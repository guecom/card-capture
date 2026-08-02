/* CardCapture service worker — 앱 셸 캐시 */
var CACHE = 'cardcapture-v21';
var SHELL = [
  './', './index.html', './manifest.json', './icon-192.png', './icon-512.png',
  './camera-quality.js', './research-policy.js', './vendor/tesseract/tesseract.min.js', './vendor/tesseract/worker.min.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return /^cardcapture-v/.test(k) && k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

/* 캐시 키에서 쿼리를 지운다. Cache Storage 키는 전체 URL이라, 초대 링크(?k=개인 링크 코드)를
   한 번만 열어도 코드가 기기에 영구 저장된다. 읽기 경로가 이미 ignoreSearch라 기능에는 영향이 없다. */
function cacheKeyFor(requestUrl) {
  var keyUrl = new URL(requestUrl);
  keyUrl.search = '';
  keyUrl.hash = '';
  return new Request(keyUrl.href);
}

/* 같은 오리진 GET만 처리: 네트워크 우선, 실패 시 캐시 (오프라인에서도 앱이 열리게) */
self.addEventListener('fetch', function (e) {
  if (e.request.method !== 'GET') return;
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  var scopePath = new URL(self.registration.scope).pathname;
  if (url.pathname.indexOf(scopePath + 'next/') === 0) return;
  e.respondWith(
    fetch(e.request).then(function (res) {
      var copy = res.clone();
      var key = cacheKeyFor(e.request.url);
      caches.open(CACHE).then(function (c) { return c.put(key, copy); }).catch(function () {});
      return res;
    }).catch(function () {
      return caches.match(e.request, { ignoreSearch: true });
    })
  );
});
