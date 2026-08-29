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
    { g: 'חיפוי',         n: 'איסכורית 5 גלים', kg: 0,  u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל מבודד 4 ס"מ', kg: 0, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'פאנל מבודד 5 ס"מ', kg: 0, u: 'מ"ר' },
    { g: 'חיפוי',         n: 'לוח סקיילייט', kg: 0,   u: 'מ"ר' },
    { g: 'בטון',          n: 'בטון ב-30',   kg: 0,   u: 'מ"ק' },
    { g: 'בטון',          n: 'רשת פלדה Q188', kg: 0,  u: "יח'" },
    { g: 'בטון',          n: 'ברזל זיון 12 מ"מ', kg: 0.888, u: "מ'" },
    { g: 'אביזרים',       n: 'פלטת בסיס', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'בורג עיגון', kg: 0, u: "יח'" },
    { g: 'אביזרים',       n: 'מרזב', kg: 0, u: "מ'" },
    { g: 'אביזרים',       n: 'צינור ניקוז', kg: 0, u: "יח'" }
  ];

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
      roofPanel:     String(d.roofPanel     || 'פאנל מבודד 5 ס"מ'),
      wallPanel:     String(d.wallPanel     || 'איסכורית 5 גלים'),
      walls:  d.walls === false ? false : true,
      gutter: d.gutter === false ? false : true
    };
  }

  function normProject(x) {
    x = x || {};
    return {
      id: x.id || uid(),
      name: String(x.name || ''),
      type: (x.type === 'slab' || x.type === 'house') ? x.type : 'shed',
      client: String(x.client || ''),
      status: String(x.status || 'planning'),
      notes: String(x.notes || ''),
      createdAt: Number(x.createdAt) || Date.now(),
      createdBy: String(x.createdBy || ''),
      dims: normDim(x.dims),
      // Footprint stored as {lat,lng} objects, never arrays — Firestore has
      // no nested-array type and silently mangles them.
      footprint: Array.isArray(x.footprint) ? x.footprint.map(function (pt) {
        return { lat: Number(pt.lat) || 0, lng: Number(pt.lng) || 0 };
      }) : [],
      footprintArea: Number(x.footprintArea) || 0,
      extras: Array.isArray(x.extras) ? x.extras.map(function (e) {
        return { name: String(e.name || ''), qty: Number(e.qty) || 0, unit: String(e.unit || "יח'") };
      }) : []
    };
  }

  function normCat(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = { profiles: [] };
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
        return { id: uid() + Math.random(), group: s2.g, name: s2.n, kgPerM: s2.kg, unit: s2.u, price: 0 };
      });
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
    var wallArea = d.walls ? (2 * d.length + 2 * d.span) * d.eaves + 2 * gable : 0;
    return {
      half: half, rise: rise, rafterLen: rafterLen, bays: bays, actualBay: actualBay,
      frames: frames, purlinRuns: purlinRuns, girtRows: girtRows,
      roofArea: roofArea, wallArea: wallArea, gable: gable,
      ridgeH: d.eaves + rise, footprint: d.span * d.length,
      perimeter: 2 * (d.span + d.length)
    };
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

    function push(name, qty, unit, note) {
      if (!(qty > 0)) return;
      var pr = profByName(name);
      var kg = (pr && pr.kgPerM && unit === "מ'") ? qty * pr.kgPerM : 0;
      out.push({ name: name, qty: qty, unit: unit, kg: kg, note: note || '' });
    }

    if (p.type === 'slab') {
      var a = slabArea(p);
      push('בטון ב-30', a * d.slabTh * w, 'מ"ק',
        n1(a) + ' מ"ר × ' + d.slabTh + ' מ\'');
      // Q188 sheets are 6×2.35 m; 10% is the standard lap allowance.
      push('רשת פלדה Q188', Math.ceil(a / (6 * 2.35) * 1.1), "יח'", tt('כולל חפיפה', 'รวมทาบ', 'شامل التداخل'));
      push('ברזל זיון 12 מ"מ', Math.sqrt(a) * 4 * 2 * w, "מ'", tt('היקף וחיזוקים', 'ขอบและเสริม', 'محيط وتقوية'));
      (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
      return out;
    }

    var g = geom(d);
    push(d.colProfile,    g.frames * 2 * d.eaves * w, "מ'",
      g.frames * 2 + ' ' + tt('עמודים', 'เสา', 'أعمدة') + ' × ' + n1(d.eaves) + ' מ\'');
    push(d.rafterProfile, g.frames * 2 * g.rafterLen * w, "מ'",
      g.frames * 2 + ' ' + tt('קורות', 'คาน', 'روافد') + ' × ' + n1(g.rafterLen) + ' מ\'');
    push(d.purlinProfile, g.purlinRuns * 2 * d.length * w, "מ'",
      (g.purlinRuns * 2) + ' ' + tt('שורות מרישים', 'แถวแป', 'صفوف') + ' × ' + n1(d.length) + ' מ\'');
    if (d.walls) {
      push(d.girtProfile, g.girtRows * g.perimeter * w, "מ'",
        g.girtRows + ' ' + tt('שורות', 'แถว', 'صفوف'));
    }
    push(d.roofPanel, g.roofArea * w, 'מ"ר', tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    if (d.walls) push(d.wallPanel, g.wallArea * w, 'מ"ר', tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    push('פלטת בסיס', g.frames * 2, "יח'", '');
    push('בורג עיגון', g.frames * 2 * 4, "יח'", tt('4 לעמוד', '4 ต่อเสา', '4 لكل عمود'));
    if (d.gutter) {
      push('מרזב', 2 * d.length, "מ'", '');
      push('צינור ניקוז', Math.max(2, Math.ceil(d.length / 12) * 2), "יח'", '');
    }
    // Foundation under the frame, always poured with a shed.
    var fa = slabArea(p);
    push('בטון ב-30', fa * d.slabTh * w, 'מ"ק', tt('רצפה', 'พื้น', 'أرضية'));
    push('רשת פלדה Q188', Math.ceil(fa / (6 * 2.35) * 1.1), "יח'", tt('רצפה', 'พื้น', 'أرضية'));
    (p.extras || []).forEach(function (e) { push(e.name, e.qty, e.unit, ''); });
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
    if (d.walls) {
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
    var L = d.length, S = d.span;
    if (p.footprintArea > 0) {
      // Keep the drawn proportion but scale it to the measured area, so the
      // sketch matches the polygon rather than the unused typed rectangle.
      var k = Math.sqrt(a / Math.max(L * S, 0.01));
      L = L * k; S = S * k;
    }
    var s = Math.min((W - pad * 2) / L, (H - pad * 2) / S);
    var x0 = (W - L * s) / 2, y0 = (H - S * s) / 2;
    var out = [];
    out.push('<rect x="' + x0 + '" y="' + y0 + '" width="' + (L * s) + '" height="' + (S * s) +
      '" fill="var(--text-muted,#888)" opacity=".22" stroke="var(--text-muted,#aaa)" stroke-width="2"/>');
    // mesh
    for (var i = 1; i < 8; i++) {
      out.push('<line x1="' + (x0 + L * s * i / 8) + '" y1="' + y0 + '" x2="' + (x0 + L * s * i / 8) +
        '" y2="' + (y0 + S * s) + '" stroke="var(--water,#4fc3f7)" stroke-width="1" opacity=".5"/>');
    }
    for (var j = 1; j < 4; j++) {
      out.push('<line x1="' + x0 + '" y1="' + (y0 + S * s * j / 4) + '" x2="' + (x0 + L * s) +
        '" y2="' + (y0 + S * s * j / 4) + '" stroke="var(--water,#4fc3f7)" stroke-width="1" opacity=".5"/>');
    }
    out.push('<text x="' + (x0 + L * s / 2) + '" y="' + (y0 + S * s / 2 + 5) +
      '" fill="var(--text,#eee)" font-size="15" font-weight="800" text-anchor="middle">' +
      n1(a) + ' \u05de"\u05e8 \u00b7 ' + d.slabTh + ' \u05de\'</text>');
    out.push('<text x="' + (x0 + L * s / 2) + '" y="' + (y0 + S * s + 24) +
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
    if (!m) return null;
    if (!_layer) _layer = L.layerGroup().addTo(m);
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
  function startFootprint(id) {
    var m = map();
    if (!m) { toast('\u26a0\ufe0f ' + tt('המפה לא זמינה', 'แผนที่ไม่พร้อม', 'الخريطة غير متاحة')); return; }
    if (window.MapAccess && !MapAccess.setExternalDraw(true)) {
      toast('\u26a0\ufe0f ' + tt('סיים את הסימון הפעיל', 'จบการวาดก่อน', 'أنهِ الرسم الحالي'));
      return;
    }
    close();
    _draw = { id: id, pts: [], markers: [], line: null };
    m.on('click', onDrawClick);
    banner(true);
  }

  function onDrawClick(e) {
    if (!_draw) return;
    var m = map();
    _draw.pts.push(e.latlng);
    var mk = L.circleMarker(e.latlng, { radius: 5, color: '#ff9f43', fillOpacity: 1 }).addTo(m);
    _draw.markers.push(mk);
    if (_draw.line) m.removeLayer(_draw.line);
    if (_draw.pts.length > 1) {
      _draw.line = L.polygon(_draw.pts, { color: '#ff9f43', weight: 2, fillOpacity: .18 }).addTo(m);
    }
    banner(true);
  }

  function banner(show) {
    var b = document.getElementById('bpBanner');
    if (!show) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.id = 'bpBanner';
      document.body.appendChild(b);
    }
    var n = _draw ? _draw.pts.length : 0;
    b.innerHTML =
      '<div style="position:fixed;top:0;inset-inline:0;z-index:10060;padding:12px;' +
        'background:rgba(8,18,12,.96);color:#fff;display:flex;gap:8px;align-items:center;' +
        'justify-content:center;flex-wrap:wrap;font-weight:700;font-size:.88rem;">' +
        '<span>\u2b20 ' + tt('לחץ על המפה לסימון גבול הפרויקט', 'แตะแผนที่เพื่อกำหนดขอบเขต',
          'انقر على الخريطة لتحديد الحدود') + ' (' + n + ')</span>' +
        '<button onclick="BuildPlan.undoPoint()" style="padding:7px 12px;border-radius:9px;border:none;' +
          'background:rgba(255,255,255,.14);color:#fff;font-family:inherit;font-weight:700;">\u21a9</button>' +
        '<button onclick="BuildPlan.finishFootprint()" style="padding:7px 14px;border-radius:9px;border:none;' +
          'background:#2d6a4f;color:#fff;font-family:inherit;font-weight:800;">\u2713 ' +
          tt('סיום', 'เสร็จ', 'إنهاء') + '</button>' +
        '<button onclick="BuildPlan.cancelFootprint()" style="padding:7px 12px;border-radius:9px;border:none;' +
          'background:rgba(255,71,87,.25);color:#fff;font-family:inherit;font-weight:700;">\u2715</button>' +
      '</div>';
  }

  function undoPoint() {
    if (!_draw || !_draw.pts.length) return;
    var m = map();
    _draw.pts.pop();
    m.removeLayer(_draw.markers.pop());
    if (_draw.line) { m.removeLayer(_draw.line); _draw.line = null; }
    if (_draw.pts.length > 1) {
      _draw.line = L.polygon(_draw.pts, { color: '#ff9f43', weight: 2, fillOpacity: .18 }).addTo(m);
    }
    banner(true);
  }

  function clearDraw() {
    var m = map();
    if (_draw && m) {
      _draw.markers.forEach(function (mk) { m.removeLayer(mk); });
      if (_draw.line) m.removeLayer(_draw.line);
      m.off('click', onDrawClick);
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
    var prev = document.querySelector('.bp-back');
    var top = prev ? prev.scrollTop : 0;
    m.innerHTML = h;
    var next = document.querySelector('.bp-back');
    if (next && top) next.scrollTop = top;
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
      '.bp-sheet{max-width:1000px;margin:0 auto;background:var(--surface,#fff);color:var(--text,#222);' +
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
    var bar =
      '<button class="bp-btn" onclick="BuildPlan.newProject(\'shed\')">\ud83c\udfd7 ' +
        tt('סככה חדשה', 'โรงเรือนใหม่', 'سقيفة جديدة') + '</button>' +
      '<button class="bp-btn" onclick="BuildPlan.newProject(\'slab\')">\ud83e\uddf1 ' +
        tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.openCatalog()">\ud83d\udcd0 ' +
        tt('קטלוג פרופילים', 'แคตตาล็อก', 'كتالوج') + '</button>' +
      '<button class="bp-btn ghost" onclick="Orders.open()">\ud83d\udce6 ' +
        tt('הזמנות', 'ใบสั่งซื้อ', 'الطلبات') + '</button>';

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
        body += '<div class="bp-card" style="cursor:pointer;" onclick="BuildPlan.open(' + p.id + ')">' +
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
          '</div></div>';
      });

    paint(shell('\ud83c\udfd7 ' + tt('פרויקטי בנייה', 'โครงการก่อสร้าง', 'مشاريع البناء'), bar, body));
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
    if (!confirm(tt('למחוק את הפרויקט?', 'ลบโครงการ?', 'حذف المشروع؟'))) return;
    var before = projById(id);
    P.projects = (P.projects || []).filter(function (p) { return p.id !== id; });
    saveP();
    if (window.Audit && Audit.log) Audit.log('delete', 'buildplan', String(id), { before: before });
    render();
  }

  function setTab(t) { _tab = t; if (_open) open(_open); }

  function open(id) {
    var p = projById(id);
    if (!p) { render(); return; }
    _open = id;
    var d = p.dims;
    var rows = takeoff(p), tot = takeoffTotals(rows);

    var tabs = ['design', 'materials', 'site'].map(function (t) {
      var lbl = t === 'design' ? '\ud83d\udcd0 ' + tt('שרטוט', 'แบบ', 'رسم')
              : t === 'materials' ? '\ud83e\uddfe ' + tt('כתב כמויות', 'รายการวัสดุ', 'الكميات')
              : '\ud83d\uddfa ' + tt('מיקום במפה', 'ตำแหน่ง', 'الموقع');
      return '<button class="bp-btn ' + (_tab === t ? 'on' : 'ghost') +
        '" onclick="BuildPlan.setTab(\'' + t + '\')">' + lbl + '</button>';
    }).join('');

    var body = '<div class="bp-card">' +
      '<div class="bp-grid">' +
        '<div><div class="bp-lbl">' + tt('שם', 'ชื่อ', 'الاسم') + '</div>' +
          '<input class="bp-in" value="' + esc(p.name) + '" ' +
          'oninput="BuildPlan._set(' + id + ',\'name\',this.value)"></div>' +
        '<div><div class="bp-lbl">' + tt('לקוח / מטע', 'ลูกค้า', 'العميل') + '</div>' +
          '<input class="bp-in" value="' + esc(p.client) + '" ' +
          'oninput="BuildPlan._set(' + id + ',\'client\',this.value)"></div>' +
      '</div></div>' + '<div class="bp-bar">' + tabs + '</div>';

    if (_tab === 'design')      body += designTab(p);
    else if (_tab === 'materials') body += matTab(p, rows, tot);
    else                        body += siteTab(p);

    var bar =
      '<button class="bp-btn" onclick="BuildPlan.saveNow()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printProject(' + id + ')">\ud83d\udda8 ' +
        tt('הדפסה', 'พิมพ์', 'طباعة') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.toOrder(' + id + ')">\ud83d\udce6 ' +
        tt('צור הזמנה', 'สร้างใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      '<button class="bp-btn warn" onclick="BuildPlan.delProject(' + id + ')">\ud83d\uddd1</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') +
      esc(p.name || typeLabel(p.type)), bar, body));
  }

  // A slider and a number field on the same value: drag to explore the
  // shape, type when the dimension is already decided.
  function ctl(id, key, label, val, min, max, step) {
    return '<div><div class="bp-lbl">' + label + '</div>' +
      '<input class="bp-in" type="number" step="' + step + '" value="' + val + '" ' +
        'oninput="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)">' +
      '<input class="bp-rng" type="range" min="' + min + '" max="' + max + '" step="' + step + '" ' +
        'value="' + val + '" oninput="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)"></div>';
  }

  function profSel(id, key, group, cur) {
    var o = '';
    (C.profiles || []).filter(function (x) { return x.group === group; }).forEach(function (x) {
      o += '<option value="' + esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        esc(x.name) + (x.kgPerM ? ' \u00b7 ' + x.kgPerM + ' kg/m' : '') +
        (x.price ? ' \u00b7 ' + money(x.price) : '') + '</option>';
    });
    return '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)">' +
      o + '</select>';
  }

  function designTab(p) {
    var id = p.id, d = p.dims;
    var h = '<div class="bp-card">' + svg(p) + '</div>';

    if (p.type === 'slab') {
      h += '<div class="bp-card"><div class="bp-grid">' +
        ctl(id, 'length', tt('אורך (מ\')', 'ยาว', 'الطول'), d.length, 2, 80, 0.5) +
        ctl(id, 'span',   tt('רוחב (מ\')', 'กว้าง', 'العرض'), d.span, 2, 40, 0.5) +
        ctl(id, 'slabTh', tt('עובי (מ\')', 'หนา', 'السماكة'), d.slabTh, 0.08, 0.5, 0.01) +
        ctl(id, 'waste',  tt('פחת %', 'เผื่อ %', 'هدر %'), d.waste, 0, 25, 1) +
      '</div>' +
      (p.footprintArea > 0 ? '<div style="font-size:.78rem;color:var(--accent,#ff9f43);margin-top:8px;">' +
        '\ud83d\uddfa ' + tt('השטח נלקח מהמצולע במפה', 'ใช้พื้นที่จากแผนที่', 'المساحة من الخريطة') +
        ': ' + n1(p.footprintArea) + ' \u05de"\u05e8</div>' : '') +
      '</div>';
      return h;
    }

    var g = geom(d);
    h += '<div class="bp-card"><div class="bp-grid">' +
      ctl(id, 'span',   tt('מפתח (מ\')', 'ช่วงกว้าง', 'الباع'), d.span, 4, 40, 0.5) +
      ctl(id, 'length', tt('אורך (מ\')', 'ยาว', 'الطول'), d.length, 4, 100, 0.5) +
      ctl(id, 'eaves',  tt('גובה עמוד (מ\')', 'สูงเสา', 'ارتفاع العمود'), d.eaves, 2, 12, 0.1) +
      ctl(id, 'bay',    tt('מרווח מסגרות (מ\')', 'ระยะเฟรม', 'تباعد الإطارات'), d.bay, 2, 10, 0.5) +
      ctl(id, 'pitch',  tt('שיפוע גג (°)', 'ความชัน', 'الميل'), d.pitch, 0, 35, 1) +
      ctl(id, 'waste',  tt('פחת %', 'เผื่อ %', 'هدر %'), d.waste, 0, 25, 1) +
    '</div>' +
    '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;font-size:.8rem;">' +
      '<label><input type="checkbox"' + (d.walls ? ' checked' : '') +
        ' onchange="BuildPlan._dim(' + id + ',\'walls\',this.checked)"> ' +
        tt('קירות', 'ผนัง', 'جدران') + '</label>' +
      '<label><input type="checkbox"' + (d.gutter ? ' checked' : '') +
        ' onchange="BuildPlan._dim(' + id + ',\'gutter\',this.checked)"> ' +
        tt('מרזבים', 'รางน้ำ', 'مزاريب') + '</label>' +
    '</div></div>' +

    '<div class="bp-card"><div class="bp-lbl">' +
      tt('פרופילים', 'โปรไฟล์', 'المقاطع') + '</div><div class="bp-grid">' +
      '<div><div class="bp-lbl">' + tt('עמודים', 'เสา', 'أعمدة') + '</div>' +
        profSel(id, 'colProfile', 'עמודים / קורות', d.colProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('קורות גג', 'คาน', 'روافد') + '</div>' +
        profSel(id, 'rafterProfile', 'עמודים / קורות', d.rafterProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('מרישים', 'แป', 'مرايش') + '</div>' +
        profSel(id, 'purlinProfile', 'מרישים', d.purlinProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('מסילות קיר', 'แปผนัง', 'مرايش الجدار') + '</div>' +
        profSel(id, 'girtProfile', 'מרישים', d.girtProfile) + '</div>' +
      '<div><div class="bp-lbl">' + tt('חיפוי גג', 'หลังคา', 'تغطية السقف') + '</div>' +
        profSel(id, 'roofPanel', 'חיפוי', d.roofPanel) + '</div>' +
      '<div><div class="bp-lbl">' + tt('חיפוי קיר', 'ผนัง', 'تغطية الجدار') + '</div>' +
        profSel(id, 'wallPanel', 'חיפוי', d.wallPanel) + '</div>' +
    '</div></div>' +

    '<div class="bp-card">' +
      '<div class="bp-tot"><span>' + tt('גובה רכס', 'สูงสันหลังคา', 'ارتفاع القمة') +
        '</span><strong>' + n1(g.ridgeH) + ' m</strong></div>' +
      '<div class="bp-tot"><span>' + tt('אורך קורה', 'ความยาวคาน', 'طول الرافدة') +
        '</span><strong>' + n1(g.rafterLen) + ' m</strong></div>' +
      '<div class="bp-tot"><span>' + tt('מסגרות בפועל', 'เฟรมจริง', 'الإطارات فعلياً') +
        '</span><strong>' + g.frames + ' @ ' + n1(g.actualBay) + ' m</strong></div>' +
      '<div class="bp-tot"><span>' + tt('שטח גג', 'พื้นที่หลังคา', 'مساحة السقف') +
        '</span><strong>' + n1(g.roofArea) + ' \u05de"\u05e8</strong></div>' +
      '<div class="bp-tot" style="border:none;"><span>' + tt('שטח מקורה', 'พื้นที่คลุม', 'المساحة المغطاة') +
        '</span><strong>' + n1(g.footprint) + ' \u05de"\u05e8</strong></div>' +
      (Math.abs(g.actualBay - d.bay) > 0.05 ?
        '<div style="font-size:.75rem;color:var(--accent,#ff9f43);margin-top:6px;">\u26a0\ufe0f ' +
        tt('המרווח הותאם ל-', 'ปรับระยะเป็น ', 'تم ضبط التباعد إلى ') + n1(g.actualBay) +
        ' m ' + tt('כדי לחלק את האורך שווה בשווה', 'เพื่อแบ่งเท่ากัน', 'لتقسيم متساوٍ') + '</div>' : '') +
    '</div>';
    return h;
  }

  function matTab(p, rows, tot) {
    var h = '<div class="bp-card">';
    rows.forEach(function (r) {
      var pr = profByName(r.name);
      h += '<div class="bp-tot"><span>' + esc(r.name) +
        (r.note ? '<br><span style="font-size:.7rem;color:var(--text-muted,#888);">' +
          esc(r.note) + '</span>' : '') + '</span>' +
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
        '<button class="bp-btn" onclick="BuildPlan.startFootprint(' + p.id + ')">\u2b20 ' +
          (has ? tt('סמן מחדש', 'วาดใหม่', 'إعادة الرسم')
               : tt('סמן על המפה', 'วาดบนแผนที่', 'ارسم على الخريطة')) + '</button>' +
        (has ? '<button class="bp-btn ghost" onclick="BuildPlan.zoomTo(' + p.id + ')">\ud83d\udd0d ' +
          tt('הצג במפה', 'ดูบนแผนที่', 'عرض على الخريطة') + '</button>' +
          '<button class="bp-btn ghost" onclick="BuildPlan.useFootprint(' + p.id + ')">\u2b07 ' +
          tt('קח מידות מהשטח', 'ใช้ขนาดจากพื้นที่', 'استخدم أبعاد المساحة') + '</button>' : '') +
      '</div>' +
      (has ? '<div style="font-size:.75rem;color:var(--text-muted,#888);margin-top:8px;">' +
        tt('שטח שסומן על המפה גובר על המידות שהוקלדו בחישוב הבטון.',
           'พื้นที่จากแผนที่มีผลเหนือค่าที่พิมพ์', 'المساحة المرسومة تتقدم على المدخلة') + '</div>' : '') +
    '</div>';
  }

  function zoomTo(id) {
    var p = projById(id), m = map();
    if (!p || !m || p.footprint.length < 3) return;
    close();
    m.fitBounds(p.footprint.map(function (pt) { return [pt.lat, pt.lng]; }), { padding: [40, 40] });
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
  function _dim(id, k, v) {
    var p = projById(id);
    if (!p) return;
    p.dims[k] = (k === 'walls' || k === 'gutter') ? !!v
      : (typeof v === 'string' && /^[a-zA-Z\u0590-\u05FF]/.test(v)) ? v : (Number(v) || 0);
    open(id);   // the drawing IS the feedback — repaint on every change
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
      body += '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:6px;">' + esc(g) +
        '</div>' + rows +
        '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.78rem;" ' +
          'onclick="BuildPlan._addProf(\'' + esc(g) + '\')">\u2795</button></div>';
    });
    var bar = '<button class="bp-btn" onclick="BuildPlan._saveCat()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';
    paint(shell('\ud83d\udcd0 ' + tt('קטלוג פרופילים', 'แคตตาล็อกโปรไฟล์', 'كتالوج المقاطع'), bar, body));
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
  function _saveCat() {
    saveC();
    toast('\u2705 ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ'));
    openCatalog();
  }

  // ── outputs ──
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

  // Print colours hardcoded — the sheet opens in a bare tab with no theme.
  function printProject(id) {
    var p = projById(id);
    if (!p) return;
    var rows = takeoff(p), tot = takeoffTotals(rows);
    var g = p.type === 'slab' ? null : geom(p.dims);
    var body = '';
    rows.forEach(function (r, i) {
      var pr = profByName(r.name);
      body += '<tr><td>' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td>' + n1(r.qty) +
        '</td><td>' + esc(r.unit) + '</td><td>' + (r.kg ? n1(r.kg) : '\u2014') + '</td>' +
        '<td>' + (pr && pr.price ? money(pr.price) : '\u2014') + '</td>' +
        '<td>' + (pr && pr.price ? money(r.qty * pr.price) : '\u2014') + '</td>' +
        '<td>' + esc(r.note) + '</td></tr>';
    });
    var drawing = svg(p)
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
      '<div class="meta">' + typeLabel(p.type) +
        (p.client ? ' \u00b7 ' + esc(p.client) : '') +
        (g ? '<br>' + n1(p.dims.span) + ' \u00d7 ' + n1(p.dims.length) + ' m, ' +
             tt('גובה', 'สูง', 'ارتفاع') + ' ' + n1(p.dims.eaves) + ' m, ' +
             tt('שיפוע', 'ชัน', 'ميل') + ' ' + n1(p.dims.pitch) + '\u00b0, ' +
             g.frames + ' ' + tt('מסגרות', 'เฟรม', 'إطارات') + ' @ ' + n1(g.actualBay) + ' m'
           : '<br>' + n1(slabArea(p)) + ' \u05de"\u05e8 \u00d7 ' + p.dims.slabTh + ' \u05de\'') +
        (p.footprintArea > 0 ? '<br>' + tt('שטח מסומן במפה', 'พื้นที่จากแผนที่', 'المساحة المرسومة') +
          ': ' + n1(p.footprintArea) + ' \u05de"\u05e8' : '') +
      '</div>' + drawing +
      '<h2>' + tt('כתב כמויות', 'รายการวัสดุ', 'جدول الكميات') + '</h2>' +
      '<table><thead><tr><th>#</th><th>' + tt('פריט', 'รายการ', 'صنف') + '</th><th>' +
        tt('כמות', 'จำนวน', 'كمية') + '</th><th>' + tt('יחידה', 'หน่วย', 'وحدة') + '</th><th>' +
        tt('משקל', 'น้ำหนัก', 'وزن') + '</th><th>' + tt('מחיר', 'ราคา', 'سعر') + '</th><th>' +
        tt('סה"כ', 'รวม', 'مجموع') + '</th><th>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</th></tr></thead>' +
      '<tbody>' + body + '</tbody><tfoot><tr><td colspan="4">' +
        tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد') + '</td><td>' + n1(tot.kg) + ' kg</td>' +
        '<td>' + tt('סה"כ', 'รวม', 'مجموع') + '</td><td colspan="2">' + money(tot.cost) +
        '</td></tr></tfoot></table>' +
      '<p style="margin-top:20px;font-size:.8rem;">\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD</p>' +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, (p.name || 'project').replace(/\s+/g, '_') + '.html');
    }
  }

  // Footprints should be visible on the map without opening the module.
  function boot() {
    if (!isManager()) return;
    loadAll().then(function () { listen(); drawFootprints(); }).catch(function () {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 1500); });
  } else {
    setTimeout(boot, 1500);
  }

  return {
    open: openModule,
    openProject: open,
    close: close,
    render: render,
    newProject: newProject,
    delProject: delProject,
    setTab: setTab,
    openCatalog: openCatalog,
    startFootprint: startFootprint,
    finishFootprint: finishFootprint,
    cancelFootprint: cancelFootprint,
    undoPoint: undoPoint,
    zoomTo: zoomTo,
    useFootprint: useFootprint,
    printProject: printProject,
    toOrder: toOrder,
    saveNow: saveNow,
    takeoff: takeoff,
    geom: geom,
    _set: _set,
    _dim: _dim,
    _prof: _prof,
    _addProf: _addProf,
    _delProf: _delProf,
    _saveCat: _saveCat
  };
})();
