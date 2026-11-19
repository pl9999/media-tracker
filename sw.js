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

  // Network first (so you get new versions), but on a slow connection fall back to the saved copy after 1.5 seconds
  // instead of leaving the app waiting.
  event.respondWith(new Promise(function(resolve) {
    var settled = false;
    function done(res) { if (!settled && res) { settled = true; resolve(res); } }
    var timer = setTimeout(function() { caches.match(req).then(done); }, 1500);

    fetch(req).then(function(res) {
      clearTimeout(timer);
      if (res && res.ok) {
        var copy = res.clone();
        caches.open(CACHE).then(function(c) { c.put(req, copy); });
      }
      done(res);
    }).catch(function() {
      clearTimeout(timer);
      caches.match(req)
        .then(function(hit) { return hit || caches.match('index.html'); })
        .then(function(hit) { done(hit || Response.error()); });
    });
  }));
});
