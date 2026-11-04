/* treemap.js — ספירת עצים בחלקות מתצלום אוויר (tree count inside chosen plots)
 * ------------------------------------------------------------------
 * An optional helper for the plots where the tree count, the missing trees
 * or the spacing are not known. It works ONLY inside plots the user picks:
 * nothing around them is read or mapped.
 *
 *   1. PICK. Tap the plots on the map (or take every plot in view).
 *
 *   2. COUNT. For each picked plot the imagery under it is read at full
 *      resolution (Esri World Imagery, zoom 18, about 0.5 m per pixel, the
 *      same imagery as the map's satellite layer), in this browser, with no
 *      upload and no cost. Then, inside the plot outline only:
 *        - crowns are found: a bright centre inside closed canopy, or a dark
 *          blob on open ground, at a scale small enough for young palms;
 *        - the planting grid is fitted (row direction, distance between
 *          rows and between trees);
 *        - each row is walked: where the gap between two trees is two or
 *          more spacings, the places in between are checked against the
 *          image (foliage darker than this plot's own soil). Foliage there
 *          means a tree the crown finder missed, usually one hidden by its
 *          neighbours; bare ground means a missing tree.
 *      Checked against 565 trees Alon confirmed by hand in Kinneret (Nov
 *      2026): recall went from 0.60 to 0.72 at the same precision (0.80).
 *
 *   3. REVIEW. Tap a dot to reject it (tap again to restore), tap empty
 *      ground inside the plot to add a tree, tap an orange gap to put a tree
 *      in it.
 *
 *   4. UPDATE. Tree count, missing trees, both spacings and plants per
 *      dunam go onto the plot (MapAccess.updatePlotTreeData), one plot at a
 *      time through a form, or all ticked plots at once. Individual trees
 *      and rows are working material only and are not stored.
 *
 * Changing plots is admin only (ownership rule, Oct 2026). The module never
 * touches the plots array or saveData itself.
 */
var TreeMap = (function () {
  'use strict';

  var TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/{y}/{x}';
  var Z = 18, TS = 256, WORLD = TS * Math.pow(2, Z);
  var MAX_SIDE = 3200;            // px of one plot's box (about 1.6 km); larger plots are refused
  var MAX_DRAW = 7000;            // dots drawn at once; beyond that, zoom in
  var BK = 64;                    // spatial bucket, px
  var MARGIN = 64;                // px of imagery read around a plot, for the blurs
  var S = null;                   // session

  var toastN = 0;
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
  function toast(m) { toastN++; if (typeof showToast === 'function') showToast(m); }
  function isRtl() { var l = (typeof currentLang !== 'undefined') ? currentLang : 'he'; return l === 'he' || l === 'ar'; }
  function getMap() { return (window.MapAccess && typeof MapAccess.getMap === 'function') ? MapAccess.getMap() : null; }
  function isAdmin() { return window.Own ? Own.isAdmin() : ((window.currentUser || {}).role === 'admin'); }
  function fmt(n, d) { n = Number(n) || 0; return d ? n.toFixed(d) : Math.round(n).toLocaleString('he-IL'); }

  // ── Web Mercator, zoom-18 pixels ─────────────────────────────────────
  function toPx(lat, lng) {
    var s = Math.sin(lat * Math.PI / 180);
    return { x: (lng + 180) / 360 * WORLD, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD };
  }
  function toLL(x, y) {
    var n = Math.PI - 2 * Math.PI * y / WORLD;
    return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: x / WORLD * 360 - 180 };
  }
  function mppAt(lat) { return 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, Z); }

  // ── Geometry in px ───────────────────────────────────────────────────
  function inRing(x, y, p) {
    var c = false;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
      var xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  function inPlot(pl, x, y) {
    if (x < pl.box[0] || x > pl.box[2] || y < pl.box[1] || y > pl.box[3]) return false;
    for (var i = 0; i < pl.rings.length; i++) if (inRing(x, y, pl.rings[i])) return true;
    return false;
  }
  function plotAt(x, y) {
    var ids = Object.keys(S.plots);
    for (var i = 0; i < ids.length; i++) if (inPlot(S.plots[ids[i]], x, y)) return S.plots[ids[i]];
    return null;
  }
  function bboxOf(rings) {
    var b = [1e18, 1e18, -1e18, -1e18];
    rings.forEach(function (r) { r.forEach(function (q) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); }); });
    return b;
  }
  function segDist(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    var t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2));
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  }

  // ── Point store with buckets ─────────────────────────────────────────
  function bkey(x, y) { return Math.floor(x / BK) + ',' + Math.floor(y / BK); }
  function addPoint(x, y, auto) {
    var k = S.px.length / 2;
    S.px.push(x, y);
    if (auto) S.auto[k] = 1;
    var key = bkey(x, y);
    (S.bk[key] || (S.bk[key] = [])).push(k);
    return k;
  }
  function eachInRect(x0, y0, x1, y1, fn) {
    var bx0 = Math.floor(x0 / BK), bx1 = Math.floor(x1 / BK), by0 = Math.floor(y0 / BK), by1 = Math.floor(y1 / BK);
    for (var by = by0; by <= by1; by++) for (var bx = bx0; bx <= bx1; bx++) {
      var a = S.bk[bx + ',' + by]; if (!a) continue;
      for (var i = 0; i < a.length; i++) {
        var k = a[i], x = S.px[2 * k], y = S.px[2 * k + 1];
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1) fn(k, x, y);
      }
    }
  }
  function nearestDet(x, y, r, includeRejected) {
    var best = -1, bd = r;
    eachInRect(x - r, y - r, x + r, y + r, function (k, px, py) {
      if (!includeRejected && S.rej[k]) return;
      var d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = k; }
    });
    return best;
  }
  function hasTree(x, y, r) {
    if (nearestDet(x, y, r, false) >= 0) return true;
    for (var i = 0; i < S.added.length; i++) if (Math.hypot(S.added[i][0] - x, S.added[i][1] - y) < r) return true;
    return false;
  }
  // Trees of one plot: accepted detections and trees the user added.
  function treesOf(pl) {
    var out = [];
    eachInRect(pl.box[0], pl.box[1], pl.box[2], pl.box[3], function (k, x, y) { if (!S.rej[k] && inPlot(pl, x, y)) out.push([x, y, k]); });
    S.added.forEach(function (q) { if (inPlot(pl, q[0], q[1])) out.push([q[0], q[1], -1]); });
    return out;
  }

  // ── Image filters ────────────────────────────────────────────────────
  function box(src, W, H, r) {
    var out = new Float32Array(W * H), tmp = new Float32Array(W * H), n = 2 * r + 1, x, y, s, o;
    for (y = 0; y < H; y++) {
      s = 0; o = y * W;
      for (x = -r; x <= r; x++) s += src[o + Math.min(W - 1, Math.max(0, x))];
      for (x = 0; x < W; x++) { tmp[o + x] = s / n; s += src[o + Math.min(W - 1, x + r + 1)] - src[o + Math.max(0, x - r)]; }
    }
    for (x = 0; x < W; x++) {
      s = 0;
      for (y = -r; y <= r; y++) s += tmp[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (y = 0; y < H; y++) { out[y * W + x] = s / n; s += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x]; }
    }
    return out;
  }
  function blur3(s, W, H, rs) { return box(box(box(s, W, H, rs[0]), W, H, rs[1]), W, H, rs[2]); }
  function maxf(src, W, H, r) {
    var tmp = new Float32Array(W * H), out = new Float32Array(W * H), x, y, k, m, o;
    for (y = 0; y < H; y++) {
      o = y * W;
      for (x = 0; x < W; x++) { m = -1e9; for (k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) if (src[o + k] > m) m = src[o + k]; tmp[o + x] = m; }
    }
    for (x = 0; x < W; x++) for (y = 0; y < H; y++) {
      m = -1e9; for (k = Math.max(0, y - r); k <= Math.min(H - 1, y + r); k++) if (tmp[k * W + x] > m) m = tmp[k * W + x]; out[y * W + x] = m;
    }
    return out;
  }
  // Crowns in an RGBA window. Closed canopy: a bright centre inside dark
  // foliage. Open ground: a dark blob on lighter soil, at a fine scale so a
  // young palm is not blurred away. Returns confident crowns (strong), a
  // looser set used to place inferred trees (cand), and a lightly smoothed
  // grey image for the foliage check.
  function detect(data, W, H) {
    var N = W * H, i, p;
    var g = new Float32Array(N), can = new Float32Array(N);
    for (i = 0, p = 0; i < N; i++, p += 4) { g[i] = (data[p] + data[p + 1] + data[p + 2]) / 3; can[i] = g[i] < 75 ? 1 : 0; }
    var cover = blur3(can, W, H, [15, 15, 15]), bg = blur3(g, W, H, [12, 12, 12]);
    var smD = blur3(g, W, H, [3, 3, 2]), smS = blur3(g, W, H, [2, 2, 1]);
    var rS = new Float32Array(N), rC = new Float32Array(N);
    for (i = 0; i < N; i++) {
      var dense = cover[i] > 0.5;
      if (dense) {
        var rd = smD[i] > 100 ? 0 : smD[i] - bg[i];
        rS[i] = rd; rC[i] = rd;
      } else if (smS[i] <= 90) {
        rS[i] = bg[i] - smS[i] - 10; rC[i] = bg[i] - smS[i] - 4;
      }
    }
    var mS = maxf(rS, W, H, 5), mC = maxf(rC, W, H, 4), strong = [], cand = [];
    for (i = 0; i < N; i++) {
      if (rS[i] > 0.5 && rS[i] >= mS[i]) strong.push(i % W, (i / W) | 0);
      if (rC[i] > 0 && rC[i] >= mC[i]) cand.push(i % W, (i / W) | 0);
    }
    var gray = blur3(g, W, H, [1, 1, 1]);
    return { strong: strong, cand: cand, gray: gray };
  }
  function otsu(vals) {
    var h = new Float64Array(256), n = vals.length, i;
    if (!n) return 128;
    for (i = 0; i < n; i++) h[Math.max(0, Math.min(255, Math.round(vals[i])))]++;
    var sum = 0; for (i = 0; i < 256; i++) sum += i * h[i];
    var sB = 0, wB = 0, best = 0, thr = 128;
    for (i = 0; i < 256; i++) {
      wB += h[i]; if (!wB) continue; var wF = n - wB; if (!wF) break;
      sB += i * h[i]; var mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr;
  }

  // ── Planting grid ────────────────────────────────────────────────────
  function coh(vals, P) {
    var c = 0, s = 0, k = 2 * Math.PI / P;
    for (var i = 0; i < vals.length; i++) { c += Math.cos(k * vals[i]); s += Math.sin(k * vals[i]); }
    return { m: Math.hypot(c, s) / vals.length, ph: Math.atan2(s, c) };
  }
  function bestPeriod(vals, lo, hi) {
    var best = 0, res = [], P;
    for (P = lo; P <= hi; P += 0.25) { var m = coh(vals, P).m; res.push([P, m]); if (m > best) best = m; }
    var pick = lo; res.forEach(function (r) { if (r[1] >= 0.85 * best && r[0] > pick) pick = r[0]; });   // not a harmonic
    return { P: pick, m: coh(vals, pick).m };
  }
  // Row direction th, distance between rows rowD, between trees in a row
  // sp, all in px, from a set of trees; plus how clear the pattern is (m).
  function fitLattice(P) {
    if (P.length > 6000) P = P.filter(function (p, i) { return i % Math.ceil(P.length / 6000) === 0; });
    var n = P.length, nnd = [], pairs = [], i, j;
    for (i = 0; i < n; i++) {
      var m1 = 1e9;
      for (j = 0; j < n; j++) {
        if (i === j) continue;
        var dx = P[j][0] - P[i][0], dy = P[j][1] - P[i][1];
        if (Math.abs(dx) > 60 || Math.abs(dy) > 60) continue;
        var d = Math.hypot(dx, dy); if (d < m1) m1 = d; if (j > i && d < 60) pairs.push([dx, dy, d]);
      }
      nnd.push(m1);
    }
    nnd.sort(function (a, b) { return a - b; });
    var dnn = Math.max(6, nnd[n >> 1]);
    var Hh = new Float64Array(180);
    pairs.forEach(function (q) { if (q[2] > 1.8 * dnn) return; var a = Math.atan2(q[1], q[0]) * 180 / Math.PI; a = ((a % 180) + 180) % 180; Hh[Math.round(a) % 180] += 1; });
    var Hs = new Float64Array(180);
    for (i = 0; i < 180; i++) for (var k = -3; k <= 3; k++) Hs[i] += Hh[(i + k + 180) % 180];
    var peaks = [];
    for (i = 0; i < 180; i++) if (Hs[i] >= Hs[(i + 179) % 180] && Hs[i] >= Hs[(i + 1) % 180]) peaks.push(i);
    peaks.sort(function (a, b) { return Hs[b] - Hs[a]; });
    var cands = [peaks[0]];
    for (i = 0; i < peaks.length; i++) { var dA = Math.abs(peaks[i] - peaks[0]); if (Math.min(dA, 180 - dA) >= 25) { cands.push(peaks[i]); break; } }
    var best = null;
    cands.forEach(function (c0) {
      for (var dth = -6; dth <= 6; dth += 0.5) {
        var th = (c0 + dth) * Math.PI / 180, nv = [-Math.sin(th), Math.cos(th)];
        var dv = P.map(function (p) { return p[0] * nv[0] + p[1] * nv[1]; });
        var r = bestPeriod(dv, Math.max(8, 0.7 * dnn), Math.min(60, 2.6 * dnn));
        if (!best || r.m > best.m + 0.02 || (Math.abs(r.m - best.m) <= 0.02 && r.P > best.P)) best = { th: th, P: r.P, m: r.m };
      }
    });
    var th = best.th, rowD = best.P;
    for (var dd = -0.6; dd <= 0.6; dd += 0.1) {
      var t2 = best.th + dd * Math.PI / 180, nv2 = [-Math.sin(t2), Math.cos(t2)];
      var mm = coh(P.map(function (p) { return p[0] * nv2[0] + p[1] * nv2[1]; }), rowD).m;
      if (mm > best.m) { best.m = mm; th = t2; }
    }
    var u = [Math.cos(th), Math.sin(th)], nv = [-Math.sin(th), Math.cos(th)];
    var off = coh(P.map(function (p) { return p[0] * nv[0] + p[1] * nv[1]; }), rowD).ph / (2 * Math.PI) * rowD;
    var rowsMap = {};
    P.forEach(function (p) {
      var d = p[0] * nv[0] + p[1] * nv[1], kk = Math.round((d - off) / rowD);
      if (Math.abs(d - off - kk * rowD) < 0.35 * rowD) (rowsMap[kk] || (rowsMap[kk] = [])).push(p[0] * u[0] + p[1] * u[1]);
    });
    var bestS = null;
    for (var Sp = Math.max(6, 0.6 * dnn); Sp <= Math.min(rowD * 1.25, 2.2 * dnn); Sp += 0.25) {
      var tot = 0, cnt = 0;
      Object.keys(rowsMap).forEach(function (kk) { var g = rowsMap[kk]; if (g.length < 3) return; tot += coh(g, Sp).m * g.length; cnt += g.length; });
      if (!cnt) continue;
      var mS = tot / cnt;
      if (!bestS || mS > bestS.m + 0.02 || (Math.abs(mS - bestS.m) <= 0.02 && Sp > bestS.S)) bestS = { S: Sp, m: mS };
    }
    return { u: u, nv: nv, rowD: rowD, sp: bestS ? bestS.S : dnn, off: off, m: best.m, dnn: dnn };
  }

  // Group trees into rows of the grid, mark the missing slots between
  // neighbours, and draw each row. accept(q) -> tree for a slot or null;
  // without accept (a row drawn by hand) every empty slot is a gap and
  // rows are not extended past their ends.
  function walkRows(pl, lat, pts, accept) {
    var inside = function (gx, gy) { return inPlot(pl, gx, gy); };
    var fills = [], a, j;
    pl.rows = []; pl.gaps = [];
    var rows = {};
    var centre = function (k) { return lat.cs ? lat.cs[k] : lat.off + Number(k) * lat.rowD; };
    pts.forEach(function (p) {
      var d = p[0] * lat.nv[0] + p[1] * lat.nv[1], k;
      if (lat.cs) {   // rows tracked one by one: nearest centre
        var bd = 1e9; k = null;
        Object.keys(lat.cs).forEach(function (kk) { var e = Math.abs(d - lat.cs[kk]); if (e < bd) { bd = e; k = kk; } });
        if (k === null || bd >= 0.35 * lat.rowD) return;
      } else {
        k = Math.round((d - lat.off) / lat.rowD);
        if (Math.abs(d - lat.off - k * lat.rowD) >= 0.35 * lat.rowD) return;
      }
      (rows[k] || (rows[k] = [])).push({ p: p, t: p[0] * lat.u[0] + p[1] * lat.u[1] });
    });
    Object.keys(rows).forEach(function (k) {
      var g = rows[k].sort(function (a, b) { return a.t - b.t; });
      var df = [];
      for (a = 1; a < g.length; a++) { var v = g[a].t - g[a - 1].t; if (v > 0.6 * lat.sp && v < 1.4 * lat.sp) df.push(v); }
      df.sort(function (a, b) { return a - b; });
      var spl = df.length >= 2 ? df[df.length >> 1] : lat.sp;
      var rowPts = g.map(function (o) { return o.p; });
      // between neighbours
      for (a = 0; a < g.length - 1; a++) {
        var n = Math.round((g[a + 1].t - g[a].t) / spl);
        if (n < 2 || n > 4) continue;
        for (j = 1; j < n; j++) {
          var q = [g[a].p[0] + (g[a + 1].p[0] - g[a].p[0]) * j / n, g[a].p[1] + (g[a + 1].p[1] - g[a].p[1]) * j / n];
          if (!inside(q[0], q[1])) continue;
          var z = accept ? accept(q) : null;
          if (z) { fills.push(z); rowPts.push(z); } else pl.gaps.push(q);
        }
      }
      // beyond the row ends, while the outline and the foliage go on
      if (accept && g.length >= 2) {
        [[0, -1], [g.length - 1, 1]].forEach(function (e) {
          var q = g[e[0]].p.slice();
          for (var s2 = 0; s2 < 12; s2++) {
            q = [q[0] + lat.u[0] * e[1] * spl, q[1] + lat.u[1] * e[1] * spl];
            if (!inside(q[0], q[1])) break;
            var z2 = accept(q);
            if (!z2) break;
            fills.push(z2); rowPts.push(z2);
          }
        });
      }
      // row line for display
      var ts = rowPts.map(function (p) { return p[0] * lat.u[0] + p[1] * lat.u[1]; });
      var t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts), c = centre(k);
      if (t1 - t0 > 0.9 * lat.sp) pl.rows.push({ a: [t0 * lat.u[0] + c * lat.nv[0], t0 * lat.u[1] + c * lat.nv[1]], b: [t1 * lat.u[0] + c * lat.nv[0], t1 * lat.u[1] + c * lat.nv[1]] });
    });
    return fills;
  }

  // ── One plot: crowns, grid, walk the rows ────────────────────────────
  // win: { ox, oy, W, H, strong:[x,y..], cand:[x,y..], gray } in window px.
  function processPlot(pl, win) {
    var i, x, y;
    var inside = function (gx, gy) { return inPlot(pl, gx, gy); };
    var strong = [], cand = [];
    for (i = 0; i < win.strong.length; i += 2) { x = win.strong[i] + win.ox; y = win.strong[i + 1] + win.oy; if (inside(x, y)) strong.push([x, y]); }
    for (i = 0; i < win.cand.length; i += 2) { x = win.cand[i] + win.ox; y = win.cand[i + 1] + win.oy; if (inside(x, y)) cand.push([x, y]); }
    pl.rows = []; pl.gaps = []; pl.grid = null;
    var fills = [];
    if (strong.length >= 12) {
      var lat = fitLattice(strong);
      if (lat.m >= 0.25) {
        pl.grid = { tree: lat.sp * S.mpp, row: lat.rowD * S.mpp, strength: lat.m };
        // foliage = darker than this plot's own soil (Otsu inside the plot)
        var vals = [], step = 2;
        for (y = 0; y < win.H; y += step) for (x = 0; x < win.W; x += step) if (inside(x + win.ox, y + win.oy)) vals.push(win.gray[y * win.W + x]);
        var thr = otsu(vals), r = Math.max(2, Math.round(0.15 * lat.sp));
        var evidence = function (q) {
          var cx = Math.round(q[0] - win.ox), cy = Math.round(q[1] - win.oy), n = 0, dk = 0;
          if (cx < r || cy < r || cx >= win.W - r || cy >= win.H - r) return 0;
          for (var yy = cy - r; yy <= cy + r; yy++) for (var xx = cx - r; xx <= cx + r; xx++) { n++; if (win.gray[yy * win.W + xx] < thr) dk++; }
          return dk / n;
        };
        var candNear = function (q, rad) {
          var best = null, bd = rad;
          for (var j = 0; j < cand.length; j++) { var d = Math.hypot(cand[j][0] - q[0], cand[j][1] - q[1]); if (d < bd) { bd = d; best = cand[j]; } }
          return best;
        };
        var accept = function (q) {
          var c = candNear(q, 0.3 * lat.sp), e = evidence(q);
          if (e >= 0.25 || (c && e >= 0.15)) return c || q;
          return null;
        };
        fills = walkRows(pl, lat, strong, accept);
        pl.tol = 0.4 * lat.sp;
        pl.dup = 0.45 * lat.sp;
      }
    }
    // store: confident crowns and inferred trees, one per tree
    var dupR = pl.dup || 5, nNew = 0;
    var put = function (p, auto) {
      if (nearestDet(p[0], p[1], dupR, true) >= 0) return;
      addPoint(p[0], p[1], auto); nNew++;
    };
    strong.forEach(function (p) { put(p, false); });
    fills.forEach(function (p) { put(p, true); });
    pl.filled = fills.length;
    pl.status = 'done';
    pl.auto0 = { grid: pl.grid, rows: pl.rows, gaps: pl.gaps, tol: pl.tol, dup: pl.dup };
    return nNew;
  }

  // ── Rows from a row the user marked (two taps along one row) ─────────
  // The direction comes from the line; the distance between rows and
  // between trees comes from the plot's current trees, with the rows
  // anchored on the marked line. Works where the automatic grid is weak
  // (closed canopy, narrow plots, two plantings).
  // Distance between rows from the distances of nearby trees to a line
  // along the rows: differences between trees in other rows pile up at
  // the row distance and its multiples. A comb (piles at P, 2P, 3P minus
  // the valleys between them) picks P without falling for P/2, then the
  // pile centres refine it.
  function rowPeriod(dv, near, lo, hi) {
    var x = [], df = [], i, j, k;
    for (i = 0; i < dv.length; i++) if (near[i]) x.push(dv[i]);
    x.sort(function (p, q) { return p - q; });
    var top = 55 / S.mpp;
    for (i = 0; i < x.length; i++) for (j = i + 1; j < x.length; j++) { var d = x[j] - x[i]; if (d > top) break; df.push(d); }
    if (df.length < 10) return 0;
    var w = 0.6 / S.mpp;
    var pile = function (v) { var s = 0; for (var q = 0; q < df.length; q++) { var z = (df[q] - v) / w; if (z > -3 && z < 3) s += Math.exp(-z * z / 2); } return s; };
    var best = null;
    for (var P = lo; P <= hi; P += 0.2) {
      var c = 0, nK = 0;
      for (k = 1; k <= 3; k++) { if (k * P > top) break; c += pile(k * P) - pile((k - 0.5) * P); nK++; }
      if (!nK) continue; c /= nK;
      if (!best || c > best.c) best = { P: P, c: c };
    }
    if (!best || best.c <= 0) return 0;
    var Pr = best.P;
    for (var it = 0; it < 3; it++) {
      var num = 0, den = 0;
      for (k = 1; k <= 3; k++) for (i = 0; i < df.length; i++) if (Math.abs(df[i] - k * Pr) < 0.2 * Pr) { num += df[i] / k; den++; }
      if (den) Pr = num / den;
    }
    return Pr;
  }
  function rowsFromLine(pl, a, b) {
    var P = treesOf(pl).map(function (t) { return [t[0], t[1]]; });
    var len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (P.length < 4) return { err: 'few' };
    if (len * S.mpp < 6) return { err: 'short' };
    var th0 = Math.atan2(b[1] - a[1], b[0] - a[0]);
    var u = [Math.cos(th0), Math.sin(th0)], nv = [-u[1], u[0]];
    var off = a[0] * nv[0] + a[1] * nv[1];
    var dv = P.map(function (p) { return p[0] * nv[0] + p[1] * nv[1] - off; });
    // the grid is read near the marked row (plots drift and bend), up to
    // about 30 m to each side of it and along its length
    var t0 = Math.min(a[0] * u[0] + a[1] * u[1], b[0] * u[0] + b[1] * u[1]) - 10 / S.mpp;
    var t1 = Math.max(a[0] * u[0] + a[1] * u[1], b[0] * u[0] + b[1] * u[1]) + 10 / S.mpp;
    var near = P.map(function (p, i) { var t = p[0] * u[0] + p[1] * u[1]; return Math.abs(dv[i]) < 30 / S.mpp && t > t0 && t < t1; });
    if (near.filter(Boolean).length < 8) near = P.map(function () { return true; });
    var score = function (Pd) {
      var c = 0, n = 0, k = 2 * Math.PI / Pd;
      for (var ii = 0; ii < dv.length; ii++) if (near[ii]) { c += Math.cos(k * dv[ii]); n++; }
      return n ? c / n : 0;
    };
    var lo = 3 / S.mpp, hi = 20 / S.mpp, rowD = rowPeriod(dv, near, lo, hi), best = rowD ? score(rowD) : -1;
    if (!rowD) return { err: 'nogrid' };
    // a tap is a few px off: turn the line about its first end to fit best
    var dirAt = function (th) {
      var n2 = [-Math.sin(th), Math.cos(th)], o2 = a[0] * n2[0] + a[1] * n2[1];
      return P.map(function (p) { return p[0] * n2[0] + p[1] * n2[1] - o2; });
    };
    var thB = th0, keepDv = dv;
    for (var dth = -3; dth <= 3.001; dth += 0.1) {
      var t2 = th0 + dth * Math.PI / 180; dv = dirAt(t2);
      var sc2 = score(rowD); if (sc2 > best) { best = sc2; thB = t2; keepDv = dv; }
    }
    dv = keepDv;
    u = [Math.cos(thB), Math.sin(thB)]; nv = [-u[1], u[0]]; off = a[0] * nv[0] + a[1] * nv[1];
    var tv = P.map(function (p) { return p[0] * u[0] + p[1] * u[1]; });
    // trees on the marked line give the spacing in the row
    var on = [];
    P.forEach(function (p, i) { if (Math.abs(dv[i]) < 1.5 / S.mpp) on.push(tv[i]); });
    on.sort(function (x, y) { return x - y; });
    var df = [];
    for (var i = 1; i < on.length; i++) { var v = on[i] - on[i - 1]; if (v * S.mpp > 2) df.push(v); }
    df.sort(function (x, y) { return x - y; });
    var spRow = df.length ? df[df.length >> 1] : 0;
    // distance between rows: the period of the distances to the line,
    // phase fixed at the line; the largest one that scores near best
    // (a half period scores the same)
    // spacing in the row over all rows, near the marked row's own value
    var rowsMap = {};
    P.forEach(function (p, i) {
      var kk = Math.round(dv[i] / rowD);
      if (Math.abs(dv[i] - kk * rowD) < 0.35 * rowD) (rowsMap[kk] || (rowsMap[kk] = [])).push(tv[i]);
    });
    var sLo = spRow ? 0.75 * spRow : 2 / S.mpp, sHi = spRow ? 1.3 * spRow : Math.min(rowD * 1.25, 15 / S.mpp), bestS = null;
    for (var Sp = sLo; Sp <= sHi; Sp += 0.25) {
      var tot = 0, cnt = 0;
      Object.keys(rowsMap).forEach(function (kk) { var g = rowsMap[kk]; if (g.length < 3) return; tot += coh(g, Sp).m * g.length; cnt += g.length; });
      if (!cnt) continue;
      var mS = tot / cnt;
      if (!bestS || mS > bestS.m + 0.02 || (Math.abs(mS - bestS.m) <= 0.02 && Sp > bestS.S)) bestS = { S: Sp, m: mS };
    }
    var sp = bestS ? bestS.S : (spRow || rowD);
    // follow the rows outward from the marked one, each centred on its
    // own trees, so a small error in the distance does not add up
    var dAbs = P.map(function (p) { return p[0] * nv[0] + p[1] * nv[1]; });
    var dMin = Math.min.apply(null, dAbs), dMax = Math.max.apply(null, dAbs), cs = { 0: off };
    [1, -1].forEach(function (dir) {
      var c = off, k = 0, miss = 0;
      while (miss < 3) {
        k += dir; c += dir * rowD;
        if (c < dMin - rowD || c > dMax + rowD) break;
        var sum = 0, n = 0;
        for (var q = 0; q < dAbs.length; q++) if (Math.abs(dAbs[q] - c) < 0.3 * rowD) { sum += dAbs[q]; n++; }
        if (n >= 2) { c = 0.5 * c + 0.5 * (sum / n); miss = 0; } else miss++;
        cs[k] = c;
      }
    });
    var lat = { u: u, nv: nv, rowD: rowD, sp: sp, off: off, m: best, cs: cs };
    walkRows(pl, lat, P, null);
    pl.grid = { tree: sp * S.mpp, row: rowD * S.mpp, strength: best, manual: true };
    pl.tol = 0.4 * sp; pl.dup = 0.45 * sp;
    return { ok: true, rows: pl.rows.length };
  }
  function autoRows(pl) {
    var a = pl.auto0; if (!a) return;
    pl.grid = a.grid; pl.rows = a.rows; pl.gaps = a.gaps; pl.tol = a.tol; pl.dup = a.dup;
  }

  // ── Reading the imagery under the chosen plots ───────────────────────
  function loadTile(x, y) {
    var url = TILE_URL.replace('{x}', x).replace('{y}', y);
    return fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.blob();
    }).then(function (b) { return createImageBitmap(b); });
  }
  function countPlots() {
    if (!S || S.busy) return;
    var todo = Object.keys(S.plots).map(function (k) { return S.plots[k]; }).filter(function (p) { return p.status !== 'done'; });
    if (!todo.length) { toast(tt('כל החלקות שנבחרו כבר נספרו', 'แปลงที่เลือกทั้งหมดนับแล้ว', 'كل القطع المختارة عُدّت بالفعل')); return; }
    S.busy = true; render();
    var tiles = {};
    var idx = 0;
    function next() {
      if (!S) return;
      if (idx >= todo.length) { finish(); return; }
      var pl = todo[idx++];
      var w = pl.box[2] - pl.box[0], h = pl.box[3] - pl.box[1];
      if (w > MAX_SIDE || h > MAX_SIDE) { pl.status = 'big'; setStatus('⚠️ ' + esc(pl.name) + ': ' + tt('החלקה גדולה מדי לספירה אחת', 'แปลงใหญ่เกินไปสำหรับการนับครั้งเดียว', 'القطعة كبيرة جدًا لعدّ واحد')); next(); return; }
      var ox = Math.floor(pl.box[0] - MARGIN), oy = Math.floor(pl.box[1] - MARGIN);
      var W = Math.ceil(w + 2 * MARGIN), H = Math.ceil(h + 2 * MARGIN);
      var tx0 = Math.floor(ox / TS), ty0 = Math.floor(oy / TS), tx1 = Math.floor((ox + W) / TS), ty1 = Math.floor((oy + H) / TS);
      var list = [], failed = 0, done = 0;
      for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) if (!tiles[tx + '_' + ty]) list.push([tx, ty]);
      var at = 0;
      setStatus('⏳ ' + esc(pl.name) + ': ' + tt('טוען תצלום אוויר', 'กำลังโหลดภาพถ่ายทางอากาศ', 'جارٍ تحميل الصورة الجوية'));
      function worker() {
        if (at >= list.length) return Promise.resolve();
        var t = list[at++];
        return loadTile(t[0], t[1]).then(function (bm) { tiles[t[0] + '_' + t[1]] = bm; }, function () { failed++; })
          .then(function () { done++; return worker(); });
      }
      var ws = []; for (var k = 0; k < 8; k++) ws.push(worker());
      Promise.all(ws).then(function () {
        if (!S) return;
        if (list.length && failed > list.length / 2) { pl.status = 'error'; next(); return; }
        setStatus('⏳ ' + esc(pl.name) + ': ' + tt('מאתר עצים', 'กำลังค้นหาต้นไม้', 'جارٍ تحديد الأشجار'));
        setTimeout(function () {
          if (!S) return;
          try {
            var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            var ctx = cv.getContext('2d', { willReadFrequently: true });
            for (var ty2 = ty0; ty2 <= ty1; ty2++) for (var tx2 = tx0; tx2 <= tx1; tx2++) {
              var bm = tiles[tx2 + '_' + ty2]; if (bm) ctx.drawImage(bm, tx2 * TS - ox, ty2 * TS - oy);
            }
            var d = detect(ctx.getImageData(0, 0, W, H).data, W, H);
            processPlot(pl, { ox: ox, oy: oy, W: W, H: H, strong: d.strong, cand: d.cand, gray: d.gray });
          } catch (e) { pl.status = 'error'; }
          redraw(); render();
          setTimeout(next, 0);
        }, 0);
      });
    }
    function finish() {
      Object.keys(tiles).forEach(function (k) { try { tiles[k].close(); } catch (e) {} });
      if (!S) return;
      S.busy = false;
      var bad = todo.filter(function (p) { return p.status === 'error'; }).length;
      S.status = bad
        ? '❌ ' + tt('לא ניתן לקרוא את תצלום האוויר לחלק מהחלקות. בדוק חיבור ונסה שוב.', 'อ่านภาพถ่ายทางอากาศของบางแปลงไม่ได้ ตรวจสอบการเชื่อมต่อแล้วลองใหม่', 'تعذرت قراءة الصورة الجوية لبعض القطع. تحقق من الاتصال وحاول مجددًا.')
        : '✅ ' + tt('הספירה הסתיימה. בדוק את הנקודות והרווחים בכל חלקה ועדכן.', 'นับเสร็จแล้ว ตรวจจุดและช่องว่างในแต่ละแปลงแล้วอัปเดต', 'انتهى العدّ. راجع النقاط والفجوات في كل قطعة ثم حدّث.');
      if (!S.active) { var f = todo.filter(function (p) { return p.status === 'done'; })[0]; if (f) S.active = f.id; }
      setMode('trees');
      if (S.active && S.plots[S.active]) zoomToPlot(S.plots[S.active]);
    }
    next();
  }

  // ── Stats per plot ───────────────────────────────────────────────────
  function openGaps(pl) {
    var tol = pl.tol || 6;
    return (pl.gaps || []).filter(function (q) { return !hasTree(q[0], q[1], tol); });
  }
  function stats(pl) {
    var trees = treesOf(pl), area = pl.area || 0, rej = 0, auto = 0;
    eachInRect(pl.box[0], pl.box[1], pl.box[2], pl.box[3], function (k, x, y) {
      if (!inPlot(pl, x, y)) return;
      if (S.rej[k]) rej++; else if (S.auto[k]) auto++;
    });
    var gaps = pl.grid ? openGaps(pl).length : null;
    return { trees: trees.length, added: trees.filter(function (t) { return t[2] < 0; }).length, rejected: rej, auto: auto, gaps: gaps, areaDn: area };
  }
  function fieldsOf(pl) {
    var s = stats(pl), f = { tree_count: s.trees };
    if (pl.grid) {
      f.missing_trees = s.gaps;
      f.tree_spacing = Math.round(pl.grid.tree * 10) / 10;
      f.row_spacing = Math.round(pl.grid.row * 10) / 10;
      f.plants_per_dunam = Math.round(1000 / (pl.grid.tree * pl.grid.row));
    }
    return f;
  }

  // ── Review tools ─────────────────────────────────────────────────────
  function activePlot() { return S.active ? S.plots[S.active] : null; }
  function fillGaps() {
    var pl = activePlot(); if (!pl) return;
    var g = openGaps(pl); if (!g.length) { toast(tt('אין רווחים למילוי', 'ไม่มีช่องว่างให้เติม', 'لا توجد فجوات للملء')); return; }
    snapshot();
    g.forEach(function (q) { S.added.push([q[0], q[1]]); });
    afterChange();
    toast('✅ ' + g.length + ' ' + tt('רווחים מולאו בעצים', 'ช่องว่างถูกเติมด้วยต้นไม้', 'فجوات مُلئت بأشجار'));
  }
  function rejectOffRow() {
    var pl = activePlot(); if (!pl || !pl.rows.length) { toast('⚠️ ' + tt('לא נמצאו שורות בחלקה הזו', 'ไม่พบแถวในแปลงนี้', 'لم تُعثر على صفوف في هذه القطعة')); return; }
    var tol = Math.max(1.5 / S.mpp, 0.3 * (pl.grid.row / S.mpp)), n = 0;
    snapshot();
    treesOf(pl).forEach(function (t) {
      if (t[2] < 0) return;
      var md = 1e9; pl.rows.forEach(function (r) { var d = segDist(t[0], t[1], r.a, r.b); if (d < md) md = d; });
      if (md > tol) { S.rej[t[2]] = 1; n++; }
    });
    if (!n) { S.undo.pop(); toast(tt('אין נקודות מחוץ לשורות', 'ไม่มีจุดนอกแถว', 'لا نقاط خارج الصفوف')); return; }
    afterChange();
    toast('🚫 ' + n + ' ' + tt('נקודות מחוץ לשורות נדחו', 'จุดนอกแถวถูกปฏิเสธ', 'نقاط خارج الصفوف رُفضت'));
  }
  function restorePlot() {
    var pl = activePlot(); if (!pl) return;
    var n = 0; snapshot();
    eachInRect(pl.box[0], pl.box[1], pl.box[2], pl.box[3], function (k, x, y) { if (S.rej[k] && inPlot(pl, x, y)) { delete S.rej[k]; n++; } });
    var before = S.added.length;
    S.added = S.added.filter(function (q) { return !inPlot(pl, q[0], q[1]); });
    n += before - S.added.length;
    if (!n) { S.undo.pop(); return; }
    afterChange();
  }

  // ── Undo ─────────────────────────────────────────────────────────────
  function snapshot() {
    S.undo.push(JSON.stringify({ rej: Object.keys(S.rej), added: S.added }));
    if (S.undo.length > 60) S.undo.shift();
  }
  function undo() {
    var u = S.undo.pop(); if (!u) return;
    u = JSON.parse(u);
    S.rej = {}; u.rej.forEach(function (k) { S.rej[k] = 1; });
    S.added = u.added;
    afterChange();
  }
  function afterChange() { redraw(); render(); }

  // ── Map layers ───────────────────────────────────────────────────────
  function ensureLayers() {
    var m = getMap(); if (!m || S.layers) return;
    S.renderer = L.canvas({ padding: 0.3 });
    S.layers = { plots: L.layerGroup().addTo(m), rows: L.layerGroup().addTo(m), dots: L.layerGroup().addTo(m) };
    S.onMove = function () { clearTimeout(S.mvT); S.mvT = setTimeout(drawDots, 120); };
    m.on('moveend zoomend', S.onMove);
    S.onClick = function (e) { onMapClick(e); };
    m.on('click', S.onClick);
  }
  function removeLayers() {
    var m = getMap(); if (!m || !S.layers) return;
    Object.keys(S.layers).forEach(function (k) { m.removeLayer(S.layers[k]); });
    m.off('moveend zoomend', S.onMove); m.off('click', S.onClick);
    S.layers = null;
  }
  function drawPlots() {
    var g = S.layers.plots; g.clearLayers();
    Object.keys(S.plots).forEach(function (id) {
      var pl = S.plots[id], act = String(S.active) === String(id);
      pl.rings.forEach(function (r) {
        L.polygon(r.map(function (q) { return toLL(q[0], q[1]); }), {
          color: act ? '#ffffff' : '#3fd0ff', weight: act ? 3.5 : 2.5, dashArray: pl.status === 'done' ? null : '7 6',
          fillColor: '#3fd0ff', fillOpacity: pl.status === 'done' ? 0.04 : 0.15, interactive: false
        }).addTo(g);
      });
    });
  }
  function drawRows() {
    var g = S.layers.rows; g.clearLayers();
    Object.keys(S.plots).forEach(function (id) {
      (S.plots[id].rows || []).forEach(function (r) {
        L.polyline([toLL(r.a[0], r.a[1]), toLL(r.b[0], r.b[1])], { color: '#3fd0ff', weight: 1.5, opacity: 0.7, interactive: false }).addTo(g);
      });
    });
    if (S.rowDraw && S.rowDraw.a) {
      L.circleMarker(toLL(S.rowDraw.a[0], S.rowDraw.a[1]), { radius: 9, color: '#ffe600', weight: 3, fill: false, interactive: false }).addTo(g);
    }
  }
  function drawDots() {
    if (!S || !S.layers) return;
    var m = getMap(), g = S.layers.dots; g.clearLayers();
    var b = m.getBounds(), a = toPx(b.getNorth(), b.getWest()), c = toPx(b.getSouth(), b.getEast());
    var n = 0; eachInRect(a.x, a.y, c.x, c.y, function () { n++; });
    S.tooMany = n > MAX_DRAW;
    var rad = m.getZoom() >= 19 ? 4 : 3;
    if (!S.tooMany) {
      eachInRect(a.x, a.y, c.x, c.y, function (k, x, y) {
        var rej = !!S.rej[k], au = !!S.auto[k];
        L.circleMarker(toLL(x, y), {
          renderer: S.renderer, radius: rad, weight: au ? 2 : 1, interactive: false,
          color: rej ? '#bbb' : (au ? '#ffd0c0' : '#fff'), fillColor: rej ? '#444' : (au ? '#ff7a45' : '#ff2a2a'),
          fillOpacity: rej ? 0.5 : 0.95, dashArray: rej ? '2 2' : null
        }).addTo(g);
      });
      Object.keys(S.plots).forEach(function (id) {
        openGaps(S.plots[id]).forEach(function (q) {
          L.circleMarker(toLL(q[0], q[1]), { renderer: S.renderer, radius: rad + 2.5, weight: 2, color: '#ff9f1c', fill: false, interactive: false }).addTo(g);
        });
      });
    }
    S.added.forEach(function (q) {
      L.circleMarker(toLL(q[0], q[1]), { renderer: S.renderer, radius: rad + 0.5, weight: 1, color: '#fff', fillColor: '#1e90ff', fillOpacity: 1, interactive: false }).addTo(g);
    });
    var note = document.getElementById('tmZoomNote');
    if (note) note.style.display = S.tooMany ? '' : 'none';
  }
  function redraw() { if (!S || !S.layers) return; drawPlots(); drawRows(); drawDots(); }

  // ── Map clicks ───────────────────────────────────────────────────────
  function plotUnderTap(lat, lng) {
    var list = (window.MapAccess && MapAccess.listPlotsWithRings) ? MapAccess.listPlotsWithRings() : [];
    var p = toPx(lat, lng);
    for (var i = 0; i < list.length; i++) {
      var r = list[i].rings.map(function (ring) { return ring.map(function (c) { var q = toPx(c.lat, c.lng); return [q.x, q.y]; }); });
      for (var j = 0; j < r.length; j++) if (inRing(p.x, p.y, r[j])) return { info: list[i], rings: r };
    }
    return null;
  }
  function togglePlot(hit) {
    var id = String(hit.info.id);
    if (S.plots[id]) {
      if (S.plots[id].status === 'done' && !window.confirm(tt('להסיר את החלקה מהספירה? התיקונים שעשית בה יאבדו.', 'นำแปลงออกจากการนับ? การแก้ไขในแปลงนี้จะหายไป', 'إزالة القطعة من العدّ؟ ستضيع تعديلاتك فيها.'))) return;
      dropPlot(id);
    } else {
      S.plots[id] = { id: id, name: hit.info.name || ('#' + id), rings: hit.rings, box: bboxOf(hit.rings), status: 'pending',
                      area: hit.info.measured || hit.info.declared || 0, current: hit.info.trees || 0, rows: [], gaps: [], grid: null };
      if (!S.mpp) S.mpp = mppAt(hit.info.rings[0][0].lat);
    }
    redraw(); render();
  }
  function dropPlot(id) {
    var pl = S.plots[id]; if (!pl) return;
    // forget its dots so a later count starts clean
    var keep = [], keepAuto = [], rejKeep = {};
    for (var k = 0; k < S.px.length / 2; k++) {
      var x = S.px[2 * k], y = S.px[2 * k + 1];
      if (inPlot(pl, x, y)) continue;
      if (S.rej[k]) rejKeep[keep.length / 2] = 1;
      if (S.auto[k]) keepAuto.push(keep.length / 2);
      keep.push(x, y);
    }
    S.px = []; S.bk = {}; S.auto = {};
    for (var i = 0; i < keep.length; i += 2) addPoint(keep[i], keep[i + 1], false);
    keepAuto.forEach(function (k2) { S.auto[k2] = 1; });
    S.rej = rejKeep;
    S.added = S.added.filter(function (q) { return !inPlot(pl, q[0], q[1]); });
    S.undo = [];
    delete S.plots[id];
    if (S.rowDraw && S.rowDraw.id === String(id)) S.rowDraw = null;
    if (String(S.active) === String(id)) S.active = null;
  }
  function onMapClick(e) {
    if (!S || S.busy) return;
    var p = toPx(e.latlng.lat, e.latlng.lng), m = getMap();
    if (S.mode === 'select') {
      var hit = plotUnderTap(e.latlng.lat, e.latlng.lng);
      if (!hit) { toast(tt('הקש בתוך חלקה כדי לבחור אותה', 'แตะในแปลงเพื่อเลือก', 'انقر داخل قطعة لاختيارها')); return; }
      togglePlot(hit); return;
    }
    if (S.mode !== 'trees') return;
    var pl = plotAt(p.x, p.y);
    if (!pl || pl.status !== 'done') { toast(tt('אפשר לערוך עצים רק בתוך חלקה שנספרה', 'แก้ไขต้นไม้ได้เฉพาะในแปลงที่นับแล้ว', 'يمكن تحرير الأشجار داخل قطعة معدودة فقط')); return; }
    if (S.tooMany) { toast('🔍 ' + tt('התקרב כדי לערוך עצים', 'ซูมเข้าเพื่อแก้ไขต้นไม้', 'قرّب لتحرير الأشجار')); return; }
    var tol = 14 * Math.pow(2, Z - m.getZoom());
    if (S.rowDraw) { rowTap(pl, p, tol); return; }
    if (String(S.active) !== pl.id) { S.active = pl.id; render(); drawPlots(); }
    // whatever is nearest the tap wins: a tree you added, a gap, a dot
    var hitT = null, hd = tol;
    S.added.forEach(function (q, i) { var d = Math.hypot(q[0] - p.x, q[1] - p.y); if (d < hd) { hd = d; hitT = { t: 'add', i: i }; } });
    openGaps(pl).forEach(function (q) { var d = Math.hypot(q[0] - p.x, q[1] - p.y); if (d < hd) { hd = d; hitT = { t: 'gap', q: q }; } });
    var kd = nearestDet(p.x, p.y, hd, true);
    if (kd >= 0) hitT = { t: 'det', k: kd };
    snapshot();
    if (hitT && hitT.t === 'add') S.added.splice(hitT.i, 1);
    else if (hitT && hitT.t === 'gap') S.added.push(hitT.q.slice());
    else if (hitT && hitT.t === 'det') { if (S.rej[hitT.k]) delete S.rej[hitT.k]; else S.rej[hitT.k] = 1; }
    else S.added.push([p.x, p.y]);
    afterChange();
  }
  // Marking a row: first tap = a tree at one end, second = a tree at the
  // other end of the same row. Taps snap to the nearest tree.
  function rowTap(pl, p, tol) {
    if (pl.id !== S.rowDraw.id) { toast(tt('סמן את השורה בתוך החלקה', 'ทำเครื่องหมายแถวภายในแปลง', 'حدّد الصف داخل القطعة')); return; }
    var q = [p.x, p.y], best = null, bd = tol;
    treesOf(pl).forEach(function (t) { var d = Math.hypot(t[0] - p.x, t[1] - p.y); if (d < bd) { bd = d; best = t; } });
    if (best) q = [best[0], best[1]];
    if (!S.rowDraw.a) { S.rowDraw.a = q; drawRows(); render(); return; }
    var a = S.rowDraw.a; S.rowDraw = null;
    var r = rowsFromLine(pl, a, q);
    if (r.err === 'short') toast('⚠️ ' + tt('השורה קצרה מדי. הקש על שני עצים רחוקים באותה שורה.', 'แถวสั้นเกินไป แตะต้นไม้สองต้นที่อยู่ห่างกันในแถวเดียวกัน', 'الصف قصير جدًا. انقر على شجرتين متباعدتين في نفس الصف.'));
    else if (r.err === 'few') toast('⚠️ ' + tt('אין מספיק עצים בחלקה. הוסף עצים ונסה שוב.', 'มีต้นไม้ในแปลงไม่พอ เพิ่มต้นไม้แล้วลองอีกครั้ง', 'لا توجد أشجار كافية في القطعة. أضف أشجارًا وحاول مجددًا.'));
    else if (r.err) toast('⚠️ ' + tt('העצים לא מסתדרים בשורות לאורך הקו הזה. נסה שורה אחרת.', 'ต้นไม้ไม่เรียงเป็นแถวตามเส้นนี้ ลองแถวอื่น', 'الأشجار لا تصطف في صفوف على طول هذا الخط. جرّب صفًا آخر.'));
    else toast('〰️ ' + r.rows + ' ' + tt('שורות', 'แถว', 'صفوف') + ' · ' + fmt(pl.grid.tree, 1) + '×' + fmt(pl.grid.row, 1) + ' ' + tt('מ׳', 'ม.', 'م'));
    afterChange();
  }
  function setMode(mode) {
    S.mode = mode;
    S.rowDraw = null;
    if (window.MapAccess && MapAccess.setExternalDraw) MapAccess.setExternalDraw(mode === 'select' || mode === 'trees');
    redraw(); render();
  }
  function selectAllInView() {
    var m = getMap(), list = (window.MapAccess && MapAccess.listPlotsWithRings) ? MapAccess.listPlotsWithRings() : [];
    var b = m.getBounds(), n = 0;
    list.forEach(function (info) {
      if (!info.rings.length || S.plots[String(info.id)]) return;
      if (!b.contains(L.latLngBounds(info.rings[0]).getCenter())) return;
      var rings = info.rings.map(function (ring) { return ring.map(function (c) { var q = toPx(c.lat, c.lng); return [q.x, q.y]; }); });
      togglePlot({ info: info, rings: rings }); n++;
    });
    if (!n) toast(tt('אין חלקות נוספות בתצוגה', 'ไม่มีแปลงเพิ่มเติมในมุมมอง', 'لا توجد قطع أخرى في العرض'));
  }
  function zoomToPlot(pl) {
    var m = getMap(), el = document.getElementById('tmPanel'); if (!m) return;
    var ph = (el && el.style.display !== 'none') ? el.getBoundingClientRect().height : 0;
    var bb = L.latLngBounds([toLL(pl.box[0], pl.box[1]), toLL(pl.box[2], pl.box[3])]);
    try { m.fitBounds(bb, { paddingTopLeft: [24, 24], paddingBottomRight: [24, ph + 24], maxZoom: 19 }); } catch (e) {}
  }

  // ── Update plots ─────────────────────────────────────────────────────
  function readNum(id, lo, hi) {
    var el = document.getElementById(id); if (!el || el.value === '') return null;
    var v = parseFloat(el.value); return (isFinite(v) && v >= lo && v <= hi) ? v : NaN;
  }
  function updateOne() {
    if (!isAdmin()) { if (window.Own) Own.denied(); return; }
    var pl = activePlot(); if (!pl) return;
    var f = {
      tree_count: readNum('tmFTrees', 0, 1000000), missing_trees: readNum('tmFMissing', 0, 1000000),
      tree_spacing: readNum('tmFTreeSp', 0.5, 30), row_spacing: readNum('tmFRowSp', 0.5, 30), plants_per_dunam: readNum('tmFPpd', 1, 100000)
    };
    if (Object.keys(f).some(function (k) { return f[k] !== null && isNaN(f[k]); })) { toast('⚠️ ' + tt('ערך לא תקין', 'ค่าไม่ถูกต้อง', 'قيمة غير صالحة')); return; }
    var r = MapAccess.updatePlotTreeData ? MapAccess.updatePlotTreeData(Number(pl.id), f, null) : { ok: false };
    if (!r || !r.ok) { toast('❌ ' + tt('עדכון החלקה נכשל', 'อัปเดตแปลงไม่สำเร็จ', 'فشل تحديث القطعة')); return; }
    pl.saved = true; if (f.tree_count != null) pl.current = f.tree_count;
    toast('✅ ' + esc(pl.name) + ': ' + tt('החלקה עודכנה', 'อัปเดตแปลงแล้ว', 'تم تحديث القطعة'));
    render();
  }
  function updateTicked() {
    if (!isAdmin()) { if (window.Own) Own.denied(); return; }
    var ids = Object.keys(S.plots).filter(function (id) { var p = S.plots[id]; return p.status === 'done' && p.tick; });
    if (!ids.length) { toast('⚠️ ' + tt('לא סומנו חלקות לעדכון', 'ไม่ได้เลือกแปลงที่จะอัปเดต', 'لم تُحدَّد قطع للتحديث')); return; }
    if (!window.confirm(tt('לעדכן', 'อัปเดต', 'تحديث') + ' ' + ids.length + ' ' + tt('חלקות במספרים שנמדדו?', 'แปลงด้วยค่าที่วัดได้?', 'قطع بالأرقام المقاسة؟'))) return;
    var ok = 0;
    ids.forEach(function (id) {
      var pl = S.plots[id], f = fieldsOf(pl);
      var r = MapAccess.updatePlotTreeData ? MapAccess.updatePlotTreeData(Number(id), f, null) : { ok: false };
      if (r && r.ok) { ok++; pl.saved = true; pl.current = f.tree_count; }
    });
    toast((ok === ids.length ? '✅ ' : '⚠️ ') + ok + '/' + ids.length + ' ' + tt('חלקות עודכנו', 'แปลงอัปเดตแล้ว', 'قطع حُدّثت'));
    render();
  }

  // ── Panel ────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('tmStyles')) return;
    var st = document.createElement('style');
    st.id = 'tmStyles';
    st.textContent =
      '.tm-panel{position:fixed;left:8px;right:8px;bottom:8px;max-height:52vh;overflow:auto;z-index:1500;' +
      'background:var(--card,#fff);color:var(--text,#1b1b1b);border-radius:16px;box-shadow:0 6px 28px rgba(0,0,0,.28);' +
      'padding:0 14px 12px;font-family:Heebo,sans-serif;font-size:14px;max-width:600px;margin:0 auto}' +
      '@media (max-width:600px){.tm-panel{max-height:44vh}}' +
      '.tm-head{position:sticky;top:0;background:var(--card,#fff);display:flex;gap:6px;align-items:center;padding:10px 0 6px;z-index:2}' +
      '.tm-head h3{margin:0;font-size:16px;flex:1}' +
      '.tm-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:7px 0}' +
      '.tm-btn{border:0;border-radius:10px;padding:8px 11px;font:inherit;font-weight:600;cursor:pointer;background:var(--g5,#e8f5e9);color:var(--g1,#1b5e20)}' +
      '.tm-btn.pri{background:var(--g2,#2e7d32);color:#fff}.tm-btn:disabled{opacity:.45;cursor:default}' +
      '.tm-btn.on{background:#0a6fa0;color:#fff}.tm-btn.big{flex:1;padding:12px 8px}' +
      '.tm-seg{display:flex;gap:4px;flex:1}.tm-seg .tm-btn{flex:1}' +
      '.tm-help{font-size:12.5px;opacity:.78;line-height:1.45;margin:4px 0}' +
      '.tm-hint{opacity:1;background:#fff6c2;color:#4a3b00;border-radius:8px;padding:6px 8px}' +
      '.tm-status{font-size:13px;margin:6px 0;line-height:1.4}' +
      '.tm-list{width:100%;border-collapse:collapse;font-size:13px;margin:6px 0}' +
      '.tm-list td,.tm-list th{padding:6px 4px;border-bottom:1px solid rgba(0,0,0,.08);text-align:center;white-space:nowrap}' +
      '.tm-list th{font-size:11.5px;opacity:.7;font-weight:600}' +
      '.tm-list td.nm{text-align:start;font-weight:700;white-space:normal;cursor:pointer}' +
      '.tm-list tr.act{background:rgba(10,111,160,.09)}' +
      '.tm-x{background:none;border:0;font-size:15px;cursor:pointer;padding:0 4px}' +
      '.tm-form{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin:6px 0}' +
      '.tm-form label{font-size:12px;opacity:.85;display:flex;flex-direction:column;gap:2px}' +
      '.tm-panel input[type=number]{font:inherit;padding:7px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.18);' +
      'background:var(--card,#fff);color:inherit;min-width:0;width:100%;box-sizing:border-box}' +
      '.tm-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;opacity:.85}' +
      '.tm-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-inline-end:4px;vertical-align:-1px}' +
      '.tm-pill{position:fixed;bottom:70px;left:12px;z-index:1500;border:0;border-radius:20px;padding:9px 14px;' +
      'font:600 14px Heebo,sans-serif;background:#0a6fa0;color:#fff;box-shadow:0 3px 12px rgba(0,0,0,.3)}';
    document.head.appendChild(st);
  }
  function panelEl() {
    var el = document.getElementById('tmPanel');
    if (!el) {
      el = document.createElement('div'); el.id = 'tmPanel'; el.className = 'tm-panel';
      (document.getElementById('tabMap') || document.body).appendChild(el);
      el.addEventListener('click', onPanelClick);
      el.addEventListener('change', onPanelChange);
    }
    return el;
  }
  function pillEl() {
    var p = document.getElementById('tmPill');
    if (!p) {
      p = document.createElement('button'); p.id = 'tmPill'; p.className = 'tm-pill';
      p.addEventListener('click', function () { setMinimized(false); });
      (document.getElementById('tabMap') || document.body).appendChild(p);
    }
    return p;
  }
  function setMinimized(on) {
    S.minimized = on;
    panelEl().style.display = on ? 'none' : '';
    var p = pillEl(); p.style.display = on ? '' : 'none';
    p.textContent = '🌴 ' + tt('ספירת עצים', 'นับต้นไม้', 'عدّ الأشجار');
    if (!on) render();
  }
  function setStatus(t) { if (!S) return; S.status = t; var el = document.getElementById('tmStatus'); if (el) el.textContent = t; else render(); }
  function render() {
    if (!S || S.minimized) return;
    var el = panelEl(); el.setAttribute('dir', isRtl() ? 'rtl' : 'ltr');
    var mm = tt('מ׳', 'ม.', 'م');
    var ids = Object.keys(S.plots), nDone = ids.filter(function (id) { return S.plots[id].status === 'done'; }).length;
    var nPending = ids.length - nDone;
    var h = '<div class="tm-head"><h3>🌴 ' + tt('ספירת עצים בחלקות', 'นับต้นไม้ในแปลง', 'عدّ الأشجار في القطع') + '</h3>' +
      '<button class="tm-btn" data-act="undo"' + (S.undo.length ? '' : ' disabled') + ' title="' + esc(tt('בטל', 'เลิกทำ', 'تراجع')) + '">↶</button>' +
      '<button class="tm-btn" data-act="min" title="' + esc(tt('מזער', 'ย่อ', 'تصغير')) + '">▾</button>' +
      '<button class="tm-btn" data-act="close" title="' + esc(tt('סגור', 'ปิด', 'إغلاق')) + '">✕</button></div>';
    h += '<div class="tm-row"><div class="tm-seg">' +
      '<button class="tm-btn' + (S.mode === 'select' ? ' on' : '') + '" data-act="mode" data-m="select">☑️ ' + tt('בחירת חלקות', 'เลือกแปลง', 'اختيار القطع') + '</button>' +
      '<button class="tm-btn' + (S.mode === 'trees' ? ' on' : '') + '" data-act="mode" data-m="trees"' + (nDone ? '' : ' disabled') + '>🌴 ' + tt('עריכת עצים', 'แก้ไขต้นไม้', 'تحرير الأشجار') + '</button>' +
      '<button class="tm-btn' + (S.mode === 'pan' ? ' on' : '') + '" data-act="mode" data-m="pan">✋ ' + tt('מפה', 'แผนที่', 'الخريطة') + '</button></div></div>';
    if (S.mode === 'select') {
      h += '<p class="tm-help">' + tt(
        'הקש על החלקות שברצונך לספור (הקשה נוספת מבטלת). רק השטח שבתוך החלקות שנבחרו נקרא ונספר. החישוב נעשה במכשיר, בלי עלות.',
        'แตะแปลงที่ต้องการนับ (แตะอีกครั้งเพื่อยกเลิก) จะอ่านและนับเฉพาะพื้นที่ภายในแปลงที่เลือก การคำนวณทำบนอุปกรณ์ ไม่มีค่าใช้จ่าย',
        'انقر على القطع التي تريد عدّها (نقرة أخرى تلغي). تُقرأ وتُعدّ المساحة داخل القطع المختارة فقط. يتم الحساب على الجهاز دون تكلفة.') + '</p>';
      h += '<div class="tm-row"><button class="tm-btn" data-act="all">' + tt('בחר את כל החלקות בתצוגה', 'เลือกทุกแปลงในมุมมอง', 'اختر كل القطع في العرض') + '</button></div>';
    }
    if (S.mode === 'trees') {
      h += '<p class="tm-help">' + tt(
        'הקש על נקודה כדי לדחות אותה (לא עץ), ושוב כדי להחזיר. הקש על קרקע ריקה בתוך החלקה כדי להוסיף עץ, ועל נקודה כחולה כדי להסיר אותו. הקש על טבעת כתומה כדי לשים בה עץ.',
        'แตะจุดเพื่อปฏิเสธ (ไม่ใช่ต้นไม้) แตะอีกครั้งเพื่อคืน แตะพื้นว่างในแปลงเพื่อเพิ่มต้นไม้ แตะจุดสีน้ำเงินเพื่อลบ แตะวงสีส้มเพื่อใส่ต้นไม้',
        'انقر على نقطة لرفضها (ليست شجرة)، ومرة أخرى لإعادتها. انقر على أرض فارغة داخل القطعة لإضافة شجرة، وعلى نقطة زرقاء لإزالتها. انقر على حلقة برتقالية لوضع شجرة فيها.') + '</p>';
      h += '<div class="tm-help" id="tmZoomNote" style="display:' + (S.tooMany ? '' : 'none') + '">🔍 ' + tt('התקרב כדי לראות ולערוך עצים בודדים', 'ซูมเข้าเพื่อดูและแก้ไขต้นไม้แต่ละต้น', 'قرّب لرؤية الأشجار الفردية وتحريرها') + '</div>';
      h += '<div class="tm-legend"><span><i style="background:#ff2a2a"></i>' + tt('זוהה', 'ตรวจพบ', 'مكتشفة') + '</span>' +
        '<span><i style="background:#ff7a45;box-shadow:0 0 0 2px #ffd0c0"></i>' + tt('הושלם לפי השורה', 'เติมตามแถว', 'أُكملت حسب الصف') + '</span>' +
        '<span><i style="background:#1e90ff"></i>' + tt('נוסף ידנית', 'เพิ่มเอง', 'أُضيف يدويًا') + '</span>' +
        '<span><i style="background:#555"></i>' + tt('נדחה', 'ปฏิเสธ', 'مرفوض') + '</span>' +
        '<span><i style="border:2px solid #ff9f1c;box-sizing:border-box"></i>' + tt('עץ חסר', 'ต้นที่ขาด', 'شجرة ناقصة') + '</span></div>';
    }
    h += '<div class="tm-status" id="tmStatus">' + esc(S.status || '') + '</div>';

    if (ids.length) {
      h += '<table class="tm-list"><tr><th></th><th style="text-align:start">' + tt('חלקה', 'แปลง', 'القطعة') + '</th><th>' + tt('עצים', 'ต้น', 'أشجار') + '</th><th>' + tt('חסרים', 'ขาด', 'ناقصة') + '</th><th>' + tt('מרווח', 'ระยะ', 'المسافة') + '</th><th>' + tt('בכרטיס', 'ในบัตร', 'في البطاقة') + '</th><th></th></tr>';
      ids.forEach(function (id) {
        var pl = S.plots[id], s = pl.status === 'done' ? stats(pl) : null;
        var stTxt = pl.status === 'pending' ? tt('ממתינה', 'รอ', 'بانتظار') : pl.status === 'big' ? tt('גדולה מדי', 'ใหญ่เกินไป', 'كبيرة جدًا') : pl.status === 'error' ? tt('שגיאה', 'ผิดพลาด', 'خطأ') : '';
        h += '<tr class="' + (String(S.active) === id ? 'act' : '') + '">' +
          '<td>' + (s ? '<input type="checkbox" data-tick="' + esc(id) + '"' + (pl.tick ? ' checked' : '') + '>' : '') + '</td>' +
          '<td class="nm" data-act="focus" data-id="' + esc(id) + '">' + esc(pl.name) + (pl.saved ? ' ✔' : '') + '</td>' +
          (s ? '<td>' + fmt(s.trees) + '</td><td>' + (s.gaps != null ? fmt(s.gaps) : '–') + '</td><td dir="ltr">' + (pl.grid ? fmt(pl.grid.tree, 1) + '×' + fmt(pl.grid.row, 1) : '–') + '</td>'
             : '<td colspan="3" style="opacity:.6">' + stTxt + '</td>') +
          '<td style="opacity:.7">' + (pl.current ? fmt(pl.current) : '–') + '</td>' +
          '<td><button class="tm-x" data-act="drop" data-id="' + esc(id) + '" title="' + esc(tt('הסר מהרשימה', 'นำออกจากรายการ', 'أزل من القائمة')) + '">✕</button></td></tr>';
      });
      h += '</table>';
    } else if (S.mode === 'select') {
      h += '<p class="tm-help" style="opacity:.6">' + tt('לא נבחרו חלקות', 'ยังไม่ได้เลือกแปลง', 'لم تُختر قطع') + '</p>';
    }
    h += '<div class="tm-row"><button class="tm-btn pri big" data-act="count"' + (S.busy || !nPending ? ' disabled' : '') + '>🛰️ ' +
      tt('ספור עצים', 'นับต้นไม้', 'عُدّ الأشجار') + (nPending ? ' (' + nPending + ')' : '') + '</button></div>';

    var pl = activePlot();
    if (pl && pl.status === 'done') {
      var s2 = stats(pl), f = fieldsOf(pl);
      h += '<div style="border-top:1px solid rgba(0,0,0,.1);margin-top:8px;padding-top:6px">';
      h += '<div class="tm-row"><b style="flex:1">' + esc(pl.name) + '</b><span class="tm-help">' +
        fmt(s2.auto) + ' ' + tt('הושלמו', 'เติม', 'أُكملت') + ' · ' + fmt(s2.added) + ' ' + tt('נוספו', 'เพิ่ม', 'أُضيفت') + ' · ' + fmt(s2.rejected) + ' ' + tt('נדחו', 'ปฏิเสธ', 'رُفضت') + '</span></div>';
      if (!pl.grid) {
        h += '<p class="tm-help">' + tt('לא נמצאו שורות נטיעה ברורות בחלקה הזו, לכן אין הערכת חסרים ומרווחים. מספר העצים הוא הנקודות שזוהו.',
          'ไม่พบแถวปลูกที่ชัดเจนในแปลงนี้ จึงไม่มีการประเมินต้นที่ขาดและระยะ จำนวนต้นคือจุดที่ตรวจพบ',
          'لم تُعثر على صفوف زراعة واضحة في هذه القطعة، لذا لا يوجد تقدير للناقص والمسافات. عدد الأشجار هو النقاط المكتشفة.') + ' ' +
          tt('סמן שורה אחת ביד והשורות יושלמו לפיה.', 'ทำเครื่องหมายหนึ่งแถวด้วยมือ แล้วแถวอื่นจะถูกเติมตามนั้น', 'حدّد صفًا واحدًا يدويًا وستُستكمل الصفوف وفقه.') + '</p>';
      }
      if (S.rowDraw && S.rowDraw.id === pl.id) {
        h += '<p class="tm-help tm-hint">📏 ' + (S.rowDraw.a
          ? tt('עכשיו הקש על עץ בקצה השני של אותה שורה (כמה שיותר רחוק).', 'ตอนนี้แตะต้นไม้ที่ปลายอีกด้านของแถวเดียวกัน (ยิ่งไกลยิ่งดี)', 'الآن انقر على شجرة في الطرف الآخر من نفس الصف (أبعد ما يمكن).')
          : tt('הקש על עץ בקצה של שורה אחת.', 'แตะต้นไม้ที่ปลายแถวหนึ่ง', 'انقر على شجرة في طرف صف واحد.')) +
          ' <button class="tm-btn" data-act="rowCancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></p>';
      } else {
        h += '<div class="tm-row"><button class="tm-btn" data-act="rowline">📏 ' + tt('סמן שורה ביד', 'ทำเครื่องหมายแถวด้วยมือ', 'حدّد صفًا يدويًا') + '</button>' +
          ((pl.grid && pl.grid.manual && pl.auto0 && pl.auto0.grid) ? '<button class="tm-btn" data-act="autorows">↺ ' + tt('חזור לשורות האוטומטיות', 'กลับไปใช้แถวอัตโนมัติ', 'عُد إلى الصفوف التلقائية') + '</button>' : '') + '</div>';
      }
      h += '<div class="tm-row"><button class="tm-btn" data-act="fill"' + (s2.gaps ? '' : ' disabled') + '>➕ ' + tt('מלא את כל החסרים', 'เติมที่ขาดทั้งหมด', 'املأ كل الناقص') + '</button>' +
        '<button class="tm-btn" data-act="offrow"' + (pl.rows.length ? '' : ' disabled') + '>🚫 ' + tt('דחה מחוץ לשורות', 'ปฏิเสธนอกแถว', 'ارفض خارج الصفوف') + '</button>' +
        '<button class="tm-btn" data-act="restore">' + tt('בטל תיקונים בחלקה', 'ยกเลิกการแก้ไขในแปลง', 'ألغِ التعديلات في القطعة') + '</button></div>';
      h += '<div class="tm-form">' +
        '<label>' + tt('מספר עצים', 'จำนวนต้น', 'عدد الأشجار') + '<input type="number" id="tmFTrees" min="0" value="' + f.tree_count + '"></label>' +
        '<label>' + tt('עצים חסרים', 'ต้นที่ขาด', 'أشجار ناقصة') + '<input type="number" id="tmFMissing" min="0" value="' + (f.missing_trees != null ? f.missing_trees : '') + '"></label>' +
        '<label>' + tt('מרווח בין עצים', 'ระยะระหว่างต้น', 'المسافة بين الأشجار') + ' (' + mm + ')<input type="number" step="0.1" id="tmFTreeSp" value="' + (f.tree_spacing != null ? f.tree_spacing : '') + '"></label>' +
        '<label>' + tt('מרווח בין שורות', 'ระยะระหว่างแถว', 'المسافة بين الصفوف') + ' (' + mm + ')<input type="number" step="0.1" id="tmFRowSp" value="' + (f.row_spacing != null ? f.row_spacing : '') + '"></label>' +
        '<label>' + tt('צמחים לדונם', 'ต้นต่อไร่', 'نباتات لكل دونم') + '<input type="number" id="tmFPpd" value="' + (f.plants_per_dunam != null ? f.plants_per_dunam : '') + '"></label></div>';
      h += '<p class="tm-help">' + tt('אלה הערכות מתצלום אוויר שתאריכו לא ידוע. שדה ריק לא ישתנה בכרטיס החלקה.', 'เป็นค่าประมาณจากภาพถ่ายทางอากาศที่ไม่ทราบวันที่ ช่องว่างจะไม่เปลี่ยนในบัตรแปลง', 'هذه تقديرات من صورة جوية تاريخها غير معروف. الحقل الفارغ لن يتغير في بطاقة القطعة.') + '</p>';
      h += '<div class="tm-row"><button class="tm-btn pri big" data-act="update"' + (isAdmin() ? '' : ' disabled') + '>✅ ' + tt('עדכן את', 'อัปเดต', 'حدّث') + ' ' + esc(pl.name) + '</button></div></div>';
    }
    var nTick = ids.filter(function (id) { return S.plots[id].status === 'done' && S.plots[id].tick; }).length;
    if (nDone > 1) {
      h += '<div class="tm-row"><button class="tm-btn big" data-act="updateAll"' + (nTick && isAdmin() ? '' : ' disabled') + '>✅ ' +
        tt('עדכן את כל המסומנות', 'อัปเดตทั้งหมดที่เลือก', 'حدّث كل المحددة') + ' (' + nTick + ')</button></div>';
    }
    el.innerHTML = h;
  }
  function onPanelClick(e) {
    var b = e.target.closest('[data-act]'); if (!b || !S) return;
    var act = b.getAttribute('data-act'), id = b.getAttribute('data-id');
    if (act === 'close') close(false);
    else if (act === 'min') setMinimized(true);
    else if (act === 'undo') undo();
    else if (act === 'mode') setMode(b.getAttribute('data-m'));
    else if (act === 'all') selectAllInView();
    else if (act === 'count') countPlots();
    else if (act === 'focus' && S.plots[id]) { S.active = id; zoomToPlot(S.plots[id]); redraw(); render(); }
    else if (act === 'drop' && S.plots[id]) {
      if (S.plots[id].status === 'done' && !window.confirm(tt('להסיר את החלקה מהספירה? התיקונים שעשית בה יאבדו.', 'นำแปลงออกจากการนับ? การแก้ไขในแปลงนี้จะหายไป', 'إزالة القطعة من العدّ؟ ستضيع تعديلاتك فيها.'))) return;
      dropPlot(id); redraw(); render();
    }
    else if (act === 'fill') fillGaps();
    else if (act === 'rowline' && activePlot()) {
      if (S.mode !== 'trees') setMode('trees');
      S.rowDraw = { id: activePlot().id, a: null }; drawRows(); render();
    }
    else if (act === 'rowCancel') { S.rowDraw = null; drawRows(); render(); }
    else if (act === 'autorows' && activePlot()) { autoRows(activePlot()); afterChange(); }
    else if (act === 'offrow') rejectOffRow();
    else if (act === 'restore') restorePlot();
    else if (act === 'update') updateOne();
    else if (act === 'updateAll') updateTicked();
  }
  function onPanelChange(e) {
    var t = e.target, id = t.getAttribute('data-tick');
    if (id && S.plots[id]) { S.plots[id].tick = t.checked; render(); }
  }

  // ── Open / close ─────────────────────────────────────────────────────
  function open() {
    if (!isAdmin()) { if (window.Own) Own.denied(); else toast('❌ ' + tt('זמין למנהל בלבד', 'ใช้ได้เฉพาะผู้ดูแล', 'متاح للمدير فقط')); return; }
    if (typeof fetch !== 'function' || typeof createImageBitmap !== 'function') {
      toast('❌ ' + tt('הדפדפן הזה לא תומך בכלי', 'เบราว์เซอร์นี้ไม่รองรับเครื่องมือนี้', 'هذا المتصفح لا يدعم الأداة')); return;
    }
    if (window.MapAccess && typeof MapAccess.goToMap === 'function') MapAccess.goToMap();
    injectCss();
    if (!S) {
      S = { px: [], bk: {}, rej: {}, auto: {}, added: [], plots: {}, active: null, undo: [],
            mode: 'select', rowDraw: null, busy: false, status: '', mpp: 0, tooMany: false, layers: null, minimized: false };
      var m = getMap(); if (m) S.mpp = mppAt(m.getCenter().lat);
    }
    ensureLayers();
    setMinimized(false);
    setMode(S.mode);
  }
  function close(force) {
    if (!S) return;
    var unsaved = Object.keys(S.plots).some(function (id) { return S.plots[id].status === 'done' && !S.plots[id].saved; });
    if (!force && unsaved &&
        !window.confirm(tt('לסגור? הספירה והתיקונים בחלקות שלא עודכנו לא יישמרו.', 'ปิด? การนับและการแก้ไขในแปลงที่ยังไม่อัปเดตจะไม่ถูกบันทึก', 'إغلاق؟ لن يُحفظ العدّ والتعديلات في القطع غير المحدّثة.'))) return;
    if (window.MapAccess && MapAccess.setExternalDraw) MapAccess.setExternalDraw(false);
    removeLayers();
    var p = document.getElementById('tmPanel'); if (p && p.parentNode) p.parentNode.removeChild(p);
    var q = document.getElementById('tmPill'); if (q && q.parentNode) q.parentNode.removeChild(q);
    S = null;
  }

  // ── Entry on the map's + menu ────────────────────────────────────────
  function refreshFabEntry() {
    var b = document.getElementById('btnTreeMap'); if (!b) return;
    b.style.display = isAdmin() ? '' : 'none';
    var t1 = b.querySelector('.fab-option-text'), t2 = b.querySelector('.fab-option-sub');
    if (t1) t1.textContent = tt('ספירת עצים בחלקות', 'นับต้นไม้ในแปลง', 'عدّ الأشجار في القطع');
    if (t2) t2.textContent = tt('עצים, חסרים ומרווחים מתצלום אוויר', 'ต้นไม้ ต้นที่ขาด และระยะจากภาพถ่ายทางอากาศ', 'الأشجار والناقص والمسافات من صورة جوية');
  }
  function init() {
    var opts = document.getElementById('fabOptions');
    if (!opts || document.getElementById('btnTreeMap')) return;
    var b = document.createElement('button');
    b.className = 'fab-option'; b.id = 'btnTreeMap';
    b.innerHTML = '<div class="fab-option-icon" style="background:#e3f2fd;color:#0a6fa0;">🌴</div>' +
      '<div><div class="fab-option-text"></div><div class="fab-option-sub"></div></div>';
    b.addEventListener('click', function () {
      opts.classList.remove('show');
      var fm = document.getElementById('fabMain'); if (fm) fm.classList.remove('open');
      open();
    });
    opts.appendChild(b);
    refreshFabEntry();
    var fm = document.getElementById('fabMain');
    if (fm) fm.addEventListener('click', refreshFabEntry);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    open: open,
    close: close,
    // exposed for tests
    _toPx: toPx, _toLL: toLL, _detect: detect, _processPlot: function (pl, w) { return processPlot(pl, w); },
    _state: function () { return S; }, _stats: function (id) { return stats(S.plots[id]); }, _fields: function (id) { return fieldsOf(S.plots[id]); },
    _count: function () { countPlots(); },
    _rowsFromLine: function (id, a, b) { return rowsFromLine(S.plots[id], a, b); }, _redraw: function () { redraw(); }
  };
})();
