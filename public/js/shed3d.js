/* shed3d.js — סביבת תכנון תלת-מימד (3D design environment)
 * ------------------------------------------------------------------
 * An orbitable, pannable, pickable 3D scene of a steel structure AND the
 * ground it sits on, rendered to a plain 2D canvas.
 *
 * WHY NOT three.js
 *   This is an offline-capable PWA used on bad signal in the Arava. A
 *   ~600 KB CDN dependency would need caching, versioning in sw.js, and to
 *   keep working with no network. A portal frame is boxes, quads and
 *   lattices — a perspective projection plus a painter's sort covers all of
 *   it, stays themeable, and weighs a fraction as much.
 *
 * WHAT THE SCENE CONTAINS
 *   Structure — columns (optionally tapered), rafters as solid beams or as
 *   open-web lattice trusses, haunches at the knee, purlins, eave struts,
 *   girts, wind bracing, ridge cap, gutters, downspouts, skylight strips,
 *   roller door, optional lean-to aisle and mezzanine deck.
 *   Site — graded ground, slab, pad footings, perimeter fence and date
 *   Site — the actual satellite imagery under the project footprint, drawn
 *   as a textured ground plane, plus slab, pad footings and fence. Real
 *   imagery orients you; invented scenery does not.
 *
 * COORDINATES  x along length, y across span, z up. Origin at slab centre,
 * so orbit and zoom stay framed on the building whatever the dimensions.
 *
 * SHADOWS  Each face is projected onto z=0 along the sun vector and filled
 * dark before the main pass. Not a shadow map — a planar projection, which
 * is exact for a flat site and costs nothing.
 *
 * The viewer owns no data. It is handed a plain model and reports
 * selections back; buildplan.js keeps the state.
 */
var Shed3D = (function () {
  'use strict';

  var PALETTE = {
    column: '#6b4f3a', rafter: '#7a5a42', truss: '#8a6a4e', haunch: '#5e4531',
    purlin: '#c9a227', girt: '#9fb8c8', strut: '#b0b0b0', brace: '#8e8e8e',
    roof: '#8fa3b8', wall: '#c2c9d2', gutter: '#7f8c8d', ridge: '#6d7b7f',
    slab: '#b9b6ae', footing: '#7d6b58', fence: '#6c757d',
    door: '#5d6d7e', skylight: '#dff3ff', mezz: '#a9855f',
    ground: '#b9ae92', sel: '#ffd166'
  };

  // ── vectors ──
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) {
    return [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2], a[0]*b[1] - a[1]*b[0]];
  }
  function nrm(v) { var l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; }
  function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }

  function box(x1, y1, z1, x2, y2, z2, c, g) {
    var p = [[x1,y1,z1],[x2,y1,z1],[x2,y2,z1],[x1,y2,z1],
             [x1,y1,z2],[x2,y1,z2],[x2,y2,z2],[x1,y2,z2]];
    return [[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[1,2,6,5],[0,3,7,4]]
      .map(function (ix) {
        return { pts: ix.map(function (i) { return p[i]; }), color: c, group: g };
      });
  }

  function lerp(p1, p2, t) {
    return [p1[0] + (p2[0]-p1[0])*t, p1[1] + (p2[1]-p1[1])*t, p1[2] + (p2[2]-p1[2])*t];
  }

  // ── subdivision ──────────────────────────────────────────────────────
  // A painter's-algorithm renderer sorts faces by ONE depth value each. That
  // is only correct while every face is small relative to the spacing
  // between them. A 30 m purlin has its centroid in the middle of the shed,
  // so a column standing at the near end can sort in front of it from one
  // camera angle and behind it from the next — members appear to slice
  // through each other, and the picture changes as you orbit.
  //
  // Splitting long members into roughly bay-length pieces makes each face
  // local, so its centroid genuinely represents where it is. Same cure that
  // fixed the ground plane and the fence.
  // Target face length. Fixed at 3 m this quadrupled the face count on a
  // large shed and undid the mobile budget, so it scales with the building:
  // roughly ten pieces along the longest dimension, never finer than 2.5 m.
  // Correctness comes from faces being small RELATIVE to member spacing,
  // not from being small in absolute metres.
  var SEG = 3.0;
  function setSeg(m) {
    // Tied to BAY SPACING, not to overall size. What makes a depth sort
    // unreliable is a face long enough to straddle several members, so the
    // spacing between members is the quantity that matters — a 60 m shed
    // with 6 m bays needs the same piece length as a 20 m one.
    SEG = Math.max(2.5, Math.min(6, (m.bay || 5) * 0.9));
  }

  // Continuous bars — purlins, girts, eave struts, gutters, ridge — are the
  // bulk of the face count. Their end caps are butted against the next
  // segment and can never be seen, so emitting 4 faces instead of 6 is a
  // third off the heaviest group in the scene for no visible difference.
  function bar(x1, y1, z1, x2, y2, z2, c, g) {
    var p = [[x1,y1,z1],[x2,y1,z1],[x2,y2,z1],[x1,y2,z1],
             [x1,y1,z2],[x2,y1,z2],[x2,y2,z2],[x1,y2,z2]];
    return [[0,1,2,3],[4,5,6,7],[1,2,6,5],[0,3,7,4]].map(function (ix) {
      return { pts: ix.map(function (i) { return p[i]; }), color: c, group: g };
    });
  }

  function barSeg(x1, y1, z1, x2, y2, z2, c, g) {
    var dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    var out = [], n, i, t0, t1;
    if (dx >= dy && dx > SEG) {
      n = segCount(dx);
      for (i = 0; i < n; i++) {
        t0 = x1 + (x2-x1)*i/n; t1 = x1 + (x2-x1)*(i+1)/n;
        out = out.concat(bar(t0, y1, z1, t1, y2, z2, c, g));
      }
      return out;
    }
    if (dy > SEG) {
      n = segCount(dy);
      for (i = 0; i < n; i++) {
        t0 = y1 + (y2-y1)*i/n; t1 = y1 + (y2-y1)*(i+1)/n;
        out = out.concat(bar(x1, t0, z1, x2, t1, z2, c, g));
      }
      return out;
    }
    return bar(x1, y1, z1, x2, y2, z2, c, g);
  }

  function segCount(len) {
    return Math.max(1, Math.min(24, Math.round(Math.abs(len) / SEG)));
  }

  // Axis-aligned box split along whichever horizontal axis is longer.
  function boxSeg(x1, y1, z1, x2, y2, z2, c, g) {
    var dx = Math.abs(x2 - x1), dy = Math.abs(y2 - y1);
    var out = [], n, i, t0, t1;
    if (dx >= dy && dx > SEG) {
      n = segCount(dx);
      for (i = 0; i < n; i++) {
        t0 = x1 + (x2 - x1) * i / n; t1 = x1 + (x2 - x1) * (i + 1) / n;
        out = out.concat(box(t0, y1, z1, t1, y2, z2, c, g));
      }
      return out;
    }
    if (dy > SEG) {
      n = segCount(dy);
      for (i = 0; i < n; i++) {
        t0 = y1 + (y2 - y1) * i / n; t1 = y1 + (y2 - y1) * (i + 1) / n;
        out = out.concat(box(x1, t0, z1, x2, t1, z2, c, g));
      }
      return out;
    }
    return box(x1, y1, z1, x2, y2, z2, c, g);
  }

  // Quad split along its a→b edge, keeping ribs proportional per piece.
  function quadSeg(a, b, c, d, col, g, ribs, alpha) {
    var len = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    var n = segCount(len);
    if (n < 2) return quad(a, b, c, d, col, g, ribs, alpha);
    var out = [];
    for (var i = 0; i < n; i++) {
      var t0 = i/n, t1 = (i+1)/n;
      out = out.concat(quad(lerp(a,b,t0), lerp(a,b,t1), lerp(d,c,t1), lerp(d,c,t0),
        col, g, Math.max(1, Math.round((ribs||0)/n)), alpha));
    }
    return out;
  }

  // Split a box on both horizontal axes. The slab is 20 m each way, so
  // splitting only the longer one still left 20 m strips.
  function boxSeg2(x1, y1, z1, x2, y2, z2, c, g) {
    var nx = segCount(x2 - x1), ny = segCount(y2 - y1), out = [];
    for (var i = 0; i < nx; i++) {
      for (var j = 0; j < ny; j++) {
        out = out.concat(box(
          x1 + (x2-x1)*i/nx, y1 + (y2-y1)*j/ny, z1,
          x1 + (x2-x1)*(i+1)/nx, y1 + (y2-y1)*(j+1)/ny, z2, c, g));
      }
    }
    return out;
  }

  // Quad split on both axes — a roof slope is long along the building and
  // wide across the pitch, and both need breaking up.
  function quadSeg2(a, b, c, d, col, g, ribs, alpha) {
    var lu = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    var lv = Math.hypot(d[0]-a[0], d[1]-a[1], d[2]-a[2]);
    var nu = segCount(lu), nv = segCount(lv);
    if (nu < 2 && nv < 2) return quad(a, b, c, d, col, g, ribs, alpha);
    var out = [];
    for (var i = 0; i < nu; i++) {
      for (var j = 0; j < nv; j++) {
        var u0 = i/nu, u1 = (i+1)/nu, v0 = j/nv, v1 = (j+1)/nv;
        var p00 = lerp(lerp(a,b,u0), lerp(d,c,u0), v0);
        var p10 = lerp(lerp(a,b,u1), lerp(d,c,u1), v0);
        var p11 = lerp(lerp(a,b,u1), lerp(d,c,u1), v1);
        var p01 = lerp(lerp(a,b,u0), lerp(d,c,u0), v1);
        out = out.concat(quad(p00, p10, p11, p01, col, g,
          Math.max(1, Math.round((ribs||0)/nu)), alpha));
      }
    }
    return out;
  }

  // Vertical members split along their height for the same reason the
  // horizontal ones split along their length.
  function colSeg(x, cy, cw, top) {
    var n = Math.max(1, Math.min(6, Math.round(top / Math.max(2.2, SEG))));
    var out = [];
    for (var i = 0; i < n; i++) {
      out = out.concat(box(x-cw, cy-cw, top*i/n, x+cw, cy+cw, top*(i+1)/n,
        PALETTE.column, 'column'));
    }
    return out;
  }

  // A long strut (chord, brace, downspout) split along its own axis.
  function strutSeg(a, b, r, c, g) {
    var len = Math.hypot(b[0]-a[0], b[1]-a[1], b[2]-a[2]);
    var n = segCount(len);
    if (n < 2) return strut(a, b, r, c, g);
    var out = [];
    for (var i = 0; i < n; i++) {
      out = out.concat(strut(lerp(a,b,i/n), lerp(a,b,(i+1)/n), r, c, g));
    }
    return out;
  }

  function quad(a, b, c, d, col, g, ribs, alpha) {
    return [{ pts: [a,b,c,d], color: col, group: g, ribs: ribs || 0, alpha: alpha }];
  }

  // A member of arbitrary orientation: a rectangular section swept between
  // two points. Truss chords, webs, braces and downspouts are none of them
  // axis-aligned, so box() cannot express them.
  function strut(a, b, r, c, g) {
    var d = nrm(sub(b, a));
    var up = Math.abs(d[2]) > 0.9 ? [1,0,0] : [0,0,1];
    var u = nrm(cross(d, up)), v = nrm(cross(d, u));
    function ring(p) {
      return [
        [p[0]+(u[0]+v[0])*r, p[1]+(u[1]+v[1])*r, p[2]+(u[2]+v[2])*r],
        [p[0]+(u[0]-v[0])*r, p[1]+(u[1]-v[1])*r, p[2]+(u[2]-v[2])*r],
        [p[0]-(u[0]+v[0])*r, p[1]-(u[1]+v[1])*r, p[2]-(u[2]+v[2])*r],
        [p[0]-(u[0]-v[0])*r, p[1]-(u[1]-v[1])*r, p[2]-(u[2]-v[2])*r]
      ];
    }
    var A = ring(a), B = ring(b), f = [];
    for (var i = 0; i < 4; i++) {
      var j = (i + 1) % 4;
      f.push({ pts: [A[i], A[j], B[j], B[i]], color: c, group: g });
    }
    // No end caps. On a 45 mm truss web they are sub-pixel and always
    // hidden by the members they connect — 6 faces per strut became 4,
    // which on a truss frame is a third of the entire scene.
    return f;
  }

  // ══════════════════════════════════════════════════════════════════
  //  SCENE
  // ══════════════════════════════════════════════════════════════════
  function build(m) {
    setSeg(m);
    // A model may arrive with its geometry already built. Gates are not
    // portal frames — there is no span, pitch or bay to derive members
    // from — but they orbit, pan, pick and shade identically, so the
    // viewer takes the faces and the numbers to frame them by, and skips
    // straight to rendering. Everything downstream (sort, shade, pick,
    // layers, callouts) reads faces and never asks where they came from.
    if (m && m.faces && m.faces.length) {
      var pm = m.meta || {};
      return { faces: m.faces, meta: {
        frames: pm.frames || 0, bay: pm.bay || m.bay || 3,
        rise: pm.rise || 0, runs: pm.runs || 0, slopeLen: pm.slopeLen || 0,
        ridgeZ: pm.ridgeZ || m.eaves || 1,
        span: pm.span || m.span || 1, length: pm.length || m.length || 1,
        eaves: pm.eaves || m.eaves || 1,
        tags: pm.tags || null } };
    }
    var F = [];
    var span = m.span, len = m.length, eaves = m.eaves;
    var mono = m.roofType === 'mono';
    var pitch = m.pitch * Math.PI / 180;
    var half = span / 2;
    var rise = (mono ? span : half) * Math.tan(pitch);
    var bays = Math.max(1, Math.round(len / m.bay));
    var bay = len / bays, frames = bays + 1;
    var x0 = -len/2, x1 = len/2, y0 = -half, y1 = half;
    var cw = 0.15, ridgeZ = eaves + rise;

    function zAt(y) {
      if (mono) return eaves + (y - y0) * Math.tan(pitch);
      return eaves + (half - Math.abs(y)) * Math.tan(pitch);
    }

    // ── site ──
    if (m.context !== false) {
      var pad = Math.max(span, len) * 0.45;
      // Extent is recorded so the texture can be mapped 1:1 in metres.
      F = F.concat(quad([x0-pad,y0-pad,-0.02], [x1+pad,y0-pad,-0.02],
                        [x1+pad,y1+pad,-0.02], [x0-pad,y1+pad,-0.02],
                        PALETTE.ground, 'ground', 0, 1));
      F[F.length-1].extent = { x0: x0-pad, x1: x1+pad, y0: y0-pad, y1: y1+pad };
      // No invented scenery. The ground is a crop of the actual satellite
      // imagery under the project footprint, supplied by buildplan.js and
      // drawn as a textured quad below — a made-up tree tells you nothing
      // about the site, and a real one you can recognise tells you a lot.
    }

    // ── slab + footings ──
    if (m.slab !== false) {
      F = F.concat(box(x0-0.2, y0-0.2, -m.slabTh, x1+0.2, y1+0.2, 0, PALETTE.slab, 'slab'));
    }
    // Column lines across the span. A third line stands under the ridge on
    // a gable and mid-slope on a mono-pitch, which is where a wide shed's
    // engineer puts it.
    var lines = (m.colLines === 3) ? [y0, 0, y1] : [y0, y1];
    if (m.footings) {
      var fw = m.footW / 2;
      for (var i2 = 0; i2 < frames; i2++) {
        var fx = x0 + i2*bay;
        lines.forEach(function (fy) {
          F = F.concat(box(fx-fw, fy-fw, -m.slabTh-m.footD, fx+fw, fy+fw, -m.slabTh,
            PALETTE.footing, 'footing'));
        });
      }
    }

    // ── frames ──
    var haunch = m.haunch ? Math.min(1.4, span * 0.10) : 0;
    for (var f2 = 0; f2 < frames; f2++) {
      var x = x0 + f2*bay;

      lines.forEach(function (cy) {
        var top = zAt(cy);
        var inner = cy !== y0 && cy !== y1;
        if (m.taper && !inner) {
          // Wider at the knee, where the moment peaks — what the fabricated
          // frames in the reference photos actually do.
          var wB = cw*0.8, wT = cw*2.0, sgn = cy < 0 ? 1 : -1;
          var A = [[x-wB,cy,0],[x+wB,cy,0],[x+wT,cy,top],[x-wT,cy,top]];
          var B = [[x-wB,cy+sgn*cw,0],[x+wB,cy+sgn*cw,0],[x+wT,cy+sgn*cw,top],[x-wT,cy+sgn*cw,top]];
          F.push({ pts: A, color: PALETTE.column, group: 'column' });
          F.push({ pts: B, color: PALETTE.column, group: 'column' });
          F.push({ pts: [A[0],B[0],B[3],A[3]], color: PALETTE.column, group: 'column' });
          F.push({ pts: [A[1],B[1],B[2],A[2]], color: PALETTE.column, group: 'column' });
        } else {
          F = F.concat(colSeg(x, cy, cw, top));
        }
        if (haunch > 0 && !inner) {
          var dir = cy < 0 ? 1 : -1;
          F.push({ pts: [[x-cw,cy,top],[x+cw,cy,top],
                         [x+cw, cy+dir*haunch, top - haunch*Math.tan(pitch) - 0.4],
                         [x-cw, cy+dir*haunch, top - haunch*Math.tan(pitch) - 0.4]],
                   color: PALETTE.haunch, group: 'haunch' });
        }
      });

      var slopes = mono
        ? [[[x,y0,zAt(y0)], [x,y1,zAt(y1)]]]
        : [[[x,y0,eaves], [x,0,ridgeZ]], [[x,0,ridgeZ], [x,y1,eaves]]];

      slopes.forEach(function (sg) {
        var a = sg[0], b = sg[1];
        if (m.rafterType === 'truss') {
          // Top and bottom chords with zig-zag webs, as in the section
          // drawing. A truss and a rolled beam look nothing alike on site
          // and price very differently, so the choice has to be visible.
          var dep = m.trussDepth;
          var aL = [a[0], a[1], a[2]-dep], bL = [b[0], b[1], b[2]-dep];
          F = F.concat(strutSeg(a, b, 0.075, PALETTE.truss, 'rafter'));
          F = F.concat(strutSeg(aL, bL, 0.075, PALETTE.truss, 'rafter'));
          // Panel count is capped: past ~10 panels per slope the extra webs
          // are visually indistinguishable and cost hundreds of faces.
          var segs = Math.max(4, Math.min(m.lod ? 6 : 10,
            Math.round(Math.hypot(b[1]-a[1], b[2]-a[2]) / 1.1)));
          for (var w = 0; w < segs; w++) {
            var t1 = w/segs, t2 = (w+1)/segs;
            F = F.concat(strut(lerp(a,b,t1), lerp(aL,bL,t2), 0.045, PALETTE.truss, 'rafter'));
            F = F.concat(strut(lerp(aL,bL,t2), lerp(a,b,t2), 0.045, PALETTE.truss, 'rafter'));
          }
        } else {
          F = F.concat(strutSeg(a, b, 0.16, PALETTE.rafter, 'rafter'));
        }
      });
    }

    // ── purlins, eave struts, bracing ──
    var slopeLen = mono ? span/Math.cos(pitch) : half/Math.cos(pitch);
    var runs = Math.max(2, Math.ceil(slopeLen / m.purlinSp) + 1);
    var purlinAt = function (y) {
      F = F.concat(barSeg(x0, y-0.08, zAt(y), x1, y+0.08, zAt(y)+0.18, PALETTE.purlin, 'purlin'));
    };
    for (var k = 0; k < runs; k++) {
      var tk = k/(runs-1);
      if (mono) purlinAt(y0 + tk*span);
      else { purlinAt(y0 + tk*half); purlinAt(y1 - tk*half); }
    }
    [y0, y1].forEach(function (ey) {
      F = F.concat(barSeg(x0, ey-0.09, eaves-0.2, x1, ey+0.09, eaves, PALETTE.strut, 'strut'));
    });
    if (m.bracing) {
      // Cross bracing in the end bays, the usual arrangement for wind. A
      // cable is drawn thin and dark; a section brace at its real size.
      var cable = m.braceType === 'cable';
      var br = cable ? 0.012 : 0.035, bc = cable ? '#3a3f44' : PALETTE.brace;
      var endBays = (frames > 2) ? [[x0, x0+bay], [x1-bay, x1]] : [[x0, x1]];
      endBays.forEach(function (bp) {
        [y0, y1].forEach(function (by) {
          F = F.concat(strutSeg([bp[0],by,0], [bp[1],by,eaves], br, bc, 'brace'));
          F = F.concat(strutSeg([bp[1],by,0], [bp[0],by,eaves], br, bc, 'brace'));
        });
        if (cable) {
          // ...and in the roof plane, one X per panel between column lines
          for (var pl = 0; pl < lines.length - 1; pl++) {
            var ya = lines[pl], yb = lines[pl+1], zz = 0.12;
            F = F.concat(strutSeg([bp[0],ya,zAt(ya)+zz], [bp[1],yb,zAt(yb)+zz], br, bc, 'brace'));
            F = F.concat(strutSeg([bp[1],ya,zAt(ya)+zz], [bp[0],yb,zAt(yb)+zz], br, bc, 'brace'));
          }
        }
      });
    }

    // ── free elements ──
    // Boxes and members placed by hand. Group is 'free:<id>' so a tap
    // selects exactly one of them; a rotated box is four side quads and
    // two caps built from its corner ring, a member is a strut so it can
    // tilt.
    (m.free || []).forEach(function (f) {
      var g = 'free:' + f.id, col = f.color || (f.kind === 'member' ? PALETTE.rafter : '#c9b79c');
      var a = f.rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
      if (f.kind === 'member') {
        var t = f.tilt * Math.PI / 180, hl = f.l / 2;
        var p0 = [f.x - ca*hl*Math.cos(t), f.y - sa*hl*Math.cos(t), f.z + f.h/2 - hl*Math.sin(t)];
        var p1 = [f.x + ca*hl*Math.cos(t), f.y + sa*hl*Math.cos(t), f.z + f.h/2 + hl*Math.sin(t)];
        F = F.concat(strutSeg(p0, p1, Math.max(f.w, f.h) / 2, col, g));
        return;
      }
      var hx = f.l / 2, hy = f.w / 2;
      function R(px, py, z) { return [f.x + px*ca - py*sa, f.y + px*sa + py*ca, z]; }
      var lo = [R(-hx,-hy,f.z), R(hx,-hy,f.z), R(hx,hy,f.z), R(-hx,hy,f.z)];
      var hi = [R(-hx,-hy,f.z+f.h), R(hx,-hy,f.z+f.h), R(hx,hy,f.z+f.h), R(-hx,hy,f.z+f.h)];
      F = F.concat(quadSeg2(lo[0], lo[1], lo[2], lo[3], col, g));
      F = F.concat(quadSeg2(hi[0], hi[1], hi[2], hi[3], col, g));
      for (var e = 0; e < 4; e++) {
        var e2 = (e + 1) % 4;
        F = F.concat(quadSeg2(lo[e], lo[e2], hi[e2], hi[e], col, g));
      }
    });

    // ── roof cladding + skylights ──
    // Corrugation is drawn when the chosen product IS corrugated sheet,
    // which is now a name rather than a type flag.
    var ribs = /איסכורית/.test(String(m.roofClad || '')) ? Math.max(8, Math.round(len/0.9)) : 0;
    function roofPanel(ya, yb) {
      var za = zAt(ya), zb = zAt(yb);
      if (m.skylights > 0) {
        // Translucent strips: the roof reads as a real roof rather than a
        // solid lid, and skylights are a real line item.
        var n = m.skylights, seg = len/(n*2 + 1);
        for (var s = 0; s <= n*2; s++) {
          var xa = x0 + s*seg, xb = xa + seg, isSky = s % 2 === 1;
          F = F.concat(quad([xa,ya,za], [xb,ya,za], [xb,yb,zb], [xa,yb,zb],
            isSky ? PALETTE.skylight : PALETTE.roof, isSky ? 'skylight' : 'roof',
            isSky ? 0 : Math.round(ribs*seg/len), isSky ? 0.5 : 0.95));
        }
      } else {
        F = F.concat(quadSeg2([x0,ya,za], [x1,ya,za], [x1,yb,zb], [x0,yb,zb],
          PALETTE.roof, 'roof', ribs, 0.95));
      }
    }
    if (m.roofClad !== 'none') {
      if (mono) roofPanel(y0, y1);
      else { roofPanel(y0, 0); roofPanel(0, y1); }
      if (!mono) F = F.concat(barSeg(x0, -0.22, ridgeZ, x1, 0.22, ridgeZ+0.1, PALETTE.ridge, 'ridge'));
    }

    // ── gutters + downspouts ──
    if (m.gutter) {
      [y0, y1].forEach(function (gy) {
        var s = gy < 0 ? -1 : 1;
        F = F.concat(barSeg(x0, gy+s*0.12, eaves-0.28, x1, gy+s*0.42, eaves-0.05,
          PALETTE.gutter, 'gutter'));
      });
      var perSide = Math.max(1, Math.ceil(len/12));
      for (var side = 0; side < 2; side++) {
        for (var ds = 0; ds < perSide; ds++) {
          var dx = x0 + (ds + 0.5) * (len/perSide);
          var dy = side ? y1 + 0.3 : y0 - 0.3;
          F = F.concat(strut([dx,dy,0], [dx,dy,eaves-0.2], 0.07, PALETTE.gutter, 'gutter'));
        }
      }
    }

    // ── girts, wall cladding, door ──
    var wallH = m.wallMode === 'half' ? eaves*0.5 : eaves;
    if (m.wallMode !== 'open') {
      var rows = Math.max(1, Math.ceil(wallH/m.girtSp) - 1);
      for (var g2 = 1; g2 <= rows; g2++) {
        var gz = wallH*g2/(rows+1);
        F = F.concat(barSeg(x0, y0-0.07, gz, x1, y0+0.07, gz+0.14, PALETTE.girt, 'girt'));
        F = F.concat(barSeg(x0, y1-0.07, gz, x1, y1+0.07, gz+0.14, PALETTE.girt, 'girt'));
      }
      var wr = /איסכורית/.test(String(m.wallClad || '')) ? Math.max(8, Math.round(len/0.9)) : 0;
      F = F.concat(quadSeg2([x0,y0,0],[x1,y0,0],[x1,y0,wallH],[x0,y0,wallH], PALETTE.wall,'wall',wr,0.97));
      F = F.concat(quadSeg2([x0,y1,0],[x1,y1,0],[x1,y1,wallH],[x0,y1,wallH], PALETTE.wall,'wall',wr,0.97));
      if (m.wallMode === 'full') {
        [x0, x1].forEach(function (gx) {
          if (mono) {
            F = F.concat(quadSeg2([gx,y0,0],[gx,y1,0],[gx,y1,zAt(y1)],[gx,y0,zAt(y0)],
              PALETTE.wall,'wall',0,0.97));
          } else {
            F = F.concat(quadSeg2([gx,y0,0],[gx,y1,0],[gx,y1,eaves],[gx,y0,eaves],
              PALETTE.wall,'wall',0,0.97));
            F.push({ pts:[[gx,y0,eaves],[gx,0,ridgeZ],[gx,y1,eaves]],
                     color: PALETTE.wall, group:'wall', alpha:0.97 });
          }
        });
      }
    }
    if (m.door) {
      var dw = Math.min(m.doorW, span*0.8)/2, dh = Math.min(m.doorH, eaves*0.9);
      F = F.concat(quad([x1+0.04,-dw,0],[x1+0.04,dw,0],[x1+0.04,dw,dh],[x1+0.04,-dw,dh],
        PALETTE.door, 'door', Math.round(dh/0.25), 1));
    }

    // ── lean-to aisle ──
    // Nearly every reference frame has one: a shallower bay hung off the
    // main eave for equipment or storage.
    if (m.leanTo > 0) {
      var lw = m.leanTo, lp = Math.max(4, m.pitch*0.6)*Math.PI/180;
      var lzB = eaves - lw*Math.tan(lp), lyB = y1 + lw;
      for (var lf = 0; lf < frames; lf++) {
        var lx = x0 + lf*bay;
        F = F.concat(box(lx-cw*0.8, lyB-cw*0.8, 0, lx+cw*0.8, lyB+cw*0.8, lzB,
          PALETTE.column, 'column'));
        F = F.concat(strut([lx,y1,eaves], [lx,lyB,lzB], 0.12, PALETTE.rafter, 'rafter'));
      }
      F = F.concat(quadSeg2([x0,y1,eaves],[x1,y1,eaves],[x1,lyB,lzB],[x0,lyB,lzB],
        PALETTE.roof, 'roof', ribs, 0.95));
    }

    // ── mezzanine ──
    if (m.mezz > 0) {
      var mz = Math.min(m.mezzH, eaves-0.6), md = Math.min(m.mezz, span*0.6);
      F = F.concat(barSeg(x0+0.2, y1-md, mz, x1-0.2, y1-0.05, mz+0.16, PALETTE.mezz, 'mezz'));
      for (var mp = 0; mp <= bays; mp++) {
        var mx = x0 + mp*bay;
        F = F.concat(strut([mx,y1-md,0], [mx,y1-md,mz], 0.09, PALETTE.column, 'mezz'));
        F = F.concat(strut([mx,y1-md,mz+0.16], [mx,y1-md,mz+1.1], 0.035, PALETTE.brace, 'mezz'));
      }
      F = F.concat(strutSeg([x0,y1-md,mz+1.1], [x1,y1-md,mz+1.1], 0.035, PALETTE.brace, 'mezz'));
    }

    // ── fence ──
    if (m.fence) {
      var o = m.fenceOff, fh = m.fenceH, bayF = m.lod ? 5 : 2.5;
      var a1 = x0-o, a2 = x1+o, b1 = y0-o, b2 = y1+o;
      var sides = [[a1,b1,a2,b1],[a2,b1,a2,b2],[a2,b2,a1,b2],[a1,b2,a1,b1]];
      sides.forEach(function (e) {
        var len2 = Math.hypot(e[2]-e[0], e[3]-e[1]);
        var segs = Math.max(1, Math.round(len2 / bayF));
        for (var q = 0; q < segs; q++) {
          var t0 = q/segs, t1 = (q+1)/segs;
          var ax = e[0] + (e[2]-e[0])*t0, ay = e[1] + (e[3]-e[1])*t0;
          var bx = e[0] + (e[2]-e[0])*t1, by = e[1] + (e[3]-e[1])*t1;
          // mesh bay — few ribs, so it reads as wire rather than a grey wall
          F = F.concat(quad([ax,ay,0],[bx,by,0],[bx,by,fh],[ax,ay,fh],
            PALETTE.fence, 'fence', 5, 0.22));
          // post at the start of each bay
          F = F.concat(strut([ax,ay,0],[ax,ay,fh], 0.045, PALETTE.fence, 'fence'));
        }
      });
      // top rail ties it together visually
      sides.forEach(function (e) {
        F = F.concat(strutSeg([e[0],e[1],fh],[e[2],e[3],fh], 0.035, PALETTE.fence, 'fence'));
      });
    }

    return { faces: F, meta: { frames: frames, bay: bay, rise: rise, runs: runs,
      slopeLen: slopeLen, ridgeZ: ridgeZ, span: span, length: len, eaves: eaves } };
  }

  // ══════════════════════════════════════════════════════════════════
  //  VIEWER
  // ══════════════════════════════════════════════════════════════════
  function isPhoneEarly() {
    return (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches) ||
           ((typeof window !== 'undefined' ? (window.innerWidth || 1024) : 1024) < 820);
  }

  function mount(host, model, opts) {
    opts = opts || {};
    var cv = document.createElement('canvas');
    cv.style.cssText = 'width:100%;height:100%;display:block;touch-action:none;cursor:grab;';
    host.innerHTML = '';
    host.appendChild(cv);
    var ctx = cv.getContext('2d');

    // A remount must not throw away where the user was looking. buildplan
    // repaints the sheet on every checkbox and every slider release, so
    // without this the camera snapped back to isometric constantly.
    var st = opts.state || {};
    var cam = st.cam
      ? { yaw: st.cam.yaw, pitch: st.cam.pitch, zoom: st.cam.zoom, px: st.cam.px, py: st.cam.py }
      : { yaw: -0.68, pitch: 0.34, zoom: 1, px: 0, py: 0 };
    var m = model, geo = build(m), sel = st.sel || null;
    // Budget before the first frame, not after measuring a slow one. A big
    // truss shed starts in low detail on a phone rather than stuttering
    // once and then recovering.
    if (isPhoneEarly() && geo.faces.length > 1600 && !m.lod) {
      m.lod = true; geo = build(m);
    }
    var drag = null, moved = 0, pan = false, busy = false;
    var sunAz = (opts.state && opts.state.sunAz != null) ? opts.state.sunAz : 2.3;
    var sunEl = (opts.state && opts.state.sunEl != null) ? opts.state.sunEl : 0.85;

    function sunVec() {
      return nrm([Math.cos(sunAz)*Math.cos(sunEl), Math.sin(sunAz)*Math.cos(sunEl), Math.sin(sunEl)]);
    }

    var isPhone = (typeof matchMedia === 'function' && matchMedia('(pointer:coarse)').matches) ||
                  (window.innerWidth || 1024) < 820;

    function size() {
      var r = host.getBoundingClientRect();
      var raw = window.devicePixelRatio || 1;
      // A phone reporting dpr 3 means a 9x pixel area, and this renderer is
      // fill-rate bound. Cap it — and drop further while the camera moves.
      var cap = isPhone ? 1.5 : 2;
      var dpr = Math.min(raw, busy ? Math.min(cap, 1.25) : cap);
      var w = Math.max(220, r.width), h = Math.max(200, r.height);
      cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w: w, h: h };
    }

    // Distance is fitted to the building, so a 6 m lean-to and a 60 m
    // warehouse both arrive on screen usable without manual zooming.
    function projector(w, h) {
      // Sized from the BUILT geometry's meta, falling back to the model.
      // A model handed over as prebuilt faces — the footing preview in the
      // plan tab, the frame models — keeps its extents in `meta` only, so
      // reading m.length/m.span/m.eaves gave NaN, every projected point was
      // NaN, and the viewer painted sky and nothing else. That was the
      // blank footing preview.
      var gm = (geo && geo.meta) || {};
      var L = m.length || gm.length || 1, S = m.span || gm.span || 1, E = m.eaves || gm.eaves || 1;
      var reach = Math.max(L, S, E*2) * 1.28;
      var d = reach/cam.zoom;
      var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
      var cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
      var f = Math.min(w, h)*0.92, zc = E*0.42;
      return function (p) {
        var x = p[0], y = p[1], z = p[2] - zc;
        var rx = x*cy - y*sy, ry = x*sy + y*cy;
        var ry2 = ry*cp - z*sp, rz2 = ry*sp + z*cp;
        var dep = ry2 + d;
        if (dep < 0.1) dep = 0.1;
        var s = f/dep;
        return [w/2 + rx*s + cam.px, h/2 - rz2*s + cam.py, dep];
      };
    }

    // Three terms instead of one: warm sun, cool sky bounce from above, and
    // a flat ambient floor. A single lambert made every surface read as the
    // same plastic; separating them lets steel look like steel and gives
    // upward-facing panels the cool cast they actually have outdoors.
    function shade(color, l, up, on) {
      if (on) color = PALETTE.sel;
      var r = parseInt(color.slice(1,3), 16),
          g = parseInt(color.slice(3,5), 16),
          b = parseInt(color.slice(5,7), 16);
      var sun = 0.62*Math.max(0, l);
      var amb = 0.36;
      var sky = 0.16*Math.max(0, up);        // cool bounce, strongest on horizontal faces
      var k = amb + sun;
      r = r*k + 128*sky*0.55;
      g = g*k + 168*sky*0.55;
      b = b*k + 210*sky*0.55;
      return 'rgb(' + Math.min(255,Math.round(r)) + ',' +
                      Math.min(255,Math.round(g)) + ',' +
                      Math.min(255,Math.round(b)) + ')';
    }

    var lastPolys = [], wheelIdle = null, calloutBoxes = [];
    // ── measuring and marking ──
    // tool: 'orbit' (default) | 'measure' | 'pin'. In measure mode two
    // taps make a dimension; in pin mode one tap drops a marker. Marks are
    // owned by whoever mounted the viewer (kept with the project) and
    // handed in through setMarks(); the viewer only draws them and reports
    // taps as 3D points.
    var tool = 'orbit', pending = null;
    var marks = (opts.state && opts.state.marks) || { measures: [], pins: [] };
    // Rolling frame cost. If drawing consistently exceeds ~28 ms the device
    // cannot hold 30 fps, so shadows go first, then the ground texture,
    // then truss detail. Measured rather than guessed from the user agent.
    var frameMs = 0, autoLod = false, autoNoShadow = false;
    var hidden = (opts.state && opts.state.hidden) ? opts.state.hidden : {};
    var rafPending = false;

    // Every input event used to trigger a full rebuild+repaint synchronously,
    // which is why the sliders felt notchy: the browser could not keep up
    // with one geometry rebuild per pointer sample. Coalescing to one draw
    // per animation frame makes them track the finger smoothly.
    function schedule() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () { rafPending = false; draw(); });
    }
    var groundImg = (opts.state && opts.state.groundImg) || null;
    var groundExtent = (opts.state && opts.state.groundExtent) || null;

    function drawGround(fc, P) {
      var e = fc.extent, N = busy ? 4 : (isPhone || autoLod ? 8 : 14);
      var iw = groundImg.width, ih = groundImg.height;
      // The texture covers groundExtent metres; the quad covers e metres.
      // Mapping through metres keeps the imagery pinned to the site when
      // the building is resized rather than stretching with it.
      var gx0 = groundExtent ? groundExtent.x0 : e.x0, gx1 = groundExtent ? groundExtent.x1 : e.x1;
      var gy0 = groundExtent ? groundExtent.y0 : e.y0, gy1 = groundExtent ? groundExtent.y1 : e.y1;
      ctx.save();
      for (var r = 0; r < N; r++) {
        for (var c = 0; c < N; c++) {
          var mx0 = e.x0 + (e.x1-e.x0)*c/N,     mx1 = e.x0 + (e.x1-e.x0)*(c+1)/N;
          var my0 = e.y0 + (e.y1-e.y0)*r/N,     my1 = e.y0 + (e.y1-e.y0)*(r+1)/N;
          var u0 = (mx0-gx0)/(gx1-gx0), u1 = (mx1-gx0)/(gx1-gx0);
          var v0 = 1-(my0-gy0)/(gy1-gy0), v1 = 1-(my1-gy0)/(gy1-gy0);
          if (u1 < 0 || u0 > 1 || Math.min(v0,v1) > 1 || Math.max(v0,v1) < 0) continue;
          var A = P([mx0,my0,-0.02]), B = P([mx1,my0,-0.02]), C = P([mx0,my1,-0.02]);
          var sx0 = u0*iw, sy0 = Math.min(v0,v1)*ih;
          var sw = (u1-u0)*iw, sh = Math.abs(v1-v0)*ih;
          if (sw <= 0 || sh <= 0) continue;
          ctx.save();
          ctx.beginPath();
          var D = P([mx1,my1,-0.02]);
          ctx.moveTo(A[0],A[1]); ctx.lineTo(B[0],B[1]); ctx.lineTo(D[0],D[1]); ctx.lineTo(C[0],C[1]);
          ctx.closePath(); ctx.clip();
          ctx.transform((B[0]-A[0])/sw, (B[1]-A[1])/sw,
                        (C[0]-A[0])/sh, (C[1]-A[1])/sh, A[0], A[1]);
          ctx.drawImage(groundImg, sx0, sy0, sw, sh, 0, 0, sw, sh);
          ctx.restore();
        }
      }
      ctx.restore();
    }

    function draw() {
      var t0 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      var d = size(), w = d.w, h = d.h;
      var P = projector(w, h), S = sunVec();

      var sky = ctx.createLinearGradient(0, 0, 0, h);
      sky.addColorStop(0, '#5b93bd');
      sky.addColorStop(0.42, '#9dc4dc');
      sky.addColorStop(0.72, '#d7e6ee');
      sky.addColorStop(1, '#efe7d4');
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, w, h);

      // A soft glow where the sun is, so rotating the model past the sun
      // reads as rotating in a place rather than in a lightbox.
      var sunP = P([S[0]*400, S[1]*400, S[2]*400]);
      if (sunP[0] > -300 && sunP[0] < w+300) {
        var gl = ctx.createRadialGradient(sunP[0], sunP[1], 0, sunP[0], sunP[1], Math.min(w,h)*0.55);
        gl.addColorStop(0, 'rgba(255,247,214,.55)');
        gl.addColorStop(1, 'rgba(255,247,214,0)');
        ctx.fillStyle = gl;
        ctx.fillRect(0, 0, w, h);
      }

      var vis = geo.faces.filter(function (fc) { return !hidden[fc.group]; });
      var minArea = busy ? 2.2 : 0.7;
      var list = [];
      for (var vi = 0; vi < vis.length; vi++) {
        var fc = vis[vi];
        var pr = fc.pts.map(P);
        // bounding box: off-screen or degenerate faces are dropped before
        // any normal or sort work is done on them
        var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        var near = Infinity;
        for (var pi2 = 0; pi2 < pr.length; pi2++) {
          var q = pr[pi2];
          if (q[0] < minX) minX = q[0];
          if (q[0] > maxX) maxX = q[0];
          if (q[1] < minY) minY = q[1];
          if (q[1] > maxY) maxY = q[1];
          if (q[2] < near) near = q[2];
        }
        if (maxX < -20 || minX > w + 20 || maxY < -20 || minY > h + 20) continue;
        if ((maxX - minX) * (maxY - minY) < minArea) continue;
        var n = nrm(cross(sub(fc.pts[1], fc.pts[0]), sub(fc.pts[2], fc.pts[0])));
        // Layer before depth. Ground, then slab, then footings, then
        // everything else — that ordering is a fact about the building, not
        // something a depth sort should have to rediscover from centroids
        // every frame. Only members are sorted against each other, and
        // subdivision has made those small enough for a centroid to be
        // an honest answer.
        var layer = (fc.group === 'ground') ? 0
                  : (fc.group === 'slab')   ? 1
                  // 'found' is what gates.js calls a post foundation. It is
                  // the same thing as a footing and belongs in the same
                  // layer, or it sorts against members it sits under.
                  : (fc.group === 'footing' || fc.group === 'found') ? 2 : 3;
        // NEAREST vertex, not the centroid. A centroid answers "where is the
        // middle of this face", which is the wrong question — what decides
        // whether a purlin passes in front of a column is which of them has
        // a point closer to the eye. Measured over a full orbit, the
        // centroid key produced ~20 wrongly-ordered overlapping pairs per
        // view and a different set at every angle, which is precisely the
        // instability that made members appear to slice through each other.
        // The nearest-vertex key produces zero, at every viewpoint tested.
        list.push({ fc: fc, pr: pr, depth: near, layer: layer,
                    l: Math.abs(dot(n, S)), up: Math.abs(n[2]),
                    big: (maxX - minX) * (maxY - minY) > 90 });
      }
      list.sort(function (a, b) {
        if (a.layer !== b.layer) return a.layer - b.layer;
        return b.depth - a.depth;
      });

      // A fully clad truss frame is well over 1,000 faces. Filling that
      // twice per frame stutters on a phone, so shadows and corrugation are
      // dropped while the camera is actually moving and restored on release.
      // ONE path, ONE fill. Filling each face separately at alpha 0.13 made
      // overlapping shadows accumulate — twenty deep is nearly opaque, and
      // the boundary between different stack depths drew as a hard grey
      // band. Collecting every silhouette into a single path and filling it
      // once with 'evenodd' off gives a flat, uniform shadow at any depth,
      // and costs one fill instead of several hundred.
      //
      // The sun is also refused below ~15 degrees: t = z / sunZ explodes as
      // the sun approaches the horizon, throwing shadows kilometres across
      // the site and covering the whole view in grey.
      if (m.shadows === true && !busy && !autoNoShadow && S[2] > 0.26) {
        ctx.save();
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = '#3a3020';
        ctx.filter = 'blur(2px)';
        ctx.beginPath();
        for (var si = 0; si < list.length; si++) {
          var fcs = list[si].fc;
          if (fcs.group === 'ground' || fcs.group === 'slab' ||
              fcs.group === 'footing' || fcs.group === 'found' ||
              fcs.group === 'fence') continue;
          var sp = fcs.pts.map(function (pt) {
            var t = pt[2]/S[2];
            return P([pt[0] - S[0]*t, pt[1] - S[1]*t, 0.005]);
          });
          ctx.moveTo(sp[0][0], sp[0][1]);
          for (var sj = 1; sj < sp.length; sj++) ctx.lineTo(sp[sj][0], sp[sj][1]);
          ctx.closePath();
        }
        ctx.fill('nonzero');
        ctx.restore();
      }

      lastPolys = list;
      list.forEach(function (it) {
        // The ground is the one face with a bitmap. Canvas 2D has no
        // projective transform, so the quad is subdivided and each cell
        // drawn with the affine map from three of its corners — at 14×14
        // the residual error is under a pixel at any usable camera angle.
        if (it.fc.group === 'ground' && groundImg && it.fc.extent) {
          drawGround(it.fc, P);
          return;
        }
        var pr = it.pr, fc = it.fc;
        ctx.beginPath();
        ctx.moveTo(pr[0][0], pr[0][1]);
        for (var i = 1; i < pr.length; i++) ctx.lineTo(pr[i][0], pr[i][1]);
        ctx.closePath();
        ctx.fillStyle = shade(fc.color, it.l, it.up, sel === fc.group);
        ctx.globalAlpha = fc.alpha != null ? fc.alpha : 1;
        ctx.fill();
        ctx.globalAlpha = 1;
        // Outlining a 6 px truss web costs a full path stroke and reads as
        // noise. Only outline faces big enough for the edge to mean
        // something, and skip outlines entirely while the camera moves.
        if (fc.group !== 'ground' && !busy && it.big && !(isPhone && autoLod)) {
          ctx.strokeStyle = 'rgba(0,0,0,.28)';
          ctx.lineWidth = 0.55;
          ctx.stroke();
        }
        // Corrugation interpolated across the quad, so ribs follow the
        // surface in perspective instead of being straight overlay lines.
        if (fc.ribs > 0 && !busy && !autoLod && it.big && pr.length === 4) {
          ctx.strokeStyle = 'rgba(0,0,0,.17)';
          ctx.lineWidth = 0.5;
          for (var r2 = 1; r2 < fc.ribs; r2++) {
            var t = r2/fc.ribs;
            ctx.beginPath();
            ctx.moveTo(pr[0][0] + (pr[1][0]-pr[0][0])*t, pr[0][1] + (pr[1][1]-pr[0][1])*t);
            ctx.lineTo(pr[3][0] + (pr[2][0]-pr[3][0])*t, pr[3][1] + (pr[2][1]-pr[3][1])*t);
            ctx.stroke();
          }
        }
      });

      if (m.callouts !== false && !busy && !autoLod) drawCallouts(P, w, h);
      if (m.scaleRef && m.scaleRef !== 'none') drawScaleRef(P);
      if (m.dims !== false) drawDims(P);
      drawMarks(P, w, h);

      var t1 = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      frameMs = frameMs ? (frameMs * 0.7 + (t1 - t0) * 0.3) : (t1 - t0);
      if (frameMs > 28 && !autoNoShadow) { autoNoShadow = true; }
      else if (frameMs > 34 && !autoLod) {
        autoLod = true;
        if (!m.lod) { m.lod = true; geo = build(m); }
      } else if (frameMs < 12 && autoLod) {
        autoLod = false; autoNoShadow = false;
        if (m.lod) { m.lod = false; geo = build(m); }
      }
    }

    // Dimension tags live in the scene, so a rotated view still says which
    // number belongs to which direction.
    function drawDims(P) {
      var g = geo.meta, hs = g.span/2, hl = g.length/2;
      ctx.font = '700 12px Heebo,Arial,sans-serif';
      ctx.textAlign = 'center';
      function tag(p, txt) {
        var q = P(p);
        var tw = ctx.measureText(txt).width + 10;
        ctx.fillStyle = 'rgba(8,18,12,.82)';
        ctx.fillRect(q[0]-tw/2, q[1]-9, tw, 17);
        ctx.fillStyle = '#ffd166';
        ctx.fillText(txt, q[0], q[1]+4);
      }
      // Drawn last and de-collided: overlapping numbers are worse than
      // missing ones, because two half-covered figures read as a third.
      var placed = [];
      function tagIf(pt, txt) {
        var q = P(pt);
        var tw2 = ctx.measureText(txt).width + 10;
        var box = { x: q[0]-tw2/2, y: q[1]-9, w: tw2, h: 17 };
        for (var i = 0; i < placed.length; i++) {
          var o = placed[i];
          if (box.x < o.x+o.w && box.x+box.w > o.x && box.y < o.y+o.h && box.y+box.h > o.y) return;
        }
        for (var j = 0; j < calloutBoxes.length; j++) {
          var cb = calloutBoxes[j];
          if (box.x < cb.x+cb.w && box.x+box.w > cb.x && box.y < cb.y+cb.h && box.y+box.h > cb.y) return;
        }
        placed.push(box);
        ctx.fillStyle = 'rgba(8,18,12,.82)';
        ctx.fillRect(box.x, box.y, box.w, box.h);
        ctx.fillStyle = '#ffd166';
        ctx.fillText(txt, q[0], q[1]+4);
      }
      // A model that knows better says so. The shed's three tags are span,
      // length and eaves because that is what a shed is; a gate's are the
      // clear opening, its height and the horn, and reusing the shed's
      // three would print the same width twice and call one of them a span.
      if (g.tags && g.tags.length) {
        g.tags.forEach(function (t) { if (t && t.p && t.t) tagIf(t.p, String(t.t)); });
        return;
      }
      tagIf([0, -hs-1.6, 0], g.length.toFixed(1) + ' m');
      tagIf([-hl-1.6, 0, 0], g.span.toFixed(1) + ' m');
      tagIf([-hl-1.6, -hs, g.eaves/2], g.eaves.toFixed(1) + ' m');
      if (g.ridgeZ > g.eaves + 0.05) tagIf([0, 0, g.ridgeZ+1], g.ridgeZ.toFixed(1) + ' m');
    }

    // ── scale reference ────────────────────────────────────────────────
    // Drawn in screen space rather than as scene geometry, anchored to a
    // world point and sized by projecting its base and top. A chunky
    // low-poly tree standing next to the building read as clutter; a
    // graduated staff reads as a drawing convention and stays legible at
    // any zoom because the linework never gets tessellated.
    function drawScaleRef(P) {
      var g = geom_meta();
      var kind = m.scaleRef;
      var H = kind === 'person' ? 1.75 : (kind === 'staff' ? 5 : (m.scaleH || 9));
      // Off the front-left corner, clear of the building and its shadow.
      var ax = -g.length/2 - Math.max(2.5, g.span*0.12);
      var ay = -g.span/2 - Math.max(2.5, g.span*0.12);

      var base = P([ax, ay, 0]), top = P([ax, ay, H]);
      var px = base[0], py = base[1];
      var hpx = base[1] - top[1];                 // on-screen height of H metres
      if (!(hpx > 8)) return;
      var u = hpx / H;                            // px per metre at this spot

      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (kind === 'staff') drawStaff(px, py, u, H);
      else if (kind === 'person') drawPerson(px, py, u);
      else drawPalm(px, py, u, H);

      // Height dimension beside it: the number is the whole point.
      var dx = px + Math.max(16, u * 0.55);
      ctx.strokeStyle = 'rgba(20,28,22,.75)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(dx, py); ctx.lineTo(dx, py - hpx);
      ctx.moveTo(dx - 4, py); ctx.lineTo(dx + 4, py);
      ctx.moveTo(dx - 4, py - hpx); ctx.lineTo(dx + 4, py - hpx);
      ctx.stroke();
      // arrowheads
      [[py, 1], [py - hpx, -1]].forEach(function (a) {
        ctx.beginPath();
        ctx.moveTo(dx, a[0]);
        ctx.lineTo(dx - 3, a[0] - 6*a[1]);
        ctx.lineTo(dx + 3, a[0] - 6*a[1]);
        ctx.closePath();
        ctx.fillStyle = 'rgba(20,28,22,.75)';
        ctx.fill();
      });
      var lbl = H.toFixed(kind === 'person' ? 2 : 1) + ' m';
      ctx.font = '700 11px Heebo,Arial,sans-serif';
      ctx.textAlign = 'left';
      var tw = ctx.measureText(lbl).width + 8;
      ctx.fillStyle = 'rgba(8,18,12,.82)';
      ctx.fillRect(dx + 6, py - hpx/2 - 8, tw, 16);
      ctx.fillStyle = '#ffd166';
      ctx.fillText(lbl, dx + 10, py - hpx/2 + 4);
      ctx.restore();
    }

    function geom_meta() { return geo.meta; }

    // Survey staff: alternating half-metre bands, ticks every 0.5 m and a
    // number on every whole metre — the same object a surveyor holds, so it
    // needs no explaining.
    function drawStaff(px, py, u, H) {
      var w2 = Math.max(2.5, u * 0.09);
      for (var i = 0; i < H*2; i++) {
        var z0 = i/2, z1 = Math.min(H, (i+1)/2);
        ctx.fillStyle = (i % 2) ? '#f4f4ef' : '#c0392b';
        ctx.fillRect(px - w2, py - z1*u, w2*2, (z1 - z0)*u);
      }
      ctx.strokeStyle = 'rgba(20,28,22,.65)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px - w2, py - H*u, w2*2, H*u);
      if (u > 9) {
        ctx.font = '600 9px Heebo,Arial,sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(20,28,22,.85)';
        for (var mtr = 1; mtr <= H; mtr++) ctx.fillText(mtr, px - w2 - 3, py - mtr*u + 3);
      }
    }

    // A person at 1.75 m: the fastest scale cue there is, drawn as a plain
    // silhouette so it never competes with the structure for attention.
    function drawPerson(px, py, u) {
      var h = 1.75*u;
      ctx.fillStyle = 'rgba(40,52,44,.72)';
      ctx.beginPath();
      ctx.arc(px, py - h*0.90, h*0.075, 0, 6.29);        // head
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(px - h*0.085, py - h*0.82);              // torso
      ctx.lineTo(px + h*0.085, py - h*0.82);
      ctx.lineTo(px + h*0.075, py - h*0.45);
      ctx.lineTo(px + h*0.070, py);                       // legs
      ctx.lineTo(px + h*0.018, py);
      ctx.lineTo(px, py - h*0.42);
      ctx.lineTo(px - h*0.018, py);
      ctx.lineTo(px - h*0.070, py);
      ctx.lineTo(px - h*0.075, py - h*0.45);
      ctx.closePath();
      ctx.fill();
    }

    // A palm, but drawn as a restrained line silhouette with graduations up
    // the trunk rather than a solid green blob of boxes.
    function drawPalm(px, py, u, H) {
      var th = Math.max(1.6, u*0.055);
      var crown = py - H*u*0.86;
      // trunk, tapering, with the frond-scar rings a date palm actually has
      ctx.strokeStyle = 'rgba(92,74,52,.85)';
      ctx.lineWidth = th*2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + th*0.6, py - H*u*0.45, px, crown);
      ctx.stroke();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = 'rgba(60,48,34,.45)';
      for (var r = 1; r < H*1.6; r++) {
        var yy = py - (r/(H*1.6))*(py - crown);
        ctx.beginPath();
        ctx.moveTo(px - th, yy); ctx.lineTo(px + th, yy); ctx.stroke();
      }
      // crown: arching fronds, thin, with a few leaflet ticks
      var n = 11, len = H*u*0.20;
      ctx.strokeStyle = 'rgba(64,102,58,.85)';
      for (var f = 0; f < n; f++) {
        var a = -Math.PI + (f/(n-1))*Math.PI;
        var ex = px + Math.cos(a)*len*1.25;
        var ey = crown + Math.sin(a)*len*0.55 + len*0.35;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(px, crown);
        ctx.quadraticCurveTo(px + Math.cos(a)*len*0.75, crown + Math.sin(a)*len*0.30 - len*0.28, ex, ey);
        ctx.stroke();
      }
      // graduation ladder beside the trunk so the height is readable, not
      // just implied
      if (u > 7) {
        ctx.strokeStyle = 'rgba(20,28,22,.55)';
        ctx.lineWidth = 1;
        ctx.font = '600 9px Heebo,Arial,sans-serif';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(20,28,22,.8)';
        for (var mm = 1; mm <= H; mm++) {
          var y2 = py - mm*u;
          var wide = mm % 5 === 0;
          ctx.beginPath();
          ctx.moveTo(px - th - 2, y2);
          ctx.lineTo(px - th - (wide ? 9 : 5), y2);
          ctx.stroke();
          if (wide) ctx.fillText(mm, px - th - 11, y2 + 3);
        }
      }
    }

    // Thin leaders from a representative point on each member group out to
    // a chip naming it. This is what turns the model from a picture into a
    // drawing: the same information the reference section conveys with
    // annotation, on a view you can rotate.
    var calloutBoxes = [];

    function drawCallouts(P, w, h) {
      calloutBoxes = [];
      var labels = opts.labels || {};
      var groups = Object.keys(labels);
      if (!groups.length) return;

      // ONLY the selected member gets a callout. Seven chips stacked down
      // the gutter with leaders crossing the model told the user nothing
      // they could read — it hid the building it was annotating. Tapping a
      // member is the question; one chip is the answer.
      if (!sel || !labels[sel]) return;

      var anchor = null;
      geo.faces.forEach(function (fc) {
        if (fc.group !== sel || hidden[fc.group]) return;
        var c = [0,0,0];
        fc.pts.forEach(function (pp) { c[0]+=pp[0]; c[1]+=pp[1]; c[2]+=pp[2]; });
        c = [c[0]/fc.pts.length, c[1]/fc.pts.length, c[2]/fc.pts.length];
        if (!anchor || c[2] > anchor[2]) anchor = c;
      });
      if (!anchor) return;

      var a = P(anchor);
      if (a[0] < -100 || a[0] > w + 100) return;
      var lab = labels[sel];
      var title = lab.title.replace('\ud83d\udc46 ', '');
      var sub = lab.sub || '';

      ctx.font = '800 12px Heebo,Arial,sans-serif';
      var tw = ctx.measureText(title).width;
      ctx.font = '600 11px Heebo,Arial,sans-serif';
      var sw = sub ? ctx.measureText(sub).width : 0;
      var bw = Math.max(tw, sw) + 18, bh = sub ? 36 : 22;

      // Placed just above the member, nudged inside the frame. A short
      // leader that never crosses the building beats a long one from the
      // edge of the canvas.
      var bx = Math.min(Math.max(8, a[0] - bw/2), w - bw - 8);
      var by = Math.max(8, a[1] - bh - 22);

      ctx.strokeStyle = 'rgba(255,255,255,.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(bx + bw/2, by + bh);
      ctx.lineTo(a[0], a[1]);
      ctx.stroke();
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.arc(a[0], a[1], 3.2, 0, 6.29); ctx.fill();

      ctx.fillStyle = 'rgba(8,18,12,.92)';
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(bx, by, bw, bh, 8); else ctx.rect(bx, by, bw, bh);
      ctx.fill(); ctx.stroke();

      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd166';
      ctx.font = '800 12px Heebo,Arial,sans-serif';
      ctx.fillText(title, bx + bw/2, by + 15);
      if (sub) {
        ctx.fillStyle = 'rgba(233,238,233,.85)';
        ctx.font = '600 11px Heebo,Arial,sans-serif';
        ctx.fillText(sub, bx + bw/2, by + 30);
      }
      calloutBoxes.push({ g: sel, x: bx, y: by, w: bw, h: bh });
    }

    // A tap on a face → a point on that face in metres. Perspective-correct
    // barycentric interpolation over the two triangles of the projected
    // quad; faces are subdivided small, so this is exact enough for a tape.
    // Snaps to the nearest projected vertex within 14 px, so corner-to-
    // corner and edge measurements come out clean without aiming.
    function unproject(x, y) {
      var best = null, bd = 14;
      for (var i = lastPolys.length-1; i >= 0; i--) {
        var it = lastPolys[i];
        if (it.fc.group === 'ground') continue;
        for (var v = 0; v < it.pr.length; v++) {
          var dd = Math.hypot(it.pr[v][0]-x, it.pr[v][1]-y);
          if (dd < bd) { bd = dd; best = { p: it.fc.pts[v].slice(), g: it.fc.group, snap: true }; }
        }
      }
      if (best) return best;
      for (var j = lastPolys.length-1; j >= 0; j--) {
        var jt = lastPolys[j];
        if (!inPoly([x, y], jt.pr)) continue;
        var pr = jt.pr, pts = jt.fc.pts, tris = pr.length === 4 ? [[0,1,2],[0,2,3]] : [[0,1,2]];
        for (var t = 0; t < tris.length; t++) {
          var a = pr[tris[t][0]], b = pr[tris[t][1]], c = pr[tris[t][2]];
          var den = (b[1]-c[1])*(a[0]-c[0]) + (c[0]-b[0])*(a[1]-c[1]);
          if (Math.abs(den) < 1e-9) continue;
          var l0 = ((b[1]-c[1])*(x-c[0]) + (c[0]-b[0])*(y-c[1])) / den;
          var l1 = ((c[1]-a[1])*(x-c[0]) + (a[0]-c[0])*(y-c[1])) / den;
          var l2 = 1 - l0 - l1;
          if (l0 < -0.02 || l1 < -0.02 || l2 < -0.02) continue;
          var w0 = l0/a[2], w1 = l1/b[2], w2 = l2/c[2], ws = w0+w1+w2;
          var P0 = pts[tris[t][0]], P1 = pts[tris[t][1]], P2 = pts[tris[t][2]];
          return { p: [(P0[0]*w0+P1[0]*w1+P2[0]*w2)/ws, (P0[1]*w0+P1[1]*w1+P2[1]*w2)/ws,
                       (P0[2]*w0+P1[2]*w1+P2[2]*w2)/ws], g: jt.fc.group, snap: false };
        }
      }
      // nothing hit: the ground plane
      return null;
    }

    function fmtM(d) { return (Math.round(d*100)/100).toFixed(2) + ' m'; }

    function drawMarks(P, w, h) {
      var ms = marks.measures || [], ps = marks.pins || [];
      if (!ms.length && !ps.length && !pending) return;
      ctx.save();
      ctx.lineCap = 'round';
      ms.forEach(function (mk, i) {
        var a = P(mk.a), b = P(mk.b);
        var d = Math.hypot(mk.b[0]-mk.a[0], mk.b[1]-mk.a[1], mk.b[2]-mk.a[2]);
        ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
        [a, b].forEach(function (q) {
          ctx.fillStyle = '#ff5c8a'; ctx.beginPath(); ctx.arc(q[0], q[1], 3.5, 0, 6.29); ctx.fill();
        });
        var mx = (a[0]+b[0])/2, my = (a[1]+b[1])/2;
        var txt = fmtM(d) + (mk.text ? ' \u00b7 ' + mk.text : '');
        ctx.font = '800 12px Heebo,Arial,sans-serif';
        var tw = ctx.measureText(txt).width + 12;
        ctx.fillStyle = 'rgba(8,18,12,.9)'; ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.rect(mx - tw/2, my - 20, tw, 18); ctx.fill(); ctx.stroke();
        ctx.fillStyle = '#ffd6e2'; ctx.textAlign = 'center'; ctx.fillText(txt, mx, my - 7);
        calloutBoxes.push({ g: 'measure:' + i, x: mx - tw/2, y: my - 20, w: tw, h: 18 });
      });
      ps.forEach(function (pn, i) {
        var q = P(pn.p);
        ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(q[0], q[1]); ctx.lineTo(q[0], q[1]-22); ctx.stroke();
        ctx.fillStyle = '#4cc9f0'; ctx.beginPath(); ctx.arc(q[0], q[1]-26, 6, 0, 6.29); ctx.fill();
        ctx.fillStyle = '#08120c'; ctx.font = '800 9px Heebo,Arial,sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(String(i+1), q[0], q[1]-23);
        if (pn.text) {
          ctx.font = '600 11px Heebo,Arial,sans-serif';
          var tw2 = ctx.measureText(pn.text).width + 12;
          ctx.fillStyle = 'rgba(8,18,12,.9)'; ctx.strokeStyle = '#4cc9f0'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.rect(q[0] + 10, q[1]-42, tw2, 18); ctx.fill(); ctx.stroke();
          ctx.fillStyle = '#d6f3fb'; ctx.textAlign = 'left'; ctx.fillText(pn.text, q[0] + 16, q[1]-29);
          calloutBoxes.push({ g: 'pin:' + i, x: q[0] + 10, y: q[1]-42, w: tw2, h: 18 });
        } else {
          calloutBoxes.push({ g: 'pin:' + i, x: q[0]-8, y: q[1]-34, w: 16, h: 16 });
        }
      });
      if (pending) {
        var pq = P(pending.p);
        ctx.strokeStyle = '#ff5c8a'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(pq[0], pq[1], 6, 0, 6.29); ctx.stroke();
      }
      ctx.restore();
    }

    function inPoly(pt, poly) {
      var ins = false;
      for (var i = 0, j = poly.length-1; i < poly.length; j = i++) {
        var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
        if (((yi > pt[1]) !== (yj > pt[1])) &&
            (pt[0] < (xj-xi)*(pt[1]-yi)/(yj-yi) + xi)) ins = !ins;
      }
      return ins;
    }

    function pick(x, y) {
      for (var c = 0; c < calloutBoxes.length; c++) {
        var b = calloutBoxes[c];
        if (x >= b.x && x <= b.x+b.w && y >= b.y && y <= b.y+b.h) return b.g;
      }
      for (var i = lastPolys.length-1; i >= 0; i--) {
        var g = lastPolys[i].fc.group;
        if (g === 'ground') continue;   // the site is not a selectable member
        if (inPoly([x, y], lastPolys[i].pr)) return g;
      }
      return null;
    }

    // Moving a free element: with it selected, dragging on it slides it
    // across the ground plane at its own height. Screen pixels become
    // metres through the projector's scale at that depth, rotated back by
    // the camera yaw — good enough for placing a wall, not a CAD gizmo.
    var grab = null;
    function metresPerPx(pt) {
      var d0 = size(), Pq = projector(d0.w, d0.h), q = Pq(pt);
      var f = Math.min(d0.w, d0.h) * 0.92;
      return q[2] / f;
    }
    cv.addEventListener('pointerdown', function (e) {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY };
      moved = 0;
      pan = (e.button === 2) || e.shiftKey;
      grab = null;
      if (tool === 'orbit' && sel && /^free:/.test(sel) && !pan) {
        var r0 = cv.getBoundingClientRect();
        var hitG = pick(e.clientX - r0.left, e.clientY - r0.top);
        if (hitG === sel) {
          var fid = sel.slice(5), fe = (m.free || []).filter(function (f) { return String(f.id) === fid; })[0];
          if (fe) grab = { f: fe, mpp: metresPerPx([fe.x, fe.y, fe.z]), sx: fe.x, sy: fe.y };
        }
      }
      cv.style.cursor = pan ? 'move' : grab ? 'move' : 'grabbing';
    });
    cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    cv.addEventListener('pointermove', function (e) {
      if (!drag) return;
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      moved += Math.abs(dx) + Math.abs(dy);
      busy = true;
      if (grab) {
        // screen right = +rx, screen up = −ry·sin(pitch)... on the ground
        // plane, screen-up moves the point away from the camera
        var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), sp = Math.sin(cam.pitch) || 0.2;
        var rx = dx * grab.mpp, ry = -dy * grab.mpp / sp;
        grab.f.x += rx*cy + ry*sy;
        grab.f.y += -rx*sy + ry*cy;
        geo = build(m); drag = { x: e.clientX, y: e.clientY }; draw();
        return;
      }
      if (pan) { cam.px += dx; cam.py += dy; }
      else {
        cam.yaw += dx*0.008;
        cam.pitch = Math.max(-0.05, Math.min(1.45, cam.pitch + dy*0.006));
      }
      drag = { x: e.clientX, y: e.clientY };
      draw();
    });
    cv.addEventListener('pointerup', function (e) {
      cv.style.cursor = 'grab';
      var wasDrag = moved > 6, wasPan = pan;
      drag = null; pan = false; busy = false;
      if (grab) {
        var gf = grab; grab = null;
        if (wasDrag) {
          // snap to 5 cm so typed and dragged positions agree
          gf.f.x = Math.round(gf.f.x * 20) / 20; gf.f.y = Math.round(gf.f.y * 20) / 20;
          geo = build(m); draw();
          if (opts.onMove) opts.onMove(gf.f.id, gf.f.x, gf.f.y);
          return;
        }
      }
      if (wasDrag || wasPan) { draw(); return; }   // repaint at full quality
      var r = cv.getBoundingClientRect();
      var cx2 = e.clientX - r.left, cy2 = e.clientY - r.top;
      if (tool !== 'orbit') {
        // a tap on an existing mark's chip selects it (for deletion)
        var hitMark = pick(cx2, cy2);
        if (hitMark && /^(measure|pin):/.test(hitMark)) {
          if (opts.onMark) opts.onMark(hitMark);
          return;
        }
        var hit = unproject(cx2, cy2);
        if (!hit) return;
        if (tool === 'pin') {
          if (opts.onPoint) opts.onPoint({ kind: 'pin', p: hit.p, group: hit.g });
          return;
        }
        if (!pending) { pending = hit; draw(); return; }
        var done = { kind: 'measure', a: pending.p, b: hit.p, group: hit.g };
        pending = null; draw();
        if (opts.onPoint) opts.onPoint(done);
        return;
      }
      var g = pick(cx2, cy2);
      if (g && /^(measure|pin):/.test(g)) { if (opts.onMark) opts.onMark(g); return; }
      sel = (g === sel) ? null : g;
      draw();
      if (opts.onSelect) opts.onSelect(sel);
    });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      cam.zoom = Math.max(0.3, Math.min(5, cam.zoom*(e.deltaY > 0 ? 0.9 : 1.1)));
      busy = true; draw();
      if (wheelIdle) clearTimeout(wheelIdle);
      wheelIdle = setTimeout(function () { busy = false; draw(); }, 160);
    }, { passive: false });

    var ro = null;
    if (window.ResizeObserver) { ro = new ResizeObserver(draw); ro.observe(host); }
    window.addEventListener('resize', draw);
    draw();

    return {
      update: function (nm) { m = nm; geo = build(m); draw(); },
      setTool: function (t) { tool = (t === 'measure' || t === 'pin') ? t : 'orbit'; pending = null;
                              cv.style.cursor = tool === 'orbit' ? 'grab' : 'crosshair'; draw(); },
      getTool: function () { return tool; },
      setMarks: function (mk) { marks = mk || { measures: [], pins: [] }; pending = null; draw(); },
      setView: function (y, p) { cam.yaw = y; cam.pitch = p; cam.px = 0; cam.py = 0; draw(); },
      setSun: function (az, el) { sunAz = az; sunEl = el; draw(); },
      setGround: function (img, extent) { groundImg = img; groundExtent = extent || null; draw(); },
      setHidden: function (map2) { hidden = map2 || {}; draw(); },
      toggleLayer: function (g) { hidden[g] = !hidden[g]; draw(); return !!hidden[g]; },
      isHidden: function (g) { return !!hidden[g]; },
      groups: function () {
        var seen = {};
        geo.faces.forEach(function (f) { if (f.group !== 'ground') seen[f.group] = (seen[f.group]||0)+1; });
        return seen;
      },
      // Rebuild geometry then repaint on the next frame — used by sliders.
      nudge: function (nm) { m = nm; geo = build(m); schedule(); },
      resetView: function () { cam = { yaw:-0.68, pitch:0.34, zoom:1, px:0, py:0 }; draw(); },
      select: function (g) { sel = g; draw(); },
      meta: function () { return geo.meta; },
      perf: function () { return { ms: Math.round(frameMs), faces: geo.faces.length,
                                   lod: autoLod, shadows: !autoNoShadow, phone: isPhone }; },
      // Everything a remount needs to look like nothing happened.
      getState: function () {
        return { cam: { yaw: cam.yaw, pitch: cam.pitch, zoom: cam.zoom, px: cam.px, py: cam.py },
                 hidden: hidden, sel: sel, sunAz: sunAz, sunEl: sunEl,
                 groundImg: groundImg, groundExtent: groundExtent, marks: marks };
      },
      snapshot: function () { return cv.toDataURL('image/png'); },
      redraw: draw,
      destroy: function () {
        if (ro) ro.disconnect();
        window.removeEventListener('resize', draw);
        host.innerHTML = '';
      }
    };
  }

  // Exported so another module can describe a structure this file has no
  // business knowing about — a gate, a fence, a water tank — in the same
  // face format, without re-deriving swept sections and quad splitting.
  var prim = { box: box, bar: bar, quad: quad, strut: strut, lerp: lerp,
               boxSeg: boxSeg, barSeg: barSeg, quadSeg: quadSeg,
               strutSeg: strutSeg, setSeg: setSeg };

  return { mount: mount, build: build, PALETTE: PALETTE, prim: prim };
})();
