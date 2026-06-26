// ── FIELD REPORT MODULE ──
// Pest/disease inspection reports with auto-location, PDF export, sharing
// Pest/disease lists are crop-specific and admin-editable

var FieldReport = (function() {
  'use strict';

  var SEVERITY_LEVELS = [
    { value: 0, label: 'נקי', labelTh: 'สะอาด', labelAr: 'نظيف', color: '#4caf50', icon: '✅' },
    { value: 1, label: 'קל', labelTh: 'เล็กน้อย', labelAr: 'خفيف', color: '#8bc34a', icon: '🟢' },
    { value: 2, label: 'בינוני', labelTh: 'ปานกลาง', labelAr: 'متوسط', color: '#ff9800', icon: '🟡' },
    { value: 3, label: 'חמור', labelTh: 'รุนแรง', labelAr: 'شديد', color: '#f44336', icon: '🔴' },
    { value: 4, label: 'קריטי', labelTh: 'วิกฤต', labelAr: 'حرج', color: '#b71c1c', icon: '⚫' }
  ];

  // ── Seed data (defaults for dates) ──
  var SEED_PESTS = [
    { he: 'כנימת מגן', th: 'เพลี้ยหอย', ar: 'حشرة قشرية' },
    { he: 'חיפושית דקל אדומה', th: 'ด้วงปาล์มแดง', ar: 'سوسة النخيل الحمراء' },
    { he: 'תולענית התמר', th: 'หนอนอินทผลัม', ar: 'دودة التمر' },
    { he: 'קרדית האבק', th: 'ไรฝุ่น', ar: 'عنكبوت الغبار' },
    { he: 'עש התמר', th: 'ผีเสื้อกลางคืนอินทผลัม', ar: 'عثة التمر' },
    { he: 'חדקונית הדקל', th: 'เพลี้ยแป้งปาล์ม', ar: 'بق النخيل الدقيقي' },
    { he: 'זבוב הפירות', th: 'แมลงวันผลไม้', ar: 'ذبابة الفاكهة' },
    { he: 'נמלים', th: 'มด', ar: 'نمل' },
    { he: 'עכבישים אדומים', th: 'ไรแดง', ar: 'عناكب حمراء' },
    { he: 'כנימת עלה', th: 'เพลี้ยอ่อน', ar: 'من الأوراق' },
    { he: 'תריפס', th: 'เพลี้ยไฟ', ar: 'تربس' }
  ];
  var SEED_DISEASES = [
    { he: 'ביוד (Bayoud)', th: 'ไบยูด (Bayoud)', ar: 'بيوض (Bayoud)' },
    { he: 'רקב שחור', th: 'โรคเน่าดำ', ar: 'عفن أسود' },
    { he: 'רקב אפור', th: 'โรคเน่าเทา', ar: 'عفن رمادي' },
    { he: 'כתמי עלים', th: 'โรคจุดใบ', ar: 'بقع أوراق' },
    { he: 'הכהיית פרי', th: 'ผลคล้ำ', ar: 'اسمرار الثمر' },
    { he: 'רקב תפרחת', th: 'โรคเน่าช่อดอก', ar: 'عفن النورة' }
  ];

  // ── Crop-specific pest/disease store ──
  // { "cropName": { pests: [{he,th?,ar?},...], diseases: [{he,th?,ar?},...] }, "_default": {...} }
  var pestLists = {};

  function loadPestLists() {
    return new Promise(function(resolve) {
      if (typeof DB !== 'undefined') {
        DB.loadAsync('shorashim-pest-lists').then(function(data) {
          if (data && Object.keys(data).length > 0) {
            pestLists = data;
          } else { seedDefaults(); }
          resolve(pestLists);
        });
      } else {
        var saved = localStorage.getItem('shorashim-pest-lists');
        if (saved) { try { pestLists = JSON.parse(saved); } catch(e) { seedDefaults(); } }
        else { seedDefaults(); }
        resolve(pestLists);
      }
    });
  }

  function savePestLists() {
    if (typeof DB !== 'undefined') DB.save('shorashim-pest-lists', pestLists);
    else localStorage.setItem('shorashim-pest-lists', JSON.stringify(pestLists));
  }

  function seedDefaults() {
    pestLists = {
      '_default': { pests: JSON.parse(JSON.stringify(SEED_PESTS)), diseases: JSON.parse(JSON.stringify(SEED_DISEASES)) }
    };
    savePestLists();
  }

  function getListForCrop(cropType) {
    if (cropType && pestLists[cropType]) return pestLists[cropType];
    return pestLists['_default'] || { pests: SEED_PESTS, diseases: SEED_DISEASES };
  }

  function getCropForPlot(plotId) {
    if (!plotId) return '';
    var ap = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : (typeof plots !== 'undefined' ? plots : []);
    var p = ap.find(function(pl) { return pl.id == plotId; });
    return (p && p.crop_type) ? p.crop_type : '';
  }

  function getAllCropTypes() {
    var crops = {};
    (typeof plots !== 'undefined' ? plots : []).forEach(function(p) { if (p.crop_type) crops[p.crop_type] = true; });
    JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]').forEach(function(c) { crops[c] = true; });
    Object.keys(pestLists).forEach(function(k) { if (k !== '_default') crops[k] = true; });
    return Object.keys(crops).sort();
  }

  // ── Translation helpers ──

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }
  function pestName(p) { return (typeof p === 'string') ? p : tt(p.he, p.th, p.ar); }
  function pestVal(p) { return (typeof p === 'string') ? p : p.he; }

  var LOC_NAMES = {
    'צמרת': { th: 'ยอด', ar: 'قمة' }, 'גזע': { th: 'ลำต้น', ar: 'جذع' },
    'עלים': { th: 'ใบ', ar: 'أوراق' }, 'פרי': { th: 'ผล', ar: 'ثمرة' },
    'שורשים': { th: 'ราก', ar: 'جذور' }, 'תפרחת': { th: 'ช่อดอก', ar: 'نورة' }
  };
  function locName(he) { var e = LOC_NAMES[he]; return e ? tt(he, e.th, e.ar) : he; }
  function translateLocs(csv) { return csv ? csv.split(',').map(function(l) { return locName(l.trim()); }).join(', ') : ''; }

  // ── Auto-detect nearest plot ──

  function getNearestPlot(lat, lng) {
    if (typeof plots === 'undefined' || !plots.length) return null;
    var nearest = null, minDist = Infinity;
    plots.forEach(function(p) {
      if (!p.latlngs || !p.latlngs.length) return;
      var cLat = 0, cLng = 0;
      p.latlngs.forEach(function(c) { cLat += (c.lat !== undefined ? c.lat : c[0]); cLng += (c.lng !== undefined ? c.lng : c[1]); });
      cLat /= p.latlngs.length; cLng /= p.latlngs.length;
      var dist = Math.sqrt(Math.pow(lat - cLat, 2) + Math.pow(lng - cLng, 2));
      if (dist < minDist) { minDist = dist; nearest = p; }
    });
    return nearest;
  }

  // ── Save/Load Reports ──

  function saveReports(reports) { if (typeof DB !== 'undefined') DB.save('shorashim-field-reports', reports); }
  function loadReports() {
    return new Promise(function(resolve) {
      if (typeof DB !== 'undefined') { DB.loadAsync('shorashim-field-reports').then(function(d) { resolve(d || []); }); }
      else { var s = localStorage.getItem('shorashim-field-reports'); resolve(s ? JSON.parse(s) : []); }
    });
  }

  // ── Build pest/disease dropdown HTML ──

  function buildPestOptions(list) {
    var html = '<option value="">' + tt('— בחר —', '— เลือก —', '— اختر —') + '</option>';
    (list || []).forEach(function(p) { html += '<option value="' + pestVal(p) + '">' + pestName(p) + '</option>'; });
    html += '<option value="__other">' + tt('אחר...', 'อื่นๆ...', 'أخرى...') + '</option>';
    return html;
  }

  function _refreshPestDropdowns(cropType) {
    var data = getListForCrop(cropType);
    var pestSel = document.getElementById('frPest');
    var disSel = document.getElementById('frDisease');
    if (pestSel) pestSel.innerHTML = buildPestOptions(data.pests);
    if (disSel) disSel.innerHTML = buildPestOptions(data.diseases);
    // Show crop badge
    var badge = document.getElementById('frCropBadge');
    if (badge) badge.textContent = cropType ? ('🌱 ' + cropType) : '';
  }

  // ── New Report Form ──

  function showNewReport() {
    loadPestLists().then(function() {
      _buildReportForm();
    });
  }

  function _buildReportForm() {
    var modal = document.getElementById('modalContainer');
    var today = new Date().toISOString().slice(0, 10);
    var timeNow = new Date();
    var timeStr = (timeNow.getHours() < 10 ? '0' : '') + timeNow.getHours() + ':' + (timeNow.getMinutes() < 10 ? '0' : '') + timeNow.getMinutes();
    var isAdmin = window.currentUser && (window.currentUser.role === 'admin' || window.currentUser.role === 'operator');

    // Plot options
    var accessiblePlots = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : (typeof plots !== 'undefined' ? plots : []);
    var plotOptions = '<option value="">' + tt('— בחר חלקה —', '— เลือกแปลง —', '— اختر قطعة —') + '</option>';
    accessiblePlots.forEach(function(p) {
      plotOptions += '<option value="' + p.id + '" data-crop="' + (p.crop_type || '') + '">' + p.name + (p.crop_type ? ' (' + p.crop_type + ')' : '') + '</option>';
    });

    // Initial pest/disease options (default list — will be refreshed when plot is selected)
    var initData = getListForCrop('');

    // Severity buttons
    var severityHtml = '';
    SEVERITY_LEVELS.forEach(function(s) {
      var label = tt(s.label, s.labelTh, s.labelAr);
      severityHtml += '<button class="sev-btn" data-sev="' + s.value + '" style="padding:8px 12px;border-radius:8px;border:2px solid ' + s.color + ';background:transparent;color:' + s.color + ';font-family:inherit;font-weight:700;font-size:0.8rem;cursor:pointer;">' + s.icon + ' ' + label + '</button>';
    });

    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:90vh;overflow-y:auto;">' +
        '<h3 style="font-weight:700;margin-bottom:14px;">🔬 ' + tt('דוח סיור שדה', 'รายงานตรวจสนาม', 'تقرير فحص ميداني') + '</h3>' +
        
        '<div style="display:grid;gap:10px;">' +
          // Date + Time
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
            '<div><label style="font-size:0.75rem;color:#666;">' + tt('תאריך', 'วันที่', 'تاريخ') + '</label>' +
            '<input type="date" id="frDate" value="' + today + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.75rem;color:#666;">' + tt('שעה', 'เวลา', 'ساعة') + '</label>' +
            '<input type="time" id="frTime" value="' + timeStr + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '</div>' +
          
          // Inspector
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('סוקר', 'ผู้ตรวจ', 'المفتش') + '</label>' +
          '<input type="text" id="frInspector" value="' + (window.currentUser ? window.currentUser.name : '') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          
          // Plot
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('חלקה', 'แปลง', 'قطعة') + ' <span id="frLocStatus" style="font-size:0.7rem;color:#999;"></span></label>' +
          '<select id="frPlot" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + plotOptions + '</select>' +
          '<div id="frCropBadge" style="font-size:0.72rem;color:#2e7d32;margin-top:2px;font-weight:600;"></div></div>' +
          
          // Pest/Disease header with manage button
          '<div style="display:flex;align-items:center;justify-content:space-between;">' +
            '<label style="font-size:0.75rem;color:#666;">' + tt('מזיק / מחלה', 'ศัตรูพืช / โรค', 'آفة / مرض') + '</label>' +
            (isAdmin ? '<button onclick="FieldReport.showPestListAdmin()" style="border:none;background:none;cursor:pointer;font-size:0.85rem;padding:2px 6px;" title="' + tt('ניהול רשימות', 'จัดการรายการ', 'إدارة القوائم') + '">⚙️</button>' : '') +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
            '<div><label style="font-size:0.7rem;color:#999;">🐛 ' + tt('מזיק', 'ศัตรูพืช', 'آفة') + '</label>' +
            '<select id="frPest" onchange="if(this.value===\'__other\'){this.style.display=\'none\';document.getElementById(\'frPestCustom\').style.display=\'block\';document.getElementById(\'frPestCustom\').focus();}" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + buildPestOptions(initData.pests) + '</select>' +
            '<input id="frPestCustom" placeholder="' + tt('שם המזיק', 'ชื่อศัตรูพืช', 'اسم الآفة') + '" style="display:none;width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.7rem;color:#999;">🦠 ' + tt('מחלה', 'โรค', 'مرض') + '</label>' +
            '<select id="frDisease" onchange="if(this.value===\'__other\'){this.style.display=\'none\';document.getElementById(\'frDiseaseCustom\').style.display=\'block\';document.getElementById(\'frDiseaseCustom\').focus();}" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + buildPestOptions(initData.diseases) + '</select>' +
            '<input id="frDiseaseCustom" placeholder="' + tt('שם המחלה', 'ชื่อโรค', 'اسم المرض') + '" style="display:none;width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '</div>' +
          
          // Severity
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('חומרה', 'ความรุนแรง', 'شدة') + '</label>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;" id="frSeverityBtns">' + severityHtml + '</div>' +
          '<input type="hidden" id="frSeverity" value=""></div>' +
          
          // Affected area
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
            '<div><label style="font-size:0.75rem;color:#666;">' + tt('אחוז נגיעות', 'เปอร์เซ็นต์การระบาด', 'نسبة الإصابة') + '</label>' +
            '<input type="number" id="frPercent" min="0" max="100" placeholder="%" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.75rem;color:#666;">' + tt('עצים נגועים', 'ต้นที่ติดเชื้อ', 'أشجار مصابة') + '</label>' +
            '<input type="number" id="frTrees" min="0" placeholder="" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
          '</div>' +
          
          // Location on tree
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('מיקום בעץ', 'ตำแหน่งบนต้นไม้', 'موقع في الشجرة') + '</label>' +
          '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;">' +
            '<button class="loc-btn" data-loc="צמרת" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.8rem;cursor:pointer;">🌿 ' + tt('צמרת', 'ยอด', 'قمة') + '</button>' +
            '<button class="loc-btn" data-loc="גזע" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.8rem;cursor:pointer;">🪵 ' + tt('גזע', 'ลำต้น', 'جذع') + '</button>' +
            '<button class="loc-btn" data-loc="עלים" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.8rem;cursor:pointer;">🍃 ' + tt('עלים', 'ใบ', 'أوراق') + '</button>' +
            '<button class="loc-btn" data-loc="פרי" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.8rem;cursor:pointer;">🌰 ' + tt('פרי', 'ผล', 'ثمرة') + '</button>' +
            '<button class="loc-btn" data-loc="שורשים" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.8rem;cursor:pointer;">🌱 ' + tt('שורשים', 'ราก', 'جذور') + '</button>' +
            '<button class="loc-btn" data-loc="תפרחת" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:#f5f5f5;font-family:inherit;font-size:0.8rem;cursor:pointer;">🌸 ' + tt('תפרחת', 'ช่อดอก', 'نورة') + '</button>' +
          '</div>' +
          '<input type="hidden" id="frLocations" value=""></div>' +
          
          // Photos
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('תמונות', 'ภาพถ่าย', 'صور') + '</label>' +
          '<div style="display:flex;gap:8px;margin-top:4px;">' +
            '<label style="padding:10px 16px;border-radius:8px;border:2px dashed #aaa;cursor:pointer;font-size:0.85rem;display:flex;align-items:center;gap:6px;">📷 ' + tt('צלם', 'ถ่ายภาพ', 'تصوير') + '<input type="file" accept="image/*" capture="environment" id="frPhoto" multiple onchange="FieldReport._handlePhotos(this.files)" style="display:none;"></label>' +
          '</div>' +
          '<div id="frPhotoPreview" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;"></div></div>' +
          
          // Recommendations
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('המלצות טיפול', 'คำแนะนำการรักษา', 'توصيات العلاج') + '</label>' +
          '<textarea id="frRecommendation" rows="2" placeholder="' + tt('למשל: ריסוס אבמקטין 1.8%, מנה 50 סמ״ק/100 ל׳', 'เช่น: ฉีด Abamectin 1.8%', 'مثال: رش أبامكتين 1.8%') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;resize:vertical;"></textarea></div>' +
          
          // Notes
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('הערות', 'หมายเหตุ', 'ملاحظات') + '</label>' +
          '<textarea id="frNotes" rows="2" placeholder="" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;resize:vertical;"></textarea></div>' +
          
          // Buttons
          '<div style="display:flex;gap:8px;margin-top:4px;">' +
            '<button onclick="FieldReport._saveReport()" style="flex:1;padding:12px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="flex:1;padding:12px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';

    // ── Plot change → refresh pest dropdowns ──
    document.getElementById('frPlot').addEventListener('change', function() {
      var sel = this.options[this.selectedIndex];
      var crop = sel ? (sel.getAttribute('data-crop') || '') : '';
      _refreshPestDropdowns(crop);
    });

    // Severity button handlers
    modal.querySelectorAll('.sev-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        modal.querySelectorAll('.sev-btn').forEach(function(b) { b.style.background = 'transparent'; b.style.color = b.style.borderColor; });
        this.style.background = this.style.borderColor;
        this.style.color = 'white';
        document.getElementById('frSeverity').value = this.getAttribute('data-sev');
      });
    });

    // Location toggle buttons
    var selectedLocs = [];
    modal.querySelectorAll('.loc-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var loc = this.getAttribute('data-loc');
        var idx = selectedLocs.indexOf(loc);
        if (idx === -1) { selectedLocs.push(loc); this.style.background = '#2e7d32'; this.style.color = 'white'; this.style.borderColor = '#2e7d32'; }
        else { selectedLocs.splice(idx, 1); this.style.background = '#f5f5f5'; this.style.color = 'inherit'; this.style.borderColor = '#ddd'; }
        document.getElementById('frLocations').value = selectedLocs.join(',');
      });
    });

    // Auto-detect location and nearest plot
    document.getElementById('frLocStatus').textContent = '📍 ' + tt('מאתר...', 'กำลังค้นหา...', 'جاري تحديد...');
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(pos) {
        var nearest = getNearestPlot(pos.coords.latitude, pos.coords.longitude);
        if (nearest) {
          var plotSel = document.getElementById('frPlot');
          plotSel.value = nearest.id;
          document.getElementById('frLocStatus').textContent = '📍 ' + tt('זוהה: ', 'ตรวจพบ: ', 'تم الكشف: ') + nearest.name;
          document.getElementById('frLocStatus').style.color = '#4caf50';
          // Refresh dropdowns for the detected plot's crop
          _refreshPestDropdowns(nearest.crop_type || '');
        } else {
          document.getElementById('frLocStatus').textContent = '📍 ' + tt('לא זוהתה חלקה קרובה', 'ไม่พบแปลงใกล้เคียง', 'لم يتم الكشف عن قطعة قريبة');
        }
      }, function() { document.getElementById('frLocStatus').textContent = ''; }, { enableHighAccuracy: true, timeout: 10000 });
    }
  }

  // ══════════════════════════════════════════
  // ── PEST LIST ADMIN (crop-specific CRUD) ──
  // ══════════════════════════════════════════

  function showPestListAdmin(preselectedCrop) {
    loadPestLists().then(function() {
      var crops = getAllCropTypes();
      var selectedCrop = preselectedCrop || crops[0] || '_default';

      var cropTabs = '';
      // _default tab
      cropTabs += '<button class="plCropTab' + (selectedCrop === '_default' ? ' active' : '') + '" data-crop="_default" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:' + (selectedCrop === '_default' ? '#2e7d32;color:white;' : '#f5f5f5;') + 'font-family:inherit;font-size:0.78rem;cursor:pointer;font-weight:600;">' + tt('ברירת מחדל', 'ค่าเริ่มต้น', 'افتراضي') + '</button>';
      crops.forEach(function(c) {
        var isActive = c === selectedCrop;
        cropTabs += '<button class="plCropTab' + (isActive ? ' active' : '') + '" data-crop="' + c + '" style="padding:6px 12px;border-radius:8px;border:1px solid #ddd;background:' + (isActive ? '#2e7d32;color:white;' : '#f5f5f5;') + 'font-family:inherit;font-size:0.78rem;cursor:pointer;">🌱 ' + c + '</button>';
      });
      // "Add crop" button
      cropTabs += '<button onclick="FieldReport._addCropList()" style="padding:6px 10px;border-radius:8px;border:2px dashed #aaa;background:transparent;font-family:inherit;font-size:0.78rem;cursor:pointer;color:#999;">➕</button>';

      var data = getListForCrop(selectedCrop);
      var pestsHtml = _renderListItems(data.pests || [], 'pest', selectedCrop);
      var diseasesHtml = _renderListItems(data.diseases || [], 'disease', selectedCrop);

      var copyFromOpts = '<option value="">' + tt('— העתק מגידול —', '— คัดลอกจากพืช —', '— نسخ من محصول —') + '</option>';
      Object.keys(pestLists).forEach(function(k) {
        if (k !== selectedCrop) copyFromOpts += '<option value="' + k + '">' + (k === '_default' ? tt('ברירת מחדל', 'ค่าเริ่มต้น', 'افتراضي') : k) + '</option>';
      });

      var modal = document.getElementById('modalContainer');
      modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:550px;max-height:90vh;overflow-y:auto;">' +
          '<h3 style="font-weight:700;margin-bottom:10px;">⚙️ ' + tt('ניהול מזיקים ומחלות', 'จัดการศัตรูพืชและโรค', 'إدارة الآفات والأمراض') + '</h3>' +
          
          // Crop tabs
          '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;">' + cropTabs + '</div>' +

          // Copy from another crop
          '<div style="margin-bottom:14px;display:flex;gap:6px;align-items:center;">' +
            '<select id="plCopyFrom" style="flex:1;padding:6px 10px;border-radius:8px;border:1px solid #ddd;font-family:inherit;font-size:0.8rem;">' + copyFromOpts + '</select>' +
            '<button onclick="FieldReport._copyFromCrop(\'' + selectedCrop + '\')" style="padding:6px 12px;border-radius:8px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:600;font-size:0.8rem;cursor:pointer;">📋 ' + tt('העתק', 'คัดลอก', 'نسخ') + '</button>' +
          '</div>' +

          // Pests section
          '<div style="margin-bottom:16px;">' +
            '<div style="font-weight:700;font-size:0.85rem;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">🐛 ' + tt('מזיקים', 'ศัตรูพืช', 'آفات') +
            '<button onclick="FieldReport._addItem(\'' + selectedCrop + '\',\'pest\')" style="border:none;background:#4caf50;color:white;border-radius:6px;padding:4px 10px;font-family:inherit;font-size:0.75rem;font-weight:600;cursor:pointer;">➕</button></div>' +
            '<div id="plPestList">' + pestsHtml + '</div>' +
          '</div>' +

          // Diseases section
          '<div style="margin-bottom:16px;">' +
            '<div style="font-weight:700;font-size:0.85rem;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;">🦠 ' + tt('מחלות', 'โรค', 'أمراض') +
            '<button onclick="FieldReport._addItem(\'' + selectedCrop + '\',\'disease\')" style="border:none;background:#4caf50;color:white;border-radius:6px;padding:4px 10px;font-family:inherit;font-size:0.75rem;font-weight:600;cursor:pointer;">➕</button></div>' +
            '<div id="plDiseaseList">' + diseasesHtml + '</div>' +
          '</div>' +

          '<button onclick="FieldReport.showNewReport()" style="width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('חזרה לדוח', 'กลับรายงาน', 'العودة للتقرير') + '</button>' +
        '</div></div>';

      // Crop tab click handlers
      modal.querySelectorAll('.plCropTab').forEach(function(btn) {
        btn.addEventListener('click', function() {
          showPestListAdmin(this.getAttribute('data-crop'));
        });
      });
    });
  }

  function _renderListItems(items, type, crop) {
    if (!items.length) return '<div style="color:#999;font-size:0.8rem;padding:8px;text-align:center;">' + tt('רשימה ריקה', 'รายการว่าง', 'القائمة فارغة') + '</div>';
    var html = '';
    items.forEach(function(item, i) {
      html += '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;padding:6px 8px;background:#f9f9f9;border-radius:8px;">';
      html += '<div style="flex:1;font-size:0.82rem;">';
      html += '<div style="font-weight:600;">' + item.he + '</div>';
      var subs = [];
      if (item.th) subs.push('🇹🇭 ' + item.th);
      if (item.ar) subs.push('🇸🇦 ' + item.ar);
      if (subs.length) html += '<div style="font-size:0.7rem;color:#999;">' + subs.join(' &nbsp; ') + '</div>';
      html += '</div>';
      html += '<button onclick="FieldReport._editItem(\'' + crop + '\',\'' + type + '\',' + i + ')" style="border:none;background:none;cursor:pointer;font-size:0.85rem;" title="' + tt('ערוך', 'แก้ไข', 'تعديل') + '">✏️</button>';
      html += '<button onclick="FieldReport._removeItem(\'' + crop + '\',\'' + type + '\',' + i + ')" style="border:none;background:none;cursor:pointer;font-size:0.85rem;">🗑️</button>';
      html += '</div>';
    });
    return html;
  }

  function _addItem(crop, type) {
    _showItemEditor(crop, type, -1, { he: '', th: '', ar: '' });
  }

  function _editItem(crop, type, index) {
    var data = getListForCrop(crop);
    var list = type === 'pest' ? data.pests : data.diseases;
    if (!list || !list[index]) return;
    _showItemEditor(crop, type, index, list[index]);
  }

  function _showItemEditor(crop, type, index, item) {
    var isNew = index === -1;
    var title = isNew ? tt('הוסף', 'เพิ่ม', 'إضافة') : tt('ערוך', 'แก้ไข', 'تعديل');
    var typeLabel = type === 'pest' ? tt('מזיק', 'ศัตรูพืช', 'آفة') : tt('מחלה', 'โรค', 'مرض');

    var editorHtml = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:999999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:14px;padding:18px;width:90%;max-width:360px;">' +
        '<h4 style="font-weight:700;margin-bottom:10px;">' + title + ' ' + typeLabel + '</h4>' +
        '<div style="display:grid;gap:8px;">' +
          '<div><label style="font-size:0.72rem;color:#666;">🇮🇱 ' + tt('עברית', 'ฮีบรู', 'عبري') + ' *</label>' +
          '<input id="plItemHe" value="' + (item.he || '') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;" placeholder="' + tt('שם בעברית', 'ชื่อภาษาฮีบรู', 'الاسم بالعبرية') + '"></div>' +
          '<div><label style="font-size:0.72rem;color:#666;">🇹🇭 ' + tt('תאילנדית', 'ไทย', 'تايلاندي') + '</label>' +
          '<input id="plItemTh" value="' + (item.th || '') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;" placeholder="' + tt('אופציונלי', 'ไม่บังคับ', 'اختياري') + '"></div>' +
          '<div><label style="font-size:0.72rem;color:#666;">🇸🇦 ' + tt('ערבית', 'อาหรับ', 'عربي') + '</label>' +
          '<input id="plItemAr" value="' + (item.ar || '') + '" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;" placeholder="' + tt('אופציונלי', 'ไม่บังคับ', 'اختياري') + '"></div>' +
          '<div style="display:flex;gap:8px;margin-top:4px;">' +
            '<button id="plItemSave" style="flex:1;padding:10px;border-radius:10px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">💾 ' + tt('שמור', 'บันทึก', 'حفظ') + '</button>' +
            '<button id="plItemCancel" style="flex:1;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('ביטול', 'ยกเลิก', 'إلغاء') + '</button>' +
          '</div>' +
        '</div>' +
      '</div></div>';

    // Append editor overlay
    var editorDiv = document.createElement('div');
    editorDiv.id = 'plItemEditorOverlay';
    editorDiv.innerHTML = editorHtml;
    document.body.appendChild(editorDiv);

    document.getElementById('plItemSave').addEventListener('click', function() {
      var he = document.getElementById('plItemHe').value.trim();
      if (!he) return;
      var newItem = { he: he, th: document.getElementById('plItemTh').value.trim(), ar: document.getElementById('plItemAr').value.trim() };
      
      // Ensure crop entry exists
      if (!pestLists[crop]) pestLists[crop] = { pests: [], diseases: [] };
      var list = type === 'pest' ? pestLists[crop].pests : pestLists[crop].diseases;
      if (isNew) { list.push(newItem); }
      else { list[index] = newItem; }
      savePestLists();

      document.getElementById('plItemEditorOverlay').remove();
      showPestListAdmin(crop);
    });

    document.getElementById('plItemCancel').addEventListener('click', function() {
      document.getElementById('plItemEditorOverlay').remove();
    });
  }

  function _removeItem(crop, type, index) {
    if (!confirm(tt('למחוק?', 'ลบ?', 'حذف؟'))) return;
    if (!pestLists[crop]) return;
    var list = type === 'pest' ? pestLists[crop].pests : pestLists[crop].diseases;
    list.splice(index, 1);
    savePestLists();
    showPestListAdmin(crop);
  }

  function _addCropList() {
    var name = prompt(tt('שם הגידול:', 'ชื่อพืช:', 'اسم المحصول:'));
    if (!name || !name.trim()) return;
    name = name.trim();
    if (!pestLists[name]) {
      pestLists[name] = { pests: [], diseases: [] };
      savePestLists();
    }
    showPestListAdmin(name);
  }

  function _copyFromCrop(targetCrop) {
    var sel = document.getElementById('plCopyFrom');
    var source = sel ? sel.value : '';
    if (!source || !pestLists[source]) return;
    if (!pestLists[targetCrop]) pestLists[targetCrop] = { pests: [], diseases: [] };
    // Deep copy and append
    var srcData = pestLists[source];
    (srcData.pests || []).forEach(function(p) {
      var exists = pestLists[targetCrop].pests.some(function(x) { return x.he === p.he; });
      if (!exists) pestLists[targetCrop].pests.push(JSON.parse(JSON.stringify(p)));
    });
    (srcData.diseases || []).forEach(function(d) {
      var exists = pestLists[targetCrop].diseases.some(function(x) { return x.he === d.he; });
      if (!exists) pestLists[targetCrop].diseases.push(JSON.parse(JSON.stringify(d)));
    });
    savePestLists();
    showPestListAdmin(targetCrop);
    if (typeof showToast === 'function') showToast('📋 ' + tt('הועתק', 'คัดลอกแล้ว', 'تم النسخ'));
  }

  // ── Photo handling ──
  
  var _photos = [];

  function _handlePhotos(files) {
    var preview = document.getElementById('frPhotoPreview');
    Array.from(files).forEach(function(file) {
      var reader = new FileReader();
      reader.onload = function(e) {
        _photos.push({ name: file.name, data: e.target.result });
        preview.innerHTML += '<div style="width:60px;height:60px;border-radius:8px;overflow:hidden;border:1px solid #ddd;"><img src="' + e.target.result + '" style="width:100%;height:100%;object-fit:cover;"></div>';
      };
      reader.readAsDataURL(file);
    });
  }

  // ── Save Report ──

  function _saveReport() {
    var plotSelect = document.getElementById('frPlot');
    var plotId = plotSelect.value ? parseInt(plotSelect.value) : null;
    var plotName = plotSelect.selectedOptions[0] ? plotSelect.selectedOptions[0].textContent : '';
    
    var pest = document.getElementById('frPest').value;
    if (pest === '__other') pest = document.getElementById('frPestCustom').value.trim();
    var disease = document.getElementById('frDisease').value;
    if (disease === '__other') disease = document.getElementById('frDiseaseCustom').value.trim();

    var report = {
      id: Date.now(),
      date: document.getElementById('frDate').value,
      time: document.getElementById('frTime').value,
      inspector: document.getElementById('frInspector').value.trim(),
      plotId: plotId,
      plotName: plotName.trim(),
      cropType: getCropForPlot(plotId),
      pest: pest || '',
      disease: disease || '',
      severity: parseInt(document.getElementById('frSeverity').value) || 0,
      infectionPercent: parseInt(document.getElementById('frPercent').value) || 0,
      affectedTrees: parseInt(document.getElementById('frTrees').value) || 0,
      locations: document.getElementById('frLocations').value,
      recommendation: document.getElementById('frRecommendation').value.trim(),
      notes: document.getElementById('frNotes').value.trim(),
      photos: _photos.map(function(p) { return p.name; }),
      createdBy: window.currentUser ? window.currentUser.username : '',
      createdAt: Date.now()
    };

    if (!report.date || (!report.pest && !report.disease)) {
      if (typeof showToast === 'function') showToast('❌ ' + tt('חובה למלא תאריך ומזיק/מחלה', 'ต้องกรอกวันที่และศัตรูพืช/โรค', 'يجب ملء التاريخ والآفة/المرض'));
      return;
    }

    loadReports().then(function(reports) {
      reports.unshift(report);
      saveReports(reports);
      _photos = [];
      document.getElementById('modalContainer').innerHTML = '';
      if (typeof showToast === 'function') showToast('✅ ' + tt('דוח נשמר', 'บันทึกรายงานแล้ว', 'تم حفظ التقرير'));
    });
  }

  // ── View Reports ──

  function showReportsList() {
    var modal = document.getElementById('modalContainer');
    modal.innerHTML = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:600px;max-height:85vh;overflow-y:auto;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
          '<h3 style="font-weight:700;">🔬 ' + tt('דוחות סיור', 'รายงานตรวจสนาม', 'تقارير الفحص') + '</h3>' +
          '<button onclick="FieldReport.showNewReport()" style="padding:6px 14px;border-radius:8px;border:none;background:#4caf50;color:white;font-family:inherit;font-weight:700;cursor:pointer;">➕</button>' +
        '</div>' +
        '<div id="reportsListContent" style="color:#999;text-align:center;padding:16px;">' + tt('טוען...', 'กำลังโหลด...', 'جاري التحميل...') + '</div>' +
        '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="margin-top:12px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('סגור', 'ปิด', 'إغلاق') + '</button>' +
      '</div></div>';

    loadReports().then(function(reports) {
      var el = document.getElementById('reportsListContent');
      if (reports.length === 0) {
        el.innerHTML = '<div style="padding:24px;text-align:center;color:#999;"><div style="font-size:2rem;margin-bottom:8px;">🔬</div>' + tt('אין דוחות עדיין', 'ยังไม่มีรายงาน', 'لا توجد تقارير بعد') + '</div>';
        return;
      }
      var html = '';
      reports.forEach(function(r) {
        var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];
        html += '<div style="background:var(--g6);border-radius:10px;padding:12px;margin-bottom:8px;border-right:4px solid ' + sev.color + ';cursor:pointer;" onclick="FieldReport.showReportDetail(' + r.id + ')">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<div>';
        html += '<div style="font-weight:700;font-size:0.9rem;">' + (r.pest || r.disease || '—') + '</div>';
        html += '<div style="font-size:0.75rem;color:#666;">' + (r.plotName || '') + (r.cropType ? ' · ' + r.cropType : '') + ' &nbsp; 📅 ' + r.date + '</div>';
        html += '</div>';
        html += '<span style="font-size:1.2rem;">' + sev.icon + '</span>';
        html += '</div></div>';
      });
      el.innerHTML = html;
    });
  }

  // ── Report Detail ──

  function showReportDetail(reportId) {
    loadReports().then(function(reports) {
      var r = reports.find(function(rep) { return rep.id === reportId; });
      if (!r) return;
      var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];
      var sevLabel = tt(sev.label, sev.labelTh, sev.labelAr);
      
      var modal = document.getElementById('modalContainer');
      var html = '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:99999;display:flex;align-items:center;justify-content:center;">' +
        '<div style="background:white;border-radius:16px;padding:20px;width:95%;max-width:500px;max-height:85vh;overflow-y:auto;">' +
          '<h3 style="font-weight:700;margin-bottom:14px;">🔬 ' + tt('דוח סיור', 'รายงานตรวจ', 'تقرير فحص') + '</h3>' +
          '<div style="display:grid;gap:8px;font-size:0.85rem;">' +
            '<div style="display:flex;justify-content:space-between;padding:8px;background:var(--g6);border-radius:8px;">' +
              '<span>📅 ' + r.date + ' ' + (r.time || '') + '</span>' +
              '<span>👤 ' + (r.inspector || '') + '</span>' +
            '</div>' +
            '<div style="padding:8px;background:var(--g6);border-radius:8px;">📍 ' + (r.plotName || tt('לא צוין', 'ไม่ระบุ', 'غير محدد')) + (r.cropType ? ' · 🌱 ' + r.cropType : '') + '</div>' +
            (r.pest ? '<div style="padding:8px;background:#fff3e0;border-radius:8px;">🐛 <strong>' + tt('מזיק', 'ศัตรูพืช', 'آفة') + ':</strong> ' + r.pest + '</div>' : '') +
            (r.disease ? '<div style="padding:8px;background:#fce4ec;border-radius:8px;">🦠 <strong>' + tt('מחלה', 'โรค', 'مرض') + ':</strong> ' + r.disease + '</div>' : '') +
            '<div style="padding:10px;background:' + sev.color + '22;border-radius:8px;border:1px solid ' + sev.color + ';">' +
              '<span style="font-size:1.2rem;">' + sev.icon + '</span> <strong>' + tt('חומרה', 'ความรุนแรง', 'شدة') + ':</strong> ' + sevLabel +
              (r.infectionPercent ? ' — ' + r.infectionPercent + '%' : '') +
              (r.affectedTrees ? ' — ' + r.affectedTrees + ' ' + tt('עצים', 'ต้น', 'أشجار') : '') +
            '</div>' +
            (r.locations ? '<div style="padding:8px;background:var(--g6);border-radius:8px;">📌 ' + tt('מיקום', 'ตำแหน่ง', 'موقع') + ': ' + translateLocs(r.locations) + '</div>' : '') +
            (r.recommendation ? '<div style="padding:8px;background:#e8f5e9;border-radius:8px;">💊 <strong>' + tt('המלצה', 'คำแนะนำ', 'توصية') + ':</strong> ' + r.recommendation + '</div>' : '') +
            (r.notes ? '<div style="padding:8px;background:var(--g6);border-radius:8px;">📝 ' + r.notes + '</div>' : '') +
          '</div>' +
          '<div style="display:flex;gap:8px;margin-top:14px;">' +
            '<button onclick="FieldReport._exportPDF(' + r.id + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#1565c0;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📄 PDF</button>' +
            '<button onclick="FieldReport._shareReport(' + r.id + ')" style="flex:1;padding:10px;border-radius:10px;border:none;background:#7e57c2;color:white;font-family:inherit;font-weight:700;cursor:pointer;">📤 ' + tt('שתף', 'แชร์', 'مشاركة') + '</button>' +
            '<button onclick="FieldReport._deleteReport(' + r.id + ')" style="padding:10px 14px;border-radius:10px;border:none;background:#f44336;color:white;font-family:inherit;font-weight:700;cursor:pointer;">🗑️</button>' +
          '</div>' +
          '<button onclick="FieldReport.showReportsList()" style="margin-top:8px;width:100%;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + tt('חזרה לרשימה', 'กลับรายการ', 'العودة للقائمة') + '</button>' +
        '</div></div>';
      modal.innerHTML = html;
    });
  }

  // ── PDF Export ──

  function _exportPDF(reportId) {
    loadReports().then(function(reports) {
      var r = reports.find(function(rep) { return rep.id === reportId; });
      if (!r) return;
      var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];
      var dir = tt('rtl','ltr','rtl');
      var htmlContent = '<div class="export-print-root" dir="' + dir + '" style="font-family:-apple-system,\'Segoe UI\',Arial,sans-serif;padding:0;margin:0;color:#111;background:#fff;direction:' + dir + ';line-height:1.5;width:194mm;">' +
        '<div class="no-break" style="background:linear-gradient(135deg,#1a5632,#2d6a4f,#40916c);color:#fff;padding:24px 28px 16px;border-radius:0 0 16px 16px;margin-bottom:18px;">' +
          '<h1 style="font-size:1.5rem;font-weight:800;margin:0 0 4px;color:#fff;">🔬 ' + tt('דוח סיור שדה','รายงานตรวจสนาม','تقرير فحص ميداني') + '</h1>' +
          '<div style="font-size:0.85rem;opacity:0.9;margin-top:8px;color:#fff;">📅 ' + r.date + ' ' + (r.time || '') + ' &nbsp; · &nbsp; 👤 ' + (r.inspector || '') + ' &nbsp; · &nbsp; 📍 ' + (r.plotName || '') + (r.cropType ? ' (' + r.cropType + ')' : '') + '</div>' +
        '</div>' +
        '<div style="padding:0 24px;color:#111;background:#fff;">' +
          '<div style="font-size:0.78rem;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 8px;padding-bottom:4px;border-bottom:2px solid #d8f3dc;">' + tt('ממצאים','ผลตรวจ','النتائج') + '</div>' +
          (r.pest ? '<div class="no-break" style="display:flex;margin-bottom:8px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;"><div style="background:#f5f0eb;padding:8px 14px;font-weight:700;font-size:0.82rem;color:#555;min-width:110px;">🐛 ' + tt('מזיק','ศัตรูพืช','آفة') + '</div><div style="background:#fff;padding:8px 14px;flex:1;color:#111;">' + r.pest + '</div></div>' : '') +
          (r.disease ? '<div class="no-break" style="display:flex;margin-bottom:8px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;"><div style="background:#f5f0eb;padding:8px 14px;font-weight:700;font-size:0.82rem;color:#555;min-width:110px;">🦠 ' + tt('מחלה','โรค','مرض') + '</div><div style="background:#fff;padding:8px 14px;flex:1;color:#111;">' + r.disease + '</div></div>' : '') +
          '<div class="no-break" style="display:flex;margin-bottom:8px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;"><div style="background:#f5f0eb;padding:8px 14px;font-weight:700;font-size:0.82rem;color:#555;min-width:110px;">' + tt('חומרה','ความรุนแรง','شدة') + '</div><div style="background:#fff;padding:8px 14px;flex:1;color:#111;"><span style="display:inline-block;padding:5px 14px;border-radius:50px;color:#fff;font-weight:700;font-size:0.85rem;background:' + sev.color + ';">' + sev.icon + ' ' + tt(sev.label, sev.labelTh, sev.labelAr) + '</span>' + (r.infectionPercent ? ' &nbsp; ' + r.infectionPercent + '%' : '') + (r.affectedTrees ? ' &nbsp; ' + r.affectedTrees + ' ' + tt('עצים','ต้น','أشجار') : '') + '</div></div>' +
          (r.locations ? '<div class="no-break" style="display:flex;margin-bottom:8px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;"><div style="background:#f5f0eb;padding:8px 14px;font-weight:700;font-size:0.82rem;color:#555;min-width:110px;">📌 ' + tt('מיקום','ตำแหน่ง','موقع') + '</div><div style="background:#fff;padding:8px 14px;flex:1;color:#111;">' + translateLocs(r.locations) + '</div></div>' : '') +
          (r.recommendation ? '<div style="font-size:0.78rem;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 8px;padding-bottom:4px;border-bottom:2px solid #d8f3dc;">' + tt('המלצות','คำแนะนำ','توصيات') + '</div><div class="no-break" style="display:flex;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;"><div style="background:#f5f0eb;padding:8px 14px;min-width:50px;">💊</div><div style="background:#fff;padding:8px 14px;flex:1;color:#111;">' + r.recommendation + '</div></div>' : '') +
          (r.notes ? '<div style="font-size:0.78rem;font-weight:700;color:#2d6a4f;text-transform:uppercase;letter-spacing:0.05em;margin:18px 0 8px;padding-bottom:4px;border-bottom:2px solid #d8f3dc;">' + tt('הערות','หมายเหตุ','ملاحظات') + '</div><div class="no-break" style="display:flex;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;"><div style="background:#f5f0eb;padding:8px 14px;min-width:50px;">📝</div><div style="background:#fff;padding:8px 14px;flex:1;color:#111;">' + r.notes + '</div></div>' : '') +
        '</div>' +
        '<div style="text-align:center;padding:20px;margin-top:24px;font-size:0.78rem;color:#888;border-top:1px solid #e0e0e0;background:#fff;"><span style="color:#2d6a4f;font-weight:700;">🌿 ' + tt('שורשים פלוס', 'Shorashim Plus', 'شوراشيم بلس') + '</span> · ' + tt('דוח סיור שדה','รายงานตรวจสนาม','تقرير فحص ميداني') + ' · ' + new Date().toLocaleDateString(tt('he-IL','th-TH','ar-SA')) + '</div>' +
        '</div>';

      if (typeof html2pdf === 'undefined') {
        if (typeof showToast === 'function') showToast('❌ html2pdf לא נטען');
        return;
      }
      var container = document.createElement('div');
      container.innerHTML = htmlContent;
      container.style.cssText = 'position:fixed;top:0;left:0;width:210mm;opacity:0;pointer-events:none;z-index:-1;background:#fff;';
      document.body.appendChild(container);

      var fontsReady = (document.fonts && document.fonts.ready) ? document.fonts.ready : Promise.resolve();
      fontsReady.then(function() {
        return new Promise(function(resolve) { requestAnimationFrame(function() { resolve(); }); });
      }).then(function() {
        return html2pdf().set({
          margin: [10, 8, 12, 8],
          filename: 'field-report-' + r.date + '.pdf',
          image: { type: 'jpeg', quality: 0.96 },
          html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
          jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait', compress: true },
          pagebreak: { mode: ['css', 'legacy'], avoid: ['tr', '.no-break'] }
        }).from(container).save();
      }).then(function() {
        if (container.parentNode) container.parentNode.removeChild(container);
        if (typeof showToast === 'function') showToast('📄 ' + tt('דוח הורד', 'ดาวน์โหลดรายงานแล้ว', 'تم تنزيل التقرير'));
      }).catch(function(err) {
        try { if (container.parentNode) container.parentNode.removeChild(container); } catch(e) {}
        console.error('PDF failed:', err);
        if (typeof showToast === 'function') showToast('❌ ' + tt('יצירת PDF נכשלה','สร้าง PDF ล้มเหลว','فشل إنشاء PDF'));
      });
    });
  }

  // Show 4-format export menu for a single report (PDF/Excel/CSV/JSON)
  function _exportReportMenu(reportId, event) {
    if (typeof Export === 'undefined') { _exportPDF(reportId); return; }
    loadReports().then(function(reports) {
      var r = reports.find(function(rep) { return rep.id === reportId; });
      if (!r) return;
      var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];
      var enriched = Object.assign({}, r, {
        severityLabel: tt(sev.label, sev.labelTh, sev.labelAr),
        locationsText: r.locations ? translateLocs(r.locations) : ''
      });
      Export.showMenu(Export.adapters.fieldReportDetail(enriched), event);
    });
  }

  // Show 4-format export menu for ALL reports as a table
  function _exportAllMenu(event) {
    if (typeof Export === 'undefined') return;
    loadReports().then(function(reports) {
      var enriched = reports.map(function(r) {
        var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];
        return Object.assign({}, r, {
          severity: tt(sev.label, sev.labelTh, sev.labelAr),
          locations: r.locations ? translateLocs(r.locations) : ''
        });
      });
      Export.showMenu(Export.adapters.fieldReports(enriched, {
        generatedBy: (typeof currentUser !== 'undefined' && currentUser ? currentUser.name : '') || ''
      }), event);
    });
  }

  // ── Share ──

  function _shareReport(reportId) {
    loadReports().then(function(reports) {
      var r = reports.find(function(rep) { return rep.id === reportId; });
      if (!r) return;
      var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];
      var text = '🔬 ' + tt('דוח סיור שדה', 'รายงานตรวจสนาม', 'تقرير فحص ميداني') + '\n' +
        '📅 ' + r.date + (r.time ? ' ' + r.time : '') + '\n' +
        '👤 ' + (r.inspector || '') + '\n' +
        '📍 ' + (r.plotName || '') + (r.cropType ? ' (' + r.cropType + ')' : '') + '\n' +
        (r.pest ? '🐛 ' + tt('מזיק','ศัตรูพืช','آفة') + ': ' + r.pest + '\n' : '') +
        (r.disease ? '🦠 ' + tt('מחלה','โรค','مرض') + ': ' + r.disease + '\n' : '') +
        sev.icon + ' ' + tt('חומרה','ความรุนแรง','شدة') + ': ' + tt(sev.label, sev.labelTh, sev.labelAr) + (r.infectionPercent ? ' (' + r.infectionPercent + '%)' : '') + '\n' +
        (r.locations ? '📌 ' + tt('מיקום','ตำแหน่ง','موقع') + ': ' + translateLocs(r.locations) + '\n' : '') +
        (r.recommendation ? '💊 ' + tt('המלצה','คำแนะนำ','توصية') + ': ' + r.recommendation + '\n' : '') +
        (r.notes ? '📝 ' + r.notes + '\n' : '') +
        '\n— ' + tt('שורשים פלוס', 'Shorashim Plus', 'شوراشيم بلس');
      if (navigator.share) {
        navigator.share({ title: tt('דוח סיור','รายงานตรวจ','تقرير فحص') + ' - ' + r.date, text: text }).catch(function() {});
      } else {
        navigator.clipboard.writeText(text).then(function() {
          if (typeof showToast === 'function') showToast('📋 ' + tt('הועתק ללוח', 'คัดลอกแล้ว', 'تم النسخ'));
        });
      }
    });
  }

  // ── Delete ──

  function _deleteReport(reportId) {
    if (!confirm(tt('למחוק דוח?', 'ลบรายงาน?', 'حذف التقرير؟'))) return;
    loadReports().then(function(reports) {
      reports = reports.filter(function(r) { return r.id !== reportId; });
      saveReports(reports);
      showReportsList();
      if (typeof showToast === 'function') showToast('🗑️');
    });
  }

  // ── Public API ──
  return {
    showNewReport: showNewReport,
    showReportsList: showReportsList,
    showReportDetail: showReportDetail,
    showPestListAdmin: showPestListAdmin,
    _handlePhotos: _handlePhotos,
    _saveReport: _saveReport,
    _exportPDF: _exportPDF,
    _exportReportMenu: _exportReportMenu,
    _exportAllMenu: _exportAllMenu,
    _shareReport: _shareReport,
    _deleteReport: _deleteReport,
    _addItem: _addItem,
    _editItem: _editItem,
    _removeItem: _removeItem,
    _addCropList: _addCropList,
    _copyFromCrop: _copyFromCrop,
    _refreshPestDropdowns: _refreshPestDropdowns
  };
})();
