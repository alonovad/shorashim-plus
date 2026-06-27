// ── SITES MODULE ──
// Derives "attendance sites" (geofenced work locations) from data the app
// already has — farms, plots, and TimeClock's custom workplaces list.
//
// We deliberately do NOT create a separate Firestore collection for sites
// in Phase 1. The single source of truth is the existing data:
//   • Each farm becomes a "farm-level" site with no geofence (umbrella)
//   • Each plot becomes a "plot-level" site whose geofence is the plot
//     polygon plus its geofenceRadiusM buffer (per-plot, default 100m).
//   • Each custom workplace (free-text strings the manager added) becomes
//     a "custom" site with no geofence (clock-in allowed from anywhere).
//
// Phase 2 will start writing geofence verification results into the
// timeclock records; this module exposes the helpers it needs.

var Sites = (function() {
  'use strict';

  var DEFAULT_RADIUS_M = 100;

  // Read-through: returns a fresh array each call (cheap — data already
  // lives in window.farms / window.plots / TimeClock.getCustomWorkplaces()).
  function getAll() {
    var sites = [];

    // Farm-level sites
    if (typeof farms !== 'undefined' && Array.isArray(farms)) {
      farms.forEach(function(f) {
        if (!f || !f.name) return;
        sites.push({
          id: 'farm:' + f.id,
          name: f.name,
          name_th: f.name_th || null,
          name_ar: f.name_ar || null,
          type: 'farm',
          geofence: null,             // farms themselves have no geofence
          linkedFarmId: f.id,
          linkedPlotIds: [],
          color: f.color || null
        });
      });
    }

    // Plot-level sites — geofence = polygon + radius buffer
    if (typeof plots !== 'undefined' && Array.isArray(plots)) {
      plots.forEach(function(p) {
        if (!p || !p.name) return;
        var polygon = null;
        if (Array.isArray(p.vertices) && p.vertices.length >= 3) {
          polygon = p.vertices.slice(); // [[lat,lng], ...]
        } else if (p.layer && typeof p.layer.getLatLngs === 'function') {
          // Leaflet polygon — extract latlngs
          try {
            var ll = p.layer.getLatLngs();
            if (ll && ll[0]) polygon = ll[0].map(function(pt) { return [pt.lat, pt.lng]; });
          } catch (e) {}
        }
        sites.push({
          id: 'plot:' + p.id,
          name: p.name,
          name_th: p.name_th || null,
          name_ar: p.name_ar || null,
          type: 'plot',
          geofence: {
            polygon: polygon,
            radiusMeters: (p.geofenceRadiusM != null ? p.geofenceRadiusM : DEFAULT_RADIUS_M)
          },
          linkedFarmId: p.farm_id || null,
          linkedPlotIds: [p.id],
          color: p.color || null
        });
      });
    }

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

  // ── Geometry helpers (Phase 2 will lean on these heavily) ──

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

  // Returns true if [lat,lng] is inside the site's geofence (polygon +
  // radius buffer). Custom and farm-level sites pass automatically.
  function isInside(site, point) {
    if (!site || !site.geofence) return true; // no geofence = no check
    if (!point || point[0] == null) return false;
    var poly = site.geofence.polygon;
    var r = site.geofence.radiusMeters || DEFAULT_RADIUS_M;
    if (Array.isArray(poly) && poly.length >= 3) {
      if (pointInPolygon(point, poly)) return true;
      // Allow being within `r` meters of the nearest vertex as a fudge.
      for (var i = 0; i < poly.length; i++) {
        if (haversineM(point, poly[i]) <= r) return true;
      }
      return false;
    }
    // No polygon (shouldn't happen for type:'plot' but be safe)
    return true;
  }

  return {
    getAll: getAll,
    findByName: findByName,
    isInside: isInside,
    haversineM: haversineM,
    pointInPolygon: pointInPolygon,
    DEFAULT_RADIUS_M: DEFAULT_RADIUS_M
  };
})();
