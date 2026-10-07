/* map-region.js — which part of the world the map is allowed to show
 * --------------------------------------------------------------------
 * The map is locked to Israel by default (app.js MAP_BOUNDS). An admin can
 * widen or move that lock: pick a preset region, or browse the whole world,
 * zoom to a country and lock the map to the current view.
 *
 * Org-wide, not per-device: stored in Firestore 'shorashim-map-region'
 * (admin-only write in firestore.rules) and applied live on every device via
 * DB.listen. map-filter.js is per-device on purpose; this is the opposite —
 * the farms are where they are for everyone.
 *
 * Tiles are fetched only for what is on screen, so a wider region costs
 * nothing extra; the lock exists to keep the map from drifting off into
 * places nobody farms.
 *
 * app.js owns the map; this module only calls MapAccess.setRegion().
 */
var MapRegion = (function () {
  'use strict';

  var KEY = 'shorashim-map-region';
  var WORLD = { south: -85, west: -180, north: 85, east: 180 };

  // Rough bounding boxes. Generous on purpose — the lock is a guard rail,
  // not a border.
  var PRESETS = [
    { id: 'israel',    icon: '🇮🇱', b: null,
      name: function () { return tt('ישראל (ברירת מחדל)', 'อิสราเอล (ค่าเริ่มต้น)', 'إسرائيل (افتراضي)'); } },
    { id: 'mideast',   icon: '🏜️', b: { south: 12, west: 25, north: 42, east: 63 },
      name: function () { return tt('המזרח התיכון', 'ตะวันออกกลาง', 'الشرق الأوسط'); } },
    { id: 'europe',    icon: '🏰', b: { south: 34, west: -25, north: 72, east: 45 },
      name: function () { return tt('אירופה', 'ยุโรป', 'أوروبا'); } },
    { id: 'africa',    icon: '🦁', b: { south: -36, west: -20, north: 38, east: 55 },
      name: function () { return tt('אפריקה', 'แอฟริกา', 'أفريقيا'); } },
    { id: 'asia',      icon: '🏯', b: { south: -12, west: 25, north: 78, east: 180 },
      name: function () { return tt('אסיה', 'เอเชีย', 'آسيا'); } },
    { id: 'namerica',  icon: '🗽', b: { south: 5, west: -170, north: 84, east: -50 },
      name: function () { return tt('צפון אמריקה', 'อเมริกาเหนือ', 'أمريكا الشمالية'); } },
    { id: 'samerica',  icon: '🌎', b: { south: -57, west: -93, north: 14, east: -32 },
      name: function () { return tt('דרום אמריקה', 'อเมริกาใต้', 'أمريكا الجنوبية'); } },
    { id: 'oceania',   icon: '🦘', b: { south: -50, west: 110, north: 0, east: 180 },
      name: function () { return tt('אוקיאניה', 'โอเชียเนีย', 'أوقيانوسيا'); } },
    { id: 'world',     icon: '🌐', b: WORLD,
      name: function () { return tt('כל העולם', 'ทั้งโลก', 'العالم كله'); } }
  ];

  var saved = null;       // the stored region, as last applied
  var browsing = false;   // admin is roaming the world to pick a custom view
  var listening = false;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function isAdmin() {
    var u = window.currentUser;
    return !!(u && u.role === 'admin');
  }

  function preset(id) {
    return PRESETS.filter(function (p) { return p.id === id; })[0] || null;
  }

  function validBox(b) {
    return b && [b.south, b.west, b.north, b.east].every(function (v) {
      return typeof v === 'number' && isFinite(v);
    }) && b.south < b.north && b.west < b.east &&
      b.south >= -90 && b.north <= 90 && b.west >= -180 && b.east <= 180;
  }

  function regionName(r) {
    if (!r || !r.preset || r.preset === 'israel') return preset('israel').name();
    if (r.preset === 'custom') return tt('אזור מותאם אישית', 'พื้นที่กำหนดเอง', 'منطقة مخصصة');
    var p = preset(r.preset);
    return p ? p.name() : preset('israel').name();
  }

  // ── apply ──
  function apply(r) {
    if (!(window.MapAccess && MapAccess.setRegion)) return;
    var box = (r && r.preset !== 'israel' && validBox(r)) ? r : null;
    MapAccess.setRegion(box);
  }

  function setSaved(r) {
    saved = r || null;
    if (!browsing) apply(saved);
    renderButton();
  }

  function loadCached() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) setSaved(JSON.parse(raw));
    } catch (e) {}
  }

  function startListening() {
    if (listening || typeof DB === 'undefined') return;
    listening = true;
    DB.listen(KEY, function (data) { setSaved(data); });
  }

  function store(r) {
    if (!isAdmin()) return;
    var u = window.currentUser || {};
    r.by = u.username || u.name || '';
    r.at = new Date().toISOString();
    DB.save(KEY, r);
    setSaved(r);
    if (typeof showToast === 'function') {
      showToast('🌍 ' + tt('אזור המפה עודכן לכל המשתמשים', 'อัปเดตพื้นที่แผนที่สำหรับผู้ใช้ทุกคนแล้ว',
        'تم تحديث منطقة الخريطة لجميع المستخدمين') + ': ' + regionName(r));
    }
  }

  // ── UI: admin button in the map's floating bar ──
  function renderButton() {
    var bar = document.querySelector('#tabMap .map-float-bar');
    var btn = document.getElementById('mrBtn');
    if (!isAdmin()) { if (btn) btn.remove(); return; }
    if (!bar) return;
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'mrBtn';
      btn.type = 'button';
      btn.className = 'layer-toggle';
      btn.style.flex = '0 0 auto';
      btn.addEventListener('click', openPicker);
      bar.appendChild(btn);
    }
    btn.innerHTML = '<span>🌍</span><span>' + esc(tt('אזור', 'พื้นที่', 'منطقة')) + '</span>';
    btn.title = tt('אזור מפה', 'พื้นที่แผนที่', 'منطقة الخريطة') + ': ' + regionName(saved);
  }

  function closePicker() {
    var o = document.getElementById('mrOverlay');
    if (o) o.remove();
  }

  function openPicker() {
    if (!isAdmin()) return;
    closePicker();
    var cur = (saved && saved.preset) || 'israel';

    var rows = PRESETS.map(function (p) {
      var on = p.id === cur;
      return '<button type="button" data-mr="' + p.id + '" style="display:flex;align-items:center;gap:10px;width:100%;' +
        'padding:10px 12px;margin-bottom:6px;border-radius:12px;font-family:inherit;font-size:0.9rem;cursor:pointer;text-align:start;' +
        'border:' + (on ? '2px solid var(--primary, #2e7d32)' : '1px solid var(--border, #ddd)') + ';' +
        'background:' + (on ? 'var(--primary-faded, rgba(46,125,50,0.1))' : 'var(--surface-glass, #f7f7f7)') + ';' +
        'color:var(--text, #222);font-weight:' + (on ? '700' : '400') + ';">' +
        '<span style="font-size:1.2rem;">' + p.icon + '</span><span>' + esc(p.name()) + '</span>' +
        (on ? '<span style="margin-inline-start:auto;">✓</span>' : '') + '</button>';
    }).join('');

    var customNote = cur === 'custom'
      ? '<div style="font-size:0.8rem;color:var(--text-muted, #666);margin-bottom:8px;">✓ ' +
        esc(tt('כרגע: אזור מותאם אישית', 'ตอนนี้: พื้นที่กำหนดเอง', 'حاليًا: منطقة مخصصة')) + '</div>'
      : '';

    var o = document.createElement('div');
    o.id = 'mrOverlay';
    o.style.cssText = 'position:fixed;inset:0;z-index:3000;background:rgba(0,0,0,0.45);display:flex;' +
      'align-items:center;justify-content:center;padding:16px;';
    o.innerHTML =
      '<div style="background:var(--bg, #fff);color:var(--text, #222);border-radius:18px;width:100%;max-width:380px;' +
      'max-height:85dvh;overflow:auto;padding:18px;box-shadow:0 10px 40px rgba(0,0,0,0.3);">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
          '<h3 style="margin:0;font-size:1.05rem;font-weight:700;">🌍 ' + esc(tt('אזור מפה', 'พื้นที่แผนที่', 'منطقة الخريطة')) + '</h3>' +
          '<button type="button" data-mr-close style="border:none;background:none;font-size:1.3rem;cursor:pointer;color:inherit;">✕</button>' +
        '</div>' +
        '<div style="font-size:0.8rem;color:var(--text-muted, #666);margin-bottom:12px;">' +
          esc(tt('המפה תוגבל לאזור שנבחר — לכל המשתמשים.',
                 'แผนที่จะถูกจำกัดในพื้นที่ที่เลือก — สำหรับผู้ใช้ทุกคน',
                 'ستقتصر الخريطة على المنطقة المختارة — لجميع المستخدمين.')) +
        '</div>' +
        customNote + rows +
        '<button type="button" data-mr-browse style="width:100%;padding:11px;margin-top:6px;border-radius:12px;border:none;cursor:pointer;' +
        'font-family:inherit;font-size:0.9rem;font-weight:700;background:var(--primary, #2e7d32);color:#fff;">🔍 ' +
          esc(tt('מדינה מסוימת — דפדף בעולם ונעל תצוגה', 'ประเทศเฉพาะ — ดูทั้งโลกแล้วล็อกมุมมอง',
                 'دولة محددة — تصفح العالم وثبّت العرض')) +
        '</button>' +
      '</div>';
    document.body.appendChild(o);

    o.addEventListener('click', function (e) {
      if (e.target === o || e.target.closest('[data-mr-close]')) { closePicker(); return; }
      if (e.target.closest('[data-mr-browse]')) { closePicker(); startBrowse(); return; }
      var b = e.target.closest('[data-mr]');
      if (!b) return;
      var p = preset(b.getAttribute('data-mr'));
      if (!p) return;
      closePicker();
      if (p.id === cur) return;
      var r = { preset: p.id };
      if (p.b) { r.south = p.b.south; r.west = p.b.west; r.north = p.b.north; r.east = p.b.east; }
      store(r);
    });
  }

  // ── browse the world, then lock to the current view ──
  function startBrowse() {
    if (!isAdmin() || !(window.MapAccess && MapAccess.setRegion)) return;
    browsing = true;
    MapAccess.setRegion(WORLD, { keepView: true });

    var bar = document.createElement('div');
    bar.id = 'mrBrowseBar';
    bar.style.cssText = 'position:fixed;top:12px;left:12px;right:12px;z-index:2500;background:var(--bg, #fff);' +
      'color:var(--text, #222);border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,0.25);padding:10px 12px;' +
      'display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:0.85rem;';
    bar.innerHTML =
      '<div style="flex:1 1 180px;">🌍 ' + esc(tt('הזז והגדל עד שרק המדינה/האזור על המסך, ואז נעל.',
        'เลื่อนและซูมจนเห็นเฉพาะประเทศ/พื้นที่บนหน้าจอ แล้วล็อก',
        'حرّك وكبّر حتى تظهر الدولة/المنطقة فقط على الشاشة، ثم ثبّت.')) + '</div>' +
      '<button type="button" data-mr-lock style="padding:8px 12px;border-radius:10px;border:none;cursor:pointer;font-family:inherit;' +
        'font-weight:700;background:var(--primary, #2e7d32);color:#fff;">🔒 ' + esc(tt('נעל תצוגה זו', 'ล็อกมุมมองนี้', 'ثبّت هذا العرض')) + '</button>' +
      '<button type="button" data-mr-cancel style="padding:8px 12px;border-radius:10px;border:1px solid var(--border, #ccc);cursor:pointer;' +
        'font-family:inherit;background:transparent;color:inherit;">' + esc(tt('ביטול', 'ยกเลิก', 'إلغاء')) + '</button>';
    document.body.appendChild(bar);

    bar.addEventListener('click', function (e) {
      if (e.target.closest('[data-mr-lock]')) { lockView(); return; }
      if (e.target.closest('[data-mr-cancel]')) { endBrowse(); apply(saved); }
    });
  }

  function endBrowse() {
    browsing = false;
    var bar = document.getElementById('mrBrowseBar');
    if (bar) bar.remove();
  }

  function lockView() {
    var m = MapAccess.getMap();
    var vb = m.getBounds();
    var r = {
      preset: 'custom',
      south: Math.max(-85, +vb.getSouth().toFixed(4)),
      west:  Math.max(-180, +vb.getWest().toFixed(4)),
      north: Math.min(85, +vb.getNorth().toFixed(4)),
      east:  Math.min(180, +vb.getEast().toFixed(4))
    };
    if (!validBox(r)) {
      if (typeof showToast === 'function') showToast('⚠️ ' + tt('תצוגה לא תקינה', 'มุมมองไม่ถูกต้อง', 'عرض غير صالح'));
      return;
    }
    endBrowse();
    store(r);
  }

  function onUserReady() {
    if (!isAdmin()) { closePicker(); if (browsing) { endBrowse(); apply(saved); } }
    renderButton();
    startListening();
  }

  function init() {
    loadCached();
    document.addEventListener('shorashim:user-ready', onUserReady);
    if (window.currentUser) onUserReady();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { open: openPicker, current: function () { return saved; } };
})();
