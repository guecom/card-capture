// 버그 리포트 메일 초안 (ISS-000217 · DEC-000093 — Kairen-Ref: TSK-000532)
//
// founder: "그러고 버그 리포트 기능도 있으면 좋겠어."
//
// 계약 세 줄:
//  1. **이 모듈은 아무것도 보내지 않는다.** 만드는 것은 `mailto:` 주소 문자열과 같은 내용의
//     평문뿐이고, 실제 발송은 사람이 자기 메일 앱에서 누른다. 자동 전송 경로를 만들지 않는다.
//  2. **진단값은 허용 목록으로만 들어온다.** 호출자가 실수로 앱 상태 전체를 넘겨도
//     `collectBugReportFacts`가 아래 `ALLOWED_FACTS`에 없는 키를 전부 버린다.
//     개인 링크 코드·연결 주소·사람 정보는 여기에 이름이 없으므로 본문에 닿을 길이 없다.
//  3. **허용된 칸 안에 섞여 들어온 비밀도 지운다.** 허용 목록은 "어떤 칸"만 막고 "그 칸에 담긴
//     값"은 막지 못한다. `redactSecrets`가 `k=…` 같은 자격 파라미터와 긴 불투명 문자열을 지운다.
//
// 왜 `mailto:`인가: 앱이 서버로 보내면 사용자가 무엇이 나갔는지 볼 수 없고, 보내기 전에 지울 수도
// 없다. 메일 초안은 사람이 내용을 전부 읽고 고친 뒤 자기 이름으로 보낸다 — 통제권이 사람에게 남는다.

/** 받는 사람. 제품 안에서 이 주소를 쓰는 자리는 여기 하나다. */
export const BUG_REPORT_ADDRESS = 'guecom90@gmail.com';

/**
 * `mailto:` 전체 길이 상한.
 *
 * 메일 클라이언트·OS 핸들러마다 상한이 다르고(안드로이드 Intent, iOS Mail, Windows 기본 앱),
 * 넘으면 조용히 잘리거나 아예 열리지 않는다. 잘린 초안은 사용자가 알아채지 못한 채 반쪽짜리
 * 제보를 보내게 만들므로, 여기서 먼저 줄이고 **줄였다는 사실을 본문에 적는다.**
 */
export const BUG_REPORT_MAX_URL = 1_900;

/**
 * 본문 뒤에 붙는 진단 구획의 머리. 사람이 지우지 않도록 무엇인지 밝힌다.
 *
 * 짧게 쓴다. 한글 한 글자는 인코딩하면 9자가 되므로, 여기서 한 줄 늘리는 것이 상한에서
 * 가장 비싼 선택이다 — 설명이 길어져 사람이 채울 칸이 잘리면 본말이 전도된다.
 */
const DIAGNOSTICS_HEADING = '────────\n아래는 진단 정보예요. 이름·연락처·개인 링크 코드는 담기지 않습니다.';

const TRUNCATION_MARK = '\n\n(내용이 길어 뒷부분을 줄였어요)';

export interface BugReportFacts {
  /** 릴리즈 이름. 사람이 통화로 말하는 값. */
  version: string;
  /** 소스 식별자. 저장소에서 다시 계산해 대조하는 값. */
  buildId: string;
  /** 지금 보고 있던 화면 이름 (한국어 탭 이름). */
  tab: string;
  /** 연결 상태 **이름**. 주소도 토큰도 아니다. */
  connection: string;
  /** 알림 상태 이름. */
  notifications: string;
  /** 지금 고른 화면 테마 이름. */
  theme: string;
  online: boolean;
  /** `390x844` 형태. 좁은 폭에서만 나는 결함을 구분하려면 필요하다. */
  viewport: string;
  language: string;
  userAgent: string;
}

/**
 * 본문에 실릴 수 있는 값의 **전부**. 여기에 없는 이름은 어떤 경로로도 메일에 닿지 않는다.
 * 새 항목을 넣으려면 그 값이 개인 정보도 자격 정보도 아니라는 것을 먼저 확인해야 한다.
 */
const ALLOWED_FACTS = [
  'version',
  'buildId',
  'tab',
  'connection',
  'notifications',
  'theme',
  'online',
  'viewport',
  'language',
  'userAgent',
] as const satisfies ReadonlyArray<keyof BugReportFacts>;

/**
 * 자격 정보로 보이는 조각을 지운다.
 *
 * 두 갈래만 본다:
 *  - `k=…`·`token=…` 처럼 **이름이 붙은** 자격 파라미터. 개인 링크가 실제로 쓰는 모양이다.
 *  - 20자 이상 이어지는 불투명 문자열. 토큰·키·세션 식별자가 이 모양이고, 진단으로 넣는
 *    값들(버전 `2.23.0`, 빌드 `src-` + 12자, 사람이 읽는 한국어 상태 이름, 흔한 User-Agent
 *    토막)은 여기에 걸리지 않는다 — 20자는 그 경계를 넘지 않도록 고른 값이다.
 *
 * 이것은 두 번째 방어선이다. 첫 번째는 `collectBugReportFacts`의 허용 목록이고, 그 목록에
 * 자격 정보를 담는 칸이 애초에 없다.
 */
export const REDACTED = '[가려짐]';

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:k|key|token|auth|secret|api|code|session|bearer)\s*[=:]\s*[^\s&,;]+/gi, REDACTED)
    .replace(/[A-Za-z0-9_-]{20,}/g, REDACTED);
}

function factText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'string') return redactSecrets(value).replace(/\s+/g, ' ').trim();
  // 객체·배열은 진단값이 아니다. 사람 정보가 통째로 실려 오는 유일한 모양이므로 버린다.
  return '';
}

/**
 * 임의의 입력에서 **허용된 칸만** 골라 진단값을 만든다.
 *
 * 호출자가 `{ ...config, ...state }`를 통째로 넘겨도 안전해야 한다 — 화면 쪽에서 무엇을
 * 넘겼는지 기억하는 것으로는 이 성질이 유지되지 않는다. 목록에 없는 키는 읽지도 않는다.
 */
export function collectBugReportFacts(input: Record<string, unknown>): BugReportFacts {
  const picked = {} as Record<string, string | boolean>;
  for (const key of ALLOWED_FACTS) {
    picked[key] = key === 'online' ? Boolean(input[key]) : factText(input[key]);
  }
  return {
    version: String(picked.version || '알 수 없음'),
    buildId: String(picked.buildId || '알 수 없음'),
    tab: String(picked.tab || '알 수 없음'),
    connection: String(picked.connection || '알 수 없음'),
    notifications: String(picked.notifications || '알 수 없음'),
    theme: String(picked.theme || '알 수 없음'),
    online: Boolean(picked.online),
    viewport: String(picked.viewport || '알 수 없음'),
    language: String(picked.language || '알 수 없음'),
    userAgent: String(picked.userAgent || '알 수 없음'),
  };
}

export function buildBugReportSubject(facts: BugReportFacts): string {
  return `[카이렌 명함] 버그 리포트 · ${facts.version} · ${facts.buildId}`;
}

/**
 * 사람이 채울 세 칸 + 자동으로 채워지는 진단 구획.
 *
 * 세 칸을 고른 이유: 재현에 필요한 최소 정보가 "무엇을 하려 했는가 / 무슨 일이 일어났는가 /
 * 언제인가"다. 칸을 더 늘리면 아무도 채우지 않고, 줄이면 되묻는 왕복이 한 번 더 생긴다.
 */
export function buildBugReportBody(facts: BugReportFacts): string {
  return [
    '아래 세 칸만 채워 주세요. 나머지는 그대로 두시면 됩니다.',
    '',
    '■ 무엇을 하려 했나요',
    '',
    '',
    '■ 무슨 일이 일어났나요',
    '',
    '',
    '■ 언제 그랬나요',
    '',
    '',
    DIAGNOSTICS_HEADING,
    `버전: ${facts.version}`,
    `빌드: ${facts.buildId}`,
    `화면: ${facts.tab}`,
    `연결: ${facts.connection}`,
    `알림: ${facts.notifications}`,
    `테마: ${facts.theme}`,
    `네트워크: ${facts.online ? '온라인' : '오프라인'}`,
    `화면 크기: ${facts.viewport}`,
    `언어: ${facts.language}`,
    `브라우저: ${facts.userAgent}`,
  ].join('\n');
}

/** 메일 앱이 없거나 열리지 않는 기기에서 그대로 복사해 붙일 수 있는 같은 내용. */
export function buildBugReportText(facts: BugReportFacts): string {
  return `받는 사람: ${BUG_REPORT_ADDRESS}\n제목: ${buildBugReportSubject(facts)}\n\n${buildBugReportBody(facts)}`;
}

/**
 * 메일 앱에 넘길 `mailto:` 주소. **여는 것까지가 전부이고 보내지 않는다.**
 *
 * 제목·본문은 `encodeURIComponent`로 인코딩한다. `encodeURI`로는 `&`·`#`·`+`가 살아남아
 * 본문이 다음 파라미터로 잘리거나 공백으로 바뀐다 — 한글 본문에서는 조용히 깨진다.
 * 길이가 상한을 넘으면 본문 **끝에서부터** 줄이고, 줄였다는 사실을 본문 안에 남긴다.
 */
export function bugReportMailto(facts: BugReportFacts, maxLength = BUG_REPORT_MAX_URL): string {
  const head = `mailto:${BUG_REPORT_ADDRESS}?subject=${encodeURIComponent(buildBugReportSubject(facts))}&body=`;
  const body = buildBugReportBody(facts);
  const whole = head + encodeURIComponent(body);
  if (whole.length <= maxLength) return whole;

  // 인코딩 뒤 길이는 글자마다 다르므로(한글 1자 = 9자) 자를 지점을 이분 탐색으로 찾는다.
  let low = 0;
  let high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((head + encodeURIComponent(body.slice(0, middle) + TRUNCATION_MARK)).length <= maxLength) low = middle;
    else high = middle - 1;
  }
  return head + encodeURIComponent(body.slice(0, low) + TRUNCATION_MARK);
}
