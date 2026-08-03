// 서버 enum을 한국어로 옮긴다 (INT-000025 반려 근거: 전면 한국어 화면에 영어 enum이 그대로 뜬다).
//
// 화면에 `Deep Research · planning`, `확신 medium`이 나갔다. 앱을 쓰는 사람에게 `medium`은
// 확신도가 아니라 읽지 못한 글자다. 서버 어휘는 계약이라 바꾸지 않고, **표시만** 옮긴다.
//
// 여기가 유일한 등록소다. 같은 enum을 화면마다 다시 번역하면 표면마다 다른 말이 생긴다 —
// 그것이 v2.20.0 반려의 뿌리였다.

import type { ResearchProgressPhase } from '../contracts/capture';

/**
 * `researchProgress.phase` 표시 이름.
 * 단계 이름이지 진행률이 아니다 — 이 값만으로 퍼센트를 만들지 않는다.
 */
export const RESEARCH_PHASE_LABELS: Readonly<Record<ResearchProgressPhase, string>> = {
  planning: '조사 계획 세우는 중',
  branching: '조사 갈래 넓히는 중',
  triangulating: '여러 출처로 교차 확인 중',
  synthesizing: '결과 정리하는 중',
  done: '조사 완료',
};

/** 막대 칸처럼 좁은 자리에 쓰는 짧은 이름. */
export const RESEARCH_PHASE_SHORT_LABELS: Readonly<Record<ResearchProgressPhase, string>> = {
  planning: '계획',
  branching: '탐색',
  triangulating: '교차 확인',
  synthesizing: '정리',
  done: '완료',
};

const PHASES = Object.keys(RESEARCH_PHASE_LABELS) as ResearchProgressPhase[];

/** 서버가 준 값이 아는 단계일 때만 단계로 인정한다. 모르는 값은 영어로 흘리지 않고 버린다. */
export function researchPhaseOf(value: unknown): ResearchProgressPhase | null {
  return typeof value === 'string' && (PHASES as string[]).includes(value) ? value as ResearchProgressPhase : null;
}

export function researchPhaseLabel(value: unknown): string | null {
  const phase = researchPhaseOf(value);
  return phase ? RESEARCH_PHASE_LABELS[phase] : null;
}

export function researchPhaseShortLabel(value: unknown): string | null {
  const phase = researchPhaseOf(value);
  return phase ? RESEARCH_PHASE_SHORT_LABELS[phase] : null;
}

/** 근거 주장의 확신도 (`ResearchEvidenceClaim.confidence`). */
export type ClaimConfidence = 'low' | 'medium' | 'high';

// `medium`을 `보통`으로 옮기지 않는다 — 진행 문구의 `보통 4~9분`(관측 범위)과 같은 낱말이 되어
// 두 개의 다른 뜻이 한 화면에서 겹친다.
export const CLAIM_CONFIDENCE_LABELS: Readonly<Record<ClaimConfidence, string>> = {
  low: '낮음',
  medium: '중간',
  high: '높음',
};

const CONFIDENCES = Object.keys(CLAIM_CONFIDENCE_LABELS) as ClaimConfidence[];

export function claimConfidenceOf(value: unknown): ClaimConfidence | null {
  return typeof value === 'string' && (CONFIDENCES as string[]).includes(value) ? value as ClaimConfidence : null;
}

export function claimConfidenceLabel(value: unknown): string | null {
  const confidence = claimConfidenceOf(value);
  return confidence ? CLAIM_CONFIDENCE_LABELS[confidence] : null;
}

/** 화면에 그대로 쓰는 한 조각: `확신 중간`. 모르는 값이면 `null`이라 아무것도 붙지 않는다. */
export function claimConfidenceText(value: unknown): string | null {
  const label = claimConfidenceLabel(value);
  return label ? `확신 ${label}` : null;
}
