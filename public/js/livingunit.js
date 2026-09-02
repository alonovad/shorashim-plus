/* livingunit.js — מתחם מגורים בבנייה קלה (accommodation planner)
 * ------------------------------------------------------------------
 * Worker accommodation, sized from the headcount rather than drawn room by
 * room. Give it 20 people and it produces the partitions, doors, sanitary
 * fittings, kitchen run and interior finishes that a compound for 20 needs.
 *
 * TWO MODES, because they are completely different jobs:
 *
 *   fitout  — the shell already exists. Only partitions, doors, sanitary,
 *             kitchen, electrical and finishes. No envelope, no roof, no
 *             foundation.
 *   full    — nothing exists. Everything above PLUS the envelope: light
 *             steel frame, איסכורית or panel skin, partial block walls in
 *             the wet rooms, and a floor slab.
 *
 * Quoting a fit-out with an envelope in it is the single most expensive
 * mistake available here, so the mode is the first control and it gates
 * whole sections of the takeoff rather than adjusting numbers.
 *
 * SIZING RULES are the ones the trade actually uses, stated openly so they
 * can be argued with:
 *   4 m² sleeping area per person, 4 people to a room
 *   1 toilet and 1 shower per 8 people, minimum 1 each
 *   1 washbasin per 6 people
 *   0.5 m of kitchen worktop per person, 2.4 m minimum
 *   1.2 m² of dining space per person
 * Every one of them is editable — they are conventions, not law, and the
 * Ministry of Labour requirement for a given site may be stricter.
 */
var LivingUnit = (function () {
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

  function norm(u) {
    u = u || {};
    return {
      mode: (u.mode === 'full') ? 'full' : 'fitout',
      people: Math.max(1, Number(u.people) || 20),
      perPerson: Number(u.perPerson) || 4,      // m² sleeping
      perRoom: Math.max(1, Number(u.perRoom) || 4),
      wcPer: Math.max(1, Number(u.wcPer) || 8),
      showerPer: Math.max(1, Number(u.showerPer) || 8),
      basinPer: Math.max(1, Number(u.basinPer) || 6),
      counterPer: Number(u.counterPer) || 0.5,  // m of worktop
      diningPer: Number(u.diningPer) || 1.2,    // m² dining
      height: Number(u.height) || 2.6,          // clear internal height
      partition: String(u.partition || 'פאנל קלקר 5 ס"מ'),
      blockWet: u.blockWet === false ? false : true,   // block walls in wet rooms
      envelope: String(u.envelope || 'איסכורית 0.5 מ"מ'),
      slabTh: Number(u.slabTh) || 0.12,
      ac: u.ac === false ? false : true,
      notes: String(u.notes || '')
    };
  }

  // ── programme ──
  // Rooms and fittings implied by the headcount.
  function program(u) {
    u = norm(u);
    var rooms = Math.ceil(u.people / u.perRoom);
    var sleepArea = u.people * u.perPerson;
    var wc = Math.max(1, Math.ceil(u.people / u.wcPer));
    var showers = Math.max(1, Math.ceil(u.people / u.showerPer));
    var basins = Math.max(1, Math.ceil(u.people / u.basinPer));
    var counter = Math.max(2.4, u.people * u.counterPer);
    var dining = u.people * u.diningPer;
    // Wet rooms are sized from the fittings they hold, not guessed.
    var wetArea = wc * 1.6 + showers * 1.6 + basins * 0.8;
    var kitchen = Math.max(6, counter * 1.8);
    var circulation = (sleepArea + wetArea + kitchen + dining) * 0.15;
    var total = sleepArea + wetArea + kitchen + dining + circulation;
    return {
      rooms: rooms, sleepArea: sleepArea, wc: wc, showers: showers, basins: basins,
      counter: counter, dining: dining, wetArea: wetArea, kitchen: kitchen,
      circulation: circulation, total: total,
      // A practical rectangle for the whole compound.
      width: Math.max(6, Math.sqrt(total / 1.6)),
      length: Math.max(6, Math.sqrt(total / 1.6) * 1.6)
    };
  }

  // ── quantities ──
  function takeoff(u) {
    u = norm(u);
    var pr = program(u);
    var out = [];
    function push(name, qty, unit, note) {
      if (!(qty > 0)) return;
      out.push({ name: name, qty: qty, unit: unit, note: note || '' });
    }

    // Partition length: room dividers plus wet-room and kitchen walls. A
    // grid of `rooms` cells across the compound needs roughly this much.
    var partLen = (pr.rooms + 1) * pr.width * 0.55 + pr.length * 0.4;
    var wetWall = (pr.wc + pr.showers) * 3.2;

    if (u.blockWet) {
      push('בלוק בטון 20 ס"מ', wetWall * u.height, 'מ"ר',
        tt('קירות רטובים', 'ผนังเปียก', 'جدران رطبة'));
      push('טיח פנים', wetWall * u.height * 2, 'מ"ר', tt('שני צדדים', 'สองด้าน', 'وجهان'));
      push('חיפוי קרמיקה', wetWall * u.height * 1.05, 'מ"ר',
        tt('חדרים רטובים, כולל פחת', 'ห้องน้ำ', 'الحمامات'));
    } else {
      push(u.partition, wetWall * u.height, 'מ"ר', tt('קירות רטובים', 'ผนังเปียก', 'جدران رطبة'));
    }
    push(u.partition, partLen * u.height, 'מ"ר',
      pr.rooms + ' ' + tt('חדרים', 'ห้อง', 'غرف'));
    push('פרופיל U לפאנל', (partLen + wetWall) * 2, "מ'",
      tt('מסילות עליונה ותחתונה', 'รางบนล่าง', 'مجاري علوية وسفلية'));

    // openings
    push('דלת פנים', pr.rooms + pr.wc + pr.showers + 1, "יח'",
      tt('חדרים, שירותים, מקלחות, כניסה', 'ประตูภายใน', 'أبواب داخلية'));
    push('חלון אלומיניום', pr.rooms + 2, "יח'",
      tt('חדר + מטבח + חלל משותף', 'หน้าต่าง', 'نوافذ'));

    // sanitary
    push('אסלה כולל מיכל', pr.wc, "יח'", '');
    push('מקלחון / אגן מקלחת', pr.showers, "יח'", '');
    push('כיור רחצה', pr.basins, "יח'", '');
    push('דוד שמש 150 ליטר', Math.max(1, Math.ceil(u.people / 10)), "יח'",
      tt('לפי צריכת מים חמים', 'ตามการใช้น้ำร้อน', 'حسب استهلاك الماء الساخن'));
    push('צנרת מים קרים/חמים', (pr.wc + pr.showers + pr.basins) * 9, "מ'", '');
    push('צנרת דלוחין וביוב', (pr.wc + pr.showers + pr.basins) * 7, "מ'", '');

    // kitchen
    push('ארון מטבח תחתון', pr.counter, "מ'", '');
    push('משטח עבודה', pr.counter, "מ'", '');
    push('כיור מטבח', Math.max(1, Math.ceil(u.people / 12)), "יח'", '');

    // electrical
    push('נקודת חשמל', pr.rooms * 4 + pr.wc + pr.showers + 8, "יח'",
      tt('שקעים, מאור, מטבח', 'จุดไฟฟ้า', 'نقاط كهرباء'));
    push('לוח חשמל', 1, "יח'", '');
    if (u.ac) {
      push('מזגן עילי 1.5 כ"ס', pr.rooms + 1, "יח'",
        tt('חדר + חלל משותף', 'ห้อง + ส่วนกลาง', 'غرفة + مشترك'));
    }

    // finishes
    push('ריצוף גרניט פורצלן', pr.total * 1.07, 'מ"ר', tt('כולל פחת', 'รวมเผื่อ', 'شامل الهدر'));
    push('צבע פנים', (partLen + wetWall) * u.height * 2, 'מ"ר', '');

    // envelope — only when there is nothing to fit out into
    if (u.mode === 'full') {
      push('בטון ב-30', pr.total * u.slabTh, 'מ"ק', tt('רצפה', 'พื้น', 'أرضية'));
      push('רשת פלדה Q188', Math.ceil(pr.total / (6 * 2.35) * 1.1), "יח'", tt('רצפה', 'พื้น', 'أرضية'));
      push(u.envelope, (2 * (pr.width + pr.length) * u.height) * 1.08, 'מ"ר',
        tt('מעטפת חיצונית', 'เปลือกอาคาร', 'الغلاف الخارجي'));
      push(u.envelope, pr.total * 1.1, 'מ"ר', tt('גג', 'หลังคา', 'سقف'));
      push('HEA 160', Math.ceil(pr.length / 4 + 1) * 2 * (u.height + 0.6), "מ'",
        tt('עמודי מעטפת', 'เสาโครง', 'أعمدة الهيكل'));
      push('Z 200x2.0', Math.ceil(pr.width / 1.5) * pr.length, "מ'",
        tt('מרישי גג', 'แปหลังคา', 'مرايش السقف'));
      push('מרזב', 2 * pr.length, "מ'", '');
    }

    return out;
  }

  // ── plan drawing ──
  // A schematic layout, not a construction drawing: sleeping rooms along
  // one side, wet block and kitchen along the other, dining in the middle.
  // Enough to agree the arrangement before anyone draws it properly.
  function svg(u, opt) {
    u = norm(u);
    opt = opt || {};
    var print = !!opt.print;
    var pr = program(u);
    var col = {
      wall: print ? '#37474f' : 'var(--text,#cfd8dc)',
      room: print ? '#eceff1' : 'rgba(255,255,255,.06)',
      wet:  print ? '#b3e5fc' : 'rgba(79,195,247,.22)',
      kit:  print ? '#ffe0b2' : 'rgba(255,159,67,.22)',
      din:  print ? '#c8e6c9' : 'rgba(46,204,113,.18)',
      txt:  print ? '#263238' : 'var(--text,#dde5dd)',
      dim:  print ? '#b34700' : 'var(--accent,#ff9f43)'
    };
    var W = 660, H = 380, pad = 46;
    var sc = Math.min((W - pad*2) / pr.length, (H - pad*2) / pr.width);
    var x0 = (W - pr.length*sc)/2, y0 = (H - pr.width*sc)/2;
    function X(m) { return x0 + m*sc; }
    function Y(m) { return y0 + m*sc; }

    var o = [];
    o.push('<rect x="' + x0 + '" y="' + y0 + '" width="' + (pr.length*sc) + '" height="' +
      (pr.width*sc) + '" fill="' + col.room + '" stroke="' + col.wall + '" stroke-width="3"/>');

    // sleeping rooms along the top
    var roomDepth = pr.width * 0.42;
    var roomW = pr.length / pr.rooms;
    for (var i = 0; i < pr.rooms; i++) {
      o.push('<rect x="' + X(i*roomW) + '" y="' + Y(0) + '" width="' + (roomW*sc) +
        '" height="' + (roomDepth*sc) + '" fill="none" stroke="' + col.wall + '" stroke-width="1.6"/>');
      if (roomW*sc > 42) {
        o.push('<text x="' + X(i*roomW + roomW/2) + '" y="' + Y(roomDepth/2) +
          '" fill="' + col.txt + '" font-size="11" font-weight="700" text-anchor="middle">' +
          tt('חדר', 'ห้อง', 'غرفة') + ' ' + (i+1) + '</text>');
        o.push('<text x="' + X(i*roomW + roomW/2) + '" y="' + (Y(roomDepth/2)+13) +
          '" fill="' + col.txt + '" font-size="9" text-anchor="middle" opacity=".75">' +
          u.perRoom + ' ' + tt('מיטות', 'เตียง', 'أسرّة') + '</text>');
      }
      // door swing
      o.push('<path d="M ' + X(i*roomW + roomW*0.2) + ' ' + Y(roomDepth) + ' a ' + (0.8*sc) +
        ' ' + (0.8*sc) + ' 0 0 1 ' + (0.8*sc) + ' ' + (-0.8*sc) +
        '" fill="none" stroke="' + col.wall + '" stroke-width="0.9" opacity=".7"/>');
    }

    // wet block bottom-left, kitchen bottom-right, dining between
    var botY = roomDepth, botH = pr.width - roomDepth;
    var wetW = Math.max(2.4, pr.wetArea / botH);
    var kitW = Math.max(2.4, pr.kitchen / botH);
    o.push('<rect x="' + X(0) + '" y="' + Y(botY) + '" width="' + (wetW*sc) + '" height="' +
      (botH*sc) + '" fill="' + col.wet + '" stroke="' + col.wall + '" stroke-width="1.6"/>');
    o.push('<text x="' + X(wetW/2) + '" y="' + Y(botY + botH/2) + '" fill="' + col.txt +
      '" font-size="11" font-weight="700" text-anchor="middle">' +
      tt('שירותים ומקלחות', 'ห้องน้ำ', 'حمامات') + '</text>');
    o.push('<text x="' + X(wetW/2) + '" y="' + (Y(botY + botH/2)+13) + '" fill="' + col.txt +
      '" font-size="9" text-anchor="middle" opacity=".75">' + pr.wc + ' WC \u00b7 ' +
      pr.showers + ' ' + tt('מקלחות', 'ฝักบัว', 'دُش') + ' \u00b7 ' + pr.basins + ' ' +
      tt('כיורים', 'อ่าง', 'أحواض') + '</text>');

    o.push('<rect x="' + X(pr.length - kitW) + '" y="' + Y(botY) + '" width="' + (kitW*sc) +
      '" height="' + (botH*sc) + '" fill="' + col.kit + '" stroke="' + col.wall + '" stroke-width="1.6"/>');
    o.push('<text x="' + X(pr.length - kitW/2) + '" y="' + Y(botY + botH/2) + '" fill="' + col.txt +
      '" font-size="11" font-weight="700" text-anchor="middle">' + tt('מטבח', 'ครัว', 'مطبخ') + '</text>');
    o.push('<text x="' + X(pr.length - kitW/2) + '" y="' + (Y(botY + botH/2)+13) + '" fill="' + col.txt +
      '" font-size="9" text-anchor="middle" opacity=".75">' + n1(pr.counter) + ' ' +
      tt('מ\' משטח', 'ม.เคาน์เตอร์', 'م سطح') + '</text>');

    var dinX = wetW, dinW = pr.length - wetW - kitW;
    if (dinW > 1) {
      o.push('<rect x="' + X(dinX) + '" y="' + Y(botY) + '" width="' + (dinW*sc) + '" height="' +
        (botH*sc) + '" fill="' + col.din + '" stroke="' + col.wall + '" stroke-width="1.6"/>');
      o.push('<text x="' + X(dinX + dinW/2) + '" y="' + Y(botY + botH/2) + '" fill="' + col.txt +
        '" font-size="11" font-weight="700" text-anchor="middle">' +
        tt('חלל אוכל ומשותף', 'พื้นที่ส่วนกลาง', 'صالة مشتركة') + '</text>');
      o.push('<text x="' + X(dinX + dinW/2) + '" y="' + (Y(botY + botH/2)+13) + '" fill="' + col.txt +
        '" font-size="9" text-anchor="middle" opacity=".75">' + n1(pr.dining) + ' \u05de"\u05e8</text>');
    }

    // dimensions
    o.push('<line x1="' + X(0) + '" y1="' + (Y(pr.width)+22) + '" x2="' + X(pr.length) +
      '" y2="' + (Y(pr.width)+22) + '" stroke="' + col.dim + '" stroke-width="1"/>');
    o.push('<text x="' + X(pr.length/2) + '" y="' + (Y(pr.width)+17) + '" fill="' + col.dim +
      '" font-size="12" font-weight="800" text-anchor="middle">' + n1(pr.length) + ' m</text>');
    o.push('<text x="' + (X(0)-10) + '" y="' + Y(pr.width/2) + '" fill="' + col.dim +
      '" font-size="12" font-weight="800" text-anchor="end">' + n1(pr.width) + ' m</text>');
    o.push('<text x="' + X(pr.length/2) + '" y="' + (y0-14) + '" fill="' + col.txt +
      '" font-size="12" font-weight="800" text-anchor="middle">' +
      u.people + ' ' + tt('אנשים', 'คน', 'أشخاص') + ' \u00b7 ' + n1(pr.total) + ' \u05de"\u05e8 \u00b7 ' +
      (u.mode === 'full' ? tt('מבנה חדש', 'อาคารใหม่', 'مبنى جديد')
                         : tt('התאמת מבנה קיים', 'ปรับปรุงอาคารเดิม', 'تجهيز مبنى قائم')) + '</text>');

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:auto;">' + o.join('') + '</svg>';
  }

  function stages(u) {
    u = norm(u);
    var pr = program(u);
    var st = [];
    if (u.mode === 'full') {
      st.push([tt('הכנת השטח והיסוד', 'เตรียมพื้นที่', 'تحضير الموقع'),
        tt('פילוס, מצע מהודק, יריעת פוליאתילן, יציקת רצפה ' + u.slabTh +
           ' מ\' עם רשת. להשאיר שרוולים לביוב ולמים לפני היציקה — קידוח בדיעבד בריצפה יצוקה הוא נזק.',
           'ปรับพื้นและเทพื้น', 'تسوية وصب الأرضية')]);
      st.push([tt('הקמת שלד ומעטפת', 'ติดตั้งโครงและเปลือก', 'إقامة الهيكل والغلاف'),
        tt('עמודים, מרישים, חיפוי ' + u.envelope + ', גג ומרזבים. איטום מלא לפני עבודות פנים.',
           'โครงและหลังคา', 'الهيكل والسقف')]);
    } else {
      st.push([tt('בדיקת המבנה הקיים', 'ตรวจอาคารเดิม', 'فحص المبنى القائم'),
        tt('לוודא גובה פנים ' + n1(u.height) + ' מ\' לפחות, מצב רצפה, אטימות גג, ונקודת חיבור לחשמל ולמים. ' +
           'שטח נדרש: ' + n1(pr.total) + ' מ"ר.',
           'ตรวจความสูงและพื้น', 'فحص الارتفاع والأرضية')]);
    }
    st.push([tt('תשתיות רטובות', 'งานระบบน้ำ', 'أعمال السباكة'),
      tt('ביוב ודלוחין בשיפוע, מים קרים וחמים, נקודות ל-' + pr.wc + ' אסלות, ' +
         pr.showers + ' מקלחות ו-' + pr.basins + ' כיורים. בדיקת לחץ לפני סגירת קירות.',
         'ทดสอบแรงดันก่อนปิดผนัง', 'اختبار الضغط قبل الإغلاق')]);
    st.push([tt('תשתית חשמל', 'งานไฟฟ้า', 'أعمال الكهرباء'),
      tt('לוח, הארקה, נקודות מאור ושקעים. כל ההשחלות לפני סגירת המחיצות.',
         'เดินสายก่อนปิดผนัง', 'التمديدات قبل الإغلاق')]);
    st.push([tt('מחיצות', 'ผนังกั้น', 'القواطع'),
      tt('מסילות U לרצפה ולתקרה, ' + pr.rooms + ' חדרים. ' +
         (u.blockWet ? 'קירות בלוק בחדרים הרטובים לפני הפאנלים.' : 'מחיצות פאנל בכל החלל.'),
         'ติดตั้งผนัง', 'تركيب القواطع')]);
    st.push([tt('חדרים רטובים', 'ห้องน้ำ', 'الحمامات'),
      tt('איטום רצפה וקירות עד 1.8 מ\', ריצוף וחיפוי, ואז כלים סניטריים. איטום לפני ריצוף, לא אחריו.',
         'กันซึมก่อนปูกระเบื้อง', 'العزل قبل التبليط')]);
    st.push([tt('מטבח וריצוף', 'ครัวและพื้น', 'المطبخ والأرضيات'),
      tt(n1(pr.counter) + ' מ\' ארונות ומשטח, כיור וחיבורים. ריצוף כללי ' + n1(pr.total) + ' מ"ר.',
         'ครัวและปูพื้น', 'المطبخ والتبليط')]);
    st.push([tt('גמר ומסירה', 'เก็บงานและส่งมอบ', 'التشطيب والتسليم'),
      tt('צבע, דלתות, ' + (u.ac ? 'מזגנים, ' : '') + 'בדיקת חשמל ומים, ניקיון ומסירה.',
         'ตรวจสอบและส่งมอบ', 'الفحص والتسليم')]);
    return st;
  }

  return { norm: norm, program: program, takeoff: takeoff, svg: svg, stages: stages };
})();
