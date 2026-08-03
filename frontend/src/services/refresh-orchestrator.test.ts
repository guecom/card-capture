import { describe, expect, it } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import { ACTIVE_REFRESH_MS, IDLE_REFRESH_MS } from './refresh-cadence';
import {
  REFRESH_BUSY_LABEL,
  REFRESH_BUSY_TEXT,
  REFRESH_FAILURE_TEXT,
  REFRESH_IDLE_LABEL,
  REFRESH_SUCCESS_HOLD_MS,
  REFRESH_SUCCESS_TEXT,
  type RefreshStatus,
  createRefreshOrchestrator,
  refreshCadencePlan,
  refreshIdleText,
} from './refresh-orchestrator';

const brief = (status: string) => ({ captureId: `c-${status}`, status } as BriefItem);

/** microtask만 흘려 조건이 이뤄질 때까지 기다린다. 실제 타이머를 쓰지 않아 결정적이다. */
async function until(predicate: () => boolean, turns = 100): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition never became true');
}

/** 손으로 결말을 정하는 조회. 동시에 몇 개가 떠 있었는지 최대치를 기억한다. */
function controllable() {
  const pending: Array<{ resolve: (value: number) => void; reject: (error: unknown) => void; signal: AbortSignal; generation: number }> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let started = 0;
  return {
    get started() { return started; },
    get maxInFlight() { return maxInFlight; },
    pending,
    run: ({ signal, generation }: { signal: AbortSignal; generation: number }) => {
      started += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise<number>((resolve, reject) => {
        pending.push({
          resolve: (value) => { inFlight -= 1; resolve(value); },
          reject: (error) => { inFlight -= 1; reject(error); },
          signal,
          generation,
        });
      });
    },
  };
}

describe('우선 갱신과 single-flight', () => {
  it('idle에서 직접 누르면 다음 폴링 차례를 기다리지 않고 바로 시작한다', () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    void orchestrator.request('priority');
    expect(api.started).toBe(1);
    expect(orchestrator.inFlight()).toBe(true);
  });

  it('겹친 폴링은 하나의 요청을 함께 기다린다 (maxListInFlight === 1)', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const first = orchestrator.request('auto');
    const second = orchestrator.request('auto');
    const third = orchestrator.request();

    expect(api.started).toBe(1);
    api.pending[0].resolve(7);
    const outcomes = await Promise.all([first, second, third]);
    expect(outcomes.map((outcome) => outcome.value)).toEqual([7, 7, 7]);
    expect(api.maxInFlight).toBe(1);
  });

  it('요청이 떠 있을 때의 우선 갱신은 그 응답을 최신으로 오인하지 않고 뒤이어 한 번 더 읽는다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    void orchestrator.request('auto');
    const priority = orchestrator.request('priority');

    // 아직은 하나만 떠 있다.
    expect(api.started).toBe(1);
    api.pending[0].resolve(1);
    await until(() => api.started === 2);
    api.pending[1].resolve(2);
    const outcome = await priority;

    // 작업 이전의 사진을 "최신"으로 오인하지 않고 뒤이어 한 번 더 읽은 결과를 돌려준다.
    expect(outcome).toMatchObject({ applied: true, value: 2 });
    expect(api.maxInFlight).toBe(1);
  });

  it('우선 갱신이 여러 번 겹쳐도 뒤이은 조회는 하나다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    void orchestrator.request('auto');
    const a = orchestrator.request('priority');
    const b = orchestrator.request('priority');
    const c = orchestrator.request('priority');

    api.pending[0].resolve(1);
    await until(() => api.started === 2);
    api.pending[1].resolve(2);
    const outcomes = await Promise.all([a, b, c]);

    expect(api.started).toBe(2);
    expect(outcomes.map((outcome) => outcome.value)).toEqual([2, 2, 2]);
    expect(api.maxInFlight).toBe(1);
  });
});

describe('늦게 도착한 응답 (정확성 결함)', () => {
  it('세션이 바뀌면 이전 요청의 응답은 화면을 덮어쓰지 않는다', async () => {
    const api = controllable();
    const seen: RefreshStatus[] = [];
    const orchestrator = createRefreshOrchestrator({ run: api.run, onStatus: (status) => seen.push(status) });
    const stale = orchestrator.request('priority');

    // 연결·계정이 바뀌었다. 지금 떠 있는 응답은 더 이상 이 화면의 것이 아니다.
    orchestrator.reset();
    const fresh = orchestrator.request('priority');
    expect(api.started).toBe(2);

    // 새 요청이 먼저 끝나고, 느린 이전 응답이 **그 뒤에** 도착한다.
    api.pending[1].resolve(200);
    expect((await fresh).applied).toBe(true);
    api.pending[0].resolve(100);
    const staleOutcome = await stale;

    expect(staleOutcome).toMatchObject({ applied: false, stale: true, value: 100 });
    // 마지막으로 화면에 반영된 것은 새 응답이다.
    expect(seen[seen.length - 1]).toMatchObject({ state: 'success', generation: 2 });
  });

  it('버려질 요청은 취소 신호를 받는다', () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    void orchestrator.request('priority');
    expect(api.pending[0].signal.aborted).toBe(false);
    orchestrator.reset();
    expect(api.pending[0].signal.aborted).toBe(true);
  });

  it('세대 번호는 요청마다 단조 증가한다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const first = orchestrator.request('priority');
    expect(orchestrator.generation()).toBe(1);
    api.pending[0].resolve(1);
    await first;
    await until(() => !orchestrator.inFlight());
    void orchestrator.request('priority');
    expect(orchestrator.generation()).toBe(2);
  });

  it('세션이 바뀐 뒤 실패한 이전 응답도 실패 문구를 띄우지 않는다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const stale = orchestrator.request('priority');
    orchestrator.reset();
    api.pending[0].reject(new Error('list_failed'));

    expect(await stale).toMatchObject({ applied: false, stale: true });
    expect(orchestrator.status().state).toBe('idle');
  });
});

describe('상태 기계와 승인 문구', () => {
  it('idle → in-flight → success → idle 로 돌아간다', async () => {
    const api = controllable();
    let clock = 0;
    const orchestrator = createRefreshOrchestrator({ run: api.run, now: () => clock });

    expect(orchestrator.status()).toMatchObject({ state: 'idle', label: REFRESH_IDLE_LABEL, busy: false, role: null });

    const request = orchestrator.request('priority');
    expect(orchestrator.status()).toMatchObject({
      state: 'in-flight',
      text: REFRESH_BUSY_TEXT,
      label: REFRESH_BUSY_LABEL,
      busy: true,
    });

    api.pending[0].resolve(3);
    await request;
    // v2.20.0에 0건이던 승인 문구를 정본으로 쓴다.
    expect(orchestrator.status()).toMatchObject({
      state: 'success',
      text: REFRESH_SUCCESS_TEXT,
      label: REFRESH_IDLE_LABEL,
      busy: false,
      role: 'status',
    });

    clock += REFRESH_SUCCESS_HOLD_MS - 1;
    orchestrator.tick(clock);
    expect(orchestrator.status().state).toBe('success');

    clock += 1;
    orchestrator.tick(clock);
    expect(orchestrator.status()).toMatchObject({ state: 'idle', text: '', label: REFRESH_IDLE_LABEL, busy: false });
  });

  it('실패는 정적 경고로 남고 다음 요청까지 사라지지 않는다', async () => {
    const api = controllable();
    let clock = 0;
    const orchestrator = createRefreshOrchestrator({ run: api.run, now: () => clock });
    const request = orchestrator.request('priority');
    api.pending[0].reject(new Error('offline'));
    const outcome = await request;

    expect(outcome).toMatchObject({ applied: false, stale: false });
    expect(orchestrator.status()).toMatchObject({
      state: 'failure',
      text: REFRESH_FAILURE_TEXT,
      label: REFRESH_IDLE_LABEL,
      busy: false,
      role: 'alert',
    });

    clock += REFRESH_SUCCESS_HOLD_MS * 10;
    orchestrator.tick(clock);
    expect(orchestrator.status().state).toBe('failure');

    void orchestrator.request('priority');
    expect(orchestrator.status().state).toBe('in-flight');
  });

  it('회전은 요청이 떠 있는 동안에만 존재한다 — 정책을 애니메이션으로 표현하지 않는다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const request = orchestrator.request('auto');
    expect(orchestrator.status().busy).toBe(true);
    api.pending[0].resolve(1);
    await request;
    expect(orchestrator.status().busy).toBe(false);
  });
});

describe('idle 문구', () => {
  it('다음 갱신 시각을 지어내지 않고 자동 갱신 여부와 마지막 성공만 말한다', () => {
    expect(refreshIdleText({ autoRefreshOn: true, lastSuccessAgoMs: 1_000 })).toBe('자동 갱신 켜짐 · 방금');
    expect(refreshIdleText({ autoRefreshOn: true, lastSuccessAgoMs: 12_000 })).toBe('자동 갱신 켜짐 · 12초 전');
    expect(refreshIdleText({ autoRefreshOn: true, lastSuccessAgoMs: 5 * 60_000 })).toBe('자동 갱신 켜짐 · 5분 전');
    expect(refreshIdleText({ autoRefreshOn: true })).toBe('자동 갱신 켜짐');
    expect(refreshIdleText({ autoRefreshOn: false, lastSuccessAgoMs: 30_000 })).toBe('자동 갱신 꺼짐 · 30초 전');
  });
});

describe('폴링 박자', () => {
  it('완료를 기다리는 카드가 있으면 빠른 박자를 쓴다', () => {
    expect(refreshCadencePlan({ items: [brief('processed'), brief('received')] }))
      .toEqual({ intervalMs: ACTIVE_REFRESH_MS, paused: false, reason: 'active' });
    expect(ACTIVE_REFRESH_MS).toBeLessThanOrEqual(5_000);
  });

  it('전부 끝나면 기존 저빈도 박자로 돌아간다', () => {
    expect(refreshCadencePlan({ items: [brief('processed'), brief('skipped')] }))
      .toEqual({ intervalMs: IDLE_REFRESH_MS, paused: false, reason: 'idle' });
  });

  it('화면이 가려졌거나 연결이 없으면 폴링하지 않는다', () => {
    expect(refreshCadencePlan({ items: [brief('received')], hidden: true }))
      .toMatchObject({ paused: true, reason: 'hidden', intervalMs: ACTIVE_REFRESH_MS });
    expect(refreshCadencePlan({ items: [brief('received')], configured: false }))
      .toMatchObject({ paused: true, reason: 'disconnected' });
  });

  it('목록이 비어 있으면 저빈도다', () => {
    expect(refreshCadencePlan({})).toMatchObject({ intervalMs: IDLE_REFRESH_MS, paused: false });
  });
});
