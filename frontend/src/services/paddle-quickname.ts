// PP-OCRv5 빠른 이름 인식 워커 클라이언트 (TSK-000236).
// 자산은 전부 자체 호스팅(vendor/) — 이미지·텍스트가 외부로 나가지 않는다.
export interface PaddleOcrLine {
  text: string;
  /** 0..1 */
  confidence: number;
  box: { x: number; y: number; width: number; height: number };
}

export interface PaddleOcrOutput {
  width: number;
  height: number;
  results: PaddleOcrLine[];
}

export interface QuickOcrClient {
  ready: Promise<boolean>;
  isReady(): boolean;
  recognize(image: ImageData, timeoutMs?: number): Promise<PaddleOcrOutput | null>;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  width?: number;
  height?: number;
  results?: PaddleOcrLine[];
}

let clientSingleton: QuickOcrClient | null = null;

const VENDOR_FILES = [
  '../vendor/ort/ort-wasm-simd-threaded.wasm',
  '../vendor/paddleocr/PP-OCRv5_mobile_det_infer.onnx',
  '../vendor/paddleocr/korean_PP-OCRv5_mobile_rec_infer.onnx',
  '../vendor/paddleocr/ppocrv5_korean_dict.txt',
];

// 유휴 시점에 파일만 미리 받아둔다(실행 없음 → 메인 스레드 안전).
export function prefetchQuickOcrAssets(): void {
  if (typeof fetch !== 'function') return;
  VENDOR_FILES.forEach((path) => {
    void fetch(new URL(path, document.baseURI).href, { cache: 'force-cache' }).catch(() => undefined);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    promise.then((value) => { window.clearTimeout(timer); resolve(value); })
      .catch(() => { window.clearTimeout(timer); resolve(fallback); });
  });
}

export function getQuickOcrWorker(): QuickOcrClient {
  if (clientSingleton) return clientSingleton;

  let worker: Worker | null = null;
  const pending = new Map<number, (reply: WorkerReply) => void>();
  let nextId = 1;
  let readyState = false;

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
      worker = new Worker(new URL('../workers/quickocr-worker.ts', import.meta.url), { type: 'module' });
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
        detection: new URL('../vendor/paddleocr/PP-OCRv5_mobile_det_infer.onnx', document.baseURI).href,
        recognition: new URL('../vendor/paddleocr/korean_PP-OCRv5_mobile_rec_infer.onnx', document.baseURI).href,
        dictionary: new URL('../vendor/paddleocr/ppocrv5_korean_dict.txt', document.baseURI).href,
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
    recognize(image, timeoutMs = 20_000) {
      if (!readyState) return Promise.resolve(null);
      return withTimeout(
        post(
          { type: 'recognize', image },
          [image.data.buffer],
          (reply) => (reply.results ? { width: reply.width ?? image.width, height: reply.height ?? image.height, results: reply.results } : null),
          null as PaddleOcrOutput | null,
        ),
        timeoutMs,
        null,
      );
    },
  };
  return clientSingleton;
}
