// ── TASK BOARD MODULE ──
// Assigns tasks to workers with due dates
// Admin/Manager creates tasks, workers see their tasks in their language

var TaskBoard = (function() {
  'use strict';

  // ── Data ──

  function saveTasks(tasks) {
    if (typeof DB !== 'undefined') DB.save('shorashim-tasks', tasks);
  }

  function loadTasks() {
    return new Promise(function(resolve) {
      if (typeof DB !== 'undefined') {
        DB.loadAsync('shorashim-tasks').then(function(data) {
          resolve(data || []);
        });
      } else {
        var saved = localStorage.getItem('shorashim-tasks');
        resolve(saved ? JSON.parse(saved) : []);
      }
    });
  }

  // ── Task CRUD ──

  function createTask(task) {
    loadTasks().then(function(tasks) {
      task.id = Date.now();
      task.created = Date.now();
      task.createdBy = window.currentUser ? window.currentUser.username : '';
      task.status = 'pending';
      tasks.push(task);
      saveTasks(tasks);
      if (typeof showToast === 'function') showToast('✅ ' + tt('משימה נוספה', 'เพิ่มงานแล้ว', 'تمت إضافة المهمة'));
    });
  }

  function updateTask(taskId, updates) {
    loadTasks().then(function(tasks) {
      var task = tasks.find(function(t) { return t.id === taskId; });
      if (task) {
        Object.keys(updates).forEach(function(k) { task[k] = updates[k]; });
        saveTasks(tasks);
      }
    });
  }

  function deleteTask(taskId) {
    loadTasks().then(function(tasks) {
      tasks = tasks.filter(function(t) { return t.id !== taskId; });
      saveTasks(tasks);
      if (typeof showToast === 'function') showToast('🗑️ ' + tt('משימה נמחקה', 'ลบงานแล้ว', 'تم حذف المهمة'));
    });
  }

  // ── Translation helper ──

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  // ── Worker View: My Tasks ──

  function showMyTasks() {
    var username = window.currentUser ? window.currentUser.username : '';
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">📋 ' + tt('המשימות שלי', 'งานของฉัน', 'مهامي') + '</h3>' +
        '<div id="myTasksContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';

    loadTasks().then(function(tasks) {
      var myTasks = tasks.filter(function(t) { return t.assignedTo === username; });
      // Sort: pending first, then by due date
      myTasks.sort(function(a, b) {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        return (a.dueDate || '').localeCompare(b.dueDate || '');
      });
      renderMyTasks(myTasks);
    });
  }

  function renderMyTasks(tasks) {
    var el = document.getElementById('myTasksContent');
    if (!el) return;

    if (tasks.length === 0) {
      el.innerHTML = '<div style="text-align:center;padding:24px;color:#999;">' +
        '<div style="font-size:2rem;margin-bottom:8px;">✅</div>' +
        '<div>' + tt('אין משימות', 'ไม่มีงาน', 'لا توجد مهام') + '</div></div>';
      return;
    }

    var today = new Date().toISOString().slice(0, 10);
    var html = '';
    tasks.forEach(function(task) {
      var isOverdue = task.dueDate && task.dueDate < today && task.status === 'pending';
      var isDone = task.status === 'done';
      var borderColor = isDone ? '#4caf50' : isOverdue ? '#f44336' : '#ff9800';
      var bgColor = isDone ? '#f1f8e9' : isOverdue ? '#ffebee' : '#fff8e1';

      html += '<div style="background:' + bgColor + ';border-radius:10px;padding:12px;margin-bottom:8px;border-right:4px solid ' + borderColor + ';">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;">';
      html += '<div style="flex:1;">';
      html += '<div style="font-weight:700;font-size:0.95rem;' + (isDone ? 'text-decoration:line-through;opacity:0.6;' : '') + '">' + task.title + '</div>';
      if (task.description) {
        html += '<div style="font-size:0.8rem;color:#666;margin-top:3px;">' + task.description + '</div>';
      }
      if (task.workplace) {
        html += '<div style="font-size:0.75rem;color:#999;margin-top:3px;">📍 ' + task.workplace + '</div>';
      }
      html += '<div style="font-size:0.72rem;color:#999;margin-top:4px;">';
      if (task.dueDate) {
        html += '📅 ' + task.dueDate;
        if (isOverdue) html += ' <span style="color:#f44336;font-weight:700;">(' + tt('באיחור', 'เลยกำหนด', 'متأخر') + ')</span>';
      }
      html += '</div>';
      html += '</div>';

      if (!isDone) {
        html += '<button onclick="TaskBoard.markDone(' + task.id + ')" style="padding:8px 12px;border-radius:8px;border:none;background:#4caf50;color:white;font-size:0.8rem;font-weight:700;cursor:pointer;white-space:nowrap;">✓ ' + tt('בוצע', 'เสร็จ', 'تم') + '</button>';
      } else {
        html += '<span style="font-size:1.2rem;">✅</span>';
      }
      html += '</div></div>';
    });
    el.innerHTML = html;
  }

  function markDone(taskId) {
    loadTasks().then(function(tasks) {
      var task = tasks.find(function(t) { return t.id === taskId; });
      if (task) {
        task.status = 'done';
        task.completedAt = Date.now();
        saveTasks(tasks);
        showMyTasks(); // refresh
      }
    });
  }

  // ── Manager View: Assign Tasks ──

  function showTaskManager() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:600px;max-height:85vh;overflow-y:auto;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<h3 style="font-weight:700;">📋 ' + tt('ניהול משימות', 'จัดการงาน', 'إدارة المهام') + '</h3>' +
          '<button onclick="TaskBoard.showNewTaskForm()" style="padding:6px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">' + tt('➕ חדש', '➕ ใหม่', '➕ جديد') + '</button>' +
        '</div>' +
        '<div id="taskManagerContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';

    loadTasks().then(function(tasks) {
      tasks.sort(function(a, b) {
        if (a.status !== b.status) return a.status === 'pending' ? -1 : 1;
        return (b.created || 0) - (a.created || 0);
      });
      renderTaskManager(tasks);
    });
  }

  function renderTaskManager(tasks) {
    var el = document.getElementById('taskManagerContent');
    if (!el) return;

    if (tasks.length === 0) {
      el.innerHTML = '<div style="padding:16px;text-align:center;color:#999;">' + tt('אין משימות — לחץ ➕ להוספה', 'ไม่มีงาน — กด ➕ เพื่อเพิ่ม', 'لا توجد مهام — اضغط ➕ للإضافة') + '</div>';
      return;
    }

    // Get user names map
    var users = {};
    try { users = JSON.parse(localStorage.getItem('shorashim-users') || '{}'); } catch(e) {}

    var html = '';
    tasks.forEach(function(task) {
      var isDone = task.status === 'done';
      var assignedName = '';
      if (task.assignedTo && users[task.assignedTo]) {
        assignedName = users[task.assignedTo].name || task.assignedTo;
      }

      html += '<div style="background:' + (isDone ? '#f1f8e9' : 'var(--g6)') + ';border-radius:10px;padding:12px;margin-bottom:8px;opacity:' + (isDone ? '0.7' : '1') + ';">';
      html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;">';
      html += '<div style="flex:1;">';
      html += '<div style="font-weight:700;font-size:0.9rem;' + (isDone ? 'text-decoration:line-through;' : '') + '">' + task.title + '</div>';
      if (task.description) html += '<div style="font-size:0.78rem;color:#666;margin-top:2px;">' + task.description + '</div>';
      html += '<div style="font-size:0.72rem;color:#999;margin-top:4px;">';
      if (assignedName) html += '👤 ' + assignedName + ' &nbsp;';
      if (task.workplace) html += '📍 ' + task.workplace + ' &nbsp;';
      if (task.dueDate) html += '📅 ' + task.dueDate;
      if (isDone) html += ' &nbsp;✅';
      html += '</div></div>';
      html += '<button onclick="TaskBoard._deleteTask(' + task.id + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;">🗑️</button>';
      html += '</div></div>';
    });
    el.innerHTML = html;
  }

  // ── New Task Form ──

  function showNewTaskForm() {
    // Get workers list
    var users = {};
    try { users = JSON.parse(localStorage.getItem('shorashim-users') || '{}'); } catch(e) {}
    var workerOptions = '<option value="">' + tt('— בחר עובד —', '— เลือกคนงาน —', '— اختر عامل —') + '</option>';
    Object.values(users).forEach(function(u) {
      if (u.username) {
        workerOptions += '<option value="' + u.username + '">' + u.name + ' (' + u.role + ')</option>';
      }
    });

    // Get workplaces
    var workplaceOptions = '<option value="">' + tt('— מקום (אופציונלי) —', '— สถานที่ (ไม่บังคับ) —', '— مكان (اختياري) —') + '</option>';
    if (typeof farms !== 'undefined') {
      farms.forEach(function(f) {
        workplaceOptions += '<option value="' + f.name + '">' + f.name + '</option>';
      });
    }

    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:90%;max-width:400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">➕ ' + tt('משימה חדשה', 'งานใหม่', 'مهمة جديدة') + '</h3>' +
        '<div style="display:grid;gap:10px;">' +
          '<input id="taskTitle" placeholder="' + tt('כותרת המשימה', 'ชื่องาน', 'عنوان المهمة') + '" style="padding:10px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;font-size:0.95rem;">' +
          '<textarea id="taskDesc" placeholder="' + tt('תיאור (אופציונלי)', 'รายละเอียด (ไม่บังคับ)', 'وصف (اختياري)') + '" rows="2" style="padding:10px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;font-size:0.85rem;resize:vertical;"></textarea>' +
          '<select id="taskAssign" style="padding:10px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + workerOptions + '</select>' +
          '<select id="taskWorkplace" style="padding:10px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + workplaceOptions + '</select>' +
          '<div>' +
            '<label style="font-size:0.75rem;color:#999;">' + tt('תאריך יעד', 'วันกำหนด', 'تاريخ الاستحقاق') + '</label>' +
            '<input type="date" id="taskDue" style="width:100%;padding:10px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:4px;">' +
            '<button onclick="TaskBoard._saveNewTask()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
            '<button onclick="TaskBoard.showTaskManager()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';

    // Default date to tomorrow
    var tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    document.getElementById('taskDue').value = tomorrow.toISOString().slice(0, 10);
  }

  function _saveNewTask() {
    var title = document.getElementById('taskTitle').value.trim();
    var desc = document.getElementById('taskDesc').value.trim();
    var assignTo = document.getElementById('taskAssign').value;
    var workplace = document.getElementById('taskWorkplace').value;
    var dueDate = document.getElementById('taskDue').value;

    if (!title) {
      if (typeof showToast === 'function') showToast('❌ ' + tt('חובה למלא כותרת', 'ต้องกรอกชื่องาน', 'يجب إدخال العنوان'));
      return;
    }

    createTask({
      title: title,
      description: desc,
      assignedTo: assignTo,
      workplace: workplace,
      dueDate: dueDate
    });

    // Return to task manager
    setTimeout(showTaskManager, 300);
  }

  function _deleteTask(taskId) {
    if (!confirm(tt('למחוק משימה?', 'ลบงาน?', 'حذف المهمة؟'))) return;
    deleteTask(taskId);
    setTimeout(showTaskManager, 300);
  }

  // ── Viewer: Task count badge ──

  function getMyPendingCount(callback) {
    var username = window.currentUser ? window.currentUser.username : '';
    loadTasks().then(function(tasks) {
      var count = tasks.filter(function(t) { return t.assignedTo === username && t.status === 'pending'; }).length;
      callback(count);
    });
  }

  // ── Public API ──
  return {
    showMyTasks: showMyTasks,
    showTaskManager: showTaskManager,
    showNewTaskForm: showNewTaskForm,
    markDone: markDone,
    getMyPendingCount: getMyPendingCount,
    _saveNewTask: _saveNewTask,
    _deleteTask: _deleteTask
  };
})();
