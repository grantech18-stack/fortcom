// FORTCOM - Service Worker (modo app instalado)
// Bumpar a cada deploy: o 'activate' apaga o cache antigo, sem isso o celular
// que ja instalou o app continua servindo o index.html velho.
// (v9 = 04/09/2026: A2 PIN com hash, A3 merge de sync, A4 escape, M4-M7, L2/L4/L5/L8)
const CACHE='fortcom-v9';
const ARQUIVOS=[
  './',
  './index.html',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js'
];
// So entra no cache o que e nosso (mesma origem) ou o que o app precisa para
// abrir offline (SDK do Firebase e fontes). Antes qualquer GET era guardado
// (beacons, imagens externas...) sem teto — um app instalado por meses podia
// estourar a cota de cache do navegador (M7).
const ORIGENS_OK=[self.location.origin,'https://www.gstatic.com','https://fonts.googleapis.com','https://fonts.gstatic.com'];
const MAX_ENTRADAS=60;          // teto de entradas no cache (LRU simples: apaga as mais antigas)

function podeCachear(url){
  try{ const u=new URL(url); return ORIGENS_OK.indexOf(u.origin)>-1; }catch(e){ return false; }
}
async function limitarCache(c){
  const ks=await c.keys();
  let excesso=ks.length-MAX_ENTRADAS;
  // keys() devolve na ordem de insercao: as primeiras sao as mais antigas
  for(let i=0; excesso>0 && i<ks.length; i++){
    const entrada=ks[i];
    if(ARQUIVOS.some(a=>entrada.url===new URL(a,self.location.href).href)) continue;   // nunca apaga o essencial
    await c.delete(entrada); excesso--;
  }
}

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
  // nunca interferir na conversa com o Firestore / Auth
  if(u.indexOf('firestore.googleapis.com')>-1 || u.indexOf('googleapis.com/google.firestore')>-1 ||
     u.indexOf('identitytoolkit.googleapis.com')>-1 || u.indexOf('securetoken.googleapis.com')>-1) return;
  if(!podeCachear(u)) return;          // externo: vai direto para a rede, sem cache
  e.respondWith(
    fetch(e.request).then(r=>{
      if(r && (r.ok || r.type==='opaque')){
        const copia=r.clone();
        caches.open(CACHE).then(c=>c.put(e.request,copia).then(()=>limitarCache(c))).catch(()=>{});
      }
      return r;
    }).catch(()=>caches.match(e.request).then(r=>r||(e.request.mode==='navigate'?caches.match('./index.html'):undefined)))
  );
});
