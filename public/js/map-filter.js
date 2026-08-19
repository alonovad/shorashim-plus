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
  var st = { farms: {}, crops: {}, text: '', hidden: {}, open: {} };
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
        // A HIDE list, not a show list: a plot is visible unless it is in
        // here. That way a newly drawn plot appears on the map immediately
        // instead of being invisible until someone finds this panel.
        st.hidden = p.hidden || {};
        st.open = p.open || {};
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

  function hiddenCount() {
    return pool().filter(function (p) { return st.hidden[p.id]; }).length;
  }

  function plotsOfFarm(fid) {
    // Largest first: the enclosing block a grower wants to hide in order to
    // reach the sub-plots underneath it is, by definition, the big one.
    return pool().filter(function (p) { return (p.farm_id || 0) === (fid || 0); })
      .sort(function (a, b) { return (b.area || 0) - (a.area || 0); });
  }

  function anyFarm() { return Object.keys(st.farms).some(function (k) { return st.farms[k]; }); }
  function anyCrop() { return Object.keys(st.crops).some(function (k) { return st.crops[k]; }); }

  function activeCount() {
    var n = 0;
    if (anyFarm()) n++;
    if (anyCrop()) n++;
    if (st.text.trim()) n++;
    if (hiddenCount()) n++;
    return n;
  }

  function passes(p) {
    // An individually hidden plot loses to every other rule. This is how the
    // overlap problem is solved: hide the big enclosing block and the small
    // plots inside it become clickable on the map.
    if (st.hidden[p.id]) return false;
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
    if (st.hidden[p.id]) delete st.hidden[p.id];
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

    function farmGroup(fid, label) {
      var mine = plotsOfFarm(fid);
      if (!mine.length) return '';
      var hidden = mine.filter(function (p) { return st.hidden[p.id]; }).length;
      var isOpen = !!st.open[fid];
      var h = '<div class="mf-group">';
      h += '<div class="mf-row mf-farm-row">' +
        '<button type="button" class="mf-caret' + (isOpen ? ' open' : '') +
          '" data-farm-toggle="' + fid + '" aria-expanded="' + isOpen + '" title="' +
          esc(tt('תת-חלקות', 'แปลงย่อย', 'قطع فرعية')) + '">▸</button>' +
        '<label class="mf-farm-label"><input type="checkbox" class="mf-farm" data-id="' + fid + '"' +
          (st.farms[fid] ? ' checked' : '') + '> <span>' + label + '</span></label>' +
        '<span class="mf-count">' + (hidden ? (mine.length - hidden) + '/' + mine.length : mine.length) + '</span>' +
        '</div>';
      if (isOpen) {
        h += '<div class="mf-sublist">';
        h += '<div class="mf-subactions">' +
          '<button type="button" data-farm-all="' + fid + '">' +
            tt('הצג הכל', 'ทั้งหมด', 'الكل') + '</button>' +
          '<button type="button" data-farm-none="' + fid + '">' +
            tt('הסתר הכל', 'ซ่อนทั้งหมด', 'إخفاء الكل') + '</button>' +
          '</div>';
        mine.forEach(function (p) {
          h += '<label class="mf-row mf-subrow"><input type="checkbox" class="mf-plot" data-id="' + p.id + '"' +
            (st.hidden[p.id] ? '' : ' checked') + '> <span>' + esc(p.name || '') + '</span>' +
            '<span class="mf-count">' + (p.area ? (Math.round(p.area * 10) / 10) : '') + '</span></label>';
        });
        h += '</div>';
      }
      return h + '</div>';
    }

    var farmHtml = farms.map(function (fa) {
      return farmGroup(fa.id, '🌳 ' + esc(fa.name));
    }).join('');
    farmHtml += farmGroup(0, tt('ללא מטע', 'ไม่มีสวน', 'بدون بستان'));

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
    panel.querySelectorAll('[data-farm-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        var fid = parseInt(b.getAttribute('data-farm-toggle'), 10) || 0;
        if (st.open[fid]) delete st.open[fid]; else st.open[fid] = true;
        persist(); render();
      });
    });
    panel.querySelectorAll('.mf-plot').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = parseInt(this.getAttribute('data-id'), 10);
        if (this.checked) delete st.hidden[id]; else st.hidden[id] = true;
        apply(); render();
      });
    });
    panel.querySelectorAll('[data-farm-all]').forEach(function (b) {
      b.addEventListener('click', function () {
        var fid = parseInt(b.getAttribute('data-farm-all'), 10) || 0;
        plotsOfFarm(fid).forEach(function (p) { delete st.hidden[p.id]; });
        apply(); render();
      });
    });
    panel.querySelectorAll('[data-farm-none]').forEach(function (b) {
      b.addEventListener('click', function () {
        var fid = parseInt(b.getAttribute('data-farm-none'), 10) || 0;
        plotsOfFarm(fid).forEach(function (p) { st.hidden[p.id] = true; });
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
    st = { farms: {}, crops: {}, text: '', hidden: {}, open: st.open || {} };
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
