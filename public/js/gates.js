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
      notes: String(g.notes || '')
    };
  }

  // ── quantities ──
  // Everything returns metres of frame, m² of mesh, m³ of concrete and a
  // count of fittings, in the shape buildplan's takeoff expects.
  function takeoff(g) {
    g = norm(g);
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
    return {
      leaves: leaves, leafW: leafW, tail: tail,
      area: (leafW + tail) * g.height * leaves,
      swingRadius: (g.type === 'swing1' || g.type === 'swing2') ? leafW : 0,
      railRun: (g.type === 'slide') ? g.width * 2 : 0
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
    var totalW = g.width + (s.tail || 0) + 1.2;
    var totalH = g.height + g.postDepth + 0.6;
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
      o.push(part('found',
        '<rect x="' + (X(px) - fw/2) + '" y="' + gy + '" width="' + fw +
          '" height="' + (g.postDepth*sc) + '" fill="' + col.conc + '" opacity=".55" class="gp-f"/>',
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

    // dimensions
    function dim(xa, xb, y, label) {
      return '<line x1="' + xa + '" y1="' + y + '" x2="' + xb + '" y2="' + y +
        '" stroke="' + col.dim + '" stroke-width="1"/>' +
        '<text x="' + ((xa+xb)/2) + '" y="' + (y-5) + '" fill="' + col.dim +
        '" font-size="12" font-weight="800" text-anchor="middle">' + label + '</text>';
    }
    o.push(dim(X(0), X(g.width), gy + 28, n1(g.width) + ' m ' + tt('אור', 'ช่องเปิด', 'فتحة')));
    o.push('<line x1="' + (X(0)-26) + '" y1="' + Y(g.height) + '" x2="' + (X(0)-26) + '" y2="' + gy +
      '" stroke="' + col.dim + '" stroke-width="1"/>');
    o.push('<text x="' + (X(0)-30) + '" y="' + Y(g.height/2) + '" fill="' + col.dim +
      '" font-size="12" font-weight="800" text-anchor="end">' + n1(g.height) + ' m</text>');
    o.push('<text x="' + X(g.width/2) + '" y="' + (gy + g.postDepth*sc + 16) + '" fill="' + col.conc +
      '" font-size="11" font-weight="700" text-anchor="middle">' +
      tt('יסוד', 'ฐาน', 'أساس') + ' ' + n1(g.postSize) + '\u00d7' + n1(g.postSize) +
      '\u00d7' + n1(g.postDepth) + ' m</text>');

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

  return { TYPES: TYPES, typeLabel: typeLabel, norm: norm,
           takeoff: takeoff, summary: summary, svg: svg, stages: stages,
           // part identification on the drawing
           partLabel: partLabel, partsOf: partsOf, bindPicker: bindPicker };
})();
