// ISS-000091 회귀 복원 게이트: legacy 파리티가 다시 깨지면 여기서 잡힌다.
// Kairen-Ref: TSK-000222, TSK-000223
import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

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
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream',
      });
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

function stopStaticServer(server: Server): Promise<void> {
  return new Promise((resolveStop, reject) => {
    server.close((error) => error ? reject(error) : resolveStop());
    server.closeAllConnections();
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cc_name', 'E2E Owner'));
  // 카메라 외 검증에서는 앱 유휴 프리로드(OpenCV WASM·Tesseract 모델)를 차단한다 —
  // 실제 자산 컴파일이 메인 스레드를 점유해 클릭 안정성 판정이 흔들린다.
  // service worker fetch까지 잡으려면 context 레벨이어야 한다 (page.route는 SW 요청을 못 잡는다).
  await page.context().route('**/vendor/**', (route) => route.abort());
});

const processedBrief = [
  '# 이런 분이에요 — Alice Kim',
  '협력 논의를 진행한 담당자입니다.',
  '',
  '## 핵심 이력',
  '| 기간 | 소속 |',
  '| --- | --- |',
  '| 2019–현재 | Acme\\|KR |',
  '',
  '- 관심사: 부품 국산화',
].join('\n');

function listFixture(receivedAtLate: string, receivedAtStage2: string) {
  return {
    ok: true,
    seeAll: true,
    researchInstructionEnabled: true,
    hasMore: false,
    items: [
      {
        captureId: '20260726-090000-e2e1',
        receivedAt: receivedAtLate,
        status: 'processed',
        person: 'PER-000001',
        capturer: 'E2E Owner',
        event: 'Expo',
        // contact 없음 — 본문 연락처 추출 폴백을 검증한다.
        brief: `${processedBrief}\n연락: alice@example.com / 010-1234-5678`,
      },
      {
        captureId: '20260726-100000-e2e2',
        receivedAt: receivedAtStage2,
        status: 'received',
        quickName: { name: 'Bob Lee', source: 'device_tesseract', confidence: 70, confirmed: false, recognizedAt: receivedAtStage2 },
      },
      {
        captureId: '20260726-080000-e2e3',
        receivedAt: receivedAtLate,
        status: 'processed',
        type: 'note',
        person: 'PER-000001 Alice Kim',
      },
    ],
  };
}

test('renders brief markdown, extracted contacts, staged progress and legacy titles', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const receivedAtLate = new Date(Date.now() - 130 * 60_000).toISOString();
  const receivedAtStage2 = new Date(Date.now() - 8 * 60_000).toISOString();

  await page.route('https://api.example.test/**', async (route) => {
    const action = new URL(route.request().url()).searchParams.get('action');
    if (action === 'list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(listFixture(receivedAtLate, receivedAtStage2)) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [] }) });
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token&view=briefs`, { waitUntil: 'networkidle' });

    // 제목이 뒤집혀 도착해도 이름을 먼저 뽑아 낸다 (계약 규칙 9). 목록 표시는 "이름 — 한 줄 요약"이다.
    await expect(page.getByRole('button', { name: /^Alice Kim — / })).toBeVisible();
    await expect(page.getByText('Alice Kim — 이런 분이에요'), '목록은 고정 문구 대신 요약을 보여 준다').toHaveCount(0);
    // note receipt는 legacy처럼 "메모 → 대상"으로 표시된다.
    await expect(page.getByText('메모 → PER-000001 Alice Kim')).toBeVisible();
    // 2단계 진행 문구는 경과와 잔여 추정을 함께 보여준다.
    await expect(page.getByText(/2\/3단계 웹 조사·기록 정리 중 \(이름 인식 ✓\) · 8분 경과 · 완료까지 약 6분 남음/)).toBeVisible();

    await page.getByRole('button', { name: /^Alice Kim — / }).click();
    // 마크다운이 원문 덤프가 아니라 실제 표·불릿으로 렌더링된다 (escaped pipe 포함).
    await expect(page.locator('.md-table-wrap table')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Acme|KR' })).toBeVisible();
    await expect(page.getByText('• 관심사: 부품 국산화')).toBeVisible();
    expect(await page.locator('.brief-detail pre').count()).toBe(0);
    // 서버 contact 요약이 없어도 본문에서 연락처를 추출한다.
    await expect(page.getByRole('link', { name: '전화' })).toHaveAttribute('href', 'tel:010-1234-5678');
    await expect(page.getByRole('link', { name: '메일' })).toHaveAttribute('href', 'mailto:alice@example.com');
  } finally {
    await stopStaticServer(server);
  }
});

test('keeps background refresh silent on network failure and maps errors on manual refresh', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  await page.route('https://api.example.test/**', (route) => route.abort('connectionrefused'));

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=owner-token&view=briefs`, { waitUntil: 'networkidle' });
    // 초기(배경) 새로고침 실패는 토스트를 띄우지 않는다 — 행사장 오프라인 스팸 방지.
    await page.waitForTimeout(1_200);
    expect(await page.evaluate(() => document.querySelector('ion-toast')?.getAttribute('is-open'))).not.toBe('true');
    // 수동 새로고침은 한글로 안내한다.
    await page.getByRole('button', { name: '상태 새로고침' }).click();
    await expect(page.getByText(/새로고침 실패: 네트워크 오류/)).toBeVisible();
  } finally {
    await stopStaticServer(server);
  }
});

test('merges local capture context into the brief card with instant note and edit', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const receivedAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const noteBodies: Array<Record<string, unknown>> = [];

  await page.route('https://api.example.test/**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}') as Record<string, unknown>;
      if (body.action === 'addnote') noteBodies.push(body);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true,
      seeAll: false,
      items: [{ captureId: '20260726-090000-q1', receivedAt, status: 'processed', person: 'PER-000002', brief: '# Carol Choi — 이런 분이에요\n담당자입니다.' }],
    }) });
  });

  await page.addInitScript(() => {
    const open = indexedDB.open('cardcapture', 1);
    open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains('q')) open.result.createObjectStore('q', { keyPath: 'captureId' }); };
    open.onsuccess = () => {
      const database = open.result;
      const transaction = database.transaction('q', 'readwrite');
      transaction.objectStore('q').put({
        captureId: '20260726-090000-q1',
        capturedAt: '2026-07-26T00:00:00.000Z',
        event: 'Expo',
        relSelf: '오늘 인사',
        relKairen: '잠재 고객',
        memo: '',
        note: '나와의 관계: 오늘 인사\nKairen과의 관계: 잠재 고객',
        images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: '/9j/4AAQ' }],
        quickName: null,
        researchInstruction: null,
        state: 'sent',
        tries: 0,
        thumb: '',
      });
      transaction.oncomplete = () => database.close();
    };
  });

  try {
    const api = encodeURIComponent('https://api.example.test/exec');
    await page.goto(`http://127.0.0.1:${address.port}/next/?api=${api}&k=guest-token&view=briefs`, { waitUntil: 'networkidle' });
    // 실폰 피드백 2: 같은 captureId의 로컬 캡처와 브리핑이 하나의 카드로 통합된다.
    await expect(page.locator('.queue-row')).toHaveCount(0);
    const card = page.locator('.brief-card', { hasText: 'Carol Choi — 담당자입니다.' });
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: /Carol Choi/ }).click();
    // 통합 카드가 내 맥락(만난 곳·관계)과 캡처 수정 진입을 함께 보여준다.
    await expect(card.getByText('내 기록: Expo · Kairen: 잠재 고객 · 나: 오늘 인사')).toBeVisible();
    await expect(card.getByRole('button', { name: '캡처 수정' })).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept('후속 미팅 잡기'));
    await card.getByRole('button', { name: '메모 추가' }).click();
    await expect.poll(() => noteBodies.length).toBe(1);
    expect(noteBodies[0]).toMatchObject({ action: 'addnote', captureId: '20260726-090000-q1', text: '후속 미팅 잡기' });
  } finally {
    await stopStaticServer(server);
  }
});

test('restores the legacy one-screen capture surface and link-first onboarding', async ({ page }) => {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');

  try {
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });

    // 촬영·맥락·완료가 한 화면에: 필드는 촬영 전에도 보이고 완료는 잠겨 있다.
    await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
    await expect(page.locator('.search-shortcut')).toHaveCount(0);
    await expect(page.getByLabel('어디서 만났는지 (선택, 2시간 유지)')).toBeVisible();
    await expect(page.getByLabel('메모 (선택 — 키보드 마이크로 말해도 돼요)')).toBeVisible();
    await expect(page.getByRole('button', { name: '완료', exact: true })).toBeDisabled();
    // 토큰이 없으면 legacy처럼 개인 링크 안내 배너가 뜬다.
    await expect(page.getByText(/받으신 개인 링크\(\?k=토큰 포함\)로 접속해 주세요/)).toBeVisible();

    // 최근 캡처·브리핑 섹션이 같은 스크롤에 있고 접기 상태가 legacy 키로 저장된다.
    const recordsToggle = page.getByRole('button', { name: /명함 기록/ });
    await expect(recordsToggle).toBeVisible();
    await expect(page.getByText('아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.')).toBeVisible();
    await recordsToggle.click();
    await expect(page.getByText('아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('cc_collapse_briefs'))).toBe('1');
    await recordsToggle.click();
    await expect(page.getByText('아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.')).toBeVisible();

    // 설정: 주소·토큰은 고급 항목 뒤에 숨고 토큰 라벨이 개인 링크 안내로 바뀐다.
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    await page.getByRole('button', { name: '이름·연결 설정 편집' }).click();
    await expect(page.getByLabel('촬영자 이름')).toBeVisible();
    await expect(page.getByLabel('개인 링크 토큰 (?k= 값)')).toBeHidden();
    await page.getByRole('button', { name: /고급 — 직접 연결 설정/ }).click();
    await expect(page.getByLabel('개인 링크 토큰 (?k= 값)')).toBeVisible();
  } finally {
    await stopStaticServer(server);
  }
});
