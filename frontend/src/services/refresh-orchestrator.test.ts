import { describe, expect, it } from 'vitest';
import type { BriefItem } from '../contracts/capture';
import { ACTIVE_REFRESH_MS, IDLE_REFRESH_MS } from './refresh-cadence';
import {
  REFRESH_BUSY_LABEL,
  REFRESH_BUSY_TEXT,
  REFRESH_FAILURE_SHORT_TEXT,
  REFRESH_FAILURE_TEXT,
  REFRESH_IDLE_LABEL,
  REFRESH_SUCCESS_HOLD_MS,
  REFRESH_SUCCESS_TEXT,
  type RefreshCadencePlan,
  type RefreshLoopTimers,
  type RefreshStatus,
  createRefreshLoop,
  createRefreshOrchestrator,
  refreshAgoText,
  refreshCadencePlan,
  refreshCadenceSentence,
  refreshCadenceText,
  refreshFailureTitle,
  refreshHeadlineText,
  refreshIdleText,
  refreshNotice,
} from './refresh-orchestrator';

/** 손으로 돌리는 시계. 실제 타이머를 쓰지 않아 4초/20초 박자를 결정적으로 잰다. */
function fakeTimers() {
  const entries = new Map<number, { handler: () => void; ms: number; nextAt: number }>();
  let sequence = 0;
  let now = 0;
  const timers: RefreshLoopTimers = {
    set(handler, ms) {
      sequence += 1;
      entries.set(sequence, { handler, ms, nextAt: now + ms });
      return sequence;
    },
    clear(id) {
      entries.delete(id);
    },
  };
  return {
    timers,
    get live() { return entries.size; },
    /** 지금 걸려 있는 간격들. `[]`이면 아무것도 돌지 않는다. */
    get intervals() { return [...entries.values()].map((entry) => entry.ms); },
    advance(ms: number): void {
      const target = now + ms;
      // 걸린 순서와 무관하게 시각 순으로 흘려보낸다.
      for (;;) {
        const due = [...entries.entries()]
          .filter(([, entry]) => entry.nextAt <= target)
          .sort((a, b) => a[1].nextAt - b[1].nextAt)[0];
        if (!due) break;
        const [, entry] = due;
        now = entry.nextAt;
        entry.nextAt += entry.ms;
        entry.handler();
      }
      now = target;
    },
  };
}

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

  it('계획을 주면 지금 걸린 박자를 그대로 넣고, 멈춰 있으면 없는 박자를 말하지 않는다', () => {
    const active = refreshCadencePlan({ items: [brief('received')] });
    const idle = refreshCadencePlan({ items: [brief('processed')] });
    const off = refreshCadencePlan({ items: [brief('received')], autoRefreshOn: false });

    expect(refreshIdleText({ autoRefreshOn: true, lastSuccessAgoMs: 1_000, cadence: active }))
      .toBe('자동 갱신 켜짐 · 4초마다 · 방금');
    expect(refreshIdleText({ autoRefreshOn: true, lastSuccessAgoMs: 1_000, cadence: idle }))
      .toBe('자동 갱신 켜짐 · 20초마다 · 방금');
    // 꺼진 상태에서 "20초마다"라고 말하면 그것이 곧 지켜지지 않는 약속이다.
    expect(refreshIdleText({ autoRefreshOn: false, lastSuccessAgoMs: 1_000, cadence: off }))
      .toBe('자동 갱신 꺼짐 · 방금');
  });

  /* 통합 검수 2026-08-04: 두 표면이 같은 사실을 다른 말로 하던 자리.
     미연결 PC에서 상단은 `연결되면 확인`인데 이 줄은 `자동 갱신 켜짐`만 남아 서로 모순되게
     읽혔다 — 하나는 "지금 안 본다", 다른 하나는 "켜져 있다". 이제 가운데 조각이 상단 바가 쓰는
     `refreshCadenceText`의 파생이라, 두 곳이 각자 문장을 만드는 일 자체가 없다.
     DEC-000092 §2의 뜻은 그대로다: 이 자리는 원래도 "지금 걸려 있는 박자"를 말하는 자리이고,
     박자가 없을 때 왜 없는지를 말하는 것이 그 자리를 비우는 것보다 정직하다. */
  it('멈춘 이유를 상단 바와 똑같은 말로 말한다', () => {
    const cases: { plan: RefreshCadencePlan; line: string }[] = [
      { plan: refreshCadencePlan({ items: [brief('processed')], configured: false }), line: '자동 갱신 켜짐 · 연결되면 확인' },
      { plan: refreshCadencePlan({ items: [brief('processed')], hidden: true }), line: '자동 갱신 켜짐 · 돌아오면 확인' },
    ];
    for (const { plan, line } of cases) {
      expect(refreshIdleText({ autoRefreshOn: true, cadence: plan })).toBe(line);
      // 상단 바가 쓰는 조각이 이 줄 안에 **글자 그대로** 들어 있다.
      expect(refreshIdleText({ autoRefreshOn: true, cadence: plan })).toContain(refreshCadenceText(plan));
    }
    // 사용자가 직접 끈 상태만 예외다 — 머리말이 이미 `자동 갱신 꺼짐`이라 같은 말을 두 번 쓰지 않는다.
    const off = refreshCadencePlan({ items: [brief('received')], autoRefreshOn: false });
    expect(refreshIdleText({ autoRefreshOn: false, cadence: off })).toBe('자동 갱신 꺼짐');
    expect(refreshCadenceText(off)).toBe('자동 꺼짐');
  });
});

// ── 적응형 박자를 정직하게 말한다 (TSK-000543) ──
//
// 지금 폴링은 처리 중일 때 4초, 조용할 때 20초다. 화면에 "20초마다"만 써 두면 그 문구는
// 처리 중인 화면에서 **거짓말**이 된다. 그래서 짧은 조각은 실제 간격에서만 파생되고,
// 전문은 왜 달라지는지까지 말한다.

describe('갱신 박자 문구', () => {
  const planOf = (input: Parameters<typeof refreshCadencePlan>[0]) => refreshCadencePlan(input);

  it('짧은 조각의 숫자는 계획의 실제 간격에서만 나온다', () => {
    expect(refreshCadenceText(planOf({ items: [brief('received')] }))).toBe('4초마다');
    expect(refreshCadenceText(planOf({ items: [brief('processed')] }))).toBe('20초마다');
    // 화면 어디에도 박아 둔 숫자가 없다는 증거: 상수를 바꾸면 문구도 같이 바뀐다.
    const custom: RefreshCadencePlan = { intervalMs: 7_000, paused: false, reason: 'idle' };
    expect(refreshCadenceText(custom)).toBe('7초마다');
  });

  it('멈춘 계획은 박자 대신 언제 다시 확인하는지를 말한다', () => {
    expect(refreshCadenceText(planOf({ items: [], autoRefreshOn: false }))).toBe('자동 꺼짐');
    expect(refreshCadenceText(planOf({ items: [], configured: false }))).toBe('연결되면 확인');
    expect(refreshCadenceText(planOf({ items: [], hidden: true }))).toBe('돌아오면 확인');
  });

  it('전문은 지금 몇 초인지와 왜 달라지는지를 함께 말한다', () => {
    const active = refreshCadenceSentence(planOf({ items: [brief('received')] }));
    expect(active).toContain('4초마다');
    expect(active, '처리가 끝나면 박자가 느려진다는 사실이 빠졌다').toContain('20초마다');

    const quiet = refreshCadenceSentence(planOf({ items: [brief('processed')] }));
    expect(quiet).toContain('20초마다');
    expect(quiet, '조용할 때의 문구가 "처리 중에는 더 자주"를 감춘다 — 그러면 4초 박자가 설명되지 않는다')
      .toContain('4초마다');

    expect(refreshCadenceSentence(planOf({ items: [], autoRefreshOn: false })))
      .toBe('자동 갱신이 꺼져 있어요. 새로고침을 누를 때만 확인합니다.');
  });

  it('한 줄은 세 가지 사실을 겹쳐 말하지 않는다', () => {
    const idle = planOf({ items: [brief('processed')] });
    // 신선도 + 박자. 요청이 떠 있지 않으면 작업 상태는 이 줄에 없다.
    expect(refreshHeadlineText({ plan: idle, lastSuccessAgoMs: 3_000 })).toBe('방금 · 20초마다');
    expect(refreshHeadlineText({ plan: idle, lastSuccessAgoMs: 12_000 })).toBe('12초 전 · 20초마다');
    // 아직 한 번도 못 받았으면 없는 신선도를 지어내지 않는다.
    expect(refreshHeadlineText({ plan: idle, lastSuccessAgoMs: null })).toBe('20초마다');
    // 요청이 실제로 떠 있는 동안에만 작업 상태가 이 줄을 차지한다.
    expect(refreshHeadlineText({ plan: idle, lastSuccessAgoMs: 3_000, busy: true })).toBe(REFRESH_BUSY_TEXT);
    expect(refreshHeadlineText({
      plan: idle,
      lastSuccessAgoMs: 3_000,
      status: { state: 'failure', text: REFRESH_FAILURE_TEXT, label: REFRESH_IDLE_LABEL, busy: false, role: 'alert', generation: 1, failureStreak: 1 },
    })).toBe(REFRESH_FAILURE_SHORT_TEXT);
    expect(refreshHeadlineText({
      plan: idle,
      lastSuccessAgoMs: 0,
      status: { state: 'success', text: REFRESH_SUCCESS_TEXT, label: REFRESH_IDLE_LABEL, busy: false, role: 'status', generation: 1, failureStreak: 0 },
    })).toBe(REFRESH_SUCCESS_TEXT);
  });

  it('경과 문구는 없는 값을 지어내지 않는다', () => {
    expect(refreshAgoText(null)).toBe('');
    expect(refreshAgoText(undefined)).toBe('');
    expect(refreshAgoText(Number.NaN)).toBe('');
    expect(refreshAgoText(2 * 3_600_000)).toBe('2시간 전');
  });
});

// ── 스위치가 실제로 타이머를 끄는가 (TSK-000543) ──
//
// "자동 갱신 꺼짐"의 증거는 화면 글자가 아니라 **걸려 있는 타이머가 0건**이라는 사실이다.
// 글자만 보는 검사는 문구를 바꿔 놓고 계속 폴링해도 통과한다.

describe('폴링 루프', () => {
  it('켜짐 · 처리 중이면 4초마다 실제로 부른다', () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    expect(loop.intervalMs()).toBe(ACTIVE_REFRESH_MS);
    expect(loop.timerCount()).toBe(1);

    clock.advance(ACTIVE_REFRESH_MS - 1);
    expect(ticks, '박자보다 일찍 불렀다').toBe(0);
    clock.advance(1);
    expect(ticks).toBe(1);
    clock.advance(ACTIVE_REFRESH_MS * 3);
    expect(ticks).toBe(4);
  });

  it('켜짐 · 조용하면 20초마다 부른다', () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('processed'), brief('skipped')] }));
    expect(loop.intervalMs()).toBe(IDLE_REFRESH_MS);
    clock.advance(ACTIVE_REFRESH_MS * 4);
    expect(ticks, '조용한데 빠른 박자로 돌고 있다').toBe(0);
    clock.advance(IDLE_REFRESH_MS - ACTIVE_REFRESH_MS * 4);
    expect(ticks).toBe(1);
  });

  it('꺼짐이면 타이머가 0건이고 아무리 기다려도 부르지 않는다', () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('received')], autoRefreshOn: false }));
    expect(loop.timerCount(), '꺼졌는데 타이머가 살아 있다').toBe(0);
    expect(clock.live, '루프 밖에 남은 타이머가 있다').toBe(0);
    expect(loop.intervalMs()).toBeNull();

    clock.advance(IDLE_REFRESH_MS * 5);
    expect(ticks, '자동 갱신을 껐는데 계속 가져오고 있다').toBe(0);
  });

  it('끄면 걸려 있던 타이머까지 거둬들이고, 다시 켜면 그 자리에서 재개한다', () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    clock.advance(ACTIVE_REFRESH_MS);
    expect(ticks).toBe(1);

    loop.apply(refreshCadencePlan({ items: [brief('received')], autoRefreshOn: false }));
    expect(clock.live).toBe(0);
    clock.advance(ACTIVE_REFRESH_MS * 10);
    expect(ticks, '끈 뒤에도 tick이 이어졌다').toBe(1);

    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    clock.advance(ACTIVE_REFRESH_MS);
    expect(ticks).toBe(2);
  });

  it('박자가 그대로면 타이머를 다시 걸지 않는다 — 목록이 바뀔 때마다 재시작하면 영영 안 돈다', () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    for (let step = 0; step < 3; step += 1) {
      clock.advance(ACTIVE_REFRESH_MS - 1_000);
      // 목록이 새로 왔다(같은 활성 상태). 같은 계획이므로 타이머는 그대로여야 한다.
      loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    }
    expect(clock.intervals).toEqual([ACTIVE_REFRESH_MS]);
    expect(ticks, '계획을 다시 적용할 때마다 박자가 처음으로 되돌아갔다').toBeGreaterThan(0);
  });

  it('연결이 없으면 폴링하지 않는다', () => {
    const clock = fakeTimers();
    let ticks = 0;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });
    loop.apply(refreshCadencePlan({ items: [brief('received')], configured: false }));
    clock.advance(IDLE_REFRESH_MS * 3);
    expect(loop.timerCount()).toBe(0);
    expect(ticks).toBe(0);
  });

  it('화면이 가려진 동안에는 부르지 않지만 타이머는 그대로 둔다 (복귀 즉시 재개)', () => {
    const clock = fakeTimers();
    let ticks = 0;
    let hidden = false;
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, hidden: () => hidden, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    hidden = true;
    clock.advance(ACTIVE_REFRESH_MS * 3);
    expect(ticks, '가려진 화면을 위해 요청을 보냈다').toBe(0);
    expect(loop.timerCount(), '타이머까지 버리면 복귀 시 다음 박자를 처음부터 기다린다').toBe(1);

    hidden = false;
    clock.advance(ACTIVE_REFRESH_MS);
    expect(ticks).toBe(1);
  });

  it('멈추면 남는 타이머가 없다', () => {
    const clock = fakeTimers();
    const loop = createRefreshLoop({ tick: () => {}, timers: clock.timers });
    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    loop.stop();
    expect(clock.live).toBe(0);
    expect(loop.timerCount()).toBe(0);
  });
});

// ── 끄는 순간 이미 날아간 요청 (TSK-000543) ──

describe('스위치를 끄는 순간', () => {
  it('이미 떠 있던 요청은 조용히 마무리되고, 새 박자는 걸리지 않는다', async () => {
    const clock = fakeTimers();
    const api = controllable();
    let ticks = 0;
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const loop = createRefreshLoop({ tick: () => { ticks += 1; }, timers: clock.timers });

    loop.apply(refreshCadencePlan({ items: [brief('received')] }));
    const inFlight = orchestrator.request('auto');
    expect(orchestrator.inFlight()).toBe(true);

    // 사용자가 끈다. 요청을 끊지 않는다 — 이미 받아 오고 있는 답을 버리면 화면이 뒤로 간다.
    loop.apply(refreshCadencePlan({ items: [brief('received')], autoRefreshOn: false }));
    expect(loop.timerCount()).toBe(0);
    expect(api.pending[0].signal.aborted, '끄기가 이미 날아간 요청을 취소해 버렸다').toBe(false);

    api.pending[0].resolve(9);
    expect(await inFlight).toMatchObject({ applied: true, value: 9 });
    clock.advance(IDLE_REFRESH_MS * 3);
    expect(ticks, '끈 뒤에 새 폴링이 시작됐다').toBe(0);
  });

  it('꺼진 상태에서도 직접 누른 갱신은 그대로 동작하고 single-flight를 유지한다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const loop = createRefreshLoop({ tick: () => {}, timers: fakeTimers().timers });
    loop.apply(refreshCadencePlan({ items: [brief('received')], autoRefreshOn: false }));

    // 연타. 하나의 요청으로 합쳐진다.
    const a = orchestrator.request('priority');
    const b = orchestrator.request('priority');
    const c = orchestrator.request('priority');
    expect(api.started).toBe(1);

    api.pending[0].resolve(5);
    await until(() => api.started === 2);
    api.pending[1].resolve(6);
    const outcomes = await Promise.all([a, b, c]);

    expect(api.maxInFlight, '꺼진 상태에서 연타하자 요청이 겹쳤다').toBe(1);
    expect(outcomes.map((outcome) => outcome.value)).toEqual([5, 6, 6]);
    expect(loop.timerCount(), '직접 누른 갱신이 자동 폴링을 되살렸다').toBe(0);
  });
});

// ── 진행 사실의 주인과 막힘 안내 (TSK-000559 / INT-000036) ──
//
// founder 판정: "오른쪽 위에 새로고침 버튼이 돌아가고 있는데, 이제 갱신 중이라고 뜨는 게 이상해."
// 원인은 `busy`가 App의 `loading`(모든 목록 조회)에서 왔다는 것이다 — 자동 폴링도 참으로
// 만든다. 이제 진행은 **누른 사람의 영수증**만 소유하고, 실패는 토스트가 아니라 남는 안내다.

describe('연속 실패 세기', () => {
  it('성공은 0으로 되돌리고, 연속 실패는 하나씩 오른다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });

    const first = orchestrator.request('priority');
    api.pending[0].reject(new Error('list_failed'));
    await first;
    expect(orchestrator.status().failureStreak).toBe(1);

    await until(() => !orchestrator.inFlight());
    const second = orchestrator.request('priority');
    // 진행 중에도 지금까지의 횟수를 잃지 않는다 — 잃으면 두 번째 안내가 첫 번째로 되돌아간다.
    expect(orchestrator.status()).toMatchObject({ state: 'in-flight', failureStreak: 1 });
    api.pending[1].reject(new Error('list_failed'));
    await second;
    expect(orchestrator.status().failureStreak).toBe(2);

    await until(() => !orchestrator.inFlight());
    const third = orchestrator.request('priority');
    api.pending[2].resolve(1);
    await third;
    expect(orchestrator.status(), '성공했는데도 실패 횟수가 남아 있다').toMatchObject({ state: 'success', failureStreak: 0 });
  });

  it('실패 상태는 원인을 함께 들고 있다 — 화면이 갈래를 말할 근거다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const request = orchestrator.request('priority');
    const cause = new TypeError('Failed to fetch');
    api.pending[0].reject(cause);
    await request;
    expect(orchestrator.status().error).toBe(cause);
  });

  it('연결·계정이 바뀌면 이전 subject에서 쌓인 실패 횟수는 따라오지 않는다', async () => {
    const api = controllable();
    const orchestrator = createRefreshOrchestrator({ run: api.run });
    const request = orchestrator.request('priority');
    api.pending[0].reject(new Error('list_failed'));
    await request;
    expect(orchestrator.status().failureStreak).toBe(1);

    orchestrator.reset();
    expect(orchestrator.status()).toMatchObject({ state: 'idle', failureStreak: 0 });
  });
});

describe('막힘·실패 안내', () => {
  const quiet = refreshCadencePlan({ items: [brief('processed')] });
  const failureStatus = (streak: number, error: unknown): RefreshStatus => ({
    state: 'failure',
    text: REFRESH_FAILURE_TEXT,
    label: REFRESH_IDLE_LABEL,
    busy: false,
    role: 'alert',
    generation: streak,
    failureStreak: streak,
    error,
  });

  it('막을 것이 없으면 아무것도 만들지 않는다', () => {
    expect(refreshNotice({ plan: quiet, online: true })).toBeNull();
    expect(refreshNotice({ plan: quiet, online: true, failure: null })).toBeNull();
    // 진행·성공은 안내가 아니다 — 그것은 누른 버튼 옆 영수증이 말한다.
    expect(refreshNotice({
      plan: quiet,
      online: true,
      failure: { ...failureStatus(1, 'x'), state: 'success' },
    })).toBeNull();
  });

  it('연결이 없으면 물어봤을 때만 답한다 — 본문 연결 카드와 같은 말을 상시로 겹치지 않는다', () => {
    const off = refreshCadencePlan({ items: [], configured: false });
    expect(refreshNotice({ plan: off, online: true })).toBeNull();
    const asked = refreshNotice({ plan: off, online: true, asked: true });
    expect(asked).toMatchObject({ reason: 'disconnected', tone: 'blocked', retry: false });
    // 눌러도 소용없는 자리에 `다시 시도`를 내밀지 않는다.
    expect(asked!.retry).toBe(false);
    expect(asked!.title).toContain('연결');
  });

  it('오프라인은 묻지 않아도 말한다 — 자동 갱신이 조용히 죽어 있는 것을 감추지 않는다', () => {
    const notice = refreshNotice({ plan: quiet, online: false });
    expect(notice).toMatchObject({ reason: 'offline', tone: 'blocked', streak: 0 });
    expect(notice!.detail, '언제 다시 확인하는지를 말하지 않는다').toContain('연결되면');
    // 오프라인이 실패보다 앞선다 — 실패의 진짜 원인이 오프라인일 때 네트워크 오류라고
    // 다시 말해 봐야 사용자가 할 일이 달라지지 않는다.
    expect(refreshNotice({ plan: quiet, online: false, failure: failureStatus(1, new TypeError('Failed to fetch')) }))
      .toMatchObject({ reason: 'offline' });
  });

  it('실패는 원인 갈래를 이름 붙이고 손잡이를 하나 준다', () => {
    const notice = refreshNotice({ plan: quiet, online: true, failure: failureStatus(1, new TypeError('Failed to fetch')) });
    expect(notice).toMatchObject({ reason: 'failure', tone: 'error', retry: true, streak: 1 });
    expect(notice!.title).toBe('네트워크 오류');
  });

  it('반복 실패는 같은 문장을 되풀이하지 않고 **보이는 문구**까지 단계를 올린다', () => {
    const error = new Error('list_failed');
    const first = refreshNotice({ plan: quiet, online: true, failure: failureStatus(1, error) })!;
    const second = refreshNotice({ plan: quiet, online: true, failure: failureStatus(2, error) })!;
    const fourth = refreshNotice({ plan: quiet, online: true, failure: failureStatus(4, error) })!;

    expect(second.title, '두 번째가 첫 번째와 똑같이 보인다 — 단계를 올리지 않은 것과 같다').not.toBe(first.title);
    expect(fourth.title).not.toBe(second.title);
    expect(second.title).toContain('연결 확인');
    expect(fourth.title).toContain('설정');
    expect(second.detail).not.toBe(first.detail);
    // 단계를 올려도 손잡이는 계속 하나다. 선택지를 늘리는 것은 도움이 아니다.
    expect([first.retry, second.retry, fourth.retry]).toEqual([true, true, true]);
  });

  it('원인 갈래는 오류 코드에서만 나온다 — 화면이 추측하지 않는다', () => {
    expect(refreshFailureTitle(new TypeError('Failed to fetch'))).toBe('네트워크 오류');
    expect(refreshFailureTitle('owner_only')).toBe('권한 오류');
    expect(refreshFailureTitle(new Error('list_failed'))).toBe('서버 오류');
    expect(refreshFailureTitle('missing_api')).toBe('연결 오류');
    expect(refreshFailureTitle('weird_code')).toBe('갱신 실패');
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
