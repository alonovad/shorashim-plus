// ── DISPLAY SETTINGS MODULE ──
// Colour theme (three soft palettes) plus per-device fine-tuning: colour
// strength, hue, press effect, shadows, borders, text size.
// Persists to localStorage under 'shorashim-display-settings'.
//
// The palettes live in css/theme-soft.css as body classes; the fine-tuning
// is body classes (press/shadow/border/text) plus recomputed palette
// variables (strength/hue). The same switch runs earlier, from the inline
// bootstrap at the top of <body> in index.html, so everything is in place
// before first paint — keep THEME_CLASSES there in step with THEMES, and the
// tune classes in step with tuneClasses() below.

var DisplaySettings = (function() {
  'use strict';

  // ── Themes ──
  // cls: extra body class on top of .theme-soft. dark: enables the dark
  // adapter (theme-neon.css). meta: browser/status-bar colour.
  // preview: [page, primary, surface, line] for the picker swatch.
  var THEMES = {
    valleyMorning: {
      name: { he: 'בוקר בבקעה', th: 'เช้าในหุบเขา', ar: 'صباح الوادي' },
      hint: { he: 'בהיר · ירוק יער וליים', th: 'สว่าง · เขียวป่าและเขียวมะนาว', ar: 'فاتح · أخضر غابي وليموني' },
      cls: '', dark: false, meta: '#ffffff', metaClassic: '#f1f4ef',
      preview: ['#f8faf6', '#1d5a2c', '#ffffff', '#c5e663']
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
  // Layout: 'fresh' (v149 — home screen, bottom bar on phones, white/forest/
  // lime look) or 'classic' (the tab-bar layout and look before v148).
  // Body class layout-fresh / layout-classic; home.js and theme-soft.css key
  // off it. The inline bootstrap in index.html applies it before first paint.
  var LAYOUTS = ['fresh', 'classic'];
  var DEFAULT_LAYOUT = 'fresh';
  var THEME_CLASSES = ['soft-dark', 'soft-earth', 'theme-neon', 'theme-classic'];

  // ── Fine-tuning ──
  var TUNE_DEFAULTS = { sat: 1, hue: 0, press: 'soft', shadow: 'none', border: 'thin', text: 'md' };
  var TUNE_OPTIONS = {
    press:  ['none', 'soft', 'strong'],
    shadow: ['none', 'soft', 'strong'],
    border: ['none', 'thin', 'bold'],
    text:   ['sm', 'md', 'lg', 'xl']
  };
  // Palette variables recomputed by strength/hue. Neutral page/text tones
  // are left alone so text contrast never drifts.
  var TUNED_VARS = ['--primary', '--primary-dim', '--primary-soft', '--primary-faded',
    '--g1', '--g2', '--g3', '--g4', '--g5', '--g6', '--tonal', '--line', '--border', '--border-light',
    '--surface-input', '--bg', '--gradient-header', '--gradient-deep', '--accent', '--accent-light',
    '--water', '--card', '--surface-glass'];
  var VARS_CACHE_KEY = 'shorashim-display-vars';

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
  // the default; unknown keys are dropped on the next save.
  function cleanTune(t) {
    var out = {};
    t = t || {};
    var sat = Number(t.sat), hue = Number(t.hue);
    out.sat = (isFinite(sat) && sat >= 0.3 && sat <= 1.7) ? Math.round(sat * 100) / 100 : TUNE_DEFAULTS.sat;
    out.hue = (isFinite(hue) && hue >= -45 && hue <= 45) ? Math.round(hue) : TUNE_DEFAULTS.hue;
    Object.keys(TUNE_OPTIONS).forEach(function(k) {
      out[k] = TUNE_OPTIONS[k].indexOf(t[k]) !== -1 ? t[k] : TUNE_DEFAULTS[k];
    });
    return out;
  }

  function loadSettings() {
    var out = { theme: DEFAULT_THEME, tune: cleanTune(null), layout: DEFAULT_LAYOUT };
    try {
      var saved = JSON.parse(localStorage.getItem('shorashim-display-settings') || 'null');
      if (saved && THEMES[saved.theme]) out.theme = saved.theme;
      if (saved && saved.tune) out.tune = cleanTune(saved.tune);
      if (saved && LAYOUTS.indexOf(saved.layout) !== -1) out.layout = saved.layout;
    } catch (e) { console.warn('Failed to load display settings:', e); }
    return out;
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem('shorashim-display-settings',
        JSON.stringify({ theme: settings.theme, tune: cleanTune(settings.tune),
          layout: LAYOUTS.indexOf(settings.layout) !== -1 ? settings.layout : DEFAULT_LAYOUT }));
    } catch (e) { console.warn('Failed to save display settings:', e); }
  }

  // ── Colour maths (strength + hue) ──
  function parseColor(str) {
    str = String(str || '').trim();
    var m;
    if ((m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i))) {
      var h = m[1];
      if (h.length === 3) h = h.replace(/(.)/g, '$1$1');
      return { r: parseInt(h.substr(0, 2), 16), g: parseInt(h.substr(2, 2), 16), b: parseInt(h.substr(4, 2), 16), a: 1 };
    }
    if ((m = str.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i))) {
      return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
    }
    return null;
  }
  function toHsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }
  function fromHsl(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    var rgb = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return rgb.map(function(v) { return Math.round((v + m) * 255); });
  }
  function tuneColor(str, sat, hue) {
    var c = parseColor(str);
    if (!c) return null;
    var hsl = toHsl(c);
    // Most of the screen is pale surfaces whose saturation is near zero, so
    // scaling it alone changes almost nothing. Above 1, strength also adds
    // colour to those pale tones (more on the lightest ones); below 1 it
    // fades everything toward grey.
    var s2 = hsl.s * sat;
    if (sat > 1) s2 += (sat - 1) * (hsl.l > 0.75 ? 0.55 : 0.25);
    var rgb = fromHsl(hsl.h + hue, Math.max(0, Math.min(1, s2)), hsl.l);
    if (c.a < 1) return 'rgba(' + rgb.join(',') + ',' + c.a + ')';
    return '#' + rgb.map(function(v) { return ('0' + v.toString(16)).slice(-2); }).join('');
  }

  // Recompute the active palette's chromatic variables. Base values are read
  // from the stylesheet (inline overrides cleared first), so this works for
  // every theme without a second copy of the palettes.
  function applyColorTune(tune, themeKey) {
    var body = document.body;
    TUNED_VARS.forEach(function(v) { body.style.removeProperty(v); });
    var vars = {};
    if (tune.sat !== 1 || tune.hue !== 0) {
      var cs = getComputedStyle(body);
      TUNED_VARS.forEach(function(v) {
        var t2 = tuneColor(cs.getPropertyValue(v), tune.sat, tune.hue);
        if (t2) { vars[v] = t2; body.style.setProperty(v, t2); }
      });
    }
    try { localStorage.setItem(VARS_CACHE_KEY, JSON.stringify({ theme: themeKey, vars: vars })); } catch (e) {}
  }

  function tuneClasses(tune) {
    return ['press-' + tune.press, 'shadow-' + tune.shadow, 'border-' + tune.border, 'text-' + tune.text];
  }

  // ── Apply ──
  function applyTheme(themeKey, tune, layout) {
    var key = THEMES[themeKey] ? themeKey : DEFAULT_THEME;
    var theme = THEMES[key];
    var body = document.body;
    if (!body) return;
    var saved = loadSettings();
    tune = cleanTune(tune || saved.tune);
    if (LAYOUTS.indexOf(layout) === -1) layout = saved.layout;
    var wasFresh = body.classList.contains('layout-fresh');
    body.classList.remove('layout-fresh', 'layout-classic');
    body.classList.add('layout-' + layout);

    THEME_CLASSES.forEach(function(c) { body.classList.remove(c); });
    Array.prototype.slice.call(body.classList).forEach(function(c) {
      if (/^(press|shadow|border|text)-/.test(c)) body.classList.remove(c);
    });
    body.classList.add('theme-soft');
    if (theme.cls) body.classList.add(theme.cls);
    // Light themes keep the light stylesheet's classic hooks; the dark one
    // turns on the dark adapter and its body.theme-neon hooks in style.css.
    body.classList.add(theme.dark ? 'theme-neon' : 'theme-classic');
    tuneClasses(tune).forEach(function(c) { body.classList.add(c); });

    var darkCss = document.querySelector('link[href*="theme-neon"]');
    if (darkCss) darkCss.disabled = !theme.dark;

    // Inline overrides older builds wrote at runtime would beat the classes.
    body.style.background = '';
    var login = document.getElementById('loginScreen');
    if (login) login.style.background = '';

    applyColorTune(tune, key + ':' + layout);

    var metaC = (layout === 'classic' && theme.metaClassic) ? theme.metaClassic : theme.meta;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', (tune.sat !== 1 || tune.hue !== 0) ? (tuneColor(metaC, tune.sat, tune.hue) || metaC) : metaC);
    if (wasFresh !== (layout === 'fresh')) {
      try { document.dispatchEvent(new CustomEvent('shorashim:layout', { detail: { layout: layout } })); } catch (e) {}
    }
  }

  function applyAll(settings) {
    settings = settings || loadSettings();
    applyTheme(settings.theme, settings.tune, settings.layout);
  }

  function init() {
    applyAll(loadSettings());
  }

  // ── Settings UI ──
  // Built from the active theme's CSS variables, so the panel itself always
  // matches whatever is on screen. Every control applies live.
  function showSettings() {
    var settings = loadSettings();
    var tune = settings.tune;
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

    function seg(key, labels) {
      return '<div class="ds-seg" data-tune="' + key + '">' + TUNE_OPTIONS[key].map(function(v, i) {
        return '<button type="button" data-val="' + v + '" class="' + (tune[key] === v ? 'on' : '') + '">' + labels[i] + '</button>';
      }).join('') + '</div>';
    }
    function satLabel(v) {
      return v < 0.85 ? tt('רך', 'อ่อน', 'خافت') : v > 1.15 ? tt('עז', 'สด', 'زاهٍ') : tt('רגיל', 'ปกติ', 'عادي');
    }
    function hueLabel(v) {
      return v === 0 ? tt('מקורי', 'เดิม', 'أصلي') : (v > 0 ? '+' : '') + v + '°';
    }

    modal.innerHTML =
      '<div class="modal-overlay" id="dsOverlay">' +
        '<div class="modal" style="max-width:440px;padding:22px 18px;">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">' +
            '<h2 style="margin:0;">' + tt('הגדרות תצוגה', 'การตั้งค่าการแสดงผล', 'إعدادات العرض') + '</h2>' +
            '<button type="button" id="dsClose" aria-label="' + tt('סגור', 'ปิด', 'إغلاق') + '" style="background:var(--tonal);border:none;color:var(--text);width:34px;height:34px;border-radius:50%;font-size:1rem;cursor:pointer;">✕</button>' +
          '</div>' +
          '<div class="ds-lbl">' + tt('פריסה ועיצוב', 'รูปแบบหน้าจอ', 'التخطيط') + '</div>' +
          '<div class="ds-seg" id="dsLayout" style="margin-bottom:16px;">' +
            '<button type="button" data-layout="fresh" class="' + (settings.layout === 'fresh' ? 'on' : '') + '">✨ ' + tt('חדשה', 'ใหม่', 'جديد') + '</button>' +
            '<button type="button" data-layout="classic" class="' + (settings.layout === 'classic' ? 'on' : '') + '">' + tt('קלאסית', 'คลาสสิก', 'كلاسيكي') + '</button>' +
          '</div>' +
          '<div class="ds-lbl">' + tt('ערכת צבעים', 'ชุดสี', 'نظام الألوان') + '</div>' +
          '<div id="dsThemeList" style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">' + cards + '</div>' +

          '<div class="ds-sec"><div class="ds-lbl">' + tt('עוצמת צבע', 'ความเข้มของสี', 'شدة اللون') +
            '<span id="dsSatV">' + satLabel(tune.sat) + '</span></div>' +
            '<input type="range" class="ds-range" id="dsSat" min="0.3" max="1.7" step="0.05" value="' + tune.sat + '"></div>' +
          '<div class="ds-sec"><div class="ds-lbl">' + tt('גוון', 'โทนสี', 'درجة اللون') +
            '<span id="dsHueV">' + hueLabel(tune.hue) + '</span></div>' +
            '<input type="range" class="ds-range" id="dsHue" min="-45" max="45" step="1" value="' + tune.hue + '"></div>' +

          '<div class="ds-sec"><div class="ds-lbl">' + tt('אפקט לחיצה', 'เอฟเฟกต์การกด', 'تأثير الضغط') + '</div>' +
            seg('press', [tt('כבוי', 'ปิด', 'مطفأ'), tt('עדין', 'เบา', 'خفيف'), tt('בולט', 'ชัด', 'واضح')]) + '</div>' +
          '<div class="ds-sec"><div class="ds-lbl">' + tt('צלליות', 'เงา', 'الظلال') + '</div>' +
            seg('shadow', [tt('ללא', 'ไม่มี', 'بدون'), tt('עדינות', 'เบา', 'خفيفة'), tt('בולטות', 'ชัด', 'واضحة')]) + '</div>' +
          '<div class="ds-sec"><div class="ds-lbl">' + tt('מסגרות', 'กรอบ', 'الإطارات') + '</div>' +
            seg('border', [tt('ללא', 'ไม่มี', 'بدون'), tt('דקות', 'บาง', 'رفيعة'), tt('בולטות', 'หนา', 'بارزة')]) + '</div>' +
          '<div class="ds-sec"><div class="ds-lbl">' + tt('גודל טקסט', 'ขนาดตัวอักษร', 'حجم النص') + '</div>' +
            seg('text', [tt('קטן', 'เล็ก', 'صغير'), tt('רגיל', 'ปกติ', 'عادي'), tt('גדול', 'ใหญ่', 'كبير'), tt('ענק', 'ใหญ่มาก', 'كبير جدًا')]) + '</div>' +

          '<button type="button" class="ds-reset" id="dsReset">' + tt('איפוס להגדרות ברירת המחדל', 'รีเซ็ตเป็นค่าเริ่มต้น', 'إعادة التعيين للافتراضي') + '</button>' +
          '<div style="text-align:center;margin-top:12px;font-size:0.72rem;color:var(--text-muted);">' +
            tt('הבחירה נשמרת במכשיר הזה', 'บันทึกไว้ในอุปกรณ์นี้', 'يُحفظ الاختيار على هذا الجهاز') +
          '</div>' +
        '</div>' +
      '</div>';

    function close() { modal.innerHTML = ''; }
    function commit(redraw) {
      saveSettings(settings);
      applyTheme(settings.theme, settings.tune, settings.layout);
      if (redraw) showSettings();
    }
    document.getElementById('dsClose').addEventListener('click', close);
    document.getElementById('dsOverlay').addEventListener('click', function(e) { if (e.target === this) close(); });

    document.querySelectorAll('#dsLayout button[data-layout]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        settings.layout = this.getAttribute('data-layout');
        commit(true);
      });
    });

    document.querySelectorAll('#dsThemeList button[data-theme]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        settings.theme = this.getAttribute('data-theme');
        commit(true); // redraw so the panel picks up the new palette
      });
    });

    var sat = document.getElementById('dsSat'), hue = document.getElementById('dsHue');
    sat.addEventListener('input', function() {
      settings.tune.sat = Number(this.value);
      document.getElementById('dsSatV').textContent = satLabel(settings.tune.sat);
      commit(false);
    });
    hue.addEventListener('input', function() {
      settings.tune.hue = Number(this.value);
      document.getElementById('dsHueV').textContent = hueLabel(settings.tune.hue);
      commit(false);
    });

    document.querySelectorAll('.ds-seg[data-tune] button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = this.parentNode.getAttribute('data-tune');
        settings.tune[key] = this.getAttribute('data-val');
        this.parentNode.querySelectorAll('button').forEach(function(b) { b.classList.remove('on'); });
        this.classList.add('on');
        commit(false);
      });
    });

    document.getElementById('dsReset').addEventListener('click', resetDefaults);
  }

  // ── Reset ──
  function resetDefaults() {
    var fresh = { theme: DEFAULT_THEME, tune: cleanTune(null), layout: DEFAULT_LAYOUT };
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
    layout: function() { return loadSettings().layout; },
    setLayout: function(l) { var st = loadSettings(); st.layout = l; saveSettings(st); applyAll(st); }
  };
})();

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', DisplaySettings.init);
} else {
  DisplaySettings.init();
}
