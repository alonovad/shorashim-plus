// ── MAINTENANCE MODULE (תחזוקה) ──
// Admin-only: project costing, materials management, shipment logging, PDF quotes
// Extended: internal estimates, contracts, invoices/expenses, access control

var Maintenance = (function() {
  'use strict';

  var UNITS = ["יח'", "מ'", 'מ"ר', 'מ"ק', 'ק"ג', 'טון', 'ליטר', 'שק', 'אריזה', 'קרטון', 'משטח', 'צינור', 'גליל'];
  var STATUSES = [
    { value: 'draft', label: null, color: '#999' },
    { value: 'sent', label: null, color: '#1565c0' },
    { value: 'approved', label: null, color: '#2e7d32' },
    { value: 'in_progress', label: null, color: '#ef6c00' },
    { value: 'completed', label: null, color: '#4caf50' },
  ];
  var PAY_TERMS = [
    { value: 'cash', label: null },
    { value: 'net30', label: null },
    { value: 'net60', label: null },
    { value: 'net90', label: null },
  ];
  var CONTRACT_STATUSES = [
    { value: 'pending', label: null, color: '#999' },
    { value: 'signed', label: null, color: '#1565c0' },
    { value: 'active', label: null, color: '#2e7d32' },
    { value: 'completed', label: null, color: '#4caf50' },
    { value: 'cancelled', label: null, color: '#f44336' },
  ];
  var INVOICE_STATUSES = [
    { value: 'pending', label: null, color: '#ef6c00' },
    { value: 'paid', label: null, color: '#4caf50' },
    { value: 'overdue', label: null, color: '#f44336' },
  ];
  var EXPENSE_CATEGORIES = [
    { value: 'materials', label: null, icon: '📦' },
    { value: 'equipment', label: null, icon: '🔧' },
    { value: 'subcontractor', label: null, icon: '👷' },
    { value: 'transport', label: null, icon: '🚛' },
    { value: 'permits', label: null, icon: '📋' },
    { value: 'other', label: null, icon: '📎' },
  ];
  var VAT_RATE = 0.18;

  // Init labels lazily (tt depends on currentLang which may not be set at parse time)
  var _labelsInit = false;
  function ensureLabels() {
    if (_labelsInit) return;
    _labelsInit = true;
    STATUSES[0].label = tt('טיוטה','แบบร่าง','مسودة');
    STATUSES[1].label = tt('נשלח ללקוח','ส่งให้ลูกค้าแล้ว','أُرسل للعميل');
    STATUSES[2].label = tt('מאושר','อนุมัติแล้ว','موافق عليه');
    STATUSES[3].label = tt('בביצוע','กำลังดำเนินการ','قيد التنفيذ');
    STATUSES[4].label = tt('הושלם','เสร็จสมบูรณ์','مكتمل');
    PAY_TERMS[0].label = tt('מזומן','เงินสด','نقدي');
    PAY_TERMS[1].label = tt('שוטף + 30','เครดิต 30 วัน','صافي 30');
    PAY_TERMS[2].label = tt('שוטף + 60','เครดิต 60 วัน','صافي 60');
    PAY_TERMS[3].label = tt('שוטף + 90','เครดิต 90 วัน','صافي 90');
    CONTRACT_STATUSES[0].label = tt('ממתין','รอดำเนินการ','قيد الانتظار');
    CONTRACT_STATUSES[1].label = tt('נחתם','ลงนามแล้ว','موقع');
    CONTRACT_STATUSES[2].label = tt('פעיל','ใช้งานอยู่','نشط');
    CONTRACT_STATUSES[3].label = tt('הושלם','เสร็จสมบูรณ์','مكتمل');
    CONTRACT_STATUSES[4].label = tt('בוטל','ยกเลิก','ملغي');
    INVOICE_STATUSES[0].label = tt('ממתין','รอดำเนินการ','قيد الانتظار');
    INVOICE_STATUSES[1].label = tt('שולם','ชำระแล้ว','مدفوع');
    INVOICE_STATUSES[2].label = tt('באיחור','เกินกำหนด','متأخر');
    EXPENSE_CATEGORIES[0].label = tt('חומרים','วัสดุ','مواد');
    EXPENSE_CATEGORIES[1].label = tt('ציוד','อุปกรณ์','معدات');
    EXPENSE_CATEGORIES[2].label = tt('קבלן משנה','ผู้รับเหมาช่วง','مقاول من الباطن');
    EXPENSE_CATEGORIES[3].label = tt('הובלה','ขนส่ง','نقل');
    EXPENSE_CATEGORIES[4].label = tt('היתרים/אגרות','ใบอนุญาต/ค่าธรรมเนียม','تصاريح/رسوم');
    EXPENSE_CATEGORIES[5].label = tt('אחר','อื่นๆ','أخرى');
  }

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  // ── Data persistence (with Firestore sync) ──

  var _projectsCache = null;
  var _accessCache = null;
  var _syncInitialized = false;
  var _migrationDone = {};

  // DB.load() calls callback twice: first localStorage (fast), then Firestore (slow).
  // DB.loadAsync wraps it in a Promise that resolves on the FIRST callback,
  // so Firestore data is always ignored. This waits for the SECOND callback.
  function _loadFromFirestore(key) {
    return new Promise(function(resolve) {
      if (typeof DB === 'undefined') {
        try { resolve(JSON.parse(localStorage.getItem(key) || '[]')); }
        catch (e) { resolve([]); }
        return;
      }
      var callCount = 0;
      var localData = null;
      var settled = false;
      var timer = setTimeout(function() {
        if (!settled) {
          settled = true;
          console.warn('[Maintenance] Firestore timeout for ' + key + ', using localStorage');
          resolve(localData || []);
        }
      }, 4000);
      DB.load(key, function(data) {
        callCount++;
        if (callCount === 1) {
          localData = data;
        } else {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(data || []);
          }
        }
      });
    });
  }

  // One-time migration: push localStorage data to Firestore if Firestore is empty
  function _migrateIfNeeded(key) {
    if (_migrationDone[key]) return Promise.resolve(null);
    _migrationDone[key] = true;
    return _loadFromFirestore(key).then(function(firestoreData) {
      if (firestoreData && firestoreData.length > 0) {
        console.log('[Maintenance] ' + key + ': Firestore has ' + firestoreData.length + ' items, no migration needed');
        return firestoreData;
      }
      var localData = [];
      try { localData = JSON.parse(localStorage.getItem(key) || '[]'); } catch (e) {}
      if (localData.length > 0 && typeof DB !== 'undefined') {
        console.log('[Maintenance] Migrating ' + key + ' to Firestore (' + localData.length + ' items from localStorage)');
        DB.save(key, localData);
        return localData;
      }
      return firestoreData || [];
    });
  }

  // Realtime listeners — sync cross-device via Firestore onSnapshot
  function _initSync() {
    if (_syncInitialized || typeof DB === 'undefined' || typeof DB.listen !== 'function') return;
    _syncInitialized = true;

    _migrateIfNeeded('shorashim-maintenance').then(function(data) {
      _projectsCache = data || [];
      DB.listen('shorashim-maintenance', function(freshData) {
        var newData = freshData || [];
        if (JSON.stringify(newData) !== JSON.stringify(_projectsCache)) {
          console.log('[Maintenance] Realtime update: shorashim-maintenance (' + newData.length + ' projects)');
          _projectsCache = newData;
          _onProjectsChanged();
        } else {
          _projectsCache = newData;
        }
      });
    });

    _migrateIfNeeded('shorashim-maintenance-access').then(function(data) {
      _accessCache = data || {};
      DB.listen('shorashim-maintenance-access', function(freshData) {
        var newData = freshData || {};
        if (JSON.stringify(newData) !== JSON.stringify(_accessCache)) {
          console.log('[Maintenance] Realtime update: shorashim-maintenance-access');
          _accessCache = newData;
        } else {
          _accessCache = newData;
        }
      });
    });
  }

  // Re-render when data changes from another device
  function _onProjectsChanged() {
    var modal = document.getElementById('modalContainer');
    if (!modal || !modal.innerHTML) return;
    if (modal.querySelector('[data-maint-view="list"]')) {
      showProjectsList();
    }
    var detailEl = modal.querySelector('[data-maint-project-id]');
    if (detailEl) {
      var pid = parseInt(detailEl.getAttribute('data-maint-project-id'));
      var activeTabAttr = detailEl.getAttribute('data-maint-active-tab') || 'materials';
      if (pid) showDetail(pid, activeTabAttr);
    }
  }

  function saveProjects(projects) {
    _projectsCache = projects;
    if (typeof DB !== 'undefined') DB.save('shorashim-maintenance', projects);
    else localStorage.setItem('shorashim-maintenance', JSON.stringify(projects));
  }
  function loadProjects() {
    if (_projectsCache !== null) return Promise.resolve(_projectsCache);
    return _migrateIfNeeded('shorashim-maintenance').then(function(data) {
      _projectsCache = data || [];
      return _projectsCache;
    });
  }
  function saveAccess(access) {
    _accessCache = access;
    if (typeof DB !== 'undefined') DB.save('shorashim-maintenance-access', access);
    else localStorage.setItem('shorashim-maintenance-access', JSON.stringify(access));
  }
  function loadAccess() {
    if (_accessCache !== null) return Promise.resolve(_accessCache);
    return _migrateIfNeeded('shorashim-maintenance-access').then(function(data) {
      _accessCache = data || {};
      return _accessCache;
    });
  }

  // ── Permissions ──
  var PERMS = ['view', 'edit', 'approve_quotes', 'see_internal', 'manage_contracts', 'manage_invoices'];
  var PERM_LABELS = {};

  function ensurePermLabels() {
    if (PERM_LABELS.view) return;
    PERM_LABELS.view = tt('צפייה','ดู','عرض');
    PERM_LABELS.edit = tt('עריכה','แก้ไข','تعديل');
    PERM_LABELS.approve_quotes = tt('אישור הצעות','อนุมัติใบเสนอราคา','الموافقة على العروض');
    PERM_LABELS.see_internal = tt('עלויות פנימיות','ต้นทุนภายใน','التكاليف الداخلية');
    PERM_LABELS.manage_contracts = tt('ניהול חוזים','จัดการสัญญา','إدارة العقود');
    PERM_LABELS.manage_invoices = tt('ניהול חשבוניות','จัดการใบแจ้งหนี้','إدارة الفواتير');
  }

  function isAdmin() { return window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'manager'); }
  function getUserEmail() { return window.currentUser && (window.currentUser.email || ''); }

  function hasPerm(perm, accessData) {
    if (isAdmin()) return true;
    var email = getUserEmail();
    if (!email || !accessData || !accessData[email]) return false;
    return !!accessData[email][perm];
  }

  function fmt(n) { return n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  // ── Cost calculations ──
  function calcProject(p) {
    var mt = 0; (p.materials || []).forEach(function(m) { mt += (m.quantity || 0) * (m.unitPrice || 0); });
    var lt = 0; (p.labor || []).forEach(function(l) { lt += (l.hours || 0) * (l.hourlyRate || 0); });
    var sub = mt + lt, mkp = sub * ((p.markup || 0) / 100), bv = sub + mkp;
    var vat = p.includeVat ? bv * VAT_RATE : 0;
    return { materialsTotal: mt, laborTotal: lt, subtotal: sub, markup: mkp, beforeVat: bv, vat: vat, total: bv + vat };
  }

  function calcInternal(p) {
    var mt = 0; (p.materials || []).forEach(function(m) { mt += (m.quantity || 0) * (m.costPrice || m.unitPrice || 0); });
    var lt = 0; (p.labor || []).forEach(function(l) { lt += (l.hours || 0) * (l.costRate || l.hourlyRate || 0); });
    var totalReal = mt + lt;
    var client = calcProject(p);
    var profit = client.beforeVat - totalReal;
    var margin = client.beforeVat > 0 ? (profit / client.beforeVat * 100) : 0;
    return { materialsCost: mt, laborCost: lt, totalCost: totalReal, clientBeforeVat: client.beforeVat, profit: profit, margin: margin };
  }

  function calcInvoiceTotals(p) {
    var totalExpenses = 0, totalPaid = 0, totalPending = 0, totalOverdue = 0;
    var byCategory = {};
    var today = new Date().toISOString().slice(0, 10);
    (p.invoices || []).forEach(function(inv) {
      // Auto-detect overdue
      if (inv.status === 'pending' && inv.dueDate && inv.dueDate < today) {
        inv.status = 'overdue';
      }
      var a = (inv.amount || 0) + (inv.vatAmount || 0);
      totalExpenses += a;
      if (inv.status === 'paid') totalPaid += a;
      else if (inv.status === 'overdue') totalOverdue += a;
      else totalPending += a;
      var cat = inv.category || 'other';
      byCategory[cat] = (byCategory[cat] || 0) + a;
    });
    return { total: totalExpenses, paid: totalPaid, pending: totalPending, overdue: totalOverdue, byCategory: byCategory };
  }

  // ── UI helpers ──
  var inputS = 'width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--border, #ddd);font-family:inherit;color:var(--text, inherit);background:var(--surface-input, transparent);';
  var lblS = 'font-size:0.8rem;color:var(--text-muted, #666);';
  var modalBg = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
  var modalCard = 'background:var(--card-solid, white);border-radius:16px;padding:20px;width:92%;max-width:';
  var btnSave = 'flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;';
  var btnCancel = 'flex:1;padding:10px;border-radius:10px;border:none;background:var(--surface-glass, #eee);color:var(--text, inherit);font-family:inherit;cursor:pointer;';

  var sectTitle = function(icon, text) { return '<div style="font-size:0.75rem;font-weight:700;color:var(--primary, #1b5e20);text-transform:uppercase;letter-spacing:1px;">' + icon + ' ' + text + '</div>'; };
  var addBtn = function(label, fn, pid) { return '<button onclick="Maintenance.' + fn + '(' + pid + ')" style="font-size:0.75rem;padding:4px 10px;border-radius:6px;border:1px solid var(--primary, #4caf50);background:transparent;color:var(--primary, #4caf50);font-family:inherit;font-weight:600;cursor:pointer;">➕ ' + label + '</button>'; };
  var thS = 'padding:8px;text-align:center;font-weight:700;font-size:0.78rem;';
  var tblWrap = function(head, body, footLabel, footVal, color) {
    return '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;"><thead><tr style="background:' + color + '22;">' + head + '</tr></thead><tbody>' + body + '</tbody><tfoot><tr style="border-top:2px solid ' + color + ';"><td colspan="3" style="padding:8px;font-weight:700;text-align:left;">' + footLabel + '</td><td style="padding:8px;text-align:center;font-weight:700;color:' + color + ';">₪' + footVal + '</td><td></td></tr></tfoot></table></div>';
  };

  var _activeTab = 'overview'; // overview | internal | contract | invoices

  // ══════════════════════════════════════
  //  PROJECTS LIST
  // ══════════════════════════════════════
  function showProjectsList() {
    ensureLabels();
    loadAccess().then(function(access) {
      if (!isAdmin() && !hasPerm('view', access)) { if (typeof showToast === 'function') showToast(tt('⛔ אין הרשאה','⛔ ไม่มีสิทธิ์','⛔ لا إذن')); return; }
      var modal = document.getElementById('modalContainer');
      var topBtns = '<button onclick="Maintenance.showNewProject()" style="padding:6px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕ ' + tt('חדש','ใหม่','جديد') + '</button>';
      topBtns += ' <button onclick="Maintenance.showDashboard()" style="padding:6px 14px;border-radius:8px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📊 ' + tt('דשבורד','แดชบอร์ด','لوحة التحكم') + '</button>';
      if (isAdmin()) topBtns += ' <button onclick="Maintenance.showAccessControl()" style="padding:6px 14px;border-radius:8px;border:none;background:#546e7a;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🔐 ' + tt('הרשאות','สิทธิ์','أذونات') + '</button>';

      // Status filter options
      var filterOpts = '<option value="all">' + tt('הכל','ทั้งหมด','الكل') + '</option>';
      STATUSES.forEach(function(s) { filterOpts += '<option value="' + s.value + '">' + s.label + '</option>'; });

      modal.innerHTML = '<div style="' + modalBg + '"><div data-maint-view="list" style="' + modalCard + '600px;max-height:85vh;overflow-y:auto;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px;">' +
          '<h3 style="font-weight:700;margin:0;">🔧 ' + tt('תחזוקה — פרויקטים','ซ่อมบำรุง — โครงการ','صيانة — مشاريع') + '</h3>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + topBtns + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:12px;">' +
          '<input id="maintSearch" type="text" placeholder="🔍 ' + tt('חיפוש...','ค้นหา...','بحث...') + '" oninput="Maintenance._filterList()" style="flex:1;padding:8px 12px;border-radius:8px;border:1px solid var(--border, #ddd);font-family:inherit;font-size:0.85rem;color:var(--text, inherit);background:var(--surface-input, transparent);">' +
          '<select id="maintFilter" onchange="Maintenance._filterList()" style="padding:8px 10px;border-radius:8px;border:1px solid var(--border, #ddd);font-family:inherit;font-size:0.82rem;color:var(--text, inherit);background:var(--surface-input, transparent);">' + filterOpts + '</select>' +
        '</div>' +
        '<div id="maintList" style="color:var(--text-muted, #999);text-align:center;padding:16px;">...</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:var(--surface-glass, #eee);color:var(--text, inherit);font-family:inherit;cursor:pointer;">' + tt('סגור','ปิด','إغلاق') + '</button>' +
      '</div></div>';
      _renderProjectList();
    });
  }

  // Cached projects for filtering
  var _cachedProjects = [];
  function _renderProjectList() {
    loadProjects().then(function(projects) {
      _cachedProjects = projects;
      _filterList();
    });
  }

  function _filterList() {
    var el = document.getElementById('maintList'); if (!el) return;
    var search = (document.getElementById('maintSearch') || {}).value || '';
    search = search.toLowerCase().trim();
    var filter = (document.getElementById('maintFilter') || {}).value || 'all';
    var projects = _cachedProjects.slice();

    if (filter !== 'all') projects = projects.filter(function(p) { return p.status === filter; });
    if (search) projects = projects.filter(function(p) {
      return (p.name || '').toLowerCase().includes(search) || (p.client || '').toLowerCase().includes(search) || (p.description || '').toLowerCase().includes(search);
    });

    projects.sort(function(a, b) { return (b.updated || b.created || 0) - (a.updated || a.created || 0); });

    if (!projects.length) {
      el.innerHTML = '<div style="padding:24px;text-align:center;color:var(--text-muted, #999);">🔧 ' + (search || filter !== 'all' ? tt('לא נמצאו תוצאות','ไม่พบผลลัพธ์','لا نتائج') : tt('אין פרויקטים — לחץ ➕','ไม่มีโครงการ — กด ➕','لا مشاريع — اضغط ➕')) + '</div>';
      return;
    }

    var h = '';
    projects.forEach(function(p) {
      var st = STATUSES.find(function(s) { return s.value === p.status; }) || STATUSES[0];
      var tot = calcProject(p);
      var invTot = calcInvoiceTotals(p);
      h += '<div onclick="Maintenance.showDetail(' + p.id + ')" style="background:var(--surface-glass, #f5f7f5);border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;border-right:4px solid ' + st.color + ';">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-weight:700;">' + p.name + '</div>';
      h += '<span style="font-size:0.72rem;padding:3px 8px;border-radius:6px;background:' + st.color + '22;color:' + st.color + ';font-weight:600;">' + st.label + '</span></div>';
      if (p.client) h += '<div style="font-size:0.8rem;color:var(--text-muted, #666);margin-top:2px;">👤 ' + p.client + '</div>';
      h += '<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.78rem;color:var(--text-muted, #999);">';
      h += '<span>📦 ' + (p.materials || []).length + ' ' + tt('חומרים','วัสดุ','مواد');
      if (p.contract && p.contract.status === 'active') h += ' · 📋 ' + tt('חוזה פעיל','สัญญาใช้งานอยู่','عقد نشط');
      if (invTot.overdue > 0) h += ' · <span style="color:#f44336;">⚠️₪' + fmt(invTot.overdue) + '</span>';
      else if (invTot.pending > 0) h += ' · ⏳₪' + fmt(invTot.pending);
      h += '</span><span style="font-weight:700;color:var(--primary, #1b5e20);">₪' + fmt(tot.total) + '</span></div></div>';
    });
    el.innerHTML = h;
  }

  // ══════════════════════════════════════
  //  NEW/EDIT PROJECT
  // ══════════════════════════════════════
  function showNewProject(existingId) {
    ensureLabels();
    loadProjects().then(function(projects) {
      var p = existingId ? projects.find(function(x) { return x.id === existingId; }) : null;
      if (!p) p = { name: '', client: '', description: '', status: 'draft', markup: 15, includeVat: true };
      var sOpts = ''; STATUSES.forEach(function(s) { sOpts += '<option value="' + s.value + '"' + (p.status === s.value ? ' selected' : '') + '>' + s.label + '</option>'; });
      var modal = document.getElementById('modalContainer');
      modal.innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '450px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:14px;">🔧 ' + (existingId ? tt('עריכת פרויקט','แก้ไขโครงการ','تعديل المشروع') : tt('פרויקט חדש','โครงการใหม่','مشروع جديد')) + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">' + tt('שם הפרויקט','ชื่อโครงการ','اسم المشروع') + ' *</label><input id="mpName" value="' + (p.name || '') + '" placeholder="' + tt('למשל: תחזוקת משרד','เช่น: ซ่อมบำรุงสำนักงาน','مثال: صيانة مكتب') + '" style="' + inputS + '"></div>' +
        '<div><label style="' + lblS + '">' + tt('לקוח','ลูกค้า','عميل') + '</label><input id="mpClient" value="' + (p.client || '') + '" style="' + inputS + '"></div>' +
        '<div><label style="' + lblS + '">' + tt('תיאור','รายละเอียด','وصف') + '</label><textarea id="mpDesc" rows="2" style="' + inputS + 'resize:vertical;">' + (p.description || '') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('סטטוס','สถานะ','الحالة') + '</label><select id="mpStatus" style="' + inputS + '">' + sOpts + '</select></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('תוספת %','เพิ่ม %','زيادة %') + '</label><input id="mpMarkup" type="number" value="' + (p.markup || 0) + '" min="0" max="100" style="' + inputS + '"></div></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:0.88rem;cursor:pointer;"><input type="checkbox" id="mpVat"' + (p.includeVat !== false ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#2e7d32;"> ' + tt('כולל מע"מ (18%)','รวม VAT (18%)','شامل ضريبة (18%)') + '</label>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveProject(' + (existingId || 0) + ')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="' + (existingId ? 'Maintenance.showDetail(' + existingId + ')' : 'Maintenance.showProjectsList()') + '" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div>' +
        '</div></div></div>';
    });
  }

  function _saveProject(eid) {
    var name = document.getElementById('mpName').value.trim();
    if (!name) { if (typeof showToast === 'function') showToast(tt('❌ חובה למלא שם','❌ ต้องกรอกชื่อ','❌ يجب إدخال الاسم')); return; }
    loadProjects().then(function(projects) {
      var p = eid ? projects.find(function(x) { return x.id === eid; }) : null;
      if (!p) { p = { id: Date.now(), materials: [], labor: [], shipments: [], invoices: [], contract: null, created: Date.now() }; projects.push(p); }
      p.name = name; p.client = document.getElementById('mpClient').value.trim();
      p.description = document.getElementById('mpDesc').value.trim(); p.status = document.getElementById('mpStatus').value;
      p.markup = parseFloat(document.getElementById('mpMarkup').value) || 0; p.includeVat = document.getElementById('mpVat').checked;
      p.updated = Date.now(); saveProjects(projects);
      if (typeof showToast === 'function') showToast(tt('✅ נשמר','✅ บันทึกแล้ว','✅ تم الحفظ')); showDetail(p.id);
    });
  }

  // ══════════════════════════════════════
  //  PROJECT DETAIL (tabbed)
  // ══════════════════════════════════════
  function showDetail(pid, tab) {
    ensureLabels();
    if (tab) _activeTab = tab;
    loadProjects().then(function(projects) {
      loadAccess().then(function(access) {
        var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
        var tot = calcProject(p);
        var st = STATUSES.find(function(s) { return s.value === p.status; }) || STATUSES[0];
        var canEdit = hasPerm('edit', access);
        var canInternal = hasPerm('see_internal', access);
        var canContract = hasPerm('manage_contracts', access);
        var canInvoice = hasPerm('manage_invoices', access);

        // ── Tab bar ──
        var tabs = [
          { id: 'overview', icon: '📋', label: tt('סקירה','ภาพรวม','نظرة عامة') },
        ];
        if (canInternal) tabs.push({ id: 'internal', icon: '🔒', label: tt('אומדן פנימי','ประมาณการภายใน','تقدير داخلي') });
        if (canContract) tabs.push({ id: 'contract', icon: '📋', label: tt('חוזה','สัญญา','عقد') });
        if (canInvoice) tabs.push({ id: 'invoices', icon: '🧾', label: tt('חשבוניות','ใบแจ้งหนี้','فواتير') });

        if (!tabs.find(function(t) { return t.id === _activeTab; })) _activeTab = 'overview';

        var tabH = '<div style="display:flex;gap:4px;margin-bottom:14px;overflow-x:auto;padding-bottom:4px;">';
        tabs.forEach(function(t) {
          var active = t.id === _activeTab;
          tabH += '<button onclick="Maintenance.showDetail(' + pid + ',\'' + t.id + '\')" style="padding:6px 12px;border-radius:8px;border:' + (active ? '2px solid var(--primary, #2e7d32)' : '1px solid var(--border, #ddd)') + ';background:' + (active ? 'var(--primary-faded, #e8f5e9)' : 'var(--card-solid, white)') + ';font-family:inherit;font-weight:' + (active ? '700' : '400') + ';font-size:0.78rem;cursor:pointer;white-space:nowrap;color:' + (active ? 'var(--primary, #1b5e20)' : 'var(--text-muted, #666)') + ';">' + t.icon + ' ' + t.label + '</button>';
        });
        tabH += '</div>';

        // ── Header ──
        var headerH = '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;gap:8px;"><div style="flex:1;min-width:0;">' +
          '<h3 style="font-weight:700;margin:0 0 4px;">🔧 ' + p.name + '</h3>' +
          (p.client ? '<div style="font-size:0.82rem;color:var(--text-muted, #666);">👤 ' + p.client + '</div>' : '') +
          (p.description ? '<div style="font-size:0.78rem;color:var(--text-muted, #999);margin-top:2px;">' + p.description + '</div>' : '') +
        '</div><div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0;">' +
          '<button onclick="Maintenance.showProjectsList()" title="' + tt('סגור','ปิด','إغلاق') + '" style="background:none;border:none;font-size:1.3rem;cursor:pointer;color:var(--text-muted, #888);padding:2px 6px;line-height:1;border-radius:6px;">✕</button>' +
          '<span style="font-size:0.72rem;padding:4px 10px;border-radius:6px;background:' + st.color + '22;color:' + st.color + ';font-weight:600;white-space:nowrap;">' + st.label + '</span>' +
        '</div></div>';

        var bodyH = '';

        // ──────────────────────
        //  TAB: OVERVIEW
        // ──────────────────────
        if (_activeTab === 'overview') {
          // Materials
          var matH = ''; (p.materials || []).forEach(function(m, i) {
            var lt = (m.quantity || 0) * (m.unitPrice || 0);
            matH += '<tr><td style="padding:6px 8px;font-weight:600;">' + m.name + '</td><td style="padding:6px 8px;text-align:center;">' + m.quantity + ' ' + (m.unit || '') + '</td><td style="padding:6px 8px;text-align:center;">₪' + fmt(m.unitPrice) + '</td><td style="padding:6px 8px;text-align:center;font-weight:700;">₪' + fmt(lt) + '</td><td style="padding:6px 4px;text-align:center;">' + (canEdit ? '<button onclick="Maintenance._editMat(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">✏️</button><button onclick="Maintenance._delMat(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">🗑️</button>' : '') + '</td></tr>';
          });
          var labH = ''; (p.labor || []).forEach(function(l, i) {
            var lt = (l.hours || 0) * (l.hourlyRate || 0);
            labH += '<tr><td style="padding:6px 8px;font-weight:600;">' + l.description + '</td><td style="padding:6px 8px;text-align:center;">' + l.hours + '</td><td style="padding:6px 8px;text-align:center;">₪' + fmt(l.hourlyRate) + '</td><td style="padding:6px 8px;text-align:center;font-weight:700;">₪' + fmt(lt) + '</td><td style="padding:6px 4px;text-align:center;">' + (canEdit ? '<button onclick="Maintenance._editLab(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">✏️</button><button onclick="Maintenance._delLab(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">🗑️</button>' : '') + '</td></tr>';
          });
          var shipH = ''; (p.shipments || []).forEach(function(s, i) {
            shipH += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:0.82rem;display:flex;justify-content:space-between;align-items:center;"><div><strong>' + s.date + '</strong> — ' + s.materialName + ' (' + s.quantity + ')' + (s.supplier ? ' · ' + s.supplier : '') + (s.notes ? ' · <span style="color:var(--text-muted, #999);">' + s.notes + '</span>' : '') + '</div>' + (canEdit ? '<button onclick="Maintenance._delShip(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">🗑️</button>' : '') + '</div>';
          });

          bodyH += '<div style="margin-bottom:18px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('📦', tt('חומרים','วัสดุ','مواد')) + (canEdit ? addBtn(tt('הוסף','เพิ่ม','إضافة'), '_addMat', pid) : '') + '</div>' +
          (!(p.materials || []).length ? '<div style="text-align:center;color:var(--text-muted, #999);padding:12px;">' + tt('אין חומרים','ไม่มีวัสดุ','لا مواد') + '</div>' :
            tblWrap('<th style="' + thS + 'text-align:right;">' + tt('חומר','วัสดุ','مادة') + '</th><th style="' + thS + '">' + tt('כמות','จำนวน','كمية') + '</th><th style="' + thS + '">' + tt('מחיר ליח\'','ราคา/หน่วย','سعر الوحدة') + '</th><th style="' + thS + '">' + tt('סה"כ','รวม','المجموع') + '</th><th style="' + thS + 'width:60px;"></th>',
              matH, tt('סה"כ חומרים','รวมวัสดุ','إجمالي المواد'), fmt(tot.materialsTotal), '#2e7d32')) + '</div>';

          bodyH += '<div style="margin-bottom:18px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('👷', tt('עבודה','แรงงาน','عمالة')) + (canEdit ? addBtn(tt('הוסף','เพิ่ม','إضافة'), '_addLab', pid) : '') + '</div>' +
          (!(p.labor || []).length ? '<div style="text-align:center;color:var(--text-muted, #999);padding:8px;">' + tt('אין פריטי עבודה','ไม่มีรายการงาน','لا عناصر عمل') + '</div>' :
            tblWrap('<th style="' + thS + 'text-align:right;">' + tt('תיאור','รายละเอียด','وصف') + '</th><th style="' + thS + '">' + tt('שעות','ชั่วโมง','ساعات') + '</th><th style="' + thS + '">₪/' + tt('שעה','ชม.','ساعة') + '</th><th style="' + thS + '">' + tt('סה"כ','รวม','المجموع') + '</th><th style="' + thS + 'width:60px;"></th>',
              labH, tt('סה"כ עבודה','รวมแรงงาน','إجمالي العمالة'), fmt(tot.laborTotal), '#ef6c00')) + '</div>';

          // Cost summary
          bodyH += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:12px;padding:14px;margin-bottom:18px;">' + sectTitle('💰', tt('סיכום עלויות','สรุปต้นทุน','ملخص التكاليف')) +
          '<div style="display:grid;gap:4px;font-size:0.88rem;margin-top:8px;">' +
            '<div style="display:flex;justify-content:space-between;"><span>' + tt('חומרים','วัสดุ','مواد') + '</span><span>₪' + fmt(tot.materialsTotal) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span>' + tt('עבודה','แรงงาน','عمالة') + '</span><span>₪' + fmt(tot.laborTotal) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;border-top:1px solid var(--border, #ddd);padding-top:4px;"><span>' + tt('סכום ביניים','ยอดรวมย่อย','المجموع الفرعي') + '</span><span>₪' + fmt(tot.subtotal) + '</span></div>' +
            (p.markup ? '<div style="display:flex;justify-content:space-between;"><span>' + tt('תוספת','เพิ่ม','زيادة') + ' ' + p.markup + '%</span><span>₪' + fmt(tot.markup) + '</span></div>' : '') +
            '<div style="display:flex;justify-content:space-between;"><span>' + tt('לפני מע"מ','ก่อน VAT','قبل الضريبة') + '</span><span style="font-weight:600;">₪' + fmt(tot.beforeVat) + '</span></div>' +
            (p.includeVat ? '<div style="display:flex;justify-content:space-between;"><span>' + tt('מע"מ 18%','VAT 18%','ضريبة 18%') + '</span><span>₪' + fmt(tot.vat) + '</span></div>' : '') +
            '<div style="display:flex;justify-content:space-between;font-size:1.1rem;font-weight:800;color:var(--primary, #1b5e20);border-top:2px solid #2e7d32;padding-top:6px;margin-top:4px;"><span>' + tt('סה"כ','รวมทั้งหมด','المجموع') + '</span><span>₪' + fmt(tot.total) + '</span></div>' +
          '</div></div>';

          // Shipments
          bodyH += '<div style="margin-bottom:18px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('🚚', tt('יומן משלוחים','บันทึกการจัดส่ง','سجل الشحنات')) + (canEdit ? addBtn(tt('הוסף','เพิ่ม','إضافة'), '_addShip', pid) : '') + '</div>' +
          (!(p.shipments || []).length ? '<div style="text-align:center;color:var(--text-muted, #999);padding:8px;">' + tt('אין משלוחים','ไม่มีจัดส่ง','لا شحنات') + '</div>' : shipH) + '</div>';

          // Action buttons
          bodyH += '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
            '<button onclick="Maintenance._quotePDF(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;font-size:0.85rem;">📄 ' + tt('הצעת מחיר','ใบเสนอราคา','عرض سعر') + '</button>' +
            '<button onclick="Maintenance._shipPDF(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#7e57c2;color:white;font-family:inherit;font-weight:700;cursor:pointer;font-size:0.85rem;">🚚 ' + tt('יומן משלוחים','บันทึกจัดส่ง','سجل الشحنات') + '</button>' +
            (canEdit ? '<button onclick="Maintenance.showNewProject(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#ff9800;color:white;font-family:inherit;font-weight:700;cursor:pointer;font-size:0.85rem;">✏️ ' + tt('עריכה','แก้ไข','تعديل') + '</button>' : '') +
          '</div>';
        }

        // ──────────────────────
        //  TAB: INTERNAL COSTS
        // ──────────────────────
        else if (_activeTab === 'internal') {
          var ic = calcInternal(p);
          var profitColor = ic.profit >= 0 ? '#2e7d32' : '#f44336';

          // Materials with real cost column
          var icMatH = ''; (p.materials || []).forEach(function(m, i) {
            var clientLine = (m.quantity || 0) * (m.unitPrice || 0);
            var realLine = (m.quantity || 0) * (m.costPrice || m.unitPrice || 0);
            icMatH += '<tr><td style="padding:6px 8px;font-weight:600;">' + m.name + '</td><td style="padding:6px 8px;text-align:center;">' + m.quantity + '</td>' +
              '<td style="padding:6px 8px;text-align:center;color:var(--text-muted, #999);">₪' + fmt(m.unitPrice) + '</td>' +
              '<td style="padding:6px 8px;text-align:center;"><input type="number" value="' + (m.costPrice || m.unitPrice || 0) + '" min="0" step="0.01" onchange="Maintenance._updateCostPrice(' + pid + ',' + i + ',this.value)" style="width:80px;padding:4px;border-radius:6px;border:1px solid var(--border, #ddd);text-align:center;font-family:inherit;color:var(--text, inherit);background:var(--surface-input, transparent);"></td>' +
              '<td style="padding:6px 8px;text-align:center;font-weight:700;">₪' + fmt(realLine) + '</td></tr>';
          });
          // Labor with real cost column
          var icLabH = ''; (p.labor || []).forEach(function(l, i) {
            var realLine = (l.hours || 0) * (l.costRate || l.hourlyRate || 0);
            icLabH += '<tr><td style="padding:6px 8px;font-weight:600;">' + l.description + '</td><td style="padding:6px 8px;text-align:center;">' + l.hours + '</td>' +
              '<td style="padding:6px 8px;text-align:center;color:var(--text-muted, #999);">₪' + fmt(l.hourlyRate) + '</td>' +
              '<td style="padding:6px 8px;text-align:center;"><input type="number" value="' + (l.costRate || l.hourlyRate || 0) + '" min="0" step="1" onchange="Maintenance._updateCostRate(' + pid + ',' + i + ',this.value)" style="width:80px;padding:4px;border-radius:6px;border:1px solid var(--border, #ddd);text-align:center;font-family:inherit;color:var(--text, inherit);background:var(--surface-input, transparent);"></td>' +
              '<td style="padding:6px 8px;text-align:center;font-weight:700;">₪' + fmt(realLine) + '</td></tr>';
          });

          bodyH += '<div style="background:#fff3e0;border-radius:10px;padding:10px;margin-bottom:14px;font-size:0.82rem;color:#e65100;">🔒 ' + tt('נתונים פנימיים בלבד — לא מופיע בהצעת מחיר ללקוח','ข้อมูลภายในเท่านั้น — ไม่แสดงในใบเสนอราคาลูกค้า','بيانات داخلية فقط — لا تظهر في عرض السعر للعميل') + '</div>';

          if ((p.materials || []).length) {
            bodyH += '<div style="margin-bottom:14px;">' + sectTitle('📦', tt('עלות חומרים אמיתית','ต้นทุนวัสดุจริง','التكلفة الحقيقية للمواد')) +
            '<div style="overflow-x:auto;margin-top:8px;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;"><thead><tr style="background:#fff3e022;"><th style="' + thS + 'text-align:right;">' + tt('חומר','วัสดุ','مادة') + '</th><th style="' + thS + '">' + tt('כמות','จำนวน','كمية') + '</th><th style="' + thS + '">' + tt('מחיר ללקוח','ราคาลูกค้า','سعر العميل') + '</th><th style="' + thS + '">' + tt('עלות אמיתית','ต้นทุนจริง','التكلفة الحقيقية') + '</th><th style="' + thS + '">' + tt('סה"כ עלות','รวมต้นทุน','إجمالي التكلفة') + '</th></tr></thead><tbody>' + icMatH + '</tbody></table></div></div>';
          }
          if ((p.labor || []).length) {
            bodyH += '<div style="margin-bottom:14px;">' + sectTitle('👷', tt('עלות עבודה אמיתית','ต้นทุนแรงงานจริง','التكلفة الحقيقية للعمالة')) +
            '<div style="overflow-x:auto;margin-top:8px;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;"><thead><tr style="background:#fff3e022;"><th style="' + thS + 'text-align:right;">' + tt('תיאור','รายละเอียด','وصف') + '</th><th style="' + thS + '">' + tt('שעות','ชั่วโมง','ساعات') + '</th><th style="' + thS + '">₪/' + tt('שעה ללקוח','ชม.ลูกค้า','ساعة للعميل') + '</th><th style="' + thS + '">₪/' + tt('שעה אמיתי','ชม.จริง','ساعة حقيقية') + '</th><th style="' + thS + '">' + tt('סה"כ עלות','รวมต้นทุน','إجمالي التكلفة') + '</th></tr></thead><tbody>' + icLabH + '</tbody></table></div></div>';
          }

          // Profit summary
          bodyH += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:12px;padding:14px;margin-bottom:14px;">' + sectTitle('📊', tt('ניתוח רווחיות','วิเคราะห์กำไร','تحليل الربحية')) +
          '<div style="display:grid;gap:4px;font-size:0.88rem;margin-top:8px;">' +
            '<div style="display:flex;justify-content:space-between;"><span>' + tt('עלות חומרים','ต้นทุนวัสดุ','تكلفة المواد') + '</span><span>₪' + fmt(ic.materialsCost) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span>' + tt('עלות עבודה','ต้นทุนแรงงาน','تكلفة العمالة') + '</span><span>₪' + fmt(ic.laborCost) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;border-top:1px solid var(--border, #ddd);padding-top:4px;font-weight:600;"><span>' + tt('סה"כ עלות אמיתית','รวมต้นทุนจริง','إجمالي التكلفة الحقيقية') + '</span><span>₪' + fmt(ic.totalCost) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;"><span>' + tt('הצעה ללקוח (לפני מע"מ)','ใบเสนอราคา (ก่อน VAT)','عرض السعر (قبل الضريبة)') + '</span><span>₪' + fmt(ic.clientBeforeVat) + '</span></div>' +
            '<div style="display:flex;justify-content:space-between;font-size:1.1rem;font-weight:800;color:' + profitColor + ';border-top:2px solid ' + profitColor + ';padding-top:6px;margin-top:4px;"><span>' + tt('רווח','กำไร','ربح') + ' (' + ic.margin.toFixed(1) + '%)</span><span>₪' + fmt(ic.profit) + '</span></div>' +
          '</div></div>';

          bodyH += '<div style="text-align:center;"><button onclick="Maintenance._internalPDF(' + pid + ')" style="padding:10px 20px;border-radius:10px;border:none;background:#e65100;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📊 ' + tt('הורד דו"ח פנימי','ดาวน์โหลดรายงานภายใน','تنزيل التقرير الداخلي') + '</button></div>';
        }

        // ──────────────────────
        //  TAB: CONTRACT
        // ──────────────────────
        else if (_activeTab === 'contract') {
          var c = p.contract || {};
          if (!p.contract) {
            bodyH += '<div style="text-align:center;padding:24px;color:var(--text-muted, #999);">' + tt('לא מוגדר חוזה','ยังไม่มีสัญญา','لا يوجد عقد') + '<br><br>' +
              '<button onclick="Maintenance._editContract(' + pid + ')" style="padding:10px 20px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📋 ' + tt('הגדר חוזה','กำหนดสัญญา','تعريف العقد') + '</button></div>';
          } else {
            var cs = CONTRACT_STATUSES.find(function(s) { return s.value === c.status; }) || CONTRACT_STATUSES[0];
            var pt = PAY_TERMS.find(function(t) { return t.value === c.paymentTerms; }) || PAY_TERMS[0];
            bodyH += '<div style="background:#e3f2fd;border-radius:12px;padding:16px;margin-bottom:14px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' + sectTitle('📋', tt('פרטי חוזה','รายละเอียดสัญญา','تفاصيل العقد')) +
              '<span style="font-size:0.72rem;padding:3px 8px;border-radius:6px;background:' + cs.color + '22;color:' + cs.color + ';font-weight:600;">' + cs.label + '</span></div>' +
              '<div style="display:grid;gap:6px;font-size:0.88rem;">' +
                (c.contractNumber ? '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted, #666);">' + tt('מס\' חוזה','เลขที่สัญญา','رقم العقد') + '</span><span style="font-weight:600;">' + c.contractNumber + '</span></div>' : '') +
                (c.clientName ? '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted, #666);">' + tt('לקוח','ลูกค้า','عميل') + '</span><span style="font-weight:600;">' + c.clientName + '</span></div>' : '') +
                (c.signedDate ? '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted, #666);">' + tt('תאריך חתימה','วันที่ลงนาม','تاريخ التوقيع') + '</span><span>' + c.signedDate + '</span></div>' : '') +
                '<div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted, #666);">' + tt('תנאי תשלום','เงื่อนไขการชำระ','شروط الدفع') + '</span><span>' + pt.label + '</span></div>' +
                (c.totalValue ? '<div style="display:flex;justify-content:space-between;font-weight:700;font-size:1rem;border-top:1px solid var(--border, #90caf9);padding-top:6px;"><span>' + tt('ערך חוזה','มูลค่าสัญญา','قيمة العقد') + '</span><span style="color:#1565c0;">₪' + fmt(c.totalValue) + '</span></div>' : '') +
                (c.notes ? '<div style="margin-top:4px;font-size:0.82rem;color:var(--text-muted, #666);border-top:1px solid var(--border, #90caf9);padding-top:6px;">' + c.notes + '</div>' : '') +
              '</div></div>';
            bodyH += '<div style="display:flex;gap:6px;">' +
              '<button onclick="Maintenance._editContract(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;">✏️ ' + tt('ערוך חוזה','แก้ไขสัญญา','تعديل العقد') + '</button>' +
              '<button onclick="Maintenance._contractPDF(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#0d47a1;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📄 ' + tt('הורד PDF','ดาวน์โหลด PDF','تنزيل PDF') + '</button>' +
              '<button onclick="Maintenance._delContract(' + pid + ')" style="padding:10px 16px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button></div>';
          }
        }

        // ──────────────────────
        //  TAB: INVOICES
        // ──────────────────────
        else if (_activeTab === 'invoices') {
          var invs = p.invoices || [];
          var invTot = calcInvoiceTotals(p);
          var contractVal = (p.contract && p.contract.totalValue) ? p.contract.totalValue : 0;
          var budgetUsed = contractVal > 0 ? (invTot.total / contractVal * 100) : 0;

          // Budget bar
          if (contractVal > 0) {
            var barColor = budgetUsed > 100 ? '#f44336' : budgetUsed > 80 ? '#ef6c00' : '#4caf50';
            bodyH += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:10px;padding:12px;margin-bottom:14px;">' +
              '<div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-bottom:6px;"><span>' + tt('תקציב מול חוזה','งบประมาณเทียบสัญญา','الميزانية مقابل العقد') + '</span><span style="font-weight:700;color:' + barColor + ';">' + budgetUsed.toFixed(1) + '%</span></div>' +
              '<div style="background:var(--border, #ddd);border-radius:6px;height:8px;overflow:hidden;"><div style="background:' + barColor + ';height:100%;width:' + Math.min(budgetUsed, 100) + '%;border-radius:6px;transition:width 0.3s;"></div></div>' +
              '<div style="display:flex;justify-content:space-between;font-size:0.78rem;color:var(--text-muted, #999);margin-top:4px;"><span>₪' + fmt(invTot.total) + ' / ₪' + fmt(contractVal) + '</span>' +
              '<span>' + tt('נותר','เหลือ','المتبقي') + ': ₪' + fmt(contractVal - invTot.total) + '</span></div></div>';
          }

          // Summary cards (now with overdue)
          bodyH += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:14px;">' +
            '<div style="background:#e8f5e9;border-radius:10px;padding:8px;text-align:center;"><div style="font-size:0.68rem;color:#2e7d32;">' + tt('שולם','ชำระแล้ว','مدفوع') + '</div><div style="font-weight:700;font-size:0.92rem;color:#2e7d32;">₪' + fmt(invTot.paid) + '</div></div>' +
            '<div style="background:#fff3e0;border-radius:10px;padding:8px;text-align:center;"><div style="font-size:0.68rem;color:#ef6c00;">' + tt('ממתין','รอดำเนินการ','قيد الانتظار') + '</div><div style="font-weight:700;font-size:0.92rem;color:#ef6c00;">₪' + fmt(invTot.pending) + '</div></div>' +
            '<div style="background:#ffebee;border-radius:10px;padding:8px;text-align:center;"><div style="font-size:0.68rem;color:#f44336;">' + tt('באיחור','เกินกำหนด','متأخر') + '</div><div style="font-weight:700;font-size:0.92rem;color:#f44336;">₪' + fmt(invTot.overdue) + '</div></div>' +
            '<div style="background:var(--surface-glass, #f5f5f5);border-radius:10px;padding:8px;text-align:center;"><div style="font-size:0.68rem;color:var(--text-muted, #666);">' + tt('סה"כ','รวม','المجموع') + '</div><div style="font-weight:700;font-size:0.92rem;">₪' + fmt(invTot.total) + '</div></div></div>';

          // Category breakdown
          var catKeys = Object.keys(invTot.byCategory);
          if (catKeys.length > 1) {
            bodyH += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:10px;padding:10px;margin-bottom:14px;">' + sectTitle('📊', tt('פילוח לפי קטגוריה','แยกตามหมวดหมู่','تفصيل حسب الفئة')) +
              '<div style="display:grid;gap:3px;margin-top:6px;font-size:0.82rem;">';
            catKeys.forEach(function(k) {
              var cat = EXPENSE_CATEGORIES.find(function(c) { return c.value === k; }) || { icon: '📎', label: k };
              var pct = invTot.total > 0 ? (invTot.byCategory[k] / invTot.total * 100) : 0;
              bodyH += '<div style="display:flex;align-items:center;gap:6px;">' +
                '<span style="width:90px;">' + cat.icon + ' ' + cat.label + '</span>' +
                '<div style="flex:1;background:var(--border, #ddd);border-radius:4px;height:6px;overflow:hidden;"><div style="background:#4caf50;height:100%;width:' + pct + '%;border-radius:4px;"></div></div>' +
                '<span style="min-width:80px;text-align:left;font-weight:600;">₪' + fmt(invTot.byCategory[k]) + '</span></div>';
            });
            bodyH += '</div></div>';
          }

          // Invoice list
          bodyH += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('🧾', tt('רשימת חשבוניות','รายการใบแจ้งหนี้','قائمة الفواتير')) + addBtn(tt('הוסף','เพิ่ม','إضافة'), '_addInvoice', pid) + '</div>';
          if (!invs.length) {
            bodyH += '<div style="text-align:center;color:var(--text-muted, #999);padding:16px;">' + tt('אין חשבוניות','ไม่มีใบแจ้งหนี้','لا فواتير') + '</div>';
          } else {
            invs.forEach(function(inv, i) {
              var is = INVOICE_STATUSES.find(function(s) { return s.value === inv.status; }) || INVOICE_STATUSES[0];
              var cat = EXPENSE_CATEGORIES.find(function(c) { return c.value === inv.category; }) || EXPENSE_CATEGORIES[5];
              var total = (inv.amount || 0) + (inv.vatAmount || 0);
              bodyH += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:10px;padding:10px;margin-bottom:6px;border-right:3px solid ' + is.color + ';">' +
                '<div style="display:flex;justify-content:space-between;align-items:center;">' +
                  '<div><span style="font-weight:700;">' + (inv.invoiceNumber || '#' + (i+1)) + '</span>' +
                  ' <span style="font-size:0.72rem;padding:1px 5px;border-radius:4px;background:#e8eaf6;color:#3949ab;">' + cat.icon + ' ' + cat.label + '</span>' +
                  (inv.supplier ? ' · <span style="color:var(--text-muted, #666);">' + inv.supplier + '</span>' : '') + '</div>' +
                  '<div style="display:flex;align-items:center;gap:6px;">' +
                    '<span style="font-size:0.72rem;padding:2px 6px;border-radius:4px;background:' + is.color + '22;color:' + is.color + ';font-weight:600;">' + is.label + '</span>' +
                    '<button onclick="Maintenance._editInvoice(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;font-size:0.9rem;">✏️</button>' +
                    '<button onclick="Maintenance._delInvoice(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;font-size:0.9rem;">🗑️</button>' +
                  '</div></div>' +
                '<div style="display:flex;justify-content:space-between;font-size:0.82rem;margin-top:4px;color:var(--text-muted, #999);">' +
                  '<span>' + (inv.date || '') + (inv.dueDate ? ' · ' + tt('לתשלום','ครบกำหนด','الاستحقاق') + ': ' + inv.dueDate : '') + '</span>' +
                  '<span style="font-weight:700;color:var(--text, #222);">₪' + fmt(total) + (inv.vatAmount ? ' <span style="font-size:0.72rem;color:var(--text-muted, #999);">(' + tt('כולל מע"מ','รวม VAT','شامل ضريبة') + ' ₪' + fmt(inv.vatAmount) + ')</span>' : '') + '</span>' +
                '</div>' +
                (inv.notes ? '<div style="font-size:0.78rem;color:var(--text-muted, #999);margin-top:2px;">' + inv.notes + '</div>' : '') +
              '</div>';
            });
          }

          // Invoice PDF button
          if (invs.length) {
            bodyH += '<div style="text-align:center;margin-top:10px;"><button onclick="Maintenance._invoicesPDF(' + pid + ')" style="padding:10px 20px;border-radius:10px;border:none;background:#ef6c00;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🧾 ' + tt('הורד דו"ח חשבוניות','ดาวน์โหลดรายงานใบแจ้งหนี้','تنزيل تقرير الفواتير') + '</button></div>';
          }
        }

        // ── Universal footer (shows on every tab) ──
        var footerH = '<div style="display:flex;gap:6px;margin-top:14px;padding-top:12px;border-top:1px solid var(--border, #ddd);">' +
          (canEdit ? '<button onclick="Maintenance._delProj(' + pid + ')" style="padding:10px 16px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;" title="' + tt('מחק פרויקט','ลบโครงการ','حذف المشروع') + '">🗑️</button>' : '') +
          '<button onclick="Maintenance.showProjectsList()" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--surface-glass, #eee);color:var(--text, inherit);font-family:inherit;font-weight:600;cursor:pointer;">✖ ' + tt('סגור','ปิด','إغلاق') + '</button>' +
        '</div>';

        // ── Render ──
        var modal = document.getElementById('modalContainer');
        modal.innerHTML = '<div style="' + modalBg + '"><div data-maint-project-id="' + pid + '" data-maint-active-tab="' + _activeTab + '" style="' + modalCard + '700px;max-height:90vh;overflow-y:auto;">' + headerH + tabH + bodyH + footerH + '</div></div>';
      });
    });
  }

  // ══════════════════════════════════════
  //  MATERIAL CRUD
  // ══════════════════════════════════════
  function _addMat(pid, idx) {
    ensureLabels();
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var m = (idx >= 0) ? p.materials[idx] : { name: '', quantity: 1, unit: "יח'", unitPrice: 0, costPrice: 0, supplier: '' };
      var uOpts = UNITS.map(function(u) { return '<option' + (m.unit === u ? ' selected' : '') + '>' + u + '</option>'; }).join('');
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">📦 ' + (idx >= 0 ? tt('עריכת חומר','แก้ไขวัสดุ','تعديل مادة') : tt('הוספת חומר','เพิ่มวัสดุ','إضافة مادة')) + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">' + tt('שם החומר','ชื่อวัสดุ','اسم المادة') + ' *</label><input id="mmN" value="' + (m.name || '') + '" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('כמות','จำนวน','كمية') + '</label><input id="mmQ" type="number" value="' + (m.quantity || 1) + '" min="0" step="0.1" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('יחידה','หน่วย','وحدة') + '</label><select id="mmU" style="' + inputS + '">' + uOpts + '</select></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('מחיר ₪ (ללקוח)','ราคา ₪ (ลูกค้า)','سعر ₪ (للعميل)') + '</label><input id="mmP" type="number" value="' + (m.unitPrice || 0) + '" min="0" step="0.01" style="' + inputS + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('עלות אמיתית ₪','ต้นทุนจริง ₪','التكلفة الحقيقية ₪') + '</label><input id="mmCP" type="number" value="' + (m.costPrice || m.unitPrice || 0) + '" min="0" step="0.01" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('ספק','ซัพพลายเออร์','مورد') + '</label><input id="mmS" value="' + (m.supplier || '') + '" style="' + inputS + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveMat(' + pid + ',' + (idx >= 0 ? idx : -1) + ')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ')" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div></div></div></div>';
    });
  }
  function _saveMat(pid, idx) {
    var n = document.getElementById('mmN').value.trim(); if (!n) { showToast(tt('❌ חובה למלא שם','❌ ต้องกรอกชื่อ','❌ يجب إدخال الاسم')); return; }
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var m = { name: n, quantity: parseFloat(document.getElementById('mmQ').value) || 0, unit: document.getElementById('mmU').value, unitPrice: parseFloat(document.getElementById('mmP').value) || 0, costPrice: parseFloat(document.getElementById('mmCP').value) || 0, supplier: document.getElementById('mmS').value.trim() };
      if (idx >= 0) p.materials[idx] = m; else { if (!p.materials) p.materials = []; p.materials.push(m); }
      p.updated = Date.now(); saveProjects(projects); showDetail(pid);
    });
  }
  function _editMat(pid, i) { _addMat(pid, i); }
  function _delMat(pid, i) { if (!confirm(tt('למחוק חומר?','ลบวัสดุ?','حذف المادة؟'))) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.materials.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid); }); }

  // ══════════════════════════════════════
  //  LABOR CRUD
  // ══════════════════════════════════════
  function _addLab(pid, idx) {
    ensureLabels();
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var l = (idx >= 0) ? p.labor[idx] : { description: '', hours: 1, hourlyRate: 50, costRate: 50 };
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">👷 ' + (idx >= 0 ? tt('עריכת עבודה','แก้ไขงาน','تعديل عمل') : tt('הוספת עבודה','เพิ่มงาน','إضافة عمل')) + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">' + tt('תיאור','รายละเอียด','وصف') + ' *</label><input id="mlD" value="' + (l.description || '') + '" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('שעות','ชั่วโมง','ساعات') + '</label><input id="mlH" type="number" value="' + (l.hours || 1) + '" min="0" step="0.5" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">₪/' + tt('שעה (ללקוח)','ชม. (ลูกค้า)','ساعة (للعميل)') + '</label><input id="mlR" type="number" value="' + (l.hourlyRate || 50) + '" min="0" style="' + inputS + '"></div></div>' +
        '<div><label style="' + lblS + '">₪/' + tt('שעה (עלות אמיתית)','ชม. (ต้นทุนจริง)','ساعة (التكلفة الحقيقية)') + '</label><input id="mlCR" type="number" value="' + (l.costRate || l.hourlyRate || 50) + '" min="0" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveLab(' + pid + ',' + (idx >= 0 ? idx : -1) + ')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ')" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div></div></div></div>';
    });
  }
  function _saveLab(pid, idx) {
    var d = document.getElementById('mlD').value.trim(); if (!d) { showToast(tt('❌ חובה למלא תיאור','❌ ต้องกรอกรายละเอียด','❌ يجب إدخال الوصف')); return; }
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return;
      var l = { description: d, hours: parseFloat(document.getElementById('mlH').value) || 0, hourlyRate: parseFloat(document.getElementById('mlR').value) || 0, costRate: parseFloat(document.getElementById('mlCR').value) || 0 };
      if (idx >= 0) p.labor[idx] = l; else { if (!p.labor) p.labor = []; p.labor.push(l); }
      p.updated = Date.now(); saveProjects(ps); showDetail(pid);
    });
  }
  function _editLab(pid, i) { _addLab(pid, i); }
  function _delLab(pid, i) { if (!confirm(tt('למחוק?','ลบ?','حذف؟'))) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.labor.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid); }); }

  // ══════════════════════════════════════
  //  SHIPMENT CRUD
  // ══════════════════════════════════════
  function _addShip(pid) {
    ensureLabels();
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var mOpts = '<option value="">— ' + tt('בחר חומר','เลือกวัสดุ','اختر مادة') + ' —</option>'; (p.materials || []).forEach(function(m) { mOpts += '<option>' + m.name + '</option>'; });
      var today = new Date().toISOString().slice(0, 10);
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">🚚 ' + tt('רישום משלוח','บันทึกการจัดส่ง','تسجيل شحنة') + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">' + tt('תאריך','วันที่','تاريخ') + '</label><input id="msD" type="date" value="' + today + '" style="' + inputS + '"></div>' +
        '<div><label style="' + lblS + '">' + tt('חומר','วัสดุ','مادة') + '</label><select id="msM" style="' + inputS + '">' + mOpts + '</select></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('כמות','จำนวน','كمية') + '</label><input id="msQ" type="number" value="1" min="0" step="0.1" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('ספק','ซัพพลายเออร์','مورد') + '</label><input id="msSup" style="' + inputS + '"></div></div>' +
        '<div><label style="' + lblS + '">' + tt('הערות','หมายเหตุ','ملاحظات') + '</label><input id="msN" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveShip(' + pid + ')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ')" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div></div></div></div>';
    });
  }
  function _saveShip(pid) {
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return;
      if (!p.shipments) p.shipments = [];
      p.shipments.push({ date: document.getElementById('msD').value, materialName: document.getElementById('msM').value || tt('כללי','ทั่วไป','عام'), quantity: parseFloat(document.getElementById('msQ').value) || 0, supplier: document.getElementById('msSup').value.trim(), notes: document.getElementById('msN').value.trim() });
      p.updated = Date.now(); saveProjects(ps); showDetail(pid);
    });
  }
  function _delShip(pid, i) { if (!confirm(tt('למחוק?','ลบ?','حذف؟'))) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.shipments.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid); }); }
  function _delProj(pid) { if (!confirm(tt('למחוק פרויקט שלם?','ลบโครงการทั้งหมด?','حذف المشروع بالكامل؟'))) return; loadProjects().then(function(ps) { saveProjects(ps.filter(function(x) { return x.id !== pid; })); showToast(tt('🗑️ נמחק','🗑️ ลบแล้ว','🗑️ تم الحذف')); showProjectsList(); }); }

  // ══════════════════════════════════════
  //  INVOICE CRUD
  // ══════════════════════════════════════
  function _addInvoice(pid, idx) {
    ensureLabels();
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var inv = (idx >= 0 && p.invoices && p.invoices[idx]) ? p.invoices[idx] : { invoiceNumber: '', supplier: '', date: new Date().toISOString().slice(0, 10), dueDate: '', amount: 0, vatAmount: 0, status: 'pending', category: 'materials', notes: '' };
      var stOpts = ''; INVOICE_STATUSES.forEach(function(s) { stOpts += '<option value="' + s.value + '"' + (inv.status === s.value ? ' selected' : '') + '>' + s.label + '</option>'; });
      var catOpts = ''; EXPENSE_CATEGORIES.forEach(function(c) { catOpts += '<option value="' + c.value + '"' + (inv.category === c.value ? ' selected' : '') + '>' + c.icon + ' ' + c.label + '</option>'; });
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '450px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">🧾 ' + (idx >= 0 ? tt('עריכת חשבונית','แก้ไขใบแจ้งหนี้','تعديل فاتورة') : tt('חשבונית חדשה','ใบแจ้งหนี้ใหม่','فاتورة جديدة')) + '</h3><div style="display:grid;gap:10px;">' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('מס\' חשבונית','เลขที่ใบแจ้งหนี้','رقم الفاتورة') + '</label><input id="invNum" value="' + (inv.invoiceNumber || '') + '" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('ספק','ซัพพลายเออร์','مورد') + '</label><input id="invSup" value="' + (inv.supplier || '') + '" style="' + inputS + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('קטגוריה','หมวดหมู่','الفئة') + '</label><select id="invCat" style="' + inputS + '">' + catOpts + '</select></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('סטטוס','สถานะ','الحالة') + '</label><select id="invSt" style="' + inputS + '">' + stOpts + '</select></div></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('תאריך','วันที่','تاريخ') + '</label><input id="invDate" type="date" value="' + (inv.date || '') + '" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('תאריך תשלום','วันครบกำหนด','تاريخ الاستحقاق') + '</label><input id="invDue" type="date" value="' + (inv.dueDate || '') + '" style="' + inputS + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('סכום (לפני מע"מ)','จำนวนเงิน (ก่อน VAT)','المبلغ (قبل الضريبة)') + '</label><input id="invAmt" type="number" value="' + (inv.amount || 0) + '" min="0" step="0.01" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('מע"מ ₪','VAT ₪','ضريبة ₪') + '</label><input id="invVat" type="number" value="' + (inv.vatAmount || 0) + '" min="0" step="0.01" style="' + inputS + '"></div></div>' +
        '<div><label style="' + lblS + '">' + tt('הערות','หมายเหตุ','ملاحظات') + '</label><input id="invNotes" value="' + (inv.notes || '') + '" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveInvoice(' + pid + ',' + (idx >= 0 ? idx : -1) + ')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ',\'invoices\')" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div></div></div></div>';
    });
  }
  function _saveInvoice(pid, idx) {
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return;
      var inv = { id: Date.now(), invoiceNumber: document.getElementById('invNum').value.trim(), supplier: document.getElementById('invSup').value.trim(), date: document.getElementById('invDate').value, dueDate: document.getElementById('invDue').value, amount: parseFloat(document.getElementById('invAmt').value) || 0, vatAmount: parseFloat(document.getElementById('invVat').value) || 0, status: document.getElementById('invSt').value, category: document.getElementById('invCat').value, notes: document.getElementById('invNotes').value.trim() };
      if (!p.invoices) p.invoices = [];
      if (idx >= 0) p.invoices[idx] = inv; else p.invoices.push(inv);
      p.updated = Date.now(); saveProjects(ps); showDetail(pid, 'invoices');
    });
  }
  function _editInvoice(pid, i) { _addInvoice(pid, i); }
  function _delInvoice(pid, i) { if (!confirm(tt('למחוק חשבונית?','ลบใบแจ้งหนี้?','حذف الفاتورة؟'))) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.invoices.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid, 'invoices'); }); }

  // ══════════════════════════════════════
  //  CONTRACT CRUD
  // ══════════════════════════════════════
  function _editContract(pid) {
    ensureLabels();
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var c = p.contract || { contractNumber: '', clientName: p.client || '', signedDate: '', paymentTerms: 'cash', totalValue: 0, status: 'pending', notes: '' };
      var csOpts = ''; CONTRACT_STATUSES.forEach(function(s) { csOpts += '<option value="' + s.value + '"' + (c.status === s.value ? ' selected' : '') + '>' + s.label + '</option>'; });
      var ptOpts = ''; PAY_TERMS.forEach(function(t) { ptOpts += '<option value="' + t.value + '"' + (c.paymentTerms === t.value ? ' selected' : '') + '>' + t.label + '</option>'; });
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '450px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:14px;">📋 ' + tt('פרטי חוזה','รายละเอียดสัญญา','تفاصيل العقد') + '</h3><div style="display:grid;gap:10px;">' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('מס\' חוזה','เลขที่สัญญา','رقم العقد') + '</label><input id="ctNum" value="' + (c.contractNumber || '') + '" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('לקוח','ลูกค้า','عميل') + '</label><input id="ctClient" value="' + (c.clientName || '') + '" style="' + inputS + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('תאריך חתימה','วันที่ลงนาม','تاريخ التوقيع') + '</label><input id="ctDate" type="date" value="' + (c.signedDate || '') + '" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('סטטוס','สถานะ','الحالة') + '</label><select id="ctStatus" style="' + inputS + '">' + csOpts + '</select></div></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">' + tt('תנאי תשלום','เงื่อนไขการชำระ','شروط الدفع') + '</label><select id="ctPay" style="' + inputS + '">' + ptOpts + '</select></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">' + tt('ערך חוזה ₪','มูลค่าสัญญา ₪','قيمة العقد ₪') + '</label><input id="ctVal" type="number" value="' + (c.totalValue || 0) + '" min="0" step="100" style="' + inputS + '"></div></div>' +
        '<div><label style="' + lblS + '">' + tt('הערות','หมายเหตุ','ملاحظات') + '</label><textarea id="ctNotes" rows="2" style="' + inputS + 'resize:vertical;">' + (c.notes || '') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveContract(' + pid + ')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ',\'contract\')" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div></div></div></div>';
    });
  }
  function _saveContract(pid) {
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return;
      p.contract = { contractNumber: document.getElementById('ctNum').value.trim(), clientName: document.getElementById('ctClient').value.trim(), signedDate: document.getElementById('ctDate').value, paymentTerms: document.getElementById('ctPay').value, totalValue: parseFloat(document.getElementById('ctVal').value) || 0, status: document.getElementById('ctStatus').value, notes: document.getElementById('ctNotes').value.trim() };
      p.updated = Date.now(); saveProjects(ps); showToast(tt('✅ חוזה נשמר','✅ บันทึกสัญญาแล้ว','✅ تم حفظ العقد')); showDetail(pid, 'contract');
    });
  }
  function _delContract(pid) { if (!confirm(tt('למחוק חוזה?','ลบสัญญา?','حذف العقد؟'))) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.contract = null; p.updated = Date.now(); saveProjects(ps); showDetail(pid, 'contract'); }); }

  // ══════════════════════════════════════
  //  INTERNAL COST inline updates
  // ══════════════════════════════════════
  function _updateCostPrice(pid, idx, val) {
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p || !p.materials[idx]) return;
      p.materials[idx].costPrice = parseFloat(val) || 0; p.updated = Date.now(); saveProjects(ps);
      // Refresh profit display without full re-render (smoother inline editing)
      var ic = calcInternal(p);
      var el = document.getElementById('internalProfit');
      if (el) { el.textContent = '₪' + fmt(ic.profit); el.style.color = ic.profit >= 0 ? '#2e7d32' : '#f44336'; }
    });
  }
  function _updateCostRate(pid, idx, val) {
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p || !p.labor[idx]) return;
      p.labor[idx].costRate = parseFloat(val) || 0; p.updated = Date.now(); saveProjects(ps);
    });
  }

  // ══════════════════════════════════════
  //  ACCESS CONTROL
  // ══════════════════════════════════════
  function showAccessControl() {
    ensureLabels(); ensurePermLabels();
    if (!isAdmin()) { showToast(tt('⛔ אין הרשאה','⛔ ไม่มีสิทธิ์','⛔ لا إذن')); return; }
    loadAccess().then(function(access) {
      var emails = Object.keys(access).sort();
      var h = '<div style="margin-bottom:14px;">' + sectTitle('🔐', tt('ניהול הרשאות תחזוקה','จัดการสิทธิ์การซ่อมบำรุง','إدارة أذونات الصيانة')) + '</div>';
      h += '<div style="font-size:0.82rem;color:var(--text-muted, #666);margin-bottom:12px;">' + tt('אדמין ומנהלים תמיד רואים הכל. כאן ניתן להגדיר הרשאות למשתמשים רגילים.','แอดมินและผู้จัดการมีสิทธิ์ทั้งหมดเสมอ ที่นี่สามารถกำหนดสิทธิ์ให้ผู้ใช้ทั่วไป','المسؤولون والمديرون لديهم كل الأذونات دائمًا. هنا يمكنك تعيين الأذونات للمستخدمين العاديين') + '</div>';

      if (!emails.length) {
        h += '<div style="text-align:center;color:var(--text-muted, #999);padding:16px;">' + tt('אין משתמשים עם הרשאות מיוחדות','ไม่มีผู้ใช้ที่มีสิทธิ์พิเศษ','لا يوجد مستخدمون بأذونات خاصة') + '</div>';
      } else {
        emails.forEach(function(email) {
          var perms = access[email] || {};
          var permTags = ''; PERMS.forEach(function(p) { if (perms[p]) permTags += '<span style="font-size:0.68rem;padding:2px 6px;border-radius:4px;background:var(--primary-faded, #e8f5e9);color:var(--primary, #2e7d32);margin-left:4px;">' + PERM_LABELS[p] + '</span>'; });
          h += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:8px;padding:10px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">' +
            '<div><div style="font-weight:600;font-size:0.88rem;">' + email + '</div><div style="margin-top:2px;">' + (permTags || '<span style="font-size:0.72rem;color:var(--text-muted, #999);">—</span>') + '</div></div>' +
            '<div><button onclick="Maintenance._editAccess(\'' + email.replace(/'/g, "\\'") + '\')" style="border:none;background:none;cursor:pointer;">✏️</button>' +
            '<button onclick="Maintenance._delAccess(\'' + email.replace(/'/g, "\\'") + '\')" style="border:none;background:none;cursor:pointer;">🗑️</button></div></div>';
        });
      }

      h += '<div style="margin-top:14px;"><label style="' + lblS + '">' + tt('הוסף משתמש (אימייל)','เพิ่มผู้ใช้ (อีเมล)','إضافة مستخدم (بريد إلكتروني)') + '</label>' +
        '<div style="display:flex;gap:6px;"><input id="acNewEmail" placeholder="user@gmail.com" style="' + inputS + 'flex:1;">' +
        '<button onclick="Maintenance._addAccess()" style="padding:8px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕</button></div></div>';

      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '500px;max-height:85vh;overflow-y:auto;">' + h +
        '<button onclick="Maintenance.showProjectsList()" style="margin-top:14px;width:100%;padding:10px;border-radius:10px;border:none;background:var(--surface-glass, #eee);color:var(--text, inherit);font-family:inherit;cursor:pointer;">' + tt('חזרה','กลับ','العودة') + '</button></div></div>';
    });
  }

  function _addAccess() {
    var email = (document.getElementById('acNewEmail').value || '').trim().toLowerCase();
    if (!email || !email.includes('@')) { showToast(tt('❌ אימייל לא תקין','❌ อีเมลไม่ถูกต้อง','❌ بريد إلكتروني غير صالح')); return; }
    loadAccess().then(function(access) {
      if (!access[email]) access[email] = {};
      // Default: view only
      access[email].view = true;
      saveAccess(access);
      _editAccess(email);
    });
  }

  function _editAccess(email) {
    ensurePermLabels();
    loadAccess().then(function(access) {
      var perms = access[email] || {};
      var h = '<h3 style="font-weight:700;margin-bottom:14px;">🔐 ' + email + '</h3><div style="display:grid;gap:8px;">';
      PERMS.forEach(function(p) {
        h += '<label style="display:flex;align-items:center;gap:10px;font-size:0.88rem;cursor:pointer;padding:6px 0;"><input type="checkbox" id="perm_' + p + '"' + (perms[p] ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#2e7d32;"> ' + PERM_LABELS[p] + '</label>';
      });
      h += '</div>';
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' + h +
        '<div style="display:flex;gap:8px;margin-top:14px;"><button onclick="Maintenance._saveAccess(\'' + email.replace(/'/g, "\\'") + '\')" style="' + btnSave + '">💾 ' + tt('שמור','บันทึก','حفظ') + '</button>' +
        '<button onclick="Maintenance.showAccessControl()" style="' + btnCancel + '">' + tt('ביטול','ยกเลิก','إلغاء') + '</button></div></div></div>';
    });
  }

  function _saveAccess(email) {
    loadAccess().then(function(access) {
      var perms = {};
      PERMS.forEach(function(p) { var el = document.getElementById('perm_' + p); if (el && el.checked) perms[p] = true; });
      access[email] = perms; saveAccess(access);
      showToast(tt('✅ הרשאות נשמרו','✅ บันทึกสิทธิ์แล้ว','✅ تم حفظ الأذونات'));
      showAccessControl();
    });
  }
  function _delAccess(email) { if (!confirm(tt('למחוק הרשאות?','ลบสิทธิ์?','حذف الأذونات؟'))) return; loadAccess().then(function(access) { delete access[email]; saveAccess(access); showAccessControl(); }); }

  // ══════════════════════════════════════
  //  DASHBOARD (aggregate across projects)
  // ══════════════════════════════════════
  function showDashboard() {
    ensureLabels();
    loadProjects().then(function(projects) {
      var totQuotes = 0, totCosts = 0, totPaid = 0, totPending = 0, totOverdue = 0;
      var activeCount = 0, completedCount = 0, draftCount = 0;
      var topProjects = [];

      projects.forEach(function(p) {
        var tot = calcProject(p);
        var ic = calcInternal(p);
        var inv = calcInvoiceTotals(p);
        totQuotes += tot.total;
        totCosts += ic.totalCost;
        totPaid += inv.paid;
        totPending += inv.pending;
        totOverdue += inv.overdue;
        if (p.status === 'in_progress') activeCount++;
        else if (p.status === 'completed') completedCount++;
        else if (p.status === 'draft') draftCount++;
        topProjects.push({ name: p.name, total: tot.total, profit: ic.profit, status: p.status, id: p.id });
      });

      topProjects.sort(function(a, b) { return b.total - a.total; });
      var profitTotal = totQuotes - totCosts;
      var profitPct = totQuotes > 0 ? (profitTotal / totQuotes * 100) : 0;
      var profitColor = profitTotal >= 0 ? '#2e7d32' : '#f44336';

      var h = '<h3 style="font-weight:700;margin:0 0 14px;">📊 ' + tt('דשבורד תחזוקה','แดชบอร์ดซ่อมบำรุง','لوحة تحكم الصيانة') + '</h3>';

      // KPI cards
      h += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:14px;">' +
        '<div style="background:#e8f5e9;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.68rem;color:#2e7d32;">' + tt('סה"כ הצעות','รวมใบเสนอราคา','إجمالي العروض') + '</div><div style="font-weight:700;font-size:1.1rem;color:var(--primary, #1b5e20);">₪' + fmt(totQuotes) + '</div></div>' +
        '<div style="background:' + profitColor + '18;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.68rem;color:' + profitColor + ';">' + tt('רווח כולל','กำไรรวม','الربح الإجمالي') + '</div><div style="font-weight:700;font-size:1.1rem;color:' + profitColor + ';">₪' + fmt(profitTotal) + ' <span style="font-size:0.72rem;">(' + profitPct.toFixed(1) + '%)</span></div></div>' +
        '<div style="background:#e3f2fd;border-radius:10px;padding:10px;text-align:center;"><div style="font-size:0.68rem;color:#1565c0;">' + tt('פרויקטים','โครงการ','المشاريع') + '</div><div style="font-weight:700;font-size:1.1rem;color:#0d47a1;">' + projects.length + '</div></div></div>';

      // Status breakdown
      h += '<div style="display:flex;gap:6px;margin-bottom:14px;">' +
        '<div style="flex:1;background:var(--surface-glass, #f5f5f5);border-radius:8px;padding:8px;text-align:center;font-size:0.82rem;"><span style="color:var(--text-muted, #999);">📝</span> ' + draftCount + ' ' + tt('טיוטות','แบบร่าง','مسودات') + '</div>' +
        '<div style="flex:1;background:#fff3e0;border-radius:8px;padding:8px;text-align:center;font-size:0.82rem;"><span style="color:#ef6c00;">🔨</span> ' + activeCount + ' ' + tt('פעילים','ใช้งานอยู่','نشط') + '</div>' +
        '<div style="flex:1;background:#e8f5e9;border-radius:8px;padding:8px;text-align:center;font-size:0.82rem;"><span style="color:#4caf50;">✅</span> ' + completedCount + ' ' + tt('הושלמו','เสร็จสมบูรณ์','مكتملة') + '</div></div>';

      // Payment status
      h += '<div style="background:var(--surface-glass, #f5f7f5);border-radius:12px;padding:14px;margin-bottom:14px;">' + sectTitle('💳', tt('סטטוס תשלומים','สถานะการชำระ','حالة المدفوعات')) +
        '<div style="display:grid;gap:4px;font-size:0.88rem;margin-top:8px;">' +
          '<div style="display:flex;justify-content:space-between;"><span style="color:#2e7d32;">✅ ' + tt('שולם','ชำระแล้ว','مدفوع') + '</span><span style="font-weight:600;">₪' + fmt(totPaid) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;"><span style="color:#ef6c00;">⏳ ' + tt('ממתין','รอดำเนินการ','قيد الانتظار') + '</span><span style="font-weight:600;">₪' + fmt(totPending) + '</span></div>' +
          (totOverdue > 0 ? '<div style="display:flex;justify-content:space-between;"><span style="color:#f44336;">⚠️ ' + tt('באיחור','เกินกำหนด','متأخر') + '</span><span style="font-weight:700;color:#f44336;">₪' + fmt(totOverdue) + '</span></div>' : '') +
        '</div></div>';

      // Top projects
      if (topProjects.length) {
        h += sectTitle('🏆', tt('פרויקטים מובילים','โครงการชั้นนำ','أفضل المشاريع'));
        h += '<div style="margin-top:8px;">';
        topProjects.slice(0, 5).forEach(function(tp) {
          var st = STATUSES.find(function(s) { return s.value === tp.status; }) || STATUSES[0];
          var pColor = tp.profit >= 0 ? '#2e7d32' : '#f44336';
          h += '<div onclick="Maintenance.showDetail(' + tp.id + ')" style="background:var(--surface-glass, #f5f7f5);border-radius:8px;padding:8px 10px;margin-bottom:4px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;">' +
            '<div><span style="font-weight:600;font-size:0.88rem;">' + tp.name + '</span> <span style="font-size:0.68rem;padding:2px 5px;border-radius:4px;background:' + st.color + '22;color:' + st.color + ';">' + st.label + '</span></div>' +
            '<div style="text-align:left;"><div style="font-weight:700;font-size:0.88rem;">₪' + fmt(tp.total) + '</div>' +
            '<div style="font-size:0.72rem;color:' + pColor + ';">' + tt('רווח','กำไร','ربح') + ': ₪' + fmt(tp.profit) + '</div></div></div>';
        });
        h += '</div>';
      }

      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '550px;max-height:90vh;overflow-y:auto;">' + h +
        '<button onclick="Maintenance.showProjectsList()" style="margin-top:14px;width:100%;padding:10px;border-radius:10px;border:none;background:var(--surface-glass, #eee);color:var(--text, inherit);font-family:inherit;cursor:pointer;">' + tt('חזרה','กลับ','العودة') + '</button></div></div>';
    });
  }

  // ══════════════════════════════════════
  //  PDF EXPORTS
  // ══════════════════════════════════════
  var pdfCss = '@page{margin:15mm}body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;color:var(--text, #222);direction:rtl;line-height:1.6;margin:0}.header{padding:28px 32px;border-radius:0 0 16px 16px;margin-bottom:24px;color:white}.header h1{font-size:1.4rem;margin:0 0 4px}.header .meta{font-size:.85rem;opacity:.85}.content{padding:0 24px}.section{font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 8px;padding-bottom:4px;border-bottom:2px solid #ddd}table{width:100%;border-collapse:collapse;font-size:.85rem;margin-bottom:16px}th{padding:8px 10px;text-align:right;font-weight:700;font-size:.78rem}td{padding:8px 10px;border-bottom:1px solid var(--border, #eee)}tfoot td{font-weight:700}.summary{background:var(--surface-glass, #f5f7f5);border-radius:12px;padding:16px;margin:20px 0}.sr{display:flex;justify-content:space-between;padding:4px 0;font-size:.9rem}.st{font-size:1.2rem;font-weight:800;border-top:2px solid;padding-top:8px;margin-top:8px}.footer{text-align:center;padding:20px;margin-top:24px;font-size:.78rem;color:var(--text-muted, #888);border-top:1px solid var(--border, #eee)}';

  function _downloadPDF(html, filename) {
    var container = document.createElement('div');
    container.className = 'export-print-root';
    container.innerHTML = html;
    container.style.cssText = 'position:fixed;left:-9999px;top:0;width:210mm;background:#ffffff;color:#111;z-index:-1;';
    document.body.appendChild(container);

    // Wait for fonts + a render frame BEFORE capture — blank PDFs come from
    // html2canvas capturing the container before its layout has settled.
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    fontsReady.then(function() {
      return new Promise(function(resolve) { requestAnimationFrame(function() { resolve(); }); });
    }).then(function() {
      return html2pdf().set({
        margin: [10, 10, 14, 10],
        filename: filename.replace(/\.html$/, '.pdf'),
        image: { type: 'jpeg', quality: 0.96 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.no-break', '.summary'] }
      }).from(container).save();
    }).then(function() {
      if (container.parentNode) container.parentNode.removeChild(container);
    }).catch(function(err) {
      try { if (container.parentNode) container.parentNode.removeChild(container); } catch(e) {}
      console.error('PDF generation failed:', err);
      // Fallback to HTML download
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' }); var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename; a.click(); URL.revokeObjectURL(a.href);
    });
  }

  // Quote PDF (client-facing)
  function _quotePDF(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var tot = calcProject(p); var today = new Date().toLocaleDateString('he-IL');
      var matR = ''; (p.materials || []).forEach(function(m, i) { var lt = (m.quantity||0)*(m.unitPrice||0); matR += '<tr><td>' + (i+1) + '</td><td>' + m.name + '</td><td>' + m.quantity + ' ' + (m.unit||'') + '</td><td>₪' + fmt(m.unitPrice) + '</td><td style="font-weight:700;">₪' + fmt(lt) + '</td></tr>'; });
      var labR = ''; (p.labor || []).forEach(function(l, i) { var lt = (l.hours||0)*(l.hourlyRate||0); labR += '<tr><td>' + (i+1) + '</td><td>' + l.description + '</td><td>' + l.hours + ' שעות</td><td>₪' + fmt(l.hourlyRate) + '</td><td style="font-weight:700;">₪' + fmt(lt) + '</td></tr>'; });
      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>הצעת מחיר — ' + p.name + '</title><style>' + pdfCss + '.header{background:linear-gradient(135deg,#1a5632,#2d6a4f)}.section{color:#2d6a4f;border-color:#d8f3dc}th{background:#e8f5e9}tfoot td{border-top:2px solid #2e7d32}.st{color:var(--primary, #1b5e20);border-color:#2e7d32}</style></head><body>' +
        '<div class="header"><h1>🔧 הצעת מחיר</h1><div class="meta">' + p.name + (p.client ? ' · לכבוד: ' + p.client : '') + ' · ' + today + '</div></div><div class="content">' +
        (p.description ? '<div style="font-size:.88rem;color:var(--text-muted, #555);margin-bottom:14px;">' + p.description + '</div>' : '') +
        ((p.materials||[]).length ? '<div class="section">📦 חומרים</div><table><thead><tr><th>#</th><th>חומר</th><th>כמות</th><th>מחיר ליח\'</th><th>סה"כ</th></tr></thead><tbody>' + matR + '</tbody><tfoot><tr><td colspan="4">סה"כ חומרים</td><td>₪' + fmt(tot.materialsTotal) + '</td></tr></tfoot></table>' : '') +
        ((p.labor||[]).length ? '<div class="section">👷 עבודה</div><table><thead><tr><th>#</th><th>תיאור</th><th>כמות</th><th>מחיר</th><th>סה"כ</th></tr></thead><tbody>' + labR + '</tbody><tfoot><tr><td colspan="4">סה"כ עבודה</td><td>₪' + fmt(tot.laborTotal) + '</td></tr></tfoot></table>' : '') +
        '<div class="summary"><div style="font-weight:700;margin-bottom:8px;">💰 סיכום</div>' +
          '<div class="sr"><span>חומרים</span><span>₪' + fmt(tot.materialsTotal) + '</span></div>' +
          '<div class="sr"><span>עבודה</span><span>₪' + fmt(tot.laborTotal) + '</span></div>' +
          (p.markup ? '<div class="sr"><span>תוספת ' + p.markup + '%</span><span>₪' + fmt(tot.markup) + '</span></div>' : '') +
          '<div class="sr"><span>לפני מע"מ</span><span>₪' + fmt(tot.beforeVat) + '</span></div>' +
          (p.includeVat ? '<div class="sr"><span>מע"מ 18%</span><span>₪' + fmt(tot.vat) + '</span></div>' : '') +
          '<div class="sr st"><span>סה"כ לתשלום</span><span>₪' + fmt(tot.total) + '</span></div></div>' +
        '<div style="font-size:.82rem;color:var(--text-muted, #666);margin-top:16px;"><strong>תנאים:</strong> הצעה תקפה ל-30 יום. מחירים אינם כוללים שינויים שלא סוכמו מראש.</div>' +
        '</div><div class="footer"><span style="color:#2d6a4f;font-weight:700;">🌿 שורשים פלוס</span> · הצעת מחיר · ' + today + '</div></body></html>';
      _downloadPDF(html, 'quote-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.pdf');
      showToast(tt('📄 הצעת מחיר הורדה','📄 ดาวน์โหลดใบเสนอราคาแล้ว','📄 تم تنزيل عرض السعر'));
    });
  }

  // Shipment log PDF
  function _shipPDF(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p || !(p.shipments||[]).length) { showToast(tt('📦 אין משלוחים','📦 ไม่มีจัดส่ง','📦 لا شحنات')); return; }
      var today = new Date().toLocaleDateString('he-IL');
      var rows = ''; p.shipments.forEach(function(s, i) { rows += '<tr><td>' + (i+1) + '</td><td>' + s.date + '</td><td>' + s.materialName + '</td><td>' + s.quantity + '</td><td>' + (s.supplier||'—') + '</td><td>' + (s.notes||'—') + '</td></tr>'; });
      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>יומן משלוחים — ' + p.name + '</title><style>' + pdfCss + '.header{background:linear-gradient(135deg,#4a148c,#7e57c2)}th{background:#ede7f6}tr:nth-child(even) td{background:var(--surface-glass, #fafafa)}</style></head><body>' +
        '<div class="header"><h1>🚚 יומן משלוחים</h1><div class="meta">' + p.name + (p.client ? ' · ' + p.client : '') + ' · ' + today + '</div></div>' +
        '<div class="content"><table><thead><tr><th>#</th><th>תאריך</th><th>חומר</th><th>כמות</th><th>ספק</th><th>הערות</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="footer"><span style="color:#7e57c2;font-weight:700;">🌿 שורשים פלוס</span> · יומן משלוחים · ' + today + '</div></body></html>';
      _downloadPDF(html, 'shipments-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.pdf');
      showToast(tt('🚚 יומן הורד','🚚 ดาวน์โหลดบันทึกแล้ว','🚚 تم تنزيل السجل'));
    });
  }

  // Internal report PDF (admin eyes only)
  function _internalPDF(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var ic = calcInternal(p); var tot = calcProject(p); var today = new Date().toLocaleDateString('he-IL');
      var matR = ''; (p.materials || []).forEach(function(m, i) {
        matR += '<tr><td>' + (i+1) + '</td><td>' + m.name + '</td><td>' + m.quantity + ' ' + (m.unit||'') + '</td><td>₪' + fmt(m.unitPrice) + '</td><td>₪' + fmt(m.costPrice || m.unitPrice) + '</td><td style="font-weight:700;">₪' + fmt((m.quantity||0) * (m.costPrice || m.unitPrice || 0)) + '</td></tr>';
      });
      var labR = ''; (p.labor || []).forEach(function(l, i) {
        labR += '<tr><td>' + (i+1) + '</td><td>' + l.description + '</td><td>' + l.hours + ' שעות</td><td>₪' + fmt(l.hourlyRate) + '</td><td>₪' + fmt(l.costRate || l.hourlyRate) + '</td><td style="font-weight:700;">₪' + fmt((l.hours||0) * (l.costRate || l.hourlyRate || 0)) + '</td></tr>';
      });
      var profitColor = ic.profit >= 0 ? '#2e7d32' : '#c62828';
      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>דו"ח פנימי — ' + p.name + '</title><style>' + pdfCss + '.header{background:linear-gradient(135deg,#bf360c,#e65100)}.section{color:#e65100;border-color:#ffccbc}th{background:#fbe9e7}tfoot td{border-top:2px solid #e65100}.st{color:' + profitColor + ';border-color:' + profitColor + '}.watermark{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:5rem;opacity:.06;font-weight:900;color:#c62828;pointer-events:none;z-index:0;}</style></head><body>' +
        '<div class="watermark">פנימי בלבד</div>' +
        '<div class="header"><h1>🔒 דו"ח עלויות פנימי</h1><div class="meta">' + p.name + (p.client ? ' · ' + p.client : '') + ' · ' + today + '</div></div><div class="content">' +
        ((p.materials||[]).length ? '<div class="section">📦 חומרים — השוואת עלויות</div><table><thead><tr><th>#</th><th>חומר</th><th>כמות</th><th>מחיר ללקוח</th><th>עלות אמיתית</th><th>סה"כ עלות</th></tr></thead><tbody>' + matR + '</tbody><tfoot><tr><td colspan="5">סה"כ עלות חומרים</td><td>₪' + fmt(ic.materialsCost) + '</td></tr></tfoot></table>' : '') +
        ((p.labor||[]).length ? '<div class="section">👷 עבודה — השוואת עלויות</div><table><thead><tr><th>#</th><th>תיאור</th><th>שעות</th><th>₪/שעה ללקוח</th><th>₪/שעה אמיתי</th><th>סה"כ עלות</th></tr></thead><tbody>' + labR + '</tbody><tfoot><tr><td colspan="5">סה"כ עלות עבודה</td><td>₪' + fmt(ic.laborCost) + '</td></tr></tfoot></table>' : '') +
        '<div class="summary"><div style="font-weight:700;margin-bottom:8px;">📊 ניתוח רווחיות</div>' +
          '<div class="sr"><span>סה"כ עלות אמיתית</span><span>₪' + fmt(ic.totalCost) + '</span></div>' +
          '<div class="sr"><span>הצעה ללקוח (לפני מע"מ)</span><span>₪' + fmt(ic.clientBeforeVat) + '</span></div>' +
          '<div class="sr st"><span>רווח (' + ic.margin.toFixed(1) + '%)</span><span>₪' + fmt(ic.profit) + '</span></div></div>' +
        '</div><div class="footer"><span style="color:#e65100;font-weight:700;">🔒 שורשים פלוס — פנימי בלבד</span> · ' + today + '</div></body></html>';
      _downloadPDF(html, 'internal-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.pdf');
      showToast(tt('📊 דו"ח פנימי הורד','📊 ดาวน์โหลดรายงานภายในแล้ว','📊 تم تنزيل التقرير الداخلي'));
    });
  }

  // Invoices summary PDF
  function _invoicesPDF(pid) {
    loadProjects().then(function(projects) {
      ensureLabels();
      var p = projects.find(function(x) { return x.id === pid; }); if (!p || !(p.invoices||[]).length) { showToast(tt('🧾 אין חשבוניות','🧾 ไม่มีใบแจ้งหนี้','🧾 لا فواتير')); return; }
      var invTot = calcInvoiceTotals(p); var today = new Date().toLocaleDateString('he-IL');
      var rows = ''; p.invoices.forEach(function(inv, i) {
        var is = INVOICE_STATUSES.find(function(s) { return s.value === inv.status; }) || INVOICE_STATUSES[0];
        var cat = EXPENSE_CATEGORIES.find(function(c) { return c.value === inv.category; }) || EXPENSE_CATEGORIES[5];
        var total = (inv.amount || 0) + (inv.vatAmount || 0);
        rows += '<tr><td>' + (i+1) + '</td><td>' + (inv.invoiceNumber || '—') + '</td><td>' + cat.icon + ' ' + cat.label + '</td><td>' + (inv.supplier || '—') + '</td><td>' + (inv.date || '—') + '</td><td>' + (inv.dueDate || '—') + '</td><td>₪' + fmt(inv.amount) + '</td><td>₪' + fmt(inv.vatAmount) + '</td><td style="font-weight:700;">₪' + fmt(total) + '</td><td style="color:' + is.color + ';font-weight:600;">' + is.label + '</td></tr>';
      });
      // Category summary
      var catSummary = ''; var catKeys = Object.keys(invTot.byCategory);
      catKeys.forEach(function(k) {
        var cat = EXPENSE_CATEGORIES.find(function(c) { return c.value === k; }) || { icon: '📎', label: k };
        catSummary += '<div class="sr"><span>' + cat.icon + ' ' + cat.label + '</span><span>₪' + fmt(invTot.byCategory[k]) + '</span></div>';
      });
      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>דו"ח חשבוניות — ' + p.name + '</title><style>' + pdfCss + '.header{background:linear-gradient(135deg,#e65100,#ef6c00)}.section{color:#e65100;border-color:#ffe0b2}th{background:#fff3e0}tr:nth-child(even) td{background:var(--surface-glass, #fafafa)}</style></head><body>' +
        '<div class="header"><h1>🧾 דו"ח חשבוניות והוצאות</h1><div class="meta">' + p.name + (p.client ? ' · ' + p.client : '') + ' · ' + today + '</div></div><div class="content">' +
        '<div class="summary" style="margin-bottom:16px;"><div style="font-weight:700;margin-bottom:8px;">💳 סיכום תשלומים</div>' +
          '<div class="sr"><span>✅ שולם</span><span style="color:#2e7d32;">₪' + fmt(invTot.paid) + '</span></div>' +
          '<div class="sr"><span>⏳ ממתין</span><span style="color:#ef6c00;">₪' + fmt(invTot.pending) + '</span></div>' +
          (invTot.overdue > 0 ? '<div class="sr"><span>⚠️ באיחור</span><span style="color:#f44336;font-weight:700;">₪' + fmt(invTot.overdue) + '</span></div>' : '') +
          '<div class="sr st"><span>סה"כ</span><span>₪' + fmt(invTot.total) + '</span></div></div>' +
        (catKeys.length > 1 ? '<div class="summary"><div style="font-weight:700;margin-bottom:8px;">📊 פילוח לפי קטגוריה</div>' + catSummary + '</div>' : '') +
        '<div class="section">🧾 פירוט חשבוניות</div>' +
        '<table><thead><tr><th>#</th><th>מס\' חשבונית</th><th>קטגוריה</th><th>ספק</th><th>תאריך</th><th>לתשלום</th><th>סכום</th><th>מע"מ</th><th>סה"כ</th><th>סטטוס</th></tr></thead><tbody>' + rows + '</tbody>' +
        '<tfoot><tr><td colspan="8" style="font-weight:700;">סה"כ</td><td style="font-weight:700;">₪' + fmt(invTot.total) + '</td><td></td></tr></tfoot></table>' +
        '</div><div class="footer"><span style="color:#ef6c00;font-weight:700;">🌿 שורשים פלוס</span> · דו"ח חשבוניות · ' + today + '</div></body></html>';
      _downloadPDF(html, 'invoices-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.pdf');
      showToast(tt('🧾 דו"ח חשבוניות הורד','🧾 ดาวน์โหลดรายงานใบแจ้งหนี้แล้ว','🧾 تم تنزيل تقرير الفواتير'));
    });
  }

  // Contract summary PDF
  function _contractPDF(pid) {
    loadProjects().then(function(projects) {
      ensureLabels();
      var p = projects.find(function(x) { return x.id === pid; }); if (!p || !p.contract) { showToast(tt('📋 אין חוזה','📋 ไม่มีสัญญา','📋 لا يوجد عقد')); return; }
      var c = p.contract; var today = new Date().toLocaleDateString('he-IL');
      var cs = CONTRACT_STATUSES.find(function(s) { return s.value === c.status; }) || CONTRACT_STATUSES[0];
      var pt = PAY_TERMS.find(function(t) { return t.value === c.paymentTerms; }) || PAY_TERMS[0];
      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>סיכום חוזה — ' + p.name + '</title><style>' + pdfCss + '.header{background:linear-gradient(135deg,#0d47a1,#1565c0)}.section{color:#1565c0;border-color:#bbdefb}th{background:#e3f2fd}.field{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border, #eee);font-size:.9rem}.field-label{color:#666}.field-value{font-weight:600}</style></head><body>' +
        '<div class="header"><h1>📋 סיכום חוזה</h1><div class="meta">' + p.name + ' · ' + today + '</div></div><div class="content">' +
        '<div class="section">פרטי חוזה</div>' +
        (c.contractNumber ? '<div class="field"><span class="field-label">מס\' חוזה</span><span class="field-value">' + c.contractNumber + '</span></div>' : '') +
        (c.clientName ? '<div class="field"><span class="field-label">לקוח</span><span class="field-value">' + c.clientName + '</span></div>' : '') +
        '<div class="field"><span class="field-label">סטטוס</span><span class="field-value" style="color:' + cs.color + '">' + cs.label + '</span></div>' +
        (c.signedDate ? '<div class="field"><span class="field-label">תאריך חתימה</span><span class="field-value">' + c.signedDate + '</span></div>' : '') +
        '<div class="field"><span class="field-label">תנאי תשלום</span><span class="field-value">' + pt.label + '</span></div>' +
        (c.totalValue ? '<div class="field" style="border-bottom:none;font-size:1.1rem;"><span class="field-label" style="font-weight:700;">ערך חוזה</span><span class="field-value" style="color:#1565c0;font-size:1.2rem;">₪' + fmt(c.totalValue) + '</span></div>' : '') +
        (c.notes ? '<div class="section">הערות</div><div style="font-size:.88rem;color:var(--text-muted, #555);">' + c.notes + '</div>' : '') +
        '</div><div class="footer"><span style="color:#1565c0;font-weight:700;">🌿 שורשים פלוס</span> · סיכום חוזה · ' + today + '</div></body></html>';
      _downloadPDF(html, 'contract-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.pdf');
      showToast(tt('📋 חוזה הורד','📋 ดาวน์โหลดสัญญาแล้ว','📋 تم تنزيل العقد'));
    });
  }

  // Initialize realtime sync
  _initSync();

  // ══════════════════════════════════════
  //  PUBLIC API
  // ══════════════════════════════════════
  return {
    showProjectsList: showProjectsList, showDetail: showDetail, showNewProject: showNewProject,
    showDashboard: showDashboard, _filterList: _filterList,
    _saveProject: _saveProject,
    _addMat: _addMat, _saveMat: _saveMat, _editMat: _editMat, _delMat: _delMat,
    _addLab: _addLab, _saveLab: _saveLab, _editLab: _editLab, _delLab: _delLab,
    _addShip: _addShip, _saveShip: _saveShip, _delShip: _delShip, _delProj: _delProj,
    _addInvoice: _addInvoice, _saveInvoice: _saveInvoice, _editInvoice: _editInvoice, _delInvoice: _delInvoice,
    _editContract: _editContract, _saveContract: _saveContract, _delContract: _delContract,
    _updateCostPrice: _updateCostPrice, _updateCostRate: _updateCostRate,
    showAccessControl: showAccessControl, _addAccess: _addAccess, _editAccess: _editAccess, _saveAccess: _saveAccess, _delAccess: _delAccess,
    _quotePDF: _quotePDF, _shipPDF: _shipPDF, _internalPDF: _internalPDF, _invoicesPDF: _invoicesPDF, _contractPDF: _contractPDF,
  };
})();
