/* SUPER BOB — service worker: игра работает без интернета.
   Стратегия: префикс-кэш всех файлов игры + cache-first с фоновым
   обновлением. Версия кэша повышается при изменении набора файлов. */
const VER = 'bob5-offline-v1';
const CORE = [
  './',
  'index.html',
  'map/maps.js',
  'engine/bob_engine.js',
  'engine/levels_cache.js',
  'supabase-config.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];
const CDN = [
  'https://unpkg.com/@supabase/supabase-js@2.58.0/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.58.0/dist/umd/supabase.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(VER);
    await cache.addAll(CORE);                          // свои файлы — обязательно
    await Promise.all(CDN.map((u) =>                   // CDN Supabase — как получится (офлайн-доставки нет)
      cache.add(new Request(u, { mode: 'no-cors' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                    // POST в Supabase — только сеть
  const url = new URL(req.url);
  if (url.origin !== location.origin && !url.hostname.includes('supabase.co') &&
      !url.hostname.includes('unpkg.com') && !url.hostname.includes('jsdelivr.net')) return;

  e.respondWith((async () => {
    const cache = await caches.open(VER);
    const hit = await cache.match(req, { ignoreSearch: url.origin !== location.origin });
    if (hit) {                                         // cache-first + фоновое обновление
      if (url.origin === location.origin)
        fetch(req).then((r) => { if (r && r.ok) cache.put(req, r.clone()); }).catch(() => {});
      return hit;
    }
    try {
      const r = await fetch(req);
      if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone());
      return r;
    } catch (err) {                                    // сети нет, в кэше пусто
      if (req.mode === 'navigate') {
        const idx = await cache.match('index.html');
        if (idx) return idx;
      }
      throw err;
    }
  })());
});
