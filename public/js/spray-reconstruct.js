/* spray-reconstruct.js — retroactive spray entry with provenance
 * -------------------------------------------------------------
 * Distinguishes two things that were previously conflated:
 *
 *   NORMAL ENTRY LAG. Sprayed Tuesday, keyed in Thursday. This is ordinary
 *   record-keeping, not a reconstruction, and gets no marking whatsoever.
 *   Marking it would make the badge meaningless through sheer volume.
 *
 *   RECONSTRUCTION. Piecing an application back together months later from
 *   invoices, stock movements and what the crew remembers. Materially a
 *   different kind of record, and marked as one.
 *
 * The line between them is LAG_DAYS_BEFORE_RECON. Under it, reconstruction
 * mode is available but optional — tick it if you're genuinely rebuilding
 * something. Over it, it engages automatically and locks, because past that
 * point an unmarked entry would be asserting a precision it doesn't have.
 *
 * `date` is always when the spray HAPPENED. enteredAt (written by app.js on
 * every entry, marked or not) is when it was keyed in. That pair is the real
 * audit trail; the badge is just the part that surfaces in reports.
 */
var SprayReconstruct = (function () {
  'use strict';

  // Two weeks covers realistic operational lag — a busy season, a foreman
  // away, a backlog of paperwork — without covering "I'm rebuilding last
  // year from receipts". Raise it if your workflow genuinely needs more;
  // raising it to a full season defeats the point of having it.
  var LAG_DAYS_BEFORE_RECON = 14;

  var active = false;
  var forced = false;

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

  function lagDays() {
    var d = document.getElementById('sprayDate');
    if (!d || !d.value) return 0;
    var ms = new Date(todayISO()).getTime() - new Date(d.value).getTime();
    if (isNaN(ms)) return 0;
    return Math.round(ms / 86400000);
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

    localizeStatic();

    document.getElementById('reconToggle').addEventListener('change', function () {
      if (forced) { this.checked = true; return; }
      active = this.checked;
      paint();
    });

    var d = document.getElementById('sprayDate');
    d.addEventListener('change', syncLag);
    d.addEventListener('input', syncLag);
    syncLag();
  }

  function localizeStatic() {
    var set = function (id, txt) {
      var el = document.getElementById(id);
      if (el) el.textContent = txt;
    };
    set('reconToggleLabel', tt('שחזור ריסוס שלא תועד',
                               'สร้างบันทึกการพ่นย้อนหลัง',
                               'إعادة بناء رش غير موثق'));
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

  // Recompute forced/optional state from the spray date.
  function syncLag() {
    var lag = lagDays();
    var toggle = document.getElementById('reconToggle');
    if (!toggle) return;

    var wasForced = forced;
    forced = lag > LAG_DAYS_BEFORE_RECON;

    if (forced) {
      toggle.checked = true;
      toggle.disabled = true;
      active = true;
      if (!wasForced) {
        toast('ℹ ' + tt('רישום ישן מ-' + LAG_DAYS_BEFORE_RECON + ' יום — סומן אוטומטית כשחזור',
                        'บันทึกเก่ากว่า ' + LAG_DAYS_BEFORE_RECON + ' วัน — ทำเครื่องหมายย้อนหลังอัตโนมัติ',
                        'سجل أقدم من ' + LAG_DAYS_BEFORE_RECON + ' يومًا — وُسم تلقائيًا كإعادة بناء'));
      }
    } else {
      toggle.disabled = false;
      if (wasForced) { toggle.checked = false; active = false; }
      else { active = toggle.checked; }
    }
    paint(lag);
  }

  function paint(lag) {
    if (typeof lag !== 'number') lag = lagDays();
    var fields = document.getElementById('reconFields');
    var card = document.getElementById('reconCard');
    var intro = document.getElementById('reconIntro');
    if (!fields || !card || !intro) return;

    fields.style.display = active ? '' : 'none';
    card.classList.toggle('recon-on', active);
    card.classList.toggle('recon-forced', forced);

    if (forced) {
      intro.textContent = tt(
        'הריסוס בוצע לפני ' + lag + ' ימים. מעבר ל-' + LAG_DAYS_BEFORE_RECON +
          ' יום הרישום מסומן כשחזור אוטומטית — לא ניתן לבטל.',
        'การพ่นเกิดขึ้น ' + lag + ' วันที่แล้ว เกิน ' + LAG_DAYS_BEFORE_RECON +
          ' วันจะถูกทำเครื่องหมายย้อนหลังอัตโนมัติ',
        'تم الرش قبل ' + lag + ' يومًا. بعد ' + LAG_DAYS_BEFORE_RECON +
          ' يومًا يُوسم السجل تلقائيًا كإعادة بناء.');
    } else if (lag > 0) {
      intro.textContent = tt(
        'פיגור רגיל של ' + lag + ' ימים — הרישום נשמר ללא סימון. סמן ידנית רק אם אתה משחזר מתוך אסמכתאות.',
        'ล่าช้าปกติ ' + lag + ' วัน — บันทึกโดยไม่มีเครื่องหมาย ทำเครื่องหมายเองเฉพาะเมื่อสร้างย้อนหลังจากเอกสาร',
        'تأخير عادي ' + lag + ' أيام — يُحفظ دون وسم. ضع الوسم يدويًا فقط عند إعادة البناء من مستندات.');
    } else {
      intro.textContent = tt(
        'רישום שוטף — נשמר ללא סימון. סמן ידנית רק אם אתה משחזר ריסוס ישן.',
        'บันทึกปัจจุบัน — ไม่มีเครื่องหมาย ทำเครื่องหมายเองเฉพาะเมื่อสร้างย้อนหลัง',
        'تسجيل جارٍ — دون وسم. ضع الوسم يدويًا فقط عند إعادة بناء رش قديم.');
    }
  }

  // ── date guard ──
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

      syncLag();
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
    thresholdDays: LAG_DAYS_BEFORE_RECON,
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
        confidence: g('reconConfidence'),
        lagDays: lagDays(),
        // true = engaged automatically by age, false = operator chose it
        autoFlagged: forced
      };
    },
    isActive: function () { return active; },
    reset: function () {
      var t = document.getElementById('reconToggle');
      if (t) { t.disabled = false; t.checked = false; }
      forced = false;
      active = false;
      ['reconBasis', 'reconRefs', 'reconConfidence'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      syncLag();
    }
  };
})();
window.SprayReconstruct = SprayReconstruct;
