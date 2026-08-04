import type { BriefItem } from '../contracts/capture';

// 평상시에는 기존 비용을 유지하고, 사용자가 완료를 기다리는 카드가 있을 때만 빠르게 확인한다.
export const ACTIVE_REFRESH_MS = 4_000;
export const IDLE_REFRESH_MS = 20_000;

/**
 * 자동 갱신은 **새 session마다 켜진 채로 시작한다** (INT-000030 / TSK-000543).
 *
 * 이 값을 기기에 저장하지 않는 것은 빠뜨린 것이 아니라 계약이다. 끄기는 "지금 잠깐 조용히
 * 있어라"라는 뜻이지 "앞으로 영영 가져오지 마라"가 아니다. 껐다는 사실은 며칠 뒤에 반드시
 * 잊히고, 그때 멈춰 있는 목록은 사용자에게 **고장으로 보인다** — 자기가 끈 스위치를 기억하는
 * 사람은 없다. 그래서 localStorage·IndexedDB·서버 어디에도 쓰지 않는다.
 *
 * 이 계약은 `refresh-cadence.test.ts`의 "영속 저장소 쓰기 0건"과
 * `e2e/int30-refresh.spec.ts`의 새 session 복귀 검사가 함께 잠근다.
 */
export const AUTO_REFRESH_DEFAULT_ON = true;

/**
 * 새 session의 자동 갱신 시작값.
 *
 * 저장소를 **읽지 않는다**. 읽을 것이 없는 것이 이 함수의 요점이고, 나중에 누가 "기억하게
 * 해 주자"며 여기에 `localStorage.getItem`을 넣는 순간 위 계약이 깨진다.
 */
export function initialAutoRefreshOn(): boolean {
  return AUTO_REFRESH_DEFAULT_ON;
}

/**
 * 간격(ms)을 사람이 말하는 초로. 화면 문구는 **언제나 실제 간격에서 파생된다** —
 * 문구에 숫자를 박아 두면 박자를 바꾸는 순간 화면이 거짓말을 시작한다.
 */
export function cadenceSeconds(intervalMs: number): number {
  return Math.max(1, Math.round(intervalMs / 1_000));
}

export function isTerminalBrief(item: BriefItem): boolean {
  return item.status === 'processed' || item.status === 'skipped';
}

export function hasActiveBriefs(items: BriefItem[]): boolean {
  return items.some((item) => !isTerminalBrief(item));
}

export function refreshCadenceMs(items: BriefItem[]): number {
  return hasActiveBriefs(items) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
}
