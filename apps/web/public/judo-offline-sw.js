const CACHE = 'judo-operator-shell-v1';
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  if (event.data?.type !== 'PREPARE') return;
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(CACHE);
        const urls = event.data.urls.filter((value) => {
          const u = new URL(value, self.location.origin);
          return (
            u.origin === self.location.origin &&
            (u.pathname.startsWith('/operator/') ||
              u.pathname.startsWith('/_next/static/') ||
              u.pathname.startsWith('/flags/'))
          );
        });
        await cache.addAll([...new Set(urls)]);
        event.ports[0].postMessage({ ok: true });
      } catch {
        event.ports[0].postMessage({ ok: false });
      }
    })(),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const navigation = event.request.mode === 'navigate' && url.pathname.startsWith('/operator/');
  if (
    !navigation &&
    !url.pathname.startsWith('/_next/static/') &&
    !url.pathname.startsWith('/flags/')
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(event.request);
        if (!response.ok) throw new Error('unavailable');
        if (navigation) await cache.put(url.pathname, response.clone());
        else await cache.put(event.request, response.clone());
        return response;
      } catch {
        return (await cache.match(navigation ? url.pathname : event.request)) || Response.error();
      }
    })(),
  );
});
