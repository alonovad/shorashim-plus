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
    // columns
    parts.push('<line x1="' + eL.x + '" y1="' + eL.y + '" x2="' + eL.x + '" y2="' + y0 +
      '" stroke="var(--primary,#2d6a4f)" stroke-width="5"/>');
    parts.push('<line x1="' + eR.x + '" y1="' + eR.y + '" x2="' + eR.x + '" y2="' + y0 +
      '" stroke="var(--primary,#2d6a4f)" stroke-width="5"/>');
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
      parts.push('<line x1="' + eR.x + '" y1="' + (eR.y + hRise) +
        '" x2="' + (eR.x - slopeL.x / lenL * hRun) + '" y2="' + (eR.y + slopeL.y / lenL * hRun) +
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
          [BP.tt('חיזוק פינה', 'ฮันช์', 'تقوية الركن'), BP.dsp(d.rafterProfile)]));
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
    parts.push('<text x="' + apex.x + '" y="' + (apex.y - 12) + '" fill="var(--text,#ddd)" ' +
      'font-size="12" font-weight="700" text-anchor="middle">' +
      (CAL ? BP.n1(d.pitch) + '\u00b0' : BP.n1(g.ridgeH) + ' m \u00b7 ' + BP.n1(d.pitch) + '\u00b0') +
      '</text>');

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
      BP.n1(d.length) + ' m \u00b7 ' + g.frames + ' ' + BP.tt('מסגרות', 'เฟรม', 'إطارات') +
      ' @ ' + BP.n1(g.actualBay) + ' m</text>');

    var plan = '<svg viewBox="0 0 ' + PW + ' ' + PH + '" style="width:100%;height:auto;">' +
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
      '" style="width:100%;height:auto;">' + out.join('') + '</svg></div>';
  }


})(BuildPlanInternals);
