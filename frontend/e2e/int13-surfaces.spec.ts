// INT-000013 회귀 게이트: 상단 바(ISS-000084), 자연어 회상 검색(ISS-000103),
// 기기 갤러리 정책(ISS-000102), 인물 전문의 `지금 알아둘 것`.
// Kairen-Ref: TSK-000220, TSK-000249, TSK-000250
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

const personFixture = [
  '---',
  'name: 김민서',
  'title: 구매팀장',
  'organization: 한화시스템',
  'last_contacted: 2026-07-22',
  '---',
  '# 김민서',
  '',
  '## Summary',
  '자동화 라인 부품 국산화를 검토 중인 구매 담당자.',
  '',
  '## 최근 활동 (90일)',
  '- 2026-06 스마트팩토리 세미나에서 국산 부품 검증 기준을 발표했다.',
  '',
  '## 대화 포인트',
  '- 국산화 파일럿의 검증 기간을 줄이는 방법에 관심이 있다.',
].join('\n');

// `지난주`는 요일에 따라 창이 통째로 움직인다. "8일 전"처럼 고정 일수로 두면 주가 넘어가는 날
// (일→월) 창 밖으로 밀려 이 게이트가 날짜 때문에 빨개진다 — 2026-07-27에 실제로 그렇게 됐다.
// 주 시작(월요일)을 기준으로 그 주의 금요일을 잡아 어느 요일에 돌려도 같은 구간에 들어오게 한다.
function weeksBack(weeks: number): string {
  const monday = new Date();
  monday.setHours(9, 0, 0, 0);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const friday = new Date(monday);
  friday.setDate(friday.getDate() - weeks * 7 + 4);
  return friday.toISOString();
}

function listFixture() {
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: false,
    items: [
      {
        captureId: '20260718-090000-a1', receivedAt: weeksBack(1), status: 'processed', person: 'PER-000001', capturer: '이강규', event: '2026 로보월드',
        contact: { name: '김민서', title: '구매팀장', organization: '한화시스템' },
        brief: '# 김민서 — 이런 분이에요\n자동화 라인 부품 국산화를 검토 중입니다.',
      },
      {
        captureId: '20260715-140000-a2', receivedAt: weeksBack(2), status: 'processed', person: 'PER-000002', capturer: '이강규', event: '판교 밋업',
        contact: { name: '박지훈', title: 'CTO', organization: '넥스트로보' },
        brief: '# 박지훈 — 이런 분이에요\n로봇 제어 소프트웨어 창업자입니다.',
      },
      { captureId: '20260726-100000-a3', receivedAt: ago(9), status: 'received', quickName: { name: '정하늘', source: 'device_ppocr', confidence: 71, confirmed: false, recognizedAt: ago(9) } },
    ],
  };
}

interface Harness {
  server: Server;
  port: number;
  requests: string[];
}

async function boot(page: import('@playwright/test').Page, options: { fakeCamera?: boolean } = {}): Promise<Harness> {
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
    if (action === 'doc' || action === 'persondoc') { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, markdown: personFixture }) }); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  await page.addInitScript((useCamera) => {
    localStorage.setItem('cc_name', '이강규');
    if (!useCamera) return;
    // 실제 MediaStream이어야 앱의 카메라 경로(video.play·videoWidth)가 그대로 돈다.
    localStorage.setItem('cc_autoCapture', 'off');
    const canvas = document.createElement('canvas');
    canvas.width = 720;
    canvas.height = 1280;
    const context = canvas.getContext('2d')!;
    const draw = () => { context.fillStyle = '#9aa7b5'; context.fillRect(0, 0, canvas.width, canvas.height); };
    draw();
    window.setInterval(draw, 120);
    const stream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(30);
    const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: Object.assign(Object.create(Object.getPrototypeOf(mediaDevices) ?? Object.prototype), mediaDevices, {
        getUserMedia: async () => stream,
        enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'fake', label: 'fake', groupId: 'fake' }],
      }),
    });
  }, options.fakeCamera === true);

  await page.setViewportSize({ width: 390, height: 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token`, { waitUntil: 'networkidle' });
  return { server, port: address.port, requests };
}

// ISS-000084: 상단 바가 제품 이름만 띄우고 화면마다 큰 제목을 또 그리면, 폰 화면 위쪽이 제목 두 줄로 낭비된다.
// ISS-000050(INT-000025): 갱신 조작은 화면마다 하나뿐이고 이름은 승인 문구 `새로고침` 하나다.
// v2.20.0에는 같은 `manualRefresh()`를 부르는 버튼이 네 화면에 여섯 개 있었고, 이 게이트는
// 실제로 쓰이지 않는 옛 class 이름(`.activity-refresh`·`.refresh-chip`)만 세고 있어 통과했다.
test('the top bar owns the screen name and live status, and each list screen has exactly one refresh', async ({ page }) => {
  const harness = await boot(page);
  try {
    const header = page.locator('ion-header .app-header');
    await expect(header.locator('b')).toHaveText('명함 캡처');
    // 화면 본문에는 제목 블록이 하나도 없다 — 제목 영역은 상단 바 하나뿐이다.
    expect(await page.locator('#kairen-ui h1').count()).toBe(0);

    await page.getByRole('button', { name: '진행', exact: true }).click();
    await expect(header.locator('b')).toHaveText('처리 진행');
    await expect(header.locator('small')).toHaveText(/1건 처리 중/);
    expect(await page.locator('#kairen-ui h1').count()).toBe(0);

    // 갱신할 목록을 가진 화면은 새로고침을 **정확히 하나** 갖는다. 상단 바는 갱신을 소유하지 않는다.
    expect(await page.locator('.refresh-control').count()).toBe(1);
    expect(await page.locator('ion-header .header-refresh').count()).toBe(0);
    const before = harness.requests.filter((entry) => entry.includes('action=list')).length;
    await page.getByRole('button', { name: /새로고침/ }).click();
    await expect.poll(() => harness.requests.filter((entry) => entry.includes('action=list')).length).toBeGreaterThan(before);
    expect(await page.locator('.activity-refresh, .refresh-chip').count()).toBe(0);

    await page.getByRole('button', { name: '캡처', exact: true }).click();
    expect(await page.locator('.refresh-control').count()).toBe(1);

    await page.getByRole('button', { name: '설정', exact: true }).click();
    await expect(header.locator('b')).toHaveText('내 앱 설정');
    // 설정 화면에는 새로고침할 목록이 없으므로 버튼도 없다.
    expect(await page.getByRole('button', { name: /새로고침/ }).count()).toBe(0);
    expect(await page.locator('.refresh-control').count()).toBe(0);
  } finally {
    harness.server.close();
  }
});

// ISS-000103: 불완전한 기억을 문장으로 말해 사람을 찾고, 왜 그 사람인지 근거를 본다.
test('recall search turns a spoken memory into evidence, and never invents unrecorded traits', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '검색', exact: true }).click();
    // 기존 빠른 검색 경로는 그대로 남아 있다.
    await expect(page.getByRole('tab', { name: '빠른 검색' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('textbox').fill('한화');
    await page.getByRole('button', { name: '찾기' }).click();
    await expect.poll(() => harness.requests.some((entry) => entry.includes('action=search') && entry.includes('q=%ED%95%9C%ED%99%94'))).toBe(true);

    const sentence = '지난주쯤 만났던 사람인데 여자였고 한화 다니던 구매팀장이었어';
    await page.getByRole('tab', { name: 'AI 사람 찾기' }).click();
    await page.getByRole('textbox').fill(sentence);
    await page.getByRole('button', { name: '찾기' }).click();

    const card = page.locator('.recall-card').first();
    await expect(card.getByText('김민서')).toBeVisible();
    // 후보마다 시점·소속 근거가 함께 보인다.
    await expect(card.getByText(/만난 시점 .* '지난주.*' 안/)).toBeVisible();
    await expect(card.getByText(/소속 한화시스템 · '한화' 일치/)).toBeVisible();
    // 지난주 밖에서 만난 사람은 후보에 들어오지 않는다.
    await expect(page.locator('.recall-card')).toHaveCount(1);
    // 기록하지 않는 속성은 조용히 버리지 않고 "쓰지 않았다"고 말한다.
    await expect(page.getByText(/성별은 명함 기록에 남기지 않아 조건으로 쓰지 않았어요/)).toBeVisible();
    // 문장 자체는 절대 서버로 나가지 않는다 (기기 안 대조 계약).
    expect(harness.requests.some((entry) => entry.includes(encodeURIComponent(sentence)) || entry.includes(sentence))).toBe(false);
  } finally {
    harness.server.close();
  }
});

// 피드백 005: 전문을 읽기 전 1~3줄. 기록에 있는 문장만 인용하고 어느 섹션에서 왔는지 밝힌다.
test('the person profile leads with cited highlights', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.getByRole('button', { name: '진행', exact: true }).click();
    // 목록 제목은 '이름 — 한 줄 요약'이다 (TSK-000246).
    await page.locator('.brief-summary').filter({ hasText: '김민서' }).click();
    await page.getByRole('button', { name: '전체 프로필' }).click();

    const now = page.locator('.now-card');
    await expect(now.getByText('지금 알아둘 것')).toBeVisible();
    await expect(now.getByText(/국산 부품 검증 기준을 발표했다/)).toBeVisible();
    await expect(now.getByText(/기록의 “최근 활동 \(90일\)”에서 그대로 가져왔어요/)).toBeVisible();
    await expect(now.getByText(/2026-07-22 기준 기록이에요/)).toBeVisible();
    // 인용은 최대 3줄이고, 근거 없는 문장을 만들어 채우지 않는다.
    expect(await now.locator('li').count()).toBeLessThanOrEqual(3);
  } finally {
    harness.server.close();
  }
});

// ISS-000102: 기본 카메라 앱만이 갤러리 사본을 만든다. 기본값은 그 경로를 평상시 동선에서 뺀다.
test('the camera keeps photos out of the phone gallery unless the owner opts in', async ({ page }) => {
  const harness = await boot(page, { fakeCamera: true });
  try {
    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    const camera = page.locator('ion-modal.camera-preview-modal');
    await expect(camera.getByText('여기서 찍은 사진은 휴대폰 갤러리에 저장되지 않아요.')).toBeVisible();
    expect(await camera.getByRole('button', { name: /기본 카메라 앱으로 찍기/ }).count()).toBe(0);
    await camera.getByRole('button', { name: '닫기' }).click();

    // 끄면 다시 쓸 수 있지만, 갤러리에 남는다는 사실이 버튼에 그대로 붙는다.
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('checkbox', { name: /기본 카메라 앱 쓰지 않기/ }).uncheck();
    await expect(page.getByText(/그 사진은 갤러리에 남고 카이렌이 지울 수 없습니다/)).toBeVisible();
    await page.getByRole('button', { name: '캡처', exact: true }).click();
    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    await expect(camera.getByRole('button', { name: /기본 카메라 앱으로 찍기 · 갤러리에 남아요/ })).toBeVisible();
  } finally {
    harness.server.close();
  }
});
