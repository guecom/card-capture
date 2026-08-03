// 새로고침의 오케스트레이션을 services 계층으로 끌어낸다 (INT-000025, DEC-000092 §2 상태 문법).
//
// 이전에는 `refresh-cadence.ts`가 상수 두 개뿐이었고, 우선순위·single-flight·상태 문구는 전부
// `App.tsx` 안에 인라인으로 있어 단위 테스트가 하나도 없었다. 그 사이에 **늦게 도착한 응답이
// 새 응답을 덮어쓰는 결함**이 그대로 남아 있었다 — 프런트엔드 전체에 `AbortController`도
// 요청 식별자도 0건이었다.
//
// 여기가 그 네 가지를 한곳에서 지키는 자리다.
//   1. 우선 갱신 — 직접 누르거나 앱으로 돌아오면 다음 폴링 차례를 기다리지 않는다.
//   2. single-flight — 겹친 trigger는 하나의 요청으로 합쳐진다 (`maxListInFlight === 1` 게이트).
//   3. 세대(generation) — 최신이 아닌 응답은 **버린다**. 이건 다듬기가 아니라 정확성 결함이었다.
//   4. 상태 기계 — `idle → in-flight → success | failure`, 승인된 문구 그대로.

import type { BriefItem } from '../contracts/capture';
import { ACTIVE_REFRESH_MS, IDLE_REFRESH_MS, hasActiveBriefs } from './refresh-cadence';

// ── 승인 문구 (INT-000025 / ISS-000050) ─────────────────────────────────────
// v2.20.0에는 `방금 업데이트`가 0건이었고 대신 `마지막 갱신 방금`이 나갔다.
// 인터뷰와 ISS-000050이 둘 다 `방금 업데이트`를 그대로 지정한다. 승인 문구를 정본으로 쓴다.
export const REFRESH_SUCCESS_TEXT = '방금 업데이트';
export const REFRESH_FAILURE_TEXT = '갱신 실패 · 다시 시도';
/** 요청이 떠 있는 동안의 문구. 회전 애니메이션도 이 상태에서만 존재한다. */
export const REFRESH_BUSY_TEXT = '갱신 중';
/** 접근 이름 한 쌍. 버튼 이름은 앱 전체에서 이 둘뿐이다. */
export const REFRESH_IDLE_LABEL = '새로고침';
export const REFRESH_BUSY_LABEL = '새로고침 중';
/** 성공 문구를 보여 주는 시간. 지나면 idle로 돌아간다. */
export const REFRESH_SUCCESS_HOLD_MS = 2_000;

export type RefreshState = 'idle' | 'in-flight' | 'success' | 'failure';

/**
 * `auto` — 폴링. 이미 요청이 떠 있으면 그것을 함께 기다린다.
 * `priority` — 직접 누름·앱 복귀·작업 직후. 떠 있는 요청이 작업 **이전**의 사진일 수 있으므로,
 *   그것이 끝난 직후 한 번 더 읽는다. 그래도 동시에 뜨는 list 요청은 언제나 하나다.
 */
export type RefreshTrigger = 'auto' | 'priority';

export interface RefreshStatus {
  state: RefreshState;
  /** 화면에 그대로 쓰는 문구. `idle`에서는 빈 문자열이고 호출자가 `refreshIdleText`를 쓴다. */
  text: string;
  /** 버튼 접근 이름 */
  label: string;
  /** `aria-busy` */
  busy: boolean;
  /** 낭독기 통지 방식. 성공은 방해하지 않고, 실패는 즉시 알린다. */
  role: 'status' | 'alert' | null;
  /** 이 상태를 만든 요청 세대 */
  generation: number;
}

export interface RefreshOutcome<T> {
  generation: number;
  /** 이 응답이 최신 세대라서 화면에 반영됐는가 */
  applied: boolean;
  /** 더 새로운 요청·세션 교체 때문에 버려진 응답인가 */
  stale: boolean;
  value?: T;
  error?: unknown;
}

export interface RefreshOrchestratorOptions<T> {
  /**
   * 실제 목록 조회. `signal`은 버려질 요청을 끊는 용도다 —
   * 늦게 온 응답을 버리는 판정은 `generation`이 하므로 `signal`을 무시해도 정확성은 유지된다.
   */
  run: (context: { signal: AbortSignal; generation: number; trigger: RefreshTrigger }) => Promise<T>;
  onStatus?: (status: RefreshStatus) => void;
  successHoldMs?: number;
  /** 시계 주입 지점. 기본은 실행 시점의 `Date.now`이고 빌드 산출물에 시각을 넣지 않는다. */
  now?: () => number;
}

const IDLE_STATUS: RefreshStatus = {
  state: 'idle',
  text: '',
  label: REFRESH_IDLE_LABEL,
  busy: false,
  role: null,
  generation: 0,
};

export interface RefreshOrchestrator<T> {
  status(): RefreshStatus;
  /** 갱신을 요청한다. 겹친 요청은 같은 Promise를 공유한다. */
  request(trigger?: RefreshTrigger): Promise<RefreshOutcome<T>>;
  /**
   * 흐르는 시간을 알려 준다 (예: 이미 있는 1초 clock). 성공 문구가 유지 시간을 넘기면 idle로 돌아간다.
   * 타이머를 이 모듈이 직접 잡지 않아 테스트에서 시간이 결정적이다.
   */
  tick(now: number): void;
  /**
   * 연결·계정이 바뀌었다. 지금 떠 있는 요청은 모두 stale이 되고 상태는 idle로 돌아간다.
   * 이전 subject의 늦은 응답이 새 화면에 쓰이지 않게 하는 경계다.
   */
  reset(): void;
  inFlight(): boolean;
  /** 마지막으로 시작된 요청의 세대 번호 */
  generation(): number;
}

export function createRefreshOrchestrator<T>(options: RefreshOrchestratorOptions<T>): RefreshOrchestrator<T> {
  const holdMs = options.successHoldMs ?? REFRESH_SUCCESS_HOLD_MS;
  const clock = options.now ?? (() => Date.now());
  let sequence = 0;
  /** 마지막으로 **시작된** 세대. 이보다 오래된 응답은 최신이 아니다. */
  let latest = 0;
  /** 이 세대 이하의 응답은 세션이 바뀌었으므로 전부 버린다. */
  let barrier = 0;
  let status: RefreshStatus = IDLE_STATUS;
  let successAt: number | null = null;
  let active: { promise: Promise<RefreshOutcome<T>>; controller: AbortController } | null = null;
  let trailing: Promise<RefreshOutcome<T>> | null = null;

  function emit(next: RefreshStatus): void {
    status = next;
    options.onStatus?.(next);
  }

  function staleOutcome(generation: number, value?: T, error?: unknown): RefreshOutcome<T> {
    return { generation, applied: false, stale: true, value, error };
  }

  function start(trigger: RefreshTrigger): Promise<RefreshOutcome<T>> {
    const generation = ++sequence;
    latest = generation;
    const controller = new AbortController();
    successAt = null;
    emit({ state: 'in-flight', text: REFRESH_BUSY_TEXT, label: REFRESH_BUSY_LABEL, busy: true, role: null, generation });

    const promise = (async (): Promise<RefreshOutcome<T>> => {
      try {
        const value = await options.run({ signal: controller.signal, generation, trigger });
        // 늦게 도착한 응답은 최신 상태를 덮어쓰지 않는다.
        if (generation !== latest || generation <= barrier) return staleOutcome(generation, value);
        successAt = clock();
        emit({ state: 'success', text: REFRESH_SUCCESS_TEXT, label: REFRESH_IDLE_LABEL, busy: false, role: 'status', generation });
        return { generation, applied: true, stale: false, value };
      } catch (error) {
        if (generation !== latest || generation <= barrier) return staleOutcome(generation, undefined, error);
        emit({ state: 'failure', text: REFRESH_FAILURE_TEXT, label: REFRESH_IDLE_LABEL, busy: false, role: 'alert', generation });
        return { generation, applied: false, stale: false, error };
      }
    })();

    const entry = { promise, controller };
    active = entry;
    void promise.finally(() => {
      if (active === entry) active = null;
    });
    return promise;
  }

  function request(trigger: RefreshTrigger = 'auto'): Promise<RefreshOutcome<T>> {
    const current = active;
    if (!current) return start(trigger);
    // 폴링은 떠 있는 요청을 함께 기다린다 — 같은 사진을 두 번 받을 이유가 없다.
    if (trigger !== 'priority') return current.promise;
    // 우선 갱신이 여럿 겹쳐도 뒤따르는 조회는 하나다.
    if (trailing) return trailing;
    const session = barrier;
    const queued = current.promise.catch(() => null).then((): Promise<RefreshOutcome<T>> | RefreshOutcome<T> => {
      trailing = null;
      if (session !== barrier) return staleOutcome(latest);
      // 먼저 깨어난 다른 우선 trigger가 이미 시작했다면 그것을 함께 기다린다.
      if (active) return active.promise;
      return start('priority');
    });
    trailing = queued;
    return queued;
  }

  return {
    status: () => status,
    request,
    tick(now: number): void {
      if (status.state !== 'success' || successAt === null) return;
      if (now - successAt < holdMs) return;
      successAt = null;
      emit({ ...IDLE_STATUS, generation: status.generation });
    },
    reset(): void {
      barrier = sequence;
      trailing = null;
      active?.controller.abort();
      active = null;
      successAt = null;
      emit({ ...IDLE_STATUS, generation: sequence });
    },
    inFlight: () => active !== null,
    generation: () => latest,
  };
}

/**
 * idle에서 새로고침 버튼 옆에 쓰는 문구 (DEC-000092 §2).
 * 다음 갱신 시각은 지어내지 않는다 — 자동 갱신이 켜져 있다는 사실과 마지막 성공만 말한다.
 */
export function refreshIdleText(input: { autoRefreshOn: boolean; lastSuccessAgoMs?: number | null }): string {
  const ago = input.lastSuccessAgoMs;
  const since = ago === null || ago === undefined || !Number.isFinite(ago)
    ? null
    : ago < 5_000 ? '방금'
      : ago < 60_000 ? `${Math.floor(ago / 1000)}초 전`
        : ago < 3_600_000 ? `${Math.floor(ago / 60_000)}분 전`
          : `${Math.floor(ago / 3_600_000)}시간 전`;
  if (!input.autoRefreshOn) return since ? `자동 갱신 꺼짐 · ${since}` : '자동 갱신 꺼짐';
  return since ? `자동 갱신 켜짐 · ${since}` : '자동 갱신 켜짐';
}

export type RefreshCadenceReason = 'active' | 'idle' | 'hidden' | 'disconnected';

export interface RefreshCadencePlan {
  intervalMs: number;
  /** 지금은 폴링하지 않는다. 화면이 가려졌거나 연결이 없을 때다. */
  paused: boolean;
  reason: RefreshCadenceReason;
}

/**
 * 지금 얼마 간격으로 폴링해야 하는가.
 *
 * 기존 박자를 그대로 유지한다 (`status-truth.spec.ts` 게이트: 활성 목록 요청은 5초 안에 시작되고,
 * 종료 뒤 5.5초 안에 멈추며, 숨김→표시 복귀는 1초 안에 재개된다). 달라진 것은 그 판단이
 * 이제 App 안 인라인이 아니라 테스트되는 자리에 있다는 점이다.
 */
export function refreshCadencePlan(input: {
  items?: ReadonlyArray<BriefItem> | null;
  hidden?: boolean;
  configured?: boolean;
}): RefreshCadencePlan {
  const items = input.items ?? [];
  const intervalMs = hasActiveBriefs([...items]) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
  if (input.configured === false) return { intervalMs, paused: true, reason: 'disconnected' };
  if (input.hidden) return { intervalMs, paused: true, reason: 'hidden' };
  return { intervalMs, paused: false, reason: intervalMs === ACTIVE_REFRESH_MS ? 'active' : 'idle' };
}
