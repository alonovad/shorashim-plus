/* radar.js — rain radar layer on the main map (Oct 2026)
 *
 * Interim source: RainViewer's public weather-maps API (composite of
 * national radars; free tier max native zoom 7 ≈ 1 km a pixel, frames every
 * 10 minutes for the last ~2 hours). Coarse at plot scale, enough to see a
 * rain cell over a farm. To be replaced by the IMS radar product once IMS
 * grants access.
 *
 * A "🌧️ מכ״ם" button sits next to the street/satellite toggle; on, the latest
 * frame shows with a time strip (play / scrub). The choice is remembered on
 * the device. Nothing is stored on the server.
 *
 * Public: Radar.toggle()
 */
var Radar = (function () {
  'use strict';

  var API = 'https://api.rainviewer.com/public/weather-maps.json';
  var KEY = 'shorashim-radar-on';
  var st = { on: false, host: '', frames: [], idx: 0, layers: {}, timer: null, refresh: null, playing: false };

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function M() { return window.map && window.map.addLayer ? window.map : null; }
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function hhmm(sec) { var d = new Date(sec * 1000); return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(); }

  function css() {
    if (document.getElementById('radarCss')) return;
    var s = document.createElement('style'); s.id = 'radarCss';
    s.textContent =
      '#radarBar{position:absolute;left:50%;transform:translateX(-50%);bottom:86px;z-index:800;display:flex;align-items:center;gap:8px;' +
        'background:rgba(255,255,255,.95);border-radius:16px;padding:6px 10px;box-shadow:0 6px 22px rgba(0,0,0,.22);font:600 12px Heebo,sans-serif;direction:rtl;max-width:calc(100% - 24px);}' +
      '#radarBar button{border:none;background:#eef4ea;border-radius:10px;width:32px;height:30px;font-size:15px;cursor:pointer;flex:none;}' +
      '#radarBar input[type=range]{width:140px;flex:1;min-width:80px;}' +
      '#radarBar .rd-t{min-width:44px;text-align:center;direction:ltr;}' +
      '#radarBar .rd-src{font-weight:400;color:#7a857c;font-size:10.5px;white-space:nowrap;}' +
      '#radarBar .rd-lg{display:flex;height:8px;width:56px;border-radius:4px;overflow:hidden;flex:none;}' +
      '#radarBar .rd-lg i{flex:1;}' +
      '.layer-toggle.rd-on{background:#1d5a2c !important;color:#fff !important;}';
    document.head.appendChild(s);
  }
  function button() {
    var bar = document.querySelector('.map-float-bar');
    if (!bar || document.getElementById('radarBtn')) return;
    var b = document.createElement('button');
    b.className = 'layer-toggle'; b.id = 'radarBtn'; b.type = 'button';
    b.innerHTML = '<span>🌧️</span> <span>' + tt('מכ״ם', 'เรดาร์', 'رادار') + '</span>';
    b.addEventListener('click', toggle);
    bar.appendChild(b);
    if (st.on) b.classList.add('rd-on');
  }

  function load() {
    return fetch(API, { cache: 'no-store' }).then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); }).then(function (j) {
      var past = (j && j.radar && j.radar.past) || [], now = (j && j.radar && j.radar.nowcast) || [];
      st.host = j.host || 'https://tilecache.rainviewer.com';
      st.frames = past.concat(now);
      st.nowIdx = past.length - 1;
    });
  }
  function layerFor(i) {
    var f = st.frames[i]; if (!f) return null;
    if (!st.layers[f.path]) {
      st.layers[f.path] = L.tileLayer(st.host + f.path + '/256/{z}/{x}/{y}/2/1_1.png', {
        opacity: 0, zIndex: 450, maxNativeZoom: 7, maxZoom: 20, tileSize: 256, crossOrigin: true,
        attribution: 'Radar © <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>'
      });
    }
    return st.layers[f.path];
  }
  function show(i) {
    var m = M(); if (!m || !st.frames.length) return;
    st.idx = Math.max(0, Math.min(st.frames.length - 1, i));
    // keep the current and the next frame on the map, so stepping does not flash
    Object.keys(st.layers).forEach(function (k) { var l = st.layers[k]; if (m.hasLayer(l)) l.setOpacity(0); });
    var cur = layerFor(st.idx); if (!m.hasLayer(cur)) cur.addTo(m); cur.setOpacity(0.62);
    var nx = layerFor((st.idx + 1) % st.frames.length); if (nx && !m.hasLayer(nx)) nx.addTo(m);
    paintBar();
  }
  function paintBar() {
    var m = M(); if (!m) return;
    var host = m.getContainer(), el = document.getElementById('radarBar');
    if (!st.on) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'radarBar'; host.appendChild(el); L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
    var f = st.frames[st.idx];
    var future = st.idx > st.nowIdx;
    el.innerHTML =
      '<button type="button" data-rd="play" title="' + tt('הנפשה', 'เล่น', 'تشغيل') + '">' + (st.playing ? '⏸' : '▶') + '</button>' +
      '<input type="range" min="0" max="' + Math.max(0, st.frames.length - 1) + '" value="' + st.idx + '" data-rd="seek">' +
      '<span class="rd-t">' + (f ? (future ? '+' : '') + hhmm(f.time) : '--:--') + '</span>' +
      '<span class="rd-lg" title="' + tt('חלש ← חזק', 'อ่อน → แรง', 'خفيف ← قوي') + '"><i style="background:#88ddee"></i><i style="background:#0099cc"></i><i style="background:#ffee00"></i><i style="background:#ff8800"></i><i style="background:#dd0000"></i></span>' +
      '<span class="rd-src" title="' + tt('זמני, עד שיתקבל מכ״ם השירות המטאורולוגי', 'ชั่วคราว', 'مؤقت') + '">RainViewer</span>';
    el.querySelector('[data-rd="play"]').onclick = function () { st.playing ? stop() : play(); };
    el.querySelector('[data-rd="seek"]').oninput = function () { stop(); show(Number(this.value)); };
  }
  function play() {
    st.playing = true; paintBar();
    clearInterval(st.timer);
    st.timer = setInterval(function () { show(st.idx >= st.frames.length - 1 ? 0 : st.idx + 1); }, 700);
  }
  function stop() { st.playing = false; clearInterval(st.timer); st.timer = null; paintBar(); }

  function on() {
    var m = M(); if (!m) { toast('⚠️ ' + tt('המפה עוד לא מוכנה', 'แผนที่ยังไม่พร้อม', 'الخريطة غير جاهزة')); return; }
    st.on = true; try { localStorage.setItem(KEY, '1'); } catch (e) {}
    var b = document.getElementById('radarBtn'); if (b) b.classList.add('rd-on');
    load().then(function () {
      if (!st.on) return;
      if (!st.frames.length) { toast('⚠️ ' + tt('אין כרגע נתוני מכ״ם', 'ไม่มีข้อมูลเรดาร์', 'لا بيانات رادار')); return; }
      show(st.nowIdx >= 0 ? st.nowIdx : st.frames.length - 1);
      // new frames every 10 minutes
      clearInterval(st.refresh);
      st.refresh = setInterval(function () { if (!st.playing) load().then(function () { show(st.nowIdx); }); }, 10 * 60 * 1000);
    }, function () { toast('❌ ' + tt('לא ניתן לטעון את המכ״ם', 'โหลดเรดาร์ไม่ได้', 'تعذر تحميل الرادار')); off(); });
  }
  function off() {
    st.on = false; try { localStorage.setItem(KEY, '0'); } catch (e) {}
    stop(); clearInterval(st.refresh);
    var m = M(); Object.keys(st.layers).forEach(function (k) { if (m && m.hasLayer(st.layers[k])) m.removeLayer(st.layers[k]); });
    st.layers = {};
    var b = document.getElementById('radarBtn'); if (b) b.classList.remove('rd-on');
    paintBar();
  }
  function toggle() { st.on ? off() : on(); }

  (function init() {
    if (!window.L || !document.querySelector('.map-float-bar')) { setTimeout(init, 800); return; }
    css(); button();
    var want = false; try { want = localStorage.getItem(KEY) === '1'; } catch (e) {}
    if (want) (function wait() { if (M()) on(); else setTimeout(wait, 800); })();
  })();

  return { toggle: toggle };
})();
window.Radar = Radar;
