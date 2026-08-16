/* map-filter.js — control which plots are drawn on the map
 * ---------------------------------------------------------
 * Access control decides what you MAY see; this decides what you WANT to
 * see. An admin with every plot in the valley doesn't need all of them on
 * screen at once. The filter narrows within getAccessiblePlots() and can
 * never widen beyond it — hiding is a view preference, not a permission.
 *
 * Kept in localStorage rather than Firestore on purpose: this is a per-device
 * view setting. Syncing it would mean changing the view on your phone
 * silently rearranges the office screen mid-conversation.
 *
 * Layers are rebuilt from scratch whenever data reloads, which wipes any
 * filtering, so this re-applies itself on shorashim:plots-rendered.
 */
var MapFilter = (function () {
  'use strict';

  var KEY = 'shorashim-map-filter';
  var st = { farms: {}, crops: {}, text: '' };
  var open = false;
  var built = false;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (raw) {
        var p = JSON.parse(raw);
        st.farms = p.farms || {};
        st.crops = p.crops || {};
        st.text = p.text || '';
      }
    } catch (e) { /* corrupt prefs are not worth failing the map over */ }
  }

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(st)); } catch (e) {}
  }

  function pool() {
    return (typeof window.getVisiblePlotPool === 'function')
      ? window.getVisiblePlotPool() : [];
  }

  function farmList() {
    return (window.SprayStore && window.SprayStore.getFarms)
      ? window.SprayStore.getFarms() : [];
  }

  function cropList() {
    var seen = {};
    pool().forEach(function (p) { if (p.crop_type) seen[p.crop_type] = true; });
    return Object.keys(seen).sort();
  }

  function anyFarm() { return Object.keys(st.farms).some(function (k) { return st.farms[k]; }); }
  function anyCrop() { return Object.keys(st.crops).some(function (k) { return st.crops[k]; }); }

  function activeCount() {
    var n = 0;
    if (anyFarm()) n++;
    if (anyCrop()) n++;
    if (st.text.trim()) n++;
    return n;
  }

  function passes(p) {
    if (anyFarm() && !st.farms[p.farm_id]) return false;
    if (anyCrop() && !st.crops[p.crop_type]) return false;
    var q = st.text.trim().toLowerCase();
    if (q && String(p.name || '').toLowerCase().indexOf(q) === -1) return false;
    return true;
  }

  // ── apply to the map ──
  function apply() {
    if (typeof window.setPlotVisibility !== 'function') return { shown: 0, total: 0 };
    var list = pool();
    var shown = 0;
    list.forEach(function (p) {
      var on = passes(p);
      window.setPlotVisibility(p.id, on);
      if (on && p.hasGeometry) shown++;
    });
    persist();
    return { shown: shown, total: list.length };
  }

  // Called before jumping to a plot — a hidden target would frame bare ground.
  function reveal(plotId) {
    var p = pool().find(function (x) { return x.id === plotId; });
    if (!p || passes(p)) return;
    if (anyFarm() && p.farm_id) st.farms[p.farm_id] = true;
    if (anyCrop() && p.crop_type) st.crops[p.crop_type] = true;
    if (st.text.trim() && String(p.name || '').toLowerCase()
        .indexOf(st.text.trim().toLowerCase()) === -1) {
      st.text = '';
    }
    apply();
    render();
    if (typeof showToast === 'function') {
      showToast('👁 ' + tt('הסינון הורחב כדי להציג את החלקה',
                          'ขยายตัวกรองเพื่อแสดงแปลงนี้',
                          'وُسّعت التصفية لعرض هذه القطعة'));
    }
  }

  // ── UI ──
  function build() {
    if (built) return;
    if (!document.body) return;

    // Appended to body with position:fixed, matching .fab-farms. #tabMap has
    // no positioning context of its own, so an absolutely-positioned child
    // would anchor to whatever ancestor happens to be positioned.
    var btn = document.createElement('button');
    btn.id = 'mfBtn';
    btn.className = 'mf-btn';
    btn.type = 'button';
    btn.addEventListener('click', toggle);
    document.body.appendChild(btn);

    var panel = document.createElement('div');
    panel.id = 'mfPanel';
    panel.className = 'mf-panel';
    document.body.appendChild(panel);

    built = true;
    syncTabVisibility();
    // Body-level fixed elements would otherwise float over every tab.
    document.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.tab')) {
        setTimeout(syncTabVisibility, 0);
      }
    });
  }

  function onMapTab() {
    var pane = document.getElementById('tabMap');
    return !!(pane && pane.classList.contains('active'));
  }

  function syncTabVisibility() {
    var btn = document.getElementById('mfBtn');
    var panel = document.getElementById('mfPanel');
    if (!btn || !panel) return;
    var on = onMapTab();
    btn.style.display = on ? '' : 'none';
    if (!on) { open = false; panel.style.display = 'none'; }
  }

  function render() {
    var btn = document.getElementById('mfBtn');
    var panel = document.getElementById('mfPanel');
    if (!btn || !panel) return;

    var n = activeCount();
    btn.innerHTML = '🔎 <span>' + tt('סינון מפה', 'ตัวกรองแผนที่', 'تصفية الخريطة') + '</span>' +
      (n ? '<span class="mf-badge">' + n + '</span>' : '');
    btn.classList.toggle('mf-active', n > 0);

    if (!open || !onMapTab()) { panel.style.display = 'none'; return; }
    panel.style.display = '';

    var farms = farmList();
    var crops = cropList();
    var plots = pool();

    var farmHtml = farms.map(function (fa) {
      var count = plots.filter(function (p) { return p.farm_id === fa.id; }).length;
      if (!count) return '';
      return '<label class="mf-row"><input type="checkbox" class="mf-farm" data-id="' + fa.id + '"' +
        (st.farms[fa.id] ? ' checked' : '') + '> <span>🌳 ' + esc(fa.name) + '</span>' +
        '<span class="mf-count">' + count + '</span></label>';
    }).join('');

    var orphan = plots.filter(function (p) { return !p.farm_id; }).length;
    if (orphan) {
      farmHtml += '<label class="mf-row"><input type="checkbox" class="mf-farm" data-id="0"' +
        (st.farms[0] ? ' checked' : '') + '> <span>' +
        tt('ללא מטע', 'ไม่มีสวน', 'بدون بستان') + '</span>' +
        '<span class="mf-count">' + orphan + '</span></label>';
    }

    var cropHtml = crops.map(function (c) {
      var count = plots.filter(function (p) { return p.crop_type === c; }).length;
      return '<label class="mf-row"><input type="checkbox" class="mf-crop" data-id="' + esc(c) + '"' +
        (st.crops[c] ? ' checked' : '') + '> <span>🌱 ' + esc(c) + '</span>' +
        '<span class="mf-count">' + count + '</span></label>';
    }).join('');

    var res = { shown: plots.filter(passes).length, total: plots.length };

    panel.innerHTML =
      '<div class="mf-head">' +
        '<span>' + tt('מציג', 'แสดง', 'يعرض') + ' ' + res.shown + ' / ' + res.total + '</span>' +
        '<button type="button" class="mf-close" onclick="MapFilter.toggle()">✕</button>' +
      '</div>' +
      '<input type="text" id="mfText" class="mf-input" value="' + esc(st.text) + '" placeholder="' +
        esc(tt('חיפוש חלקה…', 'ค้นหาแปลง…', 'بحث قطعة…')) + '">' +
      (farmHtml ? '<div class="mf-label">' + tt('מטעים', 'สวน', 'البساتين') + '</div>' +
        '<div class="mf-list">' + farmHtml + '</div>' : '') +
      (cropHtml ? '<div class="mf-label">' + tt('גידולים', 'พืช', 'المحاصيل') + '</div>' +
        '<div class="mf-list">' + cropHtml + '</div>' : '') +
      '<button type="button" class="mf-clear" onclick="MapFilter.clear()">' +
        tt('הצג הכל', 'แสดงทั้งหมด', 'عرض الكل') + '</button>';

    panel.querySelectorAll('.mf-farm').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(this.getAttribute('data-id'), 10);
        if (this.checked) st.farms[id] = true; else delete st.farms[id];
        apply(); render();
      });
    });
    panel.querySelectorAll('.mf-crop').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = this.getAttribute('data-id');
        if (this.checked) st.crops[id] = true; else delete st.crops[id];
        apply(); render();
      });
    });
    var txt = document.getElementById('mfText');
    if (txt) {
      txt.addEventListener('input', function () {
        st.text = this.value;
        apply();
        var h = document.querySelector('#mfPanel .mf-head span');
        if (h) {
          h.textContent = tt('מציג', 'แสดง', 'يعرض') + ' ' +
            pool().filter(passes).length + ' / ' + pool().length;
        }
        var b = document.getElementById('mfBtn');
        if (b) b.classList.toggle('mf-active', activeCount() > 0);
      });
    }
  }

  function toggle() { open = !open; syncTabVisibility(); render(); }

  function clear() {
    st = { farms: {}, crops: {}, text: '' };
    apply();
    render();
  }

  // ── lifecycle ──
  document.addEventListener('shorashim:plots-rendered', function () {
    build();
    apply();
    render();
  });

  function init() {
    load();
    build();
    // Layers may not exist yet on a cold start; the event above covers that.
    setTimeout(function () { apply(); render(); }, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return { apply: apply, toggle: toggle, clear: clear, reveal: reveal, passes: passes };
})();
window.MapFilter = MapFilter;
