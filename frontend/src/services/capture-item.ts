import type { CaptureQueueItem, QuickName, ResearchInstruction } from '../contracts/capture';
import type { CapturedCameraFrame } from './camera';

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export function createCaptureId(now = new Date(), random: () => number = Math.random): string {
  return `${now.getFullYear()}${twoDigits(now.getMonth() + 1)}${twoDigits(now.getDate())}`
    + `-${twoDigits(now.getHours())}${twoDigits(now.getMinutes())}${twoDigits(now.getSeconds())}`
    + `-${random().toString(36).slice(2, 6)}`;
}

export function buildLegacyNote(relSelf: string, relKairen: string, memo: string): string {
  return [
    relSelf.trim() && `나와의 관계: ${relSelf.trim()}`,
    relKairen.trim() && `Kairen과의 관계: ${relKairen.trim()}`,
    memo.trim() && `메모: ${memo.trim()}`,
  ].filter(Boolean).join('\n');
}

export function buildQueuedCapture(
  frame: CapturedCameraFrame,
  options: {
    backFrame?: CapturedCameraFrame | null;
    event?: string;
    relSelf?: string;
    relKairen?: string;
    memo?: string;
    quickName?: QuickName | null;
    researchInstruction?: ResearchInstruction | null;
    now?: Date;
    random?: () => number;
  } = {},
): CaptureQueueItem {
  const now = options.now ?? new Date();
  const random = options.random ?? Math.random;
  const match = /^data:image\/jpeg;base64,(.+)$/.exec(frame.dataUrl);
  if (!match?.[1]) throw new Error('invalid_camera_frame');
  const backMatch = options.backFrame ? /^data:image\/jpeg;base64,(.+)$/.exec(options.backFrame.dataUrl) : null;
  if (options.backFrame && !backMatch?.[1]) throw new Error('invalid_back_camera_frame');
  const event = options.event?.trim() ?? '';
  const relSelf = options.relSelf?.trim() ?? '';
  const relKairen = options.relKairen?.trim() ?? '';
  const memo = options.memo?.trim() ?? '';
  const note = buildLegacyNote(relSelf, relKairen, memo);
  const images: CaptureQueueItem['images'] = [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: match[1] }];
  if (backMatch?.[1]) images.push({ name: 'back.jpg', mime: 'image/jpeg', dataB64: backMatch[1] });

  return {
    captureId: createCaptureId(now, random),
    capturedAt: now.toISOString(),
    event,
    relSelf,
    relKairen,
    memo,
    note,
    disp: memo || relSelf || relKairen,
    images,
    quickName: options.quickName ?? null,
    researchInstruction: options.researchInstruction ?? null,
    state: 'queued',
    tries: 0,
    thumb: '',
  };
}
