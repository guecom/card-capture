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

async function boot(page: Page, options: { theme?: string; width?: number; height?: number } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  const submitted: Array<Record<string, unknown>> = [];

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    const action = new URL(request.url()).searchParams.get('action');
    if (action === 'list') {
      const items = [person(1, '김민서', '한화시스템'), person(2, '이서연', '넥스트로보')];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items }) });
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

test('고른 깊이가 실제 요청에 실려 나간다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await depthOption(sheet.locator('.ai-surface.research-request'), 'deep').click();
    await sheet.getByRole('button', { name: '모두 선택' }).click();
    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();

    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    expect(harness.submitted[0].depth, '요청에 깊이가 실리지 않았다').toBe('deep');
    // 어디로 보내는지는 클라이언트가 정하지도, 보내지도 않는다.
    const wire = JSON.stringify(harness.submitted[0]).toLowerCase();
    for (const needle of FORBIDDEN_LATIN) {
      expect(new RegExp(`\\b${needle}\\b`).test(wire), `요청 본문에 내부 이름이 있다: ${needle}`).toBe(false);
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
