import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../contracts/int30';
import {
  type BootstrapFeature,
  type SetupSituation,
  connectionSetupPrompt,
  evaluateBootstrap,
  researchSurfaceVisible,
  resolveConnectionState,
} from './bootstrap-gate';

const CONNECTIONS: ConnectionState[] = ['configured', 'unconfigured', 'expired', 'failed'];
const OFFLINE: ConnectionState[] = ['unconfigured', 'expired', 'failed'];
const LOCAL_FEATURES: BootstrapFeature[] = ['shell', 'capture', 'research', 'records'];
const SITUATIONS: SetupSituation[] = ['unconfigured', 'cancelled', 'expired', 'failed'];

describe('resolveConnectionState', () => {
  it('needs both an address and a code before calling itself connected', () => {
    expect(resolveConnectionState({ apiUrl: '', token: 'code' })).toBe('unconfigured');
    expect(resolveConnectionState({ apiUrl: 'https://api.test/exec', token: '' })).toBe('unconfigured');
    expect(resolveConnectionState({ apiUrl: '  ', token: '  ' })).toBe('unconfigured');
    expect(resolveConnectionState({ apiUrl: 'https://api.test/exec', token: 'code' })).toBe('configured');
  });

  it('separates a rejected code from a server that simply did not answer', () => {
    const base = { apiUrl: 'https://api.test/exec', token: 'code' };
    expect(resolveConnectionState({ ...base, lastError: 'invalid_token' })).toBe('expired');
    expect(resolveConnectionState({ ...base, lastError: 'list_failed' })).toBe('failed');
    expect(resolveConnectionState({ ...base, lastError: '' })).toBe('configured');
    expect(resolveConnectionState({ ...base, lastError: null })).toBe('configured');
  });
});

describe('bootstrap gate — 연결 상태별 제한 범위', () => {
  it('never blocks the shell, in any connection state', () => {
    for (const connection of CONNECTIONS) {
      for (const setupCancelled of [true, false]) {
        const gate = evaluateBootstrap({ connection, setupCancelled });
        expect(gate.shellAlive).toBe(true);
        expect(gate.blocksShell).toBe(false);
        expect(gate.features.shell.usable).toBe(true);
      }
    }
  });

  it('keeps every locally-completable feature usable in every connection state', () => {
    for (const connection of CONNECTIONS) {
      const gate = evaluateBootstrap({ connection });
      for (const feature of LOCAL_FEATURES) {
        expect(gate.features[feature].usable, `${feature} @ ${connection}`).toBe(true);
      }
    }
  });

  it('limits only the two things that genuinely need a live server', () => {
    for (const connection of OFFLINE) {
      const gate = evaluateBootstrap({ connection });
      const blocked = Object.values(gate.features).filter((verdict) => !verdict.usable).map((verdict) => verdict.feature);
      expect(blocked.sort()).toEqual(['ownerSearch', 'serverSync']);
    }
  });

  it('marks locally-completable work as deferred rather than unusable', () => {
    for (const connection of OFFLINE) {
      const gate = evaluateBootstrap({ connection });
      expect(gate.features.capture).toMatchObject({ usable: true, deferred: true });
      expect(gate.features.research).toMatchObject({ usable: true, deferred: true });
      expect(gate.features.records).toMatchObject({ usable: true, deferred: true });
      // 사람 찾기는 미루는 것이 아니라 지금 못 하는 것이다 — 대기열에 쌓이지 않는다.
      expect(gate.features.ownerSearch).toMatchObject({ usable: false, deferred: false });
    }
  });

  it('leaves nothing deferred and nothing to set up once connected', () => {
    const gate = evaluateBootstrap({ connection: 'configured' });
    expect(Object.values(gate.features).every((verdict) => verdict.usable)).toBe(true);
    expect(Object.values(gate.features).every((verdict) => !verdict.deferred)).toBe(true);
    expect(gate.setup).toBeNull();
    expect(gate.setupAnchor).toBeNull();
  });

  it('anchors the setup card on the blocked feature, never on the whole screen', () => {
    for (const connection of OFFLINE) {
      const gate = evaluateBootstrap({ connection });
      expect(gate.setupAnchor).toBe('serverSync');
      expect(gate.features[gate.setupAnchor!].usable).toBe(false);
    }
  });

  it('offers exactly one guided action, and never a bare warning', () => {
    for (const connection of OFFLINE) {
      const setup = evaluateBootstrap({ connection }).setup!;
      expect(setup.actionLabel.length).toBeGreaterThan(0);
      expect(setup.title.length).toBeGreaterThan(0);
      expect(setup.body.length).toBeGreaterThan(0);
    }
  });

  it('does not punish a cancelled setup — same limits, softer wording', () => {
    const cancelled = evaluateBootstrap({ connection: 'unconfigured', setupCancelled: true });
    const untouched = evaluateBootstrap({ connection: 'unconfigured', setupCancelled: false });
    expect(cancelled.features).toEqual(untouched.features);
    expect(cancelled.setup?.situation).toBe('cancelled');
    expect(untouched.setup?.situation).toBe('unconfigured');
    expect(cancelled.setup?.tone).toBe('info');
  });

  it('ignores the cancel flag once something actually broke', () => {
    expect(evaluateBootstrap({ connection: 'expired', setupCancelled: true }).setup?.situation).toBe('expired');
    expect(evaluateBootstrap({ connection: 'failed', setupCancelled: true }).setup?.situation).toBe('failed');
  });

  it('warns only when something that used to work stopped working', () => {
    expect(connectionSetupPrompt('unconfigured').tone).toBe('info');
    expect(connectionSetupPrompt('cancelled').tone).toBe('info');
    expect(connectionSetupPrompt('expired').tone).toBe('warn');
    expect(connectionSetupPrompt('failed').tone).toBe('warn');
  });

  it('gives every feature a non-empty sentence in every state', () => {
    for (const connection of CONNECTIONS) {
      for (const verdict of Object.values(evaluateBootstrap({ connection }).features)) {
        expect(verdict.note.length, `${verdict.feature} @ ${connection}`).toBeGreaterThan(0);
      }
    }
  });

  it('promises that unsent captures are kept, in every situation copy', () => {
    for (const situation of SITUATIONS) {
      const prompt = connectionSetupPrompt(situation);
      expect(`${prompt.body}`.length).toBeGreaterThan(10);
    }
    expect(connectionSetupPrompt('expired').body).toContain('지워지지 않고');
  });
});

describe('researchSurfaceVisible — founder가 PC에서 본 결함', () => {
  const proven = { seeAll: true, researchInstructionEnabled: true };
  const guest = { seeAll: false, researchInstructionEnabled: false };

  it('shows the composer on a first, unconfigured visit — an unanswered question is not a refusal', () => {
    // 이것이 회귀 지점이다. 예전 규칙은 미설정 기기에서 항상 false였고, 그래서 PC 첫 진입에서
    // `AI 조사 요청` 작성 자리가 DOM에서 통째로 사라졌다.
    expect(researchSurfaceVisible(guest, 'unconfigured')).toBe(true);
    expect(researchSurfaceVisible(proven, 'unconfigured')).toBe(true);
  });

  it('still obeys the server once the server has actually answered', () => {
    expect(researchSurfaceVisible(guest, 'configured')).toBe(false);
    expect(researchSurfaceVisible(proven, 'configured')).toBe(true);
    expect(researchSurfaceVisible({ seeAll: true, researchInstructionEnabled: false }, 'configured')).toBe(false);
    expect(researchSurfaceVisible({ seeAll: false, researchInstructionEnabled: true }, 'configured')).toBe(false);
  });

  it('keeps the last proven answer when a working link expires or fails', () => {
    // 끊겼다는 이유로 없던 권한을 새로 보여 주지 않고, 있던 자리를 이유 없이 지우지도 않는다.
    expect(researchSurfaceVisible(guest, 'expired')).toBe(false);
    expect(researchSurfaceVisible(guest, 'failed')).toBe(false);
    expect(researchSurfaceVisible(proven, 'expired')).toBe(true);
    expect(researchSurfaceVisible(proven, 'failed')).toBe(true);
  });
});
