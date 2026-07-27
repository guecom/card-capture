import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// 회귀 게이트: 같은 GitHub Pages 루트에 **함께 서빙되는 이전 앱**(`docs/legacy.html`)도
// 개인 링크 코드(bearer token) 경계를 지킨다.
//
// 왜 별도 파일인가: `credential-boundary.spec.ts` 는 다섯 테스트가 전부 `next/` 만 연다.
// 같은 정적 루트에 legacy 앱이 살아 있는데(root sw.js 프리캐시 + React 설정의 `이전 앱 열기` 링크)
// 한 번도 열지 않은 채 "적대적 origin 요청 0건"을 선언했다. 그 전제가 이 게이트의 존재 이유다.
//
// Kairen-Ref: TSK-000286 (FI-004 / FI-005 — legacy surface)

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

/** 빌드에 박힌 유일한 신뢰 API origin — `docs/legacy.html` 의 DEFAULT_API 와 같은 origin. */
const PINNED_ORIGIN = 'https://script.google.com';
/** 적대적 origin. `.invalid`는 공개 DNS에 존재할 수 없고 앱의 신뢰 집합에도 없다. */
const HOSTILE_API = 'https://attacker.invalid/exec';
/** 명백히 가짜인 테스트 값. 실토큰은 어떤 경우에도 쓰지 않는다. */
const FAKE_TOKEN = 'e2e-fake-token-not-a-real-credential';

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

interface WireRecord {
  url: string;
  referer: string;
}

/**
 * 이 브라우저 컨텍스트가 내보내는 **모든** 요청을 기록하고, 정적 harness origin 밖으로는
 * 한 바이트도 내보내지 않는다. 실제 GAS 엔드포인트로 인증 요청이 나가는 것을 구조적으로 막는다.
 */
async function fenceNetwork(page: Page, origin: string, items: unknown[] = []): Promise<WireRecord[]> {
  const wire: WireRecord[] = [];
  await page.context().route(() => true, async (route) => {
    const request = route.request();
    const headers = await request.allHeaders().catch(() => ({} as Record<string, string>));
    wire.push({ url: request.url(), referer: headers.referer ?? '' });
    if (request.url().startsWith(origin)) {
      // 카메라/OCR 엔진 자산은 이 게이트와 무관하다 — 내려받지 않아 테스트를 가볍게 유지한다.
      if (request.url().includes('/vendor/')) return route.abort();
      return route.continue();
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, seeAll: false, researchInstructionEnabled: false, hasMore: false, items }),
    });
  });
  return wire;
}

const listRequests = (wire: WireRecord[]) => wire.filter((record) => record.url.includes('action=list'));
const external = (wire: WireRecord[], origin: string) => wire.filter((record) => !record.url.startsWith(origin));

/** boot의 브리핑 목록 요청이 실제로 나갈 때까지 기다린다 — red/green 양쪽에서 결정적이다. */
async function waitForBootRequest(wire: WireRecord[]): Promise<void> {
  await expect.poll(() => listRequests(wire).length, { timeout: 15_000 }).toBeGreaterThan(0);
}

test.beforeEach(async ({ page }) => {
  // 첫 실행 이름 온보딩 모달이 화면을 가리지 않게 이름을 미리 넣는다.
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
});

test('never sends the personal link code to an API origin supplied through the legacy link', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?api=${encodeURIComponent(HOSTILE_API)}&k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    // 1) credential이 실린 요청은 빌드에 박힌 origin으로만 나간다.
    expect(external(wire, origin).filter((record) => !record.url.startsWith(PINNED_ORIGIN)).map((record) => record.url)).toEqual([]);
    // 2) 거부한 주소를 저장하지 않는다 — 저장되면 다음 실행에서 조용히 되살아난다.
    expect(await page.evaluate(() => localStorage.getItem('cc_api') ?? '')).not.toContain('attacker.invalid');
    // 3) 무시했다는 사실을 화면에 말한다.
    await expect(page.getByText('허용되지 않은 서버 주소라 무시했어요', { exact: false })).toBeVisible();
  } finally {
    await stopStaticServer(server);
  }
});

test('does not revive a hostile API address that an earlier legacy visit already stored', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  // 이 기기는 이미 오염돼 있다: 예전 빌드가 `?api=` 를 무검증으로 저장해 뒀다.
  await page.addInitScript(([api, token]) => {
    localStorage.setItem('cc_api', api);
    localStorage.setItem('cc_token', token);
  }, [HOSTILE_API, FAKE_TOKEN]);
  const wire = await fenceNetwork(page, origin);

  try {
    // 파라미터 없는 평범한 재실행(홈 화면 아이콘)에서도 되살아나면 안 된다.
    await page.goto(`${origin}legacy.html`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    expect(external(wire, origin).filter((record) => !record.url.startsWith(PINNED_ORIGIN)).map((record) => record.url)).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('cc_api'))).toBeNull();
  } finally {
    await stopStaticServer(server);
  }
});

test('removes the personal link code from the legacy address bar without losing the connection', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?view=search&k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    // 코드는 저장되지만 주소에는 남지 않는다. 나머지 파라미터(view)는 그대로다.
    await expect(page).toHaveURL(`${origin}legacy.html?view=search`);
    expect(await page.evaluate(() => localStorage.getItem('cc_token'))).toBe(FAKE_TOKEN);
    // 뒤로 가기로 코드가 실린 주소가 되살아나지 않는다 (replaceState여야 성립).
    expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);
  } finally {
    await stopStaticServer(server);
  }
});

test('never puts the personal link code into a Referer header from the legacy page', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin);

  try {
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    // 문서 파싱 중 나가는 자산 요청은 주소창 정리(replaceState)보다 앞선다 —
    // 이 구간을 막는 것은 referrer 정책뿐이다.
    expect(wire.filter((record) => record.referer.includes(FAKE_TOKEN)).map((record) => record.url)).toEqual([]);
    // 정책을 문서가 스스로 선언한다 (자산 요청 이전에 적용되도록 <head>에서).
    expect(await page.evaluate(() => document.querySelector('meta[name="referrer"]')?.getAttribute('content') ?? '')).toBe('no-referrer');
  } finally {
    await stopStaticServer(server);
  }
});

test('keeps the legacy invitation link working with only the personal code', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  const wire = await fenceNetwork(page, origin, [{
    captureId: '20260727-100000-e2e',
    capturedAt: '2026-07-27T01:00:00.000Z',
    receivedAt: '2026-07-27T01:00:00.000Z',
    status: 'processed',
    person: 'PER-E2E',
    brief: '# 합성 담당자 — 이런 분이에요\n합성 fixture 문장.',
  }]);

  try {
    // 정상 초대 링크: 코드만 있고 서버 주소는 붙지 않는다.
    await page.goto(`${origin}legacy.html?k=${FAKE_TOKEN}`, { waitUntil: 'domcontentloaded' });
    await waitForBootRequest(wire);

    // 빌드에 박힌 주소로, 링크 코드를 실어 정상 호출한다.
    const boot = listRequests(wire)[0];
    expect(boot.url.startsWith(`${PINNED_ORIGIN}/`)).toBe(true);
    expect(boot.url).toContain(`k=${FAKE_TOKEN}`);

    // 설정 안내 배너가 뜨지 않는다 = 앱이 스스로를 "연결됨"으로 판정한다.
    await expect(page.locator('#setupBanner')).toBeHidden();
    // 연결된 화면은 촬영 표면이다. 브리핑 본문은 이 화면의 범위가 아니라 렌더되지 않는다
    // (축소 범위 회귀는 legacy-scope.spec.ts 가 소유한다 — Kairen-Ref: TSK-000301).
    await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
    await expect(page.getByText('합성 fixture 문장.')).toHaveCount(0);
  } finally {
    await stopStaticServer(server);
  }
});
