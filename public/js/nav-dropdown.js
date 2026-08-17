/* nav-dropdown.js — groups material tabs under the ריסוס tab
 * ------------------------------------------------------------------
 * Moves the existing "חומרים" (data-tab="admin") and "חיפוש חומרים"
 * (data-tab="pestsearch") tab elements into a dropdown that hangs off
 * the "ריסוס" (data-tab="spray") tab.
 *
 * WHY THE MENU LIVES ON <body>:
 *   .tab-bar has `overflow-x: auto` (horizontal tab scrolling) AND
 *   `backdrop-filter: blur(12px)`. Per spec, overflow-x:auto with
 *   overflow-y:visible computes to overflow-y:auto, so the bar clips
 *   its descendants vertically; and a non-none backdrop-filter makes
 *   .tab-bar a containing block for fixed-position descendants too.
 *   Result: a dropdown rendered *inside* the bar is clipped away and
 *   invisible — which is exactly how the חומרים + חיפוש חומרים tabs
 *   vanished from the UI. The menu is therefore portaled to <body>
 *   and positioned with position:fixed coordinates computed from the
 *   parent tab's bounding rect.
 *
 * IMPORTANT: the original DOM NODES are MOVED, not cloned or rebuilt.
 * Every existing reference keeps working untouched:
 *   - the per-tab click handler bound in app.js (~line 2178)
 *   - the admin-only role gate that toggles style.display on
 *     [data-tab="admin"]
 *   - querySelector('[data-tab="..."]') / '.tab[data-t-key]' elsewhere
 * Nothing in app.js needs to change.
 */
(function () {
  'use strict';

  var SPRAY = '[data-tab="spray"]';
  var CHILDREN = ['admin', 'pestsearch'];
  var GAP = 4;   // px between the tab bar and the menu
  var EDGE = 8;  // min px from the viewport edge

  function build() {
    var bar = document.querySelector('.tab-bar');
    var spray = document.querySelector(SPRAY);
    if (!bar || !spray) return;
    if (spray.parentNode && spray.parentNode.classList.contains('tab-drop')) return; // already built

    var kids = CHILDREN.map(function (n) {
      return document.querySelector('[data-tab="' + n + '"]');
    }).filter(Boolean);
    if (!kids.length) return;

    // ── wrapper takes the spray tab's place in the bar ──
    var wrap = document.createElement('div');
    wrap.className = 'tab-drop';
    spray.parentNode.insertBefore(wrap, spray);
    wrap.appendChild(spray);

    // Caret marks the tab as expandable.
    var caret = document.createElement('span');
    caret.className = 'tab-drop-caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '\u25BE';
    spray.appendChild(caret);

    // ── menu is portaled to <body> so nothing can clip it ──
    var menu = document.createElement('div');
    menu.className = 'tab-drop-menu';
    menu.setAttribute('role', 'menu');
    kids.forEach(function (k) { menu.appendChild(k); });
    document.body.appendChild(menu);

    spray.setAttribute('aria-haspopup', 'true');
    spray.setAttribute('aria-expanded', 'false');

    var open = false;
    var hideTimer = null;

    function place() {
      var r = spray.getBoundingClientRect();
      var w = menu.offsetWidth || 190;
      var vw = window.innerWidth || document.documentElement.clientWidth;
      // RTL app: align the menu's right edge with the tab's right edge.
      var left = r.right - w;
      if (left + w > vw - EDGE) left = vw - EDGE - w;
      if (left < EDGE) left = EDGE;
      menu.style.left = Math.round(left) + 'px';
      menu.style.top = Math.round(r.bottom + GAP) + 'px';
    }

    function openMenu() {
      clearTimeout(hideTimer);
      if (!spray.offsetParent && spray.getClientRects().length === 0) return; // bar hidden (e.g. login)
      open = true;
      menu.classList.add('open');
      spray.setAttribute('aria-expanded', 'true');
      wrap.classList.add('open');
      place();
    }

    function closeMenu() {
      clearTimeout(hideTimer);
      open = false;
      menu.classList.remove('open');
      wrap.classList.remove('open');
      spray.setAttribute('aria-expanded', 'false');
    }

    function closeSoon() {
      clearTimeout(hideTimer);
      hideTimer = setTimeout(closeMenu, 220);
    }

    var noHover = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);

    if (noHover) {
      // Touch: first tap opens the menu, second tap selects the spray tab.
      spray.addEventListener('click', function (e) {
        if (!open) {
          e.preventDefault();
          e.stopPropagation();
          openMenu();
        }
      }, true);
      document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target) && !menu.contains(e.target)) closeMenu();
      });
    } else {
      wrap.addEventListener('mouseenter', openMenu);
      wrap.addEventListener('mouseleave', closeSoon);
      menu.addEventListener('mouseenter', function () { clearTimeout(hideTimer); });
      menu.addEventListener('mouseleave', closeSoon);
      spray.addEventListener('focus', openMenu);
      wrap.addEventListener('click', function () { closeMenu(); });
    }

    // Selecting a child always closes the menu.
    menu.addEventListener('click', function () { closeMenu(); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') closeMenu();
    });

    // Keep the fixed menu glued to its tab while things move underneath.
    function reflow() { if (open) place(); }
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);
    bar.addEventListener('scroll', reflow);

    // ── keep the parent lit while one of its children is the open tab ──
    function sync() {
      var childActive = kids.some(function (k) {
        return k.classList.contains('active');
      });
      spray.classList.toggle('has-active-child', childActive);
    }
    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.tab')) setTimeout(sync, 0);
    });
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
