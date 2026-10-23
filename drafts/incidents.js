/* incidents.js — דיווח נזק / גניבה / עץ שנפל, לכל משק (Oct 2026)
 *
 * A report is one event on a farm: damage, theft, or a fallen tree. A
 * fallen tree must be pinned on the map — one tap on "my location" (GPS)
 * or a tap on the satellite map — and the plot is found from the pin. It
 * also records what matters for finding the cause: offshoots (חוטרים),
 * treatments in the last six months (offered from the plot's spray log),
 * mature or young, fell from the base or the crown, live red palm weevil
 * found. A chart sums fallen trees by month (base / crown, weevils found)
 * or by farm, and a map shows where they fell.
 *
 * Data: appData/shorashim-incidents-YYYY { items: [...] } — worker+ write;
 *       each report is its author's (ownership.js).
 * Public: Incidents.open(farmId?), Incidents.report(farmId?)
 */
var Incidents = (function () {
  'use strict';

  var PREFIX = 'shorashim-incidents-';
  var year = String(new Date().getFullYear());
  var D = null, ui = { view: 'list', farm: '', type: '', chart: 'month' }, map = null, fmap = null, F = null;
  var TYPES = [
    { k: 'tree', ic: '🌴', he: 'עץ שנפל', th: 'ต้นล้ม', ar: 'شجرة سقطت', c: '#b3261e' },
    { k: 'damage', ic: '⚠️', he: 'נזק', th: 'ความเสียหาย', ar: 'ضرر', c: '#ef6c00' },
    { k: 'theft', ic: '🚨', he: 'גניבה', th: 'ขโมย', ar: 'سرقة', c: '#6a1b9a' }
  ];

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
  function canWrite() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator' || r === 'worker'; }
  function mine(o) { return !window.Own || Own.canEdit(o, o && o.byName); }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  function today() { return new Date().toISOString().slice(0, 10); }
  function fmtD(iso) { var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[3] + '/' + m[2] + '/' + m[1].slice(2) : (iso || ''); }
  function key() { return PREFIX + year; }
  function typeDef(k) { return TYPES.find(function (t) { return t.k === k; }) || TYPES[1]; }
  function tName(k) { var t = typeDef(k); return tt(t.he, t.th, t.ar); }
  function farms() { return S().getFarms ? S().getFarms() : []; }
  function farmName(id) { var f = farms().find(function (x) { return x.id === Number(id); }); return f ? f.name : ''; }
  function plotsWithRings(fid) {
    var M = window.MapAccess;
    return (M && M.listPlotsWithRings ? M.listPlotsWithRings() : []).filter(function (p) { return !fid || p.farmId === Number(fid); });
  }
  function plotName(id) { var p = plotsWithRings().find(function (x) { return x.id === Number(id); }); return p ? p.name : ''; }
  function inRing(lat, lng, r) {
    var ins = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      var xi = Number(r[i].lng), yi = Number(r[i].lat), xj = Number(r[j].lng), yj = Number(r[j].lat);
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) ins = !ins;
    }
    return ins;
  }
  function plotAt(lat, lng) {
    var hit = null;
    plotsWithRings().forEach(function (p) { if (!hit && p.rings.some(function (r) { return inRing(lat, lng, r); })) hit = p; });
    return hit;
  }

  function norm(d) { d = d && typeof d === 'object' ? d : {}; return { items: Array.isArray(d.items) ? d.items : [] }; }
  function load() {
    if (typeof DB === 'undefined') { D = norm(null); return Promise.resolve(); }
    return DB.loadAsync(key()).then(function (d) { D = norm(d); }, function () { D = null; });
  }
  function persist() {
    if (!D) { toast('❌ ' + tt('אין חיבור — נסה שוב', 'ไม่มีการเชื่อมต่อ', 'لا اتصال')); return Promise.resolve(false); }
    var clean = JSON.parse(JSON.stringify(D));
    var p = DB.saveAsync ? DB.saveAsync(key(), clean) : (DB.save(key(), clean), Promise.resolve());
    return p.then(function () { return true; }, function (e) {
      var c = String((e && (e.code || e.message)) || e);
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + (/permission/i.test(c) ? tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية') : c));
      return false;
    });
  }
  // Treatments of a plot in the six months before a date, from the spray log.
  function recentTreatments(plotId, date) {
    if (!plotId || !S().getEvents) return [];
    var to = Date.parse((date || today()) + 'T23:59:59'), from = to - 183 * 864e5, out = [];
    S().getEvents().forEach(function (ev) {
      var t = Date.parse(String(ev.date || '') + 'T12:00:00');
      if (!(t >= from && t <= to) || ev.voided || (ev.plotIds || []).indexOf(Number(plotId)) === -1) return;
      var mats = (ev.applications || []).map(function (a) { return a.productName; }).filter(Boolean).join(' + ');
      out.push({ id: String(ev.id), label: fmtD(ev.date) + ' · ' + (mats || tt('ריסוס', 'พ่นยา', 'رش')) });
    });
    return out.sort(function (a, b) { return a.label < b.label ? 1 : -1; });
  }

  // ── screens ──
  function shell(inner) {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    if (map) { try { map.remove(); } catch (e) {} map = null; }
    if (fmap) { try { fmap.remove(); } catch (e) {} fmap = null; }
    m.innerHTML = '<div class="modal-overlay" id="icRoot"><div class="modal ic">' +
      '<div class="ic-h"><h2>🌴 ' + tt('נזקים, גניבות ועצים שנפלו', 'ความเสียหาย ขโมย ต้นล้ม', 'الأضرار والسرقات والأشجار الساقطة') + '</h2>' +
        '<select class="form-input ic-y" id="icYear">' + [0, 1, 2].map(function (k) { var y = String(new Date().getFullYear() - k); return '<option' + (y === year ? ' selected' : '') + '>' + y + '</option>'; }).join('') + '</select>' +
        '<button class="ic-btn ghost" data-a="close" aria-label="x">✕</button></div>' + inner + '</div></div>';
    var root = document.getElementById('icRoot');
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
  }
  function open(fid) {
    ensureCss();
    if (fid != null) ui.farm = String(fid);
    ui.view = 'list';
    load().then(render);
  }
  function report(fid) {
    ensureCss();
    load().then(function () { form(null, fid != null ? Number(fid) : (ui.farm ? Number(ui.farm) : null)); });
  }
  function close() { if (map) { try { map.remove(); } catch (e) {} map = null; } if (fmap) { try { fmap.remove(); } catch (e) {} fmap = null; } var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  function filtered() {
    return ((D && D.items) || []).filter(function (it) {
      return (!ui.farm || String(it.farmId) === ui.farm) && (!ui.type || it.type === ui.type);
    }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)) || (b.createdAt || 0) - (a.createdAt || 0); });
  }
  function bar() {
    var fo = '<option value="">' + tt('כל המשקים', 'ทุกฟาร์ม', 'كل المزارع') + '</option>' + farms().map(function (f) { return '<option value="' + f.id + '"' + (String(f.id) === ui.farm ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
    return '<div class="ic-bar">' +
      (canWrite() ? '<button class="ic-btn pri" data-a="new">＋ ' + tt('דיווח חדש', 'รายงานใหม่', 'بلاغ جديد') + '</button>' : '') +
      '<select class="form-input ic-y" id="icFarm">' + fo + '</select>' +
      '<span class="ic-seg">' + [['', tt('הכל', 'ทั้งหมด', 'الكل')]].concat(TYPES.map(function (t) { return [t.k, t.ic + ' ' + tName(t.k)]; })).map(function (x) {
        return '<button class="ic-btn' + (ui.type === x[0] ? ' on' : '') + '" data-type="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</span>' +
      '<span class="ic-seg">' + [['list', '📋 ' + tt('רשימה', 'รายการ', 'قائمة')], ['chart', '📊 ' + tt('גרף נפילות', 'กราฟต้นล้ม', 'رسم السقوط')], ['map', '🗺️ ' + tt('מפה', 'แผนที่', 'خريطة')]].map(function (v) {
        return '<button class="ic-btn' + (ui.view === v[0] ? ' on' : '') + '" data-view="' + v[0] + '">' + v[1] + '</button>'; }).join('') + '</span></div>';
  }
  function render() {
    if (!D) { shell('<div class="ic-empty">' + tt('לא הצלחתי לטעון — בדוק חיבור', 'โหลดไม่ได้', 'تعذّر التحميل') + '</div>'); return; }
    if (ui.view === 'chart') { shell(bar() + chartHtml()); return; }
    if (ui.view === 'map') { shell(bar() + '<div id="icMap" class="ic-map"></div><div class="ic-mut">' + tt('נקודה = עץ שנפל · אדום = נמצאו חדקוניות חיות', 'จุด = ต้นล้ม · แดง = พบด้วง', 'نقطة = شجرة · أحمر = سوس حي') + '</div>'); drawMap(); return; }
    var list = filtered();
    shell(bar() + (list.length ? list.map(card).join('') : '<div class="ic-empty">' + tt('אין דיווחים', 'ไม่มีรายงาน', 'لا بلاغات') + '</div>'));
  }
  function yn(v) { return v === 'yes' ? tt('כן', 'ใช่', 'نعم') : v === 'no' ? tt('לא', 'ไม่', 'لا') : '—'; }
  function card(it) {
    var t = typeDef(it.type), tr = it.tree || {};
    var facts = it.type === 'tree' ? [
      [tt('נפל', 'ล้ม', 'سقط'), tr.fall === 'base' ? tt('מלמטה (בסיס)', 'จากโคน', 'من الأسفل') : tr.fall === 'crown' ? tt('מהצמרת', 'จากยอด', 'من القمة') : '—'],
      [tt('בוגר', 'โตเต็มที่', 'ناضج'), yn(tr.mature)], [tt('חוטרים', 'หน่อ', 'فسائل'), yn(tr.offshoots)],
      [tt('חדקוניות חיות', 'ด้วงมีชีวิต', 'سوس حي'), yn(tr.weevils)]
    ] : (it.value ? [[tt('הערכת נזק', 'มูลค่าความเสียหาย', 'تقدير الضرر'), '₪' + Number(it.value).toLocaleString()]] : []);
    return '<div class="ic-card" style="--c:' + t.c + '"><div class="ic-ch"><b>' + t.ic + ' ' + esc(tName(it.type)) + '</b>' +
        '<span>' + esc(farmName(it.farmId)) + (it.plotId ? ' · ' + esc(plotName(it.plotId)) : '') + '</span><span class="ic-mut">' + fmtD(it.date) + ' · ' + esc(it.createdByName || it.byName || '') + '</span>' +
        (mine(it) ? '<button class="ic-btn ghost" data-edit="' + it.id + '">✏️</button>' : '') + '</div>' +
      (facts.length ? '<div class="ic-facts">' + facts.map(function (f) { return '<span>' + esc(f[0]) + ': <b>' + esc(f[1]) + '</b></span>'; }).join('') + '</div>' : '') +
      (it.type === 'tree' && (tr.treatments || []).length + (tr.treatOther ? 1 : 0) ? '<div class="ic-mut">' + tt('טיפולים בחצי השנה האחרונה', 'การรักษาใน 6 เดือน', 'معالجات آخر 6 أشهر') + ': ' + esc((tr.treatments || []).map(function (x) { return x.label; }).concat(tr.treatOther ? [tr.treatOther] : []).join(' · ')) + '</div>' : '') +
      (it.note ? '<div class="ic-note">' + esc(it.note) + '</div>' : '') +
      (it.lat != null ? '<div class="ic-mut">📍 ' + Number(it.lat).toFixed(5) + ', ' + Number(it.lng).toFixed(5) + '</div>' : '') +
      (window.Comments ? Comments.block('incident:' + it.id, tName(it.type)) : '') +
    '</div>';
  }

  // ── chart: fallen trees ──
  function chartHtml() {
    var trees = ((D && D.items) || []).filter(function (it) { return it.type === 'tree' && (!ui.farm || String(it.farmId) === ui.farm); });
    var sw = '<div class="ic-bar"><span class="ic-seg">' + [['month', tt('לפי חודש', 'รายเดือน', 'حسب الشهر')], ['farm', tt('לפי משק', 'ตามฟาร์ม', 'حسب المزرعة')], ['cause', tt('לפי ממצא', 'ตามผลตรวจ', 'حسب النتيجة')]].map(function (c) {
      return '<button class="ic-btn' + (ui.chart === c[0] ? ' on' : '') + '" data-chart="' + c[0] + '">' + c[1] + '</button>'; }).join('') + '</span>' +
      '<span class="ic-mut">' + trees.length + ' ' + tt('עצים שנפלו ב-', 'ต้นล้มใน', 'شجرة سقطت في') + year + '</span></div>';
    if (!trees.length) return sw + '<div class="ic-empty">' + tt('אין עצים שנפלו בתקופה', 'ไม่มีต้นล้ม', 'لا أشجار ساقطة') + '</div>';
    var cats, labels;
    if (ui.chart === 'farm') {
      var fs = {}; trees.forEach(function (it) { fs[it.farmId] = 1; });
      labels = Object.keys(fs).map(function (f) { return { k: f, l: farmName(f) || '—' }; });
      cats = labels.map(function (L2) { return trees.filter(function (it) { return String(it.farmId) === L2.k; }); });
    } else if (ui.chart === 'cause') {
      labels = [{ l: tt('נפל מלמטה', 'ล้มจากโคน', 'من الأسفل') }, { l: tt('נפל מהצמרת', 'ล้มจากยอด', 'من القمة') }, { l: tt('חדקוניות חיות', 'พบด้วง', 'سوس حي') }, { l: tt('עם חוטרים', 'มีหน่อ', 'بفسائل') }, { l: tt('עץ צעיר', 'ต้นอ่อน', 'شجرة صغيرة') }];
      cats = [
        trees.filter(function (i) { return (i.tree || {}).fall === 'base'; }), trees.filter(function (i) { return (i.tree || {}).fall === 'crown'; }),
        trees.filter(function (i) { return (i.tree || {}).weevils === 'yes'; }), trees.filter(function (i) { return (i.tree || {}).offshoots === 'yes'; }),
        trees.filter(function (i) { return (i.tree || {}).mature === 'no'; })
      ];
    } else {
      labels = []; cats = [];
      for (var mth = 0; mth < 12; mth++) {
        labels.push({ l: new Date(2026, mth, 15).toLocaleDateString(undefined, { month: 'short' }) });
        cats.push(trees.filter(function (it) { return Number(String(it.date).slice(5, 7)) === mth + 1; }));
      }
    }
    var W = 760, H = 280, Lm = 36, Bm = 40, Tm = 14, n = labels.length, max = Math.max.apply(null, cats.map(function (c) { return c.length; }).concat([1]));
    var bw = Math.min(46, (W - Lm - 10) / n - 8), o = '';
    for (var t = 0; t <= Math.min(max, 5); t++) {
      var v = Math.round(max * t / Math.min(max, 5)), y = Tm + (1 - v / max) * (H - Tm - Bm);
      o += '<line x1="' + Lm + '" x2="' + (W - 6) + '" y1="' + y.toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#ece7e0"/><text x="' + (Lm - 6) + '" y="' + (y + 4).toFixed(1) + '" font-size="11" fill="#7a857c" text-anchor="end">' + v + '</text>';
    }
    cats.forEach(function (c, k) {
      var cx = Lm + (k + 0.5) * (W - Lm - 10) / n, h = c.length / max * (H - Tm - Bm), y0 = H - Bm;
      if (ui.chart === 'cause') {
        var colC = ['#8d6e63', '#2e7d32', '#b3261e', '#ef6c00', '#1e88e5'][k];
        o += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (y0 - h).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="4" fill="' + colC + '"/>';
      } else {
        // stacked: base (brown) / crown (green) / unknown (grey), weevil share marked
        var base = c.filter(function (i) { return (i.tree || {}).fall === 'base'; }).length, crown = c.filter(function (i) { return (i.tree || {}).fall === 'crown'; }).length, unk = c.length - base - crown;
        var yy = y0;
        [[base, '#8d6e63'], [crown, '#2e7d32'], [unk, '#b0b7ae']].forEach(function (s) {
          if (!s[0]) return; var hh = s[0] / max * (H - Tm - Bm); yy -= hh;
          o += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + hh.toFixed(1) + '" fill="' + s[1] + '"/>';
        });
        var wv = c.filter(function (i) { return (i.tree || {}).weevils === 'yes'; }).length;
        if (wv) o += '<circle cx="' + cx.toFixed(1) + '" cy="' + (y0 - h - 10).toFixed(1) + '" r="7" fill="#b3261e"/><text x="' + cx.toFixed(1) + '" y="' + (y0 - h - 6.5).toFixed(1) + '" font-size="9" fill="#fff" text-anchor="middle">' + wv + '</text>';
      }
      if (c.length) o += '<text x="' + cx.toFixed(1) + '" y="' + (y0 - h - (ui.chart === 'cause' ? 4 : 20)).toFixed(1) + '" font-size="12" font-weight="700" fill="#1b2a1f" text-anchor="middle">' + c.length + '</text>';
      o += '<text x="' + cx.toFixed(1) + '" y="' + (H - Bm + 16) + '" font-size="11" fill="#5a655c" text-anchor="middle">' + esc(String(labels[k].l).slice(0, 14)) + '</text>';
    });
    var legend = ui.chart === 'cause' ? '' : '<div class="ic-lg"><span><i style="background:#8d6e63"></i>' + tt('נפל מלמטה', 'ล้มจากโคน', 'من الأسفل') + '</span><span><i style="background:#2e7d32"></i>' + tt('נפל מהצמרת', 'ล้มจากยอด', 'من القمة') + '</span><span><i style="background:#b0b7ae"></i>' + tt('לא צוין', 'ไม่ระบุ', 'غير محدد') + '</span><span><i style="background:#b3261e;border-radius:50%"></i>' + tt('מספר עצים עם חדקוניות חיות', 'ต้นที่พบด้วง', 'أشجار بها سوس حي') + '</span></div>';
    return sw + '<div class="ic-chart"><svg style="direction:ltr;width:100%;height:auto;display:block;" viewBox="0 0 ' + W + ' ' + H + '">' + o + '</svg>' + legend + '</div>';
  }
  function drawMap() {
    if (typeof L === 'undefined') return;
    map = L.map('icMap', { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map);
    var b = L.latLngBounds([]);
    plotsWithRings(ui.farm || null).forEach(function (p) {
      p.rings.forEach(function (r) { var ll = r.map(function (q) { return [Number(q.lat), Number(q.lng)]; }); L.polyline(ll.concat([ll[0]]), { color: '#fff', weight: 1, opacity: 0.6, interactive: false }).addTo(map); ll.forEach(function (x) { b.extend(x); }); });
    });
    filtered().forEach(function (it) {
      if (it.lat == null) return;
      var t = typeDef(it.type), wv = it.type === 'tree' && (it.tree || {}).weevils === 'yes';
      L.circleMarker([it.lat, it.lng], { radius: 8, color: '#fff', weight: 2, fillColor: wv ? '#b3261e' : t.c === '#b3261e' ? '#ffb300' : t.c, fillOpacity: 1 }).addTo(map)
        .bindTooltip(t.ic + ' ' + esc(tName(it.type)) + ' · ' + fmtD(it.date) + (it.plotId ? ' · ' + esc(plotName(it.plotId)) : ''), { direction: 'top' });
      b.extend([it.lat, it.lng]);
    });
    if (b.isValid()) map.fitBounds(b, { padding: [24, 24], maxZoom: 17 }); else map.setView([32.03, 35.47], 12);
  }

  // ── report form ──
  function form(id, fid) {
    var it = id ? JSON.parse(JSON.stringify((D.items || []).find(function (x) { return String(x.id) === String(id); }) || {})) : null;
    if (id && !it) return;
    if (it && !mine(it)) { if (window.Own) Own.denied(); return; }
    F = it || { type: 'tree', farmId: fid || (farms()[0] ? farms()[0].id : null), plotId: null, date: today(), lat: null, lng: null, note: '', value: '', tree: { offshoots: '', mature: '', fall: '', weevils: '', treatments: [], treatOther: '' } };
    F.tree = F.tree || { offshoots: '', mature: '', fall: '', weevils: '', treatments: [], treatOther: '' };
    drawForm();
  }
  function seg(name, val, opts) {
    return '<span class="ic-seg">' + opts.map(function (o) { return '<button type="button" class="ic-btn' + (val === o[0] ? ' on' : '') + '" data-f="' + name + '" data-v="' + o[0] + '">' + o[1] + '</button>'; }).join('') + '</span>';
  }
  function drawForm() {
    var isTree = F.type === 'tree', tr = F.tree, YN = [['yes', tt('כן', 'ใช่', 'نعم')], ['no', tt('לא', 'ไม่', 'لا')]];
    var treats = isTree ? recentTreatments(F.plotId, F.date) : [];
    var fo = farms().map(function (f) { return '<option value="' + f.id + '"' + (f.id === Number(F.farmId) ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');
    var po = '<option value="">' + tt('— לפי הסיכה —', '— ตามหมุด —', '— حسب الدبوس —') + '</option>' + plotsWithRings(F.farmId).map(function (p) { return '<option value="' + p.id + '"' + (p.id === Number(F.plotId) ? ' selected' : '') + '>' + esc(p.name) + '</option>'; }).join('');
    shell('<div class="ic-form">' +
      '<div class="ic-types">' + TYPES.map(function (t) { return '<button type="button" class="ic-type' + (F.type === t.k ? ' on' : '') + '" style="--c:' + t.c + '" data-f="type" data-v="' + t.k + '">' + t.ic + '<span>' + esc(tName(t.k)) + '</span></button>'; }).join('') + '</div>' +
      '<div class="ic-g2"><label>' + tt('משק', 'ฟาร์ม', 'المزرعة') + '<select class="form-input" id="icFFarm">' + fo + '</select></label>' +
        '<label>' + tt('תאריך', 'วันที่', 'التاريخ') + '<input type="date" class="form-input" id="icFDate" value="' + esc(F.date) + '"></label></div>' +
      '<div class="ic-pin"><div class="ic-pinh"><b>📍 ' + tt('מיקום', 'ตำแหน่ง', 'الموقع') + (isTree ? ' <span class="ic-req">*</span>' : '') + '</b>' +
        '<button type="button" class="ic-btn pri" data-a="gps">📡 ' + tt('אני ליד העץ — המיקום שלי', 'ฉันอยู่ที่ต้น — ตำแหน่งของฉัน', 'أنا عند الشجرة — موقعي') + '</button></div>' +
        '<div class="ic-mut">' + tt('או הקש על המפה במקום שבו נפל העץ', 'หรือแตะบนแผนที่', 'أو اضغط على الخريطة') + (F.lat != null ? ' · ✅ ' + Number(F.lat).toFixed(5) + ', ' + Number(F.lng).toFixed(5) : '') + '</div>' +
        '<div id="icFMap" class="ic-fmap"></div>' +
        '<label>' + tt('חלקה', 'แปลง', 'القطعة') + '<select class="form-input" id="icFPlot">' + po + '</select></label></div>' +
      (isTree ? '<div class="ic-q">' +
        '<div class="ic-qr"><span>' + tt('העץ נפל', 'ต้นล้ม', 'سقطت الشجرة') + '</span>' + seg('fall', tr.fall, [['base', tt('מלמטה (בסיס)', 'จากโคน', 'من الأسفل')], ['crown', tt('מהצמרת', 'จากยอด', 'من القمة')]]) + '</div>' +
        '<div class="ic-qr"><span>' + tt('עץ בוגר?', 'โตเต็มที่?', 'شجرة ناضجة؟') + '</span>' + seg('mature', tr.mature, YN) + '</div>' +
        '<div class="ic-qr"><span>' + tt('היו לו חוטרים?', 'มีหน่อ?', 'كانت له فسائل؟') + '</span>' + seg('offshoots', tr.offshoots, YN) + '</div>' +
        '<div class="ic-qr"><span>' + tt('נמצאו חדקוניות חיות?', 'พบด้วงมีชีวิต?', 'وُجد سوس حي؟') + '</span>' + seg('weevils', tr.weevils, YN) + '</div>' +
        '<div class="ic-qt"><b>' + tt('טיפולים בחצי השנה האחרונה', 'การรักษาใน 6 เดือนล่าสุด', 'معالجات آخر 6 أشهر') + '</b>' +
          (F.plotId ? (treats.length ? treats.map(function (x) {
            var on = (tr.treatments || []).some(function (y) { return y.id === x.id; });
            return '<label class="ic-chk"><input type="checkbox" data-treat="' + esc(x.id) + '" data-label="' + esc(x.label) + '"' + (on ? ' checked' : '') + '> ' + esc(x.label) + '</label>';
          }).join('') : '<div class="ic-mut">' + tt('אין ריסוסים ביומן לחלקה הזו ב-6 החודשים האחרונים', 'ไม่มีการพ่นในบันทึก', 'لا رش في السجل') + '</div>')
            : '<div class="ic-mut">' + tt('סמן מיקום או בחר חלקה כדי לראות את הטיפולים מיומן הריסוס', 'เลือกแปลงเพื่อดูการรักษา', 'اختر قطعة لرؤية المعالجات') + '</div>') +
          '<input class="form-input" id="icFTreat" placeholder="' + esc(tt('טיפולים נוספים (הזרקה, הגמעה, חומר אחר…)', 'การรักษาอื่น', 'معالجات أخرى')) + '" value="' + esc(tr.treatOther || '') + '"></div>' +
      '</div>' : '<label class="ic-lbl">' + tt('הערכת נזק (₪, לא חובה)', 'มูลค่า (₪)', 'تقدير الضرر (₪)') + '<input class="form-input" id="icFValue" type="number" min="0" inputmode="numeric" value="' + esc(F.value || '') + '"></label>') +
      '<label class="ic-lbl">' + tt('תיאור', 'รายละเอียด', 'الوصف') + '<textarea class="form-input" id="icFNote" rows="3">' + esc(F.note || '') + '</textarea></label>' +
      '<div class="ic-bar"><button class="ic-btn pri" data-a="save">💾 ' + tt('שמור דיווח', 'บันทึกรายงาน', 'حفظ البلاغ') + '</button>' +
        (F.id ? '<button class="ic-btn warn" data-a="del">🗑 ' + tt('מחק', 'ลบ', 'حذف') + '</button>' : '') +
        '<button class="ic-btn ghost" data-a="back">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div>' +
    '</div>');
    drawFormMap();
  }
  function readForm() {
    var g = function (id) { var e = document.getElementById(id); return e ? e.value : ''; };
    F.farmId = Number(g('icFFarm')) || F.farmId; F.date = g('icFDate') || F.date; F.note = g('icFNote');
    var pv = g('icFPlot'); F.plotId = pv ? Number(pv) : F.plotId;
    if (document.getElementById('icFValue')) F.value = g('icFValue');
    if (document.getElementById('icFTreat')) F.tree.treatOther = g('icFTreat');
    var ts = [];
    document.querySelectorAll('[data-treat]').forEach(function (c) { if (c.checked) ts.push({ id: c.getAttribute('data-treat'), label: c.getAttribute('data-label') }); });
    if (document.querySelector('[data-treat]')) F.tree.treatments = ts;
  }
  function setPin(lat, lng) {
    readForm();
    F.lat = +lat.toFixed(6); F.lng = +lng.toFixed(6);
    var p = plotAt(F.lat, F.lng);
    if (p) { F.plotId = p.id; if (p.farmId) F.farmId = p.farmId; }
    drawForm();
  }
  function drawFormMap() {
    if (typeof L === 'undefined' || !document.getElementById('icFMap')) return;
    fmap = L.map('icFMap', { attributionControl: false });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(fmap);
    var b = L.latLngBounds([]);
    plotsWithRings(F.farmId).forEach(function (p) {
      p.rings.forEach(function (r) {
        var ll = r.map(function (q) { return [Number(q.lat), Number(q.lng)]; });
        L.polygon(ll, { color: p.id === Number(F.plotId) ? '#ffeb3b' : '#fff', weight: p.id === Number(F.plotId) ? 3 : 1.2, fillOpacity: 0.05, interactive: false }).addTo(fmap);
        ll.forEach(function (x) { b.extend(x); });
      });
    });
    if (F.lat != null) {
      L.circleMarker([F.lat, F.lng], { radius: 10, color: '#fff', weight: 3, fillColor: '#b3261e', fillOpacity: 1 }).addTo(fmap);
      L.circleMarker([F.lat, F.lng], { radius: 22, color: '#b3261e', weight: 2, fill: false, dashArray: '4 4', interactive: false }).addTo(fmap);
      fmap.setView([F.lat, F.lng], 18);
    } else if (b.isValid()) fmap.fitBounds(b, { padding: [16, 16], maxZoom: 17 });
    else fmap.setView([32.03, 35.47], 12);
    fmap.on('click', function (e) { setPin(e.latlng.lat, e.latlng.lng); });
  }
  function save() {
    readForm();
    if (!F.farmId) { toast('❌ ' + tt('בחר משק', 'เลือกฟาร์ม', 'اختر مزرعة')); return; }
    if (F.type === 'tree' && F.lat == null) { toast('📍 ' + tt('לעץ שנפל חובה לסמן מיקום במפה', 'ต้องปักหมุดตำแหน่ง', 'يجب تحديد الموقع على الخريطة')); return; }
    if (F.type === 'tree' && !F.tree.fall) { toast('❌ ' + tt('ציין אם העץ נפל מלמטה או מהצמרת', 'ระบุว่าล้มจากโคนหรือยอด', 'حدد هل سقطت من الأسفل أم القمة')); return; }
    var u = window.currentUser || {};
    if (!F.id) { F.id = uid(); F.byName = u.name || u.username || ''; if (window.Own) Own.stamp(F); D.items.push(F); }
    else D.items = D.items.map(function (x) { return String(x.id) === String(F.id) ? F : x; });
    persist().then(function (ok) { if (ok) { toast('✅ ' + tt('הדיווח נשמר', 'บันทึกแล้ว', 'حُفظ البلاغ')); ui.view = 'list'; render(); } });
  }

  function onChange(e) {
    var t = e.target;
    if (t.id === 'icYear') { year = t.value; load().then(render); return; }
    if (t.id === 'icFarm') { ui.farm = t.value; render(); return; }
    if (t.id === 'icFFarm') { readForm(); F.farmId = Number(t.value); F.plotId = null; drawForm(); return; }
    if (t.id === 'icFPlot' || t.id === 'icFDate') { readForm(); drawForm(); }
  }
  function onClick(e) {
    var t = e.target;
    if (t.id === 'icRoot') return close();
    var f = t.closest('[data-f]');
    if (f) {
      readForm();
      var k = f.getAttribute('data-f'), v = f.getAttribute('data-v');
      if (k === 'type') F.type = v; else F.tree[k] = F.tree[k] === v ? '' : v;
      drawForm(); return;
    }
    var ty = t.closest('[data-type]'); if (ty) { ui.type = ty.getAttribute('data-type'); render(); return; }
    var vw = t.closest('[data-view]'); if (vw) { ui.view = vw.getAttribute('data-view'); render(); return; }
    var ch = t.closest('[data-chart]'); if (ch) { ui.chart = ch.getAttribute('data-chart'); render(); return; }
    var ed = t.closest('[data-edit]'); if (ed) { form(ed.getAttribute('data-edit')); return; }
    var a = t.closest('[data-a]');
    if (!a) return;
    var k2 = a.getAttribute('data-a');
    if (k2 === 'close') return close();
    if (k2 === 'new') return form(null, ui.farm ? Number(ui.farm) : null);
    if (k2 === 'back') { ui.view = 'list'; return render(); }
    if (k2 === 'save') return save();
    if (k2 === 'del') {
      if (!mine(F) || !confirm(tt('למחוק את הדיווח?', 'ลบรายงาน?', 'حذف البلاغ؟'))) return;
      D.items = D.items.filter(function (x) { return String(x.id) !== String(F.id); });
      persist().then(function () { ui.view = 'list'; render(); }); return;
    }
    if (k2 === 'gps') {
      if (!navigator.geolocation) { toast('❌ ' + tt('אין GPS במכשיר', 'ไม่มี GPS', 'لا GPS')); return; }
      toast('📡 ' + tt('מאתר מיקום…', 'กำลังหาตำแหน่ง…', 'جارٍ تحديد الموقع…'));
      navigator.geolocation.getCurrentPosition(function (p) { setPin(p.coords.latitude, p.coords.longitude); },
        function () { toast('❌ ' + tt('אין גישה למיקום — הקש על המפה', 'ไม่มีตำแหน่ง — แตะแผนที่', 'لا موقع — اضغط على الخريطة')); }, { enableHighAccuracy: true, timeout: 15000 });
    }
  }

  function ensureCss() {
    if (document.getElementById('icCss')) return;
    var st = document.createElement('style'); st.id = 'icCss';
    st.textContent =
      '.ic{max-width:860px !important;width:100%;}.ic-h{display:flex;gap:8px;align-items:center;margin-bottom:8px;}.ic-h h2{flex:1;margin:0;font-size:1.1rem;}.ic-y{width:auto !important;margin:0 !important;}' +
      '.ic-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:7px 11px;font:inherit;font-weight:600;font-size:.8rem;cursor:pointer;min-height:38px;}' +
      '.ic-btn.pri{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.ic-btn.ghost{background:transparent;}.ic-btn.on{background:var(--primary-soft,#e2efe7);border-color:var(--primary,#2d6a4f);}.ic-btn.warn{color:#b3261e;}' +
      '.ic-bar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:8px 0;}.ic-seg{display:inline-flex;gap:4px;flex-wrap:wrap;}' +
      '.ic-card{border-inline-start:4px solid var(--c);background:var(--card,#fff);border-radius:14px;padding:10px 12px;margin-bottom:8px;box-shadow:0 1px 3px rgba(0,0,0,.06);}' +
      '.ic-ch{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}.ic-ch b{font-size:.92rem;}.ic-ch .ic-btn{margin-inline-start:auto;padding:3px 8px;min-height:30px;}' +
      '.ic-facts{display:flex;gap:10px;flex-wrap:wrap;font-size:.8rem;margin-top:6px;}.ic-note{font-size:.84rem;margin-top:6px;white-space:pre-wrap;}' +
      '.ic-mut{font-size:.74rem;color:var(--text-muted,#6f7b72);margin-top:4px;}.ic-empty{padding:28px 10px;text-align:center;color:var(--text-muted,#6f7b72);}' +
      '.ic-map{height:420px;border-radius:16px;margin-top:6px;}.ic-fmap{height:240px;border-radius:14px;margin:6px 0;}' +
      '.ic-form label,.ic-lbl{display:flex;flex-direction:column;gap:3px;font-size:.76rem;color:var(--text-muted,#6f7b72);margin-bottom:8px;}.ic-form .form-input{margin:0 !important;}' +
      '.ic-g2{display:grid;grid-template-columns:1fr 1fr;gap:8px;}' +
      '.ic-types{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-bottom:10px;}' +
      '.ic-type{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 6px;border-radius:14px;border:2px solid var(--line,#e6ebe2);background:var(--card,#fff);font:inherit;font-size:1.4rem;cursor:pointer;}' +
      '.ic-type span{font-size:.84rem;font-weight:700;color:var(--text,#1b2a1f);}.ic-type.on{border-color:var(--c);background:color-mix(in srgb,var(--c) 10%,#fff);}' +
      '.ic-pin{background:var(--tonal,#f3f6ef);border-radius:14px;padding:10px;margin-bottom:10px;}.ic-pinh{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap;}.ic-req{color:#b3261e;}' +
      '.ic-q{background:#fff7f5;border-radius:14px;padding:10px;margin-bottom:10px;display:flex;flex-direction:column;gap:8px;}' +
      '.ic-qr{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:.86rem;}.ic-qt{display:flex;flex-direction:column;gap:4px;font-size:.84rem;}' +
      '.ic-chk{flex-direction:row !important;align-items:center;gap:6px !important;color:var(--text,#1b2a1f) !important;font-size:.82rem !important;margin:0 !important;}' +
      '.ic-chart{border:1px solid var(--line,#e6ebe2);border-radius:14px;padding:8px;background:var(--card,#fff);}' +
      '.ic-lg{display:flex;gap:12px;flex-wrap:wrap;font-size:.74rem;color:var(--text-muted,#6f7b72);margin-top:4px;}.ic-lg i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-inline-end:4px;vertical-align:-1px;}';
    document.head.appendChild(st);
  }

  document.addEventListener('shorashim:lang', function () { if (document.getElementById('icRoot') && D && !document.getElementById('icFMap')) render(); });

  return { open: open, report: report, close: close };
})();
window.Incidents = Incidents;
