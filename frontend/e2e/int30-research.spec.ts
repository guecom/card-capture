// INT-000030 회귀 게이트 — `AI 조사 요청`의 **위계**와 **깊이** (TSK-000542 / DEC-000105).
//
// founder 판정 2026-08-04:
//   "제안하는 것들의 블록들이 일단 크기가 너무 커. … 모두 선택을 주로 제일 많이 누르니까 그게
//    이제 내가 글로 직접 적는 부분 바로 아래에 나왔으면 해. 그것도 엄청 누르고 싶게."
//   "빠른 조사, 일반 조사, 깊은 조사를 선택하는 옵션 버튼이 있었으면 좋겠어. … 실질적으로 유저는
//    어떤 모델이 연결되는지 사실에 대해서 몰랐으면 좋겠어."
//
// 이 게이트가 형식적이지 않다는 것은 **변경 전 번들에서 확인했다**: 순서·전폭 CTA·깊이 라디오·
// 요청에 실리는 깊이가 모두 없어 전부 FAIL한다 (예전 화면은 `제목·개수·모두 선택` 한 줄 뒤에
// 두 줄짜리 큰 블록 아홉 개가 오고, 자유 입력이 그 아래였다).
//
// 이름 유출 검사(`model 이름이 0건`)는 성질상 변경 전에도 통과한다. 그래서 그 검사만은
// **스스로 함정을 놓고** 판정한다 — 오염된 문자열을 잠깐 페이지에 넣어 검사가 실제로 잡는지
// 확인한 뒤에 0건을 주장한다. 통과만 하는 검사는 검사가 아니다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const DAY_MINUTES = 24 * 60;
const RESEARCH_RECEIPT_ID = 'research-int30-0001';
const SCOPE_COUNT = 9;

/** 사용자에게 절대 나타나면 안 되는 말. 내부 식별자 + 흔한 공급자·모델 이름. */
const FORBIDDEN_LATIN = [
  'luna', 'terra', 'sol', 'nova',
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'opus', 'sonnet', 'haiku', 'anthropic', 'openai',
];
const FORBIDDEN_KOREAN = ['모델', '엔진', '공급자'];
/** 접근성 이름·설명이 실리는 자리. 눈에 보이는 글자만 훑으면 절반만 보는 것이다. */
const TEXTUAL_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt'];

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

function stopServer(server: Server): Promise<void> {
  return new Promise((stop) => { server.close(() => stop()); server.closeAllConnections(); });
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

function person(index: number, name: string, organization: string) {
  return {
    captureId: `2026080${index}-090000-p${index}`,
    receivedAt: ago(index * DAY_MINUTES),
    status: 'processed',
    person: `PER-00000${index}`,
    capturer: '이강규',
    event: '고객사 방문 미팅',
    contact: { name, title: '구매팀장', organization },
    brief: `# ${name} — 이런 분이에요\n${organization} 구매팀장입니다.`,
  };
}

interface Harness {
  server: Server;
  /** 서버로 실제로 나간 조사 요청의 본문 */
  submitted: Array<Record<string, unknown>>;
}

async function boot(
  page: Page,
  options: { theme?: string; width?: number; height?: number; deepOpen?: boolean } = {},
): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  const submitted: Array<Record<string, unknown>> = [];
  /* 계약 §Product Behavior: 깊은 조사는 서버가 `DEEP_RESEARCH_ENABLED=true`라고 말한 경우에만
     열린다. 기본 harness는 열린 서버다 — 닫힌 서버는 그 경우를 보는 검사가 직접 끈다. */
  const deepOpen = options.deepOpen !== false;

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') {
      const items = [person(1, '김민서', '한화시스템'), person(2, '이서연', '넥스트로보')];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, deepResearchEnabled: deepOpen, hasMore: false, items }) });
      return;
    }
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      if (body.action === 'researchinstruction') {
        submitted.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: RESEARCH_RECEIPT_ID, person: 'PER-000001', status: 'received' }) });
        return;
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  const theme = options.theme;
  await page.addInitScript((value) => {
    localStorage.setItem('cc_name', '이강규');
    if (value) localStorage.setItem('cc_theme', value);
  }, theme);
  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, submitted };
}

function composer(page: Page) {
  return page.locator('.ai-surface.research-request');
}

function depthOption(scope: ReturnType<typeof composer>, depth: string) {
  return scope.locator(`.research-depth-option[data-depth="${depth}"]`);
}

function depthInput(scope: ReturnType<typeof composer>, depth: string) {
  return scope.locator(`.research-depth-option[data-depth="${depth}"] input`);
}

async function openPersonSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '진행', exact: true }).click();
  await page.locator('.brief-summary').filter({ hasText: '김민서' }).click();
  await page.locator('.brief-detail').getByRole('button', { name: 'AI 조사 요청' }).click();
  await expect(page.locator('ion-modal.person-action-modal .ai-surface.research-request')).toBeVisible();
}

// ── A. 위계: 가장 자주 누르는 것이 가장 눈에 띈다 ──

test('작성 자리 순서는 자유 입력 → 모두 선택 → 낱개 범위 → 선택 수다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const order = await composer(page).evaluate((root) => {
      const nodes = [
        root.querySelector('ion-textarea'),
        root.querySelector('.research-scope-all'),
        root.querySelector('.research-scope-grid'),
        root.querySelector('.research-scope-count'),
      ];
      const missing = ['ion-textarea', '.research-scope-all', '.research-scope-grid', '.research-scope-count']
        .filter((_, index) => !nodes[index]);
      if (missing.length) return { missing, positions: [] as number[] };
      const all = [...root.querySelectorAll('*')];
      return { missing, positions: nodes.map((node) => all.indexOf(node as Element)) };
    });
    expect(order.missing, `작성 자리에 없는 조각: ${order.missing.join(', ')}`).toEqual([]);
    expect(order.positions, '순서가 자유 입력 → 모두 선택 → 낱개 → 선택 수가 아니다')
      .toEqual([...order.positions].sort((a, b) => a - b));
  } finally {
    await stopServer(harness.server);
  }
});

test('모두 선택은 폭을 다 쓰는 하나의 조작이다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const measured = await composer(page).evaluate((root) => {
      const button = root.querySelector<HTMLElement>('.research-scope-all');
      const box = root.querySelector<HTMLElement>('.research-scopes');
      if (!button || !box) return null;
      return {
        ratio: button.getBoundingClientRect().width / box.getBoundingClientRect().width,
        height: button.getBoundingClientRect().height,
      };
    });
    expect(measured, '모두 선택 버튼이나 그 자리가 없다').not.toBeNull();
    expect(measured!.ratio, '모두 선택이 폭을 다 쓰지 않는다').toBeGreaterThan(0.97);
    // 가장 자주 누르는 것이 가장 큰 조작이어야 한다. 낱개 chip보다 확실히 높다.
    expect(measured!.height, '모두 선택이 낱개 chip과 비슷한 크기다').toBeGreaterThanOrEqual(48);
  } finally {
    await stopServer(harness.server);
  }
});

test('낱개 조사 범위는 한 줄짜리로 작아졌다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const chips = composer(page).locator('.research-scope-chip');
    await expect(chips).toHaveCount(SCOPE_COUNT);
    const heights = await chips.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    // 예전 두 줄짜리 블록은 44px 이상이었다. 한 줄이면 그보다 낮다.
    expect(Math.max(...heights), `낱개 칸이 아직 크다: ${heights.join(', ')}`).toBeLessThan(44);
    // 작아져도 무엇을 묻는 항목인지는 읽어 주는 말에 남아 있어야 한다.
    const name = await chips.first().evaluate((node) => (node.textContent ?? '').trim());
    expect(name).toContain('실력·역량 근거');
    expect(name, '설명이 통째로 사라졌다 — 접근성 이름에도 없다').toContain('공개된 결과물로');
  } finally {
    await stopServer(harness.server);
  }
});

test('전부 고르면 모두 해제로 뒤집히고 고장처럼 보이지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const cta = composer(page).locator('.research-scope-all');
    await expect(cta).toHaveAttribute('aria-pressed', 'false');
    await expect(cta).toContainText('모두 선택');
    await expect(cta).toContainText(`${SCOPE_COUNT}가지`);

    await cta.click();
    await expect(cta).toHaveAttribute('aria-pressed', 'true');
    await expect(cta).toContainText('모두 해제');
    // 다 골라진 상태에서도 자기 상태를 말한다 — 빈 껍데기로 남지 않는다.
    await expect(cta).toContainText('전부 켜짐');
    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);
  } finally {
    await stopServer(harness.server);
  }
});

test('모두 선택은 조사 범위만 바꾼다 — 만남 맥락과 추천은 손대지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 만남 맥락을 채우고 추천 하나를 눌러 둔다.
    await page.getByRole('textbox', { name: '어디서 만났나요?' }).fill('2026 스마트팩토리전 부스');
    await page.getByRole('textbox', { name: '나와의 관계' }).fill('대학 선배');
    const suggestion = page.getByRole('group', { name: 'Kairen과의 관계 예시' }).getByRole('button').first();
    const suggestionLabel = (await suggestion.innerText()).trim();
    await suggestion.click();
    await expect(page.getByRole('textbox', { name: 'Kairen과의 관계' })).toHaveValue(suggestionLabel);

    await composer(page).locator('.research-scope-all').click();
    await expect(composer(page).locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);

    // 조사 범위를 한 번에 켜는 조작이 만남 맥락을 건드리면 안 된다 (DEC-000105 non-goal).
    await expect(page.getByRole('textbox', { name: '어디서 만났나요?' })).toHaveValue('2026 스마트팩토리전 부스');
    await expect(page.getByRole('textbox', { name: '나와의 관계' })).toHaveValue('대학 선배');
    await expect(page.getByRole('textbox', { name: 'Kairen과의 관계' })).toHaveValue(suggestionLabel);
    await expect(suggestion).toHaveClass(/on/);
  } finally {
    await stopServer(harness.server);
  }
});

// ── B. 깊이: 결과와 기다림만 말한다 ──

test('깊이는 세 갈래이고 새 요청은 일반 조사에서 시작한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const group = composer(page).getByRole('radiogroup');
    await expect(group).toBeVisible();
    await expect(group.getByRole('radio')).toHaveCount(3);
    for (const label of ['빠른 조사', '일반 조사', '깊은 조사']) {
      await expect(group.getByRole('radio', { name: label })).toHaveCount(1);
    }
    await expect(depthInput(composer(page), 'standard')).toBeChecked();
    await expect(depthInput(composer(page), 'quick')).not.toBeChecked();
    await expect(depthInput(composer(page), 'deep')).not.toBeChecked();
  } finally {
    await stopServer(harness.server);
  }
});

test('깊이를 바꾸면 무엇이 달라지는지 한 줄로 말한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const summary = composer(page).locator('.research-depth-summary');
    await expect(summary).toContainText('일반 조사');

    await depthOption(composer(page), 'deep').click();
    await expect(depthInput(composer(page), 'deep')).toBeChecked();
    await expect(summary).toContainText('깊은 조사');
    // 기다림이 어떻게 달라지는지 예측 가능해야 한다.
    await expect(summary).toContainText('기다리는 시간');

    await depthOption(composer(page), 'quick').click();
    await expect(summary).toContainText('빠른 조사');
    // 깊이가 조사 **범위**를 바꾸는 것처럼 읽히면 안 된다.
    await expect(summary).toContainText('고른 범위');
  } finally {
    await stopServer(harness.server);
  }
});

test('고른 깊이가 서버가 읽는 mode로 실려 나간다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await depthOption(sheet.locator('.ai-surface.research-request'), 'deep').click();
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();

    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    // **화면 상태가 아니라 나가는 값**을 본다. 예전 결함은 화면에는 다 있었고 요청에만 없었다.
    const envelope = harness.submitted[0].instruction as Record<string, unknown> | undefined;
    expect(envelope, '요청에 구조화된 봉투가 없다').toBeTruthy();
    expect(envelope!.mode, '깊은 조사가 서버 mode로 옮겨지지 않았다').toBe('deep_evidence_graph');
    // 계약: 깊은 조사는 목적 1개 이상. 화면의 `범위 1개 이상`이 실제로 그 조건을 만족시켜야 한다.
    expect((envelope!.purposes as string[]).length, '깊은 조사에 목적이 실리지 않았다').toBeGreaterThanOrEqual(1);
    // 아홉 개를 다 골랐으면 서버 여덟 자리가 모두 채워진다.
    expect(envelope!.focusIds).toEqual(['expertise', 'authority', 'reputation', 'outcomes', 'interests', 'career', 'company', 'connection']);
    expect(String(envelope!.requestId), '재시도 멱등 키가 없다').toMatch(/^[A-Za-z0-9-]{8,64}$/);
    // 제 칸이 있는 항목 이름은 자유 입력에 다시 쓰지 않는다 (계약: 선택 항목과 별도 저장).
    expect(String(envelope!.raw).startsWith('조사 항목: '), '예전 합쳐 보내던 형식이 남아 있다').toBe(false);
    expect(String(envelope!.raw)).not.toContain('의사결정 권한·직급');
    expect(String(envelope!.raw)).not.toContain('실력·역량 근거');

    // 어디로 보내는지는 클라이언트가 정하지도, 보내지도 않는다.
    const wire = JSON.stringify(harness.submitted[0]).toLowerCase();
    for (const needle of FORBIDDEN_LATIN) {
      expect(new RegExp(`\\b${needle}\\b`).test(wire), `요청 본문에 내부 이름이 있다: ${needle}`).toBe(false);
    }
  } finally {
    await stopServer(harness.server);
  }
});

test('세 깊이가 서버에서 서로 다른 요청이 된다', async ({ page }) => {
  const harness = await boot(page);
  try {
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      // 접수되면 앱이 진행 블록으로 손을 넘긴다. 매번 같은 자리에서 시작하도록 처음부터 다시 연다.
      if (depth !== 'quick') await page.reload({ waitUntil: 'networkidle' });
      await openPersonSheet(page);
      const sheet = page.locator('ion-modal.person-action-modal');
      await sheet.locator('ion-textarea[aria-label="AI 조사 요청"] textarea').fill('공개 경력을 확인해 주세요');
      await depthOption(sheet.locator('.ai-surface.research-request'), depth).click();
      await sheet.getByRole('button', { name: '모두 선택' }).click();
      await sheet.getByRole('button', { name: '조사 요청 접수' }).click();
      await expect(sheet).toBeHidden({ timeout: 10_000 });
    }
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(3);
    const modes = harness.submitted.map((body) => (body.instruction as Record<string, unknown>).mode);
    // 예전에는 셋 다 서버에서 같은 요청이었다 — 화면만 달랐다.
    expect(modes, `세 깊이가 같은 요청이 됐다: ${JSON.stringify(modes)}`).toEqual(['quick', 'standard', 'deep_evidence_graph']);
    // 요청마다 자기 멱등 키를 갖는다 — 서로 다른 요청이 같은 이름으로 접수되면 안 된다.
    const ids = harness.submitted.map((body) => String((body.instruction as Record<string, unknown>).requestId));
    expect(new Set(ids).size, `서로 다른 요청이 같은 멱등 키를 썼다: ${ids.join(', ')}`).toBe(3);
  } finally {
    await stopServer(harness.server);
  }
});

// ── 깊이 선택은 언제나 즉시다 (TSK-000560 / INT-000036) ─────────────────────
//
// founder 판정 2026-08-04:
//   "빠른조사, 일반조사는 그냥 선택할 수 있는데, 깊은 조사는 왜 버튼 클릭할 수 있을 때 까지
//    시간이 지나야하는지 모르겠네?"
//   "깊은 조사 활성화는 조건이 아니라 그냥 선택할 수 있게 해줘."
//
// **원인은 timer도 debounce도 아니었다.** 깊은 조사 칸의 `disabled`는 목록 응답 한 칸
// (`deepResearchEnabled`)에서 왔고, 그 값은 IndexedDB 두 번 + 여러 페이지 목록 조회가 끝난 뒤에야
// 채워졌다. 즉 "시간이 지나면 켜진다"는 것은 **갱신 한 바퀴**였다. 빠른·일반은 애초에 그 값을
// 보지 않아서 처음부터 눌렸고, 그래서 깊은 조사 하나만 늦게 열리는 것처럼 보였다.
//
// 그래서 아래 검사들은 **응답을 주지 않은 채로** 판정한다. 가짜 시계를 돌리지도, 목록이
// 도착하기를 기다리지도 않는다 — 그 구간이 결함이 살던 자리다.

/** 세 라디오가 DOM에 **처음 나타난 순간**의 상태를 붙잡는다. 나중에 고쳐진 것으로 속지 않는다. */
async function watchDepthFirstPaint(page: Page): Promise<void> {
  await page.addInitScript(() => {
    /* `unavailable`과 `intake`를 **둘 다** 붙잡는다. 앞의 것은 이 칸이 꺼져 있던 시절의 표식이고
       (지금은 어느 상태에서도 다시 나타나면 안 된다), 뒤의 것은 접수가 닫혔다는 지금의 표식이다.
       한쪽만 재면 이름만 바꾸고 뜻은 그대로 둔 회귀를 못 잡는다. */
    interface FirstPaintRow { depth: string; disabled: boolean; unavailable: string | null; intake: string | null }
    (window as unknown as { __depthFirstPaint?: FirstPaintRow[] | null }).__depthFirstPaint = null;
    const holder = window as unknown as { __depthFirstPaint?: FirstPaintRow[] | null };
    // 프레임마다 들여다본다. `MutationObserver`는 init script 시점에 `documentElement`가 아직
    // 없을 수 있어 관측 자체가 시작되지 않는다 — 그러면 검사가 조용히 아무것도 못 본다.
    const capture = () => {
      if (holder.__depthFirstPaint) return;
      const inputs = [...document.querySelectorAll<HTMLInputElement>('.research-depth-option input')];
      if (inputs.length === 3) {
        holder.__depthFirstPaint = inputs.map((node) => ({
          depth: String(node.value),
          disabled: node.disabled,
          unavailable: node.closest('.research-depth-option')?.getAttribute('data-unavailable') ?? null,
          intake: node.closest('.research-depth-option')?.getAttribute('data-intake') ?? null,
        }));
        return;
      }
      window.requestAnimationFrame(capture);
    };
    window.requestAnimationFrame(capture);
  });
}

function readDepthFirstPaint(page: Page) {
  return page.evaluate(() => (window as unknown as { __depthFirstPaint?: unknown }).__depthFirstPaint);
}

test('서버가 아직 대답하지 않은 첫 프레임에서 세 깊이가 모두 고를 수 있다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 한 번 다녀왔으니 작성 자리는 첫 프레임부터 그려진다. 이제 목록 응답만 **붙잡아 둔다** —
    // 사용자가 앱을 다시 열었을 때 실제로 보게 되는 구간이다.
    const held: Array<() => void> = [];
    let listRequests = 0;
    await page.route('https://api.example.test/**', async (route) => {
      if (new URL(route.request().url()).searchParams.get('action') !== 'list') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
        return;
      }
      listRequests += 1;
      await new Promise<void>((resume) => held.push(resume));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, deepResearchEnabled: true, hasMore: false, items: [] }) });
    });
    await watchDepthFirstPaint(page);
    await page.reload({ waitUntil: 'commit' });

    const scope = composer(page);
    await expect(scope).toBeVisible();

    // 1. 처음 그려진 그 프레임에서 이미 셋 다 열려 있다.
    const painted = await readDepthFirstPaint(page);
    expect(painted, '세 깊이가 함께 나타난 프레임을 못 잡았다').not.toBeNull();
    expect(painted, `첫 render에서 고를 수 없는 깊이가 있다: ${JSON.stringify(painted)}`).toEqual([
      { depth: 'quick', disabled: false, unavailable: null, intake: null },
      { depth: 'standard', disabled: false, unavailable: null, intake: null },
      { depth: 'deep', disabled: false, unavailable: null, intake: null },
    ]);

    // 2. 그동안 목록 응답은 **아직 도착하지 않았다**. 이 사실이 없으면 위 판정은 아무것도 증명하지 못한다.
    //    요청이 떴는지를 한 번만 읽으면 안 된다 — 앱이 composer를 먼저 그리고 요청을 나중에
    //    보내는 순서라, 느린 기계에서는 이 줄에 닿는 순간 아직 0이다(CI에서 실제로 걸렸다).
    //    응답은 route handler가 붙잡고 있으니 기다려도 도착하지 않는다. 끝내 안 뜨면 이
    //    기다림이 timeout으로 걸리므로 판정은 약해지지 않는다.
    await expect
      .poll(() => listRequests, { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect(held.length, '목록 응답이 이미 도착했다 — 결함이 살던 구간을 못 봤다').toBeGreaterThan(0);

    // 3. 실제로 고를 수 있고, 고른 것이 남는다.
    await depthOption(scope, 'deep').click();
    await expect(depthInput(scope, 'deep')).toBeChecked();

    // 4. 못 들은 동안에는 아무 경고도 만들지 않는다 — 닫혔다는 말도, 기다리라는 말도 없다.
    await expect(scope.locator('.research-depth')).toHaveAttribute('data-deep-state', 'unknown');
    await expect(depthOption(scope, 'deep'), '못 들었을 뿐인데 닫혔다고 말한다').not.toContainText('접수 안 돼요');
    await expect(scope.locator('.research-depth-summary')).toContainText('근거까지 넓게 대조');
    // 처리 대기를 말하는 문장(`기다리는 시간이 가장 깁니다`)은 정당하다 — 여기서 잡는 것은
    // **상태를 지연처럼 말하는** 낱말이다.
    for (const word of ['잠시', '확인 중', '연결 중', '준비 중', '나중에', '불러오']) {
      expect((await scope.locator('.research-depth').innerText()).includes(word), `못 들은 상태를 지연처럼 말한다: ${word}`).toBe(false);
    }
    held.forEach((resume) => resume());
  } finally {
    await stopServer(harness.server);
  }
});

test('연결되지 않은 기기에서도 깊이를 고르고 요청을 준비할 수 있다', async ({ page }) => {
  // 개인 링크 없이 연 화면. 서버에 물어볼 길이 아예 없으므로 영원히 `unknown`이다 —
  // 그 상태가 선택을 막으면 오프라인에서는 깊은 조사가 존재하지 않는 기능이 된다.
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  let apiCalls = 0;
  try {
    await page.context().route('**/vendor/**', (route) => route.abort());
    await page.route('https://api.example.test/**', async (route) => { apiCalls += 1; await route.abort(); });
    // 기기 이름은 연결과 무관한 값이다. 채워 두지 않으면 이름 온보딩 시트가 화면을 덮는다.
    await page.addInitScript(() => localStorage.setItem('cc_name', '이강규'));
    await page.setViewportSize({ width: 390, height: 844 });
    await watchDepthFirstPaint(page);
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'commit' });

    const scope = composer(page);
    await expect(scope).toBeVisible();
    expect(await readDepthFirstPaint(page)).toEqual([
      { depth: 'quick', disabled: false, unavailable: null, intake: null },
      { depth: 'standard', disabled: false, unavailable: null, intake: null },
      { depth: 'deep', disabled: false, unavailable: null, intake: null },
    ]);

    // 고르고, 범위를 켜고, 글을 적는 데까지 서버가 필요하지 않다.
    await depthOption(scope, 'deep').click();
    await scope.locator('.research-scope-all').click();
    await scope.locator('ion-textarea textarea').fill('공개 경력을 확인해 주세요');
    await expect(depthInput(scope, 'deep')).toBeChecked();
    await expect(scope.locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 ${SCOPE_COUNT}개 선택`);
    await expect(scope.locator('.research-block')).toHaveCount(0);
    expect(apiCalls, '연결도 없는데 서버를 불렀다').toBe(0);
  } finally {
    await stopServer(server);
  }
});

// ── 닫힘은 사실이지 지연이 아니다 ─────────────────────────────────────────────
//
// 계약 (INT-000036 승인안): "rollback flag가 deep Product surface 전체를 닫는 경우를
// per-request 지연 조건으로 가장하지 않는다." 그리고 `DEEP_RESEARCH_ENABLED` 경계는 그대로
// fail-closed다 — 막히는 자리가 **선택이 아니라 접수**로 옮겨졌을 뿐이다.

test('서버가 닫혔다고 말해도 깊은 조사는 고를 수 있고, 막히는 것은 제출이다', async ({ page }) => {
  const harness = await boot(page, { deepOpen: false });
  try {
    const scope = composer(page);
    // 사라지지 않는다 — 없어진 선택지는 고장으로 읽힌다.
    await expect(depthOption(scope, 'deep')).toHaveCount(1);
    // 그리고 **꺼져 있지도 않다**. 고르는 것은 사람의 손이고 조건이 붙지 않는다.
    await expect(depthInput(scope, 'deep')).toBeEnabled();
    await expect(depthInput(scope, 'quick')).toBeEnabled();
    await expect(depthInput(scope, 'standard')).toBeEnabled();
    await expect(scope.locator('.research-depth')).toHaveAttribute('data-deep-state', 'closed');

    /* DOM이 화면과 **같은 말**을 하는가 (INT-000036 통합 검수).
       이 칸은 `data-unavailable="yes"`를 들고 있었다 — 이 저장소에서 그 이름은 "이 조작을 쓸 수
       없다"는 뜻이고(`CaptureEntry`의 카메라 없는 카드가 그 이름을 쓴다), 이 칸이 실제로 꺼져
       있던 시절의 표식이다. 사람에게는 "고를 수 있다"고 하면서 기계에게는 "쓸 수 없다"고 하는
       상태였고, 독립 게이트가 `enabled=true` 인데 `why=data-unavailable`로 그것을 잡아냈다.
       이제 표식이 말하는 것은 **접수**가 닫혔다는 사실이다 — 막힌 자리가 선택이 아니라 접수라는
       것이 이름에도 그대로 있다. */
    await expect(depthOption(scope, 'deep')).toHaveAttribute('data-intake', 'closed');
    for (const depth of ['quick', 'standard', 'deep'] as const) {
      expect(
        await depthOption(scope, depth).getAttribute('data-unavailable'),
        `\`${depth}\` 칸이 고를 수 있는데도 "쓸 수 없다"고 표시돼 있다`,
      ).toBeNull();
      await expect(depthOption(scope, depth)).not.toHaveAttribute('aria-disabled', 'true');
    }
    // 닫히지 않은 두 칸에는 접수 표식도 없다.
    for (const depth of ['quick', 'standard'] as const) {
      expect(await depthOption(scope, depth).getAttribute('data-intake')).toBeNull();
    }

    // 고르지 않은 동안에도 지금의 사실이 **글자로** 서 있다 — 색으로만 말하지 않는다.
    // 그리고 "못 골라요"가 아니다: 고르는 것은 되고, 안 되는 것은 접수다.
    await expect(depthOption(scope, 'deep')).toContainText('지금은 접수 안 돼요');
    expect(await depthOption(scope, 'deep').innerText(), '고를 수 없다고 적어 놓고 고르게 해 둔다').not.toContain('못 골라');
    // 뜻과 회복 방법은 그 칸이 스스로 나른다 — 새 블록을 세우지 않고(높이는 공용 예산이다)
    // 호버 문구와 낭독기 문장으로 간다.
    const closedDetail = await depthOption(scope, 'deep').getAttribute('title');
    expect(closedDetail, '닫힌 칸이 뜻을 말하지 않는다').toContain('접수하지 않아요');
    expect(closedDetail, '무엇을 하면 되는지 말하지 않는다').toContain('일반 조사');
    expect(await depthOption(scope, 'deep').locator('.research-sr-only').innerText()).toContain('일반 조사');
    // 진행이 아니다. 회전하는 것도, 세는 것도, 새로 생긴 live region도 없다.
    await expect(scope.locator('.research-depth [aria-busy="true"], .research-depth ion-spinner, .research-depth progress')).toHaveCount(0);

    // 실제로 고를 수 있고, 고른 것이 남는다.
    await depthOption(scope, 'deep').click();
    await expect(depthInput(scope, 'deep')).toBeChecked();
    // 고른 순간 접수 조건 안내가 이유와 회복 방법을 눈에 보이게 말한다.
    await expect(scope.locator('.research-block')).toBeVisible();
    await expect(scope.locator('.research-block')).toContainText('지금 접수하지 않아요');
    await expect(scope.locator('.research-block')).toContainText('일반 조사');

    // 그리고 막힌다. 서버 설정 이름·오류 코드는 화면 어디에도 없다.
    await scope.locator('ion-textarea textarea').fill('의사결정 권한을 확인해 주세요');
    await scope.locator('.research-scope-all').click();
    await expect(page.locator('ion-button.primary-action')).toHaveAttribute('data-blocked', 'research');
    const text = (await scope.innerText()).toLowerCase();
    for (const leak of ['deep_research', 'deep_feature_disabled', 'bad_research_request', 'script', 'enabled']) {
      expect(text.includes(leak), `화면에 내부 이름이 있다: ${leak}`).toBe(false);
    }
    // 닫힘을 기다림으로 말하지 않는다.
    for (const word of ['잠시', '확인 중', '연결 중', '준비 중', '나중에', '곧']) {
      expect((await scope.locator('.research-depth').innerText()).includes(word), `닫힘을 지연처럼 말한다: ${word}`).toBe(false);
    }
  } finally {
    await stopServer(harness.server);
  }
});

// ── 막혔을 때 손이 가는 곳은 이유마다 다르다 (INT-000036 / TSK-000562) ──────────
//
// 승인된 acceptance: 「깊은 조사 목적 1개 이상은 mode 선택이 아니라 제출 validation이 검사하고,
// 실패 시 **목적 영역으로 focus**와 inline 안내를 제공한다.」
//
// 예전에는 두 막힘 모두 안내 **문단**으로 손이 갔다. 문단은 읽히지만 다음 키 입력으로 할 수 있는
// 것이 없다 — 막다른 곳이다. 그리고 두 막힘을 한 곳으로 몰면 그중 하나는 반드시 거짓말이 된다:
// 서버가 닫아 둔 상태에서 범위 영역으로 데려가면, 사용자는 범위를 다 골라 놓고 여전히 못 보낸다.
//
// 그래서 **풀 수 있는 자리**로 나눠 보낸다. 아래는 그중 닫힘 쪽이다 (범위 쪽은
// `int36-surfaces.spec.ts`가 독립적으로 잰다).

/** 지금 포커스가 어디에 있는가. shadow DOM을 뚫고 가장 안쪽 활성 요소를 찾는다. */
async function focusedTrail(page: Page): Promise<{ tag: string; value: string; inDepth: boolean; inScopes: boolean; describedBy: string }> {
  return page.evaluate(() => {
    let active: Element | null = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    return {
      tag: active ? active.tagName.toLowerCase() : '(없음)',
      value: active?.getAttribute('value') ?? '',
      inDepth: Boolean(active?.closest('.research-depth')),
      inScopes: Boolean(active?.closest('.research-scopes')),
      describedBy: active?.getAttribute('aria-describedby') ?? '',
    };
  });
}

test('서버가 닫아 둔 막힘에서는 손이 범위가 아니라 깊이로 간다', async ({ page }) => {
  const harness = await boot(page, { deepOpen: false });
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    const scope = sheet.locator('.ai-surface.research-request');
    // 올라오는 시트 위의 요소는 `not stable`이라 클릭을 못 받는다. 전환이 끝난 뒤에 손을 댄다.
    await page.waitForTimeout(700);
    await depthOption(scope, 'deep').click();
    await scope.locator('ion-textarea textarea').fill('의사결정 권한을 확인해 주세요');
    // 범위를 **다 골라 놓아도** 닫힘은 풀리지 않는다. 그래서 범위 영역은 갈 곳이 아니다.
    await scope.locator('.research-scope-all').click();

    const submit = sheet.locator('.person-action-submit ion-button');
    await expect(submit).toHaveAttribute('data-blocked', 'research');
    await submit.click();
    await page.waitForTimeout(300);

    const focused = await focusedTrail(page);
    expect(focused.inDepth, `닫힘으로 막혔는데 손이 깊이 자리로 가지 않았다: ${JSON.stringify(focused)}`).toBe(true);
    expect(focused.inScopes, '범위를 골라도 풀리지 않는 막힘인데 손이 범위 영역으로 갔다').toBe(false);
    // 그 자리에서 화살표로 다른 깊이를 고를 수 있어야 실제로 풀 수 있는 자리다.
    expect(focused.tag, `포커스가 라디오가 아니다: ${JSON.stringify(focused)}`).toBe('input');
    expect(focused.value).toBe('deep');
    // 이유는 함께 읽힌다 — 손만 옮기고 왜 막혔는지 말하지 않으면 안내가 아니다.
    const blockId = await scope.locator('.research-block').getAttribute('id');
    expect(blockId).toBeTruthy();
    expect(focused.describedBy.split(/\s+/), '포커스가 닿은 자리가 막힘 이유와 이어져 있지 않다')
      .toContain(blockId!);
    await expect(scope.locator('.research-block')).toBeVisible();

    await page.keyboard.press('ArrowLeft');
    await expect(depthInput(scope, 'standard'), '깊이 자리에 섰는데 화살표로 다른 깊이를 못 고른다').toBeChecked();
    await expect(submit).toHaveAttribute('data-blocked', 'no');
  } finally {
    await stopServer(harness.server);
  }
});

test('서버가 응답에서 아예 말하지 않아도 닫힘이다 — 대답한 것과 못 들은 것은 다르다', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  try {
    await page.context().route('**/vendor/**', (route) => route.abort());
    // 옛 서버 흉내: `deepResearchEnabled` 칸 자체가 없다. **대답은 했다** — 그러므로 닫힘이다.
    await page.route('https://api.example.test/**', async (route) => {
      const action = new URL(route.request().url()).searchParams.get('action');
      const items = action === 'list' ? [person(1, '김민서', '한화시스템')] : [];
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items }),
      });
    });
    await page.addInitScript(() => localStorage.setItem('cc_name', '이강규'));
    await page.setViewportSize({ width: 390, height: 844 });
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });

    const scope = composer(page);
    await expect(scope.locator('.research-depth')).toHaveAttribute('data-deep-state', 'closed');
    // 고르는 것은 여전히 된다. 닫힌 것은 접수다.
    await expect(depthInput(scope, 'deep')).toBeEnabled();
    await expect(depthInput(scope, 'standard')).toBeEnabled();
    await depthOption(scope, 'deep').click();
    await expect(depthInput(scope, 'deep')).toBeChecked();
    await expect(scope.locator('.research-block')).toBeVisible();
    // 작성 자리 자체는 살아 있다 — 깊은 조사 하나가 닫혔다고 조사 기능이 사라지지 않는다.
    await depthOption(scope, 'standard').click();
    await expect(scope.locator('.research-block')).toHaveCount(0);
  } finally {
    await stopServer(server);
  }
});

test('닫혀 있는데 이미 깊은 조사를 고른 상태면 몰래 낮추지 않고 막는다', async ({ page }) => {
  // 열린 서버에서 깊은 조사를 고른 뒤, 같은 화면에서 서버가 닫아 버린 경우.
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const submitted: Array<Record<string, unknown>> = [];
  let deepOpen = true;
  try {
    await page.context().route('**/vendor/**', (route) => route.abort());
    await page.route('https://api.example.test/**', async (route) => {
      const request = route.request();
      const action = new URL(request.url()).searchParams.get('action');
      if (action === 'list') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, deepResearchEnabled: deepOpen, hasMore: false, items: [person(1, '김민서', '한화시스템')] }),
        });
        return;
      }
      if (request.method() === 'POST') {
        const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
        submitted.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, receiptId: RESEARCH_RECEIPT_ID }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
    });
    await page.addInitScript(() => localStorage.setItem('cc_name', '이강규'));
    await page.setViewportSize({ width: 390, height: 844 });
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });

    const scope = composer(page);
    await scope.locator('ion-textarea textarea').fill('의사결정 권한을 확인해 주세요');
    await scope.locator('.research-scope-all').click();
    await depthOption(scope, 'deep').click();
    await expect(depthInput(scope, 'deep')).toBeChecked();

    // 서버가 닫는다. 다음 목록 갱신이 그 사실을 가져온다.
    deepOpen = false;
    await page.locator('.int30-refresh-now').click();
    await expect(scope.locator('.research-depth')).toHaveAttribute('data-deep-state', 'closed', { timeout: 10_000 });

    // 고른 것은 고른 채로 남는다 — 대신 다른 깊이로 바꿔치기하지 않는다. 그리고 여전히 고를 수 있다.
    await expect(depthInput(scope, 'deep'), '고른 깊이를 몰래 다른 것으로 바꿨다').toBeChecked();
    await expect(depthInput(scope, 'deep'), '닫혔다고 선택까지 잠갔다').toBeEnabled();
    await expect(scope.locator('.research-block')).toBeVisible();
    await expect(page.locator('ion-button.primary-action')).toHaveAttribute('data-blocked', 'research');
    // 하게 될 일을 설명하지 않는다 — 하지 않을 일을 설명하는 문장은 거짓말이다.
    await expect(scope.locator('.research-depth-summary')).toContainText('지금 접수하지 않아요');

    // 그동안 어떤 조사 요청도 나가지 않았다. (막힌 버튼을 눌렀을 때의 동작 자체는
    // `int30-conformance.spec.ts`가, 마지막 방어선은 `services/research.test.ts`가 잠근다.)
    await page.waitForTimeout(400);
    expect(submitted.filter((body) => body.action === 'researchinstruction' || body.researchInstruction),
      '막힌 요청이 서버로 나갔다').toHaveLength(0);

    // 막힘을 푸는 길은 살아 있다 — 깊이를 낮추면 그 자리에서 풀린다.
    await depthOption(scope, 'standard').click();
    await expect(scope.locator('.research-block')).toHaveCount(0);
    // 막힘 표시가 **실제로 걷힌다.** `ion-button`은 custom element라 속성을 `undefined`로 주면
    // 지워지지 않고 남는다 — 그래서 예전에는 조건을 푼 뒤에도 버튼이 계속 흐리게 서 있었다.
    // `int30-research.css`의 `ion-button[data-blocked="research"] { opacity: .62 }`가 이 값을 읽는다.
    // 계산된 opacity로는 판정하지 않는다 — 사진이 없어 버튼이 `disabled`인 상태와 섞인다.
    await expect(page.locator('ion-button.primary-action'), '막힘이 풀렸는데 버튼이 아직 막힌 모습이다')
      .toHaveAttribute('data-blocked', 'no');
  } finally {
    await stopServer(server);
  }
});

test('깊이를 바꿔도 적어 둔 내용과 고른 범위가 사라지지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const scope = composer(page);
    await scope.locator('ion-textarea textarea').fill('최근 발표 자료를 확인해 주세요');
    await scope.locator('.research-scope-chip').first().click();
    await scope.locator('.research-scope-chip').nth(2).click();

    for (const depth of ['deep', 'quick', 'deep', 'standard'] as const) {
      await depthOption(scope, depth).click();
      await expect(depthInput(scope, depth)).toBeChecked();
      await expect(scope.locator('ion-textarea textarea'), `${depth}로 바꾸자 적어 둔 글이 사라졌다`)
        .toHaveValue('최근 발표 자료를 확인해 주세요');
      await expect(scope.locator('.research-scope-count'), `${depth}로 바꾸자 고른 범위가 사라졌다`)
        .toHaveText(`${SCOPE_COUNT}개 중 2개 선택`);
    }
  } finally {
    await stopServer(harness.server);
  }
});

test('새 요청은 지난번 깊이를 물려받지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await depthOption(composer(page), 'deep').click();
    await expect(depthInput(composer(page), 'deep')).toBeChecked();

    // 인물 시트는 새 요청이다 — 기본값에서 시작해야 더 오래 기다리는 선택이 습관으로 따라붙지 않는다.
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal .ai-surface.research-request');
    await expect(depthInput(sheet, 'standard')).toBeChecked();
    await expect(depthInput(sheet, 'deep')).not.toBeChecked();
  } finally {
    await stopServer(harness.server);
  }
});

test('다시 열어도 깊이는 일반 조사다 — 저장하지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await depthOption(composer(page), 'quick').click();
    await expect(depthInput(composer(page), 'quick')).toBeChecked();
    await page.reload({ waitUntil: 'networkidle' });
    await expect(depthInput(composer(page), 'standard')).toBeChecked();
  } finally {
    await stopServer(harness.server);
  }
});

// ── C. 무엇이 연결되는지는 사용자에게 없다 ──

test('화면·접근성 이름·영수증 어디에도 모델 이름이 없다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 상태를 다 펼쳐 놓고 훑는다 — 접힌 자리에 숨어 있으면 검사가 헛돈다.
    await composer(page).locator('.research-scope-all').click();
    await depthOption(composer(page), 'deep').click();
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);

    const scan = async () => page.evaluate(({ latin, korean, attributes }) => {
      const hits: string[] = [];
      const check = (where: string, text: string) => {
        const value = (text ?? '').trim();
        if (!value) return;
        for (const needle of latin) {
          if (new RegExp(`\\b${needle}\\b`, 'i').test(value)) hits.push(`${needle} @ ${where}: ${value.slice(0, 40)}`);
        }
        for (const needle of korean) {
          if (value.includes(needle)) hits.push(`${needle} @ ${where}: ${value.slice(0, 40)}`);
        }
      };
      check('body', document.body.innerText);
      for (const element of document.querySelectorAll<HTMLElement>('*')) {
        for (const attribute of attributes) {
          const value = element.getAttribute(attribute);
          if (value) check(`${element.tagName.toLowerCase()}[${attribute}]`, value);
        }
      }
      return hits;
    }, { latin: FORBIDDEN_LATIN, korean: FORBIDDEN_KOREAN, attributes: TEXTUAL_ATTRIBUTES });

    // 먼저 이 검사가 **실제로 잡는지** 확인한다. 통과만 하는 검사는 검사가 아니다.
    await page.evaluate(() => {
      const bait = document.createElement('p');
      bait.id = 'int30-name-leak-bait';
      bait.textContent = '깊은 조사는 Sol 모델로 처리합니다';
      document.body.appendChild(bait);
    });
    expect(await scan(), '이름 유출 검사가 일부러 넣은 오염을 못 잡는다').not.toEqual([]);
    await page.evaluate(() => document.getElementById('int30-name-leak-bait')?.remove());

    const leaks = await scan();
    expect(leaks, `사용자 화면에 내부 이름이 보인다: ${leaks.join(' / ')}`).toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

// ── D. 키보드·읽어 주는 말 ──

test('키보드만으로 모두 선택·낱개·깊이를 차례로 다룰 수 있다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const surface = composer(page);
    // 자유 입력에서 시작해 Tab 한 번이면 가장 자주 누르는 조작에 닿는다.
    await surface.locator('ion-textarea textarea').focus();
    await page.keyboard.press('Tab');
    await expect(surface.locator('.research-scope-all')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(surface.locator('.research-scope-all')).toHaveAttribute('aria-pressed', 'true');

    // 낱개도 키보드로 끈다.
    await page.keyboard.press('Tab');
    const first = surface.locator('.research-scope-chip').first();
    await expect(first).toBeFocused();
    await page.keyboard.press('Space');
    await expect(first).toHaveAttribute('aria-pressed', 'false');

    // 깊이는 진짜 라디오라 좌우 화살표로 옮겨 다닌다.
    await depthInput(surface, 'standard').focus();
    await page.keyboard.press('ArrowRight');
    await expect(depthInput(surface, 'deep')).toBeChecked();
    await expect(surface.locator('.research-depth-summary')).toContainText('깊은 조사');
    await page.keyboard.press('ArrowLeft');
    await expect(depthInput(surface, 'standard')).toBeChecked();
  } finally {
    await stopServer(harness.server);
  }
});

test('닫혀 있어도 화살표가 깊은 조사를 건너뛰지 않는다', async ({ page }) => {
  // 꺼진 라디오는 브라우저가 화살표 순회에서 **통째로 건너뛴다**. 그래서 예전 화면에서는
  // 키보드만 쓰는 사람에게 깊은 조사가 존재하지 않는 칸이었다 — 왜 안 되는지 물어볼 수도 없었다.
  const harness = await boot(page, { deepOpen: false });
  try {
    const surface = composer(page);
    await depthInput(surface, 'standard').focus();
    await page.keyboard.press('ArrowRight');
    await expect(depthInput(surface, 'deep'), '화살표가 닫힌 깊이를 건너뛴다').toBeChecked();
    await expect(depthInput(surface, 'deep')).toBeFocused();
    // 그 자리에서 조건이 낭독기에 도달한다 — 고른 칸이 자기 조건과 이어져 있다.
    const wiring = await surface.evaluate((root) => {
      const blockId = root.querySelector('.research-block')?.id ?? '';
      const deepInput = root.querySelector('.research-depth-option[data-depth="deep"] input');
      return { blockId, described: (deepInput?.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(blockId) };
    });
    expect(wiring.blockId).not.toBe('');
    expect(wiring.described, '닫힌 깊이를 골랐는데 이유가 낭독기에 닿지 않는다').toBe(true);

    await page.keyboard.press('ArrowLeft');
    await expect(depthInput(surface, 'standard')).toBeChecked();
  } finally {
    await stopServer(harness.server);
  }
});

test('깊이 자리의 live region은 하나다 — 같은 사실을 두 번 읽어 주지 않는다', async ({ page }) => {
  const harness = await boot(page, { deepOpen: false });
  try {
    const surface = composer(page);
    const live = async () => surface.locator('.research-depth [role="status"], .research-depth [role="alert"], .research-depth [aria-live]').count();
    // 닫힌 채로 고르지 않은 상태: 요약 줄 하나만 말한다. durable 문장은 사실이지 알림이 아니다.
    expect(await live(), '깊이 자리에 스스로 말하는 자리가 둘 이상이다').toBe(1);
    await depthOption(surface, 'deep').click();
    expect(await live(), '깊이를 고른 뒤 말하는 자리가 늘었다').toBe(1);
  } finally {
    await stopServer(harness.server);
  }
});

test('읽어 주는 말이 선택 상태와 개수를 순서대로 말한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const surface = composer(page);
    const spoken = await surface.evaluate((root) => {
      const cta = root.querySelector('.research-scope-all');
      const group = root.querySelector('[role="group"][aria-label="AI 조사 항목"]');
      const count = root.querySelector('.research-scope-count');
      const radiogroup = root.querySelector('[role="radiogroup"]');
      const labelOf = (node: Element | null) => {
        if (!node) return null;
        const direct = node.getAttribute('aria-label');
        if (direct) return direct;
        const id = node.getAttribute('aria-labelledby');
        return id ? (root.querySelector(`#${CSS.escape(id)}`)?.textContent ?? '').trim() : null;
      };
      return {
        ctaPressed: cta?.getAttribute('aria-pressed') ?? null,
        ctaDescribedBy: cta?.getAttribute('aria-describedby') === count?.getAttribute('id'),
        groupLabel: labelOf(group),
        countRole: count?.getAttribute('role') ?? null,
        radiogroupLabel: labelOf(radiogroup),
        chipStates: [...root.querySelectorAll('.research-scope-chip')].map((chip) => chip.getAttribute('aria-pressed')),
        summaryRole: root.querySelector('.research-depth-summary')?.getAttribute('role') ?? null,
      };
    });
    expect(spoken.ctaPressed).toBe('false');
    expect(spoken.ctaDescribedBy, '모두 선택이 지금 개수와 이어져 있지 않다').toBe(true);
    expect(spoken.groupLabel).toBe('AI 조사 항목');
    expect(spoken.countRole, '개수가 바뀌어도 읽어 주지 않는다').toBe('status');
    expect(spoken.radiogroupLabel).toBe('얼마나 깊게 볼까요?');
    expect(spoken.chipStates).toEqual(Array.from({ length: SCOPE_COUNT }, () => 'false'));
    expect(spoken.summaryRole, '깊이를 바꿔도 읽어 주지 않는다').toBe('status');

    // 하나를 켜면 그 하나만 켜졌다고 말하고 개수가 따라온다.
    await surface.locator('.research-scope-chip').first().click();
    await expect(surface.locator('.research-scope-chip').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(surface.locator('.research-scope-count')).toHaveText(`${SCOPE_COUNT}개 중 1개 선택`);
  } finally {
    await stopServer(harness.server);
  }
});

// ── E. 좁은 폭 ──

test('가장 좁은 폰에서도 깊이 세 칸이 나란히 서고 화면 밖으로 나가지 않는다', async ({ page }) => {
  const harness = await boot(page, { width: 320, height: 568 });
  try {
    await composer(page).locator('.research-scope-all').click();
    const report = await page.evaluate(() => {
      // 폭은 clientWidth로 잰다 — innerWidth는 emulation에서 진실이 아니다.
      const viewport = document.documentElement.clientWidth;
      const offenders: string[] = [];
      document.querySelectorAll<HTMLElement>('.ai-surface.research-request *').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.right <= viewport + 1 && rect.left >= -1) return;
        offenders.push(`${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]} → ${Math.round(rect.right)}`);
      });
      const tops = [...document.querySelectorAll<HTMLElement>('.ai-surface.research-request .research-depth-option')]
        .map((node) => Math.round(node.getBoundingClientRect().top));
      return { viewport, offenders, scrollWidth: document.documentElement.scrollWidth, tops };
    });
    expect(report.viewport).toBe(320);
    expect(report.offenders, '작성 자리가 320px 화면 밖으로 나간다').toEqual([]);
    expect(report.scrollWidth, '가로 스크롤이 생긴다').toBeLessThanOrEqual(report.viewport + 1);
    // 줄이 바뀌면 "얕은 것부터 깊은 것" 순서가 눈에서 끊긴다.
    expect(new Set(report.tops).size, `깊이 칸이 줄바꿈됐다: ${report.tops.join(', ')}`).toBe(1);
  } finally {
    await stopServer(harness.server);
  }
});
