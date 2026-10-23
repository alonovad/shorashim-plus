/* plotrec.js — המלצות גידול ומעקב לכל חלקה (Oct 2026)
 *
 * One card per plot with what to do and whether it was done:
 *  • Irrigation — next week's recommendation, computed every time from the
 *    forecast evaporation (ET0, mm/day = m³/dunam/day) × the crop's monthly
 *    coefficient. Coefficients per crop and month, each with its source:
 *    built in for date palms (Jordan Valley R&D, by stage), replaceable by
 *    the extension service's per-tree figures, an imported card, or a value
 *    typed in. Units per month: 'frac' (× evaporation per area), 'ltmm'
 *    (litres per tree per mm of evaporation), 'm3d' (fixed m³/dunam/day).
 *  • Fertilization — the crop programme (cropprog.js): recommended vs given
 *    this season per product, as bars, with what is still missing.
 *  • Tasks — generated (leaf sampling, fertilizer gaps, satellite flags,
 *    guides relevant this month) and manual ones; each can be done,
 *    scheduled or dismissed, and remembers who and when.
 *  • Sources — recommendations imported from a photo, a PDF or a link
 *    (recExtract function reads them; the person approves before anything
 *    is applied), and the guides from the library for this crop.
 *
 * Data: appData/shorashim-plotrec { kc: {crop: [12 × {v,u,src}|null]},
 *        recs: [...], auto: {key: {status,due,by,at}}, sources: [...] }
 *        worker+ write (firestore.rules).
 * Public: PlotRec.open(plotId)
 */
var PlotRec = (function () {
  'use strict';

  var KEY = 'shorashim-plotrec';
  var D = null, ui = { pid: null, tab: 'rec', item: '', showDone: false, form: null, imp: null };

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function S() { return window.SprayStore || {}; }
  function role() { return (window.currentUser || {}).role; }
  function staff() { var r = role(); return r === 'admin' || r === 'operator'; }
  function canWork() { var r = role(); return r === 'admin' || r === 'operator' || r === 'worker'; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function fmtD(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] : (iso || ''); }
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function num(x) { return (Number(x) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }); }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  function locale() { var l = (typeof currentLang !== 'undefined') ? currentLang : 'he'; return l === 'th' ? 'th-TH' : l === 'ar' ? 'ar' : 'he-IL'; }
  function monthName(i) { return new Date(2026, i, 15).toLocaleDateString(locale(), { month: 'short' }); }
  function dayName(iso) { return new Date(iso + 'T12:00:00').toLocaleDateString(locale(), { weekday: 'short' }); }
  function ltr(x) { return '<span dir="ltr">' + x + '</span>'; }

  // ── coefficients ──
  // Date palm, Medjool, Jordan Valley R&D (2012), by stage relative to
  // evaporation: fruit set → colour change 0.9, colour change → a month
  // after harvest 0.5, then until next fruit set 0.4. Stage months are the
  // valley's usual calendar; edit per crop in the irrigation tab.
  var SRC_JV = 'מו״פ בקעת הירדן — מג׳הול לפי שלבים';   // DATA KEY
  var SRC_SHAHAM = 'שה״ם 2025 — מקדם לעץ (חצבה)';       // DATA KEY
  function jv(v) { return { v: v, u: 'frac', src: SRC_JV }; }
  var DEFAULT_KC = { 'תמר': [jv(0.4), jv(0.4), jv(0.4), jv(0.9), jv(0.9), jv(0.9), jv(0.9), jv(0.5), jv(0.5), jv(0.5), jv(0.4), jv(0.4)] };   // DATA KEY
  // Extension service, Feb–May, litres per tree per mm of evaporation
  // (monthly mean of its three dekads).
  var SHAHAM_DATE = { 1: 66, 2: 67, 3: 75, 4: 76.3 };
  function cropKey(crop, table) {
    var c = String(crop || '').trim();
    if (!c) return '';
    if (table[c]) return c;
    var k = Object.keys(table).find(function (x) { return c.indexOf(x) !== -1 || x.indexOf(c) !== -1; });
    return k || '';
  }
  function kcFor(crop) {
    var own = D.kc || {}, k = cropKey(crop, own);
    if (k) return { key: k, m: own[k], own: true };
    var d = cropKey(crop, DEFAULT_KC);
    if (d) return { key: d, m: DEFAULT_KC[d], own: false };
    return { key: String(crop || '').trim(), m: [], own: false };
  }
  function unitLabel(u) {
    return u === 'ltmm' ? tt('ל׳/עץ למ״מ', 'ลิตร/ต้น ต่อ มม.', 'ل/شجرة لكل مم') : u === 'm3d' ? tt('מ״ק/ד׳ ליום', 'ลบ.ม./ไร่/วัน', 'م³/دونم/يوم') : tt('× התאדות', '× การระเหย', '× التبخر');
  }

  // ── data ──
  function norm(d) {
    d = d && typeof d === 'object' ? d : {};
    return { kc: d.kc && typeof d.kc === 'object' ? d.kc : {}, recs: Array.isArray(d.recs) ? d.recs : [],
             auto: d.auto && typeof d.auto === 'object' ? d.auto : {}, sources: Array.isArray(d.sources) ? d.sources : [] };
  }
  function load() {
    if (typeof DB === 'undefined') { D = norm(null); return Promise.resolve(); }
    return DB.loadAsync(KEY).then(function (d) { D = norm(d); }, function () { D = norm(null); });
  }
  function persist() {
    var clean = JSON.parse(JSON.stringify(D));
    var p = DB.saveAsync ? DB.saveAsync(KEY, clean) : (DB.save(KEY, clean), Promise.resolve());
    return p.then(function () { return true; }, function (e) {
      var c = String((e && (e.code || e.message)) || e);
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + (/permission/i.test(c) ? tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية') : c));
      return false;
    });
  }
  function findPlot(pid) {
    var fs = S().getFarms ? S().getFarms() : [];
    for (var i = 0; i < fs.length; i++) {
      var ps = S().getFarmPlots ? S().getFarmPlots(fs[i].id) : [];
      for (var j = 0; j < ps.length; j++) if (ps[j].id === pid) return { plot: ps[j], farm: fs[i] };
    }
    return null;
  }

  // ── irrigation ──
  function irrCalc(plot, et0) {
    var m = new Date().getMonth(), kc = kcFor(plot.crop_type), e = kc.m[m];
    var area = Number(plot.area) || 0, trees = Number(plot.tree_count) || 0, tpd = area > 0 && trees > 0 ? trees / area : 0;
    if (!e || !isFinite(Number(e.v)) || et0 == null) return { kc: kc, e: e || null };
    var v = Number(e.v), m3d, lt;
    if (e.u === 'ltmm') { lt = v * et0; m3d = tpd ? lt * tpd / 1000 : null; }
    else if (e.u === 'm3d') { m3d = v; lt = tpd ? m3d * 1000 / tpd : null; }
    else { m3d = v * et0; lt = tpd ? m3d * 1000 / tpd : null; }
    return { kc: kc, e: e, m3d: m3d, lt: lt, plotDay: m3d != null ? m3d * area : null, tpd: tpd };
  }
  function weather(farmId) {
    return new Promise(function (res) {
      if (!window.Weather || !Weather.summary) { res(null); return; }
      var done = false;
      setTimeout(function () { if (!done) { done = true; res(null); } }, 12000);
      Weather.summary(farmId, function (w) { if (!done) { done = true; res(w); } });
    });
  }
  function et0Of(w) {
    if (!w) return null;
    var a = (w.et0d || []).filter(function (x) { return x > 0; });
    if (a.length) return a.reduce(function (s, x) { return s + x; }, 0) / a.length;
    return w.et0 != null ? Number(w.et0) : null;
  }

  // ── fertilization (crop programme) ──
  function fertRows(plot) {
    var CP = window.CropProgram;
    if (!CP || !CP._program) return [];
    var prog = CP._program(plot.crop_type), coef = CP._coefOf(prog, plot);
    return prog.items.map(function (it) {
      var rec = CP._amount(it, plot, coef), app = CP._applied(plot, it);
      return { it: it, rec: rec, app: app, pct: rec > 0 ? app / rec : null };
    }).filter(function (r) { return r.rec > 0; });
  }
  function fertPct(rows) {
    var n = 0, s = 0;
    rows.forEach(function (r) { if (r.pct != null) { n++; s += Math.min(1.5, r.pct); } });
    return n ? Math.round(s / n * 100) : null;
  }
  function monthlyGiven(plot, item) {
    var out = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], y = String(new Date().getFullYear()), nm = String(item.name || '').trim();
    (S().getEvents ? S().getEvents() : []).forEach(function (ev) {
      if (String(ev.date || '').slice(0, 4) !== y || (ev.plotIds || []).indexOf(plot.id) === -1) return;
      (ev.applications || []).forEach(function (a) {
        if (String(a.productName || '').trim() !== nm) return;
        var vol = Number(ev.volumePerTree) || 0, conc = (Number(a.concentration) || 0) / 100, u = ev.volumeUnit || 'l_tree';
        var trees = Number(plot.tree_count) || 0, area = Number(plot.area) || 0;
        var L = u === 'cc_tree' ? trees * vol / 1000 * conc : u === 'l_dunam' ? area * vol * conc : trees * vol * conc;
        out[Number(String(ev.date).slice(5, 7)) - 1] += item.unit === 'גרם' ? L * 1000 : L;   // DATA KEY
      });
    });
    return out;
  }

  // ── tasks ──
  function isDate(crop) { return /תמר/.test(String(crop || '')); }   // DATA KEY (crop match)
  function autoTasks(ctx) {
    var out = [], now = new Date(), m = now.getMonth() + 1, y = now.getFullYear(), p = ctx.plot;
    if (isDate(p.crop_type)) {
      if (m === 11 || m === 12) out.push({ key: 'leaf-' + y + '-12', kind: 'leaf', due: y + '-12-15', title: tt('דיגום עלים לבדיקת הזנה', 'เก็บตัวอย่างใบเพื่อตรวจธาตุอาหาร', 'أخذ عينات أوراق لفحص التغذية'),
        text: tt('מומלץ בדצמבר ובאפריל–מאי. התוצאה מעדכנת את תוכנית הדישון.', 'แนะนำเดือนธันวาคมและเมษายน–พฤษภาคม', 'يوصى به في ديسمبر وأبريل–مايو'), guide: 'g-leaf-sampling', src: 'שה״ם' });
      if (m === 4 || m === 5) out.push({ key: 'leaf-' + y + '-05', kind: 'leaf', due: y + '-05-15', title: tt('דיגום עלים לבדיקת הזנה', 'เก็บตัวอย่างใบเพื่อตรวจธาตุอาหาร', 'أخذ عينات أوراق لفحص التغذية'),
        text: tt('מומלץ בדצמבר ובאפריל–מאי.', 'แนะนำเดือนธันวาคมและเมษายน–พฤษภาคม', 'يوصى به في ديسمبر وأبريل–مايو'), guide: 'g-leaf-sampling', src: 'שה״ם' });
      if (m === 1 || m === 2) out.push({ key: 'soil-' + y, kind: 'leaf', due: y + '-02-10', title: tt('בדיקת קרקע לפני העונה', 'ตรวจดินก่อนฤดู', 'فحص التربة قبل الموسم'),
        text: tt('ינואר–תחילת פברואר: בסיס להרכב הדשן לעונה.', 'มกราคม–ต้นกุมภาพันธ์', 'يناير–أوائل فبراير'), guide: 'g-date-fert', src: 'מו״פ בקעת הירדן' });
    }
    if (m >= 6) ctx.fert.forEach(function (r) {
      if (r.pct == null || r.pct >= 0.7) return;
      var CP = window.CropProgram, miss = r.rec - r.app;
      out.push({ key: 'fert-' + y + '-' + r.it.id, kind: 'fert', due: '', title: tt('השלמת', 'เติม', 'استكمال') + ' ' + r.it.name,
        text: tt('ניתנו', 'ให้แล้ว', 'أُعطي') + ' ' + num(r.app) + ' ' + tt('מתוך', 'จาก', 'من') + ' ' + num(r.rec) + ' ' + (CP ? CP._unitTr(r.it.unit) : r.it.unit) +
          ' (' + Math.round(r.pct * 100) + '%) · ' + tt('חסרים', 'ขาด', 'ناقص') + ' ' + num(miss), src: tt('תוכנית הדישון', 'แผนปุ๋ย', 'برنامج التسميد') });
    });
    if (ctx.sat && ctx.sat.flags && ctx.sat.flags.length && ctx.sat.cur) {
      out.push({ key: 'sat-' + ctx.sat.cur.d, kind: 'sat', due: '', title: tt('החלקה בולטת לרעה בלוויין', 'แปลงดูอ่อนจากดาวเทียม', 'القطعة ضعيفة في القمر الصناعي'),
        text: ctx.sat.flags.join(' · ') + ' · NDVI ' + ctx.sat.cur.v.toFixed(2) + ' (' + fmtD(ctx.sat.cur.d) + ')', sat: true, src: tt('לוויין', 'ดาวเทียม', 'القمر الصناعي') });
    }
    (ctx.guides || []).filter(function (g) { return g.now; }).slice(0, 2).forEach(function (g) {
      out.push({ key: 'kb-' + g.id + '-' + y + '-' + m, kind: 'read', due: '', title: tt('לקריאה החודש', 'อ่านเดือนนี้', 'للقراءة هذا الشهر') + ': ' + g.title, text: g.src, guide: g.id, src: tt('מידע שימושי', 'ข้อมูล', 'معلومات') });
    });
    return out.map(function (a) {
      var st = D.auto[ctx.plot.id + '|' + a.key] || {};
      a.auto = true; a.status = st.status || 'open'; if (st.due) a.due = st.due; a.doneBy = st.by; a.doneAt = st.at;
      return a;
    });
  }
  function storedTasks(ctx) {
    var p = ctx.plot, f = ctx.farm;
    return D.recs.filter(function (r) {
      var s = r.scope || {};
      if (s.plotId != null) return Number(s.plotId) === p.id;
      if (s.farmId != null && Number(s.farmId) !== f.id) return false;
      if (s.crop) return String(p.crop_type || '').indexOf(s.crop) !== -1 || String(s.crop).indexOf(p.crop_type || '\u0000') !== -1;
      return s.farmId != null;
    }).map(function (r) {
      var per = (r.per || {})[p.id] || {};
      return { key: 'rec-' + r.id, rid: r.id, title: r.title, text: r.text, due: per.due || r.due || '', status: per.status || r.status || 'open',
               doneBy: per.by, doneAt: per.at, src: r.source || '', kind: 'manual', month: r.month || null };
    }).filter(function (t) { return !t.month || t.month === new Date().getMonth() + 1 || t.status !== 'open' || t.due; });
  }
  function setStatus(t, status, due) {
    var u = window.currentUser || {}, rec = { status: status, by: u.name || u.username || '', at: Date.now() };
    if (due) rec.due = due;
    if (t.auto) D.auto[ui.pid + '|' + t.key] = rec;
    else {
      var r = D.recs.find(function (x) { return String(x.id) === String(t.rid); });
      if (!r) return;
      r.per = r.per || {}; r.per[ui.pid] = rec;
    }
  }

  // ── screens ──
  var ctx = null;
  function open(pid) {
    ensureCss();
    ui.pid = Number(pid); ui.tab = 'rec'; ui.item = ''; ui.form = null; ui.imp = null;
    load().then(function () {
      var f = findPlot(ui.pid);
      if (!f) { toast(tt('החלקה לא נמצאה', 'ไม่พบแปลง', 'لم يُعثر على القطعة')); return; }
      ctx = { plot: f.plot, farm: f.farm, fert: fertRows(f.plot), wx: null, et0: null, sat: null, guides: [] };
      render();
      Promise.all([
        weather(f.farm.id),
        window.Satellite && Satellite.plotStatus ? Satellite.plotStatus(f.farm.id, f.plot.id) : Promise.resolve(null),
        window.Knowledge && Knowledge.forCrop ? Knowledge.forCrop(f.plot.crop_type) : Promise.resolve([])
      ]).then(function (r) {
        if (!ctx || ctx.plot.id !== ui.pid) return;
        ctx.wx = r[0]; ctx.et0 = et0Of(r[0]); ctx.sat = r[1]; ctx.guides = r[2] || []; ctx.loaded = true;
        render();
      });
    });
  }
  function close() { ctx = null; var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m || !ctx) return;
    var p = ctx.plot, ic = irrCalc(p, ctx.et0), fp = fertPct(ctx.fert);
    var tabs = [['rec', tt('המלצות', 'คำแนะนำ', 'التوصيات')], ['irr', tt('השקיה', 'การให้น้ำ', 'الري')], ['fert', tt('דישון', 'ปุ๋ย', 'التسميد')],
                ['info', tt('מידע', 'ข้อมูล', 'معلومات')], ['src', tt('מקורות', 'แหล่งที่มา', 'المصادر')]];
    var stage = '';
    if (window.CropProgram && CropProgram._program) {
      var prog = CropProgram._program(p.crop_type), co = CropProgram._coefOf(prog, p);
      stage = tt('מקדם', 'ค่าสัมประสิทธิ์', 'معامل') + ' ' + r1(co);
    }
    m.innerHTML = '<div class="modal-overlay" id="prRoot"><div class="modal pr">' +
      '<div class="pr-hero">' +
        '<div class="pr-top"><button class="pr-ib" data-a="close" aria-label="x">✕</button>' +
          '<div class="pr-tt"><div class="pr-name">' + esc(p.name) + '</div><div class="pr-sub">' + esc(p.crop_type || '') + (p.variety ? ' ' + esc(p.variety) : '') + ' · ' + esc(ctx.farm.name) + ' · ' +
            ltr(r1(p.area)) + ' ' + tt('ד׳', 'ไร่', 'دونم') + (p.tree_count ? ' · ' + num(p.tree_count) + ' ' + tt('עצים', 'ต้น', 'شجرة') : '') + '</div></div>' +
          (stage ? '<span class="pr-pill">' + esc(stage) + '</span>' : '') + '</div>' +
        '<div class="pr-kpis">' +
          '<div><small>' + tt('השקיה מומלצת', 'น้ำที่แนะนำ', 'الري الموصى') + '</small><b>' + (ic.m3d != null ? ltr(r1(ic.m3d)) : '—') + '</b><small>' + tt('מ״ק/ד׳ ליום', 'ลบ.ม./ไร่/วัน', 'م³/دونم/يوم') + '</small></div>' +
          '<div><small>' + tt('דישון העונה', 'ปุ๋ยฤดูนี้', 'تسميد الموسم') + '</small><b>' + (fp != null ? fp + '%' : '—') + '</b><small>' + tt('מהתוכנית', 'ของแผน', 'من البرنامج') + '</small></div>' +
          '<div><small>' + tt('לוויין', 'ดาวเทียม', 'القمر') + '</small><b>' + (ctx.sat && ctx.sat.cur ? ltr(ctx.sat.cur.v.toFixed(2)) : '—') + '</b><small>NDVI' + (ctx.sat && ctx.sat.d30 != null ? ' · ' + (ctx.sat.d30 < -0.03 ? tt('יורד', 'ลดลง', 'ينخفض') : ctx.sat.d30 > 0.03 ? tt('עולה', 'เพิ่มขึ้น', 'يرتفع') : tt('יציב', 'คงที่', 'مستقر')) : '') + '</small></div>' +
        '</div></div>' +
      '<div class="pr-tabs">' + tabs.map(function (t) { return '<button class="pr-tab' + (ui.tab === t[0] ? ' on' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div class="pr-body" id="prBody">' + body(ic) + '</div>' +
    '</div></div>';
    var root = document.getElementById('prRoot');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
  }

  function body(ic) {
    if (ui.tab === 'irr') return irrTab(ic);
    if (ui.tab === 'fert') return fertCard(true);
    if (ui.tab === 'info') return infoTab();
    if (ui.tab === 'src') return srcTab();
    return irrCard(ic) + fertCard(false) + tasksCard() + srcChips();
  }

  function irrCard(ic) {
    var p = ctx.plot;
    var head = '<div class="pr-ch"><span class="pr-ico" style="color:#1f7ab8">💧</span><b>' + tt('המלצת השקיה לשבוע הקרוב', 'คำแนะนำการให้น้ำสัปดาห์นี้', 'توصية الري للأسبوع') + '</b><span class="pr-badge ok">' + tt('אוטומטי', 'อัตโนมัติ', 'تلقائي') + '</span></div>';
    if (!ic.e) return '<div class="pr-card">' + head + '<div class="pr-mut">' + tt('אין מקדם השקיה לגידול הזה לחודש הנוכחי. הגדר בלשונית השקיה או ייבא המלצה.', 'ยังไม่มีค่าสัมประสิทธิ์สำหรับพืชนี้', 'لا يوجد معامل ري لهذا المحصول') + '</div>' +
      '<div class="pr-row"><button class="pr-btn" data-tab="irr">' + tt('הגדר מקדמים', 'ตั้งค่า', 'اضبط المعاملات') + '</button><button class="pr-btn" data-tab="src">' + tt('ייבא המלצה', 'นำเข้า', 'استيراد توصية') + '</button></div></div>';
    if (ctx.et0 == null) return '<div class="pr-card">' + head + '<div class="pr-mut">' + (ctx.loaded ? tt('אין תחזית התאדות כרגע (אין חיבור או שהמשק בלי מיקום). המקדם לחודש:', 'ไม่มีพยากรณ์ตอนนี้ ค่าสัมประสิทธิ์เดือนนี้:', 'لا توقعات حاليًا. معامل الشهر:') + ' ' + ltr(r1(ic.e.v)) + ' ' + unitLabel(ic.e.u) : '⏳ ' + tt('טוען תחזית התאדות…', 'กำลังโหลดพยากรณ์…', 'جارٍ تحميل التوقعات…')) + '</div></div>';
    var big = '<div class="pr-g2">' +
      '<div class="pr-big"><small>' + tt('לעץ ליום', 'ต่อต้นต่อวัน', 'للشجرة يوميًا') + '</small><b>' + (ic.lt != null ? ltr(Math.round(ic.lt)) : '—') + ' <i>' + tt('ליטר', 'ลิตร', 'لتر') + '</i></b></div>' +
      '<div class="pr-big"><small>' + tt('לחלקה ליום', 'ต่อแปลงต่อวัน', 'للقطعة يوميًا') + '</small><b>' + (ic.plotDay != null ? ltr(Math.round(ic.plotDay)) : '—') + ' <i>' + tt('מ״ק', 'ลบ.ม.', 'م³') + '</i></b></div></div>';
    var how = ic.e.u === 'm3d' ? tt('מנה קבועה', 'ปริมาณคงที่', 'جرعة ثابتة') + ' ' + ltr(r1(ic.e.v)) + ' ' + tt('מ״ק/ד׳ ליום', 'ลบ.ม./ไร่/วัน', 'م³/دونم/يوم')
      : tt('מקדם', 'ค่าสัมประสิทธิ์', 'معامل') + ' ' + ltr(r1(ic.e.v)) + (ic.e.u === 'ltmm' ? ' ' + unitLabel(ic.e.u) : '') + ' × ' + tt('התאדות צפויה', 'การระเหยที่คาด', 'التبخر المتوقع') + ' ' + ltr(r1(ctx.et0)) + ' ' + tt('מ״מ ליום (ממוצע 7 ימים)', 'มม./วัน (เฉลี่ย 7 วัน)', 'مم/يوم (متوسط 7 أيام)');
    return '<div class="pr-card">' + head + big +
      '<div class="pr-mut">' + how + (ic.m3d != null ? ' · ' + ltr(r1(ic.m3d)) + ' ' + tt('מ״ק לדונם ליום', 'ลบ.ม./ไร่/วัน', 'م³/دونم/يوم') : '') +
        (ic.lt == null && !p.tree_count ? ' · ' + tt('חסר מספר עצים בחלקה', 'ไม่มีจำนวนต้น', 'عدد الأشجار ناقص') : '') + '</div>' +
      '<div class="pr-row"><button class="pr-btn" data-tab="irr">' + tt('פירוט שבועי ומקדמים', 'รายละเอียด', 'التفاصيل والمعاملات') + '</button></div>' +
      '<div class="pr-src">' + tt('מקור', 'ที่มา', 'المصدر') + ': ' + esc(ic.e.src || '') + ' · ' + tt('התאדות: תחזית Open-Meteo', 'การระเหย: Open-Meteo', 'التبخر: Open-Meteo') + '</div></div>';
  }

  function irrTab(ic) {
    var p = ctx.plot, kc = ic.kc, cur = new Date().getMonth(), w = ctx.wx;
    var week = '';
    if (w && (w.et0d || []).length) {
      week = '<div class="pr-wrap"><table class="pr-tbl"><thead><tr><th>' + tt('יום', 'วัน', 'اليوم') + '</th><th>ET0</th><th>' + tt('מ״ק/ד׳', 'ลบ.ม./ไร่', 'م³/دونم') + '</th><th>' + tt('ל׳/עץ', 'ลิตร/ต้น', 'ل/شجرة') + '</th><th>' + tt('מ״ק לחלקה', 'ลบ.ม./แปลง', 'م³ للقطعة') + '</th></tr></thead><tbody>' +
        w.et0d.map(function (e0, i) {
          var c = irrCalc(p, e0), d = (w.days || [])[i] || '';
          return '<tr><td>' + (d ? dayName(d) + ' ' + fmtD(d) : '') + '</td><td class="n">' + ltr(r1(e0)) + '</td><td class="n">' + (c.m3d != null ? ltr(r1(c.m3d)) : '—') + '</td><td class="n">' + (c.lt != null ? ltr(Math.round(c.lt)) : '—') + '</td><td class="n">' + (c.plotDay != null ? ltr(Math.round(c.plotDay)) : '—') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    var rows = '';
    for (var i = 0; i < 12; i++) {
      var e = (kc.m || [])[i] || null;
      rows += '<tr' + (i === cur ? ' class="cur"' : '') + '><td>' + monthName(i) + '</td>' +
        (staff() ? '<td><input class="form-input pr-kv" data-m="' + i + '" type="number" step="0.01" min="0" value="' + (e ? e.v : '') + '" inputmode="decimal"></td>' +
                   '<td><select class="form-input pr-ku" data-m="' + i + '">' + ['frac', 'ltmm', 'm3d'].map(function (u) { return '<option value="' + u + '"' + ((e ? e.u : 'frac') === u ? ' selected' : '') + '>' + unitLabel(u) + '</option>'; }).join('') + '</select></td>'
                 : '<td class="n">' + (e ? ltr(e.v) : '—') + '</td><td>' + (e ? unitLabel(e.u) : '') + '</td>') +
        '<td class="pr-mut">' + esc(e ? e.src : '') + '</td></tr>';
    }
    return '<div class="pr-card"><div class="pr-ch"><b>' + tt('7 הימים הקרובים', '7 วันข้างหน้า', 'الأيام السبعة القادمة') + '</b></div>' + (week || '<div class="pr-mut">⏳</div>') +
      '<div class="pr-mut">' + tt('ET0 = התאדות מחושבת במ״מ ליום; 1 מ״מ = 1 מ״ק לדונם. מרווח השקיה 1–4 ימים לפי קרקע וגיל המטע.', 'ET0 = การระเหยเป็นมม./วัน', 'ET0 = التبخر مم/يوم') + '</div></div>' +
      '<div class="pr-card"><div class="pr-ch"><b>' + tt('מקדמי השקיה —', 'ค่าสัมประสิทธิ์ —', 'معاملات الري —') + ' ' + esc(kc.key || p.crop_type || '') + '</b>' + (kc.own ? '' : '<span class="pr-badge">' + tt('ברירת מחדל', 'ค่าเริ่มต้น', 'افتراضي') + '</span>') + '</div>' +
        '<div class="pr-wrap"><table class="pr-tbl"><thead><tr><th>' + tt('חודש', 'เดือน', 'الشهر') + '</th><th>' + tt('ערך', 'ค่า', 'القيمة') + '</th><th>' + tt('יחידה', 'หน่วย', 'الوحدة') + '</th><th>' + tt('מקור', 'ที่มา', 'المصدر') + '</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        (staff() ? '<div class="pr-row"><button class="pr-btn pri" data-a="kcsave">💾 ' + tt('שמור מקדמים לגידול', 'บันทึก', 'حفظ المعاملات') + '</button>' +
          (isDate(p.crop_type) ? '<button class="pr-btn" data-a="shaham">' + tt('החל מקדמי שה״ם 2025 (פבר׳–מאי)', 'ใช้ค่าของ Shaham 2025', 'تطبيق معاملات شاهام 2025') + '</button>' : '') +
          (kc.own ? '<button class="pr-btn ghost" data-a="kcreset">' + tt('חזור לברירת מחדל', 'คืนค่าเริ่มต้น', 'استعادة الافتراضي') + '</button>' : '') + '</div>' : '') +
        '<div class="pr-mut">' + tt('המקדמים חלים על כל החלקות של הגידול בכל המשקים.', 'ใช้กับทุกแปลงของพืชนี้', 'تنطبق على كل قطع هذا المحصول') + '</div></div>';
  }

  function fertCard(full) {
    var rows = ctx.fert, CP = window.CropProgram;
    var head = '<div class="pr-ch"><span class="pr-ico" style="color:#5a8f1f">📊</span><b>' + tt('דישון — מומלץ מול ניתן העונה', 'ปุ๋ย — แนะนำเทียบกับที่ให้', 'التسميد — الموصى مقابل المعطى') + '</b></div>';
    if (!rows.length) return '<div class="pr-card">' + head + '<div class="pr-mut">' + tt('אין תוכנית דישון לגידול הזה. הגדר אותה בכרטיס המשק ← תוכנית לגידול.', 'ยังไม่มีแผนปุ๋ย', 'لا يوجد برنامج تسميد') + '</div></div>';
    var max = rows.reduce(function (s, r) { return Math.max(s, r.rec, r.app); }, 0) || 1;
    var bars = '<div class="pr-bars">' + rows.slice(0, 8).map(function (r) {
      var low = r.pct != null && r.pct < 0.7;
      return '<button class="pr-bc' + (ui.item === String(r.it.id) ? ' on' : '') + '" data-item="' + esc(String(r.it.id)) + '" title="' + esc(r.it.name) + '">' +
        '<span class="pr-bp">' + (r.pct != null ? Math.round(r.pct * 100) + '%' : '') + '</span>' +
        '<span class="pr-bb"><i class="rec" style="height:' + Math.round(r.rec / max * 100) + '%"></i><i class="' + (low ? 'low' : 'app') + '" style="height:' + Math.round(Math.min(r.app, max * 1.2) / max * 100) + '%"></i></span>' +
        '<span class="pr-bl">' + esc(r.it.name) + '</span></button>';
    }).join('') + '</div>' +
      '<div class="pr-leg"><span><i style="background:#d5e8b0"></i>' + tt('מומלץ', 'แนะนำ', 'موصى') + '</span><span><i style="background:#4f8a1b"></i>' + tt('ניתן', 'ให้แล้ว', 'معطى') + '</span><span><i style="background:#d9822b"></i>' + tt('מתחת ל-70%', 'ต่ำกว่า 70%', 'أقل من 70%') + '</span></div>';
    var sel = rows.find(function (r) { return String(r.it.id) === ui.item; }) || (full ? rows[0] : null);
    var detail = '';
    if (sel) {
      var mg = monthlyGiven(ctx.plot, sel.it), mx = Math.max.apply(null, mg.concat([0.0001])), cm = new Date().getMonth();
      var man = CP ? CP._manual(ctx.plot, sel.it) : 0, u = CP ? CP._unitTr(sel.it.unit) : sel.it.unit;
      detail = '<div class="pr-sel"><b>' + esc(sel.it.name) + '</b> · ' + num(sel.app) + ' / ' + num(sel.rec) + ' ' + esc(u) + (sel.it.timing ? ' · ' + esc(sel.it.timing) : '') +
        '<div class="pr-mbars">' + mg.map(function (v, i) { return '<span class="' + (i === cm ? 'cur' : '') + '"><i style="height:' + Math.round(v / mx * 100) + '%"></i><small>' + monthName(i) + '</small></span>'; }).join('') + '</div>' +
        '<div class="pr-mut">' + tt('לפי חודש: מיומן הריסוס/דישון', 'รายเดือน: จากบันทึก', 'حسب الشهر: من السجل') + (man ? ' · ' + tt('ידני (ללא חודש)', 'บันทึกเอง', 'يدوي') + ' ' + num(man) + ' ' + esc(u) : '') + '</div>' +
        (canWork() && staff() ? '<div class="pr-row"><input class="form-input pr-add" id="prAddAmt" type="number" min="0" step="0.1" placeholder="' + esc(u) + '" inputmode="decimal"><button class="pr-btn pri" data-a="fertadd" data-id="' + esc(String(sel.it.id)) + '">＋ ' + tt('רשום מתן', 'บันทึกการให้', 'سجّل إعطاء') + '</button></div>' : '') +
        (sel.pct != null && sel.pct < 1 ? '<div class="pr-warn">' + tt('חסרים', 'ขาด', 'ناقص') + ' ' + num(sel.rec - sel.app) + ' ' + esc(u) + ' ' + tt('להשלמת התוכנית בחלקה', 'เพื่อให้ครบแผน', 'لاستكمال البرنامج') + '</div>' : '') + '</div>';
    }
    return '<div class="pr-card">' + head + bars + detail + '</div>';
  }

  function tasksCard() {
    var all = autoTasks(ctx).concat(storedTasks(ctx));
    var open = all.filter(function (t) { return t.status === 'open' || t.status === 'scheduled'; }).sort(function (a, b) { return String(a.due || '9').localeCompare(String(b.due || '9')); });
    var done = all.filter(function (t) { return t.status === 'done' || t.status === 'dismissed'; });
    var days = [], d0 = new Date();
    for (var i = 0; i < 7; i++) { var d = new Date(d0); d.setDate(d0.getDate() + i); days.push(d.toISOString().slice(0, 10)); }
    var strip = '<div class="pr-days">' + days.map(function (d) {
      var n = open.filter(function (t) { return t.due === d; }).length;
      return '<span class="' + (d === today() ? 'on' : '') + '"><small>' + dayName(d) + '</small><b>' + Number(d.slice(8)) + '</b>' + (n ? '<i></i>' : '') + '</span>';
    }).join('') + '</div>';
    function card(t, idx) {
      var dot = t.kind === 'sat' ? '#b3261e' : t.kind === 'fert' ? '#4f8a1b' : t.kind === 'read' ? '#1f7ab8' : '#d9822b';
      var badge = t.due ? (t.due < today() ? '<span class="pr-badge bad">' + tt('באיחור', 'เลยกำหนด', 'متأخر') + ' · ' + fmtD(t.due) + '</span>' : '<span class="pr-badge warn">' + fmtD(t.due) + '</span>') : '<span class="pr-badge">' + esc(t.src || '') + '</span>';
      var k = esc(t.key);
      return '<div class="pr-task"><div class="pr-th"><i style="background:' + dot + '"></i><b>' + esc(t.title) + '</b>' + badge + '</div>' +
        (t.text ? '<div class="pr-mut">' + esc(t.text) + '</div>' : '') +
        (canWork() ? '<div class="pr-row">' +
          (t.guide ? '<button class="pr-btn" data-guide="' + esc(t.guide) + '">📘 ' + tt('מדריך', 'คู่มือ', 'دليل') + '</button>' : '') +
          (t.sat ? '<button class="pr-btn" data-a="sat">🛰️ ' + tt('פתח בלוויין', 'เปิดดาวเทียม', 'افتح القمر') + '</button>' : '') +
          '<button class="pr-btn pri" data-t="done" data-k="' + k + '">✔ ' + tt('בוצע', 'เสร็จ', 'تم') + '</button>' +
          '<button class="pr-btn" data-t="sched" data-k="' + k + '">📅 ' + tt('תזמן', 'นัด', 'جدولة') + '</button>' +
          '<button class="pr-btn ghost" data-t="dismiss" data-k="' + k + '">' + tt('דחה', 'ปฏิเสธ', 'رفض') + '</button>' +
          (ui.form && ui.form.sched === t.key ? '<input type="date" class="form-input pr-date" id="prSchedD" value="' + (t.due || today()) + '"><button class="pr-btn pri" data-t="schedok" data-k="' + k + '">OK</button>' : '') +
        '</div>' : '') + '</div>';
    }
    var form = '';
    if (ui.form && ui.form.add) {
      form = '<div class="pr-task pr-form"><b>' + tt('המלצה ידנית', 'คำแนะนำเพิ่มเอง', 'توصية يدوية') + '</b>' +
        '<label>' + tt('כותרת', 'หัวข้อ', 'العنوان') + '<input class="form-input" id="prFT"></label>' +
        '<label>' + tt('פירוט', 'รายละเอียด', 'التفاصيل') + '<textarea class="form-input" id="prFX" rows="2"></textarea></label>' +
        '<div class="pr-g2"><label>' + tt('מועד', 'วันที่', 'الموعد') + '<input type="date" class="form-input" id="prFD"></label>' +
        '<label>' + tt('חל על', 'ใช้กับ', 'ينطبق على') + '<select class="form-input" id="prFS"><option value="plot">' + tt('החלקה הזו', 'แปลงนี้', 'هذه القطعة') + '</option>' +
          (ctx.plot.crop_type ? '<option value="crop">' + tt('כל חלקות', 'ทุกแปลง', 'كل قطع') + ' ' + esc(ctx.plot.crop_type) + ' ' + tt('במשק', 'ในฟาร์ม', 'في المزرعة') + '</option>' : '') +
          '<option value="farm">' + tt('כל המשק', 'ทั้งฟาร์ม', 'كل المزرعة') + '</option></select></label></div>' +
        '<div class="pr-row"><button class="pr-btn pri" data-a="addsave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button><button class="pr-btn ghost" data-a="addcancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    }
    return '<div class="pr-ttl"><b>' + tt('משימות מומלצות', 'งานที่แนะนำ', 'مهام موصى بها') + '</b>' + (canWork() ? '<button class="pr-btn" data-a="add">＋ ' + tt('המלצה ידנית', 'เพิ่มเอง', 'توصية يدوية') + '</button>' : '') + '</div>' +
      strip + form + (open.length ? open.map(card).join('') : '<div class="pr-empty">' + tt('אין משימות פתוחות לחלקה הזו', 'ไม่มีงานค้าง', 'لا مهام مفتوحة') + '</div>') +
      (done.length ? '<button class="pr-btn ghost" data-a="showdone">' + (ui.showDone ? '▾ ' : '▸ ') + tt('הושלמו / נדחו', 'เสร็จ/ปฏิเสธ', 'منجزة/مرفوضة') + ' (' + done.length + ')</button>' +
        (ui.showDone ? done.map(function (t) {
          return '<div class="pr-task done"><div class="pr-th"><i style="background:#9e9e9e"></i><b>' + esc(t.title) + '</b><span class="pr-badge">' + (t.status === 'done' ? '✔ ' : '✕ ') + esc(t.doneBy || '') + (t.doneAt ? ' · ' + new Date(t.doneAt).toLocaleDateString(locale()) : '') + '</span></div>' +
            (canWork() ? '<div class="pr-row"><button class="pr-btn ghost" data-t="reopen" data-k="' + esc(t.key) + '">↺ ' + tt('פתח מחדש', 'เปิดใหม่', 'إعادة فتح') + '</button></div>' : '') + '</div>';
        }).join('') : '') : '');
  }

  function srcChips() {
    var own = D.sources.filter(function (s) { return !s.crop || String(ctx.plot.crop_type || '').indexOf(s.crop) !== -1 || String(s.crop).indexOf(ctx.plot.crop_type || '\u0000') !== -1; });
    var kc = kcFor(ctx.plot.crop_type), srcs = {};
    (kc.m || []).forEach(function (e) { if (e && e.src) srcs[e.src] = 1; });
    return '<div class="pr-card"><div class="pr-ch"><b>' + tt('מקורות ההמלצות לחלקה', 'แหล่งที่มาของคำแนะนำ', 'مصادر التوصيات') + '</b></div><div class="pr-chips">' +
      Object.keys(srcs).map(function (s) { return '<span>' + esc(s) + '</span>'; }).join('') +
      '<span class="b">' + tt('התאדות — תחזית יומית', 'การระเหย — พยากรณ์รายวัน', 'التبخر — توقعات يومية') + '</span>' +
      (ctx.fert.length ? '<span>' + tt('תוכנית הדישון של הגידול', 'แผนปุ๋ยของพืช', 'برنامج تسميد المحصول') + '</span>' : '') +
      own.map(function (s) { return '<span class="o">' + esc(s.title) + '</span>'; }).join('') + '</div>' +
      '<button class="pr-btn wide" data-tab="src">' + tt('ניהול מקורות וייבוא המלצה', 'จัดการแหล่งและนำเข้า', 'إدارة المصادر والاستيراد') + ' ←</button></div>';
  }

  function infoTab() {
    var g = ctx.guides || [];
    return '<div class="pr-card"><div class="pr-ch"><b>📚 ' + tt('מידע שימושי לגידול', 'ข้อมูลสำหรับพืชนี้', 'معلومات لهذا المحصول') + '</b></div>' +
      (g.length ? g.map(function (x) {
        return '<button class="pr-guide" data-guide="' + esc(x.id) + '"><b>' + esc(x.title) + '</b>' + (x.now ? '<span class="pr-badge ok">' + tt('רלוונטי עכשיו', 'ตอนนี้', 'الآن') + '</span>' : '') + (x.src ? '<small>' + esc(x.src) + '</small>' : '') + '</button>';
      }).join('') : '<div class="pr-empty">' + tt('אין עדיין מדריכים לגידול הזה', 'ยังไม่มีคู่มือ', 'لا أدلة بعد') + '</div>') +
      '<button class="pr-btn wide" data-a="lib">' + tt('לכל הספרייה', 'ไปที่คลังข้อมูล', 'إلى المكتبة') + ' ←</button></div>';
  }

  function srcTab() {
    var imp = ui.imp;
    if (imp && imp.res) return reviewImport(imp.res);
    var crops = cropList();
    return '<div class="pr-card"><div class="pr-ch"><b>' + tt('ייבוא המלצה חדשה', 'นำเข้าคำแนะนำ', 'استيراد توصية جديدة') + '</b></div>' +
      (staff() ? '<label class="pr-lbl">' + tt('צילום / PDF', 'รูป / PDF', 'صورة / PDF') + '<input type="file" class="form-input" id="prImpFile" accept="image/*,application/pdf"></label>' +
        '<label class="pr-lbl">' + tt('או קישור לקובץ / דף', 'หรือลิงก์', 'أو رابط') + '<input class="form-input" id="prImpUrl" placeholder="https://"></label>' +
        '<label class="pr-lbl">' + tt('אזור וקרקע (לבחירת השורה הנכונה בטבלה)', 'พื้นที่และดิน', 'المنطقة والتربة') + '<input class="form-input" id="prImpHint" value="' + esc(ctx.farm.name + ' · ' + tt('בקעת הירדן', 'หุบเขาจอร์แดน', 'غور الأردن')) + '"></label>' +
        '<div class="pr-row"><button class="pr-btn pri" data-a="impread"' + (imp && imp.busy ? ' disabled' : '') + '>🔍 ' + (imp && imp.busy ? tt('קורא…', 'กำลังอ่าน…', 'جارٍ القراءة…') : tt('קרא', 'อ่าน', 'اقرأ')) + '</button></div>' +
        (imp && imp.err ? '<div class="pr-warn">' + esc(imp.err) + '</div>' : '') +
        '<div class="pr-mut">' + tt('הקובץ נקרא אוטומטית: גידול, אזור, תקופה, מנות ומקדמים ומשימות. אתה מאשר לפני שזה נכנס לחלקות.', 'ระบบอ่านอัตโนมัติ คุณยืนยันก่อนใช้', 'يُقرأ تلقائيًا وتؤكد قبل التطبيق') + '</div>'
        : '<div class="pr-mut">' + tt('ייבוא המלצות — מנהלים בלבד', 'เฉพาะผู้จัดการ', 'للمديرين فقط') + '</div>') + '</div>' +
      '<div class="pr-ttl"><b>' + tt('מקורות פעילים', 'แหล่งที่ใช้งาน', 'مصادر نشطة') + '</b></div>' +
      '<div class="pr-srow"><span class="pr-si b">💧</span><div><b>' + tt('התאדות יומית — אוטומטי', 'การระเหยรายวัน — อัตโนมัติ', 'التبخر اليومي — تلقائي') + '</b><small>' + tt('תחזית 7 ימים לכל משק, מתעדכן בכל פתיחה', 'พยากรณ์ 7 วัน', 'توقعات 7 أيام') + '</small></div></div>' +
      '<div class="pr-srow"><span class="pr-si">📄</span><div><b>' + esc(SRC_JV) + '</b><small>' + tt('ברירת המחדל לתמר: 0.9 / 0.5 / 0.4 לפי שלב', 'ค่าเริ่มต้นสำหรับอินทผลัม', 'الافتراضي للنخيل') + '</small></div></div>' +
      '<div class="pr-srow"><span class="pr-si">📄</span><div><b>' + tt('שה״ם — המלצות לגידול תמרים 2025', 'Shaham — คำแนะนำอินทผลัม 2025', 'شاهام — توصيات النخيل 2025') + '</b><small>' + tt('מקדם לעץ פבר׳–מאי · ניתן להחיל בלשונית השקיה', 'ใช้ได้ในแท็บการให้น้ำ', 'يمكن تطبيقه في تبويب الري') + '</small></div>' +
        '<a class="pr-btn" target="_blank" rel="noopener" href="https://www.gov.il/BlobFolder/reports/recommendations-for-growing-date-palm/he/Professional_information_recommendations-for-growing-date-palm.pdf">PDF</a></div>' +
      D.sources.slice().reverse().map(function (s) {
        return '<div class="pr-srow"><span class="pr-si o">✓</span><div><b>' + esc(s.title) + '</b><small>' + esc([s.publisher, s.crop, s.period, s.added ? new Date(s.added).toLocaleDateString(locale()) : '', s.by].filter(Boolean).join(' · ')) + '</small></div>' +
          (s.url ? '<a class="pr-btn" target="_blank" rel="noopener" href="' + esc(s.url) + '">🔗</a>' : '') +
          (staff() ? '<button class="pr-btn ghost" data-delsrc="' + esc(String(s.id)) + '">🗑</button>' : '') + '</div>';
      }).join('') +
      '<div class="pr-note">' + tt('כל המלצה שומרת את המקור והתאריך שלה. מקדם שיובא מחליף את הקודם לאותם חודשים של אותו גידול.', 'ทุกคำแนะนำเก็บแหล่งที่มาและวันที่', 'كل توصية تحفظ مصدرها وتاريخها') + (crops.length ? '' : '') + '</div>';
  }
  function cropList() {
    var seen = {}, out = [];
    (S().getFarms ? S().getFarms() : []).forEach(function (f) {
      (S().getFarmPlots ? S().getFarmPlots(f.id) : []).forEach(function (p) { var c = String(p.crop_type || '').trim(); if (c && !seen[c]) { seen[c] = 1; out.push(c); } });
    });
    return out.sort(function (a, b) { return a.localeCompare(b, 'he'); });
  }

  // ── import ──
  function fileB64(blob) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(blob); }); }
  function shrink(file) {
    return new Promise(function (res) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 2200 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
        cv.toBlob(function (b) { res(b || file); }, 'image/jpeg', 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(file); };
      img.src = url;
    });
  }
  function readImport() {
    var f = (document.getElementById('prImpFile').files || [])[0], url = document.getElementById('prImpUrl').value.trim(), hint = document.getElementById('prImpHint').value;
    if (!f && !/^https:\/\//.test(url)) { toast('⚠️ ' + tt('בחר קובץ או הדבק קישור https', 'เลือกไฟล์หรือลิงก์', 'اختر ملفًا أو رابطًا')); return; }
    if (typeof firebase === 'undefined' || !firebase.app || !firebase.app().functions) { toast('❌ functions'); return; }
    ui.imp = { busy: true }; refreshBody();
    var req = { hint: hint, crops: cropList() };
    var prep;
    if (f) {
      var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      if (isPdf && f.size > 6.5 * 1024 * 1024) { ui.imp = { err: tt('PDF גדול מדי (עד 6.5MB)', 'PDF ใหญ่เกินไป', 'PDF كبير جدًا') }; refreshBody(); return; }
      prep = (isPdf ? fileB64(f) : shrink(f).then(fileB64)).then(function (b) { if (isPdf) req.pdf = b; else req.image = b; req.name = f.name; });
    } else { req.url = url; prep = Promise.resolve(); }
    prep.then(function () {
      return firebase.app().functions('us-central1').httpsCallable('recExtract', { timeout: 185000 })(req);
    }).then(function (r) { ui.imp = { res: Object.assign({ url: url || '' }, r.data || {}) }; refreshBody(); }, function (e) {
      ui.imp = { err: '❌ ' + ((e && e.message) || e) }; refreshBody();
    });
  }
  function reviewImport(res) {
    var crops = cropList(), months = res.months || [], tasks = res.tasks || [];
    var guess = crops.find(function (c) { return res.crop && (c.indexOf(res.crop) !== -1 || res.crop.indexOf(c) !== -1); }) || ctx.plot.crop_type || '';
    return '<div class="pr-card pr-rev"><div class="pr-ch"><b>' + tt('נקרא מהקובץ — לאישור', 'อ่านจากไฟล์ — รอยืนยัน', 'المقروء من الملف — للتأكيد') + '</b>' + (res.publisher ? '<span class="pr-badge ok">' + esc(res.publisher) + '</span>' : '') + '</div>' +
      '<div><b>' + esc(res.title || '') + '</b></div><div class="pr-mut">' + esc([res.crop, res.region, res.period].filter(Boolean).join(' · ')) + '</div>' +
      (res.notes ? '<div class="pr-mut">' + esc(res.notes) + '</div>' : '') +
      '<label class="pr-lbl">' + tt('להחיל על הגידול', 'ใช้กับพืช', 'تطبيق على المحصول') + '<select class="form-input" id="prImpCrop">' + crops.map(function (c) { return '<option' + (c === guess ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
      (months.length ? '<div class="pr-wrap"><table class="pr-tbl"><thead><tr><th></th><th>' + tt('חודש', 'เดือน', 'الشهر') + '</th><th>' + tt('ערך', 'ค่า', 'القيمة') + '</th><th>' + tt('יחידה', 'หน่วย', 'الوحدة') + '</th></tr></thead><tbody>' +
        months.map(function (x, i) { return '<tr><td><input type="checkbox" class="pr-im" data-i="' + i + '" checked></td><td>' + monthName(x.month - 1) + '</td><td class="n">' + ltr(x.value) + '</td><td>' + unitLabel(x.unit) + '</td></tr>'; }).join('') + '</tbody></table></div>'
        : '<div class="pr-mut">' + tt('לא נמצאו מקדמים או מנות השקיה', 'ไม่พบค่าการให้น้ำ', 'لم يُعثر على معاملات') + '</div>') +
      (res.irrigation_notes ? '<div class="pr-mut">💧 ' + esc(res.irrigation_notes) + '</div>' : '') +
      (res.fert_notes ? '<div class="pr-mut">📊 ' + esc(res.fert_notes) + '</div>' : '') +
      (tasks.length ? '<div class="pr-ttl"><b>' + tt('משימות שנמצאו', 'งานที่พบ', 'مهام وُجدت') + '</b></div>' + tasks.map(function (t, i) {
        return '<label class="pr-chk"><input type="checkbox" class="pr-it" data-i="' + i + '" checked><span><b>' + esc(t.title) + '</b>' + (t.month ? ' · ' + monthName(t.month - 1) : '') + (t.text ? '<small>' + esc(t.text) + '</small>' : '') + '</span></label>';
      }).join('') : '') +
      '<div class="pr-row"><button class="pr-btn pri" data-a="impapply">' + tt('אשר והחל', 'ยืนยันและใช้', 'تأكيد وتطبيق') + '</button><button class="pr-btn ghost" data-a="impcancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
  }
  function applyImport() {
    var res = ui.imp && ui.imp.res; if (!res) return;
    var crop = document.getElementById('prImpCrop').value, u = window.currentUser || {};
    var title = res.title || tt('המלצה מיובאת', 'คำแนะนำที่นำเข้า', 'توصية مستوردة');
    var src = { id: uid(), title: title, publisher: res.publisher || '', crop: crop, region: res.region || '', period: res.period || '', url: res.url || '', added: Date.now(), by: u.name || u.username || '' };
    var label = (res.publisher ? res.publisher + ' — ' : '') + title;
    var k = cropKey(crop, D.kc) || crop, cur = (D.kc[k] || (kcFor(crop).m || []).slice()).slice();
    while (cur.length < 12) cur.push(null);
    var nm = 0;
    (res.months || []).forEach(function (x, i) {
      var cb = document.querySelector('.pr-im[data-i="' + i + '"]');
      if (!cb || !cb.checked || !(x.month >= 1 && x.month <= 12)) return;
      cur[x.month - 1] = { v: Number(x.value), u: x.unit, src: label.slice(0, 80) }; nm++;
    });
    if (nm) D.kc[k] = cur;
    var nt = 0;
    (res.tasks || []).forEach(function (t, i) {
      var cb = document.querySelector('.pr-it[data-i="' + i + '"]');
      if (!cb || !cb.checked) return;
      D.recs.push({ id: uid() + i, scope: { crop: crop }, title: String(t.title || '').slice(0, 120), text: String(t.text || '').slice(0, 400), month: t.month || null, due: '', status: 'open', source: label.slice(0, 80), created: Date.now(), by: src.by });
      nt++;
    });
    src.items = nm + nt;
    D.sources.push(src);
    persist().then(function (ok) {
      if (ok) toast('✅ ' + tt('הוחל', 'ใช้แล้ว', 'طُبّق') + ': ' + nm + ' ' + tt('חודשים', 'เดือน', 'أشهر') + ', ' + nt + ' ' + tt('משימות', 'งาน', 'مهام'));
      ui.imp = null; ui.tab = 'rec'; render();
    });
  }

  // ── events ──
  function refreshBody() {
    var b = document.getElementById('prBody'); if (!b || !ctx) return;
    b.innerHTML = body(irrCalc(ctx.plot, ctx.et0));
  }
  function taskByKey(k) {
    return autoTasks(ctx).concat(storedTasks(ctx)).find(function (t) { return t.key === k; });
  }
  function onChange(e) {
    if (e.target.id === 'prImpFile' && e.target.files && e.target.files[0]) { var u = document.getElementById('prImpUrl'); if (u) u.value = ''; }
  }
  function onClick(e) {
    var t = e.target;
    if (t.id === 'prRoot') return close();
    var tab = t.closest('[data-tab]');
    if (tab) { ui.tab = tab.getAttribute('data-tab'); ui.form = null; render(); return; }
    var it = t.closest('[data-item]');
    if (it) { var v = it.getAttribute('data-item'); ui.item = ui.item === v ? '' : v; refreshBody(); return; }
    var g = t.closest('[data-guide]');
    if (g && window.Knowledge) { Knowledge.openItem(g.getAttribute('data-guide')); return; }
    var ds = t.closest('[data-delsrc]');
    if (ds) {
      if (!confirm(tt('להסיר את המקור מהרשימה? (מקדמים ומשימות שהוחלו נשארים)', 'ลบแหล่งที่มา?', 'إزالة المصدر؟'))) return;
      D.sources = D.sources.filter(function (s) { return String(s.id) !== ds.getAttribute('data-delsrc'); });
      persist().then(refreshBody); return;
    }
    var tk = t.closest('[data-t]');
    if (tk) {
      var act = tk.getAttribute('data-t'), task = taskByKey(tk.getAttribute('data-k'));
      if (!task) return;
      if (act === 'sched') { ui.form = { sched: task.key }; refreshBody(); return; }
      if (act === 'schedok') { var dv = (document.getElementById('prSchedD') || {}).value; if (!dv) return; setStatus(task, 'scheduled', dv); }
      else if (act === 'done') setStatus(task, 'done');
      else if (act === 'dismiss') setStatus(task, 'dismissed');
      else if (act === 'reopen') setStatus(task, 'open');
      ui.form = null;
      persist().then(refreshBody);
      return;
    }
    var a = t.closest('[data-a]');
    if (!a) return;
    var k = a.getAttribute('data-a');
    if (k === 'close') return close();
    if (k === 'lib') { if (window.Knowledge) Knowledge.open(); return; }
    if (k === 'sat') { if (window.Satellite) Satellite.open(ctx.farm.id, ctx.plot.id); return; }
    if (k === 'showdone') { ui.showDone = !ui.showDone; refreshBody(); return; }
    if (k === 'add') { ui.form = { add: true }; refreshBody(); return; }
    if (k === 'addcancel') { ui.form = null; refreshBody(); return; }
    if (k === 'addsave') {
      var ti = document.getElementById('prFT').value.trim(); if (!ti) { toast('❌ ' + tt('חסרה כותרת', 'ไม่มีหัวข้อ', 'العنوان ناقص')); return; }
      var sc = document.getElementById('prFS').value, scope = sc === 'plot' ? { plotId: ctx.plot.id } : sc === 'crop' ? { crop: ctx.plot.crop_type, farmId: ctx.farm.id } : { farmId: ctx.farm.id };
      var uu = window.currentUser || {};
      D.recs.push({ id: uid(), scope: scope, title: ti, text: document.getElementById('prFX').value.trim(), due: document.getElementById('prFD').value || '', status: 'open', source: tt('ידני', 'เพิ่มเอง', 'يدوي') + ' · ' + (uu.name || uu.username || ''), created: Date.now(), by: uu.name || uu.username || '' });
      ui.form = null; persist().then(refreshBody); return;
    }
    if (k === 'kcsave' || k === 'shaham' || k === 'kcreset') {
      var kc = kcFor(ctx.plot.crop_type), key = kc.key || String(ctx.plot.crop_type || '').trim();
      if (!key) return;
      if (k === 'kcreset') { delete D.kc[key]; }
      else {
        var arr = [];
        for (var i = 0; i < 12; i++) {
          var vi = document.querySelector('.pr-kv[data-m="' + i + '"]'), ui2 = document.querySelector('.pr-ku[data-m="' + i + '"]'), old = (kc.m || [])[i];
          var val = vi && vi.value !== '' ? Number(vi.value) : null;
          if (val == null || !isFinite(val)) { arr.push(null); continue; }
          var unit = ui2 ? ui2.value : 'frac';
          var same = old && Number(old.v) === val && old.u === unit;
          arr.push({ v: val, u: unit, src: same ? old.src : tt('ידני', 'เพิ่มเอง', 'يدوي') + ' · ' + ((window.currentUser || {}).name || '') });
        }
        if (k === 'shaham') Object.keys(SHAHAM_DATE).forEach(function (mi) { arr[Number(mi)] = { v: SHAHAM_DATE[mi], u: 'ltmm', src: SRC_SHAHAM }; });
        D.kc[key] = arr;
      }
      persist().then(function (ok) { if (ok) toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ')); render(); });
      return;
    }
    if (k === 'fertadd') {
      var amt = Number((document.getElementById('prAddAmt') || {}).value);
      if (!(amt > 0)) return;
      var id = a.getAttribute('data-id'), CP = window.CropProgram, y = CP ? CP._season() : String(new Date().getFullYear());
      var fert = JSON.parse(JSON.stringify(ctx.plot.fert || {})); fert[y] = fert[y] || {};
      fert[y][id] = (Number(fert[y][id]) || 0) + amt;
      var r = S().updatePlot ? S().updatePlot(ctx.plot.id, { fert: fert }) : { ok: false };
      if (!r || r.ok === false) { toast('❌ ' + tt('אין הרשאה לעדכן את החלקה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      var f = findPlot(ctx.plot.id); if (f) { ctx.plot = f.plot; ctx.fert = fertRows(f.plot); }
      toast('✅ ' + tt('נרשם', 'บันทึกแล้ว', 'سُجّل')); render(); return;
    }
    if (k === 'impread') return readImport();
    if (k === 'impcancel') { ui.imp = null; refreshBody(); return; }
    if (k === 'impapply') return applyImport();
  }

  function ensureCss() {
    if (document.getElementById('prCss')) return;
    var st = document.createElement('style');
    st.id = 'prCss';
    st.textContent =
      '.pr{max-width:560px !important;width:100%;padding:0 !important;background:var(--bg,#f3f6ef) !important;overflow:hidden;}' +
      '.pr-hero{background:var(--grad-primary,#1d5a2c);color:#fff;padding:16px 16px 14px;border-radius:0 0 22px 22px;}' +
      '.pr-top{display:flex;gap:10px;align-items:center;}.pr-ib{width:44px;height:44px;border-radius:14px;border:0;background:rgba(255,255,255,.16);color:#fff;font-size:1rem;cursor:pointer;flex:none;}' +
      '.pr-tt{flex:1;min-width:0;}.pr-name{font-size:1.25rem;font-weight:800;}.pr-sub{font-size:.78rem;opacity:.85;}' +
      '.pr-pill{background:var(--lime,#c9e86a);color:var(--lime-ink,#1d3a12);font-weight:700;font-size:.72rem;border-radius:99px;padding:4px 10px;white-space:nowrap;}' +
      '.pr-kpis{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:12px;}.pr-kpis>div{background:rgba(255,255,255,.13);border-radius:14px;padding:8px 10px;}' +
      '.pr-kpis small{display:block;font-size:.66rem;opacity:.85;}.pr-kpis b{font-size:1.1rem;font-weight:800;}' +
      '.pr-tabs{display:flex;gap:6px;padding:12px 14px 4px;overflow-x:auto;}.pr-tab{min-height:40px;padding:0 15px;border-radius:99px;border:1.5px solid var(--line,#d9e2d3);background:var(--card,#fff);color:var(--primary,#1d5a2c);font:inherit;font-weight:600;font-size:.84rem;cursor:pointer;white-space:nowrap;}' +
      '.pr-tab.on{background:var(--primary,#1d5a2c);color:#fff;border-color:transparent;}' +
      '.pr-body{padding:8px 14px 20px;display:flex;flex-direction:column;gap:12px;max-height:calc(100dvh - 250px);overflow-y:auto;}' +
      '.pr-card{background:var(--card,#fff);border-radius:20px;padding:14px;display:flex;flex-direction:column;gap:10px;box-shadow:0 1px 3px rgba(20,40,20,.08);}' +
      '.pr-ch{display:flex;align-items:center;gap:8px;}.pr-ch b{flex:1;font-size:1rem;}.pr-ico{font-size:1.1rem;}' +
      '.pr-badge{font-size:.68rem;font-weight:700;border-radius:99px;padding:3px 9px;background:var(--tonal,#eef3ea);color:var(--text-muted,#4a5a4e);white-space:nowrap;}.pr-badge.ok{background:#e3f2e1;color:#1f6a3a;}.pr-badge.warn{background:#fff4e5;color:#7a4100;}.pr-badge.bad{background:#fde9e7;color:#8c1d18;}' +
      '.pr-g2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;}.pr-big{background:#eaf4fb;border-radius:16px;padding:10px 12px;}.pr-big small{font-size:.72rem;color:#2b5d7e;}.pr-big b{display:block;font-size:1.55rem;font-weight:800;color:#12466a;}.pr-big i{font-style:normal;font-size:.78rem;font-weight:600;}' +
      '.pr-mut{font-size:.78rem;color:var(--text-muted,#4a5a4e);line-height:1.5;}.pr-src{font-size:.68rem;color:var(--text-muted,#6b786e);}' +
      '.pr-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}.pr-btn{min-height:40px;padding:0 13px;border-radius:12px;border:0;background:var(--tonal,#eef3ea);color:var(--primary,#1d5a2c);font:inherit;font-weight:600;font-size:.8rem;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;}' +
      '.pr-btn.pri{background:var(--primary,#1d5a2c);color:#fff;}.pr-btn.ghost{background:transparent;}.pr-btn.wide{justify-content:center;width:100%;min-height:44px;}.pr-btn[disabled]{opacity:.6;}' +
      '.pr-bars{display:flex;align-items:flex-end;gap:8px;height:170px;border-bottom:1.5px solid var(--line,#e4ece0);padding:0 2px;}' +
      '.pr-bc{flex:1;min-width:0;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:3px;border:0;background:transparent;cursor:pointer;padding:0;font:inherit;border-radius:10px;}.pr-bc.on{background:var(--tonal,#f1f5ec);}' +
      '.pr-bp{font-size:.66rem;font-weight:700;color:var(--text-muted,#4a5a4e);}.pr-bb{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;gap:3px;max-height:118px;}' +
      '.pr-bb i{display:block;width:12px;border-radius:6px 6px 0 0;min-height:2px;}.pr-bb i.rec{background:#d5e8b0;}.pr-bb i.app{background:#4f8a1b;}.pr-bb i.low{background:#d9822b;}' +
      '.pr-bl{font-size:.64rem;color:var(--text-muted,#4a5a4e);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;height:16px;}' +
      '.pr-leg{display:flex;gap:12px;flex-wrap:wrap;font-size:.72rem;color:var(--text-muted,#4a5a4e);}.pr-leg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-inline-end:4px;vertical-align:-1px;}' +
      '.pr-sel{border-top:1px dashed var(--line,#e4ece0);padding-top:8px;display:flex;flex-direction:column;gap:6px;font-size:.84rem;}' +
      '.pr-mbars{display:flex;gap:3px;align-items:flex-end;height:70px;direction:ltr;}.pr-mbars span{flex:1;height:100%;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;}.pr-mbars i{display:block;width:70%;background:#4f8a1b;border-radius:4px 4px 0 0;min-height:1px;}.pr-mbars span.cur i{background:#2f8fd0;}.pr-mbars small{font-size:.55rem;color:var(--text-muted,#6b786e);}' +
      '.pr-add{width:110px !important;margin:0 !important;}.pr-date{width:auto !important;margin:0 !important;}' +
      '.pr-warn{background:#fff4e5;color:#7a4100;border-radius:12px;padding:8px 10px;font-size:.8rem;}' +
      '.pr-ttl{display:flex;align-items:center;justify-content:space-between;}.pr-ttl b{font-size:1rem;}' +
      '.pr-days{display:flex;gap:5px;}.pr-days span{flex:1;text-align:center;padding:6px 0;border-radius:12px;background:var(--card,#fff);position:relative;}.pr-days span.on{background:var(--primary,#1d5a2c);color:#fff;}' +
      '.pr-days small{display:block;font-size:.62rem;opacity:.75;}.pr-days b{font-size:.9rem;}.pr-days i{position:absolute;top:4px;inset-inline-end:6px;width:6px;height:6px;border-radius:50%;background:#d9822b;}' +
      '.pr-task{background:var(--card,#fff);border-radius:18px;padding:12px;display:flex;flex-direction:column;gap:6px;box-shadow:0 1px 3px rgba(20,40,20,.08);}.pr-task.done{opacity:.7;}' +
      '.pr-th{display:flex;align-items:center;gap:8px;}.pr-th i{width:9px;height:9px;border-radius:50%;flex:none;}.pr-th b{flex:1;font-size:.9rem;}' +
      '.pr-form label,.pr-lbl{display:flex;flex-direction:column;gap:3px;font-size:.74rem;color:var(--text-muted,#6b786e);}.pr-form .form-input,.pr-lbl .form-input{margin:0 !important;}' +
      '.pr-empty{padding:16px;text-align:center;color:var(--text-muted,#6b786e);font-size:.84rem;}' +
      '.pr-chips{display:flex;flex-wrap:wrap;gap:6px;}.pr-chips span{font-size:.72rem;background:var(--tonal,#eef3ea);border-radius:99px;padding:5px 10px;}.pr-chips span.b{background:#eaf4fb;}.pr-chips span.o{background:#fff4e5;}' +
      '.pr-wrap{overflow-x:auto;border:1px solid var(--line,#e4ece0);border-radius:12px;}.pr-tbl{width:100%;border-collapse:collapse;font-size:.78rem;}.pr-tbl th{background:var(--tonal,#eef3ea);padding:6px;text-align:start;font-weight:700;white-space:nowrap;}' +
      '.pr-tbl td{padding:5px 6px;border-top:1px solid var(--line,#eef1ec);}.pr-tbl td.pr-mut{font-size:.66rem;line-height:1.3;}.pr-tbl td.n{text-align:center;font-variant-numeric:tabular-nums;}.pr-tbl tr.cur td{background:var(--primary-soft,#eef7d4);font-weight:700;}' +
      '.pr-tbl .form-input{margin:0 !important;padding:4px 6px !important;font-size:.78rem !important;min-width:64px;height:auto !important;}' +
      '.pr-guide{display:flex;flex-direction:column;align-items:flex-start;gap:3px;text-align:start;border:0;background:var(--tonal,#f3f6ef);border-radius:14px;padding:10px 12px;font:inherit;cursor:pointer;}.pr-guide small{font-size:.7rem;color:var(--text-muted,#6b786e);}' +
      '.pr-srow{display:flex;gap:10px;align-items:center;background:var(--card,#fff);border-radius:16px;padding:10px 12px;}.pr-srow>div{flex:1;min-width:0;}.pr-srow small{display:block;font-size:.72rem;color:var(--text-muted,#6b786e);}' +
      '.pr-si{width:40px;height:40px;border-radius:12px;background:var(--tonal,#eef3ea);display:flex;align-items:center;justify-content:center;flex:none;}.pr-si.b{background:#eaf4fb;}.pr-si.o{background:#e3f2e1;}' +
      '.pr-note{background:#fffbea;border-radius:14px;padding:10px 12px;font-size:.74rem;color:#5c4a00;line-height:1.6;}' +
      '.pr-chk{display:flex;gap:8px;align-items:flex-start;font-size:.84rem;}.pr-chk small{display:block;color:var(--text-muted,#6b786e);}.pr-chk input{width:20px;height:20px;flex:none;}' +
      '.pr-open-btn{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;min-height:46px;margin:0 0 14px;border-radius:14px;border:0;background:var(--grad-primary,#1d5a2c);color:#fff;font:inherit;font-weight:700;font-size:.92rem;cursor:pointer;}';
    document.head.appendChild(st);
  }

  document.addEventListener('shorashim:lang', function () { if (document.getElementById('prRoot') && ctx) render(); });

  return { open: open, close: close, _irr: irrCalc };
})();
window.PlotRec = PlotRec;
