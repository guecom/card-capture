import { describe, expect, it } from 'vitest';
import {
  BUG_REPORT_ADDRESS,
  BUG_REPORT_MAX_URL,
  buildBugReportBody,
  buildBugReportSubject,
  buildBugReportText,
  bugReportMailto,
  collectBugReportFacts,
  redactSecrets,
} from './bug-report';

const SAFE_INPUT = {
  version: '2.23.0',
  buildId: 'src-a1b2c3d4e5f6',
  tab: '설정',
  connection: '연결됨',
  notifications: '켜짐',
  theme: '라이트',
  online: true,
  viewport: '390x844',
  language: 'ko-KR',
  userAgent: 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
};

function bodyParamOf(mailto: string): string {
  const query = mailto.slice(mailto.indexOf('?') + 1);
  const body = new URLSearchParams(query).get('body');
  expect(body, 'mailto에 body 파라미터가 없다').not.toBeNull();
  return body ?? '';
}

describe('bug report draft', () => {
  it('fills the three-part template and the diagnostics the report actually needs', () => {
    const facts = collectBugReportFacts(SAFE_INPUT);
    const body = buildBugReportBody(facts);

    // 사람이 채우는 세 칸. 하나라도 사라지면 되묻는 왕복이 늘어난다.
    expect(body).toContain('■ 무엇을 하려 했나요');
    expect(body).toContain('■ 무슨 일이 일어났나요');
    expect(body).toContain('■ 언제 그랬나요');
    // 자동으로 채워지는 값.
    expect(body).toContain('버전: 2.23.0');
    expect(body).toContain('빌드: src-a1b2c3d4e5f6');
    expect(body).toContain('화면: 설정');
    expect(body).toContain('네트워크: 온라인');
    expect(buildBugReportSubject(facts)).toBe('[카이렌 명함] 버그 리포트 · 2.23.0 · src-a1b2c3d4e5f6');
  });

  it('offline is reported as offline, not as a missing value', () => {
    const body = buildBugReportBody(collectBugReportFacts({ ...SAFE_INPUT, online: false }));
    expect(body).toContain('네트워크: 오프라인');
  });

  // ── 인코딩 ──
  //
  // `encodeURI`로 만들면 `&`·`#`·`+`가 살아남아 본문이 다음 파라미터로 잘리거나 공백이 `+`로
  // 바뀐다. 한글 본문에서는 화면에 티가 나지 않은 채 깨진다.
  it('percent-encodes the whole body so it survives a mail client round trip', () => {
    const facts = collectBugReportFacts({ ...SAFE_INPUT, tab: '진행 & 검색 #1 + 설정' });
    const mailto = bugReportMailto(facts);

    expect(mailto.startsWith(`mailto:${BUG_REPORT_ADDRESS}?subject=`)).toBe(true);
    // 인코딩된 주소에는 구조를 깨는 글자가 남아 있으면 안 된다.
    const query = mailto.slice(mailto.indexOf('?') + 1);
    expect(query.split('&')).toHaveLength(2);
    expect(query).not.toMatch(/[\s"<>[\]{}|\\^`]/);
    expect(query).not.toContain('#');

    // 디코딩하면 원문 그대로여야 한다 — 줄바꿈과 한글까지.
    expect(bodyParamOf(mailto)).toBe(buildBugReportBody(facts));
    expect(bodyParamOf(mailto)).toContain('화면: 진행 & 검색 #1 + 설정');
    expect(bodyParamOf(mailto)).toContain('\n');
  });

  // ── 길이 상한 ──
  it('keeps the mailto under the client truncation limit and says that it trimmed', () => {
    const facts = collectBugReportFacts({ ...SAFE_INPUT, userAgent: `Mozilla ${'가'.repeat(600)} Safari` });
    const mailto = bugReportMailto(facts);

    expect(mailto.length).toBeLessThanOrEqual(BUG_REPORT_MAX_URL);
    // 잘렸다는 사실을 본문 안에서 읽을 수 있어야 한다. 조용히 잘리면 반쪽 제보가 된다.
    expect(bodyParamOf(mailto)).toContain('(내용이 길어 뒷부분을 줄였어요)');
    // 잘려도 사람이 채울 칸은 남는다 — 앞에서부터 자르면 템플릿이 통째로 사라진다.
    expect(bodyParamOf(mailto)).toContain('■ 무엇을 하려 했나요');
  });

  it('leaves a normal report untouched — the cap only trims what exceeds it', () => {
    const facts = collectBugReportFacts(SAFE_INPUT);
    const mailto = bugReportMailto(facts);
    expect(mailto.length).toBeLessThanOrEqual(BUG_REPORT_MAX_URL);
    // 여유를 남긴다. 한글 한 글자가 인코딩하면 9자라, 상한에 붙어 있으면 안내 문구 한 줄만
    // 늘어도 실제 사용자의 제보가 잘린다 — 그 순간은 화면에서 보이지 않는다.
    expect(mailto.length, '평범한 제보가 이미 상한 가까이 있다 — 진단 문구를 줄여야 한다').toBeLessThan(1_800);
    expect(bodyParamOf(mailto)).not.toContain('줄였어요');
    expect(bodyParamOf(mailto)).toContain('브라우저: Mozilla/5.0');
  });

  // ── 부정 게이트: 자격 정보·사람 정보는 어떤 경로로도 본문에 닿지 않는다 ──
  //
  // 이 게이트가 지키는 것은 "화면이 안전한 값만 넘긴다"가 아니라 **"무엇을 넘겨도 안전하다"** 다.
  // 앞의 계약은 호출 지점이 하나 늘어나는 순간 깨지고, 그 사실은 화면에서 보이지 않는다.
  it('never lets a token, a personal link code, or Person data reach the mail draft', () => {
    const leaky = {
      ...SAFE_INPUT,
      // 앱 상태를 통째로 넘긴 상황을 그대로 재현한다.
      token: 'owner-secret-token-value-9f3a',
      apiUrl: 'https://script.google.com/macros/s/AKfycbxDEPLOYMENTID999/exec',
      capturer: '이강규',
      linkCode: 'k-personal-link-code-77',
      person: { name: '홍길동', organization: '카이렌', phone: '010-1234-5678' },
      briefs: [{ person: '안지윤', memo: '판교 밋업에서 만남' }],
      recentSearches: ['홍길동'],
      localStorage: { cc_token: 'owner-secret-token-value-9f3a', cc_name: '이강규' },
    };

    const facts = collectBugReportFacts(leaky as unknown as Record<string, unknown>);
    const surfaces = [buildBugReportBody(facts), buildBugReportText(facts), bugReportMailto(facts)];
    const forbidden = [
      'owner-secret-token-value-9f3a',
      'AKfycbxDEPLOYMENTID999',
      'k-personal-link-code-77',
      '이강규',
      '홍길동',
      '안지윤',
      '010-1234-5678',
      'cc_token',
      'script.google.com',
      '판교 밋업',
    ];

    for (const surface of surfaces) {
      for (const secret of forbidden) {
        expect(surface, `버그 리포트에 "${secret}" 가 실렸다`).not.toContain(secret);
        expect(surface, `버그 리포트에 "${secret}" 가 인코딩된 채 실렸다`).not.toContain(encodeURIComponent(secret));
      }
    }
    // 허용된 값은 그대로 남아야 한다 — 전부 지워 버리면 제보가 쓸모없어진다.
    expect(surfaces[0]).toContain('버전: 2.23.0');
  });

  it('redacts a credential that arrives inside an allowed field', () => {
    // 허용 목록은 "어떤 칸"만 막는다. 그 칸 안에 섞여 들어온 값은 두 번째 방어선이 지운다.
    const facts = collectBugReportFacts({
      ...SAFE_INPUT,
      tab: '설정 ?k=SECRETLINKCODE123',
      userAgent: 'Mozilla/5.0 token=abcdefghijklmnopqrstuvwxyz',
      viewport: 'AKfycbxLONGOPAQUEDEPLOYMENTIDENTIFIER',
    });
    const body = buildBugReportBody(facts);

    expect(body).not.toContain('SECRETLINKCODE123');
    expect(body).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(body).not.toContain('AKfycbxLONGOPAQUEDEPLOYMENTIDENTIFIER');
    expect(body).toContain('[가려짐]');
  });

  it('does not redact the values a report genuinely needs', () => {
    // 지우는 규칙이 너무 넓으면 버전·빌드·브라우저가 통째로 사라져 제보가 무용지물이 된다.
    expect(redactSecrets('2.23.0')).toBe('2.23.0');
    expect(redactSecrets('src-a1b2c3d4e5f6')).toBe('src-a1b2c3d4e5f6');
    expect(redactSecrets(SAFE_INPUT.userAgent)).toBe(SAFE_INPUT.userAgent);
    expect(redactSecrets('390x844')).toBe('390x844');
    expect(redactSecrets('ko-KR')).toBe('ko-KR');
  });

  it('falls back to a readable placeholder instead of printing undefined', () => {
    const facts = collectBugReportFacts({});
    const body = buildBugReportBody(facts);
    expect(body).not.toContain('undefined');
    expect(body).toContain('버전: 알 수 없음');
    expect(body).toContain('네트워크: 오프라인');
  });

  it('offers the same content as plain text for devices with no mail client', () => {
    const facts = collectBugReportFacts(SAFE_INPUT);
    const text = buildBugReportText(facts);
    expect(text).toContain(`받는 사람: ${BUG_REPORT_ADDRESS}`);
    expect(text).toContain(buildBugReportSubject(facts));
    expect(text).toContain(buildBugReportBody(facts));
  });
});
