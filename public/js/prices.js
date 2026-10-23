/* prices.js — shared product & price database (Oct 2026)
 *
 * Every invoice / delivery note / receipt read through a farm's document
 * intake (farm-intake.js) adds its priced lines here, from every user and
 * every משק, so the app builds one common list of products and what each
 * supplier charged. For a chosen period (30/90/180/365 days, or custom
 * dates) each product's cheapest price is the reference, and any price more
 * than a set percentage above it is flagged as an anomaly — on this screen
 * and on the intake review, where a new invoice is checked line by line.
 *
 * DATA  appData/shorashim-prices-YYYY  { year, records: [ … ] }
 *   record: { id, at, by, farmId, date (YYYY-MM-DD), supplier, docType,
 *             docNo, docPath, name, product, key, kind, qty, unit,
 *             baseUnit, unitPrice (₪ per base unit, before VAT), lineTotal,
 *             source: 'doc' | 'manual' }
 *   One document per year (the record's document date), so a year never
 *   outgrows Firestore's 1 MB. Operator+ read and write (firestore.rules);
 *   workers cannot read prices. Farm names of other farms are shown only to
 *   an admin.
 *
 * Saving re-reads the year's document and merges by id — two people saving
 * invoices at the same time do not overwrite each other — and refuses to
 * save when the server read failed and this device never saw that year
 * (a failed read must never look like an empty year).
 */
var PriceBook = (function () {
  'use strict';

  var SETTINGS_KEY = 'shorashim-price-settings';
  var docs = {};        // year -> { year, records }
  var seen = {};        // year -> true once a server read succeeded
  var listening = {};
  var ui = { q: '', onlyFlag: false, kind: '', open: null };

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
  function user() { return window.currentUser || {}; }
  function isManager() { var r = user().role; return r === 'admin' || r === 'operator'; }
  function isAdmin() { return user().role === 'admin'; }
  function key(y) { return 'shorashim-prices-' + y; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function money(n) { return '₪' + (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function day(d) { try { return d ? new Date(d + 'T00:00:00').toLocaleDateString('he-IL') : ''; } catch (e) { return d || ''; } }

  // ── product identity ──
  function norm(s) {
    return String(s || '').toLowerCase()
      .replace(/["'״׳`]/g, '').replace(/[\s\-_.,()\/\\]+/g, ' ').trim();
  }
  function productKey(product, baseUnit) { return norm(product) + '|' + String(baseUnit || ''); }

  // ── settings (per user) ──
  function settings() {
    var s = { days: 90, from: '', to: '', pct: 10 };
    try { var raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); if (raw) Object.keys(s).forEach(function (k) { if (raw[k] !== undefined) s[k] = raw[k]; }); } catch (e) {}
    s.days = Number(s.days) || 0; s.pct = Math.max(0, Number(s.pct) || 0);
    return s;
  }
  function saveSettings(s) { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) {} }
  function range(s) {
    s = s || settings();
    if (!s.days && s.from && s.to) return { from: s.from, to: s.to };
    var d = new Date(); d.setDate(d.getDate() - (s.days || 90));
    return { from: d.toISOString().slice(0, 10), to: today() };
  }

  // ── storage ──
  function normDoc(d, y) {
    d = (d && typeof d === 'object') ? JSON.parse(JSON.stringify(d)) : {};
    if (!Array.isArray(d.records)) d.records = [];
    d.year = y;
    return d;
  }
  function loadYear(y) {
    if (typeof DB === 'undefined') { docs[y] = normDoc(null, y); return Promise.resolve(); }
    return DB.read(key(y)).then(function (res) {
      if (res.ok) seen[y] = true;
      docs[y] = normDoc(res.data, y);
      if (!listening[y] && DB.listen) {
        listening[y] = true;
        DB.listen(key(y), function (d) { seen[y] = true; docs[y] = normDoc(d, y); if (ui.painted) paint(); });
      }
    });
  }
  // Loads every year the current period touches (and the current year).
  function ensureLoaded(r) {
    r = r || range();
    var ys = {}, y0 = Number(r.from.slice(0, 4)), y1 = Number(r.to.slice(0, 4));
    for (var y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) ys[y] = 1;
    ys[new Date().getFullYear()] = 1;
    return Promise.all(Object.keys(ys).filter(function (y) { return !docs[y]; }).map(function (y) { return loadYear(Number(y)); }));
  }
  function allRecords() {
    var out = [];
    Object.keys(docs).forEach(function (y) { out = out.concat(docs[y].records || []); });
    return out;
  }

  // Append (or replace by id) records; grouped by the year of their date.
  function add(records) {
    if (!isManager()) return Promise.resolve(false);
    var byYear = {};
    (records || []).forEach(function (r) {
      var y = Number(String(r.date || today()).slice(0, 4)) || new Date().getFullYear();
      (byYear[y] = byYear[y] || []).push(r);
    });
    var years = Object.keys(byYear);
    if (!years.length) return Promise.resolve(true);
    return Promise.all(years.map(function (y) {
      y = Number(y);
      return DB.read(key(y)).then(function (res) {
        var base;
        if (res.ok) base = normDoc(res.exists ? res.data : null, y);
        else if (seen[y] || res.data) base = normDoc(res.data || docs[y], y);
        else return false;
        byYear[y].forEach(function (r) {
          var i = base.records.findIndex(function (x) { return x.id === r.id; });
          if (i === -1) base.records.push(r); else base.records[i] = r;
        });
        DB.save(key(y), base);
        seen[y] = true; docs[y] = base;
        return true;
      });
    })).then(function (oks) {
      var ok = oks.every(Boolean);
      if (!ok) toast('❌ ' + tt('אין חיבור לשרת — המחירים לא נשמרו. נסה שוב.', 'ไม่มีการเชื่อมต่อ — ไม่ได้บันทึกราคา', 'لا اتصال — لم تُحفظ الأسعار'));
      return ok;
    });
  }
  function removeRecord(id, y) {
    if (!isAdmin()) return Promise.resolve(false);
    return DB.read(key(y)).then(function (res) {
      if (!res.ok) { toast('❌ ' + tt('אין חיבור לשרת', 'ไม่มีการเชื่อมต่อ', 'لا اتصال')); return false; }
      var base = normDoc(res.exists ? res.data : null, y);
      base.records = base.records.filter(function (r) { return r.id !== id; });
      DB.save(key(y), base); docs[y] = base;
      return true;
    });
  }

  // Builds a record from an intake line (farm-intake.js).
  function fromIntake(it, doc, farmId) {
    var base = it.base_unit || it.unit || '';
    var product = it.product || it.catalogue_match || it.name;
    return {
      id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
      at: Date.now(), by: user().email || user().username || '',
      farmId: farmId, date: (doc && doc.doc_date) || today(),
      supplier: String((doc && doc.supplier) || '').slice(0, 80), docType: (doc && doc.doc_type) || '',
      docNo: String((doc && doc.doc_no) || '').slice(0, 40), docPath: (doc && doc.path) || '',
      name: String(it.name || '').slice(0, 100), product: String(product || '').slice(0, 100),
      key: productKey(product, base), kind: it.kind || 'other',
      qty: Number(it.qty) || 0, unit: String(it.unit || '').slice(0, 20), baseUnit: String(base).slice(0, 20),
      unitPrice: Math.round((Number(it.unit_price) || 0) * 10000) / 10000,
      lineTotal: Number(it.line_total) || 0, source: 'doc'
    };
  }

  // ── analysis ──
  function inRange(r, rg) { var d = r.date || ''; return d >= rg.from && d <= rg.to; }
  function analyze(rg, pct) {
    var by = {};
    allRecords().forEach(function (r) {
      if (!(r.unitPrice > 0) || !inRange(r, rg)) return;
      var g = by[r.key] || (by[r.key] = { key: r.key, name: r.product || r.name, baseUnit: r.baseUnit, kind: r.kind, recs: [] });
      g.recs.push(r);
    });
    return Object.keys(by).map(function (k) {
      var g = by[k];
      g.recs.sort(function (a, b) { return a.unitPrice - b.unitPrice || String(a.date).localeCompare(String(b.date)); });
      g.min = g.recs[0];
      g.max = g.recs[g.recs.length - 1];
      g.last = g.recs.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || b.at - a.at; })[0];
      g.flagged = g.recs.filter(function (r) { return over(r.unitPrice, g.min.unitPrice) > pct; });
      g.suppliers = {};
      g.recs.forEach(function (r) { if (r.supplier) g.suppliers[r.supplier] = 1; });
      return g;
    });
  }
  function over(p, min) { return min > 0 ? (p / min - 1) * 100 : 0; }

  // For the intake review: how does this price compare with the cheapest
  // known price of the same product in the user's period?
  function compare(product, baseUnit, unitPrice) {
    var s = settings(), rg = range(s);
    var k = productKey(product, baseUnit);
    var best = null;
    allRecords().forEach(function (r) {
      if (r.key !== k || !(r.unitPrice > 0) || !inRange(r, rg)) return;
      if (!best || r.unitPrice < best.unitPrice) best = r;
    });
    if (!best || !(unitPrice > 0)) return { known: !!best, min: best };
    var p = over(unitPrice, best.unitPrice);
    return { known: true, min: best, pct: p, flag: p > s.pct, cheapest: unitPrice <= best.unitPrice };
  }

  function farmLabel(fid) {
    var fs = (window.SprayStore && SprayStore.getFarms) ? SprayStore.getFarms() : [];
    var f = fs.find(function (x) { return x.id === fid; });
    if (f) return f.name;   // getFarms lists only the farms this user may see
    return tt('משק אחר', 'ฟาร์มอื่น', 'مزرعة أخرى');
  }

  // ── screen ──
  function ensureCss() {
    if (document.getElementById('pbCss')) return;
    var st = document.createElement('style');
    st.id = 'pbCss';
    st.textContent =
      '.pb-back{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9000;overflow:auto;padding:14px;}' +
      '.pb-sheet{max-width:980px;margin:0 auto;background:var(--card,#fff);color:var(--text,#222);border-radius:18px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.3);}' +
      '.pb-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:10px;}' +
      '.pb-head h3{margin:0;font-size:1.1rem;font-weight:700;}' +
      '.pb-head small{display:block;color:var(--text-muted,#777);font-size:.76rem;margin-top:2px;}' +
      '.pb-x{border:0;background:var(--g6,#eef2ee);border-radius:99px;width:34px;height:34px;font-size:1rem;cursor:pointer;}' +
      '.pb-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px;}' +
      '.pb-bar .form-input{margin:0;width:auto;flex:1 1 120px;min-width:0;padding:8px 10px;font-size:.84rem;}' +
      '.pb-bar label{display:inline-flex;gap:5px;align-items:center;font-size:.82rem;white-space:nowrap;}' +
      '.pb-btn{border:0;border-radius:99px;padding:8px 14px;background:var(--primary,#2d6a4f);color:#fff;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.pb-btn.ghost{background:var(--g6,#eef2ee);color:var(--text,#333);}' +
      '.pb-sum{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}' +
      '.pb-chip{background:var(--primary-soft,#e2efe7);color:var(--primary,#2d6a4f);border-radius:99px;padding:4px 11px;font-size:.76rem;font-weight:600;}' +
      '.pb-chip.warn{background:#fdecea;color:#b3261e;}' +
      '.pb-list{display:flex;flex-direction:column;gap:8px;}' +
      '.pb-card{border:1px solid var(--line,#dbe3d8);border-radius:14px;padding:10px 12px;background:var(--card,#fff);cursor:pointer;}' +
      '.pb-card.flag{border-color:#e9a39b;background:#fffafa;}' +
      '.pb-card .t{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}' +
      '.pb-card .t b{font-size:.95rem;}' +
      '.pb-card .t span{font-size:.74rem;color:var(--text-muted,#777);white-space:nowrap;}' +
      '.pb-card .g{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;font-size:.8rem;}' +
      '.pb-card .g div{background:var(--g6,#f2f5f2);border-radius:10px;padding:6px 8px;}' +
      '.pb-card .g small{display:block;color:var(--text-muted,#777);font-size:.7rem;}' +
      '.pb-up{color:#b3261e;font-weight:700;}' +
      '.pb-ok{color:var(--primary,#2d6a4f);font-weight:700;}' +
      '.pb-tbl{width:100%;border-collapse:collapse;font-size:.8rem;margin-top:6px;}' +
      '.pb-tbl th{background:var(--g6,#eef2ee);text-align:right;padding:6px;font-weight:600;font-size:.74rem;}' +
      '.pb-tbl td{padding:6px;border-bottom:1px solid var(--line,#e5e9e4);vertical-align:top;}' +
      '.pb-tbl tr.flag td{background:#fff4f2;}' +
      '.pb-tbl tr.min td{background:#eef8f1;}' +
      '.pb-a{border:0;background:transparent;color:var(--primary,#2d6a4f);cursor:pointer;font:inherit;padding:0;text-decoration:underline;}' +
      '.pb-empty{text-align:center;color:var(--text-muted,#777);padding:24px 8px;font-size:.86rem;}' +
      '.pb-form{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:6px;margin:8px 0;}' +
      '.pb-form .form-input{margin:0;padding:8px 10px;font-size:.84rem;}';
    document.head.appendChild(st);
  }

  function open() {
    if (!isManager()) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    ensureCss();
    ui.open = null; ui.painted = true;
    paint(true);
    ensureLoaded().then(function () { paint(); });
  }
  function close() { ui.painted = false; var c = document.getElementById('modalContainer'); if (c) c.innerHTML = ''; }

  function paint(loading) {
    var c = document.getElementById('modalContainer');
    if (!c || !ui.painted) return;
    var s = settings(), rg = range(s);
    var groups = analyze(rg, s.pct);
    var q = norm(ui.q);
    var shown = groups.filter(function (g) {
      if (ui.onlyFlag && !g.flagged.length) return false;
      if (ui.kind && g.kind !== ui.kind) return false;
      if (q && norm(g.name).indexOf(q) === -1 && !Object.keys(g.suppliers).some(function (x) { return norm(x).indexOf(q) !== -1; })) return false;
      return true;
    }).sort(function (a, b) { return (b.flagged.length ? 1 : 0) - (a.flagged.length ? 1 : 0) || String(a.name).localeCompare(String(b.name), 'he'); });
    var flaggedN = groups.reduce(function (n, g) { return n + g.flagged.length; }, 0);
    var recN = groups.reduce(function (n, g) { return n + g.recs.length; }, 0);

    var per = [[30, '30 ' + tt('יום', 'วัน', 'يوم')], [90, '90 ' + tt('יום', 'วัน', 'يوم')], [180, tt('חצי שנה', 'ครึ่งปี', 'نصف سنة')], [365, tt('שנה', 'ปี', 'سنة')], [0, tt('טווח תאריכים', 'กำหนดช่วง', 'نطاق تواريخ')]];
    var body;
    if (ui.open) body = detailHtml(groups.find(function (g) { return g.key === ui.open; }), s);
    else body =
      '<div class="pb-sum"><span class="pb-chip">' + groups.length + ' ' + tt('מוצרים', 'สินค้า', 'منتجات') + '</span>' +
        '<span class="pb-chip">' + recN + ' ' + tt('מחירים', 'ราคา', 'أسعار') + '</span>' +
        '<span class="pb-chip' + (flaggedN ? ' warn' : '') + '">' + flaggedN + ' ' + tt('חריגות', 'ผิดปกติ', 'انحرافات') + ' (>' + s.pct + '%)</span>' +
        readCostChip() + '</div>' +
      (shown.length ? '<div class="pb-list">' + shown.map(cardHtml.bind(null, s)).join('') + '</div>' :
        '<div class="pb-empty">' + (loading ? '⏳ ' + tt('טוען…', 'กำลังโหลด…', 'جارٍ التحميل…') :
          tt('אין מחירים בתקופה הזו. מחירים נוספים אוטומטית מכל חשבונית שנקלטת במשקים, או בהוספה ידנית.',
             'ยังไม่มีราคาในช่วงนี้', 'لا أسعار في هذه الفترة')) + '</div>');

    c.innerHTML = '<div class="pb-back" id="pbBack"><div class="pb-sheet">' +
      '<div class="pb-head"><div><h3>💲 ' + tt('מאגר מוצרים ומחירים', 'ฐานข้อมูลสินค้าและราคา', 'قاعدة المنتجات والأسعار') + '</h3>' +
        '<small>' + tt('משותף לכל המשקים · המחיר הזול ביותר בתקופה הוא נקודת הייחוס', 'ใช้ร่วมกันทุกฟาร์ม', 'مشترك لكل المزارع') + ' · ' + day(rg.from) + ' – ' + day(rg.to) + '</small></div>' +
        '<button class="pb-x" id="pbClose" aria-label="close">✕</button></div>' +
      '<div class="pb-bar">' +
        '<select class="form-input" id="pbDays">' + per.map(function (o) { return '<option value="' + o[0] + '"' + (s.days === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        (s.days ? '' : '<input class="form-input" type="date" id="pbFrom" value="' + esc(s.from || rg.from) + '"><input class="form-input" type="date" id="pbTo" value="' + esc(s.to || rg.to) + '">') +
        '<label>' + tt('סף חריגה', 'เกณฑ์', 'العتبة') + ' <input class="form-input" type="number" id="pbPct" min="0" max="500" step="1" value="' + s.pct + '" style="width:70px;flex:none;">%</label>' +
      '</div>' +
      (ui.open ? '' :
      '<div class="pb-bar">' +
        '<input class="form-input" type="search" id="pbQ" value="' + esc(ui.q) + '" placeholder="🔍 ' + esc(tt('חיפוש מוצר או ספק', 'ค้นหาสินค้าหรือผู้จัดหา', 'ابحث عن منتج أو مورد')) + '">' +
        '<select class="form-input" id="pbKind"><option value="">' + tt('כל הסוגים', 'ทุกประเภท', 'كل الأنواع') + '</option>' +
          [['pesticide', '🧪 ' + tt('חומרי הדברה', 'สารเคมี', 'مبيدات')], ['fertilizer', '🌱 ' + tt('דשנים', 'ปุ๋ย', 'أسمدة')], ['equipment', '🚜 ' + tt('ציוד', 'อุปกรณ์', 'معدات')], ['other', '📦 ' + tt('אחר', 'อื่นๆ', 'أخرى')]].map(function (o) {
            return '<option value="' + o[0] + '"' + (ui.kind === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
        '<label><input type="checkbox" id="pbFlag"' + (ui.onlyFlag ? ' checked' : '') + '> ' + tt('רק חריגות', 'เฉพาะผิดปกติ', 'الانحرافات فقط') + '</label>' +
        '<button class="pb-btn ghost" id="pbAdd">➕ ' + tt('מחיר ידני', 'เพิ่มราคา', 'سعر يدوي') + '</button>' +
      '</div><div id="pbAddBox"></div>') +
      body + '</div></div>';
    bindUi();
  }

  // Admin: what reading documents cost this month across every farm.
  function readCostChip() {
    if (!isAdmin() || !window.FarmIntake || !window.SprayStore || !SprayStore.getFarmIntake) return '';
    var n = 0, sum = 0;
    (SprayStore.getFarms() || []).forEach(function (f) {
      var info = SprayStore.getFarmIntake(f.id);
      var mc = info ? FarmIntake.monthCost(info.docs) : { n: 0, usd: 0 };
      n += mc.n; sum += mc.usd;
    });
    return n ? '<span class="pb-chip">💵 ' + tt('קריאת מסמכים החודש', 'ค่าอ่านเดือนนี้', 'قراءة المستندات هذا الشهر') + ': ' + FarmIntake.usd(sum) + ' · ' + n + '</span>' : '';
  }

  function cardHtml(s, g) {
    var lastOver = over(g.last.unitPrice, g.min.unitPrice);
    return '<div class="pb-card' + (g.flagged.length ? ' flag' : '') + '" data-pb-key="' + esc(g.key) + '">' +
      '<div class="t"><b>' + esc(g.name) + '</b><span>' + g.recs.length + ' ' + tt('מחירים', 'ราคา', 'أسعار') + ' · ' +
        Object.keys(g.suppliers).length + ' ' + tt('ספקים', 'ผู้จัดหา', 'موردون') +
        (g.flagged.length ? ' · <span class="pb-up">⚠️ ' + g.flagged.length + '</span>' : '') + '</span></div>' +
      '<div class="g"><div><small>' + tt('הזול ביותר', 'ถูกที่สุด', 'الأرخص') + '</small><span class="pb-ok">' + money(g.min.unitPrice) + '</span> / ' + esc(g.baseUnit) +
        '<small>' + esc(g.min.supplier || '—') + ' · ' + day(g.min.date) + '</small></div>' +
      '<div><small>' + tt('אחרון', 'ล่าสุด', 'الأخير') + '</small><span class="' + (lastOver > s.pct ? 'pb-up' : '') + '">' + money(g.last.unitPrice) + '</span>' +
        (lastOver > 0.05 ? ' <span class="' + (lastOver > s.pct ? 'pb-up' : '') + '">(+' + Math.round(lastOver) + '%)</span>' : '') +
        '<small>' + esc(g.last.supplier || '—') + ' · ' + day(g.last.date) + '</small></div></div></div>';
  }

  function detailHtml(g, s) {
    if (!g) { ui.open = null; return ''; }
    var rows = g.recs.map(function (r) {
      var p = over(r.unitPrice, g.min.unitPrice);
      var y = String(r.date || '').slice(0, 4);
      return '<tr class="' + (r === g.min ? 'min' : (p > s.pct ? 'flag' : '')) + '">' +
        '<td>' + day(r.date) + '</td><td>' + esc(r.supplier || '—') + (r.docNo ? '<br><small>#' + esc(r.docNo) + '</small>' : '') + '</td>' +
        '<td>' + esc(farmLabel(r.farmId)) + '</td>' +
        '<td><b>' + money(r.unitPrice) + '</b>' + (r.qty ? '<br><small>' + r.qty + ' ' + esc(r.unit || '') + '</small>' : '') + '</td>' +
        '<td>' + (r === g.min ? '<span class="pb-ok">' + tt('הזול', 'ถูกสุด', 'الأرخص') + '</span>' : '<span class="' + (p > s.pct ? 'pb-up' : '') + '">+' + Math.round(p * 10) / 10 + '%</span>') + '</td>' +
        '<td>' + (r.docPath ? '<button class="pb-a" data-pb-doc="' + esc(r.docPath) + '">📄</button>' : '') +
          (isAdmin() ? ' <button class="pb-a" data-pb-del="' + r.id + '" data-pb-y="' + esc(y) + '" title="' + esc(tt('מחק', 'ลบ', 'حذف')) + '">🗑</button>' : '') + '</td></tr>';
    }).join('');
    return '<button class="pb-btn ghost" id="pbBackList">→ ' + tt('לכל המוצרים', 'กลับ', 'رجوع') + '</button>' +
      '<h3 style="margin:10px 0 2px;">' + esc(g.name) + ' <small style="font-weight:400;color:var(--text-muted,#777);">/ ' + esc(g.baseUnit) + '</small></h3>' +
      '<div class="pb-sum"><span class="pb-chip">' + tt('הזול', 'ถูกสุด', 'الأرخص') + ': ' + money(g.min.unitPrice) + ' · ' + esc(g.min.supplier || '—') + '</span>' +
        '<span class="pb-chip">' + tt('היקר', 'แพงสุด', 'الأغلى') + ': ' + money(g.max.unitPrice) + '</span>' +
        (g.flagged.length ? '<span class="pb-chip warn">⚠️ ' + g.flagged.length + ' ' + tt('מעל', 'เกิน', 'فوق') + ' ' + s.pct + '%</span>' : '') + '</div>' +
      '<div style="overflow:auto;"><table class="pb-tbl"><thead><tr><th>' + tt('תאריך', 'วันที่', 'التاريخ') + '</th><th>' + tt('ספק', 'ผู้จัดหา', 'المورد') + '</th>' +
        '<th>' + tt('משק', 'ฟาร์ม', 'المزرعة') + '</th><th>' + tt('מחיר ליחידה (לפני מע"מ)', 'ราคา/หน่วย', 'السعر/وحدة') + '</th><th>' + tt('מול הזול', 'เทียบ', 'مقابل الأرخص') + '</th><th></th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table></div>';
  }

  function bindUi() {
    function $(id) { return document.getElementById(id); }
    $('pbClose').addEventListener('click', close);
    $('pbBack').addEventListener('click', function (e) { if (e.target.id === 'pbBack') close(); });
    $('pbDays').addEventListener('change', function () {
      var s = settings(); s.days = Number(this.value) || 0;
      if (!s.days) { var rg = range(); s.from = s.from || rg.from; s.to = s.to || rg.to; }
      saveSettings(s); ensureLoaded(range(s)).then(paint);
    });
    ['pbFrom', 'pbTo'].forEach(function (id) {
      var el = $(id); if (!el) return;
      el.addEventListener('change', function () {
        var s = settings(); s.from = $('pbFrom').value; s.to = $('pbTo').value;
        if (s.from && s.to && s.from > s.to) { var t = s.from; s.from = s.to; s.to = t; }
        saveSettings(s); ensureLoaded(range(s)).then(paint);
      });
    });
    $('pbPct').addEventListener('change', function () { var s = settings(); s.pct = Math.max(0, Number(this.value) || 0); saveSettings(s); paint(); });
    var q = $('pbQ');
    if (q) q.addEventListener('input', function () { ui.q = this.value; var pos = this.selectionStart; paint(); var n = $('pbQ'); if (n) { n.focus(); try { n.setSelectionRange(pos, pos); } catch (e) {} } });
    if ($('pbKind')) $('pbKind').addEventListener('change', function () { ui.kind = this.value; paint(); });
    if ($('pbFlag')) $('pbFlag').addEventListener('change', function () { ui.onlyFlag = this.checked; paint(); });
    if ($('pbAdd')) $('pbAdd').addEventListener('click', manualForm);
    if ($('pbBackList')) $('pbBackList').addEventListener('click', function () { ui.open = null; paint(); });
    document.querySelectorAll('[data-pb-key]').forEach(function (el) {
      el.addEventListener('click', function () { ui.open = el.getAttribute('data-pb-key'); paint(); });
    });
    document.querySelectorAll('[data-pb-doc]').forEach(function (el) {
      el.addEventListener('click', function () {
        var p = el.getAttribute('data-pb-doc');
        if (window.firebase && firebase.storage) firebase.storage().ref(p).getDownloadURL().then(function (u) { window.open(u, '_blank', 'noopener'); },
          function () { toast('❌ ' + tt('לא ניתן לפתוח את המסמך', 'เปิดไม่ได้', 'تعذر الفتح')); });
      });
    });
    document.querySelectorAll('[data-pb-del]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm(tt('למחוק את המחיר הזה מהמאגר?', 'ลบราคานี้?', 'حذف هذا السعر؟'))) return;
        removeRecord(Number(el.getAttribute('data-pb-del')), Number(el.getAttribute('data-pb-y'))).then(paint);
      });
    });
  }

  function manualForm() {
    var box = document.getElementById('pbAddBox');
    if (!box) return;
    var fs = (window.SprayStore && SprayStore.getFarms) ? SprayStore.getFarms() : [];
    box.innerHTML = '<div class="pb-form">' +
      '<input class="form-input" id="pbmProduct" placeholder="' + esc(tt('מוצר', 'สินค้า', 'المنتج')) + '">' +
      '<input class="form-input" id="pbmSupplier" placeholder="' + esc(tt('ספק', 'ผู้จัดหา', 'المورد')) + '">' +
      '<input class="form-input" id="pbmDate" type="date" value="' + today() + '">' +
      '<select class="form-input" id="pbmUnit">' + ['ליטר', 'ק"ג', 'יחידה', 'מטר', 'טון'].map(function (u) { return '<option>' + esc(u) + '</option>'; }).join('') + '</select>' +
      '<input class="form-input" id="pbmPrice" type="number" step="any" min="0" placeholder="' + esc(tt('₪ ליחידה לפני מע"מ', '₪/หน่วย', '₪/وحدة')) + '">' +
      '<select class="form-input" id="pbmKind"><option value="pesticide">🧪</option><option value="fertilizer">🌱</option><option value="equipment">🚜</option><option value="other" selected>📦</option></select>' +
      '<select class="form-input" id="pbmFarm"><option value="0">—</option>' + fs.map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('') + '</select>' +
      '<button class="pb-btn" id="pbmSave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button></div>';
    document.getElementById('pbmSave').addEventListener('click', function () {
      function v(id) { return (document.getElementById(id) || {}).value || ''; }
      var product = v('pbmProduct').trim(), price = Number(v('pbmPrice'));
      if (!product || !(price > 0)) { toast('⚠️ ' + tt('חסר מוצר או מחיר', 'ขาดข้อมูล', 'ينقص المنتج أو السعر')); return; }
      var rec = fromIntake({ name: product, product: product, kind: v('pbmKind'), base_unit: v('pbmUnit'), unit: v('pbmUnit'), unit_price: price, qty: 0 },
        { doc_date: v('pbmDate'), supplier: v('pbmSupplier').trim(), doc_type: 'manual' }, Number(v('pbmFarm')) || 0);
      rec.source = 'manual';
      var c = compare(product, v('pbmUnit'), price);
      add([rec]).then(function (ok) {
        if (!ok) return;
        toast(c.flag ? '⚠️ ' + tt('נשמר — יקר ב-', 'บันทึกแล้ว — แพงกว่า ', 'حُفظ — أغلى بـ ') + Math.round(c.pct) + '% ' + tt('מהזול בתקופה', 'จากถูกสุด', 'من الأرخص') : '✅ ' + tt('נשמר', 'บันทึกแล้ว', 'حُفظ'));
        paint();
      });
    });
  }

  return {
    open: open, add: add, fromIntake: fromIntake, compare: compare, ensureLoaded: ensureLoaded,
    // Records of the given years (loaded on demand) — cashflow.js reads purchase totals.
    recordsFor: function (years) {
      return ensureLoaded({ from: Math.min.apply(null, years) + '-01-01', to: Math.max.apply(null, years) + '-12-31' })
        .then(function () { return allRecords().filter(function (r) { return years.indexOf(Number(String(r.date || '').slice(0, 4))) !== -1; }); });
    },
    settings: settings, productKey: productKey, _analyze: analyze, _money: money
  };
})();
window.PriceBook = PriceBook;
