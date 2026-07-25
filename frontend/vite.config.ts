import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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
  if (!url.pathname.startsWith(scopePath)) return;
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
`;
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: serviceWorker });
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.webmanifest',
        source: JSON.stringify({
          id: './',
          name: 'Kairen Card Capture Next',
          short_name: 'Card Capture Next',
          description: 'Contract-preserving React Ionic migration candidate for Kairen Card Capture.',
          theme_color: '#f6f8fb',
          background_color: '#f5f7fb',
          display: 'standalone',
          scope: './',
          start_url: './',
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
