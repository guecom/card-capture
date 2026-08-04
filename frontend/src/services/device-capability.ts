/**
 * 이 기기가 사람을 등록하는 세 입구 중 무엇을 실제로 할 수 있는가 (TSK-000545 / INT-000030).
 *
 * 왜 따로 있는가 — 예전에는 "쓸 수 있는가"가 화면 안에서 즉석으로 판정됐고, 판정의 축이
 * 섞여 있었다. 진입 경로(Hub 링크·직접 URL·북마크)와 연결 상태(미설정·만료·실패)와
 * 기기 능력(웹캠 유무·권한)이 하나의 boolean로 뭉치면, **연결이 없다는 이유로 카메라가
 * 사라지는** 일이 생긴다. 실제로 PC 첫 방문에서 그렇게 됐다.
 *
 * 그래서 이 파일의 계약은 셋이다.
 *   1. 카드는 **항상 세 장**이다. 못 쓰는 입구도 사라지지 않고 이유와 회복 행동을 달고 남는다.
 *   2. `available`은 **기기 능력만** 본다. 연결 상태는 `available`을 절대 뒤집지 못한다
 *      (그 계약은 `device-capability.test.ts`가 네 연결 상태 전수로 지킨다).
 *   3. `직접 입력`은 어떤 조합에서도 `available: true`다. 마지막 입구가 닫히면 앱이 아니라
 *      안내문이 된다.
 *
 * 소비자는 `components/CaptureEntry.tsx`(TSK-000220)이고, 이 파일은 그 카드가 읽을 사실만 만든다.
 */

import type {
  CaptureMethodCard,
  CaptureMethodId,
  CaptureMethodRecovery,
  ConnectionState,
} from '../contracts/int30';
import { CAPTURE_METHOD_ORDER } from './capture-entry';
import type { CandidateCameraErrorCode } from './camera';

/**
 * 브라우저가 말하는 카메라 권한.
 *
 * `prompt`(아직 물어보지 않음)와 `denied`(거부됨)를 **반드시 다르게** 다룬다. 둘을 합치면
 * 한 번도 물어본 적 없는 기기에서 카메라 입구가 회색으로 죽어 있고, 사용자는 자기가 거부한
 * 적 없는 권한을 찾아 브라우저 설정을 뒤지게 된다.
 */
export type CameraPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export type FormFactor = 'desktop' | 'mobile';

export interface DeviceEnvironment {
  formFactor: FormFactor;
  /** https 또는 localhost인가. http면 브라우저가 `getUserMedia` 자체를 막는다. */
  secureContext: boolean;
  hasGetUserMedia: boolean;
  /** `<input type="file">`로 이미지를 받을 수 있는가. */
  hasFileInput: boolean;
  cameraPermission: CameraPermission;
  /** `enumerateDevices`가 센 비디오 입력 수. 셀 수 없으면 `'unknown'` — 0과 절대 같지 않다. */
  videoInputs: number | 'unknown';
  /** 카메라를 **실제로 열다가** 실패한 이유. 추측이 아니라 관측이라 가장 구체적이다. */
  lastCameraFailure: CandidateCameraErrorCode | null;
  online: boolean;
}

/**
 * 아직 아무것도 물어보지 못한 상태의 기본값.
 *
 * 모르는 것은 `unknown`으로 둔다. `videoInputs: 0`이나 `permission: 'denied'`로 시작하면
 * 탐지가 끝나기 전 몇 프레임 동안 멀쩡한 카메라가 "없음"으로 그려지고, 그 첫인상이
 * 사용자가 화면에서 읽는 유일한 사실이 된다.
 */
export const UNKNOWN_DEVICE_ENVIRONMENT: DeviceEnvironment = {
  formFactor: 'mobile',
  secureContext: true,
  hasGetUserMedia: true,
  hasFileInput: true,
  cameraPermission: 'unknown',
  videoInputs: 'unknown',
  lastCameraFailure: null,
  online: true,
};

/** 데스크톱인가. 포인터가 정밀하고 화면이 넓으면 PC 동선으로 본다. */
export function detectFormFactor(view: Pick<Window, 'matchMedia'> | undefined = typeof window === 'undefined' ? undefined : window): FormFactor {
  if (!view?.matchMedia) return 'mobile';
  try {
    const finePointer = view.matchMedia('(pointer: fine)').matches;
    const noHover = view.matchMedia('(hover: none)').matches;
    return finePointer && !noHover ? 'desktop' : 'mobile';
  } catch {
    return 'mobile';
  }
}

/** 지금 당장 알 수 있는 것만 담은 스냅샷. 비동기 조회 없이 즉시 반환한다. */
export function readDeviceEnvironment(): DeviceEnvironment {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const secureContext = typeof globalThis.isSecureContext === 'boolean' ? globalThis.isSecureContext : true;
  return {
    formFactor: detectFormFactor(),
    secureContext,
    hasGetUserMedia: Boolean(nav?.mediaDevices?.getUserMedia) && secureContext,
    hasFileInput: typeof FileReader !== 'undefined' || typeof createImageBitmap === 'function',
    cameraPermission: 'unknown',
    videoInputs: 'unknown',
    lastCameraFailure: null,
    online: nav?.onLine !== false,
  };
}

type PermissionLike = { query(descriptor: { name: string }): Promise<{ state: string }> };
type EnumerateLike = { enumerateDevices(): Promise<{ kind: string }[]> };

/**
 * 브라우저에 물어봐야 아는 것을 채운다. **권한 요청은 하지 않는다** — 조회만 한다.
 * 조회가 없거나 실패하면 그 축은 `unknown`으로 남는다. 모른다는 것을 "없다"로 바꾸지 않는다.
 */
export async function probeDeviceEnvironment(
  base: DeviceEnvironment = readDeviceEnvironment(),
  deps: { permissions?: PermissionLike; mediaDevices?: EnumerateLike } = {},
): Promise<DeviceEnvironment> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator;
  const permissions = deps.permissions ?? (nav?.permissions as PermissionLike | undefined);
  const mediaDevices = deps.mediaDevices ?? (nav?.mediaDevices as EnumerateLike | undefined);

  let cameraPermission = base.cameraPermission;
  if (permissions?.query) {
    try {
      // Safari 등은 `camera`를 모른다 — 던지면 `unknown` 그대로 둔다.
      const status = await permissions.query({ name: 'camera' });
      if (status.state === 'granted' || status.state === 'denied' || status.state === 'prompt') {
        cameraPermission = status.state;
      }
    } catch {
      /* 모르는 채로 둔다 */
    }
  }

  let videoInputs = base.videoInputs;
  if (mediaDevices?.enumerateDevices) {
    try {
      const devices = await mediaDevices.enumerateDevices();
      videoInputs = devices.filter((device) => device.kind === 'videoinput').length;
    } catch {
      /* 모르는 채로 둔다 */
    }
  }

  return { ...base, cameraPermission, videoInputs };
}

/**
 * 카드 순서 — 기기와 무관하게 하나다 (통합 판정, TSK-000220 + TSK-000545).
 *
 * 이 lane의 초안은 PC에서 `upload`를 맨 앞에 놓았다. PC로 오는 명함은 대개 이미 파일이라는
 * 관찰은 맞다. 그런데 칸이 두 줄로 접히는 grid에서 `upload`를 앞에 두면 첫 줄이
 * `upload`·`camera`가 되고 **`직접 입력`이 둘째 줄로 밀린다.** `명함 촬영`과 `직접 입력`이
 * 같은 줄·같은 크기라는 것은 founder 결정(DEC-000103)이고, 회귀 게이트(`int29-manual`)가
 * 실제 픽셀로 그것을 잰다. 순서를 기기별로 갈랐다면 PC에서 그 결정이 조용히 깨졌을 것이다.
 *
 * PC에서 `upload`의 발견 가능성은 순서가 아니라 **면적**으로 갚는다: 카드가 셋이면
 * `captureMethodColumns`가 2칸을 유지하고 CSS가 마지막 카드를 두 칸에 걸쳐 그리므로,
 * `upload`는 첫 줄 바로 아래에서 화면에서 가장 넓은 카드가 된다. 맨 앞이 아니라고 해서
 * 숨은 것이 아니다.
 *
 * 순서의 원본은 `capture-entry.ts`의 `CAPTURE_METHOD_ORDER` 하나다. 생산자와 소비자가
 * 각자 순서를 들고 있으면 둘 중 하나만 고쳤을 때 화면과 계약이 조용히 갈라진다.
 */
export function captureMethodOrder(): CaptureMethodId[] {
  return [...CAPTURE_METHOD_ORDER];
}

const DEFERRED_CLAUSE = ' 연결 전에도 이 기기에 저장돼요.';

/**
 * 카메라 카드의 제목 — 기기와 무관하게 하나다 (통합 판정).
 *
 * 이 lane의 초안은 PC에서 제목을 `웹캠으로 촬영`으로 바꿨다. 두 가지 이유로 되돌렸다.
 *
 *  1. **card anatomy가 제목과 설명의 역할을 갈라 놓았다** (`capture-entry.ts`): 제목은
 *     결과(무엇이 만들어지는가), 설명은 방법(어떻게 찍히는가)이다. `웹캠으로`는 장치 이름,
 *     즉 방법이고 그 말은 이미 아래 설명 줄이 하고 있다. 그리고 옆에 나란히 선 `직접 입력`이
 *     결과형 제목이라, 하나만 장치형이 되면 두 입구가 **다른 종류의 말**로 읽힌다 —
 *     DEC-000103의 동등 위계는 크기만이 아니라 말의 결로도 읽힌다.
 *  2. 이 문자열은 앱에서 가장 많이 참조되는 접근 이름이다(14개 spec 파일). 기기에 따라
 *     달라지면 같은 버튼이 기기마다 다른 이름을 갖게 된다.
 *
 * PC의 사정(웹캠은 화각이 넓고 두 손이 자판에 묶여 있다)은 설명 줄이 그대로 나른다.
 */
const CAMERA_TITLE = '명함 앞면 촬영';

function cameraCopy(env: DeviceEnvironment): { title: string; description: string } {
  if (env.formFactor === 'desktop') {
    return {
      title: CAMERA_TITLE,
      // 데스크톱 웹캠은 화각이 넓고 두 손이 자판에 묶여 있다 — 들고 흔들리는 시간을 짧게 만든다.
      description: '명함을 웹캠 가까이 들면 테두리를 잡고, 흔들림이 멎으면 알아서 찍어요.',
    };
  }
  return { title: CAMERA_TITLE, description: '명함을 비추면 테두리를 잡아 반듯하게 잘라요.' };
}

function uploadCopy(env: DeviceEnvironment): { title: string; description: string } {
  if (env.formFactor === 'desktop') {
    return {
      title: '파일 올리기',
      description: '명함 사진을 끌어다 놓거나 골라서 올려요. 앞·뒷면 두 장까지 한 번에.',
    };
  }
  return { title: '사진 올리기', description: '앨범에 있는 명함 사진을 골라 올려요.' };
}

export const HELP_UPLOAD: CaptureMethodRecovery = { label: '파일 올리기로 등록하기', kind: 'help' };
export const HELP_RETRY: CaptureMethodRecovery = { label: '다시 시도', kind: 'help' };
export const HELP_MANUAL: CaptureMethodRecovery = { label: '직접 입력으로 등록하기', kind: 'help' };
export const ASK_PERMISSION: CaptureMethodRecovery = { label: '카메라 권한 다시 열기', kind: 'permission' };

/** 회복 버튼을 눌렀을 때 화면이 실제로 할 일. */
export type CaptureRecoveryIntent = 'retry_camera' | 'open_upload' | 'open_manual';

/**
 * 회복 문구를 화면의 행동으로 옮긴다.
 *
 * `kind`만으로는 갈리지 않는다 — `다시 시도`와 `파일 올리기로 등록하기`가 둘 다 `help`다.
 * 그래서 이 판정은 문구를 만든 자리(바로 위 상수들) 옆에 둔다. 화면이 문구를 보고 추측하면
 * 문구를 고치는 순간 행동이 조용히 어긋난다.
 */
export function captureRecoveryIntent(recovery: CaptureMethodRecovery): CaptureRecoveryIntent {
  if (recovery.kind === 'permission') return 'retry_camera';
  if (recovery.label === HELP_RETRY.label) return 'retry_camera';
  if (recovery.label === HELP_UPLOAD.label) return 'open_upload';
  return 'open_manual';
}

interface Blocked {
  reason: string;
  recovery: CaptureMethodRecovery;
}

/**
 * 카메라를 못 쓰는 이유. **가장 구체적인 것부터** 본다 — 브라우저가 지원하지 않는 기기에
 * "권한을 열어 주세요"라고 말하면 사용자는 있지도 않은 설정을 찾아 헤맨다.
 * 하나도 걸리지 않으면 `null`이고, 그때만 카드가 살아 있다.
 */
export function cameraBlockOf(env: DeviceEnvironment): Blocked | null {
  if (!env.hasGetUserMedia && !env.secureContext) {
    return {
      reason: 'http 주소로 열려 있어 브라우저가 카메라를 막았어요. https 주소로 열면 바로 켜져요.',
      recovery: HELP_UPLOAD,
    };
  }
  if (!env.hasGetUserMedia) {
    return { reason: '이 브라우저에서는 카메라를 열 수 없어요.', recovery: HELP_UPLOAD };
  }
  if (!env.secureContext) {
    return {
      reason: 'http 주소로 열려 있어 브라우저가 카메라를 막았어요. https 주소로 열면 바로 켜져요.',
      recovery: HELP_UPLOAD,
    };
  }
  if (env.lastCameraFailure === 'permission_denied' || env.cameraPermission === 'denied') {
    return {
      reason: '카메라 권한이 꺼져 있어요. 주소창의 자물쇠에서 이 사이트의 카메라를 허용해 주세요.',
      recovery: ASK_PERMISSION,
    };
  }
  if (env.videoInputs === 0) {
    return {
      reason: env.formFactor === 'desktop'
        ? '이 PC에 연결된 카메라가 없어요.'
        : '이 기기에서 카메라를 찾지 못했어요.',
      recovery: HELP_UPLOAD,
    };
  }
  if (env.lastCameraFailure === 'camera_busy') {
    return { reason: '다른 앱이 카메라를 쓰고 있어요. 그 앱을 닫고 다시 시도해 주세요.', recovery: HELP_RETRY };
  }
  if (env.lastCameraFailure === 'camera_unavailable') {
    return { reason: '카메라를 찾지 못했어요.', recovery: HELP_UPLOAD };
  }
  if (env.lastCameraFailure === 'unsupported') {
    return { reason: '이 브라우저에서는 카메라를 열 수 없어요.', recovery: HELP_UPLOAD };
  }
  if (env.lastCameraFailure) {
    return { reason: '카메라를 여는 데 실패했어요.', recovery: HELP_RETRY };
  }
  return null;
}

/**
 * 지금 이 기기의 캡처 입구 세 장.
 *
 * `connection`은 **설명 문구 한 조각**에만 쓴다. `available`에는 닿지 않는다 — 그 계약이
 * 이 파일의 존재 이유이고, 단위 테스트가 네 상태 전수로 확인한다.
 */
export function deviceCaptureMethods(
  env: DeviceEnvironment,
  connection: ConnectionState = 'configured',
): CaptureMethodCard[] {
  const deferred = connection !== 'configured' ? DEFERRED_CLAUSE : '';
  const cameraBlock = cameraBlockOf(env);
  const camera = cameraCopy(env);
  const upload = uploadCopy(env);

  const byId: Record<CaptureMethodId, CaptureMethodCard> = {
    camera: {
      id: 'camera',
      title: camera.title,
      description: cameraBlock
        ? camera.description
        : `${camera.description}${env.cameraPermission === 'prompt' ? ' 처음 한 번만 권한을 물어봐요.' : ''}${deferred}`,
      available: !cameraBlock,
      ...(cameraBlock ? { unavailableReason: cameraBlock.reason, recovery: cameraBlock.recovery } : {}),
    },
    upload: env.hasFileInput
      ? { id: 'upload', title: upload.title, description: `${upload.description}${deferred}`, available: true }
      : {
        id: 'upload',
        title: upload.title,
        description: upload.description,
        available: false,
        unavailableReason: '이 브라우저는 파일 올리기를 지원하지 않아요.',
        recovery: HELP_MANUAL,
      },
    // 마지막 입구. 어떤 기기·권한·연결 조합에서도 조건이 붙지 않는다.
    manual: {
      id: 'manual',
      title: '직접 입력',
      description: `명함이 없어도 기억나는 대로 적어 두면 정리해 드려요.${deferred}`,
      available: true,
    },
  };

  return captureMethodOrder().map((id) => byId[id]);
}

// ── 파일 분류 ────────────────────────────────────────────────────────────────

export type IntakeSide = 'front' | 'back';
export type IntakeRejection = 'wrong_type' | 'too_large' | 'slots_full';

export interface IntakeFileLike {
  name: string;
  type: string;
  size: number;
}

export interface IntakeAssignment<T extends IntakeFileLike = IntakeFileLike> {
  file: T;
  side: IntakeSide;
}

export interface IntakeRejected {
  name: string;
  reason: IntakeRejection;
}

export interface IntakeTriage<T extends IntakeFileLike = IntakeFileLike> {
  accepted: IntakeAssignment<T>[];
  rejected: IntakeRejected[];
}

/** 20MB. 폰 카메라 원본 한 장이 넉넉히 들어가고, 브라우저가 dataURL로 들고 있어도 버틴다. */
export const MAX_INTAKE_BYTES = 20 * 1024 * 1024;

export const intakeRejectionMessage: Record<IntakeRejection, string> = {
  wrong_type: '이미지 파일이 아니라 뺐어요 (jpg·png·heic 같은 사진 파일이면 됩니다)',
  too_large: '20MB가 넘어 뺐어요. 조금 줄여서 다시 올려 주세요',
  slots_full: '한 사람은 앞·뒷면 두 장까지예요. 나머지는 다음 사람으로 따로 올려 주세요',
};

/**
 * 떨어뜨린 파일을 앞·뒷면에 배정한다.
 *
 * 여러 장을 한 번에 받는 것이 데스크톱의 기본 동선이다(폴더에서 두 장을 잡아 끈다).
 * 이미 차 있는 자리는 건드리지 않고 빈 자리만 채운다 — 두 번째 드롭이 첫 장을 조용히
 * 덮어쓰면 사용자는 무엇이 올라갔는지 알 수 없다. 남는 장은 **버리지 않고 이유를 말한다**.
 */
export function triageIntakeFiles<T extends IntakeFileLike>(
  files: readonly T[],
  options: { hasFront?: boolean; hasBack?: boolean; maxBytes?: number } = {},
): IntakeTriage<T> {
  const maxBytes = options.maxBytes ?? MAX_INTAKE_BYTES;
  const open: IntakeSide[] = [];
  if (!options.hasFront) open.push('front');
  if (!options.hasBack) open.push('back');

  const accepted: IntakeAssignment<T>[] = [];
  const rejected: IntakeRejected[] = [];

  for (const file of files) {
    if (!/^image\//i.test(file.type || '')) {
      rejected.push({ name: file.name, reason: 'wrong_type' });
      continue;
    }
    if (file.size > maxBytes) {
      rejected.push({ name: file.name, reason: 'too_large' });
      continue;
    }
    const side = open.shift();
    if (!side) {
      rejected.push({ name: file.name, reason: 'slots_full' });
      continue;
    }
    accepted.push({ file, side });
  }

  return { accepted, rejected };
}
