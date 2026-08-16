/* spray-reconstruct.js — retroactive spray entry with provenance
 * -------------------------------------------------------------
 * For sprays that were performed but never properly logged. The record
 * captures what it is (a reconstruction), what it's based on, who built
 * it and when — so it stands up to an inspector instead of quietly
 * pretending to be a contemporaneous log.
 *
 * `date` remains the date the spray HAPPENED. reconstructedAt is when it
 * was pieced together. Keeping the two separate is the whole point.
 *
 * Exposes SprayReconstruct.getMeta(), read by app.js's submit handler.
 * No new Firestore keys — this rides inside plotMapperSprayData.
 */
var SprayReconstruct = (function () {
  'use strict';

  var active = false;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else alert(msg);
  }

  // ── UI ──
  function build() {
    if (document.getElementById('reconCard')) return;
    var dateInput = document.getElementById('sprayDate');
    if (!dateInput) return;
    var anchor = dateInput.closest ? dateInput.closest('.section-card') : null;
    if (!anchor || !anchor.parentNode) return;

    var card = document.createElement('div');
    card.className = 'section-card';
    card.id = 'reconCard';
    card.innerHTML =
      '<label class="recon-switch">' +
        '<input type="checkbox" id="reconToggle">' +
        '<span class="recon-switch-label" id="reconToggleLabel"></span>' +
      '</label>' +
      '<div class="recon-note" id="reconIntro"></div>' +
      '<div id="reconFields" class="recon-fields" style="display:none;">' +
        '<div class="recon-banner" id="reconBanner"></div>' +
        '<div class="form-group">' +
          '<label class="form-label" id="reconBasisLabel"></label>' +
          '<textarea class="form-input" id="reconBasis" rows="2"></textarea>' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" id="reconRefsLabel"></label>' +
          '<input type="text" class="form-input" id="reconRefs">' +
        '</div>' +
        '<div class="form-group">' +
          '<label class="form-label" id="reconConfLabel"></label>' +
          '<select class="form-input" id="reconConfidence">' +
            '<option value="">—</option>' +
            '<option value="high"></option>' +
            '<option value="medium"></option>' +
            '<option value="low"></option>' +
          '</select>' +
        '</div>' +
      '</div>';
    anchor.parentNode.insertBefore(card, anchor.nextSibling);

    localize();

    document.getElementById('reconToggle').addEventListener('change', function () {
      active = this.checked;
      document.getElementById('reconFields').style.display = active ? '' : 'none';
      document.getElementById('reconCard').classList.toggle('recon-on', active);
    });
  }

  function localize() {
    var set = function (id, txt) {
      var el = document.getElementById(id);
      if (el) el.textContent = txt;
    };
    set('reconToggleLabel', tt('שחזור ריסוס שלא תועד',
                               'สร้างบันทึกการพ่นย้อนหลัง',
                               'إعادة بناء رش غير موثق'));
    set('reconIntro', tt('לרישום ריסוס שבוצע בפועל אך לא נרשם במועד. הרשומה תסומן כשחזור.',
                         'สำหรับการพ่นที่ทำจริงแต่ไม่ได้บันทึกตอนนั้น บันทึกจะถูกทำเครื่องหมายว่าสร้างย้อนหลัง',
                         'لتسجيل رش نُفّذ فعليًا ولم يُوثّق في حينه. سيُوسم السجل كإعادة بناء.'));
    set('reconBanner', tt('⚠ רשומה זו תסומן כשחזור בכל דוח ובכל ייצוא',
                          '⚠ บันทึกนี้จะถูกทำเครื่องหมายว่าสร้างย้อนหลังในทุกรายงาน',
                          '⚠ سيُوسم هذا السجل كإعادة بناء في كل تقرير وتصدير'));
    set('reconBasisLabel', tt('על סמך מה (חובה)',
                              'อ้างอิงจาก (จำเป็น)',
                              'استنادًا إلى (إلزامي)'));
    set('reconRefsLabel', tt('אסמכתאות — מספרי חשבונית, מלאי, וכו׳',
                             'เอกสารอ้างอิง — เลขใบแจ้งหนี้ สต็อก ฯลฯ',
                             'مستندات — أرقام فواتير، مخزون، إلخ'));
    set('reconConfLabel', tt('רמת ודאות (חובה)',
                             'ระดับความมั่นใจ (จำเป็น)',
                             'مستوى الثقة (إلزامي)'));

    var basis = document.getElementById('reconBasis');
    if (basis) {
      basis.placeholder = tt('לדוגמה: חשבונית ספק 4471, יתרת מלאי, תשאול המפעיל',
                             'เช่น ใบแจ้งหนี้ 4471, ยอดคงเหลือ, สัมภาษณ์ผู้ปฏิบัติงาน',
                             'مثال: فاتورة مورد 4471، رصيد المخزون، مقابلة المشغّل');
    }
    var sel = document.getElementById('reconConfidence');
    if (sel && sel.options.length >= 4) {
      sel.options[1].textContent = tt('גבוהה — מסמך כתוב', 'สูง — มีเอกสาร', 'عالية — مستند مكتوب');
      sel.options[2].textContent = tt('בינונית — עדות + אסמכתא חלקית', 'ปานกลาง — คำบอกเล่า + เอกสารบางส่วน', 'متوسطة — شهادة + مستند جزئي');
      sel.options[3].textContent = tt('נמוכה — הערכה בלבד', 'ต่ำ — ประมาณการเท่านั้น', 'منخفضة — تقدير فقط');
    }
  }

  // ── date guard ──
  // A log entry dated forward isn't a record of anything. Planning lives in
  // the maintenance schedule.
  function capDate() {
    var d = document.getElementById('sprayDate');
    if (d) d.setAttribute('max', todayISO());
  }

  function futureDate() {
    var d = document.getElementById('sprayDate');
    if (!d || !d.value) return false;
    return d.value > todayISO();
  }

  // ── validation ──
  // Capture on `document`, not on the button: at the target phase listeners
  // fire in registration order regardless of the capture flag, so a listener
  // bound to the button itself cannot pre-empt app.js's handler.
  function installGuard() {
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('#submitSpray');
      if (!btn) return;

      if (futureDate()) {
        e.stopPropagation();
        e.preventDefault();
        toast('❌ ' + tt('לא ניתן לרשום ריסוס בתאריך עתידי — השתמש בלוח התחזוקה לתכנון',
                        'ไม่สามารถบันทึกการพ่นในอนาคต — ใช้ปฏิทินบำรุงรักษาเพื่อวางแผน',
                        'لا يمكن تسجيل رش بتاريخ مستقبلي — استخدم تقويم الصيانة للتخطيط'));
        return;
      }

      if (!active) return;

      var basisEl = document.getElementById('reconBasis');
      var confEl = document.getElementById('reconConfidence');
      var basis = basisEl ? String(basisEl.value || '') : '';
      var conf = confEl ? String(confEl.value || '') : '';

      if (!basis.trim()) {
        e.stopPropagation();
        e.preventDefault();
        toast('❌ ' + tt('חובה לציין על סמך מה נבנה השחזור',
                        'ต้องระบุแหล่งอ้างอิงของการสร้างย้อนหลัง',
                        'يجب ذكر أساس إعادة البناء'));
        return;
      }
      if (!conf) {
        e.stopPropagation();
        e.preventDefault();
        toast('❌ ' + tt('חובה לבחור רמת ודאות',
                        'ต้องเลือกระดับความมั่นใจ',
                        'يجب اختيار مستوى الثقة'));
      }
    }, true);
  }

  function init() {
    build();
    capDate();
    installGuard();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API — read by app.js's submit handler.
  return {
    getMeta: function () {
      if (!active) return null;
      var g = function (id) {
        var el = document.getElementById(id);
        return el ? String(el.value || '').trim() : '';
      };
      return {
        reconstructed: true,
        reconstructedAt: Date.now(),
        reconstructedBy: (window.currentUser ? window.currentUser.username : ''),
        evidenceBasis: g('reconBasis'),
        sourceRefs: g('reconRefs'),
        confidence: g('reconConfidence')
      };
    },
    isActive: function () { return active; },
    reset: function () {
      active = false;
      var t = document.getElementById('reconToggle');
      if (t) t.checked = false;
      ['reconBasis', 'reconRefs', 'reconConfidence'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      var f = document.getElementById('reconFields');
      if (f) f.style.display = 'none';
      var c = document.getElementById('reconCard');
      if (c) c.classList.remove('recon-on');
    }
  };
})();
window.SprayReconstruct = SprayReconstruct;
