/* spray-edit.js — edit, void, and undo spray records
 * ---------------------------------------------------
 * Three different things, deliberately kept distinct:
 *
 *   EDIT      — the record was right to exist, a detail was wrong. Mandatory
 *               reason, appended to event.revisions[] plus the audit log.
 *   UNDO      — the record should never have existed and was made moments
 *               ago by the same person, unedited. Removed outright; the
 *               audit log still records that it briefly existed.
 *   VOID      — the record should not have existed but is now history.
 *               Struck through, kept, excluded from the active log, listed
 *               in a PDF appendix. Reversible.
 *
 * Collapsing these into one "delete" button is what makes record systems
 * either useless or dishonest. The window between undo and void is
 * SprayStore.GRACE_MS.
 *
 * Gated to operator+ because firestore.rules only permits operator+ to write
 * plotMapperSprayData — a worker's write would be refused server-side anyway.
 */
var SprayEdit = (function () {
  'use strict';

  var editingId = null;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function toast(msg) {
    if (typeof showToast === 'function') showToast(msg);
    else alert(msg);
  }

  function canEdit() {
    var u = window.currentUser || {};
    return u.role === 'admin' || u.role === 'operator';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function todayISO() {
    var d = new Date();
    var m = String(d.getMonth() + 1);
    var day = String(d.getDate());
    if (m.length < 2) m = '0' + m;
    if (day.length < 2) day = '0' + day;
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // ── revision diff ──
  function fieldLabel(f) {
    var map = {
      date: tt('תאריך', 'วันที่', 'التاريخ'),
      operator: tt('מפעיל', 'ผู้ปฏิบัติงาน', 'المشغّل'),
      volumePerTree: tt('נפח לעץ', 'ปริมาตรต่อต้น', 'حجم لكل شجرة'),
      sprayerCapacity: tt('קיבולת מרסס', 'ความจุถังพ่น', 'سعة الرشاش'),
      plotIds: tt('חלקות', 'แปลง', 'القطع'),
      applications: tt('חומרים', 'สารเคมี', 'المواد'),
      linkedReportIds: tt('דוחות מקושרים', 'รายงานที่เชื่อมโยง', 'التقارير المرتبطة'),
      farmId: tt('מטע', 'สวน', 'بستان')
    };
    return map[f] || f;
  }

  function fmtVal(field, v) {
    if (v == null || v === '') return '—';
    if (field === 'plotIds') {
      return (v || []).map(function (id) {
        return window.SprayStore ? window.SprayStore.plotNameById(id) : id;
      }).join(', ') || '—';
    }
    if (field === 'applications') {
      return (v || []).map(function (a) {
        return (a.productName || '') +
               (a.concentration != null ? ' ' + a.concentration + '%' : '') +
               (a.target ? ' → ' + a.target : '');
      }).join(' | ') || '—';
    }
    if (field === 'linkedReportIds') return (v || []).length + '';
    if (field === 'farmId') {
      var fm = (window.SprayStore ? window.SprayStore.getFarms() : [])
        .find(function (f) { return f.id === v; });
      return fm ? fm.name : String(v);
    }
    return String(v);
  }

  function diff(before, after) {
    var fields = ['date', 'operator', 'volumePerTree', 'sprayerCapacity',
                  'plotIds', 'farmId', 'applications', 'linkedReportIds'];
    var out = [];
    fields.forEach(function (f) {
      var a = JSON.stringify(before[f] == null ? null : before[f]);
      var b = JSON.stringify(after[f] == null ? null : after[f]);
      if (a !== b) {
        out.push({ field: f, label: fieldLabel(f),
                   from: fmtVal(f, before[f]), to: fmtVal(f, after[f]) });
      }
    });
    return out;
  }

  // Common corrections, so a typo fix doesn't demand an essay.
  var QUICK_REASONS = [
    ['טעות הקלדה', 'พิมพ์ผิด', 'خطأ إملائي'],
    ['ריכוז שגוי', 'ความเข้มข้นผิด', 'تركيز خاطئ'],
    ['חלקה שגויה', 'แปลงผิด', 'قطعة خاطئة'],
    ['תאריך שגוי', 'วันที่ผิด', 'تاريخ خاطئ'],
    ['תוקן מול חשבונית', 'แก้ตามใบแจ้งหนี้', 'صُحّح وفق الفاتورة']
  ];

  function chipsHtml(targetId) {
    return '<div class="se-chips">' + QUICK_REASONS.map(function (r) {
      var label = tt(r[0], r[1], r[2]);
      return '<button type="button" class="se-chip" onclick="SprayEdit.fillReason(\'' +
             targetId + '\',\'' + esc(label).replace(/'/g, '') + '\')">' + esc(label) + '</button>';
    }).join('') + '</div>';
  }

  function fillReason(targetId, text) {
    var el = document.getElementById(targetId);
    if (!el) return;
    el.value = el.value.trim() ? el.value.trim() + ', ' + text : text;
    el.focus();
  }

  // ── modal ──
  function open(eventId) {
    if (!canEdit()) {
      toast('❌ ' + tt('אין הרשאה לערוך רשומות ריסוס',
                      'ไม่มีสิทธิ์แก้ไขบันทึกการพ่น',
                      'لا صلاحية لتعديل سجلات الرش'));
      return;
    }
    if (!window.SprayStore) return;
    var ev = window.SprayStore.getEvents().find(function (e) { return e.id === eventId; });
    if (!ev) { toast('❌ ' + tt('רשומה לא נמצאה', 'ไม่พบบันทึก', 'السجل غير موجود')); return; }

    editingId = eventId;
    var plots = window.SprayStore.getPlots();
    var cat = window.SprayStore.getPesticides();
    var grace = window.SprayStore.graceState(eventId);

    var plotHtml = plots.map(function (p) {
      var on = (ev.plotIds || []).indexOf(p.id) !== -1;
      return '<label class="se-plot"><input type="checkbox" class="se-plot-cb" value="' + p.id + '"' +
        (on ? ' checked' : '') + '> ' + esc(p.name) + '</label>';
    }).join('');

    var appHtml = (ev.applications || []).map(function (a, i) { return renderAppRow(a, i); }).join('');

    var catOpts = '<option value="">' + tt('הוסף חומר…', 'เพิ่มสาร…', 'أضف مادة…') + '</option>' +
      cat.map(function (p) {
        return '<option value="' + p.id + '">' + esc(p.productName || '') +
               (p.activeIngredient ? ' (' + esc(p.activeIngredient) + ')' : '') + '</option>';
      }).join('');

    var revHtml = '';
    if (ev.revisions && ev.revisions.length) {
      revHtml = '<div class="se-revlog"><div class="se-revlog-title">' +
        tt('היסטוריית עריכות', 'ประวัติการแก้ไข', 'سجل التعديلات') + '</div>' +
        ev.revisions.slice().reverse().map(function (r) {
          return '<div class="se-rev">' +
            '<div class="se-rev-head">' + new Date(r.at).toLocaleString('he-IL') +
            ' · ' + esc(r.byName || r.by || '') + '</div>' +
            '<div class="se-rev-reason">' + esc(r.reason || '') + '</div>' +
            (r.changes || []).map(function (c) {
              return '<div class="se-rev-change">' + esc(c.label) + ': ' +
                     esc(c.from) + ' → ' + esc(c.to) + '</div>';
            }).join('') + '</div>';
        }).join('') + '</div>';
    }

    // Danger zone adapts to the record's age and state.
    var danger = '<div class="se-danger"><div class="se-danger-title">' +
      tt('הסרת הרשומה', 'ลบบันทึก', 'إزالة السجل') + '</div>';
    if (ev.voided) {
      danger += '<div class="se-danger-hint">' +
        tt('רשומה זו מבוטלת מאז ', 'ยกเลิกตั้งแต่ ', 'ملغى منذ ') +
        new Date(ev.voided.at).toLocaleDateString('he-IL') +
        (ev.voided.reason ? ' — ' + esc(ev.voided.reason) : '') + '</div>' +
        '<button type="button" class="se-unvoid" onclick="SprayEdit.unvoid()">↩ ' +
        tt('בטל את הביטול', 'ยกเลิกการยกเลิก', 'إلغاء الإبطال') + '</button>';
    } else if (grace.eligible) {
      danger += '<div class="se-danger-hint">' +
        tt('נוצרה זה עתה ולא נצפתה — ניתן למחוק לחלוטין עוד ' + grace.minutesLeft + ' דקות.',
           'เพิ่งสร้างและยังไม่ถูกดู — ลบถาวรได้อีก ' + grace.minutesLeft + ' นาที',
           'أُنشئ للتو ولم يُقرأ — يمكن حذفه نهائيًا خلال ' + grace.minutesLeft + ' دقائق.') + '</div>' +
        '<button type="button" class="se-hard" onclick="SprayEdit.hardDelete()">🗑 ' +
        tt('מחק — נוצרה בטעות', 'ลบ — สร้างผิดพลาด', 'حذف — أُنشئ بالخطأ') + '</button>' +
        '<button type="button" class="se-void" onclick="SprayEdit.voidRec()">🚫 ' +
        tt('בטל רשומה במקום', 'ยกเลิกบันทึกแทน', 'إبطال السجل بدلًا') + '</button>';
    } else {
      danger += '<div class="se-danger-hint">' +
        tt('חלון המחיקה נסגר. ניתן לבטל את הרשומה — היא תישמר, תסומן כמבוטלת ותוצא מיומן הריסוסים הפעיל.',
           'หมดเวลาลบแล้ว ยกเลิกได้ — บันทึกจะถูกเก็บและทำเครื่องหมายว่ายกเลิก',
           'انتهت نافذة الحذف. يمكن إبطال السجل — يُحفظ ويُوسم كملغى ويُستبعد من السجل الفعّال.') + '</div>' +
        '<button type="button" class="se-void" onclick="SprayEdit.voidRec()">🚫 ' +
        tt('בטל רשומה', 'ยกเลิกบันทึก', 'إبطال السجل') + '</button>';
    }
    danger += '</div>';

    var modal = document.getElementById('modalContainer');
    modal.innerHTML =
      '<div class="se-backdrop">' +
        '<div class="se-modal">' +
          '<h3 class="se-title">✏️ ' + tt('עריכת רשומת ריסוס', 'แก้ไขบันทึกการพ่น', 'تعديل سجل الرش') + '</h3>' +
          '<div class="se-warn">' + tt('כל שינוי נרשם ביומן העריכות ובלוג הביקורת.',
                                       'การเปลี่ยนแปลงทุกครั้งจะถูกบันทึก',
                                       'كل تغيير يُسجَّل في سجل التعديلات والتدقيق.') + '</div>' +

          '<label class="se-label">' + tt('תאריך', 'วันที่', 'التاريخ') + '</label>' +
          '<input type="date" id="seDate" class="form-input" value="' + esc(ev.date || '') +
            '" max="' + todayISO() + '">' +

          '<label class="se-label">' + tt('שם המפעיל', 'ชื่อผู้ปฏิบัติงาน', 'اسم المشغّل') + '</label>' +
          '<input type="text" id="seOperator" class="form-input" value="' + esc(ev.operator || '') + '">' +

          '<div class="se-two">' +
            '<div><label class="se-label">' + tt('נפח לעץ', 'ปริมาตรต่อต้น', 'حجم لكل شجرة') + '</label>' +
            '<input type="number" step="0.1" min="0" id="seVolume" class="form-input" value="' +
              (ev.volumePerTree || 0) + '"></div>' +
            '<div><label class="se-label">' + tt('קיבולת מרסס', 'ความจุถังพ่น', 'سعة الرشاش') + '</label>' +
            '<input type="number" step="1" min="0" id="seCapacity" class="form-input" value="' +
              (ev.sprayerCapacity || 0) + '"></div>' +
          '</div>' +

          '<label class="se-label">' + tt('חלקות', 'แปลง', 'القطع') + '</label>' +
          '<div class="se-plots">' + plotHtml + '</div>' +

          '<label class="se-label">' + tt('חומרים', 'สารเคมี', 'المواد') + '</label>' +
          '<div id="seApps" class="se-apps">' + appHtml + '</div>' +
          '<select id="seAddApp" class="form-input se-add">' + catOpts + '</select>' +

          '<label class="se-label se-req">' + tt('סיבת העריכה (חובה)', 'เหตุผลการแก้ไข (จำเป็น)', 'سبب التعديل (إلزامي)') + '</label>' +
          chipsHtml('seReason') +
          '<textarea id="seReason" class="form-input" rows="2"></textarea>' +

          revHtml + danger +

          '<div class="se-actions">' +
            '<button type="button" class="se-save" onclick="SprayEdit.save()">' +
              tt('שמור שינויים', 'บันทึก', 'حفظ التغييرات') + '</button>' +
            '<button type="button" class="se-cancel" onclick="SprayEdit.close()">' +
              tt('ביטול', 'ยกเลิก', 'إغلاق') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('seAddApp').addEventListener('change', function () {
      var id = parseInt(this.value, 10);
      if (isNaN(id)) return;
      var p = cat.find(function (x) { return x.id === id; });
      if (!p) return;
      var host = document.getElementById('seApps');
      var wrap = document.createElement('div');
      wrap.innerHTML = renderAppRow({
        productName: p.productName, activeIngredient: p.activeIngredient,
        concentration: 0, target: ''
      }, host.children.length);
      host.appendChild(wrap.firstChild);
      this.value = '';
    });
  }

  function renderAppRow(a, i) {
    return '<div class="se-app" data-idx="' + i + '">' +
      '<div class="se-app-name">' + esc(a.productName || '') +
        (a.activeIngredient ? ' <span class="se-app-ai">(' + esc(a.activeIngredient) + ')</span>' : '') +
        '<button type="button" class="se-app-del" onclick="SprayEdit.removeApp(this)">✕</button>' +
      '</div>' +
      '<div class="se-app-fields">' +
        '<input type="number" step="0.01" min="0" class="form-input se-app-conc" value="' +
          (a.concentration != null ? a.concentration : 0) + '" placeholder="%">' +
        '<input type="text" class="form-input se-app-target" list="sprayTargetOptions" value="' +
          esc(a.target || '') + '" placeholder="' +
          esc(tt('מזיק / מחלה', 'ศัตรูพืช / โรค', 'آفة / مرض')) + '">' +
      '</div>' +
      '<input type="hidden" class="se-app-product" value="' + esc(a.productName || '') + '">' +
      '<input type="hidden" class="se-app-ai" value="' + esc(a.activeIngredient || '') + '">' +
    '</div>';
  }

  function removeApp(btn) {
    var row = btn.closest('.se-app');
    if (row) row.parentNode.removeChild(row);
  }

  function collect() {
    var plotIds = [];
    document.querySelectorAll('.se-plot-cb:checked').forEach(function (cb) {
      plotIds.push(parseInt(cb.value, 10));
    });
    var apps = [];
    document.querySelectorAll('#seApps .se-app').forEach(function (row) {
      apps.push({
        productName: row.querySelector('.se-app-product').value,
        activeIngredient: row.querySelector('input.se-app-ai').value,
        concentration: parseFloat(row.querySelector('.se-app-conc').value) || 0,
        target: row.querySelector('.se-app-target').value.trim()
      });
    });
    return {
      date: document.getElementById('seDate').value,
      operator: document.getElementById('seOperator').value.trim(),
      volumePerTree: parseFloat(document.getElementById('seVolume').value) || 0,
      sprayerCapacity: parseFloat(document.getElementById('seCapacity').value) || 0,
      plotIds: plotIds,
      applications: apps
    };
  }

  function save() {
    var reason = document.getElementById('seReason').value.trim();
    if (!reason) {
      toast('❌ ' + tt('חובה לציין סיבת עריכה', 'ต้องระบุเหตุผลการแก้ไข', 'يجب ذكر سبب التعديل'));
      return;
    }
    var patch = collect();
    if (!patch.date) { toast('❌ ' + tt('חובה תאריך', 'ต้องมีวันที่', 'التاريخ إلزامي')); return; }
    if (patch.date > todayISO()) {
      toast('❌ ' + tt('לא ניתן לתארך ריסוס לעתיד', 'ไม่สามารถลงวันที่อนาคต', 'لا يمكن التأريخ للمستقبل'));
      return;
    }
    if (!patch.operator) { toast('❌ ' + tt('חובה שם מפעיל', 'ต้องมีชื่อผู้ปฏิบัติงาน', 'اسم المشغّل إلزامي')); return; }
    if (!patch.plotIds.length) { toast('❌ ' + tt('בחר לפחות חלקה אחת', 'เลือกอย่างน้อยหนึ่งแปลง', 'اختر قطعة واحدة على الأقل')); return; }
    if (!patch.applications.length) { toast('❌ ' + tt('חייב לפחות חומר אחד', 'ต้องมีสารอย่างน้อยหนึ่ง', 'مادة واحدة على الأقل')); return; }

    // One record = one מטע. An edit may move a record to another farm, but
    // it may never fold two growers' plots back into one record — that is
    // what per-farm reporting depends on.
    var _farms = {};
    (window.SprayStore.getPlots() || []).forEach(function (p) {
      if (patch.plotIds.indexOf(p.id) !== -1) _farms[(p.farm_id || 0)] = true;
    });
    var _fkeys = Object.keys(_farms);
    if (_fkeys.length > 1) {
      toast('❌ ' + tt('רשומה אחת = מטע אחד. רשום רשומה נפרדת למטע השני',
                      'หนึ่งบันทึก = หนึ่งสวน',
                      'سجل واحد = بستان واحد'));
      return;
    }
    patch.farmId = parseInt(_fkeys[0], 10) || null;

    var res = window.SprayStore.updateEvent(editingId, patch, reason, diff);
    if (!res || !res.ok) { toast('❌ ' + tt('העריכה נכשלה', 'แก้ไขไม่สำเร็จ', 'فشل التعديل')); return; }
    if (res.changes === 0) {
      toast('ℹ ' + tt('לא בוצעו שינויים', 'ไม่มีการเปลี่ยนแปลง', 'لا تغييرات'));
    } else {
      toast('✅ ' + tt('נשמר · ' + res.changes + ' שינויים נרשמו',
                      'บันทึกแล้ว · ' + res.changes + ' การเปลี่ยนแปลง',
                      'حُفظ · ' + res.changes + ' تغييرات'));
    }
    close();
  }

  function hardDelete() {
    if (!confirm(tt('למחוק את הרשומה לחלוטין? הפעולה בלתי הפיכה.',
                    'ลบบันทึกถาวรหรือไม่? ย้อนกลับไม่ได้',
                    'حذف السجل نهائيًا؟ لا يمكن التراجع.'))) return;
    var res = window.SprayStore.deleteWithinGrace(editingId);
    if (!res || !res.ok) {
      toast('❌ ' + (res && res.err === 'grace-expired'
        ? tt('חלון המחיקה נסגר — בטל את הרשומה במקום',
             'หมดเวลาลบ — ยกเลิกบันทึกแทน',
             'انتهت نافذة الحذف — أبطل السجل بدلًا')
        : tt('המחיקה נכשלה', 'ลบไม่สำเร็จ', 'فشل الحذف')));
      return;
    }
    toast('🗑 ' + tt('הרשומה נמחקה', 'ลบบันทึกแล้ว', 'حُذف السجل'));
    close();
  }

  function voidRec() {
    var reason = document.getElementById('seReason').value.trim();
    if (!reason) {
      toast('❌ ' + tt('ציין סיבה בשדה "סיבת העריכה" לפני ביטול',
                      'ระบุเหตุผลก่อนยกเลิก',
                      'اذكر السبب قبل الإبطال'));
      return;
    }
    if (!confirm(tt('לבטל את הרשומה? היא תישמר ותסומן כמבוטלת.',
                    'ยกเลิกบันทึก? จะถูกเก็บและทำเครื่องหมาย',
                    'إبطال السجل؟ سيُحفظ ويُوسم كملغى.'))) return;
    var res = window.SprayStore.voidEvent(editingId, reason);
    if (!res || !res.ok) { toast('❌ ' + tt('הביטול נכשל', 'ยกเลิกไม่สำเร็จ', 'فشل الإبطال')); return; }
    toast('🚫 ' + tt('הרשומה בוטלה', 'ยกเลิกบันทึกแล้ว', 'أُبطل السجل'));
    close();
  }

  function unvoid() {
    var reason = document.getElementById('seReason').value.trim();
    var res = window.SprayStore.unvoidEvent(editingId, reason);
    if (!res || !res.ok) { toast('❌ ' + tt('הפעולה נכשלה', 'ไม่สำเร็จ', 'فشلت العملية')); return; }
    toast('↩ ' + tt('הרשומה שוחזרה', 'กู้คืนบันทึกแล้ว', 'استُعيد السجل'));
    close();
  }

  function close() {
    editingId = null;
    var modal = document.getElementById('modalContainer');
    if (modal) modal.innerHTML = '';
  }

  // spray-bulk.js needs the same field diff so batch edits record real
  // change lists rather than empty ones.
  window.SprayEditDiff = diff;

  return {
    diff: diff,
    open: open, save: save, close: close, removeApp: removeApp,
    hardDelete: hardDelete, voidRec: voidRec, unvoid: unvoid,
    fillReason: fillReason, canEdit: canEdit
  };
})();
window.SprayEdit = SprayEdit;
