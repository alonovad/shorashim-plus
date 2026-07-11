// ── TEAM MODULE (Meckano-style manager→workers assignment) ──
// Each manager (מנהל, role: operator or admin) owns a team of workers,
// pulled from the shared user pool that the admin maintains in user
// management. The assignment map is stored in appData under
// 'shorashim-manager-teams':  { managerUsername: [workerUsername, ...] }
//
// Permissions model:
//   admin    — sees ALL managers (dropdown), edits any manager's team.
//   operator — sees and edits ONLY his own team.
//   worker   — no access (menu button hidden + guard here).
//
// Consumed by monthly-report.js: employeeList() filters an operator's
// employee dropdown to his own team; admin filters by manager.
//
// Depends (defensive): DB (db.js), window.users, window.currentUser,
// Audit (audit.js), showToast.

var Team = (function() {
  'use strict';

  var KEY = 'shorashim-manager-teams';
  var teams = {};            // { managerUsername: [workerUsername, ...] }
  var selectedManager = null; // admin's currently viewed manager

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }
  function isAdmin() { return window.currentUser && window.currentUser.role === 'admin'; }
  function isManager() {
    return window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'operator');
  }

  // ── data ──
  function refresh() {
    if (typeof DB === 'undefined') return Promise.resolve(teams);
    return DB.loadAsync(KEY).then(function(data) {
      teams = (data && typeof data === 'object') ? data : {};
      return teams;
    }).catch(function() { return teams; });
  }
  function persist() { if (typeof DB !== 'undefined') DB.save(KEY, teams); }

  function getTeam(managerUsername) {
    var t = teams[managerUsername];
    return Array.isArray(t) ? t.slice() : [];
  }
  // Workers of the logged-in manager (operators use this for filtering)
  function getMyWorkers() {
    if (!window.currentUser) return [];
    return getTeam(window.currentUser.username);
  }

  // ── shared pool + manager list (from admin-maintained users blob) ──
  function allUsers() { return (typeof window.users === 'object' && window.users) ? window.users : {}; }
  function managersList() {
    var u = allUsers(), list = [];
    Object.keys(u).forEach(function(k) {
      if (u[k] && (u[k].role === 'operator' || u[k].role === 'admin')) {
        list.push({ username: k, name: u[k].name || k, role: u[k].role });
      }
    });
    list.sort(function(a, b) { return a.name.localeCompare(b.name, 'he'); });
    return list;
  }
  function poolWorkers() {
    var u = allUsers(), list = [];
    Object.keys(u).forEach(function(k) {
      if (u[k] && u[k].role === 'worker') list.push({ username: k, name: u[k].name || k });
    });
    list.sort(function(a, b) { return a.name.localeCompare(b.name, 'he'); });
    return list;
  }
  function workerName(username) {
    var u = allUsers();
    return (u[username] && u[username].name) ? u[username].name : username;
  }

  // Can the logged-in user edit this manager's team?
  function canEdit(managerUsername) {
    if (isAdmin()) return true;
    return isManager() && window.currentUser.username === managerUsername;
  }

  // ── UI ──
  function show() {
    if (!isManager()) { toast('⛔ ' + tt('רק מנהל יכול לנהל צוות', 'เฉพาะผู้จัดการ', 'للمدير فقط')); return; }
    if (!isAdmin()) selectedManager = window.currentUser.username;
    else if (!selectedManager) {
      var mgrs = managersList();
      selectedManager = (mgrs[0] && mgrs[0].username) || window.currentUser.username;
    }
    refresh().then(render);
  }

  function render() {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;

    var editable = canEdit(selectedManager);
    var team = getTeam(selectedManager);
    var pool = poolWorkers().filter(function(w) { return team.indexOf(w.username) === -1; });

    // Admin: dropdown over every manager (per-manager team view + edit)
    var mgrSel = '';
    if (isAdmin()) {
      var mgrs = managersList();
      mgrSel = '<div style="margin-bottom:12px;">' +
        '<label style="font-size:0.8rem;color:#666;display:block;margin-bottom:4px;">' + tt('מנהל', 'ผู้จัดการ', 'مدير') + '</label>' +
        '<select onchange="Team._pickManager(this.value)" style="width:100%;padding:9px;border-radius:10px;border:1px solid #ddd;font-family:inherit;font-weight:700;">' +
        mgrs.map(function(m) {
          var tag = m.role === 'admin' ? ' (' + tt('מנהל ראשי', 'แอดมิน', 'مسؤول') + ')' : '';
          var cnt = getTeam(m.username).length;
          return '<option value="' + m.username + '"' + (m.username === selectedManager ? ' selected' : '') + '>' + m.name + tag + ' — ' + cnt + ' ' + tt('עובדים', 'คนงาน', 'عمال') + '</option>';
        }).join('') +
        '</select></div>';
    }

    var teamRows;
    if (team.length === 0) {
      teamRows = '<div style="color:#999;text-align:center;padding:18px;font-size:0.85rem;">' + tt('אין עובדים בצוות עדיין. הוסף מהרשימה המשותפת למטה.', 'ยังไม่มีคนงานในทีม เพิ่มจากรายการด้านล่าง', 'لا يوجد عمال في الفريق بعد. أضف من القائمة أدناه.') + '</div>';
    } else {
      teamRows = team.map(function(u) {
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:9px 12px;border-bottom:1px solid #f3f3f3;">' +
          '<span style="font-weight:600;font-size:0.88rem;">👷 ' + workerName(u) + '</span>' +
          (editable ? '<button onclick="Team._remove(\'' + u + '\')" title="' + tt('הסר', 'ลบ', 'إزالة') + '" style="border:none;background:#fdeceb;color:#c0392b;border-radius:8px;padding:4px 10px;cursor:pointer;font-family:inherit;font-size:0.78rem;font-weight:700;">✖ ' + tt('הסר', 'ลบ', 'إزالة') + '</button>' : '') +
          '</div>';
      }).join('');
    }

    var addBlock = '';
    if (editable) {
      if (pool.length === 0) {
        addBlock = '<div style="color:#999;font-size:0.78rem;padding:8px 0;">' + tt('כל העובדים מהרשימה המשותפת כבר בצוות (או שאין עובדים — האדמין מוסיף בניהול משתמשים).', 'คนงานทั้งหมดอยู่ในทีมแล้ว', 'كل العمال في الفريق بالفعل.') + '</div>';
      } else {
        addBlock =
          '<div style="display:flex;gap:8px;margin-top:10px;">' +
            '<select id="teamAddSel" style="flex:1;padding:9px;border-radius:10px;border:1px solid #ddd;font-family:inherit;">' +
              pool.map(function(w) { return '<option value="' + w.username + '">' + w.name + '</option>'; }).join('') +
            '</select>' +
            '<button onclick="Team._add()" style="padding:9px 16px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕ ' + tt('הוסף', 'เพิ่ม', 'أضف') + '</button>' +
          '</div>';
      }
    }

    modal.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:92%;max-width:440px;max-height:88vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:4px;">👥 ' + tt('ניהול צוות', 'จัดการทีม', 'إدارة الفريق') + '</h3>' +
        '<div style="font-size:0.76rem;color:#999;margin-bottom:12px;">' + tt('העובדים נמשכים מהרשימה המשותפת שהאדמין מנהל במסך המשתמשים', 'คนงานมาจากรายการกลางที่แอดมินจัดการ', 'العمال من القائمة المشتركة التي يديرها المسؤول') + '</div>' +
        mgrSel +
        '<div style="border:1px solid #eee;border-radius:12px;overflow:hidden;">' +
          '<div style="background:#f6f8f7;padding:8px 12px;font-size:0.75rem;font-weight:700;color:#666;">' + tt('הצוות של', 'ทีมของ', 'فريق') + ' ' + workerName(selectedManager) + ' (' + team.length + ')</div>' +
          teamRows +
        '</div>' +
        addBlock +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="width:100%;margin-top:14px;padding:11px;border-radius:10px;border:none;background:#eee;font-family:inherit;font-weight:600;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';
  }

  // ── actions ──
  function _pickManager(username) { selectedManager = username; render(); }

  function _add() {
    if (!canEdit(selectedManager)) { toast('⛔'); return; }
    var sel = document.getElementById('teamAddSel');
    if (!sel || !sel.value) return;
    var before = getTeam(selectedManager);
    if (!Array.isArray(teams[selectedManager])) teams[selectedManager] = [];
    if (teams[selectedManager].indexOf(sel.value) === -1) teams[selectedManager].push(sel.value);
    persist();
    if (typeof Audit !== 'undefined') {
      Audit.log('edit', 'team', selectedManager, { targetUser: sel.value, before: { workers: before }, after: { workers: teams[selectedManager].slice() }, reason: 'add worker to team' });
    }
    toast('✅ ' + tt('נוסף לצוות', 'เพิ่มแล้ว', 'تمت الإضافة'));
    render();
  }

  function _remove(username) {
    if (!canEdit(selectedManager)) { toast('⛔'); return; }
    var before = getTeam(selectedManager);
    teams[selectedManager] = before.filter(function(u) { return u !== username; });
    persist();
    if (typeof Audit !== 'undefined') {
      Audit.log('edit', 'team', selectedManager, { targetUser: username, before: { workers: before }, after: { workers: teams[selectedManager].slice() }, reason: 'remove worker from team' });
    }
    toast('🗑️ ' + tt('הוסר מהצוות', 'ลบแล้ว', 'تمت الإزالة'));
    render();
  }

  // ── Public API ──
  return {
    show: show,
    refresh: refresh,
    getTeam: getTeam,
    getMyWorkers: getMyWorkers,
    _pickManager: _pickManager,
    _add: _add,
    _remove: _remove
  };
})();
