const CACHE = 'gilgamesh-v1.2';
const PRECACHE = [
  './',
  './index.html',
  './manifest.json',
  './img/logo.svg',
  './js/main.js',
  './js/state.js',
  './js/constants.js',
  './js/ids.js',
  './js/storage.js',
  './js/peer.js',
  './js/mesh.js',
  './js/election.js',
  './js/messaging.js',
  './js/rooms.js',
  './js/files.js',
  './js/ui.js',
  './js/utils.js',
];

self.addEventListener('install',  e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => e.respondWith(caches.match(e.request).then(r => r || fetch(e.request))));
