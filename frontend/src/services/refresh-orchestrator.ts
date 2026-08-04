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
import { actionErrorMessage } from './brief-view';
import { ACTIVE_REFRESH_MS, IDLE_REFRESH_MS, cadenceSeconds, hasActiveBriefs } from './refresh-cadence';

// ── 승인 문구 (INT-000025 / ISS-000050) ─────────────────────────────────────
// v2.20.0에는 `방금 업데이트`가 0건이었고 대신 `마지막 갱신 방금`이 나갔다.
// 인터뷰와 ISS-000050이 둘 다 `방금 업데이트`를 그대로 지정한다. 승인 문구를 정본으로 쓴다.
export const REFRESH_SUCCESS_TEXT = '방금 업데이트';
export const REFRESH_FAILURE_TEXT = '갱신 실패 · 다시 시도';
/**
 * 상단 바처럼 좁은 자리에서 쓰는 실패 문구. 뜻이 줄지 않는 이유: `다시 시도`가 가리키던
 * 행동이 바로 옆 `새로고침` 버튼으로 실물이 됐다. 전문은 낭독기 통지에 그대로 나간다.
 */
export const REFRESH_FAILURE_SHORT_TEXT = '갱신 실패';
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
  /** 화면에 그대로 쓰는 문구. `idle`에서는 빈 문자열이고 호출자가 신선도 줄을 대신 그린다. */
  text: string;
  /** 버튼 접근 이름 */
  label: string;
  /** `aria-busy` */
  busy: boolean;
  /** 낭독기 통지 방식. 성공은 방해하지 않고, 실패는 즉시 알린다. */
  role: 'status' | 'alert' | null;
  /** 이 상태를 만든 요청 세대 */
  generation: number;
  /**
   * 연달아 실패한 횟수. 성공하면 0으로 돌아간다.
   *
   * 이것이 상태에 들어 있는 이유: 같은 실패를 세 번째로 겪는 사람에게 **같은 문장**을 세 번
   * 보여 주는 것은 안내가 아니라 소음이다. 몇 번째인지 알아야 단계를 올릴 수 있고, 그 판정은
   * 화면이 아니라 요청을 세는 이 자리가 해야 어긋나지 않는다 (TSK-000559).
   */
  failureStreak: number;
  /** 실패의 원인. `failure`가 아닌 상태에서는 없다. 화면이 원인 갈래를 말할 근거다. */
  error?: unknown;
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
  failureStreak: 0,
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
  /** 연달아 실패한 횟수. 성공·세션 교체가 0으로 되돌린다. */
  let failureStreak = 0;
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
    emit({
      state: 'in-flight',
      text: REFRESH_BUSY_TEXT,
      label: REFRESH_BUSY_LABEL,
      busy: true,
      role: null,
      generation,
      failureStreak,
    });

    const promise = (async (): Promise<RefreshOutcome<T>> => {
      try {
        const value = await options.run({ signal: controller.signal, generation, trigger });
        // 늦게 도착한 응답은 최신 상태를 덮어쓰지 않는다.
        if (generation !== latest || generation <= barrier) return staleOutcome(generation, value);
        successAt = clock();
        failureStreak = 0;
        emit({ state: 'success', text: REFRESH_SUCCESS_TEXT, label: REFRESH_IDLE_LABEL, busy: false, role: 'status', generation, failureStreak });
        return { generation, applied: true, stale: false, value };
      } catch (error) {
        if (generation !== latest || generation <= barrier) return staleOutcome(generation, undefined, error);
        failureStreak += 1;
        emit({
          state: 'failure',
          text: REFRESH_FAILURE_TEXT,
          label: REFRESH_IDLE_LABEL,
          busy: false,
          role: 'alert',
          generation,
          failureStreak,
          error,
        });
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
      // 연결·계정이 바뀌면 이전 subject에서 쌓인 실패 횟수는 이 화면의 사실이 아니다.
      failureStreak = 0;
      emit({ ...IDLE_STATUS, generation: sequence });
    },
    inFlight: () => active !== null,
    generation: () => latest,
  };
}

/** 마지막 성공에서 지난 시간을 사람 말로. 없으면 빈 문자열이고 호출자가 그 조각을 뺀다. */
export function refreshAgoText(ago?: number | null): string {
  if (ago === null || ago === undefined || !Number.isFinite(ago)) return '';
  if (ago < 5_000) return '방금';
  if (ago < 60_000) return `${Math.floor(ago / 1000)}초 전`;
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}분 전`;
  return `${Math.floor(ago / 3_600_000)}시간 전`;
}

/*
 * ── `refreshIdleText`가 사라진 자리 (통합 검수 2026-08-04 / INT-000036)
 *
 * 여기에는 `명함 기록` 구획 옆 한 줄(`.refresh-hint`)이 쓰던 조립 함수가 있었다. 그 줄은
 * 자동 켜짐/꺼짐 · 지금 걸려 있는 박자 · 마지막 성공을 말했다 — 상단 바가 이미 말하는
 * **바로 그 세 가지**를.
 *
 * 두 줄이 어긋나던 동안에는 그것이 "같은 말을 하게 맞추는" 문제로 보였고, 실제로 박자 조각을
 * `refreshCadenceText`의 파생으로 바꿔 맞췄다. 맞추고 나니 남은 것이 드러났다: 같은 계획에서
 * 같은 낱말로 같은 사실을 말하는 두 번째 줄에는 **자기 일이 없다**. 낭독기 기준으로는 기능
 * 상태와 신선도가 매번 두 번씩 읽히는 것이 전부였다.
 *
 * 그래서 줄을 지웠고, 그 줄만 쓰던 이 함수도 함께 지웠다. 표면이 없어졌는데 조립 함수를
 * 남겨 두면 다음 사람이 "쓸 데가 있으니 있겠지" 하고 두 번째 표면을 다시 세운다.
 * 갱신 사실의 주인은 이제 상단 갱신 덩어리 하나뿐이다 (`refreshHeadlineText`).
 */

export type RefreshCadenceReason = 'active' | 'idle' | 'hidden' | 'disconnected' | 'off';

export interface RefreshCadencePlan {
  intervalMs: number;
  /** 지금은 폴링하지 않는다. 사용자가 껐거나, 화면이 가려졌거나, 연결이 없을 때다. */
  paused: boolean;
  reason: RefreshCadenceReason;
}

/**
 * 지금 얼마 간격으로 폴링해야 하는가.
 *
 * 기존 박자를 그대로 유지한다 (`status-truth.spec.ts` 게이트: 활성 목록 요청은 5초 안에 시작되고,
 * 종료 뒤 5.5초 안에 멈추며, 숨김→표시 복귀는 1초 안에 재개된다). 달라진 것은 그 판단이
 * 이제 App 안 인라인이 아니라 테스트되는 자리에 있다는 점이다.
 *
 * `autoRefreshOn: false`가 가장 먼저다. 그것은 세상의 사정이 아니라 **사용자가 방금 내린
 * 결정**이고, 다른 이유로 덮어 말하면 스위치를 끈 사람에게 화면이 딴소리를 한다.
 */
export function refreshCadencePlan(input: {
  items?: ReadonlyArray<BriefItem> | null;
  hidden?: boolean;
  configured?: boolean;
  /** 기본은 켜짐. 값을 주지 않는 호출자(기존 계산)는 예전과 똑같이 동작한다. */
  autoRefreshOn?: boolean;
}): RefreshCadencePlan {
  const items = input.items ?? [];
  const intervalMs = hasActiveBriefs([...items]) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
  if (input.autoRefreshOn === false) return { intervalMs, paused: true, reason: 'off' };
  if (input.configured === false) return { intervalMs, paused: true, reason: 'disconnected' };
  if (input.hidden) return { intervalMs, paused: true, reason: 'hidden' };
  return { intervalMs, paused: false, reason: intervalMs === ACTIVE_REFRESH_MS ? 'active' : 'idle' };
}

/**
 * 좁은 상단 바에 들어가는 **짧은** 박자 조각 (`20초마다`).
 *
 * 숫자는 `plan.intervalMs`에서만 나온다. 그래서 활성 4초 ↔ 유휴 20초로 박자가 바뀌면
 * 이 글자도 같은 순간에 바뀐다 — 평균값이나 대표값을 적어 두는 자리가 아예 없다.
 */
export function refreshCadenceText(plan: RefreshCadencePlan): string {
  if (plan.reason === 'off') return '자동 꺼짐';
  if (plan.reason === 'disconnected') return '연결되면 확인';
  if (plan.reason === 'hidden') return '돌아오면 확인';
  return `${cadenceSeconds(plan.intervalMs)}초마다`;
}

/**
 * 같은 사실의 **정직한 전문**. 짧은 조각은 지금 값 하나만 말하므로, 낭독기와 설명 자리에는
 * 지금 몇 초인지와 **왜 달라지는지**를 함께 준다. 적응형 박자를 "20초마다"라고만 쓰면
 * 처리 중일 때의 실제 동작과 어긋난다.
 */
export function refreshCadenceSentence(plan: RefreshCadencePlan): string {
  if (plan.reason === 'off') return '자동 갱신이 꺼져 있어요. 새로고침을 누를 때만 확인합니다.';
  if (plan.reason === 'disconnected') return '연결되면 자동으로 확인합니다.';
  if (plan.reason === 'hidden') return '화면을 다시 열면 바로 확인합니다.';
  const fast = cadenceSeconds(ACTIVE_REFRESH_MS);
  const slow = cadenceSeconds(IDLE_REFRESH_MS);
  return plan.reason === 'active'
    ? `처리 중인 항목이 있어 지금은 ${fast}초마다 확인합니다. 모두 끝나면 ${slow}초마다로 돌아갑니다.`
    : `지금은 ${slow}초마다 확인합니다. 처리 중인 항목이 생기면 ${fast}초마다 더 자주 확인합니다.`;
}

/**
 * 스위치·버튼 아래 한 줄이 지금 무엇을 말해야 하는가.
 *
 * 세 가지 사실을 **한 기호에 합치지 않기 위한** 마지막 조립 지점이다.
 *   - 기능 상태(자동 켜짐/꺼짐)는 스위치가 스스로 말한다.
 *   - 작업 상태(요청 중)는 **버튼 하나가 통째로 소유한다** — 회전과 `aria-busy`가 전부다.
 *   - 이 줄은 신선도와 박자다. 요청이 떠 있는 동안에도 자리를 내주지 않는다.
 *
 * ── 진행 문구가 이 줄에서 빠진 이유 (통합 검수 2026-08-04 / INT-000036)
 * 예전에는 요청이 떠 있는 동안 이 줄이 `갱신 중`으로 바뀌었다. 계약상으로는 "한 번에 한
 * 사실"이었지만, 화면에는 그 순간 **진행을 말하는 자리가 둘**이었다 — `aria-busy`를 든 버튼과
 * 이 줄. 낭독기 사용자는 같은 사실을 두 번 듣고, 눈으로 보는 사람은 어느 쪽이 주인인지 알
 * 방법이 없다. 자리를 내주는 것 자체가 중복이었다.
 *
 * 그래서 진행은 버튼만 말한다. **결말은 여전히 이 줄이 말한다** (`방금 업데이트`·`갱신 실패`) —
 * 그것은 진행이 아니라 영수증이고, 성공을 닫는 유일한 표면이 이 줄이기 때문이다.
 * `in-flight`가 여기 내려오면 신선도·박자가 그대로 서 있는다: 마지막으로 받은 시점은 요청이
 * 떠 있는 동안에도 여전히 참이다.
 */
export function refreshHeadlineText(input: {
  plan: RefreshCadencePlan;
  status?: RefreshStatus | null;
  lastSuccessAgoMs?: number | null;
}): string {
  const state = input.status?.state;
  if (state === 'success') return REFRESH_SUCCESS_TEXT;
  if (state === 'failure') return REFRESH_FAILURE_SHORT_TEXT;
  const beat = refreshCadenceText(input.plan);
  const since = refreshAgoText(input.lastSuccessAgoMs);
  return since ? `${since} · ${beat}` : beat;
}

// ── 막힘·실패 안내 (INT-000036 / TSK-000559) ──────────────────────────────────
//
// 여기까지 오기 전, 실패는 2.6초짜리 토스트였다. 그것이 왜 틀렸는지가 이 코드의 이유다:
// **사용자가 조치해야 하는 사실에 2.6초짜리 수명을 주면 그 사실은 전달되지 않는다.**
// 화면을 안 보고 있었거나, 읽는 사이에 사라지거나, 무엇을 하라는 것인지 알기 전에 닫힌다.
// 그래서 안내는 다음 요청이 결말을 낼 때까지 **남아 있고**, 갱신 조작 바로 옆에 붙는다 —
// 무엇이 막혔는지와 그것을 푸는 손잡이가 같은 자리에 있어야 한다.

export type RefreshNoticeReason = 'disconnected' | 'offline' | 'failure';

export interface RefreshNotice {
  reason: RefreshNoticeReason;
  /**
   * 화면에 보이는 짧은 말. 원인 갈래이자 **다음에 확인할 대상**이다.
   * 반복 실패에서 단계가 오르면 이 문구가 함께 바뀐다 — 눈에 보이지 않는 단계 상승은
   * 단계를 올리지 않은 것과 같기 때문이다.
   */
  title: string;
  /** 지금 무슨 일이 일어나고 무엇을 할 수 있는가. 낭독기와 도움말이 읽는 전문. */
  detail: string;
  /** `다시 시도`가 실제로 무언가를 할 수 있는 상황인가. */
  retry: boolean;
  /** 화면 색조. 막힘은 경고, 실패는 오류다. */
  tone: 'blocked' | 'error';
  /** 몇 번째 연속 실패인가. 막힘 안내에서는 0이다. */
  streak: number;
}

/**
 * 실패의 **원인 갈래**. 전문(`actionErrorMessage`)은 길어서 상단 바에 못 들어가고,
 * 좁은 자리에 `갱신 실패`만 쓰면 무엇을 확인해야 하는지 알 수 없다. 그래서 갈래를 짧게 이름
 * 붙이고 전문은 그대로 옆에 둔다 — 줄이는 것이지 감추는 것이 아니다.
 */
export function refreshFailureTitle(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|abort/i.test(raw)) return '네트워크 오류';
  if (/owner_only|bad_token|unauthorized|forbidden|invalid_token/i.test(raw)) return '권한 오류';
  if (/server_error|list_failed|^5\d\d$/i.test(raw)) return '서버 오류';
  if (/missing_api|not_configured|no_token/i.test(raw)) return '연결 오류';
  return '갱신 실패';
}

/**
 * 반복되는 실패에서 **다음에 할 일**을 한 단계 올린다.
 *
 * 1회 — 대개 일시적이다. 원인 전문을 그대로 주고 다시 눌러 보게 한다.
 * 2회 — 우연이 아니다. 확인할 대상(연결)을 지목한다.
 * 4회 — 눌러서 풀리는 문제가 아니다. 설정을 열어 보라고 말한다.
 *
 * 같은 문장을 N번 반복하지 않는 이유는 예의가 아니라 정보량이다. 두 번째에 같은 말을 하면
 * 그 문장은 "다시 눌러라" 외에 아무것도 알려 주지 않는다.
 */
function failureDetail(error: unknown, streak: number): string {
  if (streak >= 4) return `${actionErrorMessage(error)} 계속 실패하고 있어요 — 설정에서 연결을 다시 확인해 주세요.`;
  if (streak >= 2) return `${actionErrorMessage(error)} 연결(Wi-Fi·데이터)이 살아 있는지 확인하고 다시 눌러 주세요.`;
  return actionErrorMessage(error);
}

/** 단계가 오른 것을 **눈으로도** 알 수 있게 하는 조각. 보이지 않는 단계 상승은 상승이 아니다. */
function failureStep(streak: number): string {
  if (streak >= 4) return ' · 설정에서 연결 확인';
  if (streak >= 2) return ' · 연결 확인';
  return '';
}

/**
 * 지금 갱신을 막고 있는 것이 있는가. 없으면 `null`이고 화면에는 아무것도 나타나지 않는다.
 *
 * 순서에 뜻이 있다.
 *   1. 연결이 없다 — 어떤 요청도 성립하지 않는다. 다른 원인을 말해 봐야 거짓이다.
 *   2. 오프라인 — 요청은 성립하지만 지금은 나가지 못한다. 사용자가 할 일이 아니라 **기다림**이다.
 *   3. 실패 — 위 둘이 아닌데도 실패했다. 그제서야 원인 갈래를 말할 자격이 있다.
 *
 * `asked`가 연결 없음에만 붙는 이유: 미연결 안내는 본문에 이미 상시로 붙어 있다(연결 카드).
 * 상단에까지 늘 띄우면 같은 말을 두 자리에서 하게 된다. 다만 **새로고침을 눌렀는데 아무 일도
 * 일어나지 않는 것**은 답을 줘야 하는 질문이므로, 그때만 이 자리에서 답한다.
 */
export function refreshNotice(input: {
  plan: RefreshCadencePlan;
  /** 직접 누른 갱신의 실패 영수증. 자동 박자의 실패는 여기에 오지 않는다. */
  failure?: RefreshStatus | null;
  /** 이 기기가 네트워크에 붙어 있는가. 모르면 붙어 있다고 본다. */
  online?: boolean;
  /** 연결이 없는 상태에서 사용자가 갱신을 시도했는가. */
  asked?: boolean;
}): RefreshNotice | null {
  if (input.plan.reason === 'disconnected') {
    if (input.asked !== true) return null;
    return {
      reason: 'disconnected',
      title: '연결 필요',
      detail: '개인 링크로 열면 목록을 받아올 수 있어요. 이 기기에 저장된 것은 그대로예요.',
      retry: false,
      tone: 'blocked',
      streak: 0,
    };
  }
  if (input.online === false) {
    return {
      reason: 'offline',
      title: '오프라인',
      detail: '연결되면 자동으로 다시 확인해요. 이 기기에 있는 기록은 그대로 볼 수 있어요.',
      retry: false,
      tone: 'blocked',
      streak: 0,
    };
  }
  const failure = input.failure;
  if (!failure || failure.state !== 'failure') return null;
  const streak = Math.max(failure.failureStreak, 1);
  return {
    reason: 'failure',
    title: `${refreshFailureTitle(failure.error)}${failureStep(streak)}`,
    detail: failureDetail(failure.error, streak),
    retry: true,
    tone: 'error',
    streak,
  };
}

export interface RefreshLoopTimers {
  set(handler: () => void, ms: number): number;
  clear(id: number): void;
}

export interface RefreshLoopOptions {
  /** 한 박자마다 부르는 갱신. 폴링이므로 이미 떠 있는 요청에 합류한다. */
  tick(): void;
  /**
   * 화면이 가려졌는가. 가려진 동안에는 요청하지 않지만 타이머는 그대로 둔다 —
   * 복귀 즉시 재개하는 기존 계약(`status-truth.spec.ts`)을 지키기 위해서다.
   */
  hidden?(): boolean;
  /** 시계 주입 지점. 테스트에서 가짜 타이머를 넣어 박자를 결정적으로 잰다. */
  timers?: RefreshLoopTimers;
}

export interface RefreshLoop {
  /** 새 계획을 적용한다. 간격이 그대로면 타이머를 다시 걸지 않는다(박자가 밀리지 않는다). */
  apply(plan: RefreshCadencePlan): void;
  /**
   * 지금 걸려 있는 타이머 수(0 또는 1).
   * `자동 갱신 꺼짐`의 증거는 문구가 아니라 **이 값이 0이라는 사실**이다.
   */
  timerCount(): number;
  /** 지금 걸린 간격. 멈춰 있으면 null. */
  intervalMs(): number | null;
  stop(): void;
}

/**
 * 폴링 타이머를 소유한다. 계획 하나가 타이머와 화면 문구를 **동시에** 결정하므로
 * "화면은 20초라고 쓰는데 실제로는 4초마다 돈다"가 구조적으로 불가능하다.
 */
export function createRefreshLoop(options: RefreshLoopOptions): RefreshLoop {
  const timers: RefreshLoopTimers = options.timers ?? {
    set: (handler, ms) => window.setInterval(handler, ms),
    clear: (id) => window.clearInterval(id),
  };
  let handle: number | null = null;
  let current: number | null = null;

  function stop(): void {
    if (handle === null) return;
    timers.clear(handle);
    handle = null;
    current = null;
  }

  return {
    apply(plan: RefreshCadencePlan): void {
      if (plan.paused) {
        stop();
        return;
      }
      if (handle !== null && current === plan.intervalMs) return;
      stop();
      current = plan.intervalMs;
      handle = timers.set(() => {
        if (options.hidden?.() === true) return;
        options.tick();
      }, plan.intervalMs);
    },
    timerCount: () => (handle === null ? 0 : 1),
    intervalMs: () => current,
    stop,
  };
}
