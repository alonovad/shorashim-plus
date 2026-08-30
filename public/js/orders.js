/* orders.js — ספקים והזמנות (suppliers & purchase orders)
 * ------------------------------------------------------------------
 * The shared back end for every "count it and send it to a supplier"
 * flow in the app. Two very different producers feed it:
 *
 *   agriplan.js  — a season treatment plan totals up to N litres of a
 *                  pesticide across all farms. That total IS an order.
 *   buildplan.js — a parametric structure takeoff totals up to N Z-purlins
 *                  and M m² of insulated panel. Same object, different
 *                  catalogue.
 *
 * So neither of them owns ordering. They hand Orders.draftFrom() a set of
 * lines and a provenance ref, and this module handles supplier matching,
 * pricing, the order document and the send.
 *
 * DATA
 *   appData/shorashim-suppliers  { suppliers: [...] }
 *   appData/shorashim-orders     { orders: [...], seq: n }
 *
 * A supplier carries its own catalogue (items[]). That is deliberate: the
 * same physical product has a different SKU and a different price at each
 * supplier, and a single global catalogue would force one of them to be
 * wrong. Matching a line to an item is by name, case- and space-insensitive,
 * and an unmatched line still orders — it just has no price, and the order
 * says so instead of silently costing zero.
 *
 * Access: operator+ writes (enforced in firestore.rules AND here). A worker
 * can see nothing from this module — it is not wired into their menu.
 */
var Orders = (function () {
  'use strict';

  var SUP_KEY = 'shorashim-suppliers';
  var ORD_KEY = 'shorashim-orders';

  var S = { suppliers: [] };
  var O = { orders: [], seq: 0 };
  var _lastSupSaved = '';
  var _lastOrdSaved = '';
  var _listening = false;
  var _draft = null;   // pending draft handed in by another module

  // Unit strings are stored on every order line and on every supplier
  // catalogue item, so they are data. Kept in Hebrew as the key and
  // translated only where they are shown.
  var UNITS = ['ליטר', 'ק"ג', "יח'", "מ'", 'מ"ר', 'מ"ק', 'טון', 'שק', 'גליל', 'משטח'];
  var UNIT_TX = {
    'ליטר': ['ลิตร', 'لتر'],   'ק"ג': ['กก.', 'كغ'],
    "יח'":  ['ชิ้น', 'قطعة'],  "מ'":  ['ม.', 'م'],
    'מ"ר':  ['ตร.ม.', 'م²'],   'מ"ק': ['ลบ.ม.', 'م³'],
    'טון':  ['ตัน', 'طن'],     'שק':  ['ถุง', 'كيس'],
    'גליל': ['ม้วน', 'لفة'],   'משטח': ['พาเลท', 'منصة']
  };
  function dspUnit(u) {
    var e = UNIT_TX[u];
    return e ? tt(u, e[0], e[1]) : String(u == null ? '' : u);
  }

  var STATUS = [
    { v: 'draft',     c: '#9e9e9e' },
    { v: 'sent',      c: '#1565c0' },
    { v: 'confirmed', c: '#2e7d32' },
    { v: 'delivered', c: '#4caf50' },
    { v: 'cancelled', c: '#c62828' }
  ];

  function statusLabel(v) {
    if (v === 'draft')     return tt('טיוטה', 'แบบร่าง', 'مسودة');
    if (v === 'sent')      return tt('נשלחה', 'ส่งแล้ว', 'أُرسلت');
    if (v === 'confirmed') return tt('אושרה', 'ยืนยันแล้ว', 'مؤكدة');
    if (v === 'delivered') return tt('סופקה', 'ส่งมอบแล้ว', 'تم التسليم');
    if (v === 'cancelled') return tt('בוטלה', 'ยกเลิก', 'ملغاة');
    return v;
  }
  function statusColor(v) {
    for (var i = 0; i < STATUS.length; i++) if (STATUS[i].v === v) return STATUS[i].c;
    return '#9e9e9e';
  }

  // ── helpers ──
  function tt(he, th, ar) {
    return (typeof window.tt === 'function') ? window.tt(he, th, ar) : he;
  }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }
  function isManager() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }
  // Money and quantities are summed unrounded and rounded once, at display.
  // Rounding per line and summing the rounded values is how a report ends up
  // disagreeing with the spreadsheet it was built from.
  function n2(x) { return Math.round((Number(x) || 0) * 100) / 100; }
  function money(x) {
    return '\u20aa' + (Math.round((Number(x) || 0) * 100) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }

  // ── persistence ──
  function normSup(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = { suppliers: [] };
    if (Array.isArray(s.suppliers)) {
      out.suppliers = s.suppliers.map(function (x) {
        return {
          id: x.id || uid(),
          name: String(x.name || ''),
          contact: String(x.contact || ''),
          phone: String(x.phone || ''),
          email: String(x.email || ''),
          notes: String(x.notes || ''),
          items: Array.isArray(x.items) ? x.items.map(function (it) {
            return {
              id: it.id || uid(),
              name: String(it.name || ''),
              sku: String(it.sku || ''),
              unit: String(it.unit || UNITS[0]),
              price: Number(it.price) || 0
            };
          }) : []
        };
      });
    }
    return out;
  }

  function normOrd(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = { orders: [], seq: Number(s.seq) || 0 };
    if (Array.isArray(s.orders)) {
      out.orders = s.orders.map(function (o) {
        return {
          id: o.id || uid(),
          no: String(o.no || ''),
          title: String(o.title || ''),
          supplierId: o.supplierId || null,
          supplierName: String(o.supplierName || ''),
          source: String(o.source || ''),
          ref: String(o.ref || ''),
          status: String(o.status || 'draft'),
          neededBy: String(o.neededBy || ''),
          notes: String(o.notes || ''),
          createdAt: Number(o.createdAt) || Date.now(),
          createdBy: String(o.createdBy || ''),
          sentAt: Number(o.sentAt) || 0,
          lines: Array.isArray(o.lines) ? o.lines.map(function (l) {
            return {
              name: String(l.name || ''),
              qty: Number(l.qty) || 0,
              unit: String(l.unit || ''),
              sku: String(l.sku || ''),
              price: Number(l.price) || 0,
              note: String(l.note || '')
            };
          }) : []
        };
      });
    }
    return out;
  }

  function loadAll() {
    return Promise.all([DB.loadAsync(SUP_KEY), DB.loadAsync(ORD_KEY)])
      .then(function (r) {
        S = normSup(r[0]);
        O = normOrd(r[1]);
        return true;
      });
  }

  function listen() {
    if (_listening) return;
    _listening = true;
    DB.listen(SUP_KEY, function (d) {
      var j = JSON.stringify(d);
      if (j === _lastSupSaved) return;      // our own write echoing back
      S = normSup(d);
      if (isOpen()) render();
    });
    DB.listen(ORD_KEY, function (d) {
      var j = JSON.stringify(d);
      if (j === _lastOrdSaved) return;
      O = normOrd(d);
      if (isOpen()) render();
    });
  }

  function saveSup() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var clean = JSON.parse(JSON.stringify(S));
    _lastSupSaved = JSON.stringify(clean);
    DB.save(SUP_KEY, clean);
  }
  function saveOrd() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var clean = JSON.parse(JSON.stringify(O));
    _lastOrdSaved = JSON.stringify(clean);
    DB.save(ORD_KEY, clean);
  }

  // ── catalogue matching ──
  // Given a supplier and a free-text line name, find the catalogue item.
  // Returns null when there is no match; the caller must treat that as
  // "no price known", never as zero.
  function matchItem(sup, name) {
    if (!sup) return null;
    var k = norm(name);
    var hit = null;
    (sup.items || []).forEach(function (it) {
      if (!hit && norm(it.name) === k) hit = it;
    });
    return hit;
  }

  // Which suppliers stock a given line name at all? Used to suggest a
  // supplier for a draft rather than making the user guess.
  function suppliersFor(names) {
    var score = {};
    (S.suppliers || []).forEach(function (sup) {
      var n = 0;
      names.forEach(function (nm) { if (matchItem(sup, nm)) n++; });
      if (n) score[sup.id] = n;
    });
    return (S.suppliers || []).filter(function (s) { return score[s.id]; })
      .sort(function (a, b) { return score[b.id] - score[a.id]; })
      .map(function (s) { return { id: s.id, name: s.name, matched: score[s.id], of: names.length }; });
  }

  function orderTotal(o) {
    var sum = 0, unpriced = 0;
    (o.lines || []).forEach(function (l) {
      if (l.price > 0) sum += l.qty * l.price; else unpriced++;
    });
    return { sum: sum, unpriced: unpriced };
  }

  // ── public entry point for producer modules ──
  // lines: [{ name, qty, unit, note }]
  function draftFrom(payload) {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    payload = payload || {};
    var lines = (payload.lines || []).filter(function (l) { return (Number(l.qty) || 0) > 0; });
    if (!lines.length) {
      toast('\u26a0\ufe0f ' + tt('אין שורות להזמנה', 'ไม่มีรายการ', 'لا بنود'));
      return;
    }
    _draft = {
      title: String(payload.title || ''),
      source: String(payload.source || ''),
      ref: String(payload.ref || ''),
      lines: lines.map(function (l) {
        return {
          name: String(l.name || ''),
          qty: Number(l.qty) || 0,
          unit: String(l.unit || ''),
          sku: '',
          price: 0,
          note: String(l.note || '')
        };
      })
    };
    loadAll().then(function () { listen(); renderDraft(); });
  }

  // ── UI ──
  function isOpen() { return !!document.getElementById('ordRoot'); }
  function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }

  function open() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    loadAll().then(function () { listen(); render(); });
  }
  function openSuppliers() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    loadAll().then(function () { listen(); renderSuppliers(); });
  }

  // The stylesheet lives in <head>, NOT inside the modal markup.
  // paint() replaces modalContainer.innerHTML, which would delete a
  // <style> tag rendered inside it — so the first screen was styled and
  // every screen after it lost its CSS and reflowed to the page bottom.
  function ensureCss() {
    if (document.getElementById('ordCss')) return;
    var st = document.createElement('style');
    st.id = 'ordCss';
    st.textContent =
      '.ord-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;overflow:auto;padding:14px;}' +
      '.ord-sheet{max-width:960px;margin:0 auto;background:var(--surface,#fff);color:var(--text,#222);' +
        'border-radius:16px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);}' +
      '.ord-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;' +
        'padding-bottom:10px;border-bottom:2px solid var(--border,#e0e0e0);flex-wrap:wrap;}' +
      '.ord-head h3{margin:0;font-weight:800;font-size:1.05rem;}' +
      '.ord-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.ord-btn{padding:9px 13px;border:none;border-radius:10px;background:var(--primary,#2d6a4f);color:#fff;' +
        'font-family:inherit;font-weight:700;font-size:.84rem;cursor:pointer;}' +
      '.ord-btn.ghost{background:var(--surface-glass,#eef1ee);color:var(--text,#333);}' +
      '.ord-btn.warn{background:#c62828;}' +
      '.ord-card{background:var(--surface-glass,#f5f7f5);border-radius:12px;padding:12px;margin-bottom:10px;}' +
      '.ord-row{display:grid;grid-template-columns:1fr 90px 80px 100px 32px;gap:6px;align-items:center;margin-bottom:6px;}' +
      '.ord-row input,.ord-row select{width:100%;padding:7px;border-radius:8px;border:1px solid var(--border,#ccc);' +
        'font-family:inherit;font-size:.82rem;background:var(--surface,#fff);color:var(--text,#222);}' +
      '.ord-lbl{font-size:.7rem;color:var(--text-muted,#888);font-weight:700;}' +
      '.ord-item{background:var(--surface,#fff);border-radius:10px;padding:10px 12px;margin-bottom:6px;cursor:pointer;' +
        'border-inline-start:4px solid #9e9e9e;}' +
      '.ord-pill{display:inline-block;padding:2px 9px;border-radius:20px;font-size:.7rem;font-weight:700;color:#fff;}' +
      '.ord-empty{text-align:center;color:var(--text-muted,#999);padding:18px;font-size:.86rem;}' +
      '@media(max-width:640px){.ord-row{grid-template-columns:1fr 70px 60px 32px;}.ord-row .ord-hide-sm{display:none;}}' +
      '';
    document.head.appendChild(st);
  }

  function shell(title, bar, body) {
    ensureCss();
    return '<div class="ord-back" id="ordRoot"><div class="ord-sheet">' +
      '<div class="ord-head"><div><h3>' + title + '</h3></div>' +
      '<button class="ord-btn ghost" onclick="Orders.close()">\u2715 ' +
        tt('סגור', 'ปิด', 'إغلاق') + '</button></div>' +
      '<div class="ord-bar">' + bar + '</div>' + body + '</div></div>';
  }

  function paint(html) {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = html;
  }

  // ── orders list ──
  function render() {
    var bar =
      '<button class="ord-btn" onclick="Orders.newBlank()">\u2795 ' +
        tt('הזמנה חדשה', 'ใบสั่งซื้อใหม่', 'طلب جديد') + '</button>' +
      '<button class="ord-btn ghost" onclick="Orders.openSuppliers()">\ud83c\udfea ' +
        tt('ספקים וקטלוג', 'ซัพพลายเออร์', 'الموردون') + '</button>';

    var body = '';
    var list = (O.orders || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; });
    if (!list.length) {
      body = '<div class="ord-empty">' +
        tt('אין הזמנות עדיין. תוכנית טיפולים או כתב כמויות יכולים לייצר הזמנה אוטומטית.',
           'ยังไม่มีใบสั่งซื้อ', 'لا توجد طلبات بعد') + '</div>';
    } else {
      list.forEach(function (o) {
        var t = orderTotal(o);
        body += '<div class="ord-item" style="border-inline-start-color:' + statusColor(o.status) + ';" ' +
          'onclick="Orders.showOrder(' + o.id + ')">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<strong>' + esc(o.no) + ' \u00b7 ' + esc(o.title || o.supplierName) + '</strong>' +
            '<span class="ord-pill" style="background:' + statusColor(o.status) + ';">' +
              statusLabel(o.status) + '</span></div>' +
          '<div style="font-size:.78rem;color:var(--text-muted,#888);margin-top:4px;">' +
            '\ud83c\udfea ' + esc(o.supplierName || tt('ללא ספק', 'ไม่มีผู้ขาย', 'بدون مورّد')) +
            ' \u00b7 ' + (o.lines || []).length + ' ' + tt('שורות', 'รายการ', 'بنود') +
            ' \u00b7 ' + money(t.sum) +
            (t.unpriced ? ' \u00b7 \u26a0\ufe0f ' + t.unpriced + ' ' +
              tt('ללא מחיר', 'ไม่มีราคา', 'بدون سعر') : '') +
            (o.ref ? ' \u00b7 ' + esc(o.ref) : '') +
          '</div></div>';
      });
    }
    paint(shell('\ud83d\udce6 ' + tt('הזמנות לספקים', 'ใบสั่งซื้อ', 'طلبات الموردين'), bar, body));
  }

  function newBlank() {
    _draft = { title: '', source: 'manual', ref: '', lines: [{ name: '', qty: 0, unit: UNITS[0], sku: '', price: 0, note: '' }] };
    renderDraft();
  }

  // ── draft editor ──
  function renderDraft() {
    var d = _draft;
    if (!d) { render(); return; }
    var names = d.lines.map(function (l) { return l.name; });
    var sugg = suppliersFor(names);

    var supOpts = '<option value="">' + tt('— בחר ספק —', '— เลือก —', '— اختر —') + '</option>';
    (S.suppliers || []).forEach(function (s) {
      var tag = '';
      for (var i = 0; i < sugg.length; i++) {
        if (sugg[i].id === s.id) { tag = '  (' + sugg[i].matched + '/' + sugg[i].of + ')'; break; }
      }
      supOpts += '<option value="' + s.id + '"' + (d.supplierId === s.id ? ' selected' : '') + '>' +
        esc(s.name) + tag + '</option>';
    });

    var rows = '';
    d.lines.forEach(function (l, i) {
      rows += '<div class="ord-row">' +
        '<input value="' + esc(l.name) + '" placeholder="' + tt('פריט', 'รายการ', 'صنف') +
          '" oninput="Orders._setLine(' + i + ',\'name\',this.value)">' +
        '<input type="number" step="any" value="' + (l.qty || '') + '" placeholder="0" ' +
          'oninput="Orders._setLine(' + i + ',\'qty\',this.value)">' +
        '<input value="' + esc(l.unit) + '" placeholder="' + tt('יח\'', 'หน่วย', 'وحدة') +
          '" oninput="Orders._setLine(' + i + ',\'unit\',this.value)">' +
        '<input class="ord-hide-sm" type="number" step="any" value="' + (l.price || '') + '" ' +
          'placeholder="' + tt('מחיר', 'ราคา', 'سعر') + '" ' +
          'oninput="Orders._setLine(' + i + ',\'price\',this.value)">' +
        '<button class="ord-btn warn" style="padding:6px 8px;" onclick="Orders._delLine(' + i + ')">\ud83d\uddd1</button>' +
      '</div>';
    });

    var t = orderTotal({ lines: d.lines });
    var body = '<div class="ord-card">' +
      '<div class="ord-lbl">' + tt('כותרת', 'ชื่อ', 'العنوان') + '</div>' +
      '<input style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);' +
        'font-family:inherit;background:var(--surface,#fff);color:var(--text,#222);margin-bottom:8px;" ' +
        'value="' + esc(d.title) + '" oninput="Orders._setHead(\'title\',this.value)">' +
      '<div class="ord-lbl">' + tt('ספק', 'ผู้ขาย', 'المورّد') + '</div>' +
      '<select style="width:100%;padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);' +
        'font-family:inherit;background:var(--surface,#fff);color:var(--text,#222);margin-bottom:8px;" ' +
        'onchange="Orders._pickSupplier(this.value)">' + supOpts + '</select>' +
      '<div class="ord-lbl">' + tt('נדרש עד', 'ต้องการภายใน', 'مطلوب بحلول') + '</div>' +
      '<input type="date" style="padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);' +
        'font-family:inherit;background:var(--surface,#fff);color:var(--text,#222);" ' +
        'value="' + esc(d.neededBy || '') + '" oninput="Orders._setHead(\'neededBy\',this.value)">' +
      (d.ref ? '<div style="font-size:.75rem;color:var(--text-muted,#888);margin-top:8px;">\ud83d\udd17 ' +
        esc(d.ref) + '</div>' : '') +
    '</div>' +

    '<div class="ord-card">' +
      '<div class="ord-row" style="font-weight:700;font-size:.72rem;color:var(--text-muted,#888);">' +
        '<div>' + tt('פריט', 'รายการ', 'صنف') + '</div><div>' + tt('כמות', 'จำนวน', 'كمية') + '</div>' +
        '<div>' + tt('יחידה', 'หน่วย', 'وحدة') + '</div>' +
        '<div class="ord-hide-sm">' + tt('מחיר ליח\'', 'ราคา/หน่วย', 'سعر/وحدة') + '</div><div></div></div>' +
      rows +
      '<button class="ord-btn ghost" onclick="Orders._addLine()">\u2795 ' +
        tt('שורה', 'แถว', 'سطر') + '</button>' +
      '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border,#ddd);' +
        'display:flex;justify-content:space-between;font-weight:800;">' +
        '<span>' + tt('סה"כ', 'รวม', 'المجموع') + '</span><span>' + money(t.sum) + '</span></div>' +
      (t.unpriced ? '<div style="font-size:.76rem;color:#e65100;margin-top:4px;">\u26a0\ufe0f ' +
        t.unpriced + ' ' + tt('שורות ללא מחיר — הסכום חלקי',
          'รายการไม่มีราคา', 'بنود بدون سعر') + '</div>' : '') +
    '</div>';

    var bar =
      '<button class="ord-btn" onclick="Orders._saveDraft()">\ud83d\udcbe ' +
        tt('שמור הזמנה', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="ord-btn ghost" onclick="Orders.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell('\ud83d\udcdd ' + tt('טיוטת הזמנה', 'ร่างใบสั่งซื้อ', 'مسودة طلب'), bar, body));
  }

  function _setHead(k, v) { if (_draft) _draft[k] = v; }
  function _setLine(i, k, v) {
    if (!_draft || !_draft.lines[i]) return;
    _draft.lines[i][k] = (k === 'qty' || k === 'price') ? (Number(v) || 0) : v;
    // Re-render only on name change — that is what re-scores suppliers and
    // re-prices the line. Re-rendering on every keystroke of a number would
    // drop focus mid-entry.
    if (k === 'name') {
      var sup = supById(_draft.supplierId);
      var it = matchItem(sup, v);
      if (it) { _draft.lines[i].price = it.price; _draft.lines[i].sku = it.sku; _draft.lines[i].unit = it.unit; }
    }
  }
  function _addLine() {
    if (!_draft) return;
    _draft.lines.push({ name: '', qty: 0, unit: UNITS[0], sku: '', price: 0, note: '' });
    renderDraft();
  }
  function _delLine(i) {
    if (!_draft) return;
    _draft.lines.splice(i, 1);
    renderDraft();
  }
  function supById(id) {
    var hit = null;
    (S.suppliers || []).forEach(function (s) { if (s.id === id) hit = s; });
    return hit;
  }
  // Picking a supplier re-prices every line from THAT supplier's catalogue.
  // Prices are supplier-specific, so carrying the previous supplier's numbers
  // across would produce an order that quotes the wrong company's rates.
  function _pickSupplier(v) {
    if (!_draft) return;
    var id = Number(v) || null;
    _draft.supplierId = id;
    var sup = supById(id);
    _draft.supplierName = sup ? sup.name : '';
    _draft.lines.forEach(function (l) {
      var it = matchItem(sup, l.name);
      if (it) { l.price = it.price; l.sku = it.sku; if (it.unit) l.unit = it.unit; }
      else { l.price = 0; l.sku = ''; }
    });
    renderDraft();
  }

  function _saveDraft() {
    if (!_draft) return;
    var d = _draft;
    if (!d.lines.filter(function (l) { return l.name && l.qty > 0; }).length) {
      toast('\u26a0\ufe0f ' + tt('אין שורות תקינות', 'ไม่มีรายการที่ถูกต้อง', 'لا بنود صالحة'));
      return;
    }
    O.seq = (O.seq || 0) + 1;
    var u = window.currentUser || {};
    var o = {
      id: uid(),
      no: 'PO-' + new Date().getFullYear() + '-' + String(O.seq).padStart(4, '0'),
      title: d.title || tt('הזמנה', 'ใบสั่งซื้อ', 'طلب'),
      supplierId: d.supplierId || null,
      supplierName: d.supplierName || '',
      source: d.source || 'manual',
      ref: d.ref || '',
      status: 'draft',
      neededBy: d.neededBy || '',
      notes: '',
      createdAt: Date.now(),
      createdBy: u.username || '',
      sentAt: 0,
      lines: d.lines.filter(function (l) { return l.name && l.qty > 0; })
    };
    O.orders.push(o);
    saveOrd();
    if (window.Audit && Audit.log) Audit.log('create', 'orders', String(o.id), { after: o });
    _draft = null;
    toast('\u2705 ' + tt('ההזמנה נשמרה', 'บันทึกแล้ว', 'تم الحفظ') + ' ' + o.no);
    render();
  }

  // ── single order ──
  function ordById(id) {
    var hit = null;
    (O.orders || []).forEach(function (o) { if (o.id === id) hit = o; });
    return hit;
  }

  function showOrder(id) {
    var o = ordById(id);
    if (!o) { render(); return; }
    var t = orderTotal(o);
    var rows = '';
    (o.lines || []).forEach(function (l) {
      rows += '<div style="display:flex;justify-content:space-between;gap:8px;padding:6px 0;' +
        'border-bottom:1px solid var(--border,#eee);font-size:.85rem;">' +
        '<span>' + esc(l.name) + (l.sku ? ' <span style="color:var(--text-muted,#999);">(' +
          esc(l.sku) + ')</span>' : '') + '</span>' +
        '<span style="white-space:nowrap;">' + n2(l.qty) + ' ' + esc(dspUnit(l.unit)) +
          (l.price ? ' \u00b7 ' + money(l.qty * l.price) : ' \u00b7 \u2014') + '</span></div>';
    });

    var statusSel = '<select onchange="Orders._setStatus(' + o.id + ',this.value)" ' +
      'style="padding:7px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
      'background:var(--surface,#fff);color:var(--text,#222);">';
    STATUS.forEach(function (s) {
      statusSel += '<option value="' + s.v + '"' + (o.status === s.v ? ' selected' : '') + '>' +
        statusLabel(s.v) + '</option>';
    });
    statusSel += '</select>';

    var sup = supById(o.supplierId);
    var body = '<div class="ord-card">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center;">' +
        '<strong>' + esc(o.no) + '</strong>' + statusSel + '</div>' +
      '<div style="font-size:.8rem;color:var(--text-muted,#888);margin-top:6px;">\ud83c\udfea ' +
        esc(o.supplierName || tt('ללא ספק', 'ไม่มีผู้ขาย', 'بدون مورّد')) +
        (sup && sup.phone ? ' \u00b7 ' + esc(sup.phone) : '') +
        (o.neededBy ? ' \u00b7 ' + tt('נדרש עד', 'ภายใน', 'بحلول') + ' ' + esc(o.neededBy) : '') +
        (o.ref ? '<br>\ud83d\udd17 ' + esc(o.ref) : '') + '</div>' +
    '</div>' +
    '<div class="ord-card">' + rows +
      '<div style="display:flex;justify-content:space-between;font-weight:800;padding-top:8px;">' +
        '<span>' + tt('סה"כ', 'รวม', 'المجموع') + '</span><span>' + money(t.sum) + '</span></div>' +
      (t.unpriced ? '<div style="font-size:.76rem;color:#e65100;">\u26a0\ufe0f ' + t.unpriced + ' ' +
        tt('שורות ללא מחיר', 'ไม่มีราคา', 'بدون سعر') + '</div>' : '') +
    '</div>';

    var bar =
      '<button class="ord-btn" onclick="Orders.printOrder(' + o.id + ')">\ud83d\udda8 ' +
        tt('הדפסה / PDF', 'พิมพ์', 'طباعة') + '</button>' +
      (sup && sup.phone ? '<button class="ord-btn ghost" onclick="Orders.sendWhatsApp(' + o.id + ')">\ud83d\udcac ' +
        tt('שליחה בוואטסאפ', 'ส่ง WhatsApp', 'إرسال واتساب') + '</button>' : '') +
      (sup && sup.email ? '<button class="ord-btn ghost" onclick="Orders.sendEmail(' + o.id + ')">\u2709\ufe0f ' +
        tt('שליחה במייל', 'ส่งอีเมล', 'إرسال بريد') + '</button>' : '') +
      '<button class="ord-btn warn" onclick="Orders._delOrder(' + o.id + ')">\ud83d\uddd1 ' +
        tt('מחיקה', 'ลบ', 'حذف') + '</button>' +
      '<button class="ord-btn ghost" onclick="Orders.render()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell('\ud83d\udce6 ' + esc(o.title), bar, body));
  }

  function _setStatus(id, v) {
    var o = ordById(id);
    if (!o) return;
    var before = JSON.parse(JSON.stringify(o));
    o.status = v;
    if (v === 'sent' && !o.sentAt) o.sentAt = Date.now();
    saveOrd();
    if (window.Audit && Audit.log) Audit.log('edit', 'orders', String(id), { before: before, after: o });
    showOrder(id);
  }

  function _delOrder(id) {
    if (!confirm(tt('למחוק את ההזמנה?', 'ลบใบสั่งซื้อ?', 'حذف الطلب؟'))) return;
    var before = ordById(id);
    O.orders = (O.orders || []).filter(function (o) { return o.id !== id; });
    saveOrd();
    if (window.Audit && Audit.log) Audit.log('delete', 'orders', String(id), { before: before });
    render();
  }

  // ── output ──
  function orderText(o) {
    var lines = [];
    lines.push(tt('הזמנה', 'ใบสั่งซื้อ', 'طلب شراء') + ' ' + o.no + ' \u2014 ' + o.title);
    if (o.neededBy) lines.push(tt('נדרש עד', 'ภายใน', 'بحلول') + ': ' + o.neededBy);
    lines.push('');
    (o.lines || []).forEach(function (l) {
      lines.push('\u2022 ' + l.name + ' \u2014 ' + n2(l.qty) + ' ' + dspUnit(l.unit) + (l.sku ? ' [' + l.sku + ']' : ''));
    });
    lines.push('');
    lines.push('\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 / Roots Plus');
    return lines.join('\n');
  }

  function sendWhatsApp(id) {
    var o = ordById(id);
    if (!o) return;
    var sup = supById(o.supplierId);
    var phone = String((sup && sup.phone) || '').replace(/[^\d]/g, '');
    if (phone.indexOf('0') === 0) phone = '972' + phone.slice(1);
    window.open('https://wa.me/' + phone + '?text=' + encodeURIComponent(orderText(o)), '_blank');
    if (o.status === 'draft') _setStatus(id, 'sent');
  }

  function sendEmail(id) {
    var o = ordById(id);
    if (!o) return;
    var sup = supById(o.supplierId);
    window.location.href = 'mailto:' + encodeURIComponent((sup && sup.email) || '') +
      '?subject=' + encodeURIComponent(o.no + ' \u2014 ' + o.title) +
      '&body=' + encodeURIComponent(orderText(o));
    if (o.status === 'draft') _setStatus(id, 'sent');
  }

  // Print colours are hardcoded on purpose: the report opens in a bare tab
  // with none of the app's theme variables defined, and a dark-theme value
  // would render as black-on-black there.
  function printOrder(id) {
    var o = ordById(id);
    if (!o) return;
    var sup = supById(o.supplierId);
    var t = orderTotal(o);
    var rows = '';
    (o.lines || []).forEach(function (l, i) {
      rows += '<tr><td>' + (i + 1) + '</td><td>' + esc(l.name) + '</td><td>' + esc(l.sku) + '</td>' +
        '<td>' + n2(l.qty) + '</td><td>' + esc(dspUnit(l.unit)) + '</td>' +
        '<td>' + (l.price ? money(l.price) : '\u2014') + '</td>' +
        '<td>' + (l.price ? money(l.qty * l.price) : '\u2014') + '</td></tr>';
    });
    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc(o.no) + '</title><style>' +
      'body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#222;background:#fff;padding:24px;}' +
      'h1{font-size:1.3rem;margin:0 0 4px;}table{width:100%;border-collapse:collapse;margin-top:14px;}' +
      'th,td{border:1px solid #bbb;padding:6px 8px;font-size:.85rem;text-align:right;}' +
      'th{background:#eef3ee;font-weight:800;}tfoot td{font-weight:800;background:#f7f9f7;}' +
      '.meta{font-size:.85rem;color:#555;line-height:1.7;}' +
      '</style></head><body>' +
      '<h1>' + tt('הזמנת רכש', 'ใบสั่งซื้อ', 'طلب شراء') + ' \u2014 ' + esc(o.no) + '</h1>' +
      '<div class="meta">' + esc(o.title) + '<br>' +
        tt('ספק', 'ผู้ขาย', 'المورّد') + ': ' + esc(o.supplierName || '\u2014') +
        (sup && sup.contact ? ' (' + esc(sup.contact) + ')' : '') + '<br>' +
        (o.neededBy ? tt('נדרש עד', 'ภายใน', 'بحلول') + ': ' + esc(o.neededBy) + '<br>' : '') +
        (o.ref ? tt('מקור', 'ที่มา', 'المصدر') + ': ' + esc(o.ref) + '<br>' : '') +
        tt('תאריך', 'วันที่', 'التاريخ') + ': ' + new Date(o.createdAt).toLocaleDateString('he-IL') +
      '</div>' +
      '<table><thead><tr><th>#</th><th>' + tt('פריט', 'รายการ', 'صنف') + '</th><th>' +
        tt('מק"ט', 'รหัส', 'رمز') + '</th><th>' + tt('כמות', 'จำนวน', 'كمية') + '</th><th>' +
        tt('יחידה', 'หน่วย', 'وحدة') + '</th><th>' + tt('מחיר', 'ราคา', 'سعر') + '</th><th>' +
        tt('סה"כ', 'รวม', 'مجموع') + '</th></tr></thead><tbody>' + rows + '</tbody>' +
      '<tfoot><tr><td colspan="6">' + tt('סה"כ לפני מע"מ', 'รวมก่อนภาษี', 'قبل الضريبة') +
        '</td><td>' + money(t.sum) + '</td></tr></tfoot></table>' +
      (t.unpriced ? '<p style="color:#b34700;font-size:.85rem;">\u26a0 ' + t.unpriced + ' ' +
        tt('שורות ללא מחיר בקטלוג — הסכום חלקי', 'บางรายการไม่มีราคา', 'بعض البنود بدون سعر') + '</p>' : '') +
      '<p style="margin-top:26px;font-size:.85rem;">\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD</p>' +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, o.no + '.html');
    }
  }

  // ── suppliers & catalogue ──
  function renderSuppliers() {
    var body = '';
    if (!(S.suppliers || []).length) {
      body = '<div class="ord-empty">' + tt('אין ספקים. הוסיפו ספק כדי לתמחר הזמנות אוטומטית.',
        'ยังไม่มีผู้ขาย', 'لا يوجد موردون') + '</div>';
    }
    (S.suppliers || []).forEach(function (s) {
      var items = '';
      (s.items || []).forEach(function (it, i) {
        items += '<div class="ord-row">' +
          '<input value="' + esc(it.name) + '" placeholder="' + tt('פריט', 'รายการ', 'صنف') +
            '" oninput="Orders._setItem(' + s.id + ',' + i + ',\'name\',this.value)">' +
          '<input value="' + esc(it.sku) + '" placeholder="' + tt('מק"ט', 'รหัส', 'رمز') +
            '" oninput="Orders._setItem(' + s.id + ',' + i + ',\'sku\',this.value)">' +
          '<input value="' + esc(it.unit) + '" placeholder="' + tt('יח\'', 'หน่วย', 'وحدة') +
            '" oninput="Orders._setItem(' + s.id + ',' + i + ',\'unit\',this.value)">' +
          '<input class="ord-hide-sm" type="number" step="any" value="' + (it.price || '') + '" ' +
            'placeholder="' + tt('מחיר', 'ราคา', 'سعر') + '" ' +
            'oninput="Orders._setItem(' + s.id + ',' + i + ',\'price\',this.value)">' +
          '<button class="ord-btn warn" style="padding:6px 8px;" ' +
            'onclick="Orders._delItem(' + s.id + ',' + i + ')">\ud83d\uddd1</button>' +
        '</div>';
      });

      body += '<div class="ord-card">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:8px;">' +
          '<input value="' + esc(s.name) + '" placeholder="' + tt('שם ספק', 'ชื่อผู้ขาย', 'اسم المورّد') +
            '" style="padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
            'font-weight:700;background:var(--surface,#fff);color:var(--text,#222);" ' +
            'oninput="Orders._setSup(' + s.id + ',\'name\',this.value)">' +
          '<input value="' + esc(s.contact) + '" placeholder="' + tt('איש קשר', 'ผู้ติดต่อ', 'جهة الاتصال') +
            '" style="padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
            'background:var(--surface,#fff);color:var(--text,#222);" ' +
            'oninput="Orders._setSup(' + s.id + ',\'contact\',this.value)">' +
          '<input value="' + esc(s.phone) + '" placeholder="' + tt('טלפון', 'โทร', 'هاتف') +
            '" style="padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
            'background:var(--surface,#fff);color:var(--text,#222);" ' +
            'oninput="Orders._setSup(' + s.id + ',\'phone\',this.value)">' +
          '<input value="' + esc(s.email) + '" placeholder="' + tt('אימייל', 'อีเมล', 'بريد') +
            '" style="padding:8px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
            'background:var(--surface,#fff);color:var(--text,#222);" ' +
            'oninput="Orders._setSup(' + s.id + ',\'email\',this.value)">' +
        '</div>' +
        '<div class="ord-lbl" style="margin-bottom:4px;">' +
          tt('קטלוג ומחירים', 'แคตตาล็อก', 'الكتالوج') + ' (' + (s.items || []).length + ')</div>' +
        items +
        '<div style="display:flex;gap:6px;margin-top:6px;">' +
          '<button class="ord-btn ghost" onclick="Orders._addItem(' + s.id + ')">\u2795 ' +
            tt('פריט', 'รายการ', 'صنف') + '</button>' +
          '<button class="ord-btn warn" onclick="Orders._delSup(' + s.id + ')">\ud83d\uddd1 ' +
            tt('מחק ספק', 'ลบผู้ขาย', 'حذف المورّد') + '</button>' +
        '</div>' +
      '</div>';
    });

    var bar =
      '<button class="ord-btn" onclick="Orders._addSup()">\u2795 ' +
        tt('ספק חדש', 'ผู้ขายใหม่', 'مورّد جديد') + '</button>' +
      '<button class="ord-btn ghost" onclick="Orders._saveSupUi()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="ord-btn ghost" onclick="Orders.render()">\u21a9 ' +
        tt('להזמנות', 'ใบสั่งซื้อ', 'الطلبات') + '</button>';

    paint(shell('\ud83c\udfea ' + tt('ספקים וקטלוג', 'ซัพพลายเออร์และแคตตาล็อก', 'الموردون والكتالوج'), bar, body));
  }

  function _addSup() {
    S.suppliers.push({ id: uid(), name: '', contact: '', phone: '', email: '', notes: '', items: [] });
    renderSuppliers();
  }
  function _delSup(id) {
    if (!confirm(tt('למחוק את הספק?', 'ลบผู้ขาย?', 'حذف المورّد؟'))) return;
    S.suppliers = S.suppliers.filter(function (s) { return s.id !== id; });
    saveSup();
    renderSuppliers();
  }
  function _setSup(id, k, v) {
    var s = supById(id);
    if (s) s[k] = v;
  }
  function _addItem(id) {
    var s = supById(id);
    if (!s) return;
    s.items.push({ id: uid(), name: '', sku: '', unit: UNITS[0], price: 0 });
    renderSuppliers();
  }
  function _delItem(id, i) {
    var s = supById(id);
    if (!s) return;
    s.items.splice(i, 1);
    saveSup();
    renderSuppliers();
  }
  function _setItem(id, i, k, v) {
    var s = supById(id);
    if (!s || !s.items[i]) return;
    s.items[i][k] = (k === 'price') ? (Number(v) || 0) : v;
  }
  // Explicit save: the inputs above mutate state without writing, so typing
  // in a price field does not fire a Firestore write per keystroke.
  function _saveSupUi() {
    saveSup();
    toast('\u2705 ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ'));
    renderSuppliers();
  }

  return {
    open: open,
    close: close,
    render: render,
    openSuppliers: openSuppliers,
    renderSuppliers: renderSuppliers,
    newBlank: newBlank,
    draftFrom: draftFrom,
    showOrder: showOrder,
    printOrder: printOrder,
    sendWhatsApp: sendWhatsApp,
    sendEmail: sendEmail,
    suppliersFor: suppliersFor,
    _setHead: _setHead,
    _setLine: _setLine,
    _addLine: _addLine,
    _delLine: _delLine,
    _pickSupplier: _pickSupplier,
    _saveDraft: _saveDraft,
    _setStatus: _setStatus,
    _delOrder: _delOrder,
    _addSup: _addSup,
    _delSup: _delSup,
    _setSup: _setSup,
    _addItem: _addItem,
    _delItem: _delItem,
    _setItem: _setItem,
    _saveSupUi: _saveSupUi
  };
})();
