import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import {
  ACTIVE_REFRESH_MS,
  AUTO_REFRESH_DEFAULT_ON,
  cadenceSeconds,
  hasActiveBriefs,
  IDLE_REFRESH_MS,
  initialAutoRefreshOn,
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

  it('말하는 초는 실제 간격에서만 파생된다', () => {
    expect(cadenceSeconds(ACTIVE_REFRESH_MS)).toBe(4);
    expect(cadenceSeconds(IDLE_REFRESH_MS)).toBe(20);
    // 0.5초짜리 박자를 "0초마다"라고 말하지 않는다.
    expect(cadenceSeconds(500)).toBe(1);
  });
});

/**
 * 자동 갱신 스위치의 수명 (TSK-000543).
 *
 * 저장하지 않는다는 것은 코드에서 **보이지 않는 성질**이라 주석만으로는 지켜지지 않는다.
 * 여기서 저장소 자체를 감시해 "한 번도 손대지 않았다"를 값으로 잰다.
 */
describe('자동 갱신 스위치는 기기에 남지 않는다', () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, 'localStorage');
    Reflect.deleteProperty(globalThis, 'sessionStorage');
    Reflect.deleteProperty(globalThis, 'indexedDB');
    vi.restoreAllMocks();
  });

  it('새 session은 언제나 켜진 상태로 시작한다', () => {
    expect(AUTO_REFRESH_DEFAULT_ON).toBe(true);
    expect(initialAutoRefreshOn()).toBe(true);
  });

  it('시작값을 정할 때 어떤 영속 저장소도 읽거나 쓰지 않는다', () => {
    const localGet = vi.fn(() => 'false');
    const localSet = vi.fn();
    const sessionGet = vi.fn(() => 'false');
    const sessionSet = vi.fn();
    const open = vi.fn();
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: localGet, setItem: localSet, removeItem: vi.fn() },
    });
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: { getItem: sessionGet, setItem: sessionSet, removeItem: vi.fn() },
    });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: { open } });

    // 껐다 켰다를 반복해도 — 실제 사용에서 스위치를 만지는 만큼 — 저장소에는 아무 일도 없다.
    let on = initialAutoRefreshOn();
    for (let turn = 0; turn < 5; turn += 1) on = !on;
    expect(initialAutoRefreshOn()).toBe(true);

    expect(localGet, '시작값을 localStorage에서 읽었다 — 껐던 값이 다음 session까지 살아남는다').not.toHaveBeenCalled();
    expect(localSet, '스위치 값을 localStorage에 썼다').not.toHaveBeenCalled();
    expect(sessionGet).not.toHaveBeenCalled();
    expect(sessionSet).not.toHaveBeenCalled();
    expect(open, '스위치 값을 IndexedDB에 남겼다').not.toHaveBeenCalled();
  });

  it('저장된 값이 있는 것처럼 꾸며 놓아도 시작값은 켜짐이다', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      // 예전 버전이 남겼을 법한 키를 미리 심어 둔다. 읽는 코드가 생기면 이 검사가 무너진다.
      value: { getItem: () => 'off', setItem: vi.fn(), removeItem: vi.fn() },
    });
    expect(initialAutoRefreshOn()).toBe(true);
  });
});
