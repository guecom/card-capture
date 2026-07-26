import { describe, expect, it } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import { captureContextFilled, captureContextSummary, recentEventChips, toggleChipValue } from './capture-context';

const empty = { event: '', relKairen: '', relSelf: '', memo: '' };

describe('captureContextSummary', () => {
  it('비어 있으면 요약도 비어 있다 — 빈 필드는 조용히 둔다', () => {
    expect(captureContextSummary(empty)).toBe('');
    expect(captureContextFilled(empty)).toBe(0);
  });

  it('저장될 내용만 그대로 요약한다', () => {
    expect(captureContextSummary({ event: '2026 로보월드', relKairen: '잠재 고객', relSelf: '오늘 처음', memo: '' }))
      .toBe('2026 로보월드 · Kairen: 잠재 고객 · 나: 오늘 처음');
  });

  it('긴 메모는 잘라 한 줄을 넘기지 않는다', () => {
    const summary = captureContextSummary({ ...empty, memo: '공장장님이고 우리 부품에 관심이 아주 많으셨다' });
    expect(summary).toBe('메모 공장장님이고 우리 부품에 관심이…');
  });

  it('공백만 있는 값은 입력으로 세지 않는다', () => {
    expect(captureContextFilled({ ...empty, event: '   ' })).toBe(0);
  });
});

describe('recentEventChips', () => {
  const brief = (event: string, captureId: string): BriefItem => ({ captureId, event } as BriefItem);

  it('최근에 쓴 만난 곳을 중복 없이 되돌려 준다', () => {
    const chips = recentEventChips([brief('로보월드', 'a'), brief('로보월드', 'b'), brief('판교 밋업', 'c')]);
    expect(chips).toEqual(['로보월드', '판교 밋업']);
  });

  it('이미 입력한 값은 chip으로 다시 제안하지 않는다', () => {
    expect(recentEventChips([brief('로보월드', 'a'), brief('판교 밋업', 'c')], '로보월드')).toEqual(['판교 밋업']);
  });

  it('만난 곳이 없는 기록은 건너뛴다', () => {
    expect(recentEventChips([brief('', 'a'), brief('판교 밋업', 'b')])).toEqual(['판교 밋업']);
  });
});

describe('toggleChipValue', () => {
  it('같은 값을 다시 누르면 비운다', () => {
    expect(toggleChipValue('잠재 고객', '잠재 고객')).toBe('');
    expect(toggleChipValue('', '잠재 고객')).toBe('잠재 고객');
    expect(toggleChipValue('직접 쓴 값', '잠재 고객')).toBe('잠재 고객');
  });
});
