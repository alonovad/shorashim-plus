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

// A handler can also be registered by direct assignment — `BuildPlan.foo =
// BP.foo` — which is how a module that loads AFTER the namespace owner has
// to do it: the owner's API object was already built and cannot reference a
// function that does not exist yet. Runtime-wise it is the same thing, so
// the check accepts it, scanned across every shipped file rather than only
// the file that owns the namespace.
Object.values(NS).forEach(ns => {
  const re = new RegExp('\\b' + ns + '\\.([A-Za-z_]\\w*)\\s*=[^=]', 'g');
  files.forEach(f => {
    [...src[f].matchAll(re)].forEach(m => {
      (exportsOf[ns] = exportsOf[ns] || new Set()).add(m[1]);
    });
  });
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
// A file nobody loads is still downloaded by anyone who asks for it, still
// answers every grep, and still looks maintained. buildplan.js sat in here
// at 219 KB for weeks answering searches with code that could not run, so
// this stopped being a warning. preflight.js is the one exception: a Node
// tool that ships beside the code it checks and is deliberately untagged.
const NOT_LOADED_OK = ['preflight.js'];
const orphans = files.filter(f => !tags.includes(f) && NOT_LOADED_OK.indexOf(f) === -1);
orphans.length
  ? bad(`in public/js but never loaded by index.html: ${orphans.join(', ')} — delete them, or park them outside public/`)
  : ok(`all ${files.length - NOT_LOADED_OK.length} modules are reachable`);
// dependency order
const order = (a, b) => tags.indexOf(a) < tags.indexOf(b);
[['orders.js','agriplan.js'],
 ['shed3d.js','buildplan-core.js'], ['orders.js','buildplan-core.js'],
 // rebar.js defines Rebar, which gates.js and the buildplan files normalise
 // their reinforcement specs through at load time
 ['rebar.js','gates.js'], ['rebar.js','buildplan-core.js'],
 // the ledger reads BP helpers and registers onto the BuildPlan global that
 // buildplan-link.js creates, so it must load after both
 ['buildplan-core.js','buildplan-ledger.js'], ['buildplan-link.js','buildplan-ledger.js'],
 // the plan tab builds Shed3D faces and Rebar details, and registers onto BuildPlan
 ['buildplan-link.js','buildplan-plan.js'], ['shed3d.js','buildplan-plan.js'], ['rebar.js','buildplan-plan.js'],
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
  // Prefix keys are whitelisted by a matches() pattern: per-year
  // (-[0-9]{4}) or per-project-id (-[0-9]+).
  const listed = rules.includes(`'${base}'`) ||
                 rules.includes(base.replace(/-$/, '') + '-[0-9]{4}') ||
                 rules.includes(base.replace(/-$/, '') + '-[0-9]+');
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
// Was firestore.rules only; a storage.rules copy then sat in public/js for
// weeks, served at /js/storage.rules and never deployed from there. Any
// .rules file anywhere under public/ is the same mistake.
head('7. No publicly-served rules copy');
function rulesUnderPublic(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) rulesUnderPublic(full, out);
    else if (e.name.endsWith('.rules')) out.push(path.relative(ROOT, full));
  });
  return out;
}
const strayRules = rulesUnderPublic(path.join(ROOT, 'public'), []);
strayRules.length
  ? bad(`served publicly and never deployed from there: ${strayRules.join(', ')}`)
  : ok('none');

// ── 8. untranslated user-facing Hebrew ────────────────────────────────
// Every visible string must go through tt(he, th, ar). Data keys are
// exempt: catalogue and unit names are stable identifiers that join
// takeoff, orders and quotes, and are translated at render instead.
head('8. Translation coverage');
const HEB = /[\u0590-\u05FF]/;
const OWN = ['orders.js','agriplan.js',
             'buildplan-core.js', 'buildplan-geom.js', 'buildplan-draw.js', 'buildplan-map.js', 'buildplan-ui.js', 'buildplan-link.js',
             'shed3d.js','rebar.js','buildplan-ledger.js','buildplan-plan.js','stickyactions.js'];
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
    // Hebrew that is a DATA KEY, not UI text: catalogue product names join
    // takeoff → catalogue → order → maintenance line, so translating them
    // would break every saved project. They are translated at display time
    // by BP.dsp() instead. The marker has to be explicit and on the line,
    // so nothing is exempted by accident.
    if (/CATALOGUE KEY/.test(t)) return;
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

// ── 10. SVG text direction is pinned ──────────────────────────────────
// Every report and quote window is dir="rtl". RTL inheritance reverses what
// text-anchor start/end MEAN inside SVG, so a margin callout anchored
// "start" renders to the LEFT of its x and walks off the viewBox. It cost
// the gate drawings once and the shed section a second time, silently both
// times — the drawing still renders, it is just missing its labels at the
// edge. Any SVG that carries <text> must pin itself to ltr at the root.
head('10. SVG text direction pinned to ltr');
files.forEach(f => {
  // This file is the scanner: its <svg> occurrences are the patterns it
  // searches FOR, not markup it emits.
  if (f === 'preflight.js') return;
  // Comments only — the string literals ARE the markup, so code() is no use
  // here; it blanks exactly what needs reading.
  const c = src[f].replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const opens = [...c.matchAll(/<svg\b/g)];
  if (!opens.length) return;
  // Only text-anchor is direction-sensitive. A drawing is built by string
  // concatenation, so the <text> that belongs to an <svg> is nowhere near
  // it in the source and cannot be paired up — judge at file level and
  // exempt the files that anchor nothing. app.js emits one solid-colour
  // placeholder tile and is rightly exempt; effects.js is decorative.
  if (!/text-anchor/.test(c)) { ok(`${f} (no anchored text)`); return; }
  const unpinned = opens.filter(m => {
    // The pin may be an inline style or the presentation attribute; both sit
    // inside the opening tag, which in source ends within a line or two.
    const tag = c.slice(m.index, m.index + 320);
    return !/direction\s*:\s*ltr/.test(tag) && !/direction=["']ltr["']/.test(tag);
  });
  unpinned.length
    ? bad(`${f}: ${unpinned.length} of ${opens.length} <svg> not pinned direction:ltr — RTL flips text-anchor and clips margin labels`)
    : ok(`${f} (${opens.length} svg pinned)`);
});

// ── 11. storage.rules agrees with firestore.rules ─────────────────────
// Two rules files, one identity model. firestore.rules closed the
// no-role-claim hatch after the backfill; storage.rules kept its own copy
// of it open, which made every claim-less account staff on the bucket.
head('11. Storage rules match the Firestore identity model');
const storagePath = path.join(ROOT, 'storage.rules');
if (!fs.existsSync(storagePath)) {
  bad('storage.rules missing but firebase.json points at it');
} else {
  const st = fs.readFileSync(storagePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  /role\(\)\s*==\s*null\s*\|\|/.test(st)
    ? bad('storage.rules still treats a missing role claim as staff — firestore.rules does not')
    : ok('no no-role-claim hatch');
  /sign_in_provider\s*!=\s*'phone'/.test(st)
    ? ok('phone sessions excluded, as in firestore.rules')
    : bad('storage.rules does not exclude phone-provider sessions');
}

// ── 12. every file the page loads or the worker precaches exists ─────
// Check 4 catches files nobody loads. This is the opposite, and it is the
// one that mattered: index.html loaded js/frame.js and sw.js precached it,
// and the file was never committed. The page threw "Frame is not defined"
// on every plan read — and because cache.addAll() is all-or-nothing, every
// new service worker failed to INSTALL, so the old one stayed in charge
// serving old files. Nothing on screen connected the two.
head('12. Everything referenced exists');
const PUB = path.join(ROOT, 'public');
const missingTags = tags.filter(f => !fs.existsSync(path.join(JS_DIR, f)));
missingTags.length
  ? bad(`index.html loads files that do not exist: ${missingTags.join(', ')}`)
  : ok(`all ${tags.length} script tags resolve to a file`);
const swSrc = fs.readFileSync(path.join(PUB, 'sw.js'), 'utf8');
const appUrls = ((swSrc.match(/var APP_URLS = \[([\s\S]*?)\];/) || [])[1] || '')
  .match(/'[^']+'/g) || [];
const missingSw = appUrls.map(u => u.slice(1, -1))
  .filter(u => !fs.existsSync(u === '/' ? path.join(PUB, 'index.html') : path.join(PUB, u)));
missingSw.length
  ? bad(`sw.js precaches files that do not exist — every service-worker install fails: ${missingSw.join(', ')}`)
  : ok(`all ${appUrls.length} precached files exist`);

console.log(`\n${'-'.repeat(52)}`);
console.log(failures ? `\x1b[31m${failures} FAILURE(S)\x1b[0m of ${checks} checks`
                     : `\x1b[32mall ${checks} checks passed\x1b[0m`);
process.exit(failures ? 1 : 0);
