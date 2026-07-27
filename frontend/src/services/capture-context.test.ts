import { describe, expect, it } from 'vitest';
import { captureContextFilled, captureContextSummary, eventChips, toggleChipValue } from './capture-context';

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

describe('eventChips', () => {
  it('특정 행사가 아니라 일반적인 상황만 제안한다', () => {
    // founder 지시 2026-07-27: 구체적인 행사 이름은 직접 적고, chip은 상황이어야 한다.
    expect(eventChips()).toEqual([
      '고객사 방문 미팅', '우리 회사 방문 미팅', '전시회·박람회', '세미나·컨퍼런스', '투자·IR 미팅', '채용 면접', '소개 자리',
    ]);
  });

  it('이미 고른 상황은 다시 제안하지 않는다', () => {
    expect(eventChips('고객사 방문 미팅')).not.toContain('고객사 방문 미팅');
    expect(eventChips('고객사 방문 미팅')).toHaveLength(6);
  });

  it('직접 적은 값은 chip 목록을 줄이지 않는다', () => {
    expect(eventChips('2026 스마트팩토리전 부스')).toHaveLength(7);
  });
});

describe('toggleChipValue', () => {
  it('같은 값을 다시 누르면 비운다', () => {
    expect(toggleChipValue('잠재 고객', '잠재 고객')).toBe('');
    expect(toggleChipValue('', '잠재 고객')).toBe('잠재 고객');
    expect(toggleChipValue('직접 쓴 값', '잠재 고객')).toBe('잠재 고객');
  });
});
