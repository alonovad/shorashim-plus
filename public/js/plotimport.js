/* plotimport.js — ייבוא חלקות מתמונה או מקובץ (plot import)
 * ------------------------------------------------------------------
 * Drawing every plot vertex by vertex is the slow part of setting up a
 * farm. This adds a third way in, next to "new plot" on the map's + button:
 *
 *   1. FROM AN IMAGE. A satellite screenshot, a printed map, a hand sketch.
 *      The image is laid over the map, half transparent, and aligned with
 *      four handles: move, rotate + scale, stretch sideways, stretch up.
 *      Then either
 *        - press "detect" and the plotDetect Cloud Function returns outlines
 *          in image pixels, or
 *        - close the panel and trace with the ordinary "new plot" tool over
 *          the image.
 *      Outlines live in IMAGE PIXELS and are projected through the current
 *      alignment, so moving the image after detection moves them with it.
 *
 *   2. FROM A FILE. KML / KMZ (Google Earth, My Maps) or GeoJSON. GeoJSON in
 *      the Israeli grid (ITM, EPSG:2039 — what GovMap exports) is converted
 *      to WGS84 with the full datum shift; without it plots land ~70 m off.
 *
 * Either way the result is a list of DRAFTS: dashed outlines on the map,
 * each with a name, a keep/skip box and a vertex editor (drag a vertex,
 * tap a vertex to remove it, tap a midpoint to add one). A draft whose
 * centre falls inside an existing plot is flagged and unticked. One farm
 * (and optionally a crop) is picked for the batch, and the ticked drafts
 * become ordinary plots through MapAccess.addImportedPlots — this module
 * never touches the plots array or saveData itself.
 *
 * Cost: the model is called only on an explicit press, and the answer is
 * cached in this browser per image + model + hint.
 */
var PlotImport = (function () {
  'use strict';

  var MAX_SIDE = 1568;                 // long side the vision models read natively
  var DETECT_CACHE = 'shorashim-plot-detect-cache';   // localStorage only
  var MPD = 111320;                    // metres per degree of latitude
  var DRAFT_COLOR = '#ff6f00';
  var S = null;                        // session

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function isRtl() {
    return (typeof currentLang === 'undefined') || currentLang !== 'th';
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function canImport() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }
  function getMap() {
    return (window.MapAccess && typeof MapAccess.getMap === 'function') ? MapAccess.getMap() : null;
  }

  // ── Image ⇄ ground transform ────────────────────────────────────────
  // T = { lat, lng, sx, sy, rot }: image centre on the ground, metres per
  // pixel along the image's x and y, rotation (radians, counter-clockwise
  // from east). Local flat-earth metres: exact enough across a farm.
  function px2ll(T, x, y, w, h) {
    var dx = (x - w / 2) * T.sx, dy = -(y - h / 2) * T.sy;
    var c = Math.cos(T.rot), s = Math.sin(T.rot);
    var e = dx * c - dy * s, n = dx * s + dy * c;
    return { lat: T.lat + n / MPD, lng: T.lng + e / (MPD * Math.cos(T.lat * Math.PI / 180)) };
  }
  function ll2px(T, ll, w, h) {
    var n = (ll.lat - T.lat) * MPD;
    var e = (ll.lng - T.lng) * MPD * Math.cos(T.lat * Math.PI / 180);
    var c = Math.cos(T.rot), s = Math.sin(T.rot);
    var dx = e * c + n * s, dy = -e * s + n * c;
    return { x: dx / T.sx + w / 2, y: -dy / T.sy + h / 2 };
  }
  function metresFrom(o, ll) {
    return {
      e: (ll.lng - o.lng) * MPD * Math.cos(o.lat * Math.PI / 180),
      n: (ll.lat - o.lat) * MPD
    };
  }

  // ── Israeli grid (ITM, EPSG:2039) → WGS84 ───────────────────────────
  // Inverse transverse Mercator on GRS80, then the Israel 1993 → WGS84
  // seven-parameter shift (position-vector convention).
  var ITM = { lat0: 31.7343936111111, lon0: 35.2045169444444, k0: 1.0000067,
              x0: 219529.584, y0: 626907.39 };
  function looksItm(x, y) {
    return x > 100000 && x < 300000 && y > 350000 && y < 1400000;
  }
  function itmToWgs(x, y) {
    var a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), ep2 = e2 / (1 - e2);
    var d2r = Math.PI / 180, k0 = ITM.k0;
    function mArc(phi) {
      return a * ((1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256) * phi -
        (3 * e2 / 8 + 3 * e2 * e2 / 32 + 45 * e2 * e2 * e2 / 1024) * Math.sin(2 * phi) +
        (15 * e2 * e2 / 256 + 45 * e2 * e2 * e2 / 1024) * Math.sin(4 * phi) -
        (35 * e2 * e2 * e2 / 3072) * Math.sin(6 * phi));
    }
    var M = mArc(ITM.lat0 * d2r) + (y - ITM.y0) / k0;
    var mu = M / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 * e2 * e2 / 256));
    var e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
    var phi1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) +
      (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) +
      (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) +
      (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var s1 = Math.sin(phi1), c1 = Math.cos(phi1), t1 = Math.tan(phi1);
    var C1 = ep2 * c1 * c1, T1 = t1 * t1;
    var N1 = a / Math.sqrt(1 - e2 * s1 * s1);
    var R1 = a * (1 - e2) / Math.pow(1 - e2 * s1 * s1, 1.5);
    var D = (x - ITM.x0) / (N1 * k0);
    var lat = phi1 - (N1 * t1 / R1) * (D * D / 2 -
      (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * Math.pow(D, 4) / 24 +
      (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    var lon = ITM.lon0 * d2r + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 +
      (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / c1;
    // geodetic (GRS80) → ECEF
    var sl = Math.sin(lat), N = a / Math.sqrt(1 - e2 * sl * sl);
    var X = N * Math.cos(lat) * Math.cos(lon), Y = N * Math.cos(lat) * Math.sin(lon), Z = N * (1 - e2) * sl;
    // Helmert, position vector: -24.0024 -17.1032 -17.8444 m,
    // -0.33077 -1.85269 1.66969 arcsec, 5.4248 ppm
    var as = Math.PI / (180 * 3600);
    var rx = -0.33077 * as, ry = -1.85269 * as, rz = 1.66969 * as, sc = 1 + 5.4248e-6;
    var X2 = -24.0024 + sc * (X - rz * Y + ry * Z);
    var Y2 = -17.1032 + sc * (rz * X + Y - rx * Z);
    var Z2 = -17.8444 + sc * (-ry * X + rx * Y + Z);
    // ECEF → geodetic (WGS84), a few fixed-point rounds
    var fw = 1 / 298.257223563, e2w = fw * (2 - fw);
    var p = Math.sqrt(X2 * X2 + Y2 * Y2), lat2 = Math.atan2(Z2, p * (1 - e2w));
    for (var i = 0; i < 6; i++) {
      var sn = Math.sin(lat2), Nw = a / Math.sqrt(1 - e2w * sn * sn);
      lat2 = Math.atan2(Z2 + e2w * Nw * sn, p);
    }
    return { lat: lat2 / d2r, lng: Math.atan2(Y2, X2) / d2r };
  }

  // ── Geometry helpers ────────────────────────────────────────────────
  function ringAreaDunam(ring) {
    if (!ring || ring.length < 3) return 0;
    if (window.MapAccess && typeof MapAccess.areaFromLatLngs === 'function') {
      return MapAccess.areaFromLatLngs(ring) / 1000;
    }
    return 0;
  }
  function centroid(ring) {
    var la = 0, ln = 0;
    ring.forEach(function (c) { la += c.lat; ln += c.lng; });
    return { lat: la / ring.length, lng: ln / ring.length };
  }
  function pointInRing(pt, ring) {
    var inside = false;
    for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      var yi = ring[i].lat, xi = ring[i].lng, yj = ring[j].lat, xj = ring[j].lng;
      if (((yi > pt.lat) !== (yj > pt.lat)) &&
          (pt.lng < (xj - xi) * (pt.lat - yi) / ((yj - yi) || 1e-12) + xi)) inside = !inside;
    }
    return inside;
  }
  // Douglas–Peucker in local metres. Files from GovMap can carry thousands
  // of vertices per plot; every plot lives in one Firestore document.
  function simplifyRing(ring, tolM) {
    if (ring.length <= 8) return ring;
    var o = ring[0];
    var pts = ring.map(function (c) { var m = metresFrom(o, c); return { x: m.e, y: m.n, c: c }; });
    function segDist(p, a, b) {
      var dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
      var t = L2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
      var qx = a.x + t * dx - p.x, qy = a.y + t * dy - p.y;
      return Math.sqrt(qx * qx + qy * qy);
    }
    function dp(lo, hi, keep) {
      var maxD = 0, idx = -1;
      for (var i = lo + 1; i < hi; i++) {
        var d = segDist(pts[i], pts[lo], pts[hi]);
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tolM && idx > 0) { keep[idx] = true; dp(lo, idx, keep); dp(idx, hi, keep); }
    }
    // split at the vertex farthest from the first, so the closed ring
    // is simplified as two open chains
    var far = 0, fd = -1;
    pts.forEach(function (p, i) { var d = p.x * p.x + p.y * p.y; if (d > fd) { fd = d; far = i; } });
    var keep = {}; keep[0] = true; keep[far] = true;
    dp(0, far, keep);
    pts.push(pts[0]);
    dp(far, pts.length - 1, keep);
    pts.pop();
    var out = pts.filter(function (p, i) { return keep[i]; }).map(function (p) { return p.c; });
    return out.length >= 3 ? out : ring;
  }
  function tidyRing(ring) {
    var r = ring.slice();
    if (r.length > 3) {
      var a = r[0], b = r[r.length - 1];
      if (Math.abs(a.lat - b.lat) < 1e-9 && Math.abs(a.lng - b.lng) < 1e-9) r.pop();
    }
    var tol = 0.5;
    var s = simplifyRing(r, tol);
    while (s.length > 150 && tol < 20) { tol *= 2; s = simplifyRing(r, tol); }
    return s;
  }

  // ── Drafts ──────────────────────────────────────────────────────────
  function draftLL(d) {
    if (d.px && S && S.img) {
      var I = S.img;
      return d.px.map(function (p) { return px2ll(S.T, p.x, p.y, I.w, I.h); });
    }
    return d.ll || [];
  }
  function flagOverlaps() {
    var existing = (window.MapAccess && MapAccess.listPlotsWithRings) ? MapAccess.listPlotsWithRings() : [];
    S.drafts.forEach(function (d) {
      var c = centroid(draftLL(d));
      d.overlaps = '';
      existing.some(function (p) {
        return (p.rings || []).some(function (r) {
          if (r && r.length >= 3 && pointInRing(c, r)) { d.overlaps = p.name || '?'; return true; }
          return false;
        });
      });
      if (d.overlaps) d.include = false;
    });
  }
  function addDrafts(list) {
    var n0 = S.drafts.length;
    list.forEach(function (d, i) {
      d.name = String(d.name || '').trim() || (tt('חלקה', 'แปลง', 'قطعة') + ' ' + (n0 + i + 1));
      d.include = true;
      S.drafts.push(d);
    });
    flagOverlaps();
    drawDrafts();
  }

  // ── Map layers ──────────────────────────────────────────────────────
  function ensurePane(m) {
    if (!m.getPane('plotImportPane')) {
      var p = m.createPane('plotImportPane');
      p.style.zIndex = 390;             // under plot polygons (400), over tiles
      p.style.pointerEvents = 'none';
    }
    return m.getPane('plotImportPane');
  }
  function placeImage() {
    var m = getMap(); if (!m || !S || !S.img || !S.imgEl) return;
    var I = S.img;
    var p0 = m.latLngToLayerPoint(px2ll(S.T, 0, 0, I.w, I.h));
    var p1 = m.latLngToLayerPoint(px2ll(S.T, I.w, 0, I.w, I.h));
    var p2 = m.latLngToLayerPoint(px2ll(S.T, 0, I.h, I.w, I.h));
    S.imgEl.style.transform = 'matrix(' +
      [(p1.x - p0.x) / I.w, (p1.y - p0.y) / I.w, (p2.x - p0.x) / I.h, (p2.y - p0.y) / I.h, p0.x, p0.y]
        .map(function (v) { return v.toFixed(6); }).join(',') + ')';
    S.imgEl.style.opacity = S.imgHidden ? 0 : S.opacity;
  }
  function onZoomStart() { if (S && S.imgEl) S.imgEl.style.visibility = 'hidden'; }
  function onZoomEnd() {
    if (S && S.imgEl) { placeImage(); S.imgEl.style.visibility = 'visible'; }
  }
  function handleIcon(sym, cls) {
    return L.divIcon({ className: 'pi-h ' + (cls || ''), html: '<div>' + sym + '</div>',
                       iconSize: [30, 30], iconAnchor: [15, 15] });
  }
  function handleSpots() {
    var I = S.img, T = S.T;
    return {
      move: px2ll(T, I.w / 2, I.h / 2, I.w, I.h),
      rot: px2ll(T, I.w, 0, I.w, I.h),
      sx: px2ll(T, I.w, I.h / 2, I.w, I.h),
      sy: px2ll(T, I.w / 2, 0, I.w, I.h)
    };
  }
  function syncHandles(skip) {
    if (!S || !S.handles) return;
    var spots = handleSpots();
    Object.keys(S.handles).forEach(function (k) {
      if (k !== skip) S.handles[k].setLatLng(spots[k]);
    });
  }
  function onTransformChanged(skip) {
    placeImage();
    syncHandles(skip);
    refreshDraftGeometry();
  }
  function buildHandles() {
    var m = getMap(); if (!m) return;
    removeHandles();
    var spots = handleSpots();
    var H = {};
    H.move = L.marker(spots.move, { draggable: true, icon: handleIcon('✥', 'pi-h-move'), zIndexOffset: 1000 });
    H.rot = L.marker(spots.rot, { draggable: true, icon: handleIcon('⟳', 'pi-h-rot'), zIndexOffset: 1000 });
    H.sx = L.marker(spots.sx, { draggable: true, icon: handleIcon('↔', 'pi-h-str'), zIndexOffset: 1000 });
    H.sy = L.marker(spots.sy, { draggable: true, icon: handleIcon('↕', 'pi-h-str'), zIndexOffset: 1000 });
    H.move.on('drag', function (e) {
      var ll = e.target.getLatLng(); S.T.lat = ll.lat; S.T.lng = ll.lng;
      onTransformChanged('move');
    });
    H.rot.on('drag', function (e) {
      var v = metresFrom(S.T, e.target.getLatLng());
      var ox = S.img.w / 2 * S.T.sx, oy = S.img.h / 2 * S.T.sy;
      var len = Math.sqrt(v.e * v.e + v.n * v.n), olen = Math.sqrt(ox * ox + oy * oy);
      if (len < 0.5) return;
      S.T.rot = Math.atan2(v.n, v.e) - Math.atan2(oy, ox);
      var k = len / olen; S.T.sx *= k; S.T.sy *= k;
      onTransformChanged('rot');
    });
    H.sx.on('drag', function (e) {
      var v = metresFrom(S.T, e.target.getLatLng());
      var d = v.e * Math.cos(S.T.rot) + v.n * Math.sin(S.T.rot);
      if (d > 0.5) S.T.sx = d / (S.img.w / 2);
      onTransformChanged('sx');
    });
    H.sy.on('drag', function (e) {
      var v = metresFrom(S.T, e.target.getLatLng());
      var d = -v.e * Math.sin(S.T.rot) + v.n * Math.cos(S.T.rot);
      if (d > 0.5) S.T.sy = d / (S.img.h / 2);
      onTransformChanged('sy');
    });
    Object.keys(H).forEach(function (k) {
      H[k].on('dragend', function () { syncHandles(); });
      H[k].addTo(m);
    });
    S.handles = H;
  }
  function removeHandles() {
    var m = getMap();
    if (S && S.handles && m) Object.keys(S.handles).forEach(function (k) { m.removeLayer(S.handles[k]); });
    if (S) S.handles = null;
  }
  function fitImageToView() {
    var m = getMap(); if (!m || !S || !S.img) return;
    var b = m.getBounds(), c = m.getCenter();
    var wM = m.distance(L.latLng(c.lat, b.getWest()), L.latLng(c.lat, b.getEast()));
    var hM = m.distance(L.latLng(b.getSouth(), c.lng), L.latLng(b.getNorth(), c.lng));
    var s = Math.min(wM * 0.8 / S.img.w, hM * 0.6 / S.img.h);
    S.T = { lat: c.lat, lng: c.lng, sx: s, sy: s, rot: 0 };
    onTransformChanged();
  }
  function showImage() {
    var m = getMap(); if (!m) return;
    var pane = ensurePane(m);
    if (!S.imgEl) {
      var el = document.createElement('img');
      el.className = 'pi-overlay';
      el.src = S.img.url;
      el.style.width = S.img.w + 'px';
      el.style.height = S.img.h + 'px';
      pane.appendChild(el);
      S.imgEl = el;
      m.on('zoomstart', onZoomStart);
      m.on('zoomend viewreset', onZoomEnd);
    }
    if (!S.T) fitImageToView(); else onTransformChanged();
    buildHandles();
  }
  function removeImage() {
    var m = getMap();
    removeHandles();
    if (S && S.imgEl) {
      if (S.imgEl.parentNode) S.imgEl.parentNode.removeChild(S.imgEl);
      S.imgEl = null;
    }
    if (m) { m.off('zoomstart', onZoomStart); m.off('zoomend viewreset', onZoomEnd); }
  }

  function drawDrafts() {
    var m = getMap(); if (!m) return;
    clearDraftLayers();
    S.draftLayers = S.drafts.map(function (d, i) {
      var pg = L.polygon(draftLL(d), {
        color: DRAFT_COLOR, weight: 2.5, dashArray: '6,5',
        fillColor: DRAFT_COLOR, fillOpacity: d.include ? 0.18 : 0.04, opacity: d.include ? 1 : 0.45
      }).addTo(m);
      pg.bindTooltip(esc(d.name), { permanent: true, direction: 'center', className: 'pi-tip' });
      pg.on('click', function (e) {
        // While the ordinary "new plot" tool is tracing, the click is a
        // vertex for that plot, not a request to edit this draft.
        if (window.MapAccess && MapAccess.isDrawing && MapAccess.isDrawing()) return;
        if (e && e.originalEvent) L.DomEvent.stop(e.originalEvent);
        startEdit(i);
      });
      return pg;
    });
    if (S.editIdx != null) buildVertexHandles();
    render();
  }
  function refreshDraftGeometry() {
    if (!S || !S.draftLayers) return;
    S.drafts.forEach(function (d, i) {
      var pg = S.draftLayers[i]; if (!pg) return;
      pg.setLatLngs(draftLL(d));
    });
    if (S.editIdx != null) buildVertexHandles();
    updateAreas();
  }
  function clearDraftLayers() {
    var m = getMap();
    if (S && S.draftLayers && m) S.draftLayers.forEach(function (l) { m.removeLayer(l); });
    if (S) S.draftLayers = [];
    removeVertexHandles();
  }

  // ── Vertex editor for one draft ─────────────────────────────────────
  function startEdit(i) {
    if (!S) return;
    S.editIdx = (S.editIdx === i) ? null : i;
    if (S.editIdx == null) removeVertexHandles(); else buildVertexHandles();
    if (S.minimized) setMinimized(false); else render();
  }
  function setDraftVertex(d, k, ll) {
    if (d.px) d.px[k] = ll2px(S.T, ll, S.img.w, S.img.h);
    else d.ll[k] = { lat: ll.lat, lng: ll.lng };
  }
  function removeVertexHandles() {
    var m = getMap();
    if (S && S.vHandles && m) S.vHandles.forEach(function (h) { m.removeLayer(h); });
    if (S) S.vHandles = [];
  }
  function buildVertexHandles() {
    var m = getMap(); if (!m || !S || S.editIdx == null) return;
    removeVertexHandles();
    var i = S.editIdx, d = S.drafts[i]; if (!d) return;
    var ring = draftLL(d);
    var hs = [];
    ring.forEach(function (c, k) {
      var h = L.marker(c, { draggable: true, zIndexOffset: 900,
        icon: L.divIcon({ className: 'pi-v', iconSize: [18, 18], iconAnchor: [9, 9] }) });
      h.on('drag', function (e) {
        setDraftVertex(d, k, e.target.getLatLng());
        S.draftLayers[i].setLatLngs(draftLL(d));
      });
      h.on('dragend', function () {
        h._piDragAt = Date.now();
        buildVertexHandles();
        updateAreas();
      });
      h.on('click', function () {
        if (h._piDragAt && Date.now() - h._piDragAt < 400) return;
        var arr = d.px || d.ll;
        if (arr.length <= 3) { toast('⚠️ ' + tt('לחלקה חייבות להיות לפחות 3 נקודות', 'แปลงต้องมีอย่างน้อย 3 จุด', 'يجب أن تحتوي القطعة على 3 نقاط على الأقل')); return; }
        arr.splice(k, 1);
        S.draftLayers[i].setLatLngs(draftLL(d));
        buildVertexHandles();
        updateAreas();
      });
      hs.push(h.addTo(m));
      var nx = ring[(k + 1) % ring.length];
      var mid = L.marker({ lat: (c.lat + nx.lat) / 2, lng: (c.lng + nx.lng) / 2 }, { zIndexOffset: 800,
        icon: L.divIcon({ className: 'pi-mid', iconSize: [14, 14], iconAnchor: [7, 7] }) });
      mid.on('click', function () {
        var arr = d.px || d.ll;
        var ll = mid.getLatLng();
        arr.splice(k + 1, 0, d.px ? ll2px(S.T, ll, S.img.w, S.img.h) : { lat: ll.lat, lng: ll.lng });
        S.draftLayers[i].setLatLngs(draftLL(d));
        buildVertexHandles();
        updateAreas();
      });
      hs.push(mid.addTo(m));
    });
    S.vHandles = hs;
  }

  // ── Loading an image ────────────────────────────────────────────────
  function loadImageFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || '')) {
      toast('❌ ' + tt('הקובץ אינו תמונה', 'ไฟล์ไม่ใช่รูปภาพ', 'الملف ليس صورة'));
      return;
    }
    var rd = new FileReader();
    rd.onload = function () {
      var im = new Image();
      im.onload = function () {
        var k = Math.min(1, MAX_SIDE / Math.max(im.naturalWidth, im.naturalHeight));
        var w = Math.max(32, Math.round(im.naturalWidth * k)), h = Math.max(32, Math.round(im.naturalHeight * k));
        var cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
        cx.drawImage(im, 0, 0, w, h);
        var q = 0.85, url = cv.toDataURL('image/jpeg', q);
        while (url.length > 1.4 * 1024 * 1024 && q > 0.4) { q -= 0.15; url = cv.toDataURL('image/jpeg', q); }
        if (S.imgEl) removeImage();
        S.drafts = S.drafts.filter(function (d) { return !d.px; });
        S.img = { w: w, h: h, url: url, b64: url.split(',')[1], name: file.name || '' };
        S.T = null;
        S.mode = 'image';
        S.imgHidden = false;
        S.editIdx = null;
        showImage();
        drawDrafts();
      };
      im.onerror = function () {
        toast('❌ ' + tt('לא ניתן לקרוא את התמונה', 'ไม่สามารถอ่านรูปภาพได้', 'تعذرت قراءة الصورة'));
      };
      im.src = rd.result;
    };
    rd.readAsDataURL(file);
  }

  // ── Detection (Cloud Function) ──────────────────────────────────────
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(16);
  }
  function cacheGet(k) {
    try { var c = JSON.parse(localStorage.getItem(DETECT_CACHE) || '{}'); return c[k] || null; }
    catch (e) { return null; }
  }
  function cachePut(k, v) {
    try {
      var c = JSON.parse(localStorage.getItem(DETECT_CACHE) || '{}');
      c[k] = v;
      var keys = Object.keys(c).sort(function (a, b) { return (c[a].at || 0) - (c[b].at || 0); });
      while (keys.length > 12) delete c[keys.shift()];
      localStorage.setItem(DETECT_CACHE, JSON.stringify(c));
    } catch (e) {}
  }
  function applyDetection(res) {
    S.drafts = S.drafts.filter(function (d) { return !d.px; });
    S.editIdx = null;
    var list = (res.plots || []).map(function (p) {
      return {
        px: p.points.map(function (q) { return { x: q[0], y: q[1] }; }),
        name: p.label || '',
        conf: p.confidence || 'low',
        note: p.note || ''
      };
    });
    addDrafts(list);
    S.status = list.length
      ? '✅ ' + tt('זוהו', 'พบ', 'تم العثور على') + ' ' + list.length + ' ' + tt('חלקות — בדוק ותקן לפני השמירה', 'แปลง — ตรวจสอบและแก้ไขก่อนบันทึก', 'قطع — راجع وصحح قبل الحفظ')
      : '⚠️ ' + tt('לא זוהו חלקות בתמונה', 'ไม่พบแปลงในรูปภาพ', 'لم يتم العثور على قطع في الصورة');
    if (res.notes) S.status += ' · ' + res.notes;
    render();
  }
  function detect() {
    if (!S || !S.img || S.busy) return;
    if (typeof firebase === 'undefined' || !firebase.app || !firebase.app().functions) {
      toast('❌ ' + tt('שירות הזיהוי אינו זמין', 'บริการตรวจจับไม่พร้อมใช้งาน', 'خدمة الكشف غير متاحة'));
      return;
    }
    var model = S.model || 'sonnet-5';
    var hint = (S.hint || '').trim();
    var key = model + ':' + hashStr(S.img.b64) + ':' + hashStr(hint);
    var hit = cacheGet(key);
    if (hit) { applyDetection(hit); toast('♻️ ' + tt('נטען מזיהוי קודם — ללא עלות', 'โหลดจากการตรวจจับก่อนหน้า — ไม่มีค่าใช้จ่าย', 'تم التحميل من كشف سابق — بدون تكلفة')); return; }
    S.busy = true;
    S.status = '⏳ ' + tt('מזהה חלקות… (עד דקה)', 'กำลังตรวจจับแปลง… (ไม่เกินหนึ่งนาที)', 'جارٍ كشف القطع… (حتى دقيقة)');
    render();
    var fn = firebase.app().functions('us-central1').httpsCallable('plotDetect', { timeout: 180000 });
    fn({ image: S.img.b64, width: S.img.w, height: S.img.h, model: model, hint: hint })
      .then(function (r) {
        S.busy = false;
        var res = r && r.data ? r.data : { plots: [] };
        cachePut(key, { plots: res.plots || [], notes: res.notes || '', at: Date.now() });
        applyDetection(res);
      })
      .catch(function (e) {
        S.busy = false;
        S.status = '❌ ' + tt('הזיהוי נכשל', 'การตรวจจับล้มเหลว', 'فشل الكشف') + ': ' + ((e && e.message) || e);
        render();
      });
  }

  // ── Files: GeoJSON / KML / KMZ ──────────────────────────────────────
  function coordToLL(x, y, st) {
    if (Math.abs(x) <= 180 && Math.abs(y) <= 90) return { lat: y, lng: x };
    if (looksItm(x, y)) { st.itm = true; return itmToWgs(x, y); }
    st.bad = true;
    return null;
  }
  function parseGeoJSON(obj) {
    var out = [], st = {};
    function nameOf(pr) {
      pr = pr || {};
      return pr.name || pr.Name || pr.NAME || pr.title || pr.label || pr.shem || '';
    }
    function ring(coords, nm) {
      var r = (coords || []).map(function (c) { return coordToLL(+c[0], +c[1], st); })
        .filter(function (c) { return c; });
      if (r.length >= 3) out.push({ ll: tidyRing(r), name: String(nm || '') });
    }
    function geom(g, nm) {
      if (!g) return;
      if (g.type === 'Polygon') ring(g.coordinates && g.coordinates[0], nm);
      else if (g.type === 'MultiPolygon') (g.coordinates || []).forEach(function (p) { ring(p && p[0], nm); });
      else if (g.type === 'GeometryCollection') (g.geometries || []).forEach(function (x) { geom(x, nm); });
    }
    if (obj.type === 'FeatureCollection') (obj.features || []).forEach(function (f) { geom(f.geometry, nameOf(f.properties)); });
    else if (obj.type === 'Feature') geom(obj.geometry, nameOf(obj.properties));
    else geom(obj, '');
    return { drafts: out, itm: !!st.itm, bad: !!st.bad };
  }
  function parseKML(text) {
    var doc = new DOMParser().parseFromString(text, 'application/xml');
    var out = [], st = {};
    var marks = doc.getElementsByTagName('Placemark');
    for (var i = 0; i < marks.length; i++) {
      var pm = marks[i];
      var nmEl = pm.getElementsByTagName('name')[0];
      var nm = nmEl ? nmEl.textContent.trim() : '';
      var outers = pm.getElementsByTagName('outerBoundaryIs');
      for (var j = 0; j < outers.length; j++) {
        var cEl = outers[j].getElementsByTagName('coordinates')[0];
        if (!cEl) continue;
        var r = cEl.textContent.trim().split(/\s+/).map(function (t) {
          var p = t.split(',');
          return p.length >= 2 ? coordToLL(+p[0], +p[1], st) : null;
        }).filter(function (c) { return c && isFinite(c.lat) && isFinite(c.lng); });
        if (r.length >= 3) out.push({ ll: tidyRing(r), name: nm });
      }
    }
    return { drafts: out, itm: !!st.itm, bad: !!st.bad };
  }
  // Minimal ZIP reader: find the first .kml entry in a KMZ.
  function kmzToKml(buf) {
    var dv = new DataView(buf), u8 = new Uint8Array(buf);
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return Promise.reject(new Error('zip'));
    var count = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true);
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true), csize = dv.getUint32(off + 20, true);
      var nlen = dv.getUint16(off + 28, true), xlen = dv.getUint16(off + 30, true), clen = dv.getUint16(off + 32, true);
      var loc = dv.getUint32(off + 42, true);
      var fname = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nlen));
      off += 46 + nlen + xlen + clen;
      if (!/\.kml$/i.test(fname)) continue;
      var ln = dv.getUint16(loc + 26, true), lx = dv.getUint16(loc + 28, true);
      var data = u8.subarray(loc + 30 + ln + lx, loc + 30 + ln + lx + csize);
      if (method === 0) return Promise.resolve(new TextDecoder().decode(data));
      if (method === 8 && typeof DecompressionStream !== 'undefined') {
        var ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(ds).text();
      }
      return Promise.reject(new Error('deflate'));
    }
    return Promise.reject(new Error('nokml'));
  }
  function loadGeoFile(file) {
    if (!file) return;
    var name = (file.name || '').toLowerCase();
    var done = function (r) {
      if (!r.drafts.length) {
        toast('⚠️ ' + tt('לא נמצאו פוליגונים בקובץ', 'ไม่พบรูปหลายเหลี่ยมในไฟล์', 'لم يتم العثور على مضلعات في الملف') +
          (r.bad ? ' — ' + tt('מערכת קואורדינטות לא מוכרת', 'ระบบพิกัดที่ไม่รู้จัก', 'نظام إحداثيات غير معروف') : ''));
        return;
      }
      S.mode = S.img ? 'image' : 'file';
      addDrafts(r.drafts);
      var m = getMap();
      if (m) {
        var b = L.latLngBounds([]);
        r.drafts.forEach(function (d) { d.ll.forEach(function (c) { b.extend(c); }); });
        if (b.isValid()) m.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
      }
      S.status = '✅ ' + r.drafts.length + ' ' + tt('חלקות נטענו מהקובץ', 'แปลงโหลดจากไฟล์', 'قطع تم تحميلها من الملف') +
        (r.itm ? ' · ' + tt('הומר מרשת ישראל (ITM)', 'แปลงจากระบบ ITM ของอิสราเอล', 'تم التحويل من شبكة إسرائيل (ITM)') : '');
      render();
    };
    var fail = function () {
      toast('❌ ' + tt('לא ניתן לקרוא את הקובץ', 'ไม่สามารถอ่านไฟล์ได้', 'تعذرت قراءة الملف'));
    };
    if (/\.kmz$/.test(name)) {
      file.arrayBuffer().then(kmzToKml).then(function (txt) { done(parseKML(txt)); }).catch(fail);
      return;
    }
    file.text().then(function (txt) {
      var trimmed = txt.replace(/^\uFEFF/, '').trim();
      if (trimmed.charAt(0) === '<') done(parseKML(trimmed));
      else done(parseGeoJSON(JSON.parse(trimmed)));
    }).catch(fail);
  }

  // ── Creating the plots ──────────────────────────────────────────────
  function commit() {
    if (!S) return;
    var farmId = parseInt(S.farmId, 10);
    if (!farmId) { toast('❌ ' + tt('חובה לבחור מטע', 'ต้องเลือกสวน', 'يجب اختيار بستان')); return; }
    var chosen = S.drafts.filter(function (d) { return d.include; });
    if (!chosen.length) { toast('⚠️ ' + tt('לא נבחרו חלקות', 'ไม่ได้เลือกแปลง', 'لم يتم اختيار قطع')); return; }
    var items = chosen.map(function (d) {
      return { ring: draftLL(d), name: d.name, farmId: farmId, cropType: S.crop || null };
    });
    var r = (window.MapAccess && MapAccess.addImportedPlots) ? MapAccess.addImportedPlots(items) : { ok: false };
    if (!r || !r.ok) {
      toast('❌ ' + tt('יצירת החלקות נכשלה', 'สร้างแปลงไม่สำเร็จ', 'فشل إنشاء القطع'));
      return;
    }
    toast('✅ ' + r.ids.length + ' ' + tt('חלקות נוצרו — השלם עצים ומרווחים בכרטיס החלקה', 'แปลงถูกสร้าง — กรอกจำนวนต้นและระยะในบัตรแปลง', 'قطع تم إنشاؤها — أكمل الأشجار والمسافات في بطاقة القطعة'));
    close(true);
  }

  // ── Panel ───────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('piStyles')) return;
    var st = document.createElement('style');
    st.id = 'piStyles';
    st.textContent =
      '.pi-panel{position:fixed;left:8px;right:8px;bottom:8px;max-height:46vh;overflow:auto;z-index:1500;' +
      'background:var(--card,#fff);color:var(--text,#1b1b1b);border-radius:16px;box-shadow:0 6px 28px rgba(0,0,0,.28);' +
      'padding:12px 14px;font-family:Heebo,sans-serif;font-size:14px;max-width:560px;margin:0 auto}' +
      '.pi-panel h3{margin:0;font-size:16px;flex:1}' +
      '.pi-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}' +
      '.pi-btn{border:0;border-radius:10px;padding:9px 12px;font:inherit;font-weight:600;cursor:pointer;' +
      'background:var(--g5,#e8f5e9);color:var(--g1,#1b5e20)}' +
      '.pi-btn.pri{background:var(--g2,#2e7d32);color:#fff}.pi-btn:disabled{opacity:.5}' +
      '.pi-btn.big{flex:1;padding:14px 10px;font-size:15px}' +
      '.pi-help{font-size:12.5px;opacity:.75;line-height:1.45;margin:4px 0}' +
      '.pi-status{font-size:13px;margin:6px 0;line-height:1.4}' +
      '.pi-panel input[type=text],.pi-panel select{font:inherit;padding:7px 8px;border-radius:8px;' +
      'border:1px solid rgba(0,0,0,.18);background:var(--card,#fff);color:inherit;min-width:0}' +
      '.pi-d{display:flex;gap:6px;align-items:center;padding:6px 4px;border-top:1px solid rgba(0,0,0,.08)}' +
      '.pi-d.on{background:rgba(255,111,0,.08);border-radius:8px}' +
      '.pi-d input[type=text]{flex:1;width:0}' +
      '.pi-d .pi-a{font-size:12px;opacity:.7;white-space:nowrap}' +
      '.pi-d .pi-x{background:none;border:0;font-size:17px;cursor:pointer;padding:2px 4px}' +
      '.pi-warn{font-size:11.5px;color:#e65100;padding:0 4px 4px}' +
      '.pi-pill{position:fixed;bottom:70px;left:12px;z-index:1500;border:0;border-radius:20px;' +
      'padding:9px 14px;font:600 14px Heebo,sans-serif;background:#ff6f00;color:#fff;box-shadow:0 3px 12px rgba(0,0,0,.3)}' +
      '.pi-overlay{position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;max-width:none!important}' +
      '.pi-h div{width:30px;height:30px;border-radius:50%;background:#fff;border:2px solid #ff6f00;color:#e65100;' +
      'display:flex;align-items:center;justify-content:center;font-size:16px;box-shadow:0 2px 6px rgba(0,0,0,.35)}' +
      '.pi-h-move div{background:#ff6f00;color:#fff}' +
      '.pi-v{background:#fff;border:3px solid #ff6f00;border-radius:50%;box-sizing:border-box}' +
      '.pi-mid{background:rgba(255,111,0,.55);border:2px solid #fff;border-radius:50%;box-sizing:border-box}' +
      '.pi-tip{background:rgba(255,111,0,.9);color:#fff;border:0;font:600 12px Heebo,sans-serif;box-shadow:none}' +
      '.pi-tip:before{display:none}';
    document.head.appendChild(st);
  }
  function panelEl() {
    var el = document.getElementById('piPanel');
    if (!el) {
      el = document.createElement('div');
      el.id = 'piPanel';
      el.className = 'pi-panel';
      (document.getElementById('tabMap') || document.body).appendChild(el);
      el.addEventListener('click', onPanelClick);
      el.addEventListener('input', onPanelInput);
      el.addEventListener('change', onPanelInput);
    }
    return el;
  }
  function pillEl() {
    var p = document.getElementById('piPill');
    if (!p) {
      p = document.createElement('button');
      p.id = 'piPill';
      p.className = 'pi-pill';
      p.addEventListener('click', function () { setMinimized(false); });
      (document.getElementById('tabMap') || document.body).appendChild(p);
    }
    return p;
  }
  function setMinimized(on) {
    if (!S) return;
    S.minimized = on;
    panelEl().style.display = on ? 'none' : '';
    var p = pillEl();
    p.style.display = on ? '' : 'none';
    p.textContent = '📥 ' + tt('ייבוא חלקות', 'นำเข้าแปลง', 'استيراد القطع') +
      (S.drafts.length ? ' · ' + S.drafts.length : '');
    if (!on) render();
  }
  function updateAreas() {
    if (!S) return;
    S.drafts.forEach(function (d, i) {
      var el = document.getElementById('piArea' + i);
      if (el) el.textContent = ringAreaDunam(draftLL(d)).toFixed(2) + ' ' + tt('ד׳', 'ไร่', 'دونم');
    });
  }
  function render() {
    if (!S || S.minimized) return;
    var el = panelEl();
    el.setAttribute('dir', isRtl() ? 'rtl' : 'ltr');
    var h = '<div class="pi-row" style="margin-top:0">' +
      '<h3>📥 ' + tt('ייבוא חלקות', 'นำเข้าแปลง', 'استيراد القطع') + '</h3>' +
      '<button class="pi-btn" data-act="min" title="' + esc(tt('מזער', 'ย่อ', 'تصغير')) + '">▾</button>' +
      '<button class="pi-btn" data-act="close">✕</button></div>';

    h += '<div class="pi-row">' +
      '<button class="pi-btn big" data-act="pickImg">📷 ' + (S.img ? tt('תמונה אחרת', 'รูปอื่น', 'صورة أخرى') : tt('מתמונה', 'จากรูปภาพ', 'من صورة')) + '</button>' +
      '<button class="pi-btn big" data-act="pickFile">🗺️ ' + tt('מקובץ KML / GeoJSON', 'จากไฟล์ KML / GeoJSON', 'من ملف KML / GeoJSON') + '</button></div>';

    if (!S.img && !S.drafts.length) {
      h += '<p class="pi-help">' + tt(
        'צילום מסך של תצלום אוויר, מפה מודפסת או סקיצה. התמונה תונח על המפה ותיישר אותה עם הידיות. קובץ KML מ-Google Earth או GeoJSON מ-GovMap נטען ישירות למקום הנכון.',
        'ภาพหน้าจอจากภาพถ่ายทางอากาศ แผนที่พิมพ์ หรือภาพร่าง รูปจะวางบนแผนที่และจัดตำแหน่งด้วยที่จับ ไฟล์ KML จาก Google Earth หรือ GeoJSON จาก GovMap จะโหลดตรงตำแหน่งที่ถูกต้อง',
        'لقطة شاشة لصورة جوية أو خريطة مطبوعة أو رسم. توضع الصورة على الخريطة وتُحاذى بالمقابض. ملف KML من Google Earth أو GeoJSON من GovMap يُحمَّل مباشرة في المكان الصحيح.') + '</p>';
    }

    if (S.img) {
      h += '<p class="pi-help">' + tt(
        'גרור ✥ להזזה, ⟳ לסיבוב והגדלה, ↔ ↕ למתיחה — עד שהתמונה יושבת על תצלום האוויר.',
        'ลาก ✥ เพื่อย้าย ⟳ เพื่อหมุนและปรับขนาด ↔ ↕ เพื่อยืด — จนรูปตรงกับภาพถ่ายทางอากาศ',
        'اسحب ✥ للتحريك، ⟳ للتدوير والتكبير، ↔ ↕ للمط — حتى تنطبق الصورة على الصورة الجوية.') + '</p>';
      h += '<div class="pi-row">' +
        '<span>' + tt('שקיפות', 'ความโปร่งใส', 'الشفافية') + '</span>' +
        '<input type="range" min="0.15" max="1" step="0.05" value="' + S.opacity + '" data-in="opacity" style="flex:1">' +
        '<button class="pi-btn" data-act="toggleImg">' + (S.imgHidden ? '👁️' : '🙈') + '</button>' +
        '<button class="pi-btn" data-act="fit">⤢ ' + tt('למרכז', 'กึ่งกลาง', 'للمركز') + '</button></div>';
      h += '<div class="pi-row">' +
        '<select data-in="model">' +
          '<option value="sonnet-5"' + (S.model === 'sonnet-5' ? ' selected' : '') + '>' + tt('זיהוי מדויק', 'ตรวจจับแม่นยำ', 'كشف دقيق') + '</option>' +
          '<option value="haiku"' + (S.model === 'haiku' ? ' selected' : '') + '>' + tt('זיהוי חסכוני', 'ตรวจจับประหยัด', 'كشف اقتصادي') + '</option>' +
          '<option value="opus"' + (S.model === 'opus' ? ' selected' : '') + '>' + tt('זיהוי מקסימלי', 'ตรวจจับสูงสุด', 'كشف أقصى') + '</option>' +
        '</select>' +
        '<input type="text" data-in="hint" style="flex:1" value="' + esc(S.hint || '') + '" placeholder="' +
          esc(tt('רמז (לא חובה): למשל 6 חלקות תמרים', 'คำใบ้ (ไม่บังคับ): เช่น 6 แปลงอินทผลัม', 'تلميح (اختياري): مثلاً 6 قطع نخيل')) + '">' +
        '<button class="pi-btn pri" data-act="detect"' + (S.busy ? ' disabled' : '') + '>🤖 ' + tt('זהה חלקות', 'ตรวจจับแปลง', 'اكشف القطع') + '</button></div>';
      h += '<div class="pi-row"><button class="pi-btn" data-act="manual">✏️ ' +
        tt('אסמן בעצמי מעל התמונה', 'ฉันจะวาดเองบนรูป', 'سأرسم بنفسي فوق الصورة') + '</button></div>';
    }
    if (S.status) h += '<div class="pi-status">' + esc(S.status) + '</div>';

    if (S.drafts.length) {
      h += '<div class="pi-help">' + tt(
        'לחץ ✏️ או על חלקה במפה לעריכה: גרור נקודה, לחץ על נקודה למחיקה, לחץ על נקודה כתומה בין שתיים להוספה.',
        'กด ✏️ หรือแตะแปลงบนแผนที่เพื่อแก้ไข: ลากจุด แตะจุดเพื่อลบ แตะจุดสีส้มระหว่างสองจุดเพื่อเพิ่ม',
        'اضغط ✏️ أو على قطعة في الخريطة للتعديل: اسحب نقطة، اضغط نقطة لحذفها، اضغط النقطة البرتقالية بين نقطتين للإضافة.') + '</div>';
      S.drafts.forEach(function (d, i) {
        h += '<div class="pi-d' + (S.editIdx === i ? ' on' : '') + '">' +
          '<input type="checkbox" data-in="inc" data-i="' + i + '"' + (d.include ? ' checked' : '') + '>' +
          '<input type="text" data-in="name" data-i="' + i + '" value="' + esc(d.name) + '">' +
          '<span class="pi-a" id="piArea' + i + '">' + ringAreaDunam(draftLL(d)).toFixed(2) + ' ' + tt('ד׳', 'ไร่', 'دونم') + '</span>' +
          (d.conf === 'low' ? '<span title="' + esc(tt('ביטחון נמוך', 'ความมั่นใจต่ำ', 'ثقة منخفضة')) + '">❔</span>' : '') +
          '<button class="pi-x" data-act="zoom" data-i="' + i + '">🎯</button>' +
          '<button class="pi-x" data-act="edit" data-i="' + i + '">✏️</button>' +
          '<button class="pi-x" data-act="del" data-i="' + i + '">🗑️</button></div>';
        if (d.overlaps) {
          h += '<div class="pi-warn">⚠️ ' + tt('חופפת לחלקה קיימת', 'ทับซ้อนกับแปลงที่มีอยู่', 'تتداخل مع قطعة موجودة') + ': ' + esc(d.overlaps) + '</div>';
        }
        if (d.note) h += '<div class="pi-warn">' + esc(d.note) + '</div>';
      });

      var farmsList = (window.MapAccess && MapAccess.listUserFarms) ? MapAccess.listUserFarms() : [];
      if (!S.farmId && farmsList.length === 1) S.farmId = farmsList[0].id;
      var crops = [];
      try { crops = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]'); } catch (e) {}
      h += '<div class="pi-row" style="margin-top:10px">' +
        '<select data-in="farm" style="flex:1"><option value="">' + tt('בחר מטע', 'เลือกสวน', 'اختر بستانًا') + '</option>' +
        farmsList.map(function (f) {
          return '<option value="' + f.id + '"' + (String(S.farmId) === String(f.id) ? ' selected' : '') + '>' + esc(f.name) + '</option>';
        }).join('') + '</select>' +
        '<select data-in="crop" style="flex:1"><option value="">' + tt('גידול (לא חובה)', 'พืช (ไม่บังคับ)', 'المحصول (اختياري)') + '</option>' +
        crops.map(function (c) {
          return '<option value="' + esc(c) + '"' + (S.crop === c ? ' selected' : '') + '>' + esc(c) + '</option>';
        }).join('') + '</select></div>';
      var nInc = S.drafts.filter(function (d) { return d.include; }).length;
      h += '<div class="pi-row"><button class="pi-btn pri big" data-act="commit"' + (nInc ? '' : ' disabled') + '>✅ ' +
        tt('צור', 'สร้าง', 'أنشئ') + ' ' + nInc + ' ' + tt('חלקות', 'แปลง', 'قطع') + '</button></div>';
    }
    el.innerHTML = h;
  }
  function pickFile(accept, cb) {
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.style.display = 'none';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (f) cb(f);
    });
    document.body.appendChild(inp);
    inp.click();
  }
  function onPanelClick(e) {
    var b = e.target.closest('[data-act]'); if (!b || !S) return;
    var act = b.getAttribute('data-act'), i = parseInt(b.getAttribute('data-i'), 10);
    var m = getMap();
    if (act === 'close') close(false);
    else if (act === 'min' || act === 'manual') {
      setMinimized(true);
      if (act === 'manual') toast('✏️ ' + tt('סמן עם + ← חלקה חדשה. התמונה נשארת מתחת', 'วาดด้วย + ← แปลงใหม่ รูปยังคงอยู่ด้านล่าง', 'ارسم عبر + ← قطعة جديدة. تبقى الصورة تحتها'));
    }
    else if (act === 'pickImg') pickFile('image/*', loadImageFile);
    else if (act === 'pickFile') pickFile('.kml,.kmz,.geojson,.json,application/vnd.google-earth.kml+xml,application/geo+json', loadGeoFile);
    else if (act === 'toggleImg') {
      S.imgHidden = !S.imgHidden;
      placeImage();
      if (S.imgHidden) removeHandles(); else buildHandles();
      render();
    }
    else if (act === 'fit') fitImageToView();
    else if (act === 'detect') detect();
    else if (act === 'zoom' && m && S.draftLayers[i]) m.fitBounds(S.draftLayers[i].getBounds(), { padding: [60, 60], maxZoom: 18 });
    else if (act === 'edit') startEdit(i);
    else if (act === 'del') {
      S.drafts.splice(i, 1);
      if (S.editIdx === i) S.editIdx = null;
      else if (S.editIdx != null && S.editIdx > i) S.editIdx--;
      drawDrafts();
    }
    else if (act === 'commit') commit();
  }
  function onPanelInput(e) {
    var t = e.target, k = t.getAttribute('data-in'); if (!k || !S) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    if (k === 'opacity') { S.opacity = parseFloat(t.value) || 0.6; placeImage(); }
    else if (k === 'model') S.model = t.value;
    else if (k === 'hint') S.hint = t.value;
    else if (k === 'farm') S.farmId = t.value;
    else if (k === 'crop') S.crop = t.value;
    else if (k === 'name' && S.drafts[i]) {
      S.drafts[i].name = t.value;
      var lay = S.draftLayers[i];
      if (lay && lay.getTooltip()) lay.setTooltipContent(esc(t.value));
    }
    else if (k === 'inc' && e.type === 'change' && S.drafts[i]) {
      S.drafts[i].include = t.checked;
      drawDrafts();
    }
  }

  // ── Open / close ────────────────────────────────────────────────────
  function open() {
    if (!canImport()) {
      toast('❌ ' + tt('ייבוא חלקות זמין למנהלים בלבד', 'การนำเข้าแปลงใช้ได้เฉพาะผู้จัดการ', 'استيراد القطع متاح للمديرين فقط'));
      return;
    }
    if (window.MapAccess && typeof MapAccess.goToMap === 'function') MapAccess.goToMap();
    injectCss();
    if (!S) {
      S = { drafts: [], draftLayers: [], vHandles: [], handles: null, img: null, imgEl: null, T: null,
            opacity: 0.6, imgHidden: false, model: 'sonnet-5', hint: '', farmId: '', crop: '',
            editIdx: null, status: '', busy: false, minimized: false, mode: null };
    }
    setMinimized(false);
  }
  function close(force) {
    if (!S) return;
    if (!force && S.drafts.length &&
        !window.confirm(tt('לסגור ולבטל את הטיוטות?', 'ปิดและยกเลิกแบบร่าง?', 'إغلاق وإلغاء المسودات؟'))) return;
    clearDraftLayers();
    removeImage();
    var p = document.getElementById('piPanel'); if (p && p.parentNode) p.parentNode.removeChild(p);
    var q = document.getElementById('piPill'); if (q && q.parentNode) q.parentNode.removeChild(q);
    S = null;
  }

  // ── Entry point on the map's + menu ─────────────────────────────────
  function refreshFabEntry() {
    var b = document.getElementById('btnPlotImport');
    if (!b) return;
    b.style.display = canImport() ? '' : 'none';
    var t1 = b.querySelector('.fab-option-text'), t2 = b.querySelector('.fab-option-sub');
    if (t1) t1.textContent = tt('ייבוא חלקות', 'นำเข้าแปลง', 'استيراد القطع');
    if (t2) t2.textContent = tt('מתמונה או מקובץ KML', 'จากรูปภาพหรือไฟล์ KML', 'من صورة أو ملف KML');
  }
  function init() {
    var opts = document.getElementById('fabOptions');
    if (!opts || document.getElementById('btnPlotImport')) return;
    var b = document.createElement('button');
    b.className = 'fab-option';
    b.id = 'btnPlotImport';
    b.innerHTML = '<div class="fab-option-icon" style="background:#fff3e0;color:#ef6c00;">📥</div>' +
      '<div><div class="fab-option-text"></div><div class="fab-option-sub"></div></div>';
    b.addEventListener('click', function () {
      opts.classList.remove('show');
      var fm = document.getElementById('fabMain'); if (fm) fm.classList.remove('open');
      open();
    });
    opts.appendChild(b);
    refreshFabEntry();
    // Role and language can change after load (sign-in, language switch):
    // re-check whenever the menu is opened.
    var fm = document.getElementById('fabMain');
    if (fm) fm.addEventListener('click', refreshFabEntry);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    open: open,
    close: close,
    // exposed for tests
    _itmToWgs: itmToWgs,
    _parseGeoJSON: parseGeoJSON,
    _parseKML: parseKML,
    _kmzToKml: kmzToKml,
    _px2ll: px2ll,
    _ll2px: ll2px
  };
})();
