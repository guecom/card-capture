import { beforeEach, describe, expect, it } from 'vitest';
import {
  BUG_REPORT_ADDRESS,
  BUG_REPORT_MAX_URL,
  BUG_REPORT_ROUTE_LIMIT,
  buildBugReportBody,
  buildBugReportSubject,
  buildBugReportText,
  bugReportMailto,
  collectBugReportFacts,
  formatResearchRouteReceipts,
  redactSecrets,
} from './bug-report';
import { RESEARCH_ROUTE_R1, resolveResearchRoute } from './research-mode';
import { clearResearchRouteLog, readResearchRouteLog, recordResearchRoute } from './research-telemetry';

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

// ── 조사 라우팅 영수증 (TSK-000560 / INT-000036) ──────────────────────────────
//
// 계약: "requested mode·actual binding/version·degradation reason·failure는 developer route
// receipt와 alert에 남는다." 영수증은 `research-telemetry.ts`가 오래전부터 쌓고 있었는데
// **읽는 사람이 하나도 없었다** — 시험 밖에서 `readResearchRouteLog`를 부르는 곳이 없었다.
// 이제 이미 있는 개발자 통로(버그 리포트)가 그것을 나른다.
describe('bug report — 조사 라우팅 영수증', () => {
  const facts = collectBugReportFacts(SAFE_INPUT);
  const at = (seconds: number) => new Date(Date.UTC(2026, 7, 4, 12, 30, seconds));

  beforeEach(() => { clearResearchRouteLog(); });

  it('열거된 칸이 전부 실린다 — 요청한 깊이·실제 자리·설정 판·내려감·사유', () => {
    const route = resolveResearchRoute('deep', RESEARCH_ROUTE_R1, (binding) => binding !== 'sol');
    recordResearchRoute(route, { requestId: 'rr-abc1234567', now: at(1) });

    const body = buildBugReportBody(facts);
    const line = body.split('\n').find((row) => row.includes('12:30:01'));
    expect(line, '영수증 줄이 본문에 없다').toBeTruthy();
    // 사용자가 고른 깊이와 실제로 쓰인 자리가 **둘 다** 보여야 "왜 얕게 나왔지"를 되짚을 수 있다.
    expect(line).toContain('deep>deep');
    expect(line, 'binding이 없다 — 개발자가 되짚을 값이 사라졌다').toContain('bind=terra');
    expect(line, '설정 판이 없다').toContain('r1');
    expect(line).toContain('deg=1');
    expect(line, '요청을 이어 볼 열쇠가 없다').toContain('rr-abc1234567');
    expect(line).toContain('binding_unavailable');
  });

  it('어디로도 못 간 요청은 그 사실을 말한다 — 빈칸으로 남기지 않는다', () => {
    recordResearchRoute(resolveResearchRoute('deep', RESEARCH_ROUTE_R1, () => false), { requestId: 'rr-none000000', now: at(2) });
    const body = buildBugReportBody(facts);
    expect(body).toContain('bind=none');
    expect(body).toContain('no_binding');
  });

  it('실패도 남는다 — 접수 실패가 라우팅 기록과 이어져야 되짚을 수 있다', () => {
    recordResearchRoute(resolveResearchRoute('deep'), { event: 'failed', reason: 'deep_feature_disabled', requestId: 'rr-fail000000', now: at(3) });
    expect(buildBugReportBody(facts)).toContain('fail');
    expect(buildBugReportBody(facts)).toContain('deep_feature_disabled');
  });

  it('기록이 없으면 구획 자체가 없다 — 빈 제목은 소음이다', () => {
    expect(readResearchRouteLog()).toHaveLength(0);
    expect(buildBugReportBody(facts)).not.toContain('조사 라우팅');
    expect(formatResearchRouteReceipts([])).toEqual([]);
  });

  it('최근 것만 싣는다 — 한 세션의 기록 전부가 메일 본문을 삼키지 않는다', () => {
    for (let index = 0; index < BUG_REPORT_ROUTE_LIMIT + 4; index += 1) {
      recordResearchRoute(resolveResearchRoute('quick'), { requestId: `rr-x${String(index).padStart(9, '0')}`, now: at(index) });
    }
    const lines = formatResearchRouteReceipts(readResearchRouteLog());
    // 제목 한 줄 + 영수증 상한
    expect(lines).toHaveLength(BUG_REPORT_ROUTE_LIMIT + 1);
  });

  it('부르는 쪽이 아무것도 안 넘겨도 살아 있는 기록이 붙는다', () => {
    // 기본값이 아니라 호출부에서 넘기게 하면, 그 호출부가 값을 빠뜨리는 날 영수증이 조용히 사라진다.
    recordResearchRoute(resolveResearchRoute('standard'), { requestId: 'rr-live000000', now: at(4) });
    expect(buildBugReportBody(facts)).toContain('12:30:04');
    expect(buildBugReportText(facts)).toContain('12:30:04');
  });

  // ── 부정 게이트: 개발자 값은 실리되 사용자의 글은 어떤 경로로도 못 온다 ──
  it('사용자가 적은 글·사람 이름은 영수증 경로로 들어올 수 없다', () => {
    recordResearchRoute(resolveResearchRoute('deep'), { requestId: 'rr-safe000000', now: at(5), reason: '홍길동 대표의 최근 인터뷰를 확인해줘' });
    const body = buildBugReportBody(facts);
    // `reason`은 유일한 자유 텍스트 자리이고 `redactReason`이 코드 모양만 통과시킨다.
    expect(body).not.toContain('홍길동');
    expect(body).not.toContain('인터뷰');
    // 영수증에는 조사 지시문·이름·메모를 담는 칸 자체가 없다.
    expect(Object.keys(readResearchRouteLog()[0]).sort())
      .toEqual(['binding', 'degraded', 'depth', 'event', 'reason', 'requestId', 'requestedDepth', 'routeVersion', 'ts']);
  });

  it('영수증이 붙어도 자격 정보·사람 정보 게이트가 그대로 산다', () => {
    recordResearchRoute(resolveResearchRoute('deep'), { requestId: 'rr-abc1234567', now: at(6) });
    const leaky = collectBugReportFacts({
      ...SAFE_INPUT,
      token: 'owner-secret-token-value-9f3a',
      person: { name: '홍길동' },
    } as unknown as Record<string, unknown>);
    for (const surface of [buildBugReportBody(leaky), buildBugReportText(leaky), bugReportMailto(leaky)]) {
      expect(surface).not.toContain('owner-secret-token-value-9f3a');
      expect(surface).not.toContain('홍길동');
    }
  });

  it('메일 상한에서는 영수증이 먼저 양보한다 — 사람이 채울 칸을 잘라 내지 않는다', () => {
    for (let index = 0; index < BUG_REPORT_ROUTE_LIMIT; index += 1) {
      recordResearchRoute(resolveResearchRoute('deep', RESEARCH_ROUTE_R1, (binding) => binding !== 'sol'), { requestId: `rr-y${String(index).padStart(9, '0')}`, now: at(index) });
    }
    const mailto = bugReportMailto(facts);
    expect(mailto.length).toBeLessThanOrEqual(BUG_REPORT_MAX_URL);
    // 제보 템플릿과 사람이 통화로 말하는 값은 무슨 일이 있어도 남는다.
    expect(bodyParamOf(mailto)).toContain('■ 무엇을 하려 했나요');
    expect(bodyParamOf(mailto)).toContain('버전: 2.23.0');
    // 상한이 없는 복사 경로에는 전부 간다 — 메일에서 잘려도 되짚을 길이 하나는 남는다.
    expect(buildBugReportText(facts)).toContain('bind=terra');
  });
});
