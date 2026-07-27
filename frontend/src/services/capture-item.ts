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

// 구버전 큐 항목(라벨 합성 note만 있는 경우)을 관계 필드로 되돌린다 (legacy parseNoteLegacy).
export function parseLegacyNote(note: string | undefined): { relSelf: string; relKairen: string; memo: string } {
  const parsed = { relSelf: '', relKairen: '', memo: '' };
  String(note ?? '').split('\n').forEach((line) => {
    if (line.startsWith('나와의 관계: ')) parsed.relSelf = line.slice('나와의 관계: '.length);
    else if (line.startsWith('Kairen과의 관계: ')) parsed.relKairen = line.slice('Kairen과의 관계: '.length);
    else if (line.startsWith('메모: ')) parsed.memo = line.slice('메모: '.length);
    else if (line.trim()) parsed.memo = parsed.memo ? `${parsed.memo} ${line.trim()}` : line.trim();
  });
  return parsed;
}

/** 되돌린 촬영을 다시 촬영 초안으로 펼치기 위한 값 (FI-049). */
export interface RestoredCaptureDraft {
  /** 앞면 data URL. 없으면 되돌릴 것이 없다. */
  front: string;
  /** 뒷면 data URL 또는 빈 문자열. */
  back: string;
  event: string;
  relSelf: string;
  relKairen: string;
  memo: string;
  quickName: QuickName | null;
}

function storedImageDataUrl(item: CaptureQueueItem, name: 'front.jpg' | 'back.jpg'): string {
  const image = item.images.find((candidate) => candidate.name === name && candidate.dataB64);
  return image?.dataB64 ? `data:${image.mime ?? 'image/jpeg'};base64,${image.dataB64}` : '';
}

/**
 * 대기열에서 빼낸 항목을 촬영 초안으로 되돌린다 (FI-049).
 * 구버전 항목(관계 필드 없이 note만 있는 경우)도 같은 방식으로 되살린다 — 되돌리기가
 * 예전에 저장된 촬영에서 맥락을 잃어버리면 안 된다.
 */
export function restoredDraftOf(item: CaptureQueueItem): RestoredCaptureDraft {
  const legacy = item.relSelf === undefined && item.relKairen === undefined && item.memo === undefined
    ? parseLegacyNote(item.note)
    : null;
  return {
    front: storedImageDataUrl(item, 'front.jpg'),
    back: storedImageDataUrl(item, 'back.jpg'),
    event: item.event?.trim() ?? '',
    relSelf: (legacy?.relSelf ?? item.relSelf ?? '').trim(),
    relKairen: (legacy?.relKairen ?? item.relKairen ?? '').trim(),
    memo: (legacy?.memo ?? item.memo ?? '').trim(),
    quickName: item.quickName ?? null,
  };
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
