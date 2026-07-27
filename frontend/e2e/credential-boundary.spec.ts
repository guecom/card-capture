import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 회귀 게이트: 개인 링크 코드(bearer token)가 허용되지 않은 서버로 나가지 않고,
// 주소창에 남지 않으며, 링크 코드가 바뀌면 이전 사람의 캐시가 보이지 않는다.
// Kairen-Ref: TSK-000269 (FI-004 / FI-005 / FI-006 / FI-007)

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const legacyHtmlPath = resolve(fileURLToPath(new URL('../../docs/legacy.html', import.meta.url)));

/**
 * 빌드에 박힌 배포본 주소. `vite.config.ts`가 같은 값을 읽어 `__CARD_CAPTURE_DEFAULT_API__`로 넣는다 —
 * 게이트가 빌드와 같은 원본을 보게 해서, 배포본이 바뀌어도 게이트가 조용히 무의미해지지 않게 한다.
 */
async function pinnedApiEndpoint(): Promise<string> {
  const match = /var DEFAULT_API = '([^']+)'/.exec(await readFile(legacyHtmlPath, 'utf8'));
  if (!match?.[1]) throw new Error('legacy_default_api_missing');
  return match[1];
}

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

/**
 * 같은 정적 서버를 **배포본으로 판정되는 origin**으로 연다 — Kairen-Ref: TSK-000302
 *
 * Chromium은 `*.localhost` 를 DNS 없이 loopback으로 풀고 secure context로 취급한다(배포본의
 * https와 같은 조건 — service worker·캐시가 그대로 동작한다). 반면 앱의 개발 호스트 판정은
 * 정확히 `localhost`·`127.0.0.1`·`[::1]` 만 담고 있어서 `app.localhost` 는 **개발 호스트가 아니다**.
 * 그래서 이 origin으로 열면 실제 배포본과 같은 판정을 받는다.
 * 127.0.0.1로 열면 개발 호스트라 아래 게이트는 성립하지 않는다.
 */
function deployedOrigin(origin: string): string {
  return origin.replace('//127.0.0.1:', '//app.localhost:');
}

async function openSettingsAdvanced(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
  await page.getByRole('button', { name: '사용자·연결 정보 편집' }).click();
  await page.getByRole('button', { name: /고급 설정/ }).click();
}

test.beforeEach(async ({ page }) => {
  await page.context().route('**/vendor/**', (route) => route.abort());
  // 실제 GAS 배포본으로는 어떤 요청도 나가지 않는다. `?api=` 를 거부하면 앱은 빌드에 박힌
  // 기본 주소로 되돌아가므로, 이 가드가 없으면 테스트 토큰이 실서버로 나간다.
  // 개별 test가 나중에 등록하는 route가 더 우선하므로 그쪽에서 관찰은 계속 가능하다.
  await page.context().route('https://script.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
  }));
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
    // service worker가 붙은 뒤에는 networkidle이 안정적으로 도달하지 않는다 — 앱 셸로 판정한다.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
    await page.waitForTimeout(1_000);
    expect(hostileRequests).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});

// FI-004 재검증 — Kairen-Ref: TSK-000285
//
// 위 게이트는 **다른 origin**만 시험한다. 그런데 빌드에 박힌 API는 Apps Script 웹앱이고,
// `script.google.com`은 누구나 배포할 수 있는 multi-tenant 호스트다. origin만 비교하면
// `?api=https://script.google.com/macros/s/<공격자 배포 ID>/exec` 가 통과해
// **같은 origin, 다른 경로**로 저장된 개인 링크 코드가 그대로 나간다.
test('never sends the personal link code to another deployment on the pinned API origin', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  // 존재하지 않는 명백한 가짜 배포 ID다. route가 먼저 잡아 실제 GAS에는 나가지 않는다.
  const hostileDeployment = 'https://script.google.com/macros/s/AKfycb-e2e-not-our-deployment/exec';
  const hostileRequests: string[] = [];

  await page.context().route('https://script.google.com/**', async (route) => {
    const url = route.request().url();
    if (url.includes('AKfycb-e2e-not-our-deployment')) hostileRequests.push(url);
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });

  try {
    await page.goto(`${origin}next/?api=${encodeURIComponent(hostileDeployment)}&k=owner-token`, { waitUntil: 'networkidle' });

    // 1) 공격자 배포본으로 나간 요청이 한 건도 없다.
    expect(hostileRequests).toEqual([]);
    // 2) 거부한 주소를 저장하지 않고 빌드에 박힌 기본 주소로 되돌아간다.
    expect(await page.evaluate(() => localStorage.getItem('cc_api'))).toBeNull();
    // 3) 같은 서버라도 우리 배포본이 아니라는 사실을 화면에 말한다.
    await expect(page.getByText('이 앱이 쓰는 주소가 아니라 무시했어요', { exact: false })).toBeVisible();

    // 새로고침·탭 이동으로도 되살아나지 않는다.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
    await page.waitForTimeout(1_000);
    expect(hostileRequests).toEqual([]);
  } finally {
    await stopStaticServer(server);
  }
});

// FI-004 / FI-007 재검증 — Kairen-Ref: TSK-000285
//
// `?api=<우리 배포본>?k=TOKEN` 은 자격 정보를 API 주소의 query에 실어 보낸다.
// 채택한 주소를 그대로 저장하면 코드가 `cc_api` 값 안에 남고, `연결 해제`는 `cc_api`를
// 지우지 않으므로 "연결 해제가 token을 제거한다"는 주장이 그만큼 깨진다.
test('never stores a personal link code hidden in the API address, and clears the address on disconnect', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const pinned = await pinnedApiEndpoint();

  try {
    await page.goto(`${origin}next/?api=${encodeURIComponent(`${pinned}?k=hidden-token`)}&k=owner-token`, { waitUntil: 'networkidle' });

    // 1) 저장된 주소에는 query가 아예 없다 — 자격 정보가 섞일 자리가 없다.
    const storedApi = await page.evaluate(() => localStorage.getItem('cc_api') ?? '');
    expect(storedApi).toBe(pinned);
    expect(await page.evaluate(() => Object.values(localStorage).map(String).join('\n'))).not.toContain('hidden-token');

    // 2) 연결 해제는 주소까지 정리하고, 다음 실행은 빌드에 박힌 기본 주소로 시작한다.
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '연결 해제' }).click();
    await expect(page.getByText('개인 링크 코드, 촬영자 이름', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: '연결 해제하기' }).click();

    expect(await page.evaluate(() => ({
      api: localStorage.getItem('cc_api'),
      token: localStorage.getItem('cc_token'),
    }))).toEqual({ api: null, token: null });
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

// D3-1 — 고급 설정의 주소 입력은 개발 호스트에서만 편집 가능하다. Kairen-Ref: TSK-000302
//
// v2.7.0에서 신뢰 판정을 origin + pathname으로 좁힌 뒤 배포본에서는 이 칸에 **무엇을 넣어도**
// 거부된다. 그런데 칸은 그대로 열려 있어 사용자에게 거짓 선택지를 보여 줬다.
// 아래 두 게이트는 **다른 것**을 확인한다 — 칸이 잠겼는가, 그리고 그 값이 채택되지 않는가.
test('locks the advanced address field on a deployed host while still showing where it is connected', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const pinned = await pinnedApiEndpoint();

  try {
    await page.goto(`${deployedOrigin(origin)}next/?k=owner-token`, { waitUntil: 'networkidle' });
    // 전제 확인: 개발 호스트로 열렸다면 이 게이트는 아무것도 증명하지 않는다.
    expect(await page.evaluate(() => location.hostname)).toBe('app.localhost');

    await openSettingsAdvanced(page);
    const apiField = page.getByLabel('연결 주소 (GAS API)');

    // 1) 숨기지 않는다 — 지금 어디에 연결돼 있는지는 계속 읽을 수 있어야 한다.
    await expect(apiField).toBeVisible();
    await expect(apiField).toHaveValue(pinned);
    // 2) 배포본에서는 편집할 수 없다.
    await expect(apiField).not.toBeEditable();
    // 3) 왜 바꿀 수 없는지를 화면에 말하고, 그 문장이 낭독기에도 그 칸의 설명으로 연결돼 있다.
    const describedBy = await apiField.getAttribute('aria-describedby');
    expect(describedBy, '읽기 전용 사유가 낭독기에 연결되지 않았다').toBeTruthy();
    await expect(page.locator(`#${describedBy}`)).toContainText('바꿀 수 없어요');

    // 4) **잠긴 것과 채택되지 않는 것은 다르다.** readonly를 벗겨 내고 적대적 주소를 DOM에
    //    직접 밀어 넣은 뒤 저장해도 저장된 주소는 그대로여야 한다 — 화면이 유일한 방어선이면
    //    방어선이 아니다. 배포본에서 이 칸은 값 변경 경로 자체가 없어 화면에 거부 안내도 뜨지
    //    않는다(거부할 값이 애초에 전달되지 않는다). 거부 안내 경로는 위 `?api=` 게이트들과
    //    아래 "저장돼 있던 주소" 게이트가 따로 지킨다.
    await apiField.evaluate((node: HTMLTextAreaElement) => { node.readOnly = false; });
    await apiField.fill('https://attacker.invalid/exec');
    await expect(apiField).toHaveValue('https://attacker.invalid/exec');
    await page.getByRole('button', { name: '설정 저장' }).click();
    await expect(page.getByRole('button', { name: '설정 저장' })).toBeHidden();

    expect(await page.evaluate(() => localStorage.getItem('cc_api'))).toBe(pinned);
    expect(await page.evaluate(() => Object.values(localStorage).map(String).join('\n'))).not.toContain('attacker.invalid');
  } finally {
    await stopStaticServer(server);
  }
});

// D3-3 — 이미 성립하는 것을 게이트로 고정한다. Kairen-Ref: TSK-000302
//
// 주소 입력 칸을 잠갔다고 해서 "사용자가 주소를 바꿀 수 없다"가 증명되는 것은 아니다.
// 기기에 이미 저장돼 있던 주소는 화면을 거치지 않고 다음 실행에 그대로 되살아난다.
// 배포본 origin에서 boot 재판정이 실제로 그것을 버리는지 여기서 확인한다.
test('never revives an address stored earlier, even on a deployed host', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const pinned = await pinnedApiEndpoint();
  const hostileRequests: string[] = [];

  await page.context().route('https://attacker.invalid/**', async (route) => {
    hostileRequests.push(route.request().url());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });
  // 예전 빌드가 저장해 뒀을 법한 상태를 그대로 만든다 — 링크에는 아무것도 붙지 않는다.
  await page.addInitScript(() => {
    localStorage.setItem('cc_api', 'https://attacker.invalid/exec');
    localStorage.setItem('cc_token', 'owner-token');
  });

  try {
    await page.goto(`${deployedOrigin(origin)}next/`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => location.hostname)).toBe('app.localhost');

    // 1) 자격 정보가 실린 요청이 한 건도 나가지 않는다.
    expect(hostileRequests).toEqual([]);
    // 2) 저장돼 있던 주소를 버리고 빌드에 박힌 주소로 되돌아간다.
    expect(await page.evaluate(() => localStorage.getItem('cc_api'))).toBeNull();
    // 3) 무시했다는 사실을 화면에 말한다.
    await expect(page.getByText('허용되지 않은 서버 주소라 무시했어요', { exact: false })).toBeVisible();
    // 4) 고급 설정이 보여 주는 주소도 빌드에 박힌 주소다 — 화면과 실제 연결이 갈라지면 안 된다.
    await openSettingsAdvanced(page);
    await expect(page.getByLabel('연결 주소 (GAS API)')).toHaveValue(pinned);
  } finally {
    await stopStaticServer(server);
  }
});

// 반대쪽 절반: 개발 harness에서는 계속 편집할 수 있어야 한다. 모든 곳을 잠그는 것으로
// 위 게이트를 "통과"시키면 로컬 mock API 연결이 끊긴다.
test('keeps the advanced address field editable on a development host', async ({ page }) => {
  const { server, origin } = await serverOrigin();

  try {
    await page.goto(`${origin}next/?k=owner-token`, { waitUntil: 'networkidle' });
    expect(await page.evaluate(() => location.hostname)).toBe('127.0.0.1');

    await openSettingsAdvanced(page);
    const apiField = page.getByLabel('연결 주소 (GAS API)');
    await expect(apiField).toBeVisible();
    await expect(apiField).toBeEditable();

    // 개발 호스트에서는 harness mock 주소가 실제로 채택된다.
    await apiField.fill('https://api.example.test/exec');
    await page.getByRole('button', { name: '설정 저장' }).click();
    expect(await page.evaluate(() => localStorage.getItem('cc_api'))).toBe('https://api.example.test/exec');
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
