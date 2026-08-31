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
