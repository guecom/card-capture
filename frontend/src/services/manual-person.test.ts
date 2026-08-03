import { beforeEach, describe, expect, it } from 'vitest';
// 합성 fixture는 `eval/fixtures/manual-person/`이 원본이다. 여기서 직접 읽어 채점한다 —
// 실행되지 않는 fixture는 문서일 뿐이다. (디렉터리 전체 훑기는 `eval/manual-person-intake.test.js`가 한다.)
import conflictingIdentity from '../../../eval/fixtures/manual-person/manual-conflicting-identity.json';
import exactContactDuplicate from '../../../eval/fixtures/manual-person/manual-exact-contact-duplicate.json';
import sparseRecall from '../../../eval/fixtures/manual-person/manual-sparse-recall.json';
import wrongMergeAttempt from '../../../eval/fixtures/manual-person/manual-wrong-merge-attempt.json';
import {
  buildManualIntake,
  classifyPersonMatch,
  clearManualDraft,
  extractIdentityEvidence,
  hasIdentityEvidence,
  loadManualDraft,
  manualDisplayText,
  manualSubmitRefusal,
  manualTextBudget,
  manualUploadErrorMessage,
  MANUAL_TEXT_MAX,
  normalizePhone,
  saveManualDraft,
  startManualDraft,
  type ManualMatchOutcome,
  type PersonCandidate,
} from './manual-person';
import { MANUAL_INTAKE_NOT_DEPLOYED } from './api';
import { setActiveSubject } from './storage';
import { FakeStorage } from './test-storage';

describe('입력 판정', () => {
  it('빈 내용과 공백만 있는 내용은 같은 이유로 막는다 — 버튼을 죽이지 않는다', () => {
    expect(manualSubmitRefusal('')).toBe('empty');
    expect(manualSubmitRefusal('   \n\t ')).toBe('empty');
  });

  it('세 단어만 적어도 통과한다 — 구조화된 연락처를 강요하지 않는다', () => {
    expect(manualSubmitRefusal('어제 만난 로보틱스 대표')).toBeNull();
  });

  it('상한 경계에서만 거절한다', () => {
    expect(manualSubmitRefusal('가'.repeat(MANUAL_TEXT_MAX))).toBeNull();
    expect(manualSubmitRefusal('가'.repeat(MANUAL_TEXT_MAX + 1))).toBe('too_long');
  });

  it('남은 글자는 상한이 가까워질 때만 알려 준다 — 늘 떠 있는 카운터는 잔소리다', () => {
    expect(manualTextBudget('짧은 메모').nearLimit).toBe(false);
    expect(manualTextBudget('가'.repeat(MANUAL_TEXT_MAX - 200)).nearLimit).toBe(true);
    const over = manualTextBudget('가'.repeat(MANUAL_TEXT_MAX + 5));
    expect(over.over).toBe(true);
    expect(over.remaining).toBe(-5);
  });

  it('목록 요약은 첫 줄을 그대로 줄인다 — 없는 말을 지어내지 않는다', () => {
    expect(manualDisplayText('  어제 만난 로보틱스 대표\n판교 사무실 방문 예정 ')).toBe('어제 만난 로보틱스 대표');
    expect(manualDisplayText('가'.repeat(60), 10)).toBe(`${'가'.repeat(10)}…`);
  });
});

describe('신원 근거 추출', () => {
  it('메신저에서 붙여 넣은 문단에서 이메일과 전화를 찾는다', () => {
    const evidence = extractIdentityEvidence(
      '아까 그분 연락처 보냄. 가온테크 김미래 CTO\nMIRAE.KIM@gaontech-fake.co.kr\n010-1234-5678\n다음 주에 미팅 잡자',
    );
    expect(evidence.emails).toEqual(['mirae.kim@gaontech-fake.co.kr']);
    expect(evidence.phones).toEqual(['01012345678']);
    // 화면 되읽기는 사용자가 적은 표기 그대로여야 한다.
    expect(evidence.phoneDisplays).toEqual(['010-1234-5678']);
    expect(hasIdentityEvidence(evidence)).toBe(true);
  });

  it('국가번호 표기와 국내 표기는 같은 번호로 본다', () => {
    expect(normalizePhone('+82 10-1234-5678')).toBe('01012345678');
    expect(normalizePhone('010 1234 5678')).toBe('01012345678');
    expect(normalizePhone('(02) 123-4567')).toBe('021234567');
  });

  it('전화번호처럼 안 생긴 숫자는 근거로 인정하지 않는다 — 근거 하나가 병합 권한이다', () => {
    // 날짜·주문번호·금액이 전화번호로 통과하면 엉뚱한 사람에게 붙는다.
    expect(normalizePhone('2026-07-27')).toBe('');
    expect(normalizePhone('1234567890')).toBe('');
    expect(normalizePhone('123-4567')).toBe('');
    expect(extractIdentityEvidence('2026-07-27 14:00 미팅, 견적 12,000,000원').phones).toEqual([]);
  });

  it('이메일 안의 숫자를 전화번호로 착각하지 않는다', () => {
    const evidence = extractIdentityEvidence('연락은 rep01012345678@fake-mail.example.test 로만 된다고 함');
    expect(evidence.emails).toEqual(['rep01012345678@fake-mail.example.test']);
    expect(evidence.phones).toEqual([]);
  });

  it('세 단어짜리 입력에는 근거가 없다 — 없는 것을 있다고 하지 않는다', () => {
    const evidence = extractIdentityEvidence('어제 만난 로보틱스 대표');
    expect(evidence).toEqual({ emails: [], phones: [], phoneDisplays: [] });
    expect(hasIdentityEvidence(evidence)).toBe(false);
  });
});

/* ── 연결 판정 ─────────────────────────────────────────────────────────────
   이 블록이 이 모듈의 존재 이유다. 확인 모달이 없으므로 틀린 병합을 사람이 막아 줄 자리가 없다. */

const gaon: PersonCandidate = {
  personId: 'PER-999001',
  fullName: '김미래',
  organization: '가온테크',
  emails: ['MIRAE.KIM@gaontech-fake.co.kr'],
  phones: ['010-1234-5678'],
};
const chungram: PersonCandidate = {
  personId: 'PER-999002',
  fullName: '김미래',
  organization: '청람소프트',
  emails: ['ceo@chungram-fake.io'],
  phones: ['010-7777-8888'],
};

function outcome(text: string, extra: { fullName?: string; organization?: string }, candidates: PersonCandidate[]): ManualMatchOutcome {
  return classifyPersonMatch({ evidence: extractIdentityEvidence(text), ...extra }, candidates);
}

describe('강한 근거만 연결한다', () => {
  it('이메일이 대소문자만 다르게 정확히 일치하면 이어 붙인다', () => {
    expect(outcome('가온테크 김미래 CTO, mirae.kim@gaontech-fake.co.kr', { fullName: '김미래', organization: '가온테크' }, [gaon, chungram]))
      .toEqual({ decision: 'link', reason: 'exact_email', personId: 'PER-999001', matchedOn: 'email' });
  });

  it('전화가 표기만 다르게 정확히 일치하면 이어 붙인다', () => {
    expect(outcome('아까 그분 +82 10-1234-5678', {}, [gaon, chungram]))
      .toEqual({ decision: 'link', reason: 'exact_phone', personId: 'PER-999001', matchedOn: 'phone' });
  });

  it('연락처가 없어도 이름+소속이 모호하지 않게 완전 일치하면 이어 붙인다', () => {
    expect(outcome('가온테크 김미래 CTO 다시 만남', { fullName: '김미래', organization: '가온테크' }, [gaon]))
      .toEqual({ decision: 'link', reason: 'exact_name_and_organization', personId: 'PER-999001', matchedOn: 'name_and_organization' });
  });

  it('공백·대소문자 차이는 같은 이름·소속으로 본다', () => {
    expect(outcome('다시 만남', { fullName: '김 미래', organization: ' 가온테크 ' }, [gaon]).decision).toBe('link');
  });
});

describe('약하거나 모순되는 근거는 언제나 새 인물이다 (틀린 병합 금지)', () => {
  it('이름만 같은 것은 근거가 아니다 — 동명이인', () => {
    const verdict = outcome('김미래라는 분을 소개받음', { fullName: '김미래' }, [gaon]);
    expect(verdict.decision).toBe('new');
    expect(verdict.reason).toBe('name_only');
    expect(verdict.personId).toBeUndefined();
  });

  it('이름이 같아도 소속이 다르면 기존 인물을 건드리지 않는다', () => {
    // eval/fixtures/manual-person/manual-wrong-merge-attempt.json 과 같은 상황이다.
    const verdict = outcome('청람소프트 김미래 대표', { fullName: '김미래', organization: '청람소프트' }, [gaon]);
    expect(verdict).toEqual({ decision: 'new', reason: 'organization_mismatch' });
  });

  it('이름+소속이 맞아도 연락처가 어긋나면 일치가 아니라 모순이다', () => {
    const verdict = outcome('가온테크 김미래 CTO, 새 번호 010-5555-6666', { fullName: '김미래', organization: '가온테크' }, [gaon]);
    expect(verdict).toEqual({ decision: 'new', reason: 'conflicting_evidence' });
  });

  it('이메일과 전화가 서로 다른 사람을 가리키면 어느 쪽도 건드리지 않는다', () => {
    const verdict = outcome('mirae.kim@gaontech-fake.co.kr 인데 번호는 010-7777-8888 이라고 함', {}, [gaon, chungram]);
    expect(verdict).toEqual({ decision: 'new', reason: 'conflicting_evidence' });
  });

  it('이름+소속이 같은 후보가 둘이면 모르는 채로 고르지 않는다', () => {
    const twin: PersonCandidate = { personId: 'PER-999003', fullName: '김미래', organization: '가온테크' };
    const other: PersonCandidate = { personId: 'PER-999004', fullName: '김미래', organization: '가온테크' };
    expect(outcome('가온테크 김미래', { fullName: '김미래', organization: '가온테크' }, [twin, other]))
      .toEqual({ decision: 'new', reason: 'ambiguous_candidates' });
  });

  it('이름조차 확정되지 않은 세 단어 입력은 새 인물이다', () => {
    expect(outcome('어제 만난 로보틱스 대표', {}, [gaon, chungram]))
      .toEqual({ decision: 'new', reason: 'weak_evidence' });
  });

  it('연락처가 비어 있는 기존 인물에는 이름+소속 완전 일치를 근거로 인정한다', () => {
    const sparse: PersonCandidate = { personId: 'PER-999005', fullName: '오하늘', organization: '새빛시스템' };
    expect(outcome('새빛시스템 오하늘 이사, 010-2468-1357', { fullName: '오하늘', organization: '새빛시스템' }, [sparse]))
      .toEqual({ decision: 'link', reason: 'exact_name_and_organization', personId: 'PER-999005', matchedOn: 'name_and_organization' });
  });

  it('대조할 기존 인물이 없으면 새 인물이다', () => {
    expect(outcome('mirae.kim@gaontech-fake.co.kr', { fullName: '김미래', organization: '가온테크' }, []))
      .toEqual({ decision: 'new', reason: 'no_candidate' });
  });
});

/* ── 합성 fixture corpus ────────────────────────────────────────────────────
   `eval/fixtures/manual-person/`의 fixture를 여기서 실제로 채점한다. 실행되지 않는 fixture는
   문서일 뿐이므로, 판정기가 소비하는 자리를 하나 만들어 둔다. */

interface ManualFixture {
  id: string;
  synthetic: boolean;
  manual: { text: string; claim?: { fullName?: string; organization?: string } };
  vault_context?: { candidates?: PersonCandidate[] };
  expected: { decision: string; reason: string; personId?: string; evidence?: { emails?: string[]; phones?: string[] } };
  must_not?: string[];
}

const FIXTURES = [sparseRecall, exactContactDuplicate, conflictingIdentity, wrongMergeAttempt] as unknown as ManualFixture[];

describe('합성 fixture corpus', () => {
  it('corpus가 비어 있지 않다 — fixture를 지워서 green을 만들 수 없다', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(4);
    expect(new Set(FIXTURES.map((fixture) => fixture.id)).size).toBe(FIXTURES.length);
  });

  for (const fixture of FIXTURES) {
    it(`${fixture.id}: ${fixture.expected.decision}/${fixture.expected.reason}`, () => {
      expect(fixture.synthetic, '합성 fixture만 허용한다').toBe(true);
      const evidence = extractIdentityEvidence(fixture.manual.text);
      if (fixture.expected.evidence?.emails) expect(evidence.emails).toEqual(fixture.expected.evidence.emails);
      if (fixture.expected.evidence?.phones) expect(evidence.phones).toEqual(fixture.expected.evidence.phones);
      const verdict = classifyPersonMatch(
        { evidence, fullName: fixture.manual.claim?.fullName, organization: fixture.manual.claim?.organization },
        fixture.vault_context?.candidates ?? [],
      );
      expect(verdict.decision).toBe(fixture.expected.decision);
      expect(verdict.reason).toBe(fixture.expected.reason);
      expect(verdict.personId ?? '').toBe(fixture.expected.personId ?? '');
    });
  }
});

/* ── 멱등과 초안 ─────────────────────────────────────────────────────────── */

describe('멱등 키는 초안이 소유한다', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new FakeStorage() });
    setActiveSubject('s-test');
    clearManualDraft();
  });

  it('같은 초안에서 만든 항목은 몇 번을 만들어도 같은 captureId다', () => {
    const draft = startManualDraft(new Date('2026-08-04T01:02:03.000Z'), () => 0.5);
    const first = buildManualIntake({ captureId: draft.captureId, text: '전시회에서 만난 공급사 이사' });
    const second = buildManualIntake({ captureId: draft.captureId, text: '전시회에서 만난 공급사 이사' });
    expect(second.captureId).toBe(first.captureId);
    expect(first.captureId).toBe(draft.captureId);
  });

  it('초안은 저장했다 다시 읽어도 captureId가 바뀌지 않는다 — 앱을 껐다 켜도 job은 하나다', () => {
    const draft = startManualDraft(new Date('2026-08-04T01:02:03.000Z'), () => 0.25);
    saveManualDraft({ ...draft, text: '판교에서 만난 연구소장' });
    expect(loadManualDraft()?.captureId).toBe(draft.captureId);
    expect(startManualDraft().captureId).toBe(draft.captureId);
    expect(startManualDraft().text).toBe('판교에서 만난 연구소장');
  });

  it('등록이 끝나 초안을 비우면 다음 등록은 새 captureId를 받는다', () => {
    const first = startManualDraft(new Date('2026-08-04T01:02:03.000Z'), () => 0.25);
    saveManualDraft({ ...first, text: '첫 사람' });
    clearManualDraft();
    const second = startManualDraft(new Date('2026-08-04T04:05:06.000Z'), () => 0.75);
    expect(second.captureId).not.toBe(first.captureId);
    expect(second.text).toBe('');
  });

  it('망가진 초안은 조용히 버린다 — 읽을 수 없는 값으로 job을 만들지 않는다', () => {
    localStorage.setItem('cc_s-test_manualDraft', '{ not json');
    expect(loadManualDraft()).toBeNull();
    localStorage.setItem('cc_s-test_manualDraft', JSON.stringify({ text: '아이디 없음' }));
    expect(loadManualDraft()).toBeNull();
  });
});

describe('대기열 항목', () => {
  it('사진 대신 글이 payload이고 출처가 명함으로 위장되지 않는다', () => {
    const item = buildManualIntake({
      captureId: '20260804-010203-abcd',
      text: '  가온테크 김미래 CTO, mirae.kim@gaontech-fake.co.kr  ',
      event: ' 전시회·박람회 ',
      relKairen: ' 잠재 고객 ',
      relSelf: ' 오늘 처음 ',
      now: new Date('2026-08-04T01:02:03.000Z'),
      random: () => 0.5,
    });
    expect(item.intake).toBe('manual_person');
    expect(item.images).toEqual([]);
    expect(item.quickName).toBeNull();
    expect(item.manualText).toBe('가온테크 김미래 CTO, mirae.kim@gaontech-fake.co.kr');
    expect(item.identityEvidence?.emails).toEqual(['mirae.kim@gaontech-fake.co.kr']);
    expect(item.event).toBe('전시회·박람회');
    expect(item.note).toBe('나와의 관계: 오늘 처음\nKairen과의 관계: 잠재 고객');
    // 원문을 메모 칸에 한 번 더 넣지 않는다 — 두 번째 진실 원본을 만들지 않는다.
    expect(item.memo).toBe('');
    expect(item.state).toBe('queued');
  });

  it('빈 글로는 항목을 만들지 않는다', () => {
    expect(() => buildManualIntake({ captureId: 'x', text: '   ' })).toThrow('empty_manual_text');
  });

  it('상한을 넘긴 글은 잘라서 저장한다 — 서버가 자르는 자리와 같다', () => {
    const item = buildManualIntake({ captureId: 'x', text: '가'.repeat(MANUAL_TEXT_MAX + 50) });
    expect(item.manualText).toHaveLength(MANUAL_TEXT_MAX);
  });
});

describe('서버가 아직 직접 입력을 모를 때', () => {
  it('무엇이 남아 있고 누가 무엇을 해야 하는지 말한다 — 조용한 성공으로 바꾸지 않는다', () => {
    const message = manualUploadErrorMessage(MANUAL_INTAKE_NOT_DEPLOYED);
    expect(message).toContain('이 폰에 안전하게 남아');
    expect(message).toContain('다시 배포');
  });

  it('연결 실패는 재시도가 자동으로 이어진다는 사실을 말한다', () => {
    expect(manualUploadErrorMessage('Failed to fetch')).toContain('자동으로 다시 보냅니다');
  });
});
