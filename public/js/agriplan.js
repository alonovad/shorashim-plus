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
 *
 * OWNERSHIP: inside the feature a plan belongs to whoever created it.
 * Admin may edit and delete every plan; an operator may edit and delete
 * only the plans stamped with his own username, and sees everyone else's
 * read-only. This is a UI boundary, not a rules boundary — the whole
 * season is ONE document written wholesale, so Firestore can only see
 * "an operator wrote appData/shorashim-agri-plan-YYYY", never which plan
 * inside it changed. Rules-level ownership needs per-plan documents.
 *
 * APPROVAL is per מטע. A farm's rows reach that farm's card
 * (showFarmDetails → farmCard) only after an admin approves that farm.
 * Each approval stores a signature of what the crew there executes: the
 * plan-wide fields (name, target, deadline, notes), that farm's note and
 * that farm's rows. A farm counts as approved only while its signature still
 * matches — editing farm B's rows withdraws farm B alone; editing a
 * plan-wide field withdraws every farm. No mutator has to remember to reset
 * a flag.
 *
 * Approvals live in their own document, appData/shorashim-agri-approvals-
 * {YYYY}, which firestore.rules lets only an admin write. An operator can
 * write the plans but not an approval, and cannot change approved content
 * without its signature failing — so, unlike ownership, approval is
 * enforced by the rules, not only by this client. Anything called
 * 'approvals' inside the plan document itself is ignored.
 */
var AgriPlan = (function () {
  'use strict';

  var KEY_PREFIX = 'shorashim-agri-plan-';
  // Admin-only in firestore.rules — see APPROVAL in the header.
  var APPROVALS_PREFIX = 'shorashim-agri-approvals-';

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
  // Written out in full on every row and every printed line. A number with
  // no application mode next to it is the thing that gets misread in the
  // field: 43.8 L of טוטם into a sprayer tank and 3.9 L of קוהינור poured
  // around a trunk are not interchangeable operations.
  function modeLabel(method) {
    if (method === 'drench') return tt('להגמעה', 'สำหรับรดโคน', 'للسقي');
    if (method === 'inject') return tt('להזרקה', 'สำหรับฉีด', 'للحقن');
    return tt('למרסס', 'ใส่ถังพ่น', 'لخزان الرش');
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
  var A = {};                    // { planId: { farmId: { by, at, sig } } } for `year`
  var _aLastSaved = '';
  var _openPlan = null;          // plan id being edited
  var _rowFilter = { pid: null, q: '' };   // name filter for the open plan's rows (display only)

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
  // Earliest effective deadline across rows — what a supplier has to beat.
  function earliestDeadline(p, rows) {
    var best = '';
    (rows || []).forEach(function (r) {
      var d = effDeadline(p, r);
      if (d && (!best || d < best)) best = d;
    });
    return best;
  }
  var METHOD_COLOR = { spray: ['#1565c0', '#e3f2fd'], drench: ['#8d5524', '#f6ece3'], inject: ['#7b1fa2', '#f3e5f5'] };
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
      timing: String(r.timing || ''),        // מועד מומלץ (free text — 'סיום גדיד')
      deadline: isoDate(r.deadline),         // תאריך סיום הכרחי; '' = the plan's
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
    return hash(stable({
      name: p.name, target: p.target, deadline: p.deadline, notes: p.notes,
      farmNote: String(((p.farmNotes || {})[String(fid)]) || '').trim(),
      rows: farmRows(p, fid).map(normRow)
    }));
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
    if (s.approved) out += '<span class="ap-st ok">✅ ' + s.approved + '/' + s.total + ' ' + tt('מטעים מאושרים', 'สวนอนุมัติแล้ว', 'بساتين معتمدة') + '</span> ';
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
  // Admin only — the rules reject anyone else. Rebuilt from the plans in
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
  // ── Operations ──
  // An operation is method + round: "ריסוס · 1", "הגמעה ידנית · 1". One plot
  // can carry several — the spray AND a drench in the same season — so
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

  function totals(plan) {
    var byMat = {}, byFarm = {}, farmMat = {}, farmOps = {}, price = {};
    var waterL = 0, trees = 0;
    (plan.rows || []).forEach(function (r) {
      trees += Number(r.trees) || 0;
      waterL += rowCarrierL(r);
      var fid = (r.farmId === null || r.farmId === undefined) ? 0 : r.farmId;
      if (!byFarm[fid]) byFarm[fid] = 0;
      if (!farmMat[fid]) farmMat[fid] = {};
      if (!farmOps[fid]) farmOps[fid] = {};
      var ok = opKey(r.method, r.round);
      if (!farmOps[fid][ok]) farmOps[fid][ok] = { method: r.method, round: String(r.round || '').trim(), mats: {} };
      (r.materials || []).forEach(function (m) {
        if (!m.name) return;
        var litres = rowMaterialL(r, m);
        byMat[m.name] = (byMat[m.name] || 0) + litres;
        farmMat[fid][m.name] = (farmMat[fid][m.name] || 0) + litres;
        farmOps[fid][ok].mats[m.name] = (farmOps[fid][ok].mats[m.name] || 0) + litres;
        byFarm[fid] += litres;
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
      byMat: byMat, byFarm: byFarm, farmMat: farmMat, farmOps: farmOps, price: price,
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
  // Repainting replaces innerHTML wholesale, which resets the scroll box to
  // the top — so adding a material on row 20 threw the user back to row 1.
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
    load().then(function (s) { S = s; listen(); _openPlan = null; renderList(); });
  }

  // The stylesheet lives in <head>, NOT inside the modal markup.
  // paint() replaces modalContainer.innerHTML, which would delete a
  // <style> tag rendered inside it — so the first screen was styled and
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
      '.ap-mat{display:grid;grid-template-columns:1.4fr .7fr .8fr .8fr 30px;gap:5px;margin-top:4px;align-items:center;}' +
      '.ap-out{background:var(--surface,#fff);border-radius:8px;padding:6px 9px;margin-top:6px;font-size:.78rem;' +
        'font-weight:700;color:var(--primary,#2d6a4f);}' +
      '.ap-tot{display:flex;justify-content:space-between;padding:4px 0;font-size:.86rem;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.ap-empty{text-align:center;color:var(--text-muted,#999);padding:18px;font-size:.86rem;}' +
      // Plan header: bordered white card — never confused with a row.
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
        tt('אין תוכניות לעונה זו. תוכנית מחשבת כמויות חומר לפי מספר עצים, נפח לעץ וריכוז — ומייצרת הזמנה.',
           'ยังไม่มีแผนสำหรับฤดูกาลนี้', 'لا توجد خطط لهذا الموسم') + '</div>';
    }
    (S.plans || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .forEach(function (p) {
        var t = totals(p);
        var mats = Object.keys(t.byMat).map(function (nm) {
          return esc(nm) + ' ' + n1(t.byMat[nm]) + 'L';
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
            ' \u00b7 ' + t.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') +
            (t.cost ? ' \u00b7 ' + money(t.cost) : '') + '</div>' +
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
      if (!groups[fk]) { groups[fk] = { html: '', n: 0, trees: 0, ops: [] }; gOrder.push(fk); }
      var g = groups[fk];
      g.html += rowHtml(p, r, i, ro);
      g.n++; g.trees += Number(r.trees) || 0;
      var ol = opLabel(r.method, r.round);
      if (g.ops.indexOf(ol) < 0) g.ops.push(ol);
      shown++;
    });
    var rows = gOrder.map(function (fk) {
      var g = groups[fk];
      return '<div class="ap-grp">' +
        '<div class="ap-grphd">🌳 ' + esc(farmName(Number(fk))) +
          '<span class="n">' + g.n + ' ' + tt('שורות', 'แถว', 'صفوف') + ' · ' +
            g.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + ' · ' + esc(g.ops.join(', ')) + '</span>' +
          (Number(fk) ? farmBadge(p, Number(fk)) + farmApproveBtn(p, Number(fk)) : '') +
        '</div>' + farmIssues(p, Number(fk)) + g.html + '</div>';
    }).join('');
    if (!allRows) {
      rows = '<div class="ap-empty">' + tt('אין עדיין שורות. הוסף מטע שלם, בחר חלקות או הוסף שורה.',
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
          'placeholder="🔍 ' + tt('סינון לפי שם מטע / חלקה (אפשר כמה, מופרדים בפסיק)',
            'กรองตามชื่อสวน/แปลง (คั่นด้วยจุลภาค)', 'تصفية حسب اسم البستان/القطعة (افصل بفاصلة)') + '" ' +
          'value="' + esc(_rowFilter.q) + '" oninput="AgriPlan._setRowFilter(' + id + ',this.value)">' +
        (terms.length ?
          '<span style="font-size:.78rem;color:var(--text-muted,#888);white-space:nowrap;">' +
            shown + ' / ' + allRows + ' ' + tt('שורות', 'แถว', 'صفوف') + '</span>' +
          '<button class="ap-btn ghost" data-no-sticky data-no-back style="padding:5px 10px;" ' +
            'title="' + tt('נקה סינון', 'ล้างตัวกรอง', 'مسح التصفية') + '" ' +
            'onclick="AgriPlan._setRowFilter(' + id + ',\'\')">✕</button>' : '') +
      '</div>' +
      (terms.length ? '<div style="font-size:.74rem;color:var(--text-muted,#888);margin:-4px 2px 8px;">' +
        tt('הסינון משנה רק את התצוגה — הסיכומים, ההדפסה וההזמנה כוללים את כל התוכנית',
           'ตัวกรองมีผลกับการแสดงผลเท่านั้น', 'التصفية للعرض فقط') + '</div>' : '');

    var totHtml = '';
    Object.keys(t.byMat).sort().forEach(function (nm) {
      totHtml += '<div class="ap-tot"><span>' + esc(nm) + '</span><strong>' +
        n1(t.byMat[nm]) + ' ' + tt('ליטר', 'ลิตร', 'لتر') +
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
          return esc(nm) + ' ' + n1(o.mats[nm]) + 'L';
        }).join(' · ');
        if (!mm) return '';
        return '<div style="font-size:.8rem;margin-top:2px;"><b>' + esc(opLabel(o.method, o.round)) + '</b> ' +
          '<span style="color:var(--text-muted,#888);">(' + esc(modeLabel(o.method)) + ')</span>: ' + mm + '</div>';
      }).join('');
      if (!lines) return;
      farmHtml += '<div class="ap-tot" style="display:block;">' +
        '<div>🌳 ' + esc(farmName(Number(fid))) + '</div>' + lines +
        '<input class="ap-in" data-k="fn' + fid + '" style="margin-top:4px;font-size:.76rem;" ' +
          'placeholder="' + tt('הערה למטע זה (תודפס)', 'หมายเหตุสวนนี้', 'ملاحظة لهذا البستان') + '" ' +
          'value="' + esc((p.farmNotes || {})[String(fid)] || '') + '" ' +
          'oninput="AgriPlan._setFarmNote(' + id + ',' + fid + ',this.value)">' +
        '</div>';
    });

    var body =
      (ro ? '<div class="ap-card" style="background:#fff8e1;color:#8d6e00;font-size:.8rem;font-weight:700;">' +
              '🔒 ' + tt('צפייה בלבד — התוכנית נוצרה ע"י ',
                         'ดูอย่างเดียว — แผนสร้างโดย ',
                         'للعرض فقط — أنشأها ') + esc(ownerLabel(p)) +
            '</div>' : '') +
      approvalPanel(p) +
      // The plan's own details: one bordered card, visibly not a row.
      '<div class="ap-plan">' +
        '<div class="ap-plan-hd">📋 ' + tt('פרטי התוכנית', 'รายละเอียดแผน', 'تفاصيل الخطة') +
          '<span class="n">' + allRows + ' ' + tt('שורות', 'แถว', 'صفوف') + ' · ' +
            t.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + '</span>' +
          (p.deadline ? dlChip(p.deadline, false) : '') + '</div>' +
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
      '</div>' +

      '<datalist id="apMats">' + matList + '</datalist>' +
      '<div class="ap-sec">🌱 ' + tt('שורות טיפול', 'แถวการดูแล', 'صفوف المعالجة') +
        '<span class="n">' + gOrder.length + ' ' + tt('מטעים', 'สวน', 'بساتين') + '</span></div>' +
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
        tt('פילוח לפי מטע', 'แยกตามสวน', 'حسب البستان') + '</div>' + farmHtml + '</div>' : '');

    // One native disabled fieldset beats decorating forty inputs: it disables
    // every nested control, including ones added later, and cannot be
    // half-applied. min-width:0 keeps the inner CSS grids from blowing out.
    if (ro) {
      body = '<fieldset disabled style="border:none;padding:0;margin:0;min-width:0;">' +
             body + '</fieldset>';
    }
    // The picker host sits outside that fieldset: exporting a plan you can
    // only view must still work.
    body = filterBar + '<div id="apPicker"></div>' + body;

    var bar = ro ?
      ('<button class="ap-btn ghost" onclick="AgriPlan.printPlan(' + id + ')">\ud83d\udda8 ' +
        tt('הדפסת התוכנית', 'พิมพ์แผน', 'طباعة الخطة') + '</button>' +
       exportBtns(id) +
       '<button class="ap-btn ghost" onclick="AgriPlan.renderList()">\u21a9 ' +
        tt('חזרה', 'กลับ', 'رجوع') + '</button>') :
      '<button class="ap-btn" onclick="AgriPlan.addRow(' + id + ')">\u2795 ' +
        tt('שורה', 'แถว', 'صف') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.seedFromFarm(' + id + ')">\ud83c\udf33 ' +
        tt('מטע שלם', 'ทั้งสวน', 'بستان كامل') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.pickPlots(' + id + ')">\u2611 ' +
        tt('בחר חלקות', 'เลือกแปลง', 'اختر القطع') + '</button>' +
      '<button class="ap-btn ghost" onclick="AgriPlan.bulkMaterial(' + id + ')">\u2697\ufe0f ' +
        tt('חומר למספר מטעים', 'สารหลายสวน', 'مادة لعدة بساتين') + '</button>' +
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
            tt('אשר את כל המטעים', 'อนุมัติทุกสวน', 'اعتماد كل البساتين') + '</button>';
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
      if (!r.farmId) errors.push(who + tt('לא נבחר מטע', 'ไม่ได้เลือกสวน', 'لم يُحدَّد بستان'));
      if (!(Number(r.trees) > 0)) errors.push(who + tt('חסר מספר עצים', 'ไม่มีจำนวนต้น', 'عدد الأشجار مفقود'));
      var mats = (r.materials || []).filter(function (m) { return m.name; });
      if (!mats.length) errors.push(who + tt('לא הוגדר חומר', 'ไม่มีสาร', 'لم تُحدَّد مادة'));
      mats.forEach(function (m) {
        if (!(Number(m.value) > 0)) errors.push(who + esc(m.name) + ' — ' + tt('חסר ריכוז / מינון', 'ไม่มีความเข้มข้น', 'التركيز مفقود'));
        if (m.mode === 'pct' && !(Number(r.carrier) > 0)) errors.push(who + esc(m.name) + ' — ' + tt('ריכוז באחוזים בלי נפח לעץ', 'เปอร์เซ็นต์โดยไม่มีปริมาตร', 'نسبة مئوية بلا حجم للشجرة'));
      });
      if (!effDeadline(p, r)) warnings.push(who + tt('אין תאריך סיום', 'ไม่มีกำหนดเสร็จ', 'لا تاريخ إنهاء'));
    });
    return { errors: errors, warnings: warnings };
  }
  function issuesBox(errors) {
    return '<div class="ap-apv stale">⛔ <strong>' + tt('לא ניתן לאשר — יש לתקן:', 'อนุมัติไม่ได้ — ต้องแก้ไข:', 'لا يمكن الاعتماد — يجب تصحيح:') + '</strong><ul>' +
      errors.slice(0, 30).map(function (e) { return '<li>' + e + '</li>'; }).join('') +
      (errors.length > 30 ? '<li>…</li>' : '') + '</ul></div>';
  }
  function farmIssues(p, fid) {
    return (_issues && _issues.pid === p.id && _issues.fid === fid && _issues.errors.length) ? issuesBox(_issues.errors) : '';
  }
  function farmApproveBtn(p, fid) {
    if (!isAdmin()) return '';
    return farmState(p, fid) === 'approved' ?
      '<button class="ap-btn ghost ap-mini" onclick="AgriPlan.revokeFarm(' + p.id + ',' + fid + ')">↩️ ' +
        tt('בטל אישור', 'ยกเลิก', 'إلغاء') + '</button>' :
      '<button class="ap-btn ok ap-mini" onclick="AgriPlan.approveFarm(' + p.id + ',' + fid + ')">✅ ' +
        tt('אשר מטע זה', 'อนุมัติสวนนี้', 'اعتماد هذا البستان') + '</button>';
  }
  function approvalPanel(p) {
    var s = planSummary(p), html;
    var cls = (s.total && s.approved === s.total) ? 'ok' : (s.stale ? 'stale' : 'draft');
    html = '<div class="ap-apv ' + cls + '">' + approvalBadge(p) + '<br>' +
      tt('כל מטע מאושר בנפרד ומוצג בכרטיס המטע רק אחרי שאושר. שינוי בשורות של מטע מחזיר לאישור רק אותו; שינוי בשם, במזיק, בתאריך הכללי או בהערות מחזיר את כל המטעים.',
         'แต่ละสวนอนุมัติแยกกันและแสดงในบัตรสวนหลังอนุมัติเท่านั้น การแก้แถวของสวนใดต้องอนุมัติสวนนั้นใหม่ การแก้ข้อมูลทั่วไปต้องอนุมัติทุกสวนใหม่',
         'يُعتمد كل بستان على حدة ويظهر في بطاقته بعد اعتماده فقط. تعديل صفوف بستان يعيده وحده للاعتماد؛ تعديل الاسم أو الآفة أو التاريخ العام أو الملاحظات يعيد كل البساتين.') +
      '</div>';
    if (_issues && _issues.pid === p.id && _issues.fid === null && _issues.errors.length) html += issuesBox(_issues.errors);
    return html;
  }
  function me_() { return String((window.currentUser || {}).username || ''); }
  function stamp(p, fid) {
    p.approvals = p.approvals || {};
    p.approvals[String(fid)] = { by: me_(), at: Date.now(), sig: farmSig(p, fid) };
  }
  // Approvals for farms that left the plan are dead weight — and would
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
        tt(' לביצוע? התוכנית תוצג בכרטיס המטע.', ' ? จะแสดงในบัตรสวน', ' للتنفيذ؟ ستظهر الخطة في بطاقة البستان.') + warnText(v.warnings))) return;
    var before = p.approvals[String(fid)] || null;
    stamp(p, fid);
    _issues = null;
    save(); saveApprovals();
    if (window.Audit && Audit.log) Audit.log('approve', 'agriplan', id + ':' + fid, { before: before, after: p.approvals[String(fid)] });
    toast('✅ ' + farmName(fid) + ' ' + tt('אושר ומוצג בכרטיס המטע', 'อนุมัติแล้ว', 'اعتُمد'));
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
        tt(' המטעים בתוכנית לביצוע?', ' สวน?', ' بساتين في الخطة للتنفيذ؟') + warnText(v.warnings))) return;
    var before = JSON.parse(JSON.stringify(p.approvals || {}));
    fids.forEach(function (f) { if (farmState(p, f) !== 'approved') stamp(p, f); });
    _issues = null;
    save(); saveApprovals();
    if (window.Audit && Audit.log) Audit.log('approve', 'agriplan', String(id), { before: before, after: p.approvals });
    toast('✅ ' + tt('כל המטעים אושרו', 'อนุมัติทุกสวนแล้ว', 'اعتُمدت كل البساتين'));
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
    if (!confirm(tt('לבטל את כל האישורים? התוכנית תוסר מכל כרטיסי המטעים.', 'ยกเลิกอนุมัติทั้งหมด?', 'إلغاء كل الاعتمادات؟'))) return;
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
  // that was revoked an hour ago. Seasons y-1..y+1 — a plan filed under
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
          tt('אין תוכנית ריסוס מאושרת למטע זה', 'ไม่มีแผนที่อนุมัติสำหรับสวนนี้', 'لا توجد خطة رش معتمدة لهذا البستان') + '</div>';
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
        if (!o.dose[m.name]) o.dose[m.name] = m.mode === 'pct' ? (m.value + '%') :
          (m.value + ' ' + tt('סמ"ק לעץ', 'ซีซี/ต้น', 'سم³/شجرة'));
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
      (p.notes ? '<div class="ap-fc-sub" style="margin-top:3px;">' + esc(p.notes) + '</div>' : '');
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
          '<strong>' + n1(o.mats[nm]).toLocaleString() + ' ' + tt('ליטר', 'ลิตร', 'لتر') + ' ' + modeLabel(o.method) + '</strong></div>';
      });
      html += '<div class="ap-fc-plots">' + o.rows.map(function (r) {
        var pl = r.plotId ? plotById(r.plotId) : null;
        var nm = pl ? pl.name : (r.plotId ? '#' + r.plotId : tt('כל המטע', 'ทั้งสวน', 'كل البستان'));
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
        tt('ייצוא לחלקה / מטע', 'ส่งออกตามแปลง/สวน', 'تصدير لقطعة/بستان') + '</button>' +
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
      var litres = rowMaterialL(r, m);
      mats += '<div class="ap-mat">' +
        '<input class="ap-in" list="apMats" data-k="m' + i + '-' + mi + '-n" value="' + esc(m.name) + '" placeholder="' +
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
        '<button class="ap-btn warn" data-no-sticky ' +
          'title="' + tt('מחק חומר', 'ลบสาร', 'حذف مادة') + '" style="padding:5px 7px;" ' +
          'onclick="AgriPlan._delMat(' + pid + ',' + i + ',' + mi + ')">\u2715</button>' +
        '<div style="grid-column:1/-1;font-size:.74rem;color:var(--primary,#2d6a4f);font-weight:700;">' +
          '\u2192 ' + n1(litres) + ' ' + tt('ליטר לחלקה', 'ลิตร/แปลง', 'لتر/قطعة') +
          ' \u00b7 ' + modeLabel(r.method) + '</div>' +
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
          (r.cohort ? ' — ' + esc(r.cohort) : '') + '</span>' +
        '<span class="ap-op">' + esc(opLabel(r.method, r.round)) + '</span>' +
        (r.trees ? '<span class="n">' + Number(r.trees).toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + '</span>' : '') +
        dlChip(dl, !r.deadline) +
      '</div>' +
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
        '<div><button class="ap-btn warn" data-no-sticky ' +
          'title="' + tt('מחק שורה', 'ลบแถว', 'حذف صف') + '" style="padding:7px 9px;" ' +
          'onclick="AgriPlan._delRow(' + pid + ',' + i + ')">\ud83d\uddd1</button></div>' +
      '</div>' +

      '<div class="ap-row2">' +
        '<div><div class="ap-lbl">' + tt('סיבוב טיפול', 'รอบ', 'الجولة') + '</div>' +
          '<input class="ap-in" value="' + esc(r.round) + '" placeholder="' +
            tt('ראשון / שני', 'รอบแรก', 'الأولى') + '" ' +
            'oninput="AgriPlan._setRow(' + pid + ',' + i + ',\'round\',this.value)"></div>' +
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
    // Deleting a row drops every material on it and saves immediately —
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
    var copy = '<option value="">' + tt('ללא — אוסיף חומרים אחר כך', 'ไม่มี — เพิ่มทีหลัง', 'بدون — أضيف لاحقاً') + '</option>' +
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
      tt('הפעולה כבר קיימת בתוכנית (' + existing.count + ' שורות) — חלקות שכבר יש להן אותה מסומנות באפור',
         'มีอยู่แล้ว (' + existing.count + ' แถว)', 'موجودة (' + existing.count + ' صفوف)') :
      tt('פעולה חדשה בתוכנית — תיווסף בנפרד מהפעולות הקיימות',
         'การดำเนินการใหม่ — แยกจากที่มีอยู่', 'عملية جديدة — منفصلة عن الموجودة');
    Array.prototype.forEach.call(document.querySelectorAll('.apPickPlot'), function (c) {
      var has = (';' + (c.getAttribute('data-ops') || '') + ';').indexOf(';' + op.key + ';') >= 0;
      c.disabled = has;
      if (has) c.checked = false;
      var lbl = c.closest('.apPickLbl');
      if (lbl) lbl.style.opacity = has ? '.45' : '';
    });
  }

  // Fan a whole farm out into one row per plot, tree counts seeded from the
  // map. This is the realistic entry path — the sheets cover every plot in
  // a מטע, and typing thirty rows by hand invites transcription errors.
  // Rendered as an in-sheet picker rather than window.prompt: a native
  // prompt cannot show plot counts, cannot be styled, and asked the user to
  // retype a number they had just read off a list.
  function seedFromFarm(pid) {
    var p = editable(pid);
    if (!p) return;
    var fs = farms();
    if (!fs.length) { toast('⚠️ ' + tt('אין מטעים', 'ไม่มีสวน', 'لا بساتين')); return; }
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
        '<div style="font-weight:800;margin-bottom:6px;">🌳 ' + tt('הוספת מטע שלם', 'เพิ่มทั้งสวน', 'إضافة بستان كامل') + '</div>' +
        opChooser(p) +
        '<div class="ap-lbl">' + tt('בחר מטע להוספה', 'เลือกสวน', 'اختر البستان') + '</div>' +
        (fs.length > 5 ?
          '<input class="ap-in" type="search" style="width:100%;margin-bottom:6px;" ' +
            'placeholder="🔍 ' + tt('סינון לפי שם מטע', 'กรองตามชื่อสวน', 'تصفية حسب اسم البستان') + '" ' +
            'oninput="AgriPlan._filterFarmPick(this.value)">' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
          '<select class="ap-in" id="apFarmPick" style="flex:1;min-width:200px;">' + opts + '</select>' +
          '<button class="ap-btn" id="apFarmPickAdd" onclick="AgriPlan._doSeed(' + pid + ')">➕ ' +
            tt('הוסף', 'เพิ่ม', 'إضافة') + '</button>' +
          '<button class="ap-btn ghost" onclick="AgriPlan._cancelSeed()">' +
            tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
      '</div>';
    _opChanged(pid);
    host.scrollIntoView({ block: 'nearest' });
  }

  function _cancelSeed() {
    var host = document.getElementById('apPicker');
    if (host) host.innerHTML = '';
  }

  function _setRowFilter(pid, v) {
    _rowFilter = { pid: pid, q: String(v || '') };
    showPlan(pid);
  }

  // Pickers filter in place — no repaint, so ticked boxes survive typing.
  function _filterFarmPick(v) {
    var sel = document.getElementById('apFarmPick');
    if (!sel) return;
    var terms = filterTerms(v), first = null;
    Array.prototype.forEach.call(sel.options, function (o) {
      var ok = matchesAny(terms, [o.getAttribute('data-name') || '']);
      o.hidden = !ok; o.disabled = !ok;   // iOS ignores hidden on <option>
      if (ok && first === null) first = o.value;
    });
    if (sel.selectedOptions[0] && sel.selectedOptions[0].disabled) sel.value = first === null ? '' : first;
    var add = document.getElementById('apFarmPickAdd');
    if (add) add.disabled = first === null;
  }
  function _filterPlotPick(v) {
    var terms = filterTerms(v), shown = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.apPickGrp'), function (g) {
      var farmHit = terms.length && matchesAny(terms, [g.getAttribute('data-name') || '']);
      var any = false;
      Array.prototype.forEach.call(g.querySelectorAll('.apPickLbl'), function (l) {
        var ok = farmHit || matchesAny(terms, [l.getAttribute('data-name') || '']);
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
    var fid = Number(sel.value);
    var op = readOp(p);
    // Plots that already carry this exact operation are skipped, so adding a
    // drench to a farm that has its spray creates drench rows beside the
    // spray rows instead of duplicating either.
    var has = {};
    p.rows.forEach(function (r) { if (opKey(r.method, r.round) === op.key) has[r.plotId] = true; });
    var added = 0, skipped = 0;
    plots().filter(function (pl) { return pl.farm_id === fid; }).forEach(function (pl) {
      if (has[pl.id]) { skipped++; return; }
      p.rows.push(newOpRow(op, fid, pl.id, Number(pl.tree_count) || 0, ''));
      added++;
    });
    if (!added) {
      toast('⚠️ ' + (skipped ?
        tt('לכל החלקות במטע כבר יש את הפעולה הזו', 'ทุกแปลงมีแล้ว', 'كل القطع لديها هذه العملية') :
        tt('אין חלקות במטע זה', 'ไม่มีแปลง', 'لا قطع')));
      return;
    }
    save();
    toast('✅ ' + added + ' ' + tt('שורות נוספו', 'แถวถูกเพิ่ม', 'صفوف أُضيفت') + ' — ' + opLabel(op.method, op.round) +
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
  //  BULK TOOLS — define once, apply across many farms
  // ══════════════════════════════════════════════════════════════════

  // Define a material once — name, mode, rate, price — and push it onto one
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
          tt('הגדרת חומר למספר מטעים', 'กำหนดสารหลายสวน', 'تعريف مادة لعدة بساتين') + '</div>' +
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
            '<input class="ap-in" id="apBulkName" list="apBulkMats"></div>' +
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
          tt('החל על המטעים:', 'ใช้กับสวน:', 'طبّق على البساتين:') + '</div>' +
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
        tt('פעולה בשם הזה כבר קיימת — החומר יתווסף לשורות שלה, ולחלקות שאין להן אותה ייפתחו שורות חדשות',
           'มีอยู่แล้ว — เพิ่มในแถวเดิม', 'موجودة — تضاف إلى صفوفها') :
        tt('ייפתחו שורות חדשות לכל חלקה במטעים המסומנים, בנפרד מהפעולות הקיימות',
           'จะสร้างแถวใหม่แยกต่างหาก', 'ستُنشأ صفوف جديدة منفصلة')) :
      tt('החומר יתווסף רק לשורות של ' + opLabel(tg.method, tg.round) + ' — לא לפעולות אחרות',
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
    // Re-applying the same material updates it in place rather than
    // stacking a duplicate — this is a correction tool as much as an
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
      if (!want[fid] || opKey(r.method, r.round) !== tg.key) return;
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
        if (!want[fid]) return;
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
      toast('⚠️ ' + tt('לא נמצאו שורות במטעים שנבחרו', 'ไม่พบแถว', 'لا صفوف'));
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
  // pickable for a DIFFERENT operation — the drench beside its spray.
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
        return '<label class="apPickLbl" data-name="' + esc(pl.name) + '" style="display:inline-flex;gap:5px;align-items:center;margin:3px 10px 3px 0;font-size:.8rem;">' +
          '<input type="checkbox" class="apPickPlot" value="' + pl.id + '" data-ops="' + esc((ops[pl.id] || []).join(';')) + '"> ' +
          esc(pl.name) +
          ' <span style="color:var(--text-muted,#888);">' + (Number(pl.tree_count) || 0).toLocaleString() + '</span>' +
          (labels[pl.id] ? ' <span style="font-size:.68rem;color:var(--primary,#2d6a4f);">[' + esc(labels[pl.id].join(', ')) + ']</span>' : '') +
          '</label>';
      }).join('');
      html += '<div class="apPickGrp" data-name="' + esc(farmName(Number(fid))) + '" style="margin-bottom:8px;">' +
        '<div style="font-weight:700;font-size:.84rem;margin-bottom:2px;">' +
          '🌳 ' + esc(farmName(Number(fid))) +
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
            'placeholder="🔍 ' + tt('סינון לפי שם מטע / חלקה (אפשר כמה, מופרדים בפסיק)',
              'กรองตามชื่อสวน/แปลง (คั่นด้วยจุลภาค)', 'تصفية حسب اسم البستان/القطعة (افصل بفاصلة)') + '" ' +
            'oninput="AgriPlan._filterPlotPick(this.value)">' +
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
      p.rows.push(newOpRow(op, pl.farm_id || null, pl.id, Number(pl.tree_count) || 0, ''));
      n++;
    });
    if (!n) { toast('⚠️ ' + tt('לא נבחרו חלקות', 'ไม่ได้เลือก', 'لم تُختر قطع')); return; }
    save();
    toast('✅ ' + n + ' ' + tt('שורות נוספו', 'แถวถูกเพิ่ม', 'صفوف أُضيفت') + ' — ' + opLabel(op.method, op.round));
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
      var on = (t.preset || 'forest') === k;
      return '<button onclick="AgriPlan._theme(' + pid + ',\'preset\',\'' + k + '\')" ' +
        'style="padding:8px 12px;border-radius:10px;cursor:pointer;font-family:inherit;font-weight:700;' +
        'font-size:.78rem;color:' + pr.headText + ';background:linear-gradient(135deg,' + pr.c1 + ',' + pr.c3 + ');' +
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
  // computes its own totals from ITS rows only — a grower's sheet must not
  // carry litres that belong to someone else's orchard.
  function planTheme(p) {
    // resolve() reads .report_theme off whatever object it is handed, so the
    // plan borrows the spray log's palettes without pretending to be a farm.
    return (window.ReportTheme && ReportTheme.resolve)
      ? ReportTheme.resolve(p)
      : { c1: '#1a5632', c2: '#2d6a4f', c3: '#40916c', accent: '#2d6a4f',
          headText: '#fff', radius: 16, orientation: 'landscape', footer: '', signature: false };
  }

  function printCss(th) {
    return '' +
      '@page{size:A4 ' + th.orientation + ';margin:9mm;}' +
      'body{font-family:Heebo,Arial,sans-serif;direction:rtl;color:#222;background:#fff;padding:0;margin:0;}' +
      '.hd{background:linear-gradient(135deg,' + th.c1 + ',' + th.c3 + ');color:' + th.headText + ';' +
        'padding:18px 22px;border-radius:0 0 ' + th.radius + 'px ' + th.radius + 'px;margin-bottom:14px;}' +
      '.hd h1{margin:0;font-size:1.4rem;}' +
      '.hd .sub{opacity:.9;font-size:.9rem;margin-top:3px;}' +
      '.hd .kpi{margin-top:10px;font-size:.82rem;opacity:.95;}' +
      '.wrap{padding:0 14px 14px;}' +
      'h2{font-size:1rem;margin:16px 0 6px;color:' + th.c2 + ';border-bottom:2px solid ' + th.c3 + ';' +
        'padding-bottom:3px;}' +
      'h3{font-size:.9rem;margin:0 0 4px;color:' + th.c2 + ';}' +
      'table{width:100%;border-collapse:collapse;margin-bottom:10px;}' +
      'th,td{border:1px solid #c4ccc6;padding:4px 6px;font-size:.7rem;text-align:right;vertical-align:top;}' +
      'th{background:' + th.c2 + ';color:' + th.headText + ';font-weight:800;}' +
      'tfoot td{font-weight:800;background:#f2f6f3;}' +
      '.qty{color:' + th.accent + ';font-weight:800;font-size:.76rem;}' +
      '.rate{color:#666;font-size:.66rem;}' +
      '.mode{color:#8a5a2b;font-size:.66rem;font-weight:700;}' +
      '.farms{display:flex;flex-wrap:wrap;gap:10px;}' +
      '.farm{flex:1 1 220px;border:1px solid #d5ddd7;border-radius:' + th.radius + 'px;padding:8px 10px;}' +
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
            '<span class="rate">' + (m[k].mode === 'pct' ? m[k].value + '%' : m[k].value + ' ' + tt('סמ"ק/עץ', 'ซีซี/ต้น', 'سم³/شجرة')) +
            '</span><br><span class="qty">' + n1(rowMaterialL(r, m[k])) + ' ' +
            tt('ליטר', 'ลิตร', 'لتر') + '</span></td>';
        } else cells += '<td></td>';
      }
      rows += '<tr><td><b>' + esc(methodLabel(r.method)) + '</b><br>' +
          '<span class="mode">' + esc(modeLabel(r.method)) + '</span></td>' +
        '<td>' + esc(farmName(r.farmId)) + '</td>' +
        '<td>' + esc((pl ? pl.name : '') + (r.cohort ? ' — ' + r.cohort : '')) + '</td>' +
        '<td>' + (r.trees || 0).toLocaleString() + '</td>' + cells +
        '<td>' + esc(r.round) + '</td><td>' + esc(r.timing) + '</td>' +
        '<td class="dl">' + esc(fmtDate(effDeadline(p, r))) + '</td>' +
        '<td>' + n1(r.carrier) + ' ' + (r.method === 'inject'
          ? tt('סמ"ק', 'ซีซี', 'سم³') : tt('ליטר', 'ลิตร', 'لتر')) + '</td>' +
        '<td><b>' + n1(rowCarrierL(r)).toLocaleString() + '</b></td></tr>';
    });

    var totRows = '';
    Object.keys(t.byMat).sort().forEach(function (nm) {
      totRows += '<tr><td>' + esc(nm) + '</td><td><b>' + n1(t.byMat[nm]) + '</b></td>' +
        (o.prices ?
          '<td>' + (t.price[nm] ? money(t.price[nm]) : '—') + '</td>' +
          '<td>' + (t.price[nm] ? money(t.byMat[nm] * t.price[nm]) : '—') + '</td>' : '') +
        '</tr>';
    });

    var farmSec = '';
    Object.keys(t.farmOps).forEach(function (fid) {
      var ops = t.farmOps[fid];
      var body = Object.keys(ops).map(function (k) {
        var op = ops[k];
        var names = Object.keys(op.mats).sort();
        if (!names.length) return '';
        return '<tr><td colspan="2" class="op">' + esc(opLabel(op.method, op.round)) +
            ' — ' + esc(modeLabel(op.method)) + '</td></tr>' +
          names.map(function (nm) {
            return '<tr><td>' + esc(nm) + '</td><td><b>' + n1(op.mats[nm]) + ' ' +
              tt('ליטר', 'ลิตร', 'لتر') + '</b></td></tr>';
          }).join('');
      }).join('');
      if (!body) return;
      var note = (p.farmNotes || {})[String(fid)] || '';
      farmSec += '<div class="farm"><h3>🌳 ' + esc(farmName(Number(fid))) + '</h3>' +
        (note ? '<p class="note">' + esc(note) + '</p>' : '') +
        '<table class="mini"><tbody>' + body + '</tbody></table></div>';
    });

    return '<section class="page">' +
      '<div class="hd"><h1>' + esc(p.docTitle || p.name || tt('תוכנית טיפול', 'แผน', 'خطة')) + '</h1>' +
        (p.docSub ? '<div class="sub">' + esc(p.docSub) + '</div>' : '') +
        (o.unit ? '<div class="unit">' + esc(o.unit) + '</div>' : '') +
        '<div class="kpi">' +
          (p.target ? tt('מזיק', 'ศัตรูพืช', 'الآفة') + ': ' + esc(p.target) + ' · ' : '') +
          tt('עונה', 'ฤดูกาล', 'الموسم') + ' ' + esc(year) + ' · ' +
          t.trees.toLocaleString() + ' ' + tt('עצים', 'ต้น', 'شجرة') + ' · ' +
          n1(t.waterL).toLocaleString() + ' ' + tt('ליטר תמיסה', 'ลิตร', 'لتر محلول') +
          (earliestDeadline(p, rowsIn) ? ' \u00b7 ' + tt('לסיום עד', 'เสร็จภายใน', 'الإنهاء حتى') + ' ' +
            fmtDate(earliestDeadline(p, rowsIn)) : '') +
        '</div></div>' +

      '<div class="wrap">' +
      (p.notes ? '<p style="font-size:.82rem;">' + esc(p.notes) + '</p>' : '') +

      '<table><thead><tr>' +
        '<th>' + tt('אופן יישום', 'วิธี', 'طريقة') + '</th><th>' + tt('מטע', 'สวน', 'بستان') + '</th>' +
        '<th>' + tt('חלקה', 'แปลง', 'قطعة') + '</th><th>' + tt('עצים', 'ต้น', 'أشجار') + '</th>' +
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
        tt('ליטר', 'ลิตร', 'لتر') + '</th>' +
        (o.prices ? '<th>' + tt('מחיר לליטר', 'ราคา/ลิตร', 'سعر/لتر') + '</th><th>' +
          tt('עלות', 'ต้นทุน', 'التكلفة') + '</th>' : '') +
        '</tr></thead><tbody>' + totRows + '</tbody>' +
        (o.prices ? '<tfoot><tr><td colspan="3">' + tt('סה"כ', 'รวม', 'المجموع') + '</td><td>' +
          money(t.cost) + '</td></tr></tfoot>' : '') + '</table>' +

      (farmSec ? '<h2>' + tt('פילוח לפי מטע ופעולה', 'แยกตามสวนและการดำเนินการ', 'حسب البستان والعملية') + '</h2>' +
        '<div class="farms">' + farmSec + '</div>' : '') +

      (th.signature ? '<div class="sig"><div>' + tt('אחראי הגנת הצומח', 'ผู้รับผิดชอบ', 'مسؤول وقاية النبات') +
        '</div><div>' + tt('מנהל המטע', 'ผู้จัดการสวน', 'مدير البستان') + '</div></div>' : '') +
      '<div class="ft">' + (th.footer ? esc(th.footer) + '<br>' : '') +
        '\u05e9\u05d5\u05e8\u05e9\u05d9\u05dd \u05e4\u05dc\u05d5\u05e1 \u05d1\u05e2"\u05de / ROOTS PLUS LTD \u00b7 ' +
        new Date().toLocaleDateString('he-IL') + '</div>' +
      '</div></section>';
  }

  // pages: [{ unit, rows }] — one printed page each, in one document, so a
  // single "Save as PDF" yields every grower's sheet and the browser does
  // not block a second popup.
  function exportPages(p, pages, o, suffix) {
    var th = planTheme(p);
    var html = '<!DOCTYPE html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + esc((p.docTitle || p.name) + (suffix ? ' — ' + suffix : '')) + '</title><style>' +
      printCss(th) + '</style></head><body>' +
      pages.map(function (pg) { return pageHtml(p, pg.rows, th, { unit: pg.unit, prices: o.prices }); }).join('') +
      '</body></html>';
    if (window.Util && typeof window.Util.exportReport === 'function') {
      window.Util.exportReport(html, (p.docTitle || p.name || 'plan').replace(/\s+/g, '_') +
        (suffix ? '_' + suffix.replace(/\s+/g, '_') : '') + '_' + year + '.html');
    }
  }

  // ── Supplier quantity sheet / request for quotation ──
  // Quantities per מטע, no prices: what a warehouse or supplier needs to
  // quote. Always branded שורשים regardless of the plan's print theme — it
  // leaves the company, the grower sheets do not.
  var BRAND = { dark: '#1b3a1e', mid: '#2e7d32', light: '#c8e6c9' };
  // The Shorashim Plus mark (triangle with three cuts, from the printed
  // logo). Gradient ids are numbered so header + footer marks in one sheet
  // never share an id.
  var _brandSeq = 0;
  function brandMark(size) {
    var n = ++_brandSeq;
    return '<svg class="mark" viewBox="0 0 118 100" width="' + Math.round(size * 1.18) + '" height="' + size + '" aria-hidden="true">' +
      '<defs><linearGradient id="spA-ag' + n + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f86b3"/><stop offset="0.3" stop-color="#2a9cbf"/><stop offset="1" stop-color="#c8eab5"/></linearGradient>' +
      '<linearGradient id="spB-ag' + n + '" x1="0.22" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="#2799be"/><stop offset="0.5" stop-color="#4aa9bd"/><stop offset="1" stop-color="#c8eab5"/></linearGradient></defs>' +
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
        '<th class="c">' + tt('כמות נדרשת (ליטר)', 'ปริมาณ (ลิตร)', 'الكمية (لتر)') + '</th>' +
        '<th class="fill">' + tt('גודל אריזה', 'ขนาดบรรจุ', 'حجم العبوة') + '</th>' +
        '<th class="fill">' + tt('מחיר ליחידה ₪', 'ราคาต่อหน่วย ₪', 'سعر الوحدة ₪') + '</th>' +
        '<th class="fill">' + tt('סה"כ ₪', 'รวม ₪', 'المجموع ₪') + '</th>' +
      '</tr></thead><tbody>' +
      sum.names.map(function (nm, i) {
        var it = sum.map[nm];
        return '<tr><td class="c">' + (i + 1) + '</td><td><b>' + esc(nm) + '</b></td>' +
          '<td>' + esc(it.uses.join(', ')) + '</td>' +
          '<td class="c qty">' + n1(it.L).toLocaleString() + '</td>' +
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
    var supplyBy = earliestDeadline(p, rows);

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
          (o.due ? '<div class="hl"><span>' + tt('הגשת הצעה עד', 'ส่งภายใน', 'تقديم حتى') + '</span><b>' + esc(fmtDate(o.due)) + '</b></div>' : '') +
          (supplyBy ? '<div class="hl"><span>' + tt('אספקה נדרשת עד', 'ส่งของภายใน', 'التوريد حتى') + '</span><b>' + esc(fmtDate(supplyBy)) + '</b></div>' : '') +
          '<div><span>' + tt('עונה', 'ฤดูกาล', 'الموسم') + '</span><b>' + esc(year) + '</b></div>' +
        '</div>' +
        (sub ? '<h2 class="unit">' + sub + '</h2>' : '');
    };
    var terms = '<div class="terms"><b>' + tt('נא לציין בהצעה:', 'โปรดระบุ:', 'يرجى ذكر:') + '</b> ' +
      tt('מחיר ליחידה לפני מע"מ, גודל אריזה, זמינות במלאי, מועד אספקה ותנאי תשלום. ' +
         'הכמויות מחושבות לפי תוכנית הטיפול ועשויות להתעדכן.',
         'ราคาต่อหน่วยก่อนภาษี ขนาดบรรจุ สต็อก วันส่ง และเงื่อนไขการชำระ',
         'سعر الوحدة قبل الضريبة، حجم العبوة، التوفر، موعد التوريد وشروط الدفع') + '</div>';
    var sign = '<div class="sig"><div>' + tt('שם הספק', 'ชื่อผู้จัดหา', 'اسم المورد') + '</div><div>' +
      tt('חתימה וחותמת', 'ลายเซ็นและตราประทับ', 'التوقيع والختم') + '</div><div>' +
      tt('תאריך', 'วันที่', 'التاريخ') + '</div></div>';
    var foot = '<footer>' + brandMark(16) + ' ' + tt('שורשים — ניהול חקלאי', 'โชราชิม', 'شوراشيم') +
      (contact ? ' · ' + tt('איש קשר', 'ผู้ติดต่อ', 'جهة الاتصال') + ': ' + esc(contact) : '') +
      (u.email ? ' · ' + esc(u.email) : '') + ' · ' + esc(ref) + '</footer>';

    var farmLabel = function (fid) {
      return '🌳 ' + esc(farmName(Number(fid))) + ' <span class="muted">— ' +
        tt('נקודת אספקה', 'จุดส่ง', 'نقطة التوريد') + '</span>';
    };
    var pages = [];
    if (o.mode === 'farm') {
      fOrder.forEach(function (fid) {
        pages.push(head(farmLabel(fid)) + rfqTable(matSummary(byFarm[fid])) + terms + sign + foot);
      });
    } else {
      var all = head(fOrder.length > 1 ?
          tt('סיכום כמויות — כל המטעים', 'สรุปปริมาณ — ทุกสวน', 'ملخص الكميات — كل البساتين') : farmLabel(fOrder[0])) +
        rfqTable(matSummary(rows)) + terms;
      if (fOrder.length > 1) {
        all += '<h2>' + tt('פירוט לפי מטע (נקודות אספקה)', 'แยกตามสวน', 'تفصيل حسب البستان') + '</h2>' +
          fOrder.map(function (fid) {
            var sm = matSummary(byFarm[fid]);
            return '<div class="farm"><h3>' + farmLabel(fid) + '</h3>' +
              '<table class="mini"><tbody>' + sm.names.map(function (nm) {
                return '<tr><td>' + esc(nm) + '</td><td class="c qty">' + n1(sm.map[nm].L).toLocaleString() + ' ' +
                  tt('ליטר', 'ลิตร', 'لتر') + '</td></tr>';
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
      '<title>' + esc(tt('שורשים — בקשה להצעת מחיר', 'ขอใบเสนอราคา', 'طلب عرض سعر') + ' ' + ref) + '</title>' +
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
        g.info[k] = { name: pl ? pl.name : tt('כלל המטע', 'ทั้งสวน', 'كل البستان'), trees: 0, ops: [] };
        g.keys.push(k);
      }
      g.info[k].trees += Number(r.trees) || 0;
      var lbl = opLabel(r.method, r.round);
      if (g.info[k].ops.indexOf(lbl) < 0) g.info[k].ops.push(lbl);
    });

    var tree = farmsOrder.map(function (fid) {
      var g = byFarm[fid];
      return '<div class="apExGrp" data-farm="' + fid + '" style="margin-bottom:8px;">' +
        '<label style="display:flex;gap:6px;align-items:center;font-weight:800;font-size:.86rem;">' +
          '<input type="checkbox" class="apExFarm" value="' + fid + '" ' +
            'onchange="AgriPlan._exFarm(this)"> 🌳 ' + esc(farmName(Number(fid))) +
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
          tt('ייצוא לפי חלקה / מטע', 'ส่งออกตามแปลง/สวน', 'تصدير حسب القطعة/البستان') + '</div>' +
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
        '<div style="max-height:40vh;overflow:auto;">' + tree + '</div>' +
        '<div id="apExGrower"' + (kind === 'rfq' ? ' hidden' : '') + '>' +
          '<div class="ap-lbl" style="margin-top:8px;">' + tt('חלוקה לדפים', 'แบ่งหน้า', 'تقسيم الصفحات') + '</div>' +
          '<div>' +
            radio('plot', tt('דף לכל חלקה', 'หน้าละแปลง', 'صفحة لكل قطعة'), true) +
            radio('farm', tt('דף לכל מטע', 'หน้าละสวน', 'صفحة لكل بستان'), false) +
            radio('one', tt('הכל בדף אחד', 'หน้าเดียว', 'صفحة واحدة'), false) +
          '</div>' +
          '<label style="display:flex;gap:6px;align-items:center;margin-top:6px;font-size:.82rem;">' +
            '<input type="checkbox" id="apExPrices"> ' +
            tt('כלול מחירים ועלות (פנימי — לא למגדל)', 'รวมราคา (ภายใน)', 'تضمين الأسعار (داخلي)') + '</label>' +
        '</div>' +
        '<div id="apExRfq"' + (kind === 'rfq' ? '' : ' hidden') + '>' +
          '<div class="ap-rowgrid" style="grid-template-columns:1.4fr 1fr;margin-top:8px;">' +
            '<div><div class="ap-lbl">' + tt('לכבוד (ספק / מחסן)', 'ถึง (ผู้จัดหา)', 'إلى (المورد)') + '</div>' +
              '<input class="ap-in" id="apRfqTo" placeholder="' + tt('שם הספק', 'ชื่อผู้จัดหา', 'اسم المورد') + '"></div>' +
            '<div><div class="ap-lbl">' + tt('הגשת הצעה עד', 'ส่งใบเสนอราคาภายใน', 'تقديم العرض حتى') + '</div>' +
              '<input class="ap-in" id="apRfqDue" type="date"></div>' +
          '</div>' +
          '<div class="ap-lbl" style="margin-top:8px;">' + tt('מבנה המסמך', 'รูปแบบเอกสาร', 'شكل المستند') + '</div>' +
          '<div>' +
            '<label style="display:inline-flex;gap:5px;align-items:center;margin-inline-end:14px;font-size:.84rem;">' +
              '<input type="radio" name="apRfqMode" value="one" checked> ' +
              tt('מסמך מרוכז + פירוט לכל מטע', 'รวม + แยกตามสวน', 'ملخص + تفصيل لكل بستان') + '</label>' +
            '<label style="display:inline-flex;gap:5px;align-items:center;font-size:.84rem;">' +
              '<input type="radio" name="apRfqMode" value="farm"> ' +
              tt('דף נפרד לכל מטע', 'หน้าละสวน', 'صفحة لكل بستان') + '</label>' +
          '</div>' +
          '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:4px;">' +
            tt('כמויות בלבד, ללא מחירים — עמודות המחיר נשארות ריקות למילוי הספק.',
               'ปริมาณเท่านั้น ไม่มีราคา', 'كميات فقط بلا أسعار') + '</div>' +
        '</div>' +
        '<div id="apExCount" style="font-size:.76rem;color:var(--text-muted,#888);margin-top:6px;"></div>' +
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
      tt('מטעים', 'สวน', 'بساتين') + ' → ' + pages + ' ' + tt('דפים', 'หน้า', 'صفحات');
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
    var pages = [], idx = {};
    rows.forEach(function (r) {
      var fid = r.farmId == null ? 0 : r.farmId;
      var key = mode === 'plot' ? plotKey(r) : (mode === 'farm' ? 'f' + fid : 'all');
      if (!idx[key]) {
        var unit;
        if (mode === 'one') unit = tt('חלקות נבחרות', 'แปลงที่เลือก', 'قطع مختارة');
        else {
          var pl = (mode === 'plot' && r.plotId) ? plotById(r.plotId) : null;
          unit = '🌳 ' + farmName(fid) + (pl ? ' · ' + tt('חלקה', 'แปลง', 'قطعة') + ' ' + pl.name : '');
        }
        idx[key] = { unit: unit, rows: [] };
        pages.push(idx[key]);
      }
      idx[key].rows.push(r);
    });
    var suffix = pages.length === 1 ? pages[0].unit.replace(/^🌳\s*/, '') :
      pages.length + ' ' + tt('דפים', 'หน้า', 'صفحات');
    exportPages(p, pages, { prices: prices }, suffix);
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
    _opChanged: _opChanged,
    _bulkOpChanged: _bulkOpChanged,
    _setRowFilter: _setRowFilter,
    _filterFarmPick: _filterFarmPick,
    _filterPlotPick: _filterPlotPick,
    _pickShown: _pickShown,
    printPlan: printPlan,
    toOrder: toOrder,
    approveFarm: approveFarm,
    approveAll: approveAll,
    revokeFarm: revokeFarm,
    revokeAll: revokeAll,
    farmState: farmState,
    openPlan: openPlan,
    farmCard: farmCard,
    approvalState: approvalState,
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
