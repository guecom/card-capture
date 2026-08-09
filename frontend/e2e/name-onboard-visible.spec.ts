// 회귀 게이트: 첫 실행 이름 온보딩 모달이 **보이는 높이로** 뜨고 실제 클릭으로 닫히는가.
//
// 결함 실측 (2026-08-09, connect.kairenhq.com — 이 앱의 동일본 첫 배포):
//   `--height: auto` IonModal 안에 IonContent(absolute)를 넣으면 shadow .modal-wrapper
//   높이가 0으로 접힌다. 모달은 투명한데 backdrop은 살아 있어 **화면 전체 클릭을 먹는다**
//   — founder 실보고 "클릭이나 이런게 전혀 안돼". founder 기기들은 이미 온보딩을 지나
//   발현되지 않았을 뿐, 새 기기·새 브라우저의 첫 실행에서는 즉시 발현된다.
//
// 게이트 전제에 대한 자기 점검:
//   - 기존 status-truth.spec은 이 모달의 버튼을 `evaluate(JS click)`로 눌렀다. JS click은
//     가시성과 무관하게 동작하므로 높이 0 결함이 그 게이트를 **초록인 채로** 지나갔다.
//     그래서 이 게이트는 (1) 기하 — shadow .modal-wrapper의 실제 높이(모달 측정 관례),
//     (2) 상호작용 — Playwright 실제 액션(가시성·안정성 판정 포함)으로만 잰다.
//   - 고정 대기 없음: 모달의 show-modal 클래스(상태)로 기다린다.
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
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(`${buildRoot}${sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(filePath);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
      response.end(body);
    } catch {
      response.writeHead(404).end('Not found');
    }
  });
  server.keepAliveTimeout = 1;
  return new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => done(server)); });
}

function portOf(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no TCP port');
  return address.port;
}

test('첫 실행 이름 온보딩이 보이는 높이로 뜨고, 실제 입력·클릭으로 닫힌다', async ({ page }) => {
  const server = await startStaticServer();
  try {
    // 무거운 엔진 자산은 이 판정과 무관하다 — 감지·OCR 없이도 온보딩은 떠야 한다.
    await page.context().route('**/vendor/**', (route) => route.abort());
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`http://127.0.0.1:${portOf(server)}/next/`, { waitUntil: 'load' });

    const modal = page.locator('ion-modal.name-onboard-modal');
    // 상태로 기다린다 — 신선한 기기의 첫 부팅은 이름부터 묻는다.
    await expect(modal, '첫 실행인데 이름 온보딩이 뜨지 않았다').toHaveClass(/show-modal/, { timeout: 15_000 });

    // (1) 기하 — 모달 측정 관례: shadow .modal-wrapper. 0이면 투명 전면 차단이다.
    const wrapperHeight = await modal.evaluate(
      (element) => element.shadowRoot?.querySelector('.modal-wrapper')?.getBoundingClientRect().height ?? 0,
    );
    expect(wrapperHeight, '모달 wrapper 높이가 0 — 투명한 채 화면 전체 클릭을 먹는 상태').toBeGreaterThan(80);

    // (2) 상호작용 — evaluate(JS click) 금지. 실제 액션은 가시성·안정성 판정을 포함한다.
    await expect(page.getByRole('heading', { name: '처음 오셨네요 👋' })).toBeVisible();
    await page.getByRole('textbox', { name: '이름', exact: true }).fill('합성 검증자');
    await modal.getByRole('button', { name: '시작하기' }).click();
    await expect(modal).not.toHaveClass(/show-modal/);
  } finally {
    server.close();
  }
});
