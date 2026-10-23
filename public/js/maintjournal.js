/* maintjournal.js — יומן מעקב לפרויקט (project tracking journal)
 * ------------------------------------------------------------------
 * Lives on the maintenance board, inside each project, and opens only
 * once the job is approved — there is nothing being executed to track
 * before that. A completed job's journal stays readable but is locked.
 *
 * PLAN VERSUS ACTUAL, LINE BY LINE
 *   The project's quote lines (materials and labour, including those that
 *   came from a construction BOQ) are brought into the journal as its
 *   planned side: quantity, client value and real cost, exactly as the
 *   quote prices them (Maintenance.journalSource). Against each line you
 *   record what was done (quantity), what it actually cost and its status.
 *   Work logged on a day against a line adds to its done quantity, so the
 *   two never need to be kept in step by hand. A line you add yourself
 *   (work not in the quote) is tracked the same way. If a quote line
 *   changes after it was brought in, the line says so and can be updated.
 *
 * ONE PLACE FOR EACH FACT
 *   Payments to suppliers are the project's invoices; deliveries are its
 *   shipments. The timeline SHOWS them, it does not copy them — so nothing
 *   is entered twice and no two balances can disagree. The journal itself
 *   records what only it knows: money received from the client, work done,
 *   equipment arriving and leaving, and notes.
 *
 * STORAGE
 *   One document per project (shorashim-maint-journal-<id>), not inside the
 *   shared maintenance document: a journal grows for the life of a job and
 *   must not push every other project toward Firestore's 1 MB ceiling. A
 *   failed read is NOT treated as an empty journal — saving is refused
 *   until the journal has been read, so a bad connection cannot wipe it.
 *
 * FROM THE CONSTRUCTION MODULE
 *   A construction project's old journal (shorashim-build-ledger-<id>) is
 *   moved here on request: client receipts, work and equipment as entries,
 *   payments as payments. The old document is kept and marked as moved.
 */
var MaintJournal = (function () {
  'use strict';

  var PREFIX = 'shorashim-maint-journal-';
  var OLD_PREFIX = 'shorashim-build-ledger-';
  var J = {};          // loaded journals, by project id
  var SRC = {};        // last journal source (project lines etc.), by project id
  var UI = {};         // per-project ui state
  var FAIL = {};       // projects whose journal failed to load

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
  function money(n) { return '\u20aa' + Math.round(Number(n) || 0).toLocaleString('he-IL'); }
  function num(n, d) { var x = Number(n) || 0; var k = Math.pow(10, d == null ? 2 : d); return Math.round(x * k) / k; }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(s) { var b = String(s || '').split('-'); return b.length === 3 ? (+b[2]) + '.' + (+b[1]) + '.' + b[0] : String(s || ''); }
  function who() { var u = window.currentUser || {}; return u.name || u.email || ''; }
  function uid() { return 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  // Ownership (Oct 2026): journal entries and items are records — anyone the
  // project lets edit may add them, and each is its creator's to change
  // (legacy ones match by their free-text `by`). The contract terms and
  // milestones belong to the project, so only the project's owner (or
  // admin) changes them.
  function stampIt(o) { if (window.Own) Own.stamp(o); return o; }
  function canRec(o) { return !window.Own || Own.canEdit(o, o && o.by); }
  function deny() { if (window.Own) Own.denied(); return false; }
  function keepStamp(o, src) { ['createdBy', 'createdByName', 'createdAt'].forEach(function (k) { if (src[k] !== undefined && src[k] !== '') o[k] = src[k]; }); return o; }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function audit(action, pid, opts) { try { if (window.Audit && Audit.log) Audit.log(action, 'maint-journal', String(pid), opts || {}); } catch (e) {} }

  // ── model ───────────────────────────────────────────────────────────
  var STATUS = ['', 'todo', 'in_progress', 'done', 'cancelled'];
  function statusLabel(s) {
    return { '': tt('אוטומטי', 'อัตโนมัติ', 'تلقائي'), todo: tt('טרם התחיל', 'ยังไม่เริ่ม', 'لم يبدأ'),
             in_progress: tt('בביצוע', 'กำลังทำ', 'قيد التنفيذ'), done: tt('בוצע', 'เสร็จ', 'منجز'),
             cancelled: tt('בוטל', 'ยกเลิก', 'ملغى') }[s] || s;
  }
  var KINDS = ['work', 'in', 'equip_on', 'equip_off', 'note'];
  function kindLabel(k) {
    return { work: '\ud83d\udd28 ' + tt('עבודה שבוצעה', 'งานที่ทำ', 'عمل منجز'),
             'in': '\ud83d\udcb0 ' + tt('התקבל מהלקוח', 'รับจากลูกค้า', 'مقبوض من العميل'),
             equip_on: '\ud83d\ude9c ' + tt('ציוד הגיע לשטח', 'อุปกรณ์มาถึง', 'وصلت معدات'),
             equip_off: '\ud83d\ude9a ' + tt('ציוד יצא מהשטח', 'อุปกรณ์ออก', 'غادرت معدات'),
             note: '\ud83d\udcdd ' + tt('הערה', 'หมายเหตุ', 'ملاحظة'),
             out: '\ud83e\uddfe ' + tt('תשלום', 'จ่าย', 'دفعة') }[k] || k;
  }
  function normItem(i) {
    i = i || {};
    var o = { ref: String(i.ref || ('extra:' + uid())), kind: ['materials', 'labor', 'extra'].indexOf(i.kind) >= 0 ? i.kind : 'extra',
              name: String(i.name || '').slice(0, 200), unit: String(i.unit || '').slice(0, 20),
              planQty: Math.max(0, Number(i.planQty) || 0), planClient: Math.max(0, Number(i.planClient) || 0),
              planCost: Math.max(0, Number(i.planCost) || 0), adj: Number(i.adj) || 0,
              status: STATUS.indexOf(i.status) >= 0 ? i.status : '', note: String(i.note || '').slice(0, 400),
              by: String(i.by || ''), at: String(i.at || '') };
    keepStamp(o, i);
    o.actualCost = (i.actualCost === null || i.actualCost === undefined || i.actualCost === '' || !isFinite(Number(i.actualCost))) ? null : Math.max(0, Number(i.actualCost));
    return o;
  }
  function normEntry(e) {
    e = e || {};
    return keepStamp({ id: String(e.id || uid()), date: /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) ? String(e.date) : today(),
             kind: (KINDS.indexOf(e.kind) >= 0 || e.kind === 'out') ? e.kind : 'note',
             text: String(e.text || '').slice(0, 400), amount: Math.max(0, Number(e.amount) || 0), qty: Math.max(0, Number(e.qty) || 0),
             ref: String(e.ref || ''), cat: String(e.cat || ''), by: String(e.by || ''), at: String(e.at || '') }, e);
  }
  // Contract terms as they bear on execution: a payment schedule whose
  // milestones fall due by what has been DONE, and the dates the job was
  // agreed to run between. Kept in the journal (operator-writable), next to
  // the execution it is measured against.
  var TRIGGERS = ['sign', 'progress', 'items', 'date', 'completed'];
  function triggerLabel(t) {
    return { sign: tt('בחתימת החוזה', 'เมื่อลงนาม', 'عند التوقيع'), progress: tt('בהגעה לאחוז ביצוע', 'เมื่อถึง % งาน', 'عند نسبة إنجاز'),
             items: tt('בסיום סעיפים מסוימים', 'เมื่อรายการเสร็จ', 'عند إنجاز بنود'), date: tt('בתאריך', 'ในวันที่', 'في تاريخ'),
             completed: tt('בסיום ומסירה', 'เมื่อส่งมอบ', 'عند التسليم') }[t] || t;
  }
  function normMilestone(m) {
    m = m || {};
    return { id: String(m.id || uid()), name: String(m.name || '').slice(0, 120), pct: Math.max(0, Math.min(100, Number(m.pct) || 0)),
             trigger: TRIGGERS.indexOf(m.trigger) >= 0 ? m.trigger : 'progress',
             progress: Math.max(0, Math.min(100, Number(m.progress) || 0)),
             refs: Array.isArray(m.refs) ? m.refs.map(String).slice(0, 200) : [],
             date: /^\d{4}-\d{2}-\d{2}$/.test(String(m.date)) ? String(m.date) : '' };
  }
  function normTerms(t) {
    t = (t && typeof t === 'object') ? t : {};
    var d = function (v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : ''; };
    return { start: d(t.start), end: d(t.end), retention: Math.max(0, Math.min(20, Number(t.retention) || 0)),
             milestones: (Array.isArray(t.milestones) ? t.milestones : []).map(normMilestone) };
  }
  function normDoc(d) {
    d = (d && typeof d === 'object') ? d : {};
    return { v: 1, items: (Array.isArray(d.items) ? d.items : []).map(normItem), terms: normTerms(d.terms),
             entries: (Array.isArray(d.entries) ? d.entries : []).map(normEntry),
             migratedFrom: d.migratedFrom || null, updatedAt: Number(d.updatedAt) || 0 };
  }

  // ── derived ─────────────────────────────────────────────────────────
  function doneQty(doc, it) {
    var q = it.adj || 0;
    doc.entries.forEach(function (e) { if (e.kind === 'work' && e.ref === it.ref) q += e.qty || 0; });
    return Math.max(0, num(q, 3));
  }
  function itemStatus(doc, it) {
    if (it.status) return it.status;
    var d = doneQty(doc, it);
    if (d <= 0) return 'todo';
    return (it.planQty > 0 && d < it.planQty) ? 'in_progress' : 'done';
  }
  function itemPct(doc, it) {
    var s = itemStatus(doc, it);
    if (s === 'done') return 1;
    if (s === 'cancelled' || !(it.planQty > 0)) return 0;
    return Math.min(1, doneQty(doc, it) / it.planQty);
  }
  function figures(doc, src) {
    var f = { planned: 0, earned: 0, planCost: 0, actualCost: 0, actualCostPlan: 0, received: 0, paidOut: 0, items: 0, done: 0 };
    doc.items.forEach(function (it) {
      if (itemStatus(doc, it) === 'cancelled') return;
      f.items++;
      f.planned += it.planClient;
      f.planCost += it.planCost;
      f.earned += it.planClient * itemPct(doc, it);
      if (itemStatus(doc, it) === 'done') f.done++;
      if (it.actualCost != null) { f.actualCost += it.actualCost; f.actualCostPlan += it.planCost; }
    });
    doc.entries.forEach(function (e) {
      if (e.kind === 'in') f.received += e.amount;
      if (e.kind === 'out') f.paidOut += e.amount;
    });
    f.contract = (src && (src.contractValue || src.beforeVat)) || f.planned;
    f.paid = ((src && src.invoicePaid) || 0) + f.paidOut;
    f.due = f.contract - f.received;
    f.pct = f.planned > 0 ? f.earned / f.planned : 0;
    return f;
  }
  // Each milestone: its amount, whether execution has reached it, and how
  // much of it the client's receipts cover (receipts fill milestones in
  // schedule order). "Due now" is what execution has earned under the
  // contract minus what was received, less retention until completion.
  function contractState(doc, src, f) {
    var terms = doc.terms || normTerms(null), ct = (src && src.contract) || {};
    var signed = !!(ct.signedDate || ['signed', 'active', 'completed'].indexOf(ct.status) >= 0);
    var completed = !!(src && src.status === 'completed');
    var todayS = today(), itemsBy = {};
    doc.items.forEach(function (it) { itemsBy[it.ref] = it; });
    var left = f.received, reachedSum = 0, list = [];
    terms.milestones.forEach(function (m) {
      var amount = f.contract * m.pct / 100, reached = false, why = '';
      if (m.trigger === 'sign') { reached = signed; why = signed ? (ct.signedDate || '') : tt('החוזה לא סומן כנחתם', 'ยังไม่ลงนาม', 'لم يوقّع'); }
      else if (m.trigger === 'progress') { reached = f.pct * 100 >= m.progress - 0.001; why = Math.round(f.pct * 100) + '% / ' + m.progress + '%'; }
      else if (m.trigger === 'items') {
        var refs = m.refs.filter(function (r) { return itemsBy[r]; });
        var doneN = refs.filter(function (r) { var st = itemStatus(doc, itemsBy[r]); return st === 'done' || st === 'cancelled'; }).length;
        reached = refs.length > 0 && doneN === refs.length; why = doneN + '/' + refs.length + ' ' + tt('סעיפים', 'รายการ', 'بنود');
      }
      else if (m.trigger === 'date') { reached = !!m.date && todayS >= m.date; why = m.date ? fmtDate(m.date) : '\u2014'; }
      else if (m.trigger === 'completed') { reached = completed; why = completed ? tt('הושלם', 'เสร็จ', 'مكتمل') : tt('טרם הושלם', 'ยังไม่เสร็จ', 'لم يكتمل'); }
      var covered = Math.min(amount, Math.max(0, left)); left -= covered;
      if (reached) reachedSum += amount;
      var state = covered >= amount - 0.5 && amount > 0 ? 'paid' : covered > 0 ? 'partial' : reached ? 'due' : 'future';
      list.push({ m: m, amount: amount, reached: reached, why: why, covered: covered, state: state });
    });
    var pctSum = terms.milestones.reduce(function (a, m) { return a + m.pct; }, 0);
    var held = completed ? 0 : reachedSum * terms.retention / 100;
    var out = { list: list, pctSum: pctSum, earnedByContract: reachedSum, held: held,
                dueNow: Math.max(0, reachedSum - held - f.received), overpaid: Math.max(0, f.received - reachedSum) };
    // schedule: where the job should be by today if work ran evenly
    if (terms.start && terms.end && terms.end > terms.start) {
      var t0 = Date.parse(terms.start), t1 = Date.parse(terms.end), tn = Date.parse(todayS);
      out.expected = Math.max(0, Math.min(1, (tn - t0) / (t1 - t0)));
      out.gap = f.pct - out.expected;
      out.daysLeft = Math.round((t1 - tn) / 86400000);
    }
    return out;
  }

  // equipment on site = arrivals minus departures, by name
  function onSite(doc) {
    var m = {};
    doc.entries.forEach(function (e) {
      if (e.kind !== 'equip_on' && e.kind !== 'equip_off') return;
      var k = (e.text || '').trim(); if (!k) return;
      m[k] = (m[k] || 0) + (e.kind === 'equip_on' ? 1 : -1) * (e.qty || 1);
    });
    return Object.keys(m).filter(function (k) { return m[k] > 0; }).map(function (k) { return { name: k, qty: m[k] }; });
  }

  // ── storage ─────────────────────────────────────────────────────────
  function load(pid) {
    var key = PREFIX + pid;
    var get = (typeof DB !== 'undefined' && DB.loadFresh) ? DB.loadFresh(key) : (typeof DB !== 'undefined' ? DB.loadAsync(key) : Promise.resolve(null));
    return get.then(function (d) { J[pid] = normDoc(d); delete FAIL[pid]; return J[pid]; },
                    function (err) { FAIL[pid] = true; throw err; });
  }
  function save(pid) {
    if (FAIL[pid] || !J[pid]) { toast('\u26a0\ufe0f ' + tt('היומן לא נטען — השמירה בוטלה', 'โหลดไม่สำเร็จ', 'لم يُحمّل السجل')); return false; }
    J[pid].updatedAt = Date.now();
    if (typeof DB !== 'undefined') DB.save(PREFIX + pid, JSON.parse(JSON.stringify(J[pid])));
    return true;
  }
  function source(pid) {
    if (!window.Maintenance || !Maintenance.journalSource) return Promise.resolve(null);
    return Maintenance.journalSource(pid).then(function (s) { SRC[pid] = s; return s; });
  }

  // ── tab ─────────────────────────────────────────────────────────────
  function tab(p, opts) {
    var pid = p.id;
    UI[pid] = UI[pid] || { pick: false, open: {}, kind: 'work' };
    UI[pid].canEdit = !!(opts && opts.canEdit);
    UI[pid].completed = !!(opts && opts.completed);
    UI[pid].ownP = !window.Own || Own.canEdit(p);
    setTimeout(function () { refresh(pid); }, 0);
    return '<div id="mjRoot" data-pid="' + pid + '"><div style="text-align:center;padding:24px;color:var(--text-muted,#888);">\u23f3 ' +
      tt('טוען יומן…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div></div>';
  }
  function refresh(pid) {
    Promise.all([J[pid] ? Promise.resolve(J[pid]) : load(pid), source(pid)]).then(function () {
      render(pid);
      checkOld(pid);
    }, function () {
      var root = rootFor(pid);
      if (root) root.innerHTML = '<div style="padding:16px;border-radius:10px;background:#fff3e0;color:#8a4b00;">\u26a0\ufe0f ' +
        tt('לא ניתן לטעון את היומן. לא נשמר דבר — נסה שוב כשיש חיבור.', 'โหลดไม่สำเร็จ', 'تعذر تحميل السجل') +
        ' <button onclick="MaintJournal._retry(' + pid + ')" style="margin-inline-start:8px;padding:5px 10px;border-radius:8px;border:none;background:#ef6c00;color:#fff;font-family:inherit;cursor:pointer;">\u21bb ' +
        tt('נסה שוב', 'ลองใหม่', 'إعادة') + '</button></div>';
    });
  }
  function rootFor(pid) {
    var r = document.getElementById('mjRoot');
    return (r && String(r.getAttribute('data-pid')) === String(pid)) ? r : null;
  }

  var S = {
    card: 'background:var(--card-solid,#fff);border:1px solid var(--border,#e3e3e3);border-radius:12px;padding:12px;margin-bottom:12px;',
    head: 'font-size:.78rem;font-weight:800;color:var(--primary,#1b5e20);margin-bottom:8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;',
    in: 'padding:6px 8px;border-radius:8px;border:1px solid var(--border,#ddd);font-family:inherit;font-size:.82rem;background:var(--surface-input,#fff);color:inherit;box-sizing:border-box;',
    btn: 'padding:6px 12px;border-radius:8px;border:1px solid var(--primary,#4caf50);background:transparent;color:var(--primary,#2e7d32);font-family:inherit;font-weight:600;font-size:.78rem;cursor:pointer;',
    pri: 'padding:7px 14px;border-radius:8px;border:none;background:var(--primary,#2e7d32);color:#fff;font-family:inherit;font-weight:700;font-size:.8rem;cursor:pointer;',
    muted: 'font-size:.72rem;color:var(--text-muted,#888);'
  };

  function render(pid) {
    var root = rootFor(pid); if (!root) return;
    var doc = J[pid], src = SRC[pid] || { lines: [], invoices: [], shipments: [] }, ui = UI[pid], ed = ui.canEdit, edT = ed && ui.ownP;
    var f = figures(doc, src);
    var cs = contractState(doc, src, f);
    var h = '';
    if (ui.completed) h += '<div style="' + S.card + 'background:#eceff1;">\ud83d\udd12 ' +
      tt('הפרויקט הושלם — היומן לקריאה בלבד.', 'โครงการเสร็จแล้ว อ่านอย่างเดียว', 'المشروع مكتمل — للقراءة فقط') + '</div>';
    if (ui.old && ui.old.count && edT && !doc.migratedFrom) {
      h += '<div style="' + S.card + 'background:#e3f2fd;border-color:#90caf9;">\ud83d\udce6 ' +
        tt('לפרויקט הבנייה המקושר יש יומן מעקב ישן עם', 'มีบันทึกเก่า', 'يوجد سجل قديم فيه') + ' <b>' + ui.old.count + '</b> ' + tt('רישומים.', 'รายการ', 'سجلات') +
        ' <button style="' + S.pri + 'margin-inline-start:8px;" onclick="MaintJournal._migrate(' + pid + ')">\u21aa ' +
        tt('העבר אותם ליומן הזה', 'ย้ายมาที่นี่', 'انقلها إلى هنا') + '</button></div>';
    }

    // ── summary
    var cell = function (label, val, sub, col) {
      return '<div style="flex:1 1 120px;background:var(--surface-glass,#f5f7f5);border-radius:10px;padding:8px 10px;">' +
        '<div style="' + S.muted + '">' + label + '</div><div style="font-weight:800;font-size:1rem;' + (col ? 'color:' + col + ';' : '') + '">' + val + '</div>' +
        (sub ? '<div style="' + S.muted + '">' + sub + '</div>' : '') + '</div>';
    };
    h += '<div style="' + S.card + '"><div style="' + S.head + '">\ud83d\udcca ' + tt('מצב הפרויקט', 'สถานะโครงการ', 'حالة المشروع') + '</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        cell(src.contractValue ? tt('חוזה', 'สัญญา', 'العقد') : tt('הצעת מחיר', 'ใบเสนอราคา', 'عرض السعر'), money(f.contract), tt('לפני מע"מ', 'ก่อน VAT', 'قبل الضريبة')) +
        cell(tt('התקבל מהלקוח', 'รับจากลูกค้า', 'المقبوض'), money(f.received), tt('יתרה', 'คงเหลือ', 'المتبقي') + ' ' + money(f.due), '#2e7d32') +
        cell(tt('שולם לספקים', 'จ่ายผู้ขาย', 'المدفوع للموردين'), money(f.paid), tt('מהחשבוניות', 'จากใบแจ้งหนี้', 'من الفواتير'), '#c62828') +
        cell(tt('בוצע (לפי סעיפים)', 'ความคืบหน้า', 'المنجز'), Math.round(f.pct * 100) + '%', money(f.earned) + ' / ' + money(f.planned), '#1565c0') +
        (cs.list.length ? cell(tt('לגבייה עכשיו לפי החוזה', 'ถึงกำหนดเก็บตามสัญญา', 'المستحق الآن حسب العقد'), money(cs.dueNow),
            cs.held ? tt('עיכבון', 'เงินประกัน', 'محتجز') + ' ' + money(cs.held) : '', cs.dueNow > 0 ? '#ef6c00' : '#2e7d32') : '') +
      '</div>' +
      (cs.expected != null
        ? '<div style="margin-top:8px;font-size:.8rem;">\ud83d\udcc5 ' + tt('לפי לוח הזמנים היה צריך להיות', 'ตามกำหนดควรอยู่ที่', 'حسب الجدول يجب أن يكون') + ' <b>' +
            Math.round(cs.expected * 100) + '%</b> \u00b7 ' + tt('בפועל', 'จริง', 'فعلياً') + ' <b>' + Math.round(f.pct * 100) + '%</b> \u00b7 <b style="color:' +
            (cs.gap < -0.05 ? '#c62828' : cs.gap > 0.05 ? '#2e7d32' : 'inherit') + ';">' +
            (Math.abs(cs.gap) <= 0.05 ? tt('בזמן', 'ตรงเวลา', 'في الموعد') : cs.gap < 0 ? tt('בפיגור של', 'ล่าช้า', 'متأخر بـ') + ' ' + Math.round(-cs.gap * 100) + '%'
              : tt('מקדים ב-', 'เร็วกว่า', 'متقدم بـ') + Math.round(cs.gap * 100) + '%') + '</b>' +
            (cs.daysLeft != null ? ' \u00b7 ' + (cs.daysLeft >= 0 ? cs.daysLeft + ' ' + tt('ימים לסיום', 'วันเหลือ', 'يوماً متبقياً')
                                                           : Math.abs(cs.daysLeft) + ' ' + tt('ימים אחרי מועד הסיום', 'วันเกินกำหนด', 'يوماً بعد الموعد')) : '') + '</div>'
        : '') +
      (f.actualCostPlan > 0
        ? '<div style="margin-top:8px;font-size:.8rem;">' + tt('עלות בפועל בסעיפים שעודכנו', 'ต้นทุนจริง', 'التكلفة الفعلية') + ': <b>' + money(f.actualCost) + '</b> ' +
          tt('מול מתוכנן', 'เทียบกับแผน', 'مقابل المخطط') + ' ' + money(f.actualCostPlan) + ' \u00b7 <b style="color:' + (f.actualCost > f.actualCostPlan ? '#c62828' : '#2e7d32') + ';">' +
          (f.actualCost > f.actualCostPlan ? '+' : '') + money(f.actualCost - f.actualCostPlan) + '</b></div>'
        : '') +
    '</div>';

    // ── contract terms against execution
    var T = doc.terms, ct = src.contract || {};
    h += '<div style="' + S.card + '"><div style="' + S.head + '">\ud83d\udcdc ' + tt('תנאי חוזה מול ביצוע', 'เงื่อนไขสัญญาเทียบงาน', 'شروط العقد مقابل التنفيذ') +
      ' <span style="' + S.muted + 'font-weight:400;">' + (ct.number ? '#' + esc(ct.number) + ' \u00b7 ' : '') +
        (ct.signedDate ? tt('נחתם', 'ลงนาม', 'وُقّع') + ' ' + fmtDate(ct.signedDate) : tt('לא נחתם', 'ยังไม่ลงนาม', 'غير موقّع')) +
        (ct.paymentTerms ? ' \u00b7 ' + esc(ct.paymentTerms) : '') + '</span></div>';
    // dates and retention
    var dIn = function (k, v) {
      return edT ? '<input type="date" style="' + S.in + '" value="' + esc(v) + '" onchange="MaintJournal._term(' + pid + ',\'' + k + '\',this.value)">' : '<b>' + (v ? fmtDate(v) : '\u2014') + '</b>';
    };
    h += '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;font-size:.8rem;margin-bottom:8px;">' +
      '<span>' + tt('התחלה', 'เริ่ม', 'البداية') + ' ' + dIn('start', T.start) + '</span>' +
      '<span>' + tt('סיום מתוכנן', 'สิ้นสุด', 'النهاية') + ' ' + dIn('end', T.end) + '</span>' +
      '<span>' + tt('עיכבון עד המסירה', 'เงินประกัน', 'الاحتجاز') + ' ' + (edT ? '<input type="number" min="0" max="20" step="1" style="' + S.in + 'width:58px;" value="' + T.retention +
        '" onchange="MaintJournal._term(' + pid + ',\'retention\',this.value)">' : '<b>' + T.retention + '</b>') + '%</span>' +
    '</div>';
    if (!T.milestones.length) {
      h += '<div style="' + S.muted + 'padding:6px 0;">' + tt('לא הוגדרו אבני דרך לתשלום. אבן דרך קובעת איזה חלק מהחוזה מגיע ומתי — בחתימה, באחוז ביצוע, בסיום סעיפים, בתאריך או במסירה.',
        'ยังไม่มีงวดชำระ', 'لا مراحل دفع بعد') + '</div>' +
        (edT ? '<div style="display:flex;gap:6px;flex-wrap:wrap;"><button style="' + S.btn + '" onclick="MaintJournal._msTemplate(' + pid + ')">\ud83d\udcc4 ' +
                tt('לוח תשלומים מקובל (20/30/40/10)', 'แม่แบบ', 'جدول نموذجي') + '</button>' +
              '<button style="' + S.btn + '" onclick="MaintJournal._msAdd(' + pid + ')">\u2795 ' + tt('אבן דרך', 'งวด', 'مرحلة') + '</button></div>' : '');
    } else {
      var chip = function (st) {
        var c = { paid: ['#e8f5e9', '#2e7d32', tt('שולם', 'ชำระแล้ว', 'مدفوع')], partial: ['#fff8e1', '#8a6d00', tt('שולם חלקית', 'บางส่วน', 'جزئي')],
                  due: ['#fff3e0', '#e65100', tt('מגיע לגבייה', 'ถึงกำหนด', 'مستحق')], future: ['#eceff1', '#607d8b', tt('טרם הגיע', 'ยังไม่ถึง', 'لم يحن')] }[st];
        return '<span style="font-size:.7rem;font-weight:700;border-radius:6px;padding:2px 7px;background:' + c[0] + ';color:' + c[1] + ';">' + c[2] + '</span>';
      };
      cs.list.forEach(function (row, mi) {
        var m = row.m, openM = !!ui.open['ms:' + m.id];
        h += '<div style="border-top:1px solid var(--border,#eee);padding:8px 0;">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<b style="flex:1 1 160px;font-size:.85rem;">' + esc(m.name || triggerLabel(m.trigger)) + '</b>' +
            '<span style="font-size:.8rem;">' + m.pct + '% \u00b7 <b>' + money(row.amount) + '</b></span>' + chip(row.state) +
            (edT ? '<button style="' + S.btn + 'padding:3px 8px;" onclick="MaintJournal._msOpen(' + pid + ',' + mi + ')">' + (openM ? '\u25b4' : '\u270e') + '</button>' : '') +
          '</div>' +
          '<div style="' + S.muted + '">' + triggerLabel(m.trigger) + ' \u00b7 ' + esc(row.why) +
            (row.covered > 0 && row.state !== 'paid' ? ' \u00b7 ' + tt('התקבל', 'รับแล้ว', 'المقبوض') + ' ' + money(row.covered) : '') + '</div>';
        if (edT && openM) {
          h += '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;padding:8px;border-radius:8px;background:var(--surface-glass,#f5f7f5);">' +
            '<input style="' + S.in + 'flex:1 1 160px;" value="' + esc(m.name) + '" placeholder="' + esc(tt('שם אבן הדרך', 'ชื่องวด', 'اسم المرحلة')) + '" onchange="MaintJournal._ms(' + pid + ',' + mi + ',\'name\',this.value)">' +
            '<label style="' + S.muted + '">% <input type="number" min="0" max="100" step="1" style="' + S.in + 'width:62px;" value="' + m.pct + '" onchange="MaintJournal._ms(' + pid + ',' + mi + ',\'pct\',this.value)"></label>' +
            '<select style="' + S.in + '" onchange="MaintJournal._ms(' + pid + ',' + mi + ',\'trigger\',this.value)">' +
              TRIGGERS.map(function (t) { return '<option value="' + t + '"' + (t === m.trigger ? ' selected' : '') + '>' + triggerLabel(t) + '</option>'; }).join('') + '</select>' +
            (m.trigger === 'progress' ? '<label style="' + S.muted + '"><input type="number" min="0" max="100" step="5" style="' + S.in + 'width:62px;" value="' + m.progress + '" onchange="MaintJournal._ms(' + pid + ',' + mi + ',\'progress\',this.value)"> %</label>' : '') +
            (m.trigger === 'date' ? '<input type="date" style="' + S.in + '" value="' + esc(m.date) + '" onchange="MaintJournal._ms(' + pid + ',' + mi + ',\'date\',this.value)">' : '') +
            '<button style="' + S.btn + 'color:#c62828;border-color:#ef9a9a;" onclick="MaintJournal._msDel(' + pid + ',' + mi + ')">\ud83d\uddd1</button>' +
            (m.trigger === 'items'
              ? '<div style="flex-basis:100%;max-height:160px;overflow:auto;">' + (doc.items.length ? doc.items.map(function (it) {
                  return '<label style="display:flex;gap:6px;align-items:center;font-size:.78rem;padding:2px 0;"><input type="checkbox"' + (m.refs.indexOf(it.ref) >= 0 ? ' checked' : '') +
                    ' onchange="MaintJournal._msRef(' + pid + ',' + mi + ',this)" data-ref="' + esc(it.ref) + '"> ' + esc(it.name) + '</label>';
                }).join('') : '<span style="' + S.muted + '">' + tt('הכנס קודם סעיפים ליומן', 'นำเข้ารายการก่อน', 'أدخل البنود أولاً') + '</span>') + '</div>'
              : '') +
          '</div>';
        }
        h += '</div>';
      });
      h += '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;font-size:.8rem;">' +
        (edT ? '<button style="' + S.btn + '" onclick="MaintJournal._msAdd(' + pid + ')">\u2795 ' + tt('אבן דרך', 'งวด', 'مرحلة') + '</button>' : '') +
        '<span style="flex:1"></span>' +
        (Math.abs(cs.pctSum - 100) > 0.01 ? '<span style="color:#e65100;">\u26a0\ufe0f ' + tt('סך אבני הדרך', 'รวมงวด', 'مجموع المراحل') + ' ' + cs.pctSum + '% ' + tt('(צריך 100%)', '(ควรเป็น 100%)', '(يجب 100%)') + '</span>' : '') +
        '<span>' + tt('מגיע לפי ביצוע', 'ได้ตามงาน', 'المستحق بالتنفيذ') + ' <b>' + money(cs.earnedByContract) + '</b> \u00b7 ' +
          tt('התקבל', 'รับแล้ว', 'المقبوض') + ' <b>' + money(f.received) + '</b>' +
          (cs.overpaid > 0 ? ' \u00b7 <span style="color:#1565c0;">' + tt('מקדמה מעבר לביצוע', 'ล่วงหน้า', 'مقدم يتجاوز التنفيذ') + ' ' + money(cs.overpaid) + '</span>' : '') + '</span>' +
      '</div>';
    }
    h += '</div>';

    // ── items: plan vs actual
    var inJ = {}; doc.items.forEach(function (it) { inJ[it.ref] = it; });
    var fresh = src.lines.filter(function (l) { return !inJ[l.ref]; });
    h += '<div style="' + S.card + '"><div style="' + S.head + '">\ud83d\udccb ' + tt('סעיפים — תוכנית מול ביצוע', 'รายการ — แผนเทียบกับจริง', 'البنود — المخطط مقابل المنفذ') +
      ' <span style="' + S.muted + 'font-weight:400;">' + f.done + '/' + f.items + ' ' + tt('בוצעו', 'เสร็จ', 'منجزة') + '</span><span style="flex:1"></span>' +
      (ed && fresh.length ? '<button style="' + S.btn + '" onclick="MaintJournal._pick(' + pid + ')">\ud83d\udce5 ' +
        tt('סעיפים מהצעת המחיר', 'จากใบเสนอราคา', 'من عرض السعر') + ' (' + fresh.length + ')</button>' : '') +
      (ed ? '<button style="' + S.btn + '" onclick="MaintJournal._addExtra(' + pid + ')">\u2795 ' + tt('סעיף נוסף', 'รายการเพิ่ม', 'بند إضافي') + '</button>' : '') +
    '</div>';
    if (ed && ui.pick && fresh.length) {
      h += '<div style="border:1px dashed var(--primary,#4caf50);border-radius:10px;padding:8px 10px;margin-bottom:10px;">' +
        '<div style="' + S.muted + 'margin-bottom:6px;">' + tt('בחר את הסעיפים שייכנסו ליומן. הכמות והמחיר נלקחים מהצעת המחיר כ"תוכנית".',
          'เลือกรายการ', 'اختر البنود') + '</div>' +
        fresh.map(function (l) {
          return '<label style="display:flex;gap:8px;align-items:center;padding:4px 0;font-size:.82rem;"><input type="checkbox" class="mjPick" value="' + esc(l.ref) + '" checked>' +
            '<span style="flex:1;">' + (l.kind === 'labor' ? '\ud83d\udc77 ' : '\ud83d\udce6 ') + esc(l.name) + '</span>' +
            '<span style="' + S.muted + 'white-space:nowrap;">' + num(l.qty) + ' ' + esc(l.unit) + ' \u00b7 ' + money(l.client) + '</span></label>';
        }).join('') +
        '<div style="display:flex;gap:6px;margin-top:6px;"><button style="' + S.pri + '" onclick="MaintJournal._import(' + pid + ')">\ud83d\udce5 ' + tt('הכנס ליומן', 'นำเข้า', 'أدخل') + '</button>' +
        '<button style="' + S.btn + '" onclick="MaintJournal._pick(' + pid + ')">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
    }
    if (!doc.items.length) {
      h += '<div style="text-align:center;padding:14px;' + S.muted + '">' + (src.lines.length
        ? tt('עוד לא הוכנסו סעיפים. הכנס סעיפים מהצעת המחיר כדי לעקוב אחרי תוכנית מול ביצוע.', 'ยังไม่มีรายการ', 'لا توجد بنود بعد')
        : tt('אין סעיפים בהצעת המחיר. אפשר להוסיף סעיף ידני.', 'ไม่มีรายการ', 'لا بنود في العرض')) + '</div>';
    }
    var srcByRef = {}; src.lines.forEach(function (l) { srcByRef[l.ref] = l; });
    doc.items.forEach(function (it, ix) {
      var ed = ui.canEdit && canRec(it);   // shadows the tab-level flag: this item's own
      var d = doneQty(doc, it), st = itemStatus(doc, it), pct = itemPct(doc, it);
      var ql = srcByRef[it.ref];
      var changed = ql && (Math.abs(ql.qty - it.planQty) > 0.001 || Math.abs(ql.client - it.planClient) > 0.5 || ql.name !== it.name);
      var gone = it.kind !== 'extra' && !ql;
      var bar = st === 'cancelled' ? '#9e9e9e' : pct >= 1 ? '#2e7d32' : pct > 0 ? '#ef6c00' : '#bdbdbd';
      var open = !!ui.open[it.ref];
      h += '<div style="border-top:1px solid var(--border,#eee);padding:9px 0;' + (st === 'cancelled' ? 'opacity:.55;' : '') + '">' +
        '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
          '<div style="flex:1 1 200px;min-width:160px;">' +
            '<div style="font-weight:600;font-size:.86rem;">' + (it.kind === 'labor' ? '\ud83d\udc77 ' : it.kind === 'extra' ? '\u2795 ' : '\ud83d\udce6 ') + esc(it.name) +
              (changed ? ' <span style="font-size:.68rem;background:#fff3e0;color:#8a4b00;border-radius:6px;padding:1px 6px;">' + tt('השתנה בהצעה', 'เปลี่ยนในใบเสนอ', 'تغيّر في العرض') + '</span>' : '') +
              (gone ? ' <span style="font-size:.68rem;background:#eceff1;border-radius:6px;padding:1px 6px;">' + tt('הוסר מההצעה', 'ลบจากใบเสนอ', 'حُذف من العرض') + '</span>' : '') + '</div>' +
            '<div style="' + S.muted + '">' + tt('תוכנית', 'แผน', 'المخطط') + ': ' + num(it.planQty) + ' ' + esc(it.unit) + ' \u00b7 ' + money(it.planClient) +
              (it.planCost ? ' \u00b7 ' + tt('עלות', 'ต้นทุน', 'التكلفة') + ' ' + money(it.planCost) : '') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">' +
            '<span style="' + S.muted + '">' + tt('בוצע', 'ทำแล้ว', 'المنجز') + '</span>' +
            (ed ? '<input type="number" step="any" min="0" style="' + S.in + 'width:76px;" value="' + num(d, 3) + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'done\',this.value)">'
                : '<b>' + num(d, 3) + '</b>') +
            '<span style="' + S.muted + '">' + esc(it.unit) + '</span>' +
            (ed ? '<select style="' + S.in + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'status\',this.value)">' +
                    STATUS.map(function (s) { return '<option value="' + s + '"' + (s === it.status ? ' selected' : '') + '>' + statusLabel(s) + (s === '' ? ' (' + statusLabel(st) + ')' : '') + '</option>'; }).join('') + '</select>'
                : '<span style="font-size:.76rem;">' + statusLabel(st) + '</span>') +
            '<button style="' + S.btn + 'padding:4px 8px;" onclick="MaintJournal._open(' + pid + ',' + ix + ')">' + (open ? '\u25b4' : '\u25be') + '</button>' +
          '</div>' +
        '</div>' +
        '<div style="height:6px;border-radius:4px;background:#eceff1;margin-top:6px;overflow:hidden;"><div style="height:100%;width:' + Math.round(pct * 100) + '%;background:' + bar + ';"></div></div>' +
        '<div style="' + S.muted + 'margin-top:2px;">' + Math.round(pct * 100) + '%' +
          (it.actualCost != null ? ' \u00b7 ' + tt('עלות בפועל', 'ต้นทุนจริง', 'التكلفة الفعلية') + ' ' + money(it.actualCost) +
            (it.planCost ? ' (<span style="color:' + (it.actualCost > it.planCost ? '#c62828' : '#2e7d32') + ';">' + (it.actualCost > it.planCost ? '+' : '') + money(it.actualCost - it.planCost) + '</span>)' : '') : '') +
          (it.note ? ' \u00b7 \ud83d\udcdd ' + esc(it.note) : '') + '</div>' +
        (open
          ? '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px;padding:8px;border-radius:8px;background:var(--surface-glass,#f5f7f5);">' +
              (ed ? '<label style="' + S.muted + '">' + tt('עלות בפועל', 'ต้นทุนจริง', 'التكلفة الفعلية') + ' \u20aa <input type="number" step="any" min="0" style="' + S.in + 'width:96px;" value="' + (it.actualCost != null ? it.actualCost : '') +
                      '" placeholder="' + num(it.planCost, 0) + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'actualCost\',this.value)"></label>' +
                    '<input style="' + S.in + 'flex:1 1 180px;" value="' + esc(it.note) + '" placeholder="' + esc(tt('הערה לסעיף', 'หมายเหตุ', 'ملاحظة')) +
                      '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'note\',this.value)">' +
                    (it.kind === 'extra'
                      ? '<input style="' + S.in + 'width:150px;" value="' + esc(it.name) + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'name\',this.value)">' +
                        '<label style="' + S.muted + '">' + tt('תוכנית', 'แผน', 'المخطط') + ' <input type="number" step="any" min="0" style="' + S.in + 'width:70px;" value="' + it.planQty + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'planQty\',this.value)"></label>' +
                        '<input style="' + S.in + 'width:60px;" value="' + esc(it.unit) + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'unit\',this.value)">' +
                        '<label style="' + S.muted + '">\u20aa <input type="number" step="any" min="0" style="' + S.in + 'width:90px;" value="' + it.planClient + '" onchange="MaintJournal._set(' + pid + ',' + ix + ',\'planClient\',this.value)"></label>'
                      : '') +
                    (changed ? '<button style="' + S.btn + '" onclick="MaintJournal._resync(' + pid + ',' + ix + ')">\u21bb ' + tt('עדכן לפי ההצעה', 'อัปเดตจากใบเสนอ', 'حدّث حسب العرض') + '</button>' : '') +
                    '<button style="' + S.btn + 'color:#c62828;border-color:#ef9a9a;" onclick="MaintJournal._delItem(' + pid + ',' + ix + ')">\ud83d\uddd1</button>'
                  : '<span style="' + S.muted + '">' + (it.by ? tt('עודכן ע״י', 'อัปเดตโดย', 'حدّثه') + ' ' + esc(it.by) : '') + '</span>') +
            '</div>'
          : '') +
      '</div>';
    });
    h += '</div>';

    // ── quick entry
    if (ed) {
      var k = ui.kind || 'work';
      var needsAmt = k === 'in', needsQty = k === 'work' || k === 'equip_on' || k === 'equip_off';
      h += '<div style="' + S.card + '"><div style="' + S.head + '">\u270d\ufe0f ' + tt('רישום ביומן', 'บันทึก', 'تسجيل') + '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">' +
          '<select id="mjKind" style="' + S.in + '" onchange="MaintJournal._kind(' + pid + ',this.value)">' +
            KINDS.map(function (x) { return '<option value="' + x + '"' + (x === k ? ' selected' : '') + '>' + kindLabel(x) + '</option>'; }).join('') + '</select>' +
          '<input id="mjDate" type="date" style="' + S.in + '" value="' + today() + '">' +
          (k === 'work' && doc.items.length
            ? '<select id="mjRef" style="' + S.in + 'max-width:210px;"><option value="">' + tt('— סעיף (לא חובה) —', '— รายการ —', '— بند —') + '</option>' +
                doc.items.map(function (it) { return itemStatus(doc, it) === 'cancelled' ? '' : '<option value="' + esc(it.ref) + '">' + esc(it.name) + ' (' + esc(it.unit) + ')</option>'; }).join('') + '</select>'
            : '') +
          (needsQty ? '<input id="mjQty" type="number" step="any" min="0" style="' + S.in + 'width:80px;" placeholder="' + esc(k === 'work' ? tt('כמות', 'จำนวน', 'الكمية') : tt('יח׳', 'หน่วย', 'وحدات')) + '"' + (k === 'work' ? '' : ' value="1"') + '>' : '') +
          (needsAmt ? '<input id="mjAmt" type="number" step="any" min="0" style="' + S.in + 'width:110px;" placeholder="\u20aa ' + esc(tt('סכום לפני מע"מ', 'จำนวนเงิน', 'المبلغ')) + '">' : '') +
          '<input id="mjText" style="' + S.in + 'flex:1 1 200px;" placeholder="' + esc(
            k === 'work' ? tt('מה בוצע היום', 'ทำอะไรวันนี้', 'ما الذي أُنجز اليوم') :
            k === 'in' ? tt('אמצעי תשלום / אסמכתא', 'วิธีชำระ', 'طريقة الدفع') :
            k === 'note' ? tt('הערה', 'หมายเหตุ', 'ملاحظة') : tt('שם הציוד (למשל: מערבל, מיני-מחפרון)', 'ชื่ออุปกรณ์', 'اسم المعدة')) + '">' +
          '<button style="' + S.pri + '" onclick="MaintJournal._add(' + pid + ')">\u2795 ' + tt('הוסף', 'เพิ่ม', 'أضف') + '</button>' +
        '</div>' +
        (k === 'work' ? '<div style="' + S.muted + 'margin-top:4px;">' + tt('כמות שנרשמת מול סעיף מתווספת אוטומטית ל"בוצע" שלו.', 'ปริมาณจะถูกเพิ่มในรายการ', 'تضاف الكمية إلى البند') + '</div>' : '') +
      '</div>';
    }

    // ── equipment on site
    var eq = onSite(doc);
    if (eq.length) h += '<div style="' + S.card + '"><div style="' + S.head + '">\ud83d\ude9c ' + tt('ציוד שנמצא עכשיו בשטח', 'อุปกรณ์ในไซต์', 'المعدات في الموقع') + '</div>' +
      eq.map(function (x) { return '<span style="display:inline-block;margin:2px 6px 2px 0;padding:3px 9px;border-radius:12px;background:#e3f2fd;font-size:.8rem;">' + esc(x.name) + (x.qty > 1 ? ' \u00d7' + x.qty : '') + '</span>'; }).join('') + '</div>';

    // ── timeline: journal entries + invoices + shipments
    var rows = [];
    doc.entries.forEach(function (e) { rows.push({ date: e.date, t: 'j', e: e }); });
    (src.invoices || []).forEach(function (x) { rows.push({ date: x.date, t: 'inv', e: x }); });
    (src.shipments || []).forEach(function (x) { rows.push({ date: x.date, t: 'ship', e: x }); });
    rows.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var itemName = {}; doc.items.forEach(function (it) { itemName[it.ref] = it.name + ' '; });
    h += '<div style="' + S.card + '"><div style="' + S.head + '">\ud83d\uddd3 ' + tt('ציר זמן', 'ไทม์ไลน์', 'الخط الزمني') +
      ' <span style="' + S.muted + 'font-weight:400;">' + tt('כולל חשבוניות ומשלוחים של הפרויקט', 'รวมใบแจ้งหนี้และการจัดส่ง', 'يشمل الفواتير والشحنات') + '</span></div>';
    if (!rows.length) h += '<div style="text-align:center;padding:12px;' + S.muted + '">' + tt('אין רישומים עדיין', 'ยังไม่มีบันทึก', 'لا سجلات بعد') + '</div>';
    var last = '';
    rows.slice(0, ui.all ? rows.length : 60).forEach(function (r) {
      if (r.date !== last) { h += '<div style="' + S.muted + 'font-weight:700;margin:8px 0 2px;">' + fmtDate(r.date) + '</div>'; last = r.date; }
      var line, del = '';
      if (r.t === 'j') {
        var e = r.e;
        line = kindLabel(e.kind) + (e.text ? ' \u00b7 ' + esc(e.text) : '') +
          (e.kind === 'work' && e.ref && itemName[e.ref] ? ' \u00b7 <b>' + esc(itemName[e.ref]) + '</b>' : '') +
          (e.qty && e.kind !== 'note' ? ' \u00b7 ' + num(e.qty, 3) : '') +
          (e.amount ? ' \u00b7 <b>' + money(e.amount) + '</b>' : '') +
          (e.by ? ' <span style="' + S.muted + '">\u00b7 ' + esc(e.by) + '</span>' : '');
        if (ed && canRec(e)) del = '<button style="border:none;background:none;cursor:pointer;color:#c62828;" title="' + esc(tt('מחק', 'ลบ', 'حذف')) + '" onclick="MaintJournal._del(' + pid + ',\'' + e.id + '\')">\ud83d\uddd1</button>';
      } else if (r.t === 'inv') {
        line = '\ud83e\uddfe ' + tt('חשבונית', 'ใบแจ้งหนี้', 'فاتورة') + ' \u00b7 ' + esc(r.e.supplier || '') + (r.e.number ? ' #' + esc(r.e.number) : '') +
          ' \u00b7 <b>' + money(r.e.amount + r.e.vat) + '</b> <span style="' + S.muted + '">(' + esc(r.e.status) + ')</span>';
      } else {
        line = '\ud83d\udce6 ' + tt('משלוח', 'จัดส่ง', 'شحنة') + ' \u00b7 ' + esc(r.e.material) + ' \u00b7 ' + num(r.e.qty) + (r.e.supplier ? ' \u00b7 ' + esc(r.e.supplier) : '');
      }
      h += '<div style="display:flex;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border,#f0f0f0);font-size:.82rem;"><span style="flex:1;">' + line + '</span>' + del + '</div>';
    });
    if (!ui.all && rows.length > 60) h += '<button style="' + S.btn + 'width:100%;margin-top:6px;" onclick="MaintJournal._all(' + pid + ')">' + tt('הצג הכל', 'แสดงทั้งหมด', 'عرض الكل') + ' (' + rows.length + ')</button>';
    h += '</div>';
    root.innerHTML = h;
  }

  // ── the old construction journal ────────────────────────────────────
  function oldLedger(buildId) {
    var key = OLD_PREFIX + buildId;
    var get = (typeof DB !== 'undefined' && DB.loadFresh) ? DB.loadFresh(key) : (typeof DB !== 'undefined' ? DB.loadAsync(key) : Promise.resolve(null));
    return get.then(function (d) { return d || null; }, function () { return null; });
  }
  function checkOld(pid) {
    var src = SRC[pid], doc = J[pid];
    if (!src || !src.buildProjectId || !doc || doc.migratedFrom || !UI[pid].canEdit) return;
    // remembered in the ui state, so every later repaint still shows it
    oldLedger(src.buildProjectId).then(function (d) {
      var count = (d && !d.migratedTo && Array.isArray(d.entries)) ? d.entries.length : 0;
      if ((UI[pid].old && UI[pid].old.count) === count) return;
      UI[pid].old = { count: count };
      render(pid);
    });
  }
  // Received → client receipt, work → work, equipment → movement, a payment
  // → a payment entry (counted with the invoices). The old journal is kept
  // and marked, never deleted.
  function migrate(pid) {
    var src = SRC[pid], doc = J[pid];
    if (!src || !src.buildProjectId || !doc || FAIL[pid]) return Promise.resolve(0);
    return oldLedger(src.buildProjectId).then(function (d) {
      if (!d || d.migratedTo || !Array.isArray(d.entries)) return 0;
      var n = 0;
      d.entries.forEach(function (e) {
        var base = { date: e.date, by: tt('הועבר מיומן הבנייה', 'ย้ายจากบันทึกก่อสร้าง', 'نُقل من سجل البناء'), at: new Date().toISOString() };
        var text = [e.title, e.note].filter(Boolean).join(' \u2014 ');
        if (e.kind === 'in') doc.entries.push(normEntry(Object.assign(base, { kind: 'in', amount: e.amount, text: text })));
        else if (e.kind === 'out') doc.entries.push(normEntry(Object.assign(base, { kind: 'out', amount: e.amount, text: [e.payee, text].filter(Boolean).join(' \u00b7 '), cat: e.cat })));
        else if (e.kind === 'equip') doc.entries.push(normEntry(Object.assign(base, { kind: e.dir === 'off' ? 'equip_off' : 'equip_on', text: e.equip || text, qty: e.qty || 1 })));
        else doc.entries.push(normEntry(Object.assign(base, { kind: 'work', text: text })));
        n++;
      });
      doc.migratedFrom = String(src.buildProjectId);
      if (!save(pid)) return 0;
      var marked = JSON.parse(JSON.stringify(d));
      marked.migratedTo = pid; marked.migratedAt = Date.now();
      if (typeof DB !== 'undefined') DB.save(OLD_PREFIX + src.buildProjectId, marked);
      audit('migrate', pid, { from: src.buildProjectId, entries: n });
      return n;
    });
  }

  // ── for the construction module: a read-only summary of the linked job ─
  function summary(pid) {
    return Promise.all([load(pid), source(pid)]).then(function (r) {
      var doc = r[0], src = r[1];
      if (!src) return null;
      var f = figures(doc, src), cs = contractState(doc, src, f);
      return { dueNow: cs.dueNow, hasTerms: cs.list.length > 0, status: src.status, name: src.name, open: (window.Maintenance && Maintenance.JOURNAL_STATUSES || []).indexOf(src.status) >= 0,
               contract: f.contract, received: f.received, due: f.due, paid: f.paid, pct: f.pct, items: f.items, done: f.done,
               entries: doc.entries.length, last: doc.entries.reduce(function (a, e) { return e.date > a ? e.date : a; }, '') };
    });
  }

  // ── actions ─────────────────────────────────────────────────────────
  function guard(pid) { return UI[pid] && UI[pid].canEdit && J[pid] && !FAIL[pid]; }
  function done(pid, what) { if (save(pid)) { audit('edit', pid, { what: what }); render(pid); } }
  return {
    tab: tab, summary: summary, oldLedger: oldLedger,
    _retry: function (pid) { delete J[pid]; refresh(pid); },
    _pick: function (pid) { UI[pid].pick = !UI[pid].pick; render(pid); },
    _import: function (pid) {
      if (!guard(pid)) return;
      var refs = Array.prototype.slice.call(document.querySelectorAll('.mjPick')).filter(function (c) { return c.checked; }).map(function (c) { return c.value; });
      var src = SRC[pid], doc = J[pid], have = {};
      doc.items.forEach(function (it) { have[it.ref] = 1; });
      var n = 0;
      src.lines.forEach(function (l) {
        if (refs.indexOf(l.ref) < 0 || have[l.ref]) return;
        doc.items.push(normItem(stampIt({ ref: l.ref, kind: l.kind, name: l.name, unit: l.unit, planQty: l.qty, planClient: l.client, planCost: l.cost, by: who(), at: new Date().toISOString() })));
        n++;
      });
      UI[pid].pick = false;
      done(pid, 'import ' + n);
      toast('\u2705 ' + n + ' ' + tt('סעיפים נכנסו ליומן', 'รายการถูกนำเข้า', 'بنود أُدخلت'));
    },
    _addExtra: function (pid) {
      if (!guard(pid)) return;
      var it = normItem(stampIt({ kind: 'extra', name: tt('סעיף נוסף', 'รายการเพิ่ม', 'بند إضافي'), unit: "\u05d9\u05d7'", planQty: 1, by: who(), at: new Date().toISOString() }));
      J[pid].items.push(it);
      UI[pid].open[it.ref] = true;
      done(pid, 'extra');
    },
    _open: function (pid, ix) { var it = J[pid] && J[pid].items[ix]; if (!it) return; UI[pid].open[it.ref] = !UI[pid].open[it.ref]; render(pid); },
    _set: function (pid, ix, field, v) {
      if (!guard(pid)) return;
      var doc = J[pid], it = doc.items[ix]; if (!it) return;
      if (!canRec(it)) return deny();
      if (field === 'done') {
        // what you type is the total done: the manual part is whatever the
        // logged work does not already account for
        var logged = doneQty(doc, Object.assign({}, it, { adj: 0 }));
        it.adj = num(Math.max(0, Number(v) || 0) - logged, 3);
      }
      else if (field === 'actualCost') it.actualCost = (v === '' || !isFinite(Number(v))) ? null : Math.max(0, Number(v));
      else if (field === 'status') it.status = STATUS.indexOf(v) >= 0 ? v : '';
      else if (field === 'planQty' || field === 'planClient') it[field] = Math.max(0, Number(v) || 0);
      else if (field === 'name' && String(v).trim()) it.name = String(v).trim().slice(0, 200);
      else if (field === 'unit') it.unit = String(v || '').slice(0, 20);
      else if (field === 'note') it.note = String(v || '').slice(0, 400);
      it.by = who(); it.at = new Date().toISOString();
      done(pid, field);
    },
    _resync: function (pid, ix) {
      if (!guard(pid)) return;
      var it = J[pid].items[ix], l = it && (SRC[pid].lines || []).filter(function (x) { return x.ref === it.ref; })[0];
      if (!it || !l) return;
      if (!canRec(it)) return deny();
      it.name = l.name; it.unit = l.unit; it.planQty = l.qty; it.planClient = l.client; it.planCost = l.cost;
      done(pid, 'resync');
    },
    _delItem: function (pid, ix) {
      if (!guard(pid)) return;
      var it = J[pid].items[ix]; if (!it) return;
      if (!canRec(it)) return deny();
      if (!window.confirm(tt('להסיר את הסעיף מהיומן? הרישומים שבוצעו מולו יישארו בציר הזמן.', 'ลบรายการนี้?', 'إزالة البند؟'))) return;
      J[pid].items.splice(ix, 1);
      done(pid, 'remove item');
    },
    _kind: function (pid, k) { UI[pid].kind = KINDS.indexOf(k) >= 0 ? k : 'work'; render(pid); },
    _add: function (pid) {
      if (!guard(pid)) return;
      var g = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
      var k = UI[pid].kind || 'work';
      var e = normEntry({ id: uid(), date: g('mjDate'), kind: k, text: String(g('mjText')).trim(), qty: g('mjQty'), amount: g('mjAmt'),
                          ref: k === 'work' ? g('mjRef') : '', by: who(), at: new Date().toISOString() });
      stampIt(e);
      if (k === 'in' && !(e.amount > 0)) { toast('\u26a0\ufe0f ' + tt('חסר סכום', 'ไม่มีจำนวนเงิน', 'المبلغ مفقود')); return; }
      if ((k === 'equip_on' || k === 'equip_off') && !e.text) { toast('\u26a0\ufe0f ' + tt('חסר שם הציוד', 'ไม่มีชื่ออุปกรณ์', 'اسم المعدة مفقود')); return; }
      if (k === 'work' && !e.text && !e.ref) { toast('\u26a0\ufe0f ' + tt('תאר מה בוצע או בחר סעיף', 'กรอกรายละเอียด', 'صف العمل أو اختر بنداً')); return; }
      if (k === 'note' && !e.text) return;
      J[pid].entries.push(e);
      done(pid, 'entry ' + k);
    },
    _del: function (pid, id) {
      if (!guard(pid)) return;
      var ent = J[pid].entries.filter(function (e) { return e.id === id; })[0];
      if (ent && !canRec(ent)) return deny();
      if (!window.confirm(tt('למחוק את הרישום?', 'ลบ?', 'حذف السجل؟'))) return;
      J[pid].entries = J[pid].entries.filter(function (e) { return e.id !== id; });
      done(pid, 'delete entry');
    },
    _all: function (pid) { UI[pid].all = true; render(pid); },
    _term: function (pid, k, v) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      var T = J[pid].terms;
      if (k === 'retention') T.retention = Math.max(0, Math.min(20, Number(v) || 0));
      else if (k === 'start' || k === 'end') T[k] = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '';
      done(pid, 'terms ' + k);
    },
    _msTemplate: function (pid) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      J[pid].terms.milestones = [
        normMilestone({ name: tt('מקדמה', 'เงินล่วงหน้า', 'دفعة مقدمة'), pct: 20, trigger: 'sign' }),
        normMilestone({ name: tt('התקדמות 40%', 'ความคืบหน้า 40%', 'تقدم 40%'), pct: 30, trigger: 'progress', progress: 40 }),
        normMilestone({ name: tt('סיום עבודות', 'งานเสร็จ', 'إنهاء الأعمال'), pct: 40, trigger: 'progress', progress: 100 }),
        normMilestone({ name: tt('מסירה', 'ส่งมอบ', 'التسليم'), pct: 10, trigger: 'completed' })
      ];
      done(pid, 'milestones template');
    },
    _msAdd: function (pid) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      var used = J[pid].terms.milestones.reduce(function (a, m) { return a + m.pct; }, 0);
      var m = normMilestone({ name: '', pct: Math.max(0, 100 - used), trigger: 'progress', progress: 100 });
      J[pid].terms.milestones.push(m);
      UI[pid].open['ms:' + m.id] = true;
      done(pid, 'milestone add');
    },
    _msOpen: function (pid, i) { var m = J[pid] && J[pid].terms.milestones[i]; if (!m) return; UI[pid].open['ms:' + m.id] = !UI[pid].open['ms:' + m.id]; render(pid); },
    _ms: function (pid, i, k, v) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      var m = J[pid].terms.milestones[i]; if (!m) return;
      if (k === 'name') m.name = String(v || '').slice(0, 120);
      else if (k === 'pct') m.pct = Math.max(0, Math.min(100, Number(v) || 0));
      else if (k === 'progress') m.progress = Math.max(0, Math.min(100, Number(v) || 0));
      else if (k === 'trigger') m.trigger = TRIGGERS.indexOf(v) >= 0 ? v : 'progress';
      else if (k === 'date') m.date = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : '';
      done(pid, 'milestone ' + k);
    },
    _msRef: function (pid, i, el) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      var m = J[pid].terms.milestones[i]; if (!m) return;
      var r = el.getAttribute('data-ref');
      m.refs = m.refs.filter(function (x) { return x !== r; });
      if (el.checked) m.refs.push(r);
      done(pid, 'milestone items');
    },
    _msDel: function (pid, i) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      if (!window.confirm(tt('למחוק את אבן הדרך?', 'ลบงวดนี้?', 'حذف المرحلة؟'))) return;
      J[pid].terms.milestones.splice(i, 1);
      done(pid, 'milestone delete');
    },
    _migrate: function (pid) {
      if (!guard(pid)) return;
      if (!UI[pid].ownP) return deny();
      migrate(pid).then(function (n) {
        UI[pid].old = { count: 0 };
        if (n) toast('\u2705 ' + n + ' ' + tt('רישומים הועברו מיומן הבנייה', 'รายการถูกย้าย', 'سجلات نُقلت'));
        render(pid);
      });
    },
    // for tests
    _figures: figures, _contract: contractState, _doneQty: doneQty, _status: itemStatus, _norm: normDoc, _state: function () { var o = {}; o.J = J; o.SRC = SRC; o.UI = UI; return o; }
  };
})();
