import type { BriefItem, RuntimeConfig } from '../contracts/capture';

export interface StickyCaptureContext {
  event: string;
  relSelf: string;
  relKairen: string;
  research: string;
}

const PREFIX = 'cc_';

function read(key: string): string {
  try {
    return localStorage.getItem(`${PREFIX}${key}`) ?? '';
  } catch {
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, value);
  } catch {
    // The legacy app also treats unavailable local storage as non-fatal.
  }
}

export interface OwnerFlags {
  seeAll: boolean;
  researchInstructionEnabled: boolean;
}

// legacy와 같은 키(cc_briefSeeAll, cc_researchInstructionEnabled)에 캐시해
// 서버 응답 전·오프라인에도 owner 게이트 UI가 유지되게 한다.
export function loadOwnerFlags(): OwnerFlags {
  return {
    seeAll: read('briefSeeAll') === '1',
    researchInstructionEnabled: read('researchInstructionEnabled') === '1',
  };
}

export function saveOwnerFlags(flags: OwnerFlags): void {
  write('briefSeeAll', flags.seeAll ? '1' : '');
  write('researchInstructionEnabled', flags.researchInstructionEnabled ? '1' : '');
}

export function loadRuntimeConfig(search = globalThis.location?.search ?? ''): RuntimeConfig {
  const params = new URLSearchParams(search);
  const linkedApi = params.get('api')?.trim() ?? '';
  const linkedToken = params.get('k')?.trim() ?? '';
  if (linkedApi) write('api', linkedApi);
  if (linkedToken) write('token', linkedToken);

  return {
    apiUrl: linkedApi || read('api') || __CARD_CAPTURE_DEFAULT_API__,
    token: linkedToken || read('token'),
    capturer: read('name'),
  };
}

export function saveRuntimeConfig(config: RuntimeConfig): void {
  write('api', config.apiUrl.trim());
  write('token', config.token.trim());
  write('name', config.capturer.trim());
}

export function loadStickyCaptureContext(now = Date.now()): StickyCaptureContext {
  const savedAt = Number(read('stickyAt')) || 0;
  if (savedAt && now - savedAt > 2 * 60 * 60 * 1000) {
    write('event', '');
    write('relSelf', '');
    write('relKairen', '');
    write('research', '');
    write('stickyAt', '');
    return { event: '', relSelf: '', relKairen: '', research: '' };
  }
  return { event: read('event'), relSelf: read('relSelf'), relKairen: read('relKairen'), research: read('research') };
}

// 입력 즉시 호출된다 — 완료를 누르지 못해도(카메라 이탈·앱 종료) 2시간 유지가 성립하도록.
export function saveStickyCaptureContext(context: StickyCaptureContext, now = Date.now()): void {
  write('event', context.event.trim());
  write('relSelf', context.relSelf.trim());
  write('relKairen', context.relKairen.trim());
  write('research', context.research.trim());
  write('stickyAt', String(now));
}

// 기기 갤러리 정책 (ISS-000102).
// 카이렌 카메라로 찍은 사진은 앱 안에만 있고 갤러리에 저장되지 않는다. 갤러리에 사본을 만드는 것은
// OS 기본 카메라 앱뿐이고, 그 사본은 웹 앱이 지울 수 없다 — 그래서 기본값은 "기본 카메라 쓰지 않기"다.
export function loadGalleryFree(): boolean {
  return read('galleryFree') !== 'off';
}

export function saveGalleryFree(enabled: boolean): void {
  write('galleryFree', enabled ? '' : 'off');
}

// 섹션 접기 상태 — legacy와 같은 키(cc_collapse_recent, cc_collapse_briefs)를 공유한다.
// `context`는 촬영 화면의 만남 맥락 영역이다 (INT-000015).
export type CollapsibleSection = 'recent' | 'briefs' | 'context';

// `fallback`은 사용자가 아직 접거나 편 적이 없을 때의 기본값이다.
// 만남 맥락은 선택 입력이라 기본은 접힘 — 촬영 버튼이 화면 아래로 밀리지 않는다 (INT-000015).
export function loadSectionCollapsed(section: CollapsibleSection, fallback = false): boolean {
  const value = read(`collapse_${section}`);
  if (value === '1') return true;
  if (value === '0') return false;
  return fallback;
}

export function saveSectionCollapsed(section: CollapsibleSection, collapsed: boolean): void {
  write(`collapse_${section}`, collapsed ? '1' : '0');
}

export function loadRecentSearches(): string[] {
  try {
    const values = JSON.parse(read('recentSearches')) as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === 'string').slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function saveRecentSearch(query: string): string[] {
  const normalized = query.trim();
  const next = normalized ? [normalized, ...loadRecentSearches().filter((value) => value !== normalized)].slice(0, 3) : loadRecentSearches();
  write('recentSearches', JSON.stringify(next));
  return next;
}

export function loadCachedBriefs(): BriefItem[] {
  try {
    const values = JSON.parse(read('briefs')) as unknown;
    return Array.isArray(values) ? values as BriefItem[] : [];
  } catch {
    return [];
  }
}

export function saveCachedBriefs(items: BriefItem[]): void {
  write('briefs', JSON.stringify(items));
}
