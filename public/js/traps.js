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
 *        checks: [{id,trapId,date,count,by,note}] }  — worker+ write (rules).
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
    return { traps: Array.isArray(d.traps) ? d.traps : [], checks: Array.isArray(d.checks) ? d.checks : [] };
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
        (staff() ? '<button class="tr-btn" data-a="trap">📍 ' + tt('מלכודת חדשה', 'กับดักใหม่', 'مصيدة جديدة') + '</button>' : '') +
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
          '<td>' + (staff() ? '<button class="tr-x" data-edit="' + t.id + '">✏️</button>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      '<h4 style="margin:12px 0 4px;">' + tt('ספירות אחרונות', 'การนับล่าสุด', 'آخر العدّات') + '</h4>' +
      D.checks.filter(function (c) { return traps.some(function (t) { return String(t.id) === String(c.trapId); }); })
        .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, 30).map(function (c) {
          var t = trapById(c.trapId);
          return '<div class="tr-ck"><span>' + fmtD(c.date) + '</span><b>' + esc(t ? t.name : '?') + '</b><span class="tr-cn">' + c.count + '</span><small>' + esc(c.by || '') + (c.note ? ' · ' + esc(c.note) : '') + '</small>' +
            (staff() ? '<button class="tr-x" data-delck="' + c.id + '">🗑</button>' : '') + '</div>';
        }).join('');
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
      var d = document.getElementById('trDate').value, note = document.getElementById('trNote').value.trim(), u = window.currentUser || {}, n = 0;
      if (!d) return;
      document.querySelectorAll('.tr-cnt').forEach(function (inp) {
        if (inp.value === '') return;
        var tid = inp.getAttribute('data-t');
        // One count per trap per day: a re-entry replaces it.
        D.checks = D.checks.filter(function (c) { return !(String(c.trapId) === tid && c.date === d); });
        D.checks.push({ id: uid() + n, trapId: /^\d+$/.test(tid) ? Number(tid) : tid, date: d, count: Math.max(0, parseInt(inp.value, 10) || 0), by: u.name || u.username || '', note: note });
        n++;
      });
      if (!n) { toast('⚠️ ' + tt('לא הוזנו ספירות', 'ไม่มีการนับ', 'لم تُدخل أعداد')); return; }
      persist().then(function (ok) { if (ok) toast('✅ ' + n + ' ' + tt('ספירות נשמרו', 'บันทึกแล้ว', 'حُفظت')); render(); });
    };
  }

  function trapForm(id) {
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
      if (!t.id) { t.id = uid(); D.traps.push(t); } else D.traps = D.traps.map(function (x) { return String(x.id) === String(t.id) ? t : x; });
      ui.zone = t.zone;
      persist().then(function (ok) { if (ok) toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ')); render(); });
    };
  }

  function mapView() {
    var body = document.getElementById('trBody');
    var pts = D.traps.filter(function (t) { return isFinite(Number(t.lat)) && isFinite(Number(t.lng)) && t.lat != null; });
    if (!pts.length || typeof L === 'undefined') { body.innerHTML = '<button class="tr-btn ghost" data-a="back">→ ' + tt('חזרה', 'กลับ', 'رجوع') + '</button><div class="tr-empty">' + tt('אין מלכודות עם מיקום. ערוך מלכודת והוסף מיקום.', 'ไม่มีตำแหน่ง', 'لا مواقع') + '</div>'; return; }
    body.innerHTML = '<button class="tr-btn ghost" data-a="back">→ ' + tt('חזרה', 'กลับ', 'رجوع') + '</button><div id="trMap" style="height:420px;border-radius:16px;margin-top:8px;"></div>' +
      '<div class="tr-muted">' + tt('צבע לפי הספירה האחרונה: ירוק 0 · צהוב 1–2 · כתום 3–5 · אדום 6+', 'สีตามการนับล่าสุด', 'اللون حسب آخر عدّ') + '</div>';
    map = L.map('trMap', { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
    var b = L.latLngBounds([]);
    pts.forEach(function (t) {
      var lc = lastCount(t), n = lc ? lc.count : null;
      var col = n == null ? '#999' : n === 0 ? '#2e7d32' : n <= 2 ? '#e0c000' : n <= 5 ? '#ef8a17' : '#c62828';
      L.circleMarker([t.lat, t.lng], { radius: 9, color: '#fff', weight: 2, fillColor: col, fillOpacity: 1 }).addTo(map)
        .bindTooltip(esc(t.name) + ' · ' + esc(t.zone) + (lc ? ' · ' + n + ' (' + fmtD(lc.date) + ')' : ''), { direction: 'top' });
      b.extend([t.lat, t.lng]);
    });
    map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
  }

  function printReport() {
    var weeks = lastWeeks(8), z = zones(), names = Object.keys(z).sort(function (a, b) { return a.localeCompare(b, 'he'); });
    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8"><title>לכידות חדקונית ' + year + '</title><style>' +
      'body{font-family:Rubik,Arial,sans-serif;margin:14px;color:#1b2a1f;}h1{font-size:1.1rem;color:#12401f;}table{width:100%;border-collapse:collapse;font-size:.8rem;}' +
      'th{background:#eef7d4;padding:6px;text-align:center;}td{padding:6px;border-bottom:1px solid #ddd;text-align:center;}td:first-child{text-align:right;font-weight:700;}' +
      '@page{size:A4 landscape;margin:10mm;}</style></head><body><h1>🪲 לכידות חדקונית הדקל האדומה לפי אזורים · ' + new Date().toLocaleDateString('he-IL') + '</h1>' +
      '<table><tr><th>אזור</th>' + weeks.map(function (w) { return '<th>' + fmtD(w) + '</th>'; }).join('') + '<th>סה"כ</th></tr>' +
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
      if (k === 'back') return render();
      if (k === 'check') return checkForm();
      if (k === 'trap') return trapForm(null);
      if (k === 'map') return mapView();
      if (k === 'print') return printReport();
    }
    var ed = t.closest('[data-edit]'); if (ed) return trapForm(ed.getAttribute('data-edit'));
    var dc = t.closest('[data-delck]');
    if (dc) {
      if (!confirm(tt('למחוק את הספירה?', 'ลบ?', 'حذف؟'))) return;
      var id = dc.getAttribute('data-delck');
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
      '.tr-ck small{color:var(--text-muted,#6f7b72);}.tr-cn{font-weight:700;text-align:center;}.tr-x{border:0;background:var(--tonal,#f1f4ee);border-radius:9px;height:30px;cursor:pointer;}';
    document.head.appendChild(st);
  }

  return { open: open, close: close, _weekStart: weekStart };
})();
window.Traps = Traps;
