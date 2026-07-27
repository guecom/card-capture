// 화면 움직임 (founder 판정 2026-07-28 — 실기기에서 "여전히 하이라이팅이 안 나옴").
//
// 실기기 캡처를 받고 조건을 하나씩 흉내 내 재 본 결과가 원인을 갈랐다:
//   desktop dark               ::before=block  livePixelDelta=26
//   desktop dark + reduced     ::before=none   livePixelDelta=0   ← 화면이 완전히 정지한다
//   Pixel 7 / Galaxy S9+       ::before=block  livePixelDelta=27~28
// 즉 폰 자체가 "움직임 최소화"를 켜고 있으면 우리 빛은 **하나도** 그려지지 않는다.
// Android는 접근성의 `애니메이션 제거`와 개발자 옵션의 애니메이션 배율 0을 모두
// `prefers-reduced-motion: reduce`로 브라우저에 알린다(배터리 절약 모드가 배율을 0으로
// 내리는 기기도 있다). iOS는 `설정 > 손쉬운 사용 > 동작`의 `동작 줄이기`가 같은 신호다.
//
// 그래서 OS 설정은 **기본값**이지 잠금장치가 아니게 만든다. 테마와 똑같이
// `켜기 / 끄기 / 시스템` 셋 중 하나를 고르고, 고른 값이 이 기기에 남는다.
// 아무것도 고르지 않은 사람에게는 지금까지처럼 폰 설정이 그대로 존중된다.
//
// CSS는 `:root[data-motion="off"]` 하나만 본다 — 미디어 쿼리를 직접 보면 `켜기`를 고른
// 사람의 화면까지 멈춰 버린다. 테마가 `prefers-color-scheme`를 직접 보지 않는 것과 같은 이유다.
import type { MotionPreference } from './storage';

export type ResolvedMotion = 'on' | 'off';

export const MOTION_CHOICES: ReadonlyArray<{ value: MotionPreference; label: string; hint: string }> = [
  { value: 'on', label: '켜기', hint: '항상 은은하게 움직임' },
  { value: 'off', label: '끄기', hint: '항상 멈춤' },
  { value: 'system', label: '시스템', hint: '폰 설정을 따라감' },
];

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function resolveMotion(preference: MotionPreference, systemPrefersReduced: boolean): ResolvedMotion {
  if (preference === 'system') return systemPrefersReduced ? 'off' : 'on';
  return preference;
}

export function systemPrefersReducedMotion(): boolean {
  return Boolean(globalThis.matchMedia?.(REDUCED_QUERY).matches);
}

export function applyMotion(resolved: ResolvedMotion): void {
  document.documentElement.dataset.motion = resolved;
}

/** `시스템`을 고른 사용자는 폰 설정이 바뀌는 순간 따라가야 한다. */
export function watchSystemMotion(listener: (prefersReduced: boolean) => void): () => void {
  const query = globalThis.matchMedia?.(REDUCED_QUERY);
  if (!query) return () => undefined;
  const handler = (event: MediaQueryListEvent) => listener(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}
