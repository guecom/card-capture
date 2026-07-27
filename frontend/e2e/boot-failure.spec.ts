// 부팅 실패 화면 회귀 게이트 (founder 2026-07-28: "핸드폰에서는 흰 화면만 보여").
//
// 이 앱의 껍데기는 오랫동안 빈 `<div id="root">` 하나였다. 그래서 번들이 한 줄이라도 못 뜨면
// 사용자에게 남는 것은 **하얀 화면 하나**였다 — 무엇이 잘못됐는지도, 빠져나올 방법도 없다.
// 원인(기기에 남은 예전 서비스 워커·지워진 캐시·느린 회선)은 남의 기기에서 재현할 수 없지만,
// "실패해도 말은 한다"는 이 자리에서 만들 수 있고 그것이 이 게이트가 지키는 계약이다.
//
// 함께 잠그는 것: 화면(navigate) 요청이 **네트워크 우선**인가. 예전에는 캐시 우선이라
// 기기에 남은 예전 껍데기가 항상 먼저 나왔고, 그 껍데기가 가리키는 asset 파일명은 배포마다
// 바뀌므로 캐시에서 사라진 기기는 스크립트가 404가 되고 화면이 하얗게 남았다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/** `block`에 걸리는 요청은 404로 돌려준다 — "앱 파일이 사라진 기기"를 그대로 흉내 낸다. */
function startStaticServer(block: RegExp | null): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      if (block && block.test(pathname)) { response.writeHead(404).end('gone'); return; }
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(filePath);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  server.keepAliveTimeout = 1;
  return new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done(server)); });
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP port');
  return address.port;
}

async function silenceApi(page: Page) {
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }),
  }));
}

test('a shell that cannot boot says so instead of showing a white screen', async ({ page }) => {
  // 앱 번들만 사라진 상태. 껍데기 HTML은 멀쩡히 오지만 스크립트가 404다.
  const server = await startStaticServer(/\/assets\/index-.*\.js$/);
  try {
    await silenceApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${portOf(server)}/next/`, { waitUntil: 'load' });

    const panel = page.locator('#cc-boot-failure');
    await expect(panel, '앱이 못 떴는데 화면에 아무 말도 없다 — 사용자에게는 흰 화면이다').toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: '앱을 여는 데 실패했어요' })).toBeVisible();
    // 빠져나갈 길이 있어야 한다. 안내문만 있는 실패 화면은 흰 화면과 크게 다르지 않다.
    await expect(page.getByRole('button', { name: '앱 새로 받기' })).toBeVisible();
    // 무슨 일이 있었는지 적혀 있어야 다음 진단이 가능하다.
    await expect(page.locator('#cc-boot-detail')).toContainText('앱 파일을 받지 못했어요');
  } finally {
    server.close();
  }
});

test('the recovery button clears the device state and reloads', async ({ page }) => {
  const server = await startStaticServer(/\/assets\/index-.*\.js$/);
  try {
    await silenceApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const base = `http://127.0.0.1:${portOf(server)}/next/`;
    await page.goto(base, { waitUntil: 'load' });
    await expect(page.locator('#cc-boot-failure')).toBeVisible({ timeout: 15_000 });

    // 지울 것이 실제로 있는 상태를 만든다 — 아무것도 없는 상태에서 눌러 봐야 아무것도 증명하지 못한다.
    await page.evaluate(() => caches.open('cardcapture-next-stale').then((c) => c.put('./index.html', new Response('stale'))));
    expect(await page.evaluate(() => caches.keys())).toContain('cardcapture-next-stale');

    await page.getByRole('button', { name: '앱 새로 받기' }).click();
    await page.waitForURL(/cc_fresh=/, { timeout: 15_000 });
    expect(await page.evaluate(() => caches.keys()), '캐시를 비우지 않았다').toEqual([]);
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length)), '서비스 워커를 등록 해제하지 않았다').toBe(0);
  } finally {
    server.close();
  }
});

test('a healthy boot never shows the failure screen', async ({ page }) => {
  const server = await startStaticServer(null);
  try {
    await silenceApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${portOf(server)}/next/`, { waitUntil: 'load' });
    await expect(page.getByRole('button', { name: '캡처', exact: true })).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(13_500); // 감시 타이머(12초)를 넘겨 본다.
    await expect(page.locator('#cc-boot-failure'), '정상 부팅인데 실패 화면이 떴다').toBeHidden();
  } finally {
    server.close();
  }
});

test('the app screen is fetched from the network first, so a stale shell never traps the device', async ({ page }) => {
  const server = await startStaticServer(null);
  try {
    await silenceApi(page);
    await page.setViewportSize({ width: 390, height: 844 });
    const base = `http://127.0.0.1:${portOf(server)}/next/`;
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 20_000 });

    // 기기에 "예전 껍데기"가 남아 있는 상태를 만든다. 캐시 우선이면 이것이 화면으로 나온다.
    await page.evaluate(async () => {
      const names = await caches.keys();
      const cache = await caches.open(names.find((n) => n.startsWith('cardcapture-next-')) ?? 'cardcapture-next-probe');
      await cache.put('./index.html', new Response('<!doctype html><title>STALE SHELL</title>', { headers: { 'content-type': 'text/html' } }));
      await cache.put('./', new Response('<!doctype html><title>STALE SHELL</title>', { headers: { 'content-type': 'text/html' } }));
    });

    await page.goto(base, { waitUntil: 'load' });
    expect(await page.title(), '서비스 워커가 예전 껍데기를 먼저 내줬다 — 기기가 옛 배포에 갇힌다').not.toBe('STALE SHELL');
    await expect(page.getByRole('button', { name: '캡처', exact: true })).toBeVisible({ timeout: 20_000 });
  } finally {
    server.close();
  }
});
