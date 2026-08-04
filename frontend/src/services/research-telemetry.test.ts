// 조사 요청 라우팅 영수증 (TSK-000542).
//
// 이 로그는 **개발자 전용 채널**이다. 그래서 검사가 지켜야 하는 것도 두 갈래다.
//  A. 개발자가 필요한 사실이 실제로 남는가 — 요청한 깊이, 쓰인 자리와 설정 버전, 내려간 이유, 실패.
//  B. 사용자 글자가 이 경계를 넘지 않는가 — 자유 텍스트는 코드 모양이 아니면 통과하지 못한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RESEARCH_ROUTE_LOG_LIMIT,
  clearResearchRouteLog,
  createResearchRequestId,
  readResearchRouteLog,
  recordResearchRoute,
  subscribeResearchRouteAlert,
} from './research-telemetry';
import { RESEARCH_ROUTE_R1, resetResearchRouteConfig, resolveResearchRoute } from './research-mode';

beforeEach(() => {
  clearResearchRouteLog();
  resetResearchRouteConfig();
});

describe('research route receipt — 개발자가 되짚을 수 있는가', () => {
  it('요청한 깊이·쓰인 자리·설정 버전이 한 줄에 함께 남는다', () => {
    recordResearchRoute(resolveResearchRoute('deep'), { now: new Date('2026-08-04T09:00:00.000Z') });
    const [receipt] = readResearchRouteLog();
    expect(receipt).toMatchObject({
      event: 'routed',
      requestedDepth: 'deep',
      depth: 'deep',
      binding: 'sol',
      routeVersion: 'r1',
      degraded: false,
    });
    expect(receipt.ts).toBe('2026-08-04T09:00:00.000Z');
    expect(receipt.requestId).toMatch(/^rr-[a-z0-9]{10}$/);
  });

  it('내려간 요청은 이유까지 남는다', () => {
    recordResearchRoute(resolveResearchRoute('deep', RESEARCH_ROUTE_R1, (binding) => binding !== 'sol'));
    expect(readResearchRouteLog()[0]).toMatchObject({
      event: 'degraded',
      depth: 'deep',
      binding: 'terra',
      degraded: true,
      reason: 'binding_unavailable',
    });
  });

  it('어디로도 못 간 요청은 자리가 비어 있다고 말한다', () => {
    recordResearchRoute(resolveResearchRoute('quick', RESEARCH_ROUTE_R1, () => false));
    expect(readResearchRouteLog()[0]).toMatchObject({ binding: null, reason: 'no_binding', event: 'degraded' });
  });

  it('접수 실패는 실패로 남는다 — 정상 라우팅과 섞이지 않는다', () => {
    recordResearchRoute(resolveResearchRoute('standard'), { event: 'failed', reason: 'receipt_failed' });
    expect(readResearchRouteLog()[0]).toMatchObject({ event: 'failed', reason: 'receipt_failed', binding: 'terra' });
  });

  it('요청 이름은 난수다 — 같은 깊이를 두 번 보내도 이름이 겹치지 않는다', () => {
    recordResearchRoute(resolveResearchRoute('quick'));
    recordResearchRoute(resolveResearchRoute('quick'));
    const [first, second] = readResearchRouteLog();
    expect(first.requestId).not.toBe(second.requestId);
    expect(createResearchRequestId(() => 0)).toBe('rr-0000000000');
  });
});

describe('research route receipt — 사용자 글자는 넘어오지 않는다', () => {
  it('한국어 산문 사유는 통째로 가려진다', () => {
    recordResearchRoute(resolveResearchRoute('deep'), {
      event: 'failed',
      reason: '오늘 요청 한도를 넘었어요 — 김민서 / 010-1234-5678',
    });
    expect(readResearchRouteLog()[0].reason).toBe('redacted');
  });

  it('영수증에는 열거된 필드만 있다', () => {
    recordResearchRoute(resolveResearchRoute('deep'));
    expect(Object.keys(readResearchRouteLog()[0]).sort())
      .toEqual(['binding', 'degraded', 'depth', 'event', 'requestId', 'requestedDepth', 'routeVersion', 'ts']);
  });

  it('로그는 기억에만 살고 상한을 넘지 않는다', () => {
    for (let index = 0; index < RESEARCH_ROUTE_LOG_LIMIT + 25; index += 1) {
      recordResearchRoute(resolveResearchRoute('quick'));
    }
    expect(readResearchRouteLog()).toHaveLength(RESEARCH_ROUTE_LOG_LIMIT);
  });

  it('돌려받은 목록을 망가뜨려도 원본은 남는다', () => {
    recordResearchRoute(resolveResearchRoute('quick'));
    readResearchRouteLog().length = 0;
    expect(readResearchRouteLog()).toHaveLength(1);
  });
});

describe('research route alert — 조용히 쌓이지 않는다', () => {
  it('내려감과 실패만 알린다', () => {
    const seen: string[] = [];
    const stop = subscribeResearchRouteAlert((receipt) => seen.push(receipt.event));
    try {
      recordResearchRoute(resolveResearchRoute('standard'));
      recordResearchRoute(resolveResearchRoute('deep', RESEARCH_ROUTE_R1, () => false));
      recordResearchRoute(resolveResearchRoute('quick'), { event: 'failed', reason: 'receipt_failed' });
    } finally {
      stop();
    }
    expect(seen).toEqual(['degraded', 'failed']);
  });

  it('구독을 끊으면 더 오지 않는다', () => {
    const listener = vi.fn();
    subscribeResearchRouteAlert(listener)();
    recordResearchRoute(resolveResearchRoute('deep', RESEARCH_ROUTE_R1, () => false));
    expect(listener).not.toHaveBeenCalled();
  });

  it('구독자가 던져도 기록과 다른 구독자는 살아남는다', () => {
    const survivor = vi.fn();
    const stopBad = subscribeResearchRouteAlert(() => { throw new Error('진단 채널이 앱을 넘어뜨리면 안 된다'); });
    const stopGood = subscribeResearchRouteAlert(survivor);
    try {
      expect(() => recordResearchRoute(resolveResearchRoute('deep', RESEARCH_ROUTE_R1, () => false))).not.toThrow();
    } finally {
      stopBad();
      stopGood();
    }
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(readResearchRouteLog()).toHaveLength(1);
  });
});
