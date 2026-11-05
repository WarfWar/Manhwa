const CACHE = 'manhwa-reader-v1';
const SHELL = ['./','./index.html','./assets/app.css','./assets/app.js','./assets/icon.svg','./data/catalog.json'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache)=>cache.addAll(SHELL)).then(()=>self.skipWaiting()).catch(()=>{}));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(Promise.all([self.clients.claim(),caches.keys().then((keys)=>Promise.all(keys.filter((k)=>k!==CACHE).map((k)=>caches.delete(k))))]));
});
self.addEventListener('fetch', (event) => {
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  event.respondWith(caches.match(req).then((cached)=>{
    const request=fetch(req).then((response)=>{
      if(response.ok){const copy=response.clone();caches.open(CACHE).then((cache)=>cache.put(req,copy)).catch(()=>{});}
      return response;
    }).catch(()=>cached);
    return cached||request;
  }));
});