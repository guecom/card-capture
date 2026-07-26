import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadCachedBriefs, loadRecentSearches, loadRuntimeConfig, loadStickyCaptureContext, saveCachedBriefs, saveRecentSearch, saveRuntimeConfig, saveStickyCaptureContext } from './storage';

describe('legacy-compatible runtime config', () => {
  const values = new Map<string, string>();

  beforeEach(() => {
    values.clear();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
  });

  it('accepts the legacy api and token link parameters and persists them', () => {
    const config = loadRuntimeConfig('?api=https%3A%2F%2Fapi.example%2Fexec&k=owner-token');

    expect(config).toMatchObject({ apiUrl: 'https://api.example/exec', token: 'owner-token' });
    expect(values.get('cc_api')).toBe('https://api.example/exec');
    expect(values.get('cc_token')).toBe('owner-token');
  });

  it('keeps the same cc_ storage keys used by the legacy app', () => {
    saveRuntimeConfig({ apiUrl: ' https://api.example/exec ', token: ' owner-token ', capturer: ' Kang ' });

    expect(values).toMatchObject(new Map([
      ['cc_api', 'https://api.example/exec'],
      ['cc_token', 'owner-token'],
      ['cc_name', 'Kang'],
    ]));
  });

  it('keeps event, relationship and research context for two hours, then expires it', () => {
    saveStickyCaptureContext({ event: 'Expo', relSelf: '첫 만남', relKairen: '잠재 고객', research: '최근 경력 위주' }, 1_000);
    expect(loadStickyCaptureContext(1_000 + 2 * 60 * 60 * 1000)).toEqual({ event: 'Expo', relSelf: '첫 만남', relKairen: '잠재 고객', research: '최근 경력 위주' });
    expect(loadStickyCaptureContext(1_001 + 2 * 60 * 60 * 1000)).toEqual({ event: '', relSelf: '', relKairen: '', research: '' });
  });

  it('preserves the three most recent distinct searches', () => {
    ['Kang', 'Kairen', 'Expo', 'Kang'].forEach(saveRecentSearch);
    expect(loadRecentSearches()).toEqual(['Kang', 'Expo', 'Kairen']);
  });

  it('keeps the last successful brief list for offline recall', () => {
    saveCachedBriefs([{ captureId: 'CAP-1', status: 'processed', brief: '# Alice' }]);
    expect(loadCachedBriefs()).toEqual([{ captureId: 'CAP-1', status: 'processed', brief: '# Alice' }]);
  });
});
