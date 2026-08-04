// 회귀 게이트: 한 자리에서 여러 장을 연속으로 찍는 촬영 세션의 세 가지 계약.
// Kairen-Ref: TSK-000278 (FI-046 / FI-049 / FI-067)
//
//  - FI-046 특정 사람에 대한 메모는 다음 촬영으로 새어 나가지 않는다. 만난 곳·관계는 남는다(의도).
//  - FI-049 방금 찍은 캡처를 즉시 되돌리거나 다시 열 수 있고, 그 과정에서 대기열이 꼬이거나
//    촬영 중인 다음 장을 덮어쓰지 않는다.
//  - FI-067 이름을 모르는 것은 정상 결과다. 빈칸을 실패나 미완료 작업으로 보여주지 않는다.
//
// 측정 함정 두 가지를 피한다 (accessible-surface.spec.ts와 같은 규칙).
//  - 폭은 document.documentElement.clientWidth로 잰다 (innerWidth는 emulation에서 진실이 아니다).
//  - 시트 기하는 올라오는 애니메이션이 끝난 뒤에 잰다 (중간 프레임은 화면 밖으로 읽힌다).
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
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
  return new Promise((resolveServer, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveServer(server)); });
}

function stopServer(server: Server): Promise<void> {
  return new Promise((stop) => { server.close(() => stop()); server.closeAllConnections(); });
}

async function serverOrigin(): Promise<{ server: Server; origin: string }> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  return { server, origin: `http://127.0.0.1:${address.port}/` };
}

// 1x1 JPEG. 기본 카메라 경로(파일 입력)로 실제 촬영 완료 흐름을 그대로 탄다 —
// 감지·인식 엔진(50MB)은 이 게이트의 대상이 아니다.
const JPEG_1X1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64',
);

interface StoredCapture {
  captureId: string;
  event?: string;
  relSelf?: string;
  relKairen?: string;
  memo?: string;
  note?: string;
  disp?: string;
  state?: string;
  quickName?: { name?: string } | null;
  images?: Array<{ name?: string; dataB64?: string }>;
}

function storedQueue(page: Page): Promise<StoredCapture[]> {
  return page.evaluate(() => new Promise<StoredCapture[]>((done) => {
    const open = indexedDB.open('cardcapture', 1);
    open.onsuccess = () => {
      const all = open.result.transaction('q', 'readonly').objectStore('q').getAll();
      all.onsuccess = () => done(all.result as StoredCapture[]);
      all.onerror = () => done([]);
    };
    open.onerror = () => done([]);
  })) as Promise<StoredCapture[]>;
}

/** 토스트는 2.6초 뒤 저절로 사라진다. 연속 촬영 게이트에서 30번 기다리지 않기 위해 바로 닫는다. */
async function dismissToast(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('ion-toast').forEach((toast) => {
      void (toast as HTMLElement & { dismiss?: () => Promise<boolean> }).dismiss?.();
    });
  });
}

/** 앞면 한 장을 앱의 실제 촬영 경로로 넣는다. */
async function shootFront(page: Page): Promise<void> {
  await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
  await page.locator('input.native-camera-input').setInputFiles({ name: 'front.jpg', mimeType: 'image/jpeg', buffer: JPEG_1X1 });
  await expect(page.locator('.shot-main img')).toBeVisible({ timeout: 30_000 });
}

async function completeCapture(page: Page): Promise<void> {
  await page.getByRole('button', { name: '완료', exact: true }).click();
  await expect(page.locator('.shot-main img')).toHaveCount(0, { timeout: 20_000 });
}

async function boot(page: Page, origin: string, search = ''): Promise<void> {
  await page.goto(`${origin}next/${search}`, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible({ timeout: 20_000 });
}

test.use({ viewport: { width: 375, height: 812 } });

test.beforeEach(async ({ page }) => {
  // 감지·인식 엔진은 이 게이트의 대상이 아니다.
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('cc_name', 'E2E Owner');
    // 기본 카메라 경로(파일 입력)를 쓸 수 있게 둔다.
    localStorage.setItem('cc_galleryFree', 'off');
  });
  /* 카메라가 **있는** 기기라고 못 박는다 (TSK-000220 / INT-000030).
     이 게이트가 재는 것은 촬영 세션의 계약이지 기기 가용성이 아니다. 그런데 입구를 쓸 수 있는지는
     이제 기기가 정하므로(`services/device-capability.ts`), 웹캠 없는 기계 — GitHub Actions
     `windows-latest` runner가 그렇다 — 에서는 촬영 카드가 이유·회복 줄을 달고 나오고 누르면
     파일 올리기가 열린다. 선언하지 않으면 이 파일은 코드가 아니라 **실행한 기계**를 재게 된다.
     못 쓰는 입구 쪽 계약은 `int30-integration.spec.ts`가 따로 잰다.

     **기기 목록만 선언하면 첫 장까지만 맞는다** (2026-08-04 CI 실패의 원인).
     앱은 목록을 믿고 카드를 열어 두지만, 카메라가 정말 열리는지는 `getUserMedia`로 **관측**하고
     그 관측이 조회를 이긴다(`lastCameraFailure`, `App.tsx`의 `noteCameraOutcome`). 그래야 방금
     권한을 거부한 기기가 계속 열리는 척하지 않는다 — 제품 쪽은 옳다.
     그래서 웹캠 없는 runner에서는 첫 촬영은 통과했다(파일 입력은 modal phase와 무관하게 있다).
     그 modal 안에서 `getUserMedia`가 `NotFoundError`로 실패하면서 카드가 회복 버튼으로 바뀌었고,
     **두 번째** 촬영부터 카드를 누르면 촬영 modal이 아니라 파일 올리기 작업면이 열렸다.
     기계 선언은 목록과 **여는 것**을 함께 해야 완결된다 (`offline-shell.spec.ts`와 같은 규칙). */
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    media.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: '', label: '', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo];
    // 화면을 재는 게이트가 아니므로 트랙 없는 stream이면 충분하다 — 필요한 사실은 "열린다" 하나다.
    media.getUserMedia = async () => new MediaStream();
    // 트랙이 없으면 데이터가 오지 않아 `play()`가 끝나지 않는다. 여는 데 성공했다는 사실만 남긴다.
    HTMLMediaElement.prototype.play = async () => undefined;
  });
});

// ── FI-046 ──────────────────────────────────────────────────────────────────
test('a memo written about one person never reaches the next 29 captures', async ({ page }) => {
  // 30장 연속 촬영은 이 게이트의 핵심 fixture다 — 한 장만 찍으면 누출이 드러나지 않는다.
  test.setTimeout(300_000);
  const { server, origin } = await serverOrigin();
  const PERSON_MEMO = '공장장 직속 · 우리 부품 단가 먼저 물어봄';
  try {
    // 연결 없이 부팅한다 — 대기열 30건이 전송되지 않고 기기에 그대로 남아 대조할 수 있다.
    await boot(page, origin);

    const context = page.locator('.context-block');
    // 만난 곳·관계는 이 자리에서 만나는 모든 사람에게 공통이다(의도된 2시간 유지).
    await context.getByRole('textbox', { name: '어디서 만났나요?' }).fill('고객사 방문 미팅');
    await context.getByRole('textbox', { name: 'Kairen과의 관계' }).fill('부품 공급사');
    // 메모는 이 사람 한 명에 대한 사실이다.
    await context.getByRole('textbox', { name: '메모' }).fill(PERSON_MEMO);

    await shootFront(page);
    await completeCapture(page);
    await dismissToast(page);

    // 화면 진실: 메모 칸은 비었고, 만난 곳·관계는 그대로 남아 있다.
    await expect(context.getByRole('textbox', { name: '메모' })).toHaveValue('');
    await expect(context.getByRole('textbox', { name: '어디서 만났나요?' })).toHaveValue('고객사 방문 미팅');
    await expect(context.getByRole('textbox', { name: 'Kairen과의 관계' })).toHaveValue('부품 공급사');

    // 나머지 29장은 아무것도 입력하지 않고 그대로 찍는다.
    for (let index = 1; index < 30; index += 1) {
      await shootFront(page);
      await completeCapture(page);
      await dismissToast(page);
    }

    const stored = await storedQueue(page);
    expect(stored, '30장이 모두 기기에 남아야 한다').toHaveLength(30);

    const withMemo = stored.filter((item) => (item.memo ?? '').trim());
    expect(withMemo.map((item) => item.memo), '메모는 그 사람 한 건에만 남아야 한다').toEqual([PERSON_MEMO]);

    // 합성 note·표시 문구로도 새어 나가지 않는다 — note는 워처가 읽는 본문이다.
    const leakedNote = stored.filter((item) => (item.note ?? '').includes(PERSON_MEMO) && (item.memo ?? '') !== PERSON_MEMO);
    expect(leakedNote.map((item) => item.captureId), 'note에 남의 메모가 섞였다').toEqual([]);
    const leakedDisp = stored.filter((item) => (item.disp ?? '').includes(PERSON_MEMO) && (item.memo ?? '') !== PERSON_MEMO);
    expect(leakedDisp.map((item) => item.captureId), '표시 문구에 남의 메모가 섞였다').toEqual([]);

    // 반대쪽 계약: 세션 공통 값은 30장 전부에 실려야 한다. 메모만 지우는 것이지 전부 비우는 것이 아니다.
    expect(stored.filter((item) => item.event === '고객사 방문 미팅')).toHaveLength(30);
    expect(stored.filter((item) => item.relKairen === '부품 공급사')).toHaveLength(30);
  } finally {
    await stopServer(server);
  }
});

// ── FI-067 ──────────────────────────────────────────────────────────────────
test('leaves the name unknown as a normal outcome instead of an unfinished task', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await boot(page, origin);
    await shootFront(page);

    const panel = page.locator('.quick-name-panel');
    const status = panel.getByRole('status');

    // 이름을 못 읽은 결과가 확정될 때까지 기다린다(엔진 차단 상태).
    await expect.poll(async () => (await status.textContent()) ?? '', { timeout: 40_000, intervals: [500] })
      .not.toMatch(/읽는 중/);

    // 빈칸을 "네가 해야 할 일"로 보여주지 않는다.
    expect(await status.textContent(), '이름 상태가 사용자에게 숙제를 지운다').not.toMatch(/직접 확인해 주세요|이름을 입력해 주세요/);

    // 모른다고 명시할 수 있는 선택지가 있어야 한다.
    const later = panel.getByRole('button', { name: '모름 / 나중에' });
    await expect(later, '모름 / 나중에 선택지가 없다').toBeVisible();

    await panel.getByRole('textbox', { name: '이름 후보' }).fill('오해된 회사명');
    await later.click();
    // 잘못 들어간 후보는 지워지고, 남은 상태는 실패가 아니라 정상 결과로 읽혀야 한다.
    await expect(panel.getByRole('textbox', { name: '이름 후보' })).toHaveValue('');
    await expect(status).toHaveText(/나중에/);
    await expect(later).toHaveAttribute('aria-pressed', 'true');

    // 이름 없이도 저장이 막히지 않는다.
    const done = page.getByRole('button', { name: '완료', exact: true });
    await expect(done).toBeEnabled();
    await completeCapture(page);
    await dismissToast(page);

    const stored = await storedQueue(page);
    expect(stored).toHaveLength(1);
    // 모른다고 고른 것이 틀린 이름으로 저장되지 않는다.
    expect(stored[0].quickName ?? null).toBeNull();

    // 목록에서도 "인식이 아직 안 끝났다"처럼 보이면 안 된다 — 기다리는 일은 없다.
    const row = page.locator('.queue-row').first();
    await expect(row).toBeVisible();
    await expect(row.getByText('이름 인식 대기'), '이름 없는 캡처가 처리 대기처럼 보인다').toHaveCount(0);
    await expect(row.getByText('이름 미정')).toBeVisible();
  } finally {
    await stopServer(server);
  }
});

// ── FI-049 ──────────────────────────────────────────────────────────────────
test('pulls the capture just taken back into the camera screen without tangling the queue', async ({ page }) => {
  test.setTimeout(120_000);
  const { server, origin } = await serverOrigin();
  try {
    await boot(page, origin);
    await page.locator('.context-block').getByRole('textbox', { name: '메모' }).fill('이 장은 잘못 찍음');
    await shootFront(page);
    await completeCapture(page);
    await dismissToast(page);

    const strip = page.locator('.last-saved');
    await expect(strip, '방금 저장한 캡처를 되돌릴 곳이 없다').toBeVisible();

    // 다시 열기: 방금 저장한 그 캡처의 상세가 열린다.
    await strip.getByRole('button', { name: '다시 열기' }).click();
    const sheet = page.locator('.queue-edit-modal');
    await expect(sheet).toBeVisible();
    // 시트 기하는 애니메이션이 끝난 뒤에 잰다.
    await page.waitForTimeout(700);
    const geometry = await sheet.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { top: box.top, left: box.left, width: box.width, viewport: document.documentElement.clientWidth };
    });
    expect(geometry.width).toBeGreaterThan(0);
    expect(geometry.left).toBeLessThan(geometry.viewport);
    await expect(sheet.getByRole('textbox', { name: '메모' })).toHaveValue('이 장은 잘못 찍음');
    await page.getByRole('button', { name: '닫기' }).click();
    await expect(sheet).toBeHidden();

    // 되돌리기: 대기열에서 빠지고 사진은 촬영 화면으로 돌아온다 — 사라지지 않는다.
    await strip.getByRole('button', { name: '되돌리기' }).click();
    await expect.poll(async () => (await storedQueue(page)).length, { timeout: 20_000 }).toBe(0);
    await expect(page.locator('.shot-main img'), '되돌린 사진이 촬영 화면으로 돌아오지 않았다').toBeVisible();
    await expect(page.locator('.context-block').getByRole('textbox', { name: '메모' })).toHaveValue('이 장은 잘못 찍음');
    await expect(strip).toHaveCount(0);

    // 다시 완료하면 한 건만 남는다 — 되돌린 항목이 유령으로 남아 두 건이 되면 안 된다.
    await completeCapture(page);
    await dismissToast(page);
    const stored = await storedQueue(page);
    expect(stored).toHaveLength(1);
    expect(stored[0].images?.some((image) => image.dataB64), '되돌렸다 저장한 캡처에 사진이 없다').toBe(true);
  } finally {
    await stopServer(server);
  }
});

test('never lets undo fight with the next capture or with a capture the server already took', async ({ page }) => {
  test.setTimeout(120_000);
  const { server, origin } = await serverOrigin();
  const posted: string[] = [];
  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      // 알림 구독 조회(`push*`)는 캡처 업로드가 아니다 — 섞이면 `undefined`가 목록을 오염시킨다.
      const pushProbe = JSON.parse(request.postData() ?? '{}') as { action?: string };
      if (pushProbe.action?.startsWith('push')) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false }) });
        return;
      }
      posted.push(String((JSON.parse(request.postData() ?? '{}') as { captureId?: string }).captureId));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true }) });
  });
  try {
    await boot(page, origin);

    // (1) 카메라 충돌: 다음 장을 이미 찍어 둔 상태에서는 되돌리기를 내밀지 않는다.
    //     내밀면 되돌린 사진이 방금 찍은 다음 장을 덮어쓴다.
    await shootFront(page);
    await completeCapture(page);
    await dismissToast(page);
    await expect(page.locator('.last-saved')).toBeVisible();
    await shootFront(page);
    await expect(page.locator('.last-saved'), '다음 장을 찍는 중에도 되돌리기가 남아 있다').toHaveCount(0);
    await completeCapture(page);
    await dismissToast(page);

    // (2) 서버가 이미 받은 캡처는 로컬에서 되돌린 척하지 않는다.
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
    await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible({ timeout: 20_000 });
    await shootFront(page);
    await completeCapture(page);
    await expect.poll(() => posted.length, { timeout: 30_000 }).toBeGreaterThan(0);

    const strip = page.locator('.last-saved');
    await expect(strip).toBeVisible();
    await expect.poll(async () => (await strip.textContent()) ?? '', { timeout: 30_000 }).toMatch(/되돌릴 수 없|전송/);
    await expect(strip.getByRole('button', { name: '되돌리기' }), '전송된 캡처에 되돌리기를 내밀고 있다').toHaveCount(0);
    await expect(strip.getByRole('button', { name: '다시 열기' })).toBeVisible();

    // 전송된 항목은 기기에서 사라지지 않는다.
    const stored = await storedQueue(page);
    expect(stored.filter((item) => item.state === 'sent').length).toBeGreaterThan(0);
  } finally {
    await stopServer(server);
  }
});
