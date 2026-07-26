import { describe, expect, it } from 'vitest';
import { nameFromOcrWords, type OcrWord } from './quickname-picker';

function word(text: string, heightRatio: number, overrides: Partial<OcrWord> = {}): OcrWord {
  return { text, confidence: 0.9, heightRatio, centerRatio: 0.4, ...overrides };
}

describe('nameFromOcrWords', () => {
  it('picks the largest-font hangul line as the name (typical korean card)', () => {
    const picked = nameFromOcrWords([
      word('카이렌 로보틱스', 0.06),
      word('김진우', 0.12),
      word('대표이사', 0.05),
      word('서울시 강남구 테헤란로 12', 0.03, { centerRatio: 0.9 }),
    ]);
    expect(picked?.name).toBe('김진우');
  });

  it('extracts the name token when the title shares the line', () => {
    const picked = nameFromOcrWords([
      word('홍길동 대표이사', 0.11),
      word('로보텍 주식회사', 0.07),
    ]);
    expect(picked?.name).toBe('홍길동');
  });

  it('never picks company, titles, or contact lines', () => {
    const picked = nameFromOcrWords([
      word('주식회사 한빛로보틱스', 0.1),
      word('수석 매니저', 0.08),
      word('010-1234-5678', 0.06),
      word('gildong@robotech.kr', 0.06),
    ]);
    expect(picked).toBeNull();
  });

  it('font size beats reading order — name lower on the card still wins', () => {
    const picked = nameFromOcrWords([
      word('Kairen Robotics', 0.05, { centerRatio: 0.15 }),
      word('박민준', 0.13, { centerRatio: 0.6 }),
    ]);
    expect(picked?.name).toBe('박민준');
  });

  it('accepts english full names when no hangul name exists', () => {
    const picked = nameFromOcrWords([
      word('Jane Kim', 0.11),
      word('Chief Executive Officer', 0.05),
    ]);
    expect(picked?.name).toBe('Jane Kim');
  });

  it('drops low-confidence lines and reports confidence 0..100', () => {
    expect(nameFromOcrWords([word('김서연', 0.12, { confidence: 0.2 })])).toBeNull();
    const picked = nameFromOcrWords([word('김서연', 0.12, { confidence: 0.87 })]);
    expect(picked?.confidence).toBe(87);
  });
});
