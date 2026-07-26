// INT-000015 회귀 게이트.
//   001 만남 맥락의 시각 위계 (ISS-000084 / TSK-000220)
//   002 조사 지시가 AI에게 맡기는 일로 보이는가 (ISS-000082 / TSK-000218)
//   003 AI 사람 찾기의 체감 속도·진행 표면 (ISS-000103 / TSK-000249)
//   004 결과가 한 명이 아니라 근거 있는 후보 묶음인가 (ISS-000103 / TSK-000249)
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const DAY_MINUTES = 24 * 60;

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

// 같은 회사 사람이 여럿, 같은 행사에서 만난 사람이 여럿 — "여러 명이 나오는" 질의를 재현한다.
function listFixture() {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const person = (index: number, name: string, organization: string, title: string, event: string, days: number) => ({
    captureId: `2026071${index}-090000-a${index}`,
    receivedAt: ago(days * DAY_MINUTES),
    status: 'processed',
    person: `PER-00000${index}`,
    capturer: '이강규',
    event,
    contact: { name, title, organization },
    brief: `# ${name} — 이런 분이에요\n${organization} ${title}입니다.`,
  });
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: false,
    items: [
      person(1, '김민서', '한화시스템', '구매팀장', '2026 로보월드', 3),
      person(2, '이서연', '한화에어로스페이스', '책임연구원', '2026 로보월드', 4),
      person(3, '박지훈', '한화시스템', 'CTO', '판교 밋업', 5),
      person(4, '정하늘', '넥스트로보', '대표', '판교 밋업', 6),
    ],
  };
}

interface Harness { server: Server; requests: string[] }

async function boot(page: import('@playwright/test').Page): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const requests: string[] = [];

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    requests.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture()) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await page.addInitScript(() => { localStorage.setItem('cc_name', '이강규'); });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, requests };
}

// 001: 네 칸이 같은 무게로 쌓여 촬영 버튼을 아래로 밀던 구조를 접히는 카드 하나로 바꿨다.
test('the meeting-context block stays quiet until opened, then reads back exactly what it stores', async ({ page }) => {
  const harness = await boot(page);
  try {
    const block = page.locator('.context-block');
    await expect(block.getByText('만남 맥락')).toBeVisible();
    // 접힌 상태에서는 입력 칸이 하나도 펼쳐져 있지 않다 — 촬영 버튼이 아래로 밀리지 않는다.
    await expect(block.locator('ion-input')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /만남 맥락/ })).toHaveAttribute('aria-expanded', 'false');

    await page.getByRole('button', { name: /만남 맥락/ }).click();
    // `2시간 유지` 안내는 칸마다 반복하지 않고 영역 위에 한 번만 나온다.
    await expect(block.getByText(/2시간 동안 그대로 남아요/)).toHaveCount(1);
    await expect(block.getByText(/2시간/)).toHaveCount(1);

    // 자주 쓰는 답은 chip으로 먼저 제안하고, chip을 누르면 그 값이 입력된다.
    await block.getByRole('button', { name: '잠재 고객' }).click();
    await block.getByRole('group', { name: '나와의 관계 예시' }).getByRole('button', { name: '오늘 처음' }).click();
    await page.getByRole('button', { name: /만남 맥락/ }).click();
    // 접으면 저장될 내용이 한 줄 요약으로 남는다 — 지어낸 문장이 아니라 입력한 값 그대로다.
    await expect(block.getByText('Kairen: 잠재 고객 · 나: 오늘 처음')).toBeVisible();
    await expect(block.getByText('2개')).toBeVisible();
  } finally {
    harness.server.close();
  }
});

// 002: 조사 지시는 일반 메모가 아니라 AI에게 맡기는 일이다. 표면·표식·단계·경계가 그렇게 보여야 한다.
test('the research request looks and behaves like handing work to an AI, without widening its authority', async ({ page }) => {
  const harness = await boot(page);
  try {
    const surface = page.locator('.ai-surface.research-request');
    await expect(surface.getByText('AI 조사 요청')).toBeVisible();
    await expect(surface.getByText('소유자 전용')).toBeVisible();
    await expect(surface.getByText('공개 자료에서 확인할 내용을 AI에게 맡깁니다.')).toBeVisible();

    // 접수 후 어떤 단계를 거치는지 미리 보인다 — 불투명한 로딩이 아니다.
    const rail = surface.locator('.ai-stage-rail');
    await expect(rail.getByText('작성 중')).toBeVisible();
    await expect(rail.getByText('공개 자료 조사 중')).toBeVisible();
    await expect(rail.getByText('출처 정리 중')).toBeVisible();
    await expect(rail.locator('li.ai-stage-active')).toHaveText(/작성 중/);

    // 권한 경계는 화면에 그대로 적혀 있다 (DEC-000035를 넓히지 않는다).
    await expect(surface.getByText(/로그인이 필요한 자료, 민감한 특성 추론, 외부로 보내는 행동은 하지 않아요/)).toBeVisible();

    // 예시 chip은 기존 입력을 지우지 않고 덧붙인다.
    await surface.locator('ion-textarea textarea').fill('최근 발표 확인');
    await surface.getByRole('button', { name: '회사 소식·투자' }).click();
    await expect(surface.locator('ion-textarea textarea')).toHaveValue('최근 발표 확인, 회사 소식·투자');
  } finally {
    harness.server.close();
  }
});

// 003: 첫 후보가 네트워크 왕복을 기다리지 않는다. 진행 중에는 실제 단계와 경과 시간이 보인다.
test('recall search answers from the device first and shows the real stage it is in', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '검색', exact: true }).click();
    await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();

    // 목록 응답을 붙잡아 둔다 — 서버가 느려도 기기 기록으로 낸 첫 후보는 이미 보여야 한다.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolveHold) => { release = resolveHold; });
    await page.route('https://api.example.test/**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('action') !== 'list') { await route.fallback(); return; }
      await held;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture()) });
    });

    await page.getByRole('textbox').fill('한화 사람');
    await page.getByRole('button', { name: '찾기' }).click();

    // 서버 응답 전에 후보가 이미 화면에 있다.
    await expect(page.locator('.recall-card').first()).toBeVisible({ timeout: 3_000 });
    // 기다리는 동안 무엇을 하는지 말한다 — 가짜 진행 막대가 아니라 실제 단계다.
    const progress = page.locator('.recall-progress');
    await expect(progress.getByText('최신 기록 확인 중')).toBeVisible();
    await expect(progress.getByText(/이 기기에 있는 기록 \d+건을 대조하고 있어요/)).toBeVisible();
    await expect(progress.getByText(/경과/)).toBeVisible();
    await expect(progress.getByRole('button', { name: '중단' })).toBeVisible();

    release();
    await expect(progress).toHaveCount(0);
    // 얼마나 걸렸는지는 실측값으로 말한다 (지어낸 남은 시간이 아니다).
    await expect(page.locator('.recall-count small')).toHaveText(/기록 \d+건 대조 · [\d.]+초/);
  } finally {
    harness.server.close();
  }
});

// 004: 여러 명이 나오는 질의에서 한 명으로 수렴하지 않는다.
test('a company-wide memory returns every candidate, grouped and narrowable', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '검색', exact: true }).click();
    await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
    await page.getByRole('textbox').fill('한화 다니는 사람');
    await page.getByRole('button', { name: '찾기' }).click();

    // 한화 사람 3명이 모두 후보로 남는다.
    await expect(page.locator('.recall-count strong')).toHaveText('후보 3명');
    await expect(page.locator('.recall-card')).toHaveCount(3);
    // 무엇으로 좁혔는지 chip으로 되돌려 말한다.
    await expect(page.locator('.recall-clues span').first()).toHaveText('한화');
    // 문장은 여전히 기기 밖으로 나가지 않는다.
    await expect(page.getByText('문장은 이 기기 안에서만 대조해요. 밖으로 보내지 않습니다.')).toBeVisible();
    expect(harness.requests.some((entry) => entry.includes(encodeURIComponent('한화 다니는 사람')))).toBe(false);

    // 좁히기 chip을 누르면 그 소속만 남고, 다시 누르면 전체로 돌아온다.
    await page.getByRole('group', { name: '후보 좁히기' }).getByRole('button', { name: /한화시스템 2/ }).click();
    await expect(page.locator('.recall-card')).toHaveCount(2);
    await page.getByRole('group', { name: '후보 좁히기' }).getByRole('button', { name: /전체 3/ }).click();
    await expect(page.locator('.recall-card')).toHaveCount(3);
  } finally {
    harness.server.close();
  }
});
