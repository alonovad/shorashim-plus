/* exitguard.js — the app never closes by accident
 * ------------------------------------------------------------------
 * Three jobs, all about not losing your place:
 *
 * 1. BACK BUTTON (Android hardware/gesture back, browser back)
 *    The app had no history entries of its own, so ANY back press left the
 *    app — even with a form half filled. Now a guard entry sits on top of
 *    history. A back press:
 *      - closes the hamburger menu if it is open;
 *      - else closes the topmost open window by pressing that window's own
 *        way out (חזרה / ביטול / סגור), so it behaves exactly as if the user
 *        had tapped it — the module's own handler runs, nothing is bypassed;
 *      - else asks "לצאת מהאפליקציה?" in an in-app dialog.
 *    It never presses a save/commit button and never anything destructive
 *    (same rules as stickyactions.js, which mirrors the same buttons).
 *
 * 2. CLOSING THE TAB / WINDOW
 *    beforeunload asks the browser to confirm. The browser shows its own
 *    generic text; custom wording is not allowed by any browser. Deliberate
 *    reloads (logout, restore, "רענן אפליקציה") call ExitGuard.allowLeave()
 *    first so they are not interrupted.
 *
 * 3. RETURNING TO THE OPENER (window.ModalReturn)
 *    Every screen shares #modalContainer, so a department opened from
 *    inside another (Orders / Construction / Maintenance schedule from the
 *    maintenance list, Orders from the crop plan, the individual field
 *    reports from the season monitoring screen) used to close by emptying
 *    the container — dropping the user out of maintenance altogether. A
 *    department now calls ModalReturn.enter(key) when it opens and
 *    ModalReturn.dismiss(key) from its close button; dismiss goes back to
 *    whatever opened it.
 *
 * LIMITS (platform, not fixable from a web page)
 *   - Swiping the app away in Android's recent-apps list cannot be caught.
 *   - Chrome ignores history entries added before the user's first tap, so
 *     the guard arms on the first interaction. Opening the app and pressing
 *     back before touching anything still leaves.
 *
 * Load order: anywhere after app.js; it only touches modules at run time.
 */
(function () {
  'use strict';

  function lang() {
    try { if (typeof currentLang !== 'undefined' && currentLang) return currentLang; } catch (e) {}
    try { return localStorage.getItem('shorashim-lang') || 'he'; } catch (e) { return 'he'; }
  }
  function tt(he, th, ar) {
    var l = lang();
    if (l === 'th') return th || he;
    if (l === 'ar') return ar || he;
    return he;
  }
  function mc() { return document.getElementById('modalContainer'); }

  // ════════════════════════════════════════════════════════════════
  //  3. ModalReturn — departments go back to whatever opened them
  // ════════════════════════════════════════════════════════════════
  // Openers a department can return to. `test` recognises the opener's
  // screen in #modalContainer; `reopen` redraws it.
  var OPENERS = {
    maint: {
      test: function (m) { return !!m.querySelector('[data-maint-view]'); },
      reopen: function () { if (window.Maintenance && Maintenance.showProjectsList) Maintenance.showProjectsList(); }
    },
    pestmon: {
      test: function (m) { return !!m.querySelector('#pmRoot'); },
      reopen: function () { if (window.PestMonitor && PestMonitor.open) PestMonitor.open(); }
    },
    agriplan: {
      test: function (m) { return !!m.querySelector('#apRoot'); },
      reopen: function () { if (window.AgriPlan && AgriPlan.open) AgriPlan.open(); }
    }
  };
  var _targets = {};

  function detectOpener(m) {
    if (!m || !m.firstElementChild) return null;
    for (var k in OPENERS) {
      if (OPENERS.hasOwnProperty(k)) {
        try { if (OPENERS[k].test(m)) return k; } catch (e) {}
      }
    }
    return null;
  }

  var ModalReturn = {
    // Call at the top of a department's entry point, BEFORE it repaints the
    // container, while the opener's screen is still there to be recognised.
    //   opener on screen      → remember it
    //   container empty       → opened from the app itself, nothing to return to
    //   anything else         → an internal re-entry (e.g. ✕ from a day view
    //                           back to the calendar): keep what we had
    enter: function (key) {
      var m = mc();
      var o = detectOpener(m);
      if (o) _targets[key] = o;
      else if (!m || !m.firstElementChild) _targets[key] = null;
    },
    // The department's close button. Clears the container, then redraws
    // the opener if there was one.
    dismiss: function (key) {
      var t = _targets[key] || null;
      _targets[key] = null;
      var m = mc();
      if (m) m.innerHTML = '';
      if (t && OPENERS[t]) { try { OPENERS[t].reopen(); } catch (e) { console.warn('ModalReturn', e); } }
    },
    target: function (key) { return _targets[key] || null; }
  };
  window.ModalReturn = ModalReturn;

  // A target only stays valid while something is continuously on screen.
  // Once anything empties the container (another module's own close), the
  // chain is broken and a later entry must not jump back to a stale opener.
  function watchContainer() {
    var m = mc();
    if (!m || typeof MutationObserver === 'undefined') return;
    new MutationObserver(function () {
      if (!m.firstElementChild) _targets = {};
    }).observe(m, { childList: true });
  }

  // ════════════════════════════════════════════════════════════════
  //  2. Tab / window close
  // ════════════════════════════════════════════════════════════════
  var _allowLeave = false;
  function allowLeave() { _allowLeave = true; }

  window.addEventListener('beforeunload', function (e) {
    if (_allowLeave) return;
    e.preventDefault();
    e.returnValue = '';   // Chrome < 119 needs a value set to show the prompt
    return '';
  });

  // ════════════════════════════════════════════════════════════════
  //  1. Back button
  // ════════════════════════════════════════════════════════════════
  var GUARD = '__egGuard', BASE = '__egBase';
  var _armed = false;
  var _exiting = false;

  function stateIs(s, v) { return !!(s && s.__eg === v); }

  function pushGuard() {
    try { history.pushState({ __eg: GUARD }, ''); } catch (e) {}
  }

  // Arming waits for the first tap: Chrome skips history entries a page
  // adds before the user interacts, which would let the first back press
  // straight through the guard.
  function arm() {
    if (_armed) return;
    _armed = true;
    try {
      if (!stateIs(history.state, GUARD)) {
        history.replaceState({ __eg: BASE }, '');
        pushGuard();
      }
    } catch (e) {}
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, arm, { capture: true, passive: true });
  });

  // ── What counts as "the way out" of a window ──
  // Matched against the label with emoji/symbols stripped. BACK may lead a
  // longer label ("חזרה לרשימה"); CANCEL and CLOSE must BE the label, because
  // "ביטול סימון" (clear all ticks) is an action, not a way out.
  var RX_BACK = /^(\u05d7\u05d6\u05e8\u05d4|\u05d7\u05d6\u05d5\u05e8|\u0e01\u0e25\u0e31\u0e1a|\u0631\u062c\u0648\u0639|\u0627\u0644\u0639\u0648\u062f\u0629)/;   // חזרה חזור กลับ رجوع العودة
  var RX_CANCEL = /^(\u05d1\u05d9\u05d8\u05d5\u05dc|\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01|\u0625\u0644\u063a\u0627\u0621)$/;   // ביטול ยกเลิก إلغاء
  var RX_CLOSE = /^(\u05e1\u05d2\u05d5\u05e8|\u0e1b\u0e34\u0e14|\u0625\u063a\u0644\u0627\u0642)$/;   // סגור ปิด إغلاق
  var RX_X = /[\u2715\u2716\u00d7]/;       // ✕ ✖ ×
  var RX_LEFT = /^\s*\u2190/;               // ← leading a label
  // A save is never a way out, even when worded "שמור וחזור".
  var RX_COMMIT = /\u05e9\u05de\u05d5\u05e8|\u05e9\u05de\u05d9\u05e8\u05d4|\u05d0\u05d9\u05e9\u05d5\u05e8|\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01|\u0e15\u0e01\u0e25\u0e07|\u062d\u0641\u0638|\u0645\u0648\u0627\u0641\u0642/;
  // ↩ means "back" in some sheets and "restore"/"un-void" in others, so it
  // only counts when its handler is a navigation call.
  var RX_UNDO_ARROW = /\u21a9/;
  var RX_NAV_HANDLER = /\.(render\w*|open\w*|show\w*|backTo\w*|close\w*|cancel\w*|dismiss)\s*\(/i;
  // Same refusals as stickyactions.js — a bare ✕ is also the row-remove glyph.
  var DESTRUCTIVE_ATTR = /(^|[^a-z])(_?del|delete|remove|destroy|trash|clear|restore|unvoid|undo|save|submit)/i;
  var DESTRUCTIVE_CLASS = /\b(warn|danger|delete|destructive|remove)\b/i;

  function labelOf(b) {
    var txt = (b.textContent || '').replace(/\s+/g, ' ').trim();
    if (!txt) txt = (b.getAttribute('aria-label') || b.getAttribute('title') || '').trim();
    return txt;
  }
  function visible(el) {
    if (!el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity || '1') > 0.05;
  }
  // 3 = back, 2 = cancel, 1 = close, 0 = not a way out
  function rankButton(b) {
    if (b.disabled || b.closest('[data-no-sticky],[data-no-back]')) return 0;
    if (DESTRUCTIVE_CLASS.test(typeof b.className === 'string' ? b.className : '')) return 0;
    var on = b.getAttribute('onclick') || '';
    if (DESTRUCTIVE_ATTR.test(on)) return 0;
    var txt = labelOf(b);
    if (!txt || txt.length > 26) return 0;
    if (/🗑/.test(txt) || RX_COMMIT.test(txt)) return 0;
    if (RX_UNDO_ARROW.test(txt)) return RX_NAV_HANDLER.test(on) ? 3 : 0;
    var core = txt.replace(/[^\u0590-\u05ff\u0e00-\u0e7f\u0600-\u06ffa-zA-Z0-9 ]/g, ' ')
                  .replace(/\s+/g, ' ').trim();
    if (RX_BACK.test(core)) return 3;
    if (RX_LEFT.test(txt) && (!core || RX_NAV_HANDLER.test(on))) return 3;
    if (RX_CANCEL.test(core)) return 2;
    if (RX_CLOSE.test(core)) return 1;
    if (!core && RX_X.test(txt)) return 1;     // a bare ✕
    return 0;
  }
  function wayOut(root) {
    var best = null, bestRank = 0;
    var list = root.querySelectorAll('button,[role="button"]');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      var r = rankButton(b);
      if (r > bestRank && visible(b)) { best = b; bestRank = r; }   // first in DOM wins ties
    }
    return best;
  }

  // ── Which window is on top ──
  var NOT_A_WINDOW = '#egExit, #__stickyActions, .panel, .bg-layer, .toast, .undo-bar, ' +
    '.map-float-bar, .draw-banner, .hamburger-overlay, .hamburger-panel, .header, header, #offlineBar';

  function zOf(el) { var z = parseInt(getComputedStyle(el).zIndex, 10); return isNaN(z) ? 0 : z; }

  function isWindowLayer(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.matches(NOT_A_WINDOW) || el.closest('#egExit')) return false;
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (cs.pointerEvents === 'none' || parseFloat(cs.opacity || '1') < 0.05) return false;
    var r = el.getBoundingClientRect();
    var vw = window.innerWidth || 1, vh = window.innerHeight || 1;
    return (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
            Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) >= vw * vh * 0.5;
  }

  function topWindow() {
    var cands = [].slice.call(document.body.children);
    var m = mc();
    if (m) {
      cands = cands.concat([].slice.call(m.querySelectorAll(
        ':scope > *, :scope > * > *, [style*="fixed"], [class*="back"], [class*="overlay"], [class*="modal"], [class*="backdrop"]')));
    }
    var layers = cands.filter(isWindowLayer);
    if (!layers.length) return null;
    layers.sort(function (a, b) {
      if (a.contains(b)) return 1;           // the nested one is on top
      if (b.contains(a)) return -1;
      var dz = zOf(b) - zOf(a);
      if (dz) return dz;
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? 1 : -1;
    });
    return layers[0];
  }

  function hamburgerOpen() {
    var p = document.getElementById('hamburgerPanel');
    return !!(p && p.style.display && p.style.display !== 'none');
  }
  function closeHamburger() {
    if (window.TimeClock && TimeClock.closeMenu) { TimeClock.closeMenu(); return; }
    ['hamburgerPanel', 'hamburgerOverlay'].forEach(function (id) {
      var el = document.getElementById(id); if (el) el.style.display = 'none';
    });
  }

  // One step back inside the app. True if something was closed.
  function stepBack() {
    if (hamburgerOpen()) { closeHamburger(); return true; }
    var w = topWindow();
    if (!w) return false;
    var b = wayOut(w);
    if (!b) return false;
    try { b.click(); } catch (e) { console.warn('ExitGuard', e); }
    return true;
  }

  // ── Exit dialog ──
  function dialogOpen() { return !!document.getElementById('egExit'); }
  function closeDialog() { var d = document.getElementById('egExit'); if (d) d.remove(); }

  function showDialog() {
    if (dialogOpen()) return;
    var rtl = lang() !== 'th';
    var d = document.createElement('div');
    d.id = 'egExit';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.dir = rtl ? 'rtl' : 'ltr';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.55);' +
      'display:flex;align-items:center;justify-content:center;padding:16px;font-family:inherit;';
    var btn = 'flex:1;padding:12px 10px;border-radius:12px;font-family:inherit;font-weight:800;' +
      'font-size:.95rem;cursor:pointer;';
    d.innerHTML =
      '<div style="background:var(--card-solid,#fff);color:var(--text,#222);border-radius:18px;' +
        'padding:22px 18px 16px;width:100%;max-width:320px;text-align:center;box-shadow:0 12px 40px rgba(0,0,0,.4);">' +
        '<div style="font-size:1.08rem;font-weight:800;margin-bottom:6px;">' +
          tt('לצאת מהאפליקציה?', 'ออกจากแอป?', 'الخروج من التطبيق؟') + '</div>' +
        '<div style="font-size:.85rem;opacity:.7;margin-bottom:18px;">' +
          tt('שינויים שלא נשמרו עלולים ללכת לאיבוד', 'การเปลี่ยนแปลงที่ยังไม่บันทึกอาจสูญหาย', 'قد تضيع التغييرات غير المحفوظة') + '</div>' +
        '<div style="display:flex;gap:10px;">' +
          '<button type="button" data-eg="stay" style="' + btn + 'border:none;background:var(--primary,#2d6a4f);color:#fff;">' +
            tt('הישאר', 'อยู่ต่อ', 'البقاء') + '</button>' +
          '<button type="button" data-eg="exit" style="' + btn + 'border:1.5px solid var(--border,#ccc);background:transparent;color:inherit;">' +
            tt('יציאה', 'ออก', 'خروج') + '</button>' +
        '</div>' +
      '</div>';
    d.addEventListener('click', function (e) {
      var act = e.target.closest('[data-eg]');
      if (act && act.getAttribute('data-eg') === 'exit') { exitApp(); return; }
      if (act || e.target === d) closeDialog();
    });
    document.body.appendChild(d);
    var stay = d.querySelector('[data-eg="stay"]'); if (stay) stay.focus();
  }

  function toast(msg) {
    if (typeof showToast === 'function') { try { showToast(msg); return; } catch (e) {} }
  }

  // Leaving for real. In a browser tab, going back past our two entries
  // reaches the previous site. An installed app has nothing before them,
  // and a page cannot close a window it did not open — so if we are still
  // here, the guard stays down and the next system back press leaves.
  function exitApp() {
    closeDialog();
    _exiting = true;
    allowLeave();
    try { history.go(-2); } catch (e) {}
    setTimeout(function () {
      if (document.visibilityState === 'hidden') return;
      try { window.close(); } catch (e) {}
      setTimeout(function () {
        if (document.visibilityState === 'hidden') return;
        if (stateIs(history.state, GUARD)) { try { history.back(); } catch (e) {} }
        toast(tt('הקש חזור פעם נוספת ליציאה', 'กดย้อนกลับอีกครั้งเพื่อออก', 'اضغط رجوع مرة أخرى للخروج'));
        // Changed their mind and kept working: put the guard back.
        var rearm = function () {
          window.removeEventListener('pointerdown', rearm, true);
          if (!_exiting) return;
          _exiting = false;
          _allowLeave = false;
          if (!stateIs(history.state, GUARD)) pushGuard();
        };
        window.addEventListener('pointerdown', rearm, true);
      }, 300);
    }, 350);
  }

  window.addEventListener('popstate', function (e) {
    if (_exiting || !_armed) return;
    // Only react when back landed on our base entry. Anything else is
    // somebody's own history use, not ours to interpret.
    if (!stateIs(e.state, BASE) && e.state != null) return;
    if (dialogOpen()) closeDialog();          // back while asking = stay
    else if (!stepBack()) showDialog();
    pushGuard();
  });

  // Coming back from the bfcache after a real exit: start clean.
  window.addEventListener('pageshow', function (e) {
    if (!e.persisted) return;
    _exiting = false;
    _allowLeave = false;
    if (_armed && !stateIs(history.state, GUARD)) pushGuard();
  });

  function init() { watchContainer(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.ExitGuard = {
    allowLeave: allowLeave,
    stepBack: stepBack,      // exposed for tests
    _rank: rankButton
  };
})();
