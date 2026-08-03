// 회귀 게이트: 반복 실패로 잠긴 receipt 앞에서 화면이 죽은 버튼을 내밀지 않는가.
// Kairen-Ref: TSK-000531 / ISS-000232
//
// founder 실측 2026-08-04:
//   "현재 명함 기록에, 혹은 진행에, 조사 지시 PER-418이 진행 중인데,
//    이거 다시 처리 요청해도 안 되고, 뭐 반응이 없어서, 요거 뭔가 잘 해결해 줬으면 해."
//
// 그 receipt는 워처에서 requeue 2회 x 처리기 exit 1 3회 = 연속 실패 6회로 잠겨 있었고,
// 워처는 그 뒤의 requeue를 받지 않는다. 그런데 화면은 그 사실을 모른 채 `다시 처리 요청`을
// 계속 보여 줬다 — 누르면 서버는 200을 주고, 워처는 조용히 무시하고, 아무 일도 일어나지 않는다.
//
// 이 파일이 잠그는 것:
//   (결함) R-1 워처가 잠근 receipt에도 `다시 처리 요청`이 남아 있었다.
//   (결함) R-2 무엇이 멈췄는지·지금 무엇을 할 수 있는지 말하는 자리가 없었다.
//   (경계) R-3 잠기지 않은 항목에서는 그 버튼이 그대로 있어야 한다 (과잉 제거 방지).
//   (경계) R-4 목록 JSON은 untrusted다 — 모르는 영수증은 화면에 닿지 않고, 원인 코드도 찍히지 않는다.
//   (표면) R-5 320px 폭에서 가로로 넘치지 않고, 다크에서도 토큰 색을 따른다.
//
// 게이트 전제 점검: "이 단언이 실제로 그 표면을 여는가?" — 부정 단언(`버튼이 없다`)마다
// 그 카드가 정말 그 상태로 렌더됐다는 양성 증거(복구 안내 문구·상태 배지)를 함께 요구한다.
// 그렇지 않으면 카드가 통째로 사라져도 통과한다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webmanifest': 'application/manifest+json; charset=utf-8',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) { response.writeHead(403).end('Forbidden'); return; }
      const body = await readFile(filePath);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch { response.writeHead(404).end('Not found'); }
  });
  server.keepAliveTimeout = 1;
  return new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => done(server)); });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((stop) => { server.close(() => stop()); server.closeAllConnections(); });
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

/** 합성 조사 receipt. 실제 캡처·사람 데이터는 쓰지 않는다. */
function receipt(captureId: string, recovery: Record<string, unknown> | null) {
  return {
    captureId,
    capturedAt: ago(600),
    receivedAt: ago(590),
    status: 'received',
    type: 'research_instruction',
    ...(recovery ? { recovery } : {}),
  };
}

interface Harness {
  server: Server;
  requeues: string[];
}

async function boot(page: Page, items: Array<Record<string, unknown>>, options: { width?: number; theme?: string } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const requeues: string[] = [];

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    const body = request.postData() ?? '';
    if (action === 'list') {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items }),
      });
      return;
    }
    if (body.includes('"requeue"')) {
      requeues.push(String(/"captureId":"([^"]+)"/.exec(body)?.[1] ?? ''));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });

  await page.addInitScript((theme) => {
    localStorage.setItem('cc_name', '이강규');
    if (theme) localStorage.setItem('cc_theme', theme);
  }, options.theme ?? '');

  await page.setViewportSize({ width: options.width ?? 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, requeues };
}

const cardOf = (page: Page, captureId: string) => page.locator(`#capture-${captureId}`);

// ── R-1 · R-2: 잠긴 receipt에는 죽은 버튼 대신 무슨 일이 있었는지가 온다 ──

test('반복 실패로 잠긴 항목은 다시 처리 버튼 대신 원인과 할 수 있는 일을 말한다', async ({ page }) => {
  const harness = await boot(page, [receipt('20260803-090000-r1', {
    kind: 'recovery_required', reasonCode: 'processor_failed',
    attempts: 3, failures: 6, threshold: 6, since: ago(180),
  })]);
  try {
    const card = cardOf(page, '20260803-090000-r1');
    await expect(card).toBeVisible();

    // 양성 증거 먼저: 이 카드가 정말 '복구 필요'로 렌더됐다.
    await expect(card.locator('.status-badge.status-recovery')).toHaveText(/복구 필요/);
    const notice = card.locator('.int29-recovery');
    await expect(notice).toBeVisible();
    // 사람이 읽는 말이어야 한다 — 기계 원인 코드는 화면 어디에도 없다.
    await expect(notice).toContainText('정리 작업이 도중에 멈췄어요');
    await expect(notice).not.toContainText('processor_failed');
    // 멈춘 것에는 반드시 경과가 붙는다.
    await expect(notice.locator('.int29-recovery-facts')).toContainText('3시간째');
    await expect(notice.locator('.int29-recovery-facts')).toContainText('같은 문제 6/6회');
    // 원본이 남아 있다는 사실이 먼저 온다 (사용자가 가장 먼저 걱정하는 것).
    await expect(notice).toContainText('사진·요청 내용은 그대로 있어요');

    // 결함 자체: 이 상태에서 `다시 처리 요청`이 남아 있으면 안 된다.
    await expect(card.getByRole('button', { name: '다시 처리 요청' })).toHaveCount(0);
    // 대신 실제로 무언가 하는 길이 하나 있다.
    const report = notice.getByRole('link', { name: /이 항목 알리기/ });
    await expect(report).toBeVisible();
    const href = await report.getAttribute('href');
    expect(href, `알리기 링크 실측: ${href}`).toContain('mailto:');
    expect(decodeURIComponent(href ?? '')).toContain('20260803-090000-r1');

    // 화면에서 requeue를 보낼 방법이 없다 = 아무 요청도 나가지 않았다.
    expect(harness.requeues, '잠긴 항목에서 requeue가 나갔다').toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

// ── R-3: 잠기지 않은 항목에서는 그 버튼이 그대로 있어야 한다 ──

test('일시 실패는 재시도 예정이라고 말하고 다시 처리 요청은 그대로 둔다', async ({ page }) => {
  const harness = await boot(page, [receipt('20260803-100000-r2', {
    kind: 'retry_scheduled', reasonCode: 'processor_failed',
    attempts: 1, failures: 1, threshold: 6, since: ago(4),
  })]);
  try {
    const card = cardOf(page, '20260803-100000-r2');
    await expect(card).toBeVisible();
    // 복구 필요와 다른 상태다 — 안내 블록도, 배지도 오지 않는다.
    await expect(card.locator('.int29-recovery')).toHaveCount(0);
    await expect(card.locator('.status-badge.status-recovery')).toHaveCount(0);
    // 대신 표준 진행 문구가 말하지 않는 사실 한 줄이 온다.
    await expect(card.locator('.int29-flow-note')).toContainText('곧 자동으로 다시 시도해요');
    await expect(card.locator('.int29-flow-note')).toContainText('1번째 시도');
    // 그리고 손은 그대로 닿는다.
    await expect(card.getByRole('button', { name: '다시 처리 요청' })).toBeVisible();
  } finally {
    await stopServer(harness.server);
  }
});

test('영수증이 없는 평범한 대기 항목의 다시 처리 요청은 사라지지 않는다', async ({ page }) => {
  const harness = await boot(page, [receipt('20260803-110000-r3', null)]);
  try {
    const card = cardOf(page, '20260803-110000-r3');
    await expect(card).toBeVisible();
    await expect(card.locator('.int29-recovery')).toHaveCount(0);
    const button = card.getByRole('button', { name: '다시 처리 요청' });
    await expect(button).toBeVisible();
    await button.click();
    await expect.poll(() => harness.requeues).toEqual(['20260803-110000-r3']);
  } finally {
    await stopServer(harness.server);
  }
});

// ── R-4: 목록 JSON은 untrusted다 ──

test('모르는 영수증은 화면에 닿지 않고 원인 코드도 찍히지 않는다', async ({ page }) => {
  const harness = await boot(page, [
    receipt('20260803-120000-r4', { kind: 'please_render_me', reasonCode: 'processor_failed', since: ago(10) }),
    receipt('20260803-120100-r5', { kind: 'recovery_required', reasonCode: '<b>주입</b>', since: ago(10) }),
  ]);
  try {
    for (const id of ['20260803-120000-r4', '20260803-120100-r5']) {
      const card = cardOf(page, id);
      await expect(card).toBeVisible();
      await expect(card.locator('.int29-recovery')).toHaveCount(0);
      // 모르는 상태에서는 기존 동작을 그대로 유지한다 (fail-open이 아니라 '아무 것도 새로 하지 않는다').
      await expect(card.getByRole('button', { name: '다시 처리 요청' })).toBeVisible();
    }
    const text = await page.locator('.feed, ion-content').first().innerText();
    expect(text).not.toContain('please_render_me');
    expect(text).not.toContain('주입');
  } finally {
    await stopServer(harness.server);
  }
});

// ── R-5: 좁은 폭과 다크 ──

test('320px 폭에서도 복구 안내가 가로로 넘치지 않는다', async ({ page }) => {
  const harness = await boot(page, [receipt('20260803-130000-r6', {
    kind: 'recovery_required', reasonCode: 'processor_timeout',
    attempts: 3, failures: 6, threshold: 6, since: ago(90),
  })], { width: 320 });
  try {
    const notice = cardOf(page, '20260803-130000-r6').locator('.int29-recovery');
    await expect(notice).toBeVisible();
    // 폭 기준은 clientWidth다 — emulation에서 innerWidth는 거짓을 말한다.
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      block: Array.from(document.querySelectorAll('.int29-recovery'))
        .map((node) => node.scrollWidth - node.clientWidth),
    }));
    expect(overflow.doc, '문서가 가로로 넘친다').toBeLessThanOrEqual(1);
    for (const value of overflow.block) expect(value, '복구 안내가 자기 폭을 넘긴다').toBeLessThanOrEqual(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('다크에서도 복구 안내는 하드코딩 색이 아니라 테마 토큰을 따른다', async ({ page }) => {
  const lightHarness = await boot(page, [receipt('20260803-140000-r7', {
    kind: 'recovery_required', reasonCode: 'result_incomplete',
    attempts: 3, failures: 6, threshold: 6, since: ago(30),
  })]);
  let light: { color: string; background: string };
  try {
    await expect(cardOf(page, '20260803-140000-r7').locator('.int29-recovery')).toBeVisible();
    light = await page.locator('.int29-recovery strong').evaluate((node) => ({
      color: getComputedStyle(node).color,
      background: getComputedStyle(node.closest('.int29-recovery') as HTMLElement).backgroundColor,
    }));
  } finally {
    await stopServer(lightHarness.server);
  }

  const darkHarness = await boot(page, [receipt('20260803-140000-r7', {
    kind: 'recovery_required', reasonCode: 'result_incomplete',
    attempts: 3, failures: 6, threshold: 6, since: ago(30),
  })], { theme: 'dark' });
  try {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const dark = await page.locator('.int29-recovery strong').evaluate((node) => ({
      color: getComputedStyle(node).color,
      background: getComputedStyle(node.closest('.int29-recovery') as HTMLElement).backgroundColor,
    }));
    // 두 테마에서 값이 같다면 색이 토큰이 아니라 리터럴로 박혀 있다는 뜻이다.
    expect(dark.color, `light=${light.color} dark=${dark.color}`).not.toBe(light.color);
    expect(dark.background, `light=${light.background} dark=${dark.background}`).not.toBe(light.background);
  } finally {
    await stopServer(darkHarness.server);
  }
});
