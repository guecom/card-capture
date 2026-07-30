import { describe, expect, it } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import {
  ACTIVE_REFRESH_MS,
  hasActiveBriefs,
  IDLE_REFRESH_MS,
  isTerminalBrief,
  refreshCadenceMs,
} from './refresh-cadence';

const brief = (status: string, type?: BriefItem['type']) => ({
  captureId: `${type ?? 'capture'}-${status}`,
  status,
  type,
} as BriefItem);

describe('refresh cadence', () => {
  it('uses the fast cadence while any capture card is non-terminal', () => {
    const items = [brief('processed'), brief('received')];
    expect(hasActiveBriefs(items)).toBe(true);
    expect(refreshCadenceMs(items)).toBe(ACTIVE_REFRESH_MS);
    expect(ACTIVE_REFRESH_MS).toBeLessThanOrEqual(5_000);
  });

  it('treats a research instruction receipt as active work too', () => {
    expect(refreshCadenceMs([brief('received', 'research_instruction')])).toBe(ACTIVE_REFRESH_MS);
  });

  it('returns to the existing low-frequency cadence when every card is terminal', () => {
    const items = [brief('processed'), brief('skipped', 'research_instruction')];
    expect(items.every(isTerminalBrief)).toBe(true);
    expect(refreshCadenceMs(items)).toBe(IDLE_REFRESH_MS);
    expect(IDLE_REFRESH_MS).toBe(20_000);
  });

  it('keeps unknown non-terminal status values active instead of pretending they are done', () => {
    expect(isTerminalBrief(brief('queued_by_future_server'))).toBe(false);
    expect(refreshCadenceMs([brief('queued_by_future_server')])).toBe(ACTIVE_REFRESH_MS);
  });
});
