/* shipments.js — משלוחי פרי, קליטה בבית האריזה, ארגזים, ותזרים מתוצאות המיון (Oct 2026)
 *
 * Per farm and season, three screens:
 *   1. Shipments & intake — grower delivery notes (תעודת מגדל), each with
 *      its pallets: crates, gross weight weighed at the farm and at the
 *      packing house. Net = gross − crates × tare (default 1.15 kg/crate);
 *      the farm-vs-packhouse difference per pallet, note and season.
 *   2. Crates — empty crates in / out; full crates leaving with fruit are
 *      counted from the delivery notes; running balance with a chart.
 *   3. Cash flow from a sorting report (harvest.js) — the calculation from
 *      Alon's "תוצאות מיון" sheet: fraction kg × (price + expected change),
 *      share, premium share, average per kg, sorting cost, receipts with
 *      VAT (18%, included), ledger excluding new-season advances, expected
 *      by the X% milestone and at final settlement; can be written into the
 *      farm's cash flow (cashflow.js) as planned income.
 *
 * Data: appData/shorashim-shipments-YYYY (season: from July, else last year)
 *   { notes: [{ id, farmId, growerNo, intakeNo, type, harvestDate, exitDate,
 *               dest, note, pallets: [{ id, barcode, crates, grossFarm,
 *               weighDate, grossPh }] }],
 *     crates: [{ id, farmId, date, kind: 'in'|'out', qty, pallets, type, note }],
 *     fin: { [harvestReportId]: { prices: {code: {price, change}}, sortMode,
 *            sortRate, sortTotal, basisNet, basisVat, pct, pctMonth,
 *            finalMonth, receipts: [{ id, date, type, amount, newSeason, note }] } },
 *     tare: { [farmId]: kg per crate }, low: { [farmId]: crates } }
 *   Operator+ read and write (firestore.rules) — commercial data.
 * Public: Shipments.open(farmId?, tab?, reportId?)
 */
var Shipments = (function () {
  'use strict';

  var PREFIX = 'shorashim-shipments-', HV = 'shorashim-harvest-', CF = 'shorashim-cashflow-';
  var VAT = 0.18;
  function defaultSeason() { var d = new Date(); return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1; }
  var season = defaultSeason(), D = null, HVD = null, PREV = null;
  var ui = { farm: '', tab: 'ship', open: {}, edit: null, rep: '', crateForm: null };

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
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function fmt(n, d) { return (Math.round(num(n) * Math.pow(10, d || 0)) / Math.pow(10, d || 0)).toLocaleString('he-IL', { maximumFractionDigits: d || 0 }); }
  function money(n) { return '₪' + fmt(n); }
  function signed(n, d) { var v = num(n); return '<span dir="ltr" style="unicode-bidi:isolate;">' + (v > 0 ? '+' : v < 0 ? '−' : '') + fmt(Math.abs(v), d) + '</span>'; }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function fmtD(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? m[3] + '/' + m[2] + '/' + m[1].slice(2) : (iso || ''); }
  function staff() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator'; }
  function mine(o) { return !window.Own || Own.canEdit(o); }
  function S() { return window.SprayStore || {}; }
  function farms() { return S().getFarms ? S().getFarms() : []; }
  function farmName(id) { var f = farms().find(function (x) { return x.id === Number(id); }); return f ? f.name : '—'; }
  function key(y) { return PREFIX + (y || season); }

  function norm(d) {
    d = d && typeof d === 'object' ? d : {};
    return { notes: Array.isArray(d.notes) ? d.notes : [], crates: Array.isArray(d.crates) ? d.crates : [],
      fin: d.fin && typeof d.fin === 'object' ? d.fin : {}, tare: d.tare && typeof d.tare === 'object' ? d.tare : {},
      low: d.low && typeof d.low === 'object' ? d.low : {} };
  }
  function load() {
    if (typeof DB === 'undefined') { D = norm(null); HVD = { reports: [] }; return Promise.resolve(); }
    return Promise.all([DB.read(key()), DB.read(HV + season), DB.read(HV + (season - 1))]).then(function (r) {
      D = (r[0].ok || r[0].data) ? norm(r[0].data) : null;
      HVD = (r[1] && r[1].data && Array.isArray(r[1].data.reports)) ? r[1].data : { reports: [] };
      PREV = (r[2] && r[2].data && Array.isArray(r[2].data.reports)) ? r[2].data : { reports: [] };
    }, function () { D = null; });
  }
  // Re-read, apply, write — two people entering notes do not overwrite each other.
  function commit(fn) {
    return DB.read(key()).then(function (res) {
      var base;
      if (res.ok) base = norm(res.exists ? res.data : null);
      else if (D) base = norm(JSON.parse(JSON.stringify(D)));
      else { toast('❌ ' + tt('אין חיבור לשרת — לא נשמר', 'ไม่มีการเชื่อมต่อ', 'لا اتصال — لم يُحفظ')); return false; }
      if (fn(base) === false) return false;
      var clean = JSON.parse(JSON.stringify(base));
      return (DB.saveAsync ? DB.saveAsync(key(), clean) : (DB.save(key(), clean), Promise.resolve())).then(function () { D = base; return true; }, function (e) {
        var c = String((e && (e.code || e.message)) || e);
        toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + (/permission/i.test(c) ? tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية') : c));
        return false;
      });
    });
  }

  // ── maths ──
  function tareOf(fid) { var t = D && D.tare[String(fid)]; return t != null && t !== '' ? num(t) : 1.15; }
  function palletCalc(p, tare) {
    var crates = num(p.crates), tw = crates * tare;
    var nf = num(p.grossFarm) ? num(p.grossFarm) - tw : 0, np = num(p.grossPh) ? num(p.grossPh) - tw : 0;
    return { crates: crates, tare: tw, netFarm: nf, netPh: np, diff: (num(p.grossFarm) && num(p.grossPh)) ? np - nf : null };
  }
  function noteCalc(n) {
    var t = tareOf(n.farmId), o = { pallets: 0, crates: 0, netFarm: 0, netPh: 0, diff: 0, both: 0, pending: false };
    (n.pallets || []).forEach(function (p) {
      var c = palletCalc(p, t);
      o.pallets++; o.crates += c.crates; o.netFarm += c.netFarm; o.netPh += c.netPh;
      if (c.diff != null) { o.diff += c.diff; o.both += c.netFarm; } else if (num(p.grossFarm)) o.pending = true;
    });
    if (!n.intakeNo && !o.netPh) o.pending = true;
    return o;
  }
  function farmNotes() { return ((D && D.notes) || []).filter(function (n) { return !ui.farm || String(n.farmId) === ui.farm; }); }

  // ── shell ──
  function open(fid, tab, rep) {
    if (!staff()) { toast('⛔ ' + tt('למנהלים בלבד', 'สำหรับผู้จัดการ', 'للمديرين فقط')); return; }
    ensureCss();
    if (fid != null) ui.farm = String(fid);
    else if (!ui.farm && farms()[0]) ui.farm = String(farms()[0].id);
    if (tab) ui.tab = tab;
    if (rep) ui.rep = rep;
    ui.edit = null; ui.crateForm = null;
    load().then(render);
  }
  function close() { var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }
  function render() {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    var yrs = []; for (var y = defaultSeason() + 1; y >= defaultSeason() - 3; y--) yrs.push(y);
    var head = '<div class="sh-h"><h2>🚚 ' + tt('משלוחי פרי, קליטה ותזרים', 'การส่งผลผลิต รับเข้า และกระแสเงินสด', 'شحنات الثمار والاستلام والتدفق النقدي') + '</h2>' +
      '<select class="form-input sh-s" id="shSeason">' + yrs.map(function (y) { return '<option value="' + y + '"' + (y === season ? ' selected' : '') + '>' + tt('עונה', 'ฤดูกาล', 'موسم') + ' ' + y + '</option>'; }).join('') + '</select>' +
      '<select class="form-input sh-s" id="shFarm">' + farms().map(function (f) { return '<option value="' + f.id + '"' + (String(f.id) === ui.farm ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select>' +
      '<button class="sh-btn ghost" data-a="close" aria-label="x">✕</button></div>' +
      '<div class="sh-tabs">' + [['ship', '🚚 ' + tt('משלוחים וקליטה', 'การส่งและรับเข้า', 'الشحنات والاستلام')], ['crates', '📦 ' + tt('ארגזים', 'ลัง', 'الصناديق')], ['fin', '💰 ' + tt('תזרים מתוצאות המיון', 'กระแสเงินจากผลคัดแยก', 'التدفق من نتائج الفرز')]].map(function (t) {
        return '<button class="sh-tab' + (ui.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>';
    var body = !D ? '<div class="sh-empty">' + tt('לא הצלחתי לטעון — בדוק חיבור', 'โหลดไม่ได้', 'تعذّر التحميل') + '</div>'
      : ui.tab === 'crates' ? cratesView() : ui.tab === 'fin' ? finView() : (ui.edit ? noteForm() : shipView());
    m.innerHTML = '<div class="modal-overlay" id="shRoot"><div class="modal sh">' + head + '<div id="shBody">' + body + '</div></div></div>';
    var root = document.getElementById('shRoot');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
  }

  // ── 1. shipments ──
  function shipView() {
    var ns = farmNotes().slice().sort(function (a, b) { return String(b.exitDate || b.harvestDate || '').localeCompare(String(a.exitDate || a.harvestDate || '')); });
    var tot = { notes: ns.length, pallets: 0, crates: 0, nf: 0, np: 0, diff: 0, both: 0, pending: 0 };
    ns.forEach(function (n) { var c = noteCalc(n); tot.pallets += c.pallets; tot.crates += c.crates; tot.nf += c.netFarm; tot.np += c.netPh; tot.diff += c.diff; tot.both += c.both; if (c.pending) tot.pending++; });
    var dpct = tot.both ? tot.diff / tot.both * 100 : 0;
    var kg = tt('ק"ג', 'กก.', 'كغ');
    var kpis = '<div class="sh-kpis">' +
      kpi(tt('תעודות משלוח', 'ใบส่ง', 'سندات الشحن'), fmt(tot.notes)) +
      kpi(tt('משטחים / ארגזים', 'พาเลท / ลัง', 'منصات / صناديق'), fmt(tot.pallets) + ' / ' + fmt(tot.crates)) +
      kpi(tt('נטו במשק', 'สุทธิที่ฟาร์ม', 'صافي في المزرعة'), fmt(tot.nf) + ' ' + kg) +
      kpi(tt('נטו בבית האריזה', 'สุทธิที่โรงคัด', 'صافي في بيت التعبئة'), fmt(tot.np) + ' ' + kg) +
      kpi(tt('פער משק ← בית אריזה', 'ส่วนต่าง', 'الفرق'), signed(tot.diff) + ' ' + kg + (tot.both ? ' (' + signed(dpct, 1) + '%)' : ''), Math.abs(dpct) >= 0.5 ? 'warn' : '') +
      kpi(tt('ממתינים לקליטה', 'รอรับเข้า', 'بانتظار الاستلام'), fmt(tot.pending) + ' ' + tt('תעודות', 'ใบ', 'سندات'), tot.pending ? 'warn' : '') + '</div>';
    var bar = '<div class="sh-bar"><button class="sh-btn pri" data-a="newnote">＋ ' + tt('תעודת משלוח', 'ใบส่งใหม่', 'سند شحن جديد') + '</button>' +
      '<label class="sh-tare">⚖️ ' + tt('טרה לארגז (ק"ג)', 'น้ำหนักลัง (กก.)', 'وزن الصندوق (كغ)') + ' <input class="form-input" id="shTare" type="number" step="0.01" value="' + tareOf(ui.farm) + '"></label>' +
      '<span class="sh-mut">' + tt('כל שורה = משטח. נטו = ברוטו פחות ארגזים × טרה; הפער מחושב אוטומטית.', 'แต่ละแถว = พาเลท', 'كل صف = منصة') + '</span></div>';
    var list = ns.map(function (n) {
      var c = noteCalc(n), t = tareOf(n.farmId), op = !!ui.open[n.id];
      var dp = c.both ? c.diff / c.both * 100 : 0;
      var hd = '<div class="sh-nh" data-tog="' + n.id + '"><span class="sh-chev">' + (op ? '▾' : '▸') + '</span><b>' + tt('תעודת מגדל', 'ใบส่งเกษตรกร', 'سند المزارع') + ' ' + esc(n.growerNo || '—') + '</b>' +
        (n.type ? '<span>' + esc(n.type) + '</span>' : '') +
        '<span class="sh-mut">' + [n.harvestDate ? tt('גדיד', 'เก็บ', 'قطف') + ' ' + fmtD(n.harvestDate) : '', n.exitDate ? tt('יציאה', 'ออก', 'خروج') + ' ' + fmtD(n.exitDate) : '', n.dest || ''].filter(Boolean).join(' · ') + '</span>' +
        '<span class="sh-chip">' + c.pallets + ' ' + tt('משטחים', 'พาเลท', 'منصات') + ' · ' + fmt(c.crates) + ' ' + tt('ארגזים', 'ลัง', 'صناديق') + '</span>' +
        '<span>' + tt('נטו משק', 'สุทธิฟาร์ม', 'صافي مزرعة') + ' ' + fmt(c.netFarm) + (c.netPh ? ' · ' + tt('ב"א', 'โรงคัด', 'ب.ت') + ' ' + fmt(c.netPh) : '') + '</span>' +
        (c.both ? '<span class="sh-chip ' + (Math.abs(dp) >= 0.5 ? 'w' : 'y') + '">' + tt('פער', 'ส่วนต่าง', 'فرق') + ' ' + signed(c.diff) + ' ' + kg + '</span>' : '') +
        (c.pending ? '<span class="sh-chip y">⏳ ' + tt('ממתין לנתוני קליטה', 'รอข้อมูลรับเข้า', 'بانتظار بيانات الاستلام') + '</span>' : '<span class="sh-chip">✓ ' + tt('נקלט', 'รับแล้ว', 'استُلم') + (n.intakeNo ? ' · ' + esc(n.intakeNo) : '') + '</span>') +
        (mine(n) ? '<button class="sh-btn ghost sm" data-edit="' + n.id + '">✏️</button>' : '') + '</div>';
      if (!op) return '<div class="sh-note">' + hd + '</div>';
      var rows = (n.pallets || []).map(function (p, i) {
        var pc = palletCalc(p, t);
        return '<tr><td>' + (i + 1) + '</td><td>' + esc(p.barcode || '—') + '</td><td class="n">' + fmt(pc.crates) + '</td><td class="n">' + (num(p.grossFarm) ? fmt(p.grossFarm) : '—') + '</td><td class="n a">' + (pc.netFarm ? fmt(pc.netFarm, 1) : '—') + '</td>' +
          '<td>' + fmtD(p.weighDate) + '</td><td class="n">' + (num(p.grossPh) ? fmt(p.grossPh) : '—') + '</td><td class="n a">' + (pc.netPh ? fmt(pc.netPh, 1) : '—') + '</td><td class="n a">' + fmt(pc.tare, 1) + '</td>' +
          '<td class="n a ' + (pc.diff == null ? '' : pc.diff < 0 ? 'neg' : pc.diff > 0 ? 'pos' : '') + '">' + (pc.diff == null ? '—' : signed(pc.diff, 1)) + '</td></tr>';
      }).join('');
      return '<div class="sh-note">' + hd + '<div class="sh-tw"><table><thead><tr><th>#</th><th>' + tt('ברקוד', 'บาร์โค้ด', 'باركود') + '</th><th>' + tt('ארגזים', 'ลัง', 'صناديق') + '</th><th>' + tt('ברוטו משק', 'รวมฟาร์ม', 'إجمالي مزرعة') + '</th><th>' + tt('נטו משק', 'สุทธิฟาร์ม', 'صافي مزرعة') + '</th>' +
        '<th>' + tt('שקילה ב"א', 'ชั่งที่โรงคัด', 'وزن ب.ت') + '</th><th>' + tt('ברוטו ב"א', 'รวมโรงคัด', 'إجمالي ب.ت') + '</th><th>' + tt('נטו ב"א', 'สุทธิโรงคัด', 'صافي ب.ت') + '</th><th>' + tt('טרה', 'น้ำหนักลัง', 'الوزن الفارغ') + '</th><th>' + tt('פער ב"א−משק', 'ส่วนต่าง', 'الفرق') + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (n.note ? '<div class="sh-mut" style="padding:6px 10px;">' + esc(n.note) + '</div>' : '') +
        (window.Comments ? Comments.block('ship:' + n.id, tt('תעודת מגדל', 'ใบส่ง', 'سند') + ' ' + (n.growerNo || '')) : '') + '</div>';
    }).join('');
    return kpis + bar + (list || '<div class="sh-empty">' + tt('עוד אין תעודות משלוח למשק בעונה הזו.', 'ยังไม่มีใบส่ง', 'لا سندات شحن بعد') + '</div>');
  }
  function kpi(l, v, cls) { return '<div class="sh-k ' + (cls || '') + '"><small>' + l + '</small><b>' + v + '</b></div>'; }

  function noteForm() {
    var n = ui.edit;
    var t = tareOf(n.farmId);
    var types = [tt('יבש', 'แห้ง', 'جاف'), tt('עסיסי', 'ฉ่ำ', 'عصيري'), tt('רטוב', 'เปียก', 'رطب')];
    var rows = n.pallets.map(function (p, i) {
      var pc = palletCalc(p, t);
      return '<tr><td>' + (i + 1) + '</td>' +
        '<td><input class="form-input" data-p="' + i + '" data-k="barcode" value="' + esc(p.barcode || '') + '"></td>' +
        '<td><input class="form-input n" type="number" data-p="' + i + '" data-k="crates" value="' + esc(p.crates) + '"></td>' +
        '<td><input class="form-input n" type="number" step="any" data-p="' + i + '" data-k="grossFarm" value="' + esc(p.grossFarm || '') + '"></td>' +
        '<td class="a n" id="shNf' + i + '">' + (pc.netFarm ? fmt(pc.netFarm, 1) : '') + '</td>' +
        '<td><input class="form-input" type="date" data-p="' + i + '" data-k="weighDate" value="' + esc(p.weighDate || '') + '"></td>' +
        '<td><input class="form-input n" type="number" step="any" data-p="' + i + '" data-k="grossPh" value="' + esc(p.grossPh || '') + '"></td>' +
        '<td class="a n" id="shNp' + i + '">' + (pc.netPh ? fmt(pc.netPh, 1) : '') + '</td>' +
        '<td class="a n" id="shDf' + i + '">' + (pc.diff == null ? '' : signed(pc.diff, 1)) + '</td>' +
        '<td><button class="sh-btn ghost sm" data-delp="' + i + '" title="' + esc(tt('מחק משטח', 'ลบพาเลท', 'حذف المنصة')) + '">✕</button></td></tr>';
    }).join('');
    return '<div class="sh-form"><h3>' + (n._new ? '＋ ' + tt('תעודת משלוח חדשה', 'ใบส่งใหม่', 'سند شحن جديد') : '✏️ ' + tt('עריכת תעודת משלוח', 'แก้ไขใบส่ง', 'تعديل سند الشحن')) + ' — ' + esc(farmName(n.farmId)) + '</h3>' +
      '<div class="sh-g">' +
        fld(tt('תעודת מגדל', 'เลขใบส่งเกษตรกร', 'رقم سند المزارع'), '<input class="form-input" id="shGn" value="' + esc(n.growerNo || '') + '">') +
        fld(tt('תעודת קליטה', 'เลขใบรับเข้า', 'رقم سند الاستلام'), '<input class="form-input" id="shIn" value="' + esc(n.intakeNo || '') + '">') +
        fld(tt('סוג', 'ประเภท', 'النوع'), '<input class="form-input" id="shTy" list="shTypes" value="' + esc(n.type || '') + '"><datalist id="shTypes">' + types.map(function (x) { return '<option value="' + esc(x) + '">'; }).join('') + '</datalist>') +
        fld(tt('תאריך גדיד', 'วันที่เก็บ', 'تاريخ القطف'), '<input class="form-input" type="date" id="shHd" value="' + esc(n.harvestDate || '') + '">') +
        fld(tt('תאריך יציאה', 'วันที่ออก', 'تاريخ الخروج'), '<input class="form-input" type="date" id="shEd" value="' + esc(n.exitDate || '') + '">') +
        fld(tt('יעד / בית אריזה', 'ปลายทาง', 'الوجهة'), '<input class="form-input" id="shDs" value="' + esc(n.dest || '') + '">') +
      '</div>' +
      '<div class="sh-bar"><b>' + tt('משטחים', 'พาเลท', 'منصات') + '</b>' +
        '<button class="sh-btn" data-a="addp">＋ ' + tt('משטח', 'พาเลท', 'منصة') + '</button>' +
        '<span class="sh-mut">' + tt('הוסף', 'เพิ่ม', 'أضف') + '</span><input class="form-input sh-mini" id="shAddN" type="number" value="5" min="1" max="60">' +
        '<span class="sh-mut">' + tt('משטחים של', 'พาเลท ของ', 'منصات من') + '</span><input class="form-input sh-mini" id="shAddC" type="number" value="100">' +
        '<span class="sh-mut">' + tt('ארגזים', 'ลัง', 'صناديق') + '</span><button class="sh-btn" data-a="addmany">＋</button>' +
        '<span class="sh-mut">· ' + tt('טרה', 'น้ำหนักลัง', 'الوزن الفارغ') + ' ' + t + ' ' + tt('ק"ג לארגז', 'กก./ลัง', 'كغ/صندوق') + '</span></div>' +
      '<div class="sh-tw"><table class="sh-edit"><thead><tr><th>#</th><th>' + tt('ברקוד', 'บาร์โค้ด', 'باركود') + '</th><th>' + tt('ארגזים', 'ลัง', 'صناديق') + '</th><th>' + tt('ברוטו משק', 'รวมฟาร์ม', 'إجمالي مزرعة') + '</th><th>' + tt('נטו משק', 'สุทธิฟาร์ม', 'صافي مزرعة') + '</th><th>' + tt('תאריך שקילה ב"א', 'วันที่ชั่งโรงคัด', 'تاريخ الوزن ب.ت') + '</th><th>' + tt('ברוטו ב"א', 'รวมโรงคัด', 'إجمالي ب.ت') + '</th><th>' + tt('נטו ב"א', 'สุทธิโรงคัด', 'صافي ب.ت') + '</th><th>' + tt('פער', 'ส่วนต่าง', 'الفرق') + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
      fld(tt('הערה', 'หมายเหตุ', 'ملاحظة'), '<input class="form-input" id="shNo" value="' + esc(n.note || '') + '">') +
      '<div class="sh-bar"><button class="sh-btn pri" data-a="savenote">💾 ' + tt('שמור תעודה', 'บันทึกใบส่ง', 'حفظ السند') + '</button>' +
        (!n._new ? '<button class="sh-btn warn" data-a="delnote">🗑 ' + tt('מחק', 'ลบ', 'حذف') + '</button>' : '') +
        '<button class="sh-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
  }
  function fld(l, inner) { return '<label class="sh-f"><small>' + l + '</small>' + inner + '</label>'; }
  function readNote() {
    var n = ui.edit; if (!n) return;
    function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
    if (!document.getElementById('shGn')) return;
    n.growerNo = v('shGn').trim(); n.intakeNo = v('shIn').trim(); n.type = v('shTy').trim();
    n.harvestDate = v('shHd'); n.exitDate = v('shEd'); n.dest = v('shDs').trim(); n.note = v('shNo').trim();
  }

  // ── 2. crates ──
  function crateMoves() {
    var fid = ui.farm, out = [];
    ((D && D.crates) || []).forEach(function (c) { if (String(c.farmId) === fid) out.push({ id: c.id, date: c.date, kind: c.kind, qty: c.kind === 'in' ? num(c.qty) : -num(c.qty), pallets: c.pallets, type: c.type, note: c.note, src: c }); });
    farmNotes().forEach(function (n) {
      var cr = noteCalc(n).crates;
      if (cr) out.push({ date: n.exitDate || n.harvestDate || '', kind: 'ship', qty: -cr, pallets: (n.pallets || []).length, type: n.type, note: tt('תעודה', 'ใบส่ง', 'سند') + ' ' + (n.growerNo || '') });
    });
    out.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || (b.qty - a.qty); });
    var bal = 0; out.forEach(function (m) { bal += m.qty; m.bal = bal; });
    return out;
  }
  function cratesView() {
    var ms = crateMoves(), inQ = 0, shipQ = 0, outQ = 0, pal = 0;
    ms.forEach(function (m) { if (m.kind === 'in') { inQ += m.qty; pal += num(m.pallets); } else if (m.kind === 'ship') shipQ -= m.qty; else outQ -= m.qty; });
    var bal = ms.length ? ms[ms.length - 1].bal : 0, low = num((D.low || {})[ui.farm]) || 500;
    var kpis = '<div class="sh-kpis">' + kpi(tt('ארגזים ריקים שהגיעו', 'ลังเปล่าที่มาถึง', 'صناديق فارغة وصلت'), fmt(inQ)) + kpi(tt('יצאו מלאים עם פרי', 'ออกพร้อมผลผลิต', 'خرجت ممتلئة'), fmt(shipQ)) +
      kpi(tt('הוחזרו / יצאו ריקים', 'ส่งคืนเปล่า', 'أُعيدت فارغة'), fmt(outQ)) + kpi(tt('יתרה במשק (מחושב)', 'คงเหลือที่ฟาร์ม', 'الرصيد في المزرعة'), signed(bal), bal < low ? 'warn' : 'ok') +
      kpi(tt('משטחים שהגיעו', 'พาเลทที่มาถึง', 'منصات وصلت'), fmt(pal)) +
      '<div class="sh-k"><small>' + tt('התראה מתחת ל־', 'เตือนเมื่อต่ำกว่า', 'تنبيه تحت') + '</small><input class="form-input sh-mini" id="shLow" type="number" value="' + low + '"></div></div>';
    var cf = ui.crateForm;
    var form = cf ? '<div class="sh-form sh-g" style="margin-bottom:8px;">' +
      fld(tt('תאריך', 'วันที่', 'التاريخ'), '<input class="form-input" type="date" id="shCd" value="' + esc(cf.date || today()) + '">') +
      fld(tt('תנועה', 'การเคลื่อนไหว', 'الحركة'), '<select class="form-input" id="shCk"><option value="in"' + (cf.kind === 'in' ? ' selected' : '') + '>⬇ ' + tt('כניסת ארגזים ריקים', 'ลังเปล่าเข้า', 'دخول صناديق فارغة') + '</option><option value="out"' + (cf.kind === 'out' ? ' selected' : '') + '>↩ ' + tt('יציאת ארגזים ריקים', 'ลังเปล่าออก', 'خروج صناديق فارغة') + '</option></select>') +
      fld(tt('ארגזים', 'ลัง', 'صناديق'), '<input class="form-input" type="number" id="shCq" value="' + esc(cf.qty || '') + '">') +
      fld(tt('משטחים', 'พาเลท', 'منصات'), '<input class="form-input" type="number" id="shCp" value="' + esc(cf.pallets || '') + '">') +
      fld(tt('סוג', 'ประเภท', 'النوع'), '<input class="form-input" id="shCt" list="shTypes2" value="' + esc(cf.type || '') + '"><datalist id="shTypes2"><option value="' + esc(tt('יבש', 'แห้ง', 'جاف')) + '"><option value="' + esc(tt('עסיסי', 'ฉ่ำ', 'عصيري')) + '"></datalist>') +
      fld(tt('הערה', 'หมายเหตุ', 'ملاحظة'), '<input class="form-input" id="shCn" value="' + esc(cf.note || '') + '">') +
      '<div class="sh-bar" style="grid-column:1/-1;"><button class="sh-btn pri" data-a="savecrate">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      (cf.id ? '<button class="sh-btn warn" data-a="delcrate">🗑 ' + tt('מחק', 'ลบ', 'حذف') + '</button>' : '') +
      '<button class="sh-btn ghost" data-a="cancelcrate">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>' : '';
    var bar = '<div class="sh-bar"><button class="sh-btn pri" data-a="cratein">＋ ' + tt('כניסת ארגזים', 'ลังเข้า', 'دخول صناديق') + '</button><button class="sh-btn" data-a="crateout">↩ ' + tt('יציאת ארגזים ריקים', 'ลังเปล่าออก', 'خروج صناديق فارغة') + '</button>' +
      '<span class="sh-mut">' + tt('ארגזים שיצאו עם פרי נספרים אוטומטית מתעודות המשלוח', 'ลังที่ออกพร้อมผลผลิตนับจากใบส่ง', 'الصناديق التي خرجت مع الثمار تُحسب من سندات الشحن') + '</span></div>';
    var kindL = { 'in': '⬇ ' + tt('כניסה', 'เข้า', 'دخول'), out: '↩ ' + tt('יצאו ריקים', 'ออกเปล่า', 'خرجت فارغة'), ship: '🚚 ' + tt('יצאו עם פרי', 'ออกพร้อมผลผลิต', 'خرجت مع الثمار') };
    var table = '<div class="sh-g2"><div class="sh-card"><h3>' + tt('תנועות ארגזים', 'การเคลื่อนไหวของลัง', 'حركات الصناديق') + '</h3><div class="sh-tw"><table><thead><tr><th>' + tt('תאריך', 'วันที่', 'التاريخ') + '</th><th>' + tt('תנועה', 'การเคลื่อนไหว', 'الحركة') + '</th><th>' + tt('ארגזים', 'ลัง', 'صناديق') + '</th><th>' + tt('משטחים', 'พาเลท', 'منصات') + '</th><th>' + tt('סוג', 'ประเภท', 'النوع') + '</th><th>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</th><th>' + tt('יתרה', 'คงเหลือ', 'الرصيد') + '</th><th></th></tr></thead><tbody>' +
      (ms.length ? ms.slice().reverse().map(function (m) {
        return '<tr><td>' + fmtD(m.date) + '</td><td>' + kindL[m.kind] + '</td><td class="n ' + (m.qty < 0 ? 'neg' : '') + '">' + signed(m.qty) + '</td><td class="n">' + (m.pallets ? fmt(m.pallets) : '') + '</td><td>' + esc(m.type || '') + '</td><td>' + esc(m.note || '') + '</td><td class="n"><b>' + signed(m.bal) + '</b></td>' +
          '<td>' + (m.src && mine(m.src) ? '<button class="sh-btn ghost sm" data-crate="' + m.id + '">✏️</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="8" class="sh-mut">' + tt('אין תנועות', 'ไม่มีรายการ', 'لا حركات') + '</td></tr>') + '</tbody></table></div></div>' +
      '<div class="sh-card"><h3>' + tt('יתרת ארגזים לאורך העונה', 'ยอดลังตลอดฤดูกาล', 'رصيد الصناديق خلال الموسم') + '</h3>' + balChart(ms, low) +
      '<div class="sh-mut">' + tt('קו מקווקו = סף ההתראה', 'เส้นประ = เกณฑ์เตือน', 'الخط المتقطع = حد التنبيه') + '</div></div></div>';
    return kpis + bar + form + table;
  }
  function balChart(ms, low) {
    if (ms.length < 2) return '<div class="sh-mut" style="padding:20px 0;">' + tt('צריך לפחות שתי תנועות לגרף', 'ต้องมีอย่างน้อยสองรายการ', 'يلزم حركتان على الأقل') + '</div>';
    var W = 440, H = 200, L = 46, B = 26, T = 10;
    var t0 = Date.parse(ms[0].date || today()), t1 = Date.parse(ms[ms.length - 1].date || today()); if (!(t1 > t0)) t1 = t0 + 864e5;
    var vals = ms.map(function (m) { return m.bal; }).concat([low, 0]);
    var mx = Math.max.apply(null, vals), mn = Math.min.apply(null, vals); if (mx === mn) mx = mn + 1;
    function X(d) { return L + (Date.parse(d || today()) - t0) / (t1 - t0) * (W - L - 8); }
    function Y(v) { return T + (1 - (v - mn) / (mx - mn)) * (H - T - B); }
    var pts = ms.map(function (m) { return X(m.date).toFixed(1) + ',' + Y(m.bal).toFixed(1); }).join(' ');
    return '<svg style="direction:ltr;width:100%;height:auto;" viewBox="0 0 ' + W + ' ' + H + '">' +
      '<line x1="' + L + '" x2="' + (W - 8) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '" stroke="#c9cfc4"/>' +
      '<line x1="' + L + '" x2="' + (W - 8) + '" y1="' + Y(low).toFixed(1) + '" y2="' + Y(low).toFixed(1) + '" stroke="#ef8a17" stroke-dasharray="5 4"/>' +
      '<polyline fill="none" stroke="#1d5a2c" stroke-width="2.5" points="' + pts + '"/>' +
      '<text x="' + (L - 6) + '" y="' + (Y(mx) + 4).toFixed(1) + '" font-size="10" fill="#6f7b72" text-anchor="end">' + fmt(mx) + '</text>' +
      '<text x="' + (L - 6) + '" y="' + (Y(mn) + 4).toFixed(1) + '" font-size="10" fill="#6f7b72" text-anchor="end">' + fmt(mn) + '</text>' +
      '<text x="' + L + '" y="' + (H - 6) + '" font-size="10" fill="#6f7b72">' + esc(fmtD(ms[0].date)) + '</text>' +
      '<text x="' + (W - 8) + '" y="' + (H - 6) + '" font-size="10" fill="#6f7b72" text-anchor="end">' + esc(fmtD(ms[ms.length - 1].date)) + '</text></svg>';
  }

  // ── 3. cash flow from a sorting report ──
  function reports() { return ((HVD && HVD.reports) || []).filter(function (r) { return String(r.farmId) === ui.farm; }); }
  function prevPrice(code) {
    var hit = 0;
    ((PREV && PREV.reports) || []).forEach(function (r) { if (String(r.farmId) !== ui.farm) return; (r.fractions || []).forEach(function (f) { if (f.code === code && num(f.price) > 0) hit = num(f.price); }); });
    return hit;
  }
  function isPremium(f) { return f.type === 'export' && !/SUP|SELECT/i.test(String(f.code || '')); }
  function finOf(rid) {
    var f = (D.fin && D.fin[rid]) || {};
    return { prices: f.prices || {}, sortMode: f.sortMode || 'total', sortRate: f.sortRate || '', sortTotal: f.sortTotal || '', basisNet: f.basisNet || '', basisVat: f.basisVat !== false,
      pct: f.pct != null && f.pct !== '' ? f.pct : 90, pctMonth: f.pctMonth || (season + 1) + '-08', finalMonth: f.finalMonth || (season + 1) + '-12', receipts: Array.isArray(f.receipts) ? f.receipts : [],
      createdBy: f.createdBy, createdByName: f.createdByName, createdAt: f.createdAt };
  }
  function finCalc(r, F) {
    var rows = (r.fractions || []).filter(function (f) { return num(f.kg) > 0 || f.code; }).map(function (f) {
      var pr = F.prices[f.code] || {}, base = pr.price !== undefined && pr.price !== '' ? num(pr.price) : (num(f.price) || prevPrice(f.code));
      var ch = num(pr.change), use = base + ch, kgv = num(f.kg);
      return { code: f.code || f.name || '—', type: f.type, kg: kgv, base: base, change: pr.change || '', price: use, total: kgv * use, premium: isPremium(f) };
    });
    var kg = rows.reduce(function (a, x) { return a + x.kg; }, 0), value = rows.reduce(function (a, x) { return a + x.total; }, 0);
    rows.forEach(function (x) { x.share = kg ? x.kg / kg * 100 : 0; });
    var prem = rows.reduce(function (a, x) { return a + (x.premium ? x.share : 0); }, 0);
    var sort = F.sortMode === 'rate' ? num(F.sortRate) * kg : num(F.sortTotal);
    var basisNet = F.basisNet !== '' ? num(F.basisNet) : value, basis = F.basisVat ? basisNet * (1 + VAT) : basisNet;
    var ledger = 0, newS = 0;
    F.receipts.forEach(function (x) { if (x.newSeason) newS += num(x.amount); else ledger += num(x.amount); });
    var p = num(F.pct) / 100;
    var due = p * basis - ledger, fin = (1 - p) * basis;
    return { rows: rows, kg: kg, value: value, avg: kg ? value / kg : 0, prem: prem, sort: sort, net: value - sort, basisNet: basisNet, basis: basis, ledger: ledger, newS: newS, due: due, fin: fin, remain: due + fin };
  }
  function finView() {
    var rs = reports();
    if (!rs.length) return '<div class="sh-empty">' + tt('אין דוח תוצאות מיון למשק בעונה הזו. צור דוח בתוצאות המיון של המשק, ואז חזור לכאן.', 'ยังไม่มีรายงานผลคัดแยก', 'لا تقرير فرز لهذه المزرعة في هذا الموسم') +
      (window.HarvestResults && HarvestResults.openFarm ? '<br><button class="sh-btn pri" data-a="openhv" style="margin-top:10px;">📦 ' + tt('לתוצאות המיון של המשק', 'ไปที่ผลคัดแยก', 'إلى نتائج الفرز') + '</button>' : '') + '</div>';
    if (!rs.some(function (r) { return r.id === ui.rep; })) ui.rep = rs[0].id;
    var r = rs.find(function (x) { return x.id === ui.rep; }), F = finOf(r.id), C = finCalc(r, F), can = mine(F);
    var dis = can ? '' : ' disabled';
    var sel = '<div class="sh-bar"><select class="form-input sh-s" id="shRep">' + rs.map(function (x) {
      var t = (x.fractions || []).reduce(function (a, f) { return a + num(f.kg); }, 0);
      return '<option value="' + esc(x.id) + '"' + (x.id === r.id ? ' selected' : '') + '>' + esc((x.variety || '') + ' · ' + fmtD(x.date) + ' · ' + fmt(t) + ' ' + tt('ק"ג', 'กก.', 'كغ')) + '</option>'; }).join('') + '</select>' +
      '<span class="sh-mut">' + tt('הכמויות מדוח המיון; מחיר ושינוי צפוי ניתנים לעריכה. מחיר ריק נלקח מהדוח או מהעונה הקודמת.', 'ปริมาณจากรายงาน', 'الكميات من تقرير الفرز') + '</span></div>';
    var frac = '<div class="sh-card"><h3>' + tt('שווי לפי פרקציות', 'มูลค่าตามเกรด', 'القيمة حسب الفئات') + '</h3><div class="sh-tw"><table><thead><tr><th>' + tt('פרקציה', 'เกรด', 'الفئة') + '</th><th>' + tt('ק"ג', 'กก.', 'كغ') + '</th><th>' + tt('נפח', 'สัดส่วน', 'النسبة') + '</th><th>' + tt('מחיר', 'ราคา', 'السعر') + '</th><th>' + tt('צפי שינוי ₪/ק"ג', 'เปลี่ยนแปลงคาด ₪/กก.', 'التغيير المتوقع') + '</th><th>' + tt('מחיר לחישוב', 'ราคาที่ใช้', 'السعر المعتمد') + '</th><th>' + tt('סה"כ ₪', 'รวม ₪', 'المجموع ₪') + '</th></tr></thead><tbody>' +
      C.rows.map(function (x) {
        return '<tr><td><b>' + esc(x.code) + '</b>' + (x.premium ? ' <span class="sh-chip">★</span>' : '') + '</td><td class="n">' + fmt(x.kg, 1) + '</td><td class="n">' + fmt(x.share, 2) + '%</td>' +
          '<td><input class="form-input sh-mini" type="number" step="any" data-fp="' + esc(x.code) + '" data-k="price" value="' + (x.base || '') + '"' + dis + '></td>' +
          '<td><input class="form-input sh-mini" type="number" step="any" data-fp="' + esc(x.code) + '" data-k="change" value="' + esc(x.change) + '"' + dis + '></td>' +
          '<td class="n">' + fmt(x.price, 2) + '</td><td class="n"><b>' + fmt(x.total) + '</b></td></tr>';
      }).join('') +
      '<tr class="tot"><td>' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td class="n">' + fmt(C.kg, 1) + '</td><td>100%</td><td></td><td></td><td class="n">₪' + fmt(C.avg, 2) + '/' + tt('ק"ג', 'กก.', 'كغ') + '</td><td class="n">' + fmt(C.value) + '</td></tr></tbody></table></div>' +
      '<div class="sh-mut" style="margin-top:6px;">★ ' + tt('אחוז פרימיום', 'สัดส่วนพรีเมียม', 'نسبة البريميوم') + ': <b>' + fmt(C.prem, 2) + '%</b> (' + tt('יצוא ללא SUP ו־SELECTED', 'ส่งออกไม่รวม SUP/SELECTED', 'تصدير بدون SUP/SELECTED') + ')</div></div>';
    var rec = '<div class="sh-card"><h3>' + tt('תקבולים ומקדמות', 'การรับเงินและเงินล่วงหน้า', 'المقبوضات والسلف') + '</h3><div class="sh-tw"><table><thead><tr><th>' + tt('תאריך', 'วันที่', 'التاريخ') + '</th><th>' + tt('סוג', 'ประเภท', 'النوع') + '</th><th>' + tt('סכום (כולל מע"מ)', 'จำนวน (รวมภาษี)', 'المبلغ (شامل الضريبة)') + '</th><th>' + tt('מתוך זה מע"מ', 'ภาษีในยอด', 'منها ضريبة') + '</th><th>' + tt('עונה חדשה', 'ฤดูใหม่', 'موسم جديد') + '</th><th></th></tr></thead><tbody>' +
      F.receipts.slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); }).map(function (x) {
        var vat = x.type === 'sorting' ? num(x.amount) * VAT / (1 + VAT) : 0;
        return '<tr' + (x.newSeason ? ' class="dim"' : '') + '><td><input class="form-input" type="date" data-rc="' + x.id + '" data-k="date" value="' + esc(x.date || '') + '"' + dis + '></td>' +
          '<td><select class="form-input" data-rc="' + x.id + '" data-k="type"' + dis + '>' + [['advance', tt('מקדמה', 'เงินล่วงหน้า', 'سلفة')], ['sorting', tt('מיון', 'คัดแยก', 'فرز')], ['other', tt('אחר', 'อื่น', 'أخرى')]].map(function (o) { return '<option value="' + o[0] + '"' + (x.type === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select></td>' +
          '<td><input class="form-input sh-num" type="number" step="any" data-rc="' + x.id + '" data-k="amount" value="' + esc(x.amount || '') + '"' + dis + '></td>' +
          '<td class="n">' + (vat ? fmt(vat, 2) : '') + '</td>' +
          '<td><input type="checkbox" data-rc="' + x.id + '" data-k="newSeason"' + (x.newSeason ? ' checked' : '') + dis + '></td>' +
          '<td>' + (can ? '<button class="sh-btn ghost sm" data-delrc="' + x.id + '">✕</button>' : '') + '</td></tr>';
      }).join('') +
      '<tr class="tot"><td colspan="2">' + tt('התקבל (כרטסת)', 'ได้รับแล้ว', 'المقبوض (الكشف)') + '</td><td class="n">' + fmt(C.ledger) + '</td><td colspan="3" class="sh-mut">' + (C.newS ? tt('לא כולל מקדמות לעונה חדשה', 'ไม่รวมเงินล่วงหน้าฤดูใหม่', 'بدون سلف الموسم الجديد') + ': ' + fmt(C.newS) : '') + '</td></tr></tbody></table></div>' +
      (can ? '<div class="sh-bar"><button class="sh-btn" data-a="addrc">＋ ' + tt('תקבול', 'การรับเงิน', 'مقبوض') + '</button><span class="sh-mut">' + tt('מע"מ 18% מחושב מתוך תקבולי מיון', 'ภาษี 18% จากการคัดแยก', 'ضريبة 18% من مقبوضات الفرز') + '</span></div>' : '') + '</div>';
    var set = '<div class="sh-card"><h3>' + tt('חשבון התזרים', 'การคำนวณกระแสเงิน', 'حساب التدفق') + '</h3><div class="sh-g">' +
      fld(tt('עלות מיון', 'ค่าคัดแยก', 'تكلفة الفرز'), '<select class="form-input" data-fs="sortMode"' + dis + '><option value="total"' + (F.sortMode === 'total' ? ' selected' : '') + '>' + tt('סכום כולל ₪', 'ยอดรวม ₪', 'مبلغ إجمالي') + '</option><option value="rate"' + (F.sortMode === 'rate' ? ' selected' : '') + '>' + tt('₪ לק"ג', '₪/กก.', '₪/كغ') + '</option></select>') +
      fld(F.sortMode === 'rate' ? tt('₪ לק"ג', '₪/กก.', '₪/كغ') : tt('סכום ₪', 'ยอด ₪', 'المبلغ'), '<input class="form-input" type="number" step="any" data-fs="' + (F.sortMode === 'rate' ? 'sortRate' : 'sortTotal') + '" value="' + esc(F.sortMode === 'rate' ? F.sortRate : F.sortTotal) + '"' + dis + '>') +
      fld(tt('בסיס התקבולים לפני מע"מ', 'ฐานก่อนภาษี', 'الأساس قبل الضريبة'), '<input class="form-input" type="number" step="any" data-fs="basisNet" placeholder="' + fmt(C.value) + '" value="' + esc(F.basisNet) + '"' + dis + '>') +
      fld(tt('להוסיף מע"מ 18% לבסיס', 'บวกภาษี 18%', 'إضافة ضريبة 18%'), '<input type="checkbox" data-fs="basisVat"' + (F.basisVat ? ' checked' : '') + dis + '>') +
      fld(tt('אחוז עד אבן הדרך', 'ร้อยละถึงงวด', 'النسبة حتى المرحلة'), '<input class="form-input" type="number" step="any" data-fs="pct" value="' + esc(F.pct) + '"' + dis + '>') +
      fld(tt('חודש אבן הדרך', 'เดือนงวด', 'شهر المرحلة'), '<input class="form-input" type="month" data-fs="pctMonth" value="' + esc(F.pctMonth) + '"' + dis + '>') +
      fld(tt('חודש גמר חשבון', 'เดือนปิดบัญชี', 'شهر التسوية'), '<input class="form-input" type="month" data-fs="finalMonth" value="' + esc(F.finalMonth) + '"' + dis + '>') +
      '</div>' +
      '<div class="sh-flow">' +
        fbox(tt('שווי הפרי לפי המיון', 'มูลค่าตามคัดแยก', 'قيمة الثمار حسب الفرز'), money(C.value), '₪' + fmt(C.avg, 2) + ' ' + tt('לק"ג בממוצע', 'ต่อกก. เฉลี่ย', 'للكغ بالمتوسط')) +
        fbox(tt('עלות מיון', 'ค่าคัดแยก', 'تكلفة الفرز'), '−' + money(C.sort), C.kg && C.sort ? '₪' + fmt(C.sort / C.kg, 2) + ' ' + tt('לק"ג', 'ต่อกก.', 'للكغ') : '', 'r') +
        fbox(tt('סה"כ צפוי לאחר קיזוז עלות מיון', 'คาดหลังหักค่าคัดแยก', 'المتوقع بعد خصم الفرز'), money(C.net), '') +
        fbox(tt('בסיס התקבולים (צפי תקבולים)', 'ฐานการรับเงิน', 'أساس المقبوضات'), money(C.basis), F.basisVat ? fmt(C.basisNet) + ' + ' + tt('מע"מ', 'ภาษี', 'ضريبة') + ' 18%' : '') +
      '</div><div class="sh-flow">' +
        fbox(tt('התקבל עד היום (כרטסת)', 'ได้รับถึงวันนี้', 'المقبوض حتى اليوم'), money(C.ledger), '', 'r') +
        fbox(tt('צפי להתקבל עד', 'คาดว่าจะได้รับถึง', 'المتوقع حتى') + ' ' + fmt(F.pct) + '% (' + esc(F.pctMonth) + ')', signed(C.due) + ' ₪', fmt(F.pct) + '% × ' + tt('בסיס', 'ฐาน', 'الأساس') + ' − ' + tt('התקבל', 'ได้รับ', 'المقبوض')) +
        fbox(tt('צפי בגמר חשבון', 'คาดเมื่อปิดบัญชี', 'المتوقع عند التسوية') + ' (' + fmt(100 - num(F.pct)) + '%)', money(C.fin), esc(F.finalMonth)) +
        fbox(tt('סה"כ צפוי להתקבל עוד', 'รวมที่คาดว่าจะได้รับ', 'إجمالي المتوقع'), signed(C.remain) + ' ₪', '', 'g') +
      '</div>' +
      (can ? '<div class="sh-bar"><button class="sh-btn pri" data-a="tocf">⇢ ' + tt('הוסף לתזרים כהכנסה מתוכננת', 'เพิ่มในกระแสเงินเป็นรายได้ตามแผน', 'أضف إلى التدفق كدخل مخطط') + '</button>' +
        '<span class="sh-mut">' + tt('רושם במסך התזרים של המשק את הצפי לאבן הדרך (אם חיובי) ואת גמר החשבון, בחודשים שלהם. רישום חוזר מחליף את הקודם.', 'บันทึกในกระแสเงินของฟาร์ม', 'يُسجل في تدفق المزرعة') + '</span></div>' : '') +
      '</div>';
    return sel + '<div class="sh-g2">' + frac + rec + '</div>' + set;
  }
  function fbox(l, v, sub, cls) { return '<div class="sh-fs ' + (cls || '') + '"><small>' + l + '</small><b>' + v + '</b>' + (sub ? '<span>' + sub + '</span>' : '') + '</div>'; }
  function finSave(fn) {
    var rid = ui.rep;
    return commit(function (b) {
      var cur = b.fin[rid];
      if (cur && window.Own && !Own.canEdit(cur)) { Own.denied(); return false; }
      var F = finOf.call(null, rid); // shape defaults from screen copy
      F = JSON.parse(JSON.stringify(cur || {}));
      if (!cur && window.Own) Own.stamp(F);
      fn(F);
      b.fin[rid] = F;
    });
  }
  function toCashflow() {
    var r = reports().find(function (x) { return x.id === ui.rep; });
    if (!r) return;
    var F = finOf(r.id), C = finCalc(r, F), fid = Number(ui.farm);
    var parts = [];
    if (C.due > 0) parts.push({ ym: F.pctMonth, amount: Math.round(C.due), note: tt('צפי תקבול מהמיון עד', 'คาดรับถึง', 'مقبوض متوقع حتى') + ' ' + fmt(F.pct) + '% · ' + (r.variety || '') });
    if (C.fin > 0) parts.push({ ym: F.finalMonth, amount: Math.round(C.fin), note: tt('גמר חשבון מיון', 'ปิดบัญชีคัดแยก', 'تسوية الفرز') + ' · ' + (r.variety || '') });
    if (!parts.length) { toast('ℹ️ ' + tt('אין סכום צפוי להוספה', 'ไม่มียอดคาด', 'لا مبلغ متوقع')); return; }
    var byYear = {};
    parts.forEach(function (x) { var y = String(x.ym).slice(0, 4); (byYear[y] = byYear[y] || []).push(x); });
    var u = window.currentUser || {}, src = 'ship:' + r.id;
    Promise.all(Object.keys(byYear).map(function (y) {
      return DB.read(CF + y).then(function (res) {
        if (!res.ok && !res.data) throw new Error('read');
        var d = (res.data && typeof res.data === 'object') ? res.data : {};
        d.entries = (Array.isArray(d.entries) ? d.entries : []).filter(function (e) { return e.src !== src; });
        d.opening = d.opening || {};
        byYear[y].forEach(function (x, k) {
          d.entries.push({ id: Date.now() + k, farmId: fid, m: Number(String(x.ym).slice(5, 7)) - 1, cat: 'sales', kind: 'plan', amount: x.amount, note: x.note, by: u.name || u.username || '', at: Date.now(), src: src });
        });
        var clean = JSON.parse(JSON.stringify(d));
        return DB.saveAsync ? DB.saveAsync(CF + y, clean) : (DB.save(CF + y, clean), Promise.resolve());
      });
    })).then(function () { toast('✅ ' + tt('נוסף לתזרים של המשק', 'เพิ่มในกระแสเงินแล้ว', 'أُضيف إلى التدفق')); },
      function () { toast('❌ ' + tt('לא נוסף לתזרים — בדוק חיבור והרשאה', 'เพิ่มไม่สำเร็จ', 'لم يُضف إلى التدفق')); });
  }

  // ── events ──
  function onInput(e) {
    var t = e.target;
    if (t.hasAttribute('data-p') && ui.edit) {
      var i = Number(t.getAttribute('data-p')), k = t.getAttribute('data-k'), p = ui.edit.pallets[i];
      if (!p) return;
      p[k] = t.value;
      var pc = palletCalc(p, tareOf(ui.edit.farmId));
      var a = document.getElementById('shNf' + i), b = document.getElementById('shNp' + i), c = document.getElementById('shDf' + i);
      if (a) a.textContent = pc.netFarm ? fmt(pc.netFarm, 1) : '';
      if (b) b.textContent = pc.netPh ? fmt(pc.netPh, 1) : '';
      if (c) c.innerHTML = pc.diff == null ? '' : signed(pc.diff, 1);
    }
  }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'shSeason') { season = Number(t.value); ui.edit = null; return load().then(render); }
    if (t.id === 'shFarm') { ui.farm = t.value; ui.edit = null; ui.crateForm = null; return render(); }
    if (t.id === 'shRep') { ui.rep = t.value; return render(); }
    if (t.id === 'shTare') { var v = num(t.value); return commit(function (b) { b.tare[ui.farm] = v; }).then(render); }
    if (t.id === 'shLow') { var lv = num(t.value); return commit(function (b) { b.low[ui.farm] = lv; }).then(render); }
    if (t.hasAttribute('data-fp')) {
      var code = t.getAttribute('data-fp'), k = t.getAttribute('data-k'), val = t.value;
      return finSave(function (F) { F.prices = F.prices || {}; F.prices[code] = F.prices[code] || {}; F.prices[code][k] = val; }).then(render);
    }
    if (t.hasAttribute('data-fs')) {
      var fk = t.getAttribute('data-fs'), fv = t.type === 'checkbox' ? t.checked : t.value;
      return finSave(function (F) { F[fk] = fv; }).then(render);
    }
    if (t.hasAttribute('data-rc')) {
      var id = t.getAttribute('data-rc'), rk = t.getAttribute('data-k'), rv = t.type === 'checkbox' ? t.checked : t.value;
      return finSave(function (F) { (F.receipts || []).forEach(function (x) { if (String(x.id) === id) x[rk] = rk === 'amount' ? num(rv) : rv; }); }).then(render);
    }
  }
  function onClick(e) {
    var t = e.target;
    var tb = t.closest('[data-tab]'); if (tb) { ui.tab = tb.getAttribute('data-tab'); ui.edit = null; return render(); }
    var tg = t.closest('[data-tog]');
    var ed = t.closest('[data-edit]');
    if (ed) { e.stopPropagation(); var n = D.notes.find(function (x) { return String(x.id) === ed.getAttribute('data-edit'); }); if (n) { if (!mine(n)) return Own.denied(); ui.edit = JSON.parse(JSON.stringify(n)); render(); } return; }
    if (tg) { var id = tg.getAttribute('data-tog'); ui.open[id] = !ui.open[id]; return render(); }
    var dp = t.closest('[data-delp]'); if (dp) { readNote(); ui.edit.pallets.splice(Number(dp.getAttribute('data-delp')), 1); return render(); }
    var cr = t.closest('[data-crate]'); if (cr) { var c = D.crates.find(function (x) { return String(x.id) === cr.getAttribute('data-crate'); }); if (c) { ui.crateForm = JSON.parse(JSON.stringify(c)); render(); } return; }
    var drc = t.closest('[data-delrc]'); if (drc) { var rid = drc.getAttribute('data-delrc'); return finSave(function (F) { F.receipts = (F.receipts || []).filter(function (x) { return String(x.id) !== rid; }); }).then(render); }
    var a = t.closest('[data-a]'); if (!a) return;
    var k = a.getAttribute('data-a');
    if (k === 'close') return close();
    if (k === 'back') { ui.edit = null; return render(); }
    if (k === 'newnote') { ui.edit = { _new: true, id: uid(), farmId: Number(ui.farm), growerNo: '', intakeNo: '', type: tt('יבש', 'แห้ง', 'جاف'), harvestDate: today(), exitDate: today(), dest: '', note: '', pallets: [] }; return render(); }
    if (k === 'addp') { readNote(); var last = ui.edit.pallets[ui.edit.pallets.length - 1]; ui.edit.pallets.push({ id: uid(), barcode: '', crates: last ? last.crates : 100, grossFarm: '', weighDate: last ? last.weighDate : '', grossPh: '' }); return render(); }
    if (k === 'addmany') {
      readNote();
      var nn = Math.max(1, Math.min(60, num((document.getElementById('shAddN') || {}).value) || 1)), cc = num((document.getElementById('shAddC') || {}).value) || 100;
      for (var q = 0; q < nn; q++) ui.edit.pallets.push({ id: uid() + q, barcode: '', crates: cc, grossFarm: '', weighDate: '', grossPh: '' });
      return render();
    }
    if (k === 'savenote') {
      readNote();
      var nt = ui.edit; delete nt._new;
      if (!nt.growerNo) { toast('⚠️ ' + tt('חסר מספר תעודת מגדל', 'ขาดเลขใบส่ง', 'رقم السند ناقص')); return; }
      nt.pallets = nt.pallets.map(function (p) { return { id: p.id, barcode: String(p.barcode || '').trim(), crates: num(p.crates), grossFarm: num(p.grossFarm) || '', weighDate: p.weighDate || '', grossPh: num(p.grossPh) || '' }; });
      return commit(function (b) {
        var i = b.notes.findIndex(function (x) { return String(x.id) === String(nt.id); });
        if (i !== -1 && !mine(b.notes[i])) { Own.denied(); return false; }
        if (i === -1) { if (window.Own) Own.stamp(nt); b.notes.push(nt); } else b.notes[i] = Object.assign({}, b.notes[i], nt);
      }).then(function (ok) { if (ok) { toast('✅ ' + tt('התעודה נשמרה', 'บันทึกแล้ว', 'حُفظ السند')); ui.open[nt.id] = true; ui.edit = null; render(); } });
    }
    if (k === 'delnote') {
      var dn = ui.edit;
      if (!confirm(tt('למחוק את תעודת המשלוח?', 'ลบใบส่ง?', 'حذف سند الشحن؟'))) return;
      return commit(function (b) { b.notes = b.notes.filter(function (x) { return String(x.id) !== String(dn.id); }); }).then(function () { ui.edit = null; render(); });
    }
    if (k === 'cratein' || k === 'crateout') { ui.crateForm = { kind: k === 'cratein' ? 'in' : 'out', date: today() }; return render(); }
    if (k === 'cancelcrate') { ui.crateForm = null; return render(); }
    if (k === 'savecrate' || k === 'delcrate') {
      var f = ui.crateForm;
      function g(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      if (k === 'savecrate') {
        f.date = g('shCd'); f.kind = g('shCk'); f.qty = num(g('shCq')); f.pallets = num(g('shCp')) || ''; f.type = g('shCt').trim(); f.note = g('shCn').trim(); f.farmId = Number(ui.farm);
        if (!f.qty) { toast('⚠️ ' + tt('חסרה כמות', 'ขาดจำนวน', 'الكمية ناقصة')); return; }
      } else if (!confirm(tt('למחוק את התנועה?', 'ลบรายการ?', 'حذف الحركة؟'))) return;
      return commit(function (b) {
        var i = f.id ? b.crates.findIndex(function (x) { return String(x.id) === String(f.id); }) : -1;
        if (i !== -1 && !mine(b.crates[i])) { Own.denied(); return false; }
        if (k === 'delcrate') { b.crates.splice(i, 1); return; }
        if (i === -1) { f.id = uid(); if (window.Own) Own.stamp(f); b.crates.push(f); } else b.crates[i] = f;
      }).then(function (ok) { if (ok) { ui.crateForm = null; render(); } });
    }
    if (k === 'addrc') return finSave(function (F) { F.receipts = F.receipts || []; F.receipts.push({ id: uid(), date: today(), type: 'advance', amount: '', newSeason: false }); }).then(render);
    if (k === 'tocf') return toCashflow();
    if (k === 'openhv') { close(); if (window.HarvestResults) HarvestResults.openFarm(Number(ui.farm)); }
  }

  function ensureCss() {
    if (document.getElementById('shCss')) return;
    var st = document.createElement('style'); st.id = 'shCss';
    st.textContent =
      '.sh{max-width:1180px !important;width:100%;}.sh-h{display:flex;gap:8px;align-items:center;margin-bottom:6px;}.sh-h h2{flex:1;margin:0;font-size:1.12rem;}.sh-s{width:auto !important;margin:0 !important;}' +
      '.sh-tabs{display:flex;gap:6px;margin:8px 0 10px;flex-wrap:wrap;}.sh-tab{padding:9px 14px;border-radius:12px;border:1.5px solid var(--line,#dfe7da);background:var(--card,#fff);color:var(--primary,#1d5a2c);font:inherit;font-weight:700;font-size:.84rem;cursor:pointer;}.sh-tab.on{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}' +
      '.sh-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:7px 11px;font:inherit;font-weight:700;font-size:.8rem;cursor:pointer;min-height:36px;}.sh-btn.pri{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.sh-btn.ghost{background:transparent;}.sh-btn.warn{color:#b3261e;}.sh-btn.sm{min-height:28px;padding:2px 8px;}' +
      '.sh-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:10px;}.sh-k{background:var(--tonal,#f3f6ef);border-radius:14px;padding:9px 11px;}.sh-k small{display:block;color:var(--text-muted,#6f7b72);font-size:.72rem;}.sh-k b{font-size:1.08rem;}.sh-k.warn{background:#fff3e6;}.sh-k.warn b{color:#b45309;}.sh-k.ok b{color:var(--primary,#1d5a2c);}' +
      '.sh-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0;}.sh-mut{color:var(--text-muted,#6f7b72);font-size:.74rem;}.sh-empty{padding:30px 10px;text-align:center;color:var(--text-muted,#6f7b72);}' +
      '.sh-tare{display:inline-flex;gap:6px;align-items:center;font-size:.8rem;font-weight:700;color:var(--primary,#1d5a2c);}.sh-tare input,.sh-mini{width:84px !important;margin:0 !important;padding:5px 8px !important;}' +
      '.sh-note{border:1.5px solid var(--line,#e3e9de);border-radius:16px;margin-bottom:8px;overflow:hidden;background:var(--card,#fff);}.sh-nh{display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--tonal,#f6f8f4);padding:9px 12px;font-size:.82rem;cursor:pointer;}.sh-nh b{font-size:.92rem;}.sh-nh .sh-btn{margin-inline-start:auto;}.sh-chev{color:var(--primary,#1d5a2c);}' +
      '.sh-chip{background:#e2efe7;color:#1d5a2c;border-radius:99px;padding:3px 10px;font-size:.72rem;font-weight:700;white-space:nowrap;}.sh-chip.w{background:#fde8e6;color:#b3261e;}.sh-chip.y{background:#fff5d6;color:#8a6200;}' +
      '.sh-tw{overflow-x:auto;}.sh table{width:100%;border-collapse:collapse;font-size:.78rem;}.sh th{background:#eef3ea;color:#1d5a2c;font-weight:700;padding:6px;text-align:right;font-size:.72rem;white-space:nowrap;}.sh td{padding:5px 6px;border-bottom:1px solid #eef0ec;}' +
      '.sh td.n{font-variant-numeric:tabular-nums;white-space:nowrap;}.sh td.a{color:#5a655c;background:#fafbf8;}.sh .neg{color:#b3261e;font-weight:700;}.sh .pos{color:#1d5a2c;font-weight:700;}.sh tr.tot td{font-weight:800;border-top:2px solid #cfdccb;}.sh tr.dim td{opacity:.6;}' +
      '.sh-edit input.form-input{margin:0 !important;padding:4px 6px !important;min-width:70px;font-size:.8rem;}.sh-edit input.n{width:84px;}.sh-num{width:110px !important;margin:0 !important;}.sh td .form-input{margin:0 !important;padding:4px 6px !important;font-size:.78rem;}' +
      '.sh-form{background:var(--tonal,#f3f6ef);border-radius:16px;padding:12px;}.sh-form h3{margin:0 0 8px;font-size:1rem;}.sh-g{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px;}.sh-f{display:flex;flex-direction:column;gap:3px;}.sh-f small{color:var(--text-muted,#6f7b72);font-size:.72rem;}.sh-f .form-input{margin:0 !important;}' +
      '.sh-g2{display:grid;grid-template-columns:1.25fr 1fr;gap:12px;}.sh-card{border:1.5px solid var(--line,#e3e9de);border-radius:16px;padding:12px;background:var(--card,#fff);margin-bottom:12px;}.sh-card h3{margin:0 0 8px;font-size:.95rem;}' +
      '.sh-flow{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:8px;margin-top:10px;}.sh-fs{background:var(--tonal,#f3f6ef);border-radius:14px;padding:10px;text-align:center;}.sh-fs small{display:block;color:var(--text-muted,#6f7b72);font-size:.74rem;}.sh-fs b{display:block;font-size:1.12rem;margin:2px 0;}.sh-fs span{font-size:.72rem;color:var(--text-muted,#6f7b72);}' +
      '.sh-fs.r{background:#fde8e6;}.sh-fs.r b{color:#b3261e;}.sh-fs.g{background:var(--grad-primary,#1d5a2c);color:#fff;}.sh-fs.g small{color:#e6f0e8;}' +
      '@media (max-width:820px){.sh-g2{grid-template-columns:1fr;}}';
    document.head.appendChild(st);
  }

  return { open: open, close: close, _calc: { palletCalc: palletCalc, finCalc: finCalc } };
})();
window.Shipments = Shipments;
