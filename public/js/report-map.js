/* report-map.js — satellite overview image for printed reports
 * ------------------------------------------------------------------
 * Composites Esri World Imagery tiles onto a canvas, draws the farm's
 * plot polygons on top with names, a scale bar and baked-in imagery
 * attribution, and hands back a JPEG data URL that generatePdfHtml
 * drops straight into the report.
 *
 * WHY A PRE-BAKED IMAGE AND NOT A LIVE MAP:
 *   The report is a standalone HTML document opened in a new window and
 *   printed. A Leaflet map there would need its own script, its own
 *   async tile loads, and would very likely print half-drawn or blank.
 *   A single <img> with a data URL is already fully resolved by the time
 *   the print dialog opens — nothing to race.
 *
 * WHY A CACHE AND NOT AN AWAIT AT EXPORT TIME:
 *   window.open() must run inside the user-gesture context or popup
 *   blockers eat it — app.js already refuses to export while field
 *   reports are still loading for exactly this reason. So the image is
 *   rendered ahead of time into a cache, and the export reads it
 *   synchronously. If it is not ready, the caller refuses and asks the
 *   user to retry in a moment, matching the existing convention.
 *
 * The canvas is tainted unless every tile arrives with CORS headers, so
 * tiles are requested with crossOrigin='anonymous' and any failure
 * rejects quietly: a report without the map is fine, a broken export is
 * not.
 */
var ReportMap = (function () {
  'use strict';

  var TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
  var ATTRIBUTION = 'Imagery \u00a9 Esri, Maxar, Earthstar Geographics';
  var TILE = 256;
  var MAX_Z = 19;
  var MIN_Z = 9;
  var W = 1000;          // canvas px — ~A4 landscape content width at print
  var H = 660;
  var MARGIN = 70;       // px of surrounding area kept on every side
  var TILE_TIMEOUT = 9000;
  var CACHE_TTL = 30 * 60 * 1000;

  var cache = {};        // key -> { url: dataURL, at: ms, sig: geometrySignature }
  var inflight = {};     // key -> Promise
  var failed = {};       // key -> ms of last definitive failure

  function tt(he, th, ar) {
    if (typeof window.tt === 'function') return window.tt(he, th, ar);
    return he;
  }

  // ── Web Mercator ──
  function project(lat, lng, z) {
    var n = TILE * Math.pow(2, z);
    var s = Math.sin(lat * Math.PI / 180);
    s = Math.max(-0.9999, Math.min(0.9999, s));
    return {
      x: (lng + 180) / 360 * n,
      y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n
    };
  }

  function normLatLng(c) {
    if (!c) return null;
    var lat = (c.lat !== undefined) ? c.lat : c[0];
    var lng = (c.lng !== undefined) ? c.lng : c[1];
    lat = parseFloat(lat); lng = parseFloat(lng);
    if (isNaN(lat) || isNaN(lng)) return null;
    return { lat: lat, lng: lng };
  }

  function ringOf(plot) {
    var raw = plot && plot.latlngs;
    if (!raw || !raw.length) return null;
    var ring = raw.map(normLatLng).filter(Boolean);
    return ring.length >= 3 ? ring : null;
  }

  // Every ring a plot owns, primary plus any detached parts. A printed
  // spray report that drew only the primary ring showed half a plot as the
  // whole plot — and the map on a report is exactly what someone checks
  // when they want to know what was treated.
  function ringsOf(plot) {
    var out = [];
    var main = ringOf(plot);
    if (main) out.push(main);
    ((plot && plot.parts) || []).forEach(function (raw) {
      if (raw && !Array.isArray(raw) && Array.isArray(raw.pts)) raw = raw.pts;   // stored shape
      if (!raw || raw.length < 3) return;
      var r = raw.map(normLatLng).filter(Boolean);
      if (r.length >= 3) out.push(r);
    });
    return out;
  }

  function bboxOf(rings) {
    var b = { n: -90, s: 90, e: -180, w: 180 };
    rings.forEach(function (ring) {
      ring.forEach(function (p) {
        if (p.lat > b.n) b.n = p.lat;
        if (p.lat < b.s) b.s = p.lat;
        if (p.lng > b.e) b.e = p.lng;
        if (p.lng < b.w) b.w = p.lng;
      });
    });
    // A single tiny plot would otherwise ask for zoom 22 and no context.
    var dLat = Math.max(b.n - b.s, 0.0012);
    var dLng = Math.max(b.e - b.w, 0.0012);
    var cLat = (b.n + b.s) / 2, cLng = (b.e + b.w) / 2;
    return {
      n: cLat + dLat / 2, s: cLat - dLat / 2,
      e: cLng + dLng / 2, w: cLng - dLng / 2
    };
  }

  // Zoom in as far as the plots allow while still leaving MARGIN px of
  // surrounding ground on each side — the context is the point, but a
  // plot lost in an ocean of neighbouring fields is not a plot map.
  function fitZoom(box) {
    for (var z = MAX_Z; z >= MIN_Z; z--) {
      var a = project(box.n, box.w, z);
      var b = project(box.s, box.e, z);
      if ((b.x - a.x) <= (W - MARGIN * 2) && (b.y - a.y) <= (H - MARGIN * 2)) return z;
    }
    return MIN_Z;
  }

  function loadTile(z, x, y) {
    return new Promise(function (resolve) {
      var img = new Image();
      var done = false;
      var timer = setTimeout(function () {
        if (!done) { done = true; resolve(null); }
      }, TILE_TIMEOUT);
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(img);
      };
      img.onerror = function () {
        if (done) return;
        done = true; clearTimeout(timer); resolve(null);
      };
      img.src = TILE_URL.replace('{z}', z).replace('{y}', y).replace('{x}', x);
    });
  }

  // ── drawing helpers ──
  function hexRgba(hex, alpha) {
    var h = String(hex || '#4caf50').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    if (isNaN(n)) return 'rgba(76,175,80,' + alpha + ')';
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')';
  }

  function centroid(pts) {
    var a = 0, cx = 0, cy = 0;
    for (var i = 0; i < pts.length; i++) {
      var j = (i + 1) % pts.length;
      var f = pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      a += f; cx += (pts[i].x + pts[j].x) * f; cy += (pts[i].y + pts[j].y) * f;
    }
    if (Math.abs(a) < 1e-9) {
      var sx = 0, sy = 0;
      pts.forEach(function (p) { sx += p.x; sy += p.y; });
      return { x: sx / pts.length, y: sy / pts.length };
    }
    a *= 0.5;
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  function drawLabel(ctx, text, x, y, size) {
    ctx.font = '700 ' + size + 'px -apple-system, "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(3, size / 4);
    ctx.strokeStyle = 'rgba(0,0,0,0.72)';
    ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(text, x, y);
  }

  function drawScaleBar(ctx, z, lat) {
    var mPerPx = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, z);
    var targetPx = 160;
    var raw = mPerPx * targetPx;
    var pow = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var nice = [1, 2, 5, 10].map(function (m) { return m * pow; })
      .reduce(function (best, v) {
        return Math.abs(v - raw) < Math.abs(best - raw) ? v : best;
      }, pow);
    var px = nice / mPerPx;
    var label = nice >= 1000 ? (nice / 1000) + ' \u05e7"\u05de' : nice + ' \u05de\u05f3';

    var x = 18, y = H - 22;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x - 6, y - 16, px + 12, 30);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y + 3);
    ctx.moveTo(x, y); ctx.lineTo(x + px, y);
    ctx.moveTo(x + px, y - 5); ctx.lineTo(x + px, y + 3);
    ctx.stroke();
    ctx.font = '700 12px -apple-system, "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(label, x, y - 6);
  }

  function drawAttribution(ctx) {
    ctx.font = '11px -apple-system, "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    var w = ctx.measureText(ATTRIBUTION).width;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(W - w - 14, H - 24, w + 12, 20);
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(ATTRIBUTION, W - 8, H - 8);
  }

  function drawNorth(ctx) {
    var x = W - 30, y = 32;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, y - 11); ctx.lineTo(x - 6, y + 9); ctx.lineTo(x, y + 4);
    ctx.lineTo(x + 6, y + 9); ctx.closePath();
    ctx.stroke();
    ctx.font = '700 10px -apple-system, "Segoe UI", Arial, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText('N', x, y + 13);
  }

  // ── the render itself ──
  // subject = plots drawn in full colour (the ones the report covers)
  // context = other plots of the same farm, drawn faint for orientation
  function compose(subject, context) {
    var subjRings = [];
    subject.forEach(function (p) {
      ringsOf(p).forEach(function (r) { subjRings.push({ plot: p, ring: r }); });
    });
    if (!subjRings.length) return Promise.reject(new Error('no-geometry'));

    var ctxRings = [];
    (context || []).forEach(function (p) {
      ringsOf(p).forEach(function (r) { ctxRings.push({ plot: p, ring: r }); });
    });

    var box = bboxOf(subjRings.map(function (o) { return o.ring; }));
    var z = fitZoom(box);
    var tl = project(box.n, box.w, z);
    var br = project(box.s, box.e, z);
    // Centre the fitted bbox inside the fixed canvas.
    var originX = tl.x - (W - (br.x - tl.x)) / 2;
    var originY = tl.y - (H - (br.y - tl.y)) / 2;

    var x0 = Math.floor(originX / TILE), x1 = Math.floor((originX + W) / TILE);
    var y0 = Math.floor(originY / TILE), y1 = Math.floor((originY + H) / TILE);
    var span = Math.pow(2, z);

    var jobs = [];
    for (var tx = x0; tx <= x1; tx++) {
      for (var ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= span) continue;
        var wx = ((tx % span) + span) % span;
        jobs.push({ x: wx, y: ty, px: tx * TILE - originX, py: ty * TILE - originY });
      }
    }
    if (jobs.length > 90) return Promise.reject(new Error('area-too-large'));

    var canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#20301f';
    ctx.fillRect(0, 0, W, H);

    return Promise.all(jobs.map(function (j) {
      return loadTile(z, j.x, j.y).then(function (img) { return { j: j, img: img }; });
    })).then(function (loaded) {
      var ok = 0;
      loaded.forEach(function (r) {
        if (!r.img) return;
        ok++;
        ctx.drawImage(r.img, Math.round(r.j.px), Math.round(r.j.py), TILE, TILE);
      });
      // A mostly-empty basemap is a misleading document, not a partial one.
      if (ok < Math.ceil(loaded.length * 0.6)) throw new Error('tiles-failed');

      function toPx(p) {
        var q = project(p.lat, p.lng, z);
        return { x: q.x - originX, y: q.y - originY };
      }

      function drawRing(entry, faint) {
        var pts = entry.ring.map(toPx);
        ctx.beginPath();
        pts.forEach(function (p, i) { i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); });
        ctx.closePath();
        ctx.fillStyle = hexRgba(entry.plot.color, faint ? 0.07 : 0.20);
        ctx.fill();
        // White halo under the colour keeps the outline readable over both
        // bright soil and dark canopy.
        ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255,255,255,' + (faint ? 0.35 : 0.85) + ')';
        ctx.lineWidth = faint ? 2 : 4;
        ctx.stroke();
        ctx.strokeStyle = entry.plot.color || '#4caf50';
        ctx.lineWidth = faint ? 1 : 2.2;
        ctx.stroke();
        return centroid(pts);
      }

      ctxRings.forEach(function (e) { drawRing(e, true); });
      subjRings.forEach(function (e) {
        var c = drawRing(e, false);
        var name = e.plot.name || '';
        if (name && c.x > -40 && c.x < W + 40 && c.y > -20 && c.y < H + 20) {
          drawLabel(ctx, name, c.x, c.y, 15);
        }
      });

      drawScaleBar(ctx, z, (box.n + box.s) / 2);
      drawNorth(ctx);
      drawAttribution(ctx);

      // JPEG, not PNG: imagery compresses an order of magnitude smaller and
      // a 20-record report has to stay openable.
      return { url: canvas.toDataURL('image/jpeg', 0.82), zoom: z };
    });
  }

  // Geometry signature — a redrawn plot must invalidate the cached image.
  function sigOf(sets) {
    return signature((sets.subject || []).concat(sets.context || []));
  }

  function signature(list) {
    return list.map(function (p) {
      return p.id + ':' + (p.latlngs ? p.latlngs.length : 0) + ':' + (p.color || '');
    }).sort().join('|');
  }

  function allPlots() {
    return (window.SprayStore && window.SprayStore.getPlots)
      ? window.SprayStore.getPlots() : [];
  }

  // The מטע's main plot: an explicit main_plot_id on the farm if one is
  // set, otherwise the largest plot by area — on a date farm that is the
  // block the grower means when they say "the orchard".
  function mainPlotOf(farmId) {
    var mine = allPlots().filter(function (p) { return p.farm_id === farmId; });
    if (!mine.length) return null;
    // The grower's own choice wins: ReportTheme stores it as mainPlot on the
    // farm's report_theme. SprayStore.getFarms() projects to {id,name} only,
    // so the theme has to be read through getFarmTheme.
    var theme = (window.SprayStore && window.SprayStore.getFarmTheme)
      ? window.SprayStore.getFarmTheme(farmId) : null;
    var chosen = (theme && theme.mainPlot) ? parseInt(theme.mainPlot, 10) : null;
    if (chosen) {
      var named = mine.find(function (p) { return p.id === chosen; });
      if (named) return named;
    }
    return mine.slice().sort(function (a, b) {
      return areaOf(b) - areaOf(a);
    })[0];
  }

  // Stored area is authoritative, but plots drawn before area was recorded
  // have none \u2014 fall back to the polygon's own footprint so "largest plot"
  // never silently degrades into "first plot in the list".
  function areaOf(plot) {
    if (plot && plot.area) return plot.area;
    // Sum every ring, or a split plot ranks by its primary block alone
    // and loses 'largest plot' to a smaller neighbour.
    var rings = ringsOf(plot);
    if (!rings.length) return 0;
    var total = 0;
    rings.forEach(function (ring) {
      var latRef = ring[0].lat;
      var mPerDegLat = 111320;
      var mPerDegLng = 111320 * Math.cos(latRef * Math.PI / 180);
      var a = 0;
      for (var i = 0; i < ring.length; i++) {
        var j = (i + 1) % ring.length;
        var xi = ring[i].lng * mPerDegLng, yi = ring[i].lat * mPerDegLat;
        var xj = ring[j].lng * mPerDegLng, yj = ring[j].lat * mPerDegLat;
        a += xi * yj - xj * yi;
      }
      total += Math.abs(a / 2);
    });
    return total / 1000;   // m\u00b2 \u2192 dunam
  }

  // target: {plotId} for one plot, or {farmId} for a whole farm, or {} for all.
  // A plot-scoped image draws its own polygon in full colour and the rest of
  // the same מטע faint, so the plot is read in the context of the orchard
  // without another grower's blocks ever appearing.
  function plotsFor(target) {
    var t = target || {};
    var all = allPlots();
    if (t.plotId) {
      var subject = all.filter(function (p) { return p.id === t.plotId; });
      if (!subject.length) return { subject: [], context: [] };
      var fid = subject[0].farm_id || 0;
      var context = all.filter(function (p) {
        return p.id !== t.plotId && (p.farm_id || 0) === fid;
      });
      return { subject: subject, context: context };
    }
    if (t.farmId) {
      return { subject: all.filter(function (p) { return p.farm_id === t.farmId; }), context: [] };
    }
    return { subject: all.slice(), context: [] };
  }

  function key(target) {
    var t = target || {};
    if (t.plotId) return 'plot:' + t.plotId;
    return 'farm:' + (t.farmId || 'all');
  }

  // Callers pass a plot id, a farm id, or null. Normalised here so every
  // entry point agrees on what the cache key means.
  function asTarget(arg) {
    if (arg && typeof arg === 'object') return arg;
    return { farmId: arg || null };
  }

  function render(target) {
    var k = key(target);
    var sets = plotsFor(target);
    if (!sets.subject.length) return Promise.reject(new Error('no-plots'));
    var sig = sigOf(sets);

    var hit = cache[k];
    if (hit && hit.sig === sig && (Date.now() - hit.at) < CACHE_TTL) {
      return Promise.resolve(hit);
    }
    if (inflight[k]) return inflight[k];

    delete failed[k];
    inflight[k] = compose(sets.subject, sets.context).then(function (res) {
      cache[k] = { url: res.url, zoom: res.zoom, at: Date.now(), sig: sig };
      delete inflight[k];
      return cache[k];
    }, function (err) {
      // Remember the failure so the export stops waiting on a map that is
      // never coming (farms too far apart to frame, imagery blocked, tainted
      // canvas). Reports go out without it rather than not at all.
      failed[k] = Date.now();
      delete inflight[k];
      throw err;
    });
    return inflight[k];
  }

  // ════════════════════════════════════════════════════════════════
  // Per-orchard plots page (Oct 2026)
  // One printed page per מטע: the list of its plots with a clear picture of
  // their polygons and the data on them. Pure vector SVG — prints sharp,
  // needs no network, and so can never hold an export up the way satellite
  // tiles can.
  //
  // Two layouts, chosen per farm:
  //   overview — all plots drawn to scale on one map, every plot numbered,
  //              name + area + trees written on the polygons that have room,
  //              full data table beside the map;
  //   collage  — when the plots are scattered far apart an overview shrinks
  //              them to dots, so each plot gets its own card instead, drawn
  //              to fit, with its data under it.
  // Colours arrive literal from the report theme (TH): a print window has
  // no stylesheet, so no CSS variables here.
  // ════════════════════════════════════════════════════════════════

  function escH(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function storeApi() { return window.SprayStore || {}; }

  // Rings for a plot: stored latlngs (+ detached parts), or — for a plot
  // drawn this session and not reloaded yet — its live Leaflet layer.
  function sheetRings(p) {
    var r = ringsOf(p);
    if (r.length) return r;
    try {
      if (p && p.layer && typeof p.layer.getLatLngs === 'function') {
        var ll = p.layer.getLatLngs()[0].map(normLatLng).filter(Boolean);
        if (ll.length >= 3) return [ll];
      }
    } catch (e) {}
    return [];
  }

  function nameOf(p) {
    return (typeof window.locName === 'function') ? window.locName(p) : (p.name || '');
  }

  function isDate(p) { return /תמר/.test(String((p && p.crop_type) || '')); }

  // Farming branch of a plot (orchard / vineyard / field / veg / greenhouse)
  // decides which figures are meaningful: no tree counts for field crops.
  function bdefOf(p) {
    var PB = window.PlotBranch;
    return PB ? PB.def(PB.forPlot(p)) : { count: tt('מספר עצים', 'จำนวนต้น', 'عدد الأشجار'), spacing: true, ym: true, plant: '' };
  }
  function fmtDay(d) { try { return d ? new Date(d).toLocaleDateString('he-IL') : ''; } catch (e) { return ''; } }

  function fmtNum(n, d) {
    n = Number(n) || 0;
    return d ? n.toFixed(d) : Math.round(n).toLocaleString('he-IL');
  }

  // Local metric projection around the farm: x east, y south, metres.
  function projector(allRings) {
    var lat0 = 0, lng0 = 0, cnt = 0;
    allRings.forEach(function (ring) { ring.forEach(function (q) { lat0 += q.lat; lng0 += q.lng; cnt++; }); });
    lat0 /= cnt || 1; lng0 /= cnt || 1;
    var kx = Math.cos(lat0 * Math.PI / 180) * 111320, ky = 110540;
    return function (q) { return { x: (q.lng - lng0) * kx, y: (lat0 - q.lat) * ky }; };
  }

  function boxOf(ptsList) {
    var b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    ptsList.forEach(function (pts) {
      pts.forEach(function (q) {
        if (q.x < b.x0) b.x0 = q.x; if (q.x > b.x1) b.x1 = q.x;
        if (q.y < b.y0) b.y0 = q.y; if (q.y > b.y1) b.y1 = q.y;
      });
    });
    b.w = Math.max(b.x1 - b.x0, 1); b.h = Math.max(b.y1 - b.y0, 1);
    return b;
  }

  function inside(pt, pts) {
    var c = false;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[i], b = pts[j];
      if (((a.y > pt.y) !== (b.y > pt.y)) &&
          (pt.x < (b.x - a.x) * (pt.y - a.y) / ((b.y - a.y) || 1e-9) + a.x)) c = !c;
    }
    return c;
  }

  function edgeDist(pt, pts) {
    var best = Infinity;
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[j], b = pts[i];
      var dx = b.x - a.x, dy = b.y - a.y, len = dx * dx + dy * dy || 1e-9;
      var t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / len));
      var ex = a.x + t * dx - pt.x, ey = a.y + t * dy - pt.y;
      best = Math.min(best, Math.sqrt(ex * ex + ey * ey));
    }
    return best;
  }

  // Label anchor: the point inside the polygon farthest from its edges
  // (coarse grid search). A centroid can fall outside an L-shaped plot.
  function labelPoint(pts) {
    var b = boxOf([pts]), best = null, bestD = -1, N = 18;
    for (var i = 1; i < N; i++) {
      for (var j = 1; j < N; j++) {
        var pt = { x: b.x0 + b.w * i / N, y: b.y0 + b.h * j / N };
        if (!inside(pt, pts)) continue;
        var d = edgeDist(pt, pts);
        if (d > bestD) { bestD = d; best = pt; }
      }
    }
    if (!best) best = { x: b.x0 + b.w / 2, y: b.y0 + b.h / 2 };
    return { x: best.x, y: best.y, room: Math.max(bestD, 0) };
  }

  // Nearest polygon edge from pt along one axis (dir -1 / +1). Used to
  // size an overview label to the room it really has.
  function spanEdge(pts, pt, axis, dir) {
    var best = dir < 0 ? -Infinity : Infinity;
    var other = axis === 'x' ? 'y' : 'x';
    for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      var a = pts[j], b = pts[i];
      if ((a[other] > pt[other]) === (b[other] > pt[other])) continue;
      var t = (pt[other] - a[other]) / ((b[other] - a[other]) || 1e-9);
      var v = a[axis] + t * (b[axis] - a[axis]);
      if (dir < 0 && v <= pt[axis] && v > best) best = v;
      if (dir > 0 && v >= pt[axis] && v < best) best = v;
    }
    if (!isFinite(best)) best = pt[axis];
    return best;
  }

  function ringPath(pts) {
    return 'M' + pts.map(function (q) { return q.x.toFixed(1) + ' ' + q.y.toFixed(1); }).join(' L') + ' Z';
  }

  // Scale bar length in metres that fits ~22% of the drawing width.
  function niceLen(mPerPx, px) {
    var target = mPerPx * px, pow = Math.pow(10, Math.floor(Math.log(target) / Math.LN10));
    var best = pow;
    [1, 2, 5, 10].forEach(function (m) { if (m * pow <= target) best = m * pow; });
    return best;
  }

  function plotSheetCss(TH) {
    var c1 = TH.c1 || '#1d3d2e', c2 = TH.c2 || '#2f6a4f';
    var soft = TH.soft || '#e4eee8', line = TH.line || '#c6d8cd';
    return '' +
      '.ps-page{break-before:page;page-break-before:always;padding:4mm 6mm 0;}' +
      '.ps-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;' +
        'border-bottom:2px solid ' + line + ';padding-bottom:7px;margin-bottom:10px;}' +
      '.ps-head h2{margin:0;font-size:1.25rem;font-weight:700;color:' + c1 + ';}' +
      '.ps-head .ps-sub{font-size:.78rem;color:#6b6560;margin-top:2px;}' +
      '.ps-kpis{display:flex;gap:6px;flex-wrap:wrap;}' +
      '.ps-kpi{background:' + soft + ';color:' + c1 + ';border-radius:99px;padding:4px 11px;font-size:.76rem;font-weight:600;white-space:nowrap;}' +
      '.ps-body{display:flex;gap:12px;align-items:flex-start;}' +
      '.ps-portrait .ps-body{flex-direction:column;}' +
      '.ps-map{flex:1.35 1 0;min-width:0;border:1px solid ' + line + ';border-radius:14px;overflow:hidden;background:#fbfcfa;}' +
      '.ps-map svg{display:block;width:100%;height:auto;}' +
      '.ps-portrait .ps-map{width:100%;}' +
      '.ps-tbl{flex:1 1 0;min-width:0;}' +
      '.ps-portrait .ps-tbl{width:100%;}' +
      '.ps-tbl table{width:100%;border-collapse:collapse;margin:0;box-shadow:none;border-radius:0;}' +
      '.ps-tbl th{background:' + soft + ';color:' + c1 + ';font-size:.68rem;font-weight:700;padding:5px 6px;text-align:right;border:none;border-bottom:1.5px solid ' + line + ';}' +
      '.ps-tbl td{font-size:.72rem;padding:4px 6px;border:none;border-bottom:1px solid #ecebe7;background:#fff;vertical-align:middle;}' +
      '.ps-tbl tr:nth-child(even) td{background:#fafaf8;}' +
      '.ps-tbl td.n{font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.ps-no{display:inline-block;min-width:18px;height:18px;line-height:18px;border-radius:9px;background:' + c2 + ';color:#fff;' +
        'font-size:.64rem;font-weight:700;text-align:center;padding:0 4px;}' +
      '.ps-tbl tfoot td{font-weight:700;background:' + soft + ';color:' + c1 + ';border-bottom:none;}' +
      '.ps-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;}' +
      '.ps-portrait .ps-grid{grid-template-columns:repeat(3,1fr);}' +
      '.ps-card{border:1px solid ' + line + ';border-radius:12px;padding:6px 7px 7px;break-inside:avoid;page-break-inside:avoid;background:#fff;}' +
      '.ps-card svg{display:block;width:100%;height:auto;background:#fbfcfa;border-radius:8px;}' +
      '.ps-card .ps-cn{display:flex;align-items:center;gap:5px;font-weight:700;font-size:.8rem;color:' + c1 + ';margin:5px 0 2px;}' +
      '.ps-card .ps-cd{font-size:.68rem;color:#4b4642;line-height:1.45;}' +
      '.ps-card .ps-cd b{color:' + c1 + ';font-weight:600;}' +
      '.ps-note{font-size:.66rem;color:#8a8580;margin-top:6px;}' +
      '@media print{.ps-page{padding:0;}}';
  }

  // farmId: number. TH: resolved report theme. Returns '' when the farm has
  // no plots with geometry and no plots at all.
  function plotSheet(farmId, TH) {
    TH = TH || {};
    var api = storeApi();
    var farms = api.getFarms ? api.getFarms() : [];
    var farm = farms.find(function (f) { return f.id === farmId; }) || null;
    var all = api.getPlots ? api.getPlots() : [];
    var list = all.filter(function (p) { return p.farm_id === farmId; });
    if (!list.length) return '';
    list.sort(function (a, b) {
      return String(nameOf(a)).localeCompare(String(nameOf(b)), 'he', { numeric: true, sensitivity: 'base' });
    });

    var c1 = TH.c1 || '#1d3d2e', c2 = TH.c2 || '#2f6a4f';
    var portrait = TH.orientation === 'portrait';
    var anyDate = list.some(isDate);

    var totArea = 0, totTrees = 0;
    list.forEach(function (p) { totArea += Number(p.area) || 0; if (bdefOf(p).count) totTrees += Number(p.tree_count) || 0; });

    var withGeo = list.map(function (p, i) { return { p: p, no: i + 1, rings: sheetRings(p) }; });
    var drawn = withGeo.filter(function (o) { return o.rings.length; });

    var head = '<div class="ps-head"><div>' +
        '<h2>' + escH(farm ? nameOf(farm) : '') + ' — ' + tt('חלקות המטע', 'แปลงในสวน', 'قطع البستان') + '</h2>' +
        '<div class="ps-sub">' + tt('מצב לתאריך', 'ข้อมูล ณ วันที่', 'حتى تاريخ') + ' ' +
          new Date().toLocaleDateString('he-IL') + '</div>' +
      '</div><div class="ps-kpis">' +
        '<span class="ps-kpi">' + list.length + ' ' + tt('חלקות', 'แปลง', 'قطع') + '</span>' +
        '<span class="ps-kpi">' + fmtNum(totArea, 2) + ' ' + tt('דונם', 'ไร่', 'دونم') + '</span>' +
        (totTrees ? '<span class="ps-kpi">' + fmtNum(totTrees) + ' ' + tt('עצים', 'ต้น', 'شجرة') + '</span>' : '') +
      '</div></div>';

    // Readability test for the overview: how big does a typical plot come
    // out at map scale? Below ~70 px across, labels stop fitting — collage.
    var mode = 'overview';
    var proj = null, mapW = portrait ? 760 : 640, mapH = portrait ? 470 : 440, pad = 26;
    if (drawn.length) {
      var allRings = [];
      drawn.forEach(function (o) { o.rings.forEach(function (r) { allRings.push(r); }); });
      proj = projector(allRings);
      drawn.forEach(function (o) {
        o.pts = o.rings.map(function (r) { return r.map(proj); });
        o.box = boxOf(o.pts);
      });
      var fb = boxOf(drawn.reduce(function (acc, o) { return acc.concat(o.pts); }, []));
      var sc = Math.min((mapW - 2 * pad) / fb.w, (mapH - 2 * pad) / fb.h);
      var sizes = drawn.map(function (o) { return Math.max(o.box.w, o.box.h) * sc; }).sort(function (a, b) { return a - b; });
      var median = sizes[Math.floor(sizes.length / 2)];
      if (drawn.length > 1 && median < 70) mode = 'collage';
    } else {
      mode = 'table';
    }

    var body = '';
    if (mode === 'overview') {
      body = '<div class="ps-body"><div class="ps-map">' + overviewSvg(drawn, mapW, mapH, pad, c1, c2) + '</div>' +
        '<div class="ps-tbl">' + tableHtml(withGeo, anyDate, totArea, totTrees) + '</div></div>';
    } else if (mode === 'collage') {
      body = '<div class="ps-grid">' + withGeo.map(function (o) { return cardHtml(o, c1, c2); }).join('') + '</div>';
    } else {
      body = '<div class="ps-tbl">' + tableHtml(withGeo, anyDate, totArea, totTrees) + '</div>';
    }

    var missingGeo = withGeo.length - drawn.length;
    var note = missingGeo
      ? '<div class="ps-note">' + missingGeo + ' ' + tt('חלקות ללא גבולות מסומנים במפה — מופיעות ברשימה בלבד',
          'แปลงที่ไม่มีขอบเขตบนแผนที่ — แสดงในรายการเท่านั้น', 'قطع بلا حدود على الخريطة — تظهر في القائمة فقط') + '</div>'
      : '';

    return '<section class="ps-page' + (portrait ? ' ps-portrait' : '') + '">' + head + body + note + '</section>';
  }

  function dataBits(p) {
    var bits = [], bd = bdefOf(p);
    bits.push('<b>' + fmtNum(p.area, 2) + '</b> ' + tt('דונם', 'ไร่', 'دونم'));
    if (bd.count && p.tree_count) bits.push('<b>' + fmtNum(p.tree_count) + '</b> ' + escH(bd.count.replace(/^מספר /, '')));
    if (bd.ym && p.young_trees) bits.push(fmtNum(p.young_trees) + ' ' + tt('צעירים', 'ต้นอ่อน', 'صغيرة'));
    if (bd.ym && p.missing_trees) bits.push(fmtNum(p.missing_trees) + ' ' + tt('חסרים', 'ขาด', 'ناقصة'));
    if (bd.plant && p.planting_date) bits.push(escH(bd.plant) + ' ' + fmtDay(p.planting_date));
    if (isDate(p) && p.male_trees) bits.push(fmtNum(p.male_trees) + ' ' + tt('זכרים', 'ตัวผู้', 'ذكور'));
    return bits;
  }

  function cropOf(p) {
    return [p.crop_type, p.variety].filter(Boolean).map(escH).join(' · ');
  }

  function tableHtml(rows, anyDate, totArea, totTrees) {
    // Columns follow the branches present: plant counts only when some plot
    // counts plants, young/missing only for orchards and vineyards, a
    // sowing/planting date only for annual crops.
    var anyCount = rows.some(function (o) { return !!bdefOf(o.p).count; });
    var anyYm = rows.some(function (o) { return bdefOf(o.p).ym; });
    var anyPlant = rows.some(function (o) { return !!bdefOf(o.p).plant; });
    var h = '<table><thead><tr>' +
      '<th>#</th><th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th>' +
      '<th>' + tt('גידול / זן', 'พืช / พันธุ์', 'المحصول / الصنف') + '</th>' +
      '<th>' + tt('דונם', 'ไร่', 'دونم') + '</th>' +
      (anyCount ? '<th>' + tt('עצים / צמחים', 'ต้น', 'أشجار / نباتات') + '</th>' : '') +
      (anyYm ? '<th>' + tt('צעירים', 'ต้นอ่อน', 'صغيرة') + '</th><th>' + tt('חסרים', 'ขาด', 'ناقصة') + '</th>' : '') +
      (anyDate ? '<th>' + tt('זכרים', 'ตัวผู้', 'ذكور') + '</th>' : '') +
      (anyPlant ? '<th>' + tt('זריעה / שתילה', 'หว่าน/ปลูก', 'البذر / الزراعة') + '</th>' : '') +
      '</tr></thead><tbody>';
    rows.forEach(function (o) {
      var p = o.p, bd = bdefOf(p);
      h += '<tr><td><span class="ps-no">' + o.no + '</span></td>' +
        '<td><b>' + escH(nameOf(p)) + '</b></td>' +
        '<td>' + (cropOf(p) || '—') + '</td>' +
        '<td class="n">' + fmtNum(p.area, 2) + '</td>' +
        (anyCount ? '<td class="n">' + (bd.count && p.tree_count ? fmtNum(p.tree_count) : '—') + '</td>' : '') +
        (anyYm ? '<td class="n">' + (bd.ym && p.young_trees ? fmtNum(p.young_trees) : '—') + '</td>' +
                 '<td class="n">' + (bd.ym && p.missing_trees ? fmtNum(p.missing_trees) : '—') + '</td>' : '') +
        (anyDate ? '<td class="n">' + (isDate(p) && p.male_trees ? fmtNum(p.male_trees) : '—') + '</td>' : '') +
        (anyPlant ? '<td class="n">' + (bd.plant && p.planting_date ? fmtDay(p.planting_date) : '—') + '</td>' : '') +
        '</tr>';
    });
    h += '</tbody><tfoot><tr><td></td><td>' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td></td>' +
      '<td class="n">' + fmtNum(totArea, 2) + '</td>' +
      (anyCount ? '<td class="n">' + (totTrees ? fmtNum(totTrees) : '—') + '</td>' : '') +
      (anyYm ? '<td></td><td></td>' : '') + (anyDate ? '<td></td>' : '') + (anyPlant ? '<td></td>' : '') +
      '</tr></tfoot></table>';
    return h;
  }

  // Overview: all plots to scale, numbered; name + data on plots with room.
  function overviewSvg(drawn, W, H, pad, c1, c2) {
    var fb = boxOf(drawn.reduce(function (acc, o) { return acc.concat(o.pts); }, []));
    var s = Math.min((W - 2 * pad) / fb.w, (H - 2 * pad) / fb.h);
    var offX = (W - fb.w * s) / 2 - fb.x0 * s, offY = (H - fb.h * s) / 2 - fb.y0 * s;
    function tp(q) { return { x: q.x * s + offX, y: q.y * s + offY }; }

    var shapes = '', labels = '';
    drawn.forEach(function (o, i) {
      var px = o.pts.map(function (r) { return r.map(tp); });
      px.forEach(function (r) {
        shapes += '<path d="' + ringPath(r) + '" fill="' + (i % 2 ? c2 : c1) + '" fill-opacity="0.13" stroke="' + c2 +
          '" stroke-width="1.6" stroke-linejoin="round"/>';
      });
      // Label in the largest ring.
      var big = px.slice().sort(function (a, b) { var A = boxOf([a]), B = boxOf([b]); return B.w * B.h - A.w * A.h; })[0];
      var lp = labelPoint(big), bb = boxOf([big]);
      var p = o.p, nm = String(nameOf(p));
      var bd = bdefOf(p);
      var lines = [fmtNum(p.area, 2) + ' ' + tt('דונם', 'ไร่', 'دونم')];
      if (bd.count && p.tree_count) lines.push(fmtNum(p.tree_count) + ' ' + tt('עצים', 'ต้น', 'شجرة'));
      else if (!bd.count && p.crop_type) lines.push(String(p.crop_type));
      // Room actually available around the label point: the polygon's
      // horizontal and vertical span through it, not its bounding box.
      var spanW = 2 * Math.min(lp.x - spanEdge(big, lp, 'x', -1), spanEdge(big, lp, 'x', 1) - lp.x);
      var spanH = 2 * Math.min(lp.y - spanEdge(big, lp, 'y', -1), spanEdge(big, lp, 'y', 1) - lp.y);
      var longest = Math.max(nm.length, lines.reduce(function (m, l) { return Math.max(m, l.length); }, 0));
      var fs = Math.min(13, (spanW - 10) / (longest * 0.56), (spanH - 6) / (lines.length + 2.4));
      if (fs >= 8.5) {
        // Badge + name + data lines, centred on the label point. direction="rtl"
        // on each <text> keeps Hebrew/number runs in reading order; the <svg>
        // itself stays pinned ltr so text-anchor keeps its normal meaning.
        var total = (lines.length + 1) * fs * 1.15 + fs * 1.4;
        var y0 = lp.y - total / 2;
        labels += numBadge(lp.x, y0 + fs * 0.55, o.no, c2);
        var y = y0 + fs * 1.4 + fs;
        labels += '<text x="' + lp.x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" direction="rtl" ' +
          'font-size="' + fs.toFixed(1) + '" font-weight="700" fill="' + c1 + '" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">' + escH(nm) + '</text>';
        lines.forEach(function (ln) {
          y += fs * 1.15;
          labels += '<text x="' + lp.x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" direction="rtl" ' +
            'font-size="' + (fs * 0.88).toFixed(1) + '" fill="#3f3a36" paint-order="stroke" stroke="#fff" stroke-width="3" stroke-linejoin="round">' + escH(ln) + '</text>';
        });
      } else {
        labels += numBadge(lp.x, lp.y, o.no, c2);
      }
    });

    // Scale bar + north arrow, bottom-left / top-left.
    var mPerPx = 1 / s, len = niceLen(mPerPx, W * 0.22), barPx = len / mPerPx;
    var lenTxt = len >= 1000 ? (len / 1000) + ' km' : len + ' m';
    var deco = '<g transform="translate(14,' + (H - 16) + ')">' +
        '<rect x="0" y="-5" width="' + barPx.toFixed(1) + '" height="5" fill="' + c1 + '"/>' +
        '<rect x="0" y="-5" width="' + (barPx / 2).toFixed(1) + '" height="5" fill="#fff" stroke="' + c1 + '" stroke-width="1"/>' +
        '<text x="' + (barPx + 6).toFixed(1) + '" y="0" font-size="10" fill="' + c1 + '" text-anchor="start">' + lenTxt + '</text></g>' +
      '<g transform="translate(22,22)"><path d="M0 -12 L6 6 L0 2 L-6 6 Z" fill="' + c1 + '"/>' +
        '<text x="0" y="18" font-size="9" font-weight="700" fill="' + c1 + '" text-anchor="middle">N</text></g>';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="direction:ltr;" ' +
      'font-family="Rubik, Heebo, Arial, sans-serif" role="img">' +
      '<rect width="' + W + '" height="' + H + '" fill="#fbfcfa"/>' + shapes + labels + deco + '</svg>';
  }

  function numBadge(x, y, no, c2) {
    var r = String(no).length > 1 ? 10 : 8.5;
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r + '" fill="' + c2 + '" stroke="#fff" stroke-width="1.6"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + 3.6).toFixed(1) + '" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">' + no + '</text>';
  }

  // Collage card: the plot alone, fitted to its card, with its data below.
  function cardHtml(o, c1, c2) {
    var p = o.p, W = 200, H = 136, pad = 12, padB = 24, svg = '';
    if (o.pts && o.pts.length) {
      var b = boxOf(o.pts);
      var s = Math.min((W - 2 * pad) / b.w, (H - pad - padB) / b.h);
      var offX = (W - b.w * s) / 2 - b.x0 * s, offY = pad + (H - pad - padB - b.h * s) / 2 - b.y0 * s;
      var shapes = o.pts.map(function (r) {
        return '<path d="' + ringPath(r.map(function (q) { return { x: q.x * s + offX, y: q.y * s + offY }; })) +
          '" fill="' + c2 + '" fill-opacity="0.15" stroke="' + c2 + '" stroke-width="1.8" stroke-linejoin="round"/>';
      }).join('');
      var len = niceLen(1 / s, W * 0.3), barPx = len * s;
      var deco = '<g transform="translate(8,' + (H - 8) + ')"><rect x="0" y="-3" width="' + barPx.toFixed(1) + '" height="3" fill="' + c1 + '"/>' +
        '<text x="' + (barPx + 4).toFixed(1) + '" y="0" font-size="8" fill="' + c1 + '" text-anchor="start">' + (len >= 1000 ? (len / 1000) + ' km' : len + ' m') + '</text></g>';
      svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="direction:ltr;" font-family="Rubik, Heebo, Arial, sans-serif">' +
        shapes + deco + '</svg>';
    } else {
      svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" style="direction:ltr;">' +
        '<text x="' + W / 2 + '" y="' + H / 2 + '" text-anchor="middle" direction="rtl" font-size="11" fill="#8a8580">' +
        escH(tt('אין גבולות במפה', 'ไม่มีขอบเขต', 'لا حدود')) + '</text></svg>';
    }
    var crop = cropOf(p);
    return '<div class="ps-card">' + svg +
      '<div class="ps-cn"><span class="ps-no">' + o.no + '</span>' + escH(nameOf(p)) + '</div>' +
      '<div class="ps-cd">' + dataBits(p).join(' · ') + (crop ? '<br>' + crop : '') + '</div></div>';
  }


  return {
    // Synchronous read for generatePdfHtml — never triggers work.
    getCached: function (arg) {
      var target = asTarget(arg);
      var k = key(target);
      var hit = cache[k];
      if (!hit) return null;
      var sets = plotsFor(target);
      if (!sets.subject.length) return null;
      if (hit.sig !== sigOf(sets)) return null;
      if ((Date.now() - hit.at) >= CACHE_TTL) return null;
      return hit.url;
    },
    // The image a farm's report should carry: its main plot, in context.
    getCachedMain: function (farmId) {
      var p = farmId ? mainPlotOf(farmId) : null;
      return p ? this.getCached({ plotId: p.id }) : this.getCached({ farmId: farmId || null });
    },
    prepareMain: function (farmId) {
      var p = farmId ? mainPlotOf(farmId) : null;
      return this.prepare(p ? { plotId: p.id } : { farmId: farmId || null });
    },
    isMainSettled: function (farmId) {
      var p = farmId ? mainPlotOf(farmId) : null;
      return this.isSettled(p ? { plotId: p.id } : { farmId: farmId || null });
    },
    mainPlotOf: mainPlotOf,
    isReady: function (arg) { return !!this.getCached(arg); },
    // "Nothing more to wait for" — either the image is ready or it has
    // definitively failed. Export gates use this, not isReady, so a farm whose
    // map cannot be built never becomes an unexportable farm.
    isSettled: function (arg) {
      if (this.getCached(arg)) return true;
      var f = failed[key(asTarget(arg))];
      return !!f && (Date.now() - f) < CACHE_TTL;
    },
    // Kick off a render and resolve to true/false. Safe to call repeatedly.
    prepare: function (arg) {
      return render(asTarget(arg)).then(function () { return true; },
        function () { return false; });
    },
    // Warm every farm the user can see, quietly, off the critical path.
    // Reports carry the main plot of a מטע, so warm those — warming farm
    // overviews nobody prints would just burn tile requests.
    warm: function () {
      var farms = (window.SprayStore && window.SprayStore.getFarms)
        ? window.SprayStore.getFarms() : [];
      var self = this;
      var targets = [];
      farms.forEach(function (f) {
        var p = mainPlotOf(f.id);
        if (p) targets.push({ plotId: p.id });
      });
      var i = 0;
      var step = function () {
        if (i >= targets.length) return;
        var t = targets[i++];
        self.prepare(t).then(function () { setTimeout(step, 400); },
          function () { setTimeout(step, 400); });
      };
      step();
    },
    label: function () {
      return tt('\u05ea\u05e6\u05dc\u05d5\u05dd \u05dc\u05d5\u05d5\u05d9\u05df',
                '\u0e20\u0e32\u0e1e\u0e14\u0e32\u0e27\u0e40\u0e17\u0e35\u0e22\u0e21',
                '\u0635\u0648\u0631\u0629 \u0642\u0645\u0631 \u0635\u0646\u0627\u0639\u064a');
    },
    attribution: ATTRIBUTION,
    plotSheet: plotSheet,
    plotSheetCss: plotSheetCss,
    // Test seam.
    _project: project
  };
})();
window.ReportMap = ReportMap;

// Plot geometry arrives with the app data, not at DOMContentLoaded — warm
// once the store is populated, and again whenever plots change.
(function () {
  var warmed = false;
  function go() {
    if (!window.SprayStore || !window.ReportMap) return;
    var plots = window.SprayStore.getPlots ? window.SprayStore.getPlots() : [];
    if (!plots.length) return;
    warmed = true;
    window.ReportMap.warm();
  }
  // app.js emits this after it rebuilds plot layers from stored data.
  document.addEventListener('shorashim:plots-rendered', function () { warmed = false; go(); });
  var tries = 0;
  var poll = setInterval(function () {
    tries++;
    if (warmed || tries > 40) { clearInterval(poll); return; }
    go();
  }, 1500);
})();
