/* agriplan.js — תוכניות טיפול (forward treatment plans)
 * ------------------------------------------------------------------
 * The planning half of plant protection. pestmonitor.js records what was
 * FOUND; app.js records what was DONE; this module states what WILL be
 * done, computes the material it consumes, and hands the totals to
 * orders.js as a purchase order.
 *
 * THE ROW MODEL comes straight from the planning sheets already in use:
 *
 *   אופן יישום | מטע | חלקה | מס' עצים | חומר 1..3 + ריכוז |
 *   סיבוב טיפול | מועד מומלץ | נפח/סמ"ק לעץ | → ליטר חומר לחלקה
 *
 * Only the left side is entered. Everything right of the arrow is derived,
 * by exactly two formulas:
 *
 *   pct  (ריסוס)          material_L = trees × volumePerTree × pct/100
 *   cc   (הגמעה / הזרקה)  material_L = trees × ccPerTree / 1000
 *
 * Verified against the 2025/2026 sheets:
 *   3252 trees × 15 L × 1.00%  = 487.8 L EOS        ✓
 *   3252 trees × 15 L × 0.10%  =  48.8 L ביומקטין   ✓
 *    130 trees × 30 cc         =   3.9 L קוהינור    ✓
 *  13117 trees × 20 cc         = 262.3 L רוגור      ✓
 *
 * ROUNDING: every total sums the UNROUNDED per-row values and rounds once,
 * at display. Rounding each row to one decimal and then summing is how the
 * printed plan ends up a few shekels away from the spreadsheet it replaced,
 * and once the numbers disagree nobody trusts either of them.
 *
 * COHORTS: the sheets split inside a חלקה — 'תמרים 23' is 4382 productive
 * trees AND 222 לא מניב, on different volumes; 'ייטב' splits by variety.
 * A plot record carries one tree_count, so a plan row targets
 * plotId + cohort + trees, seeded from the plot and overridable. Without
 * that layer the לא מניב trees silently inherit the productive volume.
 *
 * DATA: appData/shorashim-agri-plan-{YYYY} — one document per season, the
 * same shape pestmonitor.js uses, so a new year needs no rules deploy
 * (the rules match on the prefix).
 *
 * Access: operator+ (rules + client). Growers read their own farm's sheet
 * off the printed distribution page, not from this screen.
 */
var AgriPlan = (function () {
  'use strict';

  var KEY_PREFIX = 'shorashim-agri-plan-';

  // אופן יישום. Each method only decides which carrier column is shown and
  // which label prints — the dose maths lives on the material, not here.
  var METHODS = [
    { v: 'spray',  carrier: 'L',  def: 'pct' },
    { v: 'drench', carrier: 'L',  def: 'cc'  },
    { v: 'inject', carrier: 'cc', def: 'cc'  }
  ];
  function methodLabel(v) {
    if (v === 'spray')  return tt('ריסוס', 'พ่นยา', 'رش');
    if (v === 'drench') return tt('הגמעה ידנית עץ-עץ', 'รดโคนต้น', 'سقي فردي');
    if (v === 'inject') return tt('הזרקת גזע', 'ฉีดลำต้น', 'حقن الجذع');
    return v;
  }
  function carrierLabel(v) {
    if (v === 'spray')  return tt('נפח ריסוס לעץ (ליטר)', 'ปริมาตร/ต้น (ลิตร)', 'حجم الرش/شجرة (لتر)');
    if (v === 'drench') return tt('נפח הגמעה לעץ (ליטר)', 'ปริมาตรรด/ต้น (ลิตร)', 'حجم السقي/شجرة (لتر)');
    return tt('תמיסה לעץ (סמ"ק)', 'สารละลาย/ต้น (ซีซี)', 'محلول/شجرة (سم³)');
  }

  var S = null;                  // season document
  var year = String(new Date().getFullYear());
  var _listening = {};
  var _lastSaved = '';
  var _openPlan = null;          // plan id being edited

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
  function key() { return KEY_PREFIX + year; }
  function isManager() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }
  function n1(x) { return Math.round((Number(x) || 0) * 10) / 10; }
  function money(x) {
    return '\u20aa' + (Math.round((Number(x) || 0) * 100) / 100)
      .toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // ── app data bridges ──
  // SprayStore is app.js's read-only window. It already filters plots to
  // what this user may see, so farm/plot access control is inherited rather
  // than reimplemented (and cannot drift out of sync with the map).
  function plots() {
    return (window.SprayStore && SprayStore.getPlots) ? SprayStore.getPlots() : [];
  }
  function farms() {
    return (window.SprayStore && SprayStore.getFarms) ? SprayStore.getFarms() : [];
  }
  function farmName(id) {
    var hit = null;
    farms().forEach(function (f) { if (f.id === id) hit = f.name; });
    return hit || tt('ללא מטע', 'ไม่มีสวน', 'بدون بستان');
  }
  function plotById(id) {
    var hit = null;
    plots().forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }
  // Known pesticide names, for the datalist. Free text still wins — a plan
  // must be writable for a product that has not been catalogued yet.
  function knownMaterials() {
    var out = {};
    ((window.SprayStore && SprayStore.getPesticides) ? SprayStore.getPesticides() : [])
      .forEach(function (p) { if (p.productName) out[p.productName] = true; });
    (S && S.plans || []).forEach(function (pl) {
      (pl.rows || []).forEach(function (r) {
        (r.materials || []).forEach(function (m) { if (m.name) out[m.name] = true; });
      });
    });
    return Object.keys(out).sort();
  }

  // ── persistence ──
  function blankSeason() {
    return { year: year, plans: [] };
  }

  function normMaterial(m) {
    m = m || {};
    var mode = (m.mode === 'cc') ? 'cc' : 'pct';
    return {
      name: String(m.name || ''),
      mode: mode,
      value: Number(m.value) || 0,          // percent when pct, cc/tree when cc
      price: Number(m.price) || 0           // ₪ per litre, for costing
    };
  }

  function normRow(r) {
    r = r || {};
    var method = 'spray';
    METHODS.forEach(function (m) { if (m.v === r.method) method = r.method; });
    return {
      id: r.id || uid(),
      method: method,
      farmId: (r.farmId === null || r.farmId === undefined) ? null : Number(r.farmId),
      plotId: (r.plotId === null || r.plotId === undefined) ? null : Number(r.plotId),
      cohort: String(r.cohort || ''),        // '' = the whole plot
      trees: Number(r.trees) || 0,
      carrier: Number(r.carrier) || 0,       // L/tree, or cc/tree for inject
      round: String(r.round || ''),          // סיבוב טיפול
      timing: String(r.timing || ''),        // מועד מומלץ (free text — 'סיום גדיד')
      note: String(r.note || ''),
      materials: Array.isArray(r.materials) ? r.materials.map(normMaterial) : []
    };
  }

  function normPlan(p) {
    p = p || {};
    return {
      id: p.id || uid(),
      name: String(p.name || ''),
      target: String(p.target || ''),        // the pest
      notes: String(p.notes || ''),
      createdAt: Number(p.createdAt) || Date.now(),
      createdBy: String(p.createdBy || ''),
      rows: Array.isArray(p.rows) ? p.rows.map(normRow) : []
    };
  }

  function normalise(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = blankSeason();
    if (Array.isArray(s.plans)) out.plans = s.plans.map(normPlan);
    return out;
  }

  function load() {
    return DB.loadAsync(key()).then(function (d) { return normalise(d); });
  }

  function listen() {
    if (_listening[year]) return;
    _listening[year] = true;
    DB.listen(key(), function (d) {
      if (JSON.stringify(d) === _lastSaved) return;   // our own write echoing back
      S = normalise(d);
      if (isOpen()) repaint();
    });
  }

  function save() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    // Firestore rejects undefined; round-trip strips it and any accidental
    // function/DOM reference that crept onto a row.
    var clean = JSON.parse(JSON.stringify(S));
    _lastSaved = JSON.stringify(clean);
    DB.save(key(), clean);
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE ENGINE — the whole point of the module
  // ══════════════════════════════════════════════════════════════════

  // Litres of neat material a single row consumes. Unrounded on purpose.
  function rowMaterialL(row, mat) {
    var trees = Number(row.trees) || 0;
    if (mat.mode === 'pct') {
      return trees * (Number(row.carrier) || 0) * (Number(mat.value) || 0) / 100;
    }
    return trees * (Number(mat.value) || 0) / 1000;
  }

  // Carrier (water) the row consumes, in litres. For inject the carrier is
  // already cc of made-up solution, so it converts rather than multiplies.
  function rowCarrierL(row) {
    var trees = Number(row.trees) || 0;
    var c = Number(row.carrier) || 0;
    return (row.method === 'inject') ? (trees * c / 1000) : (trees * c);
  }

  // Totals for a plan: by material, by farm, and by farm×material.
  function totals(plan) {
    var byMat = {}, byFarm = {}, farmMat = {}, price = {};
    var waterL = 0, trees = 0;
    (plan.rows || []).forEach(function (r) {
      trees += Number(r.trees) || 0;
      waterL += rowCarrierL(r);
      var fid = (r.farmId === null || r.farmId === undefined) ? 0 : r.farmId;
      if (!byFarm[fid]) byFarm[fid] = 0;
      if (!farmMat[fid]) farmMat[fid] = {};
      (r.materials || []).forEach(function (m) {
        if (!m.name) return;
        var L = rowMaterialL(r, m);
        byMat[m.name] = (byMat[m.name] || 0) + L;
        farmMat[fid][m.name] = (farmMat[fid][m.name] || 0) + L;
        byFarm[fid] += L;
        // Last non-zero price entered for a material wins — one product has
        // one price across the plan, so a price typed on any row applies.
        if (m.price > 0) price[m.name] = m.price;
      });
    });
    var cost = 0, unpriced = [];
    Object.keys(byMat).forEach(function (nm) {
      if (price[nm]) cost += byMat[nm] * price[nm];
      else unpriced.push(nm);
    });
    return {
      byMat: byMat, byFarm: byFarm, farmMat: farmMat, price: price,
      cost: cost, unpriced: unpriced, waterL: waterL, trees: trees
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI
  // ══════════════════════════════════════════════════════════════════

  function isOpen() { return !!document.getElementById('apRoot'); }
  function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }
  function paint(html) {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = html;
  }
  function repaint() {
    if (_openPlan && planById(_openPlan)) showPlan(_openPlan);
    else renderList();
  }

  function open() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    load().then(function (s) { S = s; listen(); _openPlan = null; renderList(); });
  }

  function css() {
    if (document.getElementById('apCss')) return '';
    return '<style id="apCss">' +
      '.ap-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;overflow:auto;padding:14px;}' +
      '.ap-sheet{max-width:1100px;margin:0 auto;background:var(--surface,#fff);color:var(--text,#222);' +
        'border-radius:16px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);}' +
      '.ap-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;' +
        'padding-bottom:10px;border-bottom:2px solid var(--border,#e0e0e0);flex-wrap:wrap;}' +
      '.ap-head h3{margin:0;font-weight:800;font-size:1.05rem;}' +
      '.ap-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.ap-btn{padding:9px 13px;border:none;border-radius:10px;background:var(--primary,#2d6a4f);color:#fff;' +
        'font-family:inherit;font-weight:700;font-size:.84rem;cursor:pointer;}' +
      '.ap-btn.ghost{background:var(--surface-glass,#eef1ee);color:var(--text,#333);}' +
      '.ap-btn.warn{background:#c62828;}' +
      '.ap-card{background:var(--surface-glass,#f5f7f5);border-radius:12px;padding:12px;margin-bottom:10px;}' +
      '.ap-in{padding:7px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
        'font-size:.82rem;background:var(--surface,#fff);color:var(--text,#222);width:100%;}' +
      '.ap-lbl{font-size:.7rem;color:var(--text-muted,#888);font-weight:700;margin-bottom:2px;}' +
      '.ap-rowgrid{display:grid;grid-template-columns:1.4fr 1fr .8fr .8fr .9fr 1fr 34px;gap:5px;align-items:end;}' +
      '.ap-mat{display:grid;grid-template-columns:1.4fr .7fr .8fr .8fr 30px;gap:5px;margin-top:4px;align-items:center;}' +
      '.ap-out{background:var(--surface,#fff);border-radius:8px;padding:6px 9px;margin-top:6px;font-size:.78rem;' +
        'font-weight:700;color:var(--primary,#2d6a4f);}' +
      '.ap-tot{display:flex;justify-content:space-between;padding:4px 0;font-size:.86rem;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.ap-empty{text-align:center;color:var(--text-muted,#999);padding:18px;font-size:.86rem;}' +
      '@media(max-width:760px){.ap-rowgrid{grid-template-columns:1fr 1fr;}.ap-mat{grid-template-columns:1fr .6fr .7fr 30px;}}' +
      '</style>';
  }

  function shell(title, bar, body) {
    return css() + '<div class="ap-back" id="apRoot"><div class="ap-sheet">' +
      '<div class="ap-head"><div><h3>' + title + '</h3></div>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.close()">\u2715 ' +
        tt('סגור', 'ปิด', 'إغلاق') + '</button></div>' +
      '<div class="ap-bar">' + bar + '</div>' + body + '</div></div>';
  }

  // ── plan list ──
  function renderList() {
    _openPlan = null;
    var yrs = '';
    var now = new Date().getFullYear();
    for (var y = now + 1; y >= now - 3; y--) {
      yrs += '<option value="' + y + '"' + (String(y) === year ? ' selected' : '') + '>' + y + '</option>';
    }
    var bar =
      '<button class="ap-btn" onclick="AgriPlan.newPlan()">\u2795 ' +
        tt('תוכנית חדשה', 'แผนใหม่', 'خطة جديدة') + '</button>' +
      '<select class="ap-in" style="width:auto;" onchange="AgriPlan.setYear(this.value)">' + yrs + '</select>' +
      '<button class="ap-btn ghost" onclick="Orders.open()">\ud83d\udce6 ' +
        tt('הזמנות', 'ใบสั่งซื้อ', 'الطلبات') + '</button>';

    var body = '';
    if (!(S.plans || []).length) {
      body = '<div class="ap-empty">' +
        tt('אין תוכניות לעונה זו. תוכנית מחשבת כמויות חומר לפי מספר עצים, נפח לעץ וריכוז — ומייצרת הזמנה.',
           'ยังไม่มีแผนสำหรับฤดูกาลนี้', 'لا توجد خطط لهذا الموسم') + '</div>';
    }
    (S.plans || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .forEach(function (p) {
        var t = totals(p);
        var mats = Object.keys(t.byMat).map(function (nm) {
          return esc(nm) + ' ' + n1(t.byMat[nm]) + 'L';
        }).join(' \u00b7 ');
        body += '<div class="ap-card" style="cursor:pointer;" onclick="AgriPlan.showPlan(' + p.id + ')">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<strong>' + esc(p.name || tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) + '</strong>' +
            '<span style="font-size:.78rem;color:var(--text-muted,#888);">' +
              (p.target ? '\ud83d\udc1b ' + esc(p.target) : '') + '</span></div>' +
          '<div style="font-size:.78rem;color:var(--text-muted,#888);margin-top:4px;">' +
            (p.rows || []).length + ' ' + tt('שורות', 'แถว', 'صفوف') +
            ' \u00b7 ' + t.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') +
            (t.cost ? ' \u00b7 ' + money(t.cost) : '') + '</div>' +
          (mats ? '<div style="font-size:.76rem;margin-top:4px;">' + mats + '</div>' : '') +
        '</div>';
      });

    paint(shell('\ud83c\udf3f ' + tt('תוכניות טיפול', 'แผนการดูแล', 'خطط المعالجة') + ' ' + year, bar, body));
  }

  function setYear(y) {
    year = String(y);
    load().then(function (s) { S = s; listen(); renderList(); });
  }

  function planById(id) {
    var hit = null;
    (S.plans || []).forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }

  function newPlan() {
    var u = window.currentUser || {};
    var p = normPlan({ id: uid(), name: '', target: '', createdAt: Date.now(), createdBy: u.username || '' });
    S.plans.push(p);
    save();
    showPlan(p.id);
  }

  function delPlan(id) {
    if (!confirm(tt('למחוק את התוכנית?', 'ลบแผน?', 'حذف الخطة؟'))) return;
    var before = planById(id);
    S.plans = (S.plans || []).filter(function (p) { return p.id !== id; });
    save();
    if (window.Audit && Audit.log) Audit.log('delete', 'agriplan', String(id), { before: before });
    renderList();
  }

  // ── plan editor ──
  function showPlan(id) {
    var p = planById(id);
    if (!p) { renderList(); return; }
    _openPlan = id;
    var t = totals(p);

    var matList = knownMaterials().map(function (m) {
      return '<option value="' + esc(m) + '">';
    }).join('');

    var rows = '';
    (p.rows || []).forEach(function (r, i) { rows += rowHtml(p, r, i); });

    var totHtml = '';
    Object.keys(t.byMat).sort().forEach(function (nm) {
      totHtml += '<div class="ap-tot"><span>' + esc(nm) + '</span><strong>' +
        n1(t.byMat[nm]) + ' ' + tt('ליטר', 'ลิตร', 'لتر') +
        (t.price[nm] ? ' \u00b7 ' + money(t.byMat[nm] * t.price[nm]) : '') + '</strong></div>';
    });

    var farmHtml = '';
    Object.keys(t.farmMat).forEach(function (fid) {
      var mm = t.farmMat[fid];
      var line = Object.keys(mm).sort().map(function (nm) {
        return esc(nm) + ' ' + n1(mm[nm]) + 'L';
      }).join(' \u00b7 ');
      if (!line) return;
      farmHtml += '<div class="ap-tot"><span>\ud83c\udf33 ' + esc(farmName(Number(fid))) +
        '</span><span style="font-size:.8rem;">' + line + '</span></div>';
    });

    var body =
      '<div class="ap-card">' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
          '<div><div class="ap-lbl">' + tt('שם התוכנית', 'ชื่อแผน', 'اسم الخطة') + '</div>' +
            '<input class="ap-in" value="' + esc(p.name) + '" ' +
            'oninput="AgriPlan._setPlan(' + id + ',\'name\',this.value)"></div>' +
          '<div><div class="ap-lbl">' + tt('מזיק / מטרה', 'ศัตรูพืช', 'الآفة') + '</div>' +
            '<input class="ap-in" value="' + esc(p.target) + '" ' +
            'oninput="AgriPlan._setPlan(' + id + ',\'target\',this.value)"></div>' +
        '</div>' +
        '<div class="ap-lbl" style="margin-top:8px;">' + tt('הערות', 'หมายเหตุ', 'ملاحظات') + '</div>' +
        '<textarea class="ap-in" rows="2" ' +
          'oninput="AgriPlan._setPlan(' + id + ',\'notes\',this.value)">' + esc(p.notes) + '</textarea>' +
      '</div>' +

      '<datalist id="apMats">' + matList + '</datalist>' +
      rows +

      '<div class="ap-card">' +
        '<div style="font-weight:800;margin-bottom:6px;">\u03a3 ' +
          tt('סה"כ חומרים לתוכנית', 'รวมสารทั้งหมด', 'إجمالي المواد') + '</div>' +
        (totHtml || '<div class="ap-empty">' + tt('אין חומרים', 'ไม่มีสาร', 'لا مواد') + '</div>') +
        '<div class="ap-tot" style="border:none;margin-top:6px;"><span>' +
          tt('מים / תמיסה', 'น้ำ', 'ماء') + '</span><strong>' + n1(t.waterL).toLocaleString() + ' ' +
          tt('ליטר', 'ลิตร', 'لتر') + '</strong></div>' +
        '<div class="ap-tot" style="border:none;font-weight:800;font-size:1rem;"><span>' +
          tt('עלות משוערת', 'ต้นทุนโดยประมาณ', 'التكلفة التقديرية') + '</span><span>' +
          money(t.cost) + '</span></div>' +
        (t.unpriced.length ? '<div style="font-size:.75rem;color:#e65100;">\u26a0\ufe0f ' +
          tt('ללא מחיר', 'ไม่มีราคา', 'بدون سعر') + ': ' + esc(t.unpriced.join(', ')) + '</div>' : '') +
      '</div>' +

      (farmHtml ? '<div class="ap-card"><div style="font-weight:800;margin-bottom:6px;">\ud83c\udf33 ' +
        tt('פילוח לפי מטע', 'แยกตามสวน', 'حسب البستان') + '</div>' + farmHtml + '</div>' : '');

    var bar =
      '<button class="ap-btn" onclick="AgriPlan.addRow(' + id + ')">\u2795 ' +
        tt('שורה', 'แถว', 'صف') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.seedFromFarm(' + id + ')">\ud83c\udf33 ' +
        tt('הוסף מטע שלם', 'เพิ่มทั้งสวน', 'إضافة بستان') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.save()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.printPlan(' + id + ')">\ud83d\udda8 ' +
        tt('הדפסת התוכנית', 'พิมพ์แผน', 'طباعة الخطة') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.toOrder(' + id + ')">\ud83d\udce6 ' +
        tt('צור הזמנה', 'สร้างใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      '<button class="ap-btn warn" onclick="AgriPlan.delPlan(' + id + ')">\ud83d\uddd1</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.renderList()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell('\ud83c\udf3f ' + esc(p.name || tt('תוכנית', 'แผน', 'خطة')), bar, body));
  }

  function rowHtml(p, r, i) {
    var pid = p.id;
    var mSel = '';
    METHODS.forEach(function (m) {
      mSel += '<option value="' + m.v + '"' + (r.method === m.v ? ' selected' : '') + '>' +
        methodLabel(m.v) + '</option>';
    });

    var fSel = '<option value="">' + tt('— מטע —', '— สวน —', '— بستان —') + '</option>';
    farms().forEach(function (f) {
      fSel += '<option value="' + f.id + '"' + (r.farmId === f.id ? ' selected' : '') + '>' +
        esc(f.name) + '</option>';
    });

    var pSel = '<option value="">' + tt('— חלקה —', '— แปลง —', '— قطعة —') + '</option>';
    plots().filter(function (pl) { return !r.farmId || pl.farm_id === r.farmId; })
      .forEach(function (pl) {
        pSel += '<option value="' + pl.id + '"' + (r.plotId === pl.id ? ' selected' : '') + '>' +
          esc(pl.name) + '</option>';
      });

    var mats = '';
    (r.materials || []).forEach(function (m, mi) {
      var L = rowMaterialL(r, m);
      mats += '<div class="ap-mat">' +
        '<input class="ap-in" list="apMats" value="' + esc(m.name) + '" placeholder="' +
          tt('חומר', 'สาร', 'مادة') + '" ' +
          'oninput="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'name\',this.value)">' +
        '<select class="ap-in" onchange="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'mode\',this.value)">' +
          '<option value="pct"' + (m.mode === 'pct' ? ' selected' : '') + '>%</option>' +
          '<option value="cc"' + (m.mode === 'cc' ? ' selected' : '') + '>' +
            tt('סמ"ק/עץ', 'ซีซี/ต้น', 'سم³') + '</option></select>' +
        '<input class="ap-in" type="number" step="any" value="' + (m.value || '') + '" ' +
          'oninput="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'value\',this.value)">' +
        '<input class="ap-in" type="number" step="any" value="' + (m.price || '') + '" placeholder="\u20aa/L" ' +
          'oninput="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'price\',this.value)">' +
        '<button class="ap-btn warn" style="padding:5px 7px;" ' +
          'onclick="AgriPlan._delMat(' + pid + ',' + i + ',' + mi + ')">\u2715</button>' +
        '<div style="grid-column:1/-1;font-size:.74rem;color:var(--primary,#2d6a4f);font-weight:700;">' +
          '\u2192 ' + n1(L) + ' ' + tt('ליטר לחלקה', 'ลิตร/แปลง', 'لتر/قطعة') + '</div>' +
      '</div>';
    });

    return '<div class="ap-card">' +
      '<div class="ap-rowgrid">' +
        '<div><div class="ap-lbl">' + tt('אופן יישום', 'วิธีการ', 'طريقة') + '</div>' +
          '<select class="ap-in" onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'method\',this.value)">' +
          mSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('מטע', 'สวน', 'بستان') + '</div>' +
          '<select class="ap-in" onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'farmId\',this.value)">' +
          fSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('חלקה', 'แปลง', 'قطعة') + '</div>' +
          '<select class="ap-in" onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'plotId\',this.value)">' +
          pSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('תת-קבוצה', 'กลุ่มย่อย', 'مجموعة') + '</div>' +
          '<input class="ap-in" value="' + esc(r.cohort) + '" placeholder="' +
            tt('לא מניב / זן', 'ไม่ให้ผล', 'غير مثمر') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'cohort\',this.value)"></div>' +
        '<div><div class="ap-lbl">' + tt('מס\' עצים', 'จำนวนต้น', 'عدد الأشجار') + '</div>' +
          '<input class="ap-in" type="number" value="' + (r.trees || '') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'trees\',this.value)"></div>' +
        '<div><div class="ap-lbl">' + carrierLabel(r.method) + '</div>' +
          '<input class="ap-in" type="number" step="any" value="' + (r.carrier || '') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'carrier\',this.value)"></div>' +
        '<div><button class="ap-btn warn" style="padding:7px 9px;" ' +
          'onclick="AgriPlan._delRow(' + pid + ',' + i + ')">\ud83d\uddd1</button></div>' +
      '</div>' +

      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:6px;">' +
        '<div><div class="ap-lbl">' + tt('סיבוב טיפול', 'รอบ', 'الجولة') + '</div>' +
          '<input class="ap-in" value="' + esc(r.round) + '" placeholder="' +
            tt('ראשון / שני', 'รอบแรก', 'الأولى') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'round\',this.value)"></div>' +
        '<div><div class="ap-lbl">' + tt('מועד מומלץ', 'ช่วงเวลา', 'الموعد') + '</div>' +
          '<input class="ap-in" value="' + esc(r.timing) + '" placeholder="' +
            tt('סיום גדיד', 'หลังเก็บเกี่ยว', 'بعد الحصاد') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'timing\',this.value)"></div>' +
      '</div>' +

      mats +
      '<button class="ap-btn ghost" style="margin-top:6px;padding:6px 10px;font-size:.78rem;" ' +
        'onclick="AgriPlan._addMat(' + pid + ',' + i + ')">\u2795 ' +
        tt('חומר', 'สาร', 'مادة') + '</button>' +
      '<div class="ap-out">\ud83d\udca7 ' + tt('נפח כולל', 'ปริมาตรรวม', 'الحجم الكلي') + ': ' +
        n1(rowCarrierL(r)).toLocaleString() + ' ' + tt('ליטר', 'ลิตร', 'لتر') + '</div>' +
    '</div>';
  }

  // ── row/material mutation ──
  function _setPlan(pid, k, v) {
    var p = planById(pid);
    if (p) p[k] = v;
  }
  function _setRow(pid, i, k, v) {
    var p = planById(pid);
    if (!p || !p.rows[i]) return;
    var r = p.rows[i];
    if (k === 'trees') r.trees = Number(v) || 0;
    else if (k === 'carrier') r.carrier = Number(v) || 0;
    else if (k === 'farmId') {
      r.farmId = v === '' ? null : Number(v);
      r.plotId = null;                       // the plot list is farm-scoped
      showPlan(pid);
      return;
    } else if (k === 'plotId') {
      r.plotId = v === '' ? null : Number(v);
      // Seed tree count and farm from the plot — retyping a number that the
      // map already knows is how a plan drifts away from the orchard.
      var pl = plotById(r.plotId);
      if (pl) {
        if (!r.trees) r.trees = Number(pl.tree_count) || 0;
        if (r.farmId === null) r.farmId = pl.farm_id || null;
      }
      showPlan(pid);
      return;
    } else if (k === 'method') {
      r.method = v;
      showPlan(pid);
      return;
    } else r[k] = v;
  }
  function _delRow(pid, i) {
    var p = planById(pid);
    if (!p) return;
    p.rows.splice(i, 1);
    save();
    showPlan(pid);
  }
  function addRow(pid) {
    var p = planById(pid);
    if (!p) return;
    // A new row inherits the previous row's method, round and timing: a plan
    // is normally one operation repeated across plots, not N unrelated ones.
    var prev = p.rows[p.rows.length - 1];
    p.rows.push(normRow(prev ? {
      method: prev.method, round: prev.round, timing: prev.timing, carrier: prev.carrier,
      farmId: prev.farmId,
      materials: (prev.materials || []).map(function (m) {
        return { name: m.name, mode: m.mode, value: m.value, price: m.price };
      })
    } : {}));
    save();
    showPlan(pid);
  }
  // Fan a whole farm out into one row per plot, tree counts seeded from the
  // map. This is the realistic entry path — the sheets cover every plot in
  // a מטע, and typing thirty rows by hand invites transcription errors.
  function seedFromFarm(pid) {
    var p = planById(pid);
    if (!p) return;
    var fs = farms();
    if (!fs.length) { toast('\u26a0\ufe0f ' + tt('אין מטעים', 'ไม่มีสวน', 'لا بساتين')); return; }
    var names = fs.map(function (f, i) { return (i + 1) + '. ' + f.name; }).join('\n');
    var pick = prompt(tt('מספר המטע להוספה:', 'เลือกสวน:', 'اختر البستان:') + '\n' + names);
    var idx = parseInt(pick, 10);
    if (!idx || idx < 1 || idx > fs.length) return;
    var farm = fs[idx - 1];
    var prev = p.rows[p.rows.length - 1];
    var added = 0;
    plots().filter(function (pl) { return pl.farm_id === farm.id; }).forEach(function (pl) {
      p.rows.push(normRow({
        method: prev ? prev.method : 'spray',
        farmId: farm.id, plotId: pl.id,
        trees: Number(pl.tree_count) || 0,
        carrier: prev ? prev.carrier : 0,
        round: prev ? prev.round : '', timing: prev ? prev.timing : '',
        materials: prev ? (prev.materials || []).map(function (m) {
          return { name: m.name, mode: m.mode, value: m.value, price: m.price };
        }) : []
      }));
      added++;
    });
    save();
    toast('\u2705 ' + added + ' ' + tt('חלקות נוספו', 'แปลงถูกเพิ่ม', 'قطع أُضيفت'));
    showPlan(pid);
  }
  function _addMat(pid, i) {
    var p = planById(pid);
    if (!p || !p.rows[i]) return;
    var r = p.rows[i];
    var def = 'pct';
    METHODS.forEach(function (m) { if (m.v === r.method) def = m.def; });
    r.materials.push(normMaterial({ mode: def }));
    showPlan(pid);
  }
  function _delMat(pid, i, mi) {
    var p = planById(pid);
    if (!p || !p.rows[i]) return;
    p.rows[i].materials.splice(mi, 1);
    save();
    showPlan(pid);
  }
  function _setMat(pid, i, mi, k, v) {
    var p = planById(pid);
    if (!p || !p.rows[i] || !p.rows[i].materials[mi]) return;
    var m = p.rows[i].materials[mi];
    if (k === 'value' || k === 'price') m[k] = Number(v) || 0;
    else if (k === 'mode') { m.mode = v; showPlan(pid); return; }
    else m[k] = v;
    // A price entered on one row applies to that material everywhere in the
    // plan, so the totals do not depend on which row happened to get it.
    if (k === 'price' && m.name) {
      p.rows.forEach(function (rr) {
        (rr.materials || []).forEach(function (mm) {
          if (mm.name === m.name) mm.price = m.price;
        });
      });
    }
  }

  // ── outputs ──
  // Print colours are hardcoded: the sheet opens in a bare tab with none of
  // the app's CSS variables defined, so theme values would render invisible.
  function printPlan(id) {
    var p = planById(id);
    if (!p) return;
    var t = totals(p);

    var rows = '';
    (p.rows || []).forEach(function (r) {
      var pl = plotById(r.plotId);
      var m = r.materials || [];
      var cells = '';
      for (var k = 0; k < 3; k++) {
        cells += '<td>' + (m[k] ? esc(m[k].name) : '') + '</td><td>' +
          (m[k] ? (m[k].mode === 'pct' ? m[k].value + '%' : m[k].value + ' cc') : '') + '</td>';
      }
      var outs = m.map(function (mm) { return n1(rowMaterialL(r, mm)); }).join(' / ');
      rows += '<tr><td>' + esc(methodLabel(r.method)) + '</td>' +
        '<td>' + esc(farmName(r.farmId)) + '</td>' +
        '<td>' + esc((pl ? pl.name : '') + (r.cohort ? ' \u2014 ' + r.cohort : '')) + '</td>' +
        '<td>' + (r.trees || 0).toLocaleString() + '</td>' + cells +
        '<td>' + esc(r.round) + '</td><td>' + esc(r.timing) + '</td>' +
        '<td>' + n1(r.carrier) + '</td><td><b>' + outs + '</b></td></tr>';
    });

    var totRows = '';
    Object.keys(t.byMat).sort().forEach(function (nm) {
      totRows += '<tr><td>' + esc(nm) + '</td><td>' + n1(t.byMat[nm]) + '</td>' +
        '<td>' + (t.price[nm] ? money(t.price[nm]) : '\u2014') + '</td>' +
        '<td>' + (t.price[nm] ? money(t.byMat[nm] * t.price[nm]) : '\u2014') + '</td></tr>';
    });

    var farmRows = '';
    Object.keys(t.farmMat).forEach(function (fid) {
      var mm = t.farmMat[fid];
      Object.keys(mm).sort().forEach(function (nm) {
        farmRows += '<tr><td>' + esc(farmName(Number(fid))) + '</td><td>' + esc(nm) +
          '</td><td>' + n1(mm[nm]) + '</td></tr>';
      });
    });

    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc(p.name) + '</title><style>' +
      '@page{size:A4 landscape;margin:10mm;}' +
      'body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#222;background:#fff;padding:14px;}' +
      'h1{font-size:1.25rem;margin:0 0 2px;}h2{font-size:1rem;margin:18px 0 6px;}' +
      '.meta{font-size:.82rem;color:#555;line-height:1.6;margin-bottom:10px;}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:12px;}' +
      'th,td{border:1px solid #bbb;padding:4px 6px;font-size:.72rem;text-align:right;}' +
      'th{background:#eef3ee;font-weight:800;}' +
      'tfoot td{font-weight:800;background:#f7f9f7;}' +
      '</style></head><body>' +
      '<h1>' + tt('תוכנית טיפול', 'แผนการดูแล', 'خطة معالجة') + ' \u2014 ' + esc(p.name) + '</h1>' +
      '<div class="meta">' +
        (p.target ? tt('מזיק', 'ศัตรูพืช', 'الآفة') + ': ' + esc(p.target) + ' \u00b7 ' : '') +
        tt('עונה', 'ฤดูกาล', 'الموسم') + ': ' + esc(year) + ' \u00b7 ' +
        t.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + ' \u00b7 ' +
        n1(t.waterL).toLocaleString() + ' ' + tt('ליטר תמיסה', 'ลิตรสารละลาย', 'لتر محلول') +
        (p.notes ? '<br>' + esc(p.notes) : '') + '</div>' +

      '<table><thead><tr>' +
        '<th>' + tt('אופן יישום', 'วิธี', 'طريقة') + '</th><th>' + tt('מטע', 'สวน', 'بستان') + '</th>' +
        '<th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th><th>' + tt('מס\' עצים', 'ต้น', 'أشجار') + '</th>' +
        '<th>' + tt('חומר 1', 'สาร 1', 'مادة 1') + '</th><th>' + tt('ריכוז 1', 'เข้มข้น 1', 'تركيز 1') + '</th>' +
        '<th>' + tt('חומר 2', 'สาร 2', 'مادة 2') + '</th><th>' + tt('ריכוז 2', 'เข้มข้น 2', 'تركيز 2') + '</th>' +
        '<th>' + tt('חומר 3', 'สาร 3', 'مادة 3') + '</th><th>' + tt('ריכוז 3', 'เข้มข้น 3', 'تركيز 3') + '</th>' +
        '<th>' + tt('סיבוב', 'รอบ', 'جولة') + '</th><th>' + tt('מועד מומלץ', 'ช่วงเวลา', 'الموعد') + '</th>' +
        '<th>' + tt('לעץ', 'ต่อต้น', 'لكل شجرة') + '</th>' +
        '<th>' + tt('ליטר לחלקה', 'ลิตร/แปลง', 'لتر/قطعة') + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +

      '<h2>' + tt('סה"כ חומרים', 'รวมสาร', 'إجمالي المواد') + '</h2>' +
      '<table><thead><tr><th>' + tt('חומר', 'สาร', 'مادة') + '</th><th>' +
        tt('ליטר', 'ลิตร', 'لتر') + '</th><th>' + tt('מחיר לליטר', 'ราคา/ลิตร', 'سعر/لتر') + '</th><th>' +
        tt('עלות', 'ต้นทุน', 'التكلفة') + '</th></tr></thead><tbody>' + totRows + '</tbody>' +
        '<tfoot><tr><td colspan="3">' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td>' +
          money(t.cost) + '</td></tr></tfoot></table>' +

      (farmRows ? '<h2>' + tt('פילוח לפי מטע', 'แยกตามสวน', 'حسب البستان') + '</h2>' +
        '<table><thead><tr><th>' + tt('מטע', 'สวน', 'بستان') + '</th><th>' +
        tt('חומר', 'สาร', 'مادة') + '</th><th>' + tt('ליטר', 'ลิตร', 'لتر') +
        '</th></tr></thead><tbody>' + farmRows + '</tbody></table>' : '') +

      '<p style="margin-top:18px;font-size:.8rem;">\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD</p>' +
      '</body></html>';

    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, (p.name || 'plan').replace(/\s+/g, '_') + '_' + year + '.html');
    }
  }

  // Hand the material totals to orders.js. The plan itself is the ref, so
  // an order can always be traced back to the plan that justified it.
  function toOrder(id) {
    var p = planById(id);
    if (!p) return;
    var t = totals(p);
    var lines = Object.keys(t.byMat).sort().map(function (nm) {
      return { name: nm, qty: t.byMat[nm], unit: tt('ליטר', 'ลิตร', 'لتر'), note: '' };
    });
    if (!lines.length) {
      toast('\u26a0\ufe0f ' + tt('אין חומרים בתוכנית', 'ไม่มีสารในแผน', 'لا مواد في الخطة'));
      return;
    }
    if (typeof Orders === 'undefined') {
      toast('\u26a0\ufe0f ' + tt('מודול ההזמנות לא נטען', 'โมดูลใบสั่งซื้อไม่พร้อม', 'وحدة الطلبات غير محمّلة'));
      return;
    }
    save();
    Orders.draftFrom({
      title: (p.name || tt('תוכנית טיפול', 'แผน', 'خطة')) + ' \u2014 ' + year,
      source: 'agriplan',
      ref: tt('תוכנית', 'แผน', 'خطة') + ' #' + p.id + ' / ' + year,
      lines: lines
    });
  }

  return {
    open: open,
    close: close,
    renderList: renderList,
    setYear: setYear,
    newPlan: newPlan,
    delPlan: delPlan,
    showPlan: showPlan,
    addRow: addRow,
    seedFromFarm: seedFromFarm,
    printPlan: printPlan,
    toOrder: toOrder,
    save: save,
    totals: totals,
    _setPlan: _setPlan,
    _setRow: _setRow,
    _delRow: _delRow,
    _addMat: _addMat,
    _delMat: _delMat,
    _setMat: _setMat
  };
})();
