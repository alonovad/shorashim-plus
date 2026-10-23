/* comments.js — comments on any item (Oct 2026)
 *
 * Whoever may only view an item (ownership.js) can still respond to it.
 * Each comment is its own Firestore document in the `comments` collection
 * { key, uid, email, name, text, at }, so the rules can enforce that people
 * edit and delete only their own comments (admin may delete any) — unlike
 * the shared appData documents, this is checked on the server.
 *
 * Use: put Comments.block('plot:123') anywhere in a screen's HTML. A watcher
 * mounts every [data-cmt] placeholder as it appears: the thread, live, and a
 * box to write. Keys: '<kind>:<id>' (plot, plan, guide, zone…).
 * Public: Comments.block(key, title?), Comments.count(key) → Promise<n>
 */
var Comments = (function () {
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
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function fs() {
    try { return (window.firebase && firebase.firestore && firebase.auth && firebase.auth().currentUser) ? firebase.firestore() : null; } catch (e) { return null; }
  }
  function uid() { try { return firebase.auth().currentUser.uid; } catch (e) { return ''; } }
  function locale() { var l = (typeof currentLang !== 'undefined') ? currentLang : 'he'; return l === 'th' ? 'th-TH' : l === 'ar' ? 'ar' : 'he-IL'; }
  function when(ms) {
    var d = new Date(ms), now = Date.now();
    if (now - ms < 60000) return tt('עכשיו', 'เมื่อสักครู่', 'الآن');
    if (now - ms < 86400000) return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  }
  function safeKey(k) { return String(k || '').replace(/[^A-Za-z0-9:_\-.]/g, '').slice(0, 100); }

  function block(key, title) {
    return '<div class="cmt" data-cmt="' + esc(safeKey(key)) + '"' + (title ? ' data-cmt-title="' + esc(title) + '"' : '') + '></div>';
  }

  var subs = {};   // element id → unsubscribe
  var seq = 0;
  function mount(el) {
    if (el.getAttribute('data-cmt-on')) return;
    var key = el.getAttribute('data-cmt');
    if (!key) return;
    el.setAttribute('data-cmt-on', '1');
    var id = 'cmt' + (++seq); el.id = el.id || id;
    var db = fs();
    var head = '<div class="cmt-h">💬 ' + tt('תגובות', 'ความคิดเห็น', 'التعليقات') + ' <span class="cmt-n"></span></div>';
    if (!db) { el.innerHTML = head + '<div class="cmt-mut">' + tt('התגובות זמינות כשמחוברים לשרת', 'ความคิดเห็นใช้ได้เมื่อออนไลน์', 'التعليقات متاحة عند الاتصال') + '</div>'; return; }
    el.innerHTML = head + '<div class="cmt-list"><div class="cmt-mut">⏳</div></div>' +
      '<div class="cmt-new"><textarea class="form-input cmt-in" rows="2" maxlength="2000" placeholder="' + esc(tt('כתוב תגובה…', 'เขียนความคิดเห็น…', 'اكتب تعليقًا…')) + '"></textarea>' +
      '<button type="button" class="cmt-send">' + tt('שלח', 'ส่ง', 'إرسال') + '</button></div>';
    var list = el.querySelector('.cmt-list'), cnt = el.querySelector('.cmt-n'), me = uid();
    var isAdmin = window.Own ? Own.isAdmin() : ((window.currentUser || {}).role === 'admin');
    var unsub = db.collection('comments').where('key', '==', key).onSnapshot(function (snap) {
      var rows = [];
      snap.forEach(function (d) { var x = d.data() || {}; x._id = d.id; rows.push(x); });
      rows.sort(function (a, b) { return (a.at || 0) - (b.at || 0); });
      cnt.textContent = rows.length ? '(' + rows.length + ')' : '';
      list.innerHTML = rows.length ? rows.map(function (c) {
        var mine = c.uid === me;
        return '<div class="cmt-c' + (mine ? ' mine' : '') + '"><div class="cmt-m"><b>' + esc(c.name || String(c.email || '').split('@')[0]) + '</b> · ' + when(c.at || 0) + (c.edited ? ' · ' + tt('נערך', 'แก้ไขแล้ว', 'معدّل') : '') +
          ((mine || isAdmin) ? ' <button type="button" class="cmt-x" data-del="' + esc(c._id) + '" aria-label="delete">✕</button>' : '') + '</div>' +
          '<div class="cmt-t">' + esc(c.text) + '</div></div>';
      }).join('') : '<div class="cmt-mut">' + tt('אין תגובות עדיין', 'ยังไม่มีความคิดเห็น', 'لا تعليقات بعد') + '</div>';
    }, function () { list.innerHTML = '<div class="cmt-mut">' + tt('אין גישה לתגובות', 'เข้าถึงไม่ได้', 'لا وصول') + '</div>'; });
    subs[el.id] = unsub;
    el.addEventListener('click', function (e) {
      var del = e.target.closest('[data-del]');
      if (del) {
        if (!confirm(tt('למחוק את התגובה?', 'ลบความคิดเห็น?', 'حذف التعليق؟'))) return;
        db.collection('comments').doc(del.getAttribute('data-del')).delete().catch(function () { toast('❌ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); });
        return;
      }
      if (!e.target.closest('.cmt-send')) return;
      var inp = el.querySelector('.cmt-in'), text = inp.value.trim();
      if (!text) return;
      var u = window.currentUser || {}, au = firebase.auth().currentUser;
      var btn = e.target; btn.disabled = true;
      db.collection('comments').add({ key: key, uid: au.uid, email: String(au.email || '').toLowerCase(), name: u.name || u.username || '', text: text.slice(0, 2000), at: Date.now(),
        title: String(el.getAttribute('data-cmt-title') || '').slice(0, 100) })
        .then(function () { inp.value = ''; btn.disabled = false; }, function (err) { btn.disabled = false; toast('❌ ' + tt('התגובה לא נשמרה', 'บันทึกไม่สำเร็จ', 'لم يُحفظ التعليق') + ': ' + ((err && err.code) || '')); });
    });
  }
  // Unsubscribe threads whose element left the page.
  function sweep() {
    Object.keys(subs).forEach(function (id) { if (!document.getElementById(id)) { try { subs[id](); } catch (e) {} delete subs[id]; } });
  }
  function scan(root) { (root || document).querySelectorAll('[data-cmt]:not([data-cmt-on])').forEach(mount); }

  if (window.MutationObserver) {
    var t = null;
    new MutationObserver(function () {
      if (t) return;
      t = setTimeout(function () { t = null; scan(document); sweep(); }, 60);
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  function count(key) {
    var db = fs();
    if (!db) return Promise.resolve(0);
    return db.collection('comments').where('key', '==', safeKey(key)).get().then(function (s) { return s.size; }, function () { return 0; });
  }

  (function css() {
    var st = document.createElement('style'); st.id = 'cmtCss';
    st.textContent = '.cmt{border-top:1px dashed var(--line,#e4ece0);margin-top:10px;padding-top:8px;display:flex;flex-direction:column;gap:6px;}' +
      '.cmt-h{font-weight:700;font-size:.86rem;}.cmt-n{font-weight:500;color:var(--text-muted,#6b786e);}.cmt-mut{font-size:.76rem;color:var(--text-muted,#6b786e);}' +
      '.cmt-list{display:flex;flex-direction:column;gap:6px;max-height:260px;overflow-y:auto;}' +
      '.cmt-c{background:var(--tonal,#f1f4ee);border-radius:12px;padding:7px 10px;}.cmt-c.mine{background:#e8f3df;}' +
      '.cmt-m{font-size:.7rem;color:var(--text-muted,#6b786e);}.cmt-t{font-size:.84rem;white-space:pre-wrap;margin-top:2px;}' +
      '.cmt-x{border:0;background:transparent;color:#b3261e;cursor:pointer;font-size:.7rem;}' +
      '.cmt-new{display:flex;gap:6px;align-items:flex-end;}.cmt-in{flex:1;margin:0 !important;min-height:44px;}' +
      '.cmt-send{min-height:44px;padding:0 14px;border-radius:12px;border:0;background:var(--primary,#1d5a2c);color:#fff;font:inherit;font-weight:700;cursor:pointer;}';
    (document.head || document.documentElement).appendChild(st);
  })();

  return { block: block, count: count, _scan: scan };
})();
window.Comments = Comments;
