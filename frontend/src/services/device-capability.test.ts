import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../contracts/int30';
import type { CandidateCameraErrorCode } from './camera';
import { CAPTURE_METHOD_ORDER } from './capture-entry';
import {
  type CameraPermission,
  type DeviceEnvironment,
  type FormFactor,
  CAPTURE_DEFERRED_NOTE,
  MAX_INTAKE_BYTES,
  UNKNOWN_DEVICE_ENVIRONMENT,
  cameraBlockOf,
  captureDeferredNote,
  captureMethodOrder,
  captureRecoveryIntent,
  detectFileInput,
  deviceCaptureMethods,
  intakeAssistHint,
  intakeRejectionLine,
  intakeRejectionMessage,
  pasteShortcutLabel,
  planIntakeFiles,
  probeDeviceEnvironment,
  readDeviceEnvironment,
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

  /* 통합 검수 2026-08-04: 연결 전 저장은 **구획의 사실**이라 카드가 말하지 않는다.
     예전에는 이 문장이 세 카드 설명 꼬리에 각각 붙어 한 화면에 세 번 나왔고, 그 길이가 설명 줄을
     클램프 밖으로 밀어 320px 미연결에서 8줄이 필요한데 3줄만 보이는 상태를 만들었다. */
  it('says it saves locally once, from the section — never from the cards', () => {
    for (const connection of CONNECTIONS) {
      const cards = deviceCaptureMethods(env({ formFactor: 'desktop' }), connection);
      expect(
        cards.some((card) => card.description.includes('이 기기에 저장돼요')),
        `${connection}: 연결 전 저장 안내가 카드 설명에 다시 들어왔다`,
      ).toBe(false);
    }
    expect(captureDeferredNote('configured')).toBe('');
    for (const connection of CONNECTIONS.filter((state) => state !== 'configured')) {
      expect(captureDeferredNote(connection)).toBe(CAPTURE_DEFERRED_NOTE);
    }
    expect(CAPTURE_DEFERRED_NOTE).toContain('이 기기에 저장돼요');
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
    expect(card.description).toContain('권한은 한 번만 물어요');
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
    expect(card.description).toContain('웹캠');
    expect(card.description).not.toBe(cameraOf({ formFactor: 'mobile', videoInputs: 1, cameraPermission: 'granted' }).description);
  });

  /* 통합 검수 2026-08-04: 이 줄은 카드 안에서 **한 문장**이다.
     예전 PC 문구는 두 절이 이어져 37자였고, 여기에 권한 절과 연결 절이 더 붙어 최대 71자가 됐다.
     좁은 칸(320px에서 안쪽 95px)에서 그 길이는 클램프를 넘어 `…`가 되고, 잘린 꼬리는 사용자가
     있는 줄조차 알 수 없다. 그래서 길이 자체에 상한을 둔다 — 실제 잘림은 렌더된 픽셀로
     `surface-polish.spec.ts` 012가 다시 판정하고, 여기서는 그 게이트에 닿기 전에 막는다. */
  it('keeps every entry outcome inside one sentence-sized budget', () => {
    const worst = Math.max(
      ...FORM_FACTORS.flatMap((formFactor) => PERMISSIONS.flatMap((cameraPermission) => CONNECTIONS.map((connection) =>
        Math.max(...deviceCaptureMethods(env({ formFactor, cameraPermission, videoInputs: 1 }), connection)
          .map((card) => card.description.length))))),
    );
    expect(worst, `가장 긴 진입 카드 설명이 ${worst}자다 — 좁은 칸에서 잘린다`).toBeLessThanOrEqual(40);
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

/* INT-000036: 카드를 누른 그 제스처가 곧바로 `<input type="file">`을 여는 구조가 됐다.
   그래서 "고를 칸이 있는가"는 이제 추측이면 안 된다 — 틀리면 카드는 눌리는데 아무 일도 일어나지
   않고, 오류조차 나지 않는다. 예전 판정(`FileReader가 있는가`)은 **고른 뒤에 읽을 수 있는가**만
   봤다. 지금은 칸을 하나 만들어 `type`을 되읽는다. */
describe('detectFileInput — 고를 칸이 정말 있는가', () => {
  /* 브라우저를 흉내 낸다. `input.type`은 아는 값만 받고 모르는 값은 명세대로 `text`로 되돌린다 —
     그 되돌림이 곧 "이 브라우저는 그 칸을 모른다"는 관측이다. */
  const documentThatKnows = (types: readonly string[]) => ({
    createElement: () => {
      let value = 'text';
      return {
        get type() { return value; },
        set type(next: string) { value = types.includes(next) ? next : 'text'; },
      };
    },
  });

  it('칸을 하나 만들어 type을 되읽는다', () => {
    expect(detectFileInput(documentThatKnows(['file']), true)).toBe(true);
  });

  it('브라우저가 file을 모르면 type이 text로 되돌아간다 — 그것을 지원으로 읽지 않는다', () => {
    // 예전 판정(`FileReader가 있는가`)은 그런 기기에서도 true였다. 그러면 카드는 눌리는데
    // 아무 일도 일어나지 않고, 오류조차 나지 않는다.
    expect(detectFileInput(documentThatKnows([]), true)).toBe(false);
  });

  it('읽을 수단이 없으면 칸이 있어도 한 바퀴가 돌지 않는다', () => {
    expect(detectFileInput(documentThatKnows(['file']), false)).toBe(false);
  });

  it('칸을 만들다 던지는 환경을 지원으로 읽지 않는다', () => {
    expect(detectFileInput({ createElement: () => { throw new Error('no DOM'); } }, true)).toBe(false);
  });

  it('문서가 없는 환경에서는 읽을 수 있다는 사실만 남는다', () => {
    expect(detectFileInput(undefined, true)).toBe(true);
    expect(detectFileInput(undefined, false)).toBe(false);
  });

  it('환경 스냅샷이 이 판정을 그대로 싣는다', () => {
    // 판정이 스냅샷에 닿지 않으면 카드는 계속 옛 사실을 그린다.
    expect(readDeviceEnvironment().hasFileInput).toBe(detectFileInput());
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
    expect(triage.rejected).toEqual([{ file: file('c.jpg'), reason: 'slots_full' }]);
  });

  it('rejects a wrong type and an oversized file by name', () => {
    const triage = triageIntakeFiles([
      file('notes.pdf', 'application/pdf'),
      file('huge.jpg', 'image/jpeg', MAX_INTAKE_BYTES + 1),
      file('ok.jpg'),
    ]);
    expect(triage.rejected).toEqual([
      { file: file('notes.pdf', 'application/pdf'), reason: 'wrong_type' },
      { file: file('huge.jpg', 'image/jpeg', MAX_INTAKE_BYTES + 1), reason: 'too_large' },
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
    expect(triage.rejected).toEqual([{ file: file('a.jpg'), reason: 'slots_full' }]);
  });

  /* 거절은 이름 문자열이 아니라 **파일 자신**을 들고 있어야 한다 (INT-000036).
     자리가 다 찼을 때 "어디에 넣을까요?"를 물으려면 그 장을 손에 쥐고 있어야 하고,
     같은 이름의 두 파일은 이름으로 되찾을 수 없다. */
  it('keeps the rejected file itself, not just its name', () => {
    const duplicate = file('scan.jpg');
    const triage = triageIntakeFiles([file('a.jpg'), file('b.jpg'), duplicate]);
    expect(triage.rejected[0].file).toBe(duplicate);
  });
});

describe('intake plan — 화면이 할 일 전부', () => {
  const file = (name: string, type = 'image/jpeg', size = 1_000) => ({ name, type, size });

  it('앞·뒷면이 다 찼으면 되물을 한 장을 고르고, 그 장은 통보 문장에 넣지 않는다', () => {
    const extra = file('extra.jpg');
    const plan = planIntakeFiles([extra], { hasFront: true, hasBack: true });
    expect(plan.replaceCandidate).toBe(extra);
    // 질문 대상은 통보가 아니다 — 같은 파일을 묻고 동시에 "뺐어요"라고 말하지 않는다.
    expect(plan.notes).toEqual([]);
  });

  it('남은 장이 여럿이면 첫 장만 묻고 나머지는 이름과 이유를 남긴다', () => {
    const plan = planIntakeFiles([file('c.jpg'), file('d.jpg')], { hasFront: true, hasBack: true });
    expect(plan.replaceCandidate?.name).toBe('c.jpg');
    expect(plan.notes).toHaveLength(1);
    expect(plan.notes[0]).toContain('d.jpg');
    expect(plan.notes[0]).toContain(intakeRejectionMessage.slots_full);
  });

  it('자리가 남아 있으면 되물을 것이 없다', () => {
    const plan = planIntakeFiles([file('a.jpg'), file('b.jpg')]);
    expect(plan.replaceCandidate).toBeNull();
    expect(plan.notes).toEqual([]);
    expect(plan.accepted.map((item) => item.side)).toEqual(['front', 'back']);
  });

  it('이름과 이유를 함께 남긴다 — 이유만 남은 문장을 만들지 않는다', () => {
    const plan = planIntakeFiles([file('notes.pdf', 'application/pdf'), file('huge.jpg', 'image/jpeg', MAX_INTAKE_BYTES + 1)]);
    expect(plan.notes).toEqual([
      intakeRejectionLine('notes.pdf', 'wrong_type'),
      intakeRejectionLine('huge.jpg', 'too_large'),
    ]);
    for (const note of plan.notes) expect(note.length).toBeGreaterThan(10);
  });

  it('열어 본 뒤에야 아는 실패에도 할 말이 있다', () => {
    // 디코드 실패는 이 함수가 판정할 수 없다 — 그래도 같은 자에 같은 모양으로 남아야 한다.
    expect(intakeRejectionLine('broken.png', 'unreadable')).toContain('broken.png');
    expect(intakeRejectionMessage.unreadable.length).toBeGreaterThan(10);
  });
});

describe('끌어다 놓기·붙여넣기 안내', () => {
  /* 손가락으로는 파일을 끌 수 없고 `Ctrl+V`도 없다. 예전 `DesktopIntake`는 폰에서도
     `여기로 끌어다 놓아도 되고`를 그대로 보여 줬다 — 할 수 없는 일을 권하는 안내다. */
  it('터치 기기에는 아무 말도 하지 않는다', () => {
    expect(intakeAssistHint({ formFactor: 'mobile', hasFileInput: true })).toBe('');
  });

  it('파일 칸이 없는 브라우저에도 아무 말도 하지 않는다', () => {
    expect(intakeAssistHint({ formFactor: 'desktop', hasFileInput: false })).toBe('');
  });

  it('데스크톱에서는 두 길을 한 줄로 말한다', () => {
    const hint = intakeAssistHint({ formFactor: 'desktop', hasFileInput: true }, 'Win32');
    expect(hint).toContain('끌어다');
    expect(hint).toContain('Ctrl+V');
  });

  it('자판이 다른 기기에는 그 기기의 단축키를 말한다', () => {
    expect(pasteShortcutLabel('MacIntel')).toBe('⌘V');
    expect(pasteShortcutLabel('Win32')).toBe('Ctrl+V');
    expect(intakeAssistHint({ formFactor: 'desktop', hasFileInput: true }, 'MacIntel')).toContain('⌘V');
  });

  /* 카드 설명은 이 안내를 다시 하지 않는다 — 카드 한 장의 사실이 아니라 구획의 사실이고,
     예전 데스크톱 문구는 그것 때문에 설명 줄 예산(40자)을 정확히 다 쓰고 있었다. */
  it('카드 설명은 끌어다 놓기를 말하지 않는다', () => {
    for (const formFactor of FORM_FACTORS) {
      for (const card of deviceCaptureMethods(env({ formFactor }))) {
        expect(card.description, `${formFactor}/${card.id}`).not.toContain('끌어다');
      }
    }
  });
});
