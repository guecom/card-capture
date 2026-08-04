// 설정 화면 회귀 게이트 (ISS-000217 · DEC-000093 — Kairen-Ref: TSK-000532)
//
// founder가 이 화면을 두고 말한 것을 그대로 잠근다:
//   1. 계정·연결에 뎁스가 없다 — 이름·연결 주소·개인 링크 코드가 본문에서 바로 보이고 고쳐진다.
//   2. 알림은 상태 한 줄 · 행동 하나 · 오는 경우만 말한다. 차단이면 **앱 밖의 절차**를 적는다.
//   3. 촬영은 부정형 토글이 아니라 고르는 두 가지 방법이고, 각각의 결과가 붙어 있다.
//   4. 도움말 접기가 없고 버전이 크다.
//   5. 버그 리포트는 메일 **초안**만 연다 — 앱이 아무것도 보내지 않는다.
//
// 그리고 이 화면의 근본 결함이었던 **글자 크기**를 매번 다시 잰다.
// 예전 게이트가 화면이 망가진 채로 계속 통과한 이유는 JSX에 없는 CSS 클래스 이름을 세고 있었기
// 때문이다. 그래서 여기서는 이름이 아니라 **렌더된 글자의 계산된 크기**를 재고, 잰 개수에
// 바닥을 둔다 — 아무것도 훑지 못한 스윕은 통과가 아니라 침묵이다.
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));

/** 설정 화면 글자 크기의 바닥. 이 아래는 폰에서 읽히지 않는다. */
const MIN_FONT_PX = 13;
/** 이만큼도 못 쟀으면 스윕이 아무것도 보증하지 못한 것이다. */
const MIN_SWEPT = 40;

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

interface BootOptions {
  /** 알림 권한을 이 값으로 고정한다. `denied`가 OS 차단 상태다. */
  permission?: NotificationPermission;
  /** 브라우저가 닫힌 앱 알림 자체를 모르는 기기. */
  pushUnsupported?: boolean;
  /** 아직 개인 링크를 받지 못한 새 사용자. */
  connected?: boolean;
  theme?: 'light' | 'dark';
  width?: number;
  height?: number;
}

interface Harness {
  server: Server;
  origin: string;
  /** 앱이 실제로 보낸 요청 전부. 버그 리포트가 아무것도 보내지 않는다는 것을 여기서 판정한다. */
  requests: string[];
}

async function boot(page: Page, options: BootOptions = {}): Promise<Harness> {
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Static server did not expose a TCP port.');
  const origin = `http://127.0.0.1:${address.port}/`;
  const requests: string[] = [];

  await page.context().route('**/vendor/**', (route) => route.abort());
  // 빌드에 박힌 실제 배포본으로는 어떤 요청도 나가지 않는다. `?api=` 없이 여는 경우에 필요하다.
  await page.context().route('https://script.google.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, items: [], seeAll: false }),
  }));
  await page.route('https://api.example.test/**', async (route) => {
    const url = route.request().url();
    requests.push(url);
    const action = new URL(url).searchParams.get('action');
    if (action === 'list') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, seeAll: true, hasMore: false, items: [] }) });
      return;
    }
    // 알림 전송은 아직 준비 전이다 — 결정적인 상태를 얻기 위해 그대로 고정한다.
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, enabled: false, items: [] }) });
  });
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) requests.push(url);
  });

  await page.addInitScript((setup: BootOptions) => {
    localStorage.setItem('cc_name', '이강규');
    if (setup.theme) localStorage.setItem('cc_theme', setup.theme);
    if (setup.permission) {
      Object.defineProperty(Notification, 'permission', { configurable: true, get: () => setup.permission });
    }
    if (setup.pushUnsupported) {
      Reflect.deleteProperty(window, 'PushManager');
    }
  }, options);

  await page.setViewportSize({ width: options.width ?? 390, height: options.height ?? 844 });
  const api = encodeURIComponent('https://api.example.test/exec');
  const query = options.connected === false ? '' : `?api=${api}&k=owner-token`;
  await page.goto(`${origin}next/${query}`, { waitUntil: 'networkidle' });
  return { server, origin, requests };
}

async function openSettings(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: '주요 화면' }).getByRole('button', { name: '설정' }).click();
  await expect(page.getByRole('heading', { name: '계정·연결' })).toBeVisible();
}

/**
 * 접힌 지원 진입을 연다 (INT-000030 · Kairen-Ref: TSK-000544).
 *
 * DEC-000105이 진단·버그 리포트를 `앱 정보·지원` 안의 접힌 자리로 옮겼다. 접은 이유는 감추기
 * 위해서가 아니라 **막히지 않은 날에는 필요 없는 것**이기 때문이다. 아래 제보 관련 게이트가
 * 지키는 계약(초안만 연다 · 아무것도 보내지 않는다 · 자격 정보가 실리지 않는다)은 그대로이고,
 * 그 자리에 닿는 방법만 한 단계 늘었다.
 */
async function openSupport(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /문제가 생겼을 때/ });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

// ── 001: 글자 크기 (이 화면의 근본 결함) ──
//
// 예전 감사에서 설정의 57개 텍스트 요소 중 46개가 12.5px 이하였다. 원인은 Ionic 전역
// `small { font-size: 75% }` 와 크기를 지정하지 않은 `<p>`·`<button>` 이었다.
// 이 게이트는 클래스 이름이 아니라 **렌더된 글자**를 잰다 — JSX에 없는 이름을 세다가
// 화면이 망가진 채로 통과하던 예전 게이트의 실패를 반복하지 않기 위해서다.
const READABILITY_SWEEP = `(() => {
  function* walk(root) {
    for (const element of root.querySelectorAll('*')) {
      yield element;
      if (element.shadowRoot) yield* walk(element.shadowRoot);
    }
  }
  const scope = document.querySelector('#kairen-ui');
  if (!scope) return { error: 'no-scope', findings: [], swept: 0 };
  const findings = [];
  let swept = 0;
  for (const element of walk(scope)) {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const tag = element.tagName;
    const control = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    // 이 요소가 **직접** 담고 있는 글자만 본다. 자식이 그리는 글자는 자식이 자기 크기로 책임진다.
    const own = Array.from(element.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .join('');
    if (!own && !control) continue;
    swept += 1;
    const size = parseFloat(style.fontSize);
    if (!Number.isFinite(size) || size < ${MIN_FONT_PX}) {
      const name = tag.toLowerCase() + (element.className ? '.' + String(element.className).split(' ')[0] : '');
      findings.push({ where: name, size: style.fontSize, text: (own || '(입력 칸)').slice(0, 20) });
    }
  }
  return { error: '', findings, swept };
})()`;

test('설정 화면의 모든 글자가 폰에서 읽을 수 있는 크기다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);
    // INT-000030에서 진단·제보가 접힌 자리로 들어갔다. 접힌 글은 `display: none`이라 스윕이
    // 아예 보지 못한다 — **재지 못한 곳은 통과한 곳이 아니다.** 그래서 먼저 열고 잰다.
    // (열면 닫힌 상태의 모든 글도 그대로 남으므로 이 한 번의 스윕이 더 넓다.)
    await openSupport(page);
    const swept = await page.evaluate(READABILITY_SWEEP) as { error: string; findings: unknown[]; swept: number };

    expect(swept.error).toBe('');
    expect(swept.findings, `설정 화면에 ${MIN_FONT_PX}px 미만인 글자가 있다: ${JSON.stringify(swept.findings)}`).toEqual([]);
    // 아무것도 훑지 못한 스윕은 통과가 아니라 침묵이다.
    expect(swept.swept, `설정 화면에서 잰 요소가 너무 적다 (${swept.swept}개)`).toBeGreaterThanOrEqual(MIN_SWEPT);
  } finally {
    harness.server.close();
  }
});

// ── 002: 계정·연결에 뎁스가 없다 ──

test('이름·연결 주소·개인 링크 코드가 한 자리에서 보이고 저장된다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);

    // 사라진 뎁스가 되살아나면 여기서 잡힌다.
    expect(await page.getByRole('button', { name: '사용자·연결 정보 편집' }).count(), '없앤 뎁스가 되살아났다').toBe(0);
    expect(await page.getByRole('button', { name: /고급 설정/ }).count(), '없앤 고급 설정 접기가 되살아났다').toBe(0);
    expect(await page.getByRole('button', { name: /이 앱이 어떻게 동작하는지/ }).count(), '없앤 도움말 접기가 되살아났다').toBe(0);

    // 세 값이 한 화면에 함께 있다.
    await expect(page.getByLabel('내 이름')).toBeVisible();
    await expect(page.getByLabel('연결 주소')).toBeVisible();
    await expect(page.getByLabel('개인 링크 코드')).toBeVisible();
    // 개인 링크 코드는 보이더라도 눈에 그대로 드러나지 않는다.
    await expect(page.getByLabel('개인 링크 코드')).toHaveAttribute('type', 'password');

    await page.getByLabel('내 이름').fill('안지윤');
    await expect(page.getByText('아직 저장하지 않은 변경이 있어요.')).toBeVisible();
    await page.getByRole('button', { name: '설정 저장' }).click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cc_name'))).toBe('안지윤');
    await expect(page.getByText('아직 저장하지 않은 변경이 있어요.')).toBeHidden();
  } finally {
    harness.server.close();
  }
});

test('아직 연결하지 않은 기기에는 무엇을 해야 하는지가 적혀 있다', async ({ page }) => {
  const harness = await boot(page, { connected: false });
  try {
    await openSettings(page);
    await expect(page.getByText('아직 이 기기가 연결되지 않았어요', { exact: false })).toBeVisible();
    // 같은 상태 이름이 `앱 정보·지원`의 진단 줄에도 나타난다(같은 값에서 만들기 때문에 그래야 한다).
    // 여기서 보려는 것은 **계정 묶음에 상태가 적혀 있는가**이므로 그 묶음으로 좁힌다.
    await expect(page.getByRole('region', { name: '계정·연결' }).getByText('개인 링크 필요')).toBeVisible();
    // 지울 것이 없으면 연결 해제도 누를 수 없어야 한다 — 눌러도 아무 일 없는 버튼은 고장으로 읽힌다.
    await expect(page.getByRole('button', { name: '연결 해제' })).toBeDisabled();
  } finally {
    harness.server.close();
  }
});

// ── 003: 촬영 방법 ──

test('촬영은 부정형 토글이 아니라 두 방법 중 하나를 고르는 일이고, 결과가 함께 적힌다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);

    expect(await page.getByRole('checkbox', { name: /기본 카메라 앱 쓰지 않기/ }).count(), '부정형 토글이 되살아났다').toBe(0);

    const inApp = page.getByRole('radio', { name: /앱 안에서 촬영/ });
    const native = page.getByRole('radio', { name: /기본 카메라 앱으로도 촬영/ });
    await expect(inApp).toBeChecked();
    // 고르는 것과 그 결과가 한 자리에 있다.
    await expect(page.getByText('휴대폰 갤러리에 사본이 남지 않아요', { exact: false })).toBeVisible();
    await expect(page.getByText('이 앱은 그 사본을 지울 수 없어요', { exact: false })).toBeVisible();

    await native.check();
    await expect(native).toBeChecked();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('cc_galleryFree'))).toBe('off');

    // 새로고침해도 고른 값이 남는다.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
    await openSettings(page);
    await expect(page.getByRole('radio', { name: /기본 카메라 앱으로도 촬영/ })).toBeChecked();
  } finally {
    harness.server.close();
  }
});

// ── 004: 알림 ──

test('알림은 지금 상태 한 줄과 다음 행동 하나만 말한다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);
    const section = page.getByRole('region', { name: '알림' });

    await expect(section.getByText('안전한 전송 준비가 아직 끝나지 않았어요')).toBeVisible();
    // 행동은 하나다. 여러 개를 늘어놓으면 무엇을 눌러야 하는지가 사라진다.
    expect(await section.locator('.int29-action').count(), '알림 카드에 행동이 하나가 아니다').toBe(1);
    await expect(section.getByRole('button', { name: '아직 켤 수 없어요' })).toBeDisabled();

    // 알림이 오는 경우 세 갈래는 watcher가 실제로 보내는 kind와 1:1이다.
    await expect(section.getByText('최종 결과')).toBeVisible();
    await expect(section.getByText('내용 확인')).toBeVisible();
    await expect(section.getByText('복구 필요')).toBeVisible();
    await expect(section).toContainText('이 세 가지 외에는 알리지 않아요');
    await expect(section).toContainText('이름·회사·메모는 담기지 않습니다');
    // 내부 사정 서술은 화면에서 사라졌다.
    await expect(section).not.toContainText('VAPID');
    await expect(section).not.toContainText('구독');
  } finally {
    harness.server.close();
  }
});

test('알림이 기기에서 차단됐으면 앱 밖에서 푸는 절차를 적는다', async ({ page }) => {
  const harness = await boot(page, { permission: 'denied' });
  try {
    await openSettings(page);
    const section = page.getByRole('region', { name: '알림' });

    await expect(section.getByText('이 기기가 알림을 차단해 두었어요', { exact: false })).toBeVisible();
    // "차단됨"만 말하면 사용자는 앱 안에서 방법을 찾다 포기한다. 실제 절차가 있어야 한다.
    await expect(section).toContainText('설정 앱');
    await expect(section).toContainText('알림 허용');
    await expect(section.getByRole('button', { name: '허용한 뒤 다시 확인' })).toBeEnabled();
  } finally {
    harness.server.close();
  }
});

test('닫힌 앱 알림을 모르는 브라우저에는 대안을 적는다', async ({ page }) => {
  const harness = await boot(page, { pushUnsupported: true });
  try {
    await openSettings(page);
    const section = page.getByRole('region', { name: '알림' });
    await expect(section.getByText('이 브라우저는 앱을 닫은 뒤의 알림을 지원하지 않아요')).toBeVisible();
    await expect(section).toContainText('홈 화면에 추가');
    await expect(section).toContainText('진행 화면');
  } finally {
    harness.server.close();
  }
});

// ── 005: 버전 ──

test('버전은 통화하면서 읽을 수 있는 크기이고, 빌드 식별자는 대조할 수 있게 남는다', async ({ page }) => {
  const declared = JSON.parse(await readFile(resolve(fileURLToPath(new URL('../package.json', import.meta.url))), 'utf8')) as { version: string };
  const harness = await boot(page);
  try {
    await openSettings(page);

    const number = page.locator('.int29-version-number');
    await expect(number).toHaveText(declared.version);
    // founder: "버전 같은 거는 좀 크게 잘 보이게 써 있으면 좋겠어." 크기를 실제로 잰다.
    const size = await number.evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    expect(size, `버전 글자가 작다 (${size}px)`).toBeGreaterThanOrEqual(28);

    await expect(page.locator('.int29-version-build')).toContainText(/빌드 src-[0-9a-f]{12}/);
  } finally {
    harness.server.close();
  }
});

// ── 006: 버그 리포트 ──

test('버그 리포트는 메일 초안만 열고, 앱이 스스로 아무것도 보내지 않는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);
    await openSupport(page);
    const before = harness.requests.length;

    const link = page.getByRole('link', { name: /버그 리포트 보내기/ });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href') ?? '';

    // 1) 전송이 아니라 초안이다.
    expect(href.startsWith('mailto:guecom90@gmail.com?'), `mailto가 아니다: ${href.slice(0, 40)}`).toBe(true);
    await expect(page.locator('#kairen-ui form'), '설정이 무언가를 제출하는 form을 가지고 있다').toHaveCount(0);

    // 2) 제목·본문이 미리 채워져 있다.
    const query = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    const body = query.get('body') ?? '';
    expect(query.get('subject')).toContain('버그 리포트');
    expect(body).toContain('■ 무엇을 하려 했나요');
    expect(body).toContain('■ 무슨 일이 일어났나요');
    expect(body).toContain('■ 언제 그랬나요');
    expect(body).toContain('버전: ');
    expect(body).toContain('빌드: src-');

    // 3) 자격 정보·사람 정보는 어디에도 없다.
    for (const secret of ['owner-token', '이강규', 'api.example.test']) {
      expect(href, `버그 리포트에 "${secret}" 가 실렸다`).not.toContain(secret);
      expect(href).not.toContain(encodeURIComponent(secret));
    }

    // 4) 메일 클라이언트가 잘라 먹지 않는 길이다.
    expect(href.length, `mailto가 너무 길다 (${href.length}자)`).toBeLessThanOrEqual(1_900);

    // 5) 화면을 여는 것만으로 밖으로 나간 요청이 없다.
    await page.waitForTimeout(400);
    expect(harness.requests.slice(before).filter((url) => !url.includes('api.example.test'))).toEqual([]);
  } finally {
    harness.server.close();
  }
});

test('메일 앱이 없는 기기를 위해 같은 내용을 복사할 수 있다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSettings(page);
    await openSupport(page);

    await page.getByRole('button', { name: /내용 복사하기/ }).click();
    await expect(page.getByText('복사했어요', { exact: false })).toBeVisible();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('받는 사람: guecom90@gmail.com');
    expect(copied).toContain('■ 무엇을 하려 했나요');
    expect(copied).not.toContain('owner-token');
    expect(copied).not.toContain('이강규');
  } finally {
    harness.server.close();
  }
});

test('클립보드가 막힌 기기에서는 내용을 그대로 펼쳐 준다', async ({ page }) => {
  const harness = await boot(page);
  try {
    // 비보안 origin·권한 거부·조작 인정 만료 — 실제로 자주 있는 상황이다.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => undefined });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('navigation', { name: '주요 화면' })).toBeVisible({ timeout: 20_000 });
    await openSettings(page);
    await openSupport(page);

    await page.getByRole('button', { name: /내용 복사하기/ }).click();
    await expect(page.getByText('자동 복사가 막혀 있어요', { exact: false })).toBeVisible();
    const fallback = page.getByLabel('버그 리포트 내용');
    await expect(fallback).toBeVisible();
    await expect(fallback).toHaveValue(/■ 무엇을 하려 했나요/);
  } finally {
    harness.server.close();
  }
});

// ── 007: 좁은 폭 ──

test('320px에서도 가로로 새지 않고 모든 조작이 화면 안에 있다', async ({ page }) => {
  const harness = await boot(page, { width: 320, height: 568 });
  try {
    await openSettings(page);
    await page.waitForTimeout(200);

    const report = await page.evaluate(() => {
      // 폭 기준은 `clientWidth`다. `innerWidth`는 emulation에서 실제 레이아웃 폭과 다르다.
      const viewport = document.documentElement.clientWidth;
      const overflow: { where: string; right: number }[] = [];
      const scope = document.querySelector('#kairen-ui');
      for (const node of scope?.querySelectorAll('button, a, input, textarea, [role="radio"]') ?? []) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (rect.right > viewport + 1 || rect.left < -1) {
          overflow.push({ where: `${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]}`, right: Math.round(rect.right) });
        }
      }
      return { viewport, scrollWidth: document.scrollingElement?.scrollWidth ?? 0, overflow, controls: scope?.querySelectorAll('button, a, input, textarea').length ?? 0 };
    });

    expect(report.viewport).toBe(320);
    expect(report.scrollWidth, '설정 화면이 320px에서 가로로 스크롤된다').toBeLessThanOrEqual(report.viewport + 1);
    expect(report.overflow, `320px에서 화면 밖으로 밀린 조작: ${JSON.stringify(report.overflow)}`).toEqual([]);
    expect(report.controls, '320px에서 잰 조작이 너무 적다').toBeGreaterThanOrEqual(10);

    // 아주 긴 값이 들어와도 화면을 밀어내지 않는다. `<input>`은 HTML `size`에서 오는 고유 폭이
    // 있어서, 글자 크기를 올리면 값이 없어도 칸 자체가 밖으로 나간다 — 예전에 22개가 그렇게 나갔다.
    await page.getByLabel('내 이름').fill('가'.repeat(120));
    await page.getByLabel('개인 링크 코드').fill('x'.repeat(200));
    await page.waitForTimeout(150);
    const afterLongValues = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.scrollingElement?.scrollWidth ?? 0,
    }));
    expect(afterLongValues.scrollWidth, '긴 값이 들어오자 320px에서 가로로 새어 나갔다').toBeLessThanOrEqual(afterLongValues.viewport + 1);
  } finally {
    harness.server.close();
  }
});

// ── 008: 손가락과 키보드 ──

test('모든 조작이 손가락 크기이고 키보드로 닿는다', async ({ page }) => {
  const harness = await boot(page);
  try {
    await openSettings(page);

    const small = await page.evaluate(() => {
      const found: { where: string; height: number }[] = [];
      const scope = document.querySelector('#kairen-ui');
      for (const node of scope?.querySelectorAll('button, a[href], input[type="radio"], [role="radio"]') ?? []) {
        const rect = node.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // 라디오 자체는 작아도 되지만 **누르는 자리**(label)가 커야 한다 — 그 자리는 아래에서 잰다.
        if (node.tagName === 'INPUT') continue;
        if (rect.height < 44) found.push({ where: `${node.tagName.toLowerCase()}.${String(node.className || '').split(' ')[0]}`, height: Math.round(rect.height) });
      }
      return found;
    });
    expect(small, `손가락으로 누르기 어려운 조작(44px 미만): ${JSON.stringify(small)}`).toEqual([]);

    // 라디오를 감싼 누르는 자리도 손가락 크기다.
    const optionHeights = await page.locator('.int29-option').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(optionHeights.length).toBeGreaterThanOrEqual(2);
    for (const height of optionHeights) expect(height).toBeGreaterThanOrEqual(44);

    // 키보드만으로 이름 칸과 저장 버튼에 닿는다. 마우스 없이 못 쓰는 설정 화면은 설정 화면이 아니다.
    let landedOnName = false;
    for (let step = 0; step < 25 && !landedOnName; step += 1) {
      await page.keyboard.press('Tab');
      landedOnName = await page.evaluate(() => document.activeElement?.id === 'settings-capturer');
    }
    expect(landedOnName, '키보드만으로 이름 칸에 닿지 못한다').toBe(true);

    let landedOnSave = false;
    for (let step = 0; step < 25 && !landedOnSave; step += 1) {
      await page.keyboard.press('Tab');
      landedOnSave = await page.evaluate(() => document.activeElement?.textContent?.trim() === '설정 저장');
    }
    expect(landedOnSave, '키보드만으로 설정 저장에 닿지 못한다').toBe(true);
    // 포커스가 어디 있는지 눈으로 보여야 한다.
    const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineWidth);
    expect(parseFloat(ring), '키보드 포커스 링이 보이지 않는다').toBeGreaterThan(0);
  } finally {
    harness.server.close();
  }
});
