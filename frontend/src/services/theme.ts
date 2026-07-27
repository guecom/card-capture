// 화면 테마 (INT-000016 항목 003 — "다크모드도 있었으면 좋겠어").
//
// founder가 닫은 두 가지:
//  1. 시스템 설정 자동 추종만으로는 부족하다. 설정에서 `라이트/다크/시스템`을 직접 고른다.
//  2. 최초 기본값은 `라이트`다.
//
// 그래서 저장되는 값은 세 가지 preference이고, 실제로 칠하는 값(resolved)은 둘뿐이다.
// 이 파일은 preference → resolved 변환과 그 결과를 문서에 적용하는 일만 소유한다.
import type { ThemePreference } from './storage';

export type ResolvedTheme = 'light' | 'dark';

export const THEME_CHOICES: ReadonlyArray<{ value: ThemePreference; label: string; hint: string }> = [
  { value: 'light', label: '라이트', hint: '항상 밝은 화면' },
  { value: 'dark', label: '다크', hint: '항상 어두운 화면' },
  { value: 'system', label: '시스템', hint: '폰 설정을 따라감' },
];

/** 브라우저 주소창·작업 전환기에 쓰이는 색. 화면 맨 위 배경과 같아야 이질감이 없다. */
const THEME_COLOR: Record<ResolvedTheme, string> = { light: '#f6f8fb', dark: '#141020' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

export function systemPrefersDark(): boolean {
  return Boolean(globalThis.matchMedia?.(DARK_QUERY).matches);
}

/**
 * 실제로 칠하는 곳. CSS는 `:root[data-theme="dark"]`만 보면 되고,
 * `color-scheme`은 폼 컨트롤·스크롤바처럼 앱이 직접 그리지 않는 부분까지 따라오게 한다.
 */
export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', THEME_COLOR[resolved]);
}

/** `시스템`을 고른 사용자는 폰 설정이 바뀌는 순간 따라가야 한다. */
export function watchSystemTheme(listener: (prefersDark: boolean) => void): () => void {
  const query = globalThis.matchMedia?.(DARK_QUERY);
  if (!query) return () => undefined;
  const handler = (event: MediaQueryListEvent) => listener(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
