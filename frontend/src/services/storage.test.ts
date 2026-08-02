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

  /**
   * 계약 변경 — Kairen-Ref: TSK-000289.
   *
   * 예전 단언은 `moves pre-namespace private data to the current link code`, 즉 전역 사적 키를
   * **현재 링크 코드로 옮긴다**였다. 근거는 "이 기기에서 그 값을 쓴 주체는 지금 저장된 token뿐"이었고,
   * 그 전제가 틀렸다:
   *
   * 1. 이 정리가 도는 시점의 "지금 저장된 token"은 이번 boot에 들어온 링크가 **방금** 써 넣은 값이다.
   *    이전 subject가 남긴 값에 대해 새 subject의 토큰을 증거로 삼는 구조라, 토큰이 바뀌는 경우
   *    — 곧 FI-006이 막으려던 바로 그 경우 — 에 반드시 틀린다.
   * 2. 결함을 발견했을 때는 이전 앱(`docs/legacy.html`)도 전역 자리를 계속 쓰고 있어 창이 반복해서 열렸다.
   *    그 앱은 이제 폐기됐지만, 남아 있는 예전 기기 데이터를 안전하게 버리는 계약은 유지한다.
   *
   * 그래서 계약을 "귀속을 추정하지 않고 버린다"로 바꿨다. 이 검사는 **owner 자신의 링크로 열어도**
   * 옮기지 않는다는 것까지 단언한다 — 우리는 owner인지 아닌지를 구별할 수 없고, 구별할 수 있는
   * 척하는 것이 예전 계약의 결함이었다.
   */
  it('drops pre-namespace private data instead of adopting it into the current link code', () => {
    store.setItem('cc_briefs', JSON.stringify([{ captureId: 'CAP-0', status: 'processed' }]));
    store.setItem('cc_briefSeeAll', '1');

    loadRuntimeConfig(ownerLink);

    expect(loadCachedBriefs()).toEqual([]);
    expect(loadOwnerFlags().seeAll).toBe(false);
    expect(store.getItem('cc_briefs')).toBeNull();
    expect(store.getItem('cc_briefSeeAll')).toBeNull();
  });

  it('removes pre-namespace private data on an anonymous boot too', () => {
    store.setItem('cc_briefs', JSON.stringify([{ captureId: 'CAP-0', status: 'processed' }]));

    loadRuntimeConfig('');

    expect(store.getItem('cc_briefs')).toBeNull();
    expect(loadCachedBriefs()).toEqual([]);
  });

  /**
   * 판정 게이트 — Kairen-Ref: TSK-000289
   *
   * 전역 사적 키는 어느 subject가 썼는지 증명할 수 없는 이전 저장 형식이다. 당시 이전 앱도
   * `briefSeeAll`·`researchInstructionEnabled`·`briefs`·`recentSearches`를 계속 채웠다. 앱을 폐기한
   * 뒤에도 예전 기기에 남은 값을 다음 링크 코드가 상속하면 owner의 브리핑 전문(Private 포함)과
   * owner 게이트가 guest namespace로 들어가므로, 무조건 버리는 경계를 유지한다.
   */
  it('never adopts an unattributable shared cache into whichever link code boots first', () => {
    // owner 세션이 이전 앱에 남긴 전역 사적 키.
    store.setItem('cc_briefs', JSON.stringify([{ captureId: 'CAP-0', status: 'processed', brief: '# Owner only' }]));
    store.setItem('cc_briefSeeAll', '1');
    store.setItem('cc_researchInstructionEnabled', '1');
    store.setItem('cc_recentSearches', JSON.stringify(['한화 구매팀장']));

    // 그 기기를 guest 링크로 **먼저** 연다.
    loadRuntimeConfig(guestLink);

    expect({ briefs: loadCachedBriefs(), flags: loadOwnerFlags(), searches: loadRecentSearches() }).toEqual({
      briefs: [], flags: { seeAll: false, researchInstructionEnabled: false }, searches: [],
    });
    expect(JSON.stringify(store.snapshot())).not.toContain('Owner only');
  });
});

/**
 * FI-006 확장 — Kairen-Ref: TSK-000289
 *
 * FI-006이 `DELIVERED`가 된 뒤에도 만남 맥락(`event`·`relSelf`·`relKairen`·`research`·`stickyAt`)은
 * 전역 `cc_` 키로 남아 있었다. 계약 문장이 "브리핑 캐시·owner 게이트·검색 기록"이라는 **닫힌 목록**이라
 * 게이트도 그 세 가지만 지켰기 때문이다.
 *
 * 만남 맥락은 캐시가 아니라 **사람에 대해 그 subject가 직접 적은 메모**이고, 화면에 보이는 데서
 * 끝나지 않는다 — `App.tsx`가 이 값을 다음 촬영에 그대로 붙여 올린다. 즉 owner가 적은 관계 메모가
 * guest의 캡처에 guest의 것으로 실려 서버까지 간다.
 */
describe('meeting context is private to a subject (FI-006 확장)', () => {
  const ownerLink = `?api=${encodeURIComponent(PINNED_API)}&k=owner-token`;
  const guestLink = `?api=${encodeURIComponent(PINNED_API)}&k=guest-token`;
  const ownerContext = { event: '고객사 방문 미팅', relSelf: '대학 선배', relKairen: '잠재 고객', research: '최근 경력 위주' };
  const empty = { event: '', relSelf: '', relKairen: '', research: '' };

  it('never shows one link code the meeting context another wrote', () => {
    loadRuntimeConfig(ownerLink);
    saveStickyCaptureContext(ownerContext);

    loadRuntimeConfig(guestLink);
    expect(loadStickyCaptureContext()).toEqual(empty);
  });

  it('removes the meeting context of a link code that no longer opens the app', () => {
    loadRuntimeConfig(ownerLink);
    saveStickyCaptureContext(ownerContext);

    loadRuntimeConfig(guestLink);
    expect(JSON.stringify(store.snapshot())).not.toContain('대학 선배');
    expect(JSON.stringify(store.snapshot())).not.toContain('고객사 방문 미팅');
    // `research`는 `researchInstructionEnabled`의 접두사다 — 정리 패턴이 둘을 모두 잡는지 함께 본다.
    expect(JSON.stringify(store.snapshot())).not.toContain('최근 경력 위주');
    expect(Object.keys(store.snapshot()).filter((key) => key.startsWith(`cc_${subjectIdOf(PINNED_API, 'owner-token')}_`))).toEqual([]);
  });

  it('renders and stores no meeting context before a link code is known', () => {
    loadRuntimeConfig(ownerLink);
    saveStickyCaptureContext(ownerContext);

    // 링크 코드가 회수된(또는 아직 받지 못한) 기기에서 다시 여는 상황.
    store.removeItem('cc_token');
    loadRuntimeConfig('');
    expect(activeSubject()).toBe(ANONYMOUS_SUBJECT);
    expect(loadStickyCaptureContext()).toEqual(empty);

    saveStickyCaptureContext({ ...empty, event: '익명 상태 입력' });
    expect(JSON.stringify(store.snapshot())).not.toContain('익명 상태 입력');
  });

  /**
   * 이관하지 않고 **버리는** 것이 계약이다. 기기에 남은 전역 값이 지금 링크 코드의 주인이 적은
   * 것이라는 증거는 없고, subject가 바뀌는 boot가 바로 이 정리가 도는 boot다.
   */
  it('drops a pre-namespace meeting context instead of adopting it into the current link code', () => {
    store.setItem('cc_event', '고객사 방문 미팅');
    store.setItem('cc_relSelf', '대학 선배');
    store.setItem('cc_relKairen', '잠재 고객');
    store.setItem('cc_research', '최근 경력 위주');
    store.setItem('cc_stickyAt', String(Date.now()));

    loadRuntimeConfig(guestLink);

    expect(loadStickyCaptureContext()).toEqual(empty);
    expect(store.getItem('cc_event')).toBeNull();
    expect(store.getItem('cc_stickyAt')).toBeNull();
    expect(JSON.stringify(store.snapshot())).not.toContain('대학 선배');
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

  /**
   * 위 검사의 `loadStickyCaptureContext()`만으로는 부족하다 — `연결 해제` 뒤에는 subject가
   * 익명이라 사적 키를 **읽지 않으므로** 값이 기기에 남아 있어도 빈 값으로 보인다.
   * 실제로 지워졌는지는 저장소 내용과 재연결로만 판정할 수 있다.
   */
  it('erases the meeting context from the device, not just from view', () => {
    loadRuntimeConfig(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`);
    saveStickyCaptureContext({ event: '고객사 방문 미팅', relSelf: '대학 선배', relKairen: '잠재 고객', research: '최근 경력 위주' });

    signOutDevice();

    expect(JSON.stringify(store.snapshot())).not.toContain('대학 선배');
    expect(JSON.stringify(store.snapshot())).not.toContain('고객사 방문 미팅');

    // 같은 링크로 다시 연결해도 되살아나지 않는다.
    loadRuntimeConfig(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`);
    expect(loadStickyCaptureContext()).toEqual({ event: '', relSelf: '', relKairen: '', research: '' });
  });

  /**
   * 촬영 대기열(IndexedDB)은 유일본이라 격리·삭제 대상이 **아니다** (FI-007 계약).
   * subject 정리 경로가 넓어질 때 실수로 대기열까지 손대는 것을 막는 회귀 잠금이다.
   */
  it('never reaches the capture queue storage while isolating or disconnecting', () => {
    const indexedDb = { open: vi.fn(), deleteDatabase: vi.fn(), databases: vi.fn(), cmp: vi.fn() };
    vi.stubGlobal('indexedDB', indexedDb);

    loadRuntimeConfig(`?api=${encodeURIComponent(PINNED_API)}&k=owner-token`);
    saveCachedBriefs([{ captureId: 'CAP-1', status: 'processed', brief: '# Owner only' }]);
    saveStickyCaptureContext({ event: '고객사 방문 미팅', relSelf: '대학 선배', relKairen: '잠재 고객', research: '최근 경력 위주' });
    loadRuntimeConfig(`?api=${encodeURIComponent(PINNED_API)}&k=guest-token`);
    signOutDevice();

    expect(indexedDb.open).not.toHaveBeenCalled();
    expect(indexedDb.deleteDatabase).not.toHaveBeenCalled();
    expect(indexedDb.databases).not.toHaveBeenCalled();
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
