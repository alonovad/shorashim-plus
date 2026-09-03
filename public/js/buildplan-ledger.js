/* buildplan-ledger.js — יומן מעקב לפרויקט (per-project tracking journal)
 * ---------------------------------------------------------------------
 * A quote says what a job was SUPPOSED to cost. This says what actually
 * happened: what was received from the client, what has been paid out,
 * what work was done on which day, and what equipment is standing on site
 * right now.
 *
 * WHY IT IS A SEPARATE FIRESTORE DOCUMENT PER PROJECT
 *   Every project in this app lives inside ONE document
 *   ('shorashim-build-projects', a single {projects:[...]} blob). That is
 *   fine for a dozen parametric models, and wrong for a journal: entries
 *   accumulate for the life of a job, and a busy season would push the
 *   shared document toward Firestore's 1 MB ceiling — taking every other
 *   project down with it, because they are all the same document. So each
 *   project's journal is its own document, keyed by project id, loaded
 *   only when the tab is opened. One job's history can grow without
 *   bound and cannot corrupt another's.
 *
 * THE ONE MODELLING DECISION WORTH EXPLAINING
 *   Equipment on site is NOT a list of what is there. It is derived from
 *   movements — a mixer arrives, a mixer leaves — and "what is on site" is
 *   the running balance. A list has to be corrected by hand and quietly
 *   goes stale the first time somebody forgets; movements are what people
 *   actually witness and report, they answer "when did it get here" and
 *   "who took it", and the balance is then arithmetic. This is the same
 *   reason the takeoff derives quantities instead of storing them.
 *
 * MONEY  All figures are pre-VAT (לפני מע"מ), because that is what a
 * contract is agreed in and what a supplier invoice is compared against.
 * VAT is shown as a derived line, never stored.
 */
(function (BP) {
  'use strict';

  var KEY_PREFIX = 'shorashim-build-ledger-';
  function key(pid) { return KEY_PREFIX + pid; }

  // NB: the loaded journal is `led`, never `L` — `L` is Leaflet's global,
  // and shadowing it in any module in this app makes `typeof L` ambiguous
  // for every other function in the file. This has bitten the project once
  // already and preflight now checks for it.
  // Loaded journals, by project id. A journal is only fetched when its tab
  // is opened, so a project list of fifty does not pull fifty documents.
  var _led = {};
  var _loading = {};

  // ── model ───────────────────────────────────────────────────────────
  var KINDS = {
    in:    { icon: '\ud83d\udcb0', money: 1, sign: +1,
             label: function () { return BP.tt('התקבל מהלקוח', 'รับจากลูกค้า', 'مقبوض من العميل'); } },
    out:   { icon: '\ud83e\uddfe', money: 1, sign: -1,
             label: function () { return BP.tt('שולם', 'จ่ายแล้ว', 'مدفوع'); } },
    work:  { icon: '\ud83d\udd28', money: 0, sign: 0,
             label: function () { return BP.tt('בוצע בשטח', 'งานที่ทำ', 'أعمال منفذة'); } },
    equip: { icon: '\ud83d\ude9c', money: 0, sign: 0,
             label: function () { return BP.tt('ציוד', 'อุปกรณ์', 'معدات'); } }
  };

  var CATS = {
    materials: function () { return BP.tt('חומרים', 'วัสดุ', 'مواد'); },
    labor:     function () { return BP.tt('עבודה וקבלני משנה', 'ค่าแรง', 'عمالة'); },
    equipment: function () { return BP.tt('ציוד והשכרה', 'อุปกรณ์', 'معدات'); },
    transport: function () { return BP.tt('הובלה', 'ขนส่ง', 'نقل'); },
    other:     function () { return BP.tt('אחר', 'อื่นๆ', 'أخرى'); }
  };

  var METHODS = {
    transfer: function () { return BP.tt('העברה', 'โอน', 'تحويل'); },
    check:    function () { return BP.tt('צ\'ק', 'เช็ค', 'شيك'); },
    cash:     function () { return BP.tt('מזומן', 'เงินสด', 'نقداً'); },
    other:    function () { return BP.tt('אחר', 'อื่นๆ', 'أخرى'); }
  };

  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') +
           '-' + String(d.getDate()).padStart(2, '0');
  }

  function normEntry(e) {
    e = e || {};
    var kind = KINDS[e.kind] ? e.kind : 'work';
    return {
      id:    e.id || BP.uid(),
      date:  /^\d{4}-\d{2}-\d{2}$/.test(String(e.date)) ? String(e.date) : today(),
      kind:  kind,
      // Money is stored unsigned; the sign belongs to the kind, so an
      // entry can never contradict its own category.
      amount: Math.max(0, Number(e.amount) || 0),
      title: String(e.title || ''),
      note:  String(e.note || ''),
      cat:   CATS[e.cat] ? e.cat : 'other',
      payee: String(e.payee || ''),
      method: METHODS[e.method] ? e.method : 'transfer',
      equip: String(e.equip || ''),
      qty:   Math.max(0, Number(e.qty) || 0),
      // Equipment direction: onto site or off it.
      dir:   (e.dir === 'off') ? 'off' : 'on'
    };
  }

  function normLedger(d) {
    d = (d && typeof d === 'object') ? d : {};
    return {
      contract: Math.max(0, Number(d.contract) || 0),   // agreed price, pre-VAT
      vat: (d.vat === 0) ? 0 : (Number(d.vat) || 18),
      entries: Array.isArray(d.entries) ? d.entries.map(normEntry) : [],
      updatedAt: Number(d.updatedAt) || 0
    };
  }

  // ── derived figures ─────────────────────────────────────────────────
  // Everything the summary shows is computed here and nowhere else, so a
  // number on screen and the same number on the printed sheet cannot drift.
  function totals(led) {
    var received = 0, paid = 0, byCat = {};
    led.entries.forEach(function (e) {
      if (e.kind === 'in') received += e.amount;
      else if (e.kind === 'out') {
        paid += e.amount;
        byCat[e.cat] = (byCat[e.cat] || 0) + e.amount;
      }
    });
    return {
      received: received,
      paid: paid,
      contract: led.contract,
      // What the client still owes. Negative means they have overpaid,
      // which happens with advances and must not be hidden.
      due: led.contract - received,
      // Cash actually in hand on this job — the number that decides
      // whether the next supplier can be paid.
      cash: received - paid,
      // Profit if nothing more is spent. Not a forecast; a ceiling.
      margin: led.contract - paid,
      marginPct: led.contract > 0 ? (led.contract - paid) / led.contract * 100 : 0,
      pctPaid: led.contract > 0 ? Math.min(100, received / led.contract * 100) : 0,
      byCat: byCat,
      vatOnContract: led.contract * (led.vat / 100)
    };
  }

  // Net equipment per name. Only positive balances are "on site"; a
  // negative balance means somebody logged a return that was never
  // logged as a delivery, which is worth surfacing rather than clamping.
  function onSite(led) {
    var net = {}, last = {};
    led.entries.forEach(function (e) {
      if (e.kind !== 'equip' || !e.equip) return;
      var q = e.qty || 1;
      net[e.equip] = (net[e.equip] || 0) + (e.dir === 'on' ? q : -q);
      if (!last[e.equip] || e.date >= last[e.equip]) last[e.equip] = e.date;
    });
    return Object.keys(net).filter(function (k) { return net[k] !== 0; })
      .map(function (k) { return { name: k, qty: net[k], since: last[k] }; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  // ── persistence ─────────────────────────────────────────────────────
  BP.ledgerOf = function ledgerOf(pid) { return _led[pid] || null; };

  BP.ledgerLoad = function ledgerLoad(pid, then) {
    if (_led[pid]) { if (then) then(_led[pid]); return; }
    if (_loading[pid]) return;
    _loading[pid] = 1;
    DB.loadAsync(key(pid)).then(function (d) {
      _loading[pid] = 0;
      _led[pid] = normLedger(d);
      if (then) then(_led[pid]);
    }).catch(function () {
      // A journal that has never been written reads as absent, not as an
      // error worth blocking the tab for.
      _loading[pid] = 0;
      _led[pid] = normLedger(null);
      if (then) then(_led[pid]);
    });
  };

  function save(pid) {
    var led = _led[pid];
    if (!led) return;
    led.updatedAt = Date.now();
    // Firestore rejects undefined and refuses nested arrays; serialising
    // through JSON is what guarantees neither reaches the wire.
    DB.save(key(pid), JSON.parse(JSON.stringify(led)));
  }

  // ── mutations ───────────────────────────────────────────────────────
  // The draft entry being typed. Held outside the ledger so an abandoned
  // half-filled form is never saved, and so switching tabs discards it.
  var _draft = { kind: 'in' };

  BP.ledKind = function ledKind(pid, k) {
    _draft = { kind: KINDS[k] ? k : 'in', date: _draft.date };
    BP.open(pid);
  };
  BP.ledField = function ledField(k, v) { _draft[k] = v; };

  BP.ledAdd = function ledAdd(pid) {
    var led = _led[pid];
    if (!led) return;
    var e = normEntry(_draft);
    var m = KINDS[e.kind];
    // A money entry with no money in it, or an equipment move with no
    // equipment named, is a mistake rather than a record. Refuse it here
    // instead of storing a row that means nothing.
    if (m.money && !(e.amount > 0)) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('חסר סכום', 'ไม่มีจำนวนเงิน', 'المبلغ مفقود'));
      return;
    }
    if (e.kind === 'equip' && !e.equip) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('חסר שם ציוד', 'ไม่มีชื่ออุปกรณ์', 'اسم المعدة مفقود'));
      return;
    }
    if (e.kind === 'work' && !e.title) {
      BP.toast('\u26a0\ufe0f ' + BP.tt('חסר תיאור', 'ไม่มีคำอธิบาย', 'الوصف مفقود'));
      return;
    }
    led.entries.push(e);
    save(pid);
    _draft = { kind: e.kind, date: e.date };   // same kind and day: batch entry
    BP.toast('\u2705 ' + BP.tt('נרשם', 'บันทึกแล้ว', 'تم التسجيل'));
    BP.open(pid);
  };

  BP.ledDel = function ledDel(pid, eid) {
    var led = _led[pid];
    if (!led) return;
    led.entries = led.entries.filter(function (e) { return String(e.id) !== String(eid); });
    save(pid);
    BP.open(pid);
  };

  // Returning a piece of equipment is the commonest journal action there
  // is, so it gets one tap from the on-site list rather than a filled form.
  BP.ledReturn = function ledReturn(pid, name) {
    var led = _led[pid];
    if (!led) return;
    var cur = onSite(led).filter(function (x) { return x.name === name; })[0];
    if (!cur || cur.qty <= 0) return;
    led.entries.push(normEntry({ kind: 'equip', equip: name, qty: cur.qty, dir: 'off',
      title: BP.tt('הוחזר מהשטח', 'คืนจากไซต์', 'أُعيد من الموقع') }));
    save(pid);
    BP.open(pid);
  };

  BP.ledSet = function ledSet(pid, k, v) {
    var led = _led[pid];
    if (!led) return;
    led[k] = Math.max(0, Number(v) || 0);
    save(pid);
    BP.open(pid);
  };

  // Adopt the priced takeoff as the contract value. The bill of quantities
  // is material cost, not a selling price, so this is offered as a starting
  // point that must be edited — never written silently.
  BP.ledFromTakeoff = function ledFromTakeoff(pid) {
    var p = BP.projById(pid), led = _led[pid];
    if (!p || !led) return;
    var tot = BP.takeoffTotals(BP.takeoff(p));
    led.contract = Math.round(tot.cost);
    save(pid);
    BP.toast('\u2139\ufe0f ' + BP.tt('הועתק מכתב הכמויות — עדכן למחיר החוזה',
      'คัดลอกจากรายการวัสดุ', 'نُسخ من الكميات'));
    BP.open(pid);
  };

  // ── UI ──────────────────────────────────────────────────────────────
  function money(v) { return BP.money(v); }
  function fmtDate(s) {
    var b = String(s).split('-');
    return b.length === 3 ? (+b[2]) + '.' + (+b[1]) + '.' + b[0] : s;
  }
  function read(label, val, colour, hint) {
    return '<div class="bp-read"><span>' + label +
      (hint ? ' <span style="opacity:.6;font-size:.86em;">' + hint + '</span>' : '') +
      '</span><b' + (colour ? ' style="color:' + colour + ';"' : '') + '>' + val + '</b></div>';
  }

  BP.ledgerTab = function ledgerTab(p) {
    var id = p.id;
    var led = _led[id];
    if (!led) {
      BP.ledgerLoad(id, function () { BP.open(id); });
      return '<div class="bp-card" style="text-align:center;padding:26px;color:var(--text-muted,#888);">' +
        '\u23f3 ' + BP.tt('טוען יומן…', 'กำลังโหลด…', 'جارٍ التحميل…') + '</div>';
    }

    var t = totals(led);
    var eq = onSite(led);
    var pos = 'var(--ok,#41c47f)', neg = 'var(--warn,#e2624b)', acc = 'var(--accent,#ff9f43)';

    // ── summary ──
    var bar = '<div style="height:8px;border-radius:6px;overflow:hidden;background:rgba(255,255,255,.12);' +
        'margin:8px 0 4px;"><div style="height:100%;width:' + t.pctPaid.toFixed(1) + '%;' +
        'background:' + pos + ';"></div></div>' +
      '<div style="font-size:.74rem;color:var(--text-muted,#888);">' +
        BP.tt('שולם מהחוזה', 'ชำระแล้ว', 'مدفوع من العقد') + ': ' + t.pctPaid.toFixed(0) + '%</div>';

    var summary = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">' +
        BP.tt('מאזן הפרויקט', 'สมดุลโครงการ', 'ميزان المشروع') + '</div>' +
      '<div class="bp-grid" style="margin-bottom:8px;">' +
        '<div><div class="bp-lbl">' + BP.tt('מחיר חוזה (לפני מע"מ)', 'ราคาสัญญา', 'قيمة العقد') + '</div>' +
          '<input class="bp-in" type="number" step="any" value="' + led.contract + '" ' +
            'onchange="BuildPlan.ledSet(' + id + ',\'contract\',this.value)"></div>' +
        '<div><div class="bp-lbl">&nbsp;</div>' +
          '<button class="bp-btn ghost" style="padding:7px 10px;font-size:.74rem;width:100%;" ' +
            'onclick="BuildPlan.ledFromTakeoff(' + id + ')">\u2b07 ' +
            BP.tt('מכתב הכמויות', 'จากรายการวัสดุ', 'من الكميات') + '</button></div>' +
      '</div>' +
      read(BP.tt('התקבל מהלקוח', 'รับแล้ว', 'المقبوض'), money(t.received), pos) +
      read(BP.tt('יתרה לגבייה', 'ค้างรับ', 'المتبقي للتحصيل'), money(t.due),
           t.due > 0 ? acc : pos,
           t.due < 0 ? BP.tt('שולם ביתר', 'จ่ายเกิน', 'دفع زائد') : '') +
      read(BP.tt('שולם לספקים ולעובדים', 'จ่ายออก', 'المدفوع'), money(t.paid), neg) +
      '<div style="height:1px;background:var(--panel-border,rgba(255,255,255,.12));margin:8px 0;"></div>' +
      read(BP.tt('מזומן בקופת הפרויקט', 'เงินสดคงเหลือ', 'النقد المتاح'), money(t.cash),
           t.cash < 0 ? neg : pos) +
      read(BP.tt('רווח אם לא יהיו הוצאות נוספות', 'กำไรสูงสุด', 'الربح الأقصى'),
           money(t.margin) + (led.contract > 0 ? ' \u00b7 ' + t.marginPct.toFixed(0) + '%' : ''),
           t.margin < 0 ? neg : pos) +
      (led.contract > 0 ? read(BP.tt('מע"מ על החוזה', 'VAT', 'ض.ق.م') + ' ' + led.vat + '%',
        money(t.vatOnContract), '') : '') +
      bar +
      (Object.keys(t.byCat).length
        ? '<div style="margin-top:10px;"><div class="bp-lbl" style="margin-bottom:4px;">' +
            BP.tt('הוצאות לפי סוג', 'ค่าใช้จ่ายตามประเภท', 'المصروفات حسب النوع') + '</div>' +
            Object.keys(t.byCat).sort(function (a, b) { return t.byCat[b] - t.byCat[a]; })
              .map(function (c) { return read(CATS[c](), money(t.byCat[c]), ''); }).join('') +
          '</div>'
        : '') +
    '</div>';

    // ── equipment on site ──
    var equip = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\ud83d\ude9c ' +
        BP.tt('ציוד שנמצא עכשיו בשטח', 'อุปกรณ์ในไซต์', 'المعدات في الموقع') + '</div>' +
      (eq.length
        ? eq.map(function (x) {
            var odd = x.qty < 0;
            return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;' +
              'border-bottom:1px solid var(--panel-border,rgba(255,255,255,.1));">' +
              '<b style="flex:1;' + (odd ? 'color:' + neg + ';' : '') + '">' + BP.esc(x.name) + '</b>' +
              '<span style="font-size:.8rem;color:var(--text-muted,#888);">' +
                BP.tt('מאז', 'ตั้งแต่', 'منذ') + ' ' + fmtDate(x.since) + '</span>' +
              '<b style="color:' + (odd ? neg : acc) + ';">\u00d7' + x.qty + '</b>' +
              (odd
                ? '<span style="font-size:.72rem;color:' + neg + ';">' +
                    BP.tt('הוחזר בלי שנרשמה הבאה', 'คืนโดยไม่มีการส่ง', 'إرجاع بدون تسليم') + '</span>'
                : '<button class="bp-btn ghost" style="padding:4px 8px;font-size:.72rem;" ' +
                    'onclick="BuildPlan.ledReturn(' + id + ',\'' + BP.esc(x.name).replace(/'/g, "\\'") + '\')">\u21a9 ' +
                    BP.tt('הוחזר', 'คืนแล้ว', 'أُعيد') + '</button>') +
            '</div>';
          }).join('')
        : '<div style="font-size:.8rem;color:var(--text-muted,#888);">' +
            BP.tt('אין ציוד רשום בשטח', 'ไม่มีอุปกรณ์', 'لا توجد معدات') + '</div>') +
    '</div>';

    // ── add entry ──
    var k = _draft.kind || 'in';
    var kindBtns = Object.keys(KINDS).map(function (kk) {
      return '<button class="bp-btn ' + (k === kk ? 'on' : 'ghost') +
        '" style="padding:6px 10px;font-size:.76rem;" onclick="BuildPlan.ledKind(' + id + ',\'' + kk + '\')">' +
        KINDS[kk].icon + ' ' + KINDS[kk].label() + '</button>';
    }).join('');

    function sel(field, map, cur) {
      return '<select class="bp-in" onchange="BuildPlan.ledField(\'' + field + '\',this.value)">' +
        Object.keys(map).map(function (o) {
          return '<option value="' + o + '"' + (cur === o ? ' selected' : '') + '>' + map[o]() + '</option>';
        }).join('') + '</select>';
    }
    function fld(label, field, type, ph) {
      return '<div><div class="bp-lbl">' + label + '</div>' +
        '<input class="bp-in" type="' + type + '"' + (type === 'number' ? ' step="any"' : '') +
        ' value="' + BP.esc(_draft[field] == null ? '' : _draft[field]) + '"' +
        (ph ? ' placeholder="' + ph + '"' : '') +
        ' oninput="BuildPlan.ledField(\'' + field + '\',this.value)"></div>';
    }

    var form = '<div class="bp-card">' +
      '<div class="bp-lbl" style="margin-bottom:6px;">\u2795 ' +
        BP.tt('רשומה חדשה', 'รายการใหม่', 'قيد جديد') + '</div>' +
      '<div style="display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px;">' + kindBtns + '</div>' +
      '<div class="bp-grid">' +
        '<div><div class="bp-lbl">' + BP.tt('תאריך', 'วันที่', 'التاريخ') + '</div>' +
          '<input class="bp-in" type="date" value="' + (_draft.date || today()) + '" ' +
            'oninput="BuildPlan.ledField(\'date\',this.value)"></div>' +
        (KINDS[k].money ? fld(BP.tt('סכום \u20aa (לפני מע"מ)', 'จำนวนเงิน', 'المبلغ'), 'amount', 'number') : '') +
        (k === 'equip' ? fld(BP.tt('ציוד', 'อุปกรณ์', 'المعدة'), 'equip', 'text',
          BP.tt('מערבל, פיגומים, מסור', 'เครื่องผสม', 'خلاطة')) : '') +
        (k === 'equip' ? fld(BP.tt('כמות', 'จำนวน', 'الكمية'), 'qty', 'number') : '') +
        (k === 'equip'
          ? '<div><div class="bp-lbl">' + BP.tt('תנועה', 'การเคลื่อนย้าย', 'الحركة') + '</div>' +
              '<select class="bp-in" onchange="BuildPlan.ledField(\'dir\',this.value)">' +
                '<option value="on"' + (_draft.dir !== 'off' ? ' selected' : '') + '>\u2b07 ' +
                  BP.tt('הובא לשטח', 'ส่งเข้าไซต์', 'أُدخل') + '</option>' +
                '<option value="off"' + (_draft.dir === 'off' ? ' selected' : '') + '>\u2b06 ' +
                  BP.tt('הוחזר מהשטח', 'นำออก', 'أُخرج') + '</option>' +
              '</select></div>'
          : '') +
        (k === 'out'
          ? '<div><div class="bp-lbl">' + BP.tt('סוג הוצאה', 'ประเภท', 'النوع') + '</div>' +
              sel('cat', CATS, _draft.cat || 'materials') + '</div>' +
            fld(BP.tt('למי שולם', 'จ่ายให้', 'المستفيد'), 'payee', 'text')
          : '') +
        (k === 'in'
          ? '<div><div class="bp-lbl">' + BP.tt('אמצעי תשלום', 'วิธีชำระ', 'طريقة الدفع') + '</div>' +
              sel('method', METHODS, _draft.method || 'transfer') + '</div>'
          : '') +
      '</div>' +
      '<div style="margin-top:8px;">' +
        '<div class="bp-lbl">' + (k === 'work'
          ? BP.tt('מה בוצע', 'ทำอะไร', 'ما تم تنفيذه')
          : BP.tt('תיאור', 'คำอธิบาย', 'الوصف')) + '</div>' +
        '<input class="bp-in" value="' + BP.esc(_draft.title || '') + '" ' +
          'placeholder="' + (k === 'work'
            ? BP.esc(BP.tt('יציקת יסודות, ריתוך כנפיים, התקנת רשת',
                'เทฐานราก', 'صب الأساسات'))
            : '') + '" oninput="BuildPlan.ledField(\'title\',this.value)"></div>' +
      '<div style="margin-top:6px;">' +
        '<div class="bp-lbl">' + BP.tt('הערה', 'หมายเหตุ', 'ملاحظة') + '</div>' +
        '<input class="bp-in" value="' + BP.esc(_draft.note || '') + '" ' +
          'oninput="BuildPlan.ledField(\'note\',this.value)"></div>' +
      '<button class="bp-btn" style="margin-top:10px;width:100%;" ' +
        'onclick="BuildPlan.ledAdd(' + id + ')">\u2795 ' +
        BP.tt('הוסף ליומן', 'เพิ่ม', 'إضافة') + '</button>' +
    '</div>';

    // ── journal, newest first, grouped by month ──
    var sorted = led.entries.slice().sort(function (a, b) {
      return a.date === b.date ? (b.id - a.id) : (a.date < b.date ? 1 : -1);
    });
    var rows = '', lastMonth = '';
    sorted.forEach(function (e) {
      var mo = e.date.slice(0, 7);
      if (mo !== lastMonth) {
        lastMonth = mo;
        var mSum = 0;
        led.entries.forEach(function (x) {
          if (x.date.slice(0, 7) === mo && KINDS[x.kind].money) mSum += KINDS[x.kind].sign * x.amount;
        });
        rows += '<div style="display:flex;justify-content:space-between;align-items:baseline;' +
          'margin:12px 0 4px;padding-bottom:3px;border-bottom:1px solid var(--accent,#ff9f43);">' +
          '<b style="font-size:.82rem;color:var(--accent,#ff9f43);">' + mo + '</b>' +
          '<span style="font-size:.78rem;color:' + (mSum < 0 ? neg : pos) + ';">' +
            (mSum > 0 ? '+' : '') + money(mSum) + '</span></div>';
      }
      var m = KINDS[e.kind];
      var amt = m.money
        ? '<b style="color:' + (m.sign > 0 ? pos : neg) + ';white-space:nowrap;">' +
            (m.sign > 0 ? '+' : '\u2212') + money(e.amount) + '</b>'
        : (e.kind === 'equip'
            ? '<b style="color:' + acc + ';white-space:nowrap;">' +
                (e.dir === 'on' ? '\u2b07' : '\u2b06') + ' \u00d7' + (e.qty || 1) + '</b>'
            : '');
      var meta = [];
      if (e.kind === 'out' && e.payee) meta.push(BP.esc(e.payee));
      if (e.kind === 'out') meta.push(CATS[e.cat]());
      if (e.kind === 'in') meta.push(METHODS[e.method]());
      if (e.kind === 'equip' && e.equip) meta.push(BP.esc(e.equip));
      if (e.note) meta.push(BP.esc(e.note));
      rows += '<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;' +
        'border-bottom:1px solid var(--panel-border,rgba(255,255,255,.08));">' +
        '<span style="font-size:1rem;">' + m.icon + '</span>' +
        '<div style="flex:1;min-width:0;">' +
          '<div style="font-size:.85rem;font-weight:600;">' +
            BP.esc(e.title || m.label()) + '</div>' +
          '<div style="font-size:.73rem;color:var(--text-muted,#888);">' +
            fmtDate(e.date) + (meta.length ? ' \u00b7 ' + meta.join(' \u00b7 ') : '') + '</div>' +
        '</div>' + amt +
        '<button class="bp-btn ghost" style="padding:3px 7px;font-size:.7rem;" ' +
          'onclick="BuildPlan.ledDel(' + id + ',\'' + e.id + '\')">\u2715</button>' +
      '</div>';
    });

    var journal = '<div class="bp-card">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">' +
        '<div class="bp-lbl">\ud83d\udcd6 ' +
          BP.tt('יומן מעקב', 'บันทึกงาน', 'سجل المتابعة') +
          ' (' + led.entries.length + ')</div>' +
        '<div style="display:flex;gap:5px;">' +
          '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.72rem;" ' +
            'onclick="BuildPlan.ledPrint(' + id + ')">\ud83d\udda8 ' +
            BP.tt('הדפסה', 'พิมพ์', 'طباعة') + '</button>' +
          '<button class="bp-btn ghost" style="padding:5px 9px;font-size:.72rem;" ' +
            'onclick="BuildPlan.ledCsv(' + id + ')">\u2b07 CSV</button>' +
        '</div>' +
      '</div>' +
      (rows || '<div style="font-size:.8rem;color:var(--text-muted,#888);padding:8px 0;">' +
        BP.tt('היומן ריק — כל תשלום, ביצוע וציוד שיירשמו יופיעו כאן',
          'ยังว่าง', 'السجل فارغ') + '</div>') +
    '</div>';

    return summary + form + equip + journal;
  };

  // ── export ──────────────────────────────────────────────────────────
  BP.ledCsv = function ledCsv(pid) {
    var p = BP.projById(pid), led = _led[pid];
    if (!p || !led) return;
    var head = [
      BP.tt('תאריך', 'วันที่', 'التاريخ'),
      BP.tt('סוג', 'ประเภท', 'النوع'),
      BP.tt('תיאור', 'คำอธิบาย', 'الوصف'),
      BP.tt('הכנסה', 'รายรับ', 'إيراد'),
      BP.tt('הוצאה', 'รายจ่าย', 'مصروف'),
      BP.tt('סוג הוצאה', 'ประเภทรายจ่าย', 'نوع المصروف'),
      BP.tt('למי / אמצעי', 'ผู้รับ/วิธี', 'المستفيد/الطريقة'),
      BP.tt('ציוד', 'อุปกรณ์', 'المعدة'),
      BP.tt('כמות', 'จำนวน', 'الكمية'),
      BP.tt('תנועה', 'การเคลื่อนย้าย', 'الحركة'),
      BP.tt('הערה', 'หมายเหตุ', 'ملاحظة')
    ];
    var lines = [head.join(',')];
    led.entries.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).forEach(function (e) {
      function q(s) { return '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"'; }
      lines.push([
        q(e.date), q(KINDS[e.kind].label()), q(e.title),
        e.kind === 'in' ? e.amount : '', e.kind === 'out' ? e.amount : '',
        q(e.kind === 'out' ? CATS[e.cat]() : ''),
        q(e.kind === 'out' ? e.payee : (e.kind === 'in' ? METHODS[e.method]() : '')),
        q(e.equip), e.qty || '', q(e.kind === 'equip' ? e.dir : ''), q(e.note)
      ].join(','));
    });
    // BOM, or Excel opens Hebrew as mojibake.
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ledger-' + String(p.name || pid).replace(/[^\w\u0590-\u05ff-]+/g, '_') + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  };

  BP.ledPrint = function ledPrint(pid) {
    var p = BP.projById(pid), led = _led[pid];
    if (!p || !led) return;
    var t = totals(led), eq = onSite(led);
    var sorted = led.entries.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });

    function tr(e) {
      var m = KINDS[e.kind];
      var meta = [];
      if (e.kind === 'out' && e.payee) meta.push(e.payee);
      if (e.kind === 'out') meta.push(CATS[e.cat]());
      if (e.kind === 'in') meta.push(METHODS[e.method]());
      if (e.kind === 'equip' && e.equip) {
        meta.push(e.equip + ' \u00d7' + (e.qty || 1) +
          ' \u00b7 ' + (e.dir === 'on' ? BP.tt('הובא', 'เข้า', 'إدخال')
                                       : BP.tt('הוחזר', 'ออก', 'إخراج')));
      }
      if (e.note) meta.push(e.note);
      return '<tr><td>' + fmtDate(e.date) + '</td>' +
        '<td>' + m.icon + ' ' + m.label() + '</td>' +
        '<td>' + BP.esc(e.title || '') +
          (meta.length ? '<div class="sub">' + BP.esc(meta.join(' \u00b7 ')) + '</div>' : '') + '</td>' +
        '<td class="n pos">' + (e.kind === 'in' ? money(e.amount) : '') + '</td>' +
        '<td class="n neg">' + (e.kind === 'out' ? money(e.amount) : '') + '</td></tr>';
    }

    // No SVG here, so none of the RTL text-anchor trouble applies; tables
    // reflow inside the page box on their own.
    var css = '@page{size:A4 portrait;margin:14mm}' +
      '*{-webkit-print-color-adjust:exact;print-color-adjust:exact;box-sizing:border-box}' +
      'body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;direction:rtl;margin:0;' +
        'color:#10303f;line-height:1.5;font-size:12px}' +
      'h1{font-size:1.3rem;margin:0 0 2px;color:#0d3b53}' +
      '.meta{font-size:.82rem;color:#5b7886;margin-bottom:14px}' +
      'h2{font-size:.82rem;margin:16px 0 6px;padding:6px 10px;background:#eaf3f7;' +
        'border-right:4px solid #1c6e8c;border-radius:6px;color:#0d3b53}' +
      'table{width:100%;border-collapse:collapse;font-size:.8rem}' +
      'th{text-align:right;background:#eaf3f7;padding:6px 8px;font-size:.74rem;' +
        'border-bottom:2px solid #d8e8ee;color:#0d3b53}' +
      'td{padding:5px 8px;border-bottom:1px solid #e8f0f3;vertical-align:top}' +
      'td.n{text-align:left;white-space:nowrap;font-weight:700}' +
      '.pos{color:#1b7f4b}.neg{color:#b23a2a}' +
      '.sub{font-size:.72rem;color:#6c8a97}' +
      '.sr{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #e8f0f3}' +
      '.tot{font-weight:800;border-top:2px solid #1c6e8c;margin-top:6px;padding-top:6px}' +
      'tr{break-inside:avoid}';

    var sum = [
      [BP.tt('מחיר חוזה', 'ราคาสัญญา', 'قيمة العقد'), money(t.contract), ''],
      [BP.tt('התקבל מהלקוח', 'รับแล้ว', 'المقبوض'), money(t.received), 'pos'],
      [BP.tt('יתרה לגבייה', 'ค้างรับ', 'المتبقي'), money(t.due), t.due > 0 ? 'neg' : 'pos'],
      [BP.tt('שולם', 'จ่ายแล้ว', 'المدفوع'), money(t.paid), 'neg'],
      [BP.tt('מזומן בקופת הפרויקט', 'เงินสด', 'النقد'), money(t.cash), t.cash < 0 ? 'neg' : 'pos']
    ].map(function (r) {
      return '<div class="sr"><span>' + r[0] + '</span><b class="' + r[2] + '">' + r[1] + '</b></div>';
    }).join('') +
      '<div class="sr tot"><span>' +
        BP.tt('רווח אם לא יהיו הוצאות נוספות', 'กำไรสูงสุด', 'الربح الأقصى') +
      '</span><b class="' + (t.margin < 0 ? 'neg' : 'pos') + '">' + money(t.margin) +
        (t.contract > 0 ? ' \u00b7 ' + t.marginPct.toFixed(0) + '%' : '') + '</b></div>';

    var html = '<!doctype html><html dir="rtl" lang="he"><head><meta charset="utf-8">' +
      '<title>' + BP.esc(BP.tt('יומן מעקב', 'บันทึก', 'سجل')) + ' \u00b7 ' + BP.esc(p.name || '') +
      '</title><style>' + css + '</style></head><body>' +
      '<h1>\ud83d\udcd6 ' + BP.esc(BP.tt('יומן מעקב פרויקט', 'บันทึกโครงการ', 'سجل متابعة المشروع')) + '</h1>' +
      '<div class="meta">' + BP.esc(p.name || '') +
        (p.client ? ' \u00b7 ' + BP.esc(p.client) : '') +
        ' \u00b7 ' + fmtDate(today()) + '</div>' +
      '<h2>' + BP.tt('מאזן', 'สมดุล', 'الميزان') + '</h2>' + sum +
      '<h2>' + BP.tt('ציוד שנמצא בשטח', 'อุปกรณ์ในไซต์', 'المعدات في الموقع') + '</h2>' +
      (eq.length
        ? '<table><thead><tr><th>' + BP.tt('ציוד', 'อุปกรณ์', 'المعدة') + '</th><th>' +
            BP.tt('כמות', 'จำนวน', 'الكمية') + '</th><th>' +
            BP.tt('בשטח מאז', 'ตั้งแต่', 'منذ') + '</th></tr></thead><tbody>' +
          eq.map(function (x) {
            return '<tr><td>' + BP.esc(x.name) + '</td><td>' + x.qty + '</td><td>' +
              fmtDate(x.since) + '</td></tr>';
          }).join('') + '</tbody></table>'
        : '<div class="sub">' + BP.tt('אין ציוד רשום בשטח', 'ไม่มี', 'لا شيء') + '</div>') +
      '<h2>' + BP.tt('פירוט תנועות', 'รายการ', 'الحركات') + '</h2>' +
      '<table><thead><tr>' +
        '<th>' + BP.tt('תאריך', 'วันที่', 'التاريخ') + '</th>' +
        '<th>' + BP.tt('סוג', 'ประเภท', 'النوع') + '</th>' +
        '<th>' + BP.tt('תיאור', 'คำอธิบาย', 'الوصف') + '</th>' +
        '<th>' + BP.tt('התקבל', 'รับ', 'مقبوض') + '</th>' +
        '<th>' + BP.tt('שולם', 'จ่าย', 'مدفوع') + '</th>' +
      '</tr></thead><tbody>' + (sorted.map(tr).join('') ||
        '<tr><td colspan="5" class="sub">' + BP.tt('אין רשומות', 'ไม่มี', 'لا يوجد') + '</td></tr>') +
      '</tbody></table>' +
      '</body></html>';

    // A new window and window.print(), the same route every other report
    // here takes since html2pdf's DOM-cloning bug produced blank pages.
    var w = window.open('', '_blank');
    if (!w) { BP.toast('\u26a0\ufe0f ' + BP.tt('חסום חלונות קופצים', 'ป๊อปอัพถูกบล็อก', 'النوافذ محجوبة')); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) {} }, 350);
  };

  // Handlers named in inline attributes have to exist on the global. Written
  // out one per line rather than looped: a loop registers them just as well
  // at runtime, but preflight cannot see through it, and losing that check
  // is a worse trade than the extra lines.
  BuildPlan.ledgerTab      = BP.ledgerTab;
  BuildPlan.ledgerLoad     = BP.ledgerLoad;
  BuildPlan.ledKind        = BP.ledKind;
  BuildPlan.ledField       = BP.ledField;
  BuildPlan.ledAdd         = BP.ledAdd;
  BuildPlan.ledDel         = BP.ledDel;
  BuildPlan.ledReturn      = BP.ledReturn;
  BuildPlan.ledSet         = BP.ledSet;
  BuildPlan.ledFromTakeoff = BP.ledFromTakeoff;
  BuildPlan.ledCsv         = BP.ledCsv;
  BuildPlan.ledPrint       = BP.ledPrint;

})(BuildPlanInternals);
