/* cashflow.js — ניהול תזרים למשק (Oct 2026, v1)
 *
 * A monthly cash-flow sheet per farm (or all farms) for a year:
 *   rows    income and expense categories, plus net and cumulative balance
 *           from an opening balance
 *   columns the 12 months, each split into plan and actual
 * Actuals come from two automatic sources plus manual entries:
 *   labour     the work log × group rates (OpCost.labourByFarmMonth)
 *   purchases  supplier documents read into the price database
 *              (PriceBook records: line totals by document date and farm)
 *   manual     anything else — sales, water, electricity, leases, loans…
 * Plans are entered per category per month (or one amount spread over the year).
 *
 * Data: appData/shorashim-cashflow-YYYY { opening: {farmId: ₪}, entries: [
 *         {id, farmId, m (0-11), cat, kind: 'plan'|'actual', amount, note, by, at}] }
 *       operator+ read and write (firestore.rules) — financial data.
 * Public: CashFlow.open()
 */
var CashFlow = (function () {
  'use strict';

  var PREFIX = 'shorashim-cashflow-';
  var IN = [['sales', 'מכירת תוצרת'], ['services', 'שירותים / קבלנות'], ['grants', 'מענקים וסובסידיות'], ['in_other', 'הכנסות אחרות']];
  var OUT = [['labour', 'עבודה (מיומן העבודה)'], ['purchases', 'רכש — חומרים ודשנים (ממסמכים)'], ['water', 'מים'], ['power', 'חשמל'], ['fuel', 'דלק'],
    ['vehicles', 'כלים, רכבים ותיקונים'], ['contractors', 'קבלני משנה'], ['lease', 'שכירות / חכירה'], ['insurance', 'ביטוח'], ['finance', 'מימון והלוואות'], ['out_other', 'הוצאות אחרות']];
  var AUTO = { labour: 1, purchases: 1 };
  var MONTHS = ['ינו׳', 'פבר׳', 'מרץ', 'אפר׳', 'מאי', 'יוני', 'יולי', 'אוג׳', 'ספט׳', 'אוק׳', 'נוב׳', 'דצמ׳'];

  var year = new Date().getFullYear(), D = null, auto = { labour: {}, purchases: {} }, ui = { farm: 0, show: 'both' }, lastSaved = '';

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
  function isMgr() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator'; }
  function key() { return PREFIX + year; }
  function money(n) { var v = Math.round(Number(n) || 0); return (v < 0 ? '−' : '') + '₪' + Math.abs(v).toLocaleString('he-IL'); }
  function k0(n) { var v = Math.round(Number(n) || 0); return v ? (Math.abs(v) >= 10000 ? (Math.round(v / 100) / 10) + 'K' : v.toLocaleString('he-IL')) : ''; }
  function zeros() { return [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; }
  function norm(d) {
    d = d && typeof d === 'object' ? d : {};
    return { opening: (d.opening && typeof d.opening === 'object') ? d.opening : {}, entries: Array.isArray(d.entries) ? d.entries : [] };
  }
  function farms() { return S().getFarms ? S().getFarms() : []; }

  function load() {
    D = norm(null);
    var p1 = (typeof DB !== 'undefined' && DB.read) ? DB.read(key()).then(function (r) { D = norm(r && r.data); }, function () {}) : Promise.resolve();
    var p2 = (window.OpCost && OpCost.labourByFarmMonth) ? OpCost.labourByFarmMonth(year).then(function (x) { auto.labour = x || {}; }, function () { auto.labour = {}; }) : Promise.resolve();
    var p3 = (window.PriceBook && PriceBook.recordsFor) ? PriceBook.recordsFor([year]).then(function (recs) {
      var out = {};
      (recs || []).forEach(function (r) {
        var m = Number(String(r.date || '').slice(5, 7)) - 1;
        if (!(m >= 0 && m < 12)) return;
        var v = Number(r.lineTotal) || ((Number(r.unitPrice) || 0) * (Number(r.qty) || 0));
        if (!v) return;
        var f = r.farmId || 0;
        (out[f] = out[f] || zeros())[m] += v;
      });
      auto.purchases = out;
    }, function () { auto.purchases = {}; }) : Promise.resolve();
    return Promise.all([p1, p2, p3]);
  }
  function persist() {
    var clean = JSON.parse(JSON.stringify(D));
    lastSaved = JSON.stringify(clean);
    var p = DB.saveAsync ? DB.saveAsync(key(), clean) : (DB.save(key(), clean), Promise.resolve());
    return p.then(function () { return true; }, function (e) {
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + ((e && (e.code || e.message)) || e));
      return false;
    });
  }

  // ── numbers ──
  function inFarm(f) { return !ui.farm || Number(f) === ui.farm; }
  function autoRow(cat) {
    var src = auto[cat] || {}, out = zeros();
    Object.keys(src).forEach(function (f) { if (inFarm(f)) src[f].forEach(function (v, m) { out[m] += v; }); });
    return out;
  }
  function entryRow(cat, kind) {
    var out = zeros();
    D.entries.forEach(function (e) { if (e.cat === cat && e.kind === kind && inFarm(e.farmId)) out[e.m] += Number(e.amount) || 0; });
    return out;
  }
  function actualRow(cat) {
    var a = entryRow(cat, 'actual');
    if (AUTO[cat]) autoRow(cat).forEach(function (v, m) { a[m] += v; });
    return a;
  }
  function sum(arr) { return arr.reduce(function (a, b) { return a + b; }, 0); }
  function opening() {
    var o = 0;
    Object.keys(D.opening).forEach(function (f) { if (inFarm(f)) o += Number(D.opening[f]) || 0; });
    return o;
  }

  // ── UI ──
  function open() {
    if (!isMgr()) { toast('⛔ ' + tt('למנהלים בלבד', 'สำหรับผู้จัดการ', 'للمديرين فقط')); return; }
    ensureCss();
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '<div class="modal-overlay"><div class="modal"><p>⏳ ' + tt('טוען נתוני תזרים…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</p></div></div>';
    load().then(render);
  }
  function close() { var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    var curM = (year === new Date().getFullYear()) ? new Date().getMonth() : (year < new Date().getFullYear() ? 11 : -1);
    var showP = ui.show !== 'actual', showA = ui.show !== 'plan';
    var sub = (showP && showA) ? 2 : 1;
    var head1 = '<tr><th rowspan="' + (sub > 1 ? 2 : 1) + '" class="cf-c">' + tt('סעיף', 'หมวด', 'البند') + '</th>' + MONTHS.map(function (mn, i) {
      return '<th colspan="' + sub + '" class="' + (i === curM ? 'cur' : '') + '">' + mn + '</th>'; }).join('') +
      '<th colspan="' + sub + '">' + tt('שנתי', 'ทั้งปี', 'سنوي') + '</th></tr>';
    var head2 = sub > 1 ? '<tr>' + MONTHS.concat(['y']).map(function () { return '<th class="sm">' + tt('תכנון', 'แผน', 'خطة') + '</th><th class="sm">' + tt('בפועל', 'จริง', 'فعلي') + '</th>'; }).join('') + '</tr>' : '';
    var cells = function (pl, ac, cls) {
      var h = '';
      for (var i = 0; i < 12; i++) {
        if (showP) h += '<td class="n p ' + (cls || '') + '">' + k0(pl[i]) + '</td>';
        if (showA) h += '<td class="n a ' + (cls || '') + (i > curM ? ' fut' : '') + '">' + k0(ac[i]) + '</td>';
      }
      if (showP) h += '<td class="n p tot ' + (cls || '') + '">' + k0(sum(pl)) + '</td>';
      if (showA) h += '<td class="n a tot ' + (cls || '') + '">' + k0(sum(ac)) + '</td>';
      return h;
    };
    var totIn = { p: zeros(), a: zeros() }, totOut = { p: zeros(), a: zeros() };
    var rows = function (list, tot, sign) {
      return list.map(function (c) {
        var pl = entryRow(c[0], 'plan'), ac = actualRow(c[0]);
        pl.forEach(function (v, i) { tot.p[i] += v; }); ac.forEach(function (v, i) { tot.a[i] += v; });
        return '<tr data-cat="' + c[0] + '"><td class="cf-c">' + esc(c[1]) + (AUTO[c[0]] ? ' <small title="' + esc(tt('מתעדכן אוטומטית', 'อัปเดตอัตโนมัติ', 'يتحدث تلقائياً')) + '">⚡</small>' : '') + '</td>' + cells(pl, ac) + '</tr>';
      }).join('');
    };
    var inRows = rows(IN, totIn), outRows = rows(OUT, totOut);
    var net = { p: totIn.p.map(function (v, i) { return v - totOut.p[i]; }), a: totIn.a.map(function (v, i) { return v - totOut.a[i]; }) };
    var bal = { p: zeros(), a: zeros() }, o = opening(), bp = o, ba = o;
    for (var i = 0; i < 12; i++) { bp += net.p[i]; ba += net.a[i]; bal.p[i] = bp; bal.a[i] = ba; }
    var lowM = -1;
    for (var j = 0; j < 12; j++) { var b = (j <= curM) ? bal.a[j] : bal.p[j]; if (b < 0) { lowM = j; break; } }
    var yrs = []; for (var y = new Date().getFullYear() + 1; y >= new Date().getFullYear() - 3; y--) yrs.push(y);
    var kpi = function (lbl, v, cls) { return '<div class="cf-k ' + (cls || '') + '"><small>' + lbl + '</small><b>' + money(v) + '</b></div>'; };
    var ytdIn = sum(totIn.a.slice(0, curM + 1)), ytdOut = sum(totOut.a.slice(0, curM + 1));
    m.innerHTML = '<div class="modal-overlay" id="cfRoot"><div class="modal cf">' +
      '<div class="cf-h"><h2>💰 ' + tt('תזרים מזומנים', 'กระแสเงินสด', 'التدفق النقدي') + '</h2>' +
        '<select class="form-input cf-s" id="cfFarm"><option value="0">' + tt('כל המשקים', 'ทุกฟาร์ม', 'كل المزارع') + '</option>' + farms().map(function (f) { return '<option value="' + f.id + '"' + (ui.farm === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select>' +
        '<select class="form-input cf-s" id="cfYear">' + yrs.map(function (x) { return '<option' + (x === year ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
        '<button class="cf-btn ghost" data-a="close">✕</button></div>' +
      '<div class="cf-kpis">' + kpi(tt('יתרת פתיחה', 'ยอดยกมา', 'الرصيد الافتتاحي'), o) + kpi(tt('הכנסות עד היום', 'รายรับถึงวันนี้', 'الدخل حتى اليوم'), ytdIn, 'in') +
        kpi(tt('הוצאות עד היום', 'รายจ่ายถึงวันนี้', 'المصروفات حتى اليوم'), ytdOut, 'out') + kpi(tt('יתרה היום', 'ยอดคงเหลือ', 'الرصيد اليوم'), curM >= 0 ? bal.a[curM] : o, (curM >= 0 ? bal.a[curM] : o) < 0 ? 'neg' : '') +
        kpi(tt('צפי לסוף השנה', 'คาดการณ์สิ้นปี', 'المتوقع نهاية السنة'), (curM >= 0 ? bal.a[curM] : o) + sum(net.p.slice(curM + 1)), '') + '</div>' +
      (lowM !== -1 ? '<div class="cf-warn">⚠️ ' + tt('היתרה צפויה לרדת מתחת לאפס ב', 'ยอดจะติดลบใน', 'سيصبح الرصيد سالباً في') + MONTHS[lowM] + ' ' + year + '</div>' : '') +
      '<div class="cf-bar">' +
        '<button class="cf-btn pri" data-a="add">＋ ' + tt('תנועה / תכנון', 'รายการ', 'حركة / خطة') + '</button>' +
        '<button class="cf-btn" data-a="opening">🏦 ' + tt('יתרת פתיחה', 'ยอดยกมา', 'الرصيد الافتتاحي') + '</button>' +
        '<span class="cf-seg">' + [['both', tt('תכנון + בפועל', 'ทั้งสอง', 'الكل')], ['plan', tt('תכנון', 'แผน', 'خطة')], ['actual', tt('בפועל', 'จริง', 'فعلي')]].map(function (o2) {
          return '<button class="' + (ui.show === o2[0] ? 'on' : '') + '" data-show="' + o2[0] + '">' + o2[1] + '</button>'; }).join('') + '</span>' +
        '<button class="cf-btn ghost" data-a="print">🖨 ' + tt('הדפסה', 'พิมพ์', 'طباعة') + '</button>' +
      '</div>' +
      '<div class="cf-wrap"><table class="cf-t"><thead>' + head1 + head2 + '</thead><tbody>' +
        '<tr class="grp in"><td colspan="99">⬆ ' + tt('הכנסות', 'รายรับ', 'الدخل') + '</td></tr>' + inRows +
        '<tr class="tot in"><td class="cf-c">' + tt('סה״כ הכנסות', 'รวมรายรับ', 'مجموع الدخل') + '</td>' + cells(totIn.p, totIn.a) + '</tr>' +
        '<tr class="grp out"><td colspan="99">⬇ ' + tt('הוצאות', 'รายจ่าย', 'المصروفات') + '</td></tr>' + outRows +
        '<tr class="tot out"><td class="cf-c">' + tt('סה״כ הוצאות', 'รวมรายจ่าย', 'مجموع المصروفات') + '</td>' + cells(totOut.p, totOut.a) + '</tr>' +
        '<tr class="net"><td class="cf-c">' + tt('תזרים נטו', 'สุทธิ', 'الصافي') + '</td>' + cells(net.p, net.a) + '</tr>' +
        '<tr class="bal"><td class="cf-c">' + tt('יתרה מצטברת', 'ยอดสะสม', 'الرصيد التراكمي') + '</td>' + cells(bal.p, bal.a, 'b') + '</tr>' +
      '</tbody></table></div>' +
      '<div class="cf-muted">⚡ ' + tt('עבודה — מיומן העבודה לפי תעריפי הקבוצות (תמחיר); רכש — מסמכי ספקים שנקראו למאגר המחירים. לחיצה על שורה מציגה ומוסיפה תנועות. סכומים ב־₪, K = אלפים.',
        'แรงงานจากบันทึกงาน · การซื้อจากเอกสาร', 'العمل من سجل العمل · المشتريات من المستندات') + '</div>' +
      '<div id="cfPanel"></div>' +
    '</div></div>';
    var root = document.getElementById('cfRoot');
    root.addEventListener('click', onClick);
    document.getElementById('cfFarm').onchange = function () { ui.farm = Number(this.value) || 0; render(); };
    document.getElementById('cfYear').onchange = function () { year = Number(this.value); open(); };
  }

  function catName(c) { var x = IN.concat(OUT).find(function (y) { return y[0] === c; }); return x ? x[1] : c; }

  function addForm(cat) {
    var p = document.getElementById('cfPanel');
    var fs = farms();
    p.innerHTML = '<div class="cf-form"><h3>＋ ' + tt('תנועה או תכנון', 'รายการ', 'حركة أو خطة') + '</h3>' +
      '<div class="cf-g">' +
        '<label>' + tt('סוג', 'ชนิด', 'النوع') + '<select class="form-input" id="cfKind"><option value="actual">' + tt('בפועל', 'จริง', 'فعلي') + '</option><option value="plan">' + tt('תכנון', 'แผน', 'خطة') + '</option></select></label>' +
        '<label>' + tt('סעיף', 'หมวด', 'البند') + '<select class="form-input" id="cfCat">' +
          '<optgroup label="' + tt('הכנסות', 'รายรับ', 'الدخل') + '">' + IN.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === cat ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('') + '</optgroup>' +
          '<optgroup label="' + tt('הוצאות', 'รายจ่าย', 'المصروفات') + '">' + OUT.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === cat ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('') + '</optgroup></select></label>' +
        '<label>' + tt('משק', 'ฟาร์ม', 'المزرعة') + '<select class="form-input" id="cfF"><option value="0">' + tt('כללי', 'ทั่วไป', 'عام') + '</option>' + fs.map(function (f) { return '<option value="' + f.id + '"' + (ui.farm === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select></label>' +
        '<label>' + tt('חודש', 'เดือน', 'الشهر') + '<select class="form-input" id="cfM">' + MONTHS.map(function (mn, i) { return '<option value="' + i + '"' + (i === new Date().getMonth() ? ' selected' : '') + '>' + mn + '</option>'; }).join('') +
          '<option value="all">' + tt('כל השנה (מחולק ל־12)', 'ทั้งปี ÷12', 'السنة كلها ÷12') + '</option></select></label>' +
        '<label>' + tt('סכום ₪', 'จำนวน ₪', 'المبلغ ₪') + '<input class="form-input" id="cfAmt" type="number" step="any" inputmode="decimal"></label>' +
        '<label>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '<input class="form-input" id="cfNote"></label>' +
      '</div>' +
      '<div class="cf-bar"><button class="cf-btn pri" id="cfSave">💾 ' + tt('שמירה', 'บันทึก', 'حفظ') + '</button><button class="cf-btn ghost" data-a="hidepanel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    p.scrollIntoView({ block: 'nearest' });
    document.getElementById('cfSave').onclick = function () {
      var amt = Number(document.getElementById('cfAmt').value);
      if (!amt) { toast('❌ ' + tt('חסר סכום', 'ไม่มีจำนวน', 'المبلغ ناقص')); return; }
      var mv = document.getElementById('cfM').value, months = mv === 'all' ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] : [Number(mv)];
      var u = window.currentUser || {}, base = Date.now();
      months.forEach(function (mm, k) {
        D.entries.push({ id: base + k, farmId: Number(document.getElementById('cfF').value) || 0, m: mm, cat: document.getElementById('cfCat').value,
          kind: document.getElementById('cfKind').value, amount: Math.round(amt / months.length * 100) / 100, note: document.getElementById('cfNote').value.trim(), by: u.name || u.username || '', at: base });
      });
      persist().then(function (ok) { if (ok) toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ')); render(); });
    };
  }

  function catPanel(cat) {
    var p = document.getElementById('cfPanel');
    var list = D.entries.filter(function (e) { return e.cat === cat && inFarm(e.farmId); }).sort(function (a, b) { return a.m - b.m || a.kind.localeCompare(b.kind); });
    var fname = function (id) { var f = farms().find(function (x) { return x.id === Number(id); }); return f ? f.name : tt('כללי', 'ทั่วไป', 'عام'); };
    var autoTxt = AUTO[cat] ? '<div class="cf-muted">⚡ ' + (cat === 'labour' ? tt('בפועל כולל אוטומטית את עלות העבודה מיומן העבודה: ', 'รวมค่าแรงอัตโนมัติ: ', 'يشمل تلقائياً تكلفة العمل: ') : tt('בפועל כולל אוטומטית רכש ממסמכי ספקים: ', 'รวมการซื้ออัตโนมัติ: ', 'يشمل تلقائياً المشتريات: ')) + '<b>' + money(sum(autoRow(cat))) + '</b></div>' : '';
    p.innerHTML = '<div class="cf-form"><h3>' + esc(catName(cat)) + '</h3>' + autoTxt +
      (list.length ? list.map(function (e) {
        return '<div class="cf-e"><span>' + MONTHS[e.m] + '</span><span class="cf-kd ' + e.kind + '">' + (e.kind === 'plan' ? tt('תכנון', 'แผน', 'خطة') : tt('בפועל', 'จริง', 'فعلي')) + '</span><b>' + money(e.amount) + '</b><small>' + esc(fname(e.farmId)) + (e.note ? ' · ' + esc(e.note) : '') + '</small>' +
          '<button class="cf-x" data-del="' + e.id + '">🗑</button></div>';
      }).join('') : '<div class="cf-muted">' + tt('אין תנועות ידניות בסעיף הזה', 'ไม่มีรายการ', 'لا حركات') + '</div>') +
      '<div class="cf-bar"><button class="cf-btn pri" data-addcat="' + cat + '">＋ ' + tt('הוספה לסעיף', 'เพิ่ม', 'إضافة') + '</button><button class="cf-btn ghost" data-a="hidepanel">' + tt('סגור', 'ปิด', 'إغلاق') + '</button></div></div>';
    p.scrollIntoView({ block: 'nearest' });
  }

  function openingForm() {
    var p = document.getElementById('cfPanel');
    p.innerHTML = '<div class="cf-form"><h3>🏦 ' + tt('יתרת פתיחה ל־1 בינואר', 'ยอดยกมา 1 ม.ค.', 'الرصيد الافتتاحي 1 يناير') + ' ' + year + '</h3>' +
      '<label class="cf-ol"><span>' + tt('כללי', 'ทั่วไป', 'عام') + '</span><input class="form-input cf-op" data-f="0" type="number" step="any" value="' + (D.opening[0] || '') + '"></label>' +
      farms().map(function (f) { return '<label class="cf-ol"><span>' + esc(f.name) + '</span><input class="form-input cf-op" data-f="' + f.id + '" type="number" step="any" value="' + (D.opening[f.id] || '') + '"></label>'; }).join('') +
      '<div class="cf-bar"><button class="cf-btn pri" id="cfOpSave">💾 ' + tt('שמירה', 'บันทึก', 'حفظ') + '</button><button class="cf-btn ghost" data-a="hidepanel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    p.scrollIntoView({ block: 'nearest' });
    document.getElementById('cfOpSave').onclick = function () {
      D.opening = {};
      document.querySelectorAll('.cf-op').forEach(function (i) { var v = Number(i.value); if (v) D.opening[i.getAttribute('data-f')] = v; });
      persist().then(render);
    };
  }

  function printIt() {
    var t = document.querySelector('.cf-t');
    if (!t) return;
    var f = farms().find(function (x) { return x.id === ui.farm; });
    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>תזרים ' + year + '</title><style>' +
      'body{font-family:Rubik,Arial,sans-serif;margin:10px;color:#1b2a1f;}h1{font-size:1rem;color:#12401f;}table{width:100%;border-collapse:collapse;font-size:.62rem;}' +
      'th,td{border:1px solid #ddd;padding:3px;text-align:center;}td:first-child{text-align:right;white-space:nowrap;}tr.grp td{background:#eef7d4;font-weight:700;text-align:right;}' +
      'tr.tot td,tr.net td{font-weight:700;background:#f4f7f1;}tr.bal td{font-weight:700;background:#e8f0e0;}td.p{color:#777;}' +
      '@page{size:A4 landscape;margin:8mm;}</style></head><body><h1>💰 תזרים מזומנים ' + year + ' — ' + esc(f ? f.name : 'כל המשקים') + '</h1>' + t.outerHTML + '</body></html>';
    if (window.Util && Util.exportReport) Util.exportReport(html, 'cashflow-' + year + '.html');
  }

  function onClick(e) {
    var t = e.target;
    if (t.id === 'cfRoot') return close();
    var a = t.closest('[data-a]');
    if (a) {
      var k = a.getAttribute('data-a');
      if (k === 'close') return close();
      if (k === 'add') return addForm('');
      if (k === 'opening') return openingForm();
      if (k === 'print') return printIt();
      if (k === 'hidepanel') { document.getElementById('cfPanel').innerHTML = ''; return; }
    }
    var sh = t.closest('[data-show]'); if (sh) { ui.show = sh.getAttribute('data-show'); return render(); }
    var ac = t.closest('[data-addcat]'); if (ac) return addForm(ac.getAttribute('data-addcat'));
    var dl = t.closest('[data-del]');
    if (dl) {
      if (!confirm(tt('למחוק את התנועה?', 'ลบ?', 'حذف؟'))) return;
      var id = dl.getAttribute('data-del'), cat = (D.entries.find(function (x) { return String(x.id) === id; }) || {}).cat;
      D.entries = D.entries.filter(function (x) { return String(x.id) !== id; });
      persist().then(function () { render(); if (cat) catPanel(cat); });
      return;
    }
    var row = t.closest('tr[data-cat]'); if (row) return catPanel(row.getAttribute('data-cat'));
  }

  function ensureCss() {
    if (document.getElementById('cfCss')) return;
    var st = document.createElement('style');
    st.id = 'cfCss';
    st.textContent =
      '.cf{max-width:1400px !important;width:100%;}.cf-h{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;}.cf-h h2{flex:1;margin:0;}.cf-s{width:auto !important;margin:0 !important;}' +
      '.cf-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:8px 12px;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.cf-btn.pri{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.cf-btn.ghost{background:transparent;}' +
      '.cf-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:8px;}' +
      '.cf-k{background:var(--tonal,#f1f4ee);border-radius:16px;padding:10px 12px;}.cf-k small{display:block;font-size:.7rem;color:var(--text-muted,#6f7b72);}.cf-k b{font-size:1.15rem;}' +
      '.cf-k.in b{color:#2e7d32;}.cf-k.out b{color:#a85d00;}.cf-k.neg b{color:#b3261e;}' +
      '.cf-warn{background:#fde9e7;color:#8c1d18;border-radius:14px;padding:9px 12px;font-size:.84rem;margin-bottom:8px;}' +
      '.cf-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0;}' +
      '.cf-seg{display:inline-flex;background:var(--tonal,#f1f4ee);border-radius:12px;padding:3px;}.cf-seg button{border:0;background:transparent;border-radius:9px;padding:6px 10px;font:inherit;font-size:.78rem;cursor:pointer;color:var(--text-muted,#6f7b72);}' +
      '.cf-seg button.on{background:var(--card,#fff);color:var(--primary,#1d5a2c);font-weight:700;box-shadow:0 1px 4px rgba(0,0,0,.08);}' +
      '.cf-wrap{overflow:auto;border:1px solid var(--line,#e6ebe2);border-radius:14px;max-height:62vh;}' +
      '.cf-t{border-collapse:collapse;font-size:.74rem;min-width:1100px;width:100%;}.cf-t th{position:sticky;top:0;background:var(--tonal,#f1f4ee);padding:6px 4px;font-weight:600;font-size:.7rem;z-index:1;white-space:nowrap;}' +
      '.cf-t thead tr:nth-child(2) th{top:27px;}.cf-t th.cur{background:var(--primary-soft,#eef7d4);}.cf-t th.sm{font-weight:400;font-size:.64rem;}' +
      '.cf-t td{padding:5px 4px;border-top:1px solid var(--line,#eef1ec);}.cf-t td.n{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.cf-t td.p{color:var(--text-muted,#7b867e);}.cf-t td.fut{color:#bbb;}.cf-t td.tot{font-weight:700;background:var(--tonal,#f6f8f4);}' +
      '.cf-c{position:sticky;right:0;background:var(--card,#fff);text-align:right;white-space:nowrap;min-width:170px;z-index:1;}' +
      '.cf-t tr[data-cat]{cursor:pointer;}.cf-t tr[data-cat]:hover td{background:var(--tonal,#f6f8f4);}' +
      '.cf-t tr.grp td{background:var(--primary-soft,#eef7d4);font-weight:700;position:sticky;right:0;}.cf-t tr.grp.out td{background:#fff4e2;}' +
      '.cf-t tr.tot td,.cf-t tr.net td{font-weight:700;background:var(--tonal,#f4f7f1);}.cf-t tr.bal td{font-weight:800;background:#e8f0e0;}' +
      '.cf-muted{font-size:.72rem;color:var(--text-muted,#6f7b72);margin-top:6px;}' +
      '.cf-form{border:1px solid var(--line,#e6ebe2);border-radius:16px;padding:12px 14px;margin-top:10px;}.cf-form h3{margin:0 0 8px;}' +
      '.cf-g{display:grid;gap:8px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));}.cf-g label{display:flex;flex-direction:column;gap:4px;font-size:.74rem;color:var(--text-muted,#6f7b72);}.cf-g .form-input{margin:0;}' +
      '.cf-e{display:grid;grid-template-columns:50px 60px 100px 1fr 34px;gap:6px;align-items:center;padding:6px 0;border-top:1px solid var(--line,#eef1ec);font-size:.82rem;}' +
      '.cf-kd{font-size:.68rem;border-radius:8px;padding:2px 6px;text-align:center;}.cf-kd.plan{background:var(--tonal,#f1f4ee);}.cf-kd.actual{background:var(--primary-soft,#eef7d4);}' +
      '.cf-e small{color:var(--text-muted,#6f7b72);}.cf-x{border:0;background:var(--tonal,#f1f4ee);border-radius:9px;height:30px;cursor:pointer;}' +
      '.cf-ol{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:4px 0;font-size:.84rem;}.cf-ol .form-input{width:140px;margin:0;}';
    document.head.appendChild(st);
  }

  return { open: open, close: close };
})();
window.CashFlow = CashFlow;
