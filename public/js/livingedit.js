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
  var fullKeyBound = false, keysBound = false, menuOutsideBound = false;
  var MPD = 111320;

  function tt(he, th, ar) { return BP.tt ? BP.tt(he, th, ar) : he; }
  function esc(s) { return BP.esc ? BP.esc(s) : String(s == null ? '' : s); }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function snap(v, s) { return Math.round(v / s) * s; }
  function proj(id) { return BP.projById ? BP.projById(id) : null; }
  function st(id) {
    if (!ST[id]) ST[id] = { view: 'plan', sel: null, cut: false, sun: 'noon', undo: [], link: true,
      tool: null, wallKind: 'panel', drawStart: null,
      show: { furn: 1, elec: 1, plumb: 1, kitchen: 1, open: 1, dims: 1, wires: 0, pipes: 0 } };
    return ST[id];
  }

  // ── model access ────────────────────────────────────────────────────
  // The layout as stored; materialised from the generator on first edit.
  function editable(p) {
    var u = p.living;
    var cur = LivingUnit.layoutOf(u);
    if (!u.layout || cur.scaledFrom) {
      u.layout = JSON.parse(JSON.stringify({ L: cur.L, W: cur.W, rooms: cur.rooms, walls: cur.walls || [], edits: cur.edits || [], items: cur.items }));
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
  function findWall(lay, id) { return (lay.walls || []).filter(function (w) { return w.id === id; })[0]; }
  // A drawn wall stays on the building's axes: the longer component wins.
  function squareUp(w) {
    if (Math.abs(w.x2 - w.x1) >= Math.abs(w.y2 - w.y1)) w.y2 = w.y1; else w.x2 = w.x1;
    return w;
  }
  // 5 cm grid, then within 15 cm of a room edge, another wall or the
  // outline, onto that line.
  function snapPoint(lay, x, y, skipId) {
    var xs = [0, lay.L], ys = [0, lay.W];
    lay.rooms.forEach(function (r) { xs.push(r.x, r.x + r.w); ys.push(r.y, r.y + r.h); });
    (lay.walls || []).forEach(function (w) { if (w.id === skipId) return; xs.push(w.x1, w.x2); ys.push(w.y1, w.y2); });
    var near = function (v, list) {
      var out = snap(v, 0.05), bd = 0.15;
      list.forEach(function (e) { if (Math.abs(v - e) < bd) { bd = Math.abs(v - e); out = e; } });
      return out;
    };
    return { x: n2(Math.max(0, Math.min(lay.L, near(x, xs)))), y: n2(Math.max(0, Math.min(lay.W, near(y, ys)))) };
  }

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
    // Solid surfaces only: the theme's --card is translucent glass, and a
    // panel the drawing shows through is a panel nobody can read.
    var SOLID = 'var(--card-solid,var(--card,#fff))', LINE = 'rgba(0,0,0,.1)';
    s.textContent =
      '.lv-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
      '.lv-b{border:1px solid ' + LINE + ';background:var(--g6,#eef6f1);color:var(--text,#1b2e1b);border-radius:9px;padding:6px 10px;font:inherit;font-size:.8rem;cursor:pointer;white-space:nowrap}' +
      '.lv-b.on{background:var(--accent,#ff9f43);color:#fff;border-color:transparent;font-weight:700}' +
      '.lv-b:disabled{opacity:.4}' +
      '.lv-b.dang{color:#c62828}' +
      // the editor: toolbar on top, drawing and panel side by side
      '.lv-wrap{display:flex;flex-direction:column;gap:8px}' +
      '.lv-tb{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px;background:' + SOLID + ';border:1px solid ' + LINE + ';border-radius:12px}' +
      '.lv-tb .sep{width:1px;align-self:stretch;background:' + LINE + ';margin:0 2px}' +
      '.lv-tb .grow{flex:1}' +
      '.lv-o{min-height:34px;min-width:34px;border:1px solid ' + LINE + ';border-radius:9px;padding:5px 10px;background:var(--g6,#eef6f1);' +
        'color:var(--text,#1b2e1b);font:600 .8rem Heebo,sans-serif;cursor:pointer;white-space:nowrap}' +
      '.lv-o.on{background:var(--accent,#ff9f43);color:#fff;border-color:transparent}' +
      '.lv-o:disabled{opacity:.4}' +
      '.lv-zpct{font:600 .74rem Heebo,sans-serif;min-width:40px;text-align:center;opacity:.75}' +
      '.lv-body{display:flex;gap:10px;align-items:flex-start}' +
      '.lv-stage{flex:1 1 auto;min-width:0;background:' + SOLID + ';border:1px solid ' + LINE + ';border-radius:12px;overflow:hidden;position:relative}' +
      '.lv-cv{position:relative;overflow:hidden;padding:8px;touch-action:none}' +
      '.lv-cv.lv-3d{height:460px;padding:0}' +
      '.lv-side{flex:0 0 300px;max-height:72vh;overflow:auto;background:' + SOLID + ';border:1px solid ' + LINE + ';border-radius:12px;padding:10px 12px;font-size:.84rem;color:var(--text,#1b2e1b)}' +
      '.lv-narrow .lv-body{flex-direction:column;align-items:stretch}' +
      '.lv-narrow .lv-tb .tx{display:none}' +
      '.lv-narrow .lv-tb{gap:4px;padding:5px}' +
      '.lv-narrow .lv-o{padding:5px 8px}' +
      '.lv-narrow .lv-side{flex:none;max-height:none}' +
      '.lv-tabs{display:flex;gap:4px;margin-bottom:10px;border-bottom:1px solid ' + LINE + ';padding-bottom:8px}' +
      '.lv-tabs .lv-b{flex:1;text-align:center}' +
      '.lv-full{position:fixed;inset:0;z-index:2400;background:var(--bg,#f2f7f4);padding:8px;overflow:hidden}' +
      '.lv-full .lv-body{flex:1;min-height:0;align-items:stretch}' +
      '.lv-full .lv-stage{display:flex;flex-direction:column}' +
      '.lv-full .lv-cv{flex:1;min-height:0}' +
      '.lv-full .lv-cv svg{height:100%!important}' +
      '.lv-full .lv-cv.lv-3d{height:auto}' +
      '.lv-full .lv-side{max-height:none}' +
      '.lv-full.lv-narrow .lv-side{max-height:38vh}' +
      '.lv-ins .lv-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px}' +
      // compact fields: the app's form inputs are page-wide by default
      '.lv-side input[type=number],.lv-side input[type=text],.lv-side input:not([type]),.lv-side select{width:76px!important;min-height:0!important;padding:5px 7px!important;' +
        'font-size:.84rem!important;border-radius:8px!important;border:1px solid ' + LINE + '!important;background:var(--bg,#f6faf7)!important;color:inherit!important;box-sizing:border-box}' +
      '.lv-side input.wide,.lv-side select.wide{width:100%!important}' +
      '.lv-side select{width:auto!important;max-width:100%}' +
      '.lv-dims{display:grid;grid-template-columns:auto auto;justify-content:start;gap:3px 14px;margin-top:8px;font-size:.84rem}' +
      '.lv-dims span{opacity:.7}.lv-dims b{direction:ltr;unicode-bidi:isolate;text-align:start}' +
      '.lv-acts{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;padding-top:10px;border-top:1px solid ' + LINE + '}' +
      '.lv-title{font-weight:800;font-size:.95rem}' +
      '.lv-q{margin-top:8px;font-size:.78rem;line-height:1.7}' +
      '.lv-q b{color:var(--accent,#ff9f43)}' +
      '.lv-warn{margin-top:6px;font-size:.78rem;color:#b26a00;line-height:1.6}' +
      '.lv-hint{font-size:.76rem;opacity:.7;margin-top:6px;line-height:1.5}' +
      '.lv-load{display:flex;align-items:center;justify-content:center;height:100%;font-size:.9rem;opacity:.8}' +
      '.lv-menu{position:absolute;z-index:8;min-width:180px;background:' + SOLID + ';color:var(--text,#1b2e1b);border-radius:12px;padding:5px;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.28);border:1px solid ' + LINE + ';font:600 .84rem Heebo,sans-serif}' +
      '.lv-menu .lv-mh{padding:5px 9px 6px;font-size:.76rem;opacity:.7;border-bottom:1px solid ' + LINE + ';margin-bottom:3px}' +
      '.lv-menu button{display:flex;gap:9px;align-items:center;width:100%;border:0;background:none;color:inherit;font:inherit;' +
        'padding:9px 10px;border-radius:8px;cursor:pointer;text-align:start}' +
      '.lv-menu button:hover{background:var(--g6,#eef6f1)}' +
      '.lv-menu button.dang{color:#c62828}' +
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
      '<div class="lv-wrap' + (s.full ? ' lv-full' : '') + '" id="lvWrap">' +
        '<div class="lv-tb" id="lvTop"></div>' +
        '<div class="lv-body">' +
          '<div class="lv-stage"><div class="lv-cv" id="lvCanvas"></div></div>' +
          '<div class="lv-side" id="lvSide">' +
            '<div class="lv-tabs" id="lvTabs"></div>' +
            '<div id="lvIns" class="lv-ins"></div>' +
            '<div id="lvCtx"></div>' +
            '<div id="lvSheetB"></div>' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div id="lvQty"></div>';
    var cv = document.getElementById('lvCanvas');
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', onContext);
    bindKeys();
    cv._pid = p.id;
    var wrap = document.getElementById('lvWrap');
    // side by side when there is room for both, stacked when there is not
    var fitWidth = function () { if (wrap) wrap.classList.toggle('lv-narrow', (wrap.clientWidth || 0) < 760); };
    fitWidth();
    if (typeof ResizeObserver !== 'undefined') { var ro = new ResizeObserver(fitWidth); ro.observe(wrap); }
    redraw(p);
  }

  function redraw(p) {
    var s = st(p.id);
    var top = document.getElementById('lvTop');
    if (!top) return;
    var f = frameFor(p);
    var lay = LivingUnit.layoutOf(p.living);
    var wrap = document.getElementById('lvWrap');
    if (wrap) {
      wrap.classList.toggle('lv-full', !!s.full);
      wrap.classList.toggle('lv-narrow', (wrap.clientWidth || 0) < 760);
    }
    var plan = s.view === 'plan';
    var b = function (on, act, label, extra) {
      return '<button class="lv-o' + (on ? ' on' : '') + '" onclick="LivingEdit.' + act + '"' + (extra || '') + '>' + label + '</button>';
    };
    var sep = '<span class="sep"></span>';
    top.innerHTML =
      b(plan, 'view(' + p.id + ',\'plan\')', '\ud83d\udcd0 ' + tt('תוכנית', 'แผนผัง', 'مخطط')) +
      b(!plan, 'view(' + p.id + ',\'3d\')', '\ud83e\uddca 3D') + sep +
      b(false, 'undo(' + p.id + ')', '\u21b6<span class="tx"> ' + tt('בטל', 'เลิกทำ', 'تراجع') + '</span>', s.undo.length ? '' : ' disabled') +
      (plan ? b(s.tool === 'wall', 'tool(' + p.id + ')', '\u270f\ufe0f<span class="tx"> ' + tt('שרטט קיר', 'วาดผนัง', 'ارسم جداراً') + '</span>') : '') +
      (plan ? b(s.tool === 'cut', 'cutTool(' + p.id + ')', '\u2702\ufe0f<span class="tx"> ' + tt('חתוך קיר', 'ตัดผนัง', 'اقطع جداراً') + '</span>') : '') + sep +
      (plan
        ? b(false, 'zoom(' + p.id + ',-1)', '\u2212') + '<span class="lv-zpct" id="lvZoom">' + Math.round(((s.z && s.z.k) || 1) * 100) + '%</span>' +
          b(false, 'zoom(' + p.id + ',1)', '+') + b(false, 'zoom(' + p.id + ',0)', '\u2922<span class="tx"> ' + tt('הכל', 'ทั้งหมด', 'الكل') + '</span>')
        : b(false, 'top(' + p.id + ')', '\u2b07<span class="tx"> ' + tt('מבט על', 'มุมบน', 'منظر علوي') + '</span>') +
          b(false, 'zoom(' + p.id + ',0)', '\u2922<span class="tx"> ' + tt('איפוס', 'รีเซ็ต', 'إعادة') + '</span>')) +
      '<span class="grow"></span>' +
      (f.has ? b(false, 'showOnMap(' + p.id + ')', '\ud83d\uddfa<span class="tx"> ' + tt('מפה', 'แผนที่', 'خريطة') + '</span>') : '') +
      b(s.full, 'full(' + p.id + ')', s.full ? '\u2715<span class="tx"> ' + tt('סגור מסך מלא', 'ปิด', 'إغلاق') + '</span>'
                                             : '\u26f6<span class="tx"> ' + tt('מסך מלא', 'เต็มจอ', 'ملء الشاشة') + '</span>');

    if (s.view === '3d') draw3d(p);
    else {
      destroy3d();
      var cv = document.getElementById('lvCanvas');
      cv.className = 'lv-cv';
      cv.innerHTML = LivingUnit.svg(p.living, { show: s.show, sel: s.sel, interactive: true, north: planNorth(p, f) });
      var svg = cv.querySelector('svg');
      var vb = (svg.getAttribute('viewBox') || '0 0 1 1').split(/\s+/).map(Number);
      s.base = { x: vb[0], y: vb[1], w: vb[2], h: vb[3] };
      applyZoom(svg, s);
      if (s.sel && s.sel.t === 'room') handles(svg, lay, s.sel.id);
      if (s.sel && s.sel.t === 'wall') wallHandles(svg, lay, s.sel.id);
      if (s.tool === 'wall' && s.drawStart) {
        var mk = document.createElementNS(NS_SVG, 'circle');
        mk.setAttribute('cx', s.drawStart.x); mk.setAttribute('cy', s.drawStart.y); mk.setAttribute('r', 0.16);
        mk.setAttribute('fill', '#ffd166'); mk.setAttribute('stroke', '#1b1b1b'); mk.setAttribute('stroke-width', 0.03);
        svg.appendChild(mk);
      }
    }
    ctxBar(p, lay);
    sheet(p);
    qty(p, lay);
  }

  // ── viewport ────────────────────────────────────────────────────────
  // Zoom is a viewBox inside the drawing's own: k = 1 shows it all. The
  // geometry is untouched, so dragging and snapping go on working in
  // metres through the SVG's screen transform at any zoom.
  var ZMAX = 15;
  function applyZoom(svg, s) {
    var B = s.base; if (!svg || !B) return;
    var z = s.z || { k: 1 };
    if (!(z.k > 1.001)) { s.z = { k: 1, x: B.x, y: B.y }; svg.setAttribute('viewBox', [B.x, B.y, B.w, B.h].join(' ')); return; }
    var w = B.w / z.k, h = B.h / z.k;
    z.x = Math.max(B.x, Math.min(B.x + B.w - w, z.x));
    z.y = Math.max(B.y, Math.min(B.y + B.h - h, z.y));
    svg.setAttribute('viewBox', [z.x, z.y, w, h].join(' '));
  }
  // Zoom to k keeping drawing point P under screen point (sx, sy).
  function zoomTo(svg, s, k, P, sx, sy) {
    var B = s.base; if (!svg || !B) return;
    k = Math.max(1, Math.min(ZMAX, k));
    var w = B.w / k, h = B.h / k;
    var rc = svg.getBoundingClientRect();
    var sc = Math.min(rc.width / w, rc.height / h) || 1;
    var ox = rc.left + (rc.width - w * sc) / 2, oy = rc.top + (rc.height - h * sc) / 2;
    s.z = { k: k, x: P.x - (sx - ox) / sc, y: P.y - (sy - oy) / sc };
    applyZoom(svg, s);
    var lbl = document.getElementById('lvZoom');
    if (lbl) lbl.textContent = Math.round(k * 100) + '%';
  }
  function onWheel(ev) {
    var cv = ev.currentTarget, p = proj(cv._pid);
    if (!p || st(p.id).view !== 'plan') return;
    var svg = cv.querySelector('svg'); if (!svg) return;
    ev.preventDefault();
    var s = st(p.id);
    var k = ((s.z && s.z.k) || 1) * Math.exp(-ev.deltaY * 0.0015);
    zoomTo(svg, s, k, svgPt(svg, ev), ev.clientX, ev.clientY);
  }

  // ── context menu (right click / long press) ───────────────────────
  function targetOf(el) {
    var g;
    if ((g = el.closest('[data-handle]'))) return null;
    if ((g = el.closest('[data-item]'))) return { t: 'item', id: g.getAttribute('data-item') };
    if ((g = el.closest('[data-wall]'))) return { t: 'wall', id: g.getAttribute('data-wall') };
    if ((g = el.closest('[data-cut]'))) return { t: 'cut', id: g.getAttribute('data-cut') };
    if ((g = el.closest('[data-seg]'))) return { t: 'seg', id: g.getAttribute('data-seg') };
    if ((g = el.closest('[data-room]'))) return { t: 'room', id: g.getAttribute('data-room') };
    return null;
  }
  function onContext(ev) {
    var cv = ev.currentTarget, p = proj(cv._pid);
    if (!p || st(p.id).view !== 'plan') return;
    ev.preventDefault();
    var tg = targetOf(ev.target);
    if (!tg) { closeMenu(); return; }
    openMenu(p, tg, ev.clientX, ev.clientY);
  }
  function closeMenu() {
    var m = document.getElementById('lvMenu');
    if (m && m.parentNode) m.parentNode.removeChild(m);
  }
  function openMenu(p, tg, cx, cy) {
    var s = st(p.id), lay = LivingUnit.layoutOf(p.living);
    s.sel = tg; s.tool = null; s.drawStart = null;
    if (s.pop && s.pop !== 'ins') s.pop = '';
    redraw(p);
    var wrap = document.getElementById('lvWrap'); if (!wrap) return;
    closeMenu();
    var id = p.id, title = '', rows = [];
    var row = function (act, ic, label, cls) { rows.push('<button' + (cls ? ' class="' + cls + '"' : '') + ' onclick="LivingEdit.menu(' + id + ',\'' + act + '\')"><span>' + ic + '</span>' + label + '</button>'); };
    var edit = function () { row('edit', '\u270e', tt('ערכים מדויקים', 'ค่าที่แม่นยำ', 'قيم دقيقة')); };
    if (tg.t === 'item') {
      var it = findItem(lay, tg.id); if (!it) return;
      title = LivingUnit.itemSym(it.kind) + ' ' + esc(LivingUnit.itemLabel(it.kind));
      row('rotR', '\u27f3', tt('סובב 90° ימינה', 'หมุนขวา 90°', 'تدوير 90° يميناً'));
      row('rotL', '\u27f2', tt('סובב 90° שמאלה', 'หมุนซ้าย 90°', 'تدوير 90° يساراً'));
      if (it.kind === 'door' || it.kind === 'door_ext') row('flip', '\u21c4', tt('הפוך כיוון פתיחה', 'กลับทิศเปิด', 'اعكس اتجاه الفتح'));
      if (it.kind === 'door_slide') row('flip', '\u21c4', tt('הפוך כיוון הזזה', 'กลับทิศเลื่อน', 'اعكس اتجاه الانزلاق'));
      row('dup', '\u29c9', tt('שכפל', 'ทำซ้ำ', 'نسخ'));
      edit();
      row('del', '\ud83d\uddd1', tt('מחק', 'ลบ', 'حذف'), 'dang');
    } else if (tg.t === 'room') {
      var r = findRoom(lay, tg.id); if (!r) return;
      title = '\u25ad ' + esc(r.name || LivingUnit.roomLabel(r.type));
      row('rotRoomR', '\u27f3', tt('סובב את החדר 90° ימינה', 'หมุนห้องขวา 90°', 'تدوير الغرفة 90° يميناً'));
      row('rotRoomL', '\u27f2', tt('סובב את החדר 90° שמאלה', 'หมุนห้องซ้าย 90°', 'تدوير الغرفة 90° يساراً'));
      row('splitL', '\u2af4', tt('חלק לאורך', 'แบ่งตามยาว', 'قسّم طولياً'));
      row('splitW', '\u2550', tt('חלק לרוחב', 'แบ่งตามขวาง', 'قسّم عرضياً'));
      row('dupRoom', '\u29c9', tt('שכפל חדר', 'ทำซ้ำห้อง', 'نسخ الغرفة'));
      edit();
      row('delRoom', '\ud83d\uddd1', tt('מחק חדר', 'ลบห้อง', 'حذف الغرفة'), 'dang');
    } else if (tg.t === 'wall') {
      title = '\u2501 ' + tt('קיר מחיצה', 'ผนังกั้น', 'جدار فاصل');
      row('rotWall', '\u27f3', tt('סובב 90°', 'หมุน 90°', 'تدوير 90°'));
      row('dupWall', '\u29c9', tt('שכפל', 'ทำซ้ำ', 'نسخ'));
      edit();
      row('delWall', '\ud83d\uddd1', tt('מחק קיר', 'ลบผนัง', 'حذف الجدار'), 'dang');
    } else if (tg.t === 'cut') {
      title = '\u2702 ' + tt('קטע קיר שהוסר', 'ส่วนผนังที่ตัดออก', 'جزء جدار محذوف');
      row('restore', '\u21ba', tt('החזר את הקיר', 'คืนผนัง', 'أعد الجدار'));
    } else {
      title = '\u2501 ' + tt('קיר', 'ผนัง', 'جدار');
      row('edit', '\u2139', tt('פרטי הקיר וחומר', 'รายละเอียดและวัสดุ', 'التفاصيل والمادة'));
      row('cutWhole', '\ud83d\uddd1', tt('הסר את הקטע הזה', 'ตัดส่วนนี้', 'احذف هذا المقطع'), 'dang');
    }
    var m = document.createElement('div');
    m.id = 'lvMenu';
    m.className = 'lv-menu';
    m.setAttribute('dir', document.documentElement.getAttribute('dir') || 'rtl');
    m.innerHTML = '<div class="lv-mh">' + title + '</div>' + rows.join('');
    wrap.appendChild(m);
    // at the pointer, kept inside the editor
    var rc = wrap.getBoundingClientRect();
    var mw = m.offsetWidth || 180, mh = m.offsetHeight || 40 * (rows.length + 1);
    var x = Math.max(4, Math.min((rc.width || mw + 8) - mw - 4, cx - rc.left));
    var y = Math.max(4, Math.min((rc.height || mh + 8) - mh - 4, cy - rc.top));
    m.style.left = x + 'px'; m.style.top = y + 'px';
    if (!menuOutsideBound) {
      menuOutsideBound = true;
      document.addEventListener('pointerdown', function (e) {
        var mm = document.getElementById('lvMenu');
        if (mm && !mm.contains(e.target)) closeMenu();
      }, true);
    }
  }

  // Delete removes the selection, R turns it, Esc lets go — never while
  // a field has the keyboard.
  function bindKeys() {
    if (keysBound) return;
    keysBound = true;
    document.addEventListener('keydown', function (e) {
      var cv = document.getElementById('lvCanvas'); if (!cv || !cv._pid) return;
      var tgt = e.target, tag = (tgt && tgt.tagName) || '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || (tgt && tgt.isContentEditable)) return;
      var id = cv._pid, s = st(id);
      if (e.key === 'Escape') { closeMenu(); return; }
      if (!s.sel || s.view !== 'plan') return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        if (s.sel.t === 'item') API.del(id); else if (s.sel.t === 'room') API.delRoom(id); else if (s.sel.t === 'wall') API.delWall(id);
        else if (s.sel.t === 'cut') API.restoreCut(id);
        else if (s.sel.t === 'seg') API.menu(id, 'cutWhole');
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.sel.t === 'item') API.rot(id, e.shiftKey ? 90 : -90);
        else if (s.sel.t === 'room') API.rotRoom(id, e.shiftKey ? 0 : 1);
        else if (s.sel.t === 'wall') API.rotWall(id);
      }
    });
  }

  // ── side panel, "selected" tab: what it is, and what to do with it ──
  function ctxBar(p, lay) {
    var box = document.getElementById('lvCtx'); if (!box) return;
    var s = st(p.id), id = p.id;
    if (s.pop) { box.innerHTML = ''; return; }
    var o = function (act, label, cls) { return '<button class="lv-b' + (cls ? ' ' + cls : '') + '" onclick="LivingEdit.' + act + '">' + label + '</button>'; };
    if (s.tool === 'cut') {
      box.innerHTML = '<div class="lv-acts"' + (s.sel && s.sel.t === 'cut' ? '' : ' style="border:0;padding:0;margin:0"') + '>' +
        (s.sel && s.sel.t === 'cut' ? o('restoreCut(' + id + ')', '\u21ba ' + tt('החזר את הקיר', 'คืนผนัง', 'أعد الجدار')) : '') +
        o('cutTool(' + id + ')', '\u2713 ' + tt('סיום חיתוך', 'เสร็จ', 'إنهاء')) + '</div>';
      return;
    }
    if (s.tool === 'wall') {
      box.innerHTML = '<div class="lv-acts" style="border:0;padding:0;margin:0">' +
        LivingUnit.WALL_MATS.map(function (k) {
          return o('wallKind(' + id + ',\'' + k + '\')', esc(LivingUnit.matLabel(k)), s.wallKind === k ? 'on' : '');
        }).join('') + o('tool(' + id + ')', '\u2713 ' + tt('סיום שרטוט', 'เสร็จ', 'إنهاء')) + '</div>';
      return;
    }
    if (!s.sel) { box.innerHTML = ''; return; }
    var acts = '';
    if (s.sel.t === 'item') {
      var it = findItem(lay, s.sel.id); if (!it) { box.innerHTML = ''; return; }
      acts = o('rot(' + id + ',-90)', '\u27f3 90\u00b0') + o('rot(' + id + ',90)', '\u27f2 90\u00b0') +
        ((it.kind === 'door' || it.kind === 'door_ext' || it.kind === 'door_slide') ? o('flip(' + id + ')', '\u21c4 ' + (it.kind === 'door_slide'
          ? tt('כיוון הזזה', 'ทิศเลื่อน', 'اتجاه الانزلاق') : tt('כיוון פתיחה', 'ทิศเปิด', 'اتجاه الفتح'))) : '') +
        o('dup(' + id + ')', '\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ')) + o('del(' + id + ')', '\ud83d\uddd1 ' + tt('מחק', 'ลบ', 'حذف'), 'dang');
    } else if (s.sel.t === 'room') {
      acts = o('rotRoom(' + id + ',1)', '\u27f3 90\u00b0') + o('rotRoom(' + id + ',0)', '\u27f2 90\u00b0') +
        o('split(' + id + ',0)', '\u2af4 ' + tt('חלק לאורך', 'แบ่งตามยาว', 'قسّم طولياً')) +
        o('split(' + id + ',1)', '\u2550 ' + tt('חלק לרוחב', 'แบ่งตามขวาง', 'قسّم عرضياً')) +
        o('dupRoom(' + id + ')', '\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ')) + o('delRoom(' + id + ')', '\ud83d\uddd1 ' + tt('מחק חדר', 'ลบห้อง', 'حذف الغرفة'), 'dang');
    } else if (s.sel.t === 'cut') {
      acts = o('restoreCut(' + id + ')', '\u21ba ' + tt('החזר את הקיר', 'คืนผนัง', 'أعد الجدار'));
    } else if (s.sel.t === 'wall') {
      acts = o('rotWall(' + id + ')', '\u27f3 90\u00b0') + o('dupWall(' + id + ')', '\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ')) +
        o('delWall(' + id + ')', '\ud83d\uddd1 ' + tt('מחק קיר', 'ลบผนัง', 'حذف الجدار'), 'dang');
    }
    box.innerHTML = acts ? '<div class="lv-acts">' + acts + '</div>' : '';
  }

  // ── side panel tabs: selected / add / layers ────────────────────────
  function sheet(p) {
    var s = st(p.id), tabs = document.getElementById('lvTabs'), body = document.getElementById('lvSheetB'), ins = document.getElementById('lvIns');
    if (!tabs || !body || !ins) return;
    if (s.pop === 'ins') s.pop = '';
    if (s.view !== 'plan' && s.pop === 'add') s.pop = '';
    var tab = function (k, label) {
      return '<button class="lv-b' + ((s.pop || '') === k ? ' on' : '') + '" onclick="LivingEdit.pop(' + p.id + ',\'' + k + '\')">' + label + '</button>';
    };
    tabs.innerHTML = tab('', '\u270e ' + tt('נבחר', 'ที่เลือก', 'المحدد')) +
      (s.view === 'plan' ? tab('add', '\u2795 ' + tt('הוסף', 'เพิ่ม', 'أضف')) : '') +
      tab('layers', '\ud83d\uddc2 ' + tt('שכבות', 'เลเยอร์', 'طبقات'));
    ins.style.display = s.pop ? 'none' : '';
    if (!s.pop) { body.innerHTML = ''; inspector(p); return; }
    ins.innerHTML = '';
    if (s.pop === 'add') { body.innerHTML = palette(p); return; }
    var chip = function (k, label) {
      return '<button class="lv-b' + (s.show[k] ? ' on' : '') + '" onclick="LivingEdit.layer(' + p.id + ',\'' + k + '\')">' + label + '</button>';
    };
    body.innerHTML = '<div class="lv-bar">' +
      chip('furn', '\ud83d\udecf ' + tt('ריהוט', 'เฟอร์นิเจอร์', 'أثاث')) +
      chip('elec', '\u26a1 ' + tt('חשמל', 'ไฟฟ้า', 'كهرباء')) +
      chip('plumb', '\ud83d\udeb0 ' + tt('אינסטלציה', 'ประปา', 'سباكة')) +
      chip('kitchen', '\ud83c\udf73 ' + tt('מטבח', 'ครัว', 'مطبخ')) +
      chip('open', '\ud83d\udeaa ' + tt('פתחים', 'ช่องเปิด', 'فتحات')) + '</div>' +
      (s.view === 'plan'
        ? '<div class="lv-bar" style="margin-top:8px">' +
            chip('wires', '\u3030 ' + tt('תוואי כבלים', 'แนวสายไฟ', 'مسار الكابلات')) +
            chip('pipes', '\u3030 ' + tt('תוואי צנרת', 'แนวท่อ', 'مسار الأنابيب')) + '</div>'
        : '<div class="lv-bar" style="margin-top:8px">' +
            '<button class="lv-b' + (s.cut ? ' on' : '') + '" onclick="LivingEdit.cut(' + p.id + ')">\u2702 ' + tt('חתך קירות', 'ตัดผนัง', 'قطع الجدران') + '</button>' +
            ['morning', 'noon', 'evening'].map(function (k) {
              return '<button class="lv-b' + (s.sun === k ? ' on' : '') + '" onclick="LivingEdit.sun(' + p.id + ',\'' + k + '\')">' +
                { morning: '\ud83c\udf05 ' + tt('בוקר', 'เช้า', 'صباح'), noon: '\u2600 ' + tt('צהריים', 'เที่ยง', 'ظهر'),
                  evening: '\ud83c\udf07 ' + tt('אחה"צ', 'บ่าย', 'عصر') }[k] + '</button>';
            }).join('') + '</div>');
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
  function wallHandles(svg, lay, id) {
    var w = findWall(lay, id); if (!svg || !w) return;
    var hs = Math.max(0.24, Math.min(0.44, Math.min(lay.L, lay.W) / 24));
    [['p1', w.x1, w.y1], ['p2', w.x2, w.y2]].forEach(function (e) {
      var el = document.createElementNS(NS_SVG, 'circle');
      el.setAttribute('cx', e[1]); el.setAttribute('cy', e[2]); el.setAttribute('r', hs / 2);
      el.setAttribute('fill', '#ffd166'); el.setAttribute('stroke', '#1b1b1b'); el.setAttribute('stroke-width', 0.03);
      el.setAttribute('data-handle', e[0]); el.setAttribute('style', 'cursor:crosshair');
      svg.appendChild(el);
    });
  }
  // The wall a point is on (or nearest, within 0.6 m), and the stretch of
  // that wall's line between two points, for the cut tool.
  function nearestSeg(lay, x, y) {
    var best = null, bd = 0.6;
    LivingUnit.walls(lay).forEach(function (sg) {
      var along = sg.o === 'h' ? x : y, across = sg.o === 'h' ? y : x;
      var cl = Math.max(sg.a, Math.min(sg.b, along));
      var d = Math.hypot(along - cl, across - sg.c);
      if (d < bd) { bd = d; best = sg; }
    });
    return best;
  }
  function cutSpan(lay, sg, a, b) {
    var end = sg.o === 'h' ? lay.L : lay.W;
    a = Math.max(0, Math.min(end, snap(a, 0.05))); b = Math.max(0, Math.min(end, snap(b, 0.05)));
    return a <= b ? { a: a, b: b } : { a: b, b: a };
  }
  function previewLine(svg, x1, y1, x2, y2) {
    var ln = svg.querySelector('#lvPrev');
    if (!ln) {
      ln = document.createElementNS(NS_SVG, 'line');
      ln.setAttribute('id', 'lvPrev');
      ln.setAttribute('stroke', '#ffd166'); ln.setAttribute('stroke-width', 0.12);
      ln.setAttribute('stroke-linecap', 'square'); ln.setAttribute('stroke-dasharray', '0.25 0.12');
      ln.setAttribute('pointer-events', 'none');
      svg.appendChild(ln);
    }
    ln.setAttribute('x1', x1); ln.setAttribute('y1', y1); ln.setAttribute('x2', x2); ln.setAttribute('y2', y2);
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
  // Turn a room a quarter turn about its centre, with everything that
  // belongs to it: furniture and fittings inside it, the doors and windows
  // in its own walls, and walls drawn inside it. On screen (y down) a
  // clockwise quarter turn takes (dx, dy) to (-dy, dx). An item's `rot`
  // runs the other way (a door at 0 opens toward +y, at 90 toward +x), so
  // the same turn is rot - 90. If the turned room sticks out of the
  // building it is pushed back in; if it cannot fit at all, nothing moves.
  function rotateRoom(lay, r, cw) {
    var cx = r.x + r.w / 2, cy = r.y + r.h / 2, E = 0.15;
    var nw = r.h, nh = r.w;
    if (nw > lay.L + 0.001 || nh > lay.W + 0.001) return { ok: false, why: 'fit' };
    var turn = function (x, y) {
      var dx = x - cx, dy = y - cy;
      return cw ? { x: cx - dy, y: cy + dx } : { x: cx + dy, y: cy - dx };
    };
    var inside = function (x, y, tol) { return x >= r.x - tol && x <= r.x + r.w + tol && y >= r.y - tol && y <= r.y + r.h + tol; };
    var items = lay.items.filter(function (it) {
      var d = LivingUnit.ITEMS[it.kind] || {};
      if (!d.wall) return inside(it.x, it.y, 0.001);
      // a door or window belongs to the room when it sits in one of its walls
      var onH = (it.rot === 0 || it.rot === 180) && (Math.abs(it.y - r.y) < E || Math.abs(it.y - r.y - r.h) < E) && it.x > r.x - 0.01 && it.x < r.x + r.w + 0.01;
      var onV = (it.rot === 90 || it.rot === 270) && (Math.abs(it.x - r.x) < E || Math.abs(it.x - r.x - r.w) < E) && it.y > r.y - 0.01 && it.y < r.y + r.h + 0.01;
      return onH || onV;
    });
    var walls = (lay.walls || []).filter(function (w) {
      return inside(w.x1, w.y1, 0.02) && inside(w.x2, w.y2, 0.02);
    });
    // cuts and material choices on the room's own walls turn with it
    var edits = (lay.edits || []).filter(function (e) {
      var p1 = e.o === 'h' ? [e.a, e.c] : [e.c, e.a], p2 = e.o === 'h' ? [e.b, e.c] : [e.c, e.b];
      return inside(p1[0], p1[1], 0.02) && inside(p2[0], p2[1], 0.02);
    });
    // where it lands, and how far it must slide to stay in the building
    var nx = cx - nw / 2, ny = cy - nh / 2;
    var sx = Math.max(0, Math.min(lay.L - nw, nx)) - nx, sy = Math.max(0, Math.min(lay.W - nh, ny)) - ny;
    items.forEach(function (it) {
      var q = turn(it.x, it.y);
      it.x = n2(q.x + sx); it.y = n2(q.y + sy);
      it.rot = ((it.rot + (cw ? 270 : 90)) % 360 + 360) % 360;
    });
    walls.forEach(function (w) {
      var a = turn(w.x1, w.y1), b = turn(w.x2, w.y2);
      w.x1 = n2(a.x + sx); w.y1 = n2(a.y + sy); w.x2 = n2(b.x + sx); w.y2 = n2(b.y + sy);
    });
    edits.forEach(function (e) {
      var p1 = e.o === 'h' ? [e.a, e.c] : [e.c, e.a], p2 = e.o === 'h' ? [e.b, e.c] : [e.c, e.b];
      var a = turn(p1[0], p1[1]), b = turn(p2[0], p2[1]);
      a.x += sx; a.y += sy; b.x += sx; b.y += sy;
      if (Math.abs(a.y - b.y) < 0.001) { e.o = 'h'; e.c = n2(a.y); e.a = n2(Math.min(a.x, b.x)); e.b = n2(Math.max(a.x, b.x)); }
      else { e.o = 'v'; e.c = n2(a.x); e.a = n2(Math.min(a.y, b.y)); e.b = n2(Math.max(a.y, b.y)); }
    });
    r.x = n2(nx + sx); r.y = n2(ny + sy); r.w = n2(nw); r.h = n2(nh);
    var hits = lay.rooms.filter(function (o) {
      if (o.id === r.id) return false;
      var ox = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x), oy = Math.min(r.y + r.h, o.y + o.h) - Math.max(r.y, o.y);
      return ox > 0.05 && oy > 0.05;
    });
    return { ok: true, moved: items.length, walls: walls.length, slid: Math.abs(sx) + Math.abs(sy) > 0.001, overlaps: hits };
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
  // Two fingers down = zoom and pan, whatever the first finger was doing.
  var ptrs = {}, pinch = null;
  function nPtrs() { return Object.keys(ptrs).length; }
  function midOf() {
    var k = Object.keys(ptrs), a = ptrs[k[0]], c = ptrs[k[1]];
    return { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2, d: Math.hypot(a.x - c.x, a.y - c.y) || 1 };
  }
  function onDown(ev) {
    var cv = ev.currentTarget, p = proj(cv._pid);
    if (!p || st(p.id).view !== 'plan') return;
    var svg = cv.querySelector('svg'); if (!svg) return;
    closeMenu();
    if (ev.button === 2) return;               // the context menu handles it
    ptrs[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
    try { cv.setPointerCapture(ev.pointerId); } catch (e) {}
    if (nPtrs() >= 2) {
      // undo whatever the first finger had started moving
      if (drag && drag.svg) redraw(drag.p);
      drag = null;
      var sv = cv.querySelector('svg'), mm = midOf();
      pinch = { d0: mm.d, k0: (st(p.id).z && st(p.id).z.k) || 1, P: svgPt(sv, { clientX: mm.x, clientY: mm.y }), p: p };
      ev.preventDefault();
      return;
    }
    var gi = ev.target.closest('[data-item]'), gr = ev.target.closest('[data-room]');
    var gh = ev.target.closest('[data-handle]');
    var gw = ev.target.closest('[data-wall]');
    var pos = svgPt(svg, ev);
    var s0 = st(p.id);
    if (drag && drag.lp) clearTimeout(drag.lp);
    drag = null;                               // a gesture that ended off-canvas leaves nothing behind
    if (gh && s0.sel && s0.sel.t === 'wall') {
      drag = { t: 'wend', end: gh.getAttribute('data-handle'), id: s0.sel.id, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (s0.tool === 'cut') {
      var layC = LivingUnit.layoutOf(p.living), sgC = nearestSeg(layC, pos.x, pos.y);
      drag = sgC ? { t: 'cutdraw', seg: sgC, a0: sgC.o === 'h' ? pos.x : pos.y, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p }
                 : { t: 'none', x0: pos.x, y0: pos.y, cx0: ev.clientX, cy0: ev.clientY, z0: s0.z || { k: 1, x: 0, y: 0 }, moved: 0, svg: svg, p: p };
    }
    else if (ev.target.closest('[data-cut]')) {
      drag = { t: 'cutsel', id: ev.target.closest('[data-cut]').getAttribute('data-cut'), x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (s0.tool === 'wall') {
      var lay0 = LivingUnit.layoutOf(p.living), sp = snapPoint(lay0, pos.x, pos.y);
      drag = { t: 'draw', sx: sp.x, sy: sp.y, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (gw) {
      drag = { t: 'wall', id: gw.getAttribute('data-wall'), el: gw, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (ev.target.closest('[data-seg]') && !gi) {
      drag = { t: 'seg', id: ev.target.closest('[data-seg]').getAttribute('data-seg'), x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (gh && s0.sel && s0.sel.t === 'room') {
      var rid = st(p.id).sel.id;
      drag = { t: 'handle', h: gh.getAttribute('data-handle'), id: rid, el: svg.querySelector('[data-room="' + rid + '"]'),
               x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    }
    else if (gi) drag = { t: 'item', id: gi.getAttribute('data-item'), el: gi, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    else if (gr) drag = { t: 'room', id: gr.getAttribute('data-room'), el: gr, x0: pos.x, y0: pos.y, moved: 0, svg: svg, p: p };
    if (drag && (drag.t === 'item' || drag.t === 'room' || drag.t === 'wall' || drag.t === 'seg')) {
      // holding a finger still on an object opens its menu
      var lpd = drag, lcx = ev.clientX, lcy = ev.clientY;
      lpd.lp = setTimeout(function () {
        if (drag !== lpd || lpd.moved || nPtrs() !== 1) return;
        drag = null;
        if (lpd.el) lpd.el.removeAttribute('transform');
        openMenu(lpd.p, { t: lpd.t, id: lpd.id }, lcx, lcy);
      }, 550);
    }
    if (drag) { ev.preventDefault(); return; }
    var z0 = s0.z || { k: 1, x: 0, y: 0 };
    drag = { t: 'none', x0: pos.x, y0: pos.y, cx0: ev.clientX, cy0: ev.clientY, z0: { k: z0.k, x: z0.x, y: z0.y },
             moved: 0, svg: svg, p: p };
  }
  function onMove(ev) {
    if (ptrs[ev.pointerId]) ptrs[ev.pointerId] = { x: ev.clientX, y: ev.clientY };
    if (pinch) {
      if (nPtrs() < 2) return;
      var mm = midOf(), ps = st(pinch.p.id), sv = document.querySelector('#lvCanvas svg');
      zoomTo(sv, ps, pinch.k0 * mm.d / pinch.d0, pinch.P, mm.x, mm.y);
      return;
    }
    if (!drag) return;
    if (drag.t === 'none') {
      // one finger on empty space pans a zoomed view
      var zs = st(drag.p.id);
      if (!(drag.z0.k > 1.001)) return;
      var ddx = ev.clientX - drag.cx0, ddy = ev.clientY - drag.cy0;
      if (!drag.moved && Math.hypot(ddx, ddy) < 5) return;
      drag.moved = 1;
      var rc = drag.svg.getBoundingClientRect(), vw = zs.base.w / drag.z0.k, vh = zs.base.h / drag.z0.k;
      var sc = Math.min(rc.width / vw, rc.height / vh) || 1;
      zs.z = { k: drag.z0.k, x: drag.z0.x - ddx / sc, y: drag.z0.y - ddy / sc };
      applyZoom(drag.svg, zs);
      return;
    }
    var pos = svgPt(drag.svg, ev);
    var dx = pos.x - drag.x0, dy = pos.y - drag.y0;
    if (Math.hypot(dx, dy) > 0.04) { drag.moved = 1; if (drag.lp) { clearTimeout(drag.lp); drag.lp = null; } }
    if (!drag.moved) return;
    if (drag.t === 'cutdraw') {
      var sgM = drag.seg, cs = cutSpan(LivingUnit.layoutOf(drag.p.living), sgM, drag.a0, sgM.o === 'h' ? pos.x : pos.y);
      var pl = drag.svg.querySelector('#lvPrev');
      if (sgM.o === 'h') previewLine(drag.svg, cs.a, sgM.c, cs.b, sgM.c); else previewLine(drag.svg, sgM.c, cs.a, sgM.c, cs.b);
      pl = drag.svg.querySelector('#lvPrev'); if (pl) pl.setAttribute('stroke', '#e53935');
      return;
    }
    if (drag.t === 'draw' || drag.t === 'wend') {
      var layD = LivingUnit.layoutOf(drag.p.living);
      if (drag.t === 'draw') {
        var e1 = snapPoint(layD, pos.x, pos.y);
        var wd = squareUp({ x1: drag.sx, y1: drag.sy, x2: e1.x, y2: e1.y });
        previewLine(drag.svg, wd.x1, wd.y1, wd.x2, wd.y2);
      } else {
        var w0 = findWall(layD, drag.id); if (!w0) return;
        var e2 = snapPoint(layD, pos.x, pos.y, drag.id);
        var fx = drag.end === 'p1' ? w0.x2 : w0.x1, fy = drag.end === 'p1' ? w0.y2 : w0.y1;
        var we = squareUp({ x1: fx, y1: fy, x2: e2.x, y2: e2.y });
        previewLine(drag.svg, we.x1, we.y1, we.x2, we.y2);
      }
      return;
    }
    if (drag.t === 'wall') {
      drag.el.setAttribute('transform', 'translate(' + dx + ' ' + dy + ')');
      drag.el.setAttribute('stroke', 'rgba(255,209,102,.8)');
      drag.el.setAttribute('stroke-width', 0.14);
      return;
    }
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
    delete ptrs[ev.pointerId];
    if (pinch) { if (nPtrs() < 2) { pinch = null; drag = null; } return; }
    if (!drag) return;
    var d = drag; drag = null;
    if (d.lp) clearTimeout(d.lp);
    var p = d.p, s = st(p.id);
    // A cancelled gesture (scroll took over, call came in) moves nothing.
    if (ev.type === 'pointercancel') { redraw(p); return; }
    var pos = svgPt(d.svg, ev);
    if (d.t === 'cutsel') { s.sel = { t: 'cut', id: d.id }; s.pop = ''; redraw(p); return; }
    if (d.t === 'cutdraw') {
      var layK = LivingUnit.layoutOf(p.living), sgK = d.seg, at = sgK.o === 'h' ? pos.x : pos.y;
      var span;
      if (d.moved) span = cutSpan(layK, sgK, d.a0, at);
      else if (s.cutStart && s.cutStart.o === sgK.o && Math.abs(s.cutStart.c - sgK.c) < 0.03) { span = cutSpan(layK, sgK, s.cutStart.at, at); s.cutStart = null; }
      else { s.cutStart = { o: sgK.o, c: sgK.c, at: at }; s.drawStart = sgK.o === 'h' ? { x: at, y: sgK.c } : { x: sgK.c, y: at }; redraw(p); return; }
      s.drawStart = null;
      if (span.b - span.a < 0.1) { redraw(p); return; }
      pushUndo(p);
      var layE2 = editable(p);
      layE2.edits = layE2.edits || [];
      var ce = { id: LivingUnit.uid(), o: sgK.o, c: sgK.c, a: n2(span.a), b: n2(span.b), cut: true };
      layE2.edits.push(ce);
      s.sel = { t: 'cut', id: ce.id };
      commit(p);
      return;
    }
    if (d.t === 'draw') {
      var layU = LivingUnit.layoutOf(p.living);
      var a = d.moved ? { x: d.sx, y: d.sy } : (s.drawStart || null);
      var b = snapPoint(layU, pos.x, pos.y);
      if (!d.moved && !s.drawStart) { s.drawStart = { x: d.sx, y: d.sy }; redraw(p); return; }
      s.drawStart = null;
      var nw = squareUp({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
      if (Math.hypot(nw.x2 - nw.x1, nw.y2 - nw.y1) < 0.3) { redraw(p); return; }
      pushUndo(p);
      var layW = editable(p);
      layW.walls = layW.walls || [];
      nw.id = LivingUnit.uid(); nw.kind = s.wallKind || 'panel';
      layW.walls.push(nw);
      s.sel = { t: 'wall', id: nw.id };
      commit(p);
      return;
    }
    if (d.t === 'wend' || d.t === 'wall') {
      if (!d.moved) { s.sel = { t: 'wall', id: d.id }; redraw(p); return; }
      pushUndo(p);
      var layE = editable(p), w = findWall(layE, d.id);
      if (w) {
        if (d.t === 'wend') {
          var pe = snapPoint(layE, pos.x, pos.y, w.id);
          if (d.end === 'p1') { w.x1 = pe.x; w.y1 = pe.y; var tx = w.x1, ty = w.y1; w.x1 = w.x2; w.y1 = w.y2; w.x2 = tx; w.y2 = ty; squareUp(w); }
          else { w.x2 = pe.x; w.y2 = pe.y; squareUp(w); }
        } else {
          var mx = n2(snap(pos.x - d.x0, 0.05)), my = n2(snap(pos.y - d.y0, 0.05));
          mx = Math.max(-Math.min(w.x1, w.x2), Math.min(layE.L - Math.max(w.x1, w.x2), mx));
          my = Math.max(-Math.min(w.y1, w.y2), Math.min(layE.W - Math.max(w.y1, w.y2), my));
          w.x1 = n2(w.x1 + mx); w.x2 = n2(w.x2 + mx); w.y1 = n2(w.y1 + my); w.y2 = n2(w.y2 + my);
        }
        if (Math.hypot(w.x2 - w.x1, w.y2 - w.y1) < 0.2) layE.walls = layE.walls.filter(function (x) { return x !== w; });
      }
      s.sel = w ? { t: 'wall', id: d.id } : null;
      commit(p);
      return;
    }
    if (d.t === 'none') {
      if (d.moved) return;                      // that was a pan
      if (s.sel || s.pop) { s.sel = null; if (s.pop === 'ins') s.pop = ''; redraw(p); }
      return;
    }
    if (d.t === 'seg') { s.sel = { t: 'seg', id: d.id }; if (s.pop && s.pop !== 'ins') s.pop = ''; redraw(p); return; }
    if (!d.moved) {
      s.sel = { t: d.t, id: d.id };
      if (s.pop && s.pop !== 'ins') s.pop = '';
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
    if (!s.sel && s.tool === 'cut') {
      box.innerHTML = '<div class="lv-hint" style="opacity:.9">\u2702\ufe0f ' +
        tt('גרור לאורך קיר כדי להסיר את הקטע הזה (מעבר פתוח, בלי דלת), או הקש בנקודת ההתחלה ואז בנקודת הסיום. קטע שהוסר מסומן באדום מקווקו — הקש עליו כדי להחזיר.',
           'ลากตามผนังเพื่อตัดออก', 'اسحب على الجدار لحذف المقطع') + '</div>';
      return;
    }
    if (!s.sel && s.tool === 'wall') {
      box.innerHTML = '<div class="lv-hint" style="opacity:.9">\u270f\ufe0f ' +
        tt('גרור לאורך הקו כדי לשרטט קיר, או לחץ בנקודת ההתחלה ואז בנקודת הסיום. הקיר נצמד לקירות, לחדרים ולמסגרת. לחץ שוב על "שרטט קיר" לסיום.',
           'ลากเพื่อวาดผนัง หรือแตะจุดเริ่มและจุดสิ้นสุด', 'اسحب لرسم جدار، أو اضغط نقطة البداية ثم النهاية') + '</div>';
      return;
    }
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
      box.innerHTML = '<div><b class="lv-title">' + LivingUnit.itemSym(it.kind) + ' ' + esc(LivingUnit.itemLabel(it.kind)) + '</b>' +
        (room ? ' <span style="opacity:.7">\u00b7 ' + esc(room.name || LivingUnit.roomLabel(room.type)) + '</span>' : '') +
        itemDimsTable(it) +
        '<div class="lv-row">' + lab('X') + inp('x', it.x) + lab('Y') + inp('y', it.y) +
          ((d.resize || d.wall) ? lab(tt('רוחב', 'กว้าง', 'عرض')) + inp('w', w) : '') + '</div>' +
        '</div>';
      return;
    }
    if (s.sel.t === 'cut') {
      var ce = (lay.edits || []).filter(function (e) { return e.id === s.sel.id; })[0];
      if (!ce) { s.sel = null; box.innerHTML = ''; return; }
      box.innerHTML = '<div><b class="lv-title">\u2702 ' + tt('קטע קיר שהוסר', 'ส่วนผนังที่ตัดออก', 'جزء جدار محذوف') + '</b>' +
        dimsTable([[tt('אורך', 'ความยาว', 'الطول'), m(ce.b - ce.a)]]) +
        '<div class="lv-hint">' + tt('המעבר פתוח, בלי דלת. הכמויות כבר מחושבות בלעדיו.', 'ช่องเปิดไม่มีประตู', 'فتحة بلا باب') + '</div></div>';
      return;
    }
    if (s.sel.t === 'seg') {
      var si = LivingUnit.segInfo(p.living, s.sel.id);
      if (!si) { s.sel = null; box.innerHTML = ''; return; }
      var uN = LivingUnit.norm(p.living);
      var matSel = si.seg.outer ? '' :
        '<div class="lv-row">' + lab(tt('חומר', 'วัสดุ', 'المادة')) +
          '<select onchange="LivingEdit.segMat(' + id + ',this.value)">' +
          LivingUnit.WALL_MATS.map(function (mt) {
            return '<option value="' + mt + '"' + (si.mat === mt ? ' selected' : '') + '>' + esc(LivingUnit.matLabel(mt, uN)) + '</option>';
          }).join('') + '</select></div>';
      var cutRow = '<div class="lv-row">' + lab(tt('הסר קטע: מ-', 'ตัดจาก', 'احذف من')) +
          '<input type="number" step="0.05" min="0" id="lvCutFrom" value="' + n2(Math.max(0, si.len / 2 - 0.5)) + '">' +
          lab(tt('אורך', 'ยาว', 'طول')) + '<input type="number" step="0.05" min="0.1" id="lvCutLen" value="' + n2(Math.min(1, si.len)) + '">' +
          '<button class="lv-b" onclick="LivingEdit.cutSeg(' + id + ',document.getElementById(\'lvCutFrom\').value,document.getElementById(\'lvCutLen\').value)">\u2702 ' +
            tt('הסר', 'ตัด', 'احذف') + '</button></div>' +
        '<div class="lv-row"><button class="lv-b dang" onclick="LivingEdit.cutSeg(' + id + ',0,' + n2(si.len) + ')">\ud83d\uddd1 ' +
          tt('הסר את כל הקטע', 'ตัดทั้งส่วน', 'احذف المقطع كله') + ' (' + n2(si.len) + ' m)</button></div>';
      box.innerHTML = '<div><b class="lv-title">\u2501 ' + (si.seg.outer ? tt('קיר חוץ', 'ผนังภายนอก', 'جدار خارجي') : tt('קיר פנים', 'ผนังภายใน', 'جدار داخلي')) +
        '</b> <span style="opacity:.7">\u00b7 ' + (si.seg.outer ? tt('מעטפת', 'เปลือก', 'غلاف')
          : si.block ? tt('בלוק', 'บล็อก', 'بلوك') : tt('פאנל', 'แผง', 'لوح')) +
          (si.faces.some(Boolean) ? ' \u00b7 ' + tt('צד רטוב', 'ด้านเปียก', 'وجه رطب') : '') + '</span>' + matSel +
        dimsTable([[tt('אורך', 'ความยาว', 'الطول'), m(si.len)], [tt('עובי', 'ความหนา', 'السماكة'), cm(si.t)],
                   [tt('גובה', 'ความสูง', 'الارتفاع'), m(si.H)],
                   [tt('שטח ברוטו', 'พื้นที่รวม', 'المساحة الإجمالية'), m2(si.gross)],
                   [tt('שטח נטו (בניכוי פתחים)', 'พื้นที่สุทธิ', 'المساحة الصافية'), m2(si.net)]]) +
        (si.openings.length ? '<div class="lv-hint">' + si.openings.map(function (o) {
          return LivingUnit.itemSym(o.kind) + ' ' + esc(LivingUnit.itemLabel(o.kind)) + ' ' + n2(o.w) + '\u00d7' + n2(o.h);
        }).join(' \u00b7 ') + '</div>' : '') +
        cutRow +
        '<div class="lv-hint">' + tt('המיקום והאורך של קיר זה נקבעים לפי החדרים. "מ-" נמדד מתחילת הקטע.',
          'ตำแหน่งผนังกำหนดโดยห้อง', 'موضع الجدار تحدده الغرف') + '</div></div>';
      return;
    }
    if (s.sel.t === 'wall') {
      var fw = findWall(lay, s.sel.id);
      if (!fw) { s.sel = null; box.innerHTML = ''; return; }
      var len = Math.hypot(fw.x2 - fw.x1, fw.y2 - fw.y1);
      var winp = function (k, v) {
        return '<input class="bp-in" type="number" step="0.05" value="' + v + '" onchange="LivingEdit.setWall(' + id + ',\'' + k + '\',this.value)">';
      };
      var fsi = null;
      LivingUnit.walls(lay).forEach(function (sg) {
        if (fsi || !sg.free) return;
        var on = fw.y1 === fw.y2 ? (sg.o === 'h' && Math.abs(sg.c - fw.y1) < 0.03 && sg.a < Math.max(fw.x1, fw.x2) && sg.b > Math.min(fw.x1, fw.x2))
                                 : (sg.o === 'v' && Math.abs(sg.c - fw.x1) < 0.03 && sg.a < Math.max(fw.y1, fw.y2) && sg.b > Math.min(fw.y1, fw.y2));
        if (on) fsi = LivingUnit.segInfo(p.living, LivingUnit.segKey(sg));
      });
      var fH = LivingUnit.norm(p.living).height;
      box.innerHTML = '<div><b class="lv-title">\u2501 ' + tt('קיר מחיצה', 'ผนังกั้น', 'جدار فاصل') + '</b> <span style="opacity:.7">\u00b7 ' +
        (fw.y1 === fw.y2 ? '\u2194' : '\u2195') + '</span>' +
        dimsTable([[tt('אורך', 'ความยาว', 'الطول'), m(len)],
                   [tt('עובי', 'ความหนา', 'السماكة'), cm(fsi ? fsi.t : LivingUnit.wallThick({ block: fw.kind === 'block' }, LivingUnit.norm(p.living)))],
                   [tt('גובה', 'ความสูง', 'الارتفاع'), m(fH)], [tt('שטח', 'พื้นที่', 'المساحة'), m2(len * fH)]]) +
        (fsi && fsi.block && fw.kind !== 'block'
          ? '<div class="lv-hint" style="color:#e0a030;opacity:1">\u26a0\ufe0f ' +
            tt('הקיר חופף לגבול של חדר רטוב, ולכן נבנה ונספר כבלוק.', 'ผนังนี้ทับขอบห้องเปียก จึงนับเป็นบล็อก', 'الجدار يطابق حد غرفة رطبة لذا يُحسب بلوكاً') + '</div>'
          : '') +
        '<div class="lv-row">' + lab(tt('סוג', 'ชนิด', 'النوع')) +
          '<select class="bp-in" style="width:auto" onchange="LivingEdit.setWall(' + id + ',\'kind\',this.value)">' +
            LivingUnit.WALL_MATS.map(function (mt) {
              return '<option value="' + mt + '"' + ((fw.kind || 'panel') === mt ? ' selected' : '') + '>' + esc(LivingUnit.matLabel(mt, LivingUnit.norm(p.living))) + '</option>';
            }).join('') +
          '</select>' + lab(tt('אורך', 'ยาว', 'طول')) + winp('len', n2(len)) + '</div>' +
        '<div class="lv-row">' + lab(tt('התחלה', 'จุดเริ่ม', 'البداية') + ' X') + winp('x1', fw.x1) + lab('Y') + winp('y1', fw.y1) + '</div>' +
        '<div class="lv-hint">' + tt('גרור את הקיר להזזה · גרור נקודת קצה כדי להאריך, לקצר או לסובב',
          'ลากผนังเพื่อย้าย · ลากปลายเพื่อปรับ', 'اسحب الجدار للنقل · اسحب الطرف للتعديل') + '</div>' +
        '</div>';
      return;
    }
    var r = findRoom(lay, s.sel.id);
    if (!r) { s.sel = null; box.innerHTML = ''; return; }
    box.innerHTML = '<div><b class="lv-title">\u25ad ' + esc(r.name || LivingUnit.roomLabel(r.type)) + '</b>' +
      dimsTable([[tt('אורך', 'ความยาว', 'الطول'), m(Math.max(r.w, r.h))], [tt('רוחב', 'ความกว้าง', 'العرض'), m(Math.min(r.w, r.h))],
                 [tt('שטח', 'พื้นที่', 'المساحة'), m2(r.w * r.h)], [tt('היקף', 'เส้นรอบรูป', 'المحيط'), m(2 * (r.w + r.h))]]) +
      '<div class="lv-row">' + lab(tt('שם', 'ชื่อ', 'الاسم')) +
        '<input class="wide" value="' + esc(r.name) + '" onchange="LivingEdit.setRoom(' + id + ',\'name\',this.value)">' +
        '<select class="bp-in" style="width:auto" onchange="LivingEdit.setRoom(' + id + ',\'type\',this.value)">' +
        LivingUnit.ROOM_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (t === r.type ? ' selected' : '') + '>' + esc(LivingUnit.roomLabel(t)) + '</option>';
        }).join('') + '</select></div>' +
      '<div class="lv-row">' + lab('X') + inp('x', r.x) + lab('Y') + inp('y', r.y) +
        lab(tt('אורך', 'ยาว', 'طول')) + inp('w', r.w) + lab(tt('רוחב', 'กว้าง', 'عرض')) + inp('h', r.h) + '</div>' +
      '<div class="lv-row">' + lab(tt('רצפה', 'พื้น', 'الأرضية')) +
        '<select class="bp-in" style="width:auto" onchange="LivingEdit.setRoom(' + id + ',\'floor\',this.value)">' +
          '<option value=""' + (!r.floor ? ' selected' : '') + '>' + tt('כמו בפרויקט', 'ตามโครงการ', 'كالمشروع') + ' (' +
            esc(LivingUnit.floorLabel(LivingUnit.norm(p.living).floor)) + ')</option>' +
          LivingUnit.FLOORS.map(function (f) {
            return '<option value="' + f + '"' + (r.floor === f ? ' selected' : '') + '>' + esc(LivingUnit.floorLabel(f)) + '</option>';
          }).join('') + '</select></div>' +
      '<div class="lv-row"><label><input type="checkbox"' + (r.open ? ' checked' : '') + ' onchange="LivingEdit.setRoom(' + id + ',\'open\',this.checked)"> ' +
        tt('חלל פתוח (בלי קיר לחללים פתוחים סמוכים)', 'พื้นที่เปิด', 'مساحة مفتوحة') + '</label></div>' +
      '<div class="lv-row"><label><input type="checkbox"' + (s.link ? ' checked' : '') + ' onchange="LivingEdit.link(' + id + ',this.checked)"> \ud83d\udd17 ' +
        tt('גרירת קצה מזיזה גם את החדר הצמוד (קיר משותף)', 'ลากขอบแล้วห้องข้างเคียงขยับตาม', 'سحب الحافة يحرك الغرفة المجاورة أيضاً') + '</label></div>' +
      '<div class="lv-hint">' + tt('גרור את הידיות הכתומות כדי לשנות גודל · גרור את החדר כדי להזיז אותו עם התכולה',
        'ลากที่จับสีส้มเพื่อปรับขนาด · ลากห้องเพื่อย้าย', 'اسحب المقابض البرتقالية لتغيير الحجم · اسحب الغرفة لنقلها') + '</div>' +
      '</div>';
  }

  function m(v) { return n2(v).toFixed(2) + ' m'; }
  function cm(v) { return Math.round(v * 100) + ' cm'; }
  function m2(v) { return n2(v).toFixed(2) + ' m\u00b2'; }
  function dimsTable(rows) {
    return '<div class="lv-dims">' +
      rows.map(function (r) { return '<span>' + r[0] + '</span><b>' + r[1] + '</b>'; }).join('') + '</div>';
  }
  function itemDimsTable(it) {
    var dd = LivingUnit.itemDims(it), rows;
    if (LivingUnit.ITEMS[it.kind] && LivingUnit.ITEMS[it.kind].wall) {
      rows = [[tt('רוחב', 'ความกว้าง', 'العرض'), m(dd.w)], [tt('גובה', 'ความสูง', 'الارتفاع'), m(dd.h)]];
      if (dd.z) rows.push([tt('גובה אדן', 'ความสูงขอบ', 'ارتفاع العتبة'), m(dd.z)]);
    } else {
      rows = [[tt('אורך', 'ความยาว', 'الطول'), m(Math.max(dd.w, dd.d))], [tt('רוחב', 'ความกว้าง', 'العرض'), m(Math.min(dd.w, dd.d))],
              [tt('גובה', 'ความสูง', 'الارتفاع'), m(dd.h)]];
      if (dd.ceil) rows.push([tt('התקנה', 'ติดตั้ง', 'التركيب'), tt('תקרה', 'เพดาน', 'السقف')]);
      else if (dd.z) rows.push([tt('גובה התקנה', 'ความสูงติดตั้ง', 'ارتفاع التركيب'), m(dd.z)]);
    }
    return dimsTable(rows);
  }
  function palette(p) {
    var groups = [
      ['\ud83d\udeaa ' + tt('פתחים', 'ช่องเปิด', 'فتحات'), ['door', 'door_slide', 'door_ext', 'window']],
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
      '<br>\u23f1 ' + tt('עבודה', 'แรงงาน', 'العمل') + ' <b>' + LivingUnit.labour(p.living).total + ' ' + tt('ש"ע', 'ชม.', 'س') + '</b> \u00b7 ~<b>' +
        LivingUnit.labour(p.living).days + '</b> ' + tt('ימים ל-', 'วันสำหรับ ', 'أيام لـ') + LivingUnit.norm(p.living).crew + ' ' + tt('עובדים', 'คนงาน', 'عمال') +
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
    var u = LivingUnit.norm(p.living);
    lay.rooms.forEach(function (r) {
      out['room:' + r.id] = { title: r.name || LivingUnit.roomLabel(r.type),
        sub: n2(Math.max(r.w, r.h)) + ' \u00d7 ' + n2(Math.min(r.w, r.h)) + ' m \u00b7 ' + n1(r.w * r.h) + ' m\u00b2' };
    });
    lay.items.forEach(function (it) {
      var dd = LivingUnit.itemDims(it);
      out['it:' + it.id] = { title: LivingUnit.itemLabel(it.kind),
        sub: (LivingUnit.ITEMS[it.kind].wall ? n2(dd.w) + ' \u00d7 ' + n2(dd.h) : n2(Math.max(dd.w, dd.d)) + ' \u00d7 ' + n2(Math.min(dd.w, dd.d)) + ' \u00d7 ' + n2(dd.h)) + ' m' };
    });
    LivingUnit.walls(lay).forEach(function (sg) {
      var k = LivingUnit.segKey(sg);
      out['seg:' + k] = { title: sg.outer ? tt('קיר חוץ', 'ผนังภายนอก', 'جدار خارجي') : tt('קיר פנים', 'ผนังภายใน', 'جدار داخلي'),
        sub: n2(sg.len) + ' m \u00b7 ' + Math.round(LivingUnit.wallThick(sg, u) * 100) + ' cm \u00b7 ' + n2(u.height) + ' m' };
    });
    out.north = { title: tt('צפון', 'ทิศเหนือ', 'الشمال'), sub: '' };
    return out;
  }
  // The selection, as the group name the 3D model uses for it.
  function selGroup(s) {
    if (!s.sel) return null;
    return { item: 'it:', room: 'room:', seg: 'seg:' }[s.sel.t] ? { item: 'it:', room: 'room:', seg: 'seg:' }[s.sel.t] + s.sel.id : null;
  }
  function draw3d(p) {
    var cv = document.getElementById('lvCanvas');
    if (!cv) return;
    var s = st(p.id);
    if (viewer && viewerFor === p.id) {
      viewer.update(model(p));
      if (viewer.setLabels) viewer.setLabels(labelsFor(p));
      if (viewer.select) viewer.select(selGroup(s));
      return;
    }
    destroy3d();
    cv.className = 'lv-cv lv-3d';
    // WebGL when the device has it and three.js can be fetched; the canvas
    // painter otherwise, so the view never just goes blank
    var gl = window.LivingView3D && LivingView3D.supported() && !s.painter;
    if (gl && !(window.THREE && window.THREE.WebGLRenderer)) {
      cv.innerHTML = '<div class="lv-load">\u23f3 ' + tt('טוען תצוגת תלת-מימד…', 'กำลังโหลด 3 มิติ…', 'جارٍ تحميل العرض الثلاثي…') + '</div>';
      LivingView3D.ready().then(function (ok) {
        if (!ok) s.painter = true;
        if (st(p.id).view === '3d' && document.getElementById('lvCanvas') === cv) { cv.innerHTML = ''; draw3d(p); }
      });
      return;
    }
    if (!gl && typeof Shed3D === 'undefined') return;
    cv.innerHTML = '';
    var Eng = gl ? LivingView3D : Shed3D;
    var sun = sunOf(s.sun);
    viewer = Eng.mount(cv, model(p), {
      state: camState[p.id] || { sunAz: sun[0], sunEl: sun[1] },
      labels: labelsFor(p),
      onSelect: function (g) {
        g = String(g || '');
        if (g.indexOf('it:') === 0) s.sel = { t: 'item', id: g.slice(3) };
        else if (g.indexOf('seg:') === 0) s.sel = { t: 'seg', id: g.slice(4) };
        else if (g.indexOf('room:') === 0) s.sel = { t: 'room', id: g.slice(5) };
        else s.sel = null;
        ctxBar(p, LivingUnit.layoutOf(p.living));
        sheet(p);
      }
    });
    viewerFor = p.id;
    if (viewer.select) viewer.select(selGroup(s));
    var f = frameFor(p);
    if (f.has && BP.groundImage) {
      // imagery for the whole ground plane, which is centred on the
      // building and not necessarily on the footprint
      var ge = model(p).ext;
      var half = Math.max(Math.abs(ge.x0), Math.abs(ge.x1), Math.abs(ge.y0), Math.abs(ge.y1)) + 2;
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
    st(id).full = false;
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
    view: function (id, v) {
      withP(id, function (p) {
        var s = st(id);
        s.view = v === '3d' ? '3d' : 'plan';
        if (s.view === '3d') { s.tool = null; s.drawStart = null; }
        redraw(p);
      });
    },
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
        else if (k === 'floor') r.floor = LivingUnit.FLOORS.indexOf(v) >= 0 ? v : '';
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
        // A door or window cannot stand across its wall: a turn of one swaps
        // the side it opens to (a half-turn in the wall) instead.
        var inWall = LivingUnit.ITEMS[it.kind].wall;
        it.rot = ((it.rot + (inWall ? 180 : deg)) % 360 + 360) % 360;
        if (inWall) placeItem(lay, it, it.x, it.y);
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
        s.pop = '';
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
        s.pop = '';
        commit(p);
      });
    },
    link: function (id, on) { st(id).link = !!on; },
    rotRoom: function (id, cw) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'room') return;
        var lay = editable(p), r = findRoom(lay, s.sel.id); if (!r) return;
        var before = JSON.stringify(p.living.layout);
        var res = rotateRoom(lay, r, cw !== false && cw !== 0);
        if (!res.ok) {
          p.living.layout = JSON.parse(before);
          if (BP.toast) BP.toast('\u26a0\ufe0f ' + tt('החדר לא נכנס במבנה אחרי סיבוב', 'ห้องไม่พอดีหลังหมุน', 'الغرفة لا تتسع بعد التدوير'));
          return;
        }
        var s2 = st(id); s2.undo.push(before); if (s2.undo.length > 40) s2.undo.shift();
        if (res.overlaps.length && BP.toast) {
          BP.toast('\u26a0\ufe0f ' + tt('החדר חופף ל', 'ทับซ้อนกับ ', 'تتداخل مع ') +
            res.overlaps.map(function (o) { return o.name || LivingUnit.roomLabel(o.type); }).join(', ') +
            ' \u2014 ' + tt('הזז או שנה גודל', 'ย้ายหรือปรับขนาด', 'انقل أو غيّر الحجم'));
        } else if (res.slid && BP.toast) {
          BP.toast('\u2194 ' + tt('החדר הוזז פנימה כדי להישאר בתוך המבנה', 'เลื่อนเข้าในอาคาร', 'نُقلت الغرفة لتبقى داخل المبنى'));
        }
        commit(p);
      });
    },
    _rotRoom: rotateRoom,
    menu: function (id, act) {
      closeMenu();
      var go = {
        rotR: function () { API.rot(id, -90); }, rotL: function () { API.rot(id, 90); },
        rotRoomR: function () { API.rotRoom(id, 1); }, rotRoomL: function () { API.rotRoom(id, 0); },
        flip: function () { API.flip(id); }, dup: function () { API.dup(id); }, del: function () { API.del(id); },
        splitL: function () { API.split(id, 0); }, splitW: function () { API.split(id, 1); },
        dupRoom: function () { API.dupRoom(id); }, delRoom: function () { API.delRoom(id); },
        rotWall: function () { API.rotWall(id); }, dupWall: function () { API.dupWall(id); }, delWall: function () { API.delWall(id); },
        edit: function () { var s = st(id); s.pop = ''; API.pop(id, 'ins'); },
        restore: function () { API.restoreCut(id); },
        cutWhole: function () {
          var s = st(id), pp = proj(id); if (!pp || !s.sel || s.sel.t !== 'seg') return;
          var si = LivingUnit.segInfo(pp.living, s.sel.id); if (si) API.cutSeg(id, 0, si.len);
        }
      }[act];
      if (go) go();
    },
    pop: function (id, name) {
      withP(id, function (p) {
        var s = st(id);
        s.pop = (s.pop === name) ? '' : (name || '');
        if (s.pop === 'add' || s.pop === 'layers') { s.tool = null; s.drawStart = null; }
        redraw(p);
      });
    },
    zoom: function (id, dir) {
      withP(id, function (p) {
        var s = st(id);
        if (s.view !== 'plan') { if (viewer && viewerFor === id) viewer.resetView(); return; }
        var svg = document.querySelector('#lvCanvas svg'); if (!svg || !s.base) return;
        if (!dir) { s.z = { k: 1 }; applyZoom(svg, s); redraw(p); return; }
        var rc = svg.getBoundingClientRect(), cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2;
        var k = ((s.z && s.z.k) || 1) * (dir > 0 ? 1.5 : 1 / 1.5);
        zoomTo(svg, s, k, svgPt(svg, { clientX: cx, clientY: cy }), cx, cy);
      });
    },
    full: function (id) {
      withP(id, function (p) {
        var s = st(id);
        s.full = !s.full;
        destroy3d();            // the 3D canvas sizes itself to its box
        redraw(p);
        if (s.full && !fullKeyBound) {
          fullKeyBound = true;
          document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            Object.keys(ST).forEach(function (k) {
              if (ST[k].full) { ST[k].full = false; var pp = proj(Number(k)); if (pp) { destroy3d(); redraw(pp); } }
            });
          });
        }
      });
    },
    tool: function (id) {
      withP(id, function (p) {
        var s = st(id);
        s.tool = s.tool === 'wall' ? null : 'wall';
        s.drawStart = null;
        if (s.tool) { s.view = 'plan'; s.sel = null; }
        redraw(p);
      });
    },
    wallKind: function (id, k) { withP(id, function (p) { st(id).wallKind = LivingUnit.WALL_MATS.indexOf(k) >= 0 ? k : 'panel'; redraw(p); }); },
    cutTool: function (id) {
      withP(id, function (p) {
        var s = st(id);
        s.tool = s.tool === 'cut' ? null : 'cut';
        s.drawStart = null; s.cutStart = null;
        if (s.tool) { s.view = 'plan'; s.sel = null; s.pop = ''; }
        redraw(p);
      });
    },
    segMat: function (id, mt) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'seg') return;
        var si = LivingUnit.segInfo(p.living, s.sel.id); if (!si || si.seg.outer) return;
        pushUndo(p);
        var lay = editable(p), sg = si.seg;
        lay.edits = (lay.edits || []).filter(function (e) {
          // a new choice for exactly this stretch replaces an older one
          return e.cut || !(e.o === sg.o && Math.abs(e.c - sg.c) < 0.03 && e.a >= sg.a - 0.01 && e.b <= sg.b + 0.01);
        });
        lay.edits.push({ id: LivingUnit.uid(), o: sg.o, c: sg.c, a: n2(sg.a), b: n2(sg.b), mat: mt });
        s.sel = { t: 'seg', id: LivingUnit.segKey(sg) };
        commit(p);
      });
    },
    cutSeg: function (id, from, len) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'seg') return;
        var si = LivingUnit.segInfo(p.living, s.sel.id); if (!si) return;
        var f = Math.max(0, Number(from) || 0), l = Math.max(0.1, Number(len) || 0);
        var a = si.seg.a + f, b = Math.min(si.seg.b, a + l);
        if (b - a < 0.1) return;
        pushUndo(p);
        var lay = editable(p);
        lay.edits = lay.edits || [];
        var ce = { id: LivingUnit.uid(), o: si.seg.o, c: si.seg.c, a: n2(a), b: n2(b), cut: true };
        lay.edits.push(ce);
        s.sel = { t: 'cut', id: ce.id };
        commit(p);
      });
    },
    restoreCut: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'cut') return;
        pushUndo(p);
        var lay = editable(p);
        lay.edits = (lay.edits || []).filter(function (e) { return e.id !== s.sel.id; });
        s.sel = null;
        commit(p);
      });
    },
    setWall: function (id, k, v) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'wall') return;
        pushUndo(p);
        var lay = editable(p), w = findWall(lay, s.sel.id); if (!w) return;
        if (k === 'kind') w.kind = LivingUnit.WALL_MATS.indexOf(v) >= 0 ? v : 'panel';
        else {
          var x = Number(v); if (!isFinite(x)) return;
          var horiz = w.y1 === w.y2;
          if (k === 'len') {
            x = Math.max(0.3, x);
            if (horiz) w.x2 = n2(Math.min(lay.L, w.x1 + (w.x2 >= w.x1 ? x : -x)));
            else w.y2 = n2(Math.min(lay.W, w.y1 + (w.y2 >= w.y1 ? x : -x)));
            w.x2 = Math.max(0, w.x2); w.y2 = Math.max(0, w.y2);
          } else if (k === 'x1' || k === 'y1') {
            var dxx = k === 'x1' ? x - w.x1 : 0, dyy = k === 'y1' ? x - w.y1 : 0;
            w.x1 = n2(w.x1 + dxx); w.x2 = n2(w.x2 + dxx); w.y1 = n2(w.y1 + dyy); w.y2 = n2(w.y2 + dyy);
          }
        }
        commit(p);
      });
    },
    rotWall: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'wall') return;
        pushUndo(p);
        var lay = editable(p), w = findWall(lay, s.sel.id); if (!w) return;
        var len = Math.hypot(w.x2 - w.x1, w.y2 - w.y1);
        if (w.y1 === w.y2) { w.x2 = w.x1; w.y2 = n2(Math.min(lay.W, w.y1 + len)); }
        else { w.y2 = w.y1; w.x2 = n2(Math.min(lay.L, w.x1 + len)); }
        commit(p);
      });
    },
    dupWall: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'wall') return;
        pushUndo(p);
        var lay = editable(p), w = findWall(lay, s.sel.id); if (!w) return;
        var c = JSON.parse(JSON.stringify(w)), horiz = w.y1 === w.y2;
        c.id = LivingUnit.uid();
        if (horiz) { var ny = w.y1 + 1 <= lay.W ? 1 : -1; c.y1 = c.y2 = n2(w.y1 + ny); }
        else { var nx = w.x1 + 1 <= lay.L ? 1 : -1; c.x1 = c.x2 = n2(w.x1 + nx); }
        lay.walls.push(c);
        s.sel = { t: 'wall', id: c.id };
        commit(p);
      });
    },
    delWall: function (id) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'wall') return;
        pushUndo(p);
        var lay = editable(p);
        lay.walls = (lay.walls || []).filter(function (w) { return w.id !== s.sel.id; });
        s.sel = null;
        commit(p);
      });
    },
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
