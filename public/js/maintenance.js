// ── MAINTENANCE MODULE (תחזוקה) ──
// Admin-only: project costing, materials management, shipment logging, PDF quotes

var Maintenance = (function() {
  'use strict';

  var UNITS = ["יח'", "מ'", 'מ"ר', 'מ"ק', 'ק"ג', 'טון', 'ליטר', 'שק', 'אריזה', 'קרטון', 'משטח', 'צינור', 'גליל'];
  var STATUSES = [
    { value: 'draft', label: 'טיוטה', color: '#999' },
    { value: 'sent', label: 'נשלח ללקוח', color: '#1565c0' },
    { value: 'approved', label: 'מאושר', color: '#2e7d32' },
    { value: 'in_progress', label: 'בביצוע', color: '#ef6c00' },
    { value: 'completed', label: 'הושלם', color: '#4caf50' },
  ];
  var VAT_RATE = 0.17;

  function saveProjects(projects) {
    if (typeof DB !== 'undefined') DB.save('shorashim-maintenance', projects);
    else localStorage.setItem('shorashim-maintenance', JSON.stringify(projects));
  }
  function loadProjects() {
    return new Promise(function(resolve) {
      if (typeof DB !== 'undefined') { DB.loadAsync('shorashim-maintenance').then(function(d) { resolve(d || []); }); }
      else { try { resolve(JSON.parse(localStorage.getItem('shorashim-maintenance') || '[]')); } catch(e) { resolve([]); } }
    });
  }
  function isAdmin() { return window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'manager'); }
  function fmt(n) { return n.toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

  function calcProject(p) {
    var mt = 0; (p.materials || []).forEach(function(m) { mt += (m.quantity || 0) * (m.unitPrice || 0); });
    var lt = 0; (p.labor || []).forEach(function(l) { lt += (l.hours || 0) * (l.hourlyRate || 0); });
    var sub = mt + lt, mkp = sub * ((p.markup || 0) / 100), bv = sub + mkp;
    var vat = p.includeVat ? bv * VAT_RATE : 0;
    return { materialsTotal: mt, laborTotal: lt, subtotal: sub, markup: mkp, beforeVat: bv, vat: vat, total: bv + vat };
  }

  var inputS = 'width:100%;padding:8px 12px;border-radius:8px;border:1px solid #ddd;font-family:inherit;';
  var lblS = 'font-size:0.8rem;color:#666;';
  var modalBg = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
  var modalCard = 'background:white;border-radius:16px;padding:20px;width:92%;max-width:';
  var btnSave = 'flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;';
  var btnCancel = 'flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;';

  // ── PROJECTS LIST ──
  function showProjectsList() {
    if (!isAdmin()) { if (typeof showToast === 'function') showToast('⛔ אין הרשאה'); return; }
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '600px;max-height:85vh;overflow-y:auto;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
        '<h3 style="font-weight:700;margin:0;">🔧 תחזוקה — פרויקטים</h3>' +
        '<button onclick="Maintenance.showNewProject()" style="padding:6px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕ חדש</button>' +
      '</div><div id="maintList" style="color:#999;text-align:center;padding:16px;">טוען...</div>' +
      '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">סגור</button>' +
    '</div></div>';
    loadProjects().then(function(projects) {
      var el = document.getElementById('maintList'); if (!el) return;
      if (!projects.length) { el.innerHTML = '<div style="padding:24px;text-align:center;color:#999;">🔧 אין פרויקטים — לחץ ➕</div>'; return; }
      projects.sort(function(a, b) { return (b.updated || b.created || 0) - (a.updated || a.created || 0); });
      var h = '';
      projects.forEach(function(p) {
        var st = STATUSES.find(function(s) { return s.value === p.status; }) || STATUSES[0];
        var tot = calcProject(p);
        h += '<div onclick="Maintenance.showDetail(' + p.id + ')" style="background:#f5f7f5;border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;border-right:4px solid ' + st.color + ';">';
        h += '<div style="display:flex;justify-content:space-between;align-items:center;"><div style="font-weight:700;">' + p.name + '</div>';
        h += '<span style="font-size:0.72rem;padding:3px 8px;border-radius:6px;background:' + st.color + '22;color:' + st.color + ';font-weight:600;">' + st.label + '</span></div>';
        if (p.client) h += '<div style="font-size:0.8rem;color:#666;margin-top:2px;">👤 ' + p.client + '</div>';
        h += '<div style="display:flex;justify-content:space-between;margin-top:6px;font-size:0.78rem;color:#999;"><span>📦 ' + (p.materials || []).length + ' חומרים</span><span style="font-weight:700;color:#1b5e20;">₪' + fmt(tot.total) + '</span></div></div>';
      });
      el.innerHTML = h;
    });
  }

  // ── NEW/EDIT PROJECT ──
  function showNewProject(existingId) {
    loadProjects().then(function(projects) {
      var p = existingId ? projects.find(function(x) { return x.id === existingId; }) : null;
      if (!p) p = { name: '', client: '', description: '', status: 'draft', markup: 15, includeVat: true };
      var sOpts = ''; STATUSES.forEach(function(s) { sOpts += '<option value="' + s.value + '"' + (p.status === s.value ? ' selected' : '') + '>' + s.label + '</option>'; });
      var modal = document.getElementById('modalContainer');
      modal.innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '450px;max-height:85vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:14px;">🔧 ' + (existingId ? 'עריכת פרויקט' : 'פרויקט חדש') + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">שם הפרויקט *</label><input id="mpName" value="' + (p.name || '') + '" placeholder="למשל: תחזוקת משרד" style="' + inputS + '"></div>' +
        '<div><label style="' + lblS + '">לקוח</label><input id="mpClient" value="' + (p.client || '') + '" style="' + inputS + '"></div>' +
        '<div><label style="' + lblS + '">תיאור</label><textarea id="mpDesc" rows="2" style="' + inputS + 'resize:vertical;">' + (p.description || '') + '</textarea></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">סטטוס</label><select id="mpStatus" style="' + inputS + '">' + sOpts + '</select></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">תוספת %</label><input id="mpMarkup" type="number" value="' + (p.markup || 0) + '" min="0" max="100" style="' + inputS + '"></div></div>' +
        '<label style="display:flex;align-items:center;gap:8px;font-size:0.88rem;cursor:pointer;"><input type="checkbox" id="mpVat"' + (p.includeVat !== false ? ' checked' : '') + ' style="width:18px;height:18px;accent-color:#2e7d32;"> כולל מע"מ (17%)</label>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveProject(' + (existingId || 0) + ')" style="' + btnSave + '">💾 שמור</button>' +
        '<button onclick="' + (existingId ? 'Maintenance.showDetail(' + existingId + ')' : 'Maintenance.showProjectsList()') + '" style="' + btnCancel + '">ביטול</button></div>' +
        '</div></div></div>';
    });
  }

  function _saveProject(eid) {
    var name = document.getElementById('mpName').value.trim();
    if (!name) { if (typeof showToast === 'function') showToast('❌ חובה למלא שם'); return; }
    loadProjects().then(function(projects) {
      var p = eid ? projects.find(function(x) { return x.id === eid; }) : null;
      if (!p) { p = { id: Date.now(), materials: [], labor: [], shipments: [], created: Date.now() }; projects.push(p); }
      p.name = name; p.client = document.getElementById('mpClient').value.trim();
      p.description = document.getElementById('mpDesc').value.trim(); p.status = document.getElementById('mpStatus').value;
      p.markup = parseFloat(document.getElementById('mpMarkup').value) || 0; p.includeVat = document.getElementById('mpVat').checked;
      p.updated = Date.now(); saveProjects(projects);
      if (typeof showToast === 'function') showToast('✅ נשמר'); showDetail(p.id);
    });
  }

  // ── PROJECT DETAIL ──
  function showDetail(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var tot = calcProject(p);
      var st = STATUSES.find(function(s) { return s.value === p.status; }) || STATUSES[0];

      var matH = ''; (p.materials || []).forEach(function(m, i) {
        var lt = (m.quantity || 0) * (m.unitPrice || 0);
        matH += '<tr><td style="padding:6px 8px;font-weight:600;">' + m.name + '</td><td style="padding:6px 8px;text-align:center;">' + m.quantity + ' ' + (m.unit || '') + '</td><td style="padding:6px 8px;text-align:center;">₪' + fmt(m.unitPrice) + '</td><td style="padding:6px 8px;text-align:center;font-weight:700;">₪' + fmt(lt) + '</td><td style="padding:6px 4px;text-align:center;"><button onclick="Maintenance._editMat(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">✏️</button><button onclick="Maintenance._delMat(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">🗑️</button></td></tr>';
      });

      var labH = ''; (p.labor || []).forEach(function(l, i) {
        var lt = (l.hours || 0) * (l.hourlyRate || 0);
        labH += '<tr><td style="padding:6px 8px;font-weight:600;">' + l.description + '</td><td style="padding:6px 8px;text-align:center;">' + l.hours + '</td><td style="padding:6px 8px;text-align:center;">₪' + fmt(l.hourlyRate) + '</td><td style="padding:6px 8px;text-align:center;font-weight:700;">₪' + fmt(lt) + '</td><td style="padding:6px 4px;text-align:center;"><button onclick="Maintenance._editLab(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">✏️</button><button onclick="Maintenance._delLab(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">🗑️</button></td></tr>';
      });

      var shipH = ''; (p.shipments || []).forEach(function(s, i) {
        shipH += '<div style="background:#f5f7f5;border-radius:8px;padding:8px 10px;margin-bottom:6px;font-size:0.82rem;display:flex;justify-content:space-between;align-items:center;"><div><strong>' + s.date + '</strong> — ' + s.materialName + ' (' + s.quantity + ')' + (s.supplier ? ' · ' + s.supplier : '') + (s.notes ? ' · <span style="color:#999;">' + s.notes + '</span>' : '') + '</div><button onclick="Maintenance._delShip(' + pid + ',' + i + ')" style="border:none;background:none;cursor:pointer;">🗑️</button></div>';
      });

      var addBtn = function(label, fn) { return '<button onclick="Maintenance.' + fn + '(' + pid + ')" style="font-size:0.75rem;padding:4px 10px;border-radius:6px;border:1px solid #4caf50;background:transparent;color:#4caf50;font-family:inherit;font-weight:600;cursor:pointer;">➕ ' + label + '</button>'; };
      var sectTitle = function(icon, text) { return '<div style="font-size:0.75rem;font-weight:700;color:#1b5e20;text-transform:uppercase;letter-spacing:1px;">' + icon + ' ' + text + '</div>'; };

      var tblWrap = function(head, body, footLabel, footVal, color) {
        return '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;"><thead><tr style="background:' + color + '22;">' + head + '</tr></thead><tbody>' + body + '</tbody><tfoot><tr style="border-top:2px solid ' + color + ';"><td colspan="3" style="padding:8px;font-weight:700;text-align:left;">' + footLabel + '</td><td style="padding:8px;text-align:center;font-weight:700;color:' + color + ';">₪' + footVal + '</td><td></td></tr></tfoot></table></div>';
      };

      var thS = 'padding:8px;text-align:center;font-weight:700;font-size:0.78rem;';
      var modal = document.getElementById('modalContainer');
      modal.innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '700px;max-height:90vh;overflow-y:auto;">' +

        '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;"><div>' +
          '<h3 style="font-weight:700;margin:0 0 4px;">🔧 ' + p.name + '</h3>' +
          (p.client ? '<div style="font-size:0.82rem;color:#666;">👤 ' + p.client + '</div>' : '') +
          (p.description ? '<div style="font-size:0.78rem;color:#999;margin-top:2px;">' + p.description + '</div>' : '') +
        '</div><span style="font-size:0.72rem;padding:4px 10px;border-radius:6px;background:' + st.color + '22;color:' + st.color + ';font-weight:600;white-space:nowrap;">' + st.label + '</span></div>' +

        // Materials
        '<div style="margin-bottom:18px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('📦', 'חומרים') + addBtn('הוסף', '_addMat') + '</div>' +
        (!(p.materials || []).length ? '<div style="text-align:center;color:#999;padding:12px;">אין חומרים</div>' :
          tblWrap('<th style="' + thS + 'text-align:right;">חומר</th><th style="' + thS + '">כמות</th><th style="' + thS + '">מחיר ליח\'</th><th style="' + thS + '">סה"כ</th><th style="' + thS + 'width:60px;"></th>',
            matH, 'סה"כ חומרים', fmt(tot.materialsTotal), '#2e7d32')) + '</div>' +

        // Labor
        '<div style="margin-bottom:18px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('👷', 'עבודה') + addBtn('הוסף', '_addLab') + '</div>' +
        (!(p.labor || []).length ? '<div style="text-align:center;color:#999;padding:8px;">אין פריטי עבודה</div>' :
          tblWrap('<th style="' + thS + 'text-align:right;">תיאור</th><th style="' + thS + '">שעות</th><th style="' + thS + '">₪/שעה</th><th style="' + thS + '">סה"כ</th><th style="' + thS + 'width:60px;"></th>',
            labH, 'סה"כ עבודה', fmt(tot.laborTotal), '#ef6c00')) + '</div>' +

        // Summary
        '<div style="background:#f5f7f5;border-radius:12px;padding:14px;margin-bottom:18px;">' + sectTitle('💰', 'סיכום עלויות') +
        '<div style="display:grid;gap:4px;font-size:0.88rem;margin-top:8px;">' +
          '<div style="display:flex;justify-content:space-between;"><span>חומרים</span><span>₪' + fmt(tot.materialsTotal) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;"><span>עבודה</span><span>₪' + fmt(tot.laborTotal) + '</span></div>' +
          '<div style="display:flex;justify-content:space-between;border-top:1px solid #ddd;padding-top:4px;"><span>סכום ביניים</span><span>₪' + fmt(tot.subtotal) + '</span></div>' +
          (p.markup ? '<div style="display:flex;justify-content:space-between;"><span>תוספת ' + p.markup + '%</span><span>₪' + fmt(tot.markup) + '</span></div>' : '') +
          '<div style="display:flex;justify-content:space-between;"><span>לפני מע"מ</span><span style="font-weight:600;">₪' + fmt(tot.beforeVat) + '</span></div>' +
          (p.includeVat ? '<div style="display:flex;justify-content:space-between;"><span>מע"מ 17%</span><span>₪' + fmt(tot.vat) + '</span></div>' : '') +
          '<div style="display:flex;justify-content:space-between;font-size:1.1rem;font-weight:800;color:#1b5e20;border-top:2px solid #2e7d32;padding-top:6px;margin-top:4px;"><span>סה"כ</span><span>₪' + fmt(tot.total) + '</span></div>' +
        '</div></div>' +

        // Shipments
        '<div style="margin-bottom:18px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' + sectTitle('🚚', 'יומן משלוחים') + addBtn('הוסף', '_addShip') + '</div>' +
        (!(p.shipments || []).length ? '<div style="text-align:center;color:#999;padding:8px;">אין משלוחים</div>' : shipH) + '</div>' +

        // Actions
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          '<button onclick="Maintenance._quotePDF(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;font-size:0.85rem;">📄 הצעת מחיר</button>' +
          '<button onclick="Maintenance._shipPDF(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#7e57c2;color:white;font-family:inherit;font-weight:700;cursor:pointer;font-size:0.85rem;">🚚 יומן משלוחים</button>' +
          '<button onclick="Maintenance.showNewProject(' + pid + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#ff9800;color:white;font-family:inherit;font-weight:700;cursor:pointer;font-size:0.85rem;">✏️ עריכה</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button onclick="Maintenance._delProj(' + pid + ')" style="padding:10px 16px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button>' +
          '<button onclick="Maintenance.showProjectsList()" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">חזרה לרשימה</button>' +
        '</div></div></div>';
    });
  }

  // ── MATERIAL CRUD ──
  function _addMat(pid, idx) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var m = (idx >= 0) ? p.materials[idx] : { name: '', quantity: 1, unit: "יח'", unitPrice: 0, supplier: '' };
      var uOpts = UNITS.map(function(u) { return '<option' + (m.unit === u ? ' selected' : '') + '>' + u + '</option>'; }).join('');
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">📦 ' + (idx >= 0 ? 'עריכת חומר' : 'הוספת חומר') + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">שם החומר *</label><input id="mmN" value="' + (m.name || '') + '" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">כמות</label><input id="mmQ" type="number" value="' + (m.quantity || 1) + '" min="0" step="0.1" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">יחידה</label><select id="mmU" style="' + inputS + '">' + uOpts + '</select></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">מחיר ₪</label><input id="mmP" type="number" value="' + (m.unitPrice || 0) + '" min="0" step="0.01" style="' + inputS + '"></div></div>' +
        '<div><label style="' + lblS + '">ספק</label><input id="mmS" value="' + (m.supplier || '') + '" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveMat(' + pid + ',' + (idx >= 0 ? idx : -1) + ')" style="' + btnSave + '">💾 שמור</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ')" style="' + btnCancel + '">ביטול</button></div></div></div></div>';
    });
  }
  function _saveMat(pid, idx) {
    var n = document.getElementById('mmN').value.trim(); if (!n) { showToast('❌ חובה שם'); return; }
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var m = { name: n, quantity: parseFloat(document.getElementById('mmQ').value) || 0, unit: document.getElementById('mmU').value, unitPrice: parseFloat(document.getElementById('mmP').value) || 0, supplier: document.getElementById('mmS').value.trim() };
      if (idx >= 0) p.materials[idx] = m; else { if (!p.materials) p.materials = []; p.materials.push(m); }
      p.updated = Date.now(); saveProjects(projects); showDetail(pid);
    });
  }
  function _editMat(pid, i) { _addMat(pid, i); }
  function _delMat(pid, i) { if (!confirm('למחוק חומר?')) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.materials.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid); }); }

  // ── LABOR CRUD ──
  function _addLab(pid, idx) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var l = (idx >= 0) ? p.labor[idx] : { description: '', hours: 1, hourlyRate: 50 };
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">👷 ' + (idx >= 0 ? 'עריכת עבודה' : 'הוספת עבודה') + '</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">תיאור *</label><input id="mlD" value="' + (l.description || '') + '" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">שעות</label><input id="mlH" type="number" value="' + (l.hours || 1) + '" min="0" step="0.5" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">₪/שעה</label><input id="mlR" type="number" value="' + (l.hourlyRate || 50) + '" min="0" style="' + inputS + '"></div></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveLab(' + pid + ',' + (idx >= 0 ? idx : -1) + ')" style="' + btnSave + '">💾 שמור</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ')" style="' + btnCancel + '">ביטול</button></div></div></div></div>';
    });
  }
  function _saveLab(pid, idx) {
    var d = document.getElementById('mlD').value.trim(); if (!d) { showToast('❌ חובה תיאור'); return; }
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return;
      var l = { description: d, hours: parseFloat(document.getElementById('mlH').value) || 0, hourlyRate: parseFloat(document.getElementById('mlR').value) || 0 };
      if (idx >= 0) p.labor[idx] = l; else { if (!p.labor) p.labor = []; p.labor.push(l); }
      p.updated = Date.now(); saveProjects(ps); showDetail(pid);
    });
  }
  function _editLab(pid, i) { _addLab(pid, i); }
  function _delLab(pid, i) { if (!confirm('למחוק?')) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.labor.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid); }); }

  // ── SHIPMENT CRUD ──
  function _addShip(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var mOpts = '<option value="">— בחר חומר —</option>'; (p.materials || []).forEach(function(m) { mOpts += '<option>' + m.name + '</option>'; });
      var today = new Date().toISOString().slice(0, 10);
      document.getElementById('modalContainer').innerHTML = '<div style="' + modalBg + '"><div style="' + modalCard + '400px;">' +
        '<h3 style="font-weight:700;margin-bottom:12px;">🚚 רישום משלוח</h3><div style="display:grid;gap:10px;">' +
        '<div><label style="' + lblS + '">תאריך</label><input id="msD" type="date" value="' + today + '" style="' + inputS + '"></div>' +
        '<div><label style="' + lblS + '">חומר</label><select id="msM" style="' + inputS + '">' + mOpts + '</select></div>' +
        '<div style="display:flex;gap:8px;"><div style="flex:1;"><label style="' + lblS + '">כמות</label><input id="msQ" type="number" value="1" min="0" step="0.1" style="' + inputS + '"></div>' +
        '<div style="flex:1;"><label style="' + lblS + '">ספק</label><input id="msSup" style="' + inputS + '"></div></div>' +
        '<div><label style="' + lblS + '">הערות</label><input id="msN" style="' + inputS + '"></div>' +
        '<div style="display:flex;gap:8px;"><button onclick="Maintenance._saveShip(' + pid + ')" style="' + btnSave + '">💾 שמור</button>' +
        '<button onclick="Maintenance.showDetail(' + pid + ')" style="' + btnCancel + '">ביטול</button></div></div></div></div>';
    });
  }
  function _saveShip(pid) {
    loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return;
      if (!p.shipments) p.shipments = [];
      p.shipments.push({ date: document.getElementById('msD').value, materialName: document.getElementById('msM').value || 'כללי', quantity: parseFloat(document.getElementById('msQ').value) || 0, supplier: document.getElementById('msSup').value.trim(), notes: document.getElementById('msN').value.trim() });
      p.updated = Date.now(); saveProjects(ps); showDetail(pid);
    });
  }
  function _delShip(pid, i) { if (!confirm('למחוק?')) return; loadProjects().then(function(ps) { var p = ps.find(function(x) { return x.id === pid; }); if (!p) return; p.shipments.splice(i, 1); p.updated = Date.now(); saveProjects(ps); showDetail(pid); }); }
  function _delProj(pid) { if (!confirm('למחוק פרויקט שלם?')) return; loadProjects().then(function(ps) { saveProjects(ps.filter(function(x) { return x.id !== pid; })); showToast('🗑️ נמחק'); showProjectsList(); }); }

  // ── PDF EXPORT: QUOTE ──
  function _quotePDF(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p) return;
      var tot = calcProject(p); var today = new Date().toLocaleDateString('he-IL');
      var matR = ''; (p.materials || []).forEach(function(m, i) { var lt = (m.quantity||0)*(m.unitPrice||0); matR += '<tr><td>' + (i+1) + '</td><td>' + m.name + '</td><td>' + m.quantity + ' ' + (m.unit||'') + '</td><td>₪' + fmt(m.unitPrice) + '</td><td style="font-weight:700;">₪' + fmt(lt) + '</td></tr>'; });
      var labR = ''; (p.labor || []).forEach(function(l, i) { var lt = (l.hours||0)*(l.hourlyRate||0); labR += '<tr><td>' + (i+1) + '</td><td>' + l.description + '</td><td>' + l.hours + ' שעות</td><td>₪' + fmt(l.hourlyRate) + '</td><td style="font-weight:700;">₪' + fmt(lt) + '</td></tr>'; });

      var css = '@page{margin:15mm}body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;color:#222;direction:rtl;line-height:1.6;margin:0}.header{background:linear-gradient(135deg,#1a5632,#2d6a4f);color:white;padding:28px 32px;border-radius:0 0 16px 16px;margin-bottom:24px}.header h1{font-size:1.4rem;margin:0 0 4px}.header .meta{font-size:.85rem;opacity:.85}.content{padding:0 24px}.section{font-size:.78rem;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:.05em;margin:20px 0 8px;padding-bottom:4px;border-bottom:2px solid #d8f3dc}table{width:100%;border-collapse:collapse;font-size:.85rem;margin-bottom:16px}th{background:#e8f5e9;padding:8px 10px;text-align:right;font-weight:700;font-size:.78rem}td{padding:8px 10px;border-bottom:1px solid #eee}tfoot td{border-top:2px solid #2e7d32;font-weight:700}.summary{background:#f5f7f5;border-radius:12px;padding:16px;margin:20px 0}.sr{display:flex;justify-content:space-between;padding:4px 0;font-size:.9rem}.st{font-size:1.2rem;font-weight:800;color:#1b5e20;border-top:2px solid #2e7d32;padding-top:8px;margin-top:8px}.footer{text-align:center;padding:20px;margin-top:24px;font-size:.78rem;color:#888;border-top:1px solid #eee}';

      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>הצעת מחיר — ' + p.name + '</title><style>' + css + '</style></head><body>' +
        '<div class="header"><h1>🔧 הצעת מחיר</h1><div class="meta">' + p.name + (p.client ? ' · לכבוד: ' + p.client : '') + ' · ' + today + '</div></div><div class="content">' +
        (p.description ? '<div style="font-size:.88rem;color:#555;margin-bottom:14px;">' + p.description + '</div>' : '') +
        ((p.materials||[]).length ? '<div class="section">📦 חומרים</div><table><thead><tr><th>#</th><th>חומר</th><th>כמות</th><th>מחיר ליח\'</th><th>סה"כ</th></tr></thead><tbody>' + matR + '</tbody><tfoot><tr><td colspan="4">סה"כ חומרים</td><td>₪' + fmt(tot.materialsTotal) + '</td></tr></tfoot></table>' : '') +
        ((p.labor||[]).length ? '<div class="section">👷 עבודה</div><table><thead><tr><th>#</th><th>תיאור</th><th>כמות</th><th>מחיר</th><th>סה"כ</th></tr></thead><tbody>' + labR + '</tbody><tfoot><tr><td colspan="4">סה"כ עבודה</td><td>₪' + fmt(tot.laborTotal) + '</td></tr></tfoot></table>' : '') +
        '<div class="summary"><div style="font-weight:700;margin-bottom:8px;">💰 סיכום</div>' +
          '<div class="sr"><span>חומרים</span><span>₪' + fmt(tot.materialsTotal) + '</span></div>' +
          '<div class="sr"><span>עבודה</span><span>₪' + fmt(tot.laborTotal) + '</span></div>' +
          (p.markup ? '<div class="sr"><span>תוספת ' + p.markup + '%</span><span>₪' + fmt(tot.markup) + '</span></div>' : '') +
          '<div class="sr"><span>לפני מע"מ</span><span>₪' + fmt(tot.beforeVat) + '</span></div>' +
          (p.includeVat ? '<div class="sr"><span>מע"מ 17%</span><span>₪' + fmt(tot.vat) + '</span></div>' : '') +
          '<div class="sr st"><span>סה"כ לתשלום</span><span>₪' + fmt(tot.total) + '</span></div></div>' +
        '<div style="font-size:.82rem;color:#666;margin-top:16px;"><strong>תנאים:</strong> הצעה תקפה ל-30 יום. מחירים אינם כוללים שינויים שלא סוכמו מראש.</div>' +
        '</div><div class="footer"><span style="color:#2d6a4f;font-weight:700;">🌿 שורשים פלוס</span> · הצעת מחיר · ' + today + '</div></body></html>';

      var blob = new Blob([html], { type: 'text/html;charset=utf-8' }); var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'quote-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.html';
      a.click(); URL.revokeObjectURL(a.href); showToast('📄 הצעת מחיר הורדה');
    });
  }

  // ── PDF EXPORT: SHIPMENT LOG ──
  function _shipPDF(pid) {
    loadProjects().then(function(projects) {
      var p = projects.find(function(x) { return x.id === pid; }); if (!p || !(p.shipments||[]).length) { showToast('📦 אין משלוחים'); return; }
      var today = new Date().toLocaleDateString('he-IL');
      var rows = ''; p.shipments.forEach(function(s, i) { rows += '<tr><td>' + (i+1) + '</td><td>' + s.date + '</td><td>' + s.materialName + '</td><td>' + s.quantity + '</td><td>' + (s.supplier||'—') + '</td><td>' + (s.notes||'—') + '</td></tr>'; });
      var html = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>יומן משלוחים — ' + p.name + '</title><style>@page{margin:15mm}body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;color:#222;direction:rtl;line-height:1.6;margin:0}.header{background:linear-gradient(135deg,#4a148c,#7e57c2);color:white;padding:28px 32px;border-radius:0 0 16px 16px;margin-bottom:24px}.header h1{font-size:1.4rem;margin:0 0 4px}.header .meta{font-size:.85rem;opacity:.85}.content{padding:0 24px}table{width:100%;border-collapse:collapse;font-size:.85rem}th{background:#ede7f6;padding:8px 10px;text-align:right;font-weight:700;font-size:.78rem}td{padding:8px 10px;border-bottom:1px solid #eee}tr:nth-child(even) td{background:#fafafa}.footer{text-align:center;padding:20px;margin-top:24px;font-size:.78rem;color:#888;border-top:1px solid #eee}</style></head><body>' +
        '<div class="header"><h1>🚚 יומן משלוחים</h1><div class="meta">' + p.name + (p.client ? ' · ' + p.client : '') + ' · ' + today + '</div></div>' +
        '<div class="content"><table><thead><tr><th>#</th><th>תאריך</th><th>חומר</th><th>כמות</th><th>ספק</th><th>הערות</th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="footer"><span style="color:#7e57c2;font-weight:700;">🌿 שורשים פלוס</span> · יומן משלוחים · ' + today + '</div></body></html>';
      var blob = new Blob([html], { type: 'text/html;charset=utf-8' }); var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'shipments-' + p.name.replace(/\s+/g, '-') + '-' + new Date().toISOString().slice(0,10) + '.html';
      a.click(); URL.revokeObjectURL(a.href); showToast('🚚 יומן הורד');
    });
  }

  return {
    showProjectsList: showProjectsList, showDetail: showDetail, showNewProject: showNewProject,
    _saveProject: _saveProject, _addMat: _addMat, _saveMat: _saveMat, _editMat: _editMat, _delMat: _delMat,
    _addLab: _addLab, _saveLab: _saveLab, _editLab: _editLab, _delLab: _delLab,
    _addShip: _addShip, _saveShip: _saveShip, _delShip: _delShip, _delProj: _delProj,
    _quotePDF: _quotePDF, _shipPDF: _shipPDF,
  };
})();
