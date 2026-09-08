const CACHE = 'amrs-v1109';
const ASSETS = ['./', './index.html', './cloud-api.js?v=20260908f', './access-control.js?v=20260908f', './cvcs.js?v=20260908f', './cvcs.css?v=20260908f', './token-admin.js?v=20260908f', './xlsx.mini.min.js?v=20260908f', './galaxy-log.js?v=20260908f', './galaxy-log.css?v=20260908f', './mgm-check-request.js?v=20260908f', './mgm-check-request.css?v=20260908f', './worksheet-editor.js?v=20260908f', './worksheet-editor.css?v=20260908f', './manifest.json?v=20260908f', './sw.js'];

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

  if (e.request.mode === 'navigate') {
    const update = fetch(e.request, { cache: 'no-store' }).then(async res => {
      if (res.ok) { const cache = await caches.open(CACHE); await cache.put('./index.html', res.clone()); }
      return res;
    });
    e.waitUntil(update.catch(() => {}));
    e.respondWith(caches.match('./index.html').then(cached => cached || update));
    return;
  }

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
