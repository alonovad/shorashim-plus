/* buildplan.js — פרויקטי בנייה (light construction projects)
 * ------------------------------------------------------------------
 * The maintenance department's build side: service sheds (סככות), concrete
 * slabs and loading ramps (משטחי בטון / רמפות). Three things in one module,
 * because they are three views of one object:
 *
 *   1. A FOOTPRINT drawn on the map. A project is a place before it is a
 *      structure. It gets its own Leaflet layer and its own store — it is
 *      NOT a row in `plots`. A plot is an orchard with trees, a season and
 *      spray history; a project has a client, a status and a bill of
 *      materials. Forcing them into one table would put empty tree_count
 *      columns on concrete slabs forever.
 *
 *   2. A PARAMETRIC DRAWING. Span, length, eaves height, bay spacing and
 *      roof pitch drive a live SVG elevation and plan. The drawing is not
 *      decoration — it is the check on the numbers. A bay spacing that
 *      leaves a 0.4 m sliver at one end is obvious in a drawing and
 *      invisible in a table of quantities.
 *
 *   3. A BILL OF MATERIALS, derived from the same five inputs, priced off
 *      a profile catalogue and handed to orders.js.
 *
 * GEOMETRY (portal frame, gable roof)
 *   rise        = (span/2) × tan(pitch)
 *   rafterLen   = √((span/2)² + rise²)
 *   frames      = round(length / bay) + 1
 *   purlin runs = ceil(rafterLen / purlinSpacing) + 1   per slope
 *   girt rows   = ceil(eaves / girtSpacing)
 *   roof area   = 2 × rafterLen × length
 *   wall area   = perimeter × eaves + 2 gable triangles (span × rise / 2)
 *
 * Steel weight comes from the catalogue's kg/m, so a takeoff produces
 * tonnage — which is how section steel is actually quoted here — and not
 * just a count of sticks.
 *
 * DATA: appData/shorashim-build-projects  { projects: [...] }
 *       appData/shorashim-build-catalog   { profiles: [...] }
 *
 * Access: operator+ (rules + client), same as the rest of maintenance.
 */
var BuildPlan = (function () {
  'use strict';

  var PROJ_KEY = 'shorashim-build-projects';
  var CAT_KEY  = 'shorashim-build-catalog';

  var P = { projects: [] };
  var C = { profiles: [] };
  var _lastP = '', _lastC = '';
  var _listening = false;
  var _open = null;          // project id being edited
  var _tab = 'design';       // design | materials | site
  var _layer = null;         // Leaflet layer group for footprints
  var _draw = null;          // { id, pts[], markers[], line }

  // Sections commonly stocked in Israel, with nominal kg/m. Seeded once so
  // the module is usable on day one; the catalogue is editable, because
  // every yard carries a slightly different range at a different price.
  // Section properties for the preliminary adequacy check.
  //   wy = elastic section modulus about the strong axis, cm3
  //   ar = cross-sectional area, cm2
  //   iz = radius of gyration about the WEAK axis, cm (governs buckling)
  // Nominal catalogue values for the sections commonly stocked here. They
  // are used for a first-pass sizing check only — see checkMember().
  var SECT = {
    'HEA 140': { wy: 155, ar: 31.4, iz: 3.52 },
    'HEA 160': { wy: 220, ar: 38.8, iz: 3.98 },
    'HEA 180': { wy: 294, ar: 45.3, iz: 4.52 },
    'HEA 200': { wy: 389, ar: 53.8, iz: 4.98 },
    'HEB 160': { wy: 311, ar: 54.3, iz: 4.05 },
    'HEB 200': { wy: 570, ar: 78.1, iz: 5.07 },
    'IPE 160': { wy: 109, ar: 20.1, iz: 1.84 },
    'IPE 200': { wy: 194, ar: 28.5, iz: 2.24 },
    'IPE 240': { wy: 324, ar: 39.1, iz: 2.69 },
    'RHS 100x50x3':   { wy: 20.9, ar: 8.55, iz: 2.00 },
    'RHS 120x60x4':   { wy: 39.5, ar: 13.4, iz: 2.40 },
    'SHS 80x80x4':    { wy: 27.2, ar: 11.7, iz: 3.00 },
    'SHS 100x100x4':  { wy: 44.3, ar: 14.9, iz: 3.90 },
    'Z 150x2.0': { wy: 17.6, ar: 5.86, iz: 1.60 },
    'Z 200x2.0': { wy: 29.5, ar: 7.39, iz: 1.70 },
    'C 150x2.0': { wy: 15.4, ar: 5.61, iz: 1.50 },
    'C 200x2.5': { wy: 28.9, ar: 9.05, iz: 1.70 }
  };

  // Allowable bending stress, S235 with a working-stress safety factor.
  var F_ALLOW = 160;     // MPa
  var WIND    = 0.5;     // kN/m2 on walls, first-pass

  // First-pass adequacy of one section in one role. Returns a utilisation
  // ratio: below 1.0 the section has capacity, above it does not.
  //
  // THIS IS NOT A STRUCTURAL DESIGN. It is uniform gravity load, simple or
  // lightly continuous spans, no wind uplift, no combined axial-and-bending
  // interaction, no lateral-torsional buckling, no connection check and no
  // deflection limit. It exists to stop someone specifying an IPE 160 over
  // a 20 m span, not to replace an engineer.
  function checkMember(role, name, d) {
    var sc = SECT[name];
    if (!sc || !d) return { known: false };
    // checkMember is reachable with a raw dims object that predates these
    // fields, and one undefined turns every utilisation into NaN — which
    // renders as "NaN%" and, worse, compares false against 1 so a section
    // that was never checked reads as adequate. Defaults, not faith.
    d = {
      span: Number(d.span) || 10, length: Number(d.length) || 20,
      eaves: Number(d.eaves) || 4, bay: Number(d.bay) || 5,
      pitch: Number(d.pitch) || 10,
      purlinSp: Number(d.purlinSp) || 1.5, girtSp: Number(d.girtSp) || 1.5,
      roofLoad: Number(d.roofLoad) || 0.55,
      walls: d.walls, wallMode: d.wallMode || 'full', roofType: d.roofType || 'gable'
    };
    var g = geom(d);
    var M = 0, span = 0, w = 0, util = 0, why = '';

    if (role === 'rafter') {
      span = g.rafterLen;
      w = d.roofLoad * g.actualBay;                 // kN/m along the rafter
      M = w * span * span / 10;                     // kNm, portal continuity
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = tt('כפיפה', 'การดัด', 'انحناء');
    } else if (role === 'purlin') {
      span = g.actualBay;
      w = d.roofLoad * d.purlinSp;
      M = w * span * span / 8;
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = tt('כפיפה', 'การดัด', 'انحناء');
    } else if (role === 'girt') {
      span = g.actualBay;
      w = WIND * d.girtSp;
      M = w * span * span / 8;
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = tt('רוח', 'ลม', 'رياح');
    } else if (role === 'column') {
      // A portal column is NOT an axial strut. The frame drives a moment
      // into it at the eaves, and that moment — not the vertical load —
      // decides the section. Checking axial alone returned utilisations
      // around 10%, which would have cheerfully approved an HEA 140 under a
      // 20 m portal. Axial and bending are combined linearly, which is
      // conservative and appropriate for a first pass.
      var N = g.actualBay * (d.span / 2) * d.roofLoad;      // kN
      var lam = (d.eaves * 100) / sc.iz;                    // slenderness
      var chi = 1 / (1 + Math.pow(lam / 90, 2));            // buckling reduction
      var cap = sc.ar * 1e-4 * F_ALLOW * 1000 * chi;        // kN
      var wc = d.roofLoad * g.actualBay;                    // kN/m on the frame
      var Mc = wc * d.span * d.span / 16;                   // kNm at the eaves
      var uN = N / cap;
      var uM = (Mc * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      util = uN + uM;
      M = Mc;
      span = d.eaves;
      why = tt('לחיצה+כפיפה', 'อัด+ดัด', 'ضغط+انحناء') + ' \u03bb=' + Math.round(lam);
    } else return { known: false };

    if (!isFinite(util)) return { known: false };
    return { known: true, util: util, ok: util <= 1,
             span: span, M: M, why: why, wy: sc.wy, kg: (profByName(name) || {}).kgPerM || 0 };
  }

  // Which catalogue sections can do this job? Sorted lightest-first, since
  // the cheapest adequate section is almost always the right answer.
  function candidates(role, d) {
    var group = (role === 'purlin' || role === 'girt') ? 'מרישים' : 'עמודים / קורות';
    var out = [];
    (C.profiles || []).forEach(function (pr) {
      if (pr.group !== group) return;
      var r = checkMember(role, pr.name, d);
      if (!r.known) return;
      out.push({ name: pr.name, util: r.util, ok: r.ok, kg: pr.kgPerM,
                 price: pr.price, why: r.why });
    });
    out.sort(function (a, b) { return a.kg - b.kg; });
    return out;
  }

  var ROLE_KEY = { column: 'colProfile', rafter: 'rafterProfile',
                   purlin: 'purlinProfile', girt: 'girtProfile' };

  // Indicative prices, ex-VAT, for a catalogue that would otherwise start
  // empty and produce a quote of zero. Cladding and joinery are published
  // supplier figures; steel derives from a per-kilo rate, which is how it
  // is actually quoted. These are a STARTING POINT — every one is editable
  // in the catalogue, and the ₪/kg button reprices all the steel at once.
  var STEEL_PER_KG = 6.2;
  var PRICE = {
    'איסכורית 0.4 מ"מ': 32,  'איסכורית 0.5 מ"מ': 38,
    'איסכורית 0.6 מ"מ': 45,  'איסכורית 0.7 מ"מ': 52,
    'פאנל קלקר 5 ס"מ': 64,   'פאנל קלקר 7.5 ס"מ': 72,
    'פאנל קלקר 10 ס"מ': 80,  'פאנל קלקר 15 ס"מ': 96,
    'פאנל צמר סלעים 5 ס"מ': 110, 'פאנל צמר סלעים 10 ס"מ': 145,
    'לוח סקיילייט': 95,
    'בטון ב-30': 420,           // per m3 delivered
    'רשת פלדה Q188': 145,       // per 6x2.35 sheet
    'ברזל זיון 12 מ"מ': 6.6,    // per m
    'פלטת בסיס': 85,  'בורג עיגון': 12,
    'מרזב': 45,  'צינור ניקוז': 90,
    'שער הזזה': 4200,
    'עמוד גדר': 95,  'רשת גדר': 62,
    'רשת מרותכת 50/200': 58,
    'צירי שער כבדים': 140,  'בריח נעילה': 180,
    'בריח קרקע מרכזי': 120,  'מסילת שער': 165,
    'גלגלי מסילה': 210,  'עגלות נשיאה': 480,
    'מוביל עליון': 240,  'מנוע שער חשמלי': 5400,
    'צבע/גילוון וצביעה': 28,
    'בלוק בטון 20 ס"מ': 12,  'טיח פנים': 55,
    'חיפוי קרמיקה': 120,  'פרופיל U לפאנל': 18,
    'דלת פנים': 750,  'חלון אלומיניום': 475,
    'אסלה כולל מיכל': 620,  'מקלחון / אגן מקלחת': 780,
    'כיור רחצה': 390,  'דוד שמש 150 ליטר': 2900,
    'צנרת מים קרים': 42,  'צנרת ביוב': 58,
    'נקודת חשמל': 180,  'לוח חשמל': 1450,
    'מזגן מיני מרכזי': 4800
  };

  function seedPrice(name, kgPerM, unit) {
    if (PRICE[name] != null) return PRICE[name];
    // Anything sold by the metre with a known weight is priced by weight.
    if (kgPerM > 0 && unit === "מ'") return Math.round(kgPerM * STEEL_PER_KG * 100) / 100;
    return 0;
  }

  var SEED = [
    { g: 'עמודים / קורות', n: 'HEA 140', kg: 24.7,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'HEA 160', kg: 30.4,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'HEA 180', kg: 35.5,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'HEA 200', kg: 42.3,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'HEB 160', kg: 42.6,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'HEB 200', kg: 61.3,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'IPE 160', kg: 15.8,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'IPE 200', kg: 22.4,  u: "מ'" },
    { g: 'עמודים / קורות', n: 'IPE 240', kg: 30.7,  u: "מ'" },
    { g: 'פרופיל מלבני',  n: 'RHS 100x50x3', kg: 6.71, u: "מ'" },
    { g: 'פרופיל מלבני',  n: 'RHS 120x60x4', kg: 10.5, u: "מ'" },
    { g: 'פרופיל מרובע',  n: 'SHS 80x80x4',  kg: 9.22, u: "מ'" },
    { g: 'פרופיל מרובע',  n: 'SHS 100x100x4', kg: 11.7, u: "מ'" },
    { g: 'מרישים',        n: 'Z 150x2.0', kg: 4.60, u: "מ'" },
    { g: 'מרישים',        n: 'Z 200x2.0', kg: 5.80, u: "מ'" },
    { g: 'מרישים',        n: 'C 150x2.0', kg: 4.40, u: "מ'" },
    { g: 'מרישים',        n: 'C 200x2.5', kg: 7.10, u: "מ'" },
    // Cladding is sold by sheet thickness and, for panels, by core type and
    // thickness — a 0.4 mm sheet and a 0.7 mm sheet are different products
    // at different prices, and quoting one for the other is a real error.
    { g: 'חיפוי',         n: 'איסכורית 0.4 מ"מ', kg: 3.4, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'איסכורית 0.5 מ"מ', kg: 4.3, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'איסכורית 0.6 מ"מ', kg: 5.1, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'איסכורית 0.7 מ"מ', kg: 6.0, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל קלקר 5 ס"מ',  kg: 9.5,  u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל קלקר 7.5 ס"מ', kg: 10.5, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל קלקר 10 ס"מ', kg: 11.5, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל קלקר 15 ס"מ', kg: 13.0, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל צמר סלעים 5 ס"מ',  kg: 15.0, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל צמר סלעים 10 ס"מ', kg: 21.0, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'לוח סקיילייט', kg: 0,   u: 'מ"ר' },
    { g: 'בטון',          n: 'בטון ב-30',   kg: 0,   u: 'מ"ק' },
    { g: 'בטון',          n: 'רשת פלדה Q188', kg: 0,  u: "יח'" },
    { g: 'בטון',          n: 'ברזל זיון 12 מ"מ', kg: 0.888, u: "מ'" },
    { g: 'אביזרים',       n: 'פלטת בסיס', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'בורג עיגון', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'מרזב', kg: 0, u: "מ'" },
    // Gate hardware. Named by gates.js but absent from the catalogue, so
    // every gate priced at zero no matter what was in the price table.
    { g: 'שערים',        n: 'RHS 60x40x2', kg: 2.93, u: "מ'" },
    { g: 'שערים',        n: 'רשת מרותכת 50/200', kg: 0, u: 'מ"ר' },
    { g: 'שערים',        n: 'צירי שער כבדים', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'בריח נעילה', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'בריח קרקע מרכזי', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'מסילת שער', kg: 0, u: "מ'" },
    { g: 'שערים',        n: 'גלגלי מסילה', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'עגלות נשיאה', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'מוביל עליון', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'מנוע שער חשמלי', kg: 0, u: "יח'" },
    { g: 'שערים',        n: 'צבע/גילוון וצביעה', kg: 0, u: 'מ"ר' },
    // Living-unit items, same reason.
    { g: 'מגורים',       n: 'בלוק בטון 20 ס"מ', kg: 0, u: 'מ"ר' },
    { g: 'מגורים',       n: 'טיח פנים', kg: 0, u: 'מ"ר' },
    { g: 'מגורים',       n: 'חיפוי קרמיקה', kg: 0, u: 'מ"ר' },
    { g: 'מגורים',       n: 'פרופיל U לפאנל', kg: 0, u: "מ'" },
    { g: 'מגורים',       n: 'דלת פנים', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'חלון אלומיניום', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'אסלה כולל מיכל', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'מקלחון / אגן מקלחת', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'כיור רחצה', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'דוד שמש 150 ליטר', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'צנרת מים קרים', kg: 0, u: "מ'" },
    { g: 'מגורים',       n: 'צנרת ביוב', kg: 0, u: "מ'" },
    { g: 'מגורים',       n: 'נקודת חשמל', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'לוח חשמל', kg: 0, u: "יח'" },
    { g: 'מגורים',       n: 'מזגן מיני מרכזי', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'שער הזזה', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'עמוד גדר', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'רשת גדר', kg: 0, u: "מ'" },
    { g: 'אביזרים',       n: 'צינור ניקוז', kg: 0, u: "יח'" }
  ];

  // Starting points, not templates to be printed as-is. Each is a shape the
  // maintenance team actually builds, so a project starts one click from
  // something recognisable instead of from a blank 10×20 box.
  var MODELS = {
    canopy:   { label: ['סככת צל פתוחה', 'โรงเรือนเปิด', 'مظلة مفتوحة'],
                span: 10, length: 20, eaves: 4, bay: 5, pitch: 8,
                roofType: 'gable', wallMode: 'open', roofClad: 'iskurit', walls: false },
    leanto:   { label: ['סככה חד-שיפועית', 'หลังคาเพิงหมาแหงน', 'سقيفة بميل واحد'],
                span: 6, length: 12, eaves: 3.2, bay: 4, pitch: 7,
                roofType: 'mono', wallMode: 'half', roofClad: 'iskurit', walls: true },
    service:  { label: ['סככת שירות סגורה', 'อาคารบริการปิด', 'سقيفة خدمة مغلقة'],
                span: 8, length: 15, eaves: 3.5, bay: 5, pitch: 10,
                roofType: 'gable', wallMode: 'full', roofClad: 'panel', walls: true },
    warehouse:{ label: ['מחסן / אריזה', 'โกดัง', 'مستودع'],
                span: 16, length: 40, eaves: 6, bay: 6, pitch: 12,
                roofType: 'gable', wallMode: 'full', roofClad: 'panel', walls: true },
    ramp:     { label: ['רמפת העמסה מקורה', 'ทางลาดมีหลังคา', 'منحدر تحميل مغطى'],
                span: 6, length: 24, eaves: 4.5, bay: 6, pitch: 6,
                roofType: 'mono', wallMode: 'open', roofClad: 'iskurit', walls: false }
  };

  var TYPES = [
    { v: 'shed',  icon: '\ud83c\udfd7' },
    { v: 'slab',  icon: '\ud83e\uddf1' },
    { v: 'house', icon: '\ud83c\udfe0' }
  ];
  function typeLabel(v) {
    if (v === 'shed')  return tt('סככה / מבנה קל', 'โรงเรือน', 'سقيفة');
    if (v === 'slab')  return tt('משטח בטון / רמפה', 'พื้นคอนกรีต', 'سطح خرساني');
    if (v === 'house') return tt('מבנה מגורים', 'บ้าน', 'مبنى سكني');
    return v;
  }

  // ── display translation ──────────────────────────────────────────────
  // Catalogue names double as the key that joins takeoff → catalogue →
  // supplier order → maintenance material line. Renaming them per language
  // would break every saved project, so the Hebrew string stays the key and
  // this table translates it only at the moment it is displayed.
  // Product designations (HEA 160, Q188, RHS 100x50x3) are international
  // and deliberately absent — translating a section size would be wrong.
  var DICT = {
    'עמודים / קורות': ['เสา / คาน', 'أعمدة / روافد'],
    'פרופיל מלבני':  ['โปรไฟล์สี่เหลี่ยมผืนผ้า', 'مقطع مستطيل'],
    'פרופיל מרובע':  ['โปรไฟล์สี่เหลี่ยมจัตุรัส', 'مقطع مربع'],
    'מרישים':        ['แป', 'مرايش'],
    'חיפוי':         ['วัสดุปิดผิว', 'تغطية'],
    'בטון':          ['คอนกรีต', 'خرسانة'],
    'אביזרים':       ['อุปกรณ์', 'ملحقات'],
    'שערים':         ['ประตู', 'بوابات'],
    'מגורים':        ['ที่พัก', 'سكن'],
    'איסכורית 0.4 מ"מ': ['เมทัลชีท 0.4 มม.', 'صاج 0.4 مم'],
    'איסכורית 0.5 מ"מ': ['เมทัลชีท 0.5 มม.', 'صاج 0.5 مم'],
    'איסכורית 0.6 מ"מ': ['เมทัลชีท 0.6 มม.', 'صاج 0.6 مم'],
    'איסכורית 0.7 מ"מ': ['เมทัลชีท 0.7 มม.', 'صاج 0.7 مم'],
    'פאנל קלקר 5 ס"מ':   ['แผ่นฉนวน EPS 5 ซม.', 'بانل فلين 5 سم'],
    'פאנל קלקר 7.5 ס"מ': ['แผ่นฉนวน EPS 7.5 ซม.', 'بانل فلين 7.5 سم'],
    'פאנל קלקר 10 ס"מ':  ['แผ่นฉนวน EPS 10 ซม.', 'بانل فلين 10 سم'],
    'פאנל קלקר 15 ס"מ':  ['แผ่นฉนวน EPS 15 ซม.', 'بانل فلين 15 سم'],
    'פאנל צמר סלעים 5 ס"מ':  ['แผ่นใยหิน 5 ซม.', 'بانل صوف صخري 5 سم'],
    'פאנל צמר סלעים 10 ס"מ': ['แผ่นใยหิน 10 ซม.', 'بانل صوف صخري 10 سم'],
    'לוח סקיילייט':      ['แผ่นสกายไลท์', 'لوح إضاءة'],
    'בטון ב-30':         ['คอนกรีต B-30', 'خرسانة B-30'],
    'רשת פלדה Q188':     ['ตะแกรงเหล็ก Q188', 'شبكة حديد Q188'],
    'ברזל זיון 12 מ"מ':  ['เหล็กเส้น 12 มม.', 'حديد تسليح 12 مم'],
    'פלטת בסיס':     ['แผ่นฐาน', 'لوح قاعدة'],
    'בורג עיגון':    ['สลักยึด', 'برغي تثبيت'],
    'מרזב':          ['รางน้ำ', 'مزراب'],
    'צינור ניקוז':   ['ท่อระบายน้ำ', 'أنبوب تصريف'],
    'שער הזזה':      ['ประตูเลื่อน', 'بوابة منزلقة'],
    'עמוד גדר':      ['เสารั้ว', 'عمود سياج'],
    'רשת גדר':       ['ตาข่ายรั้ว', 'شبك سياج'],
    // units
    'ליטר': ['ลิตร', 'لتر'],   'ק"ג': ['กก.', 'كغ'],
    "יח'":  ['ชิ้น', 'قطعة'],  "מ'":  ['ม.', 'م'],
    'מ"ר':  ['ตร.ม.', 'م²'],   'מ"ק': ['ลบ.ม.', 'م³'],
    'טון':  ['ตัน', 'طن'],     'שק':  ['ถุง', 'كيس'],
    'גליל': ['ม้วน', 'لفة'],   'משטח': ['พาเลท', 'منصة'],
    // notes emitted by the takeoff
    'רצפה': ['พื้น', 'أرضية'],
    'כולל חפיפה': ['รวมทาบ', 'شامل التداخل'],
    'היקף וחיזוקים': ['ขอบและเสริม', 'محيط وتقوية'],
    'כולל פחת': ['รวมเผื่อ', 'شامل الهدر']
  };

  // Translate a stored name for display. Unknown names — a profile the user
  // added themselves — pass through unchanged rather than disappearing.
  function dsp(name) {
    var e = DICT[name];
    if (!e) return String(name == null ? '' : name);
    return tt(name, e[0], e[1]);
  }

  // Index a ['he','th','ar'] label array by the active language.
  function pick(arr) {
    if (!arr || !arr.length) return '';
    return tt(arr[0], arr[1] || arr[0], arr[2] || arr[0]);
  }

  // ── helpers ──
  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  // Coarse pointer or a narrow viewport: treat as a phone for defaults.
  function isPhone() {
    return (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches) ||
           (window.innerWidth || 1024) < 820;
  }
  function isManager() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function money(x) {
    return '\u20aa' + (Math.round((Number(x) || 0) * 100) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── persistence ──
  // Old projects stored a type ('iskurit' | 'panel' | 'none') in *Clad and a
  // product name in *Panel. Fold them into one field, preferring whatever
  // the type said, because that is what the drawing was showing.
  function migrateClad(clad, panel, fallback) {
    var c = String(clad || '');
    if (c === 'none') return 'none';
    if (c === 'iskurit') return /איסכורית/.test(String(panel || '')) ? panel : 'איסכורית 0.5 מ"מ';
    if (c === 'panel')   return /פאנל/.test(String(panel || '')) ? panel : 'פאנל קלקר 5 ס"מ';
    if (c) return c;                       // already a product name
    return String(panel || fallback);
  }

  function normDim(d) {
    d = d || {};
    return {
      span:    Number(d.span)    || 10,   // width, m
      length:  Number(d.length)  || 20,   // m
      eaves:   Number(d.eaves)   || 4,    // column height, m
      bay:     Number(d.bay)     || 5,    // frame spacing, m
      pitch:   Number(d.pitch)   || 10,   // deg
      purlinSp: Number(d.purlinSp) || 1.5,
      girtSp:   Number(d.girtSp)   || 1.5,
      slabTh:   Number(d.slabTh)   || 0.15, // m
      slabArea: Number(d.slabArea) || 0,    // m², 0 = derive from span×length
      waste:    Number(d.waste)    || 8,    // %
      colProfile:    String(d.colProfile    || 'HEA 160'),
      rafterProfile: String(d.rafterProfile || 'IPE 200'),
      purlinProfile: String(d.purlinProfile || 'Z 200x2.0'),
      girtProfile:   String(d.girtProfile   || 'C 150x2.0'),
      walls:  d.walls === false ? false : true,
      // Gutters, like cladding, are a choice. They were defaulting on and
      // adding downspouts to sheds that have neither a roof nor a gutter.
      gutter: d.gutter === true,
      // 3D / buildability
      roofType: (d.roofType === 'mono') ? 'mono' : 'gable',
      wallMode: (d.wallMode === 'open' || d.wallMode === 'half') ? d.wallMode : 'full',
      // The catalogue product itself, or 'none'. Migrated from the old
      // type-enum so existing projects keep a sensible material.
      // 'none', not a product. A takeoff must never contain something the
      // user did not ask for — being billed a panel roof you never chose is
      // worse than having to pick one. Existing projects still migrate to
      // whatever they had; only a brand-new project starts empty.
      roofClad: migrateClad(d.roofClad, d.roofPanel, 'none'),
      wallClad: migrateClad(d.wallClad, d.wallPanel, 'none'),
      footings: d.footings === false ? false : true,
      footW: Number(d.footW) || 1.0,               // pad side, m
      footD: Number(d.footD) || 0.8,               // pad depth, m
      soilBearing: Number(d.soilBearing) || 150,   // kPa
      roofLoad: Number(d.roofLoad) || 0.55,        // kN/m², dead + live
      fence: !!d.fence,
      fenceH: Number(d.fenceH) || 2,
      fenceOff: Number(d.fenceOff) || 2,
      // structure detail
      rafterType: (d.rafterType === 'truss') ? 'truss' : 'solid',
      trussDepth: Number(d.trussDepth) || 0.8,
      haunch: d.haunch === false ? false : true,
      taper: !!d.taper,
      bracing: d.bracing === false ? false : true,
      skylights: Number(d.skylights) || 0,
      door: !!d.door,
      doorW: Number(d.doorW) || 4,
      doorH: Number(d.doorH) || 3.5,
      leanTo: Number(d.leanTo) || 0,
      mezz: Number(d.mezz) || 0,
      mezzH: Number(d.mezzH) || 3,
      // scene
      // 'staff' by default: a graduated survey rod is a drawing convention,
      // reads at any zoom, and does not pretend the site has vegetation on
      // it that nobody has surveyed.
      scaleRef: ['none','staff','person','palm'].indexOf(d.scaleRef) >= 0 ? d.scaleRef : 'staff',
      scaleH: Number(d.scaleH) || 9,
      callouts: d.callouts === false ? false : true,
      // Shadows and the satellite ground are the two most expensive things
      // in the scene, so on a phone they default off rather than making the
      // first open feel broken. Both are one tap away in סביבה ותאורה.
      // Off unless explicitly asked for: a second full pass over the scene
      // for something nobody was looking at.
      shadows: d.shadows === true,
      mapGround: (d.mapGround === undefined) ? !isPhone() : !!d.mapGround,
      dims: d.dims === false ? false : true,
      sunAz: Number(d.sunAz) || 130,
      sunEl: Number(d.sunEl) || 48
    };
  }

  function normProject(x) {
    x = x || {};
    return {
      id: x.id || uid(),
      name: String(x.name || ''),
      type: (x.type === 'slab' || x.type === 'house') ? x.type : 'shed',
      // Which components this project actually contains. `type` decides the
      // SHAPE of the structure; these decide whether there is a structure at
      // all. Without them a project consisting of nothing but a gate was
      // still billed a full portal frame — 4.5 t of steel and 38 m3 of
      // concrete nobody asked for.
      // Default true so every existing project is unchanged; a new project
      // created from the gate or living tab turns it off.
      hasStruct: x.hasStruct === false ? false : true,
      hasSlab: x.hasSlab === false ? false : true,
      client: String(x.client || ''),
      status: String(x.status || 'planning'),
      notes: String(x.notes || ''),
      sketch: (x.sketch && Array.isArray(x.sketch.shapes)) ? x.sketch : { shapes: [] },
      // Components, not project types. A yard job is routinely a shed plus a
      // slab plus a gate plus a room for the crew, and quoting it as four
      // projects loses the fact that it is one price to one client.
      gates: Array.isArray(x.gates)
        ? x.gates.map(function (g) { return (typeof Gates !== 'undefined') ? Gates.norm(g) : g; })
        : [],
      living: (x.living && x.living.people)
        ? ((typeof LivingUnit !== 'undefined') ? LivingUnit.norm(x.living) : x.living)
        : null,
      maintId: (x.maintId === undefined || x.maintId === null) ? null : Number(x.maintId),
      maintName: String(x.maintName || ''),
      createdAt: Number(x.createdAt) || Date.now(),
      createdBy: String(x.createdBy || ''),
      dims: normDim(x.dims),
      // Footprint stored as {lat,lng} objects, never arrays — Firestore has
      // no nested-array type and silently mangles them.
      footprint: Array.isArray(x.footprint) ? x.footprint.map(function (pt) {
        return { lat: Number(pt.lat) || 0, lng: Number(pt.lng) || 0 };
      }) : [],
      footprintArea: Number(x.footprintArea) || 0,
      // Parametric form of a rectangular footprint, when it was made with
      // the rectangle tool. Null for a freehand-traced ring.
      rect: (x.rect && Number(x.rect.w) > 0)
        ? { lat: Number(x.rect.lat) || 0, lng: Number(x.rect.lng) || 0,
            w: Number(x.rect.w) || 0, h: Number(x.rect.h) || 0, rot: Number(x.rect.rot) || 0 }
        : null,
      extras: Array.isArray(x.extras) ? x.extras.map(function (e) {
        return { name: String(e.name || ''), qty: Number(e.qty) || 0, unit: String(e.unit || "יח'") };
      }) : []
    };
  }

  function normCat(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = { profiles: [], steelPerKg: Number(s.steelPerKg) || 0,
                pricedAt: Number(s.pricedAt) || 0 };
    if (Array.isArray(s.profiles) && s.profiles.length) {
      out.profiles = s.profiles.map(function (p) {
        return {
          id: p.id || uid(),
          group: String(p.group || ''),
          name: String(p.name || ''),
          kgPerM: Number(p.kgPerM) || 0,
          unit: String(p.unit || "מ'"),
          price: Number(p.price) || 0
        };
      });
    } else {
      out.profiles = SEED.map(function (s2) {
        return { id: uid() + Math.random(), group: s2.g, name: s2.n, kgPerM: s2.kg,
                 unit: s2.u, price: seedPrice(s2.n, s2.kg, s2.u) };
      });
      out.steelPerKg = STEEL_PER_KG;
      out.pricedAt = Date.now();
    }
    return out;
  }

  function loadAll() {
    return Promise.all([DB.loadAsync(PROJ_KEY), DB.loadAsync(CAT_KEY)]).then(function (r) {
      var d = r[0] || {};
      P = { projects: Array.isArray(d.projects) ? d.projects.map(normProject) : [] };
      C = normCat(r[1]);
      return true;
    });
  }

  function listen() {
    if (_listening) return;
    _listening = true;
    DB.listen(PROJ_KEY, function (d) {
      if (JSON.stringify(d) === _lastP) return;
      P = { projects: (d && Array.isArray(d.projects)) ? d.projects.map(normProject) : [] };
      drawFootprints();
      if (isOpen()) repaint();
    });
    DB.listen(CAT_KEY, function (d) {
      if (JSON.stringify(d) === _lastC) return;
      C = normCat(d);
      if (isOpen()) repaint();
    });
  }

  function saveP() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var clean = JSON.parse(JSON.stringify(P));
    _lastP = JSON.stringify(clean);
    DB.save(PROJ_KEY, clean);
    drawFootprints();
  }
  function saveC() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var clean = JSON.parse(JSON.stringify(C));
    _lastC = JSON.stringify(clean);
    DB.save(CAT_KEY, clean);
  }

  function projById(id) {
    var hit = null;
    (P.projects || []).forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }
  function profByName(n) {
    var hit = null;
    (C.profiles || []).forEach(function (p) { if (p.name === n) hit = p; });
    return hit;
  }

  // ══════════════════════════════════════════════════════════════════
  //  GEOMETRY + TAKEOFF
  // ══════════════════════════════════════════════════════════════════
  function geom(d) {
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
  }

  // Preliminary pad-footing check. Tributary area per column × roof load
  // gives the axial load; required area = load / allowable bearing.
  // This is a SIZING AID, not a structural design — it assumes uniform
  // load, no wind uplift, no moment at the base and a homogeneous soil,
  // and the UI says so. A real footing needs an engineer and a soil report.
  function footing(d) {
    var g = geom(d);
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
  }

  function concrete(p) {
    var d = p.dims;
    var a = slabArea(p);
    var slab = a * d.slabTh;
    var f = (p.type === 'slab' || !d.footings) ? { volAll: 0, n: 0 } : footing(d);
    return { area: a, slab: slab, footings: f.volAll, pads: f.n, total: slab + f.volAll };
  }

  function slabArea(p) {
    var d = p.dims;
    // A footprint traced on the map beats a typed rectangle — it is the
    // actual ground being poured.
    if (p.footprintArea > 0) return p.footprintArea;
    if (d.slabArea > 0) return d.slabArea;
    return d.span * d.length;
  }

  // Returns [{name, qty, unit, kg, note}]
  function takeoff(p) {
    var d = p.dims, out = [];
    var w = 1 + (d.waste / 100);
    var wantStruct = p.hasStruct !== false;
    var wantSlab = p.hasSlab !== false;

    function push(name, qty, unit, note) {
      if (!(qty > 0)) return;
      var pr = profByName(name);
      var kg = (pr && pr.kgPerM && unit === "מ'") ? qty * pr.kgPerM : 0;
      out.push({ name: name, qty: qty, unit: unit, kg: kg, note: note || '' });
    }

    if (p.type === 'slab') {
      var a = slabArea(p);
      push('בטון ב-30', a * d.slabTh * w, 'מ"ק',
        n1(a) + ' ' + dsp('מ"ר') + ' \u00d7 ' + d.slabTh + ' ' + dsp("מ'"));
      // Q188 sheets are 6×2.35 m; 10% is the standard lap allowance.
      push('רשת פלדה Q188', Math.ceil(a / (6 * 2.35) * 1.1), "יח'", tt('כולל חפיפה', 'รวมทาบ', 'شامل التداخل'));
      push('ברזל זיון 12 מ"מ', Math.sqrt(a) * 4 * 2 * w, "מ'", tt('היקף וחיזוקים', 'ขอบและเสริม', 'محيط وتقوية'));
      (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
      componentLines(p).forEach(function (l) { push(l.name, l.qty, l.unit, l.note); });
      return out;
    }

    var g = geom(d);
    // No structure requested — a gate-only or slab-only project skips the
    // entire frame. This is the fix for a project named "שער" that was
    // billed 4.5 tonnes of steel and a 200 m2 roof nobody asked for.
    if (!wantStruct) {
      if (wantSlab) {
        var sa = slabArea(p);
        push('בטון ב-30', sa * d.slabTh * w, 'מ"ק', tt('רצפה', 'พื้น', 'أرضية'));
        push('רשת פלדה Q188', Math.ceil(sa / (6 * 2.35) * 1.1), "יח'", tt('רצפה', 'พื้น', 'أرضية'));
      }
      (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
      componentLines(p).forEach(function (l) { push(l.name, l.qty, l.unit, l.note); });
      return out;
    }
    push(d.colProfile,    g.frames * 2 * d.eaves * w, "מ'",
      g.frames * 2 + ' ' + tt('עמודים', 'เสา', 'أعمدة') + ' \u00d7 ' + n1(d.eaves) + ' ' + dsp("מ'"));
    push(d.rafterProfile, g.frames * 2 * g.rafterLen * w, "מ'",
      g.frames * 2 + ' ' + tt('קורות', 'คาน', 'روافد') + ' \u00d7 ' + n1(g.rafterLen) + ' ' + dsp("מ'"));
    push(d.purlinProfile, g.purlinRuns * 2 * d.length * w, "מ'",
      (g.purlinRuns * 2) + ' ' + tt('שורות מרישים', 'แถวแป', 'صفوف') + ' \u00d7 ' + n1(d.length) + ' ' + dsp("מ'"));
    if (d.wallMode !== 'open' && d.wallClad !== 'none') {
      push(d.girtProfile, g.girtRows * g.perimeter * w, "מ'",
        g.girtRows + ' ' + tt('שורות', 'แถว', 'صفوف'));
    }
    // Cladding is billed only when it is actually specified. The model
    // honoured 'ללא' and 'פתוח'; the takeoff did not, so switching the roof
    // off changed the drawing and left the price alone.
    if (d.roofClad !== 'none') {
      push(d.roofClad, g.roofArea * w, 'מ"ר', tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    }
    if (d.wallMode !== 'open' && d.wallClad !== 'none') {
      push(d.wallClad, g.wallArea * w, 'מ"ר', tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    }
    push('פלטת בסיס', g.frames * 2, "יח'", '');
    push('בורג עיגון', g.frames * 2 * 4, "יח'", tt('4 לעמוד', '4 ต่อเสา', '4 لكل عمود'));
    if (d.gutter && d.roofClad !== 'none') {
      push('מרזב', 2 * d.length, "מ'", '');
      push('צינור ניקוז', Math.max(2, Math.ceil(d.length / 12) * 2), "יח'", '');
    }
    // Foundation under the frame, always poured with a shed.
    var fa = slabArea(p);
    if (wantSlab) push('בטון ב-30', fa * d.slabTh * w, 'מ"ק', tt('רצפה', 'พื้น', 'أرضية'));
    if (d.footings) {
      var ft = footing(d);
      push('בטון ב-30', ft.volAll * w, 'מ"ק',
        ft.n + ' ' + tt('בסיסי עמוד', 'ฐานเสา', 'قواعد أعمدة') + ' ' +
        n1(d.footW) + '\u00d7' + n1(d.footW) + '\u00d7' + n1(d.footD) + ' ' + dsp("מ'"));
      push('ברזל זיון 12 מ"מ', ft.n * d.footW * 8 * 2 * w, "מ'",
        tt('כלוב זיון לבסיסים', 'เหล็กฐาน', 'تسليح القواعد'));
    }
    if (d.skylights > 0 && d.roofClad !== 'none') {
      var skyA = (d.skylights * (d.length / (d.skylights * 2 + 1))) * g.rafterLen * 2;
      push('לוח סקיילייט', skyA * w, 'מ"ר', d.skylights + ' ' + tt('רצועות', 'แถบ', 'شرائط'));
    }
    if (d.leanTo > 0) {
      var lRaf = d.leanTo / Math.cos(Math.max(4, d.pitch * 0.6) * Math.PI / 180);
      push(d.rafterProfile, g.frames * lRaf * w, "מ'", tt('סככת צד', 'เพิงข้าง', 'جناح جانبي'));
      push(d.colProfile, g.frames * d.eaves * 0.85 * w, "מ'", tt('עמודי סככת צד', 'เสาเพิง', 'أعمدة الجناح'));
      if (d.roofClad !== 'none') {
        push(d.roofClad, d.length * lRaf * w, 'מ"ר', tt('גג סככת צד', 'หลังคาเพิง', 'سقف الجناح'));
      }
    }
    if (d.mezz > 0) {
      push(d.rafterProfile, (g.bays + 1) * d.mezz * w, "מ'", tt('קורות גלריה', 'คานชั้นลอย', 'روافد الميزانين'));
      push('רשת פלדה Q188', Math.ceil(d.length * d.mezz / (6 * 2.35) * 1.1), "יח'",
        tt('רצפת גלריה', 'พื้นชั้นลอย', 'أرضية الميزانين'));
    }
    if (d.door) push('שער הזזה', 1, "יח'", n1(d.doorW) + '\u00d7' + n1(d.doorH) + ' ' + dsp("מ'"));
    if (d.fence) {
      var per = 2 * ((d.length + d.fenceOff * 2) + (d.span + d.fenceOff * 2));
      push('עמוד גדר', Math.ceil(per / 2.5), "יח'", n1(d.fenceH) + ' ' + dsp("מ'"));
      push('רשת גדר', per, "מ'", n1(d.fenceH) + ' ' + dsp("מ'") + ' ' + tt('גובה', 'สูง', 'ارتفاع'));
    }
    if (wantSlab) push('רשת פלדה Q188', Math.ceil(fa / (6 * 2.35) * 1.1), "יח'", tt('רצפה', 'พื้น', 'أرضية'));
    (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
    componentLines(p).forEach(function (l) { push(l.name, l.qty, l.unit, l.note); });
    return out;
  }

  // Gates and accommodation contribute to the same bill of quantities as the
  // structure. Keeping them in separate documents is how a client ends up
  // with three quotes for one job and no total.
  function componentLines(p) {
    var out = [];
    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (g, i) {
        Gates.takeoff(g).forEach(function (l) {
          out.push({ name: l.name, qty: l.qty, unit: l.unit,
                     note: (g.name || (tt('שער','ประตู','بوابة') + ' ' + (i+1))) +
                           (l.note ? ' \u00b7 ' + l.note : '') });
        });
      });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      LivingUnit.takeoff(p.living).forEach(function (l) {
        out.push({ name: l.name, qty: l.qty, unit: l.unit,
                   note: tt('מגורים','ที่พัก','سكن') + (l.note ? ' \u00b7 ' + l.note : '') });
      });
    }
    return out;
  }

  function takeoffTotals(rows) {
    var cost = 0, kg = 0, unpriced = 0;
    rows.forEach(function (r) {
      var pr = profByName(r.name);
      if (pr && pr.price > 0) cost += r.qty * pr.price; else unpriced++;
      kg += r.kg;
    });
    return { cost: cost, kg: kg, unpriced: unpriced };
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE DRAWING
  // ══════════════════════════════════════════════════════════════════
  // A scaled section + plan, rebuilt on every input change. Colours come
  // from theme variables so it reads on the dark theme; stroke widths are
  // fixed px because they are line weights, not scene dimensions.
  function svg(p) {
    var d = p.dims;
    if (p.type === 'slab') return slabSvg(p);
    var g = geom(d);

    var W = 620, H = 300, pad = 46;
    var sx = (W - pad * 2) / d.span;
    var sy = (H - pad * 2 - 26) / Math.max(g.ridgeH, 1);
    var s = Math.min(sx, sy);
    var x0 = (W - d.span * s) / 2;
    var y0 = H - pad;

    function X(m) { return x0 + m * s; }
    function Y(m) { return y0 - m * s; }

    var eL = { x: X(0), y: Y(d.eaves) };
    var eR = { x: X(d.span), y: Y(d.eaves) };
    var apex = { x: X(d.span / 2), y: Y(g.ridgeH) };

    var parts = [];
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="none"/>');
    // ground
    parts.push('<line x1="' + (x0 - 26) + '" y1="' + y0 + '" x2="' + (X(d.span) + 26) + '" y2="' + y0 +
      '" stroke="var(--text-muted,#888)" stroke-width="2"/>');
    // slab
    parts.push('<rect x="' + (x0 - 6) + '" y="' + y0 + '" width="' + (d.span * s + 12) +
      '" height="' + Math.max(4, d.slabTh * s) + '" fill="var(--text-muted,#888)" opacity=".45"/>');
    // rafters + roof
    parts.push('<polyline points="' + eL.x + ',' + eL.y + ' ' + apex.x + ',' + apex.y + ' ' +
      eR.x + ',' + eR.y + '" fill="none" stroke="var(--primary,#2d6a4f)" stroke-width="4" ' +
      'stroke-linejoin="round"/>');
    // columns
    parts.push('<line x1="' + eL.x + '" y1="' + eL.y + '" x2="' + eL.x + '" y2="' + y0 +
      '" stroke="var(--primary,#2d6a4f)" stroke-width="5"/>');
    parts.push('<line x1="' + eR.x + '" y1="' + eR.y + '" x2="' + eR.x + '" y2="' + y0 +
      '" stroke="var(--primary,#2d6a4f)" stroke-width="5"/>');
    // purlin dots along each slope
    for (var i = 1; i < g.purlinRuns - 1; i++) {
      var f = i / (g.purlinRuns - 1);
      parts.push('<circle cx="' + (eL.x + (apex.x - eL.x) * f) + '" cy="' +
        (eL.y + (apex.y - eL.y) * f) + '" r="3" fill="var(--accent,#ff9f43)"/>');
      parts.push('<circle cx="' + (eR.x + (apex.x - eR.x) * f) + '" cy="' +
        (eR.y + (apex.y - eR.y) * f) + '" r="3" fill="var(--accent,#ff9f43)"/>');
    }
    // girts on the walls
    if (d.wallMode !== 'open') {
      for (var r = 1; r <= g.girtRows; r++) {
        var yy = Y(d.eaves * r / (g.girtRows + 1));
        parts.push('<line x1="' + eL.x + '" y1="' + yy + '" x2="' + (eL.x + 12) + '" y2="' + yy +
          '" stroke="var(--water,#4fc3f7)" stroke-width="3"/>');
        parts.push('<line x1="' + (eR.x - 12) + '" y1="' + yy + '" x2="' + eR.x + '" y2="' + yy +
          '" stroke="var(--water,#4fc3f7)" stroke-width="3"/>');
      }
    }
    // dimensions
    function dim(x1, y1, x2, y2, label, off) {
      return '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
        '" stroke="var(--text-muted,#999)" stroke-width="1" stroke-dasharray="3,3"/>' +
        '<text x="' + ((x1 + x2) / 2) + '" y="' + ((y1 + y2) / 2 + (off || -5)) +
        '" fill="var(--text,#ddd)" font-size="12" font-weight="700" text-anchor="middle">' +
        label + '</text>';
    }
    parts.push(dim(x0, y0 + 22, X(d.span), y0 + 22, n1(d.span) + ' m', 14));
    parts.push(dim(x0 - 22, y0, x0 - 22, Y(d.eaves), n1(d.eaves) + ' m', 0));
    parts.push('<text x="' + apex.x + '" y="' + (apex.y - 12) + '" fill="var(--text,#ddd)" ' +
      'font-size="12" font-weight="700" text-anchor="middle">' + n1(g.ridgeH) + ' m \u00b7 ' +
      n1(d.pitch) + '\u00b0</text>');

    var section = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">' +
      parts.join('') + '</svg>';

    // ── plan view: frame lines along the length ──
    var PW = 620, PH = 190, ppad = 40;
    var ps = Math.min((PW - ppad * 2) / d.length, (PH - ppad * 2) / d.span);
    var px0 = (PW - d.length * ps) / 2, py0 = (PH - d.span * ps) / 2;
    var pp = [];
    pp.push('<rect x="' + px0 + '" y="' + py0 + '" width="' + (d.length * ps) + '" height="' +
      (d.span * ps) + '" fill="var(--primary,#2d6a4f)" opacity=".10" ' +
      'stroke="var(--primary,#2d6a4f)" stroke-width="2"/>');
    for (var k = 0; k < g.frames; k++) {
      var fx = px0 + (d.length * ps) * (k / g.bays);
      pp.push('<line x1="' + fx + '" y1="' + py0 + '" x2="' + fx + '" y2="' + (py0 + d.span * ps) +
        '" stroke="var(--primary,#2d6a4f)" stroke-width="2.5"/>');
      pp.push('<circle cx="' + fx + '" cy="' + py0 + '" r="3.5" fill="var(--accent,#ff9f43)"/>');
      pp.push('<circle cx="' + fx + '" cy="' + (py0 + d.span * ps) + '" r="3.5" fill="var(--accent,#ff9f43)"/>');
    }
    // ridge
    pp.push('<line x1="' + px0 + '" y1="' + (py0 + d.span * ps / 2) + '" x2="' + (px0 + d.length * ps) +
      '" y2="' + (py0 + d.span * ps / 2) + '" stroke="var(--accent,#ff9f43)" stroke-width="1.5" ' +
      'stroke-dasharray="6,4"/>');
    pp.push('<text x="' + (px0 + d.length * ps / 2) + '" y="' + (py0 + d.span * ps + 22) +
      '" fill="var(--text,#ddd)" font-size="12" font-weight="700" text-anchor="middle">' +
      n1(d.length) + ' m \u00b7 ' + g.frames + ' ' + tt('מסגרות', 'เฟรม', 'إطارات') +
      ' @ ' + n1(g.actualBay) + ' m</text>');

    var plan = '<svg viewBox="0 0 ' + PW + ' ' + PH + '" style="width:100%;height:auto;">' +
      pp.join('') + '</svg>';

    return '<div class="bp-draw">' + section + '</div>' +
           '<div class="bp-draw" style="margin-top:8px;">' + plan + '</div>';
  }

  function slabSvg(p) {
    var d = p.dims;
    var a = slabArea(p);
    var W = 620, H = 220, pad = 44;
    // Deliberately NOT named L — that is Leaflet's global, and shadowing it
    // anywhere in this module makes `typeof L` ambiguous for every other
    // function in it.
    var sLen = d.length, sWid = d.span;
    if (p.footprintArea > 0) {
      // Keep the drawn proportion but scale it to the measured area, so the
      // sketch matches the polygon rather than the unused typed rectangle.
      var k = Math.sqrt(a / Math.max(sLen * sWid, 0.01));
      sLen = sLen * k; sWid = sWid * k;
    }
    var s = Math.min((W - pad * 2) / sLen, (H - pad * 2) / sWid);
    var x0 = (W - sLen * s) / 2, y0 = (H - sWid * s) / 2;
    var out = [];
    out.push('<rect x="' + x0 + '" y="' + y0 + '" width="' + (sLen * s) + '" height="' + (sWid * s) +
      '" fill="var(--text-muted,#888)" opacity=".22" stroke="var(--text-muted,#aaa)" stroke-width="2"/>');
    // mesh
    for (var i = 1; i < 8; i++) {
      out.push('<line x1="' + (x0 + sLen * s * i / 8) + '" y1="' + y0 + '" x2="' + (x0 + sLen * s * i / 8) +
        '" y2="' + (y0 + sWid * s) + '" stroke="var(--water,#4fc3f7)" stroke-width="1" opacity=".5"/>');
    }
    for (var j = 1; j < 4; j++) {
      out.push('<line x1="' + x0 + '" y1="' + (y0 + sWid * s * j / 4) + '" x2="' + (x0 + sLen * s) +
        '" y2="' + (y0 + sWid * s * j / 4) + '" stroke="var(--water,#4fc3f7)" stroke-width="1" opacity=".5"/>');
    }
    out.push('<text x="' + (x0 + sLen * s / 2) + '" y="' + (y0 + sWid * s / 2 + 5) +
      '" fill="var(--text,#eee)" font-size="15" font-weight="800" text-anchor="middle">' +
      n1(a) + ' \u05de"\u05e8 \u00b7 ' + d.slabTh + ' \u05de\'</text>');
    out.push('<text x="' + (x0 + sLen * s / 2) + '" y="' + (y0 + sWid * s + 24) +
      '" fill="var(--text-muted,#aaa)" font-size="12" text-anchor="middle">' +
      n2(a * d.slabTh) + ' \u05de"\u05e7 ' + tt('בטון', 'คอนกรีต', 'خرسانة') + '</text>');
    return '<div class="bp-draw"><svg viewBox="0 0 ' + W + ' ' + H +
      '" style="width:100%;height:auto;">' + out.join('') + '</svg></div>';
  }

  // ══════════════════════════════════════════════════════════════════
  //  MAP FOOTPRINTS
  // ══════════════════════════════════════════════════════════════════
  function map() {
    return (window.MapAccess && MapAccess.getMap) ? MapAccess.getMap() : null;
  }

  function layer() {
    var m = map();
    if (!m || !window.L) return null;
    // Re-add if a previous attempt created the group before the map existed,
    // or if something cleared the map's layers underneath us.
    if (!_layer) _layer = L.layerGroup();
    if (!m.hasLayer(_layer)) _layer.addTo(m);
    return _layer;
  }

  function drawFootprints() {
    var lg = layer();
    if (!lg) return;
    lg.clearLayers();
    (P.projects || []).forEach(function (p) {
      if (!p.footprint || p.footprint.length < 3) return;
      var pts = p.footprint.map(function (pt) { return [pt.lat, pt.lng]; });
      var poly = L.polygon(pts, {
        color: '#ff9f43', weight: 2, fillColor: '#ff9f43', fillOpacity: 0.25, dashArray: '6,4'
      });
      poly.bindTooltip((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') + (p.name || ''), {
        permanent: false, direction: 'center'
      });
      poly.on('click', function () { open(p.id); });
      lg.addLayer(poly);
    });
  }

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
  function placeFromDims(id) {
    var p = projById(id), m = map();
    if (!p) return;
    if (!m) { toast('\u26a0\ufe0f ' + tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (typeof GeoEdit === 'undefined') return;
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      toast('\u26a0\ufe0f ' + tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else close();

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
      toast('\u25ad ' + n1(w) + ' \u00d7 ' + n1(h) + ' m \u00b7 ' +
        tt('גרור למקום', 'ลากไปยังตำแหน่ง', 'اسحب إلى الموقع'));
    }, 120);
    void c;
  }

  // The reverse: take the drawn rectangle's sides as the building's span
  // and length, so a footprint measured on site drives the model.
  function dimsFromRect(id) {
    var p = projById(id);
    if (!p || !p.rect || !(p.rect.w > 0)) {
      toast('\u26a0\ufe0f ' + tt('אין מלבן מסומן', 'ยังไม่มีสี่เหลี่ยม', 'لا يوجد مستطيل'));
      return;
    }
    p.dims.span = n1(p.rect.w);
    p.dims.length = n1(p.rect.h);
    saveP();
    toast('\u2705 ' + n1(p.rect.w) + ' \u00d7 ' + n1(p.rect.h) + ' m');
    open(id);
  }

  function startRect(id) {
    var m = map();
    if (!m) { toast('\u26a0\ufe0f ' + tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (typeof GeoEdit === 'undefined') {
      toast('\u26a0\ufe0f ' + tt('עורך הגיאומטריה לא נטען', 'ตัวแก้ไขไม่พร้อม', 'المحرر غير محمّل'));
      return;
    }
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      toast('\u26a0\ufe0f ' + tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else close();

    var p = projById(id);
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
  }

  function rectReadout(st) {
    var f = function (id2) { return document.getElementById(id2); };
    if (f('geW') && document.activeElement !== f('geW')) f('geW').value = n1(st.w);
    if (f('geH') && document.activeElement !== f('geH')) f('geH').value = n1(st.h);
    if (f('geR') && document.activeElement !== f('geR')) f('geR').value = Math.round(st.rot);
    var a = f('geArea');
    if (a) {
      a.textContent = n1(st.area) + ' \u05de"\u05e8' +
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
        '<span>\u25ad ' + tt('גרור על המפה ליצירת מלבן', 'ลากเพื่อสร้างสี่เหลี่ยม',
          'اسحب لإنشاء مستطيل') + '</span>' +
        '<span id="geArea" style="background:rgba(255,209,102,.16);border:1px solid rgba(255,209,102,.4);' +
          'padding:3px 9px;border-radius:9px;color:#ffd166;">\u2014</span>' +
        '<span style="display:inline-flex;gap:5px;align-items:center;background:rgba(255,255,255,.08);' +
          'padding:4px 8px;border-radius:9px;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + tt('רוחב', 'กว้าง', 'عرض') + '</span>' +
          '<input id="geW" type="number" step="0.1" style="' + fld + '" oninput="BuildPlan.geApply()">' +
          '<span style="font-size:.74rem;opacity:.85;">' + tt('אורך', 'ยาว', 'طول') + '</span>' +
          '<input id="geH" type="number" step="0.1" style="' + fld + '" oninput="BuildPlan.geApply()">' +
          '<span style="font-size:.74rem;opacity:.85;">' + tt('סיבוב°', 'หมุน°', 'دوران°') + '</span>' +
          '<input id="geR" type="number" step="1" style="' + fld + '" oninput="BuildPlan.geApply()">' +
        '</span>' +
        '<button onclick="BuildPlan.geRot(-15)" style="padding:5px 9px;border-radius:8px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-weight:800;">\u21ba15\u00b0</button>' +
        '<button onclick="BuildPlan.geRot(15)" style="padding:5px 9px;border-radius:8px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-weight:800;">\u21bb15\u00b0</button>' +
        '<button onclick="BuildPlan.geRedraw()" style="padding:5px 10px;border-radius:8px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-weight:700;">\u25ad ' +
          tt('צייר מחדש', 'วาดใหม่', 'ارسم مجدداً') + '</button>' +
        '<button onclick="BuildPlan.geSave(' + id + ')" style="padding:6px 14px;border-radius:8px;border:none;' +
          'background:#2d6a4f;color:#fff;font-weight:800;">\u2713 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
        '<button onclick="BuildPlan.geCancel()" style="padding:5px 10px;border-radius:8px;border:none;' +
          'background:rgba(255,71,87,.25);color:#fff;font-weight:700;">\u2715</button>' +
      '</div>';
  }

  function geApply() {
    if (typeof GeoEdit === 'undefined' || !GeoEdit.active()) return;
    var w = Number((document.getElementById('geW') || {}).value);
    var h = Number((document.getElementById('geH') || {}).value);
    var r = Number((document.getElementById('geR') || {}).value);
    GeoEdit.setDims(isFinite(w) ? w : null, isFinite(h) ? h : null, isFinite(r) ? r : null);
  }
  function geRot(d) { if (typeof GeoEdit !== 'undefined') GeoEdit.nudgeRot(d); }
  function geRedraw() { if (typeof GeoEdit !== 'undefined') GeoEdit.setMode('draw'); }

  function geCancel() {
    if (typeof GeoEdit !== 'undefined') GeoEdit.stop();
    _ge = null;
    banner(false);
    if (window.MapAccess) MapAccess.setExternalDraw(false);
    loadAll().then(function () { render(); });
  }

  function geSave(id) {
    if (typeof GeoEdit === 'undefined') return;
    var st = GeoEdit.get();
    if (!st || !st.pts || st.pts.length < 3) {
      toast('\u26a0\ufe0f ' + tt('צייר קודם מלבן', 'วาดก่อน', 'ارسم أولاً'));
      return;
    }
    var p = projById(id);
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
      saveP();
      toast('\u2705 ' + n1(st.area) + ' \u05de"\u05e8');
      open(id);
    }
  }

  function startFootprint(id) {
    var m = map();
    if (!m) { toast('\u26a0\ufe0f ' + tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      toast('\u26a0\ufe0f ' + tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else close();
    _draw = { id: id, pts: [], markers: [], labels: [], line: null, area: 0, per: 0 };
    m.on('click', onDrawClick);
    m.on('mousemove', onDrawMove);
    banner(true);
  }

  // ── live measurement ──────────────────────────────────────────────
  // Every edge is labelled with its length as it is drawn, and area,
  // perimeter and the closing edge update on each click and on mouse move.
  // Tracing a slab blind and discovering afterwards that it came out 9.2 m
  // instead of 10 means re-walking the site.
  function metres(a, b) { return map().distance(a, b); }

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
    if (!_draw) return;
    var m = map();
    (_draw.labels || []).forEach(function (l) { m.removeLayer(l); });
    _draw.labels = [];
    var pts = _draw.pts.slice();
    if (hover) pts.push(hover);
    for (var i = 0; i + 1 < pts.length; i++) {
      var lb = edgeLabel(pts[i], pts[i + 1]);
      lb.addTo(m); _draw.labels.push(lb);
    }
    // The closing edge is shown in a muted colour: it is implied by the
    // polygon, not yet drawn by the user.
    if (pts.length > 2) {
      var cl = edgeLabel(pts[pts.length - 1], pts[0], 'close');
      cl.addTo(m); _draw.labels.push(cl);
    }
    if (_draw.line) m.removeLayer(_draw.line);
    _draw.line = null;
    if (pts.length > 1) {
      _draw.line = L.polygon(pts, {
        color: '#ff9f43', weight: 2, fillOpacity: .18, dashArray: hover ? '6,5' : null
      }).addTo(m);
    }
    var area = (window.MapAccess && pts.length > 2) ? MapAccess.areaFromLatLngs(pts) : 0;
    var per = 0;
    for (var j = 0; j < pts.length; j++) {
      if (j + 1 < pts.length) per += metres(pts[j], pts[j + 1]);
    }
    if (pts.length > 2) per += metres(pts[pts.length - 1], pts[0]);
    _draw.area = area;
    _draw.per = per;
    banner(true);
  }

  function onDrawMove(e) {
    if (!_draw) return;
    // Highlight the first vertex when the cursor is near it, so the user can
    // see the polygon is about to close before committing the click.
    var near = nearFirst(e.latlng);
    if (near !== _draw.snap) {
      _draw.snap = near;
      if (_draw.markers[0]) {
        _draw.markers[0].setStyle({ radius: near ? 9 : 5, color: near ? '#2ecc71' : '#ff9f43' });
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
    if (!_draw || _draw.pts.length < 3) return false;
    var m = map();
    var a = m.latLngToContainerPoint(_draw.pts[0]);
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
  function addSegment() {
    if (!_draw) return;
    var lenEl = document.getElementById('bpSegLen');
    var angEl = document.getElementById('bpSegAng');
    var dist = Number(lenEl && lenEl.value) || 0;
    if (dist <= 0) { toast('\u26a0\ufe0f ' + tt('הזן אורך', 'ใส่ความยาว', 'أدخل الطول')); return; }
    var turn = Number(angEl && angEl.value);
    if (!isFinite(turn)) turn = 90;

    var n = _draw.pts.length;
    if (!n) { toast('\u26a0\ufe0f ' + tt('סמן קודם נקודת התחלה', 'เลือกจุดเริ่มก่อน', 'حدد نقطة البداية')); return; }
    var br;
    if (n === 1) br = turn;                                   // first leg: absolute bearing
    else br = (bearing(_draw.pts[n-2], _draw.pts[n-1]) + turn + 360) % 360;

    var next = destination(_draw.pts[n-1], br, dist);
    _draw.pts.push(next);
    _draw.markers.push(L.circleMarker(next, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(map()));
    refreshMeasure(null);
    if (lenEl) lenEl.focus();
  }

  // An exact rectangle from the first point: the common case, and doing it
  // by four typed segments invites an off-by-one on the last corner.
  function exactRect() {
    if (!_draw || !_draw.pts.length) {
      toast('\u26a0\ufe0f ' + tt('סמן קודם נקודת פינה', 'เลือกมุมแรกก่อน', 'حدد الزاوية الأولى'));
      return;
    }
    var a = Number((document.getElementById('bpRectA') || {}).value) || 0;
    var b = Number((document.getElementById('bpRectB') || {}).value) || 0;
    var rot = Number((document.getElementById('bpRectR') || {}).value) || 0;
    if (a <= 0 || b <= 0) { toast('\u26a0\ufe0f ' + tt('הזן a ו-b', 'ใส่ a และ b', 'أدخل a و b')); return; }
    var m = map(), p0 = _draw.pts[0];
    _draw.markers.forEach(function (mk) { m.removeLayer(mk); });
    _draw.markers = [];
    var p1 = destination(p0, rot, a);
    var p2 = destination(p1, (rot + 90) % 360, b);
    var p3 = destination(p0, (rot + 90) % 360, b);
    _draw.pts = [p0, p1, p2, p3];
    _draw.pts.forEach(function (pt) {
      _draw.markers.push(L.circleMarker(pt, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(m));
    });
    refreshMeasure(null);
  }

  function onDrawClick(e) {
    if (!_draw) return;
    if (nearFirst(e.latlng)) { finishFootprint(); return; }
    var m = map();
    _draw.pts.push(e.latlng);
    _draw.markers.push(L.circleMarker(e.latlng, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(m));
    refreshMeasure(null);
  }

  function bannerReadout() {
    var el = document.getElementById('bpReadout');
    if (!el || !_draw) return;
    var n = _draw.pts.length, ar = _draw.area || 0, pe = _draw.per || 0;
    el.innerHTML =
      '<span>' + (_draw.snap
        ? '\ud83d\udfe2 ' + tt('לחץ לסגירת המצולע', 'แตะเพื่อปิดรูป', 'انقر لإغلاق الشكل')
        : '\u2b20 ' + tt('לחץ על המפה', 'แตะแผนที่', 'انقر على الخريطة')) + ' (' + n + ')</span>' +
      (ar > 0
        ? '<span style="margin-inline-start:8px;background:rgba(255,209,102,.16);' +
          'border:1px solid rgba(255,209,102,.4);padding:3px 9px;border-radius:9px;color:#ffd166;">' +
          '\u25b1 ' + n1(ar) + ' \u05de"\u05e8' +
          (ar >= 1000 ? ' (' + (ar/1000).toFixed(2) + ' \u05d3\u05d5\u05e0\u05dd)' : '') +
          ' \u00b7 \u21ba ' + n1(pe) + ' m</span>'
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
          '<span style="font-size:.74rem;opacity:.85;">' + tt('אורך', 'ยาว', 'طول') + '</span>' +
          '<input id="bpSegLen" type="number" step="0.1" placeholder="20" style="width:62px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);' +
            'color:#fff;font-family:inherit;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + tt('פנייה°', 'มุม°', 'زاوية°') + '</span>' +
          '<input id="bpSegAng" type="number" step="1" value="90" style="width:56px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);' +
            'color:#fff;font-family:inherit;">' +
          '<button onclick="BuildPlan.addSegment()" style="padding:5px 10px;border-radius:8px;border:none;' +
            'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">+</button>' +
        '</span>' +
        '<span style="display:inline-flex;gap:4px;align-items:center;background:rgba(255,255,255,.08);' +
          'padding:4px 8px;border-radius:9px;">' +
          '<span style="font-size:.74rem;opacity:.85;">' + tt('מלבן', 'สี่เหลี่ยม', 'مستطيل') + '</span>' +
          '<input id="bpRectA" type="number" step="0.1" placeholder="a" style="width:52px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;">' +
          '<span style="opacity:.7;">\u00d7</span>' +
          '<input id="bpRectB" type="number" step="0.1" placeholder="b" style="width:52px;padding:4px;' +
            'border-radius:6px;border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;">' +
          '<input id="bpRectR" type="number" step="1" value="0" title="' +
            tt('סיבוב', 'หมุน', 'دوران') + '" style="width:48px;padding:4px;border-radius:6px;' +
            'border:1px solid rgba(255,255,255,.25);background:rgba(0,0,0,.35);color:#fff;">' +
          '<button onclick="BuildPlan.exactRect()" style="padding:5px 10px;border-radius:8px;border:none;' +
            'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">\u25ad</button>' +
        '</span>' +
        '<button onclick="BuildPlan.undoPoint()" style="padding:7px 12px;border-radius:9px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-family:inherit;font-weight:700;">\u21a9</button>' +
        '<button onclick="BuildPlan.finishFootprint()" style="padding:7px 14px;border-radius:9px;border:none;' +
          'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">\u2713 ' +
          tt('סיום', 'เสร็จ', 'إنهاء') + '</button>' +
        '<button onclick="BuildPlan.cancelFootprint()" style="padding:7px 12px;border-radius:9px;border:none;' +
          'background:rgba(255,71,87,.25);color:#fff;font-family:inherit;font-weight:700;">\u2715</button>' +
      '</div>';
    bannerReadout();
  }

  function undoPoint() {
    if (!_draw || !_draw.pts.length) return;
    map().removeLayer(_draw.markers.pop());
    _draw.pts.pop();
    refreshMeasure(null);
  }

  function clearDraw() {
    var m = map();
    if (_draw && m) {
      _draw.markers.forEach(function (mk) { m.removeLayer(mk); });
      (_draw.labels || []).forEach(function (l) { m.removeLayer(l); });
      if (_draw.line) m.removeLayer(_draw.line);
      m.off('click', onDrawClick);
      m.off('mousemove', onDrawMove);
    }
    _draw = null;
    banner(false);
    if (window.MapAccess) MapAccess.setExternalDraw(false);
  }

  function cancelFootprint() {
    clearDraw();
    loadAll().then(function () { render(); });
  }

  function finishFootprint() {
    if (!_draw || _draw.pts.length < 3) {
      toast('\u26a0\ufe0f ' + tt('צריך לפחות 3 נקודות', 'ต้องมีอย่างน้อย 3 จุด', 'ثلاث نقاط على الأقل'));
      return;
    }
    var id = _draw.id;
    var pts = _draw.pts.map(function (ll) { return { lat: ll.lat, lng: ll.lng }; });
    var area = (window.MapAccess && MapAccess.areaFromLatLngs)
      ? MapAccess.areaFromLatLngs(_draw.pts) : 0;
    clearDraw();
    var p = projById(id);
    if (p) {
      p.footprint = pts;
      p.footprintArea = area;
      saveP();
      toast('\u2705 ' + n1(area) + ' \u05de"\u05e8');
      open(id);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI
  // ══════════════════════════════════════════════════════════════════
  function isOpen() { return !!document.getElementById('bpRoot'); }
  function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }
  // Same cure as agriplan: _dim() repaints on every slider tick, and a
  // wholesale innerHTML swap resets scrollTop, so dragging a slider halfway
  // down the sheet would fling the view back to the top mid-drag.
  function paint(h) {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    // Three things have to survive a repaint or the sheet feels like it
    // resets under you: the backdrop scroll, the controls-column scroll,
    // and which accordions were open.
    var back = document.querySelector('.bp-back');
    var pane = document.querySelector('.bp-pane');
    var backTop = back ? back.scrollTop : 0;
    var paneTop = pane ? pane.scrollTop : 0;
    var openAcc = [];
    document.querySelectorAll('.bp-acc').forEach(function (d, i) {
      if (d.open) openAcc.push(i);
    });
    var act = document.activeElement;
    var actId = (act && act.id) ? act.id : null;
    var caret = (act && act.selectionStart != null) ? act.selectionStart : null;

    m.innerHTML = h;

    var nBack = document.querySelector('.bp-back');
    var nPane = document.querySelector('.bp-pane');
    if (nBack && backTop) nBack.scrollTop = backTop;
    if (nPane && paneTop) nPane.scrollTop = paneTop;
    if (openAcc.length) {
      var accs = document.querySelectorAll('.bp-acc');
      accs.forEach(function (d, i) { d.open = openAcc.indexOf(i) >= 0; });
    }
    if (actId) {
      var back2 = document.getElementById(actId);
      if (back2 && back2.focus) {
        back2.focus();
        if (caret != null && back2.setSelectionRange) {
          try { back2.setSelectionRange(caret, caret); } catch (e) {}
        }
      }
    }
  }
  function repaint() {
    if (_open && projById(_open)) open(_open); else render();
  }

  function ensureCss() {
    if (document.getElementById('bpCss')) return;
    var st = document.createElement('style');
    st.id = 'bpCss';
    st.textContent =
      '.bp-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;overflow:auto;padding:14px;}' +
      '.bp-sheet{max-width:1240px;margin:0 auto;background:var(--surface,#fff);color:var(--text,#222);' +
        'border-radius:16px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);}' +
      '.bp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;' +
        'margin-bottom:12px;padding-bottom:10px;border-bottom:2px solid var(--border,#e0e0e0);flex-wrap:wrap;}' +
      '.bp-head h3{margin:0;font-weight:800;font-size:1.05rem;}' +
      '.bp-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.bp-btn{padding:9px 13px;border:none;border-radius:10px;background:var(--primary,#2d6a4f);' +
        'color:#fff;font-family:inherit;font-weight:700;font-size:.84rem;cursor:pointer;}' +
      '.bp-btn.ghost{background:var(--surface-glass,#eef1ee);color:var(--text,#333);}' +
      '.bp-btn.warn{background:#c62828;}' +
      '.bp-btn.on{outline:2px solid var(--accent,#ff9f43);}' +
      '.bp-card{background:var(--surface-glass,#f5f7f5);border-radius:12px;padding:12px;margin-bottom:10px;}' +
      '.bp-draw{background:rgba(0,0,0,.18);border-radius:12px;padding:10px;}' +
      '.bp-in{padding:7px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
        'font-size:.82rem;background:var(--surface,#fff);color:var(--text,#222);width:100%;}' +
      '.bp-lbl{font-size:.7rem;color:var(--text-muted,#888);font-weight:700;margin-bottom:2px;}' +
      '.bp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;}' +
      '.bp-rng{width:100%;accent-color:var(--primary,#2d6a4f);}' +
      '.bp-tot{display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:.84rem;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.bp-empty{text-align:center;color:var(--text-muted,#999);padding:18px;font-size:.86rem;}' +
      // Two columns on a wide screen: the model stays put on the left while
      // the controls scroll on the right. On a phone it collapses to one
      // column with the viewer stuck to the top — either way the drawing is
      // always on screen, because it is the feedback for every control.
      '.bp-split{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,1fr);gap:12px;align-items:start;}' +
      '.bp-stick{position:sticky;top:8px;z-index:3;}' +
      '.bp-pane{max-height:calc(100vh - 168px);overflow-y:auto;overscroll-behavior:contain;' +
        '-webkit-overflow-scrolling:touch;padding-inline-end:6px;padding-bottom:28px;}' +
      '.bp-pane::-webkit-scrollbar{width:10px;}' +
      '.bp-pane::-webkit-scrollbar-thumb{background:var(--border,#bbb);border-radius:6px;}' +
      '.bp-acc{background:var(--surface-glass,#f5f7f5);border-radius:12px;margin-bottom:8px;overflow:hidden;}' +
      '.bp-acc>summary{cursor:pointer;padding:10px 12px;font-weight:800;font-size:.85rem;list-style:none;' +
        'display:flex;justify-content:space-between;align-items:center;}' +
      '.bp-acc>summary::-webkit-details-marker{display:none;}' +
      '.bp-acc>summary::after{content:"\\25be";opacity:.6;}' +
      '.bp-acc[open]>summary::after{content:"\\25b4";}' +
      '.bp-acc>div{padding:0 12px 12px;}' +
      '.bp-layer{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:8px;' +
        'font-size:.8rem;cursor:pointer;background:var(--surface,#fff);margin-bottom:4px;}' +
      '.bp-layer.off{opacity:.4;}' +
      '.bp-sw{width:12px;height:12px;border-radius:3px;flex:none;}' +
      '.bp-read{display:flex;justify-content:space-between;font-size:.78rem;padding:3px 0;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.bp-read b{color:var(--accent,#ff9f43);}' +
      '@media(max-width:900px){.bp-split{grid-template-columns:1fr;}' +
        '.bp-pane{max-height:none;overflow:visible;}}' +
      '@media(max-width:640px){.bp-grid{grid-template-columns:1fr 1fr;}}';
    document.head.appendChild(st);
  }

  function shell(title, bar, body) {
    ensureCss();
    return '<div class="bp-back" id="bpRoot"><div class="bp-sheet">' +
      '<div class="bp-head"><div><h3>' + title + '</h3></div>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.close()">\u2715 ' +
        tt('סגור', 'ปิด', 'إغلاق') + '</button></div>' +
      '<div class="bp-bar">' + bar + '</div>' + body + '</div></div>';
  }

  function openModule() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    loadAll().then(function () { listen(); drawFootprints(); _open = null; render(); });
  }

  function render() {
    _open = null;
    _v3d = null;
    var bar =
      '<button class="bp-btn" onclick="BuildPlan.newProject(\'shed\')">\ud83c\udfd7 ' +
        tt('סככה חדשה', 'โรงเรือนใหม่', 'سقيفة جديدة') + '</button>' +
      '<button class="bp-btn" onclick="BuildPlan.newProject(\'slab\')">\ud83e\uddf1 ' +
        tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.openCatalog()">\ud83d\udcd0 ' +
        tt('קטלוג פרופילים', 'แคตตาล็อก', 'كتالوج') + '</button>' +
      '<button class="bp-btn ghost" onclick="Orders.open()">\ud83d\udce6 ' +
        tt('הזמנות', 'ใบสั่งซื้อ', 'الطلبات') + '</button>' +
      (typeof Maintenance !== 'undefined'
        ? '<button class="bp-btn ghost" onclick="BuildPlan.backToMaint()">\ud83d\udd27 ' +
          tt('חזרה לתחזוקה', 'กลับซ่อมบำรุง', 'رجوع للصيانة') + '</button>' : '');

    var body = '';
    if (!(P.projects || []).length) {
      body = '<div class="bp-empty">' + tt(
        'אין פרויקטים. פרויקט מוגדר במידות, מצויר אוטומטית, ומחשב כתב כמויות והזמנה.',
        'ยังไม่มีโครงการ', 'لا توجد مشاريع') + '</div>';
    }
    (P.projects || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .forEach(function (p) {
        var rows = takeoff(p), t = takeoffTotals(rows);
        var g = p.type === 'slab' ? null : geom(p.dims);
        var icon = p.type === 'slab' ? '\ud83e\uddf1' : (p.type === 'house' ? '\ud83c\udfe0' : '\ud83c\udfd7');
        body += '<div class="bp-card" style="cursor:pointer;" onclick="BuildPlan.card(' + p.id + ')">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<strong>' + icon + ' ' + esc(p.name || tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) + '</strong>' +
            '<span style="font-size:.76rem;color:var(--text-muted,#888);">' + typeLabel(p.type) + '</span>' +
          '</div>' +
          '<div style="font-size:.78rem;color:var(--text-muted,#888);margin-top:4px;">' +
            (g ? n1(p.dims.span) + '\u00d7' + n1(p.dims.length) + ' m \u00b7 ' + g.frames + ' ' +
                 tt('מסגרות', 'เฟรม', 'إطارات') + ' \u00b7 ' + n1(t.kg / 1000) + ' ' +
                 tt('טון פלדה', 'ตันเหล็ก', 'طن حديد')
               : n1(slabArea(p)) + ' \u05de"\u05e8 \u00b7 ' + n2(slabArea(p) * p.dims.slabTh) + ' \u05de"\u05e7') +
            (t.cost ? ' \u00b7 ' + money(t.cost) : '') +
            (p.footprint.length ? ' \u00b7 \ud83d\uddfa ' + n1(p.footprintArea) + ' \u05de"\u05e8' : '') +
            (p.maintId ? ' \u00b7 \ud83d\udd27 ' + esc(p.maintName || tt('מקושר','เชื่อม','مرتبط')) : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;margin-top:8px;" onclick="event.stopPropagation()">' +
            (p.footprint.length
              ? '<button class="bp-btn ghost" style="padding:5px 10px;font-size:.74rem;" ' +
                  'onclick="BuildPlan.zoomTo(' + p.id + ')">\ud83d\udccd ' +
                  tt('במפה', 'แผนที่', 'خريطة') + '</button>'
              : '<button class="bp-btn ghost" style="padding:5px 10px;font-size:.74rem;" ' +
                  'onclick="BuildPlan.startRect(' + p.id + ')">\u25ad ' +
                  tt('מקם', 'วาง', 'حدد') + '</button>') +
            '<button class="bp-btn ghost" style="padding:5px 10px;font-size:.74rem;" ' +
              'onclick="BuildPlan.openProject(' + p.id + ')">\u270f\ufe0f ' +
              tt('ערוך', 'แก้ไข', 'تحرير') + '</button>' +
            '<button class="bp-btn warn" style="padding:5px 10px;font-size:.74rem;" ' +
              'onclick="BuildPlan.delProject(' + p.id + ')">\ud83d\uddd1</button>' +
          '</div></div>';
      });

    paint(shell('\ud83c\udfd7 ' + tt('פרויקטי בנייה', 'โครงการก่อสร้าง', 'مشاريع البناء'), bar, body));
  }

  // A read-first summary, the same shape as a plot card: what it is, where
  // it is, what it will consume and what it will cost — before dropping the
  // user into a design surface full of sliders.
  function card(id) {
    var p = projById(id);
    if (!p) { render(); return; }
    var rows = takeoff(p), tot = takeoffTotals(rows), con = concrete(p);
    var g = p.type === 'slab' ? null : geom(p.dims);
    var has = p.footprint && p.footprint.length >= 3;

    function line(k, v) {
      return '<div class="bp-tot"><span>' + k + '</span><strong>' + v + '</strong></div>';
    }

    var top = rows.slice().sort(function (a, b) {
      var pa = profByName(a.name), pb = profByName(b.name);
      return ((pb && pb.price ? b.qty*pb.price : 0)) - ((pa && pa.price ? a.qty*pa.price : 0));
    }).slice(0, 6).map(function (r) {
      return '<div class="bp-tot" style="font-size:.8rem;"><span>' + esc(dsp(r.name)) +
        '</span><span>' + n1(r.qty) + ' ' + esc(dsp(r.unit)) + '</span></div>';
    }).join('');

    var body =
      '<div class="bp-card">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
          '<div><div style="font-weight:800;font-size:1.05rem;">' +
            esc(p.name || typeLabel(p.type)) + '</div>' +
            '<div style="font-size:.8rem;color:var(--text-muted,#888);">' + typeLabel(p.type) +
            (p.client ? ' \u00b7 ' + esc(p.client) : '') + '</div></div>' +
          '<div style="font-size:.76rem;color:var(--text-muted,#888);text-align:end;">' +
            new Date(p.createdAt).toLocaleDateString('he-IL') +
            (p.createdBy ? '<br>' + esc(p.createdBy) : '') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="bp-card">' +
        (g ? line(tt('מידות', 'ขนาด', 'الأبعاد'),
              n1(p.dims.span) + ' \u00d7 ' + n1(p.dims.length) + ' m') +
             line(tt('גובה עמוד / רכס', 'สูงเสา/สัน', 'ارتفاع العمود/القمة'),
              n1(p.dims.eaves) + ' / ' + n1(g.ridgeH) + ' m') +
             line(tt('מסגרות', 'เฟรม', 'إطارات'),
              g.frames + ' @ ' + n1(g.actualBay) + ' m') +
             line(tt('שטח מקורה', 'พื้นที่คลุม', 'المساحة المغطاة'), n1(g.footprint) + ' \u05de"\u05e8') +
             line(tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد'),
              n1(tot.kg) + ' kg \u00b7 ' + n2(tot.kg/1000) + ' ' + tt('טון', 'ตัน', 'طن'))
           : line(tt('שטח', 'พื้นที่', 'المساحة'), n1(slabArea(p)) + ' \u05de"\u05e8') +
             line(tt('עובי', 'ความหนา', 'السماكة'), p.dims.slabTh + ' m')) +
        line(tt('בטון', 'คอนกรีต', 'خرسانة'), n2(con.total) + ' \u05de"\u05e7') +
        line(tt('עלות חומרים', 'ต้นทุนวัสดุ', 'تكلفة المواد'), money(tot.cost)) +
        (tot.unpriced ? '<div style="font-size:.74rem;color:#e65100;">\u26a0\ufe0f ' + tot.unpriced +
          ' ' + tt('פריטים ללא מחיר', 'ไม่มีราคา', 'بدون سعر') + '</div>' : '') +
      '</div>' +

      '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">\ud83d\uddfa ' +
        tt('מיקום', 'ตำแหน่ง', 'الموقع') + '</div>' +
        (has
          ? line(tt('שטח מסומן', 'พื้นที่ที่วาด', 'المساحة المرسومة'),
              n1(p.footprintArea) + ' \u05de"\u05e8 (' + n2(p.footprintArea/1000) + ' ' +
              tt('דונם', 'ดูนัม', 'دونم') + ')') +
            '<button class="bp-btn" style="margin-top:6px;" onclick="BuildPlan.zoomTo(' + p.id + ')">' +
              '\ud83d\udccd ' + tt('הצג את אתר הבנייה במפה', 'ดูบนแผนที่', 'عرض الموقع على الخريطة') +
            '</button>'
          : '<div style="font-size:.82rem;color:var(--text-muted,#999);">' +
              tt('הפרויקט לא ממוקם על המפה.', 'ยังไม่ได้กำหนดตำแหน่ง', 'لم يُحدَّد الموقع') + '</div>' +
            '<button class="bp-btn" style="margin-top:6px;" onclick="BuildPlan.startRect(' + p.id + ')">' +
              '\u25ad ' + tt('סמן עכשיו', 'วาดตอนนี้', 'ارسم الآن') + '</button>') +
      '</div>' +

      (p.maintId ? '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">\ud83d\udd27 ' +
        tt('פרויקט תחזוקה', 'โครงการซ่อมบำรุง', 'مشروع الصيانة') + '</div>' +
        '<div class="bp-tot" style="border:none;"><span>' + esc(p.maintName || '\u2014') + '</span>' +
        '<button class="bp-btn ghost" style="padding:4px 10px;font-size:.74rem;" ' +
          'onclick="BuildPlan.openMaint(' + p.maintId + ')">' +
          tt('פתח', 'เปิด', 'فتح') + '</button></div></div>' : '') +

      (top ? '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">' +
        tt('פריטים עיקריים', 'วัสดุหลัก', 'المواد الرئيسية') + '</div>' + top + '</div>' : '') +

      (p.notes ? '<div class="bp-card" style="font-size:.84rem;">' + esc(p.notes) + '</div>' : '');

    var bar =
      '<button class="bp-btn" onclick="BuildPlan.openProject(' + p.id + ')">\u270f\ufe0f ' +
        tt('ערוך ותכנן', 'แก้ไข', 'تحرير') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printProject(' + p.id + ')">\ud83d\udda8 ' +
        tt('הדפסה מלאה', 'พิมพ์เต็ม', 'طباعة كاملة') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printQuantities(' + p.id + ')">\ud83e\uddfe ' +
        tt('כתב כמויות בלבד', 'เฉพาะรายการวัสดุ', 'الكميات فقط') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.toOrder(' + p.id + ')">\ud83d\udce6 ' +
        tt('צור הזמנה', 'ใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      '<button class="bp-btn warn" onclick="BuildPlan.delProject(' + p.id + ')">\ud83d\uddd1 ' +
        tt('מחק', 'ลบ', 'حذف') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') +
      esc(p.name || typeLabel(p.type)), bar, body));
  }

  function newProject(type) {
    var u = window.currentUser || {};
    var p = normProject({
      id: uid(), type: type || 'shed', createdAt: Date.now(), createdBy: u.username || '',
      name: typeLabel(type || 'shed')
    });
    P.projects.push(p);
    saveP();
    open(p.id);
  }

  function delProject(id) {
    var before = projById(id);
    if (!before) { render(); return; }
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var ok = (typeof window.confirm === 'function')
      ? window.confirm(tt('למחוק את הפרויקט?', 'ลบโครงการ?', 'حذف المشروع؟')) : true;
    if (!ok) return;
    // Drop the view state too, or a later project could inherit this one's
    // hidden layers.
    _v3dState = null; _v3dFor = null;
    P.projects = (P.projects || []).filter(function (p) { return p.id !== id; });
    saveP();
    if (window.Audit && Audit.log) Audit.log('delete', 'buildplan', String(id), { before: before });
    render();
  }

  function setTab(t) {
    if (_v3d && _open && _v3dFor === _open) { try { _v3dState = _v3d.getState(); } catch (e) {} }
    _tab = t;
    if (_open) open(_open);
  }

  function open(id) {
    var p = projById(id);
    if (!p) { render(); return; }
    // Grab the view before paint() destroys the canvas. Switching to a
    // different project starts fresh — carrying one building's camera onto
    // another that is a tenth the size would frame empty sky.
    if (_v3d && _v3dFor === id) { try { _v3dState = _v3d.getState(); } catch (e) {} }
    else if (_v3dFor !== id) { _v3dState = null; }
    _open = id;
    var d = p.dims;
    var rows = takeoff(p), tot = takeoffTotals(rows);

    var tabs = ['design', 'gates', 'living', 'sketch', 'materials', 'site'].map(function (t) {
      var lbl = t === 'design' ? '\ud83c\udfd7 ' + tt('מודל', 'โมเดล', 'نموذج')
              : t === 'gates' ? '\ud83d\udea7 ' + tt('שערים', 'ประตู', 'بوابات') +
                  ((p.gates || []).length ? ' (' + p.gates.length + ')' : '')
              : t === 'living' ? '\ud83c\udfe0 ' + tt('מגורים', 'ที่พัก', 'سكن') +
                  ((p.living && p.living.people) ? ' (' + p.living.people + ')' : '')
              : t === 'sketch' ? '\u270f\ufe0f ' + tt('שרטוט חופשי', 'วาดอิสระ', 'رسم حر')
              : t === 'materials' ? '\ud83e\uddfe ' + tt('כתב כמויות', 'รายการวัสดุ', 'الكميات')
              : '\ud83d\uddfa ' + tt('מיקום במפה', 'ตำแหน่ง', 'الموقع');
      return '<button class="bp-btn ' + (_tab === t ? 'on' : 'ghost') +
        '" onclick="BuildPlan.setTab(\'' + t + '\')">' + lbl + '</button>';
    }).join('');

    // What is in this project. Shown before anything else, because it
    // decides which of the tabs below actually mean anything.
    var comps = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">' +
        tt('מה כולל הפרויקט', 'โครงการนี้ประกอบด้วย', 'مكوّنات المشروع') + '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.84rem;">' +
        '<label style="display:inline-flex;gap:6px;align-items:center;">' +
          '<input type="checkbox"' + (p.hasStruct !== false ? ' checked' : '') +
          ' onchange="BuildPlan._comp(' + id + ',\'hasStruct\',this.checked)"> \ud83c\udfd7 ' +
          tt('סככה / שלד', 'โครงสร้าง', 'هيكل') + '</label>' +
        '<label style="display:inline-flex;gap:6px;align-items:center;">' +
          '<input type="checkbox"' + (p.hasSlab !== false ? ' checked' : '') +
          ' onchange="BuildPlan._comp(' + id + ',\'hasSlab\',this.checked)"> \ud83e\uddf1 ' +
          tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</label>' +
        '<span style="display:inline-flex;gap:6px;align-items:center;opacity:.75;">\ud83d\udea7 ' +
          tt('שערים', 'ประตู', 'بوابات') + ': ' + ((p.gates || []).length) + '</span>' +
        '<span style="display:inline-flex;gap:6px;align-items:center;opacity:.75;">\ud83c\udfe0 ' +
          tt('מגורים', 'ที่พัก', 'سكن') + ': ' +
          ((p.living && p.living.people) ? p.living.people + ' ' + tt('אנשים','คน','أشخاص')
                                          : tt('ללא','ไม่มี','بدون')) + '</span>' +
      '</div>' +
      (p.hasStruct === false
        ? '<div style="font-size:.75rem;color:var(--accent,#ff9f43);margin-top:8px;">\u26a0\ufe0f ' +
          tt('ללא שלד — כתב הכמויות לא כולל פלדה, חיפוי או יסודות.',
             'ไม่มีโครงสร้าง', 'بدون هيكل') + '</div>'
        : '') +
    '</div>';

    var body = comps + '<div class="bp-card">' +
      '<div class="bp-grid">' +
        '<div><div class="bp-lbl">' + tt('שם', 'ชื่อ', 'الاسم') + '</div>' +
          '<input class="bp-in" value="' + esc(p.name) + '" ' +
          'oninput="BuildPlan._set(' + id + ',\'name\',this.value)"></div>' +
        '<div><div class="bp-lbl">' + tt('לקוח / מטע', 'ลูกค้า', 'العميل') + '</div>' +
          '<input class="bp-in" value="' + esc(p.client) + '" ' +
          'oninput="BuildPlan._set(' + id + ',\'client\',this.value)"></div>' +
      '</div></div>' + '<div class="bp-bar">' + tabs + '</div>';

    if (_tab === 'design')      body += designTab(p);
    else if (_tab === 'gates')  body += gatesTab(p);
    else if (_tab === 'living') body += livingTab(p);
    else if (_tab === 'sketch') body += sketchTab(p);
    else if (_tab === 'materials') body += matTab(p, rows, tot);
    else                        body += siteTab(p);

    var bar =
      '<button class="bp-btn" onclick="BuildPlan.saveNow()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printProject(' + id + ')">\ud83d\udda8 ' +
        tt('הדפסה מלאה', 'พิมพ์เต็ม', 'طباعة كاملة') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printQuantities(' + id + ')">\ud83e\uddfe ' +
        tt('כתב כמויות בלבד', 'เฉพาะรายการวัสดุ', 'الكميات فقط') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.toOrder(' + id + ')">\ud83d\udce6 ' +
        tt('צור הזמנה', 'สร้างใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      '<button class="bp-btn warn" onclick="BuildPlan.delProject(' + id + ')">\ud83d\uddd1</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') +
      esc(p.name || typeLabel(p.type)), bar, body));
    if (_tab === 'site') linkPanel(p);
    if (_tab === 'sketch') mountSketch(p);
    if (_tab === 'design') {
      if (p.type !== 'slab') mount3d(p);
      refreshReadouts(p);
    }
  }

  function applyModel(id, key) {
    var p = projById(id), src = MODELS[key];
    if (!p || !src) return;
    Object.keys(src).forEach(function (k) {
      if (k !== 'label') p.dims[k] = src[k];
    });
    p.dims._model = key;
    // A different model has a different set of members, so stale hidden
    // layers would silently blank parts of the new one.
    if (_v3dState) _v3dState.hidden = {};
    saveP();
    open(id);
  }

  function view3d(yaw, pitch) { if (_v3d) _v3d.setView(yaw, pitch); }
  function resetView() {
    if (!_v3d) return;
    _v3d.resetView();
    if (_v3dState) _v3dState.cam = null;
  }
  // Sun is a view setting, not a property of the building — it moves the
  // shadows so the client can see the shade the structure will actually
  // throw, which for a farm canopy is often the entire point of building it.
  var _sunSave = null;
  function sun(id, k, v) {
    var p = projById(id);
    if (!p) return;
    p.dims[k] = Number(v) || 0;
    if (_v3d) _v3d.setSun(p.dims.sunAz*Math.PI/180, p.dims.sunEl*Math.PI/180);
    // Persist on a trailing timer instead of per input event — dragging the
    // sun through 180 degrees should be one write, not seventy.
    if (_sunSave) clearTimeout(_sunSave);
    _sunSave = setTimeout(saveP, 600);
  }

  // A slider and a number field on the same value: drag to explore the
  // shape, type when the dimension is already decided.
  // Slider and number field bound to each other without a repaint: the
  // slider writes the number box directly and nudges the 3D model, so
  // dragging stays at frame rate instead of rebuilding the whole sheet.
  function ctl(id, key, label, val, min, max, step) {
    var nid = 'n_' + key, rid = 'r_' + key;
    return '<div><div class="bp-lbl">' + label +
        ' <b id="v_' + key + '" style="color:var(--accent,#ff9f43);">' + val + '</b></div>' +
      '<input class="bp-rng" id="' + rid + '" type="range" min="' + min + '" max="' + max +
        '" step="' + step + '" value="' + val + '" ' +
        'oninput="BuildPlan._live(' + id + ',\'' + key + '\',this.value)" ' +
        'onchange="BuildPlan._commit(' + id + ',\'' + key + '\',this.value)">' +
      '<input class="bp-in" id="' + nid + '" type="number" step="' + step + '" value="' + val + '" ' +
        'style="margin-top:3px;" ' +
        'oninput="BuildPlan._live(' + id + ',\'' + key + '\',this.value)" ' +
        'onchange="BuildPlan._commit(' + id + ',\'' + key + '\',this.value)"></div>';
  }

  // One list of real products plus "ללא". What is shown is what is billed.
  function cladSelect(id, key, cur) {
    var o = '<option value="none"' + (cur === 'none' ? ' selected' : '') + '>' +
      tt('ללא', 'ไม่มี', 'بدون') + '</option>';
    var seen = false;
    (C.profiles || []).forEach(function (x) {
      if (x.group !== 'חיפוי') return;
      if (x.name === cur) seen = true;
      o += '<option value="' + esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        esc(dsp(x.name)) + (x.price ? ' \u00b7 ' + money(x.price) : '') + '</option>';
    });
    // A product that has been removed from the catalogue still has to show,
    // or the box would silently claim the project uses something else.
    if (cur && cur !== 'none' && !seen) {
      o += '<option value="' + esc(cur) + '" selected>' + esc(dsp(cur)) + ' \u26a0\ufe0f</option>';
    }
    return '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)">' +
      o + '</select>';
  }

  function profSel(id, key, group, cur) {
    var o = '';
    (C.profiles || []).filter(function (x) { return x.group === group; }).forEach(function (x) {
      o += '<option value="' + esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        esc(dsp(x.name)) + (x.kgPerM ? ' \u00b7 ' + x.kgPerM + ' kg/m' : '') +
        (x.price ? ' \u00b7 ' + money(x.price) : '') + '</option>';
    });
    return '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)">' +
      o + '</select>';
  }

  var _v3d = null;
  var _v3dState = null;      // camera / layers / sun, carried across remounts
  var _v3dFor = null;        // which project that state belongs to
  var _groundCache = {};

  // ── satellite ground ────────────────────────────────────────────────
  // Composites Esri World Imagery tiles covering the project footprint into
  // one canvas, which shed3d.js then maps onto the ground plane. Tiles are
  // requested with CORS so the canvas stays untainted and snapshot() keeps
  // working; if imagery fails the scene simply keeps its flat ground rather
  // than failing to render.
  var TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  function lon2x(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2y(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  function groundImage(p, halfX, halfY) {
    var key = p.id + ':' + Math.round(halfX) + 'x' + Math.round(halfY);
    if (_groundCache[key]) return Promise.resolve(_groundCache[key]);
    if (!p.footprint || p.footprint.length < 3) return Promise.resolve(null);

    var lat = 0, lng = 0;
    p.footprint.forEach(function (pt) { lat += pt.lat; lng += pt.lng; });
    lat /= p.footprint.length; lng /= p.footprint.length;

    // Pick the zoom whose ground resolution puts the required span in a
    // sensible number of tiles — too coarse is blurry, too fine is 60 fetches.
    var mpp = 156543.03392 * Math.cos(lat * Math.PI/180);
    var need = Math.max(halfX, halfY) * 2;
    // 18, matching the map's maxNativeZoom. Requesting z19 here hit the same
    // patchy coverage that blanked the map, and a missing tile left a hole
    // in the satellite ground plane.
    var z = 18;
    while (z > 14 && (mpp / Math.pow(2, z)) * 256 * 3 < need) z--;
    var res = mpp / Math.pow(2, z);

    var cx = lon2x(lng, z), cy = lat2y(lat, z);
    var tilesX = Math.ceil(halfX * 2 / (res * 256)) + 1;
    var tilesY = Math.ceil(halfY * 2 / (res * 256)) + 1;
    tilesX = Math.min(6, Math.max(2, tilesX));
    tilesY = Math.min(6, Math.max(2, tilesY));

    var x0 = Math.floor(cx - tilesX/2), y0 = Math.floor(cy - tilesY/2);
    var cv = document.createElement('canvas');
    cv.width = tilesX * 256; cv.height = tilesY * 256;
    var ctx = cv.getContext('2d');

    var jobs = [];
    for (var i = 0; i < tilesX; i++) {
      for (var j = 0; j < tilesY; j++) {
        (function (i, j) {
          jobs.push(new Promise(function (res2) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { ctx.drawImage(img, i*256, j*256); res2(true); };
            img.onerror = function () { res2(false); };
            img.src = TILE_URL.replace('{z}', z).replace('{x}', x0+i).replace('{y}', y0+j);
          }));
        })(i, j);
      }
    }

    return Promise.all(jobs).then(function (r) {
      // A composite that is mostly missing tiles is worse than none: the
      // ground plane would show holes where imagery should be.
      if (r.filter(Boolean).length < r.length * 0.75) return null;
      // Metre extents of the composited canvas, relative to the footprint
      // centroid — this is what pins the imagery to the model 1:1.
      var out = new Image();
      var extent = {
        x0: (x0 - cx) * 256 * res,
        x1: (x0 + tilesX - cx) * 256 * res,
        y0: -((y0 + tilesY - cy) * 256 * res),
        y1: -((y0 - cy) * 256 * res)
      };
      return new Promise(function (done) {
        out.onload = function () {
          _groundCache[key] = { img: out, extent: extent };
          done(_groundCache[key]);
        };
        out.onerror = function () { done(null); };
        out.src = cv.toDataURL('image/jpeg', 0.85);
      });
    }).catch(function () { return null; });
  }

  function model3d(p) {
    var d = p.dims;
    return {
      span: d.span, length: d.length, eaves: d.eaves, bay: d.bay, pitch: d.pitch,
      roofType: d.roofType, wallMode: d.wallMode,
      roofClad: d.roofClad, wallClad: d.wallClad,
      purlinSp: d.purlinSp, girtSp: d.girtSp, slabTh: d.slabTh,
      footings: d.footings, footW: d.footW, footD: d.footD,
      fence: d.fence, fenceH: d.fenceH, fenceOff: d.fenceOff,
      rafterType: d.rafterType, trussDepth: d.trussDepth,
      haunch: d.haunch, taper: d.taper, bracing: d.bracing,
      skylights: d.skylights, door: d.door, doorW: d.doorW, doorH: d.doorH,
      leanTo: d.leanTo, mezz: d.mezz, mezzH: d.mezzH,
      gutter: d.gutter, shadows: d.shadows, dims: d.dims, callouts: d.callouts,
      scaleRef: d.scaleRef, scaleH: d.scaleH,
      context: true
    };
  }

  // Mounted after paint(), because the canvas has no size until it is in the
  // document. Rebuilt rather than reused across repaints — the host node is
  // replaced by every innerHTML swap, so a retained instance would be
  // pointing at a detached canvas.
  function mount3d(p) {
    var host = document.getElementById('bp3d');
    if (!host || typeof Shed3D === 'undefined') return;
    _v3d = Shed3D.mount(host, model3d(p), {
      state: _v3dState,
      labels: calloutLabels(p),
      onSelect: function (g) {
        var el = document.getElementById('bpSel');
        if (el) el.textContent = g ? memberLabel(g) : '';
        // Tapping the member in the model is the same gesture as tapping it
        // in the legend — both should offer the swap.
        if (g) swapPanel(g); else closeSwap();
      }
    });
    _v3dFor = p.id;
    if (!_v3dState) _v3d.setSun(p.dims.sunAz*Math.PI/180, p.dims.sunEl*Math.PI/180);

    var lay = document.getElementById('bpLayers');
    if (lay) lay.innerHTML = layersPanel(p);
    legendPanel(p);

    if (p.dims.mapGround !== false && p.footprint && p.footprint.length >= 3) {
      var pad = Math.max(p.dims.span, p.dims.length) * 0.9;
      groundImage(p, p.dims.length/2 + pad, p.dims.span/2 + pad).then(function (g) {
        if (g && _v3d) _v3d.setGround(g.img, g.extent);
      });
    }
  }

  // Callout text comes from the takeoff, so a chip says the section AND how
  // much of it the job needs — the two questions anyone pointing at a member
  // in a drawing is actually asking.
  function calloutLabels(p) {
    var d = p.dims, g = geom(d), rows = takeoff(p), out = {};
    function qty(name) {
      var t = 0, u = '';
      rows.forEach(function (r) { if (r.name === name) { t += r.qty; u = r.unit; } });
      return t ? n1(t) + ' ' + u : '';
    }
    out.column = { title: memberLabel('column'), sub: d.colProfile + '  ' + qty(d.colProfile) };
    out.rafter = { title: memberLabel('rafter'),
      sub: (d.rafterType === 'truss' ? tt('סבכה', 'โครงถัก', 'جملون') + ' ' + n1(d.trussDepth) + 'm  ' : '') +
        d.rafterProfile + '  ' + qty(d.rafterProfile) };
    out.purlin = { title: memberLabel('purlin'), sub: d.purlinProfile + '  ' + qty(d.purlinProfile) };
    if (d.wallMode !== 'open') {
      out.girt = { title: memberLabel('girt'), sub: d.girtProfile + '  ' + qty(d.girtProfile) };
      out.wall = { title: memberLabel('wall'), sub: dsp(d.wallClad) + '  ' + qty(d.wallClad) };
    }
    if (d.roofClad !== 'none') {
      out.roof = { title: memberLabel('roof'), sub: dsp(d.roofClad) + '  ' + qty(d.roofClad) };
    }
    if (d.skylights > 0) out.skylight = { title: memberLabel('skylight'), sub: qty('לוח סקיילייט') };
    if (d.gutter) out.gutter = { title: memberLabel('gutter'), sub: qty('מרזב') };
    if (d.haunch) out.haunch = { title: memberLabel('haunch'), sub: '' };
    if (d.bracing) out.brace = { title: memberLabel('brace'), sub: '' };
    if (d.footings) {
      out.footing = { title: memberLabel('footing'),
        sub: g.frames*2 + ' \u00d7 ' + n1(d.footW) + '\u00d7' + n1(d.footW) + '\u00d7' + n1(d.footD) + 'm' };
    }
    out.slab = { title: memberLabel('slab'), sub: n2(concrete(p).total) + ' \u05de"\u05e7' };
    if (d.door) out.door = { title: memberLabel('door'), sub: n1(d.doorW) + '\u00d7' + n1(d.doorH) + 'm' };
    if (d.mezz > 0) out.mezz = { title: memberLabel('mezz'), sub: n1(d.mezz) + 'm' };
    if (d.fence) out.fence = { title: memberLabel('fence'), sub: n1(d.fenceH) + 'm' };
    return out;
  }

  var LAYER_ORDER = ['column','haunch','rafter','purlin','strut','brace','girt',
                     'roof','skylight','ridge','wall','door','gutter',
                     'slab','footing','mezz','fence'];

  // Turning the cladding off to look at the frame is the single most useful
  // thing you can do with a model like this, and it was impossible.
  function layersPanel(p) {
    if (!_v3d) return '';
    var present = _v3d.groups();
    var pal = Shed3D.PALETTE;
    var html = '';
    LAYER_ORDER.forEach(function (g) {
      if (!present[g]) return;
      var off = _v3d.isHidden(g);
      html += '<div class="bp-layer' + (off ? ' off' : '') + '" onclick="BuildPlan.toggleLayer(\'' + g + '\')">' +
        '<span class="bp-sw" style="background:' + (pal[g] || '#999') + ';"></span>' +
        '<span style="flex:1;">' + memberLabel(g).replace('\ud83d\udc46 ', '') + '</span>' +
        '<span style="opacity:.6;font-size:.72rem;">' + (off ? '\u25cb' : '\u25c9') + '</span></div>';
    });
    return html + '<div style="display:flex;gap:6px;margin-top:6px;">' +
      '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.74rem;" ' +
        'onclick="BuildPlan.layersAll(true)">' + tt('הצג הכל', 'แสดงทั้งหมด', 'إظهار الكل') + '</button>' +
      '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.74rem;" ' +
        'onclick="BuildPlan.layersFrame()">' + tt('שלד בלבד', 'เฉพาะโครง', 'الهيكل فقط') + '</button>' +
    '</div>';
  }

  // Named toggleLayer, not layer(): layer() is the Leaflet layer-group
  // accessor above, and a second declaration with the same name silently
  // replaced it for the whole module — which is why footprints stopped
  // appearing on the map.
  function toggleLayer(g) {
    if (!_v3d) return;
    _v3d.toggleLayer(g);
    var host = document.getElementById('bpLayers');
    if (host && _open) { host.innerHTML = layersPanel(projById(_open)); legendPanel(projById(_open)); }
  }
  function layersAll(show) {
    if (!_v3d) return;
    var next = {};
    if (!show) Object.keys(_v3d.groups()).forEach(function (g) { next[g] = true; });
    _v3d.setHidden(next);
    var host = document.getElementById('bpLayers');
    if (host && _open) host.innerHTML = layersPanel(projById(_open));
  }
  // Strip everything that hides the steel — the view a fabricator wants.
  function layersFrame() {
    if (!_v3d) return;
    _v3d.setHidden({ roof:1, wall:1, skylight:1, door:1, fence:1, slab:1, ridge:1, gutter:1 });
    var host = document.getElementById('bpLayers');
    if (host && _open) host.innerHTML = layersPanel(projById(_open));
  }

  // A legend under the model instead of chips on top of it. Every member
  // group with its colour and quantity, readable at a glance, and clicking
  // one selects it in the 3D view — which is when the single callout
  // appears. Annotation on demand rather than seven labels fighting the
  // drawing they annotate.
  function legendPanel(p) {
    var host = document.getElementById('bpLegend');
    if (!host || !_v3d) return;
    var labels = calloutLabels(p);
    var present = _v3d.groups();
    var pal = Shed3D.PALETTE;
    var html = '';
    LAYER_ORDER.forEach(function (g) {
      if (!present[g] || !labels[g] || _v3d.isHidden(g)) return;
      var l = labels[g];
      html += '<button onclick="BuildPlan.pickMember(\'' + g + '\')" ' +
        'style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:9px;' +
        'border:1px solid var(--border,#ccc);background:var(--surface,#fff);color:var(--text,#222);' +
        'font-family:inherit;font-size:.72rem;font-weight:700;cursor:pointer;">' +
        '<span style="width:9px;height:9px;border-radius:2px;background:' + (pal[g]||'#999') + ';"></span>' +
        esc(l.title.replace('\ud83d\udc46 ', '')) +
        (l.sub ? '<span style="opacity:.6;font-weight:600;"> ' + esc(l.sub) + '</span>' : '') +
      '</button>';
    });
    host.innerHTML = html;
  }

  function pickMember(g) {
    if (!_v3d) return;
    _v3d.select(g);
    var el = document.getElementById('bpSel');
    if (el) el.textContent = memberLabel(g);
    swapPanel(g);
  }

  // Tap a member, see what else would carry it. Every candidate shows its
  // utilisation, so the choice is between sections that work rather than a
  // dropdown of every section in the catalogue.
  var _swapRole = null;
  function swapPanel(role) {
    _swapRole = ROLE_KEY[role] ? role : null;
    var host = document.getElementById('bpSwap');
    if (!host) return;
    if (!ROLE_KEY[role] || !_open) { host.innerHTML = ''; return; }
    var p = projById(_open);
    if (!p) { host.innerHTML = ''; return; }
    var d = p.dims, cur = d[ROLE_KEY[role]];
    var list = candidates(role, d);
    if (!list.length) { host.innerHTML = ''; return; }

    var curR = checkMember(role, cur, d);
    var rows = list.map(function (c) {
      var pct = Math.round(c.util * 100);
      var isCur = c.name === cur;
      var col = c.ok ? (c.util > 0.85 ? '#e08e00' : 'var(--primary,#2d6a4f)') : '#c62828';
      return '<button onclick="BuildPlan.swapTo(\'' + role + '\',\'' + esc(c.name) + '\')" ' +
        'style="display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;' +
        'padding:7px 10px;margin-bottom:4px;border-radius:9px;font-family:inherit;font-size:.78rem;' +
        'cursor:pointer;text-align:start;' +
        'border:' + (isCur ? '2px solid var(--accent,#ff9f43)' : '1px solid var(--border,#ccc)') + ';' +
        'background:var(--surface,#fff);color:var(--text,#222);' + (c.ok ? '' : 'opacity:.62;') + '">' +
        '<span style="font-weight:700;">' + (c.ok ? '\u2713' : '\u2717') + ' ' + esc(c.name) +
          (isCur ? ' \u00b7 ' + tt('נוכחי', 'ปัจจุบัน', 'الحالي') : '') + '</span>' +
        '<span style="white-space:nowrap;color:' + col + ';font-weight:800;">' + pct + '%' +
          '<span style="color:var(--text-muted,#888);font-weight:600;"> \u00b7 ' +
          n1(c.kg) + ' kg/m</span></span></button>';
    }).join('');

    host.innerHTML =
      '<div class="bp-card" style="border:1.5px solid var(--accent,#ff9f43);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<div style="font-weight:800;">' + memberLabel(role).replace('\ud83d\udc46 ', '') + '</div>' +
          '<button class="bp-btn ghost" style="padding:3px 9px;font-size:.72rem;" ' +
            'onclick="BuildPlan.closeSwap()">\u2715</button></div>' +
        (curR.known
          ? '<div style="font-size:.74rem;color:var(--text-muted,#888);margin:4px 0 8px;">' +
            esc(cur) + ' \u00b7 ' + curR.why + ' \u00b7 ' +
            tt('מוט', 'ช่วง', 'مجاز') + ' ' + n1(curR.span) + ' m \u00b7 ' +
            tt('ניצול', 'การใช้งาน', 'الاستغلال') + ' ' + Math.round(curR.util * 100) + '%</div>'
          : '<div style="height:6px;"></div>') +
        rows +
        '<div style="font-size:.68rem;color:var(--text-muted,#888);margin-top:6px;line-height:1.5;">' +
          '\u26a0\ufe0f ' + tt(
            'בדיקה ראשונית בלבד: עומס אחיד, ללא רוח מרימה, ללא שילוב כפיפה-לחיצה, ללא קריסה לרוחב, ללא חיבורים ושקיעות. נדרש אישור מהנדס.',
            'ตรวจสอบเบื้องต้นเท่านั้น ต้องมีวิศวกรรับรอง',
            'فحص أولي فقط — يلزم اعتماد مهندس') + '</div>' +
      '</div>';
    host.scrollIntoView({ block: 'nearest' });
  }

  function swapTo(role, name) {
    var p = projById(_open);
    if (!p || !ROLE_KEY[role]) return;
    p.dims[ROLE_KEY[role]] = name;
    saveP();
    var r = checkMember(role, name, p.dims);
    if (r.known && !r.ok) {
      toast('\u26a0\ufe0f ' + esc(name) + ' \u00b7 ' +
        tt('ניצול', 'การใช้งาน', 'الاستغلال') + ' ' + Math.round(r.util * 100) + '%');
    } else {
      toast('\u2705 ' + esc(name));
    }
    open(_open);
    setTimeout(function () { pickMember(role); }, 60);
  }

  function closeSwap() {
    _swapRole = null;
    var host = document.getElementById('bpSwap');
    if (host) host.innerHTML = '';
    if (_v3d) _v3d.select(null);
  }

  function memberLabel(g) {
    var names = {
      column:  tt('עמודים', 'เสา', 'أعمدة'),
      rafter:  tt('קורות גג', 'คาน', 'روافد'),
      purlin:  tt('מרישים', 'แป', 'مرايش'),
      girt:    tt('מסילות קיר', 'แปผนัง', 'مرايش الجدار'),
      roof:    tt('חיפוי גג', 'หลังคา', 'تغطية السقف'),
      wall:    tt('חיפוי קיר', 'ผนัง', 'تغطية الجدار'),
      slab:    tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني'),
      footing: tt('בסיסי עמודים', 'ฐานเสา', 'قواعد الأعمدة'),
      fence:   tt('גדר', 'รั้ว', 'سياج'),
      haunch:  tt('חיזוק פינה (האנץ\')', 'ฮันช์', 'تقوية الركن'),
      strut:   tt('קורת שפה', 'คานชายคา', 'رافدة الحافة'),
      brace:   tt('אלכסוני ייצוב', 'ค้ำยัน', 'دعامات'),
      gutter:  tt('מרזב וניקוז', 'รางน้ำ', 'مزراب'),
      ridge:   tt('רכס גג', 'สันหลังคา', 'قمة السقف'),
      skylight:tt('לוח סקיילייט', 'สกายไลท์', 'لوح إضاءة'),
      door:    tt('דלת/שער', 'ประตู', 'باب'),
      mezz:    tt('גלריה', 'ชั้นลอย', 'ميزانين')
    };
    return '\ud83d\udc46 ' + (names[g] || g);
  }

  function designTab(p) {
    var id = p.id, d = p.dims;

    if (p.type === 'slab') {
      var hs = '<div class="bp-split">' +
        '<div class="bp-stick"><div class="bp-card">' + svg(p) + '</div>' +
          '<div class="bp-card"><div class="bp-lbl">' +
            tt('נתונים מחושבים', 'ค่าที่คำนวณ', 'قيم محسوبة') + '</div>' +
            '<div id="bpRead"></div></div></div>' +
        '<div class="bp-pane">' +
          '<details class="bp-acc" open><summary>' + tt('מידות', 'ขนาด', 'الأبعاد') + '</summary><div>' +
          '<div class="bp-grid">' +
            ctl(id, 'length', tt('אורך (מ\')', 'ยาว', 'الطول'), d.length, 2, 80, 0.5) +
            ctl(id, 'span',   tt('רוחב (מ\')', 'กว้าง', 'العرض'), d.span, 2, 40, 0.5) +
            ctl(id, 'slabTh', tt('עובי (מ\')', 'หนา', 'السماكة'), d.slabTh, 0.08, 0.5, 0.01) +
            ctl(id, 'waste',  tt('פחת %', 'เผื่อ %', 'هدر %'), d.waste, 0, 25, 1) +
          '</div>' +
          (p.footprintArea > 0 ? '<div style="font-size:.78rem;color:var(--accent,#ff9f43);margin-top:8px;">' +
            '\ud83d\uddfa ' + tt('השטח נלקח מהמצולע במפה', 'ใช้พื้นที่จากแผนที่', 'المساحة من الخريطة') +
            ': ' + n1(p.footprintArea) + ' \u05de"\u05e8</div>' : '') +
          '</div></details>' +
        '</div></div>';
      return hs;
    }

    var g = geom(d), ft = footing(d), con = concrete(p);

    var models = Object.keys(MODELS).map(function (k) {
      return '<button class="bp-btn ' + (d._model === k ? 'on' : 'ghost') +
        '" style="padding:7px 11px;font-size:.76rem;" onclick="BuildPlan.applyModel(' + id +
        ',\'' + k + '\')">' + esc(pick(MODELS[k].label)) + '</button>';
    }).join('');

    // Left column holds the model and the derived numbers and stays put;
    // the right column scrolls. Previously every panel was stacked in one
    // list, so by the time you reached the foundation sliders the drawing
    // they affect was far off screen.
    return '<div class="bp-split">' +
      '<div class="bp-stick">' +
'<div class="bp-card">' +
        '<div id="bp3d" style="height:min(46vh,440px);border-radius:12px;overflow:hidden;' +
          'background:radial-gradient(circle at 50% 30%,rgba(255,255,255,.06),rgba(0,0,0,.25));"></div>' +
        '<div id="bpLegend" style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;"></div>' +
        '<div id="bpSwap" style="margin-top:8px;"></div>' +
        '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;flex-wrap:wrap;">' +
          '<span style="font-size:.74rem;color:var(--text-muted,#888);">' +
            tt('גרירה = סיבוב \u00b7 Shift+גרירה = הזזה \u00b7 גלגלת = זום \u00b7 לחיצה = בחירה',
               'ลาก=หมุน Shift=เลื่อน ล้อ=ซูม แตะ=เลือก',
               'سحب=تدوير \u00b7 Shift=تحريك \u00b7 عجلة=تكبير \u00b7 نقر=تحديد') + '</span>' +
          '<span id="bpSel" style="font-size:.78rem;font-weight:800;color:var(--accent,#ff9f43);"></span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(-0.62,0.42)">\u2934 ' + tt('איזומטרי', 'ไอโซ', 'أيزومتري') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(0,0.02)">\u25ad ' + tt('חזית', 'ด้านหน้า', 'واجهة') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(1.5708,0.02)">\u25b1 ' + tt('צד', 'ด้านข้าง', 'جانب') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(0,1.35)">\u2b1c ' + tt('מבט על', 'ด้านบน', 'علوي') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.resetView()">\u21ba ' + tt('איפוס', 'รีเซ็ต', 'إعادة') + '</button>' +
        '</div>' +
      '</div>' +
        '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">' +
          tt('נתונים מחושבים', 'ค่าที่คำนวณ', 'قيم محسوبة') + '</div>' +
          '<div id="bpRead"></div></div>' +
      '</div>' +

      '<div class="bp-pane">' +
        // What this project contains at all. A gate on its own is a project;
        // so is a slab. Forcing every project to be a shed is what put
        // 4.5 tonnes of steel on a gate.
        '<details class="bp-acc" open><summary>' +
          tt('רכיבי הפרויקט', 'ส่วนประกอบ', 'مكونات المشروع') + '</summary><div>' +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;">' +
            '<label><input type="checkbox"' + (p.hasStruct !== false ? ' checked' : '') +
              ' onchange="BuildPlan._comp(' + id + ',\'hasStruct\',this.checked)"> ' +
              tt('שלד / סככה', 'โครงสร้าง', 'هيكل') + '</label>' +
            '<label><input type="checkbox"' + (p.hasSlab !== false ? ' checked' : '') +
              ' onchange="BuildPlan._comp(' + id + ',\'hasSlab\',this.checked)"> ' +
              tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</label>' +
          '</div>' +
          '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:6px;">' +
            tt('שערים ומבני מגורים נוספים בלשוניות שלהם', 'ประตูและที่พักในแท็บแยก',
               'البوابات والسكن في تبويباتها') + '</div>' +
        '</div></details>' +

        '<details class="bp-acc" open><summary>' +
          tt('דגם התחלתי', 'แบบเริ่มต้น', 'نموذج أولي') + '</summary><div>' +

      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + models + '</div>' +
        '</div></details>' +

        '<details class="bp-acc" open><summary>' +
          tt('שכבות תצוגה', 'เลเยอร์', 'طبقات العرض') + '</summary>' +
          '<div id="bpLayers">' + layersPanel(p) + '</div></details>' +

        '<details class="bp-acc" open><summary>' +
          tt('מידות עיקריות', 'ขนาดหลัก', 'الأبعاد الرئيسية') + '</summary><div>' +
          '<div class="bp-grid">' +
            ctl(id, 'span',   tt('מפתח (מ\')', 'ช่วงกว้าง', 'الباع'), d.span, 4, 40, 0.5) +
            ctl(id, 'length', tt('אורך (מ\')', 'ยาว', 'الطول'), d.length, 4, 100, 0.5) +
            ctl(id, 'eaves',  tt('גובה עמוד (מ\')', 'สูงเสา', 'ارتفاع العمود'), d.eaves, 2, 12, 0.1) +
            ctl(id, 'bay',    tt('מרווח מסגרות (מ\')', 'ระยะเฟรม', 'تباعد الإطارات'), d.bay, 2, 10, 0.5) +
            ctl(id, 'pitch',  tt('שיפוע גג (\u00b0)', 'ความชัน', 'الميل'), d.pitch, 0, 35, 1) +
            ctl(id, 'waste',  tt('פחת %', 'เผื่อ %', 'هدر %'), d.waste, 0, 25, 1) +
          '</div>' +
          '<div id="bpBayWarn" style="font-size:.75rem;color:var(--accent,#ff9f43);margin-top:6px;">' +
            (Math.abs(g.actualBay - d.bay) > 0.05
              ? '\u26a0\ufe0f ' + tt('המרווח הותאם ל-', 'ปรับระยะเป็น ', 'تم ضبط التباعد إلى ') +
                n1(g.actualBay) + ' m ' +
                tt('כדי לחלק את האורך שווה בשווה', 'เพื่อแบ่งเท่ากัน', 'لتقسيم متساوٍ')
              : '') + '</div>' +
        '</div></details>' +

        '<details class="bp-acc"><summary>' +
          tt('גג וחיפוי', 'หลังคา', 'السقف والتغطية') + '</summary><div>' +
'<div class="bp-grid">' +
        '<div><div class="bp-lbl">' + tt('סוג גג', 'ชนิดหลังคา', 'نوع السقف') + '</div>' +
          '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'roofType\',this.value)">' +
            '<option value="gable"' + (d.roofType === 'gable' ? ' selected' : '') + '>' +
              tt('אגוזי (שני שיפועים)', 'จั่ว', 'جملوني') + '</option>' +
            '<option value="mono"' + (d.roofType === 'mono' ? ' selected' : '') + '>' +
              tt('חד-שיפועי', 'เพิงหมาแหงน', 'ميل واحد') + '</option></select></div>' +
        // Built from the catalogue, because the model stores the PRODUCT.
        // These used to offer a three-value enum while the model held a
        // product name, so nothing ever matched: the box showed the first
        // option and the takeoff billed whatever was really stored. That is
        // the "פאנל 5 I never chose" — it was the default, displayed as
        // something else.
        '<div><div class="bp-lbl">' + tt('חיפוי גג', 'วัสดุหลังคา', 'مادة السقف') + '</div>' +
          cladSelect(id, 'roofClad', d.roofClad) + '</div>' +
        '<div><div class="bp-lbl">' + tt('קירות', 'ผนัง', 'الجدران') + '</div>' +
          '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'wallMode\',this.value)">' +
            '<option value="full"' + (d.wallMode === 'full' ? ' selected' : '') + '>' +
              tt('סגור', 'ปิด', 'مغلق') + '</option>' +
            '<option value="half"' + (d.wallMode === 'half' ? ' selected' : '') + '>' +
              tt('חצי גובה', 'ครึ่ง', 'نصف') + '</option>' +
            '<option value="open"' + (d.wallMode === 'open' ? ' selected' : '') + '>' +
              tt('פתוח', 'เปิด', 'مفتوح') + '</option></select></div>' +
        '<div><div class="bp-lbl">' + tt('חיפוי קיר', 'วัสดุผนัง', 'مادة الجدار') + '</div>' +
          cladSelect(id, 'wallClad', d.wallClad) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
        '<label><input type="checkbox"' + (d.fence ? ' checked' : '') +
          ' onchange="BuildPlan._dim(' + id + ',\'fence\',this.checked)"> ' +
          tt('גידור היקפי', 'รั้วรอบ', 'سياج محيطي') + '</label>' +
        (d.fence ? '<label style="font-size:.78rem;">' + tt('גובה', 'สูง', 'ارتفاع') +
          ' <input type="number" step="0.1" value="' + d.fenceH + '" style="width:60px;" class="bp-in" ' +
          'onchange="BuildPlan._dim(' + id + ',\'fenceH\',this.value)"></label>' +
          '<label style="font-size:.78rem;">' + tt('מרחק מהמבנה', 'ระยะห่าง', 'المسافة') +
          ' <input type="number" step="0.5" value="' + d.fenceOff + '" style="width:60px;" class="bp-in" ' +
          'onchange="BuildPlan._dim(' + id + ',\'fenceOff\',this.value)"></label>' : '') +
      '</div></div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          tt('שלד ורכיבים', 'โครงสร้าง', 'الهيكل والمكونات') + '</summary><div>' +

        '<div class="bp-grid">' +
          '<div><div class="bp-lbl">' + tt('סוג קורת גג', 'ชนิดคาน', 'نوع الرافدة') + '</div>' +
            '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'rafterType\',this.value)">' +
              '<option value="solid"' + (d.rafterType === 'solid' ? ' selected' : '') + '>' +
                tt('קורה מלאה (H/IPE)', 'คานตัน', 'رافدة صلبة') + '</option>' +
              '<option value="truss"' + (d.rafterType === 'truss' ? ' selected' : '') + '>' +
                tt('סבכה / רפפה', 'โครงถัก', 'جملون شبكي') + '</option></select></div>' +
          (d.rafterType === 'truss'
            ? ctl(id, 'trussDepth', tt('גובה סבכה (מ\')', 'ความลึก', 'عمق الجملون'), d.trussDepth, 0.3, 2, 0.05)
            : '') +
          ctl(id, 'skylights', tt('רצועות סקיילייט', 'สกายไลท์', 'شرائط إضاءة'), d.skylights, 0, 6, 1) +
          ctl(id, 'leanTo', tt('סככת צד (מ\')', 'เพิงข้าง', 'جناح جانبي'), d.leanTo, 0, 10, 0.5) +
          ctl(id, 'mezz', tt('עומק גלריה (מ\')', 'ชั้นลอย', 'عمق الميزانين'), d.mezz, 0, 12, 0.5) +
          (d.mezz > 0 ? ctl(id, 'mezzH', tt('גובה גלריה (מ\')', 'สูงชั้นลอย', 'ارتفاع الميزانين'), d.mezzH, 2, 6, 0.1) : '') +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
          '<label><input type="checkbox"' + (d.haunch ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'haunch\',this.checked)"> ' +
            tt('חיזוק פינה', 'ฮันช์', 'تقوية الركن') + '</label>' +
          '<label><input type="checkbox"' + (d.taper ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'taper\',this.checked)"> ' +
            tt('עמוד משתנה', 'เสาเรียว', 'عمود متغير') + '</label>' +
          '<label><input type="checkbox"' + (d.bracing ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'bracing\',this.checked)"> ' +
            tt('אלכסוני ייצוב', 'ค้ำยัน', 'دعامات') + '</label>' +
          '<label><input type="checkbox"' + (d.gutter ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'gutter\',this.checked)"> ' +
            tt('מרזבים', 'รางน้ำ', 'مزاريب') + '</label>' +
          '<label><input type="checkbox"' + (d.door ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'door\',this.checked)"> ' +
            tt('שער', 'ประตู', 'بوابة') + '</label>' +
        '</div>' +
        (d.door ? '<div class="bp-grid" style="margin-top:6px;">' +
          ctl(id, 'doorW', tt('רוחב שער', 'กว้างประตู', 'عرض البوابة'), d.doorW, 1, 12, 0.5) +
          ctl(id, 'doorH', tt('גובה שער', 'สูงประตู', 'ارتفاع البوابة'), d.doorH, 1.8, 8, 0.1) +
        '</div>' : '') +
      '</div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          tt('פרופילים', 'โปรไฟล์', 'المقاطع') + '</summary><div>' +
'<div class="bp-grid">' +
      '<div><div class="bp-lbl">' + tt('עמודים', 'เสา', 'أعمدة') + '</div>' +
        profSel(id, 'colProfile', 'עמודים / קורות', d.colProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('קורות גג', 'คาน', 'روافد') + '</div>' +
        profSel(id, 'rafterProfile', 'עמודים / קורות', d.rafterProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('מרישים', 'แป', 'مرايش') + '</div>' +
        profSel(id, 'purlinProfile', 'מרישים', d.purlinProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('מסילות קיר', 'แปผนัง', 'مرايش الجدار') + '</div>' +
        profSel(id, 'girtProfile', 'מרישים', d.girtProfile) + '</div>' +
    '</div></div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          tt('ביסוס עמודים', 'ฐานราก', 'أساسات الأعمدة') + '</summary><div>' +

        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;font-size:.8rem;">' +
          '<label><input type="checkbox"' + (d.footings ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'footings\',this.checked)"> ' +
            tt('בסיסים בודדים', 'ฐานแยก', 'قواعد منفصلة') + '</label></div>' +
        '<div class="bp-grid">' +
          ctl(id, 'footW', tt('צלע בסיס (מ\')', 'ด้านฐาน', 'ضلع القاعدة'), d.footW, 0.4, 3, 0.1) +
          ctl(id, 'footD', tt('עומק בסיס (מ\')', 'ลึกฐาน', 'عمق القاعدة'), d.footD, 0.4, 2.5, 0.1) +
          ctl(id, 'slabTh', tt('עובי משטח (מ\')', 'หนาพื้น', 'سماكة السطح'), d.slabTh, 0.08, 0.5, 0.01) +
          ctl(id, 'soilBearing', tt('כושר נשיאה (kPa)', 'กำลังรับดิน', 'تحمل التربة'), d.soilBearing, 60, 400, 10) +
        '</div>' +
        '<div id="bpFound" style="margin-top:8px;">' + footingSummary(p) + '</div>' +
        '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:6px;">\u26a0\ufe0f ' +
          tt('הערכה ראשונית בלבד: עומס אחיד, ללא רוח/מומנט, קרקע הומוגנית. נדרש אישור מהנדס וסקר קרקע.',
             'ประมาณการเบื้องต้นเท่านั้น ต้องมีวิศวกรรับรอง',
             'تقدير أولي فقط — يلزم اعتماد مهندس وتقرير تربة') + '</div>' +
      '</div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          tt('סביבה ותאורה', 'สภาพแวดล้อม', 'البيئة والإضاءة') + '</summary><div>' +

        '<div class="bp-grid">' +
          '<div><div class="bp-lbl">' + tt('כיוון שמש', 'ทิศดวงอาทิตย์', 'اتجاه الشمس') + '</div>' +
            '<input class="bp-rng" type="range" min="0" max="360" step="5" value="' + d.sunAz + '" ' +
              'oninput="BuildPlan.sun(' + id + ',\'sunAz\',this.value)"></div>' +
          '<div><div class="bp-lbl">' + tt('גובה שמש', 'มุมสูง', 'ارتفاع الشمس') + '</div>' +
            '<input class="bp-rng" type="range" min="8" max="88" step="2" value="' + d.sunEl + '" ' +
              'oninput="BuildPlan.sun(' + id + ',\'sunEl\',this.value)"></div>' +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
        '<div class="bp-grid" style="margin-top:8px;">' +
          '<div><div class="bp-lbl">' + tt('סרגל קנה מידה', 'อ้างอิงมาตราส่วน', 'مرجع المقياس') + '</div>' +
            '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'scaleRef\',this.value)">' +
              '<option value="staff"' + (d.scaleRef === 'staff' ? ' selected' : '') + '>' +
                tt('מוט מדידה מדורג', 'ไม้วัดระดับ', 'قضيب قياس') + '</option>' +
              '<option value="person"' + (d.scaleRef === 'person' ? ' selected' : '') + '>' +
                tt('דמות אדם 1.75 מ\'', 'คน 1.75 ม.', 'شخص 1.75 م') + '</option>' +
              '<option value="palm"' + (d.scaleRef === 'palm' ? ' selected' : '') + '>' +
                tt('דקל עם סקאלה', 'ปาล์มมีมาตราส่วน', 'نخلة بمقياس') + '</option>' +
              '<option value="none"' + (d.scaleRef === 'none' ? ' selected' : '') + '>' +
                tt('ללא', 'ไม่มี', 'بدون') + '</option></select></div>' +
          (d.scaleRef === 'palm'
            ? ctl(id, 'scaleH', tt('גובה הדקל (מ\')', 'สูงปาล์ม', 'ارتفاع النخلة'), d.scaleH, 3, 20, 0.5)
            : '') +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
          '<label><input type="checkbox"' + (d.mapGround ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'mapGround\',this.checked)"> ' +
            tt('רקע לוויין מהמפה', 'ภาพดาวเทียม', 'صورة الأقمار') + '</label>' +
          '<label><input type="checkbox"' + (d.callouts ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'callouts\',this.checked)"> ' +
            tt('סימוני רכיבים', 'ป้ายกำกับ', 'وسوم المكونات') + '</label>' +
          '<label><input type="checkbox"' + (d.shadows ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'shadows\',this.checked)"> ' +
            tt('צללים', 'เงา', 'ظلال') + '</label>' +
          '<label><input type="checkbox"' + (d.dims ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'dims\',this.checked)"> ' +
            tt('מידות', 'ขนาด', 'أبعاد') + '</label>' +
        '</div>' +
        '</div></div></details>' +
      '</div></div>';
  }

  // ── free sketch ──────────────────────────────────────────────────────
  // The parametric model covers rectangular portal frames. Everything else
  // an orchard actually builds — an L-shaped canopy, a bund wall, a ramp
  // with a turn — needs a drawing surface, and this is it.
  function sketchTab(p) {
    var b = function (tool, icon, he, th, ar) {
      return '<button class="bp-btn ghost" id="skT_' + tool + '" ' +
        'style="padding:7px 11px;font-size:.78rem;" onclick="BuildPlan.skTool(\'' + tool + '\')">' +
        icon + ' ' + tt(he, th, ar) + '</button>';
    };
    return '<div class="bp-split">' +
      '<div class="bp-stick">' +
        '<div class="bp-card">' +
          '<div id="bpSketch" style="height:min(52vh,480px);border-radius:12px;overflow:hidden;' +
            'background:#f4f6f4;"></div>' +
          '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:6px;">' +
            tt('גרירה = הזזה \u00b7 גלגלת = זום \u00b7 לחיצה כפולה = סיום קו שבור \u00b7 הצמדה לקודקודים ולרשת',
               'ลาก=เลื่อน ล้อ=ซูม ดับเบิลคลิก=จบเส้น',
               'سحب=تحريك \u00b7 عجلة=تكبير \u00b7 نقر مزدوج=إنهاء') + '</div>' +
        '</div>' +
        '<div class="bp-card"><div class="bp-lbl">' +
          tt('נתוני השרטוט', 'ข้อมูลแบบ', 'بيانات الرسم') + '</div>' +
          '<div id="bpSkInfo"></div></div>' +
      '</div>' +
      '<div class="bp-pane">' +
        '<details class="bp-acc" open><summary>' + tt('כלים', 'เครื่องมือ', 'أدوات') + '</summary><div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;">' +
            b('select', '\u2196', 'בחירה', 'เลือก', 'تحديد') +
            b('line',   '\u2571', 'קו', 'เส้น', 'خط') +
            b('poly',   '\u2b20', 'קו שבור', 'เส้นหลายจุด', 'خط متعدد') +
            b('rect',   '\u25ad', 'מלבן', 'สี่เหลี่ยม', 'مستطيل') +
            b('circle', '\u25cb', 'עיגול', 'วงกลม', 'دائرة') +
            b('pan',    '\u270b', 'הזזה', 'เลื่อน', 'تحريك') +
          '</div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;">' +
            '<label style="display:inline-flex;gap:5px;align-items:center;font-size:.78rem;">' +
              '<input type="checkbox" onchange="BuildPlan.skOrtho(this.checked)"> ' +
              tt('ישר בלבד', 'ตั้งฉาก', 'عمودي فقط') + '</label>' +
          '</div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;">' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skUndo()">\u21b6 ' + tt('בטל', 'เลิกทำ', 'تراجع') + '</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skRedo()">\u21b7 ' + tt('בצע שוב', 'ทำซ้ำ', 'إعادة') + '</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skFit()">\u2922 ' + tt('התאם', 'พอดี', 'ملاءمة') + '</button>' +
            '<button class="bp-btn warn" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skDel()">\ud83d\uddd1 ' + tt('מחק נבחר', 'ลบ', 'حذف') + '</button>' +
          '</div>' +
        '</div></details>' +
        '<details class="bp-acc" open><summary>' +
          tt('מידות מדויקות', 'ขนาดที่แน่นอน', 'أبعاد دقيقة') + '</summary>' +
          '<div id="bpSkEdit"><div class="bp-empty" style="font-size:.8rem;">' +
            tt('בחר צורה כדי לערוך את המידות שלה', 'เลือกรูปเพื่อแก้ไข', 'اختر شكلاً لتحرير أبعاده') +
          '</div></div></details>' +
        '<details class="bp-acc"><summary>' + tt('שינוי גודל', 'ปรับขนาด', 'تغيير الحجم') + '</summary><div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;">' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(0.5)">\u00d70.5</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(0.9)">\u00d70.9</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(1.1)">\u00d71.1</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(2)">\u00d72</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skRotate(-15)">\u21ba15\u00b0</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skRotate(15)">\u21bb15\u00b0</button>' +
          '</div></div></details>' +
      '</div></div>';
  }

  function mountSketch(p) {
    var host = document.getElementById('bpSketch');
    if (!host || typeof Sketch === 'undefined') return;
    Sketch.mount(host, p.sketch, {
      onChange: function (model, sum) {
        p.sketch = model;
        skInfo(sum);
        skEdit();
        if (_skSave) clearTimeout(_skSave);
        _skSave = setTimeout(function () { saveP(); }, 800);
      }
    });
    skTool('select');
  }
  var _skSave = null;

  function skInfo(sum) {
    var el = document.getElementById('bpSkInfo');
    if (!el || !sum) return;
    el.innerHTML =
      '<div class="bp-read"><span>' + tt('צורות', 'รูปทรง', 'أشكال') + '</span><b>' + sum.shapes + '</b></div>' +
      '<div class="bp-read"><span>' + tt('שטח כולל', 'พื้นที่รวม', 'المساحة') + '</span><b>' +
        n1(sum.area) + ' \u05de"\u05e8</b></div>' +
      '<div class="bp-read"><span>' + tt('אורך קווים', 'ความยาวรวม', 'الطول') + '</span><b>' +
        n1(sum.perim) + ' m</b></div>';
  }

  // The numeric side of the sketcher: every segment of the selected shape
  // gets a length and a bearing you can type into.
  function skEdit() {
    var el = document.getElementById('bpSkEdit');
    if (!el || typeof Sketch === 'undefined') return;
    var sel = Sketch.selection();
    if (!sel) {
      el.innerHTML = '<div class="bp-empty" style="font-size:.8rem;">' +
        tt('בחר צורה כדי לערוך את המידות שלה', 'เลือกรูปเพื่อแก้ไข', 'اختر شكلاً لتحرير أبعاده') + '</div>';
      return;
    }
    var h = '<div style="padding:0 2px;">';
    if (sel.kind === 'circle') {
      h += '<div class="bp-lbl">' + tt('רדיוס (מ\')', 'รัศมี', 'نصف القطر') + '</div>' +
        '<input class="bp-in" type="number" step="0.05" value="' + n2(sel.r) + '" ' +
          'onchange="BuildPlan.skRadius(this.value)">';
    } else {
      sel.segs.forEach(function (sg) {
        h += '<div style="display:flex;gap:5px;align-items:center;margin-bottom:5px;">' +
          '<span style="font-size:.72rem;color:var(--text-muted,#888);width:26px;">' + (sg.i+1) + '</span>' +
          '<input class="bp-in" type="number" step="0.05" value="' + n2(sg.len) + '" ' +
            'style="flex:1;" onchange="BuildPlan.skSeg(' + sg.i + ',this.value,null)">' +
          '<span style="font-size:.72rem;color:var(--text-muted,#888);">m</span>' +
          '<input class="bp-in" type="number" step="1" value="' + Math.round(sg.ang) + '" ' +
            'style="width:70px;" onchange="BuildPlan.skSeg(' + sg.i + ',null,this.value)">' +
          '<span style="font-size:.72rem;color:var(--text-muted,#888);">\u00b0</span>' +
        '</div>';
      });
    }
    h += '<div class="bp-read" style="margin-top:6px;"><span>' + tt('שטח', 'พื้นที่', 'مساحة') +
      '</span><b>' + n1(sel.area) + ' \u05de"\u05e8</b></div>' +
      '<div class="bp-read"><span>' + tt('היקף', 'เส้นรอบรูป', 'محيط') + '</span><b>' +
      n1(sel.perim) + ' m</b></div></div>';
    el.innerHTML = h;
  }

  function skTool(t) {
    if (typeof Sketch === 'undefined') return;
    Sketch.setTool(t);
    ['select','line','poly','rect','circle','pan'].forEach(function (k) {
      var b2 = document.getElementById('skT_' + k);
      if (b2) b2.className = 'bp-btn ' + (k === t ? '' : 'ghost');
    });
  }
  function skOrtho(v) { if (typeof Sketch !== 'undefined') Sketch.setOrtho(v); }
  function skUndo()  { if (typeof Sketch !== 'undefined') { Sketch.undo(); skEdit(); } }
  function skRedo()  { if (typeof Sketch !== 'undefined') { Sketch.redo(); skEdit(); } }
  function skFit()   { if (typeof Sketch !== 'undefined') Sketch.fit(); }
  function skDel()   { if (typeof Sketch !== 'undefined') { Sketch.del(); skEdit(); } }
  function skScale(f){ if (typeof Sketch !== 'undefined') { Sketch.scaleSel(f); skEdit(); } }
  function skRotate(d){ if (typeof Sketch !== 'undefined') { Sketch.rotateSel(d); skEdit(); } }
  function skSeg(i, l, a) {
    if (typeof Sketch === 'undefined') return;
    Sketch.setSegment(i, l === null ? null : Number(l), a === null ? null : Number(a));
    skEdit();
  }
  function skRadius(r) { if (typeof Sketch !== 'undefined') { Sketch.setCircle(Number(r)); skEdit(); } }

  // ── gates ────────────────────────────────────────────────────────────
  function gatesTab(p) {
    var id = p.id;
    if (typeof Gates === 'undefined') return '<div class="bp-empty">Gates module not loaded</div>';
    if (!(p.gates || []).length) {
      return '<div class="bp-card"><div class="bp-empty">' +
        tt('אין שערים בפרויקט. שער נכנס לאותו כתב כמויות כמו שאר העבודה.',
           'ยังไม่มีประตู', 'لا توجد بوابات') + '</div>' +
        '<button class="bp-btn" onclick="BuildPlan.addGate(' + id + ')">\u2795 ' +
          tt('הוסף שער', 'เพิ่มประตู', 'إضافة بوابة') + '</button></div>';
    }
    var h = '';
    p.gates.forEach(function (g, i) {
      var sum = Gates.summary(g);
      var rows = Gates.takeoff(g);
      var tSel = Gates.TYPES.map(function (t) {
        return '<option value="' + t + '"' + (g.type === t ? ' selected' : '') + '>' +
          esc(Gates.typeLabel(t)) + '</option>';
      }).join('');
      h += '<div class="bp-split" style="margin-bottom:14px;">' +
        '<div class="bp-stick"><div class="bp-card">' + Gates.svg(g) + '</div>' +
          '<div class="bp-card">' +
            rows.slice(0, 6).map(function (r) {
              return '<div class="bp-read"><span>' + esc(dsp(r.name)) + '</span><b>' +
                n1(r.qty) + ' ' + esc(dsp(r.unit)) + '</b></div>';
            }).join('') +
            (rows.length > 6 ? '<div style="font-size:.74rem;color:var(--text-muted,#888);">+' +
              (rows.length - 6) + ' ' + tt('שורות נוספות', 'รายการเพิ่ม', 'بنود إضافية') + '</div>' : '') +
          '</div></div>' +
        '<div class="bp-pane">' +
          '<div class="bp-card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
              '<input class="bp-in" style="flex:1;" value="' + esc(g.name) + '" placeholder="' +
                tt('שם השער', 'ชื่อประตู', 'اسم البوابة') + '" ' +
                'onchange="BuildPlan.setGate(' + id + ',' + i + ',\'name\',this.value)">' +
              '<button class="bp-btn warn" style="padding:5px 10px;" ' +
                'onclick="BuildPlan.delGate(' + id + ',' + i + ')">\ud83d\uddd1</button></div>' +
            '<div class="bp-lbl" style="margin-top:8px;">' + tt('סוג', 'ชนิด', 'النوع') + '</div>' +
            '<select class="bp-in" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'type\',this.value)">' +
              tSel + '</select>' +
            '<div class="bp-grid" style="margin-top:8px;">' +
              gctl(id, i, 'width',  tt('רוחב אור (מ\')', 'ความกว้าง', 'العرض'), g.width, 1, 12, 0.1) +
              gctl(id, i, 'height', tt('גובה (מ\')', 'ความสูง', 'الارتفاع'), g.height, 1, 4, 0.1) +
              gctl(id, i, 'postDepth', tt('עומק יסוד (מ\')', 'ลึกฐาน', 'عمق الأساس'), g.postDepth, 0.4, 2, 0.1) +
              gctl(id, i, 'postSize', tt('צלע יסוד (מ\')', 'ด้านฐาน', 'ضلع الأساس'), g.postSize, 0.2, 1, 0.05) +
              gctl(id, i, 'infillRows', tt('קורות ביניים', 'คานกลาง', 'عوارض وسطية'), g.infillRows, 0, 4, 1) +
            '</div>' +
            '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
              '<label><input type="checkbox"' + (g.bracing ? ' checked' : '') +
                ' onchange="BuildPlan.setGate(' + id + ',' + i + ',\'bracing\',this.checked)"> ' +
                tt('אלכסון ייצוב', 'ค้ำยัน', 'دعامة') + '</label>' +
              '<label><input type="checkbox"' + (g.motor ? ' checked' : '') +
                ' onchange="BuildPlan.setGate(' + id + ',' + i + ',\'motor\',this.checked)"> ' +
                tt('מנוע חשמלי', 'มอเตอร์', 'محرك') + '</label>' +
            '</div>' +
            '<div class="bp-grid" style="margin-top:8px;">' +
              '<div><div class="bp-lbl">' + tt('פרופיל מסגרת', 'โปรไฟล์กรอบ', 'مقطع الإطار') + '</div>' +
                gprof(id, i, 'frame', g.frame) + '</div>' +
              '<div><div class="bp-lbl">' + tt('פרופיל עמוד', 'โปรไฟล์เสา', 'مقطع العمود') + '</div>' +
                gprof(id, i, 'post', g.post) + '</div>' +
            '</div>' +
            '<div class="bp-read" style="margin-top:8px;"><span>' +
              tt('שטח כנף', 'พื้นที่บาน', 'مساحة المصراع') + '</span><b>' + n1(sum.area) + ' \u05de"\u05e8</b></div>' +
            (sum.swingRadius ? '<div class="bp-read"><span>' +
              tt('רדיוס פתיחה נדרש', 'รัศมีเปิด', 'نصف قطر الفتح') + '</span><b>' +
              n1(sum.swingRadius) + ' m</b></div>' : '') +
            (sum.tail ? '<div class="bp-read"><span>' +
              tt('זנב משקל נגדי', 'หางถ่วง', 'ذيل الموازنة') + '</span><b>' + n1(sum.tail) + ' m</b></div>' : '') +
          '</div>' +
        '</div></div>';
    });
    h += '<button class="bp-btn" onclick="BuildPlan.addGate(' + id + ')">\u2795 ' +
      tt('הוסף שער', 'เพิ่มประตู', 'إضافة بوابة') + '</button>';
    return h;
  }

  function gctl(id, i, key, label, val, min, max, step) {
    return '<div><div class="bp-lbl">' + label + ' <b style="color:var(--accent,#ff9f43);">' +
        val + '</b></div>' +
      '<input class="bp-rng" type="range" min="' + min + '" max="' + max + '" step="' + step +
        '" value="' + val + '" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'' + key + '\',this.value)">' +
      '<input class="bp-in" type="number" step="' + step + '" value="' + val + '" ' +
        'onchange="BuildPlan.setGate(' + id + ',' + i + ',\'' + key + '\',this.value)"></div>';
  }
  function gprof(id, i, key, cur) {
    var o = '';
    (C.profiles || []).filter(function (x) {
      return x.group === 'פרופיל מלבני' || x.group === 'פרופיל מרובע' || x.group === 'עמודים / קורות';
    }).forEach(function (x) {
      o += '<option value="' + esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        esc(x.name) + '</option>';
    });
    if (!o) o = '<option>' + esc(cur) + '</option>';
    return '<select class="bp-in" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'' + key +
      '\',this.value)">' + o + '</select>';
  }

  function addGate(id) {
    var p = projById(id);
    if (!p || typeof Gates === 'undefined') return;
    p.gates.push(Gates.norm({ name: tt('שער', 'ประตู', 'بوابة') + ' ' + (p.gates.length + 1) }));
    saveP(); open(id);
  }
  function delGate(id, i) {
    var p = projById(id);
    if (!p) return;
    p.gates.splice(i, 1);
    saveP(); open(id);
  }
  var BOOLG = { bracing: 1, motor: 1 };
  var TEXTG = { name: 1, type: 1, frame: 1, post: 1, mesh: 1, notes: 1 };
  function setGate(id, i, k, v) {
    var p = projById(id);
    if (!p || !p.gates[i]) return;
    p.gates[i][k] = BOOLG[k] ? !!v : TEXTG[k] ? String(v) : (Number(v) || 0);
    saveP(); open(id);
  }

  // ── accommodation ────────────────────────────────────────────────────
  function livingTab(p) {
    var id = p.id;
    if (typeof LivingUnit === 'undefined') return '<div class="bp-empty">LivingUnit not loaded</div>';
    if (!p.living || !p.living.people) {
      return '<div class="bp-card"><div class="bp-empty">' +
        tt('אין מתחם מגורים בפרויקט. הזן מספר אנשים והתוכנית תיגזר מזה.',
           'ยังไม่มีที่พัก', 'لا يوجد سكن') + '</div>' +
        '<button class="bp-btn" onclick="BuildPlan.addLiving(' + id + ')">\u2795 ' +
          tt('הוסף מתחם מגורים', 'เพิ่มที่พัก', 'إضافة سكن') + '</button></div>';
    }
    var u = p.living, pr = LivingUnit.program(u);
    var lc = function (key, label, val, min, max, step) {
      return '<div><div class="bp-lbl">' + label + ' <b style="color:var(--accent,#ff9f43);">' +
          val + '</b></div>' +
        '<input class="bp-rng" type="range" min="' + min + '" max="' + max + '" step="' + step +
          '" value="' + val + '" onchange="BuildPlan.setLiving(' + id + ',\'' + key + '\',this.value)">' +
        '<input class="bp-in" type="number" step="' + step + '" value="' + val + '" ' +
          'onchange="BuildPlan.setLiving(' + id + ',\'' + key + '\',this.value)"></div>';
    };
    return '<div class="bp-split">' +
      '<div class="bp-stick"><div class="bp-card">' + LivingUnit.svg(u) + '</div>' +
        '<div class="bp-card"><div class="bp-lbl">' + tt('תוכנית שטחים', 'โปรแกรมพื้นที่', 'برنامج المساحات') +
          '</div>' +
          '<div class="bp-read"><span>' + tt('חדרי שינה', 'ห้องนอน', 'غرف النوم') + '</span><b>' +
            pr.rooms + ' \u00d7 ' + u.perRoom + '</b></div>' +
          '<div class="bp-read"><span>' + tt('שירותים / מקלחות / כיורים', 'สุขา/ฝักบัว/อ่าง', 'حمامات') +
            '</span><b>' + pr.wc + ' / ' + pr.showers + ' / ' + pr.basins + '</b></div>' +
          '<div class="bp-read"><span>' + tt('משטח מטבח', 'เคาน์เตอร์', 'سطح المطبخ') + '</span><b>' +
            n1(pr.counter) + ' m</b></div>' +
          '<div class="bp-read"><span>' + tt('חלל אוכל', 'ส่วนกลาง', 'صالة') + '</span><b>' +
            n1(pr.dining) + ' \u05de"\u05e8</b></div>' +
          '<div class="bp-read"><span>' + tt('שטח כולל', 'พื้นที่รวม', 'المساحة الكلية') + '</span><b>' +
            n1(pr.total) + ' \u05de"\u05e8</b></div>' +
        '</div></div>' +
      '<div class="bp-pane">' +
        '<details class="bp-acc" open><summary>' + tt('בסיס התכנון', 'พื้นฐานการออกแบบ', 'أساس التصميم') +
          '</summary><div>' +
          '<div class="bp-lbl">' + tt('אופן הביצוע', 'รูปแบบงาน', 'نوع العمل') + '</div>' +
          '<select class="bp-in" onchange="BuildPlan.setLiving(' + id + ',\'mode\',this.value)">' +
            '<option value="fitout"' + (u.mode === 'fitout' ? ' selected' : '') + '>' +
              tt('התאמת מבנה קיים — מחיצות ופנים בלבד', 'ปรับปรุงอาคารเดิม', 'تجهيز مبنى قائم') + '</option>' +
            '<option value="full"' + (u.mode === 'full' ? ' selected' : '') + '>' +
              tt('הקמה מלאה כולל מעטפת', 'สร้างใหม่ทั้งหมด', 'إنشاء كامل') + '</option></select>' +
          '<div class="bp-grid" style="margin-top:8px;">' +
            lc('people', tt('מספר אנשים', 'จำนวนคน', 'عدد الأشخاص'), u.people, 2, 60, 1) +
            lc('perRoom', tt('אנשים לחדר', 'คนต่อห้อง', 'أشخاص لكل غرفة'), u.perRoom, 1, 8, 1) +
            lc('height', tt('גובה פנים (מ\')', 'ความสูง', 'الارتفاع'), u.height, 2.2, 4, 0.05) +
          '</div>' +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
            '<label><input type="checkbox"' + (u.blockWet ? ' checked' : '') +
              ' onchange="BuildPlan.setLiving(' + id + ',\'blockWet\',this.checked)"> ' +
              tt('קירות בלוק בחדרים רטובים', 'ผนังบล็อกห้องน้ำ', 'جدران بلوك للحمامات') + '</label>' +
            '<label><input type="checkbox"' + (u.ac ? ' checked' : '') +
              ' onchange="BuildPlan.setLiving(' + id + ',\'ac\',this.checked)"> ' +
              tt('מיזוג', 'แอร์', 'تكييف') + '</label>' +
          '</div>' +
          '<div class="bp-grid" style="margin-top:8px;">' +
            '<div><div class="bp-lbl">' + tt('חומר מחיצות', 'วัสดุผนัง', 'مادة القواطع') + '</div>' +
              '<select class="bp-in" onchange="BuildPlan.setLiving(' + id + ',\'partition\',this.value)">' +
              cladOptions(u.partition) + '</select></div>' +
            (u.mode === 'full'
              ? '<div><div class="bp-lbl">' + tt('מעטפת', 'เปลือก', 'الغلاف') + '</div>' +
                '<select class="bp-in" onchange="BuildPlan.setLiving(' + id + ',\'envelope\',this.value)">' +
                cladOptions(u.envelope) + '</select></div>'
              : '') +
          '</div>' +
          '<button class="bp-btn warn" style="margin-top:10px;" onclick="BuildPlan.delLiving(' + id + ')">' +
            '\ud83d\uddd1 ' + tt('הסר מגורים', 'ลบที่พัก', 'إزالة السكن') + '</button>' +
        '</div></details>' +
        '<details class="bp-acc"><summary>' + tt('תקני תכנון', 'เกณฑ์', 'معايير') + '</summary><div>' +
          '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-bottom:8px;">' +
            tt('אלה מוסכמות מקצועיות ולא תקן מחייב. דרישות משרד העבודה לאתר מסוים עשויות להיות מחמירות יותר.',
               'เป็นแนวปฏิบัติ ไม่ใช่มาตรฐานบังคับ',
               'هذه أعراف مهنية وليست معياراً ملزماً') + '</div>' +
          '<div class="bp-grid">' +
            lc('perPerson', tt('מ"ר שינה לאדם', 'ตร.ม./คน', 'م² لكل شخص'), u.perPerson, 2, 8, 0.5) +
            lc('wcPer', tt('אנשים לאסלה', 'คน/สุขา', 'أشخاص/مرحاض'), u.wcPer, 4, 15, 1) +
            lc('showerPer', tt('אנשים למקלחת', 'คน/ฝักบัว', 'أشخاص/دُش'), u.showerPer, 4, 15, 1) +
            lc('basinPer', tt('אנשים לכיור', 'คน/อ่าง', 'أشخاص/حوض'), u.basinPer, 3, 12, 1) +
            lc('counterPer', tt('מ\' משטח לאדם', 'ม.เคาน์เตอร์/คน', 'م سطح/شخص'), u.counterPer, 0.2, 1, 0.05) +
            lc('diningPer', tt('מ"ר אוכל לאדם', 'ตร.ม.ส่วนกลาง/คน', 'م² صالة/شخص'), u.diningPer, 0.6, 3, 0.1) +
          '</div></div></details>' +
      '</div></div>';
  }

  function addLiving(id) {
    var p = projById(id);
    if (!p || typeof LivingUnit === 'undefined') return;
    p.living = LivingUnit.norm({ people: 20 });
    saveP(); open(id);
  }
  function delLiving(id) {
    var p = projById(id);
    if (!p) return;
    p.living = null;
    saveP(); open(id);
  }
  var BOOLL = { blockWet: 1, ac: 1 };
  var TEXTL = { mode: 1, partition: 1, envelope: 1, notes: 1 };
  function setLiving(id, k, v) {
    var p = projById(id);
    if (!p || !p.living) return;
    p.living[k] = BOOLL[k] ? !!v : TEXTL[k] ? String(v) : (Number(v) || 0);
    saveP(); open(id);
  }

  function matTab(p, rows, tot) {
    var h = '<div class="bp-card">';
    rows.forEach(function (r) {
      var pr = profByName(r.name);
      h += '<div class="bp-tot"><span>' + esc(dsp(r.name)) +
        (r.note ? '<br><span style="font-size:.7rem;color:var(--text-muted,#888);">' +
          esc(dsp(r.note)) + '</span>' : '') + '</span>' +
        '<span style="white-space:nowrap;text-align:end;">' + n1(r.qty) + ' ' + esc(r.unit) +
        (r.kg ? '<br><span style="font-size:.7rem;color:var(--text-muted,#888);">' +
          n1(r.kg) + ' kg</span>' : '') +
        (pr && pr.price ? '<br><span style="font-size:.72rem;">' + money(r.qty * pr.price) +
          '</span>' : '') + '</span></div>';
    });
    h += '<div class="bp-tot" style="border:none;font-weight:800;margin-top:6px;"><span>' +
      tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد') + '</span><span>' +
      n1(tot.kg) + ' kg \u00b7 ' + n2(tot.kg / 1000) + ' ' + tt('טון', 'ตัน', 'طن') + '</span></div>' +
      '<div class="bp-tot" style="border:none;font-weight:800;font-size:1rem;"><span>' +
      tt('עלות חומרים', 'ต้นทุนวัสดุ', 'تكلفة المواد') + '</span><span>' + money(tot.cost) + '</span></div>' +
      (tot.unpriced ? '<div style="font-size:.75rem;color:#e65100;">\u26a0\ufe0f ' + tot.unpriced +
        ' ' + tt('פריטים ללא מחיר בקטלוג', 'ไม่มีราคา', 'بدون سعر') + '</div>' : '') +
      '</div>';
    return h;
  }

  function siteTab(p) {
    var has = p.footprint && p.footprint.length >= 3;
    return '<div class="bp-card">' +
      (has ? '<div class="bp-tot"><span>' + tt('שטח מסומן', 'พื้นที่ที่วาด', 'المساحة المرسومة') +
        '</span><strong>' + n1(p.footprintArea) + ' \u05de"\u05e8 (' +
        n2(p.footprintArea / 1000) + ' ' + tt('דונם', 'ดูนัม', 'دونم') + ')</strong></div>' +
        '<div class="bp-tot" style="border:none;"><span>' + tt('נקודות', 'จุด', 'نقاط') +
        '</span><strong>' + p.footprint.length + '</strong></div>'
        : '<div class="bp-empty">' + tt('הפרויקט עדיין לא ממוקם על המפה.',
            'ยังไม่ได้กำหนดตำแหน่ง', 'لم يُحدَّد الموقع بعد') + '</div>') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' +
        '<button class="bp-btn" onclick="BuildPlan.placeFromDims(' + p.id + ')">\u2b1a ' +
          tt('מקם לפי המידות', 'วางตามขนาด', 'ضع حسب الأبعاد') +
          ' (' + n1(p.dims.span) + '\u00d7' + n1(p.dims.length) + ')</button>' +
        '<button class="bp-btn ghost" onclick="BuildPlan.startRect(' + p.id + ')">\u25ad ' +
          (has ? tt('ערוך / הזז / סובב', 'แก้ไข / ย้าย / หมุน', 'تحرير / نقل / تدوير')
               : tt('צייר מלבן', 'วาดสี่เหลี่ยม', 'ارسم مستطيلاً')) + '</button>' +
        (p.rect && p.rect.w > 0
          ? '<button class="bp-btn ghost" onclick="BuildPlan.dimsFromRect(' + p.id + ')">\u2b07 ' +
            tt('קח מידות מהמלבן', 'ใช้ขนาดจากรูป', 'خذ الأبعاد من المستطيل') + '</button>'
          : '') +
        '<button class="bp-btn ghost" onclick="BuildPlan.startFootprint(' + p.id + ')">\u2b20 ' +
          (has ? tt('סמן מחדש נקודה-נקודה', 'วาดทีละจุด', 'ارسم نقطة بنقطة')
               : tt('סמן נקודה-נקודה', 'วาดทีละจุด', 'ارسم نقطة بنقطة')) + '</button>' +
        (has ? '<button class="bp-btn ghost" onclick="BuildPlan.zoomTo(' + p.id + ')">\ud83d\udd0d ' +
          tt('הצג במפה', 'ดูบนแผนที่', 'عرض على الخريطة') + '</button>' +
          '<button class="bp-btn ghost" onclick="BuildPlan.useFootprint(' + p.id + ')">\u2b07 ' +
          tt('קח מידות מהשטח', 'ใช้ขนาดจากพื้นที่', 'استخدم أبعاد المساحة') + '</button>' : '') +
      '</div>' +
      (has ? '<div style="font-size:.75rem;color:var(--text-muted,#888);margin-top:8px;">' +
        tt('שטח שסומן על המפה גובר על המידות שהוקלדו בחישוב הבטון.',
           'พื้นที่จากแผนที่มีผลเหนือค่าที่พิมพ์', 'المساحة المرسومة تتقدم على المدخلة') + '</div>' : '') +
    '</div>' +
    '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:6px;">\ud83d\udd27 ' +
      tt('קישור לתחזוקה', 'เชื่อมกับซ่อมบำรุง', 'الربط بالصيانة') + '</div>' +
      '<div id="bpLink"></div></div>';
  }

  // ══════════════════════════════════════════════════════════════════
  //  MAINTENANCE LINK
  // ══════════════════════════════════════════════════════════════════
  // A shed is not a department of its own — it is a maintenance job that
  // happens to have a 3D model. The takeoff becomes the material lines of a
  // maintenance project, where markup, VAT, labour, shipping and invoicing
  // already work; buildplan does not reimplement any of that.
  function linkPanel(p) {
    var host = document.getElementById('bpLink');
    if (!host || typeof Maintenance === 'undefined') return;
    Maintenance.loadProjects().then(function (list) {
      var opts = '<option value="">' + tt('— בחר פרויקט תחזוקה —', '— เลือก —', '— اختر —') + '</option>';
      (list || []).forEach(function (mp) {
        opts += '<option value="' + mp.id + '"' + (p.maintId === mp.id ? ' selected' : '') + '>' +
          esc(mp.name) + (mp.client ? ' \u00b7 ' + esc(mp.client) : '') + '</option>';
      });
      var linked = p.maintId ? (list || []).filter(function (mp) { return mp.id === p.maintId; })[0] : null;
      host.innerHTML =
        (linked
          ? '<div class="bp-tot"><span>\ud83d\udd17 ' + tt('מקושר ל', 'เชื่อมกับ', 'مرتبط بـ') +
            '</span><strong>' + esc(linked.name) + '</strong></div>' +
            '<div class="bp-tot" style="border:none;"><span>' +
              tt('שורות חומרים בפרויקט', 'รายการวัสดุ', 'بنود المواد') + '</span><strong>' +
              ((linked.materials || []).length) + '</strong></div>'
          : '<div style="font-size:.82rem;color:var(--text-muted,#999);margin-bottom:6px;">' +
            tt('הפרויקט לא מקושר לפרויקט תחזוקה. הקישור מעביר את כתב הכמויות לתמחור, הזמנות וחשבוניות.',
               'ยังไม่เชื่อมกับโครงการซ่อมบำรุง', 'غير مرتبط بمشروع صيانة') + '</div>') +
        '<select class="bp-in" id="bpMaintSel" style="margin-bottom:6px;">' + opts + '</select>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button class="bp-btn" onclick="BuildPlan.pushToMaint(' + p.id + ')">\u2b06 ' +
            tt('העבר כתב כמויות', 'ส่งรายการวัสดุ', 'إرسال الكميات') + '</button>' +
          '<button class="bp-btn ghost" onclick="BuildPlan.newMaint(' + p.id + ')">\u2795 ' +
            tt('צור פרויקט תחזוקה', 'สร้างโครงการ', 'إنشاء مشروع') + '</button>' +
          (linked ? '<button class="bp-btn ghost" onclick="BuildPlan.openMaint(' + linked.id + ')">\ud83d\udd27 ' +
            tt('פתח בתחזוקה', 'เปิด', 'فتح') + '</button>' : '') +
        '</div>';
    });
  }

  // A print-safe illustration to travel with the quantities: theme
  // variables resolved to literal colours, because the quote opens in a
  // window with none of the app's CSS.
  function illustrationFor(p) {
    var parts = [];
    if (p.hasStruct !== false && p.type !== 'slab') parts.push(svg(p));
    else if (p.type === 'slab') parts.push(svg(p));
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
    return takeoff(p).map(function (r) {
      var pr = profByName(r.name);
      return { name: r.name, qty: n1(r.qty), unit: r.unit,
               price: pr ? pr.price : 0, note: r.note };
    });
  }

  function pushToMaint(id) {
    var p = projById(id);
    var sel = document.getElementById('bpMaintSel');
    if (!p || !sel) return;
    var mid = Number(sel.value) || 0;
    if (!mid) { toast('\u26a0\ufe0f ' + tt('בחר פרויקט תחזוקה', 'เลือกโครงการ', 'اختر مشروعاً')); return; }
    if (typeof Maintenance === 'undefined') {
      toast('\u26a0\ufe0f ' + tt('מודול התחזוקה לא נטען', 'โมดูลไม่พร้อม', 'الوحدة غير محمّلة'));
      return;
    }
    Maintenance.importTakeoff(mid, p.id, p.name, takeoffLines(p), illustrationFor(p))
      .then(function (okd) {
      if (!okd) { toast('\u26a0\ufe0f ' + tt('הפרויקט לא נמצא', 'ไม่พบ', 'غير موجود')); return; }
      p.maintId = mid;
      var opt = sel.options[sel.selectedIndex];
      p.maintName = opt ? opt.text : '';
      saveP();
      toast('\u2705 ' + tt('כתב הכמויות הועבר', 'ส่งแล้ว', 'تم الإرسال'));
      linkPanel(p);
    });
  }

  function newMaint(id) {
    var p = projById(id);
    if (!p || typeof Maintenance === 'undefined') return;
    Maintenance.createFromBuild(p.id, p.name, p.client, takeoffLines(p), illustrationFor(p))
      .then(function (mid) {
      p.maintId = mid;
      p.maintName = p.name;
      saveP();
      toast('\u2705 ' + tt('נוצר פרויקט תחזוקה', 'สร้างแล้ว', 'تم الإنشاء'));
      linkPanel(p);
    });
  }

  function openMaint(mid) {
    if (typeof Maintenance === 'undefined') return;
    close();
    Maintenance.showDetail(mid);
  }

  function zoomTo(id) {
    var p = projById(id), m = map();
    if (!p || !m || p.footprint.length < 3) return;
    if (window.MapAccess && MapAccess.goToMap) MapAccess.goToMap(); else close();
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
    var p = projById(id);
    if (!p || !(p.footprintArea > 0)) return;
    var ratio = p.dims.length / Math.max(p.dims.span, 0.01);
    p.dims.span = Math.sqrt(p.footprintArea / ratio);
    p.dims.length = p.dims.span * ratio;
    saveP();
    toast('\u2705 ' + n1(p.dims.span) + ' \u00d7 ' + n1(p.dims.length) + ' m');
    open(id);
  }

  function _set(id, k, v) { var p = projById(id); if (p) p[k] = v; }

  // Component inclusion changes what the whole takeoff means, so it saves
  // and repaints rather than being nudged in place.
  function _comp(id, k, v) {
    var p = projById(id);
    if (!p) return;
    p[k] = !!v;
    saveP();
    open(id);
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
    var p = projById(id);
    if (!p) return;
    p.dims[k] = Number(v) || 0;
    var nEl = document.getElementById('n_' + k), rEl = document.getElementById('r_' + k),
        vEl = document.getElementById('v_' + k);
    if (nEl && nEl.value !== String(v)) nEl.value = v;
    if (rEl && rEl.value !== String(v)) rEl.value = v;
    if (vEl) vEl.textContent = v;
    if (_v3d) _v3d.nudge(model3d(p));
    refreshReadouts(p);
    // Persist on a trailing timer, independent of the `change` event.
    if (_liveSave) clearTimeout(_liveSave);
    _liveSave = setTimeout(function () { saveP(); }, 700);
  }
  var _liveSave = null;

  // Release: persist, and repaint once so anything structural (new controls
  // appearing, the takeoff, the callouts) catches up.
  // Releasing a slider used to repaint the entire sheet, which tore down and
  // rebuilt the canvas — that flash IS the jump. A number never changes
  // which controls exist, so nothing needs re-rendering: save it, and patch
  // the handful of places that display derived values.
  function _commit(id, k, v) {
    var p = projById(id);
    if (!p) return;
    p.dims[k] = Number(v) || 0;
    if (_liveSave) { clearTimeout(_liveSave); _liveSave = null; }
    saveP();
    refreshDerived(p);
  }

  // Everything on the design tab that is computed rather than typed.
  // Updated in place so the DOM the user is touching is never replaced.
  function refreshDerived(p) {
    refreshReadouts(p);
    legendPanel(p);
    if (_v3d) {
      var g = _v3d.isHidden ? null : null;
      void g;
    }
    // the bay-fit warning
    var warn = document.getElementById('bpBayWarn');
    if (warn && p.type !== 'slab') {
      var gg = geom(p.dims);
      warn.innerHTML = (Math.abs(gg.actualBay - p.dims.bay) > 0.05)
        ? '\u26a0\ufe0f ' + tt('המרווח הותאם ל-', 'ปรับระยะเป็น ', 'تم ضبط التباعد إلى ') +
          n1(gg.actualBay) + ' m ' +
          tt('כדי לחלק את האורך שווה בשווה', 'เพื่อแบ่งเท่ากัน', 'لتقسيم متساوٍ')
        : '';
    }
    // the foundation summary
    var fo = document.getElementById('bpFound');
    if (fo && p.type !== 'slab') fo.innerHTML = footingSummary(p);
    // utilisation in an open swap panel
    if (_v3d && _swapRole) swapPanel(_swapRole);
  }

  function footingSummary(p) {
    var d = p.dims, ft = footing(d), con = concrete(p);
    return '<div class="bp-tot"><span>' +
        tt('שטח משפיע לעמוד', 'พื้นที่รับต่อเสา', 'المساحة لكل عمود') + '</span><strong>' +
        n1(ft.trib) + ' \u05de"\u05e8 \u00b7 ' + n1(ft.axial) + ' kN</strong></div>' +
      '<div class="bp-tot"><span>' + tt('צלע נדרשת', 'ด้านที่ต้องการ', 'الضلع المطلوب') +
        '</span><strong style="color:' + (ft.ok ? 'var(--primary,#2d6a4f)' : '#e65100') + ';">' +
        n2(ft.reqSide) + ' \u05de\' ' + (ft.ok ? '\u2713' : '\u2014 ' +
        tt('הגדל ל-', 'เพิ่มเป็น', 'زد إلى') + ' ' + ft.suggest) + '</strong></div>' +
      '<div class="bp-tot" style="border:none;"><span>' + tt('בטון', 'คอนกรีต', 'خرسانة') +
        '</span><strong>' + n2(con.slab) + ' + ' + n2(con.footings) + ' = ' +
        n2(con.total) + ' \u05de"\u05e7</strong></div>';
  }

  // The numbers that answer "did the rafter actually get longer when I
  // widened the span". Written straight into the DOM on every drag frame.
  function refreshReadouts(p) {
    var host = document.getElementById('bpRead');
    if (!host) return;
    var d = p.dims;
    if (p.type === 'slab') {
      var a = slabArea(p);
      host.innerHTML =
        row(tt('שטח', 'พื้นที่', 'المساحة'), n1(a) + ' \u05de"\u05e8') +
        row(tt('בטון', 'คอนกรีต', 'خرسانة'), n2(a*d.slabTh) + ' \u05de"\u05e7');
      return;
    }
    var g = geom(d), ft = footing(d), con = concrete(p);
    var rows = takeoff(p), tot = takeoffTotals(rows);
    host.innerHTML =
      row(tt('אורך קורת גג', 'ความยาวคาน', 'طول الرافدة'), n2(g.rafterLen) + ' m') +
      row(tt('גובה רכס', 'สูงสัน', 'ارتفاع القمة'), n2(g.ridgeH) + ' m') +
      row(tt('מסגרות', 'เฟรม', 'إطارات'), g.frames + ' @ ' + n2(g.actualBay) + ' m') +
      row(tt('עמוד יחיד', 'เสาเดี่ยว', 'عمود واحد'), n2(d.eaves) + ' m \u00d7 ' + (g.frames*2)) +
      row(tt('שורות מרישים', 'แถวแป', 'صفوف المرايش'), (g.purlinRuns*2) + ' \u00d7 ' + n1(d.length) + ' m') +
      row(tt('שטח גג', 'พื้นที่หลังคา', 'مساحة السقف'), n1(g.roofArea) + ' \u05de"\u05e8') +
      row(tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد'), n2(tot.kg/1000) + ' ' + tt('טון','ตัน','طن')) +
      row(tt('בטון כולל', 'คอนกรีตรวม', 'إجمالي الخرسانة'), n2(con.total) + ' \u05de"\u05e7') +
      row(tt('צלע בסיס נדרשת', 'ด้านฐาน', 'ضلع القاعدة'),
        n2(ft.reqSide) + ' m ' + (ft.ok ? '\u2713' : '\u26a0\ufe0f')) +
      row(tt('עלות חומרים', 'ต้นทุน', 'التكلفة'), money(tot.cost));
  }
  function row(k, v) {
    return '<div class="bp-read"><span>' + k + '</span><b>' + v + '</b></div>';
  }


  function _dim(id, k, v) {
    var p = projById(id);
    if (!p) return;
    p.dims[k] = BOOL[k] ? !!v : TEXT[k] ? String(v) : (Number(v) || 0);
    var TOPO = { skylights: 1, leanTo: 1, mezz: 1 };
    if (BOOL[k] || TEXT[k] || TOPO[k]) { saveP(); open(id); return; }
    if (_v3d) _v3d.update(model3d(p));
    // Numbers still have to reach the readouts, but only once the user
    // pauses — otherwise every keystroke rewrites the DOM under the cursor.
    if (_num) clearTimeout(_num);
    _num = setTimeout(function () { saveP(); open(id); }, 550);
  }
  function saveNow() {
    saveP();
    toast('\u2705 ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ'));
  }

  // ── catalogue ──
  function openCatalog() {
    var groups = {};
    (C.profiles || []).forEach(function (p) { (groups[p.group] = groups[p.group] || []).push(p); });
    var body = '';
    Object.keys(groups).forEach(function (g) {
      var rows = '';
      groups[g].forEach(function (x) {
        rows += '<div style="display:grid;grid-template-columns:1.6fr .7fr .6fr .8fr 32px;gap:5px;margin-bottom:5px;">' +
          '<input class="bp-in" value="' + esc(x.name) + '" ' +
            'oninput="BuildPlan._prof(' + x.id + ',\'name\',this.value)">' +
          '<input class="bp-in" type="number" step="any" value="' + (x.kgPerM || '') + '" ' +
            'placeholder="kg/m" oninput="BuildPlan._prof(' + x.id + ',\'kgPerM\',this.value)">' +
          '<input class="bp-in" value="' + esc(x.unit) + '" ' +
            'oninput="BuildPlan._prof(' + x.id + ',\'unit\',this.value)">' +
          '<input class="bp-in" type="number" step="any" value="' + (x.price || '') + '" ' +
            'placeholder="\u20aa" oninput="BuildPlan._prof(' + x.id + ',\'price\',this.value)">' +
          '<button class="bp-btn warn" style="padding:5px 7px;" ' +
            'onclick="BuildPlan._delProf(' + x.id + ')">\u2715</button></div>';
      });
      body += '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:6px;">' + esc(dsp(g)) +
        '</div>' + rows +
        '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.78rem;" ' +
          'onclick="BuildPlan._addProf(\'' + esc(g) + '\')">\u2795</button></div>';
    });
    var bar = '<button class="bp-btn" onclick="BuildPlan._saveCat()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';
    paint(shell('\ud83d\udcd0 ' + tt('קטלוג פרופילים', 'แคตตาล็อกโปรไฟล์', 'كتالوج المقاطع'),
      bar, priceHeader() + body));
  }
  function _prof(pid, k, v) {
    (C.profiles || []).forEach(function (x) {
      if (x.id === pid) x[k] = (k === 'kgPerM' || k === 'price') ? (Number(v) || 0) : v;
    });
  }
  function _addProf(g) {
    C.profiles.push({ id: uid() + Math.random(), group: g, name: '', kgPerM: 0, unit: "מ'", price: 0 });
    openCatalog();
  }
  function _delProf(pid) {
    C.profiles = (C.profiles || []).filter(function (x) { return x.id !== pid; });
    saveC();
    openCatalog();
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
    if (!(v > 0)) { toast('\u26a0\ufe0f ' + tt('הזן מחיר לק"ג', 'ใส่ราคา/กก.', 'أدخل السعر/كغ')); return; }
    var n = 0;
    (C.profiles || []).forEach(function (pr) {
      if (pr.kgPerM > 0 && pr.unit === "מ'") { pr.price = Math.round(pr.kgPerM * v * 100) / 100; n++; }
    });
    C.steelPerKg = v;
    C.pricedAt = Date.now();
    saveC();
    toast('\u2705 ' + n + ' ' + tt('פרופילים תומחרו', 'โปรไฟล์ตั้งราคาแล้ว', 'مقاطع تم تسعيرها'));
    openCatalog();
  }

  function priceHeader() {
    var when = C.pricedAt ? new Date(C.pricedAt).toLocaleDateString('he-IL') : '\u2014';
    return '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\u2696\ufe0f ' +
        tt('תמחור פלדה לפי משקל', 'ราคาเหล็กตามน้ำหนัก', 'تسعير الحديد بالوزن') + '</div>' +
      '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
        '<input class="bp-in" id="bpKgPrice" type="number" step="0.1" style="width:110px;" ' +
          'value="' + (C.steelPerKg || '') + '" placeholder="\u20aa/kg">' +
        '<button class="bp-btn" onclick="BuildPlan.applySteelPrice()">' +
          tt('עדכן את כל הפרופילים', 'อัปเดตทั้งหมด', 'تحديث الكل') + '</button>' +
        '<span style="font-size:.74rem;color:var(--text-muted,#888);">' +
          tt('עודכן', 'อัปเดต', 'حُدّث') + ': ' + when + '</span>' +
      '</div>' +
      '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:8px;line-height:1.6;">' +
        tt('אין הזנת מחירים אוטומטית לפלדה בישראל — האתרים שנראים כמו מחירון הם תוכן שיווקי שמצטט מחירים סותרים. עדכנו מהצעת מחיר אמיתית. מקורות שימושיים:',
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
    saveC();
    toast('\u2705 ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ'));
    openCatalog();
  }

  // ── outputs ──
  // Read-only feeds for maintenance, so the pull direction does not require
  // maintenance to know anything about how a build project is stored.
  function listForImport() {
    return loadAll().then(function () {
      return (P.projects || []).map(function (p) {
        var rows = takeoff(p), tot = takeoffTotals(rows);
        return { id: p.id, name: p.name || typeLabel(p.type),
                 lines: rows.length, cost: tot.cost };
      });
    });
  }

  function exportForQuote(id) {
    return loadAll().then(function () {
      var p = projById(id);
      if (!p) return null;
      return { id: p.id, name: p.name || typeLabel(p.type), client: p.client || '',
               lines: takeoffLines(p), illustration: illustrationFor(p) };
    });
  }

  function toOrder(id) {
    var p = projById(id);
    if (!p) return;
    if (typeof Orders === 'undefined') {
      toast('\u26a0\ufe0f ' + tt('מודול ההזמנות לא נטען', 'โมดูลไม่พร้อม', 'الوحدة غير محمّلة'));
      return;
    }
    saveP();
    Orders.draftFrom({
      title: (p.name || typeLabel(p.type)),
      source: 'buildplan',
      ref: tt('פרויקט', 'โครงการ', 'مشروع') + ' #' + p.id,
      lines: takeoff(p).map(function (r) {
        return { name: r.name, qty: n1(r.qty), unit: r.unit, note: r.note };
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
      st.push([tt('עבודות עפר ומצע', 'งานดินและฐาน', 'أعمال الحفر والأساس'),
        tt('חישוף, פילוס, מצע מהודק בשכבות 20 ס"מ. בדיקת ניקוז — משטח שאוסף מים ייסדק.',
           'ปรับพื้นและบดอัด', 'تسوية ودك')]);
      st.push([tt('יציקת משטח', 'เทพื้น', 'صب السطح'),
        tt('רשת מרותכת על ספסרים, עובי ' + n1(d.slabTh) + ' מ\'. תפרי התפשטות כל 5-6 מ\'. ' +
           'אשפרה 7 ימים לפחות.', 'เทพื้นและบ่ม', 'الصب والمعالجة')]);
    }

    // Gate on the COMPONENT, not on p.type. p.type only says what shape a
    // structure would be if there were one — it stays 'shed' on a project
    // that contains nothing but a gate, which is why a gate document was
    // printing "erect 5 frames" and "install the panel roof".
    if (p.hasStruct !== false && (p.type === 'shed' || p.type === 'house')) {
      var g = geom(d), ft = footing(d);
      st.push([tt('סימון ויסודות', 'ทำเครื่องหมายและฐานราก', 'التخطيط والأساسات'),
        tt('סימון ' + g.frames + ' מסגרות במרווח ' + n1(g.actualBay) + ' מ\'. ' +
           (d.footings ? 'חפירת ' + (g.frames*2) + ' בסיסים ' + n1(d.footW) + '\u00d7' +
             n1(d.footW) + '\u00d7' + n1(d.footD) + ' מ\'. ' : '') +
           'לוודא אלכסונים שווים לפני היציקה — מסגרת לא מרובעת לא תתאסף.',
           'ตรวจสอบมุมฉาก', 'التأكد من التعامد')]);
      st.push([tt('עוגנים ויציקה', 'สมอและเท', 'المراسي والصب'),
        tt('בורגי עיגון בתבנית לפי פלטת הבסיס, לא לאחר היציקה. אשפרה 7 ימים לפני העמסת שלד.',
           'สมอก่อนเท', 'المراسي قبل الصب')]);
      st.push([tt('הקמת שלד', 'ประกอบโครง', 'تركيب الهيكل'),
        tt('הרכבת מסגרות, ' + (d.bracing ? 'אלכסוני ייצוב בשתי מפתחות הקצה, ' : '') +
           'מרישים ומסילות. יישור וחיזוק סופי לפני החיפוי.',
           'ประกอบและปรับ', 'التركيب والضبط')]);
      if (d.roofClad !== 'none') {
        st.push([tt('חיפוי גג', 'มุงหลังคา', 'تغطية السقف'),
          tt('התקנת ' + dsp(d.roofClad) + ' מהצד המוגן מהרוח כלפי הרוח, חפיפה לפי היצרן. ' +
             (d.gutter ? 'מרזבים וניקוז לפני הקירות.' : ''),
             'มุงตามทิศลม', 'التغطية حسب اتجاه الريح')]);
      }
      if (d.wallMode !== 'open' && d.wallClad !== 'none') {
        st.push([tt('חיפוי קירות', 'ติดผนัง', 'تغطية الجدران'),
          tt('התקנת ' + dsp(d.wallClad) + ', פתחים לחלונות ולשער לפי התוכנית.',
             'ติดตั้งผนัง', 'تركيب الجدران')]);
      }
    }

    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (gt, i) {
        Gates.stages(gt).forEach(function (row) {
          st.push([(gt.name || (tt('שער','ประตู','بوابة') + ' ' + (i+1))) + ' \u00b7 ' + row[0], row[1]]);
        });
      });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      LivingUnit.stages(p.living).forEach(function (row) {
        st.push([tt('מגורים','ที่พัก','سكن') + ' \u00b7 ' + row[0], row[1]]);
      });
    }

    if (!st.length) return '';
    var rows = st.map(function (r, i) {
      return '<tr><td style="width:26px;text-align:center;font-weight:800;">' + (i+1) + '</td>' +
        '<td style="width:210px;font-weight:700;">' + esc(r[0]) + '</td>' +
        '<td>' + esc(r[1]) + '</td>' +
        '<td style="width:70px;"></td></tr>';
    }).join('');

    return '<div style="page-break-before:always;"></div>' +
      '<h2>\ud83d\udccb ' + tt('שלבי עבודה והכנות', 'ขั้นตอนงาน', 'مراحل العمل') + '</h2>' +
      '<p style="font-size:.8rem;color:#555;">' +
        tt('הסדר הוא סדר תלות, לא סדר מקצועות. רוב התקלות היקרות בעבודות האלה הן תקלות רצף.',
           'ลำดับตามการพึ่งพา', 'الترتيب حسب التبعية') + '</p>' +
      '<table><thead><tr><th>#</th><th>' + tt('שלב', 'ขั้นตอน', 'المرحلة') + '</th><th>' +
        tt('הכנות ודגשים', 'การเตรียมและข้อควรระวัง', 'التحضير والملاحظات') + '</th><th>' +
        tt('בוצע', 'เสร็จ', 'تم') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // Print colours hardcoded — the sheet opens in a bare tab with no theme.
  // What this document is about, in the project's own terms. Printing
  // "סככה / מבנה קל · 10 × 20 m, 5 מסגרות" at the top of a gate document
  // is the header contradicting every page under it.
  function contentsLabel(p) {
    var parts = [];
    if (p.hasStruct !== false && p.type !== 'slab') parts.push(typeLabel(p.type));
    if (p.type === 'slab' || (p.hasSlab !== false && p.hasStruct === false)) {
      parts.push(tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني'));
    }
    if ((p.gates || []).length) {
      parts.push((p.gates.length > 1 ? p.gates.length + ' ' : '') +
        tt('שערים', 'ประตู', 'بوابات'));
    }
    if (p.living && p.living.people) {
      parts.push(tt('מתחם מגורים', 'ที่พัก', 'مجمع سكني') + ' ' + p.living.people);
    }
    return parts.length ? parts.join(' + ') : typeLabel(p.type);
  }

  // opts.stages === false prints the quantities alone. The work-stages
  // sheet is for whoever is building it; a supplier pricing the steel does
  // not need to be told when to pour, and sending it invites questions
  // about scope that have nothing to do with the price.
  function printProject(id, opts) {
    opts = opts || {};
    var p = projById(id);
    if (!p) return;
    var rows = takeoff(p), tot = takeoffTotals(rows);
    var g = (p.type === 'slab' || p.hasStruct === false) ? null : geom(p.dims);
    var body = '';
    rows.forEach(function (r, i) {
      var pr = profByName(r.name);
      body += '<tr><td>' + (i + 1) + '</td><td>' + esc(dsp(r.name)) + '</td><td>' + n1(r.qty) +
        '</td><td>' + esc(dsp(r.unit)) + '</td><td>' + (r.kg ? n1(r.kg) : '\u2014') + '</td>' +
        '<td>' + (pr && pr.price ? money(pr.price) : '\u2014') + '</td>' +
        '<td>' + (pr && pr.price ? money(r.qty * pr.price) : '\u2014') + '</td>' +
        '<td>' + esc(r.note) + '</td></tr>';
    });
    // Component drawings, printed at the size they are read at. A bill of
    // quantities without a drawing is a list of numbers nobody can check.
    var extra = '';
    if (typeof Gates !== 'undefined') {
      (p.gates || []).forEach(function (g, i) {
        extra += '<h2>\ud83d\udea7 ' + esc(g.name || (tt('שער','ประตู','بوابة') + ' ' + (i+1))) +
          ' \u2014 ' + esc(Gates.typeLabel(g.type)) + '</h2>' +
          '<div class="bp-draw">' + Gates.svg(g, { print: true }) + '</div>';
      });
    }
    if (typeof LivingUnit !== 'undefined' && p.living && p.living.people) {
      extra += '<h2>\ud83c\udfe0 ' + tt('מתחם מגורים', 'ที่พัก', 'مجمع سكني') + ' \u2014 ' +
        p.living.people + ' ' + tt('אנשים', 'คน', 'أشخاص') + '</h2>' +
        '<div class="bp-draw">' + LivingUnit.svg(p.living, { print: true }) + '</div>';
    }

    // Only draw the structure if there is one. A gate-only project was
    // leading its document with a 20x10 shed elevation and plan.
    var drawing = (p.hasStruct === false && p.type !== 'slab') ? '' : svg(p)
      .replace(/var\(--primary,#2d6a4f\)/g, '#2d6a4f')
      .replace(/var\(--accent,#ff9f43\)/g, '#e07b00')
      .replace(/var\(--water,#4fc3f7\)/g, '#1565c0')
      .replace(/var\(--text-muted,#[0-9a-f]+\)/g, '#777')
      .replace(/var\(--text,#[0-9a-f]+\)/g, '#222');

    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc(p.name) + '</title><style>' +
      'body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#222;background:#fff;padding:22px;}' +
      'h1{font-size:1.25rem;margin:0 0 4px;}h2{font-size:1rem;margin:16px 0 6px;}' +
      '.meta{font-size:.84rem;color:#555;line-height:1.7;}' +
      '.bp-draw{background:#f4f6f4;border:1px solid #ddd;border-radius:8px;padding:10px;margin:10px 0;}' +
      'table{width:100%;border-collapse:collapse;margin-top:8px;}' +
      'th,td{border:1px solid #bbb;padding:5px 7px;font-size:.78rem;text-align:right;}' +
      'th{background:#eef3ee;font-weight:800;}tfoot td{font-weight:800;background:#f7f9f7;}' +
      '</style></head><body>' +
      '<h1>' + esc(p.name || typeLabel(p.type)) + '</h1>' +
      '<div class="meta">' + contentsLabel(p) +
        (p.client ? ' \u00b7 ' + esc(p.client) : '') +
        (g ? '<br>' + n1(p.dims.span) + ' \u00d7 ' + n1(p.dims.length) + ' m, ' +
             tt('גובה', 'สูง', 'ارتفاع') + ' ' + n1(p.dims.eaves) + ' m, ' +
             tt('שיפוע', 'ชัน', 'ميل') + ' ' + n1(p.dims.pitch) + '\u00b0, ' +
             g.frames + ' ' + tt('מסגרות', 'เฟรม', 'إطارات') + ' @ ' + n1(g.actualBay) + ' m'
           : '<br>' + n1(slabArea(p)) + ' \u05de"\u05e8 \u00d7 ' + p.dims.slabTh + ' \u05de\'') +
        (p.footprintArea > 0 ? '<br>' + tt('שטח מסומן במפה', 'พื้นที่จากแผนที่', 'المساحة المرسومة') +
          ': ' + n1(p.footprintArea) + ' \u05de"\u05e8' : '') +
      '</div>' + drawing +
      extra +
      '<h2>' + tt('כתב כמויות', 'รายการวัสดุ', 'جدول الكميات') + '</h2>' +
      '<table><thead><tr><th>#</th><th>' + tt('פריט', 'รายการ', 'صنف') + '</th><th>' +
        tt('כמות', 'จำนวน', 'كمية') + '</th><th>' + tt('יחידה', 'หน่วย', 'وحدة') + '</th><th>' +
        tt('משקל', 'น้ำหนัก', 'وزن') + '</th><th>' + tt('מחיר', 'ราคา', 'سعر') + '</th><th>' +
        tt('סה"כ', 'รวม', 'مجموع') + '</th><th>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</th></tr></thead>' +
      '<tbody>' + body + '</tbody><tfoot><tr><td colspan="4">' +
        tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد') + '</td><td>' + n1(tot.kg) + ' kg</td>' +
        '<td>' + tt('סה"כ', 'รวม', 'مجموع') + '</td><td colspan="2">' + money(tot.cost) +
        '</td></tr></tfoot></table>' +
      (opts.stages === false ? '' : workStages(p)) +
      '<p style="margin-top:20px;font-size:.8rem;">\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD</p>' +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, (p.name || 'project').replace(/\s+/g, '_') +
        (opts.stages === false ? '_' + tt('כתב_כמויות', 'รายการวัสดุ', 'الكميات') : '') + '.html');
    }
  }

  // Footprints should be visible on the map without opening the module.
  // Login happens well after load, so this waits for a manager session and
  // a live map instead of testing once and giving up.
  var _booted = false;
  function boot() {
    if (_booted) return true;
    if (!isManager()) return false;
    if (!(window.MapAccess && MapAccess.getMap && MapAccess.getMap())) return false;
    if (!window.L) return false;
    _booted = true;
    loadAll().then(function () { listen(); drawFootprints(); }).catch(function () {});
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
  window.addEventListener('focus', function () { if (_booted) drawFootprints(); });

  return {
    open: openModule,
    openProject: open,
    card: card,
    pushToMaint: pushToMaint,
    newMaint: newMaint,
    openMaint: openMaint,
    backToMaint: function () { close(); if (typeof Maintenance !== 'undefined') Maintenance.showProjectsList(); },
    close: close,
    render: render,
    newProject: newProject,
    delProject: delProject,
    setTab: setTab,
    _comp: _comp,
    _live: _live,
    _commit: _commit,
    toggleLayer: toggleLayer,
    pickMember: pickMember,
    addGate: addGate, delGate: delGate, setGate: setGate,
    addLiving: addLiving, delLiving: delLiving, setLiving: setLiving,
    skTool: skTool, skOrtho: skOrtho, skUndo: skUndo, skRedo: skRedo,
    skFit: skFit, skDel: skDel, skScale: skScale, skRotate: skRotate,
    skSeg: skSeg, skRadius: skRadius,
    swapTo: swapTo,
    closeSwap: closeSwap,
    checkMember: checkMember,
    layersAll: layersAll,
    layersFrame: layersFrame,
    applyModel: applyModel,
    view3d: view3d,
    resetView: resetView,
    sun: sun,
    openCatalog: openCatalog,
    startFootprint: startFootprint,
    startRect: startRect,
    placeFromDims: placeFromDims,
    dimsFromRect: dimsFromRect,
    geApply: geApply,
    geRot: geRot,
    geRedraw: geRedraw,
    geSave: geSave,
    geCancel: geCancel,
    finishFootprint: finishFootprint,
    cancelFootprint: cancelFootprint,
    undoPoint: undoPoint,
    addSegment: addSegment,
    exactRect: exactRect,
    zoomTo: zoomTo,
    useFootprint: useFootprint,
    printProject: printProject,
    printQuantities: function (id) { printProject(id, { stages: false }); },
    toOrder: toOrder,
    listForImport: listForImport,
    exportForQuote: exportForQuote,
    saveNow: saveNow,
    takeoff: takeoff,
    geom: geom,
    _set: _set,
    _comp: _comp,
    _dim: _dim,
    _prof: _prof,
    _addProf: _addProf,
    _delProf: _delProf,
    _saveCat: _saveCat,
    applySteelPrice: applySteelPrice
  };
})();
