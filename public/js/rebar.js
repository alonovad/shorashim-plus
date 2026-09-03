/* rebar.js — פירוט זיון ורשתות פלדה (reinforcement detailing)
 * ------------------------------------------------------------------
 * One place that knows what goes INSIDE the concrete, for every structure
 * that pours any: gate post foundations, shed pad footings, slabs.
 *
 * WHY THIS IS A MODULE AND NOT A FEW LINES IN THE TAKEOFF
 *   The takeoff already billed reinforcement — as a single guess,
 *   `pads * footW * 8 * 2` metres of Ø12, with nothing in the drawing to
 *   say what that meant. A fabricator cannot bend a cage from that, a
 *   client cannot see it, and an inspector cannot check it. A cage is
 *   four numbers (bars, diameter, stirrup diameter, stirrup spacing) plus
 *   a mat, and once those numbers exist they can be drawn, dimensioned,
 *   priced and printed. The same four numbers describe the foundation
 *   under a gate post and under a shed column, so they live here rather
 *   than twice.
 *
 * WHAT IT IS NOT
 *   Not a design. Nothing here sizes a cage against a load — it records
 *   and draws what was specified. Bar areas, development lengths, lap
 *   splices and soil bearing are a קונסטרוקטור's work, and the defaults
 *   below are ordinary practice for a 0.4–0.8 m pad in this region, not
 *   a calculation.
 *
 * UNITS  metres for geometry, millimetres for bar diameter, centimetres
 * for spacing and cover — which is how each of them is actually written
 * on a drawing here. Converting them to one unit would make the numbers
 * unreadable to the people who use them.
 */
var Rebar = (function () {
  'use strict';

  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // Bar diameters actually stocked here. Anything else is a special order
  // and does not belong in a dropdown.
  var DIAM = [8, 10, 12, 14, 16, 20];

  // Nominal mass of a round bar: 0.006165 * d². Ø12 comes out at 0.888,
  // which is the figure already in the catalogue — the two agree by
  // derivation rather than by having been typed in twice.
  function kgPerM(d) {
    return Math.round(0.006165 * Number(d) * Number(d) * 1000) / 1000;
  }
  // The catalogue key. Hebrew is the key everywhere in this app; it is
  // translated only at display time, so a saved project never breaks.
  function barName(d) { return 'ברזל זיון ' + Number(d) + ' מ"מ'; }   // CATALOGUE KEY
  var MESH_NAME = 'רשת ברזל מצולע';   // CATALOGUE KEY
  var Q188_NAME = 'רשת פלדה Q188';   // CATALOGUE KEY

  function norm(r) {
    r = r || {};
    function pick(v, def, lo, hi) {
      var n = Number(v);
      if (!isFinite(n) || n <= 0) return def;
      return Math.max(lo, Math.min(hi, n));
    }
    function diam(v, def) {
      var n = Math.round(Number(v));
      return DIAM.indexOf(n) >= 0 ? n : def;
    }
    return {
      // Whether the detail is DRAWN. It is always priced — concrete with
      // no steel in it is not a thing anyone pours, so hiding the drawing
      // must not quietly delete the cage from the bill.
      show:   r.show === false ? false : true,
      mainN:  Math.max(2, Math.min(12, Math.round(Number(r.mainN) || 4))),
      mainD:  diam(r.mainD, 12),
      stirD:  diam(r.stirD, 8),
      stirSp: pick(r.stirSp, 20, 5, 40),      // cm
      cover:  pick(r.cover, 5, 2.5, 10),      // cm
      mat:    r.mat === false ? false : true, // bottom mat inside the pad
      matD:   diam(r.matD, 10),
      matSp:  pick(r.matSp, 15, 10, 30),      // cm
      // Slab reinforcement is a different product: welded sheets (Q188)
      // or a deformed-bar mat tied on site. Default stays Q188 so every
      // existing project prices exactly as it did before.
      slabMesh: (r.slabMesh === 'deformed' || r.slabMesh === 'none') ? r.slabMesh : 'Q188',
      meshD:  diam(r.meshD, 10),
      meshSp: pick(r.meshSp, 15, 10, 30)      // cm
    };
  }

  // ── labels, written the way they are written on a drawing ──
  function cageLabel(r) {
    r = norm(r);
    return r.mainN + '\u00d8' + r.mainD + ' + ' +
      tt('חישוקים', 'ปลอกเหล็ก', 'أساور') + ' \u00d8' + r.stirD + '@' + n1(r.stirSp);
  }
  function matLabel(r) {
    r = norm(r);
    return '#\u00d8' + r.matD + '@' + n1(r.matSp);
  }
  function slabLabel(r) {
    r = norm(r);
    if (r.slabMesh === 'none') return '';
    if (r.slabMesh === 'Q188') return Q188_NAME;
    return MESH_NAME + ' #\u00d8' + r.meshD + '@' + n1(r.meshSp);
  }
  // One line that says everything about a pad, for a leader or a table.
  function summaryLabel(r) {
    r = norm(r);
    return cageLabel(r) + (r.mat ? ' \u00b7 ' + tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية') +
      ' ' + matLabel(r) : '');
  }

  // ── quantities ──────────────────────────────────────────────────────
  // A pad cage: vertical bars with a hook at each end, stirrups up the
  // height, and an optional mat across the bottom. Everything returns in
  // the shape the takeoff expects: catalogue name, quantity, unit, note.
  function padTakeoff(r, geo) {
    r = norm(r);
    geo = geo || {};
    var n = Math.max(0, Math.round(Number(geo.n) || 0));
    var w = Number(geo.w) || 0;             // pad side, m
    var d = Number(geo.d) || 0;             // pad depth, m
    var waste = Number(geo.waste) || 1;
    var out = [];
    if (!(n > 0) || !(w > 0) || !(d > 0)) return out;

    var c = r.cover / 100;                  // cover, m
    var clearW = Math.max(0.1, w - 2 * c);
    var clearD = Math.max(0.1, d - 2 * c);

    // Main bars run the depth of the pad, with a 15 cm hook top and bottom.
    var mainLen = (clearD + 0.30) * r.mainN;
    out.push({ name: barName(r.mainD), qty: n * mainLen * waste, unit: "מ'",
      note: n + ' \u00d7 ' + r.mainN + '\u00d8' + r.mainD + ' \u00b7 ' +
        tt('כלוב יסוד', 'กรงฐานราก', 'قفص الأساس') });

    // Stirrups: one every stirSp up the clear depth, plus one at each end.
    var stirN = Math.floor(clearD / (r.stirSp / 100)) + 1;
    var stirLen = 4 * clearW + 0.12;        // closed loop + lap
    out.push({ name: barName(r.stirD), qty: n * stirN * stirLen * waste, unit: "מ'",
      note: n * stirN + ' ' + tt('חישוקים', 'ปลอกเหล็ก', 'أساور') +
        ' \u00d8' + r.stirD + '@' + n1(r.stirSp) });

    if (r.mat) {
      var barsEachWay = Math.floor(clearW / (r.matSp / 100)) + 1;
      var matLen = 2 * barsEachWay * (clearW + 0.10);
      out.push({ name: barName(r.matD), qty: n * matLen * waste, unit: "מ'",
        note: tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية') + ' ' + matLabel(r) });
    }
    return out;
  }

  // Slab reinforcement. Q188 comes in 6.00 x 2.35 m sheets; 10% is the
  // usual lap allowance. A deformed mat is bought by the square metre.
  function slabTakeoff(r, area, waste) {
    r = norm(r);
    area = Number(area) || 0;
    waste = Number(waste) || 1;
    if (!(area > 0) || r.slabMesh === 'none') return [];
    if (r.slabMesh === 'Q188') {
      return [{ name: Q188_NAME, qty: Math.ceil(area / (6 * 2.35) * 1.1), unit: "יח'",
        note: tt('כולל חפיפה', 'รวมทาบ', 'شامل التداخل') }];
    }
    return [{ name: MESH_NAME, qty: area * 1.1 * waste, unit: 'מ"ר',   // CATALOGUE KEY
      note: matLabel({ matD: r.meshD, matSp: r.meshSp }) + ' \u00b7 ' +
        tt('כולל חפיפה', 'รวมทาบ', 'شامل التداخل') }];
  }

  // ── drawing ─────────────────────────────────────────────────────────
  // Bars inside a foundation already drawn by somebody else. Given the
  // rectangle the concrete occupies on screen, this puts the cage in it:
  // two vertical main bars in section, stirrups as horizontal ties, and
  // the mat as a row of dots along the bottom. Deliberately schematic —
  // at 40 px tall a literal cage is a grey smudge, and what the reader
  // needs to see is that there IS a cage and at what spacing.
  function overlay(r, bx, opt) {
    r = norm(r);
    if (!r.show) return '';
    opt = opt || {};
    var col = opt.color || '#c0392b';
    var x = bx.x, y = bx.y, w = bx.w, h = bx.h;
    if (!(w > 6) || !(h > 6)) return '';
    var pad = Math.max(2, Math.min(5, w * 0.12));
    var o = [];

    // main bars — the two visible in a section cut
    [x + pad, x + w - pad].forEach(function (mx) {
      o.push('<line x1="' + mx + '" y1="' + (y + pad) + '" x2="' + mx + '" y2="' + (y + h - pad) +
        '" stroke="' + col + '" stroke-width="1.4" stroke-linecap="round"/>');
    });
    // stirrups at true spacing, as long as they stay legible
    var rows = Math.max(2, Math.min(9, Math.round(h / Math.max(6, (r.stirSp / 100) * (opt.scale || 40)))));
    for (var i = 0; i <= rows; i++) {
      var sy = y + pad + (h - 2 * pad) * i / rows;
      o.push('<line x1="' + (x + pad) + '" y1="' + sy + '" x2="' + (x + w - pad) + '" y2="' + sy +
        '" stroke="' + col + '" stroke-width="0.9" opacity=".85"/>');
    }
    // bottom mat, drawn as bar ends
    if (r.mat) {
      var dots = Math.max(2, Math.min(7, Math.round(w / 7)));
      for (var j = 0; j < dots; j++) {
        var dx = x + pad + (w - 2 * pad) * j / Math.max(1, dots - 1);
        o.push('<circle cx="' + dx + '" cy="' + (y + h - pad - 1.5) + '" r="1.3" fill="' + col + '"/>');
      }
    }
    return '<g class="rb-cage">' + o.join('') + '</g>';
  }

  // A standalone detail, at its own scale, the way a drawing sheet carries
  // one: section on the left, plan on the right, both dimensioned, with
  // the schedule text under them. This is the thing that was missing — the
  // takeoff said "ברזל זיון" and no drawing anywhere said what shape.
  function detailSvg(r, geo, opt) {
    r = norm(r);
    geo = geo || {};
    opt = opt || {};
    var print = !!opt.print;
    var w = Number(geo.w) || 0.5;            // pad side, m
    var d = Number(geo.d) || 1.0;            // pad depth, m
    var postW = Number(geo.postW) || Math.min(0.2, w * 0.35);
    var title = geo.title || tt('פרט זיון יסוד', 'รายละเอียดเหล็กเสริมฐานราก', 'تفصيل تسليح الأساس');

    var col = {
      conc: print ? '#9e9e9e' : 'var(--text-muted,#9e9e9e)',
      steel: print ? '#37474f' : 'var(--text,#cfd8dc)',
      bar:  print ? '#c0392b' : '#e2624b',
      dim:  print ? '#b34700' : 'var(--accent,#ff9f43)',
      txt:  print ? '#37474f' : 'var(--text,#cfd8dc)',
      grnd: print ? '#8d6e63' : 'var(--text-muted,#8d6e63)'
    };

    var W = 560, H = 300;
    var o = [];
    o.push('<text x="14" y="20" fill="' + col.txt + '" font-size="12" font-weight="800">' +
      esc(title) + '</text>');

    // ── section (left half) ──
    var sx0 = 40, sy0 = 46, sBoxH = 190;
    var sc = Math.min((240 - 40) / Math.max(w, 0.3), sBoxH / Math.max(d + 0.35, 0.6));
    var pw = w * sc, ph = d * sc;
    var px = sx0 + (200 - pw) / 2, py = sy0 + 34;

    // ground line + post stub above it
    o.push('<line x1="' + (px - 26) + '" y1="' + py + '" x2="' + (px + pw + 26) + '" y2="' + py +
      '" stroke="' + col.grnd + '" stroke-width="1.6"/>');
    var stubW = Math.max(5, postW * sc);
    o.push('<rect x="' + (px + pw / 2 - stubW / 2) + '" y="' + (py - 30) + '" width="' + stubW +
      '" height="30" fill="' + col.steel + '" opacity=".9"/>');

    // concrete
    o.push('<rect x="' + px + '" y="' + py + '" width="' + pw + '" height="' + ph +
      '" fill="' + col.conc + '" opacity=".30" stroke="' + col.conc + '" stroke-width="1"/>');
    o.push(overlay(r, { x: px, y: py, w: pw, h: ph }, { color: col.bar, scale: sc }));

    // the anchored end of the post inside the pour — the reason the cage
    // has to clear the middle of the pad, and the thing most often drawn
    // as if the post floated in the concrete
    o.push('<rect x="' + (px + pw / 2 - stubW / 2) + '" y="' + py + '" width="' + stubW +
      '" height="' + (ph * 0.72) + '" fill="none" stroke="' + col.steel +
      '" stroke-width="1" stroke-dasharray="4,3"/>');

    // dimensions
    o.push('<line x1="' + px + '" y1="' + (py + ph + 16) + '" x2="' + (px + pw) + '" y2="' + (py + ph + 16) +
      '" stroke="' + col.dim + '" stroke-width="1"/>');
    o.push('<text x="' + (px + pw / 2) + '" y="' + (py + ph + 30) + '" fill="' + col.dim +
      '" font-size="11" font-weight="800" text-anchor="middle">' + n1(w) + ' m</text>');
    o.push('<line x1="' + (px - 14) + '" y1="' + py + '" x2="' + (px - 14) + '" y2="' + (py + ph) +
      '" stroke="' + col.dim + '" stroke-width="1"/>');
    o.push('<text x="' + (px - 18) + '" y="' + (py + ph / 2) + '" fill="' + col.dim +
      '" font-size="11" font-weight="800" text-anchor="end">' + n1(d) + ' m</text>');
    o.push('<text x="' + (px + pw / 2) + '" y="' + (sy0 + 14) + '" fill="' + col.txt +
      '" font-size="10.5" font-weight="700" text-anchor="middle" opacity=".8">' +
      esc(tt('חתך', 'ภาคตัด', 'مقطع')) + '</text>');

    // ── plan (right half) ──
    var qx0 = 320, qy0 = 46;
    var qs = Math.min(170 / Math.max(w, 0.3), 150 / Math.max(w, 0.3));
    var qw = w * qs;
    var qx = qx0 + (180 - qw) / 2, qy = qy0 + 44;
    var cvr = (r.cover / 100) * qs;

    o.push('<text x="' + (qx + qw / 2) + '" y="' + (qy0 + 14) + '" fill="' + col.txt +
      '" font-size="10.5" font-weight="700" text-anchor="middle" opacity=".8">' +
      esc(tt('מבט על', 'ผังพื้น', 'مسقط أفقي')) + '</text>');
    o.push('<rect x="' + qx + '" y="' + qy + '" width="' + qw + '" height="' + qw +
      '" fill="' + col.conc + '" opacity=".22" stroke="' + col.conc + '" stroke-width="1"/>');
    // stirrup outline at cover
    o.push('<rect x="' + (qx + cvr) + '" y="' + (qy + cvr) + '" width="' + Math.max(4, qw - 2 * cvr) +
      '" height="' + Math.max(4, qw - 2 * cvr) + '" fill="none" stroke="' + col.bar +
      '" stroke-width="1.3"/>');
    // main bars, distributed around the stirrup
    var ring = [];
    var inW = Math.max(4, qw - 2 * cvr), n = r.mainN;
    var perim = 4 * inW, step = perim / n;
    for (var k = 0; k < n; k++) {
      var t = k * step, bx2, by2;
      if (t < inW)            { bx2 = qx + cvr + t;            by2 = qy + cvr; }
      else if (t < 2 * inW)   { bx2 = qx + cvr + inW;          by2 = qy + cvr + (t - inW); }
      else if (t < 3 * inW)   { bx2 = qx + cvr + inW - (t - 2 * inW); by2 = qy + cvr + inW; }
      else                    { bx2 = qx + cvr;                by2 = qy + cvr + inW - (t - 3 * inW); }
      ring.push('<circle cx="' + bx2 + '" cy="' + by2 + '" r="2.4" fill="' + col.bar + '"/>');
    }
    o.push(ring.join(''));
    // post footprint
    var pfw = Math.max(5, postW * qs);
    o.push('<rect x="' + (qx + qw / 2 - pfw / 2) + '" y="' + (qy + qw / 2 - pfw / 2) + '" width="' + pfw +
      '" height="' + pfw + '" fill="none" stroke="' + col.steel + '" stroke-width="1.2"/>');

    // ── schedule text ──
    var lines = [
      cageLabel(r),
      r.mat ? tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية') + ' ' + matLabel(r) : '',
      tt('כיסוי בטון', 'ระยะหุ้ม', 'غطاء خرساني') + ' ' + n1(r.cover) + ' ' + tt('ס"מ', 'ซม.', 'سم') +
        ' \u00b7 ' + tt('בטון', 'คอนกรีต', 'خرسانة') + ' ב-30'   // CATALOGUE KEY
    ].filter(Boolean);
    lines.forEach(function (ln, i) {
      o.push('<text x="14" y="' + (H - 34 + i * 14) + '" fill="' +
        (i === 0 ? col.bar : col.txt) + '" font-size="11" font-weight="' + (i === 0 ? 800 : 600) +
        '" opacity="' + (i === 0 ? 1 : 0.85) + '">' + esc(ln) + '</text>');
    });

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">' +
      o.join('') + '</svg>';
  }

  return {
    DIAM: DIAM, norm: norm, kgPerM: kgPerM, barName: barName,
    MESH_NAME: MESH_NAME, Q188_NAME: Q188_NAME,
    cageLabel: cageLabel, matLabel: matLabel, slabLabel: slabLabel,
    summaryLabel: summaryLabel,
    padTakeoff: padTakeoff, slabTakeoff: slabTakeoff,
    overlay: overlay, detailSvg: detailSvg
  };
})();
