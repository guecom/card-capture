import { afterEach, describe, expect, it, vi } from 'vitest';
import { scrubbedHref, scrubCredentialParams } from './url-credentials';

afterEach(() => vi.unstubAllGlobals());

describe('personal link code scrub (FI-005)', () => {
  it('removes the token and api parameters while keeping the rest', () => {
    expect(scrubbedHref('https://app.example.org/next/?api=https%3A%2F%2Fx&k=owner-token&view=search#brief'))
      .toBe('https://app.example.org/next/?view=search#brief');
  });

  it('drops the question mark when nothing else remains', () => {
    expect(scrubbedHref('https://app.example.org/next/?k=owner-token')).toBe('https://app.example.org/next/');
  });

  it('leaves an address without credentials untouched', () => {
    const href = 'https://app.example.org/next/?view=briefs';
    expect(scrubbedHref(href)).toBe(href);
    expect(scrubbedHref('not a url')).toBe('not a url');
  });

  it('replaces the history entry instead of pushing a new one', () => {
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal('history', { replaceState, pushState, state: { tab: 1 } });
    vi.stubGlobal('location', { href: 'https://app.example.org/next/?k=owner-token&view=search' });

    expect(scrubCredentialParams()).toBe(true);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).toHaveBeenCalledWith({ tab: 1 }, '', 'https://app.example.org/next/?view=search');
  });

  it('reports no change when the address carries no credentials', () => {
    const replaceState = vi.fn();
    vi.stubGlobal('history', { replaceState, state: null });
    vi.stubGlobal('location', { href: 'https://app.example.org/next/' });

    expect(scrubCredentialParams()).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });
});
