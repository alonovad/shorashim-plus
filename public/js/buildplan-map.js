/* buildplan-map.js — Leaflet footprints, rectangle editor, live measurement
 * ------------------------------------------------------------------
 * Part of the BuildPlan module, split out of the former single
 * buildplan.js (3864 lines). Load order is fixed and enforced in
 * index.html and sw.js:
 *
 *   core → geom → draw → map → ui → link
 *
 * Shared state and any function called across file boundaries live on
 * the internals bag `BuildPlanInternals` (`BP` inside each file).
 * Names used only within one file stay plain closure vars, exactly as
 * before. No behaviour changed in this split — only where the code
 * lives. Every cross-file reference is a runtime call or a property
 * read, never a load-time value, so the load order above is the only
 * ordering constraint.
 */
(function (BP) {
  'use strict';
  // ══════════════════════════════════════════════════════════════════
  //  MAP FOOTPRINTS
  // ══════════════════════════════════════════════════════════════════
  BP.map = function map() {
    return (window.MapAccess && MapAccess.getMap) ? MapAccess.getMap() : null;
  };

  function layer() {
    var m = BP.map();
    if (!m || !window.L) return null;
    // Re-add if a previous attempt created the group before the map existed,
    // or if something cleared the map's layers underneath us.
    if (!BP._layer) BP._layer = L.layerGroup();
    if (!m.hasLayer(BP._layer)) BP._layer.addTo(m);
    return BP._layer;
  }

  BP.drawFootprints = function drawFootprints() {
    var lg = layer();
    if (!lg) return;
    lg.clearLayers();
    (BP.P.projects || []).forEach(function (p) {
      if (!p.footprint || p.footprint.length < 3) return;
      var pts = p.footprint.map(function (pt) { return [pt.lat, pt.lng]; });
      var poly = L.polygon(pts, {
        color: '#ff9f43', weight: 2, fillColor: '#ff9f43', fillOpacity: 0.25, dashArray: '6,4'
      });
      poly.bindTooltip((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') + (p.name || ''), {
        permanent: false, direction: 'center'
      });
      poly.on('click', function () { BP.open(p.id); });
      lg.addLayer(poly);
    });
  };

  // Point collection runs on our own layer; app.js is parked on the
  // 'external' sentinel so its plot popups and its own draw tools stay quiet.
  // ── rectangle / transform editor ─────────────────────────────────────
  // Point-by-point tracing is right for copying something already on the
  // ground and useless for laying out a shed that does not exist yet.
  // This is the other mode: drag it out, then set the numbers.
  var _ge = null;

  // One tap: put a rectangle of the project's own dimensions at the centre
  // of the current map view, ready to drag into position. Making the user
  // draw a box and then type the numbers they already entered on the design
  // tab was work the app could do for them.
  BP.placeFromDims = function placeFromDims(id) {
    var p = BP.projById(id), m = BP.map();
    if (!p) return;
    if (!m) { BP.toast('\u26a0\ufe0f ' + BP.tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (typeof GeoEdit === 'undefined') return;
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else BP.close();

    var w = p.type === 'slab' ? (p.dims.span || 10) : (p.dims.span || 10);
    var h = p.dims.length || 20;
    var c = m.getCenter();
    _ge = { id: id };
    setTimeout(function () {
      m.invalidateSize();
      var ctr = m.getCenter();
      GeoEdit.start(m, {
        mode: 'edit',
        rect: { lat: ctr.lat, lng: ctr.lng, w: w, h: h, rot: (p.rect && p.rect.rot) || 0 },
        pts: [{ lat: ctr.lat, lng: ctr.lng }, { lat: ctr.lat, lng: ctr.lng },
              { lat: ctr.lat, lng: ctr.lng }],
        onChange: rectReadout
      });
      GeoEdit.setDims(w, h, (p.rect && p.rect.rot) || 0);
      rectBanner(id);
      BP.toast('\u25ad ' + BP.n1(w) + ' \u00d7 ' + BP.n1(h) + ' m \u00b7 ' +
        BP.tt('גרור למקום', 'ลากไปยังตำแหน่ง', 'اسحب إلى الموقع'));
    }, 120);
    void c;
  };

  // The reverse: take the drawn rectangle's sides as the building's span
  // and length, so a footprint measured on site drives the model.
  BP.dimsFromRect = function dimsFromRect(id) {
    var p = BP.projById(id);
    if (!p || !p.rect || !(p.rect.w > 0)) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('אין מלבן מסומן', 'ยังไม่มีสี่เหลี่ยม', 'لا يوجد مستطيل'));
      return;
    }
    p.dims.span = BP.n1(p.rect.w);
    p.dims.length = BP.n1(p.rect.h);
    BP.saveP();
    BP.toast('\u2705 ' + BP.n1(p.rect.w) + ' \u00d7 ' + BP.n1(p.rect.h) + ' m');
    BP.open(id);
  };

  BP.startRect = function startRect(id) {
    var m = BP.map();
    if (!m) { BP.toast('\u26a0\ufe0f ' + BP.tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (typeof GeoEdit === 'undefined') {
      BP.toast('\u26a0\ufe0f ' + BP.tt('עורך הגיאומטריה לא נטען', 'ตัวแก้ไขไม่พร้อม', 'المحرر غير محمّل'));
      return;
    }
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else BP.close();

    var p = BP.projById(id);
    _ge = { id: id };
    var opts = { mode: 'draw', onChange: rectReadout };
    // Re-opening an existing footprint keeps it editable rather than
    // forcing the user to redraw from scratch to change one dimension.
    if (p && p.footprint && p.footprint.length >= 3) {
      opts.pts = p.footprint;
      if (p.rect && p.rect.w > 0) opts.rect = p.rect;
    }
    GeoEdit.start(m, opts);
    rectBanner(id);
  };

  function rectReadout(st) {
    var f = function (id2) { return document.getElementById(id2); };
    if (f('geW') && document.activeElement !== f('geW')) f('geW').value = BP.n1(st.w);
    if (f('geH') && document.activeElement !== f('geH')) f('geH').value = BP.n1(st.h);
    if (f('geR') && document.activeElement !== f('geR')) f('geR').value = Math.round(st.rot);
    var a = f('geArea');
    if (a) {
      a.textContent = BP.n1(st.area) + ' \u05de"\u05e8' +
        (st.area >= 1000 ? '  \u00b7  ' + (st.area / 1000).toFixed(2) + ' \u05d3\u05d5\u05e0\u05dd' : '');
    }
  }

  function rectBanner(id) {
    var b = document.getElementById('bpBanner');
    if (!b) { b = document.createElement('div'); b.id = 'bpBanner'; document.body.appendChild(b); }
    var fld = 'width:70px;padding:5px;border-radius:7px;border:1px solid rgba(255,255,255,.25);' +
              'background:rgba(0,0,0,.35);color:#fff;font-family:inherit;font-weight:700;';
    b.innerHTML =
      '<div style="position:fixed;top:0;inset-inline:0;z-index:10060;padding:10px 12px;' +
        'background:rgba(8,18,12,.96);color:#fff;display:flex;gap:8px;align-items:center;' +
        'justify-content:center;flex-wrap:wrap;font-weight:700;font-size:.86rem;">' +
        // The map is yours to move until you say otherwise.
        '<button onclick="BuildPlan.geArm()" id="geArmBtn" style="padding:6px 12px;border-radius:8px;' +
          'border:none;background:rgba(255,255,255,.14);color:#fff;font-family:inherit;font-weight:800;">' +
          '\u25ad ' + BP.tt('צייר מלבן', 'วาดสี่เหลี่ยม', 'ارسم مستطيلاً') + '</button>' +
        '<span id="geHint" style="opacity:.85;">' +
          BP.tt('גרור להזזת המפה \u00b7 לחץ "צייר מלבן" כשתגיע למקום',
             'ลากเพื่อเลื่อนแผนที่', 'اسحب لتحريك الخريطة') + '</span>' +
        '<span id="geArea" style="background:rgba(255,209,102,.16);border:1px solid rgba(255,209,102,.4);' +
          'padding:3px 9px;border-radius:9px;color:#ffd166;">\u2014</span>' +
        '<span style="display:inline-flex;gap:5px;align-items:center;background:rgba(255,255,255,.08);' +
          'padding:4px 8px;border-radius:9px;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + BP.tt('רוחב', 'กว้าง', 'عرض') + '</span>' +
          '<input id="geW" type="number" step="0.1" style="' + fld + '" oninput="BuildPlan.geApply()">' +
          '<span style="font-size:.74rem;opacity:.85;">' + BP.tt('אורך', 'ยาว', 'طول') + '</span>' +
          '<input id="geH" type="number" step="0.1" style="' + fld + '" oninput="BuildPlan.geApply()">' +
          '<span style="font-size:.74rem;opacity:.85;">' + BP.tt('סיבוב°', 'หมุน°', 'دوران°') + '</span>' +
          '<input id="geR" type="number" step="1" style="' + fld + '" oninput="BuildPlan.geApply()">' +
        '</span>' +
        '<button onclick="BuildPlan.geRot(-15)" style="padding:5px 9px;border-radius:8px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-weight:800;">\u21ba15\u00b0</button>' +
        '<button onclick="BuildPlan.geRot(15)" style="padding:5px 9px;border-radius:8px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-weight:800;">\u21bb15\u00b0</button>' +
        '<button onclick="BuildPlan.geRedraw()" style="padding:5px 10px;border-radius:8px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-weight:700;">\u25ad ' +
          BP.tt('צייר מחדש', 'วาดใหม่', 'ارسم مجدداً') + '</button>' +
        '<button onclick="BuildPlan.geSave(' + id + ')" style="padding:6px 14px;border-radius:8px;border:none;' +
          'background:#2d6a4f;color:#fff;font-weight:800;">\u2713 ' + BP.tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
        '<button onclick="BuildPlan.geCancel()" style="padding:5px 10px;border-radius:8px;border:none;' +
          'background:rgba(255,71,87,.25);color:#fff;font-weight:700;">\u2715</button>' +
      '</div>';
  }

  BP.geApply = function geApply() {
    if (typeof GeoEdit === 'undefined' || !GeoEdit.active()) return;
    var w = Number((document.getElementById('geW') || {}).value);
    var h = Number((document.getElementById('geH') || {}).value);
    var r = Number((document.getElementById('geR') || {}).value);
    GeoEdit.setDims(isFinite(w) ? w : null, isFinite(h) ? h : null, isFinite(r) ? r : null);
  };
  BP.geRot = function geRot(d) { if (typeof GeoEdit !== 'undefined') GeoEdit.nudgeRot(d); };
  BP.geRedraw = function geRedraw() { BP.geArm(); };

  // Arm drawing. Until this is pressed the map pans normally, which is the
  // only way to reach the spot you actually want to draw on.
  BP.geArm = function geArm() {
    if (typeof GeoEdit === 'undefined') return;
    var on = !GeoEdit.isArmed();
    GeoEdit.arm(on);
    var b = document.getElementById('geArmBtn');
    var h = document.getElementById('geHint');
    if (b) b.style.background = on ? '#2d6a4f' : 'rgba(255,255,255,.14)';
    if (h) {
      h.textContent = on
        ? BP.tt('גרור על המפה ליצירת המלבן', 'ลากเพื่อสร้าง', 'اسحب لإنشاء المستطيل')
        : BP.tt('גרור להזזת המפה \u00b7 לחץ "צייר מלבן" כשתגיע למקום',
             'ลากเพื่อเลื่อนแผนที่', 'اسحب لتحريك الخريطة');
    }
  };

  BP.geCancel = function geCancel() {
    if (typeof GeoEdit !== 'undefined') GeoEdit.stop();
    _ge = null;
    banner(false);
    if (window.MapAccess) MapAccess.setExternalDraw(false);
    BP.loadAll().then(function () { BP.render(); });
  };

  BP.geSave = function geSave(id) {
    if (typeof GeoEdit === 'undefined') return;
    var st = GeoEdit.get();
    if (!st || !st.pts || st.pts.length < 3) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('צייר קודם מלבן', 'วาดก่อน', 'ارسم أولاً'));
      return;
    }
    var p = BP.projById(id);
    GeoEdit.stop();
    _ge = null;
    banner(false);
    if (window.MapAccess) MapAccess.setExternalDraw(false);
    if (p) {
      p.footprint = st.pts;
      p.footprintArea = st.area;
      // Keeping the parametric form means the next edit starts from the
      // exact numbers, not from four corners re-measured off the ground.
      p.rect = (st.kind === 'rect')
        ? { lat: st.ring[0] ? (st.ring[0].lat + st.ring[2].lat) / 2 : 0,
            lng: st.ring[0] ? (st.ring[0].lng + st.ring[2].lng) / 2 : 0,
            w: st.w, h: st.h, rot: st.rot }
        : null;
      BP.saveP();
      BP.toast('\u2705 ' + BP.n1(st.area) + ' \u05de"\u05e8');
      BP.open(id);
    }
  };

  BP.startFootprint = function startFootprint(id) {
    var m = BP.map();
    if (!m) { BP.toast('\u26a0\ufe0f ' + BP.tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else BP.close();
    BP._draw = { id: id, pts: [], markers: [], labels: [], line: null, area: 0, per: 0, armed: false };
    m.on('click', onDrawClick);
    m.on('mousemove', onDrawMove);
    banner(true);
  };

  // ── live measurement ──────────────────────────────────────────────
  // Every edge is labelled with its length as it is drawn, and area,
  // perimeter and the closing edge update on each click and on mouse move.
  // Tracing a slab blind and discovering afterwards that it came out 9.2 m
  // instead of 10 means re-walking the site.
  function metres(a, b) { return BP.map().distance(a, b); }

  function fmtM(x) {
    return (x < 10 ? x.toFixed(2) : x.toFixed(1)) + ' m';
  }

  function edgeLabel(a, b, cls) {
    var mid = L.latLng((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
    return L.marker(mid, {
      interactive: false,
      icon: L.divIcon({
        className: '',
        html: '<div style="transform:translate(-50%,-50%);background:rgba(8,18,12,.92);' +
          'color:' + (cls === 'close' ? '#9fb3c8' : '#ffd166') + ';padding:2px 7px;border-radius:8px;' +
          'font:700 11px/1.3 Heebo,Arial,sans-serif;white-space:nowrap;' +
          'border:1px solid rgba(255,255,255,.18);">' + fmtM(metres(a, b)) + '</div>',
        iconSize: [0, 0]
      })
    });
  }

  function refreshMeasure(hover) {
    if (!BP._draw) return;
    var m = BP.map();
    (BP._draw.labels || []).forEach(function (l) { m.removeLayer(l); });
    BP._draw.labels = [];
    var pts = BP._draw.pts.slice();
    if (hover) pts.push(hover);
    for (var i = 0; i + 1 < pts.length; i++) {
      var lb = edgeLabel(pts[i], pts[i + 1]);
      lb.addTo(m); BP._draw.labels.push(lb);
    }
    // The closing edge is shown in a muted colour: it is implied by the
    // polygon, not yet drawn by the user.
    if (pts.length > 2) {
      var cl = edgeLabel(pts[pts.length - 1], pts[0], 'close');
      cl.addTo(m); BP._draw.labels.push(cl);
    }
    if (BP._draw.line) m.removeLayer(BP._draw.line);
    BP._draw.line = null;
    if (pts.length > 1) {
      BP._draw.line = L.polygon(pts, {
        color: '#ff9f43', weight: 2, fillOpacity: .18, dashArray: hover ? '6,5' : null
      }).addTo(m);
    }
    var area = (window.MapAccess && pts.length > 2) ? MapAccess.areaFromLatLngs(pts) : 0;
    var per = 0;
    for (var j = 0; j < pts.length; j++) {
      if (j + 1 < pts.length) per += metres(pts[j], pts[j + 1]);
    }
    if (pts.length > 2) per += metres(pts[pts.length - 1], pts[0]);
    BP._draw.area = area;
    BP._draw.per = per;
    banner(true);
  }

  function onDrawMove(e) {
    if (!BP._draw || !BP._draw.armed) return;
    // Highlight the first vertex when the cursor is near it, so the user can
    // see the polygon is about to close before committing the click.
    var near = nearFirst(e.latlng);
    if (near !== BP._draw.snap) {
      BP._draw.snap = near;
      if (BP._draw.markers[0]) {
        BP._draw.markers[0].setStyle({ radius: near ? 9 : 5, color: near ? '#2ecc71' : '#ff9f43' });
      }
      banner(true);
    }
    refreshMeasure(near ? null : e.latlng);
  }

  // Within ~14 screen px of the opening point, and at least three points
  // down, a click means "close this shape" — not "add a fourth corner on top
  // of the first one", which is what it used to mean and why finishing felt
  // like fighting the tool.
  function nearFirst(ll) {
    if (!BP._draw || BP._draw.pts.length < 3) return false;
    var m = BP.map();
    var a = m.latLngToContainerPoint(BP._draw.pts[0]);
    var b = m.latLngToContainerPoint(ll);
    return a.distanceTo(b) < 14;
  }

  // Great-circle offset: given a point, a bearing and a distance, where do
  // you land? This is what makes "draw exactly 20 m east" possible.
  function destination(from, bearingDeg, distM) {
    var R = 6378137;
    var d = distM / R, br = bearingDeg * Math.PI / 180;
    var la1 = from.lat * Math.PI / 180, lo1 = from.lng * Math.PI / 180;
    var la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(br));
    var lo2 = lo1 + Math.atan2(Math.sin(br) * Math.sin(d) * Math.cos(la1),
                               Math.cos(d) - Math.sin(la1) * Math.sin(la2));
    return L.latLng(la2 * 180 / Math.PI, ((lo2 * 180 / Math.PI) + 540) % 360 - 180);
  }

  function bearing(a, b) {
    var la1 = a.lat * Math.PI/180, la2 = b.lat * Math.PI/180;
    var dl = (b.lng - a.lng) * Math.PI/180;
    var y = Math.sin(dl) * Math.cos(la2);
    var x = Math.cos(la1)*Math.sin(la2) - Math.sin(la1)*Math.cos(la2)*Math.cos(dl);
    return (Math.atan2(y, x) * 180/Math.PI + 360) % 360;
  }

  // Add a segment by typing its length, and optionally the turn from the
  // previous one. 90° turns plus two lengths give an exact 20×20.
  BP.addSegment = function addSegment() {
    if (!BP._draw) return;
    var lenEl = document.getElementById('bpSegLen');
    var angEl = document.getElementById('bpSegAng');
    var dist = Number(lenEl && lenEl.value) || 0;
    if (dist <= 0) { BP.toast('\u26a0\ufe0f ' + BP.tt('הזן אורך', 'ใส่ความยาว', 'أدخل الطول')); return; }
    var turn = Number(angEl && angEl.value);
    if (!isFinite(turn)) turn = 90;

    var n = BP._draw.pts.length;
    if (!n) { BP.toast('\u26a0\ufe0f ' + BP.tt('סמן קודם נקודת התחלה', 'เลือกจุดเริ่มก่อน', 'حدد نقطة البداية')); return; }
    var br;
    if (n === 1) br = turn;                                   // first leg: absolute bearing
    else br = (bearing(BP._draw.pts[n-2], BP._draw.pts[n-1]) + turn + 360) % 360;

    var next = destination(BP._draw.pts[n-1], br, dist);
    BP._draw.pts.push(next);
    BP._draw.markers.push(L.circleMarker(next, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(BP.map()));
    refreshMeasure(null);
    if (lenEl) lenEl.focus();
  };

  // An exact rectangle from the first point: the common case, and doing it
  // by four typed segments invites an off-by-one on the last corner.
  BP.exactRect = function exactRect() {
    if (!BP._draw || !BP._draw.pts.length) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('סמן קודם נקודת פינה', 'เลือกมุมแรกก่อน', 'حدد الزاوية الأولى'));
      return;
    }
    var a = Number((document.getElementById('bpRectA') || {}).value) || 0;
    var b = Number((document.getElementById('bpRectB') || {}).value) || 0;
    var rot = Number((document.getElementById('bpRectR') || {}).value) || 0;
    if (a <= 0 || b <= 0) { BP.toast('\u26a0\ufe0f ' + BP.tt('הזן a ו-b', 'ใส่ a และ b', 'أدخل a و b')); return; }
    var m = BP.map(), p0 = BP._draw.pts[0];
    BP._draw.markers.forEach(function (mk) { m.removeLayer(mk); });
    BP._draw.markers = [];
    var p1 = destination(p0, rot, a);
    var p2 = destination(p1, (rot + 90) % 360, b);
    var p3 = destination(p0, (rot + 90) % 360, b);
    BP._draw.pts = [p0, p1, p2, p3];
    BP._draw.pts.forEach(function (pt) {
      BP._draw.markers.push(L.circleMarker(pt, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(m));
    });
    refreshMeasure(null);
  };

  function onDrawClick(e) {
    if (!BP._draw) return;
    // Same rule as the rectangle tool: the map stays navigable until the
    // user arms point placement. Otherwise the first click anywhere —
    // including one meant only to bring the area into view — is a corner.
    if (!BP._draw.armed) return;
    if (nearFirst(e.latlng)) { BP.finishFootprint(); return; }
    var m = BP.map();
    BP._draw.pts.push(e.latlng);
    BP._draw.markers.push(L.circleMarker(e.latlng, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(m));
    refreshMeasure(null);
  }

  function bannerReadout() {
    var el = document.getElementById('bpReadout');
    if (!el || !BP._draw) return;
    var n = BP._draw.pts.length, ar = BP._draw.area || 0, pe = BP._draw.per || 0;
    el.innerHTML =
      '<button onclick="BuildPlan.ptArm()" style="padding:5px 11px;border-radius:8px;border:none;' +
        'margin-inline-end:8px;font-family:inherit;font-weight:800;color:#fff;background:' +
        (BP._draw.armed ? '#2d6a4f' : 'rgba(255,255,255,.16)') + ';">\u2b20 ' +
        (BP._draw.armed ? BP.tt('מסמן\u2026', 'กำลังวาด', 'يرسم\u2026')
                     : BP.tt('התחל סימון', 'เริ่มวาด', 'ابدأ الرسم')) + '</button>' +
      '<span>' + (!BP._draw.armed
        ? BP.tt('גרור להזזת המפה', 'ลากเพื่อเลื่อนแผนที่', 'اسحب لتحريك الخريطة')
        : (BP._draw.snap
          ? '\ud83d\udfe2 ' + BP.tt('לחץ לסגירת המצולע', 'แตะเพื่อปิดรูป', 'انقر لإغلاق الشكل')
          : '\u2b20 ' + BP.tt('לחץ להוספת נקודה', 'แตะเพื่อเพิ่มจุด', 'انقر لإضافة نقطة'))) +
        ' (' + n + ')</span>' +
      (ar > 0
        ? '<span style="margin-inline-start:8px;background:rgba(255,209,102,.16);' +
          'border:1px solid rgba(255,209,102,.4);padding:3px 9px;border-radius:9px;color:#ffd166;">' +
          '\u25b1 ' + BP.n1(ar) + ' \u05de"\u05e8' +
          (ar >= 1000 ? ' (' + (ar/1000).toFixed(2) + ' \u05d3\u05d5\u05e0\u05dd)' : '') +
          ' \u00b7 \u21ba ' + BP.n1(pe) + ' m</span>'
        : '');
  }

  function banner(show) {
    var b = document.getElementById('bpBanner');
    if (!show) { if (b) b.remove(); return; }
    // Built once. Rebuilding this on every pointer move made typing a
    // rectangle dimension a race against the next mousemove — characters
    // were being dropped mid-entry.
    if (b) { bannerReadout(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'bpBanner';
      document.body.appendChild(b);
    }
    b.innerHTML =
      '<div style="position:fixed;top:0;inset-inline:0;z-index:10060;padding:10px 12px;' +
        'background:rgba(8,18,12,.96);color:#fff;display:flex;gap:8px;align-items:center;' +
        'justify-content:center;flex-wrap:wrap;font-weight:700;font-size:.86rem;">' +
        '<span id="bpReadout"></span>' +
        '<span style="display:inline-flex;gap:4px;align-items:center;background:rgba(255,255,255,.08);' +
          'padding:4px 8px;border-radius:9px;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + BP.tt('אורך', 'ยาว', 'طول') + '</span>' +
          '<input id="bpSegLen" type="number" step="0.1" placeholder="20" style="width:62px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);' +
            'color:#fff;font-family:inherit;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + BP.tt('פנייה°', 'มุม°', 'زاوية°') + '</span>' +
          '<input id="bpSegAng" type="number" step="1" value="90" style="width:56px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);' +
            'color:#fff;font-family:inherit;">' +
          '<button onclick="BuildPlan.addSegment()" style="padding:5px 10px;border-radius:8px;border:none;' +
            'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">+</button>' +
        '</span>' +
        '<span style="display:inline-flex;gap:4px;align-items:center;background:rgba(255,255,255,.08);' +
          'padding:4px 8px;border-radius:9px;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + BP.tt('מלבן', 'สี่เหลี่ยม', 'مستطيل') + '</span>' +
          '<input id="bpRectA" type="number" step="0.1" placeholder="a" style="width:52px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;">' +
          '<span style="opacity:.7;">\u00d7</span>' +
          '<input id="bpRectB" type="number" step="0.1" placeholder="b" style="width:52px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;">' +
          '<input id="bpRectR" type="number" step="1" value="0" title="' +
            BP.tt('סיבוב', 'หมุน', 'دوران') + '" style="width:48px;padding:4px;border-radius:6px;' +
            'border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;">' +
          '<button onclick="BuildPlan.exactRect()" style="padding:5px 10px;border-radius:8px;border:none;' +
            'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">\u25ad</button>' +
        '</span>' +
        '<button onclick="BuildPlan.undoPoint()" style="padding:7px 12px;border-radius:9px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-family:inherit;font-weight:700;">\u21a9</button>' +
        '<button onclick="BuildPlan.finishFootprint()" style="padding:7px 14px;border-radius:9px;border:none;' +
          'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">\u2713 ' +
          BP.tt('סיום', 'เสร็จ', 'إنهاء') + '</button>' +
        '<button onclick="BuildPlan.cancelFootprint()" style="padding:7px 12px;border-radius:9px;border:none;' +
          'background:rgba(255,71,87,.25);color:#fff;font-family:inherit;font-weight:700;">\u2715</button>' +
      '</div>';
    bannerReadout();
  }

  BP.ptArm = function ptArm() {
    if (!BP._draw) return;
    BP._draw.armed = !BP._draw.armed;
    banner(true);
  };

  BP.undoPoint = function undoPoint() {
    if (!BP._draw || !BP._draw.pts.length) return;
    BP.map().removeLayer(BP._draw.markers.pop());
    BP._draw.pts.pop();
    refreshMeasure(null);
  };

  function clearDraw() {
    var m = BP.map();
    if (BP._draw && m) {
      BP._draw.markers.forEach(function (mk) { m.removeLayer(mk); });
      (BP._draw.labels || []).forEach(function (l) { m.removeLayer(l); });
      if (BP._draw.line) m.removeLayer(BP._draw.line);
      m.off('click', onDrawClick);
      m.off('mousemove', onDrawMove);
    }
    BP._draw = null;
    banner(false);
    if (window.MapAccess) MapAccess.setExternalDraw(false);
  }

  BP.cancelFootprint = function cancelFootprint() {
    clearDraw();
    BP.loadAll().then(function () { BP.render(); });
  };

  BP.finishFootprint = function finishFootprint() {
    if (!BP._draw || BP._draw.pts.length < 3) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('צריך לפחות 3 נקודות', 'ต้องมีอย่างน้อย 3 จุด', 'ثلاث نقاط على الأقل'));
      return;
    }
    var id = BP._draw.id;
    var pts = BP._draw.pts.map(function (ll) { return { lat: ll.lat, lng: ll.lng }; });
    var area = (window.MapAccess && MapAccess.areaFromLatLngs)
      ? MapAccess.areaFromLatLngs(BP._draw.pts) : 0;
    clearDraw();
    var p = BP.projById(id);
    if (p) {
      p.footprint = pts;
      p.footprintArea = area;
      BP.saveP();
      BP.toast('\u2705 ' + BP.n1(area) + ' \u05de"\u05e8');
      BP.open(id);
    }
  };


})(BuildPlanInternals);
