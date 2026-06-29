// ═══════════════════════════════════════════════════════════════════
//  MAINTENANCE SCHEDULE MODULE  (shared maintenance calendar)
// ═══════════════════════════════════════════════════════════════════
//
//  A single SHARED calendar for the maintenance team. Anyone who has
//  maintenance access (any entry in shorashim-maintenance-access) or is
//  an admin/manager can BOTH view and edit events. Cross-device realtime
//  sync via Firestore onSnapshot, identical pattern to maintenance.js.
//
//  Data:   appData/shorashim-maintenance-schedule  →  Array<Event>
//  Event:  { id, title, date:'YYYY-MM-DD', time:'HH:MM'|'', notes,
//            assignee:username|'', projectId:Number|null, cat, done,
//            createdBy, createdAt, updatedAt }
//
//  Firestore rules: shorashim-maintenance-schedule is in the WORKER+ write
//  tier (any role can write; the UI enforces the actual maintenance-access
//  gate). Read is the signed-in appData read. So a worker granted
//  maintenance access can edit without a silent permission failure.
//
//  DATE SAFETY: all date strings are built from LOCAL y/m/d parts.
//  toISOString() is never used for date logic (it shifts dates in Israel).
// ═══════════════════════════════════════════════════════════════════

var MaintSchedule = (function() {
  'use strict';

  var KEY = 'shorashim-maintenance-schedule';

  // ── i18n / globals helpers ──
  function T(he, th, ar) { return (typeof tt === 'function') ? tt(he, th, ar) : he; }
  function toast(msg) { if (typeof showToast === 'function') showToast(msg); }
  function hasMaint() { return typeof Maintenance !== 'undefined'; }

  // ── State ──
  var _events = null;            // in-memory cache, kept fresh by listener
  var _syncInit = false;
  var _migrationDone = false;
  var _view = 'month';           // 'month' | 'agenda'
  var _cursor = new Date();      // month currently shown (any day in it)
  var _projects = [];            // cached maintenance projects (for linking)
  var _access = null;            // cached maintenance-access map

  // ── Local-date helpers (NO toISOString — TZ-safe for Israel) ──
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dateStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function todayStr() { return dateStr(new Date()); }
  function parseStr(s) { var p = (s || '').split('-'); return new Date(+p[0], (+p[1] || 1) - 1, +p[2] || 1); }
  function uid() { return Date.now() * 1000 + Math.floor(Math.random() * 1000); }

  function fmtHuman(s) {
    var d = parseStr(s);
    var months = T('ינואר,פברואר,מרץ,אפריל,מאי,יוני,יולי,אוגוסט,ספטמבר,אוקטובר,נובמבר,דצמבר',
                   'ม.ค.,ก.พ.,มี.ค.,เม.ย.,พ.ค.,มิ.ย.,ก.ค.,ส.ค.,ก.ย.,ต.ค.,พ.ย.,ธ.ค.',
                   'يناير,فبراير,مارس,أبريل,مايو,يونيو,يوليو,أغسطس,سبتمبر,أكتوبر,نوفمبر,ديسمبر').split(',');
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }
  function monthLabel(d) {
    var months = T('ינואר,פברואר,מרץ,אפריל,מאי,יוני,יולי,אוגוסט,ספטמבר,אוקטובר,נובמבר,דצמבר',
                   'มกราคม,กุมภาพันธ์,มีนาคม,เมษายน,พฤษภาคม,มิถุนายน,กรกฎาคม,สิงหาคม,กันยายน,ตุลาคม,พฤศจิกายน,ธันวาคม',
                   'يناير,فبراير,مارس,أبريل,مايو,يونيو,يوليو,أغسطس,سبتمبر,أكتوبر,نوفمبر,ديسمبر').split(',');
    return months[d.getMonth()] + ' ' + d.getFullYear();
  }

  // ── Categories (drives the colour dot) ──
  var CATS = {
    general:    { color: '#42a5f5', label: function() { return T('כללי', 'ทั่วไป', 'عام'); } },
    repair:     { color: '#ff9800', label: function() { return T('תיקון', 'ซ่อม', 'إصلاح'); } },
    inspection: { color: '#66bb6a', label: function() { return T('בדיקה', 'ตรวจสอบ', 'فحص'); } },
    urgent:     { color: '#ef5350', label: function() { return T('דחוף', 'ด่วน', 'عاجل'); } }
  };
  function catColor(c) { return (CATS[c] || CATS.general).color; }

  // ═══════════════════════════════════════════════
  //  DATA LAYER (Firestore sync — mirrors maintenance.js)
  // ═══════════════════════════════════════════════

  // DB.load() fires its callback twice: localStorage first, Firestore second.
  // Resolve on the SECOND (authoritative) callback, with a timeout fallback.
  function _loadFromFirestore(key) {
    return new Promise(function(resolve) {
      if (typeof DB === 'undefined') {
        try { resolve(JSON.parse(localStorage.getItem(key) || '[]')); }
        catch (e) { resolve([]); }
        return;
      }
      var callCount = 0, localData = null, settled = false;
      var timer = setTimeout(function() {
        if (!settled) { settled = true; console.warn('[MaintSchedule] Firestore timeout for ' + key); resolve(localData || []); }
      }, 4000);
      DB.load(key, function(data) {
        callCount++;
        if (callCount === 1) { localData = data; }
        else if (!settled) { settled = true; clearTimeout(timer); resolve(data || []); }
      });
    });
  }

  function _migrateIfNeeded() {
    if (_migrationDone) return Promise.resolve(null);
    _migrationDone = true;
    return _loadFromFirestore(KEY).then(function(fs) {
      if (fs && fs.length > 0) return fs;
      var local = [];
      try { local = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) {}
      if (local.length > 0 && typeof DB !== 'undefined') { DB.save(KEY, local); return local; }
      return fs || [];
    });
  }

  function _initSync() {
    if (_syncInit || typeof DB === 'undefined' || typeof DB.listen !== 'function') return;
    _syncInit = true;
    _migrateIfNeeded().then(function(data) {
      _events = data || [];
      DB.listen(KEY, function(fresh) {
        var nd = fresh || [];
        if (JSON.stringify(nd) !== JSON.stringify(_events)) {
          _events = nd;
          _onChanged();
        } else {
          _events = nd;
        }
      });
    });
  }

  function _onChanged() {
    var modal = document.getElementById('modalContainer');
    if (!modal || !modal.querySelector('[data-msched-root]')) return;
    _render(); // re-render whatever view is open
  }

  function saveEvents(evs) {
    _events = evs;
    if (typeof DB !== 'undefined') DB.save(KEY, evs);
    else localStorage.setItem(KEY, JSON.stringify(evs));
  }
  function loadEvents() {
    if (_events !== null) return Promise.resolve(_events);
    return _migrateIfNeeded().then(function(data) { _events = data || []; return _events; });
  }

  // ═══════════════════════════════════════════════
  //  ACCESS
  // ═══════════════════════════════════════════════
  function _isAdmin() {
    if (hasMaint() && typeof Maintenance.isAdmin === 'function') return Maintenance.isAdmin();
    return !!(window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'manager'));
  }
  // "Permission to enter maintenance" = admin OR any entry in the access map.
  function _canAccess() {
    if (_isAdmin()) return true;
    var email = window.currentUser && window.currentUser.email;
    if (!email || !_access) return false;
    return !!_access[email]; // any maintenance access grants calendar view+edit
  }

  // ═══════════════════════════════════════════════
  //  ENTRY
  // ═══════════════════════════════════════════════
  function show() {
    _initSync();
    var jobs = [ loadEvents() ];
    jobs.push(hasMaint() && typeof Maintenance.loadAccess === 'function' ? Maintenance.loadAccess() : Promise.resolve({}));
    jobs.push(hasMaint() && typeof Maintenance.loadProjects === 'function' ? Maintenance.loadProjects() : Promise.resolve([]));
    Promise.all(jobs).then(function(res) {
      _access = res[1] || {};
      _projects = res[2] || [];
      if (!_canAccess()) { toast(T('⛔ אין הרשאה', '⛔ ไม่มีสิทธิ์', '⛔ لا إذن')); return; }
      _cursor = new Date();
      _view = 'month';
      _render();
    });
  }

  function projName(pid) {
    if (pid == null) return '';
    for (var i = 0; i < _projects.length; i++) { if (_projects[i].id === pid) return _projects[i].name; }
    return '';
  }
  function userName(uname) {
    if (!uname) return '';
    if (typeof window.users !== 'undefined' && window.users && window.users[uname]) return window.users[uname].name || uname;
    return uname;
  }

  // ═══════════════════════════════════════════════
  //  RENDER — shell + view switch
  // ═══════════════════════════════════════════════
  var BG = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;';
  var CARD = 'background:var(--card-solid, white);color:var(--text, inherit);border-radius:16px;padding:18px;width:94%;max-width:640px;max-height:88vh;overflow-y:auto;';

  function _render() {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    _ensureStyle();
    _hideHover();

    var seg = function(v, icon, lbl) {
      var on = _view === v;
      return '<button onclick="MaintSchedule._setView(\'' + v + '\')" style="padding:6px 12px;border:none;border-radius:8px;font-family:inherit;font-weight:' + (on ? '700' : '400') + ';cursor:pointer;background:' + (on ? 'var(--primary, #2e7d32)' : 'var(--surface-glass, #eee)') + ';color:' + (on ? '#fff' : 'var(--text-muted, #666)') + ';">' + icon + ' ' + lbl + '</button>';
    };

    var header =
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;">' +
        '<div style="display:flex;align-items:center;gap:10px;min-width:0;"><img src="' + (window.OGEN_LOGO || '') + '" alt="OGEN" style="height:28px;width:auto;display:block;background:#fff;border-radius:8px;padding:3px 6px;box-shadow:0 1px 4px rgba(0,0,0,0.15);"><h3 style="font-weight:700;margin:0;">📅 ' + T('לוח אחזקה', 'ปฏิทินซ่อมบำรุง', 'تقويم الصيانة') + '</h3></div>' +
        '<div style="display:flex;gap:6px;align-items:center;">' +
          seg('month', '🗓', T('חודש', 'เดือน', 'شهر')) +
          seg('agenda', '📋', T('רשימה', 'รายการ', 'قائمة')) +
          '<button onclick="MaintSchedule._newEvent(\'' + todayStr() + '\')" style="padding:6px 12px;border:none;border-radius:8px;background:#4caf50;color:#fff;font-family:inherit;font-weight:700;cursor:pointer;">➕</button>' +
        '</div>' +
      '</div>';

    var body = _view === 'agenda' ? _renderAgenda() : _renderMonth();

    var closeBtn = '<button onclick="MaintSchedule._close()" style="margin-top:14px;width:100%;padding:10px;border-radius:10px;border:none;background:var(--surface-glass, #eee);color:var(--text, inherit);font-family:inherit;cursor:pointer;">' + T('סגור', 'ปิด', 'إغلاق') + '</button>';

    modal.innerHTML = '<div style="' + BG + '"><div data-msched-root data-msched-view="' + _view + '" style="' + CARD + '">' + header + body + closeBtn + '</div></div>';
  }

  function _setView(v) { _view = v; _render(); }
  function _prevMonth() { _cursor = new Date(_cursor.getFullYear(), _cursor.getMonth() - 1, 1); _render(); }
  function _nextMonth() { _cursor = new Date(_cursor.getFullYear(), _cursor.getMonth() + 1, 1); _render(); }
  function _today() { _cursor = new Date(); _render(); }

  // ── Hover preview (mouse / hover-capable devices only) ──
  function _ensureStyle() {
    if (document.getElementById('mschedStyle')) return;
    var st = document.createElement('style');
    st.id = 'mschedStyle';
    st.textContent =
      '.msched-cell{transition:transform .12s ease, box-shadow .12s ease;}' +
      '@media (hover:hover){.msched-cell:hover{transform:translateY(-2px) scale(1.04);box-shadow:0 6px 18px rgba(0,0,0,0.28);position:relative;z-index:3;}}' +
      '#mschedHover{position:fixed;z-index:100000;pointer-events:none;max-width:240px;background:var(--card-solid,#fff);color:var(--text,inherit);border:1px solid var(--border,#ddd);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,0.35);padding:10px 12px;font-family:inherit;opacity:0;transform:translateY(4px);transition:opacity .12s ease, transform .12s ease;}' +
      '#mschedHover.show{opacity:1;transform:translateY(0);}';
    document.head.appendChild(st);
  }

  function _hideHover() {
    var el = document.getElementById('mschedHover');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function _hover(cell, ds) {
    // Hover-capable pointers only; touch devices tap through to the day view.
    if (!window.matchMedia || !window.matchMedia('(hover: hover)').matches) return;
    var evs = (_events || []).filter(function(e) { return e.date === ds; })
      .sort(function(a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; });
    if (evs.length === 0) { _hideHover(); return; }

    var rows = '';
    evs.slice(0, 6).forEach(function(e) {
      rows += '<div style="display:flex;align-items:center;gap:6px;margin:3px 0;">' +
        '<span style="width:7px;height:7px;border-radius:50%;background:' + catColor(e.cat) + ';flex-shrink:0;"></span>' +
        '<span style="font-size:0.78rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' + (e.done ? 'text-decoration:line-through;opacity:0.6;' : '') + '">' +
          (e.time ? '<span style="color:var(--text-muted,#888);font-weight:400;">' + esc(e.time) + '</span> ' : '') + esc(e.title) +
        '</span></div>';
    });
    if (evs.length > 6) rows += '<div style="font-size:0.7rem;color:var(--text-muted,#999);margin-top:2px;">+' + (evs.length - 6) + '</div>';

    _hideHover();
    var pop = document.createElement('div');
    pop.id = 'mschedHover';
    pop.innerHTML = '<div style="font-size:0.72rem;font-weight:700;color:var(--text-muted,#888);margin-bottom:4px;">' + fmtHuman(ds) + ' \u00b7 ' + evs.length + '</div>' + rows;
    document.body.appendChild(pop);

    // Centered above the cell; flips below if there is no room; clamped to the viewport.
    var r = cell.getBoundingClientRect();
    var pr = pop.getBoundingClientRect();
    var margin = 8;
    var left = r.left + (r.width - pr.width) / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - pr.width - margin));
    var top = r.top - pr.height - margin;
    if (top < margin) top = r.bottom + margin;
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
    requestAnimationFrame(function() { pop.classList.add('show'); });
  }

  function _hoverOut() { _hideHover(); }

  function _close() { _hideHover(); var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  // ── Month grid ──
  function _renderMonth() {
    var dows = T('א,ב,ג,ד,ה,ו,ש', 'อา,จ,อ,พ,พฤ,ศ,ส', 'أحد,إثن,ثلا,أرب,خمي,جمع,سبت').split(',');
    var first = new Date(_cursor.getFullYear(), _cursor.getMonth(), 1);
    var startCell = new Date(first.getFullYear(), first.getMonth(), 1 - first.getDay()); // back up to Sunday
    var today = todayStr();
    var thisMonth = _cursor.getMonth();

    // index events by date for the visible window
    var byDate = {};
    (_events || []).forEach(function(e) { (byDate[e.date] = byDate[e.date] || []).push(e); });

    var nav =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
        '<button onclick="MaintSchedule._prevMonth()" style="border:none;background:var(--surface-glass,#eee);color:var(--text,inherit);width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:1.1rem;">‹</button>' +
        '<div style="display:flex;align-items:center;gap:8px;"><strong>' + monthLabel(_cursor) + '</strong>' +
          '<button onclick="MaintSchedule._today()" style="border:1px solid var(--border,#ddd);background:var(--card-solid,#fff);color:var(--text-muted,#666);padding:3px 8px;border-radius:6px;font-family:inherit;font-size:0.72rem;cursor:pointer;">' + T('היום', 'วันนี้', 'اليوم') + '</button></div>' +
        '<button onclick="MaintSchedule._nextMonth()" style="border:none;background:var(--surface-glass,#eee);color:var(--text,inherit);width:34px;height:34px;border-radius:8px;cursor:pointer;font-size:1.1rem;">›</button>' +
      '</div>';

    var head = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;margin-bottom:3px;">';
    dows.forEach(function(d) { head += '<div style="text-align:center;font-size:0.7rem;font-weight:700;color:var(--text-muted,#888);padding:2px 0;">' + d + '</div>'; });
    head += '</div>';

    var grid = '<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">';
    var cur = new Date(startCell);
    for (var i = 0; i < 42; i++) {
      var ds = dateStr(cur);
      var inMonth = cur.getMonth() === thisMonth;
      var isToday = ds === today;
      var evs = byDate[ds] || [];
      var dots = '';
      evs.slice(0, 4).forEach(function(e) {
        dots += '<span style="width:6px;height:6px;border-radius:50%;background:' + catColor(e.cat) + ';display:inline-block;margin:1px;"></span>';
      });
      var moreN = evs.length > 4 ? '<span style="font-size:0.6rem;color:var(--text-muted,#999);">+' + (evs.length - 4) + '</span>' : '';
      grid +=
        '<div class="msched-cell" data-ds="' + ds + '" onclick="MaintSchedule._openDay(\'' + ds + '\')" onmouseenter="MaintSchedule._hover(this,\'' + ds + '\')" onmouseleave="MaintSchedule._hoverOut()" style="min-height:54px;padding:3px;border-radius:8px;cursor:pointer;border:' + (isToday ? '2px solid var(--primary,#2e7d32)' : '1px solid var(--border,#e3e3e3)') + ';background:' + (inMonth ? 'var(--surface-glass,#fafafa)' : 'transparent') + ';opacity:' + (inMonth ? '1' : '0.4') + ';display:flex;flex-direction:column;">' +
          '<div style="font-size:0.74rem;font-weight:' + (isToday ? '700' : '500') + ';color:' + (isToday ? 'var(--primary,#1b5e20)' : 'var(--text,#444)') + ';text-align:center;">' + cur.getDate() + '</div>' +
          '<div style="flex:1;display:flex;flex-wrap:wrap;align-content:flex-start;justify-content:center;">' + dots + moreN + '</div>' +
        '</div>';
      cur.setDate(cur.getDate() + 1);
    }
    grid += '</div>';

    return nav + head + grid;
  }

  // ── Agenda (upcoming, today forward) ──
  function _renderAgenda() {
    var today = todayStr();
    var upcoming = (_events || []).filter(function(e) { return e.date >= today; })
      .sort(function(a, b) { return a.date === b.date ? ((a.time || '') < (b.time || '') ? -1 : 1) : (a.date < b.date ? -1 : 1); });

    if (upcoming.length === 0) {
      return '<div style="padding:30px 12px;text-align:center;color:var(--text-muted,#999);">📭 ' + T('אין משימות מתוכננות', 'ไม่มีงานที่กำหนดไว้', 'لا مهام مجدولة') + '</div>';
    }

    var h = '<div style="display:flex;flex-direction:column;gap:6px;">';
    var lastDate = '';
    upcoming.forEach(function(e) {
      if (e.date !== lastDate) {
        lastDate = e.date;
        var lbl = e.date === today ? ('⭐ ' + T('היום', 'วันนี้', 'اليوم')) : fmtHuman(e.date);
        h += '<div style="font-size:0.74rem;font-weight:700;color:var(--text-muted,#888);margin-top:8px;">' + lbl + '</div>';
      }
      h += _eventRow(e);
    });
    h += '</div>';
    return h;
  }

  function _eventRow(e) {
    var meta = [];
    if (e.time) meta.push('🕒 ' + e.time);
    if (e.assignee) meta.push('👷 ' + userName(e.assignee));
    var pn = projName(e.projectId);
    if (pn) meta.push('🔧 ' + pn);
    return '<div style="display:flex;align-items:center;gap:8px;background:var(--surface-glass,#f5f7f5);border-radius:10px;padding:8px 10px;border-' + (document.dir === 'rtl' || document.documentElement.dir === 'rtl' ? 'right' : 'left') + ':4px solid ' + catColor(e.cat) + ';">' +
      '<span onclick="MaintSchedule._toggleDone(' + e.id + ')" style="cursor:pointer;font-size:1.1rem;" title="' + T('סמן בוצע', 'ทำเครื่องหมายเสร็จ', 'وضع علامة تم') + '">' + (e.done ? '✅' : '⬜') + '</span>' +
      '<div onclick="MaintSchedule._editEvent(' + e.id + ')" style="flex:1;min-width:0;cursor:pointer;">' +
        '<div style="font-weight:600;font-size:0.9rem;' + (e.done ? 'text-decoration:line-through;opacity:0.6;' : '') + '">' + esc(e.title) + '</div>' +
        (meta.length ? '<div style="font-size:0.72rem;color:var(--text-muted,#888);">' + meta.join(' · ') + '</div>' : '') +
      '</div>' +
      '<button onclick="MaintSchedule._editEvent(' + e.id + ')" style="border:none;background:none;cursor:pointer;font-size:1rem;">✏️</button>' +
    '</div>';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ── Day detail (from month grid tap) ──
  function _openDay(ds) {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;
    _hideHover();
    var evs = (_events || []).filter(function(e) { return e.date === ds; })
      .sort(function(a, b) { return (a.time || '') < (b.time || '') ? -1 : 1; });

    var rows = evs.length ? evs.map(_eventRow).join('') :
      '<div style="padding:20px;text-align:center;color:var(--text-muted,#999);">' + T('אין משימות ביום זה', 'ไม่มีงานในวันนี้', 'لا مهام في هذا اليوم') + '</div>';

    var html =
      '<div style="' + BG + '"><div data-msched-root data-msched-view="day" style="' + CARD + 'max-width:480px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<h3 style="font-weight:700;margin:0;">📅 ' + fmtHuman(ds) + '</h3>' +
          '<button onclick="MaintSchedule.show()" style="border:none;background:var(--surface-glass,#f0f0f0);color:var(--text,#555);width:32px;height:32px;border-radius:8px;cursor:pointer;font-size:1.1rem;">✕</button>' +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:6px;">' + rows + '</div>' +
        '<button onclick="MaintSchedule._newEvent(\'' + ds + '\')" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#4caf50;color:#fff;font-family:inherit;font-weight:700;cursor:pointer;">➕ ' + T('הוסף משימה', 'เพิ่มงาน', 'إضافة مهمة') + '</button>' +
      '</div></div>';
    modal.innerHTML = html;
  }

  // ═══════════════════════════════════════════════
  //  EDITOR
  // ═══════════════════════════════════════════════
  function _editorModal(ev, isNew) {
    var modal = document.getElementById('modalContainer');
    if (!modal) return;

    var inputCss = 'width:100%;padding:9px;border:1px solid var(--border,#ddd);border-radius:8px;font-family:inherit;font-size:0.9rem;background:var(--card-solid,#fff);color:var(--text,inherit);box-sizing:border-box;';
    var lblCss = 'font-size:0.74rem;font-weight:700;color:var(--text-muted,#888);margin-bottom:3px;display:block;';

    // assignee options
    var assignOpts = '<option value="">' + T('— ללא —', '— ไม่มี —', '— بدون —') + '</option>';
    if (typeof window.users !== 'undefined' && window.users) {
      Object.keys(window.users).sort().forEach(function(uname) {
        var u = window.users[uname];
        assignOpts += '<option value="' + esc(uname) + '"' + (ev.assignee === uname ? ' selected' : '') + '>' + esc(u.name || uname) + '</option>';
      });
    }
    // project options
    var projOpts = '<option value="">' + T('— ללא פרויקט —', '— ไม่มีโครงการ —', '— بدون مشروع —') + '</option>';
    (_projects || []).forEach(function(p) {
      projOpts += '<option value="' + p.id + '"' + (ev.projectId === p.id ? ' selected' : '') + '>' + esc(p.name) + '</option>';
    });
    // category options
    var catOpts = '';
    Object.keys(CATS).forEach(function(k) {
      catOpts += '<option value="' + k + '"' + ((ev.cat || 'general') === k ? ' selected' : '') + '>' + CATS[k].label() + '</option>';
    });

    var html =
      '<div style="' + BG + '"><div data-msched-root data-msched-view="editor" style="' + CARD + 'max-width:460px;">' +
        '<h3 style="font-weight:700;margin:0 0 14px;">' + (isNew ? '➕ ' + T('משימה חדשה', 'งานใหม่', 'مهمة جديدة') : '✏️ ' + T('עריכת משימה', 'แก้ไขงาน', 'تعديل المهمة')) + '</h3>' +
        '<div style="display:grid;gap:10px;">' +
          '<div><label style="' + lblCss + '">' + T('כותרת', 'หัวข้อ', 'العنوان') + ' *</label><input id="mschedTitle" style="' + inputCss + '" value="' + esc(ev.title) + '" placeholder="' + T('מה צריך לעשות?', 'ต้องทำอะไร?', 'ما الذي يجب فعله؟') + '"></div>' +
          '<div style="display:flex;gap:8px;">' +
            '<div style="flex:1;"><label style="' + lblCss + '">' + T('תאריך', 'วันที่', 'التاريخ') + '</label><input id="mschedDate" type="date" style="' + inputCss + '" value="' + esc(ev.date) + '"></div>' +
            '<div style="flex:1;"><label style="' + lblCss + '">' + T('שעה', 'เวลา', 'الوقت') + '</label><input id="mschedTime" type="time" style="' + inputCss + '" value="' + esc(ev.time) + '"></div>' +
          '</div>' +
          '<div><label style="' + lblCss + '">' + T('סוג', 'ประเภท', 'النوع') + '</label><select id="mschedCat" style="' + inputCss + '">' + catOpts + '</select></div>' +
          '<div><label style="' + lblCss + '">' + T('אחראי', 'ผู้รับผิดชอบ', 'المسؤول') + '</label><select id="mschedAssignee" style="' + inputCss + '">' + assignOpts + '</select></div>' +
          '<div><label style="' + lblCss + '">' + T('פרויקט מקושר', 'โครงการที่เชื่อมโยง', 'مشروع مرتبط') + '</label><select id="mschedProject" style="' + inputCss + '">' + projOpts + '</select></div>' +
          '<div><label style="' + lblCss + '">' + T('הערות', 'หมายเหตุ', 'ملاحظات') + '</label><textarea id="mschedNotes" rows="2" style="' + inputCss + 'resize:vertical;">' + esc(ev.notes) + '</textarea></div>' +
        '</div>' +
        '<div style="display:flex;gap:8px;margin-top:14px;">' +
          '<button onclick="MaintSchedule._saveEvent(' + (isNew ? 'null' : ev.id) + ',\'' + esc(ev.date) + '\')" style="flex:1;padding:10px;border:none;border-radius:10px;background:var(--primary,#2e7d32);color:#fff;font-family:inherit;font-weight:700;cursor:pointer;">💾 ' + T('שמור', 'บันทึก', 'حفظ') + '</button>' +
          (isNew ? '' : '<button onclick="MaintSchedule._delEvent(' + ev.id + ')" style="padding:10px 14px;border:none;border-radius:10px;background:#ef5350;color:#fff;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button>') +
          '<button onclick="MaintSchedule._cancel(\'' + esc(ev.date) + '\')" style="padding:10px 14px;border:1px solid var(--border,#ddd);border-radius:10px;background:var(--card-solid,#fff);color:var(--text-muted,#666);font-family:inherit;cursor:pointer;">' + T('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
      '</div></div>';
    modal.innerHTML = html;
  }

  function _newEvent(ds) {
    if (!_canAccess()) { toast(T('⛔ אין הרשאה', '⛔ ไม่มีสิทธิ์', '⛔ لا إذن')); return; }
    _editorModal({ id: null, title: '', date: ds || todayStr(), time: '', notes: '', assignee: '', projectId: null, cat: 'general', done: false }, true);
  }
  function _editEvent(id) {
    var ev = (_events || []).filter(function(e) { return e.id === id; })[0];
    if (!ev) return;
    _editorModal(ev, false);
  }

  function _saveEvent(id, fallbackDate) {
    if (!_canAccess()) { toast(T('⛔ אין הרשאה', '⛔ ไม่มีสิทธิ์', '⛔ لا إذن')); return; }
    var g = function(x) { return document.getElementById(x); };
    var title = (g('mschedTitle').value || '').trim();
    if (!title) { toast(T('⚠️ נדרשת כותרת', '⚠️ ต้องมีหัวข้อ', '⚠️ العنوان مطلوب')); return; }
    var pidRaw = g('mschedProject').value;
    var rec = {
      title: title,
      date: g('mschedDate').value || fallbackDate || todayStr(),
      time: g('mschedTime').value || '',
      cat: g('mschedCat').value || 'general',
      assignee: g('mschedAssignee').value || '',
      projectId: pidRaw ? parseInt(pidRaw, 10) : null,
      notes: (g('mschedNotes').value || '').trim()
    };
    var who = (window.currentUser && window.currentUser.username) || '';
    var now = Date.now();
    var evs = (_events || []).slice();
    if (id == null) {
      rec.id = uid(); rec.done = false; rec.createdBy = who; rec.createdAt = now; rec.updatedAt = now;
      evs.push(rec);
    } else {
      for (var i = 0; i < evs.length; i++) {
        if (evs[i].id === id) {
          rec.id = id; rec.done = !!evs[i].done; rec.createdBy = evs[i].createdBy || who;
          rec.createdAt = evs[i].createdAt || now; rec.updatedAt = now;
          evs[i] = rec; break;
        }
      }
    }
    saveEvents(evs);
    toast(T('✅ נשמר', '✅ บันทึกแล้ว', '✅ تم الحفظ'));
    _render();
  }

  function _delEvent(id) {
    if (!_canAccess()) { toast(T('⛔ אין הרשאה', '⛔ ไม่มีสิทธิ์', '⛔ لا إذن')); return; }
    var ok = (typeof window.confirm === 'function') ? window.confirm(T('למחוק את המשימה?', 'ลบงานนี้?', 'حذف المهمة؟')) : true;
    if (!ok) return;
    saveEvents((_events || []).filter(function(e) { return e.id !== id; }));
    toast(T('🗑️ נמחק', '🗑️ ลบแล้ว', '🗑️ تم الحذف'));
    _render();
  }

  function _toggleDone(id) {
    if (!_canAccess()) { toast(T('⛔ אין הרשאה', '⛔ ไม่มีสิทธิ์', '⛔ لا إذن')); return; }
    var evs = (_events || []).slice();
    for (var i = 0; i < evs.length; i++) { if (evs[i].id === id) { evs[i].done = !evs[i].done; evs[i].updatedAt = Date.now(); break; } }
    saveEvents(evs);
    _render();
  }

  function _cancel(ds) {
    // Return to the day view the editor came from if we have a date, else the calendar.
    if (ds) _openDay(ds); else _render();
  }

  // Kick off sync at load so other devices' changes are warm by first open.
  _initSync();

  // ── PUBLIC API (every name used in an inline onclick must be here) ──
  return {
    show: show,
    _setView: _setView,
    _prevMonth: _prevMonth, _nextMonth: _nextMonth, _today: _today,
    _openDay: _openDay,
    _newEvent: _newEvent, _editEvent: _editEvent,
    _saveEvent: _saveEvent, _delEvent: _delEvent, _toggleDone: _toggleDone,
    _cancel: _cancel,
    _hover: _hover, _hoverOut: _hoverOut, _close: _close
  };
})();
