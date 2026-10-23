/* ownership.js — who may change what (Oct 2026)
 *
 * The rule, as Alon set it:
 *   • Admin creates, edits and deletes anything.
 *   • Everyone else (operator, worker, viewer) may create items where their
 *     role allows, and may edit / delete ONLY the items they created
 *     themselves. Anything created by admin — or by someone else — opens
 *     read-only for them: they can view it and comment (comments.js).
 *   • Plots and farms are created and deleted by admin only.
 *   • Records people make about an item (a spray, a work-log line, fertilizer
 *     given, a trap count, a task marked done) are their own items, so
 *     anyone allowed to make them may add them to an admin's plot.
 *
 * Every new item is stamped with createdBy (lower-cased email),
 * createdByName and createdAt. Items from before this rule carry no stamp:
 * they count as admin's (read-only for others), except where a module's
 * older own field names the person (see legacy()).
 *
 * Enforcement is in the app. Firestore rules additionally stop non-admins
 * from adding or removing plots and farms (count check on
 * plotMapperSprayData) and keep comments per-author on the server.
 *
 * Public: Own.me(), Own.isAdmin(), Own.stamp(obj), Own.canEdit(obj, legacyName),
 *         Own.creatorName(obj), Own.lockHtml(obj), Own.denied()
 */
var Own = (function () {
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
  function me() {
    var u = window.currentUser || {};
    return { id: String(u.email || '').toLowerCase().trim(), name: u.name || u.username || '', username: String(u.username || '').toLowerCase(), role: u.role || '' };
  }
  function isAdmin() { return me().role === 'admin'; }
  function creator(o) { return String((o && (o.createdBy || o.created_by)) || '').toLowerCase().trim(); }

  // Stamp a NEW item (never overwrites an existing stamp).
  function stamp(o) {
    if (!o || typeof o !== 'object') return o;
    if (!creator(o)) {
      var m = me();
      o.createdBy = m.id || m.username;
      o.createdByName = m.name;
      o.createdAt = Date.now();
    }
    return o;
  }

  // A pre-rule item names its author only by a free-text field (`by`,
  // `worker`, `createdByName`…). The module passes that value; a match on
  // the user's display name or username counts as theirs.
  function legacy(o, legacyName) {
    if (creator(o)) return false;
    var n = String(legacyName != null ? legacyName : (o && (o.createdByName || o.by)) || '').trim().toLowerCase();
    if (!n) return false;
    var m = me();
    return n === String(m.name || '').trim().toLowerCase() || (m.username && n === m.username);
  }

  function canEdit(o, legacyName) {
    if (isAdmin()) return true;
    if (!o) return false;
    var c = creator(o), m = me();
    if (c) return c === m.id || (m.username && c === m.username);
    return legacy(o, legacyName);
  }
  function creatorName(o) {
    if (!o) return '';
    return o.createdByName || (creator(o) ? creator(o).split('@')[0] : tt('מנהל המערכת', 'ผู้ดูแลระบบ', 'المسؤول'));
  }
  function lockHtml(o) {
    return '<div class="own-lock">🔒 ' + tt('נוצר על ידי', 'สร้างโดย', 'أنشأه') + ' ' + esc(creatorName(o)) + ' — ' +
      tt('לצפייה ולתגובות בלבד', 'ดูและแสดงความคิดเห็นเท่านั้น', 'للعرض والتعليق فقط') + '</div>';
  }
  function denied() {
    if (typeof showToast === 'function') showToast('🔒 ' + tt('אפשר לשנות רק פריטים שיצרת בעצמך', 'แก้ไขได้เฉพาะรายการที่คุณสร้างเอง', 'يمكن تعديل العناصر التي أنشأتها فقط'));
    return false;
  }

  (function css() {
    if (document.getElementById('ownCss')) return;
    var st = document.createElement('style'); st.id = 'ownCss';
    st.textContent = '.own-lock{background:#f3efe2;color:#5c4a00;border-radius:12px;padding:7px 11px;font-size:.78rem;margin:6px 0;}';
    (document.head || document.documentElement).appendChild(st);
  })();

  return { me: me, isAdmin: isAdmin, stamp: stamp, canEdit: canEdit, creator: creator, creatorName: creatorName, lockHtml: lockHtml, denied: denied };
})();
window.Own = Own;
