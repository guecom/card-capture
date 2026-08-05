// 기계 속도 보정(TSK-000572).
//
// 벽시계 예산 단언은 "앱이 느려졌다"와 "기계가 느렸다"를 구분하지 못한다. `capture-flow.spec.ts`의
// `stableRetryMs < 2000`이 v2.14.0·v2.15.0·v2.25.0·v2.26.0·v2.27.0 다섯 판에서 **단독 실행은 통과,
// 전체 스위트 부하에서 실패**로 기록된 이유가 그것이다(한 번은 `2249ms`, 12% 초과).
//
// 예산을 늘리지 않는다 — 사용자가 체감하는 응답성을 재는 단언이라 느슨하게 만들면 재는 뜻이 사라진다.
// 대신 **같은 판·같은 페이지에서 기계 속도를 함께 재고** 그 비율만큼만 예산을 늘린다. 기준선(base)은
// 그대로 2000ms이고, 곱해지는 값은 `clamp(ratio, 1, CAP)`이라 빠른 기계에서는 조금도 느슨해지지 않는다.

import type { Page } from '@playwright/test';

/** 한 번의 pace 측정 결과. */
export interface PaceSample {
  /**
   * 기계 속도의 대표값(ms) — 워밍업을 뺀 iteration 중 **가장 빠른 것**.
   *
   * 중앙값이 아니라 최솟값을 쓰는 이유: 최솟값은 "이 기계가 지금 이 작업을 해낼 수 있는 최고 속도"라
   * 순간적인 방해(GC·백그라운드 작업)에 오염되지 않는다. 실측에서 같은 유휴 상태의 중앙값은
   * 27~44ms로 흔들렸지만 최솟값은 25.6~31.2ms에 머물렀다. 지속적인 부하는 최솟값도 함께 밀어
   * 올리므로 부하 감지력은 잃지 않고, 순간적인 튐만 예산을 부풀리지 못하게 막는다.
   */
  perIterMs: number;
  /** 측정에 쓴 iteration 수(워밍업 제외). */
  samples: number;
  /** 분포 — 측정 자체가 튀었는지 로그에서 바로 보이게 남긴다. */
  medianMs: number;
  maxMs: number;
}

/**
 * 기준 기계에서 잰 `perIterMs`. 이 값보다 빠른 기계에서는 ratio가 1로 clamp되므로
 * 예산이 base보다 느슨해지는 일은 없다.
 *
 * 측정: Windows 11 / Chrome headless / 이 저장소 e2e runner, 유휴 상태에서 실제 게이트를 단독으로
 * 5판 돌려 얻은 `perIterMs` = 25.5 / 24.8 / 26.4 / 25.2 / 25.8 (중앙값 25.5). 26으로 고정한다 —
 * 중앙값보다 살짝 위라 유휴 판은 사실상 전부 ratio 1로 clamp되고, 그래서 **빠른 기계에서는
 * 예산이 전혀 느슨해지지 않는다**. 이보다 느린 기준을 잡으면 부하 상태에서 ratio가 과소평가돼
 * 원래의 흔들림이 그대로 돌아온다.
 *
 * 확인: 확정 후 spec 파일 전체를 유휴 상태로 5판 돌렸을 때 paceMs = 26.8 / 25.7 / 25.4 / 24.9 / 25.6,
 * 그중 4판이 예산 2000ms 그대로였고 1판만 2062ms였다(3% 이내).
 */
export const PACE_REFERENCE_MS = 26;

/**
 * ratio 상한. 병적으로 느린 기계가 임의로 느린 앱을 변호하지 못하게 막는 hard ceiling이다.
 *
 * 근거 — 이 구간의 구조적 하한은 앱 상수로 정해져 있다: `auto-capture.ts`의 `minStableFrames 5`
 * × detect loop `setInterval(180)` = 900ms, 그리고 `minStableMs 650`. 여기에 burst가 새 presented
 * frame을 기다리는 시간이 붙어 **약 1초**가 이 구간의 바닥이고, base 2000ms는 그 바닥의 약 2배다.
 * CAP 2.5는 천장을 5000ms(바닥의 약 5배)로 고정한다 — **어떤 기계에서도 5초를 넘는 retry는 무조건
 * 걸린다.**
 *
 * 2.5를 고른 실측 근거: 이 게이트를 전체 스위트와 **동시에** 돌려 만든 가장 가혹한 재현에서
 * rawRatio가 1.67~2.31까지 올라갔고 cap에 닿지 않았다. 같은 판들에서 예산 소진율
 * (measured/budget)은 최대 0.82였다. 즉 2.5는 실제로 재현 가능한 최악 부하를 덮으면서도
 * 그 위로 열어 두지 않는다.
 *
 * 정직한 trade-off: cap이 걸릴 만큼 느린 기계에서는 예산이 5000ms에 멈추므로, 부하 baseline이
 * 이미 2.5초인 판에서 앱이 한 사이클(약 1초)만 더 느려지는 회귀는 그 판에서 놓칠 수 있다.
 * 그 대신 그런 판은 로그에 `cappedOut: true`로 남아 다음 사람이 "cap이 이 판을 묶었다"를
 * 재실행 없이 알 수 있다. cap을 올리는 것이 아니라 그 사실을 보이게 두는 쪽을 택했다.
 */
export const PACE_CAP = 2.5;

/**
 * 페이지 안에서 도는 control. **기계만** 재도록 만든 것이라 앱 코드 경로를 하나도 쓰지 않는다.
 *
 * 한 iteration = 애니메이션 프레임 1장을 기다린 뒤 + 촬영 프레임과 같은 크기(720x1280)의 canvas에
 * 고정된 raster 작업 + 고정된 수치 loop. 앱이 그 구간에서 하는 일과 같은 종류다 — detect loop는
 * 프레임마다 canvas를 그리고 픽셀을 훑으며, overlay는 `requestAnimationFrame`으로 돈다. 둘 다
 * main thread에서 경합하므로, 기계가 밀리면 프레임 도착과 raster·수치 작업이 함께 늘어난다.
 *
 * `sleep`이 아니다 — 대기가 아니라 실제 작업량을 잰다. 그리고 `getImageData`처럼 앱이 쓰는
 * 원시 함수는 **일부러 쓰지 않는다**: control과 앱이 같은 원시 함수를 공유하면, 그 함수가 느려지는
 * 종류의 앱 회귀를 control이 "기계가 느리다"로 읽어 스스로 변호하게 된다.
 */
async function paceProbe({ width, height, reps, rects, mathOps }: {
  width: number; height: number; reps: number; rects: number; mathOps: number;
}): Promise<{ perIterMs: number; samples: number; medianMs: number; maxMs: number }> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  // CPU-backed surface를 강제한다. GPU로 넘기면 fillRect가 지연 실행돼 실제 작업량이 아니라
  // 명령 기록 시간을 재게 된다.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('pace_probe_no_2d_context');
  const scratch = new Float64Array(4096);
  for (let index = 0; index < scratch.length; index += 1) scratch[index] = ((index * 2654) % 997) / 997;

  const durations: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    // 프레임 경계에서 시작해 iteration끼리 겹치지 않게 한다. 이 대기는 **재는 구간 밖**이다 —
    // 안에 넣으면 `requestAnimationFrame`이 vsync(약 16.7ms) 단위로 양자화돼 분해능이 사라진다
    // (실측: 작업량을 10배로 늘려도 iteration 총시간이 16.5ms에 붙박여 부하에 반응하지 못했다).
    await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    const started = performance.now();
    context.fillStyle = '#b9a892';
    context.fillRect(0, 0, width, height);
    for (let index = 0; index < rects; index += 1) {
      const px = (index * 977) % width;
      const py = (index * 1597) % height;
      context.fillStyle = index % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
      context.fillRect(px, py, 3, 3);
    }
    let accumulator = 0;
    for (let op = 0; op < mathOps; op += 1) {
      const value = scratch[op & 4095];
      accumulator += value * 0.299 + (1 - value) * 0.587 + Math.sqrt(value + 1);
    }
    // 최적화로 loop가 통째로 사라지지 않게 결과를 붙잡아 둔다(항상 거짓인 조건).
    if (!Number.isFinite(accumulator)) throw new Error('pace_probe_diverged');
    durations.push(performance.now() - started);
  }

  // 첫 iteration은 JIT 워밍업·첫 raster라 항상 느리다. 버린다.
  const measured = durations.slice(1).sort((a, b) => a - b);
  const middle = Math.floor(measured.length / 2);
  const medianMs = measured.length % 2 ? measured[middle] : (measured[middle - 1] + measured[middle]) / 2;
  return { perIterMs: measured[0], samples: measured.length, medianMs, maxMs: measured[measured.length - 1] };
}

/**
 * 크기는 실측으로 골랐다. 이보다 작으면 timer noise에 묻히고(8k rects에서 iteration 2.6ms,
 * 흔들림 ±40%), 이 크기에서는 iteration 약 27ms에 흔들림이 ±7% 안으로 들어온다.
 * probe 하나가 약 0.25s라 test 두 번 호출해도 비용이 무시할 만하다.
 */
const PROBE_ARGS = { width: 720, height: 1280, reps: 9, rects: 60_000, mathOps: 6_000_000 };

/** 같은 페이지에서 control을 한 번 잰다. 측정 구간 **밖에서만** 호출한다(부하를 주는 작업이다). */
export async function measurePace(page: Page): Promise<PaceSample> {
  return page.evaluate(paceProbe, PROBE_ARGS);
}

export interface PaceBudget {
  budgetMs: number;
  ratio: number;
  /** clamp 전 원본 비율 — 로그에서 기계가 실제로 얼마나 느렸는지 보이게 남긴다. */
  rawRatio: number;
  paceMs: number;
  capped: boolean;
}

/**
 * control에서 예산을 유도한다. `budget = base * clamp(ratio, 1, CAP)`.
 *
 * `paceSamples`는 측정 구간의 앞·뒤에서 잰 control들이다. 대표값으로 **가장 빠른 것**을 쓴다 —
 * 느린 쪽을 쓰면 어느 한쪽이 앱 작업이나 일시적 튐으로 오염됐을 때 예산이 부풀어 회귀를 변호한다.
 * 가장 빠른 쪽은 "이 기계는 적어도 이만큼은 빨랐다"는 보수적 진술이라 예산을 과하게 늘리지 않는다.
 */
export function paceBudget(baseMs: number, paceSamples: PaceSample[]): PaceBudget {
  const paceMs = Math.min(...paceSamples.map((sample) => sample.perIterMs));
  const rawRatio = paceMs / PACE_REFERENCE_MS;
  const ratio = Math.min(PACE_CAP, Math.max(1, rawRatio));
  return { budgetMs: Math.round(baseMs * ratio), ratio, rawRatio, paceMs, capped: rawRatio > PACE_CAP };
}

/** PASS·FAIL 어느 쪽이든 항상 남기는 한 줄. 다음 사람이 재실행 없이 둘을 구분할 수 있어야 한다. */
export function paceReport(
  label: string,
  measuredMs: number,
  baseMs: number,
  budget: PaceBudget,
  paceSamples: PaceSample[],
  extra: Record<string, unknown> = {},
): string {
  return `PACE_BUDGET ${JSON.stringify({
    gate: label,
    measuredMs: Math.round(measuredMs),
    baseMs,
    budgetMs: budget.budgetMs,
    verdict: measuredMs < budget.budgetMs ? 'within' : 'over',
    ...extra,
    machine: {
      paceMs: Number(budget.paceMs.toFixed(1)),
      referenceMs: PACE_REFERENCE_MS,
      rawRatio: Number(budget.rawRatio.toFixed(2)),
      appliedRatio: Number(budget.ratio.toFixed(2)),
      cap: PACE_CAP,
      cappedOut: budget.capped,
      probes: paceSamples.map((sample) => ({
        perIterMs: Number(sample.perIterMs.toFixed(1)),
        medianMs: Number(sample.medianMs.toFixed(1)),
        maxMs: Number(sample.maxMs.toFixed(1)),
        samples: sample.samples,
      })),
    },
  })}`;
}
