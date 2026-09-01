const CACHE = 'amrs-v1077';
const ASSETS = ['./', './index.html', './cloud-api.js?v=20260901d', './access-control.js?v=20260901d', './cvcs.js?v=20260901d', './cvcs.css?v=20260901d', './token-admin.js?v=20260901d', './xlsx.mini.min.js?v=20260901d', './galaxy-log.js?v=20260901d', './galaxy-log.css?v=20260901d', './manifest.json?v=20260901d', './sw.js'];

self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('script.google.com')) return;
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  const networkFirst = e.request.mode === 'navigate' ||
    /\/(?:index\.html|manifest\.json|sw\.js)$/.test(url.pathname);
  if (networkFirst) {
    e.respondWith(
      fetch(e.request, { cache: 'no-store' }).then(res => {
        if (!res.ok) return res;
        return caches.open(CACHE).then(c => c.put(e.request, res.clone())).then(() => res);
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
      if (!res.ok || res.type === 'opaque') return res;
      return caches.open(CACHE).then(c => c.put(e.request, res.clone())).then(() => res);
    }))
  );
});
