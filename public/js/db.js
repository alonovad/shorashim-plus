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
    firestore.collection('appData').doc(key).set({ value: data, updatedAt: firebase.firestore.FieldValue.serverTimestamp() })
      .catch(function(err) { console.warn('Firestore write error for ' + key + ':', err); });
  }

  // Save: writes to localStorage immediately + Firestore debounced
  function save(key, data) {
    var json = JSON.stringify(data);
    localStorage.setItem(key, json);
    cache[key] = data;
    debouncedSave(key, data);
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
    remove: remove,
    listen: listen
  };
})();
