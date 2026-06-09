var CACHE_NAME = 'shorashim-v1';
var URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/db.js',
  '/js/timeclock.js',
  '/js/taskboard.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js'
];

// Install — cache all core files
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(URLS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(
        names.filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) { return caches.delete(name); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — serve from cache first, then network
self.addEventListener('fetch', function(event) {
  // Skip non-GET and Firebase/API requests
  if (event.request.method !== 'GET') return;
  var url = event.request.url;
  if (url.indexOf('firestore.googleapis.com') !== -1) return;
  if (url.indexOf('identitytoolkit.googleapis.com') !== -1) return;
  if (url.indexOf('securetoken.googleapis.com') !== -1) return;
  if (url.indexOf('corsproxy.io') !== -1) return;

  event.respondWith(
    caches.match(event.request).then(function(cached) {
      // Return cache immediately, update in background
      var fetchPromise = fetch(event.request).then(function(response) {
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(function() {
        return cached;
      });
      return cached || fetchPromise;
    })
  );
});
