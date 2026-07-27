/* Generated candidate service worker — Kairen-Ref: TSK-000221 */
const CACHE = "cardcapture-next-5776fd10";
const CACHE_PREFIX = 'cardcapture-next-';
const SHELL = ["./","./index.html","./assets/index-BCigPAVT.js","./assets/index-ez1pC1hY.css","./assets/ionic-vendor-BbPQ-9pK.js","./assets/ionic-vendor-CUyx59f3.js","./assets/ionic-vendor-CVTHxLll.css","./assets/ionic-vendor-CiU0rtkT.js","./assets/ionic-vendor-CuW4BYHQ.js","./assets/ionic-vendor-DgmhXxri.js","./assets/ionic-vendor-DhlaSbu9.js","./assets/ionic-vendor-R6P8vIhy.js","./assets/ionic-vendor-eZh_lIPl.js","./assets/ionic-vendor-t8msffeW.js","./assets/opencv-worker-Dd-imctz.js","./assets/ort-wasm-simd-threaded-Cpm-ox6i.wasm","./assets/quickocr-worker-DhW31SJV.js","./assets/react-vendor-6WJR2M2w.js","./assets/react-vendor-BSh_wd36.js","./assets/react-vendor-CoIdssN8.js","./assets/react-vendor-q_3Li6vY.js","./assets/rolldown-runtime-BgaNhQyE.js","./assets/vendor-BQ0mZAgW.js","./assets/vendor-pMrAHhNn.js","./assets/vendor-y8VdGQCW.js"];

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
        /* 주의: 이 런타임 캐시 쓰기는 실제로는 아무것도 저장하지 않는다. clone()이
           caches.open() 이후 마이크로태스크에서 평가되는데 그때는 아래 return이 이미
           응답을 respondWith에 넘겼기 때문에 clone()이 던진다. 실측: 성공 fetch 4회 후
           SHELL 밖 항목 0건.

           고치려거든 반드시 **키에서 query string을 떼고** 저장해라. 지금 형태를 그대로
           살리면 초대 링크의 ?k=코드가 Cache Storage 키에 영구 저장된다 — 루트 워커에서
           실제로 일어났던 일이다(ISS-000110). frontend/e2e/sw-credential-cache.spec.ts의
           마지막 케이스가 이 계약을 미리 지키고 있다. (Kairen-Ref: TSK-000287) */
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
        return response;
      }).catch(() => event.request.mode === 'navigate' ? caches.match('./index.html') : undefined);
    })
  );
});
