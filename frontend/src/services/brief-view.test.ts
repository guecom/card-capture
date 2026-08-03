import { describe, expect, it } from 'vitest';
import { actionErrorMessage, briefListTitle, briefNameMap, briefTitle, elapsedMinutesOf, nameFromBrief, pendingProgress } from './brief-view';
import type { BriefItem } from '../contracts/capture';

function item(overrides: Partial<BriefItem>): BriefItem {
  return { captureId: '20260726-090000-ab12', status: 'received', ...overrides };
}

describe('nameFromBrief', () => {
  it('extracts the name from either title order', () => {
    expect(nameFromBrief('# 홍길동 — 이런 분이에요\n본문')).toBe('홍길동');
    expect(nameFromBrief('# 이런 분이에요 — 홍길동\n본문')).toBe('홍길동');
    expect(nameFromBrief('본문만')).toBeNull();
  });
});

describe('briefTitle', () => {
  it('always reassembles processed briefs as 이름 — 이런 분이에요', () => {
    expect(briefTitle(item({ status: 'processed', brief: '# 이런 분이에요 — 홍길동\n본문' }))).toBe('홍길동 — 이런 분이에요');
  });

  it('labels note and research receipts like legacy', () => {
    expect(briefTitle(item({ type: 'note', status: 'processed', person: 'PER-000401' }))).toBe('메모 → PER-000401');
    expect(briefTitle(item({ type: 'research_instruction', status: 'received' }))).toBe('조사 지시 → 처리 중');
  });

  it('falls back through contact, quickName, event, captureId', () => {
    expect(briefTitle(item({ contact: { name: '박민준' } }))).toBe('박민준 — 브리핑 준비 중');
    expect(briefTitle(item({ quickName: { name: '김서연', source: 's', confidence: 1, confirmed: false, recognizedAt: 'r' } })))
      .toBe('김서연 — 이름 확인됨 · 조사 준비 중');
    expect(briefTitle(item({ event: '사내 미팅' }))).toBe('사내 미팅');
    expect(briefTitle(item({}))).toBe('20260726-090000-ab12');
  });
});

describe('briefNameMap', () => {
  it('maps captureId to the best display name', () => {
    const map = briefNameMap([
      item({ captureId: 'a', brief: '# 홍길동 — 이런 분이에요' }),
      item({ captureId: 'b', contact: { name: '박민준' } }),
      item({ captureId: 'c' }),
    ]);
    expect(map).toEqual({ a: '홍길동', b: '박민준' });
  });
});

describe('elapsedMinutesOf', () => {
  it('prefers receivedAt over capturedAt', () => {
    const now = Date.parse('2026-07-26T10:00:00+09:00');
    expect(elapsedMinutesOf({ captureId: 'x', receivedAt: '2026-07-26T09:50:00+09:00', capturedAt: '2026-07-26T09:00:00+09:00' }, now)).toBe(10);
  });

  it('falls back to parsing captureId as local time', () => {
    // captureId는 기기 로컬 시각으로 기록된다 — 기준 now도 로컬 성분으로 만들어 타임존 독립으로 검증한다.
    const now = new Date(2026, 6, 26, 10, 0, 0).getTime();
    expect(elapsedMinutesOf({ captureId: '20260726-094500-ab12' }, now)).toBe(15);
  });

  it('returns null for unparseable or absurd values', () => {
    expect(elapsedMinutesOf({ captureId: 'nope' }, Date.parse('2026-07-26T10:00:00+09:00'))).toBeNull();
  });
});

describe('pendingProgress', () => {
  it('returns null for terminal items', () => {
    expect(pendingProgress(item({ status: 'processed' }), 10)).toBeNull();
    expect(pendingProgress(item({ status: 'skipped' }), 10)).toBeNull();
  });

  it('describes stage 1 with the usual duration', () => {
    const progress = pendingProgress(item({}), 2);
    expect(progress?.late).toBe(false);
    expect(progress?.text).toContain('1/3단계 이름 인식(OCR) 중 · 2분 경과');
    expect(progress?.text).toContain('보통 3분');
  });

  it('describes stage 2 with a remaining estimate once named', () => {
    const progress = pendingProgress(item({ contact: { name: '박민준' } }), 8);
    expect(progress?.text).toContain('2/3단계');
    expect(progress?.text).toContain('완료까지 약 6분 남음');
  });

  it('flags late items past 30 minutes', () => {
    const progress = pendingProgress(item({ contact: { name: '박민준' } }), 45);
    expect(progress?.late).toBe(true);
    expect(progress?.text).toContain('평소(6~20분)보다 오래');
  });
});

describe('actionErrorMessage', () => {
  it('maps known server codes to korean guidance', () => {
    expect(actionErrorMessage('owner_only')).toBe('소유자 토큰만 사용할 수 있어요');
    expect(actionErrorMessage('unknown_action')).toContain('GAS 재배포');
    expect(actionErrorMessage(new Error('not_processed'))).toContain('브리핑 도착 후');
  });

  it('maps network failures generically and passes through unknown codes', () => {
    expect(actionErrorMessage(new TypeError('Failed to fetch'))).toContain('네트워크 오류');
    expect(actionErrorMessage('weird_code')).toBe('요청 실패: weird_code');
  });
});

describe('briefListTitle', () => {
  const brief = (body: string) => ({ captureId: 'c1', status: 'processed', brief: `# 김진우 — 이런 분이에요\n${body}` } as never);

  it('shows 이름 — 한 줄 요약 instead of the fixed phrase', () => {
    expect(briefListTitle(brief('\n카이렌 로보틱스 대표. 협동로봇 그리퍼를 만든다.\n\n## 대화 포인트'))).toBe('김진우 — 카이렌 로보틱스 대표. 협동로봇 그리퍼를 만든다.');
  });

  it('skips headings, bullets and blank lines when finding the summary', () => {
    expect(briefListTitle(brief('\n## 요약\n\n- \n**스마트팩토리 SI를 하는 회사의 영업 총괄이다.**'))).toBe('김진우 — 스마트팩토리 SI를 하는 회사의 영업 총괄이다.');
  });

  it('truncates a long summary', () => {
    const long = '가'.repeat(120);
    const title = briefListTitle(brief(`\n${long}`));
    expect(title.length).toBeLessThan(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('falls back to progress copy while the brief has no body yet', () => {
    expect(briefListTitle({ captureId: 'c2', status: 'queued', quickName: { name: '박서연' } } as never)).toBe('박서연 — 이름 확인됨 · 조사 준비 중');
    expect(briefListTitle({ captureId: 'c3', status: 'queued', contact: { name: '박서연' } } as never)).toBe('박서연 — 브리핑 준비 중');
  });

  it('uses organization and title when the brief body is only structure', () => {
    expect(briefListTitle({ captureId: 'c4', status: 'processed', brief: '# 김진우 — 이런 분이에요\n\n## 대화 포인트', contact: { name: '김진우', organization: '카이렌 로보틱스', title: '대표' } } as never))
      .toBe('김진우 — 카이렌 로보틱스 · 대표');
  });
});
