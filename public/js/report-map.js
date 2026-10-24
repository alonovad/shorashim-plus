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
  // One printed page per מטע: a square satellite map of its plots with each
  // plot's name and data written on its polygon, and the full data table
  // beside it. Plots that lie far apart are clustered, and each cluster gets
  // its own cell inside the square (see satSquareSvg). Colours arrive literal
  // from the report theme (TH): a print window has no stylesheet, so no CSS
  // variables here.
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
    var c1 = TH.c1 || '#0c3b30', c2 = TH.c2 || '#16785c';
    var soft = TH.soft || '#e4eee8', line = TH.line || '#c6d8cd';
    return '' +
      '.ps-page{break-before:page;page-break-before:always;padding:4mm 6mm 0;break-inside:avoid;page-break-inside:avoid;}' +
      // Consecutive orchard sheets share a page when they fit — a two-plot
      // orchard does not earn a page of its own.
      '.ps-page+.ps-page{break-before:auto;page-break-before:auto;margin-top:9mm;}' +
      '.ps-head{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;' +
        'border-bottom:2px solid ' + line + ';padding-bottom:7px;margin-bottom:10px;}' +
      '.ps-head h2{margin:0;font-size:1.25rem;font-weight:700;color:' + c1 + ';}' +
      '.ps-head .ps-sub{font-size:.78rem;color:#6b6560;margin-top:2px;}' +
      '.ps-kpis{display:flex;gap:6px;flex-wrap:wrap;}' +
      '.ps-kpi{background:' + soft + ';color:' + c1 + ';border-radius:99px;padding:4px 11px;font-size:.76rem;font-weight:600;white-space:nowrap;}' +
      '.ps-body{display:flex;gap:12px;align-items:flex-start;}' +
      '.ps-portrait .ps-body{flex-direction:column;}' +
      // The frame sizes itself (width set on the <svg> in mm).
      '.ps-map{flex:0 0 auto;max-width:58%;border-radius:14px;overflow:hidden;background:#cfd8c8;' +
        'break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;}' +
      '.ps-map svg{display:block;max-width:100%;height:auto;}' +
      '.ps-portrait .ps-map{flex:none;max-width:100%;margin:0 auto;}' +
      '.ps-tbl{flex:1 1 0;min-width:0;}' +
      '.ps-portrait .ps-tbl{width:100%;}' +
      '.ps-tbl table{width:100%;border-collapse:collapse;margin:0;box-shadow:none;border-radius:0;}' +
      '.ps-tbl th{background:' + soft + ';color:' + c1 + ';font-size:.68rem;font-weight:700;padding:5px 6px;text-align:right;border:none;border-bottom:1.5px solid ' + line + ';}' +
      '.ps-tbl td{font-size:.72rem;padding:4px 6px;border:none;border-bottom:1px solid #ecebe7;background:#fff;vertical-align:middle;}' +
      '.ps-tbl tr:nth-child(even) td{background:#fafaf8;}' +
      '.ps-tbl td.n{font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.ps-tbl td.ps-x{font-size:.68rem;line-height:1.45;min-width:46%;}.ps-x .px-op{font-weight:700;color:' + c1 + ';}.ps-x .px-t{color:#5a655c;}' +
      '.ps-no{display:inline-block;min-width:18px;height:18px;line-height:18px;border-radius:9px;background:' + c2 + ';color:#fff;' +
        'font-size:.64rem;font-weight:700;text-align:center;padding:0 4px;}' +
      '.ps-tbl tr.ps-env td{color:#7a756f;background:#fff;border-top:1px dashed ' + line + ';}' +
      '.ps-envtag{font-size:.6rem;font-weight:500;color:#8a8580;white-space:nowrap;}' +
      '.ps-tbl tfoot td{font-weight:700;background:' + soft + ';color:' + c1 + ';border-bottom:none;}' +
      '.ps-note{font-size:.66rem;color:#8a8580;margin-top:6px;}' +
      '@media print{.ps-page{padding:0;}}';
  }

  // farmId: number. TH: resolved report theme. Returns '' when the farm has
  // no plots with geometry and no plots at all.
  // opts.plotIds: only these plots (the ones a plan or log covers); null
  // or absent means every plot of the farm.
  function plotSheet(farmId, TH, opts) {
    TH = TH || {};
    var only = (opts && opts.plotIds && opts.plotIds.length) ? opts.plotIds.map(Number) : null;
    var api = storeApi();
    var farms = api.getFarms ? api.getFarms() : [];
    var farm = farms.find(function (f) { return f.id === farmId; }) || null;
    var all = api.getPlots ? api.getPlots() : [];
    var farmPlots = all.filter(function (p) { return p.farm_id === farmId; });
    if (!farmPlots.length) return '';

    // Geometry for the whole farm first: envelope detection has to see every
    // plot, not only the selected ones.
    var objs = farmPlots.map(function (p) { return { p: p, rings: sheetRings(p) }; });
    var geo = objs.filter(function (o) { return o.rings.length; });
    if (geo.length) {
      var allRings = [];
      geo.forEach(function (o) { o.rings.forEach(function (r) { allRings.push(r); }); });
      var proj = projector(allRings);
      geo.forEach(function (o) {
        o.mpts = o.rings.map(function (r) { return r.map(proj); });
        o.box = boxOf(o.mpts);
        o.anchor = labelPoint(o.mpts.slice().sort(function (a, b) {
          var A = boxOf([a]), B = boxOf([b]); return B.w * B.h - A.w * A.h; })[0]);
      });
      // An envelope plot ("כל החלקות", a whole-block outline) encloses other
      // plots. Filled and labelled it would bury them, so it is drawn as a
      // dashed outline underneath, kept out of the totals (its area is the
      // sum of the plots inside it), and listed last in the table.
      geo.forEach(function (o) {
        o.inner = geo.filter(function (q) {
          return q !== o && o.mpts.some(function (r) { return inside(q.anchor, r); });
        });
        o.container = o.inner.length >= 2;
      });
    }

    // Selection: the plots the plan / log covers. Choosing an envelope plot
    // means "all of these", so it brings every plot it encloses with it.
    var pick = {};
    objs.forEach(function (o) {
      if (only && only.indexOf(Number(o.p.id)) === -1) return;
      pick[o.p.id] = true;
      if (o.container) o.inner.forEach(function (q) { pick[q.p.id] = true; });
    });
    var chosen = objs.filter(function (o) { return pick[o.p.id]; });
    if (!chosen.length) return '';
    chosen.sort(function (a, b) {
      if (!!a.container !== !!b.container) return a.container ? 1 : -1;
      return String(nameOf(a.p)).localeCompare(String(nameOf(b.p)), 'he', { numeric: true, sensitivity: 'base' });
    });
    chosen.forEach(function (o, i) { o.no = i + 1; });

    var c1 = TH.c1 || '#0c3b30', c2 = TH.c2 || '#16785c';
    var portrait = TH.orientation === 'portrait';
    var anyDate = chosen.some(function (o) { return isDate(o.p); });

    var totArea = 0, totTrees = 0, nPlots = 0;
    chosen.forEach(function (o) {
      if (o.container) return;
      nPlots++;
      totArea += Number(o.p.area) || 0;
      if (bdefOf(o.p).count) totTrees += Number(o.p.tree_count) || 0;
    });

    var drawn = chosen.filter(function (o) { return o.rings.length; });
    // The farm's other plots (not in this plan / log), drawn faintly on the
    // map so the whole orchard is in view; listed by name under the table.
    var ghosts = only ? (geo || []).filter(function (o) { return !pick[o.p.id] && !o.container; }) : [];
    var others = only ? objs.filter(function (o) { return !pick[o.p.id] && !o.container; }) : [];

    var head = '<div class="ps-head"><div>' +
        '<h2>' + escH(farm ? nameOf(farm) : '') + ' — ' + tt('חלקות המשק', 'แปลงในฟาร์ม', 'قطع المزرعة') + '</h2>' +
        '<div class="ps-sub">' + tt('מצב לתאריך', 'ข้อมูล ณ วันที่', 'حتى تاريخ') + ' ' +
          new Date().toLocaleDateString('he-IL') + '</div>' +
      '</div><div class="ps-kpis">' +
        '<span class="ps-kpi">' + nPlots + ' ' + tt('חלקות', 'แปลง', 'قطع') + '</span>' +
        '<span class="ps-kpi">' + fmtNum(totArea, 2) + ' ' + tt('דונם', 'ไร่', 'دونم') + '</span>' +
        (totTrees ? '<span class="ps-kpi">' + fmtNum(totTrees) + ' ' + tt('עצים', 'ต้น', 'شجرة') + '</span>' : '') +
      '</div></div>';

    // opts.extra: { head, cells: { plotId: html } } — a column the caller
    // fills per plot (the treatment plan: trees, materials, sprayer fills).
    // With it the table needs the full width, so it goes under the map.
    var extra = opts && opts.extra && opts.extra.cells ? opts.extra : null;
    var body = drawn.length
      ? '<div class="ps-body"' + (extra ? ' style="flex-direction:column;"' : '') + '><div class="ps-map"' + (extra ? ' style="max-width:100%;margin:0 auto;"' : '') + '>' + satSquareSvg(drawn, c1, c2, ghosts) + '</div>' +
          '<div class="ps-tbl"' + (extra ? ' style="width:100%;"' : '') + '>' + tableHtml(chosen, anyDate, totArea, totTrees, extra) + '</div></div>'
      : '<div class="ps-tbl">' + tableHtml(chosen, anyDate, totArea, totTrees, extra) + '</div>';

    var missingGeo = chosen.length - drawn.length;
    var note = missingGeo
      ? '<div class="ps-note">' + missingGeo + ' ' + tt('חלקות ללא גבולות מסומנים במפה — מופיעות ברשימה בלבד',
          'แปลงที่ไม่มีขอบเขตบนแผนที่ — แสดงในรายการเท่านั้น', 'قطع بلا حدود على الخريطة — تظهر في القائمة فقط') + '</div>'
      : '';

    if (others.length) {
      note += '<div class="ps-note">' + tt('בדף הזה', 'ในหน้านี้', 'في هذه الصفحة') + ' ' + nPlots + ' ' + tt('מתוך', 'จาก', 'من') + ' ' + (nPlots + others.length) + ' ' +
        tt('חלקות המשק. שאר החלקות (בקו מקווקו במפה, לא בתוכנית)', 'แปลงของฟาร์ม แปลงอื่น (เส้นประ ไม่อยู่ในแผน)', 'قطع المزرعة. الباقي (خط متقطع، ليست في الخطة)') + ': ' +
        others.map(function (o) { return escH(nameOf(o.p)); }).join(' · ') + '</div>';
    }
    return '<section class="ps-page' + (portrait ? ' ps-portrait' : '') + '">' + head + body + note + '</section>';
  }

  function cropOf(p) {
    return [p.crop_type, p.variety].filter(Boolean).map(escH).join(' · ');
  }

  function tableHtml(rows, anyDate, totArea, totTrees, extra) {
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
      (extra ? '<th>' + escH(extra.head || '') + '</th>' : '') +
      '</tr></thead><tbody>';
    rows.forEach(function (o) {
      var p = o.p, bd = bdefOf(p);
      h += '<tr' + (o.container ? ' class="ps-env"' : '') + '><td><span class="ps-no">' + o.no + '</span></td>' +
        '<td><b>' + escH(nameOf(p)) + '</b>' + (o.container ? ' <span class="ps-envtag">' +
          tt('מעטפת · לא נספר בסה"כ', 'ขอบเขตรวม · ไม่นับรวม', 'إطار · لا يُحتسب') + '</span>' : '') + '</td>' +
        '<td>' + (cropOf(p) || '—') + '</td>' +
        '<td class="n">' + fmtNum(p.area, 2) + '</td>' +
        (anyCount ? '<td class="n">' + (bd.count && p.tree_count ? fmtNum(p.tree_count) : '—') + '</td>' : '') +
        (anyYm ? '<td class="n">' + (bd.ym && p.young_trees ? fmtNum(p.young_trees) : '—') + '</td>' +
                 '<td class="n">' + (bd.ym && p.missing_trees ? fmtNum(p.missing_trees) : '—') + '</td>' : '') +
        (anyDate ? '<td class="n">' + (isDate(p) && p.male_trees ? fmtNum(p.male_trees) : '—') + '</td>' : '') +
        (anyPlant ? '<td class="n">' + (bd.plant && p.planting_date ? fmtDay(p.planting_date) : '—') + '</td>' : '') +
        (extra ? '<td class="ps-x">' + (extra.cells[p.id] || '<span style="color:#9a958f;">' + tt('לא בתוכנית', 'ไม่อยู่ในแผน', 'ليست في الخطة') + '</span>') + '</td>' : '') +
        '</tr>';
    });
    h += '</tbody><tfoot><tr><td></td><td>' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td></td>' +
      '<td class="n">' + fmtNum(totArea, 2) + '</td>' +
      (anyCount ? '<td class="n">' + (totTrees ? fmtNum(totTrees) : '—') + '</td>' : '') +
      (anyYm ? '<td></td><td></td>' : '') + (anyDate ? '<td></td>' : '') + (anyPlant ? '<td></td>' : '') + (extra ? '<td></td>' : '') +
      '</tr></tfoot></table>';
    return h;
  }

  // ── Satellite square (Oct 2026) ──
  // One compact frame per orchard on Esri imagery, cut to the orchard's own
  // shape (at most ~12.5 cm) so the page carries data, not empty ground.
  // Plots that sit far apart are grouped into clusters and each cluster
  // gets its own cell inside a square, so a scattered orchard still reads
  // as plots, not dots. Tiles
  // are plain <image> elements inside the SVG: synchronous to build, no
  // canvas, no CORS — the print window loads them itself, and if imagery
  // is unreachable the polygons and data still print over a plain ground.
  // SVG units are tied to print: 8 units = 1 mm, so label sizes below are
  // real legibility limits (16 units = 2 mm).
  var U_MM = 8, MAX_W_MM = 125, MAX_H_MM = 125, MIN_H_MM = 62;
  var SQ_GAP = 10, SAT_Z = 18, CLUSTER_GAP_M = 450, FILL = 0.9;

  function clusterize(drawn) {
    var parent = drawn.map(function (_, i) { return i; });
    function find(i) { return parent[i] === i ? i : (parent[i] = find(parent[i])); }
    for (var i = 0; i < drawn.length; i++) {
      for (var j = i + 1; j < drawn.length; j++) {
        var A = drawn[i].box, B = drawn[j].box;   // metres (projector)
        var gx = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
        var gy = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1));
        if (Math.sqrt(gx * gx + gy * gy) < CLUSTER_GAP_M) parent[find(i)] = find(j);
      }
    }
    var groups = {};
    drawn.forEach(function (o, i) { var r = find(i); (groups[r] = groups[r] || []).push(o); });
    return Object.keys(groups).map(function (k) { return groups[k]; })
      .sort(function (a, b) { return a[0].no - b[0].no; });
  }

  // Mercator pixels at SAT_Z for every ring of a cluster.
  function mercOf(group) {
    group.forEach(function (o) {
      o.merc = o.rings.map(function (r) { return r.map(function (q) { return project(q.lat, q.lng, SAT_Z); }); });
    });
    return boxOf(group.reduce(function (acc, o) { return acc.concat(o.merc); }, []));
  }

  // Grid that gives the smallest cluster the most room.
  function layoutCells(groups, VW, VH) {
    var n = groups.length, best = null;
    var boxes = groups.map(mercOf);
    if (n === 1) return [{ group: groups[0], box: boxes[0], x: 0, y: 0, w: VW, h: VH }];
    for (var cols = 1; cols <= n; cols++) {
      var rows = Math.ceil(n / cols);
      var cw = (VW - SQ_GAP * (cols - 1)) / cols, ch = (VH - SQ_GAP * (rows - 1)) / rows;
      var worst = Infinity;
      boxes.forEach(function (b) {
        var bw = Math.max(b.w, 60), bh = Math.max(b.h, 60);
        worst = Math.min(worst, Math.min(cw / bw, ch / bh) * Math.sqrt(bw * bh));
      });
      if (!best || worst > best.score) best = { score: worst, cols: cols, rows: rows, cw: cw, ch: ch };
    }
    return groups.map(function (g, i) {
      var r = Math.floor(i / best.cols), c = i % best.cols;
      // The last row is centred when it is short.
      var inRow = (r === best.rows - 1) ? (n - r * best.cols) : best.cols;
      var shift = (best.cols - inRow) * (best.cw + SQ_GAP) / 2;
      return { group: g, box: boxes[i], x: shift + c * (best.cw + SQ_GAP), y: r * (best.ch + SQ_GAP), w: best.cw, h: best.ch };
    });
  }

  function satSquareSvg(drawn, c1, c2, ghosts) {
    ghosts = ghosts || [];
    ghosts.forEach(function (o) { o.merc = o.rings.map(function (r) { return r.map(function (q) { return project(q.lat, q.lng, SAT_Z); }); }); });
    var groups = clusterize(drawn);
    // Frame size: a lone cluster gets a frame of its own proportions; a
    // collage of clusters shares one square.
    // The frame grows with the number of plots it has to explain: one or
    // two plots need a thumbnail-sized map, not a poster.
    var nReal = drawn.filter(function (o) { return !o.container; }).length;
    var cap = nReal <= 2 ? 80 : (nReal <= 5 ? 100 : MAX_W_MM);
    var wmm = cap, hmm = cap;
    if (groups.length === 1) {
      var gb = mercOf(groups[0]);
      var a = Math.max(gb.w, 90) / Math.max(gb.h, 90);
      wmm = Math.min(cap, Math.min(MAX_H_MM, cap) * a);
      hmm = Math.max(MIN_H_MM, Math.min(MAX_H_MM, cap, wmm / a));
    }
    var VW = Math.round(wmm * U_MM), VH = Math.round(hmm * U_MM);
    var cells = layoutCells(groups, VW, VH);
    var defs = '', body = '', uid = 'ps' + Math.random().toString(36).slice(2, 8);
    var attr = '';

    cells.forEach(function (cell, ci) {
      var b = cell.box;
      // Keep surrounding ground in view: 14% margin, and never zoom past
      // ~60 m across so a single small plot still shows its surroundings.
      var bw = Math.max(b.w, 90), bh = Math.max(b.h, 90);
      var s = Math.min(cell.w * FILL / bw, cell.h * FILL / bh);
      var cxM = b.x0 + b.w / 2, cyM = b.y0 + b.h / 2;
      var ox = cxM - cell.w / 2 / s, oy = cyM - cell.h / 2 / s;      // merc px at cell's top-left
      function tp(q) { return { x: cell.x + (q.x - ox) * s, y: cell.y + (q.y - oy) * s }; }

      // Tile zoom: ~1.6 image px per SVG unit (≈ 330 dpi in print).
      var zt = Math.round(SAT_Z + Math.log(1.6 * s) / Math.LN2);
      zt = Math.max(MIN_Z, Math.min(SAT_Z, zt));
      var tileM = TILE * Math.pow(2, SAT_Z - zt);                    // one tile in SAT_Z px
      var tx0 = Math.floor(ox / tileM), ty0 = Math.floor(oy / tileM);
      var tx1 = Math.floor((ox + cell.w / s) / tileM), ty1 = Math.floor((oy + cell.h / s) / tileM);
      while ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 48 && zt > MIN_Z) {
        zt--; tileM *= 2;
        tx0 = Math.floor(ox / tileM); ty0 = Math.floor(oy / tileM);
        tx1 = Math.floor((ox + cell.w / s) / tileM); ty1 = Math.floor((oy + cell.h / s) / tileM);
      }
      var span = Math.pow(2, zt), tiles = '';
      var sz = tileM * s;
      for (var tx = tx0; tx <= tx1; tx++) {
        for (var ty = ty0; ty <= ty1; ty++) {
          if (ty < 0 || ty >= span) continue;
          var url = TILE_URL.replace('{z}', zt).replace('{y}', ty).replace('{x}', ((tx % span) + span) % span);
          // +0.6 overlap hides hairline seams between tiles in print.
          tiles += '<image href="' + url + '" xlink:href="' + url + '" x="' + (cell.x + (tx * tileM - ox) * s).toFixed(2) +
            '" y="' + (cell.y + (ty * tileM - oy) * s).toFixed(2) + '" width="' + (sz + 0.6).toFixed(2) +
            '" height="' + (sz + 0.6).toFixed(2) + '" preserveAspectRatio="none"/>';
        }
      }

      var clip = uid + 'c' + ci;
      defs += '<clipPath id="' + clip + '"><rect x="' + cell.x.toFixed(1) + '" y="' + cell.y.toFixed(1) + '" width="' +
        cell.w.toFixed(1) + '" height="' + cell.h.toFixed(1) + '" rx="14"/></clipPath>';

      var shapes = '', labels = '', placed = [];
      ghosts.forEach(function (o) {
        var gp = o.merc.map(function (r) { return r.map(tp); });
        gp.forEach(function (r) {
          shapes += '<path d="' + ringPath(r) + '" fill="#ffffff" fill-opacity="0.06" stroke="#ffffff" stroke-width="2" stroke-dasharray="7 6" stroke-linejoin="round" stroke-opacity="0.75"/>';
        });
        var big = gp.slice().sort(function (a, b) { var A = boxOf([a]), B = boxOf([b]); return B.w * B.h - A.w * A.h; })[0];
        var bb = boxOf([big]);
        if (bb.w > 70 && bb.h > 22) {
          var lp = labelPoint(big);
          labels += '<text x="' + lp.x.toFixed(1) + '" y="' + (lp.y + 5).toFixed(1) + '" font-size="13" font-weight="600" fill="#fff" fill-opacity="0.85" text-anchor="middle" ' +
            'paint-order="stroke" stroke="#000" stroke-opacity="0.45" stroke-width="3">' + escH(nameOf(o.p)) + '</text>';
        }
      });
      cell.group.filter(function (o) { return o.container; }).forEach(function (o) {
        o.merc.map(function (r) { return r.map(tp); }).forEach(function (r) {
          shapes += '<path d="' + ringPath(r) + '" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="10 7" stroke-linejoin="round" stroke-opacity="0.9"/>';
        });
      });
      cell.group.filter(function (o) { return !o.container; }).forEach(function (o) {
        var px = o.merc.map(function (r) { return r.map(tp); });
        px.forEach(function (r) {
          shapes += '<path d="' + ringPath(r) + '" fill="' + c2 + '" fill-opacity="0.22" stroke="#ffffff" stroke-width="4.5" stroke-linejoin="round" stroke-opacity="0.9"/>' +
            '<path d="' + ringPath(r) + '" fill="none" stroke="#ffd84a" stroke-width="2.2" stroke-linejoin="round"/>';
        });
        labels += polyLabel(o, px, c1, c2, placed);
      });

      // Scale bar per cell (each cell has its own scale).
      var mPerUnit = 156543.03392 * Math.cos(((drawn[0].rings[0][0] || {}).lat || 31.8) * Math.PI / 180) / Math.pow(2, SAT_Z) / s;
      var len = niceLen(mPerUnit, Math.min(cell.w * 0.28, 220)), barPx = len / mPerUnit;
      var lenTxt = len >= 1000 ? (len / 1000) + ' km' : len + ' m';
      var bx = cell.x + 14, by = cell.y + cell.h - 14;
      var bar = '<g>' +
        '<rect x="' + (bx - 7) + '" y="' + (by - 24) + '" width="' + (barPx + 64).toFixed(1) + '" height="32" rx="8" fill="#000" fill-opacity="0.45"/>' +
        '<rect x="' + bx + '" y="' + (by - 8) + '" width="' + barPx.toFixed(1) + '" height="6" fill="#fff"/>' +
        '<rect x="' + bx + '" y="' + (by - 8) + '" width="' + (barPx / 2).toFixed(1) + '" height="6" fill="#222" stroke="#fff" stroke-width="1"/>' +
        '<text x="' + (bx + barPx + 8).toFixed(1) + '" y="' + (by - 1) + '" font-size="15" font-weight="700" fill="#fff" text-anchor="start">' + lenTxt + '</text></g>';

      body += '<g clip-path="url(#' + clip + ')">' +
        '<rect x="' + cell.x.toFixed(1) + '" y="' + cell.y.toFixed(1) + '" width="' + cell.w.toFixed(1) + '" height="' + cell.h.toFixed(1) + '" fill="#cfd8c8"/>' +
        tiles + shapes + labels + bar + '</g>' +
        '<rect x="' + cell.x.toFixed(1) + '" y="' + cell.y.toFixed(1) + '" width="' + cell.w.toFixed(1) + '" height="' + cell.h.toFixed(1) +
          '" rx="14" fill="none" stroke="#ffffff" stroke-width="3"/>';
    });

    var north = '<g transform="translate(' + (VW - 34) + ',36)"><circle r="22" fill="#000" fill-opacity="0.45"/>' +
      '<path d="M0 -14 L8 8 L0 3 L-8 8 Z" fill="#fff"/><text x="0" y="19" font-size="11" font-weight="700" fill="#fff" text-anchor="middle">N</text></g>';
    attr = '<text x="' + (VW - 10) + '" y="' + (VH - 8) + '" font-size="12" fill="#fff" fill-opacity="0.85" text-anchor="end" paint-order="stroke" stroke="#000" stroke-opacity="0.5" stroke-width="3">' +
      escH(ATTRIBUTION) + '</text>';

    return '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ' + VW + ' ' + VH + '" width="' + wmm.toFixed(1) + 'mm" ' +
      'style="direction:ltr;" font-family="Rubik, Heebo, Arial, sans-serif" role="img"><defs>' + defs + '</defs>' +
      body + north + attr + '</svg>';
  }

  // Name and data written on the polygon itself, sized to the room the
  // polygon really has. Falls back to fewer lines, then to the numbered
  // badge alone (the table beside the map carries the rest).
  function polyLabel(o, px, c1, c2, placed) {
    var big = px.slice().sort(function (a, b) { var A = boxOf([a]), B = boxOf([b]); return B.w * B.h - A.w * A.h; })[0];
    var lp = labelPoint(big);
    var spanW = 2 * Math.min(lp.x - spanEdge(big, lp, 'x', -1), spanEdge(big, lp, 'x', 1) - lp.x);
    var spanH = 2 * Math.min(lp.y - spanEdge(big, lp, 'y', -1), spanEdge(big, lp, 'y', 1) - lp.y);
    var p = o.p, bd = bdefOf(p), nm = String(nameOf(p));
    var l2 = fmtNum(p.area, 2) + ' ' + tt('דונם', 'ไร่', 'دونم');
    var l3 = '';
    if (bd.count && p.tree_count) l3 = fmtNum(p.tree_count) + ' ' + tt('עצים', 'ต้น', 'شجرة');
    else if (p.crop_type) l3 = String(p.crop_type);
    var l4 = (p.crop_type && bd.count && p.tree_count) ? [p.crop_type, p.variety].filter(Boolean).join(' · ') : (p.variety || '');

    // The plot names itself: name + as many data lines as the polygon has
    // room for, at a size that stays legible in print.
    var l2s = fmtNum(p.area, 1) + ' ' + tt('ד׳', 'ไร่', 'د');
    var options = [[l2, l3, l4], [l2, l3], [l2], [l2s]];
    for (var k = 0; k < options.length; k++) {
      var lines = options[k].filter(Boolean);
      var longest = Math.max(nm.length * 1.12, lines.reduce(function (m, l) { return Math.max(m, String(l).length); }, 0));
      var rowsN = 1.15 + lines.length;
      var fs = Math.min(22, (spanW - 8) / (longest * 0.56), (spanH - 6) / (rowsN * 1.2));
      if (fs < 15) continue;
      var y = lp.y - (rowsN * fs * 1.2) / 2 + fs * 1.05;
      var out = labelText(lp.x, y, nm, fs * 1.12, true);
      lines.forEach(function (ln) { y += fs * 1.18; out += labelText(lp.x, y, ln, fs * 0.9, false); });
      return out;
    }
    // No room for data: a name pill, or for a long name the table number.
    // Narrow strips sit side by side, so the marker slides along its own
    // strip until it clears the markers already placed.
    var short = nm.length <= 10;
    var mw = short ? Math.max(28, nm.length * 15 * 0.6 + 14) : 26, mh = short ? 24 : 26;
    var pt = freeSpot(big, lp, mw, mh, placed);
    placed.push({ x0: pt.x - mw / 2 - 2, x1: pt.x + mw / 2 + 2, y0: pt.y - mh / 2 - 2, y1: pt.y + mh / 2 + 2 });
    return short ? namePill(pt.x, pt.y, nm, c2) : numBadge(pt.x, pt.y, o.no, c2, 13);
  }

  // Candidate points along the polygon's long axis, nearest the label
  // point first; the first whose marker box overlaps nothing wins.
  function freeSpot(pts, lp, w, h, placed) {
    var b = boxOf([pts]), cands = [lp];
    var horiz = b.w >= b.h;
    [0.18, -0.18, 0.32, -0.32, 0.42, -0.42].forEach(function (f) {
      var q = horiz ? { x: lp.x + b.w * f, y: lp.y } : { x: lp.x, y: lp.y + b.h * f };
      // Follow a slanted strip: slide across to the polygon's middle there.
      var lo = spanEdge(pts, q, horiz ? 'y' : 'x', -1), hi = spanEdge(pts, q, horiz ? 'y' : 'x', 1);
      if (horiz) q.y = (lo + hi) / 2; else q.x = (lo + hi) / 2;
      if (inside(q, pts)) cands.push(q);
    });
    function clear(q) {
      return !placed.some(function (r) {
        return q.x - w / 2 < r.x1 && q.x + w / 2 > r.x0 && q.y - h / 2 < r.y1 && q.y + h / 2 > r.y0;
      });
    }
    for (var i = 0; i < cands.length; i++) if (clear(cands[i])) return cands[i];
    return lp;
  }

  function namePill(x, y, nm, c2) {
    var fs = 15, w = Math.max(28, nm.length * fs * 0.6 + 14), h = fs + 9;
    return '<rect x="' + (x - w / 2).toFixed(1) + '" y="' + (y - h / 2).toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h +
      '" rx="' + (h / 2) + '" fill="' + c2 + '" stroke="#fff" stroke-width="2"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + fs * 0.36).toFixed(1) + '" text-anchor="middle" direction="rtl" font-size="' + fs +
      '" font-weight="700" fill="#fff">' + escH(nm) + '</text>';
  }

  // White on a dark halo — readable over bright soil and dark canopy alike.
  // direction="rtl" on the <text> keeps Hebrew + numbers in reading order;
  // the <svg> stays pinned ltr so text-anchor keeps its meaning.
  function labelText(x, y, txt, fs, bold) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="middle" direction="rtl" font-size="' + fs.toFixed(1) +
      '" font-weight="' + (bold ? 700 : 600) + '" fill="#ffffff" paint-order="stroke" stroke="#0d1a12" stroke-opacity="0.82" stroke-width="' +
      (fs * 0.26).toFixed(1) + '" stroke-linejoin="round">' + escH(txt) + '</text>';
  }

  function numBadge(x, y, no, c2, r) {
    r = Math.max(r || 9, String(no).length > 1 ? 11 : 9.5);
    return '<circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + c2 + '" stroke="#fff" stroke-width="2"/>' +
      '<text x="' + x.toFixed(1) + '" y="' + (y + r * 0.38).toFixed(1) + '" text-anchor="middle" font-size="' + (r * 1.1).toFixed(1) +
      '" font-weight="700" fill="#fff">' + no + '</text>';
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
