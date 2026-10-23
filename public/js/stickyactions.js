/* stickyactions.js — סרגל פעולות צף: חזרה · שמירה · סגירה (Oct 2026)
 * ------------------------------------------------------------------
 * Every window and sub-window opened in #modalContainer gets a bar pinned
 * to the bottom of the screen that is ALWAYS there while the window is
 * open, wherever the user has scrolled:
 *
 *    [ → חזרה ]   [ 💾 the window's own save … ]   [ ✕ סגור ]
 *
 *   חזרה  presses the window's own back control (→ חזרה, → כל האזורים,
 *         → לכל המוצרים, ביטול of a sub-form…). On the window's first
 *         screen, where there is nothing to step back to, it closes.
 *   שמירה mirrors up to two commit buttons (שמור / שמירה / אישור / הוסף
 *         / 💾) that are visible in the window right now.
 *   סגור  presses the window's own close (✕ / סגור / data-a="close");
 *         a window without one is closed by emptying the container.
 *
 * The bar's buttons are proxies: a click is forwarded to the real button,
 * so every module keeps its own handlers (ownership checks, ModalReturn,
 * map cleanup) and none of them need to know this file exists.
 *
 * Never mirrored: anything destructive (🗑, warn/danger classes, delete /
 * remove handlers) and any button marked data-no-sticky. A whole window
 * can opt out with data-no-sticky-all on any element inside it.
 *
 * On phones the bar hides while a text field is focused, so it never sits
 * on the keyboard; on desktop it stays.
 *
 * Load order: last, after every module that renders modals.
 */
(function () {
  'use strict';

  var BAR_ID = '__stickyActions';
  var MAX_SAVES = 2;

  var RX_BACK = /חזרה|חזור|^\s*[→←↩]|กลับ|رجوع/;          // חזרה/חזור/→/←/↩, th, ar
  var RX_CANCEL = /^\s*(ביטול|ยกเลิก|إلغاء)\s*$/;                   // ביטול
  var RX_CLOSE = /^\s*[✕✖×xX]\s*$|סגור|ปิด|إغلاق/;                       // ✕ / סגור
  var RX_SAVE = /שמור|שמירה|אישור|💾|บันทึก|ตกลง|حفظ|موافق/; // שמור/שמירה/אישור/💾

  var DESTRUCTIVE_ATTR = /(^|[^a-z])(_?del|delete|remove|destroy|trash|clear)/i;
  var DESTRUCTIVE_CLASS = /\b(warn|danger|delete|destructive)\b/;

  function tt(he, th, ar) {
    var l = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    return l === 'th' ? th : l === 'ar' ? ar : he;
  }
  function label(el) { return (el.textContent || '').replace(/\s+/g, ' ').trim(); }
  function visible(el) {
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  function destructive(el) {
    if (DESTRUCTIVE_CLASS.test(el.className || '')) return true;
    if (DESTRUCTIVE_ATTR.test(el.getAttribute('onclick') || '')) return true;
    var a = el.getAttribute('data-a') || el.getAttribute('data-m') || el.getAttribute('data-zm') || '';
    if (/^del/.test(a)) return true;
    if (/🗑/.test(label(el))) return true;      // 🗑
    return false;
  }
  function usable(el) {
    return !el.disabled && !el.closest('#' + BAR_ID) && !el.closest('[data-no-sticky]') && !destructive(el) && visible(el);
  }

  function ensureCss() {
    if (document.getElementById('__stickyActionsCss')) return;
    var st = document.createElement('style');
    st.id = '__stickyActionsCss';
    st.textContent =
      '#' + BAR_ID + '{position:fixed;inset-inline:0;bottom:0;z-index:10050;display:flex;gap:8px;justify-content:center;align-items:center;' +
        'padding:8px 12px calc(8px + env(safe-area-inset-bottom,0px));pointer-events:none;transition:opacity .16s ease,transform .16s ease;}' +
      '#' + BAR_ID + '.hide{opacity:0;transform:translateY(110%);}' +
      '#' + BAR_ID + ' .sa-in{pointer-events:auto;display:flex;gap:8px;align-items:center;padding:7px;border-radius:18px;max-width:100%;' +
        'background:rgba(255,255,255,.94);border:1px solid rgba(29,90,44,.16);box-shadow:0 8px 28px rgba(10,30,15,.22);' +
        'backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);}' +
      '#' + BAR_ID + ' button{padding:10px 16px;border-radius:12px;border:1.5px solid #dfe7da;background:#fff;color:var(--primary,#1d5a2c);' +
        'font-family:inherit;font-weight:800;font-size:.86rem;cursor:pointer;white-space:nowrap;max-width:40vw;overflow:hidden;text-overflow:ellipsis;min-height:42px;}' +
      '#' + BAR_ID + ' button:active{transform:scale(.96);}' +
      '#' + BAR_ID + ' button.commit{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}' +
      '#' + BAR_ID + ' button.close{color:#7a3b32;}' +
      '#modalContainer .__sa-pad{height:72px;flex:none;}';
    document.head.appendChild(st);
  }
  function bar() {
    var b = document.getElementById(BAR_ID);
    if (!b) { b = document.createElement('div'); b.id = BAR_ID; b.className = 'hide'; document.body.appendChild(b); }
    return b;
  }
  function hide() { var b = bar(); b.className = 'hide'; b.innerHTML = ''; }

  function closeWindow(host) {
    // Leaflet maps inside the window are released by their module's own
    // close; here there is none, so empty the container.
    host.innerHTML = '';
  }

  function rebuild() {
    ensureCss();
    var host = document.getElementById('modalContainer');
    if (!host || !host.firstElementChild || host.querySelector('[data-no-sticky-all]') || !visible(host.firstElementChild)) return hide();

    var btns = Array.prototype.filter.call(host.querySelectorAll('button,[role="button"],.btn'), usable);
    var closeBtn = null, backBtn = null, cancelBtn = null, saves = [], seen = {};
    btns.forEach(function (el) {
      var t = label(el), a = el.getAttribute('data-a') || '';
      if (!t && !a) return;
      if (!closeBtn && (a === 'close' || (t.length <= 12 && RX_CLOSE.test(t)) || /^(x|close|סגור)$/i.test(el.getAttribute('aria-label') || ''))) { closeBtn = el; return; }
      if (!backBtn && (a === 'back' || a === 'zmback' || (t.length <= 30 && RX_BACK.test(t)))) { backBtn = el; return; }
      if (!cancelBtn && RX_CANCEL.test(t)) { cancelBtn = el; return; }
      if (saves.length < MAX_SAVES && t.length <= 30 && RX_SAVE.test(t) && !seen[t]) { seen[t] = 1; saves.push(el); }
    });
    // A sub-form's ביטול is its way back; on its own it is also the way out.
    if (!backBtn && cancelBtn) backBtn = cancelBtn;

    var b = bar(), inner = document.createElement('div');
    inner.className = 'sa-in';
    function proxy(text, cls, fn) {
      var c = document.createElement('button');
      c.type = 'button'; c.textContent = text; if (cls) c.className = cls;
      c.addEventListener('click', function (ev) { ev.preventDefault(); ev.stopPropagation(); fn(); schedule(); });
      inner.appendChild(c);
    }
    function press(src, fallback) { return function () { if (src && document.body.contains(src)) src.click(); else if (fallback) fallback(); }; }
    var doClose = closeBtn ? press(closeBtn, function () { closeWindow(host); }) : function () { closeWindow(host); };

    proxy('→ ' + tt('חזרה', 'กลับ', 'رجوع'), '', backBtn ? press(backBtn, doClose) : doClose);
    saves.forEach(function (s) { proxy(label(s), 'commit', press(s)); });
    proxy('✕ ' + tt('סגור', 'ปิด', 'إغلاق'), 'close', doClose);

    b.innerHTML = ''; b.appendChild(inner);
    var f = document.activeElement;
    var typing = f && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName) && host.contains(f) && window.matchMedia('(max-width: 899px)').matches;
    b.className = typing ? 'hide' : '';

    var sheet = host.firstElementChild.firstElementChild || host.firstElementChild;
    if (sheet && !sheet.querySelector(':scope > .__sa-pad')) {
      var pad = document.createElement('div'); pad.className = '__sa-pad'; sheet.appendChild(pad);
    }
  }

  var pending = null;
  function schedule() {
    if (pending) clearTimeout(pending);
    pending = setTimeout(rebuild, 60);   // modules repaint in bursts
  }

  function start() {
    var host = document.getElementById('modalContainer');
    if (!host) return;
    new MutationObserver(function (muts) {
      // ignore the bar's own pad insertion
      for (var i = 0; i < muts.length; i++) {
        var n = muts[i].addedNodes;
        if (n.length === 1 && n[0].className === '__sa-pad') continue;
        return schedule();
      }
    }).observe(host, { childList: true, subtree: true });
    // sections that show / hide without re-rendering
    host.addEventListener('click', schedule, true);
    host.addEventListener('change', schedule, true);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);
    document.addEventListener('focusin', function (e) {
      var t = e.target;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && window.matchMedia('(max-width: 899px)').matches) {
        var b = document.getElementById(BAR_ID); if (b) b.classList.add('hide');
      }
    });
    document.addEventListener('focusout', schedule);
    document.addEventListener('shorashim:lang', schedule);
    schedule();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  window.StickyActions = { refresh: schedule };
})();
