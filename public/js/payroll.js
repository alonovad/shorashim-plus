// ── PAYROLL / CONTRACT SETTINGS MODULE ──
// The "הגדרות שכר ומשרות" screen: work contracts (הגדרת משרה), per-employee
// wage data (נתוני שכר), and the editable אירוע type list used by the
// monthly and cross-sectional hours reports.
//
// Storage: a single admin-owned document, appData/shorashim-payroll, saved
// through DB.save like every other config blob in this app. No new
// collection, one entry to whitelist in firestore.rules.
//
// Everything here is ADDITIVE and falls back to the values monthly-report.js
// used to hardcode. An install that never opens this screen behaves exactly
// as it did before.
//
// ⚠ The wage figures this module feeds into the reports are a MANAGEMENT
// ESTIMATE — hours × rate with OT multipliers. They are not a payslip and
// do not model pension, health, national insurance, tax, sick-pay accrual
// or convalescence. Payroll of record stays with the accountant.

var Payroll = (function() {
  'use strict';

  var KEY = 'shorashim-payroll';

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  // ── Defaults ──
  // DEFAULT_CONTRACT mirrors the constant monthly-report.js shipped with, so
  // switching to configurable contracts changes no existing number.
  var DEFAULT_CONTRACT = {
    id: 'default',
    name: 'משרה מלאה א-ה גלובאלי',
    breakMin: 45,
    stdRegular: 504,          // 08:24
    stdShort: 420,            // 07:00 — short day
    restDow: [6],             // Saturday
    shortDow: [5],            // Friday
    weeklyCapRegular: 2520,   // 42h at 100%
    tier125Min: 120,          // next 2h at 125%
    tier150Min: 120           // then 150% onward
  };

  var DEFAULT_EVENTS = [
    { v: 'work',      he: 'עבודה',       th: 'ทำงาน',        ar: 'عمل',                 paid: true },
    { v: 'vacation',  he: 'חופשה',       th: 'ลาพักร้อน',    ar: 'إجازة',               paid: true },
    { v: 'sick',      he: 'מחלה',        th: 'ลาป่วย',       ar: 'مرض',                 paid: true },
    { v: 'reserve',   he: 'מילואים',     th: 'กำลังสำรอง',   ar: 'احتياط',              paid: true },
    { v: 'holiday',   he: 'חג',          th: 'วันหยุด',      ar: 'عيد',                 paid: true },
    { v: 'absence',   he: 'היעדרות',     th: 'ขาดงาน',       ar: 'غياب',                paid: false },
    { v: 'unpaid',    he: 'חל"ת',        th: 'ลาไม่รับเงิน',  ar: 'إجازة بدون راتب',     paid: false },
    { v: 'accident',  he: 'תאונת עבודה', th: 'อุบัติเหตุงาน', ar: 'إصابة عمل',           paid: true },
    { v: 'personal',  he: 'יום בחירה',   th: 'วันเลือก',     ar: 'يوم اختياري',         paid: true }
  ];

  // ── State ──
  var data = null;   // { contracts: [], employees: {}, eventTypes: [] }
  var _loaded = false;

  function blank() {
    return {
      contracts: [JSON.parse(JSON.stringify(DEFAULT_CONTRACT))],
      employees: {},
      eventTypes: JSON.parse(JSON.stringify(DEFAULT_EVENTS))
    };
  }

  function normalise(raw) {
    var d = raw && typeof raw === 'object' ? raw : {};
    var out = blank();
    if (Array.isArray(d.contracts) && d.contracts.length) {
      out.contracts = d.contracts.map(function(c) {
        var merged = JSON.parse(JSON.stringify(DEFAULT_CONTRACT));
        Object.keys(c || {}).forEach(function(k) { if (c[k] != null) merged[k] = c[k]; });
        return merged;
      });
    }
    if (d.employees && typeof d.employees === 'object') out.employees = d.employees;
    if (Array.isArray(d.eventTypes) && d.eventTypes.length) out.eventTypes = d.eventTypes;
    return out;
  }

  // Synchronous read of whatever we have. Callers that need it fresh use
  // load(); callers on a render hot path (monthly report row building) use
  // this and get the localStorage-backed copy, which DB.save keeps current.
  function _data() {
    if (!data) {
      var local = null;
      try { local = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { local = null; }
      data = normalise(local);
    }
    return data;
  }

  function load() {
    return new Promise(function(resolve) {
      if (typeof DB === 'undefined') { resolve(_data()); return; }
      DB.loadAsync(KEY).then(function(d) {
        data = normalise(d);
        _loaded = true;
        resolve(data);
      })['catch'](function() { resolve(_data()); });
    });
  }

  function save() {
    if (typeof DB !== 'undefined') DB.save(KEY, data);
    if (typeof Audit !== 'undefined' && Audit && typeof Audit.log === 'function') {
      try {
        Audit.log('edit', 'payroll-settings', KEY, { reason: 'payroll/contract settings updated' });
      } catch (e) { /* best effort */ }
    }
  }

  // ── Public lookups (used by monthly-report.js and hours-report.js) ──

  function getContracts() { return _data().contracts.slice(); }

  function getContractById(id) {
    var cs = _data().contracts;
    for (var i = 0; i < cs.length; i++) if (cs[i].id === id) return cs[i];
    return cs[0] || DEFAULT_CONTRACT;
  }

  // The contract that applies to a worker. Unassigned workers get the first
  // contract in the list, which is the legacy default — so behaviour is
  // unchanged until someone deliberately assigns something else.
  function getContract(username) {
    var emp = _data().employees[username];
    return getContractById(emp && emp.contractId);
  }

  function getEmployee(username) {
    return _data().employees[username] || null;
  }

  function getEventTypes() { return _data().eventTypes.slice(); }

  function eventLabel(v) {
    if (!v) return '—';
    var list = _data().eventTypes;
    for (var i = 0; i < list.length; i++) {
      if (list[i].v === v) return tt(list[i].he, list[i].th, list[i].ar);
    }
    return v;
  }

  function isPaidEvent(v) {
    if (!v) return true;
    var list = _data().eventTypes;
    for (var i = 0; i < list.length; i++) if (list[i].v === v) return list[i].paid !== false;
    return true;
  }

  // Estimated gross pay for one month's tiered minutes. Returns null when the
  // worker has no wage data — the reports then simply omit the money column
  // rather than printing a confident zero.
  function estimatePay(username, tiers) {
    var emp = getEmployee(username);
    if (!emp) return null;
    if (emp.payType === 'global') {
      var monthly = Number(emp.monthlySalary) || 0;
      return monthly > 0 ? { amount: monthly, basis: 'global' } : null;
    }
    var rate = Number(emp.hourlyRate) || 0;
    if (rate <= 0) return null;
    var reg = (tiers.reg || 0) / 60;
    var h125 = (tiers.t125 || 0) / 60;
    var h150 = (tiers.t150 || 0) / 60;
    return {
      amount: (reg * rate) + (h125 * rate * 1.25) + (h150 * rate * 1.5),
      basis: 'hourly'
    };
  }

  function isAdminRole() { return window.currentUser && window.currentUser.role === 'admin'; }

  // ── UI ──

  var view = 'contracts';   // contracts | employees | events

  function show() {
    if (!isAdminRole()) {
      if (typeof showToast === 'function') {
        showToast('⛔ ' + tt('למנהל מערכת בלבד', 'สำหรับผู้ดูแลระบบเท่านั้น', 'للمسؤول فقط'));
      }
      return;
    }
    load().then(function() { view = 'contracts'; render(); });
  }

  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function tab(id, label) {
    var on = (view === id);
    return '<button onclick="Payroll._tab(\'' + id + '\')" style="flex:1;padding:9px 6px;border:none;border-radius:9px;' +
      'font-family:inherit;font-size:0.8rem;font-weight:700;cursor:pointer;' +
      (on ? 'background:var(--g2,#4caf50);color:#fff;' : 'background:var(--g6,#eef3ee);color:var(--g1,#2e7d32);') +
      '">' + label + '</button>';
  }

  function render() {
    var host = document.getElementById('modalContainer');
    if (!host) return;
    var body = (view === 'contracts') ? contractsView()
             : (view === 'employees') ? employeesView()
             : eventsView();

    host.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width:620px;">' +
          '<h2 style="margin-bottom:10px;">💰 ' + tt('שכר ומשרות','ค่าจ้างและตำแหน่ง','الأجور والوظائف') + '</h2>' +
          '<div style="display:flex;gap:6px;margin-bottom:14px;">' +
            tab('contracts', tt('משרות','ตำแหน่ง','الوظائف')) +
            tab('employees', tt('נתוני עובדים','ข้อมูลพนักงาน','بيانات الموظفين')) +
            tab('events',    tt('אירועים','เหตุการณ์','الأحداث')) +
          '</div>' +
          body +
          '<div class="modal-buttons" style="margin-top:14px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
              tt('סגור','ปิด','إغلاق') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ── Contracts (הגדרת משרה) ──

  function num(label, id, val, hint) {
    return '<div style="flex:1;min-width:110px;">' +
      '<label class="form-label" style="font-size:0.7rem;">' + label + '</label>' +
      '<input type="number" class="form-input" id="' + id + '" value="' + esc(val) + '" style="font-size:0.85rem;padding:7px;">' +
      (hint ? '<div style="font-size:0.62rem;color:var(--text-muted,#888);margin-top:2px;">' + hint + '</div>' : '') +
      '</div>';
  }

  function dowChecks(id, selected) {
    var names = ['א','ב','ג','ד','ה','ו','ש'];
    var h = '<div style="display:flex;gap:4px;flex-wrap:wrap;">';
    for (var i = 0; i < 7; i++) {
      var on = (selected || []).indexOf(i) !== -1;
      h += '<label style="display:flex;align-items:center;gap:3px;font-size:0.75rem;background:var(--g6,#eef3ee);padding:4px 7px;border-radius:7px;cursor:pointer;">' +
        '<input type="checkbox" class="' + id + '" value="' + i + '"' + (on ? ' checked' : '') + '>' + names[i] + '</label>';
    }
    return h + '</div>';
  }

  function contractsView() {
    var cs = _data().contracts;
    var h = '<div style="max-height:52vh;overflow-y:auto;">';
    h += '<p style="font-size:0.75rem;color:var(--text-muted,#888);margin-bottom:10px;">' +
      tt('משרה מגדירה תקן יומי, ניכוי הפסקה, ימי מנוחה וסף שעות נוספות.',
         'ตำแหน่งกำหนดมาตรฐานรายวัน การหักพัก วันหยุด และเกณฑ์ OT',
         'الوظيفة تحدد المعيار اليومي وخصم الاستراحة وأيام الراحة وعتبة العمل الإضافي.') + '</p>';

    cs.forEach(function(c, idx) {
      h += '<div style="background:var(--g6,#f5f8f5);border-radius:11px;padding:12px;margin-bottom:10px;">' +
        '<div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">' +
          '<input type="text" class="form-input" id="ctName' + idx + '" value="' + esc(c.name) + '" style="flex:1;font-size:0.88rem;font-weight:700;">' +
          (cs.length > 1 ? '<button onclick="Payroll._delContract(' + idx + ')" style="border:none;background:#f44336;color:#fff;border-radius:8px;padding:7px 10px;cursor:pointer;font-family:inherit;">🗑️</button>' : '') +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
          num(tt('תקן יום רגיל (דק\')','มาตรฐานวันปกติ (นาที)','معيار اليوم العادي (دقيقة)'), 'ctStd' + idx, c.stdRegular, '504 = 08:24') +
          num(tt('תקן יום קצר (דק\')','มาตรฐานวันสั้น (นาที)','معيار اليوم القصير (دقيقة)'), 'ctShort' + idx, c.stdShort, '420 = 07:00') +
          num(tt('ניכוי הפסקה (דק\')','หักพัก (นาที)','خصم استراحة (دقيقة)'), 'ctBreak' + idx, c.breakMin, '') +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">' +
          num(tt('סף שבועי 100% (דק\')','เกณฑ์รายสัปดาห์ 100% (นาที)','العتبة الأسبوعية 100% (دقيقة)'), 'ctCap' + idx, c.weeklyCapRegular, '2520 = 42h') +
          num(tt('מדרגת 125% (דק\')','ขั้น 125% (นาที)','شريحة 125% (دقيقة)'), 'ct125' + idx, c.tier125Min, '') +
          num(tt('מדרגת 150% (דק\')','ขั้น 150% (นาที)','شريحة 150% (دقيقة)'), 'ct150' + idx, c.tier150Min, '') +
        '</div>' +
        '<div style="margin-bottom:6px;"><div style="font-size:0.7rem;color:var(--text-muted,#888);margin-bottom:3px;">' +
          tt('ימי מנוחה','วันหยุด','أيام الراحة') + '</div>' + dowChecks('ctRest' + idx, c.restDow) + '</div>' +
        '<div><div style="font-size:0.7rem;color:var(--text-muted,#888);margin-bottom:3px;">' +
          tt('ימים קצרים','วันสั้น','أيام قصيرة') + '</div>' + dowChecks('ctShortD' + idx, c.shortDow) + '</div>' +
      '</div>';
    });
    h += '</div>';
    h += '<div style="display:flex;gap:8px;margin-top:10px;">' +
      '<button class="btn-admin" onclick="Payroll._addContract()" style="flex:1;">➕ ' + tt('משרה חדשה','ตำแหน่งใหม่','وظيفة جديدة') + '</button>' +
      '<button class="btn-admin" onclick="Payroll._saveContracts()" style="flex:1;background:var(--g2,#4caf50);color:#fff;">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
      '</div>';
    return h;
  }

  function _tab(v) { view = v; render(); }

  function _addContract() {
    var c = JSON.parse(JSON.stringify(DEFAULT_CONTRACT));
    c.id = 'c' + Date.now();
    c.name = tt('משרה חדשה','ตำแหน่งใหม่','وظيفة جديدة');
    _data().contracts.push(c);
    render();
  }

  function _delContract(idx) {
    var cs = _data().contracts;
    if (cs.length <= 1) return;
    var gone = cs[idx];
    if (!confirm(tt('למחוק את המשרה','ลบตำแหน่ง','حذف الوظيفة') + ' "' + gone.name + '"?')) return;
    cs.splice(idx, 1);
    // Re-point anyone who was on it, so nobody ends up contract-less.
    var emps = _data().employees;
    Object.keys(emps).forEach(function(u) {
      if (emps[u] && emps[u].contractId === gone.id) emps[u].contractId = cs[0].id;
    });
    save();
    render();
  }

  function readDow(cls) {
    var out = [];
    document.querySelectorAll('.' + cls).forEach(function(cb) {
      if (cb.checked) out.push(parseInt(cb.value, 10));
    });
    return out;
  }

  function _saveContracts() {
    var cs = _data().contracts;
    for (var i = 0; i < cs.length; i++) {
      var name = (document.getElementById('ctName' + i) || {}).value;
      var std   = parseInt((document.getElementById('ctStd' + i)   || {}).value, 10);
      var short_= parseInt((document.getElementById('ctShort' + i) || {}).value, 10);
      var brk   = parseInt((document.getElementById('ctBreak' + i) || {}).value, 10);
      var cap   = parseInt((document.getElementById('ctCap' + i)   || {}).value, 10);
      var t125  = parseInt((document.getElementById('ct125' + i)   || {}).value, 10);
      var t150  = parseInt((document.getElementById('ct150' + i)   || {}).value, 10);

      if (!name || !String(name).trim()) { toast('⚠️ ' + tt('שם משרה ריק','ชื่อตำแหน่งว่าง','اسم الوظيفة فارغ')); return; }
      if (isNaN(std) || std < 0 || std > 1440)      { toast('⚠️ ' + tt('תקן יום רגיל לא תקין','มาตรฐานวันปกติไม่ถูกต้อง','معيار اليوم العادي غير صحيح')); return; }
      if (isNaN(short_) || short_ < 0 || short_ > 1440) { toast('⚠️ ' + tt('תקן יום קצר לא תקין','มาตรฐานวันสั้นไม่ถูกต้อง','معيار اليوم القصير غير صحيح')); return; }
      if (isNaN(brk) || brk < 0 || brk > 240)       { toast('⚠️ ' + tt('ניכוי הפסקה לא תקין','การหักพักไม่ถูกต้อง','خصم الاستراحة غير صحيح')); return; }
      if (isNaN(cap) || cap < 0)                    { toast('⚠️ ' + tt('סף שבועי לא תקין','เกณฑ์รายสัปดาห์ไม่ถูกต้อง','العتبة الأسبوعية غير صحيحة')); return; }

      cs[i].name = String(name).trim();
      cs[i].stdRegular = std;
      cs[i].stdShort = short_;
      cs[i].breakMin = brk;
      cs[i].weeklyCapRegular = cap;
      cs[i].tier125Min = isNaN(t125) ? 120 : t125;
      cs[i].tier150Min = isNaN(t150) ? 120 : t150;
      cs[i].restDow = readDow('ctRest' + i);
      cs[i].shortDow = readDow('ctShortD' + i);
    }
    save();
    toast('✅ ' + tt('המשרות נשמרו','บันทึกตำแหน่งแล้ว','تم حفظ الوظائف'));
    render();
  }

  // ── Employees (נתוני שכר) ──

  function employeesView() {
    var emps = _data().employees;
    var cs = _data().contracts;
    var users = (typeof window.users !== 'undefined' && window.users) ? window.users : {};
    var names = Object.keys(users).filter(function(u) {
      return users[u] && users[u].role !== 'viewer';
    }).sort(function(a, b) {
      return (users[a].name || a).localeCompare(users[b].name || b, 'he');
    });

    var h = '<p style="font-size:0.72rem;color:var(--text-muted,#888);margin-bottom:8px;">⚠️ ' +
      tt('הסכומים כאן משמשים לאומדן ניהולי בלבד — לא תלוש שכר. חישוב שכר רשמי אצל רואה החשבון.',
         'ตัวเลขนี้เป็นการประมาณการเพื่อการจัดการเท่านั้น ไม่ใช่สลิปเงินเดือน',
         'هذه الأرقام تقدير إداري فقط وليست قسيمة راتب.') + '</p>';

    if (!names.length) {
      return h + '<div style="text-align:center;color:var(--text-muted,#888);padding:20px;">' +
        tt('אין עובדים','ไม่มีพนักงาน','لا يوجد موظفون') + '</div>';
    }

    h += '<div style="max-height:52vh;overflow-y:auto;">';
    names.forEach(function(u, i) {
      var e = emps[u] || {};
      var payType = e.payType || 'hourly';
      h += '<div style="background:var(--g6,#f5f8f5);border-radius:10px;padding:10px;margin-bottom:8px;">' +
        '<div style="font-weight:700;font-size:0.86rem;margin-bottom:7px;">' + esc(users[u].name || u) + '</div>' +
        '<div style="display:flex;gap:7px;flex-wrap:wrap;">' +
          '<div style="flex:2;min-width:130px;">' +
            '<label class="form-label" style="font-size:0.68rem;">' + tt('משרה','ตำแหน่ง','الوظيفة') + '</label>' +
            '<select class="form-input" id="epC' + i + '" style="font-size:0.8rem;padding:6px;">' +
              cs.map(function(c) {
                return '<option value="' + esc(c.id) + '"' + (e.contractId === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
              }).join('') +
            '</select>' +
          '</div>' +
          '<div style="flex:1;min-width:100px;">' +
            '<label class="form-label" style="font-size:0.68rem;">' + tt('סוג שכר','ประเภทค่าจ้าง','نوع الأجر') + '</label>' +
            '<select class="form-input" id="epT' + i + '" style="font-size:0.8rem;padding:6px;">' +
              '<option value="hourly"' + (payType === 'hourly' ? ' selected' : '') + '>' + tt('שעתי','รายชั่วโมง','بالساعة') + '</option>' +
              '<option value="global"' + (payType === 'global' ? ' selected' : '') + '>' + tt('גלובלי','เหมาจ่าย','شامل') + '</option>' +
            '</select>' +
          '</div>' +
          '<div style="flex:1;min-width:95px;">' +
            '<label class="form-label" style="font-size:0.68rem;">' + tt('₪ לשעה','₪ ต่อชม.','₪ للساعة') + '</label>' +
            '<input type="number" class="form-input" id="epR' + i + '" value="' + esc(e.hourlyRate || '') + '" min="0" step="0.5" style="font-size:0.8rem;padding:6px;">' +
          '</div>' +
          '<div style="flex:1;min-width:95px;">' +
            '<label class="form-label" style="font-size:0.68rem;">' + tt('₪ חודשי','₪ รายเดือน','₪ شهري') + '</label>' +
            '<input type="number" class="form-input" id="epM' + i + '" value="' + esc(e.monthlySalary || '') + '" min="0" step="10" style="font-size:0.8rem;padding:6px;">' +
          '</div>' +
        '</div>' +
        '<input type="hidden" id="epU' + i + '" value="' + esc(u) + '">' +
      '</div>';
    });
    h += '</div>';
    h += '<button class="btn-admin" onclick="Payroll._saveEmployees(' + names.length + ')" style="width:100%;margin-top:10px;background:var(--g2,#4caf50);color:#fff;">💾 ' +
      tt('שמור','บันทึก','حفظ') + '</button>';
    return h;
  }

  function _saveEmployees(count) {
    var emps = _data().employees;
    for (var i = 0; i < count; i++) {
      var uEl = document.getElementById('epU' + i);
      if (!uEl) continue;
      var u = uEl.value;
      var rate = parseFloat((document.getElementById('epR' + i) || {}).value);
      var monthly = parseFloat((document.getElementById('epM' + i) || {}).value);
      if (!isNaN(rate) && (rate < 0 || rate > 10000)) { toast('⚠️ ' + tt('תעריף שעתי לא תקין','อัตรารายชั่วโมงไม่ถูกต้อง','الأجر بالساعة غير صحيح')); return; }
      if (!isNaN(monthly) && (monthly < 0 || monthly > 1000000)) { toast('⚠️ ' + tt('שכר חודשי לא תקין','เงินเดือนไม่ถูกต้อง','الراتب الشهري غير صحيح')); return; }
      emps[u] = {
        contractId: (document.getElementById('epC' + i) || {}).value || 'default',
        payType: (document.getElementById('epT' + i) || {}).value || 'hourly',
        hourlyRate: isNaN(rate) ? null : rate,
        monthlySalary: isNaN(monthly) ? null : monthly
      };
    }
    save();
    toast('✅ ' + tt('נתוני העובדים נשמרו','บันทึกข้อมูลพนักงานแล้ว','تم حفظ بيانات الموظفين'));
  }

  // ── Event types (אירועים) ──

  function eventsView() {
    var list = _data().eventTypes;
    var lines = list.map(function(e) {
      return e.he + (e.paid === false ? ' | 0' : '');
    }).join('\n');
    return '<p style="font-size:0.74rem;color:var(--text-muted,#888);margin-bottom:8px;">' +
      tt('אירוע לכל שורה. הוסף " | 0" בסוף שורה כדי לסמן אירוע לא בתשלום.',
         'หนึ่งเหตุการณ์ต่อบรรทัด เติม " | 0" สำหรับวันไม่ได้รับเงิน',
         'حدث في كل سطر. أضف " | 0" لحدث غير مدفوع.') + '</p>' +
      '<textarea id="pyEvents" class="form-input" style="width:100%;height:220px;font-size:0.85rem;line-height:1.6;" dir="rtl">' + esc(lines) + '</textarea>' +
      '<div style="display:flex;gap:8px;margin-top:10px;">' +
        '<button class="btn-admin" onclick="Payroll._resetEvents()" style="flex:1;">↺ ' + tt('ברירת מחדל','ค่าเริ่มต้น','افتراضي') + '</button>' +
        '<button class="btn-admin" onclick="Payroll._saveEvents()" style="flex:1;background:var(--g2,#4caf50);color:#fff;">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
      '</div>';
  }

  function _saveEvents() {
    var raw = (document.getElementById('pyEvents') || {}).value || '';
    var out = [];
    raw.split('\n').forEach(function(line) {
      var paid = true;
      var text = line;
      var bar = line.lastIndexOf('|');
      if (bar !== -1) {
        var flag = line.slice(bar + 1).trim();
        if (flag === '0') { paid = false; text = line.slice(0, bar); }
      }
      text = text.trim();
      if (!text) return;
      // Keep the translations of any event we already know by its Hebrew
      // label, so editing the list doesn't silently wipe Thai/Arabic.
      var prior = null;
      var known = _data().eventTypes.concat(DEFAULT_EVENTS);
      for (var i = 0; i < known.length; i++) { if (known[i].he === text) { prior = known[i]; break; } }
      out.push({
        v: prior ? prior.v : text,
        he: text,
        th: prior ? prior.th : text,
        ar: prior ? prior.ar : text,
        paid: paid
      });
    });
    if (!out.length) { toast('⚠️ ' + tt('הרשימה ריקה','รายการว่าง','القائمة فارغة')); return; }
    _data().eventTypes = out;
    save();
    toast('✅ ' + out.length + ' ' + tt('אירועים נשמרו','เหตุการณ์ถูกบันทึก','أحداث محفوظة'));
    render();
  }

  function _resetEvents() {
    if (!confirm(tt('לשחזר את רשימת ברירת המחדל?','คืนค่ารายการเริ่มต้น?','استعادة القائمة الافتراضية؟'))) return;
    _data().eventTypes = JSON.parse(JSON.stringify(DEFAULT_EVENTS));
    save();
    render();
  }

  function toast(m) { if (typeof showToast === 'function') showToast(m); }

  // Warm the cache early so the first monthly report render already has
  // contracts, rather than falling back to defaults for one paint.
  if (typeof DB !== 'undefined') {
    setTimeout(function() { load(); }, 1200);
  }

  return {
    show: show,
    load: load,
    getContract: getContract,
    getContracts: getContracts,
    getContractById: getContractById,
    getEmployee: getEmployee,
    getEventTypes: getEventTypes,
    eventLabel: eventLabel,
    isPaidEvent: isPaidEvent,
    estimatePay: estimatePay,
    DEFAULT_CONTRACT: DEFAULT_CONTRACT,
    _tab: _tab,
    _addContract: _addContract,
    _delContract: _delContract,
    _saveContracts: _saveContracts,
    _saveEmployees: _saveEmployees,
    _saveEvents: _saveEvents,
    _resetEvents: _resetEvents
  };
})();
