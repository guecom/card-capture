import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 회귀 게이트: 개인 링크 코드(bearer token)가 Cache Storage **키**에 영구 저장되지 않는다.
// credential-boundary.spec.ts는 localStorage와 next/ scope만 봤고, 루트 service worker가
// 캐시에 무엇을 키로 넣는지는 한 번도 확인한 적이 없다.
// Kairen-Ref: TSK-000287

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

// 명백히 가짜인 테스트 값. 실토큰·실명함 값을 절대 넣지 않는다.
const FAKE_LINK_CODE = 'fake-e2e-link-code-not-a-token';
const FAKE_API = 'https://api.example.test/exec';

// 사용자 기기에 이미 배포되어 있는(=오염됐을 수 있는) 루트 캐시 이름.
const SHIPPED_ROOT_CACHE = 'cardcapture-v19';

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
 * 프로덕션(GitHub Pages)은 https라 docs/index.html·docs/legacy.html이 스스로 sw.js를 등록한다.
 * 이 harness는 http://127.0.0.1 이라 페이지의 `location.protocol === 'https:'` 조건이 막히므로
 * 같은 등록을 명시적으로 수행한다. 127.0.0.1은 secure context라 service worker는 정상 동작한다.
 * 등록/활성은 20초 자동 주기 같은 것에 기대지 않고 controller 획득까지 명시적으로 기다린다.
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
    await page.goto(`${origin}legacy.html`, { waitUntil: 'domcontentloaded' });
    await registerRootServiceWorker(page);

    // 1) 초대 링크 형태: …/?k=CODE (index.html이 next/로 넘긴다)
    await page.goto(`${origin}?k=${FAKE_LINK_CODE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/\/next\//, { timeout: 20_000 });

    // 2) legacy 링크 형태: …/legacy.html?api=…&k=CODE
    await page.goto(`${origin}legacy.html?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });

    // 캐시 쓰기가 정착할 때까지 기다린다 — 링크 코드를 실은 probe라 수정 전에는 이 키 자체가 증거다.
    await settleCacheWrites(page, `cache-settle-probe?k=${FAKE_LINK_CODE}`, '/cache-settle-probe');

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
    await page.goto(`${origin}legacy.html`, { waitUntil: 'domcontentloaded' });

    // 이미 배포된 버전에서 오염된 기기를 재현한다: 배포본 캐시 이름에 링크 코드가 든 키가 남아 있다.
    await page.evaluate(async ([cacheName, poisonedUrl]) => {
      const cache = await caches.open(cacheName);
      await cache.put(new Request(poisonedUrl), new Response('stale shell'));
    }, [SHIPPED_ROOT_CACHE, `${origin}legacy.html?k=${FAKE_LINK_CODE}`] as const);

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

test('still serves the legacy shell offline from a link that carried a code', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  let stopped = false;

  try {
    await page.goto(`${origin}legacy.html`, { waitUntil: 'domcontentloaded' });
    await registerRootServiceWorker(page);

    const tokenLink = `${origin}legacy.html?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`;
    await page.goto(tokenLink, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });
    await settleCacheWrites(page, `cache-settle-probe?k=${FAKE_LINK_CODE}`, '/cache-settle-probe');

    await stopStaticServer(server);
    stopped = true;

    // 캐시 키를 정규화해도 읽기 경로(ignoreSearch: true)가 그대로라 오프라인 셸은 계속 떠야 한다.
    await page.goto(tokenLink, { waitUntil: 'domcontentloaded' });
    expect(await page.title()).toBe('명함 캡처 — 이전 앱');
    await expect(page.locator('#captureCard')).toBeVisible();
    await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
  } finally {
    if (!stopped) await stopStaticServer(server);
  }
});

test('keeps the personal link code out of the candidate (next/) cache keys', async ({ page }) => {
  const { server, origin } = await serverOrigin();

  try {
    // 실제 사용 흐름: 사용자가 코드가 실린 링크로 후보 앱을 연 뒤 계속 쓴다.
    await page.goto(`${origin}next/?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });
    await page.goto(`${origin}next/?api=${encodeURIComponent(FAKE_API)}&k=${FAKE_LINK_CODE}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });

    // 후보 worker도 루트와 똑같이 **전체 URL**을 캐시 키로 쓴다. 오늘 코드가 새지 않는 이유는
    // 키를 정규화해서가 아니라, 런타임 캐시 쓰기가 통째로 죽어 있기 때문이다:
    // `caches.open(CACHE).then((cache) => cache.put(request, response.clone()))` 에서
    // clone()이 respondWith가 본문을 소비한 **뒤에** 평가돼 매번 던진다.
    // (계측: SHELL 25개 = 캐시 25개, 성공한 런타임 fetch 4건 뒤에도 비-SHELL 항목 0개)
    // 그래서 이 게이트는 "코드를 실은 in-scope 요청은 절대 저장되지 않는다"는 계약으로 고정한다 —
    // 누군가 vite.config.ts에서 clone 순서를 고치면 키 정규화 없이는 여기서 잡힌다.
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
