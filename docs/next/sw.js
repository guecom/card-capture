/* Generated candidate service worker — Kairen-Ref: TSK-000221 */
const CACHE = "cardcapture-next-7c9ae82b";
const CACHE_PREFIX = 'cardcapture-next-';
const SHELL = ["./","./index.html","./assets/index--eUN3Aew.css","./assets/index-B3XmyQsq.js","./assets/ionic-vendor-BbPQ-9pK.js","./assets/ionic-vendor-CUyx59f3.js","./assets/ionic-vendor-CVTHxLll.css","./assets/ionic-vendor-CiU0rtkT.js","./assets/ionic-vendor-CuW4BYHQ.js","./assets/ionic-vendor-DgmhXxri.js","./assets/ionic-vendor-DhlaSbu9.js","./assets/ionic-vendor-R6P8vIhy.js","./assets/ionic-vendor-eZh_lIPl.js","./assets/ionic-vendor-t8msffeW.js","./assets/opencv-worker-Dd-imctz.js","./assets/ort-wasm-simd-threaded-Cpm-ox6i.wasm","./assets/quickocr-worker-DhW31SJV.js","./assets/react-vendor-6WJR2M2w.js","./assets/react-vendor-BSh_wd36.js","./assets/react-vendor-CoIdssN8.js","./assets/react-vendor-q_3Li6vY.js","./assets/rolldown-runtime-BgaNhQyE.js","./assets/vendor-CMvJ8nte.js","./assets/vendor-CbRGSR0v.js","./assets/vendor-DFMJc7Ku.js"];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))
  )).then(() => self.clients.claim()));
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'CC_PING' && event.ports?.[0]) {
    event.ports[0].postMessage({ type: 'CC_PONG', cache: CACHE });
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const scopePath = new URL(self.registration.scope).pathname;
  const sharedRuntimePaths = [
    new URL('../vendor/tesseract/', self.registration.scope).pathname,
    new URL('../vendor/opencv.js', self.registration.scope).pathname,
    new URL('../vendor/paddleocr/', self.registration.scope).pathname,
    new URL('../vendor/ort/', self.registration.scope).pathname,
  ];
  const isSharedRuntime = sharedRuntimePaths.some((path) => url.pathname.startsWith(path));
  if (!url.pathname.startsWith(scopePath) && !isSharedRuntime) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: event.request.mode === 'navigate' }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => event.request.mode === 'navigate' ? caches.match('./index.html') : undefined);
    })
  );
});
