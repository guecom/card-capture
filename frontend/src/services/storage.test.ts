import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANONYMOUS_SUBJECT,
  activeSubject,
  loadCachedBriefs,
  loadOwnerFlags,
  loadRecentSearches,
  loadRuntimeConfig,
  loadRuntimeConfigDetailed,
  loadSectionCollapsed,
  loadStickyCaptureContext,
  saveCachedBriefs,
  saveGalleryFree,
  saveOwnerFlags,
  saveRecentSearch,
  saveRuntimeConfig,
  saveSectionCollapsed,
  saveStickyCaptureContext,
  signOutDevice,
  subjectIdOf,
} from './storage';
import { FakeStorage } from './test-storage';

/**
 * 빌드에 실제로 박힌 배포본 주소. 신뢰 판정의 기준은 origin이 아니라 **이 주소 전체**다 —
 * 이전 판은 `https://script.google.com/macros/s/deployment/exec` 처럼 origin만 같은 가짜 경로를
 * 정답으로 굳혔고, 그것이 FI-004가 잘못 DELIVERED로 선언된 이유다 (재검증 TSK-000285).
 */
const PINNED_API = __CARD_CAPTURE_DEFAULT_API__;
/** 같은 origin, 다른 배포 ID. 존재하지 않는 명백한 가짜 값이다. */
const OTHER_DEPLOYMENT = 'https://script.google.com/macros/s/AKfycb-not-our-deployment-000/exec';
let store: FakeStorage;

beforeEach(() => {
  store = new FakeStorage();
  vi.stubGlobal('localStorage', store);
});

afterEach(() => vi.unstubAllGlobals());

describe('runtime config trusts only the pinned API origin (FI-004)', () => {
  it('accepts the personal link code and the pinned api address', () => {
    const loaded = loadRuntimeConfigDetailed(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`);

    expect(loaded.config).toMatchObject({ apiUrl: PINNED_API, token: 'owner-token' });
    expect(loaded.rejectedApi).toBeUndefined();
    expect(store.getItem('cc_api')).toBe(PINNED_API);
    expect(store.getItem('cc_token')).toBe('owner-token');
  });

  it('ignores an attacker address in the link, never persists it, and says so', () => {
    const loaded = loadRuntimeConfigDetailed('?api=https%3A%2F%2Fattacker.invalid%2Fexec&k=owner-token');

    expect(loaded.config.apiUrl).toBe(__CARD_CAPTURE_DEFAULT_API__);
    expect(loaded.rejectedApi).toEqual({ value: 'https://attacker.invalid/exec', reason: 'untrusted_origin' });
    expect(store.getItem('cc_api')).toBeNull();
  });

  it('drops an untrusted address that an earlier build already persisted', () => {
    store.setItem('cc_api', 'https://attacker.invalid/exec');
    store.setItem('cc_token', 'owner-token');

    const loaded = loadRuntimeConfigDetailed('');

    expect(loaded.config.apiUrl).toBe(__CARD_CAPTURE_DEFAULT_API__);
    expect(loaded.rejectedApi?.reason).toBe('untrusted_origin');
    expect(store.getItem('cc_api')).toBeNull();
  });

  it('refuses an untrusted address typed into advanced settings', () => {
    const saved = saveRuntimeConfig({ apiUrl: 'https://attacker.invalid/exec', token: 'owner-token', capturer: 'Kang' });

    expect(saved.config.apiUrl).toBe(__CARD_CAPTURE_DEFAULT_API__);
    expect(saved.rejectedApi?.reason).toBe('untrusted_origin');
    expect(store.getItem('cc_api')).toBe(__CARD_CAPTURE_DEFAULT_API__);
  });

  it('keeps the legacy cc_ storage keys for the trusted address', () => {
    saveRuntimeConfig({ apiUrl: ` ${PINNED_API} `, token: ' owner-token ', capturer: ' Kang ' });

    expect(store.getItem('cc_api')).toBe(PINNED_API);
    expect(store.getItem('cc_token')).toBe('owner-token');
    expect(store.getItem('cc_name')).toBe('Kang');
  });

  it('reports that the address bar must be scrubbed only when it carried credentials', () => {
    expect(loadRuntimeConfigDetailed('?k=owner-token').scrubUrl).toBe(true);
    expect(loadRuntimeConfigDetailed('?view=search').scrubUrl).toBe(false);
  });
});

// FI-004 / FI-007 재검증 — Kairen-Ref: TSK-000285
//
// 1) `script.google.com` 은 multi-tenant 호스트다. origin만 맞으면 통과시키면 공격자 배포본이
//    저장되고, 그 뒤 저장된 개인 링크 코드가 그쪽으로 나간다.
// 2) 채택한 주소에 query가 남으면 `?api=<우리 배포본>?k=TOKEN` 형태로 자격 정보가
//    `cc_api` 안에 저장되고, `연결 해제`가 `cc_api`를 지우지 않아 그대로 남는다.
describe('the stored API address is a pinned endpoint and never carries a credential', () => {
  it('refuses another deployment on the pinned origin and falls back to the build default', () => {
    const loaded = loadRuntimeConfigDetailed(`?api=${encodeURIComponent(OTHER_DEPLOYMENT)}&k=owner-token`);

    expect(loaded.config.apiUrl).toBe(__CARD_CAPTURE_DEFAULT_API__);
    expect(loaded.rejectedApi).toEqual({ value: OTHER_DEPLOYMENT, reason: 'untrusted_endpoint' });
    expect(store.getItem('cc_api')).toBeNull();
  });

  it('drops a same-origin deployment that an earlier build already persisted', () => {
    store.setItem('cc_api', OTHER_DEPLOYMENT);
    store.setItem('cc_token', 'owner-token');

    const loaded = loadRuntimeConfigDetailed('');

    expect(loaded.config.apiUrl).toBe(__CARD_CAPTURE_DEFAULT_API__);
    expect(loaded.rejectedApi?.reason).toBe('untrusted_endpoint');
    expect(store.getItem('cc_api')).toBeNull();
  });

  it('never persists a link code hidden inside the api parameter', () => {
    const hidden = `${PINNED_API}?k=hidden-token`;
    const loaded = loadRuntimeConfigDetailed(`?api=${encodeURIComponent(hidden)}&k=owner-token`);

    expect(loaded.config.apiUrl).toBe(PINNED_API);
    expect(store.getItem('cc_api')).toBe(PINNED_API);
    expect(JSON.stringify(store.snapshot())).not.toContain('hidden-token');
  });

  it('re-normalises an address an earlier build stored with a credential query', () => {
    store.setItem('cc_api', `${PINNED_API}?k=hidden-token`);

    const loaded = loadRuntimeConfigDetailed('');

    expect(loaded.config.apiUrl).toBe(PINNED_API);
    expect(store.getItem('cc_api')).toBe(PINNED_API);
  });

  it('refuses a hidden link code typed into advanced settings', () => {
    const saved = saveRuntimeConfig({ apiUrl: `${PINNED_API}?k=hidden-token`, token: 'owner-token', capturer: 'Kang' });

    expect(saved.config.apiUrl).toBe(PINNED_API);
    expect(store.getItem('cc_api')).toBe(PINNED_API);
    expect(JSON.stringify(store.snapshot())).not.toContain('hidden-token');
  });

  it('clears the stored address on disconnect and comes back on the build default', () => {
    loadRuntimeConfigDetailed(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`);
    expect(store.getItem('cc_api')).toBe(PINNED_API);

    signOutDevice();

    expect(store.getItem('cc_api')).toBeNull();
    expect(loadRuntimeConfig('')).toEqual({ apiUrl: __CARD_CAPTURE_DEFAULT_API__, token: '', capturer: '' });
  });
});

describe('private state is namespaced per subject (FI-006)', () => {
  const ownerLink = `?api=${encodeURIComponent(PINNED_API)}&k=owner-token`;
  const guestLink = `?api=${encodeURIComponent(PINNED_API)}&k=guest-token`;

  it('derives a stable subject from the api origin and the link code', () => {
    expect(subjectIdOf(PINNED_API, 'owner-token')).toBe(subjectIdOf(PINNED_API, 'owner-token'));
    expect(subjectIdOf(PINNED_API, 'owner-token')).not.toBe(subjectIdOf(PINNED_API, 'guest-token'));
    expect(subjectIdOf(PINNED_API, '')).toBe(ANONYMOUS_SUBJECT);
  });

  it('never shows one link code the cached briefs, owner gate or searches of another', () => {
    loadRuntimeConfig(ownerLink);
    saveCachedBriefs([{ captureId: 'CAP-1', status: 'processed', brief: '# Owner only' }]);
    saveOwnerFlags({ seeAll: true, researchInstructionEnabled: true });
    saveRecentSearch('한화 구매팀장');

    loadRuntimeConfig(guestLink);
    expect(loadCachedBriefs()).toEqual([]);
    expect(loadOwnerFlags()).toEqual({ seeAll: false, researchInstructionEnabled: false });
    expect(loadRecentSearches()).toEqual([]);
  });

  it('renders nothing private before a link code is known', () => {
    loadRuntimeConfig(ownerLink);
    saveCachedBriefs([{ captureId: 'CAP-1', status: 'processed', brief: '# Owner only' }]);

    // 링크 코드가 회수된(또는 아직 받지 못한) 기기에서 다시 여는 상황.
    store.removeItem('cc_token');
    loadRuntimeConfig('');
    expect(activeSubject()).toBe(ANONYMOUS_SUBJECT);
    expect(loadCachedBriefs()).toEqual([]);
    expect(loadOwnerFlags().seeAll).toBe(false);

    // 익명 상태에서는 사적 캐시를 쓰지도 않는다.
    saveCachedBriefs([{ captureId: 'CAP-2', status: 'processed' }]);
    expect(Object.keys(store.snapshot()).some((key) => key.endsWith('_briefs'))).toBe(false);
  });

  it('purges the private cache of a link code that no longer opens the app', () => {
    loadRuntimeConfig(ownerLink);
    saveCachedBriefs([{ captureId: 'CAP-1', status: 'processed', brief: '# Owner only' }]);
    const ownerKey = `cc_${subjectIdOf(PINNED_API, 'owner-token')}_briefs`;
    expect(store.getItem(ownerKey)).not.toBeNull();

    loadRuntimeConfig(guestLink);
    expect(store.getItem(ownerKey)).toBeNull();
  });

  it('moves pre-namespace private data to the current link code, then removes the shared copy', () => {
    store.setItem('cc_briefs', JSON.stringify([{ captureId: 'CAP-0', status: 'processed' }]));
    store.setItem('cc_briefSeeAll', '1');

    loadRuntimeConfig(ownerLink);

    expect(loadCachedBriefs()).toEqual([{ captureId: 'CAP-0', status: 'processed' }]);
    expect(loadOwnerFlags().seeAll).toBe(true);
    expect(store.getItem('cc_briefs')).toBeNull();
    expect(store.getItem('cc_briefSeeAll')).toBeNull();
  });

  it('removes pre-namespace private data that cannot be attributed to any link code', () => {
    store.setItem('cc_briefs', JSON.stringify([{ captureId: 'CAP-0', status: 'processed' }]));

    loadRuntimeConfig('');

    expect(store.getItem('cc_briefs')).toBeNull();
    expect(loadCachedBriefs()).toEqual([]);
  });
});

describe('device disconnect (FI-007)', () => {
  it('clears the link code, private caches and meeting context but keeps device preferences', () => {
    loadRuntimeConfig(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`);
    saveRuntimeConfig({ apiUrl: PINNED_API, token: 'owner-token', capturer: 'Kang' });
    saveCachedBriefs([{ captureId: 'CAP-1', status: 'processed', brief: '# Owner only' }]);
    saveOwnerFlags({ seeAll: true, researchInstructionEnabled: true });
    saveRecentSearch('한화 구매팀장');
    saveStickyCaptureContext({ event: '2026 로보월드', relSelf: '오늘 처음', relKairen: '잠재 고객', research: '최근 경력' });
    saveGalleryFree(false);
    saveSectionCollapsed('briefs', true);

    signOutDevice();

    expect(store.getItem('cc_token')).toBeNull();
    expect(store.getItem('cc_name')).toBeNull();
    expect(activeSubject()).toBe(ANONYMOUS_SUBJECT);
    expect(loadCachedBriefs()).toEqual([]);
    expect(loadOwnerFlags()).toEqual({ seeAll: false, researchInstructionEnabled: false });
    expect(loadRecentSearches()).toEqual([]);
    expect(loadStickyCaptureContext()).toEqual({ event: '', relSelf: '', relKairen: '', research: '' });
    expect(Object.keys(store.snapshot()).filter((key) => /^cc_s[0-9a-z]+_/.test(key))).toEqual([]);

    // 기기 취향 설정은 사적 기록이 아니므로 남는다.
    expect(store.getItem('cc_galleryFree')).toBe('off');
    expect(loadSectionCollapsed('briefs')).toBe(true);
  });
});

describe('capture context and search history behaviour', () => {
  beforeEach(() => loadRuntimeConfig(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`));

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
