/* plotmap.js — how plots look on the main map (Oct 2026)
 * ---------------------------------------------------------
 * Plots are drawn the way the treatment-plan maps draw them: a clean white
 * outline over the imagery, no colour per farm. Each plot writes on itself
 * what it is — name, crop and branch, size, plant count — as much as fits
 * at the current zoom. Farms are told apart by a thin dashed outline around
 * each group of their plots, with the farm's name on it.
 *
 * Hovering a plot (mouse) or a long press (touch) opens a small card with
 * more: farm, variety, planting year, density, the last work-log entry and
 * the last spray on it. A normal click still opens the full plot card.
 *
 * app.js builds the plot layers; this module only restyles them and owns
 * their labels (p.labelMarker), so show/hide (setPlotVisibility), the map
 * filter and undo keep working unchanged. Data (p.color etc.) is untouched.
 */
var PlotMap = (function () {
  'use strict';

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
  function num(n, d) {
    n = Number(n) || 0;
    return d ? (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d })
             : Math.round(n).toLocaleString('he-IL');
  }
  function day(s) {
    var m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? (Number(m[3]) + '.' + m[2] + (m[1] !== String(new Date().getFullYear()) ? '.' + m[1].slice(2) : '')) : String(s || '');
  }

  var ready = function () {
    return typeof map !== 'undefined' && typeof drawnItems !== 'undefined' && typeof plots !== 'undefined' && window.L;
  };

  // ── Style ──
  function sat() { return typeof isSatellite === 'undefined' || !!isSatellite; }
  function base() {
    return sat()
      ? { color: '#ffffff', opacity: 0.9, weight: 2.4, fillColor: '#ffffff', fillOpacity: 0.10, dashArray: null }
      : { color: '#2f6f45', opacity: 0.9, weight: 2.4, fillColor: '#2f6f45', fillOpacity: 0.08, dashArray: null };
  }
  function hot() { return { color: '#ffd84a', opacity: 1, weight: 3.4, fillColor: '#ffd84a', fillOpacity: 0.18, dashArray: null }; }
  function partStyle(s) { var o = {}; Object.keys(s).forEach(function (k) { o[k] = s[k]; }); o.dashArray = '7,5'; o.weight = 2; return o; }

  var hotId = null;
  function paint(p) {
    if (!p.layer || !p.layer.setStyle) return;
    var s = p.id === hotId ? hot() : base();
    p.layer.setStyle(s);
    (p.partLayers || []).forEach(function (l) { if (l.setStyle) l.setStyle(partStyle(s)); });
  }

  // ── What a plot says about itself ──
  function branchOf(p) {
    var PB = window.PlotBranch;
    var v = PB ? PB.forPlot(p) : 'orchard';
    var label = '';
    if (PB) PB.list().forEach(function (b) { if (b.v === v) label = b.label; });
    return { v: v, label: label };
  }
  function cropIco(p) {
    var c = String(p.crop_type || ''), b = branchOf(p).v;
    if (/תמר/.test(c)) return '🌴';
    if (/גפן|ענב/.test(c) || b === 'vineyard') return '🍇';
    if (/זית/.test(c)) return '🫒';
    if (/הדר|תפוז|לימון|אשכולית|קלמנטינ|מנדרינ|פומלה/.test(c)) return '🍊';
    if (/מנגו/.test(c)) return '🥭';
    if (/אבוקדו/.test(c)) return '🥑';
    if (/רימון/.test(c)) return '🍎';
    if (/פלפל/.test(c)) return '🌶️';
    if (/עגבני/.test(c)) return '🍅';
    if (b === 'field') return '🌾';
    if (b === 'veg' || b === 'greenhouse') return '🥬';
    return '🌱';
  }
  // Plural noun for the plant count of the plot's branch; '' = not counted.
  function countWord(p) {
    var v = branchOf(p).v;
    if (v === 'vineyard') return tt('גפנים', 'ต้นองุ่น', 'كرمة');
    if (v === 'greenhouse') return tt('צמחים', 'ต้น', 'نبتة');
    if (v === 'orchard') return tt('עצים', 'ต้น', 'شجرة');
    return '';
  }
  function plotName(p) { return (typeof locName === 'function') ? locName(p) : (p.name || ''); }
  function farmOf(p) { return (typeof farms !== 'undefined' ? farms : []).find(function (f) { return f.id === p.farm_id; }); }
  function farmName(f) { return f ? ((typeof locName === 'function') ? locName(f) : f.name) : ''; }

  function lines(p) {
    var crop = String(p.crop_type || '').trim(), br = branchOf(p);
    var l2 = cropIco(p) + ' ' + [crop, br.label].filter(Boolean).join(' · ');
    var l3 = num(p.area, 1) + ' ' + tt('דונם', 'ไร่', 'دونم');
    var w = countWord(p), l4 = (w && Number(p.tree_count)) ? num(p.tree_count) + ' ' + w : '';
    return { l2: l2, l3: l3, l4: l4 };
  }

  // ── Labels: as much as fits at this zoom ──
  // 3 = name, crop · branch, size, count · 2 = name, size · 1 = name · 0 = none
  function levelFor(p) {
    var b = p.layer.getBounds();
    var a = map.latLngToContainerPoint(b.getNorthWest()), c = map.latLngToContainerPoint(b.getSouthEast());
    var w = Math.abs(c.x - a.x), h = Math.abs(c.y - a.y);
    var nm = plotName(p).length;
    if (w >= Math.max(130, nm * 9) && h >= 88) return 3;
    if (w >= Math.max(80, nm * 8) && h >= 44) return 2;
    if (w >= Math.max(44, nm * 8.5) && h >= 20) return 1;
    return 0;
  }
  function labelHtml(p, lvl) {
    var L1 = lines(p), dark = !sat();
    var h = '<b>' + esc(plotName(p)) + '</b>';
    if (lvl >= 3) h += '<span>' + esc(L1.l2) + '</span>';
    if (lvl >= 2) h += '<span>' + esc(L1.l3) + '</span>';
    if (lvl >= 3 && L1.l4) h += '<span>' + esc(L1.l4) + '</span>';
    return '<div class="pm-lbl' + (dark ? ' pm-dk' : '') + (lvl === 1 ? ' pm-sm' : '') + '">' + h + '</div>';
  }
  function anchor(p) {
    try { return p.layer.getCenter(); } catch (e) { return p.layer.getBounds().getCenter(); }
  }
  function label(p) {
    var shown = drawnItems.hasLayer(p.layer);
    var lvl = shown ? levelFor(p) : 0;
    var key = lvl + '|' + (sat() ? 's' : 'm') + '|' + plotName(p) + '|' + p.area + '|' + p.tree_count + '|' + p.crop_type + '|' + p.branch;
    var mk = p.labelMarker;
    if (!mk || !mk._pm) {
      if (mk && drawnItems.hasLayer(mk)) drawnItems.removeLayer(mk);
      mk = p.labelMarker = L.marker(anchor(p), { icon: L.divIcon({ className: 'pm-wrap', html: '', iconSize: [0, 0] }), interactive: false, keyboard: false });
      mk._pm = true; mk._pmKey = '';
    }
    mk.setLatLng(anchor(p));
    if (mk._pmKey !== key) {
      mk._pmKey = key;
      mk.setIcon(L.divIcon({ className: 'pm-wrap', html: lvl ? labelHtml(p, lvl) : '', iconSize: [0, 0] }));
    }
    if (shown && !drawnItems.hasLayer(mk)) drawnItems.addLayer(mk);
    if (!shown && drawnItems.hasLayer(mk)) drawnItems.removeLayer(mk);
  }

  // ── Farm outlines: one dashed outline per group of a farm's plots ──
  var farmLayer = null;
  function ringsOf(p) {
    var out = [];
    [p.layer].concat(p.partLayers || []).forEach(function (l) {
      if (!l || !l.getLatLngs) return;
      var r = l.getLatLngs(); while (r && r.length && Array.isArray(r[0])) r = r[0];
      (r || []).forEach(function (ll) { out.push([ll.lng, ll.lat]); });
    });
    return out;
  }
  function hull(pts) {
    pts = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    if (pts.length < 3) return pts;
    function cr(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [], i;
    for (i = 0; i < pts.length; i++) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], pts[i]) <= 0) lo.pop(); lo.push(pts[i]); }
    for (i = pts.length - 1; i >= 0; i--) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], pts[i]) <= 0) up.pop(); up.push(pts[i]); }
    up.pop(); lo.pop();
    return lo.concat(up);
  }
  function farms_() {
    if (!farmLayer) farmLayer = L.layerGroup().addTo(map);
    farmLayer.clearLayers();
    var vis = plots.filter(function (p) { return p.layer && drawnItems.hasLayer(p.layer); });
    var byFarm = {};
    vis.forEach(function (p) { (byFarm[p.farm_id] = byFarm[p.farm_id] || []).push(p); });
    var fids = Object.keys(byFarm);
    if (fids.length < 2) return;                 // one farm on screen: nothing to tell apart
    var GAP = 0.0025;                            // ≈ 250 m: plots closer than this are one group
    fids.forEach(function (fid) {
      var ps = byFarm[fid].map(function (p) { return { p: p, b: p.layer.getBounds(), g: -1 }; });
      var g = 0;
      ps.forEach(function (a) {
        if (a.g !== -1) return;
        a.g = g; var stack = [a];
        while (stack.length) {
          var x = stack.pop();
          ps.forEach(function (y) {
            if (y.g !== -1) return;
            var near = !(y.b.getWest() > x.b.getEast() + GAP || y.b.getEast() < x.b.getWest() - GAP ||
                         y.b.getSouth() > x.b.getNorth() + GAP || y.b.getNorth() < x.b.getSouth() - GAP);
            if (near) { y.g = g; stack.push(y); }
          });
        }
        g++;
      });
      var f = farmOf(byFarm[fid][0]);
      for (var gi = 0; gi < g; gi++) {
        var pts = [];
        ps.forEach(function (o) { if (o.g === gi) pts = pts.concat(ringsOf(o.p)); });
        var hl = hull(pts);
        if (hl.length < 3) continue;
        var cx = 0, cy = 0; hl.forEach(function (q) { cx += q[0]; cy += q[1]; }); cx /= hl.length; cy /= hl.length;
        var lls = hl.map(function (q) { return L.latLng(cy + (q[1] - cy) * 1.06 + (q[1] > cy ? 0.00008 : -0.00008), cx + (q[0] - cx) * 1.06 + (q[0] > cx ? 0.0001 : -0.0001)); });
        L.polygon(lls, { color: sat() ? '#ffffff' : '#2f6f45', opacity: 0.6, weight: 1.6, dashArray: '6,6', fill: false, interactive: false }).addTo(farmLayer);
        var top = lls.reduce(function (m, q) { return q.lat > m.lat ? q : m; }, lls[0]);
        var pa = map.latLngToContainerPoint(L.latLngBounds(lls).getNorthWest()), pb = map.latLngToContainerPoint(L.latLngBounds(lls).getSouthEast());
        if (Math.abs(pb.x - pa.x) < 70) continue;  // too small at this zoom for a name tag
        L.marker(top, { interactive: false, keyboard: false, icon: L.divIcon({ className: 'pm-wrap', iconSize: [0, 0],
          html: '<div class="pm-farm">' + esc(farmName(f)) + '</div>' }) }).addTo(farmLayer);
      }
    });
  }

  // ── Refresh (debounced) ──
  var timer = null, busy = false;
  function refresh() {
    timer = null;
    if (!ready() || busy) return;
    busy = true;
    try {
      plots.forEach(function (p) {
        if (!p.layer) return;
        paint(p);
        wire(p);
        label(p);
      });
      farms_();
    } catch (e) { console.warn('PlotMap refresh:', e); }
    busy = false;
  }
  function soon() { if (!timer) timer = setTimeout(refresh, 40); }

  // ── Card (hover / long press) ──
  var card = null, hideT = null, swallowUntil = 0;
  var canHover = window.matchMedia && matchMedia('(hover: hover) and (pointer: fine)').matches;

  function lastWork(p) {
    var list = (typeof worklogEntries !== 'undefined' ? worklogEntries : []).filter(function (e) {
      return e && e.plot_id === p.id && !e.voided && !e.deleted;
    });
    list.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    return list[0] || null;
  }
  function lastSpray(p) {
    var list = (typeof sprayEvents !== 'undefined' ? sprayEvents : []).filter(function (ev) {
      return ev && !ev.voided && ev.plotIds && ev.plotIds.indexOf(p.id) !== -1;
    });
    list.sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    return list[0] || null;
  }
  function workText(e, p) {
    var ty = (typeof WL_TYPES !== 'undefined' && WL_TYPES[e.type]) || e.type || tt('עבודה', 'งาน', 'عمل');
    if (typeof t === 'function') ty = t(ty);
    var bits = [tt('יומן עבודה', 'บันทึกงาน', 'سجل العمل')];
    var wc = Number(e.worker_count) || (Array.isArray(e.workers) ? e.workers.length : 0);
    if (wc) bits.push(wc + ' ' + tt('עובדים', 'คนงาน', 'عمال'));
    if (Number(e.hours)) bits.push(num(e.hours, 1).replace(/\.0$/, '') + ' ' + tt('שעות', 'ชม.', 'ساعات'));
    if (Number(e.trees_completed)) bits.push(num(e.trees_completed) + ' ' + (countWord(p) || tt('עצים', 'ต้น', 'شجرة')));
    return { t: ty + ' · ' + day(e.date), m: bits.join(' · ') };
  }
  function sprayText(ev) {
    var names = (ev.applications || []).map(function (a) { return a.productName || a.name; }).filter(Boolean);
    var m = names.slice(0, 3).join(', ') + (names.length > 3 ? ' +' + (names.length - 3) : '');
    if (ev.operatorName) m += (m ? ' · ' : '') + ev.operatorName;
    return { t: tt('ריסוס', 'การพ่น', 'رش') + ' · ' + day(ev.date), m: m };
  }
  function cardHtml(p) {
    var f = farmOf(p), br = branchOf(p), w = countWord(p);
    var crop = String(p.crop_type || '').trim(), variety = String(p.variety || '').trim();
    var yr = String(p.planting_date || '').slice(0, 4);
    var sub = [farmName(f), crop, variety, yr ? tt('נטיעה', 'ปลูก', 'غرس') + ' ' + yr : ''].filter(Boolean).join(' · ');
    var trees = Number(p.tree_count) || 0, area = Number(p.area) || 0;
    var k = '<div><b>' + num(area, 1) + '</b><span>' + tt('דונם', 'ไร่', 'دونم') + '</span></div>';
    if (w && trees) {
      k += '<div><b>' + num(trees) + '</b><span>' + esc(w) + '</span></div>';
      if (area > 0 && (br.v === 'orchard' || br.v === 'vineyard')) k += '<div><b>' + num(trees / area) + '</b><span>' + esc(w) + '/' + tt('ד׳', 'ไร่', 'د') + '</span></div>';
    } else if (br.label) {
      k += '<div><b style="font-size:.8rem">' + esc(br.label) + '</b><span>' + tt('ענף', 'สาขา', 'فرع') + '</span></div>';
    }
    var rows = '';
    // Registered area (card) vs. traced boundary: shown only when they
    // disagree by more than 3%, which is when one of them is wrong.
    try {
      var mp = window.MapAccess && MapAccess.listPlotsWithRings ? MapAccess.listPlotsWithRings().filter(function (z) { return z.id === p.id; })[0] : null;
      var mea = mp ? Number(mp.measured) || 0 : 0;
      if (area > 0 && mea > 0 && Math.abs(mea - area) / area > 0.03) {
        var d = (mea - area) / area * 100;
        rows += '<div class="pm-warn">' + tt('מסומן במפה', 'บนแผนที่', 'على الخريطة') + ': ' + num(mea, 1) + ' ' + tt('דונם', 'ไร่', 'دونم') +
          ' (' + (d > 0 ? '+' : '−') + num(Math.abs(d)) + '%)</div>';
      }
    } catch (e) {}
    var wk = lastWork(p), sp = lastSpray(p);
    if (wk) { var a = workText(wk, p); rows += '<div class="pm-row"><i>🛠️</i><div><div class="pm-t">' + esc(a.t) + '</div><div class="pm-m">' + esc(a.m) + '</div></div></div>'; }
    if (sp) { var s = sprayText(sp); rows += '<div class="pm-row"><i>🧪</i><div><div class="pm-t">' + esc(s.t) + '</div><div class="pm-m">' + esc(s.m) + '</div></div></div>'; }
    if (!rows) rows = '<div class="pm-row pm-none">' + tt('אין עדיין פעולות ביומן לחלקה הזו', 'ยังไม่มีบันทึก', 'لا توجد سجلات بعد') + '</div>';
    return '<div class="pm-h"><span>' + cropIco(p) + ' ' + esc(plotName(p)) + '</span>' +
        (canHover ? '' : '<button type="button" class="pm-x" aria-label="' + tt('סגור', 'ปิด', 'إغلاق') + '" data-no-sticky data-no-back>✕</button>') + '</div>' +
      '<div class="pm-sub">' + esc(sub) + '</div>' +
      '<div class="pm-kpi">' + k + '</div>' + rows +
      '<button type="button" class="pm-open" data-no-sticky data-no-back>' + tt('פתח כרטיס חלקה', 'เปิดการ์ดแปลง', 'افتح بطاقة القطعة') + '</button>';
  }
  function ensureCard() {
    if (card) return card;
    card = document.createElement('div');
    card.className = 'pm-card';
    card.addEventListener('mouseenter', function () { clearTimeout(hideT); });
    card.addEventListener('mouseleave', function () { hideSoon(); });
    document.body.appendChild(card);
    return card;
  }
  function show(p, pt) {
    if (typeof drawMode !== 'undefined' && drawMode) return;
    clearTimeout(hideT);
    var c = ensureCard();
    c.innerHTML = cardHtml(p);
    c.querySelector('.pm-open').onclick = function () { hide(); if (typeof showPlotDetails === 'function') showPlotDetails(p.id); };
    var x = c.querySelector('.pm-x'); if (x) x.onclick = hide;
    c.classList.toggle('pm-sheet', !canHover);
    c.style.display = 'block';
    if (canHover && pt) {
      var r = map.getContainer().getBoundingClientRect(), cw = c.offsetWidth, ch = c.offsetHeight;
      var ax = r.left + pt.x, ay = r.top + pt.y;
      // beside the pointer, on the side with room, never off the map
      var left = ax + 18 + cw > r.right ? ax - 18 - cw : ax + 18;
      var top = Math.min(Math.max(ay - ch / 2, r.top + 8), r.bottom - ch - 8);
      c.style.left = Math.max(r.left + 8, left) + 'px';
      c.style.top = top + 'px';
    } else {
      c.style.left = ''; c.style.top = '';
    }
    if (hotId !== p.id) { var prev = hotId; hotId = p.id; [prev, p.id].forEach(function (id) { var q = plots.find(function (z) { return z.id === id; }); if (q) paint(q); }); }
  }
  function hide() {
    clearTimeout(hideT);
    if (card) card.style.display = 'none';
    if (hotId != null) { var q = plots.find(function (z) { return z.id === hotId; }); hotId = null; if (q) paint(q); }
  }
  function hideSoon() { clearTimeout(hideT); hideT = setTimeout(hide, 220); }

  function wire(p) {
    [p.layer].concat(p.partLayers || []).forEach(function (l) {
      if (!l || l._pmWired) return;
      l._pmWired = true;
      if (canHover) {
        l.on('mouseover', function (e) { show(p, e.containerPoint); });
        l.on('mousemove', function (e) { if (card && card.style.display === 'block' && hotId === p.id) show(p, e.containerPoint); });
        l.on('mouseout', hideSoon);
      }
      // long press on touch (and right click with a mouse)
      l.on('contextmenu', function (e) {
        if (e.originalEvent) L.DomEvent.preventDefault(e.originalEvent);
        swallowUntil = Date.now() + 800;
        show(p, e.containerPoint);
      });
    });
  }

  // A long press must not also open the full plot card when the finger lifts.
  function swallowClick() { return Date.now() < swallowUntil; }

  function css() {
    if (document.getElementById('pmCss')) return;
    var s = document.createElement('style');
    s.id = 'pmCss';
    s.textContent =
      '.pm-wrap{background:none;border:0}' +
      '.pm-lbl{position:absolute;left:0;top:0;transform:translate(-50%,-50%);text-align:center;white-space:nowrap;pointer-events:none;color:#fff;font-family:Heebo,sans-serif;line-height:1.28;' +
        'text-shadow:0 1px 2px rgba(0,0,0,.8),0 0 6px rgba(0,0,0,.5)}' +
      '.pm-lbl b{display:block;font-size:14px;font-weight:800}' +
      '.pm-lbl span{display:block;font-size:11.5px;font-weight:600}' +
      '.pm-lbl.pm-sm b{font-size:12px}' +
      '.pm-lbl.pm-dk{color:#1f3b27;text-shadow:0 0 3px #fff,0 0 6px #fff,0 0 2px #fff}' +
      '.pm-farm{position:absolute;left:0;top:0;transform:translate(-50%,-115%);white-space:nowrap;pointer-events:none;background:rgba(20,26,22,.62);color:#fff;font:700 11.5px Heebo,sans-serif;' +
        'padding:3px 10px;border-radius:9px;backdrop-filter:blur(4px)}' +
      '.pm-card{position:fixed;z-index:1200;display:none;width:260px;background:rgba(255,255,255,.98);color:#26302a;border-radius:16px;box-shadow:0 8px 28px rgba(0,0,0,.28);' +
        'padding:12px 14px;font:12.5px Heebo,sans-serif;direction:rtl;text-align:right}' +
      '.pm-card.pm-sheet{left:10px!important;right:10px;bottom:calc(10px + env(safe-area-inset-bottom));top:auto!important;width:auto;border-radius:20px;max-width:520px;margin:0 auto}' +
      '.pm-h{display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:800}' +
      '.pm-x{border:0;background:#f1f4ef;border-radius:50%;width:28px;height:28px;cursor:pointer;color:#55605a}' +
      '.pm-sub{color:#6b756e;font-size:11.5px;margin:2px 0 8px}' +
      '.pm-kpi{display:flex;gap:6px;margin-bottom:6px}' +
      '.pm-kpi div{flex:1;background:#f2f6ef;border-radius:10px;padding:5px 6px;text-align:center}' +
      '.pm-kpi b{display:block;font-size:13.5px}.pm-kpi span{font-size:10.5px;color:#6b756e}' +
      '.pm-row{display:flex;gap:8px;padding:6px 0;border-top:1px solid #eef1ec}' +
      '.pm-row i{font-style:normal;width:26px;height:26px;border-radius:8px;background:#eaf3e6;display:flex;align-items:center;justify-content:center;flex:none}' +
      '.pm-warn{font-size:11px;color:#9a5b00;background:#fff6e5;border-radius:8px;padding:4px 8px;margin-bottom:6px}' +
      '.pm-t{font-weight:600}.pm-m{color:#6b756e;font-size:11.5px}.pm-none{color:#6b756e;justify-content:center}' +
      '.pm-open{margin-top:8px;width:100%;border:1px solid #d9e2d4;background:#fff;color:#1d5a2c;border-radius:12px;padding:8px;font:700 12.5px Heebo,sans-serif;cursor:pointer}' +
      '.pm-open:hover{background:#f1f6ee}';
    document.head.appendChild(s);
  }

  function init() {
    if (!ready()) { setTimeout(init, 300); return; }
    css();
    map.on('zoomend', soon);
    map.on('layeradd layerremove', function (e) { if (e.layer instanceof L.TileLayer) soon(); });
    map.on('movestart zoomstart', function () { if (canHover) hide(); });
    map.on('click', function () { if (Date.now() >= swallowUntil) hide(); });
    drawnItems.on('layeradd layerremove', function () { if (!busy) soon(); });
    document.addEventListener('shorashim:plots-rendered', function () { setTimeout(soon, 0); });
    soon();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { refresh: soon, swallowClick: swallowClick, base: base, hide: hide };
})();
