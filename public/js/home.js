/**
 * home.js — Home screen and phone bottom bar for the fresh layout (v149).
 *
 * Active only while <body> has .layout-fresh (הגדרות תצוגה → פריסה ועיצוב).
 * The classic layout never sees any of this: the בית tab and the bottom bar
 * are hidden by theme-soft.css, and nothing here runs its UI.
 *
 *   • Home tab (#tabHome): greeting, a hero card for the selected farm with
 *     live weather + spray window (Weather.summary), KPI tiles, round action
 *     buttons to the other tabs, the user's farms as cards, and an alerts /
 *     plots side panel (desktop puts these side by side).
 *   • Bottom bar (phones, < 900px): בית · מפה · [+] · ריסוס · עוד.
 *     [+] opens quick actions, עוד opens every tab the user can see.
 *
 * Reads only: SprayStore (farms/plots, permission-filtered), Weather, Fleet.
 * Writes only: localStorage 'shorashim-home-farm' (selected hero farm).
 * Actions reuse the existing tab buttons and quick-action buttons, so role
 * visibility and every tab's own render hooks stay in app.js.
 */
var Home = (function () {
  'use strict';

  var SEL_KEY = 'shorashim-home-farm';
  var G = '#12401f';

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
  function S() { return window.SprayStore || {}; }
  function isFresh() { return document.body.classList.contains('layout-fresh'); }
  function user() { return window.currentUser || null; }
  function fmt(n, d) { return (Number(n) || 0).toLocaleString('he-IL', { maximumFractionDigits: d == null ? 1 : d }); }

  // ── line icons (stroke) ──
  var P = {
    spray: '<rect x="3" y="9" width="8" height="12" rx="2.5"/><path d="M6 9V6h5M11 16c3 0 3-5 6-7l2-1.5"/><circle cx="21" cy="5" r=".8"/><circle cx="20" cy="2.8" r=".6"/>',
    drop: '<path d="M12 3s6 7 6 11a6 6 0 0 1-12 0c0-4 6-11 6-11z"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5"/>',
    map: '<path d="M9 4l6 2 6-2v14l-6 2-6-2-6 2V6z"/><path d="M9 4v14M15 6v14"/>',
    leaf: '<path d="M5 19c0-9 6-14 15-14 0 9-5 15-14 15"/><path d="M5 19l8-8"/>',
    box: '<path d="M3 7l9-4 9 4v10l-9 4-9-4z"/><path d="M3 7l9 4 9-4M12 11v10"/>',
    cam: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
    person: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21c0-4 3-7 7-7s7 3 7 7"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    home: '<path d="M3 11l9-7 9 7v9H3z"/><path d="M9 20v-6h6v6"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
    tractor: '<circle cx="8" cy="17" r="4"/><circle cx="19" cy="18" r="2.5"/><path d="M4 13V7h7l2 6M11 7v6h8l1.5 3M15 9h3v4"/>',
    signal: '<path d="M4 20v-3M9 20v-7M14 20V9M19 20V4"/>',
    pin: '<path d="M12 21s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20c0-4 3-6 7-6s7 2 7 6"/><path d="M16 4a3.5 3.5 0 0 1 0 7M18 14c2.5.5 4 2.5 4 6"/>',
    chev: '<path d="M14 6l-6 6 6 6"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 19V5M8 7h7"/>',
    sat: '<rect x="9" y="9" width="6" height="6" rx="1" transform="rotate(45 12 12)"/><path d="M4 4l4 4M16 16l4 4M7 3L3 7l3 3 4-4zM17 13l-4 4 3 3 4-4zM15 9l2-2"/>',
    bug: '<ellipse cx="12" cy="13" rx="5" ry="6"/><path d="M12 7V4M9 4l1.5 2M15 4l-1.5 2M7 11H3M7 15H3M17 11h4M17 15h4M12 9v10"/>'
  };
  function ic(n, c, s, w) {
    return '<svg width="' + (s || 22) + '" height="' + (s || 22) + '" viewBox="0 0 24 24" fill="none" stroke="' + (c || 'currentColor') +
      '" stroke-width="' + (w || 1.6) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[n] || '') + '</svg>';
  }

  // ── navigation helpers (reuse the real tab buttons) ──
  function tabEl(t) { return document.querySelector('.tab[data-tab="' + t + '"]'); }
  function tabAvail(t) { var el = tabEl(t); return !!el && el.style.display !== 'none'; }
  function go(t) { var el = tabEl(t); if (el) el.click(); syncNav(); window.scrollTo(0, 0); }
  function clickId(id) { var el = document.getElementById(id); if (el) el.click(); }

  var ACTIONS = [
    { k: 'spray', ic: 'spray', he: 'ריסוס', th: 'พ่นยา', ar: 'رش', tab: 'spray' },
    { k: 'irrigation', ic: 'drop', he: 'השקיה', th: 'ให้น้ำ', ar: 'ري', tab: 'irrigation' },
    { k: 'worklog', ic: 'cal', he: 'יומן עבודה', th: 'บันทึกงาน', ar: 'سجل العمل', tab: 'worklog' },
    { k: 'weather', ic: 'sun', he: 'מזג אוויר', th: 'สภาพอากาศ', ar: 'الطقس', tab: 'weather' },
    { k: 'map', ic: 'map', he: 'מפה', th: 'แผนที่', ar: 'خريطة', tab: 'map' },
    { k: 'farms', ic: 'leaf', he: 'שדות/מטעים', th: 'ไร่/สวน', ar: 'حقول/بساتين', tab: 'farms' },
    { k: 'harvest', ic: 'box', he: 'קטיף ומיון', th: 'เก็บเกี่ยว', ar: 'قطاف وفرز', tab: 'harvest' },
    { k: 'receipt', ic: 'cam', he: 'צלם תעודה', th: 'ถ่ายใบส่งของ', ar: 'تصوير مستند', fn: function () { clickId('qaCaptureReceipt'); }, need: 'qaCaptureReceipt' },
    { k: 'library', ic: 'book', he: 'מידע שימושי', th: 'คู่มือ', ar: 'معلومات', fn: function () { if (window.Knowledge) Knowledge.open(); }, need: '__Knowledge' },
    { k: 'traps', ic: 'bug', he: 'לכידות חדקונית', th: 'กับดักด้วง', ar: 'مصائد السوسة', fn: function () { if (window.Traps) Traps.open(); }, need: '__Traps' },
    { k: 'sat', ic: 'sat', he: 'לוויין', th: 'ดาวเทียม', ar: 'القمر الصناعي', fn: function () { if (window.Satellite) Satellite.open(); }, need: '__Satellite' },
    { k: 'profile', ic: 'person', he: 'אישי', th: 'ส่วนตัว', ar: 'شخصي', tab: 'profile' },
    { k: 'users', ic: 'users', he: 'משתמשים', th: 'ผู้ใช้', ar: 'المستخدمون', tab: 'users' },
    { k: 'menu', ic: 'menu', he: 'תפריט ודוחות', th: 'เมนู', ar: 'القائمة', fn: function () { if (window.TimeClock && TimeClock.toggleMenu) TimeClock.toggleMenu(); } }
  ];
  function actionsAvail() {
    return ACTIONS.filter(function (a) {
      if (a.tab) return tabAvail(a.tab);
      if (a.need === '__Knowledge') return !!window.Knowledge;
      if (a.need === '__Traps') return !!window.Traps;
      if (a.need === '__Satellite') return !!window.Satellite;
      if (a.need) return !!document.getElementById(a.need);
      return true;
    });
  }
  function runAction(k) {
    var a = ACTIONS.find(function (x) { return x.k === k; });
    if (!a) return;
    closeSheet();
    if (a.tab) go(a.tab); else if (a.fn) a.fn();
  }

  // ── data ──
  function farmsData() {
    var farms = S().getFarms ? S().getFarms() : [];
    var plots = S().getPlots ? S().getPlots() : [];
    return farms.map(function (f) {
      var ps = plots.filter(function (p) { return p.farm_id === f.id; });
      var crops = {};
      var area = 0, trees = 0;
      ps.forEach(function (p) {
        area += Number(p.area) || 0;
        trees += Number(p.tree_count) || 0;
        if (p.crop_type) crops[p.crop_type] = 1;
      });
      return { id: f.id, name: f.name, color: f.color || G, plots: ps, area: area, trees: trees, crops: Object.keys(crops) };
    });
  }
  function selFarm(list) {
    var id = null;
    try { id = JSON.parse(localStorage.getItem(SEL_KEY) || 'null'); } catch (e) {}
    return list.find(function (f) { return f.id === id; }) || list[0] || null;
  }

  function greeting() {
    var h = new Date().getHours();
    var g = h < 12 ? tt('בוקר טוב', 'อรุณสวัสดิ์', 'صباح الخير') : h < 17 ? tt('צהריים טובים', 'สวัสดีตอนบ่าย', 'نهارك سعيد') : h < 21 ? tt('ערב טוב', 'สวัสดีตอนเย็น', 'مساء الخير') : tt('לילה טוב', 'ราตรีสวัสดิ์', 'تصبح على خير');
    var u = user(), nm = u ? String(u.name || u.username || '').split(' ')[0] : '';
    return g + (nm ? ', ' + esc(nm) : '');
  }

  // ── pieces ──
  // The hub on the hero is a shortcut ring for the selected farm: each
  // circle opens that farm's view of irrigation, vehicles, spraying, map,
  // weather or navigation; the centre opens the farm card.
  var HUB = [
    { k: 'irr', ic: 'drop', he: 'השקיה', th: 'ให้น้ำ', ar: 'ري' },
    { k: 'veh', ic: 'tractor', he: 'כלים', th: 'ยานพาหนะ', ar: 'مركبات' },
    { k: 'spray', ic: 'spray', he: 'ריסוס', th: 'พ่นยา', ar: 'رش' },
    { k: 'wx', ic: 'sun', he: 'תחזית', th: 'พยากรณ์', ar: 'توقعات' },
    { k: 'nav', ic: 'pin', he: 'ניווט', th: 'นำทาง', ar: 'ملاحة' },
    { k: 'map', ic: 'map', he: 'מפה', th: 'แผนที่', ar: 'خريطة' }
  ];
  function hubHtml(f) {
    var cx = 50, cy = 50, R = 37, lines = '', dots = '';
    var fl = (f && window.Fleet && Fleet.farmAlerts && S().canEditFarm && S().canEditFarm(f.id)) ? Fleet.farmAlerts(f.id).length : 0;
    HUB.forEach(function (h, k) {
      var a = 2 * Math.PI * k / HUB.length - Math.PI / 2;
      var x = cx + R * Math.cos(a), y = cy + R * Math.sin(a);
      lines += '<line x1="' + cx + '%" y1="' + cy + '%" x2="' + x.toFixed(1) + '%" y2="' + y.toFixed(1) + '%"/>';
      var badge = (h.k === 'veh' && fl) ? '<i class="hm-hub-b">' + fl + '</i>' : '';
      dots += '<button type="button" class="hm-hub-c" data-hub="' + h.k + '" style="left:' + x.toFixed(1) + '%;top:' + y.toFixed(1) + '%" aria-label="' + tt(h.he, h.th, h.ar) + '">' +
        ic(h.ic, '#fff', 15, 1.6) + badge + '<span>' + tt(h.he, h.th, h.ar) + '</span></button>';
    });
    return '<div class="hm-hub"><svg width="100%" height="100%" aria-hidden="true">' + lines + '<circle cx="50%" cy="50%" r="16%" /></svg>' + dots +
      '<button type="button" class="hm-hub-m" data-hub="farm" aria-label="' + tt('פרטי משק', 'รายละเอียดฟาร์ม', 'تفاصيل المزرعة') + '">' + ic('leaf', G, 22, 1.8) + '</button></div>';
  }
  function hubGo(k, fid) {
    if (k === 'farm' || k === 'veh') { if (typeof window.showFarmDetailsGlobal === 'function') window.showFarmDetailsGlobal(fid); return; }
    if (k === 'irr') return go('irrigation');
    if (k === 'spray') return go('spray');
    if (k === 'wx') return go('weather');
    if (k === 'map') { if (S().zoomToFarm) { S().zoomToFarm(fid); syncNav(); } else go('map'); return; }
    if (k === 'nav') {
      var pt = (window.Weather && Weather._points ? Weather._points() : []).find(function (p) { return p.id === fid; });
      if (!pt) { if (typeof showToast === 'function') showToast(tt('אין חלקה ראשית ממופה למשק', 'ไม่มีแปลงหลัก', 'لا توجد قطعة رئيسية')); return; }
      window.open('https://www.google.com/maps/dir/?api=1&destination=' + pt.lat + ',' + pt.lon, '_blank');
    }
  }

  function heroHtml(f) {
    if (!f) return '<div class="hm-hero"><div class="hm-hero-t"><b>' + tt('אין משקים זמינים', 'ไม่มีฟาร์ม', 'لا توجد مزارع') + '</b></div></div>';
    return '<div class="hm-hero" id="hmHero" data-farm="' + f.id + '">' + hubHtml(f) +
      '<div class="hm-hero-t"><b>' + esc(f.name) + '</b>' +
        '<small>' + f.plots.length + ' ' + tt('חלקות', 'แปลง', 'قطع') + ' · ' + fmt(f.area) + ' ' + tt('דונם', 'ไร่', 'دونم') +
        (f.trees ? ' · ' + fmt(f.trees, 0) + ' ' + tt('עצים', 'ต้น', 'شجرة') : '') + '</small></div>' +
      '<div class="hm-wx" id="hmWx"><span class="hm-wx-load">' + tt('טוען מזג אוויר…', 'กำลังโหลด…', 'جارٍ تحميل الطقس…') + '</span></div>' +
    '</div>';
  }

  function wxHtml(w) {
    if (!w) return '<span class="hm-wx-load">' + tt('אין נתוני מזג אוויר לחלקה הראשית', 'ไม่มีข้อมูลอากาศ', 'لا توجد بيانات طقس') + '</span>';
    var tag;
    if (w.spray[0] === 'good') tag = '<span class="hm-tag ok">' + ic('spray', G, 13, 2) + ' ' + tt('חלון ריסוס טוב עכשיו', 'พ่นยาได้ตอนนี้', 'وقت مناسب للرش الآن') + '</span>';
    else if (w.goodAt) tag = '<span class="hm-tag mid">' + tt('ריסוס מתאים מ־', 'พ่นได้ตั้งแต่ ', 'مناسب للرش من ') + w.goodAt + '</span>';
    else tag = '<span class="hm-tag bad">' + tt('לא לרסס היום', 'ไม่ควรพ่นวันนี้', 'لا رش اليوم') + ' · ' + esc(w.spray[1]) + '</span>';
    return '<div class="hm-wx-now"><b>' + w.temp + '°</b><span class="hm-wx-ic">' + w.icon + '</span></div>' +
      '<small>' + tt('רוח', 'ลม', 'رياح') + ' ' + w.wind + ' ' + tt('קמ״ש', 'กม./ชม.', 'كم/س') + ' · ' + tt('לחות', 'ความชื้น', 'رطوبة') + ' ' + w.rh + '%' +
      (w.et0 != null ? ' · ET0 ' + w.et0 : '') + '</small>' + tag;
  }

  function kpiHtml(f, list) {
    var fl = (f && window.Fleet && Fleet.farmAlerts && S().canEditFarm && S().canEditFarm(f.id)) ? Fleet.farmAlerts(f.id) : null;
    var tiles = [
      [tt('משקים', 'ฟาร์ม', 'مزارع'), fmt(list.length, 0), ''],
      [tt('חלקות במשק', 'แปลงในฟาร์ม', 'قطع في المزرعة'), f ? fmt(f.plots.length, 0) : '—', 'l'],
      [tt('דונם', 'ไร่', 'دونم'), f ? fmt(f.area) : '—', ''],
      fl ? [tt('כלים לטיפול', 'ยานพาหนะต้องดูแล', 'مركبات تحتاج متابعة'), fmt(fl.length, 0), fl.some(function (a) { return a.cls === 'bad'; }) ? 'r' : fl.length ? 'o' : '']
         : [tt('עצים', 'ต้น', 'أشجار'), f && f.trees ? fmt(f.trees, 0) : '—', '']
    ];
    return '<div class="hm-kpis">' + tiles.map(function (t) {
      return '<div class="hm-kpi ' + t[2] + '"><small>' + t[0] + '</small><b>' + t[1] + '</b></div>';
    }).join('') + '</div>';
  }

  function actsHtml() {
    return '<div class="hm-acts">' + actionsAvail().map(function (a, i) {
      return '<button type="button" class="hm-act" data-hm-act="' + a.k + '"><span class="hm-act-r' + (i === 0 ? ' on' : '') + '">' + ic(a.ic, null, 24, 1.5) + '</span>' +
        '<span class="hm-act-l">' + tt(a.he, a.th, a.ar) + '</span></button>';
    }).join('') + '</div>';
  }

  function farmCard(f, on) {
    var chips = f.crops.slice(0, 3).map(function (c) { return '<span>' + esc(c) + '</span>'; }).join('');
    return '<div class="hm-fc' + (on ? ' on' : '') + '" data-hm-farm="' + f.id + '" style="--fc:' + esc(f.color) + '">' +
      '<span class="hm-fc-lg">' + ic('leaf', null, 22, 1.6) + '</span>' +
      '<span class="hm-fc-t"><b>' + esc(f.name) + '</b><small>' + f.plots.length + ' ' + tt('חלקות', 'แปลง', 'قطع') + ' · ' + fmt(f.area) + ' ' + tt('דונם', 'ไร่', 'دونم') + '</small>' +
        (chips ? '<span class="hm-chips">' + chips + '</span>' : '') + '</span>' +
      '<button type="button" class="hm-fc-go" data-hm-open="' + f.id + '" title="' + tt('לפרטי משק', 'รายละเอียดฟาร์ม', 'تفاصيل المزرعة') + '">' + ic('chev', null, 18, 2) + '</button>' +
    '</div>';
  }

  function plotsPanel(f) {
    if (!f || !f.plots.length) return '';
    var rows = f.plots.slice(0, 8).map(function (p) {
      var st = p.stage ? '<span class="hm-chip">' + esc(p.stage) + '</span>' : '';
      return '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.crop_type || '') + '</td><td>' + fmt(p.area) + '</td><td>' + (p.tree_count ? fmt(p.tree_count, 0) : '—') + '</td><td>' + st + '</td></tr>';
    }).join('');
    return '<div class="hm-pn"><h4>' + tt('חלקות', 'แปลง', 'القطع') + ' · ' + esc(f.name) +
      (f.plots.length > 8 ? ' <small>(' + f.plots.length + ')</small>' : '') + '</h4>' +
      '<table class="hm-tb"><tr><th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th><th>' + tt('גידול', 'พืช', 'محصول') + '</th><th>' + tt('דונם', 'ไร่', 'دونم') + '</th><th>' +
      tt('עצים', 'ต้น', 'أشجار') + '</th><th>' + tt('שלב', 'ระยะ', 'مرحلة') + '</th></tr>' + rows + '</table></div>';
  }

  function alertsPanel(f, w) {
    var items = [];
    if (w && w.alerts) w.alerts.forEach(function (a) { items.push([a[0] === 'bad' ? 'r' : 'o', a[1], '']); });
    if (f && window.Fleet && Fleet.farmAlerts && S().canEditFarm && S().canEditFarm(f.id)) {
      Fleet.farmAlerts(f.id).forEach(function (a) { items.push([a.cls === 'bad' ? 'r' : 'o', a.text, a.when]); });
    }
    if (!items.length) return '<div class="hm-pn"><h4>' + tt('התראות', 'การแจ้งเตือน', 'تنبيهات') + '</h4><div class="hm-empty">✓ ' + tt('אין התראות למשק הזה', 'ไม่มีการแจ้งเตือน', 'لا توجد تنبيهات') + '</div></div>';
    return '<div class="hm-pn"><h4>' + tt('התראות', 'การแจ้งเตือน', 'تنبيهات') + '</h4><table class="hm-tb">' + items.slice(0, 8).map(function (it) {
      return '<tr><td>' + esc(it[1]) + '</td><td style="text-align:left"><span class="hm-chip ' + it[0] + '">' + (it[2] ? esc(it[2]) : (it[0] === 'r' ? '!' : '•')) + '</span></td></tr>';
    }).join('') + '</table></div>';
  }

  // ── render ──
  var last = { w: null, farm: null };
  function render() {
    var root = document.getElementById('homeRoot');
    if (!root) return;
    ensureCss();
    var list = farmsData(), f = selFarm(list);
    last.farm = f ? f.id : null;
    var d = new Date();
    root.innerHTML = '<div class="hm">' +
      '<div class="hm-greet"><b>' + greeting() + '</b><small>' + d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' }) + '</small></div>' +
      '<div class="hm-top">' + heroHtml(f) + kpiHtml(f, list) + '</div>' +
      actsHtml() +
      '<div class="hm-bot">' +
        '<div class="hm-farms"><div class="hm-sh"><b>' + tt('המשקים שלי', 'ฟาร์มของฉัน', 'مزارعي') + '</b><span>' + list.length + '</span></div>' +
          '<div class="hm-fcs">' + list.map(function (x) { return farmCard(x, f && x.id === f.id); }).join('') + '</div></div>' +
        '<div class="hm-side" id="hmSide">' + alertsPanel(f, null) + plotsPanel(f) + '</div>' +
      '</div>' +
    '</div>';
    bind(root);
    if (f && window.Weather && Weather.summary) {
      var fid = f.id;
      Weather.summary(fid, function (w) {
        if (last.farm !== fid) return;
        var el = document.getElementById('hmWx');
        if (el) el.innerHTML = wxHtml(w);
        var side = document.getElementById('hmSide');
        var cur = farmsData().find(function (x) { return x.id === fid; });
        if (side && cur) side.innerHTML = alertsPanel(cur, w) + plotsPanel(cur);
      });
    } else {
      var el = document.getElementById('hmWx');
      if (el) el.innerHTML = wxHtml(null);
    }
  }

  function bind(root) {
    root.querySelectorAll('[data-hub]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var hero = document.getElementById('hmHero');
        hubGo(this.getAttribute('data-hub'), hero ? Number(hero.getAttribute('data-farm')) : null);
      });
    });
    root.querySelectorAll('[data-hm-act]').forEach(function (b) {
      b.addEventListener('click', function () { runAction(this.getAttribute('data-hm-act')); });
    });
    root.querySelectorAll('[data-hm-open]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var id = Number(this.getAttribute('data-hm-open'));
        if (typeof window.showFarmDetailsGlobal === 'function') window.showFarmDetailsGlobal(id);
      });
    });
    root.querySelectorAll('[data-hm-farm]').forEach(function (c) {
      c.addEventListener('click', function () {
        var id = Number(this.getAttribute('data-hm-farm'));
        try { localStorage.setItem(SEL_KEY, JSON.stringify(id)); } catch (e) {}
        render();
        var hero = document.getElementById('hmHero');
        if (hero && window.innerWidth < 900) hero.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
  }

  // ── bottom bar + sheets (phones) ──
  function navHtml() {
    var items = [['home', 'home', tt('בית', 'หน้าแรก', 'الرئيسية')], ['map', 'map', tt('מפה', 'แผนที่', 'خريطة')], ['+'],
      ['spray', 'spray', tt('ריסוס', 'พ่นยา', 'رش')], ['more', 'grid', tt('עוד', 'เพิ่มเติม', 'المزيد')]];
    return items.map(function (it) {
      if (it[0] === '+') return '<button type="button" class="hm-nav-mid" data-hm-nav="plus" aria-label="' + tt('פעולה מהירה', 'ทำงานด่วน', 'إجراء سريع') + '">' + ic('plus', null, 26, 2.2) + '</button>';
      return '<button type="button" class="hm-nav-i" data-hm-nav="' + it[0] + '">' + ic(it[1], null, 22, 1.7) + '<span>' + it[2] + '</span></button>';
    }).join('');
  }
  function ensureNav() {
    var nav = document.getElementById('hmNav');
    var app = document.getElementById('mainApp');
    if (!app) return;
    if (!nav) {
      nav = document.createElement('nav');
      nav.id = 'hmNav';
      nav.className = 'hm-nav';
      app.appendChild(nav);
      nav.addEventListener('click', function (e) {
        var b = e.target.closest('[data-hm-nav]');
        if (!b) return;
        var k = b.getAttribute('data-hm-nav');
        if (k === 'plus') return openSheet('plus');
        if (k === 'more') return openSheet('more');
        closeSheet();
        go(k);
      });
    }
    nav.innerHTML = navHtml();
    // Map/spray may be hidden for some roles; the slot stays so the + sits centred.
    ['map', 'spray'].forEach(function (t) {
      var b = nav.querySelector('[data-hm-nav="' + t + '"]');
      if (b) b.style.visibility = tabAvail(t) ? '' : 'hidden';
    });
    syncNav();
  }
  function syncNav() {
    var nav = document.getElementById('hmNav');
    if (!nav) return;
    var act = document.querySelector('.tab.active');
    var cur = act ? act.getAttribute('data-tab') : '';
    document.body.classList.toggle('hm-home', cur === 'home');
    nav.querySelectorAll('.hm-nav-i').forEach(function (b) {
      var k = b.getAttribute('data-hm-nav');
      b.classList.toggle('on', k === cur || (k === 'more' && ['home', 'map', 'spray'].indexOf(cur) === -1 && !!cur));
    });
  }

  function openSheet(kind) {
    closeSheet();
    var items;
    if (kind === 'plus') {
      items = [];
      if (tabAvail('spray')) items.push({ k: 'spray', ic: 'spray', t: tt('ריסוס חדש', 'พ่นยาใหม่', 'رش جديد') });
      if (document.getElementById('qaQuickWorklog')) items.push({ id: 'qaQuickWorklog', ic: 'cal', t: tt('רשומת יומן מהירה', 'บันทึกงานด่วน', 'تسجيل عمل سريع') });
      if (document.getElementById('qaCaptureReceipt')) items.push({ id: 'qaCaptureReceipt', ic: 'cam', t: tt('צלם תעודת משלוח', 'ถ่ายใบส่งของ', 'تصوير مستند') });
    } else {
      items = actionsAvail().map(function (a) { return { k: a.k, ic: a.ic, t: tt(a.he, a.th, a.ar) }; });
      items.push({ k: '__ds', ic: 'sun', t: tt('הגדרות תצוגה', 'การแสดงผล', 'إعدادات العرض') });
    }
    var sh = document.createElement('div');
    sh.id = 'hmSheet';
    sh.className = 'hm-sheet-wrap';
    sh.innerHTML = '<div class="hm-sheet ' + kind + '"><span class="hm-sheet-h"></span><div class="hm-sheet-g">' + items.map(function (it) {
      return '<button type="button" class="hm-act" ' + (it.id ? 'data-hm-id="' + it.id + '"' : 'data-hm-k="' + it.k + '"') + '><span class="hm-act-r">' + ic(it.ic, null, 24, 1.5) + '</span><span class="hm-act-l">' + it.t + '</span></button>';
    }).join('') + '</div></div>';
    document.body.appendChild(sh);
    sh.addEventListener('click', function (e) {
      if (e.target === sh) return closeSheet();
      var b = e.target.closest('button');
      if (!b) return;
      var id = b.getAttribute('data-hm-id'), k = b.getAttribute('data-hm-k');
      closeSheet();
      if (id) clickId(id);
      else if (k === '__ds') { if (window.DisplaySettings) DisplaySettings.showSettings(); }
      else if (k === 'spray' && kind === 'plus') go('spray');
      else runAction(k);
    });
  }
  function closeSheet() { var s = document.getElementById('hmSheet'); if (s) s.remove(); }

  // ── lifecycle ──
  function enter() {
    var u = user();
    if (!u || u.role === 'viewer' || !isFresh()) return;
    ensureNav();
    var act = document.querySelector('.tab.active');
    if (!act || act.getAttribute('data-tab') === 'map') go('home');
  }
  function leave() {
    document.body.classList.remove('hm-home');
    var nav = document.getElementById('hmNav');
    if (nav) nav.remove();
    closeSheet();
    var act = document.querySelector('.tab.active');
    if (act && act.getAttribute('data-tab') === 'home') go('map');
  }

  document.addEventListener('shorashim:user-ready', function () { setTimeout(enter, 60); });
  // New language: the bar's labels and the home screen are built here, so repaint them.
  document.addEventListener('shorashim:lang', function () {
    if (!isFresh() || !user()) return;
    if (document.getElementById('hmNav')) ensureNav();
    var act = document.querySelector('.tab.active');
    if (act && act.getAttribute('data-tab') === 'home') render();
    if (document.getElementById('hmSheet')) closeSheet();
  });
  document.addEventListener('shorashim:layout', function (e) {
    if (!user()) return;
    if (e.detail && e.detail.layout === 'fresh') enter(); else leave();
  });
  // Keep the bar's highlighted item in step with any tab change.
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.tab')) setTimeout(syncNav, 0);
  });

  function ensureCss() {
    if (document.getElementById('hmCss')) return;
    var st = document.createElement('style');
    st.id = 'hmCss';
    st.textContent =
      '.hm{max-width:1280px;margin:0 auto;padding:12px 14px 24px;color:var(--text);}' +
      '.hm-greet{display:flex;flex-direction:column;margin:2px 4px 10px;}.hm-greet b{font-size:1.15rem;letter-spacing:-.01em;}.hm-greet small{color:var(--text-muted);font-size:.78rem;}' +
      '.hm-top{display:grid;gap:12px;}' +
      '.hm-hero{position:relative;overflow:hidden;border-radius:26px;min-height:196px;color:#fff;background:var(--grad-hero);padding:18px;display:flex;flex-direction:column;justify-content:space-between;}' +
      '.hm-hero:before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(100deg,rgba(255,255,255,.04) 0 2px,transparent 2px 7px);pointer-events:none;}' +
      '.hm-hero-t{position:relative;z-index:1;max-width:60%;}.hm-hero-t b{font-size:1.25rem;display:block;}.hm-hero-t small{opacity:.88;font-size:.78rem;}' +
      '.hm-wx{position:relative;z-index:1;max-width:62%;}.hm-wx small{display:block;opacity:.9;font-size:.76rem;margin:2px 0 8px;}' +
      '.hm-wx-now{display:flex;align-items:center;gap:8px;}.hm-wx-now b{font-size:2.5rem;font-weight:500;line-height:1;}.hm-wx-ic{font-size:1.6rem;}' +
      '.hm-wx-load{font-size:.78rem;opacity:.85;}' +
      '.hm-tag{display:inline-flex;align-items:center;gap:5px;font-size:.74rem;font-weight:700;padding:5px 10px;border-radius:10px;}' +
      '.hm-tag.ok{background:var(--lime);color:var(--lime-ink);}.hm-tag.mid{background:rgba(255,255,255,.9);color:#7a4a00;}.hm-tag.bad{background:rgba(255,255,255,.9);color:#b3261e;}' +
      '.hm-hub{position:absolute;inset-inline-end:8px;top:50%;width:178px;height:178px;transform:translateY(-52%);z-index:2;}' +
      '.hm-hub>svg{position:absolute;inset:0;overflow:visible;}.hm-hub line{stroke:rgba(255,255,255,.35);stroke-width:1;}.hm-hub circle{fill:none;stroke:rgba(255,255,255,.28);stroke-dasharray:3 4;}' +
      '.hm-hub-c{position:absolute;width:36px;height:36px;margin:-18px 0 0 -18px;padding:0;border-radius:50%;border:1.4px solid rgba(255,255,255,.75);background:rgba(255,255,255,.12);display:grid;place-items:center;cursor:pointer;transition:transform .12s,background .12s;}' +
      '.hm-hub-c:hover{background:rgba(255,255,255,.26);}.hm-hub-c:active{transform:scale(.9);}' +
      '.hm-hub-c span{position:absolute;top:100%;left:50%;transform:translateX(-50%);margin-top:2px;font-size:.58rem;font-weight:600;color:#fff;white-space:nowrap;text-shadow:0 1px 3px rgba(0,0,0,.45);}' +
      '.hm-hub-b{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#e0645a;color:#fff;font-size:.6rem;font-style:normal;font-weight:700;line-height:16px;}' +
      '.hm-hub-m{position:absolute;left:50%;top:50%;width:50px;height:50px;margin:-25px 0 0 -25px;padding:0;border:0;border-radius:50%;background:var(--lime);display:grid;place-items:center;box-shadow:0 6px 18px rgba(0,0,0,.18);cursor:pointer;}' +
      '.hm-hub-m:active{transform:scale(.92);}' +
      '.hm-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}' +
      '.hm-kpi{background:var(--tonal);border-radius:18px;padding:10px 12px;min-width:0;}.hm-kpi small{display:block;color:var(--text-muted);font-size:.7rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.hm-kpi b{font-size:1.2rem;}' +
      '.hm-kpi.l{background:var(--primary-soft);}.hm-kpi.r b{color:#b3261e;}.hm-kpi.o b{color:#b06a12;}' +
      '.hm-acts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px 6px;margin:16px 0 6px;}' +
      '.hm-act{background:none;border:0;padding:0;font:inherit;color:var(--text);display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;min-width:0;}' +
      '.hm-act-r{width:58px;height:58px;border-radius:50%;border:1.5px solid var(--line);background:var(--card);display:grid;place-items:center;color:var(--primary);position:relative;transition:transform .12s,box-shadow .12s;}' +
      '.hm-act:hover .hm-act-r{box-shadow:0 6px 16px rgba(18,64,31,.14);}.hm-act:active .hm-act-r{transform:scale(.94);}' +
      '.hm-act-r.on{background:var(--grad-primary);border-color:transparent;color:var(--lime);}' +
      '.hm-act-r.on:after{content:"";position:absolute;top:2px;left:4px;width:11px;height:11px;border-radius:50%;background:var(--lime);border:2px solid var(--card);}' +
      '.hm-act-l{font-size:.74rem;color:var(--text);text-align:center;line-height:1.2;max-width:76px;}' +
      '.hm-bot{display:grid;gap:14px;margin-top:10px;}' +
      '.hm-sh{display:flex;justify-content:space-between;align-items:baseline;margin:6px 4px 8px;}.hm-sh b{font-size:1rem;}.hm-sh span{font-size:.78rem;color:var(--text-muted);}' +
      '.hm-fcs{display:grid;gap:10px;}' +
      '.hm-fc{display:flex;align-items:center;gap:12px;padding:13px 14px;border-radius:22px;background:var(--card);border:1px solid var(--line);cursor:pointer;transition:box-shadow .15s;}' +
      '.hm-fc:hover{box-shadow:0 8px 20px rgba(18,64,31,.10);}' +
      '.hm-fc-lg{width:44px;height:44px;flex:none;border-radius:15px;background:var(--primary-soft);color:var(--primary);display:grid;place-items:center;box-shadow:inset -3px 0 0 var(--fc);}' +
      '.hm-fc-t{flex:1;min-width:0;}.hm-fc-t b{display:block;font-size:.95rem;}.hm-fc-t small{color:var(--text-muted);font-size:.74rem;}' +
      '.hm-chips{display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;}.hm-chips span{font-size:.68rem;padding:2px 8px;border-radius:8px;background:var(--tonal);color:var(--text-muted);}' +
      '.hm-fc-go{width:34px;height:34px;flex:none;border-radius:12px;border:0;background:var(--tonal);color:var(--primary);display:grid;place-items:center;cursor:pointer;}' +
      '.hm-fc.on{background:var(--grad-primary);border-color:transparent;color:#fff;box-shadow:0 10px 24px rgba(18,64,31,.28);}' +
      '.hm-fc.on .hm-fc-t small{color:rgba(255,255,255,.78);}.hm-fc.on .hm-fc-lg{background:rgba(255,255,255,.12);color:var(--lime);}' +
      '.hm-fc.on .hm-chips span{background:rgba(255,255,255,.14);color:#fff;}.hm-fc.on .hm-fc-go{background:var(--lime);color:var(--lime-ink);}' +
      '.hm-side{display:grid;gap:12px;align-content:start;}' +
      '.hm-pn{background:var(--card);border:1px solid var(--line);border-radius:22px;padding:12px 16px;}.hm-pn h4{margin:0 0 6px;font-size:.95rem;}.hm-pn h4 small{color:var(--text-muted);font-weight:400;}' +
      '.hm-tb{width:100%;border-collapse:collapse;font-size:.8rem;}.hm-tb td,.hm-tb th{padding:7px 4px;border-bottom:1px solid var(--line);text-align:right;}.hm-tb tr:last-child td{border-bottom:0;}.hm-tb th{color:var(--text-muted);font-weight:400;font-size:.72rem;}' +
      '.hm-chip{font-size:.7rem;padding:2px 8px;border-radius:8px;background:var(--primary-soft);color:var(--primary);font-weight:500;white-space:nowrap;}.hm-chip.o{background:#fff4e2;color:#b06a12;}.hm-chip.r{background:#fde9e7;color:#b3261e;}' +
      '.hm-empty{font-size:.8rem;color:var(--text-muted);padding:4px 0;}' +
      'body.soft-dark .hm-chip.o{background:rgba(226,176,116,.15);}body.soft-dark .hm-chip.r{background:rgba(232,150,139,.15);}' +
      '@media (max-width:420px){.hm-hub{width:156px;height:156px;inset-inline-end:2px;}.hm-kpis{grid-template-columns:repeat(2,1fr);}}' +
      '@media (min-width:900px){.hm{padding:18px 22px 30px;}.hm-top{grid-template-columns:1.35fr 1fr;align-items:stretch;}' +
        '.hm-kpis{grid-template-columns:1fr 1fr;}.hm-kpi{padding:14px 16px;border-radius:20px;display:flex;flex-direction:column;justify-content:center;}.hm-kpi b{font-size:1.5rem;}' +
        '.hm-acts{grid-template-columns:repeat(auto-fill,minmax(88px,1fr));margin:20px 0 8px;}.hm-act-r{width:62px;height:62px;}' +
        '.hm-bot{grid-template-columns:1.25fr 1fr;align-items:start;}.hm-fcs{grid-template-columns:1fr 1fr;}}' +
      /* bottom bar + sheets */
      '.hm-nav{display:none;}' +
      '@media (max-width:899px){body.layout-fresh .hm-nav{display:flex;position:fixed;bottom:0;left:0;right:0;z-index:1200;height:calc(70px + env(safe-area-inset-bottom,0px));padding-bottom:env(safe-area-inset-bottom,0px);' +
        'background:var(--card);border-top:1px solid var(--line);justify-content:space-around;align-items:center;box-shadow:0 -6px 20px rgba(18,64,31,.06);}}' +
      '.hm-nav-i{background:none;border:0;font:inherit;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:.66rem;color:var(--text-muted);min-width:56px;cursor:pointer;padding:6px 0;}' +
      '.hm-nav-i.on{color:var(--primary);font-weight:700;}' +
      '.hm-nav-mid{width:58px;height:58px;border-radius:50%;border:5px solid var(--card);background:var(--grad-primary);color:var(--lime);display:grid;place-items:center;margin-top:-28px;box-shadow:0 10px 22px rgba(18,64,31,.35);cursor:pointer;}' +
      '.hm-sheet-wrap{position:fixed;inset:0;z-index:1300;background:rgba(16,24,20,.35);display:flex;align-items:flex-end;justify-content:center;}' +
      '.hm-sheet{width:100%;max-width:560px;background:var(--card);border-radius:26px 26px 0 0;padding:10px 16px calc(92px + env(safe-area-inset-bottom,0px));box-shadow:0 -10px 30px rgba(0,0,0,.15);}' +
      '.hm-sheet-h{display:block;width:40px;height:4px;border-radius:4px;background:var(--line);margin:0 auto 14px;}' +
      '.hm-sheet-g{display:grid;grid-template-columns:repeat(4,1fr);gap:14px 6px;}.hm-sheet.plus .hm-sheet-g{grid-template-columns:repeat(3,1fr);}' +
      '@media (min-width:900px){.hm-sheet{border-radius:26px;margin-bottom:24px;padding-bottom:22px;}}';
    document.head.appendChild(st);
  }

  return { render: render, enter: enter, leave: leave, openSheet: openSheet, _farms: farmsData };
})();
window.Home = Home;
