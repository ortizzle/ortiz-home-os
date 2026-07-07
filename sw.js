// sw.js — network-first shell with cache fallback. Online loads always get
// current code (prevents stale-code-vs-upgraded-DB crashes); offline still
// works from the last cached shell. Never touches api.github.com traffic.
// (Cache-first caused a real stuck-update bug in Ortiz Learning OS — keep
// this strategy.)

const CACHE = 'ohos-shell-v20';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './modules/store.js',
  './modules/ui.js',
  './modules/maintenance.js',
  './modules/chores.js',
  './modules/grocery.js',
  './modules/vendors.js',
  './modules/calendar.js',
  './modules/suggest.js',
  './modules/dashboard.js',
  './modules/meeting.js',
  './modules/ai.js',
  './modules/gcal.js',
  './modules/hmcontext.js',
  './modules/manager.js',
  './modules/meals.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never intercept Gist sync traffic or Google sign-in / Calendar API traffic.
  if (
    url.hostname.endsWith('github.com') ||
    url.hostname.endsWith('githubusercontent.com') ||
    url.hostname.endsWith('google.com') ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.endsWith('gstatic.com')
  ) {
    return;
  }
  if (e.request.method !== 'GET') return;

  // Network-first: fresh code whenever online, cached shell when offline.
  // cache:'no-cache' forces ETag revalidation past GitHub Pages' max-age=600,
  // so updates land immediately instead of up to 10 minutes late.
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok && url.origin === self.location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
