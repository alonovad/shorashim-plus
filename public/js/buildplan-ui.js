/* buildplan-ui.js — the modal: tabs, panels, 3D view, sketch, gates, accommodation
 * ------------------------------------------------------------------
 * Part of the BuildPlan module, split out of the former single
 * buildplan.js (3864 lines). Load order is fixed and enforced in
 * index.html and sw.js:
 *
 *   core → geom → draw → map → ui → link
 *
 * Shared state and any function called across file boundaries live on
 * the internals bag `BuildPlanInternals` (`BP` inside each file).
 * Names used only within one file stay plain closure vars, exactly as
 * before. No behaviour changed in this split — only where the code
 * lives. Every cross-file reference is a runtime call or a property
 * read, never a load-time value, so the load order above is the only
 * ordering constraint.
 */
(function (BP) {
  'use strict';
  // ══════════════════════════════════════════════════════════════════
  //  UI
  // ══════════════════════════════════════════════════════════════════
  BP.isOpen = function isOpen() { return !!document.getElementById('bpRoot'); };
  BP.close = function close() {
    var m = document.getElementById('modalContainer');
    if (m) m.innerHTML = '';
  };
  // Same cure as agriplan: _dim() repaints on every slider tick, and a
  // wholesale innerHTML swap resets scrollTop, so dragging a slider halfway
  // down the sheet would fling the view back to the top mid-drag.
  BP.paint = function paint(h) {
    var m = document.getElementById('modalContainer');
    if (!m) return;
    // Three things have to survive a repaint or the sheet feels like it
    // resets under you: the backdrop scroll, the controls-column scroll,
    // and which accordions were open.
    var back = document.querySelector('.bp-back');
    var pane = document.querySelector('.bp-pane');
    var backTop = back ? back.scrollTop : 0;
    var paneTop = pane ? pane.scrollTop : 0;
    var openAcc = [];
    document.querySelectorAll('.bp-acc').forEach(function (d, i) {
      if (d.open) openAcc.push(i);
    });
    var act = document.activeElement;
    var actId = (act && act.id) ? act.id : null;
    var caret = (act && act.selectionStart != null) ? act.selectionStart : null;

    m.innerHTML = h;

    var nBack = document.querySelector('.bp-back');
    var nPane = document.querySelector('.bp-pane');
    if (nBack && backTop) nBack.scrollTop = backTop;
    if (nPane && paneTop) nPane.scrollTop = paneTop;
    if (openAcc.length) {
      var accs = document.querySelectorAll('.bp-acc');
      accs.forEach(function (d, i) { d.open = openAcc.indexOf(i) >= 0; });
    }
    if (actId) {
      var back2 = document.getElementById(actId);
      if (back2 && back2.focus) {
        back2.focus();
        if (caret != null && back2.setSelectionRange) {
          try { back2.setSelectionRange(caret, caret); } catch (e) {}
        }
      }
    }
  };
  // Which view is on screen. Without this, saving a price fired the
  // Firestore listener, repaint() found no open project, and dropped the
  // user back to the project list mid-edit — every single keystroke.
  BP._view = 'list';

  BP.repaint = function repaint() {
    if (BP._view === 'catalog') { BP.openCatalog(); return; }
    if (BP._open && BP.projById(BP._open)) BP.open(BP._open); else BP.render();
  };

  function ensureCss() {
    if (document.getElementById('bpCss')) return;
    var st = document.createElement('style');
    st.id = 'bpCss';
    st.textContent =
      '.bp-back{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;overflow:auto;padding:14px;}' +
      '.bp-sheet{max-width:1240px;margin:0 auto;background:var(--surface,#fff);color:var(--text,#222);' +
        'border-radius:16px;padding:16px;box-shadow:0 10px 40px rgba(0,0,0,.35);}' +
      '.bp-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;' +
        'margin-bottom:12px;padding-bottom:10px;border-bottom:2px solid var(--border,#e0e0e0);flex-wrap:wrap;}' +
      '.bp-head h3{margin:0;font-weight:800;font-size:1.05rem;}' +
      '.bp-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.bp-btn{padding:9px 13px;border:none;border-radius:10px;background:var(--primary,#2d6a4f);' +
        'color:#fff;font-family:inherit;font-weight:700;font-size:.84rem;cursor:pointer;}' +
      '.bp-btn.ghost{background:var(--surface-glass,#eef1ee);color:var(--text,#333);}' +
      '.bp-btn.warn{background:#c62828;}' +
      '.bp-btn.on{outline:2px solid var(--accent,#ff9f43);}' +
      '.bp-card{background:var(--surface-glass,#f5f7f5);border-radius:12px;padding:12px;margin-bottom:10px;}' +
      '.bp-draw{background:rgba(0,0,0,.18);border-radius:12px;padding:10px;}' +
      '.bp-in{padding:7px;border-radius:8px;border:1px solid var(--border,#ccc);font-family:inherit;' +
        'font-size:.82rem;background:var(--surface,#fff);color:var(--text,#222);width:100%;}' +
      '.bp-lbl{font-size:.7rem;color:var(--text-muted,#888);font-weight:700;margin-bottom:2px;}' +
      '.bp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;}' +
      '.bp-rng{width:100%;accent-color:var(--primary,#2d6a4f);}' +
      '.bp-tot{display:flex;justify-content:space-between;gap:8px;padding:5px 0;font-size:.84rem;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.bp-empty{text-align:center;color:var(--text-muted,#999);padding:18px;font-size:.86rem;}' +
      // Two columns on a wide screen: the model stays put on the left while
      // the controls scroll on the right. On a phone it collapses to one
      // column with the viewer stuck to the top — either way the drawing is
      // always on screen, because it is the feedback for every control.
      '.bp-split{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(300px,1fr);gap:12px;align-items:start;}' +
      '.bp-stick{position:sticky;top:8px;z-index:3;}' +
      '.bp-pane{max-height:calc(100vh - 168px);overflow-y:auto;overscroll-behavior:contain;' +
        '-webkit-overflow-scrolling:touch;padding-inline-end:6px;padding-bottom:28px;}' +
      '.bp-pane::-webkit-scrollbar{width:10px;}' +
      '.bp-pane::-webkit-scrollbar-thumb{background:var(--border,#bbb);border-radius:6px;}' +
      '.bp-acc{background:var(--surface-glass,#f5f7f5);border-radius:12px;margin-bottom:8px;overflow:hidden;}' +
      '.bp-acc>summary{cursor:pointer;padding:10px 12px;font-weight:800;font-size:.85rem;list-style:none;' +
        'display:flex;justify-content:space-between;align-items:center;}' +
      '.bp-acc>summary::-webkit-details-marker{display:none;}' +
      '.bp-acc>summary::after{content:"\\25be";opacity:.6;}' +
      '.bp-acc[open]>summary::after{content:"\\25b4";}' +
      '.bp-acc>div{padding:0 12px 12px;}' +
      '.bp-layer{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:8px;' +
        'font-size:.8rem;cursor:pointer;background:var(--surface,#fff);margin-bottom:4px;}' +
      '.bp-layer.off{opacity:.4;}' +
      '.bp-sw{width:12px;height:12px;border-radius:3px;flex:none;}' +
      '.bp-read{display:flex;justify-content:space-between;font-size:.78rem;padding:3px 0;' +
        'border-bottom:1px solid var(--border,#eee);}' +
      '.bp-read b{color:var(--accent,#ff9f43);}' +
      '@media(max-width:900px){.bp-split{grid-template-columns:1fr;}' +
        '.bp-pane{max-height:none;overflow:visible;}}' +
      '@media(max-width:640px){.bp-grid{grid-template-columns:1fr 1fr;}}';
    document.head.appendChild(st);
  }

  BP.shell = function shell(title, bar, body) {
    ensureCss();
    return '<div class="bp-back" id="bpRoot"><div class="bp-sheet">' +
      '<div class="bp-head"><div><h3>' + title + '</h3></div>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.close()">\u2715 ' +
        BP.tt('סגור', 'ปิด', 'إغلاق') + '</button></div>' +
      '<div class="bp-bar">' + bar + '</div>' + body + '</div></div>';
  };

  BP.openModule = function openModule() {
    if (!BP.isManager()) { BP.toast('\u26d4 ' + BP.tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    BP.loadAll().then(function () { BP.listen(); BP.drawFootprints(); BP._open = null; BP.render(); });
  };

  BP.render = function render() {
    BP._view = 'list';
    BP._open = null;
    BP._v3d = null;
    var bar =
      '<button class="bp-btn" onclick="BuildPlan.newProject(\'shed\')">\ud83c\udfd7 ' +
        BP.tt('סככה חדשה', 'โรงเรือนใหม่', 'سقيفة جديدة') + '</button>' +
      '<button class="bp-btn" onclick="BuildPlan.newProject(\'slab\')">\ud83e\uddf1 ' +
        BP.tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.openCatalog()">\ud83d\udcd0 ' +
        BP.tt('קטלוג פרופילים', 'แคตตาล็อก', 'كتالوج') + '</button>' +
      '<button class="bp-btn ghost" onclick="Orders.open()">\ud83d\udce6 ' +
        BP.tt('הזמנות', 'ใบสั่งซื้อ', 'الطلبات') + '</button>' +
      (typeof Maintenance !== 'undefined'
        ? '<button class="bp-btn ghost" onclick="BuildPlan.backToMaint()">\ud83d\udd27 ' +
          BP.tt('חזרה לתחזוקה', 'กลับซ่อมบำรุง', 'رجوع للصيانة') + '</button>' : '');

    var body = '';
    if (!(BP.P.projects || []).length) {
      body = '<div class="bp-empty">' + BP.tt(
        'אין פרויקטים. פרויקט מוגדר במידות, מצויר אוטומטית, ומחשב כתב כמויות והזמנה.',
        'ยังไม่มีโครงการ', 'لا توجد مشاريع') + '</div>';
    }
    (BP.P.projects || []).slice().sort(function (a, b) { return b.createdAt - a.createdAt; })
      .forEach(function (p) {
        var rows = BP.takeoff(p), t = BP.takeoffTotals(rows);
        var g = p.type === 'slab' ? null : BP.geom(p.dims);
        var icon = p.type === 'slab' ? '\ud83e\uddf1' : (p.type === 'house' ? '\ud83c\udfe0' : '\ud83c\udfd7');
        body += '<div class="bp-card" style="cursor:pointer;" onclick="BuildPlan.card(' + p.id + ')">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
            '<strong>' + icon + ' ' + BP.esc(p.name || BP.tt('ללא שם', 'ไม่มีชื่อ', 'بلا اسم')) + '</strong>' +
            '<span style="font-size:.76rem;color:var(--text-muted,#888);">' + BP.typeLabel(p.type) + '</span>' +
          '</div>' +
          '<div style="font-size:.78rem;color:var(--text-muted,#888);margin-top:4px;">' +
            (g ? BP.n1(p.dims.span) + '\u00d7' + BP.n1(p.dims.length) + ' m \u00b7 ' + g.frames + ' ' +
                 BP.tt('מסגרות', 'เฟรม', 'إطارات') + ' \u00b7 ' + BP.n1(t.kg / 1000) + ' ' +
                 BP.tt('טון פלדה', 'ตันเหล็ก', 'طن حديد')
               : BP.n1(BP.slabArea(p)) + ' \u05de"\u05e8 \u00b7 ' + BP.n2(BP.slabArea(p) * p.dims.slabTh) + ' \u05de"\u05e7') +
            (t.cost ? ' \u00b7 ' + BP.money(t.cost) : '') +
            (p.footprint.length ? ' \u00b7 \ud83d\uddfa ' + BP.n1(p.footprintArea) + ' \u05de"\u05e8' : '') +
            (p.maintId ? ' \u00b7 \ud83d\udd27 ' + BP.esc(p.maintName || BP.tt('מקושר','เชื่อม','مرتبط')) : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;margin-top:8px;" onclick="event.stopPropagation()">' +
            (p.footprint.length
              ? '<button class="bp-btn ghost" style="padding:5px 10px;font-size:.74rem;" ' +
                  'onclick="BuildPlan.zoomTo(' + p.id + ')">\ud83d\udccd ' +
                  BP.tt('במפה', 'แผนที่', 'خريطة') + '</button>'
              : '<button class="bp-btn ghost" style="padding:5px 10px;font-size:.74rem;" ' +
                  'onclick="BuildPlan.startRect(' + p.id + ')">\u25ad ' +
                  BP.tt('מקם', 'วาง', 'حدد') + '</button>') +
            '<button class="bp-btn ghost" style="padding:5px 10px;font-size:.74rem;" ' +
              'onclick="BuildPlan.openProject(' + p.id + ')">\u270f\ufe0f ' +
              BP.tt('ערוך', 'แก้ไข', 'تحرير') + '</button>' +
            '<button class="bp-btn warn" style="padding:5px 10px;font-size:.74rem;" ' +
              'onclick="BuildPlan.delProject(' + p.id + ')">\ud83d\uddd1</button>' +
          '</div></div>';
      });

    BP.paint(BP.shell('\ud83c\udfd7 ' + BP.tt('פרויקטי בנייה', 'โครงการก่อสร้าง', 'مشاريع البناء'), bar, body));
  };

  // A read-first summary, the same shape as a plot card: what it is, where
  // it is, what it will consume and what it will cost — before dropping the
  // user into a design surface full of sliders.
  BP.card = function card(id) {
    var p = BP.projById(id);
    if (!p) { BP.render(); return; }
    var rows = BP.takeoff(p), tot = BP.takeoffTotals(rows), con = BP.concrete(p);
    var g = p.type === 'slab' ? null : BP.geom(p.dims);
    var has = p.footprint && p.footprint.length >= 3;

    function line(k, v) {
      return '<div class="bp-tot"><span>' + k + '</span><strong>' + v + '</strong></div>';
    }

    var top = rows.slice().sort(function (a, b) {
      var pa = BP.profByName(a.name), pb = BP.profByName(b.name);
      return ((pb && pb.price ? b.qty*pb.price : 0)) - ((pa && pa.price ? a.qty*pa.price : 0));
    }).slice(0, 6).map(function (r) {
      return '<div class="bp-tot" style="font-size:.8rem;"><span>' + BP.esc(BP.dsp(r.name)) +
        '</span><span>' + BP.n1(r.qty) + ' ' + BP.esc(BP.dsp(r.unit)) + '</span></div>';
    }).join('');

    var body =
      '<div class="bp-card">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;">' +
          '<div><div style="font-weight:800;font-size:1.05rem;">' +
            BP.esc(p.name || BP.typeLabel(p.type)) + '</div>' +
            '<div style="font-size:.8rem;color:var(--text-muted,#888);">' + BP.typeLabel(p.type) +
            (p.client ? ' \u00b7 ' + BP.esc(p.client) : '') + '</div></div>' +
          '<div style="font-size:.76rem;color:var(--text-muted,#888);text-align:end;">' +
            new Date(p.createdAt).toLocaleDateString('he-IL') +
            (p.createdBy ? '<br>' + BP.esc(p.createdBy) : '') + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="bp-card">' +
        (g ? line(BP.tt('מידות', 'ขนาด', 'الأبعاد'),
              BP.n1(p.dims.span) + ' \u00d7 ' + BP.n1(p.dims.length) + ' m') +
             line(BP.tt('גובה עמוד / רכס', 'สูงเสา/สัน', 'ارتفاع العمود/القمة'),
              BP.n1(p.dims.eaves) + ' / ' + BP.n1(g.ridgeH) + ' m') +
             line(BP.tt('מסגרות', 'เฟรม', 'إطارات'),
              g.frames + ' @ ' + BP.n1(g.actualBay) + ' m') +
             line(BP.tt('שטח מקורה', 'พื้นที่คลุม', 'المساحة المغطاة'), BP.n1(g.footprint) + ' \u05de"\u05e8') +
             line(BP.tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد'),
              BP.n1(tot.kg) + ' kg \u00b7 ' + BP.n2(tot.kg/1000) + ' ' + BP.tt('טון', 'ตัน', 'طن'))
           : line(BP.tt('שטח', 'พื้นที่', 'المساحة'), BP.n1(BP.slabArea(p)) + ' \u05de"\u05e8') +
             line(BP.tt('עובי', 'ความหนา', 'السماكة'), p.dims.slabTh + ' m')) +
        line(BP.tt('בטון', 'คอนกรีต', 'خرسانة'), BP.n2(con.total) + ' \u05de"\u05e7') +
        line(BP.tt('עלות חומרים', 'ต้นทุนวัสดุ', 'تكلفة المواد'), BP.money(tot.cost)) +
        (tot.unpriced ? '<div style="font-size:.74rem;color:#e65100;">\u26a0\ufe0f ' + tot.unpriced +
          ' ' + BP.tt('פריטים ללא מחיר', 'ไม่มีราคา', 'بدون سعر') + '</div>' : '') +
      '</div>' +

      '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">\ud83d\uddfa ' +
        BP.tt('מיקום', 'ตำแหน่ง', 'الموقع') + '</div>' +
        (has
          ? line(BP.tt('שטח מסומן', 'พื้นที่ที่วาด', 'المساحة المرسومة'),
              BP.n1(p.footprintArea) + ' \u05de"\u05e8 (' + BP.n2(p.footprintArea/1000) + ' ' +
              BP.tt('דונם', 'ดูนัม', 'دونم') + ')') +
            '<button class="bp-btn" style="margin-top:6px;" onclick="BuildPlan.zoomTo(' + p.id + ')">' +
              '\ud83d\udccd ' + BP.tt('הצג את אתר הבנייה במפה', 'ดูบนแผนที่', 'عرض الموقع على الخريطة') +
            '</button>'
          : '<div style="font-size:.82rem;color:var(--text-muted,#999);">' +
              BP.tt('הפרויקט לא ממוקם על המפה.', 'ยังไม่ได้กำหนดตำแหน่ง', 'لم يُحدَّد الموقع') + '</div>' +
            '<button class="bp-btn" style="margin-top:6px;" onclick="BuildPlan.startRect(' + p.id + ')">' +
              '\u25ad ' + BP.tt('סמן עכשיו', 'วาดตอนนี้', 'ارسم الآن') + '</button>') +
      '</div>' +

      (p.maintId ? '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">\ud83d\udd27 ' +
        BP.tt('פרויקט תחזוקה', 'โครงการซ่อมบำรุง', 'مشروع الصيانة') + '</div>' +
        '<div class="bp-tot" style="border:none;"><span>' + BP.esc(p.maintName || '\u2014') + '</span>' +
        '<button class="bp-btn ghost" style="padding:4px 10px;font-size:.74rem;" ' +
          'onclick="BuildPlan.openMaint(' + p.maintId + ')">' +
          BP.tt('פתח', 'เปิด', 'فتح') + '</button></div></div>' : '') +

      (top ? '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">' +
        BP.tt('פריטים עיקריים', 'วัสดุหลัก', 'المواد الرئيسية') + '</div>' + top + '</div>' : '') +

      (p.notes ? '<div class="bp-card" style="font-size:.84rem;">' + BP.esc(p.notes) + '</div>' : '');

    var bar =
      '<button class="bp-btn" onclick="BuildPlan.openProject(' + p.id + ')">\u270f\ufe0f ' +
        BP.tt('ערוך ותכנן', 'แก้ไข', 'تحرير') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printProject(' + p.id + ')">\ud83d\udda8 ' +
        BP.tt('הדפסה מלאה', 'พิมพ์เต็ม', 'طباعة كاملة') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printQuantities(' + p.id + ')">\ud83e\uddfe ' +
        BP.tt('כתב כמויות בלבד', 'เฉพาะรายการวัสดุ', 'الكميات فقط') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.toOrder(' + p.id + ')">\ud83d\udce6 ' +
        BP.tt('צור הזמנה', 'ใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      '<button class="bp-btn warn" onclick="BuildPlan.delProject(' + p.id + ')">\ud83d\uddd1 ' +
        BP.tt('מחק', 'ลบ', 'حذف') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        BP.tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    BP.paint(BP.shell((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') +
      BP.esc(p.name || BP.typeLabel(p.type)), bar, body));
  };

  BP.newProject = function newProject(type) {
    var u = window.currentUser || {};
    var p = BP.normProject({
      id: BP.uid(), type: type || 'shed', createdAt: Date.now(), createdBy: u.username || '',
      name: BP.typeLabel(type || 'shed')
    });
    BP.P.projects.push(p);
    BP.saveP();
    BP.open(p.id);
  };

  BP.delProject = function delProject(id) {
    var before = BP.projById(id);
    if (!before) { BP.render(); return; }
    if (!BP.isManager()) { BP.toast('\u26d4 ' + BP.tt('אין הרשאה', 'ไม่มีสิทธิ์', 'لا صلاحية')); return; }
    var ok = (typeof window.confirm === 'function')
      ? window.confirm(BP.tt('למחוק את הפרויקט?', 'ลบโครงการ?', 'حذف المشروع؟')) : true;
    if (!ok) return;
    // Drop the view state too, or a later project could inherit this one's
    // hidden layers.
    _v3dState = null; _v3dFor = null;
    BP.P.projects = (BP.P.projects || []).filter(function (p) { return p.id !== id; });
    BP.saveP();
    if (window.Audit && Audit.log) Audit.log('delete', 'buildplan', String(id), { before: before });
    BP.render();
  };

  BP.setTab = function setTab(t) {
    if (BP._v3d && BP._open && _v3dFor === BP._open) { try { _v3dState = BP._v3d.getState(); } catch (e) {} }
    BP._tab = t;
    if (BP._open) BP.open(BP._open);
  };

  BP.open = function open(id) {
    var p = BP.projById(id);
    if (!p) { BP.render(); return; }
    // Grab the view before paint() destroys the canvas. Switching to a
    // different project starts fresh — carrying one building's camera onto
    // another that is a tenth the size would frame empty sky.
    if (BP._v3d && _v3dFor === id) { try { _v3dState = BP._v3d.getState(); } catch (e) {} }
    else if (_v3dFor !== id) { _v3dState = null; }
    BP._view = 'project';
    BP._open = id;
    var d = p.dims;
    var rows = BP.takeoff(p), tot = BP.takeoffTotals(rows);

    // 'מודל' was a tab you had to walk through even on a job that is one
    // gate and nothing else — it held the shed sliders, and a gate has no
    // span, pitch or bay. It is now named for what it is, and it is absent
    // when the project contains no structure and no slab to design.
    // Components are added from the dropdown in the header instead, which
    // is also where a shed gets switched back on.
    var hasModel = (p.hasStruct !== false) || (p.hasSlab !== false) || p.type === 'slab';
    var tabList = ['design', 'gates', 'living', 'sketch', 'materials', 'site'];
    if (!hasModel) {
      tabList = tabList.filter(function (t) { return t !== 'design'; });
      if (BP._tab === 'design') BP._tab = (p.gates || []).length ? 'gates' : 'materials';
    }
    var tabs = tabList.map(function (t) {
      var lbl = t === 'design' ? '\ud83c\udfd7 ' + BP.tt('סככה / שלד', 'โครงสร้าง', 'الهيكل')
              : t === 'gates' ? '\ud83d\udea7 ' + BP.tt('שערים', 'ประตู', 'بوابات') +
                  ((p.gates || []).length ? ' (' + p.gates.length + ')' : '')
              : t === 'living' ? '\ud83c\udfe0 ' + BP.tt('מגורים', 'ที่พัก', 'سكن') +
                  ((p.living && p.living.people) ? ' (' + p.living.people + ')' : '')
              : t === 'sketch' ? '\u270f\ufe0f ' + BP.tt('שרטוט חופשי', 'วาดอิสระ', 'رسم حر')
              : t === 'materials' ? '\ud83e\uddfe ' + BP.tt('כתב כמויות', 'รายการวัสดุ', 'الكميات')
              : '\ud83d\uddfa ' + BP.tt('מיקום במפה', 'ตำแหน่ง', 'الموقع');
      return '<button class="bp-btn ' + (BP._tab === t ? 'on' : 'ghost') +
        '" onclick="BuildPlan.setTab(\'' + t + '\')">' + lbl + '</button>';
    }).join('');

    // What is in this project. Shown before anything else, because it
    // decides which of the tabs below actually mean anything.
    var comps = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">' +
        BP.tt('מה כולל הפרויקט', 'โครงการนี้ประกอบด้วย', 'مكوّنات المشروع') + '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.84rem;">' +
        '<label style="display:inline-flex;gap:6px;align-items:center;">' +
          '<input type="checkbox"' + (p.hasStruct !== false ? ' checked' : '') +
          ' onchange="BuildPlan._comp(' + id + ',\'hasStruct\',this.checked)"> \ud83c\udfd7 ' +
          BP.tt('סככה / שלד', 'โครงสร้าง', 'هيكل') + '</label>' +
        '<label style="display:inline-flex;gap:6px;align-items:center;">' +
          '<input type="checkbox"' + (p.hasSlab !== false ? ' checked' : '') +
          ' onchange="BuildPlan._comp(' + id + ',\'hasSlab\',this.checked)"> \ud83e\uddf1 ' +
          BP.tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</label>' +
        '<span style="display:inline-flex;gap:6px;align-items:center;opacity:.75;">\ud83d\udea7 ' +
          BP.tt('שערים', 'ประตู', 'بوابات') + ': ' + ((p.gates || []).length) + '</span>' +
        '<span style="display:inline-flex;gap:6px;align-items:center;opacity:.75;">\ud83c\udfe0 ' +
          BP.tt('מגורים', 'ที่พัก', 'سكن') + ': ' +
          ((p.living && p.living.people) ? p.living.people + ' ' + BP.tt('אנשים','คน','أشخاص')
                                          : BP.tt('ללא','ไม่มี','بدون')) + '</span>' +
      '</div>' +
      // One list of everything a project can contain. Adding a gate used
      // to mean finding the gates tab and pressing a plus inside it;
      // turning a shed back on meant finding a checkbox in a third place.
      '<div style="margin-top:8px;max-width:280px;">' +
        '<select class="bp-in" onchange="BuildPlan.addComp(' + id + ',this.value);this.value=\'\';">' +
          '<option value="">\u2795 ' +
            BP.tt('הוסף לפרויקט…', 'เพิ่มในโครงการ…', 'إضافة للمشروع…') + '</option>' +
          (p.hasStruct === false ? '<option value="struct">\ud83c\udfd7 ' +
            BP.tt('סככה / שלד', 'โครงสร้าง', 'هيكل') + '</option>' : '') +
          (p.hasSlab === false ? '<option value="slab">\ud83e\uddf1 ' +
            BP.tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</option>' : '') +
          '<option value="gate">\ud83d\udea7 ' +
            BP.tt('שער', 'ประตู', 'بوابة') + '</option>' +
          (!(p.living && p.living.people) ? '<option value="living">\ud83c\udfe0 ' +
            BP.tt('יחידת מגורים', 'ที่พัก', 'وحدة سكن') + '</option>' : '') +
        '</select>' +
      '</div>' +
      (p.hasStruct === false
        ? '<div style="font-size:.75rem;color:var(--accent,#ff9f43);margin-top:8px;">\u26a0\ufe0f ' +
          BP.tt('ללא שלד — כתב הכמויות לא כולל פלדה, חיפוי או יסודות.',
             'ไม่มีโครงสร้าง', 'بدون هيكل') + '</div>'
        : '') +
    '</div>';

    var body = comps + '<div class="bp-card">' +
      '<div class="bp-grid">' +
        '<div><div class="bp-lbl">' + BP.tt('שם', 'ชื่อ', 'الاسم') + '</div>' +
          '<input class="bp-in" value="' + BP.esc(p.name) + '" ' +
          'oninput="BuildPlan._set(' + id + ',\'name\',this.value)"></div>' +
        '<div><div class="bp-lbl">' + BP.tt('לקוח / מטע', 'ลูกค้า', 'العميل') + '</div>' +
          '<input class="bp-in" value="' + BP.esc(p.client) + '" ' +
          'oninput="BuildPlan._set(' + id + ',\'client\',this.value)"></div>' +
      '</div></div>' + '<div class="bp-bar">' + tabs + '</div>';

    if (BP._tab === 'design')      body += designTab(p);
    else if (BP._tab === 'gates')  body += gatesTab(p);
    else if (BP._tab === 'living') body += livingTab(p);
    else if (BP._tab === 'sketch') body += sketchTab(p);
    else if (BP._tab === 'materials') body += matTab(p, rows, tot);
    else                        body += siteTab(p);

    var bar =
      '<button class="bp-btn" onclick="BuildPlan.saveNow()">\ud83d\udcbe ' +
        BP.tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printProject(' + id + ')">\ud83d\udda8 ' +
        BP.tt('הדפסה מלאה', 'พิมพ์เต็ม', 'طباعة كاملة') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.printQuantities(' + id + ')">\ud83e\uddfe ' +
        BP.tt('כתב כמויות בלבד', 'เฉพาะรายการวัสดุ', 'الكميات فقط') + '</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.toOrder(' + id + ')">\ud83d\udce6 ' +
        BP.tt('צור הזמנה', 'สร้างใบสั่งซื้อ', 'إنشاء طلب') + '</button>' +
      '<button class="bp-btn warn" onclick="BuildPlan.delProject(' + id + ')">\ud83d\uddd1</button>' +
      '<button class="bp-btn ghost" onclick="BuildPlan.render()">\u21a9 ' +
        BP.tt('חזרה', 'กลับ', 'رجوع') + '</button>';

    BP.paint(BP.shell((p.type === 'slab' ? '\ud83e\uddf1 ' : '\ud83c\udfd7 ') +
      BP.esc(p.name || BP.typeLabel(p.type)), bar, body));
    if (BP._tab === 'site') BP.linkPanel(p);
    if (BP._tab === 'gates') mountGates(p);
    if (BP._tab === 'sketch') mountSketch(p);
    if (BP._tab === 'design') {
      if (p.type !== 'slab') mount3d(p);
      BP.refreshReadouts(p);
    }
  };

  // Gate drawings, like the 3D model, answer "what is that member" on
  // hover and on tap. Rebuilt after every paint because innerHTML replaces
  // the host nodes and the old listeners go with them.
  // The engineer's verdict, in the same shape the shed uses: one row per
  // member, the governing action, a utilisation bar, and a section that
  // would work when the current one does not. Red means the member is
  // overstressed — not "add a bit", but change it.
  function gateChecks(g, id, i) {
    if (typeof Gates === 'undefined' || !Gates.checks) return '';
    var rows = Gates.checks(g), any = false, h = '';
    rows.forEach(function (r) {
      if (!r.known) {
        h += '<div class="bp-read"><span>' + BP.esc(Gates.roleLabel(r.role)) + '</span>' +
          '<b style="color:var(--text-muted,#888);font-weight:600;">' +
          BP.tt('פרופיל לא מוכר — לא נבדק', 'ไม่รู้จักหน้าตัด', 'مقطع غير معروف') + '</b></div>';
        return;
      }
      any = any || !r.ok;
      var pct = Math.round(r.util * 100);
      var col = r.ok ? (r.util > 0.85 ? '#e0a020' : '#2d8a5f') : '#c0392b';
      h += '<div style="margin:6px 0;">' +
        '<div style="display:flex;justify-content:space-between;gap:8px;font-size:.76rem;">' +
          '<span><b>' + BP.esc(Gates.roleLabel(r.role)) + '</b> ' +
            '<span style="opacity:.6;">' + BP.esc(r.name) + '</span></span>' +
          '<span style="color:' + col + ';font-weight:800;white-space:nowrap;">' +
            (r.ok ? '\u2713 ' : '\u2715 ') + pct + '%</span>' +
        '</div>' +
        '<div style="height:5px;border-radius:3px;background:var(--border,#ddd);overflow:hidden;margin-top:3px;">' +
          '<div style="height:100%;width:' + Math.min(100, pct) + '%;background:' + col + ';"></div></div>' +
        '<div style="font-size:.68rem;color:var(--text-muted,#888);margin-top:2px;">' +
          BP.esc(r.why) + ' \u00b7 M = ' + BP.n1(r.M) + ' kNm</div>' +
      '</div>';
      // Only offer alternatives for the members you can actually swap.
      if (!r.ok && (r.role === 'post' || r.role === 'frame')) {
        var fix = (Gates.candidates(g, r.role) || []).filter(function (c) { return c.ok; })[0];
        if (fix) {
          h += '<button class="bp-btn" style="font-size:.7rem;padding:4px 10px;margin-bottom:6px;" ' +
            'onclick="BuildPlan.setGate(' + id + ',' + i + ',\'' + r.role +
              '\',\'' + fix.name + '\')">' +
            '\u2192 ' + BP.tt('החלף ל-', 'เปลี่ยนเป็น', 'استبدل بـ') + ' ' + BP.esc(fix.name) +
            ' (' + Math.round(fix.util * 100) + '%)</button>';
        }
      }
    });
    return '<div class="bp-card">' +
      '<div style="font-size:.72rem;font-weight:800;letter-spacing:.04em;color:' +
        (any ? '#c0392b' : 'var(--text-muted,#888)') + ';margin-bottom:4px;">' +
        (any ? '\u26a0 ' : '\ud83d\udcd0 ') +
        BP.tt('בדיקה הנדסית ראשונית', 'ตรวจสอบเบื้องต้น', 'فحص هندسي أولي') + '</div>' +
      h +
      '<div style="font-size:.66rem;color:var(--text-muted,#888);margin-top:6px;line-height:1.5;">' +
        BP.tt('בדיקת מאמצים מותרים לפעולה אחת דומיננטית לכל רכיב. לא מחליפה תכנון קונסטרוקטור, ואינה כוללת ריתוכים, צירים או בדיקת קרקע.',
              'การตรวจสอบเบื้องต้น ไม่ใช่การออกแบบ',
              'فحص أولي فقط، ولا يغني عن تصميم إنشائي.') + '</div>' +
    '</div>';
  }

  var _gatePick = [];
  // Which view each gate is showing, the live viewers, and the camera each
  // one was left at. Keyed by index, and cleared whenever the list changes
  // shape — after a delete, index 2 is a different gate.
  var _gView = {}, _g3d = {}, _g3dCam = {};
  function _gateReset() { _gView = {}; _g3dDestroy(); _g3dCam = {}; }
  function _g3dDestroy() {
    Object.keys(_g3d).forEach(function (k) {
      // getState() reads closure variables, not the DOM, so it is still
      // truthful after paint() has replaced the canvas it was drawing on.
      try { _g3dCam[k] = _g3d[k].getState(); } catch (e) {}
      try { _g3d[k].destroy(); } catch (e) {}
    });
    _g3d = {};
  }

  BP.gateView = function gateView(id, i, mode) {
    _g3dDestroy();
    _gView[i] = mode;
    BP.open(id);
  };
  BP.gate3dView = function gate3dView(i, yaw, pitch) {
    if (_g3d[i]) _g3d[i].setView(yaw, pitch);
  };
  BP.gate3dReset = function gate3dReset(i) {
    if (!_g3d[i]) return;
    _g3d[i].resetView();
    if (_g3dCam[i]) _g3dCam[i].cam = null;
  };
  // Per-gate reinforcement setter, bound once so the onchange strings stay
  // short. Same shape as BP._rebarBind for the structure's own footings.
  BP._gateRebarBind = function _gateRebarBind(id, i) {
    var nm = '_gr_' + id + '_' + i;
    if (!BuildPlan[nm]) {
      BuildPlan[nm] = function (k, v) {
        var p = BP.projById(id);
        if (!p || !p.gates[i]) return;
        var cur = (p.gates[i].rebar && typeof p.gates[i].rebar === 'object')
          ? JSON.parse(JSON.stringify(p.gates[i].rebar)) : {};
        cur[k] = (k === 'show' || k === 'mat') ? !!v
               : (k === 'slabMesh') ? String(v) : (Number(v) || 0);
        p.gates[i].rebar = (typeof Rebar !== 'undefined') ? Rebar.norm(cur) : cur;
        BP.saveP(); BP.open(id);
      };
    }
    return 'BuildPlan.' + nm;
  };

  function mountGates(p) {
    _gatePick.forEach(function (h) { try { h.destroy(); } catch (e) {} });
    _gatePick = [];
    _g3dDestroy();
    if (typeof Gates === 'undefined') return;
    (p.gates || []).forEach(function (g, i) {
      var out = document.getElementById('gSel' + i);

      // ── 3D ──
      // Handed to the same viewer the shed uses, as a prebuilt face list.
      // One viewer at a time by construction: a phone cannot fill four
      // canvases, and nobody orbits two gates at once.
      var host3 = document.getElementById('gView' + i);
      if (host3 && typeof Shed3D !== 'undefined' && Gates.model3d) {
        var model = Gates.model3d(g);
        if (model) {
          var labels = {};
          Gates.partsOf(g).forEach(function (role) {
            var lab = Gates.partLabel(g, role);
            if (lab) labels[role] = { title: lab.name, sub: lab.profile };
          });
          _g3d[i] = Shed3D.mount(host3, model, {
            state: _g3dCam[i] || null,
            labels: labels,
            onSelect: function (role) {
              if (!out) return;
              var lab = role ? Gates.partLabel(g, role) : null;
              out.innerHTML = lab
                ? '<span style="opacity:.75;">' + BP.esc(lab.name) + '</span> ' +
                  '<b style="color:var(--accent,#ff9f43);">' + BP.esc(lab.profile) + '</b>'
                : '';
            }
          });
        }
        return;
      }

      var host = document.getElementById('gDraw' + i);
      if (!host) return;
      var h = Gates.bindPicker(host, g, out);
      if (h) _gatePick.push(h);

      // A legend for the same reason the shed has one: on a phone,
      // hunting for a 2 mm diagonal with a fingertip is not discovery.
      var leg = document.getElementById('gLeg' + i);
      if (!leg) return;
      leg.innerHTML = Gates.partsOf(g).map(function (role) {
        var lab = Gates.partLabel(g, role);
        if (!lab) return '';
        return '<button onclick="BuildPlan.pickGatePart(' + i + ',\'' + role + '\')" ' +
          'style="display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:9px;' +
          'border:1px solid var(--border,#ccc);background:var(--surface,#fff);color:var(--text,#222);' +
          'font-family:inherit;font-size:.68rem;font-weight:700;cursor:pointer;">' +
          lab.icon + ' ' + BP.esc(lab.name) + '</button>';
      }).join('');
    });
  }

  // Selecting from the legend is the same gesture as tapping the member.
  BP.pickGatePart = function pickGatePart(i, role) {
    var h = _gatePick[i];
    if (h) h.select(role);
  };

  BP.applyModel = function applyModel(id, key) {
    var p = BP.projById(id), src = BP.MODELS[key];
    if (!p || !src) return;
    Object.keys(src).forEach(function (k) {
      if (k !== 'label') p.dims[k] = src[k];
    });
    p.dims._model = key;
    // A different model has a different set of members, so stale hidden
    // layers would silently blank parts of the new one.
    if (_v3dState) _v3dState.hidden = {};
    BP.saveP();
    BP.open(id);
  };

  BP.view3d = function view3d(yaw, pitch) { if (BP._v3d) BP._v3d.setView(yaw, pitch); };
  BP.resetView = function resetView() {
    if (!BP._v3d) return;
    BP._v3d.resetView();
    if (_v3dState) _v3dState.cam = null;
  };
  // Sun is a view setting, not a property of the building — it moves the
  // shadows so the client can see the shade the structure will actually
  // throw, which for a farm canopy is often the entire point of building it.
  var _sunSave = null;
  BP.sun = function sun(id, k, v) {
    var p = BP.projById(id);
    if (!p) return;
    p.dims[k] = Number(v) || 0;
    if (BP._v3d) BP._v3d.setSun(p.dims.sunAz*Math.PI/180, p.dims.sunEl*Math.PI/180);
    // Persist on a trailing timer instead of per input event — dragging the
    // sun through 180 degrees should be one write, not seventy.
    if (_sunSave) clearTimeout(_sunSave);
    _sunSave = setTimeout(BP.saveP, 600);
  };

  // A slider and a number field on the same value: drag to explore the
  // shape, type when the dimension is already decided.
  // Slider and number field bound to each other without a repaint: the
  // slider writes the number box directly and nudges the 3D model, so
  // dragging stays at frame rate instead of rebuilding the whole sheet.
  function ctl(id, key, label, val, min, max, step) {
    var nid = 'n_' + key, rid = 'r_' + key;
    return '<div><div class="bp-lbl">' + label +
        ' <b id="v_' + key + '" style="color:var(--accent,#ff9f43);">' + val + '</b></div>' +
      '<input class="bp-rng" id="' + rid + '" type="range" min="' + min + '" max="' + max +
        '" step="' + step + '" value="' + val + '" ' +
        'oninput="BuildPlan._live(' + id + ',\'' + key + '\',this.value)" ' +
        'onchange="BuildPlan._commit(' + id + ',\'' + key + '\',this.value)">' +
      '<input class="bp-in" id="' + nid + '" type="number" step="' + step + '" value="' + val + '" ' +
        'style="margin-top:3px;" ' +
        'oninput="BuildPlan._live(' + id + ',\'' + key + '\',this.value)" ' +
        'onchange="BuildPlan._commit(' + id + ',\'' + key + '\',this.value)"></div>';
  }

  // One list of real products plus "ללא". What is shown is what is billed.
  function cladSelect(id, key, cur) {
    var o = '<option value="none"' + (cur === 'none' ? ' selected' : '') + '>' +
      BP.tt('ללא', 'ไม่มี', 'بدون') + '</option>';
    var seen = false;
    (BP.C.profiles || []).forEach(function (x) {
      if (x.group !== 'חיפוי') return;
      if (x.name === cur) seen = true;
      o += '<option value="' + BP.esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        BP.esc(BP.dsp(x.name)) + (x.price ? ' \u00b7 ' + BP.money(x.price) : '') + '</option>';
    });
    // A product that has been removed from the catalogue still has to show,
    // or the box would silently claim the project uses something else.
    if (cur && cur !== 'none' && !seen) {
      o += '<option value="' + BP.esc(cur) + '" selected>' + BP.esc(BP.dsp(cur)) + ' \u26a0\ufe0f</option>';
    }
    return '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)">' +
      o + '</select>';
  }

  function profSel(id, key, group, cur) {
    var o = '';
    (BP.C.profiles || []).filter(function (x) { return x.group === group; }).forEach(function (x) {
      o += '<option value="' + BP.esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        BP.esc(BP.dsp(x.name)) + (x.kgPerM ? ' \u00b7 ' + x.kgPerM + ' kg/m' : '') +
        (x.price ? ' \u00b7 ' + BP.money(x.price) : '') + '</option>';
    });
    return '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'' + key + '\',this.value)">' +
      o + '</select>';
  }

  BP._v3d = null;
  var _v3dState = null;      // camera / layers / sun, carried across remounts
  var _v3dFor = null;        // which project that state belongs to
  var _groundCache = {};

  // ── satellite ground ────────────────────────────────────────────────
  // Composites Esri World Imagery tiles covering the project footprint into
  // one canvas, which shed3d.js then maps onto the ground plane. Tiles are
  // requested with CORS so the canvas stays untainted and snapshot() keeps
  // working; if imagery fails the scene simply keeps its flat ground rather
  // than failing to render.
  var TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

  function lon2x(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2y(lat, z) {
    var r = lat * Math.PI / 180;
    return (1 - Math.log(Math.tan(r) + 1/Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z);
  }

  function groundImage(p, halfX, halfY) {
    var key = p.id + ':' + Math.round(halfX) + 'x' + Math.round(halfY);
    if (_groundCache[key]) return Promise.resolve(_groundCache[key]);
    if (!p.footprint || p.footprint.length < 3) return Promise.resolve(null);

    var lat = 0, lng = 0;
    p.footprint.forEach(function (pt) { lat += pt.lat; lng += pt.lng; });
    lat /= p.footprint.length; lng /= p.footprint.length;

    // Pick the zoom whose ground resolution puts the required span in a
    // sensible number of tiles — too coarse is blurry, too fine is 60 fetches.
    var mpp = 156543.03392 * Math.cos(lat * Math.PI/180);
    var need = Math.max(halfX, halfY) * 2;
    // 18, matching the map's maxNativeZoom. Requesting z19 here hit the same
    // patchy coverage that blanked the map, and a missing tile left a hole
    // in the satellite ground plane.
    var z = 18;
    while (z > 14 && (mpp / Math.pow(2, z)) * 256 * 3 < need) z--;
    var res = mpp / Math.pow(2, z);

    var cx = lon2x(lng, z), cy = lat2y(lat, z);
    var tilesX = Math.ceil(halfX * 2 / (res * 256)) + 1;
    var tilesY = Math.ceil(halfY * 2 / (res * 256)) + 1;
    tilesX = Math.min(6, Math.max(2, tilesX));
    tilesY = Math.min(6, Math.max(2, tilesY));

    var x0 = Math.floor(cx - tilesX/2), y0 = Math.floor(cy - tilesY/2);
    var cv = document.createElement('canvas');
    cv.width = tilesX * 256; cv.height = tilesY * 256;
    var ctx = cv.getContext('2d');

    var jobs = [];
    for (var i = 0; i < tilesX; i++) {
      for (var j = 0; j < tilesY; j++) {
        (function (i, j) {
          jobs.push(new Promise(function (res2) {
            var img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = function () { ctx.drawImage(img, i*256, j*256); res2(true); };
            img.onerror = function () { res2(false); };
            img.src = TILE_URL.replace('{z}', z).replace('{x}', x0+i).replace('{y}', y0+j);
          }));
        })(i, j);
      }
    }

    return Promise.all(jobs).then(function (r) {
      // A composite that is mostly missing tiles is worse than none: the
      // ground plane would show holes where imagery should be.
      if (r.filter(Boolean).length < r.length * 0.75) return null;
      // Metre extents of the composited canvas, relative to the footprint
      // centroid — this is what pins the imagery to the model 1:1.
      var out = new Image();
      var extent = {
        x0: (x0 - cx) * 256 * res,
        x1: (x0 + tilesX - cx) * 256 * res,
        y0: -((y0 + tilesY - cy) * 256 * res),
        y1: -((y0 - cy) * 256 * res)
      };
      return new Promise(function (done) {
        out.onload = function () {
          _groundCache[key] = { img: out, extent: extent };
          done(_groundCache[key]);
        };
        out.onerror = function () { done(null); };
        out.src = cv.toDataURL('image/jpeg', 0.85);
      });
    }).catch(function () { return null; });
  }

  BP.model3d = function model3d(p) {
    var d = p.dims;
    return {
      span: d.span, length: d.length, eaves: d.eaves, bay: d.bay, pitch: d.pitch,
      roofType: d.roofType, wallMode: d.wallMode,
      roofClad: d.roofClad, wallClad: d.wallClad,
      purlinSp: d.purlinSp, girtSp: d.girtSp, slabTh: d.slabTh,
      footings: d.footings, footW: d.footW, footD: d.footD,
      fence: d.fence, fenceH: d.fenceH, fenceOff: d.fenceOff,
      rafterType: d.rafterType, trussDepth: d.trussDepth,
      haunch: d.haunch, taper: d.taper, bracing: d.bracing,
      skylights: d.skylights, door: d.door, doorW: d.doorW, doorH: d.doorH,
      leanTo: d.leanTo, mezz: d.mezz, mezzH: d.mezzH,
      gutter: d.gutter, shadows: d.shadows, dims: d.dims, callouts: d.callouts,
      scaleRef: d.scaleRef, scaleH: d.scaleH,
      context: true
    };
  };

  // Mounted after paint(), because the canvas has no size until it is in the
  // document. Rebuilt rather than reused across repaints — the host node is
  // replaced by every innerHTML swap, so a retained instance would be
  // pointing at a detached canvas.
  function mount3d(p) {
    var host = document.getElementById('bp3d');
    if (!host || typeof Shed3D === 'undefined') return;
    BP._v3d = Shed3D.mount(host, BP.model3d(p), {
      state: _v3dState,
      labels: calloutLabels(p),
      onSelect: function (g) {
        var el = document.getElementById('bpSel');
        if (el) el.textContent = g ? memberLabel(g) : '';
        // Tapping the member in the model is the same gesture as tapping it
        // in the legend — both should offer the swap.
        if (g) BP.swapPanel(g); else BP.closeSwap();
      }
    });
    _v3dFor = p.id;
    if (!_v3dState) BP._v3d.setSun(p.dims.sunAz*Math.PI/180, p.dims.sunEl*Math.PI/180);

    var lay = document.getElementById('bpLayers');
    if (lay) lay.innerHTML = layersPanel(p);
    BP.legendPanel(p);

    if (p.dims.mapGround !== false && p.footprint && p.footprint.length >= 3) {
      var pad = Math.max(p.dims.span, p.dims.length) * 0.9;
      groundImage(p, p.dims.length/2 + pad, p.dims.span/2 + pad).then(function (g) {
        if (g && BP._v3d) BP._v3d.setGround(g.img, g.extent);
      });
    }
  }

  // Callout text comes from the takeoff, so a chip says the section AND how
  // much of it the job needs — the two questions anyone pointing at a member
  // in a drawing is actually asking.
  function calloutLabels(p) {
    var d = p.dims, g = BP.geom(d), rows = BP.takeoff(p), out = {};
    function qty(name) {
      var t = 0, u = '';
      rows.forEach(function (r) { if (r.name === name) { t += r.qty; u = r.unit; } });
      return t ? BP.n1(t) + ' ' + u : '';
    }
    out.column = { title: memberLabel('column'), sub: d.colProfile + '  ' + qty(d.colProfile) };
    out.rafter = { title: memberLabel('rafter'),
      sub: (d.rafterType === 'truss' ? BP.tt('סבכה', 'โครงถัก', 'جملون') + ' ' + BP.n1(d.trussDepth) + 'm  ' : '') +
        d.rafterProfile + '  ' + qty(d.rafterProfile) };
    out.purlin = { title: memberLabel('purlin'), sub: d.purlinProfile + '  ' + qty(d.purlinProfile) };
    if (d.wallMode !== 'open') {
      out.girt = { title: memberLabel('girt'), sub: d.girtProfile + '  ' + qty(d.girtProfile) };
      out.wall = { title: memberLabel('wall'), sub: BP.dsp(d.wallClad) + '  ' + qty(d.wallClad) };
    }
    if (d.roofClad !== 'none') {
      out.roof = { title: memberLabel('roof'), sub: BP.dsp(d.roofClad) + '  ' + qty(d.roofClad) };
    }
    if (d.skylights > 0) out.skylight = { title: memberLabel('skylight'), sub: qty('לוח סקיילייט') };
    if (d.gutter) out.gutter = { title: memberLabel('gutter'), sub: qty('מרזב') };
    if (d.haunch) out.haunch = { title: memberLabel('haunch'), sub: '' };
    if (d.bracing) out.brace = { title: memberLabel('brace'), sub: '' };
    if (d.footings) {
      out.footing = { title: memberLabel('footing'),
        sub: g.frames*2 + ' \u00d7 ' + BP.n1(d.footW) + '\u00d7' + BP.n1(d.footW) + '\u00d7' + BP.n1(d.footD) + 'm' };
    }
    out.slab = { title: memberLabel('slab'), sub: BP.n2(BP.concrete(p).total) + ' \u05de"\u05e7' };
    if (d.door) out.door = { title: memberLabel('door'), sub: BP.n1(d.doorW) + '\u00d7' + BP.n1(d.doorH) + 'm' };
    if (d.mezz > 0) out.mezz = { title: memberLabel('mezz'), sub: BP.n1(d.mezz) + 'm' };
    if (d.fence) out.fence = { title: memberLabel('fence'), sub: BP.n1(d.fenceH) + 'm' };
    return out;
  }

  var LAYER_ORDER = ['column','haunch','rafter','purlin','strut','brace','girt',
                     'roof','skylight','ridge','wall','door','gutter',
                     'slab','footing','mezz','fence'];

  // Turning the cladding off to look at the frame is the single most useful
  // thing you can do with a model like this, and it was impossible.
  function layersPanel(p) {
    if (!BP._v3d) return '';
    var present = BP._v3d.groups();
    var pal = Shed3D.PALETTE;
    var html = '';
    LAYER_ORDER.forEach(function (g) {
      if (!present[g]) return;
      var off = BP._v3d.isHidden(g);
      html += '<div class="bp-layer' + (off ? ' off' : '') + '" onclick="BuildPlan.toggleLayer(\'' + g + '\')">' +
        '<span class="bp-sw" style="background:' + (pal[g] || '#999') + ';"></span>' +
        '<span style="flex:1;">' + memberLabel(g).replace('\ud83d\udc46 ', '') + '</span>' +
        '<span style="opacity:.6;font-size:.72rem;">' + (off ? '\u25cb' : '\u25c9') + '</span></div>';
    });
    return html + '<div style="display:flex;gap:6px;margin-top:6px;">' +
      '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.74rem;" ' +
        'onclick="BuildPlan.layersAll(true)">' + BP.tt('הצג הכל', 'แสดงทั้งหมด', 'إظهار الكل') + '</button>' +
      '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.74rem;" ' +
        'onclick="BuildPlan.layersFrame()">' + BP.tt('שלד בלבד', 'เฉพาะโครง', 'الهيكل فقط') + '</button>' +
    '</div>';
  }

  // Named toggleLayer, not layer(): layer() is the Leaflet layer-group
  // accessor above, and a second declaration with the same name silently
  // replaced it for the whole module — which is why footprints stopped
  // appearing on the map.
  BP.toggleLayer = function toggleLayer(g) {
    if (!BP._v3d) return;
    BP._v3d.toggleLayer(g);
    var host = document.getElementById('bpLayers');
    if (host && BP._open) { host.innerHTML = layersPanel(BP.projById(BP._open)); BP.legendPanel(BP.projById(BP._open)); }
  };
  BP.layersAll = function layersAll(show) {
    if (!BP._v3d) return;
    var next = {};
    if (!show) Object.keys(BP._v3d.groups()).forEach(function (g) { next[g] = true; });
    BP._v3d.setHidden(next);
    var host = document.getElementById('bpLayers');
    if (host && BP._open) host.innerHTML = layersPanel(BP.projById(BP._open));
  };
  // Strip everything that hides the steel — the view a fabricator wants.
  BP.layersFrame = function layersFrame() {
    if (!BP._v3d) return;
    BP._v3d.setHidden({ roof:1, wall:1, skylight:1, door:1, fence:1, slab:1, ridge:1, gutter:1 });
    var host = document.getElementById('bpLayers');
    if (host && BP._open) host.innerHTML = layersPanel(BP.projById(BP._open));
  };

  // A legend under the model instead of chips on top of it. Every member
  // group with its colour and quantity, readable at a glance, and clicking
  // one selects it in the 3D view — which is when the single callout
  // appears. Annotation on demand rather than seven labels fighting the
  // drawing they annotate.
  BP.legendPanel = function legendPanel(p) {
    var host = document.getElementById('bpLegend');
    if (!host || !BP._v3d) return;
    var labels = calloutLabels(p);
    var present = BP._v3d.groups();
    var pal = Shed3D.PALETTE;
    var html = '';
    LAYER_ORDER.forEach(function (g) {
      if (!present[g] || !labels[g] || BP._v3d.isHidden(g)) return;
      var l = labels[g];
      html += '<button onclick="BuildPlan.pickMember(\'' + g + '\')" ' +
        'style="display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:9px;' +
        'border:1px solid var(--border,#ccc);background:var(--surface,#fff);color:var(--text,#222);' +
        'font-family:inherit;font-size:.72rem;font-weight:700;cursor:pointer;">' +
        '<span style="width:9px;height:9px;border-radius:2px;background:' + (pal[g]||'#999') + ';"></span>' +
        BP.esc(l.title.replace('\ud83d\udc46 ', '')) +
        (l.sub ? '<span style="opacity:.6;font-weight:600;"> ' + BP.esc(l.sub) + '</span>' : '') +
      '</button>';
    });
    host.innerHTML = html;
  };

  BP.pickMember = function pickMember(g) {
    if (!BP._v3d) return;
    BP._v3d.select(g);
    var el = document.getElementById('bpSel');
    if (el) el.textContent = memberLabel(g);
    BP.swapPanel(g);
  };

  // Tap a member, see what else would carry it. Every candidate shows its
  // utilisation, so the choice is between sections that work rather than a
  // dropdown of every section in the catalogue.
  BP._swapRole = null;
  BP.swapPanel = function swapPanel(role) {
    BP._swapRole = BP.ROLE_KEY[role] ? role : null;
    var host = document.getElementById('bpSwap');
    if (!host) return;
    if (!BP.ROLE_KEY[role] || !BP._open) { host.innerHTML = ''; return; }
    var p = BP.projById(BP._open);
    if (!p) { host.innerHTML = ''; return; }
    var d = p.dims, cur = d[BP.ROLE_KEY[role]];
    var list = BP.candidates(role, d);
    if (!list.length) { host.innerHTML = ''; return; }

    var curR = BP.checkMember(role, cur, d);
    var rows = list.map(function (c) {
      var pct = Math.round(c.util * 100);
      var isCur = c.name === cur;
      var col = c.ok ? (c.util > 0.85 ? '#e08e00' : 'var(--primary,#2d6a4f)') : '#c62828';
      return '<button onclick="BuildPlan.swapTo(\'' + role + '\',\'' + BP.esc(c.name) + '\')" ' +
        'style="display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;' +
        'padding:7px 10px;margin-bottom:4px;border-radius:9px;font-family:inherit;font-size:.78rem;' +
        'cursor:pointer;text-align:start;' +
        'border:' + (isCur ? '2px solid var(--accent,#ff9f43)' : '1px solid var(--border,#ccc)') + ';' +
        'background:var(--surface,#fff);color:var(--text,#222);' + (c.ok ? '' : 'opacity:.62;') + '">' +
        '<span style="font-weight:700;">' + (c.ok ? '\u2713' : '\u2717') + ' ' + BP.esc(c.name) +
          (isCur ? ' \u00b7 ' + BP.tt('נוכחי', 'ปัจจุบัน', 'الحالي') : '') + '</span>' +
        '<span style="white-space:nowrap;color:' + col + ';font-weight:800;">' + pct + '%' +
          '<span style="color:var(--text-muted,#888);font-weight:600;"> \u00b7 ' +
          BP.n1(c.kg) + ' kg/m</span></span></button>';
    }).join('');

    host.innerHTML =
      '<div class="bp-card" style="border:1.5px solid var(--accent,#ff9f43);">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<div style="font-weight:800;">' + memberLabel(role).replace('\ud83d\udc46 ', '') + '</div>' +
          '<button class="bp-btn ghost" style="padding:3px 9px;font-size:.72rem;" ' +
            'onclick="BuildPlan.closeSwap()">\u2715</button></div>' +
        (curR.known
          ? '<div style="font-size:.74rem;color:var(--text-muted,#888);margin:4px 0 8px;">' +
            BP.esc(cur) + ' \u00b7 ' + curR.why + ' \u00b7 ' +
            BP.tt('מוט', 'ช่วง', 'مجاز') + ' ' + BP.n1(curR.span) + ' m \u00b7 ' +
            BP.tt('ניצול', 'การใช้งาน', 'الاستغلال') + ' ' + Math.round(curR.util * 100) + '%</div>'
          : '<div style="height:6px;"></div>') +
        rows +
        '<div style="font-size:.68rem;color:var(--text-muted,#888);margin-top:6px;line-height:1.5;">' +
          '\u26a0\ufe0f ' + BP.tt(
            'בדיקה ראשונית בלבד: עומס אחיד, ללא רוח מרימה, ללא שילוב כפיפה-לחיצה, ללא קריסה לרוחב, ללא חיבורים ושקיעות. נדרש אישור מהנדס.',
            'ตรวจสอบเบื้องต้นเท่านั้น ต้องมีวิศวกรรับรอง',
            'فحص أولي فقط — يلزم اعتماد مهندس') + '</div>' +
      '</div>';
    host.scrollIntoView({ block: 'nearest' });
  };

  BP.swapTo = function swapTo(role, name) {
    var p = BP.projById(BP._open);
    if (!p || !BP.ROLE_KEY[role]) return;
    p.dims[BP.ROLE_KEY[role]] = name;
    BP.saveP();
    var r = BP.checkMember(role, name, p.dims);
    if (r.known && !r.ok) {
      BP.toast('\u26a0\ufe0f ' + BP.esc(name) + ' \u00b7 ' +
        BP.tt('ניצול', 'การใช้งาน', 'الاستغلال') + ' ' + Math.round(r.util * 100) + '%');
    } else {
      BP.toast('\u2705 ' + BP.esc(name));
    }
    BP.open(BP._open);
    setTimeout(function () { BP.pickMember(role); }, 60);
  };

  BP.closeSwap = function closeSwap() {
    BP._swapRole = null;
    var host = document.getElementById('bpSwap');
    if (host) host.innerHTML = '';
    if (BP._v3d) BP._v3d.select(null);
  };

  function memberLabel(g) {
    var names = {
      column:  BP.tt('עמודים', 'เสา', 'أعمدة'),
      rafter:  BP.tt('קורות גג', 'คาน', 'روافد'),
      purlin:  BP.tt('מרישים', 'แป', 'مرايش'),
      girt:    BP.tt('מסילות קיר', 'แปผนัง', 'مرايش الجدار'),
      roof:    BP.tt('חיפוי גג', 'หลังคา', 'تغطية السقف'),
      wall:    BP.tt('חיפוי קיר', 'ผนัง', 'تغطية الجدار'),
      slab:    BP.tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني'),
      footing: BP.tt('בסיסי עמודים', 'ฐานเสา', 'قواعد الأعمدة'),
      fence:   BP.tt('גדר', 'รั้ว', 'سياج'),
      haunch:  BP.tt('חיזוק פינה (האנץ\')', 'ฮันช์', 'تقوية الركن'),
      strut:   BP.tt('קורת שפה', 'คานชายคา', 'رافدة الحافة'),
      brace:   BP.tt('אלכסוני ייצוב', 'ค้ำยัน', 'دعامات'),
      gutter:  BP.tt('מרזב וניקוז', 'รางน้ำ', 'مزراب'),
      ridge:   BP.tt('רכס גג', 'สันหลังคา', 'قمة السقف'),
      skylight:BP.tt('לוח סקיילייט', 'สกายไลท์', 'لوح إضاءة'),
      door:    BP.tt('דלת/שער', 'ประตู', 'باب'),
      mezz:    BP.tt('גלריה', 'ชั้นลอย', 'ميزانين')
    };
    return '\ud83d\udc46 ' + (names[g] || g);
  }

  function designTab(p) {
    var id = p.id, d = p.dims;

    if (p.type === 'slab') {
      var hs = '<div class="bp-split">' +
        '<div class="bp-stick"><div class="bp-card">' + BP.svg(p) + '</div>' +
          '<div class="bp-card"><div class="bp-lbl">' +
            BP.tt('נתונים מחושבים', 'ค่าที่คำนวณ', 'قيم محسوبة') + '</div>' +
            '<div id="bpRead"></div></div></div>' +
        '<div class="bp-pane">' +
          '<details class="bp-acc" open><summary>' + BP.tt('מידות', 'ขนาด', 'الأبعاد') + '</summary><div>' +
          '<div class="bp-grid">' +
            ctl(id, 'length', BP.tt('אורך (מ\')', 'ยาว', 'الطول'), d.length, 2, 80, 0.5) +
            ctl(id, 'span',   BP.tt('רוחב (מ\')', 'กว้าง', 'العرض'), d.span, 2, 40, 0.5) +
            ctl(id, 'slabTh', BP.tt('עובי (מ\')', 'หนา', 'السماكة'), d.slabTh, 0.08, 0.5, 0.01) +
            ctl(id, 'waste',  BP.tt('פחת %', 'เผื่อ %', 'هدر %'), d.waste, 0, 25, 1) +
          '</div>' +
          (p.footprintArea > 0 ? '<div style="font-size:.78rem;color:var(--accent,#ff9f43);margin-top:8px;">' +
            '\ud83d\uddfa ' + BP.tt('השטח נלקח מהמצולע במפה', 'ใช้พื้นที่จากแผนที่', 'المساحة من الخريطة') +
            ': ' + BP.n1(p.footprintArea) + ' \u05de"\u05e8</div>' : '') +
          '</div></details>' +
        '</div></div>';
      return hs;
    }

    var g = BP.geom(d), ft = BP.footing(d), con = BP.concrete(p);

    // Five buttons wrapping onto three lines on a phone, of which four are
    // always wrong. A dropdown states which one is loaded and costs one tap
    // to change — and applyModel() overwrites the dimensions, so it should
    // not be the easiest thing on the panel to hit by accident.
    var models = '<select class="bp-in" onchange="BuildPlan.applyModel(' + id + ',this.value)">' +
      '<option value="">' +
        (d._model ? BP.tt('החלף דגם…', 'เปลี่ยนแบบ…', 'تغيير النموذج…')
                  : BP.tt('בחר דגם התחלתי…', 'เลือกแบบเริ่มต้น…', 'اختر نموذجاً…')) + '</option>' +
      Object.keys(BP.MODELS).map(function (k) {
        return '<option value="' + k + '"' + (d._model === k ? ' selected' : '') + '>' +
          BP.esc(BP.pick(BP.MODELS[k].label)) + '</option>';
      }).join('') + '</select>';

    // Left column holds the model and the derived numbers and stays put;
    // the right column scrolls. Previously every panel was stacked in one
    // list, so by the time you reached the foundation sliders the drawing
    // they affect was far off screen.
    return '<div class="bp-split">' +
      '<div class="bp-stick">' +
'<div class="bp-card">' +
        '<div id="bp3d" style="height:min(46vh,440px);border-radius:12px;overflow:hidden;' +
          'background:radial-gradient(circle at 50% 30%,rgba(255,255,255,.06),rgba(0,0,0,.25));"></div>' +
        '<div id="bpLegend" style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;"></div>' +
        '<div id="bpSwap" style="margin-top:8px;"></div>' +
        '<div style="display:flex;justify-content:space-between;gap:8px;margin-top:6px;flex-wrap:wrap;">' +
          '<span style="font-size:.74rem;color:var(--text-muted,#888);">' +
            BP.tt('גרירה = סיבוב \u00b7 Shift+גרירה = הזזה \u00b7 גלגלת = זום \u00b7 לחיצה = בחירה',
               'ลาก=หมุน Shift=เลื่อน ล้อ=ซูม แตะ=เลือก',
               'سحب=تدوير \u00b7 Shift=تحريك \u00b7 عجلة=تكبير \u00b7 نقر=تحديد') + '</span>' +
          '<span id="bpSel" style="font-size:.78rem;font-weight:800;color:var(--accent,#ff9f43);"></span>' +
        '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(-0.62,0.42)">\u2934 ' + BP.tt('איזומטרי', 'ไอโซ', 'أيزومتري') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(0,0.02)">\u25ad ' + BP.tt('חזית', 'ด้านหน้า', 'واجهة') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(1.5708,0.02)">\u25b1 ' + BP.tt('צד', 'ด้านข้าง', 'جانب') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.view3d(0,1.35)">\u2b1c ' + BP.tt('מבט על', 'ด้านบน', 'علوي') + '</button>' +
          '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.74rem;" ' +
            'onclick="BuildPlan.resetView()">\u21ba ' + BP.tt('איפוס', 'รีเซ็ต', 'إعادة') + '</button>' +
        '</div>' +
      '</div>' +
        '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:4px;">' +
          BP.tt('נתונים מחושבים', 'ค่าที่คำนวณ', 'قيم محسوبة') + '</div>' +
          '<div id="bpRead"></div></div>' +
      '</div>' +

      '<div class="bp-pane">' +
        // What this project contains at all. A gate on its own is a project;
        // so is a slab. Forcing every project to be a shed is what put
        // 4.5 tonnes of steel on a gate.
        '<details class="bp-acc" open><summary>' +
          BP.tt('רכיבי הפרויקט', 'ส่วนประกอบ', 'مكونات المشروع') + '</summary><div>' +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.82rem;">' +
            '<label><input type="checkbox"' + (p.hasStruct !== false ? ' checked' : '') +
              ' onchange="BuildPlan._comp(' + id + ',\'hasStruct\',this.checked)"> ' +
              BP.tt('שלד / סככה', 'โครงสร้าง', 'هيكل') + '</label>' +
            '<label><input type="checkbox"' + (p.hasSlab !== false ? ' checked' : '') +
              ' onchange="BuildPlan._comp(' + id + ',\'hasSlab\',this.checked)"> ' +
              BP.tt('משטח בטון', 'พื้นคอนกรีต', 'سطح خرساني') + '</label>' +
          '</div>' +
          '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-top:6px;">' +
            BP.tt('שערים ומבני מגורים נוספים בלשוניות שלהם', 'ประตูและที่พักในแท็บแยก',
               'البوابات والسكن في تبويباتها') + '</div>' +
        '</div></details>' +

        '<details class="bp-acc" open><summary>' +
          BP.tt('דגם התחלתי', 'แบบเริ่มต้น', 'نموذج أولي') + '</summary><div>' +

      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + models + '</div>' +
        '</div></details>' +

        '<details class="bp-acc" open><summary>' +
          BP.tt('שכבות תצוגה', 'เลเยอร์', 'طبقات العرض') + '</summary>' +
          '<div id="bpLayers">' + layersPanel(p) + '</div></details>' +

        '<details class="bp-acc" open><summary>' +
          BP.tt('מידות עיקריות', 'ขนาดหลัก', 'الأبعاد الرئيسية') + '</summary><div>' +
          '<div class="bp-grid">' +
            ctl(id, 'span',   BP.tt('מפתח (מ\')', 'ช่วงกว้าง', 'الباع'), d.span, 4, 40, 0.5) +
            ctl(id, 'length', BP.tt('אורך (מ\')', 'ยาว', 'الطول'), d.length, 4, 100, 0.5) +
            ctl(id, 'eaves',  BP.tt('גובה עמוד (מ\')', 'สูงเสา', 'ارتفاع العمود'), d.eaves, 2, 12, 0.1) +
            ctl(id, 'bay',    BP.tt('מרווח מסגרות (מ\')', 'ระยะเฟรม', 'تباعد الإطارات'), d.bay, 2, 10, 0.5) +
            ctl(id, 'pitch',  BP.tt('שיפוע גג (\u00b0)', 'ความชัน', 'الميل'), d.pitch, 0, 35, 1) +
            ctl(id, 'waste',  BP.tt('פחת %', 'เผื่อ %', 'هدر %'), d.waste, 0, 25, 1) +
          '</div>' +
          '<div id="bpBayWarn" style="font-size:.75rem;color:var(--accent,#ff9f43);margin-top:6px;">' +
            (Math.abs(g.actualBay - d.bay) > 0.05
              ? '\u26a0\ufe0f ' + BP.tt('המרווח הותאם ל-', 'ปรับระยะเป็น ', 'تم ضبط التباعد إلى ') +
                BP.n1(g.actualBay) + ' m ' +
                BP.tt('כדי לחלק את האורך שווה בשווה', 'เพื่อแบ่งเท่ากัน', 'لتقسيم متساوٍ')
              : '') + '</div>' +
        '</div></details>' +

        '<details class="bp-acc"><summary>' +
          BP.tt('גג וחיפוי', 'หลังคา', 'السقف والتغطية') + '</summary><div>' +
'<div class="bp-grid">' +
        '<div><div class="bp-lbl">' + BP.tt('סוג גג', 'ชนิดหลังคา', 'نوع السقف') + '</div>' +
          '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'roofType\',this.value)">' +
            '<option value="gable"' + (d.roofType === 'gable' ? ' selected' : '') + '>' +
              BP.tt('אגוזי (שני שיפועים)', 'จั่ว', 'جملوني') + '</option>' +
            '<option value="mono"' + (d.roofType === 'mono' ? ' selected' : '') + '>' +
              BP.tt('חד-שיפועי', 'เพิงหมาแหงน', 'ميل واحد') + '</option></select></div>' +
        // Built from the catalogue, because the model stores the PRODUCT.
        // These used to offer a three-value enum while the model held a
        // product name, so nothing ever matched: the box showed the first
        // option and the takeoff billed whatever was really stored. That is
        // the "פאנל 5 I never chose" — it was the default, displayed as
        // something else.
        '<div><div class="bp-lbl">' + BP.tt('חיפוי גג', 'วัสดุหลังคา', 'مادة السقف') + '</div>' +
          cladSelect(id, 'roofClad', d.roofClad) + '</div>' +
        '<div><div class="bp-lbl">' + BP.tt('קירות', 'ผนัง', 'الجدران') + '</div>' +
          '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'wallMode\',this.value)">' +
            '<option value="full"' + (d.wallMode === 'full' ? ' selected' : '') + '>' +
              BP.tt('סגור', 'ปิด', 'مغلق') + '</option>' +
            '<option value="half"' + (d.wallMode === 'half' ? ' selected' : '') + '>' +
              BP.tt('חצי גובה', 'ครึ่ง', 'نصف') + '</option>' +
            '<option value="open"' + (d.wallMode === 'open' ? ' selected' : '') + '>' +
              BP.tt('פתוח', 'เปิด', 'مفتوح') + '</option></select></div>' +
        '<div><div class="bp-lbl">' + BP.tt('חיפוי קיר', 'วัสดุผนัง', 'مادة الجدار') + '</div>' +
          cladSelect(id, 'wallClad', d.wallClad) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
        '<label><input type="checkbox"' + (d.fence ? ' checked' : '') +
          ' onchange="BuildPlan._dim(' + id + ',\'fence\',this.checked)"> ' +
          BP.tt('גידור היקפי', 'รั้วรอบ', 'سياج محيطي') + '</label>' +
        (d.fence ? '<label style="font-size:.78rem;">' + BP.tt('גובה', 'สูง', 'ارتفاع') +
          ' <input type="number" step="0.1" value="' + d.fenceH + '" style="width:60px;" class="bp-in" ' +
          'onchange="BuildPlan._dim(' + id + ',\'fenceH\',this.value)"></label>' +
          '<label style="font-size:.78rem;">' + BP.tt('מרחק מהמבנה', 'ระยะห่าง', 'المسافة') +
          ' <input type="number" step="0.5" value="' + d.fenceOff + '" style="width:60px;" class="bp-in" ' +
          'onchange="BuildPlan._dim(' + id + ',\'fenceOff\',this.value)"></label>' : '') +
      '</div></div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          BP.tt('שלד ורכיבים', 'โครงสร้าง', 'الهيكل والمكونات') + '</summary><div>' +

        '<div class="bp-grid">' +
          '<div><div class="bp-lbl">' + BP.tt('סוג קורת גג', 'ชนิดคาน', 'نوع الرافدة') + '</div>' +
            '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'rafterType\',this.value)">' +
              '<option value="solid"' + (d.rafterType === 'solid' ? ' selected' : '') + '>' +
                BP.tt('קורה מלאה (H/IPE)', 'คานตัน', 'رافدة صلبة') + '</option>' +
              '<option value="truss"' + (d.rafterType === 'truss' ? ' selected' : '') + '>' +
                BP.tt('סבכה / רפפה', 'โครงถัก', 'جملون شبكي') + '</option></select></div>' +
          (d.rafterType === 'truss'
            ? ctl(id, 'trussDepth', BP.tt('גובה סבכה (מ\')', 'ความลึก', 'عمق الجملون'), d.trussDepth, 0.3, 2, 0.05)
            : '') +
          ctl(id, 'skylights', BP.tt('רצועות סקיילייט', 'สกายไลท์', 'شرائط إضاءة'), d.skylights, 0, 6, 1) +
          ctl(id, 'leanTo', BP.tt('סככת צד (מ\')', 'เพิงข้าง', 'جناح جانبي'), d.leanTo, 0, 10, 0.5) +
          ctl(id, 'mezz', BP.tt('עומק גלריה (מ\')', 'ชั้นลอย', 'عمق الميزانين'), d.mezz, 0, 12, 0.5) +
          (d.mezz > 0 ? ctl(id, 'mezzH', BP.tt('גובה גלריה (מ\')', 'สูงชั้นลอย', 'ارتفاع الميزانين'), d.mezzH, 2, 6, 0.1) : '') +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
          '<label><input type="checkbox"' + (d.haunch ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'haunch\',this.checked)"> ' +
            BP.tt('חיזוק פינה', 'ฮันช์', 'تقوية الركن') + '</label>' +
          '<label><input type="checkbox"' + (d.taper ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'taper\',this.checked)"> ' +
            BP.tt('עמוד משתנה', 'เสาเรียว', 'عمود متغير') + '</label>' +
          '<label><input type="checkbox"' + (d.bracing ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'bracing\',this.checked)"> ' +
            BP.tt('אלכסוני ייצוב', 'ค้ำยัน', 'دعامات') + '</label>' +
          '<label><input type="checkbox"' + (d.gutter ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'gutter\',this.checked)"> ' +
            BP.tt('מרזבים', 'รางน้ำ', 'مزاريب') + '</label>' +
          '<label><input type="checkbox"' + (d.door ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'door\',this.checked)"> ' +
            BP.tt('שער', 'ประตู', 'بوابة') + '</label>' +
        '</div>' +
        (d.door ? '<div class="bp-grid" style="margin-top:6px;">' +
          ctl(id, 'doorW', BP.tt('רוחב שער', 'กว้างประตู', 'عرض البوابة'), d.doorW, 1, 12, 0.5) +
          ctl(id, 'doorH', BP.tt('גובה שער', 'สูงประตู', 'ارتفاع البوابة'), d.doorH, 1.8, 8, 0.1) +
        '</div>' : '') +
      '</div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          BP.tt('פרופילים', 'โปรไฟล์', 'المقاطع') + '</summary><div>' +
'<div class="bp-grid">' +
      '<div><div class="bp-lbl">' + BP.tt('עמודים', 'เสา', 'أعمدة') + '</div>' +
        profSel(id, 'colProfile', 'עמודים / קורות', d.colProfile) + '</div>' +
      '<div><div class="bp-lbl">' + BP.tt('קורות גג', 'คาน', 'روافد') + '</div>' +
        profSel(id, 'rafterProfile', 'עמודים / קורות', d.rafterProfile) + '</div>' +
      '<div><div class="bp-lbl">' + BP.tt('מרישים', 'แป', 'مرايش') + '</div>' +
        profSel(id, 'purlinProfile', 'מרישים', d.purlinProfile) + '</div>' +
      '<div><div class="bp-lbl">' + BP.tt('מסילות קיר', 'แปผนัง', 'مرايش الجدار') + '</div>' +
        profSel(id, 'girtProfile', 'מרישים', d.girtProfile) + '</div>' +
    '</div></div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          BP.tt('ביסוס עמודים', 'ฐานราก', 'أساسات الأعمدة') + '</summary><div>' +

        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:6px;font-size:.8rem;">' +
          '<label><input type="checkbox"' + (d.footings ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'footings\',this.checked)"> ' +
            BP.tt('בסיסים בודדים', 'ฐานแยก', 'قواعد منفصلة') + '</label></div>' +
        '<div class="bp-grid">' +
          ctl(id, 'footW', BP.tt('צלע בסיס (מ\')', 'ด้านฐาน', 'ضلع القاعدة'), d.footW, 0.4, 3, 0.1) +
          ctl(id, 'footD', BP.tt('עומק בסיס (מ\')', 'ลึกฐาน', 'عمق القاعدة'), d.footD, 0.4, 2.5, 0.1) +
          ctl(id, 'slabTh', BP.tt('עובי משטח (מ\')', 'หนาพื้น', 'سماكة السطح'), d.slabTh, 0.08, 0.5, 0.01) +
          ctl(id, 'soilBearing', BP.tt('כושר נשיאה (kPa)', 'กำลังรับดิน', 'تحمل التربة'), d.soilBearing, 60, 400, 10) +
        '</div>' +
        '<div id="bpFound" style="margin-top:8px;">' + BP.footingSummary(p) + '</div>' +
        rebarPanel(p) +
        '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:6px;">\u26a0\ufe0f ' +
          BP.tt('הערכה ראשונית בלבד: עומס אחיד, ללא רוח/מומנט, קרקע הומוגנית. נדרש אישור מהנדס וסקר קרקע.',
             'ประมาณการเบื้องต้นเท่านั้น ต้องมีวิศวกรรับรอง',
             'تقدير أولي فقط — يلزم اعتماد مهندس وتقرير تربة') + '</div>' +
      '</div>' +
        '</details>' +

        '<details class="bp-acc"><summary>' +
          BP.tt('סביבה ותאורה', 'สภาพแวดล้อม', 'البيئة والإضاءة') + '</summary><div>' +

        '<div class="bp-grid">' +
          '<div><div class="bp-lbl">' + BP.tt('כיוון שמש', 'ทิศดวงอาทิตย์', 'اتجاه الشمس') + '</div>' +
            '<input class="bp-rng" type="range" min="0" max="360" step="5" value="' + d.sunAz + '" ' +
              'oninput="BuildPlan.sun(' + id + ',\'sunAz\',this.value)"></div>' +
          '<div><div class="bp-lbl">' + BP.tt('גובה שמש', 'มุมสูง', 'ارتفاع الشمس') + '</div>' +
            '<input class="bp-rng" type="range" min="8" max="88" step="2" value="' + d.sunEl + '" ' +
              'oninput="BuildPlan.sun(' + id + ',\'sunEl\',this.value)"></div>' +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
        '<div class="bp-grid" style="margin-top:8px;">' +
          '<div><div class="bp-lbl">' + BP.tt('סרגל קנה מידה', 'อ้างอิงมาตราส่วน', 'مرجع المقياس') + '</div>' +
            '<select class="bp-in" onchange="BuildPlan._dim(' + id + ',\'scaleRef\',this.value)">' +
              '<option value="staff"' + (d.scaleRef === 'staff' ? ' selected' : '') + '>' +
                BP.tt('מוט מדידה מדורג', 'ไม้วัดระดับ', 'قضيب قياس') + '</option>' +
              '<option value="person"' + (d.scaleRef === 'person' ? ' selected' : '') + '>' +
                BP.tt('דמות אדם 1.75 מ\'', 'คน 1.75 ม.', 'شخص 1.75 م') + '</option>' +
              '<option value="palm"' + (d.scaleRef === 'palm' ? ' selected' : '') + '>' +
                BP.tt('דקל עם סקאלה', 'ปาล์มมีมาตราส่วน', 'نخلة بمقياس') + '</option>' +
              '<option value="none"' + (d.scaleRef === 'none' ? ' selected' : '') + '>' +
                BP.tt('ללא', 'ไม่มี', 'بدون') + '</option></select></div>' +
          (d.scaleRef === 'palm'
            ? ctl(id, 'scaleH', BP.tt('גובה הדקל (מ\')', 'สูงปาล์ม', 'ارتفاع النخلة'), d.scaleH, 3, 20, 0.5)
            : '') +
        '</div>' +
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
          '<label><input type="checkbox"' + (d.mapGround ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'mapGround\',this.checked)"> ' +
            BP.tt('רקע לוויין מהמפה', 'ภาพดาวเทียม', 'صورة الأقمار') + '</label>' +
          '<label><input type="checkbox"' + (d.callouts ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'callouts\',this.checked)"> ' +
            BP.tt('סימוני רכיבים', 'ป้ายกำกับ', 'وسوم المكونات') + '</label>' +
          '<label><input type="checkbox"' + (d.shadows ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'shadows\',this.checked)"> ' +
            BP.tt('צללים', 'เงา', 'ظلال') + '</label>' +
          '<label><input type="checkbox"' + (d.dims ? ' checked' : '') +
            ' onchange="BuildPlan._dim(' + id + ',\'dims\',this.checked)"> ' +
            BP.tt('מידות', 'ขนาด', 'أبعاد') + '</label>' +
        '</div>' +
        '</div></div></details>' +
      '</div></div>';
  }

  // ── זיון ──────────────────────────────────────────────────────────────
  // The cage was always priced and never drawn, so the numbers behind
  // 'ברזל זיון' lived nowhere the user could see or change them. These are
  // those numbers, in the panel next to the pad they belong to, with the
  // detail drawing underneath so a change is visible immediately.
  //
  // `path` is what the setter writes through: 'dims' for the structure's
  // own footings, 'gate:N' for the Nth gate's post foundations. One builder
  // for both, because it is one cage either way.
  function rebarCtl(setter, key, label, val, min, max, step) {
    return '<div><div class="bp-lbl">' + label +
        ' <b style="color:var(--accent,#ff9f43);">' + val + '</b></div>' +
      '<input class="bp-rng" type="range" min="' + min + '" max="' + max + '" step="' + step +
        '" value="' + val + '" onchange="' + setter + '(\'' + key + '\',this.value)"></div>';
  }
  function diamSel(setter, key, label, val) {
    var list = (typeof Rebar !== 'undefined') ? Rebar.DIAM : [8, 10, 12, 14, 16, 20];
    var o = list.map(function (dd) {
      return '<option value="' + dd + '"' + (Number(val) === dd ? ' selected' : '') + '>\u00d8' +
        dd + '</option>';
    }).join('');
    return '<div><div class="bp-lbl">' + label + '</div>' +
      '<select class="bp-in" onchange="' + setter + '(\'' + key + '\',this.value)">' + o +
      '</select></div>';
  }

  function rebarFields(r, setter, opt) {
    opt = opt || {};
    r = (typeof Rebar !== 'undefined') ? Rebar.norm(r) : (r || {});
    return '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:.8rem;">' +
        '<label><input type="checkbox"' + (r.show ? ' checked' : '') +
          ' onchange="' + setter + '(\'show\',this.checked)"> ' +
          BP.tt('הצג זיון באיור', 'แสดงเหล็กเสริมในภาพ', 'إظهار التسليح في الرسم') + '</label>' +
        '<label><input type="checkbox"' + (r.mat ? ' checked' : '') +
          ' onchange="' + setter + '(\'mat\',this.checked)"> ' +
          BP.tt('מרבד תחתון', 'ตะแกรงล่าง', 'شبكة سفلية') + '</label>' +
      '</div>' +
      '<div class="bp-grid" style="margin-top:8px;">' +
        rebarCtl(setter, 'mainN', BP.tt('מוטות ראשיים', 'เหล็กหลัก', 'قضبان رئيسية'), r.mainN, 2, 12, 1) +
        diamSel(setter, 'mainD', BP.tt('קוטר ראשי', 'ขนาดเหล็กหลัก', 'قطر رئيسي'), r.mainD) +
        diamSel(setter, 'stirD', BP.tt('קוטר חישוק', 'ขนาดปลอก', 'قطر الأسورة'), r.stirD) +
        rebarCtl(setter, 'stirSp', BP.tt('מרווח חישוקים (ס"מ)', 'ระยะปลอก', 'تباعد الأساور'), r.stirSp, 5, 40, 1) +
        rebarCtl(setter, 'cover', BP.tt('כיסוי בטון (ס"מ)', 'ระยะหุ้ม', 'الغطاء'), r.cover, 2.5, 10, 0.5) +
        (r.mat ? diamSel(setter, 'matD', BP.tt('קוטר מרבד', 'ขนาดตะแกรง', 'قطر الشبكة'), r.matD) : '') +
        (r.mat ? rebarCtl(setter, 'matSp', BP.tt('מרווח מרבד (ס"מ)', 'ระยะตะแกรง', 'تباعد الشبكة'), r.matSp, 10, 30, 1) : '') +
      '</div>' +
      (opt.slab
        ? '<div class="bp-grid" style="margin-top:8px;">' +
            '<div><div class="bp-lbl">' + BP.tt('רשת במשטח', 'ตะแกรงพื้น', 'شبكة السطح') + '</div>' +
              '<select class="bp-in" onchange="' + setter + '(\'slabMesh\',this.value)">' +
                '<option value="Q188"' + (r.slabMesh === 'Q188' ? ' selected' : '') + '>' +
                  BP.tt('יריעות Q188', 'แผ่น Q188', 'ألواح Q188') + '</option>' +
                '<option value="deformed"' + (r.slabMesh === 'deformed' ? ' selected' : '') + '>' +
                  BP.tt('רשת ברזל מצולע', 'ตะแกรงข้ออ้อย', 'شبكة حديد مضلع') + '</option>' +
                '<option value="none"' + (r.slabMesh === 'none' ? ' selected' : '') + '>' +
                  BP.tt('ללא', 'ไม่มี', 'بدون') + '</option></select></div>' +
            (r.slabMesh === 'deformed'
              ? diamSel(setter, 'meshD', BP.tt('קוטר רשת', 'ขนาดตะแกรง', 'قطر الشبكة'), r.meshD) +
                rebarCtl(setter, 'meshSp', BP.tt('מרווח רשת (ס"מ)', 'ระยะตะแกรง', 'تباعد الشبكة'), r.meshSp, 10, 30, 1)
              : '') +
          '</div>'
        : '') +
      ((typeof Rebar !== 'undefined')
        ? '<div class="bp-read" style="margin-top:8px;"><span>' +
            BP.tt('כלוב', 'กรง', 'قفص') + '</span><b>' + BP.esc(Rebar.cageLabel(r)) + '</b></div>'
        : '');
  }

  function rebarPanel(p) {
    if (typeof Rebar === 'undefined') return '';
    var id = p.id, d = p.dims;
    var det = BP.rebarSvg ? BP.rebarSvg(p) : '';
    return '<div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--panel-border,rgba(255,255,255,.12));">' +
      '<div class="bp-lbl">' + BP.tt('זיון ורשתות', 'เหล็กเสริมและตะแกรง', 'التسليح والشبكات') + '</div>' +
      rebarFields(d.rebar, BP._rebarBind(id), { slab: true }) +
      (det ? '<div class="bp-draw" style="margin-top:8px;">' + det + '</div>' : '') +
    '</div>';
  }

  // The onchange strings above name a per-project function so the id does
  // not have to be threaded through every one of them. Registered lazily,
  // once per project, when the panel is built.
  BP._rebar = function _rebar(id, k, v) {
    var p = BP.projById(id);
    if (!p) return;
    var cur = (p.dims.rebar && typeof p.dims.rebar === 'object')
      ? JSON.parse(JSON.stringify(p.dims.rebar)) : {};
    cur[k] = (k === 'show' || k === 'mat') ? !!v
           : (k === 'slabMesh') ? String(v) : (Number(v) || 0);
    p.dims.rebar = (typeof Rebar !== 'undefined') ? Rebar.norm(cur) : cur;
    BP.saveP();
    if (BP._v3d) { try { BP._v3d.update(BP.model3d(p)); } catch (e) {} }
    BP.open(id);
  };
  BP._rebarBind = function _rebarBind(id) {
    var nm = '_rebar_' + id;
    if (!BuildPlan[nm]) {
      BuildPlan[nm] = function (k, v) { BP._rebar(id, k, v); };
    }
    return 'BuildPlan.' + nm;
  };

  // ── free sketch ──────────────────────────────────────────────────────
  // The parametric model covers rectangular portal frames. Everything else
  // an orchard actually builds — an L-shaped canopy, a bund wall, a ramp
  // with a turn — needs a drawing surface, and this is it.
  function sketchTab(p) {
    var b = function (tool, icon, he, th, ar) {
      return '<button class="bp-btn ghost" id="skT_' + tool + '" ' +
        'style="padding:7px 11px;font-size:.78rem;" onclick="BuildPlan.skTool(\'' + tool + '\')">' +
        icon + ' ' + BP.tt(he, th, ar) + '</button>';
    };
    return '<div class="bp-split">' +
      '<div class="bp-stick">' +
        '<div class="bp-card">' +
          '<div id="bpSketch" style="height:min(52vh,480px);border-radius:12px;overflow:hidden;' +
            'background:#f4f6f4;"></div>' +
          '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:6px;">' +
            BP.tt('גרירה = הזזה \u00b7 גלגלת = זום \u00b7 לחיצה כפולה = סיום קו שבור \u00b7 הצמדה לקודקודים ולרשת',
               'ลาก=เลื่อน ล้อ=ซูม ดับเบิลคลิก=จบเส้น',
               'سحب=تحريك \u00b7 عجلة=تكبير \u00b7 نقر مزدوج=إنهاء') + '</div>' +
        '</div>' +
        '<div class="bp-card"><div class="bp-lbl">' +
          BP.tt('נתוני השרטוט', 'ข้อมูลแบบ', 'بيانات الرسم') + '</div>' +
          '<div id="bpSkInfo"></div></div>' +
      '</div>' +
      '<div class="bp-pane">' +
        '<details class="bp-acc" open><summary>' + BP.tt('כלים', 'เครื่องมือ', 'أدوات') + '</summary><div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;">' +
            b('select', '\u2196', 'בחירה', 'เลือก', 'تحديد') +
            b('line',   '\u2571', 'קו', 'เส้น', 'خط') +
            b('poly',   '\u2b20', 'קו שבור', 'เส้นหลายจุด', 'خط متعدد') +
            b('rect',   '\u25ad', 'מלבן', 'สี่เหลี่ยม', 'مستطيل') +
            b('circle', '\u25cb', 'עיגול', 'วงกลม', 'دائرة') +
            b('pan',    '\u270b', 'הזזה', 'เลื่อน', 'تحريك') +
          '</div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;">' +
            '<label style="display:inline-flex;gap:5px;align-items:center;font-size:.78rem;">' +
              '<input type="checkbox" onchange="BuildPlan.skOrtho(this.checked)"> ' +
              BP.tt('ישר בלבד', 'ตั้งฉาก', 'عمودي فقط') + '</label>' +
          '</div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px;">' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skUndo()">\u21b6 ' + BP.tt('בטל', 'เลิกทำ', 'تراجع') + '</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skRedo()">\u21b7 ' + BP.tt('בצע שוב', 'ทำซ้ำ', 'إعادة') + '</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skFit()">\u2922 ' + BP.tt('התאם', 'พอดี', 'ملاءمة') + '</button>' +
            '<button class="bp-btn warn" style="padding:6px 10px;font-size:.75rem;" ' +
              'onclick="BuildPlan.skDel()">\ud83d\uddd1 ' + BP.tt('מחק נבחר', 'ลบ', 'حذف') + '</button>' +
          '</div>' +
        '</div></details>' +
        '<details class="bp-acc" open><summary>' +
          BP.tt('מידות מדויקות', 'ขนาดที่แน่นอน', 'أبعاد دقيقة') + '</summary>' +
          '<div id="bpSkEdit"><div class="bp-empty" style="font-size:.8rem;">' +
            BP.tt('בחר צורה כדי לערוך את המידות שלה', 'เลือกรูปเพื่อแก้ไข', 'اختر شكلاً لتحرير أبعاده') +
          '</div></div></details>' +
        '<details class="bp-acc"><summary>' + BP.tt('שינוי גודל', 'ปรับขนาด', 'تغيير الحجم') + '</summary><div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;">' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(0.5)">\u00d70.5</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(0.9)">\u00d70.9</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(1.1)">\u00d71.1</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skScale(2)">\u00d72</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skRotate(-15)">\u21ba15\u00b0</button>' +
            '<button class="bp-btn ghost" style="padding:6px 10px;font-size:.75rem;" onclick="BuildPlan.skRotate(15)">\u21bb15\u00b0</button>' +
          '</div></div></details>' +
      '</div></div>';
  }

  function mountSketch(p) {
    var host = document.getElementById('bpSketch');
    if (!host || typeof Sketch === 'undefined') return;
    Sketch.mount(host, p.sketch, {
      onChange: function (model, sum) {
        p.sketch = model;
        skInfo(sum);
        skEdit();
        if (_skSave) clearTimeout(_skSave);
        _skSave = setTimeout(function () { BP.saveP(); }, 800);
      }
    });
    BP.skTool('select');
  }
  var _skSave = null;

  function skInfo(sum) {
    var el = document.getElementById('bpSkInfo');
    if (!el || !sum) return;
    el.innerHTML =
      '<div class="bp-read"><span>' + BP.tt('צורות', 'รูปทรง', 'أشكال') + '</span><b>' + sum.shapes + '</b></div>' +
      '<div class="bp-read"><span>' + BP.tt('שטח כולל', 'พื้นที่รวม', 'المساحة') + '</span><b>' +
        BP.n1(sum.area) + ' \u05de"\u05e8</b></div>' +
      '<div class="bp-read"><span>' + BP.tt('אורך קווים', 'ความยาวรวม', 'الطول') + '</span><b>' +
        BP.n1(sum.perim) + ' m</b></div>';
  }

  // The numeric side of the sketcher: every segment of the selected shape
  // gets a length and a bearing you can type into.
  function skEdit() {
    var el = document.getElementById('bpSkEdit');
    if (!el || typeof Sketch === 'undefined') return;
    var sel = Sketch.selection();
    if (!sel) {
      el.innerHTML = '<div class="bp-empty" style="font-size:.8rem;">' +
        BP.tt('בחר צורה כדי לערוך את המידות שלה', 'เลือกรูปเพื่อแก้ไข', 'اختر شكلاً لتحرير أبعاده') + '</div>';
      return;
    }
    var h = '<div style="padding:0 2px;">';
    if (sel.kind === 'circle') {
      h += '<div class="bp-lbl">' + BP.tt('רדיוס (מ\')', 'รัศมี', 'نصف القطر') + '</div>' +
        '<input class="bp-in" type="number" step="0.05" value="' + BP.n2(sel.r) + '" ' +
          'onchange="BuildPlan.skRadius(this.value)">';
    } else {
      sel.segs.forEach(function (sg) {
        h += '<div style="display:flex;gap:5px;align-items:center;margin-bottom:5px;">' +
          '<span style="font-size:.72rem;color:var(--text-muted,#888);width:26px;">' + (sg.i+1) + '</span>' +
          '<input class="bp-in" type="number" step="0.05" value="' + BP.n2(sg.len) + '" ' +
            'style="flex:1;" onchange="BuildPlan.skSeg(' + sg.i + ',this.value,null)">' +
          '<span style="font-size:.72rem;color:var(--text-muted,#888);">m</span>' +
          '<input class="bp-in" type="number" step="1" value="' + Math.round(sg.ang) + '" ' +
            'style="width:70px;" onchange="BuildPlan.skSeg(' + sg.i + ',null,this.value)">' +
          '<span style="font-size:.72rem;color:var(--text-muted,#888);">\u00b0</span>' +
        '</div>';
      });
    }
    h += '<div class="bp-read" style="margin-top:6px;"><span>' + BP.tt('שטח', 'พื้นที่', 'مساحة') +
      '</span><b>' + BP.n1(sel.area) + ' \u05de"\u05e8</b></div>' +
      '<div class="bp-read"><span>' + BP.tt('היקף', 'เส้นรอบรูป', 'محيط') + '</span><b>' +
      BP.n1(sel.perim) + ' m</b></div></div>';
    el.innerHTML = h;
  }

  BP.skTool = function skTool(t) {
    if (typeof Sketch === 'undefined') return;
    Sketch.setTool(t);
    ['select','line','poly','rect','circle','pan'].forEach(function (k) {
      var b2 = document.getElementById('skT_' + k);
      if (b2) b2.className = 'bp-btn ' + (k === t ? '' : 'ghost');
    });
  };
  BP.skOrtho = function skOrtho(v) { if (typeof Sketch !== 'undefined') Sketch.setOrtho(v); };
  BP.skUndo = function skUndo()  { if (typeof Sketch !== 'undefined') { Sketch.undo(); skEdit(); } };
  BP.skRedo = function skRedo()  { if (typeof Sketch !== 'undefined') { Sketch.redo(); skEdit(); } };
  BP.skFit = function skFit()   { if (typeof Sketch !== 'undefined') Sketch.fit(); };
  BP.skDel = function skDel()   { if (typeof Sketch !== 'undefined') { Sketch.del(); skEdit(); } };
  BP.skScale = function skScale(f){ if (typeof Sketch !== 'undefined') { Sketch.scaleSel(f); skEdit(); } };
  BP.skRotate = function skRotate(d){ if (typeof Sketch !== 'undefined') { Sketch.rotateSel(d); skEdit(); } };
  BP.skSeg = function skSeg(i, l, a) {
    if (typeof Sketch === 'undefined') return;
    Sketch.setSegment(i, l === null ? null : Number(l), a === null ? null : Number(a));
    skEdit();
  };
  BP.skRadius = function skRadius(r) { if (typeof Sketch !== 'undefined') { Sketch.setCircle(Number(r)); skEdit(); } };

  // ── gates ────────────────────────────────────────────────────────────
  function gatesTab(p) {
    var id = p.id;
    if (typeof Gates === 'undefined') return '<div class="bp-empty">Gates module not loaded</div>';
    if (!(p.gates || []).length) {
      return '<div class="bp-card"><div class="bp-empty">' +
        BP.tt('אין שערים בפרויקט. שער נכנס לאותו כתב כמויות כמו שאר העבודה.',
           'ยังไม่มีประตู', 'لا توجد بوابات') + '</div>' +
        '<button class="bp-btn" onclick="BuildPlan.addGate(' + id + ')">\u2795 ' +
          BP.tt('הוסף שער', 'เพิ่มประตู', 'إضافة بوابة') + '</button></div>';
    }
    var h = '';
    p.gates.forEach(function (g, i) {
      var sum = Gates.summary(g);
      var rows = Gates.takeoff(g);
      var tSel = Gates.TYPES.map(function (t) {
        return '<option value="' + t + '"' + (g.type === t ? ' selected' : '') + '>' +
          BP.esc(Gates.typeLabel(t)) + '</option>';
      }).join('');
      var mode = _gView[i] || '2d';
      // Three ways to look at the same gate. The elevation is what a client
      // signs; the section is what a welder needs, because it is the only
      // one that shows which way a horn actually points; the 3D view is
      // what answers "what will it look like from the road", with the same
      // orbit, pan, zoom and tap-to-identify the shed has.
      var viewBar = '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:6px;">' +
        [['2d', '\ud83d\udcd0', BP.tt('חזית', 'ด้านหน้า', 'واجهة')],
         ['sec', '\u2702', BP.tt('חתך ופרט', 'ภาคตัด', 'مقطع')],
         ['3d', '\ud83e\uddca', BP.tt('תלת-מימד', '3 มิติ', 'ثلاثي الأبعاد')]].map(function (v) {
          return '<button class="bp-btn ' + (mode === v[0] ? 'on' : 'ghost') +
            '" style="padding:5px 9px;font-size:.72rem;" onclick="BuildPlan.gateView(' + id + ',' +
            i + ',\'' + v[0] + '\')">' + v[1] + ' ' + v[2] + '</button>';
        }).join('') + '</div>';

      var drawHost = (mode === '3d')
        ? '<div id="gView' + i + '" style="height:min(46vh,420px);border-radius:12px;' +
            'overflow:hidden;background:radial-gradient(circle at 50% 30%,' +
            'rgba(255,255,255,.06),rgba(0,0,0,.25));"></div>' +
          '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:6px;">' +
            [['(-0.62,0.42)', '\u2934', BP.tt('איזומטרי', 'ไอโซ', 'أيزومتري')],
             ['(0,0.02)', '\u25ad', BP.tt('חזית', 'ด้านหน้า', 'واجهة')],
             ['(1.5708,0.02)', '\u25b1', BP.tt('צד', 'ด้านข้าง', 'جانب')],
             ['(0,1.35)', '\u2b1c', BP.tt('מבט על', 'ด้านบน', 'علوي')]].map(function (v) {
              return '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.72rem;" ' +
                'onclick="BuildPlan.gate3dView(' + i + ',' + v[0].slice(1, -1) + ')">' +
                v[1] + ' ' + v[2] + '</button>';
            }).join('') +
            '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.72rem;" ' +
              'onclick="BuildPlan.gate3dReset(' + i + ')">\u21ba ' +
              BP.tt('איפוס', 'รีเซ็ต', 'إعادة') + '</button>' +
          '</div>' +
          '<div style="font-size:.72rem;color:var(--text-muted,#888);margin-top:5px;">' +
            BP.tt('גרירה = סיבוב \u00b7 Shift+גרירה = הזזה \u00b7 גלגלת = זום \u00b7 לחיצה = בחירה',
               'ลาก=หมุน Shift=เลื่อน ล้อ=ซูม แตะ=เลือก',
               'سحب=تدوير \u00b7 Shift=تحريك \u00b7 عجلة=تكبير \u00b7 نقر=تحديد') + '</div>'
        : (mode === 'sec')
        ? '<div id="gDraw' + i + '">' + Gates.detailSvg(g) + '</div>'
        : '<div id="gDraw' + i + '">' + Gates.svg(g) + '</div>';

      h += '<div class="bp-split" style="margin-bottom:14px;">' +
        '<div class="bp-stick"><div class="bp-card">' +
          viewBar + drawHost +
          // The answer lands here rather than as a label on the drawing:
          // a gate is 640x340 of mostly thin lines and a floating tag over
          // it covers the very member it is describing.
          '<div style="display:flex;align-items:center;gap:6px;min-height:20px;margin-top:6px;' +
            'font-size:.76rem;font-weight:700;">' +
            '<span style="opacity:.55;font-weight:600;">\ud83d\udc46</span>' +
            '<span id="gSel' + i + '" style="flex:1;"></span></div>' +
          '<div id="gLeg' + i + '" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;"></div>' +
        '</div>' +
          '<div class="bp-card">' +
            rows.slice(0, 6).map(function (r) {
              return '<div class="bp-read"><span>' + BP.esc(BP.dsp(r.name)) + '</span><b>' +
                BP.n1(r.qty) + ' ' + BP.esc(BP.dsp(r.unit)) + '</b></div>';
            }).join('') +
            (rows.length > 6 ? '<div style="font-size:.74rem;color:var(--text-muted,#888);">+' +
              (rows.length - 6) + ' ' + BP.tt('שורות נוספות', 'รายการเพิ่ม', 'بنود إضافية') + '</div>' : '') +
          '</div>' +
          gateChecks(g, id, i) +
        '</div>' +
        '<div class="bp-pane">' +
          '<div class="bp-card">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
              '<input class="bp-in" style="flex:1;" value="' + BP.esc(g.name) + '" placeholder="' +
                BP.tt('שם השער', 'ชื่อประตู', 'اسم البوابة') + '" ' +
                'onchange="BuildPlan.setGate(' + id + ',' + i + ',\'name\',this.value)">' +
              '<button class="bp-btn warn" style="padding:5px 10px;" ' +
                'onclick="BuildPlan.delGate(' + id + ',' + i + ')">\ud83d\uddd1</button></div>' +
            '<div class="bp-lbl" style="margin-top:8px;">' + BP.tt('סוג', 'ชนิด', 'النوع') + '</div>' +
            '<select class="bp-in" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'type\',this.value)">' +
              tSel + '</select>' +
            '<div class="bp-grid" style="margin-top:8px;">' +
              gctl(id, i, 'width',  BP.tt('רוחב אור (מ\')', 'ความกว้าง', 'العرض'), g.width, 1, 12, 0.1) +
              gctl(id, i, 'height', BP.tt('גובה (מ\')', 'ความสูง', 'الارتفاع'), g.height, 1, 4, 0.1) +
              gctl(id, i, 'postDepth', BP.tt('עומק יסוד (מ\')', 'ลึกฐาน', 'عمق الأساس'), g.postDepth, 0.4, 2, 0.1) +
              gctl(id, i, 'postSize', BP.tt('צלע יסוד (מ\')', 'ด้านฐาน', 'ضلع الأساس'), g.postSize, 0.2, 1, 0.05) +
              gctl(id, i, 'infillRows', BP.tt('קורות ביניים', 'คานกลาง', 'عوارض وسطية'), g.infillRows, 0, 4, 1) +
            '</div>' +
            '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
              '<label><input type="checkbox"' + (g.bracing ? ' checked' : '') +
                ' onchange="BuildPlan.setGate(' + id + ',' + i + ',\'bracing\',this.checked)"> ' +
                BP.tt('אלכסון ייצוב', 'ค้ำยัน', 'دعامة') + '</label>' +
              '<label><input type="checkbox"' + (g.motor ? ' checked' : '') +
                ' onchange="BuildPlan.setGate(' + id + ',' + i + ',\'motor\',this.checked)"> ' +
                BP.tt('מנוע חשמלי', 'มอเตอร์', 'محرك') + '</label>' +
              '<label><input type="checkbox"' + (g.horns ? ' checked' : '') +
                ' onchange="BuildPlan.setGate(' + id + ',' + i + ',\'horns\',this.checked)"> ' +
                BP.tt('קרניים מעל העמודים', 'แขนเอียงบนเสา', 'أذرع فوق الأعمدة') + '</label>' +
            '</div>' +
            // ── קרניים ──
            // The arm's reach over the approach is shown as a derived
            // number, because that is the one that decides whether it
            // overhangs a road — nobody thinks in "0.5 m at 30 degrees".
            (g.horns
              ? '<div class="bp-grid" style="margin-top:8px;">' +
                  gctl(id, i, 'hornLen', BP.tt('אורך קרן (מ\')', 'ยาวแขน', 'طول الذراع'), g.hornLen, 0.2, 1.5, 0.05) +
                  gctl(id, i, 'hornAngle', BP.tt('זווית מהאנך (\u00b0)', 'มุมจากแนวดิ่ง', 'الزاوية عن العمودي'), g.hornAngle, 10, 75, 5) +
                  '<div><div class="bp-lbl">' + BP.tt('כיוון הטיה', 'ทิศเอียง', 'اتجاه الميل') + '</div>' +
                    '<select class="bp-in" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'hornDir\',this.value)">' +
                      '<option value="out"' + (g.hornDir !== 'in' ? ' selected' : '') + '>' +
                        BP.tt('כלפי הכניסה', 'ออกด้านนอก', 'نحو المدخل') + '</option>' +
                      '<option value="in"' + (g.hornDir === 'in' ? ' selected' : '') + '>' +
                        BP.tt('פנימה', 'เข้าด้านใน', 'للداخل') + '</option></select></div>' +
                '</div>' +
                '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;font-size:.8rem;">' +
                  '<label><input type="checkbox"' + (g.hornMesh ? ' checked' : '') +
                    ' onchange="BuildPlan.setGate(' + id + ',' + i + ',\'hornMesh\',this.checked)"> ' +
                    BP.tt('רשת על הקרניים', 'ตะแกรงบนแขน', 'شبك على الأذرع') + '</label>' +
                '</div>' +
                '<div class="bp-read" style="margin-top:6px;"><span>' +
                  BP.tt('בליטה מעל הכניסה', 'ระยะยื่น', 'الامتداد') + '</span><b>' +
                  BP.n1(sum.hornProj) + ' m \u00b7 ' +
                  BP.tt('גובה כולל', 'สูงรวม', 'الارتفاع الكلي') + ' ' + BP.n1(sum.topZ) + ' m</b></div>'
              : '') +
            '<div class="bp-grid" style="margin-top:8px;">' +
              '<div><div class="bp-lbl">' + BP.tt('פרופיל מסגרת', 'โปรไฟล์กรอบ', 'مقطع الإطار') + '</div>' +
                gprof(id, i, 'frame', g.frame) + '</div>' +
              '<div><div class="bp-lbl">' + BP.tt('פרופיל עמוד', 'โปรไฟล์เสา', 'مقطع العمود') + '</div>' +
                gprof(id, i, 'post', g.post) + '</div>' +
            '</div>' +
            '<div class="bp-read" style="margin-top:8px;"><span>' +
              BP.tt('שטח כנף', 'พื้นที่บาน', 'مساحة المصراع') + '</span><b>' + BP.n1(sum.area) + ' \u05de"\u05e8</b></div>' +
            (sum.swingRadius ? '<div class="bp-read"><span>' +
              BP.tt('רדיוס פתיחה נדרש', 'รัศมีเปิด', 'نصف قطر الفتح') + '</span><b>' +
              BP.n1(sum.swingRadius) + ' m</b></div>' : '') +
            (sum.tail ? '<div class="bp-read"><span>' +
              BP.tt('זנב משקל נגדי', 'หางถ่วง', 'ذيل الموازنة') + '</span><b>' + BP.n1(sum.tail) + ' m</b></div>' : '') +
          '</div>' +
          // Reinforcement in the post foundations, per gate. A gate on rock
          // and a gate in wadi fill do not get the same cage, and the quote
          // line "בטון לביסוס עמודים וברזל זיוון" was typed by hand because
          // there was nowhere to say which one this is.
          ((typeof Rebar !== 'undefined')
            ? '<div class="bp-card">' +
                '<div class="bp-lbl">' +
                  BP.tt('זיון יסודות העמודים', 'เหล็กเสริมฐานเสา', 'تسليح أساسات الأعمدة') + '</div>' +
                rebarFields(g.rebar, BP._gateRebarBind(id, i), { slab: false }) +
              '</div>'
            : '') +
        '</div></div>';
    });
    h += '<button class="bp-btn" onclick="BuildPlan.addGate(' + id + ')">\u2795 ' +
      BP.tt('הוסף שער', 'เพิ่มประตู', 'إضافة بوابة') + '</button>';
    return h;
  }

  function gctl(id, i, key, label, val, min, max, step) {
    return '<div><div class="bp-lbl">' + label + ' <b style="color:var(--accent,#ff9f43);">' +
        val + '</b></div>' +
      '<input class="bp-rng" type="range" min="' + min + '" max="' + max + '" step="' + step +
        '" value="' + val + '" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'' + key + '\',this.value)">' +
      '<input class="bp-in" type="number" step="' + step + '" value="' + val + '" ' +
        'onchange="BuildPlan.setGate(' + id + ',' + i + ',\'' + key + '\',this.value)"></div>';
  }
  function gprof(id, i, key, cur) {
    var o = '';
    (BP.C.profiles || []).filter(function (x) {
      return x.group === 'פרופיל מלבני' || x.group === 'פרופיל מרובע' || x.group === 'עמודים / קורות';
    }).forEach(function (x) {
      o += '<option value="' + BP.esc(x.name) + '"' + (x.name === cur ? ' selected' : '') + '>' +
        BP.esc(x.name) + '</option>';
    });
    if (!o) o = '<option>' + BP.esc(cur) + '</option>';
    return '<select class="bp-in" onchange="BuildPlan.setGate(' + id + ',' + i + ',\'' + key +
      '\',this.value)">' + o + '</select>';
  }

  // One entry point for "this job also includes…". Each branch lands the
  // user on the tab where the thing it just added is edited, because adding
  // a component and then having to find it is how the gates tab went
  // unnoticed in the first place.
  BP.addComp = function addComp(id, what) {
    if (!what) return;
    var p = BP.projById(id);
    if (!p) return;
    if (what === 'struct')      { p.hasStruct = true;  BP._tab = 'design'; }
    else if (what === 'slab')   { p.hasSlab = true;    BP._tab = 'design'; }
    else if (what === 'gate')   { BP._tab = 'gates';   BP.addGate(id); return; }
    else if (what === 'living') { BP._tab = 'living';  BP.addLiving(id); return; }
    else return;
    BP.saveP(); BP.open(id);
  };

  BP.addGate = function addGate(id) {
    var p = BP.projById(id);
    if (!p || typeof Gates === 'undefined') return;
    p.gates.push(Gates.norm({ name: BP.tt('שער', 'ประตู', 'بوابة') + ' ' + (p.gates.length + 1) }));
    _gateReset();
    BP.saveP(); BP.open(id);
  };
  BP.delGate = function delGate(id, i) {
    var p = BP.projById(id);
    if (!p) return;
    p.gates.splice(i, 1);
    // Index 2 is now a different gate; a retained camera or view mode would
    // belong to the one that was deleted.
    _gateReset();
    BP.saveP(); BP.open(id);
  };
  var BOOLG = { bracing: 1, motor: 1, horns: 1, hornMesh: 1 };
  var TEXTG = { name: 1, type: 1, frame: 1, post: 1, mesh: 1, notes: 1, hornDir: 1 };
  BP.setGate = function setGate(id, i, k, v) {
    var p = BP.projById(id);
    if (!p || !p.gates[i]) return;
    p.gates[i][k] = BOOLG[k] ? !!v : TEXTG[k] ? String(v) : (Number(v) || 0);
    p.gates[i] = Gates.norm(p.gates[i]);
    BP.saveP();
    // With the 3D view open, rebuild the geometry in place and leave the
    // sheet alone: a repaint would drop the canvas and the camera with it.
    // Booleans and the type change which controls exist, so those repaint.
    if (_g3d[i] && !BOOLG[k] && k !== 'type' && Gates.model3d) {
      var m3 = Gates.model3d(p.gates[i]);
      if (m3) { _g3d[i].update(m3); return; }
    }
    BP.open(id);
  };

  // ── accommodation ────────────────────────────────────────────────────
  function livingTab(p) {
    var id = p.id;
    if (typeof LivingUnit === 'undefined') return '<div class="bp-empty">LivingUnit not loaded</div>';
    if (!p.living || !p.living.people) {
      return '<div class="bp-card"><div class="bp-empty">' +
        BP.tt('אין מתחם מגורים בפרויקט. הזן מספר אנשים והתוכנית תיגזר מזה.',
           'ยังไม่มีที่พัก', 'لا يوجد سكن') + '</div>' +
        '<button class="bp-btn" onclick="BuildPlan.addLiving(' + id + ')">\u2795 ' +
          BP.tt('הוסף מתחם מגורים', 'เพิ่มที่พัก', 'إضافة سكن') + '</button></div>';
    }
    var u = p.living, pr = LivingUnit.program(u);
    var lc = function (key, label, val, min, max, step) {
      return '<div><div class="bp-lbl">' + label + ' <b style="color:var(--accent,#ff9f43);">' +
          val + '</b></div>' +
        '<input class="bp-rng" type="range" min="' + min + '" max="' + max + '" step="' + step +
          '" value="' + val + '" onchange="BuildPlan.setLiving(' + id + ',\'' + key + '\',this.value)">' +
        '<input class="bp-in" type="number" step="' + step + '" value="' + val + '" ' +
          'onchange="BuildPlan.setLiving(' + id + ',\'' + key + '\',this.value)"></div>';
    };
    return '<div class="bp-split">' +
      '<div class="bp-stick"><div class="bp-card">' + LivingUnit.svg(u) + '</div>' +
        '<div class="bp-card"><div class="bp-lbl">' + BP.tt('תוכנית שטחים', 'โปรแกรมพื้นที่', 'برنامج المساحات') +
          '</div>' +
          '<div class="bp-read"><span>' + BP.tt('חדרי שינה', 'ห้องนอน', 'غرف النوم') + '</span><b>' +
            pr.rooms + ' \u00d7 ' + u.perRoom + '</b></div>' +
          '<div class="bp-read"><span>' + BP.tt('שירותים / מקלחות / כיורים', 'สุขา/ฝักบัว/อ่าง', 'حمامات') +
            '</span><b>' + pr.wc + ' / ' + pr.showers + ' / ' + pr.basins + '</b></div>' +
          '<div class="bp-read"><span>' + BP.tt('משטח מטבח', 'เคาน์เตอร์', 'سطح المطبخ') + '</span><b>' +
            BP.n1(pr.counter) + ' m</b></div>' +
          '<div class="bp-read"><span>' + BP.tt('חלל אוכל', 'ส่วนกลาง', 'صالة') + '</span><b>' +
            BP.n1(pr.dining) + ' \u05de"\u05e8</b></div>' +
          '<div class="bp-read"><span>' + BP.tt('שטח כולל', 'พื้นที่รวม', 'المساحة الكلية') + '</span><b>' +
            BP.n1(pr.total) + ' \u05de"\u05e8</b></div>' +
        '</div></div>' +
      '<div class="bp-pane">' +
        '<details class="bp-acc" open><summary>' + BP.tt('בסיס התכנון', 'พื้นฐานการออกแบบ', 'أساس التصميم') +
          '</summary><div>' +
          '<div class="bp-lbl">' + BP.tt('אופן הביצוע', 'รูปแบบงาน', 'نوع العمل') + '</div>' +
          '<select class="bp-in" onchange="BuildPlan.setLiving(' + id + ',\'mode\',this.value)">' +
            '<option value="fitout"' + (u.mode === 'fitout' ? ' selected' : '') + '>' +
              BP.tt('התאמת מבנה קיים — מחיצות ופנים בלבד', 'ปรับปรุงอาคารเดิม', 'تجهيز مبنى قائم') + '</option>' +
            '<option value="full"' + (u.mode === 'full' ? ' selected' : '') + '>' +
              BP.tt('הקמה מלאה כולל מעטפת', 'สร้างใหม่ทั้งหมด', 'إنشاء كامل') + '</option></select>' +
          '<div class="bp-grid" style="margin-top:8px;">' +
            lc('people', BP.tt('מספר אנשים', 'จำนวนคน', 'عدد الأشخاص'), u.people, 2, 60, 1) +
            lc('perRoom', BP.tt('אנשים לחדר', 'คนต่อห้อง', 'أشخاص لكل غرفة'), u.perRoom, 1, 8, 1) +
            lc('height', BP.tt('גובה פנים (מ\')', 'ความสูง', 'الارتفاع'), u.height, 2.2, 4, 0.05) +
          '</div>' +
          '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:8px;font-size:.8rem;">' +
            '<label><input type="checkbox"' + (u.blockWet ? ' checked' : '') +
              ' onchange="BuildPlan.setLiving(' + id + ',\'blockWet\',this.checked)"> ' +
              BP.tt('קירות בלוק בחדרים רטובים', 'ผนังบล็อกห้องน้ำ', 'جدران بلوك للحمامات') + '</label>' +
            '<label><input type="checkbox"' + (u.ac ? ' checked' : '') +
              ' onchange="BuildPlan.setLiving(' + id + ',\'ac\',this.checked)"> ' +
              BP.tt('מיזוג', 'แอร์', 'تكييف') + '</label>' +
          '</div>' +
          '<div class="bp-grid" style="margin-top:8px;">' +
            '<div><div class="bp-lbl">' + BP.tt('חומר מחיצות', 'วัสดุผนัง', 'مادة القواطع') + '</div>' +
              '<select class="bp-in" onchange="BuildPlan.setLiving(' + id + ',\'partition\',this.value)">' +
              cladOptions(u.partition) + '</select></div>' +
            (u.mode === 'full'
              ? '<div><div class="bp-lbl">' + BP.tt('מעטפת', 'เปลือก', 'الغلاف') + '</div>' +
                '<select class="bp-in" onchange="BuildPlan.setLiving(' + id + ',\'envelope\',this.value)">' +
                cladOptions(u.envelope) + '</select></div>'
              : '') +
          '</div>' +
          '<button class="bp-btn warn" style="margin-top:10px;" onclick="BuildPlan.delLiving(' + id + ')">' +
            '\ud83d\uddd1 ' + BP.tt('הסר מגורים', 'ลบที่พัก', 'إزالة السكن') + '</button>' +
        '</div></details>' +
        '<details class="bp-acc"><summary>' + BP.tt('תקני תכנון', 'เกณฑ์', 'معايير') + '</summary><div>' +
          '<div style="font-size:.74rem;color:var(--text-muted,#888);margin-bottom:8px;">' +
            BP.tt('אלה מוסכמות מקצועיות ולא תקן מחייב. דרישות משרד העבודה לאתר מסוים עשויות להיות מחמירות יותר.',
               'เป็นแนวปฏิบัติ ไม่ใช่มาตรฐานบังคับ',
               'هذه أعراف مهنية وليست معياراً ملزماً') + '</div>' +
          '<div class="bp-grid">' +
            lc('perPerson', BP.tt('מ"ר שינה לאדם', 'ตร.ม./คน', 'م² لكل شخص'), u.perPerson, 2, 8, 0.5) +
            lc('wcPer', BP.tt('אנשים לאסלה', 'คน/สุขา', 'أشخاص/مرحاض'), u.wcPer, 4, 15, 1) +
            lc('showerPer', BP.tt('אנשים למקלחת', 'คน/ฝักบัว', 'أشخاص/دُش'), u.showerPer, 4, 15, 1) +
            lc('basinPer', BP.tt('אנשים לכיור', 'คน/อ่าง', 'أشخاص/حوض'), u.basinPer, 3, 12, 1) +
            lc('counterPer', BP.tt('מ\' משטח לאדם', 'ม.เคาน์เตอร์/คน', 'م سطح/شخص'), u.counterPer, 0.2, 1, 0.05) +
            lc('diningPer', BP.tt('מ"ר אוכל לאדם', 'ตร.ม.ส่วนกลาง/คน', 'م² صالة/شخص'), u.diningPer, 0.6, 3, 0.1) +
          '</div></div></details>' +
      '</div></div>';
  }

  BP.addLiving = function addLiving(id) {
    var p = BP.projById(id);
    if (!p || typeof LivingUnit === 'undefined') return;
    p.living = LivingUnit.norm({ people: 20 });
    BP.saveP(); BP.open(id);
  };
  BP.delLiving = function delLiving(id) {
    var p = BP.projById(id);
    if (!p) return;
    p.living = null;
    BP.saveP(); BP.open(id);
  };
  var BOOLL = { blockWet: 1, ac: 1 };
  var TEXTL = { mode: 1, partition: 1, envelope: 1, notes: 1 };
  BP.setLiving = function setLiving(id, k, v) {
    var p = BP.projById(id);
    if (!p || !p.living) return;
    p.living[k] = BOOLL[k] ? !!v : TEXTL[k] ? String(v) : (Number(v) || 0);
    BP.saveP(); BP.open(id);
  };

  function matTab(p, rows, tot) {
    var h = '<div class="bp-card">';
    rows.forEach(function (r) {
      var pr = BP.profByName(r.name);
      h += '<div class="bp-tot"><span>' + BP.esc(BP.dsp(r.name)) +
        (r.note ? '<br><span style="font-size:.7rem;color:var(--text-muted,#888);">' +
          BP.esc(BP.dsp(r.note)) + '</span>' : '') + '</span>' +
        '<span style="white-space:nowrap;text-align:end;">' + BP.n1(r.qty) + ' ' + BP.esc(r.unit) +
        (r.kg ? '<br><span style="font-size:.7rem;color:var(--text-muted,#888);">' +
          BP.n1(r.kg) + ' kg</span>' : '') +
        (pr && pr.price ? '<br><span style="font-size:.72rem;">' + BP.money(r.qty * pr.price) +
          '</span>' : '') + '</span></div>';
    });
    h += '<div class="bp-tot" style="border:none;font-weight:800;margin-top:6px;"><span>' +
      BP.tt('משקל פלדה', 'น้ำหนักเหล็ก', 'وزن الحديد') + '</span><span>' +
      BP.n1(tot.kg) + ' kg \u00b7 ' + BP.n2(tot.kg / 1000) + ' ' + BP.tt('טון', 'ตัน', 'طن') + '</span></div>' +
      '<div class="bp-tot" style="border:none;font-weight:800;font-size:1rem;"><span>' +
      BP.tt('עלות חומרים', 'ต้นทุนวัสดุ', 'تكلفة المواد') + '</span><span>' + BP.money(tot.cost) + '</span></div>' +
      (tot.unpriced ? '<div style="font-size:.75rem;color:#e65100;">\u26a0\ufe0f ' + tot.unpriced +
        ' ' + BP.tt('פריטים ללא מחיר בקטלוג', 'ไม่มีราคา', 'بدون سعر') + '</div>' : '') +
      '</div>';
    return h;
  }

  function siteTab(p) {
    var has = p.footprint && p.footprint.length >= 3;
    return '<div class="bp-card">' +
      (has ? '<div class="bp-tot"><span>' + BP.tt('שטח מסומן', 'พื้นที่ที่วาด', 'المساحة المرسومة') +
        '</span><strong>' + BP.n1(p.footprintArea) + ' \u05de"\u05e8 (' +
        BP.n2(p.footprintArea / 1000) + ' ' + BP.tt('דונם', 'ดูนัม', 'دونم') + ')</strong></div>' +
        '<div class="bp-tot" style="border:none;"><span>' + BP.tt('נקודות', 'จุด', 'نقاط') +
        '</span><strong>' + p.footprint.length + '</strong></div>'
        : '<div class="bp-empty">' + BP.tt('הפרויקט עדיין לא ממוקם על המפה.',
            'ยังไม่ได้กำหนดตำแหน่ง', 'لم يُحدَّد الموقع بعد') + '</div>') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">' +
        '<button class="bp-btn" onclick="BuildPlan.placeFromDims(' + p.id + ')">\u2b1a ' +
          BP.tt('מקם לפי המידות', 'วางตามขนาด', 'ضع حسب الأبعاد') +
          ' (' + BP.n1(p.dims.span) + '\u00d7' + BP.n1(p.dims.length) + ')</button>' +
        '<button class="bp-btn ghost" onclick="BuildPlan.startRect(' + p.id + ')">\u25ad ' +
          (has ? BP.tt('ערוך / הזז / סובב', 'แก้ไข / ย้าย / หมุน', 'تحرير / نقل / تدوير')
               : BP.tt('צייר מלבן', 'วาดสี่เหลี่ยม', 'ارسم مستطيلاً')) + '</button>' +
        (p.rect && p.rect.w > 0
          ? '<button class="bp-btn ghost" onclick="BuildPlan.dimsFromRect(' + p.id + ')">\u2b07 ' +
            BP.tt('קח מידות מהמלבן', 'ใช้ขนาดจากรูป', 'خذ الأبعاد من المستطيل') + '</button>'
          : '') +
        '<button class="bp-btn ghost" onclick="BuildPlan.startFootprint(' + p.id + ')">\u2b20 ' +
          (has ? BP.tt('סמן מחדש נקודה-נקודה', 'วาดทีละจุด', 'ارسم نقطة بنقطة')
               : BP.tt('סמן נקודה-נקודה', 'วาดทีละจุด', 'ارسم نقطة بنقطة')) + '</button>' +
        (has ? '<button class="bp-btn ghost" onclick="BuildPlan.zoomTo(' + p.id + ')">\ud83d\udd0d ' +
          BP.tt('הצג במפה', 'ดูบนแผนที่', 'عرض على الخريطة') + '</button>' +
          '<button class="bp-btn ghost" onclick="BuildPlan.useFootprint(' + p.id + ')">\u2b07 ' +
          BP.tt('קח מידות מהשטח', 'ใช้ขนาดจากพื้นที่', 'استخدم أبعاد المساحة') + '</button>' : '') +
      '</div>' +
      (has ? '<div style="font-size:.75rem;color:var(--text-muted,#888);margin-top:8px;">' +
        BP.tt('שטח שסומן על המפה גובר על המידות שהוקלדו בחישוב הבטון.',
           'พื้นที่จากแผนที่มีผลเหนือค่าที่พิมพ์', 'المساحة المرسومة تتقدم على المدخلة') + '</div>' : '') +
    '</div>' +
    '<div class="bp-card"><div class="bp-lbl" style="margin-bottom:6px;">\ud83d\udd27 ' +
      BP.tt('קישור לתחזוקה', 'เชื่อมกับซ่อมบำรุง', 'الربط بالصيانة') + '</div>' +
      '<div id="bpLink"></div></div>';
  }


})(BuildPlanInternals);
