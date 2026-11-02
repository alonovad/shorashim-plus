/* treemap.js — איתור חלקה לפי עצים מתצלום אוויר (tree-based plot finder)
 * ------------------------------------------------------------------
 * An optional helper for the plots that are hard to define: no lease map,
 * no register row, an old orchard nobody measured. The imagery already
 * shows where every tree stands, so the tree positions are used to find
 * the outline, the tree count and the spacing.
 *
 *   1. SCAN. The visible part of the map is read at full resolution (Esri
 *      World Imagery, zoom 18, about 0.5 m per pixel, the same imagery as
 *      the map's satellite layer) and every crown is marked. It runs in
 *      this browser, so nothing is uploaded and nothing is paid for. One
 *      scan covers at most about 2 km²; scanning again elsewhere adds to
 *      what is already found.
 *
 *   2. OUTLINE. Tap inside an orchard and the outline is drawn around the
 *      trees connected to that spot, half a spacing outside the outer row,
 *      the way plot boundaries usually run. Or tap the corners by hand, or
 *      load the outline of an existing plot. Every outline can be edited:
 *      drag a corner, drag a midpoint to add one, tap a corner to remove it.
 *
 *   3. TREES. Tap a dot to reject it (a bush, a shadow, a building), tap
 *      it again to restore it, tap empty ground to add a tree the scan
 *      missed.
 *
 *   4. ROWS. "Fit rows" finds the planting grid inside the outline: the
 *      row direction, the distance between rows and between trees. Places
 *      on the grid with no tree are shown as gaps, which is what the plot
 *      card calls missing trees. Gaps can be filled (a crown hidden by its
 *      neighbours) and dots off the grid rejected in one step.
 *
 *   5. RESULT. Area, trees, missing trees, spacings and density go either
 *      into a NEW plot (MapAccess.addImportedPlots) or onto an EXISTING one
 *      (MapAccess.updatePlotTreeData), always through a form the user
 *      checks first. Tree positions and rows are working material only:
 *      the app does not store individual trees, and neither does this.
 *
 * Creating and changing plots is admin only (ownership rule, Oct 2026).
 * The module never touches the plots array or saveData itself.
 */
var TreeMap = (function () {
  'use strict';

  var TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/18/{y}/{x}';
  var Z = 18, TS = 256, WORLD = TS * Math.pow(2, Z);
  var MAX_TILES = 200;            // one scan, about 1.8 x 1.8 km at 0.5 m/px
  var MAX_DRAW = 7000;            // dots drawn at once; beyond that, zoom in
  var BK = 64;                    // spatial bucket, px
  var S = null;                   // session

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
  var toastN = 0;
  function toast(m) { toastN++; if (typeof showToast === 'function') showToast(m); }
  function TOASTS_SEEN() { return toastN; }
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
  function inPoly(x, y, p) {
    var c = false;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
      var xi = p[i][0], yi = p[i][1], xj = p[j][0], yj = p[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  }
  function bbox(p) {
    var b = [1e18, 1e18, -1e18, -1e18];
    p.forEach(function (q) { b[0] = Math.min(b[0], q[0]); b[1] = Math.min(b[1], q[1]); b[2] = Math.max(b[2], q[0]); b[3] = Math.max(b[3], q[1]); });
    return b;
  }
  function segDist(px, py, a, b) {
    var dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
    var t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / L2));
    return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
  }
  function ringLL(p) { return p.map(function (q) { return toLL(q[0], q[1]); }); }
  function areaM2(p) {
    if (!p || p.length < 3) return 0;
    var ll = ringLL(p);
    if (window.MapAccess && MapAccess.areaFromLatLngs) return MapAccess.areaFromLatLngs(ll);
    var a = 0;
    for (var i = 0, j = p.length - 1; i < p.length; j = i++) a += (p[j][0] + p[i][0]) * (p[j][1] - p[i][1]);
    return Math.abs(a / 2) * S.mpp * S.mpp;
  }

  // ── Point store (detections) with buckets ────────────────────────────
  function bkey(x, y) { return Math.floor(x / BK) + ',' + Math.floor(y / BK); }
  function addPoint(x, y) {
    var k = S.px.length / 2;
    S.px.push(x, y);
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
  function nearestAdded(x, y, r) {
    var best = -1, bd = r;
    S.added.forEach(function (q, i) { var d = Math.hypot(q[0] - x, q[1] - y); if (d < bd) { bd = d; best = i; } });
    return best;
  }
  function hasTree(x, y, r) { return nearestDet(x, y, r, false) >= 0 || nearestAdded(x, y, r) >= 0; }
  // Trees (accepted detections + added) as [x,y] list, optionally inside a polygon.
  function treesIn(poly) {
    var out = [];
    if (poly) {
      var b = bbox(poly);
      eachInRect(b[0], b[1], b[2], b[3], function (k, x, y) { if (!S.rej[k] && inPoly(x, y, poly)) out.push([x, y, k]); });
      S.added.forEach(function (q) { if (inPoly(q[0], q[1], poly)) out.push([q[0], q[1], -1]); });
    }
    return out;
  }

  // ── Scan: fetch tiles, find crowns ───────────────────────────────────
  function loadTile(x, y) {
    var url = TILE_URL.replace('{x}', x).replace('{y}', y);
    return fetch(url, { mode: 'cors' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.blob();
    }).then(function (b) { return createImageBitmap(b); });
  }
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
  function gauss3(s, W, H, rs) { return box(box(box(s, W, H, rs[0]), W, H, rs[1]), W, H, rs[2]); }
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
  // Crowns in one window. Closed canopy: a crown is a bright centre within
  // dark foliage. Open ground: a crown is a dark blob on lighter soil.
  function detectWindow(ctx, W, H, M, ox, oy, keep) {
    var d = ctx.getImageData(0, 0, W, H).data, N = W * H, i, p;
    var g = new Float32Array(N), can = new Float32Array(N), al = new Uint8Array(N);
    for (i = 0, p = 0; i < N; i++, p += 4) { g[i] = (d[p] + d[p + 1] + d[p + 2]) / 3; can[i] = g[i] < 75 ? 1 : 0; al[i] = d[p + 3]; }
    var cover = gauss3(can, W, H, [15, 15, 15]), sm = gauss3(g, W, H, [3, 3, 2]), bg = gauss3(g, W, H, [12, 12, 12]);
    var resp = new Float32Array(N);
    for (i = 0; i < N; i++) {
      if (!al[i]) continue;
      var dn = cover[i] > 0.5, r = dn ? sm[i] - bg[i] : bg[i] - sm[i] - 15;
      if (!dn && sm[i] > 82) r = 0;
      if (dn && sm[i] > 100) r = 0;
      resp[i] = r;
    }
    var mx = maxf(resp, W, H, 6), out = [];
    for (var y = M; y < H - M; y++) for (var x = M; x < W - M; x++) {
      i = y * W + x;
      if (resp[i] > 0.5 && resp[i] >= mx[i]) { var gx = ox + x - M, gy = oy + y - M; if (keep(gx, gy)) out.push(gx, gy); }
    }
    return out;
  }
  function scan() {
    var m = getMap(); if (!m || !S || S.busy) return;
    var b = m.getBounds(), a = toPx(b.getNorth(), b.getWest()), c = toPx(b.getSouth(), b.getEast());
    var tx0 = Math.floor(a.x / TS), ty0 = Math.floor(a.y / TS), tx1 = Math.floor(c.x / TS), ty1 = Math.floor(c.y / TS);
    var nt = (tx1 - tx0 + 1) * (ty1 - ty0 + 1);
    if (nt > MAX_TILES) {
      toast('🔍 ' + tt('התקרב עוד: סריקה אחת מכסה עד כ־2 קמ״ר', 'ซูมเข้าอีก: การสแกนหนึ่งครั้งครอบคลุมได้ประมาณ 2 ตร.กม.', 'قرّب أكثر: المسح الواحد يغطي حتى نحو 2 كم²'));
      return;
    }
    S.busy = true;
    S.mpp = mppAt(m.getCenter().lat);
    var tiles = {}, list = [];
    for (var ty = ty0 - 1; ty <= ty1 + 1; ty++) for (var tx = tx0 - 1; tx <= tx1 + 1; tx++) list.push([tx, ty]);
    var done = 0, failed = 0, next = 0;
    setStatus('⏳ ' + tt('טוען תצלום אוויר', 'กำลังโหลดภาพถ่ายทางอากาศ', 'جارٍ تحميل الصورة الجوية') + ' 0/' + list.length);
    function worker() {
      if (next >= list.length) return Promise.resolve();
      var t = list[next++];
      return loadTile(t[0], t[1]).then(function (bm) { tiles[t[0] + '_' + t[1]] = bm; }, function () { failed++; })
        .then(function () {
          done++;
          if (done % 8 === 0) setStatus('⏳ ' + tt('טוען תצלום אוויר', 'กำลังโหลดภาพถ่ายทางอากาศ', 'جارٍ تحميل الصورة الجوية') + ' ' + done + '/' + list.length);
          return worker();
        });
    }
    var ws = []; for (var w = 0; w < 8; w++) ws.push(worker());
    Promise.all(ws).then(function () {
      if (failed > list.length / 2) throw new Error('tiles');
      // windows of up to 6x6 tiles with a 64 px margin from the neighbours
      var WT = 6, M = 64, wins = [];
      for (var wy = ty0; wy <= ty1; wy += WT) for (var wx = tx0; wx <= tx1; wx += WT) wins.push([wx, wy, Math.min(wx + WT - 1, tx1), Math.min(wy + WT - 1, ty1)]);
      var found = 0, wi = 0;
      var keep = function (gx, gy) { return nearestDet(gx, gy, 4, true) < 0; };   // a rescan adds only what is new
      return new Promise(function (resolve) {
        function step() {
          if (!S) { resolve(); return; }
          if (wi >= wins.length) { resolve(); return; }
          var r = wins[wi++], W = (r[2] - r[0] + 1) * TS + 2 * M, H = (r[3] - r[1] + 1) * TS + 2 * M;
          var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          var ctx = cv.getContext('2d', { willReadFrequently: true });
          for (var y = r[1] - 1; y <= r[3] + 1; y++) for (var x = r[0] - 1; x <= r[2] + 1; x++) {
            var bm = tiles[x + '_' + y]; if (bm) ctx.drawImage(bm, (x - r[0]) * TS + M, (y - r[1]) * TS + M);
          }
          var pk = detectWindow(ctx, W, H, M, r[0] * TS, r[1] * TS, keep);
          for (var i = 0; i < pk.length; i += 2) addPoint(pk[i], pk[i + 1]);
          found += pk.length / 2;
          setStatus('⏳ ' + tt('מאתר עצים', 'กำลังค้นหาต้นไม้', 'جارٍ تحديد الأشجار') + ' ' + wi + '/' + wins.length + ' · ' + fmt(found));
          setTimeout(step, 0);
        }
        step();
      }).then(function () { return found; });
    }).then(function (found) {
      Object.keys(tiles).forEach(function (k) { try { tiles[k].close(); } catch (e) {} });
      if (!S) return;
      S.busy = false;
      S.scans++;
      S.status = '✅ ' + fmt(found) + ' ' + tt('עצים אותרו בסריקה', 'ต้นที่พบในการสแกน', 'شجرة حُدّدت في المسح') +
        (failed ? ' · ' + failed + ' ' + tt('אריחים חסרים', 'ไทล์ที่ขาด', 'مربعات ناقصة') : '') +
        '. ' + tt('עכשיו הקש בתוך מטע כדי לסמן את גבולו.', 'ตอนนี้แตะในสวนเพื่อทำเครื่องหมายขอบเขต', 'الآن انقر داخل البستان لتحديد حدوده.');
      if (!S.outline) setMode('outline');
      redraw(); render();
    }).catch(function () {
      Object.keys(tiles).forEach(function (k) { try { tiles[k].close(); } catch (e) {} });
      if (!S) return;
      S.busy = false;
      S.status = '❌ ' + tt('לא ניתן לקרוא את תצלום האוויר. בדוק חיבור ונסה שוב.', 'ไม่สามารถอ่านภาพถ่ายทางอากาศได้ ตรวจสอบการเชื่อมต่อแล้วลองใหม่', 'تعذرت قراءة الصورة الجوية. تحقق من الاتصال وحاول مجددًا.');
      render();
    });
  }

  // ── Outline from the trees around a tap ──────────────────────────────
  // Typical tree spacing around a point, from local density (area per tree)
  // rather than nearest neighbours: one crown detected twice a few pixels
  // apart halves a nearest-neighbour estimate, but barely moves a density.
  function localSpacing(x, y) {
    var r = 40 / S.mpp, n = 0;
    eachInRect(x - r, y - r, x + r, y + r, function (k, px, py) { if (!S.rej[k] && Math.hypot(px - x, py - y) <= r) n++; });
    S.added.forEach(function (q) { if (Math.hypot(q[0] - x, q[1] - y) <= r) n++; });
    if (n < 8) return 0;
    return Math.sqrt(Math.PI * r * r / n);
  }
  function autoOutline(x, y) {
    var sp = localSpacing(x, y);
    if (!sp) { toast('⚠️ ' + tt('אין כאן מספיק עצים. סרוק את האזור או סמן ידנית.', 'มีต้นไม้ไม่พอที่นี่ สแกนพื้นที่หรือวาดเอง', 'لا توجد أشجار كافية هنا. امسح المنطقة أو ارسم يدويًا.')); return null; }
    var seed = nearestDet(x, y, 2.5 * sp, false), link = 1.2 * sp;
    if (seed < 0) { toast('⚠️ ' + tt('הקש קרוב יותר לעצים', 'แตะใกล้ต้นไม้มากขึ้น', 'انقر أقرب إلى الأشجار')); return null; }
    // Grow the block from the tapped tree. Where the trees near the tap
    // form a clear planting grid, a step is allowed only along that grid:
    // to the next tree in the same row (one missing tree tolerated) or to
    // the adjacent row. A neighbouring block at another angle does not fit
    // the steps, and a track between blocks (a missing row) breaks them.
    // Without a clear grid, plain linkage at 1.3 spacings is used.
    var loc = [], R45 = 45 / S.mpp, sx0 = S.px[2 * seed], sy0 = S.px[2 * seed + 1];
    eachInRect(sx0 - R45, sy0 - R45, sx0 + R45, sy0 + R45, function (j, jx, jy) { if (!S.rej[j]) loc.push([jx, jy]); });
    var grid = null;
    if (loc.length >= 25) {
      var ft = fitLattice(loc);
      if (ft.m >= 0.3) {
        var uu = [Math.cos(ft.th), Math.sin(ft.th)], vv = [-Math.sin(ft.th), Math.cos(ft.th)];
        var off0 = coh(loc.map(function (q) { return q[0] * vv[0] + q[1] * vv[1]; }), ft.rowD).ph / (2 * Math.PI) * ft.rowD;
        var byRow = {};
        loc.forEach(function (q) {
          var d = q[0] * vv[0] + q[1] * vv[1], kk = Math.round((d - off0) / ft.rowD);
          if (Math.abs(d - off0 - kk * ft.rowD) < 0.3 * ft.rowD) (byRow[kk] || (byRow[kk] = [])).push(q[0] * uu[0] + q[1] * uu[1]);
        });
        var dfs = [];
        Object.keys(byRow).forEach(function (kk) {
          var ts = byRow[kk].sort(function (a, b) { return a - b; });
          for (var t1 = 1; t1 < ts.length; t1++) { var df = ts[t1] - ts[t1 - 1]; if (df > 0.5 * ft.dnn && df < 2.5 * ft.dnn) dfs.push(df); }
        });
        dfs.sort(function (a, b) { return a - b; });
        if (dfs.length >= 6) grid = { u: uu, v: vv, rowD: ft.rowD, sp: dfs[dfs.length >> 1], off: off0 };
      }
    }
    if (grid) link = Math.max(1.4 * grid.sp, 1.4 * grid.rowD);
    var linked = function (dx, dy) {
      if (!grid) return Math.hypot(dx, dy) <= link;
      var dt = Math.abs(dx * grid.u[0] + dy * grid.u[1]), dd = Math.abs(dx * grid.v[0] + dy * grid.v[1]);
      if (dd < 0.3 * grid.rowD) return dt < 1.4 * grid.sp && dt > 0.3 * grid.sp;          // along the row
      return Math.abs(dd - grid.rowD) < 0.3 * grid.rowD && dt < 0.75 * grid.sp;           // next row
    };
    // a tree joins only if it sits on the same row lines as the tapped grid
    var band = 0.3;
    var onGrid = function (jx, jy) {
      if (!grid || !band) return true;
      var d = jx * grid.v[0] + jy * grid.v[1], f = (d - grid.off) / grid.rowD;
      return Math.abs(f - Math.round(f)) < band;
    };
    // without a grid nothing tells one block from the next: stay near the tap
    var capR = 120 / S.mpp;
    var inC = {}, q = [seed], pts = []; inC[seed] = 1;
    while (q.length && pts.length < 40000) {
      var k = q.pop(), kx = S.px[2 * k], ky = S.px[2 * k + 1];
      pts.push([kx, ky]);
      eachInRect(kx - link, ky - link, kx + link, ky + link, function (j, jx, jy) {
        if (inC[j] || S.rej[j]) return;
        if (!grid && Math.hypot(jx - sx0, jy - sy0) > capR) return;
        if (linked(jx - kx, jy - ky) && onGrid(jx, jy)) { inC[j] = 1; q.push(j); }
      });
    }
    // trees you added count too, when they sit next to this cluster
    var cb = bbox(pts);
    S.added.forEach(function (a) {
      if (a[0] < cb[0] - link || a[0] > cb[2] + link || a[1] < cb[1] - link || a[1] > cb[3] + link) return;
      for (var i2 = 0; i2 < pts.length; i2++) if (Math.hypot(pts[i2][0] - a[0], pts[i2][1] - a[1]) <= link) { pts.push([a[0], a[1]]); return; }
    });
    if (pts.length < 6) return null;
    // raster: 1 cell = 2 px (about 1 m); dilate 0.85 spacing, erode 0.35
    var cell = 2, b = bbox(pts), pad = Math.ceil(sp / cell) + 3;
    var gx0 = Math.floor(b[0] / cell) - pad, gy0 = Math.floor(b[1] / cell) - pad;
    var GW = Math.ceil(b[2] / cell) - gx0 + pad + 1, GH = Math.ceil(b[3] / cell) - gy0 + pad + 1;
    if (GW * GH > 4e6) { toast('⚠️ ' + tt('האזור גדול מדי. התקרב ונסה שוב.', 'พื้นที่ใหญ่เกินไป ซูมเข้าแล้วลองใหม่', 'المنطقة كبيرة جدًا. قرّب وحاول مجددًا.')); return null; }
    var G = new Uint8Array(GW * GH), r1 = Math.max(2, Math.round(0.85 * sp / cell)), r1s = r1 * r1;
    pts.forEach(function (p) {
      var cx = Math.round(p[0] / cell) - gx0, cy = Math.round(p[1] / cell) - gy0;
      for (var dy = -r1; dy <= r1; dy++) for (var dx = -r1; dx <= r1; dx++) {
        if (dx * dx + dy * dy > r1s) continue;
        var xx = cx + dx, yy = cy + dy; if (xx >= 0 && yy >= 0 && xx < GW && yy < GH) G[yy * GW + xx] = 1;
      }
    });
    var sx = Math.round(S.px[2 * seed] / cell) - gx0, sy = Math.round(S.px[2 * seed + 1] / cell) - gy0, i;
    // Opening: shrink by ro, keep the part holding the tapped tree, grow back.
    // Cuts necks narrower than about 2.4 spacings (a single column of trees
    // joining two blocks) without touching the block itself.
    var ro = 0 * sp / cell, D = chamfer(G, GW, GH, 0), core = new Uint8Array(GW * GH);
    for (i = 0; i < G.length; i++) core[i] = D[i] > ro ? 1 : 0;
    var cs = -1, cd = 1e9;
    for (var yy0 = Math.max(0, sy - Math.ceil(2 * ro)); yy0 <= Math.min(GH - 1, sy + Math.ceil(2 * ro)); yy0++)
      for (var xx0 = Math.max(0, sx - Math.ceil(2 * ro)); xx0 <= Math.min(GW - 1, sx + Math.ceil(2 * ro)); xx0++) {
        if (!core[yy0 * GW + xx0]) continue;
        var dd0 = Math.hypot(xx0 - sx, yy0 - sy); if (dd0 < cd) { cd = dd0; cs = yy0 * GW + xx0; }
      }
    if (ro > 0 && cs >= 0) {
      var comp = new Uint8Array(GW * GH), stk = [cs];
      while (stk.length) {
        var c0 = stk.pop(); if (comp[c0] || !core[c0]) continue; comp[c0] = 1;
        var cx0 = c0 % GW, cy0 = (c0 / GW) | 0;
        if (cx0 > 0) stk.push(c0 - 1); if (cx0 < GW - 1) stk.push(c0 + 1); if (cy0 > 0) stk.push(c0 - GW); if (cy0 < GH - 1) stk.push(c0 + GW);
      }
      var Dg = chamfer(comp, GW, GH, 1);     // distance to the kept core
      for (i = 0; i < G.length; i++) G[i] = (G[i] && Dg[i] <= ro + 1) ? 1 : 0;
    }
    // fill holes: background not reachable from the border is inside
    var vis = new Uint8Array(GW * GH), st = [];
    for (i = 0; i < GW; i++) { st.push(i, (GH - 1) * GW + i); }
    for (i = 0; i < GH; i++) { st.push(i * GW, i * GW + GW - 1); }
    while (st.length) {
      var c = st.pop(); if (vis[c] || G[c]) continue; vis[c] = 1;
      var cx2 = c % GW, cy2 = (c / GW) | 0;
      if (cx2 > 0) st.push(c - 1); if (cx2 < GW - 1) st.push(c + 1); if (cy2 > 0) st.push(c - GW); if (cy2 < GH - 1) st.push(c + GW);
    }
    for (i = 0; i < G.length; i++) if (!G[i] && !vis[i]) G[i] = 1;
    // erode by r2 so the line runs about half a spacing outside the trees
    var De = chamfer(G, GW, GH, 0), r2 = 0.35 * sp / cell;
    for (i = 0; i < G.length; i++) G[i] = De[i] > r2 ? 1 : 0;
    if (!G[sy * GW + sx]) {           // the tapped tree sits on an edge: start from the nearest inside cell
      var best0 = -1, bd0 = 1e9;
      for (i = 0; i < G.length; i++) if (G[i]) { var d1 = Math.hypot(i % GW - sx, ((i / GW) | 0) - sy); if (d1 < bd0) { bd0 = d1; best0 = i; } }
      if (best0 < 0) return null;
      sx = best0 % GW; sy = (best0 / GW) | 0;
    }
    var ring = outerBoundary(G, GW, GH, sx, sy);
    if (!ring || ring.length < 4) return null;
    S.lastGrid = !!grid;
    var poly = ring.map(function (p) { return [(p[0] + gx0) * cell, (p[1] + gy0) * cell]; });
    // corners where the line bends more than 2.5 m, loosened until there are
    // few enough (about 30) to drag by finger
    var raw = poly, tolM = 2.5;
    poly = simplify(raw, tolM / S.mpp);
    while (poly.length > 30 && tolM < 12) { tolM *= 1.3; poly = simplify(raw, tolM / S.mpp); }
    return poly.length >= 3 ? poly : null;
  }
  // Chamfer distance (cells) to the nearest cell whose mask value is
  // `target` (0: distance to background, 1: distance to the mask).
  function chamfer(M, W, H, target) {
    var D = new Float32Array(W * H), INF = 1e9, i, x, y, v;
    for (i = 0; i < D.length; i++) D[i] = (M[i] ? 1 : 0) === target ? 0 : INF;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      i = y * W + x; if (!D[i]) continue; v = D[i];
      if (x > 0) v = Math.min(v, D[i - 1] + 1); if (y > 0) v = Math.min(v, D[i - W] + 1);
      if (x > 0 && y > 0) v = Math.min(v, D[i - W - 1] + 1.414); if (x < W - 1 && y > 0) v = Math.min(v, D[i - W + 1] + 1.414);
      D[i] = v;
    }
    for (y = H - 1; y >= 0; y--) for (x = W - 1; x >= 0; x--) {
      i = y * W + x; if (!D[i]) continue; v = D[i];
      if (x < W - 1) v = Math.min(v, D[i + 1] + 1); if (y < H - 1) v = Math.min(v, D[i + W] + 1);
      if (x < W - 1 && y < H - 1) v = Math.min(v, D[i + W + 1] + 1.414); if (x > 0 && y < H - 1) v = Math.min(v, D[i + W - 1] + 1.414);
      D[i] = v;
    }
    return D;
  }
  // Outer boundary of the 4-connected blob holding (sx,sy), as a ring of
  // cell corners. Every cell edge between the blob and the outside becomes a
  // directed edge with the blob on its right; the edges chain into loops and
  // the largest loop is the outline. Unlike pixel tracing this always closes,
  // whatever thin necks the blob has.
  function outerBoundary(G, W, H, sx, sy) {
    var C = new Uint8Array(W * H), st = [sy * W + sx], i, x, y;
    while (st.length) {
      i = st.pop(); if (C[i] || !G[i]) continue; C[i] = 1;
      x = i % W; y = (i / W) | 0;
      if (x > 0) st.push(i - 1); if (x < W - 1) st.push(i + 1); if (y > 0) st.push(i - W); if (y < H - 1) st.push(i + W);
    }
    var VW = W + 1, out = {};
    var add = function (ax, ay, bx, by) { var k = ay * VW + ax; (out[k] || (out[k] = [])).push(by * VW + bx); };
    var inC = function (xx, yy) { return xx >= 0 && yy >= 0 && xx < W && yy < H && C[yy * W + xx]; };
    for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
      if (!C[y * W + x]) continue;
      if (!inC(x, y - 1)) add(x, y, x + 1, y);
      if (!inC(x + 1, y)) add(x + 1, y, x + 1, y + 1);
      if (!inC(x, y + 1)) add(x + 1, y + 1, x, y + 1);
      if (!inC(x - 1, y)) add(x, y + 1, x, y);
    }
    var best = null, bestA = 0;
    Object.keys(out).forEach(function (k0) {
      while (out[k0] && out[k0].length) {
        var loop = [], cur = Number(k0), prev = null, guard = 0;
        do {
          var cand = out[cur]; if (!cand || !cand.length) break;
          var pick = 0;
          if (cand.length > 1 && prev != null) {
            // at a pinch, turn right first (keeps the blob on the right)
            var px0 = prev % VW, py0 = (prev / VW) | 0, cx0 = cur % VW, cy0 = (cur / VW) | 0;
            var dx0 = cx0 - px0, dy0 = cy0 - py0, bestT = 9;
            cand.forEach(function (nk, ci) {
              var dx1 = nk % VW - cx0, dy1 = ((nk / VW) | 0) - cy0;
              var cr = dx0 * dy1 - dy0 * dx1, dt = dx0 * dx1 + dy0 * dy1;
              var rank = cr > 0 ? 0 : (dt > 0 ? 1 : 2);
              if (rank < bestT) { bestT = rank; pick = ci; }
            });
          }
          var nx = cand.splice(pick, 1)[0];
          loop.push([cur % VW, (cur / VW) | 0]);
          prev = cur; cur = nx;
        } while (cur !== Number(k0) && ++guard < 4e6);
        if (loop.length < 4) continue;
        var ar = 0;
        for (var a2 = 0, b2 = loop.length - 1; a2 < loop.length; b2 = a2++) ar += (loop[b2][0] + loop[a2][0]) * (loop[b2][1] - loop[a2][1]);
        ar = Math.abs(ar);
        if (ar > bestA) { bestA = ar; best = loop; }
      }
    });
    return best;
  }
  function simplify(pts, tol) {
    if (pts.length < 4) return pts;
    var keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    var stack = [[0, pts.length - 1]];
    while (stack.length) {
      var s = stack.pop(), a = s[0], b = s[1], md = -1, mi = -1;
      for (var i = a + 1; i < b; i++) { var d = segDist(pts[i][0], pts[i][1], pts[a], pts[b]); if (d > md) { md = d; mi = i; } }
      if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    var out = pts.filter(function (p, i) { return keep[i]; });
    if (out.length > 3 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) < 1) out.pop();
    return out;
  }

  // ── Rows: planting-grid fit inside the outline ───────────────────────
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
  // Planting grid of a set of trees: row direction th (radians), distance
  // between rows rowD and the median nearest-neighbour distance dnn (px).
  function fitLattice(P) {
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
    return { th: th, rowD: rowD, m: best.m, dnn: dnn };
  }
  function fitRows() {
    if (!S.outline) { toast('⚠️ ' + tt('סמן קודם את גבול החלקה', 'ทำเครื่องหมายขอบเขตแปลงก่อน', 'حدّد حدود القطعة أولاً')); return; }
    var P = treesIn(S.outline).map(function (t) { return [t[0], t[1]]; });
    if (P.length < 12) { toast('⚠️ ' + tt('מעט מדי עצים כדי למצוא שורות', 'ต้นไม้น้อยเกินไปที่จะหาแถว', 'عدد الأشجار قليل جدًا لإيجاد الصفوف')); return; }
    if (P.length > 6000) P = P.filter(function (p, i) { return i % Math.ceil(P.length / 6000) === 0; });
    var fit = fitLattice(P);
    var th = fit.th, rowD = fit.rowD, best = { m: fit.m }, n = P.length, dnn = fit.dnn, i;
    var u = [Math.cos(th), Math.sin(th)], nv = [-Math.sin(th), Math.cos(th)];
    var pr = P.map(function (p) { return { d: p[0] * nv[0] + p[1] * nv[1], t: p[0] * u[0] + p[1] * u[1] }; });
    var off = coh(pr.map(function (p) { return p.d; }), rowD).ph / (2 * Math.PI) * rowD;
    var rowsMap = {};
    pr.forEach(function (p) {
      var kk = Math.round((p.d - off) / rowD), c = off + kk * rowD;
      if (Math.abs(p.d - c) < 0.35 * rowD) (rowsMap[kk] || (rowsMap[kk] = [])).push(p);
    });
    var bestS = null;
    for (var Sp = Math.max(6, 0.6 * dnn); Sp <= Math.min(rowD * 1.25, 2.2 * dnn); Sp += 0.25) {
      var tot = 0, cnt = 0;
      Object.keys(rowsMap).forEach(function (kk) { var g = rowsMap[kk]; if (g.length < 3) return; tot += coh(g.map(function (p) { return p.t; }), Sp).m * g.length; cnt += g.length; });
      if (!cnt) continue;
      var mS = tot / cnt;
      if (!bestS || mS > bestS.m + 0.02 || (Math.abs(mS - bestS.m) <= 0.02 && Sp > bestS.S)) bestS = { S: Sp, m: mS };
    }
    var Spx = bestS ? bestS.S : dnn, rows = [];
    Object.keys(rowsMap).forEach(function (kk) {
      var g = rowsMap[kk]; if (g.length < 2) return;
      var c = off + Number(kk) * rowD;
      var ph = g.length >= 3 ? coh(g.map(function (p) { return p.t; }), Spx).ph / (2 * Math.PI) * Spx : g[0].t;
      var ts = g.map(function (p) { return p.t; });
      var t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
      t0 = ph + Math.round((t0 - ph) / Spx) * Spx; t1 = ph + Math.round((t1 - ph) / Spx) * Spx;
      if (t1 - t0 < Spx * 0.9) return;
      rows.push({ a: [t0 * u[0] + c * nv[0], t0 * u[1] + c * nv[1]], b: [t1 * u[0] + c * nv[0], t1 * u[1] + c * nv[1]], step: Spx });
    });
    if (!rows.length) { toast('⚠️ ' + tt('לא נמצאו שורות ברורות', 'ไม่พบแถวที่ชัดเจน', 'لم يتم العثور على صفوف واضحة')); return; }
    snapshot();
    S.rows = rows;
    S.grid = { tree: Spx * S.mpp, row: rowD * S.mpp, strength: best.m };
    afterChange();
    toast('〰️ ' + rows.length + ' ' + tt('שורות', 'แถว', 'صفوف') + ' · ' +
      tt('בין עצים', 'ระหว่างต้น', 'بين الأشجار') + ' ' + fmt(S.grid.tree, 1) + ' ' + tt('מ׳', 'ม.', 'م') + ' · ' +
      tt('בין שורות', 'ระหว่างแถว', 'بين الصفوف') + ' ' + fmt(S.grid.row, 1) + ' ' + tt('מ׳', 'ม.', 'م'));
  }
  function rowSlots(r) {
    var L2 = Math.hypot(r.b[0] - r.a[0], r.b[1] - r.a[1]), n = Math.max(1, Math.round(L2 / r.step)), out = [];
    for (var i = 0; i <= n; i++) { var t = i / n; out.push([r.a[0] + t * (r.b[0] - r.a[0]), r.a[1] + t * (r.b[1] - r.a[1])]); }
    return { slots: out, step: L2 / n };
  }
  function gaps() {
    var out = [], pos = 0;
    S.rows.forEach(function (r) {
      var g = rowSlots(r), tol = 0.4 * g.step;
      g.slots.forEach(function (q) {
        if (S.outline && !inPoly(q[0], q[1], S.outline)) return;
        pos++;
        if (!hasTree(q[0], q[1], tol)) out.push(q);
      });
    });
    return { gaps: out, positions: pos };
  }
  function fillGaps() {
    var g = gaps().gaps; if (!g.length) { toast(tt('אין רווחים למילוי', 'ไม่มีช่องว่างให้เติม', 'لا توجد فجوات للملء')); return; }
    snapshot();
    g.forEach(function (q) { S.added.push([q[0], q[1]]); });
    afterChange();
    toast('✅ ' + g.length + ' ' + tt('רווחים מולאו בעצים', 'ช่องว่างถูกเติมด้วยต้นไม้', 'فجوات مُلئت بأشجار'));
  }
  function rejectOffRow() {
    if (!S.rows.length) { toast('⚠️ ' + tt('מצא קודם שורות', 'หาแถวก่อน', 'أوجد الصفوف أولاً')); return; }
    var tol = Math.max(1.5 / S.mpp, 0.3 * (S.grid.row / S.mpp)), n = 0;
    snapshot();
    treesIn(S.outline).forEach(function (t) {
      if (t[2] < 0) return;
      var md = 1e9; S.rows.forEach(function (r) { var d = segDist(t[0], t[1], r.a, r.b); if (d < md) md = d; });
      if (md > tol) { S.rej[t[2]] = 1; n++; }
    });
    if (!n) { S.undo.pop(); toast(tt('אין נקודות מחוץ לשורות', 'ไม่มีจุดนอกแถว', 'لا نقاط خارج الصفوف')); return; }
    afterChange();
    toast('🚫 ' + n + ' ' + tt('נקודות מחוץ לשורות נדחו', 'จุดนอกแถวถูกปฏิเสธ', 'نقاط خارج الصفوف رُفضت'));
  }

  // ── Stats ────────────────────────────────────────────────────────────
  function stats() {
    if (!S.outline) return null;
    var trees = treesIn(S.outline), a = areaM2(S.outline), g = S.rows.length ? gaps() : null;
    var nAdded = trees.filter(function (t) { return t[2] < 0; }).length, nRej = 0;
    var b = bbox(S.outline);
    eachInRect(b[0], b[1], b[2], b[3], function (k, x, y) { if (S.rej[k] && inPoly(x, y, S.outline)) nRej++; });
    return { trees: trees.length, added: nAdded, rejected: nRej, areaDn: a / 1000, positions: g ? g.positions : null, gaps: g ? g.gaps.length : null };
  }

  // ── Undo ─────────────────────────────────────────────────────────────
  function snapshot() {
    S.undo.push(JSON.stringify({ rej: Object.keys(S.rej), added: S.added, outline: S.outline, rows: S.rows, grid: S.grid }));
    if (S.undo.length > 50) S.undo.shift();
  }
  function undo() {
    var u = S.undo.pop(); if (!u) return;
    u = JSON.parse(u);
    S.rej = {}; u.rej.forEach(function (k) { S.rej[k] = 1; });
    S.added = u.added; S.outline = u.outline; S.rows = u.rows; S.grid = u.grid;
    afterChange();
  }
  function afterChange() { redraw(); render(); }

  // ── Map layers ───────────────────────────────────────────────────────
  function ensureLayers() {
    var m = getMap(); if (!m || S.layers) return;
    S.renderer = L.canvas({ padding: 0.3 });
    S.layers = { dots: L.layerGroup().addTo(m), rows: L.layerGroup().addTo(m), outline: L.layerGroup().addTo(m), handles: L.layerGroup().addTo(m) };
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
  function drawDots() {
    if (!S || !S.layers) return;
    var m = getMap(), g = S.layers.dots; g.clearLayers();
    if (!S.showDots) return;
    var b = m.getBounds(), a = toPx(b.getNorth(), b.getWest()), c = toPx(b.getSouth(), b.getEast());
    var n = 0; eachInRect(a.x, a.y, c.x, c.y, function () { n++; });
    S.tooMany = n > MAX_DRAW;
    var rad = m.getZoom() >= 19 ? 4 : 3;
    if (!S.tooMany) {
      eachInRect(a.x, a.y, c.x, c.y, function (k, x, y) {
        var rej = !!S.rej[k], inside = S.outline ? inPoly(x, y, S.outline) : true;
        L.circleMarker(toLL(x, y), {
          renderer: S.renderer, radius: rad, weight: 1, interactive: false,
          color: rej ? '#bbb' : '#fff', fillColor: rej ? '#444' : (inside ? '#ff2a2a' : '#ffd400'),
          fillOpacity: rej ? 0.5 : 0.95, dashArray: rej ? '2 2' : null
        }).addTo(g);
      });
    }
    S.added.forEach(function (q) {
      L.circleMarker(toLL(q[0], q[1]), { renderer: S.renderer, radius: rad + 0.5, weight: 1, color: '#fff', fillColor: '#1e90ff', fillOpacity: 1, interactive: false }).addTo(g);
    });
    if (S.rows.length && !S.tooMany) {
      gaps().gaps.forEach(function (q) {
        L.circleMarker(toLL(q[0], q[1]), { renderer: S.renderer, radius: rad + 2.5, weight: 2, color: '#ff9f1c', fill: false, interactive: false }).addTo(g);
      });
    }
    var note = document.getElementById('tmZoomNote');
    if (note) note.style.display = S.tooMany ? '' : 'none';
  }
  function drawRows() {
    var g = S.layers.rows; g.clearLayers();
    S.rows.forEach(function (r) {
      L.polyline([toLL(r.a[0], r.a[1]), toLL(r.b[0], r.b[1])], { color: '#3fd0ff', weight: 2, opacity: 0.85, interactive: false }).addTo(g);
    });
  }
  function drawOutline() {
    var g = S.layers.outline, h = S.layers.handles; g.clearLayers(); h.clearLayers();
    if (S.drawing && S.drawing.length) {
      L.polyline(S.drawing.map(function (q) { return toLL(q[0], q[1]); }), { color: '#3fd0ff', weight: 3, dashArray: '8 6', interactive: false }).addTo(g);
      S.drawing.forEach(function (q, i) {
        L.circleMarker(toLL(q[0], q[1]), { radius: i ? 5 : 8, color: '#0a6fa0', weight: 2, fillColor: '#fff', fillOpacity: 1, interactive: false }).addTo(g);
      });
      return;
    }
    if (!S.outline) return;
    L.polygon(ringLL(S.outline), { color: '#fff', weight: 3, fillColor: '#3fd0ff', fillOpacity: 0.08, interactive: false }).addTo(g);
    if (S.mode !== 'outline') return;
    var ic = function (cls, sz) { return L.divIcon({ className: '', html: '<div class="' + cls + '" style="width:' + sz + 'px;height:' + sz + 'px"></div>', iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2] }); };
    S.outline.forEach(function (q, i) {
      var j = (i + 1) % S.outline.length, mid = [(q[0] + S.outline[j][0]) / 2, (q[1] + S.outline[j][1]) / 2];
      var mk = L.marker(toLL(mid[0], mid[1]), { icon: ic('tm-mid', 16), draggable: true, keyboard: false }).addTo(h);
      mk.on('dragstart', function () { snapshot(); S.outline.splice(i + 1, 0, mid.slice()); S.dragIdx = i + 1; });
      mk.on('drag', function (e) { var p = toPx(e.latlng.lat, e.latlng.lng); S.outline[S.dragIdx] = [p.x, p.y]; liveOutline(); });
      mk.on('dragend', function () { afterChange(); });
    });
    S.outline.forEach(function (q, i) {
      var mk = L.marker(toLL(q[0], q[1]), { icon: ic('tm-v', 20), draggable: true, keyboard: false }).addTo(h);
      mk.on('dragstart', function () { snapshot(); });
      mk.on('drag', function (e) { var p = toPx(e.latlng.lat, e.latlng.lng); S.outline[i] = [p.x, p.y]; liveOutline(); });
      mk.on('dragend', function () { afterChange(); });
      mk.on('click', function () {
        if (S.outline.length <= 3) { toast(tt('לחלקה דרושות לפחות 3 פינות', 'แปลงต้องมีอย่างน้อย 3 มุม', 'تحتاج القطعة 3 زوايا على الأقل')); return; }
        snapshot(); S.outline.splice(i, 1); afterChange();
      });
    });
  }
  function liveOutline() {
    var g = S.layers.outline; g.eachLayer(function (l) { if (l.setLatLngs) l.setLatLngs(ringLL(S.outline)); });
    var el = document.getElementById('tmLive'); var s = stats();
    if (el && s) el.textContent = fmt(s.areaDn, 2) + ' ' + tt('ד׳', 'ไร่', 'دونم') + ' · ' + fmt(s.trees) + ' ' + tt('עצים', 'ต้น', 'شجرة');
  }
  function redraw() { if (!S || !S.layers) return; drawOutline(); drawRows(); drawDots(); }

  // ── Map clicks by mode ───────────────────────────────────────────────
  function onMapClick(e) {
    if (!S || S.busy) return;
    var p = toPx(e.latlng.lat, e.latlng.lng), m = getMap();
    var tol = 14 * Math.pow(2, Z - m.getZoom());          // 14 screen px in z18 px
    if (S.mode === 'outline') {
      if (S.drawing) {
        if (S.drawing.length >= 3 && Math.hypot(p.x - S.drawing[0][0], p.y - S.drawing[0][1]) < tol) { finishDrawing(); return; }
        S.drawing.push([p.x, p.y]); drawOutline(); return;
      }
      if (!S.px.length && !S.added.length) { toast('⚠️ ' + tt('סרוק קודם את האזור, או סמן פינות ידנית', 'สแกนพื้นที่ก่อน หรือวาดมุมเอง', 'امسح المنطقة أولاً، أو ارسم الزوايا يدويًا')); return; }
      var nT = TOASTS_SEEN();
      var ring = autoOutline(p.x, p.y);
      if (!ring) {
        if (TOASTS_SEEN() === nT) toast('⚠️ ' + tt('לא נמצא כאן מטע מחובר. הקש בתוך שורות העצים, או סמן פינות ידנית.', 'ไม่พบสวนที่เชื่อมกันที่นี่ แตะในแถวต้นไม้ หรือวาดมุมเอง', 'لم يُعثر هنا على بستان متصل. انقر داخل صفوف الأشجار، أو ارسم الزوايا يدويًا.'));
        return;
      }
      snapshot(); S.outline = ring; S.rows = []; S.grid = null;
      afterChange();
      showAbovePanel(ring);
      toast('📐 ' + (S.lastGrid
        ? tt('הגבול סומן לפי שורות הנטיעה. בדוק אותו מול התצלום: גרור פינות לתיקון, הקש על פינה כדי למחוק אותה.', 'วาดขอบเขตตามแถวปลูกแล้ว ตรวจกับภาพถ่าย: ลากมุมเพื่อแก้ไข แตะมุมเพื่อลบ', 'رُسمت الحدود حسب صفوف الزراعة. قارنها بالصورة: اسحب الزوايا للتصحيح، وانقر على زاوية لحذفها.')
        : tt('אין כאן שורות נטיעה ברורות, לכן הגבול גס (עד 120 מ׳ מהנקודה). תקן אותו ידנית.', 'ไม่มีแถวปลูกชัดเจนที่นี่ ขอบเขตจึงหยาบ (ไม่เกิน 120 ม. จากจุด) แก้ไขเอง', 'لا توجد صفوف زراعة واضحة هنا، لذا الحدود تقريبية (حتى 120 م من النقطة). صحّحها يدويًا.')));
      return;
    }
    if (S.mode === 'trees') {
      if (!S.layers || S.tooMany) { toast('🔍 ' + tt('התקרב כדי לערוך עצים', 'ซูมเข้าเพื่อแก้ไขต้นไม้', 'قرّب لتحرير الأشجار')); return; }
      // whatever is nearest the tap wins: a tree you added, a gap, a dot
      var hit = null, hd = tol;
      S.added.forEach(function (q, i) { var d = Math.hypot(q[0] - p.x, q[1] - p.y); if (d < hd) { hd = d; hit = { t: 'add', i: i }; } });
      if (S.rows.length) gaps().gaps.forEach(function (q) { var d = Math.hypot(q[0] - p.x, q[1] - p.y); if (d < hd) { hd = d; hit = { t: 'gap', q: q }; } });
      var kd = nearestDet(p.x, p.y, hd, true);
      if (kd >= 0) hit = { t: 'det', k: kd };
      snapshot();
      if (hit && hit.t === 'add') { S.added.splice(hit.i, 1); afterChange(); return; }
      if (hit && hit.t === 'gap') { S.added.push(hit.q.slice()); afterChange(); return; }
      if (hit && hit.t === 'det') { if (S.rej[hit.k]) delete S.rej[hit.k]; else S.rej[hit.k] = 1; afterChange(); return; }
      S.added.push([p.x, p.y]); afterChange();
    }
  }
  // Frame a ring in the part of the map the panel does not cover.
  function showAbovePanel(ring) {
    var m = getMap(), el = document.getElementById('tmPanel'); if (!m || !ring) return;
    var ph = (el && el.style.display !== 'none') ? el.getBoundingClientRect().height : 0;
    try { m.fitBounds(L.latLngBounds(ringLL(ring)), { paddingTopLeft: [24, 24], paddingBottomRight: [24, ph + 24], maxZoom: m.getZoom() }); } catch (e) {}
  }
  function finishDrawing() {
    var d = S.drawing; S.drawing = null;
    if (d && d.length >= 3) { snapshot(); S.outline = d; S.rows = []; S.grid = null; }
    afterChange();
  }
  function setMode(mode) {
    S.mode = mode;
    if (mode !== 'outline') S.drawing = null;
    if (window.MapAccess && MapAccess.setExternalDraw) MapAccess.setExternalDraw(mode === 'outline' || mode === 'trees');
    redraw(); render();
  }
  function loadPlotOutline(id) {
    var r = window.MapAccess && MapAccess.getPlotRings ? MapAccess.getPlotRings(Number(id)) : null;
    if (!r || !r.rings.length) return;
    if (!S.mpp) S.mpp = mppAt(r.rings[0][0].lat);
    snapshot();
    S.outline = r.rings[0].map(function (c) { var p = toPx(c.lat, c.lng); return [p.x, p.y]; });
    S.rows = []; S.grid = null; S.target = String(r.id);
    var m = getMap(); if (m) m.fitBounds(L.latLngBounds(r.rings[0]), { padding: [40, 40], maxZoom: 18 });
    setMode('outline');
  }

  // ── Result ───────────────────────────────────────────────────────────
  function plotsHere() {
    var list = (window.MapAccess && MapAccess.listPlotsWithRings) ? MapAccess.listPlotsWithRings() : [];
    var m = getMap(); if (!m) return [];
    var b = m.getBounds();
    return list.filter(function (p) { return p.rings.length && p.rings[0].some(function (c) { return b.contains(c); }); });
  }
  function readNum(id, lo, hi) {
    var el = document.getElementById(id); if (!el || el.value === '') return null;
    var v = parseFloat(el.value); return (isFinite(v) && v >= lo && v <= hi) ? v : NaN;
  }
  function commit() {
    if (!isAdmin()) { if (window.Own) Own.denied(); return; }
    if (!S.outline) return;
    var f = {
      tree_count: readNum('tmFTrees', 0, 1000000), missing_trees: readNum('tmFMissing', 0, 1000000),
      tree_spacing: readNum('tmFTreeSp', 0.5, 30), row_spacing: readNum('tmFRowSp', 0.5, 30), plants_per_dunam: readNum('tmFPpd', 1, 100000)
    };
    var badF = Object.keys(f).filter(function (k) { return f[k] !== null && isNaN(f[k]); });
    if (badF.length) { toast('⚠️ ' + tt('ערך לא תקין', 'ค่าไม่ถูกต้อง', 'قيمة غير صالحة')); return; }
    if (f.tree_count != null) f.tree_count = Math.round(f.tree_count);
    if (f.missing_trees != null) f.missing_trees = Math.round(f.missing_trees);
    if (f.plants_per_dunam != null) f.plants_per_dunam = Math.round(f.plants_per_dunam);
    var ring = ringLL(S.outline);
    var r;
    if (S.target && S.target !== 'new') {
      var useRing = (document.getElementById('tmFRing') || {}).checked;
      r = MapAccess.updatePlotTreeData ? MapAccess.updatePlotTreeData(Number(S.target), f, useRing ? ring : null) : { ok: false };
      if (!r || !r.ok) { toast('❌ ' + tt('עדכון החלקה נכשל', 'อัปเดตแปลงไม่สำเร็จ', 'فشل تحديث القطعة')); return; }
      toast('✅ ' + tt('החלקה עודכנה', 'อัปเดตแปลงแล้ว', 'تم تحديث القطعة'));
    } else {
      var farmId = parseInt(S.farmId, 10);
      if (!farmId) { toast('❌ ' + tt('חובה לבחור משק', 'ต้องเลือกฟาร์ม', 'يجب اختيار مزرعة')); return; }
      r = MapAccess.addImportedPlots([{
        ring: ring, name: S.name, farmId: farmId, cropType: S.crop || null,
        treeCount: f.tree_count, missingTrees: f.missing_trees, treeSpacing: f.tree_spacing, rowSpacing: f.row_spacing, plantsPerDunam: f.plants_per_dunam
      }]);
      if (!r || !r.ok) { toast('❌ ' + tt('יצירת החלקה נכשלה', 'สร้างแปลงไม่สำเร็จ', 'فشل إنشاء القطعة')); return; }
      toast('✅ ' + tt('החלקה נוצרה', 'สร้างแปลงแล้ว', 'تم إنشاء القطعة'));
    }
    // the next plot starts from the same scan
    snapshot();
    S.outline = null; S.rows = []; S.grid = null; S.target = 'new'; S.name = '';
    setMode('outline');
  }

  // ── Panel ────────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('tmStyles')) return;
    var st = document.createElement('style');
    st.id = 'tmStyles';
    st.textContent =
      '.tm-panel{position:fixed;left:8px;right:8px;bottom:8px;max-height:52vh;overflow:auto;z-index:1500;' +
      'background:var(--card,#fff);color:var(--text,#1b1b1b);border-radius:16px;box-shadow:0 6px 28px rgba(0,0,0,.28);' +
      'padding:0 14px 12px;font-family:Heebo,sans-serif;font-size:14px;max-width:580px;margin:0 auto}' +
      '@media (max-width:600px){.tm-panel{max-height:42vh}}' +
      '.tm-head{position:sticky;top:0;background:var(--card,#fff);display:flex;gap:6px;align-items:center;padding:10px 0 6px;z-index:2}' +
      '.tm-head h3{margin:0;font-size:16px;flex:1}' +
      '.tm-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:7px 0}' +
      '.tm-btn{border:0;border-radius:10px;padding:8px 11px;font:inherit;font-weight:600;cursor:pointer;background:var(--g5,#e8f5e9);color:var(--g1,#1b5e20)}' +
      '.tm-btn.pri{background:var(--g2,#2e7d32);color:#fff}.tm-btn:disabled{opacity:.45;cursor:default}' +
      '.tm-btn.on{background:#0a6fa0;color:#fff}.tm-btn.big{flex:1;padding:12px 8px}' +
      '.tm-seg{display:flex;gap:4px;flex:1}.tm-seg .tm-btn{flex:1}' +
      '.tm-help{font-size:12.5px;opacity:.78;line-height:1.45;margin:4px 0}' +
      '.tm-status{font-size:13px;margin:6px 0;line-height:1.4}' +
      '.tm-kv{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}' +
      '.tm-kv div{background:rgba(0,0,0,.04);border-radius:10px;padding:6px 8px;text-align:center}' +
      '.tm-kv b{display:block;font-size:17px}.tm-kv span{font-size:11.5px;opacity:.75}' +
      '.tm-form{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px;margin:6px 0}' +
      '.tm-form label{font-size:12px;opacity:.8;display:flex;flex-direction:column;gap:2px}' +
      '.tm-panel input[type=text],.tm-panel input[type=number],.tm-panel select{font:inherit;padding:7px 8px;border-radius:8px;' +
      'border:1px solid rgba(0,0,0,.18);background:var(--card,#fff);color:inherit;min-width:0;width:100%;box-sizing:border-box}' +
      '.tm-legend{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;opacity:.85}' +
      '.tm-legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-inline-end:4px;vertical-align:-1px}' +
      '.tm-pill{position:fixed;bottom:70px;left:12px;z-index:1500;border:0;border-radius:20px;padding:9px 14px;' +
      'font:600 14px Heebo,sans-serif;background:#0a6fa0;color:#fff;box-shadow:0 3px 12px rgba(0,0,0,.3)}' +
      '.tm-v{background:#fff;border:3px solid #0a6fa0;border-radius:50%;box-sizing:border-box}' +
      '.tm-mid{background:rgba(63,208,255,.6);border:2px solid #fff;border-radius:50%;box-sizing:border-box}';
    document.head.appendChild(st);
  }
  function panelEl() {
    var el = document.getElementById('tmPanel');
    if (!el) {
      el = document.createElement('div'); el.id = 'tmPanel'; el.className = 'tm-panel';
      (document.getElementById('tabMap') || document.body).appendChild(el);
      el.addEventListener('click', onPanelClick);
      el.addEventListener('change', onPanelInput);
      el.addEventListener('input', onPanelInput);
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
    p.textContent = '🌴 ' + tt('איתור לפי עצים', 'ค้นหาตามต้นไม้', 'تحديد حسب الأشجار');
    if (!on) render();
  }
  function setStatus(t) { if (!S) return; S.status = t; var el = document.getElementById('tmStatus'); if (el) el.textContent = t; else render(); }
  function render() {
    if (!S || S.minimized) return;
    var el = panelEl(); el.setAttribute('dir', isRtl() ? 'rtl' : 'ltr');
    var dn = tt('ד׳', 'ไร่', 'دونم'), mm = tt('מ׳', 'ม.', 'م');
    var h = '<div class="tm-head"><h3>🌴 ' + tt('איתור חלקה לפי עצים', 'ค้นหาแปลงตามต้นไม้', 'تحديد القطعة حسب الأشجار') + '</h3>' +
      '<button class="tm-btn" data-act="undo"' + (S.undo.length ? '' : ' disabled') + ' title="' + esc(tt('בטל', 'เลิกทำ', 'تراجع')) + '">↶</button>' +
      '<button class="tm-btn" data-act="min" title="' + esc(tt('מזער', 'ย่อ', 'تصغير')) + '">▾</button>' +
      '<button class="tm-btn" data-act="close" title="' + esc(tt('סגור', 'ปิด', 'إغلاق')) + '">✕</button></div>';
    h += '<div class="tm-row"><button class="tm-btn pri big" data-act="scan"' + (S.busy ? ' disabled' : '') + '>🛰️ ' +
      (S.scans ? tt('סרוק גם את התצוגה הזו', 'สแกนมุมมองนี้ด้วย', 'امسح هذا العرض أيضًا') : tt('סרוק עצים בתצוגה', 'สแกนต้นไม้ในมุมมอง', 'امسح الأشجار في العرض')) + '</button></div>';
    if (!S.scans && !S.outline) {
      h += '<p class="tm-help">' + tt(
        'התקרב לאזור החלקה (עד כ־2 קמ״ר בתצוגה) ולחץ סרוק. כל עץ בתצלום האוויר יסומן בנקודה. החישוב נעשה במכשיר, בלי עלות.',
        'ซูมไปยังพื้นที่แปลง (ไม่เกินประมาณ 2 ตร.กม. ในมุมมอง) แล้วกดสแกน ต้นไม้ทุกต้นในภาพถ่ายทางอากาศจะถูกทำเครื่องหมายเป็นจุด การคำนวณทำบนอุปกรณ์ ไม่มีค่าใช้จ่าย',
        'قرّب إلى منطقة القطعة (حتى نحو 2 كم² في العرض) واضغط امسح. ستُعلَّم كل شجرة في الصورة الجوية بنقطة. يتم الحساب على الجهاز دون تكلفة.') + '</p>';
    }
    h += '<div class="tm-status" id="tmStatus">' + esc(S.status || '') + '</div>';
    h += '<div class="tm-help" id="tmZoomNote" style="display:' + (S.tooMany ? '' : 'none') + '">🔍 ' + tt('התקרב כדי לראות ולערוך עצים בודדים', 'ซูมเข้าเพื่อดูและแก้ไขต้นไม้แต่ละต้น', 'قرّب لرؤية الأشجار الفردية وتحريرها') + '</div>';

    h += '<div class="tm-row"><div class="tm-seg">' +
      '<button class="tm-btn' + (S.mode === 'pan' ? ' on' : '') + '" data-act="mode" data-m="pan">✋ ' + tt('מפה', 'แผนที่', 'الخريطة') + '</button>' +
      '<button class="tm-btn' + (S.mode === 'outline' ? ' on' : '') + '" data-act="mode" data-m="outline">📐 ' + tt('גבול', 'ขอบเขต', 'الحدود') + '</button>' +
      '<button class="tm-btn' + (S.mode === 'trees' ? ' on' : '') + '" data-act="mode" data-m="trees">🌴 ' + tt('עצים', 'ต้นไม้', 'الأشجار') + '</button></div></div>';

    if (S.mode === 'outline') {
      h += '<p class="tm-help">' + (S.drawing
        ? tt('הקש על פינות הגבול. הקש על הפינה הראשונה או על סיים כדי לסגור.', 'แตะมุมของขอบเขต แตะมุมแรกหรือกดเสร็จเพื่อปิด', 'انقر على زوايا الحدود. انقر على الزاوية الأولى أو على إنهاء للإغلاق.')
        : tt('הקש בתוך מטע: הגבול יסומן סביב העצים המחוברים. גרור פינה לתיקון, גרור נקודה כחולה להוספת פינה, הקש על פינה למחיקתה.',
             'แตะในสวน: ขอบเขตจะถูกวาดรอบต้นไม้ที่เชื่อมกัน ลากมุมเพื่อแก้ไข ลากจุดสีฟ้าเพื่อเพิ่มมุม แตะมุมเพื่อลบ',
             'انقر داخل البستان: تُرسم الحدود حول الأشجار المتصلة. اسحب زاوية للتصحيح، واسحب النقطة الزرقاء لإضافة زاوية، وانقر على زاوية لحذفها.')) + '</p>';
      h += '<div class="tm-row">' + (S.drawing
        ? '<button class="tm-btn pri" data-act="finishDraw">✔ ' + tt('סיים', 'เสร็จ', 'إنهاء') + '</button><button class="tm-btn" data-act="cancelDraw">' + tt('בטל ציור', 'ยกเลิกการวาด', 'إلغاء الرسم') + '</button>'
        : '<button class="tm-btn" data-act="draw">✏️ ' + tt('סמן פינות ידנית', 'วาดมุมเอง', 'ارسم الزوايا يدويًا') + '</button>');
      var here = plotsHere();
      if (here.length && !S.drawing) {
        h += '<select data-in="loadPlot" style="flex:1"><option value="">' + tt('טען גבול מחלקה קיימת…', 'โหลดขอบเขตจากแปลงที่มีอยู่…', 'حمّل حدود قطعة موجودة…') + '</option>' +
          here.map(function (p) { return '<option value="' + p.id + '">' + esc(p.name) + '</option>'; }).join('') + '</select>';
      }
      if (S.outline && !S.drawing) h += '<button class="tm-btn" data-act="clearOutline">🗑️ ' + tt('נקה גבול', 'ล้างขอบเขต', 'امسح الحدود') + '</button>';
      h += '</div>';
    }
    if (S.mode === 'trees') {
      h += '<p class="tm-help">' + tt(
        'הקש על נקודה אדומה כדי לדחות אותה (לא עץ), ושוב כדי להחזיר. הקש על קרקע ריקה כדי להוסיף עץ, ועל נקודה כחולה כדי להסיר אותו. הקש על טבעת כתומה כדי לשים בה עץ.',
        'แตะจุดสีแดงเพื่อปฏิเสธ (ไม่ใช่ต้นไม้) แตะอีกครั้งเพื่อคืน แตะพื้นว่างเพื่อเพิ่มต้นไม้ แตะจุดสีน้ำเงินเพื่อลบ แตะวงสีส้มเพื่อใส่ต้นไม้',
        'انقر على نقطة حمراء لرفضها (ليست شجرة)، ومرة أخرى لإعادتها. انقر على أرض فارغة لإضافة شجرة، وعلى نقطة زرقاء لإزالتها. انقر على حلقة برتقالية لوضع شجرة فيها.') + '</p>';
    }
    h += '<div class="tm-legend"><span><i style="background:#ff2a2a"></i>' + tt('עץ בחלקה', 'ต้นในแปลง', 'شجرة في القطعة') + '</span>' +
      '<span><i style="background:#ffd400"></i>' + tt('מחוץ לגבול', 'นอกขอบเขต', 'خارج الحدود') + '</span>' +
      '<span><i style="background:#1e90ff"></i>' + tt('נוסף ידנית', 'เพิ่มเอง', 'أُضيف يدويًا') + '</span>' +
      '<span><i style="background:#555"></i>' + tt('נדחה', 'ปฏิเสธ', 'مرفوض') + '</span>' +
      '<span><i style="border:2px solid #ff9f1c;box-sizing:border-box"></i>' + tt('רווח בשורה', 'ช่องว่างในแถว', 'فجوة في الصف') + '</span></div>';

    var s = stats();
    if (s) {
      h += '<div class="tm-kv">' +
        '<div><b id="tmLiveArea">' + fmt(s.areaDn, 2) + '</b><span>' + tt('דונם', 'ไร่', 'دونم') + '</span></div>' +
        '<div><b>' + fmt(s.trees) + '</b><span>' + tt('עצים בגבול', 'ต้นในขอบเขต', 'أشجار ضمن الحدود') + '</span></div>' +
        '<div><b>' + (s.areaDn ? fmt(s.trees / s.areaDn, 1) : '–') + '</b><span>' + tt('עצים לדונם', 'ต้นต่อไร่', 'شجرة لكل دونم') + '</span></div>' +
        '<div><b>' + (s.positions != null ? fmt(s.positions) : '–') + '</b><span>' + tt('מקומות בשורות', 'ตำแหน่งในแถว', 'مواقع في الصفوف') + '</span></div>' +
        '<div><b>' + (s.gaps != null ? fmt(s.gaps) : '–') + '</b><span>' + tt('רווחים', 'ช่องว่าง', 'فجوات') + '</span></div>' +
        '<div><b dir="ltr">' + (S.grid ? fmt(S.grid.tree, 1) + ' × ' + fmt(S.grid.row, 1) : '–') + '</b><span>' + tt('מרווח (מ׳)', 'ระยะ (ม.)', 'المسافة (م)') + '</span></div></div>';
      h += '<div class="tm-help" id="tmLive">' + (s.added || s.rejected ? (s.added + ' ' + tt('נוספו', 'เพิ่ม', 'أُضيفت') + ' · ' + s.rejected + ' ' + tt('נדחו', 'ปฏิเสธ', 'رُفضت')) : '') + '</div>';
      h += '<div class="tm-row"><button class="tm-btn" data-act="rows">〰️ ' + tt('מצא שורות', 'หาแถว', 'أوجد الصفوف') + '</button>' +
        '<button class="tm-btn" data-act="fill"' + (S.rows.length ? '' : ' disabled') + '>➕ ' + tt('מלא רווחים', 'เติมช่องว่าง', 'املأ الفجوات') + '</button>' +
        '<button class="tm-btn" data-act="offrow"' + (S.rows.length ? '' : ' disabled') + '>🚫 ' + tt('דחה מחוץ לשורות', 'ปฏิเสธนอกแถว', 'ارفض خارج الصفوف') + '</button>' +
        '<button class="tm-btn" data-act="clearRows"' + (S.rows.length ? '' : ' disabled') + '>' + tt('נקה שורות', 'ล้างแถว', 'امسح الصفوف') + '</button></div>';
      if (S.rows.length) {
        h += '<p class="tm-help">' + tt(
          'רווח הוא מקום על קו השורה בלי עץ: עץ חסר, או עץ שהנוף של שכניו מסתיר. עבור על הרווחים במצב עצים ומלא רק את אלה שיש בהם עץ.',
          'ช่องว่างคือตำแหน่งบนแนวแถวที่ไม่มีต้นไม้ อาจเป็นต้นที่ขาด หรือต้นที่ถูกพุ่มของต้นข้างเคียงบัง ตรวจช่องว่างในโหมดต้นไม้และเติมเฉพาะที่มีต้นไม้จริง',
          'الفجوة موقع على خط الصف بلا شجرة: شجرة ناقصة، أو شجرة يخفيها تاج جيرانها. راجع الفجوات في وضع الأشجار واملأ فقط ما فيه شجرة.') + '</p>';
      }

      // result form
      var trees = s.trees, missing = s.gaps != null ? s.gaps : '', tsp = S.grid ? S.grid.tree.toFixed(1) : '', rsp = S.grid ? S.grid.row.toFixed(1) : '';
      var ppd = S.grid ? Math.round(1000 / (S.grid.tree * S.grid.row)) : (s.areaDn ? Math.round((trees + (s.gaps || 0)) / s.areaDn) : '');
      var here2 = plotsHere();
      h += '<div style="border-top:1px solid rgba(0,0,0,.1);margin-top:8px;padding-top:6px"><div class="tm-row">' +
        '<select data-in="target" style="flex:1"><option value="new">' + tt('➕ חלקה חדשה', '➕ แปลงใหม่', '➕ قطعة جديدة') + '</option>' +
        here2.map(function (p) { return '<option value="' + p.id + '"' + (String(S.target) === String(p.id) ? ' selected' : '') + '>✏️ ' + tt('עדכן', 'อัปเดต', 'حدّث') + ': ' + esc(p.name) + '</option>'; }).join('') +
        '</select></div>';
      if (!S.target || S.target === 'new') {
        var farmsList = (window.MapAccess && MapAccess.listUserFarms) ? MapAccess.listUserFarms() : [];
        if (!S.farmId && farmsList.length === 1) S.farmId = farmsList[0].id;
        var crops = []; try { crops = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]'); } catch (e) {}
        h += '<div class="tm-row"><input type="text" data-in="name" style="flex:1" placeholder="' + esc(tt('שם החלקה', 'ชื่อแปลง', 'اسم القطعة')) + '" value="' + esc(S.name || '') + '"></div>' +
          '<div class="tm-row"><select data-in="farm" style="flex:1"><option value="">' + tt('בחר משק', 'เลือกฟาร์ม', 'اختر مزرعةً') + '</option>' +
          farmsList.map(function (f) { return '<option value="' + f.id + '"' + (String(S.farmId) === String(f.id) ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select>' +
          '<select data-in="crop" style="flex:1"><option value="">' + tt('גידול (לא חובה)', 'พืช (ไม่บังคับ)', 'المحصول (اختياري)') + '</option>' +
          crops.map(function (c) { return '<option value="' + esc(c) + '"' + (S.crop === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></div>';
      } else {
        h += '<div class="tm-row"><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="tmFRing" checked> ' +
          tt('החלף גם את גבול החלקה בגבול הזה', 'แทนที่ขอบเขตแปลงด้วยขอบเขตนี้ด้วย', 'استبدل حدود القطعة بهذه الحدود أيضًا') + '</label></div>';
      }
      h += '<div class="tm-form">' +
        '<label>' + tt('מספר עצים', 'จำนวนต้น', 'عدد الأشجار') + '<input type="number" id="tmFTrees" min="0" value="' + trees + '"></label>' +
        '<label>' + tt('עצים חסרים', 'ต้นที่ขาด', 'أشجار ناقصة') + '<input type="number" id="tmFMissing" min="0" value="' + missing + '"></label>' +
        '<label>' + tt('מרווח בין עצים', 'ระยะระหว่างต้น', 'المسافة بين الأشجار') + ' (' + mm + ')<input type="number" step="0.1" id="tmFTreeSp" value="' + tsp + '"></label>' +
        '<label>' + tt('מרווח בין שורות', 'ระยะระหว่างแถว', 'المسافة بين الصفوف') + ' (' + mm + ')<input type="number" step="0.1" id="tmFRowSp" value="' + rsp + '"></label>' +
        '<label>' + tt('צמחים לדונם', 'ต้นต่อไร่', 'نباتات لكل دونم') + '<input type="number" id="tmFPpd" value="' + ppd + '"></label>' +
        '<label>' + tt('שטח', 'พื้นที่', 'المساحة') + ' (' + dn + ')<input type="text" value="' + fmt(s.areaDn, 2) + '" disabled></label></div>';
      h += '<p class="tm-help">' + tt('בדוק את המספרים לפני השמירה: אלה הערכות מתצלום אוויר, שתאריכו לא ידוע.', 'ตรวจตัวเลขก่อนบันทึก: เป็นค่าประมาณจากภาพถ่ายทางอากาศที่ไม่ทราบวันที่', 'تحقق من الأرقام قبل الحفظ: هذه تقديرات من صورة جوية تاريخها غير معروف.') + '</p>';
      h += '<div class="tm-row"><button class="tm-btn pri big" data-act="commit"' + (isAdmin() ? '' : ' disabled') + '>✅ ' +
        ((!S.target || S.target === 'new') ? tt('צור חלקה', 'สร้างแปลง', 'أنشئ القطعة') : tt('עדכן חלקה', 'อัปเดตแปลง', 'حدّث القطعة')) + '</button></div></div>';
    }
    el.innerHTML = h;
  }
  function onPanelClick(e) {
    var b = e.target.closest('[data-act]'); if (!b || !S) return;
    var act = b.getAttribute('data-act');
    if (act === 'close') close(false);
    else if (act === 'min') setMinimized(true);
    else if (act === 'undo') undo();
    else if (act === 'scan') scan();
    else if (act === 'mode') setMode(b.getAttribute('data-m'));
    else if (act === 'draw') { S.drawing = []; render(); drawOutline(); }
    else if (act === 'finishDraw') finishDrawing();
    else if (act === 'cancelDraw') { S.drawing = null; afterChange(); }
    else if (act === 'clearOutline') { snapshot(); S.outline = null; S.rows = []; S.grid = null; afterChange(); }
    else if (act === 'rows') fitRows();
    else if (act === 'fill') fillGaps();
    else if (act === 'offrow') rejectOffRow();
    else if (act === 'clearRows') { snapshot(); S.rows = []; S.grid = null; afterChange(); }
    else if (act === 'commit') commit();
  }
  function onPanelInput(e) {
    var t = e.target, k = t.getAttribute('data-in'); if (!k || !S) return;
    if (k === 'name') S.name = t.value;
    else if (k === 'farm') S.farmId = t.value;
    else if (k === 'crop') S.crop = t.value;
    else if (k === 'target' && e.type === 'change') { S.target = t.value; render(); }
    else if (k === 'loadPlot' && e.type === 'change' && t.value) loadPlotOutline(t.value);
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
      S = { px: [], bk: {}, rej: {}, added: [], outline: null, drawing: null, rows: [], grid: null, undo: [],
            mode: 'pan', scans: 0, busy: false, status: '', mpp: 0, showDots: true, tooMany: false,
            farmId: '', crop: '', name: '', target: 'new', layers: null, minimized: false };
      var m = getMap(); if (m) S.mpp = mppAt(m.getCenter().lat);
    }
    ensureLayers();
    setMinimized(false);
    redraw();
  }
  function close(force) {
    if (!S) return;
    if (!force && (S.scans || S.outline) &&
        !window.confirm(tt('לסגור? העצים שאותרו והגבול שסומן לא יישמרו.', 'ปิด? ต้นไม้ที่พบและขอบเขตที่วาดจะไม่ถูกบันทึก', 'إغلاق؟ لن تُحفظ الأشجار المحددة والحدود المرسومة.'))) return;
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
    if (t1) t1.textContent = tt('איתור חלקה לפי עצים', 'ค้นหาแปลงตามต้นไม้', 'تحديد القطعة حسب الأشجار');
    if (t2) t2.textContent = tt('גבול, עצים ומרווחים מתצלום אוויר', 'ขอบเขต ต้นไม้ และระยะจากภาพถ่ายทางอากาศ', 'الحدود والأشجار والمسافات من صورة جوية');
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
    _toPx: toPx, _toLL: toLL, _detectWindow: detectWindow, _simplify: simplify, _boundary: outerBoundary,
    _state: function () { return S; }, _autoOutline: function (x, y) { return autoOutline(x, y); },
    _fitRows: function () { return fitRows(); }, _stats: function () { return stats(); }, _redraw: function () { redraw(); }, _addPoint: function (x, y) { return addPoint(x, y); }
  };
})();
