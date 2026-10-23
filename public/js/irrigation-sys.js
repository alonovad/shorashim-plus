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

  var FILTERS = [['manual', 'ידני', 'มือ', 'يدوي'], ['auto', 'אוטומטי', 'อัตโนมัติ', 'تلقائي'], ['auto-field', 'אוטומטי במגופי שטח', 'อัตโนมัติที่วาล์วแปลง', 'تلقائي في صمامات الحقل'], ['none', 'ללא', 'ไม่มี', 'بدون']];
  var WATER = [['wells', 'בארות', 'บ่อบาดาล', 'آبار'], ['reclaimed', 'קולחין', 'น้ำบำบัด', 'مياه معالجة'], ['mekorot', 'מקורות', 'เมโกโรต', 'مكوروت'], ['mixed', 'מעורב', 'ผสม', 'مختلط'], ['other', 'אחר', 'อื่นๆ', 'أخرى']];
  // Label of a [key, he, th, ar] option in the current language.
  function L(o) { return tt(o[1], o[2], o[3]); }
  // Per plot (v151+): irrigation computer, water type, emitter kind, and a
  // flow line per valve (planned vs measured, m³/h).
  var CTRLS = [['', 'ללא מחשב', 'ไม่มีคอมพิวเตอร์', 'بدون حاسوب'], ['galcon', 'גלקון', 'Galcon', 'جالكون'], ['netafim', 'נטפים (NMC / NetBeat)', 'Netafim (NMC / NetBeat)', 'نطافيم (NMC / NetBeat)'],
    ['talgil', 'טלגיל (Dream)', 'Talgil (Dream)', 'تلجيل (Dream)'], ['motorola', 'מוטורולה (IRRInet)', 'Motorola (IRRInet)', 'موتورولا (IRRInet)'],   // DATA KEY (brand / Latin labels)
    ['eldar', 'אלדר-שני', 'Eldar-Shany', 'إلدار-شاني'], ['bermad', 'ברמד', 'Bermad', 'برماد'], ['other', 'אחר', 'อื่นๆ', 'أخرى']];   // DATA KEY (brand / Latin labels)
  var EMITS = [['drip', 'טפטפות', 'หัวน้ำหยด', 'نقاطات'], ['sprinkler', 'מתזים', 'หัวพ่น', 'رشاشات'], ['minisprinkler', 'מיני-ממטירים', 'มินิสปริงเกอร์', 'مرشات صغيرة'],
    ['sprinkler_big', 'ממטירים', 'สปริงเกอร์', 'مرشات'], ['other', 'אחר', 'อื่นๆ', 'أخرى']];
  function emitWord(i) { return (i && i.emit === 'sprinkler') ? tt('מתזים', 'หัวพ่น', 'رشاشات') : (i && (i.emit === 'minisprinkler' || i.emit === 'sprinkler_big')) ? tt('ממטירים', 'สปริงเกอร์', 'مرشات') : tt('טפטפות', 'หัวน้ำหยด', 'نقاط'); }
  function vflowSum(i, k) { return ((i && i.vflow) || []).reduce(function (a, r) { return a + (Number(r[k]) || 0); }, 0); }
  function lbl(list, v) { var x = list.find(function (o) { return o[0] === v; }); return x ? L(x) : (v || ''); }
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
      '.ir-vt{margin-top:10px;border:1px solid var(--line,#e6ebe2);border-radius:14px;padding:10px;}' +
      '.ir-vh{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;}' +
      '.ir-vr{display:grid;grid-template-columns:1fr 1fr 1fr 1.4fr 30px;gap:5px;margin-top:5px;align-items:center;}.ir-vr .form-input{padding:7px 8px;margin:0;}' +
      '.ir-vlab{font-size:.68rem;color:var(--text-muted,#777);margin-top:0;}' +
      '.ir-vx{border:0;background:var(--tonal,#f1f4ee);border-radius:8px;height:30px;cursor:pointer;}' +
      '.ir-vempty{font-size:.75rem;color:var(--text-muted,#777);padding:4px 2px;}' +
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
      [tt('חלקה', 'แปลง', 'القطعة'), tt('קו', 'สาย', 'الخط'), tt('מגופים', 'วาล์ว', 'الصمامات'), tt('גידול / זן', 'พืช / พันธุ์', 'المحصول / الصنف'), tt('עצים', 'ต้น', 'أشجار'),
       tt('דונם', 'ไร่', 'دونم'), tt('נטיעה', 'ปลูก', 'الزراعة'), tt('אביזר השקיה', 'หัวน้ำ', 'أداة الري'), tt('ספיקה נומינלית (מק״ש)', 'อัตราไหลตามสเปก (ลบ.ม./ชม.)', 'التدفق الاسمي (م³/س)'),
       tt('לדונם', 'ต่อไร่', 'لكل دونم'), tt('ספיקה בפועל', 'อัตราไหลจริง', 'التدفق الفعلي'), tt('סטייה', 'ส่วนต่าง', 'الانحراف')].map(function (h) { return '<th>' + h + '</th>'; }).join('') +
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

  function opts(list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(L(o)) + '</option>'; }).join(''); }

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
    ensureCss();
    var p = S().getFarmPlots(farmId).find(function (x) { return x.id === plotId; });
    if (!p) return;
    var heads = S().getIrrHeads(farmId);
    var i = p.irr || { mode: isDate(p) ? 'tree' : 'line', lph: DEFAULT_LPH, males: true };
    function f(id, label, val, type, cls, extra) {
      return '<div class="form-group' + (cls ? ' ' + cls : '') + '"><label class="form-label">' + label + '</label><input class="form-input" id="' + id + '" type="' + (type || 'text') + '" step="any" value="' + esc(val == null ? '' : val) + '"' + (extra || '') + '></div>';
    }
    function sel(id, label, list, val) {
      return '<div class="form-group"><label class="form-label">' + label + '</label><select class="form-input" id="' + id + '">' +
        list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === val ? ' selected' : '') + '>' + (o.length > 3 ? L(o) : o[1]) + '</option>'; }).join('') + '</select></div>';
    }
    // Older plots kept valves as a comma list; it seeds the per-valve table.
    if (!i.vflow && i.valves) i.vflow = String(i.valves).split(/[,،;]+/).map(function (x) { return x.trim(); }).filter(Boolean).map(function (n) { return { n: n, q: 0, a: 0, t: '' }; });
    function draw() {
      var mode = i.mode || 'tree';
      modal('<h2>🚿 ' + esc(p.name) + '</h2>' +
        '<div class="ir-grid">' +
          '<div class="form-group"><label class="form-label">' + tt('ראש מערכת', 'หัวระบบ', 'رأس الري') + '</label><select class="form-input" id="ipHead"><option value="">—</option>' +
            heads.map(function (h) { return '<option value="' + h.id + '"' + (h.id === i.head ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') + '</select></div>' +
          f('ipLine', tt('קו', 'สาย', 'الخط'), i.line) +
          sel('ipCtrl', tt('מחשב השקיה', 'คอมพิวเตอร์ให้น้ำ', 'حاسوب الري'), CTRLS, i.ctrl || '') +
          f('ipCtrlNote', tt('דגם / מס׳ תחנה במחשב', 'รุ่น / สถานี', 'الطراز / المحطة'), i.ctrl_note) +
          sel('ipWater', tt('סוג המים', 'ชนิดน้ำ', 'نوع المياه'), [['', tt('לפי ראש המערכת', 'ตามหัวระบบ', 'حسب رأس الري')]].concat(WATER), i.water || '') +
          sel('ipEmit', tt('מתזים או טפטפות', 'หัวพ่นหรือหัวน้ำหยด', 'رشاشات أو نقاط'), EMITS, i.emit || 'drip') +
          '<div class="form-group full"><label class="form-label">' + tt('אופן חישוב הספיקה', 'วิธีคำนวณ', 'طريقة الحساب') + '</label><select class="form-input" id="ipMode">' +
            [['tree', emitWord(i) + ' ' + tt('לעץ', 'ต่อต้น', 'لكل شجرة')], ['line', tt('שלוחה (ל׳/ש כל X ס״מ)', 'สายน้ำหยด', 'خط تنقيط')], ['dunam', tt('ספיקה לדונם', 'อัตราต่อไร่', 'تدفق لكل دونم')]]
              .map(function (o) { return '<option value="' + o[0] + '"' + (mode === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></div>' +
          (mode === 'tree' ? f('ipDpt', emitWord(i) + ' ' + tt('לעץ', 'ต่อต้น', 'لكل شجرة'), i.dpt, 'number') + f('ipLph', tt('ספיקה לאביזר (ל׳/ש)', 'ลิตร/ชม.', 'لتر/س'), i.lph || DEFAULT_LPH, 'number') +
            (isDate(p) ? '<div class="form-group full"><label class="form-label"><input type="checkbox" id="ipMales"' + (i.males !== false ? ' checked' : '') + '> ' + tt('כולל זכרים', 'รวมตัวผู้', 'مع الذكور') + ' (' + (p.male_trees || 0) + ')</label></div>' : '') : '') +
          (mode === 'line' ? f('ipLph', tt('ספיקה לאביזר (ל׳/ש)', 'ลิตร/ชม.', 'لتر/س'), i.lph || DEFAULT_LPH, 'number') + f('ipSp', tt('מרווח בין אביזרים (ס״מ)', 'ระยะ ซม.', 'المسافة سم'), i.spacing_cm, 'number') +
            f('ipLat', tt('שלוחות לשורה', 'สายต่อแถว', 'خطوط لكل صف'), i.laterals || 1, 'number') + f('ipRow', tt('רוחב שורה (מ׳)', 'ระยะแถว ม.', 'عرض الصف م'), i.row_m || p.row_spacing || '', 'number') : '') +
          (mode === 'dunam' ? f('ipPd', tt('מק״ש לדונם', 'ลบ.ม./ชม./ไร่', 'م³/س لكل دونم'), i.per_dunam, 'number', 'full') : '') +
          f('ipAct', tt('ספיקה בפועל לכל החלקה (מק״ש, נמדד)', 'อัตราจริง', 'التدفق الفعلي'), i.actual, 'number') +
          f('ipNotes', tt('הערות', 'หมายเหตุ', 'ملاحظات'), i.notes, 'text') +
        '</div>' +
        '<div class="ir-vt"><div class="ir-vh"><b>🔧 ' + tt('מגופים וספיקות', 'วาล์วและอัตราไหล', 'الصمامات والتدفق') + '</b>' +
          '<button type="button" class="ir-e" id="ipVAdd">＋ ' + tt('מגוף', 'วาล์ว', 'صمام') + '</button></div>' +
          '<div class="ir-vr ir-vlab"><span>' + tt('מגוף', 'วาล์ว', 'صمام') + '</span><span>' + tt('מתוכנן מק״ש', 'ตามแผน', 'مخطط') + '</span><span>' + tt('נמדד מק״ש', 'วัดได้', 'مقاس') + '</span><span>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</span><span></span></div>' +
          (i.vflow || []).map(function (r, k) {
            return '<div class="ir-vr" data-vk="' + k + '"><input class="form-input" data-vf="n" value="' + esc(r.n || '') + '" placeholder="1.1">' +
              '<input class="form-input" data-vf="q" type="number" step="any" value="' + esc(r.q || '') + '">' +
              '<input class="form-input" data-vf="a" type="number" step="any" value="' + esc(r.a || '') + '">' +
              '<input class="form-input" data-vf="t" value="' + esc(r.t || '') + '">' +
              '<button type="button" class="ir-vx" data-vdel="' + k + '">×</button></div>';
          }).join('') +
          ((i.vflow || []).length ? '' : '<div class="ir-vempty">' + tt('הוסף מגוף לכל יחידת השקיה בחלקה כדי לרשום ספיקה מתוכננת ונמדדת.', 'เพิ่มวาล์ว', 'أضف صماماً') + '</div>') +
        '</div>' +
        '<div class="ir-sum" id="ipCalc"></div>' +
        '<div class="modal-buttons"><button class="btn btn-primary" id="ipSave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
        '<button class="btn btn-secondary" id="ipBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>');
      document.getElementById('ipMode').addEventListener('change', function () { read(); i.mode = this.value; draw(); });
      document.getElementById('ipEmit').addEventListener('change', function () { read(); draw(); });
      document.getElementById('ipVAdd').addEventListener('click', function () { read(); (i.vflow = i.vflow || []).push({ n: '', q: 0, a: 0, t: '' }); draw(); });
      document.querySelectorAll('[data-vdel]').forEach(function (b) { b.addEventListener('click', function () { read(); i.vflow.splice(Number(b.getAttribute('data-vdel')), 1); draw(); }); });
      document.querySelector('.modal').addEventListener('input', function () { read(); calc(); });
      document.querySelector('.modal').addEventListener('change', function () { read(); calc(); });
      document.getElementById('ipBack').addEventListener('click', function () { done ? done() : back(farmId); });
      document.getElementById('ipSave').addEventListener('click', function () {
        read();
        i.vflow = (i.vflow || []).filter(function (r) { return r.n || r.q || r.a || r.t; });
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
      i.line = (v('ipLine') || '').trim();
      i.ctrl = v('ipCtrl') || ''; i.ctrl_note = (v('ipCtrlNote') || '').trim();
      i.water = v('ipWater') || ''; i.emit = v('ipEmit') || 'drip';
      i.vflow = Array.prototype.slice.call(document.querySelectorAll('.ir-vr[data-vk]')).map(function (row) {
        var g = function (k) { var el = row.querySelector('[data-vf="' + k + '"]'); return el ? el.value : ''; };
        return { n: g('n').trim(), q: Number(g('q')) || 0, a: Number(g('a')) || 0, t: g('t').trim() };
      });
      i.valves = i.vflow.map(function (r) { return r.n; }).filter(Boolean).join(', ');
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
      var vq = vflowSum(i, 'q'), va = vflowSum(i, 'a');
      if (vq || va) el.innerHTML += '<br>' + tt('סה״כ מגופים', 'รวมวาล์ว', 'مجموع الصمامات') + ': ' + (vq ? tt('מתוכנן', 'ตามแผน', 'مخطط') + ' <b>' + n1(vq) + '</b>' : '') +
        (va ? ' · ' + tt('נמדד', 'วัดได้', 'مقاس') + ' <b>' + n1(va) + '</b>' + (vq ? ' <span class="' + (Math.abs(va / vq - 1) * 100 > DEV_PCT ? 'ir-bad' : 'ir-ok') + '">(' + (va >= vq ? '+' : '') + Math.round((va / vq - 1) * 100) + '%)</span>' : '') : '') + ' ' + tt('מק״ש', 'ลบ.ม./ชม.', 'م³/س');
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
      '<br>' + [p.irr.emit ? lbl(EMITS, p.irr.emit) : '', p.irr.water ? '💧 ' + lbl(WATER, p.irr.water) : '',
        p.irr.ctrl ? '🖥 ' + lbl(CTRLS, p.irr.ctrl) + (p.irr.ctrl_note ? ' (' + esc(p.irr.ctrl_note) + ')' : '') : ''].filter(Boolean).join(' · ') +
      ((p.irr.vflow || []).length ? '<br>' + p.irr.vflow.map(function (r) {
        return esc(r.n || '?') + ': ' + (r.q ? n1(r.q) : '—') + (r.a ? ' / ' + n1(r.a) : ''); }).join(' · ') + ' ' + tt('מק״ש (מתוכנן / נמדד)', 'ลบ.ม./ชม.', 'م³/س') : '') +
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
