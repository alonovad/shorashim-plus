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
        '<button onclick="TimeClock.punchOut()" style="padding:6px 14px;border-radius:8px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">' + tt('🔴 יציאה', '🔴 ออกงาน', '🔴 خروج') + '</button>';
    } else {
      bar.innerHTML =
        '<div style="display:flex;align-items:center;gap:8px;flex:1;">' +
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
      if (typeof showToast === 'function') showToast('🟢 ' + tt('נכנסת', 'เข้างานแล้ว', 'دخلت') + ' — ' + workplace);
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
    if (typeof showToast === 'function') showToast('🔴 ' + tt('יצאת', 'ออกงานแล้ว', 'خرجت') + ' — ' + formatDuration(record.duration));
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

    // ── My Stuff (always visible, expanded) ──
    html += '<button onclick="TaskBoard.showMyTasks();TimeClock.closeMenu()" style="' + menuBtn + 'background:#f3e5f5;">' + tt('📋 המשימות שלי', '📋 งานของฉัน', '📋 مهامي') + '</button>';
    html += '<button onclick="TimeClock.showMyRecords();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e8f5e9;">' + tt('🕐 הדוחות שלי', '🕐 รายงานของฉัน', '🕐 تقاريري') + '</button>';
    html += '<button onclick="TimeClock.showProfileEdit();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fce4ec;">' + tt('👤 הפרופיל שלי', '👤 โปรไฟล์ของฉัน', '👤 ملفي الشخصي') + '</button>';

    if (isManager) {
      // ── Management (collapsed) ──
      html += '<div onclick="var d=document.getElementById(\'menuMgmt\');d.style.display=d.style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.chev\').textContent=d.style.display===\'none\'?\'▸\':\'▾\'" style="' + groupHead + 'margin-top:10px;">';
      html += '<span style="font-weight:700;font-size:0.85rem;color:#555;"><span class="chev">▸</span> ' + tt('ניהול', 'จัดการ', 'إدارة') + '</span>';
      html += '</div>';
      html += '<div id="menuMgmt" style="display:none;">';
      html += '<button onclick="TimeClock.showAllRecords();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e3f2fd;">' + tt('📊 ניהול שעות', '📊 จัดการชั่วโมง', '📊 إدارة الساعات') + '</button>';
      html += '<button onclick="TaskBoard.showTaskManager();TimeClock.closeMenu()" style="' + menuBtn + 'background:#ede7f6;">' + tt('📋 ניהול משימות', '📋 จัดการงาน', '📋 إدارة المهام') + '</button>';
      html += '<button onclick="TimeClock.showAdminDashboard();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e0f7fa;">' + tt('📊 לוח בקרה', '📊 แดชบอร์ด', '📊 لوحة التحكم') + '</button>';
      html += '<button onclick="FieldReport.showReportsList();TimeClock.closeMenu()" style="' + menuBtn + 'background:#f9fbe7;">' + tt('🔬 דוחות סיור', '🔬 รายงานสำรวจ', '🔬 تقارير الجولات') + '</button>';
      html += '<button onclick="Maintenance.showProjectsList();TimeClock.closeMenu()" style="' + menuBtn + 'background:#efebe9;">' + tt('🔧 תחזוקה', '🔧 ซ่อมบำรุง', '🔧 صيانة') + '</button>';
      html += '</div>';

      // ── Settings (collapsed) ──
      html += '<div onclick="var d=document.getElementById(\'menuSettings\');d.style.display=d.style.display===\'none\'?\'block\':\'none\';this.querySelector(\'.chev\').textContent=d.style.display===\'none\'?\'▸\':\'▾\'" style="' + groupHead + '">';
      html += '<span style="font-weight:700;font-size:0.85rem;color:#555;"><span class="chev">▸</span> ' + tt('הגדרות', 'ตั้งค่า', 'إعدادات') + '</span>';
      html += '</div>';
      html += '<div id="menuSettings" style="display:none;">';
      html += '<button onclick="TimeClock.showExportMenu();TimeClock.closeMenu()" style="' + menuBtn + 'background:#f1f8e9;">' + tt('📥 ייצוא נתונים', '📥 ส่งออกข้อมูล', '📥 تصدير البيانات') + '</button>';
      html += '<button onclick="TimeClock.showWorkplaceAdmin();TimeClock.closeMenu()" style="' + menuBtn + 'background:#fff3e0;">' + tt('📍 מקומות עבודה', '📍 สถานที่ทำงาน', '📍 أماكن العمل') + '</button>';
      html += '<button onclick="TimeClock.showCropAdmin();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e8f5e9;">' + tt('🌱 סוגי גידולים', '🌱 ประเภทพืช', '🌱 أنواع المحاصيل') + '</button>';
      html += '</div>';
    }

    // ── Bottom actions ──
    html += '<div style="margin-top:14px;padding-top:10px;border-top:1px solid #eee;">';
    html += '<button onclick="DisplaySettings.showSettings();TimeClock.closeMenu()" style="' + menuBtn + 'background:#e0f7fa;text-align:center;">' + tt('🎨 הגדרות תצוגה', '🎨 การตั้งค่าการแสดงผล', '🎨 إعدادات العرض') + '</button>';
    html += '<button onclick="location.reload(true)" style="' + menuBtn + 'background:#e3f2fd;text-align:center;">' + tt('🔄 רענן אפליקציה', '🔄 รีเฟรชแอป', '🔄 تحديث التطبيق') + '</button>';
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
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;"><div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;"><h3 style="font-weight:700;margin-bottom:12px;">' + tt('🕐 הדוחות שלי', '🕐 รายงานของฉัน', '🕐 تقاريري') + '</h3><div id="myRecordsContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div><button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلาق') + '</button></div></div>';

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
      modal.innerHTML =
        '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:360px;">' +
          '<h3 style="font-weight:700;margin-bottom:12px;">✏️ ' + tt('עריכת רשומה', 'แก้ไขรายการ', 'تعديل سجل') + '</h3>' +
          '<div style="margin-bottom:8px;font-size:0.85rem;font-weight:600;">' + (r.userName || r.username) + ' — ' + (r.workplace || '') + '</div>' +
          '<label style="font-size:0.8rem;color:#666;">' + tt('תאריך', 'วันที่', 'تاريخ') + '</label>' +
          '<input type="date" id="editDate" value="' + dateStr + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;margin-bottom:8px;font-family:inherit;">' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">' +
            '<div><label style="font-size:0.8rem;color:#666;">' + tt('כניסה', 'เข้า', 'دخول') + '</label><input type="time" id="editIn" value="' + inTime + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.8rem;color:#666;">' + tt('יציאה', 'ออก', 'خروج') + '</label><input type="time" id="editOut" value="' + outTime + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button onclick="TimeClock._saveEdit(\'' + docId + '\')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">' + tt('💾 שמור', '💾 บันทึก', '💾 حفظ') + '</button>' +
            '<button onclick="TimeClock._deleteRecord(\'' + docId + '\')" style="padding:10px 16px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button>' +
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
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
        if (typeof showToast === 'function') showToast('💾 ' + tt('עודכן', 'อัปเดตแล้ว', 'تم التحديث'));
        showAllRecords();
      })
      .catch(function(err) {
        if (typeof showToast === 'function') showToast('❌ ' + err.message);
      });
  }

  function _deleteRecord(docId) {
    if (!confirm(tt('למחוק רשומה זו?', 'ลบรายการนี้?', 'حذف هذا السجل؟'))) return;
    db.collection('timeclock').doc(docId).delete()
      .then(function() {
        document.getElementById('modalContainer').innerHTML = '';
        if (typeof showToast === 'function') showToast('🗑️ ' + tt('נמחק', 'ลบแล้ว', 'تم الحذف'));
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
        html += '<div style="padding:6px 10px;background:#e8f5e9;border-radius:6px;margin-bottom:4px;font-size:0.85rem;">🌳 ' + f.name + '</div>';
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
                '<div style="font-size:0.75rem;color:#666;">' + tt('עובדים היום', 'คนงานวันนี้', 'العمال اليوم') + '</div>' +
              '</div>' +
              '<div style="background:#e3f2fd;border-radius:12px;padding:14px;text-align:center;">' +
                '<div style="font-size:2rem;font-weight:900;">' + clockedIn + '</div>' +
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
            '</div>';
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
    _removeCrop: _removeCrop
  };
})();
