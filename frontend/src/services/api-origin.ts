// API endpoint pinning (FI-004) — Kairen-Ref: TSK-000269, 재검증 TSK-000285
//
// 왜 필요한가: `loadRuntimeConfig`는 `?api=` 를 받아 localStorage에 저장하고, 저장된 주소로
// 개인 링크 코드(bearer token)와 명함 이미지를 POST한다. 즉 `?api=https://attacker.example/x`
// 링크를 한 번만 열면 그 뒤의 모든 업로드·목록 요청이 공격자에게 간다. 주소를 사람이
// 눈으로 확인할 방법도 없다(고급 설정 안에 숨어 있다).
//
// **origin 비교만으로는 부족하다.** 빌드에 박힌 API는 Apps Script 웹앱이고,
// `script.google.com`은 누구나 자기 웹앱을 배포할 수 있는 multi-tenant 호스트다.
// origin만 맞추면 `?api=https://script.google.com/macros/s/<공격자 배포 ID>/exec` 가
// 통과해 저장된 개인 링크 코드가 그대로 공격자 배포본으로 나간다. 그래서 신뢰 판정은
// origin이 아니라 **origin + pathname(= 배포본 주소 전체)** 을 기준으로 한다.
//
// 계약:
//  - credential은 **빌드에 박힌 배포본 주소 그 자체**와 **앱 자신의 origin**으로만 나간다.
//  - pinned origin 위에서는 정확히 pinned 배포본만 통과한다 — 다른 경로는 전부 거부다.
//  - 채택한 주소에서는 query와 fragment를 버린다. 저장되는 주소에 자격 정보가 섞일 자리를 없앤다.
//  - URL, localStorage, 캐시, 서버 응답 어느 것도 이 집합을 넓힐 수 없다.
//
// **신뢰 endpoint는 정확히 하나다. 두 번째 pinned endpoint를 만들지 않는다.**
// (founder 결정 — Kairen-Ref: TSK-000302)
//
// 배포본을 급히 갈아탈 수 있게 "긴급 전환용 두 번째 주소"를 넣자는 요구가 반복해서 나온다.
// 받지 않는 이유:
//  - 두 번째 주소가 있는 순간 위 계약 첫 줄이 거짓이 된다. credential이 나갈 수 있는 곳이 둘이 되고,
//    둘 중 어느 쪽이 지금 쓰이는지는 런타임 상태로 결정된다 — 즉 공격자가 고를 수 있는 값이 하나 늘어난다.
//  - 비상용 주소는 평소에 아무도 보지 않으므로 회수·폐기 시점이 없다. 죽은 주소가 빌드에 남아
//    도메인이 다른 손에 넘어갈 때까지 유효한 신뢰 근거로 남는다.
//  - 배포본 교체는 이미 빌드 한 번으로 끝난다(`config/public-runtime.json` → `vite.config.ts`).
//    긴급 전환의 실제 비용은 코드가 아니라 배포 승인이고, 두 번째 주소는 그 승인을 우회하는 통로가 된다.
// 이 결정은 `api-origin.test.ts`의 "exactly one pinned endpoint (D3-2)" 게이트가 강제한다.
// 다시 열려면 그 게이트를 **의도적으로** 고쳐야 한다.
//
// **고급 설정의 주소 입력은 개발 호스트에서만 편집 가능하다** (`canEditApiEndpoint`).
// 배포본에서는 무엇을 넣어도 위 판정이 거부하므로, 편집 가능한 입력 칸은 사용자에게
// 거짓 선택지를 보여 주는 것이다. 화면은 잠그되 판정은 그대로 둔다 — 화면은 방어선이 아니다.

/** 개발 harness(로컬에서 띄운 정적 서버)에서만 추가 origin을 허용한다. */
const DEVELOPMENT_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * 로컬 개발 harness가 mock API에 쓰는 예약 이름만 허용한다 (RFC 6761 `.test`, RFC 8375 `.localhost`).
 * 개발 호스트에서 실행 중일 때만 의미가 있고, 배포본에서는 절대 열리지 않는다.
 * `.invalid`·`.example`은 일부러 빼 뒀다 — 회귀 게이트가 "적대적 origin" 역할로 쓴다.
 */
const RESERVED_TEST_SUFFIXES = ['.test', '.localhost'];

function safeUrl(value: string): URL | null {
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function isDevelopmentHost(hostname: string): boolean {
  return DEVELOPMENT_HOSTS.has(hostname.toLowerCase());
}

/**
 * 앱 자신이 개발 harness에서 서비스되고 있는가. 주소를 읽을 수 없으면 배포본으로 본다(fail-closed).
 * 개발 harness 여부를 묻는 곳은 전부 이 함수를 통과한다 — 판정 기준이 두 벌이 되면 갈라진다.
 */
function isDevelopmentPage(pageOrigin: string): boolean {
  const page = safeUrl(pageOrigin);
  return Boolean(page && isDevelopmentHost(page.hostname));
}

/**
 * 고급 설정의 연결 주소를 사람이 편집할 수 있는가 (founder 결정 — Kairen-Ref: TSK-000302).
 *
 * 배포본에서는 어떤 값을 넣어도 `inspectApiUrl`이 거부하므로 편집 가능한 칸은 거짓 선택지다.
 * 개발 harness에서는 mock API를 붙여야 하므로 계속 편집할 수 있어야 한다.
 * **판정 기준은 위 개발 호스트 판정 하나뿐이다.** 이 함수는 화면 표시를 위한 것이고,
 * 실제 방어는 `inspectApiUrl`/`saveRuntimeConfig`가 한다 — 잠긴 칸은 방어선이 아니다.
 */
export function canEditApiEndpoint(pageOrigin = globalThis.location?.origin ?? ''): boolean {
  return isDevelopmentPage(pageOrigin);
}

function isReservedTestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isDevelopmentHost(host) || RESERVED_TEST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 주소에서 자격 정보가 섞일 수 있는 부분(query·fragment)을 버린 형태. */
function endpointOf(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

/** 빌드에 박힌 기본 API의 origin. 이 origin은 multi-tenant이므로 그 자체로는 신뢰 근거가 아니다. */
export function pinnedApiOrigin(defaultApi = __CARD_CAPTURE_DEFAULT_API__): string | null {
  return safeUrl(defaultApi)?.origin ?? null;
}

/**
 * 빌드에 박힌 기본 API의 **배포본 주소 전체**(origin + pathname).
 * production 신뢰 판정의 기준은 origin이 아니라 이 값이다.
 */
export function pinnedApiEndpoint(defaultApi = __CARD_CAPTURE_DEFAULT_API__): string | null {
  const url = safeUrl(defaultApi);
  return url ? endpointOf(url) : null;
}

/**
 * 지금 이 실행에서 credential이 나갈 수 있는 origin 목록.
 *
 * **origin 일치는 필요조건일 뿐 충분조건이 아니다.** pinned origin 위에서는 경로까지
 * 정확히 맞아야 통과한다 (`inspectApiUrl` 참조). 이 함수는 "어느 서버까지 이야기가 되는가"를
 * 사람이 읽고 게이트가 고정하기 위한 목록이며, 단독 판정에 쓰지 않는다.
 */
export function trustedApiOrigins(
  pageOrigin = globalThis.location?.origin ?? '',
  defaultApi = __CARD_CAPTURE_DEFAULT_API__,
): string[] {
  const origins: string[] = [];
  const pinned = pinnedApiOrigin(defaultApi);
  if (pinned) origins.push(pinned);
  const page = safeUrl(pageOrigin);
  // 같은 origin에서 서비스되는 API는 앱 자신과 같은 신뢰 수준이다.
  if (page && !origins.includes(page.origin)) origins.push(page.origin);
  return origins;
}

export type ApiUrlRejection =
  | 'malformed'
  | 'scheme'
  | 'embedded_credentials'
  | 'untrusted_origin'
  /** 서버(origin)는 맞지만 우리 배포본이 아닌 주소. multi-tenant 호스트에서만 생긴다. */
  | 'untrusted_endpoint';

export interface ApiUrlVerdict {
  trusted: boolean;
  /** 신뢰할 수 있을 때 정규화된 주소(origin + pathname). 그렇지 않으면 빈 문자열. */
  url: string;
  reason?: ApiUrlRejection;
}

/**
 * 주소 하나를 판정한다. 실패는 항상 fail-closed — 애매하면 거부한다.
 * `pageOrigin`은 앱이 실제로 서비스되는 origin이며, 개발 호스트 판정에 쓰인다.
 */
export function inspectApiUrl(
  candidate: string,
  pageOrigin = globalThis.location?.origin ?? '',
  defaultApi = __CARD_CAPTURE_DEFAULT_API__,
): ApiUrlVerdict {
  const url = safeUrl(candidate);
  if (!url) return { trusted: false, url: '', reason: 'malformed' };

  const page = safeUrl(pageOrigin);
  const developmentPage = isDevelopmentPage(pageOrigin);

  // `user:pass@host` 형태는 주소를 눈으로 읽을 수 없게 만드는 고전적인 위장 수단이다.
  if (url.username || url.password) return { trusted: false, url: '', reason: 'embedded_credentials' };

  if (url.protocol !== 'https:' && !(developmentPage && url.protocol === 'http:')) {
    return { trusted: false, url: '', reason: 'scheme' };
  }

  // 채택하는 주소에서는 query·fragment를 버린다. `?api=<우리 배포본>?k=TOKEN` 처럼
  // 자격 정보를 주소에 실어 보내도 저장되는 값에는 남지 않는다.
  // `buildListUrl` 등은 어차피 파라미터를 새로 세팅하므로 기능에는 영향이 없다.
  const endpoint = endpointOf(url);
  const pinnedOrigin = pinnedApiOrigin(defaultApi);

  // pinned origin(= Apps Script)은 multi-tenant다. 여기서는 **정확히 우리 배포본만** 통과한다.
  // 이 규칙이 먼저다 — 앱이 언젠가 같은 호스트에서 서비스되더라도 경로 판정이 느슨해지지 않는다.
  if (pinnedOrigin && url.origin === pinnedOrigin) {
    return endpoint === pinnedApiEndpoint(defaultApi)
      ? { trusted: true, url: endpoint }
      : { trusted: false, url: '', reason: 'untrusted_endpoint' };
  }

  // 앱 자신의 origin은 경로를 따지지 않는다. 같은 origin에 무언가를 올릴 수 있는 주체는
  // 이미 같은 localStorage(= 저장된 개인 링크 코드)를 읽을 수 있으므로, 경로를 좁혀도
  // 새로 막히는 것이 없다. 그 신뢰는 앱을 어디에 배포하느냐로 결정된다.
  if (page && url.origin === page.origin) return { trusted: true, url: endpoint };

  // 로컬 harness에서만: 공개 DNS에 존재할 수 없는 예약 이름을 mock API로 허용한다.
  if (developmentPage && isReservedTestHost(url.hostname)) return { trusted: true, url: endpoint };

  return { trusted: false, url: '', reason: 'untrusted_origin' };
}

export function isTrustedApiUrl(
  candidate: string,
  pageOrigin = globalThis.location?.origin ?? '',
  defaultApi = __CARD_CAPTURE_DEFAULT_API__,
): boolean {
  return inspectApiUrl(candidate, pageOrigin, defaultApi).trusted;
}

export const apiRejectionMessage: Record<ApiUrlRejection, string> = {
  malformed: '연결 주소 형식이 올바르지 않아 무시했어요.',
  scheme: '보안 연결(https)이 아닌 주소라 무시했어요.',
  embedded_credentials: '주소 안에 계정 정보가 섞여 있어 무시했어요.',
  untrusted_origin: '허용되지 않은 서버 주소라 무시했어요. 개인 링크 코드는 보내지 않았습니다.',
  untrusted_endpoint: '같은 서버라도 이 앱이 쓰는 주소가 아니라 무시했어요. 개인 링크 코드는 보내지 않았습니다.',
};
