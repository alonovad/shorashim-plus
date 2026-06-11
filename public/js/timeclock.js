// ── TIME CLOCK MODULE ──
// Punch in/out system with workplace titles
// Depends on: DB (db.js), firebase/firestore, currentUser

var TimeClock = (function() {
  'use strict';

  var clockInterval = null;
  var currentShift = null; // { punchIn: timestamp, workplace: string }
  var workplaces = []; // admin-defined list

  function init() {
    loadWorkplaces();
    loadCurrentShift();
    renderClockBar();
    if (currentShift) startTicker();
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
    if (typeof db !== 'undefined') {
      db.collection('timeclock').doc(docId).set(record)
        .then(function() { console.log('Time record saved:', docId); })
        .catch(function(err) { console.error('Time record save failed:', err); });
    }
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

  // ── Clock Bar (persistent top bar) ──

  function renderClockBar() {
    var bar = document.getElementById('clockBar');
    if (!bar) return;

    if (!window.currentUser) {
      bar.style.display = 'none';
      return;
    }

    bar.style.display = 'flex';

    if (currentShift) {
      var elapsed = formatDuration(Date.now() - currentShift.punchIn);
      bar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
          '<span style="font-size:1.2rem;">🟢</span>' +
          '<div>' +
            '<div style="font-weight:700;font-size:0.85rem;" id="clockElapsed">' + elapsed + '</div>' +
            '<div style="font-size:0.7rem;opacity:0.8;">' + (currentShift.workplace || '') + '</div>' +
          '</div>' +
        '</div>' +
        '<button onclick="TimeClock.punchOut()" style="padding:6px 14px;border-radius:8px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">🔴 יציאה</button>';
    } else {
      bar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
          '<span style="font-size:1.2rem;">⚪</span>' +
          '<div style="font-size:0.85rem;font-weight:600;">לא בשעון</div>' +
        '</div>' +
        '<button onclick="TimeClock.punchIn()" style="padding:6px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">🟢 כניסה</button>';
    }
  }

  function startTicker() {
    if (clockInterval) clearInterval(clockInterval);
    clockInterval = setInterval(function() {
      var el = document.getElementById('clockElapsed');
      if (el && currentShift) {
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
    return d.toLocaleDateString('he-IL');
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
      currentShift = {
        punchIn: Date.now(),
        workplace: workplace,
        username: window.currentUser.username,
        userName: window.currentUser.name,
        shiftIndex: count
      };
      saveCurrentShift();
      renderClockBar();
      startTicker();
      if (typeof showToast === 'function') showToast('🟢 נכנסת — ' + workplace);
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

  // ── Punch Out ──

  function punchOut() {
    if (!currentShift) return;
    var record = {
      punchIn: currentShift.punchIn,
      punchOut: Date.now(),
      workplace: currentShift.workplace,
      username: currentShift.username,
      userName: currentShift.userName,
      shiftIndex: currentShift.shiftIndex,
      date: new Date(currentShift.punchIn).toISOString().slice(0, 10),
      duration: Date.now() - currentShift.punchIn
    };
    saveTimeRecord(record);
    currentShift = null;
    saveCurrentShift();
    stopTicker();
    renderClockBar();
    if (typeof showToast === 'function') showToast('🔴 יצאת — ' + formatDuration(record.duration));
  }

  // ── Workplace Picker Modal ──

  function showWorkplacePicker(callback, forceNew) {
    var options = getWorkplaceOptions();
    var modal = document.getElementById('modalContainer');
    var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">';
    html += '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:360px;max-height:80vh;overflow-y:auto;">';
    html += '<h3 style="font-weight:700;font-size:1.1rem;margin-bottom:12px;">📍 ' + (forceNew ? 'בחר מקום עבודה חדש' : 'בחר מקום עבודה') + '</h3>';

    if (options.length === 0) {
      html += '<div style="color:#999;text-align:center;padding:16px;">אין מקומות עבודה מוגדרים. המנהל צריך להגדיר.</div>';
    } else {
      options.forEach(function(opt) {
        html += '<button onclick="TimeClock._selectWorkplace(\'' + opt.replace(/'/g, "\\'") + '\')" style="display:block;width:100%;padding:12px 16px;margin-bottom:6px;border-radius:10px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.95rem;font-weight:600;cursor:pointer;text-align:right;">' + opt + '</button>';
      });
    }

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:10px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;font-size:0.9rem;cursor:pointer;">ביטול</button>';
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
    var panel = document.getElementById('hamburgerPanel');
    if (!panel) return;

    var html = '<div style="padding:16px;">';
    html += '<h3 style="font-weight:700;font-size:1.1rem;margin-bottom:16px;border-bottom:2px solid #e0e0e0;padding-bottom:8px;">⚙️ תפריט</h3>';

    // Time records - for all users
    html += '<button onclick="TaskBoard.showMyTasks();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#f3e5f5;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📋 המשימות שלי</button>';
    html += '<button onclick="TimeClock.showMyRecords();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#e8f5e9;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">🕐 הדוחות שלי</button>';
    html += '<button onclick="TimeClock.showProfileEdit();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#fce4ec;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">👤 הפרופיל שלי</button>';

    if (isAdmin) {
      html += '<button onclick="TimeClock.showAllRecords();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#e3f2fd;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📊 ניהול שעות</button>';
      html += '<button onclick="TaskBoard.showTaskManager();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#ede7f6;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📋 ניהול משימות</button>';
      html += '<button onclick="TimeClock.showAdminDashboard();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#e0f7fa;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📊 לוח בקרה</button>';
      html += '<button onclick="FieldReport.showReportsList();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#f9fbe7;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">🔬 דוחות סיור</button>';
      html += '<button onclick="TimeClock.showExportMenu();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#f1f8e9;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📥 ייצוא נתונים</button>';
      html += '<button onclick="TimeClock.showWorkplaceAdmin();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#fff3e0;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📍 מקומות עבודה</button>';
      html += '<button onclick="TimeClock.showCropAdmin();TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-bottom:6px;border-radius:10px;border:none;background:#e8f5e9;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">🌱 סוגי גידולים</button>';
    }

    html += '<button onclick="TimeClock.closeMenu()" style="display:block;width:100%;padding:12px;margin-top:12px;border-radius:10px;border:none;background:#f5f5f5;font-family:inherit;font-size:0.9rem;cursor:pointer;text-align:center;">סגור</button>';
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
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;"><div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;"><h3 style="font-weight:700;margin-bottom:12px;">🕐 הדוחות שלי</h3><div id="myRecordsContent" style="color:#999;text-align:center;padding:16px;">טוען...</div><button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button></div></div>';

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
          document.getElementById('myRecordsContent').innerHTML = '<div style="color:red;">שגיאה: ' + err.message + '</div>';
        });
    }
  }

  // ── Manager: All Records ──

  function showAllRecords() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;"><div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:600px;max-height:85vh;overflow-y:auto;"><h3 style="font-weight:700;margin-bottom:12px;">📊 ניהול שעות — כל העובדים</h3><div id="allRecordsContent" style="color:#999;text-align:center;padding:16px;">טוען...</div><button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button></div></div>';

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
          document.getElementById('allRecordsContent').innerHTML = '<div style="color:red;">שגיאה: ' + err.message + '<br>אם זו שגיאת index, לחץ על הקישור בקונסול ליצירת ה-index.</div>';
        });
    }
  }

  function renderRecordsTable(containerId, records, showUser) {
    var el = document.getElementById(containerId);
    if (records.length === 0) {
      el.innerHTML = '<div style="text-align:center;color:#999;padding:16px;">אין רשומות</div>';
      return;
    }

    var html = '<table style="width:100%;border-collapse:collapse;font-size:0.8rem;">';
    html += '<tr style="background:#f5f5f5;font-weight:700;">';
    html += '<td style="padding:6px;">תאריך</td>';
    if (showUser) html += '<td>עובד</td>';
    html += '<td>מקום</td><td>כניסה</td><td>יציאה</td><td>שעות</td>';
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
      modal.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:360px;">' +
          '<h3 style="font-weight:700;margin-bottom:12px;">✏️ עריכת רשומה</h3>' +
          '<div style="margin-bottom:8px;font-size:0.85rem;font-weight:600;">' + (r.userName || r.username) + ' — ' + (r.workplace || '') + '</div>' +
          '<label style="font-size:0.8rem;color:#666;">תאריך</label>' +
          '<input type="date" id="editDate" value="' + dateStr + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:8px;font-family:inherit;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
            '<div><label style="font-size:0.8rem;color:#666;">כניסה</label><input type="time" id="editIn" value="' + inTime + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.8rem;color:#666;">יציאה</label><input type="time" id="editOut" value="' + outTime + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button onclick="TimeClock._saveEdit(\'' + docId + '\')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">💾 שמור</button>' +
            '<button onclick="TimeClock._deleteRecord(\'' + docId + '\')" style="padding:10px 16px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button>' +
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">ביטול</button>' +
          '</div>' +
        '</div></div>';
    });
  }

  function _saveEdit(docId) {
    var dateVal = document.getElementById('editDate').value;
    var inVal = document.getElementById('editIn').value;
    var outVal = document.getElementById('editOut').value;
    if (!dateVal || !inVal) return;

    var punchIn = new Date(dateVal + 'T' + inVal + ':00').getTime();
    var punchOut = outVal ? new Date(dateVal + 'T' + outVal + ':00').getTime() : null;
    var update = { punchIn: punchIn, date: dateVal };
    if (punchOut) {
      update.punchOut = punchOut;
      update.duration = punchOut - punchIn;
    }

    db.collection('timeclock').doc(docId).update(update)
      .then(function() {
        document.getElementById('modalContainer').innerHTML = '';
        if (typeof showToast === 'function') showToast('💾 עודכן');
        showAllRecords();
      })
      .catch(function(err) {
        if (typeof showToast === 'function') showToast('❌ ' + err.message);
      });
  }

  function _deleteRecord(docId) {
    if (!confirm('למחוק רשומה זו?')) return;
    db.collection('timeclock').doc(docId).delete()
      .then(function() {
        document.getElementById('modalContainer').innerHTML = '';
        if (typeof showToast === 'function') showToast('🗑️ נמחק');
        showAllRecords();
      });
  }

  // ── Admin: Workplace Management ──

  function showWorkplaceAdmin() {
    var modal = document.getElementById('modalContainer');
    var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">';
    html += '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;max-height:80vh;overflow-y:auto;">';
    html += '<h3 style="font-weight:700;margin-bottom:12px;">📍 ניהול מקומות עבודה</h3>';
    html += '<div style="font-size:0.75rem;color:#999;margin-bottom:10px;">מטעים מהמערכת מתווספים אוטומטית. כאן ניתן להוסיף מקומות נוספים.</div>';

    // Show farms (read-only)
    if (typeof farms !== 'undefined' && farms.length > 0) {
      html += '<div style="font-size:0.8rem;font-weight:600;margin-bottom:4px;color:#666;">מטעים (אוטומטי):</div>';
      farms.forEach(function(f) {
        html += '<div style="padding:6px 10px;background:#e8f5e9;border-radius:6px;margin-bottom:4px;font-size:0.85rem;">🌳 ' + f.name + '</div>';
      });
    }

    // Show custom workplaces (editable)
    html += '<div style="font-size:0.8rem;font-weight:600;margin:10px 0 4px;color:#666;">מקומות נוספים:</div>';
    workplaces.forEach(function(w, i) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
      html += '<div style="flex:1;padding:6px 10px;background:#fff3e0;border-radius:6px;font-size:0.85rem;">📍 ' + w + '</div>';
      html += '<button onclick="TimeClock._removeWorkplace(' + i + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;">🗑️</button>';
      html += '</div>';
    });

    html += '<div style="display:flex;gap:6px;margin-top:10px;">';
    html += '<input id="newWorkplaceName" placeholder="שם מקום עבודה חדש" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">';
    html += '<button onclick="TimeClock._addWorkplace()" style="padding:8px 16px;border-radius:8px;border:none;background:#ff9800;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕</button>';
    html += '</div>';

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button>';
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
        '<h3 style="font-weight:700;margin-bottom:12px;">👤 הפרופיל שלי</h3>' +
        '<div style="display:grid;gap:10px;">' +
          '<div><label style="font-size:0.8rem;color:#666;">שם</label><input id="profName" value="' + (user.name || '') + '" style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '<div><label style="font-size:0.8rem;color:#666;">אימייל</label><input id="profEmail" value="' + (user.email || '') + '" readonly style="width:100%;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;background:#f0f0f0;direction:ltr;text-align:left;"></div>' +
          '<div><label style="font-size:0.8rem;color:#666;">תפקיד</label><div style="padding:8px 12px;background:#f0f0f0;border-radius:8px;">' + (user.role || '') + '</div></div>' +
          '<button onclick="TimeClock._changePassword()" style="padding:10px;border-radius:8px;border:1px solid #ff9800;background:transparent;color:#ff9800;font-family:inherit;font-weight:600;cursor:pointer;">🔑 שנה סיסמה</button>' +
          '<div style="display:flex;gap:8px;">' +
            '<button onclick="TimeClock._saveProfile()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">💾 שמור</button>' +
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button>' +
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
      if (typeof showToast === 'function') showToast('✅ פרופיל עודכן');
      document.getElementById('modalContainer').innerHTML = '';
    }
  }

  function _changePassword() {
    var email = window.currentUser ? window.currentUser.email : '';
    if (!email || typeof auth === 'undefined') return;
    auth.sendPasswordResetEmail(email).then(function() {
      if (typeof showToast === 'function') showToast('📧 נשלח מייל לאיפוס סיסמה');
    }).catch(function(err) {
      if (typeof showToast === 'function') showToast('❌ ' + err.message);
    });
  }

  // ── Admin Dashboard ──

  function showAdminDashboard() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:16px;">📊 לוח בקרה</h3>' +
        '<div id="dashboardContent" style="color:#999;text-align:center;padding:16px;">טוען...</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button>' +
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
          var clockedIn = todayRecords.filter(function(r) { return !r.punchOut; }).length;
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
                '<div style="font-size:0.75rem;color:#666;">עובדים היום</div>' +
              '</div>' +
              '<div style="background:#e3f2fd;border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + clockedIn + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">מחוברים עכשיו</div>' +
              '</div>' +
              '<div style="background:#fff3e0;border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + (todayHours / 3600000).toFixed(1) + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">שעות היום</div>' +
              '</div>' +
              '<div style="background:' + (overdueTasks > 0 ? '#ffebee' : '#f3e5f5') + ';border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + pendingTasks + '</div>' +
                '<div style="font-size:0.75rem;color:#666;">משימות פתוחות' + (overdueTasks > 0 ? ' (' + overdueTasks + ' באיחור)' : '') + '</div>' +
              '</div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">' +
              '<div style="background:var(--g6);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:1.3rem;font-weight:800;">' + userCount + '</div><div style="font-size:0.7rem;color:#999;">משתמשים</div></div>' +
              '<div style="background:var(--g6);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:1.3rem;font-weight:800;">' + plotCount + '</div><div style="font-size:0.7rem;color:#999;">חלקות</div></div>' +
              '<div style="background:var(--g6);border-radius:10px;padding:10px;text-align:center;">' +
                '<div style="font-size:1.3rem;font-weight:800;">' + sprayCount + '</div><div style="font-size:0.7rem;color:#999;">ריסוסים</div></div>' +
            '</div>';
        });
    }
  }

  // ── Data Export ──

  function showExportMenu() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">📥 ייצוא נתונים</h3>' +
        '<div style="display:grid;gap:8px;">' +
          '<button onclick="TimeClock._exportCSV(\'timeclock\')" style="padding:12px;border-radius:10px;border:none;background:#e8f5e9;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">🕐 שעות עבודה (CSV)</button>' +
          '<button onclick="TimeClock._exportCSV(\'spray\')" style="padding:12px;border-radius:10px;border:none;background:#e3f2fd;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">💧 יומן ריסוס (CSV)</button>' +
          '<button onclick="TimeClock._exportCSV(\'worklog\')" style="padding:12px;border-radius:10px;border:none;background:#fff3e0;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📝 יומן עבודה (CSV)</button>' +
          '<button onclick="TimeClock._exportCSV(\'tasks\')" style="padding:12px;border-radius:10px;border:none;background:#f3e5f5;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">📋 משימות (CSV)</button>' +
        '</div>' +
        '<div style="margin-top:16px;padding-top:16px;border-top:2px solid #eee;">' +
          '<h4 style="font-weight:700;font-size:0.9rem;margin-bottom:8px;">💾 גיבוי ושחזור</h4>' +
          '<div style="display:grid;gap:8px;">' +
            '<button onclick="TimeClock._backupAll()" style="padding:12px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;">⬇️ הורד גיבוי מלא (JSON)</button>' +
            '<label style="padding:12px;border-radius:10px;border:2px dashed #999;font-family:inherit;font-size:0.9rem;font-weight:600;cursor:pointer;text-align:right;display:block;color:#666;">⬆️ שחזר מגיבוי<input type="file" accept=".json" onchange="TimeClock._restoreBackup(this.files[0])" style="display:none;"></label>' +
          '</div>' +
        '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button>' +
      '</div></div>';
  }

  function _exportCSV(type) {
    var rows = [];
    var filename = '';

    if (type === 'timeclock') {
      filename = 'timeclock_' + new Date().toISOString().slice(0,10) + '.csv';
      rows.push(['תאריך', 'עובד', 'מקום עבודה', 'כניסה', 'יציאה', 'שעות']);
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
      rows.push(['תאריך', 'מפעיל', 'חלקות', 'תכשיר', 'ריכוז', 'כמות', 'הערות']);
      events.forEach(function(e) {
        rows.push([e.date || '', e.operator || '', (e.plotNames || []).join('; '), e.pesticide || '', e.concentration || '', e.quantity || '', e.notes || '']);
      });
    }

    if (type === 'worklog') {
      filename = 'worklog_' + new Date().toISOString().slice(0,10) + '.csv';
      var data = JSON.parse(localStorage.getItem('plotMapperSprayData') || '{}');
      var entries = data.worklogEntries || [];
      rows.push(['תאריך', 'חלקה', 'סעיף', 'פעולה', 'קבוצת עובדים', 'מספר עובדים', 'שעות', 'עצים', 'הערות']);
      entries.forEach(function(e) {
        rows.push([e.date || '', e.plot_name || '', e.budget_category || '', e.description || '', e.worker_group || '', e.worker_count || '', e.hours || '', e.trees || '', e.notes || '']);
      });
    }

    if (type === 'tasks') {
      filename = 'tasks_' + new Date().toISOString().slice(0,10) + '.csv';
      var tasks = JSON.parse(localStorage.getItem('shorashim-tasks') || '[]');
      rows.push(['כותרת', 'תיאור', 'מוקצה ל', 'מקום', 'תאריך יעד', 'סטטוס', 'נוצר']);
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
    if (typeof showToast === 'function') showToast('💾 גיבוי הורד');
  }

  function _restoreBackup(file) {
    if (!file) return;
    if (!confirm('שחזור גיבוי ידרוס את כל הנתונים הנוכחיים. להמשיך?')) return;

    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var backup = JSON.parse(e.target.result);
        if (backup._type !== 'shorashim-plus-backup') {
          if (typeof showToast === 'function') showToast('❌ קובץ לא תקין');
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

        if (typeof showToast === 'function') showToast('✅ גיבוי שוחזר — רענן את הדף');
        setTimeout(function() { location.reload(); }, 2000);
      } catch(err) {
        if (typeof showToast === 'function') showToast('❌ שגיאה: ' + err.message);
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
    html += '<h3 style="font-weight:700;margin-bottom:12px;">🌱 ניהול סוגי גידולים</h3>';
    html += '<div style="font-size:0.75rem;color:#999;margin-bottom:10px;">הגידולים ישמשו לסינון חומרי הדברה ולהגדרת חלקות.</div>';

    cropList.forEach(function(c, i) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">';
      html += '<div style="flex:1;padding:6px 10px;background:#e8f5e9;border-radius:6px;font-size:0.85rem;">🌱 ' + c + '</div>';
      html += '<button onclick="TimeClock._removeCrop(' + i + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;">🗑️</button>';
      html += '</div>';
    });

    html += '<div style="display:flex;gap:6px;margin-top:10px;">';
    html += '<input id="newCropName" placeholder="שם גידול חדש (לדוגמה: תמרים)" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">';
    html += '<button onclick="TimeClock._addCrop()" style="padding:8px 16px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕</button>';
    html += '</div>';

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button>';
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

  // ── Public API ──
  return {
    init: init,
    punchIn: punchIn,
    punchOut: punchOut,
    toggleMenu: toggleMenu,
    closeMenu: closeMenu,
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
    _removeCrop: _removeCrop
  };
})();
