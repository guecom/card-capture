// 다섯 표면이 하나로 붙었을 때의 계약 — Kairen-Ref: TSK-000220 (INT-000030 / TSK-000545 / DEC-000105)
//
// 왜 이 파일이 따로 필요한가 — INT-000030은 다섯 lane이 동시에 만들었고, 각 lane의 게이트는
// 자기 조각만 볼 수 있었다. 그래서 아무도 보지 못한 자리가 정확히 **이음매**였다:
//
//   · 생산자(`services/device-capability.ts`)는 기기가 무엇을 할 수 있는지 판정했지만,
//     화면은 그 판정을 읽지 않고 `available: true`로 못 박힌 임시 배열을 그렸다.
//     능력 판정 전체가 화면에 닿지 않는 죽은 코드였다.
//   · `DesktopIntake`(파일 올리기)는 완성돼 있었으나 **아무 데도 붙어 있지 않아** e2e 관측이 0이었다.
//   · 못 쓰는 입구의 모양(`available: false`)은 단위 시험에만 있었고 실제 픽셀로는 한 번도 안 그려졌다.
//
// 그래서 이 게이트는 조각이 아니라 **붙은 결과**를 잰다. 판정 기준은 렌더된 픽셀과 접근성 트리이고,
// 앱 내부 상태를 다시 계산하지 않는다.
//
// 기기 시늉에 관하여: Chrome의 fake-capture 플래그는 이 기계에서 신뢰할 수 없다. 그래서
// `navigator.mediaDevices`를 직접 덮어쓴다 — 없는 카메라는 빈 기기 목록으로, 거부는
// `NotAllowedError`로, 되는 카메라는 `canvas.captureStream()`으로 만든다.
// Service Worker가 fetch를 가로채므로 가로채기는 반드시 `page.context().route(...)`로 건다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const MOCK_API = 'https://api.example.test/exec';

/** 96×60 단색 PNG. 실제 이미지 디코더를 통과하는 최소한의 진짜 파일이다(합성 데이터). */
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAAAYElEQVR42u3QAQ0AAAwCIPt3tIsFvieACKS8okCQIEGCBAkSJAhBggQJEiRIkCAECRIkSJAgQYIQJEiQIEGCBAkShCBBggQJEiRIEIIECRIkSJAgQQgSJEiQIEGCBAniNrHbSOeyjJjSAAAAAElFTkSuQmCC',
  'base64',
);

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
  return new Promise((done) => { server.close(() => done()); server.closeAllConnections(); });
}

type CameraWorld = 'absent' | 'denied' | 'working';

/**
 * 이 기기의 카메라 세계를 정한다.
 *
 * `absent`(카메라가 아예 없다)와 `denied`(카메라는 있는데 권한이 막혔다)를 **반드시 다르게**
 * 만든다. 둘을 합치면 화면이 사용자에게 있지도 않은 설정을 찾아 헤매게 하거나, 반대로 고칠 수
 * 있는 문제를 "기기 탓"으로 돌린다.
 *
 * `denied`는 페이지 안에서 `__ccAllowCamera()`로 허용으로 바꿀 수 있다 — 권한을 다시 연 뒤
 * 카드가 스스로 풀리는지를 재기 위해서다.
 */
async function useCameraWorld(page: Page, world: CameraWorld): Promise<void> {
  await page.addInitScript((mode: CameraWorld) => {
    let allowed = mode === 'working';
    (window as unknown as { __ccAllowCamera(): void }).__ccAllowCamera = () => { allowed = true; };

    const videoInputs = mode === 'absent'
      ? []
      : [{ kind: 'videoinput', deviceId: 'cc-e2e-cam', label: '', groupId: 'cc-e2e' }];

    const getUserMedia = (): Promise<MediaStream> => {
      if (mode === 'absent') {
        const error = new Error('No camera'); error.name = 'NotFoundError';
        return Promise.reject(error);
      }
      if (!allowed) {
        const error = new Error('Permission denied'); error.name = 'NotAllowedError';
        return Promise.reject(error);
      }
      // Chrome의 fake-capture 플래그가 이 기계에서 듣지 않는다. 캔버스 스트림이 실제 track을 만든다.
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 480;
      const context = canvas.getContext('2d')!;
      const paint = () => {
        context.fillStyle = '#203040';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = '#f0f0f0';
        context.fillRect(80, 120, 480, 240);
      };
      paint();
      // 정지된 캔버스는 프레임을 더 내보내지 않는다 — `video.play()`가 첫 프레임을 기다리다 멈춘다.
      window.setInterval(paint, 100);
      return Promise.resolve((canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(30));
    };

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia, enumerateDevices: () => Promise.resolve(videoInputs) },
    });
  }, world);
}

interface Harness { server: Server; origin: string }

/**
 * 앱을 띄운다.
 *
 * Service Worker가 fetch를 가로채므로 `page.route`가 아니라 `page.context().route`로 건다 —
 * 전자는 SW를 통과한 요청을 잡지 못하고, 그러면 실 GAS 배포본으로 요청이 나갈 수 있다.
 */
async function boot(page: Page, options: { size?: { width: number; height: number }; connected?: boolean } = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;

  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.context().route('https://script.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
  }));
  await page.context().route(`${MOCK_API}**`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, seeAll: true, researchInstructionEnabled: true, hasMore: false, items: [] }),
  }));
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  await page.setViewportSize(options.size ?? { width: 1280, height: 800 });

  const target = options.connected
    ? `${origin}next/?api=${encodeURIComponent(MOCK_API)}&k=fake-e2e-int30-integration-code`
    : `${origin}next/`;
  await page.goto(target, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
  return { server, origin };
}

/** 진입 카드 셋. 순서는 `capture-entry.ts`의 등록소 하나가 정한다. */
function entryCards(page: Page) {
  return page.locator('.primary-entries > .cc-entry-card');
}

/** 카드 하나를 **글자를 가진 줄들**로 읽는다. class 이름이 아니라 배치가 계약이다. */
async function cardAnatomy(page: Page) {
  return page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.primary-entries > .cc-entry-card')).map((card) => {
    const rect = card.getBoundingClientRect();
    return {
      role: card.tagName.toLowerCase(),
      title: (card.querySelector('.cc-entry-title')?.textContent ?? '').trim(),
      outcome: (card.querySelector('.cc-entry-outcome')?.textContent ?? '').trim(),
      // 행동 affordance는 쓸 수 있으면 `열기`, 못 쓰면 `회복`이다. 어느 카드도 이 줄이 비지 않는다.
      action: (card.querySelector('.cc-entry-action, .cc-entry-recovery')?.textContent ?? '').trim(),
      reason: (card.querySelector('.cc-entry-reason')?.textContent ?? '').trim(),
      hasIcon: Boolean(card.querySelector('svg')),
      top: Math.round(rect.top),
      height: Math.round(rect.height),
      width: Math.round(rect.width),
    };
  }));
}

test.describe('카메라가 없는 기기', () => {
  test('촬영 카드는 이유·회복 행동을 달고 남고, 나머지 입구는 그대로 쓸 수 있다', async ({ page }) => {
    await useCameraWorld(page, 'absent');
    const harness = await boot(page);
    try {
      /* 핵심 계약: 못 쓰는 입구도 **버튼으로 남는다**. 사라진 버튼은 사용자가 "원래 없는 것"과
         구별할 수 없고, 이 앱에서 가장 많이 참조되는 손잡이가 기기에 따라 없어지면
         웹캠 없는 PC에서만 무너지는 회귀가 생긴다 — 가장 늦게, 가장 알기 어렵게. */
      const camera = page.getByRole('button', { name: '명함 앞면 촬영' });
      await expect(camera).toBeVisible();
      await expect(camera).toHaveClass(/is-unavailable/);
      // 이유는 기기 탓인지 내 탓인지를 말한다. `이 PC`라는 말이 그 판정이다.
      await expect(camera).toContainText('카메라가 없어요');
      // 안내만 남고 할 일이 없는 상태를 만들지 않는다.
      await expect(camera).toContainText('파일 올리기로 등록하기');

      // 나머지 두 입구는 멀쩡하다 — 카메라가 막혔다고 등록 자체가 막히지 않는다.
      await expect(entryCards(page)).toHaveCount(3);
      await expect(page.getByRole('button', { name: /직접 입력/ })).toBeEnabled();
      await expect(page.getByRole('button', { name: /^파일 올리기/ })).toBeEnabled();
      await expect(page.locator('.ai-surface-head strong', { hasText: 'AI 조사 요청' })).toBeVisible();

      // 회복은 말뿐이 아니다: 누르면 실제로 파일 작업면이 열린다.
      await camera.click();
      await expect(page.locator('.cc-desktop-intake')).toBeVisible();

      // 직접 입력도 끝까지 열린다 — 마지막 입구는 어떤 조합에서도 닫히지 않는다.
      await page.getByRole('button', { name: '다른 방법 고르기' }).click();
      await page.getByRole('button', { name: /직접 입력/ }).click();
      await expect(page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' })).toBeVisible();
    } finally {
      await stopServer(harness.server);
    }
  });
});

test.describe('카메라 권한을 거부한 뒤', () => {
  test('카드가 방금 있었던 일을 기억하고, 다시 허용하면 스스로 풀린다', async ({ page }) => {
    await useCameraWorld(page, 'denied');
    const harness = await boot(page);
    try {
      const camera = page.getByRole('button', { name: '명함 앞면 촬영' });
      // 전제: 아직 물어본 적 없는 기기는 쓸 수 있는 상태다. `prompt`를 `denied`로 읽으면
      // 한 번도 거부한 적 없는 사람이 브라우저 설정을 뒤지게 된다.
      await expect(camera).not.toHaveClass(/is-unavailable/);

      await camera.click();
      await expect(page.getByText('카메라 권한이 꺼져 있습니다', { exact: false })).toBeVisible({ timeout: 15_000 });
      await page.getByRole('button', { name: '닫기' }).click();

      /* 예전에는 거부가 모달 안에서만 보이고 닫는 순간 잊혔다 — 사용자는 방금 거부한 입구가
         아무 일 없었다는 얼굴로 다시 서 있는 것을 봤다. 브라우저 조회는 방금 거부를 곧바로
         말해 주지 않으므로, **실제로 열어 본 결과**가 이 화면이 가진 가장 구체적인 사실이다. */
      await expect(camera).toHaveClass(/is-unavailable/, { timeout: 10_000 });
      await expect(camera).toContainText('권한이 꺼져 있어요');
      await expect(camera).toContainText('카메라 권한 다시 열기');

      // 그리고 그 상태에서도 다른 입구는 살아 있다.
      await expect(page.getByRole('button', { name: /직접 입력/ })).toBeEnabled();
      await expect(page.locator('.ai-surface-head strong', { hasText: 'AI 조사 요청' })).toBeVisible();

      /* 회복은 조회로 할 수 없다 — 권한 재요청은 브라우저가 카메라를 **실제로 열 때만** 일어난다.
         그래서 회복 버튼은 카메라를 다시 연다. 이번엔 허용된다. */
      await page.evaluate(() => (window as unknown as { __ccAllowCamera(): void }).__ccAllowCamera());
      await camera.click();
      await expect(page.locator('.camera-hint-pill')).toBeVisible({ timeout: 20_000 });
      await page.getByRole('button', { name: '닫기' }).click();

      // 막힘은 사실이 아니게 되면 풀린다. 안 그러면 권한을 허용해도 카드가 영원히 잠긴다.
      await expect(camera).not.toHaveClass(/is-unavailable/, { timeout: 10_000 });
    } finally {
      await stopServer(harness.server);
    }
  });
});

test.describe('데스크톱 1280×800', () => {
  test('세 입구가 다 보이고, 파일 올리기가 실제로 파일을 받아 앞·뒷면으로 배정한다', async ({ page }) => {
    await useCameraWorld(page, 'working');
    const harness = await boot(page, { size: { width: 1280, height: 800 }, connected: true });
    try {
      const cards = page.locator('.primary-entries > .cc-entry-card');
      await expect(cards).toHaveCount(3);
      // 순서: 촬영·직접 입력이 첫 줄에 나란히, 파일 올리기가 그 아래 두 칸을 가로질러.
      const anatomy = await cardAnatomy(page);
      expect(anatomy.map((card) => card.title)).toEqual(['명함 앞면 촬영', '직접 입력', '파일 올리기']);

      await page.getByRole('button', { name: /^파일 올리기/ }).click();
      await expect(page.locator('.cc-desktop-intake')).toBeVisible();

      /* `DesktopIntake`는 완성돼 있었지만 아무 데도 붙어 있지 않아 관측이 0이었다.
         여기서 처음으로 실제 파일이 통과한다: 두 장을 한 번에 주면 앞·뒷면으로 갈린다. */
      await page.locator('input.cc-drop-input').setInputFiles([
        { name: 'card-front.png', mimeType: 'image/png', buffer: SAMPLE_PNG },
        { name: 'card-back.png', mimeType: 'image/png', buffer: SAMPLE_PNG },
      ]);

      // 올린 사진은 **촬영한 사진과 같은 자리**로 들어간다 — 이름 인식·맥락·완료가 그대로 이어진다.
      await expect(page.locator('.shot-main img[alt="앞면 미리보기"]')).toBeVisible({ timeout: 20_000 });
      await expect(page.locator('img[alt="뒷면 미리보기"]')).toBeVisible({ timeout: 20_000 });
      // 사진이 들어왔으니 `완료`가 실제로 눌리는 상태가 된다.
      await expect(page.getByRole('button', { name: '완료' })).toBeEnabled();
    } finally {
      await stopServer(harness.server);
    }
  });

  test('이미지가 아닌 파일은 조용히 사라지지 않고 이름과 이유를 남긴다', async ({ page }) => {
    await useCameraWorld(page, 'working');
    const harness = await boot(page, { connected: true });
    try {
      await page.getByRole('button', { name: /^파일 올리기/ }).click();
      await page.locator('input.cc-drop-input').setInputFiles([
        { name: 'meeting-notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 not an image') },
      ]);
      const rejects = page.locator('.cc-intake-rejects');
      await expect(rejects).toBeVisible();
      await expect(rejects).toContainText('meeting-notes.pdf');
      // 촬영 초안은 시작되지 않았다 — 거절한 파일이 자리를 차지하면 안 된다.
      await expect(page.locator('.shot-main img[alt="앞면 미리보기"]')).toHaveCount(0);
    } finally {
      await stopServer(harness.server);
    }
  });
});

test.describe('미연결 + 데스크톱 첫 진입', () => {
  test('핵심 껍데기가 살아 있고 연결 안내는 막힌 기능 옆에 inline으로 붙는다', async ({ page }) => {
    await useCameraWorld(page, 'working');
    const harness = await boot(page, { size: { width: 1280, height: 800 } });
    try {
      // 전제 — 정말 미설정이다. 이 전제가 깨지면 아래 단언은 아무것도 증명하지 않는다.
      expect(await page.evaluate(() => localStorage.getItem('cc_token'))).toBeNull();

      // 연결이 없어도 로컬로 되는 일은 전부 그대로다 (founder가 "보이지 않는다"고 한 그 표면들).
      await expect(page.locator('.primary-entries > .cc-entry-card')).toHaveCount(3);
      await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeEnabled();
      await expect(page.getByRole('button', { name: /직접 입력/ })).toBeEnabled();
      await expect(page.getByRole('button', { name: /^파일 올리기/ })).toBeEnabled();
      await expect(page.locator('.ai-surface-head strong', { hasText: 'AI 조사 요청' })).toBeVisible();
      await expect(page.getByRole('button', { name: /명함 기록/ })).toBeVisible();

      // 전면 경고로 껍데기를 덮지 않는다 (DEC-000105).
      await expect(page.getByText('링크 설정이 필요해요')).toHaveCount(0);
      await expect(page.locator('.setup-banner')).toHaveCount(0);

      // 안내는 실제로 막힌 것 **옆**에 선다 — 촬영 카드보다 아래다.
      const setup = page.getByRole('status', { name: '명함 기록 연결 안내' });
      await expect(setup).toBeVisible();
      const captureBox = await page.locator('.capture-card').boundingBox();
      const setupBox = await setup.boundingBox();
      expect(captureBox && setupBox && setupBox.y > captureBox.y).toBe(true);

      /* 연결 전에도 저장된다는 사실은 **한 번만** 나온다 (통합 검수 2026-08-04에 정정).
         예전에는 이 문장이 세 카드 설명 꼬리에 각각 붙어 한 화면에 세 번 나왔고, 그 길이가
         설명 줄을 클램프 밖으로 밀어 잘린 꼬리를 만들었다. 이제 구획 머리가 말하고
         카드 설명은 자기 결과만 말한다. */
      await expect(page.locator('.capture-head .capture-deferred')).toHaveText('연결 전에도 이 기기에 저장돼요');
      await expect(page.locator('.cc-entry-card', { hasText: '이 기기에 저장돼요' })).toHaveCount(0);
      /* 그리고 연결 상태는 **가용성에는 닿지 않는다.** 연결이 없다는 이유로 카메라가 사라지던 것이
         PC 첫 진입의 원래 결함이었다. */
      await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeEnabled();
    } finally {
      await stopServer(harness.server);
    }
  });
});

test.describe('좁은 폭 320px', () => {
  test('카드 세 장이 가로로 넘치지 않는다', async ({ page }) => {
    await useCameraWorld(page, 'working');
    const harness = await boot(page, { size: { width: 320, height: 720 } });
    try {
      await expect(page.locator('.primary-entries > .cc-entry-card')).toHaveCount(3);

      // 폭 판정은 `clientWidth`로 한다 — emulation에서 `innerWidth`는 거짓을 말한다.
      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        const offenders = Array.from(document.querySelectorAll<HTMLElement>('main#kairen-ui *'))
          .filter((node) => node.getBoundingClientRect().right > root.clientWidth + 1)
          .map((node) => `${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]}`);
        return { client: root.clientWidth, scroll: root.scrollWidth, offenders: offenders.slice(0, 8) };
      });
      expect(overflow.offenders, '320px에서 화면 밖으로 나간 요소가 있다').toEqual([]);
      expect(overflow.scroll, '320px에서 가로 스크롤이 생긴다').toBeLessThanOrEqual(overflow.client + 1);

      // 좁아졌다고 줄이 사라지지 않는다 — 줄 하나를 버리면 그 순간 카드마다 구조가 달라진다.
      for (const card of await cardAnatomy(page)) {
        expect(card.title, '제목이 없다').not.toBe('');
        expect(card.outcome, `${card.title}: 설명 줄이 사라졌다`).not.toBe('');
        expect(card.action, `${card.title}: 행동 줄이 사라졌다`).not.toBe('');
      }
    } finally {
      await stopServer(harness.server);
    }
  });
});

test.describe('카드 해부 통일', () => {
  test('세 카드가 모두 제목·한 줄 설명·행동을 갖고, 같은 줄의 두 카드가 같은 높이로 선다', async ({ page }) => {
    await useCameraWorld(page, 'working');
    const harness = await boot(page, { size: { width: 1280, height: 800 } });
    try {
      const cards = await cardAnatomy(page);
      expect(cards.length, '진입 카드가 셋이 아니다').toBe(3);

      for (const card of cards) {
        // founder 판정: "하나는 설명이 있고 하나는 없고 그래서 시각적으로 뭔가 통일감이 떨어져."
        expect(card.hasIcon, `${card.title}: 아이콘이 없다`).toBe(true);
        expect(card.title, '제목이 빈 카드가 있다').not.toBe('');
        expect(card.outcome, `${card.title}: 한 줄 설명이 없다`).not.toBe('');
        expect(card.action, `${card.title}: 행동 affordance가 없다`).not.toBe('');
        expect(card.role, `${card.title}: 누를 수 있는 자리가 아니다`).toBe('button');
      }

      /* **같은 줄에 선 카드끼리** 높이가 같다 (통합 검수 2026-08-04에 정정).
         예전에는 세 카드 전부의 높이를 같게 요구했는데, 그것이 오히려 결함의 원인이었다:
         둘째 줄의 넓은 카드가 위 행 높이(190px)에 맞춰 부풀면서 설명 한 줄과 `사진 고르기`
         사이가 통째로 비었다. 통일감은 **같은 줄에서 같은 선**이지 서로 다른 해부의 같은 높이가
         아니다 — 넓은 카드는 넓이로 갚는다(`surface-polish.spec.ts` 009·010이 그것을 잰다). */
      expect(Math.abs(cards[0].height - cards[1].height), `첫 줄 두 카드의 높이가 어긋났다: ${JSON.stringify(cards.map((card) => card.height))}`).toBeLessThanOrEqual(2);
      expect(cards[2].height, `넓은 카드가 위 행 높이로 부풀었다: ${JSON.stringify(cards.map((card) => card.height))}`).toBeLessThan(cards[0].height);

      // 첫 줄의 두 카드는 같은 줄·같은 폭이다 (DEC-000103: 촬영과 직접 입력의 동등 위계).
      expect(Math.abs(cards[0].top - cards[1].top), '촬영과 직접 입력이 같은 줄에 있지 않다').toBeLessThanOrEqual(2);
      expect(Math.abs(cards[0].width - cards[1].width), '촬영과 직접 입력의 폭이 다르다').toBeLessThanOrEqual(2);
      // 셋째 카드는 둘째 줄에서 두 칸을 가로지른다 — 첫 줄에 끼면 직접 입력이 밀려난다.
      expect(cards[2].top, '파일 올리기가 첫 줄에 끼어 있다').toBeGreaterThan(cards[0].top + cards[0].height - 2);
      expect(cards[2].width, '파일 올리기가 두 칸을 가로지르지 않는다').toBeGreaterThan(cards[0].width * 1.6);
    } finally {
      await stopServer(harness.server);
    }
  });
});
