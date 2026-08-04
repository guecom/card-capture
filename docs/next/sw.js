/* Generated candidate service worker — Kairen-Ref: TSK-000221 */
const CACHE = "cardcapture-next-1c3b77c2";
const CACHE_PREFIX = 'cardcapture-next-';
const SHELL = ["./","./index.html","./assets/card-quad-worker-CyKoAx66.js","./assets/index-DfuF91X6.js","./assets/index-Ds5A4SlV.css","./assets/ionic-vendor-AIQfExcx.js","./assets/ionic-vendor-BLfbFd58.js","./assets/ionic-vendor-BuJcBMAG.js","./assets/ionic-vendor-CB41Jaf8.js","./assets/ionic-vendor-CVTHxLll.css","./assets/ionic-vendor-CiU0rtkT.js","./assets/ionic-vendor-CvHtaX-v.js","./assets/ionic-vendor-D32d_Gsz.js","./assets/ionic-vendor-GL6_AfrY.js","./assets/ionic-vendor-R6P8vIhy.js","./assets/opencv-worker-BsNyODJz.js","./assets/quickocr-worker-D49k7F60.js","./assets/react-vendor-6WJR2M2w.js","./assets/react-vendor-BSh_wd36.js","./assets/react-vendor-CoIdssN8.js","./assets/react-vendor-q_3Li6vY.js","./assets/rolldown-runtime-BgaNhQyE.js","./assets/vendor-BrX2rxUE.js","./assets/vendor-CGhPXutC.js","./assets/vendor-Ds5tOiCq.js"];
/* 알림 버튼 문구는 승인안(INT-000025 Thread 2 · DEC-000092) 그대로다. 잠금화면에서 버튼 하나만
   보고도 무엇을 하러 들어가는지 알아야 하므로 '내용 보완'·'문제 확인' 같은 절단형은 쓰지 않는다.
   문구·목적지는 이 워커가 소유한다 — 발신자 입력은 절대 여기에 닿지 않는다. */
const PUSH_COPY = Object.freeze({
  final_result: Object.freeze({ title: '처리가 끝났어요', body: '최종 결과를 확인할 수 있어요.', action: '결과 보기' }),
  human_input_required: Object.freeze({ title: '내용 확인이 필요해요', body: '앱에서 필요한 내용을 보완해 주세요.', action: '필요한 내용 보완' }),
  recovery_required: Object.freeze({ title: '처리를 이어가야 해요', body: '앱에서 문제를 확인하고 다시 시도해 주세요.', action: '다시 시도·문제 보기' }),
});
const PUSH_TARGET = /^[A-Za-z0-9_-]{4,80}$/;
const PUSH_EVENT_ID = /^pne-[a-f0-9]{64}$/;

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

/* Push text and destinations are owned by this service worker, never by sender input.
   A notification payload may select one of three kinds and optionally identify a bounded capture.
   Names, companies, notes, quick-name results, arbitrary stages, and absolute URLs are ignored. */
self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = null;
    try { payload = event.data ? event.data.json() : null; } catch { return; }
    if (!payload || typeof payload !== 'object' || payload.v !== 1 || !PUSH_EVENT_ID.test(payload.eventId || '')) return;
    if (typeof payload.kind !== 'string' || !Object.prototype.hasOwnProperty.call(PUSH_COPY, payload.kind)) return;
    const copy = PUSH_COPY[payload.kind];
    const target = typeof payload.target === 'string' && PUSH_TARGET.test(payload.target) ? payload.target : '';
    const notice = payload.kind === 'recovery_required' ? '&notice=recovery_required' : '';
    const route = target
      ? './?view=activity&focus=' + encodeURIComponent(target) + notice
      : './?view=activity';
    await self.registration.showNotification(copy.title, {
      body: copy.body,
      tag: 'cc-' + payload.eventId,
      renotify: false,
      requireInteraction: false,
      icon: new URL('../icon-192.png', self.registration.scope).href,
      badge: new URL('../icon-192.png', self.registration.scope).href,
      data: { route: route },
      actions: [{ action: 'open', title: copy.action }],
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const fallback = new URL('./?view=activity', self.registration.scope);
    let target = fallback;
    try {
      const candidate = new URL(event.notification.data?.route || '', self.registration.scope);
      const scope = new URL(self.registration.scope);
      if (candidate.origin === self.location.origin
          && candidate.pathname.startsWith(scope.pathname)
          && candidate.searchParams.get('view') === 'activity'
          && (!candidate.searchParams.has('focus') || PUSH_TARGET.test(candidate.searchParams.get('focus') || ''))) {
        target = candidate;
      }
    } catch { /* use bounded fallback */ }

    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const scope = new URL(self.registration.scope);
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin !== self.location.origin || !current.pathname.startsWith(scope.pathname)) continue;
      try { if ('navigate' in client) await client.navigate(target.href); } catch { /* focus current client */ }
      await client.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});

/* 'pushsubscriptionchange' 핸들러는 **일부러 없다**. 브라우저가 구독을 회전시키면 새 endpoint를
   서버 registry에 다시 등록해야 하는데, 그 호출에는 개인 링크 코드(k)가 필요하다. 워커에 그 코드를
   들여오는 순간 ISS-000110에서 막은 credential 경계가 다시 뚫린다. 대신 앱이 다음에 열릴 때
   push.ts의 inspectPushState가 'stale'/'registration_missing'으로 잡아 사용자가 명시적으로
   다시 켜게 하고, 죽은 endpoint는 sender의 404/410 → pushretire가 정리한다. 그때까지 브리핑은
   기존 pull 조회로 그대로 도달한다. 여기서 재구독을 자동화하지 마라. */

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
    new URL('../vendor/cardquad/', self.registration.scope).pathname,
  ];
  const isSharedRuntime = sharedRuntimePaths.some((path) => url.pathname.startsWith(path));
  if (!url.pathname.startsWith(scopePath) && !isSharedRuntime) return;
  /* 화면(navigate)은 **네트워크 우선**이다 (founder 2026-07-28: 컴퓨터는 되는데 폰만 흰 화면).
     예전에는 화면도 캐시 우선이라, 기기에 남아 있던 예전 껍데기가 항상 먼저 나왔다. 그 껍데기가
     가리키는 asset 파일명은 배포마다 바뀌므로, 캐시에서 그 파일이 사라진 기기에서는 스크립트가
     404가 되고 화면이 **하얗게** 남는다. 사용자가 되돌릴 방법도 없다.
     루트 워커는 처음부터 네트워크 우선이었는데 후보 워커만 반대였다 — 그 비대칭이 원인이다.
     이제 화면은 항상 지금 배포본을 먼저 받고, 네트워크가 없을 때만 캐시로 떨어진다.
     **화면 응답은 캐시에 쓰지 않는다** — 초대 링크의 ?k=코드가 키에 박히기 때문이다(ISS-000110).
     내용 해시가 붙은 asset은 불변이라 지금처럼 캐시 우선을 유지한다. */
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('./index.html', { ignoreSearch: true }))
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
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
      }).catch(() => undefined);
    })
  );
});
