// 이름 인식 벤치 (TSK-000249): 실제 PP-OCR 워커 + 실제 픽커로 명함 레이아웃 매트릭스를 돌려
// "사람 이름을 정확히 뽑는가"를 수치로 잰다.
//
// 왜 필요한가: founder 판정 "이름 인식이 허접하다. 이강규인데 강규라고 잡는다. 다른 것도 잡는다."
// 픽커만 단위 테스트하면 OCR이 실제로 뱉는 줄(띄어쓰기 분리·글자 누락·오인식)을 못 본다.
// 여기서는 실제 엔진이 뱉은 줄을 실제 픽커에 그대로 먹인다 — 어느 쪽이 틀렸는지 분리해서 보인다.
import { expect, test } from '@playwright/test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nameFromOcrWords, type OcrWord } from '../src/services/quickname-picker';

const buildRoot = resolve(fileURLToPath(new URL('../../docs/', import.meta.url)));
const outDir = resolve(fileURLToPath(new URL('../test-results/', import.meta.url)));

const types: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm',
  '.css': 'text/css', '.json': 'application/json', '.txt': 'text/plain', '.onnx': 'application/octet-stream',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json',
};

function serve(): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
      if (path.endsWith('/')) path += 'index.html';
      const file = resolve(buildRoot, path);
      if (file !== buildRoot && !file.startsWith(`${buildRoot}${sep}`)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      response.end(body);
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  server.keepAliveTimeout = 1;
  return new Promise((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => ok(server)); });
}

// 실사에 가까운 명함 레이아웃 매트릭스. 전부 가상 인물·가상 회사다 (저장소 규칙: 실명함 fixture 금지).
interface Layout {
  name: string;          // 시나리오 이름
  expect: string;        // 뽑혀야 하는 사람 이름
  scale?: number;        // 캡처 해상도 배율 (작게 찍힌 명함 재현)
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void;
}

const LAYOUTS: Layout[] = [
  {
    name: 'logo-first', expect: '강수민',
    draw: (context, width, height) => {
      context.fillStyle = '#2b3440';
      context.font = `600 ${Math.round(height * 0.11)}px sans-serif`;
      context.letterSpacing = `${Math.round(height * 0.02)}px`;
      context.fillText('NOVARO', width * 0.06, height * 0.24);
      context.letterSpacing = '0px';
      context.font = `700 ${Math.round(height * 0.1)}px "Malgun Gothic", sans-serif`;
      context.fillText('강수민', width * 0.06, height * 0.55);
      context.fillStyle = '#7b8794';
      context.font = `400 ${Math.round(height * 0.055)}px "Malgun Gothic", sans-serif`;
      context.fillText('Founder', width * 0.06, height * 0.66);
      context.font = `400 ${Math.round(height * 0.055)}px sans-serif`;
      context.fillText('sumin@novaro.io', width * 0.52, height * 0.56);
      context.fillText('010-2731-3568', width * 0.52, height * 0.66);
    },
  },
  {
    name: 'name-with-title-same-line', expect: '윤도현',
    draw: (context, width, height) => {
      context.fillStyle = '#1d2a3a';
      context.font = `700 ${Math.round(height * 0.12)}px "Malgun Gothic", sans-serif`;
      context.fillText('윤도현 대표이사', width * 0.07, height * 0.34);
      context.font = `500 ${Math.round(height * 0.07)}px "Malgun Gothic", sans-serif`;
      context.fillText('한빛로보틱스 주식회사', width * 0.07, height * 0.52);
      context.font = `400 ${Math.round(height * 0.06)}px sans-serif`;
      context.fillText('dohyun@hanbit.kr  02-555-0199', width * 0.07, height * 0.78);
    },
  },
  {
    name: 'company-larger-than-name', expect: '박서준',
    draw: (context, width, height) => {
      context.fillStyle = '#12324f';
      context.font = `800 ${Math.round(height * 0.15)}px "Malgun Gothic", sans-serif`;
      context.fillText('대성테크', width * 0.06, height * 0.28);
      context.fillStyle = '#333c46';
      context.font = `600 ${Math.round(height * 0.085)}px "Malgun Gothic", sans-serif`;
      context.fillText('박서준', width * 0.06, height * 0.58);
      context.font = `400 ${Math.round(height * 0.055)}px "Malgun Gothic", sans-serif`;
      context.fillText('선임연구원', width * 0.06, height * 0.7);
      context.font = `400 ${Math.round(height * 0.05)}px sans-serif`;
      context.fillText('sj.park@daesung.co.kr', width * 0.06, height * 0.88);
    },
  },
  {
    name: 'english-name-korean-company', expect: 'Daniel Park',
    draw: (context, width, height) => {
      context.fillStyle = '#20303f';
      context.font = `700 ${Math.round(height * 0.11)}px sans-serif`;
      context.fillText('Daniel Park', width * 0.07, height * 0.36);
      context.font = `400 ${Math.round(height * 0.06)}px "Malgun Gothic", sans-serif`;
      context.fillText('노바로 시스템즈 · 사업개발', width * 0.07, height * 0.52);
      context.font = `400 ${Math.round(height * 0.055)}px sans-serif`;
      context.fillText('daniel@novaro.io', width * 0.07, height * 0.76);
    },
  },
  {
    name: 'wide-letter-spacing-name', expect: '이강윤',
    draw: (context, width, height) => {
      context.fillStyle = '#2b3440';
      context.font = `600 ${Math.round(height * 0.09)}px sans-serif`;
      context.fillText('SEOLIM', width * 0.06, height * 0.22);
      context.fillStyle = '#1d2a3a';
      context.font = `700 ${Math.round(height * 0.11)}px "Malgun Gothic", sans-serif`;
      context.letterSpacing = `${Math.round(height * 0.05)}px`;   // 자간이 넓어 OCR이 토큰을 쪼갠다
      context.fillText('이강윤', width * 0.06, height * 0.55);
      context.letterSpacing = '0px';
      context.fillStyle = '#7b8794';
      context.font = `400 ${Math.round(height * 0.055)}px "Malgun Gothic", sans-serif`;
      context.fillText('책임연구원', width * 0.06, height * 0.68);
    },
  },
  {
    name: 'small-card-in-frame', expect: '최지우', scale: 0.34,   // 멀리서 찍혀 작게 담긴 명함
    draw: (context, width, height) => {
      context.fillStyle = '#1d2a3a';
      context.font = `700 ${Math.round(height * 0.13)}px "Malgun Gothic", sans-serif`;
      context.fillText('최지우', width * 0.07, height * 0.42);
      context.font = `400 ${Math.round(height * 0.07)}px "Malgun Gothic", sans-serif`;
      context.fillText('마케팅 팀장', width * 0.07, height * 0.6);
      context.font = `400 ${Math.round(height * 0.06)}px sans-serif`;
      context.fillText('jiwoo@brightlab.kr', width * 0.07, height * 0.8);
    },
  },
  {
    name: 'name-bottom-right', expect: '한서영',
    draw: (context, width, height) => {
      context.fillStyle = '#324150';
      context.font = `600 ${Math.round(height * 0.1)}px "Malgun Gothic", sans-serif`;
      context.fillText('브라이트랩', width * 0.06, height * 0.22);
      context.fillStyle = '#1d2a3a';
      context.font = `700 ${Math.round(height * 0.1)}px "Malgun Gothic", sans-serif`;
      context.fillText('한서영', width * 0.55, height * 0.72);
      context.font = `400 ${Math.round(height * 0.055)}px "Malgun Gothic", sans-serif`;
      context.fillText('이사', width * 0.55, height * 0.85);
    },
  },
  {
    name: 'all-caps-logo-and-english-name', expect: 'Jane Kim',
    draw: (context, width, height) => {
      context.fillStyle = '#111a24';
      context.font = `800 ${Math.round(height * 0.14)}px sans-serif`;
      context.fillText('ORBITAL', width * 0.06, height * 0.26);
      context.fillStyle = '#2b3440';
      context.font = `600 ${Math.round(height * 0.085)}px sans-serif`;
      context.fillText('Jane Kim', width * 0.06, height * 0.56);
      context.font = `400 ${Math.round(height * 0.055)}px sans-serif`;
      context.fillText('Head of Partnerships', width * 0.06, height * 0.68);
      context.fillText('jane.kim@orbital.dev', width * 0.06, height * 0.86);
    },
  },
  {
    name: 'company-word-lookalike', expect: '노진우',
    draw: (context, width, height) => {
      // 회사명 '로보틱스'와 사람 이름 '노진우'가 같이 있다 — 회사 어휘를 이름으로 뽑으면 안 된다.
      context.fillStyle = '#12324f';
      context.font = `700 ${Math.round(height * 0.12)}px "Malgun Gothic", sans-serif`;
      context.fillText('로보틱스', width * 0.06, height * 0.26);
      context.fillStyle = '#1d2a3a';
      context.font = `600 ${Math.round(height * 0.09)}px "Malgun Gothic", sans-serif`;
      context.fillText('노진우', width * 0.06, height * 0.58);
      context.font = `400 ${Math.round(height * 0.055)}px "Malgun Gothic", sans-serif`;
      context.fillText('연구소장', width * 0.06, height * 0.7);
    },
  },
  {
    name: 'four-char-name', expect: '남궁민수',
    draw: (context, width, height) => {
      context.fillStyle = '#1d2a3a';
      context.font = `700 ${Math.round(height * 0.11)}px "Malgun Gothic", sans-serif`;
      context.fillText('남궁민수', width * 0.07, height * 0.4);
      context.font = `400 ${Math.round(height * 0.06)}px "Malgun Gothic", sans-serif`;
      context.fillText('품질보증 담당', width * 0.07, height * 0.58);
      context.font = `400 ${Math.round(height * 0.055)}px sans-serif`;
      context.fillText('ms.namgung@qualis.kr', width * 0.07, height * 0.82);
    },
  },
];

test.use({ viewport: { width: 500, height: 900 } });

test('quick name bench over card layouts', async ({ page }) => {
  test.setTimeout(900_000);
  const server = await serve();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const ocrAsset = (await readdir(resolve(buildRoot, 'next/assets'))).find((file) => /^quickocr-worker-.*\.js$/.test(file));
  if (!ocrAsset) throw new Error('quickocr worker asset not found');

  try {
    await page.goto(`http://127.0.0.1:${address.port}/next/`, { waitUntil: 'networkidle' });
    await page.evaluate(({ asset, port }) => {
      const runtime = window as unknown as { __bench?: unknown };
      runtime.__bench = { asset, port };
    }, { asset: ocrAsset, port: address.port });

    // 워커를 한 번만 띄우고 모든 레이아웃을 흘린다.
    await page.evaluate(async () => {
      const { asset, port } = (window as unknown as { __bench: { asset: string; port: number } }).__bench;
      const worker = new Worker(`http://127.0.0.1:${port}/next/assets/${asset}`, { type: 'module' });
      let sequence = 1;
      const pending = new Map<number, (reply: Record<string, unknown>) => void>();
      worker.onmessage = (event: MessageEvent) => {
        const reply = event.data as { id: number };
        pending.get(reply.id)?.(reply as Record<string, unknown>);
        pending.delete(reply.id);
      };
      const call = (message: Record<string, unknown>, transfer: Transferable[] = []) => new Promise<Record<string, unknown>>((done) => {
        const id = sequence; sequence += 1; pending.set(id, done);
        worker.postMessage({ id, ...message }, transfer);
      });
      const base = `http://127.0.0.1:${port}`;
      const ready = await call({
        type: 'init',
        ortBase: `${base}/vendor/ort/`,
        detection: `${base}/vendor/paddleocr/PP-OCRv5_mobile_det_infer.onnx`,
        recognition: `${base}/vendor/paddleocr/korean_PP-OCRv5_mobile_rec_infer.onnx`,
        dictionary: `${base}/vendor/paddleocr/ppocrv5_korean_dict.txt`,
      });
      (window as unknown as { __ocrCall: unknown; __ocrReady: boolean }).__ocrCall = call;
      (window as unknown as { __ocrReady: boolean }).__ocrReady = Boolean(ready.ok);
    });
    expect(await page.evaluate(() => (window as unknown as { __ocrReady: boolean }).__ocrReady), 'OCR 워커 초기화 실패').toBe(true);

    const rows: Array<Record<string, unknown>> = [];
    for (const layout of LAYOUTS) {
      const words = await page.evaluate(async ({ source, scale }) => {
        const cardWidth = 900;
        const cardHeight = Math.round(cardWidth / 1.75);
        const card = document.createElement('canvas');
        card.width = cardWidth;
        card.height = cardHeight;
        const cardContext = card.getContext('2d', { willReadFrequently: true })!;
        cardContext.fillStyle = '#f5f4f0';
        cardContext.fillRect(0, 0, cardWidth, cardHeight);
        // eslint-disable-next-line no-new-func
        (new Function('context', 'width', 'height', `(${source})(context, width, height)`))(cardContext, cardWidth, cardHeight);

        // 캡처 파이프라인과 같은 전처리: 필요하면 축소해서 실제 촬영 해상도를 흉내낸다.
        const shotWidth = Math.round(cardWidth * (scale ?? 1));
        const shot = document.createElement('canvas');
        shot.width = shotWidth;
        shot.height = Math.round(cardHeight * (scale ?? 1));
        const shotContext = shot.getContext('2d', { willReadFrequently: true })!;
        shotContext.drawImage(card, 0, 0, shot.width, shot.height);

        const call = (window as unknown as { __ocrCall: (m: Record<string, unknown>, t?: Transferable[]) => Promise<Record<string, unknown>> }).__ocrCall;
        const image = shotContext.getImageData(0, 0, shot.width, shot.height);
        const result = await call({ type: 'recognize', image }, [image.data.buffer]);
        const height = (result.height as number) || shot.height;
        const width = (result.width as number) || shot.width;
        return ((result.results ?? []) as Array<{ text: string; confidence: number; box: { x: number; y: number; width: number; height: number } }>)
          .map((line) => ({
            text: line.text,
            confidence: line.confidence,
            heightRatio: height > 0 ? line.box.height / height : 0,
            centerRatio: height > 0 ? (line.box.y + line.box.height / 2) / height : 0.5,
            leftRatio: width > 0 ? line.box.x / width : 0,
          }));
      }, { source: layout.draw.toString(), scale: layout.scale ?? 1 });

      // 실제 픽커를 그대로 부른다 (여기서 규칙을 다시 구현하면 자기충족 게이트가 된다).
      const picked = nameFromOcrWords(words as OcrWord[]);
      rows.push({
        layout: layout.name,
        expected: layout.expect,
        picked: picked?.name ?? null,
        ok: picked?.name === layout.expect,
        ocr: (words as OcrWord[]).map((word) => word.text),
      });
    }

    const passed = rows.filter((row) => row.ok).length;
    console.log('QUICKNAME_BENCH', JSON.stringify({ passed, total: rows.length, rows }, null, 1));
    await writeFile(resolve(outDir, 'quickname-bench.json'), JSON.stringify({ passed, total: rows.length, rows }, null, 2));
    expect(passed, `이름 인식 정확도 ${passed}/${rows.length}`).toBe(rows.length);
  } finally {
    await new Promise<void>((k) => { server.close(() => k()); server.closeAllConnections(); });
  }
});
