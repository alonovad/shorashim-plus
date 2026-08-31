/* plotedit.js — עריכת גבולות חלקה (plot boundary editor)
 * ------------------------------------------------------------------
 * Two things this adds to plots on the map:
 *
 *   1. HOVER READOUT. Move over any plot and a panel names it and gives its
 *      area, its overall dimensions and its tree count. Reading a plot used
 *      to require opening it.
 *
 *   2. EDITING. Drag a vertex, add one by dragging the midpoint handle
 *      between two others, delete one with a click, and add a whole
 *      DETACHED part that belongs to the same plot.
 *
 * WHY DETACHED PARTS MATTER
 *   An orchard split by a wadi or a service track is one חלקה with one tree
 *   count and one spray record. Modelling it as two plots doubles it in
 *   every report, halves the per-tree dose, and produces two rows where the
 *   grower expects one. The plot keeps its primary ring in `latlngs` so
 *   every existing reader is untouched, and additional rings live in
 *   `parts`.
 *
 * Geometry goes through MapAccess.getPlotRings / setPlotRings. This module
 * never reaches into the plots array or calls saveData itself — how plots
 * are stored is app.js's business, and keeping that boundary means a change
 * there cannot break this silently.
 */
var PlotEdit = (function () {
  'use strict';

  var HANDLE_PX = 16;
  var S = null;          // edit session
  var H = null;          // hover state

  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function map() { return (window.MapAccess && MapAccess.getMap) ? MapAccess.getMap() : null; }
  function isManager() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }

  // ── geometry ──
  function ringAreaM2(ring) {
    if (!ring || ring.length < 3) return 0;
    var a = 0, R = 6378137;
    for (var i = 0; i < ring.length; i++) {
      var j = (i + 1) % ring.length;
      var xi = ring[i].lng * Math.PI/180, yi = ring[i].lat * Math.PI/180;
      var xj = ring[j].lng * Math.PI/180, yj = ring[j].lat * Math.PI/180;
      a += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
    }
    return Math.abs(a * R * R / 2);
  }
  function ringsArea(rings) {
    var t = 0;
    (rings || []).forEach(function (r) { t += ringAreaM2(r); });
    return t;
  }
  // Overall extent, which is what someone means by "how big is it" — the
  // bounding box in metres, not the length of every edge.
  function extentOf(rings) {
    var m = map();
    if (!m || !rings || !rings.length) return { w: 0, h: 0 };
    var la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    rings.forEach(function (r) {
      r.forEach(function (c) {
        la0 = Math.min(la0, c.lat); la1 = Math.max(la1, c.lat);
        lo0 = Math.min(lo0, c.lng); lo1 = Math.max(lo1, c.lng);
      });
    });
    return {
      w: m.distance(L.latLng(la0, lo0), L.latLng(la0, lo1)),
      h: m.distance(L.latLng(la0, lo0), L.latLng(la1, lo0))
    };
  }
  function mid(a, b) { return L.latLng((a.lat+b.lat)/2, (a.lng+b.lng)/2); }
  function inRing(pt, ring) {
    var ins = false;
    for (var i = 0, j = ring.length-1; i < ring.length; j = i++) {
      if (((ring[i].lat > pt.lat) !== (ring[j].lat > pt.lat)) &&
          (pt.lng < (ring[j].lng-ring[i].lng)*(pt.lat-ring[i].lat)/(ring[j].lat-ring[i].lat)+ring[i].lng)) {
        ins = !ins;
      }
    }
    return ins;
  }

  // ══════════════════════════════════════════════════════════════════
  //  HOVER READOUT
  // ══════════════════════════════════════════════════════════════════
  function startHover() {
    var m = map();
    if (!m || H) return;
    H = { last: null };
    m.on('mousemove', onHover);
    m.on('mouseout', function () { hideCard(); });
  }

  function onHover(e) {
    // Suppressed while drawing or editing — a readout following the cursor
    // over the vertex being dragged is in the way, not informative.
    if (S || (window.MapAccess && MapAccess.isDrawing && MapAccess.isDrawing())) {
      hideCard(); return;
    }
    if (!window.MapAccess || !MapAccess.listPlotsWithRings) return;
    var list = MapAccess.listPlotsWithRings();
    var found = null;
    for (var i = 0; i < list.length && !found; i++) {
      for (var k = 0; k < list[i].rings.length; k++) {
        if (inRing(e.latlng, list[i].rings[k])) { found = list[i]; break; }
      }
    }
    if (!found) { hideCard(); H.last = null; return; }
    if (H.last === found.id) { moveCard(e); return; }
    H.last = found.id;
    showCard(found, e);
  }

  function hideCard() {
    var el = document.getElementById('peHover');
    if (el) el.style.display = 'none';
    if (H) H.last = null;
  }

  function moveCard(e) {
    var el = document.getElementById('peHover');
    if (!el) return;
    var pt = map().latLngToContainerPoint(e.latlng);
    var mapEl = document.getElementById('map');
    var r = mapEl ? mapEl.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    // Flip to the other side near the edge so the card never leaves the map.
    var x = pt.x + 16, y = pt.y + 16;
    if (x + 240 > r.width) x = pt.x - 250;
    if (y + 130 > r.height) y = pt.y - 130;
    el.style.left = Math.max(4, x) + 'px';
    el.style.top = Math.max(4, y) + 'px';
  }

  function showCard(p, e) {
    var el = document.getElementById('peHover');
    if (!el) {
      el = document.createElement('div');
      el.id = 'peHover';
      el.style.cssText = 'position:absolute;z-index:900;pointer-events:none;min-width:180px;' +
        'max-width:250px;background:rgba(8,18,12,.93);color:#e9eee9;border-radius:11px;' +
        'padding:9px 12px;font:600 12px/1.55 Heebo,Arial,sans-serif;' +
        'border:1px solid rgba(255,255,255,.18);box-shadow:0 6px 22px rgba(0,0,0,.45);';
      var mapEl = document.getElementById('map');
      if (mapEl) mapEl.appendChild(el); else return;
    }
    var ext = extentOf(p.rings);
    var parts = p.rings.length;
    var dec = Number(p.declared) || 0, mea = Number(p.measured) || 0;
    // Two different facts, shown as two lines. The registered area is what
    // the farm is billed and planned against; the traced boundary is what
    // someone drew on a photo. They are rarely identical and pretending
    // otherwise hides whichever one is wrong.
    var diff = (dec > 0 && mea > 0) ? (mea - dec) : 0;
    var diffPct = dec > 0 ? Math.abs(diff / dec) * 100 : 0;
    var diffCol = diffPct > 10 ? '#ff6b6b' : diffPct > 3 ? '#ffb703' : '#a8e6a1';

    el.innerHTML =
      '<div style="display:flex;align-items:center;gap:6px;font-weight:800;font-size:13px;">' +
        '<span style="width:10px;height:10px;border-radius:3px;background:' + (p.color||'#2d6a4f') + ';"></span>' +
        esc(p.name) + '</div>' +

      '<div style="display:flex;justify-content:space-between;gap:10px;margin-top:5px;">' +
        '<span style="opacity:.8;">' + tt('בפועל (בכרטיס)', 'ตามบัตร', 'المسجّل') + '</span>' +
        '<b style="color:#ffd166;">' + (dec > 0 ? n2(dec) + ' ' + tt('דונם','ดูนัม','دونم') : '\u2014') +
      '</b></div>' +

      '<div style="display:flex;justify-content:space-between;gap:10px;">' +
        '<span style="opacity:.8;">' + tt('מסומן במפה', 'บนแผนที่', 'على الخريطة') + '</span>' +
        '<b style="color:#9fd8ff;">' + n2(mea) + ' ' + tt('דונם','ดูนัม','دونم') + '</b></div>' +

      (dec > 0 && mea > 0
        ? '<div style="display:flex;justify-content:space-between;gap:10px;">' +
            '<span style="opacity:.8;">' + tt('הפרש', 'ผลต่าง', 'الفارق') + '</span>' +
            '<b style="color:' + diffCol + ';">' + (diff >= 0 ? '+' : '\u2212') +
              n2(Math.abs(diff)) + '  (' + n1(diffPct) + '%)</b></div>'
        : '') +

      '<div style="display:flex;justify-content:space-between;gap:10px;opacity:.8;">' +
        '<span>' + tt('מידות', 'ขนาด', 'الأبعاد') + '</span>' +
        '<span>' + n1(ext.w) + ' \u00d7 ' + n1(ext.h) + ' m</span></div>' +
      (p.trees ? '<div style="display:flex;justify-content:space-between;gap:10px;opacity:.8;">' +
        '<span>' + tt('עצים', 'ต้น', 'أشجار') + '</span><span>' +
        p.trees.toLocaleString() + '</span></div>' : '') +
      (p.crop ? '<div style="opacity:.65;">' + esc(p.crop) + '</div>' : '') +
      (parts > 1 ? '<div style="opacity:.75;color:#a8e6a1;">' + parts + ' ' +
        tt('חלקים', 'ส่วน', 'أجزاء') + '</div>' : '');
    el.style.display = 'block';
    moveCard(e);
  }

  // ══════════════════════════════════════════════════════════════════
  //  EDITOR
  // ══════════════════════════════════════════════════════════════════
  function open(plotId) {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var m = map();
    if (!m || !window.MapAccess || !MapAccess.getPlotRings) return;
    var data = MapAccess.getPlotRings(plotId);
    if (!data || !data.rings.length) {
      toast('\u26a0\ufe0f ' + tt('לחלקה אין גבול משורטט', 'ไม่มีขอบเขต', 'لا حدود مرسومة'));
      return;
    }
    if (MapAccess.setExternalDraw && !MapAccess.setExternalDraw(true)) {
      toast('\u26a0\ufe0f ' + tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (MapAccess.goToMap) MapAccess.goToMap();
    hideCard();

    S = { id: plotId, name: data.name, color: data.color || '#2d6a4f',
          trees: data.trees, declared: Number(data.declared) || 0,
          rings: data.rings.map(function (r) {
            return r.map(function (c) { return L.latLng(c.lat, c.lng); });
          }),
          gfx: [], drag: null, adding: null };
    setTimeout(function () { m.invalidateSize(); redraw(); banner(); }, 80);
    m.on('mousedown', onDown);
    m.on('mousemove', onMove);
    m.on('mouseup', onUp);
    m.on('click', onClick);
  }

  function clearGfx() {
    var m = map();
    (S.gfx || []).forEach(function (l) { try { m.removeLayer(l); } catch (e) {} });
    S.gfx = [];
  }

  function redraw() {
    var m = map();
    if (!m || !S) return;
    clearGfx();

    S.rings.forEach(function (ring, ri) {
      var poly = L.polygon(ring, {
        color: S.color, fillColor: S.color, weight: ri === 0 ? 3 : 2,
        fillOpacity: 0.18, dashArray: ri === 0 ? null : '7,5'
      }).addTo(m);
      S.gfx.push(poly);

      ring.forEach(function (pt, i) {
        var vm = L.marker(pt, { interactive: true, icon: L.divIcon({ className: '',
          iconSize: [13,13], iconAnchor: [6.5,6.5],
          html: '<div style="width:13px;height:13px;border-radius:50%;background:#ff9f43;' +
                'border:2px solid #06120b;cursor:move;"></div>' }) }).addTo(m);
        vm._ri = ri; vm._vi = i; vm._kind = 'v';
        S.gfx.push(vm);
      });

      // Midpoint handles: dragging one inserts a vertex there. Adding a
      // point by clicking an edge is guesswork about which edge; a visible
      // handle between two vertices is not.
      ring.forEach(function (pt, i) {
        var nxt = ring[(i+1) % ring.length];
        var mm = L.marker(mid(pt, nxt), { interactive: true, icon: L.divIcon({ className: '',
          iconSize: [10,10], iconAnchor: [5,5],
          html: '<div style="width:10px;height:10px;border-radius:50%;background:rgba(255,255,255,.85);' +
                'border:1.5px solid #2d6a4f;cursor:copy;"></div>' }) }).addTo(m);
        mm._ri = ri; mm._vi = i; mm._kind = 'm';
        S.gfx.push(mm);
      });
    });

    if (S.adding && S.adding.length) {
      S.adding.forEach(function (pt) {
        S.gfx.push(L.circleMarker(pt, { radius: 5, color: '#2ecc71', fillOpacity: 1 }).addTo(m));
      });
      if (S.adding.length > 1) {
        S.gfx.push(L.polygon(S.adding, { color: '#2ecc71', weight: 2,
          fillOpacity: 0.15, dashArray: '5,4' }).addTo(m));
      }
    }
    banner();
  }

  function nearHandle(latlng) {
    var m = map(), best = null, bd = HANDLE_PX;
    var p0 = m.latLngToContainerPoint(latlng);
    S.gfx.forEach(function (g) {
      if (!g._kind) return;
      var d = p0.distanceTo(m.latLngToContainerPoint(g.getLatLng()));
      if (d < bd) { bd = d; best = g; }
    });
    return best;
  }

  function onDown(e) {
    if (!S || S.adding) return;
    var h = nearHandle(e.latlng);
    if (!h) return;
    if (h._kind === 'v') { S.drag = { ri: h._ri, vi: h._vi }; }
    else {
      // Insert at the midpoint, then drag the new vertex straight away.
      S.rings[h._ri].splice(h._vi + 1, 0, L.latLng(h.getLatLng().lat, h.getLatLng().lng));
      S.drag = { ri: h._ri, vi: h._vi + 1 };
      redraw();
    }
    if (map().dragging) map().dragging.disable();
  }

  function onMove(e) {
    if (!S || !S.drag) return;
    S.rings[S.drag.ri][S.drag.vi] = e.latlng;
    redraw();
  }

  function onUp() {
    if (!S) return;
    S.drag = null;
    if (map().dragging) map().dragging.enable();
  }

  function onClick(e) {
    if (!S || !S.adding) return;
    S.adding.push(e.latlng);
    redraw();
  }

  // Deleting is a click on a vertex while the delete mode is armed — a
  // modifier key is not discoverable and does not exist on a phone.
  function delVertex(ri, vi) {
    if (!S) return;
    if (S.rings[ri].length <= 3) {
      toast('\u26a0\ufe0f ' + tt('צריך לפחות 3 נקודות', 'ต้องมีอย่างน้อย 3 จุด', 'ثلاث نقاط على الأقل'));
      return;
    }
    S.rings[ri].splice(vi, 1);
    redraw();
  }

  function armDelete() {
    if (!S) return;
    S.delMode = !S.delMode;
    var m = map();
    S.gfx.forEach(function (g) {
      if (g._kind !== 'v') return;
      g.off('click');
      if (S.delMode) {
        g.on('click', function () { delVertex(g._ri, g._vi); });
      }
    });
    void m;
    banner();
  }

  function startPart() {
    if (!S) return;
    S.adding = [];
    S.delMode = false;
    redraw();
    toast('\u2b20 ' + tt('לחץ על המפה לסימון החלק הנוסף', 'แตะเพื่อวาดส่วนเพิ่ม', 'انقر لرسم الجزء الإضافي'));
  }

  function finishPart() {
    if (!S || !S.adding) return;
    if (S.adding.length < 3) {
      toast('\u26a0\ufe0f ' + tt('צריך לפחות 3 נקודות', 'ต้องมีอย่างน้อย 3 จุด', 'ثلاث نقاط على الأقل'));
      return;
    }
    S.rings.push(S.adding.slice());
    S.adding = null;
    redraw();
  }

  function cancelPart() { if (S) { S.adding = null; redraw(); } }

  function delPart(ri) {
    if (!S || S.rings.length <= 1) {
      toast('\u26a0\ufe0f ' + tt('לא ניתן למחוק את החלק היחיד', 'ลบส่วนเดียวไม่ได้', 'لا يمكن حذف الجزء الوحيد'));
      return;
    }
    S.rings.splice(ri, 1);
    redraw();
  }

  function banner() {
    var b = document.getElementById('peBanner');
    if (!b) { b = document.createElement('div'); b.id = 'peBanner'; document.body.appendChild(b); }
    if (!S) { b.remove(); return; }
    var area = ringsArea(S.rings) / 1000;
    var ext = extentOf(S.rings.map(function (r) {
      return r.map(function (c) { return { lat: c.lat, lng: c.lng }; });
    }));
    var btn = 'padding:6px 11px;border-radius:8px;border:none;font-family:inherit;font-weight:700;' +
              'color:#fff;cursor:pointer;font-size:.8rem;';
    var partBtns = S.rings.map(function (r, i) {
      return '<button onclick="PlotEdit.delPart(' + i + ')" style="' + btn +
        'background:rgba(255,255,255,.12);">' + (i === 0
          ? tt('ראשי', 'หลัก', 'رئيسي') : tt('חלק', 'ส่วน', 'جزء') + ' ' + (i+1)) +
        ' \u00b7 ' + n2(ringAreaM2(r.map(function (c) { return { lat: c.lat, lng: c.lng }; }))/1000) +
        (i > 0 ? ' \ud83d\uddd1' : '') + '</button>';
    }).join(' ');

    b.innerHTML =
      '<div style="position:fixed;top:0;inset-inline:0;z-index:10060;padding:10px 12px;' +
        'background:rgba(8,18,12,.96);color:#fff;display:flex;gap:8px;align-items:center;' +
        'justify-content:center;flex-wrap:wrap;font-weight:700;font-size:.85rem;">' +
        '<span>\u270f\ufe0f ' + esc(S.name) + '</span>' +
        // Live comparison while dragging: the number you are trying to hit is
      // the one on the card, so it is on screen next to the one you are
      // changing rather than a screen away.
      '<span style="background:rgba(159,216,255,.14);border:1px solid rgba(159,216,255,.4);' +
          'padding:3px 9px;border-radius:9px;color:#9fd8ff;">' +
          tt('מסומן', 'บนแผนที่', 'مرسوم') + ' ' + n2(area) + ' \u00b7 ' +
          n1(ext.w) + '\u00d7' + n1(ext.h) + ' m</span>' +
      (S.declared > 0
        ? '<span style="background:rgba(255,209,102,.16);border:1px solid rgba(255,209,102,.4);' +
            'padding:3px 9px;border-radius:9px;color:#ffd166;">' +
            tt('בפועל', 'ตามบัตร', 'المسجّل') + ' ' + n2(S.declared) + '</span>' +
          '<span style="padding:3px 9px;border-radius:9px;color:' +
            (Math.abs(area - S.declared) / S.declared > 0.1 ? '#ff6b6b'
              : Math.abs(area - S.declared) / S.declared > 0.03 ? '#ffb703' : '#a8e6a1') + ';">' +
            (area >= S.declared ? '+' : '\u2212') + n2(Math.abs(area - S.declared)) + ' ' +
            tt('דונם', 'ดูนัม', 'دونم') + '</span>'
        : '') +
        partBtns +
        (S.adding
          ? '<button onclick="PlotEdit.finishPart()" style="' + btn + 'background:#2d6a4f;">\u2713 ' +
              tt('סיים חלק', 'จบส่วน', 'إنهاء الجزء') + '</button>' +
            '<button onclick="PlotEdit.cancelPart()" style="' + btn + 'background:rgba(255,71,87,.3);">\u2715</button>'
          : '<button onclick="PlotEdit.startPart()" style="' + btn + 'background:rgba(46,204,113,.35);">\u2795 ' +
              tt('חלק נוסף', 'ส่วนเพิ่ม', 'جزء إضافي') + '</button>' +
            '<button onclick="PlotEdit.armDelete()" style="' + btn +
              'background:' + (S.delMode ? '#c62828' : 'rgba(255,255,255,.12)') + ';">\ud83d\uddd1 ' +
              (S.delMode ? tt('לחץ על נקודה למחיקה', 'แตะจุดเพื่อลบ', 'انقر نقطة للحذف')
                         : tt('מחק נקודות', 'ลบจุด', 'حذف نقاط')) + '</button>') +
        (S.declared > 0 && Math.abs(area - S.declared) > 0.01
          ? '<button onclick="PlotEdit.adoptMeasured()" style="' + btn +
              'background:rgba(255,209,102,.25);">\u21b3 ' +
              tt('עדכן את הכרטיס ל-', 'อัปเดตบัตรเป็น', 'حدّث البطاقة إلى') + ' ' + n2(area) + '</button>'
          : '') +
        '<button onclick="PlotEdit.save()" style="' + btn + 'background:#2d6a4f;">\ud83d\udcbe ' +
          tt('שמור גבולות', 'บันทึกขอบเขต', 'حفظ الحدود') + '</button>' +
        '<button onclick="PlotEdit.cancel()" style="' + btn + 'background:rgba(255,71,87,.25);">\u2715</button>' +
      '</div>';
  }

  function teardown() {
    var m = map();
    if (S && m) {
      clearGfx();
      m.off('mousedown', onDown);
      m.off('mousemove', onMove);
      m.off('mouseup', onUp);
      m.off('click', onClick);
      if (m.dragging) m.dragging.enable();
    }
    S = null;
    var b = document.getElementById('peBanner');
    if (b) b.remove();
    if (window.MapAccess && MapAccess.setExternalDraw) MapAccess.setExternalDraw(false);
  }

  // Explicit, never automatic. Redrawing a boundary more accurately is not
  // the same claim as "the registered area was wrong", and only the person
  // looking at both numbers can decide which one to trust.
  function adoptMeasured() {
    if (!S) return;
    S.adopt = ringsArea(S.rings) / 1000;
    S.declared = S.adopt;
    redraw();
    toast('\u2713 ' + tt('הכרטיס יעודכן בשמירה', 'จะอัปเดตเมื่อบันทึก', 'سيُحدَّث عند الحفظ'));
  }

  function save() {
    if (!S) return;
    var rings = S.rings.map(function (r) {
      return r.map(function (c) { return { lat: c.lat, lng: c.lng }; });
    });
    var id = S.id, area = ringsArea(rings) / 1000;
    var adopt = S.adopt;
    var okd = MapAccess.setPlotRings(id, rings, adopt);
    teardown();
    if (okd) {
      toast('\u2705 ' + n2(area) + ' ' + tt('דונם', 'ดูนัม', 'دونم'));
      if (window.Audit && Audit.log) {
        Audit.log('edit', 'plot-geometry', String(id),
          { after: { parts: rings.length, dunam: n2(area) } });
      }
    } else {
      toast('\u26a0\ufe0f ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ'));
    }
  }

  function cancel() { teardown(); }

  // Hover starts once the map exists; login happens later than load.
  function boot() {
    if (map()) { startHover(); return true; }
    return false;
  }
  if (typeof window !== 'undefined') {
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (boot() || tries > 60) clearInterval(iv);
    }, 2000);
  }

  return {
    open: open, save: save, cancel: cancel,
    startPart: startPart, finishPart: finishPart, cancelPart: cancelPart,
    delPart: delPart, armDelete: armDelete, adoptMeasured: adoptMeasured,
    hideCard: hideCard, active: function () { return !!S; }
  };
})();
