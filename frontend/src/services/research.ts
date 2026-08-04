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
import {
  type ResearchSubmitGate,
  evaluateResearchSubmit,
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
 *  - `depth` — **사용자 축**. 사람이 고른 결과·기다림이고 화면·telemetry가 읽는다. 서버는 안 읽는다.
 *  - `mode`·`purposes`·`focusIds`·`requestId` — **계약 축**. 서버 allowlist가 판정하는 값이다.
 *
 * 어디로 보낼지(내부 binding)는 여기서 정하지 않고 실어 보내지도 않는다 —
 * 그 판정(`resolveResearchRoute`)의 결과는 개발자 telemetry에만 남고 화면으로 돌아가지 않는다.
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
   * 서버가 지금 깊은 조사를 열어 뒀는가. **주지 않으면 닫힘이다** — 이 값은 서버 응답에서만
   * 오고, 못 들은 것과 안 된다는 것을 같게 취급하는 것이 계약의 fail-closed다.
   */
  deepAvailable?: boolean;
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
 * `deepAvailable` 기본값이 `false`인 이유: 못 들었으면 닫힘이다.
 */
export function researchSubmitGate(
  value: string,
  depth: unknown = DEFAULT_RESEARCH_DEPTH,
  deepAvailable = false,
): ResearchSubmitGate {
  const draft = decomposeResearchInstruction(String(value ?? ''));
  return evaluateResearchSubmit({
    depth,
    scopeCount: normalizeResearchScopeKeys(draft.scopeKeys).length,
    hasText: Boolean(draft.text.trim()),
    deepAvailable,
  });
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
 *  - `purposes`는 깊은 조사에서만 실린다. 서버도 그때만 저장한다.
 */
export function buildResearchSubmission(
  value: string,
  depth: unknown = DEFAULT_RESEARCH_DEPTH,
  options: ResearchSubmissionOptions = {},
): ResearchSubmission | null {
  // 마지막 방어선. 화면이 막지 못하고 흘러들어와도 **깊이를 낮추거나 조용히 보내지 않는다** —
  // 여기서 멈추면 호출한 쪽은 "보낼 것이 없다"와 같은 모양(null)을 받으므로, 이 자리에 오기 전에
  // `researchSubmitGate`로 이유를 보여 주는 것이 화면의 책임이다.
  if (researchSubmitGate(value, depth, options.deepAvailable === true).blocked) return null;

  const draft = decomposeResearchInstruction(String(value ?? ''));
  const scopeKeys = normalizeResearchScopeKeys(draft.scopeKeys);
  const normalizedDepth = normalizeResearchDepth(depth);
  const mode = researchModeOf(normalizedDepth);
  const raw = sanitizeResearchInstruction(composeResearchRaw(draft.text, scopeKeys));
  const focusIds = researchFocusIds(scopeKeys);
  const purposes = mode === 'deep_evidence_graph' ? researchPurposes(scopeKeys) : [];

  // 서버 `normalizeResearchRequest_`의 빈 요청 판정과 **같은 식**이다. 서버가 받지 않을 요청을
  // 만들어 두면 사용자는 이유 없는 접수 실패를 본다.
  if (!raw && !focusIds.length && !(mode === 'deep_evidence_graph' && purposes.length)) return null;

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
