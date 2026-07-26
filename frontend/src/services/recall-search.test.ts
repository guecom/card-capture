import { describe, expect, it } from 'vitest';
import { describeRecallQuery, parseRecallQuery, parseRecallWindow, runRecallSearch, serverFallbackTerm } from './recall-search';
import type { BriefItem } from '../contracts/capture';

// 기준 시각: 2026-07-26(일) 20:00 KST 상당. 주 시작은 월요일이므로 이번 주 = 7/20~, 지난주 = 7/13~7/19.
const NOW = new Date(2026, 6, 26, 20, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

function item(overrides: Partial<BriefItem> & { captureId: string }): BriefItem {
  return { status: 'processed', ...overrides };
}

function at(daysAgo: number): string {
  return new Date(NOW - daysAgo * DAY).toISOString();
}

const people: BriefItem[] = [
  item({
    captureId: '20260722-090000-a1',
    receivedAt: at(4),
    person: 'PER-000001',
    event: '2026 로보월드',
    contact: { name: '김민서', title: '구매팀장', organization: '한화시스템' },
    brief: '# 김민서 — 이런 분이에요\n자동화 라인 부품 국산화를 검토 중입니다.',
  }),
  item({
    captureId: '20260716-140000-a2',
    receivedAt: at(10),
    person: 'PER-000002',
    event: '판교 밋업',
    contact: { name: '박지훈', title: 'CTO', organization: '넥스트로보' },
    brief: '# 박지훈 — 이런 분이에요\n로봇 제어 소프트웨어 창업자입니다.',
  }),
  item({
    captureId: '20260715-100000-a3',
    receivedAt: at(11),
    person: 'PER-000003',
    event: '한화 협력사 설명회',
    contact: { name: '이서연', title: '책임연구원', organization: '한화에어로스페이스' },
    brief: '# 이서연 — 이런 분이에요\n구동계 시험 담당입니다.',
  }),
];

describe('parseRecallWindow', () => {
  it('normalizes Korean relative time to an absolute range', () => {
    const lastWeek = parseRecallWindow('지난주쯤 만난 사람', NOW);
    expect(new Date(lastWeek!.from).getDate()).toBe(13);
    expect(new Date(lastWeek!.to - 1).getDate()).toBe(19);

    const yesterday = parseRecallWindow('어제 본 사람', NOW);
    expect(new Date(yesterday!.from).getDate()).toBe(25);

    expect(parseRecallWindow('3일 전에 만난 사람', NOW)!.label).toContain('7월 23일');
    expect(parseRecallWindow('작년에 만난 사람', NOW)!.label).toContain('2025');
    expect(parseRecallWindow('한화 다니던 사람', NOW)).toBeNull();
  });
});

describe('parseRecallQuery', () => {
  it('pulls organization, event and role clues out of a spoken sentence', () => {
    const query = parseRecallQuery('지난주쯤에 만났던 사람인데 한화 다니던 구매팀장이었어', NOW);
    expect(query.window?.label).toContain('지난주');
    expect(query.fuzzy).toBe(true);
    expect(query.terms).toContainEqual({ text: '한화', kind: 'org' });
    expect(query.terms.some((term) => term.kind === 'role')).toBe(true);
  });

  it('refuses to use attributes the app never records', () => {
    const query = parseRecallQuery('지난주에 만난 여자분인데 안경 썼어', NOW);
    expect(query.ignored.map((entry) => entry.text)).toEqual(['성별', '외모']);
    expect(query.terms.some((term) => /여자|안경/.test(term.text))).toBe(false);
  });

  it('does not turn the sentence glue into search terms', () => {
    const query = parseRecallQuery('지난주쯤 만났던 사람인데 여자였고 한화 다니던 구매팀장이었어', NOW);
    // '다니', '사람인데' 같은 조각이 조건으로 올라오면 읽어 주는 문장이 쓰레기가 된다.
    expect(query.terms.map((term) => term.text).sort()).toEqual(['구매', '팀장', '한화']);
  });

  it('keeps the event phrase when the sentence says where they met', () => {
    const query = parseRecallQuery('로보월드에서 만난 사람', NOW);
    expect(query.terms).toContainEqual({ text: '로보월드', kind: 'event' });
  });
});

describe('runRecallSearch', () => {
  it('finds the person from a partial memory and explains every match', () => {
    const result = runRecallSearch(people, '지난주쯤 만난 사람인데 한화 다니던 사람', NOW);
    const names = result.candidates.map((candidate) => candidate.item.contact?.name);
    expect(names[0]).toBe('이서연');
    expect(result.candidates[0].evidence.some((entry) => entry.kind === 'time')).toBe(true);
    expect(result.candidates[0].evidence.some((entry) => entry.label.includes('한화'))).toBe(true);
    // 같은 '한화'라도 지난주 밖(4일 전)인 김민서는 시점 필터에서 빠진다.
    expect(names).not.toContain('김민서');
  });

  it('keeps near-miss candidates only when the sentence was vague, and marks them', () => {
    const vague = runRecallSearch(people, '이번 주쯤 만난 한화 사람', NOW);
    expect(vague.candidates.map((candidate) => candidate.item.contact?.name)).toContain('김민서');

    const exact = runRecallSearch(people, '이번 주에 만난 넥스트로보 사람', NOW);
    expect(exact.candidates).toHaveLength(0);
  });

  it('lists a time-only question newest first, without demanding a keyword', () => {
    const result = runRecallSearch(people, '지난주에 만난 사람', NOW);
    expect(result.candidates.map((candidate) => candidate.item.contact?.name)).toEqual(['박지훈', '이서연']);
  });

  it('reports the conditions it could not match instead of silently dropping them', () => {
    const result = runRecallSearch(people, '수원에서 만난 한화 사람', NOW);
    expect(result.unmatchedTerms).toContain('수원');
  });

  it('returns nothing rather than guessing when the memory matches no record', () => {
    expect(runRecallSearch(people, '작년에 만난 포스코 사람', NOW).candidates).toHaveLength(0);
  });
});

describe('serverFallbackTerm / describeRecallQuery', () => {
  it('sends the strongest single keyword to the server search, not the sentence', () => {
    expect(serverFallbackTerm(parseRecallQuery('지난주에 만난 한화 구매팀장', NOW))).toBe('한화');
    expect(serverFallbackTerm(parseRecallQuery('지난주에 만난 사람', NOW))).toBe('');
  });

  it('says back what it searched for', () => {
    expect(describeRecallQuery(parseRecallQuery('지난주에 만난 한화 사람', NOW))).toContain('지난주');
    expect(describeRecallQuery(parseRecallQuery('한화', NOW))).toContain("'한화'");
  });
});
