import { describe, expect, it } from 'vitest';
import { inspectApiUrl, isTrustedApiUrl, pinnedApiOrigin, trustedApiOrigins } from './api-origin';

const PINNED = pinnedApiOrigin() ?? '';
const PAGE = 'https://guecom.github.io';
const DEV_PAGE = 'http://127.0.0.1:4173';

describe('api origin pinning (FI-004)', () => {
  it('pins the trusted set to the build-time API origin and the app origin itself', () => {
    expect(PINNED).toBe('https://script.google.com');
    expect(trustedApiOrigins(PAGE)).toEqual([PINNED, PAGE]);
  });

  it('accepts the pinned production API', () => {
    expect(isTrustedApiUrl(`${PINNED}/macros/s/deployment/exec`, PAGE)).toBe(true);
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
    expect(isTrustedApiUrl('https://SCRIPT.GOOGLE.COM/exec', PAGE)).toBe(true);
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
