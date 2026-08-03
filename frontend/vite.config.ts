import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

function readPublicRuntimeApi(): string {
  const runtime = JSON.parse(readFileSync(new URL('../config/public-runtime.json', import.meta.url), 'utf8')) as { apiUrl?: unknown };
  if (typeof runtime.apiUrl !== 'string' || !/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(runtime.apiUrl)) {
    throw new Error('public_runtime_api_missing');
  }
  return runtime.apiUrl;
}

/**
 * 빌드 식별자 = 소스의 내용 해시. 벽시계가 아니다. (Kairen-Ref: TSK-000290)
 *
 * 예전 값은 `new Date()`였다. 그 문자열이 App.tsx의 build-line을 통해 entry 청크에 박히는
 * 바람에, 소스를 하나도 안 바꿔도 분이 넘어가면 entry 내용 → entry 콘텐츠 해시 파일명 →
 * index.html의 script src → sw.js의 SHELL 목록과 캐시 이름까지 연쇄로 바뀌었다.
 * 결과적으로 커밋된 `docs/next/**`가 정말 그 소스에서 나온 산출물인지 검증할 수 없었다.
 *
 * 지금 값은 번들에 실제로 들어가는 입력만으로 결정된다. 그래서
 *   1. 같은 소스 → 항상 같은 산출물 (eval/build-reproducibility.test.js가 강제한다)
 *   2. 설정 화면에 보이는 식별자로 "이 번들이 어느 소스에서 나왔나"를 역으로 대조할 수 있다
 * CRLF/LF는 정규화한다 — Windows 체크아웃(core.autocrlf=true)과 리눅스 CI가 같은 소스에
 * 대해 같은 식별자를 내야 하기 때문이다.
 */
function sourceBuildId(defaultApi: string): string {
  const frontendDir = fileURLToPath(new URL('.', import.meta.url));
  const ignoredSourceMetadata = new Set(['desktop.ini', 'Thumbs.db', '.DS_Store']);
  const files: string[] = [];
  const collect = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignoredSourceMetadata.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) collect(full);
      else files.push(full);
    }
  };
  collect(join(frontendDir, 'src'));
  for (const name of ['index.html', 'package.json', 'package-lock.json', 'vite.config.ts']) {
    files.push(join(frontendDir, name));
  }

  // 정렬 키는 OS 경로 구분자와 무관해야 한다.
  const keyed = files
    .map((full) => ({ rel: relative(frontendDir, full).split(sep).join('/'), full }))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));

  const hash = createHash('sha256');
  for (const { rel, full } of keyed) {
    hash.update(rel);
    hash.update('\0');
    const bytes = readFileSync(full);
    hash.update(extname(full).toLowerCase() === '.woff2'
      ? bytes
      : bytes.toString('utf8').replace(/\r\n?/g, '\n'));
    hash.update('\0');
  }
  // 공개 runtime config에서 주입되는 pinned endpoint도 번들 내용의 일부다.
  hash.update(defaultApi);
  return `src-${hash.digest('hex').slice(0, 12)}`;
}

const publicRuntimeApi = readPublicRuntimeApi();

function stableHash(values: string[]): string {
  let hash = 2166136261;
  for (const value of values.join('|')) {
    hash ^= value.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function candidatePwa(): Plugin {
  return {
    name: 'card-capture-candidate-pwa',
    apply: 'build',
    generateBundle(_options, bundle) {
      // `.woff2`는 SHELL에서 뺀다 (founder 판정 2026-07-28, 서체 도입).
      // `cache.addAll(SHELL)`은 **원자적**이라 한 항목만 실패해도 설치 전체가 실패하고 오프라인
      // 껍데기가 통째로 안 만들어진다. 1.7MB 서체 하나 때문에 전시장 회선에서 그 위험을 지는 대신,
      // `font-display: swap`으로 필요할 때 받아 브라우저 HTTP 캐시에 맡긴다. 못 받으면 시스템
      // 서체로 그려질 뿐 기능은 그대로다. 자세한 근거는 `src/fonts/README.md`.
      const emitted = Object.keys(bundle).filter((file) => !file.endsWith('.map') && !file.endsWith('.woff2')).sort();
      const shell = Array.from(new Set(['./', './index.html', ...emitted.map((file) => `./${file}`)]));
      const cacheName = `cardcapture-next-${stableHash(shell)}`;
      const serviceWorker = `/* Generated candidate service worker — Kairen-Ref: TSK-000221 */
const CACHE = ${JSON.stringify(cacheName)};
const CACHE_PREFIX = 'cardcapture-next-';
const SHELL = ${JSON.stringify(shell)};
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
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify({
          id: './',
          name: 'Kairen Card Capture',
          short_name: 'Card Capture',
          description: '명함을 촬영해 Kairen 인물 기억과 브리핑으로 연결합니다.',
          theme_color: '#f6f8fb',
          background_color: '#f5f7fb',
          display: 'standalone',
          scope: './',
          start_url: './',
          shortcuts: [
            {
              name: '인맥 검색',
              short_name: '검색',
              description: '만나기 전에 이 사람이 누구인지 회상',
              url: './?view=search',
              icons: [{ src: '../icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
            {
              name: '받은 브리핑',
              short_name: '브리핑',
              description: '처리된 명함 브리핑 확인',
              url: './?view=briefs',
              icons: [{ src: '../icon-192.png', sizes: '192x192', type: 'image/png' }],
            },
          ],
          icons: [
            { src: '../icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: '../icon-512.png', sizes: '512x512', type: 'image/png' },
          ],
        }),
      });
    },
  };
}

export default defineConfig({
  base: './',
  resolve: {
    // ORT는 이미 docs/vendor/ort에 해시 고정해 둔 WASM을 쓴다.
    // extern-wasm export를 선택해 동일한 13.5MB binary가 앱 bundle에 다시 들어가지 않게 한다.
    conditions: ['onnxruntime-web-use-extern-wasm'],
    alias: [
      // WASM 전용 ORT 번들로 고정 — 기본 번들은 WebGPU(jsep) 로더를 동적 임포트해
      // 27MB jsep 자산까지 요구한다. 우리는 vendor/ort/에 wasm 파일만 자체 호스팅한다.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  define: {
    __CARD_CAPTURE_DEFAULT_API__: JSON.stringify(publicRuntimeApi),
    // 설정 화면에 노출되는 빌드 식별자 — "지금 무슨 버전을 보고 있나"를 원격으로 확인하는 용도.
    // 소스 내용 해시라 재현 가능하고, 저장소에서 다시 계산해 대조할 수 있다.
    __CARD_CAPTURE_BUILD_ID__: JSON.stringify(sourceBuildId(publicRuntimeApi)),
  },
  plugins: [
    react(),
    tailwindcss(),
    candidatePwa(),
  ],
  build: {
    outDir: '../docs/next',
    emptyOutDir: true,
    sourcemap: false,
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules[\\/](?:react|react-dom|scheduler)/,
              maxSize: 250_000,
              priority: 30,
            },
            {
              name: 'ionic-vendor',
              test: /node_modules[\\/]@ionic/,
              maxSize: 300_000,
              priority: 20,
            },
            {
              name: 'vendor',
              test: /node_modules/,
              maxSize: 250_000,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
