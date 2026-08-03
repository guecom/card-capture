import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 회귀 게이트: 개인 링크 코드(bearer token)가 Cache Storage **키**에 영구 저장되지 않는다.
// Kairen-Ref: TSK-000287 (원본), TSK-000529 (복원)
//
// 이 게이트는 v2.19.0에 있었고 v2.20.0(`3e181a6`)이 지웠다. v2.22.0 롤백은 frontend를
// v2.19 기준으로 되돌렸지만 **이 파일은 되살리지 않았다.** 그래서 ISS-000110의 두 번째 결함
// (`?k=` 코드가 Cache Storage 키에 영구 저장되던 문제)은 코드만 고쳐진 채 게이트 없이 남아 있었다.
//
// 원본 4개 테스트 중 3개는 `legacy.html`에서 부팅했다. legacy 표면은 DEC-000093으로 은퇴했으므로
// 그 부팅 경로만 바꾸고 계약은 그대로 가져온다. 은퇴와 함께 사라져야 할 것은 legacy 페이지이지
// **자격 정보가 캐시 키에 남지 않는다는 계약**이 아니다.
//
// 왜 credential-boundary.spec.ts로 충분하지 않은가 — 그 파일의 캐시 테스트는 `?k=`를 실은
// **navigation**만 수행한다. 그런데 후보 워커는 navigation을 아예 캐시하지 않으므로(vite.config.ts),
// 그 단언은 런타임 캐시 쓰기가 고쳐지든 안 고쳐지든 항상 통과한다. 코드를 실은 **하위 자원**
// 요청을 흘려보내는 것은 여기뿐이다.

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

// 명백히 가짜인 테스트 값. 실토큰·실명함 값을 절대 넣지 않는다.
const FAKE_LINK_CODE = 'fake-e2e-link-code-not-a-token';
const FAKE_API = 'https://api.example.test/exec';

// 사용자 기기에 이미 배포되어 있는(=오염됐을 수 있는) 이전 버전 루트 캐시 이름.
const SHIPPED_ROOT_CACHE = 'cardcapture-v19';

// 루트 scope에 실재하는 페이지가 없다 — `docs/index.html`은 http에서 즉시 `next/`로 넘긴다.
// 루트 service worker를 등록해 판정하려면 루트 scope에 머무는 페이지가 하나 필요하므로
// harness 전용 빈 페이지를 만들어 쓴다. 제품 표면이 아니라 시험대다.
const ROOT_HARNESS_PATH = '__e2e-root-harness.html';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      const body = await readFile(filePath);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  server.keepAliveTimeout = 1;
  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

function stopStaticServer(server: Server): Promise<void> {
  return new Promise((resolveStop, reject) => {
    server.close((error) => error ? reject(error) : resolveStop());
    server.closeAllConnections();
  });
}

async function serverOrigin(): Promise<{ server: Server; origin: string }> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  return { server, origin: `http://127.0.0.1:${address.port}/` };
}

type CacheEntry = { cache: string; url: string };

/** 이 origin의 모든 Cache Storage 버킷을 열어 **키 URL 전체**를 읽는다. */
function readCacheEntries(page: import('@playwright/test').Page): Promise<CacheEntry[]> {
  return page.evaluate(async () => {
    const entries: Array<{ cache: string; url: string }> = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) entries.push({ cache: name, url: request.url });
    }
    return entries;
  });
}

function entriesWithLinkCode(entries: CacheEntry[], code: string): string[] {
  return entries.filter((entry) => entry.url.includes(code)).map((entry) => `${entry.cache} :: ${entry.url}`);
}

/**
 * 프로덕션(GitHub Pages)은 https라 `docs/index.html`이 스스로 sw.js를 등록한다. 이 harness는
 * http://127.0.0.1 이라 그 조건이 막히므로 같은 등록을 명시적으로 수행한다. 127.0.0.1은 secure
 * context라 service worker는 정상 동작한다. controller 획득까지 명시적으로 기다린다.
 */
async function registerRootServiceWorker(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
  });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });
}

/**
 * 캐시 쓰기는 `waitUntil` 없이 fire-and-forget으로 일어난다. 토큰이 "없다"는 단언이 공허해지지
 * 않도록, 반드시 캐시에 들어가야 하는 probe 요청을 하나 흘려보내고 그 키가 나타날 때까지 기다린다.
 * pathname으로만 기다리므로 수정 전(쿼리 포함 키)·수정 후(정규화된 키) 양쪽에서 모두 성립한다.
 */
async function settleCacheWrites(
  page: import('@playwright/test').Page,
  probeRelativeUrl: string,
  expectedPathname: string,
): Promise<void> {
  await page.evaluate((url) => fetch(url).catch(() => undefined), probeRelativeUrl);
  await expect.poll(
    async () => (await readCacheEntries(page)).some((entry) => new URL(entry.url).pathname === expectedPathname),
    { message: `service worker가 ${expectedPathname} 를 캐시에 기록할 때까지 기다린다`, timeout: 15_000 },
  ).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  // 루트 scope에 머무는 harness 페이지. 제품 파일이 아니므로 저장소에 두지 않고 여기서 만든다.
  await page.context().route(`**/${ROOT_HARNESS_PATH}`, (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>root harness</title></head><body></body></html>',
  }));
  // 루트 SHELL에 vendor 자산이 들어 있어 abort하면 install의 addAll이 실패해 SW가 활성화되지 못한다.
  // 빈 200으로 채워 install은 성공시키고 무거운 전송은 피한다 (SW fetch까지 잡으려면 context 레벨).
  await page.context().route('**/vendor/**', (route) => route.fulfill({
    status: 200, contentType: 'text/javascript; charset=utf-8', body: '/* e2e vendor stub */',
  }));
  // 실제 GAS 엔드포인트로는 어떤 요청도 나가지 않는다.
  await page.context().route('https://script.google.com/**', (route) => route.abort());
  await page.context().route('https://api.example.test/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }),
  }));
});

test('keeps the personal link code out of root service-worker cache keys', async ({ page }) => {
  const { server, origin } = await serverOrigin();

  try {
    await page.goto(`${origin}${ROOT_HARNESS_PATH}`, { waitUntil: 'domcontentloaded' });
    await registerRootServiceWorker(page);

    // 코드를 실은 **하위 자원** 요청. 루트 워커의 fetch 처리는 `cacheKeyFor()`로 키에서 쿼리를
    // 지운다(docs/sw.js). 그 정규화를 되돌리면 — 예를 들어 `c.put(e.request, copy)`로 —
    // 아래 단언이 곧바로 깨진다. navigation만 보는 게이트로는 절대 잡히지 않는 경로다.
    await settleCacheWrites(page, `manifest.json?k=${FAKE_LINK_CODE}`, '/manifest.json');

    const entries = await readCacheEntries(page);
    expect(entries.length, 'Cache Storage가 비어 있으면 이 게이트는 아무것도 증명하지 못한다').toBeGreaterThan(0);
    expect(
      entriesWithLinkCode(entries, FAKE_LINK_CODE),
      '개인 링크 코드가 Cache Storage 키에 남았다 — 기기에 영구 저장된 자격 정보 누출',
    ).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});

test('purges an already contaminated root cache when the worker activates', async ({ page }) => {
  const { server, origin } = await serverOrigin();

  try {
    await page.goto(`${origin}${ROOT_HARNESS_PATH}`, { waitUntil: 'domcontentloaded' });

    // 이미 배포된 버전에서 오염된 기기를 재현한다: 배포본 캐시 이름에 링크 코드가 든 키가 남아 있다.
    await page.evaluate(async ([cacheName, poisonedUrl]) => {
      const cache = await caches.open(cacheName);
      await cache.put(new Request(poisonedUrl), new Response('stale shell'));
    }, [SHIPPED_ROOT_CACHE, `${origin}?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`] as const);

    expect(entriesWithLinkCode(await readCacheEntries(page), FAKE_LINK_CODE).length)
      .toBeGreaterThan(0); // 오염 전제가 실제로 만들어졌는지 먼저 확인한다.

    await registerRootServiceWorker(page);

    // 새 worker가 활성화되면 이전 버전 캐시가 통째로 사라져야 한다.
    await expect.poll(
      async () => (await page.evaluate(() => caches.keys())).includes(SHIPPED_ROOT_CACHE),
      { message: `${SHIPPED_ROOT_CACHE} 가 activate에서 삭제되기를 기다린다`, timeout: 15_000 },
    ).toBe(false);

    expect(
      entriesWithLinkCode(await readCacheEntries(page), FAKE_LINK_CODE),
      '이전에 오염된 캐시가 업데이트 후에도 링크 코드를 들고 있다',
    ).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});

test('keeps the personal link code out of the candidate (next/) cache keys', async ({ page }) => {
  const { server, origin } = await serverOrigin();

  try {
    // 실제 사용 흐름: 사용자가 코드가 실린 링크로 후보 앱을 연 뒤 계속 쓴다.
    await page.goto(`${origin}next/?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });
    await page.goto(`${origin}next/?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`, { waitUntil: 'commit' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });

    // 후보 worker의 런타임 캐시 쓰기는 **전체 URL**을 키로 쓴다. 오늘 새지 않는 이유는 키를
    // 정규화해서가 아니라 그 쓰기가 죽어 있기 때문이다: `caches.open(CACHE).then((cache) =>
    // cache.put(request, response.clone()))` 에서 clone()이 respondWith가 본문을 소비한 **뒤에**
    // 평가돼 매번 던진다. 그래서 이 게이트는 "코드를 실은 in-scope 요청은 절대 저장되지 않는다"는
    // 계약으로 고정한다 — 누군가 vite.config.ts에서 그 죽은 쓰기를 "고치면" 키 정규화 없이는
    // 여기서 잡힌다.
    await page.evaluate((code) => fetch(`manifest.webmanifest?k=${code}`).catch(() => undefined), FAKE_LINK_CODE);
    await page.waitForTimeout(1_500);

    const entries = await readCacheEntries(page);
    expect(entries.some((entry) => entry.cache.startsWith('cardcapture-next-')), '후보 캐시가 있어야 판정이 성립한다').toBe(true);
    expect(
      entriesWithLinkCode(entries, FAKE_LINK_CODE),
      '개인 링크 코드가 후보 앱 캐시 키에 남았다',
    ).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});
