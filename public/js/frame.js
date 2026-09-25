/* frame.js — a building as a grid and its members.
 *
 * WHY THIS EXISTS
 *   A project used to be one flat `dims` object: one span, one pitch, one
 *   column section for every column. An engineer's frame is not like that.
 *   Ran Shatah's R-1 for Na'aran has corner columns in RHS 150/150/6.3 and
 *   the rest in RHS 120/120/5, main beams IPN 160 but edge beams IPN 120,
 *   cable bracing in the four end bays only, and a roof that falls 0.50 m
 *   over 14 m. None of that fits in `dims`, so a reader that understood the
 *   drawing perfectly still had nowhere to put what it read.
 *
 *   And because the section, the 3D and the quantities each derived their
 *   own geometry from `dims`, they could disagree — the mono-pitch roof was
 *   drawn as a gable in one view and billed as a gable in another.
 *
 * THE MODEL
 *   Named axes at explicit positions (1..5 along the length, A..C across),
 *   a height per lettered line, a section per member role, and overrides
 *   per element. Every element has an id (col:A1, beam:3, edge:A:1-2,
 *   purlin:4, knee:C5, cable:1-2:A, foot:B3), and the 3D, the plan, the
 *   section and the quantities are all VIEWS of that one model. They
 *   cannot disagree, and any element can be changed on its own.
 *
 * PROVENANCE
 *   Every value remembers where it came from: read off the drawing
 *   (📄), typed by the user (✋), or missing (⚠). Nothing is ever filled
 *   with a default to make a drawing look complete. A missing purlin
 *   spacing means no purlins are drawn and a warning says why — it does
 *   not mean 1.5 m appears from nowhere and reaches a quote.
 *
 * READING
 *   The engineer's PDFs carry no text at all — every label is stroked
 *   line geometry (DWG export with SHX fonts), so nothing can be parsed.
 *   And a whole A3 sheet sent as one image shrinks a 1:50 label to a few
 *   pixels. So the sheet is rendered here at ~300 dpi with pdf.js and sent
 *   as an overview plus overlapping full-resolution tiles.
 *
 * Globals: Frame. Reads BuildPlanInternals (BP) and Shed3D at call time.
 */
var Frame = (function () {
  'use strict';

  function BPI() { return window.BuildPlanInternals || {}; }
  function tt(he, th, ar) { var B = BPI(); return B.tt ? B.tt(he, th, ar) : he; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function num(v) { var n = Number(v); return (v === '' || v == null || !isFinite(n)) ? null : n; }
  function r2(v) { return Math.round(v * 100) / 100; }
  function cm(v) { return String(Math.round(v * 100)); }
  function isArr(a) { return Array.isArray(a); }

  // ══════════════════════════════════════════════════════════════════
  //  MODEL
  // ══════════════════════════════════════════════════════════════════

  var ROLES = ['column', 'beam', 'edge', 'purlin', 'knee', 'cable', 'footing'];
  var ROLE_HE = {
    column: 'עמודים', beam: 'קורות ראשיות', edge: 'קורות היקף', purlin: 'מרישים',
    knee: 'דיאגונלים', cable: 'כבלי הקשחה', footing: 'יסודות'
  };
  var ROLE_COLOR = {
    column: '#6b4f3a', beam: '#7a5a42', edge: '#9a7a58', purlin: '#c9a227',
    knee: '#8e8e8e', cable: '#4a4a4a', footing: '#7d6b58'
  };
  // Sections worth offering in the picker. The field stays free text: the
  // drawing's own label is always the truth, whatever it says.
  var COMMON = ['RHS 80/80/4', 'RHS 100/100/5', 'RHS 120/120/5', 'RHS 150/150/6.3',
    'SHS 100x100x4', 'SHS 120x120x5', 'IPN 120', 'IPN 140', 'IPN 160', 'IPN 180', 'IPN 200',
    'IPE 160', 'IPE 200', 'IPE 240', 'HEA 160', 'HEA 200', 'P60-120/60/3.6', 'Z 150x2.0',
    'Z 200x2.0', 'C 150x2.5', 'cable 8mm', 'cable 10mm'];

  function blank(name) {
    return {
      v: 1, name: String(name || ''),
      x: [], y: [], h: {},
      sec: { column: '', beam: '', edge: '', purlin: '', knee: '', cable: '' },
      purlinSp: null,
      knee: { drop: null, run: null },
      braced: [], braceDepth: null,
      foot: { w: null, l: null, t: null, below: null, ped: null, blind: null, plate: '', anchors: '', count: null },
      ov: {}, off: {}, src: {}, ev: [], conf: '', check: {}
    };
  }

  // A model arriving from Firestore may be partial or from an older shape.
  // Coerce, never invent.
  function norm(f) {
    var b = blank(f && f.name);
    if (!f || typeof f !== 'object') return b;
    function axes(a) {
      return (isArr(a) ? a : []).map(function (q) {
        return { n: String((q && q.n) || ''), p: num(q && q.p) };
      }).filter(function (q) { return q.n; });
    }
    b.x = axes(f.x); b.y = axes(f.y);
    if (f.h && typeof f.h === 'object') Object.keys(f.h).forEach(function (k) {
      var v = num(f.h[k]); if (v != null) b.h[k] = v;
    });
    if (f.sec) Object.keys(b.sec).forEach(function (k) { b.sec[k] = String(f.sec[k] || ''); });
    b.purlinSp = num(f.purlinSp);
    if (f.knee) { b.knee.drop = num(f.knee.drop); b.knee.run = num(f.knee.run); }
    b.braced = isArr(f.braced) ? f.braced.map(String) : [];
    b.braceDepth = num(f.braceDepth);
    if (f.foot) Object.keys(b.foot).forEach(function (k) {
      b.foot[k] = (k === 'plate' || k === 'anchors') ? String(f.foot[k] || '') : num(f.foot[k]);
    });
    b.ov = (f.ov && typeof f.ov === 'object') ? f.ov : {};
    b.off = (f.off && typeof f.off === 'object') ? f.off : {};
    b.src = (f.src && typeof f.src === 'object') ? f.src : {};
    b.ev = isArr(f.ev) ? f.ev.map(String) : [];
    b.conf = String(f.conf || '');
    b.check = (f.check && typeof f.check === 'object') ? f.check : {};
    return b;
  }

  // ── from the reader ─────────────────────────────────────────────────
  // Takes the reader's report and keeps ONLY what it actually read. The
  // richer `frame` block is preferred; the older `structure` block is
  // accepted so documents read before this change still open.
  function fromReport(rep, name) {
    var f = blank(name), S = f.src;
    if (!rep || typeof rep !== 'object') return f;
    var fr = rep.frame, st = rep.structure;

    function axesFrom(list, total, count, spacing, letters) {
      var out = [];
      if (isArr(list) && list.length >= 2) {
        var named = list.map(function (a, i) {
          return { n: String((a && a.name) || (letters ? String.fromCharCode(65 + i) : String(i + 1))), p: num(a && a.pos) };
        });
        if (named.every(function (a) { return a.p != null; })) return named;
        // Names without positions: usable only if a spacing was read.
        if (spacing) return named.map(function (a, i) { return { n: a.n, p: r2(i * spacing) }; });
        return named.map(function (a) { return { n: a.n, p: null }; });
      }
      if (count >= 2 && (spacing || total)) {
        var sp = spacing || (total / (count - 1));
        for (var i = 0; i < count; i++) {
          out.push({ n: letters ? String.fromCharCode(65 + i) : String(i + 1), p: r2(i * sp) });
        }
      }
      return out;
    }

    if (fr && typeof fr === 'object') {
      f.x = axesFrom(fr.axesX, num(fr.totalX), 0, num(fr.bayX), false);
      f.y = axesFrom(fr.axesY, num(fr.totalY), 0, num(fr.bayY), true);
      if (f.x.length) S.x = 'read';
      if (f.y.length) S.y = 'read';
      (isArr(fr.heights) ? fr.heights : []).forEach(function (q) {
        var v = num(q && q.h); if (q && q.line && v != null) { f.h[String(q.line)] = v; S['h.' + q.line] = 'read'; }
      });
      var sc = fr.sections || {};
      [['column', 'column'], ['beam', 'mainBeam'], ['edge', 'edgeBeam'], ['purlin', 'purlin'],
       ['knee', 'kneeBrace'], ['cable', 'bracing']].forEach(function (m) {
        if (sc[m[1]]) { f.sec[m[0]] = String(sc[m[1]]); S['sec.' + m[0]] = 'read'; }
      });
      if (num(fr.purlinSp) != null) { f.purlinSp = num(fr.purlinSp); S.purlinSp = 'read'; }
      if (num(fr.kneeDrop) != null) { f.knee.drop = num(fr.kneeDrop); S['knee.drop'] = 'read'; }
      if (num(fr.kneeRun) != null)  { f.knee.run = num(fr.kneeRun);   S['knee.run'] = 'read'; }
      if (isArr(fr.bracedBays)) { f.braced = fr.bracedBays.map(String); S.braced = 'read'; }
      if (num(fr.braceDepth) != null) { f.braceDepth = num(fr.braceDepth); S.braceDepth = 'read'; }
      (isArr(fr.exceptions) ? fr.exceptions : []).forEach(function (e) {
        if (!e || !e.ref || !e.section) return;
        var id = (e.role === 'column' || !e.role) ? 'col:' + e.ref : e.role + ':' + e.ref;
        f.ov[id] = f.ov[id] || {}; f.ov[id].sec = String(e.section); S['ov.' + id] = 'read';
      });
      takeFoot(f, fr.footing);
      f.ev = isArr(fr.evidence) ? fr.evidence.map(String) : [];
      f.conf = String(fr.confidence || '');
      // The drawing's printed overall dimension, kept to check the chain.
      f.check.totalX = num(fr.totalX); f.check.totalY = num(fr.totalY);
    } else if (st && typeof st === 'object' && st.present !== false) {
      var cpl = num(st.colsPerLine), lines = num(st.lines);
      f.x = axesFrom(null, num(st.length), cpl, num(st.bay), false);
      f.y = axesFrom(null, num(st.span), lines, null, true);
      if (f.x.length) S.x = 'read';
      if (f.y.length) S.y = 'read';
      var eav = num(st.eaves), rid = num(st.ridge);
      if (f.y.length && eav != null) {
        var n = f.y.length;
        f.y.forEach(function (a, i) {
          var h = eav;
          if (rid != null && st.roofType === 'mono') h = rid + (eav - rid) * (i / (n - 1));
          else if (rid != null && st.roofType === 'gable') {
            var t = 1 - Math.abs(i / (n - 1) - 0.5) * 2; h = eav + (rid - eav) * t;
          }
          f.h[a.n] = r2(h); S['h.' + a.n] = 'read';
        });
      }
      [['column', 'colProfile'], ['beam', 'rafterProfile'], ['purlin', 'purlinProfile'],
       ['knee', 'cornerBrace'], ['cable', 'braceMember']].forEach(function (m) {
        if (st[m[1]]) { f.sec[m[0]] = String(st[m[1]]); S['sec.' + m[0]] = 'read'; }
      });
      if (num(st.purlinSp) != null) { f.purlinSp = num(st.purlinSp); S.purlinSp = 'read'; }
      if (st.basePlate) { f.foot.plate = String(st.basePlate); S['foot.plate'] = 'read'; }
      if (st.anchorBolts) { f.foot.anchors = String(st.anchorBolts); S['foot.anchors'] = 'read'; }
      f.conf = String(st.confidence || '');
    }
    // A pad in the element list is the footing, whichever block the frame
    // came from.
    var pad = (isArr(rep.elements) ? rep.elements : []).filter(function (e) { return e && e.kind === 'pad'; })[0];
    if (pad) takeFoot(f, { w: pad.w, l: pad.l, t: pad.h, below: pad.below, count: pad.count,
      blind: pad.blind ? 0.05 : null });
    return f;
  }

  function takeFoot(f, ft) {
    if (!ft || typeof ft !== 'object') return;
    ['w', 'l', 't', 'below', 'ped', 'blind', 'count'].forEach(function (k) {
      var v = num(ft[k]);
      if (v != null && f.foot[k] == null) { f.foot[k] = v; f.src['foot.' + k] = 'read'; }
    });
    ['plate', 'anchors'].forEach(function (k) {
      if (ft[k] && !f.foot[k]) { f.foot[k] = String(ft[k]); f.src['foot.' + k] = 'read'; }
    });
  }

  // Fill what is still missing in `f` from another document's reading —
  // the foundation sheet completing the geometry sheet. Never overwrites a
  // value that is already there, read or typed.
  function merge(f, g, fromName) {
    var took = [];
    if (!f.x.length && g.x.length) { f.x = g.x; f.src.x = 'read'; took.push('x'); }
    if (!f.y.length && g.y.length) { f.y = g.y; f.src.y = 'read'; took.push('y'); }
    Object.keys(g.h).forEach(function (k) { if (f.h[k] == null) { f.h[k] = g.h[k]; f.src['h.' + k] = 'read'; took.push('h.' + k); } });
    Object.keys(f.sec).forEach(function (k) { if (!f.sec[k] && g.sec[k]) { f.sec[k] = g.sec[k]; f.src['sec.' + k] = 'read'; took.push(k); } });
    if (f.purlinSp == null && g.purlinSp != null) { f.purlinSp = g.purlinSp; f.src.purlinSp = 'read'; took.push('purlinSp'); }
    Object.keys(f.foot).forEach(function (k) {
      var empty = (k === 'plate' || k === 'anchors') ? !f.foot[k] : f.foot[k] == null;
      var has = (k === 'plate' || k === 'anchors') ? !!g.foot[k] : g.foot[k] != null;
      if (empty && has) { f.foot[k] = g.foot[k]; f.src['foot.' + k] = 'read'; took.push('foot.' + k); }
    });
    if (took.length) f.ev.push('\u2190 ' + fromName + ': ' + took.join(', '));
    return took.length;
  }

  // ── geometry helpers ────────────────────────────────────────────────
  function ready(f) { return f.x.length >= 2 && f.y.length >= 2 &&
    f.x.every(function (a) { return a.p != null; }) && f.y.every(function (a) { return a.p != null; }); }
  function sorted(a) { return a.slice().sort(function (p, q) { return p.p - q.p; }); }
  function nodeH(f, yn, xn) {
    var o = f.ov['col:' + yn + xn];
    if (o && num(o.h) != null) return num(o.h);
    return f.h[yn] != null ? f.h[yn] : null;
  }
  function secOf(f, role, id) {
    var o = f.ov[id];
    return (o && o.sec) ? String(o.sec) : (f.sec[role] || '');
  }

  // Section label → visual depth/width in metres. Visual only: the takeoff
  // bills by label, never by this estimate.
  function secDims(s) {
    s = String(s || '').toUpperCase();
    var m;
    if (/CABLE|כבל/.test(s)) {
      m = s.match(/(\d+(?:\.\d+)?)\s*MM/); var d = (m ? +m[1] : 8) / 1000;
      return { h: d, b: d, cable: true };
    }
    m = s.match(/(\d+(?:\.\d+)?)\s*[\/X\u00d7]\s*(\d+(?:\.\d+)?)/);
    if (m) {
      var h = +m[1] / 1000, b = +m[2] / 1000;
      if (b < 0.02) b = h * 0.35;            // Z 200x2.0: the 2.0 is thickness
      return { h: h, b: b };
    }
    m = s.match(/(IPN|IPE|HEA|HEB|HEM|UPN|UPE)\s*(\d+)/);
    if (m) {
      var hh = +m[2] / 1000;
      var bb = m[1] === 'IPE' ? 0.02 + 0.4 * hh : m[1].indexOf('HE') === 0 ? Math.min(0.3, hh) : 0.034 + 0.25 * hh;
      return { h: hh, b: bb };
    }
    return null;
  }
  function dimsOr(s, fb) { return secDims(s) || fb; }

  // ── the elements ────────────────────────────────────────────────────
  // Everything the building is made of, each with an id, a role, a
  // section and its geometry. Every view below is built from this list.
  function elements(f) {
    var out = [];
    if (!ready(f)) return out;
    var X = sorted(f.x), Y = sorted(f.y);
    var y0 = Y[0], yN = Y[Y.length - 1], outer = [y0, yN];

    function hAt(xn, yv) {           // column-top height at axis xn, position y
      for (var j = 0; j < Y.length - 1; j++) {
        var a = Y[j], b = Y[j + 1];
        if (yv >= a.p - 1e-9 && yv <= b.p + 1e-9) {
          var ha = nodeH(f, a.n, xn), hb = nodeH(f, b.n, xn);
          if (ha == null || hb == null) return null;
          var t = (b.p === a.p) ? 0 : (yv - a.p) / (b.p - a.p);
          return ha + (hb - ha) * t;
        }
      }
      return null;
    }
    var bd = dimsOr(f.sec.beam, { h: 0.16, b: 0.08 });

    // columns + footings
    Y.forEach(function (ya) {
      X.forEach(function (xa) {
        var id = 'col:' + ya.n + xa.n, h = nodeH(f, ya.n, xa.n);
        if (h != null) out.push({ id: id, role: 'column', sec: secOf(f, 'column', id),
          a: [xa.p, ya.p, 0], b: [xa.p, ya.p, h], len: h, at: ya.n + xa.n, xn: xa.n, yn: ya.n });
        var fid = 'foot:' + ya.n + xa.n;
        out.push({ id: fid, role: 'footing', sec: '', at: ya.n + xa.n, xn: xa.n, yn: ya.n, p: [xa.p, ya.p] });
      });
    });
    // main beams: one per numbered axis, across every lettered line
    X.forEach(function (xa) {
      var id = 'beam:' + xa.n, pts = [];
      Y.forEach(function (ya) {
        var h = nodeH(f, ya.n, xa.n);
        if (h != null) pts.push([xa.p, ya.p, h]);
      });
      if (pts.length >= 2) {
        var L = 0;
        for (var i = 1; i < pts.length; i++) L += Math.hypot(pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
        out.push({ id: id, role: 'beam', sec: secOf(f, 'beam', id), pts: pts, len: L, at: xa.n });
      }
    });
    // edge beams along the two outer lettered lines, bay by bay
    outer.forEach(function (ya) {
      for (var i = 0; i < X.length - 1; i++) {
        var id = 'edge:' + ya.n + ':' + X[i].n + '-' + X[i + 1].n;
        var ha = nodeH(f, ya.n, X[i].n), hb = nodeH(f, ya.n, X[i + 1].n);
        if (ha == null || hb == null) continue;
        out.push({ id: id, role: 'edge', sec: secOf(f, 'edge', id),
          a: [X[i].p, ya.p, ha], b: [X[i + 1].p, ya.p, hb],
          len: Math.hypot(X[i + 1].p - X[i].p, hb - ha), at: ya.n + ' ' + X[i].n + '-' + X[i + 1].n });
      }
    });
    // purlins: along the length, spaced across the width, on the beams
    if (f.purlinSp && f.purlinSp > 0.05) {
      var span = yN.p - y0.p, n = Math.round(span / f.purlinSp);
      for (var k = 0; k <= n; k++) {
        var yv = y0.p + (n ? span * k / n : 0), id = 'purlin:' + (k + 1), pts2 = [];
        X.forEach(function (xa) { var h = hAt(xa.n, yv); if (h != null) pts2.push([xa.p, yv, h + bd.h]); });
        if (pts2.length >= 2) {
          var L2 = 0;
          for (var q = 1; q < pts2.length; q++) L2 += Math.hypot(pts2[q][0] - pts2[q - 1][0], pts2[q][2] - pts2[q - 1][2]);
          out.push({ id: id, role: 'purlin', sec: secOf(f, 'purlin', id), pts: pts2, len: L2, at: String(k + 1) });
        }
      }
    }
    // knee braces on the outer lines, in the plane of each frame
    if (f.knee.drop && f.knee.run) {
      outer.forEach(function (ya, side) {
        var dir = side === 0 ? 1 : -1;
        X.forEach(function (xa) {
          var id = 'knee:' + ya.n + xa.n, h = nodeH(f, ya.n, xa.n);
          if (h == null) return;
          var yb = ya.p + dir * f.knee.run, hb = hAt(xa.n, yb);
          if (hb == null) return;
          out.push({ id: id, role: 'knee', sec: secOf(f, 'knee', id),
            a: [xa.p, ya.p, h - f.knee.drop], b: [xa.p, yb, hb],
            len: Math.hypot(f.knee.run, hb - (h - f.knee.drop)), at: ya.n + xa.n, xn: xa.n, yn: ya.n });
        });
      });
    }
    // cable X in the roof plane of each braced bay, at both outer lines
    f.braced.forEach(function (bay) {
      var pr = String(bay).split('-'), i1 = -1, i2 = -1;
      X.forEach(function (a, i) { if (a.n === pr[0]) i1 = i; if (a.n === pr[1]) i2 = i; });
      if (i1 < 0 || i2 < 0) return;
      outer.forEach(function (ya, side) {
        var dir = side === 0 ? 1 : -1;
        var depth = f.braceDepth || Math.abs((side === 0 ? Y[1] : Y[Y.length - 2]).p - ya.p);
        var yb = ya.p + dir * depth;
        var xa = X[i1], xb = X[i2];
        var c = [[xa, ya.p, xb, yb], [xa, yb, xb, ya.p]], id = 'cable:' + bay + ':' + ya.n;
        c.forEach(function (d, j) {
          var za = hAt(d[0].n, d[1]), zb = hAt(d[2].n, d[3]);
          if (za == null || zb == null) return;
          out.push({ id: id, role: 'cable', sec: secOf(f, 'cable', id), part: j,
            a: [d[0].p, d[1], za + bd.h], b: [d[2].p, d[3], zb + bd.h],
            len: Math.hypot(d[2].p - d[0].p, d[3] - d[1], zb - za), at: bay + ' ' + ya.n });
        });
      });
    });
    return out.filter(function (e) { return !f.off[e.id]; });
  }

  // ══════════════════════════════════════════════════════════════════
  //  QUANTITIES
  // ══════════════════════════════════════════════════════════════════
  function takeoff(f) {
    var els = elements(f), rows = {}, foot = 0;
    els.forEach(function (e) {
      if (e.role === 'footing') { foot++; return; }
      var key = e.role + '|' + (e.sec || '?');
      if (!rows[key]) rows[key] = { role: e.role, sec: e.sec, n: 0, len: 0, ids: {} };
      if (!rows[key].ids[e.id]) { rows[key].ids[e.id] = 1; rows[key].n++; }
      rows[key].len += e.len || 0;
    });
    var list = Object.keys(rows).map(function (k) { return rows[k]; })
      .sort(function (a, b) { return ROLES.indexOf(a.role) - ROLES.indexOf(b.role); });
    var F = f.foot, conc = null, blindA = null;
    if (F.w && F.l && F.t) {
      conc = foot * (F.w * F.l * F.t + ((F.ped && F.below) ? F.ped * F.ped * F.below : 0));
      if (F.blind) blindA = foot * F.w * F.l;
    }
    return { rows: list, footings: foot, concrete: conc, blindArea: blindA };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CHECKS — what is missing, and what does not add up
  // ══════════════════════════════════════════════════════════════════
  function checks(f) {
    var w = [];
    if (f.x.length < 2) w.push(tt('לא נקראו צירי אורך (1, 2, 3…)'));
    if (f.y.length < 2) w.push(tt('לא נקראו קווי עמודים (A, B, C…)'));
    if (f.x.some(function (a) { return a.p == null; }) || f.y.some(function (a) { return a.p == null; }))
      w.push(tt('לחלק מהצירים אין מיקום — הזן אותו מתוך שרשרת המידות'));
    f.y.forEach(function (a) { if (f.h[a.n] == null) w.push(tt('חסר גובה לקו') + ' ' + a.n); });
    Object.keys(f.sec).forEach(function (k) {
      if (!f.sec[k] && !(k === 'cable' && !f.braced.length) && !(k === 'knee' && !f.knee.drop))
        w.push(tt('חסר פרופיל:') + ' ' + tt(ROLE_HE[k] || k));
    });
    if (f.purlinSp == null) w.push(tt('חסר מרווח מרישים — המרישים לא מוצגים'));
    if (f.foot.w == null || f.foot.t == null) w.push(tt('חסרות מידות יסוד — היסודות לא מוצגים'));
    // Cross-checks: the printed overall dimension must equal the chain.
    var X = sorted(f.x), Y = sorted(f.y);
    if (f.check.totalX && X.length >= 2 && X[X.length - 1].p != null &&
        Math.abs((X[X.length - 1].p - X[0].p) - f.check.totalX) > 0.02)
      w.push(tt('סכום המרווחים לאורך') + ' (' + r2(X[X.length - 1].p - X[0].p) + ') ' +
        tt('לא שווה למידה הכוללת בתוכנית') + ' (' + f.check.totalX + ')');
    if (f.check.totalY && Y.length >= 2 && Y[Y.length - 1].p != null &&
        Math.abs((Y[Y.length - 1].p - Y[0].p) - f.check.totalY) > 0.02)
      w.push(tt('סכום המרווחים לרוחב') + ' (' + r2(Y[Y.length - 1].p - Y[0].p) + ') ' +
        tt('לא שווה למידה הכוללת בתוכנית') + ' (' + f.check.totalY + ')');
    var nodes = f.x.length * f.y.length;
    if (f.foot.count && nodes && f.foot.count !== nodes)
      w.push(tt('בתוכנית היסודות') + ' ' + f.foot.count + ' ' + tt('יסודות, ובשלד') + ' ' + nodes + ' ' + tt('עמודים'));
    return w;
  }

  // ══════════════════════════════════════════════════════════════════
  //  3D — faces for Shed3D, one pick group per element
  // ══════════════════════════════════════════════════════════════════
  function obox(a, b, w, d, color, g) {
    var dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    var L = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    dir = [dir[0] / L, dir[1] / L, dir[2] / L];
    var up = Math.abs(dir[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
    var s = [dir[1] * up[2] - dir[2] * up[1], dir[2] * up[0] - dir[0] * up[2], dir[0] * up[1] - dir[1] * up[0]];
    var sl = Math.hypot(s[0], s[1], s[2]) || 1; s = [s[0] / sl, s[1] / sl, s[2] / sl];
    var u = [s[1] * dir[2] - s[2] * dir[1], s[2] * dir[0] - s[0] * dir[2], s[0] * dir[1] - s[1] * dir[0]];
    function P(p, i, j) { return [p[0] + s[0] * i * w / 2 + u[0] * j * d / 2,
      p[1] + s[1] * i * w / 2 + u[1] * j * d / 2, p[2] + s[2] * i * w / 2 + u[2] * j * d / 2]; }
    var A = [P(a, -1, -1), P(a, 1, -1), P(a, 1, 1), P(a, -1, 1)];
    var B = [P(b, -1, -1), P(b, 1, -1), P(b, 1, 1), P(b, -1, 1)];
    var F = [];
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      F.push({ pts: [A[i], A[j], B[j], B[i]], color: color, group: g });
    }
    F.push({ pts: [A[0], A[1], A[2], A[3]], color: color, group: g });
    F.push({ pts: [B[3], B[2], B[1], B[0]], color: color, group: g });
    return F;
  }
  function abox(x1, y1, z1, x2, y2, z2, color, g) {
    return obox([(x1 + x2) / 2, (y1 + y2) / 2, z1], [(x1 + x2) / 2, (y1 + y2) / 2, z2],
      Math.abs(x2 - x1), Math.abs(y2 - y1), color, g);
  }

  function model3d(f, hidden) {
    hidden = hidden || {};
    var els = elements(f), F = [], X = sorted(f.x), Y = sorted(f.y), top = 0;
    els.forEach(function (e) {
      if (hidden[e.role]) return;
      var c = ROLE_COLOR[e.role];
      var dm = dimsOr(e.sec, e.role === 'cable' ? { h: 0.008, b: 0.008, cable: true } : { h: 0.12, b: 0.12 });
      if (e.role === 'column') {
        F = F.concat(abox(e.a[0] - dm.b / 2, e.a[1] - dm.h / 2, 0, e.a[0] + dm.b / 2, e.a[1] + dm.h / 2, e.b[2], c, e.id));
        top = Math.max(top, e.b[2]);
      } else if (e.role === 'beam' || e.role === 'purlin') {
        for (var i = 1; i < e.pts.length; i++) {
          var a = e.pts[i - 1], b = e.pts[i];
          var off = e.role === 'beam' ? dm.h / 2 : dm.h / 2;
          F = F.concat(obox([a[0], a[1], a[2] + off], [b[0], b[1], b[2] + off], dm.b, dm.h, c, e.id));
          top = Math.max(top, a[2] + dm.h, b[2] + dm.h);
        }
      } else if (e.role === 'edge') {
        F = F.concat(obox([e.a[0], e.a[1], e.a[2] + dm.h / 2], [e.b[0], e.b[1], e.b[2] + dm.h / 2], dm.b, dm.h, c, e.id));
      } else if (e.role === 'knee') {
        F = F.concat(obox(e.a, e.b, dm.b, dm.h, c, e.id));
      } else if (e.role === 'cable') {
        // Real diameter would vanish at building scale; drawn at 25 mm.
        F = F.concat(obox(e.a, e.b, 0.025, 0.025, c, e.id));
      } else if (e.role === 'footing') {
        var FT = f.foot;
        if (!(FT.w && FT.l && FT.t && FT.below != null)) return;
        var cx = e.p[0], cy = e.p[1], zTop = -FT.below, zBot = zTop - FT.t;
        F = F.concat(abox(cx - FT.w / 2, cy - FT.l / 2, zBot, cx + FT.w / 2, cy + FT.l / 2, zTop, c, e.id));
        if (FT.ped && FT.below > 0)
          F = F.concat(abox(cx - FT.ped / 2, cy - FT.ped / 2, zTop, cx + FT.ped / 2, cy + FT.ped / 2, 0, '#8e7d68', e.id));
        if (FT.blind)
          F = F.concat(abox(cx - FT.w / 2 - 0.05, cy - FT.l / 2 - 0.05, zBot - FT.blind, cx + FT.w / 2 + 0.05, cy + FT.l / 2 + 0.05, zBot, '#a8a29a', e.id));
      }
    });
    var len = X.length ? X[X.length - 1].p - X[0].p : 1, span = Y.length ? Y[Y.length - 1].p - Y[0].p : 1;
    // The viewer orbits the origin: centre the building on it.
    var cx = X.length ? (X[0].p + X[X.length - 1].p) / 2 : 0, cy = Y.length ? (Y[0].p + Y[Y.length - 1].p) / 2 : 0;
    F.forEach(function (fc) { fc.pts = fc.pts.map(function (q) { return [q[0] - cx, q[1] - cy, q[2]]; }); });
    return { faces: F, meta: { frames: X.length, bay: X.length > 1 ? len / (X.length - 1) : 3,
      rise: 0, runs: 0, slopeLen: 0, ridgeZ: top || 1, span: span || 1, length: len || 1,
      eaves: top || 1 } };
  }

  // ══════════════════════════════════════════════════════════════════
  //  2D — plan and section, both clickable per element
  // ══════════════════════════════════════════════════════════════════
  var INK = '#1f1f1f', MUTED = '#6b6b6b', SEL = '#e0a100', AXIS = '#9aa3a8';

  function dimRow(p, fixed, horiz, s0, o0, label) {
    // p = sorted positions (model units), draw ticks + segment values in cm
    var out = [];
    function X(v) { return s0(v); }
    var a = p[0], b = p[p.length - 1];
    if (horiz) {
      out.push('<line x1="' + X(a) + '" y1="' + fixed + '" x2="' + X(b) + '" y2="' + fixed + '" stroke="' + MUTED + '" stroke-width="0.8"/>');
      p.forEach(function (v) {
        out.push('<line x1="' + X(v) + '" y1="' + (fixed - 5) + '" x2="' + X(v) + '" y2="' + (fixed + 5) + '" stroke="' + MUTED + '" stroke-width="0.8"/>');
      });
      for (var i = 1; i < p.length; i++)
        out.push('<text x="' + ((X(p[i - 1]) + X(p[i])) / 2) + '" y="' + (fixed - 5) + '" font-size="10" fill="' + INK + '" text-anchor="middle">' + cm(p[i] - p[i - 1]) + '</text>');
      if (label) out.push('<text x="' + ((X(a) + X(b)) / 2) + '" y="' + (fixed + o0) + '" font-size="11" font-weight="700" fill="' + INK + '" text-anchor="middle">' + cm(b - a) + '</text>');
    } else {
      out.push('<line x1="' + fixed + '" y1="' + X(a) + '" x2="' + fixed + '" y2="' + X(b) + '" stroke="' + MUTED + '" stroke-width="0.8"/>');
      p.forEach(function (v) {
        out.push('<line x1="' + (fixed - 5) + '" y1="' + X(v) + '" x2="' + (fixed + 5) + '" y2="' + X(v) + '" stroke="' + MUTED + '" stroke-width="0.8"/>');
      });
      for (var j = 1; j < p.length; j++) {
        var cy = (X(p[j - 1]) + X(p[j])) / 2;
        out.push('<text x="' + (fixed - 6) + '" y="' + cy + '" font-size="10" fill="' + INK + '" text-anchor="middle" transform="rotate(-90 ' + (fixed - 6) + ' ' + cy + ')">' + cm(p[j] - p[j - 1]) + '</text>');
      }
      if (label) {
        var my = (X(a) + X(b)) / 2;
        out.push('<text x="' + (fixed - o0) + '" y="' + my + '" font-size="11" font-weight="700" fill="' + INK + '" text-anchor="middle" transform="rotate(-90 ' + (fixed - o0) + ' ' + my + ')">' + cm(b - a) + '</text>');
      }
    }
    return out.join('');
  }
  function bubble(x, y, t) {
    return '<circle cx="' + x + '" cy="' + y + '" r="10" fill="#fff" stroke="' + INK + '" stroke-width="1"/>' +
      '<text x="' + x + '" y="' + (y + 3.6) + '" font-size="10" font-weight="700" fill="' + INK + '" text-anchor="middle">' + esc(t) + '</text>';
  }
  function hit(id, inner) {
    return '<g data-el="' + esc(id) + '" onclick="Frame.pick(\'' + esc(id) + '\')" style="cursor:pointer">' + inner + '</g>';
  }

  function planSvg(f, sel) {
    if (!ready(f)) return '';
    var X = sorted(f.x), Y = sorted(f.y), els = elements(f);
    var L = X[X.length - 1].p - X[0].p, S = Y[Y.length - 1].p - Y[0].p;
    var W = 760, m = 78, sc = Math.min((W - 2 * m) / (L || 1), 520 / (S || 1));
    var nColSecs = {}; els.forEach(function (e) { if (e.role === 'column') nColSecs[e.sec || '?'] = 1; });
    var legendH = 14 * Object.keys(nColSecs).length + 10;
    var H = Math.round(S * sc + 2 * m + legendH);
    function px(v) { return r2(m + (v - X[0].p) * sc); }
    function py(v) { return r2(m + (v - Y[0].p) * sc); }
    var o = [];
    // axes
    X.forEach(function (a) {
      o.push('<line x1="' + px(a.p) + '" y1="' + (m - 30) + '" x2="' + px(a.p) + '" y2="' + (py(Y[Y.length - 1].p) + 30) + '" stroke="' + AXIS + '" stroke-width="0.6" stroke-dasharray="8,3,2,3"/>');
      o.push(bubble(px(a.p), m - 42, a.n));
    });
    Y.forEach(function (a) {
      o.push('<line x1="' + (m - 30) + '" y1="' + py(a.p) + '" x2="' + (W - m + 30) + '" y2="' + py(a.p) + '" stroke="' + AXIS + '" stroke-width="0.6" stroke-dasharray="8,3,2,3"/>');
      o.push(bubble(W - m + 42 > W - 12 ? W - 14 : W - m + 42, py(a.p), a.n));
    });
    function seg(e, a, b, sw, col, dash) {
      var s = e.id === sel;
      return '<line x1="' + px(a[0]) + '" y1="' + py(a[1]) + '" x2="' + px(b[0]) + '" y2="' + py(b[1]) +
        '" stroke="' + (s ? SEL : col) + '" stroke-width="' + (s ? sw + 2.5 : sw) + '"' + (dash ? ' stroke-dasharray="' + dash + '"' : '') + '/>';
    }
    var order = { purlin: 0, cable: 1, edge: 2, beam: 3, knee: 4, column: 5, footing: -1 };
    els.slice().sort(function (a, b) { return order[a.role] - order[b.role]; }).forEach(function (e) {
      if (e.role === 'purlin') o.push(hit(e.id, seg(e, e.pts[0], e.pts[e.pts.length - 1], 0.9, '#b58f10')));
      else if (e.role === 'cable') o.push(hit(e.id, seg(e, e.a, e.b, 1, '#555', '5,3')));
      else if (e.role === 'edge') o.push(hit(e.id, seg(e, e.a, e.b, 2.2, '#2b6cb0')));
      else if (e.role === 'beam') o.push(hit(e.id, seg(e, e.pts[0], e.pts[e.pts.length - 1], 3, '#3182ce')));
      else if (e.role === 'column') {
        var d = dimsOr(e.sec, { h: 0.12, b: 0.12 }), sz = Math.max(7, d.h * sc), s = e.id === sel;
        o.push(hit(e.id, '<rect x="' + (px(e.a[0]) - sz / 2) + '" y="' + (py(e.a[1]) - sz / 2) + '" width="' + sz + '" height="' + sz +
          '" fill="' + (s ? SEL : '#fff') + '" stroke="' + INK + '" stroke-width="1.4"/>'));
      }
    });
    // one label per role, on its first element — like the engineer's leaders
    var seen = {};
    els.forEach(function (e) {
      if (seen[e.role + e.sec] || !e.sec || e.role === 'footing' || e.role === 'column' || e.role === 'knee') return;
      seen[e.role + e.sec] = 1;
      var a = e.a || e.pts[0], b = e.b || e.pts[e.pts.length - 1];
      var t = e.role === 'cable' ? 0.5 : 0.28;
      var mx = px(a[0] + (b[0] - a[0]) * t), my = py(a[1] + (b[1] - a[1]) * t);
      var vert = Math.abs(b[1] - a[1]) > Math.abs(b[0] - a[0]);
      o.push('<text x="' + (mx + (vert ? 4 : 0)) + '" y="' + (my - 4) + '" font-size="9.5" fill="' + INK +
        '"' + (vert ? ' transform="rotate(-90 ' + (mx + 4) + ' ' + (my - 4) + ')" text-anchor="middle"' : ' text-anchor="middle"') + '>' + esc(e.sec) + '</text>');
    });
    // column sections: list distinct ones by corner
    var colSecs = {};
    els.forEach(function (e) { if (e.role === 'column') (colSecs[e.sec || '?'] = colSecs[e.sec || '?'] || []).push(e.at); });
    var ly = H - 10;
    Object.keys(colSecs).forEach(function (s, i) {
      o.push('<text x="' + m + '" y="' + (ly - i * 14) + '" font-size="9.5" fill="' + MUTED + '">\u25a1 ' + esc(s) + ' \u2014 ' +
        colSecs[s].length + ' (' + esc(colSecs[s].slice(0, 6).join(', ') + (colSecs[s].length > 6 ? '\u2026' : '')) + ')</text>');
    });
    o.push(dimRow(X.map(function (a) { return a.p; }), py(Y[Y.length - 1].p) + 42, true, px, 15, true));
    o.push(dimRow(Y.map(function (a) { return a.p; }), m - 58 + 10, false, py, 15, true));
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;direction:ltr;background:#fff;border-radius:8px;" direction="ltr" font-family="Arial,sans-serif">' +
      o.join('') + '</svg>';
  }

  function sectionSvg(f, xn, sel) {
    if (!ready(f)) return '';
    var X = sorted(f.x), Y = sorted(f.y), els = elements(f);
    if (!X.some(function (a) { return a.n === xn; })) xn = X[0].n;
    var S = Y[Y.length - 1].p - Y[0].p, FT = f.foot;
    var hs = Y.map(function (a) { return nodeH(f, a.n, xn); }).filter(function (v) { return v != null; });
    var zMax = Math.max.apply(null, hs.concat([1])) + 0.5;
    var zMin = -((FT.below || 0) + (FT.t || 0) + (FT.blind || 0) + 0.4);
    var W = 760, m = 80, sc = Math.min((W - 2 * m) / (S || 1), 420 / (zMax - zMin));
    var H = Math.round((zMax - zMin) * sc + 2 * m - 20);
    function px(v) { return r2(m + (v - Y[0].p) * sc); }
    function pz(z) { return r2(m - 20 + (zMax - z) * sc); }
    var o = [];
    // ground
    o.push('<rect x="' + (m - 30) + '" y="' + pz(0) + '" width="' + (S * sc + 60) + '" height="' + (pz(zMin) - pz(0)) + '" fill="#f3e3c9" stroke="none"/>');
    o.push('<line x1="' + (m - 40) + '" y1="' + pz(0) + '" x2="' + (m + S * sc + 40) + '" y2="' + pz(0) + '" stroke="' + INK + '" stroke-width="1.2"/>');
    o.push('<text x="' + (m + S * sc + 40) + '" y="' + (pz(0) - 4) + '" font-size="10" fill="' + MUTED + '" text-anchor="end">' + tt('קו קרקע') + '</text>');
    var bd = dimsOr(f.sec.beam, { h: 0.16, b: 0.08 });
    els.forEach(function (e) {
      var s = e.id === sel;
      if (e.role === 'footing' && e.xn === xn) {
        if (!(FT.w && FT.t && FT.below != null)) return;
        var cx = px(e.p[1]);
        var g = '<rect x="' + (cx - FT.w * sc / 2) + '" y="' + pz(-FT.below) + '" width="' + (FT.w * sc) + '" height="' + (FT.t * sc) +
          '" fill="' + (s ? SEL : '#e8e2d8') + '" stroke="' + INK + '" stroke-width="1"/>';
        if (FT.ped) g += '<rect x="' + (cx - FT.ped * sc / 2) + '" y="' + pz(0) + '" width="' + (FT.ped * sc) + '" height="' + (FT.below * sc) +
          '" fill="#f7f4ef" stroke="' + INK + '" stroke-width="1"/>';
        o.push(hit(e.id, g));
      }
    });
    els.forEach(function (e) {
      var s = e.id === sel, col = s ? SEL : '#3a86c8';
      if (e.role === 'column' && e.xn === xn) {
        o.push(hit(e.id, '<line x1="' + px(e.a[1]) + '" y1="' + pz(0) + '" x2="' + px(e.a[1]) + '" y2="' + pz(e.b[2]) +
          '" stroke="' + col + '" stroke-width="' + (s ? 6 : 4) + '"/>'));
      } else if (e.role === 'beam' && e.id === 'beam:' + xn) {
        var d = e.pts.map(function (p, i) { return (i ? 'L' : 'M') + px(p[1]) + ' ' + pz(p[2] + bd.h / 2); }).join(' ');
        o.push(hit(e.id, '<path d="' + d + '" fill="none" stroke="' + (s ? SEL : '#2c5f8a') + '" stroke-width="' + Math.max(4, bd.h * sc) + '"/>'));
        o.push('<text x="' + px(e.pts[0][1] + (e.pts[e.pts.length - 1][1] - e.pts[0][1]) * 0.27) + '" y="' + (pz(Math.max(e.pts[0][2], e.pts[e.pts.length - 1][2])) - 30) +
          '" font-size="10" fill="' + INK + '" text-anchor="middle">' + esc(e.sec || '?') + '</text>');
      } else if (e.role === 'knee' && e.xn === xn) {
        o.push(hit(e.id, '<line x1="' + px(e.a[1]) + '" y1="' + pz(e.a[2]) + '" x2="' + px(e.b[1]) + '" y2="' + pz(e.b[2]) +
          '" stroke="' + (s ? SEL : '#6d6d6d') + '" stroke-width="' + (s ? 4 : 2) + '"/>'));
      }
    });
    // purlin dots
    els.forEach(function (e) {
      if (e.role !== 'purlin') return;
      var p = e.pts.filter(function (q) { var a = X.filter(function (x) { return x.n === xn; })[0]; return a && Math.abs(q[0] - a.p) < 1e-6; })[0];
      if (p) o.push(hit(e.id, '<rect x="' + (px(p[1]) - 3) + '" y="' + (pz(p[2] + 0.06) - 3) + '" width="6" height="6" fill="' + (e.id === sel ? SEL : '#c9a227') + '"/>'));
    });
    // heights per line
    Y.forEach(function (a) {
      var h = nodeH(f, a.n, xn); if (h == null) return;
      o.push('<text x="' + px(a.p) + '" y="' + (pz(h) - 18) + '" font-size="10.5" font-weight="700" fill="' + INK + '" text-anchor="middle">' + cm(h) + '</text>');
      o.push(bubble(px(a.p), H - 18, a.n + xn));
    });
    o.push(dimRow(Y.map(function (a) { return a.p; }), H - 44, true, px, 15, true));
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;direction:ltr;background:#fff;border-radius:8px;" direction="ltr" font-family="Arial,sans-serif">' +
      '<text x="' + (W / 2) + '" y="22" font-size="13" font-weight="700" fill="' + INK + '" text-anchor="middle">' + tt('חתך בציר') + ' ' + esc(xn) + '</text>' +
      o.join('') + '</svg>';
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE TAB
  // ══════════════════════════════════════════════════════════════════
  // Footings start hidden in 3D: they sit below grade, and with no
  // pedestal read they float under the columns and read as clutter. The
  // section shows them where below-grade reads naturally; one tap here
  // shows them in 3D too.
  var _pid = null, _mid = null, _sel = null, _sec = null, _hidden = { footing: true };
  var _v3d = null, _v3dState = null, _v3dFor = null;

  function proj(pid) { var B = BPI(); return B.projById ? B.projById(pid) : null; }
  function modelOf(p, mid) {
    return (p && isArr(p.models)) ? p.models.filter(function (m) { return m.id === mid; })[0] : null;
  }
  function save() { var B = BPI(); if (B.saveP) B.saveP(); }
  function reopen() { var B = BPI(); if (B.open && _pid != null) B.open(_pid); }

  function srcChip(f, key) {
    var s = f.src[key];
    if (s === 'read') return '<span class="fr-chip fr-read" title="' + tt('נקרא מהתוכנית') + '">\ud83d\udcc4</span>';
    if (s === 'user') return '<span class="fr-chip fr-user" title="' + tt('הוזן ידנית') + '">\u270b</span>';
    return '<span class="fr-chip fr-miss" title="' + tt('לא נקרא — יש להזין') + '">\u26a0\ufe0f</span>';
  }

  var CSS = '<style id="fr-css">' +
    '.fr-card{background:var(--card,#fff);border:1px solid var(--border,#ddd);border-radius:12px;padding:12px;margin:10px 0;}' +
    '.fr-h{font-weight:800;font-size:.95rem;margin:0 0 8px;}' +
    '.fr-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0;}' +
    '.fr-in{width:84px;padding:5px 7px;border:1px solid var(--border,#ccc);border-radius:7px;font:inherit;background:var(--surface-input,#fff);color:inherit;}' +
    '.fr-in.w{width:170px}.fr-in.s{width:56px}' +
    '.fr-chip{font-size:.8rem;margin-inline-start:2px}.fr-miss{filter:saturate(1.4)}' +
    '.fr-warn{background:#fff4e0;color:#7a4b00;border-radius:8px;padding:8px 10px;font-size:.82rem;margin:6px 0;}' +
    '.fr-ok{background:#e8f5ee;color:#1d5b3a;border-radius:8px;padding:8px 10px;font-size:.82rem;margin:6px 0;}' +
    '.fr-3d{height:400px;border-radius:12px;overflow:hidden;background:#dfe7ee;}' +
    '.fr-tog{border:1px solid var(--border,#ccc);border-radius:16px;padding:4px 10px;font-size:.8rem;cursor:pointer;background:var(--card,#fff);color:inherit;}' +
    '.fr-tog.off{opacity:.45;text-decoration:line-through}' +
    '.fr-tbl{width:100%;border-collapse:collapse;font-size:.84rem}.fr-tbl td,.fr-tbl th{border-bottom:1px solid var(--border,#e2e2e2);padding:5px 6px;text-align:start}' +
    '.fr-grid2{display:grid;grid-template-columns:1fr;gap:10px}@media(min-width:1000px){.fr-grid2{grid-template-columns:1fr 1fr}}' +
    '.fr-btn{border:1px solid var(--border,#ccc);border-radius:8px;padding:6px 10px;cursor:pointer;background:var(--card,#fff);color:inherit;font:inherit;font-size:.84rem}' +
    '.fr-btn.pri{background:#2d6a4f;color:#fff;border-color:#2d6a4f}' +
    '</style>';

  function tab(p, mid) {
    _pid = p.id; _mid = mid;
    var m = modelOf(p, mid);
    if (!m) return '<div class="fr-card">' + tt('המודל לא נמצא') + '</div>';
    var f = m.frame = norm(m.frame);
    if (_sec == null || !f.x.some(function (a) { return a.n === _sec; })) _sec = f.x.length ? sorted(f.x)[0].n : null;
    var warn = checks(f), T = takeoff(f), H = [];
    var nRead = 0, nUser = 0;
    Object.keys(f.src).forEach(function (k) { if (f.src[k] === 'read') nRead++; else if (f.src[k] === 'user') nUser++; });

    H.push(CSS);
    H.push('<div class="fr-card"><div class="fr-row" style="justify-content:space-between">' +
      '<div><div class="fr-h">\ud83d\udcd0 ' + esc(m.name) + '</div>' +
      '<div style="font-size:.8rem;opacity:.8">\ud83d\udcc4 ' + nRead + ' ' + tt('ערכים נקראו מהתוכנית') + ' · \u270b ' + nUser + ' ' + tt('הוזנו ידנית') +
      (f.conf ? ' · ' + tt('ביטחון הקריאה:') + ' ' + esc(f.conf) : '') + '</div></div>' +
      '<div class="fr-row">' +
        (otherDocs(p, m).length ? '<button class="fr-btn" onclick="Frame.mergeMenu()">\ud83d\udce5 ' + tt('השלם מתוכנית אחרת') + '</button>' : '') +
        '<button class="fr-btn" onclick="Frame.print()">\ud83d\udda8 ' + tt('הדפסה') + '</button>' +
        '<button class="fr-btn" onclick="Frame.remove()">\ud83d\uddd1</button>' +
      '</div></div>' +
      (warn.length
        ? '<div class="fr-warn"><b>\u26a0\ufe0f ' + tt('מה חסר או לא מסתדר') + '</b><br>' + warn.map(esc).join('<br>') + '</div>'
        : '<div class="fr-ok">\u2705 ' + tt('כל הערכים קיימים והמידות מסתכמות') + '</div>') +
      '</div>');

    if (!ready(f)) {
      H.push('<div class="fr-card"><div class="fr-h">' + tt('רשת צירים') + '</div>' +
        '<div style="font-size:.84rem;margin-bottom:6px">' +
        tt('הקריאה לא הניבה רשת צירים מלאה. הזן את הצירים מתוך התוכנית — שם ומיקום במטרים מהציר הראשון.') + '</div>' +
        axesEditor(f) + '</div>');
      return H.join('');
    }

    H.push('<div class="fr-card"><div class="fr-row" style="justify-content:space-between;margin-bottom:6px">' +
      '<div class="fr-h" style="margin:0">\ud83e\uddca ' + tt('מודל תלת-ממד') + '</div>' +
      '<div class="fr-row">' + ROLES.map(function (r) {
        return '<button class="fr-tog' + (_hidden[r] ? ' off' : '') + '" onclick="Frame.toggle(\'' + r + '\')">' +
          '<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + ROLE_COLOR[r] + ';margin-inline-end:4px"></span>' + tt(ROLE_HE[r]) + '</button>';
      }).join('') + '</div></div>' +
      '<div id="fr-3d" class="fr-3d"></div>' +
      '<div style="font-size:.76rem;opacity:.75;margin-top:4px">' + tt('לחיצה על אלמנט בתלת-ממד, במבט העל או בחתך — בוחרת אותו לעריכה.') + '</div></div>');

    H.push('<div id="fr-insp">' + inspector(f) + '</div>');

    H.push('<div class="fr-grid2">' +
      '<div class="fr-card"><div class="fr-h">' + tt('מבט על') + '</div><div id="fr-plan">' + planSvg(f, _sel) + '</div></div>' +
      '<div class="fr-card"><div class="fr-row" style="justify-content:space-between"><div class="fr-h" style="margin:0">' + tt('חתך') + '</div>' +
        '<div class="fr-row">' + sorted(f.x).map(function (a) {
          return '<button class="fr-tog' + (a.n === _sec ? '' : ' off') + '" style="text-decoration:none" onclick="Frame.section(\'' + esc(a.n) + '\')">' + esc(a.n) + '</button>';
        }).join('') + '</div></div><div id="fr-sec">' + sectionSvg(f, _sec, _sel) + '</div></div>' +
      '</div>');

    H.push('<div class="fr-card"><div class="fr-h">' + tt('פרמטרים של השלד') + '</div>' + params(f) + '</div>');
    H.push('<div class="fr-card"><div class="fr-h">' + tt('כתב כמויות של המודל') + '</div>' + boqHtml(T) +
      '<div style="font-size:.76rem;opacity:.7;margin-top:6px">' +
      tt('מחושב מהמודל הזה בלבד — לא נכנס לכתב הכמויות הראשי של הפרויקט.') + '</div></div>');
    if (f.ev.length) H.push('<div class="fr-card"><details><summary class="fr-h" style="cursor:pointer">' +
      tt('מה הקורא ראה בתוכנית') + ' (' + f.ev.length + ')</summary><div style="font-size:.8rem;line-height:1.6;margin-top:6px">' +
      f.ev.map(esc).join('<br>') + '</div></details></div>');
    return H.join('');
  }

  function axesEditor(f) {
    function list(key, axes, hint) {
      return '<div style="margin:6px 0"><b>' + hint + '</b> ' + srcChip(f, key) + '<div class="fr-row">' +
        axes.map(function (a, i) {
          return '<span style="display:inline-flex;gap:3px;align-items:center;border:1px solid var(--border,#ddd);border-radius:8px;padding:3px 5px">' +
            '<input class="fr-in s" value="' + esc(a.n) + '" onchange="Frame.axis(\'' + key + '\',' + i + ',\'n\',this.value)">' +
            '<input class="fr-in s" type="number" step="0.01" value="' + (a.p == null ? '' : a.p) + '" placeholder="m" onchange="Frame.axis(\'' + key + '\',' + i + ',\'p\',this.value)">' +
            '<button class="fr-btn" style="padding:2px 6px" onclick="Frame.axisDel(\'' + key + '\',' + i + ')">\u2715</button></span>';
        }).join('') +
        '<button class="fr-btn" onclick="Frame.axisAdd(\'' + key + '\')">+ ' + tt('ציר') + '</button></div></div>';
    }
    return list('x', f.x, tt('צירי אורך (1, 2, 3…) — מיקום במטרים')) +
           list('y', f.y, tt('קווי עמודים (A, B, C…) — מיקום במטרים'));
  }

  function params(f) {
    var H = [axesEditor(f)];
    H.push('<div style="margin-top:8px"><b>' + tt('גובה עמוד לכל קו (עליון, מטרים)') + '</b><div class="fr-row">' +
      sorted(f.y).map(function (a) {
        return '<label>' + esc(a.n) + ' <input class="fr-in s" type="number" step="0.01" value="' + (f.h[a.n] == null ? '' : f.h[a.n]) +
          '" onchange="Frame.set(\'h.' + esc(a.n) + '\',this.value)"></label>' + srcChip(f, 'h.' + a.n);
      }).join(' ') + '</div></div>');
    H.push('<datalist id="fr-secs">' + COMMON.map(function (s) { return '<option value="' + esc(s) + '">'; }).join('') + '</datalist>');
    H.push('<div style="margin-top:8px"><b>' + tt('פרופילים לפי תפקיד') + '</b>');
    ['column', 'beam', 'edge', 'purlin', 'knee', 'cable'].forEach(function (k) {
      H.push('<div class="fr-row"><span style="min-width:112px">' + tt(ROLE_HE[k]) + '</span>' +
        '<input class="fr-in w" list="fr-secs" value="' + esc(f.sec[k]) + '" onchange="Frame.set(\'sec.' + k + '\',this.value)">' + srcChip(f, 'sec.' + k) + '</div>');
    });
    H.push('</div>');
    H.push('<div class="fr-row" style="margin-top:8px"><label>' + tt('מרווח מרישים (מ\')') +
      ' <input class="fr-in s" type="number" step="0.05" value="' + (f.purlinSp == null ? '' : f.purlinSp) + '" onchange="Frame.set(\'purlinSp\',this.value)"></label>' + srcChip(f, 'purlinSp') +
      '<label>' + tt('דיאגונל: ירידה') + ' <input class="fr-in s" type="number" step="0.05" value="' + (f.knee.drop == null ? '' : f.knee.drop) + '" onchange="Frame.set(\'knee.drop\',this.value)"></label>' + srcChip(f, 'knee.drop') +
      '<label>' + tt('היסט') + ' <input class="fr-in s" type="number" step="0.05" value="' + (f.knee.run == null ? '' : f.knee.run) + '" onchange="Frame.set(\'knee.run\',this.value)"></label>' + srcChip(f, 'knee.run') + '</div>');
    H.push('<div class="fr-row"><label>' + tt('שדות עם הקשחת כבלים (למשל 1-2, 4-5)') +
      ' <input class="fr-in w" value="' + esc(f.braced.join(', ')) + '" onchange="Frame.set(\'braced\',this.value)"></label>' + srcChip(f, 'braced') +
      '<label>' + tt('עומק הקשחה (מ\')') + ' <input class="fr-in s" type="number" step="0.05" value="' + (f.braceDepth == null ? '' : f.braceDepth) + '" onchange="Frame.set(\'braceDepth\',this.value)"></label>' + srcChip(f, 'braceDepth') + '</div>');
    var F = f.foot;
    H.push('<div style="margin-top:8px"><b>' + tt('יסוד בודד') + '</b><div class="fr-row">' +
      [['w', 'רוחב'], ['l', 'אורך'], ['t', 'עובי'], ['below', 'עומק ראש היסוד'], ['ped', 'צוואר'], ['blind', 'בטון רזה']].map(function (q) {
        return '<label>' + tt(q[1]) + ' <input class="fr-in s" type="number" step="0.01" value="' + (F[q[0]] == null ? '' : F[q[0]]) +
          '" onchange="Frame.set(\'foot.' + q[0] + '\',this.value)"></label>' + srcChip(f, 'foot.' + q[0]);
      }).join(' ') + '</div><div class="fr-row">' +
      '<label>' + tt('פלטה') + ' <input class="fr-in w" value="' + esc(F.plate) + '" onchange="Frame.set(\'foot.plate\',this.value)"></label>' + srcChip(f, 'foot.plate') +
      '<label>' + tt('ברגי עיגון') + ' <input class="fr-in w" value="' + esc(F.anchors) + '" onchange="Frame.set(\'foot.anchors\',this.value)"></label>' + srcChip(f, 'foot.anchors') +
      '</div></div>');
    return H.join('');
  }

  function inspector(f) {
    if (!_sel) return '<div class="fr-card" style="font-size:.84rem;opacity:.8">\ud83d\udc46 ' +
      tt('בחר אלמנט (עמוד, קורה, מריש, דיאגונל, כבל, יסוד) כדי לשנות אותו בנפרד משאר המבנה.') + '</div>';
    var e = elements(f).filter(function (q) { return q.id === _sel; })[0];
    var off = !!f.off[_sel];
    var role = e ? e.role : (_sel.split(':')[0] === 'col' ? 'column' : _sel.split(':')[0] === 'foot' ? 'footing' : _sel.split(':')[0]);
    var ov = f.ov[_sel] || {};
    var H = ['<div class="fr-card" style="border-color:' + SEL + '"><div class="fr-row" style="justify-content:space-between">' +
      '<div class="fr-h" style="margin:0">\ud83c\udfaf ' + tt(ROLE_HE[role] || role) + ' · <span dir="ltr">' + esc(_sel) + '</span>' +
      (off ? ' <span style="color:#b3261e">(' + tt('הוסר') + ')</span>' : '') + '</div>' +
      '<button class="fr-btn" onclick="Frame.pick(null)">\u2715</button></div>'];
    if (e && e.len) H.push('<div style="font-size:.84rem;margin:4px 0">' + tt('אורך') + ': <b>' + r2(e.len) + ' m</b></div>');
    if (role !== 'footing') {
      H.push('<div class="fr-row"><label>' + tt('פרופיל לאלמנט הזה בלבד') + ' <input class="fr-in w" list="fr-secs" value="' + esc(ov.sec || '') +
        '" placeholder="' + esc(f.sec[role] || '') + '" onchange="Frame.ov(\'sec\',this.value)"></label>' +
        (ov.sec ? srcChip(f, 'ov.' + _sel) : '<span style="font-size:.78rem;opacity:.7">' + tt('(כרגע: הפרופיל הכללי)') + '</span>') + '</div>');
    }
    if (role === 'column') {
      H.push('<div class="fr-row"><label>' + tt('גובה לעמוד הזה בלבד (מ\')') + ' <input class="fr-in s" type="number" step="0.01" value="' +
        (ov.h == null ? '' : ov.h) + '" placeholder="' + (e ? r2(e.len) : '') + '" onchange="Frame.ov(\'h\',this.value)"></label>' +
        '<span style="font-size:.78rem;opacity:.7">' + tt('משנה גם את שיפוע הגג בנקודה הזו') + '</span></div>');
    }
    H.push('<div class="fr-row" style="margin-top:6px">' +
      (off ? '<button class="fr-btn pri" onclick="Frame.restore()">\u21a9 ' + tt('החזר אלמנט') + '</button>'
           : '<button class="fr-btn" onclick="Frame.del()">\ud83d\uddd1 ' + tt('הסר אלמנט') + '</button>') +
      ((ov.sec || ov.h != null) ? '<button class="fr-btn" onclick="Frame.reset()">\u21ba ' + tt('חזור לערכים הכלליים') + '</button>' : '') +
      '</div></div>');
    return H.join('');
  }

  function boqHtml(T) {
    var rows = T.rows.map(function (r) {
      return '<tr><td>' + tt(ROLE_HE[r.role] || r.role) + '</td><td dir="ltr" style="text-align:start">' + esc(r.sec || '\u26a0\ufe0f ?') +
        '</td><td>' + r.n + '</td><td>' + r2(r.len) + ' m</td></tr>';
    }).join('');
    rows += '<tr><td>' + tt('יסודות') + '</td><td></td><td>' + T.footings + '</td><td>' +
      (T.concrete != null ? r2(T.concrete) + ' m\u00b3 ' + tt('בטון') : '\u26a0\ufe0f ' + tt('חסרות מידות')) + '</td></tr>';
    if (T.blindArea != null) rows += '<tr><td>' + tt('בטון רזה') + '</td><td></td><td></td><td>' + r2(T.blindArea) + ' m\u00b2</td></tr>';
    return '<table class="fr-tbl"><thead><tr><th>' + tt('רכיב') + '</th><th>' + tt('פרופיל') + '</th><th>' + tt('כמות') +
      '</th><th>' + tt('סה"כ') + '</th></tr></thead><tbody>' + rows + '</tbody></table>';
  }

  function mount(p, mid) {
    _pid = p.id; _mid = mid;
    var host = document.getElementById('fr-3d'), m = modelOf(p, mid);
    if (!host || !m || typeof Shed3D === 'undefined') return;
    var key = p.id + '/' + mid;
    if (_v3dFor !== key) _v3dState = null;
    _v3d = Shed3D.mount(host, model3d(m.frame, _hidden), {
      labels: {
        x: tt('אורך'), y: tt('רוחב'), z: tt('גובה'),
        corner: tt('פינה'), midpoint: tt('אמצע'), edge: tt('קו'), ground: tt('קרקע')
      },
      state: _v3dState,
      onSelect: function (g) { if (g && /^(col|beam|edge|purlin|knee|cable|foot):/.test(g)) selectOnly(g); else selectOnly(null); }
    });
    _v3dFor = key;
    if (_sel && _v3d.select) _v3d.select(_sel);
  }
  function destroy() {
    if (_v3d) { try { _v3dState = _v3d.getState(); } catch (e) {} try { _v3d.destroy(); } catch (e) {} }
    _v3d = null;
  }

  // Selection repaints the three side panels in place — no remount, so
  // the camera never jumps when you pick something.
  function selectOnly(id) {
    _sel = id;
    var p = proj(_pid), m = modelOf(p, _mid); if (!m) return;
    var f = m.frame;
    var a = document.getElementById('fr-insp'); if (a) a.innerHTML = inspector(f);
    var b = document.getElementById('fr-plan'); if (b) b.innerHTML = planSvg(f, _sel);
    var c = document.getElementById('fr-sec'); if (c) c.innerHTML = sectionSvg(f, _sec, _sel);
    if (_v3d && _v3d.select) _v3d.select(_sel);
  }

  // Every edit: write, mark as typed, save, repaint. The camera survives.
  function edit(fn) {
    var p = proj(_pid), m = modelOf(p, _mid); if (!m) return;
    m.frame = norm(m.frame);
    fn(m.frame);
    if (_v3d) { try { _v3dState = _v3d.getState(); } catch (e) {} }
    save(); reopen();
  }

  // ══════════════════════════════════════════════════════════════════
  //  READING — tile the sheet so the model can actually see 1:50 text
  // ══════════════════════════════════════════════════════════════════
  var PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  var PDFJS_W = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var _pdfP = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (_pdfP) return _pdfP;
    _pdfP = new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = PDFJS;
      s.onload = function () {
        if (!window.pdfjsLib) { rej(new Error('pdf.js')); return; }
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_W; res(window.pdfjsLib);
      };
      s.onerror = function () { _pdfP = null; rej(new Error('pdf.js load')); };
      document.head.appendChild(s);
    });
    return _pdfP;
  }
  function jpeg(cv, q) { return cv.toDataURL('image/jpeg', q || 0.82).split(',')[1]; }
  function scaled(src, maxEdge) {
    var s = Math.min(1, maxEdge / Math.max(src.width, src.height));
    var c = document.createElement('canvas');
    c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  // An overview for layout plus a grid of overlapping tiles at full
  // resolution. Overlap is 12 %, so a label straddling a seam is whole in
  // at least one tile.
  function cut(cv, cols, rows, prefix, out) {
    out.push({ label: prefix + ' ' + tt('סקירה') + ' (overview)', data: jpeg(scaled(cv, 1560), 0.8) });
    var tw = cv.width / cols, th = cv.height / rows, ox = tw * 0.12, oy = th * 0.12;
    for (var r = 0; r < rows; r++) for (var c = 0; c < cols; c++) {
      var x = Math.max(0, c * tw - ox), y = Math.max(0, r * th - oy);
      var w = Math.min(cv.width - x, tw + 2 * ox), h = Math.min(cv.height - y, th + 2 * oy);
      var t = document.createElement('canvas'); t.width = Math.round(w); t.height = Math.round(h);
      t.getContext('2d').drawImage(cv, x, y, w, h, 0, 0, t.width, t.height);
      out.push({ label: prefix + ' tile r' + (r + 1) + 'c' + (c + 1) + ' of ' + rows + 'x' + cols +
        ' (x ' + Math.round(x / cv.width * 100) + '-' + Math.round((x + w) / cv.width * 100) + '%, y ' +
        Math.round(y / cv.height * 100) + '-' + Math.round((y + h) / cv.height * 100) + '%)', data: jpeg(scaled(t, 1560), 0.84) });
    }
  }
  function tilesFromBytes(buf, type) {
    var isPdf = /pdf/i.test(type || '') || (buf.byteLength > 4 &&
      String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 4))) === '%PDF');
    if (isPdf) {
      return loadPdfJs().then(function (lib) {
        return lib.getDocument({ data: new Uint8Array(buf) }).promise;
      }).then(function (pdf) {
        var n = Math.min(pdf.numPages, 3), out = [], chain = Promise.resolve();
        var grid = n === 1 ? [4, 3] : n === 2 ? [3, 2] : [2, 2];
        for (var i = 1; i <= n; i++) (function (pi) {
          chain = chain.then(function () { return pdf.getPage(pi); }).then(function (pg) {
            var vp0 = pg.getViewport({ scale: 1 });
            var sc = 4600 / Math.max(vp0.width, vp0.height);
            var vp = pg.getViewport({ scale: sc });
            var cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
            var ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
            return pg.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              var land = cv.width >= cv.height;
              cut(cv, land ? grid[0] : grid[1], land ? grid[1] : grid[0], 'page ' + pi, out);
            });
          });
        })(i);
        return chain.then(function () { return out; });
      });
    }
    return new Promise(function (res, rej) {
      var img = new Image(), url = URL.createObjectURL(new Blob([buf], { type: type || 'image/png' }));
      img.onload = function () {
        var cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0); URL.revokeObjectURL(url);
        var out = [], big = Math.max(cv.width, cv.height) > 2400;
        cut(cv, big ? 3 : 2, big ? 2 : 1, 'image', out); res(out);
      };
      img.onerror = function () { URL.revokeObjectURL(url); rej(new Error('image')); };
      img.src = url;
    });
  }
  // The payload for planExtract. Tries the stored file first; if the
  // browser cannot fetch it (bucket CORS), falls back to the old whole-
  // document read so a press never simply fails.
  function payloadFor(d, model) {
    var base = { path: d.path, hint: d.hint || '', model: model || 'sonnet', name: d.name || '' };
    if (typeof firebase === 'undefined' || !firebase.storage) return Promise.resolve(base);
    return firebase.storage().ref(d.path).getDownloadURL()
      .then(function (u) { return fetch(u); })
      .then(function (r) { if (!r.ok) throw new Error('fetch ' + r.status); return r.arrayBuffer().then(function (b) { return { b: b, t: r.headers.get('content-type') }; }); })
      .then(function (x) { return tilesFromBytes(x.b, x.t); })
      .then(function (tiles) { base.tiles = tiles; return base; })
      .catch(function (e) {
        if (window.console) console.warn('Frame: tiling from storage failed, whole-document read', e);
        return base;
      });
  }
  // Same, from a file picked on the device — no network, no CORS. Used by
  // the "read at full resolution from this device" button.
  function payloadFromFile(file, d, model) {
    return file.arrayBuffer().then(function (b) { return tilesFromBytes(b, file.type); })
      .then(function (tiles) { return { path: d.path, hint: d.hint || '', model: model || 'sonnet', name: d.name || file.name, tiles: tiles }; });
  }

  // ══════════════════════════════════════════════════════════════════
  //  PROJECT WIRING
  // ══════════════════════════════════════════════════════════════════
  function docsOf(pid) { var B = BPI(); return B.planDocs ? (B.planDocs(pid) || []) : []; }
  function otherDocs(p, m) {
    return docsOf(p.id).filter(function (d) { return d.id !== m.docId && d.report; });
  }
  // Build (or rebuild) the model for a read document, fill what it lacks
  // from the project's other read documents, and open its tab.
  function fromDoc(pid, did, silent) {
    var p = proj(pid); if (!p) return null;
    var d = docsOf(pid).filter(function (x) { return x.id === did; })[0];
    if (!d || !d.report) { if (!silent) BPI().toast && BPI().toast(tt('המסמך עוד לא נקרא')); return null; }
    var name = String(d.name || d.fileName || d.path || 'plan').split('/').pop();
    var f = fromReport(d.report, name);
    docsOf(pid).forEach(function (o) { if (o.id !== did && o.report) merge(f, fromReport(o.report, o.name || ''), String(o.name || '').split('/').pop()); });
    if (!isArr(p.models)) p.models = [];
    var ex = p.models.filter(function (m) { return m.docId === did; })[0];
    if (ex) {
      // A re-read refreshes what was READ; anything the user typed stays.
      var old = norm(ex.frame);
      Object.keys(old.src).forEach(function (k) { if (old.src[k] === 'user') copyKey(old, f, k); });
      f.ov = mergeOv(old, f); f.off = old.off;
      ex.frame = f; ex.name = name;
    } else {
      ex = { id: 'm' + Date.now().toString(36), docId: did, name: name, frame: f };
      p.models.push(ex);
    }
    save();
    var B = BPI(); if (!silent && B.setTab) B.setTab('m:' + ex.id);
    return ex;
  }
  function copyKey(from, to, k) {
    var parts = k.split('.');
    if (parts[0] === 'x' || parts[0] === 'y') to[parts[0]] = from[parts[0]];
    else if (parts[0] === 'h') to.h[parts[1]] = from.h[parts[1]];
    else if (parts[0] === 'sec') to.sec[parts[1]] = from.sec[parts[1]];
    else if (parts[0] === 'foot') to.foot[parts[1]] = from.foot[parts[1]];
    else if (parts[0] === 'knee') to.knee[parts[1]] = from.knee[parts[1]];
    else if (parts[0] === 'purlinSp' || parts[0] === 'braced' || parts[0] === 'braceDepth') to[parts[0]] = from[parts[0]];
    to.src[k] = 'user';
  }
  function mergeOv(old, f) {
    var o = {};
    Object.keys(f.ov).forEach(function (k) { o[k] = f.ov[k]; });
    Object.keys(old.ov).forEach(function (k) { if (old.src['ov.' + k] === 'user' || !f.ov[k]) { o[k] = old.ov[k]; if (old.src['ov.' + k]) f.src['ov.' + k] = old.src['ov.' + k]; } });
    return o;
  }

  function printSheet() {
    var p = proj(_pid), m = modelOf(p, _mid); if (!m) return;
    var f = m.frame, T = takeoff(f), X = sorted(f.x);
    var secs = X.length ? [X[0].n, X[Math.floor(X.length / 2)].n] : [];
    if (secs[0] === secs[1]) secs.pop();
    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' + esc(m.name) + '</title><style>' +
      '@page{size:A4 landscape;margin:12mm}body{font-family:Arial,sans-serif;color:#222;direction:rtl}' +
      'h1{font-size:17px;margin:0 0 4px}h2{font-size:13px;margin:12px 0 4px}.g{display:grid;grid-template-columns:1fr 1fr;gap:12px}' +
      'table{width:100%;border-collapse:collapse;font-size:11px}td,th{border:1px solid #bbb;padding:4px 6px;text-align:right}' +
      '.w{background:#fff4e0;border:1px solid #e6c68a;padding:6px 8px;font-size:11px;margin:6px 0}' +
      '</style></head><body><h1>' + esc(m.name) + '</h1>' +
      (checks(f).length ? '<div class="w"><b>\u26a0 ' + tt('לא אומת במלואו') + ':</b> ' + checks(f).map(esc).join(' · ') + '</div>' : '') +
      '<div class="g"><div><h2>' + tt('מבט על') + '</h2>' + planSvg(f, null) + '</div><div>' +
      secs.map(function (s) { return '<h2>' + tt('חתך') + ' ' + esc(s) + '</h2>' + sectionSvg(f, s, null); }).join('') +
      '</div></div><h2>' + tt('כתב כמויות') + '</h2>' + boqHtml(T).replace(/fr-tbl/g, '') + '</body></html>';
    if (window.Util && Util.exportReport) Util.exportReport(html, (m.name || 'frame') + '.html');
  }

  // ── public ──────────────────────────────────────────────────────────
  return {
    ROLES: ROLES, norm: norm, blank: blank, fromReport: fromReport, merge: merge,
    elements: elements, takeoff: takeoff, checks: checks, model3d: model3d,
    planSvg: planSvg, sectionSvg: sectionSvg, secDims: secDims,
    tab: tab, mount: mount, destroy: destroy, fromDoc: fromDoc,
    payloadFor: payloadFor, payloadFromFile: payloadFromFile, tilesFromBytes: tilesFromBytes,

    pick: function (id) { selectOnly(id); },
    section: function (xn) { _sec = xn; selectOnly(_sel); var p = proj(_pid); if (p) reopen(); },
    toggle: function (r) {
      _hidden[r] = !_hidden[r];
      if (_v3d) { try { _v3dState = _v3d.getState(); } catch (e) {} }
      reopen();
    },
    set: function (key, v) {
      edit(function (f) {
        var k = key.split('.');
        if (k[0] === 'h') f.h[k[1]] = num(v);
        else if (k[0] === 'sec') f.sec[k[1]] = String(v || '').trim();
        else if (k[0] === 'foot') f.foot[k[1]] = (k[1] === 'plate' || k[1] === 'anchors') ? String(v || '').trim() : num(v);
        else if (k[0] === 'knee') f.knee[k[1]] = num(v);
        else if (key === 'braced') f.braced = String(v || '').split(/[,;\s]+/).filter(function (s) { return /^\S+-\S+$/.test(s); });
        else if (key === 'purlinSp' || key === 'braceDepth') f[key] = num(v);
        f.src[key] = 'user';
      });
    },
    axis: function (key, i, fld, v) {
      edit(function (f) { var a = f[key][i]; if (!a) return; if (fld === 'n') a.n = String(v || '').trim() || a.n; else a.p = num(v); f.src[key] = 'user'; });
    },
    axisAdd: function (key) {
      edit(function (f) {
        var L = f[key], last = L[L.length - 1];
        var name = key === 'y' ? String.fromCharCode(65 + L.length) : String(L.length + 1);
        L.push({ n: name, p: null });
        f.src[key] = 'user';
      });
    },
    axisDel: function (key, i) { edit(function (f) { f[key].splice(i, 1); f.src[key] = 'user'; }); },
    ov: function (fld, v) {
      if (!_sel) return;
      var id = _sel;
      edit(function (f) {
        f.ov[id] = f.ov[id] || {};
        if (fld === 'sec') { var s = String(v || '').trim(); if (s) f.ov[id].sec = s; else delete f.ov[id].sec; }
        else if (fld === 'h') { var n = num(v); if (n != null) f.ov[id].h = n; else delete f.ov[id].h; }
        if (!Object.keys(f.ov[id]).length) { delete f.ov[id]; delete f.src['ov.' + id]; } else f.src['ov.' + id] = 'user';
      });
    },
    reset: function () { var id = _sel; edit(function (f) { delete f.ov[id]; delete f.src['ov.' + id]; }); },
    del: function () { var id = _sel; edit(function (f) { f.off[id] = true; }); },
    restore: function () { var id = _sel; edit(function (f) { delete f.off[id]; }); },
    remove: function () {
      if (!confirm(tt('למחוק את המודל? המסמך עצמו נשאר.'))) return;
      var p = proj(_pid); if (!p || !isArr(p.models)) return;
      p.models = p.models.filter(function (m) { return m.id !== _mid; });
      save(); var B = BPI(); if (B.setTab) B.setTab('plan');
    },
    mergeMenu: function () {
      var p = proj(_pid), m = modelOf(p, _mid); if (!m) return;
      var o = otherDocs(p, m); if (!o.length) return;
      var names = o.map(function (d, i) { return (i + 1) + '. ' + String(d.name || d.path).split('/').pop(); }).join('\n');
      var k = parseInt(prompt(tt('השלם ערכים חסרים מאיזה מסמך?') + '\n' + names, '1'), 10);
      var d = o[k - 1]; if (!d) return;
      edit(function (f) {
        var n = merge(f, fromReport(d.report, d.name || ''), String(d.name || '').split('/').pop());
        var B = BPI(); if (B.toast) B.toast(n ? '\u2705 ' + n + ' ' + tt('ערכים הושלמו') : tt('לא נמצא מה להשלים'));
      });
    },
    print: printSheet
  };
})();
window.Frame = Frame;
