// PP-OCRv5(한국어) 빠른 이름 인식 전용 Web Worker (TSK-000236).
// onnxruntime-web WASM 컴파일·추론과 ppu-paddle-ocr 파이프라인이 전부 이 스레드에서 돌아
// 카메라 UI는 어떤 시점에도 잠기지 않는다 (TSK-000230 교훈). 모든 자산은 자체 호스팅이며
// 외부로 이미지가 전송되지 않는다 — 유일한 CDN 폴백 경로는 window 존재 시에만 발동하므로
// 워커에서는 도달 불가이고, wasmPaths도 아래 init에서 명시 지정한다.
import * as ort from 'onnxruntime-web';
import { PaddleOcrService } from 'ppu-paddle-ocr/web';

// 라이브러리의 웹 플랫폼 계층이 내부 버퍼 캔버스를 document.createElement로 만든다 —
// 워커에는 document가 없으므로 OffscreenCanvas를 돌려주는 최소 shim을 둔다.
const workerScope = self as unknown as {
  document?: { createElement: (tag: string) => unknown };
  HTMLCanvasElement?: unknown;
  HTMLImageElement?: unknown;
};
if (typeof workerScope.document === 'undefined') {
  workerScope.document = {
    createElement: (tag: string) => (tag === 'canvas' ? new OffscreenCanvas(1, 1) : undefined),
  };
}
// 라이브러리 isCanvas가 가드 없이 `x instanceof HTMLCanvasElement`를 평가한다 —
// 워커에는 그 전역이 없어 ReferenceError가 나므로 항상 false가 되는 더미 클래스를 둔다.
if (typeof workerScope.HTMLCanvasElement === 'undefined') workerScope.HTMLCanvasElement = class {};
if (typeof workerScope.HTMLImageElement === 'undefined') workerScope.HTMLImageElement = class {};

let service: PaddleOcrService | null = null;

interface InitMessage {
  id: number;
  type: 'init';
  ortBase: string;
  detection: string;
  recognition: string;
  dictionary: string;
}

interface RecognizeMessage {
  id: number;
  type: 'recognize';
  image: ImageData;
}

self.onmessage = async (messageEvent: MessageEvent<InitMessage | RecognizeMessage>) => {
  const message = messageEvent.data;
  try {
    if (message.type === 'init') {
      ort.env.wasm.wasmPaths = message.ortBase;
      // Pages에는 COOP/COEP가 없어 SharedArrayBuffer 불가 — 단일 스레드 WASM로 고정한다.
      ort.env.wasm.numThreads = 1;
      service = new PaddleOcrService({
        model: {
          detection: message.detection,
          recognition: message.recognition,
          charactersDictionary: message.dictionary,
        },
      });
      await service.initialize();
      self.postMessage({ id: message.id, ok: true });
      return;
    }
    if (message.type === 'recognize') {
      if (!service?.isInitialized()) {
        self.postMessage({ id: message.id, ok: false });
        return;
      }
      const canvas = new OffscreenCanvas(message.image.width, message.image.height);
      canvas.getContext('2d')?.putImageData(message.image, 0, 0);
      const result = await service.recognize(canvas, { flatten: true });
      self.postMessage({
        id: message.id,
        ok: true,
        width: message.image.width,
        height: message.image.height,
        results: result.results.map((item) => ({ text: item.text, confidence: item.confidence, box: item.box })),
      });
      return;
    }
    self.postMessage({ id: (message as { id: number }).id, ok: false });
  } catch (error) {
    console.error('[quickocr-worker]', error instanceof Error ? error.message : String(error));
    self.postMessage({ id: message.id, ok: false });
  }
};
