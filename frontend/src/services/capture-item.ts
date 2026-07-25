import type { CaptureQueueItem, QuickName } from '../contracts/capture';
import type { CapturedCameraFrame } from './camera';

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function createCaptureId(now = new Date(), random: () => number = Math.random): string {
  return `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`
    + `-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`
    + `-${random().toString(36).slice(2, 6)}`;
}

export function buildQueuedCapture(
  frame: CapturedCameraFrame,
  options: { quickName?: QuickName | null; now?: Date; random?: () => number } = {},
): CaptureQueueItem {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const match = /^data:image\/jpeg;base64,(.+)$/.exec(frame.dataUrl);
  if (!match?.[1]) throw new Error('invalid_camera_frame');

  return {
    captureId: createCaptureId(now, random),
    capturedAt: now.toISOString(),
    event: '',
    relSelf: '',
    relKairen: '',
    memo: '',
    note: '',
    disp: '',
    images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: match[1] }],
    quickName: options.quickName ?? null,
    researchInstruction: null,
    state: 'queued',
    tries: 0,
    thumb: '',
  };
}
