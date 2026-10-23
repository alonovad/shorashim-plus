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
  var D = null, farmId = null, ui = { view: 'table', idx: 'v', plot: null, date: '', rel: true, pxr: false }, busy = false, map = null;

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
  function open(fid, plotId) {
    ensureCss();
    var fs = farms();
    farmId = fid != null ? Number(fid) : (farmId != null ? farmId : (fs[0] ? fs[0].id : null));
    ui.plot = plotId != null ? Number(plotId) : null;
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
        else if (k === 'rel') { ui.rel = a.getAttribute('data-v') === '1'; body(); }
        else if (k === 'pxr') { ui.pxr = !ui.pxr; body(); }
        return;
      }
      var row = e.target.closest('[data-plot]');
      if (row) { ui.plot = Number(row.getAttribute('data-plot')); body(); }
    });
    document.getElementById('satFarm').onchange = function () { farmId = Number(this.value); ui.plot = null; ui.date = ''; load().then(body); };
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
    var dates = farmDates(D, list);
    if (ui.plot != null) {
      el.innerHTML = bar() + detail(list, dates);
      loadImgs(farmId).then(function () {
        var pb = document.getElementById('satPxBar'); if (!pb) return;
        pb.innerHTML = dateBar(dates) + pxLegend(ui.idx, ui.rel !== false); bindPxBar();
        drawPx('satPlotMap', list.filter(function (x) { return x.id === ui.plot; })[0]);
      });
      return;
    }
    var st = stats(list);
    if (ui.view === 'map') {
      el.innerHTML = bar() + '<div id="satPxBar"></div><div id="satMap"></div>';
      loadImgs(farmId).then(function () {
        var pb = document.getElementById('satPxBar'); if (!pb) return;
        pb.innerHTML = dateBar(dates) + pxLegend(ui.idx, ui.rel !== false); bindPxBar();
        drawPx('satMap', null);
      });
      return;
    }
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

  function detail(list, dates) {
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
      '<div class="sat-card"><div class="sat-ct">🗺️ ' + tt('מפת החלקה — כל פיקסל 10×10 מ\'', 'แผนที่แปลง — พิกเซลละ 10×10 ม.', 'خريطة القطعة — كل بكسل 10×10 م') + '</div>' +
        '<div id="satPxBar"></div><div id="satPlotMap"></div><div id="satZone" class="sat-zone"></div></div>' +
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

  // satellite screen, map view: the pixel map of the whole farm
  var pxm = null;
  function pxOpts() { return { idx: ui.idx, rel: ui.rel !== false, pixelated: !!ui.pxr }; }
  function dateBar(dates) {
    if (!ui.date || dates.indexOf(ui.date) < 0) ui.date = dates[0] || '';
    var cache = (imgDocs[farmId] || { imgs: {} }).imgs;
    return '<div class="sat-bar">' +
      '<select class="form-input sat-d" id="satDate">' + dates.slice(0, 40).map(function (d) {
        return '<option value="' + d + '"' + (d === ui.date ? ' selected' : '') + '>' + fmtDY(d) + (cache[d] ? ' ✓' : '') + '</option>'; }).join('') + '</select>' +
      '<span class="sat-seg"><button class="sat-btn' + (ui.rel !== false ? ' on' : '') + '" data-a="rel" data-v="1">' + tt('יחסי לחלקה', 'เทียบในแปลง', 'نسبي للقطعة') + '</button>' +
      '<button class="sat-btn' + (ui.rel === false ? ' on' : '') + '" data-a="rel" data-v="0">' + tt('ערך מוחלט', 'ค่าจริง', 'قيمة مطلقة') + '</button></span>' +
      '<button class="sat-btn' + (ui.pxr ? ' on' : '') + '" data-a="pxr" title="pixels">▦</button>' +
      '<span class="sat-mut" id="satPxMsg"></span></div>';
  }
  function pxMsg(t) { var e = document.getElementById('satPxMsg'); if (e) e.innerHTML = t; }
  // mapId: element id; plot: limit the view (and zone figures) to one plot
  function drawPx(mapId, plot) {
    if (typeof L === 'undefined' || !document.getElementById(mapId)) return;
    map = L.map(mapId, { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
    var b = L.latLngBounds([]);
    (plot ? [plot] : farmPlots()).forEach(function (p) { p.rings.forEach(function (r) { r.forEach(function (q) { b.extend([Number(q.lat), Number(q.lng)]); }); }); });
    if (b.isValid()) map.fitBounds(b, { padding: [16, 16], maxZoom: 18 });
    if (!ui.date) { pxMsg(tt('אין מעבר נקי', 'ไม่มีภาพ', 'لا صورة')); return; }
    pxm = PxLayer(map);
    pxMsg('⏳');
    var o = pxOpts();
    pxm.show({ fid: farmId, date: ui.date, idx: o.idx, rel: o.rel, pixelated: o.pixelated, highlight: plot ? plot.id : null,
      onPick: function (p, h) {
        if (!plot) { ui.plot = p.id; body(); return; }
        pxMsg(h ? (h.cloud ? '☁' : idxName() + ' ' + ltr(h.v.toFixed(2))) : '');
      },
      onHover: function (p, h) { pxMsg(esc(p.name) + (h ? (h.cloud ? ' · ☁' : ' · ' + idxName() + ' ' + ltr(h.v.toFixed(2))) : '')); },
      onDone: function (res, why) {
        pxMsg(res ? '' : (why === 'nocache' ? tt('אין תמונה שמורה לתאריך הזה — מנהל יכול לטעון', 'ไม่มีภาพสำหรับวันนี้', 'لا صورة لهذا التاريخ') : tt('אין תמונה', 'ไม่มีภาพ', 'لا صورة')));
        var zEl = document.getElementById('satZone');
        if (plot && zEl) {
          var z = res && res.zone[plot.id];
          zEl.innerHTML = z ? '<b>' + tt('אזור חלש', 'โซนอ่อน', 'منطقة ضعيفة') + ': ' + Math.round(z.weakPct * 100) + '%</b> ' +
            tt('מהחלקה', 'ของแปลง', 'من القطعة') + ' (' + ltr(z.weakDunam.toFixed(1)) + ' ' + tt('דונם', 'ไร่', 'دونم') + ') · ' +
            tt('חציון', 'มัธยฐาน', 'الوسيط') + ' ' + idxName() + ' ' + ltr(z.med.toFixed(2)) +
            '<div class="sat-mut">' + tt('אזור חלש = פיקסלים נמוכים בבירור מהחציון של החלקה באותו יום. כדאי לבדוק שם השקיה, עצים חסרים, מזיקים.',
                                       'โซนอ่อน = พิกเซลที่ต่ำกว่าค่ามัธยฐานของแปลงอย่างชัดเจน ควรตรวจการให้น้ำ ต้นที่ขาด ศัตรูพืช',
                                       'المنطقة الضعيفة = بكسلات أقل بوضوح من وسيط القطعة. افحص الري والأشجار المفقودة والآفات.') + '</div>' : '';
        }
      } });
  }
  function bindPxBar() {
    var sd = document.getElementById('satDate');
    if (sd) sd.onchange = function () { ui.date = this.value; body(); };
  }

  // ══ Pixel map — every 10 m pixel inside the plots ══
  // One Process API image per farm per date (sentinelImage function), cached
  // in appData/shorashim-sentinel-img-<farmId>. The PNG holds values, so the
  // colouring — absolute, or relative to each plot (weak ↔ strong zones
  // inside the plot) — happens here without another call.
  var IMG_PREFIX = 'shorashim-sentinel-img-', IMG_KEEP = 8;
  var imgDocs = {}, decoded = {};
  var RAMP = [[0, [215, 48, 39]], [0.25, [252, 141, 89]], [0.5, [254, 224, 139]], [0.75, [145, 207, 96]], [1, [26, 152, 80]]];
  var ABS = { v: [0.1, 0.7], m: [-0.2, 0.4] };
  function ramp(t) {
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    for (var i = 1; i < RAMP.length; i++) if (t <= RAMP[i][0]) {
      var a = RAMP[i - 1], b = RAMP[i], k = (t - a[0]) / (b[0] - a[0]);
      return [Math.round(a[1][0] + (b[1][0] - a[1][0]) * k), Math.round(a[1][1] + (b[1][1] - a[1][1]) * k), Math.round(a[1][2] + (b[1][2] - a[1][2]) * k)];
    }
    return RAMP[RAMP.length - 1][1];
  }
  function rampCss() { return 'linear-gradient(90deg,' + RAMP.map(function (s) { return 'rgb(' + s[1].join(',') + ') ' + (s[0] * 100) + '%'; }).join(',') + ')'; }
  function px2v(b) { return b / 254 * 1.2 - 0.2; }

  function loadImgs(fid) {
    if (imgDocs[fid]) return Promise.resolve(imgDocs[fid]);
    if (typeof DB === 'undefined') return Promise.resolve({ imgs: {} });
    return DB.loadAsync(IMG_PREFIX + fid).then(function (d) {
      imgDocs[fid] = { imgs: (d && d.imgs && typeof d.imgs === 'object') ? d.imgs : {} };
      return imgDocs[fid];
    }, function () { imgDocs[fid] = { imgs: {} }; return imgDocs[fid]; });
  }
  // Dates on which most of the farm's plots had a clear pass, newest first.
  function farmDates(doc, list) {
    var cnt = {}, withData = 0;
    list.forEach(function (p) {
      var s = (doc.plots || {})[p.id] || [];
      if (s.length) withData++;
      s.forEach(function (q) { cnt[q.d] = (cnt[q.d] || 0) + 1; });
    });
    var need = Math.max(1, Math.ceil(withData * 0.6));
    return Object.keys(cnt).filter(function (d) { return cnt[d] >= need; }).sort().reverse();
  }
  function plotsOf(fid) { var sF = farmId; farmId = fid; var l = farmPlots(); farmId = sF; return l; }
  // cached image, or (operator+) fetch it now
  function getImage(fid, date, list) {
    return loadImgs(fid).then(function (doc) {
      if (doc.imgs[date]) return doc.imgs[date];
      if (!staff()) return null;
      if (typeof firebase === 'undefined' || !firebase.app || !firebase.app().functions) return null;
      var fn = firebase.app().functions('us-central1').httpsCallable('sentinelImage', { timeout: 65000 });
      var rings = [];
      list.forEach(function (p) { p.rings.forEach(function (r) { rings.push(r.map(function (q) { return [Number(q.lng), Number(q.lat)]; })); }); });
      return fn({ date: date, rings: rings }).then(function (res) {
        var im = res && res.data;
        if (!im || !im.png) return null;
        doc.imgs[date] = { png: im.png, bbox: im.bbox, width: im.width, height: im.height };
        var ds = Object.keys(doc.imgs).sort().reverse();
        ds.slice(IMG_KEEP).forEach(function (d) { delete doc.imgs[d]; });
        if (DB.saveAsync) DB.saveAsync(IMG_PREFIX + fid, JSON.parse(JSON.stringify(doc))).catch(function () {});
        return doc.imgs[date];
      }, function (e) {
        var c = String((e && (e.code || '')) + ' ' + (e && e.message || ''));
        toast('⚠️ ' + (/exhausted|quota/i.test(c) ? tt('נגמרה המכסה החודשית של Copernicus', 'โควตาหมด', 'نفدت الحصة') :
                       tt('לא הצלחתי להביא את תמונת הלוויין', 'โหลดภาพดาวเทียมไม่ได้', 'تعذّر جلب صورة القمر')));
        return null;
      });
    });
  }
  function decode(fid, date, im) {
    var k = fid + '|' + date;
    if (decoded[k]) return Promise.resolve(decoded[k]);
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () {
        var cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height;
        var cx = cv.getContext('2d'); cx.drawImage(img, 0, 0);
        decoded[k] = { w: im.width, h: im.height, bbox: im.bbox, px: cx.getImageData(0, 0, im.width, im.height).data, owner: null, ownerFor: '' };
        resolve(decoded[k]);
      };
      img.onerror = function () { resolve(null); };
      img.src = 'data:image/png;base64,' + im.png;
    });
  }
  function inRing(x, y, r) {
    var ins = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var xi = Number(r[i].lng), yi = Number(r[i].lat), xj = Number(r[j].lng), yj = Number(r[j].lat);
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  // which plot each pixel belongs to (index into list, -1 none)
  function owners(dec, list) {
    var sig = list.map(function (p) { return p.id; }).join(',');
    if (dec.owner && dec.ownerFor === sig) return dec.owner;
    var o = new Int16Array(dec.w * dec.h).fill(-1), b = dec.bbox;
    var bx = list.map(function (p) {
      var w = 180, s = 90, e = -180, n = -90;
      p.rings.forEach(function (r) { r.forEach(function (q) { var x = Number(q.lng), y = Number(q.lat); if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }); });
      return [w, s, e, n];
    });
    for (var j = 0; j < dec.h; j++) {
      var y = b[3] - (j + 0.5) / dec.h * (b[3] - b[1]);
      for (var i = 0; i < dec.w; i++) {
        var a = (j * dec.w + i) * 4;
        if (!dec.px[a + 3]) continue;
        var x = b[0] + (i + 0.5) / dec.w * (b[2] - b[0]);
        for (var k = 0; k < list.length; k++) {
          var q = bx[k];
          if (x < q[0] || x > q[2] || y < q[1] || y > q[3]) continue;
          if (list[k].rings.some(function (r) { return inRing(x, y, r); })) { o[j * dec.w + i] = k; break; }
        }
      }
    }
    dec.owner = o; dec.ownerFor = sig;
    return o;
  }
  function quant(a, q) { if (!a.length) return null; var i = Math.min(a.length - 1, Math.max(0, Math.round(q * (a.length - 1)))); return a[i]; }
  // Colour the decoded image. rel: each plot stretched between its own 5th
  // and 95th percentile. Returns the image URL and per-plot zone figures.
  function paint(dec, list, idx, rel) {
    var o = owners(dec, list), ch = idx === 'm' ? 1 : 0, n = dec.w * dec.h;
    var vals = list.map(function () { return []; }), farmVals = [];
    for (var p = 0; p < n; p++) {
      var a = p * 4;
      if (!dec.px[a + 3] || dec.px[a + 2]) continue;
      var v = px2v(dec.px[a + ch]);
      farmVals.push(v);
      if (o[p] >= 0) vals[o[p]].push(v);
    }
    var zone = {};
    var rng = vals.map(function (vs, k) {
      vs.sort(function (x, y) { return x - y; });
      var md = quant(vs, 0.5), lo = quant(vs, 0.05), hi = quant(vs, 0.95);
      if (md != null) {
        var weak = vs.filter(function (v) { return v < md - (idx === 'm' ? 0.06 : 0.08); }).length;
        zone[list[k].id] = { n: vs.length, med: md, weakPct: weak / vs.length, weakDunam: weak * 0.1 };
      }
      return [lo, hi];
    });
    var cv = document.createElement('canvas'); cv.width = dec.w; cv.height = dec.h;
    var cx = cv.getContext('2d'), out = cx.createImageData(dec.w, dec.h), d = out.data;
    var A = ABS[idx];
    for (var q = 0; q < n; q++) {
      var b = q * 4;
      if (!dec.px[b + 3]) continue;
      if (dec.px[b + 2]) { d[b] = 160; d[b + 1] = 160; d[b + 2] = 160; d[b + 3] = 150; continue; }
      var v2 = px2v(dec.px[b + ch]), t;
      if (rel && o[q] >= 0 && rng[o[q]][0] != null && rng[o[q]][1] - rng[o[q]][0] > 0.02) t = (v2 - rng[o[q]][0]) / (rng[o[q]][1] - rng[o[q]][0]);
      else t = (v2 - A[0]) / (A[1] - A[0]);
      var c = ramp(t); d[b] = c[0]; d[b + 1] = c[1]; d[b + 2] = c[2]; d[b + 3] = 235;
    }
    cx.putImageData(out, 0, 0);
    return { url: cv.toDataURL(), zone: zone, bounds: [[dec.bbox[1], dec.bbox[0]], [dec.bbox[3], dec.bbox[2]]] };
  }
  function pxAt(dec, list, latlng, idx) {
    var b = dec.bbox;
    var i = Math.floor((latlng.lng - b[0]) / (b[2] - b[0]) * dec.w), j = Math.floor((b[3] - latlng.lat) / (b[3] - b[1]) * dec.h);
    if (i < 0 || j < 0 || i >= dec.w || j >= dec.h) return null;
    var a = (j * dec.w + i) * 4;
    if (!dec.px[a + 3]) return null;
    var o = owners(dec, list)[j * dec.w + i];
    return { v: px2v(dec.px[a + (idx === 'm' ? 1 : 0)]), cloud: !!dec.px[a + 2], plot: o >= 0 ? list[o] : null };
  }

  // A pixel layer on any Leaflet map: image in its own pane above the plot
  // polygons (clicks pass through), plot outlines on top.
  function PxLayer(m) {
    if (!m.getPane('satPx')) { var pn = m.createPane('satPx'); pn.style.zIndex = 450; pn.style.pointerEvents = 'none'; }
    if (!m.getPane('satLn')) { var pl = m.createPane('satLn'); pl.style.zIndex = 460; }
    var self = { img: null, lines: null, dec: null, list: [], res: null, seq: 0 };
    var rend = L.svg({ pane: 'satLn' });
    self.clear = function () {
      self.seq++;
      if (self.img) { try { m.removeLayer(self.img); } catch (e) {} self.img = null; }
      if (self.lines) { try { m.removeLayer(self.lines); } catch (e) {} self.lines = null; }
      self.dec = null; self.res = null;
    };
    // o: { fid, date, idx, rel, pixelated, onPlot(p), fit, onDone(res|null, msg) }
    self.show = function (o) {
      var seq = ++self.seq, list = plotsOf(o.fid);
      self.list = list;
      return getImage(o.fid, o.date, list).then(function (im) {
        if (seq !== self.seq) return;
        if (!im) { self.clear(); if (o.onDone) o.onDone(null, staff() ? 'fail' : 'nocache'); return; }
        return decode(o.fid, o.date, im).then(function (dec) {
          if (seq !== self.seq || !dec) return;
          var res = paint(dec, list, o.idx, o.rel);
          if (self.img) { try { m.removeLayer(self.img); } catch (e) {} }
          self.img = L.imageOverlay(res.url, res.bounds, { pane: 'satPx', opacity: 1, className: o.pixelated ? 'sat-pxr' : '' }).addTo(m);
          if (!self.lines) {
            self.lines = L.layerGroup();
            list.forEach(function (p) {
              p.rings.forEach(function (r) {
                var pg = L.polygon(r.map(function (q) { return [Number(q.lat), Number(q.lng)]; }), { renderer: rend, color: o.highlight === p.id ? '#ffeb3b' : '#ffffff', weight: o.highlight === p.id ? 3.5 : 1.4, fill: true, fillOpacity: 0, opacity: 0.95 });
                pg.on('click', function (ev) {
                  var hit = pxAt(dec, list, ev.latlng, o.idx);
                  if (o.onPick) o.onPick(p, hit);
                });
                pg.on('mousemove', function (ev) { if (o.onHover) o.onHover(p, pxAt(dec, list, ev.latlng, o.idx)); });
                self.lines.addLayer(pg);
              });
            });
            self.lines.addTo(m);
          }
          self.dec = dec; self.res = res;
          if (o.fit) {
            var bb = L.latLngBounds(res.bounds);
            if (o.fit === 'always' || !m.getBounds().intersects(bb) || m.getZoom() < 13) m.fitBounds(bb, { padding: [24, 24], maxZoom: 17 });
          }
          if (o.onDone) o.onDone(res, '');
        });
      });
    };
    return self;
  }
  function pxLegend(idx, rel) {
    var A = ABS[idx];
    return '<div class="sat-grad" style="background:' + rampCss() + '"></div><div class="sat-gl">' +
      (rel ? '<span>' + tt('חלש בתוך החלקה', 'อ่อนในแปลง', 'ضعيف داخل القطعة') + '</span><span>' + tt('חזק', 'แข็งแรง', 'قوي') + '</span>'
           : '<span>' + ltr(A[0].toFixed(1)) + '</span><span>' + ltr(((A[0] + A[1]) / 2).toFixed(1)) + '</span><span>' + ltr(A[1].toFixed(1)) + '</span>') +
      '</div><div class="sat-mut">▒ ' + tt('אפור = ענן באותו יום', 'สีเทา = เมฆ', 'رمادي = غيوم') + '</div>';
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
        if (ov.on) { delete imgDocs[farmId]; overlayOn(); }
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
      '.sat-big{width:100%;height:auto;display:block;direction:ltr;}' +
      '#satPlotMap{height:300px;border-radius:12px;margin-top:6px;}.sat-zone{font-size:.8rem;margin-top:6px;}.sat-d{width:auto !important;margin:0 !important;}' +
      '.sat-pxr{image-rendering:pixelated;}' +
      '.sat-grad{height:10px;border-radius:5px;margin-top:6px;direction:ltr;}.sat-gl{display:flex;justify-content:space-between;font-size:.68rem;color:var(--text-muted,#6f7b72);direction:ltr;}' +
      '.sat-mp{background:var(--card,#fff);border-radius:14px;padding:8px 10px;box-shadow:0 2px 12px rgba(0,0,0,.2);width:250px;font-size:.76rem;}' +
      '.sat-mp .form-input{margin:0 0 5px !important;padding:5px 8px !important;font-size:.78rem !important;height:auto !important;}' +
      '.sat-mp.min > :not(.sat-mp-h):not(.sat-grad):not(.sat-gl){display:none;}@media (max-width:600px){.sat-mp{width:210px;}}' +
      '.sat-mp-h{display:flex;gap:6px;align-items:center;}.sat-mp-h .form-input{flex:1;margin:0 !important;}' +
      '.sat-mp-r{display:flex;gap:4px;margin-bottom:4px;}.sat-mp-r .sat-btn{flex:1;padding:5px 6px;font-size:.74rem;}.sat-mp-o{margin-top:6px;line-height:1.45;}.sat-mp-o .sat-btn{margin-top:4px;padding:4px 8px;}' +
      '#ndviBtn.sat-ndvi-btn.on{background:var(--grad-primary,#1d5a2c) !important;color:#fff !important;}';
    document.head.appendChild(st);
  }


  // ── pixel map on the main map ──
  // A button next to the street/imagery toggle opens the pixel map of one
  // farm (the one in view) with a small panel: farm, date, index, scale.
  var ov = { min: (window.innerWidth || 800) < 600, on: false, layer: null, ctl: null, el: null, fid: null, date: '', idx: 'v', rel: true, pxr: false, docs: {}, pick: null };
  function mainMap() { return window.MapAccess && MapAccess.getMap ? MapAccess.getMap() : null; }
  function overlayOff() {
    ov.on = false;
    var m = mainMap();
    if (ov.layer) ov.layer.clear();
    if (ov.ctl && m) { try { m.removeControl(ov.ctl); } catch (e) {} }
    ov.ctl = null; ov.el = null;
    var b = document.getElementById('ndviBtn'); if (b) b.classList.remove('on');
  }
  function farmInView(m, ids) {
    var c = m.getCenter(), best = null, bd = Infinity;
    ids.forEach(function (fid) {
      plotsOf(fid).forEach(function (p) {
        p.rings.forEach(function (r) {
          if (inRing(c.lng, c.lat, r)) { best = fid; bd = -1; }
          else if (bd >= 0) r.forEach(function (q) { var d = Math.abs(q.lat - c.lat) + Math.abs(q.lng - c.lng); if (d < bd) { bd = d; best = fid; } });
        });
      });
    });
    return best;
  }
  function overlayOn() {
    var m = mainMap();
    if (!m || typeof L === 'undefined' || typeof DB === 'undefined') return;
    ensureCss();
    ov.on = true;
    var b = document.getElementById('ndviBtn'); if (b) b.classList.add('on');
    var fs = farms();
    Promise.all(fs.map(function (f) {
      return DB.loadAsync(PREFIX + f.id).then(function (d) { return { f: f, d: d }; }, function () { return { f: f, d: null }; });
    })).then(function (res) {
      if (!ov.on) return;
      ov.docs = {};
      res.forEach(function (r) { if (r.d && r.d.plots && Object.keys(r.d.plots).length) ov.docs[r.f.id] = norm(r.d); });
      var ids = Object.keys(ov.docs).map(Number);
      if (!ids.length) {
        overlayOff();
        toast('🛰️ ' + tt('אין עדיין נתוני לוויין. פתח "לוויין" ולחץ "עדכון מהלוויין".', 'ยังไม่มีข้อมูลดาวเทียม', 'لا توجد بيانات قمر صناعي بعد'));
        return;
      }
      if (ov.fid == null || ids.indexOf(ov.fid) < 0) ov.fid = farmInView(m, ids) || ids[0];
      if (!ov.layer) ov.layer = PxLayer(m);
      if (!ov.ctl) {
        var el = document.createElement('div');
        el.className = 'sat-mp leaflet-control' + (ov.min ? ' min' : '');
        var Ctl = L.Control.extend({ options: { position: 'topleft' }, onAdd: function () { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); return el; } });
        ov.ctl = new Ctl(); ov.ctl.addTo(m); ov.el = el;
        el.addEventListener('click', function (e) {
          var a = e.target.closest('[data-o]'); if (!a) return;
          var k = a.getAttribute('data-o'), v = a.getAttribute('data-v');
          if (k === 'idx') ov.idx = v; else if (k === 'rel') ov.rel = v === '1'; else if (k === 'pxr') ov.pxr = !ov.pxr;
          else if (k === 'card' && ov.pick) { open(ov.fid, ov.pick); return; }
          else if (k === 'x') { overlayOff(); return; }
          else if (k === 'min') { ov.min = !ov.min; ov.el.classList.toggle('min', ov.min); a.textContent = ov.min ? '▸' : '▾'; return; }
          drawOv(false);
        });
        el.addEventListener('change', function (e) {
          if (e.target.id === 'ovFarm') { ov.fid = Number(e.target.value); ov.date = ''; if (ov.layer) ov.layer.clear(); drawOv(true); }
          if (e.target.id === 'ovDate') { ov.date = e.target.value; drawOv(false); }
        });
      }
      drawOv(true);
    });
  }
  function ovPanel(dates, msg) {
    var cache = (imgDocs[ov.fid] || { imgs: {} }).imgs;
    var fo = farms().filter(function (f) { return ov.docs[f.id]; }).map(function (f) { return '<option value="' + f.id + '"' + (f.id === ov.fid ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
    var B = function (k, v, on, lbl) { return '<button class="sat-btn' + (on ? ' on' : '') + '" data-o="' + k + '" data-v="' + v + '">' + lbl + '</button>'; };
    return '<div class="sat-mp-h"><b>🛰️</b><select class="form-input" id="ovFarm">' + fo + '</select><button class="sat-btn ghost" data-o="min" title="−">' + (ov.min ? '▸' : '▾') + '</button><button class="sat-btn ghost" data-o="x">✕</button></div>' +
      '<select class="form-input" id="ovDate">' + dates.slice(0, 40).map(function (d) { return '<option value="' + d + '"' + (d === ov.date ? ' selected' : '') + '>' + fmtDY(d) + (cache[d] ? ' ✓' : '') + '</option>'; }).join('') + '</select>' +
      '<div class="sat-mp-r">' + B('idx', 'v', ov.idx === 'v', '🌿 NDVI') + B('idx', 'm', ov.idx === 'm', '💧 NDMI') + '</div>' +
      '<div class="sat-mp-r">' + B('rel', '1', ov.rel, tt('יחסי לחלקה', 'เทียบในแปลง', 'نسبي')) + B('rel', '0', !ov.rel, tt('מוחלט', 'ค่าจริง', 'مطلق')) + B('pxr', '1', ov.pxr, '▦') + '</div>' +
      pxLegend(ov.idx, ov.rel) +
      '<div class="sat-mp-o" id="ovOut">' + (msg || '') + '</div>';
  }
  function drawOv(fit) {
    if (!ov.on || !ov.el) return;
    var doc = ov.docs[ov.fid], list = plotsOf(ov.fid);
    var dates = farmDates(doc, list);
    if (!ov.date || dates.indexOf(ov.date) < 0) ov.date = dates[0] || '';
    loadImgs(ov.fid).then(function () {
      ov.el.innerHTML = ovPanel(dates, '⏳ ' + tt('טוען תמונה…', 'กำลังโหลด…', 'جارٍ التحميل…'));
      if (!ov.date) { document.getElementById('ovOut').textContent = tt('אין מעבר נקי', 'ไม่มีภาพ', 'لا صورة'); return; }
      ov.layer.show({ fid: ov.fid, date: ov.date, idx: ov.idx, rel: ov.rel, pixelated: ov.pxr, fit: fit ? 'auto' : '',
        onHover: function (p, h) { var o = document.getElementById('ovOut'); if (o && !ov.pick) o.innerHTML = esc(p.name) + (h ? (h.cloud ? ' · ☁' : ' · ' + (ov.idx === 'm' ? 'NDMI ' : 'NDVI ') + ltr(h.v.toFixed(2))) : ''); },
        onPick: function (p, h) {
          ov.pick = p.id;
          var z = ov.layer.res && ov.layer.res.zone[p.id], o = document.getElementById('ovOut');
          if (!o) return;
          o.innerHTML = '<b>' + esc(p.name) + '</b>' + (h && !h.cloud ? ' · ' + ltr(h.v.toFixed(2)) : '') +
            (z ? '<br>' + tt('חציון', 'มัธยฐาน', 'الوسيط') + ' ' + ltr(z.med.toFixed(2)) + ' · ' + tt('אזור חלש', 'โซนอ่อน', 'منطقة ضعيفة') + ' ' + Math.round(z.weakPct * 100) + '% (' + ltr(z.weakDunam.toFixed(1)) + ' ' + tt('ד׳', 'ไร่', 'دونم') + ')' : '') +
            '<br><button class="sat-btn" data-o="card">📈 ' + tt('כרטיס החלקה', 'การ์ดแปลง', 'بطاقة القطعة') + '</button>';
        },
        onDone: function (res, why) {
          ov.el.innerHTML = ovPanel(dates, res ? '<span class="sat-mut">' + tt('הקש על חלקה לפרטים', 'แตะแปลงเพื่อดูรายละเอียด', 'اضغط على قطعة للتفاصيل') + '</span>'
            : (why === 'nocache' ? tt('אין תמונה שמורה לתאריך הזה — מנהל יכול לטעון', 'ไม่มีภาพ', 'لا صورة محفوظة') : tt('אין תמונה', 'ไม่มีภาพ', 'لا صورة')));
          ov.pick = null;
        } });
    });
  }
  function mountMapButton() {
    var bar = document.querySelector('#tabMap .map-float-bar');
    if (!bar || document.getElementById('ndviBtn')) return;
    var btn = document.createElement('button');
    btn.className = 'layer-toggle sat-ndvi-btn'; btn.id = 'ndviBtn'; btn.type = 'button';
    btn.title = tt('מצב הצמחייה מהלוויין', 'สภาพพืชจากดาวเทียม', 'حالة الغطاء النباتي من القمر الصناعي');
    btn.innerHTML = '<span>🌿</span><span>NDVI</span>';
    btn.onclick = function () { if (ov.on) overlayOff(); else overlayOn(); };
    bar.appendChild(btn);
    ensureCss();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountMapButton); else mountMapButton();

  document.addEventListener('shorashim:lang', function () { if (document.getElementById('satRoot') && D && !busy) render(); });
  document.addEventListener('shorashim:lang', function () { var b = document.getElementById('ndviBtn'); if (b) b.title = tt('מצב הצמחייה מהלוויין', 'สภาพพืชจากดาวเทียม', 'حالة الغطاء النباتي من القمر الصناعي'); });

  return { open: open, close: close };
})();
