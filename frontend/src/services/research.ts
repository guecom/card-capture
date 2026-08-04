import type { ResearchInstruction } from '../contracts/capture';
import { DEFAULT_RESEARCH_DEPTH, type ResearchDepth } from '../contracts/int30';
import {
  type ResearchSubmitGate,
  evaluateResearchSubmit,
  normalizeResearchDepth,
  resolveResearchRoute,
} from './research-mode';
import { decomposeResearchInstruction, normalizeResearchScopeKeys } from './research-scope';
import { recordResearchRoute } from './research-telemetry';

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

export function buildResearchInstruction(value: string): ResearchInstruction | null {
  const raw = sanitizeResearchInstruction(value);
  if (!raw) return null;
  return {
    raw,
    channel: 'owner_ui',
    policyVersion: POLICY_VERSION,
    riskFlags: riskPatterns.filter(([, pattern]) => pattern.test(raw)).map(([id]) => id),
  };
}

/**
 * 실제로 접수되는 요청 한 건. 지시문 봉투에 **조사 깊이**가 하나 더 붙는다 (TSK-000542).
 *
 * `buildResearchInstruction`은 손대지 않는다 — 그 모양은 legacy 웹앱과의 parity 계약이고
 * (`research.test.ts`가 `docs/research-policy.js`와 글자 단위로 대조한다), 깊이는 그 계약이
 * 생긴 뒤에 더해진 것이다. 새 필드를 옛 봉투에 몰래 넣는 대신 새 봉투를 하나 만든다.
 *
 * 깊이는 **요청에 실려 나가는 값**이다. 어디로 보낼지는 여기서 정하지 않는다 —
 * 그 판정(`resolveResearchRoute`)의 결과는 개발자 telemetry에만 남고 화면으로 돌아가지 않는다.
 */
export interface ResearchSubmission extends ResearchInstruction {
  depth: ResearchDepth;
}

/**
 * 화면이 들고 있는 **합쳐진 한 문장**에 대해 접수 조건을 판정한다 (TSK-000542 / 계약 §Product Behavior).
 *
 * 규칙 자체는 `research-mode.ts`가 소유하고 여기서는 문자열을 (고른 범위, 자유 입력)으로 되돌려
 * 넘겨 주기만 한다. 두 제출 자리(촬영 탭의 `완료`, 인물 시트의 `조사 요청 접수`)가 같은 판정을
 * 쓰게 하려면 둘 다 이 한 줄만 부르면 되어야 한다.
 */
export function researchSubmitGate(value: string, depth: unknown = DEFAULT_RESEARCH_DEPTH): ResearchSubmitGate {
  const draft = decomposeResearchInstruction(String(value ?? ''));
  return evaluateResearchSubmit({
    depth,
    scopeCount: normalizeResearchScopeKeys(draft.scopeKeys).length,
    hasText: Boolean(draft.text.trim()),
  });
}

export function buildResearchSubmission(value: string, depth: unknown = DEFAULT_RESEARCH_DEPTH): ResearchSubmission | null {
  // 마지막 방어선. 화면이 막지 못하고 흘러들어와도 **깊이를 낮추거나 조용히 보내지 않는다** —
  // 여기서 멈추면 호출한 쪽은 "보낼 것이 없다"와 같은 모양(null)을 받으므로, 이 자리에 오기 전에
  // `researchSubmitGate`로 이유를 보여 주는 것이 화면의 책임이다.
  if (researchSubmitGate(value, depth).blocked) return null;
  const instruction = buildResearchInstruction(value);
  if (!instruction) return null;
  // 라우팅은 지금 일어나지 않는다. 지금 남기는 것은 "이 깊이로 접수됐고, 이 설정 판에서는
  // 어디로 가게 되어 있었다"는 사실이다. 설정이 반쪽이면 여기서 degraded로 드러난다.
  recordResearchRoute(resolveResearchRoute(depth));
  return { ...instruction, depth: normalizeResearchDepth(depth) };
}
