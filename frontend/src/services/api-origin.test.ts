import { describe, expect, it } from 'vitest';
import * as apiOriginModule from './api-origin';
/** 게이트가 보는 것은 번들러가 컴파일하는 바로 그 원본이다 (D3-2 하드코딩 주소 검사). */
import apiOriginSource from './api-origin.ts?raw';
import { apiRejectionMessage, canEditApiEndpoint, inspectApiUrl, isTrustedApiUrl, pinnedApiEndpoint, pinnedApiOrigin, trustedApiOrigins } from './api-origin';

const PINNED = pinnedApiOrigin() ?? '';
/** 빌드에 실제로 박힌 배포본 주소. origin이 아니라 **이 주소 전체**가 신뢰의 기준이다. */
const PINNED_ENDPOINT = __CARD_CAPTURE_DEFAULT_API__;
const PAGE = 'https://guecom.github.io';
const DEV_PAGE = 'http://127.0.0.1:4173';

describe('api origin pinning (FI-004)', () => {
  it('pins the trusted set to the build-time API origin and the app origin itself', () => {
    expect(PINNED).toBe('https://script.google.com');
    expect(trustedApiOrigins(PAGE)).toEqual([PINNED, PAGE]);
  });

  // 이전 판(TSK-000269)은 pinned origin 위의 **아무 경로**나 정답으로 굳혔다.
  // 그것이 FI-004가 DELIVERED로 잘못 선언된 이유다 — 기준은 배포본 주소 전체다.
  it('accepts the pinned production API', () => {
    expect(isTrustedApiUrl(PINNED_ENDPOINT, PAGE)).toBe(true);
  });

  it('rejects an attacker origin supplied through the link', () => {
    expect(inspectApiUrl('https://attacker.invalid/exec', PAGE)).toEqual({
      trusted: false,
      url: '',
      reason: 'untrusted_origin',
    });
  });

  it('rejects a lookalike host that only has the pinned origin as a prefix', () => {
    expect(isTrustedApiUrl('https://script.google.com.attacker.example.org/exec', PAGE)).toBe(false);
  });

  it('rejects plain http and embedded credentials on the deployed app', () => {
    expect(inspectApiUrl('http://script.google.com/exec', PAGE).reason).toBe('scheme');
    expect(inspectApiUrl('https://user:secret@script.google.com/exec', PAGE).reason).toBe('embedded_credentials');
  });

  it('rejects anything unparseable instead of guessing', () => {
    expect(inspectApiUrl('not a url', PAGE).reason).toBe('malformed');
    expect(inspectApiUrl('', PAGE).reason).toBe('malformed');
    expect(inspectApiUrl('//attacker.invalid/exec', PAGE).reason).toBe('malformed');
  });

  it('normalises host casing rather than treating it as a different origin', () => {
    expect(isTrustedApiUrl(PINNED_ENDPOINT.replace('script.google.com', 'SCRIPT.GOOGLE.COM'), PAGE)).toBe(true);
  });

  it('never trusts a reserved test name when the app is served from the public origin', () => {
    expect(isTrustedApiUrl('https://api.example.test/exec', PAGE)).toBe(false);
  });

  it('allows reserved test names only while the page itself runs on a development host', () => {
    expect(isTrustedApiUrl('https://api.example.test/exec', DEV_PAGE)).toBe(true);
    expect(isTrustedApiUrl('http://api.example.test/exec', DEV_PAGE)).toBe(true);
    // 개발 호스트에서도 harness 이름이 아닌 origin은 거부한다 — 회귀 게이트가 쓰는 적대적 origin.
    expect(isTrustedApiUrl('https://attacker.example.org/exec', DEV_PAGE)).toBe(false);
    expect(isTrustedApiUrl('https://attacker.invalid/exec', DEV_PAGE)).toBe(false);
    expect(isTrustedApiUrl('https://attacker.example/exec', DEV_PAGE)).toBe(false);
  });

  it('trusts an API served from the same origin as the app', () => {
    expect(isTrustedApiUrl(`${PAGE}/api/exec`, PAGE)).toBe(true);
  });
});

// FI-004 재검증 — Kairen-Ref: TSK-000285
//
// origin 일치는 신뢰의 **필요조건일 뿐 충분조건이 아니다**. 빌드에 박힌 API는
// `https://script.google.com/macros/s/<우리 배포 ID>/exec` 인데, Apps Script 웹앱은
// 누구나 같은 origin `script.google.com` 에 배포할 수 있다. origin만 비교하면
// `?api=https://script.google.com/macros/s/<공격자 배포 ID>/exec` 가 그대로 통과해
// 저장된 개인 링크 코드가 공격자 배포본으로 나간다.
describe('api endpoint pinning on a multi-tenant host (FI-004 재검증)', () => {
  // 우리 배포본과 같은 origin, 다른 배포 ID. 존재하지 않는 명백한 가짜 값이다.
  const OTHER_DEPLOYMENT = 'https://script.google.com/macros/s/AKfycb-not-our-deployment-000/exec';

  it('still trusts the exact pinned deployment', () => {
    expect(inspectApiUrl(PINNED_ENDPOINT, PAGE)).toEqual({ trusted: true, url: PINNED_ENDPOINT });
  });

  it('rejects another Apps Script deployment served from the same pinned origin', () => {
    expect(inspectApiUrl(OTHER_DEPLOYMENT, PAGE).trusted).toBe(false);
  });

  it('rejects a near miss on the pinned path', () => {
    expect(isTrustedApiUrl(`${PINNED_ENDPOINT}/`, PAGE)).toBe(false);
    expect(isTrustedApiUrl(PINNED_ENDPOINT.replace(/\/exec$/, '/dev'), PAGE)).toBe(false);
    expect(isTrustedApiUrl(`${PINNED}/exec`, PAGE)).toBe(false);
  });

  it('rejects a path that only walks back out of the pinned deployment', () => {
    expect(isTrustedApiUrl(`${PINNED_ENDPOINT}/../../AKfycb-not-our-deployment-000/exec`, PAGE)).toBe(false);
  });

  it('names the same-origin rejection so the app can say why it was ignored', () => {
    expect(inspectApiUrl(OTHER_DEPLOYMENT, PAGE).reason).toBe('untrusted_endpoint');
    expect(apiRejectionMessage.untrusted_endpoint).toContain('개인 링크 코드는 보내지 않았습니다');
  });

  it('drops the query string and fragment from every address it adopts', () => {
    // `?api=<우리 배포본>?k=TOKEN` 은 자격 정보를 `cc_api` 값 안에 실어 나른다.
    expect(inspectApiUrl(`${PINNED_ENDPOINT}?k=stolen-token`, PAGE).url).toBe(PINNED_ENDPOINT);
    expect(inspectApiUrl(`${PINNED_ENDPOINT}?k=stolen-token#k=stolen-token`, PAGE).url).toBe(PINNED_ENDPOINT);
    expect(inspectApiUrl(`${PAGE}/api/exec?k=stolen-token`, PAGE).url).toBe(`${PAGE}/api/exec`);
  });

  it('keeps the pinned deployment reachable from a development host, but nothing beside it', () => {
    expect(isTrustedApiUrl(PINNED_ENDPOINT, DEV_PAGE)).toBe(true);
    expect(isTrustedApiUrl(OTHER_DEPLOYMENT, DEV_PAGE)).toBe(false);
  });
});

// D3-2 — 신뢰 endpoint는 **정확히 하나**다. Kairen-Ref: TSK-000302
//
// 긴급 전환용 두 번째 pinned endpoint를 두지 않기로 한 결정을 게이트로 고정한다.
// 두 번째 주소가 생기는 순간 "credential은 이 배포본 하나로만 나간다"는 문장이 거짓이 되고,
// 그 두 번째 주소는 심사받지 않은 채 빌드에 남는다. 근거는 `api-origin.ts` 계약 주석에 있다.
describe('exactly one pinned endpoint (D3-2)', () => {
  it('exposes one scalar address, never a list', () => {
    const endpoint = pinnedApiEndpoint();
    expect(Array.isArray(endpoint)).toBe(false);
    expect(typeof endpoint).toBe('string');
    expect(endpoint).toBe(PINNED_ENDPOINT);
  });

  // 두 번째 주소는 보통 새 export(`pinnedApiEndpoints`·`fallbackApiEndpoint`)로 들어온다.
  // 표면 자체를 고정해 두면 그런 통로가 조용히 생기지 않는다. 새 export가 정당하면
  // 이 목록을 **의도적으로** 고치게 만드는 것이 이 게이트의 목적이다.
  it('keeps the module surface closed so a second address cannot be slipped in', () => {
    expect(Object.keys(apiOriginModule).sort()).toEqual([
      'apiRejectionMessage',
      'canEditApiEndpoint',
      'inspectApiUrl',
      'isTrustedApiUrl',
      'pinnedApiEndpoint',
      'pinnedApiOrigin',
      'trustedApiOrigins',
    ]);
  });

  // 두 번째 주소가 새 export 없이 **모듈 안에만** 하드코딩되면 위 두 게이트를 빠져나간다.
  // 그 값을 모르는 채로도 잡을 수 있는 유일한 방법은 "주소 리터럴이 아예 없다"를 고정하는 것이다.
  // 신뢰 주소의 출처는 빌드 상수 `__CARD_CAPTURE_DEFAULT_API__` 단 하나여야 한다.
  it('hardcodes no address of its own — the one build-time constant is the only source', () => {
    // 주석에는 공격 예시 주소가 들어 있다. 판정에 쓰이는 것은 코드뿐이므로 주석을 걷어내고 본다.
    const code = apiOriginSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

    expect(code, '주소 리터럴이 코드에 직접 박혔다 — 두 번째 endpoint일 수 있다').not.toMatch(/https?:\/\//);
    expect([...new Set(code.match(/__CARD_CAPTURE_[A-Z_]+__/g) ?? [])]).toEqual(['__CARD_CAPTURE_DEFAULT_API__']);
  });

  // 가장 강한 형태: 빌드에 박힌 주소를 옮기면 신뢰 주소도 **통째로** 따라 옮겨간다.
  // 어딘가에 하드코딩된 비상용 주소가 하나라도 남아 있으면 옛 주소가 계속 통과해 여기서 깨진다.
  it('moves the single trusted address with the build-time constant, leaving nothing behind', () => {
    const moved = 'https://script.google.com/macros/s/AKfycb-moved-deployment-001/exec';
    expect(pinnedApiEndpoint(moved)).toBe(moved);
    expect(isTrustedApiUrl(moved, PAGE, moved)).toBe(true);
    expect(isTrustedApiUrl(PINNED_ENDPOINT, PAGE, moved)).toBe(false);
    // 개발 호스트에서도 예외는 없다 — 옛 주소가 개발 경로로 되살아나면 그것도 두 번째 endpoint다.
    expect(isTrustedApiUrl(PINNED_ENDPOINT, DEV_PAGE, moved)).toBe(false);
  });
});

// D3-1 — 고급 설정의 주소 입력은 개발 호스트에서만 편집 가능하다. Kairen-Ref: TSK-000302
//
// 배포본에서는 무엇을 넣어도 거부되므로 편집 가능한 입력 칸은 **거짓 선택지**다.
// 판정 기준은 이미 있는 개발 호스트 판정 하나뿐이다 — 새 기준을 만들면 두 기준이 갈라진다.
describe('who may edit the pinned address (D3-1)', () => {
  it('allows editing only while the page itself runs on a development host', () => {
    expect(canEditApiEndpoint('http://localhost:4173')).toBe(true);
    expect(canEditApiEndpoint(DEV_PAGE)).toBe(true);
    expect(canEditApiEndpoint('http://[::1]:4173')).toBe(true);
    expect(canEditApiEndpoint('https://LOCALHOST:4173')).toBe(true);
    expect(canEditApiEndpoint(PAGE)).toBe(false);
    // `.localhost` 하위 이름은 mock API로는 허용되지만 **개발 호스트는 아니다**.
    expect(canEditApiEndpoint('http://app.localhost:4173')).toBe(false);
    expect(canEditApiEndpoint('https://attacker.invalid')).toBe(false);
  });

  it('fails closed when the page origin is missing or unreadable', () => {
    expect(canEditApiEndpoint('')).toBe(false);
    expect(canEditApiEndpoint('not a url')).toBe(false);
  });

  // 편집 허용 여부와 주소 판정이 **같은 호스트 집합**에서 나오는지 확인한다.
  // 별도 기준을 새로 만들면 둘이 갈라지고, 그 순간 이 게이트가 깨진다.
  it('reuses the same development-host judgment the address verdict uses', () => {
    const pages = ['http://localhost:4173', DEV_PAGE, 'http://[::1]:4173', PAGE, 'http://app.localhost:4173'];
    for (const pageOrigin of pages) {
      expect(isTrustedApiUrl('https://api.example.test/exec', pageOrigin)).toBe(canEditApiEndpoint(pageOrigin));
    }
  });
});
