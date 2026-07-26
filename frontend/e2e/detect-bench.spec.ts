// 감지 알고리즘 벤치 (TSK-000244): 빌드된 감지 워커를 그대로 불러 어려운 장면을 직접 먹이고
// 정답 사각형과의 IoU·안정성을 잰다. 앱 UI를 거치지 않으므로 알고리즘만 빠르게 비교할 수 있다.
//
// 왜 필요한가: founder 판정 "수직으로 볼 때 특히 안 되고 사선일 때 잘 된다, 박스가 촐싹댄다".
// 기존 시나리오 매트릭스는 전부 통과하고 있었다 — 장면이 너무 쉬웠기 때문이다.
// 여기서는 실제 실패 조건(그림자 없음·조명 기울기·폰 그림자·저대비·노이즈·반사광)을 넣는다.
import { expect, test } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const outDir = resolve(fileURLToPath(new URL('../test-results/', import.meta.url)));

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

test('detection bench over hard scenes', async ({ page }) => {
  test.setTimeout(600_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const workerAsset = (await readdir(resolve(buildRoot, 'next/assets'))).find((file) => /^opencv-worker-.*\.js$/.test(file));
  if (!workerAsset) throw new Error('opencv worker asset not found');

  try {
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'domcontentloaded' });
    const report = await page.evaluate(async (workerFile: string) => {
      // ── 장면 생성기: 실제 실패 조건을 재현한다 ──────────────────────────────
      const W = 720; const H = 1280;
      type Corner = { x: number; y: number };
      type Scene = { name: string; quad: Corner[] };

      function cardQuad(centerX: number, centerY: number, width: number, height: number, rotation: number, skew = 0): Corner[] {
        const corners = [
          { x: -width / 2, y: -height / 2 }, { x: width / 2, y: -height / 2 },
          { x: width / 2, y: height / 2 }, { x: -width / 2, y: height / 2 },
        ];
        const cos = Math.cos(rotation); const sin = Math.sin(rotation);
        return corners.map((corner) => {
          const sx = corner.x + corner.y * skew;
          return { x: centerX + sx * cos - corner.y * sin, y: centerY + sx * sin + corner.y * cos };
        });
      }

      function paint(context: CanvasRenderingContext2D, options: {
        desk: string; card: string; shadow: number; noise: number; glare: number;
        lightTilt: number; phoneShadow: boolean; quad: Corner[];
      }) {
        context.fillStyle = options.desk;
        context.fillRect(0, 0, W, H);
        // 조명 기울기 — 실사 사진은 절대 균일하지 않다.
        if (options.lightTilt) {
          const gradient = context.createLinearGradient(0, 0, W * 0.6, H);
          gradient.addColorStop(0, `rgba(255,255,255,${options.lightTilt})`);
          gradient.addColorStop(1, `rgba(0,0,0,${options.lightTilt})`);
          context.fillStyle = gradient;
          context.fillRect(0, 0, W, H);
        }
        const path = () => {
          context.beginPath();
          context.moveTo(options.quad[0].x, options.quad[0].y);
          for (let index = 1; index < 4; index += 1) context.lineTo(options.quad[index].x, options.quad[index].y);
          context.closePath();
        };
        if (options.shadow > 0) {
          context.save();
          context.translate(7, 10);
          path();
          context.fillStyle = `rgba(0,0,0,${options.shadow})`;
          context.fill();
          context.restore();
        }
        path();
        context.fillStyle = options.card;
        context.fill();
        context.save();
        path();
        context.clip();
        context.fillStyle = '#22303f';
        context.font = '700 46px sans-serif';
        context.fillText('김진우', options.quad[0].x + 34, options.quad[0].y + 86);
        context.font = '400 24px sans-serif';
        context.fillText('대표이사', options.quad[0].x + 34, options.quad[0].y + 124);
        context.fillText('010-1234-5678', options.quad[0].x + 34, options.quad[0].y + 210);
        if (options.glare > 0) {
          const glare = context.createLinearGradient(options.quad[0].x, options.quad[0].y, options.quad[2].x, options.quad[2].y);
          glare.addColorStop(0, 'rgba(255,255,255,0)');
          glare.addColorStop(0.5, `rgba(255,255,255,${options.glare})`);
          glare.addColorStop(1, 'rgba(255,255,255,0)');
          context.fillStyle = glare;
          context.fill();
        }
        context.restore();
        // 폰·손 그림자가 카드 위로 드리운다 (수직 촬영에서 흔하다).
        if (options.phoneShadow) {
          context.fillStyle = 'rgba(0,0,0,0.20)';
          context.fillRect(0, 0, W, H * 0.44);
        }
        if (options.noise > 0) {
          const image = context.getImageData(0, 0, W, H);
          for (let index = 0; index < image.data.length; index += 4) {
            const jitter = (Math.sin(index * 12.9898) * 43758.5453 % 1) * options.noise * 2 - options.noise;
            image.data[index] = Math.max(0, Math.min(255, image.data[index] + jitter));
            image.data[index + 1] = Math.max(0, Math.min(255, image.data[index + 1] + jitter));
            image.data[index + 2] = Math.max(0, Math.min(255, image.data[index + 2] + jitter));
          }
          context.putImageData(image, 0, 0);
        }
      }

      const flat = cardQuad(360, 640, 560, 340, 0);                       // 완전 수직 정렬
      const tilted = cardQuad(360, 640, 545, 330, -0.12, 0.07);           // 사선 + 원근
      const scenes: Array<Scene & { render: (context: CanvasRenderingContext2D) => void }> = [
        {
          name: 'perpendicular-shadowless', quad: flat, // founder 핵심 실패 조건
          render: (context) => paint(context, { desk: '#c9bda9', card: '#f2f0ea', shadow: 0, noise: 6, glare: 0, lightTilt: 0.05, phoneShadow: false, quad: flat }),
        },
        {
          name: 'perpendicular-phone-shadow', quad: flat,
          render: (context) => paint(context, { desk: '#bfb3a0', card: '#efedE7', shadow: 0.05, noise: 7, glare: 0, lightTilt: 0.07, phoneShadow: true, quad: flat }),
        },
        {
          name: 'perpendicular-low-contrast', quad: flat,
          render: (context) => paint(context, { desk: '#e6e3dd', card: '#f4f2ee', shadow: 0, noise: 5, glare: 0, lightTilt: 0.04, phoneShadow: false, quad: flat }),
        },
        {
          name: 'tilted-with-shadow', quad: tilted, // 잘 되던 조건 — 회귀 방지용
          render: (context) => paint(context, { desk: '#b9a892', card: '#f3f1ec', shadow: 0.26, noise: 6, glare: 0, lightTilt: 0.05, phoneShadow: false, quad: tilted }),
        },
        {
          name: 'dark-desk-glare', quad: tilted, // founder 스크린샷 2번(어두운 가죽 패드)
          render: (context) => paint(context, { desk: '#2b2b2e', card: '#e9e7e2', shadow: 0.3, noise: 8, glare: 0.35, lightTilt: 0.06, phoneShadow: false, quad: tilted }),
        },
        {
          name: 'wood-desk-warm', quad: tilted, // founder 스크린샷 1번(나무 책상)
          render: (context) => paint(context, { desk: '#8a6a45', card: '#e8e6e0', shadow: 0.28, noise: 7, glare: 0.15, lightTilt: 0.08, phoneShadow: false, quad: tilted }),
        },
      ];

      // ── 빌드된 감지 워커를 그대로 사용한다 ─────────────────────────────────
      const worker = new Worker(new URL(`./assets/${workerFile}`, location.href));
      let sequence = 1;
      const pending = new Map<number, (reply: Record<string, unknown>) => void>();
      worker.onmessage = (event: MessageEvent) => {
        const reply = event.data as { id: number };
        pending.get(reply.id)?.(reply as Record<string, unknown>);
        pending.delete(reply.id);
      };
      const call = (message: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((done) => {
        const id = sequence;
        sequence += 1;
        pending.set(id, done);
        worker.postMessage({ id, ...message }, transfer);
      });
      const ready = await call({ type: 'init', vendorUrl: new URL('../vendor/opencv.js', location.href).href });
      if (!ready.ok) return { error: 'worker init failed' };

      function polygonArea(points: Corner[]): number {
        let total = 0;
        for (let index = 0; index < points.length; index += 1) {
          const a = points[index];
          const b = points[(index + 1) % points.length];
          total += a.x * b.y - b.x * a.y;
        }
        return Math.abs(total) / 2;
      }
      // Sutherland–Hodgman 교집합 (두 다각형 모두 볼록하다).
      function clip(subject: Corner[], clipper: Corner[]): Corner[] {
        let output = subject;
        for (let index = 0; index < clipper.length; index += 1) {
          const a = clipper[index];
          const b = clipper[(index + 1) % clipper.length];
          const input = output;
          output = [];
          // clipper는 항상 orderQuad 결과(화면 좌표계 시계방향)라 내부는 side >= 0이다.
          const side = (point: Corner) => (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
          for (let position = 0; position < input.length; position += 1) {
            const current = input[position];
            const previous = input[(position + input.length - 1) % input.length];
            const currentIn = side(current) >= 0;
            const previousIn = side(previous) >= 0;
            if (currentIn !== previousIn) {
              const t = side(previous) / (side(previous) - side(current));
              output.push({ x: previous.x + t * (current.x - previous.x), y: previous.y + t * (current.y - previous.y) });
            }
            if (currentIn) output.push(current);
          }
          if (!output.length) return [];
        }
        return output;
      }
      function iou(a: Corner[], b: Corner[]): number {
        const overlap = polygonArea(clip(a, b));
        const union = polygonArea(a) + polygonArea(b) - overlap;
        return union > 0 ? overlap / union : 0;
      }
      function orderQuad(points: Corner[]): Corner[] {
        const bySum = points.slice().sort((p, q) => (p.x + p.y) - (q.x + q.y));
        const byDiff = points.slice().sort((p, q) => (p.y - p.x) - (q.y - q.x));
        return [bySum[0], byDiff[0], bySum[3], byDiff[3]];
      }

      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const detectWidth = 320;
      const detectHeight = Math.round(detectWidth * H / W);
      const small = document.createElement('canvas');
      small.width = detectWidth;
      small.height = detectHeight;
      const smallContext = small.getContext('2d', { willReadFrequently: true })!;
      const scale = W / detectWidth;

      const rows: Array<Record<string, unknown>> = [];
      for (const scene of scenes) {
        const samples: Array<{ iou: number; quad: Corner[] | null }> = [];
        let previousQuad: Corner[] | null = null; // 라이브 루프와 동일하게 직전 결과를 넘긴다
        let elapsed = 0;
        // 같은 장면을 8번 — 손떨림처럼 1px 흔들어 안정성(촐싹거림)을 잰다.
        for (let repeat = 0; repeat < 8; repeat += 1) {
          context.save();
          context.translate((repeat % 3) - 1, ((repeat >> 1) % 3) - 1);
          scene.render(context);
          context.restore();
          smallContext.drawImage(canvas, 0, 0, detectWidth, detectHeight);
          const image = smallContext.getImageData(0, 0, detectWidth, detectHeight);
          const startedAt = performance.now();
          const reply = await call({ type: 'analyze', image, minAreaRatio: 0.07, fast: false, withGate: false, previousQuad }, [image.data.buffer]);
          elapsed += performance.now() - startedAt;
          const quad = (reply.quad as Corner[] | null) ?? null;
          previousQuad = quad;
          const scaled = quad ? orderQuad(quad.map((point) => ({ x: point.x * scale, y: point.y * scale }))) : null;
          samples.push({ iou: scaled ? iou(scaled, orderQuad(scene.quad)) : 0, quad: scaled });
        }
        const found = samples.filter((sample) => sample.quad);
        const ious = samples.map((sample) => sample.iou);
        const mean = ious.reduce((total, value) => total + value, 0) / ious.length;
        // 촐싹거림: 연속 프레임 사이 코너 이동량 평균(px). 장면은 1px밖에 안 움직였다.
        let jitter = 0; let pairs = 0;
        for (let index = 1; index < samples.length; index += 1) {
          const previous = samples[index - 1].quad;
          const current = samples[index].quad;
          if (!previous || !current) continue;
          jitter += current.reduce((total, point, corner) => total + Math.hypot(point.x - previous[corner].x, point.y - previous[corner].y), 0) / 4;
          pairs += 1;
        }
        rows.push({
          scene: scene.name,
          detectRate: +(found.length / samples.length).toFixed(2),
          meanIoU: +mean.toFixed(3),
          minIoU: +Math.min(...ious).toFixed(3),
          hit75: ious.filter((value) => value >= 0.75).length,
          jitterPx: pairs ? +(jitter / pairs).toFixed(1) : -1,
          ious: ious.map((value) => +value.toFixed(2)),
          avgMs: Math.round(elapsed / samples.length),
        });
      }
      worker.terminate();
      return { rows };
    }, workerAsset);

    console.log('DETECT_BENCH', JSON.stringify(report, null, 1));
    await writeFile(resolve(outDir, 'detect-bench.json'), JSON.stringify(report, null, 2));
    expect((report as { rows?: unknown[] }).rows?.length, '벤치가 장면을 하나도 못 돌렸다').toBeGreaterThan(0);
  } finally {
    await new Promise<void>((stop) => { server.close(() => stop()); server.closeAllConnections(); });
  }
});
