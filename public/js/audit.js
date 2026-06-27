// ── AUDIT LOG MODULE ──
// Writes a tamper-resistant record of every edit/delete/approve action.
// Used by timeclock (Phase 1), leave-management (Phase 4) and any other
// module that mutates user data via a manager action.
//
// Document path: audit-log/{ts}_{actor}_{action}
// Read access: admin only (enforced in firestore.rules).
// Write access: operator+ (managers performing actions).
//
// Schema:
//   ts          (number)  — millis since epoch, client clock at action time
//   serverTs    (Timestamp) — populated by Firestore serverTimestamp()
//   actor       (string)  — username of the person doing the action
//   actorName   (string)  — display name
//   actorRole   (string)  — role at the time of action
//   action      (string)  — 'edit' | 'delete' | 'approve' | 'reject' | 'create'
//   target      (string)  — 'timeclock' | 'leave' | 'schedule' | 'sites'
//   targetId    (string)  — the doc ID of the affected document
//   targetUser  (string)  — username whose data was affected (for filtering)
//   before      (object|null) — snapshot before the change
//   after       (object|null) — snapshot after the change
//   reason      (string)  — free-text rationale, optional
//   userAgent   (string)
//   online      (boolean) — whether the device was online at write time
//
// All writes are best-effort. If offline, Firestore's local persistence
// queues them and replays on reconnect — same as any other write.

var Audit = (function() {
  'use strict';

  function _stripUndefined(obj) {
    if (obj == null) return null;
    return JSON.parse(JSON.stringify(obj));
  }

  function log(action, target, targetId, opts) {
    if (typeof db === 'undefined') return Promise.resolve();
    opts = opts || {};
    var user = window.currentUser || {};
    var ts = Date.now();
    var docId = ts + '_' + (user.username || 'anon') + '_' + action;
    var doc = {
      ts: ts,
      serverTs: firebase.firestore.FieldValue.serverTimestamp(),
      actor: user.username || 'anon',
      actorName: user.name || user.username || 'anon',
      actorRole: user.role || 'unknown',
      action: action,
      target: target,
      targetId: targetId,
      targetUser: opts.targetUser || null,
      before: _stripUndefined(opts.before),
      after:  _stripUndefined(opts.after),
      reason: opts.reason || null,
      userAgent: navigator.userAgent || '',
      online: navigator.onLine !== false
    };
    return db.collection('audit-log').doc(docId).set(doc)
      .catch(function(err) {
        console.warn('Audit log write failed:', err.message);
        // Never block the actual user action on audit failure.
      });
  }

  // Fetch recent audit entries (admin only — server enforces).
  // Returns a Promise<Array> of audit docs newest first.
  function getRecent(limit) {
    if (typeof db === 'undefined') return Promise.resolve([]);
    limit = limit || 50;
    return db.collection('audit-log')
      .orderBy('ts', 'desc')
      .limit(limit)
      .get()
      .then(function(snap) {
        var rows = [];
        snap.forEach(function(doc) { rows.push(Object.assign({ _id: doc.id }, doc.data())); });
        return rows;
      })
      .catch(function(err) {
        console.warn('Audit log read failed:', err.message);
        return [];
      });
  }

  return { log: log, getRecent: getRecent };
})();
