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
      u.layout = JSON.parse(JSON.stringify({ L: cur.L, W: cur.W, rooms: cur.rooms, walls: cur.walls || [], items: cur.items }));
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
    s.textContent =
      '.lv-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center}' +
      '.lv-b{border:1px solid rgba(255,255,255,.14);background:rgba(255,255,255,.05);color:inherit;border-radius:9px;padding:5px 9px;font:inherit;font-size:.76rem;cursor:pointer;white-space:nowrap}' +
      '.lv-b.on{background:var(--accent,#ff9f43);color:#1b1b1b;border-color:transparent;font-weight:700}' +
      '.lv-b:disabled{opacity:.4}' +
      // the editing surface: canvas with its tools floating on it
      '.lv-wrap{position:relative;border-radius:12px;overflow:hidden;background:rgba(0,0,0,.14)}' +
      '.lv-cv{position:relative;overflow:hidden;padding:48px 50px 58px 8px;touch-action:none}' +
      '.lv-cv.lv-3d{height:420px;padding:0}' +
      '.lv-full{position:fixed;inset:0;z-index:2400;border-radius:0;background:var(--bg,#0f1a14)}' +
      '.lv-full .lv-cv{position:absolute;inset:0;height:auto}' +
      '.lv-full .lv-cv svg{height:100%!important}' +
      '.lv-full .lv-cv.lv-3d{padding:0}' +
      '.lv-top{position:absolute;top:6px;left:6px;right:6px;display:flex;gap:4px;overflow-x:auto;z-index:5;pointer-events:none;scrollbar-width:none}' +
      '.lv-top::-webkit-scrollbar{display:none}' +
      '.lv-o{pointer-events:auto;flex:0 0 auto;min-height:36px;min-width:36px;border:0;border-radius:10px;padding:6px 10px;' +
        'background:rgba(16,26,20,.84);color:#fff;font:600 .78rem Heebo,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3);white-space:nowrap}' +
      '.lv-o.on{background:var(--accent,#ff9f43);color:#1b1b1b}' +
      '.lv-o:disabled{opacity:.45}' +
      '.lv-o.dang{background:rgba(160,40,40,.88)}' +
      '.lv-seg{display:flex;pointer-events:auto;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.3);flex:0 0 auto}' +
      '.lv-seg .lv-o{border-radius:0;box-shadow:none}' +
      '.lv-zoom{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:4px;z-index:5}' +
      '.lv-zoom .lv-o{font-size:1.05rem;padding:4px 0;width:40px}' +
      '.lv-zoom span{font:600 .66rem Heebo,sans-serif;color:#fff;text-align:center;background:rgba(16,26,20,.7);border-radius:6px;padding:1px 0}' +
      '.lv-ctx{position:absolute;left:6px;right:6px;bottom:6px;z-index:5;display:flex;gap:4px;align-items:center;overflow-x:auto;scrollbar-width:none}' +
      '.lv-ctx::-webkit-scrollbar{display:none}' +
      '.lv-ctx .lv-info{flex:1 1 auto;min-width:120px;background:rgba(16,26,20,.84);color:#fff;border-radius:10px;padding:5px 10px;font:.74rem Heebo,sans-serif;line-height:1.35;box-shadow:0 2px 8px rgba(0,0,0,.3)}' +
      '.lv-ctx .lv-info b{color:#ffd166}' +
      '.lv-sheet{position:absolute;left:6px;right:6px;bottom:6px;max-height:72%;overflow:auto;z-index:6;display:none;' +
        'background:var(--card,#16211b);border-radius:14px;padding:10px 12px;box-shadow:0 -4px 24px rgba(0,0,0,.45);font-size:.82rem}' +
      '.lv-sheet.on{display:block}' +
      '.lv-sheet-h{display:flex;align-items:center;gap:8px;margin-bottom:6px}.lv-sheet-h b{flex:1}' +
      '.lv-ins .lv-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px}' +
      '.lv-ins input,.lv-ins select{width:72px;padding:3px 5px;font-size:.8rem}' +
      '.lv-ins input.wide{width:150px}' +
      '.lv-q{margin-top:8px;font-size:.76rem;line-height:1.7}' +
      '.lv-q b{color:var(--accent,#ff9f43)}' +
      '.lv-warn{margin-top:6px;font-size:.76rem;color:#e0a030;line-height:1.6}' +
      '.lv-hint{font-size:.72rem;opacity:.7;margin-top:4px}' +
      '.lv-menu{position:absolute;z-index:8;min-width:170px;background:var(--card,#16211b);border-radius:12px;padding:5px;' +
        'box-shadow:0 8px 28px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.1);font:600 .82rem Heebo,sans-serif}' +
      '.lv-menu .lv-mh{padding:5px 9px 6px;font-size:.74rem;opacity:.7;border-bottom:1px solid rgba(255,255,255,.08);margin-bottom:3px}' +
      '.lv-menu button{display:flex;gap:9px;align-items:center;width:100%;border:0;background:none;color:inherit;font:inherit;' +
        'padding:9px 10px;border-radius:8px;cursor:pointer;text-align:start}' +
      '.lv-menu button:hover{background:rgba(255,255,255,.08)}' +
      '.lv-menu button.dang{color:#ff8a80}' +
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
        '<div class="lv-cv" id="lvCanvas"></div>' +
        '<div class="lv-top" id="lvTop"></div>' +
        '<div class="lv-zoom" id="lvZoom"></div>' +
        '<div class="lv-ctx" id="lvCtx"></div>' +
        '<div class="lv-sheet" id="lvSheet"><div class="lv-sheet-h"><b id="lvSheetT"></b>' +
          '<button class="lv-o" onclick="LivingEdit.pop(' + p.id + ',\'\')">\u2715</button></div>' +
          '<div id="lvSheetB"></div><div id="lvIns"></div></div>' +
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
    redraw(p);
  }

  function redraw(p) {
    var s = st(p.id);
    var top = document.getElementById('lvTop');
    if (!top) return;
    var f = frameFor(p);
    var lay = LivingUnit.layoutOf(p.living);
    var wrap = document.getElementById('lvWrap');
    if (wrap) wrap.className = 'lv-wrap' + (s.full ? ' lv-full' : '');
    var plan = s.view === 'plan';
    var b = function (on, act, label, extra) {
      return '<button class="lv-o' + (on ? ' on' : '') + '" onclick="LivingEdit.' + act + '"' + (extra || '') + '>' + label + '</button>';
    };
    top.innerHTML =
      '<div class="lv-seg">' +
        b(plan, 'view(' + p.id + ',\'plan\')', '\ud83d\udcd0 ' + tt('תוכנית', 'แผนผัง', 'مخطط')) +
        b(!plan, 'view(' + p.id + ',\'3d\')', '\ud83e\uddca 3D') +
      '</div>' +
      b(false, 'undo(' + p.id + ')', '\u21b6', s.undo.length ? ' title="' + esc(tt('בטל', 'เลิกทำ', 'تراجع')) + '"' : ' disabled') +
      (plan ? b(s.tool === 'wall', 'tool(' + p.id + ')', '\u270f\ufe0f ' + tt('קיר', 'ผนัง', 'جدار')) : '') +
      (plan ? b(s.pop === 'add', 'pop(' + p.id + ',\'add\')', '\u2795 ' + tt('הוסף', 'เพิ่ม', 'أضف')) : '') +
      b(s.pop === 'layers', 'pop(' + p.id + ',\'layers\')', '\ud83d\uddc2 ' + tt('שכבות', 'เลเยอร์', 'طبقات')) +
      (f.has ? b(false, 'showOnMap(' + p.id + ')', '\ud83d\uddfa') : '') +
      b(s.full, 'full(' + p.id + ')', s.full ? '\u2715 ' + tt('סגור', 'ปิด', 'إغلاق') : '\u26f6');

    var zm = document.getElementById('lvZoom');
    if (zm) zm.innerHTML = plan
      ? b(false, 'zoom(' + p.id + ',1)', '+') + b(false, 'zoom(' + p.id + ',-1)', '\u2212') +
        b(false, 'zoom(' + p.id + ',0)', '\u2922') + '<span>' + Math.round(((s.z && s.z.k) || 1) * 100) + '%</span>'
      : b(false, 'top(' + p.id + ')', '\u2b07') + b(false, 'zoom(' + p.id + ',0)', '\u2922');

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
    var lbl = document.querySelector('#lvZoom span');
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
      row('dup', '\u29c9', tt('שכפל', 'ทำซ้ำ', 'نسخ'));
      edit();
      row('del', '\ud83d\uddd1', tt('מחק', 'ลบ', 'حذف'), 'dang');
    } else if (tg.t === 'room') {
      var r = findRoom(lay, tg.id); if (!r) return;
      title = '\u25ad ' + esc(r.name || LivingUnit.roomLabel(r.type));
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
    } else {
      title = '\u2501 ' + tt('קיר', 'ผนัง', 'جدار');
      row('edit', '\u2139', tt('פרטי הקיר', 'รายละเอียดผนัง', 'تفاصيل الجدار'));
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
      } else if (e.key === 'r' || e.key === 'R') {
        if (s.sel.t === 'item') API.rot(id, e.shiftKey ? -90 : 90); else if (s.sel.t === 'wall') API.rotWall(id);
      }
    });
  }

  // ── floating context bar: what is selected, and what to do with it ──
  function ctxBar(p, lay) {
    var box = document.getElementById('lvCtx'); if (!box) return;
    var s = st(p.id), id = p.id;
    if (s.pop) { box.innerHTML = ''; return; }
    var o = function (act, label, cls) { return '<button class="lv-o' + (cls ? ' ' + cls : '') + '" onclick="LivingEdit.' + act + '">' + label + '</button>'; };
    var info = function (t, sub) { return '<div class="lv-info"><b>' + t + '</b>' + (sub ? '<br>' + sub : '') + '</div>'; };
    var edit = o('pop(' + id + ',\'ins\')', '\u270e');
    if (s.tool === 'wall') {
      box.innerHTML = info('\u270f\ufe0f ' + tt('שרטוט קיר', 'วาดผนัง', 'رسم جدار'),
          esc(tt('גרור, או הקש התחלה ואז סוף', 'ลาก หรือแตะจุดเริ่มแล้วจุดจบ', 'اسحب أو اضغط البداية ثم النهاية'))) +
        ['panel', 'block'].map(function (k) {
          return o('wallKind(' + id + ',\'' + k + '\')', k === 'block' ? tt('בלוק', 'บล็อก', 'بلوك') : tt('פאנל', 'แผง', 'لوح'), s.wallKind === k ? 'on' : '');
        }).join('') + o('tool(' + id + ')', '\u2713 ' + tt('סיום', 'เสร็จ', 'إنهاء'));
      return;
    }
    if (!s.sel) {
      box.innerHTML = s.view === 'plan'
        ? info(tt('הקש על קיר, חדר או פריט', 'แตะผนัง ห้อง หรือรายการ', 'اضغط جداراً أو غرفة أو عنصراً'),
               esc(tt('צביטה להגדלה · גרירה בשטח ריק להזזת התצוגה', 'บีบเพื่อซูม · ลากพื้นที่ว่างเพื่อเลื่อน', 'قرّب بإصبعين · اسحب الفراغ للتحريك')))
        : '';
      return;
    }
    if (s.sel.t === 'item') {
      var it = findItem(lay, s.sel.id); if (!it) { box.innerHTML = ''; return; }
      var dd = LivingUnit.itemDims(it), wallIt = LivingUnit.ITEMS[it.kind].wall;
      box.innerHTML = info(LivingUnit.itemSym(it.kind) + ' ' + esc(LivingUnit.itemLabel(it.kind)),
          wallIt ? n2(dd.w) + ' \u00d7 ' + n2(dd.h) + ' m' : n2(Math.max(dd.w, dd.d)) + ' \u00d7 ' + n2(Math.min(dd.w, dd.d)) + ' \u00d7 ' + n2(dd.h) + ' m') +
        o('rot(' + id + ',90)', '\u27f3') +
        ((it.kind === 'door' || it.kind === 'door_ext') ? o('flip(' + id + ')', '\u21c4') : '') +
        o('dup(' + id + ')', '\u29c9') + o('del(' + id + ')', '\ud83d\uddd1', 'dang') + edit;
      return;
    }
    if (s.sel.t === 'room') {
      var r = findRoom(lay, s.sel.id); if (!r) { box.innerHTML = ''; return; }
      box.innerHTML = info('\u25ad ' + esc(r.name || LivingUnit.roomLabel(r.type)),
          n2(Math.max(r.w, r.h)) + ' \u00d7 ' + n2(Math.min(r.w, r.h)) + ' m \u00b7 ' + n1(r.w * r.h) + ' m\u00b2') +
        o('split(' + id + ',0)', '\u2af4') + o('split(' + id + ',1)', '\u2550') +
        o('dupRoom(' + id + ')', '\u29c9') + o('delRoom(' + id + ')', '\ud83d\uddd1', 'dang') + edit;
      return;
    }
    if (s.sel.t === 'wall') {
      var w = findWall(lay, s.sel.id); if (!w) { box.innerHTML = ''; return; }
      box.innerHTML = info('\u2501 ' + tt('קיר מחיצה', 'ผนังกั้น', 'جدار فاصل'),
          n2(Math.hypot(w.x2 - w.x1, w.y2 - w.y1)) + ' m \u00b7 ' + (w.kind === 'block' ? tt('בלוק', 'บล็อก', 'بلوك') : tt('פאנל', 'แผง', 'لوح'))) +
        o('rotWall(' + id + ')', '\u27f3') + o('dupWall(' + id + ')', '\u29c9') + o('delWall(' + id + ')', '\ud83d\uddd1', 'dang') + edit;
      return;
    }
    if (s.sel.t === 'seg') {
      var si = LivingUnit.segInfo(p.living, s.sel.id); if (!si) { box.innerHTML = ''; return; }
      box.innerHTML = info('\u2501 ' + (si.seg.outer ? tt('קיר חוץ', 'ผนังภายนอก', 'جدار خارجي') : tt('קיר פנים', 'ผนังภายใน', 'جدار داخلي')),
          n2(si.len) + ' m \u00b7 ' + Math.round(si.t * 100) + ' cm \u00b7 ' + n2(si.H) + ' m \u00b7 ' + n2(si.net) + ' m\u00b2') + edit;
    }
  }

  // ── sheet: palette, layers, or the exact-values editor ──────────────
  function sheet(p) {
    var el = document.getElementById('lvSheet'); if (!el) return;
    var s = st(p.id);
    if (s.pop === 'ins' && !s.sel) s.pop = '';
    el.className = 'lv-sheet' + (s.pop ? ' on' : '');
    var t = document.getElementById('lvSheetT'), body = document.getElementById('lvSheetB'), ins = document.getElementById('lvIns');
    ins.style.display = s.pop === 'ins' ? '' : 'none';
    if (s.pop === 'ins') { t.textContent = tt('ערכים מדויקים', 'ค่าที่แม่นยำ', 'قيم دقيقة'); body.innerHTML = ''; inspector(p); return; }
    ins.innerHTML = '';
    if (s.pop === 'add') { t.textContent = tt('הוסף לתוכנית', 'เพิ่มลงในแผน', 'أضف إلى المخطط'); body.innerHTML = palette(p); return; }
    if (s.pop === 'layers') {
      t.textContent = tt('שכבות ותצוגה', 'เลเยอร์และมุมมอง', 'الطبقات والعرض');
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
          ? '<div class="lv-bar" style="margin-top:6px">' +
              chip('wires', '\u3030 ' + tt('תוואי כבלים', 'แนวสายไฟ', 'مسار الكابلات')) +
              chip('pipes', '\u3030 ' + tt('תוואי צנרת', 'แนวท่อ', 'مسار الأنابيب')) + '</div>'
          : '<div class="lv-bar" style="margin-top:6px">' +
              '<button class="lv-b' + (s.cut ? ' on' : '') + '" onclick="LivingEdit.cut(' + p.id + ')">\u2702 ' + tt('חתך קירות', 'ตัดผนัง', 'قطع الجدران') + '</button>' +
              ['morning', 'noon', 'evening'].map(function (k) {
                return '<button class="lv-b' + (s.sun === k ? ' on' : '') + '" onclick="LivingEdit.sun(' + p.id + ',\'' + k + '\')">' +
                  { morning: '\ud83c\udf05 ' + tt('בוקר', 'เช้า', 'صباح'), noon: '\u2600 ' + tt('צהריים', 'เที่ยง', 'ظهر'),
                    evening: '\ud83c\udf07 ' + tt('אחה"צ', 'บ่าย', 'عصر') }[k] + '</button>';
              }).join('') + '</div>');
      return;
    }
    t.textContent = ''; body.innerHTML = '';
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
      box.innerHTML = '<div class="lv-ins"><b>' + LivingUnit.itemSym(it.kind) + ' ' + esc(LivingUnit.itemLabel(it.kind)) + '</b>' +
        (room ? ' <span style="opacity:.7">\u00b7 ' + esc(room.name || LivingUnit.roomLabel(room.type)) + '</span>' : '') +
        itemDimsTable(it) +
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
    if (s.sel.t === 'seg') {
      var si = LivingUnit.segInfo(p.living, s.sel.id);
      if (!si) { s.sel = null; box.innerHTML = ''; return; }
      box.innerHTML = '<div class="lv-ins"><b>\u2501 ' + (si.seg.outer ? tt('קיר חוץ', 'ผนังภายนอก', 'جدار خارجي') : tt('קיר פנים', 'ผนังภายใน', 'جدار داخلي')) +
        '</b> <span style="opacity:.7">\u00b7 ' + (si.seg.outer ? tt('מעטפת', 'เปลือก', 'غلاف')
          : si.block ? tt('בלוק', 'บล็อก', 'بلوك') : tt('פאנל', 'แผง', 'لوح')) +
          (si.faces.some(Boolean) ? ' \u00b7 ' + tt('צד רטוב', 'ด้านเปียก', 'وجه رطب') : '') + '</span>' +
        dimsTable([[tt('אורך', 'ความยาว', 'الطول'), m(si.len)], [tt('עובי', 'ความหนา', 'السماكة'), cm(si.t)],
                   [tt('גובה', 'ความสูง', 'الارتفاع'), m(si.H)],
                   [tt('שטח ברוטו', 'พื้นที่รวม', 'المساحة الإجمالية'), m2(si.gross)],
                   [tt('שטח נטו (בניכוי פתחים)', 'พื้นที่สุทธิ', 'المساحة الصافية'), m2(si.net)]]) +
        (si.openings.length ? '<div class="lv-hint">' + si.openings.map(function (o) {
          return LivingUnit.itemSym(o.kind) + ' ' + esc(LivingUnit.itemLabel(o.kind)) + ' ' + n2(o.w) + '\u00d7' + n2(o.h);
        }).join(' \u00b7 ') + '</div>' : '') +
        '<div class="lv-hint">' + tt('קיר זה נוצר מגבולות החדרים — כדי לשנות אותו הזז או שנה את החדרים, או שרטט קיר חופשי.',
          'ผนังนี้มาจากขอบห้อง', 'هذا الجدار ناتج عن حدود الغرف') + '</div></div>';
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
      box.innerHTML = '<div class="lv-ins"><b>\u2501 ' + tt('קיר מחיצה', 'ผนังกั้น', 'جدار فاصل') + '</b> <span style="opacity:.7">\u00b7 ' +
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
            '<option value="panel"' + (fw.kind !== 'block' ? ' selected' : '') + '>' + tt('פאנל / גבס', 'แผง', 'لوح') + '</option>' +
            '<option value="block"' + (fw.kind === 'block' ? ' selected' : '') + '>' + tt('בלוק', 'บล็อก', 'بلوك') + '</option>' +
          '</select>' + lab(tt('אורך', 'ยาว', 'طول')) + winp('len', n2(len)) + '</div>' +
        '<div class="lv-row">' + lab(tt('התחלה', 'จุดเริ่ม', 'البداية') + ' X') + winp('x1', fw.x1) + lab('Y') + winp('y1', fw.y1) + '</div>' +
        '<div class="lv-hint">' + tt('גרור את הקיר להזזה · גרור נקודת קצה כדי להאריך, לקצר או לסובב',
          'ลากผนังเพื่อย้าย · ลากปลายเพื่อปรับ', 'اسحب الجدار للنقل · اسحب الطرف للتعديل') + '</div>' +
        '<div class="lv-row">' +
          '<button class="lv-b" onclick="LivingEdit.rotWall(' + id + ')">\u27f3 90\u00b0</button>' +
          '<button class="lv-b" onclick="LivingEdit.dupWall(' + id + ')">\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ') + '</button>' +
          '<button class="lv-b" onclick="LivingEdit.delWall(' + id + ')">\ud83d\uddd1 ' + tt('מחק', 'ลบ', 'حذف') + '</button>' +
        '</div></div>';
      return;
    }
    var r = findRoom(lay, s.sel.id);
    if (!r) { s.sel = null; box.innerHTML = ''; return; }
    box.innerHTML = '<div class="lv-ins"><b>\u25ad ' + esc(r.name || LivingUnit.roomLabel(r.type)) + '</b>' +
      dimsTable([[tt('אורך', 'ความยาว', 'الطول'), m(Math.max(r.w, r.h))], [tt('רוחב', 'ความกว้าง', 'العرض'), m(Math.min(r.w, r.h))],
                 [tt('שטח', 'พื้นที่', 'المساحة'), m2(r.w * r.h)], [tt('היקף', 'เส้นรอบรูป', 'المحيط'), m(2 * (r.w + r.h))]]) +
      '<div class="lv-row">' + lab(tt('שם', 'ชื่อ', 'الاسم')) +
        '<input class="bp-in wide" value="' + esc(r.name) + '" onchange="LivingEdit.setRoom(' + id + ',\'name\',this.value)">' +
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
      '<div class="lv-row">' +
        '<button class="lv-b" onclick="LivingEdit.split(' + id + ',0)">\u2af4 ' + tt('חלק לאורך', 'แบ่งตามยาว', 'قسّم طولياً') + '</button>' +
        '<button class="lv-b" onclick="LivingEdit.split(' + id + ',1)">\u2550 ' + tt('חלק לרוחב', 'แบ่งตามขวาง', 'قسّم عرضياً') + '</button>' +
        '<button class="lv-b" onclick="LivingEdit.dupRoom(' + id + ')">\u29c9 ' + tt('שכפל', 'ทำซ้ำ', 'نسخ') + '</button>' +
        '<button class="lv-b" onclick="LivingEdit.delRoom(' + id + ')">\ud83d\uddd1 ' + tt('מחק חדר', 'ลบห้อง', 'حذف الغرفة') + '</button>' +
      '</div></div>';
  }

  function m(v) { return n2(v).toFixed(2) + ' m'; }
  function cm(v) { return Math.round(v * 100) + ' cm'; }
  function m2(v) { return n2(v).toFixed(2) + ' m\u00b2'; }
  function dimsTable(rows) {
    return '<div style="display:grid;grid-template-columns:auto auto;gap:2px 14px;margin-top:6px;font-size:.84rem;">' +
      rows.map(function (r) { return '<span style="opacity:.7">' + r[0] + '</span><b>' + r[1] + '</b>'; }).join('') + '</div>';
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
        else if (g.indexOf('seg:') === 0) s.sel = { t: 'seg', id: g.slice(4) };
        else if (g.indexOf('room:') === 0) s.sel = { t: 'room', id: g.slice(5) };
        else s.sel = null;
        inspector(p);
      }
    });
    viewerFor = p.id;
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
    menu: function (id, act) {
      closeMenu();
      var go = {
        rotR: function () { API.rot(id, 90); }, rotL: function () { API.rot(id, -90); },
        flip: function () { API.flip(id); }, dup: function () { API.dup(id); }, del: function () { API.del(id); },
        splitL: function () { API.split(id, 0); }, splitW: function () { API.split(id, 1); },
        dupRoom: function () { API.dupRoom(id); }, delRoom: function () { API.delRoom(id); },
        rotWall: function () { API.rotWall(id); }, dupWall: function () { API.dupWall(id); }, delWall: function () { API.delWall(id); },
        edit: function () { var s = st(id); s.pop = ''; API.pop(id, 'ins'); }
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
    wallKind: function (id, k) { withP(id, function (p) { st(id).wallKind = k === 'block' ? 'block' : 'panel'; redraw(p); }); },
    setWall: function (id, k, v) {
      withP(id, function (p) {
        var s = st(id); if (!s.sel || s.sel.t !== 'wall') return;
        pushUndo(p);
        var lay = editable(p), w = findWall(lay, s.sel.id); if (!w) return;
        if (k === 'kind') w.kind = v === 'block' ? 'block' : 'panel';
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
