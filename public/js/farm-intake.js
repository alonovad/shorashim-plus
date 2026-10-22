/* farm-intake.js — stock and equipment from photos and documents (Oct 2026)
 *
 * A special mode per משק, switched on only by an admin ("admin approval").
 * When it is on, staff of that farm can photograph or upload an invoice,
 * delivery note, receipt, stock list, or a photo of a product or machine.
 * The original is kept in Storage (farm-docs/{farmId}/…), the Cloud
 * Function inventoryExtract reads it, and the person reviews every line
 * before anything is added:
 *   pesticide matched to the catalogue → farm.pesticide_inventory
 *   other consumables / fertilizers     → farm.stock_items (merged)
 *   equipment                           → farm.equipment
 * The function itself refuses farms where the mode is off, so the switch is
 * enforced on the server, not only by hiding a button.
 *
 * Public: FarmIntake.sectionHtml(farmId), FarmIntake.bind(farmId),
 *         FarmIntake.open(farmId)
 */
var FarmIntake = (function () {
  'use strict';

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
  function toast(m) { if (typeof showToast === 'function') showToast(m); }
  function store() { return window.SprayStore || {}; }
  function user() { return window.currentUser || {}; }
  function isAdmin() { return user().role === 'admin'; }
  function fmt(n) { n = Number(n) || 0; return (Math.round(n * 100) / 100).toLocaleString('he-IL'); }

  var KIND = {
    pesticide:  { ico: '🧪', he: 'חומר הדברה', th: 'สารเคมี', ar: 'مبيد' },
    fertilizer: { ico: '🌱', he: 'דשן', th: 'ปุ๋ย', ar: 'سماد' },
    equipment:  { ico: '🚜', he: 'ציוד', th: 'อุปกรณ์', ar: 'معدات' },
    other:      { ico: '📦', he: 'אחר', th: 'อื่นๆ', ar: 'أخرى' }
  };
  var DOC_TYPE = {
    invoice: 'חשבונית', delivery_note: 'תעודת משלוח', receipt: 'קבלה', equipment_photo: 'תמונת ציוד',
    product_photo: 'תמונת מוצר', stock_list: 'רשימת מלאי', other: 'מסמך'
  };
  var SPRAYER = [['airblast', 'מרסס מפוח (תותח)'], ['gun', 'מרסס רובה / צינור'], ['boom', 'מרסס מוט'], ['backpack', 'מרסס גב'], ['drench', 'מכל הגמעה']];
  function kindLabel(k) { var d = KIND[k] || KIND.other; return d.ico + ' ' + tt(d.he, d.th, d.ar); }

  // ── Farm detail section ──
  function sectionHtml(farmId) {
    var S = store();
    if (!S.getFarmIntake) return '';
    var info = S.getFarmIntake(farmId);
    if (!info) return '';
    var can = S.canUseIntake && S.canUseIntake(farmId);
    var h = '';
    h += '<div class="section-title" style="margin-top: 14px;">📄 ' +
      tt('קליטת מלאי וציוד ממסמכים', 'รับสต็อกจากเอกสาร', 'استلام المخزون من المستندات') + '</div>';
    if (!info.enabled) {
      h += '<div class="fi-off">' + tt('מצב זה דורש אישור אדמין למשק.', 'ต้องได้รับอนุมัติจากแอดมิน', 'يتطلب موافقة المسؤول') + '</div>';
    } else {
      h += '<div class="fi-on">✅ ' + tt('מאושר', 'อนุมัติแล้ว', 'معتمد') +
        (info.approvedBy ? ' · ' + esc(info.approvedBy) : '') +
        (info.approvedAt ? ' · ' + new Date(info.approvedAt).toLocaleDateString('he-IL') : '') + '</div>';
    }
    if (can) {
      h += '<button class="btn-admin fi-btn" id="fiOpen" type="button">📷 ' +
        tt('קליטה מתמונה / מסמך', 'รับจากรูป/เอกสาร', 'استلام من صورة/مستند') + '</button>';
    }
    if (isAdmin()) {
      h += '<button class="fi-btn fi-ghost" id="fiToggle" type="button">' +
        (info.enabled ? '⛔ ' + tt('בטל אישור', 'ยกเลิกอนุมัติ', 'إلغاء الموافقة') : '✔️ ' + tt('אשר מצב קליטה למשק זה', 'อนุมัติสำหรับฟาร์มนี้', 'الموافقة لهذه المزرعة')) +
        '</button>';
    }
    if (info.stock.length) {
      h += '<div class="fi-sub">' + tt('מלאי שנקלט', 'สต็อกที่รับเข้า', 'المخزون المستلم') + '</div><div class="fi-stock">' +
        info.stock.map(function (s) {
          return '<div class="fi-st"><span>' + (KIND[s.kind] || KIND.other).ico + ' ' + esc(s.name) + '</span>' +
            '<b>' + fmt(s.qty) + ' ' + esc(s.unit || '') + '</b>' +
            (can || isAdmin() ? '<button type="button" class="fi-st-edit" data-fi-stock="' + s.id + '" title="' + esc(tt('עדכון כמות', 'แก้ไข', 'تعديل')) + '">✏️</button>' : '') +
            '</div>';
        }).join('') + '</div>';
    }
    if (info.docs.length) {
      h += '<div class="fi-sub">' + tt('מסמכים שנקלטו', 'เอกสารที่รับ', 'المستندات المستلمة') + '</div><div class="fi-docs">' +
        info.docs.slice(0, 8).map(function (d) {
          return '<button type="button" class="fi-doc" data-fi-doc="' + esc(d.path) + '">' +
            '<span>' + esc(tt(DOC_TYPE[d.type] || 'מסמך')) + (d.supplier ? ' · ' + esc(d.supplier) : '') + (d.doc_no ? ' #' + esc(d.doc_no) : '') + '</span>' +
            '<small>' + (d.doc_date || new Date(d.at).toLocaleDateString('he-IL')) + ' · ' + d.items + ' ' + tt('שורות', 'แถว', 'سطور') + '</small></button>';
        }).join('') + '</div>';
    }
    return '<div class="fi-wrap">' + h + '</div>';
  }

  function bind(farmId) {
    var o = document.getElementById('fiOpen');
    if (o) o.addEventListener('click', function () { open(farmId); });
    var tg = document.getElementById('fiToggle');
    if (tg) tg.addEventListener('click', function () {
      var info = store().getFarmIntake(farmId);
      var on = !(info && info.enabled);
      if (!confirm(on
        ? tt('לאשר קליטת מלאי וציוד ממסמכים למשק', 'อนุมัติ?', 'الموافقة؟') + ' "' + (info ? info.name : '') + '"?\n' +
          tt('כל קריאת מסמך נשלחת לשירות קריאה אוטומטי ועולה כסף.', 'การอ่านเอกสารแต่ละครั้งมีค่าใช้จ่าย', 'كل قراءة لها تكلفة')
        : tt('לבטל את מצב הקליטה למשק זה?', 'ยกเลิก?', 'إلغاء؟'))) return;
      var r = store().setFarmIntake(farmId, on);
      if (r && r.ok) { toast(on ? '✅ ' + tt('המצב אושר למשק', 'อนุมัติแล้ว', 'تمت الموافقة') : '⛔ ' + tt('המצב בוטל', 'ยกเลิกแล้ว', 'أُلغي')); refresh(farmId); }
    });
    document.querySelectorAll('[data-fi-doc]').forEach(function (b) {
      b.addEventListener('click', function () { openDoc(b.getAttribute('data-fi-doc')); });
    });
    document.querySelectorAll('[data-fi-stock]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = Number(b.getAttribute('data-fi-stock'));
        var info = store().getFarmIntake(farmId);
        var st = info && info.stock.find(function (x) { return x.id === id; });
        if (!st) return;
        var v = prompt(tt('כמות חדשה עבור', 'จำนวนใหม่', 'كمية جديدة') + ' ' + st.name + ' (0 = ' + tt('הסר', 'ลบ', 'إزالة') + ')', st.qty);
        if (v === null) return;
        store().setStockQty(farmId, id, v);
        refresh(farmId);
      });
    });
  }

  function refresh(farmId) {
    if (typeof window.showFarmDetailsGlobal === 'function') window.showFarmDetailsGlobal(farmId);
  }

  function openDoc(path) {
    if (!path || !window.firebase || !firebase.storage) return;
    firebase.storage().ref(path).getDownloadURL().then(function (u) { window.open(u, '_blank', 'noopener'); },
      function () { toast('❌ ' + tt('לא ניתן לפתוח את המסמך', 'เปิดไม่ได้', 'تعذر الفتح')); });
  }

  // ── File preparation ──
  function readB64(blob) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(String(fr.result).split(',')[1] || ''); };
      fr.onerror = function () { rej(new Error('read')); };
      fr.readAsDataURL(blob);
    });
  }
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var sc = Math.min(1, 2000 / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        var cx = cv.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  function prepare(file) {
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    if (isPdf) {
      if (file.size > 6.5 * 1024 * 1024) return Promise.reject(new Error(tt('קובץ PDF גדול מדי (עד 6.5MB)', 'PDF ใหญ่เกินไป', 'ملف PDF كبير جدًا')));
      return readB64(file).then(function (b) { return { pdf: b, blob: file, ext: 'pdf', type: 'application/pdf' }; });
    }
    return compress(file).then(function (blob) {
      return readB64(blob).then(function (b) { return { image: b, blob: blob, ext: 'jpg', type: 'image/jpeg' }; });
    });
  }
  function upload(farmId, prep, idx) {
    if (!window.firebase || !firebase.storage) return Promise.resolve('');
    var path = 'farm-docs/' + farmId + '/' + Date.now() + '-' + idx + '.' + prep.ext;
    return firebase.storage().ref(path).put(prep.blob, { contentType: prep.type })
      .then(function () { return path; }, function () { return ''; });   // reading still proceeds
  }

  // ── Catalogue matching ──
  function catalogue() { return (store().getPesticides ? store().getPesticides() : []); }
  function catalogueNames() {
    var seen = {}, out = [];
    catalogue().forEach(function (p) { var n = String(p.productName || '').trim(); if (n && !seen[n]) { seen[n] = 1; out.push(n); } });
    return out;
  }
  function norm(s) { return String(s || '').replace(/["'״׳\s\-]/g, '').toLowerCase(); }
  function matchPesticide(item) {
    var cat = catalogue();
    var want = item.catalogue_match || item.name;
    var hit = cat.find(function (p) { return p.productName === want; }) ||
      cat.find(function (p) { var a = norm(p.productName), b = norm(item.name); return a && b && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1); });
    return hit ? hit.id : 0;
  }

  // ── Modal flow ──
  var S = null;   // { farmId, files, results:[{name, path, res|err}], items:[...] }

  function open(farmId) {
    if (!store().canUseIntake || !store().canUseIntake(farmId)) {
      toast('⛔ ' + tt('מצב הקליטה לא אושר למשק זה', 'ยังไม่อนุมัติ', 'غير معتمد'));
      return;
    }
    S = { farmId: farmId, files: [], results: [], items: [], busy: false, hint: '' };
    drawPick();
  }
  function modal(inner) {
    var c = document.getElementById('modalContainer');
    c.innerHTML = '<div class="modal-overlay" id="fiOverlay"><div class="modal fi-modal">' + inner + '</div></div>';
    return c;
  }
  function close() { document.getElementById('modalContainer').innerHTML = ''; S = null; }

  function drawPick(status) {
    var info = store().getFarmIntake(S.farmId) || {};
    modal(
      '<h2>📷 ' + tt('קליטה מתמונה / מסמך', 'รับจากรูป/เอกสาร', 'استلام من صورة/مستند') + ' — ' + esc(info.name || '') + '</h2>' +
      '<p>' + tt('צלם או העלה חשבונית, תעודת משלוח, רשימת מלאי, או תמונה של מוצר או כלי. כל שורה תוצג לאישורך לפני שתתווסף.',
        'ถ่ายรูปหรืออัปโหลดเอกสาร แต่ละรายการจะให้ตรวจก่อนเพิ่ม', 'صوّر أو ارفع مستندًا؛ ستراجع كل سطر قبل الإضافة') + '</p>' +
      '<label class="fi-drop"><input type="file" id="fiFiles" accept="image/*,application/pdf" multiple hidden>' +
        '<span>' + (S.files.length ? S.files.map(function (f) { return '📎 ' + esc(f.name); }).join('<br>') :
          '➕ ' + tt('בחר קבצים / צלם', 'เลือกไฟล์ / ถ่ายรูป', 'اختر ملفات / صوّر')) + '</span></label>' +
      '<div class="form-group"><label class="form-label">' + tt('הערה לקורא (לא חובה)', 'หมายเหตุ (ไม่บังคับ)', 'ملاحظة (اختياري)') + '</label>' +
        '<input class="form-input" id="fiHint" value="' + esc(S.hint) + '" placeholder="' + esc(tt('למשל: מרסס חדש שהגיע למשק', 'เช่น ถังพ่นใหม่', 'مثلاً: رشاش جديد')) + '"></div>' +
      (status ? '<div class="fi-status">' + status + '</div>' : '') +
      '<div class="modal-buttons">' +
        '<button class="btn btn-primary" id="fiRead"' + (S.files.length && !S.busy ? '' : ' disabled') + '>🔍 ' + tt('קרא', 'อ่าน', 'اقرأ') + '</button>' +
        '<button class="btn btn-secondary" id="fiCancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
      '</div>');
    document.getElementById('fiFiles').addEventListener('change', function () {
      S.files = Array.prototype.slice.call(this.files || [], 0, 8);
      S.hint = document.getElementById('fiHint').value;
      drawPick();
    });
    document.getElementById('fiCancel').addEventListener('click', close);
    document.getElementById('fiRead').addEventListener('click', function () {
      S.hint = document.getElementById('fiHint').value;
      readAll();
    });
  }

  function readAll() {
    if (!window.firebase || !firebase.app().functions) { toast('❌ functions'); return; }
    var fn = firebase.app().functions('us-central1').httpsCallable('inventoryExtract', { timeout: 300000 });
    var names = catalogueNames();
    S.busy = true; S.results = [];
    var i = 0;
    function step() {
      if (!S) return;
      if (i >= S.files.length) { S.busy = false; buildItems(); drawReview(); return; }
      var f = S.files[i], idx = i++;
      drawPick('⏳ ' + tt('קורא', 'กำลังอ่าน', 'جارٍ القراءة') + ' ' + (idx + 1) + '/' + S.files.length + ' — ' + esc(f.name));
      prepare(f).then(function (prep) {
        return upload(S.farmId, prep, idx).then(function (path) {
          var req = { farmId: S.farmId, catalogue: names, hint: S.hint };
          if (prep.pdf) req.pdf = prep.pdf; else req.image = prep.image;
          return fn(req).then(function (r) { S.results.push({ name: f.name, path: path, res: r.data }); });
        });
      }).catch(function (e) {
        S && S.results.push({ name: f.name, err: (e && e.message) || String(e) });
      }).then(step);
    }
    step();
  }

  function buildItems() {
    S.items = [];
    S.results.forEach(function (r, di) {
      if (!r.res) return;
      (r.res.items || []).forEach(function (it) {
        var x = JSON.parse(JSON.stringify(it));
        x.doc = di;
        x.on = true;
        if (x.kind === 'pesticide') x.pesticide_id = matchPesticide(x);
        if (x.kind === 'equipment' && !x.equipment_type) x.equipment_type = 'tool';
        S.items.push(x);
      });
    });
  }

  function catOptions(sel) {
    return '<option value="0">' + tt('— לא בקטלוג (יישמר כמלאי כללי) —', '— ไม่อยู่ในแคตตาล็อก —', '— ليس في الكتالوج —') + '</option>' +
      catalogue().map(function (p) {
        return '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.productName) + (p.crop ? ' · ' + esc(p.crop) : '') + '</option>';
      }).join('');
  }

  function drawReview() {
    var errs = S.results.filter(function (r) { return r.err; });
    var head = S.results.filter(function (r) { return r.res; }).map(function (r) {
      var d = r.res;
      return '<div class="fi-dochead">📄 ' + esc(tt(DOC_TYPE[d.doc_type] || 'מסמך')) + (d.supplier ? ' · ' + esc(d.supplier) : '') +
        (d.doc_no ? ' #' + esc(d.doc_no) : '') + (d.doc_date ? ' · ' + esc(d.doc_date) : '') +
        (d.notes ? '<small>' + esc(d.notes) + '</small>' : '') + '</div>';
    }).join('');
    var rows = S.items.map(function (it, i) {
      var k = it.kind;
      var extra = '';
      if (k === 'pesticide') {
        extra = '<select class="form-input fi-cat" data-i="' + i + '">' + catOptions(it.pesticide_id) + '</select>';
      } else if (k === 'equipment') {
        extra = '<div class="fi-eq"><select class="form-input fi-eqt" data-i="' + i + '">' +
          [['sprayer', '💨 ' + tt('מרסס', 'ถังพ่น', 'رشاش')], ['vehicle', '🚜 ' + tt('רכב', 'รถ', 'مركبة')], ['tool', '🔧 ' + tt('כלי', 'เครื่องมือ', 'أداة')]].map(function (o) {
            return '<option value="' + o[0] + '"' + (it.equipment_type === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') + '</select>' +
          (it.equipment_type === 'sprayer' ?
            '<select class="form-input fi-spk" data-i="' + i + '"><option value="">—</option>' + SPRAYER.map(function (o) {
              return '<option value="' + o[0] + '"' + (it.sprayer_kind === o[0] ? ' selected' : '') + '>' + esc(o[1]) + '</option>';
            }).join('') + '</select>' +
            '<input class="form-input fi-cap" data-i="' + i + '" type="number" min="0" value="' + (it.capacity_l || '') + '" placeholder="' + esc(tt('נפח (ל׳)', 'ลิตร', 'لتر')) + '">' : '') +
          '</div>';
      }
      return '<div class="fi-row' + (it.on ? '' : ' off') + (it.confidence === 'low' ? ' low' : '') + '">' +
        '<div class="fi-r1"><input type="checkbox" class="fi-on" data-i="' + i + '"' + (it.on ? ' checked' : '') + '>' +
          '<select class="form-input fi-kind" data-i="' + i + '">' + Object.keys(KIND).map(function (kk) {
            return '<option value="' + kk + '"' + (kk === k ? ' selected' : '') + '>' + kindLabel(kk) + '</option>';
          }).join('') + '</select>' +
          (it.confidence === 'low' ? '<span class="fi-low" title="' + esc(tt('קריאה לא ודאית — בדוק', 'ไม่แน่ใจ', 'غير مؤكد')) + '">⚠️</span>' : '') + '</div>' +
        '<div class="fi-r2"><input class="form-input fi-name" data-i="' + i + '" value="' + esc(it.name) + '">' +
          '<input class="form-input fi-qty" data-i="' + i + '" type="number" step="any" min="0" value="' + (it.qty || 0) + '">' +
          '<input class="form-input fi-unit" data-i="' + i + '" value="' + esc(it.unit || '') + '" placeholder="' + esc(tt('יחידה', 'หน่วย', 'وحدة')) + '"></div>' +
        (extra ? '<div class="fi-r3">' + extra + '</div>' : '') +
        (it.notes || it.pack ? '<div class="fi-note">' + esc([it.pack, it.notes].filter(Boolean).join(' · ')) + '</div>' : '') +
      '</div>';
    }).join('');
    modal(
      '<h2>✅ ' + tt('בדיקה ואישור', 'ตรวจสอบและยืนยัน', 'المراجعة والتأكيد') + '</h2>' + head +
      (errs.length ? '<div class="fi-err">' + errs.map(function (e) { return '❌ ' + esc(e.name) + ': ' + esc(e.err); }).join('<br>') + '</div>' : '') +
      (S.items.length ? '<div class="fi-list">' + rows + '</div>' :
        '<div class="empty-state" style="padding:16px;"><p>' + tt('לא נמצאו שורות במסמך', 'ไม่พบรายการ', 'لا سطور') + '</p></div>') +
      '<div class="modal-buttons">' +
        (S.items.length ? '<button class="btn btn-primary" id="fiSave">💾 ' + tt('הוסף למשק', 'เพิ่มในฟาร์ม', 'أضف للمزرعة') + '</button>' : '') +
        '<button class="btn btn-secondary" id="fiBack">' + tt('חזרה', 'กลับ', 'رجوع') + '</button>' +
      '</div>');
    var list = document.querySelector('.fi-list');
    function at(el) { return S.items[Number(el.getAttribute('data-i'))]; }
    if (list) {
      list.addEventListener('input', function (e) {
        var it = at(e.target); if (!it) return;
        if (e.target.classList.contains('fi-name')) it.name = e.target.value;
        if (e.target.classList.contains('fi-qty')) it.qty = Number(e.target.value) || 0;
        if (e.target.classList.contains('fi-unit')) it.unit = e.target.value;
        if (e.target.classList.contains('fi-cap')) it.capacity_l = Number(e.target.value) || 0;
      });
      list.addEventListener('change', function (e) {
        var it = at(e.target); if (!it) return;
        var t = e.target.classList;
        if (t.contains('fi-on')) { it.on = e.target.checked; e.target.closest('.fi-row').classList.toggle('off', !it.on); return; }
        if (t.contains('fi-cat')) { it.pesticide_id = Number(e.target.value) || 0; return; }
        if (t.contains('fi-spk')) { it.sprayer_kind = e.target.value; return; }
        if (t.contains('fi-kind')) { it.kind = e.target.value; if (it.kind === 'pesticide' && !it.pesticide_id) it.pesticide_id = matchPesticide(it); if (it.kind === 'equipment' && !it.equipment_type) it.equipment_type = 'tool'; drawReview(); return; }
        if (t.contains('fi-eqt')) { it.equipment_type = e.target.value; drawReview(); }
      });
    }
    document.getElementById('fiBack').addEventListener('click', function () { S.files = []; drawPick(); });
    var sv = document.getElementById('fiSave');
    if (sv) sv.addEventListener('click', save);
  }

  function save() {
    var chosen = S.items.filter(function (it) { return it.on && String(it.name || '').trim(); });
    if (!chosen.length) { toast('⚠️ ' + tt('לא נבחרו שורות', 'ไม่ได้เลือก', 'لم يتم الاختيار')); return; }
    var docs = S.results.filter(function (r) { return r.res; }).map(function (r, di) {
      return { path: r.path, name: r.name, type: r.res.doc_type, supplier: r.res.supplier, doc_date: r.res.doc_date,
        doc_no: r.res.doc_no, items: chosen.filter(function (it) { return it.doc === S.results.indexOf(r); }).length };
    });
    var res = store().applyFarmIntake(S.farmId, { items: chosen, docs: docs });
    if (!res || !res.ok) { toast('⛔ ' + tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var c = res.counts;
    toast('✅ ' + [c.pest ? c.pest + ' ' + tt('חומרים למלאי', 'สาร', 'مواد') : '', c.stock ? c.stock + ' ' + tt('פריטי מלאי', 'สต็อก', 'مخزون') : '',
      c.equip ? c.equip + ' ' + tt('כלים', 'อุปกรณ์', 'معدات') : ''].filter(Boolean).join(' · '));
    var fid = S.farmId;
    close();
    refresh(fid);
  }

  return { sectionHtml: sectionHtml, bind: bind, open: open, _matchPesticide: matchPesticide };
})();
window.FarmIntake = FarmIntake;
