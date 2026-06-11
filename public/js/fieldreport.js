// ── FIELD REPORT MODULE ──
// Pest/disease inspection reports with auto-location, PDF export, sharing

var FieldReport = (function() {
  'use strict';

  var SEVERITY_LEVELS = [
    { value: 0, label: 'נקי', labelTh: 'สะอาด', labelAr: 'نظيف', color: '#4caf50', icon: '✅' },
    { value: 1, label: 'קל', labelTh: 'เล็กน้อย', labelAr: 'خفيف', color: '#8bc34a', icon: '🟢' },
    { value: 2, label: 'בינוני', labelTh: 'ปานกลาง', labelAr: 'متوسط', color: '#ff9800', icon: '🟡' },
    { value: 3, label: 'חמור', labelTh: 'รุนแรง', labelAr: 'شديد', color: '#f44336', icon: '🔴' },
    { value: 4, label: 'קריטי', labelTh: 'วิกฤต', labelAr: 'حرج', color: '#b71c1c', icon: '⚫' }
  ];

  var COMMON_PESTS = [
    'כנימת מגן', 'חיפושית דקל אדומה', 'תולענית התמר', 'קרדית האבק',
    'עש התמר', 'חדקונית הדקל', 'זבוב הפירות', 'נמלים', 'עכבישים אדומים',
    'כנימת עלה', 'תריפס', 'אחר'
  ];

  var COMMON_DISEASES = [
    'ביוד (Bayoud)', 'רקב שחור', 'רקב אפור', 'כתמי עלים',
    'הכהיית פרי', 'רקב תפרחת', 'אחר'
  ];

  function tt(he, th, ar) {
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th') return th || he;
    if (lang === 'ar') return ar || he;
    return he;
  }

  // ── Auto-detect nearest plot ──

  function getNearestPlot(lat, lng) {
    if (typeof plots === 'undefined' || !plots.length) return null;
    var nearest = null;
    var minDist = Infinity;
    
    plots.forEach(function(p) {
      if (!p.latlngs || !p.latlngs.length) return;
      // Calculate center of plot
      var cLat = 0, cLng = 0;
      p.latlngs.forEach(function(c) {
        cLat += (c.lat !== undefined ? c.lat : c[0]);
        cLng += (c.lng !== undefined ? c.lng : c[1]);
      });
      cLat /= p.latlngs.length;
      cLng /= p.latlngs.length;
      
      var dist = Math.sqrt(Math.pow(lat - cLat, 2) + Math.pow(lng - cLng, 2));
      if (dist < minDist) {
        minDist = dist;
        nearest = p;
      }
    });
    return nearest;
  }

  // ── Save/Load Reports ──

  function saveReports(reports) {
    if (typeof DB !== 'undefined') DB.save('shorashim-field-reports', reports);
  }

  function loadReports() {
    return new Promise(function(resolve) {
      if (typeof DB !== 'undefined') {
        DB.loadAsync('shorashim-field-reports').then(function(data) {
          resolve(data || []);
        });
      } else {
        var saved = localStorage.getItem('shorashim-field-reports');
        resolve(saved ? JSON.parse(saved) : []);
      }
    });
  }

  // ── New Report Form ──

  function showNewReport() {
    var modal = document.getElementById('modalContainer');
    var today = new Date().toISOString().slice(0, 10);
    var timeNow = new Date();
    var timeStr = (timeNow.getHours() < 10 ? '0' : '') + timeNow.getHours() + ':' + (timeNow.getMinutes() < 10 ? '0' : '') + timeNow.getMinutes();

    // Plot options
    var accessiblePlots = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : (typeof plots !== 'undefined' ? plots : []);
    var plotOptions = '<option value="">' + tt('— בחר חלקה —', '— เลือกแปลง —', '— اختر قطعة —') + '</option>';
    accessiblePlots.forEach(function(p) {
      plotOptions += '<option value="' + p.id + '" data-name="' + p.name + '">' + p.name + (p.crop_type ? ' (' + p.crop_type + ')' : '') + '</option>';
    });

    // Pest options
    var pestOptions = '<option value="">' + tt('— בחר —', '— เลือก —', '— اختر —') + '</option>';
    COMMON_PESTS.forEach(function(p) { pestOptions += '<option value="' + p + '">' + p + '</option>'; });
    pestOptions += '<option value="__other">' + tt('אחר...', 'อื่นๆ...', 'أخرى...') + '</option>';

    var diseaseOptions = '<option value="">' + tt('— בחר —', '— เลือก —', '— اختر —') + '</option>';
    COMMON_DISEASES.forEach(function(d) { diseaseOptions += '<option value="' + d + '">' + d + '</option>'; });
    diseaseOptions += '<option value="__other">' + tt('אחר...', 'อื่นๆ...', 'أخرى...') + '</option>';

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
          
          // Plot (auto-detect)
          '<div><label style="font-size:0.75rem;color:#666;">' + tt('חלקה', 'แปลง', 'قطعة') + ' <span id="frLocStatus" style="font-size:0.7rem;color:#999;"></span></label>' +
          '<select id="frPlot" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + plotOptions + '</select></div>' +
          
          // Pest/Disease type
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">' +
            '<div><label style="font-size:0.75rem;color:#666;">' + tt('מזיק', 'ศัตรูพืช', 'آفة') + '</label>' +
            '<select id="frPest" onchange="if(this.value===\'__other\'){this.style.display=\'none\';document.getElementById(\'frPestCustom\').style.display=\'block\';document.getElementById(\'frPestCustom\').focus();}" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + pestOptions + '</select>' +
            '<input id="frPestCustom" placeholder="' + tt('שם המזיק', 'ชื่อศัตรูพืช', 'اسم الآفة') + '" style="display:none;width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;"></div>' +
            '<div><label style="font-size:0.75rem;color:#666;">' + tt('מחלה', 'โรค', 'مرض') + '</label>' +
            '<select id="frDisease" onchange="if(this.value===\'__other\'){this.style.display=\'none\';document.getElementById(\'frDiseaseCustom\').style.display=\'block\';document.getElementById(\'frDiseaseCustom\').focus();}" style="width:100%;padding:8px;border-radius:8px;border:1px solid #ddd;font-family:inherit;">' + diseaseOptions + '</select>' +
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
        if (idx === -1) {
          selectedLocs.push(loc);
          this.style.background = '#2e7d32';
          this.style.color = 'white';
          this.style.borderColor = '#2e7d32';
        } else {
          selectedLocs.splice(idx, 1);
          this.style.background = '#f5f5f5';
          this.style.color = 'inherit';
          this.style.borderColor = '#ddd';
        }
        document.getElementById('frLocations').value = selectedLocs.join(',');
      });
    });

    // Auto-detect location and nearest plot
    document.getElementById('frLocStatus').textContent = '📍 ' + tt('מאתר...', 'กำลังค้นหา...', 'جاري تحديد...');
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(function(pos) {
        var nearest = getNearestPlot(pos.coords.latitude, pos.coords.longitude);
        if (nearest) {
          document.getElementById('frPlot').value = nearest.id;
          document.getElementById('frLocStatus').textContent = '📍 ' + tt('זוהה: ', 'ตรวจพบ: ', 'تم الكشف: ') + nearest.name;
          document.getElementById('frLocStatus').style.color = '#4caf50';
        } else {
          document.getElementById('frLocStatus').textContent = '📍 ' + tt('לא זוהתה חלקה קרובה', 'ไม่พบแปลงใกล้เคียง', 'لم يتم الكشف عن قطعة قريبة');
        }
      }, function() {
        document.getElementById('frLocStatus').textContent = '';
      }, { enableHighAccuracy: true, timeout: 10000 });
    }
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
        html += '<div style="font-size:0.75rem;color:#666;">' + (r.plotName || '') + ' &nbsp; 📅 ' + r.date + '</div>';
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
            '<div style="padding:8px;background:var(--g6);border-radius:8px;">📍 ' + (r.plotName || tt('לא צוין', 'ไม่ระบุ', 'غير محدد')) + '</div>' +
            
            (r.pest ? '<div style="padding:8px;background:#fff3e0;border-radius:8px;">🐛 <strong>' + tt('מזיק', 'ศัตรูพืช', 'آفة') + ':</strong> ' + r.pest + '</div>' : '') +
            (r.disease ? '<div style="padding:8px;background:#fce4ec;border-radius:8px;">🦠 <strong>' + tt('מחלה', 'โรค', 'مرض') + ':</strong> ' + r.disease + '</div>' : '') +
            
            '<div style="padding:10px;background:' + sev.color + '22;border-radius:8px;border:1px solid ' + sev.color + ';">' +
              '<span style="font-size:1.2rem;">' + sev.icon + '</span> <strong>' + tt('חומרה', 'ความรุนแรง', 'شدة') + ':</strong> ' + sevLabel +
              (r.infectionPercent ? ' — ' + r.infectionPercent + '%' : '') +
              (r.affectedTrees ? ' — ' + r.affectedTrees + ' ' + tt('עצים', 'ต้น', 'أشجار') : '') +
            '</div>' +
            
            (r.locations ? '<div style="padding:8px;background:var(--g6);border-radius:8px;">📌 ' + tt('מיקום', 'ตำแหน่ง', 'موقع') + ': ' + r.locations.split(',').join(', ') + '</div>' : '') +
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

      var htmlContent = '<!DOCTYPE html><html dir="rtl"><head><meta charset="utf-8"><title>דוח סיור - ' + r.date + '</title>' +
        '<style>body{font-family:Arial,sans-serif;padding:30px;max-width:700px;margin:0 auto;direction:rtl;}' +
        'h1{color:#2e7d32;border-bottom:3px solid #2e7d32;padding-bottom:10px;}' +
        'table{width:100%;border-collapse:collapse;margin:16px 0;}' +
        'td,th{padding:8px 12px;border:1px solid #ddd;text-align:right;}' +
        'th{background:#f5f5f5;font-weight:700;width:120px;}' +
        '.severity{display:inline-block;padding:4px 12px;border-radius:6px;color:white;font-weight:700;background:' + sev.color + ';}' +
        '.footer{margin-top:30px;padding-top:10px;border-top:1px solid #ddd;font-size:0.8em;color:#999;}</style></head><body>' +
        '<h1>🔬 דוח סיור שדה</h1>' +
        '<table>' +
          '<tr><th>תאריך</th><td>' + r.date + ' ' + (r.time || '') + '</td></tr>' +
          '<tr><th>סוקר</th><td>' + (r.inspector || '') + '</td></tr>' +
          '<tr><th>חלקה</th><td>' + (r.plotName || '') + '</td></tr>' +
          (r.pest ? '<tr><th>מזיק</th><td>' + r.pest + '</td></tr>' : '') +
          (r.disease ? '<tr><th>מחלה</th><td>' + r.disease + '</td></tr>' : '') +
          '<tr><th>חומרה</th><td><span class="severity">' + sev.icon + ' ' + sev.label + '</span></td></tr>' +
          (r.infectionPercent ? '<tr><th>אחוז נגיעות</th><td>' + r.infectionPercent + '%</td></tr>' : '') +
          (r.affectedTrees ? '<tr><th>עצים נגועים</th><td>' + r.affectedTrees + '</td></tr>' : '') +
          (r.locations ? '<tr><th>מיקום בעץ</th><td>' + r.locations.split(',').join(', ') + '</td></tr>' : '') +
          (r.recommendation ? '<tr><th>המלצות טיפול</th><td>' + r.recommendation + '</td></tr>' : '') +
          (r.notes ? '<tr><th>הערות</th><td>' + r.notes + '</td></tr>' : '') +
        '</table>' +
        '<div class="footer">שורשים פלוס — דוח סיור שדה | נוצר ' + new Date().toLocaleDateString('he-IL') + '</div>' +
        '</body></html>';

      var blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'field-report-' + r.date + '.html';
      a.click();
      URL.revokeObjectURL(url);
      if (typeof showToast === 'function') showToast('📄 ' + tt('דוח הורד', 'ดาวน์โหลดรายงานแล้ว', 'تم تنزيل التقرير'));
    });
  }

  // ── Share ──

  function _shareReport(reportId) {
    loadReports().then(function(reports) {
      var r = reports.find(function(rep) { return rep.id === reportId; });
      if (!r) return;
      var sev = SEVERITY_LEVELS[r.severity] || SEVERITY_LEVELS[0];

      var text = '🔬 דוח סיור שדה\n' +
        '📅 ' + r.date + (r.time ? ' ' + r.time : '') + '\n' +
        '👤 ' + (r.inspector || '') + '\n' +
        '📍 ' + (r.plotName || '') + '\n' +
        (r.pest ? '🐛 מזיק: ' + r.pest + '\n' : '') +
        (r.disease ? '🦠 מחלה: ' + r.disease + '\n' : '') +
        sev.icon + ' חומרה: ' + sev.label + (r.infectionPercent ? ' (' + r.infectionPercent + '%)' : '') + '\n' +
        (r.locations ? '📌 מיקום: ' + r.locations.split(',').join(', ') + '\n' : '') +
        (r.recommendation ? '💊 המלצה: ' + r.recommendation + '\n' : '') +
        (r.notes ? '📝 ' + r.notes + '\n' : '') +
        '\n— שורשים פלוס';

      if (navigator.share) {
        navigator.share({ title: 'דוח סיור - ' + r.date, text: text }).catch(function() {});
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
    _handlePhotos: _handlePhotos,
    _saveReport: _saveReport,
    _exportPDF: _exportPDF,
    _shareReport: _shareReport,
    _deleteReport: _deleteReport
  };
})();
