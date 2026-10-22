/* pestmonitor.js — דוחות סיור ופיקוח מזיקים (season monitoring), v2
 * ------------------------------------------------------------------
 * One document per growing year in Firestore (appData/shorashim-pest-monitor-YYYY,
 * operator+ write — firestore.rules). v2 keeps a separate visit log PER PLOT:
 *
 *   S = { v: 2, year, inspector, location, signature, withMap,
 *         pests: [names],                 // season columns, shared by all plots
 *         selected: { plotId: true },     // included in "print"
 *         plots: { plotId: { visits: [{ d:'dd/mm/yyyy', r:[rating per pest], rec, n }] } } }
 *
 * v1 had ONE shared grid (S.visits) applied to every ticked plot. On load it is
 * migrated by copying that grid into each ticked plot, so every printed report
 * stays exactly what it was; if nothing was ticked the grid is kept as
 * S.legacy and offered as "apply to this plot".
 *
 * Saving: every change autosaves (debounced) through DB.saveAsync, and the
 * header shows the real outcome — "שומר…", "נשמר ✓ hh:mm", or the error
 * (e.g. no permission). The 💾 button forces an immediate save.
 *
 * Ratings are tapped on a 0–4 scale (ללא · קלה · בינונית · גבוהה · קשה) and
 * stored as the scale words, which the printed legend and summary already
 * understand. A legacy free-text rating is kept and shown until replaced.
 */
var PestMonitor = (function () {
  'use strict';

  var KEY_PREFIX = 'shorashim-pest-monitor-';   // + year
  var DEFAULT_PESTS = ['חדקונית', 'כנימות מגן', 'אקריות קורים', 'עש תמר קטן', 'עש תמר גדול', 'כוויה שחורה'];
  var RECS = ['המשך על פי תוכנית שנתית', 'ניטור צמוד בביקור הבא', 'טיפול נדרש - ראה הערות'];

  // Tap scale → stored word. Index = score.
  var LEVELS = ['ללא', 'קלה', 'בינונית', 'גבוהה', 'קשה - טיפול מיידי'];
  var LEVEL_SHORT = ['ללא', 'קלה', 'בינונית', 'גבוהה', 'קשה'];
  var LEVEL_COL = ['#6aa84f', '#c5d94a', '#f0b33c', '#e8833a', '#d94b3f'];

  // Words → score (legacy texts included). Unknown text = undefined.
  var SCALE = {
    'ללא': 0, 'אין': 0, 'נקי': 0,
    'זניח': 1, 'בודדות': 1, 'זניח-נמוך': 1, 'נמוך/קלה': 1, 'קלה': 1, 'נמוך': 1,
    'בינונית': 2, 'בינוני': 2,
    'גבוהה': 3, 'גבוה': 3,
    'קשה - טיפול מיידי': 4, 'קשה': 4
  };
  var SCALE_LABEL = ['אין נגיעות', 'נגיעות קלה', 'נגיעות בינונית', 'נגיעות גבוהה', 'נגיעות קשה'];

  var S = null;
  var year = String(new Date().getFullYear());
  var listening = {};
  var lastSaved = '';
  var active = null;        // plot id shown in the editor
  var farmOpen = {};
  var q = '';               // plot search
  var listOpen = false;     // phone: plot list unfolded
  var saveState = { st: 'idle', at: 0, err: '' };
  var saveTimer = null;

  function tt(he, th, ar) { return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he; }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dmyToIso(d) {
    var t = String(d || '').trim();
    var m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
    if (m) {
      var y = m[3].length === 2 ? '20' + m[3] : m[3];
      var dd = +m[1], mm = +m[2];
      if (dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12) return y + '-' + pad2(mm) + '-' + pad2(dd);
      return null;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
    return null;
  }
  function isoToDmy(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : ''; }
  function todayDmy() { var n = new Date(); return pad2(n.getDate()) + '/' + pad2(n.getMonth() + 1) + '/' + n.getFullYear(); }
  function dmyKey(d) { var i = dmyToIso(d); return i || ''; }
  function key() { return KEY_PREFIX + year; }
  function blankVisit(rec) { return { d: todayDmy(), r: [], rec: rec || RECS[0], n: '' }; }

  function blankSeason() {
    var u = window.currentUser || {};
    return { v: 2, year: year, inspector: u.name || u.username || '', location: '', signature: false, withMap: false,
      pests: DEFAULT_PESTS.slice(), selected: {}, plots: {} };
  }
  function normVisit(v) {
    v = v || {};
    return { d: String(v.d || ''), r: Array.isArray(v.r) ? v.r.map(function (x) { return String(x == null ? '' : x); }) : [], rec: String(v.rec || ''), n: String(v.n || '') };
  }
  function hasContent(v) {
    return String(v.d || '').trim() || (v.r || []).some(function (x) { return String(x || '').trim(); }) || String(v.n || '').trim();
  }
  function normalise(d) {
    var s = d && typeof d === 'object' ? d : {};
    var out = blankSeason();
    if (Array.isArray(s.pests) && s.pests.length) out.pests = s.pests.slice();
    ['inspector', 'location'].forEach(function (k) { if (typeof s[k] === 'string') out[k] = s[k]; });
    out.signature = !!s.signature;
    out.withMap = !!s.withMap;
    out.selected = (s.selected && typeof s.selected === 'object') ? s.selected : {};
    if (s.plots && typeof s.plots === 'object') {
      Object.keys(s.plots).forEach(function (pid) {
        var pv = s.plots[pid] || {};
        out.plots[pid] = { visits: (Array.isArray(pv.visits) ? pv.visits : []).map(normVisit) };
      });
    }
    if (Array.isArray(s.legacy) && s.legacy.length) out.legacy = s.legacy.map(normVisit);
    // v1 → v2: the shared grid becomes each ticked plot's own log.
    if (!s.plots && Array.isArray(s.visits)) {
      var vs = s.visits.map(normVisit).filter(hasContent);
      if (vs.length) {
        var ids = Object.keys(out.selected).filter(function (k) { return out.selected[k]; });
        if (ids.length) ids.forEach(function (pid) { out.plots[pid] = { visits: JSON.parse(JSON.stringify(vs)) }; });
        else out.legacy = vs;
      }
    }
    return out;
  }
  function plotLog(pid) {
    if (!S.plots[pid]) S.plots[pid] = { visits: [] };
    return S.plots[pid];
  }

  // ── persistence ──
  function persistNow() {
    if (!S) return Promise.resolve();
    clearTimeout(saveTimer); saveTimer = null;
    var clean = JSON.parse(JSON.stringify(S));
    lastSaved = JSON.stringify(clean);
    saveState = { st: 'saving', at: 0, err: '' }; paintSave();
    var p;
    if (typeof DB !== 'undefined' && DB.saveAsync) p = DB.saveAsync(key(), clean);
    else if (typeof DB !== 'undefined') { DB.save(key(), clean); p = Promise.resolve(); }
    else { try { localStorage.setItem(key(), lastSaved); } catch (e) {} p = Promise.resolve(); }
    return p.then(function () {
      saveState = { st: 'ok', at: Date.now(), err: '' }; paintSave();
    }, function (err) {
      var code = String((err && (err.code || err.message)) || err || '');
      saveState = { st: 'err', at: 0, err: /permission/i.test(code) ? tt('אין הרשאת שמירה (נדרש מנהל)', 'ไม่มีสิทธิ์บันทึก', 'لا صلاحية للحفظ') : code };
      paintSave();
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + saveState.err);
    });
  }
  function persist() {
    saveState = { st: 'dirty', at: 0, err: '' }; paintSave();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persistNow, 900);
  }
  function listen() {
    if (listening[year] || typeof DB === 'undefined' || !DB.listen) return;
    listening[year] = true;
    var y = year;
    DB.listen(KEY_PREFIX + y, function (d) {
      if (!d || y !== year) return;
      var incoming = JSON.stringify(d);
      if (incoming === lastSaved) return;
      if (saveTimer) return;            // local edits pending — ours win, they save next
      lastSaved = incoming;
      S = normalise(d);
      if (isOpen() && !editing()) render();
    });
  }
  function editing() {
    var a = document.activeElement;
    return !!(a && a.closest && a.closest('#pmRoot') && /INPUT|TEXTAREA|SELECT/.test(a.tagName));
  }
  function load() {
    return new Promise(function (resolve) {
      if (typeof DB !== 'undefined' && DB.loadFresh) {
        DB.loadFresh(key()).then(function (d) { resolve(d ? normalise(d) : blankSeason()); }, function () { resolve(blankSeason()); });
      } else if (typeof DB !== 'undefined' && DB.loadAsync) {
        DB.loadAsync(key()).then(function (d) { resolve(d ? normalise(d) : blankSeason()); }, function () { resolve(blankSeason()); });
      } else {
        var raw = null;
        try { raw = localStorage.getItem(key()); } catch (e) {}
        resolve(raw ? normalise(JSON.parse(raw)) : blankSeason());
      }
    });
  }

  // ── plots ──
  function plots() { return (window.SprayStore && SprayStore.getPlots) ? SprayStore.getPlots().slice() : []; }
  function farms() { return (window.SprayStore && SprayStore.getFarms) ? SprayStore.getFarms() : []; }
  function farmName(id) { var f = farms().find(function (x) { return x.id === id; }); return f ? f.name : tt('ללא משק', 'ไม่มีฟาร์ม', 'بلا مزرعة'); }
  function plotById(id) { return plots().find(function (p) { return String(p.id) === String(id); }) || null; }
  function selectedPlots() { return plots().filter(function (p) { return S && S.selected[p.id]; }); }

  // ── scores ──
  function scoreOf(text) {
    var k = String(text || '').trim();
    if (!k) return null;
    return (k in SCALE) ? SCALE[k] : undefined;
  }
  function summaryFor(visits, j) {
    var nums = [], words = 0, worst = null;
    (visits || []).forEach(function (v) {
      var sc = scoreOf((v.r || [])[j]);
      if (sc === null) return;
      if (sc === undefined) { words++; return; }
      nums.push(sc);
      if (worst === null || sc > worst) worst = sc;
    });
    if (!nums.length) return words ? tt('ללא דירוג', 'ไม่จัดอันดับ', 'بلا تصنيف') : '—';
    var avg = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
    return (Math.round(avg * 10) / 10) + ' · ' + SCALE_LABEL[worst];
  }
  function plotWorst(pid) {
    var log = S.plots[pid];
    if (!log || !log.visits.length) return null;
    var last = sortedVisits(log.visits)[0];
    var w = null;
    (last.r || []).forEach(function (x) { var s = scoreOf(x); if (s != null && (w === null || s > w)) w = s; });
    return w;
  }
  // Newest first for the editor; printing keeps chronological order.
  function sortedVisits(vs) {
    return vs.slice().sort(function (a, b) { return dmyKey(b.d).localeCompare(dmyKey(a.d)); });
  }

  // ── open / close ──
  function isOpen() { return !!document.getElementById('pmRoot'); }
  function open() {
    load().then(function (s) {
      S = s;
      if (!S.location) { var f = farms()[0]; if (f) S.location = f.name; }
      if (active == null || !plotById(active)) {
        var sel = selectedPlots();
        var withLog = plots().filter(function (p) { return S.plots[p.id] && S.plots[p.id].visits.length; });
        active = (withLog[0] || sel[0] || plots()[0] || {}).id;
      }
      saveState = { st: 'idle', at: 0, err: '' };
      listen();
      render();
    });
  }
  function close() {
    if (saveTimer) persistNow();
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }

  // ── render ──
  function saveChip() {
    var st = saveState.st;
    if (st === 'saving') return '<span class="pm2-save s">⏳ ' + tt('שומר…', 'กำลังบันทึก…', 'جارٍ الحفظ…') + '</span>';
    if (st === 'dirty') return '<span class="pm2-save s">● ' + tt('שינויים לא נשמרו', 'ยังไม่บันทึก', 'تغييرات غير محفوظة') + '</span>';
    if (st === 'ok') return '<span class="pm2-save ok">✓ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ') + ' ' + new Date(saveState.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) + '</span>';
    if (st === 'err') return '<span class="pm2-save err">✕ ' + esc(saveState.err) + '</span>';
    return '<span class="pm2-save">' + tt('נשמר אוטומטית', 'บันทึกอัตโนมัติ', 'حفظ تلقائي') + '</span>';
  }
  function paintSave() { var el = document.getElementById('pm2Save'); if (el) el.innerHTML = saveChip(); }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m || !S) return;
    ensureCss();
    var prev = document.querySelector('#pmRoot .pm2-main');
    var top = prev ? prev.scrollTop : 0;
    var yrs = [], now = new Date().getFullYear();
    for (var y = now + 1; y >= now - 4; y--) yrs.push(String(y));
    var sel = selectedPlots();
    m.innerHTML = '<div class="pm-backdrop pm2-back" id="pmRoot"><div class="pm2">' +
      '<div class="pm2-head">' +
        '<div class="pm2-title"><b>🔬 ' + tt('דוחות סיור ופיקוח מזיקים', 'รายงานสำรวจศัตรูพืช', 'تقارير مراقبة الآفات') + '</b>' +
          '<span id="pm2Save">' + saveChip() + '</span></div>' +
        '<div class="pm2-tools">' +
          '<select id="pm2Year" class="pm2-in sm">' + yrs.map(function (x) { return '<option' + (x === year ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
          '<button type="button" class="pm2-btn" data-a="save">💾 ' + tt('שמירה', 'บันทึก', 'حفظ') + '</button>' +
          '<button type="button" class="pm2-btn pri" data-a="print">🖨 ' + tt('הדפסה', 'พิมพ์', 'طباعة') + ' (' + sel.length + ')</button>' +
          '<button type="button" class="pm2-btn ghost" data-a="more" aria-label="more">⋯</button>' +
          '<button type="button" class="pm2-btn ghost" data-a="close" aria-label="close">✕</button>' +
        '</div>' +
      '</div>' +
      '<div class="pm2-body">' +
        '<aside class="pm2-side' + (listOpen ? ' open' : '') + '">' + sideHtml() + '</aside>' +
        '<section class="pm2-main">' + mainHtml() + '</section>' +
      '</div>' +
    '</div></div>';
    var nm = document.querySelector('#pmRoot .pm2-main');
    if (nm && top) nm.scrollTop = top;
    wire();
  }

  function sideHtml() {
    var all = plots();
    var ql = q.trim().toLowerCase();
    var byFarm = {};
    all.forEach(function (p) {
      if (ql && (String(p.name || '') + ' ' + farmName(p.farm_id || 0)).toLowerCase().indexOf(ql) === -1) return;
      var f = p.farm_id || 0;
      (byFarm[f] = byFarm[f] || []).push(p);
    });
    var cur = plotById(active);
    var html = '<button type="button" class="pm2-cur" data-a="list">' +
        '<span>' + (cur ? '📍 ' + esc(farmName(cur.farm_id || 0)) + ' · <b>' + esc(cur.name) + '</b>' : tt('בחר חלקה', 'เลือกแปลง', 'اختر قطعة')) + '</span>' +
        '<span class="pm2-chev">' + (listOpen ? '▴' : '▾') + '</span></button>' +
      '<div class="pm2-list">' +
      '<input class="pm2-in" id="pm2Q" placeholder="🔍 ' + tt('חיפוש משק או חלקה', 'ค้นหา', 'بحث') + '" value="' + esc(q) + '">' +
      '<div class="pm2-hint">' + tt('לחיצה על חלקה פותחת את הביקורים שלה · ☑ = ייכלל בהדפסה', 'แตะแปลงเพื่อเปิด · ☑ = พิมพ์', 'اضغط لفتح القطعة · ☑ = للطباعة') + '</div>';
    Object.keys(byFarm).forEach(function (fid) {
      var list = byFarm[fid], fnum = parseInt(fid, 10) || 0;
      var n = list.filter(function (p) { return S.selected[p.id]; }).length;
      var open = ql || farmOpen[fnum] || (cur && (cur.farm_id || 0) === fnum);
      html += '<div class="pm2-farm">' +
        '<div class="pm2-fh"><input type="checkbox" class="pm2-fcb" data-farm="' + fnum + '"' + (n === list.length ? ' checked' : '') + (n > 0 && n < list.length ? ' data-some="1"' : '') + '>' +
          '<button type="button" class="pm2-ft" data-ftog="' + fnum + '"><b>🌳 ' + esc(farmName(fnum)) + '</b><span>' + n + '/' + list.length + '</span><i>' + (open ? '▴' : '▾') + '</i></button></div>' +
        '<div class="pm2-plots"' + (open ? '' : ' hidden') + '>' +
        list.map(function (p) {
          var log = S.plots[p.id], cnt = log ? log.visits.length : 0;
          var last = cnt ? sortedVisits(log.visits)[0].d : '';
          var w = plotWorst(p.id);
          return '<div class="pm2-pl' + (String(p.id) === String(active) ? ' on' : '') + '" data-plot="' + p.id + '">' +
            '<input type="checkbox" class="pm2-pcb" value="' + p.id + '"' + (S.selected[p.id] ? ' checked' : '') + ' aria-label="print">' +
            '<span class="pm2-dot" style="background:' + (w == null ? 'var(--line,#dde5da)' : LEVEL_COL[w]) + '"></span>' +
            '<span class="pm2-pn"><b>' + esc(p.name) + '</b><small>' + (p.area ? (Math.round(p.area * 10) / 10) + ' ' + tt('ד׳', 'ไร่', 'د') + ' · ' : '') +
              (cnt ? cnt + ' ' + tt('ביקורים', 'ครั้ง', 'زيارات') + ' · ' + esc(last) : tt('אין ביקורים', 'ยังไม่มี', 'لا زيارات')) + '</small></span></div>';
        }).join('') + '</div></div>';
    });
    if (!all.length) html += '<div class="pm2-empty">' + tt('אין חלקות במפה', 'ไม่มีแปลง', 'لا توجد قطع') + '</div>';
    html += '<div class="pm2-row"><button type="button" class="pm2-btn ghost sm" data-a="selall">' + tt('סמן הכל להדפסה', 'เลือกทั้งหมด', 'تحديد الكل') + '</button>' +
      '<button type="button" class="pm2-btn ghost sm" data-a="selnone">' + tt('נקה סימון', 'ล้าง', 'إلغاء') + '</button></div>';
    return html + '</div>';
  }

  function mainHtml() {
    var p = plotById(active);
    var info = '<details class="pm2-card pm2-info"><summary>⚙️ ' + tt('פרטי הדוח', 'รายละเอียดรายงาน', 'تفاصيل التقرير') +
      ' <small>' + esc(S.inspector || '') + (S.location ? ' · ' + esc(S.location) : '') + '</small></summary>' +
      '<div class="pm2-grid2">' +
        '<label>' + tt('מבצע הפיקוח', 'ผู้ตรวจ', 'المفتش') + '<input class="pm2-in" data-s="inspector" value="' + esc(S.inspector) + '"></label>' +
        '<label>' + tt('מיקום', 'สถานที่', 'الموقع') + '<input class="pm2-in" data-s="location" value="' + esc(S.location) + '"></label>' +
      '</div>' +
      '<label class="pm2-chk"><input type="checkbox" data-s="signature"' + (S.signature ? ' checked' : '') + '> ' + tt('שורת חתימה בדוח', 'บรรทัดลายเซ็น', 'سطر توقيع') + '</label>' +
      '<label class="pm2-chk"><input type="checkbox" data-s="withMap"' + (S.withMap ? ' checked' : '') + '> ' + tt('כלול תצלום לווין של החלקה', 'รวมภาพดาวเทียม', 'تضمين صورة القمر') + '</label>' +
      '<div class="pm2-row"><button type="button" class="pm2-btn ghost sm" data-a="pests">🧬 ' + tt('עריכת רשימת מזיקים', 'แก้ไขศัตรูพืช', 'تعديل الآفات') + '</button></div>' +
    '</details>';
    if (!p) return info + '<div class="pm2-empty big">' + tt('בחר חלקה מהרשימה כדי לרשום ביקורים', 'เลือกแปลง', 'اختر قطعة') + '</div>';
    var log = plotLog(p.id);
    var vs = log.visits;
    var order = vs.map(function (v, i) { return i; }).sort(function (a, b) { return dmyKey(vs[b].d).localeCompare(dmyKey(vs[a].d)); });
    var legacy = (S.legacy && S.legacy.length && !vs.length) ?
      '<div class="pm2-legacy">' + tt('יש ממצאים משותפים מגרסה קודמת (' + S.legacy.length + ' ביקורים).', 'มีข้อมูลเดิม', 'بيانات سابقة') +
        ' <button type="button" class="pm2-btn sm" data-a="legacy">' + tt('החל על חלקה זו', 'ใช้กับแปลงนี้', 'تطبيق على هذه القطعة') + '</button></div>' : '';
    var head = '<div class="pm2-ph"><div><small>' + esc(farmName(p.farm_id || 0)) + '</small><h3>' + esc(p.name) + '</h3>' +
        '<small>' + (p.area ? (Math.round(p.area * 10) / 10) + ' ' + tt('דונם', 'ไร่', 'دونم') + ' · ' : '') + (p.crop_type ? esc(p.crop_type) + ' · ' : '') +
        vs.length + ' ' + tt('ביקורים', 'ครั้ง', 'زيارات') + '</small></div>' +
        '<div class="pm2-ph-a"><label class="pm2-chk"><input type="checkbox" class="pm2-pcb" value="' + p.id + '"' + (S.selected[p.id] ? ' checked' : '') + '> ' + tt('בהדפסה', 'พิมพ์', 'للطباعة') + '</label>' +
        '<button type="button" class="pm2-btn pri" data-a="add">＋ ' + tt('ביקור חדש', 'เพิ่มการเยี่ยม', 'زيارة جديدة') + '</button></div></div>';
    var sums = vs.length ? '<div class="pm2-sum">' + S.pests.map(function (n, j) {
      return '<span><small>' + esc(n) + '</small><b>' + esc(summaryFor(vs, j)) + '</b></span>'; }).join('') + '</div>' : '';
    var cards = order.map(function (i) { return visitCard(vs[i], i, p.id); }).join('') ||
      '<div class="pm2-empty">' + tt('עדיין אין ביקורים בחלקה הזו. לחץ "ביקור חדש".', 'ยังไม่มีการเยี่ยม', 'لا زيارات بعد') + '</div>';
    return info + head + legacy + sums + cards +
      '<div class="pm2-legend"><b>' + tt('סולם הערכה', 'มาตรวัด', 'المقياس') + ':</b> ' + SCALE_LABEL.map(function (l, i) { return '<i style="background:' + LEVEL_COL[i] + '"></i>' + i + ' ' + l; }).join(' · ') + '</div>';
  }

  function visitCard(v, i, pid) {
    var iso = v.d ? dmyToIso(v.d) : '';
    var date = (iso === null)
      ? '<input class="pm2-in sm" data-v="' + i + '" data-f="d" value="' + esc(v.d) + '" placeholder="dd/mm/yyyy">'
      : '<input type="date" class="pm2-in sm" data-v="' + i + '" data-f="d" value="' + (iso || '') + '">';
    var rows = S.pests.map(function (name, j) {
      var cur = (v.r || [])[j] || '';
      var sc = scoreOf(cur);
      var btns = LEVEL_SHORT.map(function (l, k) {
        return '<button type="button" class="pm2-lv' + (sc === k ? ' on' : '') + '" style="--c:' + LEVEL_COL[k] + '" data-lv="' + i + ':' + j + ':' + k + '">' + l + '</button>';
      }).join('');
      var odd = (sc === undefined) ? '<span class="pm2-odd" title="' + tt('ערך חופשי ישן', 'ค่าเดิม', 'قيمة قديمة') + '">“' + esc(cur) + '”</span>' : '';
      return '<div class="pm2-pr"><span class="pm2-pname">' + esc(name) + odd + '</span><span class="pm2-lvs">' + btns + '</span></div>';
    }).join('');
    var recOpts = RECS.concat(v.rec && RECS.indexOf(v.rec) === -1 ? [v.rec] : []);
    return '<div class="pm2-card pm2-visit">' +
      '<div class="pm2-vh">' + date +
        '<span class="pm2-vact">' +
          '<button type="button" class="pm2-btn ghost sm" data-copy="' + i + '" title="' + tt('העתק לחלקות נוספות', 'คัดลอก', 'نسخ') + '">⧉ ' + tt('העתק לחלקות', 'คัดลอก', 'نسخ') + '</button>' +
          '<button type="button" class="pm2-x" data-del="' + i + '" title="' + tt('מחיקת הביקור', 'ลบ', 'حذف') + '">🗑</button></span></div>' +
      rows +
      '<div class="pm2-grid2">' +
        '<label>' + tt('המלצת טיפול', 'คำแนะนำ', 'التوصية') + '<select class="pm2-in" data-v="' + i + '" data-f="rec">' +
          recOpts.map(function (r) { return '<option' + (r === v.rec ? ' selected' : '') + '>' + esc(r) + '</option>'; }).join('') + '</select></label>' +
        '<label>' + tt('הערות', 'หมายเหตุ', 'ملاحظات') + '<textarea class="pm2-in" rows="2" data-v="' + i + '" data-f="n">' + esc(v.n) + '</textarea></label>' +
      '</div></div>';
  }

  // ── wiring ──
  function wire() {
    var root = document.getElementById('pmRoot');
    if (!root) return;
    root.querySelectorAll('.pm2-fcb[data-some]').forEach(function (cb) { cb.indeterminate = true; });
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onChange);
  }
  function onClick(e) {
    var t = e.target;
    var b = t.closest('[data-a]');
    if (b) {
      var a = b.getAttribute('data-a');
      if (a === 'close') return close();
      if (a === 'save') return persistNow();
      if (a === 'print') return print();
      if (a === 'more') return moreMenu(b);
      if (a === 'list') { listOpen = !listOpen; var sd = document.querySelector('.pm2-side'); if (sd) sd.classList.toggle('open', listOpen); var ch = b.querySelector('.pm2-chev'); if (ch) ch.textContent = listOpen ? '▴' : '▾'; return; }
      if (a === 'selall') { plots().forEach(function (p) { S.selected[p.id] = true; }); persist(); return render(); }
      if (a === 'selnone') { S.selected = {}; persist(); return render(); }
      if (a === 'pests') return editPests();
      if (a === 'add') {
        var log = plotLog(active), prev = sortedVisits(log.visits)[0];
        log.visits.push(blankVisit(prev ? prev.rec : RECS[0]));
        S.selected[active] = true;
        persistNow(); return render();
      }
      if (a === 'legacy') { plotLog(active).visits = JSON.parse(JSON.stringify(S.legacy)); S.selected[active] = true; persistNow(); return render(); }
      return;
    }
    if (t.classList.contains('pm2-pcb') || t.classList.contains('pm2-fcb')) return;  // handled on change
    var ft = t.closest('[data-ftog]');
    if (ft) { var f = ft.getAttribute('data-ftog'); farmOpen[f] = !farmOpen[f]; var box = ft.closest('.pm2-farm').querySelector('.pm2-plots'); if (box) box.hidden = !box.hidden; var ic = ft.querySelector('i'); if (ic) ic.textContent = box && !box.hidden ? '▴' : '▾'; return; }
    var pl = t.closest('[data-plot]');
    if (pl) { active = pl.getAttribute('data-plot'); if (/^\d+$/.test(active)) active = Number(active); listOpen = false; var m0 = document.querySelector('#pmRoot .pm2-main'); if (m0) m0.scrollTop = 0; return render(); }
    var lv = t.closest('[data-lv]');
    if (lv) {
      var parts = lv.getAttribute('data-lv').split(':').map(Number);
      var v = plotLog(active).visits[parts[0]];
      if (!v) return;
      if (!Array.isArray(v.r)) v.r = [];
      var cur = scoreOf(v.r[parts[1]]);
      v.r[parts[1]] = (cur === parts[2]) ? '' : LEVELS[parts[2]];
      for (var k = 0; k < S.pests.length; k++) if (v.r[k] == null) v.r[k] = '';
      persist();
      // repaint just this row
      var row = lv.parentNode;
      row.querySelectorAll('.pm2-lv').forEach(function (x, k2) { x.classList.toggle('on', v.r[parts[1]] !== '' && k2 === parts[2]); });
      var odd = row.parentNode.querySelector('.pm2-odd'); if (odd) odd.remove();
      var sumEl = document.querySelector('#pmRoot .pm2-sum'), vs = plotLog(active).visits;
      if (sumEl) sumEl.innerHTML = S.pests.map(function (n, j) { return '<span><small>' + esc(n) + '</small><b>' + esc(summaryFor(vs, j)) + '</b></span>'; }).join('');
      return;
    }
    var del = t.closest('[data-del]');
    if (del) {
      var i = Number(del.getAttribute('data-del'));
      var vv = plotLog(active).visits[i];
      if (vv && hasContent(vv) && !confirm(tt('למחוק את הביקור מ־' + (vv.d || '') + '?', 'ลบ?', 'حذف الزيارة؟'))) return;
      plotLog(active).visits.splice(i, 1);
      persistNow(); return render();
    }
    var cp = t.closest('[data-copy]');
    if (cp) return copyVisit(Number(cp.getAttribute('data-copy')));
  }
  function onInput(e) {
    var t = e.target;
    if (t.id === 'pm2Q') {
      q = t.value;
      var side = document.querySelector('.pm2-side');
      if (side) { side.innerHTML = sideHtml(); side.querySelectorAll('.pm2-fcb[data-some]').forEach(function (cb) { cb.indeterminate = true; }); var nq = document.getElementById('pm2Q'); if (nq) { nq.focus(); nq.setSelectionRange(q.length, q.length); } }
      return;
    }
    var sk = t.getAttribute('data-s');
    if (sk && t.type !== 'checkbox') { S[sk] = t.value; persist(); return; }
    var vi = t.getAttribute('data-v');
    if (vi != null) {
      var v = plotLog(active).visits[Number(vi)];
      if (!v) return;
      var f = t.getAttribute('data-f');
      if (f === 'd') v.d = (t.type === 'date') ? isoToDmy(t.value) : t.value;
      else v[f] = t.value;
      persist();
    }
  }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'pm2Year') { if (saveTimer) persistNow(); year = t.value; active = null; return open(); }
    var sk = t.getAttribute('data-s');
    if (sk && t.type === 'checkbox') {
      S[sk] = t.checked; persist();
      if (sk === 'withMap' && t.checked) prepMaps();
      return;
    }
    if (t.getAttribute('data-f') === 'rec') return onInput(e);
    if (t.classList.contains('pm2-pcb')) {
      var id = t.value; if (/^\d+$/.test(id)) id = Number(id);
      if (t.checked) S.selected[id] = true; else delete S.selected[id];
      persist(); return render();
    }
    if (t.classList.contains('pm2-fcb')) {
      var fid = Number(t.getAttribute('data-farm')) || 0;
      plots().filter(function (p) { return (p.farm_id || 0) === fid; }).forEach(function (p) { if (t.checked) S.selected[p.id] = true; else delete S.selected[p.id]; });
      persist(); return render();
    }
  }

  function prepMaps() {
    if (!window.ReportMap || !ReportMap.prepare) return;
    var list = selectedPlots(), i = 0;
    var step = function () {
      if (i >= list.length) return;
      var p = list[i++];
      ReportMap.prepare({ plotId: p.id }).then(function () { setTimeout(step, 350); }, function () { setTimeout(step, 350); });
    };
    step();
    toast('⏳ ' + tt('מכין תצלומי לווין לחלקות המסומנות', 'กำลังเตรียมภาพ', 'جارٍ التجهيز'));
  }

  // Same visit (date, ratings, recommendation, notes) to other plots — a scout
  // who walked several blocks on one day with the same picture.
  function copyVisit(i) {
    var src = plotLog(active).visits[i];
    if (!src) return;
    var cur = plotById(active);
    var list = plots().filter(function (p) { return String(p.id) !== String(active); });
    var same = list.filter(function (p) { return cur && p.farm_id === cur.farm_id; });
    var other = list.filter(function (p) { return !cur || p.farm_id !== cur.farm_id; });
    var row = function (p) { return '<label class="pm2-cpl"><input type="checkbox" value="' + p.id + '"> ' + esc(p.name) + ' <small>' + esc(farmName(p.farm_id || 0)) + '</small></label>'; };
    var back = document.createElement('div');
    back.className = 'pm2-pop-back';
    back.innerHTML = '<div class="pm2-pop"><b>⧉ ' + tt('העתקת הביקור מ־', 'คัดลอกการเยี่ยม ', 'نسخ الزيارة ') + esc(src.d) + ' ' + tt('לחלקות:', 'ไปยัง:', 'إلى:') + '</b>' +
      '<div class="pm2-cplist">' + same.map(row).join('') + (other.length ? '<hr>' + other.map(row).join('') : '') + '</div>' +
      '<div class="pm2-row"><button type="button" class="pm2-btn pri" data-ok="1">' + tt('העתק', 'คัดลอก', 'نسخ') + '</button><button type="button" class="pm2-btn ghost" data-no="1">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    document.getElementById('pmRoot').appendChild(back);
    back.addEventListener('click', function (e) {
      if (e.target === back || e.target.getAttribute('data-no')) return back.remove();
      if (!e.target.getAttribute('data-ok')) return;
      var ids = Array.prototype.slice.call(back.querySelectorAll('input:checked')).map(function (x) { return /^\d+$/.test(x.value) ? Number(x.value) : x.value; });
      back.remove();
      if (!ids.length) return;
      ids.forEach(function (id) {
        var log = plotLog(id);
        var dup = log.visits.findIndex(function (v) { return v.d === src.d; });
        var copy = JSON.parse(JSON.stringify(src));
        if (dup !== -1) log.visits[dup] = copy; else log.visits.push(copy);
        S.selected[id] = true;
      });
      persistNow(); render();
      toast('✅ ' + tt('הביקור הועתק ל־', 'คัดลอกไป ', 'نُسخت إلى ') + ids.length + ' ' + tt('חלקות', 'แปลง', 'قطع'));
    });
  }

  function moreMenu(anchor) {
    var old = document.getElementById('pm2More');
    if (old) return old.remove();
    var r = anchor.getBoundingClientRect();
    var mm = document.createElement('div');
    mm.id = 'pm2More';
    mm.className = 'pm2-more';
    mm.style.top = (r.bottom + 6) + 'px';
    mm.style.left = Math.max(8, r.left - 160) + 'px';
    mm.innerHTML =
      '<button type="button" data-m="json">💾 ' + tt('ייצוא לקובץ (JSON)', 'ส่งออก JSON', 'تصدير JSON') + '</button>' +
      '<label>📂 ' + tt('טעינת קובץ', 'โหลดไฟล์', 'تحميل ملف') + '<input type="file" accept=".json" hidden></label>' +
      '<button type="button" data-m="field">📷 ' + tt('דוחות פרטניים (תצפיות)', 'รายงานเดี่ยว', 'تقارير مفردة') + '</button>' +
      '<button type="button" data-m="reset" class="warn">' + tt('איפוס נתוני ', 'รีเซ็ต ', 'تصفير ') + year + '</button>';
    document.body.appendChild(mm);
    var off = function (e) { if (!mm.contains(e.target) && e.target !== anchor) { mm.remove(); document.removeEventListener('click', off, true); } };
    setTimeout(function () { document.addEventListener('click', off, true); }, 0);
    mm.addEventListener('click', function (e) {
      var k = e.target.getAttribute('data-m');
      if (!k) return;
      mm.remove();
      if (k === 'json') exportJson();
      if (k === 'field' && window.FieldReport && FieldReport.showReportsList) FieldReport.showReportsList();
      if (k === 'reset') reset();
    });
    mm.querySelector('input[type=file]').addEventListener('change', function () { mm.remove(); importJson(this); });
  }

  function editPests() {
    var t = prompt(tt('מזיק בכל שורה:', 'หนึ่งชื่อต่อบรรทัด:', 'اسم لكل سطر:'), S.pests.join('\n'));
    if (t === null) return;
    var list = t.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!list.length) return;
    // Ratings are positional: remap every plot's visits by pest name.
    var old = S.pests.slice();
    var remap = function (v) { v.r = list.map(function (name) { var k = old.indexOf(name); return k === -1 ? '' : ((v.r || [])[k] || ''); }); };
    Object.keys(S.plots).forEach(function (pid) { S.plots[pid].visits.forEach(remap); });
    (S.legacy || []).forEach(remap);
    S.pests = list;
    persistNow(); render();
    toast('✅ ' + tt('רשימת המזיקים עודכנה', 'อัปเดตแล้ว', 'تم التحديث'));
  }
  function reset() {
    if (!confirm(tt('לאפס את כל ביקורי ' + year + ' בכל החלקות? כדאי לייצא קובץ לפני.', 'รีเซ็ต ' + year + '?', 'تصفير ' + year + '؟'))) return;
    S.plots = {}; delete S.legacy;
    persistNow(); render();
  }
  function exportJson() {
    var blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'פיקוח-מזיקים-' + (S.year || year) + '.json';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importJson(input) {
    var f = input && input.files && input.files[0];
    if (!f) return;
    var r = new FileReader();
    r.onload = function () {
      try {
        var d = JSON.parse(r.result);
        if (!d || (!Array.isArray(d.visits) && !d.plots)) throw new Error('shape');
        S = normalise(d);
        persistNow(); render();
        toast('✅ ' + tt('הקובץ נטען', 'โหลดแล้ว', 'تم التحميل'));
      } catch (e) { toast('❌ ' + tt('הקובץ אינו קובץ נתונים של המערכת', 'ไฟล์ไม่ถูกต้อง', 'ملف غير صالح')); }
    };
    r.readAsText(f);
  }

  // ── printed report: one A4-landscape page per ticked plot, its own visits ──
  function reportHtml(plot) {
    var pests = S.pests;
    var visits = ((S.plots[plot.id] || {}).visits || []).filter(hasContent).slice()
      .sort(function (a, b) { return dmyKey(a.d).localeCompare(dmyKey(b.d)); });
    var widths = [9].concat(pests.map(function () { return Math.floor(46 / Math.max(pests.length, 1)); })).concat([22, 22]);
    var head = ['תאריך ביקור'].concat(pests).concat(['המלצת טיפול', 'הערות'])
      .map(function (h, i) { return '<th style="width:' + (widths[i] || 10) + '%">' + esc(h) + '</th>'; }).join('');
    var rows = visits.map(function (v) {
      var c = '<td class="c">' + esc(v.d) + '</td>';
      for (var j = 0; j < pests.length; j++) {
        var val = (v.r || [])[j] || '', sc = scoreOf(val);
        c += '<td class="c"' + (sc != null && sc !== undefined ? ' style="background:' + LEVEL_COL[sc] + '33"' : '') + '>' + esc(val) + '</td>';
      }
      return '<tr>' + c + '<td>' + esc(v.rec) + '</td><td>' + esc(v.n) + '</td></tr>';
    }).join('') || '<tr><td colspan="' + (pests.length + 3) + '" class="c">אין ביקורים רשומים לחלקה זו</td></tr>';
    var fid = plot.farm_id || 0;
    var meta = [['משק', farmName(fid)], ['חלקה', plot.name || ''], ['שטח (דונם)', plot.area ? (Math.round(plot.area * 10) / 10) : ''], ['שנת גידול', S.year || year], ['ביקורים', visits.length]]
      .filter(function (kv) { return String(kv[1] === 0 ? '0' : kv[1] || '').trim() !== ''; })
      .map(function (kv) { return '<td class="k">' + esc(kv[0]) + '</td><td>' + esc(kv[1]) + '</td>'; }).join('');
    var mapUrl = (S.withMap && window.ReportMap && ReportMap.getCached) ? ReportMap.getCached({ plotId: plot.id }) : null;
    var sig = '<div class="sig">מבצע הפיקוח: <b>' + esc(S.inspector) + '</b>' + (S.signature ? ' &nbsp;&nbsp; חתימה: <span></span> &nbsp;&nbsp; תאריך: ____________' : '') + '</div>';
    return '<div class="report">' +
      '<div class="band"><h3>דוח פיקוח מזיקים — ' + esc(plot.name || '') + '</h3>' +
        '<div class="m">' + esc(farmName(fid)) + ' &nbsp;|&nbsp; מיקום: ' + esc(S.location) + ' &nbsp;|&nbsp; שנת גידול: ' + esc(S.year || year) + ' &nbsp;|&nbsp; מבצע הפיקוח: ' + esc(S.inspector) + '</div></div>' +
      '<table class="meta"><tr>' + meta + '</tr></table>' +
      (mapUrl ? '<div class="mapwrap"><img src="' + mapUrl + '" alt=""></div>' : '') +
      '<table class="log"><thead><tr>' + head + '</tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div class="scale"><b>סולם הערכה:</b> &nbsp; ' + SCALE_LABEL.map(function (l, i) { return i + ' = ' + l; }).join(' &nbsp;|&nbsp; ') + '</div>' +
      '<h4>סיכום שנתי — רמת נגיעות לפי מזיק (ממוצע · החמור שנרשם)</h4>' +
      '<table class="sum"><tr>' + pests.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr>' +
      '<tr>' + pests.map(function (p, j) { return '<td>' + esc(summaryFor(visits, j)) + '</td>'; }).join('') + '</tr></table>' +
      sig + '</div>';
  }
  function printStyles() {
    return '@page { size: A4 landscape; margin: 11mm 10mm; }' +
      'body{margin:0;background:#fff;color:#1b2a1f;font-family:"Rubik","Heebo","Segoe UI",Arial,sans-serif;font-size:14px;line-height:1.45}' +
      '.report{page-break-after:always}.report:last-child{page-break-after:auto}' +
      '.band{background:#12401f;color:#fff;padding:9px 12px;border-radius:6px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.band h3{margin:0 0 3px;font-size:15px}.band .m{font-size:10px;color:#dfeccf}' +
      '.meta{width:100%;border-collapse:collapse;margin-top:8px}.meta td{border:1px solid #d6e0cf;padding:5px 8px;font-size:10px}' +
      '.meta .k{background:#eef7d4;font-weight:700;color:#12401f;width:10%;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      '.mapwrap{margin-top:9px;page-break-inside:avoid;break-inside:avoid}.mapwrap img{width:100%;height:auto;display:block;border:1px solid #d6e0cf}' +
      'table.log{width:100%;border-collapse:collapse;margin-top:10px}' +
      'table.log th{background:#1d5a2c;color:#fff;font-size:9px;padding:5px 3px;border:1px solid #12401f;text-align:center;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'table.log td{font-size:9.5px;padding:5px 4px;border:1px solid #d6e0cf;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'table.log td.c{text-align:center;white-space:nowrap}' +
      '.scale{background:#f4f7f1;border:1px solid #d6e0cf;padding:6px 10px;font-size:9.5px;margin-top:9px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'h4{font-size:11px;color:#12401f;margin:12px 0 5px;border-right:4px solid #c5e663;padding-right:7px}' +
      'table.sum{width:100%;border-collapse:collapse}' +
      'table.sum th{background:#eef7d4;border:1px solid #d6e0cf;font-size:9.5px;padding:5px 3px;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
      'table.sum td{text-align:center;padding:8px 4px;font-size:10px;border:1px solid #d6e0cf}' +
      '.sig{margin-top:20px;font-size:10px}.sig span{display:inline-block;border-bottom:1px solid #12401f;width:140px}';
  }
  function print() {
    if (saveTimer) persistNow();
    var sel = selectedPlots();
    if (!sel.length) { toast('❌ ' + tt('סמן ☑ לפחות חלקה אחת להדפסה', 'เลือกอย่างน้อยหนึ่งแปลง', 'اختر قطعة واحدة على الأقل')); return; }
    var html = '<!DOCTYPE html>\n<html lang="he" dir="rtl">\n<head>\n<meta charset="UTF-8">\n<title>דוחות פיקוח מזיקים ' + esc(S.year || year) + '</title>\n' +
      '<style>' + printStyles() + '</style>\n</head>\n<body>\n' + sel.map(reportHtml).join('\n') + '\n</body>\n</html>';
    if (window.Util && typeof Util.exportReport === 'function') Util.exportReport(html, 'פיקוח_מזיקים_' + (S.year || year) + '.html');
    toast('📄 ' + sel.length + ' ' + tt('דוחות נפתחו — בחר הדפסה / שמור כ-PDF', 'เอกสารเปิดแล้ว', 'فُتحت التقارير'));
  }

  function ensureCss() {
    if (document.getElementById('pm2Css')) return;
    var st = document.createElement('style');
    st.id = 'pm2Css';
    st.textContent =
      '.pm2-back{padding:0 !important;align-items:stretch !important;background:rgba(16,24,20,.45) !important;}' +
      '.pm2{background:var(--bg,#f8faf6);color:var(--text,#1b2a1f);width:100%;max-width:1400px;margin:0 auto;display:flex;flex-direction:column;height:100dvh;}' +
      '@media(min-width:900px){.pm2-back{padding:18px !important;}.pm2{height:calc(100dvh - 36px);border-radius:24px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.25);}}' +
      '.pm2-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:12px 14px;background:var(--card,#fff);border-bottom:1px solid var(--line,#e6ebe2);}' +
      '.pm2-title{display:flex;flex-direction:column;gap:2px;}.pm2-title b{font-size:1.05rem;}' +
      '.pm2-save{font-size:.72rem;color:var(--text-muted,#6f7b72);}.pm2-save.ok{color:#2e7d32;font-weight:600;}.pm2-save.s{color:#a86a00;}.pm2-save.err{color:#b3261e;font-weight:600;}' +
      '.pm2-tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;}' +
      '.pm2-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:8px 12px;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;white-space:nowrap;}' +
      '.pm2-btn.pri{background:var(--grad-primary,linear-gradient(145deg,#2a6b36,#12401f));color:#fff;border-color:transparent;box-shadow:0 4px 12px rgba(18,64,31,.2);}' +
      '.pm2-btn.ghost{background:transparent;}.pm2-btn.sm{padding:5px 10px;font-size:.76rem;}' +
      '.pm2-in{width:100%;box-sizing:border-box;border:1.5px solid transparent;background:var(--tonal,#f1f4ee);color:var(--text,#1b2a1f);border-radius:12px;padding:9px 11px;font:inherit;font-size:.86rem;}' +
      '.pm2-in:focus{outline:0;border-color:var(--primary,#1d5a2c);background:var(--card,#fff);}.pm2-in.sm{width:auto;padding:6px 9px;}' +
      '.pm2-body{flex:1;min-height:0;display:flex;flex-direction:column;}' +
      '@media(min-width:900px){.pm2-body{flex-direction:row;}}' +
      '.pm2-side{background:var(--card,#fff);border-bottom:1px solid var(--line,#e6ebe2);}' +
      '@media(min-width:900px){.pm2-side{width:330px;flex:none;border-bottom:0;border-left:1px solid var(--line,#e6ebe2);overflow-y:auto;}.pm2-cur{display:none !important;}.pm2-list{display:block !important;}}' +
      '.pm2-cur{display:flex;width:100%;justify-content:space-between;align-items:center;border:0;background:none;padding:12px 14px;font:inherit;font-size:.9rem;color:inherit;cursor:pointer;}' +
      '.pm2-list{display:none;padding:10px 12px 14px;max-height:55dvh;overflow-y:auto;}.pm2-side.open .pm2-list{display:block;}' +
      '@media(min-width:900px){.pm2-list{max-height:none;}}' +
      '.pm2-hint{font-size:.7rem;color:var(--text-muted,#6f7b72);margin:6px 2px 8px;}' +
      '.pm2-farm{margin-bottom:6px;}.pm2-fh{display:flex;align-items:center;gap:6px;}' +
      '.pm2-ft{flex:1;display:flex;gap:8px;align-items:center;border:0;background:var(--tonal,#f1f4ee);border-radius:12px;padding:8px 10px;font:inherit;color:inherit;cursor:pointer;}' +
      '.pm2-ft b{flex:1;text-align:right;font-size:.86rem;}.pm2-ft span{font-size:.72rem;color:var(--text-muted,#6f7b72);}.pm2-ft i{font-style:normal;font-size:.7rem;}' +
      '.pm2-plots{padding:4px 0 2px;}' +
      '.pm2-pl{display:flex;align-items:center;gap:8px;padding:8px 8px;border-radius:12px;cursor:pointer;}' +
      '.pm2-pl:hover{background:var(--tonal,#f1f4ee);}' +
      '.pm2-pl.on{background:var(--grad-primary,linear-gradient(145deg,#2a6b36,#12401f));color:#fff;}.pm2-pl.on small{color:rgba(255,255,255,.8);}' +
      '.pm2-dot{width:10px;height:10px;border-radius:50%;flex:none;}' +
      '.pm2-pn{flex:1;min-width:0;}.pm2-pn b{display:block;font-size:.85rem;font-weight:600;}.pm2-pn small{font-size:.7rem;color:var(--text-muted,#6f7b72);}' +
      '.pm2-main{flex:1;min-height:0;overflow-y:auto;padding:12px 14px 40px;-webkit-overflow-scrolling:touch;}' +
      '.pm2-card{background:var(--card,#fff);border:1px solid var(--line,#e6ebe2);border-radius:20px;padding:12px 14px;margin-bottom:12px;}' +
      '.pm2-info summary{cursor:pointer;font-weight:600;font-size:.86rem;}.pm2-info summary small{font-weight:400;color:var(--text-muted,#6f7b72);}' +
      '.pm2-grid2{display:grid;gap:8px;margin-top:8px;}@media(min-width:620px){.pm2-grid2{grid-template-columns:1fr 1fr;}}' +
      '.pm2-grid2 label{display:flex;flex-direction:column;gap:4px;font-size:.74rem;color:var(--text-muted,#6f7b72);}' +
      '.pm2-chk{display:flex;align-items:center;gap:6px;font-size:.8rem;margin-top:8px;cursor:pointer;}' +
      '.pm2-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}' +
      '.pm2-ph{display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap;margin:4px 2px 12px;}' +
      '.pm2-ph h3{margin:0;font-size:1.25rem;}.pm2-ph small{color:var(--text-muted,#6f7b72);font-size:.76rem;}' +
      '.pm2-ph-a{display:flex;gap:10px;align-items:center;}.pm2-ph-a .pm2-chk{margin:0;}' +
      '.pm2-sum{display:flex;gap:8px;overflow-x:auto;margin-bottom:12px;padding-bottom:2px;}' +
      '.pm2-sum span{flex:none;background:var(--primary-soft,#eef7d4);border-radius:14px;padding:7px 11px;}' +
      '.pm2-sum small{display:block;font-size:.66rem;color:var(--text-muted,#6f7b72);}.pm2-sum b{font-size:.78rem;}' +
      '.pm2-vh{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px;}.pm2-vact{display:flex;gap:4px;align-items:center;}' +
      '.pm2-x{border:0;background:var(--tonal,#f1f4ee);border-radius:10px;width:32px;height:32px;cursor:pointer;}' +
      '.pm2-pr{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid var(--line,#eef1ec);flex-wrap:wrap;}' +
      '.pm2-pname{font-size:.84rem;font-weight:600;}.pm2-odd{font-weight:400;font-size:.72rem;color:#a86a00;margin-inline-start:6px;}' +
      '.pm2-lvs{display:flex;gap:4px;flex-wrap:wrap;}' +
      '.pm2-lv{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--text,#1b2a1f);border-radius:10px;padding:6px 9px;font:inherit;font-size:.74rem;cursor:pointer;min-width:46px;}' +
      '.pm2-lv.on{background:var(--c);border-color:var(--c);color:#fff;font-weight:700;text-shadow:0 1px 1px rgba(0,0,0,.2);}' +
      '.pm2-legend{font-size:.72rem;color:var(--text-muted,#6f7b72);margin-top:6px;line-height:1.9;}.pm2-legend i{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 3px -1px;}' +
      '.pm2-legacy{background:#fff4e2;color:#7a4a00;border-radius:14px;padding:10px 12px;margin-bottom:12px;font-size:.82rem;}' +
      '.pm2-empty{padding:18px;text-align:center;color:var(--text-muted,#6f7b72);font-size:.84rem;}.pm2-empty.big{padding:50px 18px;}' +
      '.pm2-more{position:fixed;z-index:100001;background:var(--card,#fff);border:1px solid var(--line,#e6ebe2);border-radius:16px;box-shadow:0 12px 30px rgba(0,0,0,.18);padding:6px;display:flex;flex-direction:column;min-width:210px;}' +
      '.pm2-more button,.pm2-more label{border:0;background:none;text-align:right;padding:10px 12px;border-radius:10px;font:inherit;font-size:.84rem;color:var(--text,#1b2a1f);cursor:pointer;}' +
      '.pm2-more button:hover,.pm2-more label:hover{background:var(--tonal,#f1f4ee);}.pm2-more .warn{color:#b3261e;}' +
      '.pm2-pop-back{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:14px;}' +
      '.pm2-pop{background:var(--card,#fff);color:var(--text,#1b2a1f);border-radius:20px;padding:16px;width:100%;max-width:420px;max-height:80dvh;display:flex;flex-direction:column;}' +
      '.pm2-cplist{overflow-y:auto;margin:10px 0;}.pm2-cpl{display:flex;gap:8px;align-items:center;padding:7px 4px;font-size:.86rem;}.pm2-cpl small{color:var(--text-muted,#6f7b72);}' +
      '.pm2-cplist hr{border:0;border-top:1px solid var(--line,#e6ebe2);margin:6px 0;}';
    document.head.appendChild(st);
  }

  return {
    open: open,
    close: close,
    print: print,
    // Test seams.
    _state: function () { return S; },
    _summary: function (pid, j) { return summaryFor(((S.plots[pid] || {}).visits) || [], j); },
    _normalise: normalise
  };
})();
window.PestMonitor = PestMonitor;
