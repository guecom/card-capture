import type { BriefItem, CaptureQueueItem, QuickName, ResearchInstruction } from '../contracts/capture';
import type { CapturedCameraFrame } from './camera';
import type { StageStat } from './stage-telemetry';
import { createCorrelationId, traceCapture } from './trace';

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

  const item: CaptureQueueItem = {
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
    // 여정은 여기서 시작한다 (FI-021). 클라이언트 진단 전용이라 업로드 payload에는 들어가지 않는다.
    correlationId: createCorrelationId(random),
  };
  // 기록되는 것은 식별자와 단계뿐이다 — 위의 자유 입력 값은 어느 것도 로그로 가지 않는다.
  traceCapture(item, 'created');
  return item;
}

/* ══════════════════════════════════════════════════════════════════════════
   기다리는 자리의 상태 (TSK-000531 / ISS-000232)

   founder 실측 2026-08-04:
     "조사 지시 PER-418이 진행 중인데, 이거 다시 처리 요청해도 안 되고, 뭐 반응이 없어서"

   그 receipt는 워처에서 requeue 2회 x 처리기 exit 1 3회 = 연속 실패 6회로 멈춰 있었다.
   화면은 그 사실을 몰랐기 때문에 **아무 일도 하지 않는 `다시 처리 요청` 버튼**을 계속 보여 줬다.
   여기서 고치는 것은 그 버튼이 아니라 **화면이 아는 것과 실제로 일어난 일 사이의 간격**이다.

   워처는 이제 캡처 폴더의 capture.json에 닫힌 영수증을 남긴다(`attention`과 같은 길):
     recovery = { kind, reasonCode, attempts, failures, threshold, since }
   그 값은 서버 목록 JSON을 거쳐 여기로 온다. 목록 JSON은 신뢰하지 않는다 — `captureAttentionOf`와
   같은 규율로 **좁히기만** 한다. 서버가 무엇을 보내든 화면에 닿는 것은 아래 닫힌 집합뿐이다.
   ══════════════════════════════════════════════════════════════════════════ */

/** 워처가 증명한 두 상태. 하나는 '기다리면 된다', 하나는 '같은 방법으로는 안 된다'이다. */
export type CaptureRecoveryKind = 'retry_scheduled' | 'recovery_required';

/** 실패 원인 분류. 워처 `Get-FailureCauseClass`의 닫힌 enum과 같은 집합이다. */
export type CaptureRecoveryReason =
  | 'processor_failed'
  | 'processor_timeout'
  | 'result_incomplete'
  | 'internal_state_failed'
  | 'unknown_failure';

export interface CaptureRecovery {
  kind: CaptureRecoveryKind;
  reasonCode: CaptureRecoveryReason;
  /** 지금 예산에서 소진한 시도 수. */
  attempts: number;
  /** 같은 원인으로 누적된 실패 수 (requeue로 초기화되지 않는다). */
  failures: number;
  /** 잠금 임계값. 워처가 격리 정책에서 유도한 값이며 화면이 지어내지 않는다. */
  threshold: number;
  /** 이 상태가 된 시각 (ISO). 파싱되지 않으면 경과를 말하지 않는다. */
  since: string;
}

/**
 * 사용자에게 보이는 문구. `reasonCode`를 그대로 찍지 않는다 —
 * 사용자에게 `processor_failed`는 아무 뜻도 아니다.
 * `cause`는 무슨 일이 있었나, `action`은 지금 무엇을 할 수 있나만 말한다.
 */
export const RECOVERY_REASON_COPY: Record<CaptureRecoveryReason, { cause: string; action: string }> = {
  processor_failed: {
    cause: '정리 작업이 도중에 멈췄어요',
    action: '같은 방식으로 다시 요청해도 같은 자리에서 멈춰요. 사진과 요청 내용은 그대로 남아 있으니, 아래로 알려 주시면 원인을 확인하고 이어서 처리할게요.',
  },
  processor_timeout: {
    cause: '정해진 시간 안에 끝나지 않아 중단됐어요',
    action: '찾아볼 범위가 넓으면 시간 안에 못 끝낼 수 있어요. 범위를 좁혀 새로 요청하거나, 아래로 알려 주시면 이어서 처리할게요.',
  },
  result_incomplete: {
    cause: '결과가 끝까지 만들어지지 않았어요',
    action: '만들다 만 결과는 저장하지 않고 되돌렸어요. 원본은 그대로예요. 아래로 알려 주시면 확인하고 이어서 처리할게요.',
  },
  internal_state_failed: {
    cause: '처리 기록을 저장하지 못했어요',
    action: '결과를 잃지 않으려고 처리를 멈춘 상태예요. 원본은 그대로예요. 아래로 알려 주시면 확인하고 이어서 처리할게요.',
  },
  unknown_failure: {
    cause: '확인되지 않은 이유로 멈췄어요',
    action: '원본과 요청 내용은 그대로 남아 있어요. 아래로 알려 주시면 원인을 확인하고 이어서 처리할게요.',
  },
};

function finiteCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

/**
 * 목록 JSON은 untrusted다. 아는 모양만 통과시키고 나머지는 없는 것으로 본다.
 * 계약(`contracts/capture.ts`)에 필드를 먼저 뚫지 않는 이유는 `captureAttentionOf`와 같다 —
 * "서버가 늘 준다"는 거짓 보장을 타입으로 남기지 않기 위해서다.
 */
export function captureRecoveryOf(item?: BriefItem | null): CaptureRecovery | null {
  const raw = (item as { recovery?: unknown } | null | undefined)?.recovery as Partial<CaptureRecovery> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.kind !== 'retry_scheduled' && raw.kind !== 'recovery_required') return null;
  if (typeof raw.reasonCode !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(RECOVERY_REASON_COPY, raw.reasonCode)) return null;
  return {
    kind: raw.kind,
    reasonCode: raw.reasonCode as CaptureRecoveryReason,
    attempts: finiteCount(raw.attempts),
    failures: finiteCount(raw.failures),
    threshold: finiteCount(raw.threshold),
    since: typeof raw.since === 'string' ? raw.since : '',
  };
}

/**
 * "언제부터 이 상태인가". 멈춘 것에는 반드시 경과가 붙어야 한다 — 경과가 없으면 사용자는
 * 방금 생긴 일인지 하루 지난 일인지 알 수 없다. 시각을 읽지 못하면 지어내지 않고 침묵한다.
 */
export function recoveryElapsedText(since: string, now: number = Date.now()): string | null {
  const at = Date.parse(String(since ?? ''));
  if (Number.isNaN(at)) return null;
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 0) return null;
  if (minutes < 1) return '방금부터';
  if (minutes < 60) return `${minutes}분째`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간째`;
  return `${Math.floor(hours / 24)}일째`;
}

/** 기다리는 자리에서 서로 다르게 말해야 하는 상태들. 각각 할 수 있는 일이 다르다. */
export type CaptureFlowState =
  | 'not_started'
  | 'processing'
  | 'delayed'
  | 'retry_scheduled'
  | 'recovery_required'
  | 'done';

export interface CaptureFlow {
  state: CaptureFlowState;
  /** 이 상태에서 `다시 처리 요청`이 의미가 있는가. 없으면 화면에 두지 않는다. */
  canRequeue: boolean;
  /** 화면이 덧붙일 한 줄. 표준 진행 문구와 겹치는 말은 하지 않는다. */
  note: string;
}

/**
 * 상태 판정. 지어낸 임계값을 쓰지 않는 것이 이 함수의 규칙이다.
 *   `retry_scheduled` / `recovery_required` — 워처가 남긴 영수증(관측된 사실)
 *   `delayed` — **이 기기가 실제로 본** 이 단계의 보통 범위 위끝(75분위)을 넘겼을 때만.
 *               관측이 없으면 지연이라고 말하지 않는다.
 */
export function captureFlowStateOf(input: {
  status?: string;
  recovery?: CaptureRecovery | null;
  elapsedMinutes?: number | null;
  stageStat?: StageStat | null;
  minSamples?: number;
}): CaptureFlow {
  const status = String(input.status ?? '');
  if (status === 'processed' || status === 'skipped') {
    return { state: 'done', canRequeue: false, note: '' };
  }
  const recovery = input.recovery ?? null;
  if (recovery?.kind === 'recovery_required') {
    return { state: 'recovery_required', canRequeue: false, note: RECOVERY_REASON_COPY[recovery.reasonCode].cause };
  }
  if (recovery?.kind === 'retry_scheduled') {
    const budget = recovery.threshold > 0 ? ` · 같은 문제 ${recovery.failures}/${recovery.threshold}회` : '';
    return {
      state: 'retry_scheduled',
      canRequeue: true,
      note: `한 번 실패해서 곧 자동으로 다시 시도해요 (${recovery.attempts}번째 시도)${budget}`,
    };
  }
  const stat = input.stageStat ?? null;
  const minSamples = input.minSamples ?? 2;
  const elapsed = input.elapsedMinutes;
  if (stat && stat.samples >= minSamples && typeof elapsed === 'number' && Number.isFinite(elapsed)
    && elapsed * 60_000 > stat.highMs) {
    return {
      state: 'delayed',
      canRequeue: true,
      note: '이 기기에서 보통 걸리던 시간보다 오래 걸리고 있어요',
    };
  }
  if (status === 'processing') return { state: 'processing', canRequeue: true, note: '' };
  return { state: 'not_started', canRequeue: true, note: '' };
}
