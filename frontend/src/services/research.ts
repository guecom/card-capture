import type { ResearchInstruction } from '../contracts/capture';
import { DEFAULT_RESEARCH_DEPTH, type ResearchDepth } from '../contracts/int30';
import {
  type ResearchMode,
  type ResearchPurpose,
  composeResearchRaw,
  researchFocusIds,
  researchModeOf,
  researchPurposes,
  sanitizeResearchRequestId,
} from './research-envelope';
import { actionErrorMessage } from './brief-view';
import {
  DEFAULT_RESEARCH_DEEP_STATE,
  RESEARCH_DEEP_CLOSED,
  type ResearchDeepState,
  type ResearchSubmitGate,
  evaluateResearchSubmit,
  normalizeResearchDeepState,
  normalizeResearchDepth,
  resolveResearchRoute,
} from './research-mode';
import { decomposeResearchInstruction, normalizeResearchScopeKeys } from './research-scope';
import { createResearchRequestId, recordResearchRoute } from './research-telemetry';

const MAX_LENGTH = 2000;
const POLICY_VERSION = 'public-research-v1';
const riskPatterns = [
  ['prompt_injection', /(ignore|무시).{0,24}(instruction|지시|규칙)|system\s*prompt|시스템\s*프롬프트/i],
  ['private_source', /비공개|private|로그인|login|DM|쪽지|사내\s*(자료|메일)|closed\s*group/i],
  ['credential', /credential|password|비밀번호|토큰|token|cookie|세션/i],
  ['sensitive_inference', /정치성향|종교|성적\s*지향|건강|질병|인종|민감\s*특성/i],
  ['doxxing', /집주소|가족\s*주소|신상\s*털|doxx|동선\s*추적/i],
  ['external_effect', /(이?메일|문자).{0,8}보내|게시|업로드|파일\s*수정|write|send/i],
  ['paid_effect', /유료\s*API|결제|구매|paid\s*api|subscribe/i],
  ['protected_write', /human_validated|AGENTS\.md|schema|스키마|allowlist|허용\s*경로/i],
] as const;

export function sanitizeResearchInstruction(value: string): string {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .replace(/\r\n?/g, '\n')
    .trim()
    .slice(0, MAX_LENGTH);
}

/** 실제로 보내는 글에 붙는 위험 표식. 보내지 않는 글에는 붙이지 않는다. */
function researchRiskFlags(raw: string): string[] {
  return riskPatterns.filter(([, pattern]) => pattern.test(raw)).map(([id]) => id);
}

export function buildResearchInstruction(value: string): ResearchInstruction | null {
  const raw = sanitizeResearchInstruction(value);
  if (!raw) return null;
  return {
    raw,
    channel: 'owner_ui',
    policyVersion: POLICY_VERSION,
    riskFlags: researchRiskFlags(raw),
  };
}

/**
 * 실제로 접수되는 요청 한 건 — **서버가 읽는 봉투 그대로**다 (TSK-000542).
 *
 * `buildResearchInstruction`은 손대지 않는다 — 그 모양은 legacy 웹앱과의 parity 계약이고
 * (`research.test.ts`가 `docs/research-policy.js`와 글자 단위로 대조한다), 계약의 구조화된
 * 봉투는 그 뒤에 생긴 것이다. 새 필드를 옛 봉투에 몰래 넣는 대신 새 봉투를 하나 만든다.
 *
 * 두 축이 함께 실린다:
 *  - `depth` — **사용자 축**. 사람이 고른 결과·기다림이다. DEC-000110부터 **서버도 읽는다** —
 *    `Code.gs`가 allowlist로 정규화해 capture envelope에 남기고, 워처가 그 값으로 처리 모델을
 *    고른다. 예전에는 이 칸이 화면과 telemetry 안에서만 살다 사라졌다.
 *  - `mode`·`purposes`·`focusIds`·`requestId` — **계약 축**. 서버 allowlist가 판정하는 값이다.
 *
 * 어느 모델로 보낼지(내부 binding)는 여기서 정하지 않고 실어 보내지도 않는다 — 요청에 실리는
 * 것은 깊이라는 **뜻**이고, 그 뜻을 모델 id로 바꾸는 것은 처리기를 띄우는 워처 한 곳뿐이다.
 */
export interface ResearchSubmission extends ResearchInstruction {
  depth: ResearchDepth;
  mode: ResearchMode;
  purposes: ResearchPurpose[];
  focusIds: string[];
  requestId: string;
}

export interface ResearchSubmissionOptions {
  /**
   * 서버가 깊은 조사에 대해 지금까지 한 말. **주지 않으면 `unknown`이다.**
   *
   * 예전 기본값은 "안 물어봤으면 닫힘"이었다. 그 기본값이 부팅 직후·오프라인 구간을 전부
   * 닫힘으로 만들었고, 화면은 그것을 지연처럼 그렸다 (TSK-000560). 이제 못 들은 것은 판정이
   * 아니다 — 판정은 서버가 하고, `Code.gs`가 `deep_evidence_graph`를 두 입구에서 다시 검사하므로
   * `DEEP_RESEARCH_ENABLED` 경계 자체는 그대로 fail-closed다.
   */
  deepState?: ResearchDeepState;
  /**
   * 이미 정해진 멱등 키. **재시도가 같은 요청임을 서버에 알리는 유일한 수단**이다.
   * 비워 두면 새로 만든다 — 그러므로 이 값은 요청을 **처음 구성하는 자리**에서 정해야 하고,
   * 재시도하는 자리에서 정하면 안 된다.
   */
  requestId?: string;
  /** 시험을 결정적으로 만들기 위한 난수 주입. 앱 코드에서는 주지 않는다. */
  random?: () => number;
}

/**
 * 화면이 들고 있는 **합쳐진 한 문장**에 대해 접수 조건을 판정한다 (TSK-000542 / 계약 §Product Behavior).
 *
 * 규칙 자체는 `research-mode.ts`가 소유하고 여기서는 문자열을 (고른 범위, 자유 입력)으로 되돌려
 * 넘겨 주기만 한다. 두 제출 자리(촬영 탭의 `완료`, 인물 시트의 `조사 요청 접수`)가 같은 판정을
 * 쓰게 하려면 둘 다 이 한 줄만 부르면 되어야 한다.
 *
 * `deepState` 기본값이 `unknown`인 이유: 못 들은 것은 판정이 아니다 (`research-mode.ts` 참고).
 */
export function researchSubmitGate(
  value: string,
  depth: unknown = DEFAULT_RESEARCH_DEPTH,
  deepState: ResearchDeepState = DEFAULT_RESEARCH_DEEP_STATE,
): ResearchSubmitGate {
  const draft = decomposeResearchInstruction(String(value ?? ''));
  return evaluateResearchSubmit({
    depth,
    scopeCount: normalizeResearchScopeKeys(draft.scopeKeys).length,
    hasText: Boolean(draft.text.trim()),
    deepState: normalizeResearchDeepState(deepState),
  });
}

// ── 접수 실패를 사람의 말로 ───────────────────────────────────────────────────
// 조사 요청이 거절되면 예전에는 `actionErrorMessage`가 그대로 쓰였다. 그 함수는 모르는 코드를
// `요청 실패: <코드>`로 붙여 돌려주므로, 서버가 `deep_feature_disabled`로 거절하는 순간
// **내부 코드가 사용자 화면에 그대로 찍혔다.** 그리고 아는 코드였던 `feature_disabled`의 문구는
// `이 기능이 잠시 꺼져 있어요`였다 — rollback flag로 닫아 둔 상태를 **지연처럼** 말하는 문장이고,
// 그것이 계약이 금지하는 바로 그 위장이다.
//
// 그래서 조사 실패는 자기 문구를 갖는다. 나머지 코드(네트워크·한도·권한)는 기존 문구를 그대로
// 쓴다 — 그것들은 진짜로 일시적이거나 이미 사람의 말로 되어 있다.

/** 서버가 "깊은 조사를 열어 두지 않았다"고 거절할 때의 코드. */
export const RESEARCH_DEEP_CLOSED_ERROR = 'deep_feature_disabled';

/** 조사 기능 전체가 닫혀 있을 때의 코드. */
export const RESEARCH_CLOSED_ERROR = 'feature_disabled';

/** 알려지지 않은 거절. 서버 원문을 사용자에게 보이지 않고 개발자 채널이 갖는다. */
export const RESEARCH_GENERIC_FAILURE = '요청을 접수하지 못했어요. 다시 시도해 주세요. 적어 둔 내용과 고른 범위는 그대로 있어요.';

const RESEARCH_CLOSED_FAILURE = '조사 요청은 지금 열려 있지 않아요. 적어 둔 내용과 고른 범위는 그대로 있어요.';

/** `actionErrorMessage`가 모르는 코드에 붙이는 머리. 이 모양이면 서버 원문이 딸려 온 것이다. */
const UNMAPPED_PREFIX = '요청 실패: ';

/** 이 거절이 "서버가 깊은 조사를 닫아 뒀다"인가. 화면이 그 사실을 배우는 유일한 판정이다. */
export function researchDeepClosedBy(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw === RESEARCH_DEEP_CLOSED_ERROR;
}

/**
 * 접수 실패를 사람이 읽는 한 줄로.
 *
 * 지키는 것 셋: 서버 코드·설정 이름을 보이지 않고, 닫힘을 지연으로 말하지 않고,
 * 적어 둔 것이 안전하다고 말한다.
 */
export function researchFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  if (raw === RESEARCH_DEEP_CLOSED_ERROR) return RESEARCH_DEEP_CLOSED.body;
  if (raw === RESEARCH_CLOSED_ERROR) return RESEARCH_CLOSED_FAILURE;
  const copy = actionErrorMessage(error);
  return copy.startsWith(UNMAPPED_PREFIX) ? RESEARCH_GENERIC_FAILURE : copy;
}

/**
 * 화면의 한 문장을 **서버가 읽는 봉투**로 옮긴다.
 *
 * 여기서 일어나는 화해가 이 기능의 본체다:
 *  - 고른 범위는 `focusIds`로 간다. 서버 allowlist가 표현하지 못하는 항목만 `raw` 뒤에 한 줄로
 *    붙는다 (`research-envelope.ts`가 그 표를 소유한다).
 *  - `raw`는 **사람이 적은 글**이다. 예전처럼 범위 이름을 앞에 붙여 보내지 않는다 —
 *    계약이 "선택 항목과 별도 저장"이라고 못박고 있고, 제 칸이 있는 값을 자유 텍스트에 숨기면
 *    서버의 allowlist 검사·지문·중복 판정이 전부 헛돈다.
 *  - `purposes`는 **깊이와 무관하게** 고른 범위에서 나온다 (DEC-000110). 예전에는 깊은 조사에서만
 *    실렸는데, 그 조건은 "깊은 조사는 목적 1개 이상"이라는 옛 접수 규칙의 그림자였다. 규칙이
 *    사라진 지금 목적을 깊이에 묶어 둘 이유가 없다 — 고른 범위는 어느 깊이에서든 조사를 좁힌다.
 */
export function buildResearchSubmission(
  value: string,
  depth: unknown = DEFAULT_RESEARCH_DEPTH,
  options: ResearchSubmissionOptions = {},
): ResearchSubmission | null {
  // 마지막 방어선. 화면이 막지 못하고 흘러들어와도 **깊이를 낮추거나 조용히 보내지 않는다** —
  // 여기서 멈추면 호출한 쪽은 "보낼 것이 없다"와 같은 모양(null)을 받으므로, 이 자리에 오기 전에
  // `researchSubmitGate`로 이유를 보여 주는 것이 화면의 책임이다.
  if (researchSubmitGate(value, depth, normalizeResearchDeepState(options.deepState)).blocked) return null;

  const draft = decomposeResearchInstruction(String(value ?? ''));
  const scopeKeys = normalizeResearchScopeKeys(draft.scopeKeys);
  const normalizedDepth = normalizeResearchDepth(depth);
  const mode = researchModeOf(normalizedDepth);
  const raw = sanitizeResearchInstruction(composeResearchRaw(draft.text, scopeKeys));
  const focusIds = researchFocusIds(scopeKeys);
  const purposes = researchPurposes(scopeKeys);

  // 서버 `normalizeResearchRequest_`의 빈 요청 판정과 **같은 식**이다. 서버가 받지 않을 요청을
  // 만들어 두면 사용자는 이유 없는 접수 실패를 본다.
  if (!raw && !focusIds.length && !purposes.length) return null;

  const requestId = sanitizeResearchRequestId(options.requestId) || createResearchRequestId(options.random);
  // 라우팅은 지금 일어나지 않는다. 지금 남기는 것은 "이 깊이로 접수됐고, 이 설정 판에서는
  // 어디로 가게 되어 있었다"는 사실이다. 설정이 반쪽이면 여기서 degraded로 드러난다.
  // 영수증 이름을 요청의 멱등 키와 같게 두어, 나중에 이 요청 한 건을 로그에서 이어 볼 수 있다.
  // **정규화 전 값을 넘긴다** — 정규화한 값을 넘기면 `unknown_depth`라는 사실이 그 자리에서 사라진다.
  recordResearchRoute(resolveResearchRoute(depth), { requestId });

  return {
    raw,
    channel: 'owner_ui',
    policyVersion: POLICY_VERSION,
    riskFlags: researchRiskFlags(raw),
    depth: normalizedDepth,
    mode,
    purposes,
    focusIds,
    requestId,
  };
}
