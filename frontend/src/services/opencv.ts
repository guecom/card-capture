export interface Point {
  x: number;
  y: number;
}

export function orderQuad(points: Point[]): Point[] {
  const bySum = points.slice().sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const byDifference = points.slice().sort((a, b) => (a.y - a.x) - (b.y - b.x));
  return [bySum[0], byDifference[0], bySum[3], byDifference[3]];
}

export function plausibleCard(quad: Point[]): boolean {
  if (quad.length !== 4) return false;
  const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.max(distance(quad[0], quad[1]), distance(quad[3], quad[2]));
  const height = Math.max(distance(quad[0], quad[3]), distance(quad[1], quad[2]));
  if (width < 20 || height < 20) return false;
  const ratio = width / height;
  return (ratio >= 1.15 && ratio <= 2.7) || (ratio >= 0.37 && ratio <= 0.87);
}

// 파일만 미리 받아 HTTP 캐시에 넣는다 — 실행·컴파일이 아니므로 메인 스레드를 막지 않고,
// 워커의 importScripts가 캐시에서 즉시 읽게 된다.
export function prefetchOpenCv(): void {
  if (typeof fetch !== 'function') return;
  void fetch(new URL('../vendor/opencv.js', document.baseURI).href, { cache: 'force-cache' }).catch(() => undefined);
}

// ── OpenCV Web Worker 클라이언트 ──
// 엔진 로드·WASM 컴파일·감지·warp가 전부 워커에서 돌아 메인 스레드는 어떤 시점에도 잠기지 않는다
// (2026-07-26 실폰 프리즈: prefetch+지연 실행만으로는 컴파일 블로킹이 카메라 진입 시점에 남았다).

export interface OpenCvAnalysis {
  quad: Point[] | null;
  blur: number | null;
  clippedRatio: number;
}

export interface OpenCvWorkerClient {
  ready: Promise<boolean>;
  isReady(): boolean;
  /** 라이브 프레임 분석. 이전 분석이 진행 중이면 프레임을 버리고 null을 반환한다(자연 스로틀). */
  analyze(image: ImageData, options: { minAreaRatio: number; fast: boolean; withGate: boolean }): Promise<OpenCvAnalysis | null>;
  /** 원본 해상도에서 명함 감지·perspective 보정. 실패·미감지·타임아웃이면 null. */
  rectify(image: ImageData, timeoutMs?: number): Promise<ImageData | null>;
  blurScore(image: ImageData, timeoutMs?: number): Promise<number | null>;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  quad?: Point[] | null;
  blur?: number | null;
  clippedRatio?: number;
  image?: ImageData | null;
}

let clientSingleton: OpenCvWorkerClient | null = null;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); })
      .catch(() => { window.clearTimeout(timer); resolve(fallback); });
  });
}

export function getOpenCvWorker(): OpenCvWorkerClient {
  if (clientSingleton) return clientSingleton;

  let worker: Worker | null = null;
  const pending = new Map<number, (reply: WorkerReply) => void>();
  let nextId = 1;
  let readyState = false;
  let analyzeInFlight = false;

  function post<T>(message: Record<string, unknown>, transfer: Transferable[], map: (reply: WorkerReply) => T, fallback: T): Promise<T> {
    if (!worker) return Promise.resolve(fallback);
    const id = nextId;
    nextId += 1;
    return new Promise<T>((resolve) => {
      pending.set(id, (reply) => resolve(reply.ok ? map(reply) : fallback));
      worker?.postMessage({ id, ...message }, transfer);
    });
  }

  const ready = new Promise<boolean>((resolve) => {
    try {
      // classic worker: 내부 importScripts가 vendor/opencv.js를 워커 스레드에서 로드·컴파일한다.
      worker = new Worker(new URL('../workers/opencv-worker.ts', import.meta.url));
      worker.onmessage = (messageEvent: MessageEvent<WorkerReply>) => {
        const reply = messageEvent.data;
        const resolver = pending.get(reply.id);
        if (resolver) {
          pending.delete(reply.id);
          resolver(reply);
        }
      };
      worker.onerror = () => {
        readyState = false;
        resolve(false);
      };
      const vendorUrl = new URL('../vendor/opencv.js', document.baseURI).href;
      void post({ type: 'init', vendorUrl }, [], () => true, false).then((ok) => {
        readyState = ok;
        resolve(ok);
      });
    } catch {
      resolve(false);
    }
  });

  clientSingleton = {
    ready,
    isReady: () => readyState,
    analyze(image, options) {
      if (!readyState || analyzeInFlight) return Promise.resolve(null);
      analyzeInFlight = true;
      return post(
        { type: 'analyze', image, minAreaRatio: options.minAreaRatio, fast: options.fast, withGate: options.withGate },
        [image.data.buffer],
        (reply) => ({ quad: reply.quad ?? null, blur: reply.blur ?? null, clippedRatio: reply.clippedRatio ?? 0 }),
        null as OpenCvAnalysis | null,
      ).finally(() => { analyzeInFlight = false; });
    },
    rectify(image, timeoutMs = 4_000) {
      if (!readyState) return Promise.resolve(null);
      return withTimeout(
        post({ type: 'rectify', image }, [image.data.buffer], (reply) => reply.image ?? null, null as ImageData | null),
        timeoutMs,
        null,
      );
    },
    blurScore(image, timeoutMs = 1_500) {
      if (!readyState) return Promise.resolve(null);
      return withTimeout(
        post({ type: 'blur', image }, [image.data.buffer], (reply) => reply.blur ?? null, null as number | null),
        timeoutMs,
        null,
      );
    },
  };
  return clientSingleton;
}
