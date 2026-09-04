// FORTCOM - Service Worker (modo app instalado)
// Bumpar a cada deploy: o 'activate' apaga o cache antigo, sem isso o celular
// que ja instalou o app continua servindo o index.html velho.
// (v8 = 04/09/2026: L11/L12 + EMAIL_PADRAO gran.tech18@gmail.com)
const CACHE='fortcom-v8';
const ARQUIVOS=[
  './',
  './index.html',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js'
];

self.addEventListener('install', e=>{
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c=>Promise.all(
    ARQUIVOS.map(u=>c.add(new Request(u,{mode:'no-cors'})).catch(()=>{}))
  )));
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch', e=>{
  if(e.request.method!=='GET') return;
  const u=e.request.url;
  // nunca interferir na conversa com o Firestore
  if(u.indexOf('firestore.googleapis.com')>-1 || u.indexOf('googleapis.com/google.firestore')>-1) return;
  e.respondWith(
    fetch(e.request).then(r=>{
      const copia=r.clone();
      caches.open(CACHE).then(c=>c.put(e.request,copia)).catch(()=>{});
      return r;
    }).catch(()=>caches.match(e.request).then(r=>r||caches.match('./index.html')))
  );
});
