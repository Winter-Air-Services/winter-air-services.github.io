/* Phase 6 — the page opens with no signal, once it has been opened once.

   Network first, the saved copy only when the network fails: a phone with signal always
   gets the newest page, and a phone in a dead zone still gets a page. Only this site's own
   page is kept — never a Supabase answer. The data a technician needs offline lives in the
   page's own local copy (see `db` in index.html), not here. */
const CACHE = 'ws-page-v4';
// version.js: so Settings → About still knows the version with no signal. app.js: the page's
// script, its own file since 2026-10-01 (the Content-Security-Policy runs no inline script).
const PAGE = ['./', './index.html', './app.js', './version.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PAGE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // Only this worker's own old page copies: 'ws-photos' is the page's house-photo cache.
    .then(keys => Promise.all(keys.filter(k => k.startsWith('ws-page-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // cache: 'no-cache' = always ask the server "has it changed?" (a 304 is cheap). Without
  // it the browser's own HTTP cache handed back an OLD page and this worker passed it on —
  // measured 2026-09-26: plain "/" showed the Phase 2 page after Phase 6 had shipped.
  const fresh = e.request.mode === 'navigate'
    ? fetch(e.request.url, {cache: 'no-cache', credentials: 'same-origin'})
    : fetch(e.request, {cache: 'no-cache'});
  e.respondWith(
    fresh
      .then(r => {
        if (r.ok && (e.request.mode === 'navigate' || PAGE.some(p => url.pathname.endsWith(p.slice(1)) ))) {
          const copy = r.clone();
          caches.open(CACHE).then(c => c.put(e.request.mode === 'navigate' ? './' : e.request, copy));
        }
        return r;
      })
      .catch(() => caches.match(e.request.mode === 'navigate' ? './' : e.request)
        .then(m => m || caches.match('./')))
  );
});
