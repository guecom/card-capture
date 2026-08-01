import { expect, test } from '@playwright/test';
import { readFile, readdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.onnx': 'application/octet-stream', '.wasm': 'application/wasm',
};

function startStaticServer(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      let relativePath = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
      if (relativePath.endsWith('/')) relativePath += 'index.html';
      const filePath = resolve(buildRoot, relativePath);
      if (filePath !== buildRoot && !filePath.startsWith(buildRoot + sep)) {
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

test('on-device card model proposes stable quadrilaterals on hard scenes', async ({ page }) => {
  test.setTimeout(180_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const workerAsset = (await readdir(resolve(buildRoot, 'next/assets'))).find((file) => /^card-quad-worker-.*\.js$/.test(file));
  if (!workerAsset) throw new Error('card quad worker asset not found');

  try {
    await page.goto('http://127.0.0.1:' + address.port + '/next/', { waitUntil: 'domcontentloaded' });
    const report = await page.evaluate(async (workerFile: string) => {
      type Point = { x: number; y: number };
      const width = 720;
      const height = 1280;
      const worker = new Worker(new URL('./assets/' + workerFile, location.href), { type: 'module' });
      let nextId = 1;
      const pending = new Map<number, (reply: Record<string, unknown>) => void>();
      worker.onmessage = (event: MessageEvent) => {
        const reply = event.data as { id: number };
        pending.get(reply.id)?.(reply as Record<string, unknown>);
        pending.delete(reply.id);
      };
      const call = (message: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((resolveReply) => {
        const id = nextId;
        nextId += 1;
        pending.set(id, resolveReply);
        worker.postMessage({ id, ...message }, transfer);
      });

      const initAt = performance.now();
      const ready = await call({
        type: 'init',
        ortBase: new URL('../vendor/ort/', location.href).href,
        model: new URL('../vendor/cardquad/lcnet100_h_e_bifpn_256_fp32.onnx', location.href).href,
      });
      const initMs = Math.round(performance.now() - initAt);
      if (!ready.ok) return { ready: false, initMs, rows: [] };

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true })!;

      function corners(rotation: number, skew = 0): Point[] {
        const centerX = width / 2;
        const centerY = height / 2;
        const cardWidth = 550;
        const cardHeight = 330;
        const cos = Math.cos(rotation);
        const sin = Math.sin(rotation);
        return [
          { x: -cardWidth / 2, y: -cardHeight / 2 },
          { x: cardWidth / 2, y: -cardHeight / 2 },
          { x: cardWidth / 2, y: cardHeight / 2 },
          { x: -cardWidth / 2, y: cardHeight / 2 },
        ].map((point) => {
          const x = point.x + point.y * skew;
          return { x: centerX + x * cos - point.y * sin, y: centerY + x * sin + point.y * cos };
        });
      }

      function paint(quad: Point[], desk: string, card: string, shadow: number, glare: number): void {
        context.fillStyle = desk;
        context.fillRect(0, 0, width, height);
        const path = (offsetX = 0, offsetY = 0) => {
          context.beginPath();
          context.moveTo(quad[0].x + offsetX, quad[0].y + offsetY);
          for (let index = 1; index < 4; index += 1) context.lineTo(quad[index].x + offsetX, quad[index].y + offsetY);
          context.closePath();
        };
        if (shadow) {
          path(8, 11);
          context.fillStyle = 'rgba(0,0,0,' + shadow + ')';
          context.fill();
        }
        path();
        context.fillStyle = card;
        context.fill();
        context.save();
        path();
        context.clip();
        context.fillStyle = '#243248';
        context.font = '700 48px sans-serif';
        context.fillText('Kairen', quad[0].x + 45, quad[0].y + 100);
        context.font = '400 26px sans-serif';
        context.fillText('Business Card', quad[0].x + 45, quad[0].y + 150);
        context.fillText('010-1234-5678', quad[0].x + 45, quad[0].y + 245);
        if (glare) {
          const gradient = context.createLinearGradient(quad[0].x, quad[0].y, quad[2].x, quad[2].y);
          gradient.addColorStop(0.35, 'rgba(255,255,255,0)');
          gradient.addColorStop(0.5, 'rgba(255,255,255,' + glare + ')');
          gradient.addColorStop(0.65, 'rgba(255,255,255,0)');
          context.fillStyle = gradient;
          context.fillRect(0, 0, width, height);
        }
        context.restore();
      }

      function order(points: Point[]): Point[] {
        const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
        const sorted = points.slice().sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
        const first = sorted.reduce((best, point, index) => point.x + point.y < sorted[best].x + sorted[best].y ? index : best, 0);
        return [...sorted.slice(first), ...sorted.slice(0, first)];
      }

      function malformed(points: Point[] | null): boolean {
        if (!points || points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return Boolean(points);
        const quad = order(points);
        let sign = 0;
        for (let index = 0; index < 4; index += 1) {
          const a = quad[index];
          const b = quad[(index + 1) % 4];
          const c = quad[(index + 2) % 4];
          const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
          if (Math.abs(cross) < 1) return true;
          if (!sign) sign = Math.sign(cross);
          else if (Math.sign(cross) !== sign) return true;
        }
        return false;
      }

      const low = corners(0);
      const warm = corners(-0.11, 0.06);
      const dark = corners(0.08, -0.05);
      const scenes = [
        { name: 'low-contrast', quad: low, draw: () => paint(low, '#dedbd5', '#efede8', 0.03, 0) },
        { name: 'warm-desk-tilted', quad: warm, draw: () => paint(warm, '#896b48', '#ece9e2', 0.24, 0.12) },
        { name: 'dark-desk-glare', quad: dark, draw: () => paint(dark, '#28292d', '#e7e4de', 0.3, 0.3) },
      ];
      const rows: Array<Record<string, unknown>> = [];
      for (const scene of scenes) {
        scene.draw();
        const image = context.getImageData(0, 0, width, height);
        const startedAt = performance.now();
        const reply = await call({ type: 'detect', image }, [image.data.buffer]);
        const elapsedMs = Math.round(performance.now() - startedAt);
        const quad = (reply.quad as Point[] | null) ?? null;
        const expected = order(scene.quad);
        const actual = quad ? order(quad) : null;
        const error = actual
          ? actual.reduce((total, point, index) => total + Math.hypot(point.x - expected[index].x, point.y - expected[index].y), 0) / 4
          : -1;
        rows.push({
          scene: scene.name,
          found: Boolean(quad),
          malformed: malformed(quad),
          confidence: Number(reply.confidence ?? 0),
          meanCornerErrorPx: Math.round(error),
          elapsedMs,
        });
      }
      worker.terminate();
      return { ready: true, initMs, rows };
    }, workerAsset);

    console.log('CARD_QUAD_MODEL', JSON.stringify(report, null, 2));
    expect(report.ready).toBe(true);
    expect(report.rows.filter((row) => row.found).length).toBeGreaterThanOrEqual(2);
    expect(report.rows.filter((row) => row.malformed)).toHaveLength(0);
    expect(Math.max(...report.rows.map((row) => row.elapsedMs))).toBeLessThan(1_500);
  } finally {
    await new Promise<void>((stop) => {
      server.close(() => stop());
      server.closeAllConnections();
    });
  }
});

test('desk-only camera never exposes a detected quadrilateral', async ({ page }) => {
  test.setTimeout(90_000);
  const server = await startStaticServer();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  try {
    await page.addInitScript(() => {
      localStorage.setItem('cc_name', 'Debug');
      localStorage.setItem('cc_autoCapture', 'off');
      const canvas = document.createElement('canvas');
      canvas.width = 720;
      canvas.height = 1280;
      const context = canvas.getContext('2d')!;
      const draw = () => {
        context.fillStyle = '#8a6d4c';
        context.fillRect(0, 0, canvas.width, canvas.height);
        for (let line = 0; line < 40; line += 1) {
          context.beginPath();
          context.moveTo(0, line * 34 + Math.sin(line) * 10);
          context.bezierCurveTo(190, line * 32 - 18, 510, line * 36 + 22, 720, line * 33);
          context.strokeStyle = line % 3 ? 'rgba(65,39,20,0.14)' : 'rgba(255,235,200,0.12)';
          context.lineWidth = 2 + line % 4;
          context.stroke();
        }
        const shade = context.createLinearGradient(0, 0, 720, 900);
        shade.addColorStop(0, 'rgba(0,0,0,0.24)');
        shade.addColorStop(0.55, 'rgba(0,0,0,0)');
        shade.addColorStop(1, 'rgba(255,255,255,0.10)');
        context.fillStyle = shade;
        context.fillRect(0, 0, canvas.width, canvas.height);
      };
      draw();
      window.setInterval(draw, 100);
      const stream = (canvas as HTMLCanvasElement & { captureStream: (fps: number) => MediaStream }).captureStream(30);
      const mediaDevices = navigator.mediaDevices ?? ({} as MediaDevices);
      Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: Object.assign(Object.create(Object.getPrototypeOf(mediaDevices) ?? Object.prototype), mediaDevices, {
          getUserMedia: async () => stream,
          enumerateDevices: async () => [{ kind: 'videoinput', deviceId: 'desk-only', label: 'desk only', groupId: 'debug' }],
        }),
      });
    });
    await page.goto('http://127.0.0.1:' + address.port + '/next/', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '명함 앞면 촬영' }).click();
    await expect(page.locator('.camera-preview-stage')).toHaveAttribute('data-state', 'streaming', { timeout: 20_000 });
    const hints: Array<string | null> = [];
    for (let sample = 0; sample < 40; sample += 1) {
      hints.push(await page.locator('.camera-hint-pill span').textContent());
      await page.waitForTimeout(100);
    }
    const detectedHints = hints.filter((hint) => hint?.startsWith('인식됨'));
    console.log('CARD_QUAD_NEGATIVE', JSON.stringify({ finalHint: hints[hints.length - 1], detectedSamples: detectedHints.length }));
    expect(detectedHints).toHaveLength(0);
  } finally {
    await new Promise<void>((stop) => {
      server.close(() => stop());
      server.closeAllConnections();
    });
  }
});
