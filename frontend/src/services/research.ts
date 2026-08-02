import type { PersonTarget, ResearchInstruction } from '../contracts/capture';

const MAX_LENGTH = 2000;
const STANDARD_POLICY_VERSION = 'public-research-v1';
const DEEP_POLICY_VERSION = 'lawful-authority-deep-research-v2';
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

export type ResearchMode = 'standard' | 'deep_evidence_graph';
export type ResearchPurpose = NonNullable<ResearchInstruction['purposes']>[number];
export type ResearchFocusId = NonNullable<ResearchInstruction['focusIds']>[number];

export const RESEARCH_FOCUS_OPTIONS: ReadonlyArray<{ id: ResearchFocusId; label: string }> = [
  { id: 'expertise', label: '실력·전문성 추정' },
  { id: 'authority', label: '의사결정 권한' },
  { id: 'reputation', label: '평판·레퍼런스' },
  { id: 'outcomes', label: '최근 성과와 실패' },
  { id: 'interests', label: '이해관계·경쟁 관계' },
  { id: 'career', label: '최근 경력·이직' },
  { id: 'company', label: '회사 소식·투자' },
  { id: 'connection', label: '나와의 접점' },
] as const;

export const RESEARCH_PURPOSES: ReadonlyArray<{ id: ResearchPurpose; label: string; hint: string }> = [
  { id: 'meeting_preparation', label: '중요한 만남 준비', hint: '대화 맥락과 확인할 질문' },
  { id: 'expertise_execution', label: '전문성·실행력 검증', hint: '결과물과 반복된 성과의 근거' },
  { id: 'authority_interests', label: '권한·이해관계 파악', hint: '실제 결정권과 조직·프로젝트 관계' },
  { id: 'reputation_risk', label: '평판·리스크 점검', hint: '반대 근거와 모르는 점까지 함께' },
] as const;

export interface ResearchInstructionOptions {
  mode?: ResearchMode;
  purposes?: ResearchPurpose[];
  focusIds?: ResearchFocusId[];
  requestId?: string;
}

const RESEARCH_REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function stableFingerprint(prefix: 'target' | 'request', canonical: string): string {
  // FNV-1a 64-bit: fingerprint는 보안 토큰이 아니라 원문을 저장하지 않는 안정적인 비교 키다.
  // 32-bit 한 개보다 충돌 여유가 크고 WebCrypto 비동기 경계 없이 submit 직전에 확정할 수 있다.
  let hash = 0xcbf29ce484222325n;
  for (const character of canonical) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `research-${prefix}-v1-${hash.toString(16).padStart(16, '0')}`;
}

/** target 원문을 저장하지 않고 같은 Person/capture인지 비교하는 subject-local 키. */
export function researchTargetFingerprint(target: PersonTarget): string {
  return stableFingerprint('target', JSON.stringify([
    String(target.person ?? '').trim(),
    String(target.captureId ?? '').trim(),
  ]));
}

/** 공백·순서 차이는 같은 요청으로, 실제 내용·mode·목적·focus 변화는 다른 요청으로 본다. */
export function researchRequestFingerprint(instruction: ResearchInstruction): string {
  const purposes = Array.from(new Set(instruction.purposes ?? [])).sort();
  const focusIds = Array.from(new Set(instruction.focusIds ?? [])).sort();
  return stableFingerprint('request', JSON.stringify([
    sanitizeResearchInstruction(instruction.raw),
    instruction.mode === 'deep_evidence_graph' ? 'deep_evidence_graph' : 'standard',
    purposes,
    focusIds,
  ]));
}

export function matchingPendingResearchRequestId(
  pending: { requestId: string; targetFingerprint: string; requestFingerprint: string } | null,
  targetFingerprint: string,
  requestFingerprint: string,
): string | null {
  return pending
    && RESEARCH_REQUEST_ID_PATTERN.test(pending.requestId)
    && pending.targetFingerprint === targetFingerprint
    && pending.requestFingerprint === requestFingerprint
    ? pending.requestId
    : null;
}

export interface ResearchRequestIdLifecycle {
  /** 현재 draft의 ID. 최초 유효 제출 때 한 번만 만든다. */
  current(): string;
  /** 응답 유실·거절 뒤 재시도는 반드시 현재 ID를 그대로 쓴다. */
  retry(): string;
  /** 사용자가 새 조사 작성기를 열었을 때 다음 제출을 새 논리 요청으로 시작한다. */
  beginNewDraft(): void;
  /** 서버의 명시적 성공 receipt 뒤에만 현재 논리 요청을 닫는다. */
  markAccepted(): void;
  /** 대기열에서 되돌린 capture처럼 이미 ID가 있는 draft를 이어 쓴다. */
  resume(requestId: string | null | undefined): void;
  /** 진단·테스트용 읽기. ID를 새로 만들지 않는다. */
  peek(): string | null;
}

/**
 * 한 조사 draft의 멱등성 ID 수명주기.
 *
 * 네트워크 오류는 서버가 요청을 받았는지 알 수 없는 상태다. 따라서 `retry()`는 새 ID를
 * 만들지 않는다. 새 ID를 허용하는 경계는 명시적인 새 draft와 성공 receipt뿐이다.
 */
export function createResearchRequestIdLifecycle(
  createId: () => string = () => globalThis.crypto.randomUUID(),
): ResearchRequestIdLifecycle {
  let requestId: string | null = null;

  const current = (): string => {
    if (requestId) return requestId;
    const candidate = createId();
    if (!RESEARCH_REQUEST_ID_PATTERN.test(candidate)) throw new Error('invalid_research_request_id');
    requestId = candidate;
    return requestId;
  };

  return {
    current,
    retry: current,
    beginNewDraft() { requestId = null; },
    markAccepted() { requestId = null; },
    resume(value) { requestId = value && RESEARCH_REQUEST_ID_PATTERN.test(value) ? value : null; },
    peek() { return requestId; },
  };
}

export function buildResearchInstruction(value: string, options: ResearchInstructionOptions = {}): ResearchInstruction | null {
  const raw = sanitizeResearchInstruction(value);
  const mode = options.mode ?? 'standard';
  const purposes = mode === 'deep_evidence_graph'
    ? Array.from(new Set(options.purposes ?? [])).filter((purpose): purpose is ResearchPurpose => RESEARCH_PURPOSES.some((candidate) => candidate.id === purpose))
    : [];
  const focusIds = Array.from(new Set(options.focusIds ?? [])).filter((focusId): focusId is ResearchFocusId => RESEARCH_FOCUS_OPTIONS.some((candidate) => candidate.id === focusId));
  if (mode === 'deep_evidence_graph' && !purposes.length) return null;
  if (!raw && !focusIds.length && !(mode === 'deep_evidence_graph' && purposes.length)) return null;
  return {
    raw,
    channel: 'owner_ui',
    policyVersion: mode === 'deep_evidence_graph' ? DEEP_POLICY_VERSION : STANDARD_POLICY_VERSION,
    riskFlags: riskPatterns.filter(([, pattern]) => pattern.test(raw)).map(([id]) => id),
    mode,
    purposes,
    focusIds,
    ...(options.requestId ? { requestId: options.requestId } : {}),
    sourceAuthority: 'public_lawful_only',
    ...(mode === 'deep_evidence_graph' ? { budget: { branchCap: 24, timeCapMinutes: 90 } } : {}),
  };
}

export function researchBulkState(selectedIds: readonly ResearchFocusId[], visible: readonly { id: ResearchFocusId }[]): { selected: number; state: 'none' | 'partial' | 'all' } {
  const visibleIds = new Set(visible.map((option) => option.id));
  const selected = selectedIds.filter((id) => visibleIds.has(id)).length;
  return { selected, state: selected === 0 ? 'none' : selected === visible.length ? 'all' : 'partial' };
}

export function toggleAllResearchFocus(selectedIds: readonly ResearchFocusId[], visible: readonly { id: ResearchFocusId }[]): ResearchFocusId[] {
  const bulk = researchBulkState(selectedIds, visible);
  const visibleIds = new Set(visible.map((option) => option.id));
  if (bulk.state === 'all') return selectedIds.filter((id) => !visibleIds.has(id));
  return Array.from(new Set([...selectedIds, ...visible.map((option) => option.id)]));
}
