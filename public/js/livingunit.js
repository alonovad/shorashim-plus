/* livingunit.js — מתחם מגורים בבנייה קלה (accommodation planner)
 * ------------------------------------------------------------------
 * Worker accommodation. Two ways to size it:
 *
 *   auto   — from the headcount. 20 people produce the rooms, wet block,
 *            kitchen and dining area a compound for 20 needs, and the
 *            rectangle follows from that.
 *   fixed  — from a length and width you type. The shell exists, or the
 *            plot only allows so much: the programme is fitted INTO the
 *            rectangle and the shortfalls are reported, not hidden.
 *
 * THE LAYOUT IS THE SOURCE OF TRUTH. Rooms are rectangles inside the
 * building, items (doors, windows, sockets, lights, AC, sanitary fittings,
 * drains, kitchen, furniture) are points with a size and a rotation. Until
 * someone edits it, the layout is generated from the programme; after the
 * first edit it is stored with the project (u.layout) and the generator
 * keeps out of the way.
 *
 * Every quantity is read off that layout:
 *   walls      — each room edge is cut against every other room edge, so a
 *                wall shared by two rooms is counted once, a wall between
 *                two open spaces (corridor / dining / kitchen) is not built
 *                at all, and a wall with a wet room on either side is a wet
 *                wall (block + plaster + tiles) rather than a panel.
 *   openings   — doors and windows are subtracted from the wall they sit in.
 *   finishes   — tiles to the wet faces only, paint and skirting to the dry
 *                faces only, waterproofing to wet floors with an upstand.
 *   services   — electrical points, cable and conduit runs measured from the
 *                panel; cold, hot and drain pipe measured from the water
 *                entry, the heater and the sewer exit.
 *
 * MODES (unchanged): fitout = partitions and interior only; full = the
 * envelope, slab and roof as well. Quoting a fit-out with an envelope in it
 * is the most expensive mistake available here, so the mode gates sections.
 *
 * Coordinates: plan metres, x along the building's length (0..L), y across
 * it (0..W), origin at the top-left corner of the drawing.
 */
var LivingUnit = (function () {
  'use strict';

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function num(v, d) { var x = Number(v); return isFinite(x) ? x : d; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function uid() { return 'i' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // Unit keys, escaped so they read as data and not as UI text.
  var M2 = '\u05de"\u05e8', M1 = "\u05de'", UN = "\u05d9\u05d7'", M3 = '\u05de"\u05e7';

  // ── room types ──────────────────────────────────────────────────────
  var ROOM_TYPES = ['bed', 'wc', 'shower', 'wash', 'laundry', 'kitchen', 'dining', 'corridor', 'store', 'office'];
  var WET = { wc: 1, shower: 1, wash: 1, laundry: 1 };
  function roomLabel(t) {
    switch (t) {
      case 'bed': return tt('חדר שינה', 'ห้องนอน', 'غرفة نوم');
      case 'wc': return tt('שירותים', 'ห้องสุขา', 'مرحاض');
      case 'shower': return tt('מקלחת', 'ห้องอาบน้ำ', 'دُش');
      case 'wash': return tt('חדר רחצה', 'ห้องล้าง', 'غرفة غسيل');
      case 'laundry': return tt('כביסה', 'ห้องซักผ้า', 'غسيل الملابس');
      case 'kitchen': return tt('מטבח', 'ครัว', 'مطبخ');
      case 'dining': return tt('חלל אוכל', 'พื้นที่รับประทาน', 'صالة طعام');
      case 'corridor': return tt('מסדרון', 'ทางเดิน', 'ممر');
      case 'store': return tt('מחסן', 'ห้องเก็บของ', 'مخزن');
      case 'office': return tt('משרד', 'สำนักงาน', 'مكتب');
    }
    return t;
  }
  var ROOM_COL = {
    bed: ['#eceff1', 'rgba(255,255,255,.06)'], wc: ['#b3e5fc', 'rgba(79,195,247,.22)'],
    shower: ['#b3e5fc', 'rgba(79,195,247,.26)'], wash: ['#d6effa', 'rgba(79,195,247,.15)'],
    laundry: ['#d1c4e9', 'rgba(149,117,205,.22)'], kitchen: ['#ffe0b2', 'rgba(255,159,67,.22)'],
    dining: ['#c8e6c9', 'rgba(46,204,113,.18)'], corridor: ['#f5f5f5', 'rgba(255,255,255,.03)'],
    store: ['#d7ccc8', 'rgba(161,136,127,.2)'], office: ['#fff9c4', 'rgba(255,235,59,.14)']
  };
  var ROOM_3D = { bed: '#d9cdb8', wc: '#9fd3ea', shower: '#8fc9e3', wash: '#b5dcec', laundry: '#c3b4dd',
                  kitchen: '#e9cfa4', dining: '#c9dcc0', corridor: '#d8d4cc', store: '#c4b6ad', office: '#e7e0b5' };

  // ── item catalogue ──────────────────────────────────────────────────
  // w: size along the item's own x, d: depth, h3: height drawn in 3D,
  // z: mounting height of the underside. wall: sits IN a wall (door,
  // window). cat drives the layer toggles.
  var ITEMS = {
    door:       { cat: 'open',    w: 0.8,  d: 0.1,  wall: 1, h3: 2.1 },
    door_ext:   { cat: 'open',    w: 1.0,  d: 0.1,  wall: 1, h3: 2.1 },
    window:     { cat: 'open',    w: 1.2,  d: 0.1,  wall: 1, sill: 1.0, h3: 1.0 },
    socket:     { cat: 'elec',    w: 0.15, d: 0.08, z: 0.3,  h3: 0.1,  col: '#f5f5f5' },
    light:      { cat: 'elec',    w: 0.3,  d: 0.3,  ceil: 1, h3: 0.06, col: '#ffe082' },
    'switch':   { cat: 'elec',    w: 0.12, d: 0.06, z: 1.05, h3: 0.12, col: '#eeeeee' },
    ac:         { cat: 'elec',    w: 0.9,  d: 0.25, z: 2.05, h3: 0.3,  col: '#fafafa' },
    panel:      { cat: 'elec',    w: 0.5,  d: 0.15, z: 1.3,  h3: 0.6,  col: '#90a4ae' },
    heater:     { cat: 'plumb',   w: 0.55, d: 0.55, z: 1.3,  h3: 0.95, col: '#eceff1' },
    water_in:   { cat: 'plumb',   w: 0.2,  d: 0.2,  h3: 0.4,  col: '#1e88e5' },
    sewer_exit: { cat: 'plumb',   w: 0.25, d: 0.25, h3: 0.05, col: '#6d4c41' },
    toilet:     { cat: 'plumb',   w: 0.4,  d: 0.7,  h3: 0.45, col: '#ffffff' },
    shower:     { cat: 'plumb',   w: 0.9,  d: 0.9,  h3: 0.06, col: '#e3f2fd' },
    basin:      { cat: 'plumb',   w: 0.5,  d: 0.4,  z: 0.7,  h3: 0.18, col: '#ffffff' },
    drain:      { cat: 'plumb',   w: 0.15, d: 0.15, h3: 0.012, col: '#455a64' },
    washer:     { cat: 'plumb',   w: 0.6,  d: 0.6,  h3: 0.85, col: '#f5f5f5' },
    counter:    { cat: 'kitchen', w: 2.4,  d: 0.6,  h3: 0.9,  col: '#bcaaa4', resize: 1 },
    sink:       { cat: 'kitchen', w: 0.8,  d: 0.6,  h3: 0.92, col: '#cfd8dc' },
    stove:      { cat: 'kitchen', w: 0.6,  d: 0.6,  h3: 0.92, col: '#424242' },
    fridge:     { cat: 'kitchen', w: 0.7,  d: 0.7,  h3: 1.8,  col: '#e0e0e0' },
    bed:        { cat: 'furn',    w: 0.9,  d: 1.9,  h3: 0.5,  col: '#8d6e63' },
    bunk:       { cat: 'furn',    w: 0.9,  d: 1.9,  h3: 1.6,  col: '#795548' },
    wardrobe:   { cat: 'furn',    w: 1.0,  d: 0.6,  h3: 2.0,  col: '#a1887f', resize: 1 },
    table:      { cat: 'furn',    w: 1.8,  d: 0.8,  h3: 0.75, col: '#a1887f', resize: 1 },
    bench:      { cat: 'furn',    w: 1.6,  d: 0.35, h3: 0.45, col: '#8d6e63', resize: 1 },
    sofa:       { cat: 'furn',    w: 2.0,  d: 0.85, h3: 0.8,  col: '#5c6bc0', resize: 1 }
  };
  // Fixtures that take water, hot water, a drain or a power point.
  var NEEDS = {
    toilet: { cold: 1, drain: 1 }, shower: { cold: 1, hot: 1, drain: 1 },
    basin: { cold: 1, hot: 1, drain: 1 }, sink: { cold: 1, hot: 1, drain: 1 },
    washer: { cold: 1, drain: 1, power: 1 }, drain: { drain: 1 }, heater: { cold: 1, power: 1 },
    fridge: { power: 1 }, stove: { power: 1 }, ac: { power: 1 }
  };
  function itemLabel(k) {
    switch (k) {
      case 'door': return tt('דלת', 'ประตู', 'باب');
      case 'door_ext': return tt('דלת כניסה', 'ประตูทางเข้า', 'باب المدخل');
      case 'window': return tt('חלון', 'หน้าต่าง', 'نافذة');
      case 'socket': return tt('שקע', 'เต้ารับ', 'مقبس');
      case 'light': return tt('נקודת מאור', 'จุดไฟ', 'نقطة إنارة');
      case 'switch': return tt('מפסק', 'สวิตช์', 'مفتاح');
      case 'ac': return tt('מזגן', 'แอร์', 'مكيف');
      case 'panel': return tt('לוח חשמל', 'ตู้ไฟ', 'لوحة كهرباء');
      case 'heater': return tt('דוד מים', 'เครื่องทำน้ำร้อน', 'سخان ماء');
      case 'water_in': return tt('כניסת מים', 'ทางเข้าน้ำ', 'مدخل الماء');
      case 'sewer_exit': return tt('יציאת ביוב', 'ทางออกน้ำเสีย', 'مخرج الصرف');
      case 'toilet': return tt('אסלה', 'โถส้วม', 'مرحاض');
      case 'shower': return tt('מקלחת', 'ฝักบัว', 'دُش');
      case 'basin': return tt('כיור רחצה', 'อ่างล้างหน้า', 'مغسلة');
      case 'drain': return tt('מחסום רצפה', 'ท่อระบายพื้น', 'مصرف أرضي');
      case 'washer': return tt('מכונת כביסה', 'เครื่องซักผ้า', 'غسالة');
      case 'counter': return tt('ארונות ומשטח', 'เคาน์เตอร์', 'خزائن وسطح');
      case 'sink': return tt('כיור מטבח', 'ซิงค์ครัว', 'مجلى');
      case 'stove': return tt('כיריים', 'เตา', 'موقد');
      case 'fridge': return tt('מקרר', 'ตู้เย็น', 'ثلاجة');
      case 'bed': return tt('מיטה', 'เตียง', 'سرير');
      case 'bunk': return tt('מיטת קומותיים', 'เตียงสองชั้น', 'سرير طابقين');
      case 'wardrobe': return tt('ארון בגדים', 'ตู้เสื้อผ้า', 'خزانة ملابس');
      case 'table': return tt('שולחן', 'โต๊ะ', 'طاولة');
      case 'bench': return tt('ספסל', 'ม้านั่ง', 'مقعد');
      case 'sofa': return tt('ספה', 'โซฟา', 'كنبة');
    }
    return k;
  }
  function itemSym(k) {
    return { door: '🚪', door_ext: '🚪', window: '🪟', socket: '🔌', light: '💡', 'switch': '⏻', ac: '❄️',
             panel: '⚡', heater: '♨️', water_in: '💧', sewer_exit: '⤓', toilet: '🚽', shower: '🚿', basin: '🚰',
             drain: '◉', washer: '🧺', counter: '▭', sink: '🚰', stove: '🍳', fridge: '🧊', bed: '🛏', bunk: '🛏',
             wardrobe: '🚪', table: '🍽', bench: '🪑', sofa: '🛋' }[k] || '•';
  }

  // ── normalise ───────────────────────────────────────────────────────
  function normLayout(l) {
    if (!l || typeof l !== 'object' || !Array.isArray(l.rooms)) return null;
    return {
      L: num(l.L, 0), W: num(l.W, 0),
      rooms: l.rooms.filter(function (r) { return r && num(r.w, 0) > 0.2 && num(r.h, 0) > 0.2; }).map(function (r) {
        return { id: String(r.id || uid()), type: ROOM_TYPES.indexOf(r.type) >= 0 ? r.type : 'store',
                 name: String(r.name || ''), x: num(r.x, 0), y: num(r.y, 0), w: num(r.w, 1), h: num(r.h, 1),
                 open: !!r.open };
      }),
      items: (Array.isArray(l.items) ? l.items : []).filter(function (it) { return it && ITEMS[it.kind]; }).map(function (it) {
        var o = { id: String(it.id || uid()), kind: it.kind, x: num(it.x, 0), y: num(it.y, 0),
                  rot: ((Math.round(num(it.rot, 0) / 90) * 90) % 360 + 360) % 360, flip: !!it.flip };
        if (it.w != null && isFinite(Number(it.w))) o.w = Number(it.w);
        return o;
      })
    };
  }
  function norm(u) {
    u = u || {};
    var site = u.site || {};
    return {
      mode: (u.mode === 'full') ? 'full' : 'fitout',
      people: Math.max(1, Number(u.people) || 20),
      perPerson: Number(u.perPerson) || 4,
      perRoom: Math.max(1, Number(u.perRoom) || 4),
      wcPer: Math.max(1, Number(u.wcPer) || 8),
      showerPer: Math.max(1, Number(u.showerPer) || 8),
      basinPer: Math.max(1, Number(u.basinPer) || 6),
      counterPer: Number(u.counterPer) || 0.5,
      diningPer: Number(u.diningPer) || 1.2,
      height: Number(u.height) || 2.6,
      partition: String(u.partition || 'פאנל קלקר 5 ס"מ'),   // CATALOGUE KEY
      blockWet: u.blockWet === false ? false : true,
      envelope: String(u.envelope || 'איסכורית 0.5 מ"מ'),    // CATALOGUE KEY
      slabTh: Number(u.slabTh) || 0.12,
      ac: u.ac === false ? false : true,
      laundry: u.laundry === false ? false : true,
      tileH: Number(u.tileH) || 2.1,
      dimMode: u.dimMode === 'fixed' ? 'fixed' : 'auto',
      lenM: Math.max(0, Number(u.lenM) || 0),
      widM: Math.max(0, Number(u.widM) || 0),
      site: { dx: num(site.dx, 0), dy: num(site.dy, 0),
              rot: ((Math.round(num(site.rot, 0) / 90) * 90) % 360 + 360) % 360 },
      layout: normLayout(u.layout),
      notes: String(u.notes || '')
    };
  }

  // ── programme ───────────────────────────────────────────────────────
  function program(u) {
    u = norm(u);
    var rooms = Math.ceil(u.people / u.perRoom);
    var sleepArea = u.people * u.perPerson;
    var wc = Math.max(1, Math.ceil(u.people / u.wcPer));
    var showers = Math.max(1, Math.ceil(u.people / u.showerPer));
    var basins = Math.max(1, Math.ceil(u.people / u.basinPer));
    var counter = Math.max(2.4, u.people * u.counterPer);
    var dining = u.people * u.diningPer;
    var wetArea = wc * 1.6 + showers * 1.6 + basins * 0.8;
    var kitchen = Math.max(6, counter * 1.8);
    var laundryArea = u.laundry ? 4 : 0;
    var circulation = (sleepArea + wetArea + kitchen + dining + laundryArea) * 0.15;
    var total = sleepArea + wetArea + kitchen + dining + laundryArea + circulation;
    var fixed = u.dimMode === 'fixed' && u.lenM > 0 && u.widM > 0;
    // As typed: length is the building's x axis, width its y axis.
    var width = fixed ? u.widM : Math.max(6, Math.sqrt(total / 1.6));
    var length = fixed ? u.lenM : Math.max(6, Math.sqrt(total / 1.6) * 1.6);
    return {
      rooms: rooms, sleepArea: sleepArea, wc: wc, showers: showers, basins: basins,
      counter: counter, dining: dining, wetArea: wetArea, kitchen: kitchen,
      circulation: circulation, total: total, fixed: fixed,
      heaters: Math.max(1, Math.ceil(u.people / 10)),
      washers: u.laundry ? Math.max(1, Math.ceil(u.people / 12)) : 0,
      width: width, length: length, area: width * length
    };
  }

  // ── auto layout ─────────────────────────────────────────────────────
  // Bedrooms along one long side; a corridor; then the wet block, laundry,
  // dining and kitchen along the other long side. WC and shower are
  // separate cubicles off a washroom with the basins, so the partitions
  // between them exist in the layout and therefore in the quantities.
  function autoLayout(u) {
    u = norm(u);
    var pr = program(u);
    var Lm = n2(pr.length), Wm = n2(pr.width);
    var rooms = [], items = [];
    function room(type, x, y, w, h, open, name) {
      var r = { id: uid(), type: type, name: name || '', x: n2(x), y: n2(y), w: n2(w), h: n2(h), open: !!open };
      rooms.push(r); return r;
    }
    function item(kind, x, y, rot, extra) {
      var o = { id: uid(), kind: kind, x: n2(x), y: n2(y), rot: rot || 0, flip: false };
      if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
      items.push(o); return o;
    }

    var nb = pr.rooms;
    var rw = Lm / nb;
    var dRoom = clamp((u.perPerson * u.perRoom) / rw, 2.8, Math.max(2.8, Wm * 0.5));
    var rest = Wm - dRoom;
    var corr = (rest - 1.2 >= 2.6) ? 1.2 : 0;
    var yB = dRoom + corr, bh = Wm - yB;

    // bedrooms
    for (var i = 0; i < nb; i++) {
      var x0 = i * rw;
      room('bed', x0, 0, rw, dRoom, false, tt('חדר', 'ห้อง', 'غرفة') + ' ' + (i + 1));
      var dX = x0 + 0.6;
      item('door', dX, dRoom, 0, { w: 0.8 });
      item('window', x0 + rw / 2, 0, 0, { w: rw >= 2 ? 1.2 : 0.9 });
      item('light', x0 + rw / 2, dRoom / 2, 0);
      item('switch', dX + 0.6, dRoom - 0.06, 0);
      item('socket', x0 + 0.25, 0.06, 0);
      item('socket', x0 + rw - 0.06, dRoom / 2, 90);
      if (u.ac) item('ac', x0 + rw - 0.7, 0.13, 0);
      var bunks = u.perRoom >= 3;
      var nBeds = bunks ? Math.ceil(u.perRoom / 2) : u.perRoom;
      for (var b = 0; b < nBeds; b++) {
        var bx = x0 + rw - 0.6 - b * 1.15;
        if (bx - 0.45 < x0 + 0.05) bx = x0 + 0.5 + b * 0.05;
        item(bunks ? 'bunk' : 'bed', bx, 0.15 + 0.95, 0);
      }
      var ww = clamp(u.perRoom * 0.5, 1.0, Math.max(1.0, rw - 1.5));
      if (dRoom >= 2.75) item('wardrobe', x0 + rw - 0.1 - ww / 2, dRoom - 0.35, 0, { w: n2(ww) });
    }
    if (corr) {
      room('corridor', 0, dRoom, Lm, corr, true);
      var nl = Math.max(1, Math.round(Lm / 4));
      for (var c = 0; c < nl; c++) item('light', (c + 0.5) * Lm / nl, dRoom + corr / 2, 0);
    }

    // wet block: cubicles along the outer wall, washroom in front
    var cubN = pr.wc + pr.showers;
    var wetW = Math.max(2.4, cubN * 1.0, pr.basins * 0.7 + 1.0);
    var cubD = clamp(bh - 1.3, 1.2, 1.6);
    var cw = wetW / cubN;
    var washH = bh - cubD;
    if (washH >= 1.0) {
      room('wash', 0, yB, wetW, washH, false);
      item('door', 0.6, yB, 0, { w: 0.8 });
      item('drain', wetW / 2, yB + washH / 2, 0);
      item('light', wetW / 2, yB + washH / 2 - 0.3, 0);
      for (var k = 0; k < pr.basins; k++) item('basin', wetW - 0.45 - k * 0.7, yB + 0.25, 180);
    }
    for (var j = 0; j < cubN; j++) {
      var isWc = j < pr.wc, cx = j * cw;
      room(isWc ? 'wc' : 'shower', cx, Wm - cubD, cw, cubD, false);
      item('door', cx + cw / 2, Wm - cubD, 0, { w: 0.7 });
      item('light', cx + cw / 2, Wm - cubD / 2, 0);
      if (isWc) item('toilet', cx + cw / 2, Wm - 0.4, 180);
      else { item('shower', cx + cw / 2, Wm - cubD / 2 + 0.1, 0); item('drain', cx + cw / 2, Wm - cubD / 2 + 0.1, 0); }
    }
    item('sewer_exit', wetW / 2, Wm, 0);

    // laundry
    var lx = wetW, lw = u.laundry ? 2.0 : 0;
    if (u.laundry) {
      room('laundry', lx, yB, lw, bh, false);
      item('door', lx + lw / 2, yB, 0, { w: 0.8 });
      for (var q = 0; q < pr.washers; q++) {
        item('washer', lx + 0.4 + q * 0.7, Wm - 0.35, 180);
        item('socket', lx + 0.4 + q * 0.7, Wm - 0.06, 180);
      }
      item('drain', lx + lw / 2, yB + bh / 2 + 0.3, 0);
      for (var hh = 0; hh < pr.heaters; hh++) item('heater', lx + lw - 0.35, yB + 0.4 + hh * 0.65, 90);
      item('light', lx + lw / 2, yB + bh / 2, 0);
      item('water_in', lx + lw - 0.15, Wm, 0);
    } else {
      item('heater', wetW - 0.4, yB + 0.4, 0);
      item('water_in', wetW - 0.15, Wm, 0);
    }

    // kitchen at the far end, open to dining
    var kitW = clamp(pr.kitchen / Math.max(bh, 1), 2.4, Math.max(2.4, (Lm - lx - lw) * 0.45));
    var kx = Lm - kitW;
    room('kitchen', kx, yB, kitW, bh, true);
    item('fridge', kx + 0.45, Wm - 0.4, 180);
    var cl = clamp(pr.counter, 1.2, kitW - 1.0);
    var ccx = Lm - 0.1 - cl / 2;
    item('counter', ccx, Wm - 0.3, 180, { w: n2(cl) });
    item('sink', ccx - cl / 4, Wm - 0.3, 180);
    item('stove', ccx + cl / 4, Wm - 0.3, 180);
    var rem = pr.counter - cl;
    if (rem > 0.6) {
      var c2 = clamp(rem, 0.6, bh - 1.0);
      item('counter', Lm - 0.3, Wm - 0.6 - c2 / 2, 90, { w: n2(c2) });
    }
    for (var s = 0; s < 3; s++) item('socket', kx + 1.1 + s * (cl / 3), Wm - 0.06, 180);
    item('light', kx + kitW / 2, yB + bh / 2, 0);
    item('window', Lm, yB + bh / 2, 90, { w: 1.0 });

    // dining / common
    var dx0 = lx + lw, dW = kx - dx0;
    if (dW > 0.8) {
      room('dining', dx0, yB, dW, bh, true);
      var nT = Math.max(1, Math.ceil(u.people / 6));
      var perRow = Math.max(1, Math.floor((dW - 0.6) / 2.4));
      for (var t = 0; t < nT; t++) {
        var col = t % perRow, row = Math.floor(t / perRow);
        item('table', dx0 + 0.3 + 1.2 + col * 2.4, yB + 1.0 + row * 1.7, 0, { w: 1.8 });
      }
      var door = dx0 + dW / 2;
      item('door_ext', door, Wm, 0, { w: 1.0 });
      item('panel', door + 1.0, Wm - 0.1, 180);
      item('window', dx0 + Math.max(0.8, dW / 4), Wm, 0, { w: 1.2 });
      item('light', dx0 + dW / 3, yB + bh / 2, 0);
      item('light', dx0 + 2 * dW / 3, yB + bh / 2, 0);
      item('socket', dx0 + 0.06, yB + bh / 2, 90);
      item('socket', kx - 0.06, yB + bh / 2 + 0.6, 270);
      if (u.ac) item('ac', dx0 + dW / 2, yB + 0.13 + (corr ? 0 : 0), 0);
    } else {
      item('door_ext', Lm - 0.8, Wm, 0, { w: 1.0 });
      item('panel', Lm - 1.8, Wm - 0.1, 180);
    }
    return { L: Lm, W: Wm, rooms: rooms, items: items, auto: true };
  }

  // The layout in force: the stored one, rescaled if the building has been
  // resized since it was drawn, or the generated one.
  function layoutOf(u) {
    u = norm(u);
    var pr = program(u);
    var l = u.layout;
    if (!l) return autoLayout(u);
    var Lm = n2(pr.length), Wm = n2(pr.width);
    if (!(l.L > 0) || !(l.W > 0) || (Math.abs(l.L - Lm) < 0.01 && Math.abs(l.W - Wm) < 0.01)) {
      l.L = l.L > 0 ? l.L : Lm; l.W = l.W > 0 ? l.W : Wm;
      return l;
    }
    var kx = Lm / l.L, ky = Wm / l.W;
    return {
      L: Lm, W: Wm, scaledFrom: { L: l.L, W: l.W },
      rooms: l.rooms.map(function (r) {
        return { id: r.id, type: r.type, name: r.name, open: r.open,
                 x: n2(r.x * kx), y: n2(r.y * ky), w: n2(r.w * kx), h: n2(r.h * ky) };
      }),
      items: l.items.map(function (it) {
        var o = JSON.parse(JSON.stringify(it));
        o.x = n2(it.x * kx); o.y = n2(it.y * ky);
        return o;
      })
    };
  }

  // ── geometry helpers ────────────────────────────────────────────────
  function itemSize(it) {
    var d = ITEMS[it.kind] || {};
    var w = (it.w != null) ? it.w : d.w, dp = d.d;
    return (it.rot === 90 || it.rot === 270) ? { w: dp, h: w } : { w: w, h: dp };
  }
  function roomAt(lay, x, y) {
    var hit = null;
    lay.rooms.forEach(function (r) {
      if (x >= r.x - 0.001 && x <= r.x + r.w + 0.001 && y >= r.y - 0.001 && y <= r.y + r.h + 0.001) {
        if (!hit || r.w * r.h < hit.w * hit.h) hit = r;
      }
    });
    return hit;
  }

  // Wall segments from room edges. Every edge is laid on its line; each
  // line is cut at every endpoint; each piece is then a wall or not, and
  // wet or dry on each face, from the rooms touching it.
  function walls(lay) {
    var Lm = lay.L, Wm = lay.W, E = 0.015;
    var lines = {};
    // Edges a centimetre apart are the same wall: rounding a generated or
    // rescaled layout must not turn one wall into two parallel ones, and an
    // edge within 3 cm of the outline IS the outline.
    function keyFor(o, c) {
      var end = o === 'h' ? Wm : Lm;
      if (Math.abs(c) < 0.03) c = 0;
      else if (Math.abs(c - end) < 0.03) c = end;
      var hit = null;
      Object.keys(lines).forEach(function (k) {
        var ln = lines[k];
        if (!hit && ln.o === o && Math.abs(ln.c - c) < 0.02) hit = k;
      });
      if (hit) return hit;
      var key = o + ':' + Math.round(c * 100);
      lines[key] = { o: o, c: Math.round(c * 100) / 100, pcs: [] };
      return key;
    }
    function add(o, c, a, b, side, r) {
      a = Math.max(0, a); b = Math.min(o === 'h' ? Lm : Wm, b);
      if (b - a < E) return;
      lines[keyFor(o, c)].pcs.push({ a: a, b: b, side: side, r: r });
    }
    lay.rooms.forEach(function (r) {
      add('h', r.y, r.x, r.x + r.w, 1, r);
      add('h', r.y + r.h, r.x, r.x + r.w, -1, r);
      add('v', r.x, r.y, r.y + r.h, 1, r);
      add('v', r.x + r.w, r.y, r.y + r.h, -1, r);
    });
    // the outline always exists, rooms or not
    [['h', 0], ['h', Wm], ['v', 0], ['v', Lm]].forEach(function (oc) {
      var key = keyFor(oc[0], oc[1]);
      lines[key].outer = true;
      lines[key].c = oc[1];
    });
    var segs = [];
    Object.keys(lines).forEach(function (key) {
      var ln = lines[key];
      var isOuter = !!ln.outer || Math.abs(ln.c) < E || (ln.o === 'h' ? Math.abs(ln.c - Wm) < E : Math.abs(ln.c - Lm) < E);
      var pts = [];
      ln.pcs.forEach(function (p) { pts.push(p.a, p.b); });
      if (isOuter) pts.push(0, ln.o === 'h' ? Lm : Wm);
      pts = pts.map(function (v) { return Math.round(v * 1000) / 1000; }).sort(function (a, b) { return a - b; });
      var uniq = [];
      pts.forEach(function (v) { if (!uniq.length || v - uniq[uniq.length - 1] > 0.001) uniq.push(v); });
      var cur = null;
      for (var i = 0; i + 1 < uniq.length; i++) {
        var a = uniq[i], b = uniq[i + 1], m = (a + b) / 2;
        var plus = [], minus = [];
        ln.pcs.forEach(function (p) { if (p.a < m && p.b > m) (p.side > 0 ? plus : minus).push(p.r); });
        var wall, wetP, wetM;
        if (isOuter) {
          wall = true;
          var inside = ln.c < E ? plus : minus;
          wetP = inside.some(function (r) { return WET[r.type]; });
          wetM = false;
        } else {
          if (!plus.length && !minus.length) wall = false;
          else if (plus.length && minus.length &&
                   plus.every(function (r) { return r.open; }) && minus.every(function (r) { return r.open; })) wall = false;
          else wall = true;
          wetP = plus.some(function (r) { return WET[r.type]; });
          wetM = minus.some(function (r) { return WET[r.type]; });
        }
        if (!wall) { cur = null; continue; }
        var sig = (isOuter ? 'o' : 'i') + (wetP ? 1 : 0) + (wetM ? 1 : 0);
        if (cur && cur.sig === sig && Math.abs(cur.b - a) < 0.002) { cur.b = b; cur.len = cur.b - cur.a; continue; }
        cur = { o: ln.o, c: ln.c, a: a, b: b, len: b - a, outer: isOuter, wetP: wetP, wetM: wetM,
                wet: wetP || wetM, sig: sig };
        segs.push(cur);
      }
    });
    return segs;
  }
  function segEnds(s) {
    return s.o === 'h' ? { x1: s.a, y1: s.c, x2: s.b, y2: s.c } : { x1: s.c, y1: s.a, x2: s.c, y2: s.b };
  }
  // The wall a door or window sits in, or null.
  function hostSeg(segs, it) {
    var o = (it.rot === 90 || it.rot === 270) ? 'v' : 'h';
    var along = o === 'h' ? it.x : it.y, across = o === 'h' ? it.y : it.x;
    var best = null, bd = 0.25;
    segs.forEach(function (s) {
      if (s.o !== o) return;
      var d = Math.abs(s.c - across);
      if (d < bd && along >= s.a - 0.05 && along <= s.b + 0.05) { bd = d; best = s; }
    });
    return best;
  }
  // Nearest wall line to a point, for snapping doors and windows.
  function snapToWall(lay, x, y) {
    var segs = walls(lay), best = null, bd = 1e9;
    segs.forEach(function (s) {
      var e = segEnds(s);
      var along = s.o === 'h' ? clamp(x, s.a, s.b) : clamp(y, s.a, s.b);
      var px = s.o === 'h' ? along : s.c, py = s.o === 'h' ? s.c : along;
      var d = Math.hypot(px - x, py - y);
      if (d < bd) { bd = d; best = { x: px, y: py, rot: s.o === 'h' ? 0 : 90, d: d, seg: s }; }
      void e;
    });
    return best;
  }
  function manhattan(a, b) { return Math.abs(a.x - b.x) + Math.abs(a.y - b.y); }

  // ── quantities from the layout ──────────────────────────────────────
  function quantities(u) {
    u = norm(u);
    var lay = layoutOf(u), segs = walls(lay), H = u.height;
    var q = {
      innerDry: 0, innerWet: 0, outer: 0, doorsInt: {}, doorsExt: 0, windows: {}, winArea: 0,
      dryDoorArea: 0, wetDoorArea: 0, extOpenArea: 0,
      dryFace: 0, wetFace: 0, dryFaceOpen: 0, wetFaceOpen: 0, doorWidthDry: 0,
      floor: 0, wetFloor: 0, wetPerim: 0, showerPerim: 0, count: {}, counterM: 0,
      cable25: 0, cable15: 0, cold: 0, hot: 0, drainPipe: 0, circuits: 0, lay: lay, segs: segs
    };
    segs.forEach(function (s) {
      if (s.outer) { q.outer += s.len; if (s.wetP) q.wetFace += s.len; else q.dryFace += s.len; }
      else {
        if (s.wet) q.innerWet += s.len; else q.innerDry += s.len;
        q.wetFace += s.len * ((s.wetP ? 1 : 0) + (s.wetM ? 1 : 0));
        q.dryFace += s.len * ((s.wetP ? 0 : 1) + (s.wetM ? 0 : 1));
      }
    });
    lay.items.forEach(function (it) {
      q.count[it.kind] = (q.count[it.kind] || 0) + 1;
      var d = ITEMS[it.kind], w = (it.w != null) ? it.w : d.w;
      if (it.kind === 'door' || it.kind === 'door_ext' || it.kind === 'window') {
        var s = hostSeg(segs, it);
        var h = it.kind === 'window' ? (d.h3 || 1) : 2.1;
        var area = w * h;
        if (it.kind === 'window') {
          var key = Math.round(w * 100) + 'x' + Math.round(h * 100);
          q.windows[key] = (q.windows[key] || 0) + 1;
          q.winArea += area;
        } else if (it.kind === 'door_ext') q.doorsExt++;
        else { var dk = Math.round(w * 100); q.doorsInt[dk] = (q.doorsInt[dk] || 0) + 1; }
        if (s) {
          var faces = s.outer ? [s.wetP] : [s.wetP, s.wetM];
          faces.forEach(function (wetF) {
            if (wetF) q.wetFaceOpen += w * Math.min(h, u.tileH); else { q.dryFaceOpen += area; q.doorWidthDry += it.kind === 'window' ? 0 : w; }
          });
          if (s.outer) q.extOpenArea += area;
          else if (s.wet) q.wetDoorArea += area; else q.dryDoorArea += area;
        }
      }
      if (it.kind === 'counter') q.counterM += w;
    });
    lay.rooms.forEach(function (r) {
      var a = r.w * r.h;
      q.floor += a;
      if (WET[r.type]) { q.wetFloor += a; q.wetPerim += 2 * (r.w + r.h); }
      if (r.type === 'shower') q.showerPerim += 2 * (r.w + r.h);
    });
    // floor area the rooms do not cover is still floor (circulation)
    q.floor = Math.max(q.floor, lay.L * lay.W - (q.innerDry + q.innerWet) * 0.1);

    // services, measured as right-angle runs (how pipe and cable are laid)
    var panel = lay.items.filter(function (i) { return i.kind === 'panel'; })[0] ||
                { x: lay.L / 2, y: lay.W };
    var heaters = lay.items.filter(function (i) { return i.kind === 'heater'; });
    var wIn = lay.items.filter(function (i) { return i.kind === 'water_in'; })[0] || heaters[0] || { x: 0, y: lay.W };
    var exitP = lay.items.filter(function (i) { return i.kind === 'sewer_exit'; })[0] || { x: 0, y: lay.W };
    var nLight = 0, nSock = 0, nApp = 0;
    lay.items.forEach(function (it) {
      var nd = NEEDS[it.kind] || {};
      if (it.kind === 'light') { q.cable15 += manhattan(panel, it) + 1.5; nLight++; }
      else if (it.kind === 'socket') { q.cable25 += manhattan(panel, it) + 2.3; nSock++; }
      else if (nd.power) { q.cable25 += manhattan(panel, it) + 2.3; nApp++; }
      if (nd.cold) q.cold += manhattan(wIn, it) + 1.0;
      if (nd.hot && heaters.length) {
        var nh = heaters.reduce(function (b, h) { return manhattan(h, it) < manhattan(b, it) ? h : b; }, heaters[0]);
        q.hot += manhattan(nh, it) + 1.0;
      }
      if (nd.drain) q.drainPipe += manhattan(exitP, it) + 0.5;
    });
    q.cable15 *= 1.15; q.cable25 *= 1.15; q.cold *= 1.1; q.hot *= 1.1; q.drainPipe *= 1.1;
    q.circuits = Math.ceil(nLight / 10) + Math.ceil(nSock / 8) + nApp;
    q.H = H;
    return q;
  }

  // ── takeoff ─────────────────────────────────────────────────────────
  function takeoff(u) {
    u = norm(u);
    var pr = program(u), q = quantities(u), lay = q.lay, H = u.height;
    var out = [];
    function push(name, qty, unit, note) {
      if (!(qty > 0)) return;
      out.push({ name: name, qty: qty, unit: unit, note: note || '' });
    }
    function c(k) { return q.count[k] || 0; }
    var wallNote = function (len) { return n1(len) + ' ' + tt('מ\' קיר', 'ม. ผนัง', 'م جدار') + ' \u00d7 ' + n2(H) + ' m'; };

    // inner walls, net of openings
    if (u.blockWet) {
      var blk = q.innerWet * H - q.wetDoorArea;
      push('בלוק בטון 20 ס"מ', blk, M2, tt('קירות פנים רטובים', 'ผนังเปียก', 'جدران رطبة') + ' \u00b7 ' + wallNote(q.innerWet));
      push('טיח פנים', blk * 2, M2, tt('בלוק, שני צדדים', 'สองด้าน', 'وجهان'));
      push(u.partition, q.innerDry * H - q.dryDoorArea, M2, tt('מחיצות פנים', 'ผนังกั้นภายใน', 'قواطع داخلية') + ' \u00b7 ' + wallNote(q.innerDry));
      push('פרופיל U לפאנל', q.innerDry * 2, M1, tt('מסילות עליונה ותחתונה', 'รางบนล่าง', 'مجاري علوية وسفلية'));
    } else {
      push(u.partition, (q.innerDry + q.innerWet) * H - q.dryDoorArea - q.wetDoorArea, M2,
        tt('מחיצות פנים', 'ผนังกั้นภายใน', 'قواطع داخلية') + ' \u00b7 ' + wallNote(q.innerDry + q.innerWet));
      push('פרופיל U לפאנל', (q.innerDry + q.innerWet) * 2, M1, tt('מסילות עליונה ותחתונה', 'รางบนล่าง', 'مجاري علوية وسفلية'));
    }

    // openings
    var di = Object.keys(q.doorsInt).sort();
    push('דלת פנים', di.reduce(function (s, k) { return s + q.doorsInt[k]; }, 0), UN,
      di.map(function (k) { return k + ' \u00d7' + q.doorsInt[k]; }).join(' \u00b7 ') + ' ' + tt('ס"מ', 'ซม.', 'سم'));
    push('דלת כניסה', q.doorsExt, UN, '');
    var wk = Object.keys(q.windows).sort();
    push('חלון אלומיניום', wk.reduce(function (s, k) { return s + q.windows[k]; }, 0), UN,
      wk.map(function (k) { return k.replace('x', '\u00d7') + ' \u00d7' + q.windows[k]; }).join(' \u00b7 ') + ' ' + tt('ס"מ', 'ซม.', 'سم'));

    // sanitary and water
    push('אסלה כולל מיכל', c('toilet'), UN, '');
    push('מקלחון / אגן מקלחת', c('shower'), UN, '');
    push('כיור רחצה', c('basin'), UN, '');
    push('מחסום רצפה', c('drain'), UN, '');
    push('דוד שמש 150 ליטר', c('heater'), UN, '');
    push('צנרת מים קרים', q.cold, M1, tt('מכניסת המים לכל נקודה', 'จากทางเข้าน้ำ', 'من مدخل الماء'));
    push('צנרת מים חמים', q.hot, M1, tt('מהדוד לנקודות החמות', 'จากเครื่องทำน้ำร้อน', 'من السخان'));
    push('צנרת ביוב', q.drainPipe, M1, tt('מכל נקודת ניקוז ליציאת הביוב', 'ถึงทางออกน้ำเสีย', 'إلى مخرج الصرف'));
    push('איטום חדרים רטובים', q.wetFloor + q.wetPerim * 0.3 + q.showerPerim * 1.5, M2,
      tt('רצפה + רולקה 30 ס"מ, קירות מקלחת לגובה 1.8', 'พื้นและผนังฝักบัว', 'الأرضية وجدران الدش'));

    // kitchen
    push('ארון מטבח תחתון', q.counterM, M1, '');
    push('משטח עבודה', q.counterM, M1, '');
    push('כיור מטבח', c('sink'), UN, '');

    // electrical
    var pts = c('socket') + c('light') + c('ac') + c('washer') + c('fridge') + c('stove') + c('heater');
    push('נקודת חשמל', pts, UN,
      c('socket') + ' ' + tt('שקעים', 'เต้ารับ', 'مقابس') + ' \u00b7 ' + c('light') + ' ' + tt('מאור', 'ไฟ', 'إنارة') +
      ' (' + c('switch') + ' ' + tt('מפסקים', 'สวิตช์', 'مفاتيح') + ') \u00b7 ' +
      (c('ac') + c('washer') + c('fridge') + c('stove') + c('heater')) + ' ' + tt('מכשירים', 'เครื่องใช้', 'أجهزة'));
    push('לוח חשמל', Math.max(1, c('panel')), UN, '~' + q.circuits + ' ' + tt('מעגלים', 'วงจร', 'دوائر'));
    push('כבל חשמל 3x2.5', q.cable25, M1, tt('שקעים ומכשירים, מהלוח', 'เต้ารับ', 'المقابس'));
    push('כבל חשמל 3x1.5', q.cable15, M1, tt('מאור, מהלוח', 'ไฟ', 'الإنارة'));
    push('צינור שרשורי 20 מ"מ', q.cable25 + q.cable15, M1, '');
    if (c('ac')) push('מזגן עילי 1.5 כ"ס', c('ac'), UN, '');

    // finishes
    push('ריצוף גרניט פורצלן', q.floor * 1.07, M2, tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    var ceramic = q.wetFace * Math.min(u.tileH, H) - q.wetFaceOpen;
    push('חיפוי קרמיקה', (ceramic + q.counterM * 0.6) * 1.05, M2,
      tt('פנים רטובים לגובה', 'ผนังเปียกสูง', 'الجدران الرطبة بارتفاع') + ' ' + n2(Math.min(u.tileH, H)) + ' m + ' +
      tt('חיפוי מטבח', 'ครัว', 'المطبخ'));
    push('צבע פנים', q.dryFace * H - q.dryFaceOpen + Math.max(0, H - u.tileH) * q.wetFace, M2,
      tt('קירות יבשים', 'ผนังแห้ง', 'الجدران الجافة'));
    push('צבע תקרה', q.floor, M2, '');
    push('פנל שיפולים', Math.max(0, q.dryFace - q.doorWidthDry), M1, '');

    // furniture and appliances, for the purchasing list
    ['bed', 'bunk', 'wardrobe', 'table', 'bench', 'sofa', 'fridge', 'stove', 'washer'].forEach(function (k) {
      if (!c(k)) return;
      var nm = { bed: 'מיטה', bunk: 'מיטת קומותיים', wardrobe: 'ארון בגדים', table: 'שולחן', bench: 'ספסל',   // CATALOGUE KEY
                 sofa: 'ספה', fridge: 'מקרר', stove: 'כיריים', washer: 'מכונת כביסה' }[k];                 // CATALOGUE KEY
      push(nm, c(k), UN, tt('ריהוט וציוד', 'เฟอร์นิเจอร์', 'أثاث ومعدات'));
    });

    // envelope — only when there is nothing to fit out into
    if (u.mode === 'full') {
      var Lm = lay.L, Wm = lay.W, area = Lm * Wm;
      push('בטון ב-30', area * u.slabTh, M3, tt('רצפה', 'พื้น', 'أرضية'));
      push('רשת פלדה Q188', Math.ceil(area / (6 * 2.35) * 1.1), UN, tt('רצפה', 'พื้น', 'أرضية'));
      push(u.envelope, (2 * (Lm + Wm) * H) * 1.08 - q.extOpenArea, M2,
        tt('מעטפת חיצונית, בניכוי פתחים', 'เปลือกอาคาร', 'الغلاف الخارجي'));
      push(u.envelope, area * 1.1, M2, tt('גג', 'หลังคา', 'سقف'));
      push('HEA 160', Math.ceil(Lm / 4 + 1) * 2 * (H + 0.6), M1, tt('עמודי מעטפת', 'เสาโครง', 'أعمدة الهيكل'));
      push('Z 200x2.0', Math.ceil(Wm / 1.5) * Lm, M1, tt('מרישי גג', 'แปหลังคา', 'مرايش السقف'));
      push('מרזב', 2 * Lm, M1, '');
    }
    void pr;
    return out;
  }

  // ── checks: what the layout does not deliver ────────────────────────
  function analyze(u) {
    u = norm(u);
    var pr = program(u), lay = layoutOf(u), out = [];
    var cnt = {};
    lay.items.forEach(function (it) { cnt[it.kind] = (cnt[it.kind] || 0) + 1; });
    var beds = (cnt.bed || 0) + 2 * (cnt.bunk || 0);
    if (pr.fixed && pr.total > pr.area * 1.001) {
      out.push(tt('השטח הנדרש', 'พื้นที่ที่ต้องการ', 'المساحة المطلوبة') + ' ' + n1(pr.total) + ' ' + M2 + ' > ' +
               tt('השטח הזמין', 'พื้นที่ที่มี', 'المساحة المتاحة') + ' ' + n1(pr.area) + ' ' + M2);
    }
    if (beds < u.people) out.push(tt('מקומות שינה', 'ที่นอน', 'أماكن النوم') + ': ' + beds + ' / ' + u.people);
    if ((cnt.toilet || 0) < pr.wc) out.push(tt('אסלות', 'โถส้วม', 'مراحيض') + ': ' + (cnt.toilet || 0) + ' / ' + pr.wc);
    if ((cnt.shower || 0) < pr.showers) out.push(tt('מקלחות', 'ฝักบัว', 'دُش') + ': ' + (cnt.shower || 0) + ' / ' + pr.showers);
    if ((cnt.basin || 0) < pr.basins) out.push(tt('כיורים', 'อ่าง', 'أحواض') + ': ' + (cnt.basin || 0) + ' / ' + pr.basins);
    var sleep = 0;
    lay.rooms.forEach(function (r) { if (r.type === 'bed') sleep += r.w * r.h; });
    if (sleep / u.people < u.perPerson - 0.05) {
      out.push(tt('שטח שינה לאדם', 'พื้นที่นอนต่อคน', 'مساحة النوم للفرد') + ': ' + n1(sleep / u.people) + ' / ' + n1(u.perPerson) + ' ' + M2);
    }
    lay.rooms.forEach(function (r) {
      if (r.type === 'bed' && Math.min(r.w, r.h) < 2.2) out.push((r.name || roomLabel(r.type)) + ': ' + tt('צר מדי', 'แคบเกินไป', 'ضيقة جداً') + ' (' + n2(Math.min(r.w, r.h)) + ' m)');
    });
    if (!cnt.panel) out.push(tt('אין לוח חשמל בתוכנית', 'ไม่มีตู้ไฟ', 'لا توجد لوحة كهرباء'));
    if (!cnt.sewer_exit && (cnt.toilet || cnt.shower)) out.push(tt('אין יציאת ביוב בתוכנית', 'ไม่มีทางออกน้ำเสีย', 'لا يوجد مخرج صرف'));
    var segs = walls(lay);
    lay.rooms.forEach(function (r) {
      if (r.open) return;
      var hasDoor = lay.items.some(function (it) {
        if (it.kind !== 'door' && it.kind !== 'door_ext') return false;
        var onH = (it.rot === 0 || it.rot === 180) && (Math.abs(it.y - r.y) < 0.2 || Math.abs(it.y - r.y - r.h) < 0.2) && it.x > r.x - 0.05 && it.x < r.x + r.w + 0.05;
        var onV = (it.rot === 90 || it.rot === 270) && (Math.abs(it.x - r.x) < 0.2 || Math.abs(it.x - r.x - r.w) < 0.2) && it.y > r.y - 0.05 && it.y < r.y + r.h + 0.05;
        return onH || onV;
      });
      if (!hasDoor) out.push((r.name || roomLabel(r.type)) + ': ' + tt('אין דלת', 'ไม่มีประตู', 'لا باب'));
    });
    void segs;
    return out;
  }

  // ── plan drawing ────────────────────────────────────────────────────
  // opt: { print, show: {furn, elec, plumb, open, dims, wires, pipes}, sel, north (deg, plan frame) }
  function svg(u, opt) {
    u = norm(u);
    opt = opt || {};
    var print = !!opt.print;
    var show = opt.show || { furn: 1, elec: 1, plumb: 1, open: 1, dims: 1, kitchen: 1 };
    var lay = layoutOf(u), segs = walls(lay);
    var Lm = lay.L, Wm = lay.W;
    var col = {
      wall: print ? '#37474f' : 'var(--text,#cfd8dc)',
      txt: print ? '#263238' : 'var(--text,#dde5dd)',
      dim: print ? '#b34700' : 'var(--accent,#ff9f43)',
      sel: '#ffd166'
    };
    var pad = 1.4;
    var vb = [-pad, -pad - 0.6, Lm + pad * 2, Wm + pad * 2 + 0.6];
    var o = [];
    var fs = Math.max(0.22, Math.min(0.36, Math.min(Lm, Wm) / 22));

    lay.rooms.forEach(function (r) {
      var on = opt.sel && opt.sel.t === 'room' && opt.sel.id === r.id;
      o.push('<rect data-room="' + r.id + '" x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h +
        '" fill="' + (ROOM_COL[r.type] || ROOM_COL.store)[print ? 0 : 1] + '" stroke="' + (on ? col.sel : 'none') +
        '" stroke-width="' + (on ? 0.08 : 0) + '"/>');
    });
    // walls
    segs.forEach(function (s) {
      var e = segEnds(s);
      o.push('<line x1="' + e.x1 + '" y1="' + e.y1 + '" x2="' + e.x2 + '" y2="' + e.y2 + '" stroke="' + col.wall +
        '" stroke-width="' + (s.outer ? 0.2 : (s.wet && u.blockWet ? 0.16 : 0.09)) + '" stroke-linecap="square"/>');
    });
    // service runs
    var panel = lay.items.filter(function (i) { return i.kind === 'panel'; })[0];
    var wIn = lay.items.filter(function (i) { return i.kind === 'water_in'; })[0];
    var exitP = lay.items.filter(function (i) { return i.kind === 'sewer_exit'; })[0];
    function run(a, b, c2, dash) {
      o.push('<path d="M' + a.x + ' ' + a.y + ' L' + b.x + ' ' + a.y + ' L' + b.x + ' ' + b.y + '" fill="none" stroke="' + c2 +
        '" stroke-width="0.035" stroke-dasharray="' + dash + '" opacity=".75"/>');
    }
    if (show.wires && panel) lay.items.forEach(function (it) {
      if (it.kind === 'light' || it.kind === 'socket' || (NEEDS[it.kind] && NEEDS[it.kind].power)) run(panel, it, '#f9a825', '0.12 0.08');
    });
    if (show.pipes) lay.items.forEach(function (it) {
      var nd = NEEDS[it.kind]; if (!nd) return;
      if (nd.cold && wIn) run(wIn, it, '#1e88e5', '0.15 0.06');
      if (nd.drain && exitP) run(exitP, it, '#6d4c41', '0.25 0.08');
    });
    // room labels
    lay.rooms.forEach(function (r) {
      if (r.w < 0.9 || r.h < 0.7) return;
      o.push('<text x="' + (r.x + r.w / 2) + '" y="' + (r.y + r.h / 2 - fs * 0.2) + '" fill="' + col.txt +
        '" font-size="' + fs + '" font-weight="700" text-anchor="middle" opacity=".85" pointer-events="none">' +
        esc(r.name || roomLabel(r.type)) + '</text>');
      o.push('<text x="' + (r.x + r.w / 2) + '" y="' + (r.y + r.h / 2 + fs * 0.9) + '" fill="' + col.txt +
        '" font-size="' + (fs * 0.75) + '" text-anchor="middle" opacity=".6" pointer-events="none">' +
        n1(r.w * r.h) + ' m\u00b2</text>');
    });
    // items
    lay.items.forEach(function (it) {
      var d = ITEMS[it.kind]; if (!d) return;
      if (!show[d.cat]) return;
      var on = opt.sel && opt.sel.t === 'item' && opt.sel.id === it.id;
      var sz = itemSize(it), w = (it.w != null) ? it.w : d.w;
      var g = '<g data-item="' + it.id + '" style="cursor:move">';
      if (it.kind === 'door' || it.kind === 'door_ext') {
        var vert = it.rot === 90 || it.rot === 270;
        var x1 = vert ? it.x : it.x - w / 2, y1 = vert ? it.y - w / 2 : it.y;
        var gap = vert
          ? '<line x1="' + it.x + '" y1="' + (it.y - w / 2) + '" x2="' + it.x + '" y2="' + (it.y + w / 2) + '"'
          : '<line x1="' + (it.x - w / 2) + '" y1="' + it.y + '" x2="' + (it.x + w / 2) + '" y2="' + it.y + '"';
        g += gap + ' stroke="' + (print ? '#fff' : 'var(--card,#1b2620)') + '" stroke-width="0.24"/>';
        var sgn = (it.flip ? -1 : 1) * ((it.rot === 180 || it.rot === 270) ? -1 : 1);
        if (vert) {
          g += '<path d="M' + it.x + ' ' + y1 + ' l' + (sgn * w) + ' 0 A' + w + ' ' + w + ' 0 0 ' + (sgn > 0 ? 1 : 0) + ' ' + it.x + ' ' + (y1 + w) +
               '" fill="none" stroke="' + (on ? col.sel : col.wall) + '" stroke-width="0.03"/>';
        } else {
          g += '<path d="M' + x1 + ' ' + it.y + ' l0 ' + (sgn * w) + ' A' + w + ' ' + w + ' 0 0 ' + (sgn > 0 ? 0 : 1) + ' ' + (x1 + w) + ' ' + it.y +
               '" fill="none" stroke="' + (on ? col.sel : col.wall) + '" stroke-width="0.03"/>';
        }
        g += '<rect x="' + (it.x - sz.w / 2 - 0.1) + '" y="' + (it.y - sz.h / 2 - 0.1) + '" width="' + (sz.w + 0.2) + '" height="' + (sz.h + 0.2) + '" fill="transparent"/>';
      } else if (it.kind === 'window') {
        var vw = it.rot === 90 || it.rot === 270;
        var rx = vw ? it.x - 0.1 : it.x - w / 2, ry = vw ? it.y - w / 2 : it.y - 0.1;
        g += '<rect x="' + rx + '" y="' + ry + '" width="' + (vw ? 0.2 : w) + '" height="' + (vw ? w : 0.2) + '" fill="' +
             (print ? '#e1f5fe' : '#4fc3f7') + '" stroke="' + (on ? col.sel : col.wall) + '" stroke-width="' + (on ? 0.05 : 0.02) + '"/>';
      } else {
        var small = sz.w < 0.35 && sz.h < 0.35;
        if (small) {
          var cc = { elec: '#f9a825', plumb: '#1e88e5' }[d.cat] || '#90a4ae';
          if (it.kind === 'sewer_exit' || it.kind === 'drain') cc = '#6d4c41';
          g += '<circle cx="' + it.x + '" cy="' + it.y + '" r="' + (on ? 0.17 : 0.12) + '" fill="' + cc + '" stroke="' +
               (on ? col.sel : '#fff') + '" stroke-width="0.03"/>';
          g += '<text x="' + it.x + '" y="' + (it.y + 0.07) + '" font-size="0.17" text-anchor="middle" pointer-events="none">' + itemSym(it.kind) + '</text>';
        } else {
          g += '<rect x="' + (it.x - sz.w / 2) + '" y="' + (it.y - sz.h / 2) + '" width="' + sz.w + '" height="' + sz.h +
               '" rx="0.04" fill="' + (d.col || '#90a4ae') + '" fill-opacity="' + (print ? 0.55 : 0.7) + '" stroke="' +
               (on ? col.sel : (print ? '#455a64' : 'rgba(0,0,0,.45)')) + '" stroke-width="' + (on ? 0.07 : 0.025) + '"/>';
          g += '<text x="' + it.x + '" y="' + (it.y + Math.min(sz.w, sz.h) * 0.18) + '" font-size="' + Math.min(0.42, Math.min(sz.w, sz.h) * 0.55) +
               '" text-anchor="middle" pointer-events="none">' + itemSym(it.kind) + '</text>';
        }
      }
      g += '</g>';
      o.push(g);
    });
    // dimensions
    if (show.dims !== 0) {
      o.push('<line x1="0" y1="' + (Wm + 0.6) + '" x2="' + Lm + '" y2="' + (Wm + 0.6) + '" stroke="' + col.dim + '" stroke-width="0.03"/>');
      o.push('<text x="' + (Lm / 2) + '" y="' + (Wm + 1.05) + '" fill="' + col.dim + '" font-size="' + (fs * 1.1) +
        '" font-weight="800" text-anchor="middle">' + n2(Lm) + ' m</text>');
      o.push('<line x1="-0.6" y1="0" x2="-0.6" y2="' + Wm + '" stroke="' + col.dim + '" stroke-width="0.03"/>');
      o.push('<text x="-0.75" y="' + (Wm / 2) + '" fill="' + col.dim + '" font-size="' + (fs * 1.1) +
        '" font-weight="800" text-anchor="middle" transform="rotate(-90 -0.75 ' + (Wm / 2) + ')">' + n2(Wm) + ' m</text>');
    }
    // north arrow, when the building's orientation is known
    if (opt.north != null && isFinite(opt.north)) {
      var ax = Lm + pad * 0.55, ay = -0.2, rad = opt.north * Math.PI / 180;
      var tx = ax + Math.sin(rad) * 0.5, ty = ay - Math.cos(rad) * 0.5;
      o.push('<g><circle cx="' + ax + '" cy="' + ay + '" r="0.55" fill="none" stroke="' + col.dim + '" stroke-width="0.03"/>' +
        '<line x1="' + (2 * ax - tx) + '" y1="' + (2 * ay - ty) + '" x2="' + tx + '" y2="' + ty + '" stroke="#e53935" stroke-width="0.07"/>' +
        '<text x="' + (ax + Math.sin(rad) * 0.85) + '" y="' + (ay - Math.cos(rad) * 0.85 + 0.12) + '" fill="#e53935" font-size="0.32" font-weight="800" text-anchor="middle">N</text></g>');
    }
    var pr = program(u);
    o.push('<text x="' + (Lm / 2) + '" y="' + (-pad + 0.1) + '" fill="' + col.txt + '" font-size="' + (fs * 1.05) +
      '" font-weight="800" text-anchor="middle">' + u.people + ' ' + tt('אנשים', 'คน', 'أشخاص') + ' \u00b7 ' +
      n1(Lm * Wm) + ' ' + M2 + ' \u00b7 ' + (u.mode === 'full' ? tt('מבנה חדש', 'อาคารใหม่', 'مبنى جديد')
                                                               : tt('התאמת מבנה קיים', 'ปรับปรุงอาคารเดิม', 'تجهيز مبنى قائم')) +
      (pr.fixed ? '' : ' \u00b7 ' + tt('מידות מחושבות', 'ขนาดคำนวณ', 'أبعاد محسوبة')) + '</text>');

    return '<svg viewBox="' + vb.join(' ') + '" style="width:100%;height:auto;direction:ltr;touch-action:' +
      (opt.interactive ? 'none' : 'auto') + ';" direction="ltr" xmlns="http://www.w3.org/2000/svg">' + o.join('') + '</svg>';
  }

  // ── 3D ──────────────────────────────────────────────────────────────
  // frame: { bearing (deg, building length axis; null = east), e0, n0 (metres
  // of the building centre from the scene origin) }. Returns Shed3D's face
  // format, in east/north/up metres so it sits on the satellite ground.
  function model3d(u, frame, opt) {
    u = norm(u);
    frame = frame || {};
    opt = opt || {};
    var show = opt.show || { furn: 1, elec: 1, plumb: 1, open: 1, kitchen: 1 };
    var lay = layoutOf(u), segs = walls(lay), H = u.height, Lm = lay.L, Wm = lay.W;
    var Hc = opt.cut ? Math.min(H, 1.25) : H;
    var b = (frame.bearing != null ? frame.bearing : 90) * Math.PI / 180;
    var sb = Math.sin(b), cb = Math.cos(b);
    var sr = u.site.rot * Math.PI / 180, srs = Math.sin(sr), src = Math.cos(sr);
    var e0 = frame.e0 || 0, n0 = frame.n0 || 0;
    function W3(x, y, z) {
      var lu = x - Lm / 2, lv = Wm / 2 - y;                  // building frame, v to the left
      var X = lu * src - lv * srs + u.site.dx, Y = lu * srs + lv * src + u.site.dy;  // site frame
      return [e0 + X * sb - Y * cb, n0 + X * cb + Y * sb, z];
    }
    var F = [];
    function face(pts, color, group, alpha) { F.push({ pts: pts, color: color, group: group, alpha: alpha }); }
    // An axis-aligned box in PLAN space, carried through the rotation.
    function bx(x1, y1, x2, y2, z1, z2, color, group, alpha) {
      var ya = Math.max(y1, y2), yb = Math.min(y1, y2), xa = Math.min(x1, x2), xb = Math.max(x1, x2);
      // corners ordered as Shed3D's box(): (u1,v1),(u2,v1),(u2,v2),(u1,v2) with v = -y
      var p = [W3(xa, ya, z1), W3(xb, ya, z1), W3(xb, yb, z1), W3(xa, yb, z1),
               W3(xa, ya, z2), W3(xb, ya, z2), W3(xb, yb, z2), W3(xa, yb, z2)];
      [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]].forEach(function (ix) {
        face(ix.map(function (i) { return p[i]; }), color, group, alpha);
      });
    }
    // ground + slab
    var corners = [W3(0, 0, 0), W3(Lm, 0, 0), W3(Lm, Wm, 0), W3(0, Wm, 0)];
    var ex = corners.map(function (c) { return c[0]; }), ny = corners.map(function (c) { return c[1]; });
    var gpad = Math.max(Lm, Wm) * 0.9;
    var ext = { x0: Math.min.apply(null, ex) - gpad, x1: Math.max.apply(null, ex) + gpad,
                y0: Math.min.apply(null, ny) - gpad, y1: Math.max.apply(null, ny) + gpad };
    F.push({ pts: [[ext.x0, ext.y0, -0.02], [ext.x1, ext.y0, -0.02], [ext.x1, ext.y1, -0.02], [ext.x0, ext.y1, -0.02]],
             color: '#b9ae92', group: 'ground', alpha: 1, extent: ext });
    bx(-0.15, -0.15, Lm + 0.15, Wm + 0.15, -0.12, 0, '#b9b6ae', 'slab');
    lay.rooms.forEach(function (r) {
      face([W3(r.x, r.y + r.h, 0.012), W3(r.x + r.w, r.y + r.h, 0.012), W3(r.x + r.w, r.y, 0.012), W3(r.x, r.y, 0.012)],
           ROOM_3D[r.type] || '#d8d4cc', 'room:' + r.id);
    });
    // walls with their openings cut out
    var openings = lay.items.filter(function (it) { return it.kind === 'door' || it.kind === 'door_ext' || it.kind === 'window'; });
    segs.forEach(function (s) {
      var t = s.outer ? 0.2 : (s.wet && u.blockWet ? 0.15 : 0.09);
      var col = s.outer ? '#c9c2b3' : (s.wet ? '#d7e3ea' : '#e6e1d6');
      var cuts = [];
      openings.forEach(function (it) {
        if (hostSeg([s], it) !== s) return;
        var w = (it.w != null) ? it.w : ITEMS[it.kind].w;
        var along = s.o === 'h' ? it.x : it.y;
        var z1 = it.kind === 'window' ? (ITEMS.window.sill) : 0;
        var z2 = it.kind === 'window' ? z1 + ITEMS.window.h3 : 2.1;
        cuts.push({ a: Math.max(s.a, along - w / 2), b: Math.min(s.b, along + w / 2), z1: z1, z2: z2, it: it });
      });
      cuts.sort(function (p, q) { return p.a - q.a; });
      var pos = s.a;
      function piece(a, bb, z1, z2) {
        if (bb - a < 0.01 || z2 - z1 < 0.01) return;
        if (s.o === 'h') bx(a, s.c - t / 2, bb, s.c + t / 2, z1, z2, col, 'wall');
        else bx(s.c - t / 2, a, s.c + t / 2, bb, z1, z2, col, 'wall');
      }
      cuts.forEach(function (cu) {
        piece(pos, cu.a, 0, Hc);
        piece(cu.a, cu.b, 0, Math.min(cu.z1, Hc));
        piece(cu.a, cu.b, Math.min(cu.z2, Hc), Hc);
        pos = Math.max(pos, cu.b);
      });
      piece(pos, s.b, 0, Hc);
    });
    // items
    lay.items.forEach(function (it) {
      var d = ITEMS[it.kind]; if (!d || !show[d.cat]) return;
      var g = 'it:' + it.id, sz = itemSize(it), w = (it.w != null) ? it.w : d.w;
      var vert = it.rot === 90 || it.rot === 270;
      if (it.kind === 'window') {
        if (ITEMS.window.sill >= Hc) return;
        var zt = Math.min(Hc, ITEMS.window.sill + ITEMS.window.h3);
        if (vert) face([W3(it.x, it.y - w / 2, d.sill), W3(it.x, it.y + w / 2, d.sill), W3(it.x, it.y + w / 2, zt), W3(it.x, it.y - w / 2, zt)], '#bfe6ff', g, 0.45);
        else face([W3(it.x - w / 2, it.y, d.sill), W3(it.x + w / 2, it.y, d.sill), W3(it.x + w / 2, it.y, zt), W3(it.x - w / 2, it.y, zt)], '#bfe6ff', g, 0.45);
        return;
      }
      if (it.kind === 'door' || it.kind === 'door_ext') {
        // the leaf, swung open 90 degrees into the room
        var sgn = (it.flip ? -1 : 1) * ((it.rot === 180 || it.rot === 270) ? -1 : 1);
        var top = Math.min(2.05, Hc);
        if (vert) bx(it.x, it.y - w / 2, it.x + sgn * w, it.y - w / 2 + 0.04, 0, top, '#8d6e63', g);
        else bx(it.x - w / 2, it.y, it.x - w / 2 + 0.04, it.y + sgn * w, 0, top, '#8d6e63', g);
        return;
      }
      var z1 = d.ceil ? H - d.h3 : (d.z || 0);
      if (z1 >= Hc && !opt.showHigh) return;
      bx(it.x - sz.w / 2, it.y - sz.h / 2, it.x + sz.w / 2, it.y + sz.h / 2, z1, Math.min(z1 + d.h3, Math.max(Hc, z1 + d.h3)), d.col || '#90a4ae', g);
    });
    // north arrow on the ground beside the building
    var nx = ext.x0 + gpad * 0.45, nyy = ext.y1 - gpad * 0.45, al = Math.max(1.5, Math.min(Lm, Wm) * 0.35);
    face([[nx - 0.12, nyy - al / 2, 0.02], [nx + 0.12, nyy - al / 2, 0.02], [nx + 0.12, nyy + al / 2 - 0.5, 0.02], [nx - 0.12, nyy + al / 2 - 0.5, 0.02]], '#e53935', 'north');
    face([[nx - 0.45, nyy + al / 2 - 0.5, 0.02], [nx + 0.45, nyy + al / 2 - 0.5, 0.02], [nx, nyy + al / 2, 0.02], [nx, nyy + al / 2, 0.02]], '#e53935', 'north');

    var spanX = ext.x1 - ext.x0 - 2 * gpad, spanY = ext.y1 - ext.y0 - 2 * gpad;
    return {
      faces: F,
      meta: { span: Math.max(spanY, 1), length: Math.max(spanX, 1), eaves: H, bay: 3, frames: 0 },
      cx: (ext.x0 + ext.x1) / 2, cy: (ext.y0 + ext.y1) / 2
    };
  }

  // ── construction stages ─────────────────────────────────────────────
  function stages(u) {
    u = norm(u);
    var pr = program(u), q = quantities(u);
    var c = function (k) { return q.count[k] || 0; };
    var st = [];
    var area = q.lay.L * q.lay.W;
    if (u.mode === 'full') {
      st.push([tt('הכנת השטח והיסוד', 'เตรียมพื้นที่', 'تحضير الموقع'),
        tt('פילוס, מצע מהודק, יריעת פוליאתילן, יציקת רצפה ' + u.slabTh +
           ' מ\' עם רשת. להשאיר שרוולים לביוב ולמים לפני היציקה — קידוח בדיעבד בריצפה יצוקה הוא נזק.',
           'ปรับพื้นและเทพื้น', 'تسوية وصب الأرضية')]);
      st.push([tt('הקמת שלד ומעטפת', 'ติดตั้งโครงและเปลือก', 'إقامة الهيكل والغلاف'),
        tt('עמודים, מרישים, חיפוי ' + u.envelope + ', גג ומרזבים. איטום מלא לפני עבודות פנים.',
           'โครงและหลังคา', 'الهيكل والسقف')]);
    } else {
      st.push([tt('בדיקת המבנה הקיים', 'ตรวจอาคารเดิม', 'فحص المبنى القائم'),
        tt('לוודא גובה פנים ' + n1(u.height) + ' מ\' לפחות, מצב רצפה, אטימות גג, ונקודת חיבור לחשמל ולמים. ' +
           'שטח: ' + n1(area) + ' מ"ר.',
           'ตรวจความสูงและพื้น', 'فحص الارتفاع والأرضية')]);
    }
    st.push([tt('תשתיות רטובות', 'งานระบบน้ำ', 'أعمال السباكة'),
      tt('ביוב ודלוחין בשיפוע, מים קרים וחמים, נקודות ל-' + c('toilet') + ' אסלות, ' +
         c('shower') + ' מקלחות ו-' + c('basin') + ' כיורים. בדיקת לחץ לפני סגירת קירות.',
         'ทดสอบแรงดันก่อนปิดผนัง', 'اختبار الضغط قبل الإغلاق')]);
    st.push([tt('תשתית חשמל', 'งานไฟฟ้า', 'أعمال الكهرباء'),
      tt('לוח, הארקה, ' + c('light') + ' נקודות מאור ו-' + c('socket') + ' שקעים. כל ההשחלות לפני סגירת המחיצות.',
         'เดินสายก่อนปิดผนัง', 'التمديدات قبل الإغلاق')]);
    st.push([tt('מחיצות', 'ผนังกั้น', 'القواطع'),
      tt('מסילות U לרצפה ולתקרה, ' + n1(q.innerDry + q.innerWet) + ' מ\' קירות פנים. ' +
         (u.blockWet ? 'קירות בלוק בחדרים הרטובים (' + n1(q.innerWet) + ' מ\') לפני הפאנלים.' : 'מחיצות פאנל בכל החלל.'),
         'ติดตั้งผนัง', 'تركيب القواطع')]);
    st.push([tt('חדרים רטובים', 'ห้องน้ำ', 'الحمامات'),
      tt('איטום רצפה וקירות עד 1.8 מ\', ריצוף וחיפוי, ואז כלים סניטריים. איטום לפני ריצוף, לא אחריו.',
         'กันซึมก่อนปูกระเบื้อง', 'العزل قبل التبليط')]);
    st.push([tt('מטבח וריצוף', 'ครัวและพื้น', 'المطبخ والأرضيات'),
      tt(n1(q.counterM) + ' מ\' ארונות ומשטח, כיור וחיבורים. ריצוף כללי ' + n1(q.floor) + ' מ"ר.',
         'ครัวและปูพื้น', 'المطبخ والتبليط')]);
    st.push([tt('גמר ומסירה', 'เก็บงานและส่งมอบ', 'التشطيب والتسليم'),
      tt('צבע, דלתות, ' + (c('ac') ? 'מזגנים, ' : '') + 'ריהוט, בדיקת חשמל ומים, ניקיון ומסירה.',
         'ตรวจสอบและส่งมอบ', 'الفحص والتسليم')]);
    void pr;
    return st;
  }

  return {
    norm: norm, program: program, takeoff: takeoff, svg: svg, stages: stages,
    autoLayout: autoLayout, layoutOf: layoutOf, walls: walls, quantities: quantities, analyze: analyze,
    model3d: model3d, snapToWall: snapToWall, roomAt: roomAt, itemSize: itemSize, segEnds: segEnds,
    ITEMS: ITEMS, ROOM_TYPES: ROOM_TYPES, WET: WET, roomLabel: roomLabel, itemLabel: itemLabel, itemSym: itemSym,
    uid: uid
  };
})();
