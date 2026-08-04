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
  /* 카메라가 **있는** 기기라고 못 박는다 (TSK-000220 / INT-000030).
     legacy 파리티는 "한 화면에 촬영·맥락·완료가 같이 있다"는 사실을 잰다. 촬영 입구의 모양은 이제
     기기 능력이 정하므로(`services/device-capability.ts`), 선언하지 않으면 웹캠 없는 기계에서
     파리티 판정이 조용히 다른 화면을 보게 된다. */
  await page.addInitScript(() => {
    const media = navigator.mediaDevices;
    if (!media) return;
    media.enumerateDevices = async () => [{ kind: 'videoinput', deviceId: '', label: '', groupId: '', toJSON: () => ({}) } as MediaDeviceInfo];
  });
});

const processedBrief = [
  '# 이런 분이에요 — Alice Kim',
  '협력 논의를 진행한 담당자입니다.',
  '[회사 홈페이지](https://acme.example/about)',
  '',
  '## 핵심 이력',
  '| 기간 | 소속 | 근거 |',
  '| --- | --- | --- |',
  '| 2019–현재 | Acme\\|KR | [수상 평가](https://awards.example/alice) |',
  '',
  '- 관심사: 부품 국산화 · LinkedIn: https://www.linkedin.com/in/alice-kim',
].join('\n');

const personDocumentFixture = [
  '---',
  'name: Alice Kim',
  'title: VP',
  'organization: Acme',
  'emails:',
  '  - alice@example.com',
  'phones:',
  '  - 010-1234-5678',
  'urls:',
  '  - "LinkedIn: https://www.linkedin.com/in/alice-kim"',
  'source_refs:',
  '  - "회사: https://acme.example/about"',
  '---',
  '# Alice Kim',
  '- 공식 소개: [Acme 리더십](https://acme.example/leadership)',
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
    if (action === 'doc' || action === 'persondoc') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, markdown: personDocumentFixture }) });
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
    // 서버가 실제로 증명한 상태와 관측 경과만 보여 준다 (DEC-000092).
    // 예전에는 `약 N분 남음 · 보통 6~20분`까지 적었는데 그 범위는 관측이 아니라 하드코딩이었고,
    // 기기에 미리 채워진 quickName을 **서버 처리 단계의 증거로 오인**해 한 단계를 앞질러 표시했다.
    // 남은 시간을 모를 때는 모른다고 말한다 — 지어낸 정밀도가 이 화면의 신뢰를 깎던 원인이다.
    await expect(page.getByText('서버가 접수했어요')).toBeVisible();
    await expect(page.getByText('8분 경과 · 남은 시간은 아직 알 수 없어요')).toBeVisible();
    await expect(page.locator('.stage-dots li.stage-active').first()).toHaveText('서버 접수');

    await page.getByRole('button', { name: /^Alice Kim — / }).click();
    // 마크다운이 원문 덤프가 아니라 실제 표·불릿으로 렌더링된다 (escaped pipe 포함).
    await expect(page.locator('.md-table-wrap table')).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Acme|KR' })).toBeVisible();
    await expect(page.getByText(/관심사: 부품 국산화/)).toBeVisible();
    expect(await page.locator('.brief-detail pre').count()).toBe(0);
    // 홈페이지·LinkedIn·표 안 근거 링크는 안전한 새 탭 링크로 열린다.
    await expect(page.getByRole('link', { name: /회사 홈페이지/ })).toHaveAttribute('href', 'https://acme.example/about');
    await expect(page.getByRole('link', { name: /수상 평가/ })).toHaveAttribute('href', 'https://awards.example/alice');
    await expect(page.getByRole('link', { name: /https:\/\/www\.linkedin\.com\/in\/alice-kim/ })).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('link', { name: /회사 홈페이지/ })).toHaveAttribute('rel', /noopener/);
    // 서버 contact 요약이 없어도 본문에서 연락처를 추출한다.
    await expect(page.getByRole('link', { name: '전화' })).toHaveAttribute('href', 'tel:010-1234-5678');
    await expect(page.getByRole('link', { name: '메일' })).toHaveAttribute('href', 'mailto:alice@example.com');
    // 액션은 임의의 단일 primary 없이 연락·기록·관리로 구분된다.
    await expect(page.getByText('연락', { exact: true })).toBeVisible();
    await expect(page.getByText('기록', { exact: true })).toBeVisible();
    await expect(page.getByText('관리', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '메모 추가' })).not.toHaveClass(/primary/);

    await page.getByRole('button', { name: '전체 프로필' }).click();
    const profile = page.locator('ion-modal').filter({ hasText: 'Alice Kim' });
    await expect(profile.getByText('바로가기', { exact: true })).toBeVisible();
    await expect(profile.getByRole('link', { name: /LinkedIn/ })).toHaveAttribute('href', 'https://www.linkedin.com/in/alice-kim');
    await expect(profile.getByRole('link', { name: /Acme 리더십/ })).toHaveAttribute('target', '_blank');
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
    /* 배경(자동) 갱신 실패는 아무것도 띄우지 않는다 — 행사장 오프라인 스팸 방지.
       예전에는 `is-open` **속성**을 읽었는데, Ionic React는 `isOpen`을 DOM property로만
       넘기므로 그 속성은 토스트가 떠 있어도 없다. 속성만 보는 단언은 토스트가 세 장 떠 있어도
       통과한다 — 그려진 상자를 직접 본다 (TSK-000559). */
    const openToasts = () => page.evaluate(() => Array.from(document.querySelectorAll('ion-toast'))
      .filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.classList.contains('overlay-hidden');
      })
      .map((node) => String((node as HTMLElement & { message?: string }).message ?? node.textContent ?? '').trim()));
    await page.waitForTimeout(1_200);
    expect(await openToasts(), '배경 갱신 실패가 토스트를 띄웠다').toEqual([]);

    /* 수동 새로고침의 실패도 토스트가 아니다 (INT-000036 / TSK-000559).
       founder 판정: "눌렀을 때 새로고침 중이라고 뭔가 위에서 내려오는데, 이거 굳이 있어야
       되나 싶어." 안내는 갱신 조작 바로 옆에 남고, 2.6초 뒤 사라지지 않는다 — 사용자가
       조치해야 하는 사실에 토스트 수명을 주면 그 사실은 전달되지 않는다. */
    await page.getByRole('button', { name: '최신 상태 확인', exact: true }).click();
    const notice = page.locator('.int30-refresh-notice');
    await expect(notice).toBeVisible({ timeout: 8_000 });
    await expect(notice, '실패의 원인 갈래를 한글로 말하지 않는다').toContainText('네트워크 오류');
    await expect(notice.getByRole('button', { name: '다시 시도' })).toBeVisible();
    // 토스트 수명(2.6초)을 넘겨도 남아 있고, 토스트는 끝까지 한 장도 뜨지 않는다.
    await page.waitForTimeout(3_200);
    await expect(notice).toBeVisible();
    expect(await openToasts(), '수동 갱신 실패가 토스트를 띄웠다').toEqual([]);
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
    await card.getByRole('button', { name: '메모 추가' }).click();
    const composer = page.locator('ion-modal.person-action-modal');
    await expect(composer.getByText('다음 만남에 기억하고 싶은 사실이나 약속을 남겨주세요.')).toBeVisible();
    await composer.locator('ion-textarea[aria-label="메모 추가"] textarea').fill('후속 미팅 잡기');
    await composer.getByRole('button', { name: '메모 저장' }).click();
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

    // 촬영·맥락·완료가 한 화면에: 맥락 필드는 촬영 전에도 보이고 완료는 잠겨 있다.
    await expect(page.getByRole('button', { name: '명함 앞면 촬영' })).toBeVisible();
    await expect(page.locator('.search-shortcut')).toHaveCount(0);
    // 이름 온보딩 모달이 떠 있는 상태라 role 조회는 aria-hidden 때문에 간헐적으로 빈다.
    await expect(page.locator('ion-input[aria-label="어디서 만났나요?"]')).toBeVisible();
    await expect(page.locator('ion-textarea[aria-label="메모"]')).toBeVisible();
    await expect(page.getByRole('button', { name: '완료', exact: true })).toBeDisabled();
    /* 토큰이 없으면 연결 안내가 뜬다 — 다만 **전면 배너가 아니다** (TSK-000545 / DEC-000105).
       legacy의 `링크 설정이 필요해요` 배너는 화면 맨 위에서 멀쩡히 되는 기능들 위를 덮었고,
       founder가 PC 진입에서 본 결함이 그것이었다. 지켜야 할 계약은 "연결이 없다는 사실과
       그 해결 경로를 화면이 말한다"이지 배너의 자리·모양이 아니므로, 같은 계약을 새 표면에서
       확인한다: 실제로 막힌 기능(명함 기록) 옆의 inline card와 손잡이 하나. */
    await expect(page.getByText('링크 설정이 필요해요')).toHaveCount(0);
    const setupCard = page.getByRole('status', { name: '명함 기록 연결 안내' });
    await expect(setupCard).toBeVisible();
    await expect(setupCard.getByRole('button', { name: '연결 설정 열기' })).toBeVisible();

    // 최근 캡처·브리핑 섹션이 같은 스크롤에 있고 접기 상태가 legacy 키로 저장된다.
    const recordsToggle = page.getByRole('button', { name: /명함 기록/ });
    await expect(recordsToggle).toBeVisible();
    await expect(page.getByText('아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.')).toBeVisible();
    await recordsToggle.click();
    await expect(page.getByText('아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('cc_collapse_briefs'))).toBe('1');
    await recordsToggle.click();
    await expect(page.getByText('아직 명함 기록이 없어요. 명함을 찍으면 여기에 쌓여요.')).toBeVisible();

    // 설정: 이름·연결 주소·개인 링크 코드가 **한 자리**에 있다.
    // 예전에는 이 셋이 시트 + `고급 설정` 접기 뒤에 있었다. DEC-000093(Kairen-Ref: TSK-000532)이
    // 그 뎁스를 없앴다 — 지키는 것은 "어디에 숨었나"가 아니라 "연결 정보가 이 화면에 있는가"다.
    await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
    await expect(page.locator('ion-header .app-header b')).toHaveText('내 앱 설정');
    await expect(page.getByText('개인 링크 정보는 이 기기에만 저장돼요.')).toBeVisible();
    await expect(page.getByLabel('내 이름')).toBeVisible();
    await expect(page.getByLabel('연결 주소')).toBeVisible();
    // 개인 링크 코드는 보이되 눈에 그대로 드러나지 않는다.
    await expect(page.getByLabel('개인 링크 코드')).toHaveAttribute('type', 'password');
    expect(await page.getByRole('button', { name: /고급 설정/ }).count(), '없앤 뎁스가 되살아났다').toBe(0);
  } finally {
    await stopStaticServer(server);
  }
});
