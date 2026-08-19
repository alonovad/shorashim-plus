/* report-theme.js — per-farm report design
 * -----------------------------------------
 * Each farm can carry its own letterhead for the spray log: colours, logo,
 * title, orientation, footer text, signature block. Stored as
 * farm.report_theme inside plotMapperSprayData, so it travels with the farm
 * and needs no new Firestore key.
 *
 * SCOPE, deliberately: a theme controls chrome only — header, palette,
 * paper, footer. It cannot touch the document's disclosures. The שחזור
 * badges, evidence-basis lines, revision notes and void appendix are
 * emitted by generatePdfHtml regardless of theme and are not exposed here.
 * A "design" that could switch those off would just be a way of laundering
 * a reconstructed log into one that reads as contemporaneous.
 *
 * Themes apply to records that exist in the system, for farms that exist in
 * the system. There is no free-text farm name.
 */
var ReportTheme = (function () {
  'use strict';

  var PRESETS = {
    forest: { label: ['ירוק קלאסי', 'เขียวคลาสสิก', 'أخضر كلاسيكي'],
      c1: '#1a5632', c2: '#2d6a4f', c3: '#40916c', accent: '#2d6a4f',
      headText: '#ffffff', radius: 20 },
    marine: { label: ['כחול ימי', 'น้ำเงินทะเล', 'أزرق بحري'],
      c1: '#0d3b52', c2: '#14607f', c3: '#1d86a8', accent: '#14607f',
      headText: '#ffffff', radius: 20 },
    earth: { label: ['אדמה', 'ดินเอิร์ธ', 'ترابي'],
      c1: '#5a3a1e', c2: '#7d5330', c3: '#a06f42', accent: '#7d5330',
      headText: '#ffffff', radius: 14 },
    slate: { label: ['אפור רשמי', 'เทาทางการ', 'رمادي رسمي'],
      c1: '#2f3437', c2: '#454c50', c3: '#5d666b', accent: '#454c50',
      headText: '#ffffff', radius: 6 },
    date: { label: ['תמר', 'อินทผลัม', 'تمر'],
      c1: '#6b4423', c2: '#96642f', c3: '#c08a45', accent: '#8a5a2b',
      headText: '#ffffff', radius: 18 }
  };

  var DEFAULTS = {
    preset: 'forest', logo: '', title: '', sub: '',
    footer: '', signature: false, orientation: 'landscape',
    // Satellite image of the מטע's main plot. OFF by default: the image
    // belongs to the outgoing document only, and only when the grower asks
    // for it. mainPlot empty = the largest plot of the farm.
    satellite: false, mainPlot: '',
    // OFF by default: a report is the grower's document, not our billboard.
    // Ticking the box adds the שורשים פלוס name to the title and the
    // footer; left alone, the document names nobody but the farm.
    brand: false
  };

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

  function toast(m) { if (typeof showToast === 'function') showToast(m); else alert(m); }
  function store() { return window.SprayStore; }

  // Largest first: the default (empty value) is the largest plot, so the
  // list reads in the order the grower would expect.
  function plotOptions(farmId, selected) {
    var plots = (store().getPlots ? store().getPlots() : [])
      .filter(function (p) { return p.farm_id === farmId; })
      .sort(function (a, b) { return (b.area || 0) - (a.area || 0); });
    var auto = plots.length ? plots[0] : null;
    var html = '<option value="">' +
      tt('אוטומטי — החלקה הגדולה',
         'อัตโนมัติ', 'تلقائي') +
      (auto ? ' (' + esc(auto.name) + ')' : '') + '</option>';
    html += plots.map(function (p) {
      return '<option value="' + p.id + '"' + (selected === p.id ? ' selected' : '') + '>' +
        esc(p.name) + (p.area ? ' · ' + (Math.round(p.area * 10) / 10) + ' ' +
          tt('דונם', 'ไร่', 'دونم') : '') + '</option>';
    }).join('');
    return html;
  }

  function canEdit() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }

  // Merge a farm's stored theme with its preset and the defaults.
  // Called by generatePdfHtml — must never throw or the export dies.
  function resolve(farmObj) {
    var saved = (farmObj && farmObj.report_theme) ? farmObj.report_theme : {};
    var merged = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      merged[k] = (saved[k] !== undefined && saved[k] !== null) ? saved[k] : DEFAULTS[k];
    });
    var p = PRESETS[merged.preset] || PRESETS.forest;
    return {
      c1: p.c1, c2: p.c2, c3: p.c3, accent: p.accent,
      headText: p.headText, radius: p.radius,
      orientation: merged.orientation === 'portrait' ? 'portrait' : 'landscape',
      title: merged.title || '', sub: merged.sub || '',
      logo: merged.logo || '', footer: merged.footer || '',
      signature: !!merged.signature,
      satellite: !!merged.satellite,
      mainPlot: merged.mainPlot ? parseInt(merged.mainPlot, 10) : null,
      brand: merged.brand === true
    };
  }

  // ── farm chooser before export ──
  function chooseAndExport() {
    var farms = store().getFarms();
    var opts = farms.map(function (f) {
      return '<option value="' + f.id + '">' + esc(f.name) + '</option>';
    }).join('');

    document.getElementById('modalContainer').innerHTML =
      '<div class="se-backdrop"><div class="se-modal" style="max-width:420px;">' +
        '<h3 class="se-title">📄 ' + tt('ייצוא יומן ריסוסים', 'ส่งออกบันทึกการพ่น', 'تصدير سجل الرش') + '</h3>' +
        '<label class="se-label">' + tt('עבור מטע', 'สำหรับสวน', 'للبستان') + '</label>' +
        '<select id="rtFarm" class="form-input">' +
          '<option value="">' + tt('כל המטעים (עיצוב ברירת מחדל)', 'ทุกสวน (ค่าเริ่มต้น)', 'كل البساتين (افتراضي)') + '</option>' +
          opts +
        '</select>' +
        '<div id="rtHint" class="rt-hint"></div>' +
        '<div class="se-actions">' +
          '<button type="button" class="se-save" onclick="ReportTheme.doExport()">' +
            tt('ייצא', 'ส่งออก', 'تصدير') + '</button>' +
          (canEdit() ? '<button type="button" class="se-cancel" onclick="ReportTheme.editFromChooser()">🎨 ' +
            tt('עיצוב', 'ออกแบบ', 'تصميم') + '</button>' : '') +
          '<button type="button" class="se-cancel" onclick="ReportTheme.close()">' +
            tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
        '</div>' +
      '</div></div>';

    var sel = document.getElementById('rtFarm');
    var hint = function () {
      var id = parseInt(sel.value, 10);
      var el = document.getElementById('rtHint');
      if (!id) {
        el.textContent = tt('כל הרשומות, בעיצוב הבית.',
                            'ทุกบันทึก ดีไซน์เริ่มต้น',
                            'كل السجلات بالتصميم الافتراضي.');
        return;
      }
      var th = store().getFarmTheme(id);
      el.textContent = th
        ? tt('עיצוב מותאם מוגדר למטע זה.', 'มีดีไซน์เฉพาะสำหรับสวนนี้', 'يوجد تصميم مخصص لهذا البستان.')
        : tt('אין עיצוב מותאם — ישתמש בעיצוב הבית.',
             'ยังไม่มีดีไซน์เฉพาะ ใช้ค่าเริ่มต้น',
             'لا يوجد تصميم مخصص — سيُستخدم الافتراضي.');
    };
    sel.addEventListener('change', hint);
    hint();
  }

  function doExport() {
    var id = parseInt(document.getElementById('rtFarm').value, 10) || null;
    var res = store().exportFarmLog(id);
    // The satellite overview is still compositing — a retry, not an error.
    if (res && res.err === 'map-pending') {
      toast('⏳ ' + tt('מכין תצלום לווין — נסה שוב בעוד רגע',
                      'กำลังเตรียมภาพดาวเทียม',
                      'جارٍ تجهيز صورة القمر'));
      return;
    }
    if (!res || !res.ok) {
      toast('❌ ' + tt('אין רשומות למטע זה', 'ไม่มีบันทึกสำหรับสวนนี้', 'لا سجلات لهذا البستان'));
      return;
    }
    close();
    toast('📄 ' + tt('הדו"ח נפתח — לחץ שמור כ-PDF',
                    'เปิดรายงานแล้ว — บันทึกเป็น PDF',
                    'فُتح التقرير — احفظ كـ PDF'));
  }

  function editFromChooser() {
    var id = parseInt(document.getElementById('rtFarm').value, 10);
    if (!id) {
      toast('❌ ' + tt('בחר מטע כדי לערוך את עיצובו',
                      'เลือกสวนเพื่อแก้ไขดีไซน์',
                      'اختر بستانًا لتعديل تصميمه'));
      return;
    }
    edit(id);
  }

  // ── design editor ──
  function edit(farmId) {
    if (!canEdit()) {
      toast('❌ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية'));
      return;
    }
    var farms = store().getFarms();
    var farm = farms.find(function (f) { return f.id === farmId; });
    if (!farm) return;

    var saved = store().getFarmTheme(farmId) || {};
    var cur = {};
    Object.keys(DEFAULTS).forEach(function (k) {
      cur[k] = (saved[k] !== undefined && saved[k] !== null) ? saved[k] : DEFAULTS[k];
    });

    var presetHtml = Object.keys(PRESETS).map(function (k) {
      var p = PRESETS[k];
      return '<label class="rt-preset' + (cur.preset === k ? ' rt-on' : '') + '" data-preset="' + k + '">' +
        '<span class="rt-swatch" style="background:linear-gradient(135deg,' +
          p.c1 + ',' + p.c2 + ',' + p.c3 + ');"></span>' +
        '<span>' + esc(tt(p.label[0], p.label[1], p.label[2])) + '</span>' +
        '<input type="radio" name="rtPreset" value="' + k + '"' +
          (cur.preset === k ? ' checked' : '') + '>' +
      '</label>';
    }).join('');

    document.getElementById('modalContainer').innerHTML =
      '<div class="se-backdrop"><div class="se-modal">' +
        '<h3 class="se-title">🎨 ' + tt('עיצוב דוח', 'ดีไซน์รายงาน', 'تصميم التقرير') +
          ' — ' + esc(farm.name) + '</h3>' +

        '<div class="rt-note">' +
          tt('העיצוב משנה כותרת, צבעים ופריסה בלבד. סימוני שחזור, יומן עריכות ורשומות שבוטלו מופיעים בכל עיצוב.',
             'ดีไซน์เปลี่ยนเฉพาะหัวกระดาษ สี และเลย์เอาต์ เครื่องหมายย้อนหลังและบันทึกแก้ไขแสดงเสมอ',
             'التصميم يغيّر الترويسة والألوان والتخطيط فقط. تظهر أوسمة إعادة البناء وسجل التعديلات في كل تصميم.') +
        '</div>' +

        '<label class="se-label">' + tt('ערכת צבעים', 'ชุดสี', 'مجموعة الألوان') + '</label>' +
        '<div class="rt-presets">' + presetHtml + '</div>' +

        '<label class="se-label">' + tt('כותרת (ריק = ברירת מחדל)', 'หัวเรื่อง (ว่าง = ค่าเริ่มต้น)', 'العنوان (فارغ = افتراضي)') + '</label>' +
        '<input type="text" id="rtTitle" class="form-input" value="' + esc(cur.title) + '">' +

        '<label class="se-label">' + tt('שורת משנה', 'บรรทัดรอง', 'سطر فرعي') + '</label>' +
        '<input type="text" id="rtSub" class="form-input" value="' + esc(cur.sub) + '" placeholder="' +
          esc(tt('מס׳ מגדל, ח.פ., טלפון…', 'เลขผู้ปลูก โทร…', 'رقم المزارع، هاتف…')) + '">' +

        '<label class="se-label">' + tt('לוגו', 'โลโก้', 'شعار') + '</label>' +
        '<input type="file" id="rtLogo" class="form-input" accept="image/png,image/jpeg,image/svg+xml">' +
        '<div id="rtLogoPrev" class="rt-logoprev">' +
          (cur.logo ? '<img src="' + cur.logo + '" alt="">' +
            '<button type="button" class="rt-logodel" onclick="ReportTheme.dropLogo()">✕</button>' : '') +
        '</div>' +

        '<label class="se-label">' + tt('כיוון הדף', 'แนวกระดาษ', 'اتجاه الصفحة') + '</label>' +
        '<select id="rtOrient" class="form-input">' +
          '<option value="landscape"' + (cur.orientation === 'landscape' ? ' selected' : '') + '>' +
            tt('לרוחב', 'แนวนอน', 'أفقي') + '</option>' +
          '<option value="portrait"' + (cur.orientation === 'portrait' ? ' selected' : '') + '>' +
            tt('לאורך', 'แนวตั้ง', 'رأسي') + '</option>' +
        '</select>' +

        '<label class="se-label">' + tt('טקסט תחתית', 'ข้อความท้ายกระดาษ', 'نص التذييل') + '</label>' +
        '<textarea id="rtFooter" class="form-input" rows="2">' + esc(cur.footer) + '</textarea>' +

        '<label class="rt-check"><input type="checkbox" id="rtSig"' +
          (cur.signature ? ' checked' : '') + '> ' +
          tt('הוסף שורת חתימה', 'เพิ่มบรรทัดลายเซ็น', 'أضف سطر توقيع') + '</label>' +

        // Opt-in, per farm, and it affects the exported document only — the
        // in-app screens never show it.
        '<label class="rt-check"><input type="checkbox" id="rtSat"' +
          (cur.satellite ? ' checked' : '') + '> ' +
          tt('הוסף תצלום לווין לדוח המופק',
             'เพิ่มภาพดาวเทียม',
             'أضف صورة قمر للتقرير') + '</label>' +

        '<label class="rt-check"><input type="checkbox" id="rtBrand"' +
          (cur.brand ? ' checked' : '') + '> ' +
          tt('הוסף כותרת "שורשים פלוס"',
             'เพิ่มหัวข้อ Shorashim Plus',
             'أضف عنوان Shorashim Plus') + '</label>' +

        '<label class="se-label">' + tt('החלקה הראשית של המטע (לתצלום)',
          'แปลงหลัก', 'القطعة الرئيسية') + '</label>' +
        '<select id="rtMainPlot" class="form-input">' + plotOptions(farmId, cur.mainPlot) + '</select>' +

        '<div class="se-actions">' +
          '<button type="button" class="se-save" onclick="ReportTheme.save(' + farmId + ')">' +
            tt('שמור עיצוב', 'บันทึกดีไซน์', 'حفظ التصميم') + '</button>' +
          '<button type="button" class="se-cancel" onclick="ReportTheme.preview(' + farmId + ')">' +
            tt('תצוגה מקדימה', 'ดูตัวอย่าง', 'معاينة') + '</button>' +
          '<button type="button" class="se-cancel" onclick="ReportTheme.reset(' + farmId + ')">' +
            tt('אפס', 'รีเซ็ต', 'إعادة') + '</button>' +
        '</div>' +
      '</div></div>';

    _pendingLogo = cur.logo;

    document.querySelectorAll('.rt-preset').forEach(function (el) {
      el.addEventListener('click', function () {
        document.querySelectorAll('.rt-preset').forEach(function (x) { x.classList.remove('rt-on'); });
        this.classList.add('rt-on');
      });
    });

    document.getElementById('rtLogo').addEventListener('change', function () {
      var file = this.files && this.files[0];
      if (!file) return;
      // 400 KB ceiling: the logo is inlined as a data URL into every export,
      // and plotMapperSprayData is a single Firestore document.
      if (file.size > 400 * 1024) {
        toast('❌ ' + tt('הלוגו גדול מדי (עד 400KB)', 'โลโก้ใหญ่เกินไป (สูงสุด 400KB)', 'الشعار كبير جدًا (حتى 400KB)'));
        this.value = '';
        return;
      }
      var r = new FileReader();
      r.onload = function () {
        _pendingLogo = r.result;
        document.getElementById('rtLogoPrev').innerHTML =
          '<img src="' + _pendingLogo + '" alt="">' +
          '<button type="button" class="rt-logodel" onclick="ReportTheme.dropLogo()">✕</button>';
      };
      r.readAsDataURL(file);
    });
  }

  var _pendingLogo = '';

  function dropLogo() {
    _pendingLogo = '';
    var el = document.getElementById('rtLogoPrev');
    if (el) el.innerHTML = '';
    var inp = document.getElementById('rtLogo');
    if (inp) inp.value = '';
  }

  function collect() {
    var sel = document.querySelector('.rt-preset.rt-on');
    return {
      preset: sel ? sel.getAttribute('data-preset') : 'forest',
      title: document.getElementById('rtTitle').value.trim(),
      sub: document.getElementById('rtSub').value.trim(),
      logo: _pendingLogo || '',
      orientation: document.getElementById('rtOrient').value,
      footer: document.getElementById('rtFooter').value.trim(),
      signature: document.getElementById('rtSig').checked,
      satellite: document.getElementById('rtSat').checked,
      mainPlot: document.getElementById('rtMainPlot').value || '',
      brand: document.getElementById('rtBrand').checked
    };
  }

  function save(farmId) {
    var res = store().setFarmTheme(farmId, collect());
    if (!res || !res.ok) { toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ')); return; }
    toast('✅ ' + tt('העיצוב נשמר', 'บันทึกดีไซน์แล้ว', 'حُفظ التصميم'));
    close();
  }

  function reset(farmId) {
    if (!confirm(tt('לאפס לעיצוב הבית?', 'รีเซ็ตเป็นค่าเริ่มต้น?', 'إعادة للتصميم الافتراضي؟'))) return;
    store().setFarmTheme(farmId, null);
    toast('↩ ' + tt('אופס לעיצוב הבית', 'รีเซ็ตแล้ว', 'أُعيد للافتراضي'));
    close();
  }

  // Saves first, so what you preview is exactly what you'd send.
  function preview(farmId) {
    store().setFarmTheme(farmId, collect());
    var res = store().exportFarmLog(farmId);
    // The satellite overview is still compositing — a retry, not an error.
    if (res && res.err === 'map-pending') {
      toast('⏳ ' + tt('מכין תצלום לווין — נסה שוב בעוד רגע',
                      'กำลังเตรียมภาพดาวเทียม',
                      'جارٍ تجهيز صورة القمر'));
      return;
    }
    if (!res || !res.ok) {
      toast('ℹ ' + tt('אין רשומות למטע זה להצגה', 'ไม่มีบันทึกให้แสดง', 'لا سجلات للعرض'));
    }
  }

  function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }

  return {
    resolve: resolve, chooseAndExport: chooseAndExport, doExport: doExport,
    editFromChooser: editFromChooser, edit: edit, save: save, reset: reset,
    preview: preview, dropLogo: dropLogo, close: close, PRESETS: PRESETS
  };
})();
window.ReportTheme = ReportTheme;
