/* geoedit.js — עורך גיאומטריה על המפה (interactive footprint editor)
 * ------------------------------------------------------------------
 * Drawing a footprint by clicking corner after corner is fine for tracing
 * something that already exists on the ground, and hopeless for laying out
 * a shed you have not built yet. This adds the two things that make that
 * possible:
 *
 *   1. DRAG A RECTANGLE. Press, drag, release. The two side lengths are
 *      labelled in metres on the axes the whole time it is being dragged,
 *      so the size is visible while the hand is still moving rather than
 *      after the fact.
 *
 *   2. TRANSFORM IT AFTERWARDS. A move handle at the centre, a rotate
 *      handle on a stalk, and corner handles for resize. Plus three number
 *      fields — width, length, rotation — that apply live, so "20 x 20 at
 *      35 degrees" is typed, not approximated by dragging.
 *
 * WHY A RECTANGLE IS STORED AS centre + w + h + rot
 *   Four independent corners cannot be rotated or resized without drifting
 *   out of square. Keeping the parametric form and deriving the corners on
 *   demand means every operation is exact and reversible, and the printed
 *   dimension is the dimension that was entered — not the one that survived
 *   four rounds of floating-point corner arithmetic.
 *
 * All offsets are geodesic (great-circle destination from a bearing and a
 * distance), so a 20 m side is 20 m on the ground, not 20 m on a flattened
 * approximation that drifts with latitude.
 *
 * The module owns no data. It reports the finished ring to a callback;
 * buildplan.js decides what to do with it.
 */
var GeoEdit = (function () {
  'use strict';

  var R = 6378137;
  var S = null;              // active session

  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }

  // ── geodesy ──
  function destination(from, brgDeg, distM) {
    var d = distM / R, b = brgDeg * Math.PI / 180;
    var la1 = from.lat * Math.PI / 180, lo1 = from.lng * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(b));
    var lo2 = lo1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la1),
                               Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return L.latLng(la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI) + 540) % 360 - 180);
  }
  function bearing(a, b) {
    var la1 = a.lat * Math.PI / 180, la2 = b.lat * Math.PI / 180;
    var dl = (b.lng - a.lng) * Math.PI / 180;
    return (Math.atan2(Math.sin(dl) * Math.cos(la2),
      Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dl)) * 180 / Math.PI + 360) % 360;
  }
  function dist(a, b) { return S.map.distance(a, b); }

  function area(ring) {
    if (!ring || ring.length < 3) return 0;
    var a = 0;
    for (var i = 0; i < ring.length; i++) {
      var j = (i + 1) % ring.length;
      var xi = ring[i].lng * Math.PI / 180, yi = ring[i].lat * Math.PI / 180;
      var xj = ring[j].lng * Math.PI / 180, yj = ring[j].lat * Math.PI / 180;
      a += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
    }
    return Math.abs(a * R * R / 2);
  }

  function centroid(ring) {
    var la = 0, lo = 0;
    ring.forEach(function (p) { la += p.lat; lo += p.lng; });
    return L.latLng(la / ring.length, lo / ring.length);
  }

  // centre + width + length + rotation → four corners, always square
  function rectRing(c, w, h, rot) {
    var hw = w / 2, hh = h / 2;
    var diag = Math.sqrt(hw * hw + hh * hh);
    var a = Math.atan2(hw, hh) * 180 / Math.PI;
    return [
      destination(c, rot + a,       diag),
      destination(c, rot + 180 - a, diag),
      destination(c, rot + 180 + a, diag),
      destination(c, rot - a,       diag)
    ];
  }

  function ring() {
    return S.kind === 'rect' ? rectRing(S.c, S.w, S.h, S.rot) : S.pts;
  }

  // ── rendering ──
  function clearLayers() {
    (S.gfx || []).forEach(function (l) { try { S.map.removeLayer(l); } catch (e) {} });
    S.gfx = [];
  }

  function label(at, text, tone) {
    return L.marker(at, {
      interactive: false,
      icon: L.divIcon({ className: '', iconSize: [0, 0], html:
        '<div style="transform:translate(-50%,-50%);background:rgba(8,18,12,.92);color:' +
        (tone || '#ffd166') + ';padding:2px 8px;border-radius:8px;white-space:nowrap;' +
        'font:800 12px/1.3 Heebo,Arial,sans-serif;border:1px solid rgba(255,255,255,.2);">' +
        text + '</div>' })
    });
  }

  function handle(at, kind) {
    var col = kind === 'move' ? '#2ecc71' : kind === 'rot' ? '#ffd166' : '#ff9f43';
    var sz  = kind === 'corner' ? 11 : 15;
    var glyph = kind === 'move' ? '\u2725' : kind === 'rot' ? '\u21bb' : '';
    return L.marker(at, {
      draggable: false,
      icon: L.divIcon({ className: '', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2], html:
        '<div data-h="' + kind + '" style="width:' + sz + 'px;height:' + sz + 'px;border-radius:50%;' +
        'background:' + col + ';border:2px solid #06120b;cursor:' +
        (kind === 'move' ? 'move' : kind === 'rot' ? 'grab' : 'nwse-resize') + ';' +
        'display:flex;align-items:center;justify-content:center;font-size:10px;color:#06120b;' +
        'box-shadow:0 1px 4px rgba(0,0,0,.5);">' + glyph + '</div>' })
    });
  }

  function redraw() {
    if (!S) return;
    clearLayers();
    var r = ring();
    if (r.length < 3) return;

    var poly = L.polygon(r, { color: '#ff9f43', weight: 2, fillColor: '#ff9f43', fillOpacity: 0.22 });
    poly.addTo(S.map); S.gfx.push(poly);

    // Edge lengths, always on. This is the number the user is trying to hit.
    for (var i = 0; i < r.length; i++) {
      var a = r[i], b = r[(i + 1) % r.length];
      var mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
      var lb = label(mid, n1(dist(a, b)) + ' m');
      lb.addTo(S.map); S.gfx.push(lb);
    }

    var c = S.kind === 'rect' ? S.c : centroid(r);
    var ar = area(r);
    var cl = label(c, n1(ar) + ' \u05de"\u05e8' +
      (ar >= 1000 ? '  \u00b7  ' + (ar / 1000).toFixed(2) + ' \u05d3\u05d5\u05e0\u05dd' : ''), '#a8e6a1');
    cl.addTo(S.map); S.gfx.push(cl);

    if (!S.dragging) {
      var mh = handle(c, 'move'); mh.addTo(S.map); S.gfx.push(mh); S.hMove = mh;
      // rotate handle on a stalk clear of the shape
      var reach = S.kind === 'rect' ? S.h / 2 + 12 : Math.sqrt(ar) * 0.75 + 12;
      var rp = destination(c, S.rot || 0, reach);
      var stalk = L.polyline([c, rp], { color: '#ffd166', weight: 1.5, dashArray: '4,4' });
      stalk.addTo(S.map); S.gfx.push(stalk);
      var rh = handle(rp, 'rot'); rh.addTo(S.map); S.gfx.push(rh); S.hRot = rh;
      if (S.kind === 'rect') {
        S.hCorner = [];
        r.forEach(function (cp, ix) {
          var ch = handle(cp, 'corner'); ch.addTo(S.map); S.gfx.push(ch);
          ch._ix = ix; S.hCorner.push(ch);
        });
      }
    }
    if (S.onChange) S.onChange(readout());
  }

  function readout() {
    var r = ring();
    return { kind: S.kind, w: S.w, h: S.h, rot: S.rot, area: area(r), ring: r,
             pts: r.map(function (p) { return { lat: p.lat, lng: p.lng }; }) };
  }

  // ── pointer plumbing ──
  // Leaflet's own drag has to be suspended for the duration, or the map
  // slides out from under the shape being edited.
  function lockMap(on) {
    if (!S || !S.map.dragging) return;
    if (on) S.map.dragging.disable(); else S.map.dragging.enable();
  }

  function nearest(latlng, markers, px) {
    var best = null, bd = px || 18;
    var p0 = S.map.latLngToContainerPoint(latlng);
    (markers || []).forEach(function (mk) {
      if (!mk) return;
      var d = p0.distanceTo(S.map.latLngToContainerPoint(mk.getLatLng()));
      if (d < bd) { bd = d; best = mk; }
    });
    return best;
  }

  function onDown(e) {
    if (!S) return;
    if (S.mode === 'draw') {
      S.dragging = 'draw';
      S.anchor = e.latlng;
      lockMap(true);
      return;
    }
    var mk = nearest(e.latlng, [S.hMove], 20);
    if (mk) { S.dragging = 'move'; lockMap(true); return; }
    mk = nearest(e.latlng, [S.hRot], 20);
    if (mk) { S.dragging = 'rot'; lockMap(true); return; }
    if (S.kind === 'rect') {
      mk = nearest(e.latlng, S.hCorner, 18);
      if (mk) { S.dragging = 'corner'; S.corner = mk._ix; lockMap(true); return; }
    }
  }

  function onMove(e) {
    if (!S || !S.dragging) return;
    var p = e.latlng;

    if (S.dragging === 'draw') {
      // Width and length are measured along the CURRENT rotation axes, so a
      // rotated drawing frame still produces a square-cornered rectangle.
      var brg = bearing(S.anchor, p), d = dist(S.anchor, p);
      var rel = (brg - S.rot) * Math.PI / 180;
      var along = Math.abs(d * Math.cos(rel));
      var across = Math.abs(d * Math.sin(rel));
      S.h = Math.max(0.5, along);
      S.w = Math.max(0.5, across);
      // grow from the anchored corner, not from the centre
      var half = Math.sqrt((S.w / 2) * (S.w / 2) + (S.h / 2) * (S.h / 2));
      var a2 = Math.atan2(S.w / 2, S.h / 2) * 180 / Math.PI;
      var quadrant = (Math.cos(rel) >= 0 ? 1 : -1);
      var side = (Math.sin(rel) >= 0 ? 1 : -1);
      S.c = destination(S.anchor, S.rot + (quadrant > 0 ? 1 : -1) * (side > 0 ? a2 : -a2) +
                        (quadrant > 0 ? 0 : 180), half);
      S.kind = 'rect';
      redraw();
      return;
    }

    if (S.dragging === 'move') {
      var c0 = S.kind === 'rect' ? S.c : centroid(S.pts);
      var b = bearing(c0, p), d2 = dist(c0, p);
      if (S.kind === 'rect') S.c = destination(S.c, b, d2);
      else S.pts = S.pts.map(function (q) { return destination(q, b, d2); });
      redraw();
      return;
    }

    if (S.dragging === 'rot') {
      var cc = S.kind === 'rect' ? S.c : centroid(S.pts);
      var nb = bearing(cc, p);
      if (S.kind === 'rect') S.rot = nb;
      else {
        var delta = nb - (S.rot || 0);
        S.pts = S.pts.map(function (q) {
          return destination(cc, bearing(cc, q) + delta, dist(cc, q));
        });
        S.rot = nb;
      }
      redraw();
      return;
    }

    if (S.dragging === 'corner' && S.kind === 'rect') {
      // The opposite corner is pinned; the dragged one sets both sides.
      var r0 = rectRing(S.c, S.w, S.h, S.rot);
      var opp = r0[(S.corner + 2) % 4];
      var b3 = bearing(opp, p), d3 = dist(opp, p);
      var rel3 = (b3 - S.rot) * Math.PI / 180;
      S.h = Math.max(0.5, Math.abs(d3 * Math.cos(rel3)));
      S.w = Math.max(0.5, Math.abs(d3 * Math.sin(rel3)));
      var half3 = Math.sqrt((S.w / 2) * (S.w / 2) + (S.h / 2) * (S.h / 2));
      S.c = destination(opp, bearing(opp, p), half3);
      redraw();
    }
  }

  function onUp() {
    if (!S || !S.dragging) return;
    var was = S.dragging;
    S.dragging = null;
    lockMap(false);
    if (was === 'draw') S.mode = 'edit';
    redraw();
  }

  // ── public ──
  function start(mapObj, opts) {
    stop();
    S = {
      map: mapObj, gfx: [], kind: null, mode: opts.mode || 'draw',
      c: null, w: 20, h: 20, rot: Number(opts.rot) || 0,
      pts: null, dragging: null, onChange: opts.onChange || null
    };
    if (opts.pts && opts.pts.length >= 3) {
      S.mode = 'edit';
      if (opts.rect) { S.kind = 'rect'; S.c = L.latLng(opts.rect.lat, opts.rect.lng);
                       S.w = opts.rect.w; S.h = opts.rect.h; S.rot = opts.rect.rot || 0; }
      else { S.kind = 'poly'; S.pts = opts.pts.map(function (p) { return L.latLng(p.lat, p.lng); }); }
      redraw();
    }
    mapObj.on('mousedown', onDown);
    mapObj.on('mousemove', onMove);
    mapObj.on('mouseup', onUp);
    return true;
  }

  function stop() {
    if (!S) return;
    lockMap(false);
    clearLayers();
    S.map.off('mousedown', onDown);
    S.map.off('mousemove', onMove);
    S.map.off('mouseup', onUp);
    S = null;
  }

  // Typed dimensions apply live and exactly — this is the path that makes
  // "20 x 20, rotated 35" achievable instead of approximated.
  function setDims(w, h, rot) {
    if (!S) return;
    if (S.kind !== 'rect') {
      // rotate-only for a traced shape; w/h are meaningless there
      if (rot != null && isFinite(rot)) {
        var cc = centroid(S.pts), delta = rot - (S.rot || 0);
        S.pts = S.pts.map(function (q) {
          return destination(cc, bearing(cc, q) + delta, dist(cc, q));
        });
        S.rot = rot;
        redraw();
      }
      return;
    }
    if (w != null && isFinite(w) && w > 0) S.w = w;
    if (h != null && isFinite(h) && h > 0) S.h = h;
    if (rot != null && isFinite(rot)) S.rot = ((rot % 360) + 360) % 360;
    if (!S.c) return;
    redraw();
  }

  function setMode(mode) { if (S) { S.mode = mode; redraw(); } }
  function get() { return S ? readout() : null; }
  function active() { return !!S; }
  function nudgeRot(deg) { if (S) setDims(null, null, (S.rot || 0) + deg); }

  return { start: start, stop: stop, setDims: setDims, setMode: setMode,
           get: get, active: active, nudgeRot: nudgeRot,
           destination: destination, bearing: bearing, area: area };
})();
