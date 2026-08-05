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
// founder 판정 2026-08-05 (DEC-000110 / TSK-000565):
//   "빠른 조사, 일반 조사, 깊은 조사는 … 오직 모델만 차이가 있는 거야. 그러고 깊은 조사를
//    클릭했을 때 조사 범위를 골라야 한다는 둥, 이런 것이 아니야."
//
// 그래서 **깊이를 고르는 것은 사용자에게 아무 숙제도 만들지 않는다.** 예전에는 `깊은 조사`가
// 조사 범위 1개 이상을 요구했고(`deep_requires_scope`), 그 한 조건 때문에 세 선택지 중 하나만
// 다른 종류의 선택이 됐다 — 고르면 할 일이 생기는 선택. 그 조건은 사라졌다.
//
// 조사 범위는 그대로 고를 수 있고 고르면 조사를 좁힌다. 다만 **접수의 조건이 아니다.**
//
// 왜 규칙이 여기 사는가: 이 판정을 JSX 안에 두면 두 화면(촬영 탭·인물 시트)이 각자 한 벌씩
// 갖게 되고, 그중 하나만 고쳐지는 날이 반드시 온다. 순수 함수 하나가 판정하고 화면은 그 결과를
// **그리기만** 한다.
//
// 막을 때 지키는 것 하나 (founder 요구 아님 — 계약이 그렇게 읽힌다):
//   깊이를 몰래 낮추지 않는다. `깊은 조사`를 골랐으면 골라진 채로 막힌다.
// 그래서 이 함수는 값을 고치지 않고 **왜 막혔고 무엇을 하면 풀리는지**만 돌려준다.

/** 지금 접수할 수 있는가. `empty`는 아직 보낼 것이 없다는 뜻이지 거절이 아니다. */
export type ResearchSubmitState = 'ready' | 'empty' | 'blocked';

// ── 서버가 깊은 조사에 대해 한 말 ────────────────────────────────────────────
// founder 판정 2026-08-04 (INT-000036 / TSK-000560):
//   "빠른조사, 일반조사는 그냥 선택할 수 있는데, 깊은 조사는 왜 버튼 클릭할 수 있을 때 까지
//    시간이 지나야하는지 모르겠네?"
//   "깊은 조사 활성화는 조건이 아니라 그냥 선택할 수 있게 해줘."
//
// 예전 모양은 `deepAvailable: boolean` 하나였다. 그 한 칸이 **서로 다른 두 사실**을 같은
// 값으로 눌러 담았다:
//   (가) 아직 서버에게 못 들었다 — 부팅 직후·오프라인·연결 전.
//   (나) 서버가 "안 연다"고 말했다 — rollback flag가 이 기능을 닫아 둔 상태.
// 둘을 `false` 하나로 접으니 화면은 (가)를 (나)처럼 그렸고, 목록 응답이 도착하는 순간
// 갑자기 고를 수 있게 됐다. 사용자 눈에는 **닫힌 기능이 아니라 요청마다 붙는 지연**으로 보였다.
// 그것이 founder가 본 결함이다.
//
// 그래서 세 값으로 쪼갠다. 규칙 두 줄:
//   1. **어떤 값에서도 고르는 것은 막지 않는다.** 선택은 사람의 손이고 조건이 붙지 않는다.
//   2. 접수를 막는 것은 `closed` 하나뿐이다. `unknown`은 판정이 아니라 **아직 모른다**이며,
//      모른다는 이유로 경고를 그리지 않는다. 그 요청의 판정은 서버가 한다 — `Code.gs`가
//      `deep_evidence_graph`를 두 입구에서 다시 검사하므로 경계는 그대로 fail-closed다.
export type ResearchDeepState = 'unknown' | 'open' | 'closed';

/**
 * 아무도 말해 주지 않았을 때의 값.
 *
 * **`closed`가 아니다.** 못 들은 것은 거절이 아니고, 못 들었다고 사용자에게 "안 된다"고 말하면
 * 그 말은 거짓일 수 있다. 대신 아무 말도 하지 않고 고르게 두며, 실제 판정은 서버가 한다.
 */
export const DEFAULT_RESEARCH_DEEP_STATE: ResearchDeepState = 'unknown';

const DEEP_STATES = new Set<ResearchDeepState>(['unknown', 'open', 'closed']);

/**
 * 아는 값만 통과시킨다. 나머지는 전부 `unknown`이다.
 *
 * 옛 호출자가 `true`/`false`를 넘길 수 있다. `true`는 `open`과 같은 뜻이고 `false`는 예전에
 * "못 들음 + 닫힘"을 함께 뜻했으므로 그대로 `closed`로 읽으면 못 들은 상태를 닫힘으로 되돌린다.
 * 그래서 boolean은 아예 안 받는다 — 타입이 먼저 막고, 값도 `unknown`으로 떨어진다.
 */
export function normalizeResearchDeepState(value: unknown): ResearchDeepState {
  return typeof value === 'string' && DEEP_STATES.has(value as ResearchDeepState)
    ? (value as ResearchDeepState)
    : DEFAULT_RESEARCH_DEEP_STATE;
}

/**
 * 닫힘을 **지연**으로 위장하는 말.
 *
 * 계약 (INT-000036 승인안): "rollback flag가 deep Product surface 전체를 닫는 경우를
 * per-request 지연 조건으로 가장하지 않는다." 사람이 기다리면 풀린다고 읽는 낱말을 닫힘 문구에
 * 쓰면, 사용자는 없는 진행을 기다리며 화면 앞에 서 있게 된다.
 *
 * 이 목록은 **닫힘 상태를 설명하는 문구에만** 적용한다. 조사 깊이 설명의 `기다리는 시간`처럼
 * 실제 처리 대기를 말하는 문장까지 금지하면 정직한 설명을 잃는다.
 */
export const RESEARCH_DELAY_WORDS: readonly string[] = [
  '잠시', '잠깐', '곧', '기다', '준비 중', '확인 중', '불러오', '로딩', '연결 중', '나중에', '조금만', '이따',
] as const;

/** 닫힘 문구가 지연 낱말을 담고 있는가. 담고 있으면 그 문구는 계약 위반이다. */
export function researchDelayWordsIn(text: string): string[] {
  return RESEARCH_DELAY_WORDS.filter((word) => String(text ?? '').includes(word));
}

/** 서버가 "지금 안 연다"고 말했을 때 화면 세 자리가 나눠 쓰는 말. */
export interface ResearchDeepClosedCopy {
  /** 깊이 칸 안에 들어가는 짧은 사실. **고를 수 없다고 말하지 않는다** — 고를 수는 있다. */
  short: string;
  /** 낭독기가 깊이 칸에서 읽는 한 문장. */
  detail: string;
  /** 접수 조건 안내와 요약 줄이 쓰는 제목. */
  title: string;
  /** 접수 실패 문구가 그대로 쓰는 한 문단. 여기에는 높이 제약이 없다. */
  body: string;
}

/**
 * 닫힘은 **사실**이지 진행이 아니다.
 *
 * 자리가 겹치지 않게 나눠 갖는다 — 한 번에 한 문장만 읽히게:
 *   `short`  깊이 칸 안 (닫혀 있으면 언제나 눈에 보이는 사실)
 *   `detail` 그 칸의 `title`(호버)과 낭독기 전용 문장 (뜻 + 회복 방법)
 *   `DEEP_UNAVAILABLE_NOTICE` 접수 조건 안내 (닫혔고 **깊은 조사를 고른** 동안)
 *   `body`   접수 실패 문구 (서버가 실제로 거절했을 때)
 *
 * **새 블록을 세우지 않는다.** 작성 자리는 이미 폰 화면 하나를 거의 채우고 있어서, 문단 하나를
 * 더 얹었더니 표면이 뷰포트보다 커지고 다른 표면 게이트가 깨졌다 (`ResearchComposer.tsx` 참고).
 *
 * 서버 설정 이름·오류 코드·내부 식별자는 한 글자도 넣지 않는다. 기다리면 풀린다고 읽히는
 * 낱말도 넣지 않는다 (`RESEARCH_DELAY_WORDS`).
 */
export const RESEARCH_DEEP_CLOSED: ResearchDeepClosedCopy = Object.freeze({
  short: '지금은 접수 안 돼요',
  detail: '깊은 조사는 지금 접수하지 않아요. 고를 수는 있지만 이대로는 요청이 접수되지 않습니다. 빠른 조사나 일반 조사로 바꾸면 그대로 보낼 수 있어요.',
  title: '깊은 조사는 지금 접수하지 않아요',
  body: '고르는 것은 언제든 됩니다. 다만 지금은 깊은 조사를 열어 두지 않아서, 이대로 보내면 접수되지 않아요. 빠른 조사나 일반 조사로 바꾸면 적어 둔 내용 그대로 보낼 수 있어요.',
});

/**
 * 막는 규칙의 닫힌 목록. **지금은 하나뿐이다.**
 *
 * - `deep_unavailable` — 서버가 지금 깊은 조사를 열어 두지 않았다고 **말했다**(`closed`).
 *   `DEEP_RESEARCH_ENABLED` fail-closed 경계이고, 사용자가 이 자리에서 풀 수 있는 조건이 아니다.
 *   이것은 사용자에게 시키는 일이 아니라 **안전장치**이므로 DEC-000110에서도 그대로 남는다.
 *
 * 예전에 여기 있던 `deep_requires_scope`(깊은 조사는 범위 1개 이상)는 사라졌다 — DEC-000110.
 * 깊이는 모델만 바꾸고, 고르는 것만으로 사용자에게 숙제를 만들지 않는다.
 *
 * `unknown`은 이 목록에 없다. 못 들은 것은 막는 이유가 아니다.
 */
export type ResearchSubmitBlock = 'deep_unavailable';

/**
 * 사람에게 그대로 읽히는 말. **막히기 전과 막힌 뒤가 같은 문장이다** — 범위를 0개로 둔 채
 * `깊은 조사`를 고른 순간부터 보이고, 실제로 막힐 때 같은 말이 제출 버튼의 이름에도 실린다.
 * 두 자리에서 다른 말을 하면 사용자는 둘을 다른 문제로 읽는다.
 */
export interface ResearchSubmitNotice {
  block: ResearchSubmitBlock;
  /** 한 줄 제목. 아직 아무것도 안 적었을 때도 거짓이 되지 않아야 한다. */
  title: string;
  /** 왜 지금 접수되지 않는가. */
  reason: string;
  /** 무엇을 하면 풀리는가. */
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
  /**
   * 지금 켜져 있는 조사 범위 수.
   *
   * **접수 조건이 아니다** (DEC-000110). 이 값이 여전히 필요한 이유는 `보낼 것이 있는가`를
   * 판정하기 위해서다 — 자유 입력이 비어 있어도 범위를 골랐으면 보낼 것이 있다.
   */
  scopeCount: number;
  /** 자유 입력에 실제 글자가 있는가(공백 제외). */
  hasText: boolean;
  /**
   * 서버가 깊은 조사에 대해 **지금까지 한 말** (`unknown` · `open` · `closed`).
   *
   * **선택 필드로 두지 않는다.** 기본값을 주면 그 기본값이 조용히 답이 되고, 부르는 쪽은
   * 물어봤는지조차 모르게 된다. 필수로 두면 새 호출 자리가 생길 때 타입이 먼저 묻는다.
   *
   * 예전 이름은 `deepAvailable: boolean`이었다. 그 칸은 "못 들었다"와 "안 된다"를 같은 `false`로
   * 접었고, 화면이 그 접힌 값을 그대로 그려서 **닫힌 기능이 지연처럼 보였다** (TSK-000560).
   */
  deepState: ResearchDeepState;
}

/**
 * 서버가 "지금 안 연다"고 **말했을 때**의 접수 조건 안내.
 *
 * 지키는 것 넷 — 사용자에게 (1) 고르는 것 자체는 막히지 않았다고 말하고, (2) 지금 접수되지
 * 않는다는 **사실**을 말하고, (3) 적어 둔 것이 안전하다고 말하고, (4) 무엇을 하면 되는지 말한다.
 * 서버 코드·설정 이름·내부 식별자는 한 글자도 넣지 않고, 기다리면 풀린다고 읽히는 낱말도
 * 넣지 않는다. 그리고 고른 깊이를 **대신 낮추지 않는다** — 고른 것은 고른 채로 두고 막는다.
 */
const DEEP_UNAVAILABLE_NOTICE: ResearchSubmitNotice = Object.freeze({
  block: 'deep_unavailable',
  title: RESEARCH_DEEP_CLOSED.title,
  reason: '깊이를 고르는 것은 언제든 되지만, 지금은 깊은 조사를 열어 두지 않아 이대로는 접수되지 않아요.',
  fix: '빠른 조사나 일반 조사로 바꾸면 그대로 보낼 수 있어요. 적어 둔 내용과 고른 범위는 그대로 있어요.',
});

/**
 * 접수 가능 여부 한 번의 판정.
 *
 * 세 갈래다 (DEC-000110 이후):
 *  - `깊은 조사` + 서버가 **닫혔다고 말함**(`closed`) → **막는다**. 이것 하나가 남은 유일한
 *    막힘이고, 사용자의 숙제가 아니라 서버 쪽 안전장치다.
 *  - `깊은 조사` + **아직 못 들음**(`unknown`) 또는 **열려 있음**(`open`) → 막지 않는다.
 *    못 들은 것은 거절이 아니다. 이 요청의 판정은 서버가 하고(`Code.gs`가 두 입구에서 다시
 *    검사한다), 거절되면 그 사실이 접수 실패로 정직하게 돌아온다.
 *  - 그 밖 → `빠른`·`일반`과 **완전히 같다**. 세 깊이 사이에 사용자가 더 해야 하는 일은 없다.
 *
 * 조사 범위 수는 이제 막힘을 만들지 않는다. `보낼 것이 있는가`(`filled`)만 정한다.
 */
export function evaluateResearchSubmit(input: ResearchSubmitInput): ResearchSubmitGate {
  const scopeCount = Number.isFinite(input.scopeCount) ? Math.max(0, Math.trunc(input.scopeCount)) : 0;
  const hasText = Boolean(input.hasText);
  const filled = scopeCount > 0 || hasText;
  const notice = normalizeResearchDepth(input.depth) === 'deep'
    && normalizeResearchDeepState(input.deepState) === 'closed'
    ? DEEP_UNAVAILABLE_NOTICE
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
//
// **실제 모델을 고르는 자리는 여기가 아니다** (DEC-000110). 앱은 외부 모델을 직접 부르지 않는다 —
// 앱이 하는 일은 고른 깊이를 요청에 실어 보내는 것뿐이고(`services/research.ts` → `api.ts` →
// `Code.gs` → `capture.json`), 깊이를 실제 모델 id로 바꾸는 것은 처리기를 띄우는 워처다
// (`config/research-models.json` + `watcher/CardCapture_Watcher.ps1`의 `Resolve-ResearchModel`).
//
// 그러면 이 표는 무엇인가 — **개발자 telemetry의 기록 축**이다. "이 요청은 어느 깊이로 접수됐고
// 그때 설정 판이 무엇이었나"를 영수증에 남기기 위한 값이며, 여기 적힌 코드명(luna·terra·sol)은
// 워처 설정 파일의 코드명과 같은 이름을 쓰되 **모델 id는 아니다.** 진짜 id는 이 저장소에 없다.

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
