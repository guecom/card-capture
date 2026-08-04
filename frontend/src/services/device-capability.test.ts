import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../contracts/int30';
import type { CandidateCameraErrorCode } from './camera';
import { CAPTURE_METHOD_ORDER } from './capture-entry';
import {
  type CameraPermission,
  type DeviceEnvironment,
  type FormFactor,
  MAX_INTAKE_BYTES,
  UNKNOWN_DEVICE_ENVIRONMENT,
  cameraBlockOf,
  captureMethodOrder,
  captureRecoveryIntent,
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
  /* 통합 판정 (TSK-000220 + TSK-000545): 순서는 기기와 무관하게 **하나**다.
     이 lane의 초안은 PC에서 `upload`를 맨 앞에 두었는데, 칸이 2개인 grid에서 그 순서는
     첫 줄을 `upload`·`camera`로 만들고 `직접 입력`을 둘째 줄로 밀어낸다. 두 입구가 같은 줄·
     같은 크기라는 것은 founder 결정(DEC-000103)이라 기기에 따라 깨질 수 없다. */
  it('keeps one order on every device so 촬영·직접 입력 stay side by side', () => {
    expect(captureMethodOrder()).toEqual(['camera', 'manual', 'upload']);
    for (const formFactor of FORM_FACTORS) {
      const ids = deviceCaptureMethods(env({ formFactor })).map((card) => card.id);
      expect(ids, `${formFactor}: 순서가 다르다`).toEqual(['camera', 'manual', 'upload']);
      // 인접성은 index 산술로 못 박는다 — 나중에 입구가 늘어도 둘 사이에 끼어들 수 없다.
      expect(ids.indexOf('manual') - ids.indexOf('camera'), `${formFactor}: 두 입구가 붙어 있지 않다`).toBe(1);
    }
  });

  it('is the same value the entry cards order by — one registry, not two', () => {
    expect(captureMethodOrder()).toEqual([...CAPTURE_METHOD_ORDER]);
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
    // PC의 사정은 **설명 줄**이 나른다. 제목은 결과를 말하는 자리다.
    expect(card.description).toContain('흔들림이 멎으면');
    expect(card.description).not.toBe(cameraOf({ formFactor: 'mobile', videoInputs: 1, cameraPermission: 'granted' }).description);
  });

  /* 통합 판정 (TSK-000220 + TSK-000545): 제목은 기기와 무관하게 하나다.
     초안은 PC에서 `웹캠으로 촬영`이었다. 그러면 (1) 옆에 나란히 선 `직접 입력`이 결과형 제목인데
     하나만 장치형이 되어 두 입구가 다른 종류의 말로 읽히고(DEC-000103의 동등 위계는 크기만이
     아니라 말의 결로도 읽힌다), (2) 앱에서 가장 많이 참조되는 접근 이름이 기기마다 달라진다. */
  it('names the camera entry by its outcome, identically on every device', () => {
    const desktop = cameraOf({ formFactor: 'desktop', videoInputs: 1 });
    const mobile = cameraOf({ formFactor: 'mobile', videoInputs: 1 });
    expect(desktop.title).toBe('명함 앞면 촬영');
    expect(mobile.title).toBe(desktop.title);
  });

  it('keeps every camera title stable across the whole device matrix', () => {
    const titles = new Set<string>();
    for (const candidate of everyEnvironment()) {
      for (const connection of CONNECTIONS) {
        titles.add(deviceCaptureMethods(candidate, connection).find((card) => card.id === 'camera')!.title);
      }
    }
    expect([...titles], '카메라 카드 제목이 조합에 따라 달라진다').toEqual(['명함 앞면 촬영']);
  });
});

describe('recovery intent', () => {
  /* 회복 버튼이 무엇을 여는지는 문구를 만든 자리가 안다. `kind`만으로는 갈리지 않는다 —
     `다시 시도`와 `파일 올리기로 등록하기`가 둘 다 `help`다. */
  it('never leaves a blocked card without a place to go', () => {
    for (const candidate of everyEnvironment()) {
      for (const card of deviceCaptureMethods(candidate)) {
        if (card.available) continue;
        expect(['retry_camera', 'open_upload', 'open_manual']).toContain(captureRecoveryIntent(card.recovery!));
      }
    }
  });

  it('asks the browser again only when a permission is what is missing', () => {
    const denied = deviceCaptureMethods(env({ cameraPermission: 'denied', videoInputs: 1 })).find((card) => card.id === 'camera')!;
    expect(captureRecoveryIntent(denied.recovery!)).toBe('retry_camera');
    // 다른 앱이 잡고 있는 경우도 "다시 열어 보는 것"이 유일하게 확인 가능한 행동이다.
    const busy = deviceCaptureMethods(env({ lastCameraFailure: 'camera_busy', videoInputs: 1 })).find((card) => card.id === 'camera')!;
    expect(captureRecoveryIntent(busy.recovery!)).toBe('retry_camera');
  });

  it('sends a camera-less device to file upload, and a file-less browser to 직접 입력', () => {
    const noCamera = deviceCaptureMethods(env({ videoInputs: 0 })).find((card) => card.id === 'camera')!;
    expect(captureRecoveryIntent(noCamera.recovery!)).toBe('open_upload');
    const noFiles = deviceCaptureMethods(env({ hasFileInput: false })).find((card) => card.id === 'upload')!;
    expect(captureRecoveryIntent(noFiles.recovery!)).toBe('open_manual');
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
