import { describe, expect, it } from 'vitest';
import { buildHighlights, highlightLabel } from './highlights';

const personDocument = [
  '---',
  'name: 김민서',
  'organization: 한화시스템',
  'last_contacted: 2026-07-22',
  '---',
  '# 김민서',
  '',
  '## Summary',
  '자동화 라인 부품 국산화를 검토 중인 구매 담당자.',
  '',
  '## 최근 활동 (90일)',
  '- 2026-06 스마트팩토리 세미나에서 **국산 부품 검증 기준**을 발표했다. [영상](https://example.test/talk)',
  '',
  '## 대화 포인트',
  '- 없음',
  '- 국산화 파일럿의 검증 기간을 줄이는 방법에 관심이 있다.',
  '',
  '## Kairen 관점',
  '자동화 셀 도입 검토 단계라 파일럿 제안이 가능한 접점이다.',
].join('\n');

describe('buildHighlights', () => {
  it('quotes one line per section and says where each came from', () => {
    const { items, checkedAt } = buildHighlights(personDocument);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: 'recent', sourceSection: '최근 활동 (90일)' });
    // 마크다운 링크·강조는 벗겨서 읽을 수 있는 문장으로 만든다.
    expect(items[0].text).toContain('국산 부품 검증 기준');
    expect(items[0].text).not.toContain('**');
    expect(items[0].text).not.toContain('](');
    // "없음" 같은 자리표시자는 건너뛰고 실제 내용을 고른다.
    expect(items[1]).toMatchObject({ kind: 'talking-point' });
    expect(items[1].text).toContain('검증 기간');
    expect(items[2].kind).toBe('kairen');
    expect(checkedAt).toBe('2026-07-22');
  });

  it('says nothing when the record has no such sections — no invented summary', () => {
    const bare = ['---', 'name: 박지훈', '---', '# 박지훈', '', '## 명함 정보', '- 이메일: a@b.test'].join('\n');
    expect(buildHighlights(bare).items).toEqual([]);
  });

  it('skips a section whose only content is a placeholder', () => {
    const empty = ['# 이서연', '', '## 최근 활동', '- 미확인', '', '## Kairen 관점', '구동계 시험 협력 여지가 있다.'].join('\n');
    const { items } = buildHighlights(empty);
    expect(items.map((item) => item.kind)).toEqual(['kairen']);
  });

  it('honours the limit and never repeats the same sentence', () => {
    expect(buildHighlights(personDocument, 1).items).toHaveLength(1);
    expect(highlightLabel('recent')).toBe('최근 변화');
  });
});
