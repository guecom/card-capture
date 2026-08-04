// 조사 요청이 **서버로 나가는 모양** (INT-000030 / TSK-000542).
//
// vault 계약 `63_Research_Instruction_Contract.md` §Request Contract가 다섯 칸을 정한다:
//
//   | 칸          | 권한                     | 규칙                                        |
//   | ----------- | ------------------------ | ------------------------------------------- |
//   | `raw`       | owner 입력               | 최대 2,000자, **선택 항목과 별도 저장**      |
//   | `mode`      | client 요청 + server 허용 | `quick`·`standard`·`deep_evidence_graph`     |
//   | `purposes`  | client 선택 + server 허용 | Deep에서 1개 이상, 네 목적 밖은 제거         |
//   | `focusIds`  | client 선택 + server 허용 | 8개 추천 ID 밖은 제거                        |
//   | `requestId` | client 생성 + server 검증 | 재시도 idempotency key                       |
//
// **왜 이 파일이 따로 있는가.** 이 다섯 칸의 값은 전부 서버(`Code.gs`)의 allowlist와 **정확히**
// 맞아야 하는데, 그 대조는 사람 눈으로는 유지되지 않는다. 실제로 유지되지 않았다 — 화면에는
// 세 가지 깊이가 있었지만 클라이언트가 보낸 것은 서버가 읽지도 않는 `depth` 한 칸이었고,
// 세 선택이 서버에서 전부 같은 요청이 됐다. 그래서 wire 값의 **등록소를 하나로 모으고**,
// `research-envelope.test.ts`가 `Code.gs`를 직접 읽어 이 등록소가 서버의 부분집합인지 검사한다.
//
// 권한은 넓히지 않는다. 여기서 만들어지는 것은 **요청 데이터**뿐이고 policy·budget·권한은 서버가
// 자기 상수로 다시 만든다 (계약: "client 값 무시, 서버 고정 snapshot 재생성").

import type { ResearchMode, ResearchPurpose } from '../contracts/capture';
import { normalizeResearchDepth, type ResearchDepth } from './research-mode';
import { RESEARCH_SCOPES, normalizeResearchScopeKeys, researchScopeLabels } from './research-scope';

export type { ResearchMode, ResearchPurpose };

// ── mode ─────────────────────────────────────────────────────────────────────

/** 클라이언트가 낼 수 있는 mode 전부. `Code.gs`의 `RESEARCH_MODES_`와 대조된다. */
export const RESEARCH_MODES: readonly ResearchMode[] = ['quick', 'standard', 'deep_evidence_graph'] as const;

/**
 * 깊이 → mode. 두 축을 분리해 두는 이유는 계약이 그렇게 나뉘어 있기 때문이다:
 * 깊이는 **사용자에게 보이는 결과·기다림**이고 mode는 **서버가 판정하는 처리 계약**이다.
 * 한쪽 이름을 다른 쪽에 그대로 쓰면 언젠가 화면에 `deep_evidence_graph`가 새어 나온다.
 */
export const RESEARCH_MODE_BY_DEPTH: Readonly<Record<ResearchDepth, ResearchMode>> = Object.freeze({
  quick: 'quick',
  standard: 'standard',
  deep: 'deep_evidence_graph',
});

export function researchModeOf(depth: unknown): ResearchMode {
  return RESEARCH_MODE_BY_DEPTH[normalizeResearchDepth(depth)];
}

// ── purposes / focusIds ──────────────────────────────────────────────────────

/** 계약 §Deep Research Purpose의 네 목적. 서버 `RESEARCH_PURPOSES_`와 같은 순서다. */
export const RESEARCH_PURPOSES: readonly ResearchPurpose[] = [
  'meeting_preparation', 'expertise_execution', 'authority_interests', 'reputation_risk',
] as const;

/** 서버 `RESEARCH_FOCUS_IDS_`의 8개. 순서까지 같다 — 서버가 이 순서로 canonical화한다. */
export const RESEARCH_FOCUS_IDS: readonly string[] = [
  'expertise', 'authority', 'reputation', 'outcomes', 'interests', 'career', 'company', 'connection',
] as const;

/**
 * 화면의 조사 범위 하나가 wire에서 갖는 자리.
 *
 * **9와 8은 같은 목록이 아니다.** 화면은 사람이 고르기 좋은 아홉 칸이고 서버 allowlist는 여덟 개다.
 * 이름이 그냥 겹치는 것은 `expertise`·`authority`·`reputation` 셋뿐이라, 나머지는 **뜻으로** 잇는다.
 * 이 표가 그 화해의 유일한 원본이다.
 *
 * - `focusId`가 `null`인 칸은 서버 allowlist가 표현하지 못하는 항목이다. 그런 항목은 조용히
 *   버리지 않고 `raw`(계약이 허용한 자유 입력 자리)로 사람이 읽는 말로 넘어간다. **제 칸이 있는
 *   항목을 `raw`로 밀어 넣지는 않는다** — 그것은 구조화된 값을 자유 텍스트에 숨기는 짓이다.
 * - `purpose`는 모든 칸에 있다. 계약이 "깊은 조사는 목적 1개 이상"을 요구하고 화면의 접수 조건은
 *   "범위 1개 이상"이므로, 범위마다 목적이 하나씩 있어야 두 조건이 **같은 뜻**이 된다.
 */
export interface ResearchScopeWire {
  /** 서버 allowlist의 focus ID. 표현할 수 없으면 null. */
  focusId: string | null;
  purpose: ResearchPurpose;
}

export const RESEARCH_SCOPE_WIRE: Readonly<Record<string, ResearchScopeWire>> = Object.freeze({
  // 실력·역량 근거 — "공개된 결과물로 실력이 진짜인지" → 결과물(outcomes)
  capability: Object.freeze({ focusId: 'outcomes', purpose: 'expertise_execution' as const }),
  // 전문 분야 (이름 그대로 겹치는 셋 중 하나)
  expertise: Object.freeze({ focusId: 'expertise', purpose: 'expertise_execution' as const }),
  // 의사결정 권한·직급 (이름 그대로)
  authority: Object.freeze({ focusId: 'authority', purpose: 'authority_interests' as const }),
  // 평판·레퍼런스 (이름 그대로)
  reputation: Object.freeze({ focusId: 'reputation', purpose: 'reputation_risk' as const }),
  // 최근 활동·발표 — "요즘 무엇을 하고 있는지" → 이력의 현재 지점(career)
  recent: Object.freeze({ focusId: 'career', purpose: 'meeting_preparation' as const }),
  // 소속 조직·사업 맥락 → company
  organization: Object.freeze({ focusId: 'company', purpose: 'authority_interests' as const }),
  // 이해관계·경쟁 구도 → interests
  interest: Object.freeze({ focusId: 'interests', purpose: 'authority_interests' as const }),
  // 함께 아는 사람·접점 → connection
  overlap: Object.freeze({ focusId: 'connection', purpose: 'meeting_preparation' as const }),
  // 대화 시작점 — **서버 allowlist에 자리가 없다.** 여덟 칸은 "무엇을 확인할까"를 말하고
  // 이 칸은 "다음에 무슨 이야기를 꺼낼까"를 말한다. 없는 칸에 억지로 끼우면 조사 대상이
  // 조용히 달라지므로 `raw`로 넘긴다.
  opener: Object.freeze({ focusId: null, purpose: 'meeting_preparation' as const }),
});

/** 고른 범위를 서버 focus ID로 옮긴다. allowlist 순서로 정렬하고 중복을 없앤다. */
export function researchFocusIds(scopeKeys: readonly string[] | undefined): string[] {
  const wanted = new Set(
    normalizeResearchScopeKeys(scopeKeys)
      .map((key) => RESEARCH_SCOPE_WIRE[key]?.focusId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  );
  return RESEARCH_FOCUS_IDS.filter((id) => wanted.has(id));
}

/** 고른 범위가 뜻하는 목적. 계약 순서로 정렬하고 중복을 없앤다. */
export function researchPurposes(scopeKeys: readonly string[] | undefined): ResearchPurpose[] {
  const wanted = new Set(normalizeResearchScopeKeys(scopeKeys).map((key) => RESEARCH_SCOPE_WIRE[key]?.purpose));
  return RESEARCH_PURPOSES.filter((purpose) => wanted.has(purpose));
}

/** 서버 allowlist가 표현하지 못하는 범위의 **사람이 읽는 이름**. */
export function researchRawExtraLabels(scopeKeys: readonly string[] | undefined): string[] {
  return researchScopeLabels(
    normalizeResearchScopeKeys(scopeKeys).filter((key) => !RESEARCH_SCOPE_WIRE[key]?.focusId),
  );
}

/**
 * `raw`에 붙는 한 줄의 표식. 기계용 토큰이 아니라 사람이 읽어도 뜻이 통하는 말이어야 한다 —
 * 이 줄은 조사 처리기가 그대로 읽는 자유 입력이다.
 */
export const RESEARCH_RAW_EXTRA_PREFIX = '추가 조사 항목: ';

/**
 * 실제로 `raw`에 실릴 글.
 *
 * 사람이 적은 글이 **먼저**고, 서버 allowlist가 표현하지 못한 항목만 뒤에 한 줄로 붙는다.
 * 여덟 개의 제 칸이 있는 항목은 여기 오지 않는다 — 그것들은 `focusIds`가 소유한다.
 */
export function composeResearchRaw(text: string, scopeKeys: readonly string[] | undefined): string {
  const body = String(text ?? '').trim();
  const extras = researchRawExtraLabels(scopeKeys);
  if (!extras.length) return body;
  const line = `${RESEARCH_RAW_EXTRA_PREFIX}${extras.join(', ')}`;
  return body ? `${body}\n${line}` : line;
}

// ── requestId ────────────────────────────────────────────────────────────────

/**
 * 서버 `sanitizeRequestId_`와 **같은 모양**이다. 여기서 한 번 더 검사하는 이유는, 모양이 안 맞는
 * 값을 서버가 조용히 빈 문자열로 바꾸면 그 요청은 멱등 키 없이 접수되고 재시도가 새 요청이 되기
 * 때문이다. 클라이언트가 못 만드는 키라면 아예 만들지 않고 새로 뽑는 편이 낫다.
 */
const REQUEST_ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

export function sanitizeResearchRequestId(value: unknown): string {
  const id = String(value ?? '');
  return REQUEST_ID_SHAPE.test(id) ? id : '';
}

// ── 배포 창(window) 대응 ──────────────────────────────────────────────────────
// `Code.gs`는 사람이 따로 재배포해야 반영된다. 웹은 먼저 올라가므로 **앱은 아는데 서버는 모르는**
// 구간이 반드시 생긴다. 그 구간에서 `quick`은 서버 allowlist에 없어 요청 전체가 거절된다.
//
// 그때 지키는 것 두 가지:
//   1. 사용자의 조사는 **된다**. 요청을 잃지 않는다.
//   2. 내려갔다는 사실은 **개발자에게만** 남는다 (founder: "사용자는 모르게, 개발자에게는 알려줘야지").
//
// 그리고 반드시 지켜야 하는 것 하나 — **진짜 실패를 이 길로 감추지 않는다.**
// `bad_research_request`는 mode 말고도 여러 이유로 난다. 그래서 되돌림은 `quick`이었던 요청에만,
// 딱 한 번, mode 한 칸만 바꿔서 한다. 나머지 칸이 원인이면 두 번째 시도도 **똑같이** 거절된다
// (서버의 빈 요청·target·권한 검사는 quick과 standard에서 완전히 동일하다).

/** 옛 서버가 mode를 못 알아봤을 때의 응답 코드. */
export const RESEARCH_BAD_REQUEST_ERROR = 'bad_research_request';

export interface ResearchModeCarrier {
  mode?: ResearchMode | string;
}

/** 이 거절이 "서버가 아직 `quick`을 모른다"로 설명되는가. `quick`이 아니었으면 절대 참이 아니다. */
export function quickModeRejected(envelope: ResearchModeCarrier | null | undefined, error: unknown): boolean {
  if (!envelope || envelope.mode !== 'quick') return false;
  return String(error ?? '') === RESEARCH_BAD_REQUEST_ERROR;
}

/**
 * 같은 요청을 `standard`로 되돌린 봉투. **mode 한 칸만 바뀐다** — `raw`·`purposes`·`focusIds`·
 * `requestId`는 그대로다. 같은 요청이므로 멱등 키도 같아야 하고, 서버가 이미 무언가 남겼다면
 * 그 사실을 알아볼 수 있어야 한다.
 */
export function downgradeQuickMode<T extends ResearchModeCarrier>(envelope: T): T {
  return { ...envelope, mode: 'standard' as ResearchMode };
}

// ── 등록소 자체 검사용 ────────────────────────────────────────────────────────

/** 화면의 범위 키 전부가 이 표에 자리를 갖고 있는가. 테스트와 개발 시 자기 점검에 쓴다. */
export function researchScopeWireGaps(): string[] {
  return RESEARCH_SCOPES.filter((scope) => !RESEARCH_SCOPE_WIRE[scope.key]).map((scope) => scope.key);
}
