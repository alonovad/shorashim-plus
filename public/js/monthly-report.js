// ── MONTHLY REPORT MODULE ──
// The admin/manager monthly attendance table ("דוח חודשי").
// Reads the live `timeclock` collection (read-only) + Leave holiday map.
// Computes תקן / חוסר-עודף / OT from a work contract using the same engine
// as the approved prototype. Renders into #modalContainer like sibling views.
//
// Depends (all optional/defensive): db (Firestore), window.currentUser,
// window.users, Leave.loadHolidayMap, TimeClock.editRecord,
// formatDate/formatTime/formatDuration, showToast, currentLang.

var MonthlyReport = (function() {
  'use strict';

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  // ── CONTRACT (mirrors "משרה מלאה א-ה גלובאלי") ──
  // TODO Phase 2: move to an editable per-employee contract in Firestore (contracts.js).
  var CONTRACT = {
    name: 'משרה מלאה א-ה גלובאלי',
    breakMin: 45,
    stdRegular: 504,        // 08:24
    stdShort: 420,          // 07:00 (Friday short day)
    restDow: [6],           // Saturday = weekly rest
    shortDow: [5],          // Friday = short standard
    weeklyCapRegular: 2520, // 42h @ 100%
    weeklyTiers: [
      { min: 120, rate: 125 },
      { min: 120, rate: 150 },
      { min: Infinity, rate: 150 }
    ]
  };

  var DOW = ['א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ש'];
  var MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  var state = { username: null, name: '', lang: 'he', year: 0, month: 0, records: [], holidays: {}, events: {}, open: null };

  // ── אירוע (attendance-event) options for the dropdown ──
  var EVENTS = [
    { v: '',          he: '—',            th: '—',              ar: '—' },
    { v: 'vacation',  he: 'חופשה',        th: 'ลาพักร้อน',       ar: 'إجازة' },
    { v: 'sick',      he: 'מחלה',         th: 'ลาป่วย',          ar: 'مرض' },
    { v: 'reserve',   he: 'מילואים',      th: 'กำลังสำรอง',      ar: 'احتياط' },
    { v: 'holiday',   he: 'חג',           th: 'วันหยุด',         ar: 'عيد' },
    { v: 'absence',   he: 'היעדרות',      th: 'ขาดงาน',          ar: 'غياب' },
    { v: 'unpaid',    he: 'חל"ת',         th: 'ลาไม่รับเงิน',     ar: 'إجازة بدون راتب' },
    { v: 'accident',  he: 'תאונת עבודה',  th: 'อุบัติเหตุงาน',    ar: 'إصابة عمل' },
    { v: 'personal',  he: 'יום בחירה',    th: 'วันเลือก',        ar: 'يوم اختياري' }
  ];
  function eventLabel(v) { for (var i = 0; i < EVENTS.length; i++) { if (EVENTS[i].v === v) return tt(EVENTS[i].he, EVENTS[i].th, EVENTS[i].ar); } return v || '—'; }

  // ── time helpers ──
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(min) {
    var s = min < 0 ? '−' : '';
    min = Math.abs(Math.round(min));
    return s + pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  }
  function recMin(r) {
    if (r.duration) return Math.round(r.duration / 60000);
    if (r.punchIn && r.punchOut) return Math.round((r.punchOut - r.punchIn) / 60000);
    return 0;
  }
  function localTime(ts) {
    if (!ts) return '—';
    var d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function dateKey(ts) { return new Date(ts).toLocaleDateString('en-CA'); } // YYYY-MM-DD local

  // ── pay engine (pure) ──
  function dayType(dateObj, holiday) {
    if (holiday) return 'event';
    if (CONTRACT.restDow.indexOf(dateObj.getDay()) !== -1) return 'rest';
    if (CONTRACT.shortDow.indexOf(dateObj.getDay()) !== -1) return 'fri';
    return 'reg';
  }
  function standardFor(type) {
    if (type === 'reg') return CONTRACT.stdRegular;
    if (type === 'fri') return CONTRACT.stdShort;
    return 0;
  }
  function dayDelta(grossMin, type) {
    var brk = grossMin > 0 ? CONTRACT.breakMin : 0;
    var net = Math.max(0, grossMin - brk);
    return net - standardFor(type);
  }
  function monthlyOT(rows) {
    var byWeek = {};
    rows.forEach(function(r) {
      if (r.netMin <= 0) return;
      var d = r.dateObj, sun = new Date(d); sun.setDate(d.getDate() - d.getDay());
      var k = sun.toLocaleDateString('en-CA');
      byWeek[k] = (byWeek[k] || 0) + r.netMin;
    });
    var reg = 0, t125 = 0, t150 = 0;
    Object.keys(byWeek).forEach(function(k) {
      var rem = byWeek[k];
      var r = Math.min(rem, CONTRACT.weeklyCapRegular); reg += r; rem -= r;
      for (var i = 0; i < CONTRACT.weeklyTiers.length && rem > 0; i++) {
        var take = Math.min(rem, CONTRACT.weeklyTiers[i].min); rem -= take;
        if (CONTRACT.weeklyTiers[i].rate === 125) t125 += take; else t150 += take;
      }
    });
    return { reg: reg, t125: t125, t150: t150 };
  }

  // ── employee list (managers pick; workers see only themselves) ──
  function isManager() {
    return window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'operator');
  }
  function employeeList() {
    var list = [];
    if (isManager() && typeof window.users !== 'undefined' && window.users) {
      Object.keys(window.users).forEach(function(k) {
        var u = window.users[k];
        if (!u || u.role === 'viewer') return;
        list.push({ username: k, name: u.name || k, lang: u.lang || 'he' });
      });
      list.sort(function(a, b) { return a.name.localeCompare(b.name, 'he'); });
    }
    if (list.length === 0 && window.currentUser) {
      list.push({ username: window.currentUser.username, name: window.currentUser.name || window.currentUser.username, lang: window.currentUser.lang || 'he' });
    }
    return list;
  }

  // ── open / load ──
  function show() {
    var now = new Date();
    var emps = employeeList();
    var me = window.currentUser ? window.currentUser.username : (emps[0] && emps[0].username);
    var pick = isManager() ? emps[0] : (emps.filter(function(e){return e.username===me;})[0] || emps[0]);
    state.username = pick ? pick.username : me;
    state.name = pick ? pick.name : '';
    state.lang = pick ? pick.lang : 'he';
    state.year = now.getFullYear();
    state.month = now.getMonth();
    state.open = null;
    renderShell(emps);
    load();
  }

  function renderShell(emps) {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    var empSel = '';
    if (isManager() && emps.length > 1) {
      empSel = '<select id="mrEmp" onchange="MonthlyReport._pickEmp(this.value)" style="font-family:inherit;font-weight:700;font-size:0.9rem;padding:6px 8px;border-radius:8px;border:1px solid #ddd;">' +
        emps.map(function(e){ return '<option value="'+e.username+'"'+(e.username===state.username?' selected':'')+'>'+e.name+'</option>'; }).join('') +
        '</select>';
    } else {
      empSel = '<span style="font-weight:700;font-size:0.95rem;">' + state.name + '</span>';
    }

    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:18px;width:96%;max-width:780px;max-height:90vh;overflow-y:auto;">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px;">' +
          '<h3 style="font-weight:700;margin:0;">📅 ' + tt('דוח חודשי','รายงานรายเดือน','التقرير الشهري') + '</h3>' +
          empSel +
          '<span style="background:#e3f4ee;color:#0f8a6e;font-size:0.7rem;font-weight:700;padding:3px 9px;border-radius:999px;">' + CONTRACT.name + '</span>' +
          '<span style="margin-inline-start:auto;display:flex;align-items:center;gap:6px;">' +
            '<button onclick="MonthlyReport._nav(-1)" style="border:1px solid #ddd;background:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-family:inherit;">›</button>' +
            '<span id="mrMonth" style="font-weight:700;min-width:120px;text-align:center;"></span>' +
            '<button onclick="MonthlyReport._nav(1)" style="border:1px solid #ddd;background:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-family:inherit;">‹</button>' +
          '</span>' +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:0.66rem;color:#999;margin-bottom:8px;align-items:center;">' +
          '<span><span style="background:#e6f5ec;color:#1d7a4d;padding:2px 8px;border-radius:999px;font-weight:700;">' + tt('עודף','เกิน','فائض') + '</span></span>' +
          '<span><span style="background:#fdeceb;color:#c0392b;padding:2px 8px;border-radius:999px;font-weight:700;">' + tt('חוסר','ขาด','نقص') + '</span></span>' +
          '<span style="color:#2f74c0;font-weight:700;">m</span> ' + tt('עריכת מנהל','แก้ไขโดยผู้จัดการ','تعديل المدير') +
          '<span class="mr-restlabel" style="color:#b8761a;font-weight:700;">▮ ' + tt('מנוחה שבועית','วันหยุดประจำสัปดาห์','راحة أسبوعية') + '</span>' +
        '</div>' +
        '<div style="overflow-x:auto;border:1px solid #eee;border-radius:10px;"><div id="mrBody"></div></div>' +
        '<div id="mrStats" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;"></div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;">' +
          '<button onclick="MonthlyReport._exportCSV()" style="flex:1;padding:10px;border-radius:10px;border:1px solid #ddd;background:#f1f8e9;font-family:inherit;font-weight:700;cursor:pointer;">📥 ' + tt('ייצוא CSV','ส่งออก CSV','تصدير CSV') + '</button>' +
          '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור','ปิด','إغلاق') + '</button>' +
        '</div>' +
      '</div></div>';
    updateMonthLabel();
  }

  function updateMonthLabel() {
    var el = document.getElementById('mrMonth');
    if (el) el.textContent = MONTHS[state.month] + ' ' + state.year;
  }

  function load() {
    var body = document.getElementById('mrBody');
    if (body) body.innerHTML = '<div style="text-align:center;color:#999;padding:24px;">' + tt('טוען...','กำลังโหลด...','جاري التحميل...') + '</div>';
    var jobs = [];

    // 1) timeclock records — reuse existing (username + punchIn) index, filter month client-side
    if (typeof db !== 'undefined' && state.username) {
      jobs.push(
        db.collection('timeclock')
          .where('username', '==', state.username)
          .orderBy('punchIn', 'desc')
          .limit(300)
          .get()
          .then(function(snap) {
            var recs = [];
            snap.forEach(function(doc) { recs.push(Object.assign({ _id: doc.id }, doc.data())); });
            state.records = recs;
          })
          .catch(function(err) { console.warn('MonthlyReport records load failed:', err); state.records = []; })
      );
    } else { state.records = []; }

    // 1b) attendance events (אירוע) for this worker — keyed by date
    if (typeof db !== 'undefined' && state.username) {
      jobs.push(
        db.collection('attendance-events')
          .where('username', '==', state.username)
          .get()
          .then(function(snap) {
            var ev = {};
            snap.forEach(function(doc) { var e = doc.data(); if (e && e.date) ev[e.date] = e.event || ''; });
            state.events = ev;
          })
          .catch(function() { state.events = {}; })
      );
    } else { state.events = {}; }

    // 2) holiday map for this worker's language
    if (typeof Leave !== 'undefined' && Leave.loadHolidayMap) {
      jobs.push(
        Leave.loadHolidayMap(state.year, state.lang)
          .then(function(map) { state.holidays = map || {}; })
          .catch(function() { state.holidays = {}; })
      );
    } else { state.holidays = {}; }

    Promise.all(jobs).then(render);
  }

  // ── build month rows (pre-draws every day incl. future) ──
  function buildRows() {
    var rows = [];
    var days = new Date(state.year, state.month + 1, 0).getDate();
    // group records by local date string
    var byDate = {};
    state.records.forEach(function(r) {
      if (!r.punchIn) return;
      var k = dateKey(r.punchIn); // local date, consistent with row lookup
      var d = new Date(r.punchIn), mk = d.getFullYear() + '-' + pad(d.getMonth() + 1);
      if (mk !== state.year + '-' + pad(state.month + 1)) return;
      (byDate[k] = byDate[k] || []).push(r);
    });
    Object.keys(byDate).forEach(function(k) {
      byDate[k].sort(function(a, b) { return a.punchIn - b.punchIn; });
    });

    for (var dd = 1; dd <= days; dd++) {
      var dateObj = new Date(state.year, state.month, dd);
      var key = dateObj.toLocaleDateString('en-CA');
      var holiday = state.holidays[key] || null;
      var type = dayType(dateObj, holiday);
      var shifts = byDate[key] || [];
      var net = 0;
      shifts.forEach(function(s) { var g = recMin(s); net += Math.max(0, g - (g > 0 ? CONTRACT.breakMin : 0)); });
      rows.push({
        d: dd, key: key, dateObj: dateObj, dow: DOW[dateObj.getDay()],
        type: type, holiday: holiday, shifts: shifts,
        std: standardFor(type), netMin: net,
        future: dateObj > new Date()
      });
    }
    return rows;
  }

  function holidayName(h) {
    if (!h) return '';
    return state.lang === 'th' ? (h.name_th || h.name_he) : state.lang === 'ar' ? (h.name_ar || h.name_he) : (h.name_he || h.name_th);
  }
  // אירוע cell: editable dropdown for managers, read-only text for workers.
  function eventCell(r) {
    var cur = state.events[r.key] || '';
    var holidayPill = r.holiday ? '<div style="margin-top:3px;"><span style="background:#fbf1df;color:#b8761a;padding:1px 7px;border-radius:999px;font-size:0.64rem;font-weight:700;">' + holidayName(r.holiday) + '</span></div>' : '';
    if (isManager()) {
      var opts = EVENTS.map(function(e) { return '<option value="' + e.v + '"' + (e.v === cur ? ' selected' : '') + '>' + tt(e.he, e.th, e.ar) + '</option>'; }).join('');
      return '<select onchange="MonthlyReport._setEvent(\'' + r.key + '\', this.value)" style="font-family:inherit;font-size:0.72rem;padding:3px 5px;border-radius:7px;border:1px solid ' + (cur ? '#9db8e6' : '#e2e2e2') + ';background:' + (cur ? '#eef4ff' : '#fff') + ';color:#334;max-width:104px;cursor:pointer;">' + opts + '</select>' + holidayPill;
    }
    if (cur) return '<span style="background:#eef4ff;color:#2f5fa0;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:700;">' + eventLabel(cur) + '</span>' + holidayPill;
    return (r.holiday ? '<span style="background:#fbf1df;color:#b8761a;padding:2px 8px;border-radius:999px;font-size:0.7rem;font-weight:700;">' + holidayName(r.holiday) + '</span>' : '—');
  }
  function pill(delta) {
    var good = delta >= 0;
    var bg = good ? '#e6f5ec' : '#fdeceb', fg = good ? '#1d7a4d' : '#c0392b';
    return '<span style="background:' + bg + ';color:' + fg + ';padding:3px 10px;border-radius:999px;font-size:0.74rem;font-weight:700;">' + (good ? '+ ' : '− ') + hm(Math.abs(delta)) + '</span>';
  }
  function srcMark(r) {
    var edited = r.editReason || r.originalPunchIn || r.originalPunchOut;
    return edited ? '<span style="color:#2f74c0;font-weight:700;font-size:0.62rem;">m</span>' : '<span style="color:#bbb;font-size:0.62rem;">a</span>';
  }

  function render() {
    updateMonthLabel();
    var rows = buildRows();
    var html = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;">';
    html += '<thead><tr style="color:#999;font-size:0.7rem;">' +
      '<th style="padding:8px 6px;text-align:right;border-bottom:1px solid #eee;">' + tt('תאריך','วันที่','تاريخ') + '</th>' +
      '<th style="padding:8px 6px;border-bottom:1px solid #eee;">' + tt('כניסה','เข้า','دخول') + '</th>' +
      '<th style="padding:8px 6px;border-bottom:1px solid #eee;">' + tt('יציאה','ออก','خروج') + '</th>' +
      '<th style="padding:8px 6px;border-bottom:1px solid #eee;">' + tt('סה"כ','รวม','المجموع') + '</th>' +
      '<th style="padding:8px 6px;border-bottom:1px solid #eee;">' + tt('תקן','มาตรฐาน','المعيار') + '</th>' +
      '<th style="padding:8px 6px;border-bottom:1px solid #eee;">' + tt('חוסר/עודף','ขาด/เกิน','نقص/فائض') + '</th>' +
      '<th style="padding:8px 6px;border-bottom:1px solid #eee;">' + tt('אירוע','เหตุการณ์','حدث') + '</th>' +
      '<th style="border-bottom:1px solid #eee;"></th></tr></thead><tbody>';

    var dateCell = function(r) { return '<span style="font-weight:700;">' + r.dow + ' ' + pad(r.d) + '/' + pad(state.month + 1) + '/' + state.year + '</span>'; };

    rows.forEach(function(r) {
      var restStyle = r.type === 'rest' ? 'background:#fbf6ec;' : (r.type === 'fri' ? 'border-inline-start:3px solid #fbf1df;' : '');
      var futureCol = r.future ? 'color:#9aa6a2;' : '';

      if (r.type === 'rest') {
        html += '<tr style="' + restStyle + '">' +
          '<td style="padding:7px 6px;text-align:right;border-bottom:1px solid #f3f3f3;">' + dateCell(r) + '</td>' +
          '<td colspan="5" style="padding:7px 6px;color:#b8761a;font-weight:700;border-bottom:1px solid #f3f3f3;">' + tt('מנוחה שבועית','วันหยุดประจำสัปดาห์','راحة أسبوعية') + '</td>' +
          '<td style="padding:7px 6px;border-bottom:1px solid #f3f3f3;color:#999;">' + (r.holiday ? holidayName(r.holiday) : '—') + '</td>' +
          '<td style="border-bottom:1px solid #f3f3f3;"></td></tr>';
        return;
      }

      if (r.shifts.length === 0) {
        var emptyDelta = r.type === 'event' ? null : dayDelta(0, r.type);
        html += '<tr style="' + restStyle + futureCol + '">' +
          '<td style="padding:7px 6px;text-align:right;border-bottom:1px solid #f3f3f3;' + futureCol + '">' + dateCell(r) + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;color:#ccc;">—</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;color:#ccc;">—</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;color:#ccc;">—</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;color:#2f74c0;">' + (r.std ? hm(r.std) : '') + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + (r.type === 'event' ? '' : (emptyDelta !== null && r.std ? pill(emptyDelta) : '')) + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + eventCell(r) + '</td>' +
          '<td style="border-bottom:1px solid #f3f3f3;"></td></tr>';
        return;
      }

      r.shifts.forEach(function(sh, si) {
        var first = si === 0;
        var g = recMin(sh);
        var delta = dayDelta(g, first ? r.type : 'event'); // 2nd shift carries no standard
        html += '<tr style="' + restStyle + '">' +
          '<td style="padding:7px 6px;text-align:right;border-bottom:1px solid #f3f3f3;">' + (first ? dateCell(r) : '<span style="color:#999;">↳ ' + tt('משמרת','กะ','وردية') + ' ' + (si + 1) + '</span>') + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + localTime(sh.punchIn) + ' ' + srcMark(sh) + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + (sh.punchOut ? localTime(sh.punchOut) : '—') + ' ' + srcMark(sh) + '</td>' +
          '<td style="padding:7px 6px;text-align:center;font-weight:700;border-bottom:1px solid #f3f3f3;">' + hm(g) + '</td>' +
          '<td style="padding:7px 6px;text-align:center;color:#2f74c0;border-bottom:1px solid #f3f3f3;">' + (first && r.std ? hm(r.std) : '') + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + pill(delta) + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + (first ? eventCell(r) : '') + '</td>' +
          '<td style="padding:7px 6px;text-align:center;border-bottom:1px solid #f3f3f3;">' + (sh._id && isManager() ? '<button onclick="TimeClock.editRecord(\'' + sh._id + '\')" title="' + tt('ערוך','แก้ไข','تعديل') + '" style="border:none;background:none;cursor:pointer;font-size:0.85rem;">✏️</button>' : '') + '</td></tr>';
      });
    });

    // ── monthly summary ──
    var net = 0, over = 0, under = 0;
    rows.forEach(function(r) {
      net += r.netMin;
      if (r.type === 'reg' || r.type === 'fri') {
        var d = dayDelta((function(){ var g=0; r.shifts.forEach(function(s){g+=recMin(s);}); return g; })(), r.type);
        if (r.shifts.length) { if (d >= 0) over += d; else under += -d; }
        else if (r.std) { under += r.std; } // unworked standard day = deficit
      }
    });
    html += '</tbody><tfoot><tr style="background:#f3f6f5;font-weight:700;">' +
      '<td style="padding:8px 6px;text-align:right;">' + tt('סיכום חודשי','สรุปรายเดือน','ملخص شهري') + '</td>' +
      '<td colspan="2" style="padding:8px 6px;color:#999;font-weight:400;">' + tt('נטו עבודה','สุทธิ','صافي') + '</td>' +
      '<td style="padding:8px 6px;text-align:center;">' + hm(net) + '</td><td></td>' +
      '<td style="padding:8px 6px;text-align:center;"><span style="background:#e6f5ec;color:#1d7a4d;padding:2px 8px;border-radius:999px;">+ ' + hm(over) + '</span></td>' +
      '<td colspan="2" style="padding:8px 6px;"><span style="background:#fdeceb;color:#c0392b;padding:2px 8px;border-radius:999px;">− ' + hm(under) + '</span></td>' +
      '</tr></tfoot></table>';

    var bodyEl = document.getElementById('mrBody');
    if (bodyEl) bodyEl.innerHTML = html;
    renderStats(rows);
  }

  function renderStats(rows) {
    var ot = monthlyOT(rows);
    var worked = rows.reduce(function(a, r) { return a + r.netMin; }, 0);
    var workDays = rows.filter(function(r) { return r.netMin > 0; }).length;
    var cards = [
      { k: tt('נטו עבודה','สุทธิ','صافي'), v: hm(worked) },
      { k: tt('רגילות 100%','ปกติ 100%','عادي 100%'), v: hm(ot.reg) },
      { k: tt('נוספות 125%','โอที 125%','إضافي 125%'), v: hm(ot.t125) },
      { k: tt('נוספות 150%','โอที 150%','إضافي 150%'), v: hm(ot.t150) },
      { k: tt('ימי עבודה','วันทำงาน','أيام عمل'), v: String(workDays) }
    ];
    var el = document.getElementById('mrStats');
    if (el) el.innerHTML = cards.map(function(c) {
      return '<div style="background:#f7faf9;border:1px solid #eee;border-radius:12px;padding:9px 14px;min-width:96px;flex:1;">' +
        '<div style="font-size:0.66rem;color:#999;">' + c.k + '</div>' +
        '<div style="font-size:1.15rem;font-weight:700;margin-top:2px;">' + c.v + '</div></div>';
    }).join('');
  }

  // ── controls ──
  function _nav(delta) {
    state.month += delta;
    if (state.month < 0) { state.month = 11; state.year--; }
    if (state.month > 11) { state.month = 0; state.year++; }
    updateMonthLabel();
    load();
  }
  function _pickEmp(username) {
    var emps = employeeList();
    var e = emps.filter(function(x) { return x.username === username; })[0];
    if (!e) return;
    state.username = e.username; state.name = e.name; state.lang = e.lang;
    load();
  }

  // ── CSV export ──
  function _exportCSV() {
    var rows = buildRows();
    var lines = ['תאריך,יום,כניסה,יציאה,סה"כ,תקן,חוסר/עודף,מקום,אירוע'];
    rows.forEach(function(r) {
      if (r.shifts.length === 0) {
        lines.push(pad(r.d) + '/' + pad(state.month + 1) + '/' + state.year + ',' + r.dow + ',,,,' + (r.std ? hm(r.std) : '') + ',,,' + holidayName(r.holiday));
      } else {
        r.shifts.forEach(function(sh, si) {
          var g = recMin(sh), d = dayDelta(g, si === 0 ? r.type : 'event');
          lines.push(pad(r.d) + '/' + pad(state.month + 1) + '/' + state.year + ',' + r.dow + ',' +
            localTime(sh.punchIn) + ',' + (sh.punchOut ? localTime(sh.punchOut) : '') + ',' + hm(g) + ',' +
            (si === 0 && r.std ? hm(r.std) : '') + ',' + (d >= 0 ? '+' : '-') + hm(Math.abs(d)) + ',' +
            (sh.workplace || '') + ',' + (si === 0 ? holidayName(r.holiday) : ''));
        });
      }
    });
    var blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'monthly_' + state.username + '_' + (state.month + 1) + '-' + state.year + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    if (typeof showToast === 'function') showToast('📥 ' + tt('הדוח יוצא','ส่งออกแล้ว','تم التصدير'));
  }

  function _setEvent(key, value) {
    if (!isManager()) { if (typeof showToast === 'function') showToast(tt('⛔ רק מנהל יכול לערוך','⛔ เฉพาะผู้ดูแล','⛔ للمدير فقط')); return; }
    if (value) state.events[key] = value; else delete state.events[key];
    if (typeof db !== 'undefined' && state.username) {
      var id = state.username + '__' + key;
      var who = (window.currentUser && window.currentUser.username) || '';
      try {
        if (value) db.collection('attendance-events').doc(id).set({ username: state.username, date: key, event: value, updatedBy: who, updatedAt: Date.now() }).catch(function(e) { console.warn('event save failed:', e && e.message); });
        else db.collection('attendance-events').doc(id).delete().catch(function() {});
      } catch (e) {}
    }
    render();
  }

  // ── Public API ──
  return {
    _setEvent: _setEvent,
    show: show,
    _nav: _nav,
    _pickEmp: _pickEmp,
    _exportCSV: _exportCSV
  };
})();
