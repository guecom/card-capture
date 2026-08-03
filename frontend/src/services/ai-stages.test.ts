import { describe, expect, it } from 'vitest';
import { elapsedLabel, recallStages, researchStages } from './ai-stages';

describe('researchStages', () => {
  it('작성 중 → 접수됨 → 조사 → 출처 정리 → 완료 순서를 유지한다', () => {
    expect(researchStages('draft').map((stage) => stage.label))
      .toEqual(['작성 중', '접수됨', '공개 자료 조사 중', '출처 정리 중', '완료']);
  });

  it('지난 단계는 done, 현재 단계만 active로 표시한다', () => {
    const stages = researchStages('searching');
    expect(stages.map((stage) => stage.state)).toEqual(['done', 'done', 'active', 'todo', 'todo']);
  });

  it('현재 단계의 한 문장을 함께 준다', () => {
    expect(researchStages('received').find((stage) => stage.state === 'active')?.headline).toBe('요청을 접수했어요');
  });
});

describe('recallStages', () => {
  it('대조 단계는 지어낸 숫자가 아니라 실제 기록 수를 말한다', () => {
    const stages = recallStages('match', 86);
    expect(stages.find((stage) => stage.state === 'active')?.headline).toBe('이 기기에 있는 기록 86건을 대조하고 있어요');
  });

  it('완료 단계에서는 앞 단계가 모두 done이다', () => {
    expect(recallStages('done', 3).map((stage) => stage.state)).toEqual(['done', 'done', 'done', 'active']);
  });
});

describe('elapsedLabel', () => {
  it('1초 미만은 소수 첫째 자리까지 보여 준다', () => {
    expect(elapsedLabel(180)).toBe('0.2초');
    expect(elapsedLabel(0)).toBe('0.0초');
  });

  it('10초를 넘으면 반올림한 초, 1분을 넘으면 분·초로 말한다', () => {
    expect(elapsedLabel(12_400)).toBe('12초');
    expect(elapsedLabel(83_000)).toBe('1분 23초');
  });

  it('음수는 0으로 다룬다', () => {
    expect(elapsedLabel(-500)).toBe('0.0초');
  });
});
