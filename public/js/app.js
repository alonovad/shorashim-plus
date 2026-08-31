  'use strict';

  // ── Util: shared helpers ──
  // exportReport(html, filename) — universal mobile-friendly export.
  // Opens the report in a new browser tab so the user can use the browser's
  // built-in "Print → Save as PDF" flow (works reliably on iOS/Android/desktop).
  // Falls back to a blob download if popups are blocked.
  window.Util = window.Util || {};
  window.Util.exportReport = function(html, filename) {
    var hebrew = (typeof t === 'function');
    var btnSave  = hebrew ? t('שמור כ-PDF')  : 'Save as PDF';
    var btnDl    = hebrew ? t('הורד HTML')   : 'Download HTML';
    var btnClose = hebrew ? t('סגור')        : 'Close';

    // Inject a no-print toolbar with Save/Print and Download buttons.
    var toolbar =
      '<div class="no-print" id="__print_toolbar" style="position:fixed;top:8px;inset-inline-start:8px;display:flex;gap:8px;z-index:99999;direction:rtl;font-family:-apple-system,Segoe UI,Arial,sans-serif;">' +
        '<button onclick="window.print()" style="padding:11px 18px;background:#2d6a4f;color:#fff;border:none;border-radius:10px;font-weight:800;font-size:0.92rem;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.2);">📄 ' + btnSave + '</button>' +
        '<button onclick="__doDownload()" style="padding:11px 18px;background:#1565c0;color:#fff;border:none;border-radius:10px;font-weight:800;font-size:0.92rem;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.2);">💾 ' + btnDl + '</button>' +
        '<button onclick="window.close()" style="padding:11px 14px;background:#777;color:#fff;border:none;border-radius:10px;font-weight:700;font-size:0.92rem;cursor:pointer;">✕ ' + btnClose + '</button>' +
      '</div>' +
      '<script>function __doDownload(){var b=new Blob([document.documentElement.outerHTML],{type:"text/html;charset=utf-8"});var a=document.createElement("a");a.href=URL.createObjectURL(b);a.download=' + JSON.stringify(filename || 'report.html') + ';document.body.appendChild(a);a.click();setTimeout(function(){document.body.removeChild(a);URL.revokeObjectURL(a.href);},100);}<\/script>' +
      '<style>@media print{.no-print,#__print_toolbar{display:none !important;}}</style>';

    // Place the toolbar right after the opening <body> if present, otherwise prepend to body content.
    var enhanced;
    if (/<body[^>]*>/i.test(html)) {
      enhanced = html.replace(/<body([^>]*)>/i, '<body$1>' + toolbar);
    } else {
      enhanced = toolbar + html;
    }

    var w = null;
    try { w = window.open('', '_blank'); } catch (e) {}
    if (w && w.document) {
      try {
        w.document.open();
        w.document.write(enhanced);
        w.document.close();
        w.focus();
        return;
      } catch (e) { /* fall through to blob fallback */ }
    }

    // Fallback: download as .html (last-resort when popups are blocked)
    var blob = new Blob([enhanced], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || 'report.html';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() {
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    }, 100);
  };

  // localizedName(obj) — returns the language-specific display name for a
  // user-entered entity (plot, farm, worker group, crop, etc.). Picks
  // obj.name_th or obj.name_ar when current language matches and the
  // translation is non-empty, otherwise falls back to obj.name.
  // Safe for any object — returns '' if obj/name is missing.
  window.Util.localizedName = function(obj) {
    if (!obj) return '';
    var lang = (typeof currentLang !== 'undefined') ? currentLang : 'he';
    if (lang === 'th' && obj.name_th) return obj.name_th;
    if (lang === 'ar' && obj.name_ar) return obj.name_ar;
    return obj.name || '';
  };
  // Convenience short alias on window
  window.locName = window.Util.localizedName;

  // ── FIREBASE AUTHENTICATION ──
  var users = {};
  
  // Load user profiles from Firestore
  function loadUsers() {
    try {
      var saved = localStorage.getItem('shorashim-users');
      if (saved) users = JSON.parse(saved);
    } catch(e) {}

    if (typeof DB !== 'undefined') {
      // Login must see the LATEST users list. DB.loadAsync resolves with the
      // cached/localStorage copy first, so a device that attempted login
      // before the admin added the user kept seeing the stale list forever.
      // loadFresh bypasses the cache and reads Firestore directly (guarded
      // for a stale-SW db.js that predates loadFresh).
      var loader = (typeof DB.loadFresh === 'function')
        ? DB.loadFresh('shorashim-users')
        : DB.loadAsync('shorashim-users');
      return loader.then(function(data) {
        if (data && Object.keys(data).length > 0) {
          users = data;
          return users;
        }
        if (Object.keys(users).length > 0) return users;
        return Promise.resolve(users);
      });
    }
    return Promise.resolve(users);
  }

  // Find user profile by email — case-insensitive. Firebase Auth returns
  // the auth email lowercased, but profiles store whatever casing the admin
  // typed in the add-user form; a strict === match locked those users out
  // with "חשבון לא מוגדר במערכת" even though their profile existed.
  function getUserByEmail(email) {
    if (!email) return null;
    var needle = String(email).trim().toLowerCase();
    for (var key in users) {
      if (users[key] && users[key].email &&
          String(users[key].email).trim().toLowerCase() === needle) {
        return users[key];
      }
    }
    return null;
  }

  // Create user profile in Firestore (admin action)
  // Email is normalized to lowercase so it always matches the (lowercased)
  // Firebase Auth email at login. firestore.rules isOwn() lowercases both
  // sides, so lowercase usernames stay compatible with ownership checks.
  function createUserProfile(email, name, role, farmPermissions, lang) {
    email = String(email).trim().toLowerCase();
    var username = email.split('@')[0];
    users[username] = {
      id: Date.now(),
      name: name,
      username: username,
      email: email,
      role: role || 'worker',
      lang: lang || 'he',
      farm_permissions: farmPermissions || [],
      created_at: Date.now()
    };
    DB.save('shorashim-users', users);
    return users[username];
  }

  // ── Deep auth refresh ──
  // Called between Firebase auth success and showing the app. Forces a
  // token refresh so server-side custom-claim changes (set by an admin
  // via the user-management UI, or via Firebase console) are picked up
  // by this session. Does NOT call setUserRole — that function is
  // admin-only by design (see functions/index.js). If a user has no
  // role claim yet, the Firestore rules' noRoleYet() escape hatch
  // handles them until an admin assigns a role.
  //
  // Returns Promise<profile>. Never rejects — token-refresh failures
  // are logged but the user is still allowed into the app.
  function ensureFreshAuth(profile) {
    var fbUser = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
    if (!fbUser || !profile) return Promise.resolve(profile);

    return fbUser.getIdToken(true)        // force refresh — picks up server-side claim changes
      .then(function() {
        return profile;
      })
      .catch(function(err) {
        // Token refresh is a best-effort background sync. The user's existing
        // token is still valid (we only got here because Firebase auth succeeded),
        // so we don't alarm them with a toast — just log for debugging.
        console.warn('Token refresh failed (non-fatal):', err && err.message);
        return profile;
      });
  }

  // Single entry point used by every login flow (auth-state-changed,
  // email/password, Google). Wraps the deep-refresh + the app boot so all
  // four code paths stay in lockstep.
  function enterApp(profile) {
    var errorEl = document.getElementById('loginError');
    if (errorEl) errorEl.textContent = '🔐 ' + (typeof t === 'function' ? t('מסנכרן הרשאות...') : 'Syncing...');
    return ensureFreshAuth(profile).then(function(p) {
      if (errorEl) errorEl.textContent = '';
      showApp(p, null);
      initMapAndData();
      startRealtimeSync();
    });
  }

  // Expose the deep-refresh as a global escape hatch. The profile edit
  // screen and any other UI that wants "re-sync permissions" can call
  // window.__resyncAuth() to force a fresh token + claim verification.
  window.__resyncAuth = function() {
    if (!window.currentUser) return Promise.resolve();
    if (typeof showToast === 'function' && typeof t === 'function') {
      showToast('🔐 ' + t('מסנכרן הרשאות...'));
    }
    return ensureFreshAuth(window.currentUser).then(function() {
      if (typeof showToast === 'function' && typeof t === 'function') {
        showToast('✅ ' + t('הרשאות סונכרנו מחדש'));
      }
    });
  };

  function showApp(user, farm) {
    currentUser = user;
    // Make currentUser available globally
    window.currentUser = user;
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('mainApp').style.display = 'flex';
    
    // Show/hide admin tabs
    var adminTabs = document.querySelectorAll('.admin-only');
    adminTabs.forEach(function(tab) {
      tab.style.display = (user.role === 'admin' || user.role === 'operator') ? 'block' : 'none';
    });
    // Re-evaluate scroll-hint affordance after tab visibility may have changed.
    if (typeof window.__refreshTabScrollHints === 'function') {
      setTimeout(window.__refreshTabScrollHints, 50);
    }

    // Init time clock
    if (typeof TimeClock !== 'undefined') TimeClock.init();

    // Update notification badge
    setTimeout(updateNotificationBadge, 1000);

    // Viewer mode: show only clock dashboard
    if (user.role === 'viewer') {
      document.querySelector('.tab-bar').style.display = 'none';
      document.querySelectorAll('.tab-content').forEach(function(tc) { tc.classList.remove('active'); });
      var viewerPanel = document.getElementById('tabViewerClock');
      if (viewerPanel) {
        viewerPanel.classList.add('active');
        renderViewerDashboard();
      }
    }
    
    sessionStorage.setItem('currentUser', JSON.stringify({
      user_id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
      email: user.email || null,
      farm_permissions: user.farm_permissions,
      login_time: Date.now()
    }));
  }

  function showLoginScreen() {
    document.getElementById('loginScreen').style.display = 'flex';
    setTimeout(function() {
      var emailInput = document.getElementById('loginEmail');
      if (emailInput) emailInput.focus();
    }, 100);
  }

  // ── SINGLE-PATH AUTH ──
  // Every sign-in route (restored session, email/password, Google,
  // first-time registration) converges on ONE onAuthStateChanged
  // listener, registered once at module scope. The listener is the only
  // code that loads the users list, resolves the profile, and boots the
  // app. Button handlers just call the Firebase auth method and surface
  // errors — nothing else.
  //
  // Why: showLoginScreen used to register the listener, AND every click
  // handler ran its own signIn→loadUsers→enterApp chain. Each sign-in
  // was therefore processed twice in parallel: two users-reads, double
  // enterApp/initMapAndData/TimeClock.init, and — whenever one read
  // missed while the other hit (flaky network, fresh device, token not
  // yet attached to the Firestore channel right after account creation)
  // — one path called auth.signOut() and stomped the session the other
  // path had just booted. "Login works sometimes" was that coin flip.
  var _authFlow = null;    // 'login' | 'register' | 'google' | null — which UI initiated the sign-in
  var _handledUid = null;  // uid already booted on this page — dedupe repeat listener fires

  function loginStatus(msg, isError) {
    var el = document.getElementById('loginError');
    if (!el) return;
    el.style.color = isError ? '#ff4757' : '#9ad9a3';
    el.textContent = msg || '';
  }
  function registerStatus(msg, isError) {
    var el = document.getElementById('regError');
    if (!el) { loginStatus(msg, isError); return; }
    el.style.color = isError ? '#ff4757' : '#9ad9a3';
    el.textContent = msg || '';
  }

  // Fresh profile lookup with one retry. The retry covers the window
  // right after account creation where the brand-new auth token may not
  // be attached to the Firestore channel yet (read denied → fallback to
  // an empty local cache on a first-time device), plus admin-write
  // replication lag.
  function resolveProfile(email) {
    return loadUsers().then(function() {
      var p = getUserByEmail(email);
      if (p) return p;
      return new Promise(function(res) { setTimeout(res, 1500); })
        .then(function() { return loadUsers(); })
        .then(function() { return getUserByEmail(email); });
    });
  }

  if (typeof auth !== 'undefined') {
    auth.onAuthStateChanged(function(firebaseUser) {
      if (window.__smsRecoveryActive) return; // temp phone session during SMS recovery
      if (!firebaseUser) { _handledUid = null; return; }
      if (firebaseUser.uid === _handledUid) return; // already booted this session
      _handledUid = firebaseUser.uid;

      var flow = _authFlow;
      _authFlow = null;
      loginStatus('⏳ ' + t('טוען פרופיל...'), false);

      resolveProfile(firebaseUser.email).then(function(profile) {
        if (profile) {
          var ov = document.getElementById('registerOverlay');
          if (ov) ov.style.display = 'none';
          loginStatus('', false);
          return enterApp(profile);
        }
        // Auth account exists but no profile in shorashim-users.
        _handledUid = null;
        if (flow === 'register') {
          // Account was just created but the admin hasn't added this user
          // in the Users tab yet. Keep the Auth account (their password
          // stays valid for later) but sign out of the app.
          registerStatus(t('נרשמת, אך החשבון טרם הוגדר במערכת. פנה למנהל.'), true);
        } else {
          loginStatus(t('חשבון לא מוגדר במערכת. פנה למנהל.'), true);
        }
        auth.signOut().catch(function() {});
      });
    });
  }

  // ── Login button: SIGN-IN ONLY ──
  // No auto-registration here. Firebase reports "wrong password" and
  // "account doesn't exist" with the SAME code (auth/invalid-credential,
  // email-enumeration protection), so registration is a separate,
  // deliberate flow behind the הרשמה link.
  document.getElementById('loginBtn').addEventListener('click', function() {
    var email = document.getElementById('loginEmail').value.trim();
    var password = document.getElementById('loginPassword').value.trim();

    if (!email || !password) {
      loginStatus(t('יש למלא אימייל וסיסמה'), true);
      return;
    }

    loginStatus('⏳ ' + t('מתחבר...'), false);
    _authFlow = 'login';
    auth.signInWithEmailAndPassword(email, password)
      .catch(function(err) {
        _authFlow = null;
        var msg = t('שגיאת התחברות');
        if (err.code === 'auth/user-not-found' ||
            err.code === 'auth/invalid-credential' ||
            err.code === 'auth/wrong-password') {
          // Ambiguous by design (enumeration protection) — cover both cases
          msg = t('אימייל או סיסמה שגויים') + '. ' + t('פעם ראשונה כאן? לחץ על "הרשמה ראשונה"');
        }
        if (err.code === 'auth/invalid-email') msg = t('כתובת אימייל לא תקינה');
        if (err.code === 'auth/too-many-requests') msg = t('יותר מדי נסיונות, נסה מאוחר יותר');
        loginStatus(msg, true);
      });
  });

  // ── First-time registration (popup) ──
  // Registration lives in its own overlay so the default screen is
  // sign-in only — existing users can no longer hit register by accident
  // (shared fields + adjacent buttons caused wrong-button taps and the
  // "האימייל כבר בשימוש" confusion loop). Creates the Firebase Auth
  // account for a user the admin already added in the Users tab; profile
  // resolution then happens in the onAuthStateChanged listener like
  // every other sign-in route.
  function openRegisterOverlay() {
    var ov = document.getElementById('registerOverlay');
    if (!ov) return;
    ov.style.display = 'flex';
    registerStatus('', false);
    var em = document.getElementById('regEmail');
    var le = document.getElementById('loginEmail');
    if (em && le && le.value && !em.value) em.value = le.value;
    setTimeout(function() { if (em) em.focus(); }, 50);
  }
  function closeRegisterOverlay() {
    var ov = document.getElementById('registerOverlay');
    if (ov) ov.style.display = 'none';
  }
  window.closeRegisterOverlay = closeRegisterOverlay;

  var _regOpenLink = document.getElementById('registerOpenLink');
  if (_regOpenLink) _regOpenLink.addEventListener('click', function(e) { e.preventDefault(); openRegisterOverlay(); });
  var _regCloseBtn = document.getElementById('registerCloseBtn');
  if (_regCloseBtn) _regCloseBtn.addEventListener('click', closeRegisterOverlay);

  document.getElementById('registerSubmitBtn').addEventListener('click', function() {
    var email = document.getElementById('regEmail').value.trim();
    var password = document.getElementById('regPassword').value;
    var password2 = document.getElementById('regPassword2').value;

    if (!email || !password) {
      registerStatus(t('יש למלא אימייל וסיסמה'), true);
      return;
    }
    if (password.length < 6) {
      registerStatus(t('הסיסמה חייבת להכיל לפחות 6 תווים'), true);
      return;
    }
    if (password !== password2) {
      registerStatus(t('הסיסמאות אינן תואמות'), true);
      return;
    }

    registerStatus('⏳ ' + t('נרשם...'), false);
    _authFlow = 'register';
    auth.createUserWithEmailAndPassword(email, password)
      .catch(function(err) {
        _authFlow = null;
        var msg = t('שגיאת התחברות');
        if (err.code === 'auth/email-already-in-use') msg = t('כבר נרשמת בעבר — השתמש בכפתור "התחבר"');
        if (err.code === 'auth/weak-password') msg = t('הסיסמה חייבת להכיל לפחות 6 תווים');
        if (err.code === 'auth/invalid-email') msg = t('כתובת אימייל לא תקינה');
        registerStatus(msg, true);
      });
  });

  document.getElementById('loginPassword').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('loginBtn').click();
  });
  var _regPass2El = document.getElementById('regPassword2');
  if (_regPass2El) _regPass2El.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') document.getElementById('registerSubmitBtn').click();
  });

  // Google Sign-In
  document.getElementById('googleLoginBtn').addEventListener('click', function() {
    loginStatus('⏳ ' + t('מתחבר...'), false);
    _authFlow = 'google';
    var provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider)
      .catch(function(err) {
        _authFlow = null;
        if (err.code === 'auth/popup-closed-by-user') {
          loginStatus('', false);
          return;
        }
        loginStatus(t('שגיאה') + ': ' + (err.message || err.code), true);
      });
  });

  // Forgot password
  document.getElementById('forgotPassLink').addEventListener('click', function(e) {
    e.preventDefault();
    var email = document.getElementById('loginEmail').value.trim();
    if (!email) {
      loginStatus(t('הזן אימייל קודם'), true);
      return;
    }
    auth.sendPasswordResetEmail(email).then(function() {
      loginStatus('📧 ' + t('נשלח מייל לאיפוס סיסמה ל-') + email, false);
    }).catch(function(err) {
      loginStatus(err.code === 'auth/user-not-found' ? t('אימייל לא נמצא') : err.message, true);
    });
  });

  // ── SMS credential recovery (שחזור פרטי התחברות ב-SMS) ──
  // Flow: phone → invisible reCAPTCHA → signInWithPhoneNumber (temp phone
  // session, blocked from Firestore by rules) → recoverAccount Cloud
  // Function verifies the phone against the registered user, resets the
  // password, returns the login email, and deletes the temp user.
  var _smsConfirmation = null;
  var _smsVerifier = null;

  function normalizePhoneIL(p) {
    p = (p || '').replace(/[\s\-().]/g, '');
    if (!p) return '';
    if (p.charAt(0) === '+') return p;
    if (p.indexOf('972') === 0) return '+' + p;
    if (p.charAt(0) === '0') return '+972' + p.slice(1);
    return '+972' + p;
  }

  function closeSmsRecovery() {
    window.__smsRecoveryActive = false;
    _smsConfirmation = null;
    if (_smsVerifier) { try { _smsVerifier.clear(); } catch (e) {} _smsVerifier = null; }
    var ov = document.getElementById('smsRecoveryOverlay');
    if (ov) ov.remove();
    // Never leave a temporary phone session signed in
    if (auth.currentUser && auth.currentUser.phoneNumber && !auth.currentUser.email) auth.signOut().catch(function() {});
  }
  window.closeSmsRecovery = closeSmsRecovery;

  function showSmsRecovery() {
    window.__smsRecoveryActive = true;
    var inputStyle = 'width:100%;padding:11px 14px;border:1px solid rgba(255,255,255,0.15);border-radius:10px;background:rgba(255,255,255,0.08);font-family:inherit;font-size:0.95rem;color:#e8ffe8;outline:none;';
    var div = document.createElement('div');
    div.id = 'smsRecoveryOverlay';
    div.innerHTML =
      '<div style="position:fixed;inset:0;background:rgba(0,0,0,0.78);z-index:100001;display:flex;align-items:center;justify-content:center;">' +
      '<div style="background:#12241a;border:1px solid rgba(57,255,20,0.25);border-radius:20px;padding:24px;width:90%;max-width:360px;color:#e8ffe8;">' +
        '<h3 style="font-weight:700;margin-bottom:6px;">🔑 ' + t('שחזור פרטי התחברות') + '</h3>' +
        '<div style="font-size:0.78rem;color:rgba(255,255,255,0.5);margin-bottom:14px;">' + t('הזן את מספר הטלפון הרשום במערכת ונשלח לך קוד ב-SMS') + '</div>' +
        '<div id="smsStep1">' +
          '<input type="tel" id="smsPhone" placeholder="050-1234567" style="' + inputStyle + 'direction:ltr;text-align:left;margin-bottom:10px;">' +
          '<button id="smsSendBtn" onclick="window.__smsSendCode()" style="width:100%;padding:12px;border-radius:10px;border:1.5px solid #39ff14;background:transparent;color:#39ff14;font-family:inherit;font-weight:700;cursor:pointer;">📲 ' + t('שלח קוד') + '</button>' +
        '</div>' +
        '<div id="smsStep2" style="display:none;">' +
          '<input type="text" id="smsCode" placeholder="123456" inputmode="numeric" autocomplete="one-time-code" style="' + inputStyle + 'direction:ltr;text-align:center;letter-spacing:6px;margin-bottom:10px;">' +
          '<input type="password" id="smsNewPass" placeholder="' + t('סיסמה חדשה (לפחות 6 תווים)') + '" style="' + inputStyle + 'margin-bottom:10px;">' +
          '<button onclick="window.__smsConfirmCode()" style="width:100%;padding:12px;border-radius:10px;border:none;background:#39ff14;color:#0a1f12;font-family:inherit;font-weight:800;cursor:pointer;">✅ ' + t('אמת ואפס סיסמה') + '</button>' +
        '</div>' +
        '<div id="smsMsg" style="min-height:20px;font-size:0.82rem;font-weight:600;margin-top:10px;text-align:center;color:#ff6b81;"></div>' +
        '<div id="smsRecaptchaBox"></div>' +
        '<button onclick="window.closeSmsRecovery()" style="width:100%;margin-top:10px;padding:10px;border-radius:10px;border:none;background:rgba(255,255,255,0.08);color:rgba(255,255,255,0.6);font-family:inherit;cursor:pointer;">' + t('סגור') + '</button>' +
      '</div></div>';
    document.body.appendChild(div);
  }

  window.__smsSendCode = function() {
    var msg = document.getElementById('smsMsg');
    var phone = normalizePhoneIL(document.getElementById('smsPhone').value);
    if (!/^\+\d{11,14}$/.test(phone)) { msg.style.color = '#ff6b81'; msg.textContent = t('מספר טלפון לא תקין'); return; }
    msg.style.color = '#9ad9a3';
    msg.textContent = '⏳ ' + t('שולח קוד...');
    try {
      if (!_smsVerifier) _smsVerifier = new firebase.auth.RecaptchaVerifier('smsRecaptchaBox', { size: 'invisible' });
    } catch (e) { msg.style.color = '#ff6b81'; msg.textContent = e.message; return; }
    auth.signInWithPhoneNumber(phone, _smsVerifier)
      .then(function(confirmation) {
        _smsConfirmation = confirmation;
        document.getElementById('smsStep1').style.display = 'none';
        document.getElementById('smsStep2').style.display = 'block';
        msg.textContent = '📲 ' + t('קוד נשלח! הזן אותו יחד עם סיסמה חדשה');
      })
      .catch(function(err) {
        msg.style.color = '#ff6b81';
        if (err.code === 'auth/too-many-requests') msg.textContent = t('יותר מדי נסיונות, נסה מאוחר יותר');
        else if (err.code === 'auth/invalid-phone-number') msg.textContent = t('מספר טלפון לא תקין');
        else msg.textContent = err.message || err.code;
        if (_smsVerifier) { try { _smsVerifier.clear(); } catch (e) {} _smsVerifier = null; }
      });
  };

  window.__smsConfirmCode = function() {
    var msg = document.getElementById('smsMsg');
    var code = document.getElementById('smsCode').value.trim();
    var newPass = document.getElementById('smsNewPass').value;
    if (!code || code.length < 6) { msg.style.color = '#ff6b81'; msg.textContent = t('הזן את הקוד מה-SMS'); return; }
    if (!newPass || newPass.length < 6) { msg.style.color = '#ff6b81'; msg.textContent = t('הסיסמה חייבת להכיל לפחות 6 תווים'); return; }
    if (!_smsConfirmation) return;
    msg.style.color = '#9ad9a3';
    msg.textContent = '⏳ ' + t('מאמת...');
    _smsConfirmation.confirm(code)
      .then(function() {
        var fn = firebase.app().functions('us-central1').httpsCallable('recoverAccount');
        return fn({ newPassword: newPass });
      })
      .then(function(res) {
        var d = (res && res.data) || {};
        auth.signOut().catch(function() {});
        window.__smsRecoveryActive = false;
        var step2 = document.getElementById('smsStep2');
        if (step2) step2.style.display = 'none';
        msg.style.color = '#39ff14';
        msg.innerHTML = '✅ ' + t('שם המשתמש שלך') + ':<br><b style="direction:ltr;display:inline-block;font-size:1rem;">' + (d.email || '') + '</b><br>' + t('הסיסמה עודכנה — אפשר להתחבר');
        var le = document.getElementById('loginEmail');
        if (le) le.value = d.email || '';
        var ef = document.getElementById('emailLoginFields');
        if (ef) ef.style.display = 'block';
      })
      .catch(function(err) {
        msg.style.color = '#ff6b81';
        var c = (err && err.code) || '';
        if (c === 'auth/invalid-verification-code' || c === 'auth/code-expired') msg.textContent = t('קוד שגוי או שפג תוקפו');
        else if (c === 'functions/not-found' || c === 'not-found') msg.textContent = t('הטלפון אינו רשום במערכת. פנה למנהל.');
        else msg.textContent = err.message || c;
        if (auth.currentUser && auth.currentUser.phoneNumber && !auth.currentUser.email) auth.signOut().catch(function() {});
      });
  };

  var _smsLink = document.getElementById('smsRecoveryLink');
  if (_smsLink) _smsLink.addEventListener('click', function(e) { e.preventDefault(); showSmsRecovery(); });

  // ── Constants ──
  var COLORS = ['#2e7d32','#1565c0','#c62828','#6a1b9a','#ef6c00','#00838f','#ad1457','#4e342e'];
  var FARM_COLORS = ['#2e7d32','#1565c0','#c62828','#6a1b9a','#ef6c00','#00838f','#ad1457','#4e342e'];
  var TREES_PER_DUNAM = 12.3;

  // Dose units. A canopy spray is dosed per tree, a herbicide pass per
  // dunam, and fertigation through the irrigation line in cc per tree — the
  // same number means three different things, so the unit travels with the
  // record instead of being assumed to be litres.
  var VOLUME_UNITS = {
    l_tree:  { label: 'ליטר / עץ',   short: 'ליטר/עץ',   perTree: true,  toLitres: 1 },
    cc_tree: { label: 'סמ"ק / עץ',  short: 'סמ"ק/עץ',  perTree: true,  toLitres: 0.001 },
    l_dunam: { label: 'ליטר / דונם', short: 'ליטר/דונם', perTree: false, toLitres: 1 }
  };
  function unitOf(u) { return VOLUME_UNITS[u] || VOLUME_UNITS.l_tree; }
  function unitShort(u) { return unitOf(u).short; }

  var SPRAY_PURPOSES = {
    pest:      'הדברת מזיקים ומחלות',
    weeds:     'ריסוס עשבייה',
    preemerge: 'מניעת הצצה'
  };
  function purposeLabel(p) { return SPRAY_PURPOSES[p] || SPRAY_PURPOSES.pest; }

  // Total litres in the tank for a given dose, unit, area and tree count.
  function doseToLitres(dose, unitKey, area) {
    var u = unitOf(unitKey);
    var qty = u.perTree ? (Math.round(area * TREES_PER_DUNAM) * dose) : (area * dose);
    return qty * u.toLitres;
  }

  // Permission helpers
  function isAdmin() {
    return currentUser && currentUser.role === 'admin';
  }
  function isManager() {
    return currentUser && (currentUser.role === 'admin' || currentUser.role === 'operator');
  }
  var colorIdx = 0;

  // ── State ──
  var plots = [];
  var sprayEvents = [];
  var _showVoided = false;   // history: voided records hidden by default
  var pesticides = [];
  var farms = [];
  var worklogEntries = [];
  var currentUser = null;
  var undoStack = [];
  var isSatellite = true;
  var activeTab = 'map';

  // ══════════════════════════════════
  // ── TRANSLATION SYSTEM ──
  // ══════════════════════════════════

  var LANGUAGES = ['he', 'th', 'ar'];
  var LANG_LABELS = { he: 'עב', th: 'ไทย', ar: 'عر' };
  // Detect browser language for first-time users
  function detectBrowserLang() {
    var saved = localStorage.getItem('shorashim-lang');
    if (saved) return saved;
    var browserLang = (navigator.language || navigator.userLanguage || 'he').toLowerCase();
    if (browserLang.indexOf('th') === 0) return 'th';
    if (browserLang.indexOf('ar') === 0) return 'ar';
    return 'he';
  }
  var currentLang = detectBrowserLang();

  var TRANSLATIONS = {
    // ── Tab bar ──
    'מפה': { th: 'แผนที่', ar: 'خريطة' },
    'ריסוס': { th: 'พ่นยา', ar: 'رش' },
    'יומן': { th: 'บันทึก', ar: 'سجل' },
    'היסטוריה': { th: 'ประวัติ', ar: 'تاريخ' },
    'אישי': { th: 'โปรไฟล์', ar: 'شخصي' },
    'מטעים': { th: 'สวน', ar: 'بساتين' },
    'משתמשים': { th: 'ผู้ใช้', ar: 'مستخدمين' },
    'חומרים': { th: 'สารเคมี', ar: 'مواد' },
    
    // ── Header ──
    'שורשים פלוס': { th: 'ชอราชิม พลัส', ar: 'شوراشيم بلس' },
    'פלטפורמה לניהול חקלאי': { th: 'แพลตฟอร์มจัดการเกษตร', ar: 'منصة إدارة زراعية' },
    
    // ── Map ──
    'חלקות מסומנות': { th: 'แปลงที่ทำเครื่องหมาย', ar: 'قطع محددة' },
    'לחץ לפרטי חלקה →': { th: 'กดดูรายละเอียด →', ar: 'اضغط للتفاصيل →' },
    'נקודות': { th: 'จุด', ar: 'نقاط' },
    'לוויין': { th: 'ดาวเทียม', ar: 'قمر صناعي' },
    'רחוב': { th: 'ถนน', ar: 'شارع' },
    'פוליגון חופשי': { th: 'วาดอิสระ', ar: 'مضلع حر' },
    'סימון נקודה-נקודה': { th: 'วางจุดทีละจุด', ar: 'نقطة بنقطة' },
    'מלבן': { th: 'สี่เหลี่ยม', ar: 'مستطيل' },
    'לחץ שתי פינות נגדיות': { th: 'กดสองมุมตรงข้าม', ar: 'اضغط زاويتين' },
    
    // ── Spray ──
    'פרטי ריסוס': { th: 'รายละเอียดการพ่น', ar: 'تفاصيل الرش' },
    'תאריך': { th: 'วันที่', ar: 'تاريخ' },
    'שם המפעיל': { th: 'ชื่อผู้ปฏิบัติงาน', ar: 'اسم المشغل' },
    'בחירת חלקות': { th: 'เลือกแปลง', ar: 'اختيار قطع' },
    'הגדרות נפח': { th: 'ตั้งค่าปริมาตร', ar: 'إعدادات الحجم' },
    'נפח לעץ (ליטר)': { th: 'ปริมาตรต่อต้น (ลิตร)', ar: 'حجم لكل شجرة (لتر)' },
    'קיבולת מרסס (ליטר)': { th: 'ความจุเครื่องพ่น (ลิตร)', ar: 'سعة الرشاش (لتر)' },
    'בחירת חומרי הדברה': { th: 'เลือกสารเคมี', ar: 'اختيار مبيدات' },
    'שמור יומן ריסוס': { th: 'บันทึกการพ่น', ar: 'حفظ سجل الرش' },
    
    // ── Worklog ──
    'יומן עבודה': { th: 'บันทึกงาน', ar: 'سجل العمل' },
    'בחר מטע': { th: 'เลือกสวน', ar: 'اختر بستان' },
    '— בחר מטע —': { th: '— เลือกสวน —', ar: '— اختر بستان —' },
    'רשומה חדשה': { th: 'บันทึกใหม่', ar: 'سجل جديد' },
    'סוג עבודה': { th: 'ประเภทงาน', ar: 'نوع العمل' },
    'תיאור / פירוט': { th: 'รายละเอียด', ar: 'وصف / تفاصيل' },
    'שעות עבודה (אופציונלי)': { th: 'ชั่วโมง (ไม่บังคับ)', ar: 'ساعات عمل (اختياري)' },
    'עובדים (אופציונלי)': { th: 'คนงาน (ไม่บังคับ)', ar: 'عمال (اختياري)' },
    'הערות': { th: 'หมายเหตุ', ar: 'ملاحظات' },
    'שמור מקומית': { th: 'บันทึกในเครื่อง', ar: 'حفظ محلي' },
    'שמור ושלח ל-Google Sheet': { th: 'บันทึกและส่ง Google Sheet', ar: 'حفظ وإرسال لـ Google Sheet' },
    'נתוני גיליון': { th: 'ข้อมูลชีต', ar: 'بيانات الجدول' },
    'רשומות אחרונות (מקומי)': { th: 'บันทึกล่าสุด (ในเครื่อง)', ar: 'سجلات أخيرة (محلي)' },
    'אין רשומות': { th: 'ไม่มีบันทึก', ar: 'لا توجد سجلات' },
    
    // ── Work types ──
    '💧 השקייה': { th: '💧 ให้น้ำ', ar: '💧 ري' },
    '🧪 ריסוס': { th: '🧪 พ่นยา', ar: '🧪 رش' },
    '🌱 דישון': { th: '🌱 ใส่ปุ๋ย', ar: '🌱 تسميد' },
    '✂️ גיזום': { th: '✂️ ตัดแต่ง', ar: '✂️ تقليم' },
    '🧺 קטיף': { th: '🧺 เก็บเกี่ยว', ar: '🧺 قطف' },
    '🔧 תחזוקה': { th: '🔧 ซ่อมบำรุง', ar: '🔧 صيانة' },
    '📌 אחר': { th: '📌 อื่นๆ', ar: '📌 أخرى' },
    
    // ── Profile ──
    'חלקה ראשית (תצוגת פתיחה)': { th: 'แปลงหลัก (หน้าจอเริ่มต้น)', ar: 'قطعة رئيسية (عرض افتتاحي)' },
    'המפה תיפתח בזום על החלקה שתבחר': { th: 'แผนที่จะซูมไปที่แปลงที่เลือก', ar: 'ستفتح الخريطة مقربة على القطعة المختارة' },
    'ללא — הצג את כל החלקות': { th: 'ไม่มี — แสดงทุกแปลง', ar: 'بدون — عرض جميع القطع' },
    'המטעים שלי': { th: 'สวนของฉัน', ar: 'بساتيني' },
    'חשבון Google': { th: 'บัญชี Google', ar: 'حساب Google' },
    'נדרש לחיבור עם Google Sheets ליומן העבודה': { th: 'จำเป็นสำหรับเชื่อมต่อ Google Sheets', ar: 'مطلوب للاتصال بـ Google Sheets' },
    'שמור אימייל': { th: 'บันทึกอีเมล', ar: 'حفظ البريد' },
    'התנתק': { th: 'ออกจากระบบ', ar: 'تسجيل خروج' },
    
    // ── General ──
    'שמור': { th: 'บันทึก', ar: 'حفظ' },
    'ביטול': { th: 'ยกเลิก', ar: 'إلغاء' },
    'סגור': { th: 'ปิด', ar: 'إغلاق' },
    'חלקות': { th: 'แปลง', ar: 'قطع' },
    'שטח': { th: 'พื้นที่', ar: 'مساحة' },
    'שטח כולל': { th: 'พื้นที่รวม', ar: 'المساحة الإجمالية' },
    'דונם': { th: 'ดูนัม', ar: 'دونم' },
    "ד'": { th: 'ดูนัม', ar: 'دونم' },
    "שטח (ד')": { th: 'พื้นที่ (ดูนัม)', ar: 'مساحة (د)' },
    'השקייה': { th: 'ให้น้ำ', ar: 'ري' },
    'קוב לדונם/פתיחה': { th: 'ลบ.ม./ดูนัม', ar: 'كوب/دونم' },
    'ימי השקייה בשבוע': { th: 'วันให้น้ำต่อสัปดาห์', ar: 'أيام ري بالأسبوع' },
    'מלאי חומרי הדברה': { th: 'สต็อกสารเคมี', ar: 'مخزون المبيدات' },
    'תעודות משלוח אחרונות': { th: 'ใบส่งสินค้าล่าสุด', ar: 'وصولات توريد أخيرة' },
    'היסטוריית ריסוס': { th: 'ประวัติการพ่น', ar: 'تاريخ الرش' },
    'נווט לחלקה במפה': { th: 'ไปที่แปลงในแผนที่', ar: 'انتقل للقطعة في الخريطة' },
    'הגדר כחלקה ראשית': { th: 'ตั้งเป็นแปลงหลัก', ar: 'تعيين كقطعة رئيسية' },
    'חלקה ראשית — לחץ לביטול': { th: 'แปลงหลัก — กดยกเลิก', ar: 'قطعة رئيسية — اضغط لإلغاء' },
    'מנהל': { th: 'ผู้จัดการ', ar: 'مدير' },
    'מפעיל': { th: 'ผู้ปฏิบัติงาน', ar: 'مشغل' },
    'צופה': { th: 'ผู้ชม', ar: 'مشاهد' },
    'ייצא PDF': { th: 'ส่งออก PDF', ar: 'تصدير PDF' },
    'מיקום זוהה': { th: 'พบตำแหน่ง', ar: 'تم تحديد الموقع' },
    'שעות': { th: 'ชั่วโมง', ar: 'ساعات' },
    'שייך למטע': { th: 'ย้ายไปสวน', ar: 'ربط ببستان' },
    'ללא מטע': { th: 'ไม่มีสวน', ar: 'بدون بستان' },
    'אין היסטוריית ריסוס': { th: 'ไม่มีประวัติการพ่น', ar: 'لا يوجد تاريخ رش' },
    'עדיין אין חלקות מסומנות': { th: 'ยังไม่มีแปลงที่ทำเครื่องหมาย', ar: 'لا توجد قطع محددة بعد' },
    'לחץ על ➕ כדי להתחיל': { th: 'กด ➕ เพื่อเริ่ม', ar: 'اضغط ➕ للبدء' },
    'אין חלקות זמינות': { th: 'ไม่มีแปลงที่ใช้ได้', ar: 'لا توجد قطع متاحة' },
    'הוסף חלקות בלשונית המפה': { th: 'เพิ่มแปลงในแท็บแผนที่', ar: 'أضف قطع في تبويب الخريطة' },
    'אין חומרי הדברה': { th: 'ไม่มีสารเคมี', ar: 'لا توجد مبيدات' },
    'הוסף בלשונית הניהול': { th: 'เพิ่มในแท็บจัดการ', ar: 'أضف في تبويب الإدارة' },
    'ריכוז': { th: 'ความเข้มข้น', ar: 'تركيز' },
    'חומר פעיל': { th: 'สารออกฤทธิ์', ar: 'مادة فعالة' },
    'יעדים': { th: 'เป้าหมาย', ar: 'أهداف' },
    'אין מטעים זמינים': { th: 'ไม่มีสวนที่ใช้ได้', ar: 'لا توجد بساتين متاحة' },
    'חלקה חדשה': { th: 'แปลงใหม่', ar: 'قطعة جديدة' },
    'תן שם לחלקה שסימנת': { th: 'ตั้งชื่อแปลงที่ทำเครื่องหมาย', ar: 'أعط اسمًا للقطعة المحددة' },
    'שם החלקה': { th: 'ชื่อแปลง', ar: 'اسم القطعة' },
    'מטע': { th: 'สวน', ar: 'بستان' },
    'אין היסטוריה': { th: 'ไม่มีประวัติ', ar: 'لا يوجد تاريخ' },
    'חלקות': { th: 'แปลง', ar: 'قطع' },
    'חומרים': { th: 'สารเคมี', ar: 'مواد' },
    'ספק': { th: 'ซัพพลายเออร์', ar: 'مورد' },
    'תיאור': { th: 'รายละเอียด', ar: 'وصف' },
    'כמות': { th: 'ปริมาณ', ar: 'كمية' },
    'אין מטעים משויכים': { th: 'ไม่มีสวนที่ผูกไว้', ar: 'لا توجد بساتين مرتبطة' },
    'אין תעודות משלוח': { th: 'ไม่มีใบส่งสินค้า', ar: 'لا توجد وصولات توريد' },
    'לא הוגדר מלאי': { th: 'ยังไม่กำหนดสต็อก', ar: 'لم يتم تحديد مخزون' },
    'לא הוגדר': { th: 'ยังไม่กำหนด', ar: 'لم يحدد' },
    'עדכון אחרון': { th: 'อัปเดตล่าสุด', ar: 'آخر تحديث' },
    'עדכן השקייה': { th: 'อัปเดตการให้น้ำ', ar: 'تحديث الري' },
    'הוסף ת. משלוח': { th: 'เพิ่มใบส่งสินค้า', ar: 'إضافة وصل توريد' },
    'עדכן מלאי חומרים': { th: 'อัปเดตสต็อกสารเคมี', ar: 'تحديث مخزون المبيدات' },
    'רענן': { th: 'รีเฟรช', ar: 'تحديث' },
    'טוען נתונים מהגיליון': { th: 'กำลังโหลดข้อมูลจากชีต', ar: 'جاري تحميل البيانات' },
    'אין נתונים בגיליון': { th: 'ไม่มีข้อมูลในชีต', ar: 'لا توجد بيانات في الجدول' },
    'מחובר': { th: 'เชื่อมต่อแล้ว', ar: 'متصل' },
    'לא הוגדר אימייל': { th: 'ยังไม่กำหนดอีเมล', ar: 'لم يتم تحديد بريد' },
    'יש להגדיר אימייל בטאב האישי': { th: 'ต้องตั้งอีเมลในโปรไฟล์', ar: 'يجب تحديد البريد في الملف الشخصي' },
    'שורות בגיליון': { th: 'แถวในชีต', ar: 'صفوف في الجدول' },
    'מציג 30 אחרונות': { th: 'แสดง 30 รายการล่าสุด', ar: 'عرض آخر 30' },
    'לחץ על המפה לסימון נקודות': { th: 'กดบนแผนที่เพื่อวางจุด', ar: 'اضغط على الخريطة لتحديد نقاط' },
    'לחץ על נקודת התחלה': { th: 'กดจุดเริ่มต้น', ar: 'اضغط نقطة البداية' },
    'לחץ על הנקודה הראשונה לסגירה': { th: 'กดจุดแรกเพื่อปิด', ar: 'اضغط النقطة الأولى للإغلاق' },
    'לחץ להמשך סימון': { th: 'กดเพื่อวางจุดต่อ', ar: 'اضغط لمتابعة التحديد' },
    'חובה למלא תיאור': { th: 'ต้องกรอกรายละเอียด', ar: 'يجب ملء الوصف' },
    'חובה לבחור מטע': { th: 'ต้องเลือกสวน', ar: 'يجب اختيار بستان' },
    'יש לבחור מטע': { th: 'เลือกสวน', ar: 'اختر بستان' },
    'יש לבחור תאריך': { th: 'เลือกวันที่', ar: 'اختر تاريخ' },
    'יש למלא תיאור': { th: 'กรอกรายละเอียด', ar: 'املأ الوصف' },
    'רשומה נשמרה מקומית': { th: 'บันทึกในเครื่องแล้ว', ar: 'تم الحفظ محليًا' },
    'נשלח ל-Google Sheet': { th: 'ส่งไปยัง Google Sheet แล้ว', ar: 'تم الإرسال إلى Google Sheet' },
    'שליחה נכשלה — נשמר מקומית': { th: 'ส่งไม่สำเร็จ — บันทึกในเครื่อง', ar: 'فشل الإرسال — تم الحفظ محليًا' },
    'שגיאת רשת — נשמר מקומית': { th: 'เครือข่ายผิดพลาด — บันทึกในเครื่อง', ar: 'خطأ شبكة — تم الحفظ محليًا' },
    'שולח': { th: 'กำลังส่ง', ar: 'جاري الإرسال' },
    'מרענן': { th: 'กำลังรีเฟรช', ar: 'جاري التحديث' },
    'שגיאה בטעינת נתונים': { th: 'เกิดข้อผิดพลาดในการโหลด', ar: 'خطأ في تحميل البيانات' },
    'אימייל נשמר': { th: 'บันทึกอีเมลแล้ว', ar: 'تم حفظ البريد' },
    'אימייל הוסר': { th: 'ลบอีเมลแล้ว', ar: 'تم حذف البريد' },
    'חלקה ראשית עודכנה': { th: 'อัปเดตแปลงหลักแล้ว', ar: 'تم تحديث القطعة الرئيسية' },
    'כתובת אימייל לא תקינה': { th: 'อีเมลไม่ถูกต้อง', ar: 'عنوان بريد غير صالح' },
    'להתנתק מהמערכת?': { th: 'ออกจากระบบ?', ar: 'تسجيل الخروج؟' },
    'הוגדרה כחלקה ראשית': { th: 'ตั้งเป็นแปลงหลักแล้ว', ar: 'تم التعيين كقطعة رئيسية' },
    'חלקה ראשית בוטלה': { th: 'ยกเลิกแปลงหลักแล้ว', ar: 'تم إلغاء القطعة الرئيسية' },
    'שויכה ל-': { th: 'ย้ายไปยัง ', ar: 'تم ربطها بـ ' },
    'הדפדפן לא תומך באיתור מיקום': { th: 'เบราว์เซอร์ไม่รองรับ GPS', ar: 'المتصفح لا يدعم تحديد الموقع' },
    'גישה למיקום נדחתה — יש לאשר בהגדרות': { th: 'ปฏิเสธสิทธิ์ — อนุญาตในตั้งค่า', ar: 'تم رفض الوصول — اسمح في الإعدادات' },
    'מיקום לא זמין': { th: 'ตำแหน่งไม่พร้อม', ar: 'الموقع غير متوفر' },
    'תם הזמן לאיתור מיקום': { th: 'หมดเวลา GPS', ar: 'انتهى وقت تحديد الموقع' },
    'חובה לבחור מטע': { th: 'ต้องเลือกสวน', ar: 'يجب اختيار بستان' },
    'תן שם לחלקה שסימנת': { th: 'ตั้งชื่อแปลงที่วาด', ar: 'أعط اسمًا للقطعة' },
    'מספר עובדים': { th: 'จำนวนคนงาน', ar: 'عدد العمال' },
    'שעות עבודה': { th: 'ชั่วโมงงาน', ar: 'ساعات عمل' },
    'חלקה': { th: 'แปลง', ar: 'قطعة' },
    'כל החלקות': { th: 'ทุกแปลง', ar: 'جميع القطع' },
    'סיכום הספק': { th: 'สรุปผลงาน', ar: 'ملخص الإنتاجية' },
    'סוג עבודה': { th: 'ประเภทงาน', ar: 'نوع العمل' },
    'לפי עובד': { th: 'ตามคนงาน', ar: 'حسب العامل' },
    'לפי חלקה': { th: 'ตามแปลง', ar: 'حسب القطعة' },
    'שעות עבודה כולל': { th: 'ชั่วโมงงานรวม', ar: 'إجمالي ساعات العمل' },
    'עובדים': { th: 'คนงาน', ar: 'عمال' },
    'רשומות': { th: 'รายการ', ar: 'سجلات' },
    'עצים': { th: 'ต้น', ar: 'أشجار' },
    'עצים שטופלו': { th: 'ต้นไม้ที่ดูแลแล้ว', ar: 'أشجار تمت معالجتها' },
    'עצים/שעה': { th: 'ต้น/ชม.', ar: 'شجرة/ساعة' },
    'עצים/עובד': { th: 'ต้น/คน', ar: 'شجرة/عامل' },
    'עצים/עובד×שעה': { th: 'ต้น/คน×ชม.', ar: 'شجرة/عامل×ساعة' },
    'הספק מחושב': { th: 'ผลิตภาพที่คำนวณ', ar: 'إنتاجية محسوبة' },
    'הגדרות Google Sheets': { th: 'ตั้งค่า Google Sheets', ar: 'إعدادات Google Sheets' },
    'כתובת Apps Script': { th: 'URL ของ Apps Script', ar: 'عنوان Apps Script' },
    'הכתובת מתקבלת אחרי פריסת הסקריפט': { th: 'ได้ URL หลัง Deploy สคริปต์', ar: 'العنوان يتم الحصول عليه بعد نشر السكريبت' },
    'מזהה גיליון לכל מטע': { th: 'Sheet ID ต่อสวน', ar: 'معرّف الجدول لكل بستان' },
    'המזהה נמצא בכתובת URL של הגיליון': { th: 'ID อยู่ใน URL ของชีต ระหว่าง /d/ กับ /edit', ar: 'المعرّف موجود في عنوان URL بين /d/ و /edit' },
    'צלם תעודת משלוח': { th: 'ถ่ายใบส่งสินค้า', ar: 'تصوير وصل توريد' },
    'חשבונית או תעודה': { th: 'ใบเสร็จหรือเอกสาร', ar: 'فاتورة أو وثيقة' },
    'רשומת יומן מהירה': { th: 'บันทึกงานด่วน', ar: 'سجل عمل سريع' },
    'דיווח עבודה': { th: 'รายงานงาน', ar: 'تقرير عمل' },
    'צלם': { th: 'ถ่ายรูป', ar: 'تصوير' },
    'גלריה': { th: 'แกลเลอรี', ar: 'معرض' },
    'יש לצלם תמונה': { th: 'ต้องถ่ายรูป', ar: 'يجب التقاط صورة' },
    'תעודה נשמרה': { th: 'บันทึกเอกสารแล้ว', ar: 'تم حفظ الوثيقة' },
    'תעודה נמחקה': { th: 'ลบเอกสารแล้ว', ar: 'تم حذف الوثيقة' },
    'אין תעודות': { th: 'ไม่มีเอกสาร', ar: 'لا توجد وثائق' },
    'תעודות / חשבוניות': { th: 'เอกสาร / ใบเสร็จ', ar: 'وثائق / فواتير' },
    'תעודת משלוח': { th: 'ใบส่งสินค้า', ar: 'وصل توريد' },
    'מחק': { th: 'ลบ', ar: 'حذف' },
    'ציוד ורכבים': { th: 'อุปกรณ์และยานพาหนะ', ar: 'معدات ومركبات' },
    'ציוד': { th: 'อุปกรณ์', ar: 'معدات' },
    'ציוד עודכן': { th: 'อัปเดตอุปกรณ์แล้ว', ar: 'تم تحديث المعدات' },
    'פעולות אחרונות': { th: 'กิจกรรมล่าสุด', ar: 'أنشطة أخيرة' },
    'רכב': { th: 'ยานพาหนะ', ar: 'مركبة' },
    'מרסס': { th: 'เครื่องพ่น', ar: 'رشاش' },
    'כלי': { th: 'เครื่องมือ', ar: 'أداة' },
    'הוסף': { th: 'เพิ่ม', ar: 'إضافة' },
    'משלוח': { th: 'จัดส่ง', ar: 'توصيل' },
    'מלאי': { th: 'สต็อก', ar: 'مخزون' },
    'גרור או לחץ על הפינה הנגדית': { th: 'ลากหรือกดมุมตรงข้าม', ar: 'اسحب أو اضغط الزاوية المقابلة' },
    'לחץ לאישור': { th: 'กดเพื่อยืนยัน', ar: 'اضغط للتأكيد' },
    'המטעים שלי': { th: 'สวนของฉัน', ar: 'بساتيني' },
    'לחץ לפרטי מטע': { th: 'กดดูรายละเอียดสวน', ar: 'اضغط لتفاصيل البستان' },
    'עריכת חלקה': { th: 'แก้ไขแปลง', ar: 'تعديل القطعة' },
    'צייר מחדש': { th: 'วาดใหม่', ar: 'إعادة رسم' },
    'נווט': { th: 'นำทาง', ar: 'تنقل' },
    'עודכן': { th: 'อัปเดตแล้ว', ar: 'تم التحديث' },
    'שם ריק': { th: 'ชื่อว่างเปล่า', ar: 'الاسم فارغ' },
    'רכבים': { th: 'ยานพาหนะ', ar: 'مركبات' },
    'אין רכבים': { th: 'ไม่มียานพาหนะ', ar: 'لا توجد مركبات' },
    'הוסף רכב': { th: 'เพิ่มยานพาหนะ', ar: 'إضافة مركبة' },
    'רכב חדש': { th: 'ยานพาหนะใหม่', ar: 'مركبة جديدة' },
    'עריכת רכב': { th: 'แก้ไขยานพาหนะ', ar: 'تعديل المركبة' },
    'שם / תיאור': { th: 'ชื่อ / รายละเอียด', ar: 'اسم / وصف' },
    'מספר רכב': { th: 'หมายเลขทะเบียน', ar: 'رقم اللوحة' },
    'שנת ייצור': { th: 'ปีผลิต', ar: 'سنة الصنع' },
    'בעלות': { th: 'เจ้าของ', ar: 'ملكية' },
    'תוקף ביטוח': { th: 'ประกันหมดอายุ', ar: 'انتهاء التأمين' },
    'תוקף בטיחות': { th: 'ตรวจสภาพหมดอายุ', ar: 'انتهاء فحص السلامة' },
    'ביטוח': { th: 'ประกัน', ar: 'تأمين' },
    'בטיחות': { th: 'ตรวจสภาพ', ar: 'فحص سلامة' },
    'טיפול אחרון': { th: 'บริการล่าสุด', ar: 'آخر صيانة' },
    'מיקום אחרון': { th: 'ตำแหน่งล่าสุด', ar: 'آخر موقع' },
    'צלם / בחר תמונה': { th: 'ถ่าย / เลือกรูป', ar: 'تصوير / اختيار صورة' },
    'רכב עודכן': { th: 'อัปเดตยานพาหนะแล้ว', ar: 'تم تحديث المركبة' },
    'רכב נמחק': { th: 'ลบยานพาหนะแล้ว', ar: 'تم حذف المركبة' },
    'חזור': { th: 'กลับ', ar: 'رجوع' },
    'חיפוש חומרים': { th: 'ค้นหาสารเคมี', ar: 'بحث مبيدات' },
    'חיפוש חומרי הדברה': { th: 'ค้นหาสารกำจัดศัตรูพืช', ar: 'بحث مبيدات حشرية' },
    'מאגר משרד החקלאות': { th: 'ฐานข้อมูลกระทรวงเกษตร', ar: 'قاعدة بيانات وزارة الزراعة' },
    'מחפש': { th: 'กำลังค้นหา', ar: 'جاري البحث' },
    'לא נמצאו תוצאות': { th: 'ไม่พบผลลัพธ์', ar: 'لم يتم العثور على نتائج' },
    'פרטי תכשיר': { th: 'รายละเอียดผลิตภัณฑ์', ar: 'تفاصيل المنتج' },
    'הוסף לרשימה המקומית': { th: 'เพิ่มในรายการท้องถิ่น', ar: 'أضف للقائمة المحلية' },
    'תוצאות': { th: 'ผลลัพธ์', ar: 'نتائج' },
    'כבר קיים': { th: 'มีอยู่แล้ว', ar: 'موجود بالفعل' },
    'נוסף': { th: 'เพิ่มแล้ว', ar: 'تمت الإضافة' },
    'הקלד לצמצום': { th: 'พิมพ์เพื่อกรอง', ar: 'اكتب لتصفية' },
    'שגיאה': { th: 'ข้อผิดพลาด', ar: 'خطأ' },
    'חיפוש חופשי': { th: 'ค้นหาอิสระ', ar: 'بحث حر' },
    'שם תכשיר': { th: 'ชื่อผลิตภัณฑ์', ar: 'اسم المنتج' },
    'שם גידול': { th: 'ชื่อพืช', ar: 'اسم المحصول' },
    'הערכת מספר עצים': { th: 'ประมาณจำนวนต้นไม้', ar: 'تقدير عدد الأشجار' },
    'בחר מרווחי שתילה או הזן ידנית': { th: 'เลือกระยะปลูกหรือกรอกเอง', ar: 'اختر مسافات الزراعة أو أدخل يدوياً' },
    'בין שורות': { th: 'ระหว่างแถว', ar: 'بين الصفوف' },
    'בין עצים': { th: 'ระหว่างต้น', ar: 'بين الأشجار' },
    'מספר עצים משוער': { th: 'จำนวนต้นโดยประมาณ', ar: 'عدد الأشجار المقدر' },
    'מספר עצים סופי (ניתן לעריכה)': { th: 'จำนวนสุดท้าย (แก้ไขได้)', ar: 'العدد النهائي (قابل للتعديل)' },
    'קוטל חרקים': { th: 'ยาฆ่าแมลง', ar: 'مبيد حشرات' },
    'קוטל פטריות': { th: 'ยาฆ่าเชื้อรา', ar: 'مبيد فطريات' },
    'קוטל עשבים': { th: 'ยาฆ่าวัชพืช', ar: 'مبيد أعشاب' },
    'הורמון/ויסות': { th: 'ฮอร์โมน/ตัวควบคุม', ar: 'هرمون/تنظيم' },
    'סבון/שמן': { th: 'สบู่/น้ำมัน', ar: 'صابون/زيت' },
    'פורמולציה': { th: 'สูตร', ar: 'تركيبة' },
    'גידול': { th: 'พืช', ar: 'محصول' },
    'נגע': { th: 'ศัตรูพืช', ar: 'آفة' },
    'מינון': { th: 'ขนาดยา', ar: 'جرعة' },
    'נפח': { th: 'ปริมาณ', ar: 'حجم' },
    'המתנה': { th: 'ระยะหยุดพ่น', ar: 'فترة انتظار' },
    'כניסה מחדש': { th: 'เข้าพื้นที่ใหม่', ar: 'إعادة الدخول' },
    'צפה בתווית הרשמית': { th: 'ดูฉลากทางการ', ar: 'عرض الملصق الرسمي' },
    'הוסף לרשימה': { th: 'เพิ่มในรายการ', ar: 'أضف للقائمة' },
    'ידני': { th: 'ด้วยตนเอง', ar: 'يدوي' },
    'תכשירים רשומים': { th: 'ผลิตภัณฑ์ที่จดทะเบียน', ar: 'منتجات مسجلة' },
    'גידולים': { th: 'พืช', ar: 'محاصيل' },
    'תכשירים': { th: 'ผลิตภัณฑ์', ar: 'منتجات' },
    'רישומים לגידולים': { th: 'รายการจดทะเบียนพืช', ar: 'تسجيلات المحاصيل' },
    'נדרש לפתוח דרך שרת': { th: 'ต้องเปิดผ่านเซิร์ฟเวอร์', ar: 'يجب الفتح عبر خادم' },
    'נסה להעלות לשרת או השתמש ב-Live Server': { th: 'อัปโหลดไปเซิร์ฟเวอร์หรือใช้ Live Server', ar: 'حمّل على خادم أو استخدم Live Server' },
    'גישה למיקום נדחתה': { th: 'การเข้าถึงตำแหน่งถูกปฏิเสธ', ar: 'تم رفض الوصول للموقع' },
    'בדוק הגדרות דפדפן ומכשיר': { th: 'ตรวจสอบการตั้งค่าเบราว์เซอร์', ar: 'تحقق من إعدادات المتصفح والجهاز' },
    'ודא ש-GPS פעיל במכשיר': { th: 'ตรวจสอบว่าเปิด GPS', ar: 'تأكد من تشغيل GPS' },
    'נסה באזור פתוח': { th: 'ลองในที่โล่ง', ar: 'جرب في مكان مفتوح' },
    'טוען מאגר': { th: 'กำลังโหลดฐานข้อมูล', ar: 'تحميل قاعدة البيانات' },
    'במאגר': { th: 'ในฐานข้อมูล', ar: 'في القاعدة' },
    'תווית זמינה': { th: 'มีฉลาก', ar: 'الملصق متاح' },
    'דו״ח עבודה': { th: 'รายงานงาน', ar: 'تقرير عمل' },
    'סיכום והיסטוריה': { th: 'สรุปและประวัติ', ar: 'ملخص وتاريخ' },
    'סוג עבודה חדש': { th: 'ประเภทงานใหม่', ar: 'نوع عمل جديد' },
    'שם הפעולה': { th: 'ชื่อกิจกรรม', ar: 'اسم النشاط' },
    'לאום עובדים': { th: 'สัญชาติคนงาน', ar: 'جنسية العمال' },
    'עובדים (שמות)': { th: 'คนงาน (ชื่อ)', ar: 'عمال (أسماء)' },
    'רשומות אחרונות': { th: 'รายการล่าสุด', ar: 'سجلات أخيرة' },
    'דילול': { th: 'ตัดแต่ง', ar: 'تخفيف' },
    'מעבר מים': { th: 'ให้น้ำ', ar: 'ري' },
    'רשומה נשמרה מקומית': { th: 'บันทึกในเครื่อง', ar: 'تم الحفظ محلياً' },
    'רישומים לגידולים': { th: 'รายการจดทะเบียนพืช', ar: 'تسجيلات المحاصيل' },

    // ── Crop & Density ──
    'בחר גידול': { th: 'เลือกพืช', ar: 'اختر محصول' },
    'סוג גידול': { th: 'ประเภทพืช', ar: 'نوع المحصول' },
    'צפיפות צמחים': { th: 'ความหนาแน่นของต้นไม้', ar: 'كثافة النباتات' },
    'בחר שיטת חישוב': { th: 'เลือกวิธีคำนวณ', ar: 'اختر طريقة الحساب' },
    'צמחים לדונם': { th: 'ต้น/ดูนัม', ar: 'نبات/دونم' },
    'מספר צמחים משוער': { th: 'จำนวนต้นโดยประมาณ', ar: 'عدد النباتات المقدر' },
    'מספר צמחים סופי (ניתן לעריכה)': { th: 'จำนวนต้นสุดท้าย (แก้ไขได้)', ar: 'عدد النباتات النهائي (قابل للتعديل)' },
    'צמחים': { th: 'ต้น', ar: 'نبتة' },
    'שם גידול': { th: 'ชื่อพืช', ar: 'اسم المحصول' },

    // ── Irrigation ──
    'השקיה': { th: 'การให้น้ำ', ar: 'ري' },

    // ── Worklog extras ──
    'בחר סעיף': { th: 'เลือกหมวด', ar: 'اختر بند' },
    'בחר פעולה': { th: 'เลือกงาน', ar: 'اختر عملية' },
    'בחר קבוצה': { th: 'เลือกกลุ่ม', ar: 'اختر مجموعة' },
    'יש לבחור פעולה': { th: 'กรุณาเลือกงาน', ar: 'يجب اختيار عملية' },
    'פעולה חדשה': { th: 'งานใหม่', ar: 'عملية جديدة' },
    'קבוצת עובדים חדשה': { th: 'กลุ่มคนงานใหม่', ar: 'مجموعة عمال جديدة' },
    'שם הקבוצה': { th: 'ชื่อกลุ่ม', ar: 'اسم المجموعة' },
    'סעיף תקציבי': { th: 'หมวดงบประมาณ', ar: 'بند الميزانية' },
    'קבוצת עובדים': { th: 'กลุ่มคนงาน', ar: 'مجموعة عمال' },
    'מספר עובדים': { th: 'จำนวนคนงาน', ar: 'عدد العمال' },
    'שעות עבודה': { th: 'ชั่วโมงทำงาน', ar: 'ساعات العمل' },
    'עובדים (שמות)': { th: 'ชื่อคนงาน', ar: 'أسماء العمال' },
    'רשומה חדשה': { th: 'รายการใหม่', ar: 'سجل جديد' },
    'רשומות אחרונות': { th: 'รายการล่าสุด', ar: 'سجلات أخيرة' },
    'רשומת יומן מהירה': { th: 'บันทึกด่วน', ar: 'سجل سريع' },
    'דיווח עבודה': { th: 'รายงานงาน', ar: 'تقرير عمل' },
    'סיכום והיסטוריה': { th: 'สรุปและประวัติ', ar: 'ملخص وتاريخ' },
    'סיכום הספק': { th: 'สรุปผลผลิต', ar: 'ملخص الإنتاجية' },
    'הספק מחושב': { th: 'ผลผลิตที่คำนวณ', ar: 'إنتاجية محسوبة' },
    'עצים שטופלו': { th: 'ต้นที่ดูแลแล้ว', ar: 'أشجار تمت معالجتها' },
    'עצים/עובד': { th: 'ต้น/คน', ar: 'شجرة/عامل' },
    'עצים/שעה': { th: 'ต้น/ชม.', ar: 'شجرة/ساعة' },
    'עצים/עובד×שעה': { th: 'ต้น/คน×ชม.', ar: 'شجرة/عامل×ساعة' },

    // ── Spray ──
    'פרטי ריסוס': { th: 'รายละเอียดพ่นยา', ar: 'تفاصيل الرش' },
    'שם המפעיל': { th: 'ชื่อผู้ปฏิบัติ', ar: 'اسم المشغل' },
    'שם תכשיר': { th: 'ชื่อสารเคมี', ar: 'اسم المبيد' },
    'בחירת חלקות': { th: 'เลือกแปลง', ar: 'اختيار قطع' },
    'בחר מטע': { th: 'เลือกสวน', ar: 'اختر بستان' },
    'תאריך': { th: 'วันที่', ar: 'تاريخ' },
    'חלקה': { th: 'แปลง', ar: 'قطعة' },
    'גידול': { th: 'พืช', ar: 'محصول' },

    // ── Pesticide Search ──
    'חיפוש חומרי הדברה': { th: 'ค้นหายาฆ่าแมลง', ar: 'بحث مبيدات' },
    'חיפוש חופשי': { th: 'ค้นหาอิสระ', ar: 'بحث حر' },
    'מאגר משרד החקלאות': { th: 'ฐานข้อมูลกระทรวงเกษตร', ar: 'قاعدة بيانات وزارة الزراعة' },
    'מחפש': { th: 'กำลังค้นหา...', ar: 'جاري البحث...' },
    'תכשיר': { th: 'สารเคมี', ar: 'مبيد' },

    // ── Profile ──
    'הגדרות Google Sheets': { th: 'ตั้งค่า Google Sheets', ar: 'إعدادات Google Sheets' },
    'כתובת Apps Script': { th: 'ที่อยู่ Apps Script', ar: 'عنوان Apps Script' },
    'הכתובת מתקבלת אחרי פריסת הסקריפט': { th: 'ที่อยู่จะได้หลังจากปรับใช้สคริปต์', ar: 'العنوان يتم الحصول عليه بعد نشر السكريبت' },
    'מזהה גיליון לכל מטע': { th: 'รหัสชีตสำหรับแต่ละสวน', ar: 'معرف الجدول لكل بستان' },
    'המזהה נמצא בכתובת URL של הגיליון': { th: 'รหัสอยู่ใน URL ของชีต', ar: 'المعرف موجود في عنوان URL للجدول' },

    // ── Receipts & Documents ──
    'חשבונית או תעודה': { th: 'ใบแจ้งหนี้หรือใบรับ', ar: 'فاتورة أو شهادة' },
    'צלם תעודת משלוח': { th: 'ถ่ายภาพใบส่งของ', ar: 'تصوير بوليصة شحن' },
    'דו״ח עבודה': { th: 'รายงานงาน', ar: 'تقرير عمل' },
    'גלריה': { th: 'แกลเลอรี', ar: 'معرض' },

    // ── Map & Navigation ──
    'גישה למיקום נדחתה': { th: 'การเข้าถึงตำแหน่งถูกปฏิเสธ', ar: 'تم رفض الوصول للموقع' },
    'הדפדפן לא תומך באיתור מיקום': { th: 'เบราว์เซอร์ไม่รองรับการระบุตำแหน่ง', ar: 'المتصفح لا يدعم تحديد الموقع' },
    'בדוק הגדרות דפדפן ומכשיר': { th: 'ตรวจสอบการตั้งค่าเบราว์เซอร์และอุปกรณ์', ar: 'تحقق من إعدادات المتصفح والجهاز' },

    // ── Empty states ──
    'אין היסטוריה': { th: 'ไม่มีประวัติ', ar: 'لا يوجد تاريخ' },
    'אין חלקות זמינות': { th: 'ไม่มีแปลงที่พร้อม', ar: 'لا توجد قطع متاحة' },
    'אין מטעים זמינים': { th: 'ไม่มีสวนที่พร้อม', ar: 'لا توجد بساتين متاحة' },
    'אין מטעים משויכים': { th: 'ไม่มีสวนที่ผูกไว้', ar: 'لا توجد بساتين مرتبطة' },
    'אין רכבים': { th: 'ไม่มียานพาหนะ', ar: 'لا توجد مركبات' },
    'אין רשומות': { th: 'ไม่มีรายการ', ar: 'لا توجد سجلات' },
    'אין תעודות משלוח': { th: 'ไม่มีใบส่งของ', ar: 'لا توجد بوالص شحن' },
    'אין תעודות': { th: 'ไม่มีเอกสาร', ar: 'لا توجد شهادات' },

    // ── Safety & Categories ──
    'בטיחות': { th: 'ความปลอดภัย', ar: 'سلامة' },
    'ביטוח': { th: 'ประกัน', ar: 'تأمين' },
    'בעלות': { th: 'ความเป็นเจ้าของ', ar: 'ملكية' },

    // ── Toast messages ──
    '⛔ רק מנהל יכול למחוק חלקות': { th: '⛔ เฉพาะผู้ดูแลเท่านั้นที่ลบแปลงได้', ar: '⛔ فقط المسؤول يمكنه حذف القطع' },
    '⛔ אין לך הרשאה למחוק חלקה זו': { th: '⛔ คุณไม่มีสิทธิ์ลบแปลงนี้', ar: '⛔ ليس لديك صلاحية لحذف هذه القطعة' },
    '💾 שיוך מגופים נשמר': { th: '💾 บันทึกการเชื่อมต่อวาล์วแล้ว', ar: '💾 تم حفظ ربط الصمامات' },
    '🔄 נתונים עודכנו': { th: '🔄 อัปเดตข้อมูลแล้ว', ar: '🔄 تم تحديث البيانات' },

    // ── Misc UI ──
    'גרור או לחץ על הפינה הנגדית': { th: 'ลากหรือคลิกที่มุมตรงข้าม', ar: 'اسحب أو اضغط على الزاوية المقابلة' },
    'לא בשעון': { th: 'ไม่ได้เข้างาน', ar: 'غير مسجل' },
    'כניסה': { th: 'เข้างาน', ar: 'دخول' },
    'השבוע': { th: 'สัปดาห์นี้', ar: 'هذا الأسبوع' },
    'החודש': { th: 'เดือนนี้', ar: 'هذا الشهر' },
    'השנה': { th: 'ปีนี้', ar: 'هذه السنة' },
    'בחירה מלוח שנה': { th: 'เลือกจากปฏิทิน', ar: 'اختيار من التقويم' },
    'סיכום נוכחות': { th: 'สรุปการเข้างาน', ar: 'ملخص الحضور' },
    'ימים': { th: 'วัน', ar: 'أيام' },
    'שעות': { th: 'ชั่วโมง', ar: 'ساعات' },
    'משמרות': { th: 'กะ', ar: 'مناوبات' },
    'המשימות שלי': { th: 'งานของฉัน', ar: 'مهامي' },
    'מחק חלקה': { th: 'ลบแปลง', ar: 'حذف قطعة' },
    'למחוק את חלקה': { th: 'ลบแปลง', ar: 'حذف القطعة' },
    'נמחק': { th: 'ถูกลบแล้ว', ar: 'تم الحذف' },
    'אין רישומים לגידולים שלך': { th: 'ไม่มีรายการสำหรับพืชของคุณ', ar: 'لا توجد تسجيلات لمحاصيلك' },
    'סה״כ': { th: 'ทั้งหมด', ar: 'إجمالي' },
    'רשומים לתכשיר זה': { th: 'รายการจดทะเบียนของสารนี้', ar: 'مسجلة لهذا المبيد' },
    'לא רלוונטי לגידולים שלך': { th: 'ไม่เกี่ยวข้องกับพืชของคุณ', ar: 'غير ملائم لمحاصيلك' },
    'מסונן לגידולים שלך': { th: 'กรองตามพืชของคุณ', ar: 'مصفى لمحاصيلك' },

    // ── Login & Auth ──
    'חשבון לא מוגדר במערכת. פנה למנהל.': { th: 'บัญชีไม่ได้ลงทะเบียนในระบบ ติดต่อผู้ดูแล', ar: 'الحساب غير مسجل في النظام. تواصل مع المسؤول.' },
    'שחזור פרטי התחברות': { th: 'กู้คืนข้อมูลเข้าสู่ระบบ', ar: 'استعادة بيانات الدخول' },
    'הזן את מספר הטלפון הרשום במערכת ונשלח לך קוד ב-SMS': { th: 'กรอกเบอร์โทรที่ลงทะเบียนไว้ เราจะส่งรหัสทาง SMS', ar: 'أدخل رقم الهاتف المسجل وسنرسل لك رمزاً عبر SMS' },
    'שלח קוד': { th: 'ส่งรหัส', ar: 'إرسال الرمز' },
    'סיסמה חדשה (לפחות 6 תווים)': { th: 'รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)', ar: 'كلمة مرور جديدة (6 أحرف على الأقل)' },
    'אמת ואפס סיסמה': { th: 'ยืนยันและรีเซ็ตรหัสผ่าน', ar: 'تحقق وأعد تعيين كلمة المرور' },
    'מספר טלפון לא תקין': { th: 'เบอร์โทรไม่ถูกต้อง', ar: 'رقم هاتف غير صالح' },
    'שולח קוד...': { th: 'กำลังส่งรหัส...', ar: 'جاري إرسال الرمز...' },
    'קוד נשלח! הזן אותו יחד עם סיסמה חדשה': { th: 'ส่งรหัสแล้ว! กรอกรหัสพร้อมรหัสผ่านใหม่', ar: 'تم إرسال الرمز! أدخله مع كلمة مرور جديدة' },
    'הזן את הקוד מה-SMS': { th: 'กรอกรหัสจาก SMS', ar: 'أدخل الرمز من SMS' },
    'מאמת...': { th: 'กำลังตรวจสอบ...', ar: 'جاري التحقق...' },
    'שם המשתמש שלך': { th: 'ชื่อผู้ใช้ของคุณ', ar: 'اسم المستخدم الخاص بك' },
    'הסיסמה עודכנה — אפשר להתחבר': { th: 'อัปเดตรหัสผ่านแล้ว — เข้าสู่ระบบได้เลย', ar: 'تم تحديث كلمة المرور — يمكنك الدخول الآن' },
    'קוד שגוי או שפג תוקפו': { th: 'รหัสผิดหรือหมดอายุ', ar: 'رمز خاطئ أو منتهي الصلاحية' },
    'הטלפון אינו רשום במערכת. פנה למנהל.': { th: 'เบอร์นี้ไม่ได้ลงทะเบียน ติดต่อผู้ดูแล', ar: 'الهاتف غير مسجل. تواصل مع المسؤول.' },
    'טלפון (לשחזור סיסמה ב-SMS)': { th: 'โทรศัพท์ (สำหรับกู้รหัสผ่านทาง SMS)', ar: 'هاتف (لاستعادة كلمة المرور عبر SMS)' },
    'יש למלא אימייל וסיסמה': { th: 'กรอกอีเมลและรหัสผ่าน', ar: 'يجب إدخال البريد وكلمة المرور' },
    'מתחבר...': { th: 'กำลังเชื่อมต่อ...', ar: 'جاري الاتصال...' },
    'שגיאת התחברות': { th: 'เข้าสู่ระบบล้มเหลว', ar: 'خطأ في تسجيل الدخول' },
    'הסיסמה חייבת להכיל לפחות 6 תווים': { th: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร', ar: 'كلمة المرور يجب أن تحتوي على 6 أحرف على الأقل' },
    'האימייל כבר בשימוש': { th: 'อีเมลนี้ถูกใช้แล้ว', ar: 'البريد الإلكتروني مستخدم بالفعل' },
    'סיסמה שגויה': { th: 'รหัสผ่านไม่ถูกต้อง', ar: 'كلمة المرور خاطئة' },
    'אימייל או סיסמה שגויים': { th: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', ar: 'البريد الإلكتروني أو كلمة المرور غير صحيحة' },
    'פעם ראשונה כאן? לחץ על "הרשמה ראשונה"': { th: 'ครั้งแรกที่นี่? กด "ลงทะเบียนครั้งแรก"', ar: 'أول مرة هنا؟ اضغط "تسجيل لأول مرة"' },
    'נרשם...': { th: 'กำลังลงทะเบียน...', ar: 'جاري التسجيل...' },
    'טוען פרופיל...': { th: 'กำลังโหลดโปรไฟล์...', ar: 'جاري تحميل الملف الشخصي...' },
    'הסיסמאות אינן תואמות': { th: 'รหัสผ่านไม่ตรงกัน', ar: 'كلمتا المرور غير متطابقتين' },
    'כבר נרשמת בעבר — השתמש בכפתור "התחבר"': { th: 'คุณลงทะเบียนแล้ว — ใช้ปุ่ม "เข้าสู่ระบบ"', ar: 'أنت مسجل بالفعل — استخدم زر "تسجيل الدخول"' },
    'נרשמת, אך החשבון טרם הוגדר במערכת. פנה למנהל.': { th: 'ลงทะเบียนสำเร็จ แต่บัญชียังไม่ถูกตั้งค่าในระบบ ติดต่อผู้ดูแล', ar: 'تم التسجيل، لكن الحساب لم يُعرَّف في النظام بعد. تواصل مع المسؤول.' },
    'יותר מדי נסיונות, נסה מאוחר יותר': { th: 'พยายามมากเกินไป ลองใหม่ภายหลัง', ar: 'محاولات كثيرة، حاول لاحقاً' },
    'הזן אימייל קודם': { th: 'กรอกอีเมลก่อน', ar: 'أدخل البريد أولاً' },
    'נשלח מייל לאיפוס סיסמה ל-': { th: 'ส่งอีเมลรีเซ็ตรหัสผ่านไปที่ ', ar: 'تم إرسال بريد إعادة تعيين كلمة المرور إلى ' },
    'אימייל לא נמצא': { th: 'ไม่พบอีเมล', ar: 'البريد غير موجود' },
    'רשת': { th: 'เครือข่าย', ar: 'شبكة' },

    // ── Retrospective plot editing ──
    'צפיפות ומספר עצים': { th: 'ความหนาแน่นและจำนวนต้น', ar: 'الكثافة وعدد الأشجار' },
    'חשב לפי מרווחים': { th: 'คำนวณจากระยะปลูก', ar: 'احسب حسب المسافات' },
    'חשב לפי צמחים לדונם': { th: 'คำนวณจากต้น/ดูนัม', ar: 'احسب حسب نبات/دونم' },
    'שטח מהמפה': { th: 'พื้นที่จากแผนที่', ar: 'المساحة من الخريطة' },
    'הזן מרווחים תקינים': { th: 'กรอกระยะปลูกที่ถูกต้อง', ar: 'أدخل مسافات صحيحة' },
    'הזן צמחים לדונם': { th: 'กรอกจำนวนต้นต่อดูนัม', ar: 'أدخل عدد النباتات للدونم' },
    'שטח לא תקין': { th: 'พื้นที่ไม่ถูกต้อง', ar: 'مساحة غير صحيحة' },
    'מרווח בין שורות לא תקין': { th: 'ระยะระหว่างแถวไม่ถูกต้อง', ar: 'المسافة بين الصفوف غير صحيحة' },
    'מרווח בין עצים לא תקין': { th: 'ระยะระหว่างต้นไม่ถูกต้อง', ar: 'المسافة بين الأشجار غير صحيحة' },
    'מספר עצים לא תקין': { th: 'จำนวนต้นไม่ถูกต้อง', ar: 'عدد الأشجار غير صحيح' },
    'צמחים לדונם לא תקין': { th: 'จำนวนต้นต่อดูนัมไม่ถูกต้อง', ar: 'عدد النباتات للدونم غير صحيح' },
    'שינוי שם חלקה': { th: 'เปลี่ยนชื่อแปลง', ar: 'تغيير اسم القطعة' },
    'נמצאו רשומות היסטוריות עם השם הישן': { th: 'พบบันทึกเก่าที่ใช้ชื่อเดิม', ar: 'تم العثور على سجلات قديمة بالاسم السابق' },
    'רשומות ביומן עבודה': { th: 'บันทึกในสมุดงาน', ar: 'سجلات دفتر العمل' },
    'דוחות שדה': { th: 'รายงานภาคสนาม', ar: 'تقارير حقلية' },
    'עדכן את כל ההיסטוריה': { th: 'อัปเดตประวัติทั้งหมด', ar: 'حدّث كل السجل' },
    'השאר את השם הישן בהיסטוריה': { th: 'เก็บชื่อเดิมไว้ในประวัติ', ar: 'أبقِ الاسم القديم في السجل' },
    'רשומות היסטוריות עודכנו': { th: 'บันทึกเก่าถูกอัปเดตแล้ว', ar: 'تم تحديث السجلات القديمة' },
    'אין לך הרשאה לערוך חלקה זו': { th: 'คุณไม่มีสิทธิ์แก้ไขแปลงนี้', ar: 'ليس لديك صلاحية لتعديل هذه القطعة' },
    'השם הישן': { th: 'ชื่อเดิม', ar: 'الاسم القديم' },
    'השם החדש': { th: 'ชื่อใหม่', ar: 'الاسم الجديد' },

    // ── Spray calculations ──
    'מספר עצים': { th: 'จำนวนต้นไม้', ar: 'عدد الأشجار' },
    'נפח כולל': { th: 'ปริมาตรรวม', ar: 'الحجم الإجمالي' },
    'מספר מילויים': { th: 'จำนวนครั้งเติม', ar: 'عدد التعبئات' },
    'מילויים': { th: 'ครั้งเติม', ar: 'تعبئات' },
    'ליטר': { th: 'ลิตร', ar: 'لتر' },
    'למילוי אחד': { th: 'ต่อครั้งเติม', ar: 'لتعبئة واحدة' },
    'ליטר/עץ': { th: 'ลิตร/ต้น', ar: 'لتر/شجرة' },
    'חלקה לא ידועה': { th: 'แปลงไม่ทราบ', ar: 'قطعة غير معروفة' },
    'לא ידוע': { th: 'ไม่ทราบ', ar: 'غير معروف' },
    'ריכוז (%)': { th: 'ความเข้มข้น (%)', ar: 'تركيز (%)' },
    'מטרה': { th: 'เป้าหมาย', ar: 'هدف' },

    // ── Spray PDF export ──
    'יומן ריסוסים': { th: 'บันทึกการพ่นยา', ar: 'سجل الرش' },
    'יומן ריסוסים - שורשים פלוס': { th: 'บันทึกการพ่นยา - ชอราชิม พลัส', ar: 'سجل الرش - شوراشيم بلس' },
    'תאריך הפקה:': { th: 'วันที่ออกรายงาน:', ar: 'تاريخ الإصدار:' },
    'מפעיל': { th: 'ผู้ปฏิบัติงาน', ar: 'مشغل' },
    'נפח/עץ': { th: 'ปริมาตร/ต้น', ar: 'حجم/شجرة' },
    'חומר': { th: 'สาร', ar: 'مادة' },
    'חומרים': { th: 'สารเคมี', ar: 'مواد' },
    'מרסס': { th: 'เครื่องพ่น', ar: 'رشاش' },
    'ריסוס חדש': { th: 'พ่นยาใหม่', ar: 'رش جديد' },
    'הדו"ח נפתח — לחץ שמור כ-PDF': { th: 'รายงานเปิดแล้ว — กดบันทึกเป็น PDF', ar: 'فُتح التقرير — اضغط حفظ كـ PDF' },
    'שמור כ-PDF': { th: 'บันทึกเป็น PDF', ar: 'حفظ كـ PDF' },
    'הורד HTML': { th: 'ดาวน์โหลด HTML', ar: 'تنزيل HTML' },

    // ── Pesticide admin ──
    'עריכת חומר': { th: 'แก้ไขสารเคมี', ar: 'تعديل مبيد' },
    'הוספת חומר': { th: 'เพิ่มสารเคมี', ar: 'إضافة مبيد' },
    'מלא את פרטי חומר ההדברה': { th: 'กรอกรายละเอียดสารเคมี', ar: 'املأ تفاصيل المبيد' },
    'שם מסחרי': { th: 'ชื่อการค้า', ar: 'الاسم التجاري' },
    'ריכוז ברירת מחדל (%)': { th: 'ความเข้มข้นเริ่มต้น (%)', ar: 'التركيز الافتراضي (%)' },
    'מטרות נפוצות': { th: 'เป้าหมายทั่วไป', ar: 'أهداف شائعة' },
    'למחוק את': { th: 'ลบ', ar: 'حذف' },

    // ── Farm admin ──
    'עריכת מטע': { th: 'แก้ไขสวน', ar: 'تعديل بستان' },
    'מטע חדש': { th: 'สวนใหม่', ar: 'بستان جديد' },
    'מלא את פרטי המטע': { th: 'กรอกรายละเอียดสวน', ar: 'املأ تفاصيل البستان' },
    'שם המטע': { th: 'ชื่อสวน', ar: 'اسم البستان' },
    'צבע המטע (כל החלקות יהיו בצבע זה)': { th: 'สีสวน (ทุกแปลงจะเป็นสีนี้)', ar: 'لون البستان (جميع القطع ستكون بهذا اللون)' },

    // ── User admin ──
    'סה"כ משתמשים': { th: 'ผู้ใช้ทั้งหมด', ar: 'إجمالي المستخدمين' },
    'מנהלים': { th: 'ผู้จัดการ', ar: 'مدراء' },
    'מפעילים': { th: 'ผู้ปฏิบัติงาน', ar: 'مشغلون' },
    'צופים': { th: 'ผู้ชม', ar: 'مشاهدون' },
    'מפעיל': { th: 'ผู้ปฏิบัติ', ar: 'مشغل' },
    'צופה': { th: 'ผู้ชม', ar: 'مشاهد' },
    'כל המטעים': { th: 'ทุกสวน', ar: 'جميع البساتين' },
    'למחוק את המשתמש': { th: 'ลบผู้ใช้', ar: 'حذف المستخدم' },
    'גישה למטעים': { th: 'เข้าถึงสวน', ar: 'الوصول إلى البساتين' },
    'עריכת משתמש': { th: 'แก้ไขผู้ใช้', ar: 'تعديل مستخدم' },
    'משתמש חדש': { th: 'ผู้ใช้ใหม่', ar: 'مستخدم جديد' },
    'שם מלא': { th: 'ชื่อเต็ม', ar: 'الاسم الكامل' },
    'אימייל': { th: 'อีเมล', ar: 'بريد إلكتروني' },
    'תפקיד': { th: 'ตำแหน่ง', ar: 'وظيفة' },
    'עובד': { th: 'คนงาน', ar: 'عامل' },
    'המשתמש יתחבר עם האימייל שהוזן. בכניסה הראשונה יצר חשבון אוטומטית עם הסיסמה שיבחר.': { th: 'ผู้ใช้จะเข้าสู่ระบบด้วยอีเมลที่กรอก ครั้งแรกจะสร้างบัญชีอัตโนมัติด้วยรหัสผ่านที่เลือก', ar: 'المستخدم سيسجل بالبريد المدخل. في الدخول الأول سينشئ حساباً تلقائياً بكلمة المرور التي يختارها.' },
    'מומלץ להשתמש בכתובת Gmail של העובד — כך יוכל להתחבר בלחיצה אחת עם Google': { th: 'แนะนำใช้ Gmail ของคนงาน — จะเข้าสู่ระบบด้วย Google ได้ในคลิกเดียว', ar: 'يُفضل استخدام Gmail العامل — سيتمكن من تسجيل الدخول بنقرة واحدة عبر Google' },
    'המשתמש יתחבר עם האימייל שהזנת. אם זה משתמש חדש, הסיסמה הראשונית תהיה האימייל עצמו.': { th: 'ผู้ใช้จะเข้าสู่ระบบด้วยอีเมลที่กรอก หากเป็นผู้ใช้ใหม่ รหัสผ่านเริ่มต้นจะเป็นอีเมลนั้น', ar: 'سيسجل المستخدم بالبريد المدخل. إذا كان جديداً، كلمة المرور الأولية ستكون البريد نفسه.' },
    'משתמש נוסף — יוכל להתחבר עם': { th: 'เพิ่มผู้ใช้แล้ว — เข้าสู่ระบบด้วย', ar: 'تمت إضافة المستخدم — يمكنه تسجيل الدخول بـ' },
    'למחוק את מטע': { th: 'ลบสวน', ar: 'حذف بستان' },

    // ── Profile ──
    'ימים/שבוע': { th: 'วัน/สัปดาห์', ar: 'أيام/أسبوع' },

    // ── Day names ──
    'יום א\'': { th: 'อาทิตย์', ar: 'الأحد' },
    'יום ב\'': { th: 'จันทร์', ar: 'الاثنين' },
    'יום ג\'': { th: 'อังคาร', ar: 'الثلاثاء' },
    'יום ד\'': { th: 'พุธ', ar: 'الأربعاء' },
    'יום ה\'': { th: 'พฤหัส', ar: 'الخميس' },
    'יום ו\'': { th: 'ศุกร์', ar: 'الجمعة' },
    'שבת': { th: 'เสาร์', ar: 'السبت' },

    // ── Worklog sync status ──
    'סונכרן': { th: 'ซิงค์แล้ว', ar: 'تمت المزامنة' },
    'מקומי': { th: 'ในเครื่อง', ar: 'محلي' },

    // ── Irrigation / Talgil ──
    'טוען נתוני השקיה...': { th: 'กำลังโหลดข้อมูลการให้น้ำ...', ar: 'جاري تحميل بيانات الري...' },
    'אין מגופים משויכים': { th: 'ไม่มีวาล์วที่ผูกไว้', ar: 'لا توجد صمامات مرتبطة' },
    'ספיקה:': { th: 'อัตราไหล:', ar: 'التدفق:' },
    'קוב/ש': { th: 'ลบ.ม./ชม.', ar: 'م³/ساعة' },
    'שטח:': { th: 'พื้นที่:', ar: 'مساحة:' },
    'ד\'': { th: 'ดูนัม', ar: 'د' },
    'כל': { th: 'ทุก', ar: 'كل' },
    'ימים': { th: 'วัน', ar: 'أيام' },
    'סגור': { th: 'ปิด', ar: 'إغلاق' },
    'פתוח': { th: 'เปิด', ar: 'مفتوح' },
    'תקלה': { th: 'ข้อผิดพลาด', ar: 'عطل' },
    'ממתין': { th: 'รอ', ar: 'انتظار' },
    'מצב': { th: 'สถานะ', ar: 'حالة' },
    'מגוף': { th: 'วาล์ว', ar: 'صمام' },
    'קו': { th: 'สาย', ar: 'خط' },
    'ספיקה (קוב/ש)': { th: 'อัตราไหล (ลบ.ม./ชม.)', ar: 'التدفق (م³/ساعة)' },
    'שטח (ד\')': { th: 'พื้นที่ (ดูนัม)', ar: 'مساحة (د)' },
    'קוב': { th: 'ลบ.ม.', ar: 'م³' },
    'קוב/ד\'': { th: 'ลบ.ม./ดูนัม', ar: 'م³/د' },
    'דקות': { th: 'นาที', ar: 'دقائق' },
    'ידני': { th: 'ด้วยตนเอง', ar: 'يدوي' },
    'מחזור:': { th: 'รอบ:', ar: 'دورة:' },
    'רצף:': { th: 'ลำดับ:', ar: 'تسلسل:' },
    'אין תוכניות': { th: 'ไม่มีโปรแกรม', ar: 'لا توجد برامج' },
    'בחר חלקה': { th: 'เลือกแปลง', ar: 'اختر قطعة' },
    'התחבר לתלגיל למעלה ושייך מגופים לחלקות': { th: 'เชื่อมต่อ Talgil ด้านบนและผูกวาล์วกับแปลง', ar: 'اتصل بـ Talgil أعلاه واربط الصمامات بالقطع' },
    'אין עדיין נתוני השקיה': { th: 'ยังไม่มีข้อมูลการให้น้ำ', ar: 'لا توجد بيانات ري بعد' },
    'שייך מגופים לחלקות בחלק למטה': { th: 'ผูกวาล์วกับแปลงด้านล่าง', ar: 'اربط الصمامات بالقطع في الأسفل' },
    'המנהל טרם שייך מגופים לחלקות שלך': { th: 'ผู้ดูแลยังไม่ได้ผูกวาล์วกับแปลงของคุณ', ar: 'المسؤول لم يربط الصمامات بقطعك بعد' },
    'מתחבר...': { th: 'กำลังเชื่อมต่อ...', ar: 'جاري الاتصال...' },
    'טוען תוכניות...': { th: 'กำลังโหลดโปรแกรม...', ar: 'جاري تحميل البرامج...' },
    'מחובר —': { th: 'เชื่อมต่อแล้ว —', ar: 'متصل —' },
    'מגופים': { th: 'วาล์ว', ar: 'صمامات' },
    'תוכניות': { th: 'โปรแกรม', ar: 'برامج' },
    'חבר תלגיל קודם': { th: 'เชื่อมต่อ Talgil ก่อน', ar: 'اتصل بـ Talgil أولاً' },

    // ── Viewer clock ──
    'אין רשומות בתקופה': { th: 'ไม่มีรายการในช่วงนี้', ar: 'لا توجد سجلات في الفترة' },
    'מקום': { th: 'สถานที่', ar: 'مكان' },
    'יציאה': { th: 'ออก', ar: 'خروج' },
    'בעבודה': { th: 'กำลังทำงาน', ar: 'في العمل' },
    'יציאה': { th: 'ออกงาน', ar: 'خروج' },

    // ── Plot & Misc ──
    'נוספה חלקה': { th: 'เพิ่มแปลงแล้ว', ar: 'تمت إضافة القطعة' },
    'נמחקה חלקה': { th: 'ลบแปลงแล้ว', ar: 'تم حذف القطعة' },
    'לדוגמה:': { th: 'ตัวอย่าง:', ar: 'مثال:' },
    'מ\'': { th: 'ม.', ar: 'م' },
    'אין חומרים מוגדרים. הוסף בלשונית חומרים.': { th: 'ไม่มีสารเคมีที่กำหนด เพิ่มในแท็บสารเคมี', ar: 'لا توجد مبيدات محددة. أضف في تبويب المواد.' },
    'כמות נוכחית': { th: 'ปริมาณปัจจุบัน', ar: 'الكمية الحالية' },
    'כמות מקסימלית': { th: 'ปริมาณสูงสุด', ar: 'الكمية القصوى' },
    'כתובת Apps Script נשמרה': { th: 'บันทึก URL ของ Apps Script แล้ว', ar: 'تم حفظ عنوان Apps Script' },
    'כתובת הוסרה': { th: 'ลบ URL แล้ว', ar: 'تم حذف العنوان' },

    // ── Worklog default actions (agricultural terms) ──
    'איגוז': { th: 'เก็บถั่ว', ar: 'جمع المكسرات' },
    'בדיקת השקייה תקופתית': { th: 'ตรวจสอบระบบน้ำประจำ', ar: 'فحص ري دوري' },
    'גדיד': { th: 'ตัดกาบ', ar: 'تقليم السعف' },
    'גיזום וניקוי אשלים וחוטרים עודפים': { th: 'ตัดแต่งทางใบเกิน', ar: 'تقليم وتنظيف السعف والأغصان الزائدة' },
    'גיזום חורפי': { th: 'ตัดแต่งฤดูหนาว', ar: 'تقليم شتوي' },
    'גיזום תמרים במושב': { th: 'ตัดแต่งอินทผลัมที่โมชาฟ', ar: 'تقليم التمور في الموشاف' },
    'דילול ראשוני': { th: 'ตัดแต่งช่อครั้งแรก', ar: 'خف أولي' },
    'דילול שני': { th: 'ตัดแต่งช่อครั้งที่สอง', ar: 'خف ثاني' },
    'הגמעת גימיק': { th: 'ใส่สาร Gimmick', ar: 'تطبيق جيميك' },
    'הגמעת קונפידור - חידקונית, קרנפית, ציקדות': { th: 'ใส่ Confidor - แมลงสกาล, ดอกกะหล่ำ, เพลี้ยจักจั่น', ar: 'تطبيق كونفيدور - بق دقيقي, قرنبيطية, حشرات قافزة' },
    'הורדת שקים': { th: 'ถอดถุง', ar: 'إنزال الأكياس' },
    'הכנת חדר אבקה': { th: 'เตรียมห้องเกสร', ar: 'تجهيز غرفة اللقاح' },
    'הפרייה': { th: 'ผสมเกสร', ar: 'تلقيح' },
    'השלמת נטיעה': { th: 'ปลูกเสริม', ar: 'استكمال الزراعة' },
    'טיפול שוטף לכלי גובה': { th: 'บำรุงเครื่องมือยกสูง', ar: 'صيانة معدات الارتفاع' },
    'נקיון מט"ש': { th: 'ทำความสะอาดบ่อบำบัดน้ำ', ar: 'تنظيف محطة المعالجة' },
    'נקיון מטע כללי': { th: 'ทำความสะอาดสวนทั่วไป', ar: 'تنظيف بستان عام' },
    'סידור גזם חורפי לאיסוף': { th: 'จัดกิ่งไม้ตัดสำหรับเก็บ', ar: 'ترتيب التقليم الشتوي للجمع' },
    'סילוק עורלה': { th: 'กำจัดต้นอ่อน', ar: 'إزالة النباتات غير المرغوبة' },
    'סיקול אבנים': { th: 'เก็บหิน', ar: 'إزالة الحجارة' },
    'עטיפה': { th: 'ห่อช่อผล', ar: 'تغليف' },
    'עשבייה מטעים כללי': { th: 'กำจัดวัชพืชทั่วไป', ar: 'إزالة أعشاب عامة' },
    'קיפניס - יישור קרקע': { th: 'ปรับระดับดิน', ar: 'تسوية التربة' },
    'קשירה': { th: 'ผูกมัด', ar: 'ربط' },
    'קשירה ושקים': { th: 'ผูกและถุง', ar: 'ربط وأكياس' },
    'קשירת זכרים והפקת אבקה': { th: 'ผูกต้นตัวผู้และเก็บเกสร', ar: 'ربط الذكور واستخراج اللقاح' },
    'ריסוס אקריות': { th: 'พ่นยากำจัดไรแดง', ar: 'رش عناكبيات' },
    'ריסוס בקתוש': { th: 'พ่นยากำจัดแบคเตอช', ar: 'رش بكتوش' },
    'ריסוס גזע לחידקונית': { th: 'พ่นยาลำต้นกำจัดแมลงสกาล', ar: 'رش جذع للبق الدقيقي' },
    'ריסוס כווייה שחורה - ריסוס צמרות': { th: 'พ่นยาโรคดำ - พ่นยอด', ar: 'رش حرق أسود - رش قمم' },
    'ריסוס עשבייה': { th: 'พ่นยากำจัดวัชพืช', ar: 'رش أعشاب' },
    'ריסוס עת"ק': { th: 'พ่นยา ATAQ', ar: 'رش عتق' },
    'נטיעה': { th: 'ปลูก', ar: 'زراعة' },
    'ריסוק': { th: 'บด', ar: 'سحق' },
    'שטיפת שקים': { th: 'ล้างถุง', ar: 'غسل أكياس' },
    'תחזוקת גדר חשמלית': { th: 'บำรุงรักษารั้วไฟฟ้า', ar: 'صيانة سياج كهربائي' },
    'קטיף לולבים': { th: 'เก็บเกี่ยวลูลาฟ', ar: 'قطف لولاف' },
    'מיון ושימור לולבים': { th: 'คัดแยกและเก็บรักษาลูลาฟ', ar: 'فرز وحفظ لولاف' },
    'קידוח גזע לחידקונית': { th: 'เจาะลำต้นกำจัดแมลงสกาล', ar: 'حفر جذع للبق الدقيقي' },
    'הדרכות': { th: 'การฝึกอบรม', ar: 'تدريبات' },
    'העברת/איסוף שקים': { th: 'ย้าย/เก็บถุง', ar: 'نقل/جمع أكياس' },
    'שקים': { th: 'ถุง', ar: 'أكياس' },
    'ראיס/מנהל עבודה': { th: 'หัวหน้างาน', ar: 'رئيس/مدير عمل' },

    // ── Budget categories ──
    'הורדת רשת/שקים': { th: 'ถอดตาข่าย/ถุง', ar: 'إنزال شباك/أكياس' },
    'טיפול קרקע ואחזקה': { th: 'ดูแลดินและบำรุงรักษา', ar: 'معالجة التربة والصيانة' },
    'לולבים': { th: 'ลูลาฟ', ar: 'لولاف' },

    // ── Worker groups (transliteration + descriptive) ──
    'תאילנדים שורשים': { th: 'ไทยชอราชิม', ar: 'تايلانديون شوراشيم' },
    'תאילנדים גלגל': { th: 'ไทยกัลกัล', ar: 'تايلانديون جلجل' },
    'תאילנדים ייטב': { th: 'ไทยเยทาฟ', ar: 'تايلانديون ييطاف' },
    'נפאלים': { th: 'เนปาล', ar: 'نيباليون' },
    'סרילנקה': { th: 'ศรีลังกา', ar: 'سريلانكا' },
    'מלאווים': { th: 'มาลาวี', ar: 'ملاويون' },
    'פלסטינאים': { th: 'ปาเลสไตน์', ar: 'فلسطينيون' },
    'ישראלים': { th: 'อิสราเอล', ar: 'إسرائيليون' },
    'מתנדבים': { th: 'อาสาสมัคร', ar: 'متطوعون' },
    'קבלנות פרדסים': { th: 'ผู้รับเหมาสวน', ar: 'مقاولات بساتين' },
    'פרדס איימן': { th: 'สวนอัยมาน', ar: 'بستان أيمن' },
    'עובדי גד"ש מפנמה': { th: 'คนงาน กดช ปานามา', ar: 'عمال جدش بنما' },
    'שומר חדש': { th: 'ผู้คุ้มกันใหม่', ar: 'حارس جديد' },
    'אלון עובדיה': { th: 'อาลอน โอวาเดีย', ar: 'ألون عوفاديا' },
    'ארנון צור': { th: 'อาร์นอน ซูร์', ar: 'أرنون تسور' },
    'זיו ליבה': { th: 'ซีฟ ลิวา', ar: 'زيف ليفا' },
    'נערן': { th: 'นาอาราน', ar: 'نعران' },
    'אגוזי': { th: 'อะกูซี', ar: 'أجوزي' },
    'דיירי': { th: 'ดายรี', ar: 'ديري' },
    'הלאלי': { th: 'ฮะลาลี', ar: 'هلالي' },
    'רוחקין': { th: 'รูฮาคิน', ar: 'روحكين' },
    'בראשית': { th: 'เบเรชิต', ar: 'بريشيت' },
    'סנסן ודקל': { th: 'ซันซัน เว ดาเคล', ar: 'سنسن ودقل' },
    'אדיר שלמה': { th: 'อาดีร์ ชโลโม', ar: 'أدير شلومو' },
    'יובל בן עמי': { th: 'ยูวาล เบ็น อามี', ar: 'يوفال بن عمي' },

    // ── Missing entries from audit (v1.2) ──
    'גידולים': { th: 'พืชผล', ar: 'محاصيل' },
    'גידול': { th: 'พืช', ar: 'محصول' },
    'גיזום': { th: 'ตัดแต่งกิ่ง', ar: 'تقليم' },
    'הוסף לרשימה': { th: 'เพิ่มในรายการ', ar: 'إضافة إلى القائمة' },
    'לא נמצאו תוצאות': { th: 'ไม่พบผลลัพธ์', ar: 'لم يتم العثور على نتائج' },
    'צפה בתווית הרשמית': { th: 'ดูฉลากทางการ', ar: 'عرض الملصق الرسمي' },
    'תווית זמינה': { th: 'มีฉลาก', ar: 'الملصق متاح' },
    'תכשירים': { th: 'สารเคมี', ar: 'مبيدات' },
    'תכשירים רשומים': { th: 'สารเคมีที่จดทะเบียน', ar: 'مبيدات مسجلة' },
    'קיוץ': { th: 'ตัดแต่ง', ar: 'تقليم' },
    'שעה': { th: 'ชั่วโมง', ar: 'ساعة' },

    // ── Name-translation UI (for plots, farms, crops) ──
    'שם בעברית': { th: 'ชื่อภาษาฮีบรู', ar: 'الاسم بالعبرية' },
    'שם בתאית': { th: 'ชื่อภาษาไทย', ar: 'الاسم بالتايلاندية' },
    'שם בערבית': { th: 'ชื่อภาษาอาหรับ', ar: 'الاسم بالعربية' },
    'תרגומים (אופציונלי)': { th: 'การแปล (ไม่บังคับ)', ar: 'الترجمات (اختياري)' },
    'תרגומים': { th: 'การแปล', ar: 'الترجمات' },
    'אופציונלי': { th: 'ไม่บังคับ', ar: 'اختياري' },

    // ── Field-report severity labels ──
    'נקי': { th: 'สะอาด', ar: 'نظيف' },
    'קל': { th: 'เล็กน้อย', ar: 'خفيف' },
    'בינוני': { th: 'ปานกลาง', ar: 'متوسط' },
    'חמור': { th: 'รุนแรง', ar: 'شديد' },
    'קריטי': { th: 'วิกฤต', ar: 'حرج' },

    // ── Field-report pest catalogue ──
    'חיפושית דקל אדומה': { th: 'ด้วงแดงปาล์ม', ar: 'سوسة النخيل الحمراء' },
    'כנימת מגן': { th: 'เพลี้ยหอย', ar: 'بق دقيقي' },
    'חדקונית הדקל': { th: 'งวงปาล์ม', ar: 'سوسة النخيل' },
    'עש התמר': { th: 'ผีเสื้อกลางคืนอินทผลัม', ar: 'فراشة التمر' },
    'זבוב הפירות': { th: 'แมลงวันผลไม้', ar: 'ذبابة الفاكهة' },
    'נמלים': { th: 'มด', ar: 'نمل' },
    'עכבישים אדומים': { th: 'ไรแดง', ar: 'العنكبوت الأحمر' },
    'כנימת עלה': { th: 'เพลี้ยอ่อน', ar: 'حشرات المن' },
    'ביוד (Bayoud)': { th: 'ไบยุด (Bayoud)', ar: 'البيوض (Bayoud)' },
    'כתמי עלים': { th: 'จุดใบ', ar: 'بقع الأوراق' },
    'הכהיית פרי': { th: 'ผลคล้ำ', ar: 'اسوداد الثمار' },

    // ── Field-report location chips (on the tree/plant) ──
    'גזע': { th: 'ลำต้น', ar: 'الجذع' },
    'עלים': { th: 'ใบ', ar: 'الأوراق' },
    'פרי': { th: 'ผล', ar: 'الثمار' },
    'צמרת': { th: 'ยอด', ar: 'القمة' },
    'שורשים': { th: 'ราก', ar: 'الجذور' },
    'תפרחת': { th: 'ช่อดอก', ar: 'النورة' },

    // ── Display-settings theme names ──
    'קלאסי (בהיר)': { th: 'คลาสสิก (สว่าง)', ar: 'كلاسيكي (فاتح)' },
    'יער ניאון': { th: 'ป่านีออน', ar: 'غابة النيون' },
    'ברקת זוהרת': { th: 'มรกตเรืองแสง', ar: 'زمرد متوهج' },
    'שעת הזהב': { th: 'ชั่วโมงทอง', ar: 'الساعة الذهبية' },
    'אוקיינוס עמוק': { th: 'มหาสมุทรลึก', ar: 'المحيط العميق' },
    'לילות ערבה': { th: 'ค่ำคืนทะเลทราย', ar: 'ليالي العربة' },

    // ── Meckano upgrade — Phase 1 ──
    'רדיוס גיאופנס לנוכחות': { th: 'รัศมีจีโอเฟนซ์สำหรับเข้างาน', ar: 'نطاق التموقع للحضور' },
    '(מטר, ברירת מחדל 100)': { th: '(เมตร, ค่าเริ่มต้น 100)', ar: '(متر، الافتراضي 100)' },
    'רדיוס גיאופנס חייב להיות בין 20 ל-500 מטר': { th: 'รัศมีต้องอยู่ระหว่าง 20-500 เมตร', ar: 'النطاق يجب أن يكون بين 20 و500 متر' },
    'במצב לא מקוון': { th: 'ออฟไลน์', ar: 'غير متصل' },
    'הרשומה תסונכרן כשתחזור לאינטרנט': { th: 'จะซิงค์เมื่อกลับมาออนไลน์', ar: 'سيُزامن عند العودة للإنترنت' },
    'הרשומה סונכרנה': { th: 'ซิงค์รายการแล้ว', ar: 'تمت مزامنة السجل' },
    'סיבת העריכה': { th: 'เหตุผลในการแก้ไข', ar: 'سبب التعديل' },
    'אופציונלי - יישמר ביומן הביקורת': { th: 'ไม่บังคับ - บันทึกใน audit log', ar: 'اختياري - يُسجل في سجل التدقيق' },
    'יומן ביקורת': { th: 'บันทึกการตรวจสอบ', ar: 'سجل التدقيق' },

    // ── Meckano upgrade — Phase 2 (geo + breaks + override) ──
    'מאתר מיקום...': { th: 'กำลังระบุตำแหน่ง...', ar: 'جاري تحديد الموقع...' },
    'מחוץ לטווח': { th: 'นอกพื้นที่', ar: 'خارج النطاق' },
    'ללא GPS': { th: 'ไม่มี GPS', ar: 'بدون GPS' },
    'דיוק נמוך': { th: 'ความแม่นยำต่ำ', ar: 'دقة منخفضة' },
    'אושר ידנית': { th: 'อนุมัติด้วยตนเอง', ar: 'تم الاعتماد يدوياً' },
    'ממתין לאישור': { th: 'รออนุมัติ', ar: 'بانتظار الاعتماد' },
    'אשר ידנית': { th: 'อนุมัติด้วยตนเอง', ar: 'اعتماد يدوي' },
    'סיבת אישור ידני (חובה):': { th: 'เหตุผลในการอนุมัติด้วยตนเอง (จำเป็น):', ar: 'سبب الاعتماد اليدوي (مطلوب):' },
    'חייב לציין סיבה': { th: 'ต้องระบุเหตุผล', ar: 'يجب ذكر السبب' },
    'מיקום': { th: 'ตำแหน่ง', ar: 'الموقع' },
    'דיוק': { th: 'ความแม่นยำ', ar: 'الدقة' },
    'כניסה': { th: 'เข้า', ar: 'دخول' },
    'יציאה': { th: 'ออก', ar: 'خروج' },
    // Breaks
    'הפסקות': { th: 'พัก', ar: 'استراحات' },
    'הפסקה': { th: 'พัก', ar: 'استراحة' },
    'סוג הפסקה': { th: 'ประเภทการพัก', ar: 'نوع الاستراحة' },
    'הפסקת אוכל': { th: 'พักทานข้าว', ar: 'استراحة طعام' },
    'הפסקה קצרה': { th: 'พักสั้น', ar: 'استراحة قصيرة' },
    'הפסקה אישית': { th: 'พักส่วนตัว', ar: 'استراحة شخصية' },
    'בהפסקת אוכל': { th: 'พักทานข้าว', ar: 'في استراحة طعام' },
    'בהפסקה': { th: 'พัก', ar: 'في استراحة' },
    'בהפסקה אישית': { th: 'พักส่วนตัว', ar: 'في استراحة شخصية' },
    'התחל הפסקה': { th: 'เริ่มพัก', ar: 'بدء استراحة' },
    '▶️ סיים הפסקה': { th: '▶️ สิ้นสุดพัก', ar: '▶️ إنهاء الاستراحة' },
    'הפסקה הסתיימה': { th: 'สิ้นสุดการพัก', ar: 'انتهت الاستراحة' },
    'הופחתה הפסקה אוטומטית': { th: 'หักพักอัตโนมัติ', ar: 'تم خصم استراحة تلقائياً' },
    'אוטומטי': { th: 'อัตโนมัติ', ar: 'تلقائي' },
    'דקות': { th: 'นาที', ar: 'دقيقة' },

    // ── Meckano upgrade — Phase 3 (schedules + OT) ──
    'לוח זמנים': { th: 'ตารางเวลา', ar: 'جدول العمل' },
    'לוחות זמנים': { th: 'ตารางเวลา', ar: 'جداول العمل' },
    'השבוע שלי': { th: 'สัปดาห์ของฉัน', ar: 'أسبوعي' },
    'שעות': { th: 'ชั่วโมง', ar: 'ساعات' },
    'רגיל': { th: 'ปกติ', ar: 'عادي' },
    'שעות נוספות': { th: 'โอที', ar: 'إضافي' },
    'איחור': { th: 'สาย', ar: 'تأخر' },
    'איחורים': { th: 'สาย', ar: 'تأخيرات' },
    'יציאה מוקדמת': { th: 'ออกก่อน', ar: 'مغادرة مبكرة' },
    'יציאות מוקדמות': { th: 'ออกก่อน', ar: 'مغادرات مبكرة' },
    'מגזר (קובע ברירות מחדל למשעות נוספות)': { th: 'ภาคส่วน (กำหนดค่าเริ่มต้น OT)', ar: 'القطاع (يحدد القيم الافتراضية للساعات الإضافية)' },
    'דקות מרווח לאיחור': { th: 'นาทีผ่อนผันสาย', ar: 'دقائق التسامح' },
    'כללי שעות נוספות מותאמים אישית': { th: 'กฎโอที กำหนดเอง', ar: 'قواعد ساعات إضافية مخصصة' },
    'עקוף את ברירות המגזר': { th: 'แทนที่ค่าเริ่มต้นภาคส่วน', ar: 'تجاوز افتراضيات القطاع' },
    'עד שעות': { th: 'สูงสุดชั่วโมง', ar: 'حتى ساعات' },
    'שעון לילה (החל מ-)': { th: 'เวลากลางคืน (เริ่ม)', ar: 'بداية الليل' },
    'שעון לילה (עד)': { th: 'เวลากลางคืน (สิ้น)', ar: 'نهاية الليل' },
    'תקרה שבועית': { th: 'สูงสุดต่อสัปดาห์', ar: 'الحد الأسبوعي' },
    'יום חופש': { th: 'วันหยุด', ar: 'يوم عطلة' },
    'לוח הזמנים נשמר': { th: 'บันทึกตารางแล้ว', ar: 'تم حفظ الجدول' },
    "א'": { th: 'อา', ar: 'الأحد' },
    "ב'": { th: 'จ', ar: 'الاثنين' },
    "ג'": { th: 'อ', ar: 'الثلاثاء' },
    "ד'": { th: 'พ', ar: 'الأربعاء' },
    "ה'": { th: 'พฤ', ar: 'الخميس' },
    "ו'": { th: 'ศ', ar: 'الجمعة' },
    'שבת': { th: 'ส', ar: 'السبت' },
    'חופש': { th: 'หยุด', ar: 'عطلة' },
    'פסקה': { th: 'พัก', ar: 'ك.د' },
    'טוען...': { th: 'กำลังโหลด...', ar: 'جاري التحميل...' },

    // ── Meckano upgrade — Phase 4 (leave management) ──
    'החופשות שלי': { th: 'การลาของฉัน', ar: 'إجازاتي' },
    'חופשות שלי': { th: 'การลาของฉัน', ar: 'إجازاتي' },
    'תור אישורים': { th: 'คิวอนุมัติ', ar: 'قائمة الاعتماد' },
    'חגי ישראל': { th: 'วันหยุดอิสราเอล', ar: 'الأعياد الإسرائيلية' },
    'יומן חגי ישראל': { th: 'ปฏิทินวันหยุดอิสราเอล', ar: 'تقويم الأعياد الإسرائيلية' },
    'בקשת חופשה חדשה': { th: 'ขอลาใหม่', ar: 'طلب إجازة جديدة' },
    'בקשת חופשה': { th: 'ขอลา', ar: 'طلب إجازة' },
    'היסטוריית בקשות': { th: 'ประวัติการลา', ar: 'سجل الطلبات' },
    'מתאריך': { th: 'จาก', ar: 'من تاريخ' },
    'עד תאריך': { th: 'ถึง', ar: 'إلى تاريخ' },
    'יום ראשון': { th: 'วันแรก', ar: 'يوم البداية' },
    'יום אחרון': { th: 'วันสุดท้าย', ar: 'يوم النهاية' },
    'יום מלא': { th: 'ทั้งวัน', ar: 'يوم كامل' },
    'חצי - בוקר': { th: 'ครึ่งเช้า', ar: 'صباحاً' },
    'חצי - אחה"צ': { th: 'ครึ่งบ่าย', ar: 'بعد الظهر' },
    'סיבה / פרטים': { th: 'เหตุผล', ar: 'السبب' },
    'אופציונלי': { th: 'ไม่บังคับ', ar: 'اختياري' },
    'סה"כ ימי עבודה': { th: 'รวมวันทำงาน', ar: 'إجمالي أيام العمل' },
    'ימים': { th: 'วัน', ar: 'أيام' },
    'זמינים': { th: 'ใช้ได้', ar: 'متاح' },
    'סהכ': { th: 'รวม', ar: 'إجمالي' },
    'ממתינים': { th: 'รอ', ar: 'قيد الانتظار' },
    'ממתין': { th: 'รอ', ar: 'قيد الانتظار' },
    'אושר': { th: 'อนุมัติแล้ว', ar: 'تمت الموافقة' },
    'נדחה': { th: 'ปฏิเสธ', ar: 'مرفوض' },
    'בוטל': { th: 'ยกเลิก', ar: 'ملغى' },
    'הבקשה נשלחה': { th: 'ส่งคำขอแล้ว', ar: 'تم إرسال الطلب' },
    'אין בקשות': { th: 'ไม่มีคำขอ', ar: 'لا توجد طلبات' },
    'אין בקשות ממתינות': { th: 'ไม่มีคำขอรอ', ar: 'لا طلبات معلقة' },
    'בקשת חופש': { th: 'ขอลา', ar: 'طلب إجازة' },
    'אשר': { th: 'อนุมัติ', ar: 'اعتماد' },
    'דחה': { th: 'ปฏิเสธ', ar: 'رفض' },
    'סיבת דחייה (חובה):': { th: 'เหตุผลในการปฏิเสธ (จำเป็น):', ar: 'سبب الرفض (مطلوب):' },
    'לבטל את הבקשה?': { th: 'ยกเลิกคำขอ?', ar: 'إلغاء الطلب؟' },
    'יתרת חופשה לא מספיקה': { th: 'พักร้อนไม่พอ', ar: 'رصيد الإجازة غير كافٍ' },
    'יתרת מחלה לא מספיקה': { th: 'ลาป่วยไม่พอ', ar: 'رصيد المرضية غير كافٍ' },
    'אין ימי עבודה בטווח': { th: 'ไม่มีวันทำงานในช่วงนี้', ar: 'لا أيام عمل في النطاق' },
    'חסר תאריך': { th: 'ขาดวันที่', ar: 'تاريخ ناقص' },
    'תאריך סיום לפני תחילה': { th: 'วันที่สิ้นสุดก่อนเริ่ม', ar: 'تاريخ النهاية قبل البداية' },
    'מייבא חגי ישראל...': { th: 'กำลังนำเข้า...', ar: 'جاري الاستيراد...' },
    'הייבוא הושלם': { th: 'นำเข้าเสร็จสิ้น', ar: 'اكتمل الاستيراد' },
    'ייבא מ-Hebcal': { th: 'นำเข้าจาก Hebcal', ar: 'استيراد من Hebcal' },
    'צור רשומות': { th: 'สร้างรายการ', ar: 'إنشاء سجلات' },
    'יוצר רשומות...': { th: 'กำลังสร้าง...', ar: 'جاري الإنشاء...' },
    'רשומות נוצרו': { th: 'สร้างแล้ว', ar: 'تم إنشاؤها' },
    'ליצור רשומות חופש לחגים?': { th: 'สร้างรายการลาวันหยุด?', ar: 'إنشاء سجلات إجازة العيد؟' },
    'לא קיימים נתונים — לחץ "ייבא מ-Hebcal"': { th: 'ยังไม่มีข้อมูล - กด "นำเข้าจาก Hebcal"', ar: 'لا توجد بيانات — اضغط "استيراد من Hebcal"' },
    'שלח': { th: 'ส่ง', ar: 'إرسال' },
    'חזור': { th: 'กลับ', ar: 'رجوع' },
    'בטל': { th: 'ยกเลิก', ar: 'إلغاء' },
    'סוג': { th: 'ประเภท', ar: 'النوع' },
    // Leave types
    'חופשה': { th: 'พักร้อน', ar: 'إجازة سنوية' },
    'מחלה': { th: 'ลาป่วย', ar: 'إجازة مرضية' },
    'מילואים': { th: 'รับราชการทหาร', ar: 'احتياط عسكري' },
    'אישית': { th: 'ลากิจ', ar: 'إجازة شخصية' },
    'ללא תשלום': { th: 'ลาไม่รับเงิน', ar: 'إجازة بدون راتب' },
    'לידה': { th: 'ลาคลอด', ar: 'إجازة أمومة' },
    'אבל': { th: 'ไว้ทุกข์', ar: 'حداد' },
    'חג': { th: 'วันหยุดราชการ', ar: 'عطلة رسمية' },

    // ── Auth deep-refresh (QA pass) ──
    'מסנכרן הרשאות...': { th: 'กำลังซิงค์สิทธิ์...', ar: 'مزامنة الصلاحيات...' },
    'סנכרון הרשאות נכשל — חלק מהפעולות עלולות להיכשל': { th: 'ซิงค์สิทธิ์ไม่สำเร็จ - บางการดำเนินการอาจล้มเหลว', ar: 'فشل مزامنة الصلاحيات — قد تفشل بعض العمليات' },
    'סנכרן הרשאות מחדש': { th: 'ซิงค์สิทธิ์ใหม่', ar: 'إعادة مزامنة الصلاحيات' },
    'הרשאות סונכרנו מחדש': { th: 'ซิงค์สิทธิ์ใหม่แล้ว', ar: 'تمت إعادة المزامنة' },
    'חזרה לרשימת פרויקטים': { th: 'กลับไปยังรายการ', ar: 'العودة لقائمة المشاريع' },
    'מחק פרויקט': { th: 'ลบโครงการ', ar: 'حذف المشروع' },

    // ── Menu reorganization + multi-source holidays ──
    'השעות שלי': { th: 'ชั่วโมงของฉัน', ar: 'ساعاتي' },
    'מחלקת תחזוקה': { th: 'แผนกซ่อมบำรุง', ar: 'قسم الصيانة' },
    'חגים': { th: 'วันหยุด', ar: 'الأعياد' },
    'יומן חגים': { th: 'ปฏิทินวันหยุด', ar: 'تقويم الأعياد' },
    'ישראל': { th: 'อิสราเอล', ar: 'إسرائيل' },
    'תאילנד': { th: 'ไทย', ar: 'تايلاند' },
    'איסלאם': { th: 'อิสลาม', ar: 'إسلامي' },
    'שמור סימונים': { th: 'บันทึก', ar: 'حفظ التحديد' },
    'סימונים נשמרו': { th: 'บันทึกการเลือกแล้ว', ar: 'تم حفظ التحديد' },
    'סמן הכל': { th: 'เลือกทั้งหมด', ar: 'تحديد الكل' },
    'נקה הכל': { th: 'ล้างทั้งหมด', ar: 'إلغاء الكل' },
    'אין נתונים. לחץ "ייבא"': { th: 'ไม่มีข้อมูล กด "นำเข้า"', ar: 'لا توجد بيانات — اضغط "استيراد"' },
    'מייבא חגים ישראליים...': { th: 'กำลังนำเข้าวันหยุดอิสราเอล...', ar: 'جاري استيراد الأعياد الإسرائيلية...' },
    'מייבא חגים תאילנדיים...': { th: 'กำลังนำเข้าวันหยุดไทย...', ar: 'جاري استيراد الأعياد التايلاندية...' },
    'מייבא חגי איסלאם...': { th: 'กำลังนำเข้าวันหยุดอิสลาม...', ar: 'جاري استيراد الأعياد الإسلامية...' },
    'חגים נטענו': { th: 'วันหยุดถูกโหลด', ar: 'أعياد تم تحميلها' },
    'ליצור רשומות חופש לחגים המסומנים?': { th: 'สร้างรายการลาวันหยุดที่เลือก?', ar: 'إنشاء سجلات إجازة العيد للأعياد المحددة؟' },
    'כל עובד מקבל רק חגים תואמים לשפה המוגדרת לו': { th: 'พนักงานแต่ละคนได้รับเฉพาะวันหยุดที่ตรงกับภาษาที่ตั้งไว้', ar: 'يحصل كل عامل فقط على العطل المطابقة للغته' },
    'שפה': { th: 'ภาษา', ar: 'اللغة' },
    'קובע אילו חגים מופיעים בלוח של העובד': { th: 'กำหนดวันหยุดที่จะแสดงในปฏิทินของพนักงาน', ar: 'يحدد العطل الظاهرة في تقويم العامل' },


    // ── Toast messages (success/error) ──
    'חובה למלא תאריך ושם מפעיל': { th: 'ต้องกรอกวันที่และชื่อผู้ปฏิบัติ', ar: 'يجب إدخال التاريخ واسم المشغل' },
    'בחר לפחות חלקה אחת': { th: 'เลือกอย่างน้อยหนึ่งแปลง', ar: 'اختر قطعة واحدة على الأقل' },
    'בחר לפחות חומר הדברה אחד': { th: 'เลือกสารเคมีอย่างน้อยหนึ่งชนิด', ar: 'اختر مبيداً واحداً على الأقل' },
    'אין יומני ריסוס לייצוא': { th: 'ไม่มีบันทึกการพ่นสำหรับส่งออก', ar: 'لا توجد سجلات رش للتصدير' },
    'קובץ HTML הורד': { th: 'ดาวน์โหลดไฟล์ HTML แล้ว', ar: 'تم تنزيل ملف HTML' },
    'חומר נמחק': { th: 'ลบสารเคมีแล้ว', ar: 'تم حذف المبيد' },
    'חובה למלא שם מסחרי וחומר פעיל': { th: 'ต้องกรอกชื่อการค้าและสารออกฤทธิ์', ar: 'يجب إدخال الاسم التجاري والمادة الفعالة' },
    'חומר עודכן': { th: 'อัปเดตสารเคมีแล้ว', ar: 'تم تحديث المبيد' },
    'חומר נוסף': { th: 'เพิ่มสารเคมีแล้ว', ar: 'تمت إضافة المبيد' },
    'מטע נמחק': { th: 'ลบสวนแล้ว', ar: 'تم حذف البستان' },
    'חובה למלא שם מטע': { th: 'ต้องกรอกชื่อสวน', ar: 'يجب إدخال اسم البستان' },
    'שם מטע כבר קיים': { th: 'ชื่อสวนมีอยู่แล้ว', ar: 'اسم البستان موجود بالفعل' },
    'מטע עודכן': { th: 'อัปเดตสวนแล้ว', ar: 'تم تحديث البستان' },
    'לא מחובר': { th: 'ไม่ได้เชื่อมต่อ', ar: 'غير متصل' },
    'מטע נוסף': { th: 'เพิ่มสวนแล้ว', ar: 'تمت إضافة البستان' },
    'משתמש נמחק': { th: 'ลบผู้ใช้แล้ว', ar: 'تم حذف المستخدم' },
    'חובה למלא שם ואימייל': { th: 'ต้องกรอกชื่อและอีเมล', ar: 'يجب إدخال الاسم والبريد' },
    'משתמש עודכן': { th: 'อัปเดตผู้ใช้แล้ว', ar: 'تم تحديث المستخدم' },
    'אימייל כבר קיים': { th: 'อีเมลมีอยู่แล้ว', ar: 'البريد موجود بالفعل' },
    'מזהי גיליונות נשמרו': { th: 'บันทึก Sheet ID แล้ว', ar: 'تم حفظ معرفات الجداول' },
    'לא הוגדר גיליון למטע זה': { th: 'ยังไม่กำหนด Sheet สำหรับสวนนี้', ar: 'لم يتم تحديد جدول لهذا البستان' },
    'לא הוגדר כתובת Apps Script': { th: 'ยังไม่กำหนด URL ของ Apps Script', ar: 'لم يتم تحديد عنوان Apps Script' },
    'נתוני השקייה עודכנו': { th: 'อัปเดตข้อมูลการให้น้ำแล้ว', ar: 'تم تحديث بيانات الري' },
    'תעודת משלוח נוספה': { th: 'เพิ่มใบส่งสินค้าแล้ว', ar: 'تمت إضافة وصل التوريد' },
    'מלאי חומרים עודכן': { th: 'อัปเดตสต็อกสารเคมีแล้ว', ar: 'تم تحديث مخزون المبيدات' },
    'נתונים עודכנו': { th: 'อัปเดตข้อมูลแล้ว', ar: 'تم تحديث البيانات' },
    'שיוך מגופים נשמר': { th: 'บันทึกการเชื่อมต่อวาล์วแล้ว', ar: 'تم حفظ ربط الصمامات' },
    'הוסר': { th: 'ถูกลบ', ar: 'أُزيل' },
    'שוחזר': { th: 'กู้คืนแล้ว', ar: 'تمت الاستعادة' },
    'לא ניתן למחוק': { th: 'ไม่สามารถลบได้', ar: 'لا يمكن الحذف' },
    'במטע זה': { th: 'ในสวนนี้', ar: 'في هذا البستان' },
    'הצג היסטוריה מלאה': { th: 'ดูประวัติทั้งหมด', ar: 'عرض السجل الكامل' },
    'רשומות נוספות': { th: 'รายการเพิ่มเติม', ar: 'سجلات إضافية' },
    'רשומות': { th: 'รายการ', ar: 'سجلات' },
    'כתובת לא תקינה': { th: 'URL ไม่ถูกต้อง', ar: 'عنوان غير صالح' },


    // ── HTML static elements ──
    'אין חיבור — נתונים יסונכרנו כשהחיבור יחזור': { th: 'ไม่มีสัญญาณ — ข้อมูลจะซิงค์เมื่อเชื่อมต่อ', ar: 'لا يوجد اتصال — ستتم المزامنة عند عودة الاتصال' },
    'חזר חיבור — מסנכרן נתונים': { th: 'เชื่อมต่อแล้ว — กำลังซิงค์ข้อมูล', ar: 'عاد الاتصال — جاري المزامنة' },
    'אין חיבור — עובד במצב לא מקוון': { th: 'ไม่มีสัญญาณ — ทำงานแบบออฟไลน์', ar: 'لا يوجد اتصال — العمل بدون إنترنت' },
    'תפריט': { th: 'เมนู', ar: 'القائمة' },
    'בטל פעולה': { th: 'ยกเลิกการกระทำ', ar: 'تراجع' },
    'המיקום שלי': { th: 'ตำแหน่งของฉัน', ar: 'موقعي' },
    'שפה': { th: 'ภาษา', ar: 'اللغة' },
    'בטל נקודה': { th: 'ยกเลิกจุด', ar: 'تراجع عن النقطة' },
    'בטל': { th: 'ยกเลิก', ar: 'تراجع' },
    'שמור יומן ריסוס': { th: 'บันทึกการพ่น', ar: 'حفظ سجل الرش' },
    'הוסף מטע חדש': { th: 'เพิ่มสวนใหม่', ar: 'إضافة بستان جديد' },
    'הוסף משתמש': { th: 'เพิ่มผู้ใช้', ar: 'إضافة مستخدم' },
    'הוסף חומר': { th: 'เพิ่มสารเคมี', ar: 'إضافة مبيد' },
    'יצוא CSV': { th: 'ส่งออก CSV', ar: 'تصدير CSV' },
    'יצוא ל-Google Sheets': { th: 'ส่งออกไป Google Sheets', ar: 'تصدير إلى Google Sheets' },
    'חיפוש: שם, חומר פעיל, מזיק...': { th: 'ค้นหา: ชื่อ สารออกฤทธิ์ ศัตรูพืช...', ar: 'بحث: اسم، مادة فعالة، آفة...' },
    'כל הגידולים': { th: 'พืชทั้งหมด', ar: 'كل المحاصيل' },
    'בחר הכל': { th: 'เลือกทั้งหมด', ar: 'تحديد الكل' },
    'אין תוצאות לסינון הנוכחי': { th: 'ไม่มีผลลัพธ์สำหรับตัวกรองนี้', ar: 'لا نتائج لهذا التصفية' },
    'אין חומרים ליצוא': { th: 'ไม่มีสารเคมีให้ส่งออก', ar: 'لا مواد للتصدير' },
    'חומרים יוצאו ל-CSV': { th: 'สารเคมีถูกส่งออกเป็น CSV', ar: 'مواد صُدِّرت إلى CSV' },
    'חומרים הועתקו — הדבק בגיליון (Ctrl+V)': { th: 'คัดลอกแล้ว — วางในชีต (Ctrl+V)', ar: 'تم النسخ — الصق في الجدول (Ctrl+V)' },
    'העתקה נכשלה — נסה יצוא CSV': { th: 'คัดลอกล้มเหลว — ลองส่งออก CSV', ar: 'فشل النسخ — جرّب تصدير CSV' },
    'גידול': { th: 'พืช', ar: 'محصول' },
    'מזיקים/מטרות': { th: 'ศัตรูพืช/เป้าหมาย', ar: 'آفات/أهداف' },
    'מינון': { th: 'ปริมาณ', ar: 'جرعة' },
    'רעילות': { th: 'ความเป็นพิษ', ar: 'سمية' },
    'ידני': { th: 'ป้อนเอง', ar: 'يدوي' },
    'חיבור תלגיל': { th: 'เชื่อมต่อ Talgil', ar: 'اتصال Talgil' },
    'התחבר': { th: 'เชื่อมต่อ', ar: 'اتصال' },
    'הגדרות חיבור': { th: 'ตั้งค่าการเชื่อมต่อ', ar: 'إعدادات الاتصال' },
    'שיוך מגופים לחלקות': { th: 'ผูกวาล์วกับแปลง', ar: 'ربط الصمامات بالقطع' },
    'שמור שיוך': { th: 'บันทึกการผูก', ar: 'حفظ الربط' },
    'השקיה לפי חלקה': { th: 'การให้น้ำตามแปลง', ar: 'ري حسب القطعة' },
    'תוכניות השקיה': { th: 'โปรแกรมการให้น้ำ', ar: 'برامج الري' },
    'סיסמה': { th: 'รหัสผ่าน', ar: 'كلمة المرور' },
    'הוסף פעולה': { th: 'เพิ่มงาน', ar: 'إضافة عملية' },
    'הוסף קבוצה': { th: 'เพิ่มกลุ่ม', ar: 'إضافة مجموعة' },
    'לפי עובד': { th: 'ตามคนงาน', ar: 'حسب العامل' },
    'לפי חלקה': { th: 'ตามแปลง', ar: 'حسب القطعة' },
    'שמור כתובת': { th: 'บันทึก URL', ar: 'حفظ العنوان' },
    'פעולה': { th: 'งาน', ar: 'عملية' },

  };

  function t(hebrewText) {
    if (typeof currentLang === 'undefined' || currentLang === 'he') return hebrewText;
    if (typeof TRANSLATIONS === 'undefined') return hebrewText;
    var entry = TRANSLATIONS[hebrewText];
    if (entry && entry[currentLang]) return entry[currentLang];
    return hebrewText;
  }
  // Drawing state
  var drawMode = null;
  var polyPoints = [];
  var polyMarkers = [];
  var polyLine = null;
  var rectStart = null;
  var rectPreview = null;
  var gpsMarker = null;

  // ── Map ──
  // MAX_ZOOM caps how far in the user can go; MAX_NATIVE is the deepest
  // level Esri actually publishes imagery for. Without the cap Leaflet
  // happily zoomed past the available tiles and the map went blank —
  // it looked like the map had disappeared. With maxNativeZoom set, the
  // last level between them upscales real tiles instead of requesting
  // ones that do not exist, so there is no blank state at any zoom.
  // ── zoom and pan limits ────────────────────────────────────────────
  // MAX_ZOOM is how far the user may go in. MAX_NATIVE is the deepest level
  // we will actually REQUEST from the tile server; anything past it is
  // produced by upscaling a real tile, so there is no blank state.
  //
  // 18, not 19: Esri publishes high-resolution imagery at z19+ only in some
  // regions. Setting maxNativeZoom to a level the server does not hold for
  // the Jordan Valley and the Arava means it answers with nothing and the
  // map goes white — which is the "map disappears when I zoom in" problem.
  // z18 is available essentially everywhere in Israel, and z19 upscales it.
  var MAX_ZOOM = 19, MAX_NATIVE = 18, MIN_ZOOM = 6;

  // A neutral tile for anything that still fails, so a gap in coverage is a
  // grey square and not a hole in the page.
  var BLANK_TILE = 'data:image/svg+xml;base64,' + btoa(
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256">' +
    '<rect width="256" height="256" fill="#3a4a3f"/></svg>');

  // Israel and the immediate surroundings. Panning past this used to leave
  // the imagery entirely and land the user in grey void with no way back.
  var MAP_BOUNDS = L.latLngBounds(L.latLng(29.2, 33.8), L.latLng(33.5, 36.4));

  var map = L.map('map', {
    center: [31.8, 35.2], zoom: 13, zoomControl: false,
    maxZoom: MAX_ZOOM, minZoom: MIN_ZOOM,
    maxBounds: MAP_BOUNDS,
    maxBoundsViscosity: 0.85,     // firm edge, but not a hard wall
    bounceAtZoomLimits: true      // pinch past the limit springs back
  });
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  var satelliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri', maxZoom: MAX_ZOOM, maxNativeZoom: MAX_NATIVE,
    noWrap: true, bounds: MAP_BOUNDS, errorTileUrl: BLANK_TILE, keepBuffer: 2
  }).addTo(map);

  var streetLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: 'OpenStreetMap', maxZoom: MAX_ZOOM, maxNativeZoom: MAX_NATIVE,
    noWrap: true, bounds: MAP_BOUNDS, errorTileUrl: BLANK_TILE, keepBuffer: 2
  });

  // Coverage varies by region even below MAX_NATIVE. If a run of tiles fails
  // at the current level, step the native ceiling down once and redraw —
  // the user keeps zooming, the imagery just gets softer instead of vanishing.
  (function () {
    var fails = 0, floor = 15;
    satelliteLayer.on('tileerror', function () {
      fails++;
      if (fails < 6) return;
      fails = 0;
      var nz = satelliteLayer.options.maxNativeZoom;
      if (nz > floor) {
        satelliteLayer.options.maxNativeZoom = nz - 1;
        satelliteLayer.redraw();
      }
    });
    satelliteLayer.on('load', function () { fails = 0; });
  })();

  var drawnItems = new L.FeatureGroup();
  map.addLayer(drawnItems);

  // ── Elements ──
  var mapEl = document.getElementById('map');
  var fabMain = document.getElementById('fabMain');
  var fabOptions = document.getElementById('fabOptions');
  var drawBanner = document.getElementById('drawBanner');
  var undoPointBtn = document.getElementById('undoPointBtn');
  var panelEl = document.getElementById('panel');
  var undoBar = document.getElementById('undoBar');
  var undoBarText = document.getElementById('undoBarText');
  var undoBarBtn = document.getElementById('undoBarBtn');
  var undoActionBtn = document.getElementById('undoActionBtn');
  var undoTimer;

  function getUserFarms(user) {
    // Admin can access all farms
    if (user.role === 'admin') {
      return farms;
    }
    // Non-admin with no permissions sees nothing
    if (!user.farm_permissions || user.farm_permissions.length === 0) {
      return [];
    }
    return farms.filter(function(f) {
      return user.farm_permissions.indexOf(f.id) !== -1;
    });
  }

  function getAccessiblePlots() {
    if (!currentUser) return [];
    var session = JSON.parse(sessionStorage.getItem('currentUser'));
    if (!session) return [];
    
    // Admin sees all
    if (currentUser.role === 'admin') return plots;
    
    // Non-admin: filter by farm permissions
    var userFarms = getUserFarms(currentUser);
    var farmIds = userFarms.map(function(f) { return f.id; });
    
    return plots.filter(function(p) {
      return p.farm_id && farmIds.indexOf(p.farm_id) !== -1;
    });
  }

  // A record whose plots cannot be resolved: plotIds missing, empty, or
  // pointing at plot ids that no longer exist (a plot deleted, or moved
  // between farms after the record was written). These are the records that
  // went invisible in the log — nothing in the UI could reach them — while
  // still printing on exports as "לא ידוע · 0.00 דונם".
  function orphanState(e) {
    var ids = (e && e.plotIds) || [];
    if (!Array.isArray(ids) || !ids.length) return { orphan: true, missing: [], reason: 'no-plots' };
    var missing = ids.filter(function(id) {
      return !plots.some(function(p) { return p.id === id; });
    });
    if (missing.length === ids.length) return { orphan: true, missing: missing, reason: 'unknown-plots' };
    return { orphan: false, missing: missing, reason: null };
  }
  function isOrphanEvent(e) { return orphanState(e).orphan; }

  function getAccessibleSprayEvents() {
    if (!currentUser) return [];
    
    // Admin sees all
    if (currentUser.role === 'admin') return sprayEvents;
    
    // Non-admin: filter by accessible plots
    var accessiblePlots = getAccessiblePlots();
    var accessiblePlotIds = accessiblePlots.map(function(p) { return p.id; });
    
    return sprayEvents.filter(function(event) {
      // Orphans belong to nobody, so plot-based access can never grant them.
      // Surfacing them to an operator is what lets them be cleaned up
      // instead of haunting the exports forever.
      if (isOrphanEvent(event)) return true;
      return (event.plotIds || []).some(function(pid) {
        return accessiblePlotIds.indexOf(pid) !== -1;
      });
    });
  }

  // ── Load data ──
  function loadData() {
    var saved = localStorage.getItem('plotMapperSprayData');
    if (saved) {
      _applyPlotData(JSON.parse(saved));
    }
    // Also fetch from Firestore for latest
    if (typeof DB !== 'undefined') {
      DB.loadAsync('plotMapperSprayData').then(function(data) {
        if (data) {
          _applyPlotData(data);
        }
      });
    }
  }

  function _applyPlotData(data) {
      plots = data.plots || [];
      sprayEvents = data.sprayEvents || [];
      pesticides = data.pesticides || getDefaultPesticides();
      farms = data.farms || [];
      worklogEntries = data.worklogEntries || [];
      
      // Clear map
      drawnItems.clearLayers();

      // Build layers for ALL plots (so saveData can read latlngs from any)
      plots.forEach(function(p) {
        if (!p.latlngs || p.latlngs.length === 0) return;
        var latlngs = p.latlngs.map(function(c) { return L.latLng(c.lat !== undefined ? c.lat : c[0], c.lng !== undefined ? c.lng : c[1]); });
        var layer = L.polygon(latlngs, {
          color: p.color, fillColor: p.color, weight: 3, fillOpacity: 0.25
        });
        p.layer = layer;
        // Extra parts render as their own polygons in the plot's colour,
        // dashed so it reads as "same plot, separate piece" rather than as
        // a second plot that happens to match.
        if (p.partLayers) {
          p.partLayers.forEach(function (l) { try { drawnItems.removeLayer(l); } catch (e) {} });
        }
        p.partLayers = (p.parts || []).map(function (ring) {
          return L.polygon(ring.map(function (c) { return L.latLng(c.lat, c.lng); }), {
            color: p.color, fillColor: p.color, weight: 2,
            fillOpacity: 0.20, dashArray: '7,5'
          });
        });
      });

      // Only display accessible plots on map
      var accessiblePlots = getAccessiblePlots();
      accessiblePlots.forEach(function(p) {
        if (!p.layer) return;
        p.layer.addTo(drawnItems);
        (p.partLayers || []).forEach(function (l) { l.addTo(drawnItems); });
        var center = p.layer.getBounds().getCenter();
        var label = L.divIcon({
          className: '',
          html: '<div style="background:' + p.color + ';color:white;padding:3px 10px;border-radius:8px;' +
            'font-family:Heebo,sans-serif;font-size:12px;font-weight:700;white-space:nowrap;' +
            'box-shadow:0 2px 8px rgba(0,0,0,0.3);text-align:center;">' + locName(p) + '</div>',
          iconAnchor: [0, 0]
        });
        var labelMarker = L.marker(center, { icon: label, interactive: false }).addTo(drawnItems);
        p.labelMarker = labelMarker;
        p.layer.on('click', function() {
          if (!drawMode) showPlotDetails(p.id);
        });
      });
      colorIdx = plots.length;
      renderPlotList();
      renderPesticideList();
      renderPesticideAdminList();
      renderHistoryList();

      // Layers were just rebuilt from scratch, so any active map filter has
      // been wiped. map-filter.js listens for this and re-applies itself.
      try {
        document.dispatchEvent(new CustomEvent('shorashim:plots-rendered'));
      } catch (e) {}
  }

  // Show/hide a single plot on the map. Both the polygon and its name label
  // live in drawnItems, so both have to move together or a hidden plot
  // leaves its label floating over empty ground.
  window.setPlotVisibility = function(plotId, visible) {
    var p = plots.find(function(pl) { return pl.id === plotId; });
    if (!p || !p.layer) return;
    if (visible) {
      if (!drawnItems.hasLayer(p.layer)) drawnItems.addLayer(p.layer);
      if (p.labelMarker && !drawnItems.hasLayer(p.labelMarker)) drawnItems.addLayer(p.labelMarker);
    } else {
      if (drawnItems.hasLayer(p.layer)) drawnItems.removeLayer(p.layer);
      if (p.labelMarker && drawnItems.hasLayer(p.labelMarker)) drawnItems.removeLayer(p.labelMarker);
    }
  };

  // Plots the current user is allowed to see at all — the filter narrows
  // within this, it can never widen beyond it.
  window.getVisiblePlotPool = function() {
    return (typeof getAccessiblePlots === 'function' ? getAccessiblePlots() : plots)
      .map(function(p) {
        return { id: p.id, name: p.name, farm_id: p.farm_id || 0,
                 crop_type: p.crop_type || '', hasGeometry: !!p.layer };
      });
  };

  function getDefaultPesticides() {
    return [
      { id: 1, activeIngredient: 'אבמקטין', productName: 'ורטימק', defaultConcentration: 0.015, unit: '%', commonTargets: 'כנימת מגן, קמחית' },
      { id: 2, activeIngredient: 'ספירומסיפן', productName: 'מובנטו', defaultConcentration: 0.024, unit: '%', commonTargets: 'כנימת מגן, תריפס' }
    ];
  }

  function saveData() {
    var data = {
      plots: plots.map(function(p) {
        var ll;
        if (p.layer && typeof p.layer.getLatLngs === 'function') {
          ll = p.layer.getLatLngs()[0].map(function(c) { return {lat: c.lat, lng: c.lng}; });
        } else if (p.latlngs) {
          ll = p.latlngs.map(function(c) {
            return {lat: c.lat !== undefined ? c.lat : c[0], lng: c.lng !== undefined ? c.lng : c[1]};
          });
        } else {
          ll = [];
        }
        return {
          id: p.id || 0, 
          name: p.name || '', 
          color: p.color || '#4caf50', 
          area: p.area || 0,
          // Declared area stays in `area`; what the drawn boundary actually
          // encloses is kept separately so a discrepancy stays visible.
          areaMeasured: (p.areaMeasured != null ? p.areaMeasured : 0),
          vertices: p.vertices || 0,
          farm_id: p.farm_id || 0,
          tree_count: p.tree_count || 0,
          row_spacing: p.row_spacing || 0,
          tree_spacing: p.tree_spacing || 0,
          crop_type: p.crop_type || '',
          plants_per_dunam: p.plants_per_dunam || 0,
          name_th: p.name_th || '',
          name_ar: p.name_ar || '',
          geofenceRadiusM: (p.geofenceRadiusM != null ? p.geofenceRadiusM : null),
          latlngs: ll,
          // Detached parts of the same plot — an orchard split by a wadi or a
          // track is one חלקה with one tree count, not two plots. `latlngs`
          // stays the primary ring so every existing reader keeps working
          // untouched; only code that knows about parts looks at this.
          parts: Array.isArray(p.parts)
            ? p.parts.map(function (ring) {
                return (ring || []).map(function (c) {
                  return { lat: c.lat, lng: c.lng };
                });
              }).filter(function (ring) { return ring.length >= 3; })
            : []
        };
      }),
      sprayEvents: sprayEvents || [],
      pesticides: pesticides || [],
      farms: farms || [],
      worklogEntries: worklogEntries || []
    };
    DB.save('plotMapperSprayData', data);
  }

  // Narrow read-only window into this IIFE's private state, so other modules
  // (fieldreport.js) can resolve the report -> spray direction of the chain
  // without app.js having to know they exist. Read-only on purpose: writes
  // still go through the submit handler so validation can't be bypassed.
  // Jump to the map and frame a plot. Shared by the plot detail modal and
  // the plot rows on the farm page so both behave identically.
  // plot.layer only exists once the map has drawn its polygons — a plot with
  // no geometry, or a cold load where drawing hasn't run, must not throw.
  window.goToPlotOnMap = function(plotId) {
    var plot = plots.find(function(p) { return p.id === plotId; });
    if (!plot) return;

    var modal = document.getElementById('modalContainer');
    if (modal) modal.innerHTML = '';

    document.querySelectorAll('.tab').forEach(function(tb) { tb.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    var mapTab = document.querySelector('[data-tab="map"]');
    if (mapTab) mapTab.classList.add('active');
    var mapPane = document.getElementById('tabMap');
    if (mapPane) mapPane.classList.add('active');
    activeTab = 'map';

    // Jumping to a plot the filter is hiding would frame blank ground.
    // Reveal it and say so, rather than silently showing nothing.
    if (window.MapFilter && typeof window.MapFilter.reveal === 'function') {
      window.MapFilter.reveal(plotId);
    }

    setTimeout(function() {
      try { map.invalidateSize(); } catch (e) {}
      if (!plot.layer || typeof plot.layer.getBounds !== 'function') {
        showToast('📍 ' + t('לחלקה זו אין גבולות משורטטים'));
        return;
      }
      try {
        map.fitBounds(plot.layer.getBounds(), { padding: [50, 50], maxZoom: 17 });
        // Brief flash so the plot is obvious among its neighbours.
        plot.layer.setStyle({ fillOpacity: 0.6 });
        setTimeout(function() {
          try { plot.layer.setStyle({ fillOpacity: 0.25 }); } catch (e) {}
        }, 800);
      } catch (e) {
        showToast('📍 ' + t('לא ניתן למקד את החלקה'));
      }
    }, 100);
  };

  window.SprayStore = {
    getEvents: function() { return (sprayEvents || []).slice(); },
    getEventsForReport: function(reportId) {
      return (sprayEvents || []).filter(function(e) {
        return (e.linkedReportIds || []).indexOf(reportId) !== -1;
      });
    },
    plotNameById: function(id) {
      var p = (plots || []).find(function(pl) { return pl.id === id; });
      return p ? p.name : t('חלקה לא ידועה');
    },
    getPlots: function() {
      var src = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : plots;
      return (src || []).slice();
    },
    getPesticides: function() { return (pesticides || []).slice(); },
    // Per-farm report branding. Lives on the farm object inside
    // plotMapperSprayData, so it travels with the farm and needs no new
    // Firestore key or rules change.
    getFarmTheme: function(farmId) {
      var f = (farms || []).find(function(x) { return x.id === farmId; });
      return (f && f.report_theme) ? JSON.parse(JSON.stringify(f.report_theme)) : null;
    },
    setFarmTheme: function(farmId, theme) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      var f = (farms || []).find(function(x) { return x.id === farmId; });
      if (!f) return { ok: false, err: 'not-found' };
      // Firestore rejects undefined — round-trip before storing.
      f.report_theme = theme ? JSON.parse(JSON.stringify(theme)) : null;
      saveData();
      return { ok: true };
    },
    exportFarmLog: function(farmId) {
      // Only farms that opted into the satellite image wait for it;
      // report-theme.js surfaces 'map-pending' to the user as a retry.
      var wantsMap = false;
      if (farmId && window.ReportTheme && window.ReportTheme.resolve) {
        var fObj = (farms || []).find(function (f) { return f.id === farmId; });
        try { wantsMap = !!window.ReportTheme.resolve(fObj).satellite; } catch (e) { wantsMap = false; }
      }
      if (wantsMap && window.ReportMap && !window.ReportMap.isMainSettled(farmId)) {
        window.ReportMap.prepareMain(farmId);
        return { ok: false, err: 'map-pending' };
      }
      var html = generatePdfHtml(farmId);
      if (!html) return { ok: false, err: 'empty' };
      var fname = t('יומן ריסוסים').replace(/ /g, '_') + '_' +
        new Date().toISOString().split('T')[0] + '.html';
      window.Util.exportReport(html, fname);
      return { ok: true };
    },
    getFarms: function() {
      var accessible = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : plots;
      var ids = {};
      (accessible || []).forEach(function(p) { if (p.farm_id) ids[p.farm_id] = true; });
      return (farms || []).filter(function(f) { return ids[f.id]; })
        .map(function(f) { return { id: f.id, name: f.name }; });
    },

    // Batched sibling of updateEvent. patchFn(event) returns the fields to
    // change for THAT record, or null to skip it. One saveData() for the
    // whole batch rather than one per record — fifty separate writes of the
    // entire blob would be slow and would race with DB.listen.
    // Per-record revisions and audit entries are still written individually:
    // the batch is a UI convenience, not a reason to lose granularity.
    updateMany: function(ids, patchFn, reason, diffFn) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      if (!reason || !String(reason).trim()) return { ok: false, err: 'reason-required' };
      reason = String(reason).trim();

      var touched = 0, skipped = 0, pending = [];
      ids.forEach(function(id) {
        var idx = sprayEvents.findIndex(function(e) { return e.id === id; });
        if (idx === -1) { skipped++; return; }
        var before = JSON.parse(JSON.stringify(sprayEvents[idx]));
        var patch = patchFn(before);
        if (!patch) { skipped++; return; }
        var after = JSON.parse(JSON.stringify(before));
        Object.keys(patch).forEach(function(k) { after[k] = patch[k]; });
        var changes = (typeof diffFn === 'function') ? diffFn(before, after) : [];
        if (!changes.length) { skipped++; return; }
        if (!after.revisions) after.revisions = [];
        after.revisions.push({
          at: Date.now(), by: u.username || '', byName: u.name || u.username || '',
          role: u.role || '', reason: reason, changes: changes, batch: true
        });
        sprayEvents[idx] = after;
        touched++;
        pending.push({ id: id, before: before, after: after });
      });

      if (!touched) return { ok: true, touched: 0, skipped: skipped };
      saveData();
      if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
        pending.forEach(function(p) {
          Audit.log('edit', 'spray', String(p.id), {
            before: p.before, after: p.after, reason: reason + ' [batch]'
          });
        });
      }
      try { renderHistoryList(); } catch (e) {}
      return { ok: true, touched: touched, skipped: skipped };
    },

    voidMany: function(ids, reason) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      if (!reason || !String(reason).trim()) return { ok: false, err: 'reason-required' };
      reason = String(reason).trim();
      var touched = 0, pending = [];
      ids.forEach(function(id) {
        var idx = sprayEvents.findIndex(function(e) { return e.id === id; });
        if (idx === -1 || sprayEvents[idx].voided) return;
        var before = JSON.parse(JSON.stringify(sprayEvents[idx]));
        sprayEvents[idx].voided = {
          at: Date.now(), by: u.username || '',
          byName: u.name || u.username || '', reason: reason
        };
        touched++;
        pending.push({ id: id, before: before, after: sprayEvents[idx] });
      });
      if (!touched) return { ok: true, touched: 0 };
      saveData();
      if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
        pending.forEach(function(p) {
          Audit.log('void', 'spray', String(p.id), {
            before: p.before, after: p.after, reason: reason + ' [batch]'
          });
        });
      }
      try { renderHistoryList(); } catch (e) {}
      return { ok: true, touched: touched };
    },

    // The ONLY write path from outside this IIFE. Applies a patch, records
    // what changed on the record itself, and mirrors it to the audit log.
    // Refuses silently-unexplained edits: a reason is mandatory, and the
    // revision trail is appended, never replaced.
    updateEvent: function(id, patch, reason, diffFn) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      if (!reason || !String(reason).trim()) return { ok: false, err: 'reason-required' };

      var idx = sprayEvents.findIndex(function(e) { return e.id === id; });
      if (idx === -1) return { ok: false, err: 'not-found' };

      var before = JSON.parse(JSON.stringify(sprayEvents[idx]));
      var after = JSON.parse(JSON.stringify(before));
      Object.keys(patch).forEach(function(k) { after[k] = patch[k]; });

      var changes = (typeof diffFn === 'function') ? diffFn(before, after) : [];
      if (!changes.length) return { ok: true, changes: 0 };

      if (!after.revisions) after.revisions = [];
      after.revisions.push({
        at: Date.now(),
        by: u.username || '',
        byName: u.name || u.username || '',
        role: u.role || '',
        reason: String(reason).trim(),
        changes: changes
      });

      sprayEvents[idx] = after;
      saveData();

      // Best-effort forensic copy. admin-read-only per firestore.rules, which
      // is why after.revisions exists as the operator-visible trail.
      if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
        Audit.log('edit', 'spray', String(id), {
          before: before, after: after, reason: String(reason).trim()
        });
      }

      try { renderHistoryList(); } catch (e) {}
      return { ok: true, changes: changes.length };
    },

    // A record created moments ago by a mis-tap is not yet a compliance
    // record — nobody has read it, nothing references it. Removing it
    // outright is honest. Past the window it becomes history and can only
    // be voided, never erased.
    GRACE_MS: 10 * 60 * 1000,
    graceState: function(id) {
      var ev = sprayEvents.find(function(e) { return e.id === id; });
      if (!ev) return { eligible: false };
      var u = window.currentUser || {};
      var created = ev.enteredAt || ev.id || 0;
      var age = Date.now() - created;
      var mine = !ev.enteredBy || ev.enteredBy === u.username;
      var untouched = !(ev.revisions && ev.revisions.length);
      return {
        eligible: age < this.GRACE_MS && mine && untouched && !ev.voided,
        minutesLeft: Math.max(0, Math.ceil((this.GRACE_MS - age) / 60000))
      };
    },
    deleteWithinGrace: function(id) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      var st = this.graceState(id);
      if (!st.eligible) return { ok: false, err: 'grace-expired' };
      var idx = sprayEvents.findIndex(function(e) { return e.id === id; });
      if (idx === -1) return { ok: false, err: 'not-found' };
      var before = JSON.parse(JSON.stringify(sprayEvents[idx]));
      sprayEvents.splice(idx, 1);
      saveData();
      // Even a grace delete is logged. The record is gone from the log; the
      // fact that it briefly existed is not.
      if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
        Audit.log('delete', 'spray', String(id), {
          before: before, after: null, reason: 'grace-window removal'
        });
      }
      try { renderHistoryList(); } catch (e) {}
      return { ok: true };
    },

    // Orphans cannot be voided through the normal flow — voiding needs a
    // record you can open, and these have no plot to open them against. This
    // is the escape hatch: admin only, confirmed, and every removed record is
    // written to the audit log in full first, so nothing vanishes silently.
    purgeOrphans: function() {
      var u = window.currentUser || {};
      if (u.role !== 'admin') { showToast('❌ ' + t('למנהל בלבד')); return { ok: false, err: 'forbidden' }; }
      var doomed = sprayEvents.filter(isOrphanEvent);
      if (!doomed.length) { showToast(t('אין רשומות ללא חלקה')); return { ok: true, removed: 0 }; }
      if (!confirm(t('למחוק') + ' ' + doomed.length + ' ' +
          t('רשומות ללא חלקה מזוהה? הפעולה תירשם ביומן הפעולות.'))) {
        return { ok: false, err: 'cancelled' };
      }
      doomed.forEach(function(e) {
        if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
          Audit.log('delete', 'spray', String(e.id), {
            before: e, after: null, reason: 'orphan purge — no resolvable plot'
          });
        }
      });
      var ids = doomed.map(function(e) { return e.id; });
      sprayEvents = sprayEvents.filter(function(e) { return ids.indexOf(e.id) === -1; });
      saveData();
      try { renderHistoryList(); } catch (e) {}
      showToast('🗑 ' + doomed.length + ' ' + t('רשומות נמחקו'));
      return { ok: true, removed: doomed.length };
    },

    // Voiding strikes the record without erasing it — the standard way to
    // retract a compliance entry. Reversible, because mistakes about
    // mistakes happen too.
    voidEvent: function(id, reason) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      if (!reason || !String(reason).trim()) return { ok: false, err: 'reason-required' };
      var idx = sprayEvents.findIndex(function(e) { return e.id === id; });
      if (idx === -1) return { ok: false, err: 'not-found' };
      var before = JSON.parse(JSON.stringify(sprayEvents[idx]));
      sprayEvents[idx].voided = {
        at: Date.now(),
        by: u.username || '',
        byName: u.name || u.username || '',
        reason: String(reason).trim()
      };
      saveData();
      if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
        Audit.log('void', 'spray', String(id), {
          before: before, after: sprayEvents[idx], reason: String(reason).trim()
        });
      }
      try { renderHistoryList(); } catch (e) {}
      return { ok: true };
    },
    unvoidEvent: function(id, reason) {
      var u = window.currentUser || {};
      if (u.role !== 'admin' && u.role !== 'operator') return { ok: false, err: 'forbidden' };
      var idx = sprayEvents.findIndex(function(e) { return e.id === id; });
      if (idx === -1) return { ok: false, err: 'not-found' };
      var before = JSON.parse(JSON.stringify(sprayEvents[idx]));
      delete sprayEvents[idx].voided;
      saveData();
      if (typeof Audit !== 'undefined' && typeof Audit.log === 'function') {
        Audit.log('unvoid', 'spray', String(id), {
          before: before, after: sprayEvents[idx], reason: String(reason || '').trim() || null
        });
      }
      try { renderHistoryList(); } catch (e) {}
      return { ok: true };
    },
    showVoided: function(v) {
      if (typeof v === 'boolean') { _showVoided = v; try { renderHistoryList(); } catch (e) {} }
      return _showVoided;
    }
  };

  // ── MapAccess ──────────────────────────────────────────────────────
  // A deliberately narrow window onto the Leaflet map for modules that own
  // a different kind of geometry than a plot. buildplan.js draws project
  // footprints (a service shed, a concrete slab) — those are maintenance
  // objects with their own lifecycle, not rows in `plots`, so they get
  // their own layer and their own store rather than polluting plot data.
  //
  // setExternalDraw() parks app.js's own state machine on the sentinel
  // 'external'. Every internal handler tests drawMode against 'polygon' or
  // 'rect', so none of them fire, while `if (!drawMode) showPlotDetails()`
  // correctly sees a draw in progress and stops opening plot popups under
  // the user's clicks.
  window.MapAccess = {
    getMap: function () { return map; },
    maxZoom: function () { return MAX_ZOOM; },
    // ── plot geometry, for plotedit.js ──
    // Rings out, rings in. The editor never touches the plots array, the
    // layer cache or saveData directly — those stay app.js's business, so a
    // change to how plots are stored cannot break the editor silently.
    getPlotRings: function (plotId) {
      var p = (plots || []).filter(function (x) { return x.id === plotId; })[0];
      if (!p) return null;
      var rings = [];
      if (p.latlngs && p.latlngs.length >= 3) {
        rings.push(p.latlngs.map(function (c) { return { lat: c.lat, lng: c.lng }; }));
      }
      (p.parts || []).forEach(function (r) {
        if (r && r.length >= 3) rings.push(r.map(function (c) { return { lat: c.lat, lng: c.lng }; }));
      });
      return { id: p.id, name: p.name, color: p.color, rings: rings,
               trees: p.tree_count || 0,
               declared: Number(p.area) || 0,      // from the plot card
               measured: plotArea(p) };            // from the drawn boundary
    },
    setPlotRings: function (plotId, rings, adoptDeclared) {
      var p = (plots || []).filter(function (x) { return x.id === plotId; })[0];
      if (!p || !rings || !rings.length) return false;
      var clean = rings.filter(function (r) { return r && r.length >= 3; })
        .map(function (r) { return r.map(function (c) { return { lat: c.lat, lng: c.lng }; }); });
      if (!clean.length) return false;
      p.latlngs = clean[0];
      p.parts = clean.slice(1);
      p.vertices = clean.reduce(function (n, r) { return n + r.length; }, 0);
      // p.area is the figure the user recorded on the plot card — the
      // registered or agreed area the farm actually works to. It is NOT the
      // area of whatever was traced on the map, and editing the boundary
      // must not silently redefine it. Measured area is derived on demand
      // instead, so the two can be compared rather than confused.
      p.areaMeasured = plotArea(p);
      // Only when the user explicitly asked for it.
      if (adoptDeclared != null && isFinite(adoptDeclared) && adoptDeclared > 0) {
        p.area = Math.round(adoptDeclared * 100) / 100;
      }
      // Rebuild the drawn layers from the new rings.
      if (p.layer) { try { drawnItems.removeLayer(p.layer); } catch (e) {} }
      (p.partLayers || []).forEach(function (l) { try { drawnItems.removeLayer(l); } catch (e) {} });
      p.layer = L.polygon(p.latlngs.map(function (c) { return L.latLng(c.lat, c.lng); }), {
        color: p.color, fillColor: p.color, weight: 3, fillOpacity: 0.25
      });
      p.partLayers = (p.parts || []).map(function (ring) {
        return L.polygon(ring.map(function (c) { return L.latLng(c.lat, c.lng); }), {
          color: p.color, fillColor: p.color, weight: 2, fillOpacity: 0.20, dashArray: '7,5'
        });
      });
      p.layer.addTo(drawnItems);
      p.partLayers.forEach(function (l) { l.addTo(drawnItems); });
      saveData();
      return true;
    },
    plotAreaOf: function (plotId) {
      var p = (plots || []).filter(function (x) { return x.id === plotId; })[0];
      return p ? plotArea(p) : 0;
    },
    // Every plot the user may see, with its rings — used for hover readout.
    listPlotsWithRings: function () {
      var src = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : plots;
      return (src || []).map(function (p) {
        var rings = [];
        if (p.latlngs && p.latlngs.length >= 3) rings.push(p.latlngs);
        (p.parts || []).forEach(function (r) { if (r && r.length >= 3) rings.push(r); });
        return { id: p.id, name: p.name, color: p.color, rings: rings,
                 trees: p.tree_count || 0, crop: p.crop_type || '',
                 farmId: p.farm_id || 0,
                 declared: Number(p.area) || 0,
                 measured: plotArea(p) };
      });
    },
    // Shoelace on the sphere, same maths the plot tool uses — returned in
    // m² here because a shed is measured in metres, not dunam.
    areaFromLatLngs: function (pts) {
      if (!pts || pts.length < 3) return 0;
      var a = 0;
      for (var i = 0; i < pts.length; i++) {
        var j = (i + 1) % pts.length;
        var xi = pts[i].lng * Math.PI / 180, yi = pts[i].lat * Math.PI / 180;
        var xj = pts[j].lng * Math.PI / 180, yj = pts[j].lat * Math.PI / 180;
        a += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
      }
      return Math.abs(a * 6378137 * 6378137 / 2);
    },
    isDrawing: function () { return !!drawMode; },
    // Bring the map tab to the front and re-measure. Leaflet computes
    // fitBounds against the container's current size, so calling it while
    // the pane is display:none frames nothing — which is why "show on map"
    // appeared to do nothing at all from inside a modal.
    goToMap: function () {
      var modal = document.getElementById('modalContainer');
      if (modal) modal.innerHTML = '';
      document.querySelectorAll('.tab').forEach(function (tb) { tb.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function (c) { c.classList.remove('active'); });
      var mt = document.querySelector('[data-tab="map"]');
      if (mt) mt.classList.add('active');
      var mp = document.getElementById('tabMap');
      if (mp) mp.classList.add('active');
      activeTab = 'map';
      setTimeout(function () { try { map.invalidateSize(); } catch (e) {} }, 50);
    },
    setExternalDraw: function (on) {
      if (on) {
        if (drawMode && drawMode !== 'external') return false;  // never steal an active draw
        drawMode = 'external';
        mapEl.classList.add('drawing');
        return true;
      }
      if (drawMode === 'external') {
        drawMode = null;
        mapEl.classList.remove('drawing');
      }
      return true;
    }
  };

  function initMapAndData() {
    // Clear existing map layers before reloading
    drawnItems.clearLayers();
    loadData();
    // Invalidate map size after mainApp becomes visible, then zoom to primary plot
    setTimeout(function() { 
      map.invalidateSize(); 
      zoomToPrimaryPlot();
    }, 200);
  }

  function zoomToPrimaryPlot() {
    if (!currentUser) return;
    
    // Check user's primary_plot_id
    var primaryPlotId = currentUser.primary_plot_id || null;
    
    if (primaryPlotId) {
      var plot = plots.find(function(p) { return p.id === primaryPlotId; });
      if (plot && plot.layer) {
        map.fitBounds(plot.layer.getBounds(), { padding: [60, 60], maxZoom: 16 });
        return;
      }
    }
    
    // Fallback: if user has accessible plots, fit all of them
    var accessiblePlots = getAccessiblePlots();
    if (accessiblePlots.length > 0) {
      var bounds = L.latLngBounds([]);
      accessiblePlots.forEach(function(p) {
        if (p.layer) bounds.extend(p.layer.getBounds());
      });
      if (bounds.isValid()) {
        map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
      }
    }
  }

  // ── Start auth flow ──
  // Seed the users cache from localStorage only — a Firestore read here
  // runs signed-out and is denied by rules anyway. The auth listener
  // does the real (fresh) read after sign-in resolves.
  try {
    var _lsUsers = localStorage.getItem('shorashim-users');
    if (_lsUsers) users = JSON.parse(_lsUsers);
  } catch (e) {}
  showLoginScreen();

  // ── Tab switching ──
  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      var targetTab = this.getAttribute('data-tab');
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      this.classList.add('active');
      document.getElementById('tab' + targetTab.charAt(0).toUpperCase() + targetTab.slice(1)).classList.add('active');
      activeTab = targetTab;

      if (targetTab === 'map') {
        setTimeout(function() { map.invalidateSize(); }, 50);
      } else if (targetTab === 'spray') {
        renderPlotCheckboxes();
        renderPesticideList();
        updateCalculations();
        // Default to form sub-view whenever the spray tab is opened from the tab bar.
        showSpraySubview('form');
      } else if (targetTab === 'farms') {
        renderFarmsAdminList();
      } else if (targetTab === 'users') {
        renderUsersAdminList();
      } else if (targetTab === 'profile') {
        renderProfileTab();
      } else if (targetTab === 'worklog') {
        renderWorklogTab();
      } else if (targetTab === 'irrigation') {
        renderIrrigationTab();
      }
    });
  });

  // ── Spray sub-view toggle (form ⇄ history) ──
  // חומרים and חיפוש חומרים live inside the spray section as
  // sub-views, not as tab-bar entries: they are part of preparing a spray,
  // and as top-level tabs they pushed the bar onto a third row.
  var SPRAY_SUBVIEWS = {
    form:       'spraySubviewForm',
    history:    'spraySubviewHistory',
    pestsearch: 'spraySubviewPestsearch',
    materials:  'spraySubviewMaterials'
  };

  function showSpraySubview(name) {
    if (!SPRAY_SUBVIEWS[name]) name = 'form';
    // A non-admin reaching the materials panel (stale state, deep link)
    // falls back to the form rather than seeing an empty screen.
    if (name === 'materials' && !isAdmin()) name = 'form';
    var found = false;
    Object.keys(SPRAY_SUBVIEWS).forEach(function(k) {
      var el = document.getElementById(SPRAY_SUBVIEWS[k]);
      if (!el) return;
      found = true;
      el.style.display = (k === name) ? '' : 'none';
    });
    if (!found) return;
    document.querySelectorAll('.spray-subview-toggle .sv-btn').forEach(function(b) {
      b.classList.toggle('active', b.getAttribute('data-spray-view') === name);
    });
    if (name === 'history') renderHistoryList();
    if (name === 'materials') renderPesticideAdminList();
    if (name === 'pestsearch') {
      var inp = document.getElementById('pestSearchInput');
      if (inp) setTimeout(function() { inp.focus(); }, 100);
    }
  }
  document.querySelectorAll('.spray-subview-toggle .sv-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      showSpraySubview(this.getAttribute('data-spray-view'));
    });
  });

  // ── Tab-bar scroll-hint affordance ──
  (function wireTabScrollHints() {
    var wrap = document.getElementById('tabBarWrap');
    var bar = document.getElementById('tabBar');
    if (!wrap || !bar) return;
    // The bar wraps to a second row now, so there is no horizontal scroll to
    // hint at. Kept as a no-op because role-gating code calls the exported
    // refresher after it reveals the admin tabs.
    function update() {
      wrap.classList.remove('can-scroll-start');
      wrap.classList.remove('can-scroll-end');
    }
    bar.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Initial + after layout settles (admin tabs may toggle visibility)
    setTimeout(update, 0);
    setTimeout(update, 300);
    setTimeout(update, 1500);
    // Expose so role-gating code can re-evaluate after showing admin tabs
    window.__refreshTabScrollHints = update;
  })();

  // ── Layer toggle ──
  document.getElementById('layerBtn').addEventListener('click', function() {
    if (isSatellite) {
      map.removeLayer(satelliteLayer);
      map.addLayer(streetLayer);
      isSatellite = false;
      document.getElementById('layerIcon').textContent = '🛰️';
      document.getElementById('layerText').textContent = t('לוויין');
    } else {
      map.removeLayer(streetLayer);
      map.addLayer(satelliteLayer);
      isSatellite = true;
      document.getElementById('layerIcon').textContent = '🗺️';
      document.getElementById('layerText').textContent = t('רחוב');
    }
  });

  // ── GPS ──
  document.getElementById('gpsBtn').addEventListener('click', function() {
    var btn = this;
    btn.classList.add('locating');
    
    if (!navigator.geolocation) {
      btn.classList.remove('locating');
      showToast('❌ ' + t('הדפדפן לא תומך באיתור מיקום'));
      return;
    }

    // Try high accuracy first, then fallback to low accuracy
    function tryLocate(highAccuracy) {
      navigator.geolocation.getCurrentPosition(
        function(position) {
          btn.classList.remove('locating');
          var lat = position.coords.latitude;
          var lng = position.coords.longitude;
          var latlng = L.latLng(lat, lng);
          
          map.invalidateSize();
          map.setView(latlng, 17, { animate: true });
          
          if (gpsMarker) map.removeLayer(gpsMarker);
          gpsMarker = L.circleMarker(latlng, {
            radius: 8, fillColor: '#4285f4', color: 'white', weight: 2, fillOpacity: 1
          }).addTo(map);
          showToast('📍 ' + t('מיקום זוהה') + ' (' + (highAccuracy ? 'GPS' : t('רשת')) + ')');
        },
        function(error) {
          // If high accuracy failed, try low accuracy
          if (highAccuracy && error.code !== 1) {
            tryLocate(false);
            return;
          }
          btn.classList.remove('locating');
          var msg = '';
          if (error.code === 1) {
            // Permission denied — might be protocol issue
            var proto = window.location.protocol;
            if (proto === 'file:' || proto === 'content:') {
              msg = t('נדרש לפתוח דרך שרת') + ' (HTTPS). ' + t('נסה להעלות לשרת או השתמש ב-Live Server');
            } else {
              msg = t('גישה למיקום נדחתה') + ' — ' + t('בדוק הגדרות דפדפן ומכשיר');
            }
          } else if (error.code === 2) {
            msg = t('מיקום לא זמין') + ' — ' + t('ודא ש-GPS פעיל במכשיר');
          } else if (error.code === 3) {
            msg = t('תם הזמן לאיתור מיקום') + ' — ' + t('נסה באזור פתוח');
          }
          showToast('❌ ' + msg);
          console.log('GPS error:', error.code, error.message, 'protocol:', window.location.protocol);
        },
        { enableHighAccuracy: highAccuracy, timeout: highAccuracy ? 10000 : 20000, maximumAge: 30000 }
      );
    }
    
    tryLocate(true);
  });

  // ── FAB ──
  fabMain.addEventListener('click', function() {
    if (drawMode) {
      cancelDraw();
    } else {
      var isOpen = fabOptions.classList.contains('show');
      fabOptions.classList.toggle('show', !isOpen);
      fabMain.classList.toggle('open', !isOpen);
    }
  });

  document.getElementById('btnPolygon').addEventListener('click', function() {
    startPolygonDraw();
    fabOptions.classList.remove('show');
    fabMain.classList.remove('open');
  });

  // ── Drawing ──
  function startPolygonDraw() {
    drawMode = 'polygon';
    polyPoints = [];
    polyMarkers = [];
    polyLine = null;
    mapEl.classList.add('drawing');
    fabMain.classList.add('drawing');
    drawBanner.classList.add('show');
    drawBanner.textContent = '⬠ ' + t('לחץ על המפה לסימון נקודות');
  }

  function startRectDraw() {
    drawMode = 'rect';
    rectStart = null;
    rectPreview = null;
    mapEl.classList.add('drawing');
    fabMain.classList.add('drawing');
    drawBanner.classList.add('show');
    drawBanner.textContent = '▬ ' + t('לחץ על נקודת התחלה');
  }

  function cancelDraw() {
    if (drawMode === 'polygon') {
      polyMarkers.forEach(function(m) { map.removeLayer(m); });
      if (polyLine) map.removeLayer(polyLine);
      polyPoints = [];
      polyMarkers = [];
      polyLine = null;
    } else if (drawMode === 'rect') {
      if (rectPreview) map.removeLayer(rectPreview);
      rectStart = null;
      rectPreview = null;
    }
    drawMode = null;
    mapEl.classList.remove('drawing');
    fabMain.classList.remove('drawing');
    drawBanner.classList.remove('show');
    undoPointBtn.classList.remove('show');
  }

  map.on('click', function(e) {
    if (drawMode === 'polygon') {
      var latlng = e.latlng;
      
      // Check if clicking near first point to close
      if (polyPoints.length >= 3) {
        var firstPx = map.latLngToContainerPoint(polyPoints[0]);
        var clickPx = map.latLngToContainerPoint(latlng);
        if (firstPx.distanceTo(clickPx) < 25) {
          finishPolygon();
          return;
        }
      }

      // Add new point
      polyPoints.push(latlng);
      var color = COLORS[colorIdx % COLORS.length];
      var isFirst = (polyPoints.length === 1);
      
      var icon = L.divIcon({
        className: '',
        html: '<div class="' + (isFirst ? 'vertex-first' : 'vertex-marker') + '" style="background:' + color + '"></div>',
        iconSize: [0, 0]
      });
      
      var marker = L.marker(latlng, { icon: icon }).addTo(map);
      polyMarkers.push(marker);
      
      // Update preview line
      if (polyLine) map.removeLayer(polyLine);
      if (polyPoints.length >= 2) {
        polyLine = L.polyline(polyPoints, { 
          color: color, 
          weight: 3, 
          dashArray: '8,6',
          opacity: 0.7
        }).addTo(map);
      }

      if (polyPoints.length >= 3) {
        undoPointBtn.classList.add('show');
        drawBanner.textContent = '⬠ ' + t('לחץ על הנקודה הראשונה לסגירה');
      } else {
        drawBanner.textContent = '⬠ ' + t('לחץ להמשך סימון');
      }
      
    } else if (drawMode === 'rect') {
      if (!rectStart) {
        rectStart = e.latlng;
        var marker = L.circleMarker(rectStart, { radius: 6, color: '#1565c0', fillColor: 'white', weight: 2, fillOpacity: 1 }).addTo(map);
        polyMarkers.push(marker);
        drawBanner.textContent = '▬ ' + t('גרור או לחץ על הפינה הנגדית');
      } else {
        // Second click — finish
        finishRect(e.latlng);
      }
    }
  });

  // Live rectangle preview — works with both mouse and touch
  function updateRectPreview(latlng) {
    if (drawMode !== 'rect' || !rectStart) return;
    var color = COLORS[colorIdx % COLORS.length];
    var bounds = L.latLngBounds(rectStart, latlng);
    
    if (rectPreview) {
      rectPreview.setBounds(bounds);
    } else {
      rectPreview = L.rectangle(bounds, { 
        color: color, 
        weight: 3, 
        fillOpacity: 0.15, 
        dashArray: '8,6',
        opacity: 0.7
      }).addTo(map);
    }
    
    // Show area in banner
    var area = calcAreaFromBounds(bounds);
    drawBanner.textContent = '▬ ' + formatArea(area) + ' — ' + t('לחץ לאישור');
  }

  map.on('mousemove', function(e) {
    updateRectPreview(e.latlng);
  });
  
  // Touch move for mobile live preview
  map.getContainer().addEventListener('touchmove', function(e) {
    if (drawMode !== 'rect' || !rectStart) return;
    if (e.touches.length !== 1) return;
    var touch = e.touches[0];
    var point = map.containerPointToLatLng(L.point(touch.clientX - map.getContainer().getBoundingClientRect().left, touch.clientY - map.getContainer().getBoundingClientRect().top));
    updateRectPreview(point);
  }, { passive: true });
  
  function calcAreaFromBounds(bounds) {
    var latlngs = [
      bounds.getSouthWest(),
      L.latLng(bounds.getSouthWest().lat, bounds.getNorthEast().lng),
      bounds.getNorthEast(),
      L.latLng(bounds.getNorthEast().lat, bounds.getSouthWest().lng)
    ];
    var area = 0;
    for (var i = 0; i < latlngs.length; i++) {
      var j = (i + 1) % latlngs.length;
      var xi = latlngs[i].lng * Math.PI / 180;
      var yi = latlngs[i].lat * Math.PI / 180;
      var xj = latlngs[j].lng * Math.PI / 180;
      var yj = latlngs[j].lat * Math.PI / 180;
      area += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
    }
    area = Math.abs(area * 6378137 * 6378137 / 2);
    return area / 1000;
  }

  undoPointBtn.addEventListener('click', function() {
    if (polyPoints.length > 0) {
      polyPoints.pop();
      var m = polyMarkers.pop();
      map.removeLayer(m);
      
      // Update preview line
      if (polyLine) {
        map.removeLayer(polyLine);
        polyLine = null;
      }
      if (polyPoints.length >= 2) {
        var color = COLORS[colorIdx % COLORS.length];
        polyLine = L.polyline(polyPoints, { 
          color: color, 
          weight: 3, 
          dashArray: '8,6',
          opacity: 0.7
        }).addTo(map);
      }
      
      if (polyPoints.length < 3) {
        undoPointBtn.classList.remove('show');
        drawBanner.textContent = '⬠ ' + t('לחץ על המפה לסימון נקודות');
      }
    }
  });

  function finishPolygon() {
    if (polyPoints.length < 3) return;
    
    var color = COLORS[colorIdx % COLORS.length];
    var layer = L.polygon(polyPoints, { 
      color: color, 
      fillColor: color, 
      weight: 3, 
      fillOpacity: 0.25 
    }).addTo(drawnItems);
    
    // Clean up markers and preview
    polyMarkers.forEach(function(m) { map.removeLayer(m); });
    polyMarkers = [];
    if (polyLine) { 
      map.removeLayer(polyLine); 
      polyLine = null; 
    }
    
    var vertices = polyPoints.length;
    polyPoints = [];
    
    drawMode = null;
    mapEl.classList.remove('drawing');
    drawBanner.classList.remove('show');
    undoPointBtn.classList.remove('show');
    fabMain.classList.remove('drawing');
    
    // Check if this is a redraw of an existing plot
    if (window._redrawPlotId) {
      var plot = plots.find(function(p) { return p.id === window._redrawPlotId; });
      if (plot) {
        var farmObj = farms.find(function(f) { return f.id === window._redrawPlotFarmId; });
        var plotColor = farmObj ? farmObj.color : color;
        
        layer.setStyle({ color: plotColor, fillColor: plotColor });
        plot.layer = layer;
        plot.area = calcArea(layer);
        plot.vertices = vertices;
        plot.color = plotColor;
        
        // Re-create label
        var center = layer.getBounds().getCenter();
        var labelIcon = L.divIcon({
          className: '',
          html: '<div style="background:' + plotColor + ';color:white;padding:3px 10px;border-radius:8px;font-family:Heebo,sans-serif;font-size:12px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);text-align:center;">' + locName(plot) + '</div>',
          iconAnchor: [0, 0]
        });
        plot.labelMarker = L.marker(center, { icon: labelIcon, interactive: false }).addTo(drawnItems);
        
        saveData();
        renderPlotList();
        showToast('✅ ' + locName(plot) + ' ' + t('עודכן'));
        
        window._redrawPlotId = null;
        window._redrawPlotName = null;
        window._redrawPlotFarmId = null;
        return;
      }
    }
    
    showNamingModal(layer, vertices);
  }

  function finishRect(end) {
    var color = COLORS[colorIdx % COLORS.length];
    var bounds = L.latLngBounds(rectStart, end);
    var layer = L.rectangle(bounds, { 
      color: color, 
      fillColor: color, 
      weight: 3, 
      fillOpacity: 0.25 
    }).addTo(drawnItems);
    
    if (rectPreview) { 
      map.removeLayer(rectPreview); 
      rectPreview = null; 
    }
    
    rectStart = null;
    drawMode = null;
    mapEl.classList.remove('drawing');
    drawBanner.classList.remove('show');
    fabMain.classList.remove('drawing');
    
    showNamingModal(layer, 4);
  }

  // ── Area calculation ──
  // Area of one ring, in dunam.
  function ringArea(latlngs) {
    var area = 0;
    for (var i = 0; i < latlngs.length; i++) {
      var j = (i + 1) % latlngs.length;
      var xi = latlngs[i].lng * Math.PI / 180, yi = latlngs[i].lat * Math.PI / 180;
      var xj = latlngs[j].lng * Math.PI / 180, yj = latlngs[j].lat * Math.PI / 180;
      area += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
    }
    return Math.abs(area * 6378137 * 6378137 / 2) / 1000;
  }

  // Total area of a plot including its detached parts. A plot whose second
  // block is half its area would otherwise be under-reported by half in
  // every dose calculation that works off dunam.
  function plotArea(p) {
    if (!p) return 0;
    var main = (p.latlngs && p.latlngs.length >= 3)
      ? ringArea(p.latlngs.map(function (c) { return { lat: c.lat, lng: c.lng }; })) : 0;
    (p.parts || []).forEach(function (ring) {
      if (ring && ring.length >= 3) main += ringArea(ring);
    });
    return main;
  }

  function calcArea(layer) {
    var latlngs = layer.getLatLngs()[0];
    var area = 0;
    for (var i = 0; i < latlngs.length; i++) {
      var j = (i + 1) % latlngs.length;
      var xi = latlngs[i].lng * Math.PI / 180;
      var yi = latlngs[i].lat * Math.PI / 180;
      var xj = latlngs[j].lng * Math.PI / 180;
      var yj = latlngs[j].lat * Math.PI / 180;
      area += (xj - xi) * (2 + Math.sin(yi) + Math.sin(yj));
    }
    area = Math.abs(area * 6378137 * 6378137 / 2);
    return area / 1000; // dunam
  }

  function formatArea(area) {
    return area.toFixed(2) + ' ' + t('דונם');
  }

  // ── Undo ──
  function pushUndo(type, data) {
    undoStack.push({ type: type, data: data });
    undoActionBtn.style.display = 'flex';
    clearTimeout(undoTimer);
    var msg = type === 'add' ? t('נוספה חלקה') + ' "' + data.name + '"' : t('נמחקה חלקה') + ' "' + data.name + '"';
    undoBarText.textContent = msg;
    undoBar.classList.add('show');
    undoTimer = setTimeout(function() { undoBar.classList.remove('show'); }, 5000);
  }

  function performUndo() {
    if (undoStack.length === 0) return;
    var action = undoStack.pop();

    if (action.type === 'add') {
      var idx = plots.findIndex(function(p) { return p.id === action.data.id; });
      if (idx >= 0) {
        var p = plots[idx];
        drawnItems.removeLayer(p.layer);
        drawnItems.removeLayer(p.labelMarker);
        plots.splice(idx, 1);
        showToast('↩ "' + action.data.name + '" ' + t('הוסר'));
      }
    } else if (action.type === 'delete') {
      var d = action.data;
      var latlngs = d.latlngs.map(function(c) { return L.latLng(c.lat !== undefined ? c.lat : c[0], c.lng !== undefined ? c.lng : c[1]); });
      var layer = L.polygon(latlngs, { color: d.color, fillColor: d.color, weight: 3, fillOpacity: 0.25 }).addTo(drawnItems);
      var center = layer.getBounds().getCenter();
      var label = L.divIcon({
        className: '',
        html: '<div style="background:' + d.color + ';color:white;padding:3px 10px;border-radius:8px;' +
          'font-family:Heebo,sans-serif;font-size:12px;font-weight:700;white-space:nowrap;' +
          'box-shadow:0 2px 8px rgba(0,0,0,0.3);text-align:center;">' + d.name + '</div>',
        iconAnchor: [0, 0]
      });
      var labelMarker = L.marker(center, { icon: label, interactive: false }).addTo(drawnItems);
      plots.push({ 
        id: d.id, 
        name: d.name, 
        color: d.color, 
        area: d.area, 
        farm_id: d.farm_id,
        layer: layer, 
        labelMarker: labelMarker, 
        vertices: d.vertices 
      });
      showToast('↩ "' + d.name + '" ' + t('שוחזר'));
    }

    renderPlotList();
    saveData();
    undoBar.classList.remove('show');
    if (undoStack.length === 0) undoActionBtn.style.display = 'none';
  }

  undoBarBtn.addEventListener('click', function(e) { e.stopPropagation(); performUndo(); });
  undoActionBtn.addEventListener('click', function(e) { e.stopPropagation(); performUndo(); });

  // ── Naming modal ──
  function showNamingModal(layer, vertices) {
    var container = document.getElementById('modalContainer');
    var area = calcArea(layer);
    
    // Build farm selector
    var session = JSON.parse(sessionStorage.getItem('currentUser'));
    var userFarms = getUserFarms(session);
    var farmOptions = '';
    if (userFarms.length === 0) {
      farmOptions = '<option value="">' + t('אין מטעים זמינים') + '</option>';
    } else {
      userFarms.forEach(function(farm) {
        farmOptions += '<option value="' + farm.id + '">' + locName(farm) + '</option>';
      });
    }
    
    // Common planting patterns (row x tree spacing in meters)
    var spacingPresets = [
      { label: '8×8', row: 8, tree: 8 },
      { label: '8×9', row: 8, tree: 9 },
      { label: '9×9', row: 9, tree: 9 },
    ];
    
    var presetsHtml = '';
    spacingPresets.forEach(function(p) {
      presetsHtml += '<button class="btn-admin spacing-preset" data-row="' + p.row + '" data-tree="' + p.tree + '" style="padding: 8px 16px; font-size: 0.85rem; border-radius: 10px;">' + p.label + '</button>';
    });
    presetsHtml += '<button class="btn-admin spacing-preset" data-row="0" data-tree="0" style="padding: 8px 16px; font-size: 0.85rem; border-radius: 10px;">✏️ ' + t('ידני') + '</button>';
    
    // Build crop type options from admin-defined list
    var cropList = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]');
    var cropOptions = '<option value="">' + t('בחר גידול') + '</option>';
    cropList.forEach(function(c) {
      cropOptions += '<option value="' + c + '">' + c + '</option>';
    });

    container.innerHTML =
      '<div class="modal-overlay" id="modalOverlay">' +
        '<div class="modal">' +
          '<h2>🌿 ' + t('חלקה חדשה') + '</h2>' +
          '<p>' + t('תן שם לחלקה שסימנת') + ' — ' + formatArea(area) + '</p>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('שם החלקה') + '</label>' +
            '<input type="text" id="plotNameInput" class="form-input" placeholder="">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('מטע') + '</label>' +
            '<select id="plotFarmSelect" class="form-input" required>' + farmOptions + '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('סוג גידול') + '</label>' +
            '<select id="plotCropType" class="form-input">' + cropOptions + '</select>' +
          '</div>' +
          
          '<div style="background: var(--g6); border-radius: 12px; padding: 14px; margin-bottom: 14px;">' +
            '<div style="font-size: 0.82rem; font-weight: 700; color: var(--g1); margin-bottom: 8px;">🌴 ' + t('צפיפות צמחים') + '</div>' +
            '<div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 10px;">' + t('בחר שיטת חישוב') + '</div>' +
            '<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;">' +
              presetsHtml +
              '<button class="btn-admin spacing-preset" data-row="-1" data-tree="-1" style="padding: 8px 16px; font-size: 0.85rem; border-radius: 10px;">📊 ' + t('צמחים לדונם') + '</button>' +
            '</div>' +
            '<div id="manualSpacingRow" style="display: none; margin-bottom: 10px;">' +
              '<div style="display: flex; gap: 8px; align-items: center;">' +
                '<div style="flex: 1;">' +
                  '<label style="font-size: 0.7rem; color: var(--text-muted);">' + t('בין שורות') + ' (' + t('מ\'') + ')</label>' +
                  '<input type="number" class="form-input" id="plotRowSpacing" min="1" max="20" step="0.5" value="8" style="padding: 8px; font-size: 0.85rem;">' +
                '</div>' +
                '<span style="font-size: 1.2rem; margin-top: 14px;">×</span>' +
                '<div style="flex: 1;">' +
                  '<label style="font-size: 0.7rem; color: var(--text-muted);">' + t('בין עצים') + ' (' + t('מ\'') + ')</label>' +
                  '<input type="number" class="form-input" id="plotTreeSpacing" min="1" max="20" step="0.5" value="8" style="padding: 8px; font-size: 0.85rem;">' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div id="manualDensityRow" style="display: none; margin-bottom: 10px;">' +
              '<label style="font-size: 0.7rem; color: var(--text-muted);">' + t('צמחים לדונם') + '</label>' +
              '<input type="number" class="form-input" id="plotPlantsPerDunam" min="1" step="1" value="" placeholder="156" style="padding: 8px; font-size: 0.85rem;">' +
            '</div>' +
            '<div id="treeEstimateResult" style="background: linear-gradient(135deg, var(--g1), var(--g2)); border-radius: 10px; padding: 12px; color: white; text-align: center;">' +
              '<div style="font-size: 0.72rem; opacity: 0.8;">' + t('מספר צמחים משוער') + '</div>' +
              '<div style="font-size: 1.8rem; font-weight: 700;" id="treeEstimateNum">—</div>' +
              '<div style="font-size: 0.7rem; opacity: 0.7;" id="treeEstimateMeta"></div>' +
            '</div>' +
            '<div class="form-group" style="margin-top: 10px; margin-bottom: 0;">' +
              '<label style="font-size: 0.7rem; color: var(--text-muted);">' + t('מספר צמחים סופי (ניתן לעריכה)') + '</label>' +
              '<input type="number" class="form-input" id="plotTreeCount" min="0" step="1" value="" style="padding: 8px; font-size: 0.95rem; font-weight: 700; text-align: center;">' +
            '</div>' +
          '</div>' +
          
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" id="modalSave">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" id="modalCancel">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var input = document.getElementById('plotNameInput');
    var rowInput = document.getElementById('plotRowSpacing');
    var treeInput = document.getElementById('plotTreeSpacing');
    var treeCountInput = document.getElementById('plotTreeCount');
    setTimeout(function() { input.focus(); }, 150);

    function updateTreeEstimate() {
      var rowS = parseFloat(rowInput.value) || 8;
      var treeS = parseFloat(treeInput.value) || 8;
      var treesPerDunam = 1000 / (rowS * treeS);
      var est = Math.round(area * treesPerDunam);
      document.getElementById('treeEstimateNum').textContent = est.toLocaleString();
      document.getElementById('treeEstimateMeta').textContent = treesPerDunam.toFixed(1) + ' ' + t('עצים') + '/' + t('דונם') + ' • ' + rowS + '×' + treeS + 'מ\'';
      treeCountInput.value = est;
    }
    
    // Don't auto-calculate until user picks a preset
    rowInput.addEventListener('input', updateTreeEstimate);
    treeInput.addEventListener('input', updateTreeEstimate);

    // Preset buttons
    container.querySelectorAll('.spacing-preset').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var r = parseInt(this.getAttribute('data-row'));
        var tr = parseInt(this.getAttribute('data-tree'));
        
        // Visual feedback
        container.querySelectorAll('.spacing-preset').forEach(function(b) { b.style.background = 'var(--g5)'; b.style.color = 'var(--g1)'; });
        this.style.background = 'var(--g2)';
        this.style.color = 'white';
        
        var manualRow = document.getElementById('manualSpacingRow');
        var densityRow = document.getElementById('manualDensityRow');
        
        if (r === -1) {
          // Plants per dunam mode
          manualRow.style.display = 'none';
          densityRow.style.display = 'block';
          var densityInput = document.getElementById('plotPlantsPerDunam');
          densityInput.focus();
          densityInput.addEventListener('input', function() {
            var ppd = parseInt(this.value) || 0;
            var est = Math.round(area * ppd);
            document.getElementById('treeEstimateNum').textContent = est.toLocaleString();
            document.getElementById('treeEstimateMeta').textContent = ppd + ' ' + t('צמחים') + '/' + t('דונם');
            treeCountInput.value = est;
          });
        } else if (r === 0) {
          // Manual spacing mode
          manualRow.style.display = 'block';
          densityRow.style.display = 'none';
          rowInput.focus();
          updateTreeEstimate();
        } else {
          // Preset spacing
          manualRow.style.display = 'none';
          densityRow.style.display = 'none';
          rowInput.value = r;
          treeInput.value = tr;
          updateTreeEstimate();
        }
      });
    });

    function save() {
      var name = input.value.trim() || t('חלקה') + ' ' + (plots.length + 1);
      var farmSelect = document.getElementById('plotFarmSelect');
      var farmId = parseInt(farmSelect.value);
      
      if (!farmId) {
        showToast('❌ ' + t('חובה לבחור מטע'));
        return;
      }
      
      var selectedFarm = farms.find(function(f) { return f.id === farmId; });
      var color = selectedFarm ? selectedFarm.color : COLORS[colorIdx % COLORS.length];
      var center = layer.getBounds().getCenter();

      var label = L.divIcon({
        className: '',
        html: '<div style="background:' + color + ';color:white;padding:3px 10px;border-radius:8px;' +
          'font-family:Heebo,sans-serif;font-size:12px;font-weight:700;white-space:nowrap;' +
          'box-shadow:0 2px 8px rgba(0,0,0,0.3);text-align:center;">' + name + '</div>',
        iconAnchor: [0, 0]
      });
      var labelMarker = L.marker(center, { icon: label, interactive: false }).addTo(drawnItems);

      var treeCount = parseInt(treeCountInput.value) || null;
      var rowSpacing = parseFloat(rowInput.value) || null;
      var treeSpacing = parseFloat(treeInput.value) || null;
      var cropType = document.getElementById('plotCropType').value || null;
      var plantsPerDunam = parseInt(document.getElementById('plotPlantsPerDunam').value) || null;

      var plot = { 
        id: Date.now(), 
        name: name, 
        color: color, 
        area: area, 
        farm_id: farmId,
        tree_count: treeCount,
        row_spacing: rowSpacing,
        tree_spacing: treeSpacing,
        crop_type: cropType,
        plants_per_dunam: plantsPerDunam,
        layer: layer, 
        labelMarker: labelMarker, 
        vertices: vertices 
      };
      plots.push(plot);
      
      // Click handler on polygon
      layer.on('click', function() {
        if (!drawMode) showPlotDetails(plot.id);
      });
      var latlngs = layer.getLatLngs()[0].map(function(ll) { return [ll.lat, ll.lng]; });
      pushUndo('add', { id: plot.id, name: name, color: color, area: area, farm_id: farmId, vertices: vertices, latlngs: latlngs });

      container.innerHTML = '';
      renderPlotList();
      saveData();
      var treeMsg = treeCount ? ' • 🌴 ' + treeCount + ' ' + t('עצים') : '';
      showToast('✅ "' + name + '" — ' + formatArea(area) + treeMsg);
      panelEl.classList.remove('collapsed');
    }

    function cancel() {
      drawnItems.removeLayer(layer);
      container.innerHTML = '';
    }

    document.getElementById('modalSave').addEventListener('click', save);
    document.getElementById('modalCancel').addEventListener('click', cancel);
    document.getElementById('modalOverlay').addEventListener('click', function(e) { if (e.target === this) cancel(); });
    input.addEventListener('keydown', function(e) { if (e.key === 'Enter') save(); });
  }

  // ── Plot list ──
  function renderPlotList() {
    var list = document.getElementById('plotList');
    var accessiblePlots = getAccessiblePlots();
    document.getElementById('plotCount').textContent = accessiblePlots.length;

    if (accessiblePlots.length === 0) {
      list.innerHTML = '<div class="empty-state"><div class="icon">📐</div>' +
        '<p>' + t('עדיין אין חלקות מסומנות') + '.<br>' + t('לחץ על ➕ כדי להתחיל') + '.</p></div>';
      return;
    }

    var html = '';
    for (var i = 0; i < accessiblePlots.length; i++) {
      var p = accessiblePlots[i];
      var isPrimary = currentUser && currentUser.primary_plot_id === p.id;
      html += '<div class="plot-card" data-plot-id="' + p.id + '">' +
        '<div class="plot-color" style="background:' + p.color + '"></div>' +
        '<div class="plot-info">' +
          '<div class="plot-name">' + (isPrimary ? '⭐ ' : '') + locName(p) + '</div>' +
          '<div class="plot-meta">' +
            '<span>📐 ' + formatArea(p.area) + '</span>' +
            '<span>📍 ' + p.vertices + ' ' + t('נקודות') + '</span>' +
            (p.tree_count ? '<span>🌴 ' + p.tree_count + '</span>' : '') +
          '</div>' +
          getPlotIrrigationBadge(p.id) +
          '<div class="plot-nav">' + t('לחץ לפרטי חלקה →') + '</div>' +
        '</div>' +
        '<button class="plot-delete" data-delete-id="' + p.id + '">🗑</button>' +
      '</div>';
    }
    list.innerHTML = html;

    list.querySelectorAll('[data-plot-id]').forEach(function(card) {
      card.addEventListener('click', function(e) {
        if (e.target.closest('[data-delete-id]')) return;
        var plotId = parseInt(this.getAttribute('data-plot-id'));
        showPlotDetails(plotId);
      });
    });

    list.querySelectorAll('[data-delete-id]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var plotId = parseInt(this.getAttribute('data-delete-id'));
        var plot = plots.find(function(p) { return p.id === plotId; });
        if (!plot) return;
        // Check user has access to this plot's farm
        if (currentUser && currentUser.role !== 'admin') {
          var userFarmIds = (currentUser.farm_permissions || []);
          if (userFarmIds.length > 0 && userFarmIds.indexOf(plot.farm_id) === -1) {
            showToast(t('⛔ אין לך הרשאה למחוק חלקה זו'));
            return;
          }
        }
        
        var latlngs = [];
        if (plot.layer && typeof plot.layer.getLatLngs === 'function') {
          latlngs = plot.layer.getLatLngs()[0].map(function(ll) { return [ll.lat, ll.lng]; });
        } else if (plot.latlngs) {
          latlngs = plot.latlngs;
        }
        pushUndo('delete', { id: plot.id, name: plot.name, color: plot.color, area: plot.area, vertices: plot.vertices, farm_id: plot.farm_id, latlngs: latlngs });
        if (plot.layer) drawnItems.removeLayer(plot.layer);
        if (plot.labelMarker) drawnItems.removeLayer(plot.labelMarker);
        var plotIdx = plots.indexOf(plot);
        if (plotIdx !== -1) plots.splice(plotIdx, 1);
        renderPlotList();
        saveData();
        showToast('🗑 "' + locName(plot) + '" ' + t('נמחק'));
      });
    });
  }

  document.getElementById('panelHandle').addEventListener('click', function() {
    panelEl.classList.toggle('collapsed');
  });

  // ── Spray form ──
  function renderPlotCheckboxes() {
    var container = document.getElementById('plotCheckboxList');
    var accessiblePlots = getAccessiblePlots();
    
    if (accessiblePlots.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 16px;"><p>' + t('אין חלקות זמינות') + '. ' + t('הוסף חלקות בלשונית המפה') + '.</p></div>';
      return;
    }

    var html = '';
    accessiblePlots.forEach(function(p) {
      html += '<label class="plot-checkbox-item">' +
        '<input type="checkbox" class="plot-checkbox" data-plot-id="' + p.id + '">' +
        '<span class="plot-checkbox-label">' + locName(p) + '</span>' +
        '<span class="plot-checkbox-area">' + formatArea(p.area) + '</span>' +
      '</label>';
    });
    container.innerHTML = html;

    container.querySelectorAll('.plot-checkbox').forEach(function(cb) {
      cb.addEventListener('change', updateCalculations);
    });
  }

  function renderPesticideList() {
    var container = document.getElementById('pesticideList');
    if (pesticides.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 16px;"><p>' + t('אין חומרי הדברה') + '. ' + t('הוסף בלשונית הניהול') + '.</p></div>';
      return;
    }

    var html = '';
    pesticides.forEach(function(pest) {
      html += '<div class="pesticide-item" data-pesticide-id="' + pest.id + '">' +
        '<div class="pesticide-name">' + pest.productName + '</div>' +
        '<div class="pesticide-active">' + pest.activeIngredient + ' • ' + pest.commonTargets + '</div>' +
        '<div class="pesticide-concentration-input">' +
          '<label class="form-label" style="margin-top: 8px;">' + t('ריכוז (%)') + '</label>' +
          '<input type="number" class="form-input concentration-input" data-pest-id="' + pest.id + '" value="' + pest.defaultConcentration + '" step="0.001" min="0">' +
          '<label class="form-label" style="margin-top: 8px;">' + t('מטרה') + '</label>' +
          '<input type="text" class="form-input target-input" data-pest-id="' + pest.id + '" value="' + pest.commonTargets.split(',')[0].trim() + '" placeholder="מזיק/מחלה">' +
        '</div>' +
      '</div>';
    });
    container.innerHTML = html;

    container.querySelectorAll('.pesticide-item').forEach(function(item) {
      item.addEventListener('click', function(e) {
        if (e.target.classList.contains('form-input')) return;
        this.classList.toggle('selected');
        updateCalculations();
      });
    });

    container.querySelectorAll('.concentration-input, .target-input').forEach(function(input) {
      input.addEventListener('input', updateCalculations);
    });
  }

  // The purpose and the irrigation toggle pick the sensible unit, but the
  // operator can still override it — once they touch the select by hand we
  // stop steering it, because they know their sprayer better than we do.
  var _unitTouched = false;

  function selectedGear() {
    var out = [];
    document.querySelectorAll('#sprayGearList .gear-chip.on').forEach(function(c) {
      out.push(c.getAttribute('data-gear'));
    });
    return out;
  }

  function currentUnit() {
    var el = document.getElementById('volumeUnit');
    return el ? el.value : 'l_tree';
  }

  function suggestUnit() {
    var purposeEl = document.getElementById('sprayPurpose');
    var irrEl = document.getElementById('sprayViaIrrigation');
    var unitEl = document.getElementById('volumeUnit');
    if (!unitEl) return;
    if (!_unitTouched) {
      // Through the irrigation line the dose is small enough that litres per
      // tree stops being readable — cc per tree is how it is actually mixed.
      if (irrEl && irrEl.checked) unitEl.value = 'cc_tree';
      else if (purposeEl && (purposeEl.value === 'weeds' || purposeEl.value === 'preemerge')) unitEl.value = 'l_dunam';
      else unitEl.value = 'l_tree';
    }
    syncVolumeLabel();
  }

  function syncVolumeLabel() {
    var lbl = document.getElementById('volumePerTreeLabel');
    var u = unitOf(currentUnit());
    if (lbl) {
      lbl.textContent = (u.perTree ? t('מנה לעץ') : t('מנה לדונם')) + ' (' + u.label + ')';
    }
    var cap = document.getElementById('sprayerCapacity');
    var capLbl = cap ? cap.parentNode.querySelector('.form-label') : null;
    var irrEl = document.getElementById('sprayViaIrrigation');
    if (capLbl) {
      capLbl.textContent = (irrEl && irrEl.checked)
        ? t('נפח מילוי / מיכל דישון (ליטר)')
        : t('קיבולת מרסס (ליטר)');
    }
  }

  (function wireSprayPurpose() {
    var start = function() {
      var purposeEl = document.getElementById('sprayPurpose');
      var irrEl = document.getElementById('sprayViaIrrigation');
      var unitEl = document.getElementById('volumeUnit');
      if (!purposeEl || !unitEl) return;
      purposeEl.addEventListener('change', function() { suggestUnit(); updateCalculations(); });
      if (irrEl) irrEl.addEventListener('change', function() { suggestUnit(); updateCalculations(); });
      unitEl.addEventListener('change', function() {
        _unitTouched = true;
        syncVolumeLabel();
        updateCalculations();
      });
      document.querySelectorAll('#sprayGearList .gear-chip').forEach(function(chip) {
        chip.addEventListener('click', function() { chip.classList.toggle('on'); });
      });
      suggestUnit();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  })();

  function updateCalculations() {
    var selectedPlots = [];
    document.querySelectorAll('.plot-checkbox:checked').forEach(function(cb) {
      var plotId = parseInt(cb.getAttribute('data-plot-id'));
      var plot = plots.find(function(p) { return p.id === plotId; });
      if (plot) selectedPlots.push(plot);
    });

    var selectedPesticides = [];
    document.querySelectorAll('.pesticide-item.selected').forEach(function(item) {
      var pestId = parseInt(item.getAttribute('data-pesticide-id'));
      var pest = pesticides.find(function(p) { return p.id === pestId; });
      var concInput = document.querySelector('.concentration-input[data-pest-id="' + pestId + '"]');
      var targetInput = document.querySelector('.target-input[data-pest-id="' + pestId + '"]');
      if (pest && concInput && targetInput) {
        selectedPesticides.push({
          pesticide: pest,
          concentration: parseFloat(concInput.value) || 0,
          target: targetInput.value.trim()
        });
      }
    });

    var volumePerTree = parseFloat(document.getElementById('volumePerTree').value) || 0;
    var sprayerCapacity = parseFloat(document.getElementById('sprayerCapacity').value) || 0;

    var container = document.getElementById('calcResults');

    if (selectedPlots.length === 0 || selectedPesticides.length === 0 || volumePerTree === 0 || sprayerCapacity === 0) {
      container.innerHTML = '';
      return;
    }

    var unitKey = currentUnit();
    var unit = unitOf(unitKey);
    var totalArea = selectedPlots.reduce(function(sum, p) { return sum + p.area; }, 0);
    var totalTrees = Math.round(totalArea * TREES_PER_DUNAM);
    // Litres in the tank, whatever unit the dose was entered in.
    var totalVolume = doseToLitres(volumePerTree, unitKey, totalArea);
    var iterations = Math.ceil(totalVolume / sprayerCapacity);

    var html = '<div class="calc-results">';
    html += '<div class="calc-row"><span class="calc-label">' + t('שטח כולל') + '</span><span class="calc-value">' + totalArea.toFixed(2) + ' ' + t('דונם') + '</span></div>';
    if (unit.perTree) {
      html += '<div class="calc-row"><span class="calc-label">' + t('מספר עצים') + '</span><span class="calc-value">' + totalTrees + ' ' + t('עצים') + '</span></div>';
    }
    html += '<div class="calc-row"><span class="calc-label">' + t('מנה') + '</span><span class="calc-value">' + volumePerTree + ' ' + unit.label + '</span></div>';
    html += '<div class="calc-row"><span class="calc-label">' + t('נפח כולל') + '</span><span class="calc-value">' + totalVolume.toFixed(0) + ' ' + t('ליטר') + '</span></div>';
    html += '<div class="calc-row"><span class="calc-label">' + t('מספר מילויים') + '</span><span class="calc-value">' + iterations + ' ' + t('מילויים') + '</span></div>';
    
    selectedPesticides.forEach(function(sp) {
      var amountTotal = (totalVolume * sp.concentration / 100).toFixed(2);
      var amountPerIter = (sprayerCapacity * sp.concentration / 100).toFixed(2);
      html += '<div class="calc-row" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.3);">';
      html += '<span class="calc-label" style="font-weight: 700;">' + sp.pesticide.productName + '</span>';
      html += '<span class="calc-value">' + amountTotal + ' ' + t('ליטר') + '</span>';
      html += '</div>';
      html += '<div class="calc-row" style="border: none; padding-top: 4px;">';
      html += '<span class="calc-label" style="font-size: 0.85rem; opacity: 0.8;">' + t('למילוי אחד') + '</span>';
      html += '<span class="calc-value" style="font-size: 0.85rem;">' + amountPerIter + ' ' + t('ליטר') + '</span>';
      html += '</div>';
    });

    html += '</div>';
    container.innerHTML = html;
  }

  var today = new Date();
  document.getElementById('sprayDate').value = today.toISOString().split('T')[0];

  document.getElementById('volumePerTree').addEventListener('input', updateCalculations);
  document.getElementById('sprayerCapacity').addEventListener('input', updateCalculations);

  document.getElementById('submitSpray').addEventListener('click', function() {
    var date = document.getElementById('sprayDate').value;
    var operator = document.getElementById('operatorName').value.trim();
    var volumePerTree = parseFloat(document.getElementById('volumePerTree').value) || 0;
    var sprayerCapacity = parseFloat(document.getElementById('sprayerCapacity').value) || 0;
    var volumeUnit = currentUnit();
    var purposeEl = document.getElementById('sprayPurpose');
    var purpose = purposeEl ? purposeEl.value : 'pest';
    var irrEl = document.getElementById('sprayViaIrrigation');
    var viaIrrigation = !!(irrEl && irrEl.checked);
    var gear = selectedGear();

    if (!date || !operator) {
      showToast('❌ ' + t('חובה למלא תאריך ושם מפעיל'));
      return;
    }

    var selectedPlotIds = [];
    document.querySelectorAll('.plot-checkbox:checked').forEach(function(cb) {
      selectedPlotIds.push(parseInt(cb.getAttribute('data-plot-id')));
    });

    if (selectedPlotIds.length === 0) {
      showToast('❌ ' + t('בחר לפחות חלקה אחת'));
      return;
    }

    var applications = [];
    document.querySelectorAll('.pesticide-item.selected').forEach(function(item) {
      var pestId = parseInt(item.getAttribute('data-pesticide-id'));
      var pest = pesticides.find(function(p) { return p.id === pestId; });
      var concInput = document.querySelector('.concentration-input[data-pest-id="' + pestId + '"]');
      var targetInput = document.querySelector('.target-input[data-pest-id="' + pestId + '"]');
      if (pest && concInput && targetInput) {
        applications.push({
          activeIngredient: pest.activeIngredient,
          productName: pest.productName,
          concentration: parseFloat(concInput.value) || 0,
          target: targetInput.value.trim()
        });
      }
    });

    if (applications.length === 0) {
      showToast('❌ ' + t('בחר לפחות חומר הדברה אחד'));
      return;
    }

    // ── One record per מטע ───────────────────────────────
    // One tank mix sprayed across two farms is still two jobs on paper: each
    // grower's log must show only their own plots, area and totals — never a
    // line revealing that the same pass covered someone else's block.
    // Splitting here, at entry, is the only clean place; splitting later
    // would mean rewriting signed history. Siblings carry a shared batchId so
    // the app can still say "same trip".
    var farmGroups = [];
    var _byFarm = {};
    selectedPlotIds.forEach(function(pid) {
      var p = plots.find(function(pl) { return pl.id === pid; });
      var fid = (p && p.farm_id) ? p.farm_id : 0;
      if (!_byFarm[fid]) {
        _byFarm[fid] = { farmId: fid || null, plotIds: [] };
        farmGroups.push(_byFarm[fid]);
      }
      _byFarm[fid].plotIds.push(pid);
    });

    var allLinkedIds = (window.SprayLink ? window.SprayLink.getSelectedReportIds() : []);
    var linkedReportObjs = (window.SprayLink && window.SprayLink.reportsById)
      ? window.SprayLink.reportsById(allLinkedIds) : [];
    var reconMeta = (window.SprayReconstruct ? window.SprayReconstruct.getMeta() : null);

    // Siblings share the batch stamp but never an id. Walk past anything
    // already taken — two entries inside the same millisecond are rare, but a
    // collision would silently overwrite a compliance record.
    var batchId = Date.now();
    var _usedIds = {};
    sprayEvents.forEach(function(e) { _usedIds[e.id] = true; });
    var _nextId = batchId;
    var freshId = function() {
      while (_usedIds[_nextId]) _nextId++;
      _usedIds[_nextId] = true;
      return _nextId++;
    };

    farmGroups.forEach(function(g) {
      // A scouting report hangs off a single plot, so it belongs to a single
      // farm — carry each one only into the record it actually justifies.
      var ownLinked = allLinkedIds.filter(function(rid) {
        var r = linkedReportObjs.find(function(x) { return x && x.id === rid; });
        return r ? g.plotIds.indexOf(parseInt(r.plotId, 10)) !== -1 : false;
      });

      sprayEvents.push({
        id: freshId(),
        date: date,
        operator: operator,
        plotIds: g.plotIds.slice(),
        // Explicit owner. Per-farm reports filter on this instead of inferring
        // from plot membership, so a record cannot surface in another
        // grower's log.
        farmId: g.farmId,
        volumePerTree: volumePerTree,
        // The dose above is meaningless without its unit — a record written
        // before this field existed is litres per tree, which is what the
        // reader is defaulted to.
        volumeUnit: volumeUnit,
        sprayerCapacity: sprayerCapacity,
        // What the pass was for, what it was applied with, and whether it
        // went through the irrigation line rather than a sprayer.
        purpose: purpose,
        gear: gear.slice(),
        viaIrrigation: viaIrrigation,
        // Deep copy: editing one sibling later must not mutate the others.
        applications: JSON.parse(JSON.stringify(applications)),
        // Inspection reports this spray responds to (spray-pest-link.js).
        linkedReportIds: ownLinked,
        // Same trip, separate paperwork.
        batchId: batchId,
        batchSize: farmGroups.length,
        // `date` is when the spray happened; enteredAt is when it was keyed in.
        // A record entered late is still an honest record if it says so.
        enteredAt: Date.now(),
        enteredBy: (window.currentUser ? window.currentUser.username : ''),
        // Provenance when the spray is being pieced back together after the
        // fact (spray-reconstruct.js). null for a normal contemporaneous entry.
        reconstruction: reconMeta ? JSON.parse(JSON.stringify(reconMeta)) : null
      });
    });

    saveData();

    if (farmGroups.length > 1) {
      var _labels = farmGroups.map(function(g) {
        var f = (farms || []).find(function(x) { return x.id === g.farmId; });
        return f ? f.name : t('ללא מטע');
      }).join(' · ');
      showToast('✅ ' + farmGroups.length + ' ' +
        t('רשומות נשמרו — אחת לכל מטע') + ': ' + _labels);
    } else {
      showToast('✅ ' + t('רשומה נשמרה מקומית'));
    }

    document.getElementById('operatorName').value = '';
    document.querySelectorAll('.plot-checkbox').forEach(function(cb) { cb.checked = false; });
    document.querySelectorAll('.pesticide-item').forEach(function(item) { item.classList.remove('selected'); });
    if (window.SprayLink && typeof window.SprayLink.reset === 'function') window.SprayLink.reset();
    if (window.SprayReconstruct && typeof window.SprayReconstruct.reset === 'function') window.SprayReconstruct.reset();
    updateCalculations();

    // History now lives inside the spray tab as a sub-view.
    showSpraySubview('history');
  });

  // ── History ──
  // Reports arrive after first paint, so any history already on screen was
  // drawn without its chain lines. Redraw when they land.
  document.addEventListener('shorashim:reports-ready', function() {
    var view = document.getElementById('spraySubviewHistory');
    if (view && view.style.display !== 'none') {
      try { renderHistoryList(); } catch (e) {}
    }
  });

  function renderHistoryList() {
    var container = document.getElementById('historyList');
    var allEvents = getAccessibleSprayEvents();
    var voidedCount = allEvents.filter(function(e) { return e.voided; }).length;
    var accessibleEvents = _showVoided ? allEvents
      : allEvents.filter(function(e) { return !e.voided; });

    var filteredOut = 0;
    if (window.SprayFilter && typeof window.SprayFilter.apply === 'function') {
      var beforeCount = accessibleEvents.length;
      accessibleEvents = window.SprayFilter.apply(accessibleEvents);
      filteredOut = beforeCount - accessibleEvents.length;
    }

    var voidBar = '';
    if (voidedCount) {
      voidBar = '<div class="void-bar"><button type="button" class="void-toggle" ' +
        'onclick="SprayStore.showVoided(' + (!_showVoided) + ')">' +
        (_showVoided ? t('הסתר רשומות שבוטלו') : t('הצג רשומות שבוטלו')) +
        ' (' + voidedCount + ')</button></div>';
    }

    if (accessibleEvents.length === 0) {
      container.innerHTML = voidBar + '<div class="empty-state"><div class="icon">📋</div>' +
        '<p>' + t(filteredOut > 0 ? 'אין רשומות התואמות את הסינון' : 'אין היסטוריה') + '</p></div>';
      try { document.dispatchEvent(new CustomEvent('shorashim:history-rendered',
        { detail: { shown: 0, filteredOut: filteredOut } })); } catch (e) {}
      return;
    }

    var sorted = accessibleEvents.slice().sort(function(a, b) {
      return new Date(b.date) - new Date(a.date);
    });

    // An orphan bar, because these records are otherwise unreachable: they
    // carry no plot, so no filter, farm view or plot picker can find them.
    var orphans = allEvents.filter(isOrphanEvent);
    if (orphans.length) {
      var isAdm = (currentUser && currentUser.role === 'admin');
      voidBar += '<div class="orphan-bar">⚠️ ' + orphans.length + ' ' +
        t('רשומות ללא חלקה מזוהה — אינן מודפסות בדוח למגדל') +
        (isAdm ? ' <button type="button" class="orphan-purge" ' +
          'onclick="SprayStore.purgeOrphans()">' +
          t('מחק את כולן') + '</button>' : '') +
        '</div>';
    }

    var html = voidBar;
    sorted.forEach(function(event) {
      // One bad record used to throw here and kill the rest of the render,
      // which is the other half of why it was invisible. Per-row guard.
      try {
      var _orph = orphanState(event);
      var plotNames = (event.plotIds || []).map(function(id) {
        var p = plots.find(function(plot) { return plot.id === id; });
        return p ? p.name : t('חלקה לא ידועה');
      }).join(', ');

      if (!plotNames) plotNames = t('חלקה לא ידועה');

      var totalArea = (event.plotIds || []).reduce(function(sum, id) {
        var p = plots.find(function(plot) { return plot.id === id; });
        return sum + (p ? p.area : 0);
      }, 0);

      // Collapse all pesticides for this event into one combined list under a single date row.
      var pestSummary = (event.applications || []).map(function(app) {
        var parts = [app.productName || ''];
        if (app.activeIngredient) parts.push('(' + app.activeIngredient + ')');
        if (app.concentration != null) parts.push('· ' + app.concentration + '%');
        if (app.target) parts.push('· ' + app.target);
        return '🧪 ' + parts.join(' ');
      }).join('<br>');

      var recon = event.reconstruction && event.reconstruction.reconstructed ? event.reconstruction : null;
      var reconBadge = '';
      if (recon) {
        var rc = recon.confidence || '';
        var rcLabel = rc === 'high' ? t('ודאות גבוהה') : rc === 'medium' ? t('ודאות בינונית') : rc === 'low' ? t('ודאות נמוכה') : '';
        reconBadge = '<span class="recon-badge recon-' + rc + '">' + t('שחזור') + (rcLabel ? ' · ' + rcLabel : '') + '</span>';
      }

      html += '<div class="history-item' + (recon ? ' is-reconstructed' : '') +
        (event.voided ? ' is-voided' : '') + '">';
      if (event.voided) {
        html += '<div class="void-banner">🚫 ' + t('רשומה בוטלה') + ' · ' +
          new Date(event.voided.at).toLocaleDateString('he-IL') + ' · ' +
          (event.voided.byName || event.voided.by || '') +
          (event.voided.reason ? ' — ' + event.voided.reason : '') + '</div>';
      }
      html += '<div class="history-header">';
      if (window.SprayEdit && window.SprayEdit.canEdit()) {
        html += '<input type="checkbox" class="hist-select" value="' + event.id + '">';
      }
      html += '<span class="history-date">' + formatDate(event.date) + reconBadge + '</span>';
      var revCount = (event.revisions || []).length;
      var revBadge = revCount
        ? '<span class="rev-badge" title="' + t('נערך') + '">✏ ' + revCount + '</span>' : '';
      var canEditRow = window.SprayEdit && window.SprayEdit.canEdit();
      html += '<span class="history-operator">' + event.operator + revBadge +
        (canEditRow
          ? '<button type="button" class="history-edit" onclick="SprayEdit.open(' + event.id + ')">✏️</button>'
          : '') + '</span>';
      html += '</div>';
      // Which grower's log this record lands in — stamped on new records,
      // derived from the first plot for legacy ones.
      var evFarmId = event.farmId || null;
      if (!evFarmId) {
        var _fp = plots.find(function(pl) { return (event.plotIds || []).indexOf(pl.id) !== -1; });
        evFarmId = (_fp && _fp.farm_id) ? _fp.farm_id : null;
      }
      var _evFarm = evFarmId ? (farms || []).find(function(f) { return f.id === evFarmId; }) : null;
      var farmChip = _evFarm
        ? '<span class="history-farm">🌳 ' + _evFarm.name + '</span>' : '';
      if (_orph.orphan) {
        farmChip = '<span class="history-orphan" title="' +
          t('החלקות של הרשומה אינן קיימות במערכת') +
          '">⚠️ ' + t('ללא חלקה מזוהה') + '</span>' + farmChip;
      }
      var batchChip = (event.batchSize > 1)
        ? '<span class="history-batch" title="' +
          t('אותו יישום נרשם בנפרד לכל מטע') +
          '">⛓ ' + event.batchSize + ' מטעים</span>' : '';
      html += '<div class="history-plots">' + farmChip + batchChip + t('חלקות') + ': ' + plotNames + ' (' + totalArea.toFixed(2) + ' ' + t('דונם') + ')</div>';
      var purposeTag = (event.purpose && event.purpose !== 'pest')
        ? '<span class="spray-purpose-tag">' + t(purposeLabel(event.purpose)) + '</span>' : '';
      var irrTag = event.viaIrrigation
        ? '<span class="spray-gear-tag">💧 ' + t('דרך השקיה') + '</span>' : '';
      var gearTags = (event.gear || []).map(function(g) {
        return '<span class="spray-gear-tag">' + g + '</span>';
      }).join('');
      if (purposeTag || irrTag || gearTags) {
        html += '<div class="history-tags" style="margin-top:5px;">' + purposeTag + irrTag + gearTags + '</div>';
      }
      html += '<div class="history-meta" style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px;">';
      html += event.volumePerTree + ' ' + t(unitShort(event.volumeUnit)) + ' • ' +
        t(event.viaIrrigation ? 'מיכל דישון' : 'מרסס') + ' ' +
        event.sprayerCapacity + ' ' + t('ליטר');
      html += '</div>';
      if (recon && recon.evidenceBasis) {
        html += '<div class="history-recon">' + t('על סמך') + ': ' + recon.evidenceBasis +
          (recon.sourceRefs ? ' · ' + recon.sourceRefs : '') +
          (recon.reconstructedBy ? ' · ' + t('שוחזר ע"י') + ' ' + recon.reconstructedBy : '') +
          '</div>';
      }
      html += '<div class="history-pesticides" style="margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--border, #e0d8d0); font-size: 0.85rem; line-height: 1.7;">';
      html += pestSummary;
      html += '</div>';

      // Chain: which scouting observation this spray responded to.
      var linked = (window.SprayLink && event.linkedReportIds && event.linkedReportIds.length)
        ? window.SprayLink.reportsById(event.linkedReportIds) : [];
      if (linked.length) {
        html += '<div class="history-chain">';
        html += '<div class="chain-title">🔗 ' + t('בעקבות דוח סיור') + '</div>';
        linked.forEach(function(r) {
          var subj = [r.pest, r.disease].filter(Boolean).join(' / ');
          html += '<div class="chain-row">' + r.date + ' · ' + (subj || t('ללא ציון')) +
            (r.severity ? ' · ' + t('חומרה') + ' ' + r.severity : '') +
            (r.inspector ? ' · ' + r.inspector : '') + '</div>';
        });
        html += '</div>';
      } else if (event.linkedReportIds && event.linkedReportIds.length) {
        html += '<div class="history-chain"><div class="chain-row chain-missing">🔗 ' +
          event.linkedReportIds.length + ' ' + t('דוחות מקושרים — לא נטענו') + '</div></div>';
      }

      if (revCount) {
        var lastRev = event.revisions[revCount - 1];
        html += '<div class="history-revs">✏ ' + t('נערך') + ' ' + revCount + ' ' +
          (revCount === 1 ? t('פעם') : t('פעמים')) + ' · ' +
          t('אחרון') + ': ' + new Date(lastRev.at).toLocaleDateString('he-IL') +
          ' · ' + (lastRev.byName || lastRev.by || '') +
          (lastRev.reason ? ' — ' + lastRev.reason : '') + '</div>';
      }

      html += '</div>';
      } catch (rowErr) {
        // Render a stub rather than losing the whole log to one bad row.
        html += '<div class="history-item"><div class="history-orphan">\u26a0\ufe0f ' +
          t('\u05e8\u05e9\u05d5\u05de\u05d4 \u05e4\u05d2\u05d5\u05de\u05d4') + ' #' + (event && event.id) + '</div></div>';
        console.warn('spray row render failed', event && event.id, rowErr);
      }
    });

    container.innerHTML = html;
    try {
      document.dispatchEvent(new CustomEvent('shorashim:history-rendered',
        { detail: { shown: sorted.length, filteredOut: filteredOut } }));
    } catch (e) {}
  }

  function formatDate(dateStr) {
    var d = new Date(dateStr);
    return d.toLocaleDateString('he-IL', { year: 'numeric', month: 'long', day: 'numeric' });
  }

  document.getElementById('exportPdfBtn').addEventListener('click', function() {
    if (sprayEvents.filter(function(e) { return !e.voided; }).length === 0) {
      showToast('❌ ' + t('אין יומני ריסוס לייצוא'));
      return;
    }

    // Field reports load asynchronously. Exporting before they arrive would
    // produce a PDF missing its chain lines — an incomplete document is worse
    // than a delayed one. We refuse rather than await: exportReport opens a
    // window, and doing that after a promise resolves loses the user-gesture
    // context and gets blocked by popup blockers.
    var needsReports = sprayEvents.some(function(e) {
      return e.linkedReportIds && e.linkedReportIds.length;
    });
    if (needsReports && window.SprayLink && !window.SprayLink.isReady()) {
      showToast('⏳ ' + t('טוען דוחות סיור — נסה שוב בעוד רגע'));
      return;
    }

    // More than one farm in play means the design is ambiguous — ask.
    if (window.ReportTheme && typeof window.ReportTheme.chooseAndExport === 'function' &&
        (farms || []).length > 1) {
      window.ReportTheme.chooseAndExport();
      return;
    }
    var onlyFarm = (farms && farms.length === 1) ? farms[0].id : null;

    // Same reasoning as the field-report check above: the satellite image is
    // composited asynchronously and window.open() cannot survive an await.
    // isSettled, not isReady — an image that can never be built must not
    // make a farm permanently unexportable. Farms that did not ask for the
    // image are never held up at all.
    var _wantsMap = false;
    if (onlyFarm && window.ReportTheme && window.ReportTheme.resolve) {
      var _f = (farms || []).find(function (f) { return f.id === onlyFarm; });
      try { _wantsMap = !!window.ReportTheme.resolve(_f).satellite; } catch (e) { _wantsMap = false; }
    }
    if (_wantsMap && window.ReportMap && !window.ReportMap.isMainSettled(onlyFarm)) {
      window.ReportMap.prepareMain(onlyFarm);
      showToast('⏳ ' + t('מכין תצלום לווין — נסה שוב בעוד רגע'));
      return;
    }

    var html = generatePdfHtml(onlyFarm);
    var filename = t('יומן ריסוסים').replace(/ /g, '_') + '_' + new Date().toISOString().split('T')[0] + '.html';
    window.Util.exportReport(html, filename);
    showToast('📄 ' + t('הדו"ח נפתח — לחץ שמור כ-PDF'));
  });

  // farmId === null exports everything under the house design.
  function generatePdfHtml(farmId) {
    var scope = sprayEvents;
    var farmObj = null;
    if (farmId) {
      farmObj = (farms || []).find(function(f) { return f.id === farmId; }) || null;
      var farmPlotIds = (plots || []).filter(function(p) { return p.farm_id === farmId; })
        .map(function(p) { return p.id; });
      scope = sprayEvents.filter(function(e) {
        // Records written since the per-farm split declare their owner. Trust
        // that: a stamped record belongs to exactly one grower's log and must
        // not leak into another's on a plot coincidence.
        if (e.farmId) return e.farmId === farmId;
        // Legacy records predate the stamp — fall back to plot membership,
        // then drop any plot that is not this farm's from the printed row so
        // the document still names only this client's blocks.
        return (e.plotIds || []).some(function(id) { return farmPlotIds.indexOf(id) !== -1; });
      });
      // A record whose plots do not exist cannot honestly be attributed to
      // this grower, and printing it as "לא ידוע · 0.00 דונם" on their
      // document is worse than leaving it out. It stays visible in the app.
      scope = scope.filter(function(e) { return !isOrphanEvent(e); });

      // Belt and braces for pre-split history: narrow each legacy record to
      // the plots this farm actually owns before it reaches the page.
      scope = scope.map(function(e) {
        if (e.farmId) return e;
        var own = (e.plotIds || []).filter(function(id) { return farmPlotIds.indexOf(id) !== -1; });
        if (own.length === (e.plotIds || []).length) return e;
        var copy = JSON.parse(JSON.stringify(e));
        copy.plotIds = own;
        copy.farmScoped = true;
        return copy;
      });
    }

    var voidedEvents = scope.filter(function(e) { return e.voided; });
    var sorted = scope.filter(function(e) { return !e.voided; })
      .sort(function(a, b) {
        return new Date(b.date) - new Date(a.date);
      });

    // Theme controls letterhead only. It cannot alter or suppress the
    // reconstruction badges, evidence lines, revision notes or void
    // appendix — those are the document's disclosures, not its styling.
    var TH = (window.ReportTheme && window.ReportTheme.resolve)
      ? window.ReportTheme.resolve(farmObj) : {
        c1: '#1a5632', c2: '#2d6a4f', c3: '#40916c',
        headText: '#ffffff', accent: '#2d6a4f', radius: 20,
        orientation: 'landscape', title: '', sub: '', logo: '',
        footer: '', signature: false, satellite: false, mainPlot: null,
        // Opt-in, same as ReportTheme's default.
        brand: false
      };

    var html = '<!DOCTYPE html>\n<html lang="he" dir="rtl">\n<head>\n';
    html += '<meta charset="UTF-8">\n';
    html += '<meta name="viewport" content="width=device-width,initial-scale=1">\n';
    html += '<title>' + t('יומן ריסוסים') + '</title>\n';
    html += '<style>\n';
    html += '@page { margin: 15mm 10mm; size: A4 ' + TH.orientation + '; }\n';
    html += 'body { font-family: -apple-system, "Segoe UI", Arial, sans-serif; direction: rtl; padding: 0; margin: 0; color: #2b2520; line-height: 1.5; }\n';
    html += '.header { background: linear-gradient(135deg, ' + TH.c1 + ', ' + TH.c2 + ', ' + TH.c3 + '); color: ' + TH.headText + '; padding: 22px 28px; border-radius: 0 0 ' + TH.radius + 'px ' + TH.radius + 'px; margin-bottom: 18px; display:flex; align-items:center; gap:18px; }\n';
    html += '.header .logo { max-height: 58px; max-width: 130px; flex:0 0 auto; }\n';
    html += '.header .htext { flex:1; }\n';
    html += '.sigrow { margin: 22px 16px 0; display:flex; gap:40px; font-size:0.78rem; color:#5a5048; }\n';
    html += '.sigrow div { flex:1; border-top:1px solid #b8ada2; padding-top:5px; }\n';
    html += '.farm-footer { margin: 14px 16px 0; font-size:0.72rem; color:#8a8078; white-space:pre-line; }\n';
    html += '.header h1 { font-size: 1.5rem; font-weight: 800; margin: 0 0 4px 0; letter-spacing: -0.02em; }\n';
    html += '.header .sub { font-size: 0.85rem; opacity: 0.9; }\n';
    html += '.meta-row { padding: 0 24px 8px; font-size: 0.78rem; color: #8a8078; }\n';
    html += 'table { width: calc(100% - 32px); margin: 0 16px 20px; border-collapse: separate; border-spacing: 0; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 12px rgba(43,37,32,0.07); }\n';
    html += 'th { background: ' + TH.accent + '; color: white; padding: 10px 10px; text-align: right; font-size: 0.78rem; font-weight: 700; letter-spacing: 0.02em; }\n';
    html += 'td { padding: 11px 10px; border-bottom: 1px solid #f0ebe6; font-size: 0.85rem; vertical-align: top; }\n';
    html += 'tr.row-reconstructed td { background: #fdf6e8; }\n';
    html += '.recon-tag { display:inline-block; margin-top:4px; padding:2px 7px; border-radius:5px; background:#b45309; color:#fff; font-size:0.66rem; font-weight:700; }\n';
    html += '.recon-basis { margin-top:6px; padding-top:5px; border-top:1px dotted #d8c9a8; font-size:0.7rem; color:#7a6a4a; }\n';
    html += '.chain-cell { margin-top:6px; padding:5px 8px; border-inline-start:2px solid #2d6a4f; background:#f2f7f4; font-size:0.7rem; color:#3d5a4a; border-radius:4px; }\n';
    html += '.revs-cell { margin-top:5px; font-size:0.68rem; color:#8a7f70; font-style:italic; }\n';
    html += '.void-appendix { margin:0 16px 16px; padding:10px 14px; border-inline-start:3px solid #9a3412; background:#fdf1ec; font-size:0.72rem; color:#7a4a3a; border-radius:6px; }\n';
    html += '.void-appendix ul { margin:6px 0 0; padding-inline-start:18px; }\n';
    html += '.void-appendix li { margin:3px 0; }\n';
    html += '.recon-legend { margin:0 16px 14px; padding:9px 12px; border-inline-start:3px solid #b45309; background:#fdf6e8; font-size:0.72rem; color:#7a6a4a; border-radius:6px; }\n';
    html += 'tr:last-child td { border-bottom: none; }\n';
    html += 'tr:nth-child(even) td { background: #faf8f5; }\n';
    html += '.event-date { font-weight: 800; font-size: 0.95rem; color: #1a5632; white-space: nowrap; }\n';
    html += '.pest-list { display: flex; flex-direction: column; gap: 4px; }\n';
    html += '.pest-item { background: #e8f5e9; border-right: 3px solid #2d6a4f; padding: 4px 8px; border-radius: 4px; font-size: 0.82rem; }\n';
    html += '.pest-name { font-weight: 700; color: #1a5632; }\n';
    html += '.pest-meta { color: #5a7060; font-size: 0.76rem; }\n';
    html += '.footer { text-align: center; padding: 18px; margin-top: 16px; font-size: 0.78rem; color: #8a8078; border-top: 1px solid #f0ebe6; }\n';
    html += '.footer .brand { color: #2d6a4f; font-weight: 700; }\n';
    // break-inside keeps the image and its caption on one printed page — a
    // plot map split across a page break is useless.
    // Corner thumbnail, not a poster: 74mm on a 297mm-wide page is roughly
    // 7% of the sheet, and sitting inside the header band it costs the log
    // no vertical space at all.
    html += '.header .mapcard { flex: 0 0 auto; width: 74mm; max-width: 30%; order: -1; }\n';
    html += '.header .mapcard img { width: 100%; height: auto; display: block; border-radius: 6px; border: 1px solid rgba(255,255,255,0.5); }\n';
    html += '.header .mapcard .mapcap { font-size: 0.6rem; opacity: 0.85; padding: 3px 1px 0; text-align: center; }\n';
    // The band grew a corner image, so it no longer needs poster padding.
    html += '.header:has(.mapcard) { padding: 12px 20px; align-items: flex-start; }\n';
    html += '.header:has(.mapcard) .htext { align-self: center; }\n';
    html += '@media print { .header .mapcard { width: 68mm; } .header .mapcard img { border-radius: 4px; } }\n';
    html += '</style>\n';
    html += '</head>\n<body>\n';
    html += '<div class="header">\n';
    if (TH.logo) html += '<img class="logo" src="' + TH.logo + '" alt="">\n';
    html += '<div class="htext">';
    // A grower exporting a log for their own client should not have to send
    // out our brand. TH.brand off = a plain title and no footer credit.
    html += '<h1>' + (TH.title || (TH.brand
      ? ('🌿 ' + t('יומן ריסוסים - שורשים פלוס'))
      : t('יומן ריסוסים'))) + '</h1>\n';
    html += '<div class="sub">' +
      (farmObj ? locName(farmObj) + ' · ' : '') +
      t('תאריך הפקה:') + ' ' + formatDate(new Date().toISOString().split('T')[0]) +
      (TH.sub ? ' · ' + TH.sub : '') + '</div>\n';
    html += '</div>';

    // Satellite thumbnail of the מטע's main plot, so a client can see
    // *where* was sprayed and not only which name was typed. Opt-in per farm
    // (ReportTheme → הוסף תצלום לווין) and only on the exported
    // document. It lives in the header's left corner — order:-1 puts it at
    // the visual left of an RTL flex row — so it costs the log no vertical
    // space. Read from cache only; see report-map.js on why this cannot await.
    var mapUrl = (TH.satellite && window.ReportMap && window.ReportMap.getCachedMain)
      ? window.ReportMap.getCachedMain(farmId || null) : null;
    if (mapUrl) {
      var _mainPlot = (window.ReportMap && window.ReportMap.mainPlotOf && farmId)
        ? window.ReportMap.mainPlotOf(farmId) : null;
      html += '<div class="mapcard">';
      html += '<img src="' + mapUrl + '" alt="' + t('תצלום לווין') + '">';
      // Attribution is baked into the image itself so it survives being
      // copied out of the PDF — no need to print it twice. The farm name is
      // already in the header beside it, so the caption names the plot only.
      html += '<div class="mapcap">🛰 ' + t('תצלום לווין') +
        (_mainPlot ? ' · ' + _mainPlot.name : '') + '</div>';
      html += '</div>';
    }
    html += '</div>\n';

    html += '<table>\n';
    html += '<thead><tr>' +
            '<th style="width:11%;">' + t('תאריך') + '</th>' +
            '<th style="width:11%;">' + t('מפעיל') + '</th>' +
            '<th style="width:22%;">' + t('חלקות') + '</th>' +
            '<th style="width:7%;">' + t('שטח') + '</th>' +
            '<th style="width:8%;">' + t('נפח/עץ') + '</th>' +
            '<th style="width:8%;">' + t('מרסס') + '</th>' +
            '<th style="width:33%;">' + t('חומרים') + '</th>' +
            '</tr></thead>\n';
    html += '<tbody>\n';

    sorted.forEach(function(event) {
      var plotNames = event.plotIds.map(function(id) {
        var p = plots.find(function(plot) { return plot.id === id; });
        return p ? p.name : t('לא ידוע');
      }).join(', ');

      var totalArea = (event.plotIds || []).reduce(function(sum, id) {
        var p = plots.find(function(plot) { return plot.id === id; });
        return sum + (p ? p.area : 0);
      }, 0);

      // Combine all pesticides for this event into ONE cell (one row per event).
      var pestCell = '<div class="pest-list">';
      (event.applications || []).forEach(function(app) {
        pestCell += '<div class="pest-item">' +
          '<span class="pest-name">🧪 ' + (app.productName || '') + '</span>' +
          (app.activeIngredient ? ' <span class="pest-meta">(' + app.activeIngredient + ')</span>' : '') +
          ' · <span class="pest-meta">' + (app.concentration != null ? app.concentration + '%' : '') + '</span>' +
          (app.target ? ' · <span class="pest-meta">' + t('מטרה') + ': ' + app.target + '</span>' : '') +
          '</div>';
      });
      pestCell += '</div>';

      var rr = event.reconstruction && event.reconstruction.reconstructed ? event.reconstruction : null;
      var pdfRecon = '';
      var pdfBasis = '';
      if (rr) {
        pdfRecon = '<div class="recon-tag">' + t('שחזור רטרואקטיבי') + '</div>';
        var cf = rr.confidence === 'high' ? t('גבוהה') : rr.confidence === 'medium' ? t('בינונית') : t('נמוכה');
        pdfBasis = '<div class="recon-basis">' +
          t('על סמך') + ': ' + (rr.evidenceBasis || '') +
          (rr.sourceRefs ? ' · ' + rr.sourceRefs : '') +
          ' · ' + t('ודאות') + ': ' + cf +
          (rr.reconstructedBy ? ' · ' + t('שוחזר ע"י') + ' ' + rr.reconstructedBy : '') +
          (rr.reconstructedAt ? ' · ' + new Date(rr.reconstructedAt).toLocaleDateString('he-IL') : '') +
          '</div>';
      }

      var pdfChain = '';
      var chainRefs = (window.SprayLink && event.linkedReportIds && event.linkedReportIds.length)
        ? window.SprayLink.reportsById(event.linkedReportIds) : [];
      if (chainRefs.length) {
        pdfChain = '<div class="chain-cell"><strong>' + t('בעקבות דוח סיור') + ':</strong> ' +
          chainRefs.map(function(r) {
            var subj = [r.pest, r.disease].filter(Boolean).join(' / ');
            return r.date + (subj ? ' — ' + subj : '') +
                   (r.severity ? ' (' + t('חומרה') + ' ' + r.severity + ')' : '');
          }).join('; ') + '</div>';
      }

      var pdfRevs = '';
      if (event.revisions && event.revisions.length) {
        var lastR = event.revisions[event.revisions.length - 1];
        pdfRevs = '<div class="revs-cell">✏ ' + t('נערך') + ' ' + event.revisions.length + ' ' +
          (event.revisions.length === 1 ? t('פעם') : t('פעמים')) + ' · ' + t('אחרון') + ': ' +
          new Date(lastR.at).toLocaleDateString('he-IL') +
          (lastR.byName ? ' · ' + lastR.byName : '') +
          (lastR.reason ? ' — ' + lastR.reason : '') + '</div>';
      }

      html += '<tr' + (rr ? ' class="row-reconstructed"' : '') + '>' +
        '<td class="event-date">' + formatDate(event.date) + pdfRecon + '</td>' +
        '<td>' + (event.operator || '') +
          (isOrphanEvent(event)
            ? '<div class="pest-meta">⚠ ' + t('ללא חלקה מזוהה') + '</div>' : '') + '</td>' +
        '<td>' + plotNames + '</td>' +
        '<td>' + totalArea.toFixed(2) + ' ' + t('דונם') + '</td>' +
        '<td>' + event.volumePerTree + ' ' + t(unitShort(event.volumeUnit)) +
          (event.viaIrrigation ? '<div class="pest-meta">דרך מערכת ההשקיה</div>' : '') + '</td>' +
        '<td>' + event.sprayerCapacity + ' ' + t('ליטר') + '</td>' +
        '<td>' + pestCell +
          ((event.purpose && event.purpose !== 'pest')
            ? '<div class="pest-meta">🎯 ' + purposeLabel(event.purpose) + '</div>' : '') +
          ((event.gear && event.gear.length)
            ? '<div class="pest-meta">🔧 ' + event.gear.join(', ') + '</div>' : '') +
          pdfChain + pdfBasis + pdfRevs + '</td>' +
      '</tr>\n';
    });

    html += '</tbody>\n</table>\n';
    if (voidedEvents.length) {
      html += '<div class="void-appendix"><strong>' + t('רשומות שבוטלו') + '</strong> — ' +
        t('אינן חלק מיומן הריסוסים הפעיל ומופיעות כאן לשקיפות בלבד') + ':<ul>';
      voidedEvents.sort(function(a, b) { return new Date(b.date) - new Date(a.date); })
        .forEach(function(e) {
          html += '<li>' + formatDate(e.date) + ' · ' + (e.operator || '') + ' · ' +
            (e.applications || []).map(function(a) { return a.productName || ''; }).join(', ') +
            ' — ' + t('בוטל') + ' ' + new Date(e.voided.at).toLocaleDateString('he-IL') +
            (e.voided.byName ? ' · ' + e.voided.byName : '') +
            (e.voided.reason ? ' — ' + e.voided.reason : '') + '</li>';
        });
      html += '</ul></div>\n';
    }
    if (sorted.some(function(e) { return e.reconstruction && e.reconstruction.reconstructed; })) {
      html += '<div class="recon-legend">' +
        t('שורות המסומנות "שחזור רטרואקטיבי" נבנו לאחר מעשה מתוך אסמכתאות ועדויות, ואינן רישום שנערך במועד הריסוס. מקור השחזור ורמת הוודאות מצוינים בכל שורה.') +
        '</div>\n';
    }
    if (TH.footer) html += '<div class="farm-footer">' + TH.footer + '</div>\n';
    if (TH.signature) {
      html += '<div class="sigrow">' +
        '<div>' + t('שם האחראי') + '</div>' +
        '<div>' + t('חתימה') + '</div>' +
        '<div>' + t('תאריך') + '</div>' +
        '</div>\n';
    }
    html += '<div class="footer">' +
      (TH.brand ? '<span class="brand">🌿 ' + t('שורשים פלוס') + '</span> · ' : '') +
      t('יומן ריסוסים') + ' · ' + new Date().getFullYear() + '</div>\n';
    html += '</body>\n</html>';

    return html;
  }

  // ── Admin ──
  // Pesticide list filtering + selection state (חומרים tab).
  var pestFilterText = '';
  var pestFilterCrop = '';
  var pestSelectedIds = {};   // id → true

  function pestCropOf(p) {
    return (p.crop || p.commonTargets || '').trim();
  }

  function getFilteredPesticides() {
    var q = pestFilterText.trim().toLowerCase();
    return pesticides.filter(function(p) {
      if (pestFilterCrop && pestCropOf(p) !== pestFilterCrop) return false;
      if (!q) return true;
      var hay = [p.productName, p.activeIngredient, p.crop, p.commonTargets, p.pest, p.regNumber]
        .filter(Boolean).join(' ').toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  function renderPesticideAdminList() {
    var container = document.getElementById('pesticideAdminList');

    // Crop dropdown: distinct crop values, selection preserved.
    var cropSel = document.getElementById('pestFilterCrop');
    if (cropSel) {
      var crops = {};
      pesticides.forEach(function(p) { var c = pestCropOf(p); if (c) crops[c] = true; });
      var opts = '<option value="">' + t('כל הגידולים') + '</option>';
      Object.keys(crops).sort().forEach(function(c) {
        opts += '<option value="' + c.replace(/"/g, '&quot;') + '"' + (c === pestFilterCrop ? ' selected' : '') + '>' + c + '</option>';
      });
      cropSel.innerHTML = opts;
    }

    if (pesticides.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 16px;"><p>' + t('אין חומרי הדברה') + '</p></div>';
      var cnt0 = document.getElementById('pestFilterCount');
      if (cnt0) cnt0.textContent = '';
      return;
    }

    var filtered = getFilteredPesticides();
    var cnt = document.getElementById('pestFilterCount');
    if (cnt) cnt.textContent = filtered.length + ' / ' + pesticides.length;

    if (filtered.length === 0) {
      container.innerHTML = '<div class="empty-state" style="padding: 16px;"><p>' + t('אין תוצאות לסינון הנוכחי') + '</p></div>';
      return;
    }

    var html = '';
    filtered.forEach(function(pest) {
      var extra = [];
      if (pest.pest) extra.push(pest.pest);
      if (pest.phi) extra.push('PHI: ' + pest.phi);
      html += '<div class="pesticide-admin-item">';
      html += '<label class="pest-check"><input type="checkbox" data-select-id="' + pest.id + '"' + (pestSelectedIds[pest.id] ? ' checked' : '') + '></label>';
      html += '<div class="pesticide-admin-info">';
      html += '<div class="pesticide-admin-name">' + pest.productName + '</div>';
      html += '<div class="pesticide-admin-details">' + pest.activeIngredient + ' • ' + pest.defaultConcentration + '% • ' + pest.commonTargets + (extra.length ? ' • ' + extra.join(' • ') : '') + '</div>';
      html += '</div>';
      html += '<div class="pesticide-admin-actions">';
      html += '<button class="btn-icon edit" data-edit-id="' + pest.id + '">✏️</button>';
      html += '<button class="btn-icon delete" data-delete-id="' + pest.id + '">🗑️</button>';
      html += '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('input[data-select-id]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var id = parseInt(this.getAttribute('data-select-id'));
        if (this.checked) pestSelectedIds[id] = true;
        else delete pestSelectedIds[id];
        var sa = document.getElementById('pestSelectAll');
        if (sa && !this.checked) sa.checked = false;
      });
    });

    container.querySelectorAll('.btn-icon.edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = parseInt(this.getAttribute('data-edit-id'));
        showPesticideModal(id);
      });
    });

    container.querySelectorAll('.btn-icon.delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = parseInt(this.getAttribute('data-delete-id'));
        var pest = pesticides.find(function(p) { return p.id === id; });
        if (confirm(t('למחוק את') + ' ' + pest.productName + '?')) {
          pesticides = pesticides.filter(function(p) { return p.id !== id; });
          saveData();
          renderPesticideAdminList();
          showToast('🗑️ ' + t('חומר נמחק'));
        }
      });
    });
  }

  document.getElementById('addPesticideBtn').addEventListener('click', function() {
    showPesticideModal(null);
  });

  // ── Pesticide filter + export wiring ──
  (function() {
    var txt = document.getElementById('pestFilterText');
    if (txt) txt.addEventListener('input', function() {
      pestFilterText = this.value;
      renderPesticideAdminList();
    });
    var sel = document.getElementById('pestFilterCrop');
    if (sel) sel.addEventListener('change', function() {
      pestFilterCrop = this.value;
      renderPesticideAdminList();
    });
    var sa = document.getElementById('pestSelectAll');
    if (sa) sa.addEventListener('change', function() {
      var on = this.checked;
      getFilteredPesticides().forEach(function(p) {
        if (on) pestSelectedIds[p.id] = true;
        else delete pestSelectedIds[p.id];
      });
      renderPesticideAdminList();
    });
    var csvBtn = document.getElementById('exportPestCsvBtn');
    if (csvBtn) csvBtn.addEventListener('click', function() { exportPesticides('csv'); });
    var shBtn = document.getElementById('exportPestSheetsBtn');
    if (shBtn) shBtn.addEventListener('click', function() { exportPesticides('sheets'); });
  })();

  // Rows for export: the checked pesticides if any are checked, otherwise
  // everything matching the current filter.
  function pesticidesForExport() {
    var selected = pesticides.filter(function(p) { return pestSelectedIds[p.id]; });
    return selected.length > 0 ? selected : getFilteredPesticides();
  }

  function buildPesticideRows(list) {
    var header = [
      t('שם מסחרי'), t('חומר פעיל'), t('ריכוז ברירת מחדל (%)'), t('גידול'),
      t('מזיקים/מטרות'), 'PHI', t('מינון'), t('רעילות'), t('מס\u05f3 רישום'), t('מקור')
    ];
    var rows = list.map(function(p) {
      return [
        p.productName || '', p.activeIngredient || '',
        (p.defaultConcentration !== undefined && p.defaultConcentration !== null) ? String(p.defaultConcentration) : '',
        pestCropOf(p), p.pest || p.commonTargets || '', p.phi || '',
        p.dosage || '', p.toxicity || '', p.regNumber || '', p.source || t('ידני')
      ];
    });
    return [header].concat(rows);
  }

  function exportPesticides(mode) {
    var list = pesticidesForExport();
    if (list.length === 0) {
      showToast('❌ ' + t('אין חומרים ליצוא'));
      return;
    }
    var rows = buildPesticideRows(list);

    if (mode === 'csv') {
      // \uFEFF BOM so Excel opens Hebrew UTF-8 correctly.
      var csv = '\uFEFF' + rows.map(function(r) {
        return r.map(function(cell) {
          cell = String(cell);
          return /[",\n\r]/.test(cell) ? '"' + cell.replace(/"/g, '""') + '"' : cell;
        }).join(',');
      }).join('\r\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'pesticides-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { document.body.removeChild(a); URL.revokeObjectURL(a.href); }, 100);
      showToast('📄 ' + list.length + ' ' + t('חומרים יוצאו ל-CSV'));
      return;
    }

    // Google Sheets: copy as TSV (pastes into a sheet as real cells),
    // then open a blank sheet. No OAuth / API needed.
    var tsv = rows.map(function(r) {
      return r.map(function(cell) { return String(cell).replace(/[\t\r\n]+/g, ' '); }).join('\t');
    }).join('\n');

    function afterCopy(ok) {
      if (ok) {
        window.open('https://sheets.new', '_blank');
        showToast('📊 ' + list.length + ' ' + t('חומרים הועתקו — הדבק בגיליון (Ctrl+V)'));
      } else {
        showToast('❌ ' + t('העתקה נכשלה — נסה יצוא CSV'));
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(tsv).then(function() { afterCopy(true); }, function() { afterCopy(fallbackCopy(tsv)); });
    } else {
      afterCopy(fallbackCopy(tsv));
    }
    function fallbackCopy(text) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      return ok;
    }
  }

  function showPesticideModal(editId) {
    var isEdit = editId !== null;
    var pest = isEdit ? pesticides.find(function(p) { return p.id === editId; }) : null;

    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" id="modalOverlay">' +
        '<div class="modal">' +
          '<h2>' + (isEdit ? '✏️ ' + t('עריכת חומר') : '➕ ' + t('הוספת חומר')) + '</h2>' +
          '<p>' + t('מלא את פרטי חומר ההדברה') + '</p>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('שם מסחרי') + '</label>' +
            '<input type="text" class="form-input" id="pestProductName" value="' + (isEdit ? pest.productName : '') + '" placeholder="' + t('לדוגמה:') + ' ורטימק">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('חומר פעיל') + '</label>' +
            '<input type="text" class="form-input" id="pestActiveIngredient" value="' + (isEdit ? pest.activeIngredient : '') + '" placeholder="Abamectin">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('ריכוז ברירת מחדל (%)') + '</label>' +
            '<input type="number" class="form-input" id="pestDefaultConc" value="' + (isEdit ? pest.defaultConcentration : '') + '" step="0.001" min="0" placeholder="0.015">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('מטרות נפוצות') + '</label>' +
            '<input type="text" class="form-input" id="pestTargets" value="' + (isEdit ? pest.commonTargets : '') + '" placeholder="Scale, Mealybug">' +
          '</div>' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" id="modalSavePest">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" id="modalCancelPest">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    function save() {
      var productName = document.getElementById('pestProductName').value.trim();
      var activeIngredient = document.getElementById('pestActiveIngredient').value.trim();
      var defaultConcentration = parseFloat(document.getElementById('pestDefaultConc').value) || 0;
      var commonTargets = document.getElementById('pestTargets').value.trim();

      if (!productName || !activeIngredient) {
        showToast('❌ ' + t('חובה למלא שם מסחרי וחומר פעיל'));
        return;
      }

      if (isEdit) {
        pest.productName = productName;
        pest.activeIngredient = activeIngredient;
        pest.defaultConcentration = defaultConcentration;
        pest.commonTargets = commonTargets;
        showToast('✅ ' + t('חומר עודכן'));
      } else {
        var newId = pesticides.length > 0 ? Math.max.apply(null, pesticides.map(function(p) { return p.id; })) + 1 : 1;
        pesticides.push({
          id: newId,
          productName: productName,
          activeIngredient: activeIngredient,
          defaultConcentration: defaultConcentration,
          unit: '%',
          commonTargets: commonTargets
        });
        showToast('✅ ' + t('חומר נוסף'));
      }

      saveData();
      renderPesticideAdminList();
      container.innerHTML = '';
    }

    function cancel() {
      container.innerHTML = '';
    }

    document.getElementById('modalSavePest').addEventListener('click', save);
    document.getElementById('modalCancelPest').addEventListener('click', cancel);
    document.getElementById('modalOverlay').addEventListener('click', function(e) { if (e.target === this) cancel(); });
  }

  // ── Farm Management ──
  function renderFarmsAdminList() {
    var container = document.getElementById('farmsAdminList');
    
    if (farms.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted);">' + t('אין מטעים זמינים') + '</div>';
      return;
    }

    var html = '';
    farms.forEach(function(farm) {
      var farmPlots = plots.filter(function(p) { return p.farm_id === farm.id; });
      var totalArea = farmPlots.reduce(function(sum, p) { return sum + p.area; }, 0);
      
      var usersData = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
      var usersWithAccess = Object.values(usersData).filter(function(u) {
        return u.role === 'admin' || u.farm_permissions.length === 0 || u.farm_permissions.indexOf(farm.id) !== -1;
      });
      
      html += '<div class="pesticide-admin-item" style="border-right: 4px solid ' + farm.color + '; cursor: pointer;" data-farm-detail-id="' + farm.id + '">';
      html += '<div class="pesticide-admin-info">';
      html += '<div class="pesticide-admin-name">' + locName(farm) + '</div>';
      html += '<div class="pesticide-admin-details">' + farmPlots.length + ' ' + t('חלקות') + ' • ' + formatArea(totalArea) + ' • ' + usersWithAccess.length + ' ' + t('עובדים') + '</div>';
      html += '<div style="font-size: 0.7rem; color: var(--g3); margin-top: 3px;">' + t('לחץ לפרטי מטע') + ' →</div>';
      html += '</div>';
      html += '<div class="pesticide-admin-actions" style="display: flex; flex-direction: column; gap: 4px;">';
      html += '<button class="btn-icon edit" data-edit-farm-id="' + farm.id + '">✏️</button>';
      html += '<button class="btn-icon delete" data-delete-farm-id="' + farm.id + '">🗑️</button>';
      html += '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    // Click on farm card → open details
    container.querySelectorAll('[data-farm-detail-id]').forEach(function(card) {
      card.addEventListener('click', function(e) {
        // Don't open details if clicking edit/delete buttons
        if (e.target.closest('.btn-icon')) return;
        var id = parseInt(this.getAttribute('data-farm-detail-id'));
        showFarmDetails(id);
      });
    });

    container.querySelectorAll('.btn-icon.edit').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = parseInt(this.getAttribute('data-edit-farm-id'));
        showFarmModal(id);
      });
    });

    container.querySelectorAll('.btn-icon.delete').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = parseInt(this.getAttribute('data-delete-farm-id'));
        var farm = farms.find(function(f) { return f.id === id; });
        var farmPlots = plots.filter(function(p) { return p.farm_id === id; });
        
        if (farmPlots.length > 0) {
          showToast('❌ ' + t('לא ניתן למחוק') + ' - ' + farmPlots.length + ' ' + t('חלקות') + ' ' + t('במטע זה'));
          return;
        }
        
        if (confirm(t('למחוק את מטע') + ' ' + locName(farm) + '?')) {
          farms = farms.filter(function(f) { return f.id !== id; });
          saveData();
          renderFarmsAdminList();
          showToast('🗑️ ' + t('מטע נמחק'));
        }
      });
    });
  }

  // Use event delegation for add farm button
  document.addEventListener('click', function(e) {
    if (e.target && e.target.id === 'addFarmBtn') {
      showFarmModal(null);
    }
    if (e.target && e.target.id === 'addUserBtn') {
      showUserModal(null);
    }
  });

  function showFarmModal(editId) {
    var isEdit = editId !== null;
    var farm = isEdit ? farms.find(function(f) { return f.id === editId; }) : null;

    var container = document.getElementById('modalContainer');
    var colorOptions = FARM_COLORS.map(function(color, idx) {
      var selected = (isEdit && farm.color === color) || (!isEdit && idx === 0);
      return '<div class="color-option' + (selected ? ' selected' : '') + '" data-color="' + color + '" style="background: ' + color + '"></div>';
    }).join('');

    var html =
      '<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this) window.cancelFarmModal()">' +
        '<div class="modal">' +
          '<h2>' + (isEdit ? '✏️ ' + t('עריכת מטע') : '➕ ' + t('מטע חדש')) + '</h2>' +
          '<p>' + t('מלא את פרטי המטע') + '</p>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('שם המטע') + '</label>' +
            '<input type="text" class="form-input" id="farmName" value="' + (isEdit ? (farm.name || '') : '') + '" placeholder="Paran">' +
          '</div>' +
          '<details class="form-group" style="margin-top:-4px;">' +
            '<summary style="cursor:pointer;font-size:0.82rem;color:var(--text-muted,#666);padding:6px 0;">🌐 ' + t('תרגומים (אופציונלי)') + '</summary>' +
            '<div class="form-group" style="margin-top:8px;">' +
              '<label class="form-label" style="font-size:0.78rem;">' + t('שם בתאית') + '</label>' +
              '<input type="text" class="form-input" id="farmNameTh" value="' + (isEdit ? (farm.name_th || '') : '') + '" placeholder="" dir="ltr">' +
            '</div>' +
            '<div class="form-group">' +
              '<label class="form-label" style="font-size:0.78rem;">' + t('שם בערבית') + '</label>' +
              '<input type="text" class="form-input" id="farmNameAr" value="' + (isEdit ? (farm.name_ar || '') : '') + '" placeholder="" dir="rtl">' +
            '</div>' +
          '</details>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('צבע המטע (כל החלקות יהיו בצבע זה)') + '</label>' +
            '<div class="color-picker">' + colorOptions + '</div>' +
          '</div>' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" onclick="window.saveFarmModal()">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" onclick="window.cancelFarmModal()">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    container.innerHTML = html;

    // Create global save/cancel functions with closure
    window.saveFarmModal = function() {
      var name = document.getElementById('farmName').value.trim();
      var nameTh = (document.getElementById('farmNameTh') || { value: '' }).value.trim();
      var nameAr = (document.getElementById('farmNameAr') || { value: '' }).value.trim();
      var selectedColor = container.querySelector('.color-option.selected');
      var color = selectedColor ? selectedColor.getAttribute('data-color') : FARM_COLORS[0];

      if (!name) {
        showToast('❌ ' + t('חובה למלא שם מטע'));
        return;
      }

      // Check for duplicate names
      var existingFarm = farms.find(function(f) { 
        return f.name.toLowerCase() === name.toLowerCase() && (!isEdit || f.id !== farm.id);
      });
      if (existingFarm) {
        showToast('❌ ' + t('שם מטע כבר קיים'));
        return;
      }

      if (isEdit) {
        farm.name = name;
        farm.name_th = nameTh || null;
        farm.name_ar = nameAr || null;
        farm.color = color;
        saveData();
        renderFarmsAdminList();
        showToast('✅ ' + t('מטע עודכן'));
      } else {
        var session = JSON.parse(sessionStorage.getItem('currentUser'));
        if (!session) {
          showToast('❌ ' + t('שגיאה') + ': ' + t('לא מחובר'));
          return;
        }
        var newId = farms.length > 0 ? Math.max.apply(null, farms.map(function(f) { return f.id; })) + 1 : 1;
        farms.push({
          id: newId,
          name: name,
          name_th: nameTh || null,
          name_ar: nameAr || null,
          color: color,
          created_by: session.id,
          created_at: Date.now()
        });
        saveData();
        renderFarmsAdminList();
        showToast('✅ ' + t('מטע נוסף'));
      }

      // Close modal - get container fresh to ensure it closes
      var modalContainer = document.getElementById('modalContainer');
      if (modalContainer) {
        modalContainer.innerHTML = '';
      }
    };

    window.cancelFarmModal = function() {
      var modalContainer = document.getElementById('modalContainer');
      if (modalContainer) {
        modalContainer.innerHTML = '';
      }
    };

    // Add color picker styles if needed
    if (!document.getElementById('colorPickerStyles')) {
      var style = document.createElement('style');
      style.id = 'colorPickerStyles';
      style.textContent = '.color-picker { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }' +
        '.color-option { width: 40px; height: 40px; border-radius: 8px; cursor: pointer; border: 3px solid transparent; transition: all 0.2s; }' +
        '.color-option:hover { transform: scale(1.1); }' +
        '.color-option.selected { border-color: var(--dark); box-shadow: 0 0 0 2px white, 0 0 0 4px var(--dark); }';
      document.head.appendChild(style);
    }

    // Setup color selection
    container.querySelectorAll('.color-option').forEach(function(opt) {
      opt.addEventListener('click', function() {
        container.querySelectorAll('.color-option').forEach(function(o) { o.classList.remove('selected'); });
        this.classList.add('selected');
      });
    });
  }

  // Make farm modal globally accessible for inline onclick
  window.showFarmModalGlobal = function() {
    showFarmModal(null);
  };

  // ── User Management ──
  // Role filter for the users list: 'all' | 'admin' | 'operator' | 'worker' | 'viewer'
  var usersRoleFilter = 'all';
  window.__setUsersRoleFilter = function(role) {
    usersRoleFilter = role || 'all';
    renderUsersAdminList();
  };
  function renderUsersAdminList() {
    var container = document.getElementById('usersAdminList');
    var summaryContainer = document.getElementById('usersSummary');
    
    // Always refresh from localStorage to get latest data
    var usersData = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
    users = usersData;
    
    var userList = Object.keys(users).map(function(username) { return users[username]; });
    
    if (userList.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted);">' + t('אין רשומות') + '</div>';
      summaryContainer.innerHTML = '';
      return;
    }

    // Calculate statistics
    var adminCount = userList.filter(function(u) { return u.role === 'admin'; }).length;
    var operatorCount = userList.filter(function(u) { return u.role === 'operator'; }).length;
    var workerCount = userList.filter(function(u) { return u.role === 'worker'; }).length;
    var viewerCount = userList.filter(function(u) { return u.role === 'viewer'; }).length;
    
    // Render summary — each card doubles as a role filter (click to filter the list)
    function statCard(role, label, count) {
      var active = usersRoleFilter === role;
      return '<div onclick="window.__setUsersRoleFilter(\'' + role + '\')" style="cursor: pointer; padding: 6px 12px; border-radius: 10px; border: 2px solid ' + (active ? 'var(--primary)' : 'transparent') + '; background: ' + (active ? 'var(--primary-light)' : 'transparent') + ';" title="' + t('סנן לפי תפקיד') + '">' +
        '<div style="font-size: 12px; color: var(--text-muted); margin-bottom: 4px;">' + label + '</div>' +
        '<div style="font-size: 24px; font-weight: 700;' + (role === 'all' ? ' color: var(--primary);' : '') + '">' + count + '</div></div>';
    }
    summaryContainer.innerHTML =
      '<div style="display: flex; gap: 12px; flex-wrap: wrap;">' +
        statCard('all', t('סה"כ משתמשים'), userList.length) +
        statCard('admin', t('מנהלים'), adminCount) +
        statCard('operator', t('מפעילים'), operatorCount) +
        statCard('worker', t('עובדים'), workerCount) +
        statCard('viewer', t('צופים'), viewerCount) +
      '</div>';

    // Apply the role filter to the rendered list (counters above stay global)
    if (usersRoleFilter !== 'all') {
      userList = userList.filter(function(u) { return u.role === usersRoleFilter; });
    }
    if (userList.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted);">' + t('אין רשומות') + '</div>';
      return;
    }

    var html = '';
    userList.forEach(function(user) {
      var roleText = user.role === 'admin' ? t('מנהל') : user.role === 'operator' ? t('מפעיל') : user.role === 'worker' ? t('עובד') : t('צופה');
      
      // Build farm badges with colors
      var farmBadges = '';
      if (user.role === 'admin' || user.farm_permissions.length === 0) {
        farmBadges = '<span style="display: inline-block; padding: 4px 8px; background: var(--g6); border-radius: 6px; font-size: 12px; color: var(--text-muted);">' + t('כל המטעים') + '</span>';
      } else {
        user.farm_permissions.forEach(function(fid) {
          var f = farms.find(function(farm) { return farm.id === fid; });
          if (f) {
            farmBadges += '<span style="display: inline-block; padding: 4px 8px; margin: 2px; background: ' + f.color + '; color: white; border-radius: 6px; font-size: 12px; font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,0.2);">' + locName(f) + '</span>';
          }
        });
      }
      
      // Primary plot badge
      var primaryBadge = '';
      if (user.primary_plot_id) {
        var pp = plots.find(function(p) { return p.id === user.primary_plot_id; });
        if (pp) {
          primaryBadge = '<div style="margin-top: 6px;"><span style="display: inline-block; padding: 3px 8px; background: var(--accent-light); color: var(--accent); border-radius: 6px; font-size: 11px; font-weight: 600;">📍 ' + locName(pp) + '</span></div>';
        }
      }
      
      html += '<div class="pesticide-admin-item">';
      html += '<div class="pesticide-admin-info">';
      html += '<div class="pesticide-admin-name">' + user.name + ' <span style="color: var(--text-muted); font-weight: 400;">(' + user.username + ')</span></div>';
      html += '<div style="margin-top: 4px;"><span style="display: inline-block; padding: 3px 8px; background: var(--primary-light); color: var(--primary); border-radius: 4px; font-size: 11px; font-weight: 600; margin-left: 6px;">' + roleText + '</span></div>';
      html += '<div style="margin-top: 8px;">' + farmBadges + '</div>';
      html += primaryBadge;
      html += '</div>';
      html += '<div class="pesticide-admin-actions">';
      html += '<button class="btn-icon edit" data-edit-user-id="' + user.id + '">✏️</button>';
      if (user.username !== 'admin') {
        html += '<button class="btn-icon delete" data-delete-user-id="' + user.id + '">🗑️</button>';
      }
      html += '</div>';
      html += '</div>';
    });

    container.innerHTML = html;

    container.querySelectorAll('.btn-icon.edit').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = parseInt(this.getAttribute('data-edit-user-id'));
        showUserModal(id);
      });
    });

    container.querySelectorAll('.btn-icon.delete').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var id = parseInt(this.getAttribute('data-delete-user-id'));
        var user = Object.values(users).find(function(u) { return u.id === id; });
        
        if (confirm(t('למחוק את המשתמש') + ' ' + user.name + '?')) {
          delete users[user.username];
          DB.save('shorashim-users', users);
          renderUsersAdminList();
          showToast('🗑️ ' + t('משתמש נמחק'));
        }
      });
    });
  }

  function showUserModal(editId) {
    var isEdit = editId !== null;
    var user = isEdit ? Object.values(users).find(function(u) { return u.id === editId; }) : null;

    var container = document.getElementById('modalContainer');
    
    // Build farm checkboxes
    var farmCheckboxes = '';
    if (farms.length > 0) {
      farmCheckboxes = '<div class="form-group"><label class="form-label">' + t('גישה למטעים') + '</label><div style="display: flex; flex-direction: column; gap: 8px; max-height: 150px; overflow-y: auto; padding: 8px; background: var(--g6); border-radius: 8px;">';
      farms.forEach(function(farm) {
        var checked = isEdit && user.farm_permissions && user.farm_permissions.indexOf(farm.id) !== -1;
        farmCheckboxes += '<label style="display: flex; align-items: center; gap: 8px; cursor: pointer;"><input type="checkbox" class="farm-permission-cb" data-farm-id="' + farm.id + '"' + (checked ? ' checked' : '') + ' style="width: 18px; height: 18px;"><span>' + locName(farm) + '</span></label>';
      });
      farmCheckboxes += '</div></div>';
    }

    var html =
      '<div class="modal-overlay" id="modalOverlay" onclick="if(event.target===this) window.cancelUserModal()">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<h2>' + (isEdit ? '✏️ ' + t('עריכת משתמש') : '➕ ' + t('משתמש חדש')) + '</h2>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('שם מלא') + '</label>' +
            '<input type="text" class="form-input" id="userName" value="' + (isEdit ? user.name : '') + '" placeholder="Name">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('אימייל') + '</label>' +
            '<input type="email" class="form-input" id="userEmail" value="' + (isEdit ? (user.email || '') : '') + '" placeholder="email@example.com" style="direction:ltr;text-align:left;" ' + (isEdit ? 'readonly style="background:#f0f0f0;direction:ltr;text-align:left;"' : '') + '>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('טלפון (לשחזור סיסמה ב-SMS)') + '</label>' +
            '<input type="tel" class="form-input" id="userPhone" value="' + (isEdit ? (user.phone || '') : '') + '" placeholder="050-1234567" style="direction:ltr;text-align:left;">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('תפקיד') + '</label>' +
            '<select class="form-input" id="userRole" style="cursor: pointer;">' +
              '<option value="worker"' + (isEdit && user.role === 'worker' ? ' selected' : '') + '>' + t('עובד') + '</option>' +
              '<option value="operator"' + (isEdit && user.role === 'operator' ? ' selected' : '') + '>' + t('מפעיל') + '</option>' +
              '<option value="admin"' + (isEdit && user.role === 'admin' ? ' selected' : '') + '>' + t('מנהל') + '</option>' +
              '<option value="viewer"' + (isEdit && user.role === 'viewer' ? ' selected' : '') + '>' + t('צופה') + '</option>' +
            '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('שפה') + '</label>' +
            '<select class="form-input" id="userLang" style="cursor: pointer;">' +
              '<option value="he"' + (isEdit && (user.lang === 'he' || !user.lang) ? ' selected' : '') + '>🇮🇱 עברית</option>' +
              '<option value="th"' + (isEdit && user.lang === 'th' ? ' selected' : '') + '>🇹🇭 ไทย</option>' +
              '<option value="ar"' + (isEdit && user.lang === 'ar' ? ' selected' : '') + '>🇸🇦 العربية</option>' +
            '</select>' +
            '<div style="font-size:0.7rem;color:#888;margin-top:4px;">' + t('קובע אילו חגים מופיעים בלוח של העובד') + '</div>' +
          '</div>' +
          farmCheckboxes +
          '<div style="font-size:0.75rem;color:#999;padding:8px;background:#fff3e0;border-radius:8px;margin-bottom:12px;">💡 ' + t('מומלץ להשתמש בכתובת Gmail של העובד — כך יוכל להתחבר בלחיצה אחת עם Google') + '</div>' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" onclick="window.saveUserModal()">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" onclick="window.cancelUserModal()">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    container.innerHTML = html;

    window.saveUserModal = function() {
      var name = document.getElementById('userName').value.trim();
      // Lowercase: must match the lowercased Firebase Auth email at login
      var email = document.getElementById('userEmail').value.trim().toLowerCase();
      var role = document.getElementById('userRole').value;
      var lang = document.getElementById('userLang').value;
      var phone = document.getElementById('userPhone').value.trim();
      
      var selectedFarms = [];
      container.querySelectorAll('.farm-permission-cb:checked').forEach(function(cb) {
        selectedFarms.push(parseInt(cb.getAttribute('data-farm-id')));
      });

      if (!name || !email) {
        showToast('❌ ' + t('חובה למלא שם ואימייל'));
        return;
      }

      if (isEdit) {
        if (users[user.username]) {
          users[user.username].name = name;
          users[user.username].role = role;
          users[user.username].lang = lang;
          users[user.username].farm_permissions = selectedFarms;
          users[user.username].phone = phone;
          DB.save('shorashim-users', users);
          renderUsersAdminList();
          showToast('✅ ' + t('משתמש עודכן'));
        }
      } else {
        // Check if email already exists
        var existing = getUserByEmail(email);
        if (existing) {
          showToast('❌ ' + t('אימייל כבר קיים'));
          return;
        }

        var username = email.split('@')[0];
        var maxId = Object.keys(users).length > 0 ? Math.max.apply(null, Object.values(users).map(function(u) { return u.id; })) : 0;
        
        users[username] = {
          id: maxId + 1,
          name: name,
          username: username,
          email: email,
          role: role,
          lang: lang,
          phone: phone,
          farm_permissions: selectedFarms,
          created_at: Date.now()
        };
        
        DB.save('shorashim-users', users);
        renderUsersAdminList();
        showToast('✅ ' + t('משתמש נוסף — יוכל להתחבר עם') + ' ' + email);
      }

      document.getElementById('modalContainer').innerHTML = '';
    };

    window.cancelUserModal = function() {
      document.getElementById('modalContainer').innerHTML = '';
    };
  }

  // Make user modal globally accessible for inline onclick
  window.showUserModalGlobal = function() {
    showUserModal(null);
  };

  // ── Profile Tab ──
  function renderProfileTab() {
    if (!currentUser) return;
    
    // Refresh user from localStorage to get latest data
    var usersData = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
    if (usersData[currentUser.username]) {
      currentUser = usersData[currentUser.username];
    }
    
    var initial = currentUser.name ? currentUser.name.charAt(0) : '?';
    document.getElementById('profileInitial').textContent = initial;
    document.getElementById('profileName').textContent = currentUser.name;
    var roleText = currentUser.role === 'admin' ? t('מנהל') : currentUser.role === 'operator' ? t('מפעיל') : currentUser.role === 'worker' ? t('עובד') : t('צופה');
    document.getElementById('profileRole').textContent = roleText + ' • ' + currentUser.username;
    
    // ── Farm cards ──
    var farmsContainer = document.getElementById('profileFarmsList');
    var userFarms = getUserFarms(currentUser);
    
    if (userFarms.length === 0) {
      farmsContainer.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">' + t('אין מטעים משויכים') + '</div>';
    } else {
      var farmsHtml = '';
      userFarms.forEach(function(farm) {
        var farmPlots = plots.filter(function(p) { return p.farm_id === farm.id; });
        var totalArea = farmPlots.reduce(function(sum, p) { return sum + (p.area || 0); }, 0);
        var irr = farm.irrigation || {};
        var irrText = irr.cube_per_dunam ? (irr.cube_per_dunam + ' ' + t('קוב לדונם/פתיחה')) : t('לא הוגדר');
        var irrDays = irr.days_per_week ? (irr.days_per_week + ' ' + t('ימים/שבוע')) : '';
        
        farmsHtml += '<div class="plot-card profile-farm-card" data-profile-farm-id="' + farm.id + '" style="border-right-color: ' + farm.color + '; cursor: pointer;">' +
          '<div class="plot-color" style="background:' + farm.color + '"></div>' +
          '<div class="plot-info">' +
            '<div class="plot-name">' + locName(farm) + '</div>' +
            '<div class="plot-meta">' +
              '<span>🌳 ' + farmPlots.length + ' ' + t('חלקות') + '</span>' +
              '<span>📐 ' + totalArea.toFixed(1) + ' ' + t('דונם') + '</span>' +
            '</div>' +
            '<div style="font-size: 0.72rem; color: var(--water); margin-top: 3px; font-weight: 500;">💧 ' + irrText + (irrDays ? ' • ' + irrDays : '') + '</div>' +
          '</div>' +
          '<span style="font-size: 1.2rem; color: var(--text-muted);">←</span>' +
        '</div>';
      });
      farmsContainer.innerHTML = farmsHtml;
      
      farmsContainer.querySelectorAll('.profile-farm-card').forEach(function(card) {
        card.addEventListener('click', function() {
          var farmId = parseInt(this.getAttribute('data-profile-farm-id'));
          showFarmDetails(farmId);
        });
      });
    }
    
    // ── Primary plot list with checkmarks ──
    var container = document.getElementById('primaryPlotList');
    var accessiblePlots = getAccessiblePlots();
    
    if (accessiblePlots.length === 0) {
      container.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">' + t('אין חלקות זמינות') + '</div>';
      return;
    }
    
    var currentPrimary = currentUser.primary_plot_id || null;
    var html = '';
    
    html += '<div class="plot-checkbox-item primary-plot-option" data-primary-id="0" style="' + (!currentPrimary ? 'background: var(--g5); border: 2px solid var(--g3);' : 'border: 2px solid transparent;') + '">' +
      '<span style="font-size: 1.2rem;">' + (!currentPrimary ? '✅' : '⬜') + '</span>' +
      '<span class="plot-checkbox-label">' + t('ללא — הצג את כל החלקות') + '</span>' +
    '</div>';
    
    accessiblePlots.forEach(function(p) {
      var isSelected = currentPrimary === p.id;
      var farmName = '';
      var farm = farms.find(function(f) { return f.id === p.farm_id; });
      if (farm) farmName = farm.name;
      
      html += '<div class="plot-checkbox-item primary-plot-option" data-primary-id="' + p.id + '" style="' + (isSelected ? 'background: var(--g5); border: 2px solid var(--g3);' : 'border: 2px solid transparent;') + '">' +
        '<span style="font-size: 1.2rem;">' + (isSelected ? '✅' : '⬜') + '</span>' +
        '<div style="flex: 1;">' +
          '<div class="plot-checkbox-label">' + locName(p) + '</div>' +
          (farmName ? '<div style="font-size: 0.75rem; color: var(--text-muted);">' + farmName + ' • ' + formatArea(p.area) + '</div>' : '') +
        '</div>' +
      '</div>';
    });
    
    container.innerHTML = html;
    
    container.querySelectorAll('.primary-plot-option').forEach(function(el) {
      el.addEventListener('click', function() {
        var plotId = parseInt(this.getAttribute('data-primary-id'));
        if (plotId === 0) plotId = null;
        
        var usersData = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
        if (usersData[currentUser.username]) {
          usersData[currentUser.username].primary_plot_id = plotId;
          DB.save('shorashim-users', usersData);
          users = usersData;
          currentUser = usersData[currentUser.username];
          showToast('✅ ' + t('חלקה ראשית עודכנה'));
          renderProfileTab();
        }
      });
    });
    
    // ── Email field ──
    var emailInput = document.getElementById('profileEmail');
    emailInput.value = currentUser.email || '';
    var emailStatus = document.getElementById('profileEmailStatus');
    if (currentUser.email) {
      emailStatus.innerHTML = '<span style="color: var(--g3);">✅ ' + t('מחובר') + ': ' + currentUser.email + '</span>';
    } else {
      emailStatus.innerHTML = '<span style="color: var(--accent);">⚠️ ' + t('לא הוגדר אימייל') + '</span>';
    }
    
    // ── Sheet ID config (admin only) ──
    var sheetConfigEl = document.getElementById('profileSheetConfig');
    if (currentUser.role === 'admin') {
      sheetConfigEl.style.display = 'block';
      
      // Apps Script URL
      var urlInput = document.getElementById('profileAppsScriptUrl');
      var savedUrl = localStorage.getItem('shorashim-apps-script-url') || '';
      urlInput.value = savedUrl;
      var urlStatus = document.getElementById('profileAppsScriptStatus');
      if (savedUrl) {
        urlStatus.innerHTML = '<span style="color: var(--g3);">✅ ' + t('מחובר') + '</span>';
      } else {
        urlStatus.innerHTML = '<span style="color: var(--accent);">⚠️ ' + t('לא הוגדר') + '</span>';
      }
      
      // Sheet IDs per farm
      var sheetHtml = '';
      farms.forEach(function(farm) {
        var sheetId = farm.google_sheet_id || '';
        var statusDot = sheetId ? '🟢' : '🔴';
        sheetHtml += '<div class="form-group" style="margin-bottom: 10px;">' +
          '<label class="form-label" style="display: flex; align-items: center; gap: 6px;">' +
            statusDot + ' ' +
            '<span style="width: 12px; height: 12px; border-radius: 50%; background: ' + farm.color + '; display: inline-block;"></span>' +
            farm.name +
          '</label>' +
          '<input type="text" class="form-input sheet-id-input" data-farm-id="' + farm.id + '" value="' + sheetId + '" placeholder="Sheet ID" dir="ltr" style="text-align: left; font-size: 0.82rem;">' +
        '</div>';
      });
      if (farms.length > 0) {
        sheetHtml += '<button class="btn-admin" id="saveSheetIds" style="width: 100%; margin-top: 8px;">💾 ' + t('שמור') + '</button>';
      }
      document.getElementById('profileSheetIds').innerHTML = sheetHtml;
      
      var saveBtn = document.getElementById('saveSheetIds');
      if (saveBtn) {
        saveBtn.addEventListener('click', function() {
          document.querySelectorAll('.sheet-id-input').forEach(function(input) {
            var fId = parseInt(input.getAttribute('data-farm-id'));
            var farm = farms.find(function(f) { return f.id === fId; });
            if (farm) farm.google_sheet_id = input.value.trim() || null;
          });
          saveData();
          showToast('✅ ' + t('מזהי גיליונות נשמרו'));
          renderProfileTab();
        });
      }
    } else {
      sheetConfigEl.style.display = 'none';
    }
  }
  
  // ── Profile Email Save ──
  document.getElementById('profileEmailSave').addEventListener('click', function() {
    var email = document.getElementById('profileEmail').value.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('❌ ' + t('כתובת אימייל לא תקינה'));
      return;
    }
    var usersData = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
    if (usersData[currentUser.username]) {
      usersData[currentUser.username].email = email || null;
      DB.save('shorashim-users', usersData);
      users = usersData;
      currentUser = usersData[currentUser.username];
      // Update session with email
      var session = JSON.parse(sessionStorage.getItem('currentUser') || '{}');
      session.email = email || null;
      sessionStorage.setItem('currentUser', JSON.stringify(session));
      showToast(email ? '✅ ' + t('אימייל נשמר') : '✅ ' + t('אימייל הוסר'));
      renderProfileTab();
    }
  });

  // ── Apps Script URL Save ──
  document.getElementById('saveAppsScriptUrl').addEventListener('click', function() {
    var url = document.getElementById('profileAppsScriptUrl').value.trim();
    if (url && !url.startsWith('https://script.google.com/')) {
      showToast('❌ ' + t('כתובת לא תקינה'));
      return;
    }
    DB.save('shorashim-apps-script-url', url);
    APPS_SCRIPT_URL = url;
    showToast(url ? '✅ ' + t('כתובת Apps Script נשמרה') : '✅ ' + t('כתובת הוסרה'));
    renderProfileTab();
  });

  // ══════════════════════════════════
  // ── WORKLOG SYSTEM ──
  // ══════════════════════════════════

  var WL_ACTIONS_DEFAULT = [
    t('איגוז'),t('בדיקת השקייה תקופתית'),t('גדיד'),t('גיזום וניקוי אשלים וחוטרים עודפים'),t('גיזום חורפי'),
    t('גיזום תמרים במושב'),t('דילול ראשוני'),t('דילול שני'),t('הגמעת גימיק'),
    t('הגמעת קונפידור - חידקונית, קרנפית, ציקדות'),t('הורדת שקים'),t('הכנת חדר אבקה'),t('הפרייה'),
    t('השלמת נטיעה'),t('טיפול שוטף לכלי גובה'),t('נקיון מט"ש'),t('נקיון מטע כללי'),
    t('סידור גזם חורפי לאיסוף'),t('סילוק עורלה'),t('סיקול אבנים'),t('עטיפה'),t('עשבייה מטעים כללי'),
    t('קיוץ'),t('קיפניס - יישור קרקע'),t('קשירה'),t('קשירה ושקים'),t('קשירת זכרים והפקת אבקה'),
    t('ריסוס אקריות'),t('ריסוס בקתוש'),t('ריסוס גזע לחידקונית'),t('ריסוס כווייה שחורה - ריסוס צמרות'),
    t('ריסוס עשבייה'),t('ריסוס עת"ק'),t('נטיעה'),t('ריסוק'),t('שטיפת שקים'),t('תחזוקת גדר חשמלית'),
    t('קטיף לולבים'),t('מיון ושימור לולבים'),t('קידוח גזע לחידקונית'),t('הדרכות'),
    t('העברת/איסוף שקים'),t('שקים'),t('ראיס/מנהל עבודה')
  ];
  
  var WL_BUDGET_CATEGORIES_DEFAULT = [
    t('קיוץ'),t('הפרייה'),t('דילול'),t('קשירה'),t('שקים'),t('גדיד'),t('הורדת רשת/שקים'),
    t('גיזום'),t('טיפול קרקע ואחזקה'),t('קשירה ושקים'),t('לולבים')
  ];
  
  var WL_WORKER_GROUPS_DEFAULT = [
    t('תאילנדים שורשים'),t('תאילנדים גלגל'),t('תאילנדים ייטב'),t('נפאלים'),t('סרילנקה'),t('מלאווים'),
    t('פלסטינאים'),t('ישראלים'),t('מתנדבים'),t('קבלנות פרדסים'),t('פרדס איימן'),
    t('עובדי גד"ש מפנמה'),t('שומר חדש'),
    t('אלון עובדיה'),t('ארנון צור'),t('זיו ליבה'),t('נערן'),t('אגוזי'),t('דיירי'),t('הלאלי'),
    t('רוחקין'),t('בראשית'),t('סנסן ודקל'),t('אדיר שלמה'),t('יובל בן עמי')
  ];
  
  // Admin-editable: merge defaults with custom from localStorage
  var customActions = JSON.parse(localStorage.getItem('shorashim-custom-actions') || '[]');
  var customBudgets = JSON.parse(localStorage.getItem('shorashim-custom-budgets') || '[]');
  var customWorkerGroups = JSON.parse(localStorage.getItem('shorashim-custom-worker-groups') || '[]');
  
  var WL_ACTIONS = WL_ACTIONS_DEFAULT.concat(customActions);
  var WL_BUDGET_CATEGORIES = WL_BUDGET_CATEGORIES_DEFAULT.concat(customBudgets);
  var WL_WORKER_GROUPS = WL_WORKER_GROUPS_DEFAULT.concat(customWorkerGroups);
  
  // Keep old WL_TYPES for backward compat with history display
  var WL_TYPES_DEFAULT = {};
  WL_ACTIONS.forEach(function(a) { WL_TYPES_DEFAULT[a] = a; });
  var customWorkTypes = JSON.parse(localStorage.getItem('shorashim-custom-work-types') || '{}');
  var WL_TYPES = Object.assign({}, WL_TYPES_DEFAULT, customWorkTypes);
  
  // Worker list
  var savedWorkers = JSON.parse(localStorage.getItem('shorashim-workers') || '[]');

  // ── Sub-view toggle ──
  var wlCurrentView = 'form';
  
  document.querySelectorAll('.wl-view-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      wlCurrentView = this.getAttribute('data-wl-view');
      document.querySelectorAll('.wl-view-btn').forEach(function(b) {
        b.classList.remove('active');
        b.style.background = 'var(--g5)'; b.style.color = 'var(--g1)';
      });
      this.classList.add('active');
      this.style.background = 'var(--g2)'; this.style.color = 'white';
      document.getElementById('wlViewForm').style.display = wlCurrentView === 'form' ? 'block' : 'none';
      document.getElementById('wlViewSummary').style.display = wlCurrentView === 'summary' ? 'block' : 'none';
      if (wlCurrentView === 'summary') {
        renderWorklogChart('type');
        renderWorklogHistory();
      }
    });
  });
  // Set initial style
  document.querySelector('.wl-view-btn.active').style.background = 'var(--g2)';
  document.querySelector('.wl-view-btn.active').style.color = 'white';

  // ── Long-press on worklog tab → choice popup ──
  (function() {
    var worklogTab = document.querySelector('[data-tab="worklog"]');
    var longPressTimer = null;
    
    worklogTab.addEventListener('touchstart', function(e) {
      longPressTimer = setTimeout(function() {
        // Show choice popup
        var container = document.getElementById('modalContainer');
        container.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
          '<div class="modal" style="max-width:320px;padding:20px;">' +
            '<h2 style="text-align:center;">📝 ' + t('יומן עבודה') + '</h2>' +
            '<button class="btn-submit" id="lpFormBtn" style="margin-bottom:10px;">📝 ' + t('דו״ח עבודה') + '</button>' +
            '<button class="btn-submit" id="lpSummaryBtn" style="background:linear-gradient(135deg,#455a64,#607d8b);">📊 ' + t('סיכום והיסטוריה') + '</button>' +
          '</div></div>';
        document.getElementById('lpFormBtn').addEventListener('click', function() {
          container.innerHTML = '';
          wlCurrentView = 'form';
          document.querySelectorAll('.wl-view-btn').forEach(function(b) { b.classList.remove('active'); b.style.background='var(--g5)'; b.style.color='var(--g1)'; });
          document.querySelector('[data-wl-view="form"]').classList.add('active');
          document.querySelector('[data-wl-view="form"]').style.background='var(--g2)';
          document.querySelector('[data-wl-view="form"]').style.color='white';
          document.getElementById('wlViewForm').style.display = 'block';
          document.getElementById('wlViewSummary').style.display = 'none';
          // Switch to worklog tab
          document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          worklogTab.classList.add('active');
          document.getElementById('tabWorklog').classList.add('active');
          activeTab = 'worklog';
          renderWorklogTab();
        });
        document.getElementById('lpSummaryBtn').addEventListener('click', function() {
          container.innerHTML = '';
          wlCurrentView = 'summary';
          document.querySelectorAll('.wl-view-btn').forEach(function(b) { b.classList.remove('active'); b.style.background='var(--g5)'; b.style.color='var(--g1)'; });
          document.querySelector('[data-wl-view="summary"]').classList.add('active');
          document.querySelector('[data-wl-view="summary"]').style.background='var(--g2)';
          document.querySelector('[data-wl-view="summary"]').style.color='white';
          document.getElementById('wlViewForm').style.display = 'none';
          document.getElementById('wlViewSummary').style.display = 'block';
          document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
          document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
          worklogTab.classList.add('active');
          document.getElementById('tabWorklog').classList.add('active');
          activeTab = 'worklog';
          renderWorklogTab();
          renderWorklogChart('type');
        });
      }, 600);
    }, { passive: true });
    worklogTab.addEventListener('touchend', function() { clearTimeout(longPressTimer); });
    worklogTab.addEventListener('touchmove', function() { clearTimeout(longPressTimer); });
  })();

  function renderWorklogTab() {
    if (!currentUser) return;
    
    // Populate farm selector
    var select = document.getElementById('wlFarmSelect');
    var userFarms = getUserFarms(currentUser);
    var currentVal = select.value;
    select.innerHTML = '<option value="">' + t('— בחר מטע —') + '</option>';
    userFarms.forEach(function(farm) {
      var opt = document.createElement('option');
      opt.value = farm.id;
      opt.textContent = locName(farm);
      select.appendChild(opt);
    });
    if (currentVal) select.value = currentVal;
    
    // Set default date
    var dateInput = document.getElementById('wlDate');
    if (!dateInput.value) dateInput.value = new Date().toISOString().split('T')[0];
    
    // Populate plot selector based on selected farm
    updateWorklogPlotSelector();
    
    // Populate work action dropdown
    var typeSelect = document.getElementById('wlType');
    var currentType = typeSelect.value;
    typeSelect.innerHTML = '<option value="">— ' + t('בחר פעולה') + ' —</option>';
    WL_ACTIONS.forEach(function(action) {
      var opt = document.createElement('option');
      opt.value = action;
      opt.textContent = action;
      typeSelect.appendChild(opt);
    });
    if (currentType) typeSelect.value = currentType;
    
    // Populate budget category dropdown
    var budgetSelect = document.getElementById('wlBudgetCategory');
    var currentBudget = budgetSelect.value;
    budgetSelect.innerHTML = '<option value="">— ' + t('בחר סעיף') + ' —</option>';
    WL_BUDGET_CATEGORIES.forEach(function(cat) {
      var opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      budgetSelect.appendChild(opt);
    });
    if (currentBudget) budgetSelect.value = currentBudget;
    
    // Populate worker group dropdown
    var groupSelect = document.getElementById('wlWorkerGroup');
    var currentGroup = groupSelect.value;
    groupSelect.innerHTML = '<option value="">— ' + t('בחר קבוצה') + ' —</option>';
    WL_WORKER_GROUPS.forEach(function(grp) {
      var opt = document.createElement('option');
      opt.value = grp;
      opt.textContent = grp;
      groupSelect.appendChild(opt);
    });
    if (currentGroup) groupSelect.value = currentGroup;
    
    // Populate worker name suggestions
    var datalist = document.getElementById('workerSuggestions');
    datalist.innerHTML = '';
    savedWorkers.forEach(function(w) {
      var opt = document.createElement('option');
      opt.value = w.name;
      datalist.appendChild(opt);
    });
    
    // Show/hide form based on selection
    updateWorklogVisibility();
    
    // Render local history
    renderWorklogHistory();
    
    // Render chart
    renderWorklogChart('type');
    
    // Translate data-t-val options
    document.querySelectorAll('[data-t-val]').forEach(function(opt) {
      opt.textContent = t(opt.getAttribute('data-t-val'));
    });
  }
  
  function updateWorklogPlotSelector() {
    var farmId = parseInt(document.getElementById('wlFarmSelect').value);
    var plotSelect = document.getElementById('wlPlotSelect');
    plotSelect.innerHTML = '<option value="">' + t('כל החלקות') + '</option>';
    
    if (farmId) {
      var farmPlots = plots.filter(function(p) { return p.farm_id === farmId; });
      farmPlots.forEach(function(p) {
        var opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = locName(p);
        plotSelect.appendChild(opt);
      });
    }
  }
  
  function updateWorklogVisibility() {
    var farmId = parseInt(document.getElementById('wlFarmSelect').value);
    var form = document.getElementById('wlEntryForm');
    var sheetSection = document.getElementById('wlSheetSection');
    
    if (farmId) {
      form.style.display = 'block';
      
      // Check if farm has a sheet configured
      var farm = farms.find(function(f) { return f.id === farmId; });
      var hasSheet = farm && farm.google_sheet_id;
      var hasEmail = currentUser && currentUser.email;
      
      // Show/hide sheet button
      var sheetBtn = document.getElementById('wlSubmitSheet');
      var sheetStatus = document.getElementById('wlSheetStatus');
      
      if (hasSheet && hasEmail) {
        sheetBtn.style.display = 'block';
        sheetBtn.disabled = false;
        sheetStatus.innerHTML = '';
        sheetSection.style.display = 'block';
        // Auto-load sheet data
        fetchSheetData(farm);
      } else if (hasSheet && !hasEmail) {
        sheetBtn.style.display = 'block';
        sheetBtn.disabled = true;
        sheetStatus.innerHTML = '<span style="color: var(--accent);">⚠️ ' + t('יש להגדיר אימייל בטאב האישי') + '</span>';
        sheetSection.style.display = 'none';
      } else {
        sheetBtn.style.display = 'none';
        sheetStatus.innerHTML = '';
        sheetSection.style.display = 'none';
      }
    } else {
      form.style.display = 'none';
      sheetSection.style.display = 'none';
    }
    
    // Show chart if there are entries for this farm
    var chartSection = document.getElementById('wlChartSection');
    var farmEntries = worklogEntries.filter(function(e) { return !farmId || e.farm_id === farmId; });
    chartSection.style.display = farmEntries.length > 0 ? 'block' : 'none';
  }
  
  // Farm selector change
  document.getElementById('wlFarmSelect').addEventListener('change', function() {
    updateWorklogPlotSelector();
    updateWorklogVisibility();
    renderWorklogHistory();
    renderWorklogChart('type');
  });
  
  // ── Add custom action ──
  document.getElementById('wlAddTypeBtn').addEventListener('click', function() {
    var container = document.getElementById('modalContainer');
    container.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
      '<div class="modal" style="max-width:360px;">' +
        '<h2>➕ ' + t('פעולה חדשה') + '</h2>' +
        '<div class="form-group">' +
          '<label class="form-label">' + t('שם הפעולה') + '</label>' +
          '<input type="text" class="form-input" id="newTypeName" placeholder="">' +
        '</div>' +
        '<div class="modal-buttons">' +
          '<button class="btn btn-primary" id="saveNewType">' + t('שמור') + '</button>' +
          '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
        '</div>' +
      '</div></div>';
    setTimeout(function() { document.getElementById('newTypeName').focus(); }, 150);
    document.getElementById('saveNewType').addEventListener('click', function() {
      var name = document.getElementById('newTypeName').value.trim();
      if (!name) return;
      if (WL_ACTIONS.indexOf(name) === -1) {
        customActions.push(name);
        WL_ACTIONS.push(name);
        DB.save('shorashim-custom-actions', customActions);
      }
      container.innerHTML = '';
      renderWorklogTab();
      document.getElementById('wlType').value = name;
      showToast('✅ ' + name + ' ' + t('נוסף'));
    });
  });
  
  // ── Add custom worker group ──
  document.getElementById('wlAddWorkerGroupBtn').addEventListener('click', function() {
    var container = document.getElementById('modalContainer');
    container.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
      '<div class="modal" style="max-width:360px;">' +
        '<h2>➕ ' + t('קבוצת עובדים חדשה') + '</h2>' +
        '<div class="form-group">' +
          '<label class="form-label">' + t('שם הקבוצה') + '</label>' +
          '<input type="text" class="form-input" id="newGroupName" placeholder="">' +
        '</div>' +
        '<div class="modal-buttons">' +
          '<button class="btn btn-primary" id="saveNewGroup">' + t('שמור') + '</button>' +
          '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
        '</div>' +
      '</div></div>';
    setTimeout(function() { document.getElementById('newGroupName').focus(); }, 150);
    document.getElementById('saveNewGroup').addEventListener('click', function() {
      var name = document.getElementById('newGroupName').value.trim();
      if (!name) return;
      if (WL_WORKER_GROUPS.indexOf(name) === -1) {
        customWorkerGroups.push(name);
        WL_WORKER_GROUPS.push(name);
        DB.save('shorashim-custom-worker-groups', customWorkerGroups);
      }
      container.innerHTML = '';
      renderWorklogTab();
      document.getElementById('wlWorkerGroup').value = name;
      showToast('✅ ' + name + ' ' + t('נוסף'));
    });
  });
  
  // ── Save locally (with worker list saving) ──
  document.getElementById('wlSubmitLocal').addEventListener('click', function() {
    var entry = collectWorklogEntry();
    if (!entry) return;
    
    // Save worker names to list
    saveWorkerNames(entry.workers);
    
    worklogEntries.unshift(entry);
    saveData();
    showToast('✅ ' + t('רשומה נשמרה מקומית'));
    clearWorklogForm();
    renderWorklogHistory();
  });
  
  function saveWorkerNames(workersStr) {
    if (!workersStr) return;
    var names = workersStr.split(',').map(function(s) { return s.trim(); }).filter(function(s) { return s; });
    var group = document.getElementById('wlWorkerGroup').value || '';
    var existingNames = savedWorkers.map(function(w) { return w.name.toLowerCase(); });
    var added = false;
    names.forEach(function(name) {
      if (existingNames.indexOf(name.toLowerCase()) === -1) {
        savedWorkers.push({ name: name, group: group });
        existingNames.push(name.toLowerCase());
        added = true;
      }
    });
    if (added) DB.save('shorashim-workers', savedWorkers);
  }
  
  // ── Save & send to Sheet ──
  document.getElementById('wlSubmitSheet').addEventListener('click', function() {
    var entry = collectWorklogEntry();
    if (!entry) return;
    
    saveWorkerNames(entry.workers);
    
    var farm = farms.find(function(f) { return f.id === entry.farm_id; });
    if (!farm || !farm.google_sheet_id) {
      showToast('❌ ' + t('לא הוגדר גיליון למטע זה'));
      return;
    }
    if (!currentUser.email) {
      showToast('❌ ' + t('יש להגדיר אימייל בטאב האישי'));
      return;
    }
    
    // Save locally first
    entry.synced_to_sheet = false;
    worklogEntries.unshift(entry);
    saveData();
    
    // Send to Google Sheet via Apps Script Web App
    var btnText = document.getElementById('wlSheetBtnText');
    btnText.textContent = '⏳ ' + t('שולח') + '...';
    
    sendToGoogleSheet(farm, entry).then(function(success) {
      if (success) {
        entry.synced_to_sheet = true;
        saveData();
        showToast('✅ ' + t('נשלח ל-Google Sheet'));
        clearWorklogForm();
        renderWorklogHistory();
        fetchSheetData(farm);
      } else {
        showToast('❌ ' + t('שליחה נכשלה — נשמר מקומית'));
      }
      btnText.textContent = '📊 ' + t('שמור ושלח ל-Google Sheet');
    }).catch(function() {
      showToast('❌ ' + t('שגיאת רשת — נשמר מקומית'));
      btnText.textContent = '📊 ' + t('שמור ושלח ל-Google Sheet');
    });
    
    renderWorklogHistory();
  });
  
  function collectWorklogEntry() {
    var farmId = parseInt(document.getElementById('wlFarmSelect').value);
    if (!farmId) { showToast('❌ ' + t('יש לבחור מטע')); return null; }
    
    var date = document.getElementById('wlDate').value;
    if (!date) { showToast('❌ ' + t('יש לבחור תאריך')); return null; }
    
    var action = document.getElementById('wlType').value;
    if (!action) { showToast('❌ ' + t('יש לבחור פעולה')); return null; }
    
    var farm = farms.find(function(f) { return f.id === farmId; });
    var plotId = parseInt(document.getElementById('wlPlotSelect').value) || null;
    var plotObj = plotId ? plots.find(function(p) { return p.id === plotId; }) : null;
    
    var budgetCategory = document.getElementById('wlBudgetCategory').value || '';
    var workerGroup = document.getElementById('wlWorkerGroup').value || '';
    var workerCount = parseInt(document.getElementById('wlWorkerCount').value) || 1;
    var hours = parseFloat(document.getElementById('wlHours').value) || null;
    
    // Day of week in Hebrew
    var dayNames = [t('יום א\''),t('יום ב\''),t('יום ג\''),t('יום ד\''),t('יום ה\''),t('יום ו\''),t('שבת')];
    var dayOfWeek = dayNames[new Date(date).getDay()];
    
    return {
      id: Date.now(),
      farm_id: farmId,
      farm_name: farm ? farm.name : '',
      plot_id: plotId,
      plot_name: plotObj ? plotObj.name : '',
      date: date,
      day_of_week: dayOfWeek,
      type: action,
      type_label: action,
      budget_category: budgetCategory,
      worker_group: workerGroup,
      description: action,
      hours: hours,
      worker_count: workerCount,
      trees_completed: parseInt(document.getElementById('wlTreesCompleted').value) || null,
      workers: document.getElementById('wlWorkers').value.trim() || null,
      notes: document.getElementById('wlNotes').value.trim() || null,
      operator: currentUser ? currentUser.name : '',
      operator_email: currentUser ? (currentUser.email || '') : '',
      created_at: new Date().toISOString(),
      synced_to_sheet: false
    };
  }
  
  function clearWorklogForm() {
    document.getElementById('wlHours').value = '';
    document.getElementById('wlWorkerCount').value = '';
    document.getElementById('wlTreesCompleted').value = '';
    document.getElementById('wlWorkers').value = '';
    document.getElementById('wlNotes').value = '';
    document.getElementById('wlDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('wlProductivityPreview').style.display = 'none';
    // Keep plot, budget, action, worker group selected for next entry
  }
  
  // ── Live productivity calculator ──
  function updateProductivityPreview() {
    var trees = parseInt(document.getElementById('wlTreesCompleted').value) || 0;
    var hours = parseFloat(document.getElementById('wlHours').value) || 0;
    var workers = parseInt(document.getElementById('wlWorkerCount').value) || 1;
    var preview = document.getElementById('wlProductivityPreview');
    
    if (trees > 0 && hours > 0) {
      preview.style.display = 'block';
      var treesPerHour = trees / hours;
      var treesPerWorker = trees / workers;
      var treesPerWorkerHour = trees / (hours * workers);
      document.getElementById('wlProdTreesPerHour').textContent = treesPerHour.toFixed(1);
      document.getElementById('wlProdTreesPerWorker').textContent = treesPerWorker.toFixed(0);
      document.getElementById('wlProdTreesPerWorkerHour').textContent = treesPerWorkerHour.toFixed(1);
    } else if (trees > 0 && workers > 0) {
      preview.style.display = 'block';
      document.getElementById('wlProdTreesPerHour').textContent = '—';
      document.getElementById('wlProdTreesPerWorker').textContent = (trees / workers).toFixed(0);
      document.getElementById('wlProdTreesPerWorkerHour').textContent = '—';
    } else {
      preview.style.display = 'none';
    }
  }
  
  ['wlTreesCompleted', 'wlHours', 'wlWorkerCount'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', updateProductivityPreview);
  });
  
  function renderWorklogHistory() {
    var container = document.getElementById('wlLocalHistory');
    var farmId = parseInt(document.getElementById('wlFarmSelect').value);
    
    var filtered = worklogEntries;
    if (farmId) {
      filtered = worklogEntries.filter(function(e) { return e.farm_id === farmId; });
    }
    
    // Filter by accessible farms
    if (currentUser && currentUser.role !== 'admin') {
      var userFarms = getUserFarms(currentUser);
      var farmIds = userFarms.map(function(f) { return f.id; });
      filtered = filtered.filter(function(e) { return farmIds.indexOf(e.farm_id) !== -1; });
    }
    
    if (filtered.length === 0) {
      container.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">' + t('אין רשומות') + '</div>';
      return;
    }
    
    var html = '';
    filtered.slice(0, 20).forEach(function(entry) {
      var syncIcon = entry.synced_to_sheet ? '<span style="color: var(--g3); font-size: 0.7rem;" title="' + t('סונכרן') + '">☁️</span>' : '<span style="color: var(--text-muted); font-size: 0.7rem;" title="' + t('מקומי') + '">💾</span>';
      html += '<div style="padding: 12px; background: var(--card); border-radius: 10px; margin-bottom: 8px; box-shadow: var(--shadow); border-right: 3px solid ' + getTypeColor(entry.type) + ';">' +
        '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">' +
          '<span class="wl-type-badge ' + entry.type + '">' + t(WL_TYPES[entry.type] || entry.type) + '</span>' +
          '<span style="font-size: 0.78rem; color: var(--text-muted);">' + entry.date + ' ' + syncIcon + '</span>' +
        '</div>' +
        '<div style="font-size: 0.88rem; font-weight: 500; margin-bottom: 4px;">' + entry.description + '</div>' +
        '<div style="font-size: 0.75rem; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap;">' +
          (entry.farm_name ? '<span>🌳 ' + entry.farm_name + '</span>' : '') +
          (entry.plot_name ? '<span>📍 ' + entry.plot_name + '</span>' : '') +
          (entry.trees_completed ? '<span>🌴 ' + entry.trees_completed + ' ' + t('עצים') + '</span>' : '') +
          (entry.hours ? '<span>⏱ ' + entry.hours + ' ' + t('שעות') + '</span>' : '') +
          (entry.worker_count && entry.worker_count > 1 ? '<span>👥 ' + entry.worker_count + ' ' + t('עובדים') + '</span>' : '') +
          (entry.workers ? '<span>👷 ' + entry.workers + '</span>' : '') +
          '<span>👤 ' + entry.operator + '</span>' +
        '</div>' +
        (entry.trees_completed && entry.hours ? '<div style="font-size: 0.72rem; color: var(--g2); margin-top: 4px; font-weight: 600;">⚡ ' + (entry.trees_completed / entry.hours).toFixed(1) + ' ' + t('עצים/שעה') + (entry.worker_count > 1 ? ' • ' + (entry.trees_completed / (entry.hours * entry.worker_count)).toFixed(1) + ' ' + t('עצים/עובד×שעה') : '') + '</div>' : '') +
        (entry.notes ? '<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 4px; font-style: italic;">📝 ' + entry.notes + '</div>' : '') +
      '</div>';
    });
    container.innerHTML = html;
  }
  
  function getTypeColor(type) {
    var colors = {
      irrigation: '#1565c0', spray: '#c62828', fertilize: '#2e7d32',
      pruning: '#ff6f00', harvest: '#6a1b9a', maintenance: '#455a64', other: '#616161'
    };
    return colors[type] || '#616161';
  }

  // ── Plot Worklog Summary (for plot detail popup) ──

  function getPlotWorklogSummary(plotId, plotName) {
    var plotEntries = worklogEntries.filter(function(e) { return e.plot_id === plotId; });

    if (plotEntries.length === 0) {
      return '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.8rem;">' + t('אין רשומות') + '</div>';
    }

    // Sort by date desc
    plotEntries.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });

    // Totals
    var totalHours = 0, totalTrees = 0, totalEntries = plotEntries.length;
    plotEntries.forEach(function(e) {
      totalHours += (e.hours || 0);
      totalTrees += (e.trees_completed || 0);
    });

    // Summary stats bar
    var html = '<div style="display: flex; gap: 8px; margin-bottom: 8px;">';
    html += '<div style="flex:1; background: var(--g6); padding: 6px 8px; border-radius: 8px; text-align: center;">';
    html += '<div style="font-size: 0.6rem; color: var(--text-muted);">' + t('רשומות') + '</div>';
    html += '<div style="font-size: 0.95rem; font-weight: 700; color: var(--g1);">' + totalEntries + '</div></div>';
    html += '<div style="flex:1; background: var(--g6); padding: 6px 8px; border-radius: 8px; text-align: center;">';
    html += '<div style="font-size: 0.6rem; color: var(--text-muted);">' + t('שעות') + '</div>';
    html += '<div style="font-size: 0.95rem; font-weight: 700; color: var(--g1);">' + totalHours.toFixed(1) + '</div></div>';
    if (totalTrees > 0) {
      html += '<div style="flex:1; background: #e8f5e9; padding: 6px 8px; border-radius: 8px; text-align: center;">';
      html += '<div style="font-size: 0.6rem; color: var(--text-muted);">🌴 ' + t('עצים') + '</div>';
      html += '<div style="font-size: 0.95rem; font-weight: 700; color: var(--g1);">' + totalTrees + '</div></div>';
    }
    html += '</div>';

    // Last 3 entries compact
    var recent = plotEntries.slice(0, 3);
    recent.forEach(function(entry) {
      html += '<div style="padding: 6px 8px; background: var(--g6); border-radius: 8px; margin-bottom: 4px; border-right: 3px solid ' + getTypeColor(entry.type) + '; font-size: 0.78rem;">';
      html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
      html += '<span style="font-weight: 700;">' + (entry.description || t(WL_TYPES[entry.type] || entry.type)) + '</span>';
      html += '<span style="color: var(--text-muted); font-size: 0.72rem;">' + entry.date + '</span>';
      html += '</div>';
      var details = [];
      if (entry.hours) details.push('⏱' + entry.hours + t('שעות'));
      if (entry.worker_count > 1) details.push('👥' + entry.worker_count);
      if (entry.trees_completed) details.push('🌴' + entry.trees_completed);
      if (entry.workers) details.push('👷' + entry.workers);
      if (details.length) html += '<div style="color: var(--text-muted); font-size: 0.7rem; margin-top: 2px;">' + details.join(' &nbsp; ') + '</div>';
      html += '</div>';
    });

    // "Show full history" button
    if (plotEntries.length > 3) {
      html += '<div style="text-align: center; margin-top: 4px;">';
      html += '<span style="font-size: 0.72rem; color: var(--text-muted);">' + (plotEntries.length - 3) + ' ' + t('רשומות נוספות') + '</span>';
      html += '</div>';
    }
    html += '<button onclick="showPlotWorklogHistory(' + plotId + ',\'' + (plotName || '').replace(/'/g, "\\'") + '\')" style="width:100%;margin-top:6px;padding:8px;border-radius:8px;border:none;background:var(--g6);font-family:inherit;font-size:0.8rem;font-weight:600;color:var(--g2);cursor:pointer;">📊 ' + t('הצג היסטוריה מלאה') + '</button>';

    return html;
  }

  window.showPlotWorklogHistory = function(plotId, plotName) {
    var plotEntries = worklogEntries.filter(function(e) { return e.plot_id === plotId; });
    plotEntries.sort(function(a, b) { return (b.date || '').localeCompare(a.date || ''); });

    var modal = document.getElementById('modalContainer');
    var html = '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">';
    html += '<div class="modal" style="max-width: 550px; max-height: 85vh; overflow-y: auto;">';
    html += '<h2 style="margin-bottom: 12px;">📝 ' + t('יומן עבודה') + ' — ' + (plotName || '') + '</h2>';

    if (plotEntries.length === 0) {
      html += '<div style="padding: 20px; text-align: center; color: var(--text-muted);">' + t('אין רשומות') + '</div>';
    } else {
      // Stats summary
      var totalHours = 0, totalTrees = 0;
      plotEntries.forEach(function(e) { totalHours += (e.hours || 0); totalTrees += (e.trees_completed || 0); });

      html += '<div style="display:flex;gap:8px;margin-bottom:14px;">';
      html += '<div style="flex:1;background:var(--g6);padding:10px;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--text-muted);">' + t('רשומות') + '</div><div style="font-size:1.1rem;font-weight:700;color:var(--g1);">' + plotEntries.length + '</div></div>';
      html += '<div style="flex:1;background:var(--g6);padding:10px;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--text-muted);">' + t('שעות') + '</div><div style="font-size:1.1rem;font-weight:700;color:var(--g1);">' + totalHours.toFixed(1) + '</div></div>';
      if (totalTrees > 0) {
        html += '<div style="flex:1;background:#e8f5e9;padding:10px;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--text-muted);">🌴</div><div style="font-size:1.1rem;font-weight:700;color:var(--g1);">' + totalTrees + '</div></div>';
        var avgProd = totalHours > 0 ? (totalTrees / totalHours).toFixed(1) : '—';
        html += '<div style="flex:1;background:#fff8e1;padding:10px;border-radius:10px;text-align:center;"><div style="font-size:0.65rem;color:var(--text-muted);">⚡/' + t('שעה') + '</div><div style="font-size:1.1rem;font-weight:700;color:#e65100;">' + avgProd + '</div></div>';
      }
      html += '</div>';

      // Full entry list
      plotEntries.forEach(function(entry) {
        html += '<div style="padding:10px;background:var(--card);border-radius:10px;margin-bottom:8px;box-shadow:var(--shadow);border-right:3px solid ' + getTypeColor(entry.type) + ';">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
        html += '<span class="wl-type-badge ' + entry.type + '" style="font-size:0.75rem;">' + t(WL_TYPES[entry.type] || entry.type) + '</span>';
        html += '<span style="font-size:0.78rem;color:var(--text-muted);">' + entry.date + '</span>';
        html += '</div>';
        html += '<div style="font-size:0.88rem;font-weight:500;margin-bottom:4px;">' + (entry.description || '') + '</div>';
        html += '<div style="font-size:0.75rem;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap;">';
        if (entry.hours) html += '<span>⏱ ' + entry.hours + ' ' + t('שעות') + '</span>';
        if (entry.worker_count > 1) html += '<span>👥 ' + entry.worker_count + '</span>';
        if (entry.trees_completed) html += '<span>🌴 ' + entry.trees_completed + '</span>';
        if (entry.workers) html += '<span>👷 ' + entry.workers + '</span>';
        html += '<span>👤 ' + entry.operator + '</span>';
        html += '</div>';
        if (entry.trees_completed && entry.hours) {
          html += '<div style="font-size:0.72rem;color:var(--g2);margin-top:4px;font-weight:600;">⚡ ' + (entry.trees_completed / entry.hours).toFixed(1) + ' ' + t('עצים/שעה');
          if (entry.worker_count > 1) html += ' • ' + (entry.trees_completed / (entry.hours * entry.worker_count)).toFixed(1) + ' ' + t('עצים/עובד×שעה');
          html += '</div>';
        }
        if (entry.notes) html += '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:4px;font-style:italic;">📝 ' + entry.notes + '</div>';
        html += '</div>';
      });
    }

    html += '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'" style="width:100%;margin-top:12px;padding:10px;border-radius:10px;border:none;background:#eee;font-family:inherit;cursor:pointer;">' + t('סגור') + '</button>';
    html += '</div></div>';
    modal.innerHTML = html;
  };

  // ── Worklog Chart ──
  var CHART_COLORS = ['#2e7d32','#1565c0','#c62828','#6a1b9a','#ef6c00','#00838f','#ad1457','#4e342e','#455a64','#ff6f00'];
  
  function renderWorklogChart(mode) {
    var farmId = parseInt(document.getElementById('wlFarmSelect').value);
    var filtered = worklogEntries.filter(function(e) {
      return !farmId || e.farm_id === farmId;
    });
    
    if (filtered.length === 0) {
      document.getElementById('wlChart').innerHTML = '';
      document.getElementById('wlChartLegend').innerHTML = '';
      return;
    }
    
    // Aggregate data based on mode
    var groups = {};
    filtered.forEach(function(entry) {
      var key, label, color;
      if (mode === 'type') {
        key = entry.type;
        label = t(WL_TYPES[entry.type] || entry.type);
        color = getTypeColor(entry.type);
      } else if (mode === 'worker') {
        var names = entry.workers ? entry.workers.split(',').map(function(s) { return s.trim(); }) : [entry.operator];
        names.forEach(function(name) {
          if (!name) return;
          if (!groups[name]) groups[name] = { label: name, hours: 0, count: 0, totalWorkers: 0, trees: 0 };
          groups[name].hours += (entry.hours || 0);
          groups[name].count += 1;
          groups[name].totalWorkers += (entry.worker_count || 1);
          groups[name].trees += (entry.trees_completed || 0);
        });
        return;
      } else if (mode === 'plot') {
        key = entry.plot_id || 'none';
        label = entry.plot_name || t('כל החלקות');
        color = null;
      }
      
      if (mode !== 'worker') {
        if (!groups[key]) groups[key] = { label: label, color: color, hours: 0, count: 0, totalWorkers: 0, trees: 0 };
        groups[key].hours += (entry.hours || 0);
        groups[key].count += 1;
        groups[key].totalWorkers += (entry.worker_count || 1);
        groups[key].trees += (entry.trees_completed || 0);
      }
    });
    
    var items = Object.keys(groups).map(function(key, idx) {
      var g = groups[key];
      var totalManHours = g.hours > 0 && g.count > 0 ? g.hours * (g.totalWorkers / g.count) : 0;
      return {
        key: key,
        label: g.label,
        color: g.color || CHART_COLORS[idx % CHART_COLORS.length],
        hours: g.hours,
        count: g.count,
        totalWorkers: g.totalWorkers,
        trees: g.trees,
        treesPerHour: g.hours > 0 ? (g.trees / g.hours) : 0,
        treesPerWorkerHour: totalManHours > 0 ? (g.trees / totalManHours) : 0
      };
    }).sort(function(a, b) { return b.trees > 0 && a.trees > 0 ? b.treesPerWorkerHour - a.treesPerWorkerHour : b.hours - a.hours; });
    
    // Use trees as the bar metric if available, otherwise hours
    var hasTrees = items.some(function(i) { return i.trees > 0; });
    var maxVal = hasTrees 
      ? (Math.max.apply(null, items.map(function(i) { return i.treesPerWorkerHour; })) || 1)
      : (Math.max.apply(null, items.map(function(i) { return i.hours; })) || 1);
    
    var html = '';
    items.forEach(function(item) {
      var barVal = hasTrees ? item.treesPerWorkerHour : item.hours;
      var pct = Math.round((barVal / maxVal) * 100);
      
      var statsText = '';
      if (item.trees > 0) {
        statsText = item.trees + ' ' + t('עצים') + ' • ' + item.treesPerWorkerHour.toFixed(1) + ' ' + t('עצים/עובד×שעה');
      } else {
        statsText = item.hours.toFixed(1) + ' ' + t('שעות') + ' • ' + item.count + ' ' + t('רשומות');
      }
      
      html += '<div style="margin-bottom: 10px;">' +
        '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 3px;">' +
          '<span style="font-size: 0.82rem; font-weight: 600; color: var(--text);">' + item.label + '</span>' +
          '<span style="font-size: 0.72rem; color: var(--text-muted);">' + statsText + '</span>' +
        '</div>' +
        '<div style="height: 22px; background: var(--g6); border-radius: 6px; overflow: hidden; position: relative;">' +
          '<div style="height: 100%; width: ' + pct + '%; background: ' + item.color + '; border-radius: 6px; transition: width 0.4s;"></div>' +
        '</div>' +
      '</div>';
    });
    
    document.getElementById('wlChart').innerHTML = html;
    
    // Summary
    var totalHours = items.reduce(function(s, i) { return s + i.hours; }, 0);
    var totalTrees = items.reduce(function(s, i) { return s + i.trees; }, 0);
    var totalEntries = items.reduce(function(s, i) { return s + i.count; }, 0);
    var summaryParts = [t('שעות עבודה כולל') + ': <strong>' + totalHours.toFixed(1) + '</strong>'];
    if (totalTrees > 0) summaryParts.push(totalTrees + ' ' + t('עצים'));
    summaryParts.push(totalEntries + ' ' + t('רשומות'));
    document.getElementById('wlChartLegend').innerHTML = summaryParts.join(' • ');
    
    // Update filter button states
    document.querySelectorAll('.wl-chart-filter').forEach(function(btn) {
      btn.classList.toggle('active', btn.getAttribute('data-chart-mode') === mode);
      btn.style.background = btn.classList.contains('active') ? 'var(--g2)' : 'var(--g5)';
      btn.style.color = btn.classList.contains('active') ? 'white' : 'var(--g1)';
      // Translate button text
      var m = btn.getAttribute('data-chart-mode');
      if (m === 'type') btn.textContent = t('סוג עבודה');
      else if (m === 'worker') btn.textContent = t('לפי עובד');
      else if (m === 'plot') btn.textContent = t('לפי חלקה');
    });
  }
  
  // Chart filter clicks
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('.wl-chart-filter');
    if (btn) {
      renderWorklogChart(btn.getAttribute('data-chart-mode'));
    }
  });

  // ══════════════════════════════════
  // ── GOOGLE SHEETS API LAYER ──
  // ══════════════════════════════════
  //
  // Architecture:
  // The app communicates with Google Sheets via a Google Apps Script Web App.
  // The admin sets a Sheet ID per farm. The web app URL is stored globally.
  // 
  // To connect:
  // 1. Admin creates a Google Sheet per farm
  // 2. Admin deploys a Google Apps Script as a web app (doPost/doGet)
  // 3. Admin sets the Apps Script URL below
  // 4. Each user sets their email in the profile tab
  // 5. The app sends entries via fetch() POST to the Apps Script
  // 6. The app reads sheet data via fetch() GET from the Apps Script
  //
  // Apps Script template (to be deployed separately):
  // - doPost(e): receives JSON {sheetId, email, row: [...]} → appends row
  // - doGet(e): receives ?sheetId=xxx&email=yyy → returns JSON {headers:[...], rows:[[...]]}
  
  // Global config — admin sets this in a future settings panel
  var APPS_SCRIPT_URL = localStorage.getItem('shorashim-apps-script-url') || '';
  
  function getAppsScriptUrl() {
    return APPS_SCRIPT_URL || localStorage.getItem('shorashim-apps-script-url') || '';
  }
  
  function sendToGoogleSheet(farm, entry) {
    var url = getAppsScriptUrl();
    if (!url) {
      showToast('❌ ' + t('לא הוגדר כתובת Apps Script'));
      return Promise.resolve(false);
    }
    
    // Match sheet columns: תאריך, יום בשבוע, חלקה, סעיף תקציבי, פעולה, לאום העובד, עובדים, שעות יומית
    // Date format: DD/MM/YYYY to match the sheet
    var dateParts = entry.date.split('-'); // YYYY-MM-DD
    var formattedDate = dateParts[2] + '/' + dateParts[1] + '/' + dateParts[0];
    
    var rowData = {
      date: formattedDate,
      plot: entry.plot_name || '',
      budget_category: entry.budget_category || '',
      action: entry.type || '',
      worker_group: entry.worker_group || '',
      worker_count: entry.worker_count || 1,
      hours: entry.hours || ''
    };
    
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        action: 'updateByDate',
        sheetId: farm.google_sheet_id,
        email: currentUser.email,
        rowData: rowData
      })
    }).then(function(response) {
      return response.json();
    }).then(function(data) {
      return data && data.success === true;
    }).catch(function(err) {
      console.error('Sheet send error:', err);
      return false;
    });
  }
  
  function fetchSheetData(farm) {
    var url = getAppsScriptUrl();
    if (!url || !farm.google_sheet_id) {
      document.getElementById('wlSheetSection').style.display = 'none';
      return;
    }
    
    var tableEl = document.getElementById('wlSheetTable');
    var loadingEl = document.getElementById('wlSheetLoading');
    var emptyEl = document.getElementById('wlSheetEmpty');
    
    tableEl.innerHTML = '';
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    
    var fetchUrl = url + '?action=read&sheetId=' + encodeURIComponent(farm.google_sheet_id) + '&email=' + encodeURIComponent(currentUser.email || '');
    
    fetch(fetchUrl)
      .then(function(response) { return response.json(); })
      .then(function(data) {
        loadingEl.style.display = 'none';
        
        if (!data || !data.rows || data.rows.length === 0) {
          emptyEl.style.display = 'block';
          return;
        }
        
        renderSheetTable(data.headers || [], data.rows);
      })
      .catch(function(err) {
        loadingEl.style.display = 'none';
        tableEl.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--danger); font-size: 0.85rem;">❌ ' + t('שגיאה בטעינת נתונים') + '</div>';
        console.error('Sheet fetch error:', err);
      });
  }
  
  function renderSheetTable(headers, rows) {
    var tableEl = document.getElementById('wlSheetTable');
    
    if (rows.length === 0) {
      document.getElementById('wlSheetEmpty').style.display = 'block';
      return;
    }
    
    var html = '<table class="sheet-table"><thead><tr>';
    
    // Use headers if provided, otherwise use first row as header
    var headerRow = headers.length > 0 ? headers : rows[0];
    var dataRows = headers.length > 0 ? rows : rows.slice(1);
    
    headerRow.forEach(function(h) {
      html += '<th>' + (h || '') + '</th>';
    });
    html += '</tr></thead><tbody>';
    
    // Show last 30 rows, reversed (newest first)
    var displayRows = dataRows.slice(-30).reverse();
    displayRows.forEach(function(row) {
      html += '<tr>';
      for (var i = 0; i < headerRow.length; i++) {
        var cell = (row[i] !== undefined && row[i] !== null) ? row[i] : '';
        html += '<td>' + cell + '</td>';
      }
      html += '</tr>';
    });
    
    html += '</tbody></table>';
    html += '<div style="font-size: 0.7rem; color: var(--text-muted); text-align: center; margin-top: 8px;">' + dataRows.length + ' ' + t('שורות בגיליון') + ' (' + t('מציג 30 אחרונות') + ')</div>';
    
    tableEl.innerHTML = html;
  }
  
  // Refresh sheet button
  document.getElementById('wlRefreshSheet').addEventListener('click', function() {
    var farmId = parseInt(document.getElementById('wlFarmSelect').value);
    var farm = farms.find(function(f) { return f.id === farmId; });
    if (farm) {
      fetchSheetData(farm);
      showToast('🔄 ' + t('מרענן') + '...');
    }
  });
  
  // ── Farm Details Modal ──
  function showFarmDetails(farmId) {
    var farm = farms.find(function(f) { return f.id === farmId; });
    if (!farm) return;
    
    var farmPlots = plots.filter(function(p) { return p.farm_id === farm.id; });
    var totalArea = farmPlots.reduce(function(sum, p) { return sum + (p.area || 0); }, 0);
    var irr = farm.irrigation || {};
    var deliveries = farm.deliveries || [];
    var equipment = farm.equipment || [];
    var isAdmin = currentUser && currentUser.role === 'admin';
    
    // ── Recent worklog for this farm ──
    var farmWorklog = worklogEntries.filter(function(e) { return e.farm_id === farmId; })
      .sort(function(a, b) { return b.date > a.date ? 1 : -1; });
    
    // ── Dashboard matrix: 2x3 grid ──
    var totalTrees = farmWorklog.reduce(function(s, e) { return s + (e.trees_completed || 0); }, 0);
    var totalHours = farmWorklog.reduce(function(s, e) { return s + (e.hours || 0); }, 0);
    var totalEntries = farmWorklog.length;
    var avgProductivity = totalHours > 0 && totalTrees > 0 ? (totalTrees / totalHours).toFixed(1) : '—';
    
    var matrixHtml = '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px;">' +
      '<div style="background: var(--g6); padding: 10px 6px; border-radius: 10px; text-align: center;">' +
        '<div style="font-size: 0.65rem; color: var(--text-muted);">' + t('חלקות') + '</div>' +
        '<div style="font-size: 1.1rem; font-weight: 700; color: var(--g1);">' + farmPlots.length + '</div>' +
      '</div>' +
      '<div style="background: var(--g6); padding: 10px 6px; border-radius: 10px; text-align: center;">' +
        '<div style="font-size: 0.65rem; color: var(--text-muted);">' + t('שטח כולל') + '</div>' +
        '<div style="font-size: 1.1rem; font-weight: 700; color: var(--g1);">' + totalArea.toFixed(1) + '</div>' +
      '</div>' +
      '<div style="background: #e3f2fd; padding: 10px 6px; border-radius: 10px; text-align: center;">' +
        '<div style="font-size: 0.65rem; color: var(--water);">' + t('קוב לדונם/פתיחה') + '</div>' +
        '<div style="font-size: 1.1rem; font-weight: 700; color: var(--water);">' + (irr.cube_per_dunam || '—') + '</div>' +
      '</div>' +
      '<div style="background: var(--accent-light); padding: 10px 6px; border-radius: 10px; text-align: center;">' +
        '<div style="font-size: 0.65rem; color: var(--accent);">' + t('רשומות') + '</div>' +
        '<div style="font-size: 1.1rem; font-weight: 700; color: var(--accent);">' + totalEntries + '</div>' +
      '</div>' +
      '<div style="background: #f3e5f5; padding: 10px 6px; border-radius: 10px; text-align: center;">' +
        '<div style="font-size: 0.65rem; color: #6a1b9a;">' + t('עצים') + '</div>' +
        '<div style="font-size: 1.1rem; font-weight: 700; color: #6a1b9a;">' + totalTrees + '</div>' +
      '</div>' +
      '<div style="background: #e8f5e9; padding: 10px 6px; border-radius: 10px; text-align: center;">' +
        '<div style="font-size: 0.65rem; color: var(--g1);">' + t('עצים/שעה') + '</div>' +
        '<div style="font-size: 1.1rem; font-weight: 700; color: var(--g1);">' + avgProductivity + '</div>' +
      '</div>' +
    '</div>';
    
    // ── Equipment & Vehicles ──
    var equipHtml = '';
    if (equipment.length === 0) {
      equipHtml = '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('לא הוגדר') + '</div>';
    } else {
      equipHtml = '<div style="display: flex; flex-wrap: wrap; gap: 6px;">';
      equipment.forEach(function(item) {
        var icon = item.type === 'vehicle' ? '🚜' : item.type === 'sprayer' ? '💨' : '🔧';
        equipHtml += '<span style="display: inline-flex; align-items: center; gap: 4px; padding: 5px 10px; background: var(--g6); border-radius: 8px; font-size: 0.78rem; font-weight: 500;">' +
          icon + ' ' + locName(item) +
          (item.status === 'broken' ? ' <span style="color: var(--danger);">⛔</span>' : '') +
        '</span>';
      });
      equipHtml += '</div>';
    }
    
    // ── Plots list ──
    var plotsHtml = '';
    if (farmPlots.length === 0) {
      plotsHtml = '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('אין חלקות זמינות') + '</div>';
    } else {
      farmPlots.forEach(function(p) {
        var isPrimary = currentUser && currentUser.primary_plot_id === p.id;
        plotsHtml += '<div class="farm-detail-plot" data-fd-plot-id="' + p.id + '" style="padding: 10px; background: var(--g6); border-radius: 8px; margin-bottom: 6px; cursor: pointer; display: flex; align-items: center; gap: 10px; border-right: 3px solid ' + p.color + ';">' +
          '<div style="flex: 1;">' +
            '<div style="font-weight: 600; font-size: 0.9rem;">' + (isPrimary ? '⭐ ' : '') + p.name + '</div>' +
            '<div style="font-size: 0.75rem; color: var(--text-muted);">' + formatArea(p.area) + '</div>' +
          '</div>' +
          '<button type="button" class="fd-plot-map" data-fd-map-plot="' + p.id + '" ' +
            'title="' + t('מעבר לחלקה במפה') + '">🗺️</button>' +
          '<span style="color: var(--text-muted);">←</span>' +
        '</div>';
      });
    }
    
    // ── Pesticide inventory ──
    var pestHtml = '';
    var farmPestInventory = farm.pesticide_inventory || [];
    if (farmPestInventory.length === 0) {
      pestHtml = '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('לא הוגדר מלאי') + '</div>';
    } else {
      farmPestInventory.forEach(function(item) {
        var pest = pesticides.find(function(p) { return p.id === item.pesticide_id; });
        var name = pest ? pest.productName : '#' + item.pesticide_id;
        var pct = item.max_quantity > 0 ? Math.round((item.quantity / item.max_quantity) * 100) : 0;
        var barColor = pct > 50 ? 'var(--g3)' : pct > 20 ? 'var(--accent)' : 'var(--danger)';
        pestHtml += '<div style="padding: 6px 0; border-bottom: 1px solid var(--g6);">' +
          '<div style="display: flex; justify-content: space-between; margin-bottom: 3px;">' +
            '<span style="font-weight: 600; font-size: 0.82rem;">' + name + '</span>' +
            '<span style="font-size: 0.78rem; color: var(--text-muted);">' + item.quantity + ' ' + (item.unit || t('ליטר')) + '</span>' +
          '</div>' +
          '<div style="height: 5px; background: var(--g6); border-radius: 3px; overflow: hidden;">' +
            '<div style="height: 100%; width: ' + pct + '%; background: ' + barColor + '; border-radius: 3px;"></div>' +
          '</div>' +
        '</div>';
      });
    }
    
    // ── Recent activities (last 5 worklog entries) ──
    var activitiesHtml = '';
    if (farmWorklog.length === 0) {
      activitiesHtml = '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('אין רשומות') + '</div>';
    } else {
      farmWorklog.slice(0, 5).forEach(function(entry) {
        activitiesHtml += '<div style="padding: 8px; background: var(--g6); border-radius: 8px; margin-bottom: 5px; border-right: 3px solid ' + getTypeColor(entry.type) + ';">' +
          '<div style="display: flex; justify-content: space-between; align-items: center;">' +
            '<span class="wl-type-badge ' + entry.type + '" style="font-size: 0.68rem;">' + t(WL_TYPES[entry.type] || entry.type) + '</span>' +
            '<span style="font-size: 0.7rem; color: var(--text-muted);">' + entry.date + '</span>' +
          '</div>' +
          '<div style="font-size: 0.8rem; margin-top: 3px;">' + entry.description + '</div>' +
          (entry.trees_completed ? '<div style="font-size: 0.7rem; color: var(--g2); margin-top: 2px;">🌴 ' + entry.trees_completed + ' ' + t('עצים') + (entry.hours ? ' • ⏱ ' + entry.hours + 'h' : '') + '</div>' : '') +
        '</div>';
      });
    }
    
    // ── Delivery notes ──
    var deliveryHtml = '';
    if (deliveries.length === 0) {
      deliveryHtml = '<div style="padding: 8px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('אין תעודות משלוח') + '</div>';
    } else {
      deliveries.slice(0, 5).forEach(function(d) {
        deliveryHtml += '<div style="padding: 8px; background: var(--g6); border-radius: 8px; margin-bottom: 5px;">' +
          '<div style="display: flex; justify-content: space-between;">' +
            '<span style="font-weight: 600; font-size: 0.82rem;">' + d.description + '</span>' +
            '<span style="font-size: 0.72rem; color: var(--text-muted);">' + d.date + '</span>' +
          '</div>' +
          (d.supplier ? '<div style="font-size: 0.72rem; color: var(--text-muted);">' + t('ספק') + ': ' + d.supplier + '</div>' : '') +
        '</div>';
      });
    }
    
    // ── Admin buttons ──
    var adminButtons = '';
    if (isAdmin) {
      adminButtons = '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 16px;">' +
        '<button class="btn-admin" id="fdEditIrrigation">💧 ' + t('השקייה') + '</button>' +
        '<button class="btn-admin" id="fdAddDelivery">📦 ' + t('משלוח') + '</button>' +
        '<button class="btn-admin" id="fdEditInventory">🧪 ' + t('מלאי') + '</button>' +
        '<button class="btn-admin" id="fdEditEquipment">🚜 ' + t('ציוד') + '</button>' +
        '<button class="btn-admin" id="fdVehicles">🚛 ' + t('רכבים') + '</button>' +
      '</div>';
    }
    
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 520px;">' +
          '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">' +
            '<div style="width: 20px; height: 20px; border-radius: 50%; background: ' + farm.color + '; flex-shrink: 0;"></div>' +
            '<h2 style="margin: 0;">' + locName(farm) + '</h2>' +
          '</div>' +
          
          matrixHtml +
          
          '<div class="section-title" style="margin-top: 4px;">🚜 ' + t('ציוד ורכבים') + '</div>' +
          equipHtml +
          
          '<div class="section-title" style="margin-top: 14px;">📋 ' + t('פעולות אחרונות') + '</div>' +
          activitiesHtml +
          
          '<div class="section-title" style="margin-top: 14px;">🌳 ' + t('חלקות') + '</div>' +
          plotsHtml +
          
          '<div class="section-title" style="margin-top: 14px;">🧪 ' + t('מלאי חומרי הדברה') + '</div>' +
          pestHtml +
          
          '<div class="section-title" style="margin-top: 14px;">📦 ' + t('תעודות משלוח אחרונות') + '</div>' +
          deliveryHtml +
          
          '<div class="section-title" style="margin-top: 14px;">📸 ' + t('תעודות / חשבוניות') + '</div>' +
          renderReceiptGallery(farm.id) +
          
          adminButtons +
          
          '<div class="modal-buttons" style="margin-top: 16px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('סגור') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    // Receipt click handlers
    container.querySelectorAll('.receipt-thumb').forEach(function(el) {
      el.addEventListener('click', function() {
        showReceiptFullView(parseInt(this.getAttribute('data-receipt-id')));
      });
    });
    
    // Plot click handlers
    container.querySelectorAll('.farm-detail-plot').forEach(function(el) {
      el.addEventListener('click', function() {
        showPlotDetails(parseInt(this.getAttribute('data-fd-plot-id')));
      });
    });

    // Straight to the map, skipping the plot modal. stopPropagation keeps the
    // row's own click from firing and opening the modal behind it.
    container.querySelectorAll('.fd-plot-map').forEach(function(el) {
      el.addEventListener('click', function(e) {
        e.stopPropagation();
        window.goToPlotOnMap(parseInt(this.getAttribute('data-fd-map-plot')));
      });
    });
    
    // Admin handlers
    if (isAdmin) {
      if (document.getElementById('fdEditIrrigation')) {
        document.getElementById('fdEditIrrigation').addEventListener('click', function() { showIrrigationEditor(farm); });
      }
      if (document.getElementById('fdAddDelivery')) {
        document.getElementById('fdAddDelivery').addEventListener('click', function() { showDeliveryEditor(farm); });
      }
      if (document.getElementById('fdEditInventory')) {
        document.getElementById('fdEditInventory').addEventListener('click', function() { showInventoryEditor(farm); });
      }
      if (document.getElementById('fdEditEquipment')) {
        document.getElementById('fdEditEquipment').addEventListener('click', function() { showEquipmentEditor(farm); });
      }
      if (document.getElementById('fdVehicles')) {
        document.getElementById('fdVehicles').addEventListener('click', function() { showVehicleList(farm); });
      }
    }
  }
  
  // ── Equipment Editor (Admin) ──
  function showEquipmentEditor(farm) {
    var equipment = farm.equipment || [];
    var container = document.getElementById('modalContainer');
    
    var listHtml = '';
    equipment.forEach(function(item, idx) {
      listHtml += '<div style="display: flex; gap: 6px; align-items: center; margin-bottom: 8px;" data-equip-idx="' + idx + '">' +
        '<select class="form-input equip-type" style="flex: 0 0 90px; padding: 8px; font-size: 0.82rem;">' +
          '<option value="vehicle"' + (item.type === 'vehicle' ? ' selected' : '') + '>🚜 ' + t('רכב') + '</option>' +
          '<option value="sprayer"' + (item.type === 'sprayer' ? ' selected' : '') + '>💨 ' + t('מרסס') + '</option>' +
          '<option value="tool"' + (item.type === 'tool' ? ' selected' : '') + '>🔧 ' + t('כלי') + '</option>' +
        '</select>' +
        '<input type="text" class="form-input equip-name" value="' + item.name + '" style="flex: 1; padding: 8px; font-size: 0.82rem;">' +
        '<button class="btn-icon delete equip-remove" style="flex-shrink: 0;">✕</button>' +
      '</div>';
    });
    
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<h2>🚜 ' + t('ציוד ורכבים') + ' — ' + locName(farm) + '</h2>' +
          '<div id="equipList">' + listHtml + '</div>' +
          '<button class="btn-admin" id="equipAdd" style="width: 100%; margin-top: 8px;">➕ ' + t('הוסף') + '</button>' +
          '<div class="modal-buttons" style="margin-top: 14px;">' +
            '<button class="btn btn-primary" id="equipSave">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    // Add new row
    document.getElementById('equipAdd').addEventListener('click', function() {
      var list = document.getElementById('equipList');
      var idx = list.children.length;
      var row = document.createElement('div');
      row.style.cssText = 'display: flex; gap: 6px; align-items: center; margin-bottom: 8px;';
      row.setAttribute('data-equip-idx', idx);
      row.innerHTML = '<select class="form-input equip-type" style="flex: 0 0 90px; padding: 8px; font-size: 0.82rem;">' +
        '<option value="vehicle">🚜 ' + t('רכב') + '</option>' +
        '<option value="sprayer">💨 ' + t('מרסס') + '</option>' +
        '<option value="tool">🔧 ' + t('כלי') + '</option>' +
      '</select>' +
      '<input type="text" class="form-input equip-name" value="" placeholder="" style="flex: 1; padding: 8px; font-size: 0.82rem;">' +
      '<button class="btn-icon delete equip-remove" style="flex-shrink: 0;">✕</button>';
      list.appendChild(row);
    });
    
    // Remove row
    container.addEventListener('click', function(e) {
      if (e.target.classList.contains('equip-remove')) {
        e.target.closest('[data-equip-idx]').remove();
      }
    });
    
    // Save
    document.getElementById('equipSave').addEventListener('click', function() {
      var newEquipment = [];
      container.querySelectorAll('[data-equip-idx]').forEach(function(row) {
        var type = row.querySelector('.equip-type').value;
        var name = row.querySelector('.equip-name').value.trim();
        if (name) newEquipment.push({ type: type, name: name, status: 'active' });
      });
      farm.equipment = newEquipment;
      saveData();
      showToast('✅ ' + t('ציוד עודכן'));
      showFarmDetails(farm.id);
    });
  }
  
  // ── Vehicle Management ──
  function showVehicleList(farm) {
    var vehicles = farm.vehicles || [];
    var container = document.getElementById('modalContainer');
    
    var html = '';
    if (vehicles.length === 0) {
      html = '<div style="padding: 16px; text-align: center; color: var(--text-muted);">' + t('אין רכבים') + '</div>';
    } else {
      vehicles.forEach(function(v) {
        var insuranceOk = v.insurance_expiry && new Date(v.insurance_expiry) > new Date();
        var safetyOk = v.safety_expiry && new Date(v.safety_expiry) > new Date();
        
        html += '<div style="padding: 12px; background: var(--g6); border-radius: 10px; margin-bottom: 8px; cursor: pointer;" data-vehicle-id="' + v.id + '">' +
          '<div style="display: flex; gap: 10px; align-items: center;">' +
            (v.image ? '<img src="' + v.image + '" style="width: 50px; height: 50px; border-radius: 8px; object-fit: cover;">' : '<div style="width: 50px; height: 50px; border-radius: 8px; background: var(--g5); display: flex; align-items: center; justify-content: center; font-size: 1.5rem;">🚜</div>') +
            '<div style="flex: 1;">' +
              '<div style="font-weight: 700; font-size: 0.9rem;">' + v.name + '</div>' +
              '<div style="font-size: 0.75rem; color: var(--text-muted);">' +
                (v.plate ? '🔢 ' + v.plate + ' • ' : '') +
                (v.year ? v.year + ' • ' : '') +
                (v.owner || '') +
              '</div>' +
              '<div style="font-size: 0.7rem; margin-top: 3px;">' +
                '<span style="color: ' + (insuranceOk ? 'var(--g3)' : 'var(--danger)') + ';">' + (insuranceOk ? '✅' : '⛔') + ' ' + t('ביטוח') + '</span> ' +
                '<span style="color: ' + (safetyOk ? 'var(--g3)' : 'var(--danger)') + ';">' + (safetyOk ? '✅' : '⛔') + ' ' + t('בטיחות') + '</span>' +
              '</div>' +
            '</div>' +
            '<span style="color: var(--text-muted);">←</span>' +
          '</div>' +
        '</div>';
      });
    }
    
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<h2>🚛 ' + t('רכבים') + ' — ' + locName(farm) + '</h2>' +
          html +
          (currentUser && currentUser.role === 'admin' ? '<button class="btn-admin" id="addVehicleBtn" style="width: 100%; margin-top: 8px;">➕ ' + t('הוסף רכב') + '</button>' : '') +
          '<div class="modal-buttons" style="margin-top: 12px;">' +
            '<button class="btn btn-secondary" id="vListBack">' + t('חזור') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    // Back to farm details
    document.getElementById('vListBack').addEventListener('click', function() {
      showFarmDetails(farm.id);
    });
    
    // Click on vehicle card
    container.querySelectorAll('[data-vehicle-id]').forEach(function(el) {
      el.addEventListener('click', function() {
        var vId = parseInt(this.getAttribute('data-vehicle-id'));
        showVehicleEditor(farm, vId);
      });
    });
    
    var addBtn = document.getElementById('addVehicleBtn');
    if (addBtn) addBtn.addEventListener('click', function() { showVehicleEditor(farm, null); });
  }
  
  function showVehicleEditor(farm, vehicleId) {
    if (!farm.vehicles) farm.vehicles = [];
    var isEdit = vehicleId !== null;
    var v = isEdit ? farm.vehicles.find(function(x) { return x.id === vehicleId; }) : {};
    if (isEdit && !v) return;
    
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<h2>🚜 ' + (isEdit ? t('עריכת רכב') : t('רכב חדש')) + '</h2>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('שם / תיאור') + '</label>' +
            '<input type="text" class="form-input" id="vName" value="' + (v.name || '') + '">' +
          '</div>' +
          '<div style="display: flex; gap: 10px;">' +
            '<div class="form-group" style="flex: 1;">' +
              '<label class="form-label">' + t('מספר רכב') + '</label>' +
              '<input type="text" class="form-input" id="vPlate" value="' + (v.plate || '') + '" dir="ltr" style="text-align: left;">' +
            '</div>' +
            '<div class="form-group" style="flex: 1;">' +
              '<label class="form-label">' + t('שנת ייצור') + '</label>' +
              '<input type="number" class="form-input" id="vYear" value="' + (v.year || '') + '" min="1980" max="2030">' +
            '</div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('בעלות') + '</label>' +
            '<input type="text" class="form-input" id="vOwner" value="' + (v.owner || '') + '">' +
          '</div>' +
          '<div style="display: flex; gap: 10px;">' +
            '<div class="form-group" style="flex: 1;">' +
              '<label class="form-label">' + t('תוקף ביטוח') + '</label>' +
              '<input type="date" class="form-input" id="vInsurance" value="' + (v.insurance_expiry || '') + '">' +
            '</div>' +
            '<div class="form-group" style="flex: 1;">' +
              '<label class="form-label">' + t('תוקף בטיחות') + '</label>' +
              '<input type="date" class="form-input" id="vSafety" value="' + (v.safety_expiry || '') + '">' +
            '</div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('טיפול אחרון') + '</label>' +
            '<input type="text" class="form-input" id="vLastService" value="' + (v.last_service || '') + '">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('מיקום אחרון') + '</label>' +
            '<input type="text" class="form-input" id="vLocation" value="' + (v.location || '') + '">' +
          '</div>' +
          '<div id="vImagePreview" style="' + (v.image ? '' : 'display:none;') + ' margin-bottom: 12px;">' +
            '<img id="vImagePreviewImg" src="' + (v.image || '') + '" style="width: 100%; border-radius: 10px; max-height: 150px; object-fit: cover;">' +
          '</div>' +
          '<button class="btn-admin" id="vImageBtn" style="width: 100%; margin-bottom: 12px;">📷 ' + t('צלם / בחר תמונה') + '</button>' +
          '<input type="file" id="vImageInput" accept="image/*" capture="environment" style="display: none;">' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" id="vSave">' + t('שמור') + '</button>' +
            (isEdit ? '<button class="btn btn-secondary" id="vDelete" style="background: var(--danger-light); color: var(--danger);">🗑️</button>' : '') +
            '<button class="btn btn-secondary" id="vBack">' + t('חזור') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    var capturedImage = v.image || null;
    
    // Back button
    document.getElementById('vBack').addEventListener('click', function() {
      showVehicleList(farm);
    });
    
    document.getElementById('vImageBtn').addEventListener('click', function() {
      document.getElementById('vImageInput').click();
    });
    
    document.getElementById('vImageInput').addEventListener('change', function(e) {
      var file = e.target.files[0];
      if (!file) return;
      compressImage(file, 600, 0.6, function(dataUrl) {
        capturedImage = dataUrl;
        document.getElementById('vImagePreviewImg').src = dataUrl;
        document.getElementById('vImagePreview').style.display = 'block';
      });
    });
    
    document.getElementById('vSave').addEventListener('click', function() {
      var name = document.getElementById('vName').value.trim();
      if (!name) { showToast('❌ ' + t('שם ריק')); return; }
      
      var data = {
        id: isEdit ? v.id : Date.now(),
        name: name,
        plate: document.getElementById('vPlate').value.trim(),
        year: parseInt(document.getElementById('vYear').value) || null,
        owner: document.getElementById('vOwner').value.trim(),
        insurance_expiry: document.getElementById('vInsurance').value || null,
        safety_expiry: document.getElementById('vSafety').value || null,
        last_service: document.getElementById('vLastService').value.trim(),
        location: document.getElementById('vLocation').value.trim(),
        image: capturedImage
      };
      
      if (isEdit) {
        var idx = farm.vehicles.findIndex(function(x) { return x.id === v.id; });
        if (idx !== -1) farm.vehicles[idx] = data;
      } else {
        farm.vehicles.push(data);
      }
      
      saveData();
      showToast('✅ ' + t('רכב עודכן'));
      showVehicleList(farm);
    });
    
    var delBtn = document.getElementById('vDelete');
    if (delBtn) {
      delBtn.addEventListener('click', function() {
        farm.vehicles = farm.vehicles.filter(function(x) { return x.id !== v.id; });
        saveData();
        showToast('🗑️ ' + t('רכב נמחק'));
        showVehicleList(farm);
      });
    }
  }
  function showIrrigationEditor(farm) {
    var irr = farm.irrigation || {};
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal">' +
          '<h2>💧 ' + t('עדכן השקייה') + ' — ' + locName(farm) + '</h2>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('קוב לדונם/פתיחה') + '</label>' +
            '<input type="number" class="form-input" id="irrCube" value="' + (irr.cube_per_dunam || '') + '" step="0.1" min="0">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('ימי השקייה בשבוע') + '</label>' +
            '<input type="number" class="form-input" id="irrDays" value="' + (irr.days_per_week || '') + '" min="0" max="7">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('הערות') + '</label>' +
            '<textarea class="form-input" id="irrNotes" rows="2">' + (irr.notes || '') + '</textarea>' +
          '</div>' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" id="irrSave">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    document.getElementById('irrSave').addEventListener('click', function() {
      farm.irrigation = {
        cube_per_dunam: parseFloat(document.getElementById('irrCube').value) || null,
        days_per_week: parseInt(document.getElementById('irrDays').value) || null,
        notes: document.getElementById('irrNotes').value.trim() || null,
        last_updated: new Date().toLocaleDateString('he-IL')
      };
      saveData();
      showToast('✅ ' + t('נתוני השקייה עודכנו'));
      showFarmDetails(farm.id);
    });
  }
  
  // ── Delivery Note Editor (Admin) ──
  function showDeliveryEditor(farm) {
    var today = new Date().toISOString().split('T')[0];
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal">' +
          '<h2>📦 ' + t('הוסף ת. משלוח') + ' — ' + locName(farm) + '</h2>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('תאריך') + '</label>' +
            '<input type="date" class="form-input" id="delDate" value="' + today + '">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('תיאור') + '</label>' +
            '<input type="text" class="form-input" id="delDesc" placeholder="">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('ספק') + '</label>' +
            '<input type="text" class="form-input" id="delSupplier" placeholder="">' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('כמות') + '</label>' +
            '<input type="text" class="form-input" id="delQty" placeholder="">' +
          '</div>' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" id="delSave">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    document.getElementById('delSave').addEventListener('click', function() {
      var desc = document.getElementById('delDesc').value.trim();
      if (!desc) { showToast('❌ ' + t('חובה למלא תיאור')); return; }
      
      if (!farm.deliveries) farm.deliveries = [];
      farm.deliveries.unshift({
        id: Date.now(),
        date: document.getElementById('delDate').value,
        description: desc,
        supplier: document.getElementById('delSupplier').value.trim(),
        quantity: document.getElementById('delQty').value.trim()
      });
      saveData();
      showToast('✅ ' + t('תעודת משלוח נוספה'));
      showFarmDetails(farm.id);
    });
  }
  
  // ── Pesticide Inventory Editor (Admin) ──
  function showInventoryEditor(farm) {
    var inventory = farm.pesticide_inventory || [];
    
    var pestOptions = '';
    pesticides.forEach(function(p) {
      var existing = inventory.find(function(item) { return item.pesticide_id === p.id; });
      pestOptions += '<div style="padding: 10px; background: var(--g6); border-radius: 8px; margin-bottom: 8px;">' +
        '<div style="font-weight: 600; font-size: 0.9rem; margin-bottom: 8px;">' + p.productName + ' <span style="font-weight: 400; color: var(--text-muted);">(' + p.activeIngredient + ')</span></div>' +
        '<div style="display: flex; gap: 8px;">' +
          '<div style="flex: 1;">' +
            '<label style="font-size: 0.75rem; color: var(--text-muted);">' + t('כמות נוכחית') + '</label>' +
            '<input type="number" class="form-input inv-qty" data-pest-id="' + p.id + '" value="' + (existing ? existing.quantity : 0) + '" min="0" step="0.1" style="padding: 8px; font-size: 0.85rem;">' +
          '</div>' +
          '<div style="flex: 1;">' +
            '<label style="font-size: 0.75rem; color: var(--text-muted);">' + t('כמות מקסימלית') + '</label>' +
            '<input type="number" class="form-input inv-max" data-pest-id="' + p.id + '" value="' + (existing ? existing.max_quantity : 0) + '" min="0" step="0.1" style="padding: 8px; font-size: 0.85rem;">' +
          '</div>' +
        '</div>' +
      '</div>';
    });
    
    if (pesticides.length === 0) {
      pestOptions = '<div style="padding: 12px; text-align: center; color: var(--text-muted);">' + t('אין חומרים מוגדרים. הוסף בלשונית חומרים.') + '</div>';
    }
    
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<h2>🧪 ' + t('מלאי חומרי הדברה') + ' — ' + locName(farm) + '</h2>' +
          '<div style="max-height: 50vh; overflow-y: auto;">' + pestOptions + '</div>' +
          '<div class="modal-buttons">' +
            '<button class="btn btn-primary" id="invSave">' + t('שמור') + '</button>' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    document.getElementById('invSave').addEventListener('click', function() {
      var newInventory = [];
      container.querySelectorAll('.inv-qty').forEach(function(input) {
        var pestId = parseInt(input.getAttribute('data-pest-id'));
        var qty = parseFloat(input.value) || 0;
        var maxInput = container.querySelector('.inv-max[data-pest-id="' + pestId + '"]');
        var maxQty = maxInput ? (parseFloat(maxInput.value) || 0) : 0;
        if (qty > 0 || maxQty > 0) {
          newInventory.push({
            pesticide_id: pestId,
            quantity: qty,
            max_quantity: maxQty,
            unit: t('ליטר')
          });
        }
      });
      farm.pesticide_inventory = newInventory;
      saveData();
      showToast('✅ ' + t('מלאי חומרים עודכן'));
      showFarmDetails(farm.id);
    });
  }
  
  // ── Logout ──
  document.getElementById('logoutBtn').addEventListener('click', function() {
    if (confirm(t('להתנתק מהמערכת?'))) {
      if (typeof TimeClock !== 'undefined' && TimeClock.stopPresence) TimeClock.stopPresence();
      sessionStorage.removeItem('currentUser');
      currentUser = null;
      window.currentUser = null;
      if (typeof auth !== 'undefined') auth.signOut();
      document.getElementById('mainApp').style.display = 'none';
      document.getElementById('loginScreen').style.display = 'flex';
      document.getElementById('loginEmail').value = '';
      document.getElementById('loginPassword').value = '';
      document.getElementById('loginError').textContent = '';
    }
  });

  // ── Plot Details Modal ──
  // ══════════════════════════════════════════════════════════
  // ── RETROSPECTIVE PLOT EDITING ──
  // Everything that can be set while drawing a plot must stay
  // editable afterwards: tree count above all (trees get planted,
  // uprooted and replanted long after the polygon is fixed), plus
  // spacing, density and the registered area.
  // ══════════════════════════════════════════════════════════

  // Reads the numeric fields out of the plot-detail edit form and validates
  // them. Returns a {field: number} map on success, or null when something
  // is out of range (a toast has already been shown) so the caller can abort
  // before writing a half-updated plot.
  //
  // A blank box means "clear this value" (stored as 0) for spacing, density
  // and tree count — the manager needs a way to say "I no longer know", and
  // silently keeping the old number would make that impossible. Area is the
  // exception: blank means "leave as is", because a plot with no area breaks
  // formatArea() and every per-dunam calculation downstream.
  function readPlotNumericEdits(plot) {
    function num(id) {
      var el = document.getElementById(id);
      if (!el) return undefined;                       // field absent from form
      var raw = (el.value || '').trim();
      // 0, not null, for a cleared box: saveData() writes every numeric plot
      // field as `value || 0`, so 0 IS the stored representation of "unknown".
      if (raw === '') return 0;
      var v = parseFloat(raw);
      return isNaN(v) ? NaN : v;
    }
    function bad(v, min, max) {
      return v !== undefined && v !== 0 && (isNaN(v) || v < min || v > max);
    }

    var area   = num('pdEditArea');
    var rowSp  = num('pdEditRowSpacing');
    var treeSp = num('pdEditTreeSpacing');
    var ppd    = num('pdEditPlantsPerDunam');
    var count  = num('pdEditTreeCount');

    if (bad(area,   0.01, 100000)) { showToast('⚠️ ' + t('שטח לא תקין')); return null; }
    if (bad(rowSp,  0.5,  30))     { showToast('⚠️ ' + t('מרווח בין שורות לא תקין')); return null; }
    if (bad(treeSp, 0.5,  30))     { showToast('⚠️ ' + t('מרווח בין עצים לא תקין')); return null; }
    if (bad(ppd,    1,    100000)) { showToast('⚠️ ' + t('צמחים לדונם לא תקין')); return null; }
    if (bad(count,  0,    1000000)){ showToast('⚠️ ' + t('מספר עצים לא תקין')); return null; }

    var out = {};
    // Area: the form shows 2dp, so a plot stored as 12.3456 renders "12.35".
    // Treating that as an edit would quietly truncate precision on every
    // save, so anything within half a hundredth counts as untouched.
    if (area !== undefined) {
      if (area === 0 || (plot && plot.area != null && Math.abs(area - plot.area) < 0.005)) {
        out.area = (plot && plot.area != null) ? plot.area : 0;
      } else {
        out.area = Math.round(area * 100) / 100;
      }
    }
    if (rowSp  !== undefined) out.row_spacing      = rowSp;
    if (treeSp !== undefined) out.tree_spacing     = treeSp;
    if (ppd    !== undefined) out.plants_per_dunam = Math.round(ppd);
    if (count  !== undefined) out.tree_count       = Math.round(count);
    return out;
  }

  // Historical records snapshot the plot name at write time, so a rename
  // orphans every worklog entry and field report that came before it.
  // Matching is by plot id first — that link survives any rename. The name
  // comparison is only a fallback for legacy rows written before ids were
  // stored alongside the name.
  function _recordMatchesPlot(rec, plotId, oldName, idField, nameField) {
    if (!rec) return false;
    if (plotId != null && rec[idField] === plotId) return true;
    return (rec[idField] == null) && !!oldName && ((rec[nameField] || '') === oldName);
  }

  // Counts the affected history, then asks what to do with it. Calls done()
  // exactly once in every path — including "no history found" and "keep the
  // old name" — so the caller can treat it as a plain continuation.
  function promptPlotRenameHistory(plot, oldName, newName, done) {
    var wlMatches = (worklogEntries || []).filter(function(e) {
      return _recordMatchesPlot(e, plot.id, oldName, 'plot_id', 'plot_name');
    });

    var reportsP = (window.FieldReport && typeof window.FieldReport.countPlotRefs === 'function')
      ? window.FieldReport.countPlotRefs(plot.id, oldName)['catch'](function() { return 0; })
      : Promise.resolve(0);

    reportsP.then(function(reportCount) {
      if (wlMatches.length + reportCount === 0) { done(); return; }

      showPlotRenameCascadeModal(oldName, newName, wlMatches.length, reportCount, function(applyToHistory) {
        if (!applyToHistory) { done(); return; }

        // Worklog entries live in this module's own state — done() runs
        // saveData(), which persists them in the same write as the plot.
        wlMatches.forEach(function(e) { e.plot_name = newName; });

        var fp = (reportCount > 0 && window.FieldReport && typeof window.FieldReport.renamePlotRefs === 'function')
          ? window.FieldReport.renamePlotRefs(plot.id, oldName, newName)['catch'](function() { return 0; })
          : Promise.resolve(0);

        fp.then(function(n) {
          try {
            if (typeof Audit !== 'undefined' && Audit && typeof Audit.log === 'function') {
              Audit.log('edit', 'plot-rename', String(plot.id), {
                before: { name: oldName },
                after: { name: newName, worklogUpdated: wlMatches.length, reportsUpdated: n },
                reason: 'retrospective plot rename — history cascade'
              });
            }
          } catch (err) { /* audit is best-effort, never blocks the rename */ }
          showToast('🔄 ' + (wlMatches.length + n) + ' ' + t('רשומות היסטוריות עודכנו'));
          done();
        });
      });
    });
  }

  // Three-way choice, so it can't reuse #modalContainer (the plot-detail
  // modal is still sitting in there and must survive a cancel). Appended to
  // <body> at a higher z-index and removed by whichever button is pressed.
  function showPlotRenameCascadeModal(oldName, newName, wlCount, reportCount, cb) {
    // Plot names are free text typed by managers, and both names go straight
    // into innerHTML below — escape them so a name containing < or & renders
    // as characters instead of breaking (or injecting into) the markup.
    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    var host = document.createElement('div');
    host.className = 'modal-overlay';
    host.style.zIndex = '3000';
    var lines = '';
    if (wlCount > 0) {
      lines += '<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--g6, rgba(255,255,255,0.06));border-radius:8px;margin-bottom:6px;">' +
        '<span>📝 ' + t('רשומות ביומן עבודה') + '</span><strong>' + wlCount + '</strong></div>';
    }
    if (reportCount > 0) {
      lines += '<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--g6, rgba(255,255,255,0.06));border-radius:8px;margin-bottom:6px;">' +
        '<span>🔍 ' + t('דוחות שדה') + '</span><strong>' + reportCount + '</strong></div>';
    }
    host.innerHTML =
      '<div class="modal" style="max-width: 420px;">' +
        '<h2>✏️ ' + t('שינוי שם חלקה') + '</h2>' +
        '<p>' + t('נמצאו רשומות היסטוריות עם השם הישן') + '.</p>' +
        '<div style="display:flex;gap:8px;align-items:center;justify-content:center;margin-bottom:12px;font-size:0.9rem;font-weight:700;">' +
          '<span style="opacity:0.7;text-decoration:line-through;">' + esc(oldName) + '</span>' +
          '<span>←</span>' +
          '<span style="color:var(--g2, #4caf50);">' + esc(newName) + '</span>' +
        '</div>' +
        lines +
        '<div style="display:flex;flex-direction:column;gap:8px;margin-top:14px;">' +
          '<button class="btn btn-primary" id="pdRenameAll" style="margin:0;">🔄 ' + t('עדכן את כל ההיסטוריה') + ' (' + (wlCount + reportCount) + ')</button>' +
          '<button class="btn btn-secondary" id="pdRenameKeep" style="margin:0;">📌 ' + t('השאר את השם הישן בהיסטוריה') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(host);

    function close(choice) {
      if (host.parentNode) host.parentNode.removeChild(host);
      cb(choice);
    }
    host.querySelector('#pdRenameAll').addEventListener('click', function() { close(true); });
    host.querySelector('#pdRenameKeep').addEventListener('click', function() { close(false); });
    // Clicking the backdrop is the conservative choice: keep history as-is.
    host.addEventListener('click', function(e) { if (e.target === host) close(false); });
  }

  function showPlotDetails(plotId) {
    var plot = plots.find(function(p) { return p.id === plotId; });
    if (!plot) return;
    
    var farmName = '';
    var farm = farms.find(function(f) { return f.id === plot.farm_id; });
    if (farm) farmName = farm.name;
    
    var plotSprays = sprayEvents.filter(function(ev) {
      return ev.plotIds && ev.plotIds.indexOf(plot.id) !== -1;
    }).sort(function(a, b) { return b.date.localeCompare(a.date); });
    
    var sprayHistoryHtml = '';
    if (plotSprays.length === 0) {
      sprayHistoryHtml = '<div style="padding: 10px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('אין היסטוריית ריסוס') + '</div>';
    } else {
      plotSprays.slice(0, 5).forEach(function(ev) {
        var pestNames = ev.applications ? ev.applications.map(function(a) { return a.productName || a.name; }).join(', ') : '';
        sprayHistoryHtml += '<div style="padding: 8px; background: var(--g6); border-radius: 8px; margin-bottom: 6px;">' +
          '<div style="display: flex; justify-content: space-between;">' +
            '<span style="font-weight: 600; font-size: 0.85rem;">' + ev.date + '</span>' +
            '<span style="font-size: 0.72rem; color: var(--text-muted);">' + (ev.operatorName || '') + '</span>' +
          '</div>' +
          (pestNames ? '<div style="font-size: 0.78rem; color: var(--text-muted); margin-top: 3px;">' + pestNames + '</div>' : '') +
        '</div>';
      });
    }
    
    var isPrimary = currentUser && currentUser.primary_plot_id === plot.id;

    // Counts live in the panel headers so a collapsed section still tells you
    // whether it holds anything worth opening.
    var plotWorklogCount = (worklogEntries || []).filter(function(e) {
      return e.plot_id === plot.id;
    }).length;

    // Farm selector
    var farmOptions = '';
    farms.forEach(function(f) {
      farmOptions += '<option value="' + f.id + '"' + (f.id === plot.farm_id ? ' selected' : '') + '>' + locName(f) + '</option>';
    });
    if (!plot.farm_id) farmOptions = '<option value="" selected>—</option>' + farmOptions;
    
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<div style="display: flex; align-items: center; gap: 12px; margin-bottom: 14px;">' +
            '<div style="width: 16px; height: 16px; border-radius: 50%; background: ' + plot.color + '; border: 2px solid rgba(0,0,0,0.1);"></div>' +
            '<h2 style="margin: 0;">' + locName(plot) + '</h2>' +
          '</div>' +
          
          '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin-bottom: 14px;">' +
            '<div style="background: var(--g6); padding: 10px; border-radius: 10px; text-align: center;">' +
              '<div style="font-size: 0.65rem; color: var(--text-muted);">' + t('שטח') + '</div>' +
              '<div style="font-size: 1rem; font-weight: 700; color: var(--g1);">' + formatArea(plot.area) + '</div>' +
            '</div>' +
            '<div style="background: var(--g6); padding: 10px; border-radius: 10px; text-align: center;">' +
              '<div style="font-size: 0.65rem; color: var(--text-muted);">' + t('נקודות') + '</div>' +
              '<div style="font-size: 1rem; font-weight: 700; color: var(--g1);">' + plot.vertices + '</div>' +
            '</div>' +
            '<div style="background: ' + (plot.tree_count ? '#e8f5e9' : 'var(--g6)') + '; padding: 10px; border-radius: 10px; text-align: center;">' +
              '<div style="font-size: 0.65rem; color: var(--text-muted);">🌴 ' + t('עצים') + '</div>' +
              '<div style="font-size: 1rem; font-weight: 700; color: var(--g1);">' + (plot.tree_count || '—') + '</div>' +
              (plot.row_spacing && plot.tree_spacing ? '<div style="font-size: 0.6rem; color: var(--text-muted);">' + plot.row_spacing + '×' + plot.tree_spacing + '</div>' : '') +
            '</div>' +
          '</div>' +
          (plot.crop_type ? '<div style="background:#e8f5e9;border-radius:8px;padding:6px 12px;margin-bottom:14px;font-size:0.85rem;font-weight:600;text-align:center;">🌱 ' + plot.crop_type + '</div>' : '') +
          
          '<!-- Edit Section -->' +
          '<details class="pd-sec" data-pdsec="edit" open>' +
            '<summary>✏️ ' + t('עריכת חלקה') + '</summary>' +
            '<div class="pd-sec-body">' +
            // Boundary editing lives on the map, not in this form — the
            // shape is the thing being edited, so the form gets out of the way.
            '<button onclick="document.getElementById(\'modalContainer\').innerHTML=\'\';PlotEdit.open(' + plot.id + ')" ' +
              'style="width:100%;padding:9px;border:none;border-radius:9px;margin-bottom:10px;' +
              'background:var(--primary,#2d6a4f);color:#fff;font-family:inherit;font-weight:700;' +
              'cursor:pointer;font-size:0.85rem;">\u2b20 ' + t('ערוך גבולות על המפה') + '</button>' +
            '<div class="form-group" style="margin-bottom: 10px;">' +
              '<label class="form-label" style="font-size: 0.78rem;">' + t('שם החלקה') + '</label>' +
              '<input type="text" class="form-input" id="pdEditName" value="' + (plot.name || '') + '" style="font-size: 0.9rem;">' +
            '</div>' +
            '<details style="margin-bottom: 10px;">' +
              '<summary style="cursor:pointer;font-size:0.74rem;color:var(--text-muted,#666);padding:4px 0;">🌐 ' + t('תרגומים (אופציונלי)') + '</summary>' +
              '<div class="form-group" style="margin:6px 0;">' +
                '<label class="form-label" style="font-size: 0.72rem;">' + t('שם בתאית') + '</label>' +
                '<input type="text" class="form-input" id="pdEditNameTh" value="' + (plot.name_th || '') + '" style="font-size: 0.85rem;" dir="ltr">' +
              '</div>' +
              '<div class="form-group" style="margin:6px 0;">' +
                '<label class="form-label" style="font-size: 0.72rem;">' + t('שם בערבית') + '</label>' +
                '<input type="text" class="form-input" id="pdEditNameAr" value="' + (plot.name_ar || '') + '" style="font-size: 0.85rem;" dir="rtl">' +
              '</div>' +
            '</details>' +
            '<div class="form-group" style="margin-bottom: 10px;">' +
              '<label class="form-label" style="font-size: 0.78rem;">📍 ' + t('רדיוס גיאופנס לנוכחות') + ' <span style="color:var(--text-muted,#999);font-weight:400;font-size:0.7rem;">' + t('(מטר, ברירת מחדל 100)') + '</span></label>' +
              '<input type="number" class="form-input" id="pdEditGeofence" value="' + (plot.geofenceRadiusM != null ? plot.geofenceRadiusM : 100) + '" min="20" max="500" step="10" style="font-size: 0.9rem;">' +
            '</div>' +
            '<div class="form-group" style="margin-bottom: 10px;">' +
              '<label class="form-label" style="font-size: 0.78rem;">🌳 ' + t('מטע') + '</label>' +
              '<select class="form-input" id="pdEditFarm" style="cursor: pointer;">' + farmOptions + '</select>' +
            '</div>' +
            '<div class="form-group" style="margin-bottom: 10px;">' +
              '<label class="form-label" style="font-size: 0.78rem;">🌱 ' + t('סוג גידול') + '</label>' +
              '<select class="form-input" id="pdEditCrop" style="cursor: pointer;">' +
                '<option value="">' + t('בחר גידול') + '</option>' +
                (function() { var cropList = JSON.parse(localStorage.getItem('shorashim-crop-types') || '[]'); return cropList.map(function(c) { return '<option value="' + c + '"' + (plot.crop_type === c ? ' selected' : '') + '>' + c + '</option>'; }).join(''); })() +
              '</select>' +
            '</div>' +
            '<div style="border-top: 1px solid var(--g5, rgba(255,255,255,0.12)); margin: 12px 0 10px;"></div>' +
            '<div style="font-size: 0.78rem; font-weight: 700; color: var(--g1); margin-bottom: 8px;">🌴 ' + t('צפיפות ומספר עצים') + '</div>' +
            '<div style="display: flex; gap: 8px; margin-bottom: 10px;">' +
              '<div style="flex: 1;">' +
                '<label class="form-label" style="font-size: 0.72rem;">' + t('בין שורות') + ' (' + t('מ\'') + ')</label>' +
                '<input type="number" class="form-input" id="pdEditRowSpacing" value="' + (plot.row_spacing || '') + '" min="0.5" max="30" step="0.5" style="font-size: 0.88rem;">' +
              '</div>' +
              '<div style="flex: 1;">' +
                '<label class="form-label" style="font-size: 0.72rem;">' + t('בין עצים') + ' (' + t('מ\'') + ')</label>' +
                '<input type="number" class="form-input" id="pdEditTreeSpacing" value="' + (plot.tree_spacing || '') + '" min="0.5" max="30" step="0.5" style="font-size: 0.88rem;">' +
              '</div>' +
            '</div>' +
            '<div style="display: flex; gap: 8px; margin-bottom: 10px;">' +
              '<div style="flex: 1;">' +
                '<label class="form-label" style="font-size: 0.72rem;">' + t('צמחים לדונם') + '</label>' +
                '<input type="number" class="form-input" id="pdEditPlantsPerDunam" value="' + (plot.plants_per_dunam || '') + '" min="1" step="1" style="font-size: 0.88rem;">' +
              '</div>' +
              '<div style="flex: 1;">' +
                '<label class="form-label" style="font-size: 0.72rem;">📐 ' + t('שטח') + ' (' + t('דונם') + ')</label>' +
                '<input type="number" class="form-input" id="pdEditArea" value="' + (plot.area != null ? Number(plot.area).toFixed(2) : '') + '" min="0.01" step="0.01" style="font-size: 0.88rem;">' +
              '</div>' +
            '</div>' +
            '<div class="form-group" style="margin-bottom: 8px;">' +
              '<label class="form-label" style="font-size: 0.72rem;">🌴 ' + t('מספר עצים') + '</label>' +
              '<input type="number" class="form-input" id="pdEditTreeCount" value="' + (plot.tree_count || '') + '" min="0" step="1" style="font-size: 1.05rem; font-weight: 700; text-align: center;">' +
            '</div>' +
            '<div style="display: flex; gap: 6px; margin-bottom: 12px;">' +
              '<button class="btn-admin" id="pdCalcFromSpacing" style="flex: 1; font-size: 0.7rem; padding: 7px 4px;">📐 ' + t('חשב לפי מרווחים') + '</button>' +
              '<button class="btn-admin" id="pdCalcFromDensity" style="flex: 1; font-size: 0.7rem; padding: 7px 4px;">📊 ' + t('חשב לפי צמחים לדונם') + '</button>' +
              '<button class="btn-admin" id="pdRecalcArea" style="flex: 1; font-size: 0.7rem; padding: 7px 4px;">↺ ' + t('שטח מהמפה') + '</button>' +
            '</div>' +
            '<div style="display: flex; gap: 8px;">' +
              '<button class="btn-admin" id="pdSaveEdit" style="flex: 1;">💾 ' + t('שמור') + '</button>' +
              '<button class="btn-admin" id="pdRedrawPolygon" style="flex: 1; background: var(--water);">🔄 ' + t('צייר מחדש') + '</button>' +
            '</div>' +
            '</div>' +
          '</details>' +
          
          '<div style="display: flex; gap: 8px; margin-bottom: 14px;">' +
            '<button class="btn-submit" id="plotDetailNav" style="flex: 1; margin: 0; font-size: 0.85rem;">🗺️ ' + t('מעבר לחלקה במפה') + '</button>' +
            '<button class="btn-submit" id="plotDetailPrimary" style="flex: 1; margin: 0; font-size: 0.85rem; background: ' + (isPrimary ? 'linear-gradient(135deg, var(--accent), #ff8f00)' : 'linear-gradient(135deg, #455a64, #607d8b)') + ';">' +
              (isPrimary ? '⭐' : '📍') +
            '</button>' +
          '</div>' +
          
          '<details class="pd-sec" data-pdsec="irrigation">' +
            '<summary>💧 ' + t('השקיה') + '</summary>' +
            '<div class="pd-sec-body">' + getPlotIrrigationHtml(plot.id) + '</div>' +
          '</details>' +

          '<details class="pd-sec" data-pdsec="worklog">' +
            '<summary>📝 ' + t('יומן עבודה') +
              (plotWorklogCount ? '<span class="pd-sec-count">' + plotWorklogCount + '</span>' : '') +
            '</summary>' +
            '<div class="pd-sec-body">' + getPlotWorklogSummary(plot.id, plot.name) + '</div>' +
          '</details>' +

          '<details class="pd-sec" data-pdsec="spray">' +
            '<summary>📋 ' + t('היסטוריית ריסוס') +
              (plotSprays.length ? '<span class="pd-sec-count">' + plotSprays.length + '</span>' : '') +
            '</summary>' +
            '<div class="pd-sec-body">' + sprayHistoryHtml + '</div>' +
          '</details>' +
          
          '<div class="modal-buttons" style="margin-top: 14px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('סגור') + '</button>' +
            '<button class="btn" id="pdDeletePlot" style="background:#f44336;color:white;">🗑️ ' + t('מחק חלקה') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    
    // ── Collapsible panels ──
    // The modal outgrew a phone screen once every agronomic field became
    // editable. Each panel remembers its own state in localStorage (not
    // Firestore — this is a per-device viewing preference, not shared data),
    // so a manager who lives in the edit form doesn't re-collapse the same
    // three history panels on every single plot they open.
    (function() {
      var PREF_KEY = 'shorashim-plot-sections';
      var prefs = {};
      try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || '{}') || {}; } catch (e) { prefs = {}; }
      container.querySelectorAll('details[data-pdsec]').forEach(function(d) {
        var key = d.getAttribute('data-pdsec');
        // Apply the stored state BEFORE listening: assigning .open fires a
        // toggle event, and listening first would rewrite the pref with the
        // value we just read.
        if (prefs[key] !== undefined) d.open = !!prefs[key];
        d.addEventListener('toggle', function() {
          prefs[key] = d.open;
          try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
        });
      });
    })();

    // Delete plot
    var pdDelBtn = document.getElementById('pdDeletePlot');
    if (pdDelBtn) {
      pdDelBtn.addEventListener('click', function() {
        // Permission check
        if (currentUser && currentUser.role !== 'admin') {
          var userFarmIds = (currentUser.farm_permissions || []);
          if (userFarmIds.length > 0 && userFarmIds.indexOf(plot.farm_id) === -1) {
            showToast(t('⛔ אין לך הרשאה למחוק חלקה זו'));
            return;
          }
        }
        if (!confirm(t('למחוק את חלקה') + ' "' + locName(plot) + '"?')) return;
        
        if (plot.layer) drawnItems.removeLayer(plot.layer);
        if (plot.labelMarker) drawnItems.removeLayer(plot.labelMarker);
        var idx = plots.indexOf(plot);
        if (idx !== -1) plots.splice(idx, 1);
        saveData();
        renderPlotList();
        document.getElementById('modalContainer').innerHTML = '';
        showToast('🗑️ "' + locName(plot) + '" ' + t('נמחק'));
      });
    }

    // ── Tree-count calculators ──
    // Convenience only: they fill the tree-count box, they don't save. The
    // manager can always override the computed number by typing over it,
    // which is the whole point of a retrospective edit.
    (function() {
      var elArea  = document.getElementById('pdEditArea');
      var elRow   = document.getElementById('pdEditRowSpacing');
      var elTree  = document.getElementById('pdEditTreeSpacing');
      var elPpd   = document.getElementById('pdEditPlantsPerDunam');
      var elCount = document.getElementById('pdEditTreeCount');
      if (!elCount) return;

      function currentArea() {
        var a = parseFloat(elArea ? elArea.value : '');
        if (!isNaN(a) && a > 0) return a;
        return plot.area || 0;
      }

      var bSpacing = document.getElementById('pdCalcFromSpacing');
      if (bSpacing) bSpacing.addEventListener('click', function() {
        var r = parseFloat(elRow.value), tr = parseFloat(elTree.value);
        if (!r || !tr || r <= 0 || tr <= 0) { showToast('⚠️ ' + t('הזן מרווחים תקינים')); return; }
        var perDunam = 1000 / (r * tr);
        elCount.value = Math.round(currentArea() * perDunam);
        if (elPpd) elPpd.value = Math.round(perDunam);
        showToast('📐 ' + perDunam.toFixed(1) + ' ' + t('עצים') + '/' + t('דונם'));
      });

      var bDensity = document.getElementById('pdCalcFromDensity');
      if (bDensity) bDensity.addEventListener('click', function() {
        var ppd = parseFloat(elPpd ? elPpd.value : '');
        if (!ppd || ppd <= 0) { showToast('⚠️ ' + t('הזן צמחים לדונם')); return; }
        elCount.value = Math.round(currentArea() * ppd);
        showToast('📊 ' + elCount.value + ' ' + t('עצים'));
      });

      var bArea = document.getElementById('pdRecalcArea');
      if (bArea) bArea.addEventListener('click', function() {
        if (!plot.layer || typeof plot.layer.getLatLngs !== 'function') {
          showToast('📍 ' + t('לחלקה זו אין גבולות משורטטים'));
          return;
        }
        var a = calcArea(plot.layer);
        elArea.value = a.toFixed(2);
        showToast('↺ ' + formatArea(a));
      });
    })();

    // Save name + farm edit
    document.getElementById('pdSaveEdit').addEventListener('click', function() {
      // Same farm-permission gate as delete: an operator scoped to certain
      // farms must not be able to rename or re-measure someone else's plot.
      if (currentUser && currentUser.role !== 'admin') {
        var editFarmIds = (currentUser.farm_permissions || []);
        if (editFarmIds.length > 0 && editFarmIds.indexOf(plot.farm_id) === -1) {
          showToast('⛔ ' + t('אין לך הרשאה לערוך חלקה זו'));
          return;
        }
      }
      var newName = document.getElementById('pdEditName').value.trim();
      var newNameTh = (document.getElementById('pdEditNameTh') || { value: '' }).value.trim();
      var newNameAr = (document.getElementById('pdEditNameAr') || { value: '' }).value.trim();
      var newFarmId = parseInt(document.getElementById('pdEditFarm').value);
      var newCropType = document.getElementById('pdEditCrop').value || null;
      var geofenceEl = document.getElementById('pdEditGeofence');
      var newGeofence = geofenceEl ? parseInt(geofenceEl.value) : null;
      if (newGeofence != null && (isNaN(newGeofence) || newGeofence < 20 || newGeofence > 500)) {
        showToast('⚠️ ' + t('רדיוס גיאופנס חייב להיות בין 20 ל-500 מטר'));
        return;
      }
      if (!newName) { showToast('❌ ' + t('שם ריק')); return; }
      
      var changed = false;
      var oldName = plot.name || '';
      var nameChanged = (newName !== plot.name);
      
      // Update name + translations
      if (nameChanged) {
        plot.name = newName;
        changed = true;
      }
      if ((newNameTh || null) !== (plot.name_th || null)) {
        plot.name_th = newNameTh || null;
        changed = true;
      }
      if ((newNameAr || null) !== (plot.name_ar || null)) {
        plot.name_ar = newNameAr || null;
        changed = true;
      }
      // Geofence radius (Phase 1 Meckano upgrade — per-plot attendance proof radius)
      if (newGeofence != null && newGeofence !== plot.geofenceRadiusM) {
        plot.geofenceRadiusM = newGeofence;
        changed = true;
      }
      
      // Update farm
      if (newFarmId && newFarmId !== plot.farm_id) {
        var newFarm = farms.find(function(f) { return f.id === newFarmId; });
        if (newFarm) {
          plot.farm_id = newFarmId;
          plot.color = newFarm.color;
          if (plot.layer) plot.layer.setStyle({ color: newFarm.color, fillColor: newFarm.color });
          changed = true;
        }
      }

      // Update crop type
      if (newCropType !== plot.crop_type) {
        plot.crop_type = newCropType;
        changed = true;
      }

      // Retrospective agronomic edits — area, spacing, density, tree count.
      // Validation runs before any assignment so an out-of-range entry aborts
      // the whole save instead of leaving the plot half-updated.
      var numEdits = readPlotNumericEdits(plot);
      if (numEdits === null) return;
      Object.keys(numEdits).forEach(function(k) {
        var before = (plot[k] != null) ? plot[k] : 0;
        if (numEdits[k] !== before) {
          plot[k] = numEdits[k];
          changed = true;
        }
      });

      if (!changed) {
        container.innerHTML = '';
        showPlotDetails(plotId);
        return;
      }

      function finishPlotEdit() {
        // Update map label
        if (plot.labelMarker) drawnItems.removeLayer(plot.labelMarker);
        if (plot.layer) {
          var center = plot.layer.getBounds().getCenter();
          var label = L.divIcon({
            className: '',
            html: '<div style="background:' + plot.color + ';color:white;padding:3px 10px;border-radius:8px;font-family:Heebo,sans-serif;font-size:12px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.3);text-align:center;">' + locName(plot) + '</div>',
            iconAnchor: [0, 0]
          });
          plot.labelMarker = L.marker(center, { icon: label, interactive: false }).addTo(drawnItems);
        }
        saveData();
        renderPlotList();
        showToast('✅ ' + locName(plot) + ' ' + t('עודכן'));
        container.innerHTML = '';
        showPlotDetails(plotId);
      }

      // A rename leaves the OLD name frozen inside every worklog entry and
      // field report written before it — those records snapshot the name at
      // write time. Ask what should happen to that history instead of
      // deciding silently in either direction.
      if (nameChanged) {
        promptPlotRenameHistory(plot, oldName, newName, finishPlotEdit);
      } else {
        finishPlotEdit();
      }
    });
    
    // Redraw polygon
    document.getElementById('pdRedrawPolygon').addEventListener('click', function() {
      container.innerHTML = '';
      // Remove old polygon from map
      if (plot.layer) drawnItems.removeLayer(plot.layer);
      if (plot.labelMarker) drawnItems.removeLayer(plot.labelMarker);
      
      // Store plot info for after redraw
      window._redrawPlotId = plot.id;
      window._redrawPlotName = plot.name;
      window._redrawPlotFarmId = plot.farm_id;
      
      // Start polygon draw mode
      drawMode = 'polygon';
      polyPoints = [];
      polyMarkers = [];
      polyLine = null;
      mapEl.classList.add('drawing');
      fabMain.classList.add('drawing');
      drawBanner.classList.add('show');
      drawBanner.textContent = '🔄 ' + t('צייר מחדש') + ': ' + plot.name;
      
      // Switch to map tab
      document.querySelectorAll('.tab').forEach(function(tt) { tt.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      document.querySelector('[data-tab="map"]').classList.add('active');
      document.getElementById('tabMap').classList.add('active');
      activeTab = 'map';
      setTimeout(function() { map.invalidateSize(); }, 50);
    });
    
    // Navigate — shared helper, so the farm page and this modal stay identical
    // and the missing-geometry case is handled in one place.
    document.getElementById('plotDetailNav').addEventListener('click', function() {
      window.goToPlotOnMap(plotId);
    });
    
    // Primary
    document.getElementById('plotDetailPrimary').addEventListener('click', function() {
      var newPrimary = isPrimary ? null : plot.id;
      var usersData = JSON.parse(localStorage.getItem('shorashim-users') || '{}');
      if (usersData[currentUser.username]) {
        usersData[currentUser.username].primary_plot_id = newPrimary;
        DB.save('shorashim-users', usersData);
        users = usersData;
        currentUser = usersData[currentUser.username];
        showToast(newPrimary ? '⭐ ' + plot.name : '📍 ' + t('חלקה ראשית בוטלה'));
        container.innerHTML = '';
        showPlotDetails(plotId);
      }
    });
  }

  // ══════════════════════════════════
  // ── DRAGGABLE FARMS FAB ──
  // ══════════════════════════════════

  (function() {
    var fab = document.getElementById('fabFarms');
    var menu = document.getElementById('fabFarmsMenu');
    var isDragging = false;
    var wasDragged = false;
    var startX, startY, startLeft, startTop;
    
    // Load saved position
    var savedPos = JSON.parse(localStorage.getItem('shorashim-fab-farms-pos') || 'null');
    if (savedPos) {
      fab.style.right = 'auto';
      fab.style.left = Math.min(savedPos.left, window.innerWidth - 60) + 'px';
      fab.style.top = Math.min(savedPos.top, window.innerHeight - 40) + 'px';
      fab.style.bottom = 'auto';
    }

    function onStart(clientX, clientY) {
      isDragging = true;
      wasDragged = false;
      var rect = fab.getBoundingClientRect();
      startX = clientX;
      startY = clientY;
      startLeft = rect.left;
      startTop = rect.top;
      fab.classList.add('dragging');
    }

    function onMove(clientX, clientY) {
      if (!isDragging) return;
      var dx = clientX - startX;
      var dy = clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) wasDragged = true;
      var newLeft = Math.max(0, Math.min(window.innerWidth - fab.offsetWidth, startLeft + dx));
      var newTop = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, startTop + dy));
      fab.style.left = newLeft + 'px';
      fab.style.top = newTop + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    }

    function onEnd() {
      if (!isDragging) return;
      isDragging = false;
      fab.classList.remove('dragging');
      // Save position
      localStorage.setItem('shorashim-fab-farms-pos', JSON.stringify({
        left: fab.getBoundingClientRect().left,
        top: fab.getBoundingClientRect().top
      }));
    }

    // Mouse events
    fab.addEventListener('mousedown', function(e) { e.preventDefault(); onStart(e.clientX, e.clientY); });
    document.addEventListener('mousemove', function(e) { onMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup', function() { 
      var drag = isDragging;
      onEnd(); 
    });

    // Touch events
    fab.addEventListener('touchstart', function(e) { 
      var touch = e.touches[0]; 
      onStart(touch.clientX, touch.clientY); 
    }, { passive: true });
    document.addEventListener('touchmove', function(e) { 
      if (!isDragging) return;
      var touch = e.touches[0]; 
      onMove(touch.clientX, touch.clientY); 
    }, { passive: true });
    document.addEventListener('touchend', function() { onEnd(); });

    // Click (only if not dragged) — toggle menu
    fab.addEventListener('click', function(e) {
      if (wasDragged) return;
      toggleFarmsMenu();
    });

    // Close menu when clicking elsewhere
    document.addEventListener('click', function(e) {
      if (!e.target.closest('#fabFarms') && !e.target.closest('#fabFarmsMenu')) {
        menu.classList.remove('show');
      }
    });

    function toggleFarmsMenu() {
      var isOpen = menu.classList.contains('show');
      if (isOpen) {
        menu.classList.remove('show');
        return;
      }
      
      // Build menu content
      var userFarms = getUserFarms(currentUser);
      if (userFarms.length === 0) {
        menu.innerHTML = '<div style="padding: 16px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">' + t('אין מטעים משויכים') + '</div>';
      } else {
        var html = '';
        userFarms.forEach(function(farm) {
          var farmPlots = plots.filter(function(p) { return p.farm_id === farm.id; });
          html += '<button class="fab-farms-menu-item" data-fab-farm-id="' + farm.id + '">' +
            '<span style="width: 14px; height: 14px; border-radius: 50%; background: ' + farm.color + '; flex-shrink: 0; display: inline-block;"></span>' +
            '<div style="flex: 1;">' +
              '<div style="font-weight: 600; font-size: 0.9rem; color: var(--text);">' + locName(farm) + '</div>' +
              '<div style="font-size: 0.72rem; color: var(--text-muted);">' + farmPlots.length + ' ' + t('חלקות') + '</div>' +
            '</div>' +
          '</button>';
        });
        menu.innerHTML = html;
      }
      
      // Position menu above the fab
      var fabRect = fab.getBoundingClientRect();
      menu.style.right = (window.innerWidth - fabRect.right) + 'px';
      menu.style.bottom = (window.innerHeight - fabRect.top + 8) + 'px';
      menu.style.left = 'auto';
      menu.style.top = 'auto';
      
      // Ensure menu doesn't go off screen
      menu.classList.add('show');
      var menuRect = menu.getBoundingClientRect();
      if (menuRect.top < 0) {
        menu.style.bottom = 'auto';
        menu.style.top = (fabRect.bottom + 8) + 'px';
      }
      if (menuRect.right > window.innerWidth) {
        menu.style.right = '8px';
      }
      
      // Farm click handlers
      menu.querySelectorAll('[data-fab-farm-id]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var fId = parseInt(this.getAttribute('data-fab-farm-id'));
          menu.classList.remove('show');
          showFarmDetails(fId);
        });
      });
    }
  })();

  // ══════════════════════════════════
  // ── PESTICIDE SEARCH (data.gov.il) ──
  // ══════════════════════════════════

  // Get crop types from user's accessible plots
  function getUserCropTypes() {
    var accessiblePlots = getAccessiblePlots();
    var crops = {};
    accessiblePlots.forEach(function(p) {
      if (p.crop_type) crops[p.crop_type] = true;
    });
    return Object.keys(crops);
  }

  var PEST_API_URL = 'https://data.gov.il/api/3/action/datastore_search';
  var PEST_RESOURCE_ID = 'cffe0c50-6856-4187-9315-51bc113cb718';
  var pestSearchTimer = null;
  var pestSearchCache = {};
  var pestSearchMode = 'all';
  
  // Dynamic field mapping — discovered from API on first call
  var pestFieldMap = null;
  
  function discoverPestFields(fields, sampleRecord) {
    if (pestFieldMap) return;
    // Exact field names from data.gov.il API response
    pestFieldMap = {
      product:  ['שם תכשיר', 'שם תכשיר אנגלי'],
      active:   ['חומר פעיל'],
      crop:     ['גידול', 'גידול אנגלי', 'קבוצת גידולים'],
      pest:     ['נגע', 'נגע אנגלי', 'נגע לטיני', 'קבוצת נגעים'],
      company:  ['בעל רשיון', 'בעל רשיון אנגלי', 'יצרן פורמולציה'],
      reg:      ['מספר רשיון'],
      usage:    ['סוג פעילות', 'סוג פעילות אנגלי'],
      conc:     ['ריכוז חומר פעיל'],
      form:     ['פורמולציה'],
      toxicity: ['רעילות', 'דרגת רעילות'],
      dosage:   ['מינון ליישום', 'נפח ליישום'],
      phi:      ['תקופת המתנה'],
      label:    ['תווית']
    };
    console.log('🧪 field mapping ready, total records:', sampleRecord ? 'yes' : 'no');
  }
  
  function getRecField(rec, category) {
    if (!pestFieldMap) {
      // Fallback before discovery
      discoverPestFields([], null);
    }
    var fields = pestFieldMap[category] || [];
    for (var i = 0; i < fields.length; i++) {
      var val = rec[fields[i]];
      if (val !== null && val !== undefined && val !== '') return String(val);
    }
    return '';
  }

  var pestInput = document.getElementById('pestSearchInput');
  var pestAC = document.getElementById('pestAutoComplete');
  var pestMeta = document.getElementById('pestSearchMeta');

  // Mode toggle buttons
  document.querySelectorAll('.pest-mode-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      pestSearchMode = this.getAttribute('data-pest-mode');
      document.querySelectorAll('.pest-mode-btn').forEach(function(b) {
        b.classList.remove('active');
        b.style.background = 'var(--g5)';
        b.style.color = 'var(--g1)';
      });
      this.classList.add('active');
      this.style.background = 'var(--g2)';
      this.style.color = 'white';
      
      // Update placeholder
      var placeholders = { all: '', product: t('שם תכשיר') + '...', crop: t('שם גידול') + '...' };
      pestInput.placeholder = placeholders[pestSearchMode] || '';
      
      // Clear cache when switching mode
      pestSearchCache = {};
      pestAC.style.display = 'none';
      
      // Re-search if input has text
      if (pestInput.value.trim().length > 0) {
        fetchPestSuggestions(pestInput.value.trim());
      }
      pestInput.focus();
    });
  });
  // Set initial active style
  document.querySelector('.pest-mode-btn.active').style.background = 'var(--g2)';
  document.querySelector('.pest-mode-btn.active').style.color = 'white';

  // Live autocomplete on input
  pestInput.addEventListener('input', function() {
    var q = this.value.trim();
    clearTimeout(pestSearchTimer);
    
    if (q.length < 1) {
      pestAC.style.display = 'none';
      pestMeta.textContent = '';
      return;
    }
    
    pestSearchTimer = setTimeout(function() {
      fetchPestSuggestions(q);
    }, 300);
  });

  // Full search on Enter or button
  document.getElementById('pestSearchBtn').addEventListener('click', function() {
    pestAC.style.display = 'none';
    performPestSearch();
  });
  pestInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      pestAC.style.display = 'none';
      performPestSearch();
    }
  });

  // Close autocomplete on outside click
  document.addEventListener('click', function(e) {
    if (!e.target.closest('#pestSearchInput') && !e.target.closest('#pestAutoComplete')) {
      pestAC.style.display = 'none';
    }
  });

  // ── Pesticide Search Engine ──
  // Uses CKAN filters= for field-specific search (exact match)
  // and q= for free text, with client-side startsWith filtering
  
  var PEST_BASE = PEST_API_URL + '?resource_id=' + PEST_RESOURCE_ID;
  
  // data.gov.il blocks some browser origins outright, and when it does the
  // browser reports a bare TypeError — indistinguishable from "no results"
  // unless we say so. Direct call first; on failure retry once through our
  // own Cloud Function, which has no CORS problem, and only then give up.
  var pestProxyMode = false;

  function pestRequest(url) {
    if (pestProxyMode) return pestViaProxy(url);
    return fetch(url).then(function(res) {
      if (!res.ok) throw new Error('gov ' + res.status);
      return res.json();
    }).catch(function(err) {
      return pestViaProxy(url).then(function(data) {
        // Stick with the proxy for the rest of the session once it works.
        pestProxyMode = true;
        return data;
      }, function() { throw err; });
    });
  }

  function pestViaProxy(url) {
    return fetch('/api/govdata?url=' + encodeURIComponent(url))
      .then(function(res) {
        if (!res.ok) throw new Error('proxy ' + res.status);
        return res.json();
      });
  }

  function pestFetch(query, mode, limit, callback) {
    // Always use q= (full text search), then filter client-side by the right field
    var url = PEST_BASE + '&q=' + encodeURIComponent(query) + '&limit=' + limit;

    pestRequest(url)
      .then(function(data) {
        if (!data.success || !data.result) { callback([]); return; }
        if (data.result.fields) discoverPestFields(data.result.fields, (data.result.records||[])[0]);
        var recs = data.result.records || [];
        var q = query.toLowerCase();
        
        // Filter to the correct field only
        var filtered = recs.filter(function(rec) {
          if (mode === 'product') {
            return (rec['\u05E9\u05DD \u05EA\u05DB\u05E9\u05D9\u05E8']||'').toLowerCase().indexOf(q) !== -1 ||
                   (rec['\u05D7\u05D5\u05DE\u05E8 \u05E4\u05E2\u05D9\u05DC']||'').toLowerCase().indexOf(q) !== -1;
          } else if (mode === 'crop') {
            return (rec['\u05D2\u05D9\u05D3\u05D5\u05DC']||'').toLowerCase().indexOf(q) !== -1;
          } else {
            return (rec['\u05E9\u05DD \u05EA\u05DB\u05E9\u05D9\u05E8']||'').toLowerCase().indexOf(q) !== -1 ||
                   (rec['\u05D7\u05D5\u05DE\u05E8 \u05E4\u05E2\u05D9\u05DC']||'').toLowerCase().indexOf(q) !== -1;
          }
        });
        callback(filtered);
      })
      .catch(function(err) {
        // Tell the user the source is unreachable instead of pretending the
        // ministry has no record of the product they are holding.
        callback([], err || new Error('unreachable'));
      });
  }
  
  // Group records by product name -> single entry with all crops
  function groupByProduct(records) {
    var groups = {};
    records.forEach(function(rec) {
      var name = rec['\u05E9\u05DD \u05EA\u05DB\u05E9\u05D9\u05E8'] || '';
      if (!name) return;
      if (!groups[name]) {
        groups[name] = {
          name: name,
          active: rec['\u05D7\u05D5\u05DE\u05E8 \u05E4\u05E2\u05D9\u05DC'] || '',
          company: rec['\u05D1\u05E2\u05DC \u05E8\u05E9\u05D9\u05D5\u05DF'] || '',
          conc: rec['\u05E8\u05D9\u05DB\u05D5\u05D6 \u05D7\u05D5\u05DE\u05E8 \u05E4\u05E2\u05D9\u05DC'] || '',
          regNum: rec['\u05DE\u05E1\u05E4\u05E8 \u05E8\u05E9\u05D9\u05D5\u05DF'] || '',
          usage: rec['\u05E1\u05D5\u05D2 \u05E4\u05E2\u05D9\u05DC\u05D5\u05EA'] || '',
          label: rec['\u05EA\u05D5\u05D5\u05D9\u05EA'] || '',
          crops: {},
          recs: []
        };
      }
      var crop = rec['\u05D2\u05D9\u05D3\u05D5\u05DC'] || '';
      if (crop) groups[name].crops[crop] = true;
      groups[name].recs.push(rec);
    });
    return Object.values(groups);
  }
  
  // Group records by crop -> list products
  function groupByCrop(records) {
    var groups = {};
    records.forEach(function(rec) {
      var crop = rec['\u05D2\u05D9\u05D3\u05D5\u05DC'] || '';
      if (!crop) return;
      if (!groups[crop]) { groups[crop] = { crop: crop, products: {}, recs: [] }; }
      var name = rec['\u05E9\u05DD \u05EA\u05DB\u05E9\u05D9\u05E8'] || '';
      if (name) groups[crop].products[name] = true;
      groups[crop].recs.push(rec);
    });
    return Object.values(groups);
  }

  function fetchPestSuggestions(query) {
    var cacheKey = pestSearchMode + ':' + query;
    if (pestSearchCache[cacheKey]) {
      renderAutoComplete(query, pestSearchCache[cacheKey]);
      return;
    }
    pestMeta.textContent = '...';
    pestFetch(query, pestSearchMode, 200, function(records) {
      pestSearchCache[cacheKey] = records;
      renderAutoComplete(query, records);
    });
  }

  function renderAutoComplete(query, records) {
    if (records.length === 0) {
      pestAC.innerHTML = '<div style="padding: 14px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">' + t('\u05DC\u05D0 \u05E0\u05DE\u05E6\u05D0\u05D5 \u05EA\u05D5\u05E6\u05D0\u05D5\u05EA') + '</div>';
      pestAC.style.display = 'block';
      pestMeta.textContent = '0';
      return;
    }
    var qLower = query.toLowerCase();
    var html = '';
    
    if (pestSearchMode === 'crop') {
      var groups = groupByCrop(records);
      groups.sort(function(a,b) {
        var aS = a.crop.toLowerCase().indexOf(qLower)===0?0:1;
        var bS = b.crop.toLowerCase().indexOf(qLower)===0?0:1;
        return aS-bS || a.crop.localeCompare(b.crop);
      });
      groups.slice(0,12).forEach(function(g,idx) {
        var prods = Object.keys(g.products);
        var prodStr = prods.slice(0,3).join(', ');
        if (prods.length>3) prodStr += ' +' + (prods.length-3);
        html += '<div class="pest-ac-item" data-ac-idx="'+idx+'">' +
          '<div class="ac-name">\u{1F331} ' + highlightMatch(g.crop, qLower) + '</div>' +
          '<div class="ac-detail">\u{1F9EA} ' + prodStr + '</div>' +
          '<div class="ac-detail" style="font-size:0.68rem;color:var(--text-muted);">'+prods.length+' '+t('\u05EA\u05DB\u05E9\u05D9\u05E8\u05D9\u05DD \u05E8\u05E9\u05D5\u05DE\u05D9\u05DD')+'</div>' +
        '</div>';
      });
      pestAC.innerHTML = html;
      pestAC.style.display = 'block';
      pestAC._data = groups;
      pestAC._mode = 'crop';
      pestMeta.textContent = groups.length + ' ' + t('\u05D2\u05D9\u05D3\u05D5\u05DC\u05D9\u05DD');
    } else {
      var groups = groupByProduct(records);
      groups.sort(function(a,b) {
        var aS = a.name.toLowerCase().indexOf(qLower)===0?0:1;
        var bS = b.name.toLowerCase().indexOf(qLower)===0?0:1;
        return aS-bS || a.name.localeCompare(b.name);
      });
      groups.slice(0,12).forEach(function(g,idx) {
        var cropNames = Object.keys(g.crops);
        var cropStr = cropNames.slice(0,3).join(', ');
        if (cropNames.length>3) cropStr += ' +' + (cropNames.length-3);
        html += '<div class="pest-ac-item" data-ac-idx="'+idx+'">' +
          '<div class="ac-name">\u{1F9EA} ' + highlightMatch(g.name, qLower) + '</div>' +
          '<div class="ac-detail">\u{1F48A} ' + g.active + (g.conc ? ' \u2014 '+g.conc : '') + '</div>' +
          (cropStr ? '<div class="ac-detail" style="color:var(--water);">\u{1F331} '+cropStr+'</div>' : '') +
          (g.label ? '<div class="ac-detail" style="font-size:0.68rem;color:var(--g3);">\u{1F4C4} '+t('\u05EA\u05D5\u05D5\u05D9\u05EA \u05D6\u05DE\u05D9\u05E0\u05D4')+'</div>' : '') +
        '</div>';
      });
      pestAC.innerHTML = html;
      pestAC.style.display = 'block';
      pestAC._data = groups;
      pestAC._mode = 'product';
      pestMeta.textContent = groups.length + ' ' + t('\u05EA\u05DB\u05E9\u05D9\u05E8\u05D9\u05DD');
    }
    
    pestAC.querySelectorAll('[data-ac-idx]').forEach(function(el) {
      el.addEventListener('click', function() {
        var idx = parseInt(this.getAttribute('data-ac-idx'));
        var g = pestAC._data[idx];
        pestAC.style.display = 'none';
        if (pestAC._mode === 'crop') {
          pestInput.value = g.crop;
          showCropDetail(g);
        } else {
          pestInput.value = g.name;
          showProductDetail(g);
        }
      });
    });
  }
  
  function highlightMatch(text, query) {
    if (!text || !query) return text || '';
    var idx = text.toLowerCase().indexOf(query);
    if (idx === -1) return text;
    return text.substring(0, idx) + '<span class="ac-highlight">' + text.substring(idx, idx + query.length) + '</span>' + text.substring(idx + query.length);
  }
  
  // Show single product with all its crop registrations
  function showProductDetail(g) {
    var container = document.getElementById('modalContainer');
    var labelLink = g.label ? '<a href="'+g.label+'" target="_blank" rel="noopener" style="display:block;text-align:center;padding:12px;background:linear-gradient(135deg,var(--g1),var(--g2));color:white;border-radius:12px;text-decoration:none;font-weight:700;font-size:0.9rem;margin-bottom:14px;">\u{1F4C4} '+t('\u05E6\u05E4\u05D4 \u05D1\u05EA\u05D5\u05D5\u05D9\u05EA \u05D4\u05E8\u05E9\u05DE\u05D9\u05EA')+'</a>' : '';
    
    // Deduplicate by crop+pest
    var seen = {};
    var uniqueRows = [];
    g.recs.forEach(function(rec) {
      var crop = rec['\u05D2\u05D9\u05D3\u05D5\u05DC'] || '';
      var pest = rec['\u05E0\u05D2\u05E2'] || '';
      var key = crop + '|' + pest;
      if (!crop || seen[key]) return;
      seen[key] = true;
      uniqueRows.push(rec);
    });

    // Filter by user's crops (all non-admin users)
    var userCrops = getUserCropTypes();
    var filteredRows = uniqueRows;
    var showingFiltered = false;
    var noMatch = false;
    if (currentUser && currentUser.role !== 'admin' && userCrops.length > 0) {
      filteredRows = uniqueRows.filter(function(rec) {
        var crop = (rec['\u05D2\u05D9\u05D3\u05D5\u05DC'] || '').toLowerCase();
        return userCrops.some(function(uc) { 
          var ucl = uc.toLowerCase();
          // Flexible matching: "תמרים" matches "תמר", "דקל תמרים", etc.
          return crop.indexOf(ucl) !== -1 || ucl.indexOf(crop) !== -1 ||
            crop.replace(/ים$/, '').indexOf(ucl.replace(/ים$/, '')) !== -1 ||
            ucl.replace(/ים$/, '').indexOf(crop.replace(/ים$/, '')) !== -1;
        });
      });
      showingFiltered = true;
      if (filteredRows.length === 0) {
        noMatch = true;
      }
    }
    
    var cropsHtml = '';
    if (noMatch) {
      cropsHtml = '<div style="padding:16px;text-align:center;color:#999;">' +
        '<div style="font-size:1.5rem;margin-bottom:8px;">🚫</div>' +
        '<div>' + t('אין רישומים לגידולים שלך') + '</div>' +
        '<div style="font-size:0.75rem;margin-top:6px;">(' + userCrops.join(', ') + ')</div>' +
        '<div style="font-size:0.72rem;margin-top:8px;color:#aaa;">' + t('סה״כ') + ' ' + uniqueRows.length + ' ' + t('גידולים') + ' ' + t('רשומים לתכשיר זה') + '</div>' +
      '</div>';
    } else {
      filteredRows.forEach(function(rec, idx) {
      var crop = rec['\u05D2\u05D9\u05D3\u05D5\u05DC'] || '';
      var pest = rec['\u05E0\u05D2\u05E2'] || '';
      var dosage = rec['\u05DE\u05D9\u05E0\u05D5\u05DF \u05DC\u05D9\u05D9\u05E9\u05D5\u05DD'] || '';
      var phi = rec['\u05EA\u05E7\u05D5\u05E4\u05EA \u05D4\u05DE\u05EA\u05E0\u05D4'] || '';
      cropsHtml += '<div style="padding:8px;background:var(--g6);border-radius:8px;margin-bottom:5px;">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-weight:600;font-size:0.88rem;">\u{1F331} '+crop+'</span>' +
          '<div style="display:flex;align-items:center;gap:6px;">' +
            (phi ? '<span style="font-size:0.72rem;padding:2px 8px;background:#fff3e0;border-radius:6px;color:var(--accent);">\u23F3 '+phi+'</span>' : '') +
            '<button class="pd-add-single" data-row-idx="'+idx+'" style="border:none;background:#4caf50;color:white;border-radius:6px;padding:2px 8px;font-size:0.75rem;font-weight:700;cursor:pointer;">➕</button>' +
          '</div>' +
        '</div>' +
        (pest ? '<div style="font-size:0.78rem;color:var(--danger);margin-top:2px;">\u{1F41B} '+pest+'</div>' : '') +
        (dosage ? '<div style="font-size:0.75rem;color:var(--text-muted);margin-top:2px;">\u{1F489} '+dosage+'</div>' : '') +
      '</div>';
    });
    } // end else (has matching crops)
    
    container.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
      '<div class="modal" style="max-width:520px;">' +
        '<h2>\u{1F9EA} '+g.name+'</h2>' +
        '<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:4px;">\u{1F48A} '+g.active+(g.conc?' \u2014 '+g.conc:'')+'</div>' +
        (g.company?'<div style="font-size:0.78rem;color:var(--text-muted);margin-bottom:4px;">\u{1F3ED} '+g.company+'</div>':'') +
        (g.regNum?'<div style="font-size:0.72rem;color:var(--text-muted);margin-bottom:12px;">#'+g.regNum+' \u2022 '+g.usage+'</div>':'') +
        labelLink +
        '<div style="font-size:0.82rem;font-weight:600;color:var(--g1);margin-bottom:8px;">'+filteredRows.length+' '+t('\u05D2\u05D9\u05D3\u05D5\u05DC\u05D9\u05DD')+(showingFiltered?' (' + t('מסונן לגידולים שלך') + ')':'')+':</div>' +
        '<div style="max-height:50vh;overflow-y:auto;">'+cropsHtml+'</div>' +
        '<div class="modal-buttons" style="margin-top:14px;">' +
          (currentUser&&currentUser.role==='admin'?'<button class="btn btn-primary" id="pdImportAll">\u2795 '+t('\u05D4\u05D5\u05E1\u05E3 \u05DC\u05E8\u05E9\u05D9\u05DE\u05D4')+'</button>':'') +
          '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">'+t('\u05E1\u05D2\u05D5\u05E8')+'</button>' +
        '</div></div></div>';
    
    var imp = document.getElementById('pdImportAll');
    if (imp) imp.addEventListener('click', function() { filteredRows.forEach(function(r){importPesticideFromGov(r);}); container.innerHTML=''; });
    
    // Individual row add buttons
    container.querySelectorAll('.pd-add-single').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var rowIdx = parseInt(this.getAttribute('data-row-idx'));
        if (filteredRows[rowIdx]) {
          importPesticideFromGov(filteredRows[rowIdx]);
          this.textContent = '✓';
          this.style.background = '#999';
          this.disabled = true;
        }
      });
    });
  }
  
  // Show all products for a crop
  function showCropDetail(g) {
    var container = document.getElementById('modalContainer');
    var prods = {};
    g.recs.forEach(function(rec) {
      var name = rec['\u05E9\u05DD \u05EA\u05DB\u05E9\u05D9\u05E8'] || '';
      if (!name) return;
      if (!prods[name]) prods[name] = { active: rec['\u05D7\u05D5\u05DE\u05E8 \u05E4\u05E2\u05D9\u05DC']||'', pests: {}, recs: [] };
      var pest = rec['\u05E0\u05D2\u05E2'] || '';
      if (pest) prods[name].pests[pest] = true;
      prods[name].recs.push(rec);
    });
    var pKeys = Object.keys(prods);
    var html = '';
    pKeys.forEach(function(name) {
      var p = prods[name];
      var pestStr = Object.keys(p.pests).join(', ');
      html += '<div class="pest-ac-item" style="border-radius:10px;margin-bottom:6px;background:var(--g6);cursor:pointer;" data-cd-name="'+name.replace(/"/g,'&quot;')+'">' +
        '<div class="ac-name">\u{1F9EA} '+name+'</div>' +
        '<div class="ac-detail">\u{1F48A} '+p.active+'</div>' +
        (pestStr?'<div class="ac-detail" style="color:var(--danger);">\u{1F41B} '+pestStr+'</div>':'') +
      '</div>';
    });
    container.innerHTML = '<div class="modal-overlay" onclick="if(event.target===this)document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
      '<div class="modal" style="max-width:520px;">' +
        '<h2>\u{1F331} '+g.crop+'</h2>' +
        '<div style="font-size:0.82rem;color:var(--text-muted);margin-bottom:14px;">'+pKeys.length+' '+t('\u05EA\u05DB\u05E9\u05D9\u05E8\u05D9\u05DD \u05E8\u05E9\u05D5\u05DE\u05D9\u05DD')+'</div>' +
        '<div style="max-height:60vh;overflow-y:auto;">'+html+'</div>' +
        '<div class="modal-buttons" style="margin-top:14px;">' +
          '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">'+t('\u05E1\u05D2\u05D5\u05E8')+'</button>' +
        '</div></div></div>';
    container.querySelectorAll('[data-cd-name]').forEach(function(el) {
      el.addEventListener('click', function() {
        var nm = this.getAttribute('data-cd-name');
        if (prods[nm]) showPestRecordDetail(prods[nm].recs[0]);
      });
    });
  }
  
  function performPestSearch() {
    var query = pestInput.value.trim();
    if (!query) return;
    var resultsEl = document.getElementById('pestSearchResults');
    var loadingEl = document.getElementById('pestSearchLoading');
    var emptyEl = document.getElementById('pestSearchEmpty');
    resultsEl.innerHTML = '';
    loadingEl.style.display = 'block';
    emptyEl.style.display = 'none';
    pestAC.style.display = 'none';
    
    pestFetch(query, pestSearchMode, 200, function(records) {
      loadingEl.style.display = 'none';
      if (records.length === 0) { emptyEl.style.display = 'block'; return; }
      
      if (pestSearchMode === 'crop') {
        var groups = groupByCrop(records);
        if (groups.length === 1) { showCropDetail(groups[0]); return; }
        // Show list
        var html = '';
        groups.forEach(function(g) {
          var prods = Object.keys(g.products);
          html += '<div class="section-card" style="margin-bottom:8px;padding:14px;cursor:pointer;" onclick=""><div style="font-weight:700;color:var(--g1);">\u{1F331} '+g.crop+'</div><div style="font-size:0.8rem;color:var(--text-muted);">'+prods.length+' '+t('\u05EA\u05DB\u05E9\u05D9\u05E8\u05D9\u05DD')+'</div></div>';
        });
        resultsEl.innerHTML = html;
      } else {
        var groups = groupByProduct(records);
        if (groups.length === 1) { showProductDetail(groups[0]); return; }
        var html = '';
        groups.forEach(function(g) {
          var cropNames = Object.keys(g.crops);
          html += '<div class="section-card" style="margin-bottom:8px;padding:14px;cursor:pointer;" data-fr-name="'+g.name.replace(/"/g,'&quot;')+'"><div style="font-weight:700;color:var(--g1);">\u{1F9EA} '+g.name+'</div><div style="font-size:0.8rem;">\u{1F48A} '+g.active+'</div>'+(g.label?'<div style="font-size:0.72rem;color:var(--g3);">\u{1F4C4} '+t('\u05EA\u05D5\u05D5\u05D9\u05EA \u05D6\u05DE\u05D9\u05E0\u05D4')+'</div>':'')+'</div>';
        });
        resultsEl.innerHTML = html;
        resultsEl._groups = {};
        groups.forEach(function(g) { resultsEl._groups[g.name] = g; });
        resultsEl.querySelectorAll('[data-fr-name]').forEach(function(el) {
          el.addEventListener('click', function() {
            var nm = this.getAttribute('data-fr-name');
            if (resultsEl._groups[nm]) showProductDetail(resultsEl._groups[nm]);
          });
        });
      }
    });
  }

  function showPestRecordDetail(rec) {
    var container = document.getElementById('modalContainer');
    
    var name = getRecField(rec, 'product');
    var active = getRecField(rec, 'active');
    var conc = getRecField(rec, 'conc');
    var form = getRecField(rec, 'form');
    var company = getRecField(rec, 'company');
    var regNum = getRecField(rec, 'reg');
    var crop = getRecField(rec, 'crop');
    var pest = getRecField(rec, 'pest');
    var usage = getRecField(rec, 'usage');
    var toxicity = getRecField(rec, 'toxicity');
    var toxLevel = rec['דרגת רעילות'] || '';
    var dosage = getRecField(rec, 'dosage');
    var volume = rec['נפח ליישום'] || '';
    var phi = getRecField(rec, 'phi');
    var labelUrl = getRecField(rec, 'label');
    var cropGroup = rec['קבוצת גידולים'] || '';
    var pestGroup = rec['קבוצת נגעים'] || '';
    var resistGroup = rec['קבוצת עמידות'] || '';
    var reEntry = rec['כניסה מחדש'] || '';
    
    // Determine category badge
    var catBadge = '';
    var usageLower = (usage + ' ' + pestGroup).toLowerCase();
    if (usageLower.indexOf('חרק') !== -1 || usageLower.indexOf('אקרי') !== -1 || usageLower.indexOf('insect') !== -1) {
      catBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; background: #fce4ec; color: #c62828;">🐛 ' + t('קוטל חרקים') + '</span>';
    } else if (usageLower.indexOf('פטר') !== -1 || usageLower.indexOf('מחלה') !== -1 || usageLower.indexOf('fungic') !== -1) {
      catBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; background: #e8eaf6; color: #283593;">🦠 ' + t('קוטל פטריות') + '</span>';
    } else if (usageLower.indexOf('עשב') !== -1 || usageLower.indexOf('herbic') !== -1) {
      catBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; background: #e8f5e9; color: #2e7d32;">🌿 ' + t('קוטל עשבים') + '</span>';
    } else if (usageLower.indexOf('הורמון') !== -1 || usageLower.indexOf('ויסות') !== -1 || usageLower.indexOf('regul') !== -1) {
      catBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; background: #fff3e0; color: #ef6c00;">⚗️ ' + t('הורמון/ויסות') + '</span>';
    } else if (usageLower.indexOf('סבון') !== -1 || usageLower.indexOf('שמן') !== -1 || usageLower.indexOf('משטח') !== -1) {
      catBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; background: #e0f7fa; color: #00838f;">🧴 ' + t('סבון/שמן') + '</span>';
    } else if (usage) {
      catBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.75rem; font-weight: 600; background: var(--g6); color: var(--g1);">🎯 ' + usage + '</span>';
    }
    
    // Toxicity badge
    var toxBadge = '';
    if (toxicity) {
      var toxColor = toxicity.indexOf('מאד') !== -1 ? '#c62828' : toxicity.indexOf('רעיל') !== -1 ? '#ef6c00' : '#2e7d32';
      toxBadge = '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.72rem; font-weight: 600; background: ' + (toxColor === '#c62828' ? '#fce4ec' : toxColor === '#ef6c00' ? '#fff3e0' : '#e8f5e9') + '; color: ' + toxColor + ';">⚠️ ' + toxicity + '</span>';
    }
    
    var html = '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
      '<div class="modal" style="max-width: 520px;">' +
        '<h2 style="margin-bottom: 4px;">🧪 ' + (name || t('תכשיר')) + '</h2>' +
        (regNum ? '<div style="font-size: 0.72rem; color: var(--text-muted); margin-bottom: 10px;">#' + regNum + (company ? ' • ' + company : '') + '</div>' : '') +
        
        '<div style="display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px;">' +
          catBadge +
          toxBadge +
          (toxLevel && toxLevel !== toxicity ? '<span style="display: inline-block; padding: 3px 10px; border-radius: 8px; font-size: 0.72rem; background: #f5f5f5; color: #616161;">🏷️ ' + toxLevel + '</span>' : '') +
        '</div>' +
        
        // Key info matrix
        '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px;">' +
          (active ? '<div style="background: var(--g6); padding: 10px; border-radius: 10px;"><div style="font-size: 0.65rem; color: var(--text-muted);">💊 ' + t('חומר פעיל') + '</div><div style="font-size: 0.88rem; font-weight: 700;">' + active + '</div>' + (conc ? '<div style="font-size: 0.72rem; color: var(--text-muted);">' + conc + '</div>' : '') + '</div>' : '') +
          (form ? '<div style="background: var(--g6); padding: 10px; border-radius: 10px;"><div style="font-size: 0.65rem; color: var(--text-muted);">🧫 ' + t('פורמולציה') + '</div><div style="font-size: 0.88rem; font-weight: 600;">' + form + '</div></div>' : '') +
          (crop ? '<div style="background: #e8f5e9; padding: 10px; border-radius: 10px;"><div style="font-size: 0.65rem; color: var(--g1);">🌱 ' + t('גידול') + '</div><div style="font-size: 0.88rem; font-weight: 700;">' + crop + '</div>' + (cropGroup && cropGroup !== crop ? '<div style="font-size: 0.72rem; color: var(--text-muted);">' + cropGroup + '</div>' : '') + '</div>' : '') +
          (pest ? '<div style="background: #fce4ec; padding: 10px; border-radius: 10px;"><div style="font-size: 0.65rem; color: #c62828;">🐛 ' + t('נגע') + '</div><div style="font-size: 0.88rem; font-weight: 700;">' + pest + '</div>' + (rec['נגע לטיני'] ? '<div style="font-size: 0.68rem; color: var(--text-muted); font-style: italic;">' + rec['נגע לטיני'] + '</div>' : '') + '</div>' : '') +
        '</div>' +
        
        // Dosage & PHI row
        (dosage || phi || volume ? '<div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 14px;">' +
          (dosage ? '<div style="background: #e3f2fd; padding: 10px; border-radius: 10px; text-align: center;"><div style="font-size: 0.65rem; color: var(--water);">💉 ' + t('מינון') + '</div><div style="font-size: 0.82rem; font-weight: 700; color: var(--water);">' + dosage + '</div></div>' : '<div></div>') +
          (volume ? '<div style="background: #e3f2fd; padding: 10px; border-radius: 10px; text-align: center;"><div style="font-size: 0.65rem; color: var(--water);">💧 ' + t('נפח') + '</div><div style="font-size: 0.82rem; font-weight: 700; color: var(--water);">' + volume + '</div></div>' : '<div></div>') +
          (phi ? '<div style="background: #fff3e0; padding: 10px; border-radius: 10px; text-align: center;"><div style="font-size: 0.65rem; color: var(--accent);">⏳ ' + t('המתנה') + '</div><div style="font-size: 0.82rem; font-weight: 700; color: var(--accent);">' + phi + '</div></div>' : '<div></div>') +
        '</div>' : '') +
        
        (reEntry ? '<div style="font-size: 0.78rem; color: var(--text-muted); margin-bottom: 8px;">🚷 ' + t('כניסה מחדש') + ': ' + reEntry + '</div>' : '') +
        (resistGroup ? '<div style="font-size: 0.75rem; color: var(--text-muted); margin-bottom: 12px;">🔬 ' + resistGroup + (rec['טרגט קוד'] ? ' (' + rec['טרגט קוד'] + ')' : '') + '</div>' : '') +
        
        // Label link
        (labelUrl ? '<a href="' + labelUrl + '" target="_blank" rel="noopener" style="display: block; text-align: center; padding: 12px; background: linear-gradient(135deg, var(--g1), var(--g2)); color: white; border-radius: 12px; text-decoration: none; font-weight: 700; font-size: 0.9rem; margin-bottom: 14px;">📄 ' + t('צפה בתווית הרשמית') + '</a>' : '') +
        
        '<div class="modal-buttons">';
    
    if (currentUser && currentUser.role === 'admin') {
      html += '<button class="btn btn-primary" id="pestDetailImport">➕ ' + t('הוסף לרשימה') + '</button>';
    }
    html += '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('סגור') + '</button></div></div></div>';
    
    container.innerHTML = html;
    var importBtn = document.getElementById('pestDetailImport');
    if (importBtn) {
      importBtn.addEventListener('click', function() {
        importPesticideFromGov(rec);
        container.innerHTML = '';
      });
    }
  }

  function importPesticideFromGov(rec) {
    var productName = getRecField(rec, 'product') || t('תכשיר');
    var activeIngredient = getRecField(rec, 'active');
    var crop = getRecField(rec, 'crop');
    var pest = getRecField(rec, 'pest');
    var usage = getRecField(rec, 'usage');
    var conc = getRecField(rec, 'conc');
    var phi = getRecField(rec, 'phi');
    var dosage = getRecField(rec, 'dosage');
    var toxicity = getRecField(rec, 'toxicity');
    var form = getRecField(rec, 'form');
    var regNum = getRecField(rec, 'reg');
    var labelUrl = getRecField(rec, 'label');

    // Check if crop matches user's crops (non-admin only)
    var userCrops = getUserCropTypes();
    if (currentUser && currentUser.role !== 'admin' && userCrops.length > 0 && crop) {
      var cropLower = crop.toLowerCase();
      var match = userCrops.some(function(uc) { 
        var ucl = uc.toLowerCase();
        return cropLower.indexOf(ucl) !== -1 || ucl.indexOf(cropLower) !== -1 ||
          cropLower.replace(/ים$/, '').indexOf(ucl.replace(/ים$/, '')) !== -1 ||
          ucl.replace(/ים$/, '').indexOf(cropLower.replace(/ים$/, '')) !== -1;
      });
      if (!match) {
        showToast('⚠️ ' + crop + ' ' + t('לא רלוונטי לגידולים שלך'));
        return;
      }
    }

    var exists = pesticides.find(function(p) {
      return p.productName === productName && p.activeIngredient === activeIngredient && p.crop === crop;
    });
    if (exists) {
      showToast('ℹ️ ' + productName + ' (' + crop + ') ' + t('כבר קיים'));
      return;
    }

    var maxId = pesticides.length > 0 ? Math.max.apply(null, pesticides.map(function(p) { return p.id; })) : 0;
    pesticides.push({
      id: maxId + 1,
      productName: productName,
      activeIngredient: activeIngredient,
      defaultConcentration: 0,
      unit: '%',
      commonTargets: crop,
      crop: crop,
      pest: pest,
      usage: usage,
      concentration: conc,
      phi: phi,
      dosage: dosage,
      toxicity: toxicity,
      formulation: form,
      regNumber: regNum,
      labelUrl: labelUrl,
      source: 'data.gov.il'
    });
    saveData();
    showToast('✅ ' + productName + ' (' + crop + ') ' + t('נוסף'));
  }

  // ══════════════════════════════════
  // ── QUICK ACTIONS & RECEIPTS ──
  // ══════════════════════════════════

  var receipts = JSON.parse(localStorage.getItem('shorashim-receipts') || '[]');

  // ── Draggable Quick Actions FAB ──
  (function() {
    var fab = document.getElementById('fabQuick');
    var opts = document.getElementById('fabQuickOptions');
    var isDragging = false;
    var wasDragged = false;
    var startX, startY, startLeft, startTop;
    
    var savedPos = JSON.parse(localStorage.getItem('shorashim-fab-quick-pos') || 'null');
    if (savedPos) {
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = Math.min(savedPos.left, window.innerWidth - 60) + 'px';
      fab.style.top = Math.min(savedPos.top, window.innerHeight - 60) + 'px';
    }

    function onStart(cx, cy) { isDragging = true; wasDragged = false; var r = fab.getBoundingClientRect(); startX = cx; startY = cy; startLeft = r.left; startTop = r.top; fab.classList.add('dragging'); }
    function onMove(cx, cy) { if (!isDragging) return; var dx = cx - startX, dy = cy - startY; if (Math.abs(dx) > 5 || Math.abs(dy) > 5) wasDragged = true; fab.style.left = Math.max(0, Math.min(window.innerWidth - fab.offsetWidth, startLeft + dx)) + 'px'; fab.style.top = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, startTop + dy)) + 'px'; fab.style.right = 'auto'; fab.style.bottom = 'auto'; }
    function onEnd() { if (!isDragging) return; isDragging = false; fab.classList.remove('dragging'); localStorage.setItem('shorashim-fab-quick-pos', JSON.stringify({ left: fab.getBoundingClientRect().left, top: fab.getBoundingClientRect().top })); }

    fab.addEventListener('mousedown', function(e) { e.preventDefault(); onStart(e.clientX, e.clientY); });
    document.addEventListener('mousemove', function(e) { onMove(e.clientX, e.clientY); });
    document.addEventListener('mouseup', function() { onEnd(); });
    fab.addEventListener('touchstart', function(e) { var t = e.touches[0]; onStart(t.clientX, t.clientY); }, { passive: true });
    document.addEventListener('touchmove', function(e) { if (isDragging) { var t = e.touches[0]; onMove(t.clientX, t.clientY); } }, { passive: true });
    document.addEventListener('touchend', function() { onEnd(); });

    fab.addEventListener('click', function() {
      if (wasDragged) return;
      var isOpen = opts.classList.contains('show');
      opts.classList.toggle('show', !isOpen);
      fab.classList.toggle('open', !isOpen);
      if (!isOpen) {
        // Position menu above fab
        var r = fab.getBoundingClientRect();
        opts.style.right = (window.innerWidth - r.right) + 'px';
        opts.style.bottom = (window.innerHeight - r.top + 8) + 'px';
        opts.style.left = 'auto'; opts.style.top = 'auto';
        // Correct if off-screen
        setTimeout(function() {
          var mr = opts.getBoundingClientRect();
          if (mr.top < 0) { opts.style.bottom = 'auto'; opts.style.top = (r.bottom + 8) + 'px'; }
          if (mr.right > window.innerWidth) { opts.style.right = '8px'; }
          if (mr.left < 0) { opts.style.left = '8px'; opts.style.right = 'auto'; }
        }, 10);
      }
    });

    document.addEventListener('click', function(e) {
      if (!e.target.closest('#fabQuick') && !e.target.closest('#fabQuickOptions')) {
        opts.classList.remove('show');
        fab.classList.remove('open');
      }
    });
  })();

  // Quick worklog — switch to worklog tab
  document.getElementById('qaQuickWorklog').addEventListener('click', function() {
    document.getElementById('fabQuickOptions').classList.remove('show');
    document.getElementById('fabQuick').classList.remove('open');
    document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
    document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
    document.querySelector('[data-tab="worklog"]').classList.add('active');
    document.getElementById('tabWorklog').classList.add('active');
    activeTab = 'worklog';
    renderWorklogTab();
  });

  // Capture receipt — open camera
  document.getElementById('qaCaptureReceipt').addEventListener('click', function() {
    document.getElementById('fabQuickOptions').classList.remove('show');
    document.getElementById('fabQuick').classList.remove('open');
    showReceiptCaptureModal();
  });

  function showReceiptCaptureModal() {
    var userFarms = getUserFarms(currentUser);
    var farmOptions = '<option value="">' + t('— בחר מטע —') + '</option>';
    userFarms.forEach(function(farm) {
      farmOptions += '<option value="' + farm.id + '">' + locName(farm) + '</option>';
    });

    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'">' +
        '<div class="modal" style="max-width: 500px;">' +
          '<h2>📸 ' + t('צלם תעודת משלוח') + '</h2>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('מטע') + '</label>' +
            '<select class="form-input" id="receiptFarmSelect">' + farmOptions + '</select>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="form-label">' + t('תיאור') + '</label>' +
            '<input type="text" class="form-input" id="receiptDesc" placeholder="">' +
          '</div>' +
          '<div id="receiptPreviewArea" style="display: none; margin-bottom: 14px;">' +
            '<img id="receiptPreviewImg" style="width: 100%; border-radius: 10px; box-shadow: var(--shadow);">' +
          '</div>' +
          '<div style="display: flex; gap: 8px; margin-bottom: 14px;">' +
            '<button class="btn-submit" id="receiptCameraBtn" style="flex: 1; margin: 0;">📷 ' + t('צלם') + '</button>' +
            '<button class="btn-submit" id="receiptGalleryBtn" style="flex: 1; margin: 0; background: linear-gradient(135deg, #455a64, #607d8b);">🖼️ ' + t('גלריה') + '</button>' +
          '</div>' +
          '<button class="btn-submit" id="receiptSaveBtn" style="display: none;">💾 ' + t('שמור') + '</button>' +
          '<div class="modal-buttons" style="margin-top: 12px;">' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('ביטול') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    var capturedImageData = null;

    // Camera button
    document.getElementById('receiptCameraBtn').addEventListener('click', function() {
      var input = document.getElementById('receiptFileInput');
      input.setAttribute('capture', 'environment');
      input.click();
    });

    // Gallery button
    document.getElementById('receiptGalleryBtn').addEventListener('click', function() {
      var input = document.getElementById('receiptFileInput');
      input.removeAttribute('capture');
      input.click();
    });

    // File selected
    document.getElementById('receiptFileInput').onchange = function(e) {
      var file = e.target.files[0];
      if (!file) return;
      compressImage(file, 800, 0.7, function(dataUrl) {
        capturedImageData = dataUrl;
        document.getElementById('receiptPreviewImg').src = dataUrl;
        document.getElementById('receiptPreviewArea').style.display = 'block';
        document.getElementById('receiptSaveBtn').style.display = 'block';
      });
      // Reset input so same file can be re-selected
      e.target.value = '';
    };

    // Save
    document.getElementById('receiptSaveBtn').addEventListener('click', function() {
      var farmId = parseInt(document.getElementById('receiptFarmSelect').value);
      if (!farmId) { showToast('❌ ' + t('יש לבחור מטע')); return; }
      if (!capturedImageData) { showToast('❌ ' + t('יש לצלם תמונה')); return; }

      var farm = farms.find(function(f) { return f.id === farmId; });
      var receipt = {
        id: Date.now(),
        farm_id: farmId,
        farm_name: farm ? farm.name : '',
        description: document.getElementById('receiptDesc').value.trim() || '',
        image: capturedImageData,
        date: new Date().toLocaleDateString('he-IL'),
        created_at: new Date().toISOString(),
        operator: currentUser ? currentUser.name : ''
      };

      receipts.unshift(receipt);
      // Keep max 50 receipts to avoid localStorage overflow
      if (receipts.length > 50) receipts = receipts.slice(0, 50);
      DB.save('shorashim-receipts', receipts);

      showToast('✅ ' + t('תעודה נשמרה'));
      container.innerHTML = '';
    });
  }

  // Image compression
  function compressImage(file, maxDim, quality, callback) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        var w = img.width;
        var h = img.height;
        if (w > maxDim || h > maxDim) {
          if (w > h) { h = Math.round(h * maxDim / w); w = maxDim; }
          else { w = Math.round(w * maxDim / h); h = maxDim; }
        }
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        callback(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // Receipt gallery in farm details
  function getReceiptsForFarm(farmId) {
    return receipts.filter(function(r) { return r.farm_id === farmId; });
  }

  function renderReceiptGallery(farmId) {
    var farmReceipts = getReceiptsForFarm(farmId);
    if (farmReceipts.length === 0) {
      return '<div style="padding: 10px; text-align: center; color: var(--text-muted); font-size: 0.85rem;">' + t('אין תעודות') + '</div>';
    }
    var html = '<div class="receipt-grid">';
    farmReceipts.forEach(function(r) {
      html += '<div class="receipt-thumb" data-receipt-id="' + r.id + '">' +
        '<img src="' + r.image + '" alt="">' +
        '<div class="receipt-date">' + r.date + '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  function showReceiptFullView(receiptId) {
    var r = receipts.find(function(x) { return x.id === receiptId; });
    if (!r) return;
    var container = document.getElementById('modalContainer');
    container.innerHTML =
      '<div class="modal-overlay" onclick="if(event.target===this) document.getElementById(\'modalContainer\').innerHTML=\'\'" style="padding: 10px;">' +
        '<div class="modal" style="max-width: 600px; padding: 16px;">' +
          '<img src="' + r.image + '" style="width: 100%; border-radius: 10px; margin-bottom: 12px;">' +
          '<div style="font-weight: 600; font-size: 0.95rem;">' + (r.description || t('תעודת משלוח')) + '</div>' +
          '<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 4px;">' +
            '🌳 ' + r.farm_name + ' • ' + r.date + ' • 👤 ' + r.operator +
          '</div>' +
          '<div class="modal-buttons" style="margin-top: 14px;">' +
            '<button class="btn btn-primary" id="receiptDeleteBtn">🗑️ ' + t('מחק') + '</button>' +
            '<button class="btn btn-secondary" onclick="document.getElementById(\'modalContainer\').innerHTML=\'\'">' + t('סגור') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('receiptDeleteBtn').addEventListener('click', function() {
      receipts = receipts.filter(function(x) { return x.id !== receiptId; });
      DB.save('shorashim-receipts', receipts);
      showToast('🗑️ ' + t('תעודה נמחקה'));
      container.innerHTML = '';
    });
  }


  function applyTranslations() {
    // Direction
    var isRtl = currentLang !== 'th';
    document.documentElement.setAttribute('dir', isRtl ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', currentLang);
    
    // Translate tabs using stored Hebrew key (immune to language state)
    document.querySelectorAll('.tab[data-t-key]').forEach(function(tab) {
      var key = tab.getAttribute('data-t-key');
      var text = tab.textContent.trim();
      // Extract emoji prefix (first 1-2 chars)
      var emoji = '';
      for (var i = 0; i < text.length; i++) {
        var code = text.codePointAt(i);
        if (code > 0xFFFF) { emoji += String.fromCodePoint(code); i++; }
        else if (code === 0xFE0F || text[i] === ' ') { emoji += text[i]; }
        else break;
      }
      if (!emoji) emoji = text.substring(0, 2) + ' ';
      tab.textContent = emoji + t(key);
    });
    
    // Translate select options with data-t-val
    document.querySelectorAll('[data-t-val]').forEach(function(opt) {
      opt.textContent = t(opt.getAttribute('data-t-val'));
    });
    
    // Update language button label
    document.getElementById('langBtn').textContent = LANG_LABELS[currentLang] || currentLang;
    
    // Header
    var h1 = document.querySelector('.header h1');
    if (h1) h1.textContent = t('שורשים פלוס');
    var sub = document.querySelector('.header .subtitle');
    if (sub) sub.textContent = t('פלטפורמה לניהול חקלאי');
    
    // Panel title
    var panelTitle = document.querySelector('.panel-title');
    if (panelTitle) panelTitle.textContent = t('חלקות מסומנות');

    // Layer toggle
    var layerText = document.getElementById('layerText');
    if (layerText) layerText.textContent = isSatellite ? t('רחוב') : t('לוויין');
    
    // Re-render ALL dynamic content — this is the nuclear option that guarantees
    // every render function rebuilds with current t() values
    reRenderActiveContent();
    
    // Translate ALL remaining [data-t-key] elements (buttons, h3, divs, spans, etc.)
    document.querySelectorAll('[data-t-key]').forEach(function(el) {
      // Skip tabs — already handled above with emoji logic
      if (el.classList.contains('tab')) return;
      // Skip section-title and form-label — handled in reRenderActiveContent
      if (el.classList.contains('section-title') || el.classList.contains('form-label')) return;
      var key = el.getAttribute('data-t-key');
      var text = el.textContent.trim();
      // Extract emoji prefix
      var emoji = '';
      for (var i = 0; i < text.length; i++) {
        var code = text.codePointAt(i);
        if (code > 0xFFFF) { emoji += String.fromCodePoint(code); i++; }
        else if (code === 0xFE0F || text[i] === ' ') { emoji += text[i]; }
        else break;
      }
      var translated = t(key);
      // If element has child elements (like <br>), just set textContent for simple elements
      if (el.children.length === 0) {
        el.textContent = (emoji || '') + translated;
      }
    });
    
    // Translate title attributes
    document.querySelectorAll('[data-t-title]').forEach(function(el) {
      el.setAttribute('title', t(el.getAttribute('data-t-title')));
    });
    
    // Translate placeholder attributes
    document.querySelectorAll('[data-t-placeholder]').forEach(function(el) {
      el.setAttribute('placeholder', t(el.getAttribute('data-t-placeholder')));
    });
  }
  
  function reRenderActiveContent() {
    // Always re-render plot list (visible on map tab)
    renderPlotList();
    
    // Re-render the active tab
    if (activeTab === 'spray') {
      renderPlotCheckboxes();
      renderPesticideList();
      updateCalculations();
      // History sub-view (if currently shown) also needs to refresh on lang change.
      var histEl = document.getElementById('spraySubviewHistory');
      if (histEl && histEl.style.display !== 'none') renderHistoryList();
    } else if (activeTab === 'profile') {
      renderProfileTab();
    } else if (activeTab === 'worklog') {
      renderWorklogTab();
    } else if (activeTab === 'farms') {
      renderFarmsAdminList();
    } else if (activeTab === 'users') {
      renderUsersAdminList();
    } else if (activeTab === 'admin') {
      renderPesticideAdminList();
    }
    
    // Translate static HTML section titles and form labels that aren't in render functions
    document.querySelectorAll('.section-title[data-t-key]').forEach(function(el) {
      var key = el.getAttribute('data-t-key');
      var emoji = '';
      var text = el.textContent.trim();
      for (var i = 0; i < text.length; i++) {
        var code = text.codePointAt(i);
        if (code > 0xFFFF) { emoji += String.fromCodePoint(code); i++; }
        else if (code === 0xFE0F || text[i] === ' ') { emoji += text[i]; }
        else break;
      }
      el.textContent = (emoji || '') + t(key);
    });
    document.querySelectorAll('.form-label[data-t-key]').forEach(function(el) {
      el.textContent = t(el.getAttribute('data-t-key'));
    });
  }
  
  // Language cycle: he → th → ar → he
  document.getElementById('langBtn').addEventListener('click', function() {
    var idx = LANGUAGES.indexOf(currentLang);
    currentLang = LANGUAGES[(idx + 1) % LANGUAGES.length];
    localStorage.setItem('shorashim-lang', currentLang);
    applyTranslations();
    // Re-render dynamically generated elements that use tt()/t()
    if (typeof TimeClock !== 'undefined' && TimeClock.renderClockBar) TimeClock.renderClockBar();
    if (typeof renderViewerDashboard === 'function') renderViewerDashboard();
    showToast(currentLang === 'he' ? '🇮🇱 עברית' : currentLang === 'th' ? '🇹🇭 ภาษาไทย' : '🇸🇦 العربية');
  });
  
  // Apply saved language on load
  if (currentLang !== 'he') {
    setTimeout(function() {
      applyTranslations();
      if (typeof TimeClock !== 'undefined' && TimeClock.renderClockBar) TimeClock.renderClockBar();
      if (typeof renderViewerDashboard === 'function') renderViewerDashboard();
    }, 300);
  }

  // ── Sound System (Web Audio API — tiny procedural sounds, no files needed) ──
  var sfxCtx = null;
  var sfxMuted = localStorage.getItem('shorashim-sfx-muted') === 'true';

  function sfxInit() {
    if (sfxCtx) return;
    try { sfxCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch(e) {}
  }

  function sfxPlay(type) {
    if (sfxMuted || !sfxCtx) return;
    try {
      var osc = sfxCtx.createOscillator();
      var gain = sfxCtx.createGain();
      osc.connect(gain);
      gain.connect(sfxCtx.destination);
      var now = sfxCtx.currentTime;

      if (type === 'tap') {
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.06);
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
        osc.start(now); osc.stop(now + 0.06);
      } else if (type === 'success') {
        osc.frequency.setValueAtTime(523, now);
        osc.frequency.setValueAtTime(659, now + 0.1);
        osc.frequency.setValueAtTime(784, now + 0.2);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.start(now); osc.stop(now + 0.35);
      } else if (type === 'error') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(200, now);
        osc.frequency.exponentialRampToValueAtTime(120, now + 0.15);
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        osc.start(now); osc.stop(now + 0.15);
      } else if (type === 'punch') {
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.08);
        osc.frequency.exponentialRampToValueAtTime(600, now + 0.15);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now); osc.stop(now + 0.2);
      }
    } catch(e) {}
  }

  window.toggleSfxMute = function() {
    sfxMuted = !sfxMuted;
    localStorage.setItem('shorashim-sfx-muted', sfxMuted);
    showToast(sfxMuted ? '🔇' : '🔊');
  };

  // Init audio on first user interaction
  document.addEventListener('click', function() { sfxInit(); }, { once: true });

  // ── Ripple Effect ──
  document.addEventListener('click', function(e) {
    var btn = e.target.closest('button, .btn-admin, .btn-submit, .tab, .fab-main, .fab-option-icon');
    if (!btn || btn.classList.contains('no-ripple')) return;
    var rect = btn.getBoundingClientRect();
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    var size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.style.overflow = 'hidden';
    if (getComputedStyle(btn).position === 'static') btn.style.position = 'relative';
    btn.appendChild(ripple);
    setTimeout(function() { ripple.remove(); }, 500);
  });

  // ── Toast ──
  function showToast(msg) {
    // Determine sound from message content
    if (msg.indexOf('✅') !== -1 || msg.indexOf('💾') !== -1 || msg.indexOf('📋') !== -1) sfxPlay('success');
    else if (msg.indexOf('❌') !== -1) sfxPlay('error');
    else if (msg.indexOf('🟢') !== -1 || msg.indexOf('🔴') !== -1) sfxPlay('punch');
    else sfxPlay('tap');

    var toastEl = document.getElementById('toast');
    toastEl.textContent = msg;
    toastEl.className = 'toast show';
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(function() {
      toastEl.classList.add('hide');
      setTimeout(function() { toastEl.className = 'toast'; }, 300);
    }, 2400);
  }

  // ── TALGIL IRRIGATION ──
  var talgilValves = [];
  var talgilPrograms = [];
  var valvePlotMap = {};
  var talgilDataLoaded = false;

  // Load cached Talgil data from Firestore on init
  function loadTalgilCache() {
    return Promise.all([
      DB.loadAsync('shorashim-valve-plot-map').then(function(data) {
        if (data && typeof data === 'object') valvePlotMap = data;
      }),
      DB.loadAsync('shorashim-talgil-cache').then(function(data) {
        if (data) {
          if (Array.isArray(data.valves) && data.valves.length) talgilValves = data.valves;
          if (Array.isArray(data.programs) && data.programs.length) talgilPrograms = data.programs;
          talgilDataLoaded = true;
        }
      })
    ]).catch(function(e) { console.warn('Talgil cache load:', e.message); });
  }

  // Save valve/program data to Firestore cache after each fetch
  function saveTalgilCache() {
    try {
      DB.save('shorashim-talgil-cache', {
        valves: talgilValves,
        programs: talgilPrograms,
        lastFetch: Date.now()
      });
    } catch(e) { console.warn('Talgil cache save:', e.message); }
  }

  // Auto-reconnect: if config exists, fetch fresh data silently
  function talgilAutoReconnect() {
    var cfg = getTalgilConfig();
    if (!cfg.host || !cfg.controllerId || !cfg.apiKey || !cfg.user) return;
    // Only auto-reconnect if we have cached data (user connected before)
    if (!talgilDataLoaded) return;
    // Silently refresh in background
    talgilFetch('valves', 'uid|name|nomFlow|area|line|state').then(function(data) {
      if (Array.isArray(data)) {
        talgilValves = data;
        talgilFetch('programs', 'uid|name|state|sequence|startTime|daysCycle|runList|valves|waterPlanned|waterDosageMode').then(function(pdata) {
          if (Array.isArray(pdata)) talgilPrograms = pdata;
          saveTalgilCache();
          // Re-render if irrigation tab is active
          if (document.querySelector('.tab-content.active #irrigationContent')) {
            renderPlotIrrigationView();
          }
        });
      }
    }).catch(function(e) { console.warn('Talgil auto-reconnect:', e.message); });
  }

  function safeProgramsList() {
    return Array.isArray(talgilPrograms) ? talgilPrograms : [];
  }

  function safeValvesList() {
    return Array.isArray(talgilValves) ? talgilValves : [];
  }

  function getTalgilConfig() {
    var saved = JSON.parse(localStorage.getItem('shorashim-talgil-config') || '{}');
    return {
      host: document.getElementById('talgilHost').value.trim() || saved.host || '',
      controllerId: document.getElementById('talgilControllerId').value.trim() || saved.controllerId || '',
      user: document.getElementById('talgilUser').value.trim() || saved.user || '',
      pass: document.getElementById('talgilPass').value.trim() || saved.pass || '',
      apiKey: document.getElementById('talgilApiKey').value.trim() || saved.apiKey || ''
    };
  }

  function saveTalgilConfig(cfg) {
    DB.save('shorashim-talgil-config', {
      host: cfg.host, controllerId: cfg.controllerId, user: cfg.user, pass: cfg.pass, apiKey: cfg.apiKey
    });
  }

  function renderIrrigationTab() {
    var isAdmin = currentUser && currentUser.role === 'admin';
    var saved = JSON.parse(localStorage.getItem('shorashim-talgil-config') || '{}');

    // Admin: show settings + mapping
    if (isAdmin) {
      if (saved.host) document.getElementById('talgilHost').value = saved.host;
      if (saved.controllerId) document.getElementById('talgilControllerId').value = saved.controllerId;
      if (saved.user) document.getElementById('talgilUser').value = saved.user;
      if (saved.pass) document.getElementById('talgilPass').value = saved.pass;
      if (saved.apiKey) document.getElementById('talgilApiKey').value = saved.apiKey;
      document.getElementById('talgilSettingsCard').style.display = '';
      if (safeValvesList().length > 0) {
        document.getElementById('mappingCard').style.display = '';
        renderMappingUI();
      }
    }

    // All users: auto-connect if config exists and no data yet
    if (saved.host && saved.apiKey && safeValvesList().length === 0) {
      autoConnectTalgil(saved);
    } else if (safeValvesList().length > 0) {
      renderPlotIrrigationView();
      renderProgramsList();
      document.getElementById('programsCard').style.display = '';
    }
  }

  async function autoConnectTalgil(cfg) {
    var statusEl = document.getElementById('plotIrrigationList');
    statusEl.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--text-muted);">⏳ ' + t('טוען נתוני השקיה...') + '</div>';
    try {
      // Set hidden inputs for talgilFetch to use
      document.getElementById('talgilHost').value = cfg.host;
      document.getElementById('talgilControllerId').value = cfg.controllerId;
      document.getElementById('talgilUser').value = cfg.user;
      document.getElementById('talgilPass').value = cfg.pass;
      document.getElementById('talgilApiKey').value = cfg.apiKey;
      talgilValves = await talgilFetch('valves', 'uid|name|nomFlow|area|line|state');
      await delay(2000);
      talgilPrograms = await talgilFetch('programs', 'uid|name|state|sequence|startTime|daysCycle|runList|valves|waterPlanned|waterDosageMode');
      renderPlotIrrigationView();
      renderProgramsList();
      document.getElementById('programsCard').style.display = '';
      if (currentUser && currentUser.role === 'admin') {
        document.getElementById('mappingCard').style.display = '';
        renderMappingUI();
      }
    } catch (e) {
      statusEl.innerHTML = '<div style="text-align: center; padding: 16px; color: var(--danger);">❌ ' + e.message + '</div>';
    }
  }

  function getPlotValves(plotId) {
    var result = [];
    for (var uid in valvePlotMap) {
      if (valvePlotMap[uid] == plotId) {
        var valve = safeValvesList().find(function(v) { return v.uid === uid; });
        if (valve) result.push(valve);
      }
    }
    return result;
  }

  // Compact irrigation summary for plot cards in מטעים tab
  // (old getPlotIrrigationBadge removed — new version below with robust matching)

  // Detailed irrigation view for plot detail popup
  function getPlotIrrigationHtml(plotId) {
    var pValves = getPlotValves(plotId);
    if (pValves.length === 0) {
      return '<div style="padding: 10px; text-align: center; color: var(--text-muted); font-size: 0.82rem;">' + t('אין מגופים משויכים') + '</div>';
    }
    var html = '';
    pValves.forEach(function(v) {
      var stateColor = v.state === 1 ? '#4caf50' : v.state === 5 ? '#f44336' : '#9e9e9e';
      html += '<div style="padding: 8px; background: var(--g6); border-radius: 8px; margin-bottom: 6px; border-right: 3px solid ' + stateColor + ';">';
      html += '<div style="display: flex; justify-content: space-between; align-items: center;">';
      html += '<span style="font-weight: 600; font-size: 0.85rem;">' + v.name + '</span>';
      html += '<span style="font-size: 0.78rem;">' + valveStateText(v.state) + '</span>';
      html += '</div>';
      html += '<div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">' + t('ספיקה:') + ' ' + v.nomFlow + ' ' + t('קוב/ש') + ' &nbsp;|&nbsp; ' + t('שטח:') + ' ' + v.area + ' ' + t("ד'") + '</div>';

      var vProgs = getValveProgramEntries(v.uid);
      if (vProgs.length > 0) {
        html += '<div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">';
        vProgs.forEach(function(vp) {
          var groupLabel = 'G' + (vp.groupIndex + 1);
          html += '<span style="background: #e3f2fd; color: #1565c0; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem;">';
          html += vp.progName + ' ' + groupLabel + ': ' + vp.water + ' ' + dosageModeText(vp.mode) + ' 🕐' + vp.start;
          if (vp.cycle > 0) html += ' (' + t('כל') + ' ' + vp.cycle + ' ' + t('ימים') + ')';
          html += '</span>';
        });
        html += '</div>';
      }

      html += '</div>';
    });
    return html;
  }

  // Normalize valve UID and program sequence labels to a common format for matching
  // Valve UIDs: "11:1", "11:16" etc. Sequence labels: "1.1", "1.16", "11:1" etc.
  function normalizeValveId(id) {
    if (!id) return '';
    // Strip any leading zeros, normalize separator to '.'
    return String(id).replace(/:/g, '.').replace(/^0+/, '');
  }

  function valveMatchesSeqLabel(valveUid, seqLabel) {
    var a = normalizeValveId(valveUid);
    var b = normalizeValveId(seqLabel);
    if (a === b) return true;
    // Also try: if valve UID has a long prefix (e.g. "11:1") and seq uses short ("1.1")
    // Strip the first digit from the valve prefix: "11" → "1"
    var aParts = a.split('.');
    var bParts = b.split('.');
    if (aParts.length === 2 && bParts.length === 2) {
      // Compare just the line and valve numbers, ignoring leading digits on line
      if (aParts[1] === bParts[1]) {
        // Check if one line is a suffix of the other
        if (aParts[0].endsWith(bParts[0]) || bParts[0].endsWith(aParts[0])) return true;
      }
    }
    return false;
  }

  // Find all programs that reference a specific valve
  function getValveProgramEntries(valveUid) {
    var result = [];
    safeProgramsList().filter(function(p) { return isProgramActive(p.state); }).forEach(function(prog) {
      var seqParts = prog.sequence ? prog.sequence.split(' > ') : [];
      if (!prog.valves) return;
      prog.valves.forEach(function(pv, i) {
        var seqLabel = (seqParts[i] || '').trim();
        if (valveMatchesSeqLabel(valveUid, seqLabel)) {
          result.push({
            progName: prog.name,
            groupLabel: seqLabel,
            groupIndex: i,
            totalGroups: prog.valves.length,
            water: pv.waterPlanned,
            mode: pv.waterDosageMode != null ? pv.waterDosageMode : prog.waterDosageMode,
            cycle: prog.daysCycle,
            start: formatStartTime(prog.startTime),
            sequence: prog.sequence
          });
        }
      });
    });
    return result;
  }

  // Compact irrigation summary for plot cards in מטעים tab
  function getPlotIrrigationBadge(plotId) {
    var pValves = getPlotValves(plotId);
    if (pValves.length === 0) return '';

    // Collect all program entries for all valves in this plot
    var allEntries = [];
    pValves.forEach(function(v) {
      getValveProgramEntries(v.uid).forEach(function(entry) {
        entry.valveName = v.name;
        entry.valveUid = v.uid;
        entry.valveState = v.state;
        allEntries.push(entry);
      });
    });

    if (allEntries.length === 0) {
      // Has valves but no active programs — show valve dots
      var statesHtml = '';
      pValves.forEach(function(v) {
        var sColor = v.state === 1 ? '#4caf50' : v.state === 5 ? '#f44336' : '#bbb';
        statesHtml += '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + sColor + ';margin-left:2px;"></span>';
      });
      return '<div style="display:flex;align-items:center;gap:4px;margin-top:4px;font-size:0.72rem;color:var(--text-muted);">💧 ' + pValves.length + ' ' + t('מגופים') + ' ' + statesHtml + '</div>';
    }

    // Group entries by program
    var byProg = {};
    allEntries.forEach(function(e) {
      if (!byProg[e.progName]) byProg[e.progName] = { entries: [], cycle: e.cycle, start: e.start, sequence: e.sequence };
      byProg[e.progName].entries.push(e);
    });

    var html = '';
    Object.keys(byProg).forEach(function(progName) {
      var pg = byProg[progName];
      html += '<div style="margin-top:4px;padding:5px 8px;background:rgba(74,144,217,0.08);border-radius:8px;border-right:3px solid var(--water);">';
      
      // Program header: name + cycle
      html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:0.72rem;">';
      html += '<span style="color:var(--water);font-weight:800;">💧 ' + progName + '</span>';
      html += '<span style="color:var(--text-muted);">';
      if (pg.cycle > 0) html += t('כל') + ' ' + pg.cycle + ' ' + t('ימים') + ' · ';
      html += '🕐 ' + pg.start;
      html += '</span></div>';
      
      // Groups: G1 → G2 with dosage for this plot's valves
      html += '<div style="display:flex;flex-wrap:wrap;gap:3px;margin-top:3px;">';
      pg.entries.forEach(function(entry, i) {
        var modeLabel = entry.mode === 2 ? t('קוב') + '/' + t("ד'") : entry.mode === 1 ? t('קוב') : t('דקות');
        var groupNum = 'G' + (entry.groupIndex + 1);
        html += '<span style="background:rgba(74,144,217,0.12);color:#0d47a1;padding:2px 7px;border-radius:5px;font-size:0.7rem;font-weight:700;">';
        html += groupNum + ': ' + entry.water + ' ' + modeLabel;
        html += '</span>';
      });
      html += '</div>';
      html += '</div>';
    });

    return html;
  }

  function renderPlotIrrigationView() {
    var el = document.getElementById('plotIrrigationList');
    var accessiblePlots = getAccessiblePlots();
    var html = '';
    var hasAny = false;

    accessiblePlots.forEach(function(plot) {
      var pValves = getPlotValves(plot.id);
      if (pValves.length === 0) return;
      hasAny = true;

      html += '<div style="background: var(--g6); border-radius: 12px; padding: 14px; margin-bottom: 10px;">';
      html += '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 10px;">';
      html += '<div style="width: 12px; height: 12px; border-radius: 50%; background: ' + plot.color + ';"></div>';
      html += '<span style="font-weight: 700; font-size: 1rem;">' + locName(plot) + '</span>';
      html += '<span style="font-size: 0.75rem; color: var(--text-muted); margin-right: auto;">' + formatArea(plot.area) + '</span>';
      html += '</div>';

      // Valves for this plot
      html += '<div style="display: grid; gap: 6px;">';
      pValves.forEach(function(v) {
        var stateColor = v.state === 1 ? '#4caf50' : v.state === 5 ? '#f44336' : '#9e9e9e';
        html += '<div style="display: flex; align-items: center; gap: 8px; background: var(--card); border-radius: 8px; padding: 8px 10px; border-right: 3px solid ' + stateColor + ';">';
        html += '<div style="flex: 1;">';
        html += '<div style="font-weight: 600; font-size: 0.85rem;">' + v.name + '</div>';
        html += '<div style="font-size: 0.75rem; color: var(--text-muted);">';
        html += t('ספיקה:') + ' ' + v.nomFlow + ' ' + t('קוב/ש') + ' &nbsp;|&nbsp; ' + t('שטח:') + ' ' + v.area + ' ' + t("ד'");        html += '</div>';

        // Find programs for this valve using robust matching
        var vProgs = getValveProgramEntries(v.uid);

        if (vProgs.length > 0) {
          html += '<div style="margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px;">';
          vProgs.forEach(function(vp) {
            var groupLabel = 'G' + (vp.groupIndex + 1);
            html += '<span style="background: #e3f2fd; color: #1565c0; padding: 2px 6px; border-radius: 4px; font-size: 0.7rem;">';
            html += vp.progName + ' ' + groupLabel + ': ' + vp.water + ' ' + dosageModeText(vp.mode) + ' 🕐' + vp.start;
            if (vp.cycle > 0) html += ' (' + t('כל') + ' ' + vp.cycle + ' ' + t('ימים') + ')';
            html += '</span>';
          });
          html += '</div>';
        }

        html += '</div>';
        html += '<div style="font-size: 0.9rem;">' + valveStateText(v.state) + '</div>';
        html += '</div>';
      });
      html += '</div>';
      html += '</div>';
    });

    if (!hasAny) {
      if (safeValvesList().length === 0) {
        html = '<div style="text-align: center; padding: 24px; color: var(--text-muted);">';
        html += '<div style="font-size: 2rem; margin-bottom: 8px;">💧</div>';
        html += currentUser && currentUser.role === 'admin'
          ? '<div>' + t('התחבר לתלגיל למעלה ושייך מגופים לחלקות') + '</div>'
          : '<div>' + t('אין עדיין נתוני השקיה') + '</div>';
        html += '</div>';
      } else {
        html = '<div style="text-align: center; padding: 24px; color: var(--text-muted);">';
        html += '<div style="font-size: 2rem; margin-bottom: 8px;">🗺️</div>';
        html += currentUser && currentUser.role === 'admin'
          ? '<div>' + t('שייך מגופים לחלקות בחלק למטה') + '</div>'
          : '<div>' + t('המנהל טרם שייך מגופים לחלקות שלך') + '</div>';
        html += '</div>';
      }
    }

    el.innerHTML = html;
  }

  function delay(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

  async function talgilFetch(endpoint, filter) {
    var cfg = getTalgilConfig();
    if (!cfg.host || !cfg.controllerId || !cfg.apiKey || !cfg.user) {
      throw new Error('missing config');
    }

    // Get Firebase auth token for the proxy
    var authToken = '';
    try { authToken = await firebase.auth().currentUser.getIdToken(); } catch(e) {}

    var resp = await fetch('/api/talgil', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + authToken
      },
      body: JSON.stringify({
        host: cfg.host,
        controllerId: cfg.controllerId,
        user: cfg.user,
        pass: cfg.pass,
        apiKey: cfg.apiKey,
        endpoint: endpoint,
        filter: filter || ''
      })
    });

    if (!resp.ok) {
      var err = {};
      try { err = await resp.json(); } catch(e) {}
      throw new Error(err.error || 'HTTP ' + resp.status);
    }
    return resp.json();
  }

  window.talgilConnect = async function() {
    var statusEl = document.getElementById('talgilStatus');
    var btn = document.getElementById('talgilConnectBtn');
    statusEl.textContent = '⏳ ' + t('מתחבר...');
    statusEl.style.color = 'var(--text-muted)';
    btn.disabled = true;
    try {
      var cfg = getTalgilConfig();
      saveTalgilConfig(cfg);
      talgilValves = await talgilFetch('valves', 'uid|name|nomFlow|area|line|state');
      statusEl.textContent = '⏳ ' + t('טוען תוכניות...');
      await delay(2000);
      talgilPrograms = await talgilFetch('programs', 'uid|name|state|sequence|startTime|daysCycle|runList|valves|waterPlanned|waterDosageMode');
      statusEl.textContent = '✅ ' + t('מחובר —') + ' ' + safeValvesList().length + ' ' + t('מגופים') + ', ' + talgilPrograms.length + ' ' + t('תוכניות');
      statusEl.style.color = 'var(--g3)';
      document.getElementById('programsCard').style.display = '';
      document.getElementById('mappingCard').style.display = '';
      renderPlotIrrigationView();
      renderProgramsList();
      renderMappingUI();
      saveTalgilCache();
    } catch (e) {
      statusEl.textContent = '❌ ' + t('שגיאה') + ': ' + e.message;
      statusEl.style.color = 'var(--danger)';
    }
    btn.disabled = false;
  };

  window.talgilRefreshValves = async function() {
    try {
      talgilValves = await talgilFetch('valves', 'uid|name|nomFlow|area|line|state');
      await delay(2000);
      talgilPrograms = await talgilFetch('programs', 'uid|name|state|sequence|startTime|daysCycle|runList|valves|waterPlanned|waterDosageMode');
      renderPlotIrrigationView();
      renderProgramsList();
      renderMappingUI();
      saveTalgilCache();
      showToast('🔄 ' + t('נתונים עודכנו'));
    } catch (e) {
      showToast('❌ ' + e.message);
    }
  };

  function valveStateText(s) {
    var states = { 0: '⚪ ' + t('סגור'), 1: '🟢 ' + t('פתוח'), 5: '🔴 ' + t('תקלה'), 7: '🟡 ' + t('ממתין') };
    return states[s] || (t('מצב') + ' ' + s);
  }

  function renderValvesList() {
    var el = document.getElementById('valvesList');
    var html = '<table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">';
    html += '<tr style="background: var(--g6); font-weight: 600;">';
    html += '<td style="padding: 6px 8px;">' + t('מגוף') + '</td><td>' + t('קו') + '</td><td>' + t('ספיקה (קוב/ש)') + '</td><td>' + t('שטח (ד\')') + '</td><td>' + t('מצב') + '</td></tr>';
    safeValvesList().forEach(function(v) {
      var plotName = valvePlotMap[v.uid] ? plots.find(function(p) { return p.id === valvePlotMap[v.uid]; }) : null;
      html += '<tr style="border-bottom: 1px solid #eee;">';
      html += '<td style="padding: 6px 8px; font-weight: 500;">' + v.name + '</td>';
      html += '<td>' + v.line + '</td>';
      html += '<td>' + v.nomFlow + '</td>';
      html += '<td>' + v.area + '</td>';
      html += '<td>' + valveStateText(v.state) + '</td>';
      html += '</tr>';
      if (plotName) {
        html += '<tr><td colspan="5" style="padding: 2px 8px 6px; font-size: 0.75rem; color: var(--g3);">🗺️ ' + plotName.name + '</td></tr>';
      }
    });
    html += '</table>';
    el.innerHTML = html;
  }

  function formatStartTime(arr) {
    if (!arr || !arr[0]) return '—';
    var mins = arr[0];
    var h = Math.floor(mins / 60);
    var m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function dosageModeText(m) {
    return m === 1 ? t('קוב') : m === 2 ? t('קוב/ד\'') : t('דקות');
  }

  function isProgramActive(state) {
    // Hide: 1=not ready, 5=finished+failure, 8=frozen, 14=finished, 15=incomplete
    var inactive = [1, 5, 8, 14, 15];
    return inactive.indexOf(state) === -1;
  }

  function renderProgramsList() {
    var el = document.getElementById('programsList');
    var html = '';
    safeProgramsList().filter(function(p) { return isProgramActive(p.state); }).forEach(function(prog) {
      var seqParts = prog.sequence.split(' > ');
      html += '<div style="background: var(--g6); border-radius: 10px; padding: 12px; margin-bottom: 8px;">';
      html += '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">';
      html += '<span style="font-weight: 700; font-size: 1rem;">' + prog.name + '</span>';
      html += '<span style="font-size: 0.8rem; background: var(--card); padding: 2px 8px; border-radius: 6px;">🕐 ' + formatStartTime(prog.startTime) + '</span>';
      html += '</div>';
      html += '<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 6px;">';
      html += t('מחזור:') + ' ' + (prog.daysCycle === 0 ? t('ידני') : t('כל') + ' ' + prog.daysCycle + ' ' + t('ימים'));
      html += ' &nbsp;|&nbsp; ' + t('רצף:') + ' ' + prog.sequence;
      html += '</div>';
      if (prog.valves && prog.valves.length > 0) {
        html += '<div style="display: flex; flex-wrap: wrap; gap: 4px;">';
        prog.valves.forEach(function(pv, i) {
          var label = seqParts[i] || (t('מגוף') + ' ' + (i + 1));
          html += '<span style="background: var(--card); padding: 3px 8px; border-radius: 6px; font-size: 0.75rem;">';
          html += label + ': ' + pv.waterPlanned + ' ' + dosageModeText(pv.waterDosageMode);
          html += '</span>';
        });
        html += '</div>';
      }
      html += '</div>';
    });
    el.innerHTML = html || '<div style="color: var(--text-muted); text-align: center;">' + t('אין תוכניות') + '</div>';
  }

  function renderMappingUI() {
    var el = document.getElementById('mappingList');
    var accessiblePlots = (typeof getAccessiblePlots === 'function') ? getAccessiblePlots() : plots;
    var html = '';
    safeValvesList().forEach(function(v) {
      html += '<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; padding: 8px; background: var(--g6); border-radius: 8px;">';
      html += '<span style="font-weight: 600; min-width: 90px; font-size: 0.85rem;">' + v.name + '</span>';
      html += '<span style="font-size: 0.75rem; color: var(--text-muted); min-width: 65px;">' + v.nomFlow + ' ' + t('קוב/ש') + '</span>';
      html += '<select data-valve-uid="' + v.uid + '" style="flex: 1; padding: 6px 8px; border-radius: 8px; border: 1px solid #ccc; font-family: inherit; font-size: 0.85rem;">';
      html += '<option value="">— ' + t('בחר חלקה') + ' —</option>';
      accessiblePlots.forEach(function(p) {
        var sel = (valvePlotMap[v.uid] == p.id) ? ' selected' : '';
        html += '<option value="' + p.id + '"' + sel + '>' + locName(p) + ' (' + p.area.toFixed(1) + ' ' + t('ד\'') + ')</option>';
      });
      html += '</select>';
      html += '</div>';
    });
    el.innerHTML = html || '<div style="color: var(--text-muted); text-align: center;">' + t('חבר תלגיל קודם') + '</div>';
  }

  window.saveValvePlotMapping = function() {
    var selects = document.querySelectorAll('#mappingList select[data-valve-uid]');
    valvePlotMap = {};
    selects.forEach(function(sel) {
      var uid = sel.getAttribute('data-valve-uid');
      if (sel.value) valvePlotMap[uid] = parseInt(sel.value);
    });
    DB.save('shorashim-valve-plot-map', valvePlotMap);
    renderPlotIrrigationView();
    renderMappingUI();
    showToast('💾 ' + t('שיוך מגופים נשמר'));
  };


  // ── VIEWER CLOCK DASHBOARD ──
  window.renderViewerDashboard = function() {
    if (!currentUser) return;
    var username = currentUser.username;

    // Period calculation
    var periodEl = document.getElementById('viewerPeriod');
    var period = periodEl ? periodEl.value : 'month';
    var now = new Date();
    var fromDate, toDate;

    if (period === 'week') {
      var day = now.getDay(); // 0=Sun
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - day);
      fromDate.setHours(0, 0, 0, 0);
      toDate = now;
    } else if (period === 'month') {
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      toDate = now;
    } else if (period === 'year') {
      fromDate = new Date(now.getFullYear(), 0, 1);
      toDate = now;
    } else if (period === 'custom') {
      var customDates = document.getElementById('viewerCustomDates');
      if (customDates) customDates.style.display = 'block';
      var fromVal = document.getElementById('viewerDateFrom').value;
      var toVal = document.getElementById('viewerDateTo').value;
      if (!fromVal || !toVal) return;
      fromDate = new Date(fromVal);
      toDate = new Date(toVal);
      toDate.setHours(23, 59, 59);
    }

    // Hide custom dates if not custom
    if (period !== 'custom') {
      var customDates = document.getElementById('viewerCustomDates');
      if (customDates) customDates.style.display = 'none';
    }

    var fromStr = fromDate.toISOString().slice(0, 10);
    var toStr = toDate.toISOString().slice(0, 10);

    // Update clock display
    updateViewerClockDisplay();

    // Update task button with pending count
    if (typeof TaskBoard !== 'undefined') {
      TaskBoard.getMyPendingCount(function(count) {
        var taskBtn = document.getElementById('viewerTaskBtn');
        if (taskBtn) {
          var label = t('המשימות שלי');
          taskBtn.textContent = '📋 ' + label + (count > 0 ? ' (' + count + ')' : '');
          if (count > 0) {
            taskBtn.style.background = '#7e57c2';
            taskBtn.style.color = 'white';
          }
        }
      });
    }

    // Query Firestore
    if (typeof db === 'undefined') return;
    db.collection('timeclock')
      .where('username', '==', username)
      .where('date', '>=', fromStr)
      .where('date', '<=', toStr)
      .orderBy('date', 'desc')
      .orderBy('punchIn', 'desc')
      .get()
      .then(function(snap) {
        var records = [];
        snap.forEach(function(doc) { records.push(doc.data()); });
        
        // Stats
        var uniqueDays = {};
        var totalMs = 0;
        records.forEach(function(r) {
          if (r.date) uniqueDays[r.date] = true;
          if (r.duration) totalMs += r.duration;
        });

        var daysEl = document.getElementById('viewerDays');
        var hoursEl = document.getElementById('viewerHours');
        var shiftsEl = document.getElementById('viewerShifts');
        if (daysEl) daysEl.textContent = Object.keys(uniqueDays).length;
        if (hoursEl) hoursEl.textContent = (totalMs / 3600000).toFixed(1);
        if (shiftsEl) shiftsEl.textContent = records.length;

        // Table
        var tableEl = document.getElementById('viewerRecordsTable');
        if (!tableEl) return;
        if (records.length === 0) {
          tableEl.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:16px;">' + t('אין רשומות בתקופה') + '</div>';
          return;
        }

        var html = '<table style="width:100%;border-collapse:collapse;font-size:0.8rem;">';
        html += '<tr style="background:var(--g6);font-weight:700;">';
        html += '<td style="padding:6px;">' + t('תאריך') + '</td><td>' + t('מקום') + '</td><td>' + t('כניסה') + '</td><td>' + t('יציאה') + '</td><td>' + t('שעות') + '</td></tr>';

        records.forEach(function(r) {
          var pIn = new Date(r.punchIn);
          var hIn = (pIn.getHours() < 10 ? '0' : '') + pIn.getHours() + ':' + (pIn.getMinutes() < 10 ? '0' : '') + pIn.getMinutes();
          var hOut = '—';
          if (r.punchOut) {
            var pOut = new Date(r.punchOut);
            hOut = (pOut.getHours() < 10 ? '0' : '') + pOut.getHours() + ':' + (pOut.getMinutes() < 10 ? '0' : '') + pOut.getMinutes();
          }
          var dur = r.duration ? (r.duration / 3600000).toFixed(1) : '—';
          html += '<tr style="border-bottom:1px solid #eee;">';
          html += '<td style="padding:6px;">' + (r.date || '') + '</td>';
          html += '<td>' + (r.workplace || '—') + '</td>';
          html += '<td>' + hIn + '</td>';
          html += '<td>' + hOut + '</td>';
          html += '<td>' + dur + '</td></tr>';
        });
        html += '</table>';
        tableEl.innerHTML = html;
      })
      .catch(function(err) {
        console.error('Viewer records error:', err);
        var tableEl = document.getElementById('viewerRecordsTable');
        if (tableEl) tableEl.innerHTML = '<div style="color:red;text-align:center;padding:8px;">' + t('שגיאה') + ': ' + err.message + '</div>';
      });
  };

  function updateViewerClockDisplay() {
    var iconEl = document.getElementById('viewerClockIcon');
    var timeEl = document.getElementById('viewerClockTime');
    var statusEl = document.getElementById('viewerClockStatus');
    var btnEl = document.getElementById('viewerPunchBtn');
    if (!iconEl) return;

    var shift = localStorage.getItem('shorashim-current-shift');
    if (shift) {
      try { shift = JSON.parse(shift); } catch(e) { shift = null; }
    }

    if (shift) {
      iconEl.textContent = '🟢';
      statusEl.textContent = shift.workplace || t('בעבודה');
      if (btnEl) {
        btnEl.textContent = '🔴 ' + t('יציאה');
        btnEl.style.background = '#f44336';
        btnEl.setAttribute('onclick', 'TimeClock.punchOut(); setTimeout(renderViewerDashboard, 500);');
      }
      // Start updating time
      if (!window._viewerClockTimer) {
        window._viewerClockTimer = setInterval(function() {
          var s = localStorage.getItem('shorashim-current-shift');
          if (s) {
            try { s = JSON.parse(s); } catch(e) { return; }
            var elapsed = Date.now() - s.punchIn;
            var h = Math.floor(elapsed / 3600000);
            var m = Math.floor((elapsed % 3600000) / 60000);
            var sec = Math.floor((elapsed % 60000) / 1000);
            if (timeEl) timeEl.textContent = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
          }
        }, 1000);
      }
    } else {
      iconEl.textContent = '⚪';
      timeEl.textContent = '00:00:00';
      statusEl.textContent = t('לא בשעון');
      if (btnEl) {
        btnEl.textContent = '🟢 ' + t('כניסה');
        btnEl.style.background = '#4caf50';
        btnEl.setAttribute('onclick', 'TimeClock.punchIn(); setTimeout(renderViewerDashboard, 500);');
      }
      if (window._viewerClockTimer) {
        clearInterval(window._viewerClockTimer);
        window._viewerClockTimer = null;
      }
    }
  }

  // ── NOTIFICATION BADGE ──
  window.updateNotificationBadge = function() {
    var badge = document.getElementById('menuBadge');
    if (!badge || !window.currentUser) return;
    
    var username = window.currentUser.username;
    var count = 0;
    
    // Count pending tasks assigned to this user
    try {
      var tasks = JSON.parse(localStorage.getItem('shorashim-tasks') || '[]');
      var lastSeen = parseInt(localStorage.getItem('shorashim-badge-seen-' + username) || '0');
      
      tasks.forEach(function(t) {
        if (t.assignedTo === username && t.status === 'pending') {
          // Count as new if created after last seen
          if (t.created && t.created > lastSeen) count++;
        }
      });
    } catch(e) {}
    
    if (count > 0) {
      badge.textContent = count > 9 ? '9+' : count;
      badge.style.display = 'block';
    } else {
      badge.style.display = 'none';
    }
  };

  // Mark notifications as seen when menu is opened
  window.markBadgeSeen = function() {
    if (!window.currentUser) return;
    localStorage.setItem('shorashim-badge-seen-' + window.currentUser.username, String(Date.now()));
    var badge = document.getElementById('menuBadge');
    if (badge) badge.style.display = 'none';
  };

  // ── FIRESTORE REALTIME SYNC ──
  // Listen for changes from other devices and refresh UI.
  // Started from enterApp AFTER sign-in. These used to register at
  // script load, before auth resolved: an onSnapshot listener that
  // errors with permission-denied is closed permanently and never
  // retries, so on any device that landed on the login screen every
  // realtime listener died pre-auth and cross-device sync stayed dead
  // until a full reload.
  var _rtStarted = false;
  function startRealtimeSync() {
    if (_rtStarted) return;
    if (typeof DB === 'undefined' || typeof db === 'undefined') return;
    _rtStarted = true;
    DB.listen('plotMapperSprayData', function(data) {
      if (data) {
        _applyPlotData(data);
      }
    });

    DB.listen('shorashim-users', function(data) {
      if (data) users = data;
    });

    DB.listen('shorashim-valve-plot-map', function(data) {
      if (data) {
        valvePlotMap = data;
        // Re-render irrigation if tab is active
        if (document.querySelector('.tab-content.active #irrigationContent')) {
          renderPlotIrrigationView();
          renderMappingUI();
        }
      }
    });

    DB.listen('shorashim-talgil-cache', function(data) {
      if (data) {
        if (Array.isArray(data.valves) && data.valves.length) talgilValves = data.valves;
        if (Array.isArray(data.programs) && data.programs.length) talgilPrograms = data.programs;
        talgilDataLoaded = true;
      }
    });

    // Load Talgil cache and auto-reconnect
    loadTalgilCache().then(function() {
      talgilAutoReconnect();
    });

    DB.listen('shorashim-crop-types', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-crop-types', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-workplaces', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-workplaces', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-tasks', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-tasks', JSON.stringify(data));
        updateNotificationBadge();
      }
    });

    DB.listen('shorashim-custom-actions', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-custom-actions', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-custom-budgets', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-custom-budgets', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-custom-worker-groups', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-custom-worker-groups', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-custom-work-types', function(data) {
      if (data) {
        localStorage.setItem('shorashim-custom-work-types', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-workers', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-workers', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-apps-script-url', function(data) {
      if (data) {
        localStorage.setItem('shorashim-apps-script-url', typeof data === 'string' ? data : JSON.stringify(data));
      }
    });

    DB.listen('shorashim-receipts', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-receipts', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-talgil-config', function(data) {
      if (data) {
        localStorage.setItem('shorashim-talgil-config', JSON.stringify(data));
      }
    });

    DB.listen('shorashim-field-reports', function(data) {
      if (data && Array.isArray(data)) {
        localStorage.setItem('shorashim-field-reports', JSON.stringify(data));
      }
    });

    // Initial load of all shared data from Firestore
    var sharedKeys = [
      'shorashim-crop-types', 'shorashim-workplaces', 'shorashim-custom-actions',
      'shorashim-custom-budgets', 'shorashim-custom-worker-groups', 'shorashim-custom-work-types',
      'shorashim-workers', 'shorashim-apps-script-url', 'shorashim-receipts', 'shorashim-talgil-config',
      'shorashim-field-reports'
    ];
    sharedKeys.forEach(function(key) {
      DB.loadAsync(key).then(function(data) {
        if (data !== null && data !== undefined) {
          localStorage.setItem(key, typeof data === 'string' ? data : JSON.stringify(data));
        }
      });
    });
  }
  // (end startRealtimeSync)
