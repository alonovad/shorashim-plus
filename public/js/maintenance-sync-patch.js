// ═══════════════════════════════════════════════════════════════════
// MAINTENANCE MODULE — DATA LAYER PATCH (Firestore Sync Fix)
// ═══════════════════════════════════════════════════════════════════
//
// WHAT THIS FIXES:
//   1. loadAsync resolves on first callback (localStorage), ignoring Firestore
//   2. No DB.listen() — changes on one device don't appear on another
//   3. Pre-existing localStorage data never migrated to Firestore
//
// HOW TO APPLY:
//   Replace the following functions in maintenance.js:
//     - saveProjects()
//     - loadProjects()
//     - saveAccess()    (if it exists)
//     - loadAccess()    (if it exists)
//   Then add the _initSync() call (see bottom of this file).
//
// ═══════════════════════════════════════════════════════════════════

  // ── Sync internals ──
  var _projectsCache = null;   // in-memory cache, kept in sync by listener
  var _accessCache = null;
  var _syncInitialized = false;
  var _migrationDone = {};     // tracks per-key migration status

  // Core fix: DB.load() calls its callback twice — first localStorage (fast),
  // then Firestore (slow). DB.loadAsync wraps it in a Promise that resolves
  // on the FIRST callback, so Firestore data is always ignored.
  // This function waits for the SECOND callback (Firestore) with a timeout
  // fallback so we don't hang if Firestore is offline.
  function _loadFromFirestore(key) {
    return new Promise(function(resolve) {
      if (typeof DB === 'undefined') {
        try { resolve(JSON.parse(localStorage.getItem(key) || '[]')); }
        catch (e) { resolve([]); }
        return;
      }
      var callCount = 0;
      var localData = null;
      var settled = false;

      // Safety net: if Firestore never responds (offline, rules block, etc),
      // fall back to localStorage data after 4 seconds
      var timer = setTimeout(function() {
        if (!settled) {
          settled = true;
          console.warn('[Maintenance] Firestore timeout for ' + key + ', using localStorage');
          resolve(localData || []);
        }
      }, 4000);

      DB.load(key, function(data) {
        callCount++;
        if (callCount === 1) {
          // First callback = localStorage (fast). Stash it as fallback.
          localData = data;
        } else {
          // Second callback = Firestore (authoritative). Use it.
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(data || []);
          }
        }
      });
    });
  }

  // One-time migration: if Firestore is empty but localStorage has data,
  // push localStorage data to Firestore. This handles data that was created
  // before the Firestore rules whitelist was fixed.
  function _migrateIfNeeded(key) {
    if (_migrationDone[key]) return Promise.resolve(null);
    _migrationDone[key] = true;

    return _loadFromFirestore(key).then(function(firestoreData) {
      // Firestore already has data — no migration needed
      if (firestoreData && firestoreData.length > 0) {
        console.log('[Maintenance] ' + key + ': Firestore has ' + firestoreData.length + ' items, no migration needed');
        return firestoreData;
      }

      // Firestore is empty — check localStorage for orphaned data
      var localData = [];
      try { localData = JSON.parse(localStorage.getItem(key) || '[]'); }
      catch (e) { /* corrupt localStorage, nothing to migrate */ }

      if (localData.length > 0 && typeof DB !== 'undefined') {
        console.log('[Maintenance] Migrating ' + key + ' to Firestore (' + localData.length + ' items from localStorage)');
        DB.save(key, localData);
        return localData;
      }

      return firestoreData || [];
    });
  }

  // ── Realtime listeners ──
  // DB.listen(key, callback) uses Firestore onSnapshot — any change on ANY
  // device triggers the callback on ALL devices, including the one that wrote.
  function _initSync() {
    if (_syncInitialized || typeof DB === 'undefined' || typeof DB.listen !== 'function') return;
    _syncInitialized = true;

    // Migrate first, then set up listeners
    _migrateIfNeeded('shorashim-maintenance').then(function(data) {
      _projectsCache = data || [];

      DB.listen('shorashim-maintenance', function(freshData) {
        var newData = freshData || [];
        // Only re-render if data actually changed (avoid loops on own writes)
        if (JSON.stringify(newData) !== JSON.stringify(_projectsCache)) {
          console.log('[Maintenance] Realtime update: shorashim-maintenance (' + newData.length + ' projects)');
          _projectsCache = newData;
          _onProjectsChanged();
        } else {
          _projectsCache = newData;
        }
      });
    });

    _migrateIfNeeded('shorashim-maintenance-access').then(function(data) {
      _accessCache = data || {};

      DB.listen('shorashim-maintenance-access', function(freshData) {
        var newData = freshData || {};
        if (JSON.stringify(newData) !== JSON.stringify(_accessCache)) {
          console.log('[Maintenance] Realtime update: shorashim-maintenance-access');
          _accessCache = newData;
        } else {
          _accessCache = newData;
        }
      });
    });
  }

  // Called when projects data changes from another device.
  // Re-renders the current view if the maintenance modal is open.
  function _onProjectsChanged() {
    var modal = document.getElementById('modalContainer');
    if (!modal || !modal.innerHTML) return;
    // Check if we're showing the projects list (look for a known element)
    if (modal.querySelector('[data-maint-view="list"]')) {
      showProjectsList();
    }
    // If showing a project detail, re-render it
    var detailEl = modal.querySelector('[data-maint-project-id]');
    if (detailEl) {
      var pid = parseInt(detailEl.getAttribute('data-maint-project-id'));
      var activeTab = detailEl.getAttribute('data-maint-active-tab') || 'materials';
      if (pid) showDetail(pid, activeTab);
    }
  }

  // ── Public data functions (replacements) ──

  function saveProjects(projects) {
    _projectsCache = projects;
    if (typeof DB !== 'undefined') DB.save('shorashim-maintenance', projects);
    else localStorage.setItem('shorashim-maintenance', JSON.stringify(projects));
  }

  function loadProjects() {
    // If cache is already populated (by listener or prior load), use it
    if (_projectsCache !== null) return Promise.resolve(_projectsCache);

    // First load: wait for Firestore, with migration
    return _migrateIfNeeded('shorashim-maintenance').then(function(data) {
      _projectsCache = data || [];
      return _projectsCache;
    });
  }

  function saveAccess(access) {
    _accessCache = access;
    if (typeof DB !== 'undefined') DB.save('shorashim-maintenance-access', access);
    else localStorage.setItem('shorashim-maintenance-access', JSON.stringify(access));
  }

  function loadAccess() {
    if (_accessCache !== null) return Promise.resolve(_accessCache);

    return _migrateIfNeeded('shorashim-maintenance-access').then(function(data) {
      _accessCache = data || {};
      return _accessCache;
    });
  }


// ═══════════════════════════════════════════════════════════════════
// INTEGRATION INSTRUCTIONS
// ═══════════════════════════════════════════════════════════════════
//
// 1. In maintenance.js, find and REPLACE these 4 functions:
//      saveProjects, loadProjects, saveAccess, loadAccess
//    with the versions above (everything between "Sync internals"
//    and "Public data functions" is new helper code that goes
//    right before them).
//
// 2. Add a data attribute to your projects list container so the
//    listener can detect which view is active:
//
//    In showProjectsList(), add to the outer wrapper div:
//      data-maint-view="list"
//
//    In showDetail(), add to the detail wrapper div:
//      data-maint-project-id="<pid>"  data-maint-active-tab="<tab>"
//
// 3. Call _initSync() once when the module loads.
//    At the very end of the IIFE, just before the return { ... },
//    add:
//
//      // Initialize realtime sync
//      _initSync();
//
// 4. Firestore rules (ALREADY DONE in your last session):
//    Verify that firestore.rules includes both:
//      'shorashim-maintenance'
//      'shorashim-maintenance-access'
//    in the admin write whitelist.
//
// 5. Deploy:
//      git add . && git commit -m "fix: maintenance Firestore sync" && git push
//      firebase deploy
//    Then hard-refresh (Ctrl+Shift+R) or clear SW cache.
//
// ═══════════════════════════════════════════════════════════════════
