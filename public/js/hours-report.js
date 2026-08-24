// ── CROSS-SECTIONAL HOURS REPORT ──
// "דוח שעות רוחבי" — one month, every worker the viewer is allowed to see,
// grouped by עובד / מטע / אירוע. The existing monthly-report.js answers
// "what did ONE worker do this month, day by day"; this answers "where did
// the hours go this month, across everybody".
//
// Reads only what already exists: the `timeclock` collection and the
// `attendance-events` collection. No new collections, no new indexes — the
// month query is a range on the single `date` field.
//
// Contract values (break deduction, weekly OT thresholds) come from
// payroll.js per employee, falling back to its default contract.
//
// ⚠ The ₪ column is a MANAGEMENT ESTIMATE (hours × rate with OT
// multipliers), not a payslip. See the note in payroll.js.

var HoursReport = (function() {
  'use strict';

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  var MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  var state = {
    year: 0, month: 0,
    groupBy: 'worker',      // worker | farm | event
    records: [],
    events: {},             // username -> { date -> eventCode }
    loading: false
  };

  // ── helpers ──
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
  function esc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isManager() {
    return window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'operator');
  }
  function isAdminRole() { return window.currentUser && window.currentUser.role === 'admin'; }

  function contractFor(username) {
    if (typeof Payroll !== 'undefined' && Payroll.getContract) return Payroll.getContract(username);
    return { breakMin: 45, weeklyCapRegular: 2520, tier125Min: 120, tier150Min: 120 };
  }

  // Which workers may this viewer see? Mirrors monthly-report.js scoping so
  // the two screens can never disagree about who belongs to whom.
  function visibleWorkers() {
    var users = (typeof window.users !== 'undefined' && window.users) ? window.users : {};
    var me = window.currentUser ? window.currentUser.username : '';
    var list = Object.keys(users).filter(function(u) { return users[u] && users[u].role !== 'viewer'; });
    if (!isManager()) return [me];
    if (!isAdminRole() && typeof Team !== 'undefined') {
      var mine = Team.getMyWorkers ? Team.getMyWorkers() : [];
      list = list.filter(function(u) { return u === me || mine.indexOf(u) !== -1; });
    }
    return list;
  }

  function workerName(u) {
    var users = (typeof window.users !== 'undefined' && window.users) ? window.users : {};
    return (users[u] && users[u].name) || u;
  }

  // A punch stores `workplace` as the farm/site NAME the worker picked.
  // That is the farm dimension — plots are never offered at punch-in.
  function farmOf(r) {
    return (r.workplace && String(r.workplace).trim()) || tt('ללא שיוך','ไม่ระบุ','غير محدد');
  }

  // ── load ──
  function show() {
    if (!isManager()) {
      if (typeof showToast === 'function') {
        showToast('⛔ ' + tt('למנהלים בלבד','สำหรับผู้จัดการเท่านั้น','للمدراء فقط'));
      }
      return;
    }
    var now = new Date();
    if (!state.year) { state.year = now.getFullYear(); state.month = now.getMonth(); }
    var warm = (typeof Payroll !== 'undefined' && Payroll.load) ? Payroll.load() : Promise.resolve();
    warm.then(function() { render(); load(); });
  }

  function monthBounds() {
    var start = state.year + '-' + pad(state.month + 1) + '-01';
    var lastDay = new Date(state.year, state.month + 1, 0).getDate();
    var end = state.year + '-' + pad(state.month + 1) + '-' + pad(lastDay);
    return { start: start, end: end };
  }

  function load() {
    state.loading = true;
    var b = monthBounds();
    var jobs = [];

    // Range query on the single `date` field — no composite index needed.
    if (typeof db !== 'undefined') {
      jobs.push(
        db.collection('timeclock')
          .where('date', '>=', b.start)
          .where('date', '<=', b.end)
          .get()
          .then(function(snap) {
            var recs = [];
            snap.forEach(function(doc) { recs.push(Object.assign({ _id: doc.id }, doc.data())); });
            state.records = recs;
          })['catch'](function(err) {
            console.warn('HoursReport records load failed:', err && err.message);
            state.records = [];
          })
      );
      jobs.push(
        db.collection('attendance-events')
          .where('date', '>=', b.start)
          .where('date', '<=', b.end)
          .get()
          .then(function(snap) {
            var ev = {};
            snap.forEach(function(doc) {
              var e = doc.data();
              if (!e || !e.username || !e.date) return;
              if (!ev[e.username]) ev[e.username] = {};
              ev[e.username][e.date] = e.event || '';
            });
            state.events = ev;
          })['catch'](function() { state.events = {}; })
      );
    } else {
      state.records = []; state.events = {};
    }

    Promise.all(jobs).then(function() { state.loading = false; render(); });
  }

  // ── aggregation ──
  // Net minutes deduct the contract break once per worker-day, not per punch:
  // a worker with three short punches in one day owes one break, not three.
  function build() {
    var allowed = visibleWorkers();
    var allowedSet = {};
    allowed.forEach(function(u) { allowedSet[u] = true; });

    var mine = state.records.filter(function(r) { return r && r.username && allowedSet[r.username]; });

    // Group punches by worker+day so the break is applied once per day.
    var days = {};
    mine.forEach(function(r) {
      var k = r.username + '|' + (r.date || '');
      if (!days[k]) days[k] = { username: r.username, date: r.date || '', gross: 0, shifts: [] };
      days[k].gross += recMin(r);
      days[k].shifts.push(r);
    });

    // Per-worker weekly tiering, so OT thresholds behave like the monthly report.
    var perWorker = {};
    Object.keys(days).forEach(function(k) {
      var d = days[k];
      var c = contractFor(d.username);
      var net = Math.max(0, d.gross - (d.gross > 0 ? (c.breakMin || 0) : 0));
      d.net = net;
      if (!perWorker[d.username]) perWorker[d.username] = [];
      perWorker[d.username].push(d);
    });

    var tiersByWorker = {};
    Object.keys(perWorker).forEach(function(u) {
      var c = contractFor(u);
      var weeks = {};
      perWorker[u].forEach(function(d) {
        var dt = new Date(d.date + 'T00:00:00');
        var wk = weekKey(dt);
        weeks[wk] = (weeks[wk] || 0) + d.net;
      });
      var reg = 0, t125 = 0, t150 = 0;
      Object.keys(weeks).forEach(function(w) {
        var rem = weeks[w];
        var r = Math.min(rem, c.weeklyCapRegular || 2520); reg += r; rem -= r;
        var a = Math.min(rem, c.tier125Min || 120); t125 += a; rem -= a;
        if (rem > 0) t150 += rem;
      });
      tiersByWorker[u] = { reg: reg, t125: t125, t150: t150, total: reg + t125 + t150 };
    });

    // Now bucket by the requested dimension.
    var buckets = {};
    function bucket(key, label) {
      if (!buckets[key]) buckets[key] = { label: label, net: 0, gross: 0, days: {}, workers: {} };
      return buckets[key];
    }

    Object.keys(days).forEach(function(k) {
      var d = days[k];
      if (state.groupBy === 'worker') {
        var b = bucket(d.username, workerName(d.username));
        b.net += d.net; b.gross += d.gross; b.days[d.date] = 1; b.workers[d.username] = 1;
      } else if (state.groupBy === 'farm') {
        // A day can span two farms — split its net time across the punches
        // in proportion to their gross, so totals still add up.
        d.shifts.forEach(function(r) {
          var g = recMin(r);
          var share = d.gross > 0 ? (d.net * (g / d.gross)) : 0;
          var f = farmOf(r);
          var bf = bucket(f, f);
          bf.net += share; bf.gross += g; bf.days[d.username + '|' + d.date] = 1; bf.workers[d.username] = 1;
        });
      } else { // event
        var code = (state.events[d.username] || {})[d.date] || '';
        var label = code
          ? ((typeof Payroll !== 'undefined' && Payroll.eventLabel) ? Payroll.eventLabel(code) : code)
          : tt('עבודה רגילה','ทำงานปกติ','عمل عادي');
        var be = bucket(code || '_work', label);
        be.net += d.net; be.gross += d.gross; be.days[d.username + '|' + d.date] = 1; be.workers[d.username] = 1;
      }
    });

    var rows = Object.keys(buckets).map(function(k) {
      var b = buckets[k];
      var pay = null;
      if (state.groupBy === 'worker' && typeof Payroll !== 'undefined' && Payroll.estimatePay) {
        pay = Payroll.estimatePay(k, tiersByWorker[k] || { reg: b.net, t125: 0, t150: 0 });
      }
      return {
        key: k,
        label: b.label,
        net: Math.round(b.net),
        gross: Math.round(b.gross),
        dayCount: Object.keys(b.days).length,
        workerCount: Object.keys(b.workers).length,
        tiers: tiersByWorker[k] || null,
        pay: pay
      };
    }).sort(function(a, b) { return b.net - a.net; });

    return rows;
  }

  // ISO-ish week key (weeks start Sunday, matching the Israeli work week).
  function weekKey(dt) {
    var d = new Date(dt.getTime());
    d.setDate(d.getDate() - d.getDay());
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // ── render ──
  function tabBtn(id, label) {
    var on = (state.groupBy === id);
    return '<button onclick="HoursReport._group(\'' + id + '\')" style="flex:1;padding:8px 4px;border:none;border-radius:9px;' +
      'font-family:inherit;font-size:0.78rem;font-weight:700;cursor:pointer;' +
      (on ? 'background:var(--g2,#4caf50);color:#fff;' : 'background:var(--g6,#eef3ee);color:var(--g1,#2e7d32);') + '">' + label + '</button>';
  }

  function render() {
    var host = document.getElementById('modalContainer');
    if (!host) return;
    var rows = state.loading ? [] : build();

    var totNet = 0, totDays = 0, totPay = 0, anyPay = false;
    rows.forEach(function(r) {
      totNet += r.net; totDays += r.dayCount;
      if (r.pay) { totPay += r.pay.amount; anyPay = true; }
    });

    var head = (state.groupBy === 'worker') ? tt('עובד','พนักงาน','موظف')
             : (state.groupBy === 'farm')   ? tt('מטע','สวน','مزرعة')
             : tt('אירוע','เหตุการณ์','حدث');

    var body = '';
    if (state.loading) {
      body = '<tr><td colspan="6" style="text-align:center;color:#999;padding:22px;">' + tt('טוען...','กำลังโหลด...','جاري التحميل...') + '</td></tr>';
    } else if (!rows.length) {
      body = '<tr><td colspan="6" style="text-align:center;color:#999;padding:22px;">' + tt('אין נתונים לחודש זה','ไม่มีข้อมูลเดือนนี้','لا بيانات لهذا الشهر') + '</td></tr>';
    } else {
      rows.forEach(function(r) {
        body +=
          '<tr>' +
            '<td style="padding:7px 6px;border-bottom:1px solid #eee;font-weight:600;">' + esc(r.label) + '</td>' +
            '<td style="padding:7px 6px;border-bottom:1px solid #eee;text-align:center;">' + r.dayCount + '</td>' +
            (state.groupBy === 'worker' ? '' :
              '<td style="padding:7px 6px;border-bottom:1px solid #eee;text-align:center;">' + r.workerCount + '</td>') +
            '<td style="padding:7px 6px;border-bottom:1px solid #eee;text-align:center;color:#888;">' + hm(r.gross) + '</td>' +
            '<td style="padding:7px 6px;border-bottom:1px solid #eee;text-align:center;font-weight:700;">' + hm(r.net) + '</td>' +
            (r.tiers ? '<td style="padding:7px 6px;border-bottom:1px solid #eee;text-align:center;font-size:0.75rem;color:#ef6c00;">' +
                (r.tiers.t125 + r.tiers.t150 > 0 ? hm(r.tiers.t125 + r.tiers.t150) : '—') + '</td>' : '<td style="border-bottom:1px solid #eee;"></td>') +
            (anyPay ? '<td style="padding:7px 6px;border-bottom:1px solid #eee;text-align:center;font-weight:700;">' +
                (r.pay ? '₪' + Math.round(r.pay.amount).toLocaleString() : '—') + '</td>' : '') +
          '</tr>';
      });
    }

    var cols =
      '<th style="text-align:start;padding:7px 6px;">' + head + '</th>' +
      '<th style="padding:7px 6px;">' + tt('ימים','วัน','أيام') + '</th>' +
      (state.groupBy === 'worker' ? '' : '<th style="padding:7px 6px;">' + tt('עובדים','พนักงาน','عمال') + '</th>') +
      '<th style="padding:7px 6px;">' + tt('ברוטו','รวม','إجمالي') + '</th>' +
      '<th style="padding:7px 6px;">' + tt('נטו','สุทธิ','صافي') + '</th>' +
      '<th style="padding:7px 6px;">' + tt('נוספות','โอที','إضافي') + '</th>' +
      (anyPay ? '<th style="padding:7px 6px;">' + tt('אומדן ₪','ประมาณ ₪','تقدير ₪') + '</th>' : '');

    host.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width:720px;">' +
          '<h2 style="margin-bottom:10px;">📊 ' + tt('דוח שעות רוחבי','รายงานชั่วโมงรวม','تقرير ساعات شامل') + '</h2>' +

          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
            '<button onclick="HoursReport._nav(-1)" style="border:none;background:var(--g6,#eef3ee);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:1rem;">›</button>' +
            '<div style="flex:1;text-align:center;font-weight:700;font-size:0.95rem;">' + MONTHS[state.month] + ' ' + state.year + '</div>' +
            '<button onclick="HoursReport._nav(1)" style="border:none;background:var(--g6,#eef3ee);border-radius:8px;padding:6px 12px;cursor:pointer;font-family:inherit;font-size:1rem;">‹</button>' +
          '</div>' +

          '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
            tabBtn('worker', '👤 ' + tt('לפי עובד','ตามพนักงาน','حسب الموظف')) +
            tabBtn('farm',   '🌳 ' + tt('לפי מטע','ตามสวน','حسب المزرعة')) +
            tabBtn('event',  '📌 ' + tt('לפי אירוע','ตามเหตุการณ์','حسب الحدث')) +
          '</div>' +

          '<div style="overflow-x:auto;max-height:50vh;overflow-y:auto;">' +
            '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">' +
              '<thead><tr style="background:var(--g6,#eef3ee);">' + cols + '</tr></thead>' +
              '<tbody>' + body + '</tbody>' +
            '</table>' +
          '</div>' +

          '<div style="display:flex;gap:8px;justify-content:space-between;background:var(--g6,#eef3ee);border-radius:9px;padding:9px 12px;margin-top:10px;font-size:0.84rem;font-weight:700;">' +
            '<span>' + tt('סה"כ','รวม','المجموع') + '</span>' +
            '<span>' + totDays + ' ' + tt('ימים','วัน','أيام') + '</span>' +
            '<span>' + hm(totNet) + '</span>' +
            (anyPay ? '<span>₪' + Math.round(totPay).toLocaleString() + '</span>' : '') +
          '</div>' +

          (anyPay ? '<div style="font-size:0.68rem;color:var(--text-muted,#888);margin-top:6px;">⚠️ ' +
            tt('אומדן ניהולי בלבד — לא תלוש שכר.','ประมาณการเพื่อการจัดการเท่านั้น','تقدير إداري فقط.') + '</div>' : '') +

          '<div class="modal-buttons" style="margin-top:12px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + tt('סגור','ปิด','إغلاق') + '</button>' +
            '<button class="btn btn-primary" onclick="HoursReport._exportCSV()">⤓ CSV</button>' +
          '</div>' +
        '</div>' +
      '</div>';
  }

  // ── controls ──
  function _group(g) { state.groupBy = g; render(); }

  function _nav(delta) {
    var m = state.month + delta;
    var y = state.year;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    state.month = m; state.year = y;
    render();
    load();
  }

  function _exportCSV() {
    var rows = build();
    var head = (state.groupBy === 'worker') ? 'עובד' : (state.groupBy === 'farm') ? 'מטע' : 'אירוע';
    var lines = [[head, 'ימים', 'עובדים', 'ברוטו', 'נטו', 'נוספות', 'אומדן ₪'].join(',')];
    rows.forEach(function(r) {
      lines.push([
        '"' + String(r.label).replace(/"/g, '""') + '"',
        r.dayCount,
        r.workerCount,
        hm(r.gross),
        hm(r.net),
        r.tiers ? hm(r.tiers.t125 + r.tiers.t150) : '',
        r.pay ? Math.round(r.pay.amount) : ''
      ].join(','));
    });
    // BOM so Excel opens Hebrew correctly.
    var blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'hours-' + state.year + '-' + pad(state.month + 1) + '-' + state.groupBy + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
    if (typeof showToast === 'function') showToast('⤓ CSV');
  }

  return {
    show: show,
    _group: _group,
    _nav: _nav,
    _exportCSV: _exportCSV
  };
})();
