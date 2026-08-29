/* stickyactions.js — סרגל פעולות צף (persistent modal actions)
 * ------------------------------------------------------------------
 * Every modal in this app puts its סגור / ביטול / חזרה / אישור / שמור
 * buttons in one row at the top or the bottom of the sheet. On a long
 * screen — a treatment plan with thirty rows, a maintenance quote, the
 * monthly report — that row scrolls out of reach, and the way out of the
 * modal is a full scroll away from wherever the user actually is.
 *
 * Rather than edit every module (and re-edit each new one), this observes
 * #modalContainer and mirrors the escape/commit buttons into a floating
 * bar pinned to the bottom of the viewport. The clones are proxies: a
 * click is forwarded to the real button, so every module keeps its own
 * handlers and none of them need to know this file exists.
 *
 * WHY MIRROR RATHER THAN position:sticky THE ORIGINAL ROW
 *   The action rows differ across modules — some are flex, some are grid,
 *   some sit inside a scrolling child, some are the first element and some
 *   the last. Making an arbitrary descendant sticky in all those layouts
 *   reliably is not achievable with one rule; mirroring is.
 *
 * IT STAYS OUT OF THE WAY
 *   - Only appears when the modal is actually taller than the viewport.
 *     A short dialog already shows its buttons; a second copy is noise.
 *   - Hides itself while a text field is focused, so it never sits on top
 *     of the mobile keyboard or the field being typed into.
 *   - A module can opt out entirely with data-no-sticky on any ancestor.
 *
 * Load order: last, after every module that renders modals — it binds to
 * the container, not to any of them.
 */
(function () {
  'use strict';

  var BAR_ID = '__stickyActions';
  var MAX_BUTTONS = 5;

  // Buttons worth mirroring: the ways OUT of a modal and the ways to COMMIT
  // it. Deliberately not "every button" — mirroring 🗑 delete or an inline
  // ➕ add row would put a destructive or context-dependent action under the
  // user's thumb, detached from the row it belongs to.
  var PATTERNS = [
    /\u05e1\u05d2\u05d5\u05e8/,                      // סגור
    /\u05d1\u05d9\u05d8\u05d5\u05dc/,                // ביטול
    /\u05d7\u05d6\u05e8\u05d4|\u05d7\u05d6\u05d5\u05e8/, // חזרה / חזור
    /\u05d0\u05d9\u05e9\u05d5\u05e8/,                // אישור
    /\u05e9\u05de\u05d5\u05e8|\u05e9\u05de\u05d9\u05e8\u05d4/, // שמור / שמירה
    /\u0e1b\u0e34\u0e14|\u0e22\u0e01\u0e40\u0e25\u0e34\u0e01|\u0e01\u0e25\u0e31\u0e1a|\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01|\u0e15\u0e01\u0e25\u0e07/,
    /\u0625\u063a\u0644\u0627\u0642|\u0625\u0644\u063a\u0627\u0621|\u0631\u062c\u0648\u0639|\u062d\u0641\u0638|\u0645\u0648\u0627\u0641\u0642/,
    /^\s*[\u2715\u2716\u00d7xX\u21a9\u2190]\s*$/     // bare ✕ / × / ↩ / ←
  ];

  // Commit-type words get the solid treatment, escapes get the ghost one,
  // so the bar reads the same way the in-sheet row does.
  var COMMIT = /\u05d0\u05d9\u05e9\u05d5\u05e8|\u05e9\u05de\u05d5\u05e8|\u05e9\u05de\u05d9\u05e8\u05d4|\u0e15\u0e01\u0e25\u0e07|\u0e1a\u0e31\u0e19\u0e17\u0e36\u0e01|\u062d\u0641\u0638|\u0645\u0648\u0627\u0641\u0642/;

  function ensureCss() {
    if (document.getElementById('__stickyActionsCss')) return;
    var st = document.createElement('style');
    st.id = '__stickyActionsCss';
    st.textContent =
      '#' + BAR_ID + '{position:fixed;inset-inline:0;bottom:0;z-index:10050;' +
        'display:flex;gap:8px;justify-content:center;flex-wrap:wrap;' +
        'padding:10px 12px calc(10px + env(safe-area-inset-bottom,0px));' +
        'background:linear-gradient(to top,rgba(8,18,12,.97) 62%,rgba(8,18,12,0));' +
        'pointer-events:none;transition:opacity .16s ease,transform .16s ease;}' +
      '#' + BAR_ID + '.hide{opacity:0;transform:translateY(110%);}' +
      '#' + BAR_ID + ' button{pointer-events:auto;padding:11px 20px;border-radius:12px;' +
        'border:1.5px solid rgba(255,255,255,.22);background:rgba(255,255,255,.10);' +
        'color:#fff;font-family:inherit;font-weight:800;font-size:.9rem;cursor:pointer;' +
        'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);' +
        'box-shadow:0 4px 18px rgba(0,0,0,.4);max-width:46vw;overflow:hidden;' +
        'text-overflow:ellipsis;white-space:nowrap;}' +
      '#' + BAR_ID + ' button:active{transform:scale(.96);}' +
      '#' + BAR_ID + ' button.commit{background:var(--primary,#2d6a4f);' +
        'border-color:var(--primary,#2d6a4f);}' +
      // Give long modals room to scroll past the bar so the last row is
      // never permanently hidden underneath it.
      '#modalContainer .__sa-pad{height:76px;flex:none;}';
    document.head.appendChild(st);
  }

  function bar() {
    var b = document.getElementById(BAR_ID);
    if (!b) {
      b = document.createElement('div');
      b.id = BAR_ID;
      b.className = 'hide';
      document.body.appendChild(b);
    }
    return b;
  }

  function label(el) {
    return (el.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function isCandidate(el) {
    if (el.disabled || el.closest('[data-no-sticky]')) return false;
    var txt = label(el);
    if (!txt || txt.length > 26) return false;
    for (var i = 0; i < PATTERNS.length; i++) if (PATTERNS[i].test(txt)) return true;
    return false;
  }

  // The scrolling element is whichever ancestor actually overflows — some
  // modals scroll the page, others scroll their own backdrop.
  function scroller(root) {
    var el = root.querySelector('[class*="back"],[style*="overflow"]');
    if (el && el.scrollHeight > el.clientHeight + 40) return el;
    return null;
  }

  function tooTall(root) {
    var sc = scroller(root);
    if (sc) return sc.scrollHeight > sc.clientHeight + 60;
    return root.scrollHeight > window.innerHeight + 60;
  }

  function rebuild() {
    ensureCss();
    var host = document.getElementById('modalContainer');
    var b = bar();

    if (!host || !host.firstElementChild || host.querySelector('[data-no-sticky]')) {
      b.className = 'hide';
      b.innerHTML = '';
      return;
    }

    if (!tooTall(host)) { b.className = 'hide'; b.innerHTML = ''; return; }

    var found = [], seen = {};
    var btns = host.querySelectorAll('button');
    for (var i = 0; i < btns.length && found.length < MAX_BUTTONS; i++) {
      var el = btns[i];
      if (!isCandidate(el)) continue;
      var txt = label(el);
      if (seen[txt]) continue;          // the same word twice helps nobody
      seen[txt] = true;
      found.push(el);
    }

    if (!found.length) { b.className = 'hide'; b.innerHTML = ''; return; }

    b.innerHTML = '';
    found.forEach(function (src) {
      var c = document.createElement('button');
      c.type = 'button';
      c.textContent = label(src);
      if (COMMIT.test(c.textContent)) c.className = 'commit';
      // Proxy, not a re-implementation: the original keeps its own onclick,
      // so this file never has to know what any module's buttons do.
      c.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (document.body.contains(src)) src.click();
        else { b.className = 'hide'; b.innerHTML = ''; }
      });
      b.appendChild(c);
    });
    b.className = '';

    // Bottom padding inside the sheet so the final row clears the bar.
    var sheet = host.firstElementChild.firstElementChild || host.firstElementChild;
    if (sheet && !sheet.querySelector(':scope > .__sa-pad')) {
      var pad = document.createElement('div');
      pad.className = '__sa-pad';
      sheet.appendChild(pad);
    }
  }

  var pending = null;
  function schedule() {
    if (pending) clearTimeout(pending);
    // Modules repaint by replacing innerHTML wholesale, often several times
    // in a burst. Debouncing means one rebuild per burst, not one per node.
    pending = setTimeout(rebuild, 60);
  }

  function start() {
    var host = document.getElementById('modalContainer');
    if (!host) return;
    new MutationObserver(schedule).observe(host, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);

    // Never cover the field being typed into, or sit under the soft keyboard.
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
        var b = document.getElementById(BAR_ID);
        if (b) b.classList.add('hide');
      }
    });
    document.addEventListener('focusout', function () { schedule(); });
    schedule();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  // Exposed so a module can force a refresh after it paints asynchronously.
  window.StickyActions = { refresh: schedule };
})();
