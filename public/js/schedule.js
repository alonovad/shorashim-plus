// ── SCHEDULE & OVERTIME MODULE (Meckano upgrade — Phase 3) ──
//
// Three concerns live here:
//   1. Schedule data model & CRUD (stored as a property on each user doc;
//      no separate Firestore collection — no rules change required).
//   2. Pure OT calculation engine (calcOTTiers) — deterministic given
//      inputs, no side effects. Used at punch-out time AND in reports.
//   3. UI: schedule editor (operator+) and personal schedule viewer.
//
// IMPORTANT: this code calculates pay. Any bug here results in workers
// being paid wrong. The engine is split out specifically so it can be
// unit-tested in isolation. Always run the algorithm in your head on
// edge cases (off days, midnight-crossing shifts, partial weeks) before
// touching it.

var Schedule = (function() {
  'use strict';

  // ── Sector presets ──
  // Agriculture is the default per the locked Phase 3 decisions. Workers
  // can be overridden per-employee in the schedule editor. Adding a new
  // preset = add a key to OT_PRESETS and to the sector picker UI below.

  var OT_PRESETS = {
    agriculture: {
      label_he: 'חקלאות',
      label_th: 'เกษตรกรรม',
      label_ar: 'زراعة',
      daily125Hours: 2,         // first 2 OT hours @ 125%
      daily150After: 2,         // hours past that @ 150%
      nightStartHour: 22,
      nightEndHour: 6,
      nightBonusMinHours: 4,    // surcharge applies if night hours ≥ this
      weeklyCapHours: 42,
      saturdayMultiplier: 1.5,  // Sat work = 150% from hour 1
      restDayMultiplier: 1.5,   // any off-day work
      graceMinutes: 15
    },
    office: {
      label_he: 'משרד',
      label_th: 'สำนักงาน',
      label_ar: 'مكتب',
      daily125Hours: 2,
      daily150After: 2,
      nightStartHour: 22,
      nightEndHour: 6,
      nightBonusMinHours: 4,
      weeklyCapHours: 42,
      saturdayMultiplier: 1.5,
      restDayMultiplier: 1.5,
      graceMinutes: 10
    }
  };

  // Default schedule template (Israeli 5-day week, Sun-Thu standard,
  // short Friday, Saturday off). Times in 24h "HH:MM".
  var DEFAULT_SCHEDULE = {
    workWeek: 5,
    weeklyHours: 42,
    sectorPreset: 'agriculture',
    otRulesOverride: null,        // null = use sector preset
    schedule: {
      sun: { start: '06:00', end: '15:00', breakMinutes: 30 },
      mon: { start: '06:00', end: '15:00', breakMinutes: 30 },
      tue: { start: '06:00', end: '15:00', breakMinutes: 30 },
      wed: { start: '06:00', end: '15:00', breakMinutes: 30 },
      thu: { start: '06:00', end: '15:00', breakMinutes: 30 },
      fri: { start: '06:00', end: '12:00', breakMinutes: 0 },
      sat: null
    },
    flexibility: { graceMinutes: 15 },
    effectiveFrom: null,
    effectiveTo: null
  };

  var DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // ── Schedule CRUD ──

  function getForUser(username) {
    if (!username || typeof users === 'undefined') return cloneDefault();
    var u = users[username];
    if (!u || !u.schedule) return cloneDefault();
    // Merge stored schedule with defaults so a partial schedule doesn't
    // crash callers expecting every day to exist.
    return _mergeSchedule(cloneDefault(), u.schedule);
  }

  function saveForUser(username, schedule) {
    if (typeof users === 'undefined' || !users[username]) return Promise.reject(new Error('User not found'));
    users[username].schedule = _stripUndefined(schedule);
    if (typeof DB !== 'undefined') {
      DB.save('shorashim-users', users);
    }
    return Promise.resolve();
  }

  function getOTRules(schedule) {
    if (!schedule) schedule = cloneDefault();
    if (schedule.otRulesOverride) {
      // Merge override on top of the sector preset so partial overrides work.
      var base = OT_PRESETS[schedule.sectorPreset || 'agriculture'] || OT_PRESETS.agriculture;
      return Object.assign({}, base, schedule.otRulesOverride);
    }
    return OT_PRESETS[schedule.sectorPreset || 'agriculture'] || OT_PRESETS.agriculture;
  }

  function cloneDefault() { return JSON.parse(JSON.stringify(DEFAULT_SCHEDULE)); }

  function _mergeSchedule(base, override) {
    if (!override) return base;
    var out = JSON.parse(JSON.stringify(base));
    Object.keys(override).forEach(function(k) {
      if (k === 'schedule' && override.schedule) {
        DAY_KEYS.forEach(function(d) {
          if (override.schedule[d] !== undefined) out.schedule[d] = override.schedule[d];
        });
      } else {
        out[k] = override[k];
      }
    });
    return out;
  }

  function _stripUndefined(obj) { return JSON.parse(JSON.stringify(obj)); }

  // ── OT calculation engine (pure function) ──
  //
  // Inputs:
  //   punchInMs, punchOutMs — shift bounds (millis since epoch)
  //   paidMinutes           — minutes worked NET of breaks
  //   schedule              — full schedule object (from getForUser)
  //   dateStr               — 'YYYY-MM-DD' of the shift date
  //
  // Output:
  //   {
  //     hoursRegular, hours125, hours150,
  //     hoursNight,           // separate count — additive surcharge bucket
  //     expectedHours,        // what the schedule says they should do
  //     late, earlyLeave,     // booleans (vs. schedule.flexibility.graceMinutes)
  //     scheduleWarnings,     // array of string codes
  //     offDay                // true if dayOfWeek had no schedule (sat for 5-day, etc.)
  //   }

  function calcOTTiers(punchInMs, punchOutMs, paidMinutes, schedule, dateStr) {
    // Defensive: bad inputs produce safe zero output rather than garbage.
    // Negative paidMinutes can happen if a record was edited so punch-out
    // is before punch-in. The engine returns zeros + a 'data_error' warning
    // so the manager dashboard surfaces it for cleanup.
    if (paidMinutes == null || paidMinutes < 0 || !punchInMs || !punchOutMs || punchOutMs <= punchInMs) {
      return {
        hoursRegular: 0, hours125: 0, hours150: 0, hoursNight: 0,
        expectedHours: 0, late: false, earlyLeave: false,
        scheduleWarnings: ['data_error'], offDay: false
      };
    }
    var rules = getOTRules(schedule);
    var dayOfWeek = new Date(dateStr + 'T00:00:00').getDay();
    var dayKey = DAY_KEYS[dayOfWeek];
    var daySchedule = schedule.schedule[dayKey];

    var paidHours = (paidMinutes || 0) / 60;
    var hoursNight = countNightHours(punchInMs, punchOutMs, rules);
    var warnings = [];

    // ── Off-day work ── all paid hours at OT 150% (or restDayMultiplier).
    // Israeli law treats work on weekly rest day differently from regular OT —
    // it's compensated at 150% from hour one. We map it to hours150 so payroll
    // can apply the right multiplier downstream.
    if (!daySchedule) {
      warnings.push('off_day_work');
      return {
        hoursRegular: 0,
        hours125: 0,
        hours150: paidHours,
        hoursNight: hoursNight,
        expectedHours: 0,
        late: false,
        earlyLeave: false,
        scheduleWarnings: warnings,
        offDay: true
      };
    }

    // ── Regular workday ──
    var expectedHours = _hoursBetween(daySchedule.start, daySchedule.end)
                        - ((daySchedule.breakMinutes || 0) / 60);
    if (expectedHours < 0) expectedHours = 0;

    var hoursRegular = Math.min(paidHours, expectedHours);
    var ot = Math.max(0, paidHours - expectedHours);
    var cap125 = rules.daily125Hours || 2;
    var hours125 = Math.min(ot, cap125);
    var hours150 = Math.max(0, ot - cap125);

    // ── Late/early detection ──
    var grace = (schedule.flexibility && schedule.flexibility.graceMinutes != null)
              ? schedule.flexibility.graceMinutes
              : (rules.graceMinutes || 15);
    var expectedStartMs = _parseDayTime(dateStr, daySchedule.start);
    var expectedEndMs   = _parseDayTime(dateStr, daySchedule.end);
    var late = (punchInMs - expectedStartMs) > grace * 60000;
    var earlyLeave = (expectedEndMs - punchOutMs) > grace * 60000;
    if (late) warnings.push('late_arrival');
    if (earlyLeave) warnings.push('early_leave');

    return {
      hoursRegular: _round(hoursRegular, 2),
      hours125: _round(hours125, 2),
      hours150: _round(hours150, 2),
      hoursNight: _round(hoursNight, 2),
      expectedHours: _round(expectedHours, 2),
      late: late,
      earlyLeave: earlyLeave,
      scheduleWarnings: warnings,
      offDay: false
    };
  }

  // Count hours between [startMs, endMs] that fall in the night window
  // (e.g., 22:00–06:00). Iterates per-day to handle multi-day shifts.
  function countNightHours(startMs, endMs, rules) {
    if (!startMs || !endMs || endMs <= startMs) return 0;
    var nightStart = rules.nightStartHour != null ? rules.nightStartHour : 22;
    var nightEnd   = rules.nightEndHour   != null ? rules.nightEndHour   : 6;
    var totalMs = 0;
    var safety = 0;
    // Anchor at the start of the day BEFORE the shift starts (handle
    // shifts that begin in the night window).
    var anchor = new Date(startMs);
    anchor.setHours(0, 0, 0, 0);
    anchor.setDate(anchor.getDate() - 1);
    while (anchor.getTime() < endMs && safety++ < 32) {
      // Each iteration considers the night window starting on this anchor day.
      var winStart = new Date(anchor); winStart.setHours(nightStart, 0, 0, 0);
      var winEnd   = new Date(anchor); winEnd.setHours(nightEnd, 0, 0, 0);
      if (nightEnd <= nightStart) winEnd.setDate(winEnd.getDate() + 1);
      var s = Math.max(startMs, winStart.getTime());
      var e = Math.min(endMs, winEnd.getTime());
      if (e > s) totalMs += (e - s);
      anchor.setDate(anchor.getDate() + 1);
    }
    return totalMs / 3600000;
  }

  function _hoursBetween(startHHMM, endHHMM) {
    var s = _parseHHMM(startHHMM);
    var e = _parseHHMM(endHHMM);
    if (s == null || e == null) return 0;
    var hours = e - s;
    if (hours < 0) hours += 24; // overnight (rare for ag)
    return hours;
  }

  function _parseHHMM(hhmm) {
    if (!hhmm) return null;
    var parts = hhmm.split(':');
    if (parts.length !== 2) return null;
    return parseInt(parts[0]) + parseInt(parts[1]) / 60;
  }

  function _parseDayTime(dateStr, hhmm) {
    return new Date(dateStr + 'T' + hhmm + ':00').getTime();
  }

  function _round(n, places) {
    var p = Math.pow(10, places || 2);
    return Math.round(n * p) / p;
  }

  // ── Weekly summary ──
  // Aggregates records for a given username across a week and reports
  // totals, expected, and OT cap status. Used by the progress widget and
  // by Phase 5 monthly timesheets.

  function getWeeklySummary(username, weekStartMs) {
    var weekEndMs = weekStartMs + 7 * 86400000;
    if (typeof db === 'undefined') return Promise.resolve(null);
    return db.collection('timeclock')
      .where('username', '==', username)
      .where('punchIn', '>=', weekStartMs)
      .where('punchIn', '<', weekEndMs)
      .get()
      .then(function(snap) {
        var totals = {
          hoursRegular: 0, hours125: 0, hours150: 0, hoursNight: 0,
          paidMinutes: 0, expectedMinutes: 0,
          recordsCount: snap.size, lateCount: 0, earlyLeaveCount: 0
        };
        var schedule = getForUser(username);
        // Expected weekly minutes from the schedule template
        DAY_KEYS.forEach(function(d) {
          var ds = schedule.schedule[d];
          if (!ds) return;
          totals.expectedMinutes += (_hoursBetween(ds.start, ds.end) * 60) - (ds.breakMinutes || 0);
        });
        snap.forEach(function(doc) {
          var r = doc.data();
          totals.paidMinutes += (r.paidMinutes != null ? r.paidMinutes : Math.round((r.duration || 0) / 60000));
          totals.hoursRegular += r.hoursRegular || 0;
          totals.hours125     += r.hours125 || 0;
          totals.hours150     += r.hours150 || 0;
          totals.hoursNight   += r.hoursNight || 0;
          if (r.scheduleWarnings && r.scheduleWarnings.indexOf('late_arrival') !== -1) totals.lateCount++;
          if (r.scheduleWarnings && r.scheduleWarnings.indexOf('early_leave') !== -1) totals.earlyLeaveCount++;
        });
        return totals;
      })
      .catch(function(err) {
        console.warn('Weekly summary failed:', err.message);
        return null;
      });
  }

  function getCurrentWeekStartMs() {
    // Israeli week starts Sunday (getDay() === 0).
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    while (d.getDay() !== 0) d.setDate(d.getDate() - 1);
    return d.getTime();
  }

  // ── Progress widget ──
  // Renders into a target element id. Shows today expected vs paid,
  // and weekly totals with OT tier breakdown.

  function renderProgressCard(elementId, username) {
    var el = document.getElementById(elementId);
    if (!el) return;
    username = username || (window.currentUser && window.currentUser.username);
    if (!username) { el.innerHTML = ''; return; }
    var schedule = getForUser(username);
    var weekStartMs = getCurrentWeekStartMs();

    el.innerHTML = '<div style="padding:14px;text-align:center;color:#999;font-size:0.85rem;">⏳ ' +
      (typeof tt === 'function' ? tt('טוען...','กำลังโหลด...','جاري التحميل...') : 'Loading...') + '</div>';

    getWeeklySummary(username, weekStartMs).then(function(s) {
      if (!s) { el.innerHTML = ''; return; }
      var paidH = (s.paidMinutes / 60).toFixed(1);
      var expH = (s.expectedMinutes / 60).toFixed(1);
      var pct = s.expectedMinutes > 0 ? Math.min(100, Math.round(100 * s.paidMinutes / s.expectedMinutes)) : 0;
      var T = (typeof tt === 'function') ? tt : function(h) { return h; };
      el.innerHTML =
        '<div style="background:linear-gradient(135deg,#e8f5e9,#c8e6c9);border-radius:12px;padding:14px;margin-bottom:12px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;">' +
            '<div style="font-weight:700;font-size:0.9rem;">📊 ' + T('השבוע שלי','สัปดาห์ของฉัน','أسبوعي') + '</div>' +
            '<div style="font-size:0.78rem;color:#2e7d32;font-weight:700;">' + paidH + ' / ' + expH + ' ' + T('שעות','ชั่วโมง','ساعات') + '</div>' +
          '</div>' +
          '<div style="height:8px;background:#fff;border-radius:4px;overflow:hidden;margin-bottom:8px;">' +
            '<div style="height:100%;width:' + pct + '%;background:linear-gradient(90deg,#2e7d32,#66bb6a);"></div>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;font-size:0.7rem;text-align:center;">' +
            '<div><div style="font-weight:700;color:#1b5e20;">' + s.hoursRegular.toFixed(1) + '</div><div style="color:#666;">' + T('רגיל','ปกติ','عادي') + '</div></div>' +
            '<div><div style="font-weight:700;color:#ef6c00;">' + s.hours125.toFixed(1) + '</div><div style="color:#666;">125%</div></div>' +
            '<div><div style="font-weight:700;color:#c62828;">' + s.hours150.toFixed(1) + '</div><div style="color:#666;">150%</div></div>' +
          '</div>' +
          (s.lateCount > 0 || s.earlyLeaveCount > 0 ?
            '<div style="margin-top:8px;font-size:0.7rem;color:#ef6c00;">⚠️ ' +
              (s.lateCount > 0 ? s.lateCount + ' ' + T('איחורים','สาย','تأخيرات') + ' ' : '') +
              (s.earlyLeaveCount > 0 ? '· ' + s.earlyLeaveCount + ' ' + T('יציאות מוקדמות','ออกก่อน','مغادرات مبكرة') : '') +
            '</div>'
            : '') +
        '</div>';
    });
  }

  // ── Schedule editor UI (operator+) ──
  // Big modal with the weekly grid. Lets an admin set per-day start/end/break,
  // pick a sector preset, and tweak per-employee OT overrides.

  function showEditorForUser(username) {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    var user = (typeof users !== 'undefined') ? users[username] : null;
    if (!user) { if (typeof showToast === 'function') showToast('❌ User not found'); return; }
    var schedule = getForUser(username);
    var T = (typeof tt === 'function') ? tt : function(h) { return h; };

    var dayLabels = {
      sun: T('א\'','อา','الأحد'),
      mon: T('ב\'','จ','الاثنين'),
      tue: T('ג\'','อ','الثلاثاء'),
      wed: T('ד\'','พ','الأربعاء'),
      thu: T('ה\'','พฤ','الخميس'),
      fri: T('ו\'','ศ','الجمعة'),
      sat: T('שבת','ส','السبت')
    };

    var dayRows = DAY_KEYS.map(function(d) {
      var ds = schedule.schedule[d];
      var off = !ds;
      return '<div style="display:grid;grid-template-columns:42px 1fr 1fr 60px 28px;gap:6px;align-items:center;margin-bottom:4px;">' +
        '<div style="font-weight:700;text-align:center;font-size:0.82rem;">' + dayLabels[d] + '</div>' +
        '<input type="time" id="schStart_' + d + '" value="' + (ds ? ds.start : '') + '" ' + (off ? 'disabled' : '') + ' style="padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;font-size:0.85rem;">' +
        '<input type="time" id="schEnd_' + d + '" value="' + (ds ? ds.end : '') + '" ' + (off ? 'disabled' : '') + ' style="padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;font-size:0.85rem;">' +
        '<input type="number" id="schBreak_' + d + '" value="' + (ds ? (ds.breakMinutes || 0) : 0) + '" min="0" max="180" ' + (off ? 'disabled' : '') + ' placeholder="' + T('הפסקה','พัก','استراحة') + '" style="padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;font-size:0.78rem;">' +
        '<input type="checkbox" id="schOff_' + d + '" ' + (off ? 'checked' : '') + ' onchange="Schedule._toggleDayOff(\'' + d + '\')" title="' + T('יום חופש','วันหยุด','يوم عطلة') + '" style="margin:0;">' +
        '</div>';
    }).join('');

    var sectorOpts = Object.keys(OT_PRESETS).map(function(k) {
      var p = OT_PRESETS[k];
      var label = (currentLang === 'th' ? p.label_th : currentLang === 'ar' ? p.label_ar : p.label_he);
      var sel = (schedule.sectorPreset === k) ? ' selected' : '';
      return '<option value="' + k + '"' + sel + '>' + label + '</option>';
    }).join('');

    var rules = getOTRules(schedule);
    var hasOverride = !!schedule.otRulesOverride;

    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:18px;width:94%;max-width:480px;max-height:92vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:4px;">🗓 ' + T('לוח זמנים','ตารางเวลา','جدول العمل') + '</h3>' +
        '<div style="font-size:0.82rem;color:#666;margin-bottom:12px;">' + (user.name || user.username) + '</div>' +

        '<div style="font-size:0.78rem;color:#666;margin-bottom:4px;">' + T('מגזר (קובע ברירות מחדל למשעות נוספות)','ภาคส่วน (กำหนดค่าเริ่มต้น OT)','القطاع (يحدد القيم الافتراضية للساعات الإضافية)') + '</div>' +
        '<select id="schSector" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:14px;font-family:inherit;">' + sectorOpts + '</select>' +

        '<div style="display:grid;grid-template-columns:42px 1fr 1fr 60px 28px;gap:6px;font-size:0.7rem;color:#999;margin-bottom:4px;">' +
          '<div></div>' +
          '<div style="text-align:center;">' + T('כניסה','เข้า','دخول') + '</div>' +
          '<div style="text-align:center;">' + T('יציאה','ออก','خروج') + '</div>' +
          '<div style="text-align:center;">' + T('פסקה','พัก','ك.د') + '</div>' +
          '<div style="text-align:center;font-size:0.65rem;">' + T('חופש','หยุด','عطلة') + '</div>' +
        '</div>' +
        dayRows +

        '<div style="margin-top:14px;font-size:0.78rem;color:#666;">' + T('דקות מרווח לאיחור','นาทีผ่อนผันสาย','دقائق التسامح') + '</div>' +
        '<input type="number" id="schGrace" value="' + ((schedule.flexibility && schedule.flexibility.graceMinutes) || 15) + '" min="0" max="60" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:14px;font-family:inherit;">' +

        '<details style="margin-bottom:14px;">' +
          '<summary style="cursor:pointer;font-size:0.82rem;font-weight:700;color:#1565c0;padding:6px 0;">⚙️ ' + T('כללי שעות נוספות מותאמים אישית','กฎโอที กำหนดเอง','قواعد ساعات إضافية مخصصة') + (hasOverride ? ' ✓' : '') + '</summary>' +
          '<div style="background:#f5f5f5;border-radius:8px;padding:10px;font-size:0.78rem;">' +
            '<label style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
              '<input type="checkbox" id="schUseOverride" ' + (hasOverride ? 'checked' : '') + '>' +
              '<span>' + T('עקוף את ברירות המגזר','แทนที่ค่าเริ่มต้นภาคส่วน','تجاوز افتراضيات القطاع') + '</span>' +
            '</label>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">' +
              '<div><div style="color:#666;">125% ' + T('עד שעות','สูงสุดชั่วโมง','حتى ساعات') + '</div><input type="number" id="schOt125" value="' + rules.daily125Hours + '" min="0" max="6" step="0.5" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;"></div>' +
              '<div><div style="color:#666;">' + T('שעון לילה (החל מ-)','เวลากลางคืน (เริ่ม)','بداية الليل') + '</div><input type="number" id="schNightStart" value="' + rules.nightStartHour + '" min="18" max="23" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;"></div>' +
              '<div><div style="color:#666;">' + T('שעון לילה (עד)','เวลากลางคืน (สิ้น)','نهاية الليل') + '</div><input type="number" id="schNightEnd" value="' + rules.nightEndHour + '" min="0" max="10" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;"></div>' +
              '<div><div style="color:#666;">' + T('תקרה שבועית','สูงสุดต่อสัปดาห์','الحد الأسبوعي') + '</div><input type="number" id="schWeeklyCap" value="' + rules.weeklyCapHours + '" min="20" max="60" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '</div>' +
          '</div>' +
        '</details>' +

        '<div style="display:flex;gap:8px;">' +
          '<button onclick="Schedule._saveFromModal(\'' + username + '\')" style="flex:1;padding:12px;border-radius:10px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;cursor:pointer;">💾 ' + T('שמור','บันทึก','حفظ') + '</button>' +
          '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:12px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + T('ביטול','ยกเลิก','إلغاء') + '</button>' +
        '</div>' +
      '</div></div>';
  }

  function _toggleDayOff(dayKey) {
    var off = document.getElementById('schOff_' + dayKey).checked;
    ['schStart_', 'schEnd_', 'schBreak_'].forEach(function(prefix) {
      var el = document.getElementById(prefix + dayKey);
      if (el) el.disabled = off;
    });
  }

  function _saveFromModal(username) {
    var newSchedule = cloneDefault();
    newSchedule.sectorPreset = document.getElementById('schSector').value;
    DAY_KEYS.forEach(function(d) {
      var off = document.getElementById('schOff_' + d).checked;
      if (off) {
        newSchedule.schedule[d] = null;
      } else {
        newSchedule.schedule[d] = {
          start: document.getElementById('schStart_' + d).value,
          end:   document.getElementById('schEnd_' + d).value,
          breakMinutes: parseInt(document.getElementById('schBreak_' + d).value) || 0
        };
      }
    });
    newSchedule.flexibility = { graceMinutes: parseInt(document.getElementById('schGrace').value) || 15 };

    var useOverride = document.getElementById('schUseOverride').checked;
    if (useOverride) {
      newSchedule.otRulesOverride = {
        daily125Hours:   parseFloat(document.getElementById('schOt125').value) || 2,
        nightStartHour:  parseInt(document.getElementById('schNightStart').value) || 22,
        nightEndHour:    parseInt(document.getElementById('schNightEnd').value) || 6,
        weeklyCapHours:  parseInt(document.getElementById('schWeeklyCap').value) || 42
      };
    } else {
      newSchedule.otRulesOverride = null;
    }

    saveForUser(username, newSchedule).then(function() {
      document.getElementById('modalContainer').innerHTML = '';
      if (typeof showToast === 'function') showToast('✅ ' + ((typeof tt === 'function') ? tt('לוח הזמנים נשמר','บันทึกตารางแล้ว','تم حفظ الجدول') : 'Saved'));
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  // Picker: which user's schedule to edit. Operator+ only.
  function showUserPicker() {
    var modal = document.getElementById('modalContainer');
    if (!modal || typeof users === 'undefined') return;
    var T = (typeof tt === 'function') ? tt : function(h) { return h; };
    var rows = Object.keys(users).map(function(uname) {
      var u = users[uname];
      var has = u.schedule ? '✓' : '·';
      return '<button onclick="Schedule.showEditorForUser(\'' + uname + '\')" style="display:flex;justify-content:space-between;align-items:center;width:100%;padding:10px 14px;margin-bottom:4px;border-radius:8px;border:1px solid #e0e0e0;background:#fafafa;font-family:inherit;font-size:0.9rem;cursor:pointer;text-align:start;">' +
        '<span>' + (u.name || uname) + '</span>' +
        '<span style="font-size:0.78rem;color:#999;">' + has + ' ' + (u.role || 'worker') + '</span>' +
        '</button>';
    }).join('');
    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:18px;width:94%;max-width:380px;max-height:80vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">🗓 ' + T('לוחות זמנים','ตารางเวลา','جداول العمل') + '</h3>' +
        rows +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:8px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + T('סגור','ปิด','إغلاق') + '</button>' +
      '</div></div>';
  }

  return {
    // Constants
    OT_PRESETS: OT_PRESETS,
    DEFAULT_SCHEDULE: DEFAULT_SCHEDULE,
    DAY_KEYS: DAY_KEYS,
    // CRUD
    getForUser: getForUser,
    saveForUser: saveForUser,
    getOTRules: getOTRules,
    // OT engine
    calcOTTiers: calcOTTiers,
    countNightHours: countNightHours,
    // Reporting
    getWeeklySummary: getWeeklySummary,
    getCurrentWeekStartMs: getCurrentWeekStartMs,
    renderProgressCard: renderProgressCard,
    // UI
    showEditorForUser: showEditorForUser,
    showUserPicker: showUserPicker,
    _toggleDayOff: _toggleDayOff,
    _saveFromModal: _saveFromModal
  };
})();
