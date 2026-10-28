/* Media Tracker service worker: keeps the app itself (index.html, app.js, icon) available offline.
   Network first, so you always get the newest files when you are online. Library data is never cached here. */
var CACHE = 'mt-shell-v1';

self.addEventListener('install', function() { self.skipWaiting(); });

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(k) { return k !== CACHE; }).map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // TMDB images and the backend are never touched

  event.respondWith(
    fetch(req).then(function(res) {
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function(c) { c.put(req, copy); });
      }
      return res;
    }).catch(function() {
      return caches.match(req).then(function(hit) {
        return hit || caches.match('index.html') || caches.match('./');
      });
    })
  );
});
