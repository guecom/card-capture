import { describe, expect, it } from 'vitest';
import {
  CLAIM_CONFIDENCE_LABELS,
  RESEARCH_PHASE_LABELS,
  claimConfidenceLabel,
  claimConfidenceOf,
  claimConfidenceText,
  researchPhaseLabel,
  researchPhaseOf,
  researchPhaseShortLabel,
} from './research-vocabulary';

describe('서버 enum을 화면으로 흘리지 않는다', () => {
  it('다섯 단계 전부에 한국어 이름이 있다', () => {
    expect(Object.keys(RESEARCH_PHASE_LABELS)).toEqual(['planning', 'branching', 'triangulating', 'synthesizing', 'done']);
    Object.values(RESEARCH_PHASE_LABELS).forEach((label) => expect(label).not.toMatch(/[A-Za-z]/));
  });

  it('세 확신도 전부에 한국어 이름이 있다', () => {
    expect(Object.keys(CLAIM_CONFIDENCE_LABELS)).toEqual(['low', 'medium', 'high']);
    Object.values(CLAIM_CONFIDENCE_LABELS).forEach((label) => expect(label).not.toMatch(/[A-Za-z]/));
  });

  it('`Deep Research · planning`이 아니라 한국어 단계 이름을 준다', () => {
    expect(researchPhaseLabel('planning')).toBe('조사 계획 세우는 중');
    expect(researchPhaseShortLabel('triangulating')).toBe('교차 확인');
  });

  it('`확신 medium`이 아니라 `확신 중간`을 준다', () => {
    expect(claimConfidenceText('medium')).toBe('확신 중간');
    expect(claimConfidenceText('low')).toBe('확신 낮음');
    expect(claimConfidenceLabel('high')).toBe('높음');
  });

  it('`medium`은 `보통`으로 옮기지 않는다 — 진행 문구의 `보통 4~9분`과 겹치기 때문이다', () => {
    expect(CLAIM_CONFIDENCE_LABELS.medium).not.toBe('보통');
  });

  it('모르는 값은 영어로 흘리는 대신 아무 말도 하지 않는다', () => {
    expect(researchPhaseOf('turbo')).toBeNull();
    expect(researchPhaseLabel(undefined)).toBeNull();
    expect(researchPhaseLabel(3)).toBeNull();
    expect(claimConfidenceOf('very_high')).toBeNull();
    expect(claimConfidenceText(null)).toBeNull();
  });
});
