/* traps.js — לכידות חדקונית הדקל האדומה לפי אזורי לכידה (Oct 2026)
 *
 * Traps grouped into zones (a zone is a name — an area, a farm block). A
 * check records how many weevils a trap held on a date. The screen shows,
 * per zone, the last 8 weeks of captures, the trend, and an alert when the
 * latest week jumps above the zone's recent average. A map shows each trap
 * coloured by its latest count.
 *
 * No official public source publishes regional capture counts (checked
 * Oct 2026), so the data is ours: entered by whoever checks the traps.
 *
 * Data: appData/shorashim-traps-YYYY  { traps: [{id,name,zone,farmId,lat,lng}],
 *        checks: [{id,trapId,date,count,by,note}], zones: [{name, ring:[{lat,lng}]}] }
 * Counts can also be read from a photo / PDF of the field sheet (trapsExtract
 * function) and reviewed row by row; many traps can be added at once, and
 * zones are drawn on the map, traps placed by tapping.  — worker+ write (rules).
 * Public: Traps.open()
 */
var Traps = (function () {
  'use strict';

  var PREFIX = 'shorashim-traps-';
  var year = String(new Date().getFullYear());
  var D = null, lastSaved = '', listening = {}, ui = { zone: '', view: 'zones' }, map = null;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function S() { return window.SprayStore || {}; }
  function key() { return PREFIX + year; }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  function staff() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator'; }
  function canWrite() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator' || r === 'worker'; }
  function norm(d) {
    d = d && typeof d === 'object' ? d : {};
    return { traps: Array.isArray(d.traps) ? d.traps : [], checks: Array.isArray(d.checks) ? d.checks : [], zones: Array.isArray(d.zones) ? d.zones : [] };
  }
  function today() { return new Date().toISOString().slice(0, 10); }
  function fmtD(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] : iso; }

  function load() {
    return new Promise(function (resolve) {
      if (typeof DB === 'undefined') { D = norm(null); resolve(); return; }
      DB.loadAsync(key()).then(function (d) { D = norm(d); resolve(); }, function () { D = norm(null); resolve(); });
      if (DB.listen && !listening[year]) {
        listening[year] = true;
        var y = year;
        DB.listen(PREFIX + y, function (d) {
          if (!d || y !== year) return;
          var s = JSON.stringify(d);
          if (s === lastSaved) return;
          D = norm(d);
          if (document.getElementById('trRoot') && !document.querySelector('#trRoot .tr-form')) render();
        });
      }
    });
  }
  function persist() {
    var clean = JSON.parse(JSON.stringify(D));
    lastSaved = JSON.stringify(clean);
    var p = DB.saveAsync ? DB.saveAsync(key(), clean) : (DB.save(key(), clean), Promise.resolve());
    return p.then(function () { return true; }, function (e) {
      var c = String((e && (e.code || e.message)) || e);
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + (/permission/i.test(c) ? tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية') : c));
      return false;
    });
  }

  // ── weeks ──
  function weekStart(iso) {
    var d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() - d.getDay());     // Sunday
    return d.toISOString().slice(0, 10);
  }
  function lastWeeks(n) {
    var out = [], d = new Date(weekStart(today()) + 'T12:00:00');
    for (var i = 0; i < n; i++) { out.unshift(d.toISOString().slice(0, 10)); d.setDate(d.getDate() - 7); }
    return out;
  }
  function zones() {
    var z = {};
    D.traps.forEach(function (t) { var k = t.zone || tt('ללא אזור', 'ไม่มีโซน', 'بلا منطقة'); (z[k] = z[k] || []).push(t); });
    return z;
  }
  function trapById(id) { return D.traps.find(function (t) { return String(t.id) === String(id); }); }
  // Weekly totals for a set of traps.
  function series(traps, weeks) {
    var ids = {}; traps.forEach(function (t) { ids[t.id] = 1; });
    var out = weeks.map(function () { return 0; }), has = weeks.map(function () { return false; });
    D.checks.forEach(function (c) {
      if (!ids[c.trapId]) return;
      var k = weeks.indexOf(weekStart(c.date));
      if (k === -1) return;
      out[k] += Number(c.count) || 0; has[k] = true;
    });
    return { v: out, has: has };
  }
  function alertOf(sr) {
    var n = sr.v.length, last = sr.v[n - 1], prev = sr.v.slice(Math.max(0, n - 5), n - 1).filter(function (x, i) { return sr.has[Math.max(0, n - 5) + i]; });
    if (!sr.has[n - 1] || prev.length < 2) return null;
    var avg = prev.length ? prev.reduce(function (a, b) { return a + b; }, 0) / prev.length : 0;
    if (last >= 3 && last > avg * 1.5) return { lvl: 'up', avg: avg, last: last };
    if (prev.length && last < avg * 0.6) return { lvl: 'down', avg: avg, last: last };
    return null;
  }
  function lastCount(t) {
    var c = D.checks.filter(function (x) { return String(x.trapId) === String(t.id); }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })[0];
    return c ? c : null;
  }

  // ── UI ──
  function open() { ensureCss(); load().then(render); }
  function close() { if (map) { try { map.remove(); } catch (e) {} map = null; } var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  // Tables show the newest week first; series stay oldest → newest.
  function heads(weeks) { return weeks.slice().reverse().map(function (w, i) { return '<th>' + (i === 0 ? tt('השבוע', 'สัปดาห์นี้', 'هذا الأسبوع') : fmtD(w)) + '</th>'; }).join(''); }
  function cells(sr) {
    var out = '';
    for (var i = sr.v.length - 1; i >= 0; i--) out += '<td class="n' + (sr.has[i] ? '' : ' e') + (i === sr.v.length - 1 ? ' cur' : '') + '">' + (sr.has[i] ? sr.v[i] : '·') + '</td>';
    return out;
  }
  function sparkSvg(sr) {
    var max = Math.max.apply(null, sr.v.concat([1])), w = 120, h = 34, bw = w / sr.v.length;
    return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" style="direction:ltr">' + sr.v.map(function (v, i) {
      var bh = Math.round(v / max * (h - 4));
      return '<rect x="' + (i * bw + 1) + '" y="' + (h - bh) + '" width="' + (bw - 2) + '" height="' + Math.max(bh, sr.has[i] ? 1 : 0) + '" rx="2" fill="' + (i === sr.v.length - 1 ? '#c62828' : '#5e9c35') + '" opacity="' + (sr.has[i] ? 1 : .25) + '"/>';
    }).join('') + '</svg>';
  }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m || !D) return;
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    var weeks = lastWeeks(8), z = zones(), names = Object.keys(z).sort(function (a, b) { return a.localeCompare(b, 'he'); });
    var yrs = []; for (var y = new Date().getFullYear(); y >= new Date().getFullYear() - 3; y--) yrs.push(String(y));
    var alerts = [];
    var rows = names.map(function (zn) {
      var sr = series(z[zn], weeks), al = alertOf(sr);
      if (al && al.lvl === 'up') alerts.push(zn);
      var total = sr.v.reduce(function (a, b) { return a + b; }, 0);
      return '<tr data-zone="' + esc(zn) + '"><td><b>' + esc(zn) + '</b><small>' + z[zn].length + ' ' + tt('מלכודות', 'กับดัก', 'مصائد') + '</small></td>' +
        cells(sr) +
        '<td>' + sparkSvg(sr) + '</td><td class="n"><b>' + total + '</b></td>' +
        '<td>' + (al ? (al.lvl === 'up' ? '<span class="tr-al up">▲ ' + tt('עלייה', 'เพิ่มขึ้น', 'ارتفاع') + '</span>' : '<span class="tr-al dn">▼ ' + tt('ירידה', 'ลดลง', 'انخفاض') + '</span>') : '') + '</td></tr>';
    }).join('');
    m.innerHTML = '<div class="modal-overlay" id="trRoot"><div class="modal tr">' +
      '<div class="tr-h"><h2>🪲 ' + tt('לכידות חדקונית לפי אזורים', 'การจับด้วงงวงตามโซน', 'صيد السوسة حسب المناطق') + '</h2>' +
        '<select class="form-input tr-y" id="trYear">' + yrs.map(function (x) { return '<option' + (x === year ? ' selected' : '') + '>' + x + '</option>'; }).join('') + '</select>' +
        '<button class="tr-btn ghost" data-a="close">✕</button></div>' +
      (alerts.length ? '<div class="tr-warn">⚠️ ' + tt('עלייה חדה בלכידות השבוע באזור', 'จับได้เพิ่มขึ้นมากในโซน', 'ارتفاع حاد في الصيد في منطقة') + ': <b>' + alerts.map(esc).join(', ') + '</b></div>' : '') +
      '<div class="tr-bar">' +
        (canWrite() ? '<button class="tr-btn pri" data-a="check">＋ ' + tt('רישום ספירה', 'บันทึกการนับ', 'تسجيل عدّ') + '</button>' : '') +
        (canWrite() ? '<button class="tr-btn" data-a="scan">📷 ' + tt('מתמונה / מסמך', 'จากรูป/เอกสาร', 'من صورة/مستند') + '</button>' : '') +
        (staff() ? '<button class="tr-btn" data-a="trap">📍 ' + tt('מלכודת חדשה', 'กับดักใหม่', 'مصيدة جديدة') + '</button>' : '') +
        (staff() ? '<button class="tr-btn" data-a="bulk">➕ ' + tt('כמה מלכודות', 'หลายกับดัก', 'عدة مصائد') + '</button>' : '') +
        '<button class="tr-btn ghost" data-a="map">🗺 ' + tt('מפה', 'แผนที่', 'خريطة') + '</button>' +
        '<button class="tr-btn ghost" data-a="print">🖨 ' + tt('הדפסה', 'พิมพ์', 'طباعة') + '</button>' +
      '</div>' +
      '<div id="trBody">' +
      (names.length ? '<div class="tr-wrap"><table class="tr-tbl"><thead><tr><th>' + tt('אזור', 'โซน', 'المنطقة') + '</th>' +
        heads(weeks) + '<th>' + tt('מגמה', 'แนวโน้ม', 'الاتجاه') + '</th><th>' + tt('סה"כ', 'รวม', 'المجموع') + '</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="tr-muted">' + tt('שבועות מתחילים ביום א׳ · לחיצה על אזור מציגה את המלכודות שלו · התראה: השבוע מעל פי 1.5 מממוצע 4 השבועות הקודמים', 'สัปดาห์เริ่มวันอาทิตย์', 'الأسابيع تبدأ الأحد') + '</div>'
        : '<div class="tr-empty">' + (staff() ? tt('עוד אין מלכודות. הוסף מלכודת עם שם ואזור, ואז רשום ספירות.', 'ยังไม่มีกับดัก', 'لا مصائد بعد') : tt('עוד לא הוגדרו מלכודות.', 'ยังไม่มีกับดัก', 'لا مصائد بعد')) + '</div>') +
      '</div></div></div>';
    var root = document.getElementById('trRoot');
    root.addEventListener('click', onClick);
    document.getElementById('trYear').onchange = function () { year = this.value; open(); };
  }

  function zoneView(zn) {
    var traps = zones()[zn] || [];
    var body = document.getElementById('trBody');
    var weeks = lastWeeks(8);
    body.innerHTML = '<button class="tr-btn ghost" data-a="back">→ ' + tt('כל האזורים', 'ทุกโซน', 'كل المناطق') + '</button>' +
      '<h3 style="margin:10px 0 6px;">' + esc(zn) + '</h3>' +
      '<div class="tr-wrap"><table class="tr-tbl"><thead><tr><th>' + tt('מלכודת', 'กับดัก', 'مصيدة') + '</th>' + heads(weeks) +
        '<th>' + tt('ספירה אחרונה', 'ล่าสุด', 'آخر عدّ') + '</th><th></th></tr></thead><tbody>' +
      traps.map(function (t) {
        var sr = series([t], weeks), lc = lastCount(t);
        return '<tr><td><b>' + esc(t.name) + '</b>' + (t.farmId ? '<small>' + esc(farmName(t.farmId)) + '</small>' : '') + '</td>' +
          cells(sr) +
          '<td>' + (lc ? '<b>' + lc.count + '</b> <small>' + fmtD(lc.date) + '</small>' : '—') + '</td>' +
          '<td>' + (staff() && mine(t) ? '<button class="tr-x" data-edit="' + t.id + '">✏️</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<h4 style="margin:12px 0 4px;">' + tt('ספירות אחרונות', 'การนับล่าสุด', 'آخر العدّات') + '</h4>' +
      D.checks.filter(function (c) { return traps.some(function (t) { return String(t.id) === String(c.trapId); }); })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, 30).map(function (c) {
          var t = trapById(c.trapId);
          return '<div class="tr-ck"><span>' + fmtD(c.date) + '</span><b>' + esc(t ? t.name : '?') + '</b><span class="tr-cn">' + c.count + '</span><small>' + esc(c.by || '') + (c.note ? ' · ' + esc(c.note) : '') + '</small>' +
            (mine(c) ? '<button class="tr-x" data-delck="' + c.id + '">🗑</button>' : '') + '</div>';
        }).join('') +
        (window.Comments ? Comments.block('zone:' + hkey(zn), zn) : '');
  }

  // Ownership rule (ownership.js): people change only the traps, zones and
  // counts they entered; admin changes anything. `by` names the author of
  // counts entered before the rule.
  function mine(o) { return !window.Own || Own.canEdit(o, o && o.by); }
  function hkey(str) { var h = 0; str = String(str || ''); for (var i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function stampIt(o) { if (window.Own) Own.stamp(o); return o; }
  // One count per trap per day: a re-entry replaces the earlier one — only
  // if it is yours to replace.
  function replaceCheck(tid, d, rec) {
    var old = D.checks.filter(function (c) { return String(c.trapId) === String(tid) && c.date === d; });
    if (old.some(function (c) { return !mine(c); })) return false;
    D.checks = D.checks.filter(function (c) { return !(String(c.trapId) === String(tid) && c.date === d); });
    D.checks.push(stampIt(rec));
    return true;
  }
  function farmName(id) { var f = (S().getFarms ? S().getFarms() : []).find(function (x) { return x.id === Number(id); }); return f ? f.name : ''; }

  function checkForm() {
    var body = document.getElementById('trBody');
    if (!D.traps.length) { toast('⚠️ ' + tt('הוסף קודם מלכודות', 'เพิ่มกับดักก่อน', 'أضف مصائد أولاً')); return; }
    var z = zones(), names = Object.keys(z).sort(function (a, b) { return a.localeCompare(b, 'he'); });
    body.innerHTML = '<div class="tr-form"><h3>＋ ' + tt('רישום ספירה', 'บันทึกการนับ', 'تسجيل عدّ') + '</h3>' +
      '<label>' + tt('תאריך', 'วันที่', 'التاريخ') + '<input type="date" class="form-input" id="trDate" value="' + today() + '"></label>' +
      '<div class="tr-muted">' + tt('הכנס מספר לכידות לכל מלכודת שנבדקה (ריק = לא נבדקה)', 'ใส่จำนวนต่อกับดัก', 'أدخل العدد لكل مصيدة') + '</div>' +
      names.map(function (zn) {
        return '<div class="tr-fz">' + esc(zn) + '</div>' + z[zn].map(function (t) {
          return '<label class="tr-fr"><span>' + esc(t.name) + '</span><input type="number" min="0" step="1" class="form-input tr-cnt" data-t="' + t.id + '" inputmode="numeric"></label>';
        }).join('');
      }).join('') +
      '<label>' + tt('הערה', 'หมายเหตุ', 'ملاحظة') + '<input class="form-input" id="trNote"></label>' +
      '<div class="tr-bar"><button class="tr-btn pri" id="trSaveCk">💾 ' + tt('שמירה', 'บันทึก', 'حفظ') + '</button><button class="tr-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    document.getElementById('trSaveCk').onclick = function () {
      var d = document.getElementById('trDate').value, note = document.getElementById('trNote').value.trim(), u = window.currentUser || {}, n = 0, skipped = 0;
      if (!d) return;
      document.querySelectorAll('.tr-cnt').forEach(function (inp) {
        if (inp.value === '') return;
        var tid = inp.getAttribute('data-t');
        if (!replaceCheck(tid, d, { id: uid() + n, trapId: /^\d+$/.test(tid) ? Number(tid) : tid, date: d, count: Math.max(0, parseInt(inp.value, 10) || 0), by: u.name || u.username || '', note: note })) { skipped++; return; }
        n++;
      });
      if (skipped) toast('🔒 ' + skipped + ' ' + tt('ספירות של אחרים לא הוחלפו', 'การนับของผู้อื่นไม่ถูกแทนที่', 'أعداد الآخرين لم تُستبدل'));
      if (!n) { if (!skipped) toast('⚠️ ' + tt('לא הוזנו ספירות', 'ไม่มีการนับ', 'لم تُدخل أعداد')); return; }
      persist().then(function (ok) { if (ok) toast('✅ ' + n + ' ' + tt('ספירות נשמרו', 'บันทึกแล้ว', 'حُفظت')); render(); });
    };
  }

  function trapForm(id) {
    if (id && !mine(trapById(id))) { if (window.Own) Own.denied(); return; }
    var t = id ? JSON.parse(JSON.stringify(trapById(id) || {})) : { name: '', zone: ui.zone || '', farmId: null };
    var zs = Object.keys(zones());
    var farms = S().getFarms ? S().getFarms() : [];
    var body = document.getElementById('trBody');
    body.innerHTML = '<div class="tr-form"><h3>📍 ' + (id ? tt('עריכת מלכודת', 'แก้ไขกับดัก', 'تعديل مصيدة') : tt('מלכודת חדשה', 'กับดักใหม่', 'مصيدة جديدة')) + '</h3>' +
      '<label>' + tt('שם / מספר', 'ชื่อ/หมายเลข', 'الاسم/الرقم') + '<input class="form-input" id="trName" value="' + esc(t.name) + '" placeholder="M-12"></label>' +
      '<label>' + tt('אזור לכידה', 'โซน', 'منطقة الصيد') + '<input class="form-input" id="trZone" list="trZones" value="' + esc(t.zone || '') + '" placeholder="' + esc(tt('למשל: פצאל צפון', 'เช่น…', 'مثلاً…')) + '"><datalist id="trZones">' + zs.map(function (z) { return '<option value="' + esc(z) + '">'; }).join('') + '</datalist></label>' +
      '<label>' + tt('משק (לא חובה)', 'ฟาร์ม', 'المزرعة') + '<select class="form-input" id="trFarm"><option value="">—</option>' + farms.map(function (f) { return '<option value="' + f.id + '"' + (Number(t.farmId) === f.id ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('') + '</select></label>' +
      '<div class="tr-g2"><label>' + tt('קו רוחב', 'ละติจูด', 'خط العرض') + '<input class="form-input" id="trLat" value="' + esc(t.lat || '') + '"></label><label>' + tt('קו אורך', 'ลองจิจูด', 'خط الطول') + '<input class="form-input" id="trLng" value="' + esc(t.lng || '') + '"></label></div>' +
      '<button type="button" class="tr-btn ghost" id="trGps">📡 ' + tt('המיקום שלי עכשיו', 'ตำแหน่งปัจจุบัน', 'موقعي الآن') + '</button>' +
      '<div class="tr-bar"><button class="tr-btn pri" id="trSaveT">💾 ' + tt('שמירה', 'บันทึก', 'حفظ') + '</button>' +
        (id ? '<button class="tr-btn warn" id="trDelT">🗑 ' + tt('מחיקה', 'ลบ', 'حذف') + '</button>' : '') +
        '<button class="tr-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    document.getElementById('trGps').onclick = function () {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(function (p) {
        document.getElementById('trLat').value = p.coords.latitude.toFixed(6); document.getElementById('trLng').value = p.coords.longitude.toFixed(6);
      }, function () { toast('❌ ' + tt('אין גישה למיקום', 'ไม่มีตำแหน่ง', 'لا وصول للموقع')); }, { enableHighAccuracy: true, timeout: 15000 });
    };
    var del = document.getElementById('trDelT');
    if (del) del.onclick = function () {
      if (!confirm(tt('למחוק את המלכודת ואת הספירות שלה?', 'ลบกับดัก?', 'حذف المصيدة؟'))) return;
      D.traps = D.traps.filter(function (x) { return String(x.id) !== String(id); });
      D.checks = D.checks.filter(function (c) { return String(c.trapId) !== String(id); });
      persist().then(render);
    };
    document.getElementById('trSaveT').onclick = function () {
      t.name = document.getElementById('trName').value.trim(); t.zone = document.getElementById('trZone').value.trim();
      var f = document.getElementById('trFarm').value; t.farmId = f ? Number(f) : null;
      var la = parseFloat(document.getElementById('trLat').value), lo = parseFloat(document.getElementById('trLng').value);
      t.lat = isFinite(la) ? la : null; t.lng = isFinite(lo) ? lo : null;
      if (!t.name || !t.zone) { toast('❌ ' + tt('חסר שם או אזור', 'ขาดชื่อหรือโซน', 'الاسم أو المنطقة ناقص')); return; }
      if (!t.id) { t.id = uid(); D.traps.push(stampIt(t)); } else D.traps = D.traps.map(function (x) { return String(x.id) === String(t.id) ? t : x; });
      ui.zone = t.zone;
      persist().then(function (ok) { if (ok) toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ')); render(); });
    };
  }

  // ── map: zones drawn as areas, traps as dots, the farm's plots for context ──
  // Staff draw a zone by tapping its corners, and place traps by tapping
  // where each one hangs (the zone's unplaced traps, one after another).
  var mapMode = null;   // { kind:'zone', name, pts:[] } | { kind:'place', zone, queue:[ids], i }
  function zoneLevel(zn) {
    var tz = zones()[zn] || [], sr = series(tz, lastWeeks(8)), k = -1;
    for (var i = sr.v.length - 1; i >= 0; i--) if (sr.has[i]) { k = i; break; }
    if (k < 0) return { col: '#9e9e9e', txt: '—' };
    var per = tz.length ? sr.v[k] / tz.length : 0;
    return { col: per === 0 ? '#2e7d32' : per <= 1 ? '#e0c000' : per <= 3 ? '#ef8a17' : '#c62828', txt: String(sr.v[k]) };
  }
  function trapCol(t) { var lc = lastCount(t), n = lc ? lc.count : null; return n == null ? '#999' : n === 0 ? '#2e7d32' : n <= 2 ? '#e0c000' : n <= 5 ? '#ef8a17' : '#c62828'; }
  function mapView() {
    var body = document.getElementById('trBody');
    if (typeof L === 'undefined') { body.innerHTML = '<div class="tr-empty">—</div>'; return; }
    var znames = Object.keys(zones()).sort(function (a, b) { return a.localeCompare(b, 'he'); });
    var tools = '';
    if (mapMode && mapMode.kind === 'zone') {
      tools = '<div class="tr-mode">✏️ ' + tt('מסמן את האזור', 'กำลังวาดโซน', 'رسم المنطقة') + ' <b>' + esc(mapMode.name) + '</b> — ' +
        tt('הקש על הפינות שלו במפה', 'แตะมุมบนแผนที่', 'اضغط على زواياها في الخريطة') + ' (' + mapMode.pts.length + ')' +
        '<span class="tr-bar"><button class="tr-btn pri" data-m="zdone">✔ ' + tt('סיום', 'เสร็จ', 'إنهاء') + '</button><button class="tr-btn" data-m="zundo">↩</button><button class="tr-btn ghost" data-m="cancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></span></div>';
    } else if (mapMode && mapMode.kind === 'place') {
      var cur = trapById(mapMode.queue[mapMode.i]);
      tools = '<div class="tr-mode">📍 ' + (cur ? tt('הקש היכן תלויה המלכודת', 'แตะตำแหน่งกับดัก', 'اضغط مكان المصيدة') + ' <b>' + esc(cur.name) + '</b> (' + (mapMode.i + 1) + '/' + mapMode.queue.length + ')' : '') +
        '<span class="tr-bar"><button class="tr-btn" data-m="pskip">' + tt('דלג', 'ข้าม', 'تخطٍّ') + '</button><button class="tr-btn pri" data-m="cancel">✔ ' + tt('סיום', 'เสร็จ', 'إنهاء') + '</button></span></div>';
    } else if (staff()) {
      tools = '<div class="tr-bar">' +
        '<select class="form-input tr-y" id="trMZone"><option value="">' + tt('אזור…', 'โซน…', 'منطقة…') + '</option>' + znames.map(function (z) { return '<option>' + esc(z) + '</option>'; }).join('') + '<option value="__new">＋ ' + tt('אזור חדש', 'โซนใหม่', 'منطقة جديدة') + '</option></select>' +
        '<button class="tr-btn" data-m="zone">✏️ ' + tt('סמן אזור במפה', 'วาดโซน', 'ارسم المنطقة') + '</button>' +
        '<button class="tr-btn" data-m="place">📍 ' + tt('מקם מלכודות', 'วางกับดัก', 'ضع المصائد') + '</button></div>';
    }
    body.innerHTML = '<button class="tr-btn ghost" data-a="back">→ ' + tt('חזרה', 'กลับ', 'رجوع') + '</button>' + tools +
      '<div id="trMap" style="height:460px;border-radius:16px;margin-top:8px;"></div>' +
      '<div class="tr-muted">' + tt('צבע האזור לפי ממוצע לכידות למלכודת בשבוע האחרון שנבדק · נקודה = מלכודת: ירוק 0 · צהוב 1–2 · כתום 3–5 · אדום 6+', 'สีโซนตามค่าเฉลี่ยต่อกับดัก', 'لون المنطقة حسب متوسط الصيد لكل مصيدة') + '</div>';
    var keepView = map ? { c: map.getCenter(), z: map.getZoom() } : null;
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    map = L.map('trMap', { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
    var b = L.latLngBounds([]);
    // plots, thin, for orientation
    var plots = (window.MapAccess && MapAccess.listPlotsWithRings) ? MapAccess.listPlotsWithRings() : [];
    var trapFarms = {}; D.traps.forEach(function (t) { if (t.farmId) trapFarms[t.farmId] = 1; });
    plots.forEach(function (p) {
      p.rings.forEach(function (r) {
        var ll = r.map(function (q) { return [Number(q.lat), Number(q.lng)]; });
        L.polyline(ll.concat([ll[0]]), { color: '#ffffff', weight: 1, opacity: 0.55, interactive: false }).addTo(map);
        if (trapFarms[p.farmId]) ll.forEach(function (x) { b.extend(x); });
      });
    });
    (D.zones || []).forEach(function (z) {
      if (!z.ring || z.ring.length < 3) return;
      var lv = zoneLevel(z.name), ll = z.ring.map(function (q) { return [q.lat, q.lng]; });
      L.polygon(ll, { color: lv.col, weight: 2.5, fillColor: lv.col, fillOpacity: 0.28 }).addTo(map)
        .bindTooltip('<b>' + esc(z.name) + '</b> · ' + lv.txt, { permanent: true, direction: 'center', className: 'tr-ztip' });
      ll.forEach(function (x) { b.extend(x); });
    });
    D.traps.forEach(function (t) {
      if (t.lat == null || !isFinite(Number(t.lat)) || !isFinite(Number(t.lng))) return;
      var lc = lastCount(t);
      L.circleMarker([Number(t.lat), Number(t.lng)], { radius: 8, color: '#fff', weight: 2, fillColor: trapCol(t), fillOpacity: 1 }).addTo(map)
        .bindTooltip(esc(t.name) + ' · ' + esc(t.zone) + (lc ? ' · ' + lc.count + ' (' + fmtD(lc.date) + ')' : ''), { direction: 'top' });
      b.extend([Number(t.lat), Number(t.lng)]);
    });
    if (mapMode && mapMode.kind === 'zone' && mapMode.pts.length) {
      var dl = mapMode.pts.map(function (q) { return [q.lat, q.lng]; });
      L.polyline(dl.concat(dl.length > 2 ? [dl[0]] : []), { color: '#ffeb3b', weight: 3, dashArray: '6 4' }).addTo(map);
      dl.forEach(function (x) { L.circleMarker(x, { radius: 5, color: '#ffeb3b', fillColor: '#ffeb3b', fillOpacity: 1 }).addTo(map); });
    }
    if (keepView) map.setView(keepView.c, keepView.z);
    else if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
    else map.setView([32.03, 35.47], 13);
    map.on('click', function (ev) {
      if (!mapMode) return;
      if (mapMode.kind === 'zone') { mapMode.pts.push({ lat: +ev.latlng.lat.toFixed(6), lng: +ev.latlng.lng.toFixed(6) }); mapView(); return; }
      if (mapMode.kind === 'place') {
        var t = trapById(mapMode.queue[mapMode.i]);
        if (t) { t.lat = +ev.latlng.lat.toFixed(6); t.lng = +ev.latlng.lng.toFixed(6); }
        mapMode.i++;
        if (mapMode.i >= mapMode.queue.length) { mapMode = null; persist().then(function (ok) { if (ok) toast('✅ ' + tt('המיקומים נשמרו', 'บันทึกตำแหน่งแล้ว', 'حُفظت المواقع')); mapView(); }); }
        else mapView();
      }
    });
  }
  function onMapTool(k) {
    if (k === 'cancel') {
      var placed = mapMode && mapMode.kind === 'place' && mapMode.i > 0;
      mapMode = null;
      if (placed) persist().then(mapView); else mapView();
      return;
    }
    if (k === 'zundo') { if (mapMode && mapMode.pts.length) mapMode.pts.pop(); mapView(); return; }
    if (k === 'pskip') { mapMode.i++; if (mapMode.i >= mapMode.queue.length) { onMapTool('cancel'); return; } mapView(); return; }
    if (k === 'zdone') {
      if (!mapMode || mapMode.pts.length < 3) { toast('⚠️ ' + tt('צריך לפחות 3 נקודות', 'ต้องมีอย่างน้อย 3 จุด', 'يلزم 3 نقاط على الأقل')); return; }
      var oldZ = (D.zones || []).find(function (z) { return z.name === mapMode.name; });
      if (oldZ && !mine(oldZ)) { mapMode = null; if (window.Own) Own.denied(); mapView(); return; }
      D.zones = (D.zones || []).filter(function (z) { return z.name !== mapMode.name; });
      D.zones.push(oldZ ? { name: mapMode.name, ring: mapMode.pts, createdBy: oldZ.createdBy, createdByName: oldZ.createdByName, createdAt: oldZ.createdAt } : stampIt({ name: mapMode.name, ring: mapMode.pts }));
      mapMode = null;
      persist().then(function (ok) { if (ok) toast('✅ ' + tt('האזור נשמר', 'บันทึกโซนแล้ว', 'حُفظت المنطقة')); mapView(); });
      return;
    }
    var sel = document.getElementById('trMZone'), zn = sel ? sel.value : '';
    if (zn === '__new') {
      zn = (prompt(tt('שם האזור החדש', 'ชื่อโซนใหม่', 'اسم المنطقة الجديدة')) || '').trim();
    }
    if (!zn) { toast('⚠️ ' + tt('בחר אזור', 'เลือกโซน', 'اختر منطقة')); return; }
    if (k === 'zone') { mapMode = { kind: 'zone', name: zn, pts: [] }; mapView(); return; }
    if (k === 'place') {
      var tz = zones()[zn] || [];
      if (!tz.length) { toast('⚠️ ' + tt('אין מלכודות באזור הזה', 'ไม่มีกับดักในโซนนี้', 'لا مصائد في هذه المنطقة')); return; }
      tz = tz.filter(mine);
      if (!tz.length) { if (window.Own) Own.denied(); return; }
      var unplaced = tz.filter(function (t) { return t.lat == null || t.lat === ''; });
      var q = (unplaced.length ? unplaced : tz).map(function (t) { return t.id; });
      mapMode = { kind: 'place', zone: zn, queue: q, i: 0 }; mapView();
    }
  }

  // ── several traps at once ──
  function bulkForm() {
    var zs = Object.keys(zones()), farms = S().getFarms ? S().getFarms() : [];
    var body = document.getElementById('trBody');
    body.innerHTML = '<div class="tr-form"><h3>➕ ' + tt('הוספת מלכודות בבת אחת', 'เพิ่มกับดักหลายอัน', 'إضافة مصائد دفعة واحدة') + '</h3>' +
      '<label>' + tt('אזור לכידה', 'โซน', 'منطقة الصيد') + '<input class="form-input" id="tbZone" list="tbZones" value="' + esc(ui.zone || '') + '"><datalist id="tbZones">' + zs.map(function (z) { return '<option value="' + esc(z) + '">'; }).join('') + '</datalist></label>' +
      '<label>' + tt('משק (לא חובה)', 'ฟาร์ม', 'المزرعة') + '<select class="form-input" id="tbFarm"><option value="">—</option>' + farms.map(function (f) { return '<option value="' + f.id + '">' + esc(f.name) + '</option>'; }).join('') + '</select></label>' +
      '<div class="tr-g2"><label>' + tt('קידומת', 'คำนำหน้า', 'بادئة') + '<input class="form-input" id="tbPre" value="M-"></label>' +
      '<label>' + tt('ממספר', 'จากเลข', 'من رقم') + '<input class="form-input" id="tbFrom" type="number" min="0" value="1" inputmode="numeric"></label></div>' +
      '<label>' + tt('עד מספר', 'ถึงเลข', 'إلى رقم') + '<input class="form-input" id="tbTo" type="number" min="0" value="10" inputmode="numeric"></label>' +
      '<label>' + tt('או: רשימת שמות, שם בכל שורה', 'หรือ: รายชื่อ บรรทัดละชื่อ', 'أو: قائمة أسماء، اسم في كل سطر') + '<textarea class="form-input" id="tbList" rows="4" placeholder="A1&#10;A2&#10;…"></textarea></label>' +
      '<div class="tr-muted" id="tbPrev"></div>' +
      '<div class="tr-bar"><button class="tr-btn pri" id="tbSave">💾 ' + tt('הוסף', 'เพิ่ม', 'أضف') + '</button><button class="tr-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div>' +
      '<div class="tr-muted">' + tt('אחרי ההוספה: מפה ← "מקם מלכודות" כדי להצמיד כל אחת למקום שלה בהקשה.', 'จากนั้น: แผนที่ ← "วางกับดัก"', 'بعدها: الخريطة ← "ضع المصائد"') + '</div></div>';
    function names() {
      var lst = document.getElementById('tbList').value.split(/\n|,/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (lst.length) return lst;
      var pre = document.getElementById('tbPre').value, a = parseInt(document.getElementById('tbFrom').value, 10), z = parseInt(document.getElementById('tbTo').value, 10);
      if (!isFinite(a) || !isFinite(z) || z < a || z - a > 499) return [];
      var out = []; for (var i = a; i <= z; i++) out.push(pre + i); return out;
    }
    function prev() {
      var n = names(), ex = {}; D.traps.forEach(function (t) { ex[t.name] = 1; });
      var dup = n.filter(function (x) { return ex[x]; }).length;
      document.getElementById('tbPrev').textContent = n.length ? n.length + ' ' + tt('מלכודות', 'กับดัก', 'مصائد') + ': ' + n.slice(0, 4).join(', ') + (n.length > 4 ? ' … ' + n[n.length - 1] : '') + (dup ? ' · ' + dup + ' ' + tt('כבר קיימות וידולגו', 'มีอยู่แล้ว จะข้าม', 'موجودة وستُتخطّى') : '') : '';
    }
    ['tbPre', 'tbFrom', 'tbTo', 'tbList'].forEach(function (id) { document.getElementById(id).oninput = prev; });
    prev();
    document.getElementById('tbSave').onclick = function () {
      var zn = document.getElementById('tbZone').value.trim(), f = document.getElementById('tbFarm').value, n = names();
      if (!zn) { toast('❌ ' + tt('חסר אזור', 'ขาดโซน', 'المنطقة ناقصة')); return; }
      var ex = {}; D.traps.forEach(function (t) { ex[t.name] = 1; });
      var add = n.filter(function (x) { return !ex[x]; });
      if (!add.length) { toast('⚠️ ' + tt('אין מלכודות חדשות להוספה', 'ไม่มีกับดักใหม่', 'لا مصائد جديدة')); return; }
      var base = uid();
      add.forEach(function (nm, i) { D.traps.push(stampIt({ id: base + i, name: nm, zone: zn, farmId: f ? Number(f) : null, lat: null, lng: null })); });
      ui.zone = zn;
      persist().then(function (ok) { if (ok) toast('✅ ' + add.length + ' ' + tt('מלכודות נוספו', 'เพิ่มกับดักแล้ว', 'أُضيفت مصائد')); render(); });
    };
  }

  // ── counts from a photo / document ──
  function fileB64(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(blob); });
  }
  function shrink(file) {
    return new Promise(function (res) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var k = Math.min(1, 2000 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { res(b || file); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); res(file); };
      img.src = url;
    });
  }
  function scanForm() {
    if (!D.traps.length) { toast('⚠️ ' + tt('הוסף קודם מלכודות', 'เพิ่มกับดักก่อน', 'أضف مصائد أولاً')); return; }
    var body = document.getElementById('trBody');
    body.innerHTML = '<div class="tr-form"><h3>📷 ' + tt('עדכון ספירות מתמונה או מסמך', 'อัปเดตจากรูป/เอกสาร', 'تحديث الأعداد من صورة أو مستند') + '</h3>' +
      '<div class="tr-muted">' + tt('צלם את דף הבדיקה מהשטח או העלה PDF. כל שורה תוצג לאישורך לפני השמירה.', 'ถ่ายรูปแผ่นตรวจหรืออัปโหลด PDF', 'صوّر ورقة الفحص أو ارفع PDF') + '</div>' +
      '<label>' + tt('קובץ', 'ไฟล์', 'ملف') + '<input type="file" class="form-input" id="tsFile" accept="image/*,application/pdf"></label>' +
      '<label>' + tt('הערה לקורא (לא חובה)', 'หมายเหตุ', 'ملاحظة') + '<input class="form-input" id="tsHint" placeholder="' + esc(tt('למשל: אזור פצאל צפון, בדיקה של יום ראשון', 'เช่น โซน…', 'مثلاً…')) + '"></label>' +
      '<div class="tr-muted" id="tsMsg"></div>' +
      '<div class="tr-bar"><button class="tr-btn pri" id="tsRead">🔍 ' + tt('קרא', 'อ่าน', 'اقرأ') + '</button><button class="tr-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    document.getElementById('tsRead').onclick = function () {
      var f = (document.getElementById('tsFile').files || [])[0];
      if (!f) { toast('⚠️ ' + tt('בחר קובץ', 'เลือกไฟล์', 'اختر ملفًا')); return; }
      if (typeof firebase === 'undefined' || !firebase.app || !firebase.app().functions) { toast('❌ functions'); return; }
      var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
      if (isPdf && f.size > 6.5 * 1024 * 1024) { toast('❌ ' + tt('PDF גדול מדי (עד 6.5MB)', 'PDF ใหญ่เกินไป', 'PDF كبير جدًا')); return; }
      var btn = this; btn.disabled = true;
      document.getElementById('tsMsg').textContent = '⏳ ' + tt('קורא…', 'กำลังอ่าน…', 'جارٍ القراءة…');
      var hint = document.getElementById('tsHint').value;
      (isPdf ? fileB64(f) : shrink(f).then(fileB64)).then(function (b64) {
        var req = { traps: D.traps.map(function (t) { return { id: String(t.id), name: t.name, zone: t.zone }; }), hint: hint, year: year };
        if (isPdf) req.pdf = b64; else req.image = b64;
        return firebase.app().functions('us-central1').httpsCallable('trapsExtract', { timeout: 185000 })(req);
      }).then(function (r) { scanReview(r.data || {}); }, function (e) {
        btn.disabled = false;
        document.getElementById('tsMsg').textContent = '❌ ' + ((e && e.message) || e);
      });
    };
  }
  function scanReview(res) {
    var rows = res.rows || [], body = document.getElementById('trBody');
    if (!rows.length) { toast('⚠️ ' + tt('לא נמצאו שורות בקובץ', 'ไม่พบข้อมูล', 'لم يُعثر على صفوف')); scanForm(); return; }
    var opts = D.traps.slice().sort(function (a, b) { return (a.zone + a.name).localeCompare(b.zone + b.name, 'he'); });
    function sel(r, i) {
      return '<select class="form-input ts-t" data-i="' + i + '"><option value="">' + tt('— לא לשמור —', '— ไม่บันทึก —', '— لا تحفظ —') + '</option>' +
        (staff() ? '<option value="__new">＋ ' + tt('מלכודת חדשה', 'กับดักใหม่', 'مصيدة جديدة') + ' "' + esc(r.label) + '"</option>' : '') +
        opts.map(function (t) { return '<option value="' + esc(String(t.id)) + '"' + (String(t.id) === r.match_id ? ' selected' : '') + '>' + esc(t.name) + ' · ' + esc(t.zone) + '</option>'; }).join('') + '</select>';
    }
    var matched = rows.filter(function (r) { return r.match_id; }).length;
    body.innerHTML = '<div class="tr-form"><h3>📷 ' + tt('אישור הספירות שנקראו', 'ตรวจการนับ', 'تأكيد الأعداد') + '</h3>' +
      '<div class="tr-muted">' + rows.length + ' ' + tt('שורות', 'แถว', 'صفوف') + ' · ' + matched + ' ' + tt('הותאמו למלכודות קיימות', 'จับคู่แล้ว', 'طوبقت') + (res.notes ? ' · ' + esc(res.notes) : '') + '</div>' +
      '<label>' + tt('תאריך הבדיקה', 'วันที่ตรวจ', 'تاريخ الفحص') + '<input type="date" class="form-input" id="tsDate" value="' + esc(res.date || today()) + '"></label>' +
      '<div class="tr-wrap"><table class="tr-tbl ts-tbl"><thead><tr><th>' + tt('נקרא', 'อ่านได้', 'المقروء') + '</th><th>' + tt('מלכודת', 'กับดัก', 'مصيدة') + '</th><th>' + tt('לכידות', 'จำนวน', 'العدد') + '</th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        return '<tr' + (r.confidence === 'low' ? ' class="lo"' : '') + '><td><b>' + esc(r.label) + '</b>' + (r.zone ? '<small>' + esc(r.zone) + '</small>' : '') + (r.date ? '<small>' + fmtD(r.date) + '</small>' : '') + '</td>' +
          '<td>' + sel(r, i) + '</td><td><input type="number" min="0" class="form-input ts-c" data-i="' + i + '" value="' + r.count + '" inputmode="numeric"></td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<div class="tr-muted">' + tt('שורות בצהוב — הקורא לא היה בטוח. בדוק אותן.', 'แถวสีเหลือง: ไม่แน่ใจ', 'الصفوف الصفراء: غير مؤكدة') + '</div>' +
      '<div class="tr-bar"><button class="tr-btn pri" id="tsSave">💾 ' + tt('שמור ספירות', 'บันทึก', 'احفظ') + '</button><button class="tr-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    document.getElementById('tsSave').onclick = function () {
      var d0 = document.getElementById('tsDate').value || today(), u = window.currentUser || {}, n = 0, made = 0, base = uid();
      rows.forEach(function (r, i) {
        var v = document.querySelector('.ts-t[data-i="' + i + '"]').value, cnt = parseInt(document.querySelector('.ts-c[data-i="' + i + '"]').value, 10);
        if (!v || !isFinite(cnt)) return;
        var tid;
        if (v === '__new') {
          tid = base + 1000 + made++;
          D.traps.push(stampIt({ id: tid, name: r.label, zone: r.zone || ui.zone || tt('ללא אזור', 'ไม่มีโซน', 'بلا منطقة'), farmId: null, lat: null, lng: null }));
        } else tid = /^\d+$/.test(v) ? Number(v) : v;
        var d = r.date || d0;
        if (!replaceCheck(tid, d, { id: base + n, trapId: tid, date: d, count: Math.max(0, cnt), by: u.name || u.username || '', note: tt('מתמונה', 'จากรูป', 'من صورة') })) return;
        n++;
      });
      if (!n) { toast('⚠️ ' + tt('לא נבחרו שורות לשמירה', 'ไม่มีแถว', 'لا صفوف')); return; }
      persist().then(function (ok) { if (ok) toast('✅ ' + n + ' ' + tt('ספירות נשמרו', 'บันทึกแล้ว', 'حُفظت')); render(); });
    };
  }

  function printReport() {
    var weeks = lastWeeks(8), z = zones(), names = Object.keys(z).sort(function (a, b) { return a.localeCompare(b, 'he'); });
    var html = '<!DOCTYPE html><html dir="' + (document.documentElement.dir || 'rtl') + '" lang="' + (document.documentElement.lang || 'he') + '"><head><meta charset="utf-8"><title>' + esc(tt('לכידות חדקונית', 'การจับด้วงงวง', 'صيد السوسة')) + ' ' + year + '</title><style>' +
      'body{font-family:Rubik,Arial,sans-serif;margin:14px;color:#1b2a1f;}h1{font-size:1.1rem;color:#12401f;}table{width:100%;border-collapse:collapse;font-size:.8rem;}' +
      'th{background:#eef7d4;padding:6px;text-align:center;}td{padding:6px;border-bottom:1px solid #ddd;text-align:center;}td:first-child{text-align:start;font-weight:700;}' +
      '@page{size:A4 landscape;margin:10mm;}</style></head><body><h1>🪲 ' + esc(tt('לכידות חדקונית הדקל האדומה לפי אזורים', 'การจับด้วงงวงมะพร้าวตามโซน', 'صيد سوسة النخيل الحمراء حسب المناطق')) + ' · ' + new Date().toLocaleDateString('he-IL') + '</h1>' +
      '<table><tr><th>' + esc(tt('אזור', 'โซน', 'المنطقة')) + '</th>' + weeks.map(function (w) { return '<th>' + fmtD(w) + '</th>'; }).join('') + '<th>' + esc(tt('סה"כ', 'รวม', 'المجموع')) + '</th></tr>' +
      names.map(function (zn) { var sr = series(z[zn], weeks); return '<tr><td>' + esc(zn) + ' (' + z[zn].length + ')</td>' + sr.v.map(function (v, i) { return '<td>' + (sr.has[i] ? v : '·') + '</td>'; }).join('') + '<td><b>' + sr.v.reduce(function (a, b) { return a + b; }, 0) + '</b></td></tr>'; }).join('') +
      '</table></body></html>';
    if (window.Util && Util.exportReport) Util.exportReport(html, 'weevil-traps-' + year + '.html');
  }

  function onClick(e) {
    var t = e.target;
    if (t.id === 'trRoot') return close();
    var a = t.closest('[data-a]');
    if (a) {
      var k = a.getAttribute('data-a');
      if (k === 'close') return close();
      if (k === 'back') { mapMode = null; return render(); }
      if (k === 'check') return checkForm();
      if (k === 'trap') return trapForm(null);
      if (k === 'map') { mapMode = null; return mapView(); }
      if (k === 'scan') return scanForm();
      if (k === 'bulk') return bulkForm();
      if (k === 'print') return printReport();
    }
    var mt = t.closest('[data-m]'); if (mt) return onMapTool(mt.getAttribute('data-m'));
    var ed = t.closest('[data-edit]'); if (ed) return trapForm(ed.getAttribute('data-edit'));
    var dc = t.closest('[data-delck]');
    if (dc) {
      if (!confirm(tt('למחוק את הספירה?', 'ลบ?', 'حذف؟'))) return;
      var id = dc.getAttribute('data-delck');
      if (!mine(D.checks.find(function (c) { return String(c.id) === id; }))) { if (window.Own) Own.denied(); return; }
      D.checks = D.checks.filter(function (c) { return String(c.id) !== id; });
      persist().then(function () { zoneView(ui.zone); });
      return;
    }
    var row = t.closest('tr[data-zone]');
    if (row) { ui.zone = row.getAttribute('data-zone'); return zoneView(ui.zone); }
  }

  function ensureCss() {
    if (document.getElementById('trCss')) return;
    var st = document.createElement('style');
    st.id = 'trCss';
    st.textContent =
      '.tr{max-width:1000px !important;width:100%;}.tr-h{display:flex;gap:8px;align-items:center;margin-bottom:8px;}.tr-h h2{flex:1;margin:0;}.tr-y{width:auto !important;margin:0 !important;}' +
      '.tr-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:8px 12px;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;}' +
      '.tr-btn.pri{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.tr-btn.ghost{background:transparent;}.tr-btn.warn{color:#b3261e;}' +
      '.tr-bar{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0;}' +
      '.tr-warn{background:#fde9e7;color:#8c1d18;border-radius:14px;padding:10px 12px;font-size:.84rem;margin-bottom:6px;}' +
      '.tr-wrap{overflow-x:auto;border:1px solid var(--line,#e6ebe2);border-radius:14px;}' +
      '.tr-tbl{width:100%;border-collapse:collapse;font-size:.8rem;min-width:640px;}.tr-tbl th{background:var(--tonal,#f1f4ee);padding:7px 5px;font-weight:600;font-size:.72rem;white-space:nowrap;}' +
      '.tr-tbl td{padding:7px 5px;border-top:1px solid var(--line,#eef1ec);}.tr-tbl td small{display:block;color:var(--text-muted,#6f7b72);font-size:.68rem;}' +
      '.tr-tbl td.cur{font-weight:700;background:var(--primary-soft,#eef7d4);}' +
      '.tr-tbl td.n{text-align:center;font-variant-numeric:tabular-nums;}.tr-tbl td.e{color:var(--text-muted,#aaa);}.tr-tbl tbody tr[data-zone]{cursor:pointer;}.tr-tbl tbody tr[data-zone]:hover{background:var(--tonal,#f6f8f4);}' +
      '.tr-al{font-size:.72rem;font-weight:700;border-radius:8px;padding:2px 7px;white-space:nowrap;}.tr-al.up{background:#fde9e7;color:#b3261e;}.tr-al.dn{background:#e8f5e9;color:#2e7d32;}' +
      '.tr-muted{font-size:.72rem;color:var(--text-muted,#6f7b72);margin-top:6px;}.tr-empty{padding:30px 10px;text-align:center;color:var(--text-muted,#6f7b72);}' +
      '.tr-form label{display:flex;flex-direction:column;gap:4px;font-size:.76rem;color:var(--text-muted,#6f7b72);margin-bottom:8px;}' +
      '.tr-g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
      '.tr-fz{font-weight:700;margin:10px 0 4px;}.tr-fr{flex-direction:row !important;align-items:center;justify-content:space-between;gap:10px;font-size:.86rem !important;color:var(--text,#1b2a1f) !important;}' +
      '.tr-fr .form-input{width:90px;margin:0;}' +
      '.tr-ck{display:grid;grid-template-columns:60px 1fr 50px 1.5fr 34px;gap:6px;align-items:center;padding:6px 2px;border-top:1px solid var(--line,#eef1ec);font-size:.82rem;}' +
      '.tr-mode{background:#fffbea;border-radius:12px;padding:8px 10px;font-size:.84rem;margin-top:6px;}.tr-mode .tr-bar{margin:6px 0 0;}' +
      '.tr-ztip{background:rgba(255,255,255,.88);border:0;border-radius:8px;font-size:.72rem;padding:2px 6px;box-shadow:none;}' +
      '.ts-tbl{min-width:0;}.ts-tbl .form-input{margin:0;}.ts-tbl tr.lo td{background:#fff8d6;}.ts-c{width:80px;}' +
      '.tr-ck small{color:var(--text-muted,#6f7b72);}.tr-cn{font-weight:700;text-align:center;}.tr-x{border:0;background:var(--tonal,#f1f4ee);border-radius:9px;height:30px;cursor:pointer;}';
    document.head.appendChild(st);
  }

  document.addEventListener('shorashim:lang', function () { if (document.getElementById('trRoot') && D && !document.querySelector('#trRoot .tr-form') && !map) render(); });

  return { open: open, close: close, _weekStart: weekStart };
})();
window.Traps = Traps;
