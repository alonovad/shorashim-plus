/* spray-bulk.js — filtering and multi-record updates
 * ---------------------------------------------------
 * Two halves:
 *
 *   FILTER  — narrow the history by farm, plot, date range, material, or
 *             free text. Ticking a מטע cascades to all its plots, so you
 *             select a whole orchard in one click instead of forty.
 *
 *   BULK    — select the filtered rows and apply one change to all of them.
 *             Routes through SprayStore.updateMany, which writes once but
 *             still records a separate revision and audit entry per record.
 *             A batch edit is a UI convenience; it is not an excuse to lose
 *             per-record provenance.
 *
 * Bulk operations are deliberately a fixed list rather than a free-form
 * editor. "Set every selected record's date to X" is almost never a real
 * correction, and offering it invites exactly the kind of sweeping rewrite
 * that makes a log worthless. Date stays per-record, in the single editor.
 */
var SprayBulk = (function () {
  'use strict';

  var f = {
    farms: {}, plots: {}, from: '', to: '', material: '', text: ''
  };
  var open = false;
  var lastShown = 0;

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  function toast(m) {
    if (typeof showToast === 'function') showToast(m); else alert(m);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function store() { return window.SprayStore; }
  function canEdit() { return window.SprayEdit && window.SprayEdit.canEdit(); }

  function activeCount() {
    var n = 0;
    if (Object.keys(f.plots).length) n++;
    if (f.from || f.to) n++;
    if (f.material) n++;
    if (f.text) n++;
    return n;
  }

  // ── filter predicate, called by app.js's renderHistoryList ──
  function apply(list) {
    var plotIds = Object.keys(f.plots).filter(function (k) { return f.plots[k]; })
      .map(function (k) { return parseInt(k, 10); });
    var mat = f.material.trim().toLowerCase();
    var q = f.text.trim().toLowerCase();

    return list.filter(function (e) {
      if (plotIds.length) {
        var hit = (e.plotIds || []).some(function (id) { return plotIds.indexOf(id) !== -1; });
        if (!hit) return false;
      }
      if (f.from && (!e.date || e.date < f.from)) return false;
      if (f.to && (!e.date || e.date > f.to)) return false;

      if (mat) {
        var m = (e.applications || []).some(function (a) {
          return ((a.productName || '') + ' ' + (a.activeIngredient || ''))
            .toLowerCase().indexOf(mat) !== -1;
        });
        if (!m) return false;
      }

      if (q) {
        var hay = [e.operator || '', e.date || ''];
        (e.applications || []).forEach(function (a) {
          hay.push(a.productName || '', a.activeIngredient || '', a.target || '');
        });
        (e.plotIds || []).forEach(function (id) {
          hay.push(store() ? store().plotNameById(id) : '');
        });
        (e.revisions || []).forEach(function (r) { hay.push(r.reason || ''); });
        if (e.reconstruction) hay.push(e.reconstruction.evidenceBasis || '',
                                       e.reconstruction.sourceRefs || '');
        if (e.voided) hay.push(e.voided.reason || '');
        if (hay.join(' ').toLowerCase().indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // ── panel ──
  function build() {
    if (document.getElementById('sbPanel')) return;
    var host = document.getElementById('historyList');
    if (!host || !host.parentNode) return;

    var wrap = document.createElement('div');
    wrap.id = 'sbPanel';
    wrap.className = 'sb-panel';
    host.parentNode.insertBefore(wrap, host);
    render();
  }

  function render() {
    var wrap = document.getElementById('sbPanel');
    if (!wrap || !store()) return;

    var farms = store().getFarms();
    var plots = store().getPlots();
    var n = activeCount();

    var body = '';
    if (open) {
      var farmHtml = farms.map(function (fa) {
        var fps = plots.filter(function (p) { return p.farm_id === fa.id; });
        if (!fps.length) return '';
        var allOn = fps.every(function (p) { return f.plots[p.id]; });
        var someOn = !allOn && fps.some(function (p) { return f.plots[p.id]; });
        return '<div class="sb-farm">' +
          '<label class="sb-farm-head">' +
            '<input type="checkbox" class="sb-farm-cb" data-farm="' + fa.id + '"' +
              (allOn ? ' checked' : '') + (someOn ? ' data-indet="1"' : '') + '>' +
            '<span class="sb-farm-name">🌳 ' + esc(fa.name) + '</span>' +
            '<span class="sb-farm-count">' + fps.length + '</span>' +
          '</label>' +
          '<div class="sb-plots">' + fps.map(function (p) {
            return '<label class="sb-plot"><input type="checkbox" class="sb-plot-cb" ' +
              'data-plot="' + p.id + '"' + (f.plots[p.id] ? ' checked' : '') + '> ' +
              esc(p.name) + '</label>';
          }).join('') + '</div>' +
        '</div>';
      }).join('');

      // Plots with no farm assigned would otherwise be unreachable.
      var orphans = plots.filter(function (p) { return !p.farm_id; });
      if (orphans.length) {
        farmHtml += '<div class="sb-farm"><div class="sb-farm-head sb-orphan">' +
          tt('ללא מטע', 'ไม่มีสวน', 'بدون بستان') + '</div><div class="sb-plots">' +
          orphans.map(function (p) {
            return '<label class="sb-plot"><input type="checkbox" class="sb-plot-cb" ' +
              'data-plot="' + p.id + '"' + (f.plots[p.id] ? ' checked' : '') + '> ' +
              esc(p.name) + '</label>';
          }).join('') + '</div></div>';
      }

      body =
        '<div class="sb-body">' +
          '<div class="sb-section-label">' + tt('מטעים וחלקות', 'สวนและแปลง', 'البساتين والقطع') + '</div>' +
          '<div class="sb-farms">' + (farmHtml || '<div class="sb-none">' +
            tt('אין חלקות', 'ไม่มีแปลง', 'لا قطع') + '</div>') + '</div>' +
          '<div class="sb-row">' +
            '<div><label class="sb-lbl">' + tt('מתאריך', 'จากวันที่', 'من تاريخ') + '</label>' +
              '<input type="date" id="sbFrom" class="form-input" value="' + esc(f.from) + '"></div>' +
            '<div><label class="sb-lbl">' + tt('עד תאריך', 'ถึงวันที่', 'إلى تاريخ') + '</label>' +
              '<input type="date" id="sbTo" class="form-input" value="' + esc(f.to) + '"></div>' +
          '</div>' +
          '<label class="sb-lbl">' + tt('שם חומר', 'ชื่อสาร', 'اسم المادة') + '</label>' +
          '<input type="text" id="sbMaterial" class="form-input" value="' + esc(f.material) + '">' +
          '<label class="sb-lbl">' + tt('חיפוש כללי', 'ค้นหาทั่วไป', 'بحث عام') + '</label>' +
          '<input type="text" id="sbText" class="form-input" value="' + esc(f.text) + '" placeholder="' +
            esc(tt('מפעיל, מטרה, חלקה, סיבת עריכה…',
                   'ผู้ปฏิบัติงาน เป้าหมาย แปลง…',
                   'مشغّل، هدف، قطعة…')) + '">' +
          '<div class="sb-actions">' +
            '<button type="button" class="sb-clear" onclick="SprayBulk.clear()">' +
              tt('נקה סינון', 'ล้างตัวกรอง', 'مسح التصفية') + '</button>' +
          '</div>' +
        '</div>';
    }

    wrap.innerHTML =
      '<button type="button" class="sb-toggle" onclick="SprayBulk.toggle()">' +
        '🔎 ' + tt('סינון', 'ตัวกรอง', 'تصفية') +
        (n ? '<span class="sb-count">' + n + '</span>' : '') +
        '<span class="sb-caret">' + (open ? '▴' : '▾') + '</span>' +
      '</button>' +
      body +
      '<div id="sbSelBar" class="sb-selbar" style="display:none;"></div>';

    if (open) wire();
    renderSelBar();
  }

  function wire() {
    // Farm checkbox cascades to every plot it owns.
    document.querySelectorAll('.sb-farm-cb').forEach(function (cb) {
      if (cb.getAttribute('data-indet')) cb.indeterminate = true;
      cb.addEventListener('change', function () {
        var fid = parseInt(this.getAttribute('data-farm'), 10);
        var on = this.checked;
        store().getPlots().filter(function (p) { return p.farm_id === fid; })
          .forEach(function (p) {
            if (on) f.plots[p.id] = true; else delete f.plots[p.id];
          });
        refresh();
      });
    });
    document.querySelectorAll('.sb-plot-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var pid = parseInt(this.getAttribute('data-plot'), 10);
        if (this.checked) f.plots[pid] = true; else delete f.plots[pid];
        refresh();
      });
    });

    var bind = function (id, key, evt) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener(evt || 'change', function () {
        f[key] = this.value;
        if (typeof renderHistoryList === 'function') renderHistoryList();
        else refresh();
      });
    };
    bind('sbFrom', 'from');
    bind('sbTo', 'to');
    bind('sbMaterial', 'material', 'input');
    bind('sbText', 'text', 'input');
  }

  function refresh() {
    if (typeof renderHistoryList === 'function') renderHistoryList();
    render();
  }

  function toggle() { open = !open; render(); }

  function clear() {
    f = { farms: {}, plots: {}, from: '', to: '', material: '', text: '' };
    refresh();
  }

  // ── selection + bulk actions ──
  function selectedIds() {
    var out = [];
    document.querySelectorAll('.hist-select:checked').forEach(function (cb) {
      var v = parseInt(cb.value, 10);
      if (!isNaN(v)) out.push(v);
    });
    return out;
  }

  function renderSelBar() {
    var bar = document.getElementById('sbSelBar');
    if (!bar) return;
    if (!canEdit()) { bar.style.display = 'none'; return; }
    var sel = selectedIds();
    bar.style.display = '';
    bar.innerHTML =
      '<label class="sb-selall"><input type="checkbox" id="sbSelAll"' +
        (sel.length && sel.length === lastShown ? ' checked' : '') + '> ' +
        tt('בחר הכל', 'เลือกทั้งหมด', 'اختر الكل') +
        ' (' + lastShown + ')</label>' +
      '<span class="sb-selcount">' + sel.length + ' ' +
        tt('נבחרו', 'ที่เลือก', 'محدد') + '</span>' +
      '<button type="button" class="sb-bulk" onclick="SprayBulk.openBulk()"' +
        (sel.length ? '' : ' disabled') + '>✏️ ' +
        tt('עדכון מרוכז', 'อัปเดตหลายรายการ', 'تحديث جماعي') + '</button>';

    var all = document.getElementById('sbSelAll');
    if (all) {
      all.addEventListener('change', function () {
        var on = this.checked;
        document.querySelectorAll('.hist-select').forEach(function (cb) { cb.checked = on; });
        renderSelBar();
      });
    }
  }

  function openBulk() {
    var ids = selectedIds();
    if (!ids.length) return;
    var cat = store().getPesticides();
    var plots = store().getPlots();

    var matOpts = cat.map(function (p) {
      return '<option value="' + esc(p.productName || '') + '">' + esc(p.productName || '') + '</option>';
    }).join('');
    var plotOpts = plots.map(function (p) {
      return '<option value="' + p.id + '">' + esc(p.name) + '</option>';
    }).join('');

    document.getElementById('modalContainer').innerHTML =
      '<div class="se-backdrop"><div class="se-modal">' +
        '<h3 class="se-title">✏️ ' + tt('עדכון מרוכז', 'อัปเดตหลายรายการ', 'تحديث جماعي') + '</h3>' +
        '<div class="se-warn">' + ids.length + ' ' +
          tt('רשומות ייבחרו לעדכון. כל רשומה תקבל רישום עריכה נפרד.',
             'บันทึกจะถูกอัปเดต แต่ละรายการมีบันทึกแยก',
             'سجلات ستُحدَّث. كل سجل يحصل على قيد تعديل منفصل.') + '</div>' +

        '<label class="se-label">' + tt('פעולה', 'การกระทำ', 'الإجراء') + '</label>' +
        '<select id="sbOp" class="form-input">' +
          '<option value="operator">' + tt('שינוי שם מפעיל', 'เปลี่ยนชื่อผู้ปฏิบัติงาน', 'تغيير اسم المشغّل') + '</option>' +
          '<option value="target">' + tt('הגדרת מטרה לחומר', 'กำหนดเป้าหมายของสาร', 'تحديد هدف للمادة') + '</option>' +
          '<option value="addPlot">' + tt('הוספת חלקה', 'เพิ่มแปลง', 'إضافة قطعة') + '</option>' +
          '<option value="removePlot">' + tt('הסרת חלקה', 'ลบแปลง', 'إزالة قطعة') + '</option>' +
          '<option value="void">' + tt('ביטול הרשומות', 'ยกเลิกบันทึก', 'إبطال السجلات') + '</option>' +
        '</select>' +

        '<div id="sbOpFields"></div>' +

        '<label class="se-label se-req">' + tt('סיבה (חובה)', 'เหตุผล (จำเป็น)', 'السبب (إلزامي)') + '</label>' +
        '<textarea id="sbReason" class="form-input" rows="2"></textarea>' +

        '<div class="se-actions">' +
          '<button type="button" class="se-save" onclick="SprayBulk.applyBulk()">' +
            tt('בצע', 'ดำเนินการ', 'تنفيذ') + '</button>' +
          '<button type="button" class="se-cancel" onclick="SprayBulk.closeBulk()">' +
            tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
        '</div>' +
      '</div></div>';

    var opSel = document.getElementById('sbOp');
    var fields = document.getElementById('sbOpFields');
    var paint = function () {
      var v = opSel.value;
      if (v === 'operator') {
        fields.innerHTML = '<label class="se-label">' +
          tt('שם מפעיל חדש', 'ชื่อใหม่', 'الاسم الجديد') +
          '</label><input type="text" id="sbVal" class="form-input">';
      } else if (v === 'target') {
        fields.innerHTML = '<label class="se-label">' + tt('חומר', 'สาร', 'المادة') +
          '</label><select id="sbMat" class="form-input">' + matOpts + '</select>' +
          '<label class="se-label">' + tt('מטרה', 'เป้าหมาย', 'الهدف') +
          '</label><input type="text" id="sbVal" class="form-input" list="sprayTargetOptions">';
      } else if (v === 'addPlot' || v === 'removePlot') {
        fields.innerHTML = '<label class="se-label">' + tt('חלקה', 'แปลง', 'القطعة') +
          '</label><select id="sbVal" class="form-input">' + plotOpts + '</select>';
      } else {
        fields.innerHTML = '<div class="se-danger-hint">' +
          tt('הרשומות יסומנו כמבוטלות, יישמרו, ויוצאו מיומן הריסוסים הפעיל.',
             'บันทึกจะถูกทำเครื่องหมายยกเลิกและเก็บไว้',
             'ستُوسم السجلات كملغاة وتُحفظ وتُستبعد من السجل الفعّال.') + '</div>';
      }
    };
    opSel.addEventListener('change', paint);
    paint();
  }

  function applyBulk() {
    var ids = selectedIds();
    var reason = document.getElementById('sbReason').value.trim();
    if (!reason) {
      toast('❌ ' + tt('חובה לציין סיבה', 'ต้องระบุเหตุผล', 'يجب ذكر السبب'));
      return;
    }
    var op = document.getElementById('sbOp').value;
    var valEl = document.getElementById('sbVal');
    var val = valEl ? valEl.value : '';

    if (op === 'void') {
      if (!confirm(tt('לבטל ' + ids.length + ' רשומות?',
                      'ยกเลิก ' + ids.length + ' บันทึก?',
                      'إبطال ' + ids.length + ' سجلات؟'))) return;
      var rv = store().voidMany(ids, reason);
      finish(rv, rv && rv.touched);
      return;
    }

    if (!val) { toast('❌ ' + tt('חסר ערך', 'ไม่มีค่า', 'قيمة مفقودة')); return; }

    var patchFn;
    if (op === 'operator') {
      patchFn = function (ev) {
        return ev.operator === val ? null : { operator: val };
      };
    } else if (op === 'target') {
      var mat = document.getElementById('sbMat').value;
      patchFn = function (ev) {
        var apps = JSON.parse(JSON.stringify(ev.applications || []));
        var changed = false;
        apps.forEach(function (a) {
          if (a.productName === mat && a.target !== val) { a.target = val; changed = true; }
        });
        return changed ? { applications: apps } : null;
      };
    } else if (op === 'addPlot') {
      var addId = parseInt(val, 10);
      var allPlots = store().getPlots() || [];
      var addPlot = allPlots.find(function (p) { return p.id === addId; });
      var addFarm = (addPlot && addPlot.farm_id) ? addPlot.farm_id : 0;
      var farmOf = function (ev) {
        if (ev.farmId) return ev.farmId;
        var fp = allPlots.find(function (p) { return (ev.plotIds || []).indexOf(p.id) !== -1; });
        return (fp && fp.farm_id) ? fp.farm_id : 0;
      };
      patchFn = function (ev) {
        var ps = (ev.plotIds || []).slice();
        if (ps.indexOf(addId) !== -1) return null;
        // One record = one מטע. Adding a plot from another farm would merge
        // two growers' paperwork back together — skip the record instead.
        var evFarm = farmOf(ev);
        if (evFarm && addFarm && evFarm !== addFarm) return null;
        ps.push(addId);
        var patch = { plotIds: ps };
        if (!ev.farmId && addFarm) patch.farmId = addFarm;
        return patch;
      };
    } else {
      var delId = parseInt(val, 10);
      patchFn = function (ev) {
        var ps = (ev.plotIds || []).slice();
        var i = ps.indexOf(delId);
        if (i === -1) return null;
        ps.splice(i, 1);
        // Never leave a spray attached to nothing — skip instead.
        if (!ps.length) return null;
        return { plotIds: ps };
      };
    }

    var res = store().updateMany(ids, patchFn, reason, window.SprayEditDiff);
    finish(res, res && res.touched);
  }

  function finish(res, touched) {
    if (!res || !res.ok) {
      toast('❌ ' + tt('העדכון נכשל', 'อัปเดตไม่สำเร็จ', 'فشل التحديث'));
      return;
    }
    if (!touched) {
      toast('ℹ ' + tt('לא בוצעו שינויים — הערכים כבר תואמים',
                      'ไม่มีการเปลี่ยนแปลง', 'لا تغييرات'));
    } else {
      toast('✅ ' + touched + ' ' + tt('רשומות עודכנו', 'บันทึกอัปเดตแล้ว', 'سجلات حُدّثت') +
        (res.skipped ? ' · ' + res.skipped + ' ' + tt('דולגו', 'ข้าม', 'تُخطّيت') : ''));
    }
    closeBulk();
  }

  function closeBulk() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  }

  // ── lifecycle ──
  document.addEventListener('shorashim:history-rendered', function (e) {
    lastShown = (e.detail && e.detail.shown) || 0;
    build();
    render();
    document.querySelectorAll('.hist-select').forEach(function (cb) {
      cb.addEventListener('change', renderSelBar);
    });
  });

  return {
    apply: apply, toggle: toggle, clear: clear,
    openBulk: openBulk, applyBulk: applyBulk, closeBulk: closeBulk
  };
})();
window.SprayFilter = SprayBulk;
window.SprayBulk = SprayBulk;
