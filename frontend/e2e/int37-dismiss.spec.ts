// 덮인 표면을 나가는 문법 — Kairen-Ref: TSK-000564 (ISS-000246 / INT-000037)
//
// founder 판정 (개발 인터뷰 009):
//   "명함 안면 촬영 누르면 닫기를 눌러서 끄고 직접 입력을 누르면 취소를 눌러서 끄고 (…)
//    이거 다 오른쪽 위에 닫기 버튼으로 끌 수 있으면 좋겠어."
//
// 이 게이트가 표면별이 아니라 **문법**을 재는 이유: 표면마다 spec을 두면 다음에 생기는 표면은
// 아무 spec에도 안 걸린다. 결함이 다시 들어오는 자리가 정확히 거기다 — 지금까지 나가는 방법이
// 다섯 가지로 갈린 것도 표면이 하나씩 늘면서였다.
//
// 판정 기준은 렌더된 픽셀과 접근성 트리다. 앱의 상태값을 다시 계산하지 않는다 — 그러면 앱이
// 자기 공식으로 자기를 채점하게 된다.
//
// `사진 올리기`는 여기 없다. 그 카드는 앱 화면을 열지 않고 **브라우저·OS의 파일 선택창**을 연다
// (`components/CaptureIntake.tsx`). 그 창은 우리 문서가 아니라서 버튼을 그릴 수도, 재는 것도
// 우리 몫이 아니다. 대신 `누르면 우리 표면이 하나도 안 열린다`는 사실을 여기서 못 박는다 —
// 언젠가 중간 화면이 다시 생기면 그때는 이 문법을 지켜야 하기 때문이다.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const MOCK_API = 'https://api.example.test/exec';

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

/** 카메라가 되는 기기를 만든다. Chrome의 fake-capture 플래그는 이 기계에서 신뢰할 수 없다. */
async function useWorkingCamera(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const getUserMedia = (): Promise<MediaStream> => {
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
      value: {
        getUserMedia,
        enumerateDevices: () => Promise.resolve([{ kind: 'videoinput', deviceId: 'cc-e2e-cam', label: '', groupId: 'cc-e2e' }]),
      },
    });
  });
}

/**
 * 손가락 기기로 만든다 — founder가 보는 화면이 그 기기다.
 *
 * `detectFormFactor`가 보는 두 질의만 바꾸고 나머지는 원래 구현으로 흘린다. `matchMedia`를
 * 통째로 바꾸면 Ionic이 자기 판정에 쓰는 질의까지 거짓을 받는다. 여기서 이 시늉이 필요한
 * 이유는 카드 이름이 기기에 따라 갈리기 때문이다(`파일 올리기` ↔ `사진 올리기`).
 */
async function useTouchPointer(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    const forced: Record<string, boolean> = { '(pointer: fine)': false, '(hover: none)': true };
    window.matchMedia = ((query: string) => {
      if (!(query in forced)) return original(query);
      return {
        media: query,
        matches: forced[query],
        onchange: null,
        addListener() { /* 이 두 질의는 바뀌지 않는다 */ },
        removeListener() { /* 위와 같음 */ },
        addEventListener() { /* 위와 같음 */ },
        removeEventListener() { /* 위와 같음 */ },
        dispatchEvent() { return false; },
      } as unknown as MediaQueryList;
    }) as typeof window.matchMedia;
  });
}

interface Harness { server: Server; origin: string }

async function boot(page: Page): Promise<Harness> {
  await useTouchPointer(page);
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
  // 첫 실행 이름 게이트는 이 게이트의 대상이 아니다. 이름을 미리 넣어 그 표면을 지나친다.
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  await page.setViewportSize({ width: 412, height: 900 });
  await page.goto(`${origin}next/?api=${encodeURIComponent(MOCK_API)}&k=fake-e2e-int37-dismiss-code`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
  return { server, origin };
}

/** 지금 화면을 덮고 있는 표면. Ionic은 열린 modal에만 `show-modal`을 붙인다. */
function openSurface(page: Page): Locator {
  return page.locator('ion-modal.show-modal');
}

interface DismissReading {
  /** 이 표면 안에 있는 나가기 조작의 개수. 정확히 하나여야 한다. */
  closeCount: number;
  /** 낭독기가 읽는 이름. */
  name: string;
  /** 표면 오른쪽 절반에 있는가. */
  onRight: boolean;
  /** 시트 위쪽 80px 안에 있는가 — 헤더 줄의 높이다. */
  onTop: boolean;
  /** 손가락 최소 크기(44px)를 만족하는가. */
  width: number;
  height: number;
  /** 자리가 멈췄는지 보기 위한 원시 좌표. 계약이 아니라 관측값이다. */
  top: number;
  left: number;
}

/**
 * 덮인 표면 하나를 **문법의 자로** 읽는다.
 *
 * 이름이 아니라 `[data-sheet-close]` 표식으로 센다. 문구는 앞으로도 바뀔 수 있지만
 * "이 표면을 나가는 조작"이라는 역할은 바뀌지 않는다.
 */
async function readDismiss(page: Page): Promise<DismissReading> {
  return page.evaluate(() => {
    const surface = document.querySelector('ion-modal.show-modal');
    if (!surface) throw new Error('덮인 표면이 없다');
    /* 재는 기준은 `ion-modal`이 아니라 **눈에 보이는 시트**다. `ion-modal`은 화면 전체를 덮는
       층이라 그것을 기준으로 재면 시트가 화면 한참 아래에서 시작해도 "위에 있다"가 된다.
       시트는 Ionic의 shadow DOM 안에 있다. */
    const sheet = (surface.shadowRoot?.querySelector('.modal-wrapper') as HTMLElement | null) ?? (surface as HTMLElement);
    const closers = Array.from(surface.querySelectorAll<HTMLElement>('[data-sheet-close]'));
    const sheetBox = sheet.getBoundingClientRect();
    const first = closers[0];
    const box = first?.getBoundingClientRect();
    return {
      closeCount: closers.length,
      name: (first?.getAttribute('aria-label') ?? first?.textContent ?? '').trim(),
      onRight: Boolean(box) && (box!.left + box!.width / 2) > (sheetBox.left + sheetBox.width / 2),
      onTop: Boolean(box) && (box!.top - sheetBox.top) < 80,
      width: box ? Math.round(box.width) : 0,
      height: box ? Math.round(box.height) : 0,
      top: box ? Math.round(box.top) : -1,
      left: box ? Math.round(box.left) : -1,
    };
  });
}

/**
 * 자리가 **멈춘 뒤에** 읽는다.
 *
 * 시트는 아래에서 올라오며 자리를 바꾼다. 올라오는 도중에 재면 "닫기가 위에 없다"가 나오는데,
 * 그건 화면의 사실이 아니라 재는 순간의 사실이다. 정해진 시간을 기다리는 대신 값이 두 번
 * 같아질 때까지 본다 — 기계가 느려도 빨라도 같은 판정이 나온다.
 */
async function settledDismiss(page: Page): Promise<DismissReading> {
  let previous = await readDismiss(page);
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await page.waitForTimeout(50);
    const current = await readDismiss(page);
    if (current.top === previous.top && current.left === previous.left && current.top >= 0) return current;
    previous = current;
  }
  return previous;
}

/** 세 표면이 지켜야 하는 것 하나. 표면 이름만 바꿔 같은 자를 댄다. */
async function expectDismissGrammar(page: Page, surfaceName: string): Promise<void> {
  const reading = await settledDismiss(page);
  expect(reading.closeCount, `${surfaceName}: 나가는 조작이 정확히 하나가 아니다`).toBe(1);
  expect(reading.name, `${surfaceName}: 낭독기가 읽는 이름이 '닫기'가 아니다`).toBe('닫기');
  expect(reading.onRight, `${surfaceName}: 나가는 조작이 오른쪽에 없다`).toBe(true);
  expect(reading.onTop, `${surfaceName}: 나가는 조작이 위에 없다`).toBe(true);
  expect(reading.width, `${surfaceName}: 손가락으로 누르기에 좁다`).toBeGreaterThanOrEqual(44);
  expect(reading.height, `${surfaceName}: 손가락으로 누르기에 낮다`).toBeGreaterThanOrEqual(44);
}

async function openCamera(page: Page): Promise<void> {
  await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
  await expect(openSurface(page)).toBeVisible({ timeout: 15_000 });
}

async function openManual(page: Page): Promise<void> {
  await page.getByRole('button', { name: '직접 입력' }).click();
  await expect(openSurface(page)).toBeVisible({ timeout: 15_000 });
}

async function openSignOut(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
  await page.getByRole('button', { name: '연결 해제', exact: true }).click();
  await expect(openSurface(page)).toBeVisible({ timeout: 15_000 });
}

test.describe('덮인 표면은 모두 같은 방법으로 닫힌다', () => {
  test('명함 앞면 촬영을 오른쪽 위 닫기로 끌 수 있다', async ({ page }) => {
    await useWorkingCamera(page);
    const { server } = await boot(page);
    try {
      await openCamera(page);
      await expectDismissGrammar(page, '명함 앞면 촬영');
    } finally {
      await stopServer(server);
    }
  });

  test('직접 입력을 오른쪽 위 닫기로 끌 수 있다', async ({ page }) => {
    const { server } = await boot(page);
    try {
      await openManual(page);
      await expectDismissGrammar(page, '직접 입력');
    } finally {
      await stopServer(server);
    }
  });

  test('연결 해제 확인도 같은 자리에서 닫힌다', async ({ page }) => {
    const { server } = await boot(page);
    try {
      await openSignOut(page);
      await expectDismissGrammar(page, '연결 해제 확인');
    } finally {
      await stopServer(server);
    }
  });

  test('세 표면의 닫기가 같은 자리·같은 크기다', async ({ page }) => {
    await useWorkingCamera(page);
    const { server } = await boot(page);
    try {
      const readings: DismissReading[] = [];
      await openCamera(page);
      readings.push(await settledDismiss(page));
      await page.keyboard.press('Escape');
      await expect(openSurface(page)).toHaveCount(0, { timeout: 10_000 });

      await openManual(page);
      readings.push(await settledDismiss(page));
      await page.keyboard.press('Escape');
      await expect(openSurface(page)).toHaveCount(0, { timeout: 10_000 });

      await openSignOut(page);
      readings.push(await settledDismiss(page));

      /* 크기가 표면마다 다르면 "같은 손잡이"라는 약속이 눈으로 깨진다. 자리는 표면 폭이
         달라 절대 좌표로 비교할 수 없으므로 `오른쪽 위`라는 사실로 비교한다. */
      const widths = new Set(readings.map((reading) => reading.width));
      const heights = new Set(readings.map((reading) => reading.height));
      expect(widths.size, `닫기 너비가 표면마다 다르다: ${[...widths].join(', ')}`).toBe(1);
      expect(heights.size, `닫기 높이가 표면마다 다르다: ${[...heights].join(', ')}`).toBe(1);
      expect(readings.every((reading) => reading.onRight && reading.onTop), '어떤 표면의 닫기가 오른쪽 위에 없다').toBe(true);
      expect(new Set(readings.map((reading) => reading.name)), '표면마다 다른 이름으로 읽힌다').toEqual(new Set(['닫기']));
    } finally {
      await stopServer(server);
    }
  });

  test('닫기를 눌러 실제로 닫힌다 — 세 표면 모두', async ({ page }) => {
    await useWorkingCamera(page);
    const { server } = await boot(page);
    try {
      for (const open of [openCamera, openManual, openSignOut]) {
        await open(page);
        await page.locator('ion-modal.show-modal [data-sheet-close]').click();
        await expect(openSurface(page)).toHaveCount(0, { timeout: 10_000 });
      }
    } finally {
      await stopServer(server);
    }
  });

  test('키보드만으로도 닫기에 닿아 누를 수 있다', async ({ page }) => {
    const { server } = await boot(page);
    try {
      await openManual(page);
      await settledDismiss(page);
      const closer = page.locator('ion-modal.show-modal [data-sheet-close]');
      /* `focus()`로 옮기면 안 된다 — 브라우저는 그때 초점 **표시**를 켜지 않는다(`:focus-visible`은
         키보드로 옮겼을 때만 선다). 그래서 실제로 Tab을 눌러 간다. 이 시트는 초점을 가두므로
         Tab은 시트 안에서 돈다 — 한 바퀴 안에 닿지 못하면 그게 결함이다. */
      let reached = false;
      for (let step = 0; step < 25 && !reached; step += 1) {
        await page.keyboard.press('Tab');
        reached = await closer.evaluate((node) => node === document.activeElement);
      }
      expect(reached, '닫기가 Tab으로 닿지 않는다').toBe(true);
      await expect(closer, '닫기가 키보드 초점을 받지 못한다').toBeFocused();
      /* 초점 표시가 없으면 키보드 사용자는 지금 어디에 서 있는지 모른다. */
      const outline = await closer.evaluate((node) => {
        const style = getComputedStyle(node);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      });
      expect(outline.style, '닫기에 키보드 초점 표시가 없다').not.toBe('none');
      expect(outline.width, '닫기의 초점 테두리가 너무 얇다').toBeGreaterThanOrEqual(2);
      await page.keyboard.press('Enter');
      await expect(openSurface(page)).toHaveCount(0, { timeout: 10_000 });
    } finally {
      await stopServer(server);
    }
  });

  test('기존에 쓰던 길도 막히지 않는다 — Esc와 아래로 끌기가 그대로다', async ({ page }) => {
    const { server } = await boot(page);
    try {
      await openManual(page);
      await page.keyboard.press('Escape');
      await expect(openSurface(page), 'Esc로 닫히지 않는다').toHaveCount(0, { timeout: 10_000 });

      // 아래로 끌어 닫던 사람이 못 닫게 되면 안 된다. 시트 제스처가 살아 있는지는
      // Ionic이 그 표면에 만든 `breakpoints` 설정으로 확인한다.
      await openManual(page);
      const draggable = await page.evaluate(() => {
        const surface = document.querySelector('ion-modal.show-modal') as (HTMLElement & { breakpoints?: number[] }) | null;
        return Array.isArray(surface?.breakpoints) && surface!.breakpoints!.includes(0);
      });
      expect(draggable, '아래로 끌어 닫는 길이 사라졌다').toBe(true);
    } finally {
      await stopServer(server);
    }
  });

  test('적던 글은 닫아도 사라지지 않는다', async ({ page }) => {
    const { server } = await boot(page);
    try {
      await openManual(page);
      const field = page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' });
      await field.fill('강남 컨퍼런스에서 만난 물류 담당자');
      await page.locator('ion-modal.show-modal [data-sheet-close]').click();
      await expect(openSurface(page)).toHaveCount(0, { timeout: 10_000 });

      // 진입 카드가 "이어서 쓸 것이 있다"고 말해야 한다 — 말하지 않으면 사용자는 잃었다고 읽는다.
      await expect(page.getByRole('button', { name: /이어서 쓰기/ })).toBeVisible();
      await openManual(page);
      await expect(field, '닫았더니 적던 글이 사라졌다').toHaveValue('강남 컨퍼런스에서 만난 물류 담당자');
    } finally {
      await stopServer(server);
    }
  });

  test('사진 올리기는 우리 표면을 열지 않는다 — 그 창은 폰의 것이다', async ({ page }) => {
    const { server } = await boot(page);
    try {
      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '사진 올리기' }).click();
      await chooser;
      /* 앱 화면이 하나도 안 열렸다는 것이 여기서의 계약이다. 중간 화면이 다시 생기면
         이 단정이 깨지고, 그때는 위 문법을 지켜야 한다는 뜻이다 (INT-000036). */
      await expect(openSurface(page), '사진 올리기가 우리 표면을 열었다').toHaveCount(0);
    } finally {
      await stopServer(server);
    }
  });
});
