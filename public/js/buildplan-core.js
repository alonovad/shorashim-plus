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

/* buildplan-core.js — constants, catalogue, engineering checks, i18n, persistence
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

var BuildPlan = window.BuildPlan || {};
var BuildPlanInternals = window.BuildPlanInternals || {};
window.BuildPlan = BuildPlan;
window.BuildPlanInternals = BuildPlanInternals;

(function (BP) {
  'use strict';
  'use strict';
  var PROJ_KEY = 'shorashim-build-projects';
  var CAT_KEY  = 'shorashim-build-catalog';

  BP.P = { projects: [] };
  BP.C = { profiles: [] };
  var _lastP = '', _lastC = '';
  // Timestamp of our own last write. Any listener callback within the
  // window below is our echo, whatever the serialisation looks like.
  var _selfWriteAt = 0;
  var SELF_WRITE_MS = 2500;
  var _listening = false;
  BP._open = null;          // project id being edited
  BP._tab = 'design';       // design | materials | site
  BP._layer = null;         // Leaflet layer group for footprints
  BP._draw = null;          // { id, pts[], markers[], line }

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
    'RHS 100x100x4':  { wy: 44.3, ar: 14.9, iz: 3.90 },
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
  BP.checkMember = function checkMember(role, name, d) {
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
    var g = BP.geom(d);
    var M = 0, span = 0, w = 0, util = 0, why = '';

    if (role === 'rafter') {
      span = g.rafterLen;
      w = d.roofLoad * g.actualBay;                 // kN/m along the rafter
      M = w * span * span / 10;                     // kNm, portal continuity
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = BP.tt('כפיפה', 'การดัด', 'انحناء');
    } else if (role === 'purlin') {
      span = g.actualBay;
      w = d.roofLoad * d.purlinSp;
      M = w * span * span / 8;
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = BP.tt('כפיפה', 'การดัด', 'انحناء');
    } else if (role === 'girt') {
      span = g.actualBay;
      w = WIND * d.girtSp;
      M = w * span * span / 8;
      util = (M * 1e6) / (sc.wy * 1e3 * F_ALLOW);
      why = BP.tt('רוח', 'ลม', 'رياح');
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
      why = BP.tt('לחיצה+כפיפה', 'อัด+ดัด', 'ضغط+انحناء') + ' \u03bb=' + Math.round(lam);
    } else return { known: false };

    if (!isFinite(util)) return { known: false };
    return { known: true, util: util, ok: util <= 1,
             span: span, M: M, why: why, wy: sc.wy, kg: (BP.profByName(name) || {}).kgPerM || 0 };
  };

  // Which catalogue sections can do this job? Sorted lightest-first, since
  // the cheapest adequate section is almost always the right answer.
  BP.candidates = function candidates(role, d) {
    var group = (role === 'purlin' || role === 'girt') ? 'מרישים' : 'עמודים / קורות';
    var out = [];
    (BP.C.profiles || []).forEach(function (pr) {
      if (pr.group !== group) return;
      var r = BP.checkMember(role, pr.name, d);
      if (!r.known) return;
      out.push({ name: pr.name, util: r.util, ok: r.ok, kg: pr.kgPerM,
                 price: pr.price, why: r.why });
    });
    out.sort(function (a, b) { return a.kg - b.kg; });
    return out;
  };

  BP.ROLE_KEY = { column: 'colProfile', rafter: 'rafterProfile',
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
    'ברזל זיון 8 מ"מ': 2.94,    // per m — 7.43 ₪/kg on nominal mass
    'ברזל זיון 10 מ"מ': 4.58,
    'ברזל זיון 12 מ"מ': 6.6,    // per m
    'ברזל זיון 14 מ"מ': 8.98,
    'ברזל זיון 16 מ"מ': 11.73,
    'ברזל זיון 20 מ"מ': 18.33,
    // A #Ø10@15 mat runs ~8.2 kg/m² both ways, tied on site.
    'רשת ברזל מצולע': 62,       // per m"ר
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
    // Every stocked diameter, so a cage specified in the drawing has
    // somewhere to price from. Masses are 0.006165·d², which is where the
    // 0.888 for Ø12 came from in the first place.
    { g: 'בטון',          n: 'ברזל זיון 8 מ"מ',  kg: 0.395, u: "מ'" },
    { g: 'בטון',          n: 'ברזל זיון 10 מ"מ', kg: 0.617, u: "מ'" },
    { g: 'בטון',          n: 'ברזל זיון 12 מ"מ', kg: 0.888, u: "מ'" },
    { g: 'בטון',          n: 'ברזל זיון 14 מ"מ', kg: 1.208, u: "מ'" },
    { g: 'בטון',          n: 'ברזל זיון 16 מ"מ', kg: 1.578, u: "מ'" },
    { g: 'בטון',          n: 'ברזל זיון 20 מ"מ', kg: 2.466, u: "מ'" },
    { g: 'בטון',          n: 'רשת ברזל מצולע', kg: 8.2, u: 'מ"ר' },
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
  BP.MODELS = {
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
  BP.typeLabel = function typeLabel(v) {
    if (v === 'shed')  return BP.tt('סככה / מבנה קל', 'โรงเรือน', 'سقيفة');
    if (v === 'slab')  return BP.tt('משטח בטון / רמפה', 'พื้นคอนกรีต', 'سطح خرساني');
    if (v === 'house') return BP.tt('מבנה מגורים', 'บ้าน', 'مبنى سكني');
    return v;
  };

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
    'ברזל זיון 8 מ"מ':   ['เหล็กเส้น 8 มม.', 'حديد تسليح 8 مم'],
    'ברזל זיון 10 מ"מ':  ['เหล็กเส้น 10 มม.', 'حديد تسليح 10 مم'],
    'ברזל זיון 12 מ"מ':  ['เหล็กเส้น 12 มม.', 'حديد تسليح 12 مم'],
    'ברזל זיון 14 מ"מ':  ['เหล็กเส้น 14 มม.', 'حديد تسليح 14 مم'],
    'ברזל זיון 16 מ"מ':  ['เหล็กเส้น 16 มม.', 'حديد تسليح 16 مم'],
    'ברזל זיון 20 מ"מ':  ['เหล็กเส้น 20 มม.', 'حديد تسليح 20 مم'],
    'רשת ברזל מצולע':    ['ตะแกรงเหล็กข้ออ้อย', 'شبكة حديد مضلع'],
    'כלוב יסוד':         ['กรงฐานราก', 'قفص الأساس'],
    'מרבד תחתון':        ['ตะแกรงล่าง', 'شبكة سفلية'],
    'חישוקים':           ['ปลอกเหล็ก', 'أساور'],
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
  BP.dsp = function dsp(name) {
    var e = DICT[name];
    if (!e) return String(name == null ? '' : name);
    return BP.tt(name, e[0], e[1]);
  };

  // Index a ['he','th','ar'] label array by the active language.
  BP.pick = function pick(arr) {
    if (!arr || !arr.length) return '';
    return BP.tt(arr[0], arr[1] || arr[0], arr[2] || arr[0]);
  };

  // ── helpers ──
  BP.tt = function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  };
  BP.toast = function toast(m) { if (typeof showToast === 'function') showToast(m); };
  BP.esc = function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };
  BP.uid = function uid() { return Date.now() + Math.floor(Math.random() * 1000); };
  // Coarse pointer or a narrow viewport: treat as a phone for defaults.
  function isPhone() {
    return (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches) ||
           (window.innerWidth || 1024) < 820;
  }
  BP.isManager = function isManager() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  };
  BP.n1 = function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; };
  BP.n2 = function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; };
  BP.money = function money(x) {
    return '\u20aa' + (Math.round((Number(x) || 0) * 100) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

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
      sunEl: Number(d.sunEl) || 48,
      // What is inside the concrete. Normalised by rebar.js when it is
      // loaded; passed through untouched when it is not, so a project that
      // was saved with a cage never loses it to load order. Defaults match
      // what the takeoff already assumed (Q188 in slabs), so no existing
      // project reprices on this deploy.
      rebar: (typeof Rebar !== 'undefined') ? Rebar.norm(d.rebar) : (d.rebar || null)
    };
  }

  BP.normProject = function normProject(x) {
    x = x || {};
    return {
      id: x.id || BP.uid(),
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
  };

  function normCat(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = { profiles: [], steelPerKg: Number(s.steelPerKg) || 0,
                pricedAt: Number(s.pricedAt) || 0 };
    if (Array.isArray(s.profiles) && s.profiles.length) {
      out.profiles = s.profiles.map(function (p) {
        return {
          id: p.id || BP.uid(),
          group: String(p.group || ''),
          name: String(p.name || ''),
          kgPerM: Number(p.kgPerM) || 0,
          unit: String(p.unit || "מ'"),
          price: Number(p.price) || 0
        };
      });
      // A saved catalogue is only seeded once, on a fresh install. Every
      // product added to SEED afterwards would therefore be missing from
      // every existing install, and the takeoff would quote it at zero —
      // which is exactly what happened when the gate hardware was added.
      // Missing entries are appended at their seed price; anything already
      // in the catalogue is left completely alone, so an edited price is
      // never overwritten by a deploy.
      var have = {};
      out.profiles.forEach(function (p) { have[p.name] = 1; });
      SEED.forEach(function (s2) {
        if (have[s2.n]) return;
        out.profiles.push({ id: BP.uid() + Math.random(), group: s2.g, name: s2.n,
          kgPerM: s2.kg, unit: s2.u, price: seedPrice(s2.n, s2.kg, s2.u) });
      });
    } else {
      out.profiles = SEED.map(function (s2) {
        return { id: BP.uid() + Math.random(), group: s2.g, name: s2.n, kgPerM: s2.kg,
                 unit: s2.u, price: seedPrice(s2.n, s2.kg, s2.u) };
      });
      out.steelPerKg = STEEL_PER_KG;
      out.pricedAt = Date.now();
    }
    return out;
  }

  BP.loadAll = function loadAll() {
    return Promise.all([DB.loadAsync(PROJ_KEY), DB.loadAsync(CAT_KEY)]).then(function (r) {
      var d = r[0] || {};
      BP.P = { projects: Array.isArray(d.projects) ? d.projects.map(BP.normProject) : [] };
      BP.C = normCat(r[1]);
      return true;
    });
  };

  BP.listen = function listen() {
    if (_listening) return;
    _listening = true;
    DB.listen(PROJ_KEY, function (d) {
      if (JSON.stringify(d) === _lastP) return;
      if (Date.now() - _selfWriteAt < SELF_WRITE_MS) return;   // our own echo
      BP.P = { projects: (d && Array.isArray(d.projects)) ? d.projects.map(BP.normProject) : [] };
      BP.drawFootprints();
      if (BP.isOpen()) BP.repaint();
    });
    DB.listen(CAT_KEY, function (d) {
      if (JSON.stringify(d) === _lastC) return;
      if (Date.now() - _selfWriteAt < SELF_WRITE_MS) return;   // our own echo
      BP.C = normCat(d);
      if (BP.isOpen()) BP.repaint();
    });
  };

  BP.saveP = function saveP() {
    if (!BP.isManager()) { BP.toast('\u26d4 ' + BP.tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var clean = JSON.parse(JSON.stringify(BP.P));
    _lastP = JSON.stringify(clean);
    _selfWriteAt = Date.now();
    DB.save(PROJ_KEY, clean);
    BP.drawFootprints();
  };
  BP.saveC = function saveC() {
    if (!BP.isManager()) { BP.toast('\u26d4 ' + BP.tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var clean = JSON.parse(JSON.stringify(BP.C));
    _lastC = JSON.stringify(clean);
    _selfWriteAt = Date.now();
    DB.save(CAT_KEY, clean);
  };

  BP.projById = function projById(id) {
    var hit = null;
    (BP.P.projects || []).forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  };
  BP.profByName = function profByName(n) {
    var hit = null;
    (BP.C.profiles || []).forEach(function (p) { if (p.name === n) hit = p; });
    return hit;
  };


})(BuildPlanInternals);
