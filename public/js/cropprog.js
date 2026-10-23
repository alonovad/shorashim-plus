/* cropprog.js — growth stages and fertilization / recommendation programmes (Oct 2026)
 *
 * Per crop (מנגו, תמר, ענבים…) a programme: the growth stages that matter for
 * it, each with a default coefficient (בוגר 1, הרכבה 0.3, צעיר 0.55 …), and
 * the recommended items — a fertilizer, a micro-element, a treatment — each
 * with a unit, a rate per dunam or per tree at coefficient 1, and its timing.
 *
 * Per plot: its stage, coefficient (stage default unless set), a
 * characterization / status line (אפיון — "מומלץ להרכב לשלי") and the date of
 * its last update ("הורכב ב-4.25"). The farm table then computes, plot by
 * plot, rate × coefficient × dunams (or trees) for every item, with totals —
 * exactly the mango sheet: ברזל 12 ק״ג/ד׳ × מקדם 0.3 × 5.6 ד׳ = 20 ק״ג.
 *
 * Data: plotMapperSprayData.cropPrograms[crop] and plot.stage / coef /
 * status_note / status_date, written through SprayStore.
 *
 * Public: CropProgram.sectionHtml(farmId), CropProgram.bind(farmId),
 *         CropProgram.open(farmId, crop), CropProgram.editProgram(crop)
 */
var CropProgram = (function () {
  'use strict';

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
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }

  var DEFAULT_STAGES = [
    { v: 'mature', he: 'בוגר / מניב', th: 'โตเต็มที่ / ให้ผล', ar: 'ناضج / مثمر', coef: 1 },
    { v: 'no-yield', he: 'אין יבול השנה', th: 'ไม่มีผลผลิตปีนี้', ar: 'لا محصول هذا العام', coef: 0.7 },
    { v: 'young', he: 'צעיר', th: 'ต้นอ่อน', ar: 'صغير', coef: 0.55 },
    { v: 'grafted', he: 'מורכב / אחרי הרכבה', th: 'ทาบกิ่งแล้ว', ar: 'مطعّم', coef: 0.3 },
    { v: 'planting', he: 'נטיעה חדשה', th: 'ปลูกใหม่', ar: 'زراعة جديدة', coef: 0.3 },
    { v: 'remove', he: 'לעקירה', th: 'รอถอน', ar: 'للقلع', coef: 0 }
  ];
  var UNITS = ['ק"ג', 'ליטר', 'יחידות', 'גרם', 'מ"ק', 'שק'];   // DATA KEY — stored on programme items
  // Stored unit words (DATA KEYs) shown in the current language.
  var UNIT_TR = { 'ק"ג': ['กก.', 'كغ'], 'ליטר': ['ลิตร', 'لتر'], 'יחידות': ['หน่วย', 'وحدات'], 'יחידה': ['หน่วย', 'وحدة'], 'גרם': ['กรัม', 'غرام'],
    'מ"ק': ['ลบ.ม.', 'م³'], 'שק': ['กระสอบ', 'كيس'], 'מטר': ['เมตร', 'متر'], 'טון': ['ตัน', 'طن'] };
  function unitTr(u) { var x = UNIT_TR[u]; return x ? tt(u, x[0], x[1]) : (u || ''); }
  // A stage keeps its Hebrew name as typed; built-in stages also carry th/ar.
  function stName(s) { if (!s) return ''; var d = DEFAULT_STAGES.find(function (x) { return x.v === s.v; }); return tt(s.he, s.th || (d && d.he === s.he ? d.th : ''), s.ar || (d && d.he === s.he ? d.ar : '')); }

  function program(crop) {
    var all = S().getCropPrograms ? S().getCropPrograms() : {};
    var p = all[crop] || {};
    return { stages: (p.stages && p.stages.length) ? p.stages : DEFAULT_STAGES.slice(), items: p.items || [], notes: p.notes || '' };
  }
  function stageOf(prog, v) { return prog.stages.find(function (s) { return s.v === v; }) || null; }
  function coefOf(prog, plot) {
    if (plot.coef != null && plot.coef !== '' && isFinite(Number(plot.coef))) return Number(plot.coef);
    var st = stageOf(prog, plot.stage);
    return st ? Number(st.coef) : 1;
  }
  function amount(item, plot, coef) {
    var base = item.basis === 'tree' ? (Number(plot.tree_count) || 0) : (Number(plot.area) || 0);
    return (Number(item.rate) || 0) * coef * base;
  }

  // ── Fertilization completion ──
  // Applied = what was entered by hand for the season (plot.fert[year][itemId])
  // + what the spray log shows for a product of the same name this season
  // (spray / fertigation records: trees × dose × concentration). Completion is
  // applied ÷ recommended (rate × coefficient × dunams or trees).
  function season() { return String(new Date().getFullYear()); }
  function manualApplied(plot, item) {
    var f = plot.fert && plot.fert[season()];
    return f && f[item.id] != null ? Number(f[item.id]) || 0 : 0;
  }
  function loggedApplied(plot, item) {
    var nm = String(item.name || '').trim();
    if (!nm || !S().getEvents) return 0;
    var y = season(), sum = 0;
    S().getEvents().forEach(function (ev) {
      if (String(ev.date || '').slice(0, 4) !== y || (ev.plotIds || []).indexOf(plot.id) === -1) return;
      (ev.applications || []).forEach(function (a) {
        if (String(a.productName || '').trim() !== nm) return;
        var vol = Number(ev.volumePerTree) || 0, conc = (Number(a.concentration) || 0) / 100, u = ev.volumeUnit || 'l_tree';
        var trees = Number(plot.tree_count) || 0, area = Number(plot.area) || 0;
        var L = u === 'cc_tree' ? trees * vol / 1000 * conc : u === 'l_dunam' ? area * vol * conc : trees * vol * conc;
        sum += L;
      });
    });
    return item.unit === 'גרם' ? sum * 1000 : sum;   // DATA KEY
  }
  function applied(plot, item) { return manualApplied(plot, item) + loggedApplied(plot, item); }
  function pct(a, rec) { return rec > 0 ? Math.round(a / rec * 100) : null; }
  function bar(p) {
    if (p == null) return '';
    var c = p >= 90 ? '#2e7d32' : p >= 50 ? '#e0a100' : '#c62828';
    return '<div class="cp-pb"><i style="width:' + Math.min(100, p) + '%;background:' + c + '"></i></div><span class="cp-pp" style="color:' + c + '">' + p + '%</span>';
  }
  // Farm-level completion for a crop, weighted by recommended amounts.
  function farmCompletion(farmId, crop) {
    var prog = program(crop);
    if (!prog.items.length) return null;
    var rec = 0, app = 0;
    S().getFarmPlots(farmId).filter(function (p) { return p.crop_type === crop; }).forEach(function (p) {
      var c = coefOf(prog, p);
      prog.items.forEach(function (it) {
        var r = amount(it, p, c);
        if (!r) return;
        rec += 1; app += Math.min(1.5, applied(p, it) / r);
      });
    });
    return rec ? Math.round(app / rec * 100) : null;
  }

  function ensureCss() {
    if (!document.getElementById('cpCss2')) {
      var s2 = document.createElement('style'); s2.id = 'cpCss2';
      s2.textContent = '.cp-done{font-size:.68rem;color:var(--text-muted,#666);margin-top:3px;display:flex;gap:4px;align-items:center;}.cp-done .form-input{width:70px;padding:3px 5px;font-size:.72rem;margin:0;}' +
        '.cp-pb{height:5px;border-radius:3px;background:var(--line,#e3e8e1);margin-top:4px;overflow:hidden;}.cp-pb i{display:block;height:100%;}.cp-pp{font-size:.66rem;font-weight:700;}' +
        '.cp-chip-pct{font-size:.7rem;font-weight:700;margin-inline-start:4px;}';
      document.head.appendChild(s2);
    }
    if (document.getElementById('cpCss')) return;
    var st = document.createElement('style');
    st.id = 'cpCss';
    st.textContent =
      '.cp-wrap{overflow:auto;border:1px solid var(--line,#dbe3d8);border-radius:12px;margin:6px 0;}' +
      '.cp-tbl{width:100%;border-collapse:collapse;font-size:.78rem;}' +
      '.cp-tbl th{background:var(--g6,#eef2ee);font-weight:600;font-size:.7rem;color:var(--text-muted,#555);text-align:right;padding:6px;vertical-align:bottom;}' +
      '.cp-tbl th small{display:block;font-weight:400;}' +
      '.cp-tbl td{padding:5px 6px;border-top:1px solid var(--line,#e5e9e4);vertical-align:middle;}' +
      '.cp-tbl td.num{font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.cp-tbl td.amt{background:#f3f8f5;font-weight:600;white-space:nowrap;}' +
      '.cp-tbl tr.tot td{font-weight:700;background:var(--primary-soft,#e2efe7);}' +
      '.cp-tbl .form-input{margin:0;padding:5px 6px;font-size:.78rem;min-width:0;}' +
      '.cp-tbl select.form-input{min-width:110px;}' +
      '.cp-tbl input.cp-coef{width:62px;}' +
      '.cp-tbl input.cp-note{min-width:140px;}' +
      '.cp-tbl input.cp-date{width:120px;}' +
      '.cp-bar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;align-items:center;}' +
      '.cp-btn{border:0;border-radius:99px;padding:8px 14px;background:var(--primary,#2d6a4f);color:#fff;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.cp-btn.ghost{background:transparent;color:var(--primary,#2d6a4f);border:1px solid var(--line,#dbe3d8);}' +
      '.cp-chip{display:inline-block;border:1px solid var(--line,#dbe3d8);border-radius:99px;padding:5px 12px;font-size:.8rem;cursor:pointer;background:var(--card,#fff);margin:0 0 4px 4px;}' +
      '.cp-chip.on{background:var(--primary,#2d6a4f);color:#fff;border-color:transparent;}' +
      '.cp-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px;}' +
      '.cp-row .form-input{margin:0;padding:7px 8px;font-size:.82rem;}' +
      '.cp-sec{font-weight:700;font-size:.84rem;margin:12px 0 6px;}';
    document.head.appendChild(st);
  }

  function farmCrops(farmId) {
    var seen = {}, out = [];
    (S().getFarmPlots(farmId) || []).forEach(function (p) { var c = p.crop_type || ''; if (c && !seen[c]) { seen[c] = 1; out.push(c); } });
    return out;
  }

  // ── farm detail section ──
  function sectionHtml(farmId) {
    if (!S().getFarmPlots) return '';
    ensureCss();
    var crops = farmCrops(farmId);
    if (!crops.length) return '';
    var progs = S().getCropPrograms();
    return '<div class="section-title" style="margin-top: 14px;">🧪 ' + tt('שלבי גידול ותוכניות דישון', 'ระยะการเติบโตและแผนปุ๋ย', 'مراحل النمو وبرامج التسميد') + '</div>' +
      '<div class="cp-bar">' + crops.map(function (c) {
        var p = progs[c];
        return '<button type="button" class="cp-chip" data-cp-crop="' + esc(c) + '">' + esc(c) +
          (p && p.items && p.items.length ? ' · ' + p.items.length + ' ' + tt('פריטים', 'รายการ', 'بنود') : ' · ' + tt('אין תוכנית', 'ไม่มีแผน', 'لا برنامج')) +
          (function () { var fc = farmCompletion(farmId, c); if (fc == null) return ''; var col = fc >= 90 ? '#2e7d32' : fc >= 50 ? '#b07800' : '#c62828';
            return '<span class="cp-chip-pct" style="color:' + col + '" title="' + esc(tt('השלמת דישון העונה', 'ความครบถ้วนของปุ๋ย', 'اكتمال التسميد')) + '">' + fc + '%</span>'; })() + '</button>';
      }).join('') + '</div>';
  }
  function bind(farmId) {
    document.querySelectorAll('[data-cp-crop]').forEach(function (b) {
      b.addEventListener('click', function () { open(farmId, b.getAttribute('data-cp-crop')); });
    });
  }

  function modal(inner, wide) {
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay"><div class="modal" style="max-width:' + (wide ? 1150 : 620) + 'px;">' + inner + '</div></div>';
  }
  function back(farmId) {
    if (farmId && typeof window.showFarmDetailsGlobal === 'function') window.showFarmDetailsGlobal(farmId);
    else document.getElementById('modalContainer').innerHTML = '';
  }

  function tableHtml(farmId, crop, forPrint) {
    var prog = program(crop);
    var plots = S().getFarmPlots(farmId).filter(function (p) { return p.crop_type === crop; })
      .sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'he', { numeric: true }); });
    var can = !forPrint && S().canEditFarm(farmId);
    var tot = prog.items.map(function () { return 0; }), totD = prog.items.map(function () { return 0; }), totA = 0, totT = 0;
    var rows = plots.map(function (p) {
      var c = coefOf(prog, p);
      totA += p.area || 0; totT += p.tree_count || 0;
      var st = stageOf(prog, p.stage);
      var stageCell = can
        ? '<select class="form-input cp-stage" data-p="' + p.id + '"><option value="">—</option>' + prog.stages.map(function (s) {
            return '<option value="' + esc(s.v) + '"' + (s.v === p.stage ? ' selected' : '') + '>' + esc(stName(s)) + ' (' + s.coef + ')</option>'; }).join('') + '</select>'
        : esc(st ? stName(st) : '');
      var coefCell = can
        ? '<input class="form-input cp-coef" data-p="' + p.id + '" type="number" step="0.05" min="0" max="3" value="' + (p.coef != null ? p.coef : '') + '" placeholder="' + c + '">'
        : c;
      var noteCell = can ? '<input class="form-input cp-note" data-p="' + p.id + '" value="' + esc(p.status_note) + '">' : esc(p.status_note);
      var dateCell = can ? '<input class="form-input cp-date" data-p="' + p.id + '" type="date" value="' + esc(p.status_date) + '">' : esc(p.status_date);
      var amts = prog.items.map(function (it, k) {
        var a = amount(it, p, c), done = applied(p, it), man = manualApplied(p, it), logd = done - man;
        tot[k] += a; totD[k] += done;
        return '<td class="amt"><div>' + (a ? r2(a) : '0') + '</div>' +
          (forPrint ? '<div class="cp-done">' + tt('בוצע', 'ทำแล้ว', 'نُفّذ') + ' ' + r2(done) + (a ? ' (' + pct(done, a) + '%)' : '') + '</div>' :
            '<div class="cp-done">' + (can ? '<input class="form-input cp-fert" data-p="' + p.id + '" data-it="' + esc(it.id) + '" type="number" step="any" min="0" value="' + (man || '') + '" placeholder="' + tt('בוצע', 'ทำแล้ว', 'نُفّذ') + '">' : r2(man)) +
            (logd > 0 ? '<small title="' + esc(tt('מתוך יומן הריסוסים', 'จากบันทึก', 'من سجل الرش')) + '">+' + r2(logd) + ' 📋</small>' : '') + '</div>' + bar(pct(done, a))) +
        '</td>';
      }).join('');
      return '<tr><td><b>' + esc(p.name) + '</b></td><td class="num">' + r2(p.area) + '</td><td class="num">' + (p.tree_count || '') + '</td><td>' + esc(p.variety) + '</td>' +
        '<td>' + stageCell + '</td><td class="num">' + coefCell + '</td><td>' + noteCell + '</td><td>' + dateCell + '</td>' + amts + '</tr>';
    }).join('');
    var head = '<tr><th>' + tt('חלקה', 'แปลง', 'القطعة') + '</th><th>' + tt('דונם', 'ไร่', 'دونم') + '</th><th>' + tt('עצים', 'ต้น', 'أشجار') + '</th><th>' + tt('זן', 'พันธุ์', 'الصنف') + '</th>' +
      '<th>' + tt('שלב', 'ระยะ', 'المرحلة') + '</th><th>' + tt('מקדם', 'สัมประสิทธิ์', 'المعامل') + '</th><th>' + tt('אפיון / סטטוס', 'สถานะ', 'الحالة') + '</th><th>' + tt('עדכון', 'อัปเดต', 'تحديث') + '</th>' +
      prog.items.map(function (it) {
        return '<th>' + esc(it.name) + '<small>' + r2(it.rate) + ' ' + esc(unitTr(it.unit)) + '/' + (it.basis === 'tree' ? tt('עץ', 'ต้น', 'شجرة') : tt('ד׳', 'ไร่', 'دونم')) + (it.timing ? ' · ' + esc(it.timing) : '') + '</small></th>';
      }).join('') + '</tr>';
    var totRow = '<tr class="tot"><td>' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td class="num">' + r2(totA) + '</td><td class="num">' + totT.toLocaleString('he-IL') + '</td><td colspan="5"></td>' +
      prog.items.map(function (it, k) { return '<td class="num">' + r2(tot[k]) + ' ' + esc(unitTr(it.unit)) + '<div class="cp-done">' + tt('בוצע', 'ทำแล้ว', 'نُفّذ') + ' ' + r2(totD[k]) + '</div>' + bar(pct(totD[k], tot[k])) + '</td>'; }).join('') + '</tr>';
    return '<div class="cp-wrap"><table class="cp-tbl"><thead>' + head + '</thead><tbody>' + rows + (plots.length ? totRow : '') + '</tbody></table></div>';
  }

  function open(farmId, crop) {
    ensureCss();
    var info = S().getVehicles ? S().getVehicles(farmId) : { farmName: '' };
    var prog = program(crop);
    var isMgr = ['admin', 'operator'].indexOf((window.currentUser || {}).role) !== -1;
    modal('<h2>🧪 ' + esc(crop) + ' — ' + esc(info.farmName) + '</h2>' +
      (prog.items.length ? '' : '<p style="font-size:.82rem;">' + tt('עוד לא הוגדרה תוכנית דישון / המלצות לגידול הזה. אפשר כבר לקבוע שלב ומקדם לכל חלקה.',
        'ยังไม่มีแผนสำหรับพืชนี้', 'لا يوجد برنامج لهذا المحصول بعد') + '</p>') +
      (prog.notes ? '<p style="font-size:.8rem;color:var(--text-muted,#666);">📝 ' + esc(prog.notes) + '</p>' : '') +
      tableHtml(farmId, crop) +
      '<div class="cp-bar">' + (isMgr ? '<button class="cp-btn" id="cpEdit">⚙️ ' + tt('עריכת תוכנית ל', 'แก้ไขแผน', 'تعديل البرنامج') + esc(crop) + '</button>' : '') +
        '<button class="cp-btn ghost" id="cpPrint">🖨️ ' + tt('הדפס / PDF', 'พิมพ์', 'طباعة') + '</button></div>' +
      '<div class="modal-buttons"><button class="btn btn-secondary" id="cpBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>', true);
    document.getElementById('cpBack').addEventListener('click', function () { back(farmId); });
    var e = document.getElementById('cpEdit');
    if (e) e.addEventListener('click', function () { editProgram(crop, function () { open(farmId, crop); }); });
    document.getElementById('cpPrint').addEventListener('click', function () {
      var title = tt('תוכנית', 'แผน', 'برنامج') + ' ' + crop + ' — ' + info.farmName;
      var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
        'body{font-family:Rubik,Arial,sans-serif;margin:14px;color:#222;}h1{font-size:1.15rem;color:#0c3b30;}' +
        'table{width:100%;border-collapse:collapse;font-size:.74rem;}th{background:#e1eee8;text-align:right;padding:5px;vertical-align:bottom;}th small{display:block;font-weight:400;}' +
        'td{padding:5px;border-bottom:1px solid #ddd;}td.amt{background:#f3f8f5;font-weight:600;}tr.tot td{font-weight:700;background:#eef6f1;}' +
        '@page{size:A4 landscape;margin:10mm;}</style></head><body><h1>' + esc(title) + '</h1>' + tableHtml(farmId, crop, true) +
        (prog.notes ? '<p>' + esc(prog.notes) + '</p>' : '') + '</body></html>';
      if (window.Util && Util.exportReport) Util.exportReport(html, 'program-' + farmId + '.html');
    });
    // Inline edits save at once and repaint the amounts.
    var sheet = document.querySelector('.cp-tbl');
    if (sheet) sheet.addEventListener('change', function (ev) {
      var t = ev.target, pid = Number(t.getAttribute('data-p'));
      if (!pid) return;
      var patch = {};
      if (t.classList.contains('cp-stage')) { patch.stage = t.value; patch.coef = null; }
      else if (t.classList.contains('cp-coef')) patch.coef = t.value === '' ? null : Number(t.value);
      else if (t.classList.contains('cp-note')) patch.status_note = t.value.trim().slice(0, 200);
      else if (t.classList.contains('cp-date')) patch.status_date = t.value;
      else if (t.classList.contains('cp-fert')) {
        var cur = (S().getFarmPlots(farmId).find(function (x) { return x.id === pid; }) || {}).fert || {};
        var y = season(); cur[y] = cur[y] || {};
        var v = Number(t.value); if (v > 0) cur[y][t.getAttribute('data-it')] = v; else delete cur[y][t.getAttribute('data-it')];
        patch.fert = cur;
      }
      else return;
      var r = S().updatePlot(pid, patch);
      if (!r || !r.ok) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      var y = document.querySelector('.modal').scrollTop;
      open(farmId, crop);
      document.querySelector('.modal').scrollTop = y;
    });
  }

  // ── programme editor ──
  function editProgram(crop, done) {
    ensureCss();
    var prog = program(crop);
    function stageRow(s, i) {
      return '<div class="cp-row cp-st" data-i="' + i + '"><input class="form-input cp-st-he" value="' + esc(s.he || '') + '" placeholder="' + esc(tt('שם השלב', 'ชื่อระยะ', 'اسم المرحلة')) + '" style="flex:2 1 160px;">' +
        '<input class="form-input cp-st-coef" type="number" step="0.05" min="0" max="3" value="' + (s.coef != null ? s.coef : 1) + '" style="width:80px;" title="' + esc(tt('מקדם', 'สัมประสิทธิ์', 'المعامل')) + '">' +
        '<button type="button" class="btn-icon delete" onclick="this.parentNode.remove()">✕</button></div>';
    }
    function itemRow(it, i) {
      return '<div class="cp-row cp-it" data-i="' + i + '">' +
        '<input class="form-input cp-it-name" value="' + esc(it.name || '') + '" placeholder="' + esc(tt('פריט (למשל ברזל, דשן 4-2-8, אבץ)', 'รายการ', 'البند')) + '" style="flex:2 1 170px;">' +
        '<input class="form-input cp-it-rate" type="number" step="any" min="0" value="' + (it.rate != null ? it.rate : '') + '" placeholder="' + esc(tt('כמות', 'จำนวน', 'الكمية')) + '" style="width:80px;">' +
        '<select class="form-input cp-it-unit">' + UNITS.map(function (u) { return '<option value="' + esc(u) + '"' + (u === it.unit ? ' selected' : '') + '>' + esc(unitTr(u)) + '</option>'; }).join('') + '</select>' +
        '<select class="form-input cp-it-basis"><option value="dunam"' + (it.basis !== 'tree' ? ' selected' : '') + '>' + tt('לדונם', 'ต่อไร่', 'لكل دونم') + '</option><option value="tree"' + (it.basis === 'tree' ? ' selected' : '') + '>' + tt('לעץ', 'ต่อต้น', 'لكل شجرة') + '</option></select>' +
        '<input class="form-input cp-it-timing" value="' + esc(it.timing || '') + '" placeholder="' + esc(tt('מועד / שלב (למשל אביב, אחרי חנטה)', 'ช่วงเวลา', 'التوقيت')) + '" style="flex:1 1 150px;">' +
        '<button type="button" class="btn-icon delete" onclick="this.parentNode.remove()">✕</button></div>';
    }
    modal('<h2>⚙️ ' + tt('תוכנית לגידול', 'แผนสำหรับพืช', 'برنامج المحصول') + ': ' + esc(crop) + '</h2>' +
      '<div class="cp-sec">' + tt('שלבי גידול ומקדם ברירת מחדל', 'ระยะและสัมประสิทธิ์', 'المراحل والمعامل') + '</div>' +
      '<div id="cpStages">' + prog.stages.map(stageRow).join('') + '</div>' +
      '<button type="button" class="cp-btn ghost" id="cpAddStage">➕ ' + tt('שלב', 'ระยะ', 'مرحلة') + '</button>' +
      '<div class="cp-sec">' + tt('המלצות / דישון — כמות במקדם 1', 'คำแนะนำ / ปุ๋ย', 'التوصيات / التسميد') + '</div>' +
      '<div id="cpItems">' + prog.items.map(itemRow).join('') + '</div>' +
      '<button type="button" class="cp-btn ghost" id="cpAddItem">➕ ' + tt('פריט', 'รายการ', 'بند') + '</button>' +
      '<div class="form-group" style="margin-top:10px;"><label class="form-label">' + tt('הערות לתוכנית', 'หมายเหตุ', 'ملاحظات') + '</label>' +
        '<textarea class="form-input" id="cpNotes" rows="2">' + esc(prog.notes) + '</textarea></div>' +
      '<div class="modal-buttons"><button class="btn btn-primary" id="cpSave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="btn btn-secondary" id="cpCancel">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>');
    document.getElementById('cpAddStage').addEventListener('click', function () {
      var d = document.createElement('div'); d.innerHTML = stageRow({ coef: 1 }, -1); document.getElementById('cpStages').appendChild(d.firstChild);
    });
    document.getElementById('cpAddItem').addEventListener('click', function () {
      var d = document.createElement('div'); d.innerHTML = itemRow({ unit: UNITS[0], basis: 'dunam' }, -1); document.getElementById('cpItems').appendChild(d.firstChild);
    });
    document.getElementById('cpCancel').addEventListener('click', function () { done ? done() : back(null); });
    document.getElementById('cpSave').addEventListener('click', function () {
      var stages = [], items = [];
      document.querySelectorAll('#cpStages .cp-st').forEach(function (r, k) {
        var he = r.querySelector('.cp-st-he').value.trim(); if (!he) return;
        var i = Number(r.getAttribute('data-i')), prev = i >= 0 ? prog.stages[i] : null;
        stages.push({ v: prev ? prev.v : 'st_' + Date.now().toString(36) + k, he: he, coef: Number(r.querySelector('.cp-st-coef').value) || 0 });
      });
      document.querySelectorAll('#cpItems .cp-it').forEach(function (r, k) {
        var name = r.querySelector('.cp-it-name').value.trim(); if (!name) return;
        var i = Number(r.getAttribute('data-i')), prev = i >= 0 ? prog.items[i] : null;
        items.push({ id: prev ? prev.id : Date.now() + k, name: name, rate: Number(r.querySelector('.cp-it-rate').value) || 0,
          unit: r.querySelector('.cp-it-unit').value, basis: r.querySelector('.cp-it-basis').value, timing: r.querySelector('.cp-it-timing').value.trim() });
      });
      var res = S().setCropProgram(crop, { stages: stages, items: items, notes: document.getElementById('cpNotes').value.trim() });
      if (!res || !res.ok) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      toast('✅ ' + tt('התוכנית נשמרה', 'บันทึกแผนแล้ว', 'حُفظ البرنامج'));
      done ? done() : back(null);
    });
  }

  return { sectionHtml: sectionHtml, bind: bind, open: open, editProgram: editProgram, _coefOf: coefOf, _amount: amount };
})();
window.CropProgram = CropProgram;
