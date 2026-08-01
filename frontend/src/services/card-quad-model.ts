import { inspectCardQuad, orderQuad, type Point } from './opencv';

export interface LearnedCardQuad {
  quad: Point[] | null;
  confidence: number;
}

export interface CardQuadModelClient {
  ready: Promise<boolean>;
  isReady(): boolean;
  detect(image: ImageData, timeoutMs?: number): Promise<LearnedCardQuad | null>;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  quad?: Point[] | null;
  confidence?: number;
}

const MODEL_PATH = '../vendor/cardquad/lcnet100_h_e_bifpn_256_fp32.onnx';
const MODEL_SHA256 = 'f4117b786e3a18470f3865c93f3c2bd69d9b998edd60f385574a5c665e79594e';
let clientSingleton: CardQuadModelClient | null = null;

export function cardQuadModelMetadata(): { path: string; sha256: string } {
  return { path: MODEL_PATH, sha256: MODEL_SHA256 };
}

export function prefetchCardQuadModelAssets(): void {
  if (typeof fetch !== 'function') return;
  void fetch(new URL(MODEL_PATH, document.baseURI).href, { cache: 'force-cache' }).catch(() => undefined);
  void fetch(new URL('../vendor/ort/ort-wasm-simd-threaded.wasm', document.baseURI).href, { cache: 'force-cache' }).catch(() => undefined);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); })
      .catch(() => { window.clearTimeout(timer); resolve(fallback); });
  });
}

export function getCardQuadModelWorker(): CardQuadModelClient {
  if (clientSingleton) return clientSingleton;
  let worker: Worker | null = null;
  const pending = new Map<number, (reply: WorkerReply) => void>();
  let nextId = 1;
  let readyState = false;
  let detectInFlight = false;

  function post<T>(
    message: Record<string, unknown>,
    transfer: Transferable[],
    map: (reply: WorkerReply) => T,
    fallback: T,
  ): Promise<T> {
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
      worker = new Worker(new URL('../workers/card-quad-worker.ts', import.meta.url), { type: 'module' });
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
      void post({
        type: 'init',
        ortBase: new URL('../vendor/ort/', document.baseURI).href,
        model: new URL(MODEL_PATH, document.baseURI).href,
      }, [], () => true, false).then((ok) => {
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
    detect(image, timeoutMs = 2_500) {
      if (!readyState || detectInFlight) return Promise.resolve(null);
      detectInFlight = true;
      return withTimeout(
        post(
          { type: 'detect', image },
          [image.data.buffer],
          (reply) => {
            const inspection = reply.quad ? inspectCardQuad(reply.quad) : null;
            if (!inspection?.valid || (reply.confidence ?? 0) < 0.3) {
              return { quad: null, confidence: reply.confidence ?? 0 };
            }
            return { quad: orderQuad(inspection.ordered), confidence: reply.confidence ?? 0 };
          },
          null as LearnedCardQuad | null,
        ),
        timeoutMs,
        null,
      ).finally(() => { detectInFlight = false; });
    },
  };
  return clientSingleton;
}
