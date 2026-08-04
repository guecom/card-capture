// 직접 입력(자연어 인물 등록) 회귀 게이트 — Kairen-Ref: TSK-000533 / ISS-000231 / DEC-000103
//
// founder 요구 (INT-000029): "명함, 안면 촬영을 통해서 인물을 검색하고 등록할 수도 있겠지만,
// 어떤 사람인지에 대한 정보를 수기로 입력하면 그것을 마치 명함의 정보들을 검색하는 것처럼
// 이제 진행해 주는 게 있었으면 좋겠어."
//
// 이 게이트가 고정하는 계약:
//   1. `직접 입력`은 `명함 촬영`과 **같은 위계**로 나란히 있다 (하위 메뉴·별도 탭 금지).
//   2. 빈 내용 제출은 죽은 버튼이 아니라 **이유**로 막힌다.
//   3. 글 안의 이메일·전화는 식별 근거로 **되읽어** 보여 준다.
//   4. 등록은 사진 경로와 같은 대기열·같은 captureId 멱등을 쓴다 — 연타해도 job은 하나다.
//   5. 작성 중인 내용은 앱을 껐다 켜도 남는다.
//   6. 320px에서 가로로 넘치지 않고, 화면 낭독기 이름이 붙어 있다.
//   7. 안면 촬영(face identification)은 명시적 non-goal이라 어떤 표현도 화면에 없다.
//
// 판정 기준은 렌더된 픽셀과 실제로 나간 요청이다 — 앱 내부 상태를 다시 계산하지 않는다.
import { expect, test, type Page, type Request } from '@playwright/test';
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

/** 실제로 서버로 나간 직접 입력 요청. 화면 상태가 아니라 이것이 "job이 몇 개인가"의 진실이다. */
interface ManualPost {
  action?: string;
  captureId?: string;
  text?: string;
  event?: string;
  note?: string;
}

function manualPostsOf(requests: Request[]): ManualPost[] {
  return requests
    .map((request) => {
      try { return JSON.parse(request.postData() ?? '{}') as ManualPost; } catch { return {}; }
    })
    .filter((body) => body.action === 'manualperson');
}

test.beforeEach(async ({ page }) => {
  // 카메라·OCR 자산은 이 게이트와 무관하다. 받으면 느려지기만 한다.
  await page.context().route('**/vendor/**', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  /* 카메라가 **있는** 기기라고 못 박는다 (TSK-000220 / INT-000030).
     이 파일의 주제는 `직접 입력`이지 기기 가용성이 아니다. 그런데 웹캠 없는 기계에서는 촬영 카드가
     회복 문구 `파일 올리기로 등록하기`를 달고 나오고, 그 문구가 시트 제출 버튼의 이름 `등록하기`를
     부분 문자열로 품는다 — `getByRole('button', { name: '등록하기' })`가 두 요소로 갈려 strict mode에서
     깨진다(웹캠 없는 기계로 시늉해 실측: 이 파일 4건 FAIL). 기기 축을 선언해 그 우연을 없앤다.
     못 쓰는 입구의 모양과 문구는 `int30-integration.spec.ts`가 자기 축으로 따로 잰다. */
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    media.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: '', label: '', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo];
  });
});

async function openApp(page: Page, origin: string): Promise<Request[]> {
  const posts: Request[] = [];
  await page.route('https://api.example.test/**', async (route, request) => {
    if (request.method() === 'POST') {
      posts.push(request);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, captureId: 'server-side', type: 'manual_person', files: [] }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true, hasMore: false }) });
  });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return posts;
}

/** 시트는 올라오는 애니메이션이 끝난 뒤에 잰다 — 중간 프레임은 화면 밖으로 읽힌다. */
async function openManualSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: '직접 입력' }).click();
  await expect(page.locator('ion-modal.manual-sheet')).toBeVisible();
  await expect(page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' })).toBeVisible();
  await page.waitForTimeout(400);
}

async function typeManual(page: Page, text: string): Promise<void> {
  const field = page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' });
  await field.click();
  await field.fill(text);
}

test('직접 입력이 명함 촬영과 같은 위계로 나란히 있다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, origin);

    const shot = page.getByRole('button', { name: '명함 앞면 촬영' });
    const manual = page.getByRole('button', { name: '직접 입력' });
    await expect(shot).toBeVisible();
    await expect(manual).toBeVisible();

    const boxes = await page.evaluate(() => {
      const shotNode = document.querySelector<HTMLElement>('.shot-main');
      const manualNode = document.querySelector<HTMLElement>('.manual-main');
      if (!shotNode || !manualNode) return null;
      const a = shotNode.getBoundingClientRect();
      const b = manualNode.getBoundingClientRect();
      return {
        sameParent: shotNode.parentElement === manualNode.parentElement,
        shot: { top: a.top, height: a.height, width: a.width },
        manual: { top: b.top, height: b.height, width: b.width },
      };
    });
    expect(boxes, '.shot-main / .manual-main 중 하나가 없다').not.toBeNull();
    // 하위 메뉴가 아니라 같은 부모의 형제여야 "같은 위계"다.
    expect(boxes!.sameParent, '직접 입력이 명함 촬영과 같은 부모에 있지 않다').toBe(true);
    expect(Math.abs(boxes!.shot.top - boxes!.manual.top), '같은 줄에 있지 않다').toBeLessThanOrEqual(2);
    expect(Math.abs(boxes!.shot.height - boxes!.manual.height), '높이가 다르다 — 시각적 무게가 같아야 한다').toBeLessThanOrEqual(2);
    expect(Math.abs(boxes!.shot.width - boxes!.manual.width), '폭이 다르다 — 시각적 무게가 같아야 한다').toBeLessThanOrEqual(2);
  } finally {
    await stopServer(server);
  }
});

test('빈 내용으로 누르면 죽은 버튼이 아니라 이유를 말한다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const posts = await openApp(page, origin);
    await openManualSheet(page);

    const submit = page.getByRole('button', { name: '등록하기' });
    // 눌리지 않는 버튼은 이유를 말할 수 없다 — 비활성으로 막지 않는다.
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.locator('.manual-refusal')).toContainText('한 줄이라도');
    // 공백만 적어도 같은 판정이어야 한다.
    await typeManual(page, '    ');
    await submit.click();
    await expect(page.locator('.manual-refusal')).toContainText('한 줄이라도');
    expect(manualPostsOf(posts), '빈 내용이 서버로 나갔다').toHaveLength(0);
  } finally {
    await stopServer(server);
  }
});

test('글 안의 이메일·전화를 식별 근거로 되읽어 준다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, origin);
    await openManualSheet(page);
    await typeManual(page, '어제 로보월드에서 만난 가온테크 김미래 CTO. 연락처는 mirae.kim@gaontech-fake.co.kr, 010-1234-5678 이라고 했다.');

    const evidence = page.locator('.manual-evidence');
    await expect(evidence).toBeVisible();
    await expect(evidence).toContainText('mirae.kim@gaontech-fake.co.kr');
    await expect(evidence).toContainText('010-1234-5678');
  } finally {
    await stopServer(server);
  }
});

test('세 단어만 적어도 등록되고 접수 영수증과 기록이 남는다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const posts = await openApp(page, origin);
    await openManualSheet(page);
    await typeManual(page, '어제 만난 로보틱스 대표');
    await page.getByRole('button', { name: '등록하기' }).click();

    await expect(page.locator('.manual-receipt')).toBeVisible();
    await expect(page.locator('.manual-receipt')).toContainText('접수');
    await page.getByRole('button', { name: '닫기' }).click();
    await expect(page.locator('ion-modal.manual-sheet')).toBeHidden();

    // 진행은 명함 기록 블록이 소유한다 — 직접 입력도 같은 자리에 나타나야 한다.
    await expect(page.locator('.records-feed .queue-row')).toHaveCount(1);
    await expect(page.locator('.records-feed .queue-row')).toContainText('어제 만난 로보틱스 대표');

    await expect.poll(() => manualPostsOf(posts).length, { timeout: 10_000 }).toBe(1);
    const [body] = manualPostsOf(posts);
    expect(body.text).toBe('어제 만난 로보틱스 대표');
    expect(body.captureId, 'captureId 없이 나가면 서버가 멱등 판정을 할 수 없다').toBeTruthy();
  } finally {
    await stopServer(server);
  }
});

test('연타해도 job은 하나다 — 같은 captureId로만 나간다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const posts = await openApp(page, origin);
    await openManualSheet(page);
    await typeManual(page, '전시회에서 만난 부품 공급사 이사님. 다음 주에 견적 준다고 함.');

    // 진짜 연타는 React가 다시 그리기 **전에** 두 번째 클릭이 도착하는 것이다.
    // Playwright의 두 번째 click()은 버튼이 사라진 뒤 새로 찾으므로 그 창을 재현하지 못한다.
    await page.getByRole('button', { name: '등록하기' })
      .evaluate((node: HTMLElement) => { node.click(); node.click(); node.click(); });
    await expect(page.locator('.manual-receipt')).toBeVisible();
    await page.waitForTimeout(1_500);

    await expect(page.locator('.records-feed .queue-row'), '연타로 대기열 항목이 늘었다').toHaveCount(1);
    const ids = new Set(manualPostsOf(posts).map((body) => body.captureId));
    expect(ids.size, `연타로 서로 다른 job이 생겼다: ${[...ids].join(', ')}`).toBe(1);
  } finally {
    await stopServer(server);
  }
});

test('작성 중인 내용은 앱을 껐다 켜도 남는다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, origin);
    await openManualSheet(page);
    await typeManual(page, '판교에서 만난 배터리 소재 회사 연구소장님');
    // 저장은 입력 즉시 일어나야 한다 — 완료를 못 눌러도 초안이 살아야 한다.
    await page.waitForTimeout(300);

    await openApp(page, origin);
    await expect(page.getByRole('button', { name: '직접 입력' })).toBeVisible();
    await expect(page.locator('.manual-main')).toContainText('이어서');
    await openManualSheet(page);
    await expect(page.getByRole('textbox', { name: '이 사람에 대해 아는 내용' }))
      .toHaveValue('판교에서 만난 배터리 소재 회사 연구소장님');
  } finally {
    await stopServer(server);
  }
});

test('연결이 끊겨도 기기에 남고 다시 연결되면 스스로 올라간다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const posts: Request[] = [];
    let online = false;
    await page.route('https://api.example.test/**', async (route, request) => {
      if (request.method() === 'POST') {
        if (!online) { await route.abort('failed'); return; }
        posts.push(request);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, captureId: 'server-side' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: true, hasMore: false }) });
    });
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`${origin}next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });

    await openManualSheet(page);
    await typeManual(page, '오프라인 전시장에서 만난 협력사 팀장님');
    await page.getByRole('button', { name: '등록하기' }).click();
    // 기기 저장이 확인된 사실만 말한다 — 서버 접수는 아직 일어나지 않았다.
    await expect(page.locator('.manual-receipt')).toContainText('이 폰에 저장');
    await page.getByRole('button', { name: '닫기' }).click();
    await expect(page.locator('.records-feed .queue-row')).toHaveCount(1);

    online = true;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => posts.length, { timeout: 15_000 }).toBeGreaterThan(0);
  } finally {
    await stopServer(server);
  }
});

test('320px에서 시트가 가로로 넘치지 않는다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await openApp(page, origin);
    await openManualSheet(page);
    await typeManual(page, '스마트팩토리전 부스에서 만난 자동화 설비 회사 대표. 이메일 rep@factory-fake.example.test 라고 적어 줌.');

    const report = await page.evaluate(() => {
      // 폭 기준은 clientWidth다 — innerWidth는 에뮬레이션에서 진실이 아니다.
      const viewport = document.documentElement.clientWidth;
      const offenders: Array<{ selector: string; right: number }> = [];
      document.querySelectorAll<HTMLElement>('ion-modal.manual-sheet *').forEach((node) => {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        if (rect.right <= viewport + 1 && rect.left >= -1) return;
        const className = typeof node.className === 'string' ? node.className.trim() : '';
        offenders.push({ selector: `${node.tagName.toLowerCase()}${className ? `.${className.split(/\s+/).join('.')}` : ''}`, right: Math.round(rect.right) });
      });
      return { viewport, offenders: offenders.slice(0, 8) };
    });
    expect(report.offenders, JSON.stringify(report)).toEqual([]);
  } finally {
    await stopServer(server);
  }
});

test('안면 촬영은 non-goal이라 어떤 표현도 화면에 없다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, origin);
    await openManualSheet(page);
    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    for (const forbidden of ['안면', '얼굴 촬영', '얼굴 인식', '페이스']) {
      expect(text, `non-goal 표현이 노출됐다: ${forbidden}`).not.toContain(forbidden);
    }
  } finally {
    await stopServer(server);
  }
});

// 기존 다크 대비 게이트(int16-surfaces)는 탭 화면만 훑는다 — 시트는 열어야 존재하므로
// 그 sweep에 잡히지 않는다. 새 표면의 대비는 새 표면이 책임진다.
test('다크 모드에서 시트의 모든 글자가 읽힌다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.addInitScript(() => localStorage.setItem('cc_theme', 'dark'));
    await openApp(page, origin);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openManualSheet(page);
    await typeManual(page, '가온테크 김미래 CTO, mirae.kim@gaontech-fake.co.kr 010-1234-5678');
    await page.waitForTimeout(200);

    const swept = await page.evaluate(() => {
      const parse = (value: string) => {
        const parts = value.match(/[\d.]+/g);
        if (!parts || parts.length < 3) return null;
        return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]), a: parts[3] === undefined ? 1 : Number(parts[3]) };
      };
      type Rgba = { r: number; g: number; b: number; a: number };
      const over = (front: Rgba, back: Rgba): Rgba => ({
        r: front.r * front.a + back.r * (1 - front.a),
        g: front.g * front.a + back.g * (1 - front.a),
        b: front.b * front.a + back.b * (1 - front.a),
        a: 1,
      });
      const luminance = ({ r, g, b }: Rgba) => {
        const channel = (value: number) => {
          const normalized = value / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const ratio = (a: Rgba, b: Rgba) => {
        const first = luminance(a);
        const second = luminance(b);
        return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
      };
      const page = parse(getComputedStyle(document.documentElement).getPropertyValue('--cc-page').trim()) ?? { r: 0, g: 0, b: 0, a: 1 };
      const failures: Array<{ where: string; text: string; ratio: number; needed: number }> = [];
      let skipped = 0;
      document.querySelectorAll<HTMLElement>('ion-modal.manual-sheet *').forEach((element) => {
        if (![...element.childNodes].some((node) => node.nodeType === 3 && (node.textContent ?? '').trim())) return;
        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return;
        const style = getComputedStyle(element);
        if (style.visibility === 'hidden' || style.opacity === '0') return;
        const color = parse(style.color);
        if (!color || color.a === 0) return;
        // 뒤에 있는 배경을 실제로 겹쳐서 계산한다. 그라데이션 뒤의 글자는 잴 수 없으므로 센다.
        const layers: Rgba[] = [];
        let node: HTMLElement | null = element;
        let unknown = false;
        while (node && node !== document.documentElement) {
          const nodeStyle = getComputedStyle(node);
          if (nodeStyle.backgroundImage.includes('gradient')) { unknown = true; break; }
          const background = parse(nodeStyle.backgroundColor);
          if (background && background.a > 0) { layers.push(background); if (background.a === 1) break; }
          node = node.parentElement;
        }
        if (unknown) { skipped += 1; return; }
        let background = page;
        for (let index = layers.length - 1; index >= 0; index -= 1) background = over(layers[index], background);
        const size = parseFloat(style.fontSize);
        const large = size >= 24 || (size >= 18.66 && parseInt(style.fontWeight, 10) >= 700);
        const needed = large ? 3 : 4.5;
        const measured = ratio(over(color, background), background);
        if (measured < needed) {
          failures.push({
            where: `${element.tagName.toLowerCase()}.${String(element.className || '').split(' ').slice(0, 2).join('.')}`,
            text: (element.textContent ?? '').trim().slice(0, 24),
            ratio: Math.round(measured * 100) / 100,
            needed,
          });
        }
      });
      return { failures, skipped };
    });

    expect(swept.failures, `다크 모드에서 읽기 어려운 글자: ${JSON.stringify(swept.failures)}`).toEqual([]);
    // 잴 수 없는 요소가 너무 많으면 이 게이트는 아무것도 보증하지 못한다.
    expect(swept.skipped, '시트에서 대비를 잴 수 없는 요소가 너무 많다').toBeLessThan(5);
  } finally {
    await stopServer(server);
  }
});

test('키보드와 낭독기만으로 열고 쓰고 닫을 수 있다', async ({ page }) => {
  const { server, origin } = await serverOrigin();
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page, origin);

    // 접근 이름이 없으면 낭독기 사용자에게는 존재하지 않는 버튼이다.
    const trigger = page.getByRole('button', { name: '직접 입력' });
    await trigger.focus();
    await expect(trigger).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('ion-modal.manual-sheet')).toBeVisible();
    // 시트가 `보인다`와 그 안의 칸이 실제로 붙는 것은 다른 순간이다. 여기 있던 고정
    // `waitForTimeout(400)`은 이 저장소가 이미 한 번 원인으로 확정한 것과 같은 모양이다 —
    // 시트가 열리고 정착하기까지 400~600ms라 그 경계 위에서는 같은 코드가 기계 속도에 따라
    // 어떤 판은 붙은 칸을, 어떤 판은 아직 없는 칸을 잰다(RELEASE.md v2.25.0). 실제로 CI에서
    // `입력 칸에 접근 이름이 없다`로 걸렸고, 같은 판이 이 PC에서는 통과했다.
    // 시간이 아니라 상태로 기다린다. 칸이 끝내 안 붙으면 여기서 걸린다 — 게이트는 약해지지 않는다.
    await expect(
      page.locator('ion-modal.manual-sheet ion-textarea'),
      '시트는 열렸는데 입력 칸이 붙지 않았다',
    ).toBeAttached();
    // 접근 이름은 칸이 붙는 순간에는 아직 없다. 50ms 간격 실측으로 확인한 모양:
    // t=0~150ms `aria-label`은 null, t=200ms에 `이 사람에 대해 아는 내용`이 붙고 그 뒤로 안 바뀐다.
    // 여기 있던 고정 `waitForTimeout(400)`은 이 PC에서만 그 200ms를 넘겼다. CI는 같은 스위트를
    // 도는 데 약 3.3배(2.9분 → 9.7분) 걸려 400ms 안에 못 붙었고 `입력 칸에 접근 이름이 없다`로
    // 걸렸다 — 제품은 멀쩡한데 게이트가 시간으로 재고 있었다. 이 저장소가 이미 한 번 원인으로
    // 확정한 것과 같은 모양이다(RELEASE.md v2.25.0의 작성 box 게이트).
    // 이제 시간이 아니라 상태로 기다린다. 이름이 끝내 안 붙으면 여기서 timeout으로 걸리므로
    // 게이트는 약해지지 않는다 — 아래 세 단언이 판정을 그대로 소유한다.
    await expect
      .poll(
        () => page.evaluate(() => document
          .querySelector('ion-modal.manual-sheet')
          ?.querySelector('ion-textarea')
          ?.getAttribute('aria-label')?.length ?? 0),
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);

    const named = await page.evaluate(() => {
      const modal = document.querySelector('ion-modal.manual-sheet');
      const field = modal?.querySelector('ion-textarea');
      return {
        modalLabel: modal?.getAttribute('aria-label') ?? '',
        fieldLabel: field?.getAttribute('aria-label') ?? '',
        liveRegions: modal ? modal.querySelectorAll('[role="status"], [aria-live]').length : 0,
      };
    });
    expect(named.modalLabel.length, '시트에 접근 이름이 없다').toBeGreaterThan(0);
    expect(named.fieldLabel.length, '입력 칸에 접근 이름이 없다').toBeGreaterThan(0);
    expect(named.liveRegions, '상태 변화를 낭독기에 알리는 자리가 없다').toBeGreaterThan(0);
  } finally {
    await stopServer(server);
  }
});
