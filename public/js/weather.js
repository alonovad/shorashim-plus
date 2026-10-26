/* weather.js — weather tab: forecast and nearest-station data per משק (Oct 2026)
 *
 * For every farm the viewer can see, the location of its main plot (the one
 * chosen on the farm's report theme, else the largest — ReportMap.mainPlotOf)
 * drives:
 *   • a hyper-local forecast from Open-Meteo (no key; one request for all
 *     farms): now, today, the next 24 hours, 7 days;
 *   • a spray window for the next 24 hours, hour by hour — wind 3–15 km/h,
 *     no rain soon, not too hot, not too dry — green / amber / red;
 *   • alerts: frost, heat, strong wind, rain;
 *   • reference evapotranspiration (ET0) — 1 mm = 1 m³ per dunam — today and
 *     over the week, the number irrigation has to replace (× crop factor);
 *   • the nearest Israel Meteorological Service station and its latest
 *     measurements, through the imsWeather Cloud Function once an IMS API
 *     token is configured (the token stays on the server).
 * Results are cached for 30 minutes per device.
 *
 * Note: Open-Meteo's free endpoint is for non-commercial use; a commercial
 * plan uses an API key on customer-api.open-meteo.com (OM_BASE / omKey).
 */
var Weather = (function () {
  'use strict';

  var OM_BASE = 'https://api.open-meteo.com/v1/forecast';
  var CACHE_KEY = 'shorashim-weather-cache';
  var TTL = 30 * 60 * 1000;
  var state = { data: null, ims: null, imsErr: '', open: null, loading: false, at: 0 };

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function S() { return window.SprayStore || {}; }
  function r0(x) { return Math.round(Number(x) || 0); }
  function r1(x) { return Math.round((Number(x) || 0) * 10) / 10; }

  // WMO weather codes → icon + Hebrew label.
  function wx(code) {
    var c = Number(code);
    if (c === 0) return ['☀️', tt('בהיר', 'แจ่มใส', 'صافٍ')];
    if (c <= 2) return ['🌤️', tt('מעונן חלקית', 'มีเมฆบางส่วน', 'غائم جزئياً')];
    if (c === 3) return ['☁️', tt('מעונן', 'มีเมฆมาก', 'غائم')];
    if (c === 45 || c === 48) return ['🌫️', tt('ערפל', 'หมอก', 'ضباب')];
    if (c >= 51 && c <= 57) return ['🌦️', tt('טפטוף', 'ฝนปรอย', 'رذاذ')];
    if (c >= 61 && c <= 67) return ['🌧️', tt('גשם', 'ฝน', 'مطر')];
    if (c >= 71 && c <= 77) return ['🌨️', tt('שלג', 'หิมะ', 'ثلج')];
    if (c >= 80 && c <= 82) return ['🌧️', tt('ממטרים', 'ฝนซู่', 'زخات')];
    if (c >= 95) return ['⛈️', tt('סופות רעמים', 'พายุฝนฟ้าคะนอง', 'عواصف رعدية')];
    return ['🌡️', ''];
  }

  // ── farm points ──
  function points() {
    var farms = S().getFarms ? S().getFarms() : [];
    var out = [];
    farms.forEach(function (f) {
      var p = window.ReportMap && ReportMap.mainPlotOf ? ReportMap.mainPlotOf(f.id) : null;
      var ring = p && p.latlngs;
      if (!ring || !ring.length) return;
      var lat = 0, lon = 0, n = 0;
      ring.forEach(function (c) {
        var la = c.lat !== undefined ? c.lat : c[0], lo = c.lng !== undefined ? c.lng : c[1];
        if (isFinite(la) && isFinite(lo)) { lat += Number(la); lon += Number(lo); n++; }
      });
      if (!n) return;
      out.push({ id: f.id, name: f.name, plot: p.name || '', lat: Math.round(lat / n * 10000) / 10000, lon: Math.round(lon / n * 10000) / 10000, station: f.ims_station || null, radStation: f.ims_rad_station || null, mopStation: f.mop_station || null });
    });
    return out;
  }

  // ── fetch ──
  function readCache(sig) {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && c.sig === sig && Date.now() - c.at < TTL) return c;
    } catch (e) {}
    return null;
  }
  function writeCache(obj) { try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch (e) {} }

  function fetchForecast(pts) {
    var q = [
      'latitude=' + pts.map(function (p) { return p.lat; }).join(','),
      'longitude=' + pts.map(function (p) { return p.lon; }).join(','),
      'current=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation,weather_code',
      'hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation,et0_fao_evapotranspiration,weather_code',
      'daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,et0_fao_evapotranspiration,wind_speed_10m_max,wind_gusts_10m_max',
      'timezone=Asia%2FJerusalem', 'forecast_days=7', 'wind_speed_unit=kmh'
    ].join('&');
    return fetch(OM_BASE + '?' + q).then(function (r) {
      if (!r.ok) throw new Error('forecast ' + r.status);
      return r.json();
    }).then(function (j) { return Array.isArray(j) ? j : [j]; });
  }

  function fetchIms(pts) {
    if (!window.firebase || !firebase.app || !firebase.app().functions) return Promise.reject(new Error('no-functions'));
    var fn = firebase.app().functions('us-central1').httpsCallable('imsWeather', { timeout: 30000 });
    return fn({ points: pts.map(function (p) { return { id: p.id, lat: p.lat, lon: p.lon, station: p.station }; }) }).then(function (r) { return (r && r.data) || {}; });
  }

  function load(force) {
    var pts = points();
    var sig = pts.map(function (p) { return p.id + ':' + p.lat + ',' + p.lon + ':' + (p.station || '') + ':' + (p.radStation || ''); }).join('|');
    var c = !force && readCache(sig);
    if (c) { state.data = c.data; state.ims = c.ims; state.imsErr = c.imsErr || ''; state.at = c.at; state.pts = pts; paint(); return; }
    if (!pts.length) { state.data = []; state.pts = pts; paint(); return; }
    state.loading = true; state.pts = pts; paint();
    var f = fetchForecast(pts).then(function (arr) {
      return pts.map(function (p, i) { return { p: p, f: arr[i] || null }; });
    }).catch(function (e) { state.err = (e && e.message) || 'error'; return null; });
    var im = fetchIms(pts).then(function (d) { return { ok: d }; }, function (e) {
      var m = String((e && (e.code || e.message)) || '');
      return { err: /not-found|NOT_FOUND|internal/.test(m) ? 'not-configured' : m };
    });
    Promise.all([f, im]).then(function (res) {
      state.loading = false;
      state.data = res[0];
      state.ims = res[1].ok ? (res[1].ok.stations || {}) : null;
      state.imsErr = res[1].err || '';
      state.at = Date.now();
      if (state.data) writeCache({ sig: sig, at: state.at, data: state.data, ims: state.ims, imsErr: state.imsErr });
      paint();
    });
  }

  // ── analysis ──
  // Spray suitability for one hour: 'good' | 'mid' | 'bad', with the reason.
  function sprayHour(h) {
    var w = h.wind, g = h.gust, t = h.temp, rh = h.rh, pp = h.pp, rain = h.rainNext;
    if (rain || pp >= 50) return ['bad', tt('גשם', 'ฝน', 'مطر')];
    if (w > 20 || g > 30) return ['bad', tt('רוח חזקה', 'ลมแรง', 'رياح قوية')];
    if (t >= 35) return ['bad', tt('חם מדי', 'ร้อนเกินไป', 'حار جداً')];
    if (w < 2) return ['mid', tt('אין רוח (היפוך)', 'ลมนิ่ง', 'سكون')];
    if (w > 15 || t >= 30 || rh < 35 || pp >= 30) return ['mid', w > 15 ? tt('רוח', 'ลม', 'رياح') : t >= 30 ? tt('חם', 'ร้อน', 'حار') : rh < 35 ? tt('יבש', 'แห้ง', 'جاف') : tt('סיכוי גשם', 'โอกาสฝน', 'احتمال مطر')];
    return ['good', tt('מתאים', 'เหมาะสม', 'مناسب')];
  }
  function hours(f, n) {
    if (!f || !f.hourly) return [];
    var H = f.hourly, now = Date.now(), out = [];
    for (var i = 0; i < H.time.length && out.length < n; i++) {
      var tms = new Date(H.time[i]).getTime();
      if (tms < now - 3600000) continue;
      var rainNext = 0;
      for (var k = i; k < Math.min(i + 4, H.time.length); k++) rainNext += Number(H.precipitation[k]) || 0;
      out.push({ time: H.time[i], temp: H.temperature_2m[i], rh: H.relative_humidity_2m[i], wind: H.wind_speed_10m[i], gust: H.wind_gusts_10m[i],
        pp: H.precipitation_probability ? H.precipitation_probability[i] : 0, rain: H.precipitation[i], rainNext: rainNext > 0.2, et0: H.et0_fao_evapotranspiration[i], code: H.weather_code ? H.weather_code[i] : null });
    }
    return out;
  }
  function alerts(f) {
    var out = [];
    if (!f || !f.daily) return out;
    var D = f.daily;
    for (var i = 0; i < Math.min(3, D.time.length); i++) {
      var day = i === 0 ? tt('היום', 'วันนี้', 'اليوم') : i === 1 ? tt('מחר', 'พรุ่งนี้', 'غداً') : dayName(D.time[i]);
      if (D.temperature_2m_min[i] <= 2) out.push(['bad', '❄️ ' + tt('סכנת קרה', 'เสี่ยงน้ำค้างแข็ง', 'خطر صقيع') + ' ' + day + ' (' + r1(D.temperature_2m_min[i]) + '°)']);
      if (D.temperature_2m_max[i] >= 40) out.push(['bad', '🔥 ' + tt('שרב', 'ร้อนจัด', 'موجة حر') + ' ' + day + ' (' + r0(D.temperature_2m_max[i]) + '°)']);
      if (D.wind_gusts_10m_max && D.wind_gusts_10m_max[i] >= 50) out.push(['mid', '💨 ' + tt('משבי רוח', 'ลมกระโชก', 'هبات رياح') + ' ' + day + ' ' + r0(D.wind_gusts_10m_max[i]) + ' ' + tt('קמ״ש', 'กม./ชม.', 'كم/س')]);
      if (D.precipitation_sum[i] >= 2) out.push(['mid', '🌧️ ' + tt('גשם', 'ฝน', 'مطر') + ' ' + day + ' ' + r1(D.precipitation_sum[i]) + ' ' + tt('מ״מ', 'มม.', 'مم')]);
    }
    return out;
  }
  var DAYS = [['א׳', 'อา.', 'أحد'], ['ב׳', 'จ.', 'إثنين'], ['ג׳', 'อ.', 'ثلاثاء'], ['ד׳', 'พ.', 'أربعاء'], ['ה׳', 'พฤ.', 'خميس'], ['ו׳', 'ศ.', 'جمعة'], ['ש׳', 'ส.', 'سبت']];
  function dayName(iso) { return tt('יום', 'วัน', 'يوم') + ' ' + (function (d) { return tt(d[0], d[1], d[2]); })(DAYS[new Date(iso + 'T12:00:00').getDay()]); }
  function hh(iso) { return String(iso).slice(11, 13); }

  function ensureCss() {
    if (document.getElementById('wxCss')) return;
    var st = document.createElement('style');
    st.id = 'wxCss';
    st.textContent =
      '.wx{padding:12px;max-width:1200px;margin:0 auto;}' +
      '.wx-top{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px;}' +
      '.wx-top h2{margin:0;font-size:1.15rem;}.wx-top small{color:var(--text-muted,#777);font-size:.74rem;}' +
      '.wx-btn{border:0;border-radius:12px;padding:8px 14px;background:var(--card,#fff);color:var(--primary,#2d6a4f);font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;box-shadow:0 3px 10px rgba(15,58,42,.1);}' +
      '.wx-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;}' +
      '.wx-card{background:var(--card,#fff);border-radius:20px;padding:14px;box-shadow:0 4px 14px rgba(15,58,42,.08);cursor:pointer;}' +
      '.wx-card h3{margin:0;font-size:1rem;display:flex;justify-content:space-between;align-items:baseline;gap:6px;}' +
      '.wx-card h3 small{font-weight:400;color:var(--text-muted,#777);font-size:.72rem;}' +
      '.wx-now{display:flex;align-items:center;gap:12px;margin:8px 0;}' +
      '.wx-now .big{font-size:2.2rem;font-weight:700;line-height:1;}' +
      '.wx-now .ic{font-size:2rem;}' +
      '.wx-now .meta{font-size:.78rem;color:var(--text-muted,#666);line-height:1.6;}' +
      '.wx-src{display:block;font-size:.64rem;color:var(--text-muted,#888);margin-top:3px;}' +
      '.wx-strip{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;margin:6px 0 2px;direction:rtl;}' +
      '.wx-strip i{height:16px;border-radius:3px;display:block;}' +
      '.wx-strip i.good{background:#3fae7a;}.wx-strip i.mid{background:#f0b33c;}.wx-strip i.bad{background:#e0645a;}' +
      '.wx-strip-l{display:flex;justify-content:space-between;font-size:.62rem;color:var(--text-muted,#888);direction:rtl;}' +
      '.wx-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}' +
      '.wx-chip{background:var(--g6,#eef3ef);border-radius:10px;padding:4px 9px;font-size:.74rem;}' +
      '.wx-chip.bad{background:#fdecea;color:#b3261e;font-weight:600;}.wx-chip.mid{background:#fff4e0;color:#9a5b00;font-weight:600;}' +
      '.wx-chip.good{background:#e6f5ee;color:#16785c;font-weight:600;}.wx-chip.warn{background:#e8f1fb;color:#1f5f99;font-weight:600;}' +
      '.wx-st{margin-top:8px;font-size:.76rem;background:#eef4fb;color:#1f4f80;border-radius:10px;padding:6px 9px;}' +
      '.wx-days{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:10px;}' +
      '.wx-day{background:var(--g6,#f2f5f2);border-radius:12px;padding:6px 2px;text-align:center;font-size:.72rem;}' +
      '.wx-day b{display:block;font-size:.8rem;}.wx-day .i{font-size:1.2rem;}' +
      '.wx-hours{overflow:auto;}.wx-hours table{border-collapse:collapse;font-size:.74rem;min-width:900px;width:100%;}' +
      '.wx-hours th,.wx-hours td{padding:4px 5px;text-align:center;border-bottom:1px solid var(--line,#e5e9e4);white-space:nowrap;}' +
      '.wx-hours td.good{background:#e6f5ee;}.wx-hours td.mid{background:#fff4e0;}.wx-hours td.bad{background:#fdecea;}' +
      '.wx-note{font-size:.72rem;color:var(--text-muted,#888);margin-top:10px;}';
    document.head.appendChild(st);
  }

  function root() { return document.getElementById('weatherRoot'); }

  // ── measured alerts from IMS stations (functions: wxAlerts, every 30 min) ──
  // appData/shorashim-wx-alerts { at, farms: { farmId: { station, km, at, items:[{k,val,gust,since}] } } }
  var wxAl = null;
  (function listenAlerts() {
    if (typeof DB === 'undefined' || !DB.listen) { setTimeout(listenAlerts, 1500); return; }
    try { DB.listen('shorashim-wx-alerts', function (d) { wxAl = d || null; var el = root(); if (el && state.data) paint(); }); } catch (e) {}
  })();
  function farmAlerts(fid) {
    var f = wxAl && wxAl.farms && wxAl.farms[fid];
    if (!f || !wxAl.at || Date.now() - wxAl.at > 2 * 3600 * 1000) return [];     // stale (function stopped) = nothing
    return (f.items || []).map(function (it) {
      var txt = it.k === 'heat' ? '🔥 ' + tt('חום כבד', 'ร้อนจัด', 'حر شديد') + ' ' + it.val + '°'
        : it.k === 'frost' ? '❄️ ' + tt('קרה', 'น้ำค้างแข็ง', 'صقيع') + ' ' + it.val + '°'
        : it.k === 'wind' ? '💨 ' + tt('רוח חזקה', 'ลมแรง', 'رياح قوية') + ' ' + it.val + (it.gust ? ' (' + tt('משבים', 'กระโชก', 'هبات') + ' ' + it.gust + ')' : '') + ' ' + tt('קמ״ש', 'กม./ชม.', 'كم/س')
        : '🌧 ' + tt('יורד גשם', 'ฝนตก', 'تمطر');
      var since = it.since ? new Date(it.since).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '';
      return { cls: it.k === 'rain' ? 'warn' : 'bad', text: txt + ' · ' + tt('תחנת', 'สถานี', 'محطة') + ' ' + f.station, when: since ? tt('מאז', 'ตั้งแต่', 'منذ') + ' ' + since : '' };
    });
  }

  function stationHtml(fid) {
    if (state.ims && state.ims[fid]) {
      var s = state.ims[fid];
      return '<div class="wx-st">📡 ' + tt('תחנה', 'สถานี', 'محطة') + ' ' + esc(s.name) + ' (' + r1(s.dist_km) + ' ' + tt('ק״מ', 'กม.', 'كم') + ')' +
        (s.at ? ' · ' + esc(new Date(s.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })) : '') + ': ' +
        [s.temp != null ? r1(s.temp) + '°' : '', s.rh != null ? r0(s.rh) + '%' : '', s.ws != null ? r0(s.ws) + ' ' + tt('קמ״ש', 'กม./ชม.', 'كم/س') : '', s.rain ? r1(s.rain) + ' ' + tt('מ״מ', 'มม.', 'مم') : '']
          .filter(Boolean).join(' · ') +
        '<small class="wx-src">' + tt('מקור: השירות המטאורולוגי (IMS). השירות המטאורולוגי אינו אחראי למידע ואינו צד לפרסומו.',
          'ที่มา: กรมอุตุนิยมวิทยาอิสราเอล (IMS) ซึ่งไม่รับผิดชอบต่อข้อมูลนี้',
          'المصدر: خدمة الأرصاد الجوية الإسرائيلية (IMS)، وهي غير مسؤولة عن المعلومات') + '</small></div>';
    }
    return '';
  }

  function cardHtml(x) {
    var f = x.f, p = x.p;
    if (!f || !f.current) return '<div class="wx-card"><h3>' + esc(p.name) + '</h3><div class="wx-note">' + tt('אין נתונים', 'ไม่มีข้อมูล', 'لا بيانات') + '</div></div>';
    var C = f.current, D = f.daily, w = wx(C.weather_code);
    var hs = hours(f, 24), sp = hs.map(sprayHour);
    var goodNow = sp.findIndex(function (s) { return s[0] === 'good'; });
    var et0 = D.et0_fao_evapotranspiration[0], et7 = D.et0_fao_evapotranspiration.reduce(function (a, b) { return a + (Number(b) || 0); }, 0);
    var al = alerts(f);
    return '<div class="wx-card" data-wx-farm="' + p.id + '">' +
      '<h3>' + esc(p.name) + '<small>📍 ' + esc(p.plot) + '</small></h3>' +
      '<div class="wx-now"><span class="ic">' + w[0] + '</span><span class="big">' + r0(C.temperature_2m) + '°</span>' +
        '<div class="meta">' + esc(tt(w[1])) + ' · ' + tt('לחות', 'ความชื้น', 'رطوبة') + ' ' + r0(C.relative_humidity_2m) + '%<br>' +
        tt('רוח', 'ลม', 'رياح') + ' ' + r0(C.wind_speed_10m) + ' ' + tt('קמ״ש', 'กม./ชม.', 'كم/س') + ' (' + tt('משבים', 'กระโชก', 'هبات') + ' ' + r0(C.wind_gusts_10m) + ')<br>' +
        tt('היום', 'วันนี้', 'اليوم') + ' ' + r0(D.temperature_2m_min[0]) + '°–' + r0(D.temperature_2m_max[0]) + '°' + (D.precipitation_probability_max ? ' · ☔ ' + r0(D.precipitation_probability_max[0]) + '%' : '') + '</div></div>' +
      '<div style="font-size:.74rem;font-weight:600;">' + tt('חלון ריסוס — 24 שעות', 'ช่วงพ่นยา 24 ชม.', 'نافذة الرش 24 ساعة') + ': ' +
        (goodNow === 0 ? '<span style="color:#16785c">' + tt('מתאים עכשיו', 'เหมาะตอนนี้', 'مناسب الآن') + '</span>' :
         goodNow > 0 ? tt('מתאים מ-', 'เหมาะตั้งแต่ ', 'مناسب من ') + hh(hs[goodNow].time) + ':00' : '<span style="color:#b3261e">' + tt('אין חלון מתאים', 'ไม่มีช่วงเหมาะ', 'لا نافذة مناسبة') + '</span>') + '</div>' +
      '<div class="wx-strip">' + sp.map(function (s, i) { return '<i class="' + s[0] + '" title="' + hh(hs[i].time) + ':00 · ' + esc(s[1]) + '"></i>'; }).join('') + '</div>' +
      '<div class="wx-strip-l"><span>' + (hs[0] ? hh(hs[0].time) + ':00' : '') + '</span><span>' + (hs[12] ? hh(hs[12].time) + ':00' : '') + '</span><span>' + (hs[23] ? hh(hs[23].time) + ':00' : '') + '</span></div>' +
      '<div class="wx-row"><span class="wx-chip">💧 ET0 ' + tt('היום', 'วันนี้', 'اليوم') + ' ' + r1(et0) + ' ' + tt('מ״מ', 'มม.', 'مم') + ' = ' + r1(et0) + ' ' + tt('מ״ק/ד׳', 'ลบ.ม./ไร่', 'م³/دونم') + '</span>' +
        '<span class="wx-chip">' + tt('השבוע', 'สัปดาห์นี้', 'هذا الأسبوع') + ' ' + r1(et7) + ' ' + tt('מ״ק/ד׳', 'ลบ.ม./ไร่', 'م³/دونم') + '</span>' +
        al.map(function (a) { return '<span class="wx-chip ' + a[0] + '">' + esc(a[1]) + '</span>'; }).join('') + '</div>' +
      stationHtml(p.id) +
      farmAlerts(p.id).map(function (a) { return '<div class="wx-chip ' + (a.cls === 'bad' ? 'bad' : 'warn') + '" style="display:block;margin-top:6px;">' + esc(a.text) + (a.when ? ' · ' + esc(a.when) : '') + '</div>'; }).join('') +
      (window.WxHist && !state.imsErr ? '<button class="wx-btn" style="margin-top:8px;" data-wx-hist="' + p.id + '">📊 ' + tt('נתונים נמדדים: גשם, חום, השקיה', 'ข้อมูลที่วัด', 'البيانات المقاسة') + '</button>' : '') + '</div>';
  }

  function detailHtml(x) {
    var f = x.f, p = x.p, D = f.daily;
    var hs = hours(f, 48);
    var days = '<div class="wx-days">' + D.time.map(function (t, i) {
      var w = wx(D.weather_code[i]);
      return '<div class="wx-day"><b>' + (i === 0 ? tt('היום', 'วันนี้', 'اليوم') : dayName(t)) + '</b><div class="i">' + w[0] + '</div>' +
        r0(D.temperature_2m_min[i]) + '°–' + r0(D.temperature_2m_max[i]) + '°<br>💨 ' + r0(D.wind_speed_10m_max[i]) +
        (D.precipitation_sum[i] ? '<br>🌧️ ' + r1(D.precipitation_sum[i]) : '') + '<br>ET0 ' + r1(D.et0_fao_evapotranspiration[i]) + '</div>';
    }).join('') + '</div>';
    var rowsDef = [
      [tt('שעה', 'เวลา', 'الساعة'), function (h) { return hh(h.time); }],
      ['', function (h) { return wx(h.code)[0]; }],
      [tt('טמפ׳', 'อุณหภูมิ', 'الحرارة'), function (h) { return r0(h.temp) + '°'; }],
      [tt('לחות', 'ความชื้น', 'رطوبة'), function (h) { return r0(h.rh) + '%'; }],
      [tt('רוח', 'ลม', 'رياح'), function (h) { return r0(h.wind); }],
      [tt('משבים', 'กระโชก', 'هبات'), function (h) { return r0(h.gust); }],
      ['☔ %', function (h) { return r0(h.pp); }],
      ['ET0', function (h) { return r1(h.et0); }]
    ];
    var table = '<div class="wx-hours"><table><tbody>' + rowsDef.map(function (r) {
      return '<tr><th>' + r[0] + '</th>' + hs.map(function (h) { return '<td>' + r[1](h) + '</td>'; }).join('') + '</tr>';
    }).join('') + '<tr><th>' + tt('ריסוס', 'พ่นยา', 'الرش') + '</th>' + hs.map(function (h) { var s = sprayHour(h); return '<td class="' + s[0] + '" title="' + esc(s[1]) + '">' + (s[0] === 'good' ? '✓' : s[0] === 'mid' ? '~' : '✕') + '</td>'; }).join('') + '</tr></tbody></table></div>';
    return '<button class="wx-btn" id="wxBack">→ ' + tt('כל המשקים', 'ทุกฟาร์ม', 'كل المزارع') + '</button>' +
      '<div class="wx-grid" style="margin-top:10px;grid-template-columns:1fr;">' + cardHtml(x) + '</div>' + days +
      '<h3 style="margin:14px 0 6px;font-size:.95rem;">' + tt('48 השעות הקרובות', '48 ชั่วโมงข้างหน้า', 'الـ48 ساعة القادمة') + '</h3>' + table;
  }

  // Callers waiting for data (Home hero) — run once a load settles.
  var subs = [];
  function notify() { var q = subs; subs = []; q.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  function paint() {
    if (!state.loading) notify();
    var el = root();
    if (!el) return;
    ensureCss();
    var head = '<div class="wx-top"><div><h2>🌤️ ' + tt('מזג אוויר במשקים', 'สภาพอากาศในฟาร์ม', 'الطقس في المزارع') + '</h2>' +
      '<small>' + tt('לפי מיקום החלקה הראשית של כל משק', 'ตามตำแหน่งแปลงหลัก', 'حسب موقع القطعة الرئيسية') +
      (state.at ? ' · ' + tt('עודכן', 'อัปเดต', 'تحديث') + ' ' + new Date(state.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : '') + '</small></div>' +
      '<button class="wx-btn" id="wxRefresh">🔄 ' + tt('רענן', 'รีเฟรช', 'تحديث') + '</button></div>';
    var body;
    if (state.loading && !state.data) body = '<div class="wx-note">⏳ ' + tt('טוען תחזית…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>';
    else if (!state.data) body = '<div class="wx-note">❌ ' + tt('לא ניתן לטעון תחזית כרגע.', 'โหลดไม่ได้', 'تعذر التحميل') + ' ' + esc(state.err || '') + '</div>';
    else if (!state.data.length) body = '<div class="wx-note">' + tt('אין משקים עם חלקה ממופה.', 'ไม่มีฟาร์มที่มีแปลง', 'لا مزارع بقطع') + '</div>';
    else if (state.open) {
      var x = state.data.find(function (d) { return d.p.id === state.open; });
      body = x && x.f ? detailHtml(x) : '';
    } else body = '<div class="wx-grid">' + state.data.map(cardHtml).join('') + '</div>';
    var note = '<div class="wx-note">' + tt('תחזית: Open-Meteo. חלון ריסוס: רוח 3–15 קמ״ש, ללא גשם ב-4 השעות הבאות, מתחת ל-30°, לחות מעל 35%. ET0 — התאדות ייחוס; מ״ק לדונם לגידול = ET0 × מקדם גידול.',
      'พยากรณ์: Open-Meteo', 'التوقعات: Open-Meteo') +
      (state.imsErr ? ' · 📡 ' + tt('תחנות השירות המטאורולוגי: ', 'สถานี IMS: ', 'محطات الأرصاد: ') +
        (state.imsErr === 'not-configured' ? tt('ממתין לטוקן API של השירות המטאורולוגי', 'รอโทเค็น', 'بانتظار الرمز') : esc(state.imsErr)) : '') + '</div>';
    el.innerHTML = '<div class="wx">' + head + body + note + '</div>';
    document.getElementById('wxRefresh').addEventListener('click', function () { load(true); });
    var b = document.getElementById('wxBack');
    if (b) b.addEventListener('click', function () { state.open = null; paint(); });
    el.querySelectorAll('[data-wx-hist]').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); WxHist.open(Number(b.getAttribute('data-wx-hist'))); });
    });
    el.querySelectorAll('[data-wx-farm]').forEach(function (c) {
      c.addEventListener('click', function () { if (state.open) return; state.open = Number(c.getAttribute('data-wx-farm')); paint(); window.scrollTo(0, 0); });
    });
  }

  function render() {
    if (!state.data || Date.now() - state.at > TTL) load(false);
    else paint();
  }

  // Compact now-and-next for one farm (Home hero). cb(null) when the farm has
  // no mapped main plot or the forecast could not be loaded.
  function summary(farmId, cb) {
    function done() {
      var arr = state.data || [];
      var x = arr.find(function (d) { return d.p.id === farmId; });
      if (!x || !x.f || !x.f.hourly) return cb(null);
      var hs = hours(x.f, 24), now = hs[0];
      if (!now) return cb(null);
      var sp = hs.map(sprayHour), gi = sp.findIndex(function (q) { return q[0] === 'good'; });
      var D = x.f.daily || {};
      cb({ farmId: farmId, temp: r0(now.temp), wind: r0(now.wind), rh: r0(now.rh), icon: wx(now.code)[0], label: wx(now.code)[1],
        spray: sp[0], goodIdx: gi, goodAt: gi > 0 ? hh(hs[gi].time) + ':00' : '', et0: D.et0_fao_evapotranspiration ? r1(D.et0_fao_evapotranspiration[0]) : null,
        et0d: D.et0_fao_evapotranspiration ? D.et0_fao_evapotranspiration.slice(0, 7).map(function (v) { return Number(v) || 0; }) : [], days: (D.time || []).slice(0, 7),
        alerts: alerts(x.f), at: state.at });
    }
    if (state.data && Date.now() - state.at <= TTL) return done();
    subs.push(done);
    if (!state.loading) load(false);
  }

  document.addEventListener('shorashim:lang', function () {
    var act = document.querySelector('.tab.active');
    if (act && act.getAttribute('data-tab') === 'weather' && state.data) paint();
  });

  return { render: render, refresh: function () { load(true); }, summary: summary, farmAlerts: farmAlerts, _sprayHour: sprayHour, _points: points };
})();
window.Weather = Weather;
