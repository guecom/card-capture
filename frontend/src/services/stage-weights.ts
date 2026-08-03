// 관측된 소요시간을 **진행 막대 칸의 폭**으로 바꾼다 (DEC-000092 §2).
//
// 승인 문장: "stage 폭은 최근 관측된 단계별 duration의 대표값으로 가중해, 읽지 않아도 전체 작업
// 진행 정도를 직관적으로 알 수 있게 한다. telemetry가 부족하거나 처리시간 분산이 크면 정밀한
// 퍼센트나 ETA를 꾸미지 않는다."
//
// 그래서 이 모듈의 계약은 두 갈래뿐이다.
//   근거가 충분하다 → 중앙값에 비례한 폭, `confident: true`
//   근거가 부족하거나 산포가 크다 → **균등 폭**, `confident: false`
// 중간은 없다. 절반쯤 아는 것을 절반쯤 비례하는 폭으로 그리면 그 폭이 무엇을 뜻하는지 아무도 모른다.
//
// (`stage-geometry.ts`는 카메라 `object-fit` 좌표 변환이라 이 일과 무관하다.)

import type { StageStat } from './stage-telemetry';

/** 이보다 표본이 적으면 대표값이라고 부르지 않는다. */
export const MIN_CONFIDENT_SAMPLES = 3;

/**
 * 허용 산포 상한 = (75분위 − 25분위) / 중앙값.
 * 1.0이면 사분위 폭이 중앙값만큼 넓다는 뜻 — 그 정도면 "보통 이 정도"가 성립하지 않는다.
 */
export const MAX_CONFIDENT_SPREAD = 1;

/**
 * 칸 하나의 최소 폭. 관측이 진짜로 0에 가까운 단계(예: 접수 직후 곧바로 처리)가 화면에서
 * 사라져 만질 수도 볼 수도 없게 되는 것을 막는 **가독 하한**이지, 지어낸 소요시간이 아니다.
 * 하한을 먹은 칸이 있어도 `confident`는 그대로다 — 근거의 유무와 그리기의 하한은 다른 문제다.
 */
export const MIN_STAGE_SHARE = 0.06;

export type StageWeightReason =
  | 'weighted'
  | 'no_stages'
  | 'insufficient_samples'
  | 'high_dispersion'
  | 'no_duration_signal';

export interface StageWeight {
  key: string;
  /** 0~1로 정규화된 칸 폭. 합은 1이다. CSS에서는 `flex-grow: share`로 쓴다. */
  share: number;
  /** 이 폭의 근거가 된 대표 소요시간(ms). 균등 폭이면 `null`이다. */
  medianMs: number | null;
  /** 이 단계에서 모은 관측 수 */
  samples: number;
}

export interface StageWeighting {
  weights: StageWeight[];
  /** 폭이 관측에 근거하는가. `false`면 균등 폭이고 화면은 폭으로 시간을 말하면 안 된다. */
  confident: boolean;
  reason: StageWeightReason;
  /** 근거가 모자란 단계 키. 무엇이 부족한지 화면·진단이 그대로 말할 수 있게 남긴다. */
  unproven: string[];
}

export interface StageWeightOptions {
  minSamples?: number;
  maxSpread?: number;
  minShare?: number;
  /**
   * **기다림이 아닌 칸.** 폭 가중의 대상에서 빼고 정확히 `minShare`만 준다.
   *
   * 조사 rail의 `작성 중`(제출 전 기기 상태)과 `완료`(종료 표시)가 그렇다. 둘은 서버가
   * 처리하는 대기 구간이 아니라 막대의 양 끝 경계라서, 소요시간 표본이 영원히 생기지 않는다.
   * 이것을 표시하지 않으면 `n>=3` 조건을 절대 못 채워 rail 전체가 영구히 균등 폭에 갇힌다 —
   * 관측을 쌓아 놓고도 막대가 그대로인, founder가 반려한 바로 그 상태다.
   *
   * marker는 `confident` 판정에 참여하지 않는다. "측정할 수 없는 칸"과 "아직 못 측정한 칸"은
   * 다른 사실이고, 전자를 후자로 세면 근거가 충분해져도 영원히 false가 된다.
   */
  markers?: readonly string[];
}

function equalWeighting(keys: readonly string[], reason: StageWeightReason, unproven: string[], stats: Readonly<Record<string, StageStat | null | undefined>>): StageWeighting {
  const share = keys.length ? 1 / keys.length : 0;
  return {
    weights: keys.map((key) => ({ key, share, medianMs: null, samples: stats[key]?.samples ?? 0 })),
    confident: false,
    reason,
    unproven,
  };
}

/**
 * 최소 폭을 지키면서 나머지를 중앙값에 비례해 나눈다.
 * 하한에 걸린 칸을 고정하고 남은 폭을 다시 비례 배분하기를 안정될 때까지 반복한다.
 */
function normalizeShares(medians: readonly number[], minShare: number): number[] {
  const count = medians.length;
  if (!count) return [];
  const floor = Math.min(Math.max(minShare, 0), 1 / count);
  const pinned = new Array<boolean>(count).fill(false);
  let shares = new Array<number>(count).fill(0);

  for (let pass = 0; pass <= count; pass += 1) {
    const freeIndexes = medians.map((_, index) => index).filter((index) => !pinned[index]);
    const pinnedTotal = floor * (count - freeIndexes.length);
    const freeBudget = Math.max(0, 1 - pinnedTotal);
    const freeSum = freeIndexes.reduce((total, index) => total + medians[index], 0);

    shares = shares.map((value, index) => (pinned[index] ? floor : value));
    if (freeSum <= 0) {
      const even = freeIndexes.length ? freeBudget / freeIndexes.length : 0;
      for (const index of freeIndexes) shares[index] = even;
      break;
    }
    let changed = false;
    for (const index of freeIndexes) {
      const value = (medians[index] / freeSum) * freeBudget;
      if (value < floor) {
        pinned[index] = true;
        changed = true;
      }
      shares[index] = value;
    }
    if (!changed) break;
  }

  const total = shares.reduce((sum, value) => sum + value, 0);
  return total > 0 ? shares.map((value) => value / total) : new Array<number>(count).fill(1 / count);
}

/**
 * 단계 키 목록과 관측 요약으로 칸 폭을 계산한다 (순수 함수).
 *
 * 한 단계라도 근거가 모자라면 **전체**가 균등 폭이 된다. 일부만 비례하는 막대는 폭이 시간인지
 * 아닌지 알 수 없어 오히려 지금보다 나쁘다.
 */
export function weightStages(
  keys: readonly string[],
  stats: Readonly<Record<string, StageStat | null | undefined>>,
  options: StageWeightOptions = {},
): StageWeighting {
  const minSamples = options.minSamples ?? MIN_CONFIDENT_SAMPLES;
  const maxSpread = options.maxSpread ?? MAX_CONFIDENT_SPREAD;
  const minShare = options.minShare ?? MIN_STAGE_SHARE;

  if (!keys.length) return { weights: [], confident: false, reason: 'no_stages', unproven: [] };

  const marker = new Set(options.markers ?? []);
  const measured = keys.filter((key) => !marker.has(key));
  // 잴 수 있는 칸이 하나도 없으면 폭으로 시간을 말할 방법 자체가 없다.
  if (!measured.length) return equalWeighting(keys, 'no_stages', [], stats);

  const thin = measured.filter((key) => (stats[key]?.samples ?? 0) < minSamples);
  if (thin.length) return equalWeighting(keys, 'insufficient_samples', thin, stats);

  const noisy = measured.filter((key) => (stats[key]?.spread ?? Number.POSITIVE_INFINITY) > maxSpread);
  if (noisy.length) return equalWeighting(keys, 'high_dispersion', noisy, stats);

  if (measured.every((key) => Math.max(0, stats[key]?.medianMs ?? 0) <= 0)) {
    return equalWeighting(keys, 'no_duration_signal', [...measured], stats);
  }

  // marker 칸은 비례 배분에 참여하지 않고 가독 하한만 차지한다. `normalizeShares`의 하한 처리가
  // 그대로 그 일을 하므로, 중앙값 0을 넣어 하한으로 고정되게 한다.
  const medians = keys.map((key) => (marker.has(key) ? 0 : Math.max(0, stats[key]?.medianMs ?? 0)));
  const shares = normalizeShares(medians, minShare);
  return {
    weights: keys.map((key, index) => ({
      key,
      share: shares[index],
      medianMs: marker.has(key) ? null : stats[key]?.medianMs ?? null,
      samples: stats[key]?.samples ?? 0,
    })),
    confident: true,
    reason: 'weighted',
    unproven: [],
  };
}

/**
 * CSS `width: N%`에 바로 쓰는 정수 백분율. 반올림 오차를 가장 큰 칸이 흡수해 합이 정확히 100이다.
 * (`share`를 그대로 반올림하면 칸 4개에서 99% 또는 101%가 나와 막대 끝이 어긋난다.)
 */
export function stageWidthPercents(weighting: StageWeighting): number[] {
  const count = weighting.weights.length;
  if (!count) return [];
  const raw = weighting.weights.map((weight) => weight.share * 100);
  const rounded = raw.map((value) => Math.round(value));
  const drift = 100 - rounded.reduce((sum, value) => sum + value, 0);
  if (drift !== 0) {
    let target = 0;
    for (let index = 1; index < count; index += 1) if (raw[index] > raw[target]) target = index;
    rounded[target] += drift;
  }
  return rounded;
}
