/* buildplan-plan.js — תוכנית קונסטרוקטור (the engineer's documents, read)
 * ---------------------------------------------------------------------
 * A construction project arrives as documents: a foundation plan, a
 * detail sheet, a reinforcement schedule, sometimes a BOQ — several PDFs
 * and photos, from an engineer, to a client who is not a builder. This
 * tab is where they live and where they get read.
 *
 *   DOCUMENTS  uploaded to Storage (build-plans/{pid}/…), registered in
 *              one Firestore document per project (shorashim-build-docs-
 *              {pid}), openable, deletable. Images are downsized on the
 *              phone first; PDFs go up whole.
 *   READING    on a press, the planExtract Cloud Function hands the file
 *              to a vision model that answers through a fixed schema:
 *              every pad, pier, strip, column, beam and slab with its
 *              dimensions and reinforcement as written, plus everything
 *              that is not one of those, plus what to ask the engineer.
 *              Cheapest capable model by default, a stronger one on
 *              request; the answer is kept with the document, so nothing
 *              is paid for twice.
 *   INSERTING  each proposal is a checkbox. Accepted ones become plan
 *              elements of the project — replacing an element with the
 *              same mark, otherwise appended — and from then on the
 *              project owns them: editable, drawn, explained, priced.
 *   3D         the excavated pit, blinding, translucent concrete, every
 *              bar of the cage, dowels or the anchor plate — in the same
 *              viewer the shed and gates use (Shed3D prebuilt faces).
 *   2D         section/plan detail (Rebar.detailSvg) for cage elements.
 *   TEXT       a glossary of every part shown, its store name, and which
 *              choices are the buyer's (prefab cage vs site-tied, welded
 *              mat vs loose bars, ready-mix vs site-mix) and which are the
 *              engineer's (diameter, count, spacing, cover, grade).
 *   BOQ        bar metres, stirrup counts, concrete m³ per element,
 *              pushed to the project's extras to price through the
 *              catalogue.
 *
 * NOT A DESIGN. Nothing here sizes anything, and a model reading a sheet
 * can misread it — which is why every proposal carries a confidence and
 * is accepted by hand, never inserted silently.
 *
 * UNITS as on a drawing: metres for geometry, millimetres for bar
 * diameter, centimetres for spacing and cover (see rebar.js).
 */
(function (BP) {
  'use strict';

  var KINDS = ['pad', 'pier', 'strip', 'column', 'beam', 'slab'];
  // Concrete grades as written on a drawing; 'בטון ' + grade is the
  // catalogue key the takeoff prices by.
  var GRADES = ['ב-20', 'ב-25', 'ב-30', 'ב-40'];   // CATALOGUE KEY
  var ICON = { pad: '\ud83e\uddf1', pier: '\ud83d\udd29', strip: '\u2796', column: '\ud83c\udfdb',
               beam: '\ud83e\ude9c', slab: '\u2b1b' };

  function kindLabel(k) {
    return k === 'pier'   ? BP.tt('כלונס', 'เสาเข็มเจาะ', 'خازوق')
         : k === 'strip'  ? BP.tt('קורת יסוד / יסוד עובר', 'ฐานรากต่อเนื่อง', 'أساس شريطي')
         : k === 'column' ? BP.tt('עמוד בטון', 'เสาคอนกรีต', 'عمود خرساني')
         : k === 'beam'   ? BP.tt('קורה', 'คาน', 'جسر')
         : k === 'slab'   ? BP.tt('רצפה / משטח מזוין', 'พื้นเสริมเหล็ก', 'بلاطة مسلحة')
         :                  BP.tt('יסוד בודד ("רגל")', 'ฐานรากเดี่ยว', 'أساس منفرد');
  }
  function kindWhat(k) {
    return k === 'pier'   ? BP.tt('עמוד בטון עגול שקודחים לתוך האדמה ומכניסים לתוכו כלוב ארוך. במקום בור — קידוח. הכלוב: מוטות אורך + טבעות/ספירלה.',
                                  'เสาเจาะกลม ใส่กรงเหล็กยาว', 'عمود دائري يُحفر في الأرض ويُنزل فيه قفص طويل')
         : k === 'strip'  ? BP.tt('קורת בטון ארוכה בתעלה, מתחת לקיר או בין יסודות. ברזל למעלה ולמטה + חישוקים לאורך כל הקורה.',
                                  'คานคอนกรีตยาวในร่อง เหล็กบน-ล่าง + ปลอก', 'جسر خرساني طويل في خندق، حديد علوي وسفلي وأساور')
         : k === 'column' ? BP.tt('עמוד בטון יצוק. הכלוב: מוטות אנכיים + חישוקים. מתחבר ליסוד דרך הקוצים שבולטים ממנו.',
                                  'เสาหล่อ: เหล็กยืน + ปลอก ต่อกับฐานด้วยเหล็กเสียบ', 'عمود مصبوب: قضبان رأسية وأساور، يتصل بالأساس عبر أشاير')
         : k === 'beam'   ? BP.tt('קורת בטון יצוקה (לרוב מעל עמודים). ברזל למעלה ולמטה + חישוקים; צריכה טפסנות (תבנית) ותמיכה עד שהבטון מתקשה.',
                                  'คานหล่อ เหล็กบน-ล่าง + ปลอก ต้องมีแบบและค้ำยัน', 'جسر مصبوب، حديد علوي وسفلي وأساور، يحتاج قالباً ودعامات')
         : k === 'slab'   ? BP.tt('משטח בטון על מצע מהודק, עם רשת בתוך הבטון — רשת Q188 מרותכת או ברזל מצולע קשור.',
                                  'พื้นคอนกรีตบนทรายบดอัด มีตะแกรงในเนื้อคอนกรีต', 'بلاطة على طبقة مدكوكة، بداخلها شبكة حديد')
         :                  BP.tt('קוביית בטון מזוין מתחת לכל עמוד. בתוכה כלוב: מוטות אנכיים + חישוקים + מרבד בתחתית. הראש בדרך כלל קצת מתחת לפני הקרקע.',
                                  'บล็อกคอนกรีตใต้เสาแต่ละต้น มีกรงเหล็กและตะแกรงล่าง', 'كتلة خرسانية تحت كل عمود، بداخلها قفص وشبكة سفلية');
  }
  function isCage(k) { return k === 'pad' || k === 'pier' || k === 'column'; }
  function isLinear(k) { return k === 'strip' || k === 'beam'; }
  function isBuried(k) { return k === 'pad' || k === 'pier' || k === 'strip'; }

  // ── model ───────────────────────────────────────────────────────────
  function num(v, def, lo, hi) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return def;
    return Math.max(lo, Math.min(hi, n));
  }
  var DEF = {
    pad:    { w: 0.6, l: 0.6, h: 0.8 },
    pier:   { w: 0.4, l: 0.4, h: 3.0 },
    strip:  { w: 0.4, l: 4.0, h: 0.6 },
    column: { w: 0.3, l: 0.3, h: 3.0 },
    beam:   { w: 0.25, l: 4.0, h: 0.5 },
    slab:   { w: 0, l: 0, h: 0.15 }
  };
  function normEl(e) {
    e = e || {};
    var kind = KINDS.indexOf(e.kind) >= 0 ? e.kind : 'pad';
    var d = DEF[kind];
    var R = (typeof Rebar !== 'undefined') ? Rebar.norm : function (r) { return r || {}; };
    return {
      id: e.id || BP.uid(),
      kind: kind,
      name: String(e.name || ''),                       // the engineer's mark: י-1, ק-2 …
      count: Math.max(1, Math.min(200, Math.round(Number(e.count) || 1))),
      w: num(e.w, d.w, 0.15, 3),                        // width / diameter, m
      l: num(e.l, d.l, 0.15, 30),                       // second side or span, m
      h: num(e.h, d.h, 0.05, 12),                       // concrete depth / height / thickness, m
      below: Math.max(0, Math.min(3, Number(e.below) || 0)),   // top below ground, m
      area: Math.max(0, Math.min(5000, Number(e.area) || 0)),  // slab m²
      topN: Math.max(0, Math.min(12, Math.round(Number(e.topN) || 2))),
      botN: Math.max(0, Math.min(12, Math.round(Number(e.botN) || 3))),
      starter: Math.max(0, Math.min(2, Number(e.starter) || 0)), // projecting length of dowels, m
      plate: !!e.plate,                                 // steel column: anchor plate + bolts
      blind: e.blind === false ? false : true,          // בטון רזה under a buried element
      rebar: R(e.rebar),
      notes: String(e.notes || '')
    };
  }
  BP.normPlan = function normPlan(x) {
    x = x || {};
    return {
      engineer: String(x.engineer || ''),
      drawingNo: String(x.drawingNo || ''),
      date: String(x.date || ''),
      concrete: String(x.concrete || 'ב-30'),          // CATALOGUE KEY suffix, as written on the sheet
      notes: String(x.notes || ''),
      sel: Math.max(0, Math.round(Number(x.sel) || 0)),
      elements: Array.isArray(x.elements) ? x.elements.map(normEl) : []
    };
  };
  function planOf(p) {
    if (!p.plan) p.plan = BP.normPlan(null);
    return p.plan;
  }
  function selEl(p) {
    var pl = planOf(p);
    if (!pl.elements.length) return null;
    if (pl.sel >= pl.elements.length) pl.sel = pl.elements.length - 1;
    return pl.elements[pl.sel];
  }

  // ── quantities ──────────────────────────────────────────────────────
  // What the takeoff already expects: catalogue name, qty, unit, note.
  // Hooks 15 cm each end, 12 cm stirrup lap — the same allowances as
  // rebar.js so a pad here and a pad on the design tab count the same.
  function barName(d) {
    return (typeof Rebar !== 'undefined') ? Rebar.barName(d) : 'ברזל זיון ' + d + ' מ"מ';   // CATALOGUE KEY
  }
  function concreteKey(pl) { return 'בטון ' + (pl.concrete || 'ב-30'); }   // CATALOGUE KEY
  function elTakeoff(pl, el) {
    var r = el.rebar, n = el.count, out = [], c = r.cover / 100;
    var tag = (el.name ? el.name + ' \u00b7 ' : '') + kindLabel(el.kind);
    var stirTxt = BP.tt('חישוקים', 'ปลอกเหล็ก', 'أساور');

    if (el.kind === 'slab') {
      if (!(el.area > 0)) return out;
      out.push({ name: concreteKey(pl), qty: n * el.area * el.h, unit: 'מ"ק', note: tag });
      if (typeof Rebar !== 'undefined') {
        Rebar.slabTakeoff(r, n * el.area, 1).forEach(function (x) { x.note = tag; out.push(x); });
      }
      return out;
    }

    var round = el.kind === 'pier';
    var vol = round ? Math.PI * el.w * el.w / 4 * el.h : el.w * el.l * el.h;
    out.push({ name: concreteKey(pl), qty: n * vol, unit: 'מ"ק', note: tag });

    if (isCage(el.kind)) {
      // longitudinal bars run the height, hooked each end, plus the dowel
      var mainLen = (el.h + 0.30 + el.starter) * r.mainN;
      out.push({ name: barName(r.mainD), qty: n * mainLen, unit: "מ'",
        note: tag + ' \u00b7 ' + r.mainN + '\u00d8' + r.mainD });
      var clearH = Math.max(0.1, el.h - 2 * c);
      var stirN = Math.floor(clearH / (r.stirSp / 100)) + 1;
      var stirLen = round ? Math.PI * Math.max(0.1, el.w - 2 * c) + 0.12
                          : 2 * (Math.max(0.1, el.w - 2 * c) + Math.max(0.1, el.l - 2 * c)) + 0.12;
      out.push({ name: barName(r.stirD), qty: n * stirN * stirLen, unit: "מ'",
        note: tag + ' \u00b7 ' + (n * stirN) + ' ' + stirTxt + ' \u00d8' + r.stirD + '@' + BP.n1(r.stirSp) });
      if (r.mat && el.kind === 'pad') {
        var cw = Math.max(0.1, el.w - 2 * c), cl = Math.max(0.1, el.l - 2 * c), sp = r.matSp / 100;
        var matLen = (Math.floor(cw / sp) + 1) * (cl + 0.10) + (Math.floor(cl / sp) + 1) * (cw + 0.10);
        out.push({ name: barName(r.matD), qty: n * matLen, unit: "מ'",
          note: tag + ' \u00b7 ' + BP.tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية') + ' #\u00d8' + r.matD + '@' + BP.n1(r.matSp) });
      }
    } else {
      // strip / beam: top + bottom bars along the span, stirrups along it
      var longN = el.topN + el.botN;
      if (longN > 0) {
        out.push({ name: barName(r.mainD), qty: n * longN * (el.l + 0.30), unit: "מ'",
          note: tag + ' \u00b7 ' + el.topN + '+' + el.botN + '\u00d8' + r.mainD });
      }
      var sN = Math.floor(Math.max(0.1, el.l - 2 * c) / (r.stirSp / 100)) + 1;
      var sLen = 2 * (Math.max(0.1, el.w - 2 * c) + Math.max(0.1, el.h - 2 * c)) + 0.12;
      out.push({ name: barName(r.stirD), qty: n * sN * sLen, unit: "מ'",
        note: tag + ' \u00b7 ' + (n * sN) + ' ' + stirTxt + ' \u00d8' + r.stirD + '@' + BP.n1(r.stirSp) });
    }
    if (el.plate) {
      out.push({ name: 'פלטת בסיס', qty: n, unit: "יח'", note: tag });          // CATALOGUE KEY
      out.push({ name: 'בורג עיגון', qty: n * 4, unit: "יח'", note: tag });      // CATALOGUE KEY
    }
    return out;
  }
  function planTakeoff(p) {
    var pl = planOf(p), all = [];
    pl.elements.forEach(function (el) { all = all.concat(elTakeoff(pl, el)); });
    // merge identical catalogue lines so the extras list stays readable
    var byKey = {}, order = [];
    all.forEach(function (x) {
      var k = x.name + '|' + x.unit;
      if (!byKey[k]) { byKey[k] = { name: x.name, qty: 0, unit: x.unit, notes: [] }; order.push(k); }
      byKey[k].qty += x.qty;
      if (x.note) byKey[k].notes.push(x.note);
    });
    return order.map(function (k) {
      var m = byKey[k];
      return { name: m.name, qty: Math.round(m.qty * 10) / 10, unit: m.unit, note: m.notes.join(' / ') };
    });
  }

  // ── 3D ──────────────────────────────────────────────────────────────
  // Prebuilt faces for Shed3D. Axes match the shed: x along the length,
  // y across, z up, ground at z = 0. Buried elements are shown in their
  // open pit — the ground is a ring with a hole, the pit has walls and a
  // floor, and the concrete is translucent so the cage reads through it.
  var C3 = {
    ground: '#b9ae92', pit: '#8a6f52', pitFloor: '#6f5a43', blind: '#c9c4b8',
    conc: '#9a968d', main: '#b8392a', stir: '#d9573f', mat: '#c4452e',
    starter: '#8e2a1f', plate: '#4d5a63', bolt: '#2f3a42', spacer: '#3a8fb0',
    form: '#a07a4a', base: '#a89f8c'
  };
  function faceAlpha(faces, a) { faces.forEach(function (f) { f.alpha = a; }); return faces; }

  BP.planModel3d = function planModel3d(el) {
    var P = (typeof Shed3D !== 'undefined' && Shed3D.prim) ? Shed3D.prim : null;
    if (!P) return null;
    var F = [], r = el.rebar, c = r.cover / 100;
    var buried = isBuried(el.kind), round = el.kind === 'pier';
    var Lx = el.kind === 'slab' ? Math.sqrt(Math.max(1, el.area)) : (round ? el.w : el.l);
    var Wy = el.kind === 'slab' ? Lx : el.w;
    var hx = Lx / 2, hy = Wy / 2;
    var blindT = (buried && el.blind) ? 0.05 : 0;
    var top = buried ? -el.below : 0;                    // top of concrete
    var bot = top - el.h;                                // bottom of concrete
    var clr = round ? 0.15 : 0.30;                       // working clearance in the pit
    var px = hx + clr, py = hy + clr, pz = bot - blindT; // pit half-sizes and floor
    var pad = Math.max(1.2, Math.max(Lx, Wy) * 0.6);
    var gx = hx + pad, gy = hy + pad;
    var tags = [];

    // ── ground ──
    if (buried) {
      // four quads around the hole
      F = F.concat(P.quad([-gx, -gy, -0.02], [gx, -gy, -0.02], [gx, -py, -0.02], [-gx, -py, -0.02], C3.ground, 'ground', 0, 1));
      F = F.concat(P.quad([-gx, py, -0.02], [gx, py, -0.02], [gx, gy, -0.02], [-gx, gy, -0.02], C3.ground, 'ground', 0, 1));
      F = F.concat(P.quad([-gx, -py, -0.02], [-px, -py, -0.02], [-px, py, -0.02], [-gx, py, -0.02], C3.ground, 'ground', 0, 1));
      F = F.concat(P.quad([px, -py, -0.02], [gx, -py, -0.02], [gx, py, -0.02], [px, py, -0.02], C3.ground, 'ground', 0, 1));
      // pit walls and floor. The walls are translucent: a painter's sort
      // draws the wall nearest the camera last, and an opaque one would
      // hide the cage from every angle but straight down. Seen through a
      // brown veil it reads as a hole in the ground, which is what it is.
      F = F.concat(P.quad([-px, -py, pz], [px, -py, pz], [px, -py, 0], [-px, -py, 0], C3.pit, 'pit', 0, 0.32));
      F = F.concat(P.quad([-px, py, pz], [px, py, pz], [px, py, 0], [-px, py, 0], C3.pit, 'pit', 0, 0.32));
      F = F.concat(P.quad([-px, -py, pz], [-px, py, pz], [-px, py, 0], [-px, -py, 0], C3.pit, 'pit', 0, 0.32));
      F = F.concat(P.quad([px, -py, pz], [px, py, pz], [px, py, 0], [px, -py, 0], C3.pit, 'pit', 0, 0.32));
      F = F.concat(P.quad([-px, -py, pz], [px, -py, pz], [px, py, pz], [-px, py, pz], C3.pitFloor, 'pit', 0, 0.9));
      if (blindT) F = F.concat(P.box(-px, -py, pz, px, py, pz + blindT, C3.blind, 'blind'));
      tags.push({ p: [0, -py - 0.25, 0], t: BP.n1(2 * px) + ' \u00d7 ' + BP.n1(2 * py) + ' m' });
      tags.push({ p: [-px - 0.3, 0, pz / 2], t: BP.n1(-pz) + ' m' });
    } else {
      F = F.concat(P.quad([-gx, -gy, -0.02], [gx, -gy, -0.02], [gx, gy, -0.02], [-gx, gy, -0.02], C3.ground, 'ground', 0, 1));
      if (el.kind === 'slab') {
        F = F.concat(P.box(-hx - 0.3, -hy - 0.3, -0.25, hx + 0.3, hy + 0.3, 0, C3.base, 'base'));
      }
    }

    // ── concrete ──
    if (round) {
      F = F.concat(faceAlpha(P.strut([0, 0, bot], [0, 0, top], el.w / 2, C3.conc, 'conc'), 0.38));
    } else if (el.kind === 'beam') {
      // a beam sits on formwork at the height it will be cast; shown 1 m up
      F = F.concat(P.box(-hx, -hy - 0.03, 0.97, hx, hy + 0.03, 1.0, C3.form, 'form'));
      F = F.concat(faceAlpha(P.box(-hx, -hy, 1.0, hx, hy, 1.0 + el.h, C3.conc, 'conc'), 0.38));
      top = 1.0 + el.h; bot = 1.0;
    } else {
      F = F.concat(faceAlpha(P.box(-hx, -hy, bot, hx, hy, top, C3.conc, 'conc'), 0.38));
    }
    tags.push({ p: [0, hy + 0.35, top], t: round ? '\u00d8' + BP.n1(el.w) + ' m'
                                          : BP.n1(Lx) + ' \u00d7 ' + BP.n1(Wy) + ' m' });
    tags.push({ p: [hx + 0.35, 0, (top + bot) / 2], t: BP.n1(el.h) + ' m' });

    // ── reinforcement ──
    var rb = 0.012, rs = 0.008;                          // drawn bar radii (exaggerated ×~2 for legibility)
    function stirRect(z, x0, y0, x1, y1) {
      F = F.concat(P.bar(x0, y0, z - rs, x1, y0 + 2 * rs, z + rs, C3.stir, 'stir'));
      F = F.concat(P.bar(x0, y1 - 2 * rs, z - rs, x1, y1, z + rs, C3.stir, 'stir'));
      F = F.concat(P.bar(x0, y0, z - rs, x0 + 2 * rs, y1, z + rs, C3.stir, 'stir'));
      F = F.concat(P.bar(x1 - 2 * rs, y0, z - rs, x1, y1, z + rs, C3.stir, 'stir'));
    }
    if (el.kind === 'slab') {
      // a mesh: bars both ways at the drawn spacing, mid-depth
      var mz = el.h / 2, sp = (r.slabMesh === 'deformed' ? r.meshSp : 15) / 100;
      var nX = Math.min(40, Math.floor(Lx / sp)), nY = Math.min(40, Math.floor(Wy / sp));
      for (var i = 0; i <= nX; i++) {
        var xx = -hx + c + (Lx - 2 * c) * i / Math.max(1, nX);
        F = F.concat(P.bar(xx - rs, -hy + c, mz - rs, xx + rs, hy - c, mz + rs, C3.mat, 'mat'));
      }
      for (var j = 0; j <= nY; j++) {
        var yy = -hy + c + (Wy - 2 * c) * j / Math.max(1, nY);
        F = F.concat(P.bar(-hx + c, yy - rs, mz + rs, hx - c, yy + 3 * rs, mz + 3 * rs, C3.mat, 'mat'));
      }
      // chairs holding the mesh up off the base
      for (var k = 0; k < 4; k++) {
        var sxp = (k % 2 ? 1 : -1) * (hx - c - 0.2), syp = (k < 2 ? 1 : -1) * (hy - c - 0.2);
        F = F.concat(P.box(sxp - 0.03, syp - 0.03, 0, sxp + 0.03, syp + 0.03, mz - rs, C3.spacer, 'spacer'));
      }
    } else if (isCage(el.kind)) {
      // longitudinal bars around the stirrup, hooked at the bottom, dowels on top
      var n = r.mainN, ring = [];
      var zb = bot + c, zt = top - c;
      if (round) {
        var rr = el.w / 2 - c;
        for (var q = 0; q < n; q++) {
          var a = q / n * Math.PI * 2;
          ring.push([Math.cos(a) * rr, Math.sin(a) * rr]);
        }
      } else {
        var ix = Lx - 2 * c, iy = Wy - 2 * c, per = 2 * (ix + iy), step = per / n;
        for (var q2 = 0; q2 < n; q2++) {
          var t = q2 * step, bx, by;
          if (t < ix)             { bx = -hx + c + t;            by = -hy + c; }
          else if (t < ix + iy)   { bx = hx - c;                 by = -hy + c + (t - ix); }
          else if (t < 2 * ix + iy) { bx = hx - c - (t - ix - iy); by = hy - c; }
          else                    { bx = -hx + c;                by = hy - c - (t - 2 * ix - iy); }
          ring.push([bx, by]);
        }
      }
      var starterTop = zt + (el.kind === 'column' ? 0 : el.starter);
      ring.forEach(function (pt) {
        F = F.concat(P.strut([pt[0], pt[1], zb], [pt[0], pt[1], zt], rb, C3.main, 'main'));
        // 15 cm hook toward the centre at the bottom
        var hk = 0.15, toX = Math.abs(pt[0]) >= Math.abs(pt[1]);
        var cx = toX ? -Math.sign(pt[0]) * hk : 0, cy = toX ? 0 : -Math.sign(pt[1]) * hk;
        if (cx || cy) F = F.concat(P.strut([pt[0], pt[1], zb], [pt[0] + cx, pt[1] + cy, zb], rb, C3.main, 'main'));
        if (starterTop > zt) F = F.concat(P.strut([pt[0], pt[1], zt], [pt[0], pt[1], starterTop], rb, C3.starter, 'starter'));
      });
      if (starterTop > zt) tags.push({ p: [0, 0, starterTop + 0.15], t: BP.n1(el.starter) + ' m' });
      // stirrups at true spacing
      var sN = Math.min(40, Math.floor((zt - zb) / (r.stirSp / 100)));
      for (var s = 0; s <= sN; s++) {
        var z = zb + (zt - zb) * (sN ? s / sN : 0);
        if (round) {
          var segs = 8, rr2 = el.w / 2 - c + rs;
          for (var u = 0; u < segs; u++) {
            var a0 = u / segs * Math.PI * 2, a1 = (u + 1) / segs * Math.PI * 2;
            F = F.concat(P.strut([Math.cos(a0) * rr2, Math.sin(a0) * rr2, z],
                                 [Math.cos(a1) * rr2, Math.sin(a1) * rr2, z], rs, C3.stir, 'stir'));
          }
        } else {
          stirRect(z, -hx + c - rs, -hy + c - rs, hx - c + rs, hy - c + rs);
        }
      }
      // bottom mat: bars both ways just above the cover, pads only
      if (r.mat && el.kind === 'pad') {
        var msp = r.matSp / 100, mzb = zb - rs;
        var mX = Math.min(30, Math.floor((Lx - 2 * c) / msp)), mY = Math.min(30, Math.floor((Wy - 2 * c) / msp));
        for (var m1 = 0; m1 <= mX; m1++) {
          var mx = -hx + c + (Lx - 2 * c) * m1 / Math.max(1, mX);
          F = F.concat(P.bar(mx - rs, -hy + c, mzb - rs, mx + rs, hy - c, mzb + rs, C3.mat, 'mat'));
        }
        for (var m2 = 0; m2 <= mY; m2++) {
          var my = -hy + c + (Wy - 2 * c) * m2 / Math.max(1, mY);
          F = F.concat(P.bar(-hx + c, my - rs, mzb - 3 * rs, hx - c, my + rs, mzb - rs, C3.mat, 'mat'));
        }
      }
      // spacers under the cage — the reason there IS a bottom cover
      if (!round) {
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (sg) {
          var sx2 = sg[0] * (hx - c - 0.05), sy2 = sg[1] * (hy - c - 0.05);
          F = F.concat(P.box(sx2 - 0.025, sy2 - 0.025, bot, sx2 + 0.025, sy2 + 0.025, zb - 3 * rs, C3.spacer, 'spacer'));
        });
      }
      // anchor plate with four bolts on top, for a steel column
      if (el.plate && el.kind !== 'column') {
        var pw = Math.min(0.35, Lx * 0.5), ph = Math.min(0.35, Wy * 0.5);
        F = F.concat(P.box(-pw / 2, -ph / 2, top, pw / 2, ph / 2, top + 0.02, C3.plate, 'plate'));
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (sg) {
          var bx2 = sg[0] * pw * 0.35, by2 = sg[1] * ph * 0.35;
          F = F.concat(P.strut([bx2, by2, top - 0.25], [bx2, by2, top + 0.08], 0.01, C3.bolt, 'bolt'));
        });
      }
    } else {
      // strip / beam: longitudinal bars top and bottom, stirrups along x
      var zB = bot + c, zT = top - c, yIn = hy - c;
      function rowBars(nB, z, col) {
        for (var b = 0; b < nB; b++) {
          var yb = nB === 1 ? 0 : -yIn + 2 * yIn * b / (nB - 1);
          F = F.concat(P.strut([-hx + c, yb, z], [hx - c, yb, z], rb, col, 'main'));
        }
      }
      rowBars(el.botN, zB, C3.main);
      rowBars(el.topN, zT, C3.main);
      var lN = Math.min(50, Math.floor((Lx - 2 * c) / (r.stirSp / 100)));
      for (var v = 0; v <= lN; v++) {
        var xs = -hx + c + (Lx - 2 * c) * (lN ? v / lN : 0);
        F = F.concat(P.bar(xs - rs, -yIn - rs, zB - rs, xs + rs, yIn + rs, zB + rs, C3.stir, 'stir'));
        F = F.concat(P.bar(xs - rs, -yIn - rs, zT - rs, xs + rs, yIn + rs, zT + rs, C3.stir, 'stir'));
        F = F.concat(P.bar(xs - rs, -yIn - rs, zB, xs + rs, -yIn + rs, zT, C3.stir, 'stir'));
        F = F.concat(P.bar(xs - rs, yIn - rs, zB, xs + rs, yIn + rs, zT, C3.stir, 'stir'));
      }
      if (el.kind === 'strip') {
        [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(function (sg) {
          var sx3 = sg[0] * (hx - c - 0.15), sy3 = sg[1] * (yIn - 0.03);
          F = F.concat(P.box(sx3 - 0.025, sy3 - 0.025, bot, sx3 + 0.025, sy3 + 0.025, zB - rb, C3.spacer, 'spacer'));
        });
      }
    }

    var reach = Math.max(Lx, Wy, el.h + (buried ? el.below : 0), 1.2);
    return {
      faces: F,
      meta: { span: Math.max(1.5, 2 * py + 0.6), length: Math.max(1.5, reach * 1.4),
              eaves: Math.max(0.8, (el.kind === 'beam' ? 1.0 + el.h : (buried ? 0.3 : top)) + (el.starter || 0)),
              ridgeZ: Math.max(0.8, top + 0.3), frames: 1, bay: 1.5, rise: 0, tags: tags }
    };
  };

  // ── glossary ────────────────────────────────────────────────────────
  // One card per part actually in the scene. Three answers each: what it
  // is, what to ask for at the store, and whether the buyer has a choice.
  // "Your call" is procurement form only. Diameter, count, spacing, cover
  // and grade are the engineer's — and each card says which it is.
  function parts(el, pl) {
    var r = el.rebar, out = [];
    var k = el.kind, cage = isCage(k), lin = isLinear(k);
    var stirName = (k === 'pier') ? BP.tt('טבעות / ספירלה', 'เหล็กปลอกวงกลม', 'حلقات / لولب') : BP.tt('חישוקים', 'ปลอกเหล็ก', 'أساور');
    var yes = BP.tt('שלך', 'ของคุณ', 'قرارك'), no = BP.tt('של הקונסטרוקטור', 'ของวิศวกร', 'قرار المهندس');
    function P2(g, name, spec, what, store, alt, whose) {
      out.push({ g: g, name: name, spec: spec || '', what: what, store: store, alt: alt, whose: whose });
    }
    if (isBuried(k)) {
      P2('pit', k === 'pier' ? BP.tt('קידוח', 'หลุมเจาะ', 'حفرة مثقوبة') : BP.tt('בור חפור', 'หลุมขุด', 'حفرة'),
        (k === 'pier' ? '\u00d8' + BP.n1(el.w + 0.3) : BP.n1(el.l + 0.6) + '\u00d7' + BP.n1(el.w + 0.6)) + ' \u00d7 ' + BP.n1(el.below + el.h + (el.blind ? 0.05 : 0)) + ' m',
        k === 'pier'
          ? BP.tt('קודחים עם מקדח כלונסאות בקוטר שכתוב בתוכנית, מורידים את הכלוב ויוצקים. אין בור פתוח.', 'เจาะด้วยสว่านเสาเข็ม ใส่กรง เทคอนกรีต', 'يُحفر بمثقاب خوازيق، يُنزل القفص ويُصب')
          : BP.tt('החפירה ליסוד. חופרים כ-30 ס"מ רחב יותר מהיסוד מכל צד כדי שיהיה מקום לעבוד ולהניח את הכלוב. הדפנות ישרות, התחתית ישרה ונקייה מאדמה תחוחה.', 'ขุดกว้างกว่าฐาน 30 ซม. ทุกด้าน ผนังตรง ก้นเรียบสะอาด', 'تُحفر أوسع من الأساس بنحو 30 سم من كل جهة، الجدران مستقيمة والقاع نظيف'),
        k === 'pier' ? BP.tt('קבלן כלונסאות עם מקדח — לא חופרים ידנית.', 'ผู้รับเหมาเสาเข็มเจาะ', 'مقاول خوازيق')
                     : BP.tt('לא קונים — מיני-מחפרון (באגר) עם כף 30–40 ס"מ, או חפירה ידנית ליסוד קטן.', 'รถขุดเล็ก หรือขุดมือ', 'حفّار صغير أو حفر يدوي'),
        BP.tt('עומק ומידות — של הקונסטרוקטור. איך חופרים — שלך.', 'ความลึกของวิศวกร วิธีขุดของคุณ', 'العمق للمهندس، طريقة الحفر لك'), yes);
      if (el.blind) {
        P2('blind', BP.tt('בטון רזה (מצע)', 'คอนกรีตหยาบรองพื้น', 'خرسانة نظافة'), '5 ' + BP.tt('ס"מ', 'ซม.', 'سم'),
          BP.tt('שכבה דקה של בטון חלש בתחתית הבור. לא נושאת עומס — היא נותנת תחתית ישרה ונקייה כדי שהכלוב לא ישקע לבוץ ושהכיסוי התחתון יישמר.', 'ชั้นบางไม่รับน้ำหนัก ให้ก้นเรียบ กรงไม่จม', 'طبقة رقيقة لا تحمل، تعطي قاعاً مستوياً ونظيفاً'),
          BP.tt('"בטון רזה" / ב-15 — שק בטון מוכן לערבוב ידני מספיק לכמות כזו.', 'คอนกรีตผสมเสร็จถุงเล็ก', 'خرسانة نظافة، كيس جاهز يكفي'),
          BP.tt('אם לא כתוב בתוכנית — לפעמים מספיק חצץ מהודק. תשאל.', 'ถ้าแบบไม่ระบุ ถามวิศวกร', 'إن لم تُذكر — اسأل المهندس'), yes);
      }
    }
    P2('conc', BP.tt('בטון', 'คอนกรีต', 'خرسانة'), pl.concrete,
      BP.tt('"ב-30" = חוזק הבטון (30 מגה-פסקל אחרי 28 יום). זה מה שמזמינים — לא "בטון" סתם.', 'ระดับกำลังคอนกรีต ต้องสั่งตามนี้', 'درجة قوة الخرسانة — تُطلب هكذا'),
      BP.tt('"בטון מובא ב-30" ממערבל; לכמות קטנה (עד ~1 מ"ק) אפשר לערבב באתר עם מערבל קטן, לפי הוראות השק.', 'คอนกรีตผสมเสร็จ หรือผสมเองถ้าปริมาณน้อย', 'خرسانة جاهزة من الخلاطة، أو خلط موقعي للكميات الصغيرة'),
      BP.tt('דרגת הבטון לא משתנה. מה כן: מערבל + משאבה (יקר, מהיר) לעומת מערבל בלבד ומריצות.', 'เกรดเปลี่ยนไม่ได้ วิธีเทเลือกได้', 'الدرجة ثابتة؛ طريقة الصب اختيارك'), no);
    if (cage || lin) {
      P2('main', BP.tt('מוטות אורך (ברזל ראשי)', 'เหล็กหลัก', 'قضبان طولية'),
        cage ? r.mainN + '\u00d8' + r.mainD : el.topN + '+' + el.botN + '\u00d8' + r.mainD,
        BP.tt('המוטות העבים לאורך היסוד/העמוד/הקורה — הם נושאים את המתיחה. "6Ø12" = שישה מוטות בקוטר 12 מ"מ. בקורה: "2+3" = שניים למעלה, שלושה למטה.', 'เหล็กเส้นหนา รับแรงดึง', 'القضبان السميكة التي تحمل الشد'),
        BP.tt('"ברזל מצולע Ø' + r.mainD + ', פ-500" — נמכר במוטות של 12 מ\'; רוב החנויות חותכות. מוסיפים 15–20 ס"מ לכל קצה לקרס (כיפוף).', 'เหล็กข้ออ้อย ขายเป็นเส้น 12 ม. บวกงอปลาย', 'حديد مضلع، يُباع بطول 12 م، أضف عكفة بكل طرف'),
        BP.tt('קוטר ומספר — לא נוגעים. אבל אפשר להזמין "כלוב מוכן" מספק ברזל: מגיע כפוף וקשור לפי המידות שלך, במקום לקשור בשטח.', 'ขนาดจำนวนแก้ไม่ได้ แต่สั่งกรงสำเร็จรูปได้', 'القطر والعدد ثابتان؛ يمكن طلب قفص جاهز'), no);
      P2('stir', stirName, '\u00d8' + r.stirD + '@' + BP.n1(r.stirSp),
        BP.tt('הטבעות שמקיפות את המוטות הראשיים כל כמה ס"מ ("Ø8@20" = ברזל 8 מ"מ כל 20 ס"מ). הן מחזיקות את הכלוב בצורה ומונעות מהמוטות להיפתח החוצה תחת עומס.', 'ห่วงล้อมเหล็กหลัก ทุก X ซม.', 'حلقات تحيط بالقضبان كل بضعة سم'),
        (k === 'pier'
          ? BP.tt('"טבעות Ø' + r.stirD + '" בקוטר חיצוני ' + BP.n1((el.w - 2 * r.cover / 100) * 100) + ' ס"מ — ספק ברזל מכופף (או ספירלה רציפה, לפי התוכנית).', 'ห่วงกลม ดัดจากร้าน', 'حلقات مثنية من المورد')
          : BP.tt('"חישוקים סגורים Ø' + r.stirD + '" במידה חיצונית ' + BP.n1((el.w - 2 * r.cover / 100) * 100) + '\u00d7' + BP.n1(((cage ? el.l : el.h) - 2 * r.cover / 100) * 100) + ' ס"מ — ספק ברזל מכופף; או "ברזל מצולע Ø' + r.stirD + '" וכיפוף באתר במכופף ידני.', 'ปลอกปิด ดัดสำเร็จจากร้าน หรือดัดเอง', 'أساور مغلقة مثنية من المورد أو تُثنى موقعياً')),
        BP.tt('המרווח (@' + BP.n1(r.stirSp) + ') לא משתנה. קנייה מכופפת מראש חוסכת שעות ויוצאת מדויקת יותר — זה שלך.', 'ระยะเปลี่ยนไม่ได้ ซื้อดัดสำเร็จได้', 'التباعد ثابت؛ الشراء مثنياً اختيارك'), no);
    }
    if (cage && k === 'pad' && r.mat) {
      P2('mat', BP.tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية'), '#\u00d8' + r.matD + '@' + BP.n1(r.matSp),
        BP.tt('שכבת מוטות שתי-וערב בתחתית היסוד ("#Ø10@15" = ברזל 10 מ"מ כל 15 ס"מ בשני הכיוונים). זה מה שמונע מהיסוד להישבר כשהאדמה דוחפת מלמטה.', 'เหล็กตาข่ายก้นฐาน กันฐานหัก', 'شبكة متقاطعة في قاع الأساس'),
        BP.tt('ברזל מצולע Ø' + r.matD + ' חתוך למידה וקשירה באתר — או "רשת מרותכת Ø' + r.matD + '/' + BP.n1(r.matSp) + '" אם ספק הברזל מחזיק.', 'เหล็กตัดตามขนาด หรือตะแกรงเชื่อม', 'قضبان مقطوعة وتُربط، أو شبكة ملحومة'),
        BP.tt('רשת מרותכת במקום קשירה ידנית — שווה ערך אם הקוטר והמרווח זהים. רשת Q188 (Ø6/15) חלשה יותר — לא תחליף בלי אישור.', 'ตะแกรงเชื่อมแทนได้ถ้าขนาดเท่ากัน', 'شبكة ملحومة بديل إن تطابق القطر والتباعد'), no);
    }
    if (k === 'slab') {
      var slabSpec = (typeof Rebar !== 'undefined') ? Rebar.slabLabel(r) : '';
      P2('mat', BP.tt('רשת ברצפה', 'ตะแกรงพื้น', 'شبكة البلاطة'), slabSpec,
        BP.tt('הרשת יושבת באמצע עובי הבטון, על "כיסאות" (שומרי מרחק). Q188 = יריעה מרותכת של ברזל 6 מ"מ כל 15 ס"מ, 6\u00d72.35 מ\'. חופפים יריעות ב-2 משבצות.', 'ตะแกรงกลางความหนา บนเก้าอี้ ทาบ 2 ช่อง', 'الشبكة في منتصف السماكة على كراسي، تداخل خانتين'),
        r.slabMesh === 'deformed' ? BP.tt('ברזל מצולע Ø' + r.meshD + ' חתוך, קשירה באתר.', 'เหล็กข้ออ้อยตัด ผูกหน้างาน', 'حديد مضلع مقطوع يُربط موقعياً')
                                   : BP.tt('"רשת פלדה Q188" — יריעות 6\u00d72.35.', 'แผ่นตะแกรง Q188', 'ألواح شبكة Q188'),
        BP.tt('סוג הרשת — של הקונסטרוקטור. אם כתוב Q188 אפשר להזמין חתוך למידה מהספק.', 'ชนิดของวิศวกร สั่งตัดได้', 'النوع للمهندس؛ يمكن طلب القص'), no);
    }
    if (cage || lin || k === 'slab') {
      P2('spacer', BP.tt('כיסוי בטון + שומרי מרחק', 'ระยะหุ้ม + ลูกปูน', 'غطاء خرساني + فواصل'), BP.n1(r.cover) + ' ' + BP.tt('ס"מ', 'ซม.', 'سم'),
        BP.tt('הברזל חייב להיות עטוף בבטון מכל צד (' + BP.n1(r.cover) + ' ס"מ כאן). בלי זה הברזל מחליד והבטון נסדק. "שומרי מרחק" (ספייסרים / "כיסאות") הם חתיכות פלסטיק או בטון שמרימות את הכלוב מהתחתית ומרחיקות אותו מהדפנות.', 'เหล็กต้องถูกหุ้มทุกด้าน ใช้ลูกปูนยก', 'يجب أن يغلف الخرسان الحديد من كل جهة؛ فواصل ترفع القفص'),
        BP.tt('"שומרי מרחק לזיון ' + BP.n1(r.cover) + ' ס"מ" (שקית פלסטיק) + "חוט קשירה שחור" + צבת קשירה.', 'ลูกปูน + ลวดผูก + คีม', 'فواصل + سلك رباط + كماشة'),
        BP.tt('הכיסוי — של הקונסטרוקטור. פלסטיק או קוביות בטון שיוצקים לבד — שלך.', 'ระยะของวิศวกร วัสดุของคุณ', 'الغطاء للمهندس، نوع الفاصل لك'), no);
    }
    if (cage && k !== 'column' && el.starter > 0) {
      P2('starter', BP.tt('קוצים (ברזלי המתנה)', 'เหล็กเสียบรอ', 'أشاير'), BP.n1(el.starter) + ' m',
        BP.tt('מוטות שבולטים מהיסוד למעלה, כדי שהעמוד שייצקו אחר כך יתחבר ליסוד. אורך הבליטה כתוב בתוכנית.', 'เหล็กโผล่จากฐานเพื่อต่อเสา', 'قضبان بارزة لربط العمود بالأساس'),
        BP.tt('אותו ברזל כמו המוטות הראשיים — פשוט מזמינים אותם ארוכים יותר.', 'เหล็กเดียวกัน ยาวขึ้น', 'نفس الحديد بطول أكبر'),
        BP.tt('אורך — של הקונסטרוקטור. אם העמוד הוא פלדה במקום בטון — אין קוצים, יש פלטת עיגון.', 'ความยาวของวิศวกร', 'الطول للمهندس'), no);
    }
    if (el.plate) {
      P2('plate', BP.tt('פלטת עיגון + ברגי יסוד', 'แผ่นเหล็ก + สลักยึด', 'صفيحة تثبيت + براغي'), '4 \u00d7 ' + BP.tt('בורג', 'สลัก', 'برغي'),
        BP.tt('לעמוד פלדה: פלטה עם 4 ברגים שמוטבעים בבטון בזמן היציקה, והעמוד מתברג אליה. חייבים לפלס ולקבע אותה לפני שהבטון מתקשה, במרחקים בין הברגים לפי שרטוט העמוד.', 'แผ่นฐานฝังสลักตอนเท ต้องปรับระดับ', 'صفيحة تُثبت في الصب، يجب تسويتها قبل التصلب'),
        BP.tt('"פלטת בסיס" לפי מידות העמוד + "ברגי עיגון M16/M20 עם קרס" — או תבנית ברגים מוכנה מהמסגר שמייצר את העמודים.', 'แผ่นฐาน + สลัก M16/M20', 'صفيحة قاعدة + براغي M16/M20'),
        BP.tt('אפשר "עיגון כימי" אחרי היציקה (קידוח + ברגים כימיים) — נוח יותר, יקר יותר, וצריך אישור הקונסטרוקטור.', 'สลักเคมีหลังเทได้ ถ้าวิศวกรอนุมัติ', 'تثبيت كيميائي بعد الصب بموافقة المهندس'), yes);
    }
    if (k === 'beam') {
      P2('form', BP.tt('טפסנות ותמיכות', 'แบบหล่อและค้ำยัน', 'قوالب ودعامات'), '',
        BP.tt('קורה יצוקה באוויר צריכה תבנית עץ/מתכת ותמיכות (ג\'קים) שנשארות לפחות שבועיים עד שהבטון חזק מספיק.', 'แบบและค้ำยันอย่างน้อย 2 สัปดาห์', 'قالب ودعامات لأسبوعين على الأقل'),
        BP.tt('השכרת תבניות + תמיכות מקבלן טפסנות; לקורה אחת — לוחות עץ וג\'קים משכירות ציוד.', 'เช่าแบบ หรือไม้และแม่แรง', 'استئجار قوالب أو خشب ورافعات'),
        BP.tt('שלך לגמרי — כל עוד התבנית מחזיקה את המידות.', 'ของคุณ ตราบใดที่ได้ขนาด', 'قرارك ما دامت الأبعاد صحيحة'), yes);
    }
    return out;
  }

  // ── shopping list ───────────────────────────────────────────────────
  // The takeoff lines, said the way a person at the counter says them.
  function shopping(pl) {
    var rows = planTakeoff({ plan: pl }), lines = [];
    rows.forEach(function (x) {
      var m = /^ברזל זיון (\d+)/.exec(x.name);
      if (m) {
        var bars = Math.ceil(x.qty / 12);
        lines.push(BP.tt('ברזל מצולע Ø' + m[1] + ' פ-500 — ' + BP.n1(x.qty) + ' מ\' (\u2248 ' + bars + ' מוטות של 12 מ\', לפני חיתוך)',
                         'เหล็กข้ออ้อย Ø' + m[1] + ' — ' + BP.n1(x.qty) + ' ม. (\u2248 ' + bars + ' เส้น 12 ม.)',
                         'حديد مضلع Ø' + m[1] + ' — ' + BP.n1(x.qty) + ' م (\u2248 ' + bars + ' قضيب 12 م)'));
      } else if (/^בטון/.test(x.name)) {
        lines.push(BP.tt(x.name + ' מובא — ' + BP.n1(x.qty) + ' מ"ק (להזמין +10% ולוודא גישה למערבל)',
                         'คอนกรีตผสมเสร็จ ' + BP.n1(x.qty) + ' ลบ.ม. (+10%)',
                         'خرسانة جاهزة ' + BP.n1(x.qty) + ' م³ (+10%)'));
      } else {
        lines.push(BP.dsp(x.name) + ' — ' + BP.n1(x.qty) + ' ' + BP.dsp(x.unit));
      }
    });
    if (rows.length) {
      lines.push(BP.tt('חוט קשירה שחור (גליל) + שומרי מרחק לזיון + צבת קשירה', 'ลวดผูก + ลูกปูน + คีม', 'سلك رباط + فواصل + كماشة'));
    }
    return lines;
  }

  // ── tab ─────────────────────────────────────────────────────────────
  var _v = null, _cam = null;   // the one live viewer and its camera across repaints
  function destroy3d() {
    if (_v) { try { _cam = _v.getState(); _v.destroy(); } catch (e) {} }
    _v = null;
  }
  function in_(id, k, val, ph, type) {
    return '<input class="bp-in" type="' + (type || 'text') + '" step="any" value="' + BP.esc(val) +
      '" placeholder="' + BP.esc(ph || '') + '" onchange="BuildPlan.planSet(' + id + ',\'' + k + '\',this.value)">';
  }
  function eln(id, i, k, val, min, max, step) {
    return '<input class="bp-in" type="number" min="' + min + '" max="' + max + '" step="' + step +
      '" value="' + val + '" onchange="BuildPlan.planEl(' + id + ',' + i + ',\'' + k + '\',this.value)">';
  }
  function fld(label, ctl) { return '<div><div class="bp-lbl">' + label + '</div>' + ctl + '</div>'; }
  function diamSel(id, i, k, val) {
    var list = (typeof Rebar !== 'undefined') ? Rebar.DIAM : [8, 10, 12, 14, 16, 20];
    return '<select class="bp-in" onchange="BuildPlan.planRebar(' + id + ',' + i + ',\'' + k + '\',this.value)">' +
      list.map(function (dd) {
        return '<option value="' + dd + '"' + (Number(val) === dd ? ' selected' : '') + '>\u00d8' + dd + '</option>';
      }).join('') + '</select>';
  }
  function rnum(id, i, k, val, min, max, step) {
    return '<input class="bp-in" type="number" min="' + min + '" max="' + max + '" step="' + step +
      '" value="' + val + '" onchange="BuildPlan.planRebar(' + id + ',' + i + ',\'' + k + '\',this.value)">';
  }

  BP.planTab = function planTab(p) {
    var id = p.id, pl = planOf(p), el = selEl(p), i = pl.sel;
    var muted = 'color:var(--text-muted,#888);';

    // ── documents + what the model read ──
    var head = docsCard(p);

    // ── element list ──
    var chips = pl.elements.map(function (e, j) {
      return '<button class="bp-btn ' + (j === i ? 'on' : 'ghost') + '" style="padding:5px 9px;font-size:.74rem;" ' +
        'onclick="BuildPlan.planSel(' + id + ',' + j + ')">' + ICON[e.kind] + ' ' +
        BP.esc(e.name || kindLabel(e.kind)) + (e.count > 1 ? ' \u00d7' + e.count : '') + '</button>';
    }).join('');
    var addSel = '<select class="bp-in" style="max-width:260px;" onchange="BuildPlan.planAdd(' + id + ',this.value);this.value=\'\';">' +
      '<option value="">\u2795 ' + BP.tt('הוסף אלמנט מהתוכנית…', 'เพิ่มชิ้นส่วน…', 'إضافة عنصر…') + '</option>' +
      KINDS.map(function (k) { return '<option value="' + k + '">' + ICON[k] + ' ' + kindLabel(k) + '</option>'; }).join('') +
      '</select>';
    var list = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">' + BP.tt('מה יש בתוכנית', 'มีอะไรในแบบ', 'ما في المخطط') + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">' + chips + '</div>' + addSel +
    '</div>';

    if (!el) {
      return head + list + '<div class="bp-empty">' +
        BP.tt('העלה את תוכנית הקונסטרוקטור למעלה ולחץ "קרא" — או הוסף אלמנט ידנית מהרשימה.', 'อัปโหลดแบบแล้วกด "อ่าน" หรือเพิ่มเอง', 'ارفع المخطط واضغط "اقرأ" أو أضف يدوياً') + '</div>';
    }

    // ── element editor ──
    var r = el.rebar, k = el.kind, cage = isCage(k), lin = isLinear(k);
    var m = BP.tt('מ\'', 'ม.', 'م'), cm = BP.tt('ס"מ', 'ซม.', 'سم');
    var geomFields =
      fld(BP.tt('סימון בתוכנית', 'รหัสในแบบ', 'الرمز في المخطط'),
        '<input class="bp-in" value="' + BP.esc(el.name) + '" placeholder="' + BP.tt('י-1', 'F-1', 'أ-1') + '" onchange="BuildPlan.planEl(' + id + ',' + i + ',\'name\',this.value)">') +
      fld(BP.tt('סוג', 'ชนิด', 'النوع'),
        '<select class="bp-in" onchange="BuildPlan.planEl(' + id + ',' + i + ',\'kind\',this.value)">' +
          KINDS.map(function (kk) { return '<option value="' + kk + '"' + (kk === k ? ' selected' : '') + '>' + ICON[kk] + ' ' + kindLabel(kk) + '</option>'; }).join('') + '</select>') +
      fld(BP.tt('כמות', 'จำนวน', 'العدد'), eln(id, i, 'count', el.count, 1, 200, 1)) +
      (k === 'slab'
        ? fld(BP.tt('שטח (מ"ר)', 'พื้นที่ (ตร.ม.)', 'المساحة (م²)'), eln(id, i, 'area', el.area, 1, 5000, 1)) +
          fld(BP.tt('עובי (' + m + ')', 'ความหนา', 'السماكة'), eln(id, i, 'h', el.h, 0.08, 0.4, 0.01))
        : k === 'pier'
        ? fld(BP.tt('קוטר (' + m + ')', 'เส้นผ่านศูนย์กลาง', 'القطر'), eln(id, i, 'w', el.w, 0.2, 1.5, 0.05)) +
          fld(BP.tt('עומק (' + m + ')', 'ความลึก', 'العمق'), eln(id, i, 'h', el.h, 0.5, 12, 0.1))
        : fld(BP.tt('רוחב (' + m + ')', 'กว้าง', 'العرض'), eln(id, i, 'w', el.w, 0.15, 3, 0.05)) +
          fld(lin ? BP.tt('אורך (' + m + ')', 'ยาว', 'الطول') : BP.tt('אורך / צלע שנייה (' + m + ')', 'ด้านที่สอง', 'الضلع الثاني'), eln(id, i, 'l', el.l, 0.15, 30, 0.05)) +
          fld(k === 'column' ? BP.tt('גובה (' + m + ')', 'สูง', 'الارتفاع') : k === 'beam' ? BP.tt('גובה קורה (' + m + ')', 'ความสูงคาน', 'ارتفاع الجسر') : BP.tt('עומק בטון (' + m + ')', 'ความลึก', 'العمق'), eln(id, i, 'h', el.h, 0.15, 12, 0.05))) +
      (isBuried(k) ? fld(BP.tt('ראש היסוד מתחת לקרקע (' + m + ')', 'หัวฐานใต้ดิน', 'رأس الأساس تحت الأرض'), eln(id, i, 'below', el.below, 0, 3, 0.05)) : '') +
      (cage && k !== 'column' ? fld(BP.tt('קוצים בולטים (' + m + ')', 'เหล็กเสียบโผล่', 'أشاير بارزة'), eln(id, i, 'starter', el.starter, 0, 2, 0.05)) : '');

    var rebarFields = k === 'slab'
      ? fld(BP.tt('רשת', 'ตะแกรง', 'شبكة'),
          '<select class="bp-in" onchange="BuildPlan.planRebar(' + id + ',' + i + ',\'slabMesh\',this.value)">' +
            '<option value="Q188"' + (r.slabMesh === 'Q188' ? ' selected' : '') + '>Q188</option>' +
            '<option value="deformed"' + (r.slabMesh === 'deformed' ? ' selected' : '') + '>' + BP.tt('ברזל מצולע', 'เหล็กข้ออ้อย', 'حديد مضلع') + '</option>' +
            '<option value="none"' + (r.slabMesh === 'none' ? ' selected' : '') + '>' + BP.tt('ללא', 'ไม่มี', 'بدون') + '</option></select>') +
        (r.slabMesh === 'deformed' ? fld(BP.tt('קוטר', 'ขนาด', 'القطر'), diamSel(id, i, 'meshD', r.meshD)) +
          fld(BP.tt('מרווח (' + cm + ')', 'ระยะ', 'التباعد'), rnum(id, i, 'meshSp', r.meshSp, 10, 30, 1)) : '') +
        fld(BP.tt('כיסוי (' + cm + ')', 'ระยะหุ้ม', 'الغطاء'), rnum(id, i, 'cover', r.cover, 2.5, 10, 0.5))
      : (cage
          ? fld(BP.tt('מוטות ראשיים', 'เหล็กหลัก', 'قضبان رئيسية'), rnum(id, i, 'mainN', r.mainN, 2, 12, 1))
          : fld(BP.tt('מוטות למעלה', 'เหล็กบน', 'قضبان علوية'), eln(id, i, 'topN', el.topN, 0, 12, 1)) +
            fld(BP.tt('מוטות למטה', 'เหล็กล่าง', 'قضبان سفلية'), eln(id, i, 'botN', el.botN, 0, 12, 1))) +
        fld(BP.tt('קוטר ראשי', 'ขนาดเหล็กหลัก', 'القطر الرئيسي'), diamSel(id, i, 'mainD', r.mainD)) +
        fld(BP.tt('קוטר חישוק', 'ขนาดปลอก', 'قطر الأسورة'), diamSel(id, i, 'stirD', r.stirD)) +
        fld(BP.tt('חישוק כל (' + cm + ')', 'ปลอกทุก', 'أسورة كل'), rnum(id, i, 'stirSp', r.stirSp, 5, 40, 1)) +
        fld(BP.tt('כיסוי (' + cm + ')', 'ระยะหุ้ม', 'الغطاء'), rnum(id, i, 'cover', r.cover, 2.5, 10, 0.5)) +
        (k === 'pad' && r.mat ? fld(BP.tt('קוטר מרבד', 'ขนาดตะแกรง', 'قطر الشبكة'), diamSel(id, i, 'matD', r.matD)) +
          fld(BP.tt('מרבד כל (' + cm + ')', 'ตะแกรงทุก', 'الشبكة كل'), rnum(id, i, 'matSp', r.matSp, 10, 30, 1)) : '');

    var toggles = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
      (k === 'pad' ? '<label><input type="checkbox"' + (r.mat ? ' checked' : '') + ' onchange="BuildPlan.planRebar(' + id + ',' + i + ',\'mat\',this.checked)"> ' + BP.tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية') + '</label>' : '') +
      (isBuried(k) ? '<label><input type="checkbox"' + (el.blind ? ' checked' : '') + ' onchange="BuildPlan.planEl(' + id + ',' + i + ',\'blind\',this.checked)"> ' + BP.tt('בטון רזה בתחתית', 'คอนกรีตหยาบรองพื้น', 'خرسانة نظافة') + '</label>' : '') +
      (cage && k !== 'column' ? '<label><input type="checkbox"' + (el.plate ? ' checked' : '') + ' onchange="BuildPlan.planEl(' + id + ',' + i + ',\'plate\',this.checked)"> ' + BP.tt('פלטת עיגון לעמוד פלדה', 'แผ่นฐานเสาเหล็ก', 'صفيحة لعمود فولاذي') + '</label>' : '') +
      '</div>';

    var editor = '<div class="bp-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<div class="bp-lbl">' + ICON[k] + ' ' + kindLabel(k) + '</div>' +
        '<button class="bp-btn warn" style="padding:4px 9px;font-size:.72rem;" onclick="BuildPlan.planDel(' + id + ',' + i + ')">\ud83d\uddd1</button>' +
      '</div>' +
      '<div style="font-size:.78rem;' + muted + 'margin-bottom:8px;">' + kindWhat(k) + '</div>' +
      '<div class="bp-grid">' + geomFields + '</div>' +
      '<div class="bp-lbl" style="margin-top:10px;">' + BP.tt('זיון (כמו שכתוב בתוכנית)', 'เหล็กเสริม (ตามแบบ)', 'التسليح (كما في المخطط)') + '</div>' +
      '<div class="bp-grid">' + rebarFields + '</div>' + toggles +
      '<div style="margin-top:8px;"><div class="bp-lbl">' + BP.tt('הערה לאלמנט', 'หมายเหตุ', 'ملاحظة') + '</div>' +
        '<input class="bp-in" value="' + BP.esc(el.notes) + '" onchange="BuildPlan.planEl(' + id + ',' + i + ',\'notes\',this.value)"></div>' +
    '</div>';

    // ── 3D + 2D ──
    var views = [['(-0.62,0.42)', '\u2934', BP.tt('איזומטרי', 'ไอโซ', 'أيزومتري')],
                 ['(0,0.02)', '\u25ad', BP.tt('חזית', 'ด้านหน้า', 'واجهة')],
                 ['(1.5708,0.02)', '\u25b1', BP.tt('צד', 'ด้านข้าง', 'جانب')],
                 ['(0,1.35)', '\u2b1c', BP.tt('מבט על', 'ด้านบน', 'علوي')]];
    var viewer = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\ud83e\uddca ' + BP.tt('איך זה נראה', 'หน้าตาเป็นอย่างไร', 'كيف يبدو') +
        (isBuried(k) ? ' — ' + BP.tt('הבור עם הכלוב בפנים', 'หลุมพร้อมกรง', 'الحفرة والقفص بداخلها') : '') + '</div>' +
      '<div id="bpPlanView" style="height:min(48vh,440px);border-radius:12px;overflow:hidden;' +
        'background:radial-gradient(circle at 50% 30%,rgba(255,255,255,.06),rgba(0,0,0,.25));"></div>' +
      '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">' +
        views.map(function (v) {
          return '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.72rem;" onclick="BuildPlan.plan3dView(' + v[0].slice(1, -1) + ')">' + v[1] + ' ' + v[2] + '</button>';
        }).join('') +
        '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.72rem;" onclick="BuildPlan.plan3dReset()">\u21ba ' + BP.tt('איפוס', 'รีเซ็ต', 'إعادة') + '</button>' +
      '</div>' +
      '<div id="bpPlanSel" style="font-size:.8rem;margin-top:6px;min-height:1.2em;">' +
        BP.tt('לחיצה על חלק במודל מסמנת אותו ומסבירה מה הוא.', 'แตะชิ้นส่วนเพื่อดูคำอธิบาย', 'انقر على جزء لتظهر شرحه') + '</div>' +
      '<div style="font-size:.72rem;' + muted + 'margin-top:4px;">' +
        BP.tt('גרירה = סיבוב \u00b7 Shift+גרירה = הזזה \u00b7 גלגלת = זום \u00b7 הברזל מצויר עבה פי 2 כדי שייראה', 'ลาก=หมุน Shift=เลื่อน ล้อ=ซูม เหล็กวาดหนากว่าจริง', 'سحب=تدوير \u00b7 Shift=تحريك \u00b7 عجلة=تكبير \u00b7 الحديد مرسوم أسمك للوضوح') + '</div>' +
      (cage && typeof Rebar !== 'undefined'
        ? '<div style="margin-top:10px;">' + Rebar.detailSvg(r, { w: el.w, d: el.h, postW: el.plate ? 0.15 : 0.08,
            title: BP.tt('פרט זיון', 'รายละเอียดเหล็ก', 'تفصيل التسليح') + ' \u2014 ' + (el.name || kindLabel(k)) }) + '</div>'
        : '') +
    '</div>';

    // ── glossary ──
    var gl = parts(el, pl).map(function (x) {
      return '<div id="bpGl_' + x.g + '" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,.07);">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;">' +
          '<b style="color:var(--accent,#ff9f43);">' + BP.esc(x.name) + '</b>' +
          '<span style="font-size:.76rem;opacity:.85;direction:ltr;">' + BP.esc(x.spec) + '</span></div>' +
        '<div style="font-size:.8rem;margin-top:3px;">' + BP.esc(x.what) + '</div>' +
        '<div style="font-size:.78rem;margin-top:4px;"><span style="' + muted + '">\ud83d\uded2 ' + BP.tt('בחנות', 'ที่ร้าน', 'في المتجر') + ':</span> ' + BP.esc(x.store) + '</div>' +
        '<div style="font-size:.78rem;margin-top:2px;"><span style="' + muted + '">\ud83d\udd00 ' + BP.tt('אפשר אחרת?', 'เลือกอย่างอื่นได้?', 'بديل؟') + '</span> ' + BP.esc(x.alt) +
          ' <span style="font-size:.7rem;padding:1px 6px;border-radius:8px;background:rgba(255,255,255,.08);">' + BP.esc(x.whose) + '</span></div>' +
      '</div>';
    }).join('');
    var glossary = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:2px;">\ud83d\udcd6 ' + BP.tt('מה זה כל חלק', 'แต่ละส่วนคืออะไร', 'ما هو كل جزء') + '</div>' +
      '<div style="font-size:.72rem;' + muted + 'margin-bottom:4px;">' +
        BP.tt('"של הקונסטרוקטור" = לא משנים בלי לשאול אותו. "שלך" = החלטת רכש שלא משנה את החוזק.', '"ของวิศวกร"=ห้ามเปลี่ยน "ของคุณ"=เลือกได้', '"قرار المهندس" لا يُغيّر؛ "قرارك" اختيار شراء لا يؤثر على القوة') + '</div>' +
      gl + '</div>';

    // ── shopping + quantities ──
    var shop = shopping(pl);
    var rows = planTakeoff(p);
    var qty = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\ud83d\uded2 ' + BP.tt('מה לבקש בחנות (כל התוכנית)', 'สิ่งที่ต้องซื้อ (ทั้งแบบ)', 'ما يُطلب من المتجر (كل المخطط)') + '</div>' +
      (shop.length ? '<ul style="margin:0 0 8px;padding-inline-start:18px;font-size:.8rem;">' +
        shop.map(function (s) { return '<li>' + BP.esc(s) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="bp-lbl" style="margin-bottom:4px;">' + BP.tt('כמויות מחושבות', 'ปริมาณที่คำนวณ', 'الكميات المحسوبة') + '</div>' +
      rows.map(function (x) {
        return '<div class="bp-read"><span>' + BP.esc(BP.dsp(x.name)) + ' <span style="' + muted + 'font-size:.7rem;">' + BP.esc(x.note) + '</span></span>' +
          '<b>' + BP.n1(x.qty) + ' ' + BP.esc(BP.dsp(x.unit)) + '</b></div>';
      }).join('') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">' +
        '<button class="bp-btn" onclick="BuildPlan.planToTakeoff(' + id + ')">\u2b06 ' + BP.tt('הוסף לכתב הכמויות', 'เพิ่มในรายการวัสดุ', 'أضف إلى الكميات') + '</button>' +
        '<button class="bp-btn ghost" onclick="BuildPlan.planPrint(' + id + ')">\ud83d\udda8 ' + BP.tt('הדפסה', 'พิมพ์', 'طباعة') + '</button>' +
      '</div>' +
      '<div style="font-size:.7rem;' + muted + 'margin-top:6px;">' +
        BP.tt('ללא פחת. הוספה לכתב הכמויות מחליפה את שורות התוכנית הקודמות ומתמחרת לפי הקטלוג.', 'ไม่รวมเศษ การเพิ่มจะแทนที่รายการเดิม', 'بدون هدر؛ الإضافة تستبدل بنود المخطط السابقة') + '</div>' +
    '</div>';

    return head + list + '<div class="bp-split">' +
      '<div>' + viewer + qty + '</div>' + '<div>' + editor + glossary + '</div>' +
    '</div>';
  };

  // Mounted after paint, like the gates — innerHTML has replaced the host.
  BP.planMount = function planMount(p) {
    var host = document.getElementById('bpPlanView');
    var el = selEl(p);
    if (!host || !el || typeof Shed3D === 'undefined') return;
    var model = BP.planModel3d(el);
    if (!model) return;
    var labels = {};
    parts(el, planOf(p)).forEach(function (x) { labels[x.g] = { title: x.name, sub: x.spec }; });
    labels.main = labels.main || { title: BP.tt('מוטות אורך', 'เหล็กหลัก', 'قضبان طولية'), sub: '' };
    labels.conc = labels.conc || { title: BP.tt('בטון', 'คอนกรีต', 'خرسانة'), sub: '' };
    labels.bolt = { title: BP.tt('ברגי יסוד', 'สลักยึด', 'براغي التثبيت'), sub: '' };
    labels.base = { title: BP.tt('מצע מהודק', 'ชั้นรองบดอัด', 'طبقة مدكوكة'), sub: '' };
    var out = document.getElementById('bpPlanSel');
    if (_v) destroy3d();
    _v = Shed3D.mount(host, model, {
      state: _cam,
      labels: labels,
      onSelect: function (g) {
        var lab = g ? labels[g] : null;
        if (out) out.innerHTML = lab ? '<b style="color:var(--accent,#ff9f43);">' + BP.esc(lab.title) + '</b> ' +
          '<span style="opacity:.8;direction:ltr;">' + BP.esc(lab.sub) + '</span>' : '';
        var card = g ? document.getElementById('bpGl_' + g) : null;
        if (card && card.scrollIntoView) card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    });
  };

  function repaint(id) { destroy3d(); BP.open(id); }

  // ── handlers ────────────────────────────────────────────────────────
  BP.planSet = function planSet(id, k, v) {
    var p = BP.projById(id); if (!p) return;
    planOf(p)[k] = String(v);
    p.plan = BP.normPlan(p.plan);
    BP.saveP();
  };
  BP.planAdd = function planAdd(id, kind) {
    var p = BP.projById(id); if (!p || !kind) return;
    var pl = planOf(p);
    pl.elements.push(normEl({ kind: kind }));
    pl.sel = pl.elements.length - 1;
    _cam = null;
    BP.saveP(); repaint(id);
  };
  BP.planDel = function planDel(id, i) {
    var p = BP.projById(id); if (!p) return;
    var pl = planOf(p);
    if (!pl.elements[i]) return;
    if (!confirm(BP.tt('למחוק את האלמנט?', 'ลบชิ้นส่วน?', 'حذف العنصر؟'))) return;
    pl.elements.splice(i, 1);
    pl.sel = Math.max(0, Math.min(pl.sel, pl.elements.length - 1));
    BP.saveP(); repaint(id);
  };
  BP.planSel = function planSel(id, i) {
    var p = BP.projById(id); if (!p) return;
    planOf(p).sel = i; _cam = null;
    BP.saveP(); repaint(id);
  };
  var TEXT_E = { name: 1, notes: 1, kind: 1 }, BOOL_E = { plate: 1, blind: 1 };
  BP.planEl = function planEl(id, i, k, v) {
    var p = BP.projById(id); if (!p) return;
    var pl = planOf(p), el = pl.elements[i];
    if (!el) return;
    el[k] = BOOL_E[k] ? !!v : TEXT_E[k] ? String(v) : (Number(v) || 0);
    pl.elements[i] = normEl(el);
    BP.saveP();
    // geometry-only edits rebuild the scene in place; anything that changes
    // which fields, cards or quantities exist repaints the sheet
    // fields, glossary and quantities all follow the geometry, so the
    // sheet repaints; the camera survives through destroy3d()
    repaint(id);
  };
  var BOOL_R = { mat: 1, show: 1 }, TEXT_R = { slabMesh: 1 };
  BP.planRebar = function planRebar(id, i, k, v) {
    var p = BP.projById(id); if (!p) return;
    var pl = planOf(p), el = pl.elements[i];
    if (!el) return;
    el.rebar[k] = BOOL_R[k] ? !!v : TEXT_R[k] ? String(v) : (Number(v) || 0);
    pl.elements[i] = normEl(el);
    BP.saveP(); repaint(id);
  };
  BP.plan3dView = function plan3dView(yaw, pitch) { if (_v) _v.setView(yaw, pitch); };
  BP.plan3dReset = function plan3dReset() { if (_v) { _v.resetView(); _cam = null; } };

  // ══════════════════════════════════════════════════════════════════
  //  DOCUMENTS — the engineer's drawings, uploaded and read
  // ══════════════════════════════════════════════════════════════════
  // Files live in Storage (build-plans/{pid}/{id}__{name}); their register,
  // and what the model read out of each, in one Firestore document per
  // project (shorashim-build-docs-{pid}) — the ledger's split, for the
  // ledger's reason. Reading a document costs a model call, so it runs
  // only on a press and the result is kept with the document: re-opening
  // the tab never re-reads anything.
  var DOCS_PREFIX = 'shorashim-build-docs-';
  var _docs = {}, _docsLoading = {}, _openDoc = {}, _busy = {};

  function normDocs(d) {
    d = (d && typeof d === 'object') ? d : {};
    return {
      docs: Array.isArray(d.docs) ? d.docs.map(function (x) {
        return {
          id: String(x.id || BP.uid()), name: String(x.name || ''), path: String(x.path || ''),
          size: Number(x.size) || 0, type: String(x.type || ''), at: Number(x.at) || 0,
          by: String(x.by || ''), hint: String(x.hint || ''),
          report: (x.report && typeof x.report === 'object') ? x.report : null,
          model: String(x.model || ''), readAt: Number(x.readAt) || 0,
          usage: (x.usage && typeof x.usage === 'object') ? { input: Number(x.usage.input) || 0, output: Number(x.usage.output) || 0 } : null,
          error: String(x.error || '')
        };
      }) : []
    };
  }
  function docsLoad(pid, then) {
    if (_docs[pid]) { if (then) then(_docs[pid]); return; }
    if (_docsLoading[pid]) return;
    _docsLoading[pid] = 1;
    DB.loadAsync(DOCS_PREFIX + pid).then(function (d) {
      _docsLoading[pid] = 0; _docs[pid] = normDocs(d); if (then) then(_docs[pid]);
    }).catch(function () {
      _docsLoading[pid] = 0; _docs[pid] = normDocs(null); if (then) then(_docs[pid]);
    });
  }
  function docsSave(pid) {
    if (!BP.isManager()) { BP.toast('\u26d4 ' + BP.tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    DB.save(DOCS_PREFIX + pid, JSON.parse(JSON.stringify(_docs[pid] || normDocs(null))));
  }
  function fmtSize(b) { return b > 1048576 ? BP.n1(b / 1048576) + ' MB' : Math.round(b / 1024) + ' KB'; }
  function who() { var u = window.currentUser || {}; return String(u.username || u.name || ''); }

  // Images are downsized on the phone before upload: a 12 MP photo of a
  // sheet is 4 MB and thousands of tokens, a 2200 px JPEG of the same
  // sheet is 400 KB and still legible to the model. PDFs go up as-is.
  function shrink(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || file.type === 'image/gif') { resolve({ blob: file, type: file.type, name: file.name }); return; }
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var MAX = 2200, sc = Math.min(1, MAX / Math.max(img.width, img.height));
        if (sc === 1 && file.size < 1500000) { URL.revokeObjectURL(url); resolve({ blob: file, type: file.type, name: file.name }); return; }
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        cv.toBlob(function (b) {
          URL.revokeObjectURL(url);
          resolve({ blob: b || file, type: b ? 'image/jpeg' : file.type, name: file.name.replace(/\.[^.]+$/, '') + '.jpg' });
        }, 'image/jpeg', 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({ blob: file, type: file.type, name: file.name }); };
      img.src = url;
    });
  }

  BP.planUpload = function planUpload(id, input) {
    var p = BP.projById(id);
    var files = input && input.files ? Array.prototype.slice.call(input.files) : [];
    if (!p || !files.length) return;
    if (typeof firebase === 'undefined' || !firebase.storage) { BP.toast('\u26a0\ufe0f Storage SDK'); return; }
    if (!BP.isManager()) { BP.toast('\u26d4 ' + BP.tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    input.value = '';
    docsLoad(id, function (reg) {
      var done = 0;
      BP.toast('\u2b06 ' + BP.tt('מעלה ' + files.length + ' קבצים…', 'กำลังอัปโหลด…', 'جارٍ الرفع…'));
      files.reduce(function (chain, f) {
        return chain.then(function () { return shrink(f); }).then(function (s) {
          var did = String(BP.uid());
          var safe = s.name.replace(/[^\w.\u0590-\u05FF-]+/g, '_').slice(0, 80);
          var path = 'build-plans/' + id + '/' + did + '__' + safe;
          return firebase.storage().ref(path).put(s.blob, { contentType: s.type }).then(function () {
            reg.docs.push({ id: did, name: s.name, path: path, size: s.blob.size, type: s.type, at: Date.now(), by: who(),
                            hint: '', report: null, model: '', readAt: 0, usage: null, error: '' });
            done++;
          });
        });
      }, Promise.resolve()).then(function () {
        docsSave(id);
        BP.toast('\u2705 ' + BP.tt(done + ' מסמכים הועלו', 'อัปโหลดแล้ว', 'تم الرفع'));
        BP.open(id);
      }).catch(function (e) {
        if (done) docsSave(id);
        BP.toast('\u274c ' + (e && e.message ? e.message : 'upload'));
        BP.open(id);
      });
    });
  };

  BP.planDocOpen = function planDocOpen(id, did) {
    var reg = _docs[id]; if (!reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0]; if (!d) return;
    firebase.storage().ref(d.path).getDownloadURL().then(function (u) { window.open(u, '_blank'); })
      .catch(function (e) { BP.toast('\u274c ' + e.message); });
  };
  BP.planDocDel = function planDocDel(id, did) {
    var reg = _docs[id]; if (!reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0]; if (!d) return;
    if (!confirm(BP.tt('למחוק את המסמך "' + d.name + '"?', 'ลบเอกสาร?', 'حذف المستند؟'))) return;
    firebase.storage().ref(d.path).delete().catch(function () {}).then(function () {
      reg.docs = reg.docs.filter(function (x) { return x.id !== did; });
      docsSave(id); BP.open(id);
    });
  };
  BP.planDocToggle = function planDocToggle(id, did) {
    _openDoc[id] = _openDoc[id] === did ? null : did; BP.open(id);
  };
  BP.planDocHint = function planDocHint(id, did, v) {
    var reg = _docs[id]; if (!reg) return;
    reg.docs.forEach(function (x) { if (x.id === did) x.hint = String(v || ''); });
    docsSave(id);
  };

  // The model call. Sequential, one document at a time; the result (or
  // the error) is stored on the document so it is never paid for twice.
  // Which model reads a drawing. Remembered per device, not per project: it
  // is a cost/accuracy preference, not a property of the building. Every call
  // site hard-coded 'sonnet', so there was no way to try a stronger reader on
  // a sheet that came back half-read.
  var MODEL_KEY = 'shorashim-plan-model';
  BP.planModelGet = function planModelGet() {
    try { return localStorage.getItem(MODEL_KEY) || 'opus'; } catch (e) { return 'opus'; }
  };
  BP.planModelSet = function planModelSet(v) {
    try { localStorage.setItem(MODEL_KEY, v); } catch (e) {}
    if (BP._tab === 'plan' && BP._open != null && BP.open) BP.open(BP._open);
  };
  BP.planModelSelect = function planModelSelect() {
    var cur = BP.planModelGet();
    var opts = [
      ['opus-5.5', BP.tt('\u05de\u05d3\u05d5\u05d9\u05e7 \u05d1\u05d9\u05d5\u05ea\u05e8', '\u0e41\u0e21\u0e48\u0e19\u0e17\u0e35\u0e48\u0e2a\u0e38\u0e14', '\u0627\u0644\u0623\u062f\u0642') + ' \u00b7 Opus 5.5'],
      ['opus',     BP.tt('\u05de\u05d3\u05d5\u05d9\u05e7', '\u0e41\u0e21\u0e48\u0e19', '\u062f\u0642\u064a\u0642') + ' \u00b7 Opus 5'],
      ['sonnet-5', BP.tt('\u05de\u05d0\u05d5\u05d6\u05df', '\u0e2a\u0e21\u0e14\u0e38\u0e25', '\u0645\u062a\u0648\u0627\u0632\u0646') + ' \u00b7 Sonnet 5'],
      ['haiku',    BP.tt('\u05de\u05d4\u05d9\u05e8 \u05d5\u05d6\u05d5\u05dc', '\u0e40\u0e23\u0e47\u0e27', '\u0633\u0631\u064a\u0639') + ' \u00b7 Haiku 4.5']
    ];
    return '<label style="font-size:.72rem;display:inline-flex;align-items:center;gap:5px;">' +
      BP.tt('\u05e7\u05d5\u05e8\u05d0 \u05e2\u05dd', '\u0e2d\u0e48\u0e32\u0e19\u0e14\u0e49\u0e27\u0e22', '\u064a\u0642\u0631\u0623 \u0628\u0640') +
      '<select class="bp-in" style="padding:3px 6px;font-size:.72rem;width:auto;" onchange="BuildPlan.planModelSet(this.value)">' +
      opts.map(function (o) {
        return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + o[1] + '</option>';
      }).join('') + '</select></label>';
  };

  BP.planRead = function planRead(id, did, model) {
    var reg = _docs[id]; if (!reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0]; if (!d) return;
    if (_busy[did]) return;
    if (d.report && !confirm(BP.tt('המסמך כבר נקרא. לקרוא שוב (עלות נוספת)?', 'อ่านอีกครั้ง?', 'قراءة مرة أخرى؟'))) return;
    _busy[did] = 1; _openDoc[id] = did; BP.open(id);
    readWith(id, d, Frame.payloadFor(d, model || BP.planModelGet()), true);
  };
  // Read by the reader this build no longer trusts. Every read made by the
  // current client is tiled in the browser and stamped d.tiled = true, so
  // anything without that stamp came from the old whole-sheet read — the one
  // that shrank a 1:50 sheet into a single image the model could not read
  // and returned a footing of 1.25 x 1.25 that is on no drawing. Haiku is
  // the old default and is treated the same way. Such a report used to show
  // the same green tick as a good one; nothing on screen said the numbers
  // under it were not read off the sheet.
  function staleRead(d) {
    return !!(d && d.report) && (d.tiled !== true || /haiku/i.test(String(d.model || '')));
  }
  BP.planStale = staleRead;
  // One read, however the payload was produced. The sheet is tiled in the
  // browser (Frame.payloadFor / payloadFromFile) so the model sees 1:50
  // labels at full resolution, then the result becomes a frame model with
  // its own tab. `open` switches to that tab on success.
  function readWith(id, d, payloadP, open) {
    var fn = firebase.app().functions('us-central1').httpsCallable('planExtract', { timeout: 300000 });
    return payloadP.then(function (payload) {
      d.tiled = !!(payload.tiles && payload.tiles.length);
      return fn(payload);
    }).then(function (res) {
      var r = res.data || {};
      d.report = r.report || null; d.model = r.model || ''; d.usage = r.usage || null; d.readAt = r.at || Date.now(); d.error = '';
    }).catch(function (e) {
      d.error = (e && e.message) ? e.message : 'error';
      BP.toast('\u274c ' + d.error);
    }).then(function () {
      _busy[d.id] = 0; docsSave(id);
      if (d.report && typeof Frame !== 'undefined') Frame.fromDoc(id, d.id, !open);
      if (!open || !d.report) BP.open(id);
    });
  }
  // The same read from a file picked on this device: no download, so no
  // bucket CORS in the way, and always the full-resolution tiles.
  BP.planReadLocal = function planReadLocal(id, did) {
    var reg = _docs[id]; if (!reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0]; if (!d || _busy[did]) return;
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'application/pdf,image/*';
    inp.onchange = function () {
      var file = inp.files && inp.files[0]; if (!file) return;
      _busy[did] = 1; _openDoc[id] = did; BP.open(id);
      readWith(id, d, Frame.payloadFromFile(file, d, BP.planModelGet()), true);
    };
    inp.click();
  };
  BP.planModel = function planModel(id, did) {
    if (typeof Frame !== 'undefined') Frame.fromDoc(id, did, false);
  };
  // Frame reads the project's documents through this.
  BP.planDocs = function planDocs(id) { var reg = _docs[id]; return reg ? reg.docs : []; };
  BP.planReadAll = function planReadAll(id) {
    var reg = _docs[id]; if (!reg) return;
    var todo = reg.docs.filter(function (x) { return !x.report && !_busy[x.id]; });
    if (!todo.length) return;
    (function next(i) {
      if (i >= todo.length) return;
      var d = todo[i]; _busy[d.id] = 1; BP.open(id);
      readWith(id, d, Frame.payloadFor(d, BP.planModelGet()), false).then(function () { next(i + 1); });
    })(0);
  };

  // What the model proposed → what the project holds. Each proposal is a
  // checkbox; a proposal whose mark already exists in the project
  // replaces that element, anything else is appended. Sheet-level facts
  // fill empty header fields only — a value typed by hand is never
  // overwritten by a re-read.
  function reportEl(e) {
    e = e || {};
    return normEl({
      kind: e.kind, name: e.name, count: e.count, w: e.w, l: e.l, h: e.h, below: e.below, area: e.area,
      topN: e.topN, botN: e.botN, starter: e.starter, plate: e.plate, blind: e.blind,
      rebar: e.rebar || {}, notes: [e.notes, e.source ? '(' + e.source + ')' : ''].filter(Boolean).join(' ')
    });
  }
  BP.planInsert = function planInsert(id, did) {
    var p = BP.projById(id), reg = _docs[id]; if (!p || !reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0];
    if (!d || !d.report) return;
    var pl = planOf(p), rep = d.report, added = 0, replaced = 0;
    (rep.elements || []).forEach(function (e, j) {
      var cb = document.getElementById('bpPick_' + did + '_' + j);
      if (cb && !cb.checked) return;
      var el = reportEl(e);
      var hit = -1;
      pl.elements.forEach(function (x, k) { if (el.name && x.name === el.name) hit = k; });
      if (hit >= 0) { el.id = pl.elements[hit].id; pl.elements[hit] = el; replaced++; }
      else { pl.elements.push(el); added++; }
    });
    var sh = rep.sheet || {};
    if (!pl.engineer && sh.engineer) pl.engineer = String(sh.engineer);
    if (!pl.drawingNo && sh.drawingNo) pl.drawingNo = String(sh.drawingNo);
    if (!pl.date && sh.date) pl.date = String(sh.date);
    if (sh.concrete && /^ב-\d+$/.test(String(sh.concrete).trim())) pl.concrete = String(sh.concrete).trim();
    pl.sel = Math.max(0, pl.elements.length - 1);
    p.plan = BP.normPlan(pl);
    BP.saveP();
    BP.toast('\u2705 ' + BP.tt(added + ' נוספו, ' + replaced + ' עודכנו', 'เพิ่ม ' + added + ' อัปเดต ' + replaced, 'أُضيف ' + added + '، حُدّث ' + replaced));
    repaint(id);
  };
  // The drawing drives the parametric model. Geometry maps directly;
  // steel sections are matched against the catalogue by normalised name
  // (RHS 120/120/5 == SHS 120x120x5) and left untouched when there is no
  // match — a section the catalogue does not know cannot be priced, so it
  // is reported rather than silently substituted.
  function profKey(s) {
    return String(s || '').toLowerCase().replace(/[\s\u00d7*\/]+/g, function (c) { return /[\s]/.test(c) ? '' : 'x'; })
      .replace(/^shs/, 'rhs').replace(/^upn|^u(?=\d)/, 'c').replace(/x+/g, 'x');
  }
  function matchProfile(name, groups) {
    var k = profKey(name); if (!k) return null;
    var hit = null;
    (BP.C.profiles || []).forEach(function (x) {
      if (hit) return;
      if (groups && groups.indexOf(x.group) < 0) return;
      if (profKey(x.name) === k) hit = x.name;
    });
    return hit;
  }
  BP.planApply = function planApply(id, did) {
    var p = BP.projById(id), reg = _docs[id]; if (!p || !reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0];
    var st = d && d.report && d.report.structure;
    if (!st || !st.present) return;
    var dm = p.dims, miss = [];
    var num = function (v) { var n = Number(v); return isFinite(n) && n > 0 ? n : 0; };
    if (num(st.bay)) dm.bay = num(st.bay);
    if (num(st.length)) dm.length = num(st.length);
    else if (num(st.colsPerLine) > 1 && num(st.bay)) dm.length = (num(st.colsPerLine) - 1) * num(st.bay);
    if (num(st.span)) dm.span = num(st.span);
    if (num(st.eaves)) dm.eaves = num(st.eaves);
    if (st.roofType === 'mono' || st.roofType === 'flat') dm.roofType = 'mono';
    else if (st.roofType === 'gable') dm.roofType = 'gable';
    if (num(st.slope)) dm.pitch = num(st.slope);
    else if (num(st.ridge) && num(st.eaves) && num(dm.span)) {
      var run = dm.roofType === 'mono' ? dm.span : dm.span / 2;
      dm.pitch = Math.round(Math.atan((num(st.ridge) - num(st.eaves)) / run) * 180 / Math.PI * 10) / 10;
    }
    if (st.roofType === 'flat') dm.pitch = Math.max(dm.pitch || 0, 2);
    dm.colLines = (Number(st.lines) >= 3) ? 3 : 2;
    if (num(st.purlinSp)) dm.purlinSp = num(st.purlinSp);
    var MAIN = ['עמודים / קורות', 'פרופיל מרובע', 'פרופיל מלבני'];   // CATALOGUE KEY
    [['colProfile', st.colProfile, MAIN], ['rafterProfile', st.rafterProfile, MAIN],
     ['purlinProfile', st.purlinProfile, ['מרישים']], ['girtProfile', st.girtProfile, ['מרישים']]].forEach(function (t) {   // CATALOGUE KEY
      if (!t[1]) return;
      var hit = matchProfile(t[1], t[2]);
      if (hit) dm[t[0]] = hit; else miss.push(t[1]);
    });
    if (st.braceMember) {
      dm.bracing = true;
      dm.braceType = /כבל|cable|wire|\u00d8?\s*8\b/i.test(st.braceMember) ? 'cable' : 'girt';
    }
    if (st.cornerBrace) {
      dm.haunch = true;
      var hb = matchProfile(st.cornerBrace, MAIN);
      if (hb) dm.haunchProfile = hb; else miss.push(st.cornerBrace);
    }
    // footings from the pad detail on the same document, if it has one
    var pad = (d.report.elements || []).filter(function (e) { return e.kind === 'pad'; })[0];
    if (pad) {
      var pe = reportEl(pad);
      dm.footings = true; dm.footW = Math.max(pe.w, pe.l); dm.footD = pe.h;
      if (typeof Rebar !== 'undefined') dm.rebar = Rebar.norm(pe.rebar);
    }
    p.dims = BP.normProject({ dims: dm }).dims;
    BP.saveP();
    BP.toast('\u2705 ' + BP.tt('המודל עודכן לפי התוכנית', 'อัปเดตโมเดลแล้ว', 'تم تحديث النموذج') +
      (miss.length ? ' \u00b7 \u26a0\ufe0f ' + BP.tt('לא בקטלוג: ', 'ไม่มีในแคตตาล็อก: ', 'غير موجود في الكتالوج: ') + miss.join(', ') : ''));
    BP._tab = 'design';
    repaint(id);
  };
  BP.planNotesFrom = function planNotesFrom(id, did) {
    var p = BP.projById(id), reg = _docs[id]; if (!p || !reg) return;
    var d = reg.docs.filter(function (x) { return x.id === did; })[0];
    if (!d || !d.report) return;
    var pl = planOf(p), lines = [];
    (d.report.other || []).forEach(function (s) { lines.push('\u2022 ' + s); });
    (d.report.questions || []).forEach(function (s) { lines.push('? ' + s); });
    var block = '[' + d.name + ']\n' + lines.join('\n');
    if (pl.notes.indexOf('[' + d.name + ']') >= 0) return;
    pl.notes = (pl.notes ? pl.notes + '\n\n' : '') + block;
    BP.saveP(); repaint(id);
  };

  function docsCard(p) {
    var id = p.id, pl = planOf(p), reg = _docs[id];
    var muted = 'color:var(--text-muted,#888);';
    var acc = 'var(--accent,#ff9f43)';
    if (!reg) {
      docsLoad(id, function () { if (BP._tab === 'plan' && BP._open === id) BP.open(id); });
    }
    var upload = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
      '<label class="bp-btn" style="cursor:pointer;">\ud83d\udcce ' +
        BP.tt('העלה תוכניות / מסמכים', 'อัปโหลดแบบ/เอกสาร', 'رفع مخططات / مستندات') +
        '<input type="file" multiple accept="image/*,application/pdf" style="display:none;" onchange="BuildPlan.planUpload(' + id + ',this)"></label>' +
      BP.planModelSelect() +
      (reg && reg.docs.some(function (x) { return !x.report; })
        ? '<button class="bp-btn ghost" onclick="BuildPlan.planReadAll(' + id + ')">\ud83d\udd0e ' + BP.tt('קרא את כל מה שלא נקרא', 'อ่านที่ยังไม่อ่าน', 'اقرأ ما لم يُقرأ') + '</button>' : '') +
      '<span style="font-size:.72rem;' + muted + '">' + BP.tt('PDF או צילום. קריאה = קריאת מודל, רק בלחיצה, נשמרת עם המסמך.', 'PDF/รูป อ่านเมื่อกดเท่านั้น', 'PDF أو صورة. القراءة عند الضغط فقط وتُحفظ') + '</span>' +
    '</div>';

    var list = '';
    if (!reg) {
      list = '<div style="padding:12px;text-align:center;' + muted + '">\u23f3</div>';
    } else if (!reg.docs.length) {
      list = '<div class="bp-empty" style="margin-top:8px;">' + BP.tt('אין עדיין מסמכים בפרויקט. העלה את תוכנית הקונסטרוקטור, פרטי היסודות, כתב הכמויות — כל מה שקיבלת.', 'ยังไม่มีเอกสาร', 'لا مستندات بعد') + '</div>';
    } else {
      list = reg.docs.map(function (d) {
        var open = _openDoc[id] === d.id, busy = !!_busy[d.id];
        var status = busy ? '<span style="color:' + acc + ';">\u23f3 ' + BP.tt('קורא…', 'กำลังอ่าน…', 'جارٍ القراءة…') + '</span>'
                   : (d.report && staleRead(d)) ? '<span style="color:var(--warn,#e0a030);font-weight:700;">\u26a0\ufe0f ' + BP.tt('נקרא בקורא הישן — הערכים אינם אמינים, קרא שוב', 'อ่านด้วยตัวอ่านเก่า — อ่านใหม่', 'قُرئ بالقارئ القديم — أعد القراءة') + '</span>'
                   : d.report ? '<span style="color:var(--ok,#41c47f);">\u2705 ' + BP.tt('נקרא', 'อ่านแล้ว', 'مقروء') + ' \u00b7 ' + ((d.report.elements || []).length) + ' ' + BP.tt('אלמנטים', 'ชิ้นส่วน', 'عناصر') + '</span>'
                   : d.error ? '<span style="color:var(--warn,#e2624b);">\u26a0\ufe0f ' + BP.esc(d.error.slice(0, 80)) + '</span>'
                   : '<span style="' + muted + '">' + BP.tt('טרם נקרא', 'ยังไม่อ่าน', 'لم يُقرأ') + '</span>';
        var row = '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;padding:7px 0;border-top:1px solid rgba(255,255,255,.07);">' +
          '<div style="min-width:0;"><b style="cursor:pointer;" onclick="BuildPlan.planDocToggle(' + id + ',\'' + d.id + '\')">' +
            (/pdf/i.test(d.type) ? '\ud83d\udcc4' : '\ud83d\uddbc') + ' ' + BP.esc(d.name) + '</b>' +
            '<div style="font-size:.72rem;' + muted + '">' + fmtSize(d.size) + (d.at ? ' \u00b7 ' + new Date(d.at).toLocaleDateString('he-IL') : '') + (d.by ? ' \u00b7 ' + BP.esc(d.by) : '') + ' \u00b7 ' + status + '</div></div>' +
          '<div style="display:flex;gap:4px;flex-wrap:wrap;">' +
            '<button class="bp-btn ghost" style="padding:4px 8px;font-size:.72rem;" onclick="BuildPlan.planDocOpen(' + id + ',\'' + d.id + '\')">\ud83d\udc41</button>' +
            (busy ? '' : '<button class="bp-btn ' + (d.report && !staleRead(d) ? 'ghost' : '') + '" style="padding:4px 8px;font-size:.72rem;" onclick="BuildPlan.planRead(' + id + ',\'' + d.id + '\')">\ud83d\udd0e ' + BP.tt(d.report ? 'קרא שוב' : 'קרא', d.report ? 'อ่านอีก' : 'อ่าน', d.report ? 'اقرأ مجدداً' : 'اقرأ') + '</button>') +
            (busy ? '' : '<button class="bp-btn ghost" style="padding:4px 8px;font-size:.72rem;" title="' + BP.tt('קרא מהקובץ שבמכשיר — תמיד ברזולוציה מלאה', 'อ่านจากไฟล์ในเครื่อง', 'اقرأ من الملف على الجهاز') + '" onclick="BuildPlan.planReadLocal(' + id + ',\'' + d.id + '\')">\ud83d\udcc1</button>') +
            (d.report ? '<button class="bp-btn" style="padding:4px 8px;font-size:.72rem;" onclick="BuildPlan.planModel(' + id + ',\'' + d.id + '\')">\ud83e\uddca ' + BP.tt('מודל', 'โมเดล', 'نموذج') + '</button>' : '') +
            '<button class="bp-btn ghost" style="padding:4px 8px;font-size:.72rem;" onclick="BuildPlan.planDocToggle(' + id + ',\'' + d.id + '\')">' + (open ? '\u25b4' : '\u25be') + '</button>' +
            '<button class="bp-btn warn" style="padding:4px 8px;font-size:.72rem;" onclick="BuildPlan.planDocDel(' + id + ',\'' + d.id + '\')">\ud83d\uddd1</button>' +
          '</div></div>';
        if (!open) return row;

        var body = '<div style="padding:4px 0 10px;">' +
          '<div style="margin-bottom:6px;"><div class="bp-lbl">' + BP.tt('הקשר למודל (לא חובה)', 'บริบทให้โมเดล', 'سياق للنموذج') + '</div>' +
            '<input class="bp-in" value="' + BP.esc(d.hint) + '" placeholder="' + BP.esc(BP.tt('למשל: סככה 12×30, יסודות לעמודי פלדה, אדמת חמרה', 'เช่น โรงเรือน 12×30', 'مثلاً: سقيفة 12×30')) + '" onchange="BuildPlan.planDocHint(' + id + ',\'' + d.id + '\',this.value)"></div>';
        if (d.report) {
          var rep = d.report, sh = rep.sheet || {};
          body += '<div style="font-size:.8rem;margin-bottom:6px;">' +
            (sh.title ? '<b>' + BP.esc(sh.title) + '</b> \u00b7 ' : '') +
            [sh.engineer, sh.drawingNo, sh.date, sh.concrete].filter(Boolean).map(BP.esc).join(' \u00b7 ') +
            '<div style="margin-top:4px;">' + BP.esc(sh.summary || '') + '</div>' +
            '<div style="font-size:.7rem;' + muted + 'margin-top:3px;">' + BP.esc(d.model) + (d.usage ? ' \u00b7 ' + d.usage.input + ' / ' + d.usage.output + ' tokens' : '') + '</div></div>';
          var st = rep.structure;
          if (st && st.present) {
            body += '<div style="font-size:.8rem;padding:6px 8px;border-radius:8px;background:rgba(255,159,67,.10);margin-bottom:8px;">' +
              '<b>\ud83c\udfd7 ' + BP.tt('השלד לפי התוכנית', 'โครงตามแบบ', 'الهيكل حسب المخطط') + '</b> ' +
              (st.confidence === 'low' ? '\ud83d\udfe0' : st.confidence === 'medium' ? '\ud83d\udfe1' : '\ud83d\udfe2') +
              '<div dir="ltr" style="text-align:left;margin-top:3px;">' +
                [st.lines ? st.lines + ' ' + BP.tt('קווי עמודים', 'แนวเสา', 'خطوط') : '',
                 st.colsPerLine ? '\u00d7 ' + st.colsPerLine : '',
                 st.bay ? '@ ' + st.bay + ' m' : '',
                 st.span ? BP.tt('רוחב', 'กว้าง', 'عرض') + ' ' + st.span + ' m' : '',
                 st.length ? BP.tt('אורך', 'ยาว', 'طول') + ' ' + st.length + ' m' : '',
                 st.eaves ? 'H ' + st.eaves + (st.ridge ? '\u2013' + st.ridge : '') + ' m' : '',
                 st.roofType ? st.roofType + (st.slope ? ' ' + st.slope + '\u00b0' : '') : '',
                 st.colProfile ? BP.tt('עמודים', 'เสา', 'أعمدة') + ' ' + st.colProfile : '',
                 st.rafterProfile ? BP.tt('קורות', 'คาน', 'روافد') + ' ' + st.rafterProfile : '',
                 st.purlinProfile ? BP.tt('מרישים', 'แป', 'مدادات') + ' ' + st.purlinProfile : '',
                 st.braceMember ? BP.tt('ייצוב', 'ค้ำยัน', 'تثبيت') + ' ' + st.braceMember : '',
                 st.cornerBrace ? BP.tt('חיזוק פינה', 'ฮันช์', 'تقوية') + ' ' + st.cornerBrace : '',
                 st.basePlate ? BP.tt('פלטה', 'แผ่น', 'صفيحة') + ' ' + st.basePlate : '',
                 st.anchorBolts || ''].filter(Boolean).map(BP.esc).join(' \u00b7 ') + '</div>' +
              (st.notes ? '<div style="' + muted + 'margin-top:3px;">' + BP.esc(st.notes) + '</div>' : '') +
              '<button class="bp-btn" style="margin-top:6px;" onclick="BuildPlan.planApply(' + id + ',\'' + d.id + '\')">\ud83c\udfd7 ' +
                BP.tt('החל על המודל (שלד, יסודות, כתב כמויות)', 'ใช้กับโมเดล', 'طبّق على النموذج') + '</button>' +
            '</div>';
          }
          var els = rep.elements || [];
          body += '<div class="bp-lbl">' + BP.tt('אלמנטים שנקראו — סמן מה להכניס לפרויקט', 'ชิ้นส่วนที่อ่านได้ เลือกเพื่อเพิ่ม', 'العناصر المقروءة — اختر ما يُدرج') + '</div>';
          if (!els.length) body += '<div style="font-size:.78rem;' + muted + '">' + BP.tt('לא זוהו אלמנטים קונסטרוקטיביים במסמך הזה.', 'ไม่พบชิ้นส่วน', 'لم تُرصد عناصر') + '</div>';
          els.forEach(function (e, j) {
            var el = reportEl(e), r = el.rebar;
            var exists = pl.elements.some(function (x) { return el.name && x.name === el.name; });
            var conf = e.confidence === 'low' ? '\ud83d\udfe0' : e.confidence === 'medium' ? '\ud83d\udfe1' : '\ud83d\udfe2';
            var dims = el.kind === 'slab' ? el.area + ' m\u00b2 \u00d7 ' + el.h : el.kind === 'pier' ? '\u00d8' + el.w + ' \u00d7 ' + el.h : el.w + ' \u00d7 ' + el.l + ' \u00d7 ' + el.h;
            var spec = el.kind === 'slab' ? ((typeof Rebar !== 'undefined') ? Rebar.slabLabel(r) : '')
                     : isCage(el.kind) ? ((typeof Rebar !== 'undefined') ? Rebar.summaryLabel(r) : '')
                     : el.topN + '+' + el.botN + '\u00d8' + r.mainD + ' \u00b7 \u00d8' + r.stirD + '@' + r.stirSp;
            body += '<label style="display:flex;gap:8px;align-items:flex-start;font-size:.8rem;padding:5px 0;border-top:1px solid rgba(255,255,255,.05);cursor:pointer;">' +
              '<input type="checkbox" id="bpPick_' + d.id + '_' + j + '"' + (e.confidence === 'low' ? '' : ' checked') + '>' +
              '<div><b>' + ICON[el.kind] + ' ' + BP.esc(el.name || kindLabel(el.kind)) + '</b>' + (el.count > 1 ? ' \u00d7' + el.count : '') +
                ' <span style="' + muted + '">' + kindLabel(el.kind) + '</span> ' + conf +
                (exists ? ' <span style="font-size:.68rem;padding:1px 6px;border-radius:8px;background:rgba(255,159,67,.2);">' + BP.tt('יחליף קיים', 'แทนที่', 'سيستبدل') + '</span>' : '') +
                '<div dir="ltr" style="text-align:left;">' + dims + ' m \u00b7 ' + BP.esc(spec) + '</div>' +
                (e.notes ? '<div style="' + muted + '">' + BP.esc(e.notes) + '</div>' : '') +
              '</div></label>';
          });
          if ((rep.other || []).length) {
            body += '<div class="bp-lbl" style="margin-top:8px;">' + BP.tt('עוד דברים שכתובים במסמך', 'สิ่งอื่นในเอกสาร', 'أمور أخرى في المستند') + '</div>' +
              '<ul style="margin:0;padding-inline-start:18px;font-size:.78rem;">' + rep.other.map(function (s) { return '<li>' + BP.esc(s) + '</li>'; }).join('') + '</ul>';
          }
          if ((rep.questions || []).length) {
            body += '<div class="bp-lbl" style="margin-top:8px;color:' + acc + ';">\u2753 ' + BP.tt('לשאול את הקונסטרוקטור', 'ถามวิศวกร', 'اسأل المهندس') + '</div>' +
              '<ul style="margin:0;padding-inline-start:18px;font-size:.78rem;">' + rep.questions.map(function (s) { return '<li>' + BP.esc(s) + '</li>'; }).join('') + '</ul>';
          }
          body += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">' +
            (els.length ? '<button class="bp-btn" onclick="BuildPlan.planInsert(' + id + ',\'' + d.id + '\')">\u2b07 ' + BP.tt('הכנס את המסומנים לפרויקט', 'เพิ่มที่เลือก', 'أدرج المحدد') + '</button>' : '') +
            (((rep.other || []).length || (rep.questions || []).length) ? '<button class="bp-btn ghost" onclick="BuildPlan.planNotesFrom(' + id + ',\'' + d.id + '\')">\ud83d\udcdd ' + BP.tt('העתק הערות ושאלות לתוכנית', 'คัดลอกหมายเหตุ', 'انسخ الملاحظات') + '</button>' : '') +
            '</div>';
        } else if (!busy) {
          body += '<div style="font-size:.78rem;' + muted + '">' + BP.tt('לחץ "קרא" כדי שהמערכת תוציא מהמסמך את היסודות, העמודים, הקורות והזיון.', 'กด "อ่าน" เพื่อดึงข้อมูล', 'اضغط "اقرأ" لاستخراج العناصر') + '</div>';
        }
        return row + body + '</div>';
      }).join('');
    }

    return '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\ud83d\udcd0 ' + BP.tt('תוכניות ומסמכים של הפרויקט', 'แบบและเอกสารโครงการ', 'مخططات ومستندات المشروع') + '</div>' +
      upload + list +
      '<div class="bp-grid" style="margin-top:12px;">' +
        fld(BP.tt('קונסטרוקטור', 'วิศวกร', 'المهندس'), in_(id, 'engineer', pl.engineer)) +
        fld(BP.tt('מס\' תוכנית', 'เลขที่แบบ', 'رقم المخطط'), in_(id, 'drawingNo', pl.drawingNo)) +
        fld(BP.tt('תאריך', 'วันที่', 'التاريخ'), in_(id, 'date', pl.date, '', 'date')) +
        fld(BP.tt('דרגת בטון', 'เกรดคอนกรีต', 'درجة الخرسانة'),
          '<select class="bp-in" onchange="BuildPlan.planSet(' + id + ',\'concrete\',this.value)">' +
            GRADES.map(function (g) { return '<option value="' + g + '"' + (pl.concrete === g ? ' selected' : '') + '>' + g + '</option>'; }).join('') + '</select>') +
      '</div>' +
      '<div style="margin-top:8px;"><div class="bp-lbl">' + BP.tt('הערות ושאלות', 'หมายเหตุ', 'ملاحظات') + '</div>' +
        '<textarea class="bp-in" rows="3" onchange="BuildPlan.planSet(' + id + ',\'notes\',this.value)">' + BP.esc(pl.notes) + '</textarea></div>' +
    '</div>';
  }

  // Lines from the plan replace lines from the plan — flagged `plan` (kept
  // by normProject) so a second press does not double the steel. Extras
  // typed by hand are left alone.
  BP.planToTakeoff = function planToTakeoff(id) {
    var p = BP.projById(id); if (!p) return;
    var rows = planTakeoff(p);
    p.extras = (p.extras || []).filter(function (e) { return !e.plan; });
    rows.forEach(function (x) { p.extras.push({ name: x.name, qty: x.qty, unit: x.unit, plan: true }); });
    BP.saveP();
    BP.toast('\u2705 ' + BP.tt(rows.length + ' שורות נוספו לכתב הכמויות', 'เพิ่ม ' + rows.length + ' รายการ', 'أُضيفت ' + rows.length + ' بنود'));
    BP._tab = 'materials';
    repaint(id);
  };

  BP.planPrint = function planPrint(id) {
    var p = BP.projById(id); if (!p) return;
    var pl = planOf(p);
    var body = '';
    pl.elements.forEach(function (el) {
      var r = el.rebar, k = el.kind;
      var dims = k === 'slab' ? el.area + ' m\u00b2 \u00d7 ' + el.h + ' m'
               : k === 'pier' ? '\u00d8' + el.w + ' \u00d7 ' + el.h + ' m'
               : el.w + ' \u00d7 ' + el.l + ' \u00d7 ' + el.h + ' m';
      var spec = k === 'slab' ? ((typeof Rebar !== 'undefined') ? Rebar.slabLabel(r) : '')
               : isCage(k) ? ((typeof Rebar !== 'undefined') ? Rebar.summaryLabel(r) : '')
               : el.topN + '+' + el.botN + '\u00d8' + r.mainD + ' + \u00d8' + r.stirD + '@' + r.stirSp;
      body += '<h2>' + ICON[k] + ' ' + BP.esc(el.name || kindLabel(k)) + (el.count > 1 ? ' \u00d7 ' + el.count : '') +
        ' <small>' + kindLabel(k) + '</small></h2>' +
        '<p><b>' + dims + '</b> \u00b7 <span dir="ltr">' + BP.esc(spec) + '</span>' +
        (el.below ? ' \u00b7 ' + BP.tt('ראש', 'หัว', 'رأس') + ' ' + el.below + ' m ' + BP.tt('מתחת לקרקע', 'ใต้ดิน', 'تحت الأرض') : '') + '</p>' +
        (isCage(k) && typeof Rebar !== 'undefined'
          ? '<div class="d">' + Rebar.detailSvg(r, { w: el.w, d: el.h, postW: 0.1, title: el.name || kindLabel(k) }, { print: true }) + '</div>' : '') +
        '<table>' + parts(el, pl).map(function (x) {
          return '<tr><th>' + BP.esc(x.name) + '<br><span dir="ltr">' + BP.esc(x.spec) + '</span></th><td>' + BP.esc(x.what) +
            '<br><i>\ud83d\uded2 ' + BP.esc(x.store) + '</i><br><i>\ud83d\udd00 ' + BP.esc(x.alt) + ' [' + BP.esc(x.whose) + ']</i></td></tr>';
        }).join('') + '</table>';
    });
    var shop = shopping(pl);
    var html = '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' +
      BP.esc(p.name) + '</title><style>' +
      '@page{size:A4;margin:12mm}body{font-family:Arial,Helvetica,sans-serif;color:#222;font-size:12px;margin:0;direction:rtl}' +
      'h1{font-size:18px;margin:0 0 4px}h2{font-size:14px;margin:14px 0 4px;border-bottom:1px solid #999;page-break-after:avoid}' +
      'small{font-weight:400;color:#666}table{width:100%;border-collapse:collapse;margin-top:4px}' +
      'th,td{border:1px solid #ccc;padding:4px 6px;vertical-align:top;text-align:right}th{width:28%;background:#f2f2f2}' +
      'i{color:#555;font-style:normal}.d{direction:ltr;max-width:170mm;margin:6px auto}.d svg{width:100%;height:auto}' +
      'ul{padding-inline-start:18px}p{margin:2px 0}.meta{color:#555;margin-bottom:6px}' +
      '</style></head><body>' +
      '<h1>\ud83d\udcd0 ' + BP.tt('תוכנית קונסטרוקטור — הסבר לבנאי', 'แบบวิศวกร — คำอธิบาย', 'مخطط المهندس — شرح') + ' \u2014 ' + BP.esc(p.name) + '</h1>' +
      '<div class="meta">' + BP.esc(pl.engineer) + (pl.drawingNo ? ' \u00b7 ' + BP.esc(pl.drawingNo) : '') + (pl.date ? ' \u00b7 ' + BP.esc(pl.date) : '') +
        ' \u00b7 ' + BP.tt('בטון', 'คอนกรีต', 'خرسانة') + ' ' + BP.esc(pl.concrete) + '</div>' +
      (pl.notes ? '<p>' + BP.esc(pl.notes) + '</p>' : '') +
      body +
      '<h2>\ud83d\uded2 ' + BP.tt('רשימת קניות', 'รายการซื้อ', 'قائمة الشراء') + '</h2><ul>' +
        shop.map(function (s) { return '<li>' + BP.esc(s) + '</li>'; }).join('') + '</ul>' +
      '<p class="meta">' + BP.tt('המסמך מצייר ומסביר את מה שנכתב בתוכנית. הוא אינו תכנון ואינו מחליף את הקונסטרוקטור.', 'เอกสารนี้อธิบายแบบ ไม่ใช่การออกแบบ', 'هذه الوثيقة شرح للمخطط وليست تصميماً') + '</p>' +
      '</body></html>';
    var w = window.open('', '_blank');
    if (!w) { BP.toast('\u26a0\ufe0f ' + BP.tt('חסום חלונות קופצים', 'ป๊อปอัพถูกบล็อก', 'النوافذ محجوبة')); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 350);
  };

  BP.planDestroy = destroy3d;

  // Handlers named in inline attributes have to exist on the global. One
  // per line so preflight can see each of them.
  BuildPlan.planTab       = BP.planTab;
  BuildPlan.planMount     = BP.planMount;
  BuildPlan.planSet       = BP.planSet;
  BuildPlan.planAdd       = BP.planAdd;
  BuildPlan.planDel       = BP.planDel;
  BuildPlan.planSel       = BP.planSel;
  BuildPlan.planEl        = BP.planEl;
  BuildPlan.planRebar     = BP.planRebar;
  BuildPlan.plan3dView    = BP.plan3dView;
  BuildPlan.plan3dReset   = BP.plan3dReset;
  BuildPlan.planUpload    = BP.planUpload;
  BuildPlan.planDocOpen   = BP.planDocOpen;
  BuildPlan.planReadLocal = BP.planReadLocal;
  BuildPlan.planModel     = BP.planModel;
  BuildPlan.planDocDel    = BP.planDocDel;
  BuildPlan.planDocToggle = BP.planDocToggle;
  BuildPlan.planDocHint   = BP.planDocHint;
  BuildPlan.planRead      = BP.planRead;
  BuildPlan.planModelSet  = BP.planModelSet;
  BuildPlan.planReadAll   = BP.planReadAll;
  BuildPlan.planInsert    = BP.planInsert;
  BuildPlan.planApply     = BP.planApply;
  BuildPlan.planNotesFrom = BP.planNotesFrom;
  BuildPlan.planToTakeoff = BP.planToTakeoff;
  BuildPlan.planPrint     = BP.planPrint;

})(BuildPlanInternals);
