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
      post: String(g.post || 'RHS 100x100x4'),
      mesh: String(g.mesh || 'רשת מרותכת 50/200'),
      postDepth: Number(g.postDepth) || 1.0,   // embedment, m
      postSize: Number(g.postSize) || 0.4,     // concrete cube side, m
      bracing: g.bracing === false ? false : true,
      motor: !!g.motor,
      infillRows: Number(g.infillRows) || 1,   // horizontal rails between top and bottom
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
    var W = 640, H = 340, pad = 54;
    var totalW = g.width + (s.tail || 0) + 1.2;
    var totalH = g.height + g.postDepth + 0.6;
    var sc = Math.min((W - pad*2) / totalW, (H - pad*2) / totalH);
    var x0 = (W - g.width*sc) / 2, gy = H - pad - g.postDepth*sc;   // ground line

    function X(m) { return x0 + m*sc; }
    function Y(m) { return gy - m*sc; }

    var o = [];
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
      o.push('<rect x="' + (X(px) - fw/2) + '" y="' + gy + '" width="' + fw +
        '" height="' + (g.postDepth*sc) + '" fill="' + col.conc + '" opacity=".55"/>');
      o.push('<rect x="' + (X(px) - 5) + '" y="' + Y(g.height + 0.25) + '" width="10" height="' +
        ((g.height + 0.25)*sc) + '" fill="' + col.steel + '"/>');
    });

    // leaves
    function leaf(lx, lw) {
      var t = 4;
      o.push('<rect x="' + X(lx) + '" y="' + Y(g.height) + '" width="' + (lw*sc) +
        '" height="' + (g.height*sc) + '" fill="none" stroke="' + col.steel +
        '" stroke-width="' + t + '"/>');
      // mesh
      var cells = Math.max(4, Math.round(lw / 0.2));
      for (var i = 1; i < cells; i++) {
        var mx = X(lx + lw*i/cells);
        o.push('<line x1="' + mx + '" y1="' + Y(g.height) + '" x2="' + mx + '" y2="' + gy +
          '" stroke="' + col.mesh + '" stroke-width="0.7"/>');
      }
      var rows = Math.max(3, Math.round(g.height / 0.2));
      for (var j = 1; j < rows; j++) {
        var my = Y(g.height*j/rows);
        o.push('<line x1="' + X(lx) + '" y1="' + my + '" x2="' + X(lx+lw) + '" y2="' + my +
          '" stroke="' + col.mesh + '" stroke-width="0.7"/>');
      }
      // intermediate rails
      for (var r = 1; r <= g.infillRows; r++) {
        var ry = Y(g.height*r/(g.infillRows+1));
        o.push('<line x1="' + X(lx) + '" y1="' + ry + '" x2="' + X(lx+lw) + '" y2="' + ry +
          '" stroke="' + col.steel + '" stroke-width="2.5"/>');
      }
      if (g.bracing) {
        o.push('<line x1="' + X(lx) + '" y1="' + gy + '" x2="' + X(lx+lw) + '" y2="' + Y(g.height) +
          '" stroke="' + col.steel + '" stroke-width="2.5"/>');
      }
    }

    if (g.type === 'swing2') { leaf(0, g.width/2); leaf(g.width/2, g.width/2); }
    else if (g.type === 'cantil') { leaf(0, g.width); 
      // counterweight tail, drawn lighter — it is structure, not opening
      o.push('<rect x="' + X(g.width) + '" y="' + Y(g.height) + '" width="' + (s.tail*sc) +
        '" height="' + (g.height*sc) + '" fill="none" stroke="' + col.steel +
        '" stroke-width="2.5" stroke-dasharray="6,4"/>');
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

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">' +
      o.join('') + '</svg>';
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
           takeoff: takeoff, summary: summary, svg: svg, stages: stages };
})();
