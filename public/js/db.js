// ── Firestore Database Layer ──
// Wraps Firestore reads/writes. Falls back to localStorage if offline.

var DB = (function() {
  'use strict';

  var firestore = typeof db !== 'undefined' ? db : null;
  var cache = {};
  var saveTimers = {};

  // Debounce saves to avoid hammering Firestore
  function debouncedSave(key, data, delayMs) {
    if (saveTimers[key]) clearTimeout(saveTimers[key]);
    saveTimers[key] = setTimeout(function() {
      _writeFirestore(key, data);
    }, delayMs || 1000);
  }

  function _writeFirestore(key, data) {
    if (!firestore) return;
    // Firestore rejects undefined values — strip them
    var clean = JSON.parse(JSON.stringify(data));
    firestore.collection('appData').doc(key).set({ value: clean, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
      .then(function() { console.log('Firestore saved: ' + key); })
      .catch(function(err) { 
        console.error('Firestore write FAILED for ' + key + ':', err);
        if (typeof showToast === 'function') showToast('❌ Firestore: ' + err.message);
      });
  }

  // Save: writes to localStorage immediately + Firestore debounced
  function save(key, data) {
    var json = JSON.stringify(data);
    localStorage.setItem(key, json);
    cache[key] = data;
    // Write to Firestore immediately for critical data, debounced for others
    _writeFirestore(key, data);
  }

  // Load: tries cache first, then Firestore, falls back to localStorage
  function load(key, callback) {
    // Return cached value immediately if available
    if (cache[key] !== undefined) {
      callback(cache[key]);
      return;
    }

    // Try localStorage first for instant UI
    var local = localStorage.getItem(key);
    if (local) {
      try {
        cache[key] = JSON.parse(local);
        callback(cache[key]);
      } catch(e) {
        callback(null);
      }
    }

    // Then try Firestore for latest data
    if (!firestore) {
      if (!local) callback(null);
      return;
    }

    firestore.collection('appData').doc(key).get()
      .then(function(doc) {
        if (doc.exists && doc.data().value !== undefined) {
          var firestoreData = doc.data().value;
          cache[key] = firestoreData;
          localStorage.setItem(key, JSON.stringify(firestoreData));
          callback(firestoreData);
        } else if (!local) {
          callback(null);
        }
      })
      .catch(function(err) {
        console.warn('Firestore read error for ' + key + ':', err);
        if (!local) callback(null);
      });
  }

  // Load with promise
  function loadAsync(key) {
    return new Promise(function(resolve) {
      load(key, resolve);
    });
  }

  // Fresh load: bypasses the in-memory cache and localStorage and reads
  // Firestore directly. Used by the login flow — a device that loaded the
  // users list before an admin added a new user would otherwise keep
  // resolving with the stale cached copy and lock that user out. Updates
  // cache + localStorage on success; falls back to the normal (cached)
  // load only if Firestore is unreachable.
  function loadFresh(key) {
    // { source: 'server' } is the important part: enablePersistence is on,
    // and a plain get() silently serves Firestore's OWN offline cache when
    // the server is slow/unreachable — so the old loadFresh only bypassed
    // the app's cache, not Firestore's, and a device on a flaky connection
    // could keep resolving a stale users list ("admin added me but I'm
    // still locked out"). Server-only get rejects when offline, and only
    // then do we deliberately fall back to cached data.
    function _resolveDoc(doc, resolve) {
      if (doc.exists && doc.data().value !== undefined) {
        var data = doc.data().value;
        cache[key] = data;
        try { localStorage.setItem(key, JSON.stringify(data)); } catch(e) {}
        resolve(data);
      } else {
        resolve(null);
      }
    }
    return new Promise(function(resolve) {
      if (!firestore) { load(key, resolve); return; }
      firestore.collection('appData').doc(key).get({ source: 'server' })
        .then(function(doc) { _resolveDoc(doc, resolve); })
        .catch(function(err) {
          console.warn('Firestore server read failed for ' + key + ', falling back to cache:', err && err.message);
          firestore.collection('appData').doc(key).get()
            .then(function(doc) { _resolveDoc(doc, resolve); })
            .catch(function(err2) {
              console.warn('Firestore fresh read error for ' + key + ':', err2);
              load(key, resolve);
            });
        });
    });
  }

  // One read of the SERVER copy, with the outcome spelled out:
  //   { ok:true,  exists:true,  data }        the server has it
  //   { ok:true,  exists:false, data:null }   the server has nothing here
  //   { ok:false, error, data:<cached|null> }  we could not ask — this says
  //                                            NOTHING about what is stored
  // load() cannot express that. It calls back once or twice depending on
  // whether this browser happened to hold a local copy, and callers that
  // counted callbacks read a fresh browser's single, correct answer as "no
  // answer": maintenance waited out an 8-second timer on every new device,
  // every Incognito window and every browser whose storage was cleared, then
  // announced that the projects could not be loaded.
  function read(key) {
    return new Promise(function(resolve) {
      var local = null;
      try { var s = localStorage.getItem(key); if (s) local = JSON.parse(s); } catch (e) {}
      if (!firestore) { resolve({ ok: false, exists: false, data: local, error: 'no-firestore' }); return; }
      firestore.collection('appData').doc(key).get({ source: 'server' })
        .then(function(doc) {
          if (doc.exists && doc.data().value !== undefined) {
            var data = doc.data().value;
            cache[key] = data;
            try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) {}
            resolve({ ok: true, exists: true, data: data });
          } else {
            resolve({ ok: true, exists: false, data: null });
          }
        })
        .catch(function(err) {
          var code = (err && (err.code || err.message)) || 'error';
          console.warn('[DB] server read of ' + key + ' failed (' + code + ') \u2014 not treating as empty');
          resolve({ ok: false, exists: false, data: cache[key] !== undefined ? cache[key] : local, error: code });
        });
    });
  }

  // Delete a key
  function remove(key) {
    localStorage.removeItem(key);
    delete cache[key];
    if (firestore) {
      firestore.collection('appData').doc(key).delete()
        .catch(function(err) { console.warn('Firestore delete error:', err); });
    }
  }

  // Listen for realtime changes from other devices
  function listen(key, callback) {
    if (!firestore) return;
    firestore.collection('appData').doc(key).onSnapshot(function(doc) {
      if (doc.exists && doc.data().value !== undefined) {
        var data = doc.data().value;
        cache[key] = data;
        localStorage.setItem(key, JSON.stringify(data));
        callback(data);
      }
    }, function(err) {
      console.warn('Firestore listen error for ' + key + ':', err);
    });
  }

  return {
    save: save,
    load: load,
    loadAsync: loadAsync,
    loadFresh: loadFresh,
    read: read,
    remove: remove,
    listen: listen
  };
})();
