/* wxhist.js — measured weather per משק from IMS stations (Oct 2026)
 *
 * From the nearest Israel Meteorological Service stations (functions:
 * imsData, mode "days"), for the farm's location:
 *   • rain this season (from 1 September) against the same date last
 *     season, by month, rain days;
 *   • heat: days ≥ 35° and ≥ 40°, the season's highest;
 *   • degree days: heat accumulated above a base temperature from a chosen
 *     date (ripening, pest cycles), this year against last year;
 *   • irrigation: measured ET0 of the last full week (Sun–Sat) × each plot's
 *     monthly coefficient (plotrec.js) = what should have been given, next
 *     to what was given (typed per plot and week, stored in plotrec);
 *   • events (rain, heat ≥ 40°, frost ≤ 2°) and a printable record of the
 *     whole season, day by day - official station data, for insurance claims.
 * Each element comes from the nearest station that measures it; the screen
 * says which station and how far.
 *
 * Public: WxHist.open(farmId)
 */
var WxHist = (function () {
  'use strict';

  var ui = { fid: null, cur: null, prev: null, err: '', base: 18, from: '' };

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
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function addDays(iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
  function fmtD(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? Number(m[3]) + '/' + Number(m[2]) : iso; }
  function fmtDY(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1] : iso; }
  var MONTHS = [['ספט׳', 'ก.ย.', 'سبتمبر'], ['אוק׳', 'ต.ค.', 'أكتوبر'], ['נוב׳', 'พ.ย.', 'نوفمبر'], ['דצמ׳', 'ธ.ค.', 'ديسمبر'], ['ינו׳', 'ม.ค.', 'يناير'], ['פבר׳', 'ก.พ.', 'فبراير'],
    ['מרץ', 'มี.ค.', 'مارس'], ['אפר׳', 'เม.ย.', 'أبريل'], ['מאי', 'พ.ค.', 'مايو'], ['יוני', 'มิ.ย.', 'يونيو'], ['יולי', 'ก.ค.', 'يوليو'], ['אוג׳', 'ส.ค.', 'أغسطس']];

  function farmName(fid) { var f = (S().getFarms ? S().getFarms() : []).find(function (x) { return x.id === fid; }); return f ? f.name : ''; }
  function point(fid) { return (window.Weather && Weather._points ? Weather._points() : []).find(function (p) { return p.id === fid; }) || null; }

  // the rain season: 1 September → yesterday; last season = the same dates a year earlier
  function season() {
    var y = new Date(), yest = addDays(ymd(y), -1), yr = Number(yest.slice(0, 4)), mo = Number(yest.slice(5, 7));
    var start = (mo >= 9 ? yr : yr - 1) + '-09-01';
    return { from: start, to: yest, pFrom: (Number(start.slice(0, 4)) - 1) + start.slice(4), pTo: (yr - 1) + yest.slice(4) };
  }
  function fetchDays(pt, from, to) {
    var fn = firebase.app().functions('us-central1').httpsCallable('imsData', { timeout: 300000 });
    return fn({ mode: 'days', points: [{ id: 'p', lat: pt.lat, lon: pt.lon, station: pt.station, radStation: pt.radStation }], from: from, to: to }).then(function (r) { return (r && r.data && r.data.points && r.data.points.p) || null; });
  }

  function open(fid) {
    ui.fid = fid; ui.cur = ui.prev = null; ui.err = ''; ui.pick = null; ui.tbl = null; ui.tblData = null; ui.day = null; ui.dayData = null;
    try { var st = JSON.parse(localStorage.getItem('shorashim-wxhist-' + fid) || '{}'); ui.base = Number(st.base) || 18; ui.from = st.from || ''; } catch (e) { ui.base = 18; ui.from = ''; }
    if (!ui.from) ui.from = new Date().getFullYear() + '-01-01';
    ensureCss();
    paint();
    var pt = point(fid);
    if (!pt) { ui.err = tt('למשק אין מיקום (אין חלקה מסומנת במפה)', 'ฟาร์มไม่มีตำแหน่ง', 'لا موقع للمزرعة'); return paint(); }
    if (!window.firebase || !firebase.app) { ui.err = 'offline'; return paint(); }
    var s = season();
    ui.s = s; ui.more = false;
    var fail = function (e) {
      if (ui.fid !== fid) return;
      var c = String((e && (e.code || e.message)) || '');
      ui.err = /not-found/.test(c) ? tt('פונקציית נתוני השירות המטאורולוגי עוד לא נפרסה (firebase deploy --only functions:imsData)', 'ยังไม่ได้ติดตั้ง', 'الدالة غير منشورة')
        : /deadline|unavailable/.test(c) ? tt('השירות המטאורולוגי איטי כרגע. הנתונים שכבר נטענו נשמרו - נסה שוב בעוד דקה.', 'IMS ช้า ลองอีกครั้ง', 'الخدمة بطيئة، حاول لاحقًا') : c;
      paint();
    };
    // 1) this season and the same dates last season - a few months, shown
    //    as soon as they arrive
    Promise.all([fetchDays(pt, s.from, s.to), fetchDays(pt, s.pFrom, s.pTo), window.PlotRec && PlotRec.ready ? PlotRec.ready() : null]).then(function (r) {
      if (ui.fid !== fid) return;
      ui.cur = r[0]; ui.prev = r[1]; ui.loadedFrom = s.from;
      if (!ui.cur) { ui.err = tt('אין נתונים מתחנות השירות המטאורולוגי לאזור הזה', 'ไม่มีข้อมูล', 'لا بيانات'); return paint(); }
      paint();
      loadEarlier(fid, pt);
    }, fail);
  }
  // 2) degree days from a date before the season (1 January by default):
  //    the extra months are fetched afterwards and merged in
  function loadEarlier(fid, pt) {
    var s = ui.s, lo = ui.from, min = addDays(s.to, -390);
    if (lo < min) lo = min;
    if (lo >= ui.loadedFrom) return;
    var end = addDays(ui.loadedFrom, -1), plo = (Number(lo.slice(0, 4)) - 1) + lo.slice(4), pend = (Number(end.slice(0, 4)) - 1) + end.slice(4);
    ui.more = true; paint();
    Promise.all([fetchDays(pt, lo, end), fetchDays(pt, plo, pend)]).then(function (r) {
      if (ui.fid !== fid) return;
      if (r[0]) ui.cur.days = (r[0].days || []).concat(ui.cur.days || []);
      if (r[1] && ui.prev) ui.prev.days = (r[1].days || []).concat(ui.prev.days || []);
      ui.loadedFrom = lo; ui.more = false; paint();
    }, function () { if (ui.fid !== fid) return; ui.more = 'fail'; paint(); });
  }
  function close() { var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  // ── figures ──
  function sum(days, k) { return days.reduce(function (a, d) { return a + (Number(d[k]) || 0); }, 0); }
  function count(days, f) { return days.filter(f).length; }
  function seasonMonth(iso) { var m = Number(iso.slice(5, 7)); return (m + 3) % 12; }   // Sep = 0 … Aug = 11
  function monthly(days) { var a = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]; days.forEach(function (d) { if (d.rain != null) a[seasonMonth(d.d)] += d.rain; }); return a; }
  function gdd(days, from, base) {
    var acc = 0, out = [];
    days.forEach(function (d) {
      if (d.d < from || d.tmax == null || d.tmin == null) return;
      acc += Math.max(0, (d.tmax + d.tmin) / 2 - base);
      out.push([d.d, acc]);
    });
    return out;
  }
  // last full week, Sunday → Saturday
  function lastWeek() {
    var d = new Date(); d.setHours(12, 0, 0, 0);
    var sat = new Date(d); sat.setDate(d.getDate() - ((d.getDay() + 1) % 7 || 7));
    var sun = new Date(sat); sun.setDate(sat.getDate() - 6);
    var f = function (x) { return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    return { from: f(sun), to: f(sat) };
  }

  // ── charts ──
  function barsSvg(a, b) {
    var W = 560, H = 170, pad = 26, max = Math.max(5, Math.max.apply(null, a.concat(b))), bw = (W - pad * 2) / 12;
    var y = function (v) { return H - 22 - (v / max) * (H - 40); };
    var g = '';
    for (var i = 0; i < 12; i++) {
      var x = pad + i * bw;
      g += '<rect x="' + (x + bw * 0.14) + '" y="' + y(b[i]) + '" width="' + bw * 0.34 + '" height="' + (H - 22 - y(b[i])) + '" rx="2" fill="#c8d3c4"/>' +
        '<rect x="' + (x + bw * 0.5) + '" y="' + y(a[i]) + '" width="' + bw * 0.34 + '" height="' + (H - 22 - y(a[i])) + '" rx="2" fill="#2f7fbf"/>' +
        (a[i] ? '<text x="' + (x + bw * 0.67) + '" y="' + (y(a[i]) - 3) + '" font-size="9" text-anchor="middle" fill="#2f7fbf">' + Math.round(a[i]) + '</text>' : '') +
        '<text x="' + (x + bw / 2) + '" y="' + (H - 7) + '" font-size="10" text-anchor="middle" fill="#6b756e">' + esc(tt(MONTHS[i][0], MONTHS[i][1], MONTHS[i][2])) + '</text>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;direction:ltr;" font-family="Rubik,Heebo,Arial,sans-serif">' + g + '</svg>';
  }
  function lineSvg(cur, prev) {
    var W = 560, H = 170, pad = 30, all = cur.concat(prev), max = Math.max(10, Math.max.apply(null, all.map(function (p) { return p[1]; })));
    var n = Math.max(cur.length, prev.length, 2);
    var path = function (arr) { return arr.map(function (p, i) { return (i ? 'L' : 'M') + (pad + i / (n - 1) * (W - pad * 2)).toFixed(1) + ' ' + (H - 20 - p[1] / max * (H - 36)).toFixed(1); }).join(' '); };
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;direction:ltr;" font-family="Rubik,Heebo,Arial,sans-serif">' +
      '<line x1="' + pad + '" y1="' + (H - 20) + '" x2="' + (W - pad) + '" y2="' + (H - 20) + '" stroke="#e1e6de"/>' +
      (prev.length ? '<path d="' + path(prev) + '" fill="none" stroke="#c8d3c4" stroke-width="2.5"/>' : '') +
      (cur.length ? '<path d="' + path(cur) + '" fill="none" stroke="#d9822b" stroke-width="3"/>' : '') +
      '<text x="' + pad + '" y="12" font-size="10" fill="#6b756e">' + Math.round(max) + '</text></svg>';
  }

  function ensureCss() {
    if (document.getElementById('whCss')) return;
    var s = document.createElement('style');
    s.id = 'whCss';
    s.textContent =
      '.wh{max-width:900px !important;width:100%;}.wh-h{display:flex;gap:8px;align-items:center;}.wh-h h2{flex:1;margin:0;font-size:1.15rem;}' +
      '.wh-src{font-size:.74rem;color:var(--text-muted,#6f7b72);margin:2px 0 10px;}' +
      '.wh-k{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-bottom:12px;}' +
      '.wh-k div{background:var(--tonal,#f2f6ef);border-radius:14px;padding:9px 10px;}.wh-k b{display:block;font-size:1.2rem;}.wh-k span{font-size:.72rem;color:var(--text-muted,#6f7b72);}.wh-k small{display:block;font-size:.7rem;color:var(--text-muted,#6f7b72);}' +
      '.wh-sec{border:1px solid var(--line,#e6ebe2);border-radius:16px;padding:10px 12px;margin-bottom:10px;background:var(--card,#fff);}.wh-sec h3{margin:0 0 6px;font-size:.95rem;}' +
      '.wh-lg{font-size:.72rem;color:var(--text-muted,#6f7b72);}.wh-lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin:0 4px -1px 0;}' +
      '.wh-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:.8rem;margin-bottom:6px;}.wh-row .form-input{width:auto !important;margin:0 !important;padding:5px 8px !important;}' +
      '.wh-t{width:100%;border-collapse:collapse;font-size:.78rem;}.wh-t th{background:var(--tonal,#f1f4ee);padding:6px 5px;font-weight:600;font-size:.72rem;text-align:right;}.wh-t td{padding:6px 5px;border-top:1px solid var(--line,#eef1ec);}' +
      '.wh-t input{width:80px;margin:0 !important;padding:4px 6px !important;}.wh-up{color:#b3261e;font-weight:700;}.wh-dn{color:#b06a12;font-weight:700;}.wh-ok{color:#2e7d32;font-weight:700;}' +
      '.wh-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:7px 12px;font:inherit;font-weight:600;font-size:.8rem;cursor:pointer;}' +
      '.wh-ev{max-height:240px;overflow-y:auto;}';
    document.head.appendChild(s);
  }

  function paint() {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    var head = '<div class="wh-h"><h2>📊 ' + tt('מזג אוויר נמדד', 'สภาพอากาศที่วัดได้', 'الطقس المقاس') + ' · ' + esc(farmName(ui.fid)) + '</h2>' +
      (ui.cur ? '<button class="wh-btn" data-wh="print">🖨 ' + tt('דוח עונה להדפסה', 'พิมพ์รายงาน', 'طباعة التقرير') + '</button>' : '') +
      '<button class="wh-btn" data-wh="close">✕</button></div>';
    var body;
    if (ui.err) body = '<div class="wh-sec">' + esc(ui.err) + '</div>';
    else if (!ui.cur) body = '<div class="wh-sec">⏳ ' + tt('טוען נתונים מתחנות השירות המטאורולוגי… בפעם הראשונה זה יכול לקחת עד דקה', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>';
    else body = content();
    m.innerHTML = '<div class="modal-overlay" id="whRoot"><div class="modal wh">' + head + body + '</div></div>';
    var root = document.getElementById('whRoot');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
  }

  function stationsLine(x) {
    var st = (x && x.stations) || {}, parts = [];
    var add = function (k, label) { if (st[k]) parts.push(label + ': ' + esc(st[k].name) + ' (' + st[k].km + ' ' + tt('ק״מ', 'กม.', 'كم') + ')'); };
    add('temp', tt('טמפרטורה', 'อุณหภูมิ', 'الحرارة')); add('rain', tt('גשם', 'ฝน', 'مطر')); add('rad', tt('קרינה', 'รังสี', 'إشعاع')); add('wind', tt('רוח', 'ลม', 'رياح'));
    return tt('תחנות השירות המטאורולוגי', 'สถานี IMS', 'محطات الأرصاد') + ' · ' + parts.join(' · ');
  }

  function content() {
    var cAll = ui.cur.days || [], pAll = (ui.prev && ui.prev.days) || [];
    var c = cAll.filter(function (d) { return d.d >= ui.s.from; }), p = pAll.filter(function (d) { return d.d >= ui.s.pFrom; });
    var rainC = sum(c, 'rain'), rainP = sum(p, 'rain');
    var hot35 = count(c, function (d) { return d.tmax >= 35; }), hot40 = count(c, function (d) { return d.tmax >= 40; });
    var tmax = c.reduce(function (m, d) { return d.tmax != null && (m == null || d.tmax > m.tmax) ? d : m; }, null);
    var rainDays = count(c, function (d) { return d.rain >= 1; });
    var last7 = c.slice(-7), et7 = sum(last7, 'et0');
    var miss = count(c, function (d) { return d.tmax == null; });
    var k = '<div class="wh-k">' +
      '<div><span>' + tt('גשם מ־1 בספטמבר', 'ฝนตั้งแต่ 1 ก.ย.', 'المطر منذ 1 سبتمبر') + '</span><b>' + r1(rainC) + ' ' + tt('מ״מ', 'มม.', 'مم') + '</b><small>' + tt('אשתקד באותו מועד', 'ปีก่อน', 'العام الماضي') + ': ' + r1(rainP) + '</small></div>' +
      '<div><span>' + tt('ימי גשם (≥1 מ״מ)', 'วันฝน', 'أيام المطر') + '</span><b>' + rainDays + '</b><small>' + tt('אשתקד', 'ปีก่อน', 'العام الماضي') + ': ' + count(p, function (d) { return d.rain >= 1; }) + '</small></div>' +
      '<div><span>' + tt('ימים ≥35° / ≥40°', 'วัน ≥35° / ≥40°', 'أيام ≥35° / ≥40°') + '</span><b>' + hot35 + ' / ' + hot40 + '</b><small>' + tt('מתחילת העונה', 'ตั้งแต่ต้นฤดู', 'منذ بداية الموسم') + '</small></div>' +
      '<div><span>' + tt('הטמפ׳ הגבוהה בעונה', 'สูงสุด', 'الأعلى') + '</span><b>' + (tmax ? tmax.tmax + '°' : '-') + '</b><small>' + (tmax ? fmtDY(tmax.d) : '') + '</small></div>' +
      '<div><span>' + tt('התאדות מחושבת, 7 ימים', 'การระเหยคำนวณ 7 วัน', 'تبخر محسوب 7 أيام') + '</span><b>' + r1(et7) + ' ' + tt('מ״מ', 'มม.', 'مم') + '</b><small>' + tt('ממוצע', 'เฉลี่ย', 'المتوسط') + ' ' + r1(et7 / Math.max(1, last7.length)) + ' ' + tt('ליום', 'ต่อวัน', 'يوميًا') + '</small></div>' +
    '</div>';
    var mC = monthly(c), mP = monthly(p), anyRain = mC.concat(mP).some(function (v) { return v > 0; });
    var rain = '<div class="wh-sec"><h3>🌧 ' + tt('גשם לפי חודשים', 'ฝนรายเดือน', 'المطر شهريًا') + '</h3>' +
      (anyRain ? barsSvg(mC, mP) + '<div class="wh-lg"><i style="background:#2f7fbf"></i>' + tt('העונה', 'ฤดูนี้', 'هذا الموسم') + ' &nbsp; <i style="background:#c8d3c4"></i>' + tt('אשתקד, עד אותו תאריך', 'ปีก่อน', 'العام الماضي') + '</div>'
        : '<div class="wh-lg">' + tt('לא ירד גשם מ־1 בספטמבר, גם לא אשתקד באותה תקופה.', 'ยังไม่มีฝน', 'لم تمطر بعد') + '</div>') + '</div>';
    // degree days
    var all = pAll.concat(cAll), from = ui.from, base = ui.base;
    var g1 = gdd(all, from, base);
    var pFrom = (Number(from.slice(0, 4)) - 1) + from.slice(4), lastYearEnd = addDays(cAll.length ? cAll[cAll.length - 1].d : ymd(new Date()), -365);
    var g0 = gdd(all.filter(function (d) { return d.d <= lastYearEnd; }), pFrom, base);
    var dd = '<div class="wh-sec"><h3>🌡 ' + tt('צבירת חום (מעלות־יום)', 'การสะสมความร้อน', 'تراكم الحرارة') + '</h3>' +
      '<div class="wh-row">' + tt('טמפ׳ בסיס', 'อุณหภูมิฐาน', 'حرارة الأساس') + ' <input class="form-input" type="number" step="0.5" id="whBase" value="' + base + '" style="width:70px !important;">° · ' +
        tt('מתאריך', 'ตั้งแต่', 'من تاريخ') + ' <input class="form-input" type="date" id="whFrom" value="' + esc(from) + '"></div>' +
      '<div style="font-size:1.05rem;margin:2px 0 4px;"><b>' + Math.round(g1.length ? g1[g1.length - 1][1] : 0) + '</b> ' + tt('מעלות־יום', 'องศา-วัน', 'درجة-يوم') +
        ' <span class="wh-lg">(' + tt('אשתקד באותו מועד', 'ปีก่อน', 'العام الماضي') + ': ' + Math.round(g0.length ? g0[g0.length - 1][1] : 0) + ')</span></div>' +
      (ui.more === true ? '<div class="wh-lg">⏳ ' + tt('טוען את החודשים שלפני העונה…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>'
        : ui.more === 'fail' ? '<div class="wh-lg">⚠️ ' + tt('החודשים שלפני העונה לא נטענו (השירות המטאורולוגי איטי) - פתח שוב בעוד דקה', 'โหลดไม่ได้', 'تعذر التحميل') + '</div>' : '') +
      lineSvg(g1, g0) + '<div class="wh-lg"><i style="background:#d9822b"></i>' + tt('השנה', 'ปีนี้', 'هذا العام') + ' &nbsp; <i style="background:#c8d3c4"></i>' + tt('אשתקד', 'ปีก่อน', 'العام الماضي') +
      ' · ' + tt('מעלות־יום = סכום (ממוצע יומי פחות טמפ׳ הבסיס) בימים שמעליה', 'ผลรวมของ (เฉลี่ย − ฐาน)', 'مجموع (المتوسط − الأساس)') + '</div></div>';
    return '<div class="wh-src">' + stationsLine(ui.cur) + (miss ? ' · ' + miss + ' ' + tt('ימים בלי נתוני טמפרטורה', 'วันไม่มีข้อมูล', 'أيام بلا بيانات') : '') +
        (S().canEditFarm && S().canEditFarm(ui.fid) ? ' <button class="wh-btn" style="padding:3px 9px;font-size:.72rem;" data-wh="pick">🛰 ' + tt('בחירת תחנה', 'เลือกสถานี', 'اختيار المحطة') + '</button>' : '') + '</div>' +
      (ui.pick ? pickHtml() : '') +
      k + dataTable(cAll) + rain + dd + irrigation(cAll) + events(c);
  }

  function irrigation(c) {
    var wk = lastWeek(), days = c.filter(function (d) { return d.d >= wk.from && d.d <= wk.to; });
    var et = sum(days, 'et0');
    var plots = (S().getFarmPlots ? S().getFarmPlots(ui.fid) : []).filter(function (p) { return Number(p.area) > 0; });
    var head = '<div class="wh-sec"><h3>💧 ' + tt('השקיה: מומלץ לפי התאדות נמדדת מול מה שניתן', 'การให้น้ำ: แนะนำเทียบกับที่ให้', 'الري: الموصى به مقابل المعطى') + '</h3>' +
      '<div class="wh-lg" style="margin-bottom:6px;">' + tt('שבוע', 'สัปดาห์', 'الأسبوع') + ' ' + fmtD(wk.from) + '–' + fmtD(wk.to) + ' · ' + tt('התאדות מחושבת מנתוני התחנה', 'การระเหยคำนวณจากสถานี', 'تبخر محسوب من بيانات المحطة') + ' <b>' + r1(et) + ' ' + tt('מ״מ', 'มม.', 'مم') + '</b>' +
        (days.some(function (d) { return d.et0m === 'hg'; }) ? ' (' + tt('בחלק מהימים בלי לחות או רוח: חישוב לפי טמפרטורות בלבד', 'บางวันคำนวณจากอุณหภูมิ', 'بعض الأيام حسب الحرارة') + ')'
          : days.some(function (d) { return d.et0m === 'pm-est'; }) ? ' (' + tt('פנמן־מונטית עם לחות ורוח מהתחנה; קרינה מוערכת מטווח הטמפרטורות - אין תחנת קרינה קרובה', 'Penman-Monteith รังสีประมาณ', 'بنمان-مونتيث مع إشعاع مقدّر') + ')'
          : ' (' + tt('פנמן־מונטית מלא', 'Penman-Monteith', 'بنمان-مونتيث') + ')') +
        ' · ' + tt('1 מ״מ = 1 מ״ק לדונם', '1 มม. = 1 ลบ.ม./ไร่', '1 مم = 1 م³/دونم') + '</div>';
    if (!days.length) return head + '<div class="wh-lg">' + tt('אין עדיין נתונים לשבוע הזה', 'ยังไม่มีข้อมูล', 'لا بيانات بعد') + '</div></div>';
    if (!window.PlotRec || !PlotRec._irr) return head + '</div>';
    var rows = plots.map(function (p) {
      // per-day recommendation summed (coefficient × that day's ET0)
      var rec = 0, unit = null;
      days.forEach(function (d) { var ic = PlotRec._irr(p, d.et0 || 0); if (ic && ic.plotDay != null) { rec += ic.plotDay; unit = ic.e; } });
      var given = PlotRec.getGiven ? PlotRec.getGiven(p.id, wk.from) : null;
      var diff = (given != null && rec > 0) ? Math.round((given - rec) / rec * 100) : null;
      var cls = diff == null ? '' : diff > 15 ? 'wh-up' : diff < -15 ? 'wh-dn' : 'wh-ok';
      return '<tr><td><b>' + esc(p.name) + '</b><small style="display:block;color:var(--text-muted)">' + r1(p.area) + ' ' + tt('ד׳', 'ไร่', 'د') + (unit ? ' · ' + tt('מקדם', 'ค่าสัมประสิทธิ์', 'معامل') + ' ' + r1(unit.v) : '') + '</small></td>' +
        '<td>' + (unit ? '<b>' + Math.round(rec) + '</b> ' + tt('מ״ק', 'ลบ.ม.', 'م³') + '<small style="display:block;color:var(--text-muted)">' + r1(rec / p.area) + ' ' + tt('מ״ק/ד׳', 'ลบ.ม./ไร่', 'م³/دونم') + '</small>' : '<span class="wh-lg">' + tt('אין מקדם לגידול', 'ไม่มีค่า', 'لا معامل') + '</span>') + '</td>' +
        '<td><input class="form-input" type="number" step="any" min="0" data-given="' + p.id + '" value="' + (given != null ? given : '') + '" placeholder="' + tt('מ״ק', 'ลบ.ม.', 'م³') + '"></td>' +
        '<td class="' + cls + '">' + (diff == null ? '' : (diff > 0 ? '+' : '') + diff + '%') + '</td></tr>';
    }).join('');
    return head + '<div style="overflow-x:auto;"><table class="wh-t"><thead><tr><th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th><th>' + tt('מומלץ לשבוע', 'แนะนำ', 'موصى به') + '</th><th>' + tt('ניתן בפועל', 'ให้จริง', 'المعطى') + '</th><th>' + tt('הפרש', 'ต่าง', 'الفرق') + '</th></tr></thead><tbody>' +
      (rows || '<tr><td colspan="4">' + tt('אין חלקות עם שטח', 'ไม่มีแปลง', 'لا قطع') + '</td></tr>') + '</tbody></table></div>' +
      '<div class="wh-lg" style="margin-top:4px;">' + tt('המקדמים לפי גידול וחודש נערכים בכרטיס החלקה ← המלצות גידול ← השקיה. הפרש מעל 15% מסומן.', 'แก้ค่าสัมประสิทธิ์ได้ในการ์ดแปลง', 'تُعدّل المعاملات في بطاقة القطعة') + '</div></div>';
  }

  function eventList(c) {
    var ev = [];
    c.forEach(function (d) {
      if (d.rain >= 1) ev.push([d.d, '🌧', tt('גשם', 'ฝน', 'مطر') + ' ' + r1(d.rain) + ' ' + tt('מ״מ', 'มม.', 'مم')]);
      if (d.tmax >= 40) ev.push([d.d, '🔥', tt('חום', 'ร้อน', 'حر') + ' ' + d.tmax + '°']);
      if (d.tmin != null && d.tmin <= 2) ev.push([d.d, '❄️', tt('קרה', 'น้ำค้างแข็ง', 'صقيع') + ' ' + d.tmin + '°']);
      if (d.wsmax >= 60) ev.push([d.d, '💨', tt('משב רוח', 'ลมกระโชก', 'هبة رياح') + ' ' + Math.round(d.wsmax) + ' ' + tt('קמ״ש', 'กม./ชม.', 'كم/س')]);
    });
    return ev.reverse();
  }
  function events(c) {
    var ev = eventList(c);
    return '<div class="wh-sec"><h3>📌 ' + tt('אירועים מתחילת העונה', 'เหตุการณ์ตั้งแต่ต้นฤดู', 'الأحداث منذ بداية الموسم') + ' (' + ev.length + ')</h3>' +
      (ev.length ? '<div class="wh-ev"><table class="wh-t"><tbody>' + ev.map(function (e) { return '<tr><td style="width:90px;">' + fmtDY(e[0]) + '</td><td>' + e[1] + ' ' + esc(e[2]) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<div class="wh-lg">' + tt('אין אירועים חריגים', 'ไม่มีเหตุการณ์', 'لا أحداث') + '</div>') +
      '<div class="wh-lg" style="margin-top:4px;">' + tt('גשם ≥1 מ״מ · חום ≥40° · קרה ≤2° · משב ≥60 קמ״ש', 'ฝน ≥1 · ร้อน ≥40 · หนาว ≤2 · ลม ≥60', 'مطر ≥1 · حر ≥40 · صقيع ≤2 · رياح ≥60') + '</div></div>';
  }

  // printable season record - every day, from the official stations
  function printReport() {
    var c = (ui.cur.days || []).filter(function (d) { return d.d >= ui.s.from; }), name = farmName(ui.fid), ev = eventList(c);
    var rows = c.map(function (d) {
      var v = function (x, u) { return x == null ? '-' : x + (u || ''); };
      return '<tr><td>' + fmtDY(d.d) + '</td><td>' + v(d.tmax) + '</td><td>' + v(d.tmin) + '</td><td>' + v(d.rh, '%') + '</td><td>' + v(d.wsmax) + '</td><td>' + v(d.rain) + '</td><td>' + v(d.et0) + '</td></tr>';
    }).join('');
    var html = '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' + esc(name) + ' - ' + tt('נתוני מזג אוויר', 'ข้อมูลอากาศ', 'بيانات الطقس') + '</title>' +
      '<link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;600;700&display=swap" rel="stylesheet">' +
      '<style>@page{size:A4;margin:14mm}body{font-family:Rubik,Arial,sans-serif;color:#1b1b1b;font-size:11px}h1{font-size:18px;margin:0}h2{font-size:13px;margin:14px 0 4px}' +
      '.s{color:#555;margin:3px 0 10px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #ddd;padding:3px 5px;text-align:right}th{background:#eef3ec}tr{break-inside:avoid}thead{display:table-header-group}</style></head><body>' +
      '<h1>' + esc(name) + ' - ' + tt('נתוני מזג אוויר נמדדים', 'ข้อมูลอากาศที่วัด', 'بيانات الطقس المقاسة') + '</h1>' +
      '<div class="s">' + fmtDY(ui.s.from) + ' – ' + fmtDY(ui.s.to) + ' · ' + stationsLine(ui.cur) + '<br>' + tt('מקור: השירות המטאורולוגי (IMS). השירות המטאורולוגי אינו אחראי למידע ואינו צד לפרסומו.', 'ที่มา: IMS', 'المصدر: IMS') + ' · ' + tt('הופק', 'สร้าง', 'أُنشئ') + ' ' + new Date().toLocaleDateString('he-IL') + '</div>' +
      '<h2>' + tt('סיכום', 'สรุป', 'ملخص') + '</h2><table><tr><th>' + tt('גשם בעונה', 'ฝน', 'المطر') + '</th><th>' + tt('ימי גשם', 'วันฝน', 'أيام مطر') + '</th><th>' + tt('ימים ≥40°', 'วัน ≥40°', 'أيام ≥40°') + '</th><th>' + tt('קרה ≤2°', 'หนาว', 'صقيع') + '</th></tr>' +
        '<tr><td>' + r1(sum(c, 'rain')) + ' ' + tt('מ״מ', 'มม.', 'مم') + '</td><td>' + count(c, function (d) { return d.rain >= 1; }) + '</td><td>' + count(c, function (d) { return d.tmax >= 40; }) + '</td><td>' + count(c, function (d) { return d.tmin != null && d.tmin <= 2; }) + '</td></tr></table>' +
      (ev.length ? '<h2>' + tt('אירועים', 'เหตุการณ์', 'أحداث') + '</h2><table>' + ev.map(function (e) { return '<tr><td style="width:90px">' + fmtDY(e[0]) + '</td><td>' + esc(e[2]) + '</td></tr>'; }).join('') + '</table>' : '') +
      '<h2>' + tt('נתונים יומיים', 'ข้อมูลรายวัน', 'بيانات يومية') + '</h2><table><thead><tr><th>' + tt('תאריך', 'วันที่', 'التاريخ') + '</th><th>' + tt('מקס׳ °', 'สูงสุด', 'العظمى') + '</th><th>' + tt('מינ׳ °', 'ต่ำสุด', 'الصغرى') + '</th><th>' + tt('לחות', 'ความชื้น', 'رطوبة') + '</th><th>' + tt('משב מקס׳ קמ״ש', 'ลมสูงสุด', 'أقصى هبة') + '</th><th>' + tt('גשם מ״מ', 'ฝน มม.', 'مطر مم') + '</th><th>ET0</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { toast('⚠️ ' + tt('החלון נחסם - אפשר חלונות קופצים', 'ป๊อปอัพถูกบล็อก', 'تم حظر النافذة')); return; }
    w.document.open(); w.document.write(html); w.document.close();
    setTimeout(function () { try { w.focus(); w.print(); } catch (e) {} }, 700);
  }

  function saveSettings() { try { localStorage.setItem('shorashim-wxhist-' + ui.fid, JSON.stringify({ base: ui.base, from: ui.from })); } catch (e) {} }
  // Choosing the station that stands for the farm. Mountain and valley lie
  // side by side here, so the nearest station can have another climate
  // altogether (a valley farm 17 km from a hilltop station); the list shows
  // distance, altitude when IMS gives it, and what each station measures.
  function pickHtml() {
    if (ui.pick === 'load') return '<div class="wh-sec">⏳ ' + tt('טוען רשימת תחנות…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>';
    var cur = point(ui.fid), chosen = cur && cur.station, chosenRad = cur && cur.radStation;
    var lab = function (ch) { return [ch.indexOf('TD') >= 0 ? tt('טמפ׳', 'อุณหภูมิ', 'حرارة') : '', ch.indexOf('Rain') >= 0 ? tt('גשם', 'ฝน', 'مطر') : '', ch.indexOf('WS') >= 0 ? tt('רוח', 'ลม', 'رياح') : '', ch.indexOf('Grad') >= 0 ? tt('קרינה', 'รังสี', 'إشعاع') : ''].filter(Boolean).join(' · '); };
    return '<div class="wh-sec"><h3>🛰 ' + tt('התחנה שמייצגת את המשק', 'สถานีของฟาร์ม', 'محطة المزرعة') + '</h3>' +
      '<div class="wh-lg" style="margin-bottom:6px;">' + tt('ברירת המחדל היא התחנה הקרובה ביותר. במשק בעמק ליד תחנה בהר כדאי לבחור תחנה בעמק גם אם היא רחוקה יותר. הבחירה חלה על כל נתוני השירות המטאורולוגי של המשק: מזג אוויר, רישומי ריסוס והתראות.', 'ค่าเริ่มต้นคือสถานีที่ใกล้ที่สุด', 'الافتراضي هو الأقرب') + '</div>' +
      '<select class="form-input" id="whStation" style="width:100% !important;"><option value="">' + tt('אוטומטי - הקרובה ביותר', 'อัตโนมัติ', 'تلقائي - الأقرب') + '</option>' +
      (ui.pick || []).filter(function (x) { return x.km <= 70 && (x.channels.indexOf('TD') >= 0 || x.channels.indexOf('Rain') >= 0); }).map(function (x) {
        return '<option value="' + esc(x.id) + '"' + (String(chosen) === String(x.id) ? ' selected' : '') + '>' + esc(x.name) + ' · ' + x.km + ' ' + tt('ק״מ', 'กม.', 'كم') + (x.alt != null ? ' · ' + x.alt + ' ' + tt('מ׳', 'ม.', 'م') : '') + ' · ' + esc(lab(x.channels)) + '</option>';
      }).join('') + '</select>' +
      // radiation feeds only the evaporation; few stations measure it, so a
      // valley farm can take it from a lowland station further away
      '<h3 style="margin-top:12px;">☀️ ' + tt('תחנת קרינה (לחישוב ההתאדות)', 'สถานีรังสี (สำหรับการระเหย)', 'محطة الإشعاع (للتبخر)') + '</h3>' +
      '<div class="wh-lg" style="margin-bottom:6px;">' + tt('רק תחנות מעטות מודדות קרינת שמש. בלי תחנה בטווח 25 ק״מ הקרינה מוערכת מהפרש הטמפרטורות (סטייה של כ־6% בבדיקה מול תחנת צבי). קרינה נמדדת מתחנת שפלה (חוות עדן, בית דגן) התאימה בכ־4%. ביום מעונן מקומית בתחנה הרחוקה הערך יכול לסטות.', 'มีไม่กี่สถานีที่วัดรังสี', 'قلة من المحطات تقيس الإشعاع') + '</div>' +
      '<select class="form-input" id="whRadStation" style="width:100% !important;"><option value="">' + tt('אוטומטי - קרובה עד 25 ק״מ, אחרת הערכה', 'อัตโนมัติ', 'تلقائي') + '</option>' +
      (ui.pick || []).filter(function (x) { return x.channels.indexOf('Grad') >= 0; }).map(function (x) {
        return '<option value="' + esc(x.id) + '"' + (String(chosenRad) === String(x.id) ? ' selected' : '') + '>' + esc(x.name) + ' · ' + x.km + ' ' + tt('ק״מ', 'กม.', 'كم') + (x.alt != null ? ' · ' + x.alt + ' ' + tt('מ׳', 'ม.', 'م') : '') + '</option>';
      }).join('') + '</select></div>';
  }
  function loadStations() {
    var pt = point(ui.fid); if (!pt) return;
    ui.pick = 'load'; paint();
    var fn = firebase.app().functions('us-central1').httpsCallable('imsData', { timeout: 60000 });
    fn({ mode: 'stations', lat: pt.lat, lon: pt.lon, km: 120 }).then(function (r) { ui.pick = (r && r.data && r.data.stations) || []; paint(); },
      function (e) { ui.pick = null; toast('❌ ' + ((e && (e.code || e.message)) || '')); paint(); });
  }
  // ── the measurements, for any dates ──
  // Daily figures for a chosen range (from what is loaded, or fetched); a
  // day opens hour by hour (mode "day"). Both can be saved as CSV.
  function tblRange() {
    if (!ui.tbl) { var to = ui.s.to; ui.tbl = { from: addDays(to, -13), to: to }; }
    return ui.tbl;
  }
  function tblDays(cAll) {
    var t = tblRange();
    var have = cAll.length && cAll[0].d <= t.from && cAll[cAll.length - 1].d >= t.to;
    if (have) return cAll.filter(function (d) { return d.d >= t.from && d.d <= t.to; });
    if (ui.tblData && ui.tblData.key === t.from + t.to) return ui.tblData.days;
    if (ui.tblLoading !== t.from + t.to) {
      ui.tblLoading = t.from + t.to;
      var pt = point(ui.fid), key = t.from + t.to;
      fetchDays(pt, t.from, t.to).then(function (x) { ui.tblData = { key: key, days: (x && x.days) || [] }; ui.tblLoading = null; paint(); },
        function (e) { ui.tblLoading = null; ui.tblData = { key: key, days: [], err: (e && (e.code || e.message)) || '' }; paint(); });
    }
    return null;
  }
  function DCOLS() { return [['d', tt('תאריך', 'วันที่', 'التاريخ')], ['tmax', tt('מקס׳ °', 'สูงสุด °', 'العظمى °')], ['tmin', tt('מינ׳ °', 'ต่ำสุด °', 'الصغرى °')], ['tmean', tt('ממוצע °', 'เฉลี่ย °', 'المتوسط °')],
    ['rh', tt('לחות %', 'ความชื้น %', 'رطوبة %')], ['ws', tt('רוח ממוצעת קמ״ש', 'ลมเฉลี่ย', 'متوسط الرياح')], ['wsmax', tt('משב מקס׳ קמ״ש', 'ลมกระโชกสูงสุด', 'أقصى هبة')], ['rain', tt('גשם מ״מ', 'ฝน มม.', 'مطر مم')],
    ['rs', tt('קרינה MJ/m²', 'รังสี MJ/m²', 'إشعاع MJ/m²')], ['et0', tt('התאדות מחושבת מ״מ', 'การระเหย (คำนวณ) มม.', 'تبخر محسوب مم')]].concat(mopOn() ? [['mop', tt('התאדות מו״פ מ״מ', 'การระเหย มอพ. มม.', 'تبخر مو"ف مم')]] : []); }
  // ── the Jordan Valley R&D (מו״פ) published evaporation, as an extra
  // column next to ours: their nearest station (or the farm's chosen one),
  // fetched per table range through the server (their site has no CORS) ──
  function mopOn() { try { return localStorage.getItem('shorashim-wxhist-mop') === '1'; } catch (e) { return false; } }
  function mopFor(t) {
    var key = ui.fid + '|' + t.from + t.to + '|' + ((point(ui.fid) || {}).mopStation || '');
    if (ui.mop && ui.mop.key === key) return ui.mop;
    if (ui.mopLoading !== key) {
      ui.mopLoading = key;
      var pt = point(ui.fid) || {}, fn = firebase.app().functions('us-central1').httpsCallable('imsData', { timeout: 120000 });
      fn({ mode: 'mop', lat: pt.lat, lon: pt.lon, mopStation: pt.mopStation || '', from: t.from, to: t.to }).then(function (r) {
        var x = (r && r.data) || {}, by = {};
        (x.days || []).forEach(function (d) { by[d.d] = d; });
        ui.mop = { key: key, by: by, station: x.station || null, stations: x.stations || [], err: x.err || '' }; ui.mopLoading = null; paint();
      }, function (e) { ui.mop = { key: key, by: {}, stations: [], err: (e && (e.code || e.message)) || '' }; ui.mopLoading = null; paint(); });
    }
    return null;
  }
  function mopBar(t) {
    var on = mopOn(), m = on ? mopFor(t) : null, pt = point(ui.fid) || {};
    var h = '<div class="wh-row" style="margin-top:4px;"><label style="display:inline-flex;align-items:center;gap:4px;cursor:pointer;"><input type="checkbox" id="whMop"' + (on ? ' checked' : '') + '> ' +
      tt('הצג עמודת התאדות מאתר מו״פ בקעת הירדן', 'แสดงการระเหยจาก มอพ.', 'عرض تبخر مو"ف غور الأردن') + '</label>';
    if (on && !m) h += ' <span class="wh-lg">⏳ ' + tt('טוען מאתר המו״פ…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</span>';
    if (on && m) {
      var canEdit = S().canEditFarm && S().canEditFarm(ui.fid);
      h += ' <span class="wh-lg">' + tt('תחנה', 'สถานี', 'محطة') + ':</span> ' + (canEdit && m.stations.length ? '<select class="form-input" id="whMopSt" style="width:auto !important;padding:2px 6px;"><option value="">' +
        tt('אוטומטי - הקרובה', 'อัตโนมัติ', 'تلقائي') + (m.station && !m.station.chosen ? ' (' + esc(m.station.name) + ')' : '') + '</option>' +
        m.stations.map(function (s) { return '<option value="' + s.n + '"' + (String(pt.mopStation) === String(s.n) ? ' selected' : '') + '>' + esc(s.name) + (s.km != null ? ' · ' + s.km + ' ' + tt('ק״מ', 'กม.', 'كم') : '') + '</option>'; }).join('') + '</select>'
        : '<b>' + esc(m.station ? m.station.name : '-') + '</b>');
      if (m.err) h += ' <span class="wh-lg">⚠️ ' + tt('אתר המו״פ לא ענה במלואו', 'เว็บไซต์ไม่ตอบ', 'الموقع لم يستجب') + ' (' + esc(m.err) + ')</span>';
    }
    return h + '</div>' + (on && m ? '<div class="wh-lg">' + tt('כפי שפורסם באתר המו״פ (פנמן-מונטיס לפי חישובם). הם מעדכנים באיחור של כמה ימים, ולכן הימים האחרונים יכולים להיות ריקים.', 'ตามที่เผยแพร่', 'كما نُشر') + '</div>' : '');
  }
  function HCOLS() { return [['h', tt('שעה', 'เวลา', 'الساعة')], ['temp', tt('טמפ׳ °', 'อุณหภูมิ °', 'الحرارة °')], ['tmax', tt('מקס׳', 'สูงสุด', 'العظمى')], ['tmin', tt('מינ׳', 'ต่ำสุด', 'الصغرى')],
    ['rh', tt('לחות %', 'ความชื้น %', 'رطوبة %')], ['ws', tt('רוח קמ״ש', 'ลม', 'رياح')], ['wsmax', tt('משב קמ״ש', 'ลมกระโชก', 'هبة')], ['wd', tt('כיוון °', 'ทิศ °', 'الاتجاه °')],
    ['rain', tt('גשם מ״מ', 'ฝน มม.', 'مطر مم')], ['rad', tt('קרינה W/m²', 'รังสี W/m²', 'إشعاع W/m²')]]; }
  function dataTable(cAll) {
    var t = tblRange(), days = tblDays(cAll), mop = mopOn() ? mopFor(t) : null;
    if (days && mop) days = days.map(function (d) { var x = mop.by[d.d]; return x && x.et0 != null ? Object.assign({}, d, { mop: x.et0 }) : d; });
    var head = '<div class="wh-sec"><h3>📋 ' + tt('כל נתוני המדידה לפי תאריכים', 'ข้อมูลตามวันที่', 'كل القياسات حسب التاريخ') + '</h3>' +
      '<div class="wh-row">' + tt('מ־', 'จาก', 'من') + ' <input class="form-input" type="date" id="whTF" value="' + t.from + '" max="' + ui.s.to + '"> ' +
        tt('עד', 'ถึง', 'إلى') + ' <input class="form-input" type="date" id="whTT" value="' + t.to + '" max="' + ui.s.to + '">' +
        (days && days.length ? ' <button class="wh-btn" data-wh="csv">⬇ CSV</button>' : '') + '</div>' + mopBar(t);
    if (!days) return head + '<div class="wh-lg">⏳ ' + tt('טוען את התאריכים האלה מהשירות המטאורולוגי…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div></div>';
    if (!days.length) return head + '<div class="wh-lg">' + (ui.tblData && ui.tblData.err ? '⚠️ ' + esc(ui.tblData.err) : tt('אין נתונים לתאריכים האלה', 'ไม่มีข้อมูล', 'لا بيانات')) + '</div></div>';
    var v = function (x) { return x == null ? '-' : x; };
    var rows = days.slice().reverse().map(function (d) {
      var open = ui.day === d.d;
      return '<tr data-wh-day="' + d.d + '" style="cursor:pointer;' + (open ? 'background:var(--tonal,#f2f6ef);' : '') + '">' + DCOLS().map(function (c) { return '<td>' + (c[0] === 'd' ? (open ? '▾ ' : '▸ ') + fmtDY(d.d) : v(d[c[0]])) + '</td>'; }).join('') + '</tr>' +
        (open ? '<tr><td colspan="' + DCOLS().length + '" style="background:#fafcf9;">' + dayHtml() + '</td></tr>' : '');
    }).join('');
    return head + '<div style="overflow-x:auto;max-height:420px;overflow-y:auto;"><table class="wh-t"><thead><tr>' + DCOLS().map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>' +
      '<div class="wh-lg" style="margin-top:4px;">' + tt('לחיצה על יום פותחת אותו שעה אחרי שעה. שעות לפי שעון חורף, כפי שהשירות המטאורולוגי שומר אותן.', 'คลิกวันเพื่อดูรายชั่วโมง', 'انقر يومًا لعرضه بالساعات') + '</div></div>';
  }
  function dayHtml() {
    var x = ui.dayData;
    if (!x || x.d !== ui.day) return '⏳ ' + tt('טוען שעות…', 'กำลังโหลด…', 'جارٍ التحميل…');
    if (x.err) return '⚠️ ' + esc(x.err);
    if (!x.hours || !x.hours.length) return tt('אין נתונים שעתיים ליום הזה', 'ไม่มีข้อมูล', 'لا بيانات');
    var v = function (y) { return y == null ? '-' : y; };
    return '<div class="wh-lg" style="margin-bottom:4px;">' + tt('תחנת', 'สถานี', 'محطة') + ' ' + esc(x.station) + ' · ' + fmtDY(x.d) + ' <button class="wh-btn" style="padding:2px 8px;font-size:.7rem;" data-wh="csvday">⬇ CSV</button></div>' +
      '<table class="wh-t"><thead><tr>' + HCOLS().map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      x.hours.map(function (h) { return '<tr>' + HCOLS().map(function (c) { return '<td>' + (c[0] === 'h' ? h.h + ':00' : v(h[c[0]])) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }
  function openDay(d) {
    if (ui.day === d) { ui.day = null; return paint(); }
    ui.day = d; ui.dayData = null; paint();
    var pt = point(ui.fid), fn = firebase.app().functions('us-central1').httpsCallable('imsData', { timeout: 120000 });
    fn({ mode: 'day', lat: pt.lat, lon: pt.lon, station: pt.station, date: d }).then(function (r) {
      var x = (r && r.data) || {}; ui.dayData = { d: d, station: x.station || '', hours: x.hours || [] }; if (ui.day === d) paint();
    }, function (e) { ui.dayData = { d: d, err: (e && (e.code || e.message)) || '' }; if (ui.day === d) paint(); });
  }
  function csv(cols, rows, name) {
    var q = function (x) { x = x == null ? '' : String(x); return /[",\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    var txt = '\ufeff' + cols.map(function (c) { return q(c[1]); }).join(',') + '\n' + rows.map(function (r) { return cols.map(function (c) { return q(r[c[0]]); }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([txt], { type: 'text/csv;charset=utf-8' })); a.download = name + '.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }
  function onClick(e) {
    var dr = e.target.closest('[data-wh-day]');
    if (dr && !e.target.closest('button')) return openDay(dr.getAttribute('data-wh-day'));
    if (e.target.id === 'whRoot') return close();
    var b = e.target.closest('[data-wh]'); if (!b) return;
    var k = b.getAttribute('data-wh');
    if (k === 'close') return close();
    if (k === 'pick') { if (ui.pick) { ui.pick = null; return paint(); } return loadStations(); }
    if (k === 'print') return printReport();
    if (k === 'csv') { var cAll = (ui.cur && ui.cur.days) || [], ds = tblDays(cAll) || [], mc = mopOn() && ui.mop ? ui.mop.by : null;
      if (mc) ds = ds.map(function (d) { var x = mc[d.d]; return x && x.et0 != null ? Object.assign({}, d, { mop: x.et0 }) : d; }); return csv(DCOLS(), ds, 'ims-' + farmName(ui.fid) + '-' + tblRange().from + '_' + tblRange().to); }
    if (k === 'csvday' && ui.dayData && ui.dayData.hours) return csv(HCOLS(), ui.dayData.hours, 'ims-' + farmName(ui.fid) + '-' + ui.day);
  }
  function onChange(e) {
    var t = e.target;
    if (t.id === 'whTF' || t.id === 'whTT') {
      var r = tblRange(), f = t.id === 'whTF' ? t.value : r.from, to = t.id === 'whTT' ? t.value : r.to;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return;
      if (f > to) { var x = f; f = to; to = x; }
      if ((new Date(to) - new Date(f)) / 864e5 > 370) f = addDays(to, -370);
      ui.tbl = { from: f, to: to }; ui.day = null; return paint();
    }
    if (t.id === 'whMop') { try { localStorage.setItem('shorashim-wxhist-mop', t.checked ? '1' : '0'); } catch (er) {} return paint(); }
    if (t.id === 'whMopSt') {
      var rm = S().setImsStation ? S().setImsStation(ui.fid, t.value, 'mop') : { ok: false };
      if (!rm.ok) { toast('⛔ ' + tt('אין הרשאה לשנות את המשק', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      toast('✅ ' + tt('תחנת המו״פ נשמרה למשק', 'บันทึกแล้ว', 'تم الحفظ'));
      // the farm record updates through the store; read it again shortly
      ui.mop = null; setTimeout(paint, 300); return;
    }
    if (t.id === 'whStation' || t.id === 'whRadStation') {
      var r = S().setImsStation ? S().setImsStation(ui.fid, t.value, t.id === 'whRadStation' ? 'rad' : '') : { ok: false };
      if (!r.ok) { toast('⛔ ' + tt('אין הרשאה לשנות את המשק', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      toast('✅ ' + tt('התחנה נשמרה למשק', 'บันทึกแล้ว', 'تم الحفظ'));
      if (window.Weather && Weather.refresh) try { Weather.refresh(); } catch (er) {}
      ui.pick = null;
      return open(ui.fid);
    }
    if (t.id === 'whBase') { var v = Number(t.value); if (isFinite(v)) { ui.base = v; saveSettings(); paint(); } return; }
    if (t.id === 'whFrom') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(t.value)) return;
      ui.from = t.value; saveSettings();
      if (ui.loadedFrom && ui.from < ui.loadedFrom) { var pt0 = point(ui.fid); if (pt0) return loadEarlier(ui.fid, pt0); }
      paint(); return;
    }
    var g = t.getAttribute && t.getAttribute('data-given');
    if (g && window.PlotRec && PlotRec.setGiven) {
      PlotRec.setGiven(Number(g), lastWeek().from, t.value).then(function (ok) { if (ok) { toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ')); paint(); } });
    }
  }

  return { open: open, close: close };
})();
window.WxHist = WxHist;
