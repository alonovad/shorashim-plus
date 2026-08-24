// ── SITES MODULE ──
// Derives "attendance sites" (geofenced work locations) from data the app
// already has — farms, plots, and TimeClock's custom workplaces list.
//
// We deliberately do NOT create a separate Firestore collection for sites.
// The single source of truth is the existing data:
//   • Each farm becomes a "farm-level" site whose geofence is the union of
//     its plots' polygons. Farms carry no geometry of their own, so this is
//     the only boundary a farm can have — and the farm name is what the
//     worker actually picks at punch-in, so this is the fence that matters.
//   • Each plot becomes a "plot-level" site whose geofence is the plot
//     polygon plus its geofenceRadiusM buffer (per-plot, default 100m).
//   • Each custom workplace (free-text strings the manager added) becomes
//     a "custom" site with no geofence (clock-in allowed from anywhere).
//
// Geofence shape:
//   geofence = { areas: [ { polygon: [[lat,lng],...], radiusMeters: n }, ... ] }
//   geofence = null   ⇒ this site cannot be verified (no geometry at all)
//
// null is load-bearing: timeclock.js reads it as "unverifiable" and records
// geoVerified: null. A site must never present an EMPTY geofence, because
// that would be indistinguishable from "checked and passed".

var Sites = (function() {
  'use strict';

  var DEFAULT_RADIUS_M = 100;

  // Extract a plot's polygon as [[lat,lng], ...], or null if it has none.
  //
  // Note that p.vertices is NOT the geometry — it is an integer vertex COUNT
  // (rendered as "6 נקודות" in the plot list). The real geometry lives in
  // p.latlngs, saved as {lat,lng} objects, with the live Leaflet layer as a
  // secondary source. Older records may hold [lat,lng] pairs instead, so both
  // shapes are accepted.
  function plotPolygon(p) {
    if (!p) return null;

    if (Array.isArray(p.latlngs) && p.latlngs.length >= 3) {
      var poly = [];
      for (var i = 0; i < p.latlngs.length; i++) {
        var c = p.latlngs[i];
        if (!c) continue;
        var lat = (c.lat !== undefined) ? c.lat : c[0];
        var lng = (c.lng !== undefined) ? c.lng : c[1];
        if (typeof lat === 'number' && typeof lng === 'number') poly.push([lat, lng]);
      }
      if (poly.length >= 3) return poly;
    }

    // Fall back to the live Leaflet layer (present once the map has drawn).
    if (p.layer && typeof p.layer.getLatLngs === 'function') {
      try {
        var ll = p.layer.getLatLngs();
        if (ll && ll[0] && ll[0].length >= 3) {
          return ll[0].map(function(pt) { return [pt.lat, pt.lng]; });
        }
      } catch (e) { /* layer not ready — treat as no geometry */ }
    }

    return null;
  }

  function plotRadius(p) {
    return (p && p.geofenceRadiusM != null) ? p.geofenceRadiusM : DEFAULT_RADIUS_M;
  }

  // Build a geofence from a list of plots. Returns null when not one of them
  // has usable geometry — an un-drawn farm is unverifiable, not wide open.
  function fenceFromPlots(plotList) {
    var areas = [];
    (plotList || []).forEach(function(p) {
      var poly = plotPolygon(p);
      if (poly) areas.push({ polygon: poly, radiusMeters: plotRadius(p) });
    });
    return areas.length ? { areas: areas } : null;
  }

  // Read-through: returns a fresh array each call (cheap — data already
  // lives in window.farms / window.plots / TimeClock.getCustomWorkplaces()).
  function getAll() {
    var sites = [];
    var allPlots = (typeof plots !== 'undefined' && Array.isArray(plots)) ? plots : [];

    // Farm-level sites — geofence is the union of the farm's plots. This is
    // the site a worker actually punches in against, since getWorkplaceOptions()
    // offers farm names, never plot names.
    if (typeof farms !== 'undefined' && Array.isArray(farms)) {
      farms.forEach(function(f) {
        if (!f || !f.name) return;
        var farmPlots = allPlots.filter(function(p) { return p && p.farm_id === f.id; });
        sites.push({
          id: 'farm:' + f.id,
          name: f.name,
          name_th: f.name_th || null,
          name_ar: f.name_ar || null,
          type: 'farm',
          geofence: fenceFromPlots(farmPlots),
          linkedFarmId: f.id,
          linkedPlotIds: farmPlots.map(function(p) { return p.id; }),
          color: f.color || null
        });
      });
    }

    // Plot-level sites — geofence = polygon + radius buffer
    allPlots.forEach(function(p) {
      if (!p || !p.name) return;
      sites.push({
        id: 'plot:' + p.id,
        name: p.name,
        name_th: p.name_th || null,
        name_ar: p.name_ar || null,
        type: 'plot',
        geofence: fenceFromPlots([p]),
        linkedFarmId: p.farm_id || null,
        linkedPlotIds: [p.id],
        color: p.color || null
      });
    });

    // Custom workplaces — text-only, no geofence
    var custom = (window.TimeClock && typeof window.TimeClock.getCustomWorkplaces === 'function')
      ? window.TimeClock.getCustomWorkplaces() : [];
    custom.forEach(function(name) {
      if (!name) return;
      sites.push({
        id: 'custom:' + name,
        name: name,
        name_th: null,
        name_ar: null,
        type: 'custom',
        geofence: null,
        linkedFarmId: null,
        linkedPlotIds: [],
        color: null
      });
    });

    return sites;
  }

  // Lookup by id or by free-text name. Returns null if not found.
  function findByName(name) {
    if (!name) return null;
    var all = getAll();
    // First exact match on canonical name
    var hit = all.find(function(s) { return s.name === name; });
    if (hit) return hit;
    // Then on translated names
    hit = all.find(function(s) { return s.name_th === name || s.name_ar === name; });
    return hit || null;
  }

  // ── Geometry helpers ──

  // Haversine distance in meters between two [lat,lng] points.
  function haversineM(a, b) {
    if (!a || !b) return Infinity;
    var R = 6371000;
    var lat1 = a[0] * Math.PI / 180;
    var lat2 = b[0] * Math.PI / 180;
    var dLat = (b[0] - a[0]) * Math.PI / 180;
    var dLng = (b[1] - a[1]) * Math.PI / 180;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1) * Math.cos(lat2) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(x)));
  }

  // Point-in-polygon test (ray casting). polygon: [[lat,lng], ...]
  function pointInPolygon(point, polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) return false;
    var x = point[1], y = point[0];
    var inside = false;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      var xi = polygon[i][1], yi = polygon[i][0];
      var xj = polygon[j][1], yj = polygon[j][0];
      var intersect = ((yi > y) !== (yj > y)) &&
                      (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Distance in meters from a point to the nearest edge of a polygon.
  // Vertex-only distance under-reports badly on long plot edges — standing
  // halfway along a 300m row is ~150m from either corner but 0m from the
  // edge — which would push legitimate punches outside the buffer.
  function distanceToPolygonM(point, polygon) {
    var best = Infinity;
    for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      best = Math.min(best, distanceToSegmentM(point, polygon[j], polygon[i]));
    }
    return best;
  }

  // Point-to-segment distance, projected onto a local flat plane. Over the
  // tens-of-metres distances a geofence buffer deals with, the error from
  // ignoring curvature is far below GPS accuracy.
  function distanceToSegmentM(p, a, b) {
    var latRef = p[0] * Math.PI / 180;
    var mPerDegLat = 111132;
    var mPerDegLng = 111320 * Math.cos(latRef);
    function xy(q) { return [(q[1] - p[1]) * mPerDegLng, (q[0] - p[0]) * mPerDegLat]; }
    var A = xy(a), B = xy(b);
    var dx = B[0] - A[0], dy = B[1] - A[1];
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.sqrt(A[0] * A[0] + A[1] * A[1]);
    var tt = -(A[0] * dx + A[1] * dy) / len2;
    tt = Math.max(0, Math.min(1, tt));
    var cx = A[0] + tt * dx, cy = A[1] + tt * dy;
    return Math.sqrt(cx * cx + cy * cy);
  }

  // Returns true if [lat,lng] falls inside any of the site's fenced areas,
  // or within that area's radius buffer of its edge.
  //
  // Callers MUST check site.geofence for null first (timeclock.js does) —
  // "no fence" means unverifiable and is not the same answer as "outside".
  // The defensive returns below are false, never true: a fence that exists
  // but cannot be evaluated must not silently pass a punch.
  function isInside(site, point) {
    if (!site) return false;
    if (!site.geofence) return true;   // no fence configured = no check to fail
    if (!point || point[0] == null) return false;

    var areas = site.geofence.areas;
    if (!Array.isArray(areas) || areas.length === 0) return false;

    for (var i = 0; i < areas.length; i++) {
      var poly = areas[i] && areas[i].polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      if (pointInPolygon(point, poly)) return true;
      var r = areas[i].radiusMeters || DEFAULT_RADIUS_M;
      if (distanceToPolygonM(point, poly) <= r) return true;
    }
    return false;
  }

  // Metres from the point to the nearest fenced area (0 when inside).
  // Used for the manager-facing "how far outside were they" readout.
  function distanceToSite(site, point) {
    if (!site || !site.geofence || !point || point[0] == null) return null;
    var areas = site.geofence.areas || [];
    var best = Infinity;
    for (var i = 0; i < areas.length; i++) {
      var poly = areas[i] && areas[i].polygon;
      if (!Array.isArray(poly) || poly.length < 3) continue;
      if (pointInPolygon(point, poly)) return 0;
      best = Math.min(best, distanceToPolygonM(point, poly));
    }
    return best === Infinity ? null : Math.round(best);
  }

  return {
    getAll: getAll,
    findByName: findByName,
    isInside: isInside,
    distanceToSite: distanceToSite,
    haversineM: haversineM,
    pointInPolygon: pointInPolygon,
    DEFAULT_RADIUS_M: DEFAULT_RADIUS_M
  };
})();
