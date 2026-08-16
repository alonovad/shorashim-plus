/* spray-pest-link.js — pest/disease vocabulary + inspection-report linking
 * ---------------------------------------------------------------------
 * Two additions to the spray form:
 *
 * 1. TARGET VOCABULARY. The per-pesticide "target" field was free text
 *    that vanished on submit. It now autocompletes from the SAME store
 *    fieldreport.js uses (shorashim-pest-lists), and any new name typed
 *    is written back to that store — so a pest named during a spray is
 *    available in the next inspection report, and vice versa. One
 *    vocabulary, not two.
 *
 * 2. LINKED INSPECTION REPORTS. Field reports for the selected plots are
 *    offered for linking, so a spray event records which scouting
 *    observation it responds to. Stored as linkedReportIds on the spray
 *    event.
 *
 * app.js keeps sprayEvents/saveData private to its IIFE, so the write of
 * linkedReportIds happens inside app.js's own submit handler, which reads
 * window.SprayLink.getSelectedReportIds(). This module owns the UI and
 * the vocabulary; app.js owns the record.
 *
 * No new Firestore keys: both stores are already whitelisted.
 */
var SprayLink = (function () {
  'use strict';

  var PEST_KEY = 'shorashim-pest-lists';
  var REPORT_KEY = 'shorashim-field-reports';
  var DATALIST_ID = 'sprayTargetOptions';
  var RECENT_DAYS = 90;

  var READY_EVENT = 'shorashim:reports-ready';

  var pestLists = {};
  var reports = [];
  var showAllReports = false;

  // Field reports load asynchronously, but app.js reads them synchronously
  // when rendering history and when building the PDF. Anything that depends
  // on them has to know whether they've actually arrived.
  var loaded = false;
  var resolveReady;
  var readyPromise = new Promise(function (res) { resolveReady = res; });

  function announceReady() {
    loaded = true;
    try { resolveReady(reports); } catch (e) {}
    try {
      document.dispatchEvent(new CustomEvent(READY_EVENT, { detail: { count: reports.length } }));
    } catch (e) {
      // CustomEvent constructor is unavailable on very old WebViews.
      var ev = document.createEvent('Event');
      ev.initEvent(READY_EVENT, true, true);
      document.dispatchEvent(ev);
    }
  }

  // ── i18n (module-local, mirrors fieldreport.js) ──
  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function itemName(p) { return (typeof p === 'string') ? p : tt(p.he, p.th, p.ar); }
  function itemVal(p) { return (typeof p === 'string') ? p : p.he; }

  // ── store ──
  function loadPestLists() {
    return new Promise(function (resolve) {
      if (typeof DB !== 'undefined') {
        DB.loadAsync(PEST_KEY).then(function (d) {
          pestLists = (d && Object.keys(d).length) ? d : {};
          resolve(pestLists);
        });
      } else {
        var s = localStorage.getItem(PEST_KEY);
        try { pestLists = s ? JSON.parse(s) : {}; } catch (e) { pestLists = {}; }
        resolve(pestLists);
      }
    });
  }

  function savePestLists() {
    // Firestore rejects undefined — round-trip to strip it.
    var clean = JSON.parse(JSON.stringify(pestLists));
    if (typeof DB !== 'undefined') DB.save(PEST_KEY, clean);
    else localStorage.setItem(PEST_KEY, JSON.stringify(clean));
  }

  function loadReports() {
    return new Promise(function (resolve) {
      if (typeof DB !== 'undefined') {
        DB.loadAsync(REPORT_KEY).then(function (d) { reports = d || []; resolve(reports); });
      } else {
        var s = localStorage.getItem(REPORT_KEY);
        try { reports = s ? JSON.parse(s) : []; } catch (e) { reports = []; }
        resolve(reports);
      }
    });
  }

  // ── plot / crop helpers ──
  function checkedPlotIds() {
    var ids = [];
    document.querySelectorAll('.plot-checkbox:checked').forEach(function (cb) {
      ids.push(parseInt(cb.getAttribute('data-plot-id'), 10));
    });
    return ids;
  }

  function cropForPlot(plotId) {
    var list = (typeof getAccessiblePlots === 'function')
      ? getAccessiblePlots()
      : (typeof plots !== 'undefined' ? plots : []);
    if (!list || !list.find) return '';
    var p = list.find(function (pl) { return pl.id == plotId; });
    return (p && p.crop_type) ? p.crop_type : '';
  }

  function activeCrops() {
    var seen = {};
    checkedPlotIds().forEach(function (id) {
      var c = cropForPlot(id);
      if (c) seen[c] = true;
    });
    return Object.keys(seen);
  }

  // Vocabulary for the plots currently checked. No plots checked, or a crop
  // with no list of its own, falls back to _default plus everything known —
  // better to over-offer than to leave the operator with an empty dropdown.
  function vocabulary() {
    var out = [];
    var seen = {};
    function push(arr) {
      (arr || []).forEach(function (x) {
        var v = itemVal(x);
        if (v && !seen[v]) { seen[v] = true; out.push(x); }
      });
    }
    var crops = activeCrops();
    var matched = false;
    crops.forEach(function (c) {
      if (pestLists[c]) {
        matched = true;
        push(pestLists[c].pests);
        push(pestLists[c].diseases);
      }
    });
    if (pestLists['_default']) {
      push(pestLists['_default'].pests);
      push(pestLists['_default'].diseases);
    }
    if (!matched) {
      Object.keys(pestLists).forEach(function (k) {
        if (!pestLists[k]) return;
        push(pestLists[k].pests);
        push(pestLists[k].diseases);
      });
    }
    return out;
  }

  function knownTarget(name) {
    var needle = name.trim().toLowerCase();
    if (!needle) return true;
    var hit = false;
    Object.keys(pestLists).forEach(function (k) {
      if (!pestLists[k]) return;
      ['pests', 'diseases'].forEach(function (bucket) {
        (pestLists[k][bucket] || []).forEach(function (x) {
          if (itemVal(x).trim().toLowerCase() === needle) hit = true;
        });
      });
    });
    return hit;
  }

  // New names land in `pests` under the crop being sprayed. If it's actually
  // a disease the admin moves it in the existing pest-list admin screen —
  // guessing from the string would be worse than letting a human sort it.
  function rememberTarget(name) {
    var clean = String(name || '').trim();
    if (!clean || knownTarget(clean)) return false;
    var crops = activeCrops();
    var key = crops.length === 1 ? crops[0] : '_default';
    if (!pestLists[key]) pestLists[key] = { pests: [], diseases: [] };
    if (!pestLists[key].pests) pestLists[key].pests = [];
    pestLists[key].pests.push({ he: clean, th: '', ar: '' });
    return true;
  }

  // ── datalist wiring ──
  function ensureDatalist() {
    var dl = document.getElementById(DATALIST_ID);
    if (!dl) {
      dl = document.createElement('datalist');
      dl.id = DATALIST_ID;
      document.body.appendChild(dl);
    }
    return dl;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function refreshDatalist() {
    var dl = ensureDatalist();
    var html = '';
    vocabulary().forEach(function (x) {
      var v = itemVal(x);
      var label = itemName(x);
      html += '<option value="' + esc(v) + '"' +
              (label !== v ? ' label="' + esc(label) + '"' : '') + '></option>';
    });
    dl.innerHTML = html;
  }

  // app.js re-renders #pesticideList on its own schedule, so attach by
  // observation rather than once at init.
  function attachInputs() {
    document.querySelectorAll('.target-input').forEach(function (inp) {
      if (inp.getAttribute('list') === DATALIST_ID) return;
      inp.setAttribute('list', DATALIST_ID);
      inp.setAttribute('autocomplete', 'off');
      if (!inp.placeholder) {
        inp.placeholder = tt('מזיק / מחלה', 'ศัตรูพืช / โรค', 'آفة / مرض');
      }
    });
  }

  function watchPesticideList() {
    var host = document.getElementById('pesticideList');
    if (!host || !window.MutationObserver) return;
    new MutationObserver(function () { attachInputs(); })
      .observe(host, { childList: true, subtree: true });
  }

  // ── linked reports UI ──
  function buildPanel() {
    if (document.getElementById('sprayLinkCard')) return;
    var anchor = document.getElementById('calcResults');
    if (!anchor || !anchor.parentNode) return;

    var card = document.createElement('div');
    card.className = 'section-card';
    card.id = 'sprayLinkCard';
    card.innerHTML =
      '<div class="section-title">🔍 <span id="sprayLinkTitle"></span></div>' +
      '<div class="sl-hint" id="sprayLinkHint"></div>' +
      '<div id="sprayLinkList" class="sl-list"></div>' +
      '<button type="button" class="sl-toggle" id="sprayLinkToggle"></button>';
    anchor.parentNode.insertBefore(card, anchor);

    document.getElementById('sprayLinkTitle').textContent =
      tt('דוחות סיור מקושרים', 'รายงานตรวจแปลงที่เชื่อมโยง', 'تقارير الجولة المرتبطة');
    document.getElementById('sprayLinkHint').textContent =
      tt('קשר את הריסוס לדוח הסיור שהצדיק אותו',
         'เชื่อมโยงการพ่นกับรายงานตรวจแปลงที่เป็นเหตุผล',
         'اربط الرش بتقرير الجولة الذي يبرره');

    document.getElementById('sprayLinkToggle').addEventListener('click', function () {
      showAllReports = !showAllReports;
      renderPanel();
    });
  }

  function relevantReports() {
    var ids = checkedPlotIds();
    var cutoff = Date.now() - RECENT_DAYS * 86400000;
    return reports
      .filter(function (r) { return ids.indexOf(parseInt(r.plotId, 10)) !== -1; })
      .filter(function (r) {
        if (showAllReports) return true;
        var t = r.date ? new Date(r.date).getTime() : (r.createdAt || 0);
        return isNaN(t) ? true : t >= cutoff;
      })
      .sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
  }

  function renderPanel() {
    var host = document.getElementById('sprayLinkList');
    var toggle = document.getElementById('sprayLinkToggle');
    if (!host) return;

    var ids = checkedPlotIds();
    if (!ids.length) {
      host.innerHTML = '<div class="sl-empty">' +
        tt('בחר חלקות כדי לראות דוחות סיור',
           'เลือกแปลงเพื่อดูรายงานตรวจแปลง',
           'اختر القطع لعرض تقارير الجولة') + '</div>';
      if (toggle) toggle.style.display = 'none';
      return;
    }

    var list = relevantReports();
    if (!list.length) {
      host.innerHTML = '<div class="sl-empty">' +
        tt('אין דוחות סיור לחלקות שנבחרו',
           'ไม่มีรายงานตรวจแปลงสำหรับแปลงที่เลือก',
           'لا توجد تقارير جولة للقطع المختارة') + '</div>';
    } else {
      var prev = selectedIds();
      var html = '';
      list.forEach(function (r) {
        var subject = [r.pest, r.disease].filter(Boolean).join(' / ') ||
                      tt('ללא ציון', 'ไม่ระบุ', 'غير محدد');
        var sev = r.severity ? ' · ' + tt('חומרה', 'ความรุนแรง', 'الشدة') + ' ' + r.severity : '';
        var pct = r.infectionPercent ? ' · ' + r.infectionPercent + '%' : '';
        html +=
          '<label class="sl-row">' +
            '<input type="checkbox" class="sl-check" value="' + r.id + '"' +
              (prev.indexOf(r.id) !== -1 ? ' checked' : '') + '>' +
            '<span class="sl-body">' +
              '<span class="sl-line1">' + esc(r.date || '') + ' — ' + esc(subject) + '</span>' +
              '<span class="sl-line2">' + esc(r.plotName || '') + sev + pct +
                (r.inspector ? ' · ' + esc(r.inspector) : '') + '</span>' +
              (r.recommendation
                ? '<span class="sl-rec">' + esc(r.recommendation) + '</span>' : '') +
            '</span>' +
          '</label>';
      });
      host.innerHTML = html;
    }

    if (toggle) {
      toggle.style.display = '';
      toggle.textContent = showAllReports
        ? tt('הצג רק 90 יום אחרונים', 'แสดงเฉพาะ 90 วันล่าสุด', 'عرض آخر 90 يومًا فقط')
        : tt('הצג את כל הדוחות', 'แสดงรายงานทั้งหมด', 'عرض كل التقارير');
    }
  }

  function selectedIds() {
    var out = [];
    document.querySelectorAll('#sprayLinkList .sl-check:checked').forEach(function (cb) {
      var v = parseInt(cb.value, 10);
      if (!isNaN(v)) out.push(v);
    });
    return out;
  }

  // ── submit hook ──
  // Bound to `document`, NOT to the button. At the target phase listeners fire
  // in registration order regardless of the capture flag, so a hook on the
  // button itself would run AFTER app.js has already cleared .selected and the
  // harvest would silently find nothing. On an ancestor it is a true capture
  // listener and runs first.
  function installSubmitHook() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('#submitSpray');
      if (!btn) return;
      var added = 0;
      document.querySelectorAll('.target-input').forEach(function (inp) {
        var item = inp.closest ? inp.closest('.pesticide-item') : null;
        if (item && !item.classList.contains('selected')) return;
        if (rememberTarget(inp.value)) added++;
      });
      if (added > 0) {
        savePestLists();
        refreshDatalist();
        if (typeof FieldReport !== 'undefined' &&
            typeof FieldReport._refreshPestDropdowns === 'function') {
          try { FieldReport._refreshPestDropdowns(); } catch (err) {}
        }
      }
    }, true);
  }

  // ── init ──
  function init() {
    ensureDatalist();
    buildPanel();
    installSubmitHook();
    watchPesticideList();

    Promise.all([loadPestLists(), loadReports()]).then(function () {
      refreshDatalist();
      attachInputs();
      renderPanel();
      announceReady();
    });

    // Plot selection drives both the vocabulary and the report list.
    document.addEventListener('change', function (e) {
      if (e.target && e.target.classList &&
          e.target.classList.contains('plot-checkbox')) {
        refreshDatalist();
        renderPanel();
      }
    });

    // Keep both stores live across devices — DB.loadAsync resolves off
    // localStorage and would otherwise never see another device's writes.
    if (typeof DB !== 'undefined' && typeof DB.listen === 'function') {
      DB.listen(PEST_KEY, function (d) {
        if (d && Object.keys(d).length) { pestLists = d; refreshDatalist(); }
      });
      DB.listen(REPORT_KEY, function (d) {
        if (d) { reports = d; renderPanel(); announceReady(); }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API — read by app.js's submit handler.
  return {
    // True once shorashim-field-reports has actually arrived. app.js checks
    // this before building a PDF, so an export can never silently omit the
    // chain lines.
    isReady: function () { return loaded; },
    whenReady: function () { return readyPromise; },
    readyEvent: READY_EVENT,
    getSelectedReportIds: function () {
      try { return selectedIds(); } catch (e) { return []; }
    },
    reset: function () {
      showAllReports = false;
      document.querySelectorAll('#sprayLinkList .sl-check').forEach(function (cb) {
        cb.checked = false;
      });
      renderPanel();
    },
    refresh: function () { refreshDatalist(); renderPanel(); },
    reportsById: function (ids) {
      return (ids || []).map(function (id) {
        return reports.find(function (r) { return r.id === id; });
      }).filter(Boolean);
    }
  };
})();
window.SprayLink = SprayLink;
