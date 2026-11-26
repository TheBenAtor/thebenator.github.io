// Service worker: lets the game and editor be installed and used offline.
// Network-first, so a changed MOD/encounter.ini or script.js always shows up when online.
const CACHE = 'battle-engine-v2';
const SHELL = [
  './', 'index.html', 'GAME/script.js', 'editor/', 'editor/index.html',
  'manifest.webmanifest', 'pwa/icons/icon-192.png', 'pwa/icons/icon-512.png',
  'GAME/ASSETS/kris-sheet.jpg', 'GAME/ASSETS/rals-sheet.png', 'GAME/ASSETS/susie-sheet.png',
  'GAME/ASSETS/background.gif', 'GAME/ASSETS/fonts/determination.ttf',
  'MOD/encounter.ini'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c =>
    // one file at a time so a missing optional file can't break the install
    Promise.all(SHELL.map(u => c.add(u).catch(() => {})))
  ).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match(req, { ignoreSearch: true })))
  );
});
