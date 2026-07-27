import { describe, expect, it } from 'vitest';
import { apiRejectionMessage, inspectApiUrl, isTrustedApiUrl, pinnedApiOrigin, trustedApiOrigins } from './api-origin';

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
