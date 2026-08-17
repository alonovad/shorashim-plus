/* pestmonitor.js — מערכת דוחות פיקוח מזיקים (season monitoring)
 * ------------------------------------------------------------------
 * Replaces the one-report-at-a-time דוחות סיור screen with the season
 * model: the plots are picked once, the season's visits are entered
 * once in a single grid (rows = visit dates, columns = pests), and one
 * A4-landscape report per selected plot is printed from that shared log.
 *
 * WHAT CHANGED FROM THE MOCK, AND WHY:
 *   - Plots are NOT typed by hand. They come from the app's own plots,
 *     grouped by מטע, with area filled in automatically. Typing grove
 *     names again would let the printed report disagree with the map.
 *   - Season data lives in Firestore (one doc per growing year) instead
 *     of localStorage, so a scout on a phone and the office see the same
 *     grid. DB.listen, not DB.loadAsync — loadAsync resolves from
 *     localStorage first and ignores the slower Firestore answer.
 *   - The annual summary row is computed, not a row of dashes: the free
 *     text ratings map onto the 0–4 scale printed in the legend, and the
 *     summary shows the average and the worst reading actually recorded.
 *   - JSON save/load is kept — it is how a report leaves the farm — but
 *     "reset" wipes only the current year's doc, never another year.
 *
 * One printed report covers one plot, so a grower only ever sees their
 * own מטע — the same rule the spray log follows.
 */
var PestMonitor = (function () {
  'use strict';

  var KEY_PREFIX = 'shorashim-pest-monitor-';   // + year
  var DEFAULT_PESTS = ['\u05d7\u05d3\u05e7\u05d5\u05e0\u05d9\u05ea', '\u05db\u05e0\u05d9\u05de\u05d5\u05ea \u05de\u05d2\u05df',
    '\u05d0\u05e7\u05e8\u05d9\u05d5\u05ea \u05e7\u05d5\u05e8\u05d9\u05dd', '\u05e2\u05e9 \u05ea\u05de\u05e8 \u05e7\u05d8\u05df',
    '\u05e2\u05e9 \u05ea\u05de\u05e8 \u05d2\u05d3\u05d5\u05dc', '\u05db\u05d5\u05d5\u05d9\u05d4 \u05e9\u05d7\u05d5\u05e8\u05d4'];

  var RATINGS = ['\u05dc\u05dc\u05d0', '\u05d6\u05e0\u05d9\u05d7', '\u05d1\u05d5\u05d3\u05d3\u05d5\u05ea', '\u05d6\u05e0\u05d9\u05d7-\u05e0\u05de\u05d5\u05da',
    '\u05e0\u05de\u05d5\u05da/\u05e7\u05dc\u05d4', '\u05d1\u05d9\u05e0\u05d5\u05e0\u05d9\u05ea', '\u05d2\u05d1\u05d5\u05d4\u05d4',
    '\u05e7\u05e9\u05d4 - \u05d8\u05d9\u05e4\u05d5\u05dc \u05de\u05d9\u05d9\u05d3\u05d9'];

  var RECS = ['\u05d4\u05de\u05e9\u05da \u05e2\u05dc \u05e4\u05d9 \u05ea\u05d5\u05db\u05e0\u05d9\u05ea \u05e9\u05e0\u05ea\u05d9\u05ea',
    '\u05e0\u05d9\u05d8\u05d5\u05e8 \u05e6\u05de\u05d5\u05d3 \u05d1\u05d1\u05d9\u05e7\u05d5\u05e8 \u05d4\u05d1\u05d0',
    '\u05d8\u05d9\u05e4\u05d5\u05dc \u05e0\u05d3\u05e8\u05e9 - \u05e8\u05d0\u05d4 \u05d4\u05e2\u05e8\u05d5\u05ea'];

  // The legend printed on every report is the contract for these words.
  // Anything unrecognised still prints verbatim but scores as unknown —
  // the summary says so rather than quietly averaging it as zero.
  var SCALE = {
    '\u05dc\u05dc\u05d0': 0, '\u05d0\u05d9\u05df': 0, '\u05e0\u05e7\u05d9': 0,
    '\u05d6\u05e0\u05d9\u05d7': 1, '\u05d1\u05d5\u05d3\u05d3\u05d5\u05ea': 1, '\u05d6\u05e0\u05d9\u05d7-\u05e0\u05de\u05d5\u05da': 1,
    '\u05e0\u05de\u05d5\u05da/\u05e7\u05dc\u05d4': 1, '\u05e7\u05dc\u05d4': 1, '\u05e0\u05de\u05d5\u05da': 1,
    '\u05d1\u05d9\u05e0\u05d5\u05e0\u05d9\u05ea': 2, '\u05d1\u05d9\u05e0\u05d5\u05e0\u05d9': 2,
    '\u05d2\u05d1\u05d5\u05d4\u05d4': 3, '\u05d2\u05d1\u05d5\u05d4': 3,
    '\u05e7\u05e9\u05d4 - \u05d8\u05d9\u05e4\u05d5\u05dc \u05de\u05d9\u05d9\u05d3\u05d9': 4, '\u05e7\u05e9\u05d4': 4
  };
  var SCALE_LABEL = ['\u05d0\u05d9\u05df \u05e0\u05d2\u05d9\u05e2\u05d5\u05ea', '\u05e0\u05d2\u05d9\u05e2\u05d5\u05ea \u05e7\u05dc\u05d4',
    '\u05e0\u05d2\u05d9\u05e2\u05d5\u05ea \u05d1\u05d9\u05e0\u05d5\u05e0\u05d9\u05ea', '\u05e0\u05d2\u05d9\u05e2\u05d5\u05ea \u05d2\u05d1\u05d5\u05d4\u05d4',
    '\u05e0\u05d2\u05d9\u05e2\u05d5\u05ea \u05e7\u05e9\u05d4'];

  var S = null;          // season state
  var year = String(new Date().getFullYear());
  var listening = {};    // year -> true
  var lastSaved = '';    // guards DB.listen re-render loops on our own write

  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function key() { return KEY_PREFIX + year; }

  function blankSeason() {
    var u = window.currentUser || {};
    return {
      year: year,
      inspector: u.name || u.username || '',
      location: '',
      signature: false,
      withMap: false,
      pests: DEFAULT_PESTS.slice(),
      selected: {},                       // plotId -> true
      visits: [{ d: '', r: [], rec: RECS[0], n: '' }]
    };
  }

  function normalise(d) {
    var s = d && typeof d === 'object' ? d : {};
    var out = blankSeason();
    if (Array.isArray(s.pests) && s.pests.length) out.pests = s.pests.slice();
    if (typeof s.inspector === 'string') out.inspector = s.inspector;
    if (typeof s.location === 'string') out.location = s.location;
    out.signature = !!s.signature;
    out.withMap = !!s.withMap;
    out.selected = (s.selected && typeof s.selected === 'object') ? s.selected : {};
    if (Array.isArray(s.visits) && s.visits.length) {
      out.visits = s.visits.map(function (v) {
        return {
          d: String(v.d || ''),
          r: Array.isArray(v.r) ? v.r.slice() : [],
          rec: String(v.rec || ''),
          n: String(v.n || '')
        };
      });
    }
    return out;
  }

  // ── persistence ──
  function persist() {
    if (!S) return;
    // Firestore rejects undefined — round-trip before writing.
    var clean = JSON.parse(JSON.stringify(S));
    lastSaved = JSON.stringify(clean);
    if (typeof DB !== 'undefined') DB.save(key(), clean);
    else { try { localStorage.setItem(key(), lastSaved); } catch (e) {} }
  }

  function listen() {
    if (listening[year] || typeof DB === 'undefined' || !DB.listen) return;
    listening[year] = true;
    DB.listen(key(), function (d) {
      if (!d) return;
      var incoming = JSON.stringify(d);
      if (incoming === lastSaved) return;   // our own write echoing back
      lastSaved = incoming;
      S = normalise(d);
      if (isOpen()) { render(); }
    });
  }

  function load() {
    return new Promise(function (resolve) {
      if (typeof DB !== 'undefined' && DB.loadAsync) {
        DB.loadAsync(key()).then(function (d) { resolve(d ? normalise(d) : blankSeason()); },
          function () { resolve(blankSeason()); });
      } else {
        var raw = null;
        try { raw = localStorage.getItem(key()); } catch (e) {}
        resolve(raw ? normalise(JSON.parse(raw)) : blankSeason());
      }
    });
  }

  // ── plots, straight from the app ──
  function plots() {
    var src = (window.SprayStore && window.SprayStore.getPlots)
      ? window.SprayStore.getPlots() : [];
    return src.slice();
  }
  function farms() {
    return (window.SprayStore && window.SprayStore.getFarms)
      ? window.SprayStore.getFarms() : [];
  }
  function farmName(id) {
    var f = farms().find(function (x) { return x.id === id; });
    return f ? f.name : tt('\u05dc\u05dc\u05d0 \u05de\u05d8\u05e2', '\u0e44\u0e21\u0e48\u0e21\u0e35\u0e2a\u0e27\u0e19', '\u0628\u0644\u0627 \u0628\u0633\u062a\u0627\u0646');
  }
  function selectedPlots() {
    return plots().filter(function (p) { return S && S.selected[p.id]; });
  }

  // ── summary maths ──
  function scoreOf(text) {
    var k = String(text || '').trim();
    if (!k) return null;
    return (k in SCALE) ? SCALE[k] : undefined;   // undefined = unrecognised
  }
  function summaryFor(pestIndex) {
    var nums = [], words = 0, worst = null;
    (S.visits || []).forEach(function (v) {
      var sc = scoreOf((v.r || [])[pestIndex]);
      if (sc === null) return;
      if (sc === undefined) { words++; return; }
      nums.push(sc);
      if (worst === null || sc > worst) worst = sc;
    });
    if (!nums.length) return words ? tt('\u05dc\u05dc\u05d0 \u05d3\u05d9\u05e8\u05d5\u05d2', '\u0e44\u0e21\u0e48\u0e08\u0e31\u0e14\u0e2d\u0e31\u0e19\u0e14\u0e31\u0e1a', '\u0628\u0644\u0627 \u062a\u0635\u0646\u064a\u0641') : '\u2014';
    var avg = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    return (Math.round(avg * 10) / 10) + ' \u00b7 ' + SCALE_LABEL[worst];
  }

  // ── in-app UI ──
  function isOpen() { return !!document.getElementById('pmRoot'); }

  function open() {
    load().then(function (s) {
      S = s;
      if (!S.location) {
        var f = farms()[0];
        if (f) S.location = f.name;
      }
      // A saved season predating a pest-column change keeps its own list.
      listen();
      render();
    });
  }

  function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    var all = plots();
    var sel = selectedPlots();

    var html = '<div class="pm-backdrop" id="pmRoot">' +
      '<div class="pm-sheet">' +
      '<div class="pm-head">' +
        '<div>' +
          '<h3>\ud83d\udd2c ' + tt('\u05de\u05e2\u05e8\u05db\u05ea \u05d3\u05d5\u05d7\u05d5\u05ea \u05e4\u05d9\u05e7\u05d5\u05d7 \u05de\u05d6\u05d9\u05e7\u05d9\u05dd',
            '\u0e23\u0e30\u0e1a\u0e1a\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19\u0e15\u0e23\u0e27\u0e08\u0e28\u0e31\u0e15\u0e23\u0e39\u0e1e\u0e37\u0e0a',
            '\u0646\u0637\u0627\u0645 \u062a\u0642\u0627\u0631\u064a\u0631 \u0645\u0631\u0627\u0642\u0628\u0629 \u0627\u0644\u0622\u0641\u0627\u062a') + '</h3>' +
          '<div class="pm-tag">' + tt('\u05de\u05d6\u05d9\u05e0\u05d9\u05dd \u05d0\u05ea \u05d4\u05d7\u05dc\u05e7\u05d5\u05ea \u05d5\u05d0\u05ea \u05de\u05de\u05e6\u05d0\u05d9 \u05d4\u05e2\u05d5\u05e0\u05d4 \u05e4\u05e2\u05dd \u05d0\u05d7\u05ea \u2014 \u05de\u05d3\u05e4\u05d9\u05e1\u05d9\u05dd \u05d3\u05d5\u05d7 \u05dc\u05db\u05dc \u05d7\u05dc\u05e7\u05d4',
            '\u0e01\u0e23\u0e2d\u0e01\u0e04\u0e23\u0e31\u0e49\u0e07\u0e40\u0e14\u0e35\u0e22\u0e27 \u2014 \u0e1e\u0e34\u0e21\u0e1e\u0e4c\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19\u0e17\u0e38\u0e01\u0e41\u0e1b\u0e25\u0e07',
            '\u0625\u062f\u062e\u0627\u0644 \u0645\u0631\u0629 \u0648\u0627\u062d\u062f\u0629 \u2014 \u0637\u0628\u0627\u0639\u0629 \u062a\u0642\u0631\u064a\u0631 \u0644\u0643\u0644 \u0642\u0637\u0639\u0629') + '</div>' +
        '</div>' +
        '<div class="pm-tag">' + all.length + ' ' + tt('\u05d7\u05dc\u05e7\u05d5\u05ea', '\u0e41\u0e1b\u0e25\u0e07', '\u0642\u0637\u0639') +
          ' \u00b7 ' + S.visits.length + ' ' + tt('\u05d1\u05d9\u05e7\u05d5\u05e8\u05d9\u05dd', '\u0e01\u0e32\u0e23\u0e40\u0e22\u0e35\u0e48\u0e22\u0e21', '\u0632\u064a\u0627\u0631\u0627\u062a') + '</div>' +
      '</div>' +

      '<div class="pm-bar">' +
        '<button type="button" class="pm-btn" onclick="PestMonitor.print()">\ud83d\udda8 ' +
          tt('\u05d4\u05d3\u05e4\u05e1\u05ea \u05d3\u05d5\u05d7\u05d5\u05ea \u05dc\u05d7\u05dc\u05e7\u05d5\u05ea \u05d4\u05de\u05e1\u05d5\u05de\u05e0\u05d5\u05ea',
             '\u0e1e\u0e34\u0e21\u0e1e\u0e4c\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19', '\u0637\u0628\u0627\u0639\u0629 \u0627\u0644\u062a\u0642\u0627\u0631\u064a\u0631') +
          ' (' + sel.length + ')</button>' +
        '<button type="button" class="pm-btn ghost" onclick="PestMonitor.exportJson()">\ud83d\udcbe ' +
          tt('\u05e9\u05de\u05d9\u05e8\u05d4 \u05dc\u05de\u05d7\u05e9\u05d1 (JSON)', '\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01 JSON', '\u062d\u0641\u0638 JSON') + '</button>' +
        '<label class="pm-btn ghost pm-file">\ud83d\udcc2 ' +
          tt('\u05d8\u05e2\u05d9\u05e0\u05ea \u05e7\u05d5\u05d1\u05e5', '\u0e42\u0e2b\u0e25\u0e14\u0e44\u0e1f\u0e25\u0e4c', '\u062a\u062d\u0645\u064a\u0644 \u0645\u0644\u0641') +
          '<input type="file" accept=".json" onchange="PestMonitor.importJson(this)" hidden></label>' +
        '<button type="button" class="pm-btn ghost" onclick="PestMonitor.editPests()">\ud83e\uddec ' +
          tt('\u05e2\u05e8\u05d9\u05db\u05ea \u05e2\u05de\u05d5\u05d3\u05d5\u05ea \u05de\u05d6\u05d9\u05e7\u05d9\u05dd',
             '\u0e41\u0e01\u0e49\u0e44\u0e02\u0e04\u0e2d\u0e25\u0e31\u0e21\u0e19\u0e4c', '\u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0623\u0639\u0645\u062f\u0629') + '</button>' +
        '<button type="button" class="pm-btn warn" onclick="PestMonitor.reset()">' +
          tt('\u05d0\u05d9\u05e4\u05d5\u05e1 \u05d4\u05e0\u05ea\u05d5\u05e0\u05d9\u05dd', '\u0e23\u0e35\u0e40\u0e0b\u0e15', '\u062a\u0635\u0641\u064a\u0631') + '</button>' +
        '<button type="button" class="pm-btn ghost" onclick="FieldReport.showReportsList()">\ud83d\udcf7 ' +
          tt('\u05d3\u05d5\u05d7\u05d5\u05ea \u05e4\u05e8\u05d8\u05e0\u05d9\u05d9\u05dd', '\u0e23\u0e32\u0e22\u0e07\u0e32\u0e19\u0e40\u0e14\u0e35\u0e48\u0e22\u0e27', '\u062a\u0642\u0627\u0631\u064a\u0631 \u0645\u0641\u0631\u062f\u0629') + '</button>' +
        '<button type="button" class="pm-btn ghost" onclick="PestMonitor.close()">\u2715 ' +
          tt('\u05e1\u05d2\u05d5\u05e8', '\u0e1b\u0e34\u0e14', '\u0625\u063a\u0644\u0627\u0642') + '</button>' +
      '</div>' +

      '<div class="pm-grid">' + settingsCard() + plotsCard(all) + '</div>' +
      visitsCard() +
      '</div></div>';

    m.innerHTML = html;
    wire();
  }

  function settingsCard() {
    var yrs = [];
    var now = new Date().getFullYear();
    for (var y = now + 1; y >= now - 4; y--) yrs.push(String(y));
    return '<div class="pm-card">' +
      '<h4>' + tt('\u05e4\u05e8\u05d8\u05d9 \u05d4\u05d3\u05d5\u05d7', '\u0e23\u0e32\u0e22\u0e25\u0e30\u0e40\u0e2d\u0e35\u0e22\u0e14', '\u062a\u0641\u0627\u0635\u064a\u0644') + '</h4>' +
      '<div class="pm-body"><div class="pm-set">' +
        '<div><label>' + tt('\u05de\u05d1\u05e6\u05e2 \u05d4\u05e4\u05d9\u05e7\u05d5\u05d7', '\u0e1c\u0e39\u0e49\u0e15\u0e23\u0e27\u0e08', '\u0627\u0644\u0645\u0641\u062a\u0634') +
          '</label><input id="pmInsp" value="' + esc(S.inspector) + '"></div>' +
        '<div><label>' + tt('\u05de\u05d9\u05e7\u05d5\u05dd', '\u0e2a\u0e16\u0e32\u0e19\u0e17\u0e35\u0e48', '\u0627\u0644\u0645\u0648\u0642\u0639') +
          '</label><input id="pmLoc" value="' + esc(S.location) + '"></div>' +
        '<div><label>' + tt('\u05e9\u05e0\u05ea \u05d2\u05d9\u05d3\u05d5\u05dc', '\u0e1b\u0e35\u0e40\u0e01\u0e29\u0e15\u0e23', '\u0633\u0646\u0629 \u0627\u0644\u0645\u062d\u0635\u0648\u0644') +
          '</label><select id="pmYear">' + yrs.map(function (y) {
            return '<option value="' + y + '"' + (y === year ? ' selected' : '') + '>' + y + '</option>';
          }).join('') + '</select></div>' +
      '</div>' +
      '<label class="pm-chk"><input type="checkbox" id="pmSig"' + (S.signature ? ' checked' : '') + '> ' +
        tt('\u05e9\u05d5\u05e8\u05ea \u05d7\u05ea\u05d9\u05de\u05d4 \u05d1\u05d3\u05d5\u05d7', '\u0e1a\u0e23\u0e23\u0e17\u0e31\u0e14\u0e25\u0e32\u0e22\u0e40\u0e0b\u0e19', '\u0633\u0637\u0631 \u062a\u0648\u0642\u064a\u0639') + '</label>' +
      '<label class="pm-chk"><input type="checkbox" id="pmMap"' + (S.withMap ? ' checked' : '') + '> ' +
        tt('\u05db\u05dc\u05d5\u05dc \u05ea\u05e6\u05dc\u05d5\u05dd \u05dc\u05d5\u05d5\u05d9\u05df \u05e9\u05dc \u05d4\u05de\u05d8\u05e2',
           '\u0e23\u0e27\u0e21\u0e20\u0e32\u0e1e\u0e14\u0e32\u0e27\u0e40\u0e17\u0e35\u0e22\u0e21', '\u062a\u0636\u0645\u064a\u0646 \u0635\u0648\u0631\u0629 \u0627\u0644\u0642\u0645\u0631') + '</label>' +
      '</div></div>';
  }

  function plotsCard(all) {
    var byFarm = {};
    all.forEach(function (p) {
      var fid = p.farm_id || 0;
      if (!byFarm[fid]) byFarm[fid] = [];
      byFarm[fid].push(p);
    });
    var body = '';
    Object.keys(byFarm).forEach(function (fid) {
      var list = byFarm[fid];
      var fidNum = parseInt(fid, 10) || 0;
      var on = list.every(function (p) { return S.selected[p.id]; });
      body += '<div class="pm-farm">' +
        '<label class="pm-farm-head"><input type="checkbox" class="pm-farm-cb" data-farm="' + fidNum + '"' +
          (on ? ' checked' : '') + '> <b>\ud83c\udf33 ' + esc(farmName(fidNum)) + '</b>' +
          '<span class="pm-n">' + list.filter(function (p) { return S.selected[p.id]; }).length +
          '/' + list.length + '</span></label>';
      list.forEach(function (p) {
        body += '<label class="pm-plot"><input type="checkbox" class="pm-plot-cb" value="' + p.id + '"' +
          (S.selected[p.id] ? ' checked' : '') + '> <span>' + esc(p.name) + '</span>' +
          '<span class="pm-dunam">' + (p.area ? (Math.round(p.area * 10) / 10) + ' ' +
            tt('\u05d3\u05d5\u05e0\u05dd', '\u0e44\u0e23\u0e48', '\u062f\u0648\u0646\u0645') : '') + '</span></label>';
      });
      body += '</div>';
    });
    if (!all.length) {
      body = '<div class="pm-empty">' + tt('\u05d0\u05d9\u05df \u05d7\u05dc\u05e7\u05d5\u05ea \u05d1\u05de\u05e4\u05d4',
        '\u0e44\u0e21\u0e48\u0e21\u0e35\u0e41\u0e1b\u0e25\u0e07', '\u0644\u0627 \u062a\u0648\u062c\u062f \u0642\u0637\u0639') + '</div>';
    }
    return '<div class="pm-card">' +
      '<h4>' + tt('\u05d7\u05dc\u05e7\u05d5\u05ea', '\u0e41\u0e1b\u0e25\u0e07', '\u0627\u0644\u0642\u0637\u0639') +
        '<span class="pm-n">' + selectedPlots().length + ' ' +
        tt('\u05de\u05e1\u05d5\u05de\u05e0\u05d5\u05ea', '\u0e40\u0e25\u0e37\u0e2d\u0e01', '\u0645\u062d\u062f\u062f\u0629') + '</span></h4>' +
      '<div class="pm-body">' +
        '<p class="pm-hint">' + tt('\u05de\u05e1\u05d5\u05de\u05df = \u05d9\u05d9\u05db\u05dc\u05dc \u05d1\u05d4\u05d3\u05e4\u05e1\u05d4. \u05dc\u05db\u05dc \u05d7\u05dc\u05e7\u05d4 \u05de\u05d5\u05d3\u05e4\u05e1 \u05d3\u05d5\u05d7 \u05e0\u05e4\u05e8\u05d3.',
          '\u0e40\u0e25\u0e37\u0e2d\u0e01 = \u0e23\u0e27\u0e21\u0e2d\u0e22\u0e39\u0e48\u0e43\u0e19\u0e01\u0e32\u0e23\u0e1e\u0e34\u0e21\u0e1e\u0e4c',
          '\u0627\u0644\u0645\u062d\u062f\u062f = \u064a\u0637\u0628\u0639 \u0628\u062a\u0642\u0631\u064a\u0631 \u0645\u0646\u0641\u0631\u062f') + '</p>' +
        body +
        '<div class="pm-row"><button type="button" class="pm-btn ghost" onclick="PestMonitor.selectAll(true)">' +
          tt('\u05e1\u05d9\u05de\u05d5\u05df \u05d4\u05db\u05dc', '\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e17\u0e31\u0e49\u0e07\u0e2b\u0e21\u0e14', '\u062a\u062d\u062f\u064a\u062f \u0627\u0644\u0643\u0644') + '</button>' +
        '<button type="button" class="pm-btn ghost" onclick="PestMonitor.selectAll(false)">' +
          tt('\u05d1\u05d9\u05d8\u05d5\u05dc \u05e1\u05d9\u05de\u05d5\u05df', '\u0e25\u0e49\u0e32\u0e07', '\u0625\u0644\u063a\u0627\u0621') + '</button></div>' +
      '</div></div>';
  }

  function visitsCard() {
    var head = '<th class="pm-date">' + tt('\u05ea\u05d0\u05e8\u05d9\u05da \u05d1\u05d9\u05e7\u05d5\u05e8', '\u0e27\u0e31\u0e19\u0e17\u0e35\u0e48', '\u0627\u0644\u062a\u0627\u0631\u064a\u062e') + '</th>' +
      S.pests.map(function (p) { return '<th>' + esc(p) + '</th>'; }).join('') +
      '<th class="pm-wide">' + tt('\u05d4\u05de\u05dc\u05e6\u05ea \u05d8\u05d9\u05e4\u05d5\u05dc', '\u0e04\u0e33\u0e41\u0e19\u0e30\u0e19\u0e33', '\u0627\u0644\u062a\u0648\u0635\u064a\u0629') + '</th>' +
      '<th class="pm-wide">' + tt('\u05d4\u05e2\u05e8\u05d5\u05ea', '\u0e2b\u0e21\u0e32\u0e22\u0e40\u0e2b\u0e15\u0e38', '\u0645\u0644\u0627\u062d\u0638\u0627\u062a') + '</th><th></th>';

    var rows = S.visits.map(function (v, i) {
      var cells = '<td class="pm-mid"><input data-v="' + i + '" data-f="d" value="' + esc(v.d) +
        '" placeholder="dd/mm/yyyy"></td>';
      S.pests.forEach(function (p, j) {
        cells += '<td class="pm-mid"><input list="pmRatings" data-v="' + i + '" data-f="r" data-j="' + j +
          '" value="' + esc((v.r || [])[j] || '') + '"></td>';
      });
      cells += '<td><input list="pmRecs" data-v="' + i + '" data-f="rec" value="' + esc(v.rec) + '"></td>';
      cells += '<td><input data-v="' + i + '" data-f="n" value="' + esc(v.n) + '"></td>';
      cells += '<td><button type="button" class="pm-del" data-del="' + i + '" title="' +
        tt('\u05de\u05d7\u05d9\u05e7\u05ea \u05d4\u05d1\u05d9\u05e7\u05d5\u05e8', '\u0e25\u0e1a', '\u062d\u0630\u0641') + '">\u00d7</button></td>';
      return '<tr>' + cells + '</tr>';
    }).join('');

    var sum = '<tr><td class="pm-mid"><b>' + tt('\u05e1\u05d9\u05db\u05d5\u05dd', '\u0e2a\u0e23\u0e38\u0e1b', '\u0645\u0644\u062e\u0635') + '</b></td>' +
      S.pests.map(function (p, j) { return '<td class="pm-mid pm-sum">' + esc(summaryFor(j)) + '</td>'; }).join('') +
      '<td colspan="3"></td></tr>';

    return '<div class="pm-card pm-visits">' +
      '<h4>' + tt('\u05de\u05de\u05e6\u05d0\u05d9 \u05d4\u05e2\u05d5\u05e0\u05d4', '\u0e1c\u0e25\u0e01\u0e32\u0e23\u0e15\u0e23\u0e27\u0e08', '\u0646\u062a\u0627\u0626\u062c \u0627\u0644\u0645\u0648\u0633\u0645') +
        '<span class="pm-n">' + tt('\u05d7\u05dc \u05e2\u05dc \u05db\u05dc \u05d4\u05d7\u05dc\u05e7\u05d5\u05ea \u05d4\u05de\u05e1\u05d5\u05de\u05e0\u05d5\u05ea',
          '\u0e43\u0e0a\u0e49\u0e01\u0e31\u0e1a\u0e17\u0e38\u0e01\u0e41\u0e1b\u0e25\u0e07\u0e17\u0e35\u0e48\u0e40\u0e25\u0e37\u0e2d\u0e01',
          '\u064a\u0646\u0637\u0628\u0642 \u0639\u0644\u0649 \u0643\u0644 \u0627\u0644\u0642\u0637\u0639 \u0627\u0644\u0645\u062d\u062f\u062f\u0629') + '</span></h4>' +
      '<div class="pm-body">' +
        '<div class="pm-scroll"><table class="pm-table"><thead><tr>' + head + '</tr></thead>' +
        '<tbody>' + rows + '</tbody><tfoot>' + sum + '</tfoot></table></div>' +
        '<datalist id="pmRatings">' + RATINGS.map(function (r) {
          return '<option value="' + esc(r) + '">'; }).join('') + '</datalist>' +
        '<datalist id="pmRecs">' + RECS.map(function (r) {
          return '<option value="' + esc(r) + '">'; }).join('') + '</datalist>' +
        '<div class="pm-row">' +
          '<button type="button" class="pm-btn ghost" onclick="PestMonitor.addVisit()">\u2795 ' +
            tt('\u05d4\u05d5\u05e1\u05e4\u05ea \u05d1\u05d9\u05e7\u05d5\u05e8', '\u0e40\u0e1e\u0e34\u0e48\u0e21', '\u0625\u0636\u0627\u0641\u0629') + '</button>' +
          '<button type="button" class="pm-btn ghost" onclick="PestMonitor.fillRec()">' +
            tt('\u05de\u05d9\u05dc\u05d5\u05d9 \u05d4\u05de\u05dc\u05e6\u05d4 \u05d1\u05db\u05dc \u05d4\u05e9\u05d5\u05e8\u05d5\u05ea',
               '\u0e40\u0e15\u0e34\u0e21\u0e04\u0e33\u0e41\u0e19\u0e30\u0e19\u0e33', '\u062a\u0639\u0645\u064a\u0645 \u0627\u0644\u062a\u0648\u0635\u064a\u0629') + '</button>' +
        '</div>' +
        '<div class="pm-legend"><b>' + tt('\u05e1\u05d5\u05dc\u05dd \u05d4\u05e2\u05e8\u05db\u05d4', '\u0e40\u0e01\u0e13\u0e11\u0e4c', '\u0645\u0642\u064a\u0627\u0633') + ':</b> ' +
          SCALE_LABEL.map(function (l, i) { return i + ' = ' + l; }).join(' \u00b7 ') + '</div>' +
      '</div></div>';
  }

  // ── wiring ──
  function wire() {
    var bind = function (id, key, prop) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', function () {
        S[key] = (prop === 'checked') ? el.checked : el.value;
        persist();
      });
    };
    bind('pmInsp', 'inspector');
    bind('pmLoc', 'location');
    bind('pmSig', 'signature', 'checked');
    bind('pmMap', 'withMap', 'checked');
    var mapEl = document.getElementById('pmMap');
    if (mapEl) mapEl.addEventListener('change', function () {
      if (!mapEl.checked || !window.ReportMap || !window.ReportMap.prepare) return;
      // Composite now, in the background, so the first print is not bare.
      var list = selectedPlots();
      var i = 0;
      var step = function () {
        if (i >= list.length) return;
        var p = list[i++];
        window.ReportMap.prepare({ plotId: p.id }).then(function () { setTimeout(step, 350); },
          function () { setTimeout(step, 350); });
      };
      step();
      toast('⏳ ' + tt('מכין תצלומי לווין לחלקות המסומנות',
        'กำลังเตรียมภาพ', 'جارٍ التجهيز'));
    });

    var ys = document.getElementById('pmYear');
    if (ys) ys.addEventListener('change', function () {
      // Each growing year is its own document — switching years must not
      // drag this season's visits into the next one.
      year = ys.value;
      open();
    });

    document.querySelectorAll('.pm-plot-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(cb.value, 10);
        if (cb.checked) S.selected[id] = true; else delete S.selected[id];
        persist();
        render();
      });
    });
    document.querySelectorAll('.pm-farm-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var fid = parseInt(cb.getAttribute('data-farm'), 10) || 0;
        plots().filter(function (p) { return (p.farm_id || 0) === fid; })
          .forEach(function (p) {
            if (cb.checked) S.selected[p.id] = true; else delete S.selected[p.id];
          });
        persist();
        render();
      });
    });

    // Typed cells save on the fly but must not re-render — a re-render on
    // every keystroke would steal focus mid-word.
    document.querySelectorAll('.pm-table input').forEach(function (el) {
      el.addEventListener('input', function () {
        var i = parseInt(el.getAttribute('data-v'), 10);
        var f = el.getAttribute('data-f');
        var v = S.visits[i];
        if (!v) return;
        if (f === 'r') {
          var j = parseInt(el.getAttribute('data-j'), 10);
          if (!Array.isArray(v.r)) v.r = [];
          v.r[j] = el.value;
        } else {
          v[f] = el.value;
        }
        persist();
      });
      // The summary row only needs to catch up when a cell is left.
      el.addEventListener('change', function () { refreshSummary(); });
    });

    document.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = parseInt(b.getAttribute('data-del'), 10);
        if (S.visits.length <= 1) {
          S.visits = [{ d: '', r: [], rec: RECS[0], n: '' }];
        } else {
          S.visits.splice(i, 1);
        }
        persist();
        render();
      });
    });
  }

  function refreshSummary() {
    var cells = document.querySelectorAll('.pm-sum');
    if (!cells.length) return;
    S.pests.forEach(function (p, j) {
      if (cells[j]) cells[j].textContent = summaryFor(j);
    });
  }

  // ── printed report ──
  function reportHtml(plot) {
    var pests = S.pests;
    var widths = [9].concat(pests.map(function () {
      return Math.floor(46 / Math.max(pests.length, 1));
    })).concat([22, 22]);
    var head = [tt('\u05ea\u05d0\u05e8\u05d9\u05da \u05d1\u05d9\u05e7\u05d5\u05e8', '', '')].concat(pests)
      .concat([tt('\u05d4\u05de\u05dc\u05e6\u05ea \u05d8\u05d9\u05e4\u05d5\u05dc', '', ''), tt('\u05d4\u05e2\u05e8\u05d5\u05ea', '', '')])
      .map(function (h, i) { return '<th style="width:' + (widths[i] || 10) + '%">' + esc(h) + '</th>'; }).join('');

    var rows = S.visits.filter(function (v) {
      // An empty row is a UI convenience, not a visit.
      return String(v.d || '').trim() || (v.r || []).some(function (x) { return String(x || '').trim(); });
    }).map(function (v) {
      var c = '<td class="c">' + esc(v.d) + '</td>';
      for (var j = 0; j < pests.length; j++) c += '<td class="c">' + esc((v.r || [])[j] || '') + '</td>';
      return '<tr>' + c + '<td>' + esc(v.rec) + '</td><td>' + esc(v.n) + '</td></tr>';
    }).join('');

    var fid = plot.farm_id || 0;
    var meta = [
      ['\u05de\u05d8\u05e2', farmName(fid)],
      ['\u05d7\u05dc\u05e7\u05d4', plot.name || ''],
      ['\u05e9\u05d8\u05d7 (\u05d3\u05d5\u05e0\u05dd)', plot.area ? (Math.round(plot.area * 10) / 10) : ''],
      ['\u05e9\u05e0\u05ea \u05d2\u05d9\u05d3\u05d5\u05dc', S.year || year]
    ].filter(function (kv, i) { return i === 0 || i === 3 || String(kv[1] || '').trim() !== ''; })
     .map(function (kv) { return '<td class="k">' + esc(kv[0]) + '</td><td>' + esc(kv[1]) + '</td>'; }).join('');

    // One printed report = one plot, so the image is that plot in the
    // context of its own מטע — never another grower's blocks.
    var mapUrl = (S.withMap && window.ReportMap && window.ReportMap.getCached)
      ? window.ReportMap.getCached({ plotId: plot.id }) : null;

    var sig = S.signature
      ? '<div class="sig">\u05de\u05d1\u05e6\u05e2 \u05d4\u05e4\u05d9\u05e7\u05d5\u05d7: <b>' + esc(S.inspector) +
        '</b> &nbsp;&nbsp; \u05d7\u05ea\u05d9\u05de\u05d4: <span></span> &nbsp;&nbsp; \u05ea\u05d0\u05e8\u05d9\u05da: ____________</div>'
      : '<div class="sig">\u05de\u05d1\u05e6\u05e2 \u05d4\u05e4\u05d9\u05e7\u05d5\u05d7: <b>' + esc(S.inspector) + '</b></div>';

    return '<div class="report">' +
      '<div class="band"><h3>\u05d3\u05d5\u05d7 \u05de\u05e8\u05db\u05d6 \u05e4\u05d9\u05e7\u05d5\u05d7 \u05de\u05d6\u05d9\u05e7\u05d9\u05dd \u2014 \u05de\u05d8\u05e2 \u05ea\u05de\u05e8\u05d9\u05dd</h3>' +
        '<div class="m">' + esc(farmName(fid)) + ' &nbsp;|&nbsp; \u05de\u05d9\u05e7\u05d5\u05dd: ' + esc(S.location) +
        ' &nbsp;|&nbsp; \u05e9\u05e0\u05ea \u05d2\u05d9\u05d3\u05d5\u05dc: ' + esc(S.year || year) +
        ' &nbsp;|&nbsp; \u05de\u05d1\u05e6\u05e2 \u05d4\u05e4\u05d9\u05e7\u05d5\u05d7: ' + esc(S.inspector) + '</div></div>' +
      '<table class="meta"><tr>' + meta + '</tr></table>' +
      (mapUrl ? '<div class="mapwrap"><img src="' + mapUrl + '" alt=""></div>' : '') +
      '<table class="log"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="scale"><b>\u05e1\u05d5\u05dc\u05dd \u05d4\u05e2\u05e8\u05db\u05d4:</b> &nbsp; ' +
        SCALE_LABEL.map(function (l, i) { return i + ' = ' + l; }).join(' &nbsp;|&nbsp; ') + '</div>' +
      '<h4>\u05e1\u05d9\u05db\u05d5\u05dd \u05e9\u05e0\u05ea\u05d9 \u2014 \u05e8\u05de\u05ea \u05e0\u05d2\u05d9\u05e2\u05d5\u05ea \u05dc\u05e4\u05d9 \u05de\u05d6\u05d9\u05e7 (\u05de\u05de\u05d5\u05e6\u05e2 \u00b7 \u05d4\u05d7\u05de\u05d5\u05e8 \u05e9\u05e0\u05e8\u05e9\u05dd)</h4>' +
      '<table class="sum"><tr>' + pests.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' +
      '<tr>' + pests.map(function (p, j) { return '<td>' + esc(summaryFor(j)) + '</td>'; }).join('') + '</tr></table>' +
      sig + '</div>';
  }

  function printStyles() {
    // Hardcoded print colours on purpose — a printed document must not
    // follow the app's dark theme.
    return '@page { size: A4 landscape; margin: 11mm 10mm; }' +
      'body{margin:0;background:#fff;color:#1b2b1e;font-family:"Heebo","Rubik","Segoe UI",Arial,sans-serif;font-size:14px;line-height:1.45}' +
      '.report{page-break-after:always}.report:last-child{page-break-after:auto}' +
      '.band{background:#2c5f2d;color:#fff;padding:9px 12px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.band h3{margin:0 0 3px;font-size:15px}.band .m{font-size:10px;color:#d9e8d4}' +
      '.meta{width:100%;border-collapse:collapse;margin-top:8px}' +
      '.meta td{border:1px solid #c3d2bd;padding:5px 8px;font-size:10px}' +
      '.meta .k{background:#eef1ea;font-weight:700;color:#2c5f2d;width:11%;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.mapwrap{margin-top:9px;page-break-inside:avoid;break-inside:avoid}' +
      '.mapwrap img{width:100%;height:auto;display:block;border:1px solid #c3d2bd}' +
      'table.log{width:100%;border-collapse:collapse;margin-top:10px}' +
      'table.log th{background:#2c5f2d;color:#fff;font-size:9px;padding:5px 3px;border:1px solid #24501f;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'table.log td{font-size:9.5px;padding:5px 4px;border:1px solid #c3d2bd;background:#fff}' +
      'table.log td.c{text-align:center;white-space:nowrap}' +
      'table.log tr:nth-child(even) td{background:#f7faf5;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.scale{background:#eef1ea;border:1px solid #c3d2bd;padding:6px 10px;font-size:9.5px;margin-top:9px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'h4{font-size:11px;color:#2c5f2d;margin:12px 0 5px;border-right:4px solid #7fae5f;padding-right:7px}' +
      'table.sum{width:100%;border-collapse:collapse}' +
      'table.sum th{background:#7fae5f;border:1px solid #6b9950;font-size:9.5px;padding:5px 3px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'table.sum td{text-align:center;padding:8px 4px;font-size:10px;background:#fff;border:1px solid #c3d2bd}' +
      '.sig{margin-top:20px;font-size:10px}.sig span{display:inline-block;border-bottom:1px solid #2c5f2d;width:140px}';
  }

  function print() {
    var sel = selectedPlots();
    if (!sel.length) {
      toast('\u274c ' + tt('\u05e1\u05de\u05df \u05dc\u05e4\u05d7\u05d5\u05ea \u05d7\u05dc\u05e7\u05d4 \u05d0\u05d7\u05ea',
        '\u0e40\u0e25\u0e37\u0e2d\u0e01\u0e2d\u0e22\u0e48\u0e32\u0e07\u0e19\u0e49\u0e2d\u0e22\u0e2b\u0e19\u0e36\u0e48\u0e07\u0e41\u0e1b\u0e25\u0e07',
        '\u0627\u062e\u062a\u0631 \u0642\u0637\u0639\u0629 \u0648\u0627\u062d\u062f\u0629 \u0639\u0644\u0649 \u0627\u0644\u0623\u0642\u0644'));
      return;
    }
    var html = '<!DOCTYPE html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="UTF-8">\n' +
      '<title>\u05d3\u05d5\u05d7\u05d5\u05ea \u05e4\u05d9\u05e7\u05d5\u05d7 \u05de\u05d6\u05d9\u05e7\u05d9\u05dd ' + esc(S.year || year) + '</title>\n' +
      '<style>' + printStyles() + '</style>\n</head>\n<body>\n' +
      sel.map(reportHtml).join('\n') + '\n</body>\n</html>';

    var fname = '\u05e4\u05d9\u05e7\u05d5\u05d7_\u05de\u05d6\u05d9\u05e7\u05d9\u05dd_' + (S.year || year) + '.html';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, fname);
    }
    toast('\ud83d\udcc4 ' + sel.length + ' ' + tt('\u05d3\u05d5\u05d7\u05d5\u05ea \u05e0\u05e4\u05ea\u05d7\u05d5 \u2014 \u05d1\u05d7\u05e8 \u05d4\u05d3\u05e4\u05e1\u05d4 / \u05e9\u05de\u05d5\u05e8 \u05db-PDF',
      '\u0e40\u0e2d\u0e01\u0e2a\u0e32\u0e23\u0e40\u0e1b\u0e34\u0e14\u0e41\u0e25\u0e49\u0e27', '\u0641\u064f\u062a\u062d\u062a \u0627\u0644\u062a\u0642\u0627\u0631\u064a\u0631'));
  }

  // ── toolbar actions ──
  return {
    open: open,
    close: close,
    print: print,
    addVisit: function () {
      S.visits.push({ d: '', r: [], rec: (S.visits[0] && S.visits[0].rec) || RECS[0], n: '' });
      persist(); render();
    },
    fillRec: function () {
      var t = prompt(tt('\u05d4\u05de\u05dc\u05e6\u05ea \u05d8\u05d9\u05e4\u05d5\u05dc \u05dc\u05db\u05dc \u05d4\u05e9\u05d5\u05e8\u05d5\u05ea:',
        '\u0e04\u0e33\u0e41\u0e19\u0e30\u0e19\u0e33\u0e2a\u0e33\u0e2b\u0e23\u0e31\u0e1a\u0e17\u0e38\u0e01\u0e41\u0e16\u0e27:',
        '\u0627\u0644\u062a\u0648\u0635\u064a\u0629 \u0644\u0643\u0644 \u0627\u0644\u0623\u0633\u0637\u0631:'),
        (S.visits[0] && S.visits[0].rec) || RECS[0]);
      if (t === null) return;
      S.visits.forEach(function (v) { v.rec = t; });
      persist(); render();
    },
    selectAll: function (on) {
      if (on) plots().forEach(function (p) { S.selected[p.id] = true; });
      else S.selected = {};
      persist(); render();
    },
    editPests: function () {
      var t = prompt(tt('\u05e2\u05de\u05d5\u05d3\u05d4 \u05dc\u05db\u05dc \u05de\u05d6\u05d9\u05e7 \u2014 \u05e9\u05dd \u05d1\u05db\u05dc \u05e9\u05d5\u05e8\u05d4:',
        '\u0e2b\u0e19\u0e36\u0e48\u0e07\u0e0a\u0e37\u0e48\u0e2d\u0e15\u0e48\u0e2d\u0e1a\u0e23\u0e23\u0e17\u0e31\u0e14:',
        '\u0627\u0633\u0645 \u0644\u0643\u0644 \u0633\u0637\u0631:'), S.pests.join('\n'));
      if (t === null) return;
      var list = t.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!list.length) return;
      // Ratings are stored positionally, so a column change would silently
      // shift readings under the wrong pest. Remap by name and drop the rest.
      var old = S.pests.slice();
      S.visits.forEach(function (v) {
        var moved = list.map(function (name) {
          var k = old.indexOf(name);
          return k === -1 ? '' : ((v.r || [])[k] || '');
        });
        v.r = moved;
      });
      S.pests = list;
      persist(); render();
      toast('\u2705 ' + tt('\u05e2\u05de\u05d5\u05d3\u05d5\u05ea \u05e2\u05d5\u05d3\u05db\u05e0\u05d5', '\u0e2d\u0e31\u0e1b\u0e40\u0e14\u0e15\u0e41\u0e25\u0e49\u0e27', '\u062a\u0645 \u0627\u0644\u062a\u062d\u062f\u064a\u062b'));
    },
    reset: function () {
      if (!confirm(tt('\u05dc\u05d0\u05e4\u05e1 \u05d0\u05ea \u05d1\u05d9\u05e7\u05d5\u05e8\u05d9 ' + year + '? \u05db\u05d3\u05d0\u05d9 \u05dc\u05e9\u05de\u05d5\u05e8 \u05e7\u05d5\u05d1\u05e5 \u05dc\u05e4\u05e0\u05d9.',
        '\u0e23\u0e35\u0e40\u0e0b\u0e15 ' + year + '?', '\u062a\u0635\u0641\u064a\u0631 ' + year + '?'))) return;
      var keep = { inspector: S.inspector, location: S.location, signature: S.signature,
                   withMap: S.withMap, pests: S.pests.slice(), selected: S.selected };
      S = blankSeason();
      S.inspector = keep.inspector; S.location = keep.location;
      S.signature = keep.signature; S.withMap = keep.withMap;
      S.pests = keep.pests; S.selected = keep.selected;
      persist(); render();
    },
    exportJson: function () {
      var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '\u05e4\u05d9\u05e7\u05d5\u05d7-\u05de\u05d6\u05d9\u05e7\u05d9\u05dd-' + (S.year || year) + '.json';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      toast('\ud83d\udcbe ' + tt('\u05d4\u05e7\u05d5\u05d1\u05e5 \u05e0\u05e9\u05de\u05e8', '\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01\u0e41\u0e25\u0e49\u0e27', '\u062a\u0645 \u0627\u0644\u062d\u0641\u0638'));
    },
    importJson: function (input) {
      var f = input && input.files && input.files[0];
      if (!f) return;
      var r = new FileReader();
      r.onload = function () {
        try {
          var d = JSON.parse(r.result);
          if (!Array.isArray(d.visits)) throw new Error('shape');
          S = normalise(d);
          persist(); render();
          toast('\u2705 ' + tt('\u05d4\u05e7\u05d5\u05d1\u05e5 \u05e0\u05d8\u05e2\u05df', '\u0e42\u0e2b\u0e25\u0e14\u0e41\u0e25\u0e49\u0e27', '\u062a\u0645 \u0627\u0644\u062a\u062d\u0645\u064a\u0644'));
        } catch (e) {
          toast('\u274c ' + tt('\u05d4\u05e7\u05d5\u05d1\u05e5 \u05d0\u05d9\u05e0\u05d5 \u05e7\u05d5\u05d1\u05e5 \u05e0\u05ea\u05d5\u05e0\u05d9\u05dd \u05e9\u05dc \u05d4\u05de\u05e2\u05e8\u05db\u05ea',
            '\u0e44\u0e1f\u0e25\u0e4c\u0e44\u0e21\u0e48\u0e16\u0e39\u0e01\u0e15\u0e49\u0e2d\u0e07', '\u0645\u0644\u0641 \u063a\u064a\u0631 \u0635\u0627\u0644\u062d'));
        }
        input.value = '';
      };
      r.readAsText(f);
    },
    // Test seam.
    _summary: function (i) { return summaryFor(i); },
    _state: function () { return S; }
  };
})();
window.PestMonitor = PestMonitor;
