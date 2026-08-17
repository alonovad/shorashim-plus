// ── TIME CLOCK MODULE ──
// Punch in/out system with workplace titles
// Depends on: DB (db.js), firebase/firestore, currentUser

var TimeClock = (function() {
  'use strict';

  var clockInterval = null;
  var currentShift = null; // { punchIn: timestamp, workplace: string }
  var workplaces = []; // admin-defined list

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function init() {
    loadWorkplaces();
    loadCurrentShift();
    renderClockBar();
    if (currentShift) startTicker();
    startPresence();
  }

  // ── Data ──

  function loadWorkplaces() {
    var saved = localStorage.getItem('shorashim-workplaces');
    if (saved) workplaces = JSON.parse(saved);
    // Also load from Firestore
    if (typeof DB !== 'undefined') {
      DB.loadAsync('shorashim-workplaces').then(function(data) {
        if (data && Array.isArray(data)) {
          workplaces = data;
          localStorage.setItem('shorashim-workplaces', JSON.stringify(workplaces));
        }
      });
    }
  }

  function saveWorkplaces() {
    DB.save('shorashim-workplaces', workplaces);
  }

  function loadCurrentShift() {
    var saved = localStorage.getItem('shorashim-current-shift');
    if (saved) {
      try { currentShift = JSON.parse(saved); } catch(e) { currentShift = null; }
    }
  }

  function saveCurrentShift() {
    if (currentShift) {
      localStorage.setItem('shorashim-current-shift', JSON.stringify(currentShift));
    } else {
      localStorage.removeItem('shorashim-current-shift');
    }
  }

  function saveTimeRecord(record) {
    // Save to Firestore: timeclock/{date}_{username}_{index}
    var dateStr = new Date(record.punchIn).toISOString().slice(0, 10);
    var docId = dateStr + '_' + record.username + '_' + record.shiftIndex;

    // ── Phase 1 (Meckano upgrade): additive schema ──
    // All fields default to safe values so the existing aggregation
    // queries (which only know about punchIn/punchOut/duration/workplace)
    // keep working untouched. Old records without these fields are read
    // with the same fallbacks elsewhere in the codebase.
    var durationMs = record.duration || 0;
    var durationMin = Math.round(durationMs / 60000);
    var augmented = Object.assign({}, record, {
      // Location proof — Phase 2 will populate. Null means "not captured".
      punchInGeo:  record.punchInGeo  || null,
      punchOutGeo: record.punchOutGeo || null,
      geoVerified: record.geoVerified != null ? record.geoVerified : null,
      geoWarnings: record.geoWarnings || [],

      // Break tracking — Phase 2 will populate. Empty = no breaks taken.
      breaks: record.breaks || [],
      paidMinutes:  record.paidMinutes  != null ? record.paidMinutes  : durationMin,
      breakMinutes: record.breakMinutes != null ? record.breakMinutes : 0,

      // Categorisation — defaults to regular work, no project tag.
      type: record.type || 'regular',
      projectCode: record.projectCode || null,
      taskCode: record.taskCode || null,

      // Approval state — auto_approved keeps existing UX unchanged; Phase 3
      // introduces the manager approval queue.
      status: record.status || 'auto_approved',
      approvedBy: record.approvedBy || null,
      approvedAt: record.approvedAt || null,
      rejectionReason: null,

      // OT tiers — Phase 3 computes these from the schedule.
      hoursRegular: record.hoursRegular != null ? record.hoursRegular : (durationMs / 3600000),
      hours125: 0,
      hours150: 0,
      hoursNight: 0,

      // Verification metadata
      ipAddress: null, // we don't capture client IP from the browser
      device: _detectDevice(),

      // Edit audit (only set when an edit happens — see _saveEdit)
      originalPunchIn: null,
      originalPunchOut: null,
      editReason: null,

      // Schema version so future migrations can detect old/new records
      schemaVersion: 1
    });

    if (typeof db !== 'undefined') {
      db.collection('timeclock').doc(docId).set(augmented)
        .then(function() {
          console.log('Time record saved:', docId);
          if (!navigator.onLine && typeof showToast === 'function') {
            showToast('📴 ' + tt('הרשומה תסונכרן כשתחזור לאינטרנט',
                                 'จะซิงค์เมื่อกลับมาออนไลน์',
                                 'سيُزامن عند العودة للإنترنت'));
          }
        })
        .catch(function(err) { console.error('Time record save failed:', err); });
    }
  }

  // Detect device family — passed into the audit/schema fields.
  function _detectDevice() {
    var ua = navigator.userAgent || '';
    if (/Mobi|Android|iPhone|iPad/i.test(ua)) return 'mobile';
    return 'web';
  }

  // Expose custom workplaces for the Sites module
  function getCustomWorkplaces() {
    return workplaces.slice();
  }

  // ── Workplace List (from farms + custom) ──

  function getWorkplaceOptions() {
    // Merge farms + custom workplaces
    var options = [];
    // Add farms if available
    if (typeof farms !== 'undefined' && Array.isArray(farms)) {
      farms.forEach(function(f) {
        if (f.name) options.push(f.name);
      });
    }
    // Add custom workplaces
    workplaces.forEach(function(w) {
      if (options.indexOf(w) === -1) options.push(w);
    });
    return options;
  }

  // ─────────────────────────────────────────────────────────────
  // ── PHASE 2 (Meckano upgrade): geolocation + geofence + breaks
  // ─────────────────────────────────────────────────────────────

  // Get a GPS fix as a Promise. Resolves to {lat,lng,accuracy,source} on
  // success, or null on timeout/denial/error. Never rejects — the caller
  // gets null and decides how to proceed (we never block a punch on geo).
  function getGeoFix(timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    if (!navigator.geolocation) return Promise.resolve(null);
    return new Promise(function(resolve) {
      var done = false;
      var timer = setTimeout(function() {
        if (done) return;
        done = true;
        resolve(null);
      }, timeoutMs);
      navigator.geolocation.getCurrentPosition(
        function(pos) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy,
            source: 'gps',
            ts: Date.now()
          });
        },
        function(err) {
          if (done) return;
          done = true;
          clearTimeout(timer);
          console.warn('Geo error:', err.code, err.message);
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 30000 }
      );
    });
  }

  // Verify a captured geo fix against the workplace's geofence (if any).
  // Returns:
  //   { verified: true|false|null, warnings: [...] }
  // - verified=null: no geofence on the site, or no geo fix captured
  // - verified=true: GPS point falls inside the polygon (or within the
  //   per-plot radius buffer)
  // - verified=false: outside — punch is still allowed but flagged
  function verifyGeoFix(geoFix, workplaceName) {
    var warnings = [];
    if (!geoFix) {
      warnings.push('no_gps');
      return { verified: null, warnings: warnings };
    }
    if (geoFix.accuracy > 100) {
      warnings.push('low_accuracy');
    }
    if (typeof Sites === 'undefined') return { verified: null, warnings: warnings };
    var site = Sites.findByName(workplaceName);
    if (!site || !site.geofence) {
      // Custom workplace or farm umbrella — no geofence, can't verify.
      return { verified: null, warnings: warnings };
    }
    var inside = Sites.isInside(site, [geoFix.lat, geoFix.lng]);
    if (!inside) warnings.push('outside_geofence');
    return { verified: inside, warnings: warnings };
  }

  // ── Break tracking helpers ──
  // breaks live on currentShift.breaks = [{ start, end, type, auto }]
  function getActiveBreak() {
    if (!currentShift || !currentShift.breaks) return null;
    for (var i = currentShift.breaks.length - 1; i >= 0; i--) {
      if (currentShift.breaks[i].end == null) return currentShift.breaks[i];
    }
    return null;
  }

  function totalBreakMinutes(breaks) {
    if (!Array.isArray(breaks)) return 0;
    var ms = 0;
    breaks.forEach(function(b) {
      if (b && b.start && b.end) ms += (b.end - b.start);
    });
    return Math.round(ms / 60000);
  }

  function startBreak(type) {
    if (!currentShift) return;
    if (getActiveBreak()) return; // already on break — ignore
    currentShift.breaks = currentShift.breaks || [];
    currentShift.breaks.push({ start: Date.now(), end: null, type: type || 'short', auto: false });
    saveCurrentShift();
    renderClockBar();
    if (typeof showToast === 'function') {
      var labels = { lunch: tt('הפסקת אוכל','พักทานข้าว','استراحة طعام'),
                     short: tt('הפסקה קצרה','พักสั้น','استراحة قصيرة'),
                     personal: tt('הפסקה אישית','พักส่วนตัว','استراحة شخصية') };
      showToast('☕ ' + (labels[type] || type));
    }
  }

  function endBreak() {
    var active = getActiveBreak();
    if (!active) return;
    active.end = Date.now();
    saveCurrentShift();
    renderClockBar();
    var minutes = Math.round((active.end - active.start) / 60000);
    if (typeof showToast === 'function') {
      showToast('✅ ' + tt('הפסקה הסתיימה','สิ้นสุดการพัก','انتهت الاستراحة') + ' (' + minutes + ' ' + tt('דקות','นาที','دقيقة') + ')');
    }
  }

  // Modal: choose a break type. Called when the ☕ button is tapped.
  function showBreakTypeModal() {
    var modal = document.getElementById('modalContainer');
    var btn = function(type, icon, label) {
      return '<button onclick="TimeClock.startBreakAndClose(\'' + type + '\')" style="display:flex;align-items:center;gap:10px;width:100%;padding:14px;margin-bottom:6px;border-radius:10px;border:1px solid #e0d8d0;background:#faf8f5;font-family:inherit;font-size:0.95rem;font-weight:600;cursor:pointer;">' +
        '<span style="font-size:1.4rem;">' + icon + '</span><span style="flex:1;text-align:start;">' + label + '</span></button>';
    };
    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:340px;">' +
        '<h3 style="font-weight:700;margin-bottom:14px;">☕ ' + tt('סוג הפסקה','ประเภทการพัก','نوع الاستراحة') + '</h3>' +
        btn('lunch',    '🍽️', tt('הפסקת אוכל','พักทานข้าว','استراحة طعام')) +
        btn('short',    '⏸',  tt('הפסקה קצרה','พักสั้น','استراحة قصيرة')) +
        btn('personal', '👤', tt('הפסקה אישית','พักส่วนตัว','استراحة شخصية')) +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:10px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('ביטול','ยกเลิก','إلغاء') + '</button>' +
      '</div></div>';
  }

  function startBreakAndClose(type) {
    document.getElementById('modalContainer').innerHTML = '';
    startBreak(type);
  }

  // ── End Phase 2 helpers ──

  // ── Clock Bar (persistent top bar) ──

  function renderClockBar() {
    var bar = document.getElementById('clockBar');
    if (!bar) return;

    if (!window.currentUser) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';

    // Phase 1 (Meckano upgrade): show an offline pill so the user knows
    // their punch is queued by Firestore's local persistence layer rather
    // than silently lost. Re-rendered automatically on every state change.
    var offlinePill = (navigator.onLine === false)
      ? '<span title="' + tt('הרשומה תסונכרן כשתחזור לאינטרנט',
                              'จะซิงค์เมื่อกลับมาออนไลน์',
                              'سيُزامن عند العودة للإنترنت') +
        '" style="background:#ffb74d;color:#3e2723;font-weight:700;font-size:0.65rem;padding:2px 7px;border-radius:6px;margin-inline-end:6px;">📴 ' +
        tt('במצב לא מקוון','ออฟไลน์','غير متصل') + '</span>'
      : '';

    if (currentShift) {
      var elapsed = formatDuration(Date.now() - currentShift.punchIn);
      var active = getActiveBreak();
      if (active) {
        // ── On break: show resume + (no punch-out until break ends) ──
        var breakElapsed = formatDuration(Date.now() - active.start);
        var breakLabels = {
          lunch:    tt('בהפסקת אוכל','พักทานข้าว','استراحة طعام'),
          short:    tt('בהפסקה','พัก','استراحة'),
          personal: tt('בהפסקה אישית','พักส่วนตัว','استراحة شخصية')
        };
        bar.style.background = 'linear-gradient(135deg,#ffb74d,#ff9800)';
        bar.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
            offlinePill +
            '<span style="font-size:1.2rem;">☕</span>' +
            '<div>' +
              '<div style="font-weight:700;font-size:0.85rem;" id="clockElapsed">' + breakElapsed + '</div>' +
              '<div style="font-size:0.7rem;opacity:0.9;">' + (breakLabels[active.type] || active.type) + '</div>' +
            '</div>' +
          '</div>' +
          '<button onclick="TimeClock.endBreak()" style="padding:6px 14px;border-radius:8px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">' + tt('▶️ סיים הפסקה','▶️ สิ้นสุดพัก','▶️ إنهاء الاستراحة') + '</button>';
      } else {
        bar.style.background = '';
        bar.innerHTML =
          '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
            offlinePill +
            '<span style="font-size:1.2rem;">🟢</span>' +
            '<div>' +
              '<div style="font-weight:700;font-size:0.85rem;" id="clockElapsed">' + elapsed + '</div>' +
              '<div style="font-size:0.7rem;opacity:0.8;">' + (currentShift.workplace || '') + '</div>' +
            '</div>' +
          '</div>' +
          '<button onclick="TimeClock.showBreakTypeModal()" title="' + tt('התחל הפסקה','เริ่มพัก','بدء استراحة') + '" style="padding:6px 10px;border-radius:8px;border:none;background:#ff9800;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;margin-inline-end:4px;">☕</button>' +
          '<button onclick="TimeClock.punchOut()" style="padding:6px 14px;border-radius:8px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">' + tt('🔴 יציאה', '🔴 ออกงาน', '🔴 خروج') + '</button>';
      }
    } else {
      bar.style.background = '';
      bar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
          offlinePill +
          '<span style="font-size:1.2rem;">⚪</span>' +
          '<div style="font-size:0.85rem;font-weight:600;">' + tt('לא בשעון', 'ไม่ได้เข้างาน', 'غير مسجل') + '</div>' +
        '</div>' +
        '<button onclick="TimeClock.punchIn()" style="padding:6px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">' + tt('🟢 כניסה', '🟢 เข้างาน', '🟢 دخول') + '</button>';
    }
  }

  function startTicker() {
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(function() {
      var el = document.getElementById('clockElapsed');
      if (!el || !currentShift) return;
      var active = getActiveBreak();
      if (active) {
        el.textContent = formatDuration(Date.now() - active.start);
      } else {
        el.textContent = formatDuration(Date.now() - currentShift.punchIn);
      }
    }, 1000);
  }

  function stopTicker() {
    if (clockInterval) { clearInterval(clockInterval); clockInterval = null; }
  }

  function formatDuration(ms) {
    var totalSec = Math.floor(ms / 1000);
    var h = Math.floor(totalSec / 3600);
    var m = Math.floor((totalSec % 3600) / 60);
    var s = totalSec % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  function formatTime(ts) {
    var d = new Date(ts);
    var h = d.getHours();
    var m = d.getMinutes();
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function formatDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString((typeof currentLang !== 'undefined' && currentLang === 'th') ? 'th-TH' : (typeof currentLang !== 'undefined' && currentLang === 'ar') ? 'ar-SA' : 'he-IL');
  }

  // ── Punch In ──

  function punchIn() {
    // Check if this is a second+ shift today — need workplace selection
    getTodayShiftCount(function(count) {
      if (count === 0) {
        // First shift — show workplace picker
        showWorkplacePicker(function(workplace) {
          doPunchIn(workplace);
        });
      } else {
        // Additional shift — force new workplace
        showWorkplacePicker(function(workplace) {
          doPunchIn(workplace);
        }, true);
      }
    });
  }

  function doPunchIn(workplace) {
    getTodayShiftCount(function(count) {
      if (typeof showToast === 'function') {
        showToast('📍 ' + tt('מאתר מיקום...','กำลังระบุตำแหน่ง...','جاري تحديد الموقع...'));
      }
      getGeoFix(10000).then(function(geo) {
        var v = verifyGeoFix(geo, workplace);
        currentShift = {
          punchIn: Date.now(),
          workplace: workplace,
          username: window.currentUser.username,
          userName: window.currentUser.name,
          shiftIndex: count,
          // ── Phase 2: geo state carried through the shift ──
          punchInGeo: geo,
          geoVerified: v.verified,
          geoWarnings: v.warnings.slice(),
          breaks: []
        };
        saveCurrentShift();
        _presenceBeat();
        renderClockBar();
        startTicker();
        if (typeof showToast === 'function') {
          var msg = '🟢 ' + tt('נכנסת', 'เข้างานแล้ว', 'دخلت') + ' — ' + workplace;
          if (v.warnings.indexOf('outside_geofence') !== -1) {
            msg += ' ⚠️ ' + tt('מחוץ לטווח','นอกพื้นที่','خارج النطاق');
          } else if (v.warnings.indexOf('no_gps') !== -1) {
            msg += ' ⚠️ ' + tt('ללא GPS','ไม่มี GPS','بدون GPS');
          }
          showToast(msg);
        }
      });
    });
  }

  function getTodayShiftCount(callback) {
    var today = new Date().toISOString().slice(0, 10);
    var username = window.currentUser ? window.currentUser.username : '';
    if (typeof db !== 'undefined') {
      db.collection('timeclock')
        .where('username', '==', username)
        .where('date', '==', today)
        .get()
        .then(function(snap) { callback(snap.size); })
        .catch(function() { callback(0); });
    } else {
      callback(0);
    }
  }

  // ── Presence (who currently has the app open) ──
  // Every logged-in user heartbeats a 'presence/{username}' doc while the app
  // is open — NOT only when clocked in. The dashboard shows anyone seen within
  // PRESENCE_ONLINE_MS. If they're also clocked in, their workplace rides along
  // so the dashboard can mark them. Best-effort; timeclock records untouched.
  var PRESENCE_BEAT_MS = 90000;      // heartbeat every 90s
  var _presenceTimer = null;
  var _presenceWired = false;
  function _presenceBeat() {
    if (typeof db === 'undefined' || !window.currentUser) return;
    var uname = window.currentUser.username;
    var wp = '';
    try { var cs = JSON.parse(localStorage.getItem('shorashim-current-shift') || 'null'); if (cs && cs.workplace) wp = cs.workplace; } catch (e) {}
    try {
      db.collection('presence').doc(uname).set({
        username: uname,
        name: window.currentUser.name || uname,
        role: window.currentUser.role || '',
        workplace: wp,
        lastSeen: Date.now()
      }, { merge: true }).catch(function() {});
    } catch (e) {}
  }
  function startPresence() {
    if (typeof db === 'undefined' || !window.currentUser) return;
    _presenceBeat();
    if (_presenceTimer) clearInterval(_presenceTimer);
    _presenceTimer = setInterval(_presenceBeat, PRESENCE_BEAT_MS);
    if (!_presenceWired) {
      _presenceWired = true;
      document.addEventListener('visibilitychange', function() { if (!document.hidden) _presenceBeat(); });
      window.addEventListener('online', _presenceBeat);
    }
  }
  function stopPresence() {
    if (_presenceTimer) { clearInterval(_presenceTimer); _presenceTimer = null; }
    if (typeof db !== 'undefined' && window.currentUser) {
      try { db.collection('presence').doc(window.currentUser.username).delete().catch(function() {}); } catch (e) {}
    }
  }

  // ── Punch Out ──

  function punchOut() {
    if (!currentShift) return;
    // End any active break automatically — the user is leaving.
    if (getActiveBreak()) {
      getActiveBreak().end = Date.now();
    }
    if (typeof showToast === 'function') {
      showToast('📍 ' + tt('מאתר מיקום...','กำลังระบุตำแหน่ง...','جاري تحديد الموقع...'));
    }
    var workplace = currentShift.workplace;
    getGeoFix(10000).then(function(geoOut) {
      var vOut = verifyGeoFix(geoOut, workplace);

      // Merge warnings from punch-in and punch-out
      var combinedWarnings = (currentShift.geoWarnings || []).slice();
      vOut.warnings.forEach(function(w) {
        if (combinedWarnings.indexOf(w) === -1) combinedWarnings.push(w);
      });

      // Combined geoVerified: both ends must verify (or be unknown) for the
      // shift to count as verified overall. Any false ⇒ false; null + true
      // ⇒ null (uncertain — manager review encouraged).
      var combinedVerified = null;
      var inVerified = currentShift.geoVerified;
      var outVerified = vOut.verified;
      if (inVerified === true && outVerified === true) combinedVerified = true;
      else if (inVerified === false || outVerified === false) combinedVerified = false;

      // Compute break totals
      var breaks = currentShift.breaks || [];
      var breakMin = totalBreakMinutes(breaks);
      var durationMs = Date.now() - currentShift.punchIn;
      var durationMin = Math.round(durationMs / 60000);

      // Auto-break rule: shifts ≥ 6h with no logged break get 30min deducted
      // as an unpaid lunch. The synthetic break is recorded so the audit
      // trail is honest about why paidMinutes < duration.
      var autoBreakApplied = false;
      if (durationMin >= 360 && breakMin === 0) {
        var autoStart = currentShift.punchIn + (durationMs / 2) - (15 * 60000);
        breaks = breaks.concat([{
          start: autoStart,
          end: autoStart + (30 * 60000),
          type: 'lunch',
          auto: true
        }]);
        breakMin = 30;
        autoBreakApplied = true;
      }
      var paidMin = Math.max(0, durationMin - breakMin);

      // ── Phase 3: OT tier calculation using the user's schedule ──
      // calcOTTiers is a pure function in schedule.js — same input always
      // gives same output. If the module isn't loaded for any reason we
      // fall back gracefully to "all hours regular" so the punch still saves.
      var dateStr = new Date(currentShift.punchIn).toISOString().slice(0, 10);
      var otTiers = null;
      if (typeof Schedule !== 'undefined') {
        try {
          var sched = Schedule.getForUser(currentShift.username);
          otTiers = Schedule.calcOTTiers(currentShift.punchIn, Date.now(), paidMin, sched, dateStr);
        } catch (e) {
          console.warn('OT calculation failed, defaulting to regular:', e);
        }
      }
      if (!otTiers) {
        otTiers = {
          hoursRegular: paidMin / 60, hours125: 0, hours150: 0, hoursNight: 0,
          expectedHours: 0, late: false, earlyLeave: false, scheduleWarnings: [], offDay: false
        };
      }

      // Decide initial approval status: shifts with geo failures OR
      // schedule warnings default to pending so the manager reviews them.
      var hasWarnings = (combinedVerified === false) ||
                        (otTiers.scheduleWarnings && otTiers.scheduleWarnings.length > 0);
      var status = hasWarnings ? 'pending' : 'auto_approved';

      var record = {
        punchIn: currentShift.punchIn,
        punchOut: Date.now(),
        workplace: workplace,
        username: currentShift.username,
        userName: currentShift.userName,
        shiftIndex: currentShift.shiftIndex,
        date: new Date(currentShift.punchIn).toISOString().slice(0, 10),
        duration: durationMs,
        // ── Phase 2 fields ──
        punchInGeo: currentShift.punchInGeo || null,
        punchOutGeo: geoOut || null,
        geoVerified: combinedVerified,
        geoWarnings: combinedWarnings,
        breaks: breaks,
        paidMinutes: paidMin,
        breakMinutes: breakMin,
        status: status,
        // ── Phase 3 fields ──
        hoursRegular: otTiers.hoursRegular,
        hours125: otTiers.hours125,
        hours150: otTiers.hours150,
        hoursNight: otTiers.hoursNight,
        expectedHours: otTiers.expectedHours,
        scheduleWarnings: otTiers.scheduleWarnings || [],
        offDay: !!otTiers.offDay
      };

      saveTimeRecord(record);
      currentShift = null;
      saveCurrentShift();
      _presenceBeat();
      stopTicker();
      renderClockBar();

      if (typeof showToast === 'function') {
        var msg = '🔴 ' + tt('יצאת', 'ออกงานแล้ว', 'خرجت') + ' — ' + formatDuration(durationMs);
        if (autoBreakApplied) {
          msg += ' (☕ ' + tt('הופחתה הפסקה אוטומטית','หักพักอัตโนมัติ','تم خصم استراحة تلقائياً') + ')';
        }
        if (otTiers.hours125 > 0 || otTiers.hours150 > 0) {
          msg += ' · ' + tt('שעות נוספות','โอที','إضافي') + ' ' + (otTiers.hours125 + otTiers.hours150).toFixed(1) + 'h';
        }
        if (otTiers.late) msg += ' ⏰ ' + tt('איחור','สาย','تأخر');
        if (otTiers.earlyLeave) msg += ' ⏰ ' + tt('יציאה מוקדמת','ออกก่อน','مغادرة مبكرة');
        if (combinedVerified === false) {
          msg += ' ⚠️ ' + tt('ממתין לאישור','รออนุมัติ','بانتظار الاعتماد');
        }
        showToast(msg);
      }
    });
  }

  // ── Workplace Picker Modal ──

  function showWorkplacePicker(callback, forceNew) {
    var options = getWorkplaceOptions();
    var modal = document.getElementById('modalContainer');
    var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">';
    html += '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:360px;max-height:80vh;overflow-y:auto;">';
    html += '<h3 style="font-weight:700;font-size:1.1rem;margin-bottom:12px;">📍 ' + (forceNew ? tt('בחר מקום עבודה חדש', 'เลือกสถานที่ทำงานใหม่', 'اختر مكان عمل جديد') : tt('בחר מקום עבודה', 'เลือกสถานที่ทำงาน', 'اختر مكان العمل')) + '</h3>';

    if (options.length === 0) {
      html += '<div style="color:#999;text-align:center;padding:16px;">' + tt('אין מקומות עבודה מוגדרים. המנהל צריך להגדיר.', 'ไม่มีสถานที่ทำงาน ผู้ดูแลต้องตั้งค่า', 'لا توجد أماكن عمل. يجب على المسؤول إعدادها.') + '</div>';
    } else {
      options.forEach(function(opt) {
        html += '<button onclick="TimeClock._selectWorkplace(\'' + opt.replace(/'/g, "\\'") + '\')" style="display:block;width:100%;padding:12px 16px;margin-bottom:6px;border-radius:10px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.95rem;font-weight:600;cursor:pointer;text-align:right;">' + opt + '</button>';
      });
    }

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:10px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;font-size:0.9rem;cursor:pointer;">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>';
    html += '</div></div>';
    modal.innerHTML = html;

    // Store callback for selection
    TimeClock._workplaceCallback = callback;
  }

  function _selectWorkplace(name) {
    document.getElementById('modalContainer').innerHTML = '';
    if (TimeClock._workplaceCallback) {
      TimeClock._workplaceCallback(name);
      TimeClock._workplaceCallback = null;
    }
  }

  // ── Hamburger Menu Panel ──

  function renderMenuPanel() {
    var isAdmin = window.currentUser && window.currentUser.role === 'admin';
    var isManager = window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'operator');
    var panel = document.getElementById('hamburgerPanel');
    if (!panel) return;

    var menuBtn = 'display:block;width:100%;padding:11px 12px;margin-bottom:5px;border-radius:10px;border:none;font-family:inherit;font-size:0.88rem;font-weight:600;cursor:pointer;text-align:right;';
    var groupHead = 'display:flex;align-items:center;justify-content:space-between;padding:8px 0;cursor:pointer;border-bottom:1px solid #eee;margin-bottom:6px;';

    var html = '<div style="padding:16px;">';
    
    // Header with user name
    html += '<div style="margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #e0e0e0;">';
    html += '<h3 style="font-weight:700;font-size:1.1rem;">' + tt('⚙️ תפריט', '⚙️ เมนู', '⚙️ القائمة') + '</h3>';
    if (window.currentUser && window.currentUser.name) {
      html += '<div style="font-size:0.78rem;color:#999;margin-top:2px;">👤 ' + window.currentUser.name + '</div>';
    }
    html += '</div>';

    // ── השעות שלי (collapsible) ──
    html += '<div onclick="var d=document.getElementById(\'menuHours\');var open=d.style.display!==\'block\';d.style.display=open?\'block\':\'none\';this.classList.toggle(\'open\',open);" class="menu-group-head">';
    html += '<span class="mg-label">🕐 ' + tt('השעות שלי', 'ชั่วโมงของฉัน', 'ساعاتي') + '</span><span class="mg-chev">▸</span>';
    html += '</div>';
    html += '<div id="menuHours" style="display:none;">';
    html += '<button onclick="Leave.showMyLeave();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fff3e0;">' + tt('🏖️ החופשות שלי', '🏖️ การลาของฉัน', '🏖️ إجازاتي') + '</button>';
    html += '<button onclick="MonthlyReport.show();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e0f2f1;">' + tt('דוח חודשי 📅', '📅 รายงานรายเดือน', '📅 التقرير الشهري') + '</button>';
    if (isManager) {
      html += '<button onclick="Leave.showApprovalQueue();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fff8e1;">' + tt('✅ תור אישורים', '✅ คิวอนุมัติ', '✅ قائمة الاعتماد') + '</button>';
      html += '<button onclick="Leave.showHolidayAdmin();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fce4ec;">' + tt('🎉 חגים', '🎉 วันหยุด', '🎉 الأعياد') + '</button>';
    }
    html += '</div>';

    if (isManager) {
      // ── ניהול צוות (Meckano-style manager→workers) ──
      html += '<button onclick="Team.show();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e8eaf6;">' + tt('👥 הצוות שלי', '👥 ทีมของฉัน', '👥 فريقي') + '</button>';

      // ── דוחות סיור (standalone) ──
      // Opens the season monitoring grid; the older per-observation reports
      // (which feed the spray traceability chain) hang off a button inside it.
      html += '<button onclick="PestMonitor.open();TimeClock.closeMenu()" style="' + menuBtn + 'background:#f9fbe7;">' + tt('🔬 דוחות סיור', '🔬 รายงานสำรวจ', '🔬 تقارير الجولات') + '</button>';

      // ── מחלקת תחזוקה (standalone, renamed) ──
      html += '<button onclick="Maintenance.showProjectsList();TimeClock.closeMenu()" style="' + menuBtn + 'background:#efebe9;">' + tt('🔧 מחלקת תחזוקה', '🔧 แผนกซ่อมบำรุง', '🔧 قسم الصيانة') + '</button>';
    }

    // ── הגדרות (collapsible) ──
    html += '<div onclick="var d=document.getElementById(\'menuSettings\');var open=d.style.display!==\'block\';d.style.display=open?\'block\':\'none\';this.classList.toggle(\'open\',open);" class="menu-group-head">';
    html += '<span class="mg-label">⚙️ ' + tt('הגדרות', 'ตั้งค่า', 'إعدادات') + '</span><span class="mg-chev">▸</span>';
    html += '</div>';
    html += '<div id="menuSettings" style="display:none;">';
    html += '<button onclick="TaskBoard.showMyTasks();TimeClock.closeMenu()" style="' + menuBtn + 'background:#f3e5f5;">' + tt('📋 המשימות שלי', '📋 งานของฉัน', '📋 مهامي') + '</button>';
    if (isManager) {
      html += '<button onclick="TaskBoard.showTaskManager();TimeClock.closeMenu()" style="' + menuBtn + 'background:#ede7f6;">' + tt('📋 ניהול משימות', '📋 จัดการงาน', '📋 إدارة المهام') + '</button>';
    }
    html += '<button onclick="TimeClock.showProfileEdit();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fce4ec;">' + tt('👤 הפרופיל שלי', '👤 โปรไฟล์ของฉัน', '👤 ملفي الشخصي') + '</button>';
    if (isManager) {
      html += '<button onclick="TimeClock.showAdminDashboard();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e0f7fa;">' + tt('📊 לוח בקרה', '📊 แดชบอร์ด', '📊 لوحة التحكم') + '</button>';
      html += '<button onclick="TimeClock.showExportMenu();TimeClock.closeMenu()" style="' + menuBtn + 'background:#f1f8e9;">' + tt('📥 ייצוא נתונים', '📥 ส่งออกข้อมูล', '📥 تصدير البيانات') + '</button>';
      html += '<button onclick="TimeClock.showWorkplaceAdmin();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fff3e0;">' + tt('📍 מקומות עבודה', '📍 สถานที่ทำงาน', '📍 أماكن العمل') + '</button>';
      html += '<button onclick="TimeClock.showCropAdmin();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e8f5e9;">' + tt('🌱 סוגי גידולים', '🌱 ประเภทพืช', '🌱 أنواع المحاصيل') + '</button>';
    }
    html += '<button onclick="DisplaySettings.showSettings();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e0f7fa;">' + tt('🎨 הגדרות תצוגה', '🎨 การตั้งค่าการแสดงผล', '🎨 إعدادات العرض') + '</button>';
    html += '<button onclick="location.reload(true)" style="' + menuBtn + 'background:#e3f2fd;">' + tt('🔄 רענן אפליקציה', '🔄 รีเฟรชแอป', '🔄 تحديث التطبيق') + '</button>';
    html += '</div>';

    // ── Bottom actions ──
    html += '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #eee;">';
    html += '<button onclick="TimeClock.logout()" style="' + menuBtn + 'background:#ffebee;color:#c62828;font-weight:700;text-align:center;">' + tt('🚪 התנתק', '🚪 ออกจากระบบ', '🚪 تسجيل خروج') + '</button>';
    html += '<button onclick="TimeClock.closeMenu()" style="' + menuBtn + 'background:#f5f5f5;text-align:center;font-weight:400;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>';
    html += '</div>';
    html += '<div style="text-align:center;margin-top:8px;font-size:0.65rem;color:#bbb;">v1.0.0</div>';
    html += '</div>';
    panel.innerHTML = html;
  }

  function toggleMenu() {
    var panel = document.getElementById('hamburgerPanel');
    var overlay = document.getElementById('hamburgerOverlay');
    if (!panel) return;
    var isOpen = panel.style.display === 'block';
    if (isOpen) {
      panel.style.display = 'none';
      if (overlay) overlay.style.display = 'none';
    } else {
      renderMenuPanel();
      panel.style.display = 'block';
      if (overlay) overlay.style.display = 'block';
      if (typeof markBadgeSeen === 'function') markBadgeSeen();
    }
  }

  function closeMenu() {
    var panel = document.getElementById('hamburgerPanel');
    var overlay = document.getElementById('hamburgerOverlay');
    if (panel) panel.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
  }

  // ── My Records View ──

  function showMyRecords() {
    var username = window.currentUser ? window.currentUser.username : '';
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;"><div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;"><h3 style="font-weight:700;margin-bottom:12px;">' + tt('🕐 הדוחות שלי', '🕐 รายงานของฉัน', '🕐 تقاريري') + '</h3><div id="myProgressCard"></div><div id="myRecordsContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div><button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلาق') + '</button></div></div>';

    // Phase 3: progress widget — current week paid vs expected + OT breakdown
    if (typeof Schedule !== 'undefined') Schedule.renderProgressCard('myProgressCard', username);

    if (typeof db !== 'undefined') {
      db.collection('timeclock')
        .where('username', '==', username)
        .orderBy('punchIn', 'desc')
        .limit(30)
        .get()
        .then(function(snap) {
          var records = [];
          snap.forEach(function(doc) { records.push(doc.data()); });
          renderRecordsTable('myRecordsContent', records, false);
        })
        .catch(function(err) {
          document.getElementById('myRecordsContent').innerHTML = '<div style="color:red;">' + tt('שגיאה', 'ข้อผิดพลาด', 'خطأ') + ': ' + err.message + '</div>';
        });
    }
  }

  // ── Manager: All Records ──

  function showAllRecords() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;"><div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:600px;max-height:85vh;overflow-y:auto;"><h3 style="font-weight:700;margin-bottom:12px;">' + tt('📊 ניהול שעות — כל העובדים', '📊 จัดการชั่วโมง — ทุกคน', '📊 إدارة الساعات — جميع العمال') + '</h3><div id="allRecordsContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div><button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلาق') + '</button></div></div>';

    if (typeof db !== 'undefined') {
      db.collection('timeclock')
        .orderBy('punchIn', 'desc')
        .limit(100)
        .get()
        .then(function(snap) {
          var records = [];
          snap.forEach(function(doc) { records.push(Object.assign({ _id: doc.id }, doc.data())); });
          renderRecordsTable('allRecordsContent', records, true);
        })
        .catch(function(err) {
          document.getElementById('allRecordsContent').innerHTML = '<div style="color:red;">' + tt('שגיאה', 'ข้อผิดพลาด', 'خطأ') + ': ' + err.message + '</div>';
        });
    }
  }

  function renderRecordsTable(containerId, records, showUser) {
    var el = document.getElementById(containerId);
    if (records.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:#999;padding:16px;">' + tt('אין רשומות', 'ไม่มีรายการ', 'لا توجد سجلات') + '</div>';
      return;
    }

    var html = '<table style="width:100%;border-collapse:collapse;font-size:0.8rem;">';
    html += '<tr style="background:#f5f5f5;font-weight:700;">';
    html += '<td style="padding:6px;">' + tt('תאריך', 'วันที่', 'تاريخ') + '</td>';
    if (showUser) html += '<td>' + tt('עובד', 'คนงาน', 'عامل') + '</td>';
    html += '<td>' + tt('מקום', 'สถานที่', 'مكان') + '</td><td>' + tt('כניסה', 'เข้า', 'دخول') + '</td><td>' + tt('יציאה', 'ออก', 'خروج') + '</td><td>' + tt('שעות', 'ชั่วโมง', 'ساعات') + '</td>';
    if (showUser) html += '<td></td>';
    html += '</tr>';

    records.forEach(function(r) {
      html += '<tr style="border-bottom:1px solid #eee;">';
      html += '<td style="padding:6px;">' + formatDate(r.punchIn) + '</td>';
      if (showUser) html += '<td>' + (r.userName || r.username) + '</td>';
      html += '<td>' + (r.workplace || '—') + '</td>';
      html += '<td>' + formatTime(r.punchIn) + '</td>';
      html += '<td>' + (r.punchOut ? formatTime(r.punchOut) : '—') + '</td>';
      html += '<td>' + (r.duration ? formatDuration(r.duration) : '—') + '</td>';
      if (showUser && r._id) {
        html += '<td><button onclick="TimeClock.editRecord(\'' + r._id + '\')" style="border:none;background:none;cursor:pointer;font-size:0.9rem;">✏️</button></td>';
      }
      html += '</tr>';
    });
    html += '</table>';
    el.innerHTML = html;
  }

  // ── Manager: Edit Record ──

  function editRecord(docId) {
    if (typeof db === 'undefined') return;
    db.collection('timeclock').doc(docId).get().then(function(doc) {
      if (!doc.exists) return;
      var r = doc.data();
      var pIn = new Date(r.punchIn);
      var pOut = r.punchOut ? new Date(r.punchOut) : null;
      var dateStr = pIn.toISOString().slice(0, 10);
      var inTime = (pIn.getHours() < 10 ? '0' : '') + pIn.getHours() + ':' + (pIn.getMinutes() < 10 ? '0' : '') + pIn.getMinutes();
      var outTime = pOut ? (pOut.getHours() < 10 ? '0' : '') + pOut.getHours() + ':' + (pOut.getMinutes() < 10 ? '0' : '') + pOut.getMinutes() : '';

      var modal = document.getElementById('modalContainer');

      // ── Phase 2: build context panels (geo / breaks / approval state) ──
      var contextBlocks = '';
      var geoIn = r.punchInGeo, geoOut = r.punchOutGeo;
      if (geoIn || geoOut || (r.geoWarnings && r.geoWarnings.length)) {
        var warnPills = (r.geoWarnings || []).map(function(w) {
          var labels = {
            outside_geofence: tt('מחוץ לטווח','นอกพื้นที่','خارج النطاق'),
            low_accuracy:     tt('דיוק נמוך','ความแม่นยำต่ำ','دقة منخفضة'),
            no_gps:           tt('ללא GPS','ไม่มี GPS','بدون GPS'),
            manual_override:  tt('אושר ידנית','อนุมัติด้วยตนเอง','تم الاعتماد يدوياً')
          };
          var color = (w === 'manual_override') ? '#2e7d32' : '#ef6c00';
          return '<span style="display:inline-block;background:' + color + ';color:white;padding:2px 8px;border-radius:6px;font-size:0.7rem;font-weight:700;margin-inline-end:4px;">⚠️ ' + (labels[w] || w) + '</span>';
        }).join('');
        var inAcc  = geoIn  ? Math.round(geoIn.accuracy)  + 'm' : '—';
        var outAcc = geoOut ? Math.round(geoOut.accuracy) + 'm' : '—';
        contextBlocks +=
          '<div style="background:#fff8e1;border:1px solid #ffe0b2;border-radius:8px;padding:8px 10px;margin-bottom:10px;font-size:0.78rem;">' +
            '<div style="font-weight:700;margin-bottom:4px;">📍 ' + tt('מיקום','ตำแหน่ง','الموقع') + '</div>' +
            warnPills +
            '<div style="color:#666;margin-top:4px;">' +
              tt('דיוק','ความแม่นยำ','الدقة') + ': ' + tt('כניסה','เข้า','دخول') + ' ' + inAcc + ' · ' + tt('יציאה','ออก','خروج') + ' ' + outAcc +
            '</div>' +
          '</div>';
      }
      if (Array.isArray(r.breaks) && r.breaks.length) {
        var breakRows = r.breaks.map(function(b) {
          var dur = (b.end && b.start) ? Math.round((b.end - b.start) / 60000) : 0;
          var icon = b.type === 'lunch' ? '🍽️' : (b.type === 'personal' ? '👤' : '⏸');
          var auto = b.auto ? ' <span style="color:#999;">(' + tt('אוטומטי','อัตโนมัติ','تلقائي') + ')</span>' : '';
          return '<div style="font-size:0.78rem;color:#444;">' + icon + ' ' + dur + ' ' + tt('דקות','นาที','دقيقة') + auto + '</div>';
        }).join('');
        contextBlocks +=
          '<div style="background:#f3e5f5;border:1px solid #e1bee7;border-radius:8px;padding:8px 10px;margin-bottom:10px;">' +
            '<div style="font-weight:700;font-size:0.78rem;margin-bottom:4px;">☕ ' + tt('הפסקות','พัก','استراحات') + ' (' + (r.breakMinutes || 0) + ' ' + tt('דקות','นาที','دقيقة') + ')</div>' +
            breakRows +
          '</div>';
      }
      // Force-approve button: only when this record needs review.
      var forceApproveBtn = '';
      if (r.status === 'pending' || r.geoVerified === false) {
        forceApproveBtn =
          '<button onclick="TimeClock._forceApprove(\'' + docId + '\')" style="width:100%;padding:10px;border-radius:10px;border:none;background:#2e7d32;color:white;font-family:inherit;font-weight:700;font-size:0.85rem;cursor:pointer;margin-bottom:8px;">' +
          '🔓 ' + tt('אשר ידנית','อนุมัติด้วยตนเอง','اعتماد يدوي') + '</button>';
      }

      modal.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:380px;max-height:90vh;overflow-y:auto;">' +
          '<h3 style="font-weight:700;margin-bottom:12px;">✏️ ' + tt('עריכת רשומה', 'แก้ไขรายการ', 'تعديل سجل') + '</h3>' +
          '<div style="margin-bottom:8px;font-size:0.85rem;font-weight:600;">' + (r.userName || r.username) + ' — ' + (r.workplace || '') + '</div>' +
          contextBlocks +
          forceApproveBtn +
          '<label style="font-size:0.8rem;color:#666;">' + tt('תאריך', 'วันที่', 'تاريخ') + '</label>' +
          '<input type="date" id="editDate" value="' + dateStr + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:8px;font-family:inherit;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
            '<div><label style="font-size:0.8rem;color:#666;">' + tt('כניסה', 'เข้า', 'دخول') + '</label><input type="time" id="editIn" value="' + inTime + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.8rem;color:#666;">' + tt('יציאה', 'ออก', 'خروج') + '</label><input type="time" id="editOut" value="' + outTime + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '</div>' +
          '<label style="font-size:0.8rem;color:#666;">' + tt('סיבת העריכה', 'เหตุผลในการแก้ไข', 'سبب التعديل') + '</label>' +
          '<input type="text" id="editReason" placeholder="' + tt('אופציונלי - יישמר ביומן הביקורת', 'ไม่บังคับ - บันทึกใน audit log', 'اختياري - يُسجل في سجل التدقيق') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:10px;font-family:inherit;font-size:0.85rem;">' +
          '<div style="display:flex;gap:8px;">' +
            '<button onclick="TimeClock._saveEdit(\'' + docId + '\')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">' + tt('💾 שמור', '💾 บันทึก', '💾 حفظ') + '</button>' +
            '<button onclick="TimeClock._deleteRecord(\'' + docId + '\')" style="padding:10px 16px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button>' +
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
          '</div>' +
        '</div></div>';
      window.__timeclockEditingRecord = r;
    });
  }

  // Manager force-approves a flagged punch. Prompts for a reason, then
  // adds 'manual_override' to warnings, flips status to 'approved', and
  // writes an audit entry — Phase 1 audit hook is reused.
  function _forceApprove(docId) {
    var reason = prompt(tt('סיבת אישור ידני (חובה):','เหตุผลในการอนุมัติด้วยตนเอง (จำเป็น):','سبب الاعتماد اليدوي (مطلوب):'));
    if (reason == null) return; // cancelled
    reason = reason.trim();
    if (!reason) {
      if (typeof showToast === 'function') showToast('❌ ' + tt('חייב לציין סיבה','ต้องระบุเหตุผล','يجب ذكر السبب'));
      return;
    }
    var before = window.__timeclockEditingRecord || null;
    var prevWarnings = (before && before.geoWarnings) ? before.geoWarnings.slice() : [];
    if (prevWarnings.indexOf('manual_override') === -1) prevWarnings.push('manual_override');
    var update = {
      status: 'approved',
      approvedBy: (window.currentUser && window.currentUser.username) || 'unknown',
      approvedAt: Date.now(),
      geoWarnings: prevWarnings,
      editReason: reason
    };
    db.collection('timeclock').doc(docId).update(update)
      .then(function() {
        document.getElementById('modalContainer').innerHTML = '';
        if (typeof showToast === 'function') showToast('✅ ' + tt('אושר ידנית','อนุมัติแล้ว','تم الاعتماد'));
        if (typeof Audit !== 'undefined') {
          Audit.log('approve', 'timeclock', docId, {
            targetUser: before ? before.username : null,
            before: before,
            after: Object.assign({}, before || {}, update),
            reason: reason
          });
        }
        window.__timeclockEditingRecord = null;
        showAllRecords();
      })
      .catch(function(err) {
        if (typeof showToast === 'function') showToast('❌ ' + err.message);
      });
  }

  function _saveEdit(docId) {
    var dateVal = document.getElementById('editDate').value;
    var inVal = document.getElementById('editIn').value;
    var outVal = document.getElementById('editOut').value;
    var reasonEl = document.getElementById('editReason');
    var reason = reasonEl ? reasonEl.value.trim() : '';
    if (!dateVal || !inVal) return;

    var before = window.__timeclockEditingRecord || null;
    var punchIn = new Date(dateVal + 'T' + inVal + ':00').getTime();
    var punchOut = outVal ? new Date(dateVal + 'T' + outVal + ':00').getTime() : null;
    var update = { punchIn: punchIn, date: dateVal };
    if (punchOut) {
      update.punchOut = punchOut;
      update.duration = punchOut - punchIn;
      update.paidMinutes = Math.round((punchOut - punchIn) / 60000);
      update.hoursRegular = (punchOut - punchIn) / 3600000;
    }
    // Preserve the original times on first edit (don't clobber on re-edit).
    if (before && before.originalPunchIn == null) {
      update.originalPunchIn = before.punchIn;
      update.originalPunchOut = before.punchOut || null;
    }
    if (reason) update.editReason = reason;
    // An edit invalidates auto-approval — manager must re-approve.
    // (Phase 3 surfaces this; Phase 1 just records the state change.)
    update.status = 'pending';
    update.approvedBy = null;
    update.approvedAt = null;

    db.collection('timeclock').doc(docId).update(update)
      .then(function() {
        document.getElementById('modalContainer').innerHTML = '';
        if (typeof showToast === 'function') showToast('💾 ' + tt('עודכן', 'อัปเดตแล้ว', 'تم التحديث'));
        // Audit log — fire-and-forget, never blocks the user.
        if (typeof Audit !== 'undefined') {
          Audit.log('edit', 'timeclock', docId, {
            targetUser: before ? before.username : null,
            before: before,
            after: Object.assign({}, before || {}, update),
            reason: reason || null
          });
        }
        window.__timeclockEditingRecord = null;
        showAllRecords();
      })
      .catch(function(err) {
        if (typeof showToast === 'function') showToast('❌ ' + err.message);
      });
  }

  function _deleteRecord(docId) {
    if (!confirm(tt('למחוק רשומה זו?', 'ลบรายการนี้?', 'حذف هذا السجل؟'))) return;
    var before = window.__timeclockEditingRecord || null;
    db.collection('timeclock').doc(docId).delete()
      .then(function() {
        document.getElementById('modalContainer').innerHTML = '';
        if (typeof showToast === 'function') showToast('🗑️ ' + tt('נמחק', 'ลบแล้ว', 'تم الحذف'));
        if (typeof Audit !== 'undefined') {
          Audit.log('delete', 'timeclock', docId, {
            targetUser: before ? before.username : null,
            before: before,
            after: null,
            reason: null
          });
        }
        window.__timeclockEditingRecord = null;
        showAllRecords();
      });
  }

  // ── Admin: Workplace Management ──

  function showWorkplaceAdmin() {
    var modal = document.getElementById('modalContainer');
    var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">';
    html += '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;max-height:80vh;overflow-y:auto;">';
    html += '<h3 style="font-weight:700;margin-bottom:12px;">📍 ' + tt('ניהול מקומות עבודה', 'จัดการสถานที่ทำงาน', 'إدارة أماكن العمل') + '</h3>';
    html += '<div style="font-size:0.75rem;color:#999;margin-bottom:10px;">' + tt('מטעים מהמערכת מתווספים אוטומטית. כאן ניתן להוסיף מקומות נוספים.', 'สวนจากระบบจะเพิ่มอัตโนมัติ เพิ่มสถานที่อื่นได้ที่นี่', 'البساتين تُضاف تلقائياً. يمكن إضافة أماكن أخرى هنا.') + '</div>';

    // Show farms (read-only)
    if (typeof farms !== 'undefined' && farms.length > 0) {
      html += '<div style="font-size:0.8rem;font-weight:600;margin-bottom:4px;color:#666;">' + tt('מטעים (אוטומטי)', 'สวน (อัตโนมัติ)', 'بساتين (تلقائي)') + ':</div>';
      farms.forEach(function(f) {
        html += '<div style="padding:6px 10px;background:#e8f5e9;border-radius:6px;margin-bottom:4px;font-size:0.85rem;">🌳 ' + (window.locName ? window.locName(f) : f.name) + '</div>';
      });
    }

    // Show custom workplaces (editable)
    html += '<div style="font-size:0.8rem;font-weight:600;margin:10px 0 4px;color:#666;">' + tt('מקומות נוספים', 'สถานที่เพิ่มเติม', 'أماكن إضافية') + ':</div>';
    workplaces.forEach(function(w, i) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
      html += '<div style="flex:1;padding:6px 10px;background:#fff3e0;border-radius:6px;font-size:0.85rem;">📍 ' + w + '</div>';
      html += '<button onclick="TimeClock._removeWorkplace(' + i + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;">🗑️</button>';
      html += '</div>';
    });

    html += '<div style="display:flex;gap:6px;margin-top:10px;">';
    html += '<input id="newWorkplaceName" placeholder="' + tt('שם מקום עבודה חדש', 'ชื่อสถานที่ใหม่', 'اسم مكان جديد') + '" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">';
    html += '<button onclick="TimeClock._addWorkplace()" style="padding:8px 16px;border-radius:8px;border:none;background:#ff9800;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕</button>';
    html += '</div>';

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>';
    html += '</div></div>';
    modal.innerHTML = html;
  }

  function _addWorkplace() {
    var input = document.getElementById('newWorkplaceName');
    var name = input.value.trim();
    if (!name) return;
    if (workplaces.indexOf(name) === -1) {
      workplaces.push(name);
      saveWorkplaces();
    }
    showWorkplaceAdmin();
  }

  function _removeWorkplace(index) {
    workplaces.splice(index, 1);
    saveWorkplaces();
    showWorkplaceAdmin();
  }

  // ── Profile Edit ──

  function showProfileEdit() {
    var user = window.currentUser;
    if (!user) return;
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">👤 ' + tt('הפרופיל שלי', 'โปรไฟล์ของฉัน', 'ملفي الشخصي') + '</h3>' +
        '<div style="display:grid;gap:10px;">' +
          '<div><label style="font-size:0.8rem;color:#666;">' + tt('שם', 'ชื่อ', 'الاسم') + '</label><input id="profName" value="' + (user.name || '') + '" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '<div><label style="font-size:0.8rem;color:#666;">' + tt('אימייל', 'อีเมล', 'البريد') + '</label><input id="profEmail" value="' + (user.email || '') + '" readonly style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;background:#f0f0f0;direction:ltr;text-align:left;"></div>' +
          '<div><label style="font-size:0.8rem;color:#666;">' + tt('תפקיד', 'ตำแหน่ง', 'الوظيفة') + '</label><div style="padding:8px 12px;background:#f0f0f0;border-radius:8px;">' + (user.role || '') + '</div></div>' +
          '<button onclick="TimeClock._changePassword()" style="padding:10px;border-radius:8px;border:1px solid #ff9800;background:transparent;color:#ff9800;font-family:inherit;font-weight:600;cursor:pointer;">🔑 ' + tt('שנה סיסמה', 'เปลี่ยนรหัสผ่าน', 'تغيير كلمة المرور') + '</button>' +
          '<button onclick="window.__resyncAuth && window.__resyncAuth()" style="padding:10px;border-radius:8px;border:1px solid #1565c0;background:transparent;color:#1565c0;font-family:inherit;font-weight:600;cursor:pointer;">🔄 ' + tt('סנכרן הרשאות מחדש', 'ซิงค์สิทธิ์ใหม่', 'إعادة مزامنة الصلاحيات') + '</button>' +
          '<div style="display:flex;gap:8px;">' +
            '<button onclick="TimeClock._saveProfile()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">' + tt('💾 שמור', '💾 บันทึก', '💾 حفظ') + '</button>' +
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';
  }

  function _saveProfile() {
    var name = document.getElementById('profName').value.trim();
    if (!name) return;
    var user = window.currentUser;
    if (!user) return;
    var users = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
    if (users[user.username]) {
      users[user.username].name = name;
      if (typeof DB !== 'undefined') DB.save('shorashim-users', users);
      window.currentUser.name = name;
      if (typeof showToast === 'function') showToast('✅ ' + tt('פרופיל עודכן', 'อัปเดตโปรไฟล์แล้ว', 'تم تحديث الملف الشخصي'));
      document.getElementById('modalContainer').innerHTML = '';
    }
  }

  function _changePassword() {
    var email = window.currentUser ? window.currentUser.email : '';
    if (!email || typeof auth === 'undefined') return;
    auth.sendPasswordResetEmail(email).then(function() {
      if (typeof showToast === 'function') showToast('📧 ' + tt('נשלח מייל לאיפוס סיסמה', 'ส่งอีเมลรีเซ็ตรหัสผ่านแล้ว', 'تم إرسال بريد إعادة تعيين كلمة المرور'));
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  // ── Admin Dashboard ──

  function showAdminDashboard() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:16px;">📊 ' + tt('לוח בקרה', 'แดชบอร์ด', 'لوحة التحكم') + '</h3>' +
        '<div id="dashboardContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';

    var today = new Date().toISOString().slice(0, 10);
    var weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

    // Get users
    var users = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
    var userCount = Object.keys(users).length;
    var plots = JSON.parse(localStorage.getItem('plotMapperSprayData') || '{}');
    var plotCount = (plots.plots || []).length;
    var farmCount = (plots.farms || []).length;
    var sprayCount = (plots.sprayEvents || []).length;

    // Get today's clock records
    if (typeof db !== 'undefined') {
      db.collection('timeclock')
        .where('date', '==', today)
        .get()
        .then(function(snap) {
          var todayRecords = [];
          snap.forEach(function(doc) { todayRecords.push(doc.data()); });
          var clockedIn = 0; // populated below from the active-shifts presence collection
          var todayWorkers = {};
          todayRecords.forEach(function(r) { todayWorkers[r.username] = true; });
          var todayHours = 0;
          todayRecords.forEach(function(r) { if (r.duration) todayHours += r.duration; });

          // Get tasks
          var tasks = JSON.parse(localStorage.getItem('shorashim-tasks') || '[]');
          var pendingTasks = tasks.filter(function(t) { return t.status === 'pending'; }).length;
          var overdueTasks = tasks.filter(function(t) { return t.status === 'pending' && t.dueDate && t.dueDate < today; }).length;

          var el = document.getElementById('dashboardContent');
          el.innerHTML =
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">' +
              '<div style="background:#e8f5e9;border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + Object.keys(todayWorkers).length + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">' + tt('עובדים היום', 'คนงานวันนี้', 'العمال اليوم') + '</div>' +
              '</div>' +
              '<div style="background:#e3f2fd;border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;" id="dashConnectedNum">' + clockedIn + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">' + tt('מחוברים עכשיו', 'ออนไลน์ตอนนี้', 'متصلون الآن') + '</div>' +
              '</div>' +
              '<div style="background:#fff3e0;border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + (todayHours / 3600000).toFixed(1) + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">' + tt('שעות היום', 'ชั่วโมงวันนี้', 'ساعات اليوم') + '</div>' +
              '</div>' +
              '<div style="background:' + (overdueTasks > 0 ? '#ffebee' : '#f3e5f5') + ';border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + pendingTasks + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">' + tt('משימות פתוחות', 'งานค้าง', 'مهام مفتوحة') + (overdueTasks > 0 ? ' (' + overdueTasks + ' ' + tt('באיחור', 'เลยกำหนด', 'متأخر') + ')' : '') + '</div>' +
              '</div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
              '<div style="background:var(--g6);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:1.3rem;font-weight:800;">' + userCount + '</div><div style="font-size:0.7rem;color:#999;">' + tt('משתמשים', 'ผู้ใช้', 'مستخدمون') + '</div></div>' +
              '<div style="background:var(--g6);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:1.3rem;font-weight:800;">' + plotCount + '</div><div style="font-size:0.7rem;color:#999;">' + tt('חלקות', 'แปลง', 'قطع') + '</div></div>' +
              '<div style="background:var(--g6);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:1.3rem;font-weight:800;">' + sprayCount + '</div><div style="font-size:0.7rem;color:#999;">' + tt('ריסוסים', 'การพ่น', 'رشات') + '</div></div>' +
            '</div>' +
            '<div id="dashConnectedWho" style="margin-top:10px;text-align:center;"></div>';

          // Presence: who currently has the app open. Reads the presence
          // collection (heartbeat while the app is open) and counts anyone seen
          // within the last 4 minutes. Clocked-in users (workplace set) get a
          // green dot; app-open-only users get a grey dot.
          if (typeof db !== 'undefined') {
            db.collection('presence').get().then(function(psnap) {
              var now = Date.now(), list = [];
              psnap.forEach(function(d) { var a = d.data(); if (a && a.lastSeen && (now - a.lastSeen) < 240000) list.push(a); });
              var esc = function(x) { return String(x == null ? '' : x).replace(/[&<>]/g, function(c) { return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'; }); };
              var numEl = document.getElementById('dashConnectedNum');
              if (numEl) numEl.textContent = list.length;
              var whoEl = document.getElementById('dashConnectedWho');
              if (whoEl && list.length) {
                whoEl.innerHTML = list.sort(function(a, b) { return (b.workplace ? 1 : 0) - (a.workplace ? 1 : 0); }).map(function(a) {
                  var on = !!a.workplace;
                  return '<span style="display:inline-block;background:' + (on ? '#e8f5e9' : '#eceff1') + ';color:' + (on ? '#1b5e20' : '#455a64') + ';border-radius:8px;padding:3px 10px;margin:2px;font-size:0.78rem;font-weight:600;">' + (on ? '🟢' : '⚪') + ' ' + esc(a.name || a.username) + (a.workplace ? ' · ' + esc(a.workplace) : '') + '</span>';
                }).join('');
              }
            }).catch(function() {});
          }
        });
    }
  }

  // ── Data Export ──

  function showExportMenu() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">📥 ' + tt('ייצוא נתונים', 'ส่งออกข้อมูล', 'تصدير البيانات') + '</h3>' +
        '<div style="display:grid;gap:8px;">' +
          '<button onclick="TimeClock._exportCSV(\'timeclock\')" style="padding:12px;border-radius:10px;border:none;background:#e8f5e9;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">' + tt('🕐 שעות עבודה (CSV)', '🕐 ชั่วโมงทำงาน (CSV)', '🕐 ساعات العمل (CSV)') + '</button>' +
          '<button onclick="TimeClock._exportCSV(\'spray\')" style="padding:12px;border-radius:10px;border:none;background:#e3f2fd;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">' + tt('💧 יומן ריסוס (CSV)', '💧 บันทึกพ่นยา (CSV)', '💧 سجل الرش (CSV)') + '</button>' +
          '<button onclick="TimeClock._exportCSV(\'worklog\')" style="padding:12px;border-radius:10px;border:none;background:#fff3e0;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">' + tt('📝 יומן עבודה (CSV)', '📝 บันทึกงาน (CSV)', '📝 سجل العمل (CSV)') + '</button>' +
          '<button onclick="TimeClock._exportCSV(\'tasks\')" style="padding:12px;border-radius:10px;border:none;background:#f3e5f5;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">' + tt('📋 משימות (CSV)', '📋 งาน (CSV)', '📋 المهام (CSV)') + '</button>' +
        '</div>' +
        '<div style="margin-top:16px;padding-top:16px;border-top:2px solid #eee;">' +
          '<h4 style="font-weight:700;font-size:0.9rem;margin-bottom:8px;">💾 ' + tt('גיבוי ושחזור', 'สำรองและกู้คืน', 'نسخ احتياطي واستعادة') + '</h4>' +
          '<div style="display:grid;gap:8px;">' +
            '<button onclick="TimeClock._backupAll()" style="padding:12px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">' + tt('⬇️ הורד גיבוי מלא (JSON)', '⬇️ ดาวน์โหลดสำรองทั้งหมด (JSON)', '⬇️ تنزيل نسخة كاملة (JSON)') + '</button>' +
            '<label style="padding:12px;border-radius:10px;border:2px dashed #999;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;display:block;color:#666;">' + tt('⬆️ שחזר מגיבוי', '⬆️ กู้คืนจากสำรอง', '⬆️ استعادة من نسخة') + '<input type="file" accept=".json" onchange="TimeClock._restoreBackup(this.files[0])" style="display:none;"></label>' +
          '</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';
  }

  function _exportCSV(type) {
    var rows = [];
    var filename = '';

    if (type === 'timeclock') {
      filename = 'timeclock_' + new Date().toISOString().slice(0,10) + '.csv';
      rows.push([tt('תאריך','วันที่','تاريخ'), tt('עובד','คนงาน','عامل'), tt('מקום עבודה','สถานที่','مكان العمل'), tt('כניסה','เข้า','دخول'), tt('יציאה','ออก','خروج'), tt('שעות','ชั่วโมง','ساعات')]);
      if (typeof db !== 'undefined') {
        db.collection('timeclock').orderBy('punchIn', 'desc').limit(500).get().then(function(snap) {
          snap.forEach(function(doc) {
            var r = doc.data();
            var pIn = new Date(r.punchIn);
            var pOut = r.punchOut ? new Date(r.punchOut) : null;
            rows.push([
              r.date || '',
              r.userName || r.username || '',
              r.workplace || '',
              pIn.getHours() + ':' + (pIn.getMinutes() < 10 ? '0' : '') + pIn.getMinutes(),
              pOut ? pOut.getHours() + ':' + (pOut.getMinutes() < 10 ? '0' : '') + pOut.getMinutes() : '',
              r.duration ? (r.duration / 3600000).toFixed(2) : ''
            ]);
          });
          downloadCSV(rows, filename);
        });
        return;
      }
    }

    if (type === 'spray') {
      filename = 'spray_log_' + new Date().toISOString().slice(0,10) + '.csv';
      var data = JSON.parse(localStorage.getItem('plotMapperSprayData') || '{}');
      var events = data.sprayEvents || [];
      rows.push([tt('תאריך','วันที่','تاريخ'), tt('מפעיל','ผู้ปฏิบัติ','مشغل'), tt('חלקות','แปลง','قطع'), tt('תכשיר','สารเคมี','مبيد'), tt('ריכוז','ความเข้มข้น','تركيز'), tt('כמות','ปริมาณ','كمية'), tt('הערות','หมายเหตุ','ملاحظات')]);
      events.forEach(function(e) {
        rows.push([e.date || '', e.operator || '', (e.plotNames || []).join('; '), e.pesticide || '', e.concentration || '', e.quantity || '', e.notes || '']);
      });
    }

    if (type === 'worklog') {
      filename = 'worklog_' + new Date().toISOString().slice(0,10) + '.csv';
      var data = JSON.parse(localStorage.getItem('plotMapperSprayData') || '{}');
      var entries = data.worklogEntries || [];
      rows.push([tt('תאריך','วันที่','تاريخ'), tt('חלקה','แปลง','قطعة'), tt('סעיף','หมวด','بند'), tt('פעולה','งาน','عملية'), tt('קבוצת עובדים','กลุ่มคนงาน','مجموعة عمال'), tt('מספר עובדים','จำนวน','عدد العمال'), tt('שעות','ชม.','ساعات'), tt('עצים','ต้น','أشجار'), tt('הערות','หมายเหตุ','ملاحظات')]);
      entries.forEach(function(e) {
        rows.push([e.date || '', e.plot_name || '', e.budget_category || '', e.description || '', e.worker_group || '', e.worker_count || '', e.hours || '', e.trees || '', e.notes || '']);
      });
    }

    if (type === 'tasks') {
      filename = 'tasks_' + new Date().toISOString().slice(0,10) + '.csv';
      var tasks = JSON.parse(localStorage.getItem('shorashim-tasks') || '[]');
      rows.push([tt('כותרת','ชื่อ','عنوان'), tt('תיאור','รายละเอียด','وصف'), tt('מוקצה ל','มอบหมายให้','مكلف لـ'), tt('מקום','สถานที่','مكان'), tt('תאריך יעד','วันกำหนด','تاريخ الاستحقاق'), tt('סטטוס','สถานะ','حالة'), tt('נוצר','สร้างเมื่อ','أُنشئ')]);
      tasks.forEach(function(t) {
        rows.push([t.title || '', t.description || '', t.assignedTo || '', t.workplace || '', t.dueDate || '', t.status || '', t.created ? new Date(t.created).toLocaleDateString('he-IL') : '']);
      });
    }

    if (rows.length > 1) downloadCSV(rows, filename);
  }

  function downloadCSV(rows, filename) {
    var bom = '\uFEFF';
    var csv = bom + rows.map(function(r) {
      return r.map(function(cell) {
        var s = String(cell).replace(/"/g, '""');
        return '"' + s + '"';
      }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('📥 ' + filename);
  }

  // ── Backup ──

  function _backupAll() {
    var backup = { _version: 1, _date: new Date().toISOString(), _type: 'shorashim-plus-backup' };
    var keys = [
      'shorashim-users', 'plotMapperSprayData', 'shorashim-valve-plot-map',
      'shorashim-talgil-config', 'shorashim-crop-types', 'shorashim-workplaces',
      'shorashim-custom-actions', 'shorashim-custom-budgets', 'shorashim-custom-worker-groups',
      'shorashim-custom-work-types', 'shorashim-workers', 'shorashim-apps-script-url',
      'shorashim-receipts', 'shorashim-tasks'
    ];
    keys.forEach(function(key) {
      var val = localStorage.getItem(key);
      if (val) {
        try { backup[key] = JSON.parse(val); } catch(e) { backup[key] = val; }
      }
    });

    // Also backup timeclock from Firestore
    if (typeof db !== 'undefined') {
      db.collection('timeclock').orderBy('punchIn', 'desc').limit(1000).get().then(function(snap) {
        var records = [];
        snap.forEach(function(doc) { records.push(doc.data()); });
        backup['_timeclock'] = records;
        _downloadBackup(backup);
      }).catch(function() {
        _downloadBackup(backup);
      });
    } else {
      _downloadBackup(backup);
    }
  }

  function _downloadBackup(backup) {
    var json = JSON.stringify(backup, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'shorashim-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(url);
    if (typeof showToast === 'function') showToast('💾 ' + tt('גיבוי הורד', 'ดาวน์โหลดสำรองแล้ว', 'تم تنزيل النسخة'));
  }

  function _restoreBackup(file) {
    if (!file) return;
    if (!confirm(tt('שחזור גיבוי ידרוס את כל הנתונים הנוכחיים. להמשיך?', 'การกู้คืนจะเขียนทับข้อมูลทั้งหมด ดำเนินการต่อ?', 'الاستعادة ستمحو جميع البيانات الحالية. متابعة؟'))) return;

    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var backup = JSON.parse(e.target.result);
        if (backup._type !== 'shorashim-plus-backup') {
          if (typeof showToast === 'function') showToast('❌ ' + tt('קובץ לא תקין', 'ไฟล์ไม่ถูกต้อง', 'ملف غير صالح'));
          return;
        }

        var keys = [
          'shorashim-users', 'plotMapperSprayData', 'shorashim-valve-plot-map',
          'shorashim-talgil-config', 'shorashim-crop-types', 'shorashim-workplaces',
          'shorashim-custom-actions', 'shorashim-custom-budgets', 'shorashim-custom-worker-groups',
          'shorashim-custom-work-types', 'shorashim-workers', 'shorashim-apps-script-url',
          'shorashim-receipts', 'shorashim-tasks'
        ];
        
        keys.forEach(function(key) {
          if (backup[key] !== undefined) {
            var val = typeof backup[key] === 'string' ? backup[key] : JSON.stringify(backup[key]);
            localStorage.setItem(key, val);
            if (typeof DB !== 'undefined') DB.save(key, backup[key]);
          }
        });

        // Restore timeclock records
        if (backup['_timeclock'] && typeof db !== 'undefined') {
          backup['_timeclock'].forEach(function(rec) {
            if (rec.punchIn && rec.username) {
              var dateStr = rec.date || new Date(rec.punchIn).toISOString().slice(0, 10);
              var docId = dateStr + '_' + rec.username + '_' + (rec.shiftIndex || 0);
              db.collection('timeclock').doc(docId).set(rec).catch(function() {});
            }
          });
        }

        if (typeof showToast === 'function') showToast('✅ ' + tt('גיבוי שוחזר — רענן את הדף', 'กู้คืนแล้ว — รีเฟรชหน้า', 'تمت الاستعادة — حدّث الصفحة'));
        setTimeout(function() { location.reload(); }, 2000);
      } catch(err) {
        if (typeof showToast === 'function') showToast('❌ ' + tt('שגיאה', 'ข้อผิดพลาด', 'خطأ') + ': ' + err.message);
      }
    };
    reader.readAsText(file);
  }

  // ── Admin: Crop Type Management ──

  function showCropAdmin() {
    var cropList = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]');
    var modal = document.getElementById('modalContainer');
    var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">';
    html += '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;max-height:80vh;overflow-y:auto;">';
    html += '<h3 style="font-weight:700;margin-bottom:12px;">🌱 ' + tt('ניהול סוגי גידולים', 'จัดการประเภทพืช', 'إدارة أنواع المحاصيل') + '</h3>';
    html += '<div style="font-size:0.75rem;color:#999;margin-bottom:10px;">' + tt('הגידולים ישמשו לסינון חומרי הדברה ולהגדרת חלקות.', 'พืชจะใช้กรองสารเคมีและกำหนดแปลง', 'المحاصيل ستُستخدم لتصفية المبيدات وتحديد القطع.') + '</div>';

    cropList.forEach(function(c, i) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
      html += '<div style="flex:1;padding:6px 10px;background:#e8f5e9;border-radius:6px;font-size:0.85rem;">🌱 ' + c + '</div>';
      html += '<button onclick="TimeClock._removeCrop(' + i + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;">🗑️</button>';
      html += '</div>';
    });

    html += '<div style="display:flex;gap:6px;margin-top:10px;">';
    html += '<input id="newCropName" placeholder="' + tt('שם גידול חדש', 'ชื่อพืชใหม่', 'اسم محصول جديد') + '" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">';
    html += '<button onclick="TimeClock._addCrop()" style="padding:8px 16px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕</button>';
    html += '</div>';

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>';
    html += '</div></div>';
    modal.innerHTML = html;
  }

  function _addCrop() {
    var input = document.getElementById('newCropName');
    var name = input.value.trim();
    if (!name) return;
    var cropList = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]');
    if (cropList.indexOf(name) === -1) {
      cropList.push(name);
      if (typeof DB !== 'undefined') DB.save('shorashim-crop-types', cropList);
      else localStorage.setItem('shorashim-crop-types', JSON.stringify(cropList));
    }
    showCropAdmin();
  }

  function _removeCrop(index) {
    var cropList = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]');
    cropList.splice(index, 1);
    if (typeof DB !== 'undefined') DB.save('shorashim-crop-types', cropList);
    else localStorage.setItem('shorashim-crop-types', JSON.stringify(cropList));
    showCropAdmin();
  }

  function logout() {
    if (confirm(tt('להתנתק מהמערכת?', 'ออกจากระบบ?', 'تسجيل الخروج؟'))) {
      closeMenu();
      if (typeof firebase !== 'undefined' && firebase.auth) {
        firebase.auth().signOut().then(function() {
          location.reload();
        });
      } else {
        location.reload();
      }
    }
  }

  // ── Public API ──
  return {
    init: init,
    punchIn: punchIn,
    punchOut: punchOut,
    stopPresence: stopPresence,
    toggleMenu: toggleMenu,
    closeMenu: closeMenu,
    logout: logout,
    showMyRecords: showMyRecords,
    showAllRecords: showAllRecords,
    showWorkplaceAdmin: showWorkplaceAdmin,
    editRecord: editRecord,
    renderClockBar: renderClockBar,
    _selectWorkplace: _selectWorkplace,
    _workplaceCallback: null,
    _saveEdit: _saveEdit,
    _deleteRecord: _deleteRecord,
    _addWorkplace: _addWorkplace,
    _removeWorkplace: _removeWorkplace,
    showCropAdmin: showCropAdmin,
    showProfileEdit: showProfileEdit,
    showAdminDashboard: showAdminDashboard,
    showExportMenu: showExportMenu,
    _saveProfile: _saveProfile,
    _changePassword: _changePassword,
    _exportCSV: _exportCSV,
    _backupAll: _backupAll,
    _restoreBackup: _restoreBackup,
    _addCrop: _addCrop,
    _removeCrop: _removeCrop,
    // ── Meckano upgrade — Phase 1 ──
    getCustomWorkplaces: getCustomWorkplaces,
    // ── Meckano upgrade — Phase 2 ──
    showBreakTypeModal: showBreakTypeModal,
    startBreakAndClose: startBreakAndClose,
    endBreak: endBreak,
    _forceApprove: _forceApprove
  };
})();

// Online/offline listeners — re-render the clock bar so the offline pill
// appears/disappears in sync with network state. Lives outside the IIFE so
// it survives the module being re-loaded.
window.addEventListener('online', function() {
  if (window.TimeClock && typeof window.TimeClock.renderClockBar === 'function') {
    window.TimeClock.renderClockBar();
  }
  if (typeof showToast === 'function') {
    showToast('🌐 ' + (typeof tt === 'function'
      ? tt('הרשומה סונכרנה','ซิงค์รายการแล้ว','تمت مزامنة السجل')
      : 'Back online'));
  }
});
window.addEventListener('offline', function() {
  if (window.TimeClock && typeof window.TimeClock.renderClockBar === 'function') {
    window.TimeClock.renderClockBar();
  }
});
