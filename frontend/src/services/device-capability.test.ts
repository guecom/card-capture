import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../contracts/int30';
import type { CandidateCameraErrorCode } from './camera';
import {
  type CameraPermission,
  type DeviceEnvironment,
  type FormFactor,
  MAX_INTAKE_BYTES,
  UNKNOWN_DEVICE_ENVIRONMENT,
  cameraBlockOf,
  captureMethodOrder,
  deviceCaptureMethods,
  probeDeviceEnvironment,
  triageIntakeFiles,
} from './device-capability';

function env(overrides: Partial<DeviceEnvironment> = {}): DeviceEnvironment {
  return { ...UNKNOWN_DEVICE_ENVIRONMENT, ...overrides };
}

const CONNECTIONS: ConnectionState[] = ['configured', 'unconfigured', 'expired', 'failed'];
const PERMISSIONS: CameraPermission[] = ['granted', 'denied', 'prompt', 'unknown'];
const FORM_FACTORS: FormFactor[] = ['desktop', 'mobile'];
const CAMERA_FAILURES: (CandidateCameraErrorCode | null)[] = [
  null, 'unsupported', 'permission_denied', 'camera_unavailable', 'camera_busy', 'frame_not_ready', 'camera_failed',
];
const VIDEO_INPUTS: (number | 'unknown')[] = ['unknown', 0, 1, 2];

/** 기기 축 전체를 곱해 만든 환경 목록. 조합을 손으로 고르면 빠뜨린 칸이 결함이 된다. */
function everyEnvironment(): DeviceEnvironment[] {
  const list: DeviceEnvironment[] = [];
  for (const formFactor of FORM_FACTORS) {
    for (const secureContext of [true, false]) {
      for (const hasGetUserMedia of [true, false]) {
        for (const hasFileInput of [true, false]) {
          for (const cameraPermission of PERMISSIONS) {
            for (const videoInputs of VIDEO_INPUTS) {
              for (const lastCameraFailure of CAMERA_FAILURES) {
                for (const online of [true, false]) {
                  list.push({ formFactor, secureContext, hasGetUserMedia, hasFileInput, cameraPermission, videoInputs, lastCameraFailure, online });
                }
              }
            }
          }
        }
      }
    }
  }
  return list;
}

describe('capture method cards — 전수 매트릭스', () => {
  const all = everyEnvironment();

  it('covers the whole device axis product', () => {
    // 조합 수가 조용히 줄면(축 하나가 사라지면) 아래 전수 단언이 의미를 잃는다.
    expect(all.length).toBe(2 * 2 * 2 * 2 * 4 * 4 * 7 * 2);
  });

  it('always offers exactly the three entries, in every device and connection combination', () => {
    for (const candidate of all) {
      for (const connection of CONNECTIONS) {
        const cards = deviceCaptureMethods(candidate, connection);
        expect(cards.map((card) => card.id).sort()).toEqual(['camera', 'manual', 'upload']);
      }
    }
  });

  it('never lets a card lose its title or description', () => {
    for (const candidate of all) {
      for (const card of deviceCaptureMethods(candidate)) {
        expect(card.title.length).toBeGreaterThan(0);
        expect(card.description.length).toBeGreaterThan(0);
      }
    }
  });

  it('never leaves an unavailable card without a reason and a way out', () => {
    for (const candidate of all) {
      for (const card of deviceCaptureMethods(candidate)) {
        if (card.available) {
          expect(card.unavailableReason).toBeUndefined();
          expect(card.recovery).toBeUndefined();
          continue;
        }
        expect(card.unavailableReason && card.unavailableReason.length > 0).toBe(true);
        expect(card.recovery?.label.length).toBeGreaterThan(0);
        expect(['permission', 'setup', 'help']).toContain(card.recovery?.kind);
      }
    }
  });

  it('keeps 직접 입력 available in every combination — the last entry never closes', () => {
    for (const candidate of all) {
      for (const connection of CONNECTIONS) {
        const manual = deviceCaptureMethods(candidate, connection).find((card) => card.id === 'manual');
        expect(manual?.available).toBe(true);
      }
    }
  });

  it('never lets the connection state flip availability', () => {
    for (const candidate of all) {
      const baseline = deviceCaptureMethods(candidate, 'configured').map((card) => [card.id, card.available]);
      for (const connection of CONNECTIONS) {
        expect(deviceCaptureMethods(candidate, connection).map((card) => [card.id, card.available])).toEqual(baseline);
      }
    }
  });

  it('never lets being offline flip availability', () => {
    for (const candidate of all.filter((item) => item.online)) {
      const offline = deviceCaptureMethods({ ...candidate, online: false });
      expect(offline.map((card) => card.available)).toEqual(deviceCaptureMethods(candidate).map((card) => card.available));
    }
  });

  it('says it saves locally only while a connection is missing', () => {
    const cards = deviceCaptureMethods(env({ formFactor: 'desktop' }), 'unconfigured');
    expect(cards.every((card) => card.description.includes('이 기기에 저장돼요'))).toBe(true);
    const connected = deviceCaptureMethods(env({ formFactor: 'desktop' }), 'configured');
    expect(connected.some((card) => card.description.includes('이 기기에 저장돼요'))).toBe(false);
  });
});

describe('capture method order', () => {
  it('leads with the file entry on a PC and with the camera on a phone', () => {
    expect(captureMethodOrder('desktop')[0]).toBe('upload');
    expect(captureMethodOrder('mobile')[0]).toBe('camera');
    expect(deviceCaptureMethods(env({ formFactor: 'desktop' })).map((card) => card.id)).toEqual(['upload', 'camera', 'manual']);
    expect(deviceCaptureMethods(env({ formFactor: 'mobile' })).map((card) => card.id)).toEqual(['camera', 'upload', 'manual']);
  });
});

describe('camera availability', () => {
  const cameraOf = (overrides: Partial<DeviceEnvironment>) =>
    deviceCaptureMethods(env(overrides)).find((card) => card.id === 'camera')!;

  it('treats "not asked yet" as usable and says so', () => {
    const card = cameraOf({ cameraPermission: 'prompt', videoInputs: 1 });
    expect(card.available).toBe(true);
    expect(card.description).toContain('처음 한 번만 권한을 물어봐요');
  });

  it('treats "denied" as blocked and points at the browser control, not at us', () => {
    const card = cameraOf({ cameraPermission: 'denied', videoInputs: 1 });
    expect(card.available).toBe(false);
    expect(card.unavailableReason).toContain('권한이 꺼져 있어요');
    expect(card.recovery?.kind).toBe('permission');
  });

  it('speaks differently for not-asked and denied', () => {
    const asked = cameraOf({ cameraPermission: 'prompt', videoInputs: 1 });
    const denied = cameraOf({ cameraPermission: 'denied', videoInputs: 1 });
    expect(asked.description).not.toBe(denied.unavailableReason);
    expect(asked.available).not.toBe(denied.available);
  });

  it('never reads "cannot count cameras" as "no camera"', () => {
    expect(cameraOf({ videoInputs: 'unknown' }).available).toBe(true);
    expect(cameraOf({ videoInputs: 0 }).available).toBe(false);
  });

  it('blames the http origin rather than the permission when the context is insecure', () => {
    const card = cameraOf({ secureContext: false, hasGetUserMedia: false, cameraPermission: 'prompt' });
    expect(card.available).toBe(false);
    expect(card.unavailableReason).toContain('https');
    expect(card.recovery?.kind).toBe('help');
  });

  it('names an unsupported browser instead of asking for a permission that does not exist', () => {
    const card = cameraOf({ hasGetUserMedia: false, secureContext: true });
    expect(card.unavailableReason).toContain('이 브라우저');
    expect(card.recovery?.kind).toBe('help');
  });

  it('tells the user another app is holding the camera', () => {
    const card = cameraOf({ lastCameraFailure: 'camera_busy', videoInputs: 1 });
    expect(card.available).toBe(false);
    expect(card.unavailableReason).toContain('다른 앱');
  });

  it('gives a desktop-specific wording for a PC with no camera at all', () => {
    expect(cameraOf({ formFactor: 'desktop', videoInputs: 0 }).unavailableReason).toContain('이 PC');
    expect(cameraOf({ formFactor: 'mobile', videoInputs: 0 }).unavailableReason).toContain('이 기기');
  });

  it('describes the desktop webcam for hands that are not free', () => {
    const card = cameraOf({ formFactor: 'desktop', videoInputs: 1, cameraPermission: 'granted' });
    expect(card.title).toBe('웹캠으로 촬영');
    expect(card.description).toContain('흔들림이 멎으면');
  });

  it('reports no block at all when the camera is simply fine', () => {
    expect(cameraBlockOf(env({ cameraPermission: 'granted', videoInputs: 2 }))).toBeNull();
  });
});

describe('other entries never disappear because the camera failed', () => {
  it('keeps upload and manual available while the camera is blocked for every reason', () => {
    for (const failure of CAMERA_FAILURES) {
      for (const permission of PERMISSIONS) {
        const cards = deviceCaptureMethods(env({ formFactor: 'desktop', lastCameraFailure: failure, cameraPermission: permission, videoInputs: 0 }));
        expect(cards.find((card) => card.id === 'upload')?.available).toBe(true);
        expect(cards.find((card) => card.id === 'manual')?.available).toBe(true);
      }
    }
  });

  it('keeps camera and manual available while file upload is unsupported', () => {
    const cards = deviceCaptureMethods(env({ hasFileInput: false, cameraPermission: 'granted', videoInputs: 1 }));
    expect(cards.find((card) => card.id === 'upload')?.available).toBe(false);
    expect(cards.find((card) => card.id === 'camera')?.available).toBe(true);
    expect(cards.find((card) => card.id === 'manual')?.available).toBe(true);
  });
});

describe('probeDeviceEnvironment', () => {
  it('fills in the permission and the camera count without asking for access', async () => {
    const probed = await probeDeviceEnvironment(env(), {
      permissions: { query: async () => ({ state: 'granted' }) },
      mediaDevices: { enumerateDevices: async () => [{ kind: 'videoinput' }, { kind: 'audioinput' }] },
    });
    expect(probed.cameraPermission).toBe('granted');
    expect(probed.videoInputs).toBe(1);
  });

  it('leaves an axis unknown when the browser refuses to answer', async () => {
    const probed = await probeDeviceEnvironment(env(), {
      permissions: { query: async () => { throw new Error('TypeError'); } },
      mediaDevices: { enumerateDevices: async () => { throw new Error('NotAllowedError'); } },
    });
    expect(probed.cameraPermission).toBe('unknown');
    expect(probed.videoInputs).toBe('unknown');
  });

  it('reads zero cameras as a real zero', async () => {
    const probed = await probeDeviceEnvironment(env(), {
      mediaDevices: { enumerateDevices: async () => [{ kind: 'audioinput' }] },
    });
    expect(probed.videoInputs).toBe(0);
  });
});

describe('file triage', () => {
  const file = (name: string, type = 'image/jpeg', size = 1_000) => ({ name, type, size });

  it('assigns the first two images to front and back', () => {
    const triage = triageIntakeFiles([file('a.jpg'), file('b.png')]);
    expect(triage.accepted).toEqual([
      { file: file('a.jpg'), side: 'front' },
      { file: file('b.png'), side: 'back' },
    ]);
    expect(triage.rejected).toEqual([]);
  });

  it('fills only the empty slot instead of overwriting what is already there', () => {
    const triage = triageIntakeFiles([file('b.jpg')], { hasFront: true });
    expect(triage.accepted).toEqual([{ file: file('b.jpg'), side: 'back' }]);
  });

  it('explains extra files instead of silently dropping them', () => {
    const triage = triageIntakeFiles([file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(triage.accepted).toHaveLength(2);
    expect(triage.rejected).toEqual([{ name: 'c.jpg', reason: 'slots_full' }]);
  });

  it('rejects a wrong type and an oversized file by name', () => {
    const triage = triageIntakeFiles([
      file('notes.pdf', 'application/pdf'),
      file('huge.jpg', 'image/jpeg', MAX_INTAKE_BYTES + 1),
      file('ok.jpg'),
    ]);
    expect(triage.rejected).toEqual([
      { name: 'notes.pdf', reason: 'wrong_type' },
      { name: 'huge.jpg', reason: 'too_large' },
    ]);
    // 나쁜 파일이 섞여 있어도 멀쩡한 장은 그대로 들어간다.
    expect(triage.accepted).toEqual([{ file: file('ok.jpg'), side: 'front' }]);
  });

  it('does not consume a slot for a file it rejected', () => {
    const triage = triageIntakeFiles([file('bad.txt', 'text/plain'), file('a.jpg'), file('b.jpg')]);
    expect(triage.accepted.map((item) => item.side)).toEqual(['front', 'back']);
  });

  it('returns nothing to do when both slots are already full', () => {
    const triage = triageIntakeFiles([file('a.jpg')], { hasFront: true, hasBack: true });
    expect(triage.accepted).toEqual([]);
    expect(triage.rejected).toEqual([{ name: 'a.jpg', reason: 'slots_full' }]);
  });
});
