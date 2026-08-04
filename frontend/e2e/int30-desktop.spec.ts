import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PC 진입 회귀 게이트 — Kairen-Ref: TSK-000545 (INT-000030 / ISS-000235 / DEC-000105)
 *
 * founder 보고 2026-08-04 (hub.kairenhq.com → PC로 명함 캡처 앱 진입):
 *   "일단 들어가면은 링크 설정이 필요해요라고 위에 경고문이 뜨고, 그러고 AI 조사 요청이라든가
 *    그런 게 캡처 화면에 보이지 않아."
 *
 * 원인은 성긴 setup gate였다. `configured = Boolean(apiUrl && token)` boolean 하나가
 * "서버에 물어볼 수 있는가"와 "화면에 무엇을 그릴 것인가"를 동시에 결정했고, 그래서 연결이
 * 없다는 이유만으로 **로컬로 멀쩡히 되는 기능들이 사라졌다**.
 *
 * 아래 게이트가 고정하는 계약:
 *   1. 미설정 PC 첫 진입에서도 직접 입력·AI 조사 요청·기록/진행이 보인다.
 *   2. 연결 안내는 전면 경고가 아니라 막힌 기능 옆 inline card + 손잡이 하나다.
 *   3. 웹캠이 막혀도 다른 입구는 숨지 않는다.
 *   4. 링크 코드는 주소·기록·referrer·콘솔·계측 어디에도 남지 않는다.
 */

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

/** 명백히 가짜인 시험 값. 실토큰을 절대 넣지 않는다. */
const FAKE_LINK_CODE = 'fake-e2e-int30-link-code';
const MOCK_API = 'https://api.example.test/exec';

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

/** 촬영 탭에서 **연결 없이도 살아 있어야 하는** 핵심 표면. 하나라도 빠지면 결함이다. */
async function expectCoreShell(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
  // 사람을 등록하는 입구: 촬영과 직접 입력은 위계가 같다 (DEC-000103).
  await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
  await expect(page.getByRole('button', { name: /직접 입력/ })).toBeVisible();
  // founder가 "보이지 않는다"고 보고한 바로 그 표면.
  await expect(page.locator('.ai-surface-head strong', { hasText: 'AI 조사 요청' })).toBeVisible();
  // 만남 맥락과 기록/진행.
  await expect(page.getByRole('button', { name: /만남 맥락/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /명함 기록/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '완료' })).toBeVisible();
}

/** 전면 경고는 어떤 상태에서도 존재하지 않는다. */
async function expectNoBlockingBanner(page: Page): Promise<void> {
  await expect(page.getByText('링크 설정이 필요해요')).toHaveCount(0);
  await expect(page.locator('.setup-banner')).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.context().route('**/vendor/**', (route) => route.abort());
  // 실 GAS 배포본으로는 어떤 요청도 나가지 않는다.
  await page.context().route('https://script.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
  }));
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
});

test.describe('PC 진입 — 데스크톱 1280×800', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('keeps the working parts of the shell on a first PC visit with no personal link', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    try {
      await page.goto(`${origin}next/`, { waitUntil: 'domcontentloaded' });

      // 미설정 상태 전제 — 이 전제가 깨지면 아래 단언은 아무것도 증명하지 않는다.
      expect(await page.evaluate(() => localStorage.getItem('cc_token'))).toBeNull();

      await expectCoreShell(page);
      await expectNoBlockingBanner(page);
    } finally {
      await stopStaticServer(server);
    }
  });

  test('anchors the setup card on the blocked feature instead of covering the screen', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    try {
      await page.goto(`${origin}next/`, { waitUntil: 'domcontentloaded' });
      await expectCoreShell(page);

      const setup = page.getByRole('status', { name: '명함 기록 연결 안내' });
      await expect(setup).toBeVisible();

      // 화면 맨 위가 아니다 — 촬영 카드 **아래**, 즉 실제로 막힌 것 옆에 있다.
      const captureBox = await page.locator('.capture-card').boundingBox();
      const setupBox = await setup.boundingBox();
      expect(captureBox && setupBox && setupBox.y > captureBox.y).toBe(true);

      // 손잡이는 하나이고, 그 하나가 앱 안의 연결 설정으로 데려간다.
      await expect(setup.getByRole('button')).toHaveCount(1);
      await setup.getByRole('button', { name: '연결 설정 열기' }).click();
      await expect(page.getByRole('heading', { name: '계정·연결' })).toBeVisible();
    } finally {
      await stopStaticServer(server);
    }
  });

  test('keeps every other entry when the webcam is denied', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    /* 권한 거부를 실제로 재현한다. Chrome의 fake-capture 플래그는 이 환경에서 신뢰할 수 없으므로
       `getUserMedia`를 직접 덮어써 브라우저가 던지는 것과 같은 오류를 만든다.

       기기 목록에는 카메라가 **있다**고 답한다. `카메라가 아예 없다`와 `카메라는 있는데 권한이
       거부됐다`는 서로 다른 세계이고, 이 게이트가 재려는 것은 두 번째다 (첫 번째는
       `int30-integration.spec.ts`가 잰다). 예전에는 목록을 빈 배열로 두었는데, 진입 카드가
       기기 능력을 읽기 시작한 뒤로는 그 stub이 "카메라 없는 PC"를 뜻하게 됐다. */
    await page.addInitScript(() => {
      const denied = () => {
        const error = new Error('Permission denied');
        error.name = 'NotAllowedError';
        return Promise.reject(error);
      };
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
          getUserMedia: denied,
          enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: '', label: '', groupId: '' }]),
        },
      });
    });

    try {
      await page.goto(`${origin}next/`, { waitUntil: 'domcontentloaded' });
      await expectCoreShell(page);

      // 카메라를 실제로 열어 실패시킨다.
      await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
      await expect(page.getByText('카메라 권한이 꺼져 있습니다', { exact: false })).toBeVisible({ timeout: 15_000 });
      // 막다른 길이 아니다 — 그 화면 안에도 대체 수단이 남아 있다.
      await expect(page.getByRole('button', { name: /기본 카메라 앱으로 찍기/ })).toBeVisible();
      await page.getByRole('button', { name: '닫기' }).click();

      // 그리고 촬영이 막혔다고 해서 나머지 입구가 사라지지 않는다.
      await expectCoreShell(page);
      await expectNoBlockingBanner(page);
      /* 방금 있었던 일을 카드가 기억한다 (TSK-000220 통합). 예전에는 거부가 모달 안에서만
         보이고 닫는 순간 잊혔다 — 사용자는 자기가 방금 거부한 입구가 아무 일 없었다는 얼굴로
         다시 서 있는 것을 봤다. 조회는 방금 거부를 곧바로 말해 주지 않으므로,
         **실제로 열어 본 결과**가 이 화면이 가진 가장 구체적인 사실이다. */
      const camera = page.getByRole('button', { name: '명함 앞면 촬영' });
      await expect(camera).toContainText('권한이 꺼져 있어요');
      await expect(camera).toContainText('카메라 권한 다시 열기');
    } finally {
      await stopStaticServer(server);
    }
  });

  test('keeps the shell alive when the server rejects the personal link', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    await page.context().route(`${MOCK_API}**`, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'invalid_token' }),
    }));

    try {
      await page.goto(`${origin}next/?api=${encodeURIComponent(MOCK_API)}&k=${FAKE_LINK_CODE}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });

      // 연결이 거절돼도 껍데기와 로컬로 되는 일은 그대로 산다.
      await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
      await expect(page.getByRole('button', { name: /직접 입력/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /명함 기록/ })).toBeVisible();
      await expectNoBlockingBanner(page);

      // 진행 탭도 통째로 잠기지 않는다.
      await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '진행' }).click();
      await expect(page.locator('.records-feed')).toBeVisible();
    } finally {
      await stopStaticServer(server);
    }
  });

  test('treats a hub-style entry as a target address plus a non-secret hint only', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    try {
      // Hub가 넘기는 것은 목적지와 환경 힌트뿐이다. 자격 정보는 들어 있지 않다.
      await page.goto(`${origin}next/?src=hub&env=prod`, { waitUntil: 'domcontentloaded' });
      await expectCoreShell(page);
      await expectNoBlockingBanner(page);

      // 힌트를 자격 정보로 착각해 저장하지 않는다.
      const stored = await page.evaluate(() => ({
        token: localStorage.getItem('cc_token'),
        api: localStorage.getItem('cc_api'),
        all: Object.values(localStorage).map(String).join('\n'),
      }));
      expect(stored.token).toBeNull();
      expect(stored.api).toBeNull();
      expect(stored.all).not.toContain('hub');
    } finally {
      await stopStaticServer(server);
    }
  });
});

test.describe('PC 진입 — 좁은 데스크톱 창 900×700', () => {
  test.use({ viewport: { width: 900, height: 700 } });

  test('keeps the same entries and does not push the page sideways', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    try {
      await page.goto(`${origin}next/`, { waitUntil: 'domcontentloaded' });
      await expectCoreShell(page);
      await expectNoBlockingBanner(page);
      await expect(page.getByRole('status', { name: '명함 기록 연결 안내' })).toBeVisible();

      // 폭 판정은 `clientWidth`로 한다 — emulation에서 `innerWidth`는 거짓을 말한다.
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return { scroll: root.scrollWidth, client: root.clientWidth };
      });
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
    } finally {
      await stopStaticServer(server);
    }
  });
});

test.describe('자격 정보 0건 — negative fixture', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('leaves no credential in the URL, history, referrer, console, or instrumentation', async ({ page }) => {
    const { server, origin } = await serverOrigin();
    const consoleLines: string[] = [];
    const referrers: string[] = [];
    const foreignUrls: string[] = [];
    // 사용자가 실제로 누른 그 링크 한 건. 입력이지 유출이 아니므로 대상에서 뺀다 —
    // 그 **다음**부터 코드가 실린 주소가 다시 나타나면 그것은 유출이다.
    const entryUrl = `${origin}next/?api=${encodeURIComponent(MOCK_API)}&k=${FAKE_LINK_CODE}&view=briefs`;

    page.on('console', (message) => consoleLines.push(message.text()));
    page.on('pageerror', (error) => consoleLines.push(String(error)));
    page.on('request', (request) => {
      const referer = request.headers().referer ?? request.headers().referrer ?? '';
      if (referer) referrers.push(referer);
      // API 자신은 코드를 query로 싣는다(설계). 그 외 어디로도 새지 않는지가 이 게이트의 대상이다.
      if (request.url() !== entryUrl && !request.url().startsWith(MOCK_API)) foreignUrls.push(request.url());
    });

    await page.context().route(`${MOCK_API}**`, (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
    }));

    try {
      await page.goto(entryUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });

      // 전제 — 코드가 실제로 채택됐다. 채택되지 않았다면 아래 단언은 공허하게 통과한다.
      expect(await page.evaluate(() => localStorage.getItem('cc_token'))).toBe(FAKE_LINK_CODE);

      // 1) 주소창에 남지 않는다.
      expect(page.url()).not.toContain(FAKE_LINK_CODE);
      expect(page.url()).not.toContain('k=');

      // 2) 방문 기록으로 되살릴 수 없다 (push가 아니라 replace여야 성립).
      expect(await page.evaluate(() => history.length)).toBeLessThanOrEqual(2);

      // 앱을 계속 쓴다 — 탭을 옮기고 새로고침해도 같아야 한다.
      const nav = page.getByRole('navigation', { name: '주요 화면' });
      await nav.getByRole('button', { name: '캡처' }).click();
      await nav.getByRole('button', { name: '진행' }).click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });

      const leaks = await page.evaluate(([code, api]) => {
        // API 호출 자신은 코드를 query로 싣는다 — `?k=` 인증의 설계이고 이 게이트의 대상이 아니다.
        // 대상은 **그 밖의 모든 곳**이다: 자산 주소, 계측 beacon, 화면 안의 링크.
        const resources = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => !name.startsWith(api));
        const links = Array.from(document.querySelectorAll('a[href]')).map((node) => node.getAttribute('href') ?? '');
        return {
          href: location.href,
          hash: location.hash,
          referrer: document.referrer,
          title: document.title,
          // 화면에 그려진 글자 어디에도 코드가 없다 — 스크린샷·화면 공유로도 새지 않는다.
          bodyText: document.body.innerText,
          resources: resources.filter((name) => name.includes(code)),
          links: links.filter((href) => href.includes(code)),
          session: Object.values(sessionStorage).map(String).join('\n'),
        };
      }, [FAKE_LINK_CODE, MOCK_API] as const);

      // 3) 주소·hash·referrer·제목·본문 어디에도 없다.
      expect(leaks.href).not.toContain(FAKE_LINK_CODE);
      expect(leaks.hash).not.toContain(FAKE_LINK_CODE);
      expect(leaks.referrer).not.toContain(FAKE_LINK_CODE);
      expect(leaks.title).not.toContain(FAKE_LINK_CODE);
      expect(leaks.bodyText).not.toContain(FAKE_LINK_CODE);
      // 4) 계측(resource timing)과 화면 안의 링크에도 없다.
      expect(leaks.resources).toEqual([]);
      expect(leaks.links).toEqual([]);
      expect(leaks.session).not.toContain(FAKE_LINK_CODE);
      // 5) 콘솔로 흘리지 않는다.
      expect(consoleLines.filter((line) => line.includes(FAKE_LINK_CODE))).toEqual([]);
      // 6) 어떤 요청의 Referer에도 실리지 않는다.
      expect(referrers.filter((value) => value.includes(FAKE_LINK_CODE))).toEqual([]);
      // 7) API 외의 어떤 주소로도 나가지 않는다.
      expect(foreignUrls.filter((value) => value.includes(FAKE_LINK_CODE))).toEqual([]);
      // 전제 — 실제로 요청이 오갔다. 0건이면 위 두 필터가 공허하게 통과한다.
      expect(referrers.length).toBeGreaterThan(0);
    } finally {
      await stopStaticServer(server);
    }
  });
});
