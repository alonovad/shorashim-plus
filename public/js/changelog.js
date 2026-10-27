/* changelog.js — "לוג שינויים אחרונים" (admin only, Oct 2026)
 *
 * Every write a signed-in person makes to the shared data is recorded on
 * the server (functions: clAppData / clTimeclock / … → changeLog/{id}),
 * field by field, with the old and the new value. This screen lists those
 * entries, newest first, with who made them; admin can put any single
 * change — or a whole entry — back with a click (changeUndo). The server
 * refuses an undo when the field has changed again since, unless admin
 * confirms overwriting it.
 *
 * Public: ChangeLog.open()
 */
var ChangeLog = (function () {
  'use strict';

  var PAGE = 60;
  var st = { items: [], last: null, done: false, loading: false, users: null, fUser: '', fArea: '', q: '', open: {} };

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
  function isAdmin() { return !!(window.currentUser && window.currentUser.role === 'admin'); }

  // ── naming ──
  function areaOf(col, doc) {
    var C = {
      'timeclock': tt('שעון נוכחות', 'นาฬิกาเข้างาน', 'ساعة الدوام'),
      'leave-requests': tt('בקשות חופשה', 'คำขอลา', 'طلبات الإجازة'),
      'comments': tt('תגובות', 'ความคิดเห็น', 'تعليقات'),
      'holidays': tt('חגים', 'วันหยุด', 'أعياد'),
      'attendance-events': tt('אירועי נוכחות', 'เหตุการณ์เข้างาน', 'أحداث الحضور')
    };
    if (col !== 'appData') return C[col] || col;
    var D = [
      ['plotMapperSprayData', tt('חלקות, משקים וריסוסים', 'แปลง ฟาร์ม และการพ่น', 'قطع، مزارع ورش')],
      ['shorashim-users', tt('משתמשים', 'ผู้ใช้', 'المستخدمون')],
      ['shorashim-agri-plan-', tt('תוכנית טיפולים', 'แผนการดูแล', 'خطة العلاج')],
      ['shorashim-agri-approvals-', tt('אישורי טיפולים', 'การอนุมัติ', 'موافقات')],
      ['shorashim-traps-', tt('מלכודות', 'กับดัก', 'مصائد')],
      ['shorashim-pest-monitor-', tt('ניטור מזיקים', 'ติดตามศัตรูพืช', 'رصد الآفات')],
      ['shorashim-harvest-', tt('קטיף ומיון', 'เก็บเกี่ยวและคัดแยก', 'القطف والفرز')],
      ['shorashim-shipments-', tt('משלוחים', 'การจัดส่ง', 'الشحنات')],
      ['shorashim-prices', tt('מחירים', 'ราคา', 'الأسعار')],
      ['shorashim-cashflow-', tt('תזרים מזומנים', 'กระแสเงินสด', 'التدفق النقدي')],
      ['shorashim-maint', tt('תחזוקה', 'ซ่อมบำรุง', 'الصيانة')],
      ['shorashim-tasks', tt('משימות', 'งาน', 'المهام')],
      ['shorashim-workers', tt('עובדים', 'คนงาน', 'العمال')],
      ['shorashim-workplaces', tt('מקומות עבודה', 'สถานที่ทำงาน', 'أماكن العمل')],
      ['shorashim-payroll', tt('שכר', 'เงินเดือน', 'الرواتب')],
      ['shorashim-build-', tt('בנייה', 'ก่อสร้าง', 'البناء')],
      ['shorashim-knowledge', tt('ספריית ידע', 'คลังความรู้', 'مكتبة المعرفة')],
      ['shorashim-field-reports', tt('דוחות שטח', 'รายงานภาคสนาม', 'تقارير ميدانية')],
      ['shorashim-plotrec', tt('השקיה ודישון לחלקה', 'การให้น้ำ/ปุ๋ย', 'الري والتسميد')],
      ['shorashim-plot-register', tt('רישום חלקות', 'ทะเบียนแปลง', 'سجل القطع')],
      ['shorashim-receipts', tt('קבלות', 'ใบเสร็จ', 'إيصالات')],
      ['shorashim-orders', tt('הזמנות', 'คำสั่งซื้อ', 'الطلبات')],
      ['shorashim-suppliers', tt('ספקים', 'ผู้จัดหา', 'الموردون')],
      ['shorashim-crop-types', tt('סוגי גידולים', 'ประเภทพืช', 'أنواع المحاصيل')]
    ];
    for (var i = 0; i < D.length; i++) if (doc === D[i][0] || doc.indexOf(D[i][0]) === 0) return D[i][1];
    return doc;
  }
  function who(e) {
    var em = String(e.email || '').toLowerCase(), u = st.users || {};
    for (var k in u) if (u[k] && String(u[k].email || '').toLowerCase() === em && em) return u[k].name || u[k].username || em;
    return em || tt('לא ידוע', 'ไม่ทราบ', 'غير معروف');
  }
  // field keys as people call them; unknown keys stay as stored
  var KEYS = null;
  function keyName(k) {
    if (!KEYS) KEYS = {
      plots: tt('חלקות', 'แปลง', 'القطع'), farms: tt('משקים', 'ฟาร์ม', 'المزارع'), sprays: tt('ריסוסים', 'การพ่น', 'الرش'),
      worklog: tt('יומן עבודה', 'บันทึกงาน', 'سجل العمل'), name: tt('שם', 'ชื่อ', 'الاسم'), area: tt('שטח', 'พื้นที่', 'المساحة'),
      trees: tt('עצים', 'ต้นไม้', 'الأشجار'), crop_type: tt('גידול', 'พืช', 'المحصول'), variety: tt('זן', 'สายพันธุ์', 'الصنف'),
      farm_id: tt('משק', 'ฟาร์ม', 'المزرعة'), role: tt('תפקיד', 'บทบาท', 'الدور'), email: tt('אימייל', 'อีเมล', 'البريد'),
      farm_permissions: tt('גישה למשקים', 'สิทธิ์ฟาร์ม', 'صلاحيات المزارع'), phone: tt('טלפון', 'โทรศัพท์', 'الهاتف'),
      notes: tt('הערות', 'หมายเหตุ', 'ملاحظات'), date: tt('תאריך', 'วันที่', 'التاريخ'), dose: tt('מינון', 'อัตรา', 'الجرعة'),
      material: tt('חומר', 'สาร', 'المادة'), materials: tt('חומרים', 'สาร', 'المواد'), status: tt('סטטוס', 'สถานะ', 'الحالة'),
      vehicles: tt('כלים', 'ยานพาหนะ', 'المركبات'), color: tt('צבע', 'สี', 'اللون'), layer: tt('גבולות', 'ขอบเขต', 'الحدود'),
      coords: tt('גבולות', 'ขอบเขต', 'الحدود'), branch: tt('ענף', 'สาขา', 'الفرع'), planted: tt('שנת נטיעה', 'ปีที่ปลูก', 'سنة الزراعة')
    };
    return KEYS[k] || k;
  }
  function lbl(c) {
    var s = String(c.label || '').replace(/^value( › )?/, '');
    if (!s) return tt('המסמך כולו', 'ทั้งเอกสาร', 'المستند كله');
    return s.split(' › ').map(keyName).join(' › ');
  }
  function short(j) {
    if (j == null) return '∅';
    var v; try { v = JSON.parse(j); } catch (e) { return String(j).slice(0, 50); }
    if (v == null) return '∅';
    if (Array.isArray(v)) return '[' + v.length + ' ' + tt('פריטים', 'รายการ', 'عناصر') + ']';
    if (typeof v === 'object') {
      var n = v.name || v.title || v.label || v.material;
      return n ? '«' + String(n).slice(0, 40) + '»' : '{' + Object.keys(v).length + ' ' + tt('שדות', 'ฟิลด์', 'حقول') + '}';
    }
    var s = String(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  }
  function opIco(op) { return op === 'add' ? '➕' : op === 'del' ? '🗑' : op === 'undo' ? '↩️' : '✏️'; }
  function when(ms) {
    var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + String(d.getFullYear()).slice(2) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // ── data ──
  function loadUsers() {
    if (st.users) return Promise.resolve();
    return firebase.firestore().collection('appData').doc('shorashim-users').get().then(function (s) {
      st.users = (s.exists && s.data().value) || {};
    }, function () { st.users = {}; });
  }
  function loadMore() {
    if (st.loading || st.done) return;
    st.loading = true; paint();
    var q = firebase.firestore().collection('changeLog').orderBy('at', 'desc').limit(PAGE);
    if (st.last) q = q.startAfter(st.last);
    q.get().then(function (s) {
      s.docs.forEach(function (d) { var x = d.data(); x.id = d.id; st.items.push(x); });
      st.last = s.docs.length ? s.docs[s.docs.length - 1] : st.last;
      st.done = s.docs.length < PAGE;
      st.loading = false; paint();
    }, function (e) { st.loading = false; st.err = (e && (e.code || e.message)) || ''; paint(); });
  }

  // ── undo ──
  function undo(id, idx, force) {
    var e = st.items.find(function (x) { return x.id === id; });
    if (!e) return;
    var msg = idx == null
      ? tt('לבטל את כל הפעולה (' + e.changes.length + ' שינויים) ולהחזיר את המצב שלפניה?', 'ยกเลิกทั้งหมด?', 'إلغاء العملية كلها؟')
      : tt('לבטל את השינוי ב"' + lbl(e.changes[idx]) + '" ולהחזיר ל־' + short(e.changes[idx].fromJ) + '?', 'ยกเลิกการเปลี่ยนแปลงนี้?', 'إلغاء هذا التغيير؟');
    if (!force && !confirm(msg)) return;
    var fn = firebase.app().functions('us-central1').httpsCallable('changeUndo', { timeout: 60000 });
    toast('⏳ ' + tt('מחזיר…', 'กำลังย้อนกลับ…', 'جارٍ الاسترجاع…'));
    fn({ id: id, idx: idx, force: !!force }).then(function (r) {
      var x = (r && r.data) || {}, done = x.done || [], failed = x.failed || [];
      if (done.length) {
        e.undone = e.undone || {};
        done.forEach(function (i) { e.undone[i] = { by: (window.currentUser && window.currentUser.email) || '', at: Date.now() }; });
        toast('✅ ' + tt('שוחזר', 'ย้อนกลับแล้ว', 'تم الاسترجاع') + (done.length > 1 ? ' (' + done.length + ')' : ''));
      }
      if (failed.length) {
        var changed = failed.filter(function (f) { return f.why === 'changed'; }).length;
        if (changed && !force && confirm(tt('הערך השתנה שוב מאז השינוי הזה (' + changed + '). לדרוס את המצב הנוכחי ולהחזיר בכל זאת?', 'ค่าเปลี่ยนไปแล้ว เขียนทับ?', 'تغيرت القيمة منذ ذلك. استبدال؟'))) return undo(id, idx, true);
        var other = failed.filter(function (f) { return f.why !== 'changed'; }).length;
        if (other) toast('⚠️ ' + tt('חלק מהשינויים לא ניתנים לשחזור (המידע כבר לא קיים או גדול מדי)', 'บางรายการย้อนกลับไม่ได้', 'بعض التغييرات لا يمكن استرجاعها'));
      }
      paint();
    }, function (er) { toast('❌ ' + ((er && (er.code || er.message)) || '')); });
  }

  // ── view ──
  function filtered() {
    var q = st.q.trim().toLowerCase();
    return st.items.filter(function (e) {
      if (st.fUser && String(e.email || '') !== st.fUser) return false;
      if (st.fArea && areaOf(e.col, e.doc) !== st.fArea) return false;
      if (q) {
        var hay = (who(e) + ' ' + areaOf(e.col, e.doc) + ' ' + (e.changes || []).map(function (c) { return lbl(c) + ' ' + short(c.fromJ) + ' ' + short(c.toJ); }).join(' ')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    });
  }
  function entryHtml(e) {
    var adm = isAdmin(), open = !!st.open[e.id], ch = e.changes || [], show = open ? ch : ch.slice(0, 4);
    var allUndone = ch.length && ch.every(function (c, i) { return (e.undone || {})[i]; });
    var h = '<div class="cl-e">' +
      '<div class="cl-h"><b>' + esc(who(e)) + '</b> · <span>' + esc(areaOf(e.col, e.doc)) + '</span>' +
      '<span class="cl-t">' + when(e.at) + '</span></div>';
    if (e.undoOf) h += '<div class="cl-note">↩️ ' + tt('שחזור של שינוי קודם', 'ย้อนกลับการเปลี่ยนแปลงก่อนหน้า', 'استرجاع تغيير سابق') + '</div>';
    h += show.map(function (c, k) {
      var i = open ? k : k, u = (e.undone || {})[i], can = adm && !e.undoOf && !u && !c.big && c.op !== 'undo';
      return '<div class="cl-c' + (u ? ' cl-u' : '') + (can ? ' cl-can' : '') + '"' + (can ? ' data-cl-undo="' + esc(e.id) + '" data-cl-i="' + i + '" title="' + esc(tt('לחיצה מבטלת את השינוי הזה', 'คลิกเพื่อยกเลิก', 'انقر للإلغاء')) + '"' : '') + '>' +
        '<span class="cl-op">' + opIco(c.op) + '</span><span class="cl-l">' + esc(lbl(c)) + '</span> ' +
        (c.op === 'add' ? '<span class="cl-v">' + esc(short(c.toJ)) + '</span>'
          : c.op === 'del' ? '<span class="cl-v cl-from">' + esc(short(c.fromJ)) + '</span>'
          : '<span class="cl-v cl-from">' + esc(short(c.fromJ)) + '</span> → <span class="cl-v">' + esc(short(c.toJ)) + '</span>') +
        (u ? ' <span class="cl-ub">' + tt('בוטל', 'ยกเลิกแล้ว', 'أُلغي') + '</span>' : '') +
        (c.big ? ' <span class="cl-ub">' + tt('גדול מדי לשחזור', 'ใหญ่เกินไป', 'كبير جدًا') + '</span>' : '') + '</div>';
    }).join('');
    if (ch.length > 4) h += '<button class="cl-more" data-cl-open="' + esc(e.id) + '">' + (open ? tt('הצג פחות', 'แสดงน้อยลง', 'عرض أقل') : tt('עוד', 'เพิ่ม', 'المزيد') + ' ' + (ch.length - 4) + ' ' + tt('שינויים', 'การเปลี่ยนแปลง', 'تغييرات')) + '</button>';
    if (e.partial) h += '<div class="cl-note">' + tt('פעולה גדולה: נרשמו ' + ch.length + ' מתוך ' + e.n + ' שינויים', 'บันทึกบางส่วน', 'تم تسجيل جزء') + '</div>';
    if (adm && !e.undoOf && ch.length > 1 && !allUndone) h += '<button class="cl-all" data-no-sticky data-cl-undo="' + esc(e.id) + '">↩️ ' + tt('בטל את כל הפעולה', 'ยกเลิกทั้งหมด', 'إلغاء العملية كلها') + '</button>';
    return h + '</div>';
  }
  function paint() {
    var box = document.getElementById('clBody');
    if (!box) return;
    var users = {}, areas = {};
    st.items.forEach(function (e) { if (e.email) users[e.email] = who(e); areas[areaOf(e.col, e.doc)] = 1; });
    var list = filtered();
    var gev = (st.guard || []).slice(0, 5);
    box.innerHTML =
      (gev.length ? '<div class="cl-e" style="border-color:#f0c36d;background:#fffaf0;"><div class="cl-h"><b>⚠️ ' + tt('הגנות השרת — אירועים אחרונים', 'การป้องกันเซิร์ฟเวอร์ — เหตุการณ์ล่าสุด', 'حمايات الخادم — أحداث أخيرة') + '</b></div>' +
        gev.map(function (g) {
          if (g.kind === 'open_shift') return '<div class="cl-c">' + when(g.at) + ' · <b>' + esc(g.name || g.username) + '</b> · 🕐 ' +
            tt('משמרת פתוחה מאז', 'กะเปิดตั้งแต่', 'وردية مفتوحة منذ') + ' ' + when(g.since) + ' (' + g.hours + ' ' + tt('שעות', 'ชม.', 'ساعات') + ')' + (g.workplace ? ' · ' + esc(g.workplace) : '') + '</div>';
          if (g.kind === 'reverted') return '<div class="cl-c">' + when(g.at) + ' · <b>' + esc(who({ email: g.email })) + '</b> · ↩️ ' +
            tt('שינוי לא מורשה הוחזר אוטומטית', 'การเปลี่ยนแปลงที่ไม่ได้รับอนุญาตถูกย้อนกลับ', 'أُعيد تغيير غير مصرح به') + ' (' + g.n + ') · ' + esc(areaOf('appData', g.doc || '')) +
            (g.labels && g.labels.length ? ' · <span class="cl-v">' + esc(g.labels.map(function (l) { return lbl({ label: l }); }).join(' | ')) + '</span>' : '') + '</div>';
          return '<div class="cl-c">' + when(g.at) + ' · <b>' + esc(who({ email: g.email })) + '</b> · ' + tt('הועבר לצופה', 'ถูกลดเป็นผู้ชม', 'نُقل للعرض') + ' · ' + esc(guardKind(g.kind)) + ' · ' +
            tt('10 דק׳', '10 นาที', '10 د') + ' ' + g.counts.m10 + ' / ' + tt('שעה', 'ชม.', 'ساعة') + ' ' + g.counts.h1 + ' / ' + tt('יום', 'วัน', 'يوم') + ' ' + g.counts.d1 +
            ' · ' + tt('היה', 'เดิม', 'كان') + ': ' + esc(g.prev_role) + '</div>';
        }).join('') +
        '<div class="cl-note">' + tt('להחזרת ההרשאה: משתמשים ← עריכה ← בחר שוב את התפקיד ושמור.', 'คืนสิทธิ์: ผู้ใช้ ← แก้ไข ← เลือกบทบาท', 'للاستعادة: المستخدمون ← تعديل ← اختر الدور') + '</div></div>' : '') +
      '<div class="cl-f">' +
        '<select class="form-input" id="clUser"><option value="">' + tt('כל המשתמשים', 'ผู้ใช้ทั้งหมด', 'كل المستخدمين') + '</option>' +
          Object.keys(users).map(function (k) { return '<option value="' + esc(k) + '"' + (st.fUser === k ? ' selected' : '') + '>' + esc(users[k]) + '</option>'; }).join('') + '</select>' +
        '<select class="form-input" id="clArea"><option value="">' + tt('כל האזורים', 'ทุกส่วน', 'كل الأقسام') + '</option>' +
          Object.keys(areas).sort().map(function (k) { return '<option' + (st.fArea === k ? ' selected' : '') + '>' + esc(k) + '</option>'; }).join('') + '</select>' +
        '<input class="form-input" id="clQ" placeholder="' + esc(tt('חיפוש…', 'ค้นหา…', 'بحث…')) + '" value="' + esc(st.q) + '">' +
      '</div>' +
      (isAdmin() ? '<div class="cl-hint">' + tt('לחיצה על שורה מבטלת את השינוי הזה ומחזירה את הערך הקודם.', 'คลิกแถวเพื่อยกเลิก', 'انقر على سطر لإلغاء التغيير') + '</div>' : '') +
      (st.err ? '<div class="cl-note">⚠️ ' + esc(st.err) + '</div>' : '') +
      (list.length ? list.map(entryHtml).join('') : (st.loading ? '' : '<div class="cl-note">' + tt('אין שינויים להצגה', 'ไม่มีการเปลี่ยนแปลง', 'لا تغييرات') + '</div>')) +
      (st.loading ? '<div class="cl-note">⏳ ' + tt('טוען…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>'
        : !st.done ? '<button class="cl-more cl-load" id="clMore">' + tt('טען שינויים ישנים יותר', 'โหลดเพิ่ม', 'تحميل الأقدم') + '</button>' : '');
  }
  function guardKind(k) {
    return k === 'ai' ? tt('קריאות AI', 'การอ่าน AI', 'قراءات AI') : k === 'write' ? tt('שמירות', 'การบันทึก', 'حفظ')
      : k === 'deny' ? tt('ניסיונות שינוי לא מורשים', 'การเปลี่ยนแปลงที่ไม่ได้รับอนุญาต', 'محاولات غير مصرح بها') : tt('קריאות לשרת', 'การเรียกเซิร์ฟเวอร์', 'استدعاءات الخادم');
  }
  // admin is told as soon as the server limits someone
  var guardStarted = false;
  function watchGuard() {
    if (guardStarted || !isAdmin() || !window.firebase || !firebase.firestore) return;
    guardStarted = true;
    firebase.firestore().collection('appData').doc('shorashim-load-guard').onSnapshot(function (s) {
      var ev = ((s.exists && s.data().value) || {}).events || [];
      st.guard = ev;
      var seen = 0; try { seen = Number(localStorage.getItem('shorashim-load-guard-seen')) || 0; } catch (e) {}
      var fresh = ev.filter(function (g) { return g.at > seen; });
      if (fresh.length) {
        loadUsers().then(function () {
          var dem = fresh.filter(function (g) { return g.kind !== 'reverted' && g.kind !== 'open_shift'; }), rev = fresh.filter(function (g) { return g.kind === 'reverted'; });
          var osh = fresh.filter(function (g) { return g.kind === 'open_shift'; });
          if (osh.length) toast('🕐 ' + tt('משמרת פתוחה יותר מ־16 שעות: ', 'กะเปิดนานเกิน 16 ชม.: ', 'وردية مفتوحة أكثر من 16 ساعة: ') + osh.map(function (g) { return g.name || g.username; }).join(', '));
          if (dem.length) toast('⚠️ ' + tt('הגנת עומס: ', 'ป้องกันโหลด: ', 'حماية الحمل: ') + dem.map(function (g) { return who({ email: g.email }); }).join(', ') + ' ' + tt('הועבר/ו לצפייה בלבד. פרטים בלוג השינויים.', 'ถูกลดเป็นดูอย่างเดียว', 'نُقل/وا للعرض فقط'));
          else if (rev.length) toast('↩️ ' + tt('שינוי לא מורשה הוחזר: ', 'ย้อนกลับการเปลี่ยนแปลง: ', 'أُعيد تغيير: ') + rev.map(function (g) { return who({ email: g.email }); }).join(', ') + ' · ' + tt('פרטים בלוג השינויים', 'ดูบันทึก', 'التفاصيل في السجل'));
        });
        try { localStorage.setItem('shorashim-load-guard-seen', String(fresh[0].at)); } catch (e) {}
      }
      paint();
    }, function () { guardStarted = false; });
  }
  (function poll() { if (window.currentUser) { if (!isAdmin()) return; watchGuard(); } if (!guardStarted) setTimeout(poll, 4000); })();

  function css() {
    if (document.getElementById('clCss')) return;
    var s = document.createElement('style'); s.id = 'clCss';
    s.textContent =
      '#clModal .modal{max-width:760px;width:96vw;max-height:88vh;display:flex;flex-direction:column;}' +
      '#clBody{overflow-y:auto;flex:1;padding-bottom:8px;}' +
      '.cl-f{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}.cl-f .form-input{flex:1;min-width:120px;width:auto !important;}' +
      '.cl-hint{font-size:.75rem;color:var(--text-muted);margin-bottom:8px;}' +
      '.cl-e{border:1px solid var(--g5,#e3e8e0);border-radius:12px;padding:8px 10px;margin-bottom:8px;background:var(--surface,#fff);}' +
      '.cl-h{font-size:.85rem;display:flex;gap:4px;align-items:baseline;flex-wrap:wrap;}.cl-t{margin-inline-start:auto;color:var(--text-muted);font-size:.75rem;direction:ltr;}' +
      '.cl-c{font-size:.8rem;padding:4px 6px;border-radius:8px;margin-top:3px;display:flex;gap:4px;flex-wrap:wrap;align-items:baseline;}' +
      '.cl-can{cursor:pointer;}.cl-can:hover{background:var(--tonal,#f2f6ef);}' +
      '.cl-op{flex:none;}.cl-l{font-weight:600;}.cl-v{background:#f4f6f3;border-radius:6px;padding:0 5px;word-break:break-word;}.cl-from{text-decoration:line-through;color:#8a6d6d;}' +
      '.cl-u{opacity:.55;}.cl-u .cl-l{text-decoration:line-through;}.cl-ub{font-size:.7rem;background:#fde9e7;color:#a33;border-radius:6px;padding:0 5px;}' +
      '.cl-note{font-size:.75rem;color:var(--text-muted);margin-top:4px;}' +
      '.cl-more,.cl-all{border:1px solid var(--g5,#d9e2d4);background:#fff;border-radius:10px;padding:3px 10px;font-family:inherit;font-size:.75rem;margin-top:5px;cursor:pointer;color:var(--g2,#1d5a2c);}' +
      '.cl-all{margin-inline-start:6px;}.cl-load{width:100%;padding:8px;}';
    document.head.appendChild(s);
  }

  function open() {
    if (!isAdmin()) { toast('🔒 ' + tt('למנהל המערכת בלבד', 'สำหรับผู้ดูแลเท่านั้น', 'للمسؤول فقط')); return; }
    css();
    st.items = []; st.last = null; st.done = false; st.err = ''; st.open = {};
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay" id="clModal"><div class="modal">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;"><h2 style="margin:0;">📜 ' + tt('לוג שינויים אחרונים', 'บันทึกการเปลี่ยนแปลงล่าสุด', 'سجل التغييرات الأخيرة') + '</h2>' +
      '<button class="btn btn-secondary" id="clClose" style="flex:none;width:auto;padding:6px 16px;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button></div>' +
      '<div style="font-size:.75rem;color:var(--text-muted);margin:4px 0 8px;">' + tt('כל שינוי שנשמר, קטן כגדול: מי, מתי, מה היה ומה נהיה. הרישום נעשה בשרת ונשמר שנה.', 'ทุกการเปลี่ยนแปลง: ใคร เมื่อไร อะไร', 'كل تغيير: من ومتى وماذا') + '</div>' +
      '<div id="clBody"></div></div></div>';
    var m = document.getElementById('clModal');
    m.addEventListener('click', function (ev) {
      if (ev.target === m || ev.target.id === 'clClose') { c.innerHTML = ''; return; }
      var t = ev.target.closest('[data-cl-undo],[data-cl-open],#clMore');
      if (!t) return;
      if (t.id === 'clMore') return loadMore();
      if (t.hasAttribute('data-cl-open')) { var id = t.getAttribute('data-cl-open'); st.open[id] = !st.open[id]; return paint(); }
      var i = t.getAttribute('data-cl-i');
      undo(t.getAttribute('data-cl-undo'), i == null ? null : Number(i));
    });
    m.addEventListener('change', function (ev) {
      if (ev.target.id === 'clUser') { st.fUser = ev.target.value; paint(); }
      if (ev.target.id === 'clArea') { st.fArea = ev.target.value; paint(); }
    });
    m.addEventListener('input', function (ev) {
      if (ev.target.id === 'clQ') { st.q = ev.target.value; var pos = ev.target.selectionStart; paint(); var q = document.getElementById('clQ'); if (q) { q.focus(); try { q.setSelectionRange(pos, pos); } catch (er) {} } }
    });
    loadUsers().then(loadMore);
  }

  return { open: open };
})();
window.ChangeLog = ChangeLog;
