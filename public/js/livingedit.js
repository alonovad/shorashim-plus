/* livingedit.js — עורך מתחם המגורים (accommodation editor)
 * ------------------------------------------------------------------
 * The hands-on half of the living unit. livingunit.js owns the model and
 * every number derived from it; this file lets you change the model:
 *
 *   PLAN    — drag rooms and items, snap doors and windows to walls,
 *             add anything from the palette, edit exact values in the
 *             inspector, toggle layers (furniture, electrical, plumbing,
 *             kitchen, openings) and overlay the cable and pipe runs the
 *             quantities are measured from. Undo for every edit.
 *   3D      — the same layout in the Shed3D viewer, standing on the real
 *             satellite image of the site, turned to its real bearing, with
 *             a north arrow and morning / noon / afternoon sun. Optional
 *             cut-away at 1.25 m to look into the rooms.
 *   MAP     — the floor plan drawn on the main map at true scale and
 *             orientation: rooms, walls, fittings.
 *
 * The first edit freezes the generated layout into the project (u.layout);
 * from then on the generator stays out of the way until "re-plan" is asked
 * for. Every change saves through BP.saveP() and repaints only this panel,
 * so the camera, the selection and the scroll position survive it.
 */
var LivingEdit = (function () {
  'use strict';

  var BP = window.BuildPlanInternals || {};
  var ST = {};                // per-project editor state
  var viewer = null;          // live Shed3D instance
  var viewerFor = null;
  var camState = {};          // per project camera
  var mapLayer = null;        // plan drawn on the main map
  var MPD = 111320;

  function tt(he, th, ar) { return BP.tt ? BP.tt(he, th, ar) : he; }
  function esc(s) { return BP.esc ? BP.esc(s) : String(s == null ? '' : s); }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function snap(v, s) { return Math.round(v / s) * s; }
  function proj(id) { return BP.projById ? BP.projById(id) : null; }
  function st(id) {
    if (!ST[id]) ST[id] = { view: 'plan', sel: null, cut: false, sun: 'noon', undo: [], link: true,
      show: { furn: 1, elec: 1, plumb: 1, kitchen: 1, open: 1, dims: 1, wires: 0, pipes: 0 } };
    return ST[id];
  }

  // ── model access ────────────────────────────────────────────────────
  // The layout as stored; materialised from the generator on first edit.
  function editable(p) {
    var u = p.living;
    var cur = LivingUnit.layoutOf(u);
    if (!u.layout || cur.scaledFrom) {
      u.layout = JSON.parse(JSON.stringify({ L: cur.L, W: cur.W, rooms: cur.rooms, items: cur.items }));
    }
    return u.layout;
  }
  function pushUndo(p) {
    var s = st(p.id);
    s.undo.push(p.living.layout ? JSON.stringify(p.living.layout) : null);
    if (s.undo.length > 40) s.undo.shift();
  }
  function commit(p) {
    if (BP.saveP) BP.saveP();
    redraw(p);
  }
  function findItem(lay, id) { return lay.items.filter(function (i) { return i.id === id; })[0]; }
  function findRoom(lay, id) { return lay.rooms.filter(function (r) { return r.id === id; })[0]; }

  // ── where the building is on the ground ─────────────────────────────
  function frameFor(p) {
    var fp = p.footprint || [];
    if (fp.length < 3) return { has: false, bearing: null, e0: 0, n0: 0 };
    var c = { lat: 0, lng: 0 };
    fp.forEach(function (q) { c.lat += q.lat; c.lng += q.lng; });
    c.lat /= fp.length; c.lng /= fp.length;
    var k = MPD * Math.cos(c.lat * Math.PI / 180);
    var bearing, ctr;
    if (p.rect && p.rect.w > 0) {
      bearing = Number(p.rect.rot) || 0;
      ctr = { lat: p.rect.lat, lng: p.rect.lng };
    } else {
      var best = 0;
      bearing = 90;
      for (var i = 0; i < fp.length; i++) {
        var a = fp[i], b = fp[(i + 1) % fp.length];
        var de = (b.lng - a.lng) * k, dn = (b.lat - a.lat) * MPD, len = Math.hypot(de, dn);
        if (len > best) { best = len; bearing = Math.atan2(de, dn) * 180 / Math.PI; }
      }
      ctr = c;
    }
    return { has: true, bearing: bearing, c: c, k: k,
             e0: (ctr.lng - c.lng) * k, n0: (ctr.lat - c.lat) * MPD };
  }
  // plan metres → lat/lng, the same chain model3d uses
  function planToLatLng(p, f, lay, x, y) {
    var u = LivingUnit.norm(p.living);
    var b = (f.bearing != null ? f.bearing : 90) * Math.PI / 180, sb = Math.sin(b), cb = Math.cos(b);
    var sr = u.site.rot * Math.PI / 180;
    var lu = x - lay.L / 2, lv = lay.W / 2 - y;
    var X = lu * Math.cos(sr) - lv * Math.sin(sr) + u.site.dx, Y = lu * Math.sin(sr) + lv * Math.cos(sr) + u.site.dy;
    var e = f.e0 + X * sb - Y * cb, n = f.n0 + X * cb + Y * sb;
    return [f.c.lat + n / MPD, f.c.lng + e / f.k];
  }
  // north, as an angle clockwise from "up" on the plan drawing
  function planNorth(p, f) {
    if (!f.has) return null;
    var u = LivingUnit.norm(p.living);
    var b = f.bearing * Math.PI / 180, r = u.site.rot * Math.PI / 180;
    var X = Math.cos(b), Y = Math.sin(b);
    var lu = X * Math.cos(r) + Y * Math.sin(r), lv = -X * Math.sin(r) + Y * Math.cos(r);
    return Math.atan2(lu, lv) * 180 / Math.PI;
  }

  // ── panel ───────────────────────────────────────────────────────────
  function css() {
    if (document.getElementById('lvStyles')) return;
    var s = document.createElement('style');
    s.id = 'lvStyles';
    s.textContent =
      '.lv-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px}' +
      '.lv-b{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;border-radius:9px;padding:5px 9px;font:inherit;font-size:.76rem;cursor:pointer;white-space:nowrap}' +
      '.lv-b.on{background:var(--accent,#ff9f43);color:#1b1b1b;border-color:transparent;font-weight:700}' +
      '.lv-b:disabled{opacity:.4}' +
      '.lv-cv{border-radius:10px;background:rgba(0,0,0,.12);overflow:hidden;position:relative}' +
      '.lv-3d{height:380px}' +
      '.lv-ins{margin-top:8px;padding:8px 10px;border-radius:10px;background:rgba(255,209,102,.08);border:1px solid rgba(255,209,102,.35);font-size:.8rem}' +
      '.lv-ins .lv-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}' +
      '.lv-ins input,.lv-ins select{width:72px;padding:3px 5px;font-size:.78rem}' +
      '.lv-ins input.wide{width:150px}' +
      '.lv-pal{margin-top:8px}.lv-pal summary{cursor:pointer;font-size:.8rem;font-weight:700}' +
      '.lv-pal .lv-bar{margin:6px 0 0}' +
      '.lv-q{margin-top:8px;font-size:.76rem;line-height:1.7}' +
      '.lv-q b{color:var(--accent,#ff9f43)}' +
      '.lv-warn{margin-top:6px;font-size:.76rem;color:#e0a030;line-height:1.6}' +
      '.lv-hint{font-size:.7rem;opacity:.65;margin-top:4px}' +
      '.lv-pill{position:fixed;left:50%;transform:translateX(-50%);bottom:80px;z-index:1600;display:flex;gap:6px;' +
      'background:#263238;color:#fff;border-radius:22px;padding:6px 8px;box-shadow:0 4px 16px rgba(0,0,0,.35);font:600 13px Heebo,sans-serif}' +
      '.lv-pill button{border:0;border-radius:16px;padding:6px 11px;font:inherit;cursor:pointer;background:rgba(255,255,255,.12);color:#fff}';
    document.head.appendChild(s);
  }

  function mount(p) {
    if (typeof LivingUnit === 'undefined' || !p || !p.living || !p.living.people) return;
    var host = document.getElementById('lvHost');
    if (!host) return;
    css();
    destroy3d();
    var s = st(p.id);
    host.innerHTML =
      '<div class="lv-bar" id="lvTop"></div>' +
      '<div class="lv-cv" id="lvCanvas"></div>' +
      '<div id="lvIns"></div>' +
      '<details class="lv-pal" ' + (s.palOpen ? 'open' : '') + ' ontoggle="LivingEdit.palToggle(' + p.id + ',this.open)">' +
        '<summary>\u2795 ' + tt('הוסף לתוכנית', 'เพิ่มลงในแผน', 'أضف إلى المخطط') + '</summary>' + palette(p) + '</details>' +
      '<div id="lvQty"></div>';
    var cv = document.getElementById('lvCanvas');
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv._pid = p.id;
    redraw(p);
  }

  function redraw(p) {
    var s = st(p.id);
    var top = document.getElementById('lvTop');
    if (!top) return;
    var f = frameFor(p);
    var lay = LivingUnit.layoutOf(p.living);
    var chip = function (k, label) {
      return '<button class="lv-b' + (s.show[k] ? ' on' : '') + '" onclick="LivingEdit.layer(' + p.id + ',\'' + k + '\')">' + label + '</button>';
    };
    top.innerHTML =
      '<button class="lv-b' + (s.view === 'plan' ? ' on' : '') + '" onclick="LivingEdit.view(' + p.id + ',\'plan\')">\ud83d\udcd0 ' + tt('תוכנית', 'แผนผัง', 'مخطط') + '</button>' +
      '<button class="lv-b' + (s.view === '3d' ? ' on' : '') + '" onclick="LivingEdit.view(' + p.id + ',\'3d\')">\ud83e\uddca ' + tt('תלת-מימד', '3 มิติ', 'ثلاثي الأبعاد') + '</button>' +
      '<button class="lv-b" onclick="LivingEdit.showOnMap(' + p.id + ')"' + (f.has ? '' : ' disabled title="' +
        esc(tt('מקם קודם את הפרויקט על המפה בלשונית האתר', 'วางโครงการบนแผนที่ก่อน', 'ضع المشروع على الخريطة أولاً')) + '"') + '>\ud83d\uddfa ' + tt('על המפה', 'บนแผนที่', 'على الخريطة') + '</button>' +
      '<button class="lv-b" onclick="LivingEdit.undo(' + p.id + ')"' + (s.undo.length ? '' : ' disabled') + '>\u21b6 ' + tt('בטל', 'เลิกทำ', 'تراجع') + '</button>' +
      '<span style="flex-basis:100%;height:0"></span>' +
      chip('furn', '\ud83d\udecf ' + tt('ריהוט', 'เฟอร์นิเจอร์', 'أثاث')) +
      chip('elec', '\u26a1 ' + tt('חשמל', 'ไฟฟ้า', 'كهرباء')) +
      chip('plumb', '\ud83d\udeb0 ' + tt('אינסטלציה', 'ประปา', 'سباكة')) +
      chip('kitchen', '\ud83c\udf73 ' + tt('מטבח', 'ครัว', 'مطبخ')) +
      chip('open', '\ud83d\udeaa ' + tt('פתחים', 'ช่องเปิด', 'فتحات')) +
      (s.view === 'plan'
        ? chip('wires', '\u3030 ' + tt('תוואי כבלים', 'แนวสายไฟ', 'مسار الكابلات')) +
          chip('pipes', '\u3030 ' + tt('תוואי צנרת', 'แนวท่อ', 'مسار الأنابيب'))
        : '<button class="lv-b' + (s.cut ? ' on' : '') + '" onclick="LivingEdit.cut(' + p.id + ')">\u2702 ' + tt('חתך קירות', 'ตัดผนัง', 'قطع الجدران') + '</button>' +
          ['morning', 'noon', 'evening'].map(function (k) {
            return '<button class="lv-b' + (s.sun === k ? ' on' : '') + '" onclick="LivingEdit.sun(' + p.id + ',\'' + k + '\')">' +
              { morning: '\ud83c\udf05 ' + tt('בוקר', 'เช้า', 'صباح'), noon: '\u2600 ' + tt('צהריים', 'เที่ยง', 'ظهر'),
                evening: '\ud83c\udf07 ' + tt('אחה"צ', 'บ่าย', 'عصر') }[k] + '</button>';
          }).join('') +
          '<button class="lv-b" onclick="LivingEdit.top(' + p.id + ')">\u2b07 ' + tt('מבט על', 'มุมบน', 'منظر علوي') + '</button>');

    if (s.view === '3d') draw3d(p);
    else {
      destroy3d();
      var cv = document.getElementById('lvCanvas');
      cv.className = 'lv-cv';
      cv.innerHTML = LivingUnit.svg(p.living, { show: s.show, sel: s.sel, interactive: true, north: planNorth(p, f) });
      if (s.sel && s.sel.t === 'room') handles(cv.querySelector('svg'), lay, s.sel.id);
    }
    inspector(p);
    qty(p, lay);
  }

  // ── room resize ─────────────────────────────────────────────────────
  // Eight handles on the selected room: four edges, four corners. Sized
  // from the building so they stay grabbable on a phone at any scale.
  var NS_SVG = 'http://www.w3.org/2000/svg';
  function handles(svg, lay, id) {
    var r = findRoom(lay, id); if (!svg || !r) return;
    var hs = Math.max(0.22, Math.min(0.42, Math.min(lay.L, lay.W) / 26));
    var pts = { nw: [r.x, r.y], n: [r.x + r.w / 2, r.y], ne: [r.x + r.w, r.y], e: [r.x + r.w, r.y + r.h / 2],
                se: [r.x + r.w, r.y + r.h], s: [r.x + r.w / 2, r.y + r.h], sw: [r.x, r.y + r.h], w: [r.x, r.y + r.h / 2] };
    var cur = { nw: 'nwse', se: 'nwse', ne: 'nesw', sw: 'nesw', n: 'ns', s: 'ns', e: 'ew', w: 'ew' };
    Object.keys(pts).forEach(function (k) {
      var el = document.createElementNS(NS_SVG, 'rect');
      var corner = k.length === 2;
      el.setAttribute('x', pts[k][0] - hs / 2); el.setAttribute('y', pts[k][1] - hs / 2);
      el.setAttribute('width', hs); el.setAttribute('height', hs);
      el.setAttribute('rx', corner ? 0.03 : hs / 2);
      el.setAttribute('fill', corner ? '#ffd166' : '#ff9f43');
      el.setAttribute('stroke', '#1b1b1b'); el.setAttribute('stroke-width', 0.03);
      el.setAttribute('data-handle', k);
      el.setAttribute('style', 'cursor:' + cur[k] + '-resize');
      svg.appendChild(el);
    });
  }
  function edgeSnap(v, list) {
    var out = snap(v, 0.05), bd = 0.15;
    list.forEach(function (e) { if (Math.abs(v - e) < bd) { bd = Math.abs(v - e); out = e; } });
    return out;
  }
  // New edges for room r after dragging handle h by (dx, dy). With link on,
  // a room whose opposite edge lay on the moved edge follows it, so the
  // shared wall moves instead of opening a gap or an overlap.
  function resizeRoom(lay, r, h, dx, dy, link) {
    var MIN = 0.6;
    var xs = [0, lay.L], ys = [0, lay.W];
    lay.rooms.forEach(function (o) { if (o.id === r.id) return; xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); });
    var x1 = r.x, x2 = r.x + r.w, y1 = r.y, y2 = r.y + r.h;
    var ox1 = x1, ox2 = x2, oy1 = y1, oy2 = y2;
    if (h.indexOf('w') >= 0) x1 = Math.max(0, Math.min(x2 - MIN, edgeSnap(x1 + dx, xs)));
    if (h.indexOf('e') >= 0) x2 = Math.min(lay.L, Math.max(x1 + MIN, edgeSnap(x2 + dx, xs)));
    if (h.indexOf('n') >= 0) y1 = Math.max(0, Math.min(y2 - MIN, edgeSnap(y1 + dy, ys)));
    if (h.indexOf('s') >= 0) y2 = Math.min(lay.W, Math.max(y1 + MIN, edgeSnap(y2 + dy, ys)));
    if (link) {
      var ov = function (a1, a2, b1, b2) { return Math.min(a2, b2) - Math.max(a1, b1) > 0.05; };
      lay.rooms.forEach(function (o) {
        if (o.id === r.id) return;
        var oR = o.x + o.w, oB = o.y + o.h;
        if (x2 !== ox2 && Math.abs(o.x - ox2) < 0.03 && ov(oy1, oy2, o.y, oB) && oR - x2 >= MIN) { o.x = n2(x2); o.w = n2(oR - x2); }
        if (x1 !== ox1 && Math.abs(oR - ox1) < 0.03 && ov(oy1, oy2, o.y, oB) && x1 - o.x >= MIN) { o.w = n2(x1 - o.x); }
        if (y2 !== oy2 && Math.abs(o.y - oy2) < 0.03 && ov(ox1, ox2, o.x, oR) && oB - y2 >= MIN) { o.y = n2(y2); o.h = n2(oB - y2); }
        if (y1 !== oy1 && Math.abs(oB - oy1) < 0.03 && ov(ox1, ox2, o.x, oR) && y1 - o.y >= MIN) { o.h = n2(y1 - o.y); }
      });
    }
    r.x = n2(x1); r.y = n2(y1); r.w = n2(x2 - x1); r.h = n2(y2 - y1);
  }
  // Two rooms where there was one, along its longer or shorter side.
  function splitRoom(lay, r, across) {
    var c = JSON.parse(JSON.stringify(r));
    c.id = LivingUnit.uid();
    c.name = r.name ? r.name + ' 2' : '';
    if (across) { var h2 = n2(r.h / 2); c.y = n2(r.y + h2); c.h = n2(r.h - h2); r.h = h2; }
    else { var w2 = n2(r.w / 2); c.x = n2(r.x + w2); c.w = n2(r.w - w2); r.w = w2; }
    lay.rooms.push(c);
    return c;
  }

  // ── plan interaction ────────────────────────────────────────────────
  var drag = null;
  function svgPt(svg, ev) {
    var pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    var m = svg.getScreenCTM();
    if (!m) return { x: 0, y: 0 };
    var r = pt.matrixTransform(m.inverse());
    return { x: r.x, y: r.y };
  }
  function onDown(ev) {
    var cv = ev.currentTarget, p = proj(cv._pid);
    if (!p || st(p.id).view !== 'plan') return;
    var svg = cv.querySelector('svg'); if (!svg) return;
    var gi = ev.target.closest('[data-item]'), gr = ev.target.closest('[data-room]');
    var gh = ev.target.closest('[data-handle]');
    var pos = svgPt(svg, ev);
    if (gh && st(p.id).sel && st(p.id).sel.t === 'room') {
      var rid = st(p.id).sel.id;
      drag = { t: 'handle', h: gh.getAttribute('data-handle'), id: rid, el: svg.querySelector('[data-room="' + rid + '"]'),
               x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (gi) drag = { t: 'item', id: gi.getAttribute('data-item'), el: gi, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    else if (gr) drag = { t: 'room', id: gr.getAttribute('data-room'), el: gr, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    else { drag = { t: 'none', x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p }; return; }
    try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
    ev.preventDefault();
  }
  function onMove(ev) {
    if (!drag || drag.t === 'none') return;
    var pos = svgPt(drag.svg, ev);
    var dx = pos.x - drag.x0, dy = pos.y - drag.y0;
    if (Math.hypot(dx, dy) > 0.04) drag.moved = 1;
    if (!drag.moved) return;
    if (drag.t === 'handle') {
      var lay0 = LivingUnit.layoutOf(drag.p.living), r0 = findRoom(lay0, drag.id);
      if (!r0 || !drag.el) return;
      var tmp = JSON.parse(JSON.stringify(lay0)), rr = findRoom(tmp, drag.id);
      resizeRoom(tmp, rr, drag.h, dx, dy, false);
      drag.el.setAttribute('x', rr.x); drag.el.setAttribute('y', rr.y);
      drag.el.setAttribute('width', rr.w); drag.el.setAttribute('height', rr.h);
      drag.el.setAttribute('stroke', '#ffd166'); drag.el.setAttribute('stroke-width', 0.1);
      drag.el.setAttribute('stroke-dasharray', '0.2 0.12');
      return;
    }
    var tr = 'translate(' + dx + ' ' + dy + ')';
    drag.el.setAttribute('transform', tr);
    if (drag.t === 'room') {
      // items inside travel with their room
      if (!drag.inside) {
        var lay = LivingUnit.layoutOf(drag.p.living), r = findRoom(lay, drag.id);
        drag.inside = r ? lay.items.filter(function (it) {
          return it.x > r.x && it.x < r.x + r.w && it.y > r.y && it.y < r.y + r.h;
        }).map(function (it) { return it.id; }) : [];
      }
      drag.inside.forEach(function (id) {
        var g = drag.svg.querySelector('[data-item="' + id + '"]');
        if (g) g.setAttribute('transform', tr);
      });
    }
  }
  function onUp(ev) {
    if (!drag) return;
    var d = drag; drag = null;
    var p = d.p, s = st(p.id);
    // A cancelled gesture (scroll took over, call came in) moves nothing.
    if (ev.type === 'pointercancel') { redraw(p); return; }
    var pos = svgPt(d.svg, ev);
    if (d.t === 'none') { if (s.sel) { s.sel = null; redraw(p); } return; }
    if (!d.moved) {
      s.sel = { t: d.t, id: d.id };
      redraw(p);
      return;
    }
    var dx = pos.x - d.x0, dy = pos.y - d.y0;
    pushUndo(p);
    var lay = editable(p);
    if (d.t === 'handle') {
      var rh = findRoom(lay, d.id);
      if (rh) resizeRoom(lay, rh, d.h, dx, dy, s.link);
      s.sel = { t: 'room', id: d.id };
      commit(p);
      return;
    }
    if (d.t === 'item') {
      var it = findItem(lay, d.id);
      if (it) placeItem(lay, it, it.x + dx, it.y + dy);
    } else {
      var r = findRoom(lay, d.id);
      if (r) {
        var nx = Math.max(0, Math.min(lay.L - r.w, snap(r.x + dx, 0.05)));
        var ny = Math.max(0, Math.min(lay.W - r.h, snap(r.y + dy, 0.05)));
        var m = magnet(lay, r, nx, ny); nx = m.x; ny = m.y;
        var mx = nx - r.x, my = ny - r.y;
        (d.inside || []).forEach(function (id) { var i2 = findItem(lay, id); if (i2) { i2.x = n2(i2.x + mx); i2.y = n2(i2.y + my); } });
        r.x = n2(nx); r.y = n2(ny);
      }
    }
    s.sel = { t: d.t, id: d.id };
    commit(p);
  }
  // Pull a dragged room's edges onto nearby room edges and the outline.
  function magnet(lay, r, x, y) {
    var xs = [0, lay.L], ys = [0, lay.W];
    lay.rooms.forEach(function (o) { if (o.id === r.id) return; xs.push(o.x, o.x + o.w); ys.push(o.y, o.y + o.h); });
    var best = function (v, w, list) {
      var out = v, bd = 0.2;
      list.forEach(function (e) {
        if (Math.abs(v - e) < bd) { bd = Math.abs(v - e); out = e; }
        if (Math.abs(v + w - e) < bd) { bd = Math.abs(v + w - e); out = e - w; }
      });
      return out;
    };
    return { x: best(x, r.w, xs), y: best(y, r.h, ys) };
  }
  // Doors and windows go into the nearest wall; everything else snaps to 5 cm.
  function placeItem(lay, it, x, y) {
    var d = LivingUnit.ITEMS[it.kind];
    x = Math.max(0, Math.min(lay.L, x)); y = Math.max(0, Math.min(lay.W, y));
    if (d && d.wall) {
      var w = LivingUnit.snapToWall(lay, x, y);
      if (w && w.d < 1.2) {
        var sameAxis = (w.rot === 0) === (it.rot === 0 || it.rot === 180);
        it.x = n2(snap(w.x, 0.05)); it.y = n2(snap(w.y, 0.05));
        if (!sameAxis) it.rot = w.rot;
        return;
      }
    }
    it.x = n2(snap(x, 0.05)); it.y = n2(snap(y, 0.05));
  }

  // ── inspector ───────────────────────────────────────────────────────
  function inspector(p) {
    var box = document.getElementById('lvIns'); if (!box) return;
    var s = st(p.id), lay = LivingUnit.layoutOf(p.living);
    if (!s.sel) {
      box.innerHTML = '<div class="lv-hint">' + tt('לחץ על חדר או פריט כדי לערוך אותו · גרור כדי להזיז · דלתות וחלונות נצמדים לקיר הקרוב',
        'แตะห้องหรือรายการเพื่อแก้ไข · ลากเพื่อย้าย · ประตูและหน้าต่างติดผนังใกล้สุด',
        'اضغط غرفة أو عنصراً للتحرير · اسحب للنقل · الأبواب والنوافذ تلتصق بأقرب جدار') + '</div>';
      return;
    }
    var id = p.id;
    var inp = function (k, v, step, cls) {
      return '<input class="bp-in ' + (cls || '') + '" type="number" step="' + (step || 0.05) + '" value="' + v + '" onchange="LivingEdit.set(' + id + ',\'' + k + '\',this.value)">';
    };
    var lab = function (t) { return '<span style="opacity:.7">' + t + '</span>'; };
    if (s.sel.t === 'item') {
      var it = findItem(lay, s.sel.id);
      if (!it) { s.sel = null; box.innerHTML = ''; return; }
      var d = LivingUnit.ITEMS[it.kind], w = (it.w != null) ? it.w : d.w;
      var room = LivingUnit.roomAt(lay, it.x, it.y);
      box.innerHTML = '<div class="lv-ins"><b>' + LivingUnit.itemSym(it.kind) + ' ' + esc(LivingUnit.itemLabel(it.kind)) + '</b>' +
        (room ? ' <span style="opacity:.7">\u00b7 ' + esc(room.name || LivingUnit.roomLabel(room.type)) + '</span>' : '') +
        '<div class="lv-row">' + lab('X') + inp('x', it.x) + lab('Y') + inp('y', it.y) +
          ((d.resize || d.wall) ? lab(tt('רוחב', 'กว้าง', 'عرض')) + inp('w', w) : '') + '</div>' +
        '<div class="lv-row">' +
          '<button class="lv-b" onclick="LivingEdit.rot(' + id + ',-90)">\u27f2 90\u00b0</button>' +
          '<button class="lv-b" onclick="LivingEdit.rot(' + id + ',90)">\u27f3 90\u00b0</button>' +
          ((it.kind === 'door' || it.kind === 'door_ext') ? '<button class="lv-b" onclick="LivingEdit.flip(' + id + ')">\u21c4 ' + tt('כיוון פתיחה', 'ทิศเปิด', 'اتجاه الفتح') + '</button>' : '') +
          '<button class="lv-b" onclick="LivingEdit.dup(' + id + ')">\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ') + '</button>' +
          '<button class="lv-b" onclick="LivingEdit.del(' + id + ')">\ud83d\uddd1 ' + tt('מחק', 'ลบ', 'حذف') + '</button>' +
        '</div></div>';
      return;
    }
    var r = findRoom(lay, s.sel.id);
    if (!r) { s.sel = null; box.innerHTML = ''; return; }
    box.innerHTML = '<div class="lv-ins"><b>\u25ad ' + esc(r.name || LivingUnit.roomLabel(r.type)) + '</b> <span style="opacity:.7">\u00b7 ' + n1(r.w * r.h) + ' m\u00b2</span>' +
      '<div class="lv-row">' + lab(tt('שם', 'ชื่อ', 'الاسم')) +
        '<input class="bp-in wide" value="' + esc(r.name) + '" onchange="LivingEdit.setRoom(' + id + ',\'name\',this.value)">' +
        '<select class="bp-in" style="width:auto" onchange="LivingEdit.setRoom(' + id + ',\'type\',this.value)">' +
        LivingUnit.ROOM_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (t === r.type ? ' selected' : '') + '>' + esc(LivingUnit.roomLabel(t)) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="lv-row">' + lab('X') + inp('x', r.x) + lab('Y') + inp('y', r.y) +
        lab(tt('אורך', 'ยาว', 'طول')) + inp('w', r.w) + lab(tt('רוחב', 'กว้าง', 'عرض')) + inp('h', r.h) + '</div>' +
      '<div class="lv-row"><label><input type="checkbox"' + (r.open ? ' checked' : '') + ' onchange="LivingEdit.setRoom(' + id + ',\'open\',this.checked)"> ' +
        tt('חלל פתוח (בלי קיר לחללים פתוחים סמוכים)', 'พื้นที่เปิด', 'مساحة مفتوحة') + '</label></div>' +
      '<div class="lv-row"><label><input type="checkbox"' + (s.link ? ' checked' : '') + ' onchange="LivingEdit.link(' + id + ',this.checked)"> \ud83d\udd17 ' +
        tt('גרירת קצה מזיזה גם את החדר הצמוד (קיר משותף)', 'ลากขอบแล้วห้องข้างเคียงขยับตาม', 'سحب الحافة يحرك الغرفة المجاورة أيضاً') + '</label></div>' +
      '<div class="lv-hint">' + tt('גרור את הידיות הכתומות כדי לשנות גודל · גרור את החדר כדי להזיז אותו עם התכולה',
        'ลากที่จับสีส้มเพื่อปรับขนาด · ลากห้องเพื่อย้าย', 'اسحب المقابض البرتقالية لتغيير الحجم · اسحب الغرفة لنقلها') + '</div>' +
      '<div class="lv-row">' +
        '<button class="lv-b" onclick="LivingEdit.split(' + id + ',0)">\u2af4 ' + tt('חלק לאורך', 'แบ่งตามยาว', 'قسّم طولياً') + '</button>' +
        '<button class="lv-b" onclick="LivingEdit.split(' + id + ',1)">\u2550 ' + tt('חלק לרוחב', 'แบ่งตามขวาง', 'قسّم عرضياً') + '</button>' +
        '<button class="lv-b" onclick="LivingEdit.dupRoom(' + id + ')">\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ') + '</button>' +
        '<button class="lv-b" onclick="LivingEdit.delRoom(' + id + ')">\ud83d\uddd1 ' + tt('מחק חדר', 'ลบห้อง', 'حذف الغرفة') + '</button>' +
      '</div></div>';
  }

  function palette(p) {
    var groups = [
      ['\ud83d\udeaa ' + tt('פתחים', 'ช่องเปิด', 'فتحات'), ['door', 'door_ext', 'window']],
      ['\u26a1 ' + tt('חשמל', 'ไฟฟ้า', 'كهرباء'), ['socket', 'light', 'switch', 'ac', 'panel']],
      ['\ud83d\udeb0 ' + tt('אינסטלציה וניקוז', 'ประปาและระบายน้ำ', 'سباكة وصرف'), ['toilet', 'shower', 'basin', 'drain', 'washer', 'heater', 'water_in', 'sewer_exit']],
      ['\ud83c\udf73 ' + tt('מטבח', 'ครัว', 'مطبخ'), ['counter', 'sink', 'stove', 'fridge']],
      ['\ud83d\udecf ' + tt('ריהוט', 'เฟอร์นิเจอร์', 'أثاث'), ['bed', 'bunk', 'wardrobe', 'table', 'bench', 'sofa']]
    ];
    return groups.map(function (g) {
      return '<div class="lv-hint" style="margin-top:6px;opacity:.85">' + g[0] + '</div><div class="lv-bar">' +
        g[1].map(function (k) {
          return '<button class="lv-b" onclick="LivingEdit.add(' + p.id + ',\'' + k + '\')">' + LivingUnit.itemSym(k) + ' ' + esc(LivingUnit.itemLabel(k)) + '</button>';
        }).join('') + '</div>';
    }).join('') +
    '<div class="lv-hint" style="margin-top:6px;opacity:.85">\u25ad ' + tt('חדרים', 'ห้อง', 'غرف') + '</div><div class="lv-bar">' +
      LivingUnit.ROOM_TYPES.map(function (t) {
        return '<button class="lv-b" onclick="LivingEdit.addRoom(' + p.id + ',\'' + t + '\')">' + esc(LivingUnit.roomLabel(t)) + '</button>';
      }).join('') + '</div>';
  }

  function qty(p, lay) {
    var box = document.getElementById('lvQty'); if (!box) return;
    var q = LivingUnit.quantities(p.living), warn = LivingUnit.analyze(p.living);
    var c = function (k) { return q.count[k] || 0; };
    var doorsInt = Object.keys(q.doorsInt).reduce(function (s, k) { return s + q.doorsInt[k]; }, 0);
    var wins = Object.keys(q.windows).reduce(function (s, k) { return s + q.windows[k]; }, 0);
    box.innerHTML = '<div class="lv-q">' +
      tt('קירות פנים', 'ผนังภายใน', 'جدران داخلية') + ' <b>' + n1(q.innerDry + q.innerWet) + ' m</b> (' +
        tt('רטובים', 'เปียก', 'رطبة') + ' ' + n1(q.innerWet) + ') \u00b7 ' +
      tt('חוץ', 'ภายนอก', 'خارجية') + ' <b>' + n1(q.outer) + ' m</b> \u00b7 ' +
      tt('רצפה', 'พื้น', 'أرضية') + ' <b>' + n1(q.floor) + ' m\u00b2</b><br>' +
      tt('דלתות', 'ประตู', 'أبواب') + ' <b>' + (doorsInt + q.doorsExt) + '</b> \u00b7 ' +
      tt('חלונות', 'หน้าต่าง', 'نوافذ') + ' <b>' + wins + '</b> \u00b7 ' +
      tt('שקעים', 'เต้ารับ', 'مقابس') + ' <b>' + c('socket') + '</b> \u00b7 ' +
      tt('מאור', 'ไฟ', 'إنارة') + ' <b>' + c('light') + '</b> \u00b7 ' +
      tt('מזגנים', 'แอร์', 'مكيفات') + ' <b>' + c('ac') + '</b><br>' +
      tt('כבלים', 'สายไฟ', 'كابلات') + ' <b>' + n1(q.cable25 + q.cable15) + ' m</b> \u00b7 ' +
      tt('מים', 'น้ำ', 'ماء') + ' <b>' + n1(q.cold + q.hot) + ' m</b> \u00b7 ' +
      tt('ביוב', 'น้ำเสีย', 'صرف') + ' <b>' + n1(q.drainPipe) + ' m</b>' +
      '<div class="lv-hint">' + tt('כתב הכמויות המלא, כולל מחיצות, חיפויים ותשתיות, נמצא בלשונית החומרים.',
        'รายการวัสดุเต็มอยู่ในแท็บวัสดุ', 'جدول الكميات الكامل في تبويب المواد') + '</div></div>' +
      (warn.length ? '<div class="lv-warn">\u26a0\ufe0f ' + warn.map(esc).join('<br>\u26a0\ufe0f ') + '</div>' : '') +
      (lay.scaledFrom ? '<div class="lv-hint">\u2194 ' + tt('הפריסה הותאמה למידות החדשות — בדוק מיקומים', 'ปรับตามขนาดใหม่', 'تم تكييف المخطط للأبعاد الجديدة') + '</div>' : '');
  }

  // ── 3D ──────────────────────────────────────────────────────────────
  function sunOf(k) {
    return { morning: [0, 0.45], noon: [-Math.PI / 2, 1.2], evening: [Math.PI, 0.45] }[k] || [-Math.PI / 2, 1.2];
  }
  function model(p) {
    var s = st(p.id), f = frameFor(p);
    return LivingUnit.model3d(p.living, f.has ? f : { bearing: null }, { show: s.show, cut: s.cut });
  }
  function labelsFor(p) {
    var lay = LivingUnit.layoutOf(p.living), out = {};
    lay.rooms.forEach(function (r) { out['room:' + r.id] = { title: r.name || LivingUnit.roomLabel(r.type), sub: n1(r.w * r.h) + ' m\u00b2' }; });
    lay.items.forEach(function (it) {
      var r = LivingUnit.roomAt(lay, it.x, it.y);
      out['it:' + it.id] = { title: LivingUnit.itemLabel(it.kind), sub: r ? (r.name || LivingUnit.roomLabel(r.type)) : '' };
    });
    out.north = { title: tt('צפון', 'ทิศเหนือ', 'الشمال'), sub: '' };
    return out;
  }
  function draw3d(p) {
    var cv = document.getElementById('lvCanvas');
    if (!cv || typeof Shed3D === 'undefined') return;
    var s = st(p.id);
    if (viewer && viewerFor === p.id) { viewer.update(model(p)); return; }
    destroy3d();
    cv.className = 'lv-cv lv-3d';
    var sun = sunOf(s.sun);
    viewer = Shed3D.mount(cv, model(p), {
      state: camState[p.id] || { sunAz: sun[0], sunEl: sun[1] },
      labels: labelsFor(p),
      onSelect: function (g) {
        g = String(g || '');
        if (g.indexOf('it:') === 0) s.sel = { t: 'item', id: g.slice(3) };
        else if (g.indexOf('room:') === 0) s.sel = { t: 'room', id: g.slice(5) };
        else s.sel = null;
        inspector(p);
      }
    });
    viewerFor = p.id;
    var f = frameFor(p);
    if (f.has && BP.groundImage) {
      var m = model(p), half = Math.max(m.meta.length, m.meta.span) * 0.5 + Math.max(m.meta.length, m.meta.span) * 0.9;
      BP.groundImage(p, half, half).then(function (g) {
        if (g && viewer && viewerFor === p.id) viewer.setGround(g.img, g.extent);
      });
    }
  }
  function destroy3d() {
    if (viewer) {
      try { camState[viewerFor] = viewer.getState(); } catch (e) {}
      try { viewer.destroy(); } catch (e) {}
    }
    viewer = null; viewerFor = null;
  }

  // ── map overlay ─────────────────────────────────────────────────────
  function clearMap() {
    var m = (window.MapAccess && MapAccess.getMap) ? MapAccess.getMap() : null;
    if (mapLayer && m) m.removeLayer(mapLayer);
    mapLayer = null;
    var pill = document.getElementById('lvPill'); if (pill && pill.parentNode) pill.parentNode.removeChild(pill);
  }
  function showOnMap(id) {
    var p = proj(id);
    if (!p || !p.living) return;
    var f = frameFor(p);
    if (!f.has) {
      if (BP.toast) BP.toast('\u26a0\ufe0f ' + tt('מקם קודם את הפרויקט על המפה בלשונית האתר', 'วางโครงการบนแผนที่ก่อน', 'ضع المشروع على الخريطة أولاً'));
      return;
    }
    if (!window.MapAccess || !MapAccess.getMap) return;
    clearMap();
    destroy3d();
    if (BP.close) BP.close();
    if (MapAccess.goToMap) MapAccess.goToMap();
    var lmap = MapAccess.getMap();
    var lay = LivingUnit.layoutOf(p.living), segs = LivingUnit.walls(lay);
    var ll = function (x, y) { return planToLatLng(p, f, lay, x, y); };
    var grp = L.layerGroup();
    var fill = { bed: '#eceff1', wc: '#4fc3f7', shower: '#4fc3f7', wash: '#81d4fa', laundry: '#9575cd', kitchen: '#ffb74d',
                 dining: '#81c784', corridor: '#e0e0e0', store: '#a1887f', office: '#fff176' };
    lay.rooms.forEach(function (r) {
      L.polygon([ll(r.x, r.y), ll(r.x + r.w, r.y), ll(r.x + r.w, r.y + r.h), ll(r.x, r.y + r.h)], {
        color: '#263238', weight: 0, fillColor: fill[r.type] || '#e0e0e0', fillOpacity: 0.55
      }).bindTooltip(esc(r.name || LivingUnit.roomLabel(r.type)) + ' \u00b7 ' + n1(r.w * r.h) + ' m\u00b2', { sticky: true }).addTo(grp);
    });
    segs.forEach(function (sg) {
      var e = LivingUnit.segEnds(sg);
      L.polyline([ll(e.x1, e.y1), ll(e.x2, e.y2)], { color: '#212121', weight: sg.outer ? 4 : 2, opacity: 0.9 }).addTo(grp);
    });
    var catCol = { elec: '#f9a825', plumb: '#1e88e5', kitchen: '#8d6e63', furn: '#6d4c41', open: '#00838f' };
    lay.items.forEach(function (it) {
      var d = LivingUnit.ITEMS[it.kind]; if (!d) return;
      var sz = LivingUnit.itemSize(it);
      var tip = LivingUnit.itemSym(it.kind) + ' ' + esc(LivingUnit.itemLabel(it.kind));
      if (sz.w >= 0.35 && sz.h >= 0.35 && !d.wall) {
        L.polygon([ll(it.x - sz.w / 2, it.y - sz.h / 2), ll(it.x + sz.w / 2, it.y - sz.h / 2),
                   ll(it.x + sz.w / 2, it.y + sz.h / 2), ll(it.x - sz.w / 2, it.y + sz.h / 2)], {
          color: catCol[d.cat] || '#455a64', weight: 1, fillColor: d.col || '#90a4ae', fillOpacity: 0.85
        }).bindTooltip(tip, { sticky: true }).addTo(grp);
      } else {
        L.circleMarker(ll(it.x, it.y), { radius: d.wall ? 4 : 3, color: '#fff', weight: 1,
          fillColor: catCol[d.cat] || '#455a64', fillOpacity: 1 }).bindTooltip(tip).addTo(grp);
      }
    });
    grp.addTo(lmap);
    mapLayer = grp;
    setTimeout(function () {
      lmap.invalidateSize();
      var pts = [ll(0, 0), ll(lay.L, 0), ll(lay.L, lay.W), ll(0, lay.W)];
      lmap.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
    }, 150);
    css();
    var pill = document.createElement('div');
    pill.id = 'lvPill';
    pill.className = 'lv-pill';
    pill.innerHTML = '<span style="padding:6px 4px">\ud83c\udfe0 ' + esc(p.name || '') + '</span>' +
      '<button onclick="LivingEdit.backToProject(' + id + ')">\u21a9 ' + tt('לפרויקט', 'กลับโครงการ', 'للمشروع') + '</button>' +
      '<button onclick="LivingEdit.hideMap()">\u2715</button>';
    document.body.appendChild(pill);
  }

  // ── actions ─────────────────────────────────────────────────────────
  function withP(id, fn) {
    var p = proj(id); if (!p || !p.living) return;
    fn(p);
  }
  var API = {
    mount: mount,
    view: function (id, v) { withP(id, function (p) { st(id).view = v === '3d' ? '3d' : 'plan'; redraw(p); }); },
    layer: function (id, k) { withP(id, function (p) { var s = st(id); s.show[k] = s.show[k] ? 0 : 1; redraw(p); }); },
    cut: function (id) { withP(id, function (p) { st(id).cut = !st(id).cut; redraw(p); }); },
    sun: function (id, k) {
      withP(id, function (p) {
        st(id).sun = k;
        var sv = sunOf(k);
        if (viewer) viewer.setSun(sv[0], sv[1]);
        redraw(p);
      });
    },
    top: function (id) { if (viewer && viewerFor === id) viewer.setView(0, 1.45); },
    palToggle: function (id, open) { st(id).palOpen = !!open; },
    undo: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.undo.length) return;
        var prev = s.undo.pop();
        p.living.layout = prev ? JSON.parse(prev) : null;
        s.sel = null;
        commit(p);
      });
    },
    set: function (id, k, v) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel) return;
        pushUndo(p);
        var lay = editable(p);
        var x = Number(v); if (!isFinite(x)) return;
        if (s.sel.t === 'item') {
          var it = findItem(lay, s.sel.id); if (!it) return;
          if (k === 'w') it.w = Math.max(0.1, n2(x));
          else if (k === 'x') placeItem(lay, it, x, it.y);
          else if (k === 'y') placeItem(lay, it, it.x, x);
        } else {
          var r = findRoom(lay, s.sel.id); if (!r) return;
          if (k === 'w' || k === 'h') r[k] = Math.max(0.5, n2(x));
          else r[k] = Math.max(0, n2(x));
          r.x = Math.min(r.x, Math.max(0, lay.L - r.w)); r.y = Math.min(r.y, Math.max(0, lay.W - r.h));
          r.w = Math.min(r.w, lay.L - r.x); r.h = Math.min(r.h, lay.W - r.y);
        }
        commit(p);
      });
    },
    setRoom: function (id, k, v) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'room') return;
        pushUndo(p);
        var r = findRoom(editable(p), s.sel.id); if (!r) return;
        if (k === 'open') r.open = !!v;
        else if (k === 'type') { r.type = String(v); if (r.type === 'corridor' || r.type === 'dining' || r.type === 'kitchen') r.open = true; }
        else r.name = String(v || '');
        commit(p);
      });
    },
    rot: function (id, deg) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'item') return;
        pushUndo(p);
        var lay = editable(p), it = findItem(lay, s.sel.id); if (!it) return;
        it.rot = ((it.rot + deg) % 360 + 360) % 360;
        if (LivingUnit.ITEMS[it.kind].wall) placeItem(lay, it, it.x, it.y);
        commit(p);
      });
    },
    flip: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'item') return;
        pushUndo(p);
        var it = findItem(editable(p), s.sel.id); if (it) it.flip = !it.flip;
        commit(p);
      });
    },
    dup: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'item') return;
        pushUndo(p);
        var lay = editable(p), it = findItem(lay, s.sel.id); if (!it) return;
        var c = JSON.parse(JSON.stringify(it));
        c.id = LivingUnit.uid();
        var sz = LivingUnit.itemSize(it);
        placeItem(lay, c, it.x + (sz.w >= sz.h ? sz.w + 0.1 : 0), it.y + (sz.h > sz.w ? sz.h + 0.1 : 0));
        lay.items.push(c);
        s.sel = { t: 'item', id: c.id };
        commit(p);
      });
    },
    del: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'item') return;
        pushUndo(p);
        var lay = editable(p);
        lay.items = lay.items.filter(function (i) { return i.id !== s.sel.id; });
        s.sel = null;
        commit(p);
      });
    },
    add: function (id, kind) {
      withP(id, function (p) {
        var s = st(id);
        pushUndo(p);
        var lay = editable(p);
        var x = lay.L / 2, y = lay.W / 2;
        if (s.sel && s.sel.t === 'room') { var r = findRoom(lay, s.sel.id); if (r) { x = r.x + r.w / 2; y = r.y + r.h / 2; } }
        else if (s.sel && s.sel.t === 'item') { var i0 = findItem(lay, s.sel.id); if (i0) { x = i0.x + 0.5; y = i0.y; } }
        var it = { id: LivingUnit.uid(), kind: kind, x: 0, y: 0, rot: 0, flip: false };
        placeItem(lay, it, x, y);
        lay.items.push(it);
        s.sel = { t: 'item', id: it.id };
        st(id).view = st(id).view || 'plan';
        commit(p);
      });
    },
    addRoom: function (id, type) {
      withP(id, function (p) {
        var s = st(id);
        pushUndo(p);
        var lay = editable(p);
        var w = Math.min(3, lay.L), h = Math.min(3, lay.W);
        var r = { id: LivingUnit.uid(), type: type, name: '', x: n2((lay.L - w) / 2), y: n2((lay.W - h) / 2), w: w, h: h,
                  open: type === 'corridor' || type === 'dining' || type === 'kitchen' };
        lay.rooms.push(r);
        s.sel = { t: 'room', id: r.id };
        commit(p);
      });
    },
    link: function (id, on) { st(id).link = !!on; },
    split: function (id, across) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'room') return;
        pushUndo(p);
        var lay = editable(p), r = findRoom(lay, s.sel.id); if (!r) return;
        splitRoom(lay, r, !!across);
        commit(p);
      });
    },
    _resize: resizeRoom,
    _split: splitRoom,
    dupRoom: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'room') return;
        pushUndo(p);
        var lay = editable(p), r = findRoom(lay, s.sel.id); if (!r) return;
        var c = JSON.parse(JSON.stringify(r));
        c.id = LivingUnit.uid();
        c.x = n2(Math.min(lay.L - c.w, r.x + r.w));
        lay.rooms.push(c);
        s.sel = { t: 'room', id: c.id };
        commit(p);
      });
    },
    delRoom: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'room') return;
        pushUndo(p);
        var lay = editable(p);
        lay.rooms = lay.rooms.filter(function (r) { return r.id !== s.sel.id; });
        s.sel = null;
        commit(p);
      });
    },
    replan: function (id) {
      // Back to the generated plan. Asked, because it throws edits away.
      withP(id, function (p) {
        if (p.living.layout && !window.confirm(tt('לבנות את הפריסה מחדש לפי מספר האנשים? השינויים שעשית בתוכנית יימחקו (אפשר לבטל).',
          'สร้างแผนใหม่? การแก้ไขจะหายไป', 'إعادة بناء المخطط؟ ستضيع التعديلات'))) return;
        pushUndo(p);
        p.living.layout = null;
        st(id).sel = null;
        if (BP.saveP) BP.saveP();
        if (BP.open) BP.open(id);
      });
    },
    useStructDims: function (id) {
      // Size the accommodation to the structure it is being fitted into.
      withP(id, function (p) {
        var d = p.dims || {};
        if (!(d.length > 0) || !(d.span > 0)) return;
        p.living.dimMode = 'fixed';
        p.living.lenM = Number(d.length);
        p.living.widM = Number(d.span);
        if (BP.saveP) BP.saveP();
        if (BP.open) BP.open(id);
      });
    },
    showOnMap: showOnMap,
    hideMap: clearMap,
    backToProject: function (id) {
      clearMap();
      if (window.BuildPlan && BuildPlan.openProject) BuildPlan.openProject(id);
    },
    planNorth: function (p) { return planNorth(p, frameFor(p)); },
    hasSite: function (p) { return frameFor(p).has; }
  };
  return API;
})();
