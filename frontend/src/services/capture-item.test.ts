import { beforeEach, describe, expect, it } from 'vitest';
import {
  RECOVERY_REASON_COPY,
  buildQueuedCapture,
  captureFlowStateOf,
  captureRecoveryOf,
  createCaptureId,
  recoveryElapsedText,
  restoredDraftOf,
} from './capture-item';
import type { BriefItem } from '../contracts/capture';
import { clearTrace, traceOf } from './trace';

describe('captured-image queue contract', () => {
  const now = new Date(2026, 6, 25, 22, 45, 9);

  it('keeps the legacy local-time capture id shape', () => {
    expect(createCaptureId(now, () => 0.5)).toBe('20260725-224509-i');
  });

  it('builds the existing front-image queue payload without network fields', () => {
    const item = buildQueuedCapture({
      dataUrl: 'data:image/jpeg;base64,fixture-image',
      width: 1600,
      height: 900,
    }, { now, random: () => 0.5, quickName: {
      name: '김카이렌', source: 'device_text_detector', confidence: 80, confirmed: false, recognizedAt: now.toISOString(),
    } });

    expect(item).toMatchObject({
      captureId: '20260725-224509-i',
      capturedAt: now.toISOString(),
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'fixture-image' }],
      quickName: { name: '김카이렌', source: 'device_text_detector', confidence: 80, confirmed: false },
      researchInstruction: null,
      state: 'queued',
      tries: 0,
    });
    expect(item).not.toHaveProperty('k');
    expect(item).not.toHaveProperty('capturer');
  });

  it('rejects a non-JPEG frame before IndexedDB can receive it', () => {
    expect(() => buildQueuedCapture({
      dataUrl: 'data:image/png;base64,fixture-image',
      width: 1600,
      height: 900,
    }, { now })).toThrow('invalid_camera_frame');
  });

  it('preserves back image, sticky context labels, memo, and research instruction', () => {
    const item = buildQueuedCapture({ dataUrl: 'data:image/jpeg;base64,front', width: 1600, height: 900 }, {
      backFrame: { dataUrl: 'data:image/jpeg;base64,back', width: 1600, height: 900 },
      event: ' 2026 로보월드 ',
      relSelf: ' 오늘 처음 인사 ',
      relKairen: ' 잠재 고객 ',
      memo: ' 자료 보내기 ',
      researchInstruction: { raw: '공개 이력 확인', channel: 'owner_ui', policyVersion: 'public-research-v1', riskFlags: [] },
      now,
    });

    expect(item).toMatchObject({
      event: '2026 로보월드',
      relSelf: '오늘 처음 인사',
      relKairen: '잠재 고객',
      memo: '자료 보내기',
      note: '나와의 관계: 오늘 처음 인사\nKairen과의 관계: 잠재 고객\n메모: 자료 보내기',
      disp: '자료 보내기',
      images: [{ name: 'front.jpg', dataB64: 'front' }, { name: 'back.jpg', dataB64: 'back' }],
      researchInstruction: { raw: '공개 이력 확인', policyVersion: 'public-research-v1' },
    });
  });
});

// 되돌리기는 지우고 끝내는 것이 아니라 촬영 초안으로 되살리는 것이다 (FI-049).
describe('restoring a taken-back capture into the camera draft (FI-049)', () => {
  it('brings the same image bytes, context, memo and confirmed name back', () => {
    const item = buildQueuedCapture({ dataUrl: 'data:image/jpeg;base64,front', width: 1600, height: 900 }, {
      backFrame: { dataUrl: 'data:image/jpeg;base64,back', width: 1600, height: 900 },
      event: '고객사 방문 미팅',
      relSelf: '오늘 처음',
      relKairen: '부품 공급사',
      memo: '공장장 직속',
      quickName: { name: '김민서', source: 'user_corrected', confidence: 0, confirmed: true, recognizedAt: '2026-07-27T03:00:00.000Z' },
    });

    expect(restoredDraftOf(item)).toEqual({
      front: 'data:image/jpeg;base64,front',
      back: 'data:image/jpeg;base64,back',
      event: '고객사 방문 미팅',
      relSelf: '오늘 처음',
      relKairen: '부품 공급사',
      memo: '공장장 직속',
      quickName: { name: '김민서', source: 'user_corrected', confidence: 0, confirmed: true, recognizedAt: '2026-07-27T03:00:00.000Z' },
    });
  });

  it('revives the context of a legacy row that only ever stored the composed note', () => {
    const draft = restoredDraftOf({
      captureId: '20260727-120000-legacy',
      capturedAt: '2026-07-27T03:00:00.000Z',
      event: '2026 로보월드',
      note: '나와의 관계: 예전 동료\nKairen과의 관계: 협력사\n메모: 다음 주 자료 보내기',
      images: [{ name: 'front.jpg', mime: 'image/jpeg', dataB64: 'legacy-front' }],
      state: 'queued',
      tries: 0,
    });

    expect(draft).toMatchObject({
      front: 'data:image/jpeg;base64,legacy-front',
      back: '',
      event: '2026 로보월드',
      relSelf: '예전 동료',
      relKairen: '협력사',
      memo: '다음 주 자료 보내기',
      quickName: null,
    });
  });

  it('reports no original when the sent image has already been cleaned up', () => {
    expect(restoredDraftOf({
      captureId: '20260727-120000-sent',
      capturedAt: '2026-07-27T03:00:00.000Z',
      images: [{ name: 'front.jpg', mime: 'image/jpeg' }],
      state: 'sent',
      tries: 0,
      relSelf: '',
      relKairen: '',
      memo: '',
    }).front).toBe('');
  });
});

// 캡처의 여정은 촬영이 대기열에 들어가는 순간 시작된다 (FI-021).
// correlationId는 클라이언트 진단 전용이며 서버로 전송되지 않는다.
describe('a new capture starts its own traceable journey (FI-021)', () => {
  beforeEach(() => { clearTrace(); });

  it('mints a correlation id that carries no capture content', () => {
    const item = buildQueuedCapture({ dataUrl: 'data:image/jpeg;base64,front', width: 1600, height: 900 }, {
      now: new Date(2026, 6, 27, 9, 0, 0),
      random: () => 0.5,
      event: '2026 로보월드 부스 A-12',
      memo: '공장장 직속, 다음 주 자료 보내기',
      quickName: { name: '김민서', source: 'user_corrected', confidence: 0, confirmed: true, recognizedAt: '2026-07-27T00:00:00.000Z' },
    });

    expect(item.correlationId).toMatch(/^cc-[0-9a-z]+$/);
    expect(item.correlationId).not.toContain('김민서');
    expect(item.correlationId).not.toContain('로보월드');
    // 같은 시각·같은 난수여도 캡처마다 다른 값을 받아야 여정이 뒤섞이지 않는다.
    expect(item.correlationId).not.toBe(item.captureId);
  });

  it('records the creation step so the journey has a beginning', () => {
    const item = buildQueuedCapture({ dataUrl: 'data:image/jpeg;base64,front', width: 1600, height: 900 }, {
      event: '2026 로보월드 부스 A-12',
      relSelf: '예전 동료',
      memo: '공장장 직속, 다음 주 자료 보내기',
      quickName: { name: '김민서', source: 'user_corrected', confidence: 0, confirmed: true, recognizedAt: '2026-07-27T00:00:00.000Z' },
    });

    const journey = traceOf(item.correlationId as string);
    expect(journey.map((record) => record.event)).toEqual(['created']);
    expect(journey[0].captureId).toBe(item.captureId);

    const serialized = JSON.stringify(journey);
    for (const value of ['김민서', '2026 로보월드 부스 A-12', '예전 동료', '공장장 직속, 다음 주 자료 보내기', 'front']) {
      expect(serialized).not.toContain(value);
    }
  });
});

// ── 기다리는 자리의 상태 (TSK-000531 / ISS-000232) ───────────────────────────
// founder 실측 2026-08-04: 조사 receipt가 워처에서 연속 6회 실패로 멈춰 있는 동안에도
// 화면은 아무 일도 하지 않는 `다시 처리 요청`만 보여 줬다. 여기서 잠그는 것은
// (1) 워처가 증명한 상태만 화면에 닿는다, (2) 그 상태에서는 죽은 버튼을 두지 않는다.
describe('watcher recovery receipt', () => {
  const receipt = (extra: Record<string, unknown> = {}) => ({
    captureId: '20260803-090000-r1',
    status: 'received',
    recovery: {
      kind: 'recovery_required',
      reasonCode: 'processor_failed',
      attempts: 3,
      failures: 6,
      threshold: 6,
      since: '2026-08-04T00:00:00.000Z',
      ...extra,
    },
  }) as unknown as BriefItem;

  it('narrows the watcher receipt to the closed contract', () => {
    expect(captureRecoveryOf(receipt())).toEqual({
      kind: 'recovery_required',
      reasonCode: 'processor_failed',
      attempts: 3,
      failures: 6,
      threshold: 6,
      since: '2026-08-04T00:00:00.000Z',
    });
  });

  it('drops receipts the contract does not know — the list JSON is untrusted', () => {
    expect(captureRecoveryOf(null)).toBeNull();
    expect(captureRecoveryOf({ captureId: 'x', status: 'received' } as BriefItem)).toBeNull();
    expect(captureRecoveryOf(receipt({ kind: 'please_show_this' }))).toBeNull();
    expect(captureRecoveryOf(receipt({ reasonCode: '<script>alert(1)</script>' }))).toBeNull();
    expect(captureRecoveryOf(receipt({ reasonCode: 'toString' }))).toBeNull();
  });

  it('coerces counters instead of trusting them', () => {
    const parsed = captureRecoveryOf(receipt({ attempts: '3', failures: -9, threshold: null }));
    expect(parsed).toMatchObject({ attempts: 3, failures: 0, threshold: 0 });
  });

  it('never renders the machine reason code to the user', () => {
    for (const [code, copy] of Object.entries(RECOVERY_REASON_COPY)) {
      expect(copy.cause).not.toContain(code);
      expect(copy.action).not.toContain(code);
      expect(copy.cause.length).toBeGreaterThan(0);
      expect(copy.action.length).toBeGreaterThan(0);
    }
  });

  it('says how long it has been stuck, and stays silent when it cannot tell', () => {
    const now = Date.parse('2026-08-04T03:30:00.000Z');
    expect(recoveryElapsedText('2026-08-04T03:29:40.000Z', now)).toBe('방금부터');
    expect(recoveryElapsedText('2026-08-04T03:00:00.000Z', now)).toBe('30분째');
    expect(recoveryElapsedText('2026-08-04T00:00:00.000Z', now)).toBe('3시간째');
    expect(recoveryElapsedText('2026-08-01T00:00:00.000Z', now)).toBe('3일째');
    expect(recoveryElapsedText('', now)).toBeNull();
    expect(recoveryElapsedText('nonsense', now)).toBeNull();
  });

  it('removes the requeue affordance only in the state that proves it is dead', () => {
    const stuck = captureFlowStateOf({ status: 'received', recovery: captureRecoveryOf(receipt()) });
    expect(stuck.state).toBe('recovery_required');
    expect(stuck.canRequeue).toBe(false);

    const retrying = captureFlowStateOf({
      status: 'received',
      recovery: captureRecoveryOf(receipt({ kind: 'retry_scheduled', attempts: 1, failures: 1 })),
    });
    expect(retrying.state).toBe('retry_scheduled');
    expect(retrying.canRequeue).toBe(true);
    expect(retrying.note).toContain('1번째 시도');

    const waiting = captureFlowStateOf({ status: 'received' });
    expect(waiting).toEqual({ state: 'not_started', canRequeue: true, note: '' });
    expect(captureFlowStateOf({ status: 'processing' }).state).toBe('processing');
    expect(captureFlowStateOf({ status: 'processed' }).state).toBe('done');
    expect(captureFlowStateOf({ status: 'skipped' }).state).toBe('done');
  });

  it('calls it delayed only from what this device actually observed', () => {
    const observed = { stage: 'process', samples: 4, medianMs: 300_000, lowMs: 240_000, highMs: 600_000, spread: 1.2 };
    // 관측 위끝(10분)을 넘겼다 = 관측된 사실. 지어낸 임계값이 아니다.
    expect(captureFlowStateOf({ status: 'processing', elapsedMinutes: 40, stageStat: observed }).state).toBe('delayed');
    expect(captureFlowStateOf({ status: 'processing', elapsedMinutes: 5, stageStat: observed }).state).toBe('processing');
    // 표본이 없으면 지연이라고 말하지 않는다 — 없는 근거를 있는 척하지 않는다.
    expect(captureFlowStateOf({
      status: 'processing', elapsedMinutes: 999, stageStat: { ...observed, samples: 1 },
    }).state).toBe('processing');
    expect(captureFlowStateOf({ status: 'processing', elapsedMinutes: 999 }).state).toBe('processing');
    // 워처가 증명한 상태가 관측 추정을 이긴다.
    expect(captureFlowStateOf({
      status: 'processing', elapsedMinutes: 999, stageStat: observed,
      recovery: captureRecoveryOf(receipt()),
    }).state).toBe('recovery_required');
  });
});
