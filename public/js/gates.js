/* gates.js — תכנון שערים (gate designer)
 * ------------------------------------------------------------------
 * Perimeter gates as they are actually built here: galvanised RHS frame,
 * welded mesh infill, diagonal corner bracing, concrete-set posts.
 *
 * FOUR TYPES, because the type changes the quantities completely:
 *   swing1  כנף אחת       — one leaf, two posts
 *   swing2  שתי כנפיים    — two leaves, two posts, centre drop bolt
 *   slide   הזזה על מסילה — one leaf + a rail and a ground track
 *   cantil  קונזולי       — one leaf plus a counterweight tail, no ground
 *                           track, so it works on an unpaved approach
 *
 * KRANIYIM (קרניים) — the angled arms above the posts, leaning toward
 * whoever is arriving, with the mesh carried up onto them. On the
 * engineer's sheet this is "שער עם קרן": it is what stops the gate being
 * climbed, and it is a cantilever on top of a cantilever, so it is added
 * to the post moment rather than drawn and forgotten.
 *
 * The counterweight tail is the thing people forget when pricing a
 * cantilever gate: the leaf continues past the opening by roughly half the
 * clear width again, and that steel is real. It is computed, not ignored.
 *
 * A gate has no structural check here. Span, wind area and hinge loads on a
 * 6 m leaf are a fabricator's problem, and pretending otherwise would be
 * worse than saying nothing.
 */
var Gates = (function () {
  'use strict';

  var TYPES = ['swing1', 'swing2', 'slide', 'cantil'];

  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  A FIRST-PASS STRUCTURAL CHECK
  // ══════════════════════════════════════════════════════════════════
  // The header of this file used to say a gate gets no structural check
  // because hinge loads on a 6 m leaf are a fabricator's problem. That was
  // half right: a full check is, but the three numbers below are the ones
  // that actually decide whether a gate sags, and leaving them out meant a
  // 6 m leaf could be quoted on 40x40 tube with nothing to say otherwise.
  //
  // What this is: the same first-pass arithmetic the shed uses — allowable
  // stress, one governing action per member, linear combination. What it
  // is NOT: a design. Fatigue at the hinges, weld detailing, and the soil
  // under the foundation are all outside it, and a red badge means stop,
  // not "add 10%".
  //
  // Wy in cm3, A in cm2, i in cm — EN 10219 cold-formed hollow sections.
  var GSECT = {
    'SHS 40x40x2':   { wy: 3.37, ar: 2.95, iz: 1.54 },
    'SHS 40x40x3':   { wy: 4.60, ar: 4.25, iz: 1.49 },
    'RHS 60x40x2':   { wy: 6.15, ar: 3.75, iz: 1.53 },
    'RHS 60x40x3':   { wy: 8.44, ar: 5.45, iz: 1.49 },
    'SHS 60x60x3':   { wy: 11.5, ar: 6.65, iz: 2.29 },
    'SHS 60x60x4':   { wy: 14.2, ar: 8.55, iz: 2.25 },
    'RHS 80x40x3':   { wy: 12.4, ar: 6.65, iz: 1.52 },
    'RHS 80x40x4':   { wy: 15.5, ar: 8.55, iz: 1.48 },
    'SHS 80x80x3':   { wy: 21.0, ar: 9.05, iz: 3.11 },
    'SHS 80x80x4':   { wy: 27.2, ar: 11.7, iz: 3.00 },
    'RHS 100x50x3':  { wy: 20.9, ar: 8.55, iz: 2.00 },
    'RHS 100x50x4':  { wy: 26.6, ar: 11.1, iz: 1.96 },
    'SHS 100x100x4': { wy: 44.3, ar: 14.9, iz: 3.90 },
    'SHS 100x100x5': { wy: 53.8, ar: 18.4, iz: 3.85 },
    'RHS 120x60x4':  { wy: 39.5, ar: 13.4, iz: 2.40 },
    'SHS 120x120x5': { wy: 80.3, ar: 22.4, iz: 4.66 },
    'SHS 150x150x5': { wy: 128, ar: 28.4, iz: 5.89 },
    'SHS 150x150x6': { wy: 152, ar: 33.6, iz: 5.83 }
  };
  // A catalogue name is written a dozen ways on site. Match on the digits.
  function sect(name) {
    if (GSECT[name]) return GSECT[name];
    var key = String(name || '').replace(/[^0-9]/g, '');
    for (var k in GSECT) {
      if (GSECT.hasOwnProperty(k) && k.replace(/[^0-9]/g, '') === key) return GSECT[k];
    }
    return null;
  }

  var F_ALLOW  = 160;    // MPa, allowable bending stress
  var WIND     = 0.5;    // kN/m2
  var MESH_KG  = 6;      // kg/m2 of welded mesh infill
  var STEEL_KG = 0.785;  // kg/m per cm2 of section

  // Mesh lets most of the wind through; a sheeted leaf does not. The infill
  // description is the only thing that says which, so read it.
  function solidity(g) {
    return /פח|איסכורית|לוח|אטום/.test(String(g.mesh || '')) ? 1.0 : 0.35;
  }

  function leafWeight(g) {
    var s = summary(g);
    var fs = sect(g.frame);
    var frameLen = 2 * (s.leafW + s.tail + g.height) + g.infillRows * (s.leafW + s.tail);
    var steel = frameLen * (fs ? fs.ar * STEEL_KG : 4);
    var mesh = (s.leafW + s.tail) * g.height * MESH_KG;
    return (steel + mesh) * 0.00981;    // kN
  }

  // role: 'post' | 'frame' | 'found'
  function check(g, role) {
    g = norm(g);
    var s = summary(g);
    var util = 0, why = '', M = 0, sc = null, name = '';

    if (role === 'frame') {
      // The top rail of a leaf spans the leaf and carries half of what the
      // leaf weighs, plus wind on its tributary strip. It is the member
      // that shows a sagging gate first.
      name = g.frame; sc = sect(name);
      if (!sc) return { known: false, role: role, name: name };
      var Lm = s.leafW + s.tail;
      var w = (leafWeight(g) / 2) / Math.max(Lm, 0.1) +
              WIND * solidity(g) * (g.height / 2);
      M = w * Lm * Lm / 8;
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = tt('כפיפה + רוח', 'ดัด + ลม', 'انحناء + رياح');

    } else if (role === 'post') {
      // A swing post is a cantilever with the leaf hung off one side. The
      // eccentric weight, not the wind, is usually what bends it — which is
      // why a post sized on wind alone leans within a season.
      name = g.post; sc = sect(name);
      if (!sc) return { known: false, role: role, name: name };
      var Wl = leafWeight(g);
      var ecc = (g.type === 'swing1' || g.type === 'swing2') ? (s.leafW + s.tail) / 2 : 0.15;
      var Fw = WIND * solidity(g) * (s.leafW + s.tail) * g.height;   // kN on the leaf
      M = Wl * ecc + Fw * (g.height / 2);
      // A horn is a cantilever bolted to the top of a cantilever. Its own
      // weight acts on its horizontal reach, and the mesh on it catches
      // wind at the highest point on the gate, where the lever arm is
      // longest — which is exactly why an unchecked horn bends posts.
      if (g.horns) {
        var hSelf = g.hornLen * (sc.ar * STEEL_KG) * 0.00981;              // kN
        var hWind = WIND * solidity(g) * (s.hornArea / Math.max(1, (g.type === 'slide') ? 4 :
                      (g.type === 'cantil') ? 3 : 2));
        M += hSelf * s.hornProj + hWind * (g.height + s.hornRise / 2);
      }
      if (g.motor) M *= 1.15;   // operator thrust and the shock of hitting a stop
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = tt('כפיפה מתלייה + רוח', 'ดัดจากการแขวน', 'انحناء من التعليق');

    } else if (role === 'found') {
      // Overturning of an embedded post. The first version of this resisted
      // the moment with the concrete block's own weight about its toe and
      // ignored the soil "to be conservative" — which failed a 4 m gate on
      // a standard 40x40x100 block at 292%, i.e. it failed every gate ever
      // built here. A check that is always red is not conservative, it is
      // noise, and it teaches you to ignore the badge.
      //
      // The right first-pass model for a pole foundation is passive earth
      // pressure over the embedment, which is what actually holds a gate
      // post up. Kp=3 (phi≈30, granular fill) and gamma=18 kN/m3 are
      // ordinary Arava backfill; the resultant sits at D/3 above the base.
      var Kp = 3, gamma = 18;
      name = tt('יסוד', 'ฐาน', 'أساس') + ' ' +
             n1(g.postSize) + '\u00d7' + n1(g.postSize) + '\u00d7' + n1(g.postDepth);
      var D = g.postDepth, b = g.postSize;
      var Wl2 = leafWeight(g);
      var ecc2 = (g.type === 'swing1' || g.type === 'swing2') ? (s.leafW + s.tail) / 2 : 0.15;
      var Fw2 = WIND * solidity(g) * (s.leafW + s.tail) * g.height;
      var Mo = Wl2 * ecc2 + Fw2 * (g.height / 2);          // about ground level
      var Pp = 0.5 * Kp * gamma * D * D * b;               // kN, passive resultant
      var Mr = Pp * (2 * D / 3);                           // kNm about ground level
      M = Mo;
      util = Mr > 0 ? (Mo / (Mr / 1.5)) : 99;              // 1.5 against overturning
      why = tt('התהפכות · לחץ קרקע פסיבי', 'พลิกคว่ำ', 'انقلاب · ضغط تربة سلبي');
      if (!isFinite(util)) return { known: false, role: role, name: name };
      return { known: true, role: role, name: name, util: util, ok: util <= 1, M: M, why: why };
    } else {
      return { known: false, role: role, name: '' };
    }

    if (!isFinite(util)) return { known: false, role: role, name: name };
    return { known: true, role: role, name: name, util: util, ok: util <= 1,
             M: M, why: why, wy: sc.wy };
  }

  function checks(g) {
    return ['post', 'frame', 'found'].map(function (r) { return check(g, r); });
  }

  // Sections that would work, cheapest first by weight. Same idea as the
  // shed's swap list: a choice between sections that pass, not a dropdown
  // of everything in stock.
  function candidates(g, role) {
    g = norm(g);
    var out = [];
    Object.keys(GSECT).forEach(function (nm) {
      var trial = norm(JSON.parse(JSON.stringify(g)));
      if (role === 'post') trial.post = nm; else if (role === 'frame') trial.frame = nm; else return;
      var r = check(trial, role);
      if (r.known) out.push({ name: nm, util: r.util, ok: r.ok, kg: GSECT[nm].ar * STEEL_KG });
    });
    return out.sort(function (a, b) { return a.kg - b.kg; });
  }

  function roleLabel(role) {
    if (role === 'post')  return tt('עמוד', 'เสา', 'عمود');
    if (role === 'frame') return tt('מסגרת כנף', 'กรอบบาน', 'إطار المصراع');
    if (role === 'found') return tt('יסוד', 'ฐานราก', 'الأساس');
    return role;
  }

  function typeLabel(v) {
    if (v === 'swing1') return tt('כנף אחת', 'บานเดี่ยว', 'مصراع واحد');
    if (v === 'swing2') return tt('שתי כנפיים', 'บานคู่', 'مصراعان');
    if (v === 'slide')  return tt('הזזה על מסילה', 'บานเลื่อน', 'منزلق');
    if (v === 'cantil') return tt('קונזולי (ללא מסילה)', 'คานยื่น', 'كابولي');
    return v;
  }

  // ── the drawing knows what it is made of ──────────────────────────
  // A gate drawing that cannot tell you which section a member is has to
  // be read next to the takeoff table to mean anything. The shed model
  // already answers that on tap; the gate now answers it the same way,
  // because it is the same question asked of a different drawing.
  //
  // Roles map to the profile fields on the gate, not to hardcoded names:
  // change the leaf section and the frame, the rails, the bracing and the
  // cantilever tail all report the new one, because they are all cut from
  // that stick.
  var PART_ROLE = {
    post:  { icon: '\u2b1b', prof: function (g) { return g.post; },
             name: function () { return tt('עמוד', 'เสา', 'عمود'); } },
    frame: { icon: '\u25ad', prof: function (g) { return g.frame; },
             name: function () { return tt('מסגרת כנף', 'กรอบบาน', 'إطار المصراع'); } },
    rail:  { icon: '\u2501', prof: function (g) { return g.frame; },
             name: function () { return tt('מסילת ביניים', 'แปกลาง', 'مجرى وسطي'); } },
    brace: { icon: '\u2571', prof: function (g) { return g.frame; },
             name: function () { return tt('אלכסון חיזוק', 'ค้ำยันทแยง', 'دعامة قطرية'); } },
    tail:  { icon: '\u2b0c', prof: function (g) { return g.frame; },
             name: function () { return tt('זנב משקל נגדי', 'หางถ่วง', 'ذيل الموازنة'); } },
    mesh:  { icon: '\u2591', prof: function (g) { return g.mesh; },
             name: function () { return tt('מילוי רשת', 'ตะแกรง', 'حشوة شبكية'); } },
    horn:  { icon: '\u2197', prof: function (g) {
               return String(g.post || '') + ' \u00b7 ' + n1(g.hornLen) + ' m @ ' +
                      n1(g.hornAngle) + '\u00b0'; },
             name: function () { return tt('קרן', 'แขนเอียง', 'ذراع مائل'); } },
    found: { icon: '\u2b1c', prof: function (g) {
               return tt('בטון', 'คอนกรีต', 'خرسانة') + ' ' +
                      n1(g.postSize) + '\u00d7' + n1(g.postSize) + '\u00d7' + n1(g.postDepth) + ' m'; },
             name: function () { return tt('יסוד עמוד', 'ฐานเสา', 'أساس العمود'); } }
  };

  // One line, in the order a person reads it: what it is, then what it is
  // made of. Returned as parts too, so a caller can style them separately.
  function partLabel(g, role) {
    g = norm(g);
    var r = PART_ROLE[role];
    if (!r) return null;
    return { role: role, icon: r.icon, name: r.name(), profile: String(r.prof(g) || ''),
             text: r.name() + ' \u00b7 ' + String(r.prof(g) || '') };
  }

  function norm(g) {
    g = g || {};
    var t = TYPES.indexOf(g.type) >= 0 ? g.type : 'swing2';
    return {
      id: g.id || (Date.now() + Math.floor(Math.random() * 1000)),
      name: String(g.name || ''),
      type: t,
      width: Number(g.width) || 4,        // clear opening, m
      height: Number(g.height) || 2,      // leaf height, m
      frame: String(g.frame || 'RHS 60x40x2'),
      post: String(g.post || 'SHS 100x100x4'),
      mesh: String(g.mesh || 'רשת מרותכת 50/200'),
      postDepth: Number(g.postDepth) || 1.0,   // embedment, m
      postSize: Number(g.postSize) || 0.4,     // concrete cube side, m
      bracing: g.bracing === false ? false : true,
      motor: !!g.motor,
      // `|| 1` turned a deliberate 0 into 1: the control offers 0-4, but
      // a gate with no intermediate rails silently grew one — drawn, and
      // billed, as g.infillRows * leafWidth of steel nobody asked for.
      // Absent still means 1; an explicit 0 now means 0.
      infillRows: (g.infillRows === null || g.infillRows === undefined || g.infillRows === '')
                    ? 1 : Math.max(0, Number(g.infillRows) || 0),
      // ── קרניים ──
      // Off by default: every gate already built here has none, and
      // turning them on for existing records would silently add steel to
      // saved quotes.
      horns:     !!g.horns,
      hornLen:   Math.max(0.2, Math.min(1.5, Number(g.hornLen) || 0.5)),   // m along the arm
      hornAngle: Math.max(10, Math.min(75, Number(g.hornAngle) || 30)),    // deg from vertical
      // Which way the arm leans. 'out' is toward the approach — the side
      // somebody would climb from — and is the only one that does the job
      // the detail exists for; 'in' is offered because a gate on a
      // property line sometimes cannot overhang the road.
      hornDir:   (g.hornDir === 'in') ? 'in' : 'out',
      hornMesh:  g.hornMesh === false ? false : true,
      // Reinforcement inside the post foundations. Normalised by rebar.js
      // when it is loaded, kept as-is when it is not, so a gate saved with
      // a cage never loses it because of load order.
      rebar: (typeof Rebar !== 'undefined') ? Rebar.norm(g.rebar) : (g.rebar || null),
      notes: String(g.notes || '')
    };
  }

  // ── quantities ──
  // Everything returns metres of frame, m² of mesh, m³ of concrete and a
  // count of fittings, in the shape buildplan's takeoff expects.
  function takeoff(g) {
    g = norm(g);
    var s = summary(g);
    var out = [];
    function push(name, qty, unit, note) {
      if (!(qty > 0)) return;
      out.push({ name: name, qty: qty, unit: unit, note: note || '' });
    }

    var leaves = (g.type === 'swing2') ? 2 : 1;
    var leafW = (g.type === 'swing2') ? g.width / 2 : g.width;
    // A cantilever leaf runs past the opening by ~50% to carry itself.
    var tail = (g.type === 'cantil') ? g.width * 0.5 : 0;
    var totalLeafW = leafW + tail;

    // perimeter frame per leaf, plus intermediate rails
    var perLeaf = 2 * (totalLeafW + g.height) + g.infillRows * totalLeafW;
    // diagonal corner braces, one per leaf corner pair
    var diag = g.bracing ? Math.hypot(totalLeafW, g.height) * leaves : 0;
    push(g.frame, perLeaf * leaves + diag, "מ'",
      leaves + ' ' + tt('כנפיים', 'บาน', 'مصاريع') + ' ' + n1(totalLeafW) + '\u00d7' + n1(g.height) +
      (tail ? ' (' + tt('כולל זנב משקל נגדי', 'รวมหางถ่วง', 'شامل ذيل الموازنة') + ' ' + n1(tail) + ' m)' : ''));

    push(g.mesh, totalLeafW * g.height * leaves * 1.05, 'מ"ר',
      tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));

    // posts: swing needs two, slide and cantilever need a run of them
    var posts = (g.type === 'slide') ? 4 : (g.type === 'cantil') ? 3 : 2;
    push(g.post, posts * (g.height + g.postDepth), "מ'",
      posts + ' ' + tt('עמודים', 'เสา', 'أعمدة') + ' \u00b7 ' +
      tt('עומק', 'ลึก', 'عمق') + ' ' + n1(g.postDepth) + ' m');

    push('בטון ב-30', posts * g.postSize * g.postSize * g.postDepth, 'מ"ק',
      tt('יסודות עמודים', 'ฐานเสา', 'أساسات الأعمدة') + ' ' +
      n1(g.postSize) + '\u00d7' + n1(g.postSize) + '\u00d7' + n1(g.postDepth));

    // Reinforcement, itemised per bar diameter instead of billed as one
    // guessed length of Ø12. The cage is the same object the detail
    // drawing shows, so the drawing and the price cannot disagree.
    if (typeof Rebar !== 'undefined') {
      Rebar.padTakeoff(g.rebar, { n: posts, w: g.postSize, d: g.postDepth, waste: 1.05 })
        .forEach(function (r) { push(r.name, r.qty, r.unit, r.note); });
    }

    // ── קרניים ──
    // The arm itself is cut from the post stick — it is a continuation of
    // the post, welded on at an angle, not a lighter member. The rail
    // across the tips and the mesh on the sloping face are what make it a
    // barrier rather than two spikes.
    if (g.horns) {
      push(g.post, posts * g.hornLen, "מ'",
        posts + ' ' + tt('קרניים', 'แขนเอียง', 'أذرع مائلة') + ' ' +
        n1(g.hornLen) + ' m @ ' + n1(g.hornAngle) + '\u00b0 ' +
        (g.hornDir === 'in' ? tt('פנימה', 'เข้า', 'للداخل')
                            : tt('כלפי הכניסה', 'ออกด้านนอก', 'نحو المدخل')));
      push(g.frame, g.width, "מ'",
        tt('קורת ראש בין הקרניים', 'คานหัวเสา', 'عارضة علوية بين الأذرع'));
      if (g.hornMesh) {
        push(g.mesh, s.hornArea * 1.05, 'מ"ר',
          tt('רשת על הקרניים', 'ตะแกรงบนแขน', 'شبك على الأذرع'));
        push('צבע/גילוון וצביעה', s.hornArea * 2, 'מ"ר',
          tt('קרניים · שתי פנים', 'แขน สองด้าน', 'الأذرع · وجهان'));
      }
    }

    if (g.type === 'swing1' || g.type === 'swing2') {
      push('צירי שער כבדים', leaves * 2, "יח'", '');
      push('בריח נעילה', 1, "יח'", '');
      if (g.type === 'swing2') push('בריח קרקע מרכזי', 1, "יח'", '');
    } else if (g.type === 'slide') {
      // Track runs the full opening again so the leaf has somewhere to go.
      push('מסילת הזזה תחתונה', g.width * 2, "מ'", tt('כולל מקטע פתיחה', 'รวมช่วงเปิด', 'شامل مسار الفتح'));
      push('גלגלי הזזה', 4, "יח'", '');
      push('מוביל עליון', 2, "יח'", '');
    } else if (g.type === 'cantil') {
      push('עגלות נשיאה קונזוליות', 2, "יח'", tt('ללא מסילת קרקע', 'ไม่มีรางพื้น', 'بدون مسار أرضي'));
      push('פרופיל נשיאה קונזולי', totalLeafW, "מ'", '');
      push('מוביל עליון', 2, "יח'", '');
    }

    if (g.motor) {
      push('מנוע לשער', 1, "יח'",
        (g.type === 'swing1' || g.type === 'swing2')
          ? tt('זרוע/בוכנה', 'แขนกล', 'ذراع') : tt('מנוע הזזה', 'มอเตอร์เลื่อน', 'محرك انزلاق'));
      push('צנרת חשמל ופיקוד', g.width + 12, "מ'", '');
    }

    push('צבע/גילוון וצביעה', totalLeafW * g.height * leaves * 2, 'מ"ר',
      tt('שתי פנים', 'สองด้าน', 'وجهان'));

    return out;
  }

  function summary(g) {
    g = norm(g);
    var leaves = (g.type === 'swing2') ? 2 : 1;
    var leafW = (g.type === 'swing2') ? g.width / 2 : g.width;
    var tail = (g.type === 'cantil') ? g.width * 0.5 : 0;
    // The arm resolved into the two numbers everything else needs: how far
    // it reaches out over the approach, and how much higher it puts the top
    // of the gate. Both are zero when there are no horns, so every caller
    // can add them unconditionally.
    var a = g.hornAngle * Math.PI / 180;
    var hornProj = g.horns ? g.hornLen * Math.sin(a) : 0;
    var hornRise = g.horns ? g.hornLen * Math.cos(a) : 0;
    return {
      leaves: leaves, leafW: leafW, tail: tail,
      area: (leafW + tail) * g.height * leaves,
      swingRadius: (g.type === 'swing1' || g.type === 'swing2') ? leafW : 0,
      railRun: (g.type === 'slide') ? g.width * 2 : 0,
      hornLen: g.horns ? g.hornLen : 0,
      hornProj: hornProj, hornRise: hornRise,
      hornArea: (g.horns && g.hornMesh) ? g.width * g.hornLen : 0,
      topZ: g.height + hornRise
    };
  }

  // ── elevation drawing ──
  // Straight-on view, which is how a gate is quoted and checked: frame,
  // mesh grid, bracing, posts and their foundations, dimensioned.
  // The same leader convention the shed section uses: arrowhead on the
  // member, slanted leader, horizontal shelf, text on the shelf. Written
  // out again here rather than shared, because gates.js loads before
  // BuildPlan and must not depend on it at parse time.
  function gArrow(tx, ty, fx, fy, col) {
    var dx = tx - fx, dy = ty - fy, len = Math.sqrt(dx*dx + dy*dy) || 1;
    var ux = dx/len, uy = dy/len, px = -uy, py = ux, L = 8, Wd = 2.9;
    var bx = tx - ux*L, by = ty - uy*L;
    return '<path d="M' + tx + ',' + ty + ' L' + (bx + px*Wd) + ',' + (by + py*Wd) +
      ' L' + (bx - px*Wd) + ',' + (by - py*Wd) + ' Z" fill="' + col + '"/>';
  }
  function gLeader(tx, ty, bx, by, dir, lines, col) {
    lines = [].concat(lines).filter(Boolean);
    if (!lines.length) return '';
    var wide = 0;
    lines.forEach(function (t) { wide = Math.max(wide, String(t).length); });
    var shelf = Math.max(34, wide * 6.1);
    var ex = (dir === 'l') ? bx - shelf : bx + shelf;
    var out = '<line x1="' + bx + '" y1="' + by + '" x2="' + tx + '" y2="' + ty +
        '" stroke="' + col + '" stroke-width="1"/>' +
      '<line x1="' + bx + '" y1="' + by + '" x2="' + ex + '" y2="' + by +
        '" stroke="' + col + '" stroke-width="1"/>' +
      gArrow(tx, ty, bx, by, col);
    for (var i = 0; i < lines.length; i++) {
      out += '<text x="' + ex + '" y="' + (by - ((lines.length - 1 - i) * 13 + 4)) +
        '" fill="' + col + '" font-size="11" font-weight="600" text-anchor="' +
        ((dir === 'l') ? 'start' : 'end') +
        '" font-family="ui-monospace,Menlo,Consolas,monospace">' + esc(lines[i]) + '</text>';
    }
    return out;
  }

  function svg(g, opt) {
    g = norm(g);
    opt = opt || {};
    var print = !!opt.print;
    var col = {
      steel: print ? '#37474f' : 'var(--text,#cfd8dc)',
      mesh:  print ? '#90a4ae' : 'var(--text-muted,#8fa3b8)',
      conc:  print ? '#bdbdbd' : 'var(--text-muted,#9e9e9e)',
      dim:   print ? '#b34700' : 'var(--accent,#ff9f43)',
      grnd:  print ? '#8d6e63' : 'var(--text-muted,#8d6e63)'
    };
    var s = summary(g);
    // Callouts want margin, not a smaller gate: the canvas grows, the
    // drawing keeps its scale.
    var CAL = opt.callouts !== false;
    var W = CAL ? 880 : 640, H = 340, pad = 54;
    var mx = CAL ? 170 : pad;
    // The horn reaches out past the posts and up past the frame, so the
    // extents it occupies have to be in the scale calculation or the arm
    // is drawn off the top of the canvas.
    var totalW = g.width + (s.tail || 0) + (s.hornProj || 0) + 1.2;
    var totalH = g.height + (s.hornRise || 0) + g.postDepth + 0.6;
    var sc = Math.min((W - mx*2) / totalW, (H - pad*2) / totalH);
    var x0 = (W - g.width*sc) / 2, gy = H - pad - g.postDepth*sc;   // ground line

    function X(m) { return x0 + m*sc; }
    function Y(m) { return gy - m*sc; }

    // Interactive on screen, inert on paper. A quote is printed, and a
    // hover highlight in a PDF is at best a stray colour.
    var live = !print && opt.interactive !== false;

    var o = [];
    // Every member goes inside a <g> carrying its role. A <title> rides
    // along so the browser's own tooltip works even before any script has
    // run, and in contexts that never bind one at all.
    function part(role, body, hit) {
      if (!live) return body;
      var lab = partLabel(g, role);
      return '<g class="gp" data-gp="' + role + '">' +
        '<title>' + esc(lab ? lab.text : role) + '</title>' +
        (hit || '') + body + '</g>';
    }
    // Thin lines are almost impossible to hit with a finger, so each one
    // gets an invisible fat twin underneath it. Without this the feature
    // works on a mouse and not at all on the phone it is mostly used on.
    function hitLine(x1, y1, x2, y2) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
        '" class="gp-hit" stroke-width="14" stroke="transparent" fill="none"/>';
    }
    function hitRect(x, y, w, h) {
      return '<rect x="' + x + '" y="' + y + '" width="' + Math.max(w, 1) +
        '" height="' + Math.max(h, 1) + '" class="gp-hit" fill="transparent" stroke="transparent"/>';
    }

    if (live) {
      o.push('<style>' +
        '.gp{cursor:pointer}' +
        '.gp>*{transition:stroke .12s,fill .12s,opacity .12s}' +
        '.gp:hover .gp-v,.gp.gp-on .gp-v{stroke:var(--accent,#ff9f43)}' +
        '.gp:hover .gp-f,.gp.gp-on .gp-f{fill:var(--accent,#ff9f43);opacity:.85}' +
        '</style>');
    }

    // ground
    o.push('<line x1="10" y1="' + gy + '" x2="' + (W-10) + '" y2="' + gy +
      '" stroke="' + col.grnd + '" stroke-width="2"/>');

    // post foundations
    var postXs = (g.type === 'swing2' || g.type === 'swing1')
      ? [0, g.width]
      : (g.type === 'slide') ? [-0.6, 0, g.width, g.width + 0.6]
      : [0, g.width, g.width + 0.6];
    postXs.forEach(function (px) {
      var fw = g.postSize * sc;
      // Concrete first, then the cage inside it. A foundation drawn as a
      // plain grey block is why "בטון לביסוס עמודים וברזל זיוון" had to be
      // typed into the quote by hand — the drawing never showed the steel.
      var cage = (typeof Rebar !== 'undefined')
        ? Rebar.overlay(g.rebar, { x: X(px) - fw/2, y: gy, w: fw, h: g.postDepth*sc },
                        { color: print ? '#c0392b' : '#e2624b', scale: sc })
        : '';
      o.push(part('found',
        '<rect x="' + (X(px) - fw/2) + '" y="' + gy + '" width="' + fw +
          '" height="' + (g.postDepth*sc) + '" fill="' + col.conc + '" opacity=".55" class="gp-f"/>' +
          cage,
        hitRect(X(px) - fw/2, gy, fw, g.postDepth*sc)));
      o.push(part('post',
        '<rect x="' + (X(px) - 5) + '" y="' + Y(g.height + 0.25) + '" width="10" height="' +
          ((g.height + 0.25)*sc) + '" fill="' + col.steel + '" class="gp-f"/>',
        hitRect(X(px) - 9, Y(g.height + 0.25), 18, (g.height + 0.25)*sc)));
    });

    // leaves
    function leaf(lx, lw) {
      var t = 4;
      // Mesh goes down first and carries a hit rect over the whole leaf, so
      // the gaps between wires answer "mesh" instead of answering nothing.
      // Frame, rails and bracing are drawn after it and therefore sit on
      // top for hit-testing as well as for looks.
      var wires = [];
      var cells = Math.max(4, Math.round(lw / 0.2));
      for (var i = 1; i < cells; i++) {
        var mx = X(lx + lw*i/cells);
        wires.push('<line x1="' + mx + '" y1="' + Y(g.height) + '" x2="' + mx + '" y2="' + gy +
          '" stroke="' + col.mesh + '" stroke-width="0.7" class="gp-v"/>');
      }
      var rows = Math.max(3, Math.round(g.height / 0.2));
      for (var j = 1; j < rows; j++) {
        var my = Y(g.height*j/rows);
        wires.push('<line x1="' + X(lx) + '" y1="' + my + '" x2="' + X(lx+lw) + '" y2="' + my +
          '" stroke="' + col.mesh + '" stroke-width="0.7" class="gp-v"/>');
      }
      o.push(part('mesh', wires.join(''), hitRect(X(lx), Y(g.height), lw*sc, g.height*sc)));

      o.push(part('frame',
        '<rect x="' + X(lx) + '" y="' + Y(g.height) + '" width="' + (lw*sc) +
          '" height="' + (g.height*sc) + '" fill="none" stroke="' + col.steel +
          '" stroke-width="' + t + '" class="gp-v"/>',
        '<rect x="' + X(lx) + '" y="' + Y(g.height) + '" width="' + (lw*sc) +
          '" height="' + (g.height*sc) + '" fill="none" stroke="transparent" stroke-width="16" class="gp-hit"/>'));

      // intermediate rails
      for (var r = 1; r <= g.infillRows; r++) {
        var ry = Y(g.height*r/(g.infillRows+1));
        o.push(part('rail',
          '<line x1="' + X(lx) + '" y1="' + ry + '" x2="' + X(lx+lw) + '" y2="' + ry +
            '" stroke="' + col.steel + '" stroke-width="2.5" class="gp-v"/>',
          hitLine(X(lx), ry, X(lx+lw), ry)));
      }
      if (g.bracing) {
        o.push(part('brace',
          '<line x1="' + X(lx) + '" y1="' + gy + '" x2="' + X(lx+lw) + '" y2="' + Y(g.height) +
            '" stroke="' + col.steel + '" stroke-width="2.5" class="gp-v"/>',
          hitLine(X(lx), gy, X(lx+lw), Y(g.height))));
      }
    }

    // ── קרניים ────────────────────────────────────────────────────────
    // In a true straight-on elevation an arm leaning toward the viewer is
    // foreshortened to nothing, which would show the reader a gate with no
    // horns on it. Drawn instead the way a fence elevation draws them: both
    // arms leaning the same way at their real angle, in true length, with
    // the head rail joining the tips. Gates.detailSvg() carries the section
    // that says which way they actually point.
    function horns() {
      if (!g.horns) return;
      var topZ = g.height + 0.25;
      var lean = -(s.hornProj);                    // drawn toward the left margin
      var tipZ = topZ + s.hornRise;
      var ends = postXs.map(function (px) { return { x: px, tx: px + lean }; });

      if (g.hornMesh) {
        var wires = [];
        var span = g.width, cells = Math.max(3, Math.round(span / 0.35));
        for (var i = 0; i <= cells; i++) {
          var bx = g.width * i / cells;
          wires.push('<line x1="' + X(bx) + '" y1="' + Y(topZ) + '" x2="' + X(bx + lean) +
            '" y2="' + Y(tipZ) + '" stroke="' + col.mesh + '" stroke-width="0.7" class="gp-v"/>');
        }
        var bands = 3;
        for (var j = 1; j < bands; j++) {
          var t = j / bands;
          wires.push('<line x1="' + X(lean*t) + '" y1="' + Y(topZ + s.hornRise*t) +
            '" x2="' + X(g.width + lean*t) + '" y2="' + Y(topZ + s.hornRise*t) +
            '" stroke="' + col.mesh + '" stroke-width="0.7" class="gp-v"/>');
        }
        o.push(part('mesh', wires.join(''), ''));
      }

      ends.forEach(function (e) {
        o.push(part('horn',
          '<line x1="' + X(e.x) + '" y1="' + Y(topZ) + '" x2="' + X(e.tx) + '" y2="' + Y(tipZ) +
            '" stroke="' + col.steel + '" stroke-width="4" stroke-linecap="round" class="gp-v"/>',
          hitLine(X(e.x), Y(topZ), X(e.tx), Y(tipZ))));
      });
      // head rail across the tips
      o.push(part('horn',
        '<line x1="' + X(lean) + '" y1="' + Y(tipZ) + '" x2="' + X(g.width + lean) + '" y2="' + Y(tipZ) +
          '" stroke="' + col.steel + '" stroke-width="2.5" class="gp-v"/>',
        hitLine(X(lean), Y(tipZ), X(g.width + lean), Y(tipZ))));
      // the angle, called out on the drawing where it is read
      o.push('<text x="' + X(g.width + lean*0.5) + '" y="' + (Y(topZ + s.hornRise*0.5) - 6) +
        '" fill="' + col.dim + '" font-size="11" font-weight="700" text-anchor="middle">' +
        n1(g.hornAngle) + '\u00b0</text>');
    }

    if (g.type === 'swing2') { leaf(0, g.width/2); leaf(g.width/2, g.width/2); }
    else if (g.type === 'cantil') { leaf(0, g.width); 
      // counterweight tail, drawn lighter — it is structure, not opening
      o.push(part('tail',
        '<rect x="' + X(g.width) + '" y="' + Y(g.height) + '" width="' + (s.tail*sc) +
          '" height="' + (g.height*sc) + '" fill="none" stroke="' + col.steel +
          '" stroke-width="2.5" stroke-dasharray="6,4" class="gp-v"/>',
        hitRect(X(g.width), Y(g.height), s.tail*sc, g.height*sc)));
      o.push('<text x="' + X(g.width + s.tail/2) + '" y="' + Y(g.height/2) +
        '" fill="' + col.dim + '" font-size="11" font-weight="700" text-anchor="middle">' +
        tt('זנב', 'หาง', 'ذيل') + ' ' + n1(s.tail) + ' m</text>');
    }
    else leaf(0, g.width);

    horns();

    // dimensions
    function dim(xa, xb, y, label) {
      return '<line x1="' + xa + '" y1="' + y + '" x2="' + xb + '" y2="' + y +
        '" stroke="' + col.dim + '" stroke-width="1"/>' +
        '<text x="' + ((xa+xb)/2) + '" y="' + (y-5) + '" fill="' + col.dim +
        '" font-size="12" font-weight="800" text-anchor="middle">' + label + '</text>';
    }
    o.push(dim(X(0), X(g.width), gy + 28, n1(g.width) + ' m'));
    o.push('<line x1="' + (X(0)-26) + '" y1="' + Y(g.height) + '" x2="' + (X(0)-26) + '" y2="' + gy +
      '" stroke="' + col.dim + '" stroke-width="1"/>');
    o.push('<text x="' + (X(0)-30) + '" y="' + Y(g.height/2) + '" fill="' + col.dim +
      '" font-size="12" font-weight="800" text-anchor="end">' + n1(g.height) + ' m</text>');
    o.push('<text x="' + X(g.width/2) + '" y="' + (gy + g.postDepth*sc + 16) + '" fill="' + col.conc +
      '" font-size="11" font-weight="700" text-anchor="middle">' +
      tt('יסוד', 'ฐาน', 'أساس') + ' ' + n1(g.postSize) + '\u00d7' + n1(g.postSize) +
      '\u00d7' + n1(g.postDepth) + ' m' +
      ((typeof Rebar !== 'undefined' && g.rebar && g.rebar.show)
        ? ' \u00b7 ' + esc(Rebar.cageLabel(g.rebar)) : '') + '</text>');

    // ── named members ──────────────────────────────────────────────
    // Same information the picker gives on tap, printed for the copy that
    // reaches the fabricator and the client, where nothing is tappable.
    if (CAL) {
      // Leaders sit in fixed vertical slots, one per margin, so two of them
      // can never land on the same line — which is exactly what happened
      // when each was positioned relative to the member it points at.
      // Each leader also reaches the nearest instance of its member, so no
      // leader crosses the gate to reach something on the far side.
      var lc = col.steel, ml = (g.type === 'swing2') ? g.width / 2 : g.width;
      var rx = X(g.width + (s.tail || 0)) + 30, lx2 = X(0) - 30;
      function lab(role) { var L = partLabel(g, role); return L ? [L.name, L.profile] : null; }

      // left margin
      o.push(gLeader(X(0), Y(g.height * 0.62), lx2, Y(g.height) - 10, 'l', lab('post'), lc));
      o.push(gLeader(X(ml * 0.18), Y(g.height * 0.90), lx2, Y(g.height * 0.14), 'l', lab('frame'), lc));

      // right margin — targets on the right-hand leaf
      var rLeafX = (g.type === 'swing2') ? ml : 0;
      o.push(gLeader(X(rLeafX + ml * 0.72), Y(g.height * 0.72), rx, Y(g.height) - 10, 'r',
        lab('mesh'), lc));
      if (g.bracing) {
        o.push(gLeader(X(rLeafX + ml * 0.5), (gy + Y(g.height)) / 2, rx, Y(g.height * 0.40), 'r',
          lab('brace'), lc));
      }
      if (g.infillRows > 0) {
        o.push(gLeader(X(rLeafX + ml * 0.25), Y(g.height / (g.infillRows + 1)),
          rx, Y(g.height * 0.10), 'r', lab('rail'), lc));
      }
      if (g.type === 'cantil') {
        o.push(gLeader(X(g.width + s.tail * 0.5), Y(g.height), rx, Y(g.height) + 26, 'r',
          lab('tail'), lc));
      }
      if (g.horns) {
        o.push(gLeader(X(ml * 0.5 - s.hornProj * 0.5), Y(g.height + 0.25 + s.hornRise * 0.5),
          lx2, Y(g.height) - 34, 'l', lab('horn'), lc));
      }
      // The foundation already names itself in the note under the gate;
      // a leader saying the same thing twice is noise, not annotation.
    }

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">' +
      o.join('') + '</svg>';
  }

  // Hover or tap a member, read its section. Bound after the drawing is in
  // the document, because every repaint replaces the host node and a
  // retained listener would be pointing at markup nobody can see.
  //
  // Hover is transient and tap is sticky: on a phone there is no hover at
  // all, so a tap has to leave the answer on screen instead of flashing it
  // for as long as the finger is down. Tapping the same member again, or
  // anywhere else in the drawing, clears it.
  function bindPicker(host, gate, readout) {
    if (!host) return null;
    var svgEl = host.tagName && host.tagName.toLowerCase() === 'svg'
      ? host : host.querySelector('svg');
    if (!svgEl) return null;
    var pinned = null;

    function show(role) {
      var lab = role ? partLabel(gate, role) : null;
      if (readout) {
        readout.innerHTML = lab
          ? '<span style="opacity:.75;">' + esc(lab.name) + '</span> ' +
            '<b style="color:var(--accent,#ff9f43);">' + esc(lab.profile) + '</b>'
          : '';
      }
      return lab;
    }
    function markPinned() {
      svgEl.querySelectorAll('.gp').forEach(function (el) {
        el.classList.toggle('gp-on', !!pinned && el.getAttribute('data-gp') === pinned);
      });
    }
    function roleAt(target) {
      var el = target && target.closest ? target.closest('.gp') : null;
      return el ? el.getAttribute('data-gp') : null;
    }

    function onMove(e) { if (!pinned) show(roleAt(e.target)); }
    function onLeave() { if (!pinned) show(null); }
    function onClick(e) {
      var role = roleAt(e.target);
      pinned = (role && role !== pinned) ? role : null;
      markPinned();
      show(pinned);
    }

    svgEl.addEventListener('pointermove', onMove);
    svgEl.addEventListener('pointerleave', onLeave);
    svgEl.addEventListener('click', onClick);
    return {
      select: function (role) { pinned = role || null; markPinned(); show(pinned); },
      clear: function () { pinned = null; markPinned(); show(null); },
      destroy: function () {
        svgEl.removeEventListener('pointermove', onMove);
        svgEl.removeEventListener('pointerleave', onLeave);
        svgEl.removeEventListener('click', onClick);
      }
    };
  }

  // Roles present in a given gate, so a caller can build a legend without
  // knowing how the drawing is put together.
  function partsOf(g) {
    g = norm(g);
    var out = ['post', 'found', 'frame', 'mesh'];
    if (g.infillRows > 0) out.push('rail');
    if (g.bracing) out.push('brace');
    if (g.horns) out.push('horn');
    if (g.type === 'cantil') out.push('tail');
    return out;
  }

  // Preparation and sequence. A gate goes wrong at the posts, so that is
  // what the sheet leads with.
  function stages(g) {
    g = norm(g);
    var st = [
      [tt('סימון ומדידה', 'วัดและทำเครื่องหมาย', 'قياس وتحديد'),
       tt('לוודא רוחב אור נטו ' + n1(g.width) + ' מ\' בין פני העמודים, לא בין מרכזיהם. לסמן ניצב לציר הדרך.',
          'ตรวจสอบความกว้างสุทธิ', 'التأكد من العرض الصافي')],
      [tt('חפירת יסודות', 'ขุดฐานราก', 'حفر الأساسات'),
       tt(g.postSize + '\u00d7' + g.postSize + ' מ\' בעומק ' + n1(g.postDepth) +
          ' מ\'. לוודא שאין תשתיות במסלול החפירה.',
          'ขุดตามขนาด', 'حفر حسب المقاس')],
      [tt('התקנת עמודים ויציקה', 'ติดตั้งเสาและเท', 'تركيب الأعمدة والصب'),
       tt('לייצב את העמודים באנך ובגובה אחיד, לוודא ניצבות בשני מישורים לפני היציקה. אין לתלות כנף לפני 7 ימי אשפרה.',
          'ตั้งเสาให้ได้ดิ่ง', 'ضبط الأعمدة عمودياً')],
      [tt('ייצור הכנף', 'ผลิตบาน', 'تصنيع المصراع'),
       tt('ריתוך מסגרת מפרופיל ' + g.frame + ', אלכסון ייצוב, ריתוך רשת. ליטוש וגילוון/צביעה לפני התלייה.',
          'เชื่อมโครง', 'لحام الإطار')]
    ];
    if (g.type === 'slide') {
      st.push([tt('יציקת מסילה', 'เทราง', 'صب المسار'),
        tt('מסילה תחתונה לאורך ' + n1(g.width*2) + ' מ\' על משטח בטון מפולס. סטייה מפילוס תגרום לתקיעה.',
           'รางล่าง', 'المسار السفلي')]);
    }
    if (g.type === 'cantil') {
      st.push([tt('בסיס עגלות', 'ฐานรถเข็น', 'قاعدة العربات'),
        tt('שתי עגלות על יסוד רציף. אורך הזנב ' + n1(g.width*0.5) + ' מ\' חייב מרווח פנוי מאחורי הפתח.',
           'ต้องมีพื้นที่ว่างด้านหลัง', 'يلزم فراغ خلف الفتحة')]);
    }
    if (g.horns) {
      st.push([tt('ייצור והרכבת קרניים', 'ทำและติดตั้งแขนเอียง', 'تصنيع وتركيب الأذرع'),
        tt('קרן ' + n1(g.hornLen) + ' מ\' בזווית ' + n1(g.hornAngle) + '\u00b0 ' +
           (g.hornDir === 'in' ? 'פנימה' : 'כלפי הכניסה') +
           '. לרתך את הקרן לראש העמוד לפני התלייה, ולוודא זווית זהה בכל העמודים — ' +
           'קרן שסוטה במעלה אחת נראית עקומה מהכביש.',
           'เชื่อมแขนก่อนแขวนบาน', 'لحام الأذرع قبل التعليق')]);
    }
    st.push([tt('תלייה וכיוון', 'แขวนและปรับ', 'التعليق والضبط'),
      tt('התלייה, כיוון מפלס, בדיקת פתיחה מלאה ללא חיכוך, התקנת בריח.',
         'ปรับระดับ', 'ضبط المستوى')]);
    if (g.motor) {
      st.push([tt('חשמל ומנוע', 'ไฟฟ้าและมอเตอร์', 'كهرباء ومحرك'),
        tt('הכנת צנרת וכבל לפני היציקה — לא לאחריה. התקנת מנוע, גלאי בטיחות וכיוון סופים.',
           'เตรียมท่อก่อนเท', 'تمديد الأنابيب قبل الصب')]);
    }
    return st;
  }

  // ══════════════════════════════════════════════════════════════════
  //  SECTION DETAIL — the true shape of the horn, and the cage
  // ══════════════════════════════════════════════════════════════════
  // The elevation is a compromise (see horns() above). This is not: a cut
  // through one post, looking along the gate, so the arm points where it
  // really points and the foundation shows what is really in it. It is the
  // drawing the engineer's sheet calls חתך ב-ב, and the one a welder needs.
  function detailSvg(g, opt) {
    g = norm(g);
    opt = opt || {};
    var print = !!opt.print;
    var s = summary(g);
    var col = {
      steel: print ? '#37474f' : 'var(--text,#cfd8dc)',
      mesh:  print ? '#90a4ae' : 'var(--text-muted,#8fa3b8)',
      conc:  print ? '#bdbdbd' : 'var(--text-muted,#9e9e9e)',
      dim:   print ? '#b34700' : 'var(--accent,#ff9f43)',
      grnd:  print ? '#8d6e63' : 'var(--text-muted,#8d6e63)',
      txt:   print ? '#37474f' : 'var(--text,#cfd8dc)',
      bar:   print ? '#c0392b' : '#e2624b'
    };
    var W = 520, H = 340, pad = 46;
    var topZ = g.height + 0.25;
    var upH = topZ + s.hornRise;
    var reach = Math.max(g.postSize, s.hornProj * 2 + g.postSize) + 0.5;
    var sc = Math.min((W - pad * 3) / reach, (H - pad * 2) / (upH + g.postDepth + 0.3));
    // The approach is to the LEFT of the section, so an arm that leans
    // 'out' leans left — the same side the reader is standing on.
    var cx = W * 0.58;
    var sgn = (g.hornDir === 'in') ? 1 : -1;
    var gy = pad + upH * sc;
    function X(m) { return cx + m * sc; }
    function Y(m) { return gy - m * sc; }

    var o = [];
    o.push('<text x="14" y="20" fill="' + col.txt + '" font-size="12" font-weight="800">' +
      esc(tt('חתך דרך עמוד · קרן ויסוד', 'ภาคตัดผ่านเสา', 'مقطع عبر العمود')) + '</text>');

    // ground
    o.push('<line x1="16" y1="' + gy + '" x2="' + (W - 16) + '" y2="' + gy +
      '" stroke="' + col.grnd + '" stroke-width="2"/>');
    // approach arrow — who the horn is leaning toward
    var ax = X(sgn * (s.hornProj + 0.45));
    o.push('<line x1="' + ax + '" y1="' + (gy + 22) + '" x2="' + X(sgn * 0.12) + '" y2="' + (gy + 22) +
      '" stroke="' + col.dim + '" stroke-width="1"/>' +
      gArrow(X(sgn * 0.12), gy + 22, ax, gy + 22, col.dim));
    o.push('<text x="' + ax + '" y="' + (gy + 38) + '" fill="' + col.dim +
      '" font-size="10.5" font-weight="700" text-anchor="middle">' +
      esc(tt('כיוון הגעה', 'ทิศทางเข้า', 'اتجاه القدوم')) + '</text>');

    // foundation + cage
    var fw = g.postSize * sc;
    o.push('<rect x="' + (X(0) - fw / 2) + '" y="' + gy + '" width="' + fw + '" height="' +
      (g.postDepth * sc) + '" fill="' + col.conc + '" opacity=".55"/>');
    if (typeof Rebar !== 'undefined') {
      o.push(Rebar.overlay(g.rebar, { x: X(0) - fw / 2, y: gy, w: fw, h: g.postDepth * sc },
        { color: col.bar, scale: sc }));
    }

    // post
    o.push('<rect x="' + (X(0) - 5) + '" y="' + Y(topZ) + '" width="10" height="' +
      (topZ * sc) + '" fill="' + col.steel + '"/>');

    // the arm, at its true angle
    if (g.horns) {
      var tipX = X(sgn * s.hornProj), tipY = Y(upH);
      o.push('<line x1="' + X(0) + '" y1="' + Y(topZ) + '" x2="' + tipX + '" y2="' + tipY +
        '" stroke="' + col.steel + '" stroke-width="5" stroke-linecap="round"/>');
      if (g.hornMesh) {
        for (var i = 1; i <= 4; i++) {
          var t = i / 5;
          o.push('<line x1="' + (X(0) + (tipX - X(0)) * t) + '" y1="' + (Y(topZ) + (tipY - Y(topZ)) * t) +
            '" x2="' + (X(0) + (tipX - X(0)) * t - sgn * 5) + '" y2="' +
            (Y(topZ) + (tipY - Y(topZ)) * t) + '" stroke="' + col.mesh + '" stroke-width="1.4"/>');
        }
      }
      // angle from the vertical, marked at the knuckle
      o.push('<path d="M' + X(0) + ',' + (Y(topZ) + 26) + ' A 26 26 0 0 ' + (sgn < 0 ? 1 : 0) + ' ' +
        (X(0) + sgn * 26 * Math.sin(g.hornAngle * Math.PI / 180)) + ',' +
        (Y(topZ) + 26 * Math.cos(g.hornAngle * Math.PI / 180)) +
        '" fill="none" stroke="' + col.dim + '" stroke-width="1"/>');
      o.push('<text x="' + (X(0) + sgn * 34) + '" y="' + (Y(topZ) + 20) + '" fill="' + col.dim +
        '" font-size="11" font-weight="800" text-anchor="middle">' + n1(g.hornAngle) + '\u00b0</text>');
      // arm length, along the arm
      o.push('<text x="' + ((X(0) + tipX) / 2 + sgn * 22) + '" y="' + ((Y(topZ) + tipY) / 2) +
        '" fill="' + col.dim + '" font-size="11" font-weight="800" text-anchor="middle">' +
        n1(g.hornLen) + ' m</text>');
      // horizontal reach — the number that decides whether it overhangs a road
      o.push('<line x1="' + X(0) + '" y1="' + (tipY - 14) + '" x2="' + tipX + '" y2="' + (tipY - 14) +
        '" stroke="' + col.dim + '" stroke-width="1" stroke-dasharray="3,3"/>');
      o.push('<text x="' + ((X(0) + tipX) / 2) + '" y="' + (tipY - 19) + '" fill="' + col.dim +
        '" font-size="10.5" font-weight="700" text-anchor="middle">' + n1(s.hornProj) + ' m</text>');
    }

    // heights
    o.push('<line x1="' + (X(0) + fw / 2 + 30) + '" y1="' + Y(0) + '" x2="' + (X(0) + fw / 2 + 30) +
      '" y2="' + Y(topZ) + '" stroke="' + col.dim + '" stroke-width="1"/>');
    o.push('<text x="' + (X(0) + fw / 2 + 34) + '" y="' + Y(topZ / 2) + '" fill="' + col.dim +
      '" font-size="11" font-weight="800">' + n1(topZ) + ' m</text>');
    o.push('<text x="' + (X(0) + fw / 2 + 34) + '" y="' + (gy + g.postDepth * sc / 2) +
      '" fill="' + col.conc + '" font-size="10.5" font-weight="700">' +
      n1(g.postSize) + '\u00d7' + n1(g.postSize) + '\u00d7' + n1(g.postDepth) + ' m</text>');

    // schedule
    var lines = [g.post + ' \u00b7 ' + tt('עמוד', 'เสา', 'عمود')];
    if (g.horns) {
      lines.push(tt('קרן', 'แขนเอียง', 'ذراع') + ' ' + n1(g.hornLen) + ' m @ ' +
        n1(g.hornAngle) + '\u00b0 ' + (g.hornDir === 'in'
          ? tt('פנימה', 'เข้า', 'للداخل') : tt('כלפי הכניסה', 'ออกนอก', 'نحو المدخل')));
    }
    if (typeof Rebar !== 'undefined' && g.rebar) lines.push(Rebar.summaryLabel(g.rebar));
    lines.forEach(function (ln, i) {
      o.push('<text x="14" y="' + (H - 30 + i * 13) + '" fill="' +
        col.txt + '" font-size="10.5" font-weight="700" opacity=".85">' + esc(ln) + '</text>');
    });

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">' +
      o.join('') + '</svg>';
  }

  // ══════════════════════════════════════════════════════════════════
  //  3D MODEL
  // ══════════════════════════════════════════════════════════════════
  // Handed to Shed3D.mount() as a prebuilt face list, so a gate orbits,
  // pans, zooms and picks with exactly the controls the shed has — one
  // viewer, one set of gestures, one thing to learn. The 3D view is also
  // the only honest picture of a horn: it points at the camera when you
  // look at the gate head-on, which is the whole idea.
  //
  // Axes match the shed: x across the opening, y through the gate (−y is
  // the approach side), z up.
  var G3 = {
    post: '#5f6a72', frame: '#6b7780', rail: '#6b7780', brace: '#77838c',
    horn: '#4e5a62', mesh: '#9fb0bd', found: '#8d8579', tail: '#7c878f',
    track: '#8a8a8a', ground: '#b9ae92'
  };

  function model3d(g) {
    g = norm(g);
    var s = summary(g);
    var P = (typeof Shed3D !== 'undefined' && Shed3D.prim) ? Shed3D.prim : null;
    if (!P) return null;

    var F = [];
    var hw = g.width / 2;                       // half opening
    var t = 0.05;                               // half thickness of a leaf member
    var pw = 0.075;                             // half width of a post
    var topZ = g.height + 0.25;

    // Long members are split so the painter's sort stays honest — the same
    // reason shed3d subdivides. A 6 m top rail whose centroid sits in the
    // middle of the opening otherwise sorts in front of a near post from
    // one angle and behind it from the next.
    function splitX(x1, x2, fn) {
      var n = Math.max(1, Math.min(12, Math.round(Math.abs(x2 - x1) / 1.0)));
      for (var i = 0; i < n; i++) {
        fn(x1 + (x2 - x1) * i / n, x1 + (x2 - x1) * (i + 1) / n);
      }
    }
    function barX(x1, x2, y1, z1, y2, z2, col, grp) {
      splitX(x1, x2, function (a, b) { F = F.concat(P.bar(a, y1, z1, b, y2, z2, col, grp)); });
    }
    function colZ(x, y, z1, z2, col, grp) {
      var n = Math.max(1, Math.round((z2 - z1) / 1.2));
      for (var i = 0; i < n; i++) {
        F = F.concat(P.box(x - pw, y - pw, z1 + (z2 - z1) * i / n,
                           x + pw, y + pw, z1 + (z2 - z1) * (i + 1) / n, col, grp));
      }
    }
    // A mesh panel: one translucent quad per metre of run, ribbed, rather
    // than a wire per cell. Twelve hundred cylinders would be honest and
    // unusable on a phone.
    function meshPanel(x1, x2, y, z1, z2, grp) {
      splitX(x1, x2, function (a, b) {
        F = F.concat(P.quad([a, y, z1], [b, y, z1], [b, y, z2], [a, y, z2],
          G3.mesh, grp || 'mesh', Math.max(2, Math.round((z2 - z1) / 0.2)), 0.55));
      });
    }

    // ── ground ──
    var padXY = Math.max(2, g.width * 0.5);
    F = F.concat(P.quad([-hw - padXY, -padXY, -0.02], [hw + padXY, -padXY, -0.02],
                        [hw + padXY, padXY, -0.02], [-hw - padXY, padXY, -0.02],
                        G3.ground, 'ground', 0, 1));

    // ── posts and their foundations ──
    var postXs = (g.type === 'slide') ? [-hw - 0.6, -hw, hw, hw + 0.6]
               : (g.type === 'cantil') ? [-hw, hw, hw + 0.6]
               : [-hw, hw];
    var fh = g.postSize / 2;
    postXs.forEach(function (px) {
      F = F.concat(P.box(px - fh, -fh, -g.postDepth, px + fh, fh, 0, G3.found, 'found'));
      colZ(px, 0, 0, topZ, G3.post, 'post');
    });

    // ── leaves ──
    function leaf(x1, x2) {
      barX(x1, x2, -t, 0, t, 2 * t, G3.frame, 'frame');                       // bottom rail
      barX(x1, x2, -t, g.height - 2 * t, t, g.height, G3.frame, 'frame');     // top rail
      [x1, x2].forEach(function (ex) {
        F = F.concat(P.box(ex - t, -t, 0, ex + t, t, g.height, G3.frame, 'frame'));
      });
      for (var r = 1; r <= g.infillRows; r++) {
        var rz = g.height * r / (g.infillRows + 1);
        barX(x1, x2, -t * 0.7, rz - t * 0.7, t * 0.7, rz + t * 0.7, G3.rail, 'rail');
      }
      if (g.bracing) {
        F = F.concat(P.strut([x1, 0, 0.05], [x2, 0, g.height - 0.05], 0.035, G3.brace, 'brace'));
      }
      meshPanel(x1, x2, 0, 0.02, g.height - 0.02);
    }

    if (g.type === 'swing2') { leaf(-hw, 0); leaf(0, hw); }
    else {
      leaf(-hw, hw);
      if (g.type === 'cantil' && s.tail > 0) {
        barX(hw, hw + s.tail, -t, g.height - 2 * t, t, g.height, G3.tail, 'tail');
        barX(hw, hw + s.tail, -t, 0, t, 2 * t, G3.tail, 'tail');
        F = F.concat(P.box(hw + s.tail - t, -t, 0, hw + s.tail + t, t, g.height, G3.tail, 'tail'));
      }
      if (g.type === 'slide') {
        barX(-hw - 0.6, hw + 0.6, -0.06, -0.04, 0.06, 0.06, G3.track, 'track');
      }
    }

    // ── קרניים ──
    // Leaning along −y when 'out': straight at whoever is arriving.
    if (g.horns) {
      var dir = (g.hornDir === 'in') ? 1 : -1;
      var ty = dir * s.hornProj, tz = topZ + s.hornRise;
      postXs.forEach(function (px) {
        F = F.concat(P.strut([px, 0, topZ], [px, ty, tz], 0.075, G3.horn, 'horn'));
      });
      // head rail across the tips, and the mesh on the sloping face
      splitX(-hw, hw, function (a, b) {
        F = F.concat(P.bar(a, ty - 0.05, tz - 0.05, b, ty + 0.05, tz + 0.05, G3.horn, 'horn'));
      });
      if (g.hornMesh) {
        splitX(-hw, hw, function (a, b) {
          F = F.concat(P.quad([a, 0, topZ], [b, 0, topZ], [b, ty, tz], [a, ty, tz],
            G3.mesh, 'mesh', Math.max(2, Math.round(g.hornLen / 0.2)), 0.55));
        });
      }
    }

    var far = Math.max(g.width, 3) + (s.tail || 0);
    return {
      // the prebuilt-geometry contract with shed3d
      faces: F,
      meta: {
        span: Math.max(1.5, s.hornProj * 2 + 1), length: far, eaves: s.topZ,
        ridgeZ: s.topZ, frames: postXs.length, bay: 1.5, rise: 0,
        // Gate numbers, in gate places — the shed's span/length/eaves tags
        // would be three readings of the same opening.
        tags: [
          { p: [0, -Math.max(1.2, s.hornProj + 0.8), 0], t: n1(g.width) + ' m' },
          { p: [-far / 2 - 0.8, 0, g.height / 2], t: n1(g.height) + ' m' }
        ].concat(g.horns
          ? [{ p: [0, ((g.hornDir === 'in') ? 1 : -1) * (s.hornProj + 0.3), s.topZ + 0.35],
               t: n1(g.hornLen) + ' m @ ' + n1(g.hornAngle) + '\u00b0' }]
          : [])
      },
      // framing hints read by the projector
      span: Math.max(2.5, s.hornProj * 2 + 1.5), length: far, eaves: s.topZ, bay: 1.5,
      // a gate has no site context of its own; the ground quad above is all
      context: false, slab: false, footings: false,
      scaleRef: 'none', shadows: false, dims: true, callouts: true
    };
  }

  return { TYPES: TYPES, typeLabel: typeLabel, norm: norm,
           takeoff: takeoff, summary: summary, svg: svg, stages: stages,
           // section detail and the orbitable model
           detailSvg: detailSvg, model3d: model3d,
           // first-pass structural check
           check: check, checks: checks, candidates: candidates,
           roleLabel: roleLabel, sections: GSECT,
           // part identification on the drawing
           partLabel: partLabel, partsOf: partsOf, bindPicker: bindPicker };
})();
