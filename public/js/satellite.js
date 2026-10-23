/* satellite.js — מצב הצמחייה מהלוויין, Sentinel-2 (Oct 2026)
 *
 * Every 2–5 days a Sentinel-2 satellite passes over the valley. For each
 * plot polygon the sentinelNdvi Cloud Function returns, per clear pass, the
 * plot's mean NDVI (vigour / canopy density) and NDMI (canopy moisture),
 * with clouds, shadows and water masked out.
 *
 * What the screen is for: spotting the plot that is falling behind. A date
 * orchard never reaches the NDVI of a wheat field (the canopy covers only
 * part of the ground), so absolute numbers mean little — the screen compares
 * each plot with itself (last 30 days, same time last year) and with the
 * farm's other plots of the same crop, and flags what stands out.
 *
 * Data: appData/shorashim-sentinel-<farmId>
 *   { plots: { <plotId>: [{d,v,m,c}] }, fetched: { <plotId>: 'YYYY-MM-DD' },
 *     updated, by }    d date · v NDVI · m NDMI · c clear fraction
 *   Written by operator+ after a refresh (rules); everyone reads it.
 * Public: Satellite.open(farmId?)
 */
var Satellite = (function () {
  'use strict';

  var PREFIX = 'shorashim-sentinel-';
  var FIRST_DAYS = 400, KEEP_DAYS = 760, OVERLAP_DAYS = 20;
  var D = null, farmId = null, ui = { view: 'table', idx: 'v', plot: null }, busy = false, map = null;

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
  function staff() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator'; }
  function key() { return PREFIX + farmId; }
  function today() { return new Date().toISOString().slice(0, 10); }
  function addDays(iso, n) { var d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function days(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5); }
  function fmtD(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] : (iso || ''); }
  function fmtDY(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1].slice(2) : (iso || ''); }
  function norm(d) {
    d = d && typeof d === 'object' ? d : {};
    return { plots: d.plots && typeof d.plots === 'object' ? d.plots : {}, fetched: d.fetched && typeof d.fetched === 'object' ? d.fetched : {},
             updated: d.updated || 0, by: d.by || '' };
  }

  // ── plots of the farm, with polygons ──
  function farmPlots() {
    var info = {};
    (S().getFarmPlots ? S().getFarmPlots(farmId) : []).forEach(function (p) { info[p.id] = p; });
    var M = window.MapAccess;
    return (M && M.listPlotsWithRings ? M.listPlotsWithRings() : []).filter(function (p) {
      return p.farmId === farmId && p.rings && p.rings.length;
    }).map(function (p) {
      var i = info[p.id] || {};
      return { id: p.id, name: i.name || p.name, color: p.color, rings: p.rings, crop: p.crop || i.crop_type || '', branch: i.branch || '' };
    });
  }
  function farms() { return S().getFarms ? S().getFarms() : []; }

  function load() {
    return new Promise(function (resolve) {
      if (typeof DB === 'undefined') { D = norm(null); resolve(); return; }
      DB.loadAsync(key()).then(function (d) { D = norm(d); resolve(); }, function () { D = norm(null); resolve(); });
    });
  }
  function persist() {
    var clean = JSON.parse(JSON.stringify(D));
    var p = DB.saveAsync ? DB.saveAsync(key(), clean) : (DB.save(key(), clean), Promise.resolve());
    return p.then(function () { return true; }, function (e) {
      var c = String((e && (e.code || e.message)) || e);
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + (/permission/i.test(c) ? tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية') : c));
      return false;
    });
  }

  // ── series maths ──
  function series(pid) { return (D && D.plots[pid]) || []; }
  function near(pts, iso, tol) {
    var best = null, bd = Infinity;
    pts.forEach(function (p) { var d = Math.abs(days(p.d, iso)); if (d < bd) { bd = d; best = p; } });
    return bd <= tol ? best : null;
  }
  function median(a) { a = a.slice().sort(function (x, y) { return x - y; }); var n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : null; }
  function val(p) { return p ? (ui.idx === 'm' ? p.m : p.v) : null; }
  // A single pass can be hazy; "now" is the median of the passes in the
  // 15 days up to the plot's latest clear one.
  function current(pts) {
    if (!pts.length) return null;
    var last = pts[pts.length - 1].d;
    var vs = pts.filter(function (p) { return days(p.d, last) <= 15; }).map(val).filter(function (x) { return x != null; });
    return vs.length ? { d: last, v: median(vs) } : null;
  }
  function stats(list) {
    var cur = {};
    list.forEach(function (p) { cur[p.id] = current(series(p.id)); });
    var byCrop = {};
    list.forEach(function (p) { if (cur[p.id]) (byCrop[p.crop] = byCrop[p.crop] || []).push(p.id); });
    var out = {};
    list.forEach(function (p) {
      var c = cur[p.id], pts = series(p.id), r = { cur: c, d30: null, yoy: null, rel: null, flags: [] };
      if (c) {
        var a = near(pts, addDays(c.d, -30), 10);
        if (a && val(a) != null) r.d30 = c.v - val(a);
        var y = near(pts, addDays(c.d, -365), 12);
        if (y && val(y) != null) r.yoy = c.v - val(y);
        var peers = (byCrop[p.crop] || []).filter(function (id) { return cur[id] && Math.abs(days(cur[id].d, c.d)) <= 10; });
        if (peers.length >= 3) {
          var md = median(peers.map(function (id) { return cur[id].v; }));
          if (md > 0.05) r.rel = c.v / md - 1;
        }
        if (r.rel != null && r.rel <= -0.15) r.flags.push(tt('נמוך ב-', 'ต่ำกว่า ', 'أقل بـ') + Math.round(-r.rel * 100) + '%\u200f ' + tt('מחלקות דומות', 'แปลงพืชเดียวกัน', 'من القطع المماثلة'));
        if (r.d30 != null && r.d30 <= (ui.idx === 'm' ? -0.08 : -0.06)) r.flags.push(tt('ירידה ב-30 יום', 'ลดลงใน 30 วัน', 'انخفاض خلال 30 يومًا'));
        if (r.yoy != null && r.yoy <= -0.08) r.flags.push(tt('נמוך מאשתקד', 'ต่ำกว่าปีก่อน', 'أقل من العام الماضي'));
      }
      out[p.id] = r;
    });
    return out;
  }

  // ── colours ──
  function colV(v) { return v == null ? '#b0b7ae' : v < 0.2 ? '#c62828' : v < 0.3 ? '#ef6c00' : v < 0.4 ? '#f9a825' : v < 0.5 ? '#9ccc65' : v < 0.6 ? '#43a047' : '#1b5e20'; }
  function colM(v) { return v == null ? '#b0b7ae' : v < -0.1 ? '#c62828' : v < 0 ? '#ef6c00' : v < 0.1 ? '#f9a825' : v < 0.2 ? '#4fc3f7' : v < 0.3 ? '#0288d1' : '#01579b'; }
  function col(v) { return ui.idx === 'm' ? colM(v) : colV(v); }
  function f2(v) { return v == null ? '—' : v.toFixed(2); }
  function ltr(x) { return '<span dir="ltr">' + x + '</span>'; }
  function sgn(v) { if (v != null) v = Math.round(v * 100) / 100; return v == null ? '—' : ltr((v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2)); }
  function idxName() { return ui.idx === 'm' ? 'NDMI' : 'NDVI'; }

  // ── charts (time runs left → right in every language) ──
  function spark(pts, end) {
    var w = 130, h = 34, from = addDays(end, -365);
    var ps = pts.filter(function (p) { return p.d >= from && val(p) != null; });
    if (ps.length < 2) return '<span class="sat-mut">—</span>';
    var lo = ui.idx === 'm' ? -0.3 : 0, hi = ui.idx === 'm' ? 0.5 : 0.9;
    var xy = ps.map(function (p) {
      var x = days(from, p.d) / 365 * (w - 4) + 2, y = h - 2 - (Math.max(lo, Math.min(hi, val(p))) - lo) / (hi - lo) * (h - 4);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
    var last = xy[xy.length - 1].split(',');
    return '<svg class="sat-spark" style="direction:ltr" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
      '<polyline points="' + xy.join(' ') + '" fill="none" stroke="#5e9c35" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="2.6" fill="' + col(val(ps[ps.length - 1])) + '"/></svg>';
  }
  function bigChart(pts, end, idx) {
    var keep = ui.idx; ui.idx = idx;
    var W = (window.innerWidth || 800) < 600 ? 380 : 640, H = W < 600 ? 180 : 200, L = 34, R = 8, T = 10, B = 24, from = addDays(end, -365);
    var lo = idx === 'm' ? -0.3 : 0, hi = idx === 'm' ? 0.5 : 0.9;
    function X(iso) { return L + days(from, iso) / 365 * (W - L - R); }
    function Y(v) { return T + (1 - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (H - T - B); }
    function line(ps, shift, stroke, dash) {
      var a = ps.map(function (p) { return X(addDays(p.d, shift)).toFixed(1) + ',' + Y(val(p)).toFixed(1); });
      return a.length > 1 ? '<polyline points="' + a.join(' ') + '" fill="none" stroke="' + stroke + '" stroke-width="2"' + (dash ? ' stroke-dasharray="5 4"' : '') + ' stroke-linejoin="round"/>' : '';
    }
    var cur = pts.filter(function (p) { return p.d >= from && val(p) != null; });
    var prev = pts.filter(function (p) { return p.d >= addDays(from, -365) && p.d < from && val(p) != null; });
    var g = '';
    for (var v = lo; v <= hi + 1e-9; v += 0.1) {
      var y = Y(v).toFixed(1);
      g += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y + '" y2="' + y + '" stroke="#e6ebe2" stroke-width="1"/>' +
           '<text x="' + (L - 4) + '" y="' + (Number(y) + 3) + '" text-anchor="end" font-size="10" fill="#7a857c">' + v.toFixed(1) + '</text>';
    }
    for (var i = 0; i <= 12; i += 2) {
      var dI = addDays(from, Math.round(i * 365 / 12));
      g += '<text x="' + X(dI).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === 12 ? 'end' : 'middle') + '" font-size="10" fill="#7a857c">' + fmtD(dI).slice(3) + '/' + dI.slice(2, 4) + '</text>';
    }
    var dots = cur.map(function (p) { return '<circle cx="' + X(p.d).toFixed(1) + '" cy="' + Y(val(p)).toFixed(1) + '" r="2.4" fill="' + col(val(p)) + '"><title>' + fmtDY(p.d) + ' · ' + f2(val(p)) + '</title></circle>'; }).join('');
    var svg = '<svg class="sat-big" style="direction:ltr" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet">' + g +
      line(prev, 365, '#b9c2b6', true) + line(cur, 0, idx === 'm' ? '#0288d1' : '#2e7d32', false) + dots + '</svg>';
    ui.idx = keep;
    return svg;
  }

  // ── screens ──
  function open(fid) {
    ensureCss();
    var fs = farms();
    farmId = fid != null ? Number(fid) : (farmId != null ? farmId : (fs[0] ? fs[0].id : null));
    ui.plot = null;
    if (farmId == null) { toast(tt('אין משקים', 'ไม่มีฟาร์ม', 'لا توجد مزارع')); return; }
    load().then(render);
  }
  function close() {
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    var m = document.getElementById('modalContainer'); if (m) m.innerHTML = '';
  }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m || !D) return;
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    var fs = farms();
    var fo = fs.map(function (f) { return '<option value="' + f.id + '"' + (f.id === farmId ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
    m.innerHTML = '<div class="modal-overlay" id="satRoot"><div class="modal sat">' +
      '<div class="sat-h"><h2>🛰️ ' + tt('מצב הצמחייה מהלוויין', 'สภาพพืชจากดาวเทียม', 'حالة الغطاء النباتي من القمر الصناعي') + '</h2>' +
        '<select class="form-input sat-f" id="satFarm">' + fo + '</select>' +
        '<button class="sat-btn ghost" data-a="close" aria-label="x">✕</button></div>' +
      '<div id="satBody"></div></div></div>';
    var root = document.getElementById('satRoot');
    root.addEventListener('click', function (e) {
      if (e.target === root) { close(); return; }
      var a = e.target.closest('[data-a]');
      if (a) {
        var k = a.getAttribute('data-a');
        if (k === 'close') close();
        else if (k === 'refresh') refresh();
        else if (k === 'view') { ui.view = a.getAttribute('data-v'); body(); }
        else if (k === 'idx') { ui.idx = a.getAttribute('data-v'); body(); }
        else if (k === 'back') { ui.plot = null; body(); }
        return;
      }
      var row = e.target.closest('[data-plot]');
      if (row) { ui.plot = Number(row.getAttribute('data-plot')); body(); }
    });
    document.getElementById('satFarm').onchange = function () { farmId = Number(this.value); ui.plot = null; load().then(body); };
    body();
  }

  function bar() {
    var upd = D.updated ? new Date(D.updated) : null;
    return '<div class="sat-bar">' +
      (staff() ? '<button class="sat-btn pri" data-a="refresh"' + (busy ? ' disabled' : '') + '>' + (busy ? '⏳ ' + tt('מעדכן…', 'กำลังอัปเดต…', 'جارٍ التحديث…') : '🔄 ' + tt('עדכון מהלוויין', 'อัปเดตจากดาวเทียม', 'تحديث من القمر')) + '</button>' : '') +
      '<span class="sat-seg">' +
        '<button class="sat-btn' + (ui.idx === 'v' ? ' on' : '') + '" data-a="idx" data-v="v">🌿 NDVI</button>' +
        '<button class="sat-btn' + (ui.idx === 'm' ? ' on' : '') + '" data-a="idx" data-v="m">💧 NDMI</button>' +
      '</span>' +
      (ui.plot == null ? '<span class="sat-seg">' +
        '<button class="sat-btn' + (ui.view === 'table' ? ' on' : '') + '" data-a="view" data-v="table">📋 ' + tt('טבלה', 'ตาราง', 'جدول') + '</button>' +
        '<button class="sat-btn' + (ui.view === 'map' ? ' on' : '') + '" data-a="view" data-v="map">🗺️ ' + tt('מפה', 'แผนที่', 'خريطة') + '</button>' +
      '</span>' : '') +
      (upd ? '<span class="sat-mut">' + tt('עודכן', 'อัปเดต', 'حُدّث') + ' ' + upd.toLocaleDateString() + '</span>' : '') +
    '</div>';
  }

  function body() {
    var el = document.getElementById('satBody');
    if (!el) return;
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    var list = farmPlots();
    var any = list.some(function (p) { return series(p.id).length; });
    if (!list.length) { el.innerHTML = '<div class="sat-empty">' + tt('אין במשק חלקות משורטטות על המפה.', 'ฟาร์มนี้ยังไม่มีแปลงที่วาดบนแผนที่', 'لا توجد قطع مرسومة على الخريطة في هذه المزرعة.') + '</div>'; return; }
    if (!any) {
      el.innerHTML = bar() + '<div class="sat-empty">' +
        (staff() ? tt('עדיין אין נתוני לוויין למשק הזה. לחץ "עדכון מהלוויין" — הפעם הראשונה מביאה שנה אחורה ולוקחת כדקה.',
                      'ยังไม่มีข้อมูลดาวเทียม กด "อัปเดตจากดาวเทียม"', 'لا توجد بيانات بعد. اضغط "تحديث من القمر".')
                 : tt('עדיין אין נתוני לוויין למשק הזה. מנהל יכול לעדכן.', 'ยังไม่มีข้อมูล ผู้จัดการสามารถอัปเดตได้', 'لا توجد بيانات بعد. يمكن للمدير التحديث.')) +
        '</div>' + legendHelp();
      return;
    }
    if (ui.plot != null) { el.innerHTML = bar() + detail(list); return; }
    var st = stats(list);
    if (ui.view === 'map') { el.innerHTML = bar() + '<div id="satMap"></div>' + legend(); drawMap(list, st); return; }
    el.innerHTML = bar() + table(list, st) + legend() + legendHelp();
  }

  function table(list, st) {
    var lastAll = list.map(function (p) { var s = series(p.id); return s.length ? s[s.length - 1].d : ''; }).sort().pop();
    var flagged = list.filter(function (p) { return st[p.id].flags.length; });
    var rows = list.slice().sort(function (a, b) {
      var fa = st[a.id].flags.length ? 0 : 1, fb = st[b.id].flags.length ? 0 : 1;
      if (fa !== fb) return fa - fb;
      return String(a.crop).localeCompare(String(b.crop), 'he') || String(a.name).localeCompare(String(b.name), 'he');
    }).map(function (p) {
      var r = st[p.id], c = r.cur;
      return '<tr data-plot="' + p.id + '"' + (r.flags.length ? ' class="fl"' : '') + '>' +
        '<td><b>' + esc(p.name) + '</b><small>' + esc(p.crop || '') + '</small></td>' +
        '<td class="n"><span class="sat-chip" style="background:' + col(c && c.v) + '">' + f2(c && c.v) + '</span>' + (c ? '<small>' + fmtD(c.d) + '</small>' : '') + '</td>' +
        '<td class="n ' + (r.d30 == null ? '' : r.d30 < -0.03 ? 'dn' : r.d30 > 0.03 ? 'up' : '') + '">' + sgn(r.d30) + '</td>' +
        '<td class="n ' + (r.yoy == null ? '' : r.yoy < -0.03 ? 'dn' : r.yoy > 0.03 ? 'up' : '') + '">' + sgn(r.yoy) + '</td>' +
        '<td class="n ' + (r.rel == null ? '' : r.rel < -0.1 ? 'dn' : r.rel > 0.1 ? 'up' : '') + '">' + (r.rel == null ? '—' : ltr((r.rel > 0 ? '+' : r.rel < 0 ? '−' : '') + Math.abs(Math.round(r.rel * 100)) + '%')) + '</td>' +
        '<td>' + spark(series(p.id), c ? c.d : today()) + '</td>' +
        '<td class="fz">' + r.flags.map(function (f) { return '<span class="sat-flag">⚠ ' + esc(f) + '</span>'; }).join('') + '</td>' +
      '</tr>';
    }).join('');
    return (flagged.length ? '<div class="sat-warn">⚠ ' + flagged.length + ' ' + tt('חלקות לבדיקה בשטח', 'แปลงที่ควรตรวจ', 'قطع تحتاج فحصًا ميدانيًا') + ': ' +
             flagged.map(function (p) { return esc(p.name); }).join(' · ') + '</div>' : '') +
      '<div class="sat-mut">' + tt('מעבר נקי אחרון', 'ภาพล่าสุดที่ไม่มีเมฆ', 'آخر مرور صافٍ') + ': ' + fmtDY(lastAll) + '</div>' +
      '<div class="sat-wrap"><table class="sat-tbl"><thead><tr>' +
        '<th>' + tt('חלקה', 'แปลง', 'القطعة') + '</th><th>' + idxName() + '</th>' +
        '<th>' + tt('שינוי 30 יום', 'เปลี่ยน 30 วัน', 'تغيّر 30 يومًا') + '</th>' +
        '<th>' + tt('מול אשתקד', 'เทียบปีก่อน', 'مقابل العام الماضي') + '</th>' +
        '<th>' + tt('מול חלקות דומות', 'เทียบแปลงพืชเดียวกัน', 'مقابل القطع المماثلة') + '</th>' +
        '<th>' + tt('12 חודשים', '12 เดือน', '12 شهرًا') + '</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function detail(list) {
    var p = list.filter(function (x) { return x.id === ui.plot; })[0];
    if (!p) { ui.plot = null; return ''; }
    var pts = series(p.id), st = stats(list)[p.id], end = pts.length ? pts[pts.length - 1].d : today();
    var recent = pts.slice(-10).reverse().map(function (q) {
      return '<tr><td>' + fmtDY(q.d) + '</td><td class="n"><span class="sat-chip" style="background:' + colV(q.v) + '">' + f2(q.v) + '</span></td>' +
        '<td class="n"><span class="sat-chip" style="background:' + colM(q.m) + '">' + f2(q.m) + '</span></td><td class="n">' + Math.round((q.c || 0) * 100) + '%</td></tr>';
    }).join('');
    return '<button class="sat-btn ghost" data-a="back">→ ' + tt('כל החלקות', 'ทุกแปลง', 'كل القطع') + '</button>' +
      '<h3 class="sat-pt">' + esc(p.name) + (p.crop ? ' <small>' + esc(p.crop) + '</small>' : '') + '</h3>' +
      (st.flags.length ? '<div class="sat-warn">⚠ ' + st.flags.map(esc).join(' · ') + '</div>' : '') +
      '<div class="sat-card"><div class="sat-ct">🌿 NDVI — ' + tt('צפיפות ועוצמת הנוף', 'ความหนาแน่นของทรงพุ่ม', 'كثافة الغطاء') + '</div>' + bigChart(pts, end, 'v') + '</div>' +
      '<div class="sat-card"><div class="sat-ct">💧 NDMI — ' + tt('לחות הנוף', 'ความชื้นของทรงพุ่ม', 'رطوبة الغطاء') + '</div>' + bigChart(pts, end, 'm') + '</div>' +
      '<div class="sat-mut">' + tt('קו מלא: 12 החודשים האחרונים · קו מקווקו: השנה הקודמת', 'เส้นทึบ: 12 เดือนล่าสุด · เส้นประ: ปีก่อน', 'خط متصل: آخر 12 شهرًا · خط متقطع: العام السابق') + '</div>' +
      '<div class="sat-wrap" style="margin-top:10px"><table class="sat-tbl sm"><thead><tr><th>' + tt('תאריך', 'วันที่', 'التاريخ') + '</th><th>NDVI</th><th>NDMI</th><th>' + tt('שטח נקי', 'ไม่มีเมฆ', 'صافٍ') + '</th></tr></thead><tbody>' + recent + '</tbody></table></div>';
  }

  function legend() {
    var stops = ui.idx === 'm' ? [-0.15, -0.05, 0.05, 0.15, 0.25, 0.35] : [0.15, 0.25, 0.35, 0.45, 0.55, 0.65];
    var lab = ui.idx === 'm' ? ['&lt;−0.1', '−0.1–0', '0–0.1', '0.1–0.2', '0.2–0.3', '0.3+'] : ['&lt;0.2', '0.2–0.3', '0.3–0.4', '0.4–0.5', '0.5–0.6', '0.6+'];
    return '<div class="sat-leg">' + stops.map(function (s, i) { return '<span><i style="background:' + col(s) + '"></i>' + ltr(lab[i]) + '</span>'; }).join('') + '</div>';
  }
  function legendHelp() {
    return '<details class="sat-help"><summary>' + tt('איך לקרוא את זה', 'อ่านอย่างไร', 'كيف تقرأ هذا') + '</summary><div>' +
      tt('NDVI מודד כמה צמחייה ירוקה ופעילה יש בחלקה. במטע תמרים הנוף מכסה רק חלק מהקרקע, ולכן הערכים נמוכים משדה (בדרך כלל 0.3–0.5) — חשוב לעקוב אחרי השינוי ולא אחרי המספר. ' +
         'NDMI מודד את לחות הנוף; ירידה שלו לפני ירידה ב-NDVI יכולה להעיד על עקה מים. ' +
         'עשבייה בין השורות מעלה את הערכים בחורף. חלקה מסומנת היא סיבה ללכת לבדוק בשטח — לא אבחנה.',
         'NDVI วัดปริมาณพืชสีเขียว ในสวนอินทผลัมค่ามักอยู่ที่ 0.3–0.5 ให้ดูการเปลี่ยนแปลงมากกว่าตัวเลข NDMI วัดความชื้นของทรงพุ่ม หญ้าระหว่างแถวทำให้ค่าสูงขึ้นในฤดูหนาว แปลงที่ถูกทำเครื่องหมายควรไปตรวจในพื้นที่',
         'يقيس NDVI كمية الغطاء الأخضر. في بستان النخيل القيم عادة 0.3–0.5، فتابع التغيّر لا الرقم. يقيس NDMI رطوبة الغطاء. الأعشاب بين الصفوف ترفع القيم شتاءً. القطعة المؤشَّرة سبب للفحص الميداني وليست تشخيصًا.') +
      '<br><small>' + tt('מקור: Copernicus Sentinel-2 (ESA), רזולוציה 10 מ\'.', 'ที่มา: Copernicus Sentinel-2 (ESA) ความละเอียด 10 ม.', 'المصدر: Copernicus Sentinel-2 (ESA)، دقة 10 م.') + '</small></div></details>';
  }

  function drawMap(list, st) {
    if (typeof L === 'undefined') return;
    map = L.map('satMap', { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
    var b = L.latLngBounds([]);
    list.forEach(function (p) {
      var c = st[p.id].cur, v = c && c.v;
      p.rings.forEach(function (r) {
        var ll = r.map(function (q) { return [Number(q.lat), Number(q.lng)]; });
        var poly = L.polygon(ll, { color: st[p.id].flags.length ? '#b3261e' : '#ffffff', weight: st[p.id].flags.length ? 3 : 1.5, fillColor: col(v), fillOpacity: 0.72 }).addTo(map);
        poly.bindTooltip(esc(p.name) + ' · ' + idxName() + ' ' + f2(v) + (c ? ' (' + fmtD(c.d) + ')' : ''), { sticky: true });
        poly.on('click', function () { ui.plot = p.id; body(); });
        ll.forEach(function (x) { b.extend(x); });
      });
    });
    if (b.isValid()) map.fitBounds(b, { padding: [20, 20], maxZoom: 17 });
  }

  // ── refresh from the satellite (operator+) ──
  function refresh() {
    if (busy || !staff()) return;
    if (typeof firebase === 'undefined' || !firebase.app || !firebase.app().functions) { toast('❌ ' + tt('אין חיבור לשרת', 'ไม่มีการเชื่อมต่อ', 'لا اتصال')); return; }
    var list = farmPlots(), to = today();
    var groups = {};
    list.forEach(function (p) {
      var f = D.fetched[p.id];
      var from = f ? addDays(f, -OVERLAP_DAYS) : addDays(to, -FIRST_DAYS);
      if (from >= to) return;
      (groups[from] = groups[from] || []).push(p);
    });
    var jobs = [];
    Object.keys(groups).forEach(function (from) {
      var g = groups[from];
      for (var i = 0; i < g.length; i += 30) jobs.push({ from: from, plots: g.slice(i, i + 30) });
    });
    if (!jobs.length) { toast('✅ ' + tt('הכל מעודכן', 'อัปเดตแล้ว', 'كل شيء محدّث')); return; }
    busy = true; body();
    var fn = firebase.app().functions('us-central1').httpsCallable('sentinelNdvi', { timeout: 125000 });
    var errs = 0, quota = false, notSet = false;
    var chain = Promise.resolve();
    jobs.forEach(function (j) {
      chain = chain.then(function () {
        return fn({ from: j.from, to: to, plots: j.plots.map(function (p) {
          return { id: p.id, rings: p.rings.map(function (r) { return r.map(function (q) { return [Number(q.lng), Number(q.lat)]; }); }) };
        }) }).then(function (res) {
          var out = (res && res.data && res.data.plots) || {};
          j.plots.forEach(function (p) {
            var r = out[String(p.id)];
            if (!r || r.err) { errs++; if (r && r.err === 'quota') quota = true; return; }
            var byD = {};
            series(p.id).forEach(function (q) { byD[q.d] = q; });
            (r.pts || []).forEach(function (q) { byD[q.d] = q; });
            var keepFrom = addDays(to, -KEEP_DAYS);
            D.plots[p.id] = Object.keys(byD).sort().filter(function (d) { return d >= keepFrom; }).map(function (d) { return byD[d]; });
            D.fetched[p.id] = to;
          });
        }, function (e) {
          errs += j.plots.length;
          var c = String((e && (e.code || '')) + ' ' + (e && e.message || ''));
          if (/failed-precondition|not-found|internal/i.test(c)) notSet = true;
          if (/permission/i.test(c)) toast('❌ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية'));
        });
      });
    });
    chain.then(function () {
      busy = false;
      D.updated = Date.now();
      D.by = (window.currentUser || {}).name || '';
      // stale plots that were deleted from the farm drop out of the doc
      var ids = {}; list.forEach(function (p) { ids[p.id] = 1; });
      Object.keys(D.plots).forEach(function (k) { if (!ids[k]) { delete D.plots[k]; delete D.fetched[k]; } });
      var got = list.some(function (p) { return series(p.id).length; });
      (got ? persist() : Promise.resolve(true)).then(function () {
        if (notSet && !got) toast('⚠️ ' + tt('שירות הלוויין עדיין לא הוגדר בשרת (מפתחות Copernicus)', 'ยังไม่ได้ตั้งค่าบริการดาวเทียม', 'خدمة القمر الصناعي غير مُعدّة بعد'));
        else if (quota) toast('⚠️ ' + tt('נגמרה המכסה החודשית של Copernicus — חלק מהחלקות לא עודכנו', 'โควตาหมด', 'نفدت الحصة الشهرية'));
        else if (errs) toast('⚠️ ' + errs + ' ' + tt('חלקות לא עודכנו', 'แปลงไม่ได้อัปเดต', 'قطع لم تُحدَّث'));
        else toast('✅ ' + tt('עודכן מהלוויין', 'อัปเดตแล้ว', 'تم التحديث'));
        body();
      });
    });
  }

  function ensureCss() {
    if (document.getElementById('satCss')) return;
    var st = document.createElement('style');
    st.id = 'satCss';
    st.textContent =
      '.sat{max-width:1000px !important;width:100%;}.sat-h{display:flex;gap:8px;align-items:center;margin-bottom:8px;}.sat-h h2{flex:1;margin:0;font-size:1.1rem;}.sat-f{width:auto !important;max-width:46%;margin:0 !important;}' +
      '.sat-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:7px 11px;font:inherit;font-weight:600;font-size:.8rem;cursor:pointer;}' +
      '.sat-btn.pri{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.sat-btn.ghost{background:transparent;}.sat-btn.on{background:var(--primary-soft,#e2efe7);border-color:var(--primary,#2d6a4f);}.sat-btn[disabled]{opacity:.6;}' +
      '.sat-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0 8px;}.sat-seg{display:inline-flex;gap:4px;}' +
      '.sat-mut{font-size:.72rem;color:var(--text-muted,#6f7b72);}.sat-empty{padding:28px 10px;text-align:center;color:var(--text-muted,#6f7b72);}' +
      '.sat-warn{background:#fde9e7;color:#8c1d18;border-radius:14px;padding:9px 12px;font-size:.82rem;margin:4px 0 6px;}' +
      '.sat-wrap{overflow-x:auto;border:1px solid var(--line,#e6ebe2);border-radius:14px;margin-top:6px;}' +
      '.sat-tbl{width:100%;border-collapse:collapse;font-size:.8rem;min-width:720px;}.sat-tbl.sm{min-width:0;}' +
      '.sat-tbl th{background:var(--tonal,#f1f4ee);padding:7px 6px;font-weight:600;font-size:.72rem;white-space:nowrap;text-align:start;}' +
      '.sat-tbl td{padding:6px;border-top:1px solid var(--line,#eef1ec);vertical-align:middle;}.sat-tbl td small{display:block;color:var(--text-muted,#6f7b72);font-size:.68rem;}' +
      '.sat-tbl td.n{text-align:center;font-variant-numeric:tabular-nums;white-space:nowrap;}.sat-tbl td.dn{color:#b3261e;font-weight:700;}.sat-tbl td.up{color:#2e7d32;font-weight:700;}' +
      '.sat-tbl tbody tr[data-plot]{cursor:pointer;}.sat-tbl tbody tr[data-plot]:hover{background:var(--tonal,#f6f8f4);}.sat-tbl tr.fl td:first-child{box-shadow:inset -3px 0 #b3261e;}' +
      '[dir=ltr] .sat-tbl tr.fl td:first-child{box-shadow:inset 3px 0 #b3261e;}' +
      '.sat-chip{direction:ltr;unicode-bidi:isolate;display:inline-block;min-width:42px;color:#fff;font-weight:700;border-radius:8px;padding:2px 6px;text-shadow:0 1px 1px rgba(0,0,0,.25);}' +
      '.sat-flag{display:inline-block;background:#fde9e7;color:#8c1d18;border-radius:8px;padding:2px 7px;font-size:.7rem;font-weight:600;margin:1px 2px;white-space:nowrap;}.sat-tbl td.fz{min-width:120px;}' +
      '.sat-spark{display:block;direction:ltr;}' +
      '.sat-leg{display:flex;gap:10px;flex-wrap:wrap;font-size:.7rem;color:var(--text-muted,#6f7b72);margin:8px 0 2px;}.sat-leg i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-inline-end:4px;vertical-align:-2px;}' +
      '.sat-help{font-size:.78rem;margin-top:8px;color:var(--text,#1b2a1f);}.sat-help summary{cursor:pointer;color:var(--primary,#1d5a2c);font-weight:600;}.sat-help div{padding:6px 2px;line-height:1.5;}' +
      '#satMap{height:440px;border-radius:16px;margin-top:4px;}' +
      '.sat-pt{margin:8px 0 6px;}.sat-pt small{font-weight:500;color:var(--text-muted,#6f7b72);font-size:.8rem;}' +
      '.sat-card{border:1px solid var(--line,#e6ebe2);border-radius:14px;padding:8px 10px;margin-top:8px;}.sat-ct{font-size:.8rem;font-weight:700;margin-bottom:4px;}' +
      '.sat-big{width:100%;height:auto;display:block;direction:ltr;}';
    document.head.appendChild(st);
  }

  document.addEventListener('shorashim:lang', function () { if (document.getElementById('satRoot') && D && !busy) render(); });

  return { open: open, close: close };
})();
