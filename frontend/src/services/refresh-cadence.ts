import type { BriefItem } from '../contracts/capture';

// 평상시에는 기존 비용을 유지하고, 사용자가 완료를 기다리는 카드가 있을 때만 빠르게 확인한다.
export const ACTIVE_REFRESH_MS = 4_000;
export const IDLE_REFRESH_MS = 20_000;

export function isTerminalBrief(item: BriefItem): boolean {
  return item.status === 'processed' || item.status === 'skipped';
}

export function hasActiveBriefs(items: BriefItem[]): boolean {
  return items.some((item) => !isTerminalBrief(item));
}

export function refreshCadenceMs(items: BriefItem[]): number {
  return hasActiveBriefs(items) ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS;
}
