/* fleet.js — vehicles per משק: register, expiries, loans, monthly report (Oct 2026)
 *
 * One table per farm of every vehicle, agricultural or not: name, licence
 * plate, compulsory (חובה) and comprehensive (מקיף) insurance expiry, annual
 * test (טסט), safety inspection where one is required (tractors, forklifts,
 * lifting gear), owner, and where the vehicle is right now. Expiries turn
 * orange 30 days ahead and red once passed.
 *
 * A vehicle can be loaned to another farm (ניוד) and returned. Each loan is
 * logged on both farms, and the monthly report counts how many days each
 * vehicle spent at another farm in a month — calendar days and work days
 * (Sunday–Friday) — the way the monthly hours report counts a worker's days.
 *
 * Data lives on the farm (plotMapperSprayData): farm.vehicles[] (home farm),
 * v.loan while out, farm.vehicle_loans[] on both sides. All writes go
 * through SprayStore (app.js), which checks the user's farm permissions.
 *
 * Public: Fleet.sectionHtml(farmId), Fleet.bind(farmId), Fleet.open(farmId),
 *         Fleet.report()
 */
var Fleet = (function () {
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
  function today() { return new Date().toISOString().slice(0, 10); }
  function day(d) { try { return d ? new Date(d + 'T00:00:00').toLocaleDateString('he-IL') : ''; } catch (e) { return d || ''; } }

  var KINDS = [
    ['tractor', '🚜', 'טרקטור', 'รถแทรกเตอร์', 'جرار'],
    ['atv', '🛻', 'טרקטורון / רכב שטח', 'ATV', 'مركبة صحراوية'],
    ['truck', '🚛', 'משאית', 'รถบรรทุก', 'شاحنة'],
    ['pickup', '🛻', 'טנדר', 'รถกระบะ', 'بيك أب'],
    ['car', '🚗', 'רכב פרטי / מסחרי', 'รถยนต์', 'سيارة'],
    ['forklift', '🏗️', 'מלגזה', 'รถยก', 'رافعة شوكية'],
    ['lift', '🪜', 'במה / כלי הרמה', 'เครื่องยก', 'رافعة'],
    ['sprayer', '💨', 'מרסס מתנייע', 'รถพ่นยา', 'رشاش ذاتي'],
    ['trailer', '🔗', 'עגלה / נגרר', 'รถพ่วง', 'مقطورة'],
    ['other', '🔧', 'אחר', 'อื่นๆ', 'أخرى']
  ];
  function kindOf(v) { return KINDS.find(function (k) { return k[0] === v; }) || KINDS[KINDS.length - 1]; }
  function kindLabel(v) { var k = kindOf(v); return k[1] + ' ' + tt(k[2], k[3], k[4]); }
  // Safety inspection is required by default for these kinds.
  var SAFETY_KINDS = { tractor: 1, forklift: 1, lift: 1, sprayer: 1 };

  // Older records had one insurance date and one safety date.
  function fields(v) {
    return {
      mandatory: v.ins_mandatory || v.insurance_expiry || '',
      comprehensive: v.ins_comprehensive || '',
      test: v.test_expiry || '',
      safety: v.safety_expiry || '',
      needsSafety: v.safety_required != null ? !!v.safety_required : !!SAFETY_KINDS[v.kind] || !!v.safety_expiry
    };
  }
  function status(d) {
    if (!d) return { cls: 'none', txt: '—' };
    var days = Math.floor((new Date(d + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000);
    if (days < 0) return { cls: 'bad', txt: day(d), title: tt('פג תוקף', 'หมดอายุ', 'منتهي') };
    if (days <= 30) return { cls: 'warn', txt: day(d), title: days + ' ' + tt('ימים', 'วัน', 'أيام') };
    return { cls: 'ok', txt: day(d) };
  }
  function cell(d, needed, label) {
    var dl = ' data-l="' + esc(label || '') + '"';
    if (needed === false) return '<td class="fl-na"' + dl + '>' + tt('לא נדרש', 'ไม่จำเป็น', 'غير مطلوب') + '</td>';
    var s = status(d);
    return '<td class="fl-d ' + s.cls + '"' + dl + (s.title ? ' title="' + esc(s.title) + '"' : '') + '>' + esc(s.txt) + '</td>';
  }
  function alerts(v) {
    var f = fields(v), n = 0;
    [f.mandatory, f.comprehensive, f.test, f.needsSafety ? f.safety : ''].forEach(function (d) {
      if (!d) return; var c = status(d).cls; if (c === 'bad' || c === 'warn') n++;
    });
    return n;
  }

  function ensureCss() {
    if (document.getElementById('flCss')) return;
    var st = document.createElement('style');
    st.id = 'flCss';
    st.textContent =
      '.fl-wrap{overflow:auto;margin:6px 0 4px;border:1px solid var(--line,#dbe3d8);border-radius:12px;}' +
      '.fl-tbl{width:100%;border-collapse:collapse;font-size:.78rem;min-width:640px;}' +
      '.fl-tbl th{background:var(--g6,#eef2ee);color:var(--text-muted,#555);font-weight:600;font-size:.7rem;text-align:right;padding:7px 6px;white-space:nowrap;}' +
      '.fl-tbl td{padding:7px 6px;border-top:1px solid var(--line,#e5e9e4);white-space:nowrap;vertical-align:middle;}' +
      '.fl-tbl td.fl-n{white-space:normal;min-width:110px;font-weight:600;}' +
      '.fl-tbl td.fl-n small{display:block;font-weight:400;color:var(--text-muted,#777);font-size:.7rem;}' +
      '.fl-tbl .plate{direction:ltr;unicode-bidi:isolate;font-family:ui-monospace,monospace;background:#fff6c7;border:1px solid #d8c24a;border-radius:4px;padding:1px 5px;font-size:.74rem;}' +
      '.fl-d.ok{color:var(--primary,#2d6a4f);}' +
      '.fl-d.warn{color:#9a5b00;font-weight:700;background:#fff4e0;}' +
      '.fl-d.bad{color:#b3261e;font-weight:700;background:#fdecea;}' +
      '.fl-d.none,.fl-na{color:var(--text-muted,#999);}' +
      '.fl-loan{display:inline-block;background:#e8f0fe;color:#1a56b0;border-radius:99px;padding:2px 8px;font-size:.7rem;font-weight:600;}' +
      '.fl-home{color:var(--text-muted,#777);font-size:.72rem;}' +
      '.fl-act{border:0;background:var(--g6,#eef2ee);border-radius:8px;padding:4px 8px;cursor:pointer;font:inherit;font-size:.74rem;margin-inline-start:3px;}' +
      '.fl-bar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;}' +
      '.fl-btn{border:0;border-radius:99px;padding:8px 14px;background:var(--primary,#2d6a4f);color:#fff;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.fl-btn.ghost{background:transparent;color:var(--primary,#2d6a4f);border:1px solid var(--line,#dbe3d8);}' +
      '.fl-sub{font-size:.78rem;font-weight:700;color:var(--text-muted,#667);margin:12px 2px 4px;}' +
      '.fl-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
      '.fl-grid .form-group{margin:0;}' +
      '.fl-grid .full{grid-column:1/-1;}' +
      '.fl-rep td,.fl-rep th{text-align:right;}' +
      '.fl-tot td{font-weight:700;background:var(--primary-soft,#e2efe7);}' +
      // Phone: each vehicle becomes a card, every value labelled.
      '@media (max-width:640px){' +
        '.fl-tbl.fl-cards{min-width:0;}.fl-cards thead{display:none;}' +
        '.fl-cards tr{display:grid;grid-template-columns:1fr 1fr;gap:4px 10px;padding:10px;border-top:1px solid var(--line,#e5e9e4);}' +
        '.fl-cards td{border:0;padding:2px 0;white-space:normal;background:transparent !important;}' +
        '.fl-cards td.fl-n{grid-column:1/-1;font-size:.9rem;}' +
        '.fl-cards td[data-l]::before{content:attr(data-l);display:block;font-size:.66rem;color:var(--text-muted,#888);font-weight:400;}' +
        '.fl-cards td.fl-d.warn,.fl-cards td.fl-d.bad{border-radius:6px;padding:2px 6px;}' +
        '.fl-cards td.fl-d.warn{background:#fff4e0 !important;}.fl-cards td.fl-d.bad{background:#fdecea !important;}' +
        '.fl-cards td.fl-where,.fl-cards td.fl-acts{grid-column:1/-1;}' +
      '}';
    document.head.appendChild(st);
  }

  // ── table ──
  function tableHtml(farmId, data, compact) {
    var can = S().canEditFarm && S().canEditFarm(farmId);
    var rows = data.own.map(function (v) { return rowHtml(farmId, v, false, can, compact); }).join('') +
      data.inbound.map(function (v) { return rowHtml(farmId, v, true, can, compact); }).join('');
    if (!rows) return '<div class="fi-off">' + tt('אין כלי רכב רשומים למשק.', 'ยังไม่มียานพาหนะ', 'لا مركبات مسجلة') + '</div>';
    return '<div class="fl-wrap"><table class="fl-tbl fl-cards"><thead><tr>' +
      '<th>' + tt('כלי', 'ยานพาหนะ', 'المركبة') + '</th><th>' + tt('מס׳ רישוי', 'ทะเบียน', 'رقم الترخيص') + '</th>' +
      '<th>' + tt('ביטוח חובה', 'ประกันภาคบังคับ', 'تأمين إلزامي') + '</th><th>' + tt('ביטוח מקיף', 'ประกันชั้นหนึ่ง', 'تأمين شامل') + '</th>' +
      '<th>' + tt('טסט', 'ตรวจสภาพ', 'الفحص السنوي') + '</th><th>' + tt('בדיקת בטיחות / תסקיר', 'ตรวจความปลอดภัย', 'فحص السلامة') + '</th>' +
      '<th>' + tt('בעלים', 'เจ้าของ', 'المالك') + '</th><th>' + tt('מיקום / ניוד', 'ที่อยู่ / ย้าย', 'الموقع / نقل') + '</th>' +
      (compact ? '' : '<th></th>') + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }
  function rowHtml(farmId, v, inbound, can, compact) {
    var f = fields(v);
    var where = inbound
      ? '<span class="fl-loan">↙️ ' + tt('שאול מ', 'ยืมจาก', 'معار من') + '-' + esc(v.homeName) + '</span><div class="fl-home">' + tt('מאז', 'ตั้งแต่', 'منذ') + ' ' + day(v.loan.start) + '</div>'
      : (v.loan ? '<span class="fl-loan">↗️ ' + tt('בניוד אל', 'อยู่ที่', 'معار إلى') + ' ' + esc(v.loan.toName) + '</span><div class="fl-home">' + tt('מאז', 'ตั้งแต่', 'منذ') + ' ' + day(v.loan.start) + '</div>'
        : '<span class="fl-home">' + tt('במשק', 'ที่ฟาร์ม', 'في المزرعة') + '</span>');
    var acts = '';
    if (!compact && can) {
      if (!inbound) acts += '<button class="fl-act" data-fl-edit="' + v.id + '">✏️</button>';
      if (v.loan) acts += '<button class="fl-act" data-fl-ret="' + v.id + '" data-fl-home="' + v.home + '">↩️ ' + tt('החזר', 'คืน', 'إرجاع') + '</button>';
      else if (!inbound) acts += '<button class="fl-act" data-fl-loan="' + v.id + '">🔁 ' + tt('נייד', 'ย้าย', 'نقل') + '</button>';
    }
    return '<tr>' +
      '<td class="fl-n">' + esc(v.name || '') + '<small>' + kindLabel(v.kind) + '</small></td>' +
      '<td data-l="' + esc(tt('מס׳ רישוי', 'ทะเบียน', 'رقم الترخيص')) + '">' + (v.plate ? '<span class="plate">' + esc(v.plate) + '</span>' : '—') + '</td>' +
      cell(f.mandatory, undefined, tt('ביטוח חובה', 'ประกันภาคบังคับ', 'تأمين إلزامي')) +
      cell(f.comprehensive, undefined, tt('ביטוח מקיף', 'ประกันชั้นหนึ่ง', 'تأمين شامل')) +
      cell(f.test, undefined, tt('טסט', 'ตรวจสภาพ', 'الفحص السنوي')) +
      cell(f.safety, f.needsSafety ? undefined : false, tt('בדיקת בטיחות', 'ตรวจความปลอดภัย', 'فحص السلامة')) +
      '<td data-l="' + esc(tt('בעלים', 'เจ้าของ', 'المالك')) + '">' + esc(v.owner || '—') + '</td><td class="fl-where" data-l="' + esc(tt('מיקום', 'ที่อยู่', 'الموقع')) + '">' + where + '</td>' +
      (compact ? '' : '<td class="fl-acts">' + acts + '</td>') + '</tr>';
  }

  // ── farm detail section ──
  function sectionHtml(farmId) {
    if (!S().getVehicles) return '';
    ensureCss();
    var data = S().getVehicles(farmId);
    var n = data.own.length + data.inbound.length;
    var warn = data.own.concat(data.inbound).reduce(function (a, v) { return a + alerts(v); }, 0);
    var can = S().canEditFarm && S().canEditFarm(farmId);
    if (!n && !can) return '';
    return '<div class="section-title" style="margin-top: 14px;">🚛 ' + tt('כלי רכב', 'ยานพาหนะ', 'المركبات') +
        (warn ? ' <span class="fl-loan" style="background:#fdecea;color:#b3261e;">⚠️ ' + warn + '</span>' : '') + '</div>' +
      (n ? tableHtml(farmId, data, true) : '') +
      '<div class="fl-bar"><button type="button" class="fl-btn ghost" id="flOpen">📋 ' +
        (can ? tt('ניהול כלי רכב וניוד', 'จัดการยานพาหนะ', 'إدارة المركبات') : tt('טבלה מלאה', 'ตารางเต็ม', 'الجدول الكامل')) + '</button></div>';
  }
  function bind(farmId) {
    var b = document.getElementById('flOpen');
    if (b) b.addEventListener('click', function () { open(farmId); });
  }

  // ── full screen ──
  function modal(inner, wide) {
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay" id="flOverlay"><div class="modal" style="max-width:' + (wide ? 980 : 560) + 'px;">' + inner + '</div></div>';
    return c;
  }
  function back(farmId) {
    if (typeof window.showFarmDetailsGlobal === 'function') window.showFarmDetailsGlobal(farmId);
    else document.getElementById('modalContainer').innerHTML = '';
  }

  function open(farmId) {
    ensureCss();
    var data = S().getVehicles(farmId);
    var can = S().canEditFarm(farmId);
    modal('<h2>🚛 ' + tt('כלי רכב', 'ยานพาหนะ', 'المركبات') + ' — ' + esc(data.farmName) + '</h2>' +
      '<p style="margin:0 0 6px;">' + tt('כל כלי הרכב של המשק, חקלאיים ואחרים. תאריך כתום — פג בתוך 30 יום; אדום — פג.',
        'ยานพาหนะทั้งหมดของฟาร์ม', 'كل مركبات المزرعة') + '</p>' +
      tableHtml(farmId, data, false) +
      '<div class="fl-bar">' +
        (can ? '<button class="fl-btn" id="flAdd">➕ ' + tt('הוסף כלי', 'เพิ่มยานพาหนะ', 'إضافة مركبة') + '</button>' : '') +
        '<button class="fl-btn ghost" id="flRep">📊 ' + tt('דוח ניוד חודשי', 'รายงานการย้ายรายเดือน', 'تقرير النقل الشهري') + '</button>' +
      '</div>' +
      '<div class="modal-buttons"><button class="btn btn-secondary" id="flBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>', true);
    document.getElementById('flBack').addEventListener('click', function () { back(farmId); });
    var add = document.getElementById('flAdd');
    if (add) add.addEventListener('click', function () { edit(farmId, null); });
    document.getElementById('flRep').addEventListener('click', function () { report(farmId); });
    document.querySelectorAll('[data-fl-edit]').forEach(function (b) {
      b.addEventListener('click', function () { edit(farmId, Number(b.getAttribute('data-fl-edit'))); });
    });
    document.querySelectorAll('[data-fl-loan]').forEach(function (b) {
      b.addEventListener('click', function () { loan(farmId, Number(b.getAttribute('data-fl-loan'))); });
    });
    document.querySelectorAll('[data-fl-ret]').forEach(function (b) {
      b.addEventListener('click', function () { giveBack(farmId, Number(b.getAttribute('data-fl-home')), Number(b.getAttribute('data-fl-ret'))); });
    });
  }

  function edit(farmId, vid) {
    var data = S().getVehicles(farmId);
    var v = vid ? data.own.find(function (x) { return x.id === vid; }) : null;
    var isNew = !v;
    v = v || { kind: 'tractor' };
    var f = fields(v);
    function inp(id, label, val, type, cls) {
      return '<div class="form-group' + (cls ? ' ' + cls : '') + '"><label class="form-label">' + label + '</label>' +
        '<input class="form-input" id="' + id + '" type="' + (type || 'text') + '" value="' + esc(val || '') + '"' + (id === 'flPlate' ? ' dir="ltr"' : '') + '></div>';
    }
    modal('<h2>' + (isNew ? '➕ ' + tt('כלי חדש', 'ยานพาหนะใหม่', 'مركبة جديدة') : '✏️ ' + esc(v.name)) + '</h2>' +
      '<div class="fl-grid">' +
        inp('flName', tt('שם / תיאור', 'ชื่อ', 'الاسم'), v.name, 'text', 'full') +
        '<div class="form-group"><label class="form-label">' + tt('סוג', 'ประเภท', 'النوع') + '</label><select class="form-input" id="flKind">' +
          KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (v.kind === k[0] ? ' selected' : '') + '>' + k[1] + ' ' + esc(tt(k[2], k[3], k[4])) + '</option>'; }).join('') + '</select></div>' +
        inp('flPlate', tt('מספר רישוי', 'ทะเบียน', 'رقم الترخيص'), v.plate) +
        inp('flOwner', tt('בעלים', 'เจ้าของ', 'المالك'), v.owner) +
        inp('flYear', tt('שנת ייצור', 'ปีผลิต', 'سنة الصنع'), v.year, 'number') +
        inp('flMand', tt('ביטוח חובה — בתוקף עד', 'ประกันภาคบังคับ ถึง', 'تأمين إلزامي حتى'), f.mandatory, 'date') +
        inp('flComp', tt('ביטוח מקיף — בתוקף עד', 'ประกันชั้นหนึ่ง ถึง', 'تأمين شامل حتى'), f.comprehensive, 'date') +
        inp('flTest', tt('טסט (רישיון רכב) — עד', 'ตรวจสภาพ ถึง', 'الفحص حتى'), f.test, 'date') +
        '<div class="form-group"><label class="form-label"><input type="checkbox" id="flNeedSafety"' + (f.needsSafety ? ' checked' : '') + '> ' +
          tt('נדרשת בדיקת בטיחות', 'ต้องตรวจความปลอดภัย', 'يتطلب فحص سلامة') + '</label>' +
          '<input class="form-input" id="flSafety" type="date" value="' + esc(f.safety) + '"></div>' +
        inp('flNotes', tt('הערות', 'หมายเหตุ', 'ملاحظات'), v.notes, 'text', 'full') +
      '</div>' +
      '<div class="modal-buttons"><button class="btn btn-primary" id="flSave">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
        (isNew ? '' : '<button class="btn btn-secondary" id="flDel" style="background:var(--danger-light);color:var(--danger);">🗑️</button>') +
        '<button class="btn btn-secondary" id="flCancel">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>');
    document.getElementById('flKind').addEventListener('change', function () {
      document.getElementById('flNeedSafety').checked = !!SAFETY_KINDS[this.value];
    });
    document.getElementById('flCancel').addEventListener('click', function () { open(farmId); });
    var del = document.getElementById('flDel');
    if (del) del.addEventListener('click', function () {
      if (!confirm(tt('למחוק את הכלי', 'ลบ', 'حذف') + ' "' + v.name + '"?')) return;
      var r = S().deleteVehicle(farmId, v.id);
      if (r && r.err === 'on-loan') { toast('⚠️ ' + tt('הכלי בניוד — החזר אותו קודם', 'อยู่ระหว่างยืม', 'المركبة معارة')); return; }
      open(farmId);
    });
    document.getElementById('flSave').addEventListener('click', function () {
      function val(id) { return (document.getElementById(id) || {}).value || ''; }
      var name = val('flName').trim();
      if (!name) { toast('⚠️ ' + tt('חסר שם', 'ขาดชื่อ', 'الاسم مطلوب')); return; }
      var out = {
        id: v.id || Date.now(), name: name, kind: val('flKind'), plate: val('flPlate').trim(), owner: val('flOwner').trim(),
        year: parseInt(val('flYear'), 10) || null,
        ins_mandatory: val('flMand') || '', ins_comprehensive: val('flComp') || '', test_expiry: val('flTest') || '',
        safety_required: document.getElementById('flNeedSafety').checked, safety_expiry: val('flSafety') || '',
        insurance_expiry: val('flMand') || '', notes: val('flNotes').trim()
      };
      var r = S().saveVehicle(farmId, out);
      if (!r || !r.ok) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'حُفظ'));
      open(farmId);
    });
  }

  function loan(farmId, vid) {
    var data = S().getVehicles(farmId);
    var v = data.own.find(function (x) { return x.id === vid; });
    var targets = S().transferTargets(farmId);
    if (!v) return;
    if (!targets.length) { toast('⚠️ ' + tt('אין משק אחר שיש לך הרשאה אליו', 'ไม่มีฟาร์มอื่น', 'لا مزرعة أخرى')); return; }
    modal('<h2>🔁 ' + tt('ניוד', 'ย้าย', 'نقل') + ' — ' + esc(v.name) + (v.plate ? ' <span class="plate" style="font-size:.8rem;">' + esc(v.plate) + '</span>' : '') + '</h2>' +
      '<div class="form-group"><label class="form-label">' + tt('אל משק', 'ไปยังฟาร์ม', 'إلى مزرعة') + '</label><select class="form-input" id="flTo">' +
        targets.map(function (t) { return '<option value="' + t.id + '">' + esc(t.name) + '</option>'; }).join('') + '</select></div>' +
      '<div class="form-group"><label class="form-label">' + tt('מתאריך', 'ตั้งแต่', 'من تاريخ') + '</label><input class="form-input" type="date" id="flStart" value="' + today() + '"></div>' +
      '<div class="form-group"><label class="form-label">' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</label><input class="form-input" id="flNote"></div>' +
      '<div class="modal-buttons"><button class="btn btn-primary" id="flGo">🔁 ' + tt('נייד', 'ย้าย', 'نقل') + '</button>' +
      '<button class="btn btn-secondary" id="flCancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div>');
    document.getElementById('flCancel').addEventListener('click', function () { open(farmId); });
    document.getElementById('flGo').addEventListener('click', function () {
      var to = Number(document.getElementById('flTo').value);
      var r = S().loanVehicle(farmId, vid, to, { start: document.getElementById('flStart').value || today(), note: document.getElementById('flNote').value.trim() });
      if (!r || !r.ok) { toast('⛔ ' + (r && r.err === 'already' ? tt('הכלי כבר בניוד', 'ยืมอยู่แล้ว', 'معارة بالفعل') : tt('אין הרשאה לניוד בין המשקים האלה', 'ไม่มีสิทธิ์', 'لا صلاحية'))); return; }
      toast('✅ ' + v.name + ' → ' + r.loan.toName);
      open(farmId);
    });
  }

  function giveBack(farmId, homeId, vid) {
    modal('<h2>↩️ ' + tt('החזרת כלי', 'คืนยานพาหนะ', 'إرجاع المركبة') + '</h2>' +
      '<div class="form-group"><label class="form-label">' + tt('תאריך החזרה (היום האחרון במשק השואל)', 'วันที่คืน', 'تاريخ الإرجاع') + '</label>' +
        '<input class="form-input" type="date" id="flEnd" value="' + today() + '"></div>' +
      '<div class="modal-buttons"><button class="btn btn-primary" id="flGo">↩️ ' + tt('החזר', 'คืน', 'إرجاع') + '</button>' +
      '<button class="btn btn-secondary" id="flCancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div>');
    document.getElementById('flCancel').addEventListener('click', function () { open(farmId); });
    document.getElementById('flGo').addEventListener('click', function () {
      var r = S().returnVehicle(homeId, vid, document.getElementById('flEnd').value || today());
      if (!r || !r.ok) { toast('⛔ ' + tt('לא ניתן להחזיר', 'คืนไม่ได้', 'تعذر الإرجاع')); return; }
      toast('✅ ' + tt('הכלי הוחזר', 'คืนแล้ว', 'أُرجعت'));
      open(farmId);
    });
  }

  // ── monthly report ──
  // Days a vehicle spent at another farm in the month: the overlap of each
  // loan [start, end or today] with the month. Calendar days and work days
  // (Sunday–Friday; Saturday is the rest day).
  function overlap(l, y, m) {
    var ms = new Date(y, m, 1), me = new Date(y, m + 1, 0);
    var s = new Date(l.start + 'T00:00:00'), e = new Date((l.end || today()) + 'T00:00:00');
    if (e < ms || s > me) return null;
    var a = s > ms ? s : ms, b = e < me ? e : me;
    var cal = 0, work = 0;
    for (var d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) { cal++; if (d.getDay() !== 6) work++; }
    function iso(x) { return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); }
    return { from: iso(a), to: iso(b), cal: cal, work: work, open: !l.end };
  }
  var MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  var rep = { y: new Date().getFullYear(), m: new Date().getMonth(), farm: null, all: false };

  function reportRows() {
    var loans = S().getVehicleLoans ? S().getVehicleLoans() : [];
    var rows = [];
    loans.forEach(function (l) {
      if (rep.farm && l.from !== rep.farm && l.to !== rep.farm) return;
      var o = overlap(l, rep.y, rep.m);
      if (o) rows.push({ l: l, o: o });
    });
    rows.sort(function (a, b) { return String(a.l.vname).localeCompare(String(b.l.vname), 'he') || a.o.from.localeCompare(b.o.from); });
    return rows;
  }

  function report(farmId) {
    ensureCss();
    rep.farm = (farmId && !rep.all) ? farmId : null;
    var rows = reportRows();
    var byV = {};
    rows.forEach(function (r) { var k = r.l.vid; (byV[k] = byV[k] || { name: r.l.vname, plate: r.l.plate, cal: 0, work: 0 }); byV[k].cal += r.o.cal; byV[k].work += r.o.work; });
    var tbl = rows.length ? '<div class="fl-wrap"><table class="fl-tbl fl-rep"><thead><tr><th>' + tt('כלי', 'ยานพาหนะ', 'المركبة') + '</th><th>' + tt('מס׳ רישוי', 'ทะเบียน', 'الترخيص') + '</th>' +
      '<th>' + tt('ממשק', 'จากฟาร์ม', 'من') + '</th><th>' + tt('אל משק', 'ไปฟาร์ม', 'إلى') + '</th><th>' + tt('תקופה בחודש', 'ช่วง', 'الفترة') + '</th>' +
      '<th>' + tt('ימים', 'วัน', 'أيام') + '</th><th>' + tt('ימי עבודה', 'วันทำงาน', 'أيام عمل') + '</th><th>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</th></tr></thead><tbody>' +
      rows.map(function (r) {
        return '<tr><td class="fl-n">' + esc(r.l.vname) + '</td><td>' + (r.l.plate ? '<span class="plate">' + esc(r.l.plate) + '</span>' : '—') + '</td>' +
          '<td>' + esc(r.l.fromName) + '</td><td>' + esc(r.l.toName) + '</td>' +
          '<td>' + day(r.o.from) + ' – ' + day(r.o.to) + (r.o.open ? ' <span class="fl-loan">' + tt('עדיין בניוד', 'ยังยืมอยู่', 'ما زالت معارة') + '</span>' : '') + '</td>' +
          '<td>' + r.o.cal + '</td><td><b>' + r.o.work + '</b></td><td>' + esc(r.l.note || '') + '</td></tr>';
      }).join('') +
      Object.keys(byV).map(function (k) {
        var t = byV[k];
        return '<tr class="fl-tot"><td colspan="5">' + tt('סה"כ', 'รวม', 'المجموع') + ' — ' + esc(t.name) + (t.plate ? ' (' + esc(t.plate) + ')' : '') + '</td><td>' + t.cal + '</td><td>' + t.work + '</td><td></td></tr>';
      }).join('') + '</tbody></table></div>'
      : '<div class="fi-off" style="padding:14px;">' + tt('לא היו ניודים בחודש הזה.', 'ไม่มีการย้ายในเดือนนี้', 'لا عمليات نقل هذا الشهر') + '</div>';
    var title = tt('דוח ניוד כלים', 'รายงานการย้ายยานพาหนะ', 'تقرير نقل المركبات') + ' — ' + MONTHS[rep.m] + ' ' + rep.y;
    modal('<h2>📊 ' + title + '</h2>' +
      '<div class="fl-bar"><button class="fl-btn ghost" id="flPrev">→</button>' +
        '<span style="align-self:center;font-weight:700;">' + MONTHS[rep.m] + ' ' + rep.y + '</span>' +
        '<button class="fl-btn ghost" id="flNext">←</button>' +
        (farmId ? '<label style="align-self:center;font-size:.8rem;"><input type="checkbox" id="flAll"' + (rep.all ? ' checked' : '') + '> ' + tt('כל המשקים', 'ทุกฟาร์ม', 'كل المزارع') + '</label>' : '') +
        (rows.length ? '<button class="fl-btn ghost" id="flPrint">🖨️ ' + tt('הדפס / PDF', 'พิมพ์', 'طباعة') + '</button>' : '') + '</div>' +
      tbl +
      '<p style="font-size:.74rem;color:var(--text-muted,#777);">' + tt('ימי עבודה = ימים בניוד ללא שבת. ניוד שעדיין פתוח נספר עד היום.', 'วันทำงานไม่รวมวันเสาร์', 'أيام العمل دون السبت') + '</p>' +
      '<div class="modal-buttons"><button class="btn btn-secondary" id="flBack">' + tt('חזור', 'กลับ', 'رجوع') + '</button></div>', true);
    function shift(d) { rep.m += d; if (rep.m < 0) { rep.m = 11; rep.y--; } if (rep.m > 11) { rep.m = 0; rep.y++; } report(farmId); }
    document.getElementById('flPrev').addEventListener('click', function () { shift(-1); });
    document.getElementById('flNext').addEventListener('click', function () { shift(1); });
    var all = document.getElementById('flAll');
    if (all) all.addEventListener('change', function () { rep.all = this.checked; report(farmId); });
    document.getElementById('flBack').addEventListener('click', function () { if (farmId) open(farmId); else document.getElementById('modalContainer').innerHTML = ''; });
    var pr = document.getElementById('flPrint');
    if (pr) pr.addEventListener('click', function () {
      var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>' + esc(title) + '</title><style>' +
        'body{font-family:Rubik,Arial,sans-serif;margin:16px;color:#222;}h1{font-size:1.2rem;color:#0c3b30;}' +
        'table{width:100%;border-collapse:collapse;font-size:.8rem;}th{background:#e1eee8;text-align:right;padding:6px;}td{padding:6px;border-bottom:1px solid #ddd;text-align:right;}' +
        '.plate{direction:ltr;unicode-bidi:isolate;font-family:monospace;background:#fff6c7;border:1px solid #d8c24a;border-radius:3px;padding:0 4px;}.fl-tot td{font-weight:700;background:#eef6f1;}.fl-loan{font-size:.7rem;color:#1a56b0;}' +
        '</style></head><body><h1>' + esc(title) + '</h1>' + tbl.replace('fl-wrap', '') + '</body></html>';
      if (window.Util && Util.exportReport) Util.exportReport(html, 'vehicle-loans-' + rep.y + '-' + (rep.m + 1) + '.html');
    });
  }

  return { sectionHtml: sectionHtml, bind: bind, open: open, report: report, _overlap: overlap };
})();
window.Fleet = Fleet;
