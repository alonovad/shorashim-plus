/* buildplan-link.js — maintenance link, catalogue editor, outputs, work stages, boot
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
  //  MAINTENANCE LINK
  // ══════════════════════════════════════════════════════════════════
  // A shed is not a department of its own — it is a maintenance job that
  // happens to have a 3D model. The takeoff becomes the material lines of a
  // maintenance project, where markup, VAT, labour, shipping and invoicing
  // already work; buildplan does not reimplement any of that.
  BP.linkPanel = function linkPanel(p) {
    var host = document.getElementById('bpLink');
    if (!host || typeof Maintenance === 'undefined') return;
    Maintenance.loadProjects().then(function (list) {
      var opts = '<option value="">' + BP.tt('— בחר פרויקט תחזוקה —', '— เลือก —', '— اختر —') + '</option>';
      (list || []).forEach(function (mp) {
        opts += '<option value="' + mp.id + '"' + (p.maintId === mp.id ? ' selected' : '') + '>' +
          BP.esc(mp.name) + (mp.client ? ' \u00b7 ' + BP.esc(mp.client) : '') + '</option>';
      });
      var linked = p.maintId ? (list || []).filter(function (mp) { return mp.id === p.maintId; })[0] : null;
      host.innerHTML =
        (linked
          ? '<div class="bp-tot"><span>\ud83d\udd17 ' + BP.tt('מקושר ל', 'เชื่อมกับ', 'مرتبط بـ') +
            '</span><strong>' + BP.esc(linked.name) + '</strong></div>' +
            '<div class="bp-tot" style="border:none;"><span>' +
              BP.tt('שורות חומרים בפרויקט', 'รายการวัสดุ', 'بنود المواد') + '</span><strong>' +
              ((linked.materials || []).length) + '</strong></div>'
          : '<div style="font-size:.82rem;color:var(--text-muted,#999);margin-bottom:6px;">' +
            BP.tt('הפרויקט לא מקושר לפרויקט תחזוקה. הקישור מעביר את כתב הכמויות לתמחור, הזמנות וחשבוניות.',
               'ยังไม่เชื่อมกับโครงการซ่อมบำรุง', 'غير مرتبط بمشروع صيانة') + '</div>') +
        '<select class="bp-in" id="bpMaintSel" style="margin-bottom:6px;">' + opts + '</select>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button class="bp-btn" onclick="BuildPlan.pushToMaint(' + p.id + ')">\u2b06 ' +
            BP.tt('העבר כתב כמויות', 'ส่งรายการวัสดุ', 'إرسال الكميات') + '</button>' +
          '<button class="bp-btn ghost" onclick="BuildPlan.newMaint(' + p.id + ')">\u2795 ' +
            BP.tt('צור פרויקט תחזוקה', 'สร้างโครงการ', 'إنشاء مشروع') + '</button>' +
          (linked ? '<button class="bp-btn ghost" onclick="BuildPlan.openMaint(' + linked.id + ')">\ud83d\udd27 ' +
            BP.tt('פתח בתחזוקה', 'เปิด', 'فتح') + '</button>' : '') +
        '</div>';
    });
  };

  // A print-safe illustration to travel with the quantities: theme
  // variables resolved to literal colours, because the quote opens in a
  // window with none of the app's CSS.
  function illustrationFor(p) {
    var parts = [];
    if (p.hasStruct !== false && p.type !== 'slab') parts.push(BP.svg(p));
    else if (p.type === 'slab') parts.push(BP.svg(p));
    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (g) { parts.push(Gates.svg(g, { print: true })); });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      parts.push(LivingUnit.svg(p.living, { print: true }));
    }
    return parts.join('')
      .replace(/var\(--primary,#2d6a4f\)/g, '#2d6a4f')
      .replace(/var\(--accent,#ff9f43\)/g, '#e07b00')
      .replace(/var\(--water,#4fc3f7\)/g, '#1565c0')
      .replace(/var\(--text-muted,#[0-9a-f]+\)/g, '#777')
      .replace(/var\(--text,#[0-9a-f]+\)/g, '#222')
      .replace(/var\(--surface[a-z-]*,#[0-9a-f]+\)/g, '#fff');
  }

  function takeoffLines(p) {
    return BP.takeoff(p).map(function (r) {
      var pr = BP.profByName(r.name);
      return { name: r.name, qty: BP.n1(r.qty), unit: r.unit,
               price: pr ? pr.price : 0, note: r.note };
    });
  }

  function pushToMaint(id) {
    var p = BP.projById(id);
    var sel = document.getElementById('bpMaintSel');
    if (!p || !sel) return;
    var mid = Number(sel.value) || 0;
    if (!mid) { BP.toast('\u26a0\ufe0f ' + BP.tt('בחר פרויקט תחזוקה', 'เลือกโครงการ', 'اختر مشروعاً')); return; }
    if (typeof Maintenance === 'undefined') {
      BP.toast('\u26a0\ufe0f ' + BP.tt('מודול התחזוקה לא נטען', 'โมดูลไม่พร้อม', 'الوحدة غير محمّلة'));
      return;
    }
    Maintenance.importTakeoff(mid, p.id, p.name, takeoffLines(p), illustrationFor(p))
      .then(function (okd) {
      if (!okd) { BP.toast('\u26a0\ufe0f ' + BP.tt('הפרויקט לא נמצא', 'ไม่พบ', 'غير موجود')); return; }
      p.maintId = mid;
      var opt = sel.options[sel.selectedIndex];
      p.maintName = opt ? opt.text : '';
      BP.saveP();
      BP.toast('\u2705 ' + BP.tt('כתב הכמויות הועבר', 'ส่งแล้ว', 'تم الإرسال'));
      BP.linkPanel(p);
    });
  }

  function newMaint(id) {
    var p = BP.projById(id);
    if (!p || typeof Maintenance === 'undefined') return;
    Maintenance.createFromBuild(p.id, p.name, p.client, takeoffLines(p), illustrationFor(p))
      .then(function (mid) {
      p.maintId = mid;
      p.maintName = p.name;
      BP.saveP();
      BP.toast('\u2705 ' + BP.tt('נוצר פרויקט תחזוקה', 'สร้างแล้ว', 'تم الإنشاء'));
      BP.linkPanel(p);
    });
  }

  function openMaint(mid) {
    if (typeof Maintenance === 'undefined') return;
    BP.close();
    Maintenance.showDetail(mid);
  }

  function zoomTo(id) {
    var p = BP.projById(id), m = BP.map();
    if (!p || !m || p.footprint.length < 3) return;
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else BP.close();
    var ring = p.footprint.map(function (pt) { return [pt.lat, pt.lng]; });
    // After the tab switch Leaflet needs a beat to re-measure before the
    // bounds mean anything.
    setTimeout(function () {
      m.invalidateSize();
      // A 5x5 m slab would otherwise fit to the map's maximum, past the
      // level Esri publishes. Stop one below so the tiles are always real.
      m.fitBounds(ring, { padding: [40, 40], maxZoom: 18 });
    }, 80);
    // A brief pulse: after a zoom the eye needs telling which of several
    // orange outlines is the one that was just asked for.
    var hl = L.polygon(ring, { color: '#2ecc71', weight: 4, fill: false }).addTo(m);
    hl.bringToFront();
    var n = 0;
    var iv = setInterval(function () {
      n++;
      hl.setStyle({ opacity: n % 2 ? 0.15 : 1 });
      if (n > 5) { clearInterval(iv); m.removeLayer(hl); }
    }, 320);
  }

  // Fit the typed rectangle to the traced area, keeping the current
  // proportion — a first guess at dimensions from real ground.
  function useFootprint(id) {
    var p = BP.projById(id);
    if (!p || !(p.footprintArea > 0)) return;
    var ratio = p.dims.length / Math.max(p.dims.span, 0.01);
    p.dims.span = Math.sqrt(p.footprintArea / ratio);
    p.dims.length = p.dims.span * ratio;
    BP.saveP();
    BP.toast('\u2705 ' + BP.n1(p.dims.span) + ' \u00d7 ' + BP.n1(p.dims.length) + ' m');
    BP.open(id);
  }

  function _set(id, k, v) { var p = BP.projById(id); if (p) p[k] = v; }

  // Component inclusion changes what the whole takeoff means, so it saves
  // and repaints rather than being nudged in place.
  function _comp(id, k, v) {
    var p = BP.projById(id);
    if (!p) return;
    p[k] = !!v;
    BP.saveP();
    BP.open(id);
  }
  var BOOL = { walls: 1, gutter: 1, footings: 1, fence: 1,
               haunch: 1, taper: 1, bracing: 1, door: 1,
               mapGround: 1, callouts: 1, shadows: 1, dims: 1 };
  var TEXT = { roofType: 1, wallMode: 1, roofClad: 1, wallClad: 1, rafterType: 1, scaleRef: 1,
               colProfile: 1, rafterProfile: 1, purlinProfile: 1, girtProfile: 1,
               roofClad: 1, wallClad: 1 };
  // Numbers only nudge the model, so the viewer is updated in place and the
  // sheet is left alone — a full repaint on every slider tick would rebuild
  // the canvas 60 times a second and lose the camera angle mid-drag.
  var _num = null;

  // Drag: update the model and the derived readouts only. No repaint, so
  // focus, scroll position and the camera all survive, and the slider keeps
  // up with the pointer.
  function _live(id, k, v) {
    var p = BP.projById(id);
    if (!p) return;
    p.dims[k] = Number(v) || 0;
    var nEl = document.getElementById('n_' + k), rEl = document.getElementById('r_' + k),
        vEl = document.getElementById('v_' + k);
    if (nEl && nEl.value !== String(v)) nEl.value = v;
    if (rEl && rEl.value !== String(v)) rEl.value = v;
    if (vEl) vEl.textContent = v;
    if (BP._v3d) BP._v3d.nudge(BP.model3d(p));
    BP.refreshReadouts(p);
    // The legend carries quantities straight off the takeoff, so leaving it
    // out of the live update let the model and the legend disagree while a
    // slider was moving — the 3D showing one pitch and the item list the
    // previous one, in the same view.
    BP.legendPanel(p);
    // Persist on a trailing timer, independent of the `change` event.
    if (_liveSave) clearTimeout(_liveSave);
    _liveSave = setTimeout(function () { BP.saveP(); }, 700);
  }
  var _liveSave = null;

  // Release: persist, and repaint once so anything structural (new controls
  // appearing, the takeoff, the callouts) catches up.
  // Releasing a slider used to repaint the entire sheet, which tore down and
  // rebuilt the canvas — that flash IS the jump. A number never changes
  // which controls exist, so nothing needs re-rendering: save it, and patch
  // the handful of places that display derived values.
  function _commit(id, k, v) {
    var p = BP.projById(id);
    if (!p) return;
    p.dims[k] = Number(v) || 0;
    if (_liveSave) { clearTimeout(_liveSave); _liveSave = null; }
    BP.saveP();
    refreshDerived(p);
  }

  // Everything on the design tab that is computed rather than typed.
  // Updated in place so the DOM the user is touching is never replaced.
  function refreshDerived(p) {
    BP.refreshReadouts(p);
    BP.legendPanel(p);
    if (BP._v3d) {
      var g = BP._v3d.isHidden ? null : null;
      void g;
    }
    // the bay-fit warning
    var warn = document.getElementById('bpBayWarn');
    if (warn && p.type !== 'slab') {
      var gg = BP.geom(p.dims);
      warn.innerHTML = (Math.abs(gg.actualBay - p.dims.bay) > 0.05)
        ? '\u26a0\ufe0f ' + BP.tt('המרווח הותאם ל-', 'ปรับระยะเป็น ', 'تم ضبط التباعد إلى ') +
          BP.n1(gg.actualBay) + ' m ' +
          BP.tt('כדי לחלק את האורך שווה בשווה', 'เพื่อแบ่งเท่ากัน', 'لتقسيم متساوٍ')
        : '';
    }
    // the foundation summary
    var fo = document.getElementById('bpFound');
    if (fo && p.type !== 'slab') fo.innerHTML = BP.footingSummary(p);
    // utilisation in an open swap panel
    if (BP._v3d && BP._swapRole) BP.swapPanel(BP._swapRole);
  }

  BP.footingSummary = function footingSummary(p) {
    var d = p.dims, ft = BP.footing(d), con = BP.concrete(p);
    return '<div class="bp-tot"><span>' +
        BP.tt('שטח משפיע לעמוד', 'พื้นที่รับต่อเสา', 'المساحة لكل عمود') + '</span><strong>' +
        BP.n1(ft.trib) + ' \u05de"\u05e8 \u00b7 ' + BP.n1(ft.axial) + ' kN</strong></div>' +
      '<div class="bp-tot"><span>' + BP.tt('צלע נדרשת', 'ด้านที่ต้องการ', 'الضلع المطلوب') +
        '</span><strong style="color:' + (ft.ok ? 'var(--primary,#2d6a4f)' : '#e65100') + ';">' +
        BP.n2(ft.reqSide) + ' \u05de\' ' + (ft.ok ? '\u2713' : '\u2014 ' +
        BP.tt('הגדל ל-', 'เพิ่มเป็น', 'زد إلى') + ' ' + ft.suggest) + '</strong></div>' +
      '<div class="bp-tot" style="border:none;"><span>' + BP.tt('בטון', 'คอนกรีต', 'خرسانة') +
        '</span><strong>' + BP.n2(con.slab) + ' + ' + BP.n2(con.footings) + ' = ' +
        BP.n2(con.total) + ' \u05de"\u05e7</strong></div>';
  };

  // The numbers that answer "did the rafter actually get longer when I
  // widened the span". Written straight into the DOM on every drag frame.
  BP.refreshReadouts = function refreshReadouts(p) {
    var host = document.getElementById('bpRead');
    if (!host) return;
    var d = p.dims;
    if (p.type === 'slab') {
      var a = BP.slabArea(p);
      host.innerHTML =
        row(BP.tt('שטח', 'พื้นที่', 'المساحة'), BP.n1(a) + ' \u05de"\u05e8') +
        row(BP.tt('בטון', 'คอนกรีต', 'خرسانة'), BP.n2(a*d.slabTh) + ' \u05de"\u05e7');
      return;
    }
    var g = BP.geom(d), ft = BP.footing(d), con = BP.concrete(p);
    var rows = BP.takeoff(p), tot = BP.takeoffTotals(rows);
    host.innerHTML =
      row(BP.tt('אורך קורת גג', 'ความยาวคาน', 'طول الرافدة'), BP.n2(g.rafterLen) + ' m') +
      row(BP.tt('גובה רכס', 'สูงสัน', 'ارتفاع القمة'), BP.n2(g.ridgeH) + ' m') +
      row(BP.tt('מסגרות', 'เฟรม', 'إطارات'), g.frames + ' @ ' + BP.n2(g.actualBay) + ' m') +
      row(BP.tt('עמוד יחיד', 'เสาเดี่ยว', 'عمود واحد'), BP.n2(d.eaves) + ' m \u00d7 ' + (g.frames*2)) +
      row(BP.tt('שורות מרישים', 'แถวแป', 'صفوف المرايش'), (g.purlinRuns*2) + ' \u00d7 ' + BP.n1(d.length) + ' m') +
      row(BP.tt('שטח גג', 'พื้นที่หลังคา', 'مساحة السقف'), BP.n1(g.roofArea) + ' \u05de"\u05e8') +
      row(BP.tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد'), BP.n2(tot.kg/1000) + ' ' + BP.tt('טון','ตัน','طن')) +
      row(BP.tt('בטון כולל', 'คอนกรีตรวม', 'إجمالي الخرسانة'), BP.n2(con.total) + ' \u05de"\u05e7') +
      row(BP.tt('צלע בסיס נדרשת', 'ด้านฐาน', 'ضلع القاعدة'),
        BP.n2(ft.reqSide) + ' m ' + (ft.ok ? '\u2713' : '\u26a0\ufe0f')) +
      row(BP.tt('עלות חומרים', 'ต้นทุน', 'التكلفة'), BP.money(tot.cost));
  };
  function row(k, v) {
    return '<div class="bp-read"><span>' + k + '</span><b>' + v + '</b></div>';
  }


  function _dim(id, k, v) {
    var p = BP.projById(id);
    if (!p) return;
    p.dims[k] = BOOL[k] ? !!v : TEXT[k] ? String(v) : (Number(v) || 0);
    var TOPO = { skylights: 1, leanTo: 1, mezz: 1 };
    if (BOOL[k] || TEXT[k] || TOPO[k]) { BP.saveP(); BP.open(id); return; }
    if (BP._v3d) BP._v3d.update(BP.model3d(p));
    // Numbers still have to reach the readouts, but only once the user
    // pauses — otherwise every keystroke rewrites the DOM under the cursor.
    if (_num) clearTimeout(_num);
    _num = setTimeout(function () { BP.saveP(); BP.open(id); }, 550);
  }
  function saveNow() {
    BP.saveP();
    BP.toast('\u2705 ' + BP.tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ'));
  }

  // ── catalogue ──
  BP.openCatalog = function openCatalog() {
    BP._view = 'catalog';
    var groups = {};
    (BP.C.profiles || []).forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
    var body = '';
    Object.keys(groups).forEach(function (g) {
      var rows = '';
      groups[g].forEach(function (x) {
        rows += '<div style="display:grid;grid-template-columns:1.6fr .7fr .6fr .8fr 32px;gap:5px;margin-bottom:5px;">' +
          '<input class="bp-in" value="' + BP.esc(x.name) + '" ' +
            'oninput="BuildPlan._prof(' + x.id + ',\'name\',this.value)">' +
          '<input class="bp-in" type="number" step="any" value="' + (x.kgPerM || '') + '" ' +
            'placeholder="kg/m" oninput="BuildPlan._prof(' + x.id + ',\'kgPerM\',this.value)">' +
          '<input class="bp-in" value="' + BP.esc(x.unit) + '" ' +
            'oninput="BuildPlan._prof(' + x.id + ',\'unit\',this.value)">' +
          '<input class="bp-in" type="number" step="any" value="' + (x.price || '') + '" ' +
            'placeholder="\u20aa" oninput="BuildPlan._prof(' + x.id + ',\'price\',this.value)">' +
          '<button class="bp-btn warn" style="padding:5px 7px;" ' +
            'onclick="BuildPlan._delProf(' + x.id + ')">\u2715</button></div>';
      });
      body += '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:6px;">' + BP.esc(BP.dsp(g)) +
        '</div>' + rows +
        '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.78rem;" ' +
          'onclick="BuildPlan._addProf(\'' + BP.esc(g) + '\')">\u2795</button></div>';
    });
    var bar = '<button class="bp-btn" onclick="BuildPlan._saveCat()">\ud83d\udcbe ' +
        BP.tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        BP.tt('חזרה', 'กลับ', 'رجوع') + '</button>';
    BP.paint(BP.shell('\ud83d\udcd0 ' + BP.tt('קטלוג פרופילים', 'แคตตาล็อกโปรไฟล์', 'كتالوج المقاطع'),
      bar, priceHeader() + body));
  };
  // Mutate only. Repainting here would replace the input being typed into;
  // the explicit שמור button writes, and the listener guard below stops our
  // own write bouncing back as a repaint.
  function _prof(pid, k, v) {
    (BP.C.profiles || []).forEach(function (x) {
      if (x.id === pid) x[k] = (k === 'kgPerM' || k === 'price') ? (Number(v) || 0) : v;
    });
  }
  function _addProf(g) {
    BP.C.profiles.push({ id: BP.uid() + Math.random(), group: g, name: '', kgPerM: 0, unit: "מ'", price: 0 });
    BP.openCatalog();
  }
  function _delProf(pid) {
    BP.C.profiles = (BP.C.profiles || []).filter(function (x) { return x.id !== pid; });
    BP.saveC();
    BP.openCatalog();
  }
  // Steel is sold by weight, not by the metre. Every merchant quotes a
  // shekels-per-kilo figure and the section price follows from kg/m, so
  // keeping the catalogue current is one number rather than seventeen.
  // There is no public price feed for Israeli steel — the pages that look
  // like one are generated content quoting different figures for the same
  // section on sibling pages — so this stays a number you set from a real
  // quote, with the sources listed next to it.
  function applySteelPrice() {
    var v = Number((document.getElementById('bpKgPrice') || {}).value);
    if (!(v > 0)) { BP.toast('\u26a0\ufe0f ' + BP.tt('הזן מחיר לק"ג', 'ใส่ราคา/กก.', 'أدخل السعر/كغ')); return; }
    var n = 0;
    (BP.C.profiles || []).forEach(function (pr) {
      if (pr.kgPerM > 0 && pr.unit === "מ'") { pr.price = Math.round(pr.kgPerM * v * 100) / 100; n++; }
    });
    BP.C.steelPerKg = v;
    BP.C.pricedAt = Date.now();
    BP.saveC();
    BP.toast('\u2705 ' + n + ' ' + BP.tt('פרופילים תומחרו', 'โปรไฟล์ตั้งราคาแล้ว', 'مقاطع تم تسعيرها'));
    BP.openCatalog();
  }

  function priceHeader() {
    var when = BP.C.pricedAt ? new Date(BP.C.pricedAt).toLocaleDateString('he-IL') : '\u2014';
    return '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\u2696\ufe0f ' +
        BP.tt('תמחור פלדה לפי משקל', 'ราคาเหล็กตามน้ำหนัก', 'تسعير الحديد بالوزن') + '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
        '<input class="bp-in" id="bpKgPrice" type="number" step="0.1" style="width:110px;" ' +
          'value="' + (BP.C.steelPerKg || '') + '" placeholder="\u20aa/kg">' +
        '<button class="bp-btn" onclick="BuildPlan.applySteelPrice()">' +
          BP.tt('עדכן את כל הפרופילים', 'อัปเดตทั้งหมด', 'تحديث الكل') + '</button>' +
        '<span style="font-size:.74rem;color:var(--text-muted,#888);">' +
          BP.tt('עודכן', 'อัปเดต', 'حُدّث') + ': ' + when + '</span>' +
      '</div>' +
      '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:8px;line-height:1.6;">' +
        BP.tt('אין הזנת מחירים אוטומטית לפלדה בישראל — האתרים שנראים כמו מחירון הם תוכן שיווקי שמצטט מחירים סותרים. עדכנו מהצעת מחיר אמיתית. מקורות שימושיים:',
           'ไม่มีฟีดราคาอัตโนมัติ อัปเดตจากใบเสนอราคาจริง',
           'لا توجد تغذية أسعار تلقائية — حدّث من عرض سعر حقيقي') + '<br>' +
        '<a href="https://www.saf.co.il/sal/list.php?t=24" target="_blank" rel="noopener" ' +
          'style="color:var(--accent,#ff9f43);">saf.co.il</a> \u00b7 ' +
        '<a href="https://panel-hashomron.co.il/%D7%9E%D7%95%D7%A6%D7%A8%D7%99%D7%9D/" target="_blank" ' +
          'rel="noopener" style="color:var(--accent,#ff9f43);">panel-hashomron.co.il</a> \u00b7 ' +
        '<a href="https://marzevit.co.il/product-category/%D7%9E%D7%95%D7%A6%D7%A8%D7%99-%D7%91%D7%A0%D7%99%D7%94-%D7%A7%D7%9C%D7%94/k-panelim/" ' +
          'target="_blank" rel="noopener" style="color:var(--accent,#ff9f43);">marzevit.co.il</a> \u00b7 ' +
        '<a href="https://www.biad.co.il/ipn" target="_blank" rel="noopener" ' +
          'style="color:var(--accent,#ff9f43);">biad.co.il</a>' +
      '</div></div>';
  }

  function _saveCat() {
    BP.saveC();
    BP.toast('\u2705 ' + BP.tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ'));
    BP.openCatalog();
  }

  // ── outputs ──
  // Read-only feeds for maintenance, so the pull direction does not require
  // maintenance to know anything about how a build project is stored.
  function listForImport() {
    return BP.loadAll().then(function () {
      return (BP.P.projects || []).map(function (p) {
        var rows = BP.takeoff(p), tot = BP.takeoffTotals(rows);
        return { id: p.id, name: p.name || BP.typeLabel(p.type),
                 lines: rows.length, cost: tot.cost };
      });
    });
  }

  function exportForQuote(id) {
    return BP.loadAll().then(function () {
      var p = BP.projById(id);
      if (!p) return null;
      return { id: p.id, name: p.name || BP.typeLabel(p.type), client: p.client || '',
               lines: takeoffLines(p), illustration: illustrationFor(p) };
    });
  }

  function toOrder(id) {
    var p = BP.projById(id);
    if (!p) return;
    if (typeof Orders === 'undefined') {
      BP.toast('\u26a0\ufe0f ' + BP.tt('מודול ההזמנות לא נטען', 'โมดูลไม่พร้อม', 'الوحدة غير محمّلة'));
      return;
    }
    BP.saveP();
    Orders.draftFrom({
      title: (p.name || BP.typeLabel(p.type)),
      source: 'buildplan',
      ref: BP.tt('פרויקט', 'โครงการ', 'مشروع') + ' #' + p.id,
      lines: BP.takeoff(p).map(function (r) {
        return { name: r.name, qty: BP.n1(r.qty), unit: r.unit, note: r.note };
      })
    });
  }

  // ── work stages ──────────────────────────────────────────────────────
  // The sheet that goes to whoever is actually building it. Ordered by
  // dependency, not by trade — the mistakes that cost money on these jobs
  // are sequencing mistakes: pouring before the sleeves are in, tiling
  // before the waterproofing, hanging a leaf before the posts have cured.
  function workStages(p) {
    var st = [];
    var d = p.dims;

    // Parenthesised: `A && B || C` would have let the second branch run
    // with the slab switched off.
    if (p.hasSlab !== false &&
        (p.type === 'slab' || (p.footprintArea > 0 && p.type !== 'shed'))) {
      st.push([BP.tt('עבודות עפר ומצע', 'งานดินและฐาน', 'أعمال الحفر والأساس'),
        BP.tt('חישוף, פילוס, מצע מהודק בשכבות 20 ס"מ. בדיקת ניקוז — משטח שאוסף מים ייסדק.',
           'ปรับพื้นและบดอัด', 'تسوية ودك')]);
      st.push([BP.tt('יציקת משטח', 'เทพื้น', 'صب السطح'),
        BP.tt('רשת מרותכת על ספסרים, עובי ' + BP.n1(d.slabTh) + ' מ\'. תפרי התפשטות כל 5-6 מ\'. ' +
           'אשפרה 7 ימים לפחות.', 'เทพื้นและบ่ม', 'الصب والمعالجة')]);
    }

    // Gate on the COMPONENT, not on p.type. p.type only says what shape a
    // structure would be if there were one — it stays 'shed' on a project
    // that contains nothing but a gate, which is why a gate document was
    // printing "erect 5 frames" and "install the panel roof".
    if (p.hasStruct !== false && (p.type === 'shed' || p.type === 'house')) {
      var g = BP.geom(d), ft = BP.footing(d);
      st.push([BP.tt('סימון ויסודות', 'ทำเครื่องหมายและฐานราก', 'التخطيط والأساسات'),
        BP.tt('סימון ' + g.frames + ' מסגרות במרווח ' + BP.n1(g.actualBay) + ' מ\'. ' +
           (d.footings ? 'חפירת ' + (g.frames*2) + ' בסיסים ' + BP.n1(d.footW) + '\u00d7' +
             BP.n1(d.footW) + '\u00d7' + BP.n1(d.footD) + ' מ\'. ' : '') +
           'לוודא אלכסונים שווים לפני היציקה — מסגרת לא מרובעת לא תתאסף.',
           'ตรวจสอบมุมฉาก', 'التأكد من التعامد')]);
      st.push([BP.tt('עוגנים ויציקה', 'สมอและเท', 'المراسي والصب'),
        BP.tt('בורגי עיגון בתבנית לפי פלטת הבסיס, לא לאחר היציקה. אשפרה 7 ימים לפני העמסת שלד.',
           'สมอก่อนเท', 'المراسي قبل الصب')]);
      st.push([BP.tt('הקמת שלד', 'ประกอบโครง', 'تركيب الهيكل'),
        BP.tt('הרכבת מסגרות, ' + (d.bracing ? 'אלכסוני ייצוב בשתי מפתחות הקצה, ' : '') +
           'מרישים ומסילות. יישור וחיזוק סופי לפני החיפוי.',
           'ประกอบและปรับ', 'التركيب والضبط')]);
      if (d.roofClad !== 'none') {
        st.push([BP.tt('חיפוי גג', 'มุงหลังคา', 'تغطية السقف'),
          BP.tt('התקנת ' + BP.dsp(d.roofClad) + ' מהצד המוגן מהרוח כלפי הרוח, חפיפה לפי היצרן. ' +
             (d.gutter ? 'מרזבים וניקוז לפני הקירות.' : ''),
             'มุงตามทิศลม', 'التغطية حسب اتجاه الريح')]);
      }
      if (d.wallMode !== 'open' && d.wallClad !== 'none') {
        st.push([BP.tt('חיפוי קירות', 'ติดผนัง', 'تغطية الجدران'),
          BP.tt('התקנת ' + BP.dsp(d.wallClad) + ', פתחים לחלונות ולשער לפי התוכנית.',
             'ติดตั้งผนัง', 'تركيب الجدران')]);
      }
    }

    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (gt, i) {
        Gates.stages(gt).forEach(function (row) {
          st.push([(gt.name || (BP.tt('שער','ประตู','بوابة') + ' ' + (i+1))) + ' \u00b7 ' + row[0], row[1]]);
        });
      });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      LivingUnit.stages(p.living).forEach(function (row) {
        st.push([BP.tt('מגורים','ที่พัก','سكن') + ' \u00b7 ' + row[0], row[1]]);
      });
    }

    if (!st.length) return '';
    var rows = st.map(function (r, i) {
      return '<tr><td style="width:26px;text-align:center;font-weight:800;">' + (i+1) + '</td>' +
        '<td style="width:210px;font-weight:700;">' + BP.esc(r[0]) + '</td>' +
        '<td>' + BP.esc(r[1]) + '</td>' +
        '<td style="width:70px;"></td></tr>';
    }).join('');

    return '<div style="page-break-before:always;"></div>' +
      '<h2>\ud83d\udccb ' + BP.tt('שלבי עבודה והכנות', 'ขั้นตอนงาน', 'مراحل العمل') + '</h2>' +
      '<p style="font-size:.8rem;color:#555;">' +
        BP.tt('הסדר הוא סדר תלות, לא סדר מקצועות. רוב התקלות היקרות בעבודות האלה הן תקלות רצף.',
           'ลำดับตามการพึ่งพา', 'الترتيب حسب التبعية') + '</p>' +
      '<table><thead><tr><th>#</th><th>' + BP.tt('שלב', 'ขั้นตอน', 'المرحلة') + '</th><th>' +
        BP.tt('הכנות ודגשים', 'การเตรียมและข้อควรระวัง', 'التحضير والملاحظات') + '</th><th>' +
        BP.tt('בוצע', 'เสร็จ', 'تم') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // Print colours hardcoded — the sheet opens in a bare tab with no theme.
  // What this document is about, in the project's own terms. Printing
  // "סככה / מבנה קל · 10 × 20 m, 5 מסגרות" at the top of a gate document
  // is the header contradicting every page under it.
  function contentsLabel(p) {
    var parts = [];
    if (p.hasStruct !== false && p.type !== 'slab') parts.push(BP.typeLabel(p.type));
    if (p.type === 'slab' || (p.hasSlab !== false && p.hasStruct === false)) {
      parts.push(BP.tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني'));
    }
    if ((p.gates || []).length) {
      parts.push((p.gates.length > 1 ? p.gates.length + ' ' : '') +
        BP.tt('שערים', 'ประตู', 'بوابات'));
    }
    if (p.living && p.living.people) {
      parts.push(BP.tt('מתחם מגורים', 'ที่พัก', 'مجمع سكني') + ' ' + p.living.people);
    }
    return parts.length ? parts.join(' + ') : BP.typeLabel(p.type);
  }

  // opts.stages === false prints the quantities alone. The work-stages
  // sheet is for whoever is building it; a supplier pricing the steel does
  // not need to be told when to pour, and sending it invites questions
  // about scope that have nothing to do with the price.
  function printProject(id, opts) {
    opts = opts || {};
    var p = BP.projById(id);
    if (!p) return;
    var rows = BP.takeoff(p), tot = BP.takeoffTotals(rows);
    var g = (p.type === 'slab' || p.hasStruct === false) ? null : BP.geom(p.dims);
    var body = '';
    rows.forEach(function (r, i) {
      var pr = BP.profByName(r.name);
      body += '<tr><td>' + (i + 1) + '</td><td>' + BP.esc(BP.dsp(r.name)) + '</td><td>' + BP.n1(r.qty) +
        '</td><td>' + BP.esc(BP.dsp(r.unit)) + '</td><td>' + (r.kg ? BP.n1(r.kg) : '\u2014') + '</td>' +
        '<td>' + (pr && pr.price ? BP.money(pr.price) : '\u2014') + '</td>' +
        '<td>' + (pr && pr.price ? BP.money(r.qty * pr.price) : '\u2014') + '</td>' +
        '<td>' + BP.esc(r.note) + '</td></tr>';
    });
    // Component drawings, printed at the size they are read at. A bill of
    // quantities without a drawing is a list of numbers nobody can check.
    var extra = '';
    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (g, i) {
        extra += '<h2>\ud83d\udea7 ' + BP.esc(g.name || (BP.tt('שער','ประตู','بوابة') + ' ' + (i+1))) +
          ' \u2014 ' + BP.esc(Gates.typeLabel(g.type)) + '</h2>' +
          '<div class="bp-draw">' + Gates.svg(g, { print: true }) + '</div>';
      });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      extra += '<h2>\ud83c\udfe0 ' + BP.tt('מתחם מגורים', 'ที่พัก', 'مجمع سكني') + ' \u2014 ' +
        p.living.people + ' ' + BP.tt('אנשים', 'คน', 'أشخاص') + '</h2>' +
        '<div class="bp-draw">' + LivingUnit.svg(p.living, { print: true }) + '</div>';
    }

    // Only draw the structure if there is one. A gate-only project was
    // leading its document with a 20x10 shed elevation and plan.
    var drawing = (p.hasStruct === false && p.type !== 'slab') ? '' : BP.svg(p)
      .replace(/var\(--primary,#2d6a4f\)/g, '#2d6a4f')
      .replace(/var\(--accent,#ff9f43\)/g, '#e07b00')
      .replace(/var\(--water,#4fc3f7\)/g, '#1565c0')
      .replace(/var\(--text-muted,#[0-9a-f]+\)/g, '#777')
      .replace(/var\(--text,#[0-9a-f]+\)/g, '#222');

    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + BP.esc(p.name) + '</title><style>' +
      'body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#222;background:#fff;padding:22px;}' +
      'h1{font-size:1.25rem;margin:0 0 4px;}h2{font-size:1rem;margin:16px 0 6px;}' +
      '.meta{font-size:.84rem;color:#555;line-height:1.7;}' +
      '.bp-draw{background:#f4f6f4;border:1px solid #ddd;border-radius:8px;padding:10px;margin:10px 0;}' +
      'table{width:100%;border-collapse:collapse;margin-top:8px;}' +
      'th,td{border:1px solid #bbb;padding:5px 7px;font-size:.78rem;text-align:right;}' +
      'th{background:#eef3ee;font-weight:800;}tfoot td{font-weight:800;background:#f7f9f7;}' +
      '</style></head><body>' +
      '<h1>' + BP.esc(p.name || BP.typeLabel(p.type)) + '</h1>' +
      '<div class="meta">' + contentsLabel(p) +
        (p.client ? ' \u00b7 ' + BP.esc(p.client) : '') +
        (g ? '<br>' + BP.n1(p.dims.span) + ' \u00d7 ' + BP.n1(p.dims.length) + ' m, ' +
             BP.tt('גובה', 'สูง', 'ارتفاع') + ' ' + BP.n1(p.dims.eaves) + ' m, ' +
             BP.tt('שיפוע', 'ชัน', 'ميل') + ' ' + BP.n1(p.dims.pitch) + '\u00b0, ' +
             g.frames + ' ' + BP.tt('מסגרות', 'เฟรม', 'إطارات') + ' @ ' + BP.n1(g.actualBay) + ' m'
           : '<br>' + BP.n1(BP.slabArea(p)) + ' \u05de"\u05e8 \u00d7 ' + p.dims.slabTh + ' \u05de\'') +
        (p.footprintArea > 0 ? '<br>' + BP.tt('שטח מסומן במפה', 'พื้นที่จากแผนที่', 'المساحة المرسومة') +
          ': ' + BP.n1(p.footprintArea) + ' \u05de"\u05e8' : '') +
      '</div>' + drawing +
      extra +
      '<h2>' + BP.tt('כתב כמויות', 'รายการวัสดุ', 'جدول الكميات') + '</h2>' +
      '<table><thead><tr><th>#</th><th>' + BP.tt('פריט', 'รายการ', 'صنف') + '</th><th>' +
        BP.tt('כמות', 'จำนวน', 'كمية') + '</th><th>' + BP.tt('יחידה', 'หน่วย', 'وحدة') + '</th><th>' +
        BP.tt('משקל', 'น้ำหนัก', 'وزن') + '</th><th>' + BP.tt('מחיר', 'ราคา', 'سعر') + '</th><th>' +
        BP.tt('סה"כ', 'รวม', 'مجموع') + '</th><th>' + BP.tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</th></tr></thead>' +
      '<tbody>' + body + '</tbody><tfoot><tr><td colspan="4">' +
        BP.tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد') + '</td><td>' + BP.n1(tot.kg) + ' kg</td>' +
        '<td>' + BP.tt('סה"כ', 'รวม', 'مجموع') + '</td><td colspan="2">' + BP.money(tot.cost) +
        '</td></tr></tfoot></table>' +
      (opts.stages === false ? '' : workStages(p)) +
      '<p style="margin-top:20px;font-size:.8rem;">\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD</p>' +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, (p.name || 'project').replace(/\s+/g, '_') +
        (opts.stages === false ? '_' + BP.tt('כתב_כמויות', 'รายการวัสดุ', 'الكميات') : '') + '.html');
    }
  }

  // Footprints should be visible on the map without opening the module.
  // Login happens well after load, so this waits for a manager session and
  // a live map instead of testing once and giving up.
  var _booted = false;
  function boot() {
    if (_booted) return true;
    if (!BP.isManager()) return false;
    if (!(window.MapAccess && MapAccess.getMap && MapAccess.getMap())) return false;
    if (!window.L) return false;
    _booted = true;
    BP.loadAll().then(function () { BP.listen(); BP.drawFootprints(); }).catch(function () {});
    return true;
  }

  function watchForSession() {
    if (boot()) return;
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (boot() || tries > 120) clearInterval(iv);   // give up after ~4 min
    }, 2000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(watchForSession, 1200); });
  } else {
    setTimeout(watchForSession, 1200);
  }

  // Re-assert the layer after a login or a tab switch repaints the map.
  window.addEventListener('focus', function () { if (_booted) BP.drawFootprints(); });

  
  // ── public API (was the IIFE return value) ──
  var API = {
    open: BP.openModule,
    openProject: BP.open,
    card: BP.card,
    pushToMaint: pushToMaint,
    newMaint: newMaint,
    openMaint: openMaint,
    backToMaint: function () { BP.close(); if (typeof Maintenance !== 'undefined') Maintenance.showProjectsList(); },
    close: BP.close,
    render: BP.render,
    newProject: BP.newProject,
    delProject: BP.delProject,
    setTab: BP.setTab,
    _comp: _comp,
    _live: _live,
    _commit: _commit,
    toggleLayer: BP.toggleLayer,
    pickMember: BP.pickMember,
    addGate: BP.addGate, delGate: BP.delGate, setGate: BP.setGate,
    addLiving: BP.addLiving, delLiving: BP.delLiving, setLiving: BP.setLiving,
    skTool: BP.skTool, skOrtho: BP.skOrtho, skUndo: BP.skUndo, skRedo: BP.skRedo,
    skFit: BP.skFit, skDel: BP.skDel, skScale: BP.skScale, skRotate: BP.skRotate,
    skSeg: BP.skSeg, skRadius: BP.skRadius,
    swapTo: BP.swapTo,
    closeSwap: BP.closeSwap,
    checkMember: BP.checkMember,
    layersAll: BP.layersAll,
    layersFrame: BP.layersFrame,
    applyModel: BP.applyModel,
    view3d: BP.view3d,
    resetView: BP.resetView,
    sun: BP.sun,
    openCatalog: BP.openCatalog,
    startFootprint: BP.startFootprint,
    startRect: BP.startRect,
    placeFromDims: BP.placeFromDims,
    dimsFromRect: BP.dimsFromRect,
    geApply: BP.geApply,
    geRot: BP.geRot,
    geRedraw: BP.geRedraw,
    geArm: BP.geArm,
    geSave: BP.geSave,
    geCancel: BP.geCancel,
    finishFootprint: BP.finishFootprint,
    cancelFootprint: BP.cancelFootprint,
    undoPoint: BP.undoPoint,
    ptArm: BP.ptArm,
    addSegment: BP.addSegment,
    exactRect: BP.exactRect,
    zoomTo: zoomTo,
    useFootprint: useFootprint,
    printProject: printProject,
    printQuantities: function (id) { printProject(id, { stages: false }); },
    toOrder: toOrder,
    listForImport: listForImport,
    exportForQuote: exportForQuote,
    saveNow: saveNow,
    takeoff: BP.takeoff,
    geom: BP.geom,
    _set: _set,
    _comp: _comp,
    _dim: _dim,
    _prof: _prof,
    _addProf: _addProf,
    _delProf: _delProf,
    _saveCat: _saveCat,
    applySteelPrice: applySteelPrice
  };
  Object.keys(API).forEach(function (k) { BuildPlan[k] = API[k]; });

})(BuildPlanInternals);
