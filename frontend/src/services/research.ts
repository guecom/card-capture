import type { ResearchInstruction } from '../contracts/capture';

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
