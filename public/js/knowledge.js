/* knowledge.js — מידע שימושי: ספרייה, מדריכים וגלריית מזיקים ומחלות (Oct 2026)
 *
 * A shared library by topic — irrigation, fittings, fertilization, spraying,
 * pests & diseases (shown as a photo gallery), general — each entry a title,
 * text, tags, an optional link and attached files (images / PDFs).
 *
 * Data:   appData/shorashim-knowledge  { items: [...] }  (operator+ write,
 *         everyone signed-in reads — firestore.rules)
 * Files:  Storage knowledge/{ts}-{i}.{ext}  (staff write, signed-in read —
 *         storage.rules). Images are compressed client-side; PDFs ≤ 20 MB.
 *
 * Public: Knowledge.open(cat?)
 */
var Knowledge = (function () {
  'use strict';

  var KEY = 'shorashim-knowledge';
  var CATS = [
    ['irrigation', '💧', 'השקיה', 'การให้น้ำ', 'الري'],
    ['fittings', '🔧', 'אביזרים וציוד', 'อุปกรณ์', 'المعدات'],
    ['fert', '🧪', 'דישון', 'ปุ๋ย', 'التسميد'],
    ['spray', '🧴', 'ריסוס והדברה', 'การพ่นยา', 'الرش والمكافحة'],
    ['pests', '🐛', 'מזיקים ומחלות', 'ศัตรูพืชและโรค', 'الآفات والأمراض'],
    ['general', '📘', 'המלצות כלליות', 'คำแนะนำทั่วไป', 'توصيات عامة']
  ];
  var D = { items: [] }, loaded = false, ui = { cat: '', q: '' }, lastSaved = '';

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
  function staff() { var r = (window.currentUser || {}).role; return r === 'admin' || r === 'operator'; }
  function catDef(k) { return CATS.find(function (c) { return c[0] === k; }) || CATS[CATS.length - 1]; }
  function catName(k) { var c = catDef(k); return tt(c[2], c[3], c[4]); }
  function uid() { return Date.now() + Math.floor(Math.random() * 1000); }

  function load() {
    return new Promise(function (resolve) {
      if (typeof DB === 'undefined') { resolve(); return; }
      DB.loadAsync(KEY).then(function (d) { if (d && Array.isArray(d.items)) D = d; loaded = true; resolve(); }, function () { resolve(); });
      if (DB.listen && !load._l) {
        load._l = true;
        DB.listen(KEY, function (d) {
          if (!d || !Array.isArray(d.items)) return;
          var s = JSON.stringify(d);
          if (s === lastSaved) return;
          D = d;
          if (document.getElementById('kbRoot') && !document.querySelector('#kbRoot .kb-ed')) render();
        });
      }
    });
  }
  function persist() {
    var clean = JSON.parse(JSON.stringify(D));
    lastSaved = JSON.stringify(clean);
    if (DB.saveAsync) return DB.saveAsync(KEY, clean).then(function () { return true; }, function (e) {
      toast('❌ ' + tt('השמירה נכשלה', 'บันทึกไม่สำเร็จ', 'فشل الحفظ') + ': ' + ((e && (e.code || e.message)) || e));
      return false;
    });
    DB.save(KEY, clean);
    return Promise.resolve(true);
  }

  // ── files ──
  function compress(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        var sc = Math.min(1, 1800 / Math.max(img.width, img.height));
        var cv = document.createElement('canvas');
        cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc);
        var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(function (b) { b ? resolve(b) : reject(new Error('encode')); }, 'image/jpeg', 0.84);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
      img.src = url;
    });
  }
  function uploadFile(file, i) {
    if (!window.firebase || !firebase.storage) return Promise.reject(new Error('no-storage'));
    var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
    var isImg = /^image\//.test(file.type || '');
    if (!isPdf && !isImg) return Promise.reject(new Error(tt('רק תמונות או PDF', 'รูปหรือ PDF เท่านั้น', 'صور أو PDF فقط')));
    if (isPdf && file.size > 20 * 1024 * 1024) return Promise.reject(new Error(tt('PDF גדול מ־20MB', 'PDF ใหญ่เกินไป', 'PDF كبير جدًا')));
    var prep = isPdf ? Promise.resolve(file) : compress(file);
    return prep.then(function (blob) {
      var ext = isPdf ? 'pdf' : 'jpg', path = 'knowledge/' + Date.now() + '-' + i + '.' + ext;
      var ref = firebase.storage().ref(path);
      return ref.put(blob, { contentType: isPdf ? 'application/pdf' : 'image/jpeg' }).then(function () { return ref.getDownloadURL(); })
        .then(function (url) { return { name: file.name || ext, path: path, url: url, type: isPdf ? 'pdf' : 'img' }; });
    });
  }

  // ── list ──
  function open(cat) {
    if (cat) ui.cat = cat;
    ensureCss();
    var go = function () { render(); };
    if (loaded) go(); else load().then(go);
  }
  function close() { var m = document.getElementById('modalContainer'); if (m) m.innerHTML = ''; }

  function filtered() {
    var q = ui.q.trim().toLowerCase();
    return (D.items || []).filter(function (it) {
      if (ui.cat && it.cat !== ui.cat) return false;
      if (!q) return true;
      return (it.title + ' ' + it.body + ' ' + (it.tags || []).join(' ')).toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
  }

  function render() {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    var list = filtered();
    var counts = {};
    (D.items || []).forEach(function (it) { counts[it.cat] = (counts[it.cat] || 0) + 1; });
    var gallery = ui.cat === 'pests';
    var body = list.length ? (gallery ? '<div class="kb-gal">' + list.map(galCard).join('') + '</div>' : list.map(card).join(''))
      : '<div class="kb-empty">' + (staff() ? tt('עוד אין כאן תכנים. לחץ "הוספה" כדי להעלות מדריך, קובץ או תמונה.', 'ยังไม่มีเนื้อหา', 'لا يوجد محتوى بعد') : tt('עוד אין כאן תכנים.', 'ยังไม่มีเนื้อหา', 'لا يوجد محتوى بعد')) + '</div>';
    m.innerHTML = '<div class="modal-overlay" id="kbRoot"><div class="modal kb">' +
      '<div class="kb-h"><h2>📚 ' + tt('מידע שימושי', 'ข้อมูลที่เป็นประโยชน์', 'معلومات مفيدة') + '</h2>' +
        (staff() ? '<button class="kb-btn pri" data-a="new">＋ ' + tt('הוספה', 'เพิ่ม', 'إضافة') + '</button>' : '') +
        '<button class="kb-btn ghost" data-a="close">✕</button></div>' +
      '<input class="form-input kb-q" id="kbQ" placeholder="🔍 ' + tt('חיפוש במדריכים, בתגיות ובטקסט', 'ค้นหา', 'بحث') + '" value="' + esc(ui.q) + '">' +
      '<div class="kb-cats"><button class="kb-cat' + (!ui.cat ? ' on' : '') + '" data-cat="">' + tt('הכל', 'ทั้งหมด', 'الكل') + ' <small>' + (D.items || []).length + '</small></button>' +
        CATS.map(function (c) { return '<button class="kb-cat' + (ui.cat === c[0] ? ' on' : '') + '" data-cat="' + c[0] + '">' + c[1] + ' ' + tt(c[2], c[3], c[4]) + (counts[c[0]] ? ' <small>' + counts[c[0]] + '</small>' : '') + '</button>'; }).join('') +
      '</div>' +
      '<div class="kb-list" id="kbList">' + body + '</div>' +
    '</div></div>';
    var root = document.getElementById('kbRoot');
    root.addEventListener('click', onClick);
    document.getElementById('kbQ').addEventListener('input', function () {
      ui.q = this.value;
      var l = filtered();
      document.getElementById('kbList').innerHTML = l.length ? (ui.cat === 'pests' ? '<div class="kb-gal">' + l.map(galCard).join('') + '</div>' : l.map(card).join('')) : '<div class="kb-empty">' + tt('לא נמצא', 'ไม่พบ', 'لا نتائج') + '</div>';
    });
  }
  function filesHtml(it) {
    return (it.files || []).map(function (f, k) {
      return f.type === 'img'
        ? '<a href="' + esc(f.url) + '" target="_blank" rel="noopener" class="kb-thumb"><img src="' + esc(f.url) + '" alt="" loading="lazy"></a>'
        : '<a href="' + esc(f.url) + '" target="_blank" rel="noopener" class="kb-file">📄 ' + esc(f.name || 'PDF') + '</a>';
    }).join('');
  }
  function card(it) {
    return '<div class="kb-card"><div class="kb-ch"><span class="kb-tag">' + catDef(it.cat)[1] + ' ' + esc(catName(it.cat)) + '</span><b>' + esc(it.title) + '</b>' +
      (staff() ? '<button class="kb-x" data-edit="' + it.id + '" title="' + tt('עריכה', 'แก้ไข', 'تعديل') + '">✏️</button>' : '') + '</div>' +
      (it.body ? '<div class="kb-body">' + esc(it.body) + '</div>' : '') +
      ((it.files || []).length ? '<div class="kb-files">' + filesHtml(it) + '</div>' : '') +
      (it.link ? '<a class="kb-link" href="' + esc(it.link) + '" target="_blank" rel="noopener">🔗 ' + esc(it.link.replace(/^https?:\/\//, '').slice(0, 60)) + '</a>' : '') +
      ((it.tags || []).length ? '<div class="kb-tags">' + it.tags.map(function (t) { return '<span>#' + esc(t) + '</span>'; }).join('') + '</div>' : '') +
    '</div>';
  }
  function galCard(it) {
    var img = (it.files || []).find(function (f) { return f.type === 'img'; });
    return '<div class="kb-gc" data-view="' + it.id + '">' +
      (img ? '<img src="' + esc(img.url) + '" alt="" loading="lazy">' : '<div class="kb-noimg">🐛</div>') +
      '<div class="kb-gt"><b>' + esc(it.title) + '</b>' + (it.body ? '<small>' + esc(it.body.slice(0, 70)) + (it.body.length > 70 ? '…' : '') + '</small>' : '') + '</div></div>';
  }
  function view(id) {
    var it = (D.items || []).find(function (x) { return String(x.id) === String(id); });
    if (!it) return;
    var list = document.getElementById('kbList');
    list.innerHTML = '<button class="kb-btn ghost" data-a="back">→ ' + tt('חזרה לגלריה', 'กลับ', 'رجوع') + '</button>' + card(it);
  }

  function onClick(e) {
    var t = e.target;
    if (t.id === 'kbRoot') return close();
    var a = t.closest('[data-a]');
    if (a) {
      var k = a.getAttribute('data-a');
      if (k === 'close') return close();
      if (k === 'new') return editor(null);
      if (k === 'back') return render();
    }
    var c = t.closest('[data-cat]');
    if (c) { ui.cat = c.getAttribute('data-cat'); return render(); }
    var ed = t.closest('[data-edit]');
    if (ed) return editor(ed.getAttribute('data-edit'));
    var v = t.closest('[data-view]');
    if (v) return view(v.getAttribute('data-view'));
  }

  // ── editor (staff) ──
  function editor(id) {
    if (!staff()) return;
    var it = id ? JSON.parse(JSON.stringify((D.items || []).find(function (x) { return String(x.id) === String(id); }) || {})) : { cat: ui.cat || 'general', files: [], tags: [] };
    var list = document.getElementById('kbList');
    function draw() {
      list.innerHTML = '<div class="kb-ed">' +
        '<div class="kb-g2"><label>' + tt('נושא', 'หัวข้อ', 'الموضوع') + '<select class="form-input" id="kbCat">' +
          CATS.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === it.cat ? ' selected' : '') + '>' + c[1] + ' ' + tt(c[2], c[3], c[4]) + '</option>'; }).join('') + '</select></label>' +
          '<label>' + tt('כותרת', 'ชื่อเรื่อง', 'العنوان') + '<input class="form-input" id="kbTitle" value="' + esc(it.title || '') + '" placeholder="' + esc(tt('למשל: חדקונית הדקל האדומה — סימני נגיעות', 'เช่น…', 'مثلاً…')) + '"></label></div>' +
        '<label>' + tt('תוכן / הסבר', 'เนื้อหา', 'المحتوى') + '<textarea class="form-input" id="kbBody" rows="6">' + esc(it.body || '') + '</textarea></label>' +
        '<div class="kb-g2"><label>' + tt('קישור (לא חובה)', 'ลิงก์', 'رابط') + '<input class="form-input" id="kbLink" value="' + esc(it.link || '') + '" placeholder="https://"></label>' +
          '<label>' + tt('תגיות (מופרדות בפסיק)', 'แท็ก', 'وسوم') + '<input class="form-input" id="kbTags" value="' + esc((it.tags || []).join(', ')) + '"></label></div>' +
        '<div class="kb-files">' + (it.files || []).map(function (f, k) {
          return '<span class="kb-fe">' + (f.type === 'img' ? '<img src="' + esc(f.url) + '" alt="">' : '📄 ' + esc(f.name)) + '<button type="button" data-rmf="' + k + '">×</button></span>';
        }).join('') + '</div>' +
        '<label class="kb-btn ghost kb-up">📎 ' + tt('צירוף תמונות / PDF', 'แนบรูป/PDF', 'إرفاق صور/PDF') + '<input type="file" id="kbFiles" accept="image/*,application/pdf" multiple hidden></label>' +
        '<span id="kbUpMsg" class="kb-muted"></span>' +
        '<div class="kb-row"><button class="kb-btn pri" id="kbSave">💾 ' + tt('שמירה', 'บันทึก', 'حفظ') + '</button>' +
          (id ? '<button class="kb-btn warn" id="kbDel">🗑 ' + tt('מחיקה', 'ลบ', 'حذف') + '</button>' : '') +
          '<button class="kb-btn ghost" id="kbCancel">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button></div></div>';
      var read = function () {
        it.cat = document.getElementById('kbCat').value; it.title = document.getElementById('kbTitle').value.trim();
        it.body = document.getElementById('kbBody').value.trim(); it.link = document.getElementById('kbLink').value.trim();
        it.tags = document.getElementById('kbTags').value.split(/[,،]/).map(function (s) { return s.trim(); }).filter(Boolean);
      };
      list.querySelectorAll('[data-rmf]').forEach(function (b) { b.onclick = function () { read(); it.files.splice(Number(b.getAttribute('data-rmf')), 1); draw(); }; });
      document.getElementById('kbFiles').onchange = function () {
        read();
        var files = Array.prototype.slice.call(this.files || []);
        if (!files.length) return;
        var msg = document.getElementById('kbUpMsg'); msg.textContent = '⏳ ' + tt('מעלה…', 'กำลังอัปโหลด…', 'جارٍ الرفع…');
        Promise.all(files.map(function (f, i) { return uploadFile(f, i).then(function (r) { return r; }, function (err) { toast('❌ ' + (f.name || '') + ': ' + (err && err.message || err)); return null; }); }))
          .then(function (res) { res.filter(Boolean).forEach(function (r) { it.files.push(r); }); draw(); });
      };
      document.getElementById('kbCancel').onclick = function () { render(); };
      var del = document.getElementById('kbDel');
      if (del) del.onclick = function () {
        if (!confirm(tt('למחוק את הפריט?', 'ลบ?', 'حذف؟'))) return;
        D.items = (D.items || []).filter(function (x) { return String(x.id) !== String(id); });
        persist().then(function () { render(); });
      };
      document.getElementById('kbSave').onclick = function () {
        read();
        if (!it.title) { toast('❌ ' + tt('חסרה כותרת', 'ไม่มีชื่อ', 'العنوان ناقص')); return; }
        var u = window.currentUser || {};
        it.at = Date.now(); it.by = u.name || u.username || '';
        if (!it.id) { it.id = uid(); D.items = (D.items || []).concat([it]); }
        else D.items = D.items.map(function (x) { return String(x.id) === String(it.id) ? it : x; });
        ui.cat = it.cat;
        persist().then(function (ok) { if (ok) toast('✅ ' + tt('נשמר', 'บันทึกแล้ว', 'تم الحفظ')); render(); });
      };
    }
    draw();
  }

  function ensureCss() {
    if (document.getElementById('kbCss')) return;
    var st = document.createElement('style');
    st.id = 'kbCss';
    st.textContent =
      '.kb{max-width:980px !important;width:100%;}' +
      '.kb-h{display:flex;align-items:center;gap:8px;margin-bottom:10px;}.kb-h h2{flex:1;margin:0;}' +
      '.kb-btn{border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);color:var(--primary,#1d5a2c);border-radius:12px;padding:8px 12px;font:inherit;font-weight:600;font-size:.82rem;cursor:pointer;display:inline-flex;align-items:center;gap:4px;}' +
      '.kb-btn.pri{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.kb-btn.ghost{background:transparent;}.kb-btn.warn{color:#b3261e;}' +
      '.kb-q{margin-bottom:8px !important;}' +
      '.kb-cats{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:8px;}' +
      '.kb-cat{flex:none;border:1.5px solid var(--line,#e6ebe2);background:var(--card,#fff);border-radius:12px;padding:7px 11px;font:inherit;font-size:.8rem;cursor:pointer;color:var(--text,#1b2a1f);}' +
      '.kb-cat.on{background:var(--grad-primary,#1d5a2c);color:#fff;border-color:transparent;}.kb-cat small{opacity:.7;}' +
      '.kb-card{border:1px solid var(--line,#e6ebe2);border-radius:18px;padding:12px 14px;margin-bottom:10px;background:var(--card,#fff);}' +
      '.kb-ch{display:flex;align-items:center;gap:8px;}.kb-ch b{flex:1;font-size:.95rem;}' +
      '.kb-tag{font-size:.7rem;background:var(--primary-soft,#eef7d4);color:var(--primary,#1d5a2c);border-radius:8px;padding:2px 8px;white-space:nowrap;}' +
      '.kb-x{border:0;background:var(--tonal,#f1f4ee);border-radius:10px;width:32px;height:32px;cursor:pointer;}' +
      '.kb-body{white-space:pre-line;font-size:.86rem;margin-top:8px;line-height:1.6;}' +
      '.kb-files{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;}' +
      '.kb-thumb img{width:120px;height:90px;object-fit:cover;border-radius:12px;display:block;border:1px solid var(--line,#e6ebe2);}' +
      '.kb-file{display:inline-flex;gap:4px;align-items:center;background:var(--tonal,#f1f4ee);border-radius:10px;padding:6px 10px;font-size:.8rem;color:var(--primary,#1d5a2c);text-decoration:none;}' +
      '.kb-link{display:inline-block;margin-top:8px;font-size:.8rem;color:var(--primary,#1d5a2c);}' +
      '.kb-tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;}.kb-tags span{font-size:.7rem;color:var(--text-muted,#6f7b72);}' +
      '.kb-empty{padding:30px 10px;text-align:center;color:var(--text-muted,#6f7b72);font-size:.86rem;}' +
      '.kb-gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px;}' +
      '.kb-gc{border:1px solid var(--line,#e6ebe2);border-radius:16px;overflow:hidden;cursor:pointer;background:var(--card,#fff);}' +
      '.kb-gc img,.kb-noimg{width:100%;height:120px;object-fit:cover;display:block;}.kb-noimg{display:grid;place-items:center;font-size:2rem;background:var(--tonal,#f1f4ee);}' +
      '.kb-gt{padding:8px 10px;}.kb-gt b{display:block;font-size:.84rem;}.kb-gt small{font-size:.7rem;color:var(--text-muted,#6f7b72);}' +
      '.kb-ed label{display:flex;flex-direction:column;gap:4px;font-size:.76rem;color:var(--text-muted,#6f7b72);margin-bottom:8px;}' +
      '.kb-g2{display:grid;gap:8px;}@media(min-width:620px){.kb-g2{grid-template-columns:1fr 1fr;}}' +
      '.kb-fe{position:relative;display:inline-flex;align-items:center;gap:4px;background:var(--tonal,#f1f4ee);border-radius:10px;padding:4px 8px;font-size:.78rem;}' +
      '.kb-fe img{width:60px;height:45px;object-fit:cover;border-radius:8px;}.kb-fe button{border:0;background:none;color:#b3261e;cursor:pointer;font-size:1rem;}' +
      '.kb-up{margin:8px 0;}.kb-muted{font-size:.76rem;color:var(--text-muted,#6f7b72);margin-inline-start:6px;}.kb-row{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}';
    document.head.appendChild(st);
  }

  document.addEventListener('shorashim:lang', function () { if (document.getElementById('kbRoot') && !document.querySelector('#kbRoot .kb-ed')) render(); });

  return { open: open, close: close, _cats: CATS };
})();
window.Knowledge = Knowledge;
