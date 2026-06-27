// ── LEAVE MANAGEMENT MODULE (Meckano upgrade — Phase 4) ──
//
// Three concerns:
//   1. Leave request CRUD against `leave-requests/{requestId}`.
//   2. Balance bookkeeping per user (stored on user doc — no new collection).
//      Vacation accrual follows Israeli labor law's per-tenure ladder.
//   3. Israeli holiday calendar — fetched from Hebcal (CORS-enabled) and
//      cached in `holidays/{year}`. When approved, leaves and holidays
//      generate synthetic timeclock entries so monthly totals are
//      uniform across all paid-but-not-worked time.
//
// IMPORTANT: like the OT engine in schedule.js, this affects pay.
// Don't optimise here without re-running the test cases.

var Leave = (function() {
  'use strict';

  // ── Constants ──

  var LEAVE_TYPES = {
    vacation:    { he: 'חופשה',      th: 'พักร้อน',     ar: 'إجازة سنوية',      icon: '🏖️', usesBalance: 'vacation' },
    sick:        { he: 'מחלה',        th: 'ลาป่วย',      ar: 'إجازة مرضية',      icon: '🤒', usesBalance: 'sick' },
    reserve:     { he: 'מילואים',     th: 'รับราชการทหาร', ar: 'احتياط عسكري',     icon: '🪖', usesBalance: 'reserve' },
    personal:    { he: 'אישית',       th: 'ลากิจ',       ar: 'إجازة شخصية',      icon: '👤', usesBalance: 'vacation' },
    unpaid:      { he: 'ללא תשלום',  th: 'ลาไม่รับเงิน', ar: 'إجازة بدون راتب', icon: '💸', usesBalance: null },
    maternity:   { he: 'לידה',        th: 'ลาคลอด',      ar: 'إجازة أمومة',      icon: '👶', usesBalance: null },
    bereavement: { he: 'אבל',         th: 'ไว้ทุกข์',     ar: 'حداد',             icon: '🕯️', usesBalance: null },
    holiday:     { he: 'חג',          th: 'วันหยุดราชการ', ar: 'عطلة رسمية',       icon: '🎉', usesBalance: null }
  };

  // Israeli annual vacation entitlement by years of tenure (5-day week,
  // post-2017 amendment). The user can override per-employee in the
  // balance editor; this is just the auto-credit baseline.
  var ANNUAL_VACATION_DAYS = {
    1: 12, 2: 12, 3: 12, 4: 13, 5: 14,
    6: 16, 7: 18, 8: 19, 9: 20, 10: 21,
    11: 22, 12: 23, 13: 24, 14: 25, 15: 26, 16: 27, 17: 28
  };
  function vacationByTenure(years) {
    if (years < 1) return 12; // first-year minimum
    if (years >= 17) return 28;
    return ANNUAL_VACATION_DAYS[Math.floor(years)] || 12;
  }

  // Sick days: 1.5 per worked month, max 90 lifetime per Israeli labor law.
  var SICK_DAYS_PER_YEAR = 18;
  var SICK_MAX_ACCRUAL = 90;

  // ── User balance helpers ──

  function getCurrentYear() { return new Date().getFullYear(); }

  function tenureYears(user) {
    if (!user || !user.created_at) return 0;
    return (Date.now() - user.created_at) / (365.25 * 86400000);
  }

  // Returns the live balance object for a user, creating defaults if
  // this is the first time the user is asking about leave this year.
  function getBalance(username) {
    if (typeof users === 'undefined' || !users[username]) {
      return _defaultBalance(0);
    }
    var u = users[username];
    var yr = getCurrentYear();
    if (!u.leaveBalance || u.leaveBalance.year !== yr) {
      // Rolled over to a new year — recompute earned, carry vacation forward,
      // sick capped at SICK_MAX_ACCRUAL.
      var prev = u.leaveBalance || _defaultBalance(0);
      var earnedVac = vacationByTenure(tenureYears(u));
      var carriedVac = Math.max(0, (prev.vacation && prev.vacation.earned - prev.vacation.used) || 0);
      var carriedSick = Math.min(SICK_MAX_ACCRUAL,
        Math.max(0, (prev.sick && prev.sick.earned - prev.sick.used) || 0));
      u.leaveBalance = {
        year: yr,
        vacation: { earned: earnedVac, used: 0, pending: 0, carryOver: carriedVac, customOverride: null },
        sick:     { earned: SICK_DAYS_PER_YEAR, used: 0, pending: 0, carryOver: carriedSick },
        reserve:  { used: 0 }   // no balance — reserve is unlimited
      };
      if (typeof DB !== 'undefined') DB.save('shorashim-users', users);
    }
    return u.leaveBalance;
  }

  function _defaultBalance(years) {
    return {
      year: getCurrentYear(),
      vacation: { earned: vacationByTenure(years), used: 0, pending: 0, carryOver: 0, customOverride: null },
      sick:     { earned: SICK_DAYS_PER_YEAR, used: 0, pending: 0, carryOver: 0 },
      reserve:  { used: 0 }
    };
  }

  // Effective vacation total: customOverride if set, else earned + carryOver
  function effectiveVacation(balance) {
    if (!balance || !balance.vacation) return { available: 0, used: 0, pending: 0 };
    var v = balance.vacation;
    var total = v.customOverride != null ? v.customOverride : (v.earned + v.carryOver);
    return {
      total: total,
      used: v.used || 0,
      pending: v.pending || 0,
      available: total - (v.used || 0) - (v.pending || 0)
    };
  }

  function effectiveSick(balance) {
    if (!balance || !balance.sick) return { total: 0, used: 0, available: 0 };
    var s = balance.sick;
    var total = (s.earned || 0) + (s.carryOver || 0);
    return { total: total, used: s.used || 0, available: total - (s.used || 0) };
  }

  // ── Day-counting ──

  // Counts ACTUAL working days in [start, end] inclusive, skipping weekends
  // and known holidays. Half-day options at either end reduce the count.
  function countLeaveDays(startDate, endDate, startHalf, endHalf, schedule, holidayDates) {
    if (!startDate || !endDate || startDate > endDate) return 0;
    schedule = schedule || null;
    holidayDates = holidayDates || {};
    var s = new Date(startDate + 'T00:00:00');
    var e = new Date(endDate + 'T00:00:00');
    var totalDays = 0;
    var dayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
    for (var d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      var ds = d.toISOString().slice(0, 10);
      if (holidayDates[ds]) continue;                  // public holiday — free
      if (schedule) {
        var dk = dayKeys[d.getDay()];
        if (!schedule.schedule || !schedule.schedule[dk]) continue;   // off-day
      } else {
        // No schedule supplied — fall back to "Saturday off"
        if (d.getDay() === 6) continue;
      }
      totalDays += 1;
    }
    // Apply half-day reductions if range is non-empty
    if (totalDays > 0) {
      if (startHalf === 'am' || startHalf === 'pm') totalDays -= 0.5;
      // BUG FIX: previous version had `endHalf === 'am' || endHalf === 'pm' && endDate !== startDate`
      // which parsed as `am || (pm && multiDay)` due to && binding tighter than ||.
      // That made a same-day request with endHalf='am' wrongly subtract another 0.5.
      // The intent is: on a multi-day range, BOTH endpoints can be half-days.
      if (endDate !== startDate && (endHalf === 'am' || endHalf === 'pm')) totalDays -= 0.5;
    }
    return Math.max(0, totalDays);
  }

  // ── Leave request CRUD ──

  function submitRequest(req) {
    if (typeof db === 'undefined') return Promise.reject(new Error('Offline storage not ready'));
    var id = 'req_' + Date.now() + '_' + (req.username || 'anon');
    var doc = Object.assign({
      id: id,
      status: 'pending',
      requestedAt: Date.now(),
      approvedBy: null,
      approvedAt: null,
      rejectionReason: null
    }, req);
    return db.collection('leave-requests').doc(id).set(doc).then(function() {
      // NOTE: we deliberately do NOT update the balance's `pending` field
      // here. Workers can write `leave-requests` but not `shorashim-users`,
      // so a balance write would fail under strict rules. Instead, the
      // pending count is computed at display time by aggregating pending
      // requests via getPendingDaysAsync().
      if (typeof Audit !== 'undefined') {
        Audit.log('create', 'leave', id, {
          targetUser: req.username, before: null, after: doc
        });
      }
      return doc;
    });
  }

  // Live pending-days count: aggregates pending leave-requests for the
  // user. Used by the UI in place of the (no-longer-stored) pending field.
  function getPendingDaysAsync(username, type) {
    if (typeof db === 'undefined') return Promise.resolve(0);
    var lt = LEAVE_TYPES[type];
    if (!lt || !lt.usesBalance) return Promise.resolve(0);
    return db.collection('leave-requests')
      .where('username', '==', username)
      .where('status', '==', 'pending')
      .get()
      .then(function(snap) {
        var sum = 0;
        snap.forEach(function(doc) {
          var r = doc.data();
          if (LEAVE_TYPES[r.type] && LEAVE_TYPES[r.type].usesBalance === lt.usesBalance) {
            sum += r.days || 0;
          }
        });
        return sum;
      })
      .catch(function() { return 0; });
  }

  function listForUser(username, limit) {
    if (typeof db === 'undefined') return Promise.resolve([]);
    return db.collection('leave-requests')
      .where('username', '==', username)
      .orderBy('requestedAt', 'desc')
      .limit(limit || 30)
      .get()
      .then(function(snap) {
        var rows = []; snap.forEach(function(d) { rows.push(d.data()); });
        return rows;
      })
      .catch(function() { return []; });
  }

  function listPending() {
    if (typeof db === 'undefined') return Promise.resolve([]);
    return db.collection('leave-requests')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'desc')
      .get()
      .then(function(snap) {
        var rows = []; snap.forEach(function(d) { rows.push(d.data()); });
        return rows;
      })
      .catch(function() { return []; });
  }

  function approve(requestId, approverUsername) {
    if (typeof db === 'undefined') return Promise.reject(new Error('Offline'));
    return db.collection('leave-requests').doc(requestId).get().then(function(doc) {
      if (!doc.exists) throw new Error('Not found');
      var before = doc.data();
      if (before.status !== 'pending') throw new Error('Already processed');
      var update = {
        status: 'approved',
        approvedBy: approverUsername,
        approvedAt: Date.now()
      };
      return db.collection('leave-requests').doc(requestId).update(update).then(function() {
        // Pending is computed dynamically from leave-requests now — only
        // debit `used` here. (Old code: pending--, used++).
        _adjustBalance(before.username, before.type, +before.days, 'used');
        // Create synthetic timeclock entries for each day in range
        return _createSyntheticTimeclockEntries(before);
      }).then(function() {
        if (typeof Audit !== 'undefined') {
          Audit.log('approve', 'leave', requestId, {
            targetUser: before.username, before: before, after: Object.assign({}, before, update)
          });
        }
      });
    });
  }

  function reject(requestId, approverUsername, reason) {
    if (typeof db === 'undefined') return Promise.reject(new Error('Offline'));
    return db.collection('leave-requests').doc(requestId).get().then(function(doc) {
      if (!doc.exists) throw new Error('Not found');
      var before = doc.data();
      if (before.status !== 'pending') throw new Error('Already processed');
      var update = {
        status: 'rejected',
        approvedBy: approverUsername,
        approvedAt: Date.now(),
        rejectionReason: reason || null
      };
      return db.collection('leave-requests').doc(requestId).update(update).then(function() {
        // No balance change — pending is computed from leave-requests now.
        if (typeof Audit !== 'undefined') {
          Audit.log('reject', 'leave', requestId, {
            targetUser: before.username, before: before, after: Object.assign({}, before, update),
            reason: reason || null
          });
        }
      });
    });
  }

  function cancel(requestId) {
    // Only the owner can cancel their own pending request.
    return db.collection('leave-requests').doc(requestId).get().then(function(doc) {
      if (!doc.exists) throw new Error('Not found');
      var before = doc.data();
      if (before.status !== 'pending') throw new Error('Already processed');
      return db.collection('leave-requests').doc(requestId).update({ status: 'cancelled' });
      // No balance change — pending is computed from leave-requests now.
    });
  }

  // ── Balance adjustments ──
  function _adjustBalance(username, type, delta, bucket) {
    if (typeof users === 'undefined' || !users[username]) return;
    var u = users[username];
    if (!u.leaveBalance) u.leaveBalance = _defaultBalance(tenureYears(u));
    var lt = LEAVE_TYPES[type];
    if (!lt) return;
    var key = lt.usesBalance;
    if (!key) {
      // Unpaid / maternity / bereavement / holiday — no balance change
      // (they still create synthetic timeclock entries on approve).
      return;
    }
    var b = u.leaveBalance[key];
    if (!b) return;
    if (bucket === 'pending') b.pending = Math.max(0, (b.pending || 0) + delta);
    else if (bucket === 'used')    b.used    = Math.max(0, (b.used    || 0) + delta);
    if (typeof DB !== 'undefined') DB.save('shorashim-users', users);
  }

  // ── Synthetic timeclock entries on approval ──
  // We create one entry per workday in the leave range so monthly
  // timesheets aggregate uniformly. These records have type set and
  // duration set to the user's expected daily hours.
  function _createSyntheticTimeclockEntries(req) {
    if (typeof db === 'undefined') return Promise.resolve();
    var schedule = (typeof Schedule !== 'undefined') ? Schedule.getForUser(req.username) : null;
    var dayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
    var s = new Date(req.startDate + 'T00:00:00');
    var e = new Date(req.endDate + 'T00:00:00');
    var batch = db.batch();
    var writes = 0;
    for (var d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
      var ds = d.toISOString().slice(0, 10);
      var dk = dayKeys[d.getDay()];
      var sched = schedule && schedule.schedule[dk];
      if (!sched) continue;
      var expectedH = _scheduleDailyHours(sched);
      var paidMin = Math.round(expectedH * 60);
      // Apply half-day reduction if this is the boundary
      var halfReduction = 0;
      if (ds === req.startDate && (req.startDay === 'am' || req.startDay === 'pm')) halfReduction = 0.5;
      if (ds === req.endDate   && (req.endDay   === 'am' || req.endDay   === 'pm') && req.startDate !== req.endDate) halfReduction = 0.5;
      if (halfReduction > 0) paidMin = Math.round(paidMin * (1 - halfReduction));
      var punchIn  = new Date(ds + 'T' + (sched.start || '08:00') + ':00').getTime();
      var punchOut = punchIn + paidMin * 60000;
      var docId = ds + '_' + req.username + '_leave_' + req.id.slice(-6);
      var rec = {
        punchIn: punchIn, punchOut: punchOut,
        username: req.username, userName: req.userName || '',
        workplace: '— ' + (LEAVE_TYPES[req.type] ? LEAVE_TYPES[req.type].he : req.type) + ' —',
        shiftIndex: 0, date: ds, duration: paidMin * 60000,
        paidMinutes: paidMin, breakMinutes: 0, breaks: [],
        type: req.type, status: 'approved',
        approvedBy: req.approvedBy, approvedAt: req.approvedAt,
        leaveRequestId: req.id,
        geoVerified: null, geoWarnings: [], punchInGeo: null, punchOutGeo: null,
        hoursRegular: expectedH * (1 - halfReduction), hours125: 0, hours150: 0, hoursNight: 0,
        expectedHours: expectedH, scheduleWarnings: [], offDay: false,
        synthetic: true, schemaVersion: 1, device: 'system'
      };
      batch.set(db.collection('timeclock').doc(docId), rec);
      writes++;
    }
    if (writes === 0) return Promise.resolve();
    return batch.commit();
  }

  function _scheduleDailyHours(daySchedule) {
    if (!daySchedule) return 0;
    var s = daySchedule.start.split(':'); var e = daySchedule.end.split(':');
    var h = (parseInt(e[0]) + parseInt(e[1])/60) - (parseInt(s[0]) + parseInt(s[1])/60);
    if (h < 0) h += 24;
    h -= (daySchedule.breakMinutes || 0) / 60;
    return Math.max(0, h);
  }

  // ── Hebcal holiday import ──
  // Fetches Israeli major holidays for a year and caches in `holidays/{year}`.
  // Cached docs are used by Sites/Schedule to skip holiday days.

  function fetchAndCacheHolidays(year) {
    year = year || getCurrentYear();
    if (typeof db === 'undefined') return Promise.reject(new Error('Offline'));
    return db.collection('holidays').doc(String(year)).get().then(function(snap) {
      if (snap.exists) return snap.data();
      // Not cached yet — fetch from Hebcal. Wrap with a 15s timeout and
      // explicit error handling so the UI doesn't hang on network failure.
      var url = 'https://www.hebcal.com/hebcal?v=1&cfg=json&maj=on&mod=on&i=on&year=' + year;
      var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timeoutId = setTimeout(function() { if (ctl) ctl.abort(); }, 15000);
      var opts = ctl ? { signal: ctl.signal } : {};
      return fetch(url, opts).then(function(res) {
        clearTimeout(timeoutId);
        if (!res.ok) throw new Error('Hebcal HTTP ' + res.status);
        return res.json();
      }).then(function(json) {
        if (!json || !Array.isArray(json.items)) {
          throw new Error('Hebcal returned malformed response');
        }
        var holidays = json.items.filter(function(item) {
          return item && item.category === 'holiday' && item.yomtov;
        }).map(function(item) {
          return {
            date: (item.date || '').slice(0, 10),
            name_he: item.hebrew || item.title || '',
            name_th: item.title || '',
            name_ar: item.title || '',
            paid: true,
            halfDay: false,
            source: 'hebcal'
          };
        });
        var doc = {
          year: year,
          country: 'IL',
          holidays: holidays,
          importedAt: Date.now(),
          source: 'hebcal'
        };
        return db.collection('holidays').doc(String(year)).set(doc).then(function() { return doc; });
      }).catch(function(err) {
        clearTimeout(timeoutId);
        var msg = (err && err.name === 'AbortError')
          ? 'Hebcal request timed out'
          : (err.message || 'Hebcal fetch failed');
        console.error(msg, err);
        throw new Error(msg);
      });
    });
  }

  function loadHolidayMap(year) {
    year = year || getCurrentYear();
    if (typeof db === 'undefined') return Promise.resolve({});
    return db.collection('holidays').doc(String(year)).get().then(function(snap) {
      if (!snap.exists) return {};
      var doc = snap.data();
      var map = {};
      (doc.holidays || []).forEach(function(h) { map[h.date] = h; });
      return map;
    }).catch(function() { return {}; });
  }

  // Generate synthetic timeclock entries for the year's paid holidays for
  // every active user. Admin-triggered, idempotent (uses deterministic
  // doc IDs).
  function generateHolidayEntries(year) {
    year = year || getCurrentYear();
    return loadHolidayMap(year).then(function(map) {
      if (typeof users === 'undefined') return 0;
      var batch = db.batch();
      var writes = 0;
      var workers = Object.keys(users).filter(function(k) {
        return users[k].role !== 'viewer';
      });
      var dayKeys = ['sun','mon','tue','wed','thu','fri','sat'];
      Object.keys(map).forEach(function(ds) {
        var h = map[ds];
        if (!h.paid) return;
        var d = new Date(ds + 'T00:00:00');
        workers.forEach(function(uname) {
          var u = users[uname];
          var sched = u.schedule || (typeof Schedule !== 'undefined' ? Schedule.DEFAULT_SCHEDULE : null);
          if (!sched || !sched.schedule) return;
          var daySched = sched.schedule[dayKeys[d.getDay()]];
          if (!daySched) return; // already off (e.g. holiday on Saturday — no double-count)
          var expectedH = _scheduleDailyHours(daySched);
          var paidMin = Math.round(expectedH * 60);
          var punchIn = new Date(ds + 'T' + daySched.start + ':00').getTime();
          var docId = ds + '_' + uname + '_holiday';
          batch.set(db.collection('timeclock').doc(docId), {
            punchIn: punchIn, punchOut: punchIn + paidMin * 60000,
            username: uname, userName: u.name || uname,
            workplace: '🎉 ' + h.name_he,
            shiftIndex: 0, date: ds, duration: paidMin * 60000,
            paidMinutes: paidMin, breakMinutes: 0, breaks: [],
            type: 'holiday', status: 'approved',
            holidayName: h.name_he,
            geoVerified: null, geoWarnings: [], punchInGeo: null, punchOutGeo: null,
            hoursRegular: expectedH, hours125: 0, hours150: 0, hoursNight: 0,
            expectedHours: expectedH, scheduleWarnings: [], offDay: false,
            synthetic: true, schemaVersion: 1, device: 'system'
          });
          writes++;
        });
      });
      if (writes === 0) return 0;
      return batch.commit().then(function() { return writes; });
    });
  }

  // ─────────────────────────────────────────────────────────
  // ── UI
  // ─────────────────────────────────────────────────────────

  function _T(he, th, ar) { return typeof tt === 'function' ? tt(he, th, ar) : he; }

  function showMyLeave() {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    var username = window.currentUser && window.currentUser.username;
    if (!username) return;
    var bal = getBalance(username);
    var vac = effectiveVacation(bal);
    var sick = effectiveSick(bal);

    // Render immediately with vac/sick as-is. Pending is no longer
    // persisted (workers can't write the balance doc), so we kick off a
    // background fetch and patch the displayed numbers in place once it
    // resolves. No modal-open delay.
    _renderMyLeaveBody(username, vac, sick);

    Promise.all([
      getPendingDaysAsync(username, 'vacation'),
      getPendingDaysAsync(username, 'sick')
    ]).then(function(p) {
      var vAvail = Math.max(0, vac.available - p[0]);
      var sAvail = Math.max(0, sick.available - p[1]);
      var ve = document.getElementById('vacAvail');
      var se = document.getElementById('sickAvail');
      var vp = document.getElementById('vacPending');
      if (ve) ve.textContent = vAvail;
      if (se) se.textContent = sAvail;
      if (vp && p[0] > 0) vp.innerHTML = '⏳ ' + p[0] + ' ' + _T('ממתינים','รอ','قيد الانتظار');
    }).catch(function() {});
  }

  function _renderMyLeaveBody(username, vac, sick) {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    var typeLabel = function(t) { var lt = LEAVE_TYPES[t]; return lt ? (lt.icon + ' ' + _T(lt.he, lt.th, lt.ar)) : t; };
    var statusBadge = function(s) {
      var colors = { pending: '#ff9800', approved: '#2e7d32', rejected: '#c62828', cancelled: '#999' };
      var labels = {
        pending:   _T('ממתין','รอ','قيد الانتظار'),
        approved:  _T('אושר','อนุมัติแล้ว','تمت الموافقة'),
        rejected:  _T('נדחה','ปฏิเสธ','مرفوض'),
        cancelled: _T('בוטל','ยกเลิก','ملغى')
      };
      return '<span style="display:inline-block;background:' + (colors[s]||'#999') + ';color:white;font-size:0.7rem;padding:2px 8px;border-radius:6px;font-weight:700;">' + (labels[s]||s) + '</span>';
    };

    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:480px;max-height:90vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">🏖️ ' + _T('חופשות שלי','การลาของฉัน','إجازاتي') + '</h3>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">' +
          '<div style="background:linear-gradient(135deg,#e8f5e9,#c8e6c9);border-radius:10px;padding:10px;">' +
            '<div style="font-size:0.7rem;color:#1b5e20;">🏖️ ' + _T('חופשה','พักร้อน','إجازة سنوية') + '</div>' +
            '<div style="font-size:1.3rem;font-weight:700;color:#1b5e20;" id="vacAvail">' + vac.available + '</div>' +
            '<div style="font-size:0.7rem;color:#388e3c;">' + _T('זמינים','ใช้ได้','متاح') + ' / ' + vac.total + ' ' + _T('סהכ','รวม','إجمالي') + '</div>' +
            '<div style="font-size:0.65rem;color:#ef6c00;margin-top:2px;" id="vacPending"></div>' +
          '</div>' +
          '<div style="background:linear-gradient(135deg,#fff3e0,#ffe0b2);border-radius:10px;padding:10px;">' +
            '<div style="font-size:0.7rem;color:#bf360c;">🤒 ' + _T('מחלה','ลาป่วย','إجازة مرضية') + '</div>' +
            '<div style="font-size:1.3rem;font-weight:700;color:#bf360c;" id="sickAvail">' + sick.available + '</div>' +
            '<div style="font-size:0.7rem;color:#e65100;">' + _T('זמינים','ใช้ได้','متاح') + ' / ' + sick.total + '</div>' +
          '</div>' +
        '</div>' +

        '<button onclick="Leave.showRequestForm()" style="width:100%;padding:12px;border-radius:10px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;font-size:0.95rem;cursor:pointer;margin-bottom:14px;">➕ ' + _T('בקשת חופשה חדשה','ขอลาใหม่','طلب إجازة جديدة') + '</button>' +

        '<div style="font-weight:700;font-size:0.85rem;margin-bottom:8px;color:#666;">' + _T('היסטוריית בקשות','ประวัติการลา','سجل الطلبات') + '</div>' +
        '<div id="myLeaveHistory" style="color:#999;font-size:0.85rem;text-align:center;padding:14px;">' + _T('טוען...','กำลังโหลด...','جاري التحميل...') + '</div>' +

        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:10px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + _T('סגור','ปิด','إغلاق') + '</button>' +
      '</div></div>';

    listForUser(username, 20).then(function(rows) {
      var c = document.getElementById('myLeaveHistory');
      if (!c) return;
      if (rows.length === 0) {
        c.innerHTML = '<div style="color:#999;">' + _T('אין בקשות','ไม่มีคำขอ','لا توجد طلبات') + '</div>';
        return;
      }
      var html = '';
      rows.forEach(function(r) {
        var fromTo = r.startDate === r.endDate ? r.startDate : r.startDate + ' → ' + r.endDate;
        var cancelBtn = (r.status === 'pending')
          ? ' <button onclick="Leave._cancelMine(\'' + r.id + '\')" style="border:none;background:none;color:#c62828;font-size:0.75rem;cursor:pointer;">' + _T('בטל','ยกเลิก','إلغاء') + '</button>'
          : '';
        html += '<div style="border:1px solid #e0e0e0;border-radius:8px;padding:10px;margin-bottom:6px;font-size:0.85rem;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;">' +
            '<div>' + typeLabel(r.type) + ' · ' + r.days + ' ' + _T('ימים','วัน','أيام') + '</div>' + statusBadge(r.status) +
          '</div>' +
          '<div style="font-size:0.78rem;color:#666;margin-top:2px;">' + fromTo + cancelBtn + '</div>' +
          (r.reason ? '<div style="font-size:0.75rem;color:#888;margin-top:2px;">' + r.reason + '</div>' : '') +
          (r.rejectionReason ? '<div style="font-size:0.75rem;color:#c62828;margin-top:2px;">⚠️ ' + r.rejectionReason + '</div>' : '') +
        '</div>';
      });
      c.innerHTML = html;
    });
  }

  function showRequestForm() {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    var today = new Date().toISOString().slice(0, 10);
    var typeOpts = Object.keys(LEAVE_TYPES).map(function(k) {
      var lt = LEAVE_TYPES[k];
      return '<option value="' + k + '">' + lt.icon + ' ' + _T(lt.he, lt.th, lt.ar) + '</option>';
    }).join('');
    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:18px;width:94%;max-width:380px;max-height:90vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">➕ ' + _T('בקשת חופשה','ขอลา','طلب إجازة') + '</h3>' +

        '<label style="font-size:0.8rem;color:#666;">' + _T('סוג','ประเภท','النوع') + '</label>' +
        '<select id="leaveType" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:8px;font-family:inherit;">' + typeOpts + '</select>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
          '<div><label style="font-size:0.8rem;color:#666;">' + _T('מתאריך','จาก','من تاريخ') + '</label>' +
          '<input type="date" id="leaveStart" value="' + today + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '<div><label style="font-size:0.8rem;color:#666;">' + _T('עד תאריך','ถึง','إلى تاريخ') + '</label>' +
          '<input type="date" id="leaveEnd" value="' + today + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
        '</div>' +

        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
          '<div><label style="font-size:0.8rem;color:#666;">' + _T('יום ראשון','วันแรก','يوم البداية') + '</label>' +
          '<select id="leaveStartDay" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' +
            '<option value="full">' + _T('יום מלא','ทั้งวัน','يوم كامل') + '</option>' +
            '<option value="am">' + _T('חצי - בוקר','ครึ่งเช้า','صباحاً') + '</option>' +
            '<option value="pm">' + _T('חצי - אחה"צ','ครึ่งบ่าย','بعد الظهر') + '</option>' +
          '</select></div>' +
          '<div><label style="font-size:0.8rem;color:#666;">' + _T('יום אחרון','วันสุดท้าย','يوم النهاية') + '</label>' +
          '<select id="leaveEndDay" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' +
            '<option value="full">' + _T('יום מלא','ทั้งวัน','يوم كامل') + '</option>' +
            '<option value="am">' + _T('חצי - בוקר','ครึ่งเช้า','صباحاً') + '</option>' +
            '<option value="pm">' + _T('חצי - אחה"צ','ครึ่งบ่าย','بعد الظهر') + '</option>' +
          '</select></div>' +
        '</div>' +

        '<label style="font-size:0.8rem;color:#666;">' + _T('סיבה / פרטים','เหตุผล','السبب') + '</label>' +
        '<textarea id="leaveReason" rows="2" placeholder="' + _T('אופציונלי','ไม่บังคับ','اختياري') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:8px;font-family:inherit;font-size:0.88rem;resize:vertical;"></textarea>' +

        '<div id="leaveDaysPreview" style="font-size:0.8rem;color:#666;margin-bottom:10px;"></div>' +

        '<div style="display:flex;gap:8px;">' +
          '<button onclick="Leave._submitFromForm()" style="flex:1;padding:11px;border-radius:10px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📤 ' + _T('שלח','ส่ง','إرسال') + '</button>' +
          '<button onclick="Leave.showMyLeave()" style="flex:1;padding:11px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + _T('חזור','กลับ','رجوع') + '</button>' +
        '</div>' +
      '</div></div>';

    ['leaveStart','leaveEnd','leaveStartDay','leaveEndDay','leaveType'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', _updateDaysPreview);
    });
    _updateDaysPreview();
  }

  function _updateDaysPreview() {
    var c = document.getElementById('leaveDaysPreview');
    if (!c) return;
    var s = document.getElementById('leaveStart').value;
    var e = document.getElementById('leaveEnd').value;
    var sh = document.getElementById('leaveStartDay').value;
    var eh = document.getElementById('leaveEndDay').value;
    var username = window.currentUser && window.currentUser.username;
    var schedule = (typeof Schedule !== 'undefined' && username) ? Schedule.getForUser(username) : null;

    loadHolidayMap().then(function(holMap) {
      var days = countLeaveDays(s, e, sh, eh, schedule, holMap);
      c.innerHTML = '📅 ' + _T('סה"כ ימי עבודה','รวมวันทำงาน','إجمالي أيام العمل') + ': <strong>' + days + '</strong>';
    });
  }

  function _submitFromForm() {
    var username = window.currentUser && window.currentUser.username;
    if (!username) return;
    var type = document.getElementById('leaveType').value;
    var startDate = document.getElementById('leaveStart').value;
    var endDate = document.getElementById('leaveEnd').value;
    var startDay = document.getElementById('leaveStartDay').value;
    var endDay = document.getElementById('leaveEndDay').value;
    var reason = document.getElementById('leaveReason').value.trim();
    if (!startDate || !endDate) {
      if (typeof showToast === 'function') showToast('❌ ' + _T('חסר תאריך','ขาดวันที่','تاريخ ناقص'));
      return;
    }
    if (endDate < startDate) {
      if (typeof showToast === 'function') showToast('❌ ' + _T('תאריך סיום לפני תחילה','วันที่สิ้นสุดก่อนเริ่ม','تاريخ النهاية قبل البداية'));
      return;
    }
    var schedule = (typeof Schedule !== 'undefined') ? Schedule.getForUser(username) : null;
    loadHolidayMap().then(function(holMap) {
      var days = countLeaveDays(startDate, endDate, startDay, endDay, schedule, holMap);
      if (days <= 0) {
        if (typeof showToast === 'function') showToast('❌ ' + _T('אין ימי עבודה בטווח','ไม่มีวันทำงานในช่วงนี้','لا أيام عمل في النطاق'));
        return;
      }
      // Check balance — pending is computed live since it's no longer
      // stored on shorashim-users (workers can't write that doc).
      var bal = getBalance(username);
      var lt = LEAVE_TYPES[type];
      var balanceCheck = (lt.usesBalance === 'vacation' || lt.usesBalance === 'sick')
        ? getPendingDaysAsync(username, type)
        : Promise.resolve(0);

      balanceCheck.then(function(alreadyPending) {
        if (lt.usesBalance === 'vacation') {
          var v = effectiveVacation(bal);
          var avail = Math.max(0, v.available - alreadyPending);
          if (avail < days) {
            if (typeof showToast === 'function') showToast('⚠️ ' + _T('יתרת חופשה לא מספיקה','พักร้อนไม่พอ','رصيد الإجازة غير كافٍ') + ' (' + avail + ')');
            return;
          }
        } else if (lt.usesBalance === 'sick') {
          var sk = effectiveSick(bal);
          var savail = Math.max(0, sk.available - alreadyPending);
          if (savail < days) {
            if (typeof showToast === 'function') showToast('⚠️ ' + _T('יתרת מחלה לא מספיקה','ลาป่วยไม่พอ','رصيد المرضية غير كافٍ'));
            return;
          }
        }
        submitRequest({
          username: username,
          userName: window.currentUser.name || username,
          type: type, startDate: startDate, endDate: endDate, days: days,
          startDay: startDay, endDay: endDay, reason: reason || null
        }).then(function() {
          if (typeof showToast === 'function') showToast('✅ ' + _T('הבקשה נשלחה','ส่งคำขอแล้ว','تم إرسال الطلب'));
          showMyLeave();
        }).catch(function(err) {
          if (typeof showToast === 'function') showToast('❌ ' + err.message);
        });
      });
    });
  }

  function _cancelMine(reqId) {
    if (!confirm(_T('לבטל את הבקשה?','ยกเลิกคำขอ?','إلغاء الطلب؟'))) return;
    cancel(reqId).then(function() {
      if (typeof showToast === 'function') showToast('✅ ' + _T('בוטל','ยกเลิกแล้ว','ملغى'));
      showMyLeave();
    });
  }

  // ── Manager: approval queue ──
  function showApprovalQueue() {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:560px;max-height:90vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">✅ ' + _T('תור אישורים','คิวอนุมัติ','قائمة الاعتماد') + '</h3>' +
        '<div id="approvalQueueContent" style="color:#999;text-align:center;padding:14px;">' + _T('טוען...','กำลังโหลด...','جاري التحميل...') + '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:10px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + _T('סגור','ปิด','إغلاق') + '</button>' +
      '</div></div>';

    listPending().then(function(rows) {
      var c = document.getElementById('approvalQueueContent');
      if (!c) return;
      if (!rows.length) {
        c.innerHTML = '<div style="color:#999;padding:20px;">🎉 ' + _T('אין בקשות ממתינות','ไม่มีคำขอรอ','لا طلبات معلقة') + '</div>';
        return;
      }
      c.innerHTML = rows.map(function(r) {
        var lt = LEAVE_TYPES[r.type];
        var typeLabel = lt ? (lt.icon + ' ' + _T(lt.he, lt.th, lt.ar)) : r.type;
        var range = r.startDate === r.endDate ? r.startDate : r.startDate + ' → ' + r.endDate;
        return '<div style="border:1px solid #ffe0b2;border-radius:10px;padding:10px;margin-bottom:8px;background:#fffbf0;">' +
          '<div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:4px;">' +
            '<div><strong>' + (r.userName || r.username) + '</strong> · ' + typeLabel + '</div>' +
            '<div style="font-size:0.78rem;color:#666;">' + r.days + ' ' + _T('ימים','วัน','أيام') + '</div>' +
          '</div>' +
          '<div style="font-size:0.82rem;color:#666;margin-bottom:6px;">' + range + '</div>' +
          (r.reason ? '<div style="font-size:0.78rem;color:#555;margin-bottom:6px;padding:6px 8px;background:#fff;border-radius:6px;">' + r.reason + '</div>' : '') +
          '<div style="display:flex;gap:6px;">' +
            '<button onclick="Leave._approveOne(\'' + r.id + '\')" style="flex:1;padding:8px;border-radius:8px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;font-size:0.82rem;cursor:pointer;">✅ ' + _T('אשר','อนุมัติ','اعتماد') + '</button>' +
            '<button onclick="Leave._rejectOne(\'' + r.id + '\')" style="flex:1;padding:8px;border-radius:8px;border:none;background:#c62828;color:white;font-family:inherit;font-weight:700;font-size:0.82rem;cursor:pointer;">❌ ' + _T('דחה','ปฏิเสธ','رفض') + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
    });
  }

  function _approveOne(reqId) {
    var actor = window.currentUser && window.currentUser.username;
    approve(reqId, actor).then(function() {
      if (typeof showToast === 'function') showToast('✅ ' + _T('אושר','อนุมัติแล้ว','تمت الموافقة'));
      showApprovalQueue();
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  function _rejectOne(reqId) {
    var reason = prompt(_T('סיבת דחייה (חובה):','เหตุผลในการปฏิเสธ (จำเป็น):','سبب الرفض (مطلوب):'));
    if (reason == null) return;
    reason = reason.trim();
    if (!reason) {
      if (typeof showToast === 'function') showToast('❌ ' + _T('חייב לציין סיבה','ต้องระบุเหตุผล','يجب ذكر السبب'));
      return;
    }
    var actor = window.currentUser && window.currentUser.username;
    reject(reqId, actor, reason).then(function() {
      if (typeof showToast === 'function') showToast('✅ ' + _T('נדחה','ปฏิเสธแล้ว','تم الرفض'));
      showApprovalQueue();
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  // ── Admin: holiday calendar import ──
  function showHolidayAdmin() {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    var year = getCurrentYear();
    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:440px;max-height:88vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">🎉 ' + _T('יומן חגי ישראל','ปฏิทินวันหยุดอิสราเอล','تقويم الأعياد الإسرائيلية') + '</h3>' +
        '<div id="holidayContent" style="color:#999;text-align:center;padding:14px;">' + _T('טוען...','กำลังโหลด...','جاري التحميل...') + '</div>' +
        '<div style="display:flex;gap:8px;margin-top:12px;">' +
          '<button onclick="Leave._importHolidaysNow()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📥 ' + _T('ייבא מ-Hebcal','นำเข้าจาก Hebcal','استيراد من Hebcal') + '</button>' +
          '<button onclick="Leave._generateHolidayEntriesNow()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;">⚙️ ' + _T('צור רשומות','สร้างรายการ','إنشاء سجلات') + '</button>' +
        '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:8px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + _T('סגור','ปิด','إغلاق') + '</button>' +
      '</div></div>';
    loadHolidayMap(year).then(function(map) {
      var c = document.getElementById('holidayContent');
      if (!c) return;
      var keys = Object.keys(map).sort();
      if (!keys.length) {
        c.innerHTML = '<div style="color:#999;">' + _T('לא קיימים נתונים — לחץ "ייבא מ-Hebcal"','ยังไม่มีข้อมูล - กด "นำเข้าจาก Hebcal"','لا توجد بيانات — اضغط "استيراد من Hebcal"') + '</div>';
        return;
      }
      c.innerHTML = '<div style="font-size:0.82rem;text-align:start;">' + keys.map(function(d) {
        return '<div style="padding:5px 0;border-bottom:1px solid #f0f0f0;">📅 ' + d + ' — ' + (map[d].name_he || '') + '</div>';
      }).join('') + '</div>';
    });
  }

  function _importHolidaysNow() {
    if (typeof showToast === 'function') showToast('📥 ' + _T('מייבא חגי ישראל...','กำลังนำเข้า...','جاري الاستيراد...'));
    fetchAndCacheHolidays(getCurrentYear()).then(function() {
      if (typeof showToast === 'function') showToast('✅ ' + _T('הייבוא הושלם','นำเข้าเสร็จสิ้น','اكتمل الاستيراد'));
      showHolidayAdmin();
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  function _generateHolidayEntriesNow() {
    if (!confirm(_T('ליצור רשומות חופש לחגים?','สร้างรายการลาวันหยุด?','إنشاء سجلات إجازة العيد؟'))) return;
    if (typeof showToast === 'function') showToast('⚙️ ' + _T('יוצר רשומות...','กำลังสร้าง...','جاري الإنشاء...'));
    generateHolidayEntries(getCurrentYear()).then(function(count) {
      if (typeof showToast === 'function') showToast('✅ ' + count + ' ' + _T('רשומות נוצרו','สร้างแล้ว','تم إنشاؤها'));
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  // Public API
  return {
    LEAVE_TYPES: LEAVE_TYPES,
    vacationByTenure: vacationByTenure,
    tenureYears: tenureYears,
    getBalance: getBalance,
    effectiveVacation: effectiveVacation,
    effectiveSick: effectiveSick,
    countLeaveDays: countLeaveDays,
    submitRequest: submitRequest,
    getPendingDaysAsync: getPendingDaysAsync,
    listForUser: listForUser,
    listPending: listPending,
    approve: approve,
    reject: reject,
    cancel: cancel,
    loadHolidayMap: loadHolidayMap,
    fetchAndCacheHolidays: fetchAndCacheHolidays,
    generateHolidayEntries: generateHolidayEntries,
    // UI
    showMyLeave: showMyLeave,
    showRequestForm: showRequestForm,
    showApprovalQueue: showApprovalQueue,
    showHolidayAdmin: showHolidayAdmin,
    _submitFromForm: _submitFromForm,
    _cancelMine: _cancelMine,
    _approveOne: _approveOne,
    _rejectOne: _rejectOne,
    _importHolidaysNow: _importHolidaysNow,
    _generateHolidayEntriesNow: _generateHolidayEntriesNow
  };
})();
