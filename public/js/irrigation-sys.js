/* irrigation-sys.js — irrigation heads and per-plot irrigation systems (Oct 2026)
 *
 * Per משק: its irrigation heads (ראש מערכת / בקר) — main valve, number of
 * valves, water meters, filter type and filter valves, water source.
 * Per חלקה: which head and line feed it, its valves, and the emitter layout,
 * from which the nominal flow (m³/h) is calculated and set against the
 * measured flow:
 *   tree  — drippers per tree × L/h, over trees (+ males for date palms):
 *           (213 + 39) × 8 × 8.5 L/h = 17.1 m³/h
 *   line  — dripper line: L/h every N cm, laterals per row, row spacing:
 *           area / row × laterals / spacing × L/h
 *   dunam — a flow per dunam × dunams (when that is how the plot is known)
 * The farm table groups plots by head, totals trees, dunams and flow, and
 * flags plots whose measured flow is more than 10% off the nominal.
 *
 * Data: farm.irr_heads[] and plot.irr (plotMapperSprayData), written through
 * SprayStore (farm permission checked there).
 *
 * Public: IrrigSys.sectionHtml(farmId), IrrigSys.bind(farmId),
 *         IrrigSys.open(farmId), IrrigSys.plotHtml(plotId, farmId),
 *         IrrigSys.nominal(plot)
 */
var IrrigSys = (function () {
  'use strict';

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function S() { return window.SprayStore || {}; }
  function n1(x) { return (Math.round((Number(x) || 0) * 10) / 10).toLocaleString('he-IL'); }
  var DEFAULT_LPH = 8.5, DEV_PCT = 10;

  var FILTERS = [['manual', 'ידני'], ['auto', 'אוטומטי'], ['auto-field', 'אוטומטי במגופי שטח'], ['none', 'ללא']];
  var WATER = [['wells', 'בארות'], ['reclaimed', 'קולחין'], ['mekorot', 'מקורות'], ['mixed', 'מעורב'], ['other', 'אחר']];
  function lbl(list, v) { var x = list.find(function (o) { return o[0] === v; }); return x ? x[1] : (v || ''); }
  function isDate(p) { return /תמר/.test(String(p.crop_type || '')); }

  // ── nominal flow, m³/h ──
  function nominal(p) {
    var i = p.irr || {};
    var lph = Number(i.lph) || DEFAULT_LPH;
    if (i.mode === 'tree') {
      var trees = (Number(p.tree_count) || 0) + (isDate(p) && i.males !== false ? (Number(p.male_trees) || 0) : 0);
      var d = Number(i.dpt) || 0;
      return trees && d ? trees * d * lph / 1000 : null;
    }
    if (i.mode === 'line') {
      var row = Number(i.row_m) || Number(p.row_spacing) || 0, sp = Number(i.spacing_cm) || 0;
      if (!row || !sp || !p.area) return null;
      var meters = p.area * 1000 / row * (Number(i.laterals) || 1);
      return meters / (sp / 100) * lph / 1000;
    }
    if (i.mode === 'dunam') {
      var pd = Number(i.per_dunam) || 0;
      return pd && p.area ? pd * p.area : null;
    }
    return null;
  }
  function emitterText(p) {
    var i = p.irr || {};
    if (i.mode === 'tree') return (i.dpt || '?') + ' × ' + (i.lph || DEFAULT_LPH) + ' ' + tt('ל׳/ש לעץ', 'ล./ชม./ต้น', 'ل/س للشجرة');
    if (i.mode === 'line') return (i.lph || DEFAULT_LPH) + '/' + (i.spacing_cm || '?') + (Number(i.laterals) > 1 ? ' ×' + i.laterals : '');
    if (i.mode === 'dunam') return (i.per_dunam || '?') + ' ' + tt('מק״ש לדונם', 'ลบ.ม./ชม./ไร่', 'م³/س/دونم');
    return '—';
  }
  function deviation(p) {
    var nom = nominal(p), act = Number((p.irr || {}).actual) || 0;
    if (!nom || !act) return null;
    return (act / nom - 1) * 100;
  }

  function ensureCss() {
    if (document.getElementById('irCss')) return;
    var st = document.createElement('style');
    st.id = 'irCss';
    st.textContent =
      '.ir-wrap{overflow:auto;border:1px solid var(--line,#dbe3d8);border-radius:12px;margin:6px 0;}' +
      '.ir-tbl{width:100%;border-collapse:collapse;font-size:.78rem;min-width:760px;}' +
      '.ir-tbl th{background:var(--g6,#eef2ee);font-weight:600;font-size:.7rem;color:var(--text-muted,#555);text-align:right;padding:6px;white-space:nowrap;}' +
      '.ir-tbl td{padding:6px;border-top:1px solid var(--line,#e5e9e4);white-space:nowrap;}' +
      '.ir-tbl tr.head td{background:var(--primary-soft,#e2efe7);font-weight:700;white-space:normal;}' +
      '.ir-tbl tr.head small{font-weight:400;color:var(--text-muted,#555);}' +
      '.ir-tbl tr.tot td{font-weight:700;background:#f4f7f4;}' +
      '.ir-tbl td.num{font-variant-numeric:tabular-nums;}' +
      '.ir-bad{color:#b3261e;font-weight:700;}.ir-ok{color:var(--primary,#2d6a4f);}' +
      '.ir-e{border:0;background:var(--g6,#eef2ee);border-radius:8px;padding:3px 8px;cursor:pointer;font:inherit;font-size:.74rem;}' +
      '.ir-bar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;}' +
      '.ir-btn{border:0;border-radius:99px;padding:8px 14px;background:var(--primary,#2d6a4f);color:#fff;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.ir-btn.ghost{background:transparent;color:var(--primary,#2d6a4f);border:1px solid var(--line,#dbe3d8);}' +
      '.ir-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}.ir-grid .form-group{margin:0;}.ir-grid .full{grid-column:1/-1;}' +
      '.ir-head-row{border:1px solid var(--line,#dbe3d8);border-radius:12px;padding:8px;margin-bottom:8px;}' +
      '.ir-sum{font-size:.8rem;background:var(--g6,#f2f5f2);border-radius:10px;padding:8px 10px;margin-top:8px;line-height:1.6;}';
    document.head.appendChild(st);
  }

  // ── farm detail section ──
  function sectionHtml(farmId) {
    if (!S().getFarmPlots) return '';
    ensureCss();
    var plots = S().getFarmPlots(farmId), heads = S().getIrrHeads(farmId);
    var withIrr = plots.filter(function (p) { return p.irr; });
    if (!withIrr.length && !heads.length && !S().canEditFarm(farmId)) return '';
    var tot = 0, bad = 0;
    withIrr.forEach(function (p) { tot += nominal(p) || 0; var d = deviation(p); if (d != null && Math.abs(d) > DEV_PCT) bad++; });
    return '<div class="section-title" style="margin-top: 14px;">🚿 ' + tt('מערכות השקיה', 'ระบบน้ำ', 'أنظمة الري') + '</div>' +
      '<div class="ir-sum">' + heads.length + ' ' + tt('ראשי מערכת', 'หัวระบบ', 'رؤوس') + ' · ' + withIrr.length + '/' + plots.length + ' ' +
        tt('חלקות מוגדרות', 'แปลงที่กำหนด', 'قطع محددة') + (tot ? ' · ' + tt('ספיקה נומינלית', 'อัตราไหล', 'التدفق الاسمي') + ' <b>' + n1(tot) + '</b> ' + tt('מק״ש', 'ลบ.ม./ชม.', 'م³/س') : '') +
        (bad ? ' · <span class="ir-bad">⚠️ ' + bad + ' ' + tt('חריגות ספיקה', 'ผิดปกติ', 'انحرافات') + '</span>' : '') + '</div>' +
      '<div class="ir-bar"><button type="button" class="ir-btn ghost" id="irOpen">🚿 ' + tt('טבלת השקיה', 'ตารางน้ำ', 'جدول الري') + '</button></div>';
  }
  function bind(farmId) {
    var b = document.getElementById('irOpen');
    if (b) b.addEventListener('click', function () { open(farmId); });
  }

  function modal(inner, wide) {
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay"><div class="modal" style="max-width:' + (wide ? 1100 : 560) + 'px;">' + inner + '</div></div>';
  }
  function back(farmId) {
    if (typeof window.showFarmDetailsGlobal === 'function') window.showFarmDetailsGlobal(farmId);
    else document.getElementById('modalContainer').innerHTML = '';
  }

  function tableHtml(farmId, forPrint) {
    var plots = S().getFarmPlots(farmId), heads = S().getIrrHeads(farmId);
    var can = !forPrint && S().canEditFarm(farmId);
    var groups = heads.map(function (h) { return { h: h, plots: [] }; });
    var none = { h: null, plots: [] };
    plots.forEach(function (p) {
      var g = p.irr && p.irr.head ? groups.find(function (x) { return x.h.id === p.irr.head; }) : null;
      (g || none).plots.push(p);
    });
    if (none.plots.length) groups.push(none);
    var cols = 12 + (can ? 1 : 0);
    var body = groups.map(function (g) {
      var h = g.h, rows = '';
      g.plots.sort(function (a, b) {
        var la = String((a.irr || {}).line || ''), lb = String((b.irr || {}).line || '');
        return la.localeCompare(lb, 'he', { numeric: true }) || String(a.name).localeCompare(String(b.name), 'he', { numeric: true });
      });
      var tT = 0, tD = 0, tF = 0, tA = 0;
      g.plots.forEach(function (p) {
        var i = p.irr || {}, nom = nominal(p), dev = deviation(p);
        var trees = (p.tree_count || 0), males = isDate(p) ? (p.male_trees || 0) : 0;
        tT += trees + males; tD += p.area || 0; tF += nom || 0; tA += Number(i.actual) || 0;
        rows += '<tr><td>' + esc(p.name) + '</td><td>' + esc(i.line || '') + '</td><td>' + esc(i.valves || '') + '</td>' +
          '<td>' + esc([p.crop_type, p.variety].filter(Boolean).join(' · ')) + '</td>' +
          '<td class="num">' + (trees || '') + (males ? ' <small>+' + males + '♂</small>' : '') + '</td>' +
          '<td class="num">' + n1(p.area) + '</td><td class="num">' + (p.planting_date ? String(p.planting_date).slice(0, 4) : '') + '</td>' +
          '<td>' + esc(p.irr ? emitterText(p) : '—') + '</td>' +
          '<td class="num"><b>' + (nom ? n1(nom) : '—') + '</b></td>' +
          '<td class="num">' + (nom && p.area ? (Math.round(nom / p.area * 100) / 100) : '') + '</td>' +
          '<td class="num">' + (i.actual ? n1(i.actual) : '') + '</td>' +
          '<td class="num ' + (dev == null ? '' : (Math.abs(dev) > DEV_PCT ? 'ir-bad' : 'ir-ok')) + '">' + (dev == null ? '' : (dev > 0 ? '+' : '') + Math.round(dev) + '%') + '</td>' +
          (can ? '<td><button class="ir-e" data-ir-plot="' + p.id + '">✏️</button></td>' : '') + '</tr>';
      });
      var headRow = '<tr class="head"><td colspan="' + cols + '">' + (h ?
        '🚰 ' + esc(h.name) + (h.controller ? ' · ' + tt('בקר', 'ตัวควบคุม', 'وحدة التحكم') + ' ' + esc(h.controller) : '') +
        ' <small>· ' + [h.main_valve ? tt('מגוף ראשי', 'วาล์วหลัก', 'صمام رئيسي') : '', h.valves ? h.valves + ' ' + tt('מגופים', 'วาล์ว', 'صمامات') : '',
          h.meters ? h.meters + ' ' + tt('מדי מים', 'มาตรน้ำ', 'عدادات') : '', h.filter ? tt('מסנן', 'กรอง', 'فلتر') + ' ' + lbl(FILTERS, h.filter) : '',
          h.filter_valves ? h.filter_valves + ' ' + tt('מגופי סינון', 'วาล์วกรอง', 'صمامات فلترة') : '', h.water ? tt('מים', 'น้ำ', 'مياه') + ': ' + lbl(WATER, h.water) : ''].filter(Boolean).join(' · ') + '</small>'
        : '❔ ' + tt('חלקות ללא ראש מערכת', 'แปลงที่ไม่มีหัวระบบ', 'قطع بلا رأس')) + '</td></tr>';
      var totRow = g.plots.length > 1 ? '<tr class="tot"><td colspan="4">' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td class="num">' + tT.toLocaleString('he-IL') + '</td><td class="num">' + n1(tD) +
        '</td><td colspan="2"></td><td class="num">' + (tF ? n1(tF) : '—') + '</td><td></td><td class="num">' + (tA ? n1(tA) : '') + '</td><td colspan="' + (can ? 2 : 1) + '"></td></tr>' : '';
      return headRow + rows + totRow;
    }).join('');
    return '<div class="ir-wrap"><table class="ir-tbl"><thead><tr>' +
      ['חלקה', 'קו', 'מגופים', 'גידול / זן', 'עצים', 'דונם', 'נטיעה', 'אביזר השקיה', 'ספיקה נומינלית (מק״ש)', 'לדונם', 'ספיקה בפועל', 'סטייה'].map(function (h) { return '<th>' + h + '</th>'; }).join('') +
      (can ? '<th></th>' : '') + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function open(farmId) {
    ensureCss();
    var can = S().canEditFarm(farmId);
    var info = S().getVehicles ? S().getVehicles(farmId) : { farmName: '' };
    modal('<h2>🚿 ' + tt('מערכות השקיה', 'ระบบน้ำ', 'أنظمة الري') + ' — ' + esc(info.farmName) + '</h2>' +
      '<p style="margin:0 0 4px;font-size:.8rem;">' + tt('ספיקה נומינלית מחושבת מאביזר ההשקיה של כל חלקה; סטייה של יותר מ-10% מהספיקה בפועל מסומנת באדום.',
        'อัตราไหลคำนวณจากหัวน้ำหยด', 'التدفق الاسمي محسوب من نقاط التنقيط') + '</p>' +
      tableHtml(farmId) +
      '<div class="ir-bar">' + (can ? '<button class="ir-btn" id="irHeads">🚰 ' + tt('ראשי מערכת', 'หัวระบบ', 'رؤوس الري') + '</button>' : '') +
        '<button class="ir-btn ghost" id="irPrint">🖨️ ' + tt('הדפס / PDF', 'พิมพ์', 'طباعة') + '</button></div>' +
      '<div class="modal-buttons"><button class="btn btn-secondary" id="irBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>', true);
    document.getElementById('irBack').addEventListener('click', function () { back(farmId); });
    var hb = document.getElementById('irHeads');
    if (hb) hb.addEventListener('click', function () { editHeads(farmId); });
    document.getElementById('irPrint').addEventListener('click', function () {
      var title = tt('מערכות השקיה', 'ระบบน้ำ', 'أنظمة الري') + ' — ' + info.farmName;
      var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
        'body{font-family:Rubik,Arial,sans-serif;margin:14px;color:#222;}h1{font-size:1.15rem;color:#0c3b30;}' +
        'table{width:100%;border-collapse:collapse;font-size:.74rem;}th{background:#e1eee8;text-align:right;padding:5px;}td{padding:5px;border-bottom:1px solid #ddd;}' +
        'tr.head td{background:#eef6f1;font-weight:700;}tr.tot td{font-weight:700;background:#f6f8f6;}.ir-bad{color:#b3261e;font-weight:700;}' +
        '@page{size:A4 landscape;margin:10mm;}</style></head><body><h1>' + esc(title) + '</h1>' + tableHtml(farmId, true) + '</body></html>';
      if (window.Util && Util.exportReport) Util.exportReport(html, 'irrigation-' + farmId + '.html');
    });
    document.querySelectorAll('[data-ir-plot]').forEach(function (b) {
      b.addEventListener('click', function () { editPlot(Number(b.getAttribute('data-ir-plot')), farmId, function () { open(farmId); }); });
    });
  }

  function opts(list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }

  function editHeads(farmId) {
    var heads = S().getIrrHeads(farmId);
    function row(h, i) {
      return '<div class="ir-head-row" data-i="' + i + '"><div class="ir-grid">' +
        '<div class="form-group"><label class="form-label">' + tt('שם ראש מערכת', 'ชื่อหัวระบบ', 'اسم الرأس') + '</label><input class="form-input irh-name" value="' + esc(h.name || '') + '"></div>' +
        '<div class="form-group"><label class="form-label">' + tt('בקר', 'ตัวควบคุม', 'وحدة التحكم') + '</label><input class="form-input irh-ctrl" value="' + esc(h.controller || '') + '"></div>' +
        '<div class="form-group"><label class="form-label">' + tt('מגופים', 'วาล์ว', 'صمامات') + '</label><input class="form-input irh-valves" type="number" min="0" value="' + (h.valves || '') + '"></div>' +
        '<div class="form-group"><label class="form-label">' + tt('מדי מים', 'มาตรน้ำ', 'عدادات') + '</label><input class="form-input irh-meters" type="number" min="0" value="' + (h.meters || '') + '"></div>' +
        '<div class="form-group"><label class="form-label">' + tt('מסנן', 'กรอง', 'فلتر') + '</label><select class="form-input irh-filter"><option value="">—</option>' + opts(FILTERS, h.filter) + '</select></div>' +
        '<div class="form-group"><label class="form-label">' + tt('מגופי סינון', 'วาล์วกรอง', 'صمامات فلترة') + '</label><input class="form-input irh-fv" type="number" min="0" value="' + (h.filter_valves || '') + '"></div>' +
        '<div class="form-group"><label class="form-label">' + tt('מקור מים', 'แหล่งน้ำ', 'مصدر المياه') + '</label><select class="form-input irh-water"><option value="">—</option>' + opts(WATER, h.water) + '</select></div>' +
        '<div class="form-group"><label class="form-label"><input type="checkbox" class="irh-main"' + (h.main_valve ? ' checked' : '') + '> ' + tt('מגוף ראשי', 'วาล์วหลัก', 'صمام رئيسي') + '</label>' +
          '<button type="button" class="ir-e" onclick="this.closest(\'.ir-head-row\').remove()" style="margin-top:6px;">🗑 ' + tt('הסר', 'ลบ', 'إزالة') + '</button></div>' +
      '</div></div>';
    }
    modal('<h2>🚰 ' + tt('ראשי מערכת', 'หัวระบบ', 'رؤوس الري') + '</h2><div id="irhList">' + heads.map(row).join('') + '</div>' +
      '<div class="ir-bar"><button class="ir-btn ghost" id="irhAdd">➕ ' + tt('ראש מערכת', 'เพิ่มหัวระบบ', 'إضافة رأس') + '</button></div>' +
      '<div class="modal-buttons"><button class="btn btn-primary" id="irhSave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="btn btn-secondary" id="irhBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>');
    document.getElementById('irhAdd').addEventListener('click', function () {
      var d = document.createElement('div'); d.innerHTML = row({}, -1);
      document.getElementById('irhList').appendChild(d.firstChild);
    });
    document.getElementById('irhBack').addEventListener('click', function () { open(farmId); });
    document.getElementById('irhSave').addEventListener('click', function () {
      var out = [];
      document.querySelectorAll('#irhList .ir-head-row').forEach(function (r, k) {
        var i = Number(r.getAttribute('data-i'));
        var name = r.querySelector('.irh-name').value.trim();
        if (!name) return;
        var prev = i >= 0 ? heads[i] : null;
        out.push({
          id: prev ? prev.id : Date.now() + k, name: name, controller: r.querySelector('.irh-ctrl').value.trim(),
          valves: Number(r.querySelector('.irh-valves').value) || 0, meters: Number(r.querySelector('.irh-meters').value) || 0,
          filter: r.querySelector('.irh-filter').value, filter_valves: Number(r.querySelector('.irh-fv').value) || 0,
          water: r.querySelector('.irh-water').value, main_valve: r.querySelector('.irh-main').checked
        });
      });
      var res = S().setIrrHeads(farmId, out);
      if (!res || !res.ok) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'حُفظ'));
      open(farmId);
    });
  }

  function editPlot(plotId, farmId, done) {
    var p = S().getFarmPlots(farmId).find(function (x) { return x.id === plotId; });
    if (!p) return;
    var heads = S().getIrrHeads(farmId);
    var i = p.irr || { mode: isDate(p) ? 'tree' : 'line', lph: DEFAULT_LPH, males: true };
    function f(id, label, val, type, cls, extra) {
      return '<div class="form-group' + (cls ? ' ' + cls : '') + '"><label class="form-label">' + label + '</label><input class="form-input" id="' + id + '" type="' + (type || 'text') + '" step="any" value="' + esc(val == null ? '' : val) + '"' + (extra || '') + '></div>';
    }
    function draw() {
      var mode = i.mode || 'tree';
      modal('<h2>🚿 ' + esc(p.name) + '</h2>' +
        '<div class="ir-grid">' +
          '<div class="form-group"><label class="form-label">' + tt('ראש מערכת', 'หัวระบบ', 'رأس الري') + '</label><select class="form-input" id="ipHead"><option value="">—</option>' +
            heads.map(function (h) { return '<option value="' + h.id + '"' + (h.id === i.head ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select></div>' +
          f('ipLine', tt('קו', 'สาย', 'الخط'), i.line) +
          f('ipValves', tt('מגופים (למשל 1.1, 1.2)', 'วาล์ว', 'الصمامات'), i.valves, 'text', 'full') +
          '<div class="form-group full"><label class="form-label">' + tt('אביזר השקיה', 'หัวน้ำ', 'نقاط الري') + '</label><select class="form-input" id="ipMode">' +
            [['tree', tt('טפטפות לעץ', 'หัวน้ำต่อต้น', 'نقاط لكل شجرة')], ['line', tt('שלוחת טפטוף (ל׳/ש כל X ס״מ)', 'สายน้ำหยด', 'خط تنقيط')], ['dunam', tt('ספיקה לדונם', 'อัตราต่อไร่', 'تدفق لكل دونم')]]
              .map(function (o) { return '<option value="' + o[0] + '"' + (mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
          (mode === 'tree' ? f('ipDpt', tt('טפטפות לעץ', 'หัวต่อต้น', 'نقاط/شجرة'), i.dpt, 'number') + f('ipLph', tt('ספיקת טפטפת (ל׳/ש)', 'ลิตร/ชม.', 'لتر/س'), i.lph || DEFAULT_LPH, 'number') +
            (isDate(p) ? '<div class="form-group full"><label class="form-label"><input type="checkbox" id="ipMales"' + (i.males !== false ? ' checked' : '') + '> ' + tt('כולל זכרים', 'รวมตัวผู้', 'مع الذكور') + ' (' + (p.male_trees || 0) + ')</label></div>' : '') : '') +
          (mode === 'line' ? f('ipLph', tt('ספיקת טפטפת (ל׳/ש)', 'ลิตร/ชม.', 'لتر/س'), i.lph || DEFAULT_LPH, 'number') + f('ipSp', tt('מרווח טפטפות (ס״מ)', 'ระยะ ซม.', 'المسافة سم'), i.spacing_cm, 'number') +
            f('ipLat', tt('שלוחות לשורה', 'สายต่อแถว', 'خطوط لكل صف'), i.laterals || 1, 'number') + f('ipRow', tt('רוחב שורה (מ׳)', 'ระยะแถว ม.', 'عرض الصف م'), i.row_m || p.row_spacing || '', 'number') : '') +
          (mode === 'dunam' ? f('ipPd', tt('מק״ש לדונם', 'ลบ.ม./ชม./ไร่', 'م³/س لكل دونم'), i.per_dunam, 'number', 'full') : '') +
          f('ipAct', tt('ספיקה בפועל (מק״ש, נמדד)', 'อัตราจริง', 'التدفق الفعلي'), i.actual, 'number') +
          f('ipNotes', tt('הערות', 'หมายเหตุ', 'ملاحظات'), i.notes, 'text') +
        '</div>' +
        '<div class="ir-sum" id="ipCalc"></div>' +
        '<div class="modal-buttons"><button class="btn btn-primary" id="ipSave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
        '<button class="btn btn-secondary" id="ipBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>');
      document.getElementById('ipMode').addEventListener('change', function () { read(); i.mode = this.value; draw(); });
      document.querySelector('.modal').addEventListener('input', function () { read(); calc(); });
      document.querySelector('.modal').addEventListener('change', function () { read(); calc(); });
      document.getElementById('ipBack').addEventListener('click', function () { done ? done() : back(farmId); });
      document.getElementById('ipSave').addEventListener('click', function () {
        read();
        var r = S().updatePlot(plotId, { irr: i });
        if (!r || !r.ok) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
        toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'حُفظ'));
        done ? done() : back(farmId);
      });
      calc();
    }
    function v(id) { var el = document.getElementById(id); return el ? el.value : undefined; }
    function read() {
      var h = v('ipHead'); i.head = h ? Number(h) : null;
      i.line = (v('ipLine') || '').trim(); i.valves = (v('ipValves') || '').trim();
      i.mode = v('ipMode') || i.mode;
      if (v('ipDpt') !== undefined) i.dpt = Number(v('ipDpt')) || 0;
      if (v('ipLph') !== undefined) i.lph = Number(v('ipLph')) || DEFAULT_LPH;
      if (v('ipSp') !== undefined) i.spacing_cm = Number(v('ipSp')) || 0;
      if (v('ipLat') !== undefined) i.laterals = Number(v('ipLat')) || 1;
      if (v('ipRow') !== undefined) i.row_m = Number(v('ipRow')) || 0;
      if (v('ipPd') !== undefined) i.per_dunam = Number(v('ipPd')) || 0;
      var m = document.getElementById('ipMales'); if (m) i.males = m.checked;
      i.actual = Number(v('ipAct')) || 0; i.notes = (v('ipNotes') || '').trim();
    }
    function calc() {
      var el = document.getElementById('ipCalc'); if (!el) return;
      var q = JSON.parse(JSON.stringify(p)); q.irr = i;
      var nom = nominal(q), dev = deviation(q);
      el.innerHTML = nom ? tt('ספיקה נומינלית', 'อัตราไหล', 'التدفق الاسمي') + ': <b>' + n1(nom) + '</b> ' + tt('מק״ש', 'ลบ.ม./ชม.', 'م³/س') +
        (p.area ? ' · ' + (Math.round(nom / p.area * 100) / 100) + ' ' + tt('לדונם', 'ต่อไร่', 'لكل دونم') : '') +
        (dev != null ? ' · <span class="' + (Math.abs(dev) > DEV_PCT ? 'ir-bad' : 'ir-ok') + '">' + tt('סטייה', 'ส่วนต่าง', 'الانحراف') + ' ' + (dev > 0 ? '+' : '') + Math.round(dev) + '%</span>' : '')
        : tt('מלא את נתוני האביזר כדי לחשב ספיקה', 'กรอกข้อมูลเพื่อคำนวณ', 'أكمل البيانات للحساب');
    }
    draw();
  }

  // Short block for the plot card's irrigation panel.
  function plotHtml(plotId, farmId) {
    if (!S().getFarmPlots) return '';
    ensureCss();
    var p = S().getFarmPlots(farmId).find(function (x) { return x.id === plotId; });
    if (!p) return '';
    var can = S().canEditFarm(farmId), heads = S().getIrrHeads(farmId);
    var h = p.irr && heads.find(function (x) { return x.id === p.irr.head; });
    var nom = nominal(p), dev = deviation(p);
    return '<div class="ir-sum">' + (p.irr ?
      (h ? '🚰 ' + esc(h.name) + ' · ' : '') + (p.irr.line ? tt('קו', 'สาย', 'خط') + ' ' + esc(p.irr.line) + ' · ' : '') +
      (p.irr.valves ? tt('מגופים', 'วาล์ว', 'صمامات') + ' ' + esc(p.irr.valves) + ' · ' : '') + esc(emitterText(p)) +
      (nom ? '<br>' + tt('ספיקה נומינלית', 'อัตราไหล', 'التدفق الاسمي') + ' <b>' + n1(nom) + '</b> ' + tt('מק״ש', 'ลบ.ม./ชม.', 'م³/س') : '') +
      (p.irr.actual ? ' · ' + tt('בפועל', 'จริง', 'فعلي') + ' ' + n1(p.irr.actual) : '') +
      (dev != null ? ' <span class="' + (Math.abs(dev) > DEV_PCT ? 'ir-bad' : 'ir-ok') + '">(' + (dev > 0 ? '+' : '') + Math.round(dev) + '%)</span>' : '')
      : tt('מערכת ההשקיה של החלקה לא הוגדרה.', 'ยังไม่ได้กำหนดระบบน้ำ', 'لم يُحدد نظام الري')) +
      (can ? '<div style="margin-top:6px;"><button type="button" class="ir-e" id="irPlotEdit" data-plot="' + plotId + '" data-farm="' + farmId + '">✏️ ' +
        tt('הגדרת מערכת השקיה', 'ตั้งค่าระบบน้ำ', 'إعداد نظام الري') + '</button></div>' : '') + '</div>';
  }
  // Delegated: the plot card re-renders often.
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest && e.target.closest('#irPlotEdit');
    if (!b) return;
    var pid = Number(b.getAttribute('data-plot')), fid = Number(b.getAttribute('data-farm'));
    editPlot(pid, fid, function () { if (typeof window.showPlotDetails === 'function') window.showPlotDetails(pid); else back(fid); });
  });

  return { sectionHtml: sectionHtml, bind: bind, open: open, plotHtml: plotHtml, nominal: nominal, editPlot: editPlot };
})();
window.IrrigSys = IrrigSys;
