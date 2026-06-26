/* ============================================================================
 * Shorashim Plus — Universal Export Module  (v1.0)
 * ----------------------------------------------------------------------------
 * Print-isolated PDF + CSV + JSON + Excel for every report in the app.
 * Built against actual field names from app.js / timeclock.js / fieldreport.js /
 * maintenance.js as of commit on main.
 *
 * Public API:
 *   Export.showMenu(dataset, event)        ─ floating 4-format picker
 *   Export.exportPDF(dataset, opts)
 *   Export.exportCSV(dataset, opts)
 *   Export.exportJSON(dataset, opts)
 *   Export.exportXLSX(dataset, opts)
 *
 *   Adapters (real field names baked in):
 *   Export.adapters.timeclock(records)     ─ {userName, workplace, date,
 *                                              punchIn(ms), punchOut(ms), duration(ms)}
 *   Export.adapters.spray(sprayEvents, plots)
 *                                          ─ {date, plotIds[], applications[],
 *                                              volumePerTree, sprayerCapacity, operator}
 *   Export.adapters.sprayFlat(sprayEvents) ─ from localStorage sprayEvents
 *                                              {date, operator, plotNames[], pesticide,
 *                                               concentration, quantity, notes}
 *   Export.adapters.worklog(entries)       ─ {date, plot_name, budget_category,
 *                                              description, worker_group, worker_count,
 *                                              hours, trees, notes}
 *   Export.adapters.tasks(tasks)           ─ {title, description, assignedTo,
 *                                              workplace, dueDate, status, created(ms)}
 *   Export.adapters.fieldReports(reports)  ─ {date, time, inspector, plotName,
 *                                              cropType, pest, disease, severity,
 *                                              infectionPercent, affectedTrees,
 *                                              locations, recommendation, notes}
 *   Export.adapters.maintenanceQuote(project, totals)
 *   Export.adapters.maintenanceShipments(project)
 *   Export.adapters.maintenanceInvoices(project, invoiceTotals)
 * ========================================================================== */

var Export = (function () {
  'use strict';

  // ─── Translation shim (works whether tt or t is defined) ────────────────
  function _t(he, th, ar) {
    if (typeof tt === 'function')       return tt(he, th || he, ar || he);
    if (typeof t  === 'function')       return t(he);
    return he;
  }

  // ─── Toast shim (matches existing showToast(msg) signature) ─────────────
  function _toast(msg) {
    if (typeof showToast === 'function') { showToast(msg); return; }
    console.log('[Export]', msg);
  }

  // ─── Formatting ──────────────────────────────────────────────────────────
  function _pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function _fmtDate(d) {
    if (!d && d !== 0) return '';
    var dt = (d instanceof Date) ? d : new Date(typeof d === 'number' ? d : String(d));
    if (isNaN(dt)) return String(d);
    return _pad2(dt.getDate()) + '/' + _pad2(dt.getMonth() + 1) + '/' + dt.getFullYear();
  }
  function _fmtTime(d) {
    if (!d && d !== 0) return '';
    var dt = (d instanceof Date) ? d : new Date(typeof d === 'number' ? d : String(d));
    if (isNaN(dt)) return String(d);
    return _pad2(dt.getHours()) + ':' + _pad2(dt.getMinutes());
  }
  function _fmtDateTime(d) {
    var dt = (d instanceof Date) ? d : new Date(typeof d === 'number' ? d : String(d));
    if (isNaN(dt)) return String(d);
    return _fmtDate(dt) + ' ' + _fmtTime(dt);
  }
  function _fmtHours(ms) {
    if (!ms && ms !== 0) return '';
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '';
    return (n / 3600000).toFixed(2);
  }
  function _todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + _pad2(d.getMonth() + 1) + '-' + _pad2(d.getDate());
  }
  function _safe(s) {
    return String(s || 'export').replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 80);
  }
  function _filename(dataset, ext) {
    return (dataset.filename || _safe(dataset.title) || 'shorashim') + '_' + _todayISO() + '.' + ext;
  }
  function _esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
                    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }
  function _renderCell(row, col) {
    var v = row[col.key];
    if (typeof col.format === 'function') { try { return col.format(v, row); } catch (e) {} }
    if (v === null || v === undefined) return '';
    if (v instanceof Date) return _fmtDate(v);
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  }
  function _normalize(ds) {
    if (!ds || !Array.isArray(ds.columns) || !Array.isArray(ds.rows))
      throw new Error('Export: dataset needs columns[] and rows[]');
    ds.title = ds.title || 'Shorashim Export';
    ds.meta = ds.meta || {};
    return ds;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  PDF — print-isolated, theme variables explicitly reset
  // ═══════════════════════════════════════════════════════════════════════
  function exportPDF(dataset, opts) {
    dataset = _normalize(dataset); opts = opts || {};
    if (typeof html2pdf === 'undefined') {
      _toast('❌ html2pdf לא נטען');
      console.error('Export.exportPDF: html2pdf undefined');
      return Promise.reject();
    }

    var landscape = opts.landscape != null ? opts.landscape : dataset.columns.length > 6;
    var container = _buildPrintContainer(dataset, { landscape: landscape });
    document.body.appendChild(container);

    _toast('📄 ' + _t('יוצר PDF…', 'กำลังสร้าง PDF…', 'إنشاء PDF…'));

    // Wait for fonts AND a render frame before capture — prevents blank canvas
    var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
    return fontsReady.then(function () {
      return new Promise(function (resolve) { requestAnimationFrame(function () { resolve(); }); });
    }).then(function () {
      // Diagnostic: log what html2canvas will actually see
      var rect = container.getBoundingClientRect();
      console.log('[Export PDF] container dims:', {
        offsetW: container.offsetWidth, offsetH: container.offsetHeight,
        scrollW: container.scrollWidth, scrollH: container.scrollHeight,
        clientRect: { w: rect.width, h: rect.height, top: rect.top, left: rect.left }
      });
      if (container.offsetHeight === 0) {
        console.warn('[Export PDF] container has zero height — PDF will be blank');
      }
      return html2pdf().set({
        margin:   [10, 8, 12, 8],
        filename: _filename(dataset, 'pdf'),
        image:    { type: 'jpeg', quality: 0.96 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff'
        },
        jsPDF: {
          unit: 'mm', format: 'a4',
          orientation: landscape ? 'landscape' : 'portrait',
          compress: true
        },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.no-break'] }
      }).from(container).toCanvas().then(function (canvas) {
        console.log('[Export PDF] canvas dims:', canvas.width, 'x', canvas.height);
        if (canvas.width === 0 || canvas.height === 0) {
          throw new Error('Canvas has zero dimensions — capture failed');
        }
        return html2pdf().set({
          margin:   [10, 8, 12, 8],
          filename: _filename(dataset, 'pdf'),
          jsPDF: { unit: 'mm', format: 'a4', orientation: landscape ? 'landscape' : 'portrait', compress: true }
        }).from(canvas).toPdf().save();
      });
    }).then(function () {
      if (container.parentNode) container.parentNode.removeChild(container);
      _toast('✅ ' + _t('PDF נשמר', 'บันทึก PDF', 'تم حفظ PDF'));
    }).catch(function (err) {
      try { if (container.parentNode) container.parentNode.removeChild(container); } catch (e) {}
      console.error('[Export PDF] failed:', err);
      _toast('❌ ' + _t('יצירת PDF נכשלה — ראה console', 'PDF ล้มเหลว', 'فشل PDF'));
    });
  }

  function _buildPrintContainer(dataset, opts) {
    var root = document.createElement('div');
    root.className = 'export-print-root';
    root.setAttribute('dir', 'rtl');

    // CRITICAL: html2canvas in newer versions skips elements positioned outside
    // the viewport. We must keep the container IN the viewport but invisible
    // (opacity:0 + z-index:-1 + pointer-events:none). The offscreen-via-left:-9999
    // trick stopped working in html2canvas 1.4+.
    var widthMm = opts.landscape ? 277 : 194;
    root.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:' + widthMm + 'mm',
      'opacity:0',
      'pointer-events:none',
      'z-index:-1',
      'background:#ffffff',
      'color:#111111',
      'font-family:"Heebo","Assistant","Noto Sans Hebrew","Segoe UI",Arial,sans-serif',
      'direction:rtl',
      'text-align:right',
      'padding:0',
      'margin:0'
    ].join(';');

    // Header strip
    var h = document.createElement('div');
    h.className = 'no-break';
    h.innerHTML =
      '<div style="border-bottom:2px solid #2d6a4f;padding:0 0 10px 0;margin-bottom:12px;background:#fff">' +
        '<div style="display:flex;justify-content:space-between;align-items:flex-end">' +
          '<div>' +
            '<div style="font-size:18pt;font-weight:700;color:#1b4332;background:#fff">' + _esc(dataset.title) + '</div>' +
            (dataset.subtitle ? '<div style="font-size:11pt;color:#444;margin-top:2px;background:#fff">' + _esc(dataset.subtitle) + '</div>' : '') +
          '</div>' +
          '<div style="font-size:9pt;color:#555;text-align:left;direction:ltr;background:#fff">' +
            '🌿 Shorashim Plus<br>' + _fmtDateTime(new Date()) +
          '</div>' +
        '</div>' +
        _renderMeta(dataset.meta) +
      '</div>';
    root.appendChild(h);

    // Table
    var table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:10pt;background:#fff';
    var thead = document.createElement('thead');
    thead.style.cssText = 'display:table-header-group';
    var trh = document.createElement('tr');
    dataset.columns.forEach(function (c) {
      var th = document.createElement('th');
      th.textContent = c.label || c.key;
      th.style.cssText = 'background:#2d6a4f !important;color:#ffffff !important;padding:6px 8px;text-align:' +
        (c.align || 'right') + ';font-weight:600;border:1px solid #1b4332;font-size:10pt';
      if (c.width) th.style.width = c.width + 'px';
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    dataset.rows.forEach(function (row, idx) {
      var tr = document.createElement('tr');
      var bg = idx % 2 ? '#f4f9f6' : '#ffffff';
      tr.style.cssText = 'page-break-inside:avoid;background:' + bg + ' !important';
      dataset.columns.forEach(function (col) {
        var td = document.createElement('td');
        td.textContent = _renderCell(row, col);
        td.style.cssText = 'padding:5px 8px;border:1px solid #cfd9d3;text-align:' +
          (col.align || 'right') + ';color:#111 !important;font-size:9.5pt;vertical-align:top;background:' +
          bg + ' !important';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    root.appendChild(table);

    if (!dataset.rows.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:30px;text-align:center;color:#777;font-size:11pt;background:#fff';
      empty.textContent = _t('אין נתונים להצגה', 'ไม่มีข้อมูล', 'لا توجد بيانات');
      root.appendChild(empty);
    }

    if (dataset.summary && dataset.summary.length) {
      var sum = document.createElement('div');
      sum.className = 'no-break';
      sum.style.cssText = 'margin-top:14px;padding:10px;background:#e8f3ec !important;' +
        'border:1px solid #95c9a9;border-radius:6px;page-break-inside:avoid';
      var html = '<div style="font-weight:700;color:#1b4332;margin-bottom:6px;font-size:11pt">' +
        _t('סיכום', 'สรุป', 'ملخص') + '</div><table style="width:100%;font-size:10pt"><tbody>';
      dataset.summary.forEach(function (s) {
        html += '<tr><td style="padding:3px 8px;color:#444;background:#e8f3ec">' + _esc(s.label) +
          '</td><td style="padding:3px 8px;text-align:left;font-weight:600;color:#111;background:#e8f3ec">' +
          _esc(s.value) + '</td></tr>';
      });
      html += '</tbody></table>';
      sum.innerHTML = html;
      root.appendChild(sum);
    }

    var foot = document.createElement('div');
    foot.style.cssText = 'margin-top:18px;padding-top:6px;border-top:1px solid #ccc;' +
      'font-size:8pt;color:#888;text-align:center;direction:ltr;background:#fff';
    foot.textContent = 'shorashim-plus.web.app · ' + _fmtDateTime(new Date());
    root.appendChild(foot);
    return root;
  }

  function _renderMeta(meta) {
    var keys = Object.keys(meta || {});
    var labels = {
      farm: _t('חווה','ฟาร์ม','مزرعة'),
      plot: _t('חלקה','แปลง','قطعة'),
      worker: _t('עובד','คนงาน','عامل'),
      generatedBy: _t('הופק על ידי','สร้างโดย','أنشأ بواسطة'),
      dateRange: _t('טווח תאריכים','ช่วงวันที่','نطاق التواريخ'),
      project: _t('פרויקט','โครงการ','مشروع'),
      client: _t('לקוח','ลูกค้า','عميل')
    };
    var parts = keys.filter(function (k) { return meta[k] != null && meta[k] !== ''; })
      .map(function (k) {
        return '<span style="display:inline-block;margin-left:14px;background:#fff">' +
          '<b style="color:#1b4332">' + _esc(labels[k] || k) + ':</b> ' +
          '<span style="color:#333">' + _esc(meta[k]) + '</span></span>';
      });
    if (!parts.length) return '';
    return '<div style="margin-top:8px;font-size:9.5pt;color:#444;background:#fff">' + parts.join('') + '</div>';
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  CSV — UTF-8 BOM (so Excel reads Hebrew correctly)
  // ═══════════════════════════════════════════════════════════════════════
  function exportCSV(dataset, opts) {
    dataset = _normalize(dataset); opts = opts || {};
    var sep = opts.separator || ',';
    var lines = [];
    lines.push(dataset.columns.map(function (c) { return _csvEsc(c.label || c.key, sep); }).join(sep));
    dataset.rows.forEach(function (r) {
      lines.push(dataset.columns.map(function (c) { return _csvEsc(_renderCell(r, c), sep); }).join(sep));
    });
    if (dataset.summary && dataset.summary.length) {
      lines.push('');
      dataset.summary.forEach(function (s) {
        lines.push(_csvEsc(s.label, sep) + sep + _csvEsc(s.value, sep));
      });
    }
    _download('\uFEFF' + lines.join('\r\n'), _filename(dataset, 'csv'), 'text/csv;charset=utf-8');
    _toast('📊 ' + _t('CSV נשמר', 'บันทึก CSV', 'تم حفظ CSV'));
  }
  function _csvEsc(v, sep) {
    var s = (v == null) ? '' : String(v);
    if (s.indexOf('"') !== -1 || s.indexOf(sep) !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  JSON
  // ═══════════════════════════════════════════════════════════════════════
  function exportJSON(dataset, opts) {
    dataset = _normalize(dataset);
    var payload = {
      title: dataset.title,
      subtitle: dataset.subtitle || null,
      app: 'Shorashim Plus',
      generatedAt: new Date().toISOString(),
      meta: dataset.meta || {},
      columns: dataset.columns.map(function (c) { return { key: c.key, label: c.label || c.key }; }),
      rowCount: dataset.rows.length,
      rows: dataset.rows.map(function (r) {
        var clean = {};
        dataset.columns.forEach(function (c) { clean[c.key] = r[c.key] === undefined ? null : r[c.key]; });
        return clean;
      }),
      summary: dataset.summary || []
    };
    _download(JSON.stringify(payload, null, 2), _filename(dataset, 'json'), 'application/json;charset=utf-8');
    _toast('🔧 ' + _t('JSON נשמר', 'บันทึก JSON', 'تم حفظ JSON'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  XLSX (SheetJS)
  // ═══════════════════════════════════════════════════════════════════════
  function exportXLSX(dataset, opts) {
    dataset = _normalize(dataset);
    if (typeof XLSX === 'undefined') {
      _toast('❌ ' + _t('SheetJS לא נטען','SheetJS ไม่ถูกโหลด','SheetJS غير محمل'));
      console.error('Export.exportXLSX: XLSX undefined');
      return;
    }
    var aoa = [dataset.columns.map(function (c) { return c.label || c.key; })];
    dataset.rows.forEach(function (r) {
      aoa.push(dataset.columns.map(function (c) {
        var v = r[c.key];
        if (typeof v === 'number') return v;
        if (v instanceof Date)     return v;
        return _renderCell(r, c);
      }));
    });
    if (dataset.summary && dataset.summary.length) {
      aoa.push([]);
      dataset.summary.forEach(function (s) {
        aoa.push([s.label, typeof s.value === 'number' ? s.value : String(s.value)]);
      });
    }
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!views'] = [{ RTL: true }];
    ws['!cols'] = dataset.columns.map(function (c) {
      return { wch: c.xlsxWidth || Math.max(12, (c.label || c.key).length + 4) };
    });
    ws['!freeze'] = { xSplit: 0, ySplit: 1 };

    var wb = XLSX.utils.book_new();
    wb.Workbook = { Views: [{ RTL: true }] };
    var sheetName = String(dataset.title || 'Sheet1').replace(/[\/\\?*\[\]:]/g, '').slice(0, 31) || 'Sheet1';
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, _filename(dataset, 'xlsx'));
    _toast('📈 ' + _t('Excel נשמר', 'บันทึก Excel', 'تم حفظ Excel'));
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  Download helper
  // ═══════════════════════════════════════════════════════════════════════
  function _download(content, filename, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
  }

  // ═══════════════════════════════════════════════════════════════════════
  //  4-format picker menu
  // ═══════════════════════════════════════════════════════════════════════
  function showMenu(dataset, anchor) {
    _closeMenu();
    var menu = document.createElement('div');
    menu.id = 'export-menu-popup';
    menu.setAttribute('dir', 'rtl');
    menu.style.cssText = 'position:fixed;z-index:99999;background:rgba(15,25,18,0.97);' +
      'backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
      'border:1px solid rgba(57,255,20,0.35);border-radius:12px;padding:6px;' +
      'box-shadow:0 8px 32px rgba(0,0,0,0.6),0 0 24px rgba(57,255,20,0.15);' +
      'min-width:200px;font-family:"Heebo","Assistant",sans-serif';

    var btns = [
      { icon: '📄', label: _t('PDF','PDF','PDF'),     fn: function () { exportPDF(dataset);  } },
      { icon: '📈', label: _t('Excel','Excel','Excel'), fn: function () { exportXLSX(dataset); } },
      { icon: '📊', label: _t('CSV','CSV','CSV'),     fn: function () { exportCSV(dataset);  } },
      { icon: '🔧', label: _t('JSON','JSON','JSON'),   fn: function () { exportJSON(dataset); } }
    ];
    btns.forEach(function (b) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.innerHTML = '<span style="font-size:16px;margin-left:10px">' + b.icon + '</span><span>' + b.label + '</span>';
      btn.style.cssText = 'display:flex;align-items:center;width:100%;background:transparent;' +
        'border:none;color:#e8ffe8;padding:11px 16px;border-radius:8px;cursor:pointer;' +
        'font-size:14px;text-align:right;font-family:inherit;transition:background 0.15s';
      btn.onmouseover = function () { btn.style.background = 'rgba(57,255,20,0.15)'; };
      btn.onmouseout  = function () { btn.style.background = 'transparent'; };
      btn.onclick = function () { _closeMenu(); b.fn(); };
      menu.appendChild(btn);
    });
    document.body.appendChild(menu);

    var rect = null;
    if (anchor && anchor.target && anchor.target.getBoundingClientRect)        rect = anchor.target.getBoundingClientRect();
    else if (anchor && anchor.currentTarget && anchor.currentTarget.getBoundingClientRect) rect = anchor.currentTarget.getBoundingClientRect();
    else if (anchor && anchor.getBoundingClientRect)                            rect = anchor.getBoundingClientRect();

    if (rect) {
      var top = rect.bottom + 6, left = rect.right - menu.offsetWidth;
      if (left < 8) left = 8;
      if (top + menu.offsetHeight > window.innerHeight - 8) top = rect.top - menu.offsetHeight - 6;
      menu.style.top = top + 'px'; menu.style.left = left + 'px';
    } else {
      menu.style.top = '50%'; menu.style.left = '50%';
      menu.style.transform = 'translate(-50%,-50%)';
    }
    setTimeout(function () {
      document.addEventListener('click', _closeMenuOnAway, true);
      document.addEventListener('keydown', _closeMenuOnEsc, true);
    }, 0);
  }
  function _closeMenu() {
    var m = document.getElementById('export-menu-popup'); if (m) m.remove();
    document.removeEventListener('click', _closeMenuOnAway, true);
    document.removeEventListener('keydown', _closeMenuOnEsc, true);
  }
  function _closeMenuOnAway(e) {
    var m = document.getElementById('export-menu-popup'); if (m && !m.contains(e.target)) _closeMenu();
  }
  function _closeMenuOnEsc(e) { if (e.key === 'Escape') _closeMenu(); }

  // ═══════════════════════════════════════════════════════════════════════
  //  ADAPTERS — real field names from the actual codebase
  // ═══════════════════════════════════════════════════════════════════════
  var adapters = {};

  // ── Timeclock: records from Firestore `timeclock` collection ────────────
  // Fields: userName/username, workplace, date, punchIn (ms), punchOut (ms), duration (ms)
  adapters.timeclock = function (records, meta) {
    records = records || [];
    var totalMs = 0;
    records.forEach(function (r) { totalMs += Number(r.duration) || 0; });
    return {
      title: _t('דוח שעון נוכחות','รายงานเวลาทำงาน','تقرير الحضور'),
      filename: 'timeclock',
      meta: meta || {},
      columns: [
        { key: 'date',      label: _t('תאריך','วันที่','تاريخ'),            width: 80, align: 'center' },
        { key: 'userName',  label: _t('עובד','คนงาน','عامل'),               width: 120,
          format: function (v, r) { return v || r.username || ''; } },
        { key: 'workplace', label: _t('מקום עבודה','สถานที่','مكان العمل'), width: 110 },
        { key: 'punchIn',   label: _t('כניסה','เข้า','دخول'),               width: 70, align: 'center', format: _fmtTime },
        { key: 'punchOut',  label: _t('יציאה','ออก','خروج'),                width: 70, align: 'center', format: _fmtTime },
        { key: 'duration',  label: _t('שעות','ชั่วโมง','ساعات'),            width: 70, align: 'center', format: _fmtHours }
      ],
      rows: records,
      summary: [
        { label: _t('סה״כ רשומות','จำนวนรายการ','إجمالي السجلات'), value: records.length },
        { label: _t('סה״כ שעות','รวมชั่วโมง','إجمالي الساعات'),     value: (totalMs / 3600000).toFixed(2) }
      ]
    };
  };

  // ── Worklog entries from localStorage.plotMapperSprayData.worklogEntries ─
  adapters.worklog = function (entries, meta) {
    entries = entries || [];
    var totalHrs = 0, totalTrees = 0;
    entries.forEach(function (e) {
      totalHrs += Number(e.hours) || 0;
      totalTrees += Number(e.trees) || 0;
    });
    return {
      title: _t('יומן עבודה','บันทึกงาน','سجل العمل'),
      filename: 'worklog',
      meta: meta || {},
      columns: [
        { key: 'date',            label: _t('תאריך','วันที่','تاريخ'),                      width: 80, align: 'center' },
        { key: 'plot_name',       label: _t('חלקה','แปลง','قطعة'),                          width: 100 },
        { key: 'budget_category', label: _t('סעיף','หมวด','بند'),                            width: 100 },
        { key: 'description',     label: _t('פעולה','งาน','عملية') },
        { key: 'worker_group',    label: _t('קבוצת עובדים','กลุ่มคนงาน','مجموعة عمال'),   width: 110 },
        { key: 'worker_count',    label: _t('מס׳ עובדים','จำนวน','عدد العمال'),            width: 70, align: 'center' },
        { key: 'hours',           label: _t('שעות','ชม.','ساعات'),                          width: 60, align: 'center' },
        { key: 'trees',           label: _t('עצים','ต้น','أشجار'),                          width: 60, align: 'center' },
        { key: 'notes',           label: _t('הערות','หมายเหตุ','ملاحظات') }
      ],
      rows: entries,
      summary: [
        { label: _t('סה״כ רשומות','รายการทั้งหมด','إجمالي السجلات'), value: entries.length },
        { label: _t('סה״כ שעות','รวมชั่วโมง','إجمالي الساعات'),       value: totalHrs.toFixed(2) },
        { label: _t('סה״כ עצים','รวมต้น','إجمالي الأشجار'),           value: totalTrees }
      ]
    };
  };

  // ── Spray events (FLAT form — from localStorage CSV-style data) ─────────
  // {date, operator, plotNames[], pesticide, concentration, quantity, notes}
  adapters.sprayFlat = function (events, meta) {
    events = events || [];
    return {
      title: _t('יומן ריסוסים','บันทึกพ่นยา','سجل الرش'),
      filename: 'spray_log',
      meta: meta || {},
      columns: [
        { key: 'date',          label: _t('תאריך','วันที่','تاريخ'),               width: 80, align: 'center' },
        { key: 'operator',      label: _t('מפעיל','ผู้ปฏิบัติ','مشغل'),            width: 110 },
        { key: 'plotNames',     label: _t('חלקות','แปลง','قطع'),
          format: function (v) { return Array.isArray(v) ? v.join(', ') : (v || ''); } },
        { key: 'pesticide',     label: _t('תכשיר','สารเคมี','مبيد') },
        { key: 'concentration', label: _t('ריכוז','ความเข้มข้น','تركيز'),         width: 70, align: 'center' },
        { key: 'quantity',      label: _t('כמות','ปริมาณ','كمية'),                 width: 70, align: 'center' },
        { key: 'notes',         label: _t('הערות','หมายเหตุ','ملاحظات') }
      ],
      rows: events,
      summary: [{ label: _t('סה״כ ריסוסים','รวมการพ่น','إجمالي الرش'), value: events.length }]
    };
  };

  // ── Spray events (RICH form — from app.js plot mapper) ──────────────────
  // {date, plotIds[], operator, applications[{productName, activeIngredient, concentration, target}], volumePerTree, sprayerCapacity}
  adapters.spray = function (sprayEvents, plots, meta) {
    sprayEvents = sprayEvents || []; plots = plots || [];
    function plotName(id) { var p = plots.find(function (x) { return x.id === id; }); return p ? p.name : '—'; }
    function plotArea(id) { var p = plots.find(function (x) { return x.id === id; }); return p ? Number(p.area) || 0 : 0; }
    var rows = [];
    sprayEvents.slice().sort(function (a, b) { return new Date(b.date) - new Date(a.date); })
      .forEach(function (ev) {
        var names = (ev.plotIds || []).map(plotName).join(', ');
        var area  = (ev.plotIds || []).reduce(function (s, id) { return s + plotArea(id); }, 0);
        (ev.applications || []).forEach(function (app) {
          rows.push({
            date:        ev.date,
            operator:    ev.operator || '',
            plots:       names,
            area:        area,
            volumePerTree: ev.volumePerTree,
            sprayer:     ev.sprayerCapacity,
            product:     app.productName,
            active:      app.activeIngredient,
            concentration: app.concentration,
            target:      app.target
          });
        });
      });
    return {
      title: _t('יומן ריסוסים','บันทึกพ่นยา','سجل الرش'),
      filename: 'spray_log',
      meta: meta || {},
      columns: [
        { key: 'date',          label: _t('תאריך','วันที่','تاريخ'),                  width: 80, align: 'center', format: _fmtDate },
        { key: 'operator',      label: _t('מפעיל','ผู้ปฏิบัติ','مشغل'),               width: 100 },
        { key: 'plots',         label: _t('חלקות','แปลง','قطع') },
        { key: 'area',          label: _t('שטח (דונם)','พื้นที่','مساحة'),           width: 80, align: 'center',
          format: function (v) { return Number(v).toFixed(2); } },
        { key: 'volumePerTree', label: _t('נפח/עץ (ל׳)','ปริมาตร/ต้น','حجم/شجرة'),   width: 80, align: 'center' },
        { key: 'sprayer',       label: _t('מרסס (ל׳)','ถังพ่น','رشاش'),               width: 80, align: 'center' },
        { key: 'product',       label: _t('תכשיר','สารเคมี','مبيد') },
        { key: 'active',        label: _t('חומר פעיל','สารออกฤทธิ์','مادة فعالة') },
        { key: 'concentration', label: _t('ריכוז %','ความเข้มข้น','تركيز'),           width: 70, align: 'center',
          format: function (v) { return v != null ? v + '%' : ''; } },
        { key: 'target',        label: _t('מטרה','เป้าหมาย','هدف') }
      ],
      rows: rows,
      summary: [{ label: _t('סה״כ יישומים','รวมการใช้','إجمالي التطبيقات'), value: rows.length }]
    };
  };

  // ── Tasks from localStorage `shorashim-tasks` ───────────────────────────
  // {title, description, assignedTo, workplace, dueDate, status, created (ms)}
  adapters.tasks = function (tasks, meta) {
    tasks = tasks || [];
    var byStatus = {};
    tasks.forEach(function (t) { var k = t.status || 'unknown'; byStatus[k] = (byStatus[k] || 0) + 1; });
    var summary = [{ label: _t('סה״כ משימות','รวมงาน','إجمالي المهام'), value: tasks.length }];
    Object.keys(byStatus).forEach(function (k) { summary.push({ label: k, value: byStatus[k] }); });
    return {
      title: _t('דוח משימות','รายงานงาน','تقرير المهام'),
      filename: 'tasks',
      meta: meta || {},
      columns: [
        { key: 'title',       label: _t('כותרת','ชื่อ','عنوان') },
        { key: 'description', label: _t('תיאור','รายละเอียด','وصف') },
        { key: 'assignedTo',  label: _t('מוקצה ל','มอบหมายให้','مكلف لـ'),         width: 110 },
        { key: 'workplace',   label: _t('מקום','สถานที่','مكان'),                   width: 100 },
        { key: 'dueDate',     label: _t('תאריך יעד','วันกำหนด','تاريخ الاستحقاق'), width: 90, align: 'center' },
        { key: 'status',      label: _t('סטטוס','สถานะ','حالة'),                    width: 80, align: 'center' },
        { key: 'created',     label: _t('נוצר','สร้างเมื่อ','أُنشئ'),               width: 90, align: 'center', format: _fmtDate }
      ],
      rows: tasks,
      summary: summary
    };
  };

  // ── Field reports — from fieldreport.js loadReports() ────────────────────
  // {id, date, time, inspector, plotName, cropType, pest, disease, severity,
  //  infectionPercent, affectedTrees, locations, recommendation, notes}
  adapters.fieldReports = function (reports, meta) {
    reports = reports || [];
    return {
      title: _t('דוחות סיור שדה','รายงานตรวจสนาม','تقارير فحص ميداني'),
      filename: 'field_reports',
      meta: meta || {},
      columns: [
        { key: 'date',             label: _t('תאריך','วันที่','تاريخ'),         width: 80, align: 'center' },
        { key: 'time',             label: _t('שעה','เวลา','وقت'),               width: 60, align: 'center' },
        { key: 'inspector',        label: _t('בודק','ผู้ตรวจ','مفتش'),         width: 100 },
        { key: 'plotName',         label: _t('חלקה','แปลง','قطعة'),             width: 100 },
        { key: 'cropType',         label: _t('גידול','พืช','محصول'),            width: 80 },
        { key: 'pest',             label: _t('מזיק','ศัตรูพืช','آفة') },
        { key: 'disease',          label: _t('מחלה','โรค','مرض') },
        { key: 'severity',         label: _t('חומרה','ความรุนแรง','شدة'),       width: 80, align: 'center' },
        { key: 'infectionPercent', label: _t('% נגיעות','% ติด','% إصابة'),     width: 80, align: 'center',
          format: function (v) { return v != null && v !== '' ? v + '%' : ''; } },
        { key: 'affectedTrees',    label: _t('עצים נגועים','ต้นติด','أشجار مصابة'), width: 80, align: 'center' },
        { key: 'recommendation',   label: _t('המלצה','คำแนะนำ','توصية') },
        { key: 'notes',            label: _t('הערות','หมายเหตุ','ملاحظات') }
      ],
      rows: reports,
      summary: [{ label: _t('סה״כ דוחות','รวมรายงาน','إجمالي التقارير'), value: reports.length }]
    };
  };

  // ── Single field report (detail PDF) ────────────────────────────────────
  adapters.fieldReportDetail = function (r) {
    var rows = [
      { k: _t('תאריך','วันที่','تاريخ'),         v: (r.date || '') + (r.time ? ' ' + r.time : '') },
      { k: _t('בודק','ผู้ตรวจ','مفتش'),         v: r.inspector || '' },
      { k: _t('חלקה','แปลง','قطعة'),             v: (r.plotName || '') + (r.cropType ? ' (' + r.cropType + ')' : '') },
      { k: _t('מזיק','ศัตรูพืช','آفة'),         v: r.pest || '' },
      { k: _t('מחלה','โรค','مرض'),               v: r.disease || '' },
      { k: _t('חומרה','ความรุนแรง','شدة'),       v: r.severityLabel || r.severity || '' },
      { k: _t('% נגיעות','% ติด','% إصابة'),     v: r.infectionPercent != null ? r.infectionPercent + '%' : '' },
      { k: _t('עצים נגועים','ต้นติด','أشجار مصابة'), v: r.affectedTrees || '' },
      { k: _t('מיקום','ตำแหน่ง','موقع'),         v: r.locationsText || '' },
      { k: _t('המלצה','คำแนะนำ','توصية'),         v: r.recommendation || '' },
      { k: _t('הערות','หมายเหตุ','ملاحظات'),     v: r.notes || '' }
    ].filter(function (x) { return x.v !== '' && x.v != null; });
    return {
      title: _t('דוח סיור שדה','รายงานตรวจสนาม','تقرير فحص ميداني'),
      subtitle: (r.date || '') + (r.plotName ? ' · ' + r.plotName : ''),
      filename: 'field-report-' + (r.date || _todayISO()),
      meta: {},
      columns: [
        { key: 'k', label: _t('שדה','ฟิลด์','حقل'), width: 130 },
        { key: 'v', label: _t('ערך','ค่า','قيمة') }
      ],
      rows: rows,
      landscape: false
    };
  };

  // ── Maintenance: quote, shipments, invoices ─────────────────────────────
  adapters.maintenanceQuote = function (project, totals) {
    var items = [];
    (project.materials || []).forEach(function (m, i) {
      items.push({ idx: i + 1, type: '📦', name: m.name, qty: m.quantity + ' ' + (m.unit || ''),
                   unitPrice: '₪' + (m.unitPrice || 0).toLocaleString(),
                   total: '₪' + ((m.quantity || 0) * (m.unitPrice || 0)).toLocaleString() });
    });
    (project.labor || []).forEach(function (l, i) {
      items.push({ idx: (project.materials || []).length + i + 1, type: '👷', name: l.description,
                   qty: l.hours + ' ' + _t('שעות','ชม.','ساعات'),
                   unitPrice: '₪' + (l.hourlyRate || 0).toLocaleString(),
                   total: '₪' + ((l.hours || 0) * (l.hourlyRate || 0)).toLocaleString() });
    });
    return {
      title: _t('הצעת מחיר','ใบเสนอราคา','عرض سعر'),
      subtitle: project.name + (project.client ? ' · ' + project.client : ''),
      filename: 'quote-' + _safe(project.name),
      meta: { project: project.name, client: project.client || '' },
      columns: [
        { key: 'idx',       label: '#',  width: 30, align: 'center' },
        { key: 'type',      label: '',   width: 25, align: 'center' },
        { key: 'name',      label: _t('פריט','รายการ','بند') },
        { key: 'qty',       label: _t('כמות','ปริมาณ','كمية'),      width: 80, align: 'center' },
        { key: 'unitPrice', label: _t('מחיר יח׳','ราคา/หน่วย','سعر الوحدة'), width: 90, align: 'left' },
        { key: 'total',     label: _t('סה״כ','รวม','المجموع'),       width: 100, align: 'left' }
      ],
      rows: items,
      summary: totals ? [
        { label: _t('חומרים','วัสดุ','مواد'),       value: '₪' + (totals.materialsTotal || 0).toLocaleString() },
        { label: _t('עבודה','แรงงาน','عمالة'),       value: '₪' + (totals.laborTotal     || 0).toLocaleString() },
        { label: _t('לפני מע״מ','ก่อน VAT','قبل الضريبة'), value: '₪' + (totals.beforeVat || 0).toLocaleString() },
        { label: _t('מע״מ','VAT','ضريبة'),           value: '₪' + (totals.vat || 0).toLocaleString() },
        { label: _t('סה״כ לתשלום','รวมที่ต้องชำระ','الإجمالي المستحق'),
          value: '₪' + (totals.total || 0).toLocaleString() }
      ] : []
    };
  };

  adapters.maintenanceShipments = function (project) {
    var rows = (project.shipments || []).map(function (s, i) {
      return { idx: i + 1, date: s.date, material: s.materialName, qty: s.quantity,
               supplier: s.supplier || '—', notes: s.notes || '' };
    });
    return {
      title: _t('יומן משלוחים','บันทึกการจัดส่ง','سجل الشحنات'),
      subtitle: project.name,
      filename: 'shipments-' + _safe(project.name),
      meta: { project: project.name, client: project.client || '' },
      columns: [
        { key: 'idx',      label: '#',                                  width: 35, align: 'center' },
        { key: 'date',     label: _t('תאריך','วันที่','تاريخ'),         width: 90, align: 'center' },
        { key: 'material', label: _t('חומר','วัสดุ','مادة') },
        { key: 'qty',      label: _t('כמות','ปริมาณ','كمية'),          width: 80, align: 'center' },
        { key: 'supplier', label: _t('ספק','ผู้จำหน่าย','مورد'),       width: 120 },
        { key: 'notes',    label: _t('הערות','หมายเหตุ','ملاحظات') }
      ],
      rows: rows,
      summary: [{ label: _t('סה״כ משלוחים','รวมการจัดส่ง','إجمالي الشحنات'), value: rows.length }]
    };
  };

  adapters.maintenanceInvoices = function (project, invTot) {
    var rows = (project.invoices || []).map(function (inv, i) {
      var total = (inv.amount || 0) + (inv.vatAmount || 0);
      return {
        idx: i + 1, invoiceNumber: inv.invoiceNumber || '—',
        category: inv.category || '', supplier: inv.supplier || '—',
        date: inv.date || '', dueDate: inv.dueDate || '',
        amount: '₪' + (inv.amount || 0).toLocaleString(),
        vat: '₪' + (inv.vatAmount || 0).toLocaleString(),
        total: '₪' + total.toLocaleString(),
        status: inv.status || ''
      };
    });
    var summary = invTot ? [
      { label: _t('שולם','ชำระ','مدفوع'),       value: '₪' + (invTot.paid || 0).toLocaleString() },
      { label: _t('ממתין','รอ','معلق'),         value: '₪' + (invTot.pending || 0).toLocaleString() },
      { label: _t('באיחור','เกินกำหนด','متأخر'), value: '₪' + (invTot.overdue || 0).toLocaleString() },
      { label: _t('סה״כ','รวม','إجمالي'),       value: '₪' + (invTot.total || 0).toLocaleString() }
    ] : [];
    return {
      title: _t('דוח חשבוניות','รายงานใบแจ้งหนี้','تقرير الفواتير'),
      subtitle: project.name,
      filename: 'invoices-' + _safe(project.name),
      meta: { project: project.name, client: project.client || '' },
      columns: [
        { key: 'idx',           label: '#',                                width: 30, align: 'center' },
        { key: 'invoiceNumber', label: _t('מס׳','เลขที่','رقم'),          width: 90 },
        { key: 'category',      label: _t('קטגוריה','หมวด','فئة'),         width: 100 },
        { key: 'supplier',      label: _t('ספק','ผู้จำหน่าย','مورد'),     width: 110 },
        { key: 'date',          label: _t('תאריך','วันที่','تاريخ'),       width: 85, align: 'center' },
        { key: 'dueDate',       label: _t('לתשלום','กำหนด','استحقاق'),    width: 85, align: 'center' },
        { key: 'amount',        label: _t('סכום','ยอด','مبلغ'),            width: 85, align: 'left' },
        { key: 'vat',           label: _t('מע״מ','VAT','ضريبة'),           width: 75, align: 'left' },
        { key: 'total',         label: _t('סה״כ','รวม','إجمالي'),          width: 90, align: 'left' },
        { key: 'status',        label: _t('סטטוס','สถานะ','حالة'),         width: 80, align: 'center' }
      ],
      rows: rows,
      summary: summary
    };
  };

  // ═══════════════════════════════════════════════════════════════════════
  //  Public API
  // ═══════════════════════════════════════════════════════════════════════
  return {
    showMenu:   showMenu,
    exportPDF:  exportPDF,
    exportCSV:  exportCSV,
    exportJSON: exportJSON,
    exportXLSX: exportXLSX,
    adapters:   adapters,
    _utils:     { fmtDate: _fmtDate, fmtTime: _fmtTime, fmtDateTime: _fmtDateTime, fmtHours: _fmtHours }
  };
})();
