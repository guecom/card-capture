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

/**
 * `<input type="file">`이 실제로 있는가 (INT-000036).
 *
 * 예전 판정은 `FileReader가 있는가`였다. 그것은 **고른 뒤에 읽을 수 있는가**를 볼 뿐,
 * 고르는 칸이 있는지는 보지 않는다. 지금은 카드를 누르는 그 제스처가 곧바로 이 칸을 여는
 * 구조라 (`components/CaptureIntake.tsx`), 칸이 없으면 카드는 누를 수 있는데 아무 일도 일어나지
 * 않는다 — 이 표면에서 가장 나쁜 종류의 실패다.
 *
 * 그래서 칸을 하나 만들어 `type`을 되읽는다. 브라우저가 `file`을 모르면 명세대로 `text`로
 * 되돌아가므로, 추측이 아니라 관측이 된다. 읽는 쪽(`FileReader`)도 함께 있어야 한 바퀴가 돈다.
 */
export interface FileInputProbe {
  createElement(tagName: 'input'): { type: string };
}

export function detectFileInput(
  probe: FileInputProbe | undefined = typeof document === 'undefined' ? undefined : document,
  canRead: boolean = typeof FileReader !== 'undefined' || typeof createImageBitmap === 'function',
): boolean {
  // 고를 수 있어도 읽지 못하면 한 바퀴가 돌지 않는다.
  if (!canRead) return false;
  // 문서가 없는 환경(SSR·단위 시험)에서는 칸을 만들어 볼 수 없다. 그때는 읽을 수 있다는 사실만 남는다.
  if (!probe) return true;
  try {
    const input = probe.createElement('input');
    input.type = 'file';
    return input.type === 'file';
  } catch {
    return false;
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
    hasFileInput: detectFileInput(),
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

/**
 * 연결 전에도 저장된다는 사실 (통합 검수 2026-08-04).
 *
 * 예전에는 이 문장이 **세 카드의 설명 뒤에 각각** 붙었다. 두 가지가 동시에 잘못이었다.
 *
 *  1. 이것은 카드의 사실이 아니라 **구획의 사실**이다. 연결 상태는 입구마다 다르지 않으므로
 *     같은 문장이 한 화면에 세 번 나왔다.
 *  2. 그 길이가 설명 줄을 클램프 밖으로 밀어 `…`를 만들었다. 실측: 320px 미연결에서
 *     `명함 앞면 촬영`은 8줄이 필요한데 3줄만 보였고, 잘린 꼬리를 읽을 방법이 없었다.
 *
 * 그래서 문장은 남기되 자리를 옮긴다 — 카드 위 구획 머리(`빠른 등록` 줄)가 한 번만 말한다.
 * 설명 줄은 다시 **한 가지 결과만** 말하는 자리로 돌아온다.
 */
export const CAPTURE_DEFERRED_NOTE = '연결 전에도 이 기기에 저장돼요';

/** 지금 이 연결 상태에서 구획 머리가 덧붙일 한 마디. 연결돼 있으면 빈 문자열이다. */
export function captureDeferredNote(connection: ConnectionState): string {
  return connection === 'configured' ? '' : CAPTURE_DEFERRED_NOTE;
}

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

/**
 * 카메라 카드의 설명 — 폰과 PC가 같은 **모양의 한 문장**을 쓴다 (통합 검수 2026-08-04).
 *
 * 예전 PC 문구는 두 절이 이어진 37자짜리였다(`… 테두리를 잡고, 흔들림이 멎으면 …`).
 * 실폰에서는 짧은 폰 문구가 나가 안 보였지만, **폭을 좁힌 데스크톱 창**에서는 이 문구가 그대로
 * 들어와 3줄에서 끊겼다 — 잘린 꼬리가 ` 처음 한 번만 권한을 물어봐요.`였다.
 * 형식(desktop/mobile)은 pointer로 판정하므로 창 폭과 무관하다. 즉 문장이 길다는 것이 원인이고,
 * 폭은 그것이 드러나는 조건일 뿐이다.
 *
 * PC의 사정(웹캠·자동 촬영)은 그대로 나르되 절을 하나로 줄인다.
 */
function cameraCopy(env: DeviceEnvironment): { title: string; description: string } {
  if (env.formFactor === 'desktop') {
    return {
      title: CAMERA_TITLE,
      // 데스크톱 웹캠은 화각이 넓고 두 손이 자판에 묶여 있다 — 들고 있는 시간을 짧게 만든다.
      description: '웹캠에 비추면 테두리를 잡아 알아서 찍어요.',
    };
  }
  return { title: CAMERA_TITLE, description: '명함을 비추면 테두리를 잡아 반듯하게 잘라요.' };
}

/**
 * 아직 권한을 물어본 적이 없을 때 덧붙는 한 마디.
 *
 * 짧아야 하는 이유가 있다: 이 절은 **설명 줄 안에** 들어가고, 좁은 칸에서 그 줄이 몇 줄을 쓰는지를
 * 혼자 두 배로 만든다. 뜻은 그대로다 — 물어보는 횟수가 한 번뿐이라는 것.
 */
const PERMISSION_PROMPT_CLAUSE = ' 권한은 한 번만 물어요.';

/**
 * 파일 입구의 문구 (INT-000036에서 다시 씀).
 *
 * 예전 데스크톱 문구는 `끌어다 놓거나`를 카드 설명 안에 넣었다. 두 가지가 어긋나 있었다.
 *
 *  1. **끌어다 놓기는 카드의 사실이 아니라 화면의 사실이다.** 이제 캡처 영역 전체가 드롭
 *     대상이므로(`components/CaptureIntake.tsx`) 그 문장이 카드 한 장에만 붙어 있으면 거짓말이
 *     된다. 구획의 사실은 구획이 말한다 — `intakeAssistHint()` 참고. `CAPTURE_DEFERRED_NOTE`를
 *     카드에서 구획으로 옮긴 것과 같은 규칙이다.
 *  2. 그 문장이 설명 줄 예산(40자)을 정확히 다 썼다. 한 글자만 늘려도 좁은 칸에서 잘렸다.
 *
 * 폰 문구가 끌어다 놓기를 권한 적은 없다. 그 자리는 그대로 둔다.
 */
function uploadCopy(env: DeviceEnvironment): { title: string; description: string } {
  if (env.formFactor === 'desktop') {
    return {
      title: '파일 올리기',
      description: '명함 사진을 골라 올려요. 앞·뒷면 두 장까지 한 번에.',
    };
  }
  return { title: '사진 올리기', description: '앨범에 있는 명함 사진을 골라 올려요.' };
}

/**
 * 붙여넣기 단축키 이름. 기기가 쓰는 자판을 그대로 말한다 —
 * Mac에서 `Ctrl+V`라고 적으면 그 안내는 실제로 아무 일도 하지 않는 손가락을 만든다.
 */
export function pasteShortcutLabel(platform: string = typeof navigator === 'undefined' ? '' : `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? '⌘V' : 'Ctrl+V';
}

/**
 * 캡처 구획이 덧붙이는 두 번째 길 — 끌어다 놓기와 붙여넣기.
 *
 * **터치 기기에는 빈 문자열이다.** 손가락으로는 파일을 끌어다 놓을 수 없고 `Ctrl+V`도 없다.
 * 할 수 없는 일을 권하는 안내는 안내가 아니라 잡음이고, 예전 `DesktopIntake`는 폰에서도
 * `여기로 끌어다 놓아도 되고`를 그대로 보여 주고 있었다.
 *
 * 파일 칸 자체가 없는 브라우저에서도 빈 문자열이다 — 그 기기에서는 이 길이 아예 없다.
 */
export function intakeAssistHint(
  env: Pick<DeviceEnvironment, 'formFactor' | 'hasFileInput'>,
  platform?: string,
): string {
  if (env.formFactor !== 'desktop' || !env.hasFileInput) return '';
  return `사진 파일을 이 화면에 끌어다 놓거나 ${pasteShortcutLabel(platform)}로 붙여넣어도 돼요`;
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
 * `connection`은 여기서 **아무것도 바꾸지 않는다.** 그래도 계속 받는 이유는 그것이 이 파일의
 * 계약 그 자체이기 때문이다 — "연결 상태는 `available`을 절대 뒤집지 못한다"를 단위 테스트가
 * 네 상태 전수로 이 파라미터를 통해 지킨다. 파라미터를 지우면 그 보증도 함께 사라진다.
 *
 * 연결 전 저장 안내는 카드가 아니라 구획이 말한다 — `captureDeferredNote()` 참고.
 */
export function deviceCaptureMethods(
  env: DeviceEnvironment,
  connection: ConnectionState = 'configured',
): CaptureMethodCard[] {
  void connection;
  const cameraBlock = cameraBlockOf(env);
  const camera = cameraCopy(env);
  const upload = uploadCopy(env);

  const byId: Record<CaptureMethodId, CaptureMethodCard> = {
    camera: {
      id: 'camera',
      title: camera.title,
      description: cameraBlock
        ? camera.description
        : `${camera.description}${env.cameraPermission === 'prompt' ? PERMISSION_PROMPT_CLAUSE : ''}`,
      available: !cameraBlock,
      ...(cameraBlock ? { unavailableReason: cameraBlock.reason, recovery: cameraBlock.recovery } : {}),
    },
    upload: env.hasFileInput
      ? { id: 'upload', title: upload.title, description: upload.description, available: true }
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
      description: '명함이 없어도 기억나는 대로 적어 두면 정리해 드려요.',
      available: true,
    },
  };

  return captureMethodOrder().map((id) => byId[id]);
}

// ── 파일 분류 ────────────────────────────────────────────────────────────────

export type IntakeSide = 'front' | 'back';
/** `unreadable`만 판정 시점이 다르다 — 열어 본 뒤에야 알 수 있어 호출자가 돌려준다. */
export type IntakeRejection = 'wrong_type' | 'too_large' | 'slots_full' | 'unreadable';

export interface IntakeFileLike {
  name: string;
  type: string;
  size: number;
}

export interface IntakeAssignment<T extends IntakeFileLike = IntakeFileLike> {
  file: T;
  side: IntakeSide;
}

/**
 * 거절된 한 장. **파일 자신을 들고 있다.**
 *
 * 예전에는 이름 문자열만 남겼다. 그래서 "자리가 없어 빠진 장"을 나중에 다시 쓰려면 이름으로
 * 원본을 되찾아야 했는데, 같은 이름의 파일 두 장은 구별되지 않는다. 자리가 다 찼을 때
 * `어디에 넣을까요?`를 물으려면 그 장을 손에 쥐고 있어야 한다 (`planIntakeFiles`).
 */
export interface IntakeRejected<T extends IntakeFileLike = IntakeFileLike> {
  file: T;
  reason: IntakeRejection;
}

export interface IntakeTriage<T extends IntakeFileLike = IntakeFileLike> {
  accepted: IntakeAssignment<T>[];
  rejected: IntakeRejected<T>[];
}

/** 20MB. 폰 카메라 원본 한 장이 넉넉히 들어가고, 브라우저가 dataURL로 들고 있어도 버틴다. */
export const MAX_INTAKE_BYTES = 20 * 1024 * 1024;

export const intakeRejectionMessage: Record<IntakeRejection, string> = {
  wrong_type: '이미지 파일이 아니라 뺐어요 (jpg·png·heic 같은 사진 파일이면 됩니다)',
  too_large: '20MB가 넘어 뺐어요. 조금 줄여서 다시 올려 주세요',
  slots_full: '한 사람은 앞·뒷면 두 장까지예요. 나머지는 다음 사람으로 따로 올려 주세요',
  unreadable: '사진을 열지 못했어요. 파일이 깨졌거나 이 브라우저가 모르는 형식이에요',
};

/** 이름과 이유를 한 줄로 붙인다. 이유만 남고 무엇이었는지 모르는 문장을 만들지 않는다. */
export function intakeRejectionLine(name: string, reason: IntakeRejection): string {
  return `${name} — ${intakeRejectionMessage[reason]}`;
}

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
  const rejected: IntakeRejected<T>[] = [];

  for (const file of files) {
    if (!/^image\//i.test(file.type || '')) {
      rejected.push({ file, reason: 'wrong_type' });
      continue;
    }
    if (file.size > maxBytes) {
      rejected.push({ file, reason: 'too_large' });
      continue;
    }
    const side = open.shift();
    if (!side) {
      rejected.push({ file, reason: 'slots_full' });
      continue;
    }
    accepted.push({ file, side });
  }

  return { accepted, rejected };
}

export interface IntakePlan<T extends IntakeFileLike = IntakeFileLike> extends IntakeTriage<T> {
  /**
   * 앞·뒷면이 다 차서 자리를 못 얻은 **첫 장**. 있으면 화면이 `어디에 넣을까요?`를 묻는다.
   *
   * 두 장 이상 남았을 때 전부 묻지는 않는다 — 세 번째 장의 자리를 묻는 질문에는 사람이 답할
   * 근거가 없다. 첫 장만 질문이 되고 나머지는 이유가 붙은 통보로 남는다.
   */
  replaceCandidate: T | null;
  /** 화면에 그대로 내보낼 문장들. `replaceCandidate`는 여기 없다 — 그것은 질문이지 통보가 아니다. */
  notes: string[];
}

/**
 * 받은 파일 묶음을 **화면이 할 일 전부**로 바꾼다 (INT-000036).
 *
 * `triageIntakeFiles`는 "어느 자리에 갈 수 있는가"만 판정한다. 그 위에 이 함수가 두 가지를 더한다:
 * 자리가 다 찼을 때 되물을 대상 한 장과, 사람이 읽을 문장들. 화면 세 곳(카드에서 고르기·
 * 끌어다 놓기·붙여넣기)이 전부 이 하나를 통과하므로 경로마다 다른 말을 하지 않는다.
 */
export function planIntakeFiles<T extends IntakeFileLike>(
  files: readonly T[],
  options: { hasFront?: boolean; hasBack?: boolean; maxBytes?: number } = {},
): IntakePlan<T> {
  const triage = triageIntakeFiles(files, options);
  const firstFull = triage.rejected.findIndex((item) => item.reason === 'slots_full');
  const replaceCandidate = firstFull >= 0 ? triage.rejected[firstFull].file : null;
  const notes = triage.rejected
    .filter((_item, index) => index !== firstFull)
    .map((item) => intakeRejectionLine(item.file.name, item.reason));
  return { ...triage, replaceCandidate, notes };
}
