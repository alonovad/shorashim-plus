/* worklogedit.js — עריכת יומן העבודה והיסטוריה (work log editor)
 * ------------------------------------------------------------------
 * The work log was write-once: an entry with a wrong date, the wrong plot
 * or a mistyped hour count stayed wrong, and only the latest 20 could be
 * seen. This adds:
 *
 *   EDIT     every field of any entry, old ones included, from the tab's
 *            list, from a plot's full history, or from the browser below.
 *   HISTORY  each saved edit is kept ON the entry (entry.revisions): when,
 *            who, and every field's old and new value — a work log is a
 *            record people rely on, and a silent change undermines it.
 *            The app's audit log gets the same.
 *   DELETE   with confirmation, and an undo bar for a few seconds after.
 *   BROWSE   the whole log, filtered by farm, plot, action, date range or
 *            free text, with totals for what is shown.
 *
 * Who may edit: admins and operators any entry; anyone else their own.
 * An entry already sent to its Google Sheet is edited here but NOT in the
 * sheet (the sheet only appends); it is marked as out of step with it.
 *
 * The data stays app.js's: entries live in its `worklogEntries` and are
 * stored by its saveData(). This module reads its lists (farms, plots,
 * actions, budget categories, worker groups) and never keeps its own copy.
 */
var WorklogEdit = (function () {
  'use strict';

  var PAGE = 50;
  var B = null;          // browser state
  var undoTimer = null;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function tr(he) { return (typeof t === 'function') ? t(he) : he; }   // app.js's dictionary, for its own list items
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function entries() { return (typeof worklogEntries !== 'undefined' && Array.isArray(worklogEntries)) ? worklogEntries : []; }
  function me() { return (typeof currentUser !== 'undefined' && currentUser) ? currentUser : {}; }
  function save() { if (typeof saveData === 'function') saveData(); }
  function audit(action, id, opts) { try { if (window.Audit && Audit.log) Audit.log(action, 'worklog', String(id), opts || {}); } catch (e) {} }
  function byId(id) { var n = Number(id); return entries().filter(function (e) { return e.id === n || String(e.id) === String(id); })[0] || null; }
  function canEdit(e) {
    var u = me();
    if (u.role === 'admin' || u.role === 'operator') return true;
    if (!e) return false;
    return (u.email && e.operator_email && u.email.toLowerCase() === String(e.operator_email).toLowerCase()) ||
           (u.name && e.operator === u.name);
  }
  function userFarms() {
    try { return (typeof getUserFarms === 'function') ? (getUserFarms(me()) || []) : []; } catch (e) { return []; }
  }
  function farmName(f) { return (typeof locName === 'function') ? locName(f) : (f && f.name) || ''; }
  function list(name) { return (typeof window[name] !== 'undefined' && Array.isArray(window[name])) ? window[name] : []; }
  function fieldLabel(f) {
    return {
      date: tt('תאריך', 'วันที่', 'التاريخ'), farm_id: tt('משק', 'ฟาร์ม', 'المزرعة'), plot_id: tt('חלקה', 'แปลง', 'القطعة'),
      type: tt('פעולה', 'งาน', 'العمل'), budget_category: tt('סעיף תקציבי', 'หมวดงบ', 'بند الميزانية'),
      worker_group: tt('קבוצת עובדים', 'กลุ่มคนงาน', 'مجموعة العمال'), worker_count: tt('מספר עובדים', 'จำนวนคนงาน', 'عدد العمال'),
      hours: tt('שעות', 'ชั่วโมง', 'ساعات'), trees_completed: tt('עצים שבוצעו', 'ต้นที่เสร็จ', 'الأشجار المنجزة'),
      quantity: tt('כמות (תפוקה)', 'ปริมาณ (ผลผลิต)', 'الكمية (الإنتاج)'), quantity_unit: tt('יחידה', 'หน่วย', 'الوحدة'),
      workers: tt('שמות עובדים', 'ชื่อคนงาน', 'أسماء العمال'), notes: tt('הערות', 'หมายเหตุ', 'ملاحظات')
    }[f] || f;
  }
  // a field's value as a person reads it in the history
  function shown(f, v) {
    if (v == null || v === '') return '\u2014';
    if (f === 'farm_id') { var fm = (typeof farms !== 'undefined' ? farms : []).filter(function (x) { return x.id === v; })[0]; return fm ? farmName(fm) : String(v); }
    if (f === 'quantity_unit') return tr(String(v));
    if (f === 'plot_id') { var pl = (typeof plots !== 'undefined' ? plots : []).filter(function (x) { return x.id === v; })[0]; return pl ? pl.name : String(v); }
    return String(v);
  }
  function dayOf(date) {
    var d = new Date(date);
    if (isNaN(d.getTime())) return '';
    return [tt('יום א\'', 'อาทิตย์', 'الأحد'), tt('יום ב\'', 'จันทร์', 'الاثنين'), tt('יום ג\'', 'อังคาร', 'الثلاثاء'),
            tt('יום ד\'', 'พุธ', 'الأربعاء'), tt('יום ה\'', 'พฤหัส', 'الخميس'), tt('יום ו\'', 'ศุกร์', 'الجمعة'),
            tt('שבת', 'เสาร์', 'السبت')][d.getDay()];
  }
  function closeModal() { var c = document.getElementById('modalContainer'); if (c) c.innerHTML = ''; }
  // every place that shows the log, after a change
  function refreshViews() {
    try { if (typeof renderWorklogHistory === 'function') renderWorklogHistory(); } catch (e) {}
    try {
      var sum = document.getElementById('wlViewSummary');
      if (sum && sum.style.display !== 'none' && typeof renderWorklogChart === 'function') renderWorklogChart('type');
    } catch (e) {}
  }

  // ── the edit form ───────────────────────────────────────────────────
  var EDIT_FIELDS = ['date', 'farm_id', 'plot_id', 'type', 'budget_category', 'worker_group', 'worker_count', 'hours', 'trees_completed', 'quantity', 'quantity_unit', 'workers', 'notes'];
  var back = null;     // where to return after saving: 'browse' | {plot, name} | null

  function opt(v, label, sel) { return '<option value="' + esc(v) + '"' + (sel ? ' selected' : '') + '>' + esc(label) + '</option>'; }
  function plotOptions(farmId, sel) {
    var ps = (typeof plots !== 'undefined' ? plots : []).filter(function (p) { return !farmId || p.farm_id === farmId; });
    return opt('', tt('— כל המשק —', '— ทั้งฟาร์ม —', '— المزرعة كلها —'), !sel) +
      ps.map(function (p) { return opt(p.id, p.name, p.id === sel); }).join('');
  }
  function edit(id, from) {
    var e = byId(id);
    if (!e) { toast('\u26a0\ufe0f ' + tt('הרשומה לא נמצאה', 'ไม่พบรายการ', 'السجل غير موجود')); return; }
    if (!canEdit(e)) { toast('\u26d4 ' + tt('אפשר לערוך רק רשומות שלך', 'แก้ได้เฉพาะของคุณ', 'يمكنك تعديل سجلاتك فقط')); return; }
    back = from || null;
    var fs = userFarms();
    if (e.farm_id && !fs.some(function (f) { return f.id === e.farm_id; })) {
      var ef = (typeof farms !== 'undefined' ? farms : []).filter(function (f) { return f.id === e.farm_id; })[0];
      if (ef) fs = fs.concat([ef]);
    }
    var acts = list('WL_ACTIONS').slice(); if (e.type && acts.indexOf(e.type) < 0) acts.unshift(e.type);
    var cats = list('WL_BUDGET_CATEGORIES').slice(); if (e.budget_category && cats.indexOf(e.budget_category) < 0) cats.unshift(e.budget_category);
    var grps = list('WL_WORKER_GROUPS').slice(); if (e.worker_group && grps.indexOf(e.worker_group) < 0) grps.unshift(e.worker_group);
    var units = list('WL_QTY_UNITS').slice(); if (e.quantity_unit && units.indexOf(e.quantity_unit) < 0) units.unshift(e.quantity_unit);
    var unitSel = e.quantity_unit || units[0];
    var row = function (label, inner) { return '<div class="form-group"><label class="form-label">' + label + '</label>' + inner + '</div>'; };
    var two = function (a, b) { return '<div style="display:flex;gap:10px;"><div style="flex:1;">' + a + '</div><div style="flex:1;">' + b + '</div></div>'; };
    var revs = Array.isArray(e.revisions) ? e.revisions : [];
    var html = '<div class="modal-overlay" onclick="if(event.target===this)WorklogEdit.close()">' +
      '<div class="modal" style="max-width:520px;max-height:90vh;overflow-y:auto;">' +
        '<h2>\u270e ' + tt('עריכת רשומה ביומן', 'แก้ไขรายการ', 'تعديل السجل') + '</h2>' +
        '<div style="font-size:.76rem;color:var(--text-muted);margin:-4px 0 10px;">' +
          tt('נרשם על ידי', 'บันทึกโดย', 'سجّله') + ' ' + esc(e.operator || '\u2014') +
          (e.created_at ? ' \u00b7 ' + esc(String(e.created_at).slice(0, 16).replace('T', ' ')) : '') + '</div>' +
        (e.synced_to_sheet
          ? '<div style="font-size:.78rem;background:#fff3e0;color:#8a4b00;border-radius:8px;padding:8px 10px;margin-bottom:10px;">\u26a0\ufe0f ' +
              tt('הרשומה כבר נשלחה לגיליון Google. השינוי יישמר כאן בלבד — בגיליון יש לעדכן ידנית.',
                 'รายการนี้ถูกส่งไปยัง Google Sheet แล้ว การแก้ไขจะบันทึกที่นี่เท่านั้น',
                 'أُرسل السجل إلى Google Sheet. التعديل يُحفظ هنا فقط.') + '</div>'
          : '') +
        two(row(fieldLabel('date'), '<input type="date" class="form-input" id="weDate" value="' + esc(e.date || '') + '">'),
            row(fieldLabel('type'), '<select class="form-input" id="weType">' + acts.map(function (a) { return opt(a, a, a === e.type); }).join('') + '</select>')) +
        two(row(fieldLabel('farm_id'), '<select class="form-input" id="weFarm" onchange="WorklogEdit._farm(this.value)">' +
              fs.map(function (f) { return opt(f.id, farmName(f), f.id === e.farm_id); }).join('') + '</select>'),
            row(fieldLabel('plot_id'), '<select class="form-input" id="wePlot">' + plotOptions(e.farm_id, e.plot_id) + '</select>')) +
        two(row(fieldLabel('budget_category'), '<select class="form-input" id="weBudget">' + opt('', '\u2014', !e.budget_category) +
              cats.map(function (c) { return opt(c, tr(c), c === e.budget_category); }).join('') + '</select>'),
            row(fieldLabel('worker_group'), '<select class="form-input" id="weGroup">' + opt('', '\u2014', !e.worker_group) +
              grps.map(function (g) { return opt(g, tr(g), g === e.worker_group); }).join('') + '</select>')) +
        two(row(fieldLabel('worker_count') + (e.crews && e.crews.length > 1 ? ' <small style="color:var(--text-muted);">(' + tt('הקבוצה הראשית', 'กลุ่มหลัก', 'المجموعة الرئيسية') + ')</small>' : ''),
            '<input type="number" min="1" step="1" class="form-input" id="weCount" value="' + esc(e.crews && e.crews.length > 1 ? (e.crews[0].count || 1) : (e.worker_count || '')) + '">' +
            (e.crews && e.crews.length > 1 ? '<div style="font-size:.72rem;color:var(--text-muted);margin-top:3px;">+ ' + e.crews.slice(1).map(function (c) { return esc(c.count + ' ' + (c.group || '')); }).join(' + ') + '</div>' : '')),
            row(fieldLabel('hours'), '<input type="number" min="0" step="0.25" class="form-input" id="weHours" value="' + esc(e.hours != null ? e.hours : '') + '">')) +
        row(fieldLabel('trees_completed'), '<input type="number" min="0" step="1" class="form-input" id="weTrees" value="' + esc(e.trees_completed != null ? e.trees_completed : '') + '">') +
        two(row(fieldLabel('quantity'), '<input type="number" min="0" step="any" inputmode="decimal" class="form-input" id="weQty" value="' + esc(e.quantity != null ? e.quantity : '') + '">'),
            row(fieldLabel('quantity_unit'), '<select class="form-input" id="weQtyUnit">' + units.map(function (u) { return opt(u, tr(u), u === unitSel); }).join('') + '</select>')) +
        row(fieldLabel('workers'), '<input type="text" class="form-input" id="weWorkers" value="' + esc(e.workers || '') + '" placeholder="' + esc(tt('שמות, מופרדים בפסיק', 'ชื่อ คั่นด้วยจุลภาค', 'أسماء مفصولة بفواصل')) + '">') +
        row(fieldLabel('notes'), '<textarea class="form-input" id="weNotes" rows="3" style="resize:vertical;">' + esc(e.notes || '') + '</textarea>') +
        (revs.length
          ? '<details style="margin:6px 0 12px;"><summary style="cursor:pointer;font-weight:700;font-size:.85rem;">\ud83d\udd58 ' +
              tt('היסטוריית שינויים', 'ประวัติการแก้ไข', 'سجل التغييرات') + ' (' + revs.length + ')</summary>' +
              revs.slice().reverse().map(function (r) {
                return '<div style="font-size:.78rem;border-inline-start:3px solid var(--g5,#81c784);padding:4px 10px;margin-top:8px;">' +
                  '<b>' + esc(String(r.at || '').slice(0, 16).replace('T', ' ')) + '</b> \u00b7 ' + esc(r.by || '') +
                  (r.ch || []).map(function (c) {
                    return '<div>' + esc(fieldLabel(c.f)) + ': <span style="text-decoration:line-through;opacity:.65;">' + esc(shown(c.f, c.from)) +
                      '</span> \u2192 <b>' + esc(shown(c.f, c.to)) + '</b></div>';
                  }).join('') + '</div>';
              }).join('') + '</details>'
          : '') +
        '<div class="modal-buttons">' +
          '<button class="btn btn-primary" onclick="WorklogEdit._save(' + e.id + ')">' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
          '<button class="btn btn-secondary" onclick="WorklogEdit._back()">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
        '<button onclick="WorklogEdit.del(' + e.id + ')" style="width:100%;margin-top:10px;padding:9px;border-radius:10px;border:1px solid #ef9a9a;background:#fff5f5;color:#c62828;font-family:inherit;font-weight:600;cursor:pointer;">\ud83d\uddd1 ' +
          tt('מחק רשומה', 'ลบรายการ', 'احذف السجل') + '</button>' +
      '</div></div>';
    document.getElementById('modalContainer').innerHTML = html;
  }
  function farmChanged(v) {
    var el = document.getElementById('wePlot');
    if (el) el.innerHTML = plotOptions(parseInt(v, 10) || null, null);
  }
  function collect() {
    var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    var int = function (v) { var n = parseInt(v, 10); return isFinite(n) ? n : null; };
    var flt = function (v) { var n = parseFloat(v); return isFinite(n) ? n : null; };
    var qty = flt(g('weQty')); if (qty != null && qty <= 0) qty = null;
    return {
      date: g('weDate'), farm_id: int(g('weFarm')), plot_id: int(g('wePlot')), type: g('weType'),
      budget_category: g('weBudget') || '', worker_group: g('weGroup') || '',
      worker_count: int(g('weCount')) || 1, hours: flt(g('weHours')), trees_completed: int(g('weTrees')),
      quantity: qty, quantity_unit: qty ? (g('weQtyUnit') || null) : null,
      workers: String(g('weWorkers') || '').trim() || null, notes: String(g('weNotes') || '').trim() || null
    };
  }
  function saveEdit(id) {
    var e = byId(id); if (!e || !canEdit(e)) return;
    var v = collect();
    if (!v.date) { toast('\u274c ' + tt('יש לבחור תאריך', 'เลือกวันที่', 'اختر التاريخ')); return; }
    if (!v.farm_id) { toast('\u274c ' + tt('יש לבחור משק', 'เลือกฟาร์ม', 'اختر المزرعة')); return; }
    if (!v.type) { toast('\u274c ' + tt('יש לבחור פעולה', 'เลือกงาน', 'اختر العمل')); return; }
    if (v.quantity != null && v.quantity < 0) { toast('\u274c ' + tt('כמות לא תקינה', 'ปริมาณไม่ถูกต้อง', 'كمية غير صالحة')); return; }
    if (v.hours != null && (v.hours < 0 || v.hours > 24)) { toast('\u274c ' + tt('שעות לא תקינות', 'ชั่วโมงไม่ถูกต้อง', 'ساعات غير صالحة')); return; }
    var ch = [];
    // Several crews: the form edits the main crew; worker_count stays the total.
    if (e.crews && e.crews.length > 1) {
      var rest = e.crews.slice(1).reduce(function (a, c) { return a + (Number(c.count) || 0); }, 0);
      v._mainCount = v.worker_count; v.worker_count = (Number(v.worker_count) || 1) + rest;
    }
    EDIT_FIELDS.forEach(function (f) {
      var before = (e[f] === undefined || e[f] === '') ? null : e[f];
      var after = (v[f] === undefined || v[f] === '') ? null : v[f];
      if (String(before) !== String(after)) ch.push({ f: f, from: before, to: after });
    });
    if (!ch.length) { goBack(); return; }
    var oldType = e.type;
    ch.forEach(function (c) { e[c.f] = c.to == null ? (c.f === 'budget_category' || c.f === 'worker_group' ? '' : null) : c.to; });
    if (e.crews && e.crews.length > 1) { e.crews[0].group = e.worker_group || ''; e.crews[0].count = Number(v._mainCount) || 1; }
    // the derived fields follow
    var fm = (typeof farms !== 'undefined' ? farms : []).filter(function (f) { return f.id === e.farm_id; })[0];
    var pl = (typeof plots !== 'undefined' ? plots : []).filter(function (p) { return p.id === e.plot_id; })[0];
    e.farm_name = fm ? fm.name : (e.farm_name || '');
    e.plot_name = pl ? pl.name : '';
    e.day_of_week = dayOf(e.date) || e.day_of_week || '';
    if (e.type !== oldType) { e.type_label = e.type; if (!e.description || e.description === oldType) e.description = e.type; }
    var u = me(), at = new Date().toISOString();
    e.revisions = (Array.isArray(e.revisions) ? e.revisions : []).concat([{ at: at, by: u.name || u.email || '', ch: ch }]);
    e.edited_at = at;
    e.edited_by = u.name || u.email || '';
    if (e.synced_to_sheet) e.sheet_stale = true;
    save();
    audit('edit', e.id, { changes: ch.map(function (c) { return c.f; }) });
    toast('\u2705 ' + tt('הרשומה עודכנה', 'อัปเดตแล้ว', 'تم التحديث') + ' (' + ch.length + ')');
    refreshViews();
    goBack();
  }
  function goBack() {
    var b = back; back = null;
    if (b === 'browse') { browse(true); return; }
    if (b && b.plot != null && typeof window.showPlotWorklogHistory === 'function') { window.showPlotWorklogHistory(b.plot, b.name || ''); return; }
    closeModal();
  }

  // ── delete, with a moment to change your mind ──────────────────────
  function del(id, from) {
    var e = byId(id); if (!e) return;
    if (!canEdit(e)) { toast('\u26d4 ' + tt('אפשר למחוק רק רשומות שלך', 'ลบได้เฉพาะของคุณ', 'يمكنك حذف سجلاتك فقط')); return; }
    if (!window.confirm(tt('למחוק את הרשומה מ-', 'ลบรายการวันที่ ', 'حذف سجل ') + (e.date || '') + ' (' + (e.type || '') + ')?')) return;
    var arr = entries(), idx = arr.indexOf(e);
    if (idx < 0) return;
    arr.splice(idx, 1);
    save();
    audit('delete', e.id, { snapshot: { date: e.date, type: e.type, farm_id: e.farm_id, plot_id: e.plot_id, hours: e.hours } });
    refreshViews();
    if (from) back = from;
    if (back || (document.getElementById('modalContainer') || {}).innerHTML) goBack();
    undoBar(e, idx);
  }
  function undoBar(e, idx) {
    var old = document.getElementById('weUndo'); if (old) old.remove();
    clearTimeout(undoTimer);
    var bar = document.createElement('div');
    bar.id = 'weUndo';
    bar.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:84px;z-index:3000;background:#263238;color:#fff;' +
      'border-radius:22px;padding:8px 10px 8px 16px;display:flex;gap:12px;align-items:center;font:600 .85rem Heebo,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.35);';
    bar.innerHTML = '<span>\ud83d\uddd1 ' + tt('הרשומה נמחקה', 'ลบแล้ว', 'تم الحذف') + '</span>' +
      '<button style="border:0;border-radius:16px;padding:6px 12px;background:#ffd166;color:#1b1b1b;font:inherit;cursor:pointer;">\u21b6 ' + tt('בטל', 'เลิกทำ', 'تراجع') + '</button>';
    bar.querySelector('button').addEventListener('click', function () {
      var arr = entries();
      arr.splice(Math.min(idx, arr.length), 0, e);
      save();
      audit('restore', e.id, {});
      refreshViews();
      if (B && document.getElementById('weBrowse')) browse(true);
      bar.remove();
    });
    document.body.appendChild(bar);
    undoTimer = setTimeout(function () { if (bar.parentNode) bar.remove(); }, 7000);
  }

  // ── the whole log ───────────────────────────────────────────────────
  function filtered() {
    var fs = userFarms().map(function (f) { return f.id; }), admin = me().role === 'admin';
    var q = String(B.q || '').trim().toLowerCase();
    return entries().filter(function (e) {
      if (!admin && fs.indexOf(e.farm_id) < 0) return false;
      if (B.farm && e.farm_id !== B.farm) return false;
      if (B.plot && e.plot_id !== B.plot) return false;
      if (B.type && e.type !== B.type) return false;
      if (B.from && String(e.date || '') < B.from) return false;
      if (B.to && String(e.date || '') > B.to) return false;
      if (q) {
        var hay = [e.type, e.workers, e.notes, e.plot_name, e.farm_name, e.operator, e.worker_group, e.budget_category, e.quantity_unit].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      return String(b.date || '').localeCompare(String(a.date || '')) || (Number(b.id) || 0) - (Number(a.id) || 0);
    });
  }
  function browse(keep) {
    if (!keep || !B) B = { farm: null, plot: null, type: '', from: '', to: '', q: '', shown: PAGE };
    var html = '<div class="modal-overlay" onclick="if(event.target===this)WorklogEdit.close()">' +
      '<div class="modal" id="weBrowse" style="max-width:720px;max-height:92vh;overflow-y:auto;">' +
        '<h2>\ud83d\udcda ' + tt('היסטוריית יומן העבודה', 'ประวัติบันทึกงาน', 'سجل العمل الكامل') + '</h2>' +
        '<div id="weFilters"></div><div id="weTotals"></div><div id="weList"></div>' +
        '<button onclick="WorklogEdit.close()" style="width:100%;margin-top:12px;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';
    document.getElementById('modalContainer').innerHTML = html;
    drawFilters();
    drawList();
  }
  function drawFilters() {
    var box = document.getElementById('weFilters'); if (!box) return;
    var fs = userFarms();
    var ps = (typeof plots !== 'undefined' ? plots : []).filter(function (p) { return !B.farm || p.farm_id === B.farm; });
    var types = {}; entries().forEach(function (e) { if (e.type) types[e.type] = 1; });
    var cell = function (label, inner) { return '<div style="flex:1 1 140px;min-width:120px;"><div style="font-size:.72rem;color:var(--text-muted);margin-bottom:2px;">' + label + '</div>' + inner + '</div>'; };
    box.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
      cell(fieldLabel('farm_id'), '<select class="form-input" onchange="WorklogEdit._f(\'farm\',this.value)">' + opt('', tt('הכל', 'ทั้งหมด', 'الكل'), !B.farm) +
        fs.map(function (f) { return opt(f.id, farmName(f), f.id === B.farm); }).join('') + '</select>') +
      cell(fieldLabel('plot_id'), '<select class="form-input" onchange="WorklogEdit._f(\'plot\',this.value)">' + opt('', tt('הכל', 'ทั้งหมด', 'الكل'), !B.plot) +
        ps.map(function (p) { return opt(p.id, p.name, p.id === B.plot); }).join('') + '</select>') +
      cell(fieldLabel('type'), '<select class="form-input" onchange="WorklogEdit._f(\'type\',this.value)">' + opt('', tt('הכל', 'ทั้งหมด', 'الكل'), !B.type) +
        Object.keys(types).sort().map(function (k) { return opt(k, k, k === B.type); }).join('') + '</select>') +
      cell(tt('מתאריך', 'จากวันที่', 'من تاريخ'), '<input type="date" class="form-input" value="' + esc(B.from) + '" onchange="WorklogEdit._f(\'from\',this.value)">') +
      cell(tt('עד תאריך', 'ถึงวันที่', 'إلى تاريخ'), '<input type="date" class="form-input" value="' + esc(B.to) + '" onchange="WorklogEdit._f(\'to\',this.value)">') +
      cell(tt('חיפוש', 'ค้นหา', 'بحث'), '<input type="text" class="form-input" value="' + esc(B.q) + '" placeholder="' + esc(tt('עובד, הערה…', 'คนงาน หมายเหตุ…', 'عامل، ملاحظة…')) +
        '" oninput="WorklogEdit._f(\'q\',this.value)">') +
    '</div>';
  }
  function drawList() {
    var rows = filtered();
    var hrs = 0, man = 0, trees = 0;
    rows.forEach(function (e) { hrs += e.hours || 0; man += (e.hours || 0) * (e.worker_count || 1); trees += e.trees_completed || 0; });
    var tot = document.getElementById('weTotals');
    if (tot) tot.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">' +
      [[tt('רשומות', 'รายการ', 'سجلات'), rows.length], [tt('שעות', 'ชั่วโมง', 'ساعات'), hrs.toFixed(1)],
       [tt('שעות עבודה', 'ชั่วโมงแรงงาน', 'ساعات العمل'), man.toFixed(1)], ['\ud83c\udf34', trees]].map(function (x) {
        return '<div style="flex:1;min-width:80px;background:var(--g6);padding:8px;border-radius:10px;text-align:center;">' +
          '<div style="font-size:.66rem;color:var(--text-muted);">' + x[0] + '</div><div style="font-size:1.05rem;font-weight:700;color:var(--g1);">' + x[1] + '</div></div>';
      }).join('') + '</div>' + qtyStrip(rows);
    var box = document.getElementById('weList'); if (!box) return;
    if (!rows.length) { box.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);">' + tt('אין רשומות', 'ไม่มีรายการ', 'لا توجد سجلات') + '</div>'; return; }
    box.innerHTML = rows.slice(0, B.shown).map(function (e) { return card(e, 'browse'); }).join('') +
      (rows.length > B.shown
        ? '<button onclick="WorklogEdit._more()" style="width:100%;padding:10px;border-radius:10px;border:1px dashed var(--g5);background:none;font-family:inherit;cursor:pointer;">' +
            tt('הצג עוד', 'แสดงเพิ่ม', 'عرض المزيد') + ' (' + (rows.length - B.shown) + ')</button>'
        : '');
  }
  // output totals per unit for what is shown (app.js keeps the arithmetic)
  function qtyStrip(rows) {
    if (typeof wlQtyTotals !== 'function') return '';
    var q = wlQtyTotals(rows);
    if (!Object.keys(q).length) return '';
    var rate = wlQtyRateText(q);
    return '<div style="background:#fff8e1;border-radius:10px;padding:8px 10px;margin:-4px 0 12px;font-size:.82rem;text-align:center;">\ud83d\udce6 <b>' +
      esc(wlQtyTotalsText(q)) + '</b>' + (rate ? '<div style="font-size:.7rem;color:var(--text-muted);margin-top:2px;">' + esc(rate) + '</div>' : '') + '</div>';
  }
  // one entry as a row, with its edit and delete — used by the browser and,
  // through WorklogEdit.actions(), by the lists app.js draws
  function card(e, from) {
    var col = (typeof getTypeColor === 'function') ? getTypeColor(e.type) : '#616161';
    return '<div style="padding:10px 12px;background:var(--card);border-radius:10px;margin-bottom:8px;box-shadow:var(--shadow);border-right:3px solid ' + col + ';">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;">' +
        '<b style="font-size:.88rem;">' + esc(e.type || '') + '</b>' +
        '<span style="font-size:.78rem;color:var(--text-muted);white-space:nowrap;">' + esc(e.date || '') + ' ' + esc(e.day_of_week || '') + '</span>' +
      '</div>' +
      '<div style="font-size:.75rem;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap;">' +
        (e.farm_name ? '<span>\ud83c\udf33 ' + esc(e.farm_name) + '</span>' : '') +
        (e.plot_name ? '<span>\ud83d\udccd ' + esc(e.plot_name) + '</span>' : '') +
        (e.hours ? '<span>\u23f1 ' + esc(e.hours) + '</span>' : '') +
        (e.worker_count > 1 ? '<span>\ud83d\udc65 ' + esc(e.worker_count) + '</span>' : '') +
        (e.trees_completed ? '<span>\ud83c\udf34 ' + esc(e.trees_completed) + '</span>' : '') +
        (typeof wlQtyText === 'function' && wlQtyText(e) ? '<span>\ud83d\udce6 ' + esc(wlQtyText(e)) + '</span>' : '') +
        (e.workers ? '<span>\ud83d\udc77 ' + esc(e.workers) + '</span>' : '') +
        '<span>\ud83d\udc64 ' + esc(e.operator || '') + '</span>' +
      '</div>' +
      (e.notes ? '<div style="font-size:.75rem;color:var(--text-muted);margin-top:4px;font-style:italic;">\ud83d\udcdd ' + esc(e.notes) + '</div>' : '') +
      actions(e, from) +
    '</div>';
  }
  // the edit / delete strip, plus the "edited" and "sheet out of step" marks
  function actions(e, from) {
    var fromArg = from === 'browse' ? ",'browse'" : (from && from.plot != null ? ",{plot:" + Number(from.plot) + ",name:'" + String(from.name || '').replace(/\\/g, '').replace(/'/g, "\\'") + "'}" : '');
    var marks = (e.edited_at ? '<span title="' + esc(tt('נערך', 'แก้ไขแล้ว', 'معدّل') + ' ' + String(e.edited_at).slice(0, 16).replace('T', ' ') + ' \u00b7 ' + (e.edited_by || '')) +
                 '" style="font-size:.7rem;background:#e3f2fd;color:#1565c0;border-radius:6px;padding:1px 6px;">\u270e ' + tt('נערך', 'แก้ไขแล้ว', 'معدّل') +
                 (Array.isArray(e.revisions) && e.revisions.length > 1 ? ' \u00d7' + e.revisions.length : '') + '</span>' : '') +
      (e.sheet_stale ? '<span style="font-size:.7rem;background:#fff3e0;color:#8a4b00;border-radius:6px;padding:1px 6px;">\u26a0\ufe0f ' +
                 tt('לא מעודכן בגיליון', 'ไม่ตรงกับชีต', 'غير محدّث في الجدول') + '</span>' : '');
    var btn = 'border:1px solid rgba(0,0,0,.12);background:var(--g6);border-radius:8px;padding:4px 10px;font-family:inherit;font-size:.75rem;cursor:pointer;';
    var copyBtn = '<button style="' + btn + '" onclick="WorklogEdit.copy(' + e.id + ')" title="' + esc(tt('העתק את התוכן לתאריך אחר', 'คัดลอกไปวันอื่น', 'نسخ إلى تاريخ آخر')) + '">\u29c9 ' + tt('העתק', 'คัดลอก', 'نسخ') + '</button>';
    if (!canEdit(e)) return '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' + marks + '<span style="flex:1;"></span>' + copyBtn + '</div>';
    return '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' + marks +
      '<span style="flex:1;"></span>' + copyBtn +
      '<button style="' + btn + '" onclick="WorklogEdit.edit(' + e.id + fromArg + ')">\u270e ' + tt('ערוך', 'แก้ไข', 'تعديل') + '</button>' +
      '<button style="' + btn + 'color:#c62828;" onclick="WorklogEdit.del(' + e.id + fromArg + ')">\ud83d\uddd1</button>' +
    '</div>';
  }

  // Same work, another day: duplicate an entry's content onto a new date and
  // open it in the editor for whatever changed (hours, quantities…).
  function copy(id) {
    var e = byId(id);
    if (!e) return;
    var today = new Date().toISOString().slice(0, 10);
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay" id="weCpOv"><div class="modal" style="max-width:380px;">' +
      '<h2>\u29c9 ' + tt('העתקת רשומה לתאריך חדש', 'คัดลอกไปวันใหม่', 'نسخ إلى تاريخ جديد') + '</h2>' +
      '<div style="font-size:.82rem;color:var(--text-muted);margin-bottom:8px;">' + esc(tr(e.type || '')) + ' \u00b7 ' + esc(e.farm_name || '') + (e.plot_name ? ' \u00b7 ' + esc(e.plot_name) : '') + ' \u00b7 ' + esc(e.date || '') + '</div>' +
      '<label class="form-label">' + tt('לתאריך', 'วันที่', 'إلى تاريخ') + '</label>' +
      '<input type="date" class="form-input" id="weCpDate" value="' + (e.date === today ? new Date(Date.now() + 86400000).toISOString().slice(0, 10) : today) + '">' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:.84rem;margin-top:10px;"><input type="checkbox" id="weCpQty" checked> ' +
        tt('כולל שעות, עצים וכמויות', 'รวมชั่วโมงและปริมาณ', 'مع الساعات والكميات') + '</label>' +
      '<label style="display:flex;gap:6px;align-items:center;font-size:.84rem;margin-top:6px;"><input type="checkbox" id="weCpEdit" checked> ' +
        tt('פתח לעריכה אחרי ההעתקה', 'เปิดแก้ไขหลังคัดลอก', 'افتح للتعديل بعد النسخ') + '</label>' +
      '<div class="modal-buttons"><button class="btn btn-primary" id="weCpGo">\u29c9 ' + tt('העתק', 'คัดลอก', 'نسخ') + '</button>' +
      '<button class="btn btn-secondary" id="weCpNo">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div></div>';
    document.getElementById('weCpNo').onclick = closeModal;
    document.getElementById('weCpOv').addEventListener('click', function (ev) { if (ev.target === this) closeModal(); });
    document.getElementById('weCpGo').onclick = function () {
      var d = document.getElementById('weCpDate').value;
      if (!d) { toast('\u274c ' + tt('יש לבחור תאריך', 'เลือกวันที่', 'اختر تاريخاً')); return; }
      var withQty = document.getElementById('weCpQty').checked, thenEdit = document.getElementById('weCpEdit').checked;
      var n = JSON.parse(JSON.stringify(e));
      ['revisions', 'edited_at', 'edited_by', 'sheet_stale', 'synced_to_sheet'].forEach(function (k) { delete n[k]; });
      var ids = entries().map(function (x) { return Number(x.id) || 0; });
      n.id = Math.max(Date.now(), Math.max.apply(null, ids.concat([0])) + 1);
      n.date = d; n.day_of_week = dayOf(d);
      if (!withQty) { n.hours = null; n.trees_completed = null; n.quantity = null; n.quantity_unit = null; }
      var u = me();
      n.operator = u.name || ''; n.operator_email = u.email || '';
      n.created_at = new Date().toISOString(); n.copied_from = e.id; n.synced_to_sheet = false;
      entries().unshift(n);
      save();
      audit('create', n.id, { note: 'copy of ' + e.id });
      refreshViews();
      toast('\u2705 ' + tt('הרשומה הועתקה ל־', 'คัดลอกไป ', 'نُسخ إلى ') + d.split('-').reverse().join('/'));
      if (thenEdit) edit(n.id); else closeModal();
    };
  }

  return {
    copy: copy,
    edit: edit, del: del, browse: function () { browse(false); }, close: closeModal, actions: actions, canEdit: canEdit,
    _farm: farmChanged,
    _save: saveEdit,
    _back: goBack,
    _f: function (k, v) {
      if (!B) return;
      if (k === 'farm') { B.farm = parseInt(v, 10) || null; B.plot = null; drawFilters(); }
      else if (k === 'plot') B.plot = parseInt(v, 10) || null;
      else B[k] = String(v || '');
      B.shown = PAGE;
      drawList();
    },
    _more: function () { if (B) { B.shown += PAGE; drawList(); } }
  };
})();
