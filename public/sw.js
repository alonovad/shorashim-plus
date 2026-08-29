var CACHE_NAME = 'shorashim-v64';
// CDN libs — these never change, safe to cache-first
var CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-functions-compat.js',
  'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.2/html2pdf.bundle.min.js'
];
// App files — these change on deploy, need network-first
var APP_URLS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/css/theme-neon.css',
  '/js/app.js',
  '/js/db.js',
  '/js/audit.js',
  '/js/sites.js',
  '/js/schedule.js',
  '/js/leave.js',
  '/js/timeclock.js',
  '/js/team.js',
  '/js/payroll.js',
  '/js/monthly-report.js',
  '/js/hours-report.js',
  '/js/taskboard.js',
  '/js/fieldreport.js',
  '/js/pestmonitor.js',
  '/js/orders.js',
  '/js/agriplan.js',
  '/js/display-settings.js',
  '/js/stickyactions.js',
  '/js/maintenance.js',
  '/js/maintenance-schedule.js',
  '/js/spray-pest-link.js',
  '/js/spray-reconstruct.js',
  '/js/spray-edit.js',
  '/js/spray-bulk.js',
  '/js/map-filter.js',
  '/js/report-map.js',
  '/js/report-theme.js',
  '/js/effects.js'
];
// Install — precache CDN libs + app files
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CDN_URLS.concat(APP_URLS));
    })
  );
  self.skipWaiting();
});
// Activate — purge ALL old caches
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
// Fetch strategy:
//   CDN libs → cache-first (immutable, versioned URLs)
//   App files → network-first (deploy changes visible immediately)
//   Firebase/API → passthrough (no caching)
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;
  var url = event.request.url;
  // Skip browser-extension requests (Cache API rejects non-http schemes)
  if (url.indexOf('chrome-extension://') === 0) return;
  if (url.indexOf('moz-extension://')    === 0) return;
  if (url.indexOf('safari-extension://') === 0) return;
  // Skip Firebase/API — let them pass through
  if (url.indexOf('firestore.googleapis.com') !== -1) return;
  if (url.indexOf('identitytoolkit.googleapis.com') !== -1) return;
  if (url.indexOf('securetoken.googleapis.com') !== -1) return;
  if (url.indexOf('securetoken.google.com') !== -1) return;
  if (url.indexOf('corsproxy.io') !== -1) return;
  if (url.indexOf('data.gov.il') !== -1) return;
  // CDN libs → cache-first (they never change)
  var isCDN = url.indexOf('cdnjs.cloudflare.com') !== -1 ||
              url.indexOf('gstatic.com/firebasejs') !== -1;
  if (isCDN) {
    event.respondWith(
      caches.match(event.request).then(function(cached) {
        return cached || fetch(event.request).then(function(response) {
          if (response && response.status === 200) {
            var clone = response.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, clone);
            });
          }
          return response;
        });
      })
    );
    return;
  }
  // App files → network-first (deploys visible immediately, offline fallback to cache)
  event.respondWith(
    fetch(event.request).then(function(response) {
      if (response && response.status === 200) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache) {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(function() {
      return caches.match(event.request);
    })
  );
});
