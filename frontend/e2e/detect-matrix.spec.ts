// 감지 품질 매트릭스 (TSK-000237): 실사에 가까운 여러 장면을 실제 앱 카메라 경로로 흘려
// "감지 성공 여부 + 감지 박스가 실제 카드에 앉는가"를 시나리오별로 계측한다.
// founder 증상: "명함에서 오프셋된, 명함 위 사각박스" = 감지 실패 시 그려지는 고정 가이드 프레임.
import { expect, test } from '@playwright/test';
import { cardBoxOnScreen, centerDistance, overlayHole } from './stage-truth';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const outDir = resolve(fileURLToPath(new URL('../test-results/', import.meta.url)));

const FRAME = { width: 720, height: 1280 };
const CARD = { x: 90, y: 470, width: 540, height: 324 };

type Scenario = 'clean' | 'tilted-glare' | 'low-contrast' | 'busy-background' | 'rounded-shadowless';

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json; charset=utf-8',
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

test.use({ viewport: { width: 375, height: 812 } });

test('detection matrix over realistic scenes', async ({ page }) => {
  test.setTimeout(600_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const report: Array<Record<string, unknown>> = [];

  try {
    page.on('pageerror', (error) => console.log('PAGEERROR', error.message.slice(0, 200)));

    for (const scenario of ['clean', 'tilted-glare', 'low-contrast', 'busy-background', 'rounded-shadowless'] as Scenario[]) {
      await page.context().clearCookies();
      await page.addInitScript(({ frame, card, scene }) => {
        localStorage.setItem('cc_name', 'Debug');
        localStorage.setItem('cc_autoCapture', 'off');
        const canvas = document.createElement('canvas');
        canvas.width = frame.width;
        canvas.height = frame.height;
        const context = canvas.getContext('2d')!;

        const roundedCard = (radius: number) => {
          context.beginPath();
          const { x, y, width, height } = card;
          context.moveTo(x + radius, y);
          context.arcTo(x + width, y, x + width, y + height, radius);
          context.arcTo(x + width, y + height, x, y + height, radius);
          context.arcTo(x, y + height, x, y, radius);
          context.arcTo(x, y, x + width, y, radius);
          context.closePath();
        };
        const cardText = () => {
          context.fillStyle = '#1d2a3a';
          context.font = '700 58px "Malgun Gothic", sans-serif';
          context.fillText('김진우', card.x + 36, card.y + 104);
          context.font = '400 27px "Malgun Gothic", sans-serif';
          context.fillText('대표이사', card.x + 36, card.y + 148);
          context.font = '600 26px "Malgun Gothic", sans-serif';
          context.fillText('카이렌 로보틱스', card.x + 36, card.y + 212);
          context.font = '400 22px "Malgun Gothic", sans-serif';
          context.fillText('010-1234-5678', card.x + 36, card.y + 264);
        };
        const noise = (amount: number) => {
          for (let index = 0; index < 2500; index += 1) {
            const px = (index * 977) % frame.width;
            const py = (index * 1597) % frame.height;
            context.fillStyle = index % 2 ? `rgba(255,255,255,${amount})` : `rgba(0,0,0,${amount})`;
            context.fillRect(px, py, 2, 2);
          }
        };

        const draw = () => {
          if (scene === 'low-contrast') { context.fillStyle = '#e8e6e1'; } // 흰 책상 위 흰 카드
          else if (scene === 'busy-background') { context.fillStyle = '#6f6a63'; }
          else { context.fillStyle = '#b9a892'; }
          context.fillRect(0, 0, frame.width, frame.height);

          if (scene === 'busy-background') {
            // 노트북·수첩·다른 카드 등 사각형이 여럿인 책상
            context.fillStyle = '#3b4551'; context.fillRect(-40, 120, 460, 300);
            context.fillStyle = '#d8d2c6'; context.fillRect(380, 900, 400, 340);
            context.fillStyle = '#8d99a8'; context.fillRect(40, 1080, 300, 180);
          }
          noise(scene === 'low-contrast' ? 0.03 : 0.05);

          context.save();
          if (scene === 'tilted-glare') {
            context.translate(card.x + card.width / 2, card.y + card.height / 2);
            context.rotate(-7 * Math.PI / 180);
            context.transform(1, 0.06, 0, 1, 0, 0); // 원근 느낌의 살짝 기울임
            context.translate(-(card.x + card.width / 2), -(card.y + card.height / 2));
          }
          if (scene !== 'rounded-shadowless') {
            context.fillStyle = 'rgba(0,0,0,0.22)';
            context.fillRect(card.x + 6, card.y + 9, card.width, card.height);
          }
          if (scene === 'rounded-shadowless' || scene === 'tilted-glare') roundedCard(18);
          else { context.beginPath(); context.rect(card.x, card.y, card.width, card.height); }
          context.fillStyle = scene === 'low-contrast' ? '#f6f5f2' : '#f3f1ec';
          context.fill();
          context.save();
          context.clip();
          cardText();
          if (scene === 'tilted-glare') {
            const glare = context.createLinearGradient(card.x, card.y, card.x + card.width, card.y + card.height);
            glare.addColorStop(0, 'rgba(255,255,255,0)');
            glare.addColorStop(0.45, 'rgba(255,255,255,0.75)');
            glare.addColorStop(0.7, 'rgba(255,255,255,0)');
            context.fillStyle = glare;
            context.fillRect(card.x, card.y, card.width, card.height);
          }
          context.restore();
          context.restore();
        };
        draw();
        window.setInterval(draw, 120);
        const stream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(30);
        Object.defineProperty(navigator, 'mediaDevices', {
          configurable: true,
          value: { getUserMedia: async () => stream, enumerateDevices: async () => [] },
        });
      }, { frame: FRAME, card: CARD, scene: scenario });

      await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
      await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });
      await expect(page.locator('.camera-engine-note')).toContainText(/준비됨|fallback/, { timeout: 60_000 });
      await page.waitForTimeout(2_500);

      const probe = await page.evaluate(() => {
        const overlay = document.querySelector('canvas.camera-overlay') as HTMLCanvasElement | null;
        const video = document.querySelector('.camera-preview-stage video') as HTMLVideoElement | null;
        if (!overlay || !video) return null;
        return {
          stage: { width: overlay.width, height: overlay.height },
          video: { width: video.videoWidth, height: video.videoHeight },
          hint: document.querySelector('.camera-hint-pill span')?.textContent ?? null,
        };
      });
      const hole = await overlayHole(page);

      let verdict = 'NO_BOX';
      let centerDx = -1; let centerDy = -1; let sizeRatio = -1;
      if (probe && hole) {
        // 기대 위치는 앱의 좌표 공식이 아니라 렌더된 화면 픽셀에서 찾은 카드다 (TSK-000241).
        // 예전에는 여기서 앱과 같은 cover 공식을 다시 계산해, 매핑이 통째로 틀려도 ON_CARD가 나왔다.
        const expected = await cardBoxOnScreen(page);
        if (expected) {
          ({ dx: centerDx, dy: centerDy } = centerDistance(hole, expected));
          sizeRatio = +((hole.width * hole.height) / (expected.width * expected.height)).toFixed(2);
          // 가이드 프레임(감지 실패 시 그려짐)은 화면 42% 지점의 고정 박스다.
          const guideWidth = Math.min(probe.stage.width * 0.88, 520);
          const looksLikeGuide = Math.abs(hole.width - guideWidth) < 12 && Math.abs((hole.y + hole.height / 2) - probe.stage.height * 0.42) < 14;
          verdict = looksLikeGuide ? 'GUIDE_FALLBACK' : (centerDx < expected.width * 0.15 && centerDy < expected.height * 0.15 ? 'ON_CARD' : 'OFFSET');
        } else {
          verdict = 'NO_TRUTH'; // 장면에서 카드를 픽셀로 찾지 못함 (저대비 시나리오)
        }
      }
      report.push({ scenario, verdict, centerDx, centerDy, sizeRatio, hint: probe?.hint ?? null });
      await page.locator('.camera-preview-stage').screenshot({ path: resolve(outDir, `scene-${scenario}.png`) });
      await page.getByRole('button', { name: '닫기' }).click();
      await page.waitForTimeout(300);
    }

    console.log('DETECT_MATRIX', JSON.stringify(report, null, 1));
    await writeFile(resolve(outDir, 'detect-matrix.json'), JSON.stringify(report, null, 2));
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});
