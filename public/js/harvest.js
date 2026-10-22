/* harvest.js — תוצאות מיון / קטיף
 * -------------------------------------------------------------------
 * Per-orchard sorting / harvest result reports, one Firestore document per
 * season (shorashim-harvest-2026, ...). Each report picks a FORMAT — the
 * shape of the packing house's statement — plus the packing house and the
 * marketer, chosen from names already used or typed new.
 *
 * Formats:
 *   dates-sorting  the packing-house "summary of sorting results" for dates:
 *                  fruit intake and losses, then the split into fractions
 *                  (export grades, local market, industry) with weight, %
 *                  of finished product, and an optional price column.
 *   general        any crop: free fraction rows with quantity and price.
 * More formats are added by appending to FORMATS.
 *
 * Saving never trusts the screen's copy of the season: it re-reads the
 * document from the server and merges the one report being saved. A read
 * that fails is not treated as an empty season (DB.read distinguishes the
 * two) — that confusion once wiped every construction project.
 */
var HarvestResults = (function () {
  'use strict';

  var KEY_PREFIX = 'shorashim-harvest-';

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
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
  function kg(n) { return Math.round(num(n)).toLocaleString('he-IL'); }
  function pct(n) { return (Math.round(n * 100) / 100).toFixed(2) + ' %'; }
  function money(n) { return '₪' + (Math.round(num(n) * 100) / 100).toLocaleString('he-IL', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function uid() { return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // Dates are harvested Aug–Dec and statements arrive into the next year:
  // until June the "current" season is last year's.
  function defaultSeason() { var d = new Date(); return d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1; }

  var TYPES = [
    { v: 'export',   he: 'יצוא',      th: 'ส่งออก',     ar: 'تصدير' },
    { v: 'local',    he: 'שוק מקומי', th: 'ตลาดในประเทศ', ar: 'سوق محلي' },
    { v: 'industry', he: 'תעשייה',    th: 'อุตสาหกรรม',  ar: 'صناعة' }
  ];
  function typeLabel(v) { var t = TYPES.find(function (x) { return x.v === v; }) || TYPES[0]; return tt(t.he, t.th, t.ar); }

  var FORMATS = {
    'dates-sorting': {
      label: function () { return tt('תמרים — סיכום תוצאות מיון (בית אריזה)', 'อินทผลัม — สรุปผลคัดแยก', 'تمور — ملخص نتائج الفرز'); },
      // Intake block as packing houses print it. 'calc' rows are derived.
      intake: [
        { k: 'entry',   he: 'סה"כ משקל כניסה לבית אריזה' },
        { k: 'wet',     he: 'משקל לח' },
        { k: 'dry',     he: 'משקל לאחר יבוש' },
        { k: 'dryLoss', he: 'סה"כ פחת ייבוש', calc: 'dryLoss' },
        { k: 'mgadid',  he: 'סה"כ ג\' מגדיד' },
        { k: 'primary', he: 'סה"כ ג\' ממיון ראשוני' },
        { k: 'bonbon',  he: 'סה"כ ג\' ממיון בונבון' },
        { k: 'loss',    he: 'פחת כללי', pctOf: 'entry' }
      ],
      // Fraction rows a dates packing house reports; {v} = the variety.
      fractions: [
        ['export', 'SJ', 'תמר {v} סופר גמבו פרימיום'],
        ['export', 'J', 'תמר {v} גמבו פרימיום'],
        ['export', 'L', 'תמר {v} לארג פרימיום'],
        ['export', 'M', 'תמר {v} מדיום פרימיום'],
        ['export', 'S', 'תמר {v} סמול פרימיום'],
        ['export', 'J SUP', 'תמר {v} גמבו סופריור'],
        ['export', 'L SUP', 'תמר {v} לארג סופריור'],
        ['export', 'M SUP', 'תמר {v} מדיום סופריור'],
        ['export', 'SELECTED', 'תמר {v} SELECTED'],
        ['export', 'SJ SUP', ''],
        ['export', 'Selected J', ''],
        ['local', 'LOCAL 2', 'תמר {v} גדול שוק מקומי'],
        ['local', 'LOCAL 1', 'תמר {v} קטן שוק מקומי'],
        ['industry', 'סוג ג - תעשייה', 'סוג ג - תעשייה']
      ]
    },
    'general': {
      label: function () { return tt('כללי — כמויות ומחירים לכל גידול', 'ทั่วไป — ปริมาณและราคา', 'عام — كميات وأسعار'); },
      intake: [
        { k: 'entry', he: 'סה"כ משקל שנקטף' },
        { k: 'loss',  he: 'פחת', pctOf: 'entry' }
      ],
      fractions: [
        ['export', '', ''],
        ['local', '', ''],
        ['industry', '', '']
      ]
    }
  };

  // ── state ──
  var S = { year: defaultSeason(), reports: [] };   // current season doc
  var seen = {};          // year -> true once this device read it OK (or holds a copy)
  var season = defaultSeason();
  var farmFilter = '';
  var draft = null;       // report being edited
  var listening = {};

  function key(y) { return KEY_PREFIX + y; }
  function store() { return window.SprayStore || {}; }
  function farms() { return store().getFarms ? store().getFarms() : []; }
  function farmIds() { return farms().map(function (f) { return f.id; }); }
  function farmName(id) { var f = farms().find(function (x) { return x.id === id; }); return f ? f.name : '—'; }
  function canEdit() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator'; }
  function me() { var u = window.currentUser || {}; return u.name || u.username || ''; }

  function blank(y) { return { year: y, reports: [] }; }
  function normDoc(d, y) {
    d = (d && typeof d === 'object') ? d : blank(y);
    if (!Array.isArray(d.reports)) d.reports = [];
    d.year = y;
    return d;
  }

  function load(y) {
    season = y;
    S = blank(y);
    paint();
    if (typeof DB === 'undefined') return;
    DB.read(key(y)).then(function (res) {
      if (season !== y) return;
      if (res.ok || res.data) seen[y] = true;
      S = normDoc(res.ok ? res.data : res.data, y);
      if (!res.ok) toast('⚠️ ' + tt('אין חיבור לשרת — מוצגים נתונים שמורים במכשיר', 'ไม่มีการเชื่อมต่อ', 'لا اتصال بالخادم'));
      paint();
    });
    if (!listening[y] && DB.listen) {
      listening[y] = true;
      DB.listen(key(y), function (d) {
        seen[y] = true;
        if (season === y) { S = normDoc(d, y); if (!draft) paint(); }
      });
    }
  }

  // Re-read, merge one change, write. op: { upsert: report } | { remove: id }
  function commit(y, op) {
    return DB.read(key(y)).then(function (res) {
      var base;
      if (res.ok) base = normDoc(res.exists ? res.data : null, y);
      else if (seen[y] || res.data) base = normDoc(res.data || S, y);
      else {
        toast('❌ ' + tt('אין חיבור לשרת — לא נשמר. נסה שוב.', 'ไม่มีการเชื่อมต่อ — ไม่ได้บันทึก', 'لا اتصال — لم يُحفظ'));
        return false;
      }
      if (op.upsert) {
        var i = base.reports.findIndex(function (r) { return r.id === op.upsert.id; });
        if (i === -1) base.reports.push(op.upsert); else base.reports[i] = op.upsert;
      }
      if (op.remove) base.reports = base.reports.filter(function (r) { return r.id !== op.remove; });
      DB.save(key(y), base);
      seen[y] = true;
      if (season === y) S = base;
      return true;
    });
  }

  // ── maths ──
  function totals(r) {
    var by = {}, total = 0, revenue = 0, priced = false;
    TYPES.forEach(function (t) { by[t.v] = { kg: 0, rev: 0 }; });
    (r.fractions || []).forEach(function (f) {
      var w = num(f.kg), p = num(f.price);
      if (!by[f.type]) by[f.type] = { kg: 0, rev: 0 };
      by[f.type].kg += w; total += w;
      if (p > 0) { priced = true; by[f.type].rev += w * p; revenue += w * p; }
    });
    return { by: by, total: total, revenue: revenue, priced: priced };
  }
  function intakeCalc(r, row) {
    var i = r.intake || {};
    if (row.calc === 'dryLoss') {
      var w = num(i.wet), d = num(i.dry);
      return w > 0 && d > 0 ? { kg: w - d, pct: (w - d) / w * 100 } : null;
    }
    if (row.pctOf) {
      var base = num(i[row.pctOf]), v = num(i[row.k]);
      return base > 0 && v > 0 ? { kg: v, pct: v / base * 100 } : null;
    }
    return null;
  }

  function newReport(fmt) {
    var f = FORMATS[fmt] ? fmt : 'dates-sorting';
    var ids = farmIds();
    return {
      id: uid(), format: f, farmId: farmFilter ? Number(farmFilter) : (ids.length === 1 ? ids[0] : null),
      variety: f === 'dates-sorting' ? 'מגהול' : '', packer: '', marketer: '',
      date: new Date().toISOString().slice(0, 10), intake: {},
      fractions: FORMATS[f].fractions.map(function (x) { return { type: x[0], code: x[1], name: x[2], kg: '', price: '' }; }),
      notes: '', createdBy: me(), createdAt: Date.now()
    };
  }
  function fillVariety(r) {
    (r.fractions || []).forEach(function (f) { if (f.name) f.name = f.name.replace(/\{v\}/g, r.variety || ''); });
  }

  // Names used before, for the packer / marketer / variety pickers.
  function usedNames(field) {
    var out = {};
    (S.reports || []).forEach(function (r) { if (r[field]) out[r[field]] = true; });
    if (field === 'variety') {
      (store().getPlots ? store().getPlots() : []).forEach(function (p) { if (p.variety) out[p.variety] = true; });
      out['מגהול'] = true;
    }
    return Object.keys(out).sort(function (a, b) { return a.localeCompare(b, 'he'); });
  }

  // ── styles (theme variables, so all three palettes apply) ──
  function injectCss() {
    if (document.getElementById('hv-css')) return;
    var st = document.createElement('style');
    st.id = 'hv-css';
    st.textContent =
      '.hv-wrap{padding:14px 14px 90px;overflow-y:auto;height:100%;box-sizing:border-box;}' +
      '.hv-top{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;}' +
      '.hv-top h2{flex:1 1 100%;margin:0 0 2px;font-size:1.15rem;color:var(--text);}' +
      '.hv-top select{flex:1;min-width:0;}' +
      '.hv-new{flex:0 0 auto;}' +
      '.hv-card{background:var(--card);border:1px solid var(--line,#dbe3d8);border-radius:16px;padding:12px 14px;margin-bottom:10px;cursor:pointer;}' +
      '.hv-card h3{margin:0;font-size:1rem;color:var(--text);display:flex;justify-content:space-between;gap:8px;}' +
      '.hv-card .hv-sub{font-size:.78rem;color:var(--text-muted);margin-top:3px;}' +
      '.hv-kpis{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}' +
      '.hv-kpi{background:var(--tonal,#e5ece3);border-radius:99px;padding:3px 10px;font-size:.76rem;font-weight:600;color:var(--text);}' +
      '.hv-kpi.p{background:var(--primary-soft,#dcebe2);color:var(--primary);}' +
      '.hv-empty{text-align:center;color:var(--text-muted);padding:30px 10px;font-size:.9rem;}' +
      '.hv-back{position:fixed;inset:0;z-index:2000;background:rgba(16,24,20,.42);display:flex;align-items:flex-start;justify-content:center;padding:12px;overflow-y:auto;}' +
      '.hv-sheet{background:var(--card);color:var(--text);border-radius:20px;width:100%;max-width:820px;padding:16px;box-sizing:border-box;margin:auto;}' +
      '.hv-sheet h2{margin:0 0 12px;font-size:1.1rem;}' +
      '.hv-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 10px;}' +
      '@media (max-width:560px){.hv-grid{grid-template-columns:1fr;}}' +
      '.hv-f label{display:block;font-size:.74rem;color:var(--text-muted);margin-bottom:3px;}' +
      '.hv-sec{font-weight:700;font-size:.9rem;margin:16px 0 8px;color:var(--text);}' +
      '.hv-in{display:grid;grid-template-columns:1fr 110px 70px;gap:6px;align-items:center;font-size:.82rem;padding:4px 0;border-bottom:1px solid var(--line,#e6e6e6);}' +
      '.hv-in input{text-align:center;padding:7px !important;}' +
      '.hv-in .hv-c{text-align:center;color:var(--text-muted);font-size:.78rem;}' +
      '.hv-x{background:none;border:none;color:var(--danger);font-size:1rem;cursor:pointer;padding:2px 4px;}' +
      '.hv-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px;}' +
      '.hv-actions .btn{flex:1;min-width:120px;}' +
      '.hv-row{border:1px solid var(--line,#e2e6df);border-radius:12px;padding:6px;margin-bottom:6px;background:var(--card);}' +
      '.hv-l1{display:grid;grid-template-columns:96px 92px 1fr 26px;gap:5px;align-items:center;}' +
      '.hv-l2{display:grid;grid-template-columns:1fr 64px 1fr 92px;gap:5px;align-items:end;margin-top:5px;}' +
      '.hv-l2 label{font-size:.66rem;color:var(--text-muted);display:flex;flex-direction:column;gap:2px;}' +
      '.hv-row input,.hv-row select{padding:7px !important;font-size:.82rem !important;min-width:0;width:100%;box-sizing:border-box;}' +
      '.hv-row .hv-c{font-size:.78rem;color:var(--text-muted);text-align:center;padding-bottom:9px;white-space:nowrap;}' +
      '.hv-sum{display:grid;grid-template-columns:1fr 80px 70px 100px;gap:5px;padding:7px 10px;border-radius:10px;background:var(--tonal,#eef2ec);font-weight:700;font-size:.8rem;margin:2px 0 8px;}' +
      '.hv-sum span:not(:first-child){text-align:center;white-space:nowrap;}' +
      '.hv-tot{background:var(--primary-soft,#dcebe2);color:var(--primary);}' +
      '.hv-avg{text-align:left;font-size:.78rem;color:var(--text-muted);margin-top:-2px;}' +
      '@media (max-width:420px){.hv-l1{grid-template-columns:84px 76px 1fr 24px;}.hv-sum{grid-template-columns:1fr 64px 58px 84px;font-size:.74rem;}}';
    document.head.appendChild(st);
  }

  // ── tab ──
  function host() { return document.getElementById('harvestRoot'); }

  function render() {
    injectCss();
    if (S.year !== season || !seen[season]) load(season); else paint();
  }

  function paint() {
    var el = host();
    if (!el) return;
    var ids = farmIds();
    var list = (S.reports || []).filter(function (r) {
      if (ids.indexOf(r.farmId) === -1) return false;          // only farms this user may see
      return !farmFilter || String(r.farmId) === String(farmFilter);
    }).sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });

    var y0 = defaultSeason();
    var years = [y0 + 1, y0, y0 - 1, y0 - 2, y0 - 3].map(function (y) {
      return '<option value="' + y + '"' + (y === season ? ' selected' : '') + '>' + tt('עונה', 'ฤดูกาล', 'موسم') + ' ' + y + '</option>';
    }).join('');
    var farmOpts = '<option value="">' + tt('כל המטעים', 'ทุกสวน', 'جميع البساتين') + '</option>' +
      farms().map(function (f) { return '<option value="' + f.id + '"' + (String(f.id) === String(farmFilter) ? ' selected' : '') + '>' + esc(f.name) + '</option>'; }).join('');

    var cards = list.map(function (r) {
      var t = totals(r), fmt = FORMATS[r.format] || FORMATS['dates-sorting'];
      var exp = t.total ? t.by.export.kg / t.total * 100 : 0;
      return '<div class="hv-card" data-hv="' + esc(r.id) + '">' +
        '<h3><span>' + esc(farmName(r.farmId)) + (r.variety ? ' · ' + esc(r.variety) : '') + '</span>' +
          '<span style="font-weight:500;font-size:.8rem;color:var(--text-muted);">' + esc(r.date ? new Date(r.date).toLocaleDateString('he-IL') : '') + '</span></h3>' +
        '<div class="hv-sub">' + esc([r.packer, r.marketer].filter(Boolean).join(' → ') || fmt.label()) + '</div>' +
        '<div class="hv-kpis">' +
          '<span class="hv-kpi">' + kg(t.total) + ' ' + tt('ק"ג', 'กก.', 'كغ') + '</span>' +
          (t.total ? '<span class="hv-kpi p">' + tt('יצוא', 'ส่งออก', 'تصدير') + ' ' + pct(exp) + '</span>' : '') +
          (t.priced ? '<span class="hv-kpi">' + money(t.revenue) + '</span>' : '') +
        '</div></div>';
    }).join('');

    el.innerHTML = '<div class="hv-wrap">' +
      '<div class="hv-top"><h2>📦 ' + tt('תוצאות מיון / קטיף', 'ผลการคัดแยก/เก็บเกี่ยว', 'نتائج الفرز / القطف') + '</h2>' +
        '<select class="form-input" id="hvSeason">' + years + '</select>' +
        '<select class="form-input" id="hvFarm">' + farmOpts + '</select>' +
        (canEdit() ? '<button class="btn btn-primary hv-new" id="hvNew">+ ' + tt('דוח חדש', 'รายงานใหม่', 'تقرير جديد') + '</button>' : '') +
      '</div>' +
      (cards || '<div class="hv-empty">' + (farms().length
        ? tt('אין עדיין תוצאות לעונה זו.', 'ยังไม่มีผลสำหรับฤดูกาลนี้', 'لا نتائج لهذا الموسم بعد.') + (canEdit() ? '<br>' + tt('לחצו "דוח חדש" כדי להזין תוצאות מבית האריזה.', 'กด "รายงานใหม่"', 'اضغط "تقرير جديد"') : '')
        : tt('אין מטעים משויכים למשתמש.', 'ไม่มีสวนที่ผูกไว้', 'لا توجد بساتين مرتبطة')) + '</div>') +
      '</div>';

    document.getElementById('hvSeason').addEventListener('change', function () { load(Number(this.value)); });
    document.getElementById('hvFarm').addEventListener('change', function () { farmFilter = this.value; paint(); });
    var nb = document.getElementById('hvNew');
    if (nb) nb.addEventListener('click', function () { openEditor(null); });
    el.querySelectorAll('[data-hv]').forEach(function (c) {
      c.addEventListener('click', function () { openEditor(this.getAttribute('data-hv')); });
    });
  }

  // ── editor ──
  function openEditor(id) {
    var src = id ? (S.reports || []).find(function (r) { return r.id === id; }) : null;
    if (id && !src) return;
    draft = src ? JSON.parse(JSON.stringify(src)) : newReport('dates-sorting');
    if (!src) fillVariety(draft);
    drawEditor();
  }

  function closeEditor() {
    draft = null;
    var b = document.getElementById('hvBack');
    if (b) b.remove();
    paint();
  }

  function datalist(id, field) {
    return '<datalist id="' + id + '">' + usedNames(field).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist>';
  }

  function drawEditor() {
    var r = draft, ro = !canEdit();
    var fmt = FORMATS[r.format] || FORMATS['dates-sorting'];
    var dis = ro ? ' disabled' : '';
    var farmOpts = farms().map(function (f) {
      return '<option value="' + f.id + '"' + (f.id === r.farmId ? ' selected' : '') + '>' + esc(f.name) + '</option>';
    }).join('');
    if (!r.farmId) farmOpts = '<option value="">' + tt('בחר מטע', 'เลือกสวน', 'اختر بستانًا') + '</option>' + farmOpts;
    var fmtOpts = Object.keys(FORMATS).map(function (k) {
      return '<option value="' + k + '"' + (k === r.format ? ' selected' : '') + '>' + esc(FORMATS[k].label()) + '</option>';
    }).join('');

    var intake = fmt.intake.map(function (row) {
      var c = intakeCalc(r, row);
      var val = row.calc ? (c ? kg(c.kg) : '—') : null;
      return '<div class="hv-in"><span>' + esc(row.he) + '</span>' +
        (row.calc
          ? '<span class="hv-c">' + val + '</span>'
          : '<input type="number" inputmode="decimal" class="form-input" data-in="' + row.k + '" value="' + esc((r.intake || {})[row.k] || '') + '"' + dis + '>') +
        '<span class="hv-c">' + (c ? pct(c.pct) : '') + '</span></div>';
    }).join('');

    var body = buildFractionRows(r, ro);

    var back = document.createElement('div');
    back.className = 'hv-back';
    back.id = 'hvBack';
    back.innerHTML = '<div class="hv-sheet" role="dialog">' +
      '<h2>📦 ' + (ro ? '' : (r.createdAt && (S.reports || []).some(function (x) { return x.id === r.id; }) ? tt('עריכת דוח', 'แก้ไขรายงาน', 'تعديل التقرير') : tt('דוח חדש', 'รายงานใหม่', 'تقرير جديد')) + ' · ') + tt('עונה', 'ฤดูกาล', 'موسم') + ' ' + season + '</h2>' +
      '<div class="hv-grid">' +
        '<div class="hv-f"><label>' + tt('מטע', 'สวน', 'بستان') + '</label><select class="form-input" id="hvFarmSel"' + dis + '>' + farmOpts + '</select></div>' +
        '<div class="hv-f"><label>' + tt('פורמט הדוח', 'รูปแบบรายงาน', 'صيغة التقرير') + '</label><select class="form-input" id="hvFmt"' + dis + '>' + fmtOpts + '</select></div>' +
        '<div class="hv-f"><label>' + tt('בית אריזה', 'โรงคัดบรรจุ', 'بيت التعبئة') + '</label><input class="form-input" id="hvPacker" list="hvPackers" value="' + esc(r.packer) + '"' + dis + '>' + datalist('hvPackers', 'packer') + '</div>' +
        '<div class="hv-f"><label>' + tt('משווק', 'ผู้จำหน่าย', 'المسوّق') + '</label><input class="form-input" id="hvMarketer" list="hvMarketers" value="' + esc(r.marketer) + '"' + dis + '>' + datalist('hvMarketers', 'marketer') + '</div>' +
        '<div class="hv-f"><label>' + tt('זן', 'พันธุ์', 'الصنف') + '</label><input class="form-input" id="hvVariety" list="hvVarieties" value="' + esc(r.variety) + '"' + dis + '>' + datalist('hvVarieties', 'variety') + '</div>' +
        '<div class="hv-f"><label>' + tt('תאריך הדוח', 'วันที่รายงาน', 'تاريخ التقرير') + '</label><input type="date" class="form-input" id="hvDate" value="' + esc(r.date) + '"' + dis + '></div>' +
      '</div>' +
      '<div class="hv-sec">' + tt('קליטת פרי', 'การรับผลผลิต', 'استلام الثمار') + ' <span style="font-weight:400;color:var(--text-muted);font-size:.74rem;">(' + tt('ק"ג', 'กก.', 'كغ') + ')</span></div>' +
      '<div id="hvIntake">' + intake + '</div>' +
      '<div class="hv-sec">' + tt('חלוקה לפרקציות', 'แบ่งตามเกรด', 'التقسيم إلى فئات') + ' <span style="font-weight:400;color:var(--text-muted);font-size:.74rem;">(' + tt('מחיר לק"ג — לא חובה', 'ราคาต่อกก. — ไม่บังคับ', 'السعر للكغ — اختياري') + ')</span></div>' +
      '<div id="hvFrBody">' + body + '</div>' +
      (ro ? '' : '<button class="btn btn-secondary" id="hvAddRow" style="margin-top:8px;">+ ' + tt('שורה', 'แถว', 'سطر') + '</button>') +
      '<div class="hv-sec">' + tt('הערות', 'หมายเหตุ', 'ملاحظات') + '</div>' +
      '<textarea class="form-input" id="hvNotes" rows="2"' + dis + '>' + esc(r.notes) + '</textarea>' +
      '<div class="hv-actions">' +
        (ro ? '' : '<button class="btn btn-primary" id="hvSave">' + tt('שמירה', 'บันทึก', 'حفظ') + '</button>') +
        '<button class="btn btn-secondary" id="hvPrint">' + tt('הדפסה / PDF', 'พิมพ์ / PDF', 'طباعة / PDF') + '</button>' +
        (!ro && (S.reports || []).some(function (x) { return x.id === r.id; }) ? '<button class="btn btn-secondary" id="hvDel" style="color:var(--danger);">' + tt('מחיקה', 'ลบ', 'حذف') + '</button>' : '') +
        '<button class="btn btn-secondary" id="hvClose">' + tt('סגירה', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';
    var old = document.getElementById('hvBack');
    if (old) old.remove();
    document.body.appendChild(back);
    wireEditor();
  }

  // Each fraction is a two-line row so it stays usable at phone width:
  //   type · grade · name                       ✕
  //   weight · % · price/kg · revenue
  function buildFractionRows(r, ro) {
    var t = totals(r), out = '', dis = ro ? ' disabled' : '';
    TYPES.forEach(function (ty) {
      var tv = ty.v, rows = [];
      (r.fractions || []).forEach(function (f, i) { if (f.type === tv) rows.push({ f: f, i: i }); });
      if (!rows.length) return;
      rows.forEach(function (o) {
        var f = o.f, w = num(f.kg), p = num(f.price);
        var typeSel = '<select class="form-input" data-fr="' + o.i + '" data-k="type"' + dis + '>' + TYPES.map(function (x) {
          return '<option value="' + x.v + '"' + (x.v === f.type ? ' selected' : '') + '>' + typeLabel(x.v) + '</option>';
        }).join('') + '</select>';
        out += '<div class="hv-row">' +
          '<div class="hv-l1">' + typeSel +
            '<input class="form-input" data-fr="' + o.i + '" data-k="code" value="' + esc(f.code) + '"' + dis + ' placeholder="' + tt('פרקציה', 'เกรด', 'الفئة') + '" style="direction:ltr;text-align:right;">' +
            '<input class="form-input" data-fr="' + o.i + '" data-k="name" value="' + esc(f.name) + '"' + dis + ' placeholder="' + tt('שם', 'ชื่อ', 'الاسم') + '">' +
            (ro ? '<span></span>' : '<button class="hv-x" data-del="' + o.i + '" aria-label="' + tt('הסר', 'ลบ', 'إزالة') + '">✕</button>') +
          '</div>' +
          '<div class="hv-l2">' +
            '<label>' + tt('משקל', 'น้ำหนัก', 'الوزن') + '<input type="number" inputmode="decimal" class="form-input" data-fr="' + o.i + '" data-k="kg" value="' + esc(f.kg) + '"' + dis + '></label>' +
            '<span class="hv-c">' + (t.total && w ? pct(w / t.total * 100) : '—') + '</span>' +
            '<label>' + tt('₪ לק"ג', '₪/กก.', '₪/كغ') + '<input type="number" inputmode="decimal" step="0.01" class="form-input" data-fr="' + o.i + '" data-k="price" value="' + esc(f.price) + '"' + dis + '></label>' +
            '<span class="hv-c">' + (w && p ? money(w * p) : '') + '</span>' +
          '</div></div>';
      });
      var b = t.by[tv];
      out += '<div class="hv-sum"><span>' + tt('סה"כ', 'รวม', 'المجموع') + ' ' + typeLabel(tv) + '</span>' +
        '<span>' + kg(b.kg) + '</span><span>' + (t.total ? pct(b.kg / t.total * 100) : '') + '</span><span>' + (b.rev ? money(b.rev) : '') + '</span></div>';
    });
    out += '<div class="hv-sum hv-tot"><span>' + tt('סה"כ תוצרת גמורה', 'รวมผลผลิตสำเร็จ', 'إجمالي المنتج النهائي') + '</span>' +
      '<span>' + kg(t.total) + '</span><span>' + (t.total ? '100.00 %' : '') + '</span><span>' + (t.priced ? money(t.revenue) : '') + '</span></div>' +
      (t.priced && t.total ? '<div class="hv-avg">' + tt('מחיר ממוצע לק"ג', 'ราคาเฉลี่ย/กก.', 'متوسط السعر/كغ') + ': ' + money(t.revenue / t.total) + '</div>' : '');
    return out;
  }

  function readHeader() {
    var r = draft;
    var fs = document.getElementById('hvFarmSel');
    r.farmId = fs && fs.value ? Number(fs.value) : null;
    r.packer = document.getElementById('hvPacker').value.trim();
    r.marketer = document.getElementById('hvMarketer').value.trim();
    r.variety = document.getElementById('hvVariety').value.trim();
    r.date = document.getElementById('hvDate').value;
    r.notes = document.getElementById('hvNotes').value;
  }

  // Live recalculation without rebuilding inputs (keeps focus and keyboard).
  function refreshCalc() {
    var r = draft, fmt = FORMATS[r.format] || FORMATS['dates-sorting'];
    var rows = document.querySelectorAll('#hvIntake .hv-in');
    fmt.intake.forEach(function (row, i) {
      var c = intakeCalc(r, row), el = rows[i];
      if (!el) return;
      var spans = el.querySelectorAll('.hv-c');
      if (row.calc) spans[0].textContent = c ? kg(c.kg) : '—';
      spans[spans.length - 1].textContent = c ? pct(c.pct) : '';
    });
  }

  function wireEditor() {
    var back = document.getElementById('hvBack');
    var ro = !canEdit();
    back.addEventListener('click', function (e) { if (e.target === back) closeEditor(); });
    document.getElementById('hvClose').addEventListener('click', closeEditor);
    document.getElementById('hvPrint').addEventListener('click', function () { if (!ro) readHeader(); printReport(draft); });
    if (ro) return;

    document.getElementById('hvFmt').addEventListener('change', function () {
      readHeader();
      var nf = this.value;
      var hasData = (draft.fractions || []).some(function (f) { return num(f.kg) > 0; });
      if (hasData && !confirm(tt('החלפת פורמט תחליף את שורות הפרקציות. להמשיך?', 'เปลี่ยนรูปแบบจะแทนที่แถว ดำเนินการต่อ?', 'تغيير الصيغة سيستبدل الأسطر. متابعة؟'))) { this.value = draft.format; return; }
      draft.format = nf;
      draft.fractions = FORMATS[nf].fractions.map(function (x) { return { type: x[0], code: x[1], name: x[2], kg: '', price: '' }; });
      fillVariety(draft);
      drawEditor();
    });

    document.getElementById('hvIntake').addEventListener('input', function (e) {
      var k = e.target.getAttribute('data-in');
      if (!k) return;
      draft.intake = draft.intake || {};
      draft.intake[k] = e.target.value;
      refreshCalc();
    });

    var body = document.getElementById('hvFrBody');
    body.addEventListener('change', function (e) {
      var i = e.target.getAttribute('data-fr'), k = e.target.getAttribute('data-k');
      if (i === null || !k) return;
      draft.fractions[Number(i)][k] = e.target.value;
      readHeader();
      // Totals and per-row % depend on every row: redraw the table body.
      body.innerHTML = buildFractionRows(draft, false);
    });
    body.addEventListener('click', function (e) {
      var d = e.target.getAttribute('data-del');
      if (d === null) return;
      draft.fractions.splice(Number(d), 1);
      body.innerHTML = buildFractionRows(draft, false);
    });
    document.getElementById('hvAddRow').addEventListener('click', function () {
      readHeader();
      draft.fractions.push({ type: 'export', code: '', name: '', kg: '', price: '' });
      body.innerHTML = buildFractionRows(draft, false);
    });

    document.getElementById('hvSave').addEventListener('click', function () {
      readHeader();
      if (!draft.farmId) { toast('⚠️ ' + tt('יש לבחור מטע', 'ต้องเลือกสวน', 'يجب اختيار بستان')); return; }
      if (farmIds().indexOf(draft.farmId) === -1) { toast('⛔ ' + tt('אין לך הרשאה למטע זה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
      var rec = JSON.parse(JSON.stringify(draft));
      rec.updatedAt = Date.now();
      rec.updatedBy = me();
      commit(season, { upsert: rec }).then(function (ok) {
        if (!ok) return;
        toast('✅ ' + tt('הדוח נשמר', 'บันทึกรายงานแล้ว', 'تم حفظ التقرير'));
        closeEditor();
      });
    });
    var del = document.getElementById('hvDel');
    if (del) del.addEventListener('click', function () {
      if (!confirm(tt('למחוק את הדוח?', 'ลบรายงาน?', 'حذف التقرير؟'))) return;
      commit(season, { remove: draft.id }).then(function (ok) {
        if (!ok) return;
        toast('🗑️ ' + tt('הדוח נמחק', 'ลบรายงานแล้ว', 'تم حذف التقرير'));
        closeEditor();
      });
    });
  }

  // ── printed report (soft letterhead, literal colours for print) ──
  function printReport(r) {
    var TH = (window.ReportTheme && window.ReportTheme.resolve) ? window.ReportTheme.resolve(null) : {};
    var ink = TH.ink || '#1d3d2e', soft = TH.soft || '#e4eee8', line = TH.line || '#c6d8cd', c2 = TH.c2 || '#2f6a4f';
    var fmt = FORMATS[r.format] || FORMATS['dates-sorting'];
    var t = totals(r);
    var intake = fmt.intake.map(function (row) {
      var c = intakeCalc(r, row), v = row.calc ? (c ? c.kg : '') : (r.intake || {})[row.k];
      return '<tr><td>' + esc(row.he) + '</td><td class="n">' + (num(v) ? kg(v) : '') + '</td><td class="n">' + (c ? pct(c.pct) : '') + '</td></tr>';
    }).join('');
    var frac = '';
    TYPES.forEach(function (ty) {
      var rows = (r.fractions || []).filter(function (f) { return f.type === ty.v && (num(f.kg) || f.code || f.name); });
      if (!rows.length) return;
      rows.forEach(function (f) {
        var w = num(f.kg), p = num(f.price);
        frac += '<tr><td>' + typeLabel(ty.v) + '</td><td style="direction:ltr;text-align:right;">' + esc(f.code) + '</td><td>' + esc(f.name) + '</td>' +
          '<td class="n">' + (w ? kg(w) : '') + '</td><td class="n">' + (t.total && w ? pct(w / t.total * 100) : '') + '</td>' +
          (t.priced ? '<td class="n">' + (p ? money(p) : '') + '</td><td class="n">' + (w && p ? money(w * p) : '') + '</td>' : '') + '</tr>';
      });
      var b = t.by[ty.v];
      frac += '<tr class="sub"><td colspan="3">' + tt('סה"כ', 'รวม', 'المجموع') + ' ' + typeLabel(ty.v) + ':</td><td class="n">' + kg(b.kg) + '</td><td class="n">' + (t.total ? pct(b.kg / t.total * 100) : '') + '</td>' +
        (t.priced ? '<td></td><td class="n">' + (b.rev ? money(b.rev) : '') + '</td>' : '') + '</tr>';
    });
    frac += '<tr class="tot"><td colspan="3">' + tt('סה"כ תוצרת גמורה', 'รวมผลผลิตสำเร็จ', 'إجمالي المنتج النهائي') + ':</td><td class="n">' + kg(t.total) + '</td><td class="n">100.00 %</td>' +
      (t.priced ? '<td class="n">' + (t.total ? money(t.revenue / t.total) : '') + '</td><td class="n">' + money(t.revenue) + '</td>' : '') + '</tr>';

    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc(tt('סיכום תוצאות מיון', 'สรุปผลคัดแยก', 'ملخص نتائج الفرز') + ' — ' + farmName(r.farmId)) + '</title>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap">' +
      '<style>@page{size:A4 portrait;margin:12mm;}' +
      'body{font-family:Rubik,Arial,sans-serif;direction:rtl;color:#222;margin:0;}' +
      '.hd{background:' + soft + ';border-radius:16px;padding:16px 20px;margin-bottom:14px;}' +
      '.hd h1{margin:0;font-size:1.35rem;color:' + ink + ';}' +
      '.hd .sub{color:#5f5a55;font-size:.86rem;margin-top:4px;}' +
      '.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:6px 14px;font-size:.82rem;margin-bottom:14px;}' +
      '.meta b{color:' + ink + ';}' +
      'h2{font-size:.95rem;color:' + ink + ';border-bottom:2px solid ' + line + ';padding-bottom:3px;margin:16px 0 6px;}' +
      'table{width:100%;border-collapse:collapse;font-size:.8rem;}' +
      'th{background:' + soft + ';color:' + ink + ';text-align:right;padding:5px 7px;font-weight:700;border-bottom:1.5px solid ' + line + ';}' +
      'td{padding:5px 7px;border-bottom:1px solid #eceae6;}' +
      'td.n{text-align:left;direction:ltr;white-space:nowrap;font-variant-numeric:tabular-nums;}' +
      'tr.sub td{background:#f4f6f1;font-weight:700;}' +
      'tr.tot td{background:' + soft + ';font-weight:700;color:' + ink + ';}' +
      '.notes{margin-top:12px;font-size:.8rem;white-space:pre-wrap;}' +
      '.ft{margin-top:18px;font-size:.7rem;color:#888;}' +
      '.kpis{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}' +
      '.kpi{background:#fff;border:1px solid ' + line + ';border-radius:99px;padding:3px 10px;font-size:.78rem;font-weight:600;color:' + c2 + ';}' +
      '</style></head><body>' +
      '<div class="hd"><h1>' + tt('סיכום תוצאות מיון', 'สรุปผลคัดแยก', 'ملخص نتائج الفرز') + '</h1>' +
        '<div class="sub">' + esc(fmt.label()) + ' · ' + tt('עונה', 'ฤดูกาล', 'موسم') + ' ' + season + '</div>' +
        '<div class="kpis"><span class="kpi">' + kg(t.total) + ' ' + tt('ק"ג תוצרת גמורה', 'กก.', 'كغ منتج نهائي') + '</span>' +
          (t.total ? '<span class="kpi">' + tt('יצוא', 'ส่งออก', 'تصدير') + ' ' + pct(t.by.export.kg / t.total * 100) + '</span>' : '') +
          (t.priced ? '<span class="kpi">' + tt('הכנסה', 'รายได้', 'الدخل') + ' ' + money(t.revenue) + '</span>' : '') + '</div></div>' +
      '<div class="meta">' +
        '<div>' + tt('מגדל / מטע', 'สวน', 'المزارع / البستان') + ': <b>' + esc(farmName(r.farmId)) + '</b></div>' +
        '<div>' + tt('זן הפרי', 'พันธุ์', 'الصنف') + ': <b>' + esc(r.variety || '—') + '</b></div>' +
        '<div>' + tt('תאריך', 'วันที่', 'التاريخ') + ': <b>' + esc(r.date ? new Date(r.date).toLocaleDateString('he-IL') : '—') + '</b></div>' +
        '<div>' + tt('בית אריזה', 'โรงคัดบรรจุ', 'بيت التعبئة') + ': <b>' + esc(r.packer || '—') + '</b></div>' +
        '<div>' + tt('משווק', 'ผู้จำหน่าย', 'المسوّق') + ': <b>' + esc(r.marketer || '—') + '</b></div>' +
      '</div>' +
      '<h2>' + tt('קליטת פרי', 'การรับผลผลิต', 'استلام الثمار') + '</h2>' +
      '<table><thead><tr><th></th><th>' + tt('משקל (ק"ג)', 'น้ำหนัก (กก.)', 'الوزن (كغ)') + '</th><th>' + tt('אחוז', '%', 'النسبة') + '</th></tr></thead><tbody>' + intake + '</tbody></table>' +
      '<h2>' + tt('חלוקה לפרקציות', 'แบ่งตามเกรด', 'التقسيم إلى فئات') + '</h2>' +
      '<table><thead><tr><th>' + tt('אופי טיב', 'ประเภท', 'النوع') + '</th><th>' + tt('פרקציה', 'เกรด', 'الفئة') + '</th><th>' + tt('שם', 'ชื่อ', 'الاسم') + '</th><th>' + tt('משקל', 'น้ำหนัก', 'الوزن') + '</th><th>' + tt('אחוז', '%', 'النسبة') + '</th>' +
        (t.priced ? '<th>' + tt('₪ לק"ג', '₪/กก.', '₪/كغ') + '</th><th>' + tt('הכנסה', 'รายได้', 'الدخل') + '</th>' : '') + '</tr></thead><tbody>' + frac + '</tbody></table>' +
      (r.notes ? '<div class="notes">' + esc(r.notes) + '</div>' : '') +
      '<div class="ft">' + tt('הופק ב', 'สร้างเมื่อ', 'أُنشئ في') + '-' + new Date().toLocaleDateString('he-IL') + '</div>' +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, ('harvest_' + farmName(r.farmId) + '_' + season).replace(/\s+/g, '_') + '.html');
    }
  }

  return {
    render: render,
    open: openEditor,
    FORMATS: FORMATS
  };
})();
window.HarvestResults = HarvestResults;
