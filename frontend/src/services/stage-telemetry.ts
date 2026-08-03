// 단계별로 **실제로 얼마나 걸렸는지**를 이 기기에서 관측해 모은다 (DEC-000092 §1).
//
// founder 반려 2026-08-02: "진행 막대기가 실질적으로 의미 없음… 단계별 걸리는 시간에 비례한 진행
// 바가 있었으면 함. 얼마나 기다려야 완료되는지 읽는 것보다 직관적으로 알고 싶음."
//
// 그 막대를 그리려면 먼저 **가중할 데이터**가 있어야 한다. 이 모듈이 그 데이터만 만든다.
// 규율 세 가지:
//  1. 관측만 기록한다. 서버가 증명한 상태 전이를 본 순간에만 표본이 생긴다.
//  2. 표본은 유한하다 — subject마다 단계당 최근 `STAGE_SAMPLE_WINDOW`개만 남는다.
//  3. 대표값과 함께 **표본 수와 산포**를 같이 돌려준다. 부족하다는 사실을 숨기면 폭이 거짓말을 한다.
//
// 저장 자리는 subject namespace다 (`storage.ts` `PRIVATE_KEYS`). namespace 없는 사적 상태가
// 다른 사람 화면에 남는 것이 ISS-000112였다.

import { loadStageDurationsRaw, saveStageDurationsRaw } from './storage';

export const STAGE_TELEMETRY_VERSION = 1;

/** 단계마다 남기는 최근 관측 수. 오래된 서버 성능은 지금의 기다림을 대표하지 못한다. */
export const STAGE_SAMPLE_WINDOW = 24;

/** 동시에 지켜보는 캡처 수 상한. 목록이 길어도 저장소가 무한히 자라지 않는다. */
export const STAGE_WATCH_MAX = 60;

/** 관측으로 인정하는 하한. 이보다 짧으면 폴링 간격 안에서 두 단계가 겹친 것이라 단계 소요로 볼 수 없다. */
export const STAGE_SAMPLE_MIN_MS = 0;

/**
 * 관측으로 인정하는 상한(6시간). 앱을 닫아 둔 사이의 벽시계는 "그 단계가 그만큼 걸렸다"가 아니다.
 * 넘는 값은 버린다 — 늘리는 쪽으로 틀린 표본 하나가 중앙값을 통째로 끌고 간다.
 */
export const STAGE_SAMPLE_MAX_MS = 6 * 60 * 60 * 1000;

/** 지켜보던 캡처를 잊는 시간(24시간). 이보다 오래 갱신이 없으면 그 관측은 이어 붙이지 않는다. */
export const STAGE_WATCH_STALE_MS = 24 * 60 * 60 * 1000;

/** 한 단계의 관측 요약. `samples`와 `spread`를 반드시 함께 읽어야 한다. */
export interface StageStat {
  stage: string;
  /** 이 단계에서 모은 관측 수 */
  samples: number;
  /** 대표 소요시간 = 중앙값 */
  medianMs: number;
  /** 보통 범위의 아래끝 (25분위) */
  lowMs: number;
  /** 보통 범위의 위끝 (75분위) */
  highMs: number;
  /**
   * 산포 = (75분위 − 25분위) / 중앙값. 중앙값이 0이면 범위가 0일 때만 0이고 아니면 `Infinity`다.
   * 이 값이 크면 "보통 이 정도"라고 말할 수 없다.
   */
  spread: number;
}

/** 아직 끝나지 않은 캡처를 어느 단계에서 언제부터 보고 있었는지. */
export interface StageWatchEntry {
  stage: string;
  /** 단계 순서. 뒤로 가는 전이는 표본을 만들지 않는다. */
  rank: number;
  /** 이 단계에 있는 것을 처음 본 시각 */
  since: number;
}

export interface StageTelemetry {
  version: typeof STAGE_TELEMETRY_VERSION;
  /** 단계 → 최근 관측 소요시간(ms) 목록. 오래된 것이 앞이다. */
  stages: Record<string, number[]>;
  /** captureId → 관측 중인 단계 */
  watch: Record<string, StageWatchEntry>;
}

/** 지금 이 캡처가 어느 단계에 있는지에 대한 **서버가 증명한** 관측 한 건. */
export interface StageSighting {
  id: string;
  stage: string;
  rank: number;
}

export interface StageObservationResult {
  telemetry: StageTelemetry;
  samples: StageSample[];
  /** 저장할 이유가 있는가. 폴링마다 같은 값을 다시 쓰지 않기 위한 신호다. */
  changed: boolean;
}

/** 확정된 관측 소요시간 한 건. */
export interface StageSample {
  stage: string;
  ms: number;
}

export function emptyStageTelemetry(): StageTelemetry {
  return { version: STAGE_TELEMETRY_VERSION, stages: {}, watch: {} };
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** 저장된 값은 신뢰하지 않는다 — 다른 버전·손상·손으로 편집된 값이 폭을 결정하게 두지 않는다. */
export function parseStageTelemetry(raw: string): StageTelemetry {
  if (!raw) return emptyStageTelemetry();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStageTelemetry();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyStageTelemetry();
  const record = parsed as Record<string, unknown>;
  if (record.version !== STAGE_TELEMETRY_VERSION) return emptyStageTelemetry();

  const stages: Record<string, number[]> = {};
  const rawStages = record.stages;
  if (rawStages && typeof rawStages === 'object' && !Array.isArray(rawStages)) {
    for (const [stage, values] of Object.entries(rawStages as Record<string, unknown>)) {
      if (!stage || !Array.isArray(values)) continue;
      const kept = values
        .map((value) => finiteMs(value))
        .filter((value): value is number => value !== null && value >= STAGE_SAMPLE_MIN_MS && value <= STAGE_SAMPLE_MAX_MS)
        .slice(-STAGE_SAMPLE_WINDOW);
      if (kept.length) stages[stage] = kept;
    }
  }

  const watch: Record<string, StageWatchEntry> = {};
  const rawWatch = record.watch;
  if (rawWatch && typeof rawWatch === 'object' && !Array.isArray(rawWatch)) {
    for (const [id, entry] of Object.entries(rawWatch as Record<string, unknown>)) {
      if (!id || !entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const value = entry as Record<string, unknown>;
      const since = finiteMs(value.since);
      const rank = finiteMs(value.rank);
      if (typeof value.stage !== 'string' || !value.stage || since === null || rank === null) continue;
      watch[id] = { stage: value.stage, rank, since };
    }
  }

  return { version: STAGE_TELEMETRY_VERSION, stages, watch };
}

export function loadStageTelemetry(): StageTelemetry {
  return parseStageTelemetry(loadStageDurationsRaw());
}

export function saveStageTelemetry(telemetry: StageTelemetry): void {
  saveStageDurationsRaw(JSON.stringify(telemetry));
}

function pushSample(stages: Record<string, number[]>, stage: string, ms: number): void {
  if (!stage || ms < STAGE_SAMPLE_MIN_MS || ms > STAGE_SAMPLE_MAX_MS) return;
  const next = [...(stages[stage] ?? []), ms];
  stages[stage] = next.length > STAGE_SAMPLE_WINDOW ? next.slice(next.length - STAGE_SAMPLE_WINDOW) : next;
}

/** 오래된 관측 대상을 잘라 낸다. 최근 갱신 순으로 `STAGE_WATCH_MAX`개만 남는다. */
function trimWatch(watch: Record<string, StageWatchEntry>, now: number): Record<string, StageWatchEntry> {
  const alive = Object.entries(watch).filter(([, entry]) => now - entry.since <= STAGE_WATCH_STALE_MS);
  if (alive.length <= STAGE_WATCH_MAX) return Object.fromEntries(alive);
  return Object.fromEntries(alive.sort((a, b) => b[1].since - a[1].since).slice(0, STAGE_WATCH_MAX));
}

/**
 * 목록 한 번을 보고 관측을 갱신한다 (순수 함수).
 *
 * - 처음 보는 캡처는 그 단계에 있었다고 **기록만** 한다. 언제 들어왔는지 모르므로 표본이 아니다.
 * - 단계가 앞으로 갔을 때만, 방금 떠난 단계들에 대해 표본을 만든다.
 * - 한 번의 폴링에서 두 단계를 건너뛰었으면 지나온 중간 단계는 `0ms`로 기록한다.
 *   관측된 사실 그대로다 — "그 단계에 머문 것을 한 번도 보지 못했다".
 * - 뒤로 간 상태(서버 재처리 등)는 표본을 만들지 않고 관측 시작점만 옮긴다.
 */
export function observeStages(input: {
  telemetry: StageTelemetry;
  sightings: ReadonlyArray<StageSighting>;
  now: number;
  /** 단계 순서 목록. 건너뛴 중간 단계를 이름으로 되찾는 데 쓴다. */
  order?: ReadonlyArray<string>;
}): StageObservationResult {
  const { telemetry, sightings, now } = input;
  const order = input.order ?? [];
  const stages: Record<string, number[]> = {};
  for (const [stage, values] of Object.entries(telemetry.stages)) stages[stage] = [...values];
  const watch: Record<string, StageWatchEntry> = { ...telemetry.watch };
  const samples: StageSample[] = [];
  let changed = false;

  for (const sighting of sightings) {
    if (!sighting.id || !sighting.stage) continue;
    const previous = watch[sighting.id];
    if (!previous) {
      watch[sighting.id] = { stage: sighting.stage, rank: sighting.rank, since: now };
      changed = true;
      continue;
    }
    if (sighting.rank === previous.rank) continue;
    if (sighting.rank < previous.rank) {
      // 서버가 되돌아갔다. 이전 구간을 소요시간으로 주장하지 않는다.
      watch[sighting.id] = { stage: sighting.stage, rank: sighting.rank, since: now };
      changed = true;
      continue;
    }

    const elapsed = now - previous.since;
    if (elapsed >= STAGE_SAMPLE_MIN_MS && elapsed <= STAGE_SAMPLE_MAX_MS) {
      samples.push({ stage: previous.stage, ms: elapsed });
      // 건너뛴 중간 단계는 "머문 것을 보지 못했다" = 0ms.
      for (let rank = previous.rank + 1; rank < sighting.rank; rank += 1) {
        const skipped = order[rank];
        if (skipped) samples.push({ stage: skipped, ms: 0 });
      }
    }
    watch[sighting.id] = { stage: sighting.stage, rank: sighting.rank, since: now };
    changed = true;
  }

  for (const sample of samples) pushSample(stages, sample.stage, sample.ms);
  const trimmed = trimWatch(watch, now);
  if (Object.keys(trimmed).length !== Object.keys(watch).length) changed = true;
  return { telemetry: { version: STAGE_TELEMETRY_VERSION, stages, watch: trimmed }, samples, changed };
}

/** 관측 없이 표본만 직접 더한다 (서버 timestamp에서 파생된 표본 등). 순수 함수. */
export function withStageSamples(telemetry: StageTelemetry, samples: ReadonlyArray<StageSample>): StageTelemetry {
  if (!samples.length) return telemetry;
  const stages: Record<string, number[]> = {};
  for (const [stage, values] of Object.entries(telemetry.stages)) stages[stage] = [...values];
  for (const sample of samples) pushSample(stages, sample.stage, sample.ms);
  return { ...telemetry, stages };
}

function quantile(sorted: ReadonlyArray<number>, fraction: number): number {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

/** 한 단계의 대표값·표본 수·산포. 표본이 없으면 `null`이다 — 0을 대표값으로 꾸미지 않는다. */
export function stageStat(telemetry: StageTelemetry, stage: string): StageStat | null {
  const values = telemetry.stages[stage];
  if (!values || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const medianMs = quantile(sorted, 0.5);
  const lowMs = quantile(sorted, 0.25);
  const highMs = quantile(sorted, 0.75);
  const width = highMs - lowMs;
  const spread = medianMs > 0 ? width / medianMs : width > 0 ? Number.POSITIVE_INFINITY : 0;
  return { stage, samples: sorted.length, medianMs, lowMs, highMs, spread };
}

export function stageStats(telemetry: StageTelemetry, stages: ReadonlyArray<string>): Record<string, StageStat | null> {
  const summary: Record<string, StageStat | null> = {};
  for (const stage of stages) summary[stage] = stageStat(telemetry, stage);
  return summary;
}

/** 단위를 따로 들고 있어야 `3분~6분`이 아니라 `3~6분`으로 붙일 수 있다. */
function durationParts(ms: number): { value: string; unit: string; text: string } {
  if (ms < 60_000) {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return { value: String(seconds), unit: '초', text: `${seconds}초` };
  }
  const minutes = ms / 60_000;
  if (minutes < 60) {
    const whole = Math.max(1, Math.round(minutes));
    return { value: String(whole), unit: '분', text: `${whole}분` };
  }
  const hours = Math.floor(minutes / 60);
  const rest = Math.round(minutes % 60);
  const text = rest ? `${hours}시간 ${rest}분` : `${hours}시간`;
  // 시간 단위는 두 토막이라 단위를 합치지 않는다.
  return { value: text, unit: '', text };
}

/**
 * `보통 4~9분` — 승인 문구의 `보통 범위`다 (DEC-000092 §2).
 *
 * 표본이 2개 미만이면 `null`. 한 번 본 것을 "보통"이라고 부르지 않는다.
 * 점 추정(ETA)이 아니라 관측된 범위다 — 위끝과 아래끝이 같은 눈금으로 반올림되면 한 값만 쓴다.
 */
export function typicalRangeText(stat: StageStat | null | undefined, minSamples = 2): string | null {
  if (!stat || stat.samples < minSamples) return null;
  const low = durationParts(stat.lowMs);
  const high = durationParts(stat.highMs);
  if (low.text === high.text) return `보통 ${low.text}`;
  if (low.unit && low.unit === high.unit) return `보통 ${low.value}~${high.value}${low.unit}`;
  return `보통 ${low.text}~${high.text}`;
}
