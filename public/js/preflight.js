#!/usr/bin/env node
/* preflight.js — run this BEFORE handing over any change.
 *
 * `node -c` only parses. It cannot see a ReferenceError, a duplicate
 * function declaration that silently replaces an earlier one, an onclick
 * naming an export that does not exist, or a Firestore key missing from the
 * rules. Every one of those has shipped broken from this project, so each
 * now has a check here.
 *
 * Usage: node preflight.js      (exit code 1 on any failure)
 */
'use strict';
const fs = require('fs');
const path = require('path');

function findRepoRoot(start) {
  let d = start;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(d, 'firebase.json')) &&
        fs.existsSync(path.join(d, 'public', 'js'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  console.error('preflight: could not find the repo root (no firebase.json above ' + start + ')');
  process.exit(2);
}
// This file ships inside public/js but describes the whole repo, so it must
// locate the root rather than assume it is the root. __dirname alone sent
// JS_DIR to public/js/public/js and the script died on its own first
// readdir, which is a poor look for the thing that checks everything else.
const REPO_ROOT = findRepoRoot(__dirname);
const ROOT = REPO_ROOT;
const JS_DIR = path.join(ROOT, 'public/js');
let failures = 0, checks = 0;

function ok(msg)   { checks++; console.log('  \x1b[32mok\x1b[0m   ' + msg); }
function bad(msg)  { checks++; failures++; console.log('  \x1b[31mFAIL\x1b[0m ' + msg); }
function head(t)   { console.log('\n\x1b[1m' + t + '\x1b[0m'); }


// Blank the full argument list of the named calls, brackets matched, so the
// scan never mistakes an interpolated translated string for a raw literal.
function blankCalls(src, names) {
  const out = src.split('');
  const re = new RegExp('\\b(' + names.join('|') + ')\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) {
    let depth = 0, i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (!depth) break; }
    }
    for (let j = m.index; j <= i && j < out.length; j++) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  }
  return out.join('');
}

const files = fs.readdirSync(JS_DIR).filter(f => f.endsWith('.js'));
const src = {};
files.forEach(f => { src[f] = fs.readFileSync(path.join(JS_DIR, f), 'utf8'); });

// Comments and string literals stripped, so pattern matching does not trip
// over prose or over HTML held in strings.
function code(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
          .replace(/'(?:\\.|[^'\\])*'/g, "''")
          .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

// ── 1. duplicate top-level declarations ────────────────────────────────
// Two `function foo()` in one scope: the second silently wins. This is what
// broke map footprints — a UI helper replaced the Leaflet layer accessor.
head('1. Duplicate function declarations');
files.forEach(f => {
  const names = [...code(src[f]).matchAll(/^\s{2}function ([A-Za-z_]\w*)\s*\(/gm)].map(m => m[1]);
  const seen = {}, dup = [];
  names.forEach(n => { if (seen[n]) dup.push(n); seen[n] = 1; });
  dup.length ? bad(`${f}: duplicate ${dup.join(', ')}`) : ok(`${f} (${names.length} fns)`);
});

// ── 2. locals shadowing globals ────────────────────────────────────────
// `var L = length` shadows Leaflet for its whole function; `var map = {...}`
// shadows the map accessor. Both have bitten this project.
head('2. Locals shadowing app globals');
const GLOBALS = ['L', 'map', 'DB', 'Util', 'Audit', 'document', 'window'];
files.forEach(f => {
  const c = code(src[f]);
  const real = [];
  [...new Set([...c.matchAll(new RegExp(`\\bvar\\s+(${GLOBALS.join('|')})\\b`, 'g'))]
    .map(m => m[1]))].forEach(g => {
    // A file that declares `var DB = (function(){...})()` is defining DB,
    // not shadowing it. Only flag when the file also CONSUMES the global as
    // a global — that is the ambiguity that actually breaks at runtime.
    const defines = new RegExp(`\\bvar\\s+${g}\\s*=\\s*\\(?function|window\\.${g}\\s*=`).test(c);
    const consumes = new RegExp(`\\b${g}\\.[a-zA-Z]`).test(c) ||
                     new RegExp(`typeof\\s+${g}\\b`).test(c);
    const declaredAtTop = new RegExp(`^\\s{0,2}var\\s+${g}\\b`, 'm').test(c);
    // A local named L inside a function is only dangerous if some OTHER
    // function in the file relies on the global L. Approximate that by
    // requiring the global use to sit at two-space (module) indentation.
    const usedAtModuleLevel = new RegExp(`^\\s{2,4}(?:var\\s+\\w+\\s*=\\s*)?${g}\\.[a-zA-Z]`, 'm').test(c);
    if (!defines && consumes && usedAtModuleLevel && !declaredAtTop) real.push(g);
  });
  real.length ? bad(`${f}: shadows ${real.join(', ')} while also using it as a global`) : ok(f);
});

// ── 3. every Module.fn( referenced in markup is exported ──────────────
// An onclick naming a function that is not in the return block is a dead
// button — no error until a user presses it.
head('3. Exported handlers cover every reference');
const NS = { 'orders.js':'Orders', 'agriplan.js':'AgriPlan',
             'buildplan-link.js':'BuildPlan',
             'shed3d.js':'Shed3D', 'stickyactions.js':'StickyActions' };
const exportsOf = {};
Object.keys(NS).forEach(f => {
  if (!src[f]) return;
  // buildplan-link.js publishes its API as `var API = {` rather than a
  // `return {` block, because the module is now six files sharing one
  // namespace instead of one IIFE. Accept either shape.
  let i = src[f].lastIndexOf('var API = {');
  if (i >= 0) i += 'var API = '.length - 'return '.length;
  else i = src[f].lastIndexOf('return {');
  let block = '';
  if (i >= 0) {
    let d = 0;
    for (let j = i + 7; j < src[f].length; j++) {
      const ch = src[f][j];
      if (ch === '{') d++;
      else if (ch === '}') { d--; if (!d) { block = src[f].slice(i, j); break; } }
    }
  }
  exportsOf[NS[f]] = new Set([...block.matchAll(/[{,]\s*([A-Za-z_]\w*)\s*:/g)].map(m => m[1]));
});
files.forEach(f => {
  const missing = [];
  Object.keys(exportsOf).forEach(ns => {
    const used = [...src[f].matchAll(new RegExp(`\\b${ns}\\.([A-Za-z_]\\w*)\\s*\\(`, 'g'))]
      .map(m => m[1]);
    used.forEach(u => { if (!exportsOf[ns].has(u)) missing.push(`${ns}.${u}`); });
  });
  missing.length ? bad(`${f}: unresolved ${[...new Set(missing)].join(', ')}`) : ok(f);
});

// ── 4. index.html wiring ───────────────────────────────────────────────
head('4. index.html script tags');
const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
const tags = [...html.matchAll(/<script[^>]*src="js\/([^"]+)"/g)].map(m => m[1]);
const dupTags = tags.filter((t, i) => tags.indexOf(t) !== i);
dupTags.length ? bad(`duplicate tags: ${[...new Set(dupTags)].join(', ')}`)
               : ok(`${tags.length} tags, no duplicates`);
const orphans = files.filter(f => !tags.includes(f));
orphans.length
  ? console.log('  \x1b[33mwarn\x1b[0m ' + `dead files (shipped, never loaded): ${orphans.join(', ')}`)
  : ok('every js file is loaded');
// dependency order
const order = (a, b) => tags.indexOf(a) < tags.indexOf(b);
[['orders.js','agriplan.js'],
 ['shed3d.js','buildplan-core.js'], ['orders.js','buildplan-core.js'],
 // the six buildplan files share one namespace and MUST keep this order
 ['buildplan-core.js','buildplan-geom.js'], ['buildplan-geom.js','buildplan-draw.js'], ['buildplan-draw.js','buildplan-map.js'], ['buildplan-map.js','buildplan-ui.js'], ['buildplan-ui.js','buildplan-link.js']]
  .forEach(([a, b]) => {
    if (!tags.includes(a) || !tags.includes(b)) return;
    order(a, b) ? ok(`${a} before ${b}`) : bad(`${a} must load before ${b}`);
  });
if (tags.includes('stickyactions.js')) {
  const after = ['orders.js','agriplan.js','buildplan-link.js'].every(m => order(m, 'stickyactions.js'));
  after ? ok('stickyactions.js loads after the modal modules')
        : bad('stickyactions.js must load after orders/agriplan/buildplan');
}

// ── 5. service worker cache ────────────────────────────────────────────
head('5. Service worker');
const sw = fs.readFileSync(path.join(ROOT, 'public/sw.js'), 'utf8');
const ver = (sw.match(/CACHE_NAME\s*=\s*'([^']+)'/) || [])[1];
ver ? ok(`CACHE_NAME = ${ver}`) : bad('CACHE_NAME not found');
const loaded = files.filter(f => tags.includes(f));
const uncached = loaded.filter(f => !sw.includes(`/js/${f}`));
uncached.length ? bad(`not cached: ${uncached.join(', ')}`)
                : ok(`all ${loaded.length} loaded files are cached`);

// ── 6. firestore rules cover every document written ───────────────────
head('6. Firestore rules whitelist');
const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
// Only keys that reach Firestore. Scanning every 'shorashim-*' string also
// catches localStorage keys, which rules have nothing to do with.
const keys = new Set();
// Only files reached by an index.html script tag. `tags` comes from check 4.
const shipped = files.filter(f => tags.includes(f));
const unwired = files.filter(f => !tags.includes(f));
shipped.forEach(f => {
  const c = src[f];
  [...c.matchAll(/DB\.save\(\s*'(shorashim-[a-z-]+)'/g)].forEach(m => keys.add(m[1]));
  // keys held in a constant and saved via that constant
  [...c.matchAll(/DB\.save\(\s*([A-Z_]+)\s*[,)]/g)].forEach(m => {
    const def = c.match(new RegExp(`${m[1]}\\s*=\\s*'(shorashim-[a-z-]+)'`));
    if (def) keys.add(def[1]);
  });
  // A constant only counts if it is actually handed to DB.save — plenty of
  // 'shorashim-*' constants are localStorage keys, which rules never see.
  [...c.matchAll(/([A-Z_]+)\s*=\s*'(shorashim-[a-z-]+)'/g)].forEach(m => {
    if (new RegExp(`DB\\.save\\(\\s*${m[1]}\\b`).test(c) ||
        new RegExp(`DB\\.save\\(\\s*key\\(\\)`).test(c) && /KEY_PREFIX/.test(m[1])) {
      keys.add(m[2]);
    }
  });
  // key() helpers that concatenate a prefix
  [...c.matchAll(/return\s+([A-Z_]+)\s*\+\s*year/g)].forEach(() => {});
});
[...keys].sort().forEach(k => {
  const base = k.replace(/\*$/, '');
  const listed = rules.includes(`'${base}'`) ||
                 rules.includes(base.replace(/-$/, '') + '-[0-9]{4}');
  listed ? ok(`${k} whitelisted`) : bad(`${k} NOT in firestore.rules — writes will be denied`);
});
// Keys belonging to modules that are not loaded. Not a failure — nothing
// writes them — but they are what has to be whitelisted on the day the
// module is wired up, so say so rather than let it be a launch-day surprise.
function pendingKeys(c) {
  const found = new Set();
  [...c.matchAll(/DB\.save\(\s*'(shorashim-[a-z-]+)'/g)].forEach(m => found.add(m[1]));
  [...c.matchAll(/DB\.save\(\s*([A-Z_]+)\s*[,)]/g)].forEach(m => {
    const def = c.match(new RegExp(`${m[1]}\\s*=\\s*'(shorashim-[a-z-]+)'`));
    if (def) found.add(def[1]);
  });
  return found;
}
const pending = new Set();
unwired.forEach(f => {
  pendingKeys(src[f]).forEach(k => {
    if (!keys.has(k) && !rules.includes(`'${k}'`)) pending.add(`${k} (${f})`);
  });
});
[...pending].sort().forEach(k =>
  console.log('  \x1b[33mwarn\x1b[0m ' + `${k} — module not loaded; whitelist it before wiring it up`));

// ── 7. stale public copy of the rules ──────────────────────────────────
head('7. No publicly-served rules copy');
fs.existsSync(path.join(JS_DIR, 'firestore.rules'))
  ? bad('public/js/firestore.rules exists — served publicly and never deployed')
  : ok('none');

// ── 8. untranslated user-facing Hebrew ────────────────────────────────
// Every visible string must go through tt(he, th, ar). Data keys are
// exempt: catalogue and unit names are stable identifiers that join
// takeoff, orders and quotes, and are translated at render instead.
head('8. Translation coverage');
const HEB = /[\u0590-\u05FF]/;
const OWN = ['orders.js','agriplan.js',
             'buildplan-core.js', 'buildplan-geom.js', 'buildplan-draw.js', 'buildplan-map.js', 'buildplan-ui.js', 'buildplan-link.js',
             'shed3d.js','stickyactions.js'];
OWN.forEach(f => {
  if (!src[f]) return;
  let m = src[f].replace(/\/\*[\s\S]*?\*\//g, x => x.replace(/[^\n]/g, ' '))
                .replace(/(^|[^:])\/\/[^\n]*/g, (x, p2) => p2 + x.slice(p2.length).replace(/./g, ' '));
  // Blank every tt(...) call by matching brackets rather than by pattern.
  // A tt() whose first argument is concatenated across several lines is
  // still translated, and no regex short of a parser gets that right.
  m = blankCalls(m, ['tt', 'dsp', 'dspUnit', 'qty', 'push', 'b']);

  const hits = [];
  m.split('\n').forEach((line, i) => {
    const raw = src[f].split('\n')[i] || '';
    const t = raw.trim();
    if (/^'[^']*':\s*\[/.test(t) || /\{\s*g:\s*'/.test(t) || /label:\s*\[/.test(t)) return;
    if (/^var UNITS/.test(t) || /^\s*"[^"]*":\s*\[/.test(t)) return;
    if (/^push\(/.test(t) || /profSel\(/.test(t)) return;   // catalogue keys
    if (/String\(d\.\w+\s*\|\|/.test(t)) return;              // catalogue defaults
    if (/^var group\s*=/.test(t)) return;                     // catalogue group key
    if (/^'[^']*':\s*[\d.]+\s*,?\s*($|\/\/)/.test(t)) return;   // price table entry
    if (/^'[^']*':\s*[\d.]+,\s*'[^']*':\s*[\d.]+/.test(t)) return;
    if (/x\.group !== /.test(t)) return;                      // catalogue group filter
    if (/migrateClad\(/.test(t)) return;                      // catalogue defaults
    if (/x\.group ===/.test(t)) return;                       // catalogue group key
    if (/^if \(c === '/.test(t)) return;                      // migration mapping
    const re = /'((?:\\.|[^'\\])*)'/g; let g;
    while ((g = re.exec(line))) if (HEB.test(g[1])) hits.push(i + 1);
  });
  hits.length ? bad(`${f}: untranslated at lines ${[...new Set(hits)].slice(0,6).join(', ')}`)
              : ok(f);
});

// ── 9. map zoom is bounded ────────────────────────────────────────────
head('9. Map zoom bounds');
const appSrc = src['app.js'] || '';
/maxZoom:\s*MAX_ZOOM,\s*minZoom/.test(appSrc)
  ? ok('map has maxZoom + minZoom') : bad('map is unbounded — tiles can run out and blank');
(appSrc.match(/maxNativeZoom/g) || []).length >= 2
  ? ok('both tile layers set maxNativeZoom') : bad('tile layer missing maxNativeZoom');

console.log(`\n${'-'.repeat(52)}`);
console.log(failures ? `\x1b[31m${failures} FAILURE(S)\x1b[0m of ${checks} checks`
                     : `\x1b[32mall ${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
