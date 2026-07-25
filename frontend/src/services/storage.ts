import type { BriefItem, RuntimeConfig } from '../contracts/capture';

export interface StickyCaptureContext {
  event: string;
  relSelf: string;
  relKairen: string;
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
    write('stickyAt', '');
    return { event: '', relSelf: '', relKairen: '' };
  }
  return { event: read('event'), relSelf: read('relSelf'), relKairen: read('relKairen') };
}

export function saveStickyCaptureContext(context: StickyCaptureContext, now = Date.now()): void {
  write('event', context.event.trim());
  write('relSelf', context.relSelf.trim());
  write('relKairen', context.relKairen.trim());
  write('stickyAt', String(now));
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
