/* plotregister.js — מאגר נתוני חלקות (plot data register)
 * ------------------------------------------------------------------
 * Split the two halves of setting up a plot: the OUTLINE, which only a
 * person tracing on the map gets right, and the ATTRIBUTES (number, name,
 * farm, registered area, variety, crop, tree count, spacing, notes), which
 * usually already exist in a table somewhere — a lease schedule, a plot
 * list, an agronomist's PDF, a photo of a page.
 *
 *   1. UPLOAD. A photo, a screenshot or a PDF goes to the plotDataExtract
 *      Cloud Function, which returns one row per plot. The rows are shown
 *      for review (every field editable, the farm matched to the app's
 *      farms) and then added to the register.
 *
 *   2. APPLY. In the "new plot" modal after drawing, and in the plot card's
 *      edit section, "📋 משוך מהמאגר" opens a picker. Choosing a row fills
 *      the form: name, farm, crop, variety, tree count, spacing, notes, and
 *      the REGISTERED area (stored as the plot's declared area, with the
 *      drawn area kept as the measured one — a large gap between the two
 *      is shown, because it usually means the outline is wrong).
 *      With an area to compare, unused rows closest in size come first.
 *
 * The register is one Firestore document (shorashim-plot-register,
 * operator+). A row remembers which plot it was applied to, so the picker
 * shows what is still waiting for an outline. The model reads only on an
 * explicit press, and the answer is cached in this browser per file.
 */
var PlotRegister = (function () {
  'use strict';

  var REG_KEY = 'shorashim-plot-register';
  var EXTRACT_CACHE = 'shorashim-plot-extract-cache';   // localStorage only
  var MAX_PIXELS = 1150000;   // what the vision models read without resampling
  var MAX_SIDE = 1568;
  var FIELDS = ['plot_no', 'name', 'farm', 'farm_id', 'area', 'variety', 'crop', 'tree_count',
                'row_spacing', 'tree_spacing', 'plants_per_dunam', 'planting_year', 'notes', 'extra'];

  var reg = null;            // { rows: [], updatedAt }
  var M = null;              // manager state
  var P = null;              // picker state

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function dirAttr() {
    return ((typeof currentLang === 'undefined') || currentLang !== 'th') ? 'rtl' : 'ltr';
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function canEdit() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }
  function farmsList() {
    return (window.MapAccess && MapAccess.listUserFarms) ? MapAccess.listUserFarms() : [];
  }
  function fmt(n, d) {
    return (n == null || n === '' || !isFinite(n)) ? '' : String(Math.round(Number(n) * Math.pow(10, d)) / Math.pow(10, d));
  }

  // ── Storage ─────────────────────────────────────────────────────────
  function load() {
    if (typeof DB === 'undefined') { reg = reg || { rows: [] }; return Promise.resolve(reg); }
    var p = (typeof DB.loadFresh === 'function') ? DB.loadFresh(REG_KEY) : DB.loadAsync(REG_KEY);
    return p.then(function (data) {
      reg = (data && Array.isArray(data.rows)) ? data : { rows: [] };
      return reg;
    });
  }
  function persist() {
    if (!canEdit()) return;
    reg.updatedAt = Date.now();
    if (typeof DB !== 'undefined') DB.save(REG_KEY, reg);
  }

  // ── Row helpers ─────────────────────────────────────────────────────
  function norm(s) {
    return String(s || '').toLowerCase().replace(/["'\u05F4\u05F3`\s\-_.]/g, '');
  }
  function matchFarm(text) {
    var n = norm(text); if (!n) return null;
    var fl = farmsList(), hit = null;
    fl.some(function (f) { if (norm(f.name) === n) { hit = f.id; return true; } return false; });
    if (hit) return hit;
    fl.some(function (f) {
      var fn = norm(f.name);
      if (fn && (fn.indexOf(n) !== -1 || n.indexOf(fn) !== -1)) { hit = f.id; return true; }
      return false;
    });
    return hit;
  }
  function farmName(id) {
    var f = farmsList().filter(function (x) { return String(x.id) === String(id); })[0];
    return f ? f.name : '';
  }
  function displayName(r) {
    var nm = String(r.name || '').trim(), no = String(r.plot_no || '').trim();
    if (nm && no && nm.indexOf(no) === -1) return no + ' ' + nm;
    return nm || (no ? tt('חלקה', 'แปลง', 'قطعة') + ' ' + no : '');
  }
  function composeNotes(r) {
    var out = [];
    if (r.notes) out.push(r.notes);
    if (r.planting_year) out.push(tt('שנת נטיעה', 'ปีที่ปลูก', 'سنة الزراعة') + ': ' + r.planting_year);
    (r.extra || []).forEach(function (x) { if (x) out.push(x); });
    return out.join('\n');
  }
  function cleanRow(r) {
    var o = { id: r.id || (Date.now() + '-' + Math.random().toString(36).slice(2, 7)) };
    FIELDS.forEach(function (k) { o[k] = (r[k] === undefined) ? null : r[k]; });
    o.extra = Array.isArray(r.extra) ? r.extra : [];
    o.usedBy = r.usedBy || null;
    o.conf = r.conf || r.confidence || '';
    return o;
  }
  function sameRow(a, b) {
    return norm(a.plot_no) === norm(b.plot_no) && norm(a.name) === norm(b.name) &&
           String(a.farm_id || '') === String(b.farm_id || '');
  }
  function plotNameById(id) {
    if (!id || !window.MapAccess || !MapAccess.listPlotsWithRings) return '';
    var p = MapAccess.listPlotsWithRings().filter(function (x) { return x.id === id; })[0];
    return p ? p.name : '';
  }

  // ── Extraction ──────────────────────────────────────────────────────
  function hashStr(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
    return h.toString(16) + ':' + s.length;
  }
  function cacheGet(k) {
    try { return (JSON.parse(localStorage.getItem(EXTRACT_CACHE) || '{}'))[k] || null; } catch (e) { return null; }
  }
  function cachePut(k, v) {
    try {
      var c = JSON.parse(localStorage.getItem(EXTRACT_CACHE) || '{}');
      c[k] = v;
      var keys = Object.keys(c).sort(function (a, b) { return (c[a].at || 0) - (c[b].at || 0); });
      while (keys.length > 8) delete c[keys.shift()];
      localStorage.setItem(EXTRACT_CACHE, JSON.stringify(c));
    } catch (e) {}
  }
  function readImage(file) {
    return new Promise(function (resolve, reject) {
      var rd = new FileReader();
      rd.onerror = reject;
      rd.onload = function () {
        var im = new Image();
        im.onerror = reject;
        im.onload = function () {
          var w0 = im.naturalWidth, h0 = im.naturalHeight;
          var k = Math.min(1, Math.sqrt(MAX_PIXELS / (w0 * h0)), MAX_SIDE / Math.max(w0, h0));
          var w = Math.max(32, Math.round(w0 * k)), h = Math.max(32, Math.round(h0 * k));
          var cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          var cx = cv.getContext('2d');
          cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
          cx.drawImage(im, 0, 0, w, h);
          resolve(cv.toDataURL('image/jpeg', 0.9).split(',')[1]);
        };
        im.src = rd.result;
      };
      rd.readAsDataURL(file);
    });
  }
  function readPdf(file) {
    return new Promise(function (resolve, reject) {
      if (file.size > 6.5 * 1024 * 1024) { reject(new Error('size')); return; }
      var rd = new FileReader();
      rd.onerror = reject;
      rd.onload = function () { resolve(String(rd.result).split(',')[1]); };
      rd.readAsDataURL(file);
    });
  }
  function extract(file) {
    if (!M || M.busy) return;
    var isPdf = /pdf$/i.test(file.type || '') || /\.pdf$/i.test(file.name || '');
    if (!isPdf && !/^image\//.test(file.type || '')) {
      toast('❌ ' + tt('יש לבחור תמונה או PDF', 'กรุณาเลือกรูปภาพหรือ PDF', 'اختر صورة أو PDF'));
      return;
    }
    if (typeof firebase === 'undefined' || !firebase.app || !firebase.app().functions) {
      toast('❌ ' + tt('שירות הקריאה אינו זמין', 'บริการอ่านไม่พร้อมใช้งาน', 'خدمة القراءة غير متاحة'));
      return;
    }
    M.busy = true;
    M.status = '⏳ ' + tt('מכין את הקובץ…', 'กำลังเตรียมไฟล์…', 'جارٍ تجهيز الملف…');
    renderManager();
    (isPdf ? readPdf(file) : readImage(file)).then(function (b64) {
      var key = (M.model || 'sonnet-5') + ':' + hashStr(b64) + ':' + hashStr(M.hint || '');
      var hit = cacheGet(key);
      if (hit) {
        M.busy = false;
        takeRows(hit.rows, hit.notes, file.name);
        toast('♻️ ' + tt('נטען מקריאה קודמת — ללא עלות', 'โหลดจากการอ่านก่อนหน้า — ไม่มีค่าใช้จ่าย', 'تم التحميل من قراءة سابقة — بدون تكلفة'));
        return;
      }
      M.status = '⏳ ' + tt('קורא את הטבלה… (עד שתי דקות)', 'กำลังอ่านตาราง… (ไม่เกินสองนาที)', 'جارٍ قراءة الجدول… (حتى دقيقتين)');
      renderManager();
      var payload = { model: M.model || 'sonnet-5', hint: M.hint || '',
                      farms: farmsList().map(function (f) { return f.name; }) };
      if (isPdf) payload.pdf = b64; else payload.image = b64;
      var fn = firebase.app().functions('us-central1').httpsCallable('plotDataExtract', { timeout: 300000 });
      return fn(payload).then(function (r) {
        M.busy = false;
        var res = (r && r.data) || { rows: [] };
        cachePut(key, { rows: res.rows || [], notes: res.notes || '', at: Date.now() });
        takeRows(res.rows || [], res.notes || '', file.name);
      });
    }).catch(function (e) {
      if (!M) return;
      M.busy = false;
      M.status = (e && e.message === 'size')
        ? '❌ ' + tt('קובץ PDF גדול מ-6.5MB — פצל אותו או צלם את העמודים', 'ไฟล์ PDF ใหญ่กว่า 6.5MB — แยกไฟล์หรือถ่ายภาพหน้า', 'ملف PDF أكبر من 6.5MB — قسّمه أو صوّر الصفحات')
        : '❌ ' + tt('הקריאה נכשלה', 'การอ่านล้มเหลว', 'فشلت القراءة') + ': ' + ((e && e.message) || e);
      renderManager();
    });
  }
  function takeRows(rows, notes, fileName) {
    M.pending = (rows || []).map(function (r) {
      var o = cleanRow(r);
      o.id = null;
      o.farm_id = matchFarm(r.farm);
      o.include = true;
      o.source = fileName || '';
      return o;
    });
    M.status = M.pending.length
      ? '✅ ' + tt('נקראו', 'อ่านได้', 'تمت قراءة') + ' ' + M.pending.length + ' ' + tt('שורות — בדוק לפני ההוספה', 'แถว — ตรวจสอบก่อนเพิ่ม', 'صفوف — راجع قبل الإضافة')
      : '⚠️ ' + tt('לא נמצאו שורות חלקה בקובץ', 'ไม่พบแถวแปลงในไฟล์', 'لم يتم العثور على صفوف قطع في الملف');
    if (notes) M.status += ' · ' + notes;
    renderManager();
  }
  function addPending() {
    if (!canEdit()) return;
    var list = M.pending.filter(function (r) { return r.include; });
    var added = 0, updated = 0;
    list.forEach(function (r) {
      var row = cleanRow(r);
      var ex = reg.rows.filter(function (x) { return sameRow(x, row); })[0];
      if (ex) {
        FIELDS.forEach(function (k) { if (row[k] !== null && row[k] !== '') ex[k] = row[k]; });
        updated++;
      } else {
        row.id = Date.now() + '-' + Math.random().toString(36).slice(2, 7);
        reg.rows.push(row);
        added++;
      }
    });
    persist();
    M.pending = [];
    M.status = '✅ ' + added + ' ' + tt('נוספו', 'เพิ่มแล้ว', 'أضيفت') +
      (updated ? ' · ' + updated + ' ' + tt('עודכנו', 'อัปเดตแล้ว', 'حُدّثت') : '');
    renderManager();
  }

  // ── Overlays ────────────────────────────────────────────────────────
  function injectCss() {
    if (document.getElementById('prStyles')) return;
    var st = document.createElement('style');
    st.id = 'prStyles';
    st.textContent =
      '.pr-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:14px;font-family:Heebo,sans-serif}' +
      '.pr-box{background:var(--card,#fff);color:var(--text,#1b1b1b);border-radius:16px;width:100%;max-width:620px;max-height:90vh;overflow:auto;padding:14px 16px;box-shadow:0 10px 40px rgba(0,0,0,.35);font-size:14px}' +
      '.pr-box h3{margin:0;font-size:17px;flex:1}' +
      '.pr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}' +
      '.pr-btn{border:0;border-radius:10px;padding:9px 12px;font:inherit;font-weight:600;cursor:pointer;background:var(--g5,#e8f5e9);color:var(--g1,#1b5e20)}' +
      '.pr-btn.pri{background:var(--g2,#2e7d32);color:#fff}.pr-btn.big{flex:1;padding:13px 10px}.pr-btn:disabled{opacity:.5}' +
      '.pr-btn.dang{background:#ffebee;color:#c62828}' +
      '.pr-help{font-size:12.5px;opacity:.75;line-height:1.45;margin:4px 0}' +
      '.pr-status{font-size:13px;margin:6px 0;line-height:1.4}' +
      '.pr-box input,.pr-box select,.pr-box textarea{font:inherit;padding:6px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.18);background:var(--card,#fff);color:inherit;min-width:0;box-sizing:border-box}' +
      '.pr-card{border:1px solid rgba(0,0,0,.1);border-radius:12px;padding:8px 10px;margin:8px 0}' +
      '.pr-card.off{opacity:.5}.pr-card.low{border-color:#ffb74d}' +
      '.pr-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}' +
      '.pr-grid label{font-size:11px;opacity:.7;display:block}.pr-grid input,.pr-grid select{width:100%}' +
      '.pr-full{grid-column:1/-1}.pr-full textarea{width:100%;min-height:44px}' +
      '.pr-item{display:flex;gap:8px;align-items:center;padding:9px 6px;border-top:1px solid rgba(0,0,0,.08);cursor:pointer}' +
      '.pr-item:hover{background:rgba(46,125,50,.06)}.pr-item.used{opacity:.55}' +
      '.pr-item .pr-m{flex:1;min-width:0}.pr-item .pr-t{font-weight:700}' +
      '.pr-item .pr-s{font-size:12px;opacity:.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.pr-tag{font-size:11px;border-radius:6px;padding:2px 6px;background:#e8f5e9;color:#2e7d32;white-space:nowrap}' +
      '.pr-tag.u{background:#eceff1;color:#546e7a}.pr-tag.n{background:#fff3e0;color:#e65100}' +
      '.pr-info{border-radius:10px;padding:8px 10px;margin:8px 0;font-size:0.82rem;background:#e8f5e9;line-height:1.45}' +
      '.pr-info.warn{background:#fff3e0;color:#bf360c}';
    document.head.appendChild(st);
  }
  function overlay(id, z) {
    injectCss();
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.className = 'pr-ov';
      el.style.zIndex = z;
      el.innerHTML = '<div class="pr-box"></div>';
      el.addEventListener('click', function (e) { if (e.target === el) closeOverlay(id); });
      document.body.appendChild(el);
    }
    el.setAttribute('dir', dirAttr());
    return el.querySelector('.pr-box');
  }
  function closeOverlay(id) {
    var el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (id === 'prManager') {
      M = null;
      if (P) renderPicker();      // the picker underneath may now have rows
    }
    if (id === 'prPicker') P = null;
  }

  // ── Row editor card ─────────────────────────────────────────────────
  function cardHtml(r, list, i) {
    var fo = '<option value="">' + tt('— מטע —', '— สวน —', '— بستان —') + '</option>' +
      farmsList().map(function (f) {
        return '<option value="' + f.id + '"' + (String(r.farm_id) === String(f.id) ? ' selected' : '') + '>' + esc(f.name) + '</option>';
      }).join('');
    function inp(f, label, type, val) {
      return '<div><label>' + label + '</label><input type="' + (type || 'text') + '" data-f="' + f + '" data-l="' + list + '" data-i="' + i + '" value="' + esc(val == null ? '' : val) + '"' +
        (type === 'number' ? ' step="any"' : '') + '></div>';
    }
    return '<div class="pr-card' + (r.include === false ? ' off' : '') + (r.conf === 'low' ? ' low' : '') + '">' +
      '<div class="pr-row" style="margin:0 0 6px">' +
        (list === 'new' ? '<input type="checkbox" data-f="include" data-l="new" data-i="' + i + '"' + (r.include !== false ? ' checked' : '') + '>' : '') +
        '<b style="flex:1">' + esc(displayName(r) || '—') + '</b>' +
        (r.conf === 'low' ? '<span class="pr-tag n">❔ ' + tt('לבדוק', 'ตรวจสอบ', 'للتحقق') + '</span>' : '') +
        (list === 'reg' ? '<button class="pr-btn dang" data-act="delRow" data-i="' + i + '">🗑️</button>' +
                          '<button class="pr-btn" data-act="collapse">▴</button>' : '') +
      '</div>' +
      '<div class="pr-grid">' +
        inp('plot_no', tt('מס׳ חלקה', 'เลขแปลง', 'رقم القطعة'), 'text', r.plot_no) +
        inp('name', tt('שם', 'ชื่อ', 'الاسم'), 'text', r.name) +
        '<div><label>' + tt('מטע', 'สวน', 'البستان') + (r.farm && !r.farm_id ? ' <span style="color:#e65100">(' + esc(r.farm) + ')</span>' : '') + '</label>' +
          '<select data-f="farm_id" data-l="' + list + '" data-i="' + i + '">' + fo + '</select></div>' +
        inp('area', tt('שטח (דונם)', 'พื้นที่ (ดูนัม)', 'المساحة (دونم)'), 'number', r.area) +
        inp('variety', tt('זן', 'สายพันธุ์', 'الصنف'), 'text', r.variety) +
        inp('crop', tt('גידול', 'พืช', 'المحصول'), 'text', r.crop) +
        inp('tree_count', tt('מספר עצים', 'จำนวนต้น', 'عدد الأشجار'), 'number', r.tree_count) +
        inp('planting_year', tt('שנת נטיעה', 'ปีที่ปลูก', 'سنة الزراعة'), 'number', r.planting_year) +
        inp('row_spacing', tt('בין שורות (מ׳)', 'ระหว่างแถว (ม.)', 'بين الصفوف (م)'), 'number', r.row_spacing) +
        inp('tree_spacing', tt('בין עצים (מ׳)', 'ระหว่างต้น (ม.)', 'بين الأشجار (م)'), 'number', r.tree_spacing) +
        '<div class="pr-full"><label>' + tt('הערות', 'หมายเหตุ', 'ملاحظات') + '</label>' +
          '<textarea data-f="notes" data-l="' + list + '" data-i="' + i + '">' + esc(r.notes || '') + '</textarea></div>' +
        ((r.extra && r.extra.length) ? '<div class="pr-full pr-help">' + r.extra.map(esc).join(' · ') + '</div>' : '') +
      '</div></div>';
  }
  function itemHtml(r, i, actAttr, extraTag) {
    var bits = [];
    var fn = farmName(r.farm_id) || r.farm;
    if (fn) bits.push(fn);
    if (r.area) bits.push(fmt(r.area, 2) + ' ' + tt('ד׳', 'ดูนัม', 'دونم'));
    if (r.variety) bits.push(r.variety);
    if (r.tree_count) bits.push('🌴 ' + r.tree_count);
    var used = r.usedBy ? (plotNameById(r.usedBy) || '✓') : '';
    return '<div class="pr-item' + (used ? ' used' : '') + '" ' + actAttr + ' data-i="' + i + '">' +
      '<div class="pr-m"><div class="pr-t">' + esc(displayName(r) || '—') + '</div>' +
      '<div class="pr-s">' + esc(bits.join(' · ')) + '</div></div>' +
      (extraTag || '') +
      (used ? '<span class="pr-tag u">✓ ' + esc(used) + '</span>' : '<span class="pr-tag">' + tt('פנויה', 'ว่าง', 'متاحة') + '</span>') +
      '</div>';
  }
  function filterRows(q) {
    var n = norm(q);
    return reg.rows.map(function (r, i) { return { r: r, i: i }; }).filter(function (x) {
      if (!n) return true;
      return [x.r.plot_no, x.r.name, x.r.variety, x.r.farm, farmName(x.r.farm_id), x.r.crop]
        .some(function (v) { return norm(v).indexOf(n) !== -1; });
    });
  }

  // ── Manager ─────────────────────────────────────────────────────────
  function openManager() {
    if (!canEdit()) {
      toast('❌ ' + tt('מאגר הנתונים זמין למנהלים בלבד', 'คลังข้อมูลใช้ได้เฉพาะผู้จัดการ', 'المخزن متاح للمديرين فقط'));
      return;
    }
    M = M || { pending: [], status: '', busy: false, model: 'sonnet-5', hint: '', q: '', open: null };
    overlay('prManager', 2300).innerHTML = '<div class="pr-status">⏳</div>';
    load().then(renderManager);
  }
  function renderManager() {
    if (!M || !document.getElementById('prManager')) return;
    var box = overlay('prManager', 2300);
    var used = reg.rows.filter(function (r) { return r.usedBy; }).length;
    var h = '<div class="pr-row" style="margin-top:0"><h3>📋 ' + tt('מאגר נתוני חלקות', 'คลังข้อมูลแปลง', 'مخزن بيانات القطع') + '</h3>' +
      '<button class="pr-btn" data-act="closeM">✕</button></div>';
    h += '<p class="pr-help">' + tt(
      'העלה טבלה של חלקות (צילום, צילום מסך או PDF). אחרי שתשרטט פוליגון, לחץ "📋 משוך מהמאגר" כדי למלא את כל נתוני החלקה בלחיצה.',
      'อัปโหลดตารางแปลง (รูปถ่าย ภาพหน้าจอ หรือ PDF) หลังวาดรูปหลายเหลี่ยม กด "📋 ดึงจากคลัง" เพื่อกรอกข้อมูลแปลงทั้งหมดในคลิกเดียว',
      'ارفع جدول القطع (صورة أو لقطة شاشة أو PDF). بعد رسم المضلع اضغط "📋 اسحب من المخزن" لملء كل بيانات القطعة بنقرة.') + '</p>';
    h += '<div class="pr-row">' +
      '<button class="pr-btn big pri" data-act="upImg"' + (M.busy ? ' disabled' : '') + '>📷 ' + tt('תמונה', 'รูปภาพ', 'صورة') + '</button>' +
      '<button class="pr-btn big pri" data-act="upPdf"' + (M.busy ? ' disabled' : '') + '>📄 PDF</button></div>';
    h += '<div class="pr-row"><select data-m="model">' +
      '<option value="sonnet-5"' + (M.model === 'sonnet-5' ? ' selected' : '') + '>' + tt('קריאה מדויקת', 'อ่านแม่นยำ', 'قراءة دقيقة') + '</option>' +
      '<option value="haiku"' + (M.model === 'haiku' ? ' selected' : '') + '>' + tt('קריאה חסכונית', 'อ่านประหยัด', 'قراءة اقتصادية') + '</option>' +
      '<option value="opus"' + (M.model === 'opus' ? ' selected' : '') + '>' + tt('קריאה מקסימלית', 'อ่านสูงสุด', 'قراءة قصوى') + '</option>' +
      '</select><input type="text" data-m="hint" style="flex:1" value="' + esc(M.hint) + '" placeholder="' +
      esc(tt('רמז (לא חובה): למשל כל החלקות במושב פצאל', 'คำใบ้ (ไม่บังคับ)', 'تلميح (اختياري)')) + '"></div>';
    if (M.status) h += '<div class="pr-status">' + esc(M.status) + '</div>';

    if (M.pending.length) {
      var nInc = M.pending.filter(function (r) { return r.include; }).length;
      h += '<div style="font-weight:700;margin-top:10px">🔎 ' + tt('לבדיקה', 'ตรวจสอบ', 'للمراجعة') + ' (' + M.pending.length + ')</div>';
      M.pending.forEach(function (r, i) { h += cardHtml(r, 'new', i); });
      h += '<div class="pr-row"><button class="pr-btn pri big" data-act="addPending"' + (nInc ? '' : ' disabled') + '>➕ ' +
        tt('הוסף', 'เพิ่ม', 'أضف') + ' ' + nInc + ' ' + tt('למאגר', 'ลงคลัง', 'إلى المخزن') + '</button>' +
        '<button class="pr-btn" data-act="dropPending">' + tt('בטל', 'ยกเลิก', 'إلغاء') + '</button></div>';
    }

    h += '<div class="pr-row" style="margin-top:12px"><b style="flex:1">' + tt('במאגר', 'ในคลัง', 'في المخزن') + ': ' + reg.rows.length +
      ' · ' + tt('שויכו', 'ใช้แล้ว', 'مُسندة') + ': ' + used + '</b>' +
      (reg.rows.length ? '<button class="pr-btn dang" data-act="clearAll">' + tt('מחק הכל', 'ลบทั้งหมด', 'احذف الكل') + '</button>' : '') + '</div>';
    if (reg.rows.length) {
      h += '<input type="text" data-m="q" style="width:100%" value="' + esc(M.q) + '" placeholder="🔍 ' + esc(tt('חיפוש', 'ค้นหา', 'بحث')) + '">';
      h += '<div id="prRegList">' + regListHtml() + '</div>';
    }
    box.innerHTML = h;
    bindBox(box, onManagerClick, onManagerInput);
  }
  function regListHtml() {
    return filterRows(M.q).map(function (x) {
      return (M.open === x.i) ? cardHtml(x.r, 'reg', x.i) : itemHtml(x.r, x.i, 'data-act="openRow"');
    }).join('');
  }
  function bindBox(box, onClick, onInput) {
    if (box._prBound) { box._prClick = onClick; box._prInput = onInput; return; }
    box._prBound = true;
    box._prClick = onClick; box._prInput = onInput;
    box.addEventListener('click', function (e) { box._prClick(e); });
    box.addEventListener('input', function (e) { box._prInput(e); });
    box.addEventListener('change', function (e) { box._prInput(e); });
  }
  function pickFile(accept, cb) {
    var inp = document.createElement('input');
    inp.type = 'file'; inp.accept = accept; inp.style.display = 'none';
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0];
      if (inp.parentNode) inp.parentNode.removeChild(inp);
      if (f) cb(f);
    });
    document.body.appendChild(inp);
    inp.click();
  }
  function onManagerClick(e) {
    var b = e.target.closest('[data-act]'); if (!b || !M) return;
    var act = b.getAttribute('data-act'), i = parseInt(b.getAttribute('data-i'), 10);
    if (act === 'closeM') closeOverlay('prManager');
    else if (act === 'upImg') pickFile('image/*', extract);
    else if (act === 'upPdf') pickFile('application/pdf,.pdf', extract);
    else if (act === 'addPending') addPending();
    else if (act === 'dropPending') { M.pending = []; M.status = ''; renderManager(); }
    else if (act === 'openRow') { M.open = i; refreshRegList(); }
    else if (act === 'collapse') { M.open = null; persist(); refreshRegList(); }
    else if (act === 'delRow') {
      if (!window.confirm(tt('למחוק את השורה מהמאגר?', 'ลบแถวนี้ออกจากคลัง?', 'حذف الصف من المخزن؟'))) return;
      reg.rows.splice(i, 1); M.open = null; persist(); renderManager();
    }
    else if (act === 'clearAll') {
      if (!window.confirm(tt('למחוק את כל המאגר? חלקות קיימות לא ישתנו.', 'ลบคลังทั้งหมด? แปลงที่มีอยู่จะไม่เปลี่ยน', 'حذف المخزن بالكامل؟ القطع الموجودة لن تتغير.'))) return;
      reg.rows = []; M.open = null; persist(); renderManager();
    }
  }
  function refreshRegList() {
    var el = document.getElementById('prRegList');
    if (el) el.innerHTML = regListHtml(); else renderManager();
  }
  function onManagerInput(e) {
    var t = e.target; if (!M) return;
    var mk = t.getAttribute('data-m');
    if (mk === 'model') { M.model = t.value; return; }
    if (mk === 'hint') { M.hint = t.value; return; }
    if (mk === 'q') { M.q = t.value; M.open = null; refreshRegList(); return; }
    var f = t.getAttribute('data-f'), l = t.getAttribute('data-l');
    if (!f || !l) return;
    var i = parseInt(t.getAttribute('data-i'), 10);
    var r = (l === 'new') ? M.pending[i] : reg.rows[i];
    if (!r) return;
    if (f === 'include') { if (e.type === 'change') { r.include = t.checked; renderManager(); } return; }
    if (f === 'farm_id') { r.farm_id = t.value ? parseInt(t.value, 10) : null; }
    else if (t.type === 'number') {
      var v = t.value === '' ? null : Number(t.value);
      r[f] = (v == null || !isFinite(v)) ? null : v;
    }
    else r[f] = t.value;
    // Register edits persist when the card is collapsed or on change, not
    // on every keystroke.
    if (l === 'reg' && e.type === 'change') persist();
  }

  // ── Picker ──────────────────────────────────────────────────────────
  // target: 'naming' (new-plot modal) or 'edit' (plot card edit section).
  // area: the drawn area in dunam, used to rank rows by likely match.
  function pickFor(target, area) {
    P = { target: target, area: Number(area) || 0, q: '' };
    overlay('prPicker', 2200).innerHTML = '<div class="pr-status">⏳</div>';
    load().then(renderPicker);
  }
  function renderPicker() {
    if (!P || !document.getElementById('prPicker')) return;
    var box = overlay('prPicker', 2200);
    var h = '<div class="pr-row" style="margin-top:0"><h3>📋 ' + tt('משוך נתונים מהמאגר', 'ดึงข้อมูลจากคลัง', 'اسحب البيانات من المخزن') + '</h3>' +
      (canEdit() ? '<button class="pr-btn" data-act="manage">⚙️ ' + tt('ניהול / העלאה', 'จัดการ / อัปโหลด', 'إدارة / رفع') + '</button>' : '') +
      '<button class="pr-btn" data-act="closeP">✕</button></div>';
    if (!reg.rows.length) {
      h += '<p class="pr-help">' + tt('המאגר ריק. העלה טבלה או PDF עם נתוני החלקות.', 'คลังว่างเปล่า อัปโหลดตารางหรือ PDF ที่มีข้อมูลแปลง', 'المخزن فارغ. ارفع جدولاً أو PDF ببيانات القطع.') + '</p>';
      if (canEdit()) h += '<div class="pr-row"><button class="pr-btn pri big" data-act="manage">📤 ' + tt('העלה נתונים', 'อัปโหลดข้อมูล', 'ارفع البيانات') + '</button></div>';
    } else {
      if (P.area) h += '<p class="pr-help">📐 ' + tt('שטח משורטט', 'พื้นที่ที่วาด', 'المساحة المرسومة') + ': ' + fmt(P.area, 2) + ' ' + tt('דונם', 'ดูนัม', 'دونم') + ' — ' +
        tt('הקרובות בגודלן ראשונות', 'ขนาดใกล้เคียงแสดงก่อน', 'الأقرب حجماً أولاً') + '</p>';
      h += '<input type="text" data-m="pq" style="width:100%" value="' + esc(P.q) + '" placeholder="🔍 ' + esc(tt('חיפוש לפי מספר, שם, זן', 'ค้นหาตามเลข ชื่อ สายพันธุ์', 'بحث بالرقم أو الاسم أو الصنف')) + '">';
      h += '<div id="prPickList">' + pickListHtml() + '</div>';
    }
    box.innerHTML = h;
    bindBox(box, onPickerClick, onPickerInput);
  }
  function pickListHtml() {
    var list = filterRows(P.q);
    list.sort(function (a, b) {
      var ua = a.r.usedBy ? 1 : 0, ub = b.r.usedBy ? 1 : 0;
      if (ua !== ub) return ua - ub;
      if (P.area && !P.q) {
        var da = a.r.area ? Math.abs(a.r.area - P.area) / P.area : 99;
        var db = b.r.area ? Math.abs(b.r.area - P.area) / P.area : 99;
        if (da !== db) return da - db;
      }
      return String(a.r.plot_no || a.r.name).localeCompare(String(b.r.plot_no || b.r.name), undefined, { numeric: true });
    });
    return list.map(function (x) {
      var tag = '';
      if (P.area && x.r.area) {
        var d = Math.abs(x.r.area - P.area) / P.area;
        if (d <= 0.1) tag = '<span class="pr-tag">≈ ' + Math.round(d * 100) + '%</span>';
      }
      return itemHtml(x.r, x.i, 'data-act="pick"', tag);
    }).join('');
  }
  function onPickerClick(e) {
    var b = e.target.closest('[data-act]'); if (!b || !P) return;
    var act = b.getAttribute('data-act');
    if (act === 'closeP') closeOverlay('prPicker');
    else if (act === 'manage') openManager();
    else if (act === 'pick') {
      var r = reg.rows[parseInt(b.getAttribute('data-i'), 10)];
      if (!r) return;
      if (r.usedBy && !window.confirm(tt('השורה כבר שויכה לחלקה', 'แถวนี้ถูกใช้กับแปลงแล้ว', 'الصف مُسند لقطعة بالفعل') + ' "' +
          (plotNameById(r.usedBy) || '?') + '". ' + tt('להשתמש בה שוב?', 'ใช้อีกครั้ง?', 'استخدامه مرة أخرى؟'))) return;
      var tgt = P.target, area = P.area;
      closeOverlay('prPicker');
      if (tgt === 'edit') fillEdit(r, area); else fillNaming(r, area);
    }
  }
  function onPickerInput(e) {
    if (!P) return;
    if (e.target.getAttribute('data-m') === 'pq') {
      P.q = e.target.value;
      var el = document.getElementById('prPickList'); if (el) el.innerHTML = pickListHtml();
    }
  }

  // ── Applying a row to a form ────────────────────────────────────────
  function el(id) { return document.getElementById(id); }
  function setVal(id, v) { var x = el(id); if (x && v != null && v !== '') { x.value = v; return true; } return false; }
  function setSelect(id, v) {
    var s = el(id); if (!s || v == null || v === '') return false;
    var hit = null;
    for (var i = 0; i < s.options.length; i++) {
      if (String(s.options[i].value) === String(v) || norm(s.options[i].value) === norm(v)) { hit = s.options[i].value; break; }
    }
    if (hit == null) {
      var o = document.createElement('option');
      o.value = v; o.textContent = v;
      s.appendChild(o);
      hit = v;
    }
    s.value = hit;
    return true;
  }
  function areaInfo(boxId, r, drawn) {
    var box = el(boxId); if (!box) return;
    var txt = '📋 ' + esc(displayName(r));
    var warn = false;
    if (r.area && drawn) {
      var d = (drawn - r.area) / r.area;
      warn = Math.abs(d) > 0.1;
      txt += '<br>📐 ' + tt('בטבלה', 'ในตาราง', 'في الجدول') + ': <b>' + fmt(r.area, 2) + '</b> · ' +
        tt('משורטט', 'ที่วาด', 'المرسوم') + ': <b>' + fmt(drawn, 2) + '</b> ' + tt('דונם', 'ดูนัม', 'دونم') +
        ' (' + (d > 0 ? '+' : '') + Math.round(d * 100) + '%)';
      if (warn) txt += '<br>⚠️ ' + tt('פער גדול — בדוק את הקו המשורטט', 'ต่างกันมาก — ตรวจสอบเส้นที่วาด', 'فرق كبير — تحقق من الخط المرسوم');
    } else if (r.area) {
      txt += '<br>📐 ' + tt('שטח רשום', 'พื้นที่ที่จดทะเบียน', 'المساحة المسجلة') + ': ' + fmt(r.area, 2) + ' ' + tt('דונם', 'ดูนัม', 'دونم');
    }
    box.className = 'pr-info' + (warn ? ' warn' : '');
    box.innerHTML = txt;
    box.style.display = '';
  }
  function fillNaming(r, drawn) {
    injectCss();
    setVal('plotNameInput', displayName(r));
    if (r.farm_id) setSelect('plotFarmSelect', r.farm_id);
    if (r.crop) setSelect('plotCropType', r.crop);
    setVal('plotVariety', r.variety);
    var notes = composeNotes(r);
    if (notes) setVal('plotNotes', notes);
    if (r.row_spacing && r.tree_spacing) {
      var ms = el('manualSpacingRow'); if (ms) ms.style.display = 'block';
      setVal('plotRowSpacing', r.row_spacing);
      setVal('plotTreeSpacing', r.tree_spacing);
    }
    if (r.plants_per_dunam) setVal('plotPlantsPerDunam', r.plants_per_dunam);
    if (r.tree_count != null) {
      setVal('plotTreeCount', r.tree_count);
      var en = el('treeEstimateNum'); if (en) en.textContent = Number(r.tree_count).toLocaleString();
      var em = el('treeEstimateMeta'); if (em) em.textContent = tt('מהמאגר', 'จากคลัง', 'من المخزن');
    }
    setVal('plotDeclaredArea', r.area);
    setVal('plotRegisterRowId', r.id);
    areaInfo('plotRegisterInfo', r, drawn);
    toast('📋 ' + tt('הנתונים הוחלו — בדוק ולחץ שמור', 'ใช้ข้อมูลแล้ว — ตรวจสอบแล้วกดบันทึก', 'تم تطبيق البيانات — راجع واضغط حفظ'));
  }
  function fillEdit(r, measured) {
    injectCss();
    setVal('pdEditName', displayName(r));
    if (r.farm_id) setSelect('pdEditFarm', r.farm_id);
    if (r.crop) setSelect('pdEditCrop', r.crop);
    setVal('pdEditVariety', r.variety);
    var notes = composeNotes(r), ne = el('pdEditNotes');
    if (notes && ne) {
      var cur = ne.value.trim();
      ne.value = (cur && cur.indexOf(notes) === -1) ? cur + '\n' + notes : (cur || notes);
    }
    setVal('pdEditRowSpacing', r.row_spacing);
    setVal('pdEditTreeSpacing', r.tree_spacing);
    setVal('pdEditPlantsPerDunam', r.plants_per_dunam);
    setVal('pdEditArea', r.area);
    if (r.tree_count != null) setVal('pdEditTreeCount', r.tree_count);
    setVal('pdRegisterRowId', r.id);
    areaInfo('pdRegisterInfo', r, measured);
    toast('📋 ' + tt('הנתונים הוחלו — בדוק ולחץ שמור', 'ใช้ข้อมูลแล้ว — ตรวจสอบแล้วกดบันทึก', 'تم تطبيق البيانات — راجع واضغط حفظ'));
  }

  // Called by app.js once the plot is saved, so the row shows as assigned.
  function markUsed(rowId, plotId) {
    if (!rowId || !canEdit()) return;
    var go = function () {
      var r = reg.rows.filter(function (x) { return String(x.id) === String(rowId); })[0];
      if (!r) return;
      r.usedBy = plotId;
      persist();
    };
    if (reg) go(); else load().then(go);
  }
  // Varieties already known to the register, for the variety field's list.
  function varieties() {
    if (!reg) {
      try { var c = JSON.parse(localStorage.getItem(REG_KEY) || 'null'); if (c && c.rows) reg = c; } catch (e) {}
    }
    var seen = {};
    ((reg && reg.rows) || []).forEach(function (r) { if (r.variety) seen[String(r.variety).trim()] = 1; });
    return Object.keys(seen);
  }

  // ── Entry point on the map's + menu ─────────────────────────────────
  function refreshFabEntry() {
    var b = document.getElementById('btnPlotRegister'); if (!b) return;
    b.style.display = canEdit() ? '' : 'none';
    var t1 = b.querySelector('.fab-option-text'), t2 = b.querySelector('.fab-option-sub');
    if (t1) t1.textContent = tt('מאגר נתוני חלקות', 'คลังข้อมูลแปลง', 'مخزن بيانات القطع');
    if (t2) t2.textContent = tt('העלאת טבלה או PDF', 'อัปโหลดตารางหรือ PDF', 'رفع جدول أو PDF');
  }
  function init() {
    var opts = document.getElementById('fabOptions');
    if (!opts || document.getElementById('btnPlotRegister')) return;
    var b = document.createElement('button');
    b.className = 'fab-option';
    b.id = 'btnPlotRegister';
    b.innerHTML = '<div class="fab-option-icon" style="background:#e3f2fd;color:#1565c0;">📋</div>' +
      '<div><div class="fab-option-text"></div><div class="fab-option-sub"></div></div>';
    b.addEventListener('click', function () {
      opts.classList.remove('show');
      var fm = document.getElementById('fabMain'); if (fm) fm.classList.remove('open');
      openManager();
    });
    opts.appendChild(b);
    refreshFabEntry();
    var fm = document.getElementById('fabMain');
    if (fm) fm.addEventListener('click', refreshFabEntry);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    openManager: openManager,
    pickFor: pickFor,
    markUsed: markUsed,
    varieties: varieties,
    // exposed for tests
    _matchFarm: matchFarm,
    _displayName: displayName,
    _composeNotes: composeNotes
  };
})();
