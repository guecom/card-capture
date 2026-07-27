// API origin pinning (FI-004) — Kairen-Ref: TSK-000269
//
// 왜 필요한가: `loadRuntimeConfig`는 `?api=` 를 받아 localStorage에 저장하고, 저장된 주소로
// 개인 링크 코드(bearer token)와 명함 이미지를 POST한다. 즉 `?api=https://attacker.example/x`
// 링크를 한 번만 열면 그 뒤의 모든 업로드·목록 요청이 공격자에게 간다. 주소를 사람이
// 눈으로 확인할 방법도 없다(고급 설정 안에 숨어 있다).
//
// 계약: credential은 **빌드에 박힌 신뢰 origin**과 **앱 자신의 origin**으로만 나간다.
// URL, localStorage, 캐시, 서버 응답 어느 것도 이 집합을 넓힐 수 없다.

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

function isReservedTestHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return isDevelopmentHost(host) || RESERVED_TEST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 빌드에 박힌 기본 API. 이 origin이 유일한 production 신뢰 대상이다. */
export function pinnedApiOrigin(defaultApi = __CARD_CAPTURE_DEFAULT_API__): string | null {
  return safeUrl(defaultApi)?.origin ?? null;
}

/**
 * 지금 이 실행에서 credential을 보내도 되는 origin 목록.
 * `pageOrigin`이 개발 호스트일 때만 예약 테스트 이름이 더해진다.
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
  | 'untrusted_origin';

export interface ApiUrlVerdict {
  trusted: boolean;
  /** 신뢰할 수 있을 때 정규화된 주소. 그렇지 않으면 빈 문자열. */
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
  const developmentPage = Boolean(page && isDevelopmentHost(page.hostname));

  // `user:pass@host` 형태는 주소를 눈으로 읽을 수 없게 만드는 고전적인 위장 수단이다.
  if (url.username || url.password) return { trusted: false, url: '', reason: 'embedded_credentials' };

  if (url.protocol !== 'https:' && !(developmentPage && url.protocol === 'http:')) {
    return { trusted: false, url: '', reason: 'scheme' };
  }

  const allowed = trustedApiOrigins(pageOrigin, defaultApi);
  if (allowed.includes(url.origin)) return { trusted: true, url: url.toString() };

  // 로컬 harness에서만: 공개 DNS에 존재할 수 없는 예약 이름을 mock API로 허용한다.
  if (developmentPage && isReservedTestHost(url.hostname)) return { trusted: true, url: url.toString() };

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
};
