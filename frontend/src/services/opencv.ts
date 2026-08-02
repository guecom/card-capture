export interface Point {
  x: number;
  y: number;
}

const MIN_CORNER_DISTANCE = 8;
const MIN_TURN_SINE = Math.sin((18 * Math.PI) / 180);

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function signedArea(points: Point[]): number {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    total += current.x * next.y - next.x * current.y;
  }
  return total / 2;
}

export function orderQuad(points: Point[]): Point[] {
  if (points.length !== 4) return points.slice();
  const center = points.reduce((sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }), { x: 0, y: 0 });
  let ordered = points.slice().sort((a, b) => Math.atan2(a.y - center.y, a.x - center.x) - Math.atan2(b.y - center.y, b.x - center.x));
  if (signedArea(ordered) < 0) ordered = ordered.reverse();
  const first = ordered.reduce((best, point, index) => {
    const score = point.x + point.y;
    const bestScore = ordered[best].x + ordered[best].y;
    if (score !== bestScore) return score < bestScore ? index : best;
    if (point.y !== ordered[best].y) return point.y < ordered[best].y ? index : best;
    return point.x < ordered[best].x ? index : best;
  }, 0);
  return [...ordered.slice(first), ...ordered.slice(0, first)];
}

export type QuadInspection = {
  valid: boolean;
  reason: 'ok' | 'point-count' | 'non-finite' | 'duplicate-corner' | 'non-convex' | 'extreme-angle' | 'too-small' | 'shape-collapse' | 'aspect-ratio';
  ordered: Point[];
  aspect: number;
};

export function inspectCardQuad(quad: Point[]): QuadInspection {
  if (quad.length !== 4) return { valid: false, reason: 'point-count', ordered: quad.slice(), aspect: 0 };
  if (quad.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return { valid: false, reason: 'non-finite', ordered: quad.slice(), aspect: 0 };
  }
  const ordered = orderQuad(quad);
  for (let left = 0; left < ordered.length; left += 1) {
    for (let right = left + 1; right < ordered.length; right += 1) {
      if (distance(ordered[left], ordered[right]) < MIN_CORNER_DISTANCE) return { valid: false, reason: 'duplicate-corner', ordered, aspect: 0 };
    }
  }

  let turnSign = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const previous = ordered[(index + 3) % 4];
    const current = ordered[index];
    const next = ordered[(index + 1) % 4];
    const ax = current.x - previous.x; const ay = current.y - previous.y;
    const bx = next.x - current.x; const by = next.y - current.y;
    const magnitude = Math.hypot(ax, ay) * Math.hypot(bx, by);
    if (!magnitude) return { valid: false, reason: 'duplicate-corner', ordered, aspect: 0 };
    const cross = ax * by - ay * bx;
    const sine = cross / magnitude;
    if (Math.abs(sine) < MIN_TURN_SINE) return { valid: false, reason: 'extreme-angle', ordered, aspect: 0 };
    const sign = Math.sign(cross);
    if (!turnSign) turnSign = sign;
    else if (sign !== turnSign) return { valid: false, reason: 'non-convex', ordered, aspect: 0 };
  }

  const top = distance(ordered[0], ordered[1]);
  const right = distance(ordered[1], ordered[2]);
  const bottom = distance(ordered[2], ordered[3]);
  const left = distance(ordered[3], ordered[0]);
  const width = (top + bottom) / 2;
  const height = (left + right) / 2;
  if (Math.min(width, height) < 20) return { valid: false, reason: 'too-small', ordered, aspect: 0 };
  if (Math.max(top, bottom) / Math.min(top, bottom) > 3 || Math.max(left, right) / Math.min(left, right) > 3) {
    return { valid: false, reason: 'shape-collapse', ordered, aspect: 0 };
  }
  const boxWidth = Math.max(...ordered.map((point) => point.x)) - Math.min(...ordered.map((point) => point.x));
  const boxHeight = Math.max(...ordered.map((point) => point.y)) - Math.min(...ordered.map((point) => point.y));
  const fill = boxWidth > 0 && boxHeight > 0 ? Math.abs(signedArea(ordered)) / (boxWidth * boxHeight) : 0;
  if (fill < 0.42) return { valid: false, reason: 'shape-collapse', ordered, aspect: 0 };
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect < 1.15 || aspect > 2.7) return { valid: false, reason: 'aspect-ratio', ordered, aspect };
  return { valid: true, reason: 'ok', ordered, aspect };
}

export function plausibleCard(quad: Point[]): boolean {
  return inspectCardQuad(quad).valid;
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
  analyze(image: ImageData, options: { minAreaRatio: number; fast: boolean; withGate: boolean; previousQuad?: Point[] | null }): Promise<OpenCvAnalysis | null>;
  /** 화면에서 이미 잡은 사각형으로 perspective 보정. 실패·타임아웃이면 null. */
  warp(image: ImageData, quad: Point[], timeoutMs?: number): Promise<ImageData | null>;
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
        { type: 'analyze', image, minAreaRatio: options.minAreaRatio, fast: options.fast, withGate: options.withGate, previousQuad: options.previousQuad ?? null },
        [image.data.buffer],
        (reply) => ({ quad: reply.quad ?? null, blur: reply.blur ?? null, clippedRatio: reply.clippedRatio ?? 0 }),
        null as OpenCvAnalysis | null,
      ).finally(() => { analyzeInFlight = false; });
    },
    warp(image, quad, timeoutMs = 4_000) {
      if (!readyState) return Promise.resolve(null);
      return withTimeout(
        post({ type: 'warp', image, quad }, [image.data.buffer], (reply) => reply.image ?? null, null as ImageData | null),
        timeoutMs,
        null,
      );
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
