/* nav-dropdown.js — groups material tabs under the ריסוס tab
 * ------------------------------------------------------------------
 * Moves the existing "חומרים" (data-tab="admin") and "חיפוש חומרים"
 * (data-tab="pestsearch") tab elements into a hover/tap dropdown that
 * hangs off the "ריסוס" (data-tab="spray") tab.
 *
 * IMPORTANT: the original DOM NODES are MOVED, not cloned or rebuilt.
 * That means every existing reference keeps working untouched:
 *   - the global .tab click handler in app.js (~line 1843)
 *   - the admin-only role gate that toggles style.display on
 *     [data-tab="admin"]
 *   - any querySelector('[data-tab="..."]') elsewhere in the app
 * Nothing in app.js needs to change.
 *
 * The children keep their .tab class so app.js still switches content
 * correctly. Because that handler clears .active from every .tab, the
 * parent would visually go dark while a child is open — so we mirror
 * child state onto the parent with .has-active-child.
 */
(function () {
  'use strict';

  var SPRAY = '[data-tab="spray"]';
  var CHILDREN = ['admin', 'pestsearch'];

  function build() {
    var bar = document.querySelector('.tab-bar');
    var spray = document.querySelector(SPRAY);
    if (!bar || !spray) return;
    if (spray.parentNode && spray.parentNode.classList.contains('tab-drop')) return; // already built

    var kids = CHILDREN.map(function (n) {
      return document.querySelector('[data-tab="' + n + '"]');
    }).filter(Boolean);
    if (!kids.length) return;

    // Wrapper takes the spray tab's place in the bar.
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

    var menu = document.createElement('div');
    menu.className = 'tab-drop-menu';
    menu.setAttribute('role', 'menu');
    kids.forEach(function (k) { menu.appendChild(k); });
    wrap.appendChild(menu);

    spray.setAttribute('aria-haspopup', 'true');
    spray.setAttribute('aria-expanded', 'false');

    // ── touch / no-hover devices: first tap opens, second selects ──
    var noHover = window.matchMedia && window.matchMedia('(hover: none)').matches;
    if (noHover) {
      spray.addEventListener('click', function (e) {
        if (!wrap.classList.contains('open')) {
          e.preventDefault();
          e.stopPropagation();
          openMenu();
        }
      }, true);
      document.addEventListener('click', function (e) {
        if (!wrap.contains(e.target)) closeMenu();
      });
      menu.addEventListener('click', function () { closeMenu(); });
    }

    function openMenu() {
      wrap.classList.add('open');
      spray.setAttribute('aria-expanded', 'true');
    }
    function closeMenu() {
      wrap.classList.remove('open');
      spray.setAttribute('aria-expanded', 'false');
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeMenu();
    });

    // ── keep the parent lit while one of its children is the open tab ──
    function sync() {
      var childActive = kids.some(function (k) {
        return k.classList.contains('active');
      });
      spray.classList.toggle('has-active-child', childActive);
    }
    kids.forEach(function (k) {
      k.addEventListener('click', function () { setTimeout(sync, 0); });
    });
    document.querySelectorAll('.tab').forEach(function (t) {
      t.addEventListener('click', function () { setTimeout(sync, 0); });
    });
    sync();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
