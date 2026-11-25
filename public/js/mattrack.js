/* mattrack.js — מעקב חומרים (material tracking for a maintenance job)
 * ------------------------------------------------------------------
 * One row per material the job needs, grouped by name and unit (the same
 * profile can appear on several quote lines — a truss chord and a girder
 * chord are the same steel to buy). Each row answers four questions:
 *
 *   NEEDED    the quote's quantity (which, for a job linked to a build
 *             project, is the design's takeoff).
 *   ORDERED   supplier orders that refer to this job or its build project
 *             (sent / confirmed / delivered), lines matched by name. An
 *             order line in bars ("מוט 12 מ'") counts as metres.
 *   RECEIVED  deliveries — the job's shipments — entered here against the
 *             row (in the line's unit or in bars), or older free-text ones
 *             matched by name.
 *   USED      work logged in the tracking journal against the row's quote
 *             lines (maintjournal.js), read-only.
 *
 * BARS
 *   Steel is bought in stock lengths, not metres. For a job with a build
 *   project the actual pieces come from the design (BuildPlan.cutPieces);
 *   they are packed into stock bars first-fit-decreasing with a saw kerf,
 *   so the row says "7 bars of 12 m, 3.2 m off-cut" rather than "73.7 m".
 *   A piece longer than the bar is split and flagged as a splice. Stock
 *   length is 12 m unless set to 6 m per row; the choice is saved with the
 *   job (p.stock). Roof sheets are cut to length, at most 6 m: a sheet line
 *   longer than that is flagged.
 *
 * Nothing here is stored except deliveries (as the job's shipments) and the
 * stock length choice; everything else is derived each time it opens.
 * Globals: MatTrack. Reads Maintenance, Orders data, BuildPlan, DB.
 */
var MatTrack = (function () {
  'use strict';

  var KERF = 0.003;               // m per cut
  var SHEET_MAX = 6;              // roof sheets come cut to length, up to 6 m
  var ORD_KEY = 'shorashim-orders';
  var J_PREFIX = 'shorashim-maint-journal-';
  var _st = {};                   // per job: { data, form }

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
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function r2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function keyOf(name, unit) { return String(name || '').trim() + '|' + String(unit || '').trim(); }
  function isMetre(u) { return /^מ'?$|^m$/i.test(String(u || '').trim()); }
  var STEEL = /^(SHS|RHS|CHS|C |Z |L |IPE|IPN|HEA|HEB|UPN|UNP|PFC)|^מוט פלדה|^צינור/i;
  function isSteel(name, unit) { return isMetre(unit) && STEEL.test(String(name || '').trim()); }
  function isSheet(name) { return /פח|איסכורית|לוח פנל|פאנל/.test(String(name || '')); }
  function sheetLen(name) { var m = String(name || '').match(/אורך\s*([\d.]+)/); return m ? Number(m[1]) : 0; }
  // "מוט 12 מ'" / "מוטות 6 מ'" as an order or delivery unit → metres per unit.
  function barUnit(u) { var m = String(u || '').match(/מוט\S*\s*([\d.]+)/); return m ? Number(m[1]) : 0; }

  // ── bars: first-fit decreasing ────────────────────────────────────────
  function packBars(pieces, stock) {
    var list = [], splices = 0;
    pieces.forEach(function (pc) {
      for (var i = 0; i < pc.count; i++) {
        var L = pc.len;
        while (L > stock + 1e-9) { list.push(stock); L -= stock; splices++; }
        if (L > 1e-6) list.push(L);
      }
    });
    list.sort(function (a, b) { return b - a; });
    var bars = [];
    list.forEach(function (L) {
      for (var b = 0; b < bars.length; b++) {
        if (bars[b] + L + (bars[b] > 0 ? KERF : 0) <= stock + 1e-9) { bars[b] += L + (bars[b] > 0 ? KERF : 0); return; }
      }
      bars.push(L);
    });
    var used = bars.reduce(function (s, x) { return s + x; }, 0);
    return { bars: bars.length, off: r1(bars.length * stock - used), splices: splices, pieces: list.length };
  }

  // ── gather everything one job needs ───────────────────────────────────
  function load(pid) {
    return Maintenance.loadProjects().then(function (ps) {
      var p = (ps || []).filter(function (x) { return x.id === pid; })[0];
      if (!p) throw new Error('project');
      var jP = (typeof DB !== 'undefined' && DB.loadAsync) ? DB.loadAsync(J_PREFIX + pid).catch(function () { return null; }) : Promise.resolve(null);
      var oP = (typeof DB !== 'undefined' && DB.loadAsync) ? DB.loadAsync(ORD_KEY).catch(function () { return null; }) : Promise.resolve(null);
      var cP = (p.buildProjectId && typeof BuildPlan !== 'undefined' && BuildPlan.cutPieces)
        ? BuildPlan.cutPieces(p.buildProjectId).catch(function () { return []; }) : Promise.resolve([]);
      return Promise.all([jP, oP, cP]).then(function (r) { return build(p, r[0], r[1], r[2]); });
    });
  }

  function build(p, journal, ordersDoc, pieces) {
    var rows = {}, order = [];
    (p.materials || []).forEach(function (m) {
      var k = keyOf(m.name, m.unit);
      if (!rows[k]) { rows[k] = { key: k, name: String(m.name || '').trim(), unit: String(m.unit || '').trim(), need: 0, ids: [], ordered: 0, received: 0, used: 0, deliveries: [] }; order.push(k); }
      rows[k].need += Number(m.quantity) || 0;
      if (m._id) rows[k].ids.push('materials:' + m._id);
    });
    // ordered — orders that name this job or its build project
    var refs = [String(p.id)]; if (p.buildProjectId) refs.push(String(p.buildProjectId));
    var ords = (ordersDoc && Array.isArray(ordersDoc.orders)) ? ordersDoc.orders : [];
    ords.forEach(function (o) {
      if (['sent', 'confirmed', 'delivered'].indexOf(String(o.status)) < 0) return;
      var hay = String(o.ref || '') + ' ' + String(o.title || '');
      if (!refs.some(function (r) { return hay.indexOf(r) >= 0; }) && String(o.title || '') !== String(p.name || '')) return;
      (o.lines || []).forEach(function (l) {
        var bu = barUnit(l.unit), name = String(l.name || '').trim();
        var k = bu ? null : keyOf(name, l.unit);
        if (bu) { order.forEach(function (kk) { if (!k && rows[kk].name === name && isMetre(rows[kk].unit)) k = kk; }); }
        if (k && rows[k]) rows[k].ordered += (Number(l.qty) || 0) * (bu || 1);
      });
    });
    // received — the job's shipments
    (p.shipments || []).forEach(function (s) {
      var k = s.key && rows[s.key] ? s.key : null;
      if (!k) order.forEach(function (kk) { if (!k && rows[kk].name === String(s.materialName || '').trim()) k = kk; });
      if (!k) return;
      rows[k].received += Number(s.quantity) || 0;
      rows[k].deliveries.push(s);
    });
    // used — tracking journal work against the row's quote lines
    if (journal && Array.isArray(journal.items)) {
      var refRow = {};
      order.forEach(function (k) { rows[k].ids.forEach(function (id) { refRow[id] = k; }); });
      var adj = {};
      journal.items.forEach(function (it) { if (refRow[it.ref]) adj[it.ref] = Number(it.adj) || 0; });
      Object.keys(adj).forEach(function (ref) { rows[refRow[ref]].used += adj[ref]; });
      (journal.entries || []).forEach(function (e) {
        if (e.kind === 'work' && refRow[e.ref]) rows[refRow[e.ref]].used += Number(e.qty) || 0;
      });
    }
    // bars per steel row
    var stockOf = p.stock || {};
    var byProf = {};
    (pieces || []).forEach(function (pc) { (byProf[pc.profile] = byProf[pc.profile] || []).push(pc); });
    order.forEach(function (k) {
      var r = rows[k];
      if (!isSteel(r.name, r.unit)) return;
      var stock = Number(stockOf[k]) || 12;
      var pcs = byProf[r.name];
      var res = pcs ? packBars(pcs, stock) : { bars: Math.ceil(r.need / stock - 1e-9), off: r1(Math.ceil(r.need / stock - 1e-9) * stock - r.need), splices: 0, pieces: 0 };
      // A quantity typed above the design's pieces (an override, extras) is
      // bought as well: never fewer bars than the quote's metres need.
      var floor = Math.ceil(r.need / stock - 1e-9);
      if (res.bars < floor) { res.off = r1(res.off + (floor - res.bars) * stock); res.bars = floor; }
      r.stock = stock; r.bars = res; r.fromDesign = !!pcs;
    });
    order.forEach(function (k) {
      var r = rows[k];
      r.need = r2(r.need); r.ordered = r2(r.ordered); r.received = r2(r.received); r.used = r2(r.used);
      var tol = Math.max(0.01, r.need * 0.001);
      r.status = r.need <= 0 ? 'none'
        : r.received > r.need * 1.05 + tol ? 'over'
        : r.received >= r.need - tol ? 'ok'
        : r.ordered > r.received + tol ? 'waiting'
        : 'short';
      if (isSheet(r.name) && sheetLen(r.name) > SHEET_MAX + 1e-9) r.warn = tt('גליון ארוך מ-' + SHEET_MAX + ' מ\' — לא ניתן לספק', 'ยาวเกิน', 'أطول من المسموح');
    });
    return { p: p, rows: order.map(function (k) { return rows[k]; }) };
  }

  // ── UI ────────────────────────────────────────────────────────────────
  var BADGE = {
    ok:      ['#1b7a4b', '✅', function () { return tt('התקבל במלואו', 'ครบ', 'مكتمل'); }],
    short:   ['#c25700', '🟠', function () { return tt('חסר', 'ขาด', 'ناقص'); }],
    waiting: ['#1565c0', '⏳', function () { return tt('הוזמן, ממתין', 'สั่งแล้ว รอ', 'طُلب، بانتظار'); }],
    over:    ['#6a1b9a', '🔵', function () { return tt('התקבל עודף', 'เกิน', 'زيادة'); }],
    none:    ['#888', '—', function () { return ''; }]
  };
  var CSS = 'font-family:inherit;';
  function btn(label, on, kind) {
    var bg = kind === 'primary' ? 'var(--primary,#2d6a4f)' : 'transparent';
    var fg = kind === 'primary' ? '#fff' : 'var(--primary,#2d6a4f)';
    return '<button onclick="' + on + '" style="' + CSS + 'padding:6px 12px;border-radius:8px;border:1px solid var(--primary,#2d6a4f);background:' + bg + ';color:' + fg + ';font-weight:700;font-size:.8rem;cursor:pointer;">' + label + '</button>';
  }

  function render(pid) {
    var st = _st[pid]; if (!st || !st.data) return;
    var p = st.data.p, rows = st.data.rows;
    var mc = document.getElementById('modalContainer'); if (!mc) return;
    var cnt = { ok: 0, short: 0, waiting: 0, over: 0 };
    rows.forEach(function (r) { if (cnt[r.status] != null) cnt[r.status]++; });
    var canEdit = true;   // Maintenance.addShipment enforces the job's rules
    var head =
      '<div style="position:sticky;top:0;z-index:2;background:var(--card-bg,#fff);padding:10px 0 8px;border-bottom:1px solid var(--border,#ddd);display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<div><div style="font-weight:800;font-size:1.05rem;">📦 ' + tt('מעקב חומרים', 'ติดตามวัสดุ', 'تتبع المواد') + '</div>' +
          '<div style="font-size:.78rem;color:var(--text-muted,#888);">' + esc(p.name) + (p.client ? ' · ' + esc(p.client) : '') + '</div></div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
          (cnt.short || cnt.waiting ? btn('📋 ' + tt('הזמנה מהחסר', 'สั่งส่วนที่ขาด', 'طلب الناقص'), 'MatTrack.orderShort(' + pid + ')') : '') +
          btn('← ' + tt('חזרה', 'กลับ', 'رجوع'), 'MatTrack.close(' + pid + ')') +
          btn('✕', 'MatTrack.close(' + pid + ')') +
        '</div></div>';
    var sum = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:10px 0;font-size:.82rem;">' +
      ['ok', 'waiting', 'short', 'over'].map(function (s) {
        return '<span style="padding:4px 10px;border-radius:12px;background:rgba(127,127,127,.08);color:' + BADGE[s][0] + ';font-weight:700;">' +
          BADGE[s][1] + ' ' + BADGE[s][2]() + ': ' + cnt[s] + '</span>';
      }).join('') + '</div>';
    var tbl = '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:.8rem;">' +
      '<thead><tr style="text-align:right;color:var(--text-muted,#888);">' +
        '<th style="padding:6px;">' + tt('חומר', 'วัสดุ', 'مادة') + '</th>' +
        '<th>' + tt('נדרש', 'ต้องการ', 'مطلوب') + '</th><th>' + tt('הוזמן', 'สั่ง', 'طُلب') + '</th>' +
        '<th>' + tt('התקבל', 'ได้รับ', 'استُلم') + '</th><th>' + tt('נוצל', 'ใช้', 'استُخدم') + '</th>' +
        '<th>' + tt('מצב', 'สถานะ', 'الحالة') + '</th><th></th></tr></thead><tbody>' +
      rows.map(function (r, i) {
        var b = BADGE[r.status];
        var gap = r.need - r.received;
        var bars = r.bars
          ? '<div style="font-size:.72rem;color:var(--text-muted,#777);margin-top:2px;">' +
              '📏 ' + r.bars.bars + ' ' + tt('מוטות', 'ท่อน', 'قضبان') + ' × ' +
              '<select onchange="MatTrack.stock(' + pid + ',' + i + ',this.value)" style="' + CSS + 'font-size:.72rem;padding:0 2px;">' +
                [6, 12].map(function (L) { return '<option value="' + L + '"' + (r.stock === L ? ' selected' : '') + '>' + L + '</option>'; }).join('') +
              '</select> ' + tt('מ\'', 'ม.', 'م') + ' · ' + tt('שארית', 'เศษ', 'فضلة') + ' ' + r.bars.off + ' ' + tt('מ\'', 'ม.', 'م') +
              (r.bars.splices ? ' · ⚠️ ' + r.bars.splices + ' ' + tt('חיבורי המשכה', 'รอยต่อ', 'وصلات') : '') +
              (r.fromDesign ? ' · ' + tt('לפי חיתוך מהתכנון', 'ตามแบบ', 'حسب التصميم') : '') + '</div>'
          : '';
        var warn = r.warn ? '<div style="font-size:.72rem;color:#b3261e;font-weight:700;">⚠️ ' + esc(r.warn) + '</div>' : '';
        var dl = r.deliveries.length
          ? '<div style="font-size:.7rem;color:var(--text-muted,#888);">' + r.deliveries.map(function (s) {
              return esc(s.date || '') + ' · ' + r1(s.quantity) + (s.bars ? ' (' + s.bars + ' ' + tt('מוטות', 'ท่อน', 'قضبان') + ')' : '') + (s.supplier ? ' · ' + esc(s.supplier) : '');
            }).join(' | ') + '</div>' : '';
        var form = (_st[pid].form === i) ? formRow(pid, i, r) : '';
        return '<tr style="border-top:1px solid var(--border,#e5e5e5);vertical-align:top;">' +
          '<td style="padding:6px;"><b dir="auto">' + esc(r.name) + '</b> <span style="color:var(--text-muted,#888);">' + esc(r.unit) + '</span>' + bars + warn + dl + '</td>' +
          '<td style="padding:6px;">' + r1(r.need) + '</td>' +
          '<td style="padding:6px;">' + (r.ordered ? r1(r.ordered) : '—') + '</td>' +
          '<td style="padding:6px;font-weight:700;">' + (r.received ? r1(r.received) : '—') + '</td>' +
          '<td style="padding:6px;">' + (r.used ? r1(r.used) : '—') + '</td>' +
          '<td style="padding:6px;color:' + b[0] + ';font-weight:700;white-space:nowrap;">' + b[1] + ' ' + b[2]() +
            (r.status === 'short' || r.status === 'waiting' ? ' ' + r1(gap) : r.status === 'over' ? ' +' + r1(-gap) : '') + '</td>' +
          '<td style="padding:6px;">' + (canEdit ? '<button onclick="MatTrack.form(' + pid + ',' + i + ')" style="' + CSS + 'border:1px solid var(--border,#ccc);background:transparent;border-radius:6px;padding:3px 8px;cursor:pointer;font-weight:700;">+ ' + tt('התקבל', 'รับ', 'استلام') + '</button>' : '') + '</td>' +
          '</tr>' + form;
      }).join('') + '</tbody></table></div>';
    var foot = '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:10px;">' +
      tt('נדרש = כתב הכמויות של העבודה. הוזמן = הזמנות ספק שנשלחו ומפנות לעבודה או לפרויקט הבנייה. התקבל = משלוחים. נוצל = עבודה שנרשמה ביומן המעקב. גליונות פח: עד ' + SHEET_MAX + ' מ\' אורך.',
         'ต้องการ = BOQ; สั่ง = ใบสั่งซื้อ; ได้รับ = การจัดส่ง; ใช้ = บันทึกงาน', 'مطلوب = جدول الكميات؛ طُلب = أوامر الشراء؛ استُلم = الشحنات؛ استُخدم = سجل العمل') + '</div>';
    mc.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:16px;">' +
      '<div style="background:var(--card-bg,#fff);color:var(--text,#222);border-radius:14px;width:min(980px,100%);padding:0 16px 16px;box-shadow:0 10px 40px rgba(0,0,0,.25);">' +
      head + sum + tbl + foot + '</div></div>';
  }

  function formRow(pid, i, r) {
    var today = new Date(); var iso = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    var gap = Math.max(0, r1(r.need - r.received));
    var inp = 'style="' + CSS + 'padding:6px;border-radius:6px;border:1px solid var(--border,#ccc);"';
    var unitSel = r.bars
      ? '<select id="mtU" ' + inp + '><option value="line">' + esc(r.unit) + '</option><option value="bar">' + tt('מוטות', 'ท่อน', 'قضبان') + ' ' + r.stock + ' ' + tt('מ\'', 'ม.', 'م') + '</option></select>'
      : '<span>' + esc(r.unit) + '</span>';
    return '<tr><td colspan="7" style="padding:8px;background:rgba(77,163,255,.07);">' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
        '<input id="mtD" type="date" value="' + iso + '" ' + inp + '>' +
        '<input id="mtQ" type="number" min="0" step="0.1" value="' + gap + '" ' + inp + ' style="' + CSS + 'width:90px;padding:6px;border-radius:6px;border:1px solid var(--border,#ccc);">' +
        unitSel +
        '<input id="mtS" placeholder="' + esc(tt('ספק', 'ผู้จัดส่ง', 'المورد')) + '" ' + inp + '>' +
        '<input id="mtN" placeholder="' + esc(tt('תעודת משלוח / הערה', 'หมายเหตุ', 'ملاحظة')) + '" ' + inp + '>' +
        btn('💾 ' + tt('שמור', 'บันทึก', 'حفظ'), 'MatTrack.receive(' + pid + ',' + i + ')', 'primary') +
        btn(tt('ביטול', 'ยกเลิก', 'إلغاء'), 'MatTrack.form(' + pid + ',-1)') +
      '</div></td></tr>';
  }

  function open(pid) {
    _st[pid] = _st[pid] || { form: -1 };
    var mc = document.getElementById('modalContainer');
    if (mc) mc.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:10000;display:flex;align-items:center;justify-content:center;"><div style="background:#fff;padding:20px;border-radius:12px;">⏳</div></div>';
    return load(pid).then(function (data) { _st[pid].data = data; render(pid); })
      .catch(function (e) { toast('❌ ' + (e && e.message ? e.message : 'load')); close(pid); });
  }
  function close(pid) {
    var mc = document.getElementById('modalContainer'); if (mc) mc.innerHTML = '';
    if (pid && typeof Maintenance !== 'undefined' && Maintenance.showDetail) Maintenance.showDetail(pid);
  }
  function form(pid, i) { if (!_st[pid]) return; _st[pid].form = (i >= 0 && _st[pid].form !== i) ? i : -1; render(pid); }
  function receive(pid, i) {
    var st = _st[pid]; if (!st || !st.data) return;
    var r = st.data.rows[i]; if (!r) return;
    var q = parseFloat((document.getElementById('mtQ') || {}).value) || 0;
    if (!(q > 0)) { toast('⚠️ ' + tt('כמות חסרה', 'ไม่มีจำนวน', 'الكمية ناقصة')); return; }
    var u = (document.getElementById('mtU') || {}).value;
    var bars = (u === 'bar' && r.stock) ? q : 0;
    var qty = bars ? q * r.stock : q;
    var s = { date: (document.getElementById('mtD') || {}).value || '', materialName: r.name, key: r.key, quantity: r2(qty),
              supplier: ((document.getElementById('mtS') || {}).value || '').trim(), notes: ((document.getElementById('mtN') || {}).value || '').trim() };
    if (bars) s.bars = bars;
    Maintenance.addShipment(pid, s).then(function (ok) {
      if (!ok) return;
      st.form = -1;
      toast('✅ ' + tt('נרשם', 'บันทึกแล้ว', 'تم التسجيل'));
      return load(pid).then(function (data) { st.data = data; render(pid); });
    });
  }
  function stock(pid, i, v) {
    var st = _st[pid]; if (!st || !st.data) return;
    var r = st.data.rows[i]; if (!r) return;
    Maintenance.setStock(pid, r.key, Number(v) || 12).then(function () {
      return load(pid).then(function (data) { st.data = data; render(pid); });
    });
  }
  // What is still missing becomes a supplier order: steel in whole bars,
  // everything else in its own unit. Orders lets the user pick the
  // supplier and send it; the order's ref points back to this job, so
  // once sent it shows up here as ordered.
  function orderShort(pid) {
    var st = _st[pid]; if (!st || !st.data || typeof Orders === 'undefined' || !Orders.draftFrom) return;
    var p = st.data.p, lines = [];
    st.data.rows.forEach(function (r) {
      var miss = r.need - Math.max(r.received, r.ordered);
      if (!(miss > 0.01)) return;
      if (r.bars && r.stock) {
        var frac = r.need > 0 ? miss / r.need : 1;
        var nb = Math.max(1, Math.ceil(r.bars.bars * frac - 1e-9));
        lines.push({ name: r.name, qty: nb, unit: 'מוט ' + r.stock + " מ'", note: r1(miss) + " מ'" });
      } else {
        lines.push({ name: r.name, qty: r2(miss), unit: r.unit, note: '' });
      }
    });
    if (!lines.length) { toast('✅ ' + tt('אין חסרים', 'ไม่มีขาด', 'لا نواقص')); return; }
    Orders.draftFrom({ title: p.name || '', source: 'maintenance', ref: tt('תחזוקה', 'ซ่อมบำรุง', 'صيانة') + ' #' + p.id, lines: lines });
  }

  return { open: open, close: close, form: form, receive: receive, stock: stock, orderShort: orderShort,
           _packBars: packBars, _build: build };
})();
window.MatTrack = MatTrack;
