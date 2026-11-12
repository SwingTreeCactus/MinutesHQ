/* Lets the app open without a connection (for example, a meeting room with no wifi).
   App files: try the network first so updates show up, fall back to the saved copy.
   Libraries from the CDN: saved copy first. Database and Anthropic calls are never cached. */
const CACHE = 'minutes-hq-v4';
const SHELL = [
  './', 'index.html', 'my.html', 'privacy.html', 'terms.html', 'css/app.css',
  'js/config.js', 'js/common.js', 'js/icons.js', 'js/vault.js', 'js/pdf.js', 'js/live.js', 'js/meeting.js', 'js/app.js', 'js/my.js',
  'manifest.webmanifest', 'icons/app-192.png', 'icons/app-512.png'
];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('index.html'))));
});
