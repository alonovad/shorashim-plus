/* buildplan-geom.js — portal-frame geometry and material takeoff
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
  //  GEOMETRY + TAKEOFF
  // ══════════════════════════════════════════════════════════════════
  BP.geom = function geom(d) {
    var half = d.span / 2;
    var rise = half * Math.tan(d.pitch * Math.PI / 180);
    var rafterLen = Math.sqrt(half * half + rise * rise);
    // Bays are made to fit the length rather than left with a remainder —
    // a fabricator spaces frames evenly, so the actual spacing is derived
    // back from the frame count and shown to the user.
    var bays = Math.max(1, Math.round(d.length / d.bay));
    var actualBay = d.length / bays;
    var frames = bays + 1;
    var purlinRuns = Math.ceil(rafterLen / d.purlinSp) + 1;   // per slope
    var girtRows = Math.max(0, Math.ceil(d.eaves / d.girtSp) - 1);
    var roofArea = 2 * rafterLen * d.length;
    var gable = d.span * rise / 2;                            // one triangle
    var wallArea = (d.wallMode !== 'open')
      ? (2 * d.length + 2 * d.span) * (d.wallMode === 'half' ? d.eaves*0.5 : d.eaves) + 2 * gable
      : 0;
    return {
      half: half, rise: rise, rafterLen: rafterLen, bays: bays, actualBay: actualBay,
      frames: frames, purlinRuns: purlinRuns, girtRows: girtRows,
      roofArea: roofArea, wallArea: wallArea, gable: gable,
      ridgeH: d.eaves + rise, footprint: d.span * d.length,
      perimeter: 2 * (d.span + d.length)
    };
  };

  // Preliminary pad-footing check. Tributary area per column × roof load
  // gives the axial load; required area = load / allowable bearing.
  // This is a SIZING AID, not a structural design — it assumes uniform
  // load, no wind uplift, no moment at the base and a homogeneous soil,
  // and the UI says so. A real footing needs an engineer and a soil report.
  BP.footing = function footing(d) {
    var g = BP.geom(d);
    var trib = g.actualBay * (d.span / 2);          // per column, m²
    var axial = trib * d.roofLoad;                  // kN
    var selfW = d.footW * d.footW * d.footD * 25;   // pad self-weight, kN
    var reqA = (axial + selfW) / d.soilBearing;     // m²
    var reqSide = Math.sqrt(Math.max(reqA, 0.01));
    var n = g.frames * 2;
    return {
      trib: trib, axial: axial, reqSide: reqSide, n: n,
      ok: d.footW >= reqSide,
      suggest: Math.ceil(reqSide * 10) / 10,
      volEach: d.footW * d.footW * d.footD,
      volAll: n * d.footW * d.footW * d.footD
    };
  };

  BP.concrete = function concrete(p) {
    var d = p.dims;
    var a = BP.slabArea(p);
    var slab = a * d.slabTh;
    var f = (p.type === 'slab' || !d.footings) ? { volAll: 0, n: 0 } : BP.footing(d);
    return { area: a, slab: slab, footings: f.volAll, pads: f.n, total: slab + f.volAll };
  };

  BP.slabArea = function slabArea(p) {
    var d = p.dims;
    // A footprint traced on the map beats a typed rectangle — it is the
    // actual ground being poured.
    if (p.footprintArea > 0) return p.footprintArea;
    if (d.slabArea > 0) return d.slabArea;
    return d.span * d.length;
  };

  // Returns [{name, qty, unit, kg, note}]
  BP.takeoff = function takeoff(p) {
    var d = p.dims, out = [];
    var w = 1 + (d.waste / 100);
    var wantStruct = p.hasStruct !== false;
    var wantSlab = p.hasSlab !== false;

    function push(name, qty, unit, note) {
      if (!(qty > 0)) return;
      var pr = BP.profByName(name);
      var kg = (pr && pr.kgPerM && unit === "מ'") ? qty * pr.kgPerM : 0;
      out.push({ name: name, qty: qty, unit: unit, kg: kg, note: note || '' });
    }

    // ── reinforcement ──
    // The spec on the project is the same object the detail drawing reads,
    // so the bill and the drawing cannot disagree about what is in the
    // concrete. Defaults are Q188 in slabs and 4Ø12 + Ø8@20 in pads, which
    // is what the hardcoded lines below used to assume — no existing
    // project reprices because of this change.
    function pushSlabSteel(area, note) {
      if (!(area > 0)) return;
      if (typeof Rebar === 'undefined') {
        push('רשת פלדה Q188', Math.ceil(area / (6 * 2.35) * 1.1), "יח'", note);
        return;
      }
      Rebar.slabTakeoff(d.rebar, area, w).forEach(function (r) {
        push(r.name, r.qty, r.unit, note ? note + ' \u00b7 ' + r.note : r.note);
      });
    }
    function pushPadSteel(n, side, depth) {
      if (!(n > 0)) return;
      if (typeof Rebar === 'undefined') {
        push('ברזל זיון 12 מ"מ', n * side * 8 * 2 * w, "מ'",
          BP.tt('כלוב זיון לבסיסים', 'เหล็กฐาน', 'تسليح القواعد'));
        return;
      }
      Rebar.padTakeoff(d.rebar, { n: n, w: side, d: depth, waste: w })
        .forEach(function (r) { push(r.name, r.qty, r.unit, r.note); });
    }

    if (p.type === 'slab') {
      var a = BP.slabArea(p);
      push('בטון ב-30', a * d.slabTh * w, 'מ"ק',
        BP.n1(a) + ' ' + BP.dsp('מ"ר') + ' \u00d7 ' + d.slabTh + ' ' + BP.dsp("מ'"));
      pushSlabSteel(a, '');
      // Edge trimmers around the perimeter, two per side. The diameter
      // follows the spec rather than being frozen at Ø12.
      var edgeD = (typeof Rebar !== 'undefined' && d.rebar) ? d.rebar.mainD : 12;
      push('ברזל זיון ' + edgeD + ' מ"מ', Math.sqrt(a) * 4 * 2 * w, "מ'",
        BP.tt('היקף וחיזוקים', 'ขอบและเสริม', 'محيط وتقوية'));
      (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
      componentLines(p).forEach(function (l) { push(l.name, l.qty, l.unit, l.note); });
      return out;
    }

    var g = BP.geom(d);
    // No structure requested — a gate-only or slab-only project skips the
    // entire frame. This is the fix for a project named "שער" that was
    // billed 4.5 tonnes of steel and a 200 m2 roof nobody asked for.
    if (!wantStruct) {
      if (wantSlab) {
        var sa = BP.slabArea(p);
        push('בטון ב-30', sa * d.slabTh * w, 'מ"ק', BP.tt('רצפה', 'พื้น', 'أرضية'));
        pushSlabSteel(sa, BP.tt('רצפה', 'พื้น', 'أرضية'));
      }
      (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
      componentLines(p).forEach(function (l) { push(l.name, l.qty, l.unit, l.note); });
      return out;
    }
    push(d.colProfile,    g.frames * 2 * d.eaves * w, "מ'",
      g.frames * 2 + ' ' + BP.tt('עמודים', 'เสา', 'أعمدة') + ' \u00d7 ' + BP.n1(d.eaves) + ' ' + BP.dsp("מ'"));
    push(d.rafterProfile, g.frames * 2 * g.rafterLen * w, "מ'",
      g.frames * 2 + ' ' + BP.tt('קורות', 'คาน', 'روافد') + ' \u00d7 ' + BP.n1(g.rafterLen) + ' ' + BP.dsp("מ'"));
    push(d.purlinProfile, g.purlinRuns * 2 * d.length * w, "מ'",
      (g.purlinRuns * 2) + ' ' + BP.tt('שורות מרישים', 'แถวแป', 'صفوف') + ' \u00d7 ' + BP.n1(d.length) + ' ' + BP.dsp("מ'"));
    if (d.wallMode !== 'open' && d.wallClad !== 'none') {
      push(d.girtProfile, g.girtRows * g.perimeter * w, "מ'",
        g.girtRows + ' ' + BP.tt('שורות', 'แถว', 'صفوف'));
    }
    // Cladding is billed only when it is actually specified. The model
    // honoured 'ללא' and 'פתוח'; the takeoff did not, so switching the roof
    // off changed the drawing and left the price alone.
    if (d.roofClad !== 'none') {
      push(d.roofClad, g.roofArea * w, 'מ"ר', BP.tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    }
    if (d.wallMode !== 'open' && d.wallClad !== 'none') {
      push(d.wallClad, g.wallArea * w, 'מ"ר', BP.tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    }
    // ── stiffening steel ───────────────────────────────────────────
    // Haunches and wind bracing were drawn, modelled in 3D and checked by
    // the engineer, and then billed to nobody: neither produced a takeoff
    // line. On a 12x30 shed that is roughly 120 m of steel missing from
    // every quote it ever appeared in.
    //
    // Both are cut from a section already in the catalogue rather than a
    // new one. An unknown profile name resolves to kgPerM 0 and price 0,
    // so inventing 'מוט 16' here would have produced a takeoff line that
    // silently costs nothing — a worse failure than the one being fixed.
    if (d.haunch) {
      // One haunch at each eaves corner: the run along the rafter and the
      // drop down the column, as drawn in the section.
      var hRun = Math.min(d.span * 0.10, 1.2);
      var hRise = Math.min(d.eaves * 0.26, 1.0);
      var haunchLen = Math.sqrt(hRun * hRun + hRise * hRise);
      push(d.rafterProfile, g.frames * 2 * haunchLen * w, "מ'",
        BP.tt('חיזוקי פינה', 'ฮันช์', 'تقويات الأركان') + ' \u00b7 ' +
        (g.frames * 2) + ' \u00d7 ' + BP.n1(haunchLen) + ' ' + BP.dsp("מ'"));
    }
    if (d.bracing) {
      // One braced bay at each end, or the single bay if that is all there
      // is: cross bracing in the roof plane and in both side walls.
      var bays = Math.min(2, Math.max(1, g.bays));
      var bay = g.actualBay;
      var roofBrace = bays * 2 * Math.sqrt(bay * bay + d.span * d.span);
      var wallBrace = (d.wallMode === 'open') ? 0
        : bays * 2 * 2 * Math.sqrt(bay * bay + d.eaves * d.eaves);
      var braceLen = roofBrace + wallBrace;
      push(d.girtProfile, braceLen * w, "מ'",
        BP.tt('ייצוב רוח — גג וקירות', 'ค้ำยันลม', 'تثبيت الرياح') + ' \u00b7 ' +
        bays + ' ' + BP.tt('משבצות מיוצבות', 'ช่วงค้ำยัน', 'حقول مثبتة'));
    }

    push('פלטת בסיס', g.frames * 2, "יח'", '');
    push('בורג עיגון', g.frames * 2 * 4, "יח'", BP.tt('4 לעמוד', '4 ต่อเสา', '4 لكل عمود'));
    if (d.gutter && d.roofClad !== 'none') {
      push('מרזב', 2 * d.length, "מ'", '');
      push('צינור ניקוז', Math.max(2, Math.ceil(d.length / 12) * 2), "יח'", '');
    }
    // Foundation under the frame, always poured with a shed.
    var fa = BP.slabArea(p);
    if (wantSlab) push('בטון ב-30', fa * d.slabTh * w, 'מ"ק', BP.tt('רצפה', 'พื้น', 'أرضية'));
    if (d.footings) {
      var ft = BP.footing(d);
      push('בטון ב-30', ft.volAll * w, 'מ"ק',
        ft.n + ' ' + BP.tt('בסיסי עמוד', 'ฐานเสา', 'قواعد أعمدة') + ' ' +
        BP.n1(d.footW) + '\u00d7' + BP.n1(d.footW) + '\u00d7' + BP.n1(d.footD) + ' ' + BP.dsp("מ'"));
      pushPadSteel(ft.n, d.footW, d.footD);
    }
    if (d.skylights > 0 && d.roofClad !== 'none') {
      var skyA = (d.skylights * (d.length / (d.skylights * 2 + 1))) * g.rafterLen * 2;
      push('לוח סקיילייט', skyA * w, 'מ"ר', d.skylights + ' ' + BP.tt('רצועות', 'แถบ', 'شرائط'));
    }
    if (d.leanTo > 0) {
      var lRaf = d.leanTo / Math.cos(Math.max(4, d.pitch * 0.6) * Math.PI / 180);
      push(d.rafterProfile, g.frames * lRaf * w, "מ'", BP.tt('סככת צד', 'เพิงข้าง', 'جناح جانبي'));
      push(d.colProfile, g.frames * d.eaves * 0.85 * w, "מ'", BP.tt('עמודי סככת צד', 'เสาเพิง', 'أعمدة الجناح'));
      if (d.roofClad !== 'none') {
        push(d.roofClad, d.length * lRaf * w, 'מ"ר', BP.tt('גג סככת צד', 'หลังคาเพิง', 'سقف الجناح'));
      }
    }
    if (d.mezz > 0) {
      push(d.rafterProfile, (g.bays + 1) * d.mezz * w, "מ'", BP.tt('קורות גלריה', 'คานชั้นลอย', 'روافد الميزانين'));
      push('רשת פלדה Q188', Math.ceil(d.length * d.mezz / (6 * 2.35) * 1.1), "יח'",
        BP.tt('רצפת גלריה', 'พื้นชั้นลอย', 'أرضية الميزانين'));
    }
    if (d.door) push('שער הזזה', 1, "יח'", BP.n1(d.doorW) + '\u00d7' + BP.n1(d.doorH) + ' ' + BP.dsp("מ'"));
    if (d.fence) {
      var per = 2 * ((d.length + d.fenceOff * 2) + (d.span + d.fenceOff * 2));
      push('עמוד גדר', Math.ceil(per / 2.5), "יח'", BP.n1(d.fenceH) + ' ' + BP.dsp("מ'"));
      push('רשת גדר', per, "מ'", BP.n1(d.fenceH) + ' ' + BP.dsp("מ'") + ' ' + BP.tt('גובה', 'สูง', 'ارتفاع'));
    }
    if (wantSlab) pushSlabSteel(fa, BP.tt('רצפה', 'พื้น', 'أرضية'));
    (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
    componentLines(p).forEach(function (l) { push(l.name, l.qty, l.unit, l.note); });
    return out;
  };

  // Gates and accommodation contribute to the same bill of quantities as the
  // structure. Keeping them in separate documents is how a client ends up
  // with three quotes for one job and no total.
  function componentLines(p) {
    var out = [];
    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (g, i) {
        Gates.takeoff(g).forEach(function (l) {
          out.push({ name: l.name, qty: l.qty, unit: l.unit,
                     note: (g.name || (BP.tt('שער','ประตู','بوابة') + ' ' + (i+1))) +
                           (l.note ? ' \u00b7 ' + l.note : '') });
        });
      });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      LivingUnit.takeoff(p.living).forEach(function (l) {
        out.push({ name: l.name, qty: l.qty, unit: l.unit,
                   note: BP.tt('מגורים','ที่พัก','سكن') + (l.note ? ' \u00b7 ' + l.note : '') });
      });
    }
    return out;
  }

  BP.takeoffTotals = function takeoffTotals(rows) {
    var cost = 0, kg = 0, unpriced = 0;
    rows.forEach(function (r) {
      var pr = BP.profByName(r.name);
      if (pr && pr.price > 0) cost += r.qty * pr.price; else unpriced++;
      kg += r.kg;
    });
    return { cost: cost, kg: kg, unpriced: unpriced };
  };


})(BuildPlanInternals);
