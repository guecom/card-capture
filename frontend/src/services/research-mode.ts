// 조사 깊이 — 사용자가 고르는 것은 **결과와 기다림**이고, 어디로 보내지는지는 내부 설정이다.
//
// founder 판정 2026-08-04 (INT-000030 / TSK-000542):
//   "AI 조사 요청에 빠른 조사, 일반 조사, 깊은 조사를 선택하는 옵션 버튼이 있었으면 좋겠어.
//    … 실질적으로 유저는 어떤 모델이 연결되는지 사실에 대해서 몰랐으면 좋겠어."
//
// 그래서 이 파일은 **두 개의 표를 일부러 분리해서** 가지고 있다.
//
//   1. `RESEARCH_DEPTHS`  — 사용자에게 보이는 말. 결과·기다림만 있고 식별자는 한 글자도 없다.
//   2. `RESEARCH_ROUTE_R1` — 내부 라우팅. 식별자는 오직 여기와 개발자 telemetry에만 산다.
//
// 둘을 한 객체에 합치면 언젠가 누군가 "설명 옆에 뭐가 붙었는지 같이 보여 주자"고 쓰게 된다.
// 표가 나뉘어 있으면 그 실수가 타입 단계에서 어색해지고, `research-mode.test.ts`가 실제로
// 사용자 문구 안에 binding 식별자가 섞였는지 매번 훑는다.
//
// 라우팅은 **버전이 붙은 설정**이다. 연결이 바뀌면 새 버전 객체로 통째로 갈아 끼우고,
// 그 버전이 telemetry 영수증에 그대로 남는다 — "그때 무엇으로 보냈나"를 나중에 되짚기 위해서다.
// 이 파일은 어떤 외부 호출도 하지 않는다. 깊이는 요청에 실려 나가는 계약일 뿐이다.

import { DEFAULT_RESEARCH_DEPTH, type ResearchDepth } from '../contracts/int30';

export { DEFAULT_RESEARCH_DEPTH };
export type { ResearchDepth };

/** 기다림의 상대적 무게. **분 단위를 약속하지 않는다** — 지킬 수 없는 숫자는 적지 않는다. */
export type ResearchWaitWeight = 1 | 2 | 3;

/** 기다림 눈금의 칸 수. 화면의 막대와 이 값이 같은 곳에서 나온다. */
export const RESEARCH_WAIT_STEPS = 3;

export interface ResearchDepthOption {
  depth: ResearchDepth;
  /** 버튼에 적히는 이름 */
  label: string;
  /** 칸 안에 들어가는 아주 짧은 결과 요약. 한 줄을 넘기지 않는다. */
  short: string;
  /** 고른 뒤 한 줄로 읽어 주는 말 — **무엇을 얻고 얼마나 기다리는지**. */
  detail: string;
  wait: ResearchWaitWeight;
}

/**
 * 고를 수 있는 깊이. **순서가 계약이다** — 얕은 것부터 깊은 것까지 언제나 같은 차례로 선다.
 *
 * 문구 규칙 세 가지:
 *  1. 무엇이 연결되는지 말하지 않는다. 사용자가 얻는 것과 기다리는 정도만 말한다.
 *  2. 조사 **범위**를 바꾸는 것처럼 들리면 안 된다 — 범위는 위에서 고른 그대로다.
 *     그래서 세 문장이 모두 `고른 범위를`로 시작한다.
 *  3. 분·초를 약속하지 않는다. 실제 대기는 그날 부하에 따라 달라지고, 어긴 약속은 신뢰를 깎는다.
 */
export const RESEARCH_DEPTHS: readonly ResearchDepthOption[] = [
  {
    depth: 'quick',
    label: '빠른 조사',
    short: '핵심만',
    detail: '고른 범위를 핵심 근거 위주로 확인해요. 기다리는 시간이 가장 짧습니다.',
    wait: 1,
  },
  {
    depth: 'standard',
    label: '일반 조사',
    short: '균형 있게',
    detail: '고른 범위를 표준 깊이로 확인해요. 대부분의 만남에는 이 정도로 충분합니다.',
    wait: 2,
  },
  {
    depth: 'deep',
    label: '깊은 조사',
    short: '근거까지',
    detail: '고른 범위를 근거까지 넓게 대조해요. 기다리는 시간이 가장 깁니다.',
    wait: 3,
  },
] as const;

const DEPTH_BY_KEY = new Map(RESEARCH_DEPTHS.map((option) => [option.depth, option]));

/**
 * 알 수 없는 값은 기본값으로 되돌린다.
 *
 * 저장된 초안·옛 요청·손으로 만든 payload가 이 자리에 무엇이든 넣을 수 있다. 요청이 깊이 하나
 * 때문에 통째로 거절되는 것보다, 기본 깊이로 접수되고 그 사실이 telemetry에 `unknown_depth`로
 * 남는 편이 낫다.
 */
export function normalizeResearchDepth(value: unknown): ResearchDepth {
  return typeof value === 'string' && DEPTH_BY_KEY.has(value as ResearchDepth)
    ? (value as ResearchDepth)
    : DEFAULT_RESEARCH_DEPTH;
}

export function researchDepthOption(depth: unknown): ResearchDepthOption {
  return DEPTH_BY_KEY.get(normalizeResearchDepth(depth))!;
}

/** 지금 고른 깊이를 한 줄로 읽어 주는 말. 화면의 `role="status"` 줄이 이것을 그대로 쓴다. */
export function researchDepthSummary(depth: unknown): string {
  const option = researchDepthOption(depth);
  return `${option.label} — ${option.detail}`;
}

// ── 접수 조건 ────────────────────────────────────────────────────────────────
// Product 계약 (`63_Research_Instruction_Contract.md`):
//   "사용자-facing mode는 `빠른 조사·일반 조사·깊은 조사`이고 신규 요청 기본값은 `일반 조사`다.
//    **깊은 조사는 목적을 하나 이상 골라야 접수된다.**"
//
// 왜 규칙이 여기 사는가: 이 판정을 JSX 안에 두면 두 화면(촬영 탭·인물 시트)이 각자 한 벌씩
// 갖게 되고, 그중 하나만 고쳐지는 날이 반드시 온다. 순수 함수 하나가 판정하고 화면은 그 결과를
// **그리기만** 한다.
//
// 막을 때 지키는 두 가지 (founder 요구 아님 — 계약이 그렇게 읽힌다):
//   1. 깊이를 몰래 낮추지 않는다. `깊은 조사`를 골랐으면 골라진 채로 막힌다.
//   2. 범위를 대신 골라 주지 않는다. 고르는 것은 언제나 사람의 손이다.
// 그래서 이 함수는 값을 고치지 않고 **왜 막혔고 무엇을 하면 풀리는지**만 돌려준다.

/** 지금 접수할 수 있는가. `empty`는 아직 보낼 것이 없다는 뜻이지 거절이 아니다. */
export type ResearchSubmitState = 'ready' | 'empty' | 'blocked';

/**
 * 막는 규칙의 닫힌 목록.
 *
 * - `deep_requires_scope` — 계약의 "깊은 조사는 목적 1개 이상". 사용자가 범위를 고르면 풀린다.
 * - `deep_unavailable` — 서버가 지금 깊은 조사를 열어 두지 않았다. 사용자가 이 자리에서 풀 수
 *   있는 조건이 아니므로 **먼저** 판정한다. 고를 수 없는 것을 고르게 두고 나중에 다른 이유로
 *   막는 화면은 거짓말이다.
 */
export type ResearchSubmitBlock = 'deep_requires_scope' | 'deep_unavailable';

/** 깊은 조사가 접수되기 위해 필요한 최소 범위 수. 계약의 `하나 이상`이 이 숫자다. */
export const RESEARCH_DEEP_MIN_SCOPES = 1;

/**
 * 사람에게 그대로 읽히는 말. **막히기 전과 막힌 뒤가 같은 문장이다** — 범위를 0개로 둔 채
 * `깊은 조사`를 고른 순간부터 보이고, 실제로 막힐 때 같은 말이 제출 버튼의 이름에도 실린다.
 * 두 자리에서 다른 말을 하면 사용자는 둘을 다른 문제로 읽는다.
 */
export interface ResearchSubmitNotice {
  block: ResearchSubmitBlock;
  /** 한 줄 제목. 아직 아무것도 안 적었을 때도 거짓이 되지 않아야 한다. */
  title: string;
  /** 왜. 자유 입력만으로는 안 된다는 사실까지 말한다 — 그것이 가장 흔한 오해다. */
  reason: string;
  /** 무엇을 하면 풀리는가. **두 갈래를 모두** 말한다: 범위를 고르거나, 깊이를 낮추거나. */
  fix: string;
}

export interface ResearchSubmitGate {
  state: ResearchSubmitState;
  /** 제출을 실제로 거절하고 있는가. `empty`와 구분해야 촬영 저장까지 막지 않는다. */
  blocked: boolean;
  /** 규칙 설명. 규칙과 무관한 상태에서는 `null`이다. */
  notice: ResearchSubmitNotice | null;
}

export interface ResearchSubmitInput {
  depth: unknown;
  /** 지금 켜져 있는 조사 범위 수. */
  scopeCount: number;
  /** 자유 입력에 실제 글자가 있는가(공백 제외). */
  hasText: boolean;
  /**
   * 서버가 지금 깊은 조사를 열어 뒀는가 (계약: `DEEP_RESEARCH_ENABLED=true`인 경우에만 열린다).
   *
   * **선택 필드로 두지 않는다.** 기본값을 주면 그 기본값이 조용히 답이 되고, fail-closed는
   * "안 물어보면 닫힘"이어야 하는데 부르는 쪽은 물어봤는지조차 모르게 된다. 필수로 두면
   * 새 호출 자리가 생길 때 타입이 먼저 묻는다.
   */
  deepAvailable: boolean;
}

const DEEP_SCOPE_NOTICE: ResearchSubmitNotice = Object.freeze({
  block: 'deep_requires_scope',
  title: '깊은 조사는 조사 범위를 골라야 해요',
  reason: '조사 범위를 하나 이상 골라야 깊은 조사가 접수돼요. 직접 적은 내용만으로는 시작하지 않습니다.',
  fix: '위에서 범위를 고르거나, 깊이를 일반 조사로 바꾸면 바로 보낼 수 있어요.',
});

/**
 * 지금은 깊은 조사를 받지 않는다는 말.
 *
 * 지키는 것 셋 — 사용자에게 (1) 지금 열려 있지 않다는 **사실**을 말하고, (2) 적어 둔 것이
 * 안전하다고 말하고, (3) 무엇을 하면 되는지 말한다. 서버 코드·설정 이름·내부 식별자는 한 글자도
 * 넣지 않는다. 그리고 고른 깊이를 **대신 낮추지 않는다** — 고른 것은 고른 채로 두고 막는다.
 */
const DEEP_UNAVAILABLE_NOTICE: ResearchSubmitNotice = Object.freeze({
  block: 'deep_unavailable',
  title: '깊은 조사는 지금 받을 수 없어요',
  reason: '지금은 깊은 조사를 열어 두지 않았어요. 이대로는 요청이 접수되지 않습니다.',
  fix: '빠른 조사나 일반 조사로 바꾸면 바로 보낼 수 있어요. 적어 둔 내용과 고른 범위는 그대로 있어요.',
});

/**
 * 접수 가능 여부 한 번의 판정.
 *
 * 네 갈래다:
 *  - `깊은 조사` + 서버가 안 열어 뒀음 → **막는다**. 사용자가 이 자리에서 풀 수 있는 조건이
 *    아니므로 범위 규칙보다 먼저 판정한다.
 *  - `깊은 조사` + 범위 0개 + 보낼 내용 있음 → **막는다**. 사용자가 보낼 것을 갖고 있는데
 *    계약이 받지 않는 상태이므로, 이유를 보이고 제출을 거절한다.
 *  - `깊은 조사` + 범위 0개 + 보낼 내용 없음 → 막지 않되 **같은 설명을 미리 보인다**.
 *    긴 글을 다 적은 뒤에 처음 막히는 것보다, 고른 직후에 조건을 아는 편이 낫다.
 *  - 그 밖 → `빠른`·`일반`의 기존 규칙 그대로. 이 함수는 그 둘을 조금도 조이지 않는다.
 */
export function evaluateResearchSubmit(input: ResearchSubmitInput): ResearchSubmitGate {
  const scopeCount = Number.isFinite(input.scopeCount) ? Math.max(0, Math.trunc(input.scopeCount)) : 0;
  const hasText = Boolean(input.hasText);
  const filled = scopeCount > 0 || hasText;
  const notice = normalizeResearchDepth(input.depth) !== 'deep' ? null
    : input.deepAvailable !== true ? DEEP_UNAVAILABLE_NOTICE
      : scopeCount < RESEARCH_DEEP_MIN_SCOPES ? DEEP_SCOPE_NOTICE
        : null;

  if (notice) {
    return filled
      ? { state: 'blocked', blocked: true, notice }
      : { state: 'empty', blocked: false, notice };
  }
  return { state: filled ? 'ready' : 'empty', blocked: false, notice: null };
}

/** 규칙과 무관한 상태의 기본값. 화면이 조사 기능을 끈 경우에 쓴다. */
export const RESEARCH_SUBMIT_READY: ResearchSubmitGate = Object.freeze({ state: 'ready', blocked: false, notice: null });

/**
 * 제출 버튼이 스스로 말하는 이름. 막혀 있으면 이유와 회복 방법이 **이름 안에** 들어간다.
 *
 * **Ionic 함정 둘.**
 *  1. `ion-button`이 안쪽 native button으로 옮겨 주는 것은 `aria-checked`·`aria-label`·`aria-pressed`
 *     뿐이다. `aria-describedby`를 host에 붙여도 낭독기가 읽는 버튼에는 닿지 않는다 — 그래서
 *     이유를 **이름 자체에** 싣는다.
 *  2. `ion-button`은 물려받은 `aria-label`을 자기 안에 기억해 둔다. 속성을 **지우면** 그 기억이
 *     남아 옛 이름이 계속 읽힌다 — `e2e/int30-conformance.spec.ts`가 실제로 그것을 잡아냈다
 *     (범위를 골라 막힘이 풀린 뒤에도 "지금은 보낼 수 없어요"가 이름에 남아 있었다).
 *     그래서 이 함수는 **언제나 문자열을 돌려준다**. 지우는 경로를 아예 만들지 않는다.
 */
export function researchSubmitLabel(label: string, gate: ResearchSubmitGate): string {
  if (!gate.blocked || !gate.notice) return label;
  return `${label} — 지금은 보낼 수 없어요. ${gate.notice.reason} ${gate.notice.fix}`;
}

// ── 내부 라우팅 설정 ──────────────────────────────────────────────────────────
// 여기부터는 **개발자만** 보는 값이다. 이 아래의 어떤 문자열도 화면·접근성 이름·영수증에
// 나타나면 안 된다. `research-mode.test.ts`와 `e2e/int30-research.spec.ts`가 그것을 검사한다.

/** 라우팅 설정 한 벌. 버전이 붙어 있어야 "그때 무엇으로 보냈나"를 되짚을 수 있다. */
export interface ResearchRouteConfig {
  /** 설정 판 이름. 연결이 바뀌면 새 값을 준다. */
  version: string;
  /** 깊이 → 내부 식별자. */
  bindings: Readonly<Record<ResearchDepth, string>>;
  /** 1차 식별자를 못 쓸 때 내려갈 자리. 없으면 내려가지 않는다. */
  fallbacks?: Readonly<Partial<Record<ResearchDepth, string>>>;
}

/** 지금 판. 교체는 `setResearchRouteConfig`로만 한다 — 부분 수정을 허용하지 않는다. */
export const RESEARCH_ROUTE_R1: ResearchRouteConfig = Object.freeze({
  version: 'r1',
  bindings: Object.freeze({ quick: 'luna', standard: 'terra', deep: 'sol' }),
  fallbacks: Object.freeze({ standard: 'luna', deep: 'terra' }),
});

let activeRouteConfig: ResearchRouteConfig = RESEARCH_ROUTE_R1;

export function researchRouteConfig(): ResearchRouteConfig {
  return activeRouteConfig;
}

/**
 * 라우팅 판을 통째로 갈아 끼운다.
 *
 * 반쪽 설정을 막는다: 버전이 없거나 깊이 하나라도 비어 있으면 거절한다. 그런 판이 들어오면
 * 어떤 요청은 라우팅되고 어떤 요청은 조용히 떨어지는데, 그 상태는 화면 어디에도 나타나지 않는다.
 */
export function setResearchRouteConfig(next: ResearchRouteConfig): ResearchRouteConfig {
  if (!next || typeof next.version !== 'string' || !next.version.trim()) {
    throw new Error('research_route_version_missing');
  }
  for (const option of RESEARCH_DEPTHS) {
    const binding = next.bindings?.[option.depth];
    if (typeof binding !== 'string' || !binding.trim()) throw new Error('research_route_binding_missing');
  }
  activeRouteConfig = next;
  return activeRouteConfig;
}

export function resetResearchRouteConfig(): ResearchRouteConfig {
  activeRouteConfig = RESEARCH_ROUTE_R1;
  return activeRouteConfig;
}

/** 왜 원래 자리로 못 갔는가. 닫힌 목록이며 개발자 채널에만 남는다. */
export type ResearchRouteReason = 'unknown_depth' | 'binding_unavailable' | 'no_binding';

export interface ResearchRoute {
  /** 사용자가 실제로 고른 값 (정규화 전). */
  requestedDepth: ResearchDepth;
  /** 라우팅에 쓰인 값 (정규화 후). */
  depth: ResearchDepth;
  /** 내부 식별자. 어디로도 못 갈 때만 null. */
  binding: string | null;
  version: string;
  degraded: boolean;
  reason?: ResearchRouteReason;
}

/**
 * 깊이 하나를 내부 자리로 옮긴다. **순수 함수다** — 설정과 가용성 판정을 인자로 받는다.
 *
 * 세 갈래로 내려간다:
 *  1. 값이 이상하다 → 기본 깊이로 라우팅하고 `unknown_depth`.
 *  2. 1차 자리를 못 쓴다 → 같은 깊이의 fallback으로 내려가고 `binding_unavailable`.
 *  3. fallback도 없거나 그마저 못 쓴다 → `binding: null` + `no_binding`. 이때 요청은 라우팅되지
 *     않은 것이며, 호출한 쪽이 그 사실을 알고 처리해야 한다.
 *
 * `isAvailable`의 기본값이 "다 쓸 수 있다"인 이유: 이 앱은 외부 모델을 직접 부르지 않는다.
 * 가용성은 나중에 실제 라우터가 주입한다.
 */
export function resolveResearchRoute(
  depth: unknown,
  config: ResearchRouteConfig = researchRouteConfig(),
  isAvailable: (binding: string) => boolean = () => true,
): ResearchRoute {
  // 아는 값인가를 먼저 판정한다. 모르는 값도 기본 깊이로 라우팅하되 그 사실을 잃지 않는다.
  const unknownDepth = !(typeof depth === 'string' && DEPTH_BY_KEY.has(depth as ResearchDepth));
  const normalized = normalizeResearchDepth(depth);
  const requestedDepth = normalized;

  const primary = config.bindings?.[normalized];
  if (typeof primary === 'string' && primary && isAvailable(primary)) {
    return {
      requestedDepth,
      depth: normalized,
      binding: primary,
      version: config.version,
      degraded: unknownDepth,
      ...(unknownDepth ? { reason: 'unknown_depth' as const } : {}),
    };
  }

  const fallback = config.fallbacks?.[normalized];
  if (typeof fallback === 'string' && fallback && isAvailable(fallback)) {
    return {
      requestedDepth,
      depth: normalized,
      binding: fallback,
      version: config.version,
      degraded: true,
      reason: unknownDepth ? 'unknown_depth' : 'binding_unavailable',
    };
  }

  return {
    requestedDepth,
    depth: normalized,
    binding: null,
    version: config.version,
    degraded: true,
    reason: 'no_binding',
  };
}
