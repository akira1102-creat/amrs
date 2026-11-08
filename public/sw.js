const CACHE='amrs-v1152';
const ASSETS=['./','./index.html','./bootstrap.mjs?v=20261108a','./bootstrap.css?v=20261108a','./access-control.js?v=20261108a','./manifest.json?v=20261108a','./icon.png?v=23','./apple-touch-icon.png?v=23'];
self.addEventListener('message',e=>{if(e.data?.type==='SKIP_WAITING')self.skipWaiting();});
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE&&/^(amrs-v|akira-ml-v)/.test(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{
 if(e.request.method!=='GET'||new URL(e.request.url).origin!==self.location.origin)return;
 if(e.request.mode==='navigate'){
  e.respondWith(fetch(e.request,{cache:'no-store'}).then(async r=>{if(r.ok){const c=await caches.open(CACHE);await c.put('./index.html',r.clone());}return r;}).catch(async()=>await caches.match('./index.html')||Response.error()));return;
 }
 e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request)));
});
