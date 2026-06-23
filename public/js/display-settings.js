// ── DISPLAY SETTINGS MODULE ──
// Lets users customize theme, colors, effects, and display preferences
// Persists to localStorage, applies on load

var DisplaySettings = (function() {
  'use strict';

  // ── Predefined Themes ──
  var THEMES = {
    neonForest: {
      name: { he: '🌿 יער ניאון', th: '🌿 ป่านีออน', ar: '🌿 غابة نيون' },
      vars: {
        '--g1': '#0d2818', '--g2': '#39ff14', '--g3': '#2bc410', '--g4': '#39ff14',
        '--primary': '#39ff14', '--primary-dim': '#2bc410',
        '--primary-faded': 'rgba(57,255,20,0.12)', '--primary-glow': 'rgba(57,255,20,0.3)',
        '--primary-glow-sm': 'rgba(57,255,20,0.15)',
        '--accent': '#ff9f43', '--accent-light': 'rgba(255,159,67,0.12)',
        '--danger': '#ff4757', '--water': '#4fc3f7',
        '--text': '#e8ffe8', '--text-muted': 'rgba(255,255,255,0.45)',
        '--border': 'rgba(255,255,255,0.08)', '--border-light': 'rgba(255,255,255,0.04)',
        '--surface-glass': 'rgba(255,255,255,0.07)', '--surface-input': 'rgba(255,255,255,0.05)',
        '--gradient-deep': 'radial-gradient(ellipse at 50% 0%, #0d2818 0%, #071510 40%, #030a07 100%)',
        '--orb1': '#39ff14', '--orb2': '#00e676',
        '--leaf-color': '#39ff14', '--spark-color': '#76ff03',
      },
      dark: true
    },
    emeraldGlow: {
      name: { he: '💎 ברקת זוהרת', th: '💎 มรกตเรืองแสง', ar: '💎 توهج زمردي' },
      vars: {
        '--g1': '#0a3d2a', '--g2': '#0fffaa', '--g3': '#0bc87e', '--g4': '#0fffaa',
        '--primary': '#0fffaa', '--primary-dim': '#0bc87e',
        '--primary-faded': 'rgba(15,255,170,0.12)', '--primary-glow': 'rgba(15,255,170,0.3)',
        '--primary-glow-sm': 'rgba(15,255,170,0.15)',
        '--accent': '#ffc857', '--accent-light': 'rgba(255,200,87,0.12)',
        '--danger': '#ff5c5c', '--water': '#4fc3f7',
        '--text': '#f0faf5', '--text-muted': 'rgba(255,255,255,0.5)',
        '--border': 'rgba(255,255,255,0.1)', '--border-light': 'rgba(255,255,255,0.06)',
        '--surface-glass': 'rgba(255,255,255,0.07)', '--surface-input': 'rgba(255,255,255,0.06)',
        '--gradient-deep': 'radial-gradient(ellipse at 20% 50%, #0a3d2a 0%, #061f16 40%, #020d09 100%)',
        '--orb1': '#0fffaa', '--orb2': '#00b874',
        '--leaf-color': '#0fffaa', '--spark-color': '#0fffaa',
      },
      dark: true
    },
    goldenHour: {
      name: { he: '🌅 שעת הזהב', th: '🌅 ชั่วโมงทอง', ar: '🌅 الساعة الذهبية' },
      vars: {
        '--g1': '#3d2a0a', '--g2': '#ffb347', '--g3': '#d4933a', '--g4': '#ffb347',
        '--primary': '#ffb347', '--primary-dim': '#d4933a',
        '--primary-faded': 'rgba(255,179,71,0.12)', '--primary-glow': 'rgba(255,179,71,0.35)',
        '--primary-glow-sm': 'rgba(255,179,71,0.15)',
        '--accent': '#4aeadc', '--accent-light': 'rgba(74,234,220,0.12)',
        '--danger': '#ff5c5c', '--water': '#4aeadc',
        '--text': '#fff8f0', '--text-muted': 'rgba(255,255,255,0.5)',
        '--border': 'rgba(255,255,255,0.1)', '--border-light': 'rgba(255,255,255,0.06)',
        '--surface-glass': 'rgba(255,255,255,0.07)', '--surface-input': 'rgba(255,255,255,0.06)',
        '--gradient-deep': 'radial-gradient(ellipse at 70% 30%, #3d2a0a 0%, #1a1005 40%, #0d0a04 100%)',
        '--orb1': '#ffb347', '--orb2': '#ff6b35',
        '--leaf-color': '#ffb347', '--spark-color': '#ffc857',
      },
      dark: true
    },
    deepOcean: {
      name: { he: '🌊 אוקיינוס עמוק', th: '🌊 มหาสมุทรลึก', ar: '🌊 المحيط العميق' },
      vars: {
        '--g1': '#0a1a3d', '--g2': '#4fc3f7', '--g3': '#3a9fd4', '--g4': '#4fc3f7',
        '--primary': '#4fc3f7', '--primary-dim': '#3a9fd4',
        '--primary-faded': 'rgba(79,195,247,0.12)', '--primary-glow': 'rgba(79,195,247,0.3)',
        '--primary-glow-sm': 'rgba(79,195,247,0.15)',
        '--accent': '#a8e06c', '--accent-light': 'rgba(168,224,108,0.12)',
        '--danger': '#ff6b6b', '--water': '#4fc3f7',
        '--text': '#f0f8ff', '--text-muted': 'rgba(255,255,255,0.5)',
        '--border': 'rgba(255,255,255,0.1)', '--border-light': 'rgba(255,255,255,0.06)',
        '--surface-glass': 'rgba(255,255,255,0.07)', '--surface-input': 'rgba(255,255,255,0.06)',
        '--gradient-deep': 'radial-gradient(ellipse at 30% 70%, #0a1a3d 0%, #060f20 40%, #020509 100%)',
        '--orb1': '#4fc3f7', '--orb2': '#0288d1',
        '--leaf-color': '#4fc3f7', '--spark-color': '#80d8ff',
      },
      dark: true
    },
    aravaNight: {
      name: { he: '🌙 לילות ערבה', th: '🌙 คืนอาราวา', ar: '🌙 ليالي عربة' },
      vars: {
        '--g1': '#2d2b55', '--g2': '#E8B04A', '--g3': '#4A46A0', '--g4': '#E8B04A',
        '--primary': '#a78bfa', '--primary-dim': '#7c5cc4',
        '--primary-faded': 'rgba(167,139,250,0.12)', '--primary-glow': 'rgba(167,139,250,0.3)',
        '--primary-glow-sm': 'rgba(167,139,250,0.15)',
        '--accent': '#E8B04A', '--accent-light': 'rgba(232,176,74,0.12)',
        '--danger': '#D94452', '--water': '#7dd3fc',
        '--text': '#f5f4f7', '--text-muted': 'rgba(255,255,255,0.45)',
        '--border': 'rgba(255,255,255,0.08)', '--border-light': 'rgba(255,255,255,0.04)',
        '--surface-glass': 'rgba(255,255,255,0.06)', '--surface-input': 'rgba(255,255,255,0.05)',
        '--gradient-deep': 'radial-gradient(ellipse at 50% 0%, #1C1C30 0%, #12121f 40%, #0C0C14 100%)',
        '--orb1': '#a78bfa', '--orb2': '#E8B04A',
        '--leaf-color': '#a78bfa', '--spark-color': '#c4b5fd',
      },
      dark: true
    },
  };

  // ── Defaults ──
  var DEFAULTS = {
    theme: 'neonForest',
    effects: {
      orbs: true,
      sparkles: true,
      leaves: true,
      botanicals: true,
      buttonBurst: true,
    },
    glowIntensity: 'normal', // 'off', 'subtle', 'normal', 'intense'
    cardBlur: 18,
  };

  // ── Translation helper ──
  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function tName(nameObj) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    return nameObj[lang] || nameObj.he;
  }

  // ── Storage ──
  function loadSettings() {
    try {
      var saved = localStorage.getItem('shorashim-display-settings');
      if (saved) {
        var parsed = JSON.parse(saved);
        // Merge with defaults to fill any missing keys
        return mergeDeep(JSON.parse(JSON.stringify(DEFAULTS)), parsed);
      }
    } catch (e) { console.warn('Failed to load display settings:', e); }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  function saveSettings(settings) {
    try {
      localStorage.setItem('shorashim-display-settings', JSON.stringify(settings));
    } catch (e) { console.warn('Failed to save display settings:', e); }
  }

  function mergeDeep(target, source) {
    for (var key in source) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        mergeDeep(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
    return target;
  }

  // ── Apply Theme ──
  function applyTheme(themeKey) {
    var theme = THEMES[themeKey];
    if (!theme) return;

    var root = document.documentElement;
    var vars = theme.vars;
    for (var prop in vars) {
      root.style.setProperty(prop, vars[prop]);
    }

    // Apply background gradient
    document.body.style.background = vars['--gradient-deep'];

    // Update orb colors if effects.js is loaded
    var orbs = document.querySelectorAll('.bg-orb--1, .bg-orb--3');
    orbs.forEach(function(o) { o.style.background = vars['--orb1']; });
    var orbs2 = document.querySelectorAll('.bg-orb--2');
    orbs2.forEach(function(o) { o.style.background = vars['--orb2']; });

    // Update sparkle colors
    document.querySelectorAll('.sparkle-layer > div').forEach(function(s) {
      s.style.background = vars['--spark-color'];
      s.style.boxShadow = '0 0 ' + (parseInt(s.style.width) * 2 || 6) + 'px ' + vars['--spark-color'];
    });

    // Update falling leaf colors
    document.querySelectorAll('.falling-leaves-layer svg path').forEach(function(p) {
      p.setAttribute('fill', vars['--leaf-color']);
    });
    document.querySelectorAll('.falling-leaves-layer svg line, .falling-leaves-layer svg path[stroke]').forEach(function(p) {
      if (p.getAttribute('stroke')) p.setAttribute('stroke', vars['--leaf-color']);
    });

    // Update meta theme-color
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', vars['--g1']);

    // Update login screen if visible
    var loginBg = document.getElementById('loginScreen');
    if (loginBg) loginBg.style.background = vars['--gradient-deep'];
  }

  // ── Apply Effects ──
  function applyEffects(effects) {
    var layers = {
      orbs: '.bg-layer .bg-orb',
      sparkles: '.sparkle-layer',
      leaves: '.falling-leaves-layer',
      botanicals: '.botanical',
    };

    for (var key in layers) {
      var els = document.querySelectorAll(layers[key]);
      var visible = effects[key] !== false;
      els.forEach(function(el) {
        el.style.display = visible ? '' : 'none';
      });
    }
  }

  // ── Apply Glow Intensity ──
  function applyGlow(intensity) {
    var root = document.documentElement;
    switch (intensity) {
      case 'off':
        root.style.setProperty('--primary-glow', 'transparent');
        root.style.setProperty('--primary-glow-sm', 'transparent');
        break;
      case 'subtle':
        // Half the normal glow
        root.style.setProperty('--primary-glow', root.style.getPropertyValue('--primary-glow').replace(/[\d.]+\)$/, '0.15)'));
        root.style.setProperty('--primary-glow-sm', root.style.getPropertyValue('--primary-glow-sm').replace(/[\d.]+\)$/, '0.08)'));
        break;
      case 'intense':
        root.style.setProperty('--primary-glow', root.style.getPropertyValue('--primary-glow').replace(/[\d.]+\)$/, '0.5)'));
        root.style.setProperty('--primary-glow-sm', root.style.getPropertyValue('--primary-glow-sm').replace(/[\d.]+\)$/, '0.3)'));
        break;
      default: break; // 'normal' uses the theme defaults
    }
  }

  // ── Apply All Settings ──
  function applyAll(settings) {
    if (!settings) settings = loadSettings();
    applyTheme(settings.theme);
    applyEffects(settings.effects);
    applyGlow(settings.glowIntensity);
  }

  // ── Initialize on Load ──
  function init() {
    var settings = loadSettings();
    // Small delay to let effects.js inject its elements first
    setTimeout(function() { applyAll(settings); }, 100);
  }

  // ── Settings UI ──
  function showSettings() {
    var settings = loadSettings();
    var modal = document.getElementById('modalContainer');
    if (!modal) return;

    var themeButtons = '';
    Object.keys(THEMES).forEach(function(key) {
      var theme = THEMES[key];
      var isActive = settings.theme === key;
      var primaryColor = theme.vars['--primary'];
      themeButtons += '<button data-theme="' + key + '" style="' +
        'display:flex;align-items:center;gap:10px;width:100%;padding:12px 14px;' +
        'border-radius:12px;border:1.5px solid ' + (isActive ? primaryColor : 'var(--border)') + ';' +
        'background:' + (isActive ? 'var(--primary-faded)' : 'rgba(255,255,255,0.03)') + ';' +
        'color:var(--text);cursor:pointer;font-family:inherit;font-size:0.9rem;' +
        'margin-bottom:6px;text-align:right;transition:all 0.2s;' +
        (isActive ? 'box-shadow:0 0 12px ' + primaryColor + '33;' : '') +
        '">' +
        '<span style="width:20px;height:20px;border-radius:50%;background:' + primaryColor + ';' +
        'box-shadow:0 0 8px ' + primaryColor + '55;flex-shrink:0;"></span>' +
        '<span style="flex:1;">' + tName(theme.name) + '</span>' +
        (isActive ? '<span style="color:' + primaryColor + ';">✓</span>' : '') +
        '</button>';
    });

    function toggle(key) {
      return '<label style="display:flex;align-items:center;justify-content:space-between;' +
        'padding:10px 14px;border-radius:10px;background:rgba(255,255,255,0.03);' +
        'border:1px solid var(--border);margin-bottom:6px;cursor:pointer;">' +
        '<span style="color:var(--text);font-size:0.88rem;">' + key.label + '</span>' +
        '<input type="checkbox" data-effect="' + key.id + '" ' + (settings.effects[key.id] !== false ? 'checked' : '') +
        ' style="width:20px;height:20px;accent-color:var(--primary);cursor:pointer;">' +
        '</label>';
    }

    var effectToggles = [
      { id: 'orbs', label: tt('🔮 כדורי אור ברקע', '🔮 ลูกแสงพื้นหลัง', '🔮 كرات ضوء الخلفية') },
      { id: 'sparkles', label: tt('✨ ניצוצות', '✨ ประกาย', '✨ شرارات') },
      { id: 'leaves', label: tt('🍃 עלים נופלים', '🍃 ใบไม้ร่วง', '🍃 أوراق متساقطة') },
      { id: 'botanicals', label: tt('🌿 עיטורי צמחים', '🌿 ลวดลายพฤกษศาสตร์', '🌿 زخارف نباتية') },
      { id: 'buttonBurst', label: tt('💥 אפקט לחיצה', '💥 เอฟเฟกต์กดปุ่ม', '💥 تأثير الضغط') },
    ].map(toggle).join('');

    var glowOptions = '';
    ['off', 'subtle', 'normal', 'intense'].forEach(function(level) {
      var labels = {
        off: tt('כבוי', 'ปิด', 'مغلق'),
        subtle: tt('עדין', 'เบา', 'خفيف'),
        normal: tt('רגיל', 'ปกติ', 'عادي'),
        intense: tt('חזק', 'เข้มข้น', 'مكثف'),
      };
      var isActive = settings.glowIntensity === level;
      glowOptions += '<button data-glow="' + level + '" style="' +
        'flex:1;padding:8px 4px;border-radius:8px;font-family:inherit;font-size:0.8rem;cursor:pointer;' +
        'border:1px solid ' + (isActive ? 'var(--primary)' : 'var(--border)') + ';' +
        'background:' + (isActive ? 'var(--primary-faded)' : 'rgba(255,255,255,0.03)') + ';' +
        'color:' + (isActive ? 'var(--primary)' : 'var(--text-muted)') + ';' +
        'font-weight:' + (isActive ? '700' : '400') + ';' +
        '">' + labels[level] + '</button>';
    });

    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(3,10,7,0.7);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:99999;display:flex;align-items:center;justify-content:center;" onclick="if(event.target===this)document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
      '<div style="background:rgba(15,25,18,0.95);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px 20px;width:92%;max-width:440px;max-height:85vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,0.5);color:var(--text);">' +

        // Header
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">' +
          '<h3 style="font-weight:700;font-size:1.1rem;color:var(--primary);margin:0;">🎨 ' + tt('הגדרות תצוגה', 'การตั้งค่าการแสดงผล', 'إعدادات العرض') + '</h3>' +
          '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="background:none;border:none;color:var(--text-muted);font-size:1.3rem;cursor:pointer;padding:4px;">✕</button>' +
        '</div>' +

        // Theme section
        '<div style="margin-bottom:20px;">' +
          '<div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">' + tt('ערכת נושא', 'ธีม', 'السمة') + '</div>' +
          '<div id="dsThemeList">' + themeButtons + '</div>' +
        '</div>' +

        // Effects section
        '<div style="margin-bottom:20px;">' +
          '<div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">' + tt('אפקטים', 'เอฟเฟกต์', 'التأثيرات') + '</div>' +
          '<div id="dsEffects">' + effectToggles + '</div>' +
        '</div>' +

        // Glow section
        '<div style="margin-bottom:20px;">' +
          '<div style="font-size:0.75rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:1.5px;margin-bottom:8px;">' + tt('עוצמת זוהר', 'ความเข้มของแสง', 'شدة التوهج') + '</div>' +
          '<div id="dsGlow" style="display:flex;gap:6px;">' + glowOptions + '</div>' +
        '</div>' +

        // Reset button
        '<button onclick="DisplaySettings.resetDefaults()" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,0.03);color:var(--text-muted);font-family:inherit;font-size:0.85rem;cursor:pointer;margin-top:4px;">' +
          '🔄 ' + tt('איפוס לברירת מחדל', 'รีเซ็ตเป็นค่าเริ่มต้น', 'إعادة تعيين') +
        '</button>' +

        '<div style="text-align:center;margin-top:12px;font-size:0.7rem;color:var(--text-muted);">' +
          tt('השינויים נשמרים אוטומטית', 'บันทึกอัตโนมัติ', 'يتم الحفظ تلقائيًا') +
        '</div>' +

      '</div></div>';

    // ── Event listeners ──

    // Theme buttons
    document.querySelectorAll('#dsThemeList button[data-theme]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = this.getAttribute('data-theme');
        settings.theme = key;
        saveSettings(settings);
        applyTheme(key);
        // Refresh the panel to show new active state
        setTimeout(function() { showSettings(); }, 50);
      });
    });

    // Effect toggles
    document.querySelectorAll('#dsEffects input[data-effect]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var key = this.getAttribute('data-effect');
        settings.effects[key] = this.checked;
        saveSettings(settings);
        applyEffects(settings.effects);
      });
    });

    // Glow buttons
    document.querySelectorAll('#dsGlow button[data-glow]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        settings.glowIntensity = this.getAttribute('data-glow');
        saveSettings(settings);
        applyTheme(settings.theme); // reapply base first
        applyGlow(settings.glowIntensity);
        // Refresh panel
        setTimeout(function() { showSettings(); }, 50);
      });
    });
  }

  // ── Reset ──
  function resetDefaults() {
    var fresh = JSON.parse(JSON.stringify(DEFAULTS));
    saveSettings(fresh);
    applyAll(fresh);
    showSettings(); // refresh UI
    if (typeof showToast === 'function') showToast('🔄 ' + tt('הוחזר לברירת מחדל', 'รีเซ็ตแล้ว', 'تمت إعادة التعيين'));
  }

  // ── Public API ──
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
