import type { BriefItem, CaptureQueueItem } from '../contracts/capture';
import {
  type StageSample,
  type StageSighting,
  type StageStat,
  type StageTelemetry,
  loadStageTelemetry,
  observeStages,
  saveStageTelemetry,
  stageStats,
  typicalRangeText,
  withStageSamples,
  STAGE_SAMPLE_MAX_MS,
} from './stage-telemetry';
import { type StageWeighting, weightStages } from './stage-weights';

export type StageKey = 'upload' | 'receive' | 'process' | 'complete';
export type StageState = 'done' | 'active' | 'todo' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  /**
   * 이 칸이 막대에서 차지하는 폭 (0~1, 합은 1). 관측이 충분하면 소요시간 중앙값에 비례하고,
   * 부족하면 균등이다. 어느 쪽인지는 `CaptureProgress.weighting.confident`가 말한다 (DEC-000092 §2).
   */
  share: number;
}

export interface CaptureProgress {
  stages: Stage[];
  step: number;
  total: number;
  /** Terminal truth only: 1 means complete; non-terminal work never fabricates a percentage. */
  percent: 0 | 1;
  done: boolean;
  failed: boolean;
  late: false;
  headline: string;
  detail: string;
  /** 칸 폭의 근거. `confident`가 false면 화면은 폭으로 시간을 말하면 안 된다. */
  weighting: StageWeighting;
}

const STAGE_DEFS: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: 'upload', label: '기기에서 전송' },
  { key: 'receive', label: '서버 접수' },
  { key: 'process', label: '서버 처리' },
  { key: 'complete', label: '결과 준비' },
];

/** 진행 막대의 단계 순서. telemetry의 단계 이름도 이 키를 쓴다. */
export const CAPTURE_STAGE_KEYS: ReadonlyArray<StageKey> = STAGE_DEFS.map((definition) => definition.key);

/**
 * 모든 단계를 지난 뒤의 순위. 이 순위에는 기다림이 없으므로 표본을 만들지 않는다 —
 * 다만 마지막 단계를 **떠난 것**을 보려면 관측 자체는 필요해서 이름을 하나 둔다.
 */
export const CAPTURE_TERMINAL_RANK = STAGE_DEFS.length;
const TERMINAL_STAGE = 'done';

/**
 * 사람이 손을 대야 끝나는 종료 사유. **`contracts/capture.ts`가 아니라 여기에 둔다** —
 * `BriefItem.attention`은 지금 계약에 없는 서버 필드이고, 이 모듈만 그 값을 읽는다.
 * 계약에 필드를 먼저 뚫어 두면 "서버가 늘 준다"는 거짓 보장이 타입으로 남는다.
 * 나중에 계약이 이 필드를 정식으로 실으면 아래 판정은 그대로 통과한다 — 좁히기만 하기 때문이다.
 */
export interface CaptureAttention {
  kind: 'input_required';
  reasonCode: 'unreadable_capture' | 'missing_required_side' | 'identity_ambiguous';
  requestedAt: string;
}

const ATTENTION_DETAIL: Record<CaptureAttention['reasonCode'], string> = {
  unreadable_capture: '사진의 글자를 확실히 읽지 못했어요 · 더 선명한 사진이나 내용을 보완해 주세요',
  missing_required_side: '처리에 필요한 명함 면이 없어요 · 빠진 면을 보완해 주세요',
  identity_ambiguous: '누구의 명함인지 확정하지 못했어요 · 이름이나 회사를 확인해 주세요',
};

/** Treat list JSON as untrusted: only the bounded, user-actionable attention contract renders. */
export function captureAttentionOf(brief?: BriefItem | null): CaptureAttention | null {
  // 계약 밖 필드라 `unknown`으로 받아 하나씩 좁힌다. 서버가 무엇을 보내든 화면에 닿는 것은 아래 셋뿐이다.
  const attention = (brief as { attention?: unknown } | null | undefined)?.attention as Partial<CaptureAttention> | undefined;
  if (!attention || typeof attention !== 'object' || attention.kind !== 'input_required') return null;
  if (typeof attention.reasonCode !== 'string') return null;
  if (!Object.prototype.hasOwnProperty.call(ATTENTION_DETAIL, attention.reasonCode)) return null;
  if (typeof attention.requestedAt !== 'string' || !attention.requestedAt || Number.isNaN(Date.parse(attention.requestedAt))) return null;
  return attention as CaptureAttention;
}

/** Only map states explicitly proven by the local queue or server response. */
export function stageIndexOf(input: { brief?: BriefItem | null; queue?: CaptureQueueItem | null }): number {
  const { brief, queue } = input;
  if (brief) {
    if (brief.status === 'processed' || brief.status === 'skipped') return 4;
    if (brief.status === 'processing') return 2;
    return 1;
  }
  if (queue?.state === 'sent') return 1;
  return 0;
}

function elapsedText(minutes: number): string {
  if (minutes < 1) return '1분 미만 경과';
  if (minutes < 60) return `${Math.floor(minutes)}분 경과`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.floor(minutes % 60);
  return `${hours}시간${rest ? ` ${rest}분` : ''} 경과`;
}

/**
 * `마지막 갱신 …` — 승인 문구의 네 번째 조각 (DEC-000092 §2).
 * 이 화면이 얼마나 오래된 사실을 보여 주고 있는지를 말한다. 다음 갱신 시각은 지어내지 않는다.
 */
export function lastUpdatedText(agoMs: number | null | undefined): string | null {
  if (agoMs === null || agoMs === undefined || !Number.isFinite(agoMs)) return null;
  const ago = Math.max(0, agoMs);
  if (ago < 5_000) return '마지막 갱신 방금';
  if (ago < 60_000) return `마지막 갱신 ${Math.floor(ago / 1000)}초 전`;
  if (ago < 3_600_000) return `마지막 갱신 ${Math.floor(ago / 60_000)}분 전`;
  return `마지막 갱신 ${Math.floor(ago / 3_600_000)}시간 전`;
}

export interface CaptureProgressInput {
  brief?: BriefItem | null;
  queue?: CaptureQueueItem | null;
  elapsedMinutes?: number | null;
  /**
   * 단계별 관측 요약 (`stageStats`). 주지 않으면 칸은 균등 폭이 되고 `보통 범위`도 말하지 않는다 —
   * 없는 근거를 있는 척하지 않기 위해서다.
   */
  stageStats?: Readonly<Record<string, StageStat | null | undefined>> | null;
  /** 목록을 마지막으로 갱신한 뒤 지난 시간(ms). 없으면 `마지막 갱신` 조각을 생략한다. */
  refreshedAgoMs?: number | null;
}

/**
 * 대기 중 화면의 detail 문구 (DEC-000092 §2).
 *
 * `현재 단계 + 경과 + 보통 범위 + 마지막 갱신`이 승인안이다. 점 ETA(`약 3분 남음`)와 지어낸
 * 퍼센트는 여전히 금지다 — 관측된 **범위**는 추정이 아니라 이 기기가 실제로 본 값이라 허용된다.
 * 범위를 말할 표본이 없으면 그 자리는 "아직 알 수 없다"로 남는다.
 */
export function waitingDetailText(input: {
  elapsedMinutes?: number | null;
  typicalRange?: string | null;
  refreshedAgoMs?: number | null;
}): string {
  const updated = lastUpdatedText(input.refreshedAgoMs);
  const minutes = input.elapsedMinutes;
  if (minutes === null || minutes === undefined) {
    return ['마지막으로 확인된 상태를 표시합니다', updated].filter(Boolean).join(' · ');
  }
  const typical = input.typicalRange || '남은 시간은 아직 알 수 없어요';
  return [elapsedText(minutes), typical, updated].filter(Boolean).join(' · ');
}

export function captureProgress(input: CaptureProgressInput): CaptureProgress {
  const failed = input.queue?.state === 'failed';
  const index = failed ? 0 : stageIndexOf(input);
  const done = index >= STAGE_DEFS.length;
  const weighting = weightStages(CAPTURE_STAGE_KEYS, input.stageStats ?? {});
  const shares = new Map(weighting.weights.map((weight) => [weight.key, weight.share]));
  const stages: Stage[] = STAGE_DEFS.map((definition, position) => ({
    ...definition,
    state: failed && position === 0 ? 'failed' : done || position < index ? 'done' : position === index ? 'active' : 'todo',
    share: shares.get(definition.key) ?? 1 / STAGE_DEFS.length,
  }));

  if (failed) {
    const tries = input.queue?.tries ?? 0;
    return {
      stages,
      step: 1,
      total: STAGE_DEFS.length,
      percent: 0,
      done: false,
      failed: true,
      late: false,
      headline: '전송하지 못했어요',
      detail: `${tries ? `${tries}회 시도 · ` : ''}연결되면 자동 재시도하고, 지금 직접 다시 보낼 수도 있어요`,
      weighting,
    };
  }

  if (done) {
    const attention = captureAttentionOf(input.brief);
    return {
      stages,
      step: STAGE_DEFS.length + 1,
      total: STAGE_DEFS.length,
      percent: 1,
      done: true,
      failed: false,
      late: false,
      headline: attention ? '확인이 필요해요' : input.brief?.status === 'skipped' ? '명함이 아니어서 처리하지 않았어요' : '결과가 준비됐어요',
      detail: attention
        ? ATTENTION_DETAIL[attention.reasonCode]
        : input.elapsedMinutes === null || input.elapsedMinutes === undefined ? '서버가 완료 상태를 확인했습니다' : `${Math.max(0, Math.floor(input.elapsedMinutes))}분 경과 뒤 완료 상태를 확인했습니다`,
      weighting,
    };
  }

  const headlines = ['기기에서 전송을 기다려요', '서버가 접수했어요', '서버에서 처리 중이에요', '결과를 확인하고 있어요'];
  return {
    stages,
    step: index + 1,
    total: STAGE_DEFS.length,
    percent: 0,
    done: false,
    failed: false,
    late: false,
    headline: headlines[index],
    // 지금 서 있는 그 단계의 보통 범위만 말한다. 전체 남은 시간은 여전히 추정하지 않는다.
    detail: waitingDetailText({
      elapsedMinutes: input.elapsedMinutes,
      typicalRange: typicalRangeText(input.stageStats?.[CAPTURE_STAGE_KEYS[index]] ?? null),
      refreshedAgoMs: input.refreshedAgoMs,
    }),
    weighting,
  };
}

// ── 관측 수집 (DEC-000092 §1) ────────────────────────────────────────────────
// 진행 막대의 폭이 의미를 가지려면 먼저 "이 단계가 보통 얼마나 걸리는가"를 알아야 하고,
// 그 값은 서버가 주지 않는다. 그래서 목록을 볼 때마다 **이 기기가 본 것**을 모은다.

/**
 * 조사 receipt는 명함 캡처가 아니다. 같은 목록에 섞여 오지만 `기기에서 전송 → 서버 접수 → 서버
 * 처리`라는 단계 어휘를 공유하지 않는다 — 조사는 `ai-stages.ts`의 rail 어휘로 따로 관측한다.
 * 섞어 넣으면 몇 분짜리 조사 시간이 몇 초짜리 캡처 단계의 중앙값을 통째로 끌고 간다.
 *
 * `researchProgress`도 함께 본다. 지금 계약(`contracts/capture.ts`)에는 없는 서버 필드라
 * `unknown`으로 읽지만, 있으면 그것만으로 조사 receipt다 — 배제는 넓을수록 안전하다.
 * 놓치면 잘못된 표본이 중앙값에 영구히 남고, 과하게 배제해 봐야 표본 하나를 안 쓸 뿐이다.
 */
export function isResearchReceipt(item?: BriefItem | null): boolean {
  if (!item) return false;
  if (item.type === 'research_instruction') return true;
  return Boolean((item as { researchProgress?: unknown }).researchProgress);
}

/** 목록 한 번에서 뽑은 단계 관측. 서버·대기열이 증명한 상태만 들어간다. */
export function captureStageSightings(input: {
  briefs?: ReadonlyArray<BriefItem> | null;
  queue?: ReadonlyArray<CaptureQueueItem> | null;
}): StageSighting[] {
  const byId = new Map<string, StageSighting>();
  for (const item of input.queue ?? []) {
    if (!item?.captureId || item.state === 'failed') continue;
    const rank = stageIndexOf({ queue: item });
    byId.set(item.captureId, { id: item.captureId, stage: CAPTURE_STAGE_KEYS[rank] ?? TERMINAL_STAGE, rank });
  }
  for (const item of input.briefs ?? []) {
    if (!item?.captureId || isResearchReceipt(item)) continue;
    const rank = stageIndexOf({ brief: item });
    // 서버 응답이 대기열 추정을 이긴다.
    byId.set(item.captureId, { id: item.captureId, stage: CAPTURE_STAGE_KEYS[rank] ?? TERMINAL_STAGE, rank });
  }
  return [...byId.values()];
}

/**
 * 서버 timestamp만으로 확정되는 표본 — 촬영 시각과 서버 접수 시각의 차이가 곧 `기기에서 전송`이다.
 * 관측을 기다릴 필요가 없어 첫 표본이 빨리 쌓인다. 기기 시계와 서버 시계가 다르면 음수나 터무니없는
 * 값이 나오므로 허용 구간을 벗어난 값은 버린다.
 *
 * 이미 지켜보고 있던 캡처는 건너뛴다 — 폴링마다 같은 값을 다시 넣으면 그 캡처 하나가 중앙값을 지배한다.
 */
export function serverProvenStageSamples(
  briefs: ReadonlyArray<BriefItem> | null | undefined,
  seen: Readonly<Record<string, unknown>> = {},
): StageSample[] {
  const samples: StageSample[] = [];
  for (const item of briefs ?? []) {
    if (!item?.captureId || isResearchReceipt(item) || Object.prototype.hasOwnProperty.call(seen, item.captureId)) continue;
    const captured = Date.parse(String(item.capturedAt ?? ''));
    const received = Date.parse(String(item.receivedAt ?? ''));
    if (Number.isNaN(captured) || Number.isNaN(received)) continue;
    const ms = received - captured;
    if (ms < 0 || ms > STAGE_SAMPLE_MAX_MS) continue;
    samples.push({ stage: 'upload', ms });
  }
  return samples;
}

/** 목록 한 번을 telemetry에 반영한다 (순수 함수). */
export function recordCaptureStageObservations(input: {
  telemetry: StageTelemetry;
  briefs?: ReadonlyArray<BriefItem> | null;
  queue?: ReadonlyArray<CaptureQueueItem> | null;
  now: number;
}): { telemetry: StageTelemetry; samples: StageSample[]; changed: boolean } {
  const seeded = serverProvenStageSamples(input.briefs, input.telemetry.watch);
  const base = withStageSamples(input.telemetry, seeded);
  const observed = observeStages({
    telemetry: base,
    sightings: captureStageSightings(input),
    now: input.now,
    order: CAPTURE_STAGE_KEYS,
  });
  return {
    telemetry: observed.telemetry,
    samples: [...seeded, ...observed.samples],
    changed: observed.changed || seeded.length > 0,
  };
}

/**
 * 목록을 새로 받을 때마다 호출한다. 관측을 저장하고 지금 쓸 단계 요약을 돌려준다.
 * 저장은 실제로 바뀐 것이 있을 때만 한다 — 4초 폴링마다 localStorage를 쓰지 않기 위해서다.
 */
export function syncCaptureStageTelemetry(input: {
  briefs?: ReadonlyArray<BriefItem> | null;
  queue?: ReadonlyArray<CaptureQueueItem> | null;
  now?: number;
}): Record<string, StageStat | null> {
  const result = recordCaptureStageObservations({
    telemetry: loadStageTelemetry(),
    briefs: input.briefs,
    queue: input.queue,
    now: input.now ?? Date.now(),
  });
  if (result.changed) saveStageTelemetry(result.telemetry);
  return stageStats(result.telemetry, CAPTURE_STAGE_KEYS);
}

/** 저장된 관측만 읽어 단계 요약을 만든다 (첫 render 등, 새 관측 없이 폭이 필요한 자리). */
export function captureStageStats(): Record<string, StageStat | null> {
  return stageStats(loadStageTelemetry(), CAPTURE_STAGE_KEYS);
}
