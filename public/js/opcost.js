/* opcost.js — operation costing and targets from the work log (Oct 2026)
 *
 * The cost workbook's model, applied to the app's own work log:
 *   cost of an entry   = workers × daily hours × the worker group's hourly
 *                        rate (לאום העובדים: תאילנדים 45.5, פלסטינאים 38.5…)
 *   budget of an entry = output × the budget line's price per unit
 *                        (סעיף תקציבי → תקציב עץ: קיוץ 10.5 ₪ לעץ …)
 *   target             = the line's required output per worker-hour
 *                        (הספק שעתי נדרש: קיוץ 4.3 עצים/שעה …)
 * so for any month, farm, budget line and worker group the report shows the
 * labour hours, the cost against the budget, the actual output per hour
 * against the target, and the actual cost per tree. Output is trees by
 * default; a line can instead be priced per dunam (the plot's area), per
 * unit of quantity (crates, kg…) or per worker-hour.
 *
 * DATA  appData/shorashim-prices-ops (admin writes, operator+ reads):
 *   { rateDefault, dayHours, groups: {name: ₪/h},
 *     sections: {name: { unit, budget, target }}, farmBudget: {fid: {name: ₪}} }
 * Work-log entries come from SprayStore.getWorklog() — the farms the viewer
 * may see.
 */
var OpCost = (function () {
  'use strict';

  var KEY = 'shorashim-prices-ops';
  var cfg = null;
  var ui = { y: new Date().getFullYear(), m: new Date().getMonth(), farm: 0, by: 'farm', tab: 'report' };

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
  function role() { return (window.currentUser || {}).role; }
  function isAdmin() { return role() === 'admin'; }
  function isMgr() { return role() === 'admin' || role() === 'operator'; }
  function money(n) { return '₪' + Math.round(Number(n) || 0).toLocaleString('he-IL'); }
  function money2(n) { return '₪' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function r1(n) { return (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('he-IL'); }

  // Seeded from the 2026 cost workbook (hourly rate per worker group; date
  // budget lines with price per tree and required hourly output).
  function defaults() {
    var g = {};
    ['תאילנדים שורשים', 'מלאווים', 'אגוזי', 'דיירי', 'הלאלי', 'רוחקין', 'בראשית', 'סנסן ודקל', 'אדיר שלמה', 'יובל בן עמי', 'נערן', 'זיו ליבה',
     'ארנון צור', 'תאילנדים ייטב', 'נפאלים', 'אלון עובדיה', 'קבלנות פרדסים', 'פרדס איימן', 'מתנדבים', 'סרילנקה', 'תאילנדים גלגל', 'עובדי גד"ש מפנמה']
      .forEach(function (n) { g[n] = 45.5; });
    g['שומר חדש'] = 44; g['פלסטינאים'] = 38.5; g['ישראלים'] = 46;
    function sec(budget, target) { return { unit: 'tree', budget: budget, target: target }; }
    return {
      rateDefault: 45.5, dayHours: 8, groups: g, farmBudget: {},
      sections: {
        'קיוץ': sec(10.5, 4.3), 'הפרייה': sec(4.1, 11.0), 'דילול': sec(60.5, 0.8), 'קשירה': sec(22.8, 2.0), 'שקים': sec(22.8, 2.0),
        'גדיד': sec(60.5, 0.8), 'הורדת רשת/שקים': sec(15.5, 2.9), 'גיזום': sec(6.7, 6.8), 'טיפול קרקע ואחזקה': sec(41.4, 1.1),
        'קשירה ושקים': sec(45.5, 1.0), 'לולבים': sec(2.1, 22.0), 'מיון ראשוני': sec(3.3, 0)
      }
    };
  }
  function norm(c) {
    var d = defaults();
    c = (c && typeof c === 'object') ? c : {};
    return {
      rateDefault: Number(c.rateDefault) || d.rateDefault, dayHours: Number(c.dayHours) || d.dayHours,
      groups: c.groups || d.groups, sections: c.sections || d.sections, farmBudget: c.farmBudget || {}
    };
  }
  function load() {
    if (typeof DB === 'undefined') { cfg = norm(null); return Promise.resolve(cfg); }
    return DB.read(KEY).then(function (res) { cfg = norm(res.data); cfg._ok = res.ok; return cfg; });
  }
  function save() {
    if (!isAdmin()) return false;
    var out = JSON.parse(JSON.stringify(cfg)); delete out._ok;
    DB.save(KEY, out);
    return true;
  }

  // ── computation ──
  function inMonth(d) { var x = String(d || ''); return x.slice(0, 4) === String(ui.y) && Number(x.slice(5, 7)) === ui.m + 1; }
  function compute() {
    var log = S().getWorklog ? S().getWorklog() : [];
    var rows = {}, order = [];
    var farmNames = {};
    (S().getFarms ? S().getFarms() : []).forEach(function (f) { farmNames[f.id] = f.name; });
    log.forEach(function (e) {
      if (!inMonth(e.date)) return;
      if (ui.farm && e.farm_id !== ui.farm) return;
      var section = e.budget_category || e.type || '—';
      var sc = cfg.sections[section] || null;
      var rate = cfg.groups[e.worker_group] != null ? Number(cfg.groups[e.worker_group]) : cfg.rateDefault;
      var workers = Number(e.worker_count) || 1;
      var hoursMissing = !(Number(e.hours) > 0);
      var hours = hoursMissing ? cfg.dayHours : Number(e.hours);
      var labourH = workers * hours, cost = labourH * rate;
      var unit = sc ? sc.unit : 'tree';
      var out = unit === 'tree' ? (Number(e.trees_completed) || 0) : unit === 'qty' ? (Number(e.quantity) || 0)
        : unit === 'dunam' ? (e.plot_id && S().plotArea ? S().plotArea(e.plot_id) : 0) : labourH;
      var fb = (cfg.farmBudget[e.farm_id] || {})[section];
      var budgetUnit = fb != null ? Number(fb) : (sc ? Number(sc.budget) || 0 : 0);
      var k = ui.by === 'farm' ? e.farm_id + '|' + section : ui.by === 'group' ? (e.worker_group || '—') + '|' + section : section;
      var r = rows[k];
      if (!r) {
        r = rows[k] = { farm: ui.by === 'farm' ? (farmNames[e.farm_id] || e.farm_name || '') : '', group: ui.by === 'group' ? (e.worker_group || '—') : '',
          section: section, unit: unit, target: sc ? Number(sc.target) || 0 : 0, budgetUnit: budgetUnit, priced: !!sc,
          n: 0, labourH: 0, cost: 0, out: 0, budget: 0, missingH: 0, missingOut: 0, budgetUnits: {} };
        order.push(k);
      }
      r.n++; r.labourH += labourH; r.cost += cost; r.out += out; r.budget += out * budgetUnit;
      if (hoursMissing) r.missingH++;
      if (unit !== 'hour' && !out) r.missingOut++;
    });
    return order.map(function (k) { return rows[k]; }).sort(function (a, b) {
      return String(a.farm + a.group).localeCompare(String(b.farm + b.group), 'he') || String(a.section).localeCompare(String(b.section), 'he');
    });
  }

  var UNIT_LBL = { tree: 'עצים', dunam: 'דונם', qty: 'כמות', hour: 'שעות' };
  var MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

  function ensureCss() {
    if (document.getElementById('ocCss')) return;
    var st = document.createElement('style');
    st.id = 'ocCss';
    st.textContent =
      '.oc-wrap{overflow:auto;border:1px solid var(--line,#dbe3d8);border-radius:12px;margin:6px 0;}' +
      '.oc-tbl{width:100%;border-collapse:collapse;font-size:.78rem;min-width:860px;}' +
      '.oc-tbl th{background:var(--g6,#eef2ee);font-weight:600;font-size:.7rem;color:var(--text-muted,#555);text-align:right;padding:6px;white-space:nowrap;}' +
      '.oc-tbl td{padding:6px;border-top:1px solid var(--line,#e5e9e4);white-space:nowrap;}' +
      '.oc-tbl td.num{font-variant-numeric:tabular-nums;}' +
      '.oc-tbl tr.tot td{font-weight:700;background:var(--primary-soft,#e2efe7);}' +
      '.oc-good{color:var(--primary,#2d6a4f);font-weight:700;}.oc-warn{color:#9a5b00;font-weight:700;}.oc-bad{color:#b3261e;font-weight:700;}' +
      '.oc-muted{color:var(--text-muted,#888);font-size:.7rem;}' +
      '.oc-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0;}' +
      '.oc-bar .form-input{margin:0;width:auto;padding:7px 9px;font-size:.82rem;}' +
      '.oc-btn{border:0;border-radius:99px;padding:8px 14px;background:var(--primary,#2d6a4f);color:#fff;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.oc-btn.ghost{background:transparent;color:var(--primary,#2d6a4f);border:1px solid var(--line,#dbe3d8);}' +
      '.oc-tab{border:0;border-radius:99px;padding:7px 14px;background:var(--g6,#eef2ee);font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.oc-tab.on{background:var(--primary,#2d6a4f);color:#fff;}' +
      '.oc-set .oc-row{display:flex;gap:6px;align-items:center;margin-bottom:5px;flex-wrap:wrap;}' +
      '.oc-set .form-input{margin:0;padding:6px 8px;font-size:.8rem;}' +
      '.oc-sec{font-weight:700;margin:12px 0 6px;font-size:.86rem;}';
    document.head.appendChild(st);
  }

  function pctCls(p) { return p >= 100 ? 'oc-good' : p >= 90 ? 'oc-warn' : 'oc-bad'; }

  function reportTable(rows, forPrint) {
    if (!rows.length) return '<div class="oc-muted" style="padding:16px;text-align:center;">' + tt('אין רישומי יומן עבודה בחודש הזה.', 'ไม่มีบันทึกงานเดือนนี้', 'لا سجلات عمل هذا الشهر') + '</div>';
    var tot = { labourH: 0, cost: 0, budget: 0, n: 0 };
    var body = rows.map(function (r) {
      tot.labourH += r.labourH; tot.cost += r.cost; tot.budget += r.budget; tot.n += r.n;
      var hourly = r.labourH ? r.out / r.labourH : 0;
      var pct = r.target && r.unit !== 'hour' && r.out ? hourly / r.target * 100 : null;
      var perUnit = r.out && r.unit !== 'hour' ? r.cost / r.out : null;
      var diff = r.priced && r.budget ? r.budget - r.cost : null;
      return '<tr>' + (ui.by === 'farm' ? '<td>' + esc(r.farm) + '</td>' : '') + (ui.by === 'group' ? '<td>' + esc(r.group) + '</td>' : '') +
        '<td><b>' + esc(r.section) + '</b>' + (r.priced ? '' : ' <span class="oc-muted">(' + tt('לא מתומחר', 'ไม่มีราคา', 'غير مسعّر') + ')</span>') + '</td>' +
        '<td class="num">' + r.n + '</td><td class="num">' + r1(r.labourH) + (r.missingH ? ' <span class="oc-muted" title="' + esc(tt('רישומים ללא שעות — חושבו לפי יום עבודה מלא', 'ไม่มีชั่วโมง', 'بلا ساعات')) + '">*' + r.missingH + '</span>' : '') + '</td>' +
        '<td class="num">' + (r.unit === 'hour' ? '—' : r1(r.out) + ' <span class="oc-muted">' + tt(UNIT_LBL[r.unit]) + '</span>') + (r.missingOut ? ' <span class="oc-muted" title="' + esc(tt('רישומים ללא כמות', 'ไม่มีจำนวน', 'بلا كمية')) + '">∅' + r.missingOut + '</span>' : '') + '</td>' +
        '<td class="num">' + (r.target ? r1(r.target) : '—') + '</td>' +
        '<td class="num">' + (r.unit === 'hour' || !r.out ? '—' : r1(hourly)) + '</td>' +
        '<td class="num ' + (pct == null ? '' : pctCls(pct)) + '">' + (pct == null ? '—' : Math.round(pct) + '%') + '</td>' +
        '<td class="num">' + (r.budgetUnit ? money2(r.budgetUnit) : '—') + '</td>' +
        '<td class="num ' + (perUnit != null && r.budgetUnit ? (perUnit <= r.budgetUnit ? 'oc-good' : 'oc-bad') : '') + '">' + (perUnit != null ? money2(perUnit) : '—') + '</td>' +
        '<td class="num">' + money(r.cost) + '</td><td class="num">' + (r.priced && r.budget ? money(r.budget) : '—') + '</td>' +
        '<td class="num ' + (diff == null ? '' : diff >= 0 ? 'oc-good' : 'oc-bad') + '">' + (diff == null ? '—' : (diff >= 0 ? '+' : '−') + money(Math.abs(diff)).replace('₪', '₪')) + '</td></tr>';
    }).join('');
    var span = 2 + (ui.by !== 'section' ? 1 : 0);
    var totDiff = tot.budget ? tot.budget - tot.cost : null;
    body += '<tr class="tot"><td colspan="' + (span - 1) + '">' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td class="num">' + tot.n + '</td><td class="num">' + r1(tot.labourH) + '</td>' +
      '<td colspan="6"></td><td class="num">' + money(tot.cost) + '</td><td class="num">' + (tot.budget ? money(tot.budget) : '—') + '</td>' +
      '<td class="num ' + (totDiff == null ? '' : totDiff >= 0 ? 'oc-good' : 'oc-bad') + '">' + (totDiff == null ? '—' : (totDiff >= 0 ? '+' : '−') + money(Math.abs(totDiff))) + '</td></tr>';
    var head = (ui.by === 'farm' ? '<th>' + tt('משק', 'ฟาร์ม', 'المزرعة') + '</th>' : '') + (ui.by === 'group' ? '<th>' + tt('קבוצת עובדים / ספק', 'กลุ่มคนงาน', 'مجموعة العمال') + '</th>' : '') +
      ['סעיף תקציבי', 'רישומים', 'שעות עבודה', 'תפוקה', 'הספק שעתי נדרש', 'הספק שעתי בפועל', 'עמידה ביעד', 'תמחיר ליחידה', 'עלות בפועל ליחידה', 'עלות', 'תקציב', 'פער'].map(function (h) { return '<th>' + h + '</th>'; }).join('');
    return '<div class="oc-wrap"><table class="oc-tbl"><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
  }

  function modal(inner) {
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay"><div class="modal" style="max-width:1200px;">' + inner + '</div></div>';
  }

  function open(farmId) {
    if (!isMgr()) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    ensureCss();
    if (farmId) ui.farm = farmId;
    load().then(paint);
  }

  function paint() {
    var farms = S().getFarms ? S().getFarms() : [];
    var title = tt('תמחיר ועמידה ביעדים', 'ต้นทุนและเป้าหมาย', 'التكلفة والأهداف');
    var tabs = '<div class="oc-bar"><button class="oc-tab' + (ui.tab === 'report' ? ' on' : '') + '" data-oc-tab="report">📊 ' + tt('דוח חודשי', 'รายงาน', 'التقرير') + '</button>' +
      '<button class="oc-tab' + (ui.tab === 'settings' ? ' on' : '') + '" data-oc-tab="settings">⚙️ ' + tt('תמחיר והספקים', 'ราคาและเป้า', 'الأسعار والأهداف') + '</button></div>';
    var body;
    if (ui.tab === 'settings') body = settingsHtml();
    else {
      var rows = compute();
      body = '<div class="oc-bar">' +
          '<button class="oc-btn ghost" id="ocPrev">→</button><b>' + MONTHS[ui.m] + ' ' + ui.y + '</b><button class="oc-btn ghost" id="ocNext">←</button>' +
          '<select class="form-input" id="ocFarm"><option value="0">' + tt('כל המשקים', 'ทุกฟาร์ม', 'كل المزارع') + '</option>' +
            farms.map(function (f) { return '<option value="' + f.id + '"' + (f.id === ui.farm ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select>' +
          '<select class="form-input" id="ocBy">' + [['farm', tt('לפי משק וסעיף', 'ตามฟาร์ม', 'حسب المزرعة')], ['section', tt('לפי סעיף', 'ตามหมวด', 'حسب البند')], ['group', tt('לפי קבוצת עובדים / ספק', 'ตามกลุ่ม', 'حسب المجموعة')]]
            .map(function (o) { return '<option value="' + o[0] + '"' + (ui.by === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
          '<button class="oc-btn ghost" id="ocPrint">🖨️ ' + tt('הדפס / PDF', 'พิมพ์', 'طباعة') + '</button>' +
        '</div>' + reportTable(rows) +
        '<p class="oc-muted">' + tt('עלות = עובדים × שעות × מחיר השעה של קבוצת העובדים. תקציב = תפוקה × תמחיר הסעיף. עמידה ביעד = הספק שעתי בפועל מול הנדרש. * רישומים ללא שעות חושבו לפי ', 'คำนวณจากบันทึกงาน', 'محسوب من سجل العمل') +
          cfg.dayHours + ' ' + tt('שעות; ∅ רישומים ללא כמות.', 'ชม.', 'ساعات') + '</p>';
    }
    modal('<h2>💹 ' + title + '</h2>' + tabs + body +
      '<div class="modal-buttons"><button class="btn btn-secondary" id="ocClose">' + tt('סגור', 'ปิด', 'إغلاق') + '</button></div>');
    document.getElementById('ocClose').addEventListener('click', function () { document.getElementById('modalContainer').innerHTML = ''; });
    document.querySelectorAll('[data-oc-tab]').forEach(function (b) { b.addEventListener('click', function () { ui.tab = b.getAttribute('data-oc-tab'); paint(); }); });
    if (ui.tab === 'settings') { bindSettings(); return; }
    function shift(d) { ui.m += d; if (ui.m < 0) { ui.m = 11; ui.y--; } if (ui.m > 11) { ui.m = 0; ui.y++; } paint(); }
    document.getElementById('ocPrev').addEventListener('click', function () { shift(-1); });
    document.getElementById('ocNext').addEventListener('click', function () { shift(1); });
    document.getElementById('ocFarm').addEventListener('change', function () { ui.farm = Number(this.value) || 0; paint(); });
    document.getElementById('ocBy').addEventListener('change', function () { ui.by = this.value; paint(); });
    document.getElementById('ocPrint').addEventListener('click', function () {
      var t = title + ' — ' + MONTHS[ui.m] + ' ' + ui.y + (ui.farm ? ' — ' + ((farms.find(function (f) { return f.id === ui.farm; }) || {}).name || '') : '');
      var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' + esc(t) + '</title><style>' +
        'body{font-family:Rubik,Arial,sans-serif;margin:14px;color:#222;}h1{font-size:1.1rem;color:#0c3b30;}' +
        'table{width:100%;border-collapse:collapse;font-size:.72rem;}th{background:#e1eee8;text-align:right;padding:5px;}td{padding:5px;border-bottom:1px solid #ddd;}' +
        'tr.tot td{font-weight:700;background:#eef6f1;}.oc-good{color:#16785c;font-weight:700;}.oc-warn{color:#9a5b00;font-weight:700;}.oc-bad{color:#b3261e;font-weight:700;}.oc-muted{color:#888;font-size:.66rem;}' +
        '@page{size:A4 landscape;margin:10mm;}</style></head><body><h1>' + esc(t) + '</h1>' + reportTable(compute(), true) + '</body></html>';
      if (window.Util && Util.exportReport) Util.exportReport(html, 'op-cost-' + ui.y + '-' + (ui.m + 1) + '.html');
    });
  }

  // ── settings (admin edits; operators read) ──
  function settingsHtml() {
    var ro = !isAdmin() ? ' disabled' : '';
    var known = {};
    (S().getWorklog ? S().getWorklog() : []).forEach(function (e) { if (e.budget_category) known[e.budget_category] = 1; });
    Object.keys(cfg.sections).forEach(function (k) { known[k] = 1; });
    var groups = {};
    (S().getWorkerGroups ? S().getWorkerGroups() : []).forEach(function (g) { groups[g] = 1; });
    Object.keys(cfg.groups).forEach(function (g) { groups[g] = 1; });
    return '<div class="oc-set">' +
      (isAdmin() ? '' : '<p class="oc-muted">' + tt('צפייה בלבד — עריכה למנהל מערכת.', 'ดูอย่างเดียว', 'للعرض فقط') + '</p>') +
      '<div class="oc-row"><label>' + tt('מחיר שעה ברירת מחדל', 'ราคาต่อชม.เริ่มต้น', 'سعر الساعة الافتراضي') + ' <input class="form-input" id="ocRate" type="number" step="0.5" value="' + cfg.rateDefault + '" style="width:80px;"' + ro + '></label>' +
        '<label>' + tt('שעות ביום עבודה (לרישום ללא שעות)', 'ชม./วัน', 'ساعات/يوم') + ' <input class="form-input" id="ocDay" type="number" step="0.5" value="' + cfg.dayHours + '" style="width:70px;"' + ro + '></label></div>' +
      '<div class="oc-sec">' + tt('סעיפים תקציביים — תמחיר והספק נדרש', 'หมวดงบ', 'بنود الميزانية') + '</div>' +
      '<div id="ocSecs">' + Object.keys(known).sort(function (a, b) { return a.localeCompare(b, 'he'); }).map(function (k) {
        var s = cfg.sections[k] || { unit: 'tree', budget: '', target: '' };
        return '<div class="oc-row oc-sec-row" data-k="' + esc(k) + '"><b style="flex:1 1 150px;">' + esc(k) + '</b>' +
          '<select class="form-input oc-unit"' + ro + '>' + Object.keys(UNIT_LBL).map(function (u) { return '<option value="' + u + '"' + (s.unit === u ? ' selected' : '') + '>' + tt('ל', 'ต่อ', 'لكل ') + tt(UNIT_LBL[u]) + '</option>'; }).join('') + '</select>' +
          '<label>₪ <input class="form-input oc-budget" type="number" step="0.01" value="' + (s.budget !== '' ? s.budget : '') + '" style="width:80px;"' + ro + '></label>' +
          '<label>' + tt('הספק לשעה', 'ต่อชม.', 'لكل ساعة') + ' <input class="form-input oc-target" type="number" step="0.1" value="' + (s.target !== '' ? s.target : '') + '" style="width:70px;"' + ro + '></label>' +
          (isAdmin() ? '<button type="button" class="oc-btn ghost oc-calc" title="' + esc(tt('חשב הספק מתמחיר: מחיר שעה ÷ תמחיר', 'คำนวณ', 'احسب')) + '">÷</button>' : '') + '</div>';
      }).join('') + '</div>' +
      (isAdmin() ? '<div class="oc-row"><input class="form-input" id="ocNewSec" placeholder="' + esc(tt('סעיף חדש', 'หมวดใหม่', 'بند جديد')) + '"><button class="oc-btn ghost" id="ocAddSec">➕</button></div>' : '') +
      '<div class="oc-sec">' + tt('מחיר שעה לפי קבוצת עובדים / ספק', 'ราคาต่อชม.ตามกลุ่ม', 'سعر الساعة حسب المجموعة') + '</div>' +
      '<div id="ocGroups">' + Object.keys(groups).sort(function (a, b) { return a.localeCompare(b, 'he'); }).map(function (g) {
        return '<div class="oc-row oc-grp-row" data-g="' + esc(g) + '"><span style="flex:1 1 150px;">' + esc(g) + '</span>' +
          '<label>₪ <input class="form-input oc-grate" type="number" step="0.5" value="' + (cfg.groups[g] != null ? cfg.groups[g] : '') + '" placeholder="' + cfg.rateDefault + '" style="width:80px;"' + ro + '></label></div>';
      }).join('') + '</div>' +
      (isAdmin() ? '<div class="oc-bar"><button class="oc-btn" id="ocSave">💾 ' + tt('שמור תמחיר', 'บันทึก', 'حفظ') + '</button></div>' : '') + '</div>';
  }
  function bindSettings() {
    if (!isAdmin()) return;
    document.querySelectorAll('.oc-calc').forEach(function (b) {
      b.addEventListener('click', function () {
        var row = b.closest('.oc-sec-row'), bud = Number(row.querySelector('.oc-budget').value);
        var rate = Number(document.getElementById('ocRate').value) || cfg.rateDefault;
        if (bud > 0) row.querySelector('.oc-target').value = Math.round(rate / bud * 10) / 10;
      });
    });
    var add = document.getElementById('ocAddSec');
    if (add) add.addEventListener('click', function () {
      var n = document.getElementById('ocNewSec').value.trim();
      if (!n) return;
      readSettings(); cfg.sections[n] = cfg.sections[n] || { unit: 'tree', budget: 0, target: 0 }; paint();
    });
    document.getElementById('ocSave').addEventListener('click', function () {
      readSettings();
      if (save()) toast('✅ ' + tt('התמחיר נשמר', 'บันทึกแล้ว', 'حُفظ'));
    });
  }
  function readSettings() {
    cfg.rateDefault = Number(document.getElementById('ocRate').value) || cfg.rateDefault;
    cfg.dayHours = Number(document.getElementById('ocDay').value) || cfg.dayHours;
    document.querySelectorAll('.oc-sec-row').forEach(function (r) {
      var k = r.getAttribute('data-k'), b = r.querySelector('.oc-budget').value, t = r.querySelector('.oc-target').value;
      if (b === '' && t === '' && !cfg.sections[k]) return;
      cfg.sections[k] = { unit: r.querySelector('.oc-unit').value, budget: Number(b) || 0, target: Number(t) || 0 };
    });
    document.querySelectorAll('.oc-grp-row').forEach(function (r) {
      var g = r.getAttribute('data-g'), v = r.querySelector('.oc-grate').value;
      if (v === '') delete cfg.groups[g]; else cfg.groups[g] = Number(v);
    });
  }

  return { open: open, _compute: function () { return compute(); }, _load: load, _ui: ui };
})();
window.OpCost = OpCost;
