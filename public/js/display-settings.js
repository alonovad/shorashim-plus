// ── DISPLAY SETTINGS MODULE ──
// Lets each user pick one of three colour themes (the soft design, Oct 2026).
// Persists to localStorage under 'shorashim-display-settings'.
//
// The palettes themselves live in css/theme-soft.css as body classes; this
// module only switches classes. The same switch runs earlier, from the inline
// bootstrap at the top of <body> in index.html, so the saved theme is in
// place before first paint — keep THEME_CLASSES there in step with THEMES.

var DisplaySettings = (function() {
  'use strict';

  // ── Themes ──
  // cls: extra body class on top of .theme-soft. dark: enables the dark
  // adapter (theme-neon.css). meta: browser/status-bar colour.
  // preview: [page, primary, surface, line] for the picker swatch.
  var THEMES = {
    valleyMorning: {
      name: { he: 'בוקר בבקעה', th: 'เช้าในหุบเขา', ar: 'صباح الوادي' },
      hint: { he: 'בהיר · ירוק עלה הדקל', th: 'สว่าง · เขียวใบปาล์ม', ar: 'فاتح · أخضر سعف النخيل' },
      cls: '', dark: false, meta: '#f1f4ef',
      preview: ['#f1f4ef', '#2f6a4f', '#ffffff', '#dbe3d8']
    },
    valleyNight: {
      name: { he: 'לילה בבקעה', th: 'คืนในหุบเขา', ar: 'ليل الوادي' },
      hint: { he: 'כהה ורך', th: 'มืดและนุ่มนวล', ar: 'داكن وهادئ' },
      cls: 'soft-dark', dark: true, meta: '#141b18',
      preview: ['#141b18', '#93c7a4', '#1d2622', '#2f3b35']
    },
    earthDate: {
      name: { he: 'אדמה ותמר', th: 'ดินและอินทผลัม', ar: 'أرض وتمر' },
      hint: { he: 'בהיר · חום תמר', th: 'สว่าง · น้ำตาลอินทผลัม', ar: 'فاتح · بني التمر' },
      cls: 'soft-earth', dark: false, meta: '#f2f0ec',
      preview: ['#f2f0ec', '#6b4226', '#ffffff', '#e0d9cf']
    }
  };
  var DEFAULT_THEME = 'valleyMorning';
  var ALL_CLASSES = ['soft-dark', 'soft-earth', 'theme-neon', 'theme-classic'];

  var DEFAULTS = { theme: DEFAULT_THEME };

  // ── Translation helper ──
  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function tName(obj) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    return obj[lang] || obj.he;
  }

  // ── Storage ──
  // Older builds saved one of six themes (classic + five neon) plus effect
  // and glow settings. Anything that is not a current theme falls back to
  // the default; the old keys are simply dropped on the next save.
  function loadSettings() {
    var out = { theme: DEFAULT_THEME };
    try {
      var saved = JSON.parse(localStorage.getItem('shorashim-display-settings') || 'null');
      if (saved && THEMES[saved.theme]) out.theme = saved.theme;
    } catch (e) { console.warn('Failed to load display settings:', e); }
    return out;
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem('shorashim-display-settings', JSON.stringify({ theme: settings.theme }));
    } catch (e) { console.warn('Failed to save display settings:', e); }
  }

  // ── Apply Theme ──
  function applyTheme(themeKey) {
    var key = THEMES[themeKey] ? themeKey : DEFAULT_THEME;
    var theme = THEMES[key];
    var body = document.body;
    if (!body) return;

    ALL_CLASSES.forEach(function(c) { body.classList.remove(c); });
    body.classList.add('theme-soft');
    if (theme.cls) body.classList.add(theme.cls);
    // Light themes keep the light stylesheet's classic hooks; the dark one
    // turns on the dark adapter and its body.theme-neon hooks in style.css.
    body.classList.add(theme.dark ? 'theme-neon' : 'theme-classic');

    var darkCss = document.querySelector('link[href*="theme-neon"]');
    if (darkCss) darkCss.disabled = !theme.dark;

    // Inline overrides older builds wrote at runtime would beat the classes.
    body.style.background = '';
    var login = document.getElementById('loginScreen');
    if (login) login.style.background = '';

    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.meta);
  }

  function applyAll(settings) {
    applyTheme((settings || loadSettings()).theme);
  }

  function init() {
    applyAll(loadSettings());
  }

  // ── Settings UI ──
  // Built from the active theme's CSS variables, so the panel itself always
  // matches whatever theme is on screen.
  function showSettings() {
    var settings = loadSettings();
    var modal = document.getElementById('modalContainer');
    if (!modal) return;

    // Swatch colours travel as CSS custom properties, not inline
    // background/border declarations: the dark adapter repaints any inline
    // background inside a dialog, which would turn the light previews dark.
    var cards = Object.keys(THEMES).map(function(key) {
      var th = THEMES[key], p = th.preview, on = settings.theme === key;
      return '<button type="button" class="ds-card' + (on ? ' on' : '') + '" data-theme="' + key + '" aria-pressed="' + on + '"' +
          ' style="--sw-bg:' + p[0] + ';--sw-pri:' + p[1] + ';--sw-card:' + p[2] + ';--sw-line:' + p[3] + ';">' +
          '<span class="ds-sw"><span class="ds-sw-bar"></span><span class="ds-sw-card"></span></span>' +
          '<span class="ds-name">' + tName(th.name) + '</span>' +
          '<span class="ds-hint">' + tName(th.hint) + '</span>' +
        '</button>';
    }).join('');

    modal.innerHTML =
      '<div class="modal-overlay" id="dsOverlay">' +
        '<div class="modal" style="max-width:420px;padding:22px 18px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<h2 style="margin:0;">' + tt('הגדרות תצוגה', 'การตั้งค่าการแสดงผล', 'إعدادات العرض') + '</h2>' +
            '<button type="button" id="dsClose" aria-label="' + tt('סגור', 'ปิด', 'إغلاق') + '" style="background:var(--tonal);border:none;color:var(--text);width:34px;height:34px;border-radius:50%;font-size:1rem;cursor:pointer;">✕</button>' +
          '</div>' +
          '<div style="font-size:0.85rem;font-weight:600;color:var(--text);margin-bottom:10px;">' + tt('ערכת צבעים', 'ชุดสี', 'نظام الألوان') + '</div>' +
          '<div id="dsThemeList" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">' + cards + '</div>' +
          '<div style="text-align:center;margin-top:14px;font-size:0.72rem;color:var(--text-muted);">' +
            tt('הבחירה נשמרת במכשיר הזה', 'บันทึกไว้ในอุปกรณ์นี้', 'يُحفظ الاختيار على هذا الجهاز') +
          '</div>' +
        '</div>' +
      '</div>';

    function close() { modal.innerHTML = ''; }
    document.getElementById('dsClose').addEventListener('click', close);
    document.getElementById('dsOverlay').addEventListener('click', function(e) { if (e.target === this) close(); });

    document.querySelectorAll('#dsThemeList button[data-theme]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = this.getAttribute('data-theme');
        settings.theme = key;
        saveSettings(settings);
        applyTheme(key);
        showSettings(); // redraw so the panel picks up the new palette
      });
    });
  }

  // ── Reset ──
  function resetDefaults() {
    var fresh = { theme: DEFAULT_THEME };
    saveSettings(fresh);
    applyAll(fresh);
    showSettings();
    if (typeof showToast === 'function') showToast(tt('הוחזר לברירת המחדל', 'รีเซ็ตแล้ว', 'تمت إعادة التعيين'));
  }

  return {
    init: init,
    showSettings: showSettings,
    applyAll: applyAll,
    resetDefaults: resetDefaults,
    THEMES: THEMES,
  };
})();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', DisplaySettings.init);
} else {
  DisplaySettings.init();
}
