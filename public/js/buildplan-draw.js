/* buildplan-draw.js — parametric SVG section + plan drawing
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
  //  THE DRAWING
  // ══════════════════════════════════════════════════════════════════
  // A scaled section + plan, rebuilt on every input change. Colours come
  // from theme variables so it reads on the dark theme; stroke widths are
  // fixed px because they are line weights, not scene dimensions.
  // ── CAD annotation primitives ─────────────────────────────────────
  // A structural drawing names its members on the drawing. Everything the
  // fabricator needs is one glance away instead of one cross-reference to
  // a table on another page, and the quote stops being a picture of a shed
  // and becomes a description of the one being priced.
  //
  // Anatomy, which is a convention and not a preference: an arrowhead on
  // the member, a slanted leader to a bend, a horizontal shelf, and the
  // text sitting on the shelf. Text never touches the geometry it labels.
  var ANN = {
    line:  'var(--text,#222)',
    thin:  'var(--text-muted,#888)',
    txt:   'var(--text,#222)',
    size:  11.5
  };

  function arrowHead(tx, ty, fromX, fromY, col) {
    var dx = tx - fromX, dy = ty - fromY;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;          // unit vector, shelf -> member
    var px = -uy, py = ux;                     // perpendicular
    var L = 9, Wd = 3.1;                       // head length and half-width
    var bx = tx - ux * L, by = ty - uy * L;
    return '<path d="M' + tx + ',' + ty +
      ' L' + (bx + px * Wd) + ',' + (by + py * Wd) +
      ' L' + (bx - px * Wd) + ',' + (by - py * Wd) + ' Z" fill="' + col + '"/>';
  }

  // tx,ty  the point on the member being named
  // bx,by  where the leader bends into its horizontal shelf
  // dir    'l' or 'r' — which way the shelf runs from the bend
  // lines  one or more strings, stacked bottom-up above the shelf
  function leader(tx, ty, bx, by, dir, lines, col) {
    col = col || ANN.line;
    lines = [].concat(lines).filter(Boolean);
    if (!lines.length) return '';
    // The shelf is as long as the widest line it has to carry. 0.55em per
    // character is a deliberate over-estimate: a shelf slightly too long
    // reads as a drawing convention, one too short reads as a mistake.
    var wide = 0;
    lines.forEach(function (t) { wide = Math.max(wide, String(t).length); });
    var shelf = Math.max(38, wide * ANN.size * 0.55);
    var ex = (dir === 'l') ? bx - shelf : bx + shelf;
    var anchor = (dir === 'l') ? 'start' : 'end';
    var out =
      '<line x1="' + bx + '" y1="' + by + '" x2="' + tx + '" y2="' + ty +
        '" stroke="' + col + '" stroke-width="1"/>' +
      '<line x1="' + bx + '" y1="' + by + '" x2="' + ex + '" y2="' + by +
        '" stroke="' + col + '" stroke-width="1"/>' +
      arrowHead(tx, ty, bx, by, col);
    // Stacked upward so the last line always sits directly on the shelf,
    // which is what the eye follows back to the arrow.
    for (var i = 0; i < lines.length; i++) {
      var up = (lines.length - 1 - i) * (ANN.size + 2.5) + 4;
      out += '<text x="' + ex + '" y="' + (by - up) + '" fill="' + ANN.txt +
        '" font-size="' + ANN.size + '" font-weight="600" text-anchor="' + anchor +
        '" font-family="ui-monospace,Menlo,Consolas,monospace">' + BP.esc(lines[i]) + '</text>';
    }
    return out;
  }

  // A dimension chain: one run of ticks with each segment labelled along
  // it, and the overall figure outboard of them. Vertical only — that is
  // the one that needs rotated text and therefore the one worth a helper.
  function dimChainV(x, y0v, stops, labels, overall) {
    var out = '', col = ANN.thin;
    out += '<line x1="' + x + '" y1="' + y0v + '" x2="' + x + '" y2="' +
      stops[stops.length - 1] + '" stroke="' + col + '" stroke-width="1"/>';
    var all = [y0v].concat(stops);
    all.forEach(function (yy) {
      out += '<line x1="' + (x - 4) + '" y1="' + (yy + 4) + '" x2="' + (x + 4) + '" y2="' + (yy - 4) +
        '" stroke="' + col + '" stroke-width="1"/>';
    });
    for (var i = 0; i < labels.length; i++) {
      var mid = (all[i] + all[i + 1]) / 2;
      out += '<text x="' + (x - 6) + '" y="' + mid + '" fill="' + ANN.txt +
        '" font-size="11" font-weight="600" text-anchor="middle"' +
        ' transform="rotate(-90 ' + (x - 6) + ' ' + mid + ')"' +
        ' font-family="ui-monospace,Menlo,Consolas,monospace">' + BP.esc(labels[i]) + '</text>';
    }
    if (overall) {
      var ox = x + 30;
      out += '<line x1="' + ox + '" y1="' + all[0] + '" x2="' + ox + '" y2="' + all[all.length - 1] +
        '" stroke="' + col + '" stroke-width="1"/>';
      [all[0], all[all.length - 1]].forEach(function (yy) {
        out += '<line x1="' + (ox - 4) + '" y1="' + (yy + 4) + '" x2="' + (ox + 4) + '" y2="' + (yy - 4) +
          '" stroke="' + col + '" stroke-width="1"/>';
      });
      var om = (all[0] + all[all.length - 1]) / 2;
      out += '<text x="' + (ox - 6) + '" y="' + om + '" fill="' + ANN.txt +
        '" font-size="11" font-weight="700" text-anchor="middle"' +
        ' transform="rotate(-90 ' + (ox - 6) + ' ' + om + ')"' +
        ' font-family="ui-monospace,Menlo,Consolas,monospace">' + BP.esc(overall) + '</text>';
    }
    return out;
  }

  // Heights are called out in centimetres, the way they are on every
  // fabrication drawing here — 360, not 3.6 m.
  function cm(m) { return String(Math.round((Number(m) || 0) * 100)); }

  BP.svg = function svg(p) {
    var d = p.dims;
    if (p.type === 'slab') return slabSvg(p);
    var g = BP.geom(d);

    // Callouts live in the margin, so the margin has to exist. The frame
    // itself is drawn at the same scale either way — the canvas grows
    // around it rather than the structure shrinking inside it.
    var CAL = d.callouts !== false;
    var W = CAL ? 880 : 620, H = CAL ? 340 : 300, pad = 46;
    var mx = CAL ? 178 : pad;          // side margin for leaders
    var sx = (W - mx * 2) / d.span;
    var sy = (H - pad * 2 - 26) / Math.max(g.ridgeH, 1);
    var s = Math.min(sx, sy);
    var x0 = (W - d.span * s) / 2;
    var y0 = H - pad;

    function X(m) { return x0 + m * s; }
    function Y(m) { return y0 - m * s; }

    // On a mono-pitch there is no apex at mid-span: the roof runs from the
    // low eaves straight to the high end. Modelling it as a degenerate
    // "apex" that sits at the high column keeps every downstream use —
    // rafters, purlin dots, haunch, leaders — working unchanged, and makes
    // the drawing agree with the 3D view and the takeoff for the first time.
    var eL = { x: X(0), y: Y(d.eaves) };
    var eR = { x: X(d.span), y: Y(g.mono ? g.ridgeH : d.eaves) };
    var apex = g.mono ? { x: X(d.span), y: Y(g.ridgeH) }
                      : { x: X(d.span / 2), y: Y(g.ridgeH) };

    var parts = [];
    parts.push('<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="none"/>');
    // ground
    parts.push('<line x1="' + (x0 - 26) + '" y1="' + y0 + '" x2="' + (X(d.span) + 26) + '" y2="' + y0 +
      '" stroke="var(--text-muted,#888)" stroke-width="2"/>');
    // slab
    parts.push('<rect x="' + (x0 - 6) + '" y="' + y0 + '" width="' + (d.span * s + 12) +
      '" height="' + Math.max(4, d.slabTh * s) + '" fill="var(--text-muted,#888)" opacity=".45"/>');
    // pad footings under the columns, with the cage inside them. The
    // section drew a slab strip and stopped, so the one part of the
    // structure that is invisible once poured was also the one part the
    // drawing never described.
    if (d.footings && p.hasStruct !== false) {
      var fpw = Math.max(10, d.footW * s), fpd = Math.max(8, d.footD * s);
      var fpy = y0 + Math.max(4, d.slabTh * s);
      [eL.x, eR.x].forEach(function (fx) {
        parts.push('<rect x="' + (fx - fpw / 2) + '" y="' + fpy + '" width="' + fpw +
          '" height="' + fpd + '" fill="var(--text-muted,#888)" opacity=".35" ' +
          'stroke="var(--text-muted,#999)" stroke-width="1"/>');
        if (typeof Rebar !== 'undefined') {
          parts.push(Rebar.overlay(d.rebar, { x: fx - fpw / 2, y: fpy, w: fpw, h: fpd },
            { color: '#c0392b', scale: s }));
        }
      });
    }

    // rafters + roof
    parts.push('<polyline points="' + eL.x + ',' + eL.y + ' ' + apex.x + ',' + apex.y + ' ' +
      eR.x + ',' + eR.y + '" fill="none" stroke="var(--primary,#2d6a4f)" stroke-width="4" ' +
      'stroke-linejoin="round"/>');
    // A lattice truss: its bottom chord, parallel to the roof line.
    var under = (d.rafterType === 'truss') ? d.trussDepth : 0.25;
    if (d.rafterType === 'truss') {
      var dpx = d.trussDepth * s;
      parts.push('<polyline points="' + eL.x + ',' + (eL.y + dpx) + ' ' + apex.x + ',' + (apex.y + dpx) + ' ' +
        eR.x + ',' + (eR.y + dpx) + '" fill="none" stroke="var(--primary,#2d6a4f)" stroke-width="2" ' +
        'stroke-linejoin="round" opacity=".8"/>');
    }
    // columns — to the roof, or to their actual height when they stop short
    // of it (existing poles under a girder). Existing ones are drawn grey.
    var colStroke = d.colExisting ? 'var(--text-muted,#888)' : 'var(--primary,#2d6a4f)';
    var cTopL = d.colH > 0 ? Y(d.colH) : eL.y, cTopR = d.colH > 0 ? Y(d.colH) : eR.y;
    parts.push('<line x1="' + eL.x + '" y1="' + cTopL + '" x2="' + eL.x + '" y2="' + y0 +
      '" stroke="' + colStroke + '" stroke-width="5"/>');
    parts.push('<line x1="' + eR.x + '" y1="' + cTopR + '" x2="' + eR.x + '" y2="' + y0 +
      '" stroke="' + colStroke + '" stroke-width="5"/>');
    // Longitudinal girder along each column line, seen end-on: its top at
    // the underside of the rafter, its depth below.
    var gDd = BP.girderDepth(d);
    if (gDd > 0) {
      [[eL.x, d.eaves], [eR.x, g.mono ? g.ridgeH : d.eaves]].forEach(function (q) {
        var gt = Y(q[1] - under), gh = gDd * s;
        parts.push('<rect x="' + (q[0] - 7) + '" y="' + gt + '" width="14" height="' + gh +
          '" fill="#9a7a58" opacity=".35" stroke="#9a7a58" stroke-width="1.5"/>');
      });
    }
    // A third column line, when specified, stands under the ridge on a
    // gable and at the slope's midpoint on a mono. It was drawn in plan and
    // billed in the takeoff but never appeared in the section.
    if (d.colLines === 3) {
      var midX = X(d.span / 2);
      var midY = g.mono ? Y(d.eaves + g.rise / 2) : Y(g.ridgeH);
      parts.push('<line x1="' + midX + '" y1="' + midY + '" x2="' + midX + '" y2="' + y0 +
        '" stroke="var(--primary,#2d6a4f)" stroke-width="4" stroke-dasharray="7,4"/>');
    }
    // haunch diagonal at each eaves corner. It was named in the callouts
    // but never drawn, so the leader pointed at bare air — worse than no
    // callout, because it says the drawing is wrong rather than terse.
    var hRun = 0, hRise = 0;
    if (d.haunch) {
      hRun = Math.min(d.span * 0.10, 1.2) * s;     // along the rafter
      hRise = Math.min(d.eaves * 0.26, 1.0) * s;   // down the column
      var slopeL = { x: (apex.x - eL.x), y: (apex.y - eL.y) };
      var lenL = Math.sqrt(slopeL.x * slopeL.x + slopeL.y * slopeL.y) || 1;
      parts.push('<line x1="' + eL.x + '" y1="' + (eL.y + hRise) +
        '" x2="' + (eL.x + slopeL.x / lenL * hRun) + '" y2="' + (eL.y + slopeL.y / lenL * hRun) +
        '" stroke="var(--water,#4fc3f7)" stroke-width="2.5"/>');
      // Unit vector from the right-hand column back up its own rafter:
      // toward the apex on a gable, back toward the low column on a mono
      // (where the apex IS this column and the vector would be degenerate).
      var backX, backY;
      if (g.mono) { backX = (eL.x - eR.x); backY = (eL.y - eR.y); }
      else        { backX = (apex.x - eR.x); backY = (apex.y - eR.y); }
      var lenR = Math.sqrt(backX * backX + backY * backY) || 1;
      parts.push('<line x1="' + eR.x + '" y1="' + (eR.y + hRise) +
        '" x2="' + (eR.x + backX / lenR * hRun) + '" y2="' + (eR.y + backY / lenR * hRun) +
        '" stroke="var(--water,#4fc3f7)" stroke-width="2.5"/>');
    }

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
    parts.push(dim(x0, y0 + 22, X(d.span), y0 + 22, BP.n1(d.span) + ' m', 14));
    if (!CAL) parts.push(dim(x0 - 22, y0, x0 - 22, Y(d.eaves), BP.n1(d.eaves) + ' m', 0));

    // ── named members ──────────────────────────────────────────────
    // Each leader points at the member it names, from the margin, so the
    // section reads the way a fabrication drawing reads.
    if (CAL) {
      // purlins: a run on the left slope, called out with its spacing the
      // way a purlin schedule is written — section @ centres in cm.
      var pf = 0.45;
      var purlX = eL.x + (apex.x - eL.x) * pf, purlY = eL.y + (apex.y - eL.y) * pf;
      parts.push(leader(purlX, purlY, x0 - 34, Y(g.ridgeH) - 6, 'l',
        [BP.dsp(d.purlinProfile) + ' @ ' + cm(d.purlinSp)]));

      // rafter: mid-slope on the right
      var rafX = eR.x + (apex.x - eR.x) * 0.5, rafY = eR.y + (apex.y - eR.y) * 0.5;
      parts.push(leader(rafX, rafY, X(d.span) + 34, Y(g.ridgeH) - 6, 'r',
        [BP.tt('קורת גג', 'คาน', 'رافدة'), BP.dsp(d.rafterProfile) +
          (d.rafterType === 'truss' ? ' \u00b7 ' + BP.tt('סבכה', 'โครงถัก', 'جملون') : '')]));

      // haunch, when there is one — the member most often left unnamed and
      // most often the reason a corner does not fit on site. The leader
      // lands on the diagonal drawn above, at its midpoint.
      if (d.haunch) {
        parts.push(leader(eR.x - hRun * 0.42, eR.y + hRise * 0.46,
          X(d.span) + 34, Y(d.eaves * 0.60), 'r',
          [BP.tt('חיזוק פינה', 'ฮันช์', 'تقوية الركن'), BP.dsp(d.haunchProfile || d.rafterProfile)]));
      }

      // Column and girts both go left, rafter and haunch right. Five
      // leaders down one margin overlap each other; split across the two
      // and each has room for its shelf.
      parts.push(leader(eL.x, Y(d.eaves * 0.48), x0 - 34, Y(d.eaves * 0.74), 'l',
        [BP.tt('עמוד', 'เสา', 'عمود'), BP.dsp(d.colProfile)]));

      if (d.wallMode !== 'open' && g.girtRows > 0) {
        parts.push(leader(eL.x + 10, Y(d.eaves / (g.girtRows + 1)), x0 - 34, Y(d.eaves * 0.20), 'l',
          [BP.tt('מסילות קיר', 'แปผนัง', 'مرايش الجدار'),
           BP.dsp(d.girtProfile) + ' @ ' + cm(d.girtSp)]));
      }

      // The cage, named where it is drawn. Without this the reader sees
      // red lines in a grey box and has to guess the bar schedule.
      if (d.footings && typeof Rebar !== 'undefined' && d.rebar && d.rebar.show) {
        parts.push(leader(eL.x, y0 + Math.max(4, d.slabTh * s) + Math.max(8, d.footD * s) * 0.5,
          x0 - 34, y0 - 8, 'l',
          [BP.tt('זיון יסוד', 'เหล็กเสริมฐาน', 'تسليح الأساس'), Rebar.cageLabel(d.rebar)]));
      }

      // height chain: eaves, then the rise to the ridge, then the overall
      var cx = X(d.span) + 118;
      parts.push(dimChainV(cx, y0, [Y(d.eaves), Y(g.ridgeH)],
        [cm(d.eaves), cm(g.ridgeH - d.eaves)], cm(g.ridgeH)));
    }
    var capX = g.mono ? X(d.span * 0.72) : apex.x;
    parts.push('<text x="' + capX + '" y="' + (apex.y - 12) + '" fill="var(--text,#ddd)" ' +
      'font-size="12" font-weight="700" text-anchor="middle">' +
      (CAL ? BP.n1(d.pitch) + '\u00b0' : BP.n1(g.ridgeH) + ' m \u00b7 ' + BP.n1(d.pitch) + '\u00b0') +
      '</text>');

    var section = '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;direction:ltr;" direction="ltr">' +
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
      if (d.colLines === 3) {
        pp.push('<circle cx="' + fx + '" cy="' + (py0 + d.span * ps / 2) + '" r="3.5" fill="var(--accent,#ff9f43)"/>');
      }
    }
    // ridge
    pp.push('<line x1="' + px0 + '" y1="' + (py0 + d.span * ps / 2) + '" x2="' + (px0 + d.length * ps) +
      '" y2="' + (py0 + d.span * ps / 2) + '" stroke="var(--accent,#ff9f43)" stroke-width="1.5" ' +
      'stroke-dasharray="6,4"/>');
    pp.push('<text x="' + (px0 + d.length * ps / 2) + '" y="' + (py0 + d.span * ps + 22) +
      '" fill="var(--text,#ddd)" font-size="12" font-weight="700" text-anchor="middle">' +
      BP.n1(d.length) + ' m \u00b7 ' + g.frames + ' ' + BP.tt('מסגרות', 'เฟรม', 'إطارات') +
      ' @ ' + BP.n1(g.actualBay) + ' m</text>');

    var plan = '<svg viewBox="0 0 ' + PW + ' ' + PH + '" style="width:100%;height:auto;direction:ltr;" direction="ltr">' +
      pp.join('') + '</svg>';

    return '<div class="bp-draw">' + section + '</div>' +
           '<div class="bp-draw" style="margin-top:8px;">' + plan + '</div>';
  };

  // ── פרט זיון ─────────────────────────────────────────────────────────
  // The full detail at its own scale, section and plan, for the design
  // panel and the printed sheet. Geometry comes from the project so the
  // detail is of THIS foundation, not a generic one: pad side and depth
  // from the footing inputs, post size read off the column profile.
  BP.rebarSvg = function rebarSvg(p, opt) {
    if (typeof Rebar === 'undefined') return '';
    var d = p.dims;
    if (p.type === 'slab' || !d.footings) return '';
    // 'SHS 100x100x4' → 0.10 m. A section name is the only place the post
    // width is recorded, so it is parsed rather than stored twice.
    var mm = String(d.colProfile || '').match(/(\d{2,4})\s*[xX\u00d7]/);
    var postW = mm ? Math.min(0.6, Number(mm[1]) / 1000) : 0.16;
    return Rebar.detailSvg(d.rebar, {
      w: d.footW, d: d.footD, postW: postW,
      title: BP.tt('פרט זיון יסוד עמוד', 'รายละเอียดเหล็กเสริมฐานเสา', 'تفصيل تسليح أساس العمود')
    }, opt || {});
  };

  function slabSvg(p) {
    var d = p.dims;
    var a = BP.slabArea(p);
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
      BP.n1(a) + ' \u05de"\u05e8 \u00b7 ' + d.slabTh + ' \u05de\'</text>');
    out.push('<text x="' + (x0 + sLen * s / 2) + '" y="' + (y0 + sWid * s + 24) +
      '" fill="var(--text-muted,#aaa)" font-size="12" text-anchor="middle">' +
      BP.n2(a * d.slabTh) + ' \u05de"\u05e7 ' + BP.tt('בטון', 'คอนกรีต', 'خرسانة') + '</text>');
    // The blue grid above has always been drawn. Now it says what it is —
    // Q188 sheets and a tied #Ø10@15 mat are different products at
    // different prices, and the drawing was silent about which.
    if (typeof Rebar !== 'undefined' && d.rebar && d.rebar.show) {
      var ml = Rebar.slabLabel(d.rebar);
      if (ml) {
        out.push('<text x="' + (x0 + sLen * s / 2) + '" y="' + (y0 + sWid * s + 40) +
          '" fill="var(--water,#4fc3f7)" font-size="11.5" font-weight="700" text-anchor="middle">' +
          BP.esc(BP.dsp(ml)) + '</text>');
      }
    }
    return '<div class="bp-draw"><svg viewBox="0 0 ' + W + ' ' + H +
      '" style="width:100%;height:auto;direction:ltr;" direction="ltr">' + out.join('') + '</svg></div>';
  }


  // ══════════════════════════════════════════════════════════════════
  //  TRUSS + GIRDER SHEET (full print)
  // ══════════════════════════════════════════════════════════════════
  // The takeoff bills a lattice truss as top chord, bottom chord and a
  // Pratt web on ~1.17 m panels, and a longitudinal girder as two chords
  // and a Pratt web on ~1 m panels. This draws exactly those members, with
  // the same panel counts and lengths, plus a cut list — so the welder
  // builds what was priced.
  function trussGeo(d) {
    var g = BP.geom(d);
    var tPan = Math.max(4, Math.round(g.rafterLen / 1.17));
    return { g: g, tPan: tPan, tPL: g.rafterLen / tPan, tD: d.trussDepth };
  }
  function lineS(x1, y1, x2, y2, c, w) {
    return '<line x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) + '" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) +
      '" stroke="' + c + '" stroke-width="' + w + '" stroke-linecap="round"/>';
  }
  function textS(x, y, t, sz, anchor, bold, c) {
    return '<text x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" font-size="' + (sz || 11) + '" text-anchor="' + (anchor || 'middle') +
      '" font-family="ui-monospace,Menlo,Consolas,monospace"' + (bold ? ' font-weight="700"' : '') + ' fill="' + (c || '#222') + '">' + BP.esc(t) + '</text>';
  }
  function dimS(x1, x2, y, t, sz) {
    return lineS(x1, y, x2, y, '#555', 0.8) + lineS(x1 - 3, y + 3, x1 + 3, y - 3, '#555', 1) + lineS(x2 - 3, y + 3, x2 + 3, y - 3, '#555', 1) +
      textS((x1 + x2) / 2, y - 3, t, sz || 9);
  }
  // One truss, drawn along its own axis: chords, node numbers, a Pratt web
  // that turns at mid-span, panel dimensions, overall length and depth.
  BP.trussSvg = function trussSvg(p) {
    var d = p.dims, t = trussGeo(d), L = t.g.rafterLen;
    var W = 900, pad = 40, sc = (W - pad - 90) / L, H = Math.max(150, t.tD * sc + 110);
    var X = function (u) { return pad + u * sc; }, Y = function (v) { return 30 + (t.tD - v) * sc; };
    var o = [], half = Math.floor(t.tPan / 2);
    o.push(lineS(X(0), Y(t.tD), X(L), Y(t.tD), '#1f3a5f', 3));
    o.push(lineS(X(0), Y(0), X(L), Y(0), '#1f3a5f', 3.4));
    for (var k = 0; k <= t.tPan; k++) {
      o.push(lineS(X(k * t.tPL), Y(0), X(k * t.tPL), Y(t.tD), '#3d6fa8', 1.4));
      o.push(textS(X(k * t.tPL), Y(t.tD) - 7, String(k), 9));
    }
    for (k = 0; k < t.tPan; k++) {
      var a = k * t.tPL, b = (k + 1) * t.tPL;
      o.push(k < half ? lineS(X(a), Y(t.tD), X(b), Y(0), '#3d6fa8', 1.4) : lineS(X(a), Y(0), X(b), Y(t.tD), '#3d6fa8', 1.4));
    }
    for (k = 0; k < t.tPan; k++) o.push(dimS(X(k * t.tPL), X((k + 1) * t.tPL), Y(0) + 18, t.tPL.toFixed(3), 8));
    o.push(dimS(X(0), X(L), Y(0) + 40, L.toFixed(3) + ' m', 10));
    o.push(lineS(X(L) + 18, Y(t.tD), X(L) + 18, Y(0), '#555', 0.8));
    o.push(textS(X(L) + 30, (Y(t.tD) + Y(0)) / 2 + 4, t.tD.toFixed(2), 9, 'start'));
    return '<svg viewBox="0 0 ' + W + ' ' + Math.round(H) + '" style="width:100%;height:auto;direction:ltr;" direction="ltr">' + o.join('') + '</svg>';
  };
  // The longitudinal girders, one elevation per column line: columns
  // where they stand, chords, a Pratt web turning at the middle of each
  // span between columns, the frames bearing on top.
  BP.girderSvg = function girderSvg(p) {
    var d = p.dims, g = BP.geom(d), gD = BP.girderDepth(d);
    if (!(gD > 0)) return '';
    var gPan = Math.max(2, Math.round(d.length / 1.0)), gPL = d.length / gPan;
    var W = 900, pad = 40, sc = (W - 2 * pad) / d.length, H = gD * sc + 120;
    var X = function (u) { return pad + u * sc; }, Y = function (v) { return 34 + (gD - v) * sc; };
    var o = [];
    o.push(lineS(X(0), Y(gD), X(d.length), Y(gD), '#1f3a5f', 2.6));
    o.push(lineS(X(0), Y(0), X(d.length), Y(0), '#1f3a5f', 2.6));
    for (var k = 0; k <= gPan; k++) o.push(lineS(X(k * gPL), Y(0), X(k * gPL), Y(gD), '#3d6fa8', 1));
    var cf = g.colFrameIdx.map(function (i) { return i * g.actualBay; });
    for (var j = 0; j + 1 < cf.length; j++) {
      var n = Math.round((cf[j + 1] - cf[j]) / gPL), h = Math.floor(n / 2);
      for (k = 0; k < n; k++) {
        var a = cf[j] + k * gPL, b = a + gPL;
        o.push(k < h ? lineS(X(a), Y(gD), X(b), Y(0), '#3d6fa8', 1) : lineS(X(a), Y(0), X(b), Y(gD), '#3d6fa8', 1));
      }
      o.push(dimS(X(cf[j]), X(cf[j + 1]), Y(0) + 48, (cf[j + 1] - cf[j]).toFixed(2), 9));
    }
    cf.forEach(function (x) { o.push('<rect x="' + (X(x) - 5).toFixed(1) + '" y="' + Y(0).toFixed(1) + '" width="10" height="30" fill="#bbb" stroke="#555"/>'); });
    for (var f = 0; f < g.frames; f++) {
      var x = f * g.actualBay;
      o.push('<rect x="' + (X(x) - 3).toFixed(1) + '" y="' + (Y(gD) - 22).toFixed(1) + '" width="6" height="22" fill="#dfe7f1" stroke="#1f3a5f"/>');
      o.push(textS(X(x), Y(gD) - 27, String(f + 1), 9, 'middle', true));
    }
    o.push(dimS(X(0), X(d.length), Y(0) + 70, d.length.toFixed(2) + ' m · ' + gPan + ' × ' + gPL.toFixed(2), 10));
    return '<svg viewBox="0 0 ' + W + ' ' + Math.round(H) + '" style="width:100%;height:auto;direction:ltr;" direction="ltr">' + o.join('') + '</svg>';
  };
  // Cut list for one truss and one girder, lengths as drawn.
  BP.trussCutList = function trussCutList(p, part) {
    var d = p.dims, t = trussGeo(d), g = t.g, rows = [];
    var wantT = part !== 'girder', wantG = part !== 'truss';
    var diag = Math.sqrt(t.tPL * t.tPL + t.tD * t.tD);
    var nT = g.frames * g.slopes;
    if (wantT) rows.push([BP.tt('אגד · חגורה עליונה', 'โครงถัก · คอร์ดบน', 'جملون · وتر علوي'), d.rafterProfile, 1, g.rafterLen, nT]);
    if (wantT) rows.push([BP.tt('אגד · חגורה תחתונה', 'โครงถัก · คอร์ดล่าง', 'جملون · وتر سفلي'), d.trussBotProfile, 1, g.rafterLen, nT]);
    if (wantT) rows.push([BP.tt('אגד · ניצבים', 'โครงถัก · ตั้ง', 'جملون · قوائم'), d.trussWebProfile || d.trussBotProfile, t.tPan + 1, t.tD, nT]);
    if (wantT) rows.push([BP.tt('אגד · אלכסונים', 'โครงถัก · ทแยง', 'جملون · أقطار'), d.trussWebProfile || d.trussBotProfile, t.tPan, diag, nT]);
    var gD = BP.girderDepth(d);
    if (gD > 0 && wantG) {
      var gPan = Math.max(2, Math.round(d.length / 1.0)), gPL = d.length / gPan, nG = (d.colLines === 3 ? 3 : 2);
      rows.push([BP.tt('קורת אורך · חגורות', 'คานตามยาว · คอร์ด', 'عارضة طولية · أوتار'), d.girderProfile || d.rafterProfile, 2, d.length, nG]);
      rows.push([BP.tt('קורת אורך · ניצבים', 'คานตามยาว · ตั้ง', 'عارضة طولية · قوائم'), d.trussWebProfile || d.girderProfile, gPan + 1, gD, nG]);
      rows.push([BP.tt('קורת אורך · אלכסונים', 'คานตามยาว · ทแยง', 'عارضة طولية · أقطار'), d.trussWebProfile || d.girderProfile, gPan, Math.sqrt(gPL * gPL + gD * gD), nG]);
    }
    return '<table><thead><tr><th>' + BP.tt('חלק', 'ชิ้น', 'جزء') + '</th><th>' + BP.tt('פרופיל', 'หน้าตัด', 'مقطع') + '</th><th>' +
      BP.tt('יח\' ליחידה', 'ต่อชุด', 'لكل وحدة') + '</th><th>' + BP.tt('אורך (מ\')', 'ยาว (ม.)', 'طول (م)') + '</th><th>' +
      BP.tt('יחידות', 'ชุด', 'وحدات') + '</th><th>' + BP.tt('סה"כ מ\' (ללא פחת)', 'รวม ม.', 'المجموع م') + '</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td>' + BP.esc(r[0]) + '</td><td dir="ltr">' + BP.esc(r[1]) + '</td><td>' + r[2] + '</td><td>' + r[3].toFixed(3) +
          '</td><td>' + r[4] + '</td><td>' + BP.n1(r[2] * r[3] * r[4]) + '</td></tr>';
      }).join('') + '</tbody></table>';
  };

  // The pieces the steel is actually cut into, per profile — what a
  // fabricator buys stock bars for. Same geometry as the takeoff (panel
  // counts, lengths), without the waste factor: waste is what the bar
  // optimiser finds, not a percentage. A long member is split at a frame
  // or column so it can be spliced over a support (purlins, girder chords);
  // a truss chord longer than the bar is reported with its splice.
  BP.cutPieces = function cutPieces(p) {
    var d = p.dims, out = [];
    if (!d || p.type === 'slab' || p.hasStruct === false || p.source === 'plan') return out;
    var g = BP.geom(d);
    function add(profile, len, count, part) {
      if (!profile || !(len > 0) || !(count > 0)) return;
      out.push({ profile: profile, len: Math.round(len * 1000) / 1000, count: count, part: part });
    }
    // Split a run of `total` at the given support positions into pieces no
    // longer than `max`, cutting at the last support that still fits.
    function splitRun(total, supports, max) {
      var cuts = [], start = 0;
      while (total - start > max + 1e-6) {
        var best = null;
        supports.forEach(function (s) { if (s > start + 1e-6 && s - start <= max + 1e-6) best = s; });
        if (best == null) best = start + max;
        cuts.push(best - start); start = best;
      }
      cuts.push(total - start);
      return cuts;
    }
    var frames = [], colAt = [];
    for (var i = 0; i < g.frames; i++) frames.push(i * g.actualBay);
    g.colFrameIdx.forEach(function (fi) { colAt.push(fi * g.actualBay); });
    var nT = g.frames * g.slopes;
    if (d.rafterType === 'truss' && d.trussBotProfile) {
      var tPan = Math.max(4, Math.round(g.rafterLen / 1.17)), tPL = g.rafterLen / tPan, tD = d.trussDepth;
      add(d.rafterProfile, g.rafterLen, nT, 'truss-top');
      add(d.trussBotProfile, g.rafterLen, nT, 'truss-bottom');
      var web = d.trussWebProfile || d.trussBotProfile;
      add(web, tD, nT * (tPan + 1), 'truss-vertical');
      add(web, Math.sqrt(tPL * tPL + tD * tD), nT * tPan, 'truss-diagonal');
    } else {
      add(d.rafterProfile, g.rafterLen, nT, 'rafter');
    }
    var gD = BP.girderDepth(d);
    if (gD > 0) {
      var nG = d.colLines === 3 ? 3 : 2, gPan = Math.max(2, Math.round(d.length / 1.0)), gPL = d.length / gPan;
      splitRun(d.length, colAt.length > 1 ? colAt : frames, 12).forEach(function (L) {
        add(d.girderProfile || d.rafterProfile, L, nG * 2, 'girder-chord');
      });
      var gw = d.trussWebProfile || d.girderProfile || d.rafterProfile;
      add(gw, gD, nG * (gPan + 1), 'girder-vertical');
      add(gw, Math.sqrt(gPL * gPL + gD * gD), nG * gPan, 'girder-diagonal');
    }
    var rows = g.purlinRuns * g.slopes;
    splitRun(d.length, frames, 12).forEach(function (L) { add(d.purlinProfile, L, rows, 'purlin'); });
    if (d.haunch) {
      var hRun = Math.min(d.span * 0.10, 1.2), hRise = Math.min(d.eaves * 0.26, 1.0);
      add(d.haunchProfile || d.rafterProfile, Math.sqrt(hRun * hRun + hRise * hRise), g.colFrames * 2, 'knee');
    }
    if (!d.colExisting) {
      g.colH.forEach(function (h) { add(d.colProfile, h, g.colFrames, 'column'); });
    }
    return out;
  };

  // Plan of the structure seen from above: column lines and the columns
  // that stand, frames/trusses on every axis, the girders, purlin rows, and
  // the roof bracing the takeoff bills (an X per panel in each end bay).
  BP.roofPlanSvg = function roofPlanSvg(p) {
    var d = p.dims, g = BP.geom(d);
    var W = 900, padL = 60, padR = 70, padT = 50, sc = (W - padL - padR) / d.length;
    var H = padT + d.span * sc + 90;
    var X = function (y) { return padL + y * sc; }, Y = function (x) { return padT + x * sc; };
    var o = [];
    o.push('<rect x="' + X(0) + '" y="' + Y(0) + '" width="' + (d.length * sc).toFixed(1) + '" height="' + (d.span * sc).toFixed(1) + '" fill="#f4f1ea" stroke="#bbb"/>');
    var lines = d.colLines === 3 ? [0, d.span / 2, d.span] : [0, d.span];
    var mono = d.roofType === 'mono';
    // purlin rows, projected on plan
    for (var s = 0; s < g.slopes; s++) {
      for (var k = 0; k < g.purlinRuns; k++) {
        var f = k / Math.max(1, g.purlinRuns - 1);
        var xs = mono ? f * d.span : (s === 0 ? f * d.span / 2 : d.span / 2 + f * d.span / 2);
        o.push(lineS(X(0), Y(xs), X(d.length), Y(xs), '#b5651d', 1.1));
      }
    }
    // roof bracing in the end bays
    if (d.bracing) {
      var cB = Math.min(2, Math.max(1, g.bays)), ends = cB >= 2 ? [0, g.bays - 1] : [0];
      var panels = d.colLines === 3 ? 2 : 1, pw = d.span / panels;
      ends.forEach(function (b) {
        for (var q = 0; q < panels; q++) {
          var y0 = b * g.actualBay, y1 = y0 + g.actualBay, x0 = q * pw, x1 = x0 + pw;
          o.push(lineS(X(y0), Y(x0), X(y1), Y(x1), '#2e7d32', 1.2));
          o.push(lineS(X(y0), Y(x1), X(y1), Y(x0), '#2e7d32', 1.2));
        }
      });
    }
    // girders along the column lines
    if (BP.girderDepth(d) > 0) lines.forEach(function (x) { o.push(lineS(X(0), Y(x), X(d.length), Y(x), '#1f3a5f', 4)); });
    // frames / trusses on every axis
    for (var i = 0; i < g.frames; i++) {
      var y = i * g.actualBay;
      o.push(lineS(X(y), Y(0), X(y), Y(d.span), '#1f3a5f', 3));
      o.push('<circle cx="' + X(y).toFixed(1) + '" cy="' + (Y(0) - 26).toFixed(1) + '" r="9" fill="#fff" stroke="#333"/>');
      o.push(textS(X(y), Y(0) - 22, String(i + 1), 10, 'middle', true));
    }
    // columns where they stand
    g.colFrameIdx.forEach(function (fi) {
      lines.forEach(function (x) {
        o.push('<circle cx="' + X(fi * g.actualBay).toFixed(1) + '" cy="' + Y(x).toFixed(1) + '" r="5.5" fill="' + (d.colExisting ? '#bbb' : '#555') + '" stroke="#000"/>');
      });
    });
    var LET = 'ABC';
    lines.forEach(function (x, j) {
      o.push('<circle cx="' + (X(0) - 30) + '" cy="' + Y(x).toFixed(1) + '" r="9" fill="#fff" stroke="#333"/>');
      o.push(textS(X(0) - 30, Y(x) + 4, LET[j], 10, 'middle', true));
    });
    for (i = 0; i < g.bays; i++) o.push(dimS(X(i * g.actualBay), X((i + 1) * g.actualBay), Y(d.span) + 26, g.actualBay.toFixed(2), 9));
    o.push(dimS(X(0), X(d.length), Y(d.span) + 50, d.length.toFixed(2) + ' m', 10));
    o.push(lineS(X(d.length) + 34, Y(0), X(d.length) + 34, Y(d.span), '#555', 0.8));
    o.push(textS(X(d.length) + 44, (Y(0) + Y(d.span)) / 2, d.span.toFixed(2) + ' m', 10, 'start'));
    return '<svg viewBox="0 0 ' + W + ' ' + Math.round(H) + '" style="width:100%;height:auto;direction:ltr;" direction="ltr">' + o.join('') + '</svg>';
  };

})(BuildPlanInternals);
