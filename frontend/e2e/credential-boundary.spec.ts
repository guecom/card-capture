import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 회귀 게이트: 개인 링크 코드(bearer token)가 허용되지 않은 서버로 나가지 않고,
// 주소창에 남지 않으며, 링크 코드가 바뀌면 이전 사람의 캐시가 보이지 않는다.
// Kairen-Ref: TSK-000269 (FI-004 / FI-005 / FI-006 / FI-007)

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

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

test.beforeEach(async ({ page }) => {
  await page.context().route('**/vendor/**', (route) => route.abort());
  // 첫 실행 이름 온보딩 모달이 하단 탭을 가리지 않게 이름을 미리 넣는다.
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
});

test('never sends the personal link code to an API origin supplied through the link', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const hostileRequests: string[] = [];

  // 공격자 origin으로 나가는 **모든** 요청을 기록한다 — 도달 자체가 실패다.
  await page.context().route('https://attacker.invalid/**', async (route) => {
    hostileRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });

  try {
    const hostile = encodeURIComponent('https://attacker.invalid/exec');
    await page.goto(`${origin}next/?api=${hostile}&k=owner-token`, { waitUntil: 'networkidle' });

    // 1) 자격 정보가 실린 요청이 한 건도 나가지 않는다.
    expect(hostileRequests).toEqual([]);
    // 2) 거부한 주소를 저장하지 않는다 — 저장되면 다음 실행에서 조용히 되살아난다.
    expect(await page.evaluate(() => localStorage.getItem('cc_api') ?? '')).not.toContain('attacker.invalid');
    // 3) 무시했다는 사실을 화면에 말한다.
    await expect(page.getByText('허용되지 않은 서버 주소라 무시했어요', { exact: false })).toBeVisible();

    // 앱을 계속 써도(새로고침·탭 이동) 공격자에게 가지 않는다.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
    await page.waitForTimeout(500);
    expect(hostileRequests).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});

test('removes the personal link code from the address bar without losing the connection', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  await page.route('https://api.example.test/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }),
  }));

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token&view=search`, { waitUntil: 'networkidle' });

    // 코드는 저장되지만 주소에는 남지 않는다. 나머지 파라미터(view)는 그대로다.
    await expect(page).toHaveURL(`${origin}next/?view=search`);
    expect(await page.evaluate(() => localStorage.getItem('cc_token'))).toBe('owner-token');
    await expect(page.locator('ion-header .app-header b')).toHaveText('사람 찾기');

    // 뒤로 가기로 코드가 실린 주소가 되살아나지 않는다 (replaceState여야 성립).
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  } finally {
    await stopStaticServer(server);
  }
});

test('does not show one personal link code the cached records of another', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const ownerBrief = { captureId: '20260727-100000-own', status: 'processed', person: '소유자 전용 기록', brief: '# 소유자 전용 기록\n소유자만 볼 수 있는 문장.' };
  let ownerListed = false;

  await page.route('https://api.example.test/**', async (route) => {
    const token = new URL(route.request().url()).searchParams.get('k');
    if (token !== 'owner-token') {
      // guest 세션에서는 서버가 응답하지 않는다 — 화면에 남는 것은 오직 이 기기의 캐시뿐이다.
      return;
    }
    ownerListed = true;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [ownerBrief], seeAll: true }) });
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token&view=briefs`, { waitUntil: 'networkidle' });
    await expect(page.getByText('소유자 전용 기록').first()).toBeVisible();
    expect(ownerListed).toBe(true);

    // 같은 폰을 guest 링크로 연다. 서버가 침묵해도 이전 사람의 캐시가 보이면 안 된다.
    await page.goto(`${origin}next/?api=${api}&k=guest-token&view=briefs`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_500);
    await expect(page.getByText('소유자 전용 기록')).toHaveCount(0);

    // 이전 subject의 캐시 값 자체가 기기에서 사라진다.
    const values = await page.evaluate(() => Object.values(localStorage).map(String).join('\n'));
    expect(values).not.toContain('소유자 전용 기록');
  } finally {
    await stopStaticServer(server);
  }
});

test('disconnects the device without deleting captures that still need to be sent', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  await page.route('https://api.example.test/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }),
  }));

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });

    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '연결 해제' }).click();
    await expect(page.getByText('개인 링크 코드, 촬영자 이름', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '연결 해제하기' }).click();

    const after = await page.evaluate(() => ({
      token: localStorage.getItem('cc_token'),
      name: localStorage.getItem('cc_name'),
      privateKeys: Object.keys(localStorage).filter((key) => /^cc_s[0-9a-z]+_/.test(key)),
    }));
    expect(after).toEqual({ token: null, name: null, privateKeys: [] });
  } finally {
    await stopStaticServer(server);
  }
});

test('keeps API responses out of the offline cache', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  await page.route('https://api.example.test/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }),
  }));

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });

    const cachedUrls = await page.evaluate(async () => {
      const keys = await caches.keys();
      const urls: string[] = [];
      for (const key of keys) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    });

    expect(cachedUrls.length).toBeGreaterThan(0);
    expect(cachedUrls.filter((url) => !url.startsWith(origin))).toEqual([]);
    expect(cachedUrls.some((url) => url.includes('k=owner-token'))).toBe(false);
  } finally {
    await stopStaticServer(server);
  }
});
