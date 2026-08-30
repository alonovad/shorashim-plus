/* sketch.js — לוח שרטוט (2D drafting canvas)
 * ------------------------------------------------------------------
 * A small drafting surface for the shapes the parametric shed model cannot
 * express: an L-shaped canopy, a lean-to against an existing wall, a bund
 * wall, a ramp with a turn in it. Draw it, dimension it, move it, delete it.
 *
 * EVERYTHING IS IN METRES. The world is metric and the view is a transform
 * over it, so a line is 6.40 m whether you are zoomed to the whole site or
 * to one corner. The alternative — storing pixels and converting on the way
 * out — is how a drawing ends up a different size than the number on it.
 *
 * SNAPPING, in priority order: existing vertices, then the grid, then
 * orthogonal from the previous point when Shift is held. Vertex snapping
 * comes first because two lines that merely look joined at one zoom level
 * are visibly apart at the next, and a quantity takeoff off an open
 * polygon is wrong in a way nobody notices.
 *
 * NUMERIC EDITING is the point of the whole thing. Select a segment and its
 * length and bearing become editable fields; typing 6.5 moves the far end
 * to exactly 6.5 m away along the current bearing, leaving the near end
 * pinned. Dragging is for exploring, typing is for deciding.
 *
 * UNDO is a snapshot stack — the shape count here is small enough that
 * copying the model is cheaper to write and safer than inverse operations.
 *
 * The module owns no persistence. buildplan.js hands it a model and gets
 * change notifications back.
 */
var Sketch = (function () {
  'use strict';

  var GRID = 0.25;          // m, snap increment
  var SNAP_PX = 12;         // pointer tolerance in screen px
  var MAX_UNDO = 40;

  var S = null;

  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function uid() { return Date.now() + Math.floor(Math.random() * 10000); }

  // ── model ──
  function blank() {
    return { shapes: [], nextId: 1 };
  }

  function normShape(sh) {
    return {
      id: sh.id || uid(),
      kind: (['line','rect','circle','poly'].indexOf(sh.kind) >= 0) ? sh.kind : 'line',
      pts: (sh.pts || []).map(function (p) { return { x: Number(p.x) || 0, y: Number(p.y) || 0 }; }),
      r: Number(sh.r) || 0,
      label: String(sh.label || '')
    };
  }

  function normalise(m) {
    var o = blank();
    if (m && Array.isArray(m.shapes)) o.shapes = m.shapes.map(normShape);
    return o;
  }

  // ── geometry ──
  function len(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
  function ang(a, b) { return Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI; }
  function polar(a, degrees, d) {
    var r = degrees * Math.PI / 180;
    return { x: a.x + Math.cos(r) * d, y: a.y + Math.sin(r) * d };
  }

  // Shoelace. Closed shapes only; an open polyline has no area and saying
  // so is better than reporting the area of its implied closure.
  function areaOf(sh) {
    if (sh.kind === 'circle') return Math.PI * sh.r * sh.r;
    if (sh.kind === 'rect') return Math.abs(sh.pts[1].x - sh.pts[0].x) * Math.abs(sh.pts[1].y - sh.pts[0].y);
    if (sh.kind !== 'poly' || sh.pts.length < 3) return 0;
    var a = 0;
    for (var i = 0; i < sh.pts.length; i++) {
      var j = (i + 1) % sh.pts.length;
      a += sh.pts[i].x * sh.pts[j].y - sh.pts[j].x * sh.pts[i].y;
    }
    return Math.abs(a / 2);
  }

  function perimOf(sh) {
    if (sh.kind === 'circle') return 2 * Math.PI * sh.r;
    if (sh.kind === 'rect') {
      return 2 * (Math.abs(sh.pts[1].x - sh.pts[0].x) + Math.abs(sh.pts[1].y - sh.pts[0].y));
    }
    var t = 0;
    for (var i = 0; i + 1 < sh.pts.length; i++) t += len(sh.pts[i], sh.pts[i+1]);
    if (sh.kind === 'poly' && sh.pts.length > 2) t += len(sh.pts[sh.pts.length-1], sh.pts[0]);
    return t;
  }

  // Rect and circle are stored by two defining points; corners derived.
  function corners(sh) {
    var a = sh.pts[0], b = sh.pts[1];
    return [{x:a.x,y:a.y},{x:b.x,y:a.y},{x:b.x,y:b.y},{x:a.x,y:b.y}];
  }

  function vertsOf(sh) {
    if (sh.kind === 'rect') return corners(sh);
    if (sh.kind === 'circle') return [sh.pts[0], { x: sh.pts[0].x + sh.r, y: sh.pts[0].y }];
    return sh.pts;
  }

  // ── view ──
  function w2s(p) { return { x: (p.x - S.ox) * S.sc + S.w/2, y: S.h/2 - (p.y - S.oy) * S.sc }; }
  function s2w(p) { return { x: (p.x - S.w/2) / S.sc + S.ox, y: (S.h/2 - p.y) / S.sc + S.oy }; }

  function snap(world, from) {
    // 1. existing vertices
    var best = null, bd = SNAP_PX / S.sc;
    S.m.shapes.forEach(function (sh) {
      if (sh.id === S.dragId) return;
      vertsOf(sh).forEach(function (v) {
        var d = Math.hypot(v.x - world.x, v.y - world.y);
        if (d < bd) { bd = d; best = { x: v.x, y: v.y }; }
      });
    });
    if (best) return best;
    // 2. orthogonal from the previous point
    if (S.ortho && from) {
      if (Math.abs(world.x - from.x) > Math.abs(world.y - from.y)) world = { x: world.x, y: from.y };
      else world = { x: from.x, y: world.y };
    }
    // 3. grid
    return { x: Math.round(world.x / GRID) * GRID, y: Math.round(world.y / GRID) * GRID };
  }

  // ── undo ──
  function push() {
    S.undo.push(JSON.stringify(S.m));
    if (S.undo.length > MAX_UNDO) S.undo.shift();
    S.redo = [];
  }
  function undo() {
    if (!S || !S.undo.length) return;
    S.redo.push(JSON.stringify(S.m));
    S.m = JSON.parse(S.undo.pop());
    S.sel = null;
    draw(); changed();
  }
  function redo() {
    if (!S || !S.redo.length) return;
    S.undo.push(JSON.stringify(S.m));
    S.m = JSON.parse(S.redo.pop());
    draw(); changed();
  }

  function changed() { if (S.onChange) S.onChange(S.m, summary()); }

  function summary() {
    var a = 0, p = 0;
    S.m.shapes.forEach(function (sh) { a += areaOf(sh); p += perimOf(sh); });
    return { shapes: S.m.shapes.length, area: a, perim: p,
             sel: S.sel ? byId(S.sel) : null };
  }

  function byId(id) {
    var hit = null;
    S.m.shapes.forEach(function (sh) { if (sh.id === id) hit = sh; });
    return hit;
  }

  // ── drawing ──
  function draw() {
    if (!S) return;
    var c = S.ctx, r = S.host.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    S.w = Math.max(240, r.width); S.h = Math.max(240, r.height);
    S.cv.width = S.w * dpr; S.cv.height = S.h * dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    c.fillStyle = '#f4f6f4';
    c.fillRect(0, 0, S.w, S.h);

    // grid, coarsened automatically so it never becomes a grey wash
    var step = GRID;
    while (step * S.sc < 9) step *= 4;
    var x0 = Math.floor((S.ox - S.w/2/S.sc) / step) * step;
    var x1 = S.ox + S.w/2/S.sc, y0 = Math.floor((S.oy - S.h/2/S.sc) / step) * step;
    var y1 = S.oy + S.h/2/S.sc;
    c.lineWidth = 1;
    for (var gx = x0; gx <= x1; gx += step) {
      var major = Math.abs(gx % (step * 4)) < 1e-6;
      c.strokeStyle = major ? 'rgba(45,106,79,.20)' : 'rgba(45,106,79,.07)';
      var sx = w2s({x:gx,y:0}).x;
      c.beginPath(); c.moveTo(sx, 0); c.lineTo(sx, S.h); c.stroke();
    }
    for (var gy = y0; gy <= y1; gy += step) {
      var major2 = Math.abs(gy % (step * 4)) < 1e-6;
      c.strokeStyle = major2 ? 'rgba(45,106,79,.20)' : 'rgba(45,106,79,.07)';
      var sy = w2s({x:0,y:gy}).y;
      c.beginPath(); c.moveTo(0, sy); c.lineTo(S.w, sy); c.stroke();
    }

    S.m.shapes.forEach(function (sh) { drawShape(c, sh, sh.id === S.sel); });
    if (S.pending) drawShape(c, S.pending, false, true);

    // scale bar — the drawing is metric and should say so at any zoom
    var barM = step * 4, barPx = barM * S.sc;
    c.strokeStyle = '#2d6a4f'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(14, S.h-16); c.lineTo(14+barPx, S.h-16); c.stroke();
    c.beginPath(); c.moveTo(14, S.h-20); c.lineTo(14, S.h-12);
    c.moveTo(14+barPx, S.h-20); c.lineTo(14+barPx, S.h-12); c.stroke();
    c.fillStyle = '#2d6a4f'; c.font = '700 11px Heebo,Arial,sans-serif'; c.textAlign = 'left';
    c.fillText(n2(barM) + ' m', 14, S.h-24);
  }

  function drawShape(c, sh, selected, ghost) {
    c.lineWidth = selected ? 3 : 2;
    c.strokeStyle = ghost ? 'rgba(45,106,79,.45)' : (selected ? '#ff9f43' : '#2d6a4f');
    c.fillStyle = selected ? 'rgba(255,159,67,.13)' : 'rgba(45,106,79,.09)';

    if (sh.kind === 'circle') {
      var ctr = w2s(sh.pts[0]);
      c.beginPath(); c.arc(ctr.x, ctr.y, sh.r * S.sc, 0, 6.2832);
      c.fill(); c.stroke();
    } else {
      var pts = (sh.kind === 'rect' ? corners(sh) : sh.pts).map(w2s);
      if (pts.length < 2) return;
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (var i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
      if (sh.kind === 'rect' || (sh.kind === 'poly' && pts.length > 2)) { c.closePath(); c.fill(); }
      c.stroke();
    }

    if (ghost) return;

    // Dimensions on every segment, always. A drawing without them is a
    // picture; the number is the reason the drawing exists.
    var vs = sh.kind === 'rect' ? corners(sh) : sh.pts;
    if (sh.kind === 'circle') {
      dimText(c, w2s({ x: sh.pts[0].x + sh.r/2, y: sh.pts[0].y }), 'R ' + n2(sh.r) + ' m');
    } else {
      var closed = (sh.kind === 'rect') || (sh.kind === 'poly' && vs.length > 2);
      var last = closed ? vs.length : vs.length - 1;
      for (var k = 0; k < last; k++) {
        var a = vs[k], b = vs[(k+1) % vs.length];
        var d = len(a, b);
        if (d * S.sc < 26) continue;
        dimText(c, w2s({ x: (a.x+b.x)/2, y: (a.y+b.y)/2 }), n2(d) + ' m');
      }
    }

    if (selected) {
      vertsOf(sh).forEach(function (v) {
        var p = w2s(v);
        c.fillStyle = '#ff9f43';
        c.strokeStyle = '#06120b'; c.lineWidth = 1.5;
        c.beginPath(); c.arc(p.x, p.y, 5, 0, 6.2832); c.fill(); c.stroke();
      });
      var ar = areaOf(sh);
      if (ar > 0) {
        var ctr2 = centroidOf(sh);
        dimText(c, w2s(ctr2), n2(ar) + ' \u05de"\u05e8', '#2d6a4f');
      }
    }
  }

  function centroidOf(sh) {
    var vs = sh.kind === 'rect' ? corners(sh) : (sh.kind === 'circle' ? [sh.pts[0]] : sh.pts);
    var x = 0, y = 0;
    vs.forEach(function (v) { x += v.x; y += v.y; });
    return { x: x / vs.length, y: y / vs.length };
  }

  function dimText(c, at, txt, bg) {
    c.font = '700 11px Heebo,Arial,sans-serif';
    c.textAlign = 'center';
    var w = c.measureText(txt).width + 8;
    c.fillStyle = bg || 'rgba(8,18,12,.85)';
    c.fillRect(at.x - w/2, at.y - 8, w, 15);
    c.fillStyle = '#ffd166';
    c.fillText(txt, at.x, at.y + 3);
  }

  // ── hit testing ──
  function hit(world) {
    var tol = SNAP_PX / S.sc, found = null;
    // topmost first
    for (var i = S.m.shapes.length - 1; i >= 0; i--) {
      var sh = S.m.shapes[i];
      if (sh.kind === 'circle') {
        if (Math.abs(len(sh.pts[0], world) - sh.r) < tol ||
            len(sh.pts[0], world) < sh.r) { found = sh.id; break; }
        continue;
      }
      var vs = sh.kind === 'rect' ? corners(sh) : sh.pts;
      var closed = (sh.kind === 'rect') || (sh.kind === 'poly' && vs.length > 2);
      var lim = closed ? vs.length : vs.length - 1;
      for (var k = 0; k < lim; k++) {
        if (distToSeg(world, vs[k], vs[(k+1) % vs.length]) < tol) { found = sh.id; break; }
      }
      if (found) break;
      if (closed && inPoly(world, vs)) { found = sh.id; break; }
    }
    return found;
  }

  function distToSeg(p, a, b) {
    var dx = b.x-a.x, dy = b.y-a.y, l2 = dx*dx+dy*dy;
    if (!l2) return len(p, a);
    var t = Math.max(0, Math.min(1, ((p.x-a.x)*dx + (p.y-a.y)*dy) / l2));
    return Math.hypot(p.x - (a.x+t*dx), p.y - (a.y+t*dy));
  }
  function inPoly(p, vs) {
    var ins = false;
    for (var i = 0, j = vs.length-1; i < vs.length; j = i++) {
      if (((vs[i].y > p.y) !== (vs[j].y > p.y)) &&
          (p.x < (vs[j].x-vs[i].x)*(p.y-vs[i].y)/(vs[j].y-vs[i].y)+vs[i].x)) ins = !ins;
    }
    return ins;
  }
  function vertexAt(sh, world) {
    var tol = SNAP_PX / S.sc, idx = -1;
    vertsOf(sh).forEach(function (v, i) { if (len(v, world) < tol) idx = i; });
    return idx;
  }

  // ── pointer ──
  function pos(e) {
    var r = S.cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function onDown(e) {
    if (!S) return;
    S.cv.setPointerCapture && S.cv.setPointerCapture(e.pointerId);
    var sp = pos(e), wp = s2w(sp);
    S.moved = 0;

    if (S.tool === 'pan' || e.button === 1) { S.drag = 'pan'; S.last = sp; return; }

    if (S.tool === 'select') {
      var id = hit(wp);
      if (id) {
        S.sel = id;
        var sh = byId(id);
        var vi = vertexAt(sh, wp);
        push();
        if (vi >= 0 && sh.kind !== 'circle') { S.drag = 'vertex'; S.vi = vi; S.dragId = id; }
        else if (vi === 1 && sh.kind === 'circle') { S.drag = 'radius'; S.dragId = id; }
        else { S.drag = 'move'; S.dragId = id; S.anchor = wp; }
      } else { S.sel = null; S.drag = 'pan'; S.last = sp; }
      draw(); changed();
      return;
    }

    // drawing tools
    var snapped = snap(wp, S.pending ? S.pending.pts[S.pending.pts.length-1] : null);
    if (S.tool === 'line' || S.tool === 'poly') {
      if (!S.pending) S.pending = normShape({ kind: S.tool === 'line' ? 'line' : 'poly', pts: [snapped, snapped] });
      else {
        S.pending.pts[S.pending.pts.length-1] = snapped;
        if (S.tool === 'line') { commit(); return; }
        S.pending.pts.push(snapped);
      }
    } else if (S.tool === 'rect' || S.tool === 'circle') {
      S.pending = normShape({ kind: S.tool, pts: [snapped, snapped] });
      S.drag = 'draw';
    }
    draw();
  }

  function onMove(e) {
    if (!S) return;
    var sp = pos(e), wp = s2w(sp);
    S.cursor = wp;

    if (S.drag === 'pan') {
      var d = { x: sp.x - S.last.x, y: sp.y - S.last.y };
      S.moved += Math.abs(d.x) + Math.abs(d.y);
      S.ox -= d.x / S.sc; S.oy += d.y / S.sc;
      S.last = sp; draw(); return;
    }
    if (S.drag === 'move') {
      var sh = byId(S.dragId);
      if (!sh) return;
      var dx = wp.x - S.anchor.x, dy = wp.y - S.anchor.y;
      sh.pts.forEach(function (p) { p.x += dx; p.y += dy; });
      S.anchor = wp; draw(); changed(); return;
    }
    if (S.drag === 'vertex') {
      var sh2 = byId(S.dragId);
      if (!sh2) return;
      var sn = snap(wp, null);
      if (sh2.kind === 'rect') {
        // a rect corner moves the two defining points, keeping it a rect
        var c0 = sh2.pts[0], c1 = sh2.pts[1];
        if (S.vi === 0) { c0.x = sn.x; c0.y = sn.y; }
        else if (S.vi === 1) { c1.x = sn.x; c0.y = sn.y; }
        else if (S.vi === 2) { c1.x = sn.x; c1.y = sn.y; }
        else { c0.x = sn.x; c1.y = sn.y; }
      } else { sh2.pts[S.vi] = sn; }
      draw(); changed(); return;
    }
    if (S.drag === 'radius') {
      var sh3 = byId(S.dragId);
      if (sh3) { sh3.r = Math.max(0.1, len(sh3.pts[0], wp)); draw(); changed(); }
      return;
    }
    if (S.drag === 'draw' && S.pending) {
      var sn2 = snap(wp, S.pending.pts[0]);
      if (S.pending.kind === 'circle') S.pending.r = Math.max(0.1, len(S.pending.pts[0], sn2));
      else S.pending.pts[1] = sn2;
      draw(); return;
    }
    if (S.pending && (S.tool === 'line' || S.tool === 'poly')) {
      S.pending.pts[S.pending.pts.length-1] = snap(wp, S.pending.pts[S.pending.pts.length-2]);
      draw();
    }
  }

  function onUp() {
    if (!S) return;
    if (S.drag === 'draw' && S.pending) commit();
    S.drag = null; S.dragId = null;
  }

  function commit() {
    if (!S.pending) return;
    var sh = S.pending;
    S.pending = null;
    // Reject zero-size shapes: a stray click should not leave an invisible
    // object in the model that later shows up in a quantity total.
    if (sh.kind === 'circle') { if (sh.r < 0.1) { draw(); return; } }
    else if (sh.pts.length < 2 || perimOf(sh) < 0.1) { draw(); return; }
    push();
    sh.id = uid();
    S.m.shapes.push(sh);
    S.sel = sh.id;
    draw(); changed();
  }

  function finishPoly() {
    if (S && S.pending && S.pending.kind === 'poly') {
      S.pending.pts.pop();          // drop the rubber-band point
      commit();
    }
  }

  function onWheel(e) {
    if (!S) return;
    e.preventDefault();
    var before = s2w(pos(e));
    S.sc = Math.max(2, Math.min(300, S.sc * (e.deltaY > 0 ? 0.88 : 1.14)));
    var after = s2w(pos(e));
    S.ox += before.x - after.x; S.oy += before.y - after.y;
    draw();
  }

  // ── public ops ──
  function setTool(t) {
    if (!S) return;
    if (S.pending && S.pending.kind === 'poly') finishPoly();
    S.pending = null; S.tool = t; draw();
  }
  function setOrtho(v) { if (S) S.ortho = !!v; }
  function del() {
    if (!S || !S.sel) return;
    push();
    S.m.shapes = S.m.shapes.filter(function (sh) { return sh.id !== S.sel; });
    S.sel = null; draw(); changed();
  }
  function clear() {
    if (!S) return;
    push(); S.m = blank(); S.sel = null; draw(); changed();
  }
  // Scale about the shape's own centroid, so a shape does not walk across
  // the sheet when it is resized.
  function scaleSel(f) {
    if (!S || !S.sel) return;
    var sh = byId(S.sel);
    if (!sh) return;
    push();
    var c = centroidOf(sh);
    sh.pts.forEach(function (p) { p.x = c.x + (p.x-c.x)*f; p.y = c.y + (p.y-c.y)*f; });
    if (sh.kind === 'circle') sh.r *= f;
    draw(); changed();
  }
  function rotateSel(deg) {
    if (!S || !S.sel) return;
    var sh = byId(S.sel);
    if (!sh || sh.kind === 'rect' || sh.kind === 'circle') return;   // axis-aligned by definition
    push();
    var c = centroidOf(sh), r = deg * Math.PI/180;
    sh.pts.forEach(function (p) {
      var dx = p.x-c.x, dy = p.y-c.y;
      p.x = c.x + dx*Math.cos(r) - dy*Math.sin(r);
      p.y = c.y + dx*Math.sin(r) + dy*Math.cos(r);
    });
    draw(); changed();
  }

  // Typed geometry. Segment index i of the selected shape is set to an
  // exact length and/or bearing; the near end stays put and everything
  // downstream of the far end moves with it, which is what "make this wall
  // 6.5 m" means on a drawing.
  function setSegment(i, length, angle) {
    if (!S || !S.sel) return false;
    var sh = byId(S.sel);
    if (!sh || sh.kind === 'circle') return false;
    push();
    if (sh.kind === 'rect') {
      var a = sh.pts[0], b = sh.pts[1];
      if (i % 2 === 0) b.x = a.x + (b.x >= a.x ? 1 : -1) * Math.abs(length);
      else b.y = a.y + (b.y >= a.y ? 1 : -1) * Math.abs(length);
      draw(); changed(); return true;
    }
    if (i + 1 > sh.pts.length) return false;
    var p0 = sh.pts[i], p1 = sh.pts[(i+1) % sh.pts.length];
    var d = (length != null && isFinite(length) && length > 0) ? length : len(p0, p1);
    var t = (angle != null && isFinite(angle)) ? angle : ang(p0, p1);
    var np = polar(p0, t, d);
    var dx = np.x - p1.x, dy = np.y - p1.y;
    for (var k = i+1; k < sh.pts.length; k++) { sh.pts[k].x += dx; sh.pts[k].y += dy; }
    draw(); changed(); return true;
  }

  function setCircle(r) {
    if (!S || !S.sel) return;
    var sh = byId(S.sel);
    if (!sh || sh.kind !== 'circle') return;
    push(); sh.r = Math.max(0.1, r); draw(); changed();
  }

  function fit() {
    if (!S || !S.m.shapes.length) { S.sc = 24; S.ox = 0; S.oy = 0; draw(); return; }
    var x0=1e9,x1=-1e9,y0=1e9,y1=-1e9;
    S.m.shapes.forEach(function (sh) {
      vertsOf(sh).forEach(function (v) {
        x0=Math.min(x0,v.x); x1=Math.max(x1,v.x); y0=Math.min(y0,v.y); y1=Math.max(y1,v.y);
      });
      if (sh.kind === 'circle') {
        x0=Math.min(x0,sh.pts[0].x-sh.r); x1=Math.max(x1,sh.pts[0].x+sh.r);
        y0=Math.min(y0,sh.pts[0].y-sh.r); y1=Math.max(y1,sh.pts[0].y+sh.r);
      }
    });
    S.ox = (x0+x1)/2; S.oy = (y0+y1)/2;
    S.sc = Math.max(2, Math.min(200,
      Math.min(S.w / Math.max(1, x1-x0+4), S.h / Math.max(1, y1-y0+4))));
    draw();
  }

  function selection() {
    if (!S || !S.sel) return null;
    var sh = byId(S.sel);
    if (!sh) return null;
    var segs = [];
    if (sh.kind !== 'circle') {
      var vs = sh.kind === 'rect' ? corners(sh) : sh.pts;
      var closed = (sh.kind === 'rect') || (sh.kind === 'poly' && vs.length > 2);
      var lim = closed ? vs.length : vs.length - 1;
      for (var k = 0; k < lim; k++) {
        segs.push({ i: k, len: len(vs[k], vs[(k+1)%vs.length]), ang: ang(vs[k], vs[(k+1)%vs.length]) });
      }
    }
    return { id: sh.id, kind: sh.kind, r: sh.r, segs: segs,
             area: areaOf(sh), perim: perimOf(sh) };
  }

  // ── lifecycle ──
  function mount(host, model, opts) {
    destroy();
    opts = opts || {};
    var cv = document.createElement('canvas');
    cv.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:crosshair;';
    host.innerHTML = '';
    host.appendChild(cv);
    S = {
      host: host, cv: cv, ctx: cv.getContext('2d'),
      m: normalise(model), sc: 24, ox: 0, oy: 0, w: 600, h: 400,
      tool: 'select', ortho: false, sel: null, pending: null,
      drag: null, dragId: null, vi: -1, anchor: null, last: null, moved: 0,
      undo: [], redo: [], onChange: opts.onChange || null
    };
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp);
    cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('dblclick', finishPoly);
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); finishPoly(); });
    if (window.ResizeObserver) { S.ro = new ResizeObserver(draw); S.ro.observe(host); }
    fit();
    changed();
    return true;
  }

  function destroy() {
    if (!S) return;
    if (S.ro) S.ro.disconnect();
    S.host.innerHTML = '';
    S = null;
  }

  function get() { return S ? JSON.parse(JSON.stringify(S.m)) : null; }
  function active() { return !!S; }

  return {
    mount: mount, destroy: destroy, get: get, active: active,
    setTool: setTool, setOrtho: setOrtho, del: del, clear: clear,
    scaleSel: scaleSel, rotateSel: rotateSel, setSegment: setSegment,
    setCircle: setCircle, fit: fit, undo: undo, redo: redo,
    selection: selection, summary: summary, finishPoly: finishPoly,
    areaOf: areaOf, perimOf: perimOf
  };
})();
