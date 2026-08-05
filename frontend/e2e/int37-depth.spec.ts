// INT-000037 회귀 게이트 — 조사 깊이는 **오직 모델만** 바꾼다 (DEC-000110 / TSK-000565).
//
// founder 판정 2026-08-05:
//   "빠른 조사, 일반 조사, 깊은 조사는 빠른 조사는 GPT 루나 모델, 일반 조사는 GPT 테라 모델,
//    깊은 조사는 GPT 솔 모델, 오직 모델만 차이가 있는 거야. 그러고 깊은 조사를 클릭했을 때
//    조사 범위를 골라야 한다는 둥, 이런 것이 아니야."
//
// 그래서 이 파일이 재는 것은 네 문장이다. 전부 founder가 그대로 읽을 수 있는 말이어야 한다:
//   1. 깊은 조사를 고르고 조사 범위를 하나도 고르지 않아도 그대로 접수된다.
//   2. 세 깊이 사이에 사용자가 더 해야 하는 일이 없다.
//   3. 고른 깊이가 서버로 실려 나간다 — 인물 시트와 촬영, 두 길 모두.
//   4. 화면·접근성 이름·영수증 어디에도 모델 이름이 없다.
//
// ── 이 게이트가 형식적이지 않다는 근거 ──
// 변경 **전** 번들(v2.26.0, `docs/`에 커밋된 그 바이트)에서 1·2·3이 실제로 FAIL한다.
// 그때는 `깊은 조사` + 범위 0개가 제출에서 막혔고(`deep_requires_scope`), 인물 시트 경로의
// 요청 봉투에는 `depth` 칸 자체가 없었다. 4번은 성질상 변경 전에도 통과하므로 **스스로 함정을
// 놓고** 판정한다 — 오염된 문자열을 잠깐 넣어 검사가 실제로 잡는지 확인한 뒤에 0건을 주장한다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const DAY_MINUTES = 24 * 60;
const RESEARCH_RECEIPT_ID = 'research-int37-0001';
const DEPTHS = ['quick', 'standard', 'deep'] as const;

/** 사용자에게 절대 나타나면 안 되는 말. 내부 식별자 + 흔한 공급자·모델 이름. */
const FORBIDDEN_LATIN = [
  'luna', 'terra', 'sol', 'nova',
  'gpt', 'claude', 'gemini', 'llama', 'mistral', 'opus', 'sonnet', 'haiku', 'anthropic', 'openai',
];
const FORBIDDEN_KOREAN = ['모델', '엔진', '공급자'];
/** 접근성 이름·설명이 실리는 자리. 눈에 보이는 글자만 훑으면 절반만 보는 것이다. */
const TEXTUAL_ATTRIBUTES = ['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext', 'title', 'placeholder', 'alt'];

/** 1x1 JPEG. 실제 촬영 완료 경로를 그대로 타면서 감지·인식 엔진(50MB)은 건드리지 않는다(합성 데이터). */
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
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
  /** 인물 시트에서 나간 조사 요청 본문 (`action: 'researchinstruction'`). */
  submitted: Array<Record<string, unknown>>;
  /** 촬영 경로에서 나간 업로드 본문. 조사 봉투가 `researchInstruction`으로 함께 실린다. */
  uploaded: Array<Record<string, unknown>>;
}

async function boot(page: Page, options: { deepOpen?: boolean } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  const submitted: Array<Record<string, unknown>> = [];
  const uploaded: Array<Record<string, unknown>> = [];
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
      if (Array.isArray(body.images)) {
        uploaded.push(body);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, captureId: String(body.captureId ?? ''), files: [], status: 'received' }) });
        return;
      }
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await page.addInitScript(() => {
    localStorage.setItem('cc_name', '이강규');
    // 기본 카메라 경로(파일 입력)를 쓸 수 있게 둔다 — 촬영 길을 재려면 촬영이 먼저 성립해야 한다.
    localStorage.setItem('cc_galleryFree', 'off');
  });
  /* 웹캠 없는 기계(GitHub Actions windows runner)에서는 촬영 카드가 파일 올리기로 바뀐다.
     그러면 이 파일은 깊이가 아니라 **실행한 기계**를 재게 된다. 카메라가 있는 기기라고 못 박는다. */
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    media.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: '', label: '', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo];
  });
  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, submitted, uploaded };
}

function composer(page: Page) {
  return page.locator('.cc-stack > section .ai-surface.research-request').first();
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
  // 올라오는 시트 위의 요소는 아직 움직이는 중이라 클릭을 못 받는다. 전환이 끝난 뒤에 손을 댄다.
  await page.waitForTimeout(700);
}

// ── 1. 깊은 조사에 조사 범위를 요구하지 않는다 ────────────────────────────────

test('깊은 조사를 고르고 조사 범위를 하나도 고르지 않아도 그대로 접수된다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    const scope = sheet.locator('.ai-surface.research-request');

    await scope.locator('ion-textarea textarea').fill('공개 경력과 최근 발표를 확인해 주세요');
    await depthOption(scope, 'deep').click();
    await expect(depthInput(scope, 'deep')).toBeChecked();

    // 범위는 하나도 고르지 않았다 — 그 사실을 값으로 못 박는다.
    await expect(scope.locator('.research-scope-count')).toHaveText(/0개 선택/);
    // 그런데도 "무엇을 더 해야 한다"는 말이 어디에도 없다.
    await expect(scope.locator('.research-block'), '범위를 고르라는 조건이 아직 남아 있다').toHaveCount(0);

    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();

    // 접수됐다는 증거는 문구가 아니라 **실제로 나간 요청**이다.
    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    const envelope = harness.submitted[0].instruction as Record<string, unknown>;
    expect(envelope, '요청에 구조화된 봉투가 없다').toBeTruthy();
    expect(envelope.mode, '깊이를 몰래 낮춰 보냈다').toBe('deep_evidence_graph');
    // 고른 범위가 없으므로 자리도 비어 있다 — 비어 있다고 거절되지 않는다는 것이 이 검사의 전부다.
    expect(envelope.focusIds).toEqual([]);
  } finally {
    await stopServer(harness.server);
  }
});

// ── 2. 세 깊이 사이에 사용자가 더 해야 하는 일이 없다 ─────────────────────────

test('세 깊이 사이에 사용자가 더 해야 하는 일이 없다', async ({ page }) => {
  const harness = await boot(page);
  try {
    const scope = composer(page);
    await scope.locator('ion-textarea textarea').fill('공개 경력을 확인해 주세요');

    const measurements: Array<{ depth: string; extraRequired: number; blocked: string }> = [];
    for (const depth of DEPTHS) {
      await depthOption(scope, depth).click();
      await expect(depthInput(scope, depth)).toBeChecked();
      // 깊이를 바꾼 뒤의 상태가 실제로 그려진 다음에 잰다.
      await expect(scope.locator('.research-depth-summary')).toBeVisible();
      const blocked = (await page.locator('ion-button.primary-action').getAttribute('data-blocked')) ?? '(없음)';
      const notices = await scope.locator('.research-block').count();
      measurements.push({ depth, extraRequired: notices + (blocked === 'research' ? 1 : 0), blocked });
    }

    // 어느 깊이에서도 사용자가 더 해야 하는 일이 없다.
    expect(
      measurements.map((row) => row.extraRequired),
      `깊이마다 사용자가 더 해야 하는 일이 다르다: ${JSON.stringify(measurements)}`,
    ).toEqual([0, 0, 0]);
    // 그리고 셋이 서로 **같다**. 하나만 조건이 붙으면 그 선택은 다른 종류의 선택이 된다.
    expect(new Set(measurements.map((row) => `${row.extraRequired}|${row.blocked}`)).size, '세 깊이의 접수 조건이 서로 다르다').toBe(1);
  } finally {
    await stopServer(harness.server);
  }
});

// ── 3. 고른 깊이가 서버로 실려 나간다 — 두 길 모두 ───────────────────────────
//
// 화면 상태만 보는 검사는 이것을 영영 못 잡는다. 예전 결함이 정확히 그 모양이었다:
// 화면에는 세 깊이가 다 있었고 선택 상태도 남았는데, 인물 시트에서 나간 봉투에는 `depth` 칸이
// 아예 없었다. 그래서 여기서는 **나가는 값 자체**를 본다.

test('고른 깊이가 서버로 실려 나간다 — 인물 시트 길', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    const scope = sheet.locator('.ai-surface.research-request');
    await scope.locator('ion-textarea textarea').fill('공개 경력을 확인해 주세요');
    await depthOption(scope, 'deep').click();
    await sheet.getByRole('button', { name: '조사 요청 접수' }).click();

    await expect.poll(() => harness.submitted.length, { timeout: 10_000 }).toBe(1);
    const envelope = harness.submitted[0].instruction as Record<string, unknown>;
    expect(envelope.depth, '인물 시트에서 고른 깊이가 요청에 실리지 않았다').toBe('deep');
    expect(envelope.mode).toBe('deep_evidence_graph');
  } finally {
    await stopServer(harness.server);
  }
});

test('고른 깊이가 서버로 실려 나간다 — 촬영 길', async ({ page }) => {
  const harness = await boot(page);
  try {
    const scope = composer(page);
    await scope.locator('ion-textarea textarea').fill('공개 경력을 확인해 주세요');
    await depthOption(scope, 'quick').click();
    await expect(depthInput(scope, 'quick')).toBeChecked();

    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    await page.locator('input.native-camera-input').setInputFiles({ name: 'front.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
    await expect(page.locator('.shot-main img')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '완료', exact: true }).click();

    await expect.poll(() => harness.uploaded.length, { timeout: 20_000 }).toBeGreaterThan(0);
    const envelope = harness.uploaded[0].researchInstruction as Record<string, unknown> | null;
    expect(envelope, '촬영 업로드에 조사 봉투가 없다').toBeTruthy();
    expect(envelope!.depth, '촬영 탭에서 고른 깊이가 업로드에 실리지 않았다').toBe('quick');
    expect(envelope!.mode).toBe('quick');
  } finally {
    await stopServer(harness.server);
  }
});

// ── 4. 무엇이 연결되는지는 사용자에게 없다 ────────────────────────────────────

test('화면·접근성 이름·영수증 어디에도 모델 이름이 없다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 상태를 다 펼쳐 놓고 훑는다 — 접힌 자리에 숨어 있으면 검사가 헛돈다.
    await composer(page).locator('.research-scope-all').click();
    await depthOption(composer(page), 'deep').click();
    await openPersonSheet(page);
    const sheet = page.locator('ion-modal.person-action-modal');
    await sheet.locator('.ai-surface.research-request ion-textarea textarea').fill('공개 경력을 확인해 주세요');
    await depthOption(sheet.locator('.ai-surface.research-request'), 'deep').click();
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
      bait.id = 'int37-name-leak-bait';
      bait.textContent = '깊은 조사는 Sol 모델로 처리합니다';
      document.body.appendChild(bait);
    });
    expect(await scan(), '이름 유출 검사가 일부러 넣은 오염을 못 잡는다').not.toEqual([]);
    await page.evaluate(() => document.getElementById('int37-name-leak-bait')?.remove());

    const leaks = await scan();
    expect(leaks, `사용자 화면에 내부 이름이 보인다: ${leaks.join(' / ')}`).toEqual([]);

    // 영수증(서버로 나간 본문)에도 없다 — 어디로 보낼지는 클라이언트가 정하지도, 보내지도 않는다.
    const wire = JSON.stringify(harness.submitted[0]).toLowerCase();
    for (const needle of FORBIDDEN_LATIN) {
      expect(new RegExp(`\\b${needle}\\b`).test(wire), `요청 본문에 내부 이름이 있다: ${needle}`).toBe(false);
    }
  } finally {
    await stopServer(harness.server);
  }
});
