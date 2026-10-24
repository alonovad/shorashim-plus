/* agriplan.js - תוכניות טיפול (forward treatment plans)
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
 * COHORTS: the sheets split inside a חלקה - 'תמרים 23' is 4382 productive
 * trees AND 222 לא מניב, on different volumes; 'ייטב' splits by variety.
 * A plot record carries one tree_count, so a plan row targets
 * plotId + cohort + trees, seeded from the plot and overridable. Without
 * that layer the לא מניב trees silently inherit the productive volume.
 *
 * DATA: appData/shorashim-agri-plan-{YYYY} - one document per season, the
 * same shape pestmonitor.js uses, so a new year needs no rules deploy
 * (the rules match on the prefix).
 *
 * Access: operator+ (rules + client). Growers read their own farm's sheet
 * off the printed distribution page, not from this screen.
 *
 * OWNERSHIP: inside the feature a plan belongs to whoever created it.
 * Admin may edit and delete every plan; an operator may edit and delete
 * only the plans stamped with his own username, and sees everyone else's
 * read-only. This is a UI boundary, not a rules boundary - the whole
 * season is ONE document written wholesale, so Firestore can only see
 * "an operator wrote appData/shorashim-agri-plan-YYYY", never which plan
 * inside it changed. Rules-level ownership needs per-plan documents.
 *
 * APPROVAL is per מטע. A farm's rows reach that farm's card
 * (showFarmDetails → farmCard) only after an admin approves that farm.
 * Each approval stores a signature of what the crew there executes: the
 * plan-wide fields (name, target, deadline, notes), that farm's note and
 * that farm's rows. A farm counts as approved only while its signature still
 * matches - editing farm B's rows withdraws farm B alone; editing a
 * plan-wide field withdraws every farm. No mutator has to remember to reset
 * a flag.
 *
 * Approvals live in their own document, appData/shorashim-agri-approvals-
 * {YYYY}, which firestore.rules lets only an admin write. An operator can
 * write the plans but not an approval, and cannot change approved content
 * without its signature failing - so, unlike ownership, approval is
 * enforced by the rules, not only by this client. Anything called
 * 'approvals' inside the plan document itself is ignored.
 */
var AgriPlan = (function () {
  'use strict';

  var KEY_PREFIX = 'shorashim-agri-plan-';
  // Admin-only in firestore.rules - see APPROVAL in the header.
  var APPROVALS_PREFIX = 'shorashim-agri-approvals-';
  // Saved templates for "דגשים לביצוע והכנות", shared across seasons and
  // plans: { items: [{ id, name, text, createdBy… }] } - operator+ write.
  var TPL_KEY = 'shorashim-agri-prep-templates';
  var _tpl = null, _tplOpen = false;

  // אופן יישום. Each method only decides which carrier column is shown and
  // which label prints - the dose maths lives on the material, not here.
  var METHODS = [
    { v: 'spray',  carrier: 'L',  def: 'pct' },
    { v: 'drench', carrier: 'L',  def: 'cc'  },
    { v: 'inject', carrier: 'cc', def: 'cc'  },
    // Any other job on the trees (pruning, cleaning, a hand application…):
    // the round field carries its description; materials are optional.
    { v: 'general', carrier: 'L', def: 'cc' },
    // Soil disinfection for field crops and vegetables: counted per DUNAM,
    // not per tree - the row's quantity is the plot's area.
    { v: 'soil',   carrier: 'L',  def: 'lu', unit: 'dunam' },
    // Drench through the irrigation system: injected per valve / plot, so it
    // is counted per DUNAM like soil disinfection - no per-tree volume.
    { v: 'drench_irr', carrier: 'L', def: 'lu', unit: 'dunam' }
  ];
  function isDunam(method) { return method === 'soil' || method === 'drench_irr'; }
  function qtyWord(method) { return isDunam(method) ? tt('דונם', 'ไร่', 'دونم') : tt('עצים', 'ต้น', 'شجرة'); }
  function plotQty(pl, method) { return isDunam(method) ? Math.round((Number(pl && pl.area) || 0) * 100) / 100 : (Number(pl && pl.tree_count) || 0); }
  function methodLabel(v) {
    if (v === 'spray')  return tt('ריסוס', 'พ่นยา', 'رش');
    if (v === 'drench') return tt('הגמעה ידנית עץ-עץ', 'รดโคนต้น', 'سقي فردي');
    if (v === 'inject') return tt('הזרקת גזע', 'ฉีดลำต้น', 'حقن الجذع');
    if (v === 'general') return tt('טיפול כללי', 'งานทั่วไป', 'معالجة عامة');
    if (v === 'soil') return tt('חיטוי קרקע', 'ฆ่าเชื้อดิน', 'تعقيم التربة');
    if (v === 'drench_irr') return tt('הגמעה דרך מערכת ההשקיה', 'รดผ่านระบบน้ำ', 'سقي عبر نظام الري');
    return v;
  }
  // Written out in full on every row and every printed line. A number with
  // no application mode next to it is the thing that gets misread in the
  // field: 43.8 L of טוטם into a sprayer tank and 3.9 L of קוהינור poured
  // around a trunk are not interchangeable operations.
  function modeLabel(method) {
    if (method === 'drench') return tt('להגמעה', 'สำหรับรดโคน', 'للسقي');
    if (method === 'inject') return tt('להזרקה', 'สำหรับฉีด', 'للحقن');
    if (method === 'soil') return tt('לחיטוי קרקע', 'สำหรับฆ่าเชื้อดิน', 'لتعقيم التربة');
    if (method === 'drench_irr') return tt('להזרקה למערכת ההשקיה', 'ฉีดเข้าระบบน้ำ', 'للحقن في نظام الري');
    if (method === 'general') return tt('לטיפול', 'สำหรับงาน', 'للمعالجة');
    return tt('למרסס', 'ใส่ถังพ่น', 'لخزان الرش');
  }

  function carrierLabel(v) {
    if (v === 'spray')  return tt('נפח ריסוס לעץ (ליטר)', 'ปริมาตร/ต้น (ลิตร)', 'حجم الرش/شجرة (لتر)');
    if (v === 'drench') return tt('נפח הגמעה לעץ (ליטר)', 'ปริมาตรรด/ต้น (ลิตร)', 'حجم السقي/شجرة (لتر)');
    if (v === 'soil') return tt('מים לדונם (ליטר)', 'น้ำ/ไร่ (ลิตร)', 'ماء/دونم (لتر)');
    if (v === 'drench_irr') return tt('מים לדונם בהזרקה (ליטר, לא חובה)', 'น้ำ/ไร่ (ลิตร)', 'ماء/دونم (لتر)');
    if (v === 'general') return tt('נפח לעץ (ליטר, אם יש)', 'ปริมาตร/ต้น (ถ้ามี)', 'حجم/شجرة (إن وجد)');
    return tt('תמיסה לעץ (סמ"ק)', 'สารละลาย/ต้น (ซีซี)', 'محلول/شجرة (سم³)');
  }

  var S = null;                  // season document
  var year = String(new Date().getFullYear());
  var _listening = {};
  var _lastSaved = '';
  var A = {};                    // { planId: { farmId: { by, at, sig } } } for `year`
  var _aLastSaved = '';
  var _openPlan = null;          // plan id being edited
  var _rowFilter = { pid: null, q: '' };   // name filter for the open plan's rows (display only)
  // Which farm groups of the open plan are unfolded: { '<planId>|<farmId>': true }.
  // Remembered per device so a plan reopens the way it was left.
  var _grpOpen = (function () { try { return JSON.parse(localStorage.getItem('ap-grp-open') || '{}') || {}; } catch (e) { return {}; } })();
  function _grpSave() { try { localStorage.setItem('ap-grp-open', JSON.stringify(_grpOpen)); } catch (e) {} }

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
  var _uidLast = 0;
  // Strictly increasing: the pickers create dozens of rows in the same
  // millisecond, and Date.now() + random(1000) could repeat.
  function uid() {
    var t = Date.now();
    _uidLast = t > _uidLast ? t : _uidLast + 1;
    return _uidLast;
  }
  function key() { return KEY_PREFIX + year; }
  function isManager() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }
  function isAdmin() {
    return (window.currentUser || {}).role === 'admin';
  }
  function me() {
    return String((window.currentUser || {}).username || '').toLowerCase();
  }
  // Plans written before createdBy was stamped carry '' and stay admin-only:
  // there is no honest way to guess an author, and guessing wrong hands one
  // manager's sheet to another.
  function ownsPlan(p) {
    var who = String((p && p.createdBy) || '').toLowerCase();
    return !!who && !!me() && who === me();
  }
  function canEdit(p) {
    return isManager() && (isAdmin() || ownsPlan(p));
  }
  function denied() {
    toast('\u26d4 ' + tt('רק מי שיצר את התוכנית או מנהל מערכת יכול לשנות אותה',
                         'เฉพาะผู้สร้างแผนหรือผู้ดูแลระบบเท่านั้นที่แก้ไขได้',
                         'التعديل متاح لمن أنشأ الخطة أو لمدير النظام فقط'));
  }
  // Every mutator goes through here. An un-guarded mutator is reachable from
  // the console and from a read-only screen left open when a plan changed
  // hands, so the check belongs at the mutation, not only in the markup.
  function editable(pid) {
    var p = planById(pid);
    if (!p) return null;
    if (!canEdit(p)) { denied(); return null; }
    return p;
  }
  function ownerLabel(p) {
    var who = String((p && p.createdBy) || '');
    return who ? who : tt('לא ידוע', 'ไม่ทราบ', 'غير معروف');
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
    return hit || tt('ללא משק', 'ไม่มีฟาร์ม', 'بدون مزرعة');
  }
  function plotById(id) {
    var hit = null;
    plots().forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }
  // Known pesticide names, for the datalist. Free text still wins - a plan
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
    var mode = (m.mode === 'cc' || m.mode === 'lu') ? m.mode : 'pct';
    var out = {
      name: String(m.name || ''),
      mode: mode,
      value: Number(m.value) || 0,          // percent when pct, cc (or g) per tree when cc
      price: Number(m.price) || 0           // ₪ per litre (or per kg), for costing
    };
    // Powders / granules: quantities are kg (shown as kg or g). The key is
    // written only when it is not litres, so plans saved before units
    // existed keep the same approval signature.
    if (m.unit === 'kg' || m.unit === 'g') out.unit = m.unit;
    return out;
  }

  // ── Units (liquid L / solid kg·g) ──
  // A product is one or the other, so the unit is looked up by name: this
  // plan first, then any plan this season, then the catalogue (a registered
  // concentration "… גרם/ק"ג" or "%" of a WP/WG/GR formulation means solid).
  function catalogueSolid(name) {
    var nm = String(name || '').trim();
    if (!nm) return false;
    var all = (window.SprayStore && SprayStore.getPesticides) ? SprayStore.getPesticides() : [];
    return all.some(function (x) {
      if (String(x.productName || '').trim() !== nm) return false;
      var t = String(x.concentration || '') + ' ' + String(x.formulation || '') + ' ' + String(x.productName || '');
      return /ק["״']?ג|\bWP\b|\bWG\b|\bGR\b|\bDP\b|\bSG\b|אבקה|גרגר/i.test(t);
    });
  }
  function U(name, p) {
    var nm = String(name || ''), hit = null;
    var look = function (pl) {
      (pl && pl.rows || []).forEach(function (r) { (r.materials || []).forEach(function (m) { if (!hit && m.name === nm && m.unit) hit = m.unit; }); });
    };
    if (p) look(p);
    if (!hit) (S && S.plans || []).forEach(look);
    if (!hit && catalogueSolid(nm)) hit = 'kg';
    return hit || 'L';
  }
  function unitWord(u) { return u === 'kg' ? tt('ק״ג', 'กก.', 'كغ') : u === 'g' ? tt('גרם', 'กรัม', 'غرام') : tt('ליטר', 'ลิตร', 'لتر'); }
  function unitShort(u) { return u === 'kg' ? 'kg' : u === 'g' ? 'g' : 'L'; }
  // q is litres for liquids, kg for solids.
  function qtyNum(q, u) { return u === 'g' ? Math.round((Number(q) || 0) * 1000) : n1(q); }
  function fmtQty(q, u) { return qtyNum(q, u).toLocaleString() + ' ' + unitWord(u); }
  // Per-tank / per-bucket amounts: below 1 L or 1 kg, in cc or grams.
  function fmtSmall(q, u) {
    q = Number(q) || 0;
    if (u === 'L' && q < 1) return Math.round(q * 1000).toLocaleString() + ' ' + tt('סמ"ק', 'ซีซี', 'سم³');
    if (u === 'kg' && q < 1) return Math.round(q * 1000).toLocaleString() + ' ' + tt('גרם', 'กรัม', 'غرام');
    return fmtQty(q, u);
  }
  function fmtQtyS(q, u) { return qtyNum(q, u) + unitShort(u); }
  function perTreeWord(u) { return (u === 'kg' || u === 'g') ? tt('גרם/עץ', 'กรัม/ต้น', 'غرام/شجرة') : tt('סמ"ק/עץ', 'ซีซี/ต้น', 'سم³/شجرة'); }
  function doseText(m, p, method) {
    if (m.mode === 'pct') return m.value + '%';
    if (m.mode === 'lu') return m.value + ' ' + unitWord(U(m.name, p)) + '/' + (isDunam(method) ? tt('דונם', 'ไร่', 'دونم') : tt('עץ', 'ต้น', 'شجرة'));
    return m.value + ' ' + perUnitWord(U(m.name, p), method);
  }
  function perUnitWord(u, method) {
    if (!isDunam(method)) return perTreeWord(u);
    return (u === 'kg' || u === 'g') ? tt('גרם/דונם', 'กรัม/ไร่', 'غرام/دونم') : tt('סמ"ק/דונם', 'ซีซี/ไร่', 'سم³/دونم');
  }
  function priceWord(u) { return (u === 'kg' || u === 'g') ? tt('לק״ג', 'ต่อกก.', 'لكل كغ') : tt('לליטר', 'ต่อลิตร', 'لكل لتر'); }

  // ── Deadlines ──
  // Stored as yyyy-mm-dd (what <input type=date> speaks), shown dd/mm/yyyy.
  // A row's own date wins; an empty one falls back to the plan's.
  function isoDate(v) { var t = String(v || ''); return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : ''; }
  function fmtDate(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? m[3] + '/' + m[2] + '/' + m[1] : '';
  }
  function effDeadline(p, r) { return (r && r.deadline) || (p && p.deadline) || ''; }
  function daysLeft(iso) {
    if (!iso) return null;
    var d = new Date(iso + 'T00:00:00'), n = new Date();
    n.setHours(0, 0, 0, 0);
    return Math.round((d - n) / 86400000);
  }
  function dlChip(iso, inherited) {
    if (!iso) return '';
    var d = daysLeft(iso);
    var cls = d < 0 ? 'late' : (d <= 7 ? 'soon' : 'ok');
    var tail = d < 0 ? ' · ' + tt('באיחור', 'เลยกำหนด', 'متأخر') :
               d === 0 ? ' · ' + tt('היום', 'วันนี้', 'اليوم') :
               d <= 7 ? ' · ' + d + ' ' + tt('ימים', 'วัน', 'أيام') : '';
    return '<span class="ap-dl ' + cls + '" title="' +
      (inherited ? tt('לפי תאריך התוכנית', 'ตามแผน', 'حسب الخطة') : tt('תאריך ייעודי לשורה', 'เฉพาะแถว', 'خاص بالصف')) + '">⏰ ' +
      tt('סיום עד', 'เสร็จภายใน', 'الإنهاء حتى') + ' ' + fmtDate(iso) + tail + '</span>';
  }
  // Earliest effective deadline across rows - what a supplier has to beat.
  function earliestDeadline(p, rows) {
    var best = '';
    (rows || []).forEach(function (r) {
      var d = effDeadline(p, r);
      if (d && (!best || d < best)) best = d;
    });
    return best;
  }
  var METHOD_COLOR = { spray: ['#1565c0', '#e3f2fd'], drench: ['#8d5524', '#f6ece3'], inject: ['#7b1fa2', '#f3e5f5'], general: ['#546e7a', '#eceff1'], soil: ['#ef6c00', '#fff3e0'] };
  function mColor(m) { return METHOD_COLOR[m] || METHOD_COLOR.spray; }

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
      timing: String(r.timing || ''),        // מועד מומלץ (free text - 'סיום גדיד')
      deadline: isoDate(r.deadline),         // תאריך סיום הכרחי; '' = the plan's
      start: isoDate(r.start),               // מועד התחלה מומלץ (date)
      container: Number(r.container) || 0,   // manual drench: bucket / container size, litres
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
      deadline: isoDate(p.deadline),         // תאריך סיום הכרחי for every row without its own
      notes: String(p.notes || ''),
      prep: String(p.prep || ''),           // דגשים לביצוע והכנות - printed, shown to the crew
      zones: normZones(p.zones),            // spray diagram: parts of the tree and share of the volume
      createdAt: Number(p.createdAt) || Date.now(),
      createdBy: String(p.createdBy || ''),
      // Printed heading, separate from the internal plan name: the sheet a
      // grower receives is titled for him, not for our project list.
      docTitle: String(p.docTitle || ''),
      docSub: String(p.docSub || ''),
      // A short line per מטע, printed on that farm's section. Managers need
      // to attach a local caveat ("start after the north block is picked")
      // without it applying to every other farm in the plan.
      farmNotes: (p.farmNotes && typeof p.farmNotes === 'object') ? p.farmNotes : {},
      // Reuses the spray log's palette so plans and logs look like one
      // family of documents. ReportTheme.resolve() reads .report_theme off
      // any object, so a plan can carry a theme without being a farm.
      report_theme: (p.report_theme && typeof p.report_theme === 'object') ? p.report_theme : {},
      // { farmId: { by, at, sig } }, attached from the approvals document
      // by attach(). Never read from the plan document: operators write that.
      approvals: {},
      // { farmId: true } - once a farm is approved, whether this plan is
      // printed in that farm's spray log (יומן ריסוסים). Not signed: turning
      // it on or off does not send the farm back for approval.
      inLog: (p.inLog && typeof p.inLog === 'object') ? p.inLog : {},
      rows: Array.isArray(p.rows) ? p.rows.map(normRow) : []
    };
  }

  // ── Approval (per farm) ──
  function normApprovals(a) {
    var out = {};
    if (a && typeof a === 'object') {
      Object.keys(a).forEach(function (k) {
        var v = a[k];
        if (v && typeof v === 'object' && v.sig) {
          out[String(k)] = { by: String(v.by || ''), at: Number(v.at) || 0, sig: String(v.sig) };
        }
      });
    }
    return out;
  }
  function normApprovalDoc(d) {
    var out = {}, src = (d && d.plans && typeof d.plans === 'object') ? d.plans : {};
    Object.keys(src).forEach(function (pid) {
      var m = normApprovals(src[pid]);
      if (Object.keys(m).length) out[String(pid)] = m;
    });
    return out;
  }
  function attach(s, a) {
    (s.plans || []).forEach(function (p) {
      p.approvals = JSON.parse(JSON.stringify((a || {})[String(p.id)] || {}));
    });
    return s;
  }
  // Key order is canonicalised: Firestore does not preserve map key order,
  // so a row could come back with its keys reordered and void a valid approval.
  function stable(v) {
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if (v && typeof v === 'object') {
      return '{' + Object.keys(v).sort().map(function (k) {
        return JSON.stringify(k) + ':' + stable(v[k]);
      }).join(',') + '}';
    }
    return JSON.stringify(v === undefined ? null : v);
  }
  function hash(s) {
    var h = 0x811c9dc5;                      // FNV-1a, 32 bit
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16) + '.' + s.length;
  }
  function farmRows(p, fid) {
    fid = Number(fid);
    return (p.rows || []).filter(function (r) { return r.farmId === fid; });
  }
  function farmSig(p, fid) {
    var o = {
      name: p.name, target: p.target, deadline: p.deadline, notes: p.notes,
      farmNote: String(((p.farmNotes || {})[String(fid)]) || '').trim(),
      rows: farmRows(p, fid).map(normRow)
    };
    // The crew executes the preparation notes too, so they are signed - but
    // only once written, so plans approved before the field existed stay approved.
    if (String(p.prep || '').trim()) o.prep = String(p.prep).trim();
    if (p.zones && p.zones.on) o.zones = { img: p.zones.img || '', parts: p.zones.parts };
    return hash(stable(o));
  }
  // Farms the plan currently covers, in first-appearance order.
  function planFarms(p) {
    var seen = {}, out = [];
    (p.rows || []).forEach(function (r) {
      if (r.farmId && !seen[r.farmId]) { seen[r.farmId] = true; out.push(r.farmId); }
    });
    return out;
  }
  // 'approved' | 'stale' (edited after approval) | 'draft'
  function farmState(p, fid) {
    var a = p && p.approvals && p.approvals[String(fid)];
    if (!a || !a.sig) return 'draft';
    return (farmRows(p, fid).length && a.sig === farmSig(p, fid)) ? 'approved' : 'stale';
  }
  function planSummary(p) {
    var s = { total: 0, approved: 0, stale: 0, draft: 0 };
    planFarms(p).forEach(function (fid) { s.total++; s[farmState(p, fid)]++; });
    return s;
  }
  // Legacy name kept for callers outside: 'approved' only when every farm is.
  function approvalState(p) {
    var s = planSummary(p);
    if (s.total && s.approved === s.total) return 'approved';
    if (s.approved || s.stale) return 'partial';
    return 'draft';
  }
  function farmBadge(p, fid) {
    var st = farmState(p, fid);
    if (st === 'approved') return '<span class="ap-st ok">✅ ' + tt('מאושר לביצוע', 'อนุมัติแล้ว', 'معتمد للتنفيذ') + '</span>';
    if (st === 'stale') return '<span class="ap-st stale">⚠️ ' + tt('שונה אחרי אישור', 'แก้ไขหลังอนุมัติ', 'عُدّل بعد الاعتماد') + '</span>';
    return '<span class="ap-st draft">📝 ' + tt('ממתין לאישור', 'รออนุมัติ', 'بانتظار الاعتماد') + '</span>';
  }
  function approvalBadge(p) {
    var s = planSummary(p), out = '';
    if (s.total && s.approved === s.total) {
      return '<span class="ap-st ok">✅ ' + tt('מאושרת לביצוע', 'อนุมัติแล้ว', 'معتمدة للتنفيذ') + '</span>';
    }
    if (s.approved) out += '<span class="ap-st ok">✅ ' + s.approved + '/' + s.total + ' ' + tt('משקים מאושרים', 'ฟาร์มอนุมัติแล้ว', 'مزارع معتمدة') + '</span> ';
    if (s.stale) out += '<span class="ap-st stale">⚠️ ' + s.stale + ' ' + tt('שונו אחרי אישור', 'แก้ไขหลังอนุมัติ', 'عُدّلت بعد الاعتماد') + '</span> ';
    if (!s.approved && !s.stale) out = '<span class="ap-st draft">📝 ' + tt('ממתינה לאישור', 'รออนุมัติ', 'بانتظار الاعتماد') + '</span>';
    return out;
  }

  function normalise(d) {
    var s = (d && typeof d === 'object') ? d : {};
    var out = blankSeason();
    if (Array.isArray(s.plans)) out.plans = s.plans.map(normPlan);
    return out;
  }

  function load() {
    var y = year;
    return Promise.all([DB.loadAsync(KEY_PREFIX + y), DB.loadAsync(APPROVALS_PREFIX + y)]).then(function (r) {
      A = normApprovalDoc(r[1]);
      return attach(normalise(r[0]), A);
    });
  }

  function listen() {
    if (_listening[year]) return;
    _listening[year] = true;
    // Listeners stay registered for every season opened this session; a
    // change to a season no longer on screen must not replace the one that is.
    var y = year;
    DB.listen(KEY_PREFIX + y, function (d) {
      if (y !== year) return;
      if (JSON.stringify(d) === _lastSaved) return;   // our own write echoing back
      S = attach(normalise(d), A);
      if (isOpen()) repaint();
    });
    DB.listen(APPROVALS_PREFIX + y, function (d) {
      if (y !== year) return;
      if (JSON.stringify(d) === _aLastSaved) return;
      A = normApprovalDoc(d);
      if (S) attach(S, A);
      if (isOpen()) repaint();
    });
  }

  function save() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    // Firestore rejects undefined; round-trip strips it and any accidental
    // function/DOM reference that crept onto a row.
    var clean = JSON.parse(JSON.stringify(S));
    (clean.plans || []).forEach(function (p) { delete p.approvals; });   // they have their own document
    _lastSaved = JSON.stringify(clean);
    DB.save(key(), clean);
  }
  // Admin only - the rules reject anyone else. Rebuilt from the plans in
  // memory, so approvals of deleted plans and departed farms drop out.
  function saveApprovals() {
    if (!isAdmin() || !S) return;
    var out = {};
    (S.plans || []).forEach(function (p) {
      prune(p);
      if (p.approvals && Object.keys(p.approvals).length) out[String(p.id)] = p.approvals;
    });
    A = JSON.parse(JSON.stringify(out));
    var doc = { year: year, plans: A };
    _aLastSaved = JSON.stringify(doc);
    DB.save(APPROVALS_PREFIX + year, doc);
  }

  // ══════════════════════════════════════════════════════════════════
  //  THE ENGINE - the whole point of the module
  // ══════════════════════════════════════════════════════════════════

  // Litres of neat material a single row consumes. Unrounded on purpose.
  function rowMaterialL(row, mat) {
    var trees = Number(row.trees) || 0;
    if (mat.mode === 'pct') {
      return trees * (Number(row.carrier) || 0) * (Number(mat.value) || 0) / 100;
    }
    if (mat.mode === 'lu') return trees * (Number(mat.value) || 0);   // litres / kg per unit (dunam or tree)
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
  // ── Operations ──
  // An operation is method + round: "ריסוס · 1", "הגמעה ידנית · 1". One plot
  // can carry several - the spray AND a drench in the same season - so
  // everything that adds rows or materials names the operation it targets
  // instead of assuming every row of a farm is the same job.
  function opKey(method, round) { return String(method || 'spray') + '|' + String(round || '').trim(); }
  function opLabel(method, round) {
    var rd = String(round || '').trim();
    return methodLabel(method) + (rd ? ' · ' + rd : '');
  }
  function planOps(p) {
    var seen = {}, out = [];
    (p.rows || []).forEach(function (r) {
      var k = opKey(r.method, r.round);
      if (!seen[k]) {
        seen[k] = { key: k, method: r.method, round: String(r.round || '').trim(), sample: r, count: 0 };
        out.push(seen[k]);
      }
      seen[k].count++;
    });
    return out;
  }
  function opByKey(p, key) {
    var hit = null;
    planOps(p).forEach(function (o) { if (o.key === key) hit = o; });
    return hit;
  }
  function cloneMats(r) {
    return ((r && r.materials) || []).map(function (m) {
      return { name: m.name, mode: m.mode, value: m.value, price: m.price };
    });
  }
  function defaultMode(method) {
    var d = 'pct';
    METHODS.forEach(function (m) { if (m.v === method) d = m.def; });
    return d;
  }

  // The farm's own crop, not a generic tree: dates 🌴, vines 🍇, olives 🫒,
  // citrus 🍊, mango 🥭, avocado 🥑, field crops 🌾, vegetables 🥬.
  function farmIco(fid) {
    var cnt = {};
    plots().forEach(function (pl) { if (Number(pl.farm_id) !== Number(fid)) return; var c = String(pl.crop_type || ''); cnt[c] = (cnt[c] || 0) + (Number(pl.area) || 1); });
    var top = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0] || '';
    if (/תמר/.test(top)) return '🌴';
    if (/גפן|ענב/.test(top)) return '🍇';
    if (/זית/.test(top)) return '🫒';
    if (/הדר|תפוז|לימון|אשכולית|קלמנטינ|מנדרינ/.test(top)) return '🍊';
    if (/מנגו/.test(top)) return '🥭';
    if (/אבוקדו/.test(top)) return '🥑';
    if (/חיט|שעור|תירס|תלתן|חמני|כותנה|גידולי שדה/.test(top)) return '🌾';
    if (/עגבני|מלפפון|בצל|אבטיח|מלון|פלפל|תפוח אדמה|ירק|חסה|גזר/.test(top)) return '🥬';
    return '🌱';
  }
  function treeKey(r) { return (r.plotId ? 'p' + r.plotId : 'f' + (r.farmId || 0)) + '|' + String(r.cohort || ''); }
  // "ריסוס: 9,613 עצים · 144,195 ל' | הגמעה ידנית: 9,613 עצים · 9,613 ל'"
  function opsLine(t, sep) {
    return (t.ops || []).map(function (o) {
      return '<span style="white-space:nowrap;">' + esc(opLabel(o.method, o.round)) + ': ' + Math.round(o.qty).toLocaleString() + ' ' + qtyWord(o.method) +
        (o.water > 0 ? ' · ' + n1(o.water).toLocaleString() + ' ' + tt('ל\' תמיסה', 'ล. สารละลาย', 'ل محلول') : '') + '</span>';
    }).join(sep || ' | ');
  }
  function treesText(t) {
    return t.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + (t.dunam ? ' · ' + n1(t.dunam).toLocaleString() + ' ' + tt('דונם', 'ไร่', 'دونم') : '');
  }
  function totals(plan) {
    var byMat = {}, byFarm = {}, farmMat = {}, farmOps = {}, price = {};
    var waterL = 0, uT = {}, uD = {}, byOp = {}, opOrder = [];
    (plan.rows || []).forEach(function (r) {
      // A tree that is sprayed AND drenched is still one tree: count each
      // plot (+ sub-group) once, and give each operation its own count and
      // solution volume.
      var tk = treeKey(r), q = Number(r.trees) || 0;
      if (isDunam(r.method)) uD[tk] = Math.max(uD[tk] || 0, q); else uT[tk] = Math.max(uT[tk] || 0, q);
      var opk = opKey(r.method, r.round);
      if (!byOp[opk]) { byOp[opk] = { method: r.method, round: String(r.round || '').trim(), qty: 0, water: 0 }; opOrder.push(opk); }
      byOp[opk].qty += q; byOp[opk].water += rowCarrierL(r);
      waterL += rowCarrierL(r);
      var fid = (r.farmId === null || r.farmId === undefined) ? 0 : r.farmId;
      if (!byFarm[fid]) byFarm[fid] = 0;
      if (!farmMat[fid]) farmMat[fid] = {};
      if (!farmOps[fid]) farmOps[fid] = {};
      var ok = opKey(r.method, r.round);
      if (!farmOps[fid][ok]) farmOps[fid][ok] = { method: r.method, round: String(r.round || '').trim(), mats: {}, container: 0 };
      if (r.container > 0) farmOps[fid][ok].container = r.container;
      (r.materials || []).forEach(function (m) {
        if (!m.name) return;
        var litres = rowMaterialL(r, m);
        byMat[m.name] = (byMat[m.name] || 0) + litres;
        farmMat[fid][m.name] = (farmMat[fid][m.name] || 0) + litres;
        farmOps[fid][ok].mats[m.name] = (farmOps[fid][ok].mats[m.name] || 0) + litres;
        byFarm[fid] += litres;
        // Last non-zero price entered for a material wins - one product has
        // one price across the plan, so a price typed on any row applies.
        if (m.price > 0) price[m.name] = m.price;
      });
    });
    var cost = 0, unpriced = [];
    Object.keys(byMat).forEach(function (nm) {
      if (price[nm]) cost += byMat[nm] * price[nm];
      else unpriced.push(nm);
    });
    var trees = 0, dunam = 0;
    Object.keys(uT).forEach(function (k) { trees += uT[k]; });
    Object.keys(uD).forEach(function (k) { dunam += uD[k]; });
    return {
      ops: opOrder.map(function (k) { return byOp[k]; }),
      byMat: byMat, byFarm: byFarm, farmMat: farmMat, farmOps: farmOps, price: price,
      cost: cost, unpriced: unpriced, waterL: waterL, trees: trees, dunam: dunam
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI
  // ══════════════════════════════════════════════════════════════════

  function isOpen() { return !!document.getElementById('apRoot'); }
  // New language: repaint whatever screen of the module is open.
  document.addEventListener('shorashim:lang', function () {
    if (!isOpen() || !S) return;
    var a = document.activeElement;
    if (a && a.closest && a.closest('#apRoot') && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) return;
    if (_openPlan) showPlan(_openPlan); else renderList();
  });
  function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }
  // Repainting replaces innerHTML wholesale, which resets the scroll box to
  // the top - so adding a material on row 20 threw the user back to row 1.
  // Carry scrollTop (and the focused field) across the repaint instead.
  // ── Name filter ──
  // "תמרים, ייטב" shows both: comma-separated terms, any one may match.
  // Spaces, quote marks (" ' ״ ׳) and niqqud are ignored, so 'תמרים 23',
  // 'תמרים23' and 'תמרים-23' all find the same plot.
  function normName(v) {
    return String(v == null ? '' : v).toLowerCase()
      .replace(/[\u0591-\u05C7]/g, '')
      .replace(/["'`\u05f3\u05f4\u2019\u201d\s\-_.]/g, '');
  }
  function filterTerms(q) {
    return String(q || '').split(/[,\u060c]/).map(normName).filter(function (t) { return t; });
  }
  function matchesAny(terms, texts) {
    if (!terms.length) return true;
    var hay = texts.map(normName);
    return terms.some(function (t) {
      return hay.some(function (h) { return h.indexOf(t) >= 0; });
    });
  }

  function paint(html) {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    var prev = document.querySelector('.ap-back');
    var top = prev ? prev.scrollTop : 0;
    var act = document.activeElement;
    var key = (act && act.dataset && act.dataset.k) ? act.dataset.k : null;
    var caret = (act && act.selectionStart != null) ? act.selectionStart : null;
    m.innerHTML = html;
    var next = document.querySelector('.ap-back');
    if (next && top) next.scrollTop = top;
    if (key) {
      var back = document.querySelector('[data-k="' + key + '"]');
      if (back) {
        back.focus();
        if (caret != null && back.setSelectionRange) {
          try { back.setSelectionRange(caret, caret); } catch (e) {}
        }
      }
    }
  }
  function repaint() {
    if (_openPlan && planById(_openPlan)) showPlan(_openPlan);
    else renderList();
  }

  function open() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    preloadQr();
    load().then(function (s) { S = s; listen(); _openPlan = null; renderList(); });
  }

  // The stylesheet lives in <head>, NOT inside the modal markup.
  // paint() replaces modalContainer.innerHTML, which would delete a
  // <style> tag rendered inside it - so the first screen was styled and
  // every screen after it lost its CSS and reflowed to the page bottom.
  function ensureCss() {
    if (document.getElementById('apCss')) return;
    var st = document.createElement('style');
    st.id = 'apCss';
    st.textContent =
      '.ap-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;overflow:auto;padding:14px;}' +
      '.ap-sheet{max-width:1100px;margin:0 auto;background:var(--surface,#fff);color:var(--text,#222);' +
        'border-radius:16px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);}' +
      '.ap-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;' +
        'padding-bottom:10px;border-bottom:2px solid var(--border,#e0e0e0);flex-wrap:wrap;}' +
      '.ap-head h3{margin:0;font-weight:800;font-size:1.05rem;}' +
      '.ap-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.ap-guides{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px;}.ap-guides .ap-btn{font-size:.8rem;}' +
      '.ap-btn{padding:9px 13px;border:none;border-radius:10px;background:var(--primary,#2d6a4f);color:#fff;' +
        'font-family:inherit;font-weight:700;font-size:.84rem;cursor:pointer;}' +
      '.ap-btn.ghost{background:var(--surface-glass,#eef1ee);color:var(--text,#333);}' +
      '.ap-btn.warn{background:#c62828;}' +
      '.ap-btn.ok{background:#2e7d32;}' +
      '.ap-btn.ap-mini{padding:4px 9px;font-size:.74rem;border-radius:8px;}' +
      '.ap-btn.ghost.ap-mini{background:var(--card-solid,#fff);border:1px solid var(--border,#dfe3df);}' +
      '.ap-st{display:inline-block;border-radius:999px;padding:2px 9px;font-size:.72rem;font-weight:700;white-space:nowrap;}' +
      '.ap-st.ok{background:#e8f5e9;color:#2e7d32;}.ap-st.stale{background:#fff3e0;color:#e65100;}' +
      '.ap-st.draft{background:#eceff1;color:#546e7a;}' +
      '.ap-apv{border-radius:12px;padding:9px 12px;margin-bottom:10px;font-size:.82rem;line-height:1.5;}' +
      '.ap-apv.ok{background:#e8f5e9;color:#1b5e20;}.ap-apv.stale{background:#fff3e0;color:#bf360c;}' +
      '.ap-apv.draft{background:#eceff1;color:#37474f;}' +
      '.ap-apv ul{margin:4px 0 0;padding-inline-start:18px;}' +
      '.ap-fc{background:var(--card-solid,#fff);border:1px solid var(--border,#dfe3df);border-inline-start:4px solid #2e7d32;' +
        'border-radius:10px;padding:9px 10px;margin-bottom:8px;font-size:.8rem;}' +
      '.ap-fc-hd{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-weight:800;font-size:.86rem;}' +
      '.ap-fc-sub{color:var(--text-muted,#888);font-size:.72rem;margin-top:2px;}' +
      '.ap-fc-op{margin-top:8px;padding-top:6px;border-top:1px dashed var(--border,#e0e0e0);}' +
      '.ap-fc-mat{display:flex;justify-content:space-between;gap:8px;padding:2px 0;}' +
      '.ap-fc-plots{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;}' +
      '.ap-fc-plot{background:var(--surface-glass,#f1f4f1);border-radius:6px;padding:2px 7px;font-size:.72rem;}' +
      '.ap-fc-pend{display:block;width:100%;text-align:start;background:none;border:1px dashed var(--border,#ccc);' +
        'border-radius:8px;padding:6px 9px;margin-bottom:6px;font-family:inherit;font-size:.76rem;cursor:pointer;color:inherit;}' +
      '.ap-card{background:var(--surface-glass,#f5f7f5);border-radius:12px;padding:12px;margin-bottom:10px;}' +
      '.ap-in{padding:7px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
        'font-size:.82rem;background:var(--surface,#fff);color:var(--text,#222);width:100%;' +
        'box-sizing:border-box;min-width:0;}' +
      '.ap-lbl{font-size:.7rem;color:var(--text-muted,#888);font-weight:700;margin-bottom:2px;}' +
      '.ap-rowgrid{display:grid;grid-template-columns:1.4fr 1fr .8fr .8fr .9fr 1fr 34px;gap:5px;align-items:end;}' +
      '.ap-mat-n{display:flex;gap:4px;min-width:0;}.ap-mat-n .ap-in{flex:1;min-width:0;}' +
      '.ap-unit{flex:none;width:62px;border:1px solid var(--line,#dde5da);border-radius:10px;background:var(--card,#fff);color:var(--text,#1b2a1f);font:inherit;font-size:.78rem;padding:0 4px;}' +
      '.ap-prep{background:var(--primary-soft,#eef7d4);border-radius:14px;padding:10px 12px;margin-top:8px;}' +
      '.ap-zone{background:#fff7ef;border-radius:14px;padding:10px 12px;margin-top:8px;}' +
      '.ap-zbody{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin-top:6px;}.ap-zfig{flex:0 1 300px;}.ap-zin{flex:1 1 220px;display:flex;flex-direction:column;gap:5px;min-width:0;}' +
      '.ap-zrow{display:flex;align-items:center;gap:6px;font-size:.82rem;}.ap-zrow span{flex:1;}.ap-zrow i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-inline-end:6px;vertical-align:-1px;}' +
      '.ap-zrow .ap-in{width:70px;margin:0;}.ap-zsum{font-weight:700;font-size:.82rem;}.ap-zsum.bad{color:#b3261e;}' +
      '.ap-ztbl{width:100%;border-collapse:collapse;font-size:.76rem;margin-top:6px;}.ap-ztbl th,.ap-ztbl td{padding:4px 6px;border-bottom:1px solid #eadfd3;text-align:start;}' +
      '.ap-tpls{background:var(--card,#fff);border-radius:12px;padding:6px;margin:4px 0 8px;display:flex;flex-direction:column;gap:4px;}' +
      '.ap-tpl{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:4px 6px;border-radius:10px;}.ap-tpl:hover{background:var(--tonal,#f3f6ef);}' +
      '.ap-tpl .ap-btn{padding:4px 9px;font-size:.74rem;}.ap-tpln{flex:1;min-width:140px;font-size:.8rem;}.ap-tpln small{display:block;color:var(--text-muted,#888);font-size:.7rem;}' +
      '.ap-bv{max-height:46vh;overflow-y:auto;border:1px solid var(--line,#e6ebe2);border-radius:12px;padding:6px 8px;margin-top:6px;}' +
      '.ap-bv-f{font-weight:700;margin:6px 0 2px;display:flex;gap:6px;align-items:center;}' +
      '.ap-bv-r{display:flex;gap:8px;align-items:center;padding:4px 18px 4px 0;font-size:.84rem;}.ap-bv-r small{color:var(--text-muted,#888);}' +
      '.ap-mat-pick{flex:none;width:34px;border:1px solid var(--line,#dde5da);border-radius:10px;background:var(--card,#fff);color:var(--primary,#1d5a2c);cursor:pointer;font-size:1rem;}' +
      '.apmp-back{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:9500;display:flex;align-items:center;justify-content:center;padding:14px;}' +
      '.apmp{background:var(--card,#fff);color:var(--text,#1b2a1f);border-radius:22px;width:100%;max-width:520px;max-height:86vh;display:flex;flex-direction:column;box-shadow:0 18px 40px rgba(0,0,0,.25);}' +
      '.apmp-h{padding:14px 16px 8px;display:flex;gap:8px;align-items:center;}.apmp-h b{flex:1;font-size:1rem;}' +
      '.apmp-h button{border:0;background:var(--tonal,#f1f4ee);border-radius:50%;width:32px;height:32px;cursor:pointer;color:inherit;}' +
      '.apmp-s{margin:0 16px 8px;width:auto !important;box-sizing:border-box;}.apmp-l{overflow-y:auto;padding:0 10px 12px;}' +
      '.apmp-i{display:block;width:100%;text-align:start;border:0;background:none;padding:9px 8px;border-bottom:1px solid var(--line,#eef1ec);cursor:pointer;color:inherit;font:inherit;}' +
      '.apmp-i:hover{background:var(--tonal,#f1f4ee);}.apmp-i b{font-size:.9rem;}.apmp-i small{display:block;color:var(--text-muted,#777);font-size:.72rem;margin-top:2px;}' +
      '.ap-mat{display:grid;grid-template-columns:1.4fr .7fr .8fr .8fr 30px;gap:5px;margin-top:4px;align-items:center;}' +
      '.ap-out{background:var(--surface,#fff);border-radius:8px;padding:6px 9px;margin-top:6px;font-size:.78rem;' +
        'font-weight:700;color:var(--primary,#2d6a4f);}' +
      '.ap-tot{display:flex;justify-content:space-between;padding:4px 0;font-size:.86rem;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.ap-empty{text-align:center;color:var(--text-muted,#999);padding:18px;font-size:.86rem;}' +
      // Plan header: bordered white card - never confused with a row.
      '.ap-plan{background:var(--card-solid,#fff);border:2px solid var(--primary,#2d6a4f);border-radius:14px;' +
        'padding:12px 14px;margin-bottom:6px;box-shadow:0 2px 10px rgba(0,0,0,.06);}' +
      '.ap-plan-hd{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-weight:800;font-size:.92rem;' +
        'color:var(--primary,#2d6a4f);margin-bottom:8px;}' +
      '.ap-plan-hd .n,.ap-grphd .n,.ap-sec .n,.ap-rowhd .n{font-weight:400;font-size:.76rem;color:var(--text-muted,#888);}' +
      '.ap-plan-grid{display:grid;grid-template-columns:1.3fr 1fr .8fr;gap:8px;}' +
      '.ap-flt{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px;}' +
      // Section rule between the plan and its rows.
      '.ap-sec{display:flex;align-items:center;gap:8px;margin:18px 2px 8px;font-weight:800;font-size:.95rem;' +
        'border-bottom:2px solid var(--border,#dfe3df);padding-bottom:5px;}' +
      // One tinted band per orchard; rows sit inside it as white cards.
      '.ap-grp{background:var(--surface-glass,#eef2ee);border-radius:14px;padding:8px 8px 1px;margin-bottom:12px;}' +
      '.ap-grphd{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px;padding:2px 6px 8px;font-weight:800;font-size:.9rem;}' +
      'details.ap-grp{border:1.5px solid var(--line,#dfe6dc);background:var(--card,#fff) !important;padding:4px 8px 1px !important;}' +
      'details.ap-grp[open]{border-color:var(--primary,#2d6a4f);}details.ap-grp[open]>summary{border-bottom:1px dashed var(--line,#dfe6dc);margin-bottom:8px;}' +
      'details.ap-grp>summary:hover{background:var(--tonal,#f3f6ef);border-radius:10px;}' +
      'details.ap-grp>summary.ap-grphd{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:6px 14px;padding:6px 6px 8px;}' +
      'details.ap-grp>summary::-webkit-details-marker{display:none;}' +
      '.ap-gname{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px 8px;flex:1 1 220px;min-width:0;}' +
      '.ap-gchev{display:inline-block;transition:transform .15s;color:var(--primary,#2d6a4f);font-size:.8rem;}details.ap-grp[open] .ap-gchev{transform:rotate(90deg);}' +
      '[dir=rtl] .ap-gchev{transform:scaleX(-1);}[dir=rtl] details.ap-grp[open] .ap-gchev{transform:rotate(90deg);}' +
      '.ap-gst{display:inline-flex;gap:6px;align-items:center;}.ap-gwarn{color:#b26a00;}' +
      '.ap-gtodo{flex:1 1 300px;display:flex;flex-direction:column;gap:3px;font-weight:500;font-size:.78rem;min-width:0;}' +
      '.ap-gop{display:flex;flex-wrap:wrap;gap:4px 6px;align-items:baseline;}' +
      '.ap-gopn{font-weight:700;color:var(--primary,#2d6a4f);white-space:nowrap;}' +
      '.ap-gm{background:var(--tonal,#eef3ea);border-radius:8px;padding:1px 7px;white-space:nowrap;}' +
      'details.ap-grp:not([open]){padding-bottom:0;}details.ap-grp:not([open])>summary{padding-bottom:6px;}' +
      '.ap-gbody{padding-top:2px;}' +
      '.ap-grpbar{display:flex;gap:6px;align-items:center;margin:0 0 8px;}.ap-grpbar .ap-btn{padding:5px 11px;font-size:.78rem;}' +
      '.ap-row{background:var(--card-solid,#fff);border:1px solid var(--border,#e0e5e0);' +
        'border-inline-start:5px solid var(--mc,#1565c0);border-radius:10px;padding:10px;margin-bottom:8px;}' +
      '.ap-rowhd{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:-2px 0 8px;font-size:.84rem;font-weight:800;}' +
      '.ap-num{background:var(--mc,#1565c0);color:#fff;border-radius:6px;padding:1px 7px;font-size:.72rem;}' +
      '.ap-op{background:var(--mcb,#e3f2fd);color:var(--mc,#1565c0);border-radius:999px;padding:2px 9px;font-size:.74rem;}' +
      '.ap-dl{border-radius:999px;padding:2px 9px;font-size:.72rem;font-weight:700;white-space:nowrap;}' +
      '.ap-dl.ok{background:#e8f5e9;color:#2e7d32;}.ap-dl.soon{background:#fff3e0;color:#e65100;}' +
      '.ap-dl.late{background:#ffebee;color:#c62828;}' +
      '.ap-row2{display:grid;grid-template-columns:1fr 1fr .8fr;gap:5px;margin-top:6px;}' +
      '.ap-sum{background:var(--card-solid,#fff);border:1px solid var(--border,#dfe3df);border-radius:12px;' +
        'padding:0 12px 10px;margin-bottom:10px;overflow:hidden;}' +
      '.ap-sum-hd{margin:0 -12px 6px;padding:8px 12px;font-weight:800;background:var(--primary,#2d6a4f);color:#fff;}' +
      '.ap-pick{border:1.5px solid var(--primary,#2d6a4f);}' +
      '@media(max-width:760px){.ap-rowgrid{grid-template-columns:1fr 1fr;}.ap-mat{grid-template-columns:1.3fr .7fr .7fr .7fr 30px;}' +
        '.ap-plan-grid,.ap-row2{grid-template-columns:1fr 1fr;}}' +
      '';
    document.head.appendChild(st);
  }

  function shell(title, bar, body) {
    ensureCss();
    return '<div class="ap-back" id="apRoot"><div class="ap-sheet">' +
      '<div class="ap-head"><div><h3>' + title + '</h3></div>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.close()">\u2715 ' +
        tt('סגור', 'ปิด', 'إغلاق') + '</button></div>' +
      '<div class="ap-bar">' + bar + '</div>' + body + '</div></div>';
  }

  // ── plan list ──
  function renderList() {
    if (!S) S = blankSeason();
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
        tt('אין תוכניות לעונה זו. תוכנית מחשבת כמויות חומר לפי מספר עצים, נפח לעץ וריכוז - ומייצרת הזמנה.',
           'ยังไม่มีแผนสำหรับฤดูกาลนี้', 'لا توجد خطط لهذا الموسم') + '</div>';
    }
    (S.plans || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .forEach(function (p) {
        var t = totals(p);
        var mats = Object.keys(t.byMat).map(function (nm) {
          return esc(nm) + ' ' + fmtQtyS(t.byMat[nm], U(nm, p));
        }).join(' \u00b7 ');
        var mine = canEdit(p);
        body += '<div class="ap-card" style="cursor:pointer;' + (mine ? '' : 'opacity:.88;') +
          '" onclick="AgriPlan.showPlan(' + p.id + ')">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<strong>' + (mine ? '' : '\ud83d\udd12 ') +
              esc(p.name || tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) + '</strong> ' + approvalBadge(p) +
            '<span style="font-size:.78rem;color:var(--text-muted,#888);">' +
              (p.target ? '\ud83d\udc1b ' + esc(p.target) + ' ' : '') +
              dlChip(earliestDeadline(p, p.rows), false) + '</span></div>' +
          '<div style="font-size:.78rem;color:var(--text-muted,#888);margin-top:4px;">' +
            (p.rows || []).length + ' ' + tt('שורות', 'แถว', 'صفوف') +
            ' \u00b7 ' + treesText(t) +
            (t.cost ? ' \u00b7 ' + money(t.cost) : '') + '</div>' +
          ((t.ops || []).length > 1 ? '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:2px;">' + opsLine(t) + '</div>' : '') +
          (mats ? '<div style="font-size:.76rem;margin-top:4px;">' + mats + '</div>' : '') +
          '<div style="font-size:.72rem;color:var(--text-muted,#999);margin-top:4px;">' +
            tt('נוצר ע"י', 'สร้างโดย', 'أنشأها') + ': ' + esc(ownerLabel(p)) +
            (mine ? '' : ' \u00b7 ' + tt('צפייה בלבד', 'ดูอย่างเดียว', 'للعرض فقط')) + '</div>' +
        '</div>';
      });

    paint(shell('\ud83c\udf3f ' + tt('תוכניות טיפול', 'แผนการดูแล', 'خطط المعالجة') + ' ' + year, bar, body));
  }

  function setYear(y) {
    year = String(y);
    load().then(function (s) { S = s; listen(); renderList(); });
  }

  function planById(id) {
    if (!S) return null;              // load() still in flight
    var hit = null;
    (S.plans || []).forEach(function (p) { if (p.id === id) hit = p; });
    return hit;
  }

  function newPlan() {
    if (!isManager()) { toast('\u26d4 ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    if (!S) S = blankSeason();
    var u = window.currentUser || {};
    var p = normPlan({ id: uid(), name: '', target: '', createdAt: Date.now(), createdBy: u.username || '' });
    S.plans.push(p);
    save();
    showPlan(p.id);
  }

  // ── Take an orchard out of a plan: delete its rows, or move them to
  // another plan of the same season (or a new one). The target plan's
  // approval for that farm is reset by the change, as with any edit.
  var _mv = null;
  function farmRowsOf(p, fid) { return (p.rows || []).filter(function (r) { return Number(r.farmId) === Number(fid); }); }
  function _farmDel(pid, fid) {
    var p = editable(pid);
    if (!p) return;
    var n = farmRowsOf(p, fid).length;
    if (!n || !confirm(tt('להוציא את', 'เอา', 'إزالة') + ' "' + farmName(fid) + '" ' + tt('מהתוכנית?', 'ออกจากแผน?', 'من الخطة؟') + '\n' +
      n + ' ' + tt('שורות יימחקו.', 'แถวจะถูกลบ', 'صفوف ستُحذف.'))) return;
    var before = JSON.parse(JSON.stringify(farmRowsOf(p, fid)));
    p.rows = (p.rows || []).filter(function (r) { return Number(r.farmId) !== Number(fid); });
    if (p.approvals) delete p.approvals[String(fid)];
    _mv = null;
    save();
    if (window.Audit && Audit.log) Audit.log('delete', 'agriplan', pid + ':farm:' + fid, { before: before });
    toast('🗑 ' + farmName(fid) + ' ' + tt('הוצא מהתוכנית', 'ถูกนำออก', 'أُزيلت من الخطة'));
    showPlan(pid);
  }
  function _farmMove(pid, fid) {
    if (!editable(pid)) return;
    _mv = (_mv && _mv.pid === pid && _mv.fid === fid) ? null : { pid: pid, fid: fid };
    showPlan(pid);
    if (_mv) setTimeout(function () { var e = document.getElementById('apMvTo'); if (e) e.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
  }
  function moveBox(p, fid) {
    var others = (S.plans || []).filter(function (x) { return x.id !== p.id && canEdit(x); });
    var n = farmRowsOf(p, fid).length;
    return '<div class="ap-card" style="background:var(--tonal,#f3f6ef);margin-bottom:8px;">' +
      '<div style="font-weight:800;margin-bottom:6px;">↪ ' + tt('העברת', 'ย้าย', 'نقل') + ' ' + esc(farmName(fid)) + ' (' + n + ' ' + tt('שורות', 'แถว', 'صفوف') + ') ' + tt('לתוכנית:', 'ไปยังแผน:', 'إلى الخطة:') + '</div>' +
      '<select class="ap-in" id="apMvTo" style="max-width:420px;">' +
        others.map(function (x) { return '<option value="' + x.id + '">' + esc((x.name || tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) + (farmRowsOf(x, fid).length ? ' - ' + tt('כבר כולל את המטע', 'มีสวนนี้แล้ว', 'تتضمن البستان') : '')) + '</option>'; }).join('') +
        '<option value="new">＋ ' + tt('תוכנית חדשה', 'แผนใหม่', 'خطة جديدة') + ': ' + esc((p.name || '') + ' - ' + farmName(fid)) + '</option>' +
      '</select>' +
      '<div style="display:flex;gap:6px;margin-top:8px;"><button class="ap-btn" data-no-back onclick="AgriPlan._farmMoveGo(' + p.id + ',' + fid + ')">↪ ' + tt('העבר', 'ย้าย', 'نقل') + '</button>' +
      '<button class="ap-btn ghost" data-no-sticky onclick="AgriPlan._farmMove(' + p.id + ',' + fid + ')">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div>' +
      '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:4px;">' + tt('המטע יוסר מהתוכנית הזו. בתוכנית היעד הוא יחכה לאישור מחדש.', 'สวนจะถูกนำออกจากแผนนี้', 'سيُزال البستان من هذه الخطة.') + '</div></div>';
  }
  function _farmMoveGo(pid, fid) {
    var p = editable(pid);
    if (!p) return;
    var v = (document.getElementById('apMvTo') || {}).value, dst;
    if (v === 'new') {
      var u = window.currentUser || {};
      dst = normPlan({ id: uid(), name: (p.name || '') + ' - ' + farmName(fid), target: p.target || '', createdAt: Date.now(), createdBy: u.username || '' });
      ['prep', 'docTitle', 'docSub', 'deadline', 'zones', 'diagram'].forEach(function (k) { if (p[k] != null) dst[k] = JSON.parse(JSON.stringify(p[k])); });
      S.plans.push(dst);
    } else {
      dst = planById(Number(v));
      if (!dst || !canEdit(dst)) { denied(); return; }
    }
    var moving = farmRowsOf(p, fid);
    if (!moving.length) return;
    dst.rows = (dst.rows || []).concat(JSON.parse(JSON.stringify(moving)));
    // the farm's own note travels with it
    if (p.farmNotes && p.farmNotes[String(fid)] != null) {
      dst.farmNotes = dst.farmNotes || {};
      if (!dst.farmNotes[String(fid)]) dst.farmNotes[String(fid)] = p.farmNotes[String(fid)];
      delete p.farmNotes[String(fid)];
    }
    if (dst.approvals) delete dst.approvals[String(fid)];
    p.rows = (p.rows || []).filter(function (r) { return Number(r.farmId) !== Number(fid); });
    if (p.approvals) delete p.approvals[String(fid)];
    _mv = null;
    save();
    if (window.Audit && Audit.log) Audit.log('update', 'agriplan', pid + ':farm:' + fid, { movedTo: dst.id, rows: moving.length });
    toast('↪ ' + farmName(fid) + ' ' + tt('הועבר אל', 'ย้ายไป', 'نُقل إلى') + ' "' + (dst.name || '-') + '"');
    showPlan(pid);
  }

  function delPlan(id) {
    var before = planById(id);
    if (!before) return;
    if (!canEdit(before)) { denied(); return; }
    if (!confirm(tt('למחוק את התוכנית?', 'ลบแผน?', 'حذف الخطة؟'))) return;
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
    if (_rowFilter.pid !== id) _rowFilter = { pid: id, q: '' };
    var ro = !canEdit(p);
    var t = totals(p);

    var matList = knownMaterials().map(function (m) {
      return '<option value="' + esc(m) + '">';
    }).join('');

    // Rows keep their real index i, so edits on a filtered view still land
    // on the right row; the filter only decides what is drawn. Rows are
    // grouped under their מטע so a long plan reads as orchards, not as one
    // undifferentiated stack of identical cards.
    var allRows = (p.rows || []).length, shown = 0;
    var terms = filterTerms(_rowFilter.q);
    var gOrder = [], groups = {};
    (p.rows || []).forEach(function (r, i) {
      var pl = r.plotId ? plotById(r.plotId) : null;
      if (!matchesAny(terms, [r.farmId ? farmName(r.farmId) : '', pl ? pl.name : '', r.cohort || '',
                              opLabel(r.method, r.round)])) return;
      var fk = String(r.farmId == null ? 0 : r.farmId);
      if (!groups[fk]) { groups[fk] = { html: '', n: 0, trees: 0, ops: [], seen: {} }; gOrder.push(fk); }
      var g = groups[fk];
      g.html += rowHtml(p, r, i, ro);
      g.n++;
      if (!isDunam(r.method)) { var tk0 = treeKey(r), q0 = Number(r.trees) || 0; if (q0 > (g.seen[tk0] || 0)) { g.trees += q0 - (g.seen[tk0] || 0); g.seen[tk0] = q0; } }
      var ol = opLabel(r.method, r.round);
      if (g.ops.indexOf(ol) < 0) g.ops.push(ol);
      shown++;
    });
    // Each farm folds into one line: name and size on one side, what that
    // farm has to do in this plan (per operation: materials and amounts) on
    // the other. One farm only, or a filter on → unfolded.
    var single = gOrder.length < 2;
    var rows = (gOrder.length > 1 ? '<div class="ap-grpbar">' +
        '<button class="ap-btn ghost" data-no-sticky data-no-back onclick="AgriPlan._grpAll(' + id + ',true)">▾ ' + tt('פתח הכל', 'เปิดทั้งหมด', 'فتح الكل') + '</button>' +
        '<button class="ap-btn ghost" data-no-sticky data-no-back onclick="AgriPlan._grpAll(' + id + ',false)">▸ ' + tt('קפל הכל', 'พับทั้งหมด', 'طي الكل') + '</button>' +
        '<span class="n">' + gOrder.length + ' ' + tt('משקים', 'ฟาร์ม', 'مزارع') + '</span></div>' : '') +
      gOrder.map(function (fk) {
      var g = groups[fk], fid = Number(fk);
      var open = single || terms.length > 0 || !!_grpOpen[id + '|' + fk];
      var ops = (t.farmOps && t.farmOps[fk]) || (t.farmOps && t.farmOps[fid]) || {};
      var todo = Object.keys(ops).map(function (k) {
        var o = ops[k];
        var mm = Object.keys(o.mats || {}).sort().map(function (nm) {
          return '<span class="ap-gm">' + esc(nm) + ' <b>' + fmtQtyS(o.mats[nm], U(nm, p)) + '</b></span>';
        }).join('');
        return mm ? '<div class="ap-gop"><span class="ap-gopn">' + esc(opLabel(o.method, o.round)) + '</span>' + mm + '</div>' : '';
      }).join('');
      var issues = farmIssues(p, fid);
      var mv = _mv && _mv.pid === id && _mv.fid === fid;
      if (mv) open = true;
      var farmTools = (!ro && fid) ? '<span class="ap-gtools">' +
        '<button class="ap-btn ghost ap-mini" data-no-sticky data-no-back title="' + esc(tt('העבר את המטע לתוכנית אחרת', 'ย้ายไปแผนอื่น', 'نقل إلى خطة أخرى')) + '" onclick="AgriPlan._farmMove(' + id + ',' + fid + ')">↪ ' + tt('העבר', 'ย้าย', 'نقل') + '</button>' +
        '<button class="ap-btn ghost ap-mini" data-no-sticky data-no-back style="color:#b3261e;" title="' + esc(tt('הוצא את המטע מהתוכנית', 'เอาออกจากแผน', 'إزالة من الخطة')) + '" onclick="AgriPlan._farmDel(' + id + ',' + fid + ')">🗑</button></span>' : '';
      var mvBox = mv ? moveBox(p, fid) : '';
      return '<details class="ap-grp"' + (open ? ' open' : '') + ' ontoggle="AgriPlan._grpToggle(' + id + ',\'' + fk + '\',this.open)">' +
        '<summary class="ap-grphd" onclick="if(event.target.closest(\'button,a,select,input,label\'))event.preventDefault();">' +
          '<div class="ap-gname"><span class="ap-gchev">▸</span>' + farmIco(fid) + ' ' + esc(farmName(fid)) +
            '<span class="n">' + (Object.keys(g.seen).length || g.n) + ' ' + tt('חלקות', 'แปลง', 'قطع') + (g.n > Object.keys(g.seen).length ? ' (' + g.n + ' ' + tt('שורות', 'แถว', 'صفوف') + ')' : '') + ' · ' +
              g.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + '</span>' +
            (issues ? '<span class="ap-gwarn" title="' + esc(tt('יש הערות לבדיקה', 'มีข้อควรตรวจ', 'توجد ملاحظات')) + '">⚠</span>' : '') +
            (fid ? '<span class="ap-gst">' + farmBadge(p, fid) + farmApproveBtn(p, fid) + logToggle(p, fid, ro) + farmTools + '</span>' : '') +
          '</div>' +
          '<div class="ap-gtodo">' + (todo || '<span class="n">' + esc(g.ops.join(', ')) + '</span>') + '</div>' +
        '</summary>' +
        '<div class="ap-gbody">' + mvBox + issues + g.html + '</div></details>';
    }).join('');
    if (!allRows) {
      rows = '<div class="ap-empty">' + tt('אין עדיין שורות. הוסף משק שלם, בחר חלקות או הוסף שורה.',
        'ยังไม่มีแถว', 'لا صفوف بعد') + '</div>';
    } else if (terms.length && !shown) {
      rows = '<div class="ap-empty">' +
        tt('אין שורות שמתאימות לסינון', 'ไม่มีแถวที่ตรงกับตัวกรอง', 'لا صفوف مطابقة للتصفية') + '</div>';
    }
    // Lives outside the read-only fieldset below, so a view-only plan can
    // be filtered too.
    var filterBar = allRows < 2 ? '' :
      '<div class="ap-flt">' +
        '<input class="ap-in" data-k="apRowFlt" type="search" style="flex:1;min-width:180px;" ' +
          'placeholder="🔍 ' + tt('סינון לפי שם משק / חלקה (אפשר כמה, מופרדים בפסיק)',
            'กรองตามชื่อฟาร์ม/แปลง (คั่นด้วยจุลภาค)', 'تصفية حسب اسم المزرعة/القطعة (افصل بفاصلة)') + '" ' +
          'value="' + esc(_rowFilter.q) + '" oninput="AgriPlan._setRowFilter(' + id + ',this.value)">' +
        (terms.length ?
          '<span style="font-size:.78rem;color:var(--text-muted,#888);white-space:nowrap;">' +
            shown + ' / ' + allRows + ' ' + tt('שורות', 'แถว', 'صفوف') + '</span>' +
          '<button class="ap-btn ghost" data-no-sticky data-no-back style="padding:5px 10px;" ' +
            'title="' + tt('נקה סינון', 'ล้างตัวกรอง', 'مسح التصفية') + '" ' +
            'onclick="AgriPlan._setRowFilter(' + id + ',\'\')">✕</button>' : '') +
      '</div>' +
      (terms.length ? '<div style="font-size:.74rem;color:var(--text-muted,#888);margin:-4px 2px 8px;">' +
        tt('הסינון משנה רק את התצוגה - הסיכומים, ההדפסה וההזמנה כוללים את כל התוכנית',
           'ตัวกรองมีผลกับการแสดงผลเท่านั้น', 'التصفية للعرض فقط') + '</div>' : '');

    var totHtml = '';
    Object.keys(t.byMat).sort().forEach(function (nm) {
      totHtml += '<div class="ap-tot"><span>' + esc(nm) + '</span><strong>' +
        fmtQty(t.byMat[nm], U(nm, p)) +
        (t.price[nm] ? ' \u00b7 ' + money(t.byMat[nm] * t.price[nm]) : '') + '</strong></div>';
    });

    // Per farm, split by operation: a drench quantity printed next to a
    // spray quantity with no label is exactly the misread this module
    // warns about at modeLabel().
    var farmHtml = '';
    Object.keys(t.farmOps).forEach(function (fid) {
      var ops = t.farmOps[fid];
      var lines = Object.keys(ops).map(function (k) {
        var o = ops[k];
        var mm = Object.keys(o.mats).sort().map(function (nm) {
          return esc(nm) + ' ' + fmtQtyS(o.mats[nm], U(nm, p));
        }).join(' · ');
        if (!mm) return '';
        return '<div style="font-size:.8rem;margin-top:2px;"><b>' + esc(opLabel(o.method, o.round)) + '</b> ' +
          ': ' + mm + '</div>';
      }).join('');
      if (!lines) return;
      farmHtml += '<div class="ap-tot" style="display:block;">' +
        '<div>' + farmIco(Number(fid)) + ' ' + esc(farmName(Number(fid))) + '</div>' + lines +
        '<input class="ap-in" data-k="fn' + fid + '" style="margin-top:4px;font-size:.76rem;" ' +
          'placeholder="' + tt('הערה למשק זה (תודפס)', 'หมายเหตุฟาร์มนี้', 'ملاحظة لهذه المزرعة') + '" ' +
          'value="' + esc((p.farmNotes || {})[String(fid)] || '') + '" ' +
          'oninput="AgriPlan._setFarmNote(' + id + ',' + fid + ',this.value)">' +
        '</div>';
    });

    var body =
      (ro ? '<div class="ap-card" style="background:#fff8e1;color:#8d6e00;font-size:.8rem;font-weight:700;">' +
              '🔒 ' + tt('צפייה בלבד - התוכנית נוצרה ע"י ',
                         'ดูอย่างเดียว - แผนสร้างโดย ',
                         'للعرض فقط - أنشأها ') + esc(ownerLabel(p)) +
            '</div>' : '') +
      approvalPanel(p) +
      // The plan's own details: one bordered card, visibly not a row.
      '<div class="ap-plan">' +
        '<div class="ap-plan-hd">📋 ' + tt('פרטי התוכנית', 'รายละเอียดแผน', 'تفاصيل الخطة') +
          '<span class="n">' + allRows + ' ' + tt('שורות', 'แถว', 'صفوف') + ' · ' +
            treesText(t) + '</span>' +
          (p.deadline ? dlChip(p.deadline, false) : '') +
          ((t.ops || []).length > 1 ? '<div class="n" style="flex-basis:100%;font-weight:400;">' + opsLine(t) + '</div>' : '') + '</div>' +
        '<div class="ap-plan-grid">' +
          '<div><div class="ap-lbl">' + tt('שם התוכנית', 'ชื่อแผน', 'اسم الخطة') + '</div>' +
            '<input class="ap-in" value="' + esc(p.name) + '" ' +
            'oninput="AgriPlan._setPlan(' + id + ',\'name\',this.value)"></div>' +
          '<div><div class="ap-lbl">' + tt('מזיק / מטרה', 'ศัตรูพืช', 'الآفة') + '</div>' +
            '<input class="ap-in" value="' + esc(p.target) + '" ' +
            'oninput="AgriPlan._setPlan(' + id + ',\'target\',this.value)"></div>' +
          '<div><div class="ap-lbl">⏰ ' + tt('תאריך סיום הכרחי', 'กำหนดเสร็จ', 'تاريخ الإنهاء الإلزامي') + '</div>' +
            '<input class="ap-in" type="date" value="' + esc(p.deadline || '') + '" ' +
            'onchange="AgriPlan._setDeadline(' + id + ',this.value)"></div>' +
        '</div>' +
        '<div class="ap-lbl" style="margin-top:8px;">' + tt('הערות', 'หมายเหตุ', 'ملاحظات') + '</div>' +
        '<textarea class="ap-in" rows="2" ' +
          'oninput="AgriPlan._setPlan(' + id + ',\'notes\',this.value)">' + esc(p.notes) + '</textarea>' +
        '<div class="ap-prep"><div class="ap-lbl" style="display:flex;justify-content:space-between;align-items:center;gap:6px;">' +
          '<b>🧰 ' + tt('דגשים לביצוע והכנות לריסוס', 'ข้อควรปฏิบัติและการเตรียม', 'إرشادات التنفيذ والتحضير') + '</b>' +
          (ro ? '' : '<span style="display:inline-flex;gap:4px;">' +
            '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back style="padding:4px 9px;font-size:.74rem;" onclick="AgriPlan._tplToggle(' + id + ')">📑 ' + tt('תבניות', 'แม่แบบ', 'قوالب') + ' ' + (_tplOpen ? '▴' : '▾') + '</button>' +
            '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back style="padding:4px 9px;font-size:.74rem;" onclick="AgriPlan._tplSave(' + id + ')">💾 ' + tt('שמור כתבנית', 'บันทึกเป็นแม่แบบ', 'حفظ كقالب') + '</button></span>') + '</div>' +
          (!ro && _tplOpen ? tplPanel(id) : '') +
          '<textarea class="ap-in" id="apPrep" rows="4" placeholder="' + esc(tt('כיול מרסס, סדר ערבוב, pH מים, ציוד מגן, תנאי רוח וטמפ׳, זמן כניסה חוזרת…', 'การเตรียม…', 'المعايرة، ترتيب الخلط…')) + '" ' +
            (ro ? 'readonly ' : '') + 'oninput="AgriPlan._setPlan(' + id + ',\'prep\',this.value)">' + esc(p.prep || '') + '</textarea>' +
          '<div style="font-size:.7rem;color:var(--text-muted,#888);margin-top:3px;">' + tt('מודפס בראש התוכנית ומוצג לצוות בכרטיס המשק', 'พิมพ์และแสดงให้ทีม', 'يُطبع ويُعرض للطاقم') + '</div></div>' +
          zonesEditor(p, ro) +
      '</div>' +

      '<datalist id="apMats">' + matList + '</datalist>' +
      '<div class="ap-sec">🌱 ' + tt('שורות טיפול', 'แถวการดูแล', 'صفوف المعالجة') +
        '<span class="n">' + gOrder.length + ' ' + tt('משקים', 'ฟาร์ม', 'مزارع') + '</span></div>' +
      rows +

      '<div class="ap-sum">' +
        '<div class="ap-sum-hd">Σ ' + tt('סה"כ חומרים לתוכנית', 'รวมสารทั้งหมด', 'إجمالي المواد') + '</div>' +
        (totHtml || '<div class="ap-empty">' + tt('אין חומרים', 'ไม่มีสาร', 'لا مواد') + '</div>') +
        '<div class="ap-tot" style="border:none;margin-top:6px;"><span>' +
          tt('מים / תמיסה', 'น้ำ', 'ماء') + '</span><strong>' + n1(t.waterL).toLocaleString() + ' ' +
          tt('ליטר', 'ลิตร', 'لتر') + '</strong></div>' +
        '<div class="ap-tot" style="border:none;font-weight:800;font-size:1rem;"><span>' +
          tt('עלות משוערת', 'ต้นทุนโดยประมาณ', 'التكلفة التقديرية') + '</span><span>' +
          money(t.cost) + '</span></div>' +
        (t.unpriced.length ? '<div style="font-size:.75rem;color:#e65100;">⚠️ ' +
          tt('ללא מחיר', 'ไม่มีราคา', 'بدون سعر') + ': ' + esc(t.unpriced.join(', ')) + '</div>' : '') +
      '</div>' +

      (farmHtml ? '<div class="ap-sum"><div class="ap-sum-hd">🌳 ' +
        tt('פילוח לפי משק', 'แยกตามฟาร์ม', 'حسب المزرعة') + '</div>' + farmHtml + '</div>' : '');

    // One native disabled fieldset beats decorating forty inputs: it disables
    // every nested control, including ones added later, and cannot be
    // half-applied. min-width:0 keeps the inner CSS grids from blowing out.
    if (ro) {
      body = '<fieldset disabled style="border:none;padding:0;margin:0;min-width:0;">' +
             body + '</fieldset>';
    }
    // The picker host sits outside that fieldset: exporting a plan you can
    // only view must still work.
    var guideBar = window.Knowledge && Knowledge.openItem ? '<div class="ap-guides">' +
      '<button class="ap-btn ghost" onclick="Knowledge.openItem(\'g-spray-mix\')">\ud83d\udcd8 ' + tt('הכנת מיכל: סדר ערבוב', 'การเตรียมถัง: ลำดับการผสม', 'تحضير الخزان: ترتيب الخلط') + '</button>' +
      '<button class="ap-btn ghost" onclick="Knowledge.openItem(\'g-spray-cal\')">\ud83d\udcd0 ' + tt('כיול מרסס', 'ปรับเทียบเครื่องพ่น', 'معايرة الرشاش') + '</button>' +
      '<button class="ap-btn ghost" onclick="Knowledge.openItem(\'g-spray-safety\')">\ud83e\uddba ' + tt('בטיחות', 'ความปลอดภัย', 'السلامة') + '</button></div>' : '';
    body = (ro && window.Own ? Own.lockHtml({ createdBy: p.createdBy, createdByName: p.createdBy }) : '') + guideBar + filterBar + '<div id="apPicker"></div>' + body +
      (window.Comments ? Comments.block('plan:' + id, p.name || '') : '');

    var bar = ro ?
      ('<button class="ap-btn ghost" onclick="AgriPlan.printPlan(' + id + ')">\ud83d\udda8 ' +
        tt('הדפסת התוכנית', 'พิมพ์แผน', 'طباعة الخطة') + '</button>' +
       exportBtns(id) +
       '<button class="ap-btn ghost" onclick="AgriPlan.renderList()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>') :
      '<button class="ap-btn" onclick="AgriPlan.addRow(' + id + ')">\u2795 ' +
        tt('שורה', 'แถว', 'صف') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.seedFromFarm(' + id + ')">\ud83c\udf33 ' +
        tt('משק שלם', 'ทั้งฟาร์ม', 'مزرعة كاملة') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.pickPlots(' + id + ')">\u2611 ' +
        tt('בחר חלקות', 'เลือกแปลง', 'اختر القطع') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.bulkMaterial(' + id + ')">\u2697\ufe0f ' +
        tt('חומר למספר משקים', 'สารหลายฟาร์ม', 'مادة لعدة مزارع') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.bulkCarrier(' + id + ')">\ud83d\udca7 ' +
        tt('שינוי נפח לעץ', 'เปลี่ยนปริมาตร/ต้น', 'تغيير الحجم/شجرة') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.splitApp(' + id + ')">🔀 ' +
        tt('פיצול ליישומים', 'แยกวิธีใช้', 'تقسيم حسب الطريقة') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.bulkStart(' + id + ')">📅 ' +
        tt('מועד התחלה לכל מטע', 'วันเริ่มต่อสวน', 'موعد البدء لكل بستان') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.themeEditor(' + id + ')">\ud83c\udfa8 ' +
        tt('עיצוב', 'ออกแบบ', 'تصميم') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.save()">\ud83d\udcbe ' +
        tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.printPlan(' + id + ')">\ud83d\udda8 ' +
        tt('הדפסת התוכנית', 'พิมพ์แผน', 'طباعة الخطة') + '</button>' +
      exportBtns(id) +
      '<button class="ap-btn ghost" onclick="AgriPlan.toOrder(' + id + ')">\ud83d\udce6 ' +
        tt('צור הזמנה', 'สร้างใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      (function () {
        if (!isAdmin()) return '';
        var s = planSummary(p), out = '';
        if (s.total && s.approved < s.total) {
          out += '<button class="ap-btn ok" onclick="AgriPlan.approveAll(' + id + ')">\u2705 ' +
            tt('אשר את כל המשקים', 'อนุมัติทุกฟาร์ม', 'اعتماد كل المزارع') + '</button>';
        }
        if (Object.keys(p.approvals || {}).length) {
          out += '<button class="ap-btn ghost" onclick="AgriPlan.revokeAll(' + id + ')">\u21a9\ufe0f ' +
            tt('בטל את כל האישורים', 'ยกเลิกอนุมัติทั้งหมด', 'إلغاء كل الاعتمادات') + '</button>';
        }
        return out;
      })() +
      '<button class="ap-btn warn" onclick="AgriPlan.delPlan(' + id + ')">\ud83d\uddd1</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.renderList()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    paint(shell('\ud83c\udf3f ' + esc(p.name || tt('תוכנית', 'แผน', 'خطة')), bar, body));
  }

  // ── approval UI + actions ──
  var _issues = null;                      // { pid, fid|null, errors[] } from the last approve attempt
  function rowName(r) {
    var pl = r.plotId ? plotById(r.plotId) : null;
    return (r.farmId ? farmName(r.farmId) : '?') + (pl ? ' / ' + pl.name : '') +
      (r.cohort ? ' (' + r.cohort + ')' : '') + ' · ' + opLabel(r.method, r.round);
  }
  // Errors block approval: a field crew cannot execute them. Warnings are
  // shown in the confirm and the admin decides.
  function validateRows(p, rows) {
    var errors = [], warnings = [];
    if (!rows.length) errors.push(tt('אין שורות טיפול', 'ไม่มีแถว', 'لا توجد صفوف معالجة'));
    rows.forEach(function (r) {
      var who = rowName(r) + ': ';
      if (!r.farmId) errors.push(who + tt('לא נבחר משק', 'ไม่ได้เลือกฟาร์ม', 'لم يُحدَّد مزرعة'));
      if (!(Number(r.trees) > 0)) errors.push(who + tt('חסר מספר עצים', 'ไม่มีจำนวนต้น', 'عدد الأشجار مفقود'));
      var mats = (r.materials || []).filter(function (m) { return m.name; });
      if (!mats.length) errors.push(who + tt('לא הוגדר חומר', 'ไม่มีสาร', 'لم تُحدَّد مادة'));
      mats.forEach(function (m) {
        if (!(Number(m.value) > 0)) errors.push(who + esc(m.name) + ' - ' + tt('חסר ריכוז / מינון', 'ไม่มีความเข้มข้น', 'التركيز مفقود'));
        if (m.mode === 'pct' && !(Number(r.carrier) > 0)) errors.push(who + esc(m.name) + ' - ' + tt('ריכוז באחוזים בלי נפח לעץ', 'เปอร์เซ็นต์โดยไม่มีปริมาตร', 'نسبة مئوية بلا حجم للشجرة'));
      });
      if (!effDeadline(p, r)) warnings.push(who + tt('אין תאריך סיום', 'ไม่มีกำหนดเสร็จ', 'لا تاريخ إنهاء'));
    });
    return { errors: errors, warnings: warnings };
  }
  function issuesBox(errors) {
    return '<div class="ap-apv stale">⛔ <strong>' + tt('לא ניתן לאשר - יש לתקן:', 'อนุมัติไม่ได้ - ต้องแก้ไข:', 'لا يمكن الاعتماد - يجب تصحيح:') + '</strong><ul>' +
      errors.slice(0, 30).map(function (e) { return '<li>' + e + '</li>'; }).join('') +
      (errors.length > 30 ? '<li>…</li>' : '') + '</ul></div>';
  }
  function farmIssues(p, fid) {
    return (_issues && _issues.pid === p.id && _issues.fid === fid && _issues.errors.length) ? issuesBox(_issues.errors) : '';
  }
  // ── In the farm's spray log or not ──
  function logToggle(p, fid, ro) {
    if (farmState(p, fid) !== 'approved') return '';
    var on = !!(p.inLog && p.inLog[String(fid)]);
    if (ro) return on ? '<span class="ap-st ok">📒 ' + tt('ביומן הריסוס', 'ในบันทึกพ่นยา', 'في سجل الرش') + '</span>' : '';
    return '<button class="ap-btn ' + (on ? 'ok' : 'ghost') + ' ap-mini" data-no-sticky data-no-back title="' + esc(tt('האם התוכנית תודפס ביומן הריסוס של המשק', 'พิมพ์ในบันทึกพ่นยาของฟาร์ม', 'طباعة الخطة في سجل رش المزرعة')) + '" onclick="AgriPlan._logToggle(' + p.id + ',' + fid + ')">📒 ' +
      (on ? tt('כלול ביומן הריסוס ✓', 'อยู่ในบันทึก ✓', 'ضمن سجل الرش ✓') : tt('הכלל ביומן הריסוס', 'ใส่ในบันทึก', 'تضمين في سجل الرش')) + '</button>';
  }
  function _logToggle(pid, fid) {
    var p = editable(pid);
    if (!p) return;
    p.inLog = p.inLog || {};
    if (p.inLog[String(fid)]) delete p.inLog[String(fid)]; else p.inLog[String(fid)] = true;
    save();
    _log.ready = false; prepareLog();
    toast('📒 ' + farmName(fid) + ': ' + (p.inLog[String(fid)] ? tt('התוכנית תודפס ביומן הריסוס', 'จะพิมพ์ในบันทึก', 'ستُطبع في سجل الرش') : tt('התוכנית לא תודפס ביומן הריסוס', 'จะไม่พิมพ์', 'لن تُطبع في سجل الرش')));
    showPlan(pid);
  }
  // The spray log is built synchronously when its window opens (a window
  // opened after an await is blocked as a pop-up), so the approved plans it
  // prints are read ahead of time: prepareLog() fills _log, logPending()
  // tells the export to wait, logSection(farmId) returns the HTML.
  var _log = { ready: false, busy: false, byFarm: {} };
  function prepareLog() {
    if (_log.busy || !window.DB || !DB.read) return Promise.resolve();
    _log.busy = true;
    var now = new Date().getFullYear(), yrs = [now - 1, now, now + 1];
    return Promise.all(yrs.map(function (y) {
      return Promise.all([DB.read(KEY_PREFIX + y), DB.read(APPROVALS_PREFIX + y)]);
    })).then(function (res) {
      var by = {};
      res.forEach(function (r, i) {
        var pd = r[0] && r[0].data, ad = r[1] && r[1].data;
        var plans = (pd && Array.isArray(pd.plans)) ? attach({ plans: pd.plans.map(normPlan) }, normApprovalDoc(ad)).plans : [];
        plans.forEach(function (pl) {
          Object.keys(pl.inLog || {}).forEach(function (fk) {
            var fid = Number(fk);
            if (!pl.inLog[fk] || farmState(pl, fid) !== 'approved') return;
            var rows = pl.rows.filter(function (x) { return Number(x.farmId) === fid; });
            if (!rows.length) return;
            (by[fid] = by[fid] || []).push({ year: yrs[i], p: pl, rows: rows, at: (pl.approvals[String(fid)] || {}).at || 0 });
          });
        });
      });
      _log = { ready: true, busy: false, byFarm: by };
    }, function () { _log.busy = false; });
  }
  function logPending() { return !_log.ready; }
  function logSection(farmId) {
    if (!_log.ready) return '';
    var fids = farmId != null ? [Number(farmId)] : Object.keys(_log.byFarm).map(Number);
    var out = '';
    fids.forEach(function (fid) {
      (_log.byFarm[fid] || []).sort(function (a, b) { return (earliestDeadline(a.p, a.rows) || '9') < (earliestDeadline(b.p, b.rows) || '9') ? -1 : 1; }).forEach(function (it) {
        var p = it.p;
        out += '<div class="ap-log" style="margin:18px 16px 0;break-inside:avoid;page-break-inside:avoid;">' +
          '<div style="font-weight:700;font-size:.95rem;margin-bottom:4px;">🧪 ' + tt('תוכנית טיפול מאושרת', 'แผนที่อนุมัติ', 'خطة معالجة معتمدة') + ': ' + esc(p.docTitle || p.name || '-') +
            (farmId == null ? ' · ' + esc(farmName(fid)) : '') + '</div>' +
          '<div style="font-size:.74rem;color:#7a756f;margin-bottom:6px;">' + (p.target ? tt('מטרה', 'เป้าหมาย', 'الهدف') + ': ' + esc(p.target) + ' · ' : '') +
            (it.at ? tt('אושר', 'อนุมัติ', 'اعتُمد') + ' ' + new Date(it.at).toLocaleDateString('he-IL') : '') + '</div>' +
          '<table><thead><tr><th>' + tt('אופן יישום', 'วิธี', 'الطريقة') + '</th><th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th><th>' + tt('עצים / דונם', 'ต้น/ไร่', 'أشجار/دونم') + '</th>' +
            '<th>' + tt('חומרים ומינון', 'สารและอัตรา', 'المواد والجرعة') + '</th><th>' + tt('סיבוב / מועד', 'รอบ / เวลา', 'الجولة / الموعد') + '</th><th>' + tt('סיום עד', 'ภายใน', 'حتى') + '</th></tr></thead><tbody>' +
          it.rows.map(function (r) {
            var pl = r.plotId ? plotById(r.plotId) : null;
            var mats = (r.materials || []).filter(function (m) { return m && m.name; }).map(function (m) {
              return esc(m.name) + ' ' + esc(doseText(m, p, r.method)) + ' (' + fmtQty(rowMaterialL(r, m), U(m.name, p)) + ')';
            }).join('<br>');
            return '<tr><td>' + esc(methodLabel(r.method)) + '</td><td>' + esc(pl ? pl.name : tt('כלל המשק', 'ทั้งฟาร์ม', 'كل المزرعة')) + '</td>' +
              '<td>' + (Number(r.trees) || 0).toLocaleString() + ' ' + qtyWord(r.method) + '</td><td>' + (mats || '-') + '</td>' +
              '<td>' + esc([r.round, r.start ? '▶ ' + fmtDate(r.start) : '', r.timing].filter(Boolean).join(' · ') || '-') + '</td><td>' + esc(fmtDate(effDeadline(p, r)) || '-') + '</td></tr>';
          }).join('') + '</tbody></table>' +
          (String(p.prep || '').trim() ? '<div style="font-size:.74rem;white-space:pre-line;margin-top:4px;color:#4a4540;">' + esc(String(p.prep).trim().replace(/\u2014/g, '-')) + '</div>' : '') +
        '</div>';
      });
    });
    return out ? '<div style="margin-top:22px;border-top:2px solid #e6e0d8;padding-top:6px;"><div style="margin:8px 16px 0;font-weight:800;font-size:1.02rem;">' +
      tt('תוכניות טיפול מאושרות', 'แผนที่อนุมัติ', 'خطط معالجة معتمدة') + '</div>' + out + '</div>' : '';
  }

  function farmApproveBtn(p, fid) {
    if (!isAdmin()) return '';
    return farmState(p, fid) === 'approved' ?
      '<button class="ap-btn ghost ap-mini" onclick="AgriPlan.revokeFarm(' + p.id + ',' + fid + ')">↩️ ' +
        tt('בטל אישור', 'ยกเลิก', 'إلغاء') + '</button>' :
      '<button class="ap-btn ok ap-mini" onclick="AgriPlan.approveFarm(' + p.id + ',' + fid + ')">✅ ' +
        tt('אשר משק זה', 'อนุมัติฟาร์มนี้', 'اعتماد هذه المزرعة') + '</button>';
  }
  function approvalPanel(p) {
    var s = planSummary(p), html;
    var cls = (s.total && s.approved === s.total) ? 'ok' : (s.stale ? 'stale' : 'draft');
    html = '<div class="ap-apv ' + cls + '">' + approvalBadge(p) + '<br>' +
      tt('כל משק מאושר בנפרד ומוצג בכרטיס המשק רק אחרי שאושר. שינוי בשורות של משק מחזיר לאישור רק אותו; שינוי בשם, במזיק, בתאריך הכללי או בהערות מחזיר את כל המשקים.',
         'แต่ละฟาร์มอนุมัติแยกกันและแสดงในบัตรฟาร์มหลังอนุมัติเท่านั้น การแก้แถวของฟาร์มใดต้องอนุมัติฟาร์มนั้นใหม่ การแก้ข้อมูลทั่วไปต้องอนุมัติทุกฟาร์มใหม่',
         'تُعتمد كل مزرعة على حدة وتظهر في بطاقتها بعد اعتمادها فقط. تعديل صفوف مزرعة يعيدها وحدها للاعتماد؛ تعديل الاسم أو الآفة أو التاريخ العام أو الملاحظات يعيد كل البساتين.') +
      '</div>';
    if (_issues && _issues.pid === p.id && _issues.fid === null && _issues.errors.length) html += issuesBox(_issues.errors);
    return html;
  }
  function me_() { return String((window.currentUser || {}).username || ''); }
  function stamp(p, fid) {
    p.approvals = p.approvals || {};
    p.approvals[String(fid)] = { by: me_(), at: Date.now(), sig: farmSig(p, fid) };
  }
  // Approvals for farms that left the plan are dead weight - and would
  // resurrect if the farm were added back with identical rows.
  function prune(p) {
    var live = {};
    planFarms(p).forEach(function (f) { live[String(f)] = true; });
    Object.keys(p.approvals || {}).forEach(function (k) { if (!live[k]) delete p.approvals[k]; });
  }
  function warnText(w) {
    return w.length ? '\n\n⚠️ ' + w.length + ' ' + tt('שורות ללא תאריך סיום', 'แถวไม่มีกำหนด', 'صفوف بلا تاريخ') + ':\n' +
      w.slice(0, 8).join('\n') + (w.length > 8 ? '\n…' : '') : '';
  }
  function adminOnly() {
    if (isAdmin()) return true;
    toast('⛔ ' + tt('רק מנהל מערכת מאשר תוכניות', 'เฉพาะผู้ดูแลระบบ', 'لمدير النظام فقط'));
    return false;
  }
  function approveFarm(id, fid) {
    if (!adminOnly()) return;
    var p = planById(id);
    if (!p) return;
    fid = Number(fid);
    var v = validateRows(p, farmRows(p, fid));
    _issues = { pid: id, fid: fid, errors: v.errors };
    if (v.errors.length) { showPlan(id); return; }
    if (!confirm(tt('לאשר את ', 'อนุมัติ ', 'اعتماد ') + farmName(fid) +
        tt(' לביצוע? התוכנית תוצג בכרטיס המשק.', ' ? จะแสดงในบัตรฟาร์ม', ' للتنفيذ؟ ستظهر الخطة في بطاقة المزرعة.') + warnText(v.warnings))) return;
    var before = p.approvals[String(fid)] || null;
    stamp(p, fid);
    _issues = null;
    save(); saveApprovals();
    if (window.Audit && Audit.log) Audit.log('approve', 'agriplan', id + ':' + fid, { before: before, after: p.approvals[String(fid)] });
    toast('✅ ' + farmName(fid) + ' ' + tt('אושר ומוצג בכרטיס המשק', 'อนุมัติแล้ว', 'اعتُمد'));
    showPlan(id);
  }
  function approveAll(id) {
    if (!adminOnly()) return;
    var p = planById(id);
    if (!p) return;
    var v = validateRows(p, p.rows || []);
    _issues = { pid: id, fid: null, errors: v.errors };
    if (v.errors.length) { showPlan(id); return; }
    var fids = planFarms(p);
    if (!confirm(tt('לאשר את כל ', 'อนุมัติทั้ง ', 'اعتماد كل ') + fids.length +
        tt(' המשקים בתוכנית לביצוע?', ' ฟาร์ม?', ' مزارع في الخطة للتنفيذ؟') + warnText(v.warnings))) return;
    var before = JSON.parse(JSON.stringify(p.approvals || {}));
    fids.forEach(function (f) { if (farmState(p, f) !== 'approved') stamp(p, f); });
    _issues = null;
    save(); saveApprovals();
    if (window.Audit && Audit.log) Audit.log('approve', 'agriplan', String(id), { before: before, after: p.approvals });
    toast('✅ ' + tt('כל המשקים אושרו', 'อนุมัติทุกฟาร์มแล้ว', 'اعتُمدت كل المزارع'));
    showPlan(id);
  }
  function revokeFarm(id, fid) {
    if (!adminOnly()) return;
    var p = planById(id);
    fid = String(Number(fid));
    if (!p || !p.approvals || !p.approvals[fid]) return;
    if (!confirm(tt('לבטל את האישור של ', 'ยกเลิกอนุมัติ ', 'إلغاء اعتماد ') + farmName(Number(fid)) + '?')) return;
    var before = p.approvals[fid];
    delete p.approvals[fid];
    saveApprovals();
    if (window.Audit && Audit.log) Audit.log('revoke', 'agriplan', id + ':' + fid, { before: before });
    showPlan(id);
  }
  function revokeAll(id) {
    if (!adminOnly()) return;
    var p = planById(id);
    if (!p || !Object.keys(p.approvals || {}).length) return;
    if (!confirm(tt('לבטל את כל האישורים? התוכנית תוסר מכל כרטיסי המשקים.', 'ยกเลิกอนุมัติทั้งหมด?', 'إلغاء كل الاعتمادات؟'))) return;
    var before = p.approvals;
    p.approvals = {};
    saveApprovals();
    if (window.Audit && Audit.log) Audit.log('revoke', 'agriplan', String(id), { before: before });
    showPlan(id);
  }
  function openPlan(y, id) {
    if (!isManager()) return;
    year = String(y);
    load().then(function (s) { S = s; listen(); showPlan(Number(id)); });
  }

  // ── Farm card ──
  // Approved plans touching this farm, as the crew executes them: per
  // operation, the material quantities for THIS farm only and the plots in
  // it. Reads the server copy (DB.read): a cached season would show a plan
  // that was revoked an hour ago. Seasons y-1..y+1 - a plan filed under
  // last year can still be running in January.
  function farmCard(farmId, host) {
    if (!host || !window.DB || !DB.read) return;
    ensureCss();
    farmId = Number(farmId);
    var tag = String(farmId) + ':' + Date.now();
    host.setAttribute('data-ap-fc', tag);
    var title = '<div class="section-title" style="margin-top: 4px;">🧪 ' +
      tt('תוכנית ריסוס', 'แผนการพ่นยา', 'خطة الرش') + '</div>';
    host.innerHTML = title + '<div class="ap-fc-sub" style="padding:6px;">' + tt('טוען…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>';
    var now = new Date().getFullYear();
    var yrs = [now - 1, now, now + 1];
    Promise.all(yrs.map(function (y) {
      return Promise.all([DB.read(KEY_PREFIX + y), DB.read(APPROVALS_PREFIX + y)]);
    })).then(function (res) {
      if (!document.body.contains(host) || host.getAttribute('data-ap-fc') !== tag) return;
      var approved = [], pending = [];
      var cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 30);
      var cutIso = cutoff.toISOString().slice(0, 10);
      res.forEach(function (r, i) {
        var pd = r[0] && r[0].data, ad = r[1] && r[1].data;
        var plans = (pd && Array.isArray(pd.plans)) ? attach({ plans: pd.plans.map(normPlan) }, normApprovalDoc(ad)).plans : [];
        plans.forEach(function (p) {
          var rows = p.rows.filter(function (x) { return x.farmId === farmId; });
          if (!rows.length) return;
          var st = farmState(p, farmId);
          var last = '', undated = false;
          rows.forEach(function (x) { var d = effDeadline(p, x); if (!d) undated = true; else if (d > last) last = d; });
          // Finished a month ago → off the card. Undated plans live with their season.
          var done = undated ? yrs[i] < now : last < cutIso;
          if (done) return;
          var item = { year: yrs[i], p: p, rows: rows, first: earliestDeadline(p, rows) };
          if (st === 'approved') approved.push(item);
          else if (isManager()) pending.push({ year: yrs[i], p: p, st: st, fid: farmId });
        });
      });
      approved.sort(function (a, b) { return (a.first || '9999') < (b.first || '9999') ? -1 : 1; });
      var html = title;
      if (!approved.length) {
        html += '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' +
          tt('אין תוכנית ריסוס מאושרת למשק זה', 'ไม่มีแผนที่อนุมัติสำหรับฟาร์มนี้', 'لا توجد خطة رش معتمدة لهذه المزرعة') + '</div>';
      }
      approved.forEach(function (it) { html += farmPlanHtml(it, farmId); });
      pending.forEach(function (it) {
        html += '<button type="button" class="ap-fc-pend" onclick="AgriPlan.openPlan(' + it.year + ',' + it.p.id + ')">' +
          farmBadge(it.p, it.fid) + ' ' + esc(it.p.name || tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) +
          ' · ' + tt('לא מוצגת לצוות עד אישור', 'ทีมยังไม่เห็นจนกว่าจะอนุมัติ', 'لا تظهر للطاقم قبل الاعتماد') + '</button>';
      });
      host.innerHTML = html;
    });
  }
  function farmPlanHtml(it, farmId) {
    var p = it.p, a = (p.approvals || {})[String(farmId)] || {};
    var ops = {}, order = [];
    it.rows.forEach(function (r) {
      var k = opKey(r.method, r.round);
      if (!ops[k]) { ops[k] = { method: r.method, round: r.round, rows: [], mats: {}, dose: {}, water: 0, trees: 0 }; order.push(k); }
      var o = ops[k];
      o.rows.push(r);
      o.trees += Number(r.trees) || 0;
      o.water += rowCarrierL(r);
      (r.materials || []).forEach(function (m) {
        if (!m.name) return;
        o.mats[m.name] = (o.mats[m.name] || 0) + rowMaterialL(r, m);
        if (!o.dose[m.name]) o.dose[m.name] = doseText(m, p, r.method);
      });
    });
    var note = String((p.farmNotes || {})[String(farmId)] || '').trim();
    var when = a.at ? fmtDate(new Date(a.at).toISOString().slice(0, 10)) : '';
    var html = '<div class="ap-fc">' +
      '<div class="ap-fc-hd">✅ ' + esc(p.name || tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) +
        (p.target ? ' <span style="font-weight:600;">· 🐛 ' + esc(p.target) + '</span>' : '') +
        ' ' + dlChip(it.first, false) + '</div>' +
      '<div class="ap-fc-sub">' + tt('אושרה ע"י', 'อนุมัติโดย', 'اعتمدها') + ' ' + esc(a.by) + (when ? ' · ' + when : '') + '</div>' +
      (note ? '<div style="margin-top:5px;font-weight:600;">📌 ' + esc(note) + '</div>' : '') +
      (p.notes ? '<div class="ap-fc-sub" style="margin-top:3px;">' + esc(p.notes) + '</div>' : '') +
      (String(p.prep || '').trim() ? '<div class="ap-fc-sub" style="margin-top:4px;white-space:pre-line;background:#f4f9ea;border-radius:8px;padding:5px 8px;color:#1b2a1f;"><b>🧰 ' +
        tt('דגשים לביצוע', 'ข้อควรปฏิบัติ', 'إرشادات') + ':</b>\n' + esc(String(p.prep).replace(/\u2014/g, '-')) + '</div>' : '') +
      (p.zones && p.zones.on ? '<div class="ap-fc-sub" style="margin-top:4px;display:flex;gap:8px;align-items:center;background:#fff7ef;border-radius:8px;padding:5px 8px;">' +
        '<div style="flex:0 0 120px;">' + zonesFigure(p.zones, 120) + '</div><div style="font-size:.74rem;">' +
        ZONES.filter(function (d) { return Number(p.zones.parts[d.k]) > 0; }).map(function (d) {
          return '<div><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + d.c + ';margin-inline-end:4px;"></span>' + esc(zName(d)) + ' <b>' + p.zones.parts[d.k] + '%</b></div>';
        }).join('') + '</div></div>' : '');
    order.forEach(function (k) {
      var o = ops[k], c = mColor(o.method);
      html += '<div class="ap-fc-op">' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">' +
          '<span class="ap-op" style="--mc:' + c[0] + ';--mcb:' + c[1] + ';">' + esc(opLabel(o.method, o.round)) + '</span>' +
          '<span class="ap-fc-sub" style="margin:0;">' + o.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') +
            (o.water ? ' · ' + n1(o.water).toLocaleString() + ' ' + tt('ליטר מים / תמיסה', 'ลิตรน้ำ', 'لتر ماء') : '') + '</span>' +
        '</div>';
      Object.keys(o.mats).sort().forEach(function (nm) {
        html += '<div class="ap-fc-mat"><span>' + esc(nm) + ' <span class="ap-fc-sub">(' + esc(o.dose[nm]) + ')</span></span>' +
          '<strong>' + fmtQty(o.mats[nm], U(nm, p)) + '</strong></div>';
      });
      html += '<div class="ap-fc-plots">' + o.rows.map(function (r) {
        var pl = r.plotId ? plotById(r.plotId) : null;
        var nm = pl ? pl.name : (r.plotId ? '#' + r.plotId : tt('כל המשק', 'ทั้งฟาร์ม', 'كل المزرعة'));
        var own = r.deadline && r.deadline !== it.first;
        return '<span class="ap-fc-plot">' + esc(nm) + (r.cohort ? ' (' + esc(r.cohort) + ')' : '') +
          ' · ' + (Number(r.trees) || 0).toLocaleString() + (own ? ' · ⏰ ' + fmtDate(r.deadline) : '') + '</span>';
      }).join('') + '</div></div>';
    });
    if (isManager()) {
      html += '<button type="button" class="ap-btn ghost" style="margin-top:8px;padding:6px 10px;font-size:.76rem;" ' +
        'onclick="AgriPlan.openPlan(' + it.year + ',' + p.id + ')">🌿 ' + tt('פתח בתוכניות טיפול', 'เปิดในแผน', 'فتح في الخطط') + '</button>';
    }
    return html + '</div>';
  }

  function exportBtns(id) {
    return '<button class="ap-btn ghost" onclick="AgriPlan.exportPicker(' + id + ',\'grower\')">📤 ' +
        tt('ייצוא לחלקה / משק', 'ส่งออกตามแปลง/ฟาร์ม', 'تصدير لقطعة/مزرعة') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.exportPicker(' + id + ',\'rfq\')">🧾 ' +
        tt('בקשה להצעת מחיר', 'ขอใบเสนอราคา', 'طلب عرض سعر') + '</button>';
  }

  function rowHtml(p, r, i, ro) {
    var pid = p.id;
    var mSel = '';
    METHODS.forEach(function (m) {
      mSel += '<option value="' + m.v + '"' + (r.method === m.v ? ' selected' : '') + '>' +
        methodLabel(m.v) + '</option>';
    });

    var fSel = '<option value="">' + tt('- משק -', '- ฟาร์ม -', '- مزرعة -') + '</option>';
    farms().forEach(function (f) {
      fSel += '<option value="' + f.id + '"' + (r.farmId === f.id ? ' selected' : '') + '>' +
        esc(f.name) + '</option>';
    });

    var pSel = '<option value="">' + tt('- חלקה -', '- แปลง -', '- قطعة -') + '</option>';
    plots().filter(function (pl) { return !r.farmId || pl.farm_id === r.farmId; })
      .forEach(function (pl) {
        pSel += '<option value="' + pl.id + '"' + (r.plotId === pl.id ? ' selected' : '') + '>' +
          esc(pl.name) + '</option>';
      });

    var mats = '';
    (r.materials || []).forEach(function (m, mi) {
      var litres = rowMaterialL(r, m);
      mats += '<div class="ap-mat">' +
        '<span class="ap-mat-n"><input class="ap-in" list="apMats" data-k="m' + i + '-' + mi + '-n" value="' + esc(m.name) + '" placeholder="' +
          tt('חומר', 'สาร', 'مادة') + '" ' +
          'oninput="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'name\',this.value)">' +
          '<button type="button" class="ap-mat-pick" title="' + tt('כל החומרים', 'สารทั้งหมด', 'كل المواد') + '" onclick="AgriPlan._pickMat(' + pid + ',' + i + ',' + mi + ')">☰</button>' +
          (function () { var un = U(m.name, p); return '<select class="ap-unit" title="' + tt('יחידה: נוזל (ליטר) או אבקה/גרגרים (ק״ג / גרם)', 'หน่วย', 'الوحدة') + '" onchange="AgriPlan._setUnit(' + pid + ',' + i + ',' + mi + ',this.value)">' +
            [['L', tt('ליטר', 'ลิตร', 'لتر')], ['kg', tt('ק״ג', 'กก.', 'كغ')], ['g', tt('גרם', 'กรัม', 'غرام')]].map(function (o) {
              return '<option value="' + o[0] + '"' + (o[0] === un ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'; })() + '</span>' +
        '<select class="ap-in" onchange="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'mode\',this.value)">' +
          '<option value="pct"' + (m.mode === 'pct' ? ' selected' : '') + '>%</option>' +
          '<option value="cc"' + (m.mode === 'cc' ? ' selected' : '') + '>' +
            perUnitWord(U(m.name, p), r.method) + '</option>' +
          '<option value="lu"' + (m.mode === 'lu' ? ' selected' : '') + '>' +
            unitWord(U(m.name, p)) + '/' + (isDunam(r.method) ? tt('דונם', 'ไร่', 'دونم') : tt('עץ', 'ต้น', 'شجرة')) + '</option></select>' +
        '<input class="ap-in" type="number" step="any" value="' + (m.value || '') + '" ' +
          'oninput="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'value\',this.value)">' +
        '<input class="ap-in" type="number" step="any" value="' + (m.price || '') + '" placeholder="\u20aa/L" ' +
          'oninput="AgriPlan._setMat(' + pid + ',' + i + ',' + mi + ',\'price\',this.value)">' +
        '<button class="ap-btn ghost" data-no-sticky data-no-back title="' + tt('העבר חומר זה ליישום אחר (הגמעה, הזרקה…)', 'ย้ายไปวิธีอื่น', 'نقل إلى طريقة أخرى') + '" style="padding:5px 7px;" ' +
          'onclick="AgriPlan.splitApp(' + pid + ',' + i + ',' + mi + ')">↦</button>' +
        '<button class="ap-btn warn" data-no-sticky ' +
          'title="' + tt('מחק חומר', 'ลบสาร', 'حذف مادة') + '" style="padding:5px 7px;" ' +
          'onclick="AgriPlan._delMat(' + pid + ',' + i + ',' + mi + ')">\u2715</button>' +
        '<div style="grid-column:1/-1;font-size:.74rem;color:var(--primary,#2d6a4f);font-weight:700;">' +
          '\u2192 ' + fmtQty(litres, U(m.name, p)) + ' ' + tt('לחלקה', 'ต่อแปลง', 'للقطعة') +
          '</div>' +
      '</div>';
    });

    var mc = mColor(r.method);
    var pl0 = r.plotId ? plotById(r.plotId) : null;
    var dl = effDeadline(p, r);
    return '<div class="ap-row" style="--mc:' + mc[0] + ';--mcb:' + mc[1] + ';">' +
      (ro ? '<fieldset disabled style="border:none;padding:0;margin:0;min-width:0;">' : '') +
      // Who and what at a glance, before the form fields.
      '<div class="ap-rowhd">' +
        '<span class="ap-num">' + (i + 1) + '</span>' +
        '<span>' + esc(pl0 ? pl0.name : tt('ללא חלקה', 'ไม่มีแปลง', 'بلا قطعة')) +
          (r.cohort ? ' - ' + esc(r.cohort) : '') + '</span>' +
        '<span class="ap-op">' + esc(opLabel(r.method, r.round)) + '</span>' +
        (r.trees ? '<span class="n">' + Number(r.trees).toLocaleString() + ' ' + qtyWord(r.method) + '</span>' : '') +
        dlChip(dl, !r.deadline) +
      '</div>' +
      '<div class="ap-rowgrid">' +
        '<div><div class="ap-lbl">' + tt('אופן יישום', 'วิธีการ', 'طريقة') + '</div>' +
          '<select class="ap-in" onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'method\',this.value)">' +
          mSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('משק', 'ฟาร์ม', 'مزرعة') + '</div>' +
          '<select class="ap-in" onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'farmId\',this.value)">' +
          fSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('חלקה', 'แปลง', 'قطعة') + '</div>' +
          '<select class="ap-in" onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'plotId\',this.value)">' +
          pSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('תת-קבוצה', 'กลุ่มย่อย', 'مجموعة') + '</div>' +
          '<input class="ap-in" value="' + esc(r.cohort) + '" placeholder="' +
            tt('לא מניב / זן', 'ไม่ให้ผล', 'غير مثمر') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'cohort\',this.value)"></div>' +
        '<div><div class="ap-lbl">' + (isDunam(r.method) ? tt('שטח (דונם)', 'พื้นที่ (ไร่)', 'المساحة (دونم)') : tt('מס\' עצים', 'จำนวนต้น', 'عدد الأشجار')) + '</div>' +
          '<input class="ap-in" type="number" value="' + (r.trees || '') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'trees\',this.value)"></div>' +
        '<div><div class="ap-lbl">' + carrierLabel(r.method) + '</div>' +
          '<input class="ap-in" type="number" step="any" value="' + (r.carrier || '') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'carrier\',this.value)"></div>' +
        '<div><button class="ap-btn warn" data-no-sticky ' +
          'title="' + tt('מחק שורה', 'ลบแถว', 'حذف صف') + '" style="padding:7px 9px;" ' +
          'onclick="AgriPlan._delRow(' + pid + ',' + i + ')">\ud83d\uddd1</button></div>' +
      '</div>' +

      '<div class="ap-row2">' +
        '<div><div class="ap-lbl">' + (r.method === 'general' ? tt('תיאור הטיפול', 'รายละเอียดงาน', 'وصف المعالجة') : tt('סיבוב טיפול', 'รอบ', 'الجولة')) + '</div>' +
          '<input class="ap-in" value="' + esc(r.round) + '" placeholder="' +
            tt('ראשון / שני', 'รอบแรก', 'الأولى') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'round\',this.value)"></div>' +
        '<div><div class="ap-lbl">▶ ' + tt('התחלה מומלצת', 'เริ่มแนะนำ', 'البدء الموصى به') + '</div>' +
          '<input class="ap-in" type="date" value="' + esc(r.start || '') + '" ' +
            'onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'start\',this.value)"></div>' +
        (r.method === 'drench' ? '<div><div class="ap-lbl">🪣 ' + tt('גודל דלי / מכל (ליטר)', 'ขนาดถัง (ลิตร)', 'حجم الدلو (لتر)') + '</div>' +
          '<input class="ap-in" type="number" step="any" value="' + (r.container || '') + '" placeholder="5" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'container\',this.value)"></div>' : '') +
        '<div><div class="ap-lbl">' + tt('מועד מומלץ', 'ช่วงเวลา', 'الموعد') + '</div>' +
          '<input class="ap-in" value="' + esc(r.timing) + '" placeholder="' +
            tt('סיום גדיד', 'หลังเก็บเกี่ยว', 'بعد الحصاد') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'timing\',this.value)"></div>' +
        '<div><div class="ap-lbl">⏰ ' + tt('סיום עד', 'เสร็จภายใน', 'الإنهاء حتى') +
          (p.deadline && !r.deadline ? ' <span style="font-weight:400;">(' + tt('לפי התוכנית', 'ตามแผน', 'حسب الخطة') + ')</span>' : '') +
          '</div>' +
          '<input class="ap-in" type="date" value="' + esc(r.deadline || '') + '" ' +
            'onchange="AgriPlan._setRow(' + pid + ',' + i + ',\'deadline\',this.value)"></div>' +
      '</div>' +

      mats +
      '<button class="ap-btn ghost" style="margin-top:6px;padding:6px 10px;font-size:.78rem;" ' +
        'onclick="AgriPlan._addMat(' + pid + ',' + i + ')">\u2795 ' +
        tt('חומר', 'สาร', 'مادة') + '</button>' +
      '<div class="ap-out">\ud83d\udca7 ' + tt('נפח כולל', 'ปริมาตรรวม', 'الحجم الكلي') + ': ' +
        n1(rowCarrierL(r)).toLocaleString() + ' ' + tt('ליטר', 'ลิตร', 'لتر') + '</div>' +
      (ro ? '</fieldset>' : '') +
    '</div>';
  }

  // ── row/material mutation ──
  function _setPlan(pid, k, v) {
    var p = editable(pid);
    if (p) p[k] = v;
  }
  // Dates repaint: every row's deadline chip depends on the plan's date.
  function _setDeadline(pid, v) {
    var p = editable(pid);
    if (!p) return;
    p.deadline = isoDate(v);
    save();
    showPlan(pid);
  }
  function _setRow(pid, i, k, v) {
    var p = editable(pid);
    if (!p || !p.rows[i]) return;
    var r = p.rows[i];
    if (k === 'trees') r.trees = Number(v) || 0;
    else if (k === 'carrier') r.carrier = Number(v) || 0;
    else if (k === 'container') r.container = Number(v) || 0;
    else if (k === 'start') r.start = isoDate(v);
    else if (k === 'farmId') {
      r.farmId = v === '' ? null : Number(v);
      r.plotId = null;                       // the plot list is farm-scoped
      showPlan(pid);
      return;
    } else if (k === 'plotId') {
      r.plotId = v === '' ? null : Number(v);
      // Seed tree count and farm from the plot - retyping a number that the
      // map already knows is how a plan drifts away from the orchard.
      var pl = plotById(r.plotId);
      if (pl) {
        if (!r.trees) r.trees = plotQty(pl, r.method);
        if (r.farmId === null) r.farmId = pl.farm_id || null;
      }
      showPlan(pid);
      return;
    } else if (k === 'method') {
      var wasDunam = isDunam(r.method);
      r.method = v;
      // Per-dunam ↔ per-tree: the quantity follows the plot's area or trees.
      var plm = r.plotId ? plotById(r.plotId) : null;
      if (plm && wasDunam !== isDunam(v)) r.trees = plotQty(plm, v);
      showPlan(pid);
      return;
    } else if (k === 'deadline') {
      r.deadline = isoDate(v);
      save();
      showPlan(pid);
      return;
    } else r[k] = v;
  }
  function _delRow(pid, i) {
    var p = editable(pid);
    if (!p || !p.rows[i]) return;
    // Deleting a row drops every material on it and saves immediately -
    // a plan has no undo. Always name what is about to be destroyed.
    var r = p.rows[i];
    var pl = plotById(r.plotId);
    var nMat = (r.materials || []).length;
    var what = [
      (pl ? pl.name : '') + (r.cohort ? ' \u2014 ' + r.cohort : ''),
      r.trees ? (r.trees + ' ' + tt('עצים', 'ต้น', 'شجرة')) : '',
      nMat ? (nMat + ' ' + tt('חומרים', 'สาร', 'مواد')) : ''
    ].filter(Boolean).join(' \u00b7 ');
    if (!confirm(tt('למחוק את השורה?', 'ลบแถวนี้?', 'حذف هذا الصف؟') +
                 (what ? '\n\n' + what : '') + '\n\n' +
                 tt('לא ניתן לשחזר.', 'ไม่สามารถกู้คืนได้', 'لا يمكن التراجع.'))) return;
    p.rows.splice(i, 1);
    save();
    showPlan(pid);
  }
  function addRow(pid) {
    var p = editable(pid);
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
  // ── Operation chooser, shared by both plot pickers ──
  // Says WHICH job the new rows are: method + round, and whether they start
  // with a copy of an existing operation's materials or empty. Defaults to
  // the last row's operation, so the common case (more plots for the same
  // spray) is still one tap.
  function opChooser(p) {
    var last = p.rows[p.rows.length - 1];
    var m0 = last ? last.method : 'spray';
    var r0 = last ? String(last.round || '').trim() : '';
    var mSel = METHODS.map(function (m) {
      return '<option value="' + m.v + '"' + (m.v === m0 ? ' selected' : '') + '>' + esc(methodLabel(m.v)) + '</option>';
    }).join('');
    var copy = '<option value="">' + tt('ללא - אוסיף חומרים אחר כך', 'ไม่มี - เพิ่มทีหลัง', 'بدون - أضيف لاحقاً') + '</option>' +
      planOps(p).map(function (o) {
        return '<option value="' + esc(o.key) + '"' + (o.key === opKey(m0, r0) ? ' selected' : '') + '>' +
          tt('העתק מ', 'คัดลอกจาก ', 'نسخ من ') + esc(opLabel(o.method, o.round)) + '</option>';
      }).join('');
    return '<div class="ap-rowgrid" style="grid-template-columns:1.1fr .7fr 1.4fr;margin-bottom:6px;">' +
        '<div><div class="ap-lbl">' + tt('אופן יישום', 'วิธีใช้', 'طريقة التطبيق') + '</div>' +
          '<select class="ap-in" id="apOpMethod" onchange="AgriPlan._opChanged(' + p.id + ')">' + mSel + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('סיבוב טיפול', 'รอบ', 'الجولة') + '</div>' +
          '<input class="ap-in" id="apOpRound" value="' + esc(r0) + '" placeholder="1" ' +
            'oninput="AgriPlan._opChanged(' + p.id + ')"></div>' +
        '<div><div class="ap-lbl">' + tt('חומרים לשורות החדשות', 'สารสำหรับแถวใหม่', 'مواد للصفوف الجديدة') + '</div>' +
          '<select class="ap-in" id="apOpCopy">' + copy + '</select></div>' +
      '</div>' +
      '<div id="apOpHint" style="font-size:.74rem;color:var(--text-muted,#888);margin:-2px 0 6px;"></div>';
  }
  function readOp(p) {
    var method = (document.getElementById('apOpMethod') || {}).value || 'spray';
    var round = String((document.getElementById('apOpRound') || {}).value || '').trim();
    var src = opByKey(p, (document.getElementById('apOpCopy') || {}).value || '');
    return { method: method, round: round, key: opKey(method, round), src: src ? src.sample : null };
  }
  function newOpRow(op, farmId, plotId, trees, cohort) {
    return normRow({
      method: op.method, round: op.round,
      timing: op.src ? op.src.timing : '',
      deadline: op.src ? op.src.deadline : '',
      carrier: op.src ? op.src.carrier : 0,
      farmId: farmId, plotId: plotId, trees: trees, cohort: cohort || '',
      materials: cloneMats(op.src)
    });
  }
  // Re-evaluates the picker after the operation changes: a plot is greyed
  // out only when it already has THIS operation, not any row at all.
  function _opChanged(pid) {
    var p = planById(pid);
    if (!p) return;
    var op = readOp(p);
    var existing = opByKey(p, op.key);
    var copy = document.getElementById('apOpCopy');
    if (copy && copy.dataset.touched !== '1') copy.value = existing ? existing.key : '';
    if (copy && !copy.dataset.wired) {
      copy.dataset.wired = '1';
      copy.addEventListener('change', function () { copy.dataset.touched = '1'; });
    }
    var hint = document.getElementById('apOpHint');
    if (hint) hint.textContent = existing ?
      tt('הפעולה כבר קיימת בתוכנית (' + existing.count + ' שורות) - חלקות שכבר יש להן אותה מסומנות באפור',
         'มีอยู่แล้ว (' + existing.count + ' แถว)', 'موجودة (' + existing.count + ' صفوف)') :
      tt('פעולה חדשה בתוכנית - תיווסף בנפרד מהפעולות הקיימות',
         'การดำเนินการใหม่ - แยกจากที่มีอยู่', 'عملية جديدة - منفصلة عن الموجودة');
    Array.prototype.forEach.call(document.querySelectorAll('.apPickPlot'), function (c) {
      var has = (';' + (c.getAttribute('data-ops') || '') + ';').indexOf(';' + op.key + ';') >= 0;
      c.disabled = has;
      if (has) c.checked = false;
      var lbl = c.closest('.apPickLbl');
      if (lbl) lbl.style.opacity = has ? '.45' : '';
    });
  }

  // Fan a whole farm out into one row per plot, tree counts seeded from the
  // map. This is the realistic entry path - the sheets cover every plot in
  // a מטע, and typing thirty rows by hand invites transcription errors.
  // Rendered as an in-sheet picker rather than window.prompt: a native
  // prompt cannot show plot counts, cannot be styled, and asked the user to
  // retype a number they had just read off a list.
  // ── Branch / crop pre-filter (PlotBranch.filterBar, app.js) ──
  // Lets a plan target e.g. only the date orchards of every farm.
  function segBar(prefix, list, onch) {
    return window.PlotBranch && PlotBranch.filterBar ? PlotBranch.filterBar(prefix, list, onch) : '';
  }
  function segSel(prefix) { return window.PlotBranch && PlotBranch.filterRead ? PlotBranch.filterRead(prefix) : null; }
  function segOn(sel) { return !!(sel && (sel.branch || sel.crop)); }
  function segOk(pl, sel) { return !segOn(sel) || (!!pl && PlotBranch.filterMatch(pl, sel)); }

  function seedFromFarm(pid) {
    var p = editable(pid);
    if (!p) return;
    var fs = farms();
    if (!fs.length) { toast('⚠️ ' + tt('אין משקים', 'ไม่มีฟาร์ม', 'لا مزارع')); return; }
    var all = plots();
    var opts = fs.map(function (f) {
      var n = all.filter(function (pl) { return pl.farm_id === f.id; }).length;
      var trees = 0;
      all.forEach(function (pl) { if (pl.farm_id === f.id) trees += Number(pl.tree_count) || 0; });
      return '<option value="' + f.id + '" data-name="' + esc(f.name) + '">' + esc(f.name) + '  ·  ' + n + ' ' +
        tt('חלקות', 'แปลง', 'قطع') + '  ·  ' + trees.toLocaleString() + ' ' +
        tt('עצים', 'ต้น', 'شجرة') + '</option>';
    }).join('');

    var host = document.getElementById('apPicker');
    if (!host) return;
    host.innerHTML =
      '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
        '<div style="font-weight:800;margin-bottom:6px;">🌳 ' + tt('הוספת משק שלם', 'เพิ่มทั้งฟาร์ม', 'إضافة مزرعة كاملة') + '</div>' +
        opChooser(p) +
        '<div class="ap-lbl">' + tt('סינון לפי ענף / גידול', 'กรองตามสาขา/พืช', 'تصفية حسب الفرع/المحصول') + '</div>' +
        segBar('apSeed', all, 'AgriPlan._seedHint()') +
        '<div class="ap-lbl">' + tt('בחר משק להוספה', 'เลือกฟาร์ม', 'اختر المزرعة') + '</div>' +
        (fs.length > 5 ?
          '<input class="ap-in" type="search" style="width:100%;margin-bottom:6px;" ' +
            'placeholder="🔍 ' + tt('סינון לפי שם משק', 'กรองตามชื่อฟาร์ม', 'تصفية حسب اسم المزرعة') + '" ' +
            'oninput="AgriPlan._filterFarmPick(this.value)">' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
          '<select class="ap-in" id="apFarmPick" style="flex:1;min-width:200px;" onchange="AgriPlan._seedHint()">' +
            '<option value="all" data-name="*">🌐 ' + tt('כל המשקים', 'ทุกฟาร์ม', 'كل المزارع') + '</option>' + opts + '</select>' +
          '<button class="ap-btn" id="apFarmPickAdd" onclick="AgriPlan._doSeed(' + pid + ')">➕ ' +
            tt('הוסף', 'เพิ่ม', 'إضافة') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' +
            tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
        '<div id="apSeedHint" style="font-size:.76rem;color:var(--text-muted,#888);margin-top:6px;"></div>' +
      '</div>';
    var fp = document.getElementById('apFarmPick');
    if (fp && fs.length) fp.value = String(fs[0].id);
    _opChanged(pid);
    _seedHint();
    host.scrollIntoView({ block: 'nearest' });
  }

  // Plots the "whole farm" action would add, after the branch/crop filter.
  function seedPlots() {
    var sel = document.getElementById('apFarmPick');
    if (!sel || sel.value === '') return [];
    var seg = segSel('apSeed');
    var fid = sel.value === 'all' ? null : Number(sel.value);
    var mine = {};
    farms().forEach(function (f) { mine[f.id] = true; });
    return plots().filter(function (pl) {
      if (fid === null ? !mine[pl.farm_id] : pl.farm_id !== fid) return false;
      return segOk(pl, seg);
    });
  }
  function _seedHint() {
    var h = document.getElementById('apSeedHint');
    if (!h) return;
    var list = seedPlots(), trees = 0, fset = {};
    list.forEach(function (pl) { trees += Number(pl.tree_count) || 0; fset[pl.farm_id] = 1; });
    h.textContent = list.length + ' ' + tt('חלקות', 'แปลง', 'قطع') + ' · ' + Object.keys(fset).length + ' ' +
      tt('משקים', 'ฟาร์ม', 'مزارع') + ' · ' + trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة');
    var add = document.getElementById('apFarmPickAdd');
    if (add) add.disabled = !list.length;
  }

  function _cancelSeed() {
    var host = document.getElementById('apPicker');
    if (host) host.innerHTML = '';
  }

  function _grpToggle(pid, fk, isOpen) {
    if (isOpen) _grpOpen[pid + '|' + fk] = true; else delete _grpOpen[pid + '|' + fk];
    _grpSave();
  }
  function _grpAll(pid, isOpen) {
    var p = planById(pid);
    if (!p) return;
    (p.rows || []).forEach(function (r) {
      var k = pid + '|' + String(r.farmId == null ? 0 : r.farmId);
      if (isOpen) _grpOpen[k] = true; else delete _grpOpen[k];
    });
    _grpSave();
    document.querySelectorAll('details.ap-grp').forEach(function (d) { d.open = isOpen; });
  }
  function _setRowFilter(pid, v) {
    _rowFilter = { pid: pid, q: String(v || '') };
    showPlan(pid);
  }

  // Pickers filter in place - no repaint, so ticked boxes survive typing.
  function _filterFarmPick(v) {
    var sel = document.getElementById('apFarmPick');
    if (!sel) return;
    var terms = filterTerms(v), first = null;
    Array.prototype.forEach.call(sel.options, function (o) {
      var ok = o.value === 'all' || matchesAny(terms, [o.getAttribute('data-name') || '']);
      o.hidden = !ok; o.disabled = !ok;   // iOS ignores hidden on <option>
      if (ok && first === null) first = o.value;
    });
    if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = first === null ? '' : first;
    var add = document.getElementById('apFarmPickAdd');
    if (add) add.disabled = first === null;
  }
  var _pickQ = '';
  function _filterPlotPick(v) {
    if (v === undefined) v = _pickQ; else _pickQ = v;
    var seg = segSel('apPick');
    var terms = filterTerms(v), shown = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.apPickGrp'), function (g) {
      var farmHit = terms.length && matchesAny(terms, [g.getAttribute('data-name') || '']);
      var any = false;
      Array.prototype.forEach.call(g.querySelectorAll('.apPickLbl'), function (l) {
        var ok = (farmHit || matchesAny(terms, [l.getAttribute('data-name') || ''])) &&
          segOk(plotById(Number(l.getAttribute('data-pid'))), seg);
        l.style.display = ok ? 'inline-flex' : 'none';
        if (ok) { any = true; shown++; }
      });
      g.style.display = any ? '' : 'none';
    });
    var none = document.getElementById('apPickNone');
    if (none) none.style.display = shown ? 'none' : '';
  }
  function _pickShown() {
    Array.prototype.forEach.call(document.querySelectorAll('.apPickLbl'), function (l) {
      if (l.style.display === 'none' || l.closest('.apPickGrp').style.display === 'none') return;
      var c = l.querySelector('.apPickPlot');
      if (c && !c.disabled) c.checked = true;
    });
  }

  function _doSeed(pid) {
    var p = editable(pid);
    var sel = document.getElementById('apFarmPick');
    if (!p || !sel) return;
    if (sel.value === '') return;
    var op = readOp(p);
    // Plots that already carry this exact operation are skipped, so adding a
    // drench to a farm that has its spray creates drench rows beside the
    // spray rows instead of duplicating either.
    var has = {};
    p.rows.forEach(function (r) { if (opKey(r.method, r.round) === op.key) has[r.plotId] = true; });
    var added = 0, skipped = 0;
    seedPlots().forEach(function (pl) {
      if (has[pl.id]) { skipped++; return; }
      p.rows.push(newOpRow(op, pl.farm_id, pl.id, plotQty(pl, op.method), ''));
      added++;
    });
    if (!added) {
      toast('⚠️ ' + (skipped ?
        tt('לכל החלקות במשק כבר יש את הפעולה הזו', 'ทุกแปลงมีแล้ว', 'كل القطع لديها هذه العملية') :
        tt('אין חלקות במשק זה', 'ไม่มีแปลง', 'لا قطع')));
      return;
    }
    save();
    toast('✅ ' + added + ' ' + tt('שורות נוספו', 'แถวถูกเพิ่ม', 'صفوف أُضيفت') + ' - ' + opLabel(op.method, op.round) +
      (skipped ? ' (' + skipped + ' ' + tt('כבר היו', 'มีแล้ว', 'موجودة') + ')' : ''));
    showPlan(pid);
  }

  function _addMat(pid, i) {
    var p = editable(pid);
    if (!p || !p.rows[i]) return;
    var r = p.rows[i];
    var def = 'pct';
    METHODS.forEach(function (m) { if (m.v === r.method) def = m.def; });
    r.materials.push(normMaterial({ mode: def }));
    showPlan(pid);
  }
  // ── Split materials into their own application ──
  // A row has one method, so every material on it is applied that way. To
  // drench one material while spraying the rest, the material moves to a
  // sibling row (same plot, trees, cohort, round, dates) with its own method,
  // solution volume and bucket. Opened from a material line (that row only)
  // or from the toolbar (a material across the plan or one orchard).
  var _sp = null;
  function splitApp(pid, i, mi) {
    var p = editable(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    var names = {};
    (p.rows || []).forEach(function (r) { (r.materials || []).forEach(function (m) { if (m.name) names[m.name] = 1; }); });
    var one = (i != null && p.rows[i] && p.rows[i].materials[mi]) ? { i: i, name: p.rows[i].materials[mi].name } : null;
    _sp = { pid: pid, one: one };
    var farmsIn = planFarms(p);
    var mOpt = METHODS.map(function (m) { return '<option value="' + m.v + '"' + (m.v === 'drench' ? ' selected' : '') + '>' + esc(methodLabel(m.v)) + '</option>'; }).join('');
    host.innerHTML = '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
      '<div style="font-weight:800;margin-bottom:6px;">🔀 ' + tt('העברת חומר ליישום נפרד', 'ย้ายสารไปวิธีแยก', 'نقل مادة إلى طريقة منفصلة') + '</div>' +
      '<div style="font-size:.76rem;color:var(--text-muted,#888);margin-bottom:6px;">' + tt('החומר יוצא מהשורה שלו ועובר לשורה נפרדת באותה חלקה, עם אופן היישום, נפח התמיסה והדלי שתבחר. שאר החומרים נשארים במקומם.', 'สารจะย้ายไปแถวใหม่ในแปลงเดียวกัน', 'تنتقل المادة إلى صف منفصل في نفس القطعة.') + '</div>' +
      '<div class="ap-rowgrid" style="grid-template-columns:1.2fr 1.2fr 1fr 1fr .9fr;">' +
        '<div><div class="ap-lbl">' + tt('חומר', 'สาร', 'المادة') + '</div><select class="ap-in" id="apSpMat"' + (one ? ' disabled' : '') + '>' +
          Object.keys(names).sort().map(function (n) { return '<option' + (one && one.name === n ? ' selected' : '') + '>' + esc(n) + '</option>'; }).join('') + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('אופן יישום חדש', 'วิธีใหม่', 'الطريقة الجديدة') + '</div><select class="ap-in" id="apSpMethod">' + mOpt + '</select></div>' +
        '<div><div class="ap-lbl">' + tt('תמיסה לעץ (ליטר)', 'สารละลาย/ต้น (ลิตร)', 'محلول/شجرة (لتر)') + '</div><input class="ap-in" id="apSpCarrier" type="number" step="any" placeholder="' + tt('לא חובה', 'ไม่บังคับ', 'اختياري') + '"></div>' +
        '<div><div class="ap-lbl">🪣 ' + tt('דלי / מכל (ליטר)', 'ถัง (ลิตร)', 'دلو (لتر)') + '</div><input class="ap-in" id="apSpBucket" type="number" step="any" placeholder="5"></div>' +
        '<div><div class="ap-lbl">' + tt('מינון חדש', 'อัตราใหม่', 'جرعة جديدة') + '</div><input class="ap-in" id="apSpDose" type="number" step="any" placeholder="' + tt('ללא שינוי', 'ไม่เปลี่ยน', 'بدون تغيير') + '"></div>' +
      '</div>' +
      (one ? '' : '<div class="ap-lbl" style="margin-top:6px;">' + tt('היכן', 'ที่ไหน', 'أين') + '</div><select class="ap-in" id="apSpScope" style="max-width:340px;"><option value="">' + tt('כל המטעים בתוכנית', 'ทุกสวนในแผน', 'كل البساتين') + '</option>' +
        farmsIn.map(function (f) { return '<option value="' + f + '">' + esc(farmName(f)) + '</option>'; }).join('') + '</select>') +
      '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:4px;">' + tt('מינון חדש - באותה יחידה שהחומר מוגדר בה (למשל 20 סמ"ק/עץ). ריק = נשאר כפי שהוא.', 'อัตราในหน่วยเดิม', 'الجرعة بنفس الوحدة') + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px;"><button class="ap-btn" data-no-back onclick="AgriPlan._splitGo()">🔀 ' + tt('העבר', 'ย้าย', 'نقل') + '</button>' +
        '<button class="ap-btn ghost" data-no-sticky onclick="AgriPlan._cancelSeed()">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function _splitGo() {
    var sp = _sp, p = sp && editable(sp.pid);
    if (!p) return;
    function v(id) { var e = document.getElementById(id); return e ? e.value : ''; }
    var name = sp.one ? sp.one.name : v('apSpMat'), method = v('apSpMethod');
    var carrier = Number(v('apSpCarrier')) || 0, bucket = Number(v('apSpBucket')) || 0, dose = v('apSpDose');
    var scope = sp.one ? null : (v('apSpScope') ? Number(v('apSpScope')) : null);
    if (!name || !method) return;
    var moved = 0, out = [], emptied = [];
    function sib(r) { return function (x) { return x !== r && x.method === method && Number(x.farmId) === Number(r.farmId) && Number(x.plotId) === Number(r.plotId) && x.cohort === r.cohort && x.round === r.round; }; }
    var rows = p.rows.slice();
    rows.forEach(function (r, idx) {
      out.push(r);
      if (sp.one && idx !== sp.one.i) return;
      if (scope != null && Number(r.farmId) !== scope) return;
      if (r.method === method) return;
      var mi = (r.materials || []).findIndex(function (m) { return m.name === name; });
      if (mi < 0) return;
      var m = r.materials.splice(mi, 1)[0];
      if (!r.materials.length) emptied.push(r);
      if (dose !== '') m.value = Number(dose) || 0;
      var dst = out.find(sib(r)) || rows.slice(idx + 1).find(sib(r));
      if (!dst) {
        var pl = r.plotId ? plotById(r.plotId) : null;
        dst = normRow({ method: method, farmId: r.farmId, plotId: r.plotId, cohort: r.cohort, round: r.round, timing: r.timing, deadline: r.deadline, start: r.start,
          trees: (pl && isDunam(method) !== isDunam(r.method)) ? plotQty(pl, method) : r.trees, carrier: carrier, container: bucket, materials: [] });
        out.push(dst);
      } else {
        if (carrier) dst.carrier = carrier;
        if (bucket) dst.container = bucket;
      }
      dst.materials.push(m);
      moved++;
    });
    if (!moved) { toast('⚠️ ' + tt('לא נמצאו שורות להעברה', 'ไม่พบแถว', 'لا صفوف للنقل')); return; }
    // a row whose last material moved away (and is not a general job) goes
    p.rows = out.filter(function (r) { return !(emptied.indexOf(r) !== -1 && !(r.materials || []).length && r.method !== 'general'); });
    save();
    toast('🔀 ' + name + ' → ' + methodLabel(method) + ' · ' + moved + ' ' + tt('שורות', 'แถว', 'صفوف'));
    var host = document.getElementById('apPicker'); if (host) host.innerHTML = '';
    showPlan(p.id);
  }

  // ── Recommended start date for every orchard at once ──
  function bulkStart(pid) {
    var p = editable(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    var fids = planFarms(p);
    if (!fids.length) { toast('⚠️ ' + tt('הוסף קודם שורות לתוכנית', 'เพิ่มแถวก่อน', 'أضف صفوفاً أولاً')); return; }
    function common(fid) {
      var d = null, same = true;
      p.rows.forEach(function (r) { if (Number(r.farmId) !== Number(fid)) return; if (d === null) d = r.start || ''; else if ((r.start || '') !== d) same = false; });
      return same ? (d || '') : '';
    }
    host.innerHTML = '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
      '<div style="font-weight:800;margin-bottom:6px;">📅 ' + tt('מועד התחלה מומלץ לכל מטע', 'วันเริ่มต่อสวน', 'موعد البدء لكل بستان') + '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px;"><span class="ap-lbl" style="margin:0;">' + tt('אותו תאריך לכולם', 'วันเดียวกันทั้งหมด', 'نفس التاريخ للجميع') + '</span>' +
        '<input class="ap-in" type="date" id="apBsAll" style="max-width:170px;" onchange="document.querySelectorAll(\'.apBsF\').forEach(function(e){e.value=this.value}.bind(this))"></div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:6px 12px;">' +
        fids.map(function (f) {
          var n = p.rows.filter(function (r) { return Number(r.farmId) === Number(f); }).length;
          return '<label style="display:flex;gap:8px;align-items:center;justify-content:space-between;font-size:.84rem;"><span>' + farmIco(f) + ' ' + esc(farmName(f)) + ' <small style="color:var(--text-muted,#888);">(' + n + ')</small></span>' +
            '<input class="ap-in apBsF" type="date" data-f="' + f + '" value="' + esc(common(f)) + '" style="max-width:160px;"></label>';
        }).join('') + '</div>' +
      '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:6px;">' + tt('חל על כל השורות של המטע. שדה ריק = מוחק את מועד ההתחלה של המטע.', 'ใช้กับทุกแถวของสวน', 'يُطبق على كل صفوف البستان.') + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px;"><button class="ap-btn" data-no-back onclick="AgriPlan._bsApply(' + pid + ')">✓ ' + tt('עדכן', 'อัปเดต', 'تحديث') + '</button>' +
        '<button class="ap-btn ghost" data-no-sticky onclick="AgriPlan._cancelSeed()">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    host.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function _bsApply(pid) {
    var p = editable(pid);
    if (!p) return;
    var set = {};
    document.querySelectorAll('.apBsF').forEach(function (e) { set[e.getAttribute('data-f')] = isoDate(e.value); });
    var n = 0;
    p.rows.forEach(function (r) {
      var k = String(r.farmId);
      if (!(k in set)) return;
      if ((r.start || '') !== set[k]) { r.start = set[k]; n++; }
    });
    save();
    toast('📅 ' + n + ' ' + tt('שורות עודכנו', 'แถวอัปเดต', 'صفوف حُدّثت'));
    var host = document.getElementById('apPicker'); if (host) host.innerHTML = '';
    showPlan(pid);
  }

  function _delMat(pid, i, mi) {
    var p = editable(pid);
    if (!p || !p.rows[i]) return;
    var m = (p.rows[i].materials || [])[mi];
    if (!m) return;
    if (!confirm(tt('למחוק את החומר', 'ลบสาร', 'حذف المادة') + ' "' +
                 (m.name || tt('ללא שם', 'ไม่มีชื่อ', 'بدون اسم')) + '"?')) return;
    p.rows[i].materials.splice(mi, 1);
    save();
    showPlan(pid);
  }
  // Every material in our lists - the whole catalogue, whatever crop it is
  // registered for - plus names already used in plans. The datalist only
  // offers names matching what is typed; this lists them all, searchable.
  function allMaterialsInfo() {
    var by = {};
    ((window.SprayStore && SprayStore.getPesticides) ? SprayStore.getPesticides() : []).forEach(function (x) {
      var n = String(x.productName || '').trim();
      if (!n) return;
      var e = by[n] || (by[n] = { name: n, act: {}, crops: {} });
      String(x.activeIngredient || '').split(/\s*[+,،]\s*/).forEach(function (a) { a = a.trim(); if (a) e.act[a] = 1; });
      String(x.crop || '').split(/[,،]/).forEach(function (c) { c = c.trim(); if (c) e.crops[c] = 1; });
    });
    knownMaterials().forEach(function (n) { if (!by[n]) by[n] = { name: n, act: {}, crops: {} }; });
    return Object.keys(by).sort(function (a, b) { return a.localeCompare(b, 'he'); }).map(function (k) {
      var e = by[k];
      return { name: e.name, act: Object.keys(e.act).join(' + '), crops: Object.keys(e.crops).join(', ') };
    });
  }
  function _pickMat(pid, i, mi) {
    var list = allMaterialsInfo();
    var old = document.getElementById('apmpBack');
    if (old) old.remove();
    var back = document.createElement('div');
    back.id = 'apmpBack';
    back.className = 'apmp-back';
    back.innerHTML = '<div class="apmp"><div class="apmp-h"><b>' + tt('כל חומרי ההדברה', 'สารกำจัดศัตรูพืชทั้งหมด', 'كل المبيدات') + ' (' + list.length + ')</b>' +
      '<button type="button" data-x="1">✕</button></div>' +
      '<input class="ap-in apmp-s" id="apmpQ" placeholder="🔍 ' + tt('חיפוש לפי שם, חומר פעיל או גידול', 'ค้นหา', 'بحث بالاسم أو المادة أو المحصول') + '">' +
      '<div class="apmp-l" id="apmpL"></div></div>';
    document.body.appendChild(back);
    function draw(q) {
      q = String(q || '').trim().toLowerCase();
      var rows = list.filter(function (m) { return !q || (m.name + ' ' + m.act + ' ' + m.crops).toLowerCase().indexOf(q) !== -1; });
      document.getElementById('apmpL').innerHTML = rows.map(function (m, k) {
        return '<button type="button" class="apmp-i" data-n="' + esc(m.name) + '"><b>' + esc(m.name) + '</b>' +
          ((m.act || m.crops) ? '<small>' + esc(m.act) + (m.act && m.crops ? ' · ' : '') + (m.crops ? '🌱 ' + esc(m.crops) : '') + '</small>' : '') + '</button>';
      }).join('') || '<div style="padding:14px;color:var(--text-muted,#777);">' + tt('לא נמצא', 'ไม่พบ', 'لا نتائج') + '</div>';
    }
    draw('');
    var q = document.getElementById('apmpQ');
    q.addEventListener('input', function () { draw(this.value); });
    setTimeout(function () { try { q.focus(); } catch (e) {} }, 30);
    back.addEventListener('click', function (e) {
      if (e.target === back || e.target.getAttribute('data-x')) return back.remove();
      var b = e.target.closest('.apmp-i');
      if (!b) return;
      var name = b.getAttribute('data-n');
      back.remove();
      if (pid === null || pid === undefined) {
        var inp = document.getElementById('apBulkName');
        if (inp) { inp.value = name; inp.dispatchEvent(new Event('input', { bubbles: true })); }
        return;
      }
      _setMat(pid, i, mi, 'name', name);
      save();
      showPlan(pid);
    });
  }

  // A product is liquid or solid everywhere in the plan: the choice is
  // applied to every row carrying the same material name.
  function _setUnit(pid, i, mi, u) {
    var p = editable(pid);
    if (!p || !p.rows[i] || !p.rows[i].materials[mi]) return;
    var nm = p.rows[i].materials[mi].name;
    p.rows.forEach(function (r) {
      (r.materials || []).forEach(function (m) {
        if (m === p.rows[i].materials[mi] || (nm && m.name === nm)) { if (u === 'kg' || u === 'g') m.unit = u; else delete m.unit; }
      });
    });
    save();
    showPlan(pid);
  }

  function _setMat(pid, i, mi, k, v) {
    var p = editable(pid);
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

  // ══════════════════════════════════════════════════════════════════
  //  BULK TOOLS - define once, apply across many farms
  // ══════════════════════════════════════════════════════════════════

  // Volume per tree for many rows at once: tick plots (grouped by farm,
  // filterable by operation and name), type the new L/tree, apply. Every
  // material quantity follows, since pct doses are computed from it.
  function bulkCarrier(pid) {
    var p = editable(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    if (!p.rows.length) { toast('⚠️ ' + tt('הוסף קודם שורות לתוכנית', 'เพิ่มแถวก่อน', 'أضف صفوفاً أولاً')); return; }
    var ops = planOps(p);
    host.innerHTML =
      '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
        '<div style="font-weight:800;margin-bottom:6px;">💧 ' + tt('שינוי נפח לעץ בבת אחת', 'เปลี่ยนปริมาตรต่อต้นพร้อมกัน', 'تغيير الحجم لكل شجرة دفعة واحدة') + '</div>' +
        '<div class="ap-rowgrid" style="grid-template-columns:1.3fr 1fr .8fr;">' +
          '<div><div class="ap-lbl">' + tt('פעולה', 'การดำเนินการ', 'العملية') + '</div><select class="ap-in" id="apBvOp" onchange="AgriPlan.bulkCarrier(' + pid + ')">' +
            '<option value="">' + tt('כל הפעולות', 'ทั้งหมด', 'كل العمليات') + '</option>' +
            ops.map(function (o) { return '<option value="' + esc(o.key) + '"' + (o.key === _bv.op ? ' selected' : '') + '>' + esc(opLabel(o.method, o.round)) + '</option>'; }).join('') + '</select></div>' +
          '<div><div class="ap-lbl">' + tt('סינון לפי שם', 'กรองชื่อ', 'تصفية بالاسم') + '</div><input class="ap-in" id="apBvQ" value="' + esc(_bv.q) + '" placeholder="' + tt('משק / חלקה', 'ฟาร์ม/แปลง', 'مزرعة/قطعة') + '" oninput="AgriPlan.bulkCarrier(' + pid + ')"></div>' +
          '<div><div class="ap-lbl">' + tt('נפח חדש לעץ', 'ปริมาตรใหม่/ต้น', 'الحجم الجديد') + '</div><input class="ap-in" id="apBvVal" type="number" step="any" value="' + esc(_bv.val) + '" placeholder="5"></div>' +
        '</div>' +
        '<div id="apBvList" class="ap-bv"></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">' +
          '<button class="ap-btn" onclick="AgriPlan._bvApply(' + pid + ')">✓ ' + tt('עדכן את המסומנות', 'อัปเดตที่เลือก', 'حدّث المحدد') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._bvAll(' + pid + ',true)">' + tt('סמן הכל', 'เลือกทั้งหมด', 'تحديد الكل') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._bvAll(' + pid + ',false)">' + tt('נקה', 'ล้าง', 'مسح') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
          '<span id="apBvN" style="font-size:.78rem;color:var(--text-muted,#888);"></span>' +
        '</div></div>';
    var opEl = document.getElementById('apBvOp'), qEl = document.getElementById('apBvQ'), vEl = document.getElementById('apBvVal');
    // Keep what was typed across the redraws the filters trigger.
    _bv.op = opEl.value; _bv.q = qEl.value; _bv.val = vEl.value;
    vEl.addEventListener('input', function () { _bv.val = vEl.value; });
    var q = _bv.q.trim().toLowerCase();
    var groups = {}, order = [];
    p.rows.forEach(function (r, i) {
      if (_bv.op && opKey(r.method, r.round) !== _bv.op) return;
      var pl = plotById(r.plotId), fname = farmName(r.farmId), pname = (pl ? pl.name : '') + (r.cohort ? ' - ' + r.cohort : '');
      if (q && (fname + ' ' + pname).toLowerCase().indexOf(q) === -1) return;
      var fid = String(r.farmId == null ? 0 : r.farmId);
      if (!groups[fid]) { groups[fid] = []; order.push(fid); }
      groups[fid].push({ i: i, r: r, name: pname });
    });
    var list = document.getElementById('apBvList');
    list.innerHTML = order.map(function (fid) {
      return '<div class="ap-bv-f"><input type="checkbox" class="apBvFarm" data-f="' + fid + '"' + (groups[fid].every(function (x) { return _bv.sel[x.r.id]; }) ? ' checked' : '') + '> ' + farmIco(Number(fid)) + ' ' + esc(farmName(Number(fid))) + '</div>' +
        groups[fid].map(function (x) {
          return '<label class="ap-bv-r"><input type="checkbox" class="apBvRow" data-f="' + fid + '" data-id="' + x.r.id + '"' + (_bv.sel[x.r.id] ? ' checked' : '') + '> ' +
            esc(x.name || tt('ללא חלקה', 'ไม่มีแปลง', 'بلا قطعة')) + ' <small>' + esc(opLabel(x.r.method, x.r.round)) + ' · ' + (x.r.trees || 0).toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') +
            ' · <b>' + n1(x.r.carrier) + '</b> ' + (x.r.method === 'inject' ? tt('סמ"ק', 'ซีซี', 'سم³') : tt('ל׳', 'ล.', 'ل')) + '/' + tt('עץ', 'ต้น', 'شجرة') + '</small></label>';
        }).join('');
    }).join('') || '<div class="ap-empty">' + tt('אין שורות תואמות', 'ไม่มีแถว', 'لا صفوف') + '</div>';
    var count = function () { var n = Object.keys(_bv.sel).filter(function (k) { return _bv.sel[k]; }).length; document.getElementById('apBvN').textContent = n + ' ' + tt('שורות מסומנות', 'แถวที่เลือก', 'صفوف محددة'); };
    list.querySelectorAll('.apBvRow').forEach(function (c) {
      c.addEventListener('change', function () { _bv.sel[c.getAttribute('data-id')] = c.checked; count(); });
    });
    list.querySelectorAll('.apBvFarm').forEach(function (c) {
      c.addEventListener('change', function () {
        list.querySelectorAll('.apBvRow[data-f="' + c.getAttribute('data-f') + '"]').forEach(function (x) { x.checked = c.checked; _bv.sel[x.getAttribute('data-id')] = c.checked; });
        count();
      });
    });
    count();
    if (document.activeElement !== qEl) host.scrollIntoView({ block: 'nearest' });
    else { qEl.focus(); qEl.setSelectionRange(qEl.value.length, qEl.value.length); }
  }
  var _bv = { op: '', q: '', val: '', sel: {} };
  function _bvAll(pid, on) {
    document.querySelectorAll('#apBvList .apBvRow').forEach(function (x) { x.checked = on; _bv.sel[x.getAttribute('data-id')] = on; });
    document.querySelectorAll('#apBvList .apBvFarm').forEach(function (x) { x.checked = on; });
    var n = document.getElementById('apBvN'); if (n) n.textContent = Object.keys(_bv.sel).filter(function (k) { return _bv.sel[k]; }).length + ' ' + tt('שורות מסומנות', 'แถวที่เลือก', 'صفوف محددة');
  }
  function _bvApply(pid) {
    var p = editable(pid);
    if (!p) return;
    var v = Number((document.getElementById('apBvVal') || {}).value);
    if (!(v > 0)) { toast('⚠️ ' + tt('הכנס נפח חדש לעץ', 'ใส่ปริมาตร', 'أدخل الحجم')); return; }
    var n = 0;
    p.rows.forEach(function (r) { if (_bv.sel[String(r.id)]) { r.carrier = v; n++; } });
    if (!n) { toast('⚠️ ' + tt('לא סומנו שורות', 'ไม่ได้เลือก', 'لم تُحدد صفوف')); return; }
    _bv.sel = {};
    save();
    showPlan(pid);
    toast('✅ ' + tt('הנפח עודכן ל־', 'อัปเดตเป็น ', 'تم التحديث إلى ') + v + ' ' + tt('בשורות:', 'ใน', 'في') + ' ' + n);
  }
  // ── Spray diagram: which parts of the tree, and what share of the volume ──
  // A plan may carry a diagram for the crew: the built-in date palm with
  // its parts highlighted, or an uploaded illustration, plus the share of
  // the per-tree volume each part gets. Printed with the plan and shown on
  // the farm card; litres per part follow from each row's volume per tree.
  var ZONES = [
    { k: 'bunches', c: '#e91e63', he: 'אשכולות', th: 'ทะลาย', ar: 'العذوق' },
    { k: 'heart',   c: '#ff9800', he: 'לב הדקל ובסיס הכפות', th: 'ยอดและโคนทาง', ar: 'قلب النخلة وقواعد السعف' },
    { k: 'fronds',  c: '#43a047', he: 'נוף / כפות', th: 'ทางใบ', ar: 'السعف' },
    { k: 'trunk',   c: '#8d6e63', he: 'גזע', th: 'ลำต้น', ar: 'الجذع' },
    { k: 'base',    c: '#1e88e5', he: 'בסיס הגזע / קרקע', th: 'โคนต้น/ดิน', ar: 'قاعدة الجذع/التربة' }
  ];
  function zName(z) { return tt(z.he, z.th, z.ar); }
  function normZones(z) {
    if (!z || typeof z !== 'object') return null;
    var parts = {};
    ZONES.forEach(function (d) { var v = Number((z.parts || {})[d.k]); if (v > 0) parts[d.k] = Math.min(100, Math.round(v * 10) / 10); });
    return { on: !!z.on, img: /^https:\/\//.test(String(z.img || '')) ? String(z.img) : '', parts: parts };
  }
  function zSum(z) { var s = 0; Object.keys((z && z.parts) || {}).forEach(function (k) { s += Number(z.parts[k]) || 0; }); return Math.round(s * 10) / 10; }
  // Built-in palm. direction:ltr - RTL inheritance flips text-anchor.
  function zoneSvg(z, w) {
    var P = (z && z.parts) || {};
    function on(k) { return Number(P[k]) > 0; }
    function col(k, a) { var d = ZONES.find(function (x) { return x.k === k; }); return on(k) ? d.c : (a || 'none'); }
    var fronds = '';
    [[-120, 60], [-95, 30], [-60, 12], [-25, 4], [25, 4], [60, 12], [95, 30], [120, 60], [-135, 110], [135, 110]].forEach(function (d) {
      fronds += '<path d="M150 150 Q ' + (150 + d[0] * 0.55) + ' ' + (d[1] - 10) + ' ' + (150 + d[0]) + ' ' + (d[1] + 40) + '" fill="none" stroke="#2e7d32" stroke-width="5" stroke-linecap="round"/>';
    });
    var bunch = function (x, y) {
      var o = '<path d="M150 158 Q ' + ((150 + x) / 2) + ' ' + (y - 30) + ' ' + x + ' ' + (y - 12) + '" stroke="#c8a24a" stroke-width="2.5" fill="none"/>';
      for (var i = 0; i < 9; i++) o += '<circle cx="' + (x - 9 + (i % 3) * 9) + '" cy="' + (y - 6 + Math.floor(i / 3) * 8) + '" r="4.3" fill="#e6a23c" stroke="#a86b14" stroke-width="1"/>';
      return o;
    };
    var hl = function (k, shape) { return on(k) ? shape.replace('FILL', col(k)).replace('OP', '0.30') : ''; };
    var labels = [
      ['bunches', 262, 196, 196, 200], ['heart', 262, 150, 168, 156], ['fronds', 38, 46, 92, 70],
      ['trunk', 38, 250, 140, 250], ['base', 262, 318, 190, 322]
    ].filter(function (l) { return on(l[0]); }).map(function (l) {
      var d = ZONES.find(function (x) { return x.k === l[0]; }), left = l[1] < 150;
      return '<line x1="' + l[3] + '" y1="' + l[4] + '" x2="' + (left ? l[1] + 4 : l[1] - 4) + '" y2="' + l[2] + '" stroke="' + d.c + '" stroke-width="2"/>' +
        '<circle cx="' + l[3] + '" cy="' + l[4] + '" r="3.5" fill="' + d.c + '"/>' +
        '<text x="' + l[1] + '" y="' + (l[2] - 4) + '" font-size="14" font-weight="700" fill="' + d.c + '" text-anchor="' + (left ? 'end' : 'start') + '">' + esc(zName(d)) + '</text>' +
        '<text x="' + l[1] + '" y="' + (l[2] + 15) + '" font-size="17" font-weight="800" fill="' + d.c + '" text-anchor="' + (left ? 'end' : 'start') + '">' + P[l[0]] + '%</text>';
    }).join('');
    return '<svg style="direction:ltr;max-width:100%;height:auto;" viewBox="-80 0 460 340" width="' + (w || 300) + '" role="img" aria-label="spray diagram" font-family="Rubik, Heebo, Arial, sans-serif">' +
      '<rect x="-80" y="0" width="460" height="340" fill="#f6faf3" rx="14"/>' +
      '<rect x="-80" y="318" width="460" height="22" fill="#d7c4a3"/>' +
      hl('fronds', '<ellipse cx="150" cy="92" rx="150" ry="78" fill="FILL" fill-opacity="OP"/>') +
      fronds +
      '<rect x="138" y="160" width="24" height="160" rx="6" fill="#8d6e63"/>' +
      (function () { var o = ''; for (var y = 172; y < 318; y += 12) o += '<path d="M138 ' + y + ' L162 ' + (y + 6) + '" stroke="#6d4c41" stroke-width="2"/>'; return o; })() +
      hl('trunk', '<rect x="132" y="168" width="36" height="150" rx="8" fill="FILL" fill-opacity="OP" stroke="FILL" stroke-width="2"/>') +
      bunch(118, 205) + bunch(184, 205) + bunch(150, 214) +
      hl('bunches', '<ellipse cx="150" cy="206" rx="62" ry="26" fill="FILL" fill-opacity="OP" stroke="FILL" stroke-width="2"/>') +
      hl('heart', '<circle cx="150" cy="156" r="20" fill="FILL" fill-opacity="OP" stroke="FILL" stroke-width="2"/>') +
      hl('base', '<ellipse cx="150" cy="322" rx="48" ry="11" fill="FILL" fill-opacity="OP" stroke="FILL" stroke-width="2"/>') +
      labels + '</svg>';
  }
  function zonesFigure(z, w) {
    if (z.img) return '<img src="' + esc(z.img) + '" alt="" style="max-width:100%;max-height:' + (w ? Math.round(w * 1.1) : 330) + 'px;border-radius:12px;display:block;">';
    return zoneSvg(z, w);
  }
  // Litres per part for each distinct volume per tree in the given rows.
  function zonesTable(z, rows) {
    var keys = ZONES.filter(function (d) { return Number(z.parts[d.k]) > 0; });
    if (!keys.length) return '';
    var vols = [];
    (rows || []).forEach(function (r) { if (r.method === 'spray' && r.carrier > 0 && vols.indexOf(r.carrier) === -1) vols.push(r.carrier); });
    vols = vols.sort(function (a, b) { return a - b; }).slice(0, 3);
    return '<table class="ap-ztbl"><thead><tr><th>' + tt('חלק בעץ', 'ส่วนของต้น', 'جزء الشجرة') + '</th><th>%</th>' +
      vols.map(function (v) { return '<th>' + tt('מתוך', 'จาก', 'من') + ' ' + v + ' ' + tt('ל׳/עץ', 'ล./ต้น', 'ل/شجرة') + '</th>'; }).join('') + '</tr></thead><tbody>' +
      keys.map(function (d) {
        var pc = Number(z.parts[d.k]);
        return '<tr><td><span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:' + d.c + ';margin-inline-end:5px;"></span>' + esc(zName(d)) + '</td><td>' + pc + '%</td>' +
          vols.map(function (v) { return '<td>' + n1(v * pc / 100) + ' ' + tt('ל׳', 'ล.', 'ل') + '</td>'; }).join('') + '</tr>';
      }).join('') + '</tbody></table>';
  }
  function zonesEditor(p, ro) {
    var z = p.zones;
    var id = p.id;
    if (!z || !z.on) {
      return ro ? '' : '<div class="ap-zone"><button type="button" class="ap-btn ghost" data-no-sticky data-no-back onclick="AgriPlan._zToggle(' + id + ')">🌴 ' +
        tt('הוסף איור ריסוס לעץ - אילו חלקים ואיזה אחוז מהנפח', 'เพิ่มภาพการพ่น', 'أضف رسم الرش') + '</button></div>';
    }
    var sum = zSum(z);
    return '<div class="ap-zone"><div class="ap-lbl" style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">' +
        '<b>🌴 ' + tt('איור ריסוס - חלקי העץ וחלוקת הנפח', 'ภาพการพ่น - ส่วนของต้นและสัดส่วน', 'رسم الرش - أجزاء الشجرة وتوزيع الحجم') + '</b>' +
        (ro ? '' : '<span style="display:inline-flex;gap:4px;flex-wrap:wrap;">' +
          '<label class="ap-btn ghost" style="padding:4px 9px;font-size:.74rem;cursor:pointer;">🖼 ' + (z.img ? tt('החלף איור', 'เปลี่ยนภาพ', 'تغيير الرسم') : tt('העלה איור משלך', 'อัปโหลดภาพ', 'ارفع رسمك')) +
            '<input type="file" accept="image/*" hidden onchange="AgriPlan._zImg(' + id + ',this)"></label>' +
          (z.img ? '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back style="padding:4px 9px;font-size:.74rem;" onclick="AgriPlan._zImgDel(' + id + ')">🌴 ' + tt('חזור לאיור הדקל', 'กลับไปภาพต้นปาล์ม', 'العودة لرسم النخلة') + '</button>' : '') +
          '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back style="padding:4px 9px;font-size:.74rem;color:#b3261e;" onclick="AgriPlan._zToggle(' + id + ')">✕ ' + tt('הסר', 'ลบ', 'إزالة') + '</button></span>') +
      '</div>' +
      '<div class="ap-zbody"><div class="ap-zfig">' + zonesFigure(z, 300) + '</div>' +
        '<div class="ap-zin">' + ZONES.map(function (d) {
          return '<label class="ap-zrow"><span><i style="background:' + d.c + '"></i>' + esc(zName(d)) + '</span>' +
            '<input class="ap-in" type="number" min="0" max="100" step="5" value="' + (z.parts[d.k] || '') + '" placeholder="0" ' + (ro ? 'readonly ' : '') +
            'onchange="AgriPlan._zSet(' + id + ',\'' + d.k + '\',this.value)"><b>%</b></label>';
        }).join('') +
        '<div class="ap-zsum' + (sum && sum !== 100 ? ' bad' : '') + '">' + tt('סה״כ', 'รวม', 'المجموع') + ' ' + sum + '%' + (sum && sum !== 100 ? ' - ' + tt('צריך להגיע ל-100%', 'ควรรวมเป็น 100%', 'يجب أن يكون 100%') : '') + '</div>' +
        zonesTable(z, p.rows) + '</div></div></div>';
  }
  function _zToggle(pid) {
    var p = editable(pid);
    if (!p) return;
    if (p.zones && p.zones.on) {
      if (!confirm(tt('להסיר את איור הריסוס מהתוכנית?', 'ลบภาพการพ่น?', 'إزالة رسم الرش؟'))) return;
      p.zones = null;
    } else p.zones = { on: true, img: '', parts: { bunches: 50, heart: 30, fronds: 20 } };
    save(); showPlan(pid);
  }
  function _zSet(pid, k, v) {
    var p = editable(pid);
    if (!p || !p.zones) return;
    var n = Number(v);
    if (n > 0) p.zones.parts[k] = Math.min(100, n); else delete p.zones.parts[k];
    save(); showPlan(pid);
  }
  function _zImgDel(pid) {
    var p = editable(pid);
    if (!p || !p.zones) return;
    p.zones.img = ''; save(); showPlan(pid);
  }
  function _zImg(pid, input) {
    var p = editable(pid), f = input && input.files && input.files[0];
    if (!p || !f || !p.zones) return;
    if (!window.firebase || !firebase.storage) { toast('❌ ' + tt('אין חיבור לאחסון', 'ไม่มีที่เก็บ', 'لا تخزين')); return; }
    toast('⏳ ' + tt('מעלה…', 'กำลังอัปโหลด…', 'جارٍ الرفع…'));
    var img = new Image(), url = URL.createObjectURL(f);
    img.onload = function () {
      var k = Math.min(1, 1600 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url);
      cv.toBlob(function (b) {
        var ref = firebase.storage().ref('knowledge/spray-' + Date.now() + '.jpg');
        ref.put(b, { contentType: 'image/jpeg' }).then(function () { return ref.getDownloadURL(); }).then(function (u) {
          p.zones.img = u; save(); showPlan(pid);
        }, function (e) { toast('❌ ' + tt('ההעלאה נכשלה', 'อัปโหลดไม่สำเร็จ', 'فشل الرفع') + ': ' + ((e && e.code) || '')); });
      }, 'image/jpeg', 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); toast('❌ ' + tt('הקובץ אינו תמונה', 'ไม่ใช่รูปภาพ', 'ليس صورة')); };
    img.src = url;
  }

  // ── prep-note templates ──
  function tplLoad() {
    if (_tpl) return Promise.resolve(_tpl);
    if (typeof DB === 'undefined') { _tpl = { items: [] }; return Promise.resolve(_tpl); }
    return DB.loadAsync(TPL_KEY).then(function (d) {
      _tpl = { items: (d && Array.isArray(d.items)) ? d.items : [] }; return _tpl;
    }, function () { _tpl = null; return { items: [] }; });   // a failed read is not "empty": never saved over
  }
  function tplPersist() {
    if (!_tpl) return Promise.resolve(false);
    var clean = JSON.parse(JSON.stringify(_tpl));
    var pr = DB.saveAsync ? DB.saveAsync(TPL_KEY, clean) : (DB.save(TPL_KEY, clean), Promise.resolve());
    return pr.then(function () { return true; }, function (e) {
      toast('\u274c ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + ((e && (e.code || e.message)) || e)); return false;
    });
  }
  // Built-in instruction templates. Inserted as plain text into the plan's
  // prep notes, where they are edited like anything else.
  var BUILTIN_TPL = {
    'b-drench-man': {
      name: function () { return tt('הגמעה ידנית עץ-עץ - דגשים', 'รดโคนต้นด้วยมือ', 'سقي يدوي'); },
      sub: function () { return tt('הרטבה מוקדמת, שפיכה סביב הבסיס, נפח אחיד', 'รดน้ำก่อน รดรอบโคน', 'ترطيب، صب حول القاعدة'); },
      text: function () { return [
        tt('הגמעה ידנית עץ-עץ:', 'การรดโคนต้นด้วยมือ:', 'السقي اليدوي شجرة شجرة:'),
        '• ' + tt('להרטיב את הקרקע סביב הגזע לפני ההגמעה - קרקע יבשה סופגת באופן לא אחיד.', 'รดน้ำดินรอบโคนก่อน', 'ترطيب التربة حول الجذع قبل السقي.'),
        '• ' + tt('לשפוך את כל הכמות סביב בסיס הגזע - לא על הגזע ולא על העלווה.', 'เทรอบโคนต้น ไม่ราดลำต้นหรือใบ', 'الصب حول قاعدة الجذع، لا على الجذع ولا الأوراق.'),
        '• ' + tt('אותו נפח לכל עץ - למדוד בכלי מסומן, לא בעין.', 'ปริมาณเท่ากันทุกต้น ใช้ภาชนะวัด', 'نفس الكمية لكل شجرة بإناء مدرّج.'),
        '• ' + tt('לערבב את המכל לפני כל מילוי - תמיסה שעומדת שוקעת.', 'คนถังก่อนเติมทุกครั้ง', 'تحريك الخزان قبل كل تعبئة.'),
        '• ' + tt('השקיה אחרי ההגמעה - לפי הוראות התווית.', 'การให้น้ำหลังรด ตามฉลาก', 'الري بعد السقي حسب الملصق.')
      ].join('\n'); }
    },
    'b-drench-irr': {
      name: function () { return tt('הגמעה דרך מערכת ההשקיה - דגשים', 'รดผ่านระบบน้ำ', 'سقي عبر الري'); },
      sub: function () { return tt('מילוי קווים, זמן הזרקה לכל מגוף, שטיפה', 'เติมท่อ ฉีด ล้าง', 'ملء الخطوط، الحقن، الشطف'); },
      text: function () { return [
        tt('הגמעה דרך מערכת ההשקיה:', 'การรดผ่านระบบน้ำ:', 'السقي عبر نظام الري:'),
        '• ' + tt('לבדוק לפני: אין דליפות וטפטפות סתומות בקטע, המזרק/משאבת הדשן תקינים.', 'ตรวจรอยรั่วและหัวน้ำหยดตัน', 'فحص التسربات والنقّاطات المسدودة.'),
        '• ' + tt('להפעיל השקיה לפני ההזרקה עד שהקווים מלאים והלחץ יציב.', 'เปิดน้ำจนท่อเต็มและแรงดันคงที่', 'تشغيل الري حتى امتلاء الخطوط وثبات الضغط.'),
        '• ' + tt('להזריק כל מגוף בנפרד, בזמן שנקבע; לרשום מגוף, שעת התחלה וסיום.', 'ฉีดทีละวาล์ว บันทึกเวลา', 'الحقن لكل محبس على حدة وتسجيل الوقت.'),
        '• ' + tt('הכמות היא לדונם - לוודא את שטח המגוף, לא לחשב לפי עצים.', 'ปริมาณต่อไร่ ตรวจพื้นที่วาล์ว', 'الكمية للدونم - تأكد من مساحة المحبس.'),
        '• ' + tt('אחרי ההזרקה - להמשיך להשקות במים נקיים, שהחומר יגיע לבית השורשים ולא יישאר בצנרת.', 'ล้างด้วยน้ำสะอาดหลังฉีด', 'الشطف بماء نظيف بعد الحقن.'),
        '• ' + tt('לא לערבב עם דשן או חומר אחר באותו מכל בלי אישור תאימות.', 'ไม่ผสมกับปุ๋ยโดยไม่ตรวจความเข้ากันได้', 'عدم الخلط مع سماد دون تأكيد التوافق.')
      ].join('\n'); }
    }
  };
  function tplMine(t) { return !window.Own || Own.canEdit(t); }
  function tplPanel(pid) {
    var items = (_tpl && _tpl.items) || [];
    var row = function (key, name, sub, del) {
      return '<div class="ap-tpl"><div class="ap-tpln"><b>' + esc(name) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' +
        '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back onclick="AgriPlan._tplUse(' + pid + ',\'' + key + '\',false)">＋ ' + tt('הוסף', 'เพิ่ม', 'أضف') + '</button>' +
        '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back onclick="AgriPlan._tplUse(' + pid + ',\'' + key + '\',true)">⇄ ' + tt('החלף', 'แทนที่', 'استبدل') + '</button>' +
        (del ? '<button type="button" class="ap-btn ghost" data-no-sticky data-no-back style="color:#b3261e;" onclick="AgriPlan._tplDel(\'' + key + '\')">🗑</button>' : '') + '</div>';
    };
    return '<div class="ap-tpls">' +
      row('builtin', tt('ברירת מחדל - דגשים כלליים לריסוס', 'ค่าเริ่มต้น', 'الافتراضي'), tt('כיול, סדר ערבוב, pH, ציוד מגן, מזג אוויר', 'การปรับเทียบ ลำดับการผสม…', 'المعايرة، الخلط…'), false) +
      Object.keys(BUILTIN_TPL).map(function (k) { return row(k, BUILTIN_TPL[k].name(), BUILTIN_TPL[k].sub(), false); }).join('') +
      (_tpl ? items.slice().sort(function (a, b) { return String(a.name).localeCompare(String(b.name), 'he'); }).map(function (t) {
        return row(String(t.id), t.name, (t.createdByName || '') + ' · ' + String(t.text || '').split('\n')[0].slice(0, 60), tplMine(t));
      }).join('') : '<div class="ap-tpln"><small>⏳</small></div>') +
      (_tpl && !items.length ? '<div class="ap-tpln"><small>' + tt('עוד אין תבניות שמורות. כתוב דגשים ולחץ "שמור כתבנית".', 'ยังไม่มีแม่แบบที่บันทึก', 'لا قوالب محفوظة بعد') + '</small></div>' : '') +
    '</div>';
  }
  function _tplToggle(pid) {
    _tplOpen = !_tplOpen;
    if (_tplOpen && !_tpl) tplLoad().then(function () { if (_openPlan === pid) showPlan(pid); });
    showPlan(pid);
  }
  function _tplUse(pid, key, replace) {
    var p = editable(pid);
    if (!p) return;
    if (key === 'builtin') {
      if (replace) p.prep = '';
      _prepTemplate(pid);
      return;
    }
    var t = BUILTIN_TPL[key] ? { text: BUILTIN_TPL[key].text() } : ((_tpl && _tpl.items) || []).find(function (x) { return String(x.id) === String(key); });
    if (!t) return;
    if (replace && String(p.prep || '').trim() && !confirm(tt('להחליף את הדגשים הקיימים בתבנית?', 'แทนที่ข้อความเดิม?', 'استبدال الإرشادات الحالية؟'))) return;
    p.prep = replace || !String(p.prep || '').trim() ? String(t.text || '') : (p.prep.trim() + '\n' + String(t.text || ''));
    save();
    showPlan(pid);
  }
  function _tplSave(pid) {
    var p = planById(pid);
    if (!p) return;
    var text = String(p.prep || '').trim();
    if (!text) { toast('\u26a0\ufe0f ' + tt('כתוב קודם דגשים בתיבה', 'เขียนข้อความก่อน', 'اكتب الإرشادات أولاً')); return; }
    tplLoad().then(function () {
      if (!_tpl) { toast('\u274c ' + tt('אין חיבור - נסה שוב', 'ไม่มีการเชื่อมต่อ', 'لا اتصال')); return; }
      var name = (prompt(tt('שם לתבנית (למשל: ריסוס בלושילד חורף)', 'ชื่อแม่แบบ', 'اسم القالب'), p.name || '') || '').trim();
      if (!name) return;
      var same = _tpl.items.find(function (x) { return String(x.name).trim() === name; });
      if (same) {
        if (!tplMine(same)) { toast('\u26d4 ' + tt('יש כבר תבנית בשם הזה של משתמש אחר - בחר שם אחר', 'มีชื่อนี้แล้ว', 'الاسم مستخدم')); return; }
        if (!confirm(tt('לעדכן את התבנית הקיימת בשם הזה?', 'อัปเดตแม่แบบเดิม?', 'تحديث القالب الحالي؟'))) return;
        same.text = text; same.updatedAt = Date.now();
      } else {
        var t = { id: uid(), name: name.slice(0, 80), text: text.slice(0, 4000) };
        if (window.Own) Own.stamp(t);
        _tpl.items.push(t);
      }
      tplPersist().then(function (ok) { if (ok) { toast('\u2705 ' + tt('התבנית נשמרה', 'บันทึกแม่แบบแล้ว', 'حُفظ القالب')); _tplOpen = true; if (_openPlan === pid) showPlan(pid); } });
    });
  }
  function _tplDel(key) {
    var t = ((_tpl && _tpl.items) || []).find(function (x) { return String(x.id) === String(key); });
    if (!t) return;
    if (!tplMine(t)) { if (window.Own) Own.denied(); return; }
    if (!confirm(tt('למחוק את התבנית', 'ลบแม่แบบ', 'حذف القالب') + ' "' + t.name + '"?')) return;
    _tpl.items = _tpl.items.filter(function (x) { return x !== t; });
    tplPersist().then(function () { if (_openPlan) showPlan(_openPlan); });
  }

  function _prepTemplate(pid) {
    var p = editable(pid);
    if (!p) return;
    var tpl = tt([
      '• כיול מרסס לפני תחילת העבודה - לוודא נפח לעץ לפי התוכנית',
      '• מילוי מים: חצי מיכל, הפעלת ערבול, ואז חומרים לפי הסדר: אבקות (WP/WG) → תרחיפים (SC) → תחליבים (EC) → משטחים',
      '• בדיקת pH מים (רצוי 5.5–6.5) ותיקון לפי הצורך',
      '• ציוד מגן מלא: מסיכה, כפפות, משקפיים, ביגוד',
      '• לא לרסס ברוח מעל 15 קמ״ש, בחום מעל 32°, או לפני גשם צפוי',
      '• לשמור תווית החומר בשטח · לרשום ריסוס ביומן מיד בסיום',
      '• זמן כניסה חוזרת וימי המתנה לקטיף לפי התווית'
    ].join('\n'),
    '• ปรับเทียบเครื่องพ่นก่อนเริ่มงาน\n• ลำดับการผสม: ผง → น้ำแขวนลอย → อิมัลชัน → สารจับใบ\n• ตรวจ pH น้ำ (5.5–6.5)\n• อุปกรณ์ป้องกันครบชุด\n• ห้ามพ่นเมื่อลมแรงกว่า 15 กม./ชม. ร้อนกว่า 32° หรือก่อนฝน\n• เก็บฉลากไว้ในแปลง · บันทึกการพ่นทันที\n• ระยะเข้าซ้ำและระยะรอเก็บเกี่ยวตามฉลาก',
    '• معايرة الرشاش قبل البدء\n• ترتيب الخلط: مساحيق → معلقات → مستحلبات → مواد لاصقة\n• فحص pH الماء (5.5–6.5)\n• معدات وقاية كاملة\n• لا رش برياح فوق 15 كم/س أو حرارة فوق 32° أو قبل المطر\n• الاحتفاظ بالملصق في الحقل · تسجيل الرش فوراً\n• فترة الدخول وفترة الانتظار حسب الملصق');
    p.prep = String(p.prep || '').trim() ? (p.prep.trim() + '\n' + tpl) : tpl;
    save();
    showPlan(pid);
  }

  // Define a material once - name, mode, rate, price - and push it onto one
  // OPERATION across the farms you tick. It used to go onto every row of
  // the farm, so a drench material landed inside the spray rows. Now it
  // targets one existing operation, or opens a separate new one.
  function bulkMaterial(pid) {
    var p = editable(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    var ops = planOps(p);
    if (!ops.length) {
      toast('⚠️ ' + tt('הוסף קודם שורות לתוכנית', 'เพิ่มแถวก่อน', 'أضف صفوفاً أولاً'));
      return;
    }
    var fids = [];
    (p.rows || []).forEach(function (r) {
      var fid = String(r.farmId == null ? 0 : r.farmId);
      if (fids.indexOf(fid) < 0) fids.push(fid);
    });
    var checks = fids.map(function (fid) {
      return '<label class="apBulkLbl" data-farm="' + fid + '" style="display:inline-flex;gap:5px;align-items:center;margin:3px 10px 3px 0;font-size:.82rem;">' +
        '<input type="checkbox" class="apBulkFarm" value="' + fid + '" checked> ' +
        esc(farmName(Number(fid))) + ' <span class="apBulkN" style="color:var(--text-muted,#888);"></span></label>';
    }).join('');
    var mats = knownMaterials().map(function (m) {
      return '<option value="' + esc(m) + '">';
    }).join('');
    var opSel = ops.map(function (o) {
      return '<option value="' + esc(o.key) + '">' + esc(opLabel(o.method, o.round)) +
        ' (' + o.count + ' ' + tt('שורות', 'แถว', 'صفوف') + ')</option>';
    }).join('') +
      '<option value="__new">➕ ' + tt('פעולה נפרדת חדשה…', 'การดำเนินการใหม่…', 'عملية جديدة منفصلة…') + '</option>';
    var mSel = METHODS.map(function (m) {
      return '<option value="' + m.v + '"' + (m.v === 'drench' ? ' selected' : '') + '>' + esc(methodLabel(m.v)) + '</option>';
    }).join('');

    host.innerHTML =
      '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
        '<div style="font-weight:800;margin-bottom:6px;">⚗️ ' +
          tt('הגדרת חומר למספר משקים', 'กำหนดสารหลายฟาร์ม', 'تعريف مادة لعدة مزارع') + '</div>' +
        '<div class="ap-lbl">' + tt('לאיזו פעולה להוסיף', 'เพิ่มในการดำเนินการ', 'إلى أي عملية') + '</div>' +
        '<select class="ap-in" id="apBulkOp" style="width:100%;margin-bottom:6px;" onchange="AgriPlan._bulkOpChanged(' + pid + ')">' + opSel + '</select>' +
        '<div id="apBulkNew" class="ap-rowgrid" style="grid-template-columns:1.2fr .8fr;margin-bottom:6px;" hidden>' +
          '<div><div class="ap-lbl">' + tt('אופן יישום', 'วิธีใช้', 'طريقة التطبيق') + '</div>' +
            '<select class="ap-in" id="apBulkNewMethod" onchange="AgriPlan._bulkOpChanged(' + pid + ')">' + mSel + '</select></div>' +
          '<div><div class="ap-lbl">' + tt('סיבוב טיפול', 'รอบ', 'الجولة') + '</div>' +
            '<input class="ap-in" id="apBulkNewRound" placeholder="1" oninput="AgriPlan._bulkOpChanged(' + pid + ')"></div>' +
        '</div>' +
        '<datalist id="apBulkMats">' + mats + '</datalist>' +
        '<div class="ap-rowgrid" style="grid-template-columns:1.4fr .8fr .7fr .7fr;">' +
          '<div><div class="ap-lbl">' + tt('חומר', 'สาร', 'مادة') + '</div>' +
            '<span class="ap-mat-n"><input class="ap-in" id="apBulkName" list="apBulkMats">' +
            '<button type="button" class="ap-mat-pick" title="' + tt('כל החומרים', 'สารทั้งหมด', 'كل المواد') + '" onclick="AgriPlan._pickMat(null)">☰</button></span></div>' +
          '<div><div class="ap-lbl">' + tt('אופן מינון', 'โหมด', 'الوضع') + '</div>' +
            '<select class="ap-in" id="apBulkMode">' +
              '<option value="pct">% ' + tt('מהתמיסה', 'ของสารละลาย', 'من المحلول') + '</option>' +
              '<option value="cc">' + tt('סמ"ק לעץ', 'ซีซี/ต้น', 'سم³/شجرة') + '</option>' +
            '</select></div>' +
          '<div><div class="ap-lbl">' + tt('ערך', 'ค่า', 'القيمة') + '</div>' +
            '<input class="ap-in" id="apBulkVal" type="number" step="any"></div>' +
          '<div><div class="ap-lbl">₪ ' + tt('לליטר', 'ต่อลิตร', 'لكل لتر') + '</div>' +
            '<input class="ap-in" id="apBulkPrice" type="number" step="any"></div>' +
        '</div>' +
        '<div class="ap-lbl" style="margin-top:8px;">' +
          tt('רק בחלקות מענף / גידול:', 'เฉพาะสาขา/พืช:', 'فقط في الفرع/المحصول:') + '</div>' +
        segBar('apBulk', (p.rows || []).map(function (r) { return plotById(r.plotId); }).filter(Boolean), '') +
        '<div class="ap-lbl" style="margin-top:8px;">' +
          tt('החל על המשקים:', 'ใช้กับฟาร์ม:', 'طبّق على المزارع:') + '</div>' +
        '<div>' + checks + '</div>' +
        '<div id="apBulkHint" style="font-size:.74rem;color:var(--text-muted,#888);margin-top:4px;"></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">' +
          '<button class="ap-btn" onclick="AgriPlan._applyBulk(' + pid + ')">✓ ' +
            tt('החל', 'ใช้', 'تطبيق') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' +
            tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
      '</div>';
    _bulkOpChanged(pid);
    host.scrollIntoView({ block: 'nearest' });
  }

  function bulkTarget(p) {
    var v = (document.getElementById('apBulkOp') || {}).value || '';
    if (v === '__new') {
      var method = (document.getElementById('apBulkNewMethod') || {}).value || 'drench';
      var round = String((document.getElementById('apBulkNewRound') || {}).value || '').trim();
      return { isNew: true, method: method, round: round, key: opKey(method, round) };
    }
    var o = opByKey(p, v);
    return o ? { isNew: false, method: o.method, round: o.round, key: o.key } : null;
  }

  // Keeps the dialog honest as the target changes: dose mode follows the
  // method, and each farm shows how many rows the material will land on.
  function _bulkOpChanged(pid) {
    var p = planById(pid);
    if (!p) return;
    var tg = bulkTarget(p);
    var box = document.getElementById('apBulkNew');
    if (box) box.hidden = !(tg && tg.isNew);
    if (!tg) return;
    var mode = document.getElementById('apBulkMode');
    if (mode) mode.value = defaultMode(tg.method);
    var existing = opByKey(p, tg.key);
    Array.prototype.forEach.call(document.querySelectorAll('.apBulkLbl'), function (l) {
      var fid = l.getAttribute('data-farm');
      var inOp = 0, plotsInFarm = {};
      p.rows.forEach(function (r) {
        if (String(r.farmId == null ? 0 : r.farmId) !== fid) return;
        if (opKey(r.method, r.round) === tg.key) inOp++;
        plotsInFarm[(r.plotId || 0) + '|' + (r.cohort || '')] = 1;
      });
      var n = l.querySelector('.apBulkN');
      if (n) n.textContent = tg.isNew && !inOp ?
        '(+' + Object.keys(plotsInFarm).length + ' ' + tt('שורות חדשות', 'แถวใหม่', 'صفوف جديدة') + ')' :
        '(' + inOp + ' ' + tt('שורות', 'แถว', 'صفوف') + ')';
    });
    var hint = document.getElementById('apBulkHint');
    if (hint) hint.textContent = tg.isNew ?
      (existing ?
        tt('פעולה בשם הזה כבר קיימת - החומר יתווסף לשורות שלה, ולחלקות שאין להן אותה ייפתחו שורות חדשות',
           'มีอยู่แล้ว - เพิ่มในแถวเดิม', 'موجودة - تضاف إلى صفوفها') :
        tt('ייפתחו שורות חדשות לכל חלקה במשקים המסומנים, בנפרד מהפעולות הקיימות',
           'จะสร้างแถวใหม่แยกต่างหาก', 'ستُنشأ صفوف جديدة منفصلة')) :
      tt('החומר יתווסף רק לשורות של ' + opLabel(tg.method, tg.round) + ' - לא לפעולות אחרות',
         'เพิ่มเฉพาะแถวของ ' + opLabel(tg.method, tg.round), 'يضاف فقط إلى صفوف ' + opLabel(tg.method, tg.round));
  }

  function _applyBulk(pid) {
    var p = editable(pid);
    if (!p) return;
    var tg = bulkTarget(p);
    if (!tg) return;
    var name = (document.getElementById('apBulkName') || {}).value || '';
    var mode = (document.getElementById('apBulkMode') || {}).value || 'pct';
    var val = Number((document.getElementById('apBulkVal') || {}).value) || 0;
    var price = Number((document.getElementById('apBulkPrice') || {}).value) || 0;
    if (!name || !val) {
      toast('⚠️ ' + tt('חסר שם חומר או ערך', 'ขาดชื่อหรือค่า', 'الاسم أو القيمة ناقص'));
      return;
    }
    var want = {};
    Array.prototype.forEach.call(document.querySelectorAll('.apBulkFarm'), function (c) {
      if (c.checked) want[c.value] = true;
    });
    // Branch / crop filter: rows whose plot does not match are left alone
    // (a farm-level row has no plot and is skipped while a filter is on).
    var bseg = segSel('apBulk');
    var rowOk = function (r) { return !segOn(bseg) || segOk(plotById(r.plotId), bseg); };
    // Re-applying the same material updates it in place rather than
    // stacking a duplicate - this is a correction tool as much as an
    // entry tool, and a doubled row would silently double the order.
    var put = function (r) {
      var hit = null;
      (r.materials || []).forEach(function (m) { if (m.name === name) hit = m; });
      if (hit) { hit.mode = mode; hit.value = val; hit.price = price; }
      else r.materials.push(normMaterial({ name: name, mode: mode, value: val, price: price }));
    };
    var updated = 0, created = 0;
    var inOp = {};   // plot|cohort that already has the target operation
    p.rows.forEach(function (r) {
      var fid = String(r.farmId == null ? 0 : r.farmId);
      if (!want[fid] || opKey(r.method, r.round) !== tg.key || !rowOk(r)) return;
      put(r);
      updated++;
      inOp[fid + '|' + (r.plotId || 0) + '|' + (r.cohort || '')] = true;
    });
    if (tg.isNew) {
      // One new row per plot (and cohort) the farm already has in the plan,
      // carrying the same tree count, so the split between productive and
      // לא מניב trees survives into the new operation.
      var seen = {}, fresh = [];
      p.rows.forEach(function (r) {
        var fid = String(r.farmId == null ? 0 : r.farmId);
        if (!want[fid] || !rowOk(r)) return;
        var k = fid + '|' + (r.plotId || 0) + '|' + (r.cohort || '');
        if (inOp[k] || seen[k]) return;
        seen[k] = true;
        var row = normRow({ method: tg.method, round: tg.round, farmId: r.farmId, plotId: r.plotId,
                            cohort: r.cohort, trees: r.trees, carrier: 0, materials: [] });
        put(row);
        fresh.push(row);
      });
      fresh.forEach(function (row) { p.rows.push(row); });
      created = fresh.length;
    }
    if (!updated && !created) {
      toast('⚠️ ' + tt('לא נמצאו שורות במשקים שנבחרו', 'ไม่พบแถว', 'لا صفوف'));
      return;
    }
    save();
    toast('✅ ' + opLabel(tg.method, tg.round) + ': ' +
      (updated ? updated + ' ' + tt('שורות עודכנו', 'แถวถูกอัปเดต', 'صفوف حُدّثت') : '') +
      (updated && created ? ', ' : '') +
      (created ? created + ' ' + tt('שורות חדשות', 'แถวใหม่', 'صفوف جديدة') : ''));
    showPlan(pid);
  }

  // Pick exactly which plots go in, per farm, instead of taking a whole מטע
  // and deleting what you did not want. A plot already in the plan stays
  // pickable for a DIFFERENT operation - the drench beside its spray.
  function pickPlots(pid) {
    var p = editable(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    var ops = {};   // plotId -> [opKey]
    var labels = {};
    (p.rows || []).forEach(function (r) {
      if (!r.plotId) return;
      var k = opKey(r.method, r.round);
      (ops[r.plotId] = ops[r.plotId] || []);
      if (ops[r.plotId].indexOf(k) < 0) {
        ops[r.plotId].push(k);
        (labels[r.plotId] = labels[r.plotId] || []).push(opLabel(r.method, r.round));
      }
    });

    var byFarm = {};
    plots().forEach(function (pl) {
      var f = pl.farm_id == null ? 0 : pl.farm_id;
      (byFarm[f] = byFarm[f] || []).push(pl);
    });

    var html = '';
    Object.keys(byFarm).forEach(function (fid) {
      var list = byFarm[fid].map(function (pl) {
        return '<label class="apPickLbl" data-name="' + esc(pl.name) + '" data-pid="' + pl.id + '" style="display:inline-flex;gap:5px;align-items:center;margin:3px 10px 3px 0;font-size:.8rem;">' +
          '<input type="checkbox" class="apPickPlot" value="' + pl.id + '" data-ops="' + esc((ops[pl.id] || []).join(';')) + '"> ' +
          esc(pl.name) +
          ' <span style="color:var(--text-muted,#888);">' + (Number(pl.tree_count) || 0).toLocaleString() + '</span>' +
          (labels[pl.id] ? ' <span style="font-size:.68rem;color:var(--primary,#2d6a4f);">[' + esc(labels[pl.id].join(', ')) + ']</span>' : '') +
          '</label>';
      }).join('');
      html += '<div class="apPickGrp" data-name="' + esc(farmName(Number(fid))) + '" style="margin-bottom:8px;">' +
        '<div style="font-weight:700;font-size:.84rem;margin-bottom:2px;">' +
          '' + farmIco(Number(fid)) + ' ' + esc(farmName(Number(fid))) +
          ' <button class="ap-btn ghost" style="padding:3px 8px;font-size:.7rem;" ' +
            'onclick="AgriPlan._pickAll(' + fid + ')">' +
            tt('הכל', 'ทั้งหมด', 'الكل') + '</button></div>' +
        list + '</div>';
    });

    host.innerHTML =
      '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
        '<div style="font-weight:800;margin-bottom:6px;">🌳 ' +
          tt('בחירת חלקות לתוכנית', 'เลือกแปลง', 'اختيار القطع') + '</div>' +
        opChooser(p) +
        '<div style="display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">' +
          '<input class="ap-in" type="search" style="flex:1;min-width:180px;" ' +
            'placeholder="🔍 ' + tt('סינון לפי שם משק / חלקה (אפשר כמה, מופרדים בפסיק)',
              'กรองตามชื่อฟาร์ม/แปลง (คั่นด้วยจุลภาค)', 'تصفية حسب اسم المزرعة/القطعة (افصل بفاصلة)') + '" ' +
            'oninput="AgriPlan._filterPlotPick(this.value)">' +
          segBar('apPick', plots(), 'AgriPlan._filterPlotPick()') +
          '<button class="ap-btn ghost" style="padding:5px 10px;font-size:.76rem;" onclick="AgriPlan._pickShown()">☑ ' +
            tt('סמן את המוצגים', 'เลือกที่แสดง', 'تحديد المعروض') + '</button>' +
        '</div>' +
        '<div style="max-height:46vh;overflow:auto;">' + html +
          '<div id="apPickNone" class="ap-empty" style="display:none;">' +
            tt('אין חלקות שמתאימות לסינון', 'ไม่มีแปลงที่ตรงกับตัวกรอง', 'لا قطع مطابقة للتصفية') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">' +
          '<button class="ap-btn" onclick="AgriPlan._addPicked(' + pid + ')">➕ ' +
            tt('הוסף לתוכנית', 'เพิ่ม', 'إضافة') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' +
            tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
      '</div>';
    _opChanged(pid);
    host.scrollIntoView({ block: 'nearest' });
  }

  function _pickAll(fid) {
    var ids = {};
    plots().forEach(function (pl) {
      if ((pl.farm_id == null ? 0 : pl.farm_id) === fid) ids[pl.id] = true;
    });
    Array.prototype.forEach.call(document.querySelectorAll('.apPickPlot'), function (c) {
      var lbl = c.closest('.apPickLbl');
      if (lbl && lbl.style.display === 'none') return;   // filtered out
      if (ids[Number(c.value)] && !c.disabled) c.checked = true;
    });
  }

  function _addPicked(pid) {
    var p = editable(pid);
    if (!p) return;
    var op = readOp(p);
    var n = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.apPickPlot'), function (c) {
      if (!c.checked || c.disabled) return;
      var pl = plotById(Number(c.value));
      if (!pl) return;
      p.rows.push(newOpRow(op, pl.farm_id || null, pl.id, plotQty(pl, op.method), ''));
      n++;
    });
    if (!n) { toast('⚠️ ' + tt('לא נבחרו חלקות', 'ไม่ได้เลือก', 'لم تُختر قطع')); return; }
    save();
    toast('✅ ' + n + ' ' + tt('שורות נוספו', 'แถวถูกเพิ่ม', 'صفوف أُضيفت') + ' - ' + opLabel(op.method, op.round));
    showPlan(pid);
  }

  function _setFarmNote(pid, fid, v) {
    var p = editable(pid);
    if (!p) return;
    if (!p.farmNotes) p.farmNotes = {};
    p.farmNotes[String(fid)] = v;
  }

  // ── document design ──
  // Palettes come from ReportTheme so a plan and a spray log printed on the
  // same day are visibly the same document family.
  function themeEditor(pid) {
    var p = editable(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    var t = p.report_theme || {};
    var presets = (window.ReportTheme && ReportTheme.PRESETS) ? ReportTheme.PRESETS : {};
    var sw = Object.keys(presets).map(function (k) {
      var pr = presets[k];
      var on = (t.preset || 'valley') === k;
      return '<button onclick="AgriPlan._theme(' + pid + ',\'preset\',\'' + k + '\')" ' +
        'style="padding:8px 12px;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:700;' +
        'font-size:.78rem;color:#fff;background:linear-gradient(135deg,' + pr.c1 + ',' + pr.c3 + ');' +
        'border:' + (on ? '2.5px solid var(--accent,#ff9f43)' : '1px solid rgba(255,255,255,.2)') + ';">' +
        esc(pr.label ? pr.label[0] : k) + '</button>';
    }).join(' ');

    host.innerHTML =
      '<div class="ap-card" style="border:1.5px solid var(--primary,#2d6a4f);">' +
        '<div style="font-weight:800;margin-bottom:6px;">\ud83c\udfa8 ' +
          tt('עיצוב המסמך', 'ออกแบบเอกสาร', 'تصميم المستند') + '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;">' + sw + '</div>' +
        '<div class="ap-rowgrid" style="grid-template-columns:1fr 1fr;">' +
          '<div><div class="ap-lbl">' + tt('כותרת המסמך', 'ชื่อเอกสาร', 'عنوان المستند') + '</div>' +
            '<input class="ap-in" data-k="dt" value="' + esc(p.docTitle) + '" placeholder="' +
              esc(p.name) + '" oninput="AgriPlan._setPlan(' + pid + ',\'docTitle\',this.value)"></div>' +
          '<div><div class="ap-lbl">' + tt('כותרת משנה', 'คำบรรยาย', 'عنوان فرعي') + '</div>' +
            '<input class="ap-in" data-k="ds" value="' + esc(p.docSub) + '" ' +
              'oninput="AgriPlan._setPlan(' + pid + ',\'docSub\',this.value)"></div>' +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.82rem;">' +
          '<label><input type="radio" name="apOri"' +
            ((t.orientation || 'landscape') === 'landscape' ? ' checked' : '') +
            ' onchange="AgriPlan._theme(' + pid + ',\'orientation\',\'landscape\')"> ' +
            tt('לרוחב', 'แนวนอน', 'أفقي') + '</label>' +
          '<label><input type="radio" name="apOri"' +
            (t.orientation === 'portrait' ? ' checked' : '') +
            ' onchange="AgriPlan._theme(' + pid + ',\'orientation\',\'portrait\')"> ' +
            tt('לאורך', 'แนวตั้ง', 'عمودي') + '</label>' +
          '<label><input type="checkbox"' + (t.signature ? ' checked' : '') +
            ' onchange="AgriPlan._theme(' + pid + ',\'signature\',this.checked)"> ' +
            tt('שורת חתימה', 'ช่องเซ็น', 'سطر توقيع') + '</label>' +
        '</div>' +
        '<div class="ap-lbl" style="margin-top:8px;">' + tt('כיתוב תחתון', 'ท้ายกระดาษ', 'تذييل') + '</div>' +
        '<input class="ap-in" data-k="df" value="' + esc(t.footer || '') + '" ' +
          'oninput="AgriPlan._theme(' + pid + ',\'footer\',this.value)">' +
        '<div style="display:flex;gap:6px;margin-top:8px;">' +
          '<button class="ap-btn" onclick="AgriPlan.printPlan(' + pid + ')">\ud83d\udda8 ' +
            tt('תצוגה מקדימה', 'ดูตัวอย่าง', 'معاينة') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' +
            tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
        '</div>' +
      '</div>';
    host.scrollIntoView({ block: 'nearest' });
  }

  function _theme(pid, k, v) {
    var p = editable(pid);
    if (!p) return;
    if (!p.report_theme) p.report_theme = {};
    p.report_theme[k] = v;
    save();
    if (k === 'preset' || k === 'orientation') themeEditor(pid);
  }

  // ── outputs ──
  // Print colours are hardcoded: the sheet opens in a bare tab with none of
  // the app's CSS variables defined, so theme values would render invisible.
  // ═══════════════════════════════════════════════════════
  //  PRINT / EXPORT
  // ═══════════════════════════════════════════════════════
  // One builder for every printed page, so the full plan and the per-plot /
  // per-farm sheets cannot drift apart in layout or arithmetic. Each page
  // computes its own totals from ITS rows only - a grower's sheet must not
  // carry litres that belong to someone else's orchard.
  function planTheme(p) {
    // resolve() reads .report_theme off whatever object it is handed, so the
    // plan borrows the spray log's palettes without pretending to be a farm.
    return (window.ReportTheme && ReportTheme.resolve)
      ? ReportTheme.resolve(p)
      : { c1: '#1a5632', c2: '#2d6a4f', c3: '#40916c', accent: '#2d6a4f',
          headText: '#fff', radius: 16, orientation: 'landscape', footer: '', signature: false };
  }

  // Easier reading (Oct 2026): darker ink, heavier weights, larger table text.
  function readCss(th) {
    return 'body{color:#141414;font-weight:500;-webkit-font-smoothing:antialiased;}' +
      '.hd{position:relative;padding-inline-end:22px;}.hd-crop{float:left;display:flex;align-items:center;gap:8px;background:#fff;border:1px solid ' + (th.line || '#d5ddd7') + ';border-radius:14px;padding:6px 12px;margin:0 0 6px 10px;font-weight:700;color:' + (th.ink || th.c1) + ';}' +
      '.hd-ico{font-size:1.9rem;line-height:1;}.hd-crop small{display:block;font-weight:500;font-size:.72rem;color:#5f5a55;}' +
      '.lb-page img{display:block;max-width:100%;max-height:170mm;margin:8px auto;object-fit:contain;border:1px solid #e1ded8;border-radius:8px;}.lb-page .lb-cap{text-align:center;font-size:.85rem;color:#4a4744;}' +
      '.hd h1{font-size:1.55rem;font-weight:800;}.hd .sub{font-size:.95rem;font-weight:500;}.hd .kpi{font-size:.9rem;font-weight:600;color:#262220;}' +
      'h2{font-size:1.12rem;font-weight:800;}h3{font-size:.98rem;font-weight:700;}' +
      'th,td{font-size:.8rem;padding:5px 7px;line-height:1.45;}th{font-weight:800;}td{font-weight:500;color:#1b1b1b;}' +
      '.qty{font-size:.86rem;font-weight:800;}.rate,.mode{font-size:.74rem;}.rate{color:#4a4744;}' +
      '.mini td{font-size:.8rem;}.mini td.loads{font-size:.78rem;color:#262220;}' +
      '.mt-kv td{font-size:.78rem;}.mt-ai{font-size:.82rem;}.mt-use{font-size:.78rem;font-weight:600;}' +
      '.ps-tbl th{font-size:.74rem;}.ps-tbl td{font-size:.78rem;}.ps-tbl td.ps-x{font-size:.76rem;}';
  }
  function printCss(th) {
    return '' +
      '@page{size:A4 ' + th.orientation + ';margin:14mm;}' +
      'body{font-family:Rubik,Heebo,Arial,sans-serif;direction:rtl;color:#222;background:#fff;padding:0;margin:0;}' +
      // Soft letterhead (Oct 2026): tinted band, dark ink, no gradient.
      '.hd{background:' + (th.soft || '#e4eee8') + ';color:' + (th.ink || th.c1) + ';' +
        'padding:18px 22px;border-radius:' + th.radius + 'px;margin:4px 0 14px;}' +
      '.hd h1{margin:0;font-size:1.4rem;font-weight:700;color:' + (th.ink || th.c1) + ';}' +
      '.hd .sub{color:#5f5a55;font-size:.9rem;margin-top:3px;}' +
      '.hd .kpi{margin-top:10px;font-size:.82rem;color:#3f3a36;}' +
      '.wrap{padding:0 14px 14px;}' +
      'h2{font-size:1rem;font-weight:700;margin:16px 0 6px;color:' + (th.ink || th.c2) + ';border-bottom:2px solid ' + (th.line || th.c3) + ';' +
        'padding-bottom:3px;}' +
      'h3{font-size:.9rem;margin:0 0 4px;color:' + th.c2 + ';}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:10px;}' +
      'th,td{border:1px solid #e1ded8;padding:4px 6px;font-size:.7rem;text-align:right;vertical-align:top;}' +
      'th{background:' + (th.soft || '#e4eee8') + ';color:' + (th.ink || th.c1) + ';font-weight:700;border-color:' + (th.line || '#c6d8cd') + ';}' +
      'tfoot td{font-weight:700;background:' + (th.soft || '#f2f6f3') + ';}' +
      '.qty{color:' + th.accent + ';font-weight:800;font-size:.76rem;}' +
      '.rate{color:#666;font-size:.66rem;}' +
      '.mode{color:#8a5a2b;font-size:.66rem;font-weight:700;}' +
      '.farms{display:flex;flex-wrap:wrap;gap:10px;}' +
      '.farm{flex:1 1 220px;border:1px solid ' + (th.line || '#d5ddd7') + ';border-radius:' + th.radius + 'px;padding:8px 10px;break-inside:avoid;}' +
      '.mini td.loads{background:#f6f8f5;border-radius:6px;padding:4px 6px;font-size:.68rem;color:#3f3a36;line-height:1.5;}' +
      '.mini td.loads b{color:' + (th.ink || th.c1) + ';}' +
      '.mini td.loads.warn{background:#fdf3ea;color:#8a4b1b;}' +
      // Materials page
      '.mt-page{break-before:page;page-break-before:always;}' +
      '.mt-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;}' +
      '.mt-card{border:1px solid ' + (th.line || '#d5ddd7') + ';border-radius:14px;padding:10px 12px;display:flex;gap:12px;break-inside:avoid;page-break-inside:avoid;}' +
      '.mt-info{flex:1;min-width:0;}' +
      '.mt-info h3{font-size:1rem;margin:0 0 2px;color:' + (th.ink || th.c1) + ';}' +
      '.mt-ai{font-size:.76rem;color:#3f3a36;margin-bottom:6px;font-weight:600;line-height:1.5;}' +
      '.mt-ai span{font-weight:400;color:#6b6560;}' +
      '.mt-kv{width:100%;border-collapse:collapse;margin:0;}' +
      '.mt-kv td{border:none;border-bottom:1px solid #eeebe6;font-size:.7rem;padding:3px 0;}' +
      '.mt-kv td:first-child{color:#6b6560;width:40%;}' +
      '.mt-use{margin-top:7px;background:' + (th.soft || '#e4eee8') + ';border-radius:8px;padding:5px 8px;font-size:.7rem;color:' + (th.ink || th.c1) + ';}' +
      '.mt-label{flex:0 0 46mm;text-align:center;font-size:.62rem;color:#6b6560;}' +
      '.mt-label img{width:100%;max-height:62mm;object-fit:contain;border:1px solid #e1ded8;border-radius:8px;background:#fff;}' +
      '.mt-qr{width:30mm;height:30mm;margin:4mm auto 3px;}' +
      '.mt-qr svg{width:100%;height:100%;}' +
      '.mt-label a{color:' + (th.ink || th.c1) + ';word-break:break-all;}' +
      '.mt-none{border:1px dashed #d8d3cc;border-radius:8px;padding:14px 6px;margin-top:4mm;}' +
      '.farm .note{font-size:.72rem;color:#8a5a2b;margin:0 0 5px;font-style:italic;}' +
      '.mini td{border:none;border-bottom:1px solid #eee;font-size:.72rem;padding:2px 0;}' +
      '.mini td.op{font-weight:800;color:#2d6a4f;padding-top:6px;border-bottom:1px solid #cfd8d2;}' +
      '.sig{margin-top:26px;display:flex;gap:40px;font-size:.78rem;}' +
      '.sig div{flex:1;border-top:1px solid #999;padding-top:4px;}' +
      '.ft{margin-top:16px;font-size:.72rem;color:#666;}' +
      '.hd .unit{margin-top:8px;font-size:1.05rem;font-weight:800;}' +
      'td.dl{font-weight:800;color:#b3261e;white-space:nowrap;}' +
      '.page{break-after:page;page-break-after:always;}' +
      '.page:last-child{break-after:auto;page-break-after:auto;}' +
      'tr{break-inside:avoid;page-break-inside:avoid;}';
  }

  // o: { unit: heading for this page ('' = whole plan), prices: bool }
  // The crop of the farms on this sheet: icon and crop name in the header.
  function cropBadge(rows) {
    var fids = farmIdsOf(rows);
    if (fids.length !== 1) return '';
    var fid = fids[0], cnt = {};
    plots().forEach(function (pl) { if (Number(pl.farm_id) !== Number(fid)) return; var c = String(pl.crop_type || '').trim(); if (c) cnt[c] = (cnt[c] || 0) + (Number(pl.area) || 1); });
    var crop = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; })[0] || '';
    var vars = {};
    plots().forEach(function (pl) { if (Number(pl.farm_id) === Number(fid) && pl.variety) vars[pl.variety] = 1; });
    return '<div class="hd-crop"><span class="hd-ico">' + farmIco(fid) + '</span><span>' + esc(crop) + (Object.keys(vars).length ? '<small>' + esc(Object.keys(vars).slice(0, 3).join(' · ')) + '</small>' : '') + '</span></div>';
  }
  function pageHtml(p, rowsIn, th, o) {
    var t = totals({ rows: rowsIn });
    var rows = '';
    rowsIn.forEach(function (r) {
      var pl = plotById(r.plotId);
      var m = r.materials || [];
      var cells = '';
      // One cell per material carrying BOTH the concentration and the litres
      // that plot needs. A reader should never have to multiply anything.
      for (var k = 0; k < 3; k++) {
        if (m[k]) {
          cells += '<td><b>' + esc(m[k].name) + '</b><br>' +
            '<span class="rate">' + doseText(m[k], p, r.method) +
            '</span><br><span class="qty">' + fmtQty(rowMaterialL(r, m[k]), U(m[k].name, p)) + '</span></td>';
        } else cells += '<td></td>';
      }
      rows += '<tr><td><b>' + esc(methodLabel(r.method)) + '</b></td>' +
        '<td>' + esc(farmName(r.farmId)) + '</td>' +
        '<td>' + esc((pl ? pl.name : '') + (r.cohort ? ' - ' + r.cohort : '')) + '</td>' +
        '<td>' + (r.trees || 0).toLocaleString() + '</td>' + cells +
        '<td>' + esc(r.round) + '</td><td>' + esc([r.start ? '▶ ' + fmtDate(r.start) : '', r.timing].filter(Boolean).join(' · ')) + '</td>' +
        '<td class="dl">' + esc(fmtDate(effDeadline(p, r))) + '</td>' +
        '<td>' + n1(r.carrier) + ' ' + (r.method === 'inject'
          ? tt('סמ"ק', 'ซีซี', 'سم³') : tt('ליטר', 'ลิตร', 'لتر')) + '</td>' +
        '<td><b>' + n1(rowCarrierL(r)).toLocaleString() + '</b></td></tr>';
    });

    var totRows = '';
    Object.keys(t.byMat).sort().forEach(function (nm) {
      totRows += '<tr><td>' + esc(nm) + '</td><td><b>' + fmtQty(t.byMat[nm], U(nm, p)) + '</b></td>' +
        (o.prices ?
          '<td>' + (t.price[nm] ? money(t.price[nm]) : '-') + '</td>' +
          '<td>' + (t.price[nm] ? money(t.byMat[nm] * t.price[nm]) : '-') + '</td>' : '') +
        '</tr>';
    });

    // Solution litres per farm × operation, for the sprayer-load figures.
    var solByOp = {};
    rowsIn.forEach(function (r) {
      var fid = (r.farmId === null || r.farmId === undefined) ? 0 : r.farmId;
      var key = fid + '#' + opKey(r.method, r.round);
      solByOp[key] = (solByOp[key] || 0) + rowCarrierL(r);
    });

    var farmSec = '';
    Object.keys(t.farmOps).forEach(function (fid) {
      var ops = t.farmOps[fid];
      var body = Object.keys(ops).map(function (k) {
        var op = ops[k];
        var names = Object.keys(op.mats).sort();
        var loads = loadsHtml(Number(fid), op, solByOp[fid + '#' + k] || 0);
        if (!names.length) return '';
        return '<tr><td colspan="2" class="op">' + esc(opLabel(op.method, op.round)) + '</td></tr>' +
          names.map(function (nm) {
            return '<tr><td>' + esc(nm) + '</td><td><b>' + fmtQty(op.mats[nm], U(nm, p)) + '</b></td></tr>';
          }).join('') + loads;
      }).join('');
      if (!body) return;
      var note = (p.farmNotes || {})[String(fid)] || '';
      farmSec += '<div class="farm"><h3>' + farmIco(Number(fid)) + ' ' + esc(farmName(Number(fid))) + '</h3>' +
        (note ? '<p class="note">' + esc(note) + '</p>' : '') +
        '<table class="mini"><tbody>' + body + '</tbody></table></div>';
    });

    return '<section class="page">' +
      '<div class="hd">' + cropBadge(rowsIn) + '<h1>' + esc(p.docTitle || p.name || tt('תוכנית טיפול', 'แผน', 'خطة')) + '</h1>' +
        (p.docSub ? '<div class="sub">' + esc(p.docSub) + '</div>' : '') +
        (o.unit ? '<div class="unit">' + esc(o.unit) + '</div>' : '') +
        '<div class="kpi">' +
          (p.target ? tt('מזיק', 'ศัตรูพืช', 'الآفة') + ': ' + esc(p.target) + ' · ' : '') +
          tt('עונה', 'ฤดูกาล', 'الموسم') + ' ' + esc(year) + ' · ' +
          treesText(t) + ' · ' +
          ((t.ops || []).length > 1 ? opsLine(t, ' · ') : n1(t.waterL).toLocaleString() + ' ' + tt('ליטר תמיסה', 'ลิตร', 'لتر محلول')) +
          (earliestDeadline(p, rowsIn) ? ' \u00b7 ' + tt('לסיום עד', 'เสร็จภายใน', 'الإنهاء حتى') + ' ' +
            fmtDate(earliestDeadline(p, rowsIn)) : '') +
        '</div></div>' +

      '<div class="wrap">' +
      (p.notes ? '<p style="font-size:.82rem;">' + esc(p.notes) + '</p>' : '') +
      (String(p.prep || '').trim() ? '<div style="border:1.5px solid #1d5a2c;border-radius:8px;padding:6px 10px;margin:6px 0 10px;font-size:.8rem;background:#f4f9ea;-webkit-print-color-adjust:exact;print-color-adjust:exact;"><b>🧰 ' +
        tt('דגשים לביצוע והכנות', 'ข้อควรปฏิบัติ', 'إرشادات التنفيذ') + '</b><div style="white-space:pre-line;margin-top:3px;">' + esc(String(p.prep).replace(/\u2014/g, '-')) + '</div></div>' : '') +
      (p.zones && p.zones.on ? '<div style="display:flex;gap:12px;align-items:flex-start;border:1.5px solid #ef6c00;border-radius:8px;padding:6px 10px;margin:0 0 10px;font-size:.78rem;background:#fff7ef;break-inside:avoid;page-break-inside:avoid;-webkit-print-color-adjust:exact;print-color-adjust:exact;">' +
        '<div style="flex:0 0 200px;">' + zonesFigure(p.zones, 200) + '</div><div style="flex:1;"><b>🌴 ' + tt('אופן הריסוס בעץ - חלוקת הנפח', 'วิธีพ่นบนต้น - สัดส่วนปริมาตร', 'طريقة الرش - توزيع الحجم') + '</b>' +
        zonesTable(p.zones, rowsIn).replace('class="ap-ztbl"', 'style="width:100%;border-collapse:collapse;margin-top:4px;font-size:.76rem;"') + '</div></div>' : '') +

      '<table><thead><tr>' +
        '<th>' + tt('אופן יישום', 'วิธี', 'طريقة') + '</th><th>' + tt('משק', 'ฟาร์ม', 'مزرعة') + '</th>' +
        '<th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th><th>' + ((rowsIn || []).some(function (x) { return isDunam(x.method); }) ? tt('עצים / דונם', 'ต้น / ไร่', 'أشجار / دونم') : tt('עצים', 'ต้น', 'أشجار')) + '</th>' +
        '<th>' + tt('חומר 1 / כמות לחלקה', 'สาร 1', 'مادة 1') + '</th>' +
        '<th>' + tt('חומר 2 / כמות לחלקה', 'สาร 2', 'مادة 2') + '</th>' +
        '<th>' + tt('חומר 3 / כמות לחלקה', 'สาร 3', 'مادة 3') + '</th>' +
        '<th>' + tt('סיבוב', 'รอบ', 'جولة') + '</th><th>' + tt('מועד מומלץ', 'ช่วงเวลา', 'الموعد') + '</th>' +
        '<th>' + tt('סיום עד', 'เสร็จภายใน', 'الإنهاء حتى') + '</th>' +
        '<th>' + tt('לעץ', 'ต่อต้น', 'لكل شجرة') + '</th>' +
        '<th>' + tt('סה"כ תמיסה (ל\')', 'รวมสารละลาย', 'إجمالي المحلول') + '</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>' +

      '<h2>' + (o.unit ? tt('סה"כ חומרים', 'รวมสาร', 'إجمالي المواد') :
                         tt('סה"כ חומרים להזמנה', 'รวมสารสั่งซื้อ', 'إجمالي المواد للطلب')) + '</h2>' +
      '<table><thead><tr><th>' + tt('חומר', 'สาร', 'مادة') + '</th><th>' +
        tt('כמות', 'ปริมาณ', 'الكمية') + '</th>' +
        (o.prices ? '<th>' + tt('מחיר ליחידה (ליטר / ק״ג)', 'ราคา/หน่วย', 'سعر/وحدة') + '</th><th>' +
          tt('עלות', 'ต้นทุน', 'التكلفة') + '</th>' : '') +
        '</tr></thead><tbody>' + totRows + '</tbody>' +
        (o.prices ? '<tfoot><tr><td colspan="3">' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td>' +
          money(t.cost) + '</td></tr></tfoot>' : '') + '</table>' +

      (farmSec ? '<h2>' + tt('פילוח לפי משק ופעולה', 'แยกตามฟาร์มและการดำเนินการ', 'حسب المزرعة والعملية') + '</h2>' +
        '<div class="farms">' + farmSec + '</div>' : '') +

      (th.signature ? '<div class="sig"><div>' + tt('אחראי הגנת הצומח', 'ผู้รับผิดชอบ', 'مسؤول وقاية النبات') +
        '</div><div>' + tt('מנהל המשק', 'ผู้จัดการฟาร์ม', 'مدير المزرعة') + '</div></div>' : '') +
      '<div class="ft">' + (th.footer ? esc(th.footer) + '<br>' : '') +
        '\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD \u00b7 ' +
        new Date().toLocaleDateString('he-IL') + '</div>' +
      '</div></section>';
  }

  // pages: [{ unit, rows }] - one printed page each, in one document, so a
  // single "Save as PDF" yields every grower's sheet and the browser does
  // not block a second popup.
  function exportPages(p, pages, o, suffix) {
    var th = planTheme(p);
    var RM = window.ReportMap;
    // Each grower sheet is followed by one plots page per מטע it covers
    // (never repeated within a document); the materials page closes it.
    var shown = {};
    // Only the plots actually exported appear on a מטע's plots page. A row
    // with no plot (a whole-farm row) brings the whole farm.
    var sheetIds = {};
    pages.forEach(function (pg) {
      (pg.rows || []).forEach(function (r) {
        var pl = r.plotId ? plotById(r.plotId) : null;
        // A plot is drawn on ITS farm's page even if the row names another
        // farm (a plot moved between farms used to vanish from the sheet).
        var fid = pl ? pl.farm_id : r.farmId;
        if (!fid) return;
        if (!pl) { sheetIds[fid] = 'all'; return; }
        if (sheetIds[fid] === 'all') return;
        (sheetIds[fid] = sheetIds[fid] || []).push(pl.id);
      });
    });
    var allPlanRows = [];
    pages.forEach(function (pg) { allPlanRows = allPlanRows.concat(pg.rows || []); });
    var body = pages.map(function (pg) {
      var out = pageHtml(p, pg.rows, th, { unit: pg.unit, prices: o.prices });
      if (RM && RM.plotSheet) {
        var fids = farmIdsOf(pg.rows);
        (pg.rows || []).forEach(function (r) { var pl = r.plotId ? plotById(r.plotId) : null; if (pl && pl.farm_id && fids.indexOf(pl.farm_id) === -1) fids.push(pl.farm_id); });
        fids.forEach(function (fid) {
          if (shown[fid]) return;
          shown[fid] = true;
          // Every plot of the orchard is listed; the ones in the plan carry
          // their trees, materials and sprayer fills.
          out += RM.plotSheet(fid, th, { plotIds: null, extra: { head: tt('בתוכנית - כמויות למרסס', 'ในแผน - ปริมาณ', 'في الخطة - الكميات'), cells: plotCells(fid, allPlanRows) } });
        });
      }
      return out;
    }).join('');
    var allRows = [];
    pages.forEach(function (pg) { allRows = allRows.concat(pg.rows || []); });
    var mats = materialsPage(allRows, th) + labelPages(allRows);
    // o.fileName: the browser's "Save as PDF" names the file after <title>.
    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc(o.fileName || ((p.docTitle || p.name) + (suffix ? ' - ' + suffix : ''))) + '</title>' +
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;600;700&display=swap">' +
      '<style>' + printCss(th) + (RM && RM.plotSheetCss ? RM.plotSheetCss(th) : '') + readCss(th) + '</style></head><body>' +
      body + mats +
      // QR codes for official labels that have no attached photo. Drawn in
      // the print window; if the library cannot load, the printed link stays.
      (mats.indexOf('data-qr=') !== -1
        ? '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js"></script>' +
          '<script>(function(){try{document.querySelectorAll("[data-qr]").forEach(function(el){' +
          'var q=qrcode(0,"M");q.addData(el.getAttribute("data-qr"));q.make();el.innerHTML=q.createSvgTag({cellSize:3,margin:2,scalable:true});});}catch(e){}})();</script>'
        : '') +
      '</body></html>';
    if (o.returnHtml) return { html: html, orientation: th.orientation || 'landscape' };
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, o.fileName ? o.fileName + '.html' : (p.docTitle || p.name || 'plan').replace(/\s+/g, '_') +
        (suffix ? '_' + suffix.replace(/\s+/g, '_') : '') + '_' + year + '.html');
    }
  }

  function farmIdsOf(rows) {
    var seen = {}, out = [];
    (rows || []).forEach(function (r) {
      var fid = r.farmId;
      if (fid === null || fid === undefined) { var pl = plotById(r.plotId); fid = pl ? pl.farm_id : null; }
      if (fid && !seen[fid]) { seen[fid] = true; out.push(fid); }
    });
    return out;
  }

  // Per plot of an orchard: what the plan does there - operation, trees (or
  // dunam), each material's total, the solution, and for tank operations
  // what goes into one full tank of the farm's largest sprayer and how many
  // fills the plot takes. Used in the plots column of the orchard page.
  function plotCells(fid, rows) {
    var lt = tt('ל\'', 'ล.', 'ل'), out = {};
    var sprayers = (window.SprayStore && SprayStore.getFarmSprayers) ? SprayStore.getFarmSprayers(Number(fid)) : [];
    var sp = sprayers[0] || null;
    (rows || []).forEach(function (r) {
      var pl = r.plotId ? plotById(r.plotId) : null;
      if (!pl || Number(pl.farm_id) !== Number(fid)) return;
      var mats = (r.materials || []).filter(function (m) { return m && m.name; });
      var solL = rowCarrierL(r);
      var line = '<div><span class="px-op">' + esc(opLabel(r.method, r.round)) + '</span> · <span class="px-t">' +
        (Number(r.trees) || 0).toLocaleString() + ' ' + qtyWord(r.method) + '</span>';
      if (mats.length) line += '<br>' + mats.map(function (m) { return esc(m.name) + ' <b>' + fmtQty(rowMaterialL(r, m), U(m.name)) + '</b>'; }).join(' · ');
      if (r.start) line += ' · <span class="px-t">▶ ' + esc(fmtDate(r.start)) + '</span>';
      if (r.method === 'drench' && r.container > 0 && solL > 0) {
        var nb = Math.ceil(solL / r.container);
        line += '<br>' + tt('תמיסה', 'สารละลาย', 'محلول') + ' ' + n1(solL).toLocaleString() + ' ' + lt + ' · 🪣 ' + r.container + ' ' + lt + ' → <b>' + nb + ' ' + tt('דליים', 'ถัง', 'دلاء') + '</b>' +
          (mats.length ? '<br>' + tt('לדלי', 'ต่อถัง', 'لكل دلو') + ': ' + mats.map(function (m) { return esc(m.name) + ' <b>' + fmtSmall(r.container * (rowMaterialL(r, m) / solL), U(m.name)) + '</b>'; }).join(' · ') : '');
        out[pl.id] = (out[pl.id] || '') + line + '</div>';
        return;
      }
      var tank = r.method !== 'inject' && r.method !== 'drench_irr' && solL > 0;
      if (tank) {
        line += '<br>' + tt('תמיסה', 'สารละลาย', 'محلول') + ' ' + n1(solL).toLocaleString() + ' ' + lt;
        if (sp) {
          var fills = Math.ceil(solL / sp.capacityL);
          var per = mats.map(function (m) {
            var q = sp.capacityL * (rowMaterialL(r, m) / solL);
            return esc(m.name) + ' <b>' + fmtSmall(q, U(m.name)) + '</b>';
          }).join(' · ');
          line += ' · 🚜 ' + esc(sp.name) + ' ' + sp.capacityL.toLocaleString() + ' ' + lt + ' → <b>' + fills + ' ' +
            (fills === 1 ? tt('מילוי', 'ถัง', 'تعبئة') : tt('מילויים', 'ถัง', 'تعبئات')) + '</b>' +
            (per ? '<br>' + tt('למרסס מלא', 'ต่อถังเต็ม', 'لكل خزان ممتلئ') + ': ' + per : '');
        } else line += ' · <span style="color:#b3261e;">' + tt('לא הוגדר מרסס למשק', 'ยังไม่ได้กำหนดถังพ่น', 'لا رشاش للمزرعة') + '</span>';
      }
      out[pl.id] = (out[pl.id] || '') + line + '</div>';
    });
    return out;
  }

  // ── Sprayer loads per מטע × operation ──
  // Uses the sprayers defined on the farm card (ציוד → מרסס, with tank
  // volume). Per sprayer: how many fills the operation takes, and what goes
  // into one full tank - derived from the plan's own product:solution ratio,
  // so it holds for % and cc/tree recipes alike. Trunk injection uses no tank.
  function loadsHtml(fid, op, solL) {
    if (op.method === 'inject' || op.method === 'drench_irr' || !(solL > 0)) return '';
    if (op.method === 'drench') {
      // Manual drench: mixed in buckets, not in a sprayer tank.
      var ltb = tt('ל\'', 'ล.', 'ل');
      if (!(op.container > 0)) return '<tr><td colspan="2" class="loads">' + tt('תמיסה', 'สารละลาย', 'محلول') + ': <b>' + n1(solL).toLocaleString() + ' ' + ltb + '</b></td></tr>';
      var nb = Math.ceil(solL / op.container);
      var perB = Object.keys(op.mats).sort().map(function (nm) {
        var q = op.container * (op.mats[nm] / solL);
        return esc(nm) + ' ' + fmtSmall(q, U(nm));
      }).join(' · ');
      return '<tr><td colspan="2" class="loads">' + tt('תמיסה', 'สารละลาย', 'محلول') + ': <b>' + n1(solL).toLocaleString() + ' ' + ltb + '</b><br>🪣 ' +
        tt('דלי', 'ถัง', 'دلو') + ' ' + op.container + ' ' + ltb + ' → <b>' + nb + ' ' + tt('דליים', 'ถัง', 'دلاء') + '</b>' +
        (perB ? '<br>' + tt('לדלי', 'ต่อถัง', 'لكل دلو') + ': ' + perB : '') + '</td></tr>';
    }
    var sprayers = (window.SprayStore && SprayStore.getFarmSprayers) ? SprayStore.getFarmSprayers(fid) : [];
    var lt = tt('ל\'', 'ล.', 'ل');
    if (!sprayers.length) {
      return '<tr><td colspan="2" class="loads warn">' + tt('תמיסה', 'สารละลาย', 'محلول') + ': <b>' +
        n1(solL).toLocaleString() + ' ' + lt + '</b> · ' +
        tt('לא הוגדר מרסס למשק - הגדר בכרטיס המשק ← ציוד', 'ยังไม่ได้กำหนดถังพ่นของฟาร์ม', 'لم يُحدد رشاش للمزرعة') + '</td></tr>';
    }
    var names = Object.keys(op.mats).sort();
    var lines = sprayers.map(function (sp) {
      var fills = Math.ceil(solL / sp.capacityL);
      var per = names.map(function (nm) {
        var q = sp.capacityL * (op.mats[nm] / solL);
        return esc(nm) + ' ' + (q < 10 ? Math.round(q * 100) / 100 : n1(q)) + ' ' + lt;
      }).join(' · ');
      return '<b>' + esc(sp.name) + '</b>' + (sp.kindLabel ? ' · ' + esc(sp.kindLabel) : '') + ' · ' +
        sp.capacityL.toLocaleString() + ' ' + lt + ' → <b>' + fills + ' ' +
        (fills === 1 ? tt('מילוי', 'ถัง', 'تعبئة') : tt('מילויים', 'ถัง', 'تعبئات')) + '</b>' +
        (per ? '<br>' + tt('למילוי מלא', 'ต่อถังเต็ม', 'لكل تعبئة كاملة') + ': ' + per : '');
    });
    if (sprayers.length > 1) {
      var cap = sprayers.reduce(function (a, sp) { return a + sp.capacityL; }, 0);
      lines.push(tt('כל המרססים יחד', 'ทุกถังพร้อมกัน', 'جميع الرشاشات معًا') + ' (' + cap.toLocaleString() + ' ' + lt + '): <b>' +
        Math.ceil(solL / cap) + ' ' + tt('סבבים', 'รอบ', 'جولات') + '</b>');
    }
    return '<tr><td colspan="2" class="loads">' + tt('תמיסה', 'สารละลาย', 'محلول') + ': <b>' +
      n1(solL).toLocaleString() + ' ' + lt + '</b><br>' + lines.join('<br>') + '</td></tr>';
  }

  // ── Recommended materials page ──
  // Every material in the document, with what the catalogue knows about it
  // (from the Ministry registry import) and its label: an attached label
  // photo when one exists, otherwise a QR code to the official label.
  function catalogueFor(name) {
    var all = (window.SprayStore && SprayStore.getPesticides) ? SprayStore.getPesticides() : [];
    var nm = String(name || '').trim();
    var hits = all.filter(function (x) { return String(x.productName || '').trim() === nm; });
    if (!hits.length) return null;
    hits.sort(function (a, b) {
      function score(x) { return (x.labelImage ? 4 : 0) + (/תמר/.test(String(x.crop || x.commonTargets || '')) ? 2 : 0) + (x.labelUrl ? 1 : 0); }
      return score(b) - score(a);
    });
    var best = hits[0];
    // Targets across the product's registrations, for the "against" line.
    var pests = {};
    hits.forEach(function (x) { String(x.pest || '').split(/[,،]/).forEach(function (s) { s = s.trim(); if (s) pests[s] = true; }); });
    best = JSON.parse(JSON.stringify(best));
    best._pests = Object.keys(pests).slice(0, 8);
    return best;
  }

  var QR_LIB = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
  function preloadQr() {
    if (window.qrcode || document.getElementById('apQrLib')) return;
    var sc = document.createElement('script'); sc.id = 'apQrLib'; sc.src = QR_LIB; document.head.appendChild(sc);
  }
  function qrSvg(url) {
    if (!window.qrcode || !url) return '';
    try { var q = window.qrcode(0, 'M'); q.addData(String(url)); q.make(); return q.createSvgTag({ cellSize: 4, margin: 4, scalable: true }); } catch (e) { return ''; }
  }
  // A full page per label photo, after the materials page.
  function labelPages(rows) {
    var seen = {}, out = '';
    (rows || []).forEach(function (r) { (r.materials || []).forEach(function (m) { if (m.name) seen[m.name] = 1; }); });
    Object.keys(seen).sort().forEach(function (nm) {
      var c = catalogueFor(nm);
      if (!c || !c.labelImage) return;
      out += '<section class="page lb-page"><div class="hd"><h1>' + tt('תווית', 'ฉลาก', 'الملصق') + ': ' + esc(nm) + '</h1>' +
        (c.regNumber ? '<div class="sub">' + tt('מספר רישיון', 'เลขทะเบียน', 'رقم الترخيص') + ' ' + esc(c.regNumber) + '</div>' : '') + '</div>' +
        '<div class="wrap"><img src="' + esc(c.labelImage) + '" alt=""><div class="lb-cap">' + tt('התווית השמורה במאגר החומרים', 'ฉลากที่บันทึกไว้', 'الملصق المحفوظ') + '</div></div></section>';
    });
    return out;
  }
  function materialsPage(rows, th) {
    var use = {};      // name -> { L, rates:{}, ops:{} }
    (rows || []).forEach(function (r) {
      (r.materials || []).forEach(function (m) {
        if (!m.name) return;
        var u = use[m.name] || (use[m.name] = { L: 0, rates: {}, ops: {} });
        u.L += rowMaterialL(r, m);
        u.rates[doseText(m, null, r.method)] = true;
        u.ops[methodLabel(r.method)] = true;
      });
    });
    var names = Object.keys(use).sort();
    if (!names.length) return '';
    var cards = names.map(function (nm) {
      var c = catalogueFor(nm), u = use[nm];
      var kv = [];
      function row(label, val) { if (val) kv.push('<tr><td>' + label + '</td><td>' + esc(val) + '</td></tr>'); }
      // Only what the person mixing and spraying needs: what is in it, how
      // much, how long before harvest, how dangerous, against what.
      if (c) {
        row(tt('מינון רשום', 'อัตราที่จดทะเบียน', 'الجرعة المسجلة'), c.dosage);
        row(tt('ימי המתנה לקטיף', 'ระยะรอเก็บเกี่ยว', 'فترة الانتظار'), c.phi ? c.phi + ' ' + tt('ימים', 'วัน', 'أيام') : '');
        row(tt('רעילות', 'ความเป็นพิษ', 'السمية'), c.toxicity);
        row(tt('נגד', 'สำหรับ', 'ضد'), (c._pests || []).join(', '));
        row(tt('מספר רישיון', 'เลขทะเบียน', 'رقم الترخيص'), c.regNumber);
      }
      // Every active ingredient, each with its own concentration.
      var ais = c && c.activeIngredient ? String(c.activeIngredient).split(/\s*\+\s*/) : [];
      var concs = c && c.concentration ? String(c.concentration).split(/\s*\+\s*/) : [];
      var aiHtml = ais.map(function (a, i) {
        var cc = ais.length === concs.length ? concs[i] : (i === 0 && ais.length === 1 ? concs.join(' + ') : '');
        return '<div>' + esc(a) + (cc ? ' <span>' + esc(cc) + '</span>' : '') + '</div>';
      }).join('');
      if (ais.length > 1 && concs.length && concs.length !== ais.length) {
        aiHtml += '<div><span>' + esc(concs.join(' + ')) + '</span></div>';
      }
      var label;
      if (c && c.labelImage) {
        label = '<img src="' + esc(c.labelImage) + '" alt=""><div>' + tt('תווית המוצר', 'ฉลากสินค้า', 'ملصق المنتج') + '</div>';
      } else if (c && c.labelUrl) {
        label = '<div class="mt-qr"' + (qrSvg(c.labelUrl) ? '>' + qrSvg(c.labelUrl) : ' data-qr="' + esc(c.labelUrl) + '">') + '</div>' +
          '<div>' + tt('סרוק לתווית הרשמית', 'สแกนเพื่อดูฉลาก', 'امسح للملصق الرسمي') + '</div>';
      } else {
        label = '<div class="mt-none">' + tt('אין תווית שמורה', 'ไม่มีฉลาก', 'لا يوجد ملصق') + '</div>';
      }
      return '<div class="mt-card"><div class="mt-info">' +
          '<h3>' + esc(nm) + '</h3>' +
          '<div class="mt-ai">' + (aiHtml ||
            (c ? '' : tt('לא נמצא במאגר החומרים', 'ไม่พบในฐานข้อมูล', 'غير موجود في قاعدة البيانات'))) + '</div>' +
          (kv.length ? '<table class="mt-kv"><tbody>' + kv.join('') + '</tbody></table>' : '') +
          '<div class="mt-use">' + tt('בתוכנית', 'ในแผน', 'في الخطة') + ': ' +
            esc(Object.keys(u.ops).join(', ')) + ' · ' + esc(Object.keys(u.rates).join(', ')) + ' · <b>' +
            fmtQty(u.L, U(nm)) + '</b></div>' +
        '</div><div class="mt-label">' + label + '</div></div>';
    }).join('');
    return '<section class="page mt-page"><div class="hd"><h1>' +
      tt('החומרים המומלצים', 'สารที่แนะนำ', 'المواد الموصى بها') + '</h1>' +
      '<div class="sub">' + tt('פרטי רישום ותוויות', 'ข้อมูลการขึ้นทะเบียนและฉลาก', 'بيانات التسجيل والملصقات') + '</div></div>' +
      '<div class="wrap"><div class="mt-grid">' + cards + '</div>' +
      '<div class="ft">' + tt('יש לפעול לפי התווית הרשמית. הנתונים נלקחו ממאגר משרד החקלאות כפי שנשמר במערכת.',
        'ปฏิบัติตามฉลากทางการ', 'يجب العمل وفق الملصق الرسمي') + '</div></div></section>';
  }

  // ── Supplier quantity sheet / request for quotation ──
  // Quantities per מטע, no prices: what a warehouse or supplier needs to
  // quote. Always branded שורשים regardless of the plan's print theme - it
  // leaves the company, the grower sheets do not.
  var BRAND = { dark: '#1b3a1e', mid: '#2e7d32', light: '#c8e6c9' };
  // The Shorashim Plus mark (triangle with three cuts, from the printed
  // logo). Gradient ids are numbered so header + footer marks in one sheet
  // never share an id.
  var _brandSeq = 0;
  function brandMark(size) {
    var n = ++_brandSeq;
    return '<svg class="mark" style="direction:ltr" viewBox="0 0 118 100" width="' + Math.round(size * 1.18) + '" height="' + size + '" aria-hidden="true">' +
      '<defs><linearGradient id="spA-ag' + n + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#12401f"/><stop offset="0.3" stop-color="#2c6e2a"/><stop offset="1" stop-color="#b5dc55"/></linearGradient>' +
      '<linearGradient id="spB-ag' + n + '" x1="0.22" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#1d5a2c"/><stop offset="0.5" stop-color="#5e9c35"/><stop offset="1" stop-color="#cfe97a"/></linearGradient></defs>' +
      '<path fill="url(#spA-ag' + n + ')" d="M56 6 L117.4 94 L30.9 94 L68.3 34.6 L27.7 94 L21.2 94 L63.7 26.5 L18 94 L11 94 L57.7 19.9 L7.8 94 L0.6 94 Z"/>' +
      '<path fill="url(#spB-ag' + n + ')" d="M72 28.8 L117.4 94 L30.9 94 Z"/></svg>';
  }

  // Litres per material for a set of rows, with the operations it serves.
  function matSummary(rows) {
    var out = {}, order = [];
    rows.forEach(function (r) {
      (r.materials || []).forEach(function (m) {
        if (!m.name) return;
        if (!out[m.name]) { out[m.name] = { L: 0, uses: [] }; order.push(m.name); }
        out[m.name].L += rowMaterialL(r, m);
        var u = methodLabel(r.method);
        if (out[m.name].uses.indexOf(u) < 0) out[m.name].uses.push(u);
      });
    });
    order.sort();
    return { names: order, map: out };
  }

  function rfqTable(sum) {
    if (!sum.names.length) {
      return '<p class="muted">' + tt('אין חומרים בשורות שנבחרו', 'ไม่มีสาร', 'لا مواد') + '</p>';
    }
    return '<table><thead><tr>' +
        '<th class="c">#</th><th>' + tt('חומר', 'สาร', 'مادة') + '</th>' +
        '<th>' + tt('שימוש', 'การใช้', 'الاستخدام') + '</th>' +
        '<th class="c">' + tt('כמות נדרשת', 'ปริมาณ', 'الكمية') + '</th>' +
        '<th class="fill">' + tt('גודל אריזה', 'ขนาดบรรจุ', 'حجم العبوة') + '</th>' +
        '<th class="fill">' + tt('מחיר ליחידה ₪', 'ราคาต่อหน่วย ₪', 'سعر الوحدة ₪') + '</th>' +
        '<th class="fill">' + tt('סה"כ ₪', 'รวม ₪', 'المجموع ₪') + '</th>' +
      '</tr></thead><tbody>' +
      sum.names.map(function (nm, i) {
        var it = sum.map[nm];
        return '<tr><td class="c">' + (i + 1) + '</td><td><b>' + esc(nm) + '</b></td>' +
          '<td>' + esc(it.uses.join(', ')) + '</td>' +
          '<td class="c qty">' + fmtQty(it.L, U(nm)) + '</td>' +
          '<td class="fill"></td><td class="fill"></td><td class="fill"></td></tr>';
      }).join('') +
      '</tbody></table>';
  }

  function rfqExport(p, rows, o) {
    if (!rows.length) { toast('⚠️ ' + tt('לא נבחרו שורות', 'ไม่ได้เลือก', 'لم تُختر صفوف')); return; }
    var u = window.currentUser || {};
    var contact = u.displayName || u.name || u.username || '';
    var ref = 'RFQ-' + year + '-' + String(p.id).slice(-5);
    var today = new Date().toLocaleDateString('he-IL');

    var fOrder = [], byFarm = {};
    rows.forEach(function (r) {
      var fid = String(r.farmId == null ? 0 : r.farmId);
      if (!byFarm[fid]) { byFarm[fid] = []; fOrder.push(fid); }
      byFarm[fid].push(r);
    });

    var head = function (sub) {
      return '<header class="brand">' + brandMark(54) +
          '<div class="bt"><div class="wm">' + tt('שורשים', 'โชราชิม', 'شوراشيم') + '</div>' +
          '<div class="tag">' + tt('ניהול חקלאי', 'การจัดการเกษตร', 'إدارة زراعية') + '</div></div>' +
          '<div class="doc"><div class="dt">' + tt('בקשה להצעת מחיר', 'ขอใบเสนอราคา', 'طلب عرض سعر') + '</div>' +
          '<div class="ds">' + tt('חומרי הגנת הצומח', 'สารป้องกันพืช', 'مواد وقاية النبات') + '</div></div>' +
        '</header>' +
        '<div class="meta">' +
          '<div><span>' + tt('מס\' בקשה', 'เลขที่', 'رقم الطلب') + '</span><b>' + esc(ref) + '</b></div>' +
          '<div><span>' + tt('תאריך', 'วันที่', 'التاريخ') + '</span><b>' + esc(today) + '</b></div>' +
          (o.to ? '<div><span>' + tt('לכבוד', 'ถึง', 'إلى') + '</span><b>' + esc(o.to) + '</b></div>' : '') +
          '<div><span>' + tt('עונה', 'ฤดูกาล', 'الموسم') + '</span><b>' + esc(year) + '</b></div>' +
        '</div>' +
        (sub ? '<h2 class="unit">' + sub + '</h2>' : '');
    };
    var terms = '<div class="terms"><b>' + tt('נא לציין בהצעה:', 'โปรดระบุ:', 'يرجى ذكر:') + '</b> ' +
      tt('מחיר ליחידה לפני מע"מ, גודל אריזה, זמינות במלאי, ותנאי תשלום. ' +
         'הכמויות מחושבות לפי תוכנית הטיפול ועשויות להתעדכן.',
         'ราคาต่อหน่วยก่อนภาษี ขนาดบรรจุ สต็อก วันส่ง และเงื่อนไขการชำระ',
         'سعر الوحدة قبل الضريبة، حجم العبوة، التوفر، موعد التوريد وشروط الدفع') + '</div>';
    var sign = '<div class="sig"><div>' + tt('שם הספק', 'ชื่อผู้จัดหา', 'اسم المورد') + '</div><div>' +
      tt('חתימה וחותמת', 'ลายเซ็นและตราประทับ', 'التوقيع والختم') + '</div><div>' +
      tt('תאריך', 'วันที่', 'التاريخ') + '</div></div>';
    var foot = '<footer>' + brandMark(16) + ' ' + tt('שורשים - ניהול חקלאי', 'โชราชิม', 'شوراشيم') +
      (contact ? ' · ' + tt('איש קשר', 'ผู้ติดต่อ', 'جهة الاتصال') + ': ' + esc(contact) : '') +
      (u.email ? ' · ' + esc(u.email) : '') + ' · ' + esc(ref) + '</footer>';

    var farmLabel = function (fid) {
      return '' + farmIco(Number(fid)) + ' ' + esc(farmName(Number(fid))) + ' <span class="muted">- ' +
        tt('נקודת אספקה', 'จุดส่ง', 'نقطة التوريد') + '</span>';
    };
    var pages = [];
    if (o.mode === 'farm') {
      fOrder.forEach(function (fid) {
        pages.push(head(farmLabel(fid)) + rfqTable(matSummary(byFarm[fid])) + terms + sign + foot);
      });
    } else {
      var all = head(fOrder.length > 1 ?
          tt('סיכום כמויות - כל המשקים', 'สรุปปริมาณ - ทุกฟาร์ม', 'ملخص الكميات - كل المزارع') : farmLabel(fOrder[0])) +
        rfqTable(matSummary(rows)) + terms;
      if (fOrder.length > 1) {
        all += '<h2>' + tt('פירוט לפי משק (נקודות אספקה)', 'แยกตามฟาร์ม', 'تفصيل حسب المزرعة') + '</h2>' +
          fOrder.map(function (fid) {
            var sm = matSummary(byFarm[fid]);
            return '<div class="farm"><h3>' + farmLabel(fid) + '</h3>' +
              '<table class="mini"><tbody>' + sm.names.map(function (nm) {
                return '<tr><td>' + esc(nm) + '</td><td class="c qty">' + fmtQty(sm.map[nm].L, U(nm)) + '</td></tr>';
              }).join('') + '</tbody></table></div>';
          }).join('');
      }
      pages.push(all + sign + foot);
    }

    var css =
      '@page{size:A4 portrait;margin:11mm;}' +
      'body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#1f2a1f;background:#fff;margin:0;}' +
      '.page{break-after:page;page-break-after:always;}.page:last-child{break-after:auto;page-break-after:auto;}' +
      '.brand{display:flex;align-items:center;gap:12px;background:' + BRAND.dark + ';color:#fff;' +
        'padding:14px 18px;border-radius:14px;}' +
      '.brand .bt{flex:1;}.brand .wm{font-size:1.7rem;font-weight:900;letter-spacing:.5px;line-height:1;}' +
      '.brand .tag{font-size:.78rem;color:' + BRAND.light + ';margin-top:3px;}' +
      '.brand .doc{text-align:left;}.brand .dt{font-size:1.1rem;font-weight:800;}' +
      '.brand .ds{font-size:.74rem;color:' + BRAND.light + ';}' +
      '.meta{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;}' +
      '.meta div{border:1px solid #cfdccf;border-radius:10px;padding:6px 10px;min-width:110px;}' +
      '.meta span{display:block;font-size:.66rem;color:#5d6b5d;}.meta b{font-size:.86rem;}' +
      '.meta .hl{border-color:#b3261e;}.meta .hl b{color:#b3261e;}' +
      'h2{font-size:1rem;color:' + BRAND.mid + ';border-bottom:2px solid ' + BRAND.light + ';padding-bottom:4px;margin:16px 0 8px;}' +
      'h2.unit{font-size:1.1rem;}h3{font-size:.9rem;margin:0 0 4px;color:' + BRAND.mid + ';}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:8px;}' +
      'th,td{border:1px solid #c6d3c6;padding:6px 7px;font-size:.78rem;text-align:right;vertical-align:middle;}' +
      'th{background:' + BRAND.mid + ';color:#fff;font-weight:800;}' +
      'td.c,th.c{text-align:center;}td.qty{font-weight:800;font-size:.86rem;}' +
      'th.fill{background:#5d7d5f;}td.fill{background:#fbfdfb;min-width:70px;height:26px;}' +
      'tr{break-inside:avoid;page-break-inside:avoid;}' +
      '.farm{display:inline-block;vertical-align:top;width:48%;margin:0 0 10px 1.5%;border:1px solid #cfdccf;' +
        'border-radius:10px;padding:8px 10px;box-sizing:border-box;}' +
      '.mini td{border:none;border-bottom:1px solid #e8eee8;padding:3px 0;}' +
      '.muted{color:#6b786b;font-weight:400;font-size:.8em;}' +
      '.terms{font-size:.76rem;background:#f3f8f3;border-radius:10px;padding:8px 10px;margin:10px 0;}' +
      '.sig{display:flex;gap:28px;margin-top:30px;font-size:.78rem;}' +
      '.sig div{flex:1;border-top:1px solid #8a968a;padding-top:4px;}' +
      'footer{margin-top:18px;font-size:.7rem;color:#5d6b5d;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}' +
      'svg.mark{flex:none;}';

    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc(tt('שורשים - בקשה להצעת מחיר', 'ขอใบเสนอราคา', 'طلب عرض سعر') + ' ' + ref) + '</title>' +
      '<style>' + css + '</style></head><body>' +
      pages.map(function (pg) { return '<section class="page">' + pg + '</section>'; }).join('') +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, ref + '.html');
    }
  }

  function printPlan(id) {
    var p = planById(id);
    if (!p) return;
    exportPages(p, [{ unit: '', rows: p.rows || [] }], { prices: true });
  }

  // ── Export by plot / by farm ──
  // Tick whole farms or single plots; choose one page per plot, one page
  // per farm, or everything ticked on one page. Rows that belong to no plot
  // (a farm-level row) travel with their farm.
  function plotKey(r) { return r.plotId ? String(r.plotId) : 'f' + (r.farmId == null ? 0 : r.farmId); }

  function exportPicker(pid, kind) {
    preloadQr();
    kind = kind === 'rfq' ? 'rfq' : 'grower';
    var p = planById(pid);
    if (!p) return;
    var host = document.getElementById('apPicker');
    if (!host) return;
    if (!(p.rows || []).length) {
      toast('⚠️ ' + tt('אין שורות בתוכנית', 'ไม่มีแถว', 'لا صفوف'));
      return;
    }
    var farmsOrder = [], byFarm = {};
    p.rows.forEach(function (r) {
      var fid = String(r.farmId == null ? 0 : r.farmId);
      if (!byFarm[fid]) { byFarm[fid] = { keys: [], info: {} }; farmsOrder.push(fid); }
      var k = plotKey(r);
      var g = byFarm[fid];
      if (!g.info[k]) {
        var pl = r.plotId ? plotById(r.plotId) : null;
        g.info[k] = { name: pl ? pl.name : tt('כלל המשק', 'ทั้งฟาร์ม', 'كل المزرعة'), trees: 0, ops: [] };
        g.keys.push(k);
      }
      if (!isDunam(r.method)) g.info[k].trees = Math.max(g.info[k].trees, Number(r.trees) || 0);
      var lbl = opLabel(r.method, r.round);
      if (g.info[k].ops.indexOf(lbl) < 0) g.info[k].ops.push(lbl);
    });

    var tree = farmsOrder.map(function (fid) {
      var g = byFarm[fid];
      return '<div class="apExGrp" data-farm="' + fid + '" style="margin-bottom:8px;">' +
        '<label style="display:flex;gap:6px;align-items:center;font-weight:800;font-size:.86rem;">' +
          '<input type="checkbox" class="apExFarm" value="' + fid + '" ' +
            'onchange="AgriPlan._exFarm(this)"> ' + farmIco(Number(fid)) + ' ' + esc(farmName(Number(fid))) +
          ' <span style="font-weight:400;color:var(--text-muted,#888);font-size:.76rem;">(' +
            g.keys.length + ' ' + tt('חלקות', 'แปลง', 'قطع') + ')</span></label>' +
        '<div style="padding-inline-start:22px;">' +
          g.keys.map(function (k) {
            var it = g.info[k];
            return '<label style="display:inline-flex;gap:5px;align-items:center;margin:3px 10px 3px 0;font-size:.8rem;">' +
              '<input type="checkbox" class="apExPlot" value="' + esc(k) + '" data-farm="' + fid + '" ' +
                'onchange="AgriPlan._exPlot(this)"> ' + esc(it.name) +
              ' <span style="color:var(--text-muted,#888);font-size:.72rem;">' +
                it.trees.toLocaleString() + ' · ' + esc(it.ops.join(', ')) + '</span></label>';
          }).join('') +
        '</div></div>';
    }).join('');

    var radio = function (v, label, on) {
      return '<label style="display:inline-flex;gap:5px;align-items:center;margin-inline-end:14px;font-size:.84rem;">' +
        '<input type="radio" name="apExMode" value="' + v + '"' + (on ? ' checked' : '') + '> ' + label + '</label>';
    };

    host.innerHTML =
      '<div class="ap-card ap-pick">' +
        '<div style="font-weight:800;margin-bottom:6px;">📤 ' +
          tt('ייצוא לפי חלקה / משק', 'ส่งออกตามแปลง/ฟาร์ม', 'تصدير حسب القطعة/المزرعة') + '</div>' +
        '<div style="margin-bottom:8px;">' +
          '<label style="display:inline-flex;gap:5px;align-items:center;margin-inline-end:14px;font-size:.86rem;font-weight:700;">' +
            '<input type="radio" name="apExKind" value="grower"' + (kind === 'grower' ? ' checked' : '') + '> ' +
            tt('דפי טיפול למגדל', 'แผ่นงานสำหรับเกษตรกร', 'أوراق المعالجة للمزارع') + '</label>' +
          '<label style="display:inline-flex;gap:5px;align-items:center;font-size:.86rem;font-weight:700;">' +
            '<input type="radio" name="apExKind" value="rfq"' + (kind === 'rfq' ? ' checked' : '') + '> 🧾 ' +
            tt('פירוט כמויות לספק (הצעת מחיר)', 'ปริมาณสำหรับผู้จัดหา', 'كميات للمورد (عرض سعر)') + '</label>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;">' +
          '<button class="ap-btn ghost" style="padding:5px 10px;font-size:.76rem;" onclick="AgriPlan._exAll(true)">' +
            tt('סמן הכל', 'เลือกทั้งหมด', 'تحديد الكل') + '</button>' +
          '<button class="ap-btn ghost" data-no-back style="padding:5px 10px;font-size:.76rem;" onclick="AgriPlan._exAll(false)">' +
            tt('נקה סימון', 'ล้าง', 'مسح التحديد') + '</button>' +
        '</div>' +
        '<div style="display:flex;gap:6px;margin-bottom:8px;flex-wrap:wrap;align-items:center;">' +
          segBar('apEx', p.rows.map(function (r) { return plotById(r.plotId); }).filter(Boolean), '') +
          '<button class="ap-btn ghost" style="padding:5px 10px;font-size:.76rem;" onclick="AgriPlan._exSeg()">☑ ' +
            tt('סמן רק את התואמים', 'เลือกเฉพาะที่ตรง', 'تحديد المطابق فقط') + '</button>' +
        '</div>' +
        '<div style="max-height:40vh;overflow:auto;">' + tree + '</div>' +
        '<div id="apExGrower"' + (kind === 'rfq' ? ' hidden' : '') + '>' +
          '<div class="ap-lbl" style="margin-top:8px;">' + tt('חלוקה לדפים', 'แบ่งหน้า', 'تقسيم الصفحات') + '</div>' +
          '<div>' +
            radio('plot', tt('דף לכל חלקה', 'หน้าละแปลง', 'صفحة لكل قطعة'), true) +
            radio('farm', tt('דף לכל משק', 'หน้าละฟาร์ม', 'صفحة لكل مزرعة'), false) +
            radio('one', tt('הכל בדף אחד', 'หน้าเดียว', 'صفحة واحدة'), false) +
          '</div>' +
          '<label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:.82rem;font-weight:700;">' +
            '<input type="checkbox" id="apExSplit"> 📄 ' +
            tt('קובץ PDF נפרד לכל מטע (שם הקובץ נקבע אוטומטית)', 'แยกไฟล์ PDF ต่อสวน', 'ملف PDF منفصل لكل بستان') + '</label>' +
          '<label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:.82rem;">' +
            '<input type="checkbox" id="apExPrices"> ' +
            tt('כלול מחירים ועלות (פנימי - לא למגדל)', 'รวมราคา (ภายใน)', 'تضمين الأسعار (داخلي)') + '</label>' +
        '</div>' +
        '<div id="apExRfq"' + (kind === 'rfq' ? '' : ' hidden') + '>' +
          '<div class="ap-rowgrid" style="grid-template-columns:1.4fr 1fr;margin-top:8px;">' +
            '<div><div class="ap-lbl">' + tt('לכבוד (ספק / מחסן)', 'ถึง (ผู้จัดหา)', 'إلى (المورد)') + '</div>' +
              '<input class="ap-in" id="apRfqTo" placeholder="' + tt('שם הספק', 'ชื่อผู้จัดหา', 'اسم المورد') + '"></div>' +

          '</div>' +
          '<div class="ap-lbl" style="margin-top:8px;">' + tt('מבנה המסמך', 'รูปแบบเอกสาร', 'شكل المستند') + '</div>' +
          '<div>' +
            '<label style="display:inline-flex;gap:5px;align-items:center;margin-inline-end:14px;font-size:.84rem;">' +
              '<input type="radio" name="apRfqMode" value="one" checked> ' +
              tt('מסמך מרוכז + פירוט לכל משק', 'รวม + แยกตามฟาร์ม', 'ملخص + تفصيل لكل مزرعة') + '</label>' +
            '<label style="display:inline-flex;gap:5px;align-items:center;font-size:.84rem;">' +
              '<input type="radio" name="apRfqMode" value="farm"> ' +
              tt('דף נפרד לכל משק', 'หน้าละฟาร์ม', 'صفحة لكل مزرعة') + '</label>' +
          '</div>' +
          '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:4px;">' +
            tt('כמויות בלבד, ללא מחירים - עמודות המחיר נשארות ריקות למילוי הספק.',
               'ปริมาณเท่านั้น ไม่มีราคา', 'كميات فقط بلا أسعار') + '</div>' +
        '</div>' +
        '<div id="apExCount" style="font-size:.76rem;color:var(--text-muted,#888);margin-top:6px;"></div>' +
        '<div id="apExFiles"></div>' +
        '<div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">' +
          '<button class="ap-btn" onclick="AgriPlan._doExport(' + pid + ')">📤 ' +
            tt('ייצוא', 'ส่งออก', 'تصدير') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' +
            tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
      '</div>';
    Array.prototype.forEach.call(host.querySelectorAll('input[name="apExMode"],input[name="apRfqMode"]'), function (r) {
      r.addEventListener('change', _exCount);
    });
    Array.prototype.forEach.call(host.querySelectorAll('input[name="apExKind"]'), function (r) {
      r.addEventListener('change', function () {
        var k = _exKind();
        var g = document.getElementById('apExGrower'), q = document.getElementById('apExRfq');
        if (g) g.hidden = k === 'rfq';
        if (q) q.hidden = k !== 'rfq';
        _exCount();
      });
    });
    // A supplier sheet is normally the whole plan; start with everything ticked.
    if (kind === 'rfq') _exAll(true); else _exCount();
    host.scrollIntoView({ block: 'nearest' });
  }

  function _exSyncFarm(fid) {
    var all = document.querySelectorAll('.apExPlot[data-farm="' + fid + '"]');
    var on = 0;
    Array.prototype.forEach.call(all, function (c) { if (c.checked) on++; });
    var f = document.querySelector('.apExFarm[value="' + fid + '"]');
    if (f) { f.checked = on > 0 && on === all.length; f.indeterminate = on > 0 && on < all.length; }
  }
  function _exFarm(cb) {
    Array.prototype.forEach.call(document.querySelectorAll('.apExPlot[data-farm="' + cb.value + '"]'),
      function (c) { c.checked = cb.checked; });
    cb.indeterminate = false;
    _exCount();
  }
  function _exPlot(cb) { _exSyncFarm(cb.getAttribute('data-farm')); _exCount(); }
  function _exAll(on) {
    Array.prototype.forEach.call(document.querySelectorAll('.apExPlot'), function (c) { c.checked = on; });
    Array.prototype.forEach.call(document.querySelectorAll('.apExFarm'), function (c) {
      c.checked = on; c.indeterminate = false;
    });
    _exCount();
  }
  // Tick exactly the plots that match the branch / crop filter.
  function _exSeg() {
    var seg = segSel('apEx');
    Array.prototype.forEach.call(document.querySelectorAll('.apExPlot'), function (c) {
      var v = c.value;
      c.checked = v.charAt(0) === 'f' ? !segOn(seg) : segOk(plotById(Number(v)), seg);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.apExFarm'), function (fc) {
      var all = document.querySelectorAll('.apExPlot[data-farm="' + fc.value + '"]');
      var on = Array.prototype.filter.call(all, function (c) { return c.checked; }).length;
      fc.checked = on > 0 && on === all.length;
      fc.indeterminate = on > 0 && on < all.length;
    });
    _exCount();
  }
  function _exKind() {
    var r = document.querySelector('input[name="apExKind"]:checked');
    return r ? r.value : 'grower';
  }
  function _exMode() {
    var r = document.querySelector(_exKind() === 'rfq' ? 'input[name="apRfqMode"]:checked' : 'input[name="apExMode"]:checked');
    return r ? r.value : 'plot';
  }
  function _exPicked() {
    var picked = {}, farmsOn = {}, n = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.apExPlot'), function (c) {
      if (!c.checked) return;
      picked[c.value] = true; farmsOn[c.getAttribute('data-farm')] = true; n++;
    });
    return { picked: picked, plots: n, farms: Object.keys(farmsOn).length };
  }
  function _exCount() {
    var el = document.getElementById('apExCount');
    if (!el) return;
    var k = _exPicked(), mode = _exMode();
    if (!k.plots) { el.textContent = tt('לא נבחר דבר', 'ยังไม่ได้เลือก', 'لم يُحدد شيء'); return; }
    var pages = mode === 'plot' ? k.plots : (mode === 'farm' ? k.farms : 1);
    el.textContent = k.plots + ' ' + tt('חלקות', 'แปลง', 'قطع') + ' · ' + k.farms + ' ' +
      tt('משקים', 'ฟาร์ม', 'مزارع') + ' → ' + pages + ' ' + tt('דפים', 'หน้า', 'صفحات');
  }

  function _doExport(pid) {
    var p = planById(pid);
    if (!p) return;
    var k = _exPicked(), mode = _exMode();
    if (!k.plots) { toast('⚠️ ' + tt('סמן לפחות חלקה אחת', 'เลือกอย่างน้อยหนึ่งแปลง', 'حدد قطعة واحدة على الأقل')); return; }
    var prices = !!(document.getElementById('apExPrices') || {}).checked;
    var rows = p.rows.filter(function (r) { return k.picked[plotKey(r)]; });
    if (_exKind() === 'rfq') {
      rfqExport(p, rows, {
        mode: mode,
        to: String((document.getElementById('apRfqTo') || {}).value || '').trim(),
        due: isoDate((document.getElementById('apRfqDue') || {}).value)
      });
      return;
    }
    if ((document.getElementById('apExSplit') || {}).checked) return splitExport(p, rows, mode, prices);
    var pages = buildPages(rows, mode);
    var suffix = pages.length === 1 ? pages[0].unit.replace(/^\S+\s*/, '') :
      pages.length + ' ' + tt('דפים', 'หน้า', 'صفحات');
    exportPages(p, pages, { prices: prices }, suffix);
  }
  function buildPages(rows, mode) {
    var pages = [], idx = {};
    rows.forEach(function (r) {
      var fid = r.farmId == null ? 0 : r.farmId;
      var key = mode === 'plot' ? plotKey(r) : (mode === 'farm' ? 'f' + fid : 'all');
      if (!idx[key]) {
        var unit;
        if (mode === 'one') unit = tt('חלקות נבחרות', 'แปลงที่เลือก', 'قطع مختارة');
        else {
          var pl = (mode === 'plot' && r.plotId) ? plotById(r.plotId) : null;
          unit = farmIco(fid) + ' ' + farmName(fid) + (pl ? ' · ' + tt('חלקה', 'แปลง', 'قطعة') + ' ' + pl.name : '');
        }
        idx[key] = { unit: unit, rows: [] };
        pages.push(idx[key]);
      }
      idx[key].rows.push(r);
    });
    return pages;
  }
  // One file per orchard (משק), named "<plan>_<farm>_<date>". Browsers allow
  // one new window per tap, so the files are offered as a list: one button
  // per orchard, each opening its own print window (Save as PDF).
  function fileSafe(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''); }
  function splitExport(p, rows, mode, prices) {
    var groups = {}, order = [];
    rows.forEach(function (r) {
      var pl = r.plotId ? plotById(r.plotId) : null;
      var fid = pl && pl.farm_id ? pl.farm_id : (r.farmId == null ? 0 : r.farmId);
      if (!groups[fid]) { groups[fid] = []; order.push(fid); }
      groups[fid].push(r);
    });
    var date = new Date().toISOString().slice(0, 10), base = fileSafe(p.docTitle || p.name || tt('תוכנית', 'แผน', 'خطة'));
    var files = order.map(function (fid) {
      return { fid: fid, farm: farmName(Number(fid)) || '-', rows: groups[fid], name: base + '_' + fileSafe(farmName(Number(fid)) || 'farm') + '_' + date };
    });
    _split = { pid: p.id, files: files, mode: mode, prices: prices };
    if (files.length === 1) return _splitOpen(0);
    var box = document.getElementById('apExFiles');
    if (!box) return;
    box.innerHTML = '<div class="ap-card" style="margin-top:8px;background:var(--tonal,#f3f6ef);">' +
      '<div style="font-weight:800;margin-bottom:4px;">📄 ' + files.length + ' ' + tt('קבצים - אחד לכל מטע', 'ไฟล์ - ไฟล์ละสวน', 'ملفات - ملف لكل بستان') + '</div>' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:4px 0 8px;"><button class="ap-btn" data-no-sticky id="apSplitAll" onclick="AgriPlan._splitZip()">⬇ ' + tt('הורד את כל הקבצים (ZIP)', 'ดาวน์โหลดทั้งหมด (ZIP)', 'تنزيل كل الملفات (ZIP)') + '</button>' +
        '<span id="apSplitProg" style="font-size:.78rem;color:var(--text-muted,#888);"></span></div>' +
      '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-bottom:6px;">' + tt('או קובץ-קובץ: כל לחיצה פותחת קובץ; בחלון שנפתח: "שמור כ-PDF". שם הקובץ כבר מוכן.', 'หรือทีละไฟล์', 'أو ملفًا ملفًا') + '</div>' +
      files.map(function (f, i) {
        return '<div style="display:flex;gap:8px;align-items:center;margin:4px 0;"><button class="ap-btn" data-no-sticky id="apSplit' + i + '" onclick="AgriPlan._splitOpen(' + i + ')">📄 ' + esc(f.farm) + '</button>' +
          '<small style="color:var(--text-muted,#888);direction:ltr;unicode-bidi:plaintext;">' + esc(f.name) + '.pdf</small></div>';
      }).join('') + '</div>';
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  var _split = null;
  // ── All the files at once: each orchard's document is rendered to a real
  // PDF inside its own hidden frame (its print CSS stays out of the app),
  // and the PDFs are packed into one ZIP. Map tiles are fetched and inlined
  // first - an SVG drawn to canvas cannot load outside images itself; a tile
  // that cannot be fetched leaves the plain map ground, data still prints.
  var CDN_H2P = 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js';
  var CDN_ZIP = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
  function loadScript(src, test) {
    if (test()) return Promise.resolve();
    return new Promise(function (res, rej) {
      var sc = document.createElement('script'); sc.src = src; sc.onload = function () { res(); }; sc.onerror = function () { rej(new Error('load ' + src)); };
      document.head.appendChild(sc);
    });
  }
  function inlineImages(doc) {
    var els = Array.prototype.slice.call(doc.querySelectorAll('image'));
    var cache = {};
    return Promise.all(els.map(function (el) {
      var u = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
      if (!/^https?:/.test(u)) return null;
      cache[u] = cache[u] || toDataUrl(u);
      return cache[u].then(function (d) { if (d) { el.setAttribute('href', d); el.removeAttribute('xlink:href'); } else el.remove(); });
    }).concat(Array.prototype.slice.call(doc.querySelectorAll('img')).map(function (im) {
      var u = im.getAttribute('src') || '';
      if (!/^https?:/.test(u)) return null;
      return toDataUrl(u).then(function (d) { if (d) im.setAttribute('src', d); });
    })));
  }
  var _dl = {};      // url -> Promise<dataURL|null>, shared by every file of a ZIP
  function toDataUrl(u) {
    if (_dl[u]) return _dl[u];
    return (_dl[u] = fetch(u, { mode: 'cors' }).then(function (r) { if (!r.ok) throw 0; return r.blob(); }).then(function (b) {
      return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = function () { res(null); }; fr.readAsDataURL(b); });
    }).catch(function () { return null; }));
  }
  var _css = {};
  function inlineFonts(doc) {
    var links = Array.prototype.slice.call(doc.querySelectorAll('link[rel="stylesheet"]'));
    return Promise.all(links.map(function (l) {
      var href = l.getAttribute('href') || '';
      if (!/^https?:/.test(href)) return null;
      _css[href] = _css[href] || fetch(href, { mode: 'cors' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (css) {
        var urls = css.match(/url\((https?:[^)]+)\)/g) || [];
        return Promise.all(urls.map(function (m) { var u = m.slice(4, -1).replace(/['"]/g, ''); return toDataUrl(u).then(function (d) { if (d) css = css.split(u).join(d); }); })).then(function () { return css; });
      }).catch(function () { return ''; });
      return _css[href].then(function (css) { if (css) { var st = doc.createElement('style'); st.textContent = css; doc.head.appendChild(st); } });
    }));
  }
  // ── Page layout for the PDF ──
  // Each part of the document (treatment sheet, orchard page, materials
  // page) starts a new page. A part taller than a page is cut only where no
  // text line, table row, map or bordered box is crossed - the lowest such
  // point that fits. Parts are rendered one at a time by the browser
  // (foreignObject) at 3× for sharp text.
  function composePdf(w, d, land, W) {
    var PW = land ? 297 : 210, PH = land ? 210 : 297, M = 14, CW = PW - 2 * M, CH = PH - 2 * M;
    var parts = Array.prototype.slice.call(d.querySelectorAll('body > .page, body > section.page, body > .ps-page, body > .mt-page, body > section.ps-page, body > .lb-page'));
    if (!parts.length) parts = [d.body];
    var opts = w.JSON.parse(JSON.stringify({ margin: 0, image: { type: 'jpeg', quality: 0.97 },
      html2canvas: { scale: 2.4, useCORS: true, windowWidth: W, backgroundColor: '#ffffff', logging: false, foreignObjectRendering: true },
      jsPDF: { unit: 'mm', format: 'a4', orientation: land ? 'landscape' : 'portrait' } }));
    var pdf = null, first = true;
    function safeCuts(el) {
      var top = el.getBoundingClientRect().top, iv = [];
      var pagePx = CH * (el.getBoundingClientRect().width / CW);
      function add(r) { if (r.height > 0 && r.height < pagePx * 0.95) iv.push([r.top - top, r.bottom - top]); }
      el.querySelectorAll('tr, img, svg, h1, h2, h3, h4, li, .ps-map, .ps-head').forEach(function (e) { add(e.getBoundingClientRect()); });
      // A heading stays with the start of what follows it.
      el.querySelectorAll('h1, h2, h3, h4, .section-title, .sec-h').forEach(function (h) {
        var nx = h.nextElementSibling; if (!nx) return;
        var a = h.getBoundingClientRect(), b = nx.getBoundingClientRect();
        add({ top: a.top, bottom: Math.min(b.bottom, b.top + 70), height: Math.min(b.bottom, b.top + 70) - a.top });
      });
      el.querySelectorAll('*').forEach(function (e) {
        var cs = w.getComputedStyle(e);
        var bg = cs.backgroundColor, hasBg = bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)/.test(bg) && e.tagName !== 'BODY';
        if ((parseFloat(cs.borderTopWidth) > 0 && parseFloat(cs.borderBottomWidth) > 0) || hasBg || e.tagName === 'TD') add(e.getBoundingClientRect());
      });
      var tw = d.createTreeWalker(el, 4, null), tn, rg = d.createRange();
      while ((tn = tw.nextNode())) { if (!tn.nodeValue.trim()) continue; rg.selectNodeContents(tn); Array.prototype.forEach.call(rg.getClientRects(), add); }
      return { iv: iv, pagePx: pagePx };
    }
    function cutAt(iv, from, limit) {
      // the lowest y in (from, limit] that no interval crosses
      var y = limit, guard = 0;
      while (y > from && guard++ < 5000) {
        var hit = null;
        for (var i = 0; i < iv.length; i++) if (iv[i][0] < y - 0.5 && iv[i][1] > y + 0.5) { if (!hit || iv[i][0] < hit[0]) hit = iv[i]; }
        if (!hit) return y;
        y = hit[0];
      }
      return limit;
    }
    function renderPart(k) {
      if (k >= parts.length) { parts.forEach(function (x) { x.style.display = ''; }); return Promise.resolve(); }
      // Only this part is shown while it renders: it sits at the top of the
      // page, where the browser renderer places it reliably.
      parts.forEach(function (x, i) { x.style.display = i === k ? '' : 'none'; });
      var el = parts[k];
      el.style.breakBefore = 'auto'; el.style.marginTop = '0';
      // a little room on both sides so rounded borders are never clipped
      el.style.paddingLeft = '8px'; el.style.paddingRight = '8px'; el.style.boxSizing = 'border-box';
      var g = safeCuts(el), hPx = el.getBoundingClientRect().height, wPx = el.getBoundingClientRect().width;
      return w.html2pdf().set(opts).from(el).toCanvas().get('canvas').then(function (cv) {
        var ratio = cv.width / wPx, mmPerPx = CW / wPx, y0 = 0;
        function begin() {
          if (!pdf) return w.html2pdf().set(opts).from(d.createElement('div')).toPdf().get('pdf').then(function (p) { pdf = p; });
          return Promise.resolve();
        }
        return begin().then(function () {
          // Slightly taller than a page: shrink to fit rather than spill a
          // row or two onto a page of their own.
          if (hPx > g.pagePx && hPx <= g.pagePx * 1.15) {
            var f = g.pagePx / hPx, wmm = CW * f;
            if (!first) pdf.addPage();
            first = false;
            pdf.addImage(cv.toDataURL('image/jpeg', 0.97), 'JPEG', M + (CW - wmm) / 2, M, wmm, CH);
            return;
          }
          while (y0 < hPx - 1) {
            var lim = Math.min(hPx, y0 + g.pagePx), y1 = lim >= hPx ? hPx : cutAt(g.iv, y0, lim);
            if (y1 - y0 < g.pagePx * 0.25) y1 = lim;          // no good cut: rather cut than leave a stub
            var sh = Math.round((y1 - y0) * ratio), sc = d.createElement('canvas');
            sc.width = cv.width; sc.height = Math.max(1, sh);
            var cx = sc.getContext('2d'); cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, sc.width, sc.height);
            cx.drawImage(cv, 0, Math.round(y0 * ratio), cv.width, sh, 0, 0, cv.width, sh);
            if (!first) pdf.addPage();
            first = false;
            pdf.addImage(sc.toDataURL('image/jpeg', 0.97), 'JPEG', M, M, CW, (y1 - y0) * mmPerPx);
            y0 = y1;
          }
        });
      }).then(function () { return renderPart(k + 1); });
    }
    return renderPart(0).then(function () { return pdf.output('blob'); });
  }
  // ── PDF: printed by Chrome on the server (functions: planPdf) ──
  // Real print layout: rows are never cut, table headers repeat, text is
  // sharp. Emoji are dropped (the server has no colour-emoji font, and
  // small emoji read as clutter on a printed sheet). If the function is not
  // there or fails, the old in-browser method below still makes the file.
  var _srvPdfOff = false;
  var EMOJI_RE = /(?:[\u2600-\u27BF\u2B50\u2B55\u2934\u2935]|[\uD83C-\uDBFF][\uDC00-\uDFFF])[\uFE0F\u200D]?/g;
  // An orchard sheet (map + plot table) a little taller than one page used
  // to spill a single row onto a page of its own. Before printing, the map
  // is shrunk just enough for the sheet to fit (never below 60 mm); a sheet
  // far taller than a page is left to flow, its rows unbroken.
  function FIT_JS(land) {
    return '(function(){function go(){try{var mm=96/25.4,H=((' + (land ? 210 : 297) + ')-28)*mm-6;' +
      'document.querySelectorAll(".ps-page").forEach(function(pg){var h=pg.getBoundingClientRect().height;' +
        'if(h<=H||h>H*1.4)return;var sv=pg.querySelector(".ps-map svg");if(!sv)return;' +
        'var sh=sv.getBoundingClientRect().height,nh=sh-(h-H);if(nh<60*mm)nh=60*mm;' +
        'var w=sv.getBoundingClientRect().width;sv.style.width=(w*nh/sh)+"px";sv.removeAttribute("width");});' +
      '}catch(e){}document.documentElement.dataset.fit="1";}' +
      'if(document.readyState==="complete")go();else window.addEventListener("load",go);})();';
  }
  function serverPdf(html, land) {
    if (_srvPdfOff || !window.firebase || !firebase.app) return Promise.reject(new Error('no-server'));
    var fix = '<style>.hd-ico:empty{display:none}tr,.farm,.mt-card,.ap-log{break-inside:avoid;page-break-inside:avoid}' +
      'thead{display:table-header-group}h2,h3{break-after:avoid;page-break-after:avoid}</style>';
    var clean = String(html).replace(EMOJI_RE, '').replace(/<\/head>/i, fix + '</head>').replace(/<\/body>/i, '<script>' + FIT_JS(land) + '</script></body>');
    var fn = firebase.app().functions('us-central1').httpsCallable('planPdf', { timeout: 120000 });
    return fn({ html: clean, landscape: land }).then(function (r) {
      var b64 = r && r.data && r.data.pdf;
      if (!b64) throw new Error('empty');
      var bin = atob(b64), u = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      return new Blob([u], { type: 'application/pdf' });
    }, function (e) {
      var code = String((e && e.code) || '');
      if (/not-found|unimplemented|permission-denied|unauthenticated/.test(code)) _srvPdfOff = true;
      throw e;
    });
  }
  function pdfFromHtml(html, orientation) {
    var land = orientation !== 'portrait';
    return serverPdf(html, land).catch(function (e) {
      console.warn('[AgriPlan pdf] server print unavailable, using in-browser method:', e && (e.code || e.message));
      return localPdf(html, orientation);
    });
  }
  function localPdf(html, orientation) {
    return new Promise(function (resolve, reject) {
      var land = orientation !== 'portrait', W = land ? 1123 : 794;
      var ifr = document.createElement('iframe');
      ifr.setAttribute('aria-hidden', 'true');
      ifr.style.cssText = 'position:fixed;left:0;top:0;width:' + W + 'px;height:900px;border:0;opacity:0;pointer-events:none;z-index:-1;';
      var done = false, kill = setTimeout(function () { if (!done) { done = true; ifr.remove(); reject(new Error('timeout')); } }, 90000);
      ifr.onload = function () {
        var w = ifr.contentWindow, d = ifr.contentDocument;
        var sc = d.createElement('script'); sc.src = CDN_H2P;
        sc.onerror = function () { if (!done) { done = true; clearTimeout(kill); ifr.remove(); reject(new Error('html2pdf')); } };
        sc.onload = function () {
          var ready = (d.fonts && d.fonts.ready) ? d.fonts.ready : Promise.resolve();
          ready.then(function () { return Promise.all([inlineImages(d), inlineFonts(d)]); }).then(function () {
            // A sheet ends with break-after and the orchard page starts with
            // break-before; html2pdf honours both and leaves an empty page.
            var fix = d.createElement('style');
            fix.textContent = '.page{break-after:auto !important;page-break-after:auto !important;}.page+.page{break-before:page;page-break-before:always;}.ps-head h2{white-space:nowrap;}';
            d.head.appendChild(fix);
            // Text is laid out by the browser itself (foreignObject
            // rendering) - html2canvas's own text engine misplaces Hebrew
            // words and the punctuation around them. In that mode outside
            // resources cannot load, so fonts and images were inlined above.
            // Built in the frame's own realm: html2pdf checks "instanceof
            // Array", which fails for an array made in the parent window.
            return composePdf(w, d, land, W);
          }).then(function (blob) {
            if (done) return; done = true; clearTimeout(kill); ifr.remove(); resolve(blob);
          }, function (e) { if (done) return; done = true; clearTimeout(kill); ifr.remove(); reject(e); });
        };
        d.head.appendChild(sc);
      };
      document.body.appendChild(ifr);
      ifr.srcdoc = html;
    });
  }
  function _splitZip() {
    var s = _split, p = s && planById(s.pid);
    if (!s || !p) return;
    var btn = document.getElementById('apSplitAll'), prog = document.getElementById('apSplitProg');
    if (btn) btn.disabled = true;
    function say(t) { if (prog) prog.textContent = t; }
    say('⏳ ' + tt('טוען…', 'กำลังโหลด…', 'جارٍ التحميل…'));
    loadScript(CDN_ZIP, function () { return !!window.JSZip; }).then(function () {
      var zip = new window.JSZip(), i = 0, fails = [], doneN = 0;
      function next() {
        if (i >= s.files.length) return Promise.resolve();
        var f = s.files[i++];
        say('⏳ ' + tt('מכין', 'กำลังทำ', 'جارٍ التحضير') + ' ' + (doneN + 1) + '/' + s.files.length + ' - ' + f.farm);
        var doc = exportPages(p, buildPages(f.rows, s.mode), { prices: s.prices, fileName: f.name, returnHtml: true }, f.farm);
        return pdfFromHtml(doc.html, doc.orientation).then(function (b) { zip.file(f.name + '.pdf', b); }, function (e) { console.warn('[AgriPlan zip]', f.farm, e); fails.push(f.farm); }).then(function () { doneN++; }).then(next);
      }
      // two files at a time: rendering waits on downloads and the browser
      // does both at once
      return Promise.all([next(), next()]).then(function () {
        if (fails.length === s.files.length) throw new Error('all');
        say('⏳ ' + tt('אורז…', 'กำลังบีบอัด…', 'جارٍ الضغط…'));
        return zip.generateAsync({ type: 'blob' });
      }).then(function (blob) {
        var base = fileSafe(p.docTitle || p.name || tt('תוכנית', 'แผน', 'خطة')) + '_' + new Date().toISOString().slice(0, 10) + '.zip';
        var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
        say('✅ ' + (s.files.length - fails.length) + ' ' + tt('קבצים הורדו', 'ไฟล์', 'ملفات') + (fails.length ? ' · ⚠️ ' + tt('לא הצליחו', 'ไม่สำเร็จ', 'فشلت') + ': ' + fails.join(', ') : ''));
      });
    }).catch(function (e) {
      console.warn('[AgriPlan zip]', e);
      say('❌ ' + tt('ההורדה נכשלה - אפשר להוריד קובץ-קובץ מהרשימה', 'ดาวน์โหลดไม่สำเร็จ', 'فشل التنزيل - نزّل ملفًا ملفًا'));
    }).then(function () { if (btn) btn.disabled = false; });
  }
  function _splitOpen(i) {
    var s = _split, f = s && s.files[i], p = s && planById(s.pid);
    if (!f || !p) return;
    exportPages(p, buildPages(f.rows, s.mode), { prices: s.prices, fileName: f.name }, f.farm);
    var b = document.getElementById('apSplit' + i);
    if (b) { b.textContent = '✅ ' + f.farm; b.classList.add('ghost'); }
  }

  // Hand the material totals to orders.js. The plan itself is the ref, so
  // an order can always be traced back to the plan that justified it.
  function toOrder(id) {
    var p = planById(id);
    if (!p) return;
    var t = totals(p);
    var lines = Object.keys(t.byMat).sort().map(function (nm) {
      var un = U(nm, p);
      return { name: nm, qty: un === 'g' ? Math.round(t.byMat[nm] * 1000) : t.byMat[nm], unit: unitWord(un), note: '' };
    });
    if (!lines.length) {
      toast('\u26a0\ufe0f ' + tt('אין חומרים בתוכנית', 'ไม่มีสารในแผน', 'لا مواد في الخطة'));
      return;
    }
    if (typeof Orders === 'undefined') {
      toast('\u26a0\ufe0f ' + tt('מודול ההזמנות לא נטען', 'โมดูลใบสั่งซื้อไม่พร้อม', 'وحدة الطلبات غير محمّلة'));
      return;
    }
    // Reading a plan into an order is allowed for any manager; writing the
    // season document back is not, unless this plan is his to save.
    if (canEdit(p)) save();
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
    bulkMaterial: bulkMaterial,
    pickPlots: pickPlots,
    themeEditor: themeEditor,
    _applyBulk: _applyBulk,
    _pickAll: _pickAll,
    _addPicked: _addPicked,
    _setFarmNote: _setFarmNote,
    _theme: _theme,
    _doSeed: _doSeed,
    _cancelSeed: _cancelSeed,
    exportPicker: exportPicker,
    _setDeadline: _setDeadline,
    _exFarm: _exFarm,
    _exPlot: _exPlot,
    _exAll: _exAll,
    _doExport: _doExport,
    _seedHint: _seedHint,
    _exSeg: _exSeg,
    _opChanged: _opChanged,
    _bulkOpChanged: _bulkOpChanged,
    _setRowFilter: _setRowFilter,
    _grpToggle: _grpToggle,
    _grpAll: _grpAll,
    _filterFarmPick: _filterFarmPick,
    _filterPlotPick: _filterPlotPick,
    _pickShown: _pickShown,
    printPlan: printPlan,
    toOrder: toOrder,
    approveFarm: approveFarm,
    _farmDel: _farmDel,
    _farmMove: _farmMove,
    _farmMoveGo: _farmMoveGo,
    approveAll: approveAll,
    revokeFarm: revokeFarm,
    revokeAll: revokeAll,
    farmState: farmState,
    openPlan: openPlan,
    farmCard: farmCard,
    _logToggle: _logToggle,
    prepareLog: prepareLog,
    logPending: logPending,
    logSection: logSection,
    approvalState: approvalState,
    save: save,
    totals: totals,
    _setPlan: _setPlan,
    _setRow: _setRow,
    _delRow: _delRow,
    _addMat: _addMat,
    _delMat: _delMat,
    _setMat: _setMat,
    _setUnit: _setUnit,
    bulkCarrier: bulkCarrier,
    _bvApply: _bvApply,
    _bvAll: _bvAll,
    _prepTemplate: _prepTemplate,
    _tplToggle: _tplToggle,
    _zToggle: _zToggle,
    _zSet: _zSet,
    _zImg: _zImg,
    _zImgDel: _zImgDel,
    _tplUse: _tplUse,
    _splitOpen: _splitOpen,
    _splitZip: _splitZip,
    splitApp: splitApp,
    _splitGo: _splitGo,
    bulkStart: bulkStart,
    _bsApply: _bsApply,
    _tplSave: _tplSave,
    _tplDel: _tplDel,
    _pickMat: _pickMat
  };
})();
