import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';

function readLegacyDefaultApi(): string {
  const legacyHtml = readFileSync(new URL('../docs/legacy.html', import.meta.url), 'utf8');
  const match = /var DEFAULT_API = '([^']+)'/.exec(legacyHtml);
  if (!match?.[1]) throw new Error('legacy_default_api_missing');
  return match[1];
}

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
      const emitted = Object.keys(bundle).filter((file) => !file.endsWith('.map')).sort();
      const shell = Array.from(new Set(['./', './index.html', ...emitted.map((file) => `./${file}`)]));
      const cacheName = `cardcapture-next-${stableHash(shell)}`;
      const serviceWorker = `/* Generated candidate service worker — Kairen-Ref: TSK-000221 */
const CACHE = ${JSON.stringify(cacheName)};
const CACHE_PREFIX = 'cardcapture-next-';
const SHELL = ${JSON.stringify(shell)};

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
    alias: [
      // WASM 전용 ORT 번들로 고정 — 기본 번들은 WebGPU(jsep) 로더를 동적 임포트해
      // 27MB jsep 자산까지 요구한다. 우리는 vendor/ort/에 wasm 파일만 자체 호스팅한다.
      { find: /^onnxruntime-web$/, replacement: 'onnxruntime-web/wasm' },
    ],
  },
  define: {
    __CARD_CAPTURE_DEFAULT_API__: JSON.stringify(readLegacyDefaultApi()),
    // 설정 화면에 노출되는 빌드 식별자 — "지금 무슨 버전을 보고 있나"를 원격으로 확인하는 용도.
    __CARD_CAPTURE_BUILD_ID__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z'),
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
