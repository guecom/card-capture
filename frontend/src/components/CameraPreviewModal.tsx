import {
  IonButton,
  IonContent,
  IonHeader,
  IonModal,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, Image as ImageIcon, Lightbulb } from 'lucide-react';
import {
  CandidateCameraError,
  cameraHasTorch,
  type CapturedCameraFrame,
  canvasFromImageData,
  cropCanvasRegion,
  fileToCameraFrame,
  finalizeCameraFrame,
  openEnvironmentCamera,
  setCameraTorch,
  stopCameraStream,
} from '../services/camera';
import { getOpenCvWorker, type OpenCvWorkerClient, plausibleCard, type Point } from '../services/opencv';
import { getCardQuadModelWorker, type CardQuadModelClient } from '../services/card-quad-model';
import {
  activeCardQuadModelQuad,
  blankCardQuadModelGate,
  negativeCardQuadModelGate,
  positiveCardQuadModelGate,
  unavailableCardQuadModelGate,
} from '../services/card-quad-gate';
import { agreeCardQuad } from '../services/card-quad-agreement';
import { blankAutoCaptureState, nextAutoCaptureState } from '../services/auto-capture';
import { assessCaptureMotionBurst, captureMotionFrame, type CaptureMotionFrame } from '../services/capture-stability';
import { blankQuadTrackState, nextQuadTrackState } from '../services/quad-tracker';
import { type CoverMap, coverMapInBox, guideRectDisplay, guideRectInVideo, lerpQuad, rectToQuad, videoPointToDisplay } from '../services/stage-geometry';

// 촬영 전용 모달 — 맥락 입력·이름 확인·완료는 legacy처럼 메인 화면이 소유한다 (ISS-000091 항목 18).
// 명함 감지 엔진(OpenCV)은 Web Worker에서만 돌아 이 화면의 버튼은 어떤 시점에도 잠기지 않는다 (TSK-000230).
type PreviewPhase = 'idle' | 'requesting' | 'streaming' | 'choice' | 'error';
export type CardSide = 'front' | 'back';

export interface CapturedSideMeta {
  cropState: 'rectified' | 'guide' | 'full' | 'native';
  blurry: boolean;
  source: 'manual' | 'auto' | 'native';
}

const failureCopy: Record<string, string> = {
  unsupported: '이 브라우저는 직접 카메라 미리보기를 지원하지 않습니다.',
  permission_denied: '카메라 권한이 꺼져 있습니다. 브라우저 설정에서 허용하거나 기본 카메라를 사용하세요.',
  camera_unavailable: '후면 카메라를 찾지 못했습니다. 기본 카메라로 계속할 수 있습니다.',
  camera_busy: '다른 앱이 카메라를 사용 중입니다. 닫은 뒤 다시 시도하세요.',
  camera_failed: '카메라를 시작하지 못했습니다. 기본 카메라로 계속하세요.',
};

// 비디오 프레임 → 오버레이 좌표 매핑. 두 엘리먼트가 실제로 그려진 상자를 매 프레임 재서 만든다.
// 상자가 같다고 가정하면 레이아웃이 바뀌는 순간 감지 박스가 명함에서 통째로 떨어진다 (ISS-000098).
function stageCoverMap(video: HTMLVideoElement, overlay: HTMLCanvasElement): CoverMap {
  const videoBox = video.getBoundingClientRect();
  const overlayBox = overlay.getBoundingClientRect();
  // 오버레이가 숨겨진 순간(rect 0)에는 비디오 상자를 그대로 좌표계로 쓴다.
  const reference = overlayBox.width > 0 && overlayBox.height > 0 ? overlayBox : videoBox;
  return coverMapInBox(video.videoWidth, video.videoHeight, videoBox, reference);
}

function quadPath(context: CanvasRenderingContext2D, quad: Point[]): void {
  context.beginPath();
  context.moveTo(quad[0].x, quad[0].y);
  context.lineTo(quad[1].x, quad[1].y);
  context.lineTo(quad[2].x, quad[2].y);
  context.lineTo(quad[3].x, quad[3].y);
  context.closePath();
}

function drawCorners(context: CanvasRenderingContext2D, quad: Point[], length: number, color: string, width: number): void {
  context.strokeStyle = color;
  context.lineWidth = width;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (let index = 0; index < 4; index += 1) {
    const point = quad[index];
    const previous = quad[(index + 3) % 4];
    const next = quad[(index + 1) % 4];
    const previousDistance = Math.hypot(previous.x - point.x, previous.y - point.y) || 1;
    const nextDistance = Math.hypot(next.x - point.x, next.y - point.y) || 1;
    const previousLength = Math.min(length, previousDistance * 0.4);
    const nextLength = Math.min(length, nextDistance * 0.4);
    context.beginPath();
    context.moveTo(point.x + (previous.x - point.x) / previousDistance * previousLength, point.y + (previous.y - point.y) / previousDistance * previousLength);
    context.lineTo(point.x, point.y);
    context.lineTo(point.x + (next.x - point.x) / nextDistance * nextLength, point.y + (next.y - point.y) / nextDistance * nextLength);
    context.stroke();
  }
}

// 자동 촬영 진행 링 — legacy 셔터의 conic 진행 표시를 스테이지 하단 중앙에 재현한다.
function drawProgressRing(context: CanvasRenderingContext2D, width: number, height: number, progress: number): void {
  const radius = 21;
  const centerX = width / 2;
  const centerY = height - radius - 16;
  context.beginPath();
  context.arc(centerX, centerY, radius, 0, Math.PI * 2);
  context.strokeStyle = 'rgba(255,255,255,0.3)';
  context.lineWidth = 4;
  context.stroke();
  context.beginPath();
  context.arc(centerX, centerY, radius, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, progress));
  context.strokeStyle = '#39dfc1';
  context.lineWidth = 4;
  context.stroke();
}

type VideoFrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number, metadata: { mediaTime?: number; presentedFrames?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  getVideoPlaybackQuality?: () => { totalVideoFrames: number; droppedVideoFrames: number };
};

function presentedVideoFrameCount(video: HTMLVideoElement): number | null {
  const quality = (video as VideoFrameCallbackVideo).getVideoPlaybackQuality?.();
  if (!quality) return null;
  const presented = quality.totalVideoFrames - quality.droppedVideoFrames;
  return Number.isFinite(presented) && presented >= 0 ? presented : null;
}

// 실제로 새 camera frame이 도착한 뒤에만 다음 sample을 읽는다. 단순 timeout만 쓰면
// 느린 폰에서 같은 frame을 세 번 읽고 "안정"으로 오판할 수 있다.
function waitForNextVideoFrame(video: HTMLVideoElement, afterFrame: number | null, timeoutMs = 320): Promise<number | null> {
  const candidate = video as VideoFrameCallbackVideo;
  const requestVideoFrame = typeof candidate.requestVideoFrameCallback === 'function'
    ? candidate.requestVideoFrameCallback.bind(candidate)
    : null;
  return new Promise((resolve) => {
    let settled = false;
    let callbackHandle = 0;
    let animationHandle = 0;
    const finish = (mediaTime: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutHandle);
      if (callbackHandle && candidate.cancelVideoFrameCallback) candidate.cancelVideoFrameCallback(callbackHandle);
      if (animationHandle) cancelAnimationFrame(animationHandle);
      resolve(mediaTime);
    };
    const timeoutHandle = window.setTimeout(() => finish(null), timeoutMs);
    if (requestVideoFrame) {
      // 이 callback 자체가 compositor에 새 frame이 제출될 때 한 번만 호출된다.
      callbackHandle = requestVideoFrame((_now, metadata) => {
        finish(metadata.presentedFrames ?? metadata.mediaTime ?? (afterFrame ?? 0) + 1);
      });
      return;
    }
    // currentTime은 playback clock일 뿐 frame identity가 아니다. callback API가 없는
    // WebView에서는 실제 표시 frame counter가 있을 때만 진행하고, 없으면 fail-closed한다.
    if (afterFrame === null) {
      finish(null);
      return;
    }
    const poll = () => {
      const frameCount = presentedVideoFrameCount(video);
      if (frameCount === null) finish(null);
      else if (frameCount > afterFrame) finish(frameCount);
      else animationHandle = requestAnimationFrame(poll);
    };
    poll();
  });
}

async function freezeStableAutoFrame(
  video: HTMLVideoElement,
  reference: CaptureMotionFrame,
  isActive: () => boolean,
): Promise<{ canvas: HTMLCanvasElement | null; reason: 'stable' | 'motion' | 'frame_timeout' }> {
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = 48;
  sampleCanvas.height = Math.max(1, Math.round(48 * video.videoHeight / video.videoWidth));
  const sampleContext = sampleCanvas.getContext('2d');
  if (!sampleContext) return { canvas: null, reason: 'frame_timeout' };

  const samples: CaptureMotionFrame[] = [];
  const candidate = video as VideoFrameCallbackVideo;
  const hasVideoFrameCallback = typeof candidate.requestVideoFrameCallback === 'function';
  let frameIdentity = hasVideoFrameCallback ? null : presentedVideoFrameCount(video);
  if (!hasVideoFrameCallback && frameIdentity === null) {
    return { canvas: null, reason: 'frame_timeout' };
  }
  for (let index = 0; index < 3; index += 1) {
    const nextFrame = await waitForNextVideoFrame(video, frameIdentity);
    if (nextFrame === null || !isActive()) return { canvas: null, reason: 'frame_timeout' };
    frameIdentity = nextFrame;
    sampleContext.drawImage(video, 0, 0, sampleCanvas.width, sampleCanvas.height);
    samples.push(captureMotionFrame(sampleContext.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height)));
  }

  const assessment = assessCaptureMotionBurst(reference, samples);
  if (!assessment.stable) return { canvas: null, reason: 'motion' };

  // motion 판정을 통과한 마지막 presented frame을 바로 얼린다. 이후 warp·sharpness
  // 검사가 느려져도 결과는 이 canvas에서 나오므로 더 최신의 흔들린 video frame으로 바뀌지 않는다.
  const full = document.createElement('canvas');
  full.width = video.videoWidth;
  full.height = video.videoHeight;
  const fullContext = full.getContext('2d');
  if (!fullContext) return { canvas: null, reason: 'frame_timeout' };
  fullContext.drawImage(video, 0, 0);
  return { canvas: full, reason: 'stable' };
}

export function CameraCaptureModal({
  isOpen,
  initialSide,
  withBackChoice,
  galleryFree = true,
  onDismiss,
  onCaptured,
  onFinished,
}: {
  isOpen: boolean;
  initialSide: CardSide;
  withBackChoice: boolean;
  /** true면 OS 기본 카메라 앱을 평상시 동선에서 빼 둔다 — 그 앱이 만드는 갤러리 사본은 지울 수 없다 (ISS-000102). */
  galleryFree?: boolean;
  onDismiss: () => void;
  onCaptured: (side: CardSide, frame: CapturedCameraFrame, meta: CapturedSideMeta) => void;
  onFinished: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<OpenCvWorkerClient | null>(null);
  const modelWorkerRef = useRef<CardQuadModelClient | null>(null);
  const autoGateRef = useRef(blankAutoCaptureState());
  const quadTrackRef = useRef(blankQuadTrackState());
  const capturingRef = useRef(false);
  const captureGenerationRef = useRef(0);
  const liveQuadRef = useRef<{ quad: Point[]; at: number } | null>(null);
  const displayQuadRef = useRef<Point[] | null>(null);
  const detectedSinceRef = useRef(0);
  const autoProgressRef = useRef(0);
  // 다음 장을 위해 자동 촬영을 다시 무장할지. 뒷면/재촬영으로 돌아온 직후에는 꺼 둔다 —
  // 안 그러면 사용자가 명함을 뒤집기도 전에(실측 1.5초) 앞면이 뒷면으로 다시 찍힌다 (founder 판정 2026-07-26).
  const autoArmedRef = useRef(true);
  const rearmAtRef = useRef(0);
  // 직전 프레임의 감지 사각형(감지용 축소 프레임 좌표). 워커가 후보를 고를 때 기준으로 써서
  // 프레임마다 다른 후보가 이기며 박스가 떠는 것을 막는다 (TSK-000244).
  const lastDetectQuadRef = useRef<Point[] | null>(null);
  const modelGateRef = useRef(blankCardQuadModelGate());
  // 감지용 다운스케일 캔버스는 한 번만 만들어 재사용한다 (모바일 GC 부담 축소).
  const detectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>('idle');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [side, setSide] = useState<CardSide>(initialSide);
  const sideRef = useRef(side);
  sideRef.current = side;
  const [detail, setDetail] = useState('');
  const [cvState, setCvState] = useState('명함 감지 엔진 대기');
  const [choiceThumb, setChoiceThumb] = useState('');
  const [autoCapture, setAutoCapture] = useState(() => localStorage.getItem('cc_autoCapture') !== 'off');
  const autoCaptureEnabledRef = useRef(autoCapture);
  autoCaptureEnabledRef.current = autoCapture;
  const [autoHint, setAutoHint] = useState('명함을 화면 안에 담아 주세요');
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const invalidatePendingCapture = useCallback(() => {
    captureGenerationRef.current += 1;
    capturingRef.current = false;
  }, []);

  const stopPreview = useCallback(() => {
    invalidatePendingCapture();
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchAvailable(false);
    setTorchOn(false);
    autoGateRef.current = blankAutoCaptureState();
    quadTrackRef.current = blankQuadTrackState();
    autoProgressRef.current = 0;
    liveQuadRef.current = null;
    displayQuadRef.current = null;
    detectedSinceRef.current = 0;
    lastDetectQuadRef.current = null;
    modelGateRef.current = blankCardQuadModelGate();
  }, [invalidatePendingCapture]);

  useEffect(() => stopPreview, [stopPreview]);

  const resumeStreaming = useCallback((nextSide: CardSide) => {
    // 선택지에서 뒷면/앞면 재촬영으로 복귀 — 스트림은 살아 있으므로 즉시 촬영 가능 (legacy camGoBack2).
    setSide(nextSide);
    invalidatePendingCapture();
    autoGateRef.current = blankAutoCaptureState();
    quadTrackRef.current = blankQuadTrackState();
    autoProgressRef.current = 0;
    liveQuadRef.current = null;
    detectedSinceRef.current = 0;
    lastDetectQuadRef.current = null;
    modelGateRef.current = blankCardQuadModelGate();
    // 방금 찍은 장이 그대로 다시 찍히지 않도록, 명함이 한 번 화면에서 벗어난 뒤에만 자동 촬영을 재개한다.
    autoArmedRef.current = false;
    rearmAtRef.current = performance.now();
    setAutoHint(nextSide === 'back' ? '명함을 뒤집어 뒷면을 대주세요' : '앞면을 다시 대주세요');
    setPhase('streaming');
  }, [invalidatePendingCapture]);

  const startPreview = useCallback(async (nextSide: CardSide) => {
    stopPreview();
    setSide(nextSide);
    setChoiceThumb('');
    setPhase('requesting');
    setDetail(`${nextSide === 'front' ? '앞면' : '뒷면'} 촬영을 위해 후면 카메라 권한을 확인하고 있어요.`);
    setAutoHint('명함을 화면 안에 담아 주세요');
    autoArmedRef.current = true; // 새 세션은 바로 찍을 준비가 된 상태다.
    try {
      const stream = await openEnvironmentCamera();
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new CandidateCameraError('camera_failed');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      setTorchAvailable(cameraHasTorch(stream));
      setPhase('streaming');
      setDetail('');
      // 엔진은 앱 시작 직후 워커에서 미리 기동된다 — 보통 여기 도달하면 이미 준비 완료다.
      const client = getOpenCvWorker();
      workerRef.current = client;
      const startModelClient = () => {
        const modelClient = getCardQuadModelWorker();
        modelWorkerRef.current = modelClient;
        if (modelClient.isReady()) {
          setCvState('명함 전용 AI·경계 검증 준비됨');
        } else {
          void modelClient.ready.then((ok) => {
            if (phaseRef.current !== 'streaming') return;
            if (!ok) modelGateRef.current = unavailableCardQuadModelGate(performance.now());
            setCvState(ok ? '명함 전용 AI·경계 검증 준비됨' : 'AI 경계 검증 불가 · 수동 안전 촬영만 가능');
          });
        }
      };
      if (client.isReady()) {
        setCvState('명함 감지·자동 촬영 준비됨');
        startModelClient();
      } else {
        const startedAt = Date.now();
        setCvState('명함 감지 엔진 준비 중… 지금도 촬영할 수 있어요');
        const ticker = window.setInterval(() => {
          if (client.isReady()) { window.clearInterval(ticker); return; }
          setCvState(`명함 감지 엔진 준비 중 ${Math.round((Date.now() - startedAt) / 1000)}초… 지금도 촬영할 수 있어요`);
        }, 1_000);
        void client.ready.then((ok) => {
          window.clearInterval(ticker);
          setCvState(ok ? '명함 감지·자동 촬영 준비됨' : '전체 프레임 fallback 준비됨');
          if (ok) startModelClient();
        });
      }
    } catch (error) {
      stopPreview();
      const code = error instanceof CandidateCameraError ? error.code : 'camera_failed';
      setPhase('error');
      setDetail(failureCopy[code]);
    }
  }, [stopPreview]);

  const capturePreviewFrame = useCallback(async (
    source: 'manual' | 'auto' = 'manual',
    motionReference: CaptureMotionFrame | null = null,
  ) => {
    const video = videoRef.current;
    if (!video || (source === 'auto' && capturingRef.current)) return;
    // 수동 shutter는 진행 중 auto hold를 취소하고 즉시 새 capture generation을 시작한다.
    const captureGeneration = captureGenerationRef.current + 1;
    captureGenerationRef.current = captureGeneration;
    capturingRef.current = true;
    const captureSide = sideRef.current;
    const isCaptureCurrent = () => (
      captureGenerationRef.current === captureGeneration
      && capturingRef.current
      && phaseRef.current === 'streaming'
      && (source === 'manual' || autoCaptureEnabledRef.current)
    );
    try {
      if (!video.videoWidth) throw new CandidateCameraError('frame_not_ready');
      let full: HTMLCanvasElement;
      if (source === 'auto') {
        const frozen = motionReference
          ? await freezeStableAutoFrame(video, motionReference, isCaptureCurrent)
          : { canvas: null, reason: 'frame_timeout' as const };
        if (!frozen.canvas) {
          if (isCaptureCurrent()) {
            autoGateRef.current = blankAutoCaptureState();
            autoProgressRef.current = 0;
            capturingRef.current = false;
            setAutoHint(frozen.reason === 'motion'
              ? '카메라가 움직였어요 · 다시 고정해 주세요'
              : '새 카메라 프레임을 기다리는 중 · 잠시 고정해 주세요');
          }
          return;
        }
        full = frozen.canvas;
      } else {
        full = document.createElement('canvas');
        full.width = video.videoWidth;
        full.height = video.videoHeight;
        const context = full.getContext('2d');
        if (!context) throw new CandidateCameraError('camera_failed');
        context.drawImage(video, 0, 0);
      }
      if (!isCaptureCurrent()) return;
      const fullContext = full.getContext('2d');
      if (!fullContext) throw new CandidateCameraError('camera_failed');

      let result: HTMLCanvasElement | null = null;
      let cropState: CapturedSideMeta['cropState'] = 'full';
      const client = workerRef.current;
      if (client?.isReady()) {
        // 1순위: 화면에서 방금 보여 준 사각형 그대로 잘라낸다 (WYSIWYG).
        // 촬영 시점에 처음부터 다시 찾으면 화면에서는 잡혔는데 결과물은 안 잘리는 일이 생긴다.
        const live = liveQuadRef.current;
        const fresh = live && performance.now() - live.at < 1_500 ? live.quad : null;
        if (fresh) {
          try {
            const image = fullContext.getImageData(0, 0, full.width, full.height);
            const warped = await client.warp(image, fresh);
            if (!isCaptureCurrent()) return;
            if (warped) {
              result = canvasFromImageData(warped);
              cropState = 'rectified';
            }
          } catch {
            // getImageData 불가 → 아래 경로로.
          }
        }
      }
      if (!isCaptureCurrent()) return;
      if (!result) {
        // 감지 실패 폴백: 화면 가이드 영역만 잘라 배경 전체가 올라가지 않게 한다 (legacy 규칙).
        const overlay = overlayRef.current;
        if (overlay) {
          const map = stageCoverMap(video, overlay);
          const region = guideRectInVideo(map);
          const cropped = region ? cropCanvasRegion(full, region) : null;
          if (cropped) {
            result = cropped;
            cropState = 'guide';
          }
        }
      }
      const finalCanvas = result ?? full;

      // 촬영 직후 흐림 점수 경고 (legacy blurScore < 45) — 워커에서 계산.
      let blurScore: number | null = null;
      if (client?.isReady()) {
        try {
          const scale = Math.min(1, 600 / Math.max(1, finalCanvas.width));
          const check = document.createElement('canvas');
          check.width = Math.max(1, Math.round(finalCanvas.width * scale));
          check.height = Math.max(1, Math.round(finalCanvas.height * scale));
          const checkContext = check.getContext('2d');
          checkContext?.drawImage(finalCanvas, 0, 0, check.width, check.height);
          const image = checkContext?.getImageData(0, 0, check.width, check.height);
          blurScore = image ? await client.blurScore(image) : null;
          if (!isCaptureCurrent()) return;
        } catch {
          blurScore = null;
        }
      }
      if (!isCaptureCurrent()) return;
      const blurry = blurScore !== null && blurScore < 45;
      // 자동 경로는 실제 저장할 frozen frame의 선명도를 확인하지 못해도 fail-closed다.
      // 수동 shutter는 사용자의 명시 행동이므로 기존처럼 저장하고 가능한 경우 경고만 남긴다.
      if (source === 'auto' && (blurScore === null || blurry)) {
        autoGateRef.current = blankAutoCaptureState();
        autoProgressRef.current = 0;
        capturingRef.current = false;
        setAutoHint('실제 촬영 프레임이 흐려요 · 다시 고정해 주세요');
        return;
      }

      const frame = finalizeCameraFrame(finalCanvas);
      if (!isCaptureCurrent()) return;
      onCaptured(captureSide, frame, { cropState, blurry, source });
      // 앞면·뒷면 모두 "이대로 괜찮은지" 확인 단계를 거친다. 뒷면만 확인 없이 닫히던 것을
      // founder가 지적했다(2026-07-26) — 자동 촬영이면 사용자는 결과를 볼 기회조차 없었다.
      setChoiceThumb(frame.dataUrl);
      setPhase('choice');
      capturingRef.current = false;
    } catch {
      if (!isCaptureCurrent()) return;
      capturingRef.current = false;
      setPhase('error');
      setDetail('카메라 프레임이 아직 준비되지 않았습니다. 다시 시도하거나 기본 카메라를 사용하세요.');
    }
  }, [onCaptured, onFinished, stopPreview, withBackChoice]);

  // 명함 감지 루프: 프레임을 워커로 보내고 결과만 받는다. 자동 촬영이 꺼져 있어도 오버레이 표시는 계속한다.
  useEffect(() => {
    if (phase !== 'streaming') return;
    let deepCounter = 0;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      const client = workerRef.current;
      const modelClient = modelWorkerRef.current;
      if (!video || !video.videoWidth || capturingRef.current) return;
      if (!client?.isReady()) {
        setAutoHint('감지 엔진 준비 중 · 지금 찍어도 저장됩니다');
        return;
      }
      const canvas = detectCanvasRef.current ?? (detectCanvasRef.current = document.createElement('canvas'));
      const targetHeight = Math.max(1, Math.round(320 * video.videoHeight / video.videoWidth));
      if (canvas.width !== 320) canvas.width = 320;
      if (canvas.height !== targetHeight) canvas.height = targetHeight;
      const context = canvas.getContext('2d');
      if (!context || typeof context.getImageData !== 'function') return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      deepCounter += 1;
      if (deepCounter % 3 === 0 && modelClient?.isReady()) {
        try {
          const modelImage = context.getImageData(0, 0, canvas.width, canvas.height);
          void modelClient.detect(modelImage).then((result) => {
            if (phaseRef.current !== 'streaming' || capturingRef.current) return;
            // null은 busy/timeout/worker 오류다. 이를 명함 없음으로 오해하면 느린 폰에서
            // 학습 모델이 끝나기 전에 gate가 닫힌다. 명시적인 quad:null 응답만 negative다.
            if (result === null) return;
            if (result.quad && plausibleCard(result.quad)) {
              modelGateRef.current = positiveCardQuadModelGate(
                result.quad,
                result.confidence,
                performance.now(),
              );
            } else {
              modelGateRef.current = negativeCardQuadModelGate(modelGateRef.current, performance.now());
            }
          });
        } catch {
          // 모델 입력을 검증할 수 없으면 자동 경계 경로는 fail-closed로 유지한다.
        }
      }
      let image: ImageData;
      try {
        image = context.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        return;
      }
      const frameWidth = canvas.width;
      const frameHeight = canvas.height;
      // worker 전송은 image buffer를 detach한다. 그 전에 작은 luminance fingerprint를
      // 복사해 두고, ready 뒤 실제 저장 frame까지 움직임이 없었는지 비교한다.
      const motionReference = autoCapture ? captureMotionFrame(image) : null;
      const videoScale = video.videoWidth / frameWidth;
      const modelGate = modelGateRef.current;
      const learnedSeed = activeCardQuadModelQuad(modelGate, performance.now());
      // 명함 전용 모델은 후보를 제안하고 OpenCV가 실제 edge support를 확인한다.
      // 모델 단독 결과는 화면 박스나 자동 촬영에 직접 사용하지 않는다.
      const seedQuad = learnedSeed ?? lastDetectQuadRef.current;
      void client.analyze(image, { minAreaRatio: 0.07, fast: deepCounter % 3 !== 0, withGate: autoCapture, previousQuad: seedQuad }).then((analysis) => {
        if (!analysis) return; // 이전 프레임 분석 중 — 이 프레임은 버림(자연 스로틀).
        if (phaseRef.current !== 'streaming' || capturingRef.current) return;
        const now = performance.now();
        const latestModelGate = modelGateRef.current;
        const activeModelQuad = activeCardQuadModelQuad(latestModelGate, now);
        // 학습 모델의 positive는 전역 허가가 아니다. 같은 프레임 좌표에서 OpenCV
        // 후보와 위치·크기·꼭짓점이 일치할 때만 경계가 다음 단계로 갈 수 있다.
        const agreement = agreeCardQuad(activeModelQuad, analysis.quad, frameWidth, frameHeight);
        const verifiedQuad = agreement.accepted ? analysis.quad : null;
        const verificationConfidence = Math.min(latestModelGate.confidence, agreement.confidence);
        if (!verifiedQuad || !plausibleCard(verifiedQuad)) {
          quadTrackRef.current = nextQuadTrackState(quadTrackRef.current, null, frameWidth, frameHeight, 0);
          liveQuadRef.current = null;
          if (autoCapture) {
            autoGateRef.current = nextAutoCaptureState(autoGateRef.current, { detected: false }, now);
            autoProgressRef.current = 0;
          }
          // 모델 waiting/negative는 그 자체로 "명함을 치움"이 아니다. 뒷면 전환 직후
          // 아직 같은 장이 보이는데 모델을 기다린다는 이유로 재무장하면 앞면이 뒷면으로
          // 자동 촬영된다. OpenCV 경계도 실제로 사라진 프레임에서만 재무장한다.
          if (!analysis.quad || !plausibleCard(analysis.quad)) autoArmedRef.current = true;
          lastDetectQuadRef.current = null;
          setAutoHint(latestModelGate.status === 'unavailable'
            ? 'AI 경계 검증을 사용할 수 없어요 · 아래 버튼으로 안전 촬영해 주세요'
            : latestModelGate.status === 'waiting'
              ? '명함 여부를 확인 중… 잠시 고정해 주세요'
              : '명함 네 모서리를 맞추는 중… 잠시 고정해 주세요');
          return;
        }
        quadTrackRef.current = nextQuadTrackState(
          quadTrackRef.current,
          verifiedQuad,
          frameWidth,
          frameHeight,
          verificationConfidence,
        );
        const tracked = quadTrackRef.current;
        if (!tracked.accepted || !tracked.locked) {
          liveQuadRef.current = null;
          if (autoCapture) {
            autoGateRef.current = nextAutoCaptureState(autoGateRef.current, { detected: false }, now);
            autoProgressRef.current = 0;
          }
          lastDetectQuadRef.current = tracked.locked;
          setAutoHint(tracked.status === 'rejected' ? '명함 네 모서리를 다시 맞춰 주세요' : '명함 경계를 확인 중 · 잠시 고정해 주세요');
          return;
        }
        lastDetectQuadRef.current = tracked.locked;
        liveQuadRef.current = { quad: tracked.locked.map((point) => ({ x: point.x * videoScale, y: point.y * videoScale })), at: now };
        if (!autoCapture) {
          setAutoHint('인식됨 · 아래 버튼으로 촬영할 수 있어요');
          return;
        }
        if (!autoArmedRef.current) {
          // 아직 방금 찍은 장이 그대로 보이는 상태 — 자동으로 찍지 않는다. 수동 버튼은 언제나 열려 있다.
          autoGateRef.current = blankAutoCaptureState();
          autoProgressRef.current = 0;
          setAutoHint(now - rearmAtRef.current > 4_000
            ? '준비되면 아래 버튼으로 촬영하세요'
            : (sideRef.current === 'back' ? '명함을 뒤집어 뒷면을 대주세요' : '앞면을 다시 대주세요'));
          return;
        }
        autoGateRef.current = nextAutoCaptureState(autoGateRef.current, {
          detected: true,
          plausible: true,
          quad: tracked.locked,
          frameWidth,
          frameHeight,
          blur: analysis.blur,
          clippedRatio: analysis.clippedRatio,
        }, now);
        const gate = autoGateRef.current;
        autoProgressRef.current = gate.progress;
        setAutoHint(gate.reason === 'blur' ? '조금 흐려요 · 휴대폰을 고정해 주세요'
          : gate.reason === 'glare' ? '빛 반사를 줄여 주세요'
            : gate.fired ? '좋아요 · 자동 촬영 중'
              : '인식됨 · 잠시 고정하면 자동 촬영해요');
        if (gate.fired) void capturePreviewFrame('auto', motionReference);
      });
    }, 180);
    return () => window.clearInterval(interval);
  }, [autoCapture, capturePreviewFrame, phase]);

  // 오버레이 렌더 루프: 감지 사각형·코너 브래킷·주변 스크림·보간·자동 촬영 진행 링 (legacy camLoop 렌더).
  useEffect(() => {
    if (phase !== 'streaming') return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const overlay = overlayRef.current;
      const video = videoRef.current;
      if (!overlay || !video) return;
      const width = overlay.clientWidth;
      const height = overlay.clientHeight;
      if (!width || !height) return;
      if (overlay.width !== width) overlay.width = width;
      if (overlay.height !== height) overlay.height = height;
      const context = overlay.getContext('2d');
      // 일부 WebView가 제한된 2D context를 줄 수 있다 — 오버레이는 장식이므로 조용히 건너뛴다.
      if (!context || typeof context.clearRect !== 'function') return;
      context.clearRect(0, 0, width, height);

      const now = performance.now();
      const live = liveQuadRef.current;
      // 느린 기기에서 왕복이 길어져도 박스가 카드에서 떨어지지 않도록 유지 시간을 넉넉히 둔다.
      const detected = Boolean(live && now - live.at < 1_100);
      if (detected) {
        if (!detectedSinceRef.current) detectedSinceRef.current = now;
      } else {
        detectedSinceRef.current = 0;
      }
      const locked = detected && now - detectedSinceRef.current > 420;

      let target: Point[];
      if (detected && live) {
        const map = stageCoverMap(video, overlay);
        target = live.quad.map((point) => videoPointToDisplay(map, point));
      } else {
        target = rectToQuad(guideRectDisplay(width, height));
      }
      // 적응형 보간: 조금 움직이면 천천히(떨림 제거), 크게 움직이면 빠르게(반응 유지).
      const drift = displayQuadRef.current
        ? displayQuadRef.current.reduce((total, point, corner) => total + Math.hypot(point.x - target[corner].x, point.y - target[corner].y), 0) / 4
        : Number.POSITIVE_INFINITY;
      const factor = !detected ? 0.18 : (drift < 2 ? 0.08 : drift < 10 ? 0.2 : 0.45);
      displayQuadRef.current = lerpQuad(displayQuadRef.current, target, factor);
      const quad = displayQuadRef.current;

      // 주변만 은은하게 어둡게 — 명함이 화면에서 떠오르도록.
      context.fillStyle = detected ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.34)';
      context.fillRect(0, 0, width, height);
      context.save();
      context.globalCompositeOperation = 'destination-out';
      quadPath(context, quad);
      context.fill();
      context.restore();

      quadPath(context, quad);
      context.lineJoin = 'round';
      context.lineWidth = 1.5;
      context.setLineDash(detected ? [] : [10, 8]); // 점선 = 아직 명함을 못 찾은 대기 프레임
      context.strokeStyle = locked ? 'rgba(255,255,255,0.95)' : (detected ? 'rgba(255,255,255,0.68)' : 'rgba(255,255,255,0.36)');
      if (locked) {
        context.fillStyle = 'rgba(255,255,255,0.05)';
        context.fill();
      }
      context.stroke();
      context.setLineDash([]);
      if (detected) drawCorners(context, quad, locked ? 26 : 20, locked ? 'rgba(255,255,255,0.98)' : 'rgba(255,255,255,0.82)', locked ? 2.5 : 2);
      if (autoCapture && autoProgressRef.current > 0) drawProgressRing(context, width, height, autoProgressRef.current);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [autoCapture, phase]);

  const handleNativeFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setPhase('requesting');
    setDetail('기본 카메라 사진을 준비하고 있어요.');
    try {
      const frame = await fileToCameraFrame(file);
      onCaptured(sideRef.current, frame, { cropState: 'native', blurry: false, source: 'native' });
      stopPreview();
      onFinished();
    } catch {
      setPhase('error');
      setDetail('사진을 읽지 못했습니다. 다시 시도해 주세요.');
    }
  }, [onCaptured, onFinished, stopPreview]);

  const beginSession = useCallback(() => {
    setChoiceThumb('');
    void startPreview(initialSide);
  }, [initialSide, startPreview]);

  const toggleAutoCapture = useCallback(() => {
    const next = !autoCaptureEnabledRef.current;
    autoCaptureEnabledRef.current = next;
    setAutoCapture(next);
    localStorage.setItem('cc_autoCapture', next ? 'on' : 'off');
    if (!next) invalidatePendingCapture();
    autoGateRef.current = blankAutoCaptureState();
    autoProgressRef.current = 0;
  }, [invalidatePendingCapture]);

  const toggleTorch = useCallback(async () => {
    const next = !torchOn;
    if (await setCameraTorch(streamRef.current, next)) setTorchOn(next);
  }, [torchOn]);

  return (
    <IonModal className="camera-preview-modal" isOpen={isOpen} onDidPresent={beginSession} onDidDismiss={() => { stopPreview(); onDismiss(); }}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{side === 'front' ? '명함 앞면' : '명함 뒷면'}</IonTitle>
          <IonButton slot="end" fill="clear" onClick={() => { stopPreview(); onDismiss(); }}>닫기</IonButton>
        </IonToolbar>
      </IonHeader>
      <IonContent className="camera-preview-content ion-padding">
        <div className="camera-preview-stage" data-state={phase}>
          <video ref={videoRef} aria-label="후면 카메라 미리보기" />
          <canvas ref={overlayRef} className="camera-overlay" aria-hidden="true" style={{ display: phase === 'streaming' ? '' : 'none' }} />
          {phase === 'choice' && choiceThumb && <img src={choiceThumb} alt={side === 'front' ? '앞면 촬영 결과' : '뒷면 촬영 결과'} />}
          {phase === 'streaming' && <div className="camera-hint-pill" role="status"><span>{autoHint}</span></div>}
          {(phase === 'idle' || phase === 'requesting' || phase === 'error') && (
            <div className="camera-preview-state" role="status">
              {phase === 'requesting' ? <IonSpinner name="crescent" /> : <CameraIcon aria-hidden="true" size={30} />}
              <strong>{phase === 'error' ? '기본 카메라로 계속할 수 있어요' : '카메라 준비 중'}</strong>
              {detail && <p>{detail}</p>}
            </div>
          )}
        </div>

        {phase === 'streaming' && (
          <>
            <p className="camera-engine-note">{cvState}</p>
            <div className="camera-live-actions">
              <IonButton fill={autoCapture ? 'solid' : 'outline'} onClick={toggleAutoCapture}>{autoCapture ? '자동 촬영 켜짐' : '자동 촬영 꺼짐'}</IonButton>
              {torchAvailable && <IonButton fill={torchOn ? 'solid' : 'outline'} onClick={() => void toggleTorch()}><Lightbulb aria-hidden="true" size={17} /> 플래시</IonButton>}
            </div>
            <IonButton expand="block" onClick={() => void capturePreviewFrame('manual')}><ImageIcon aria-hidden="true" slot="start" size={18} />{side === 'front' ? '앞면' : '뒷면'} 촬영</IonButton>
            {/* 여기서 찍은 사진은 갤러리에 저장되지 않는다. 기본 카메라 앱은 반대라서 평상시 동선에서 뺀다. */}
            {galleryFree
              ? <p className="camera-privacy-note">여기서 찍은 사진은 휴대폰 갤러리에 저장되지 않아요.</p>
              : <IonButton expand="block" fill="outline" onClick={() => nativeInputRef.current?.click()}>기본 카메라 앱으로 찍기 · 갤러리에 남아요</IonButton>}
          </>
        )}

        {phase === 'choice' && side === 'front' && (
          <div className="camera-choice">
            <p>{withBackChoice ? '앞면 저장됨 — 뒷면도 찍을까요? (선택)' : '앞면 저장됨 — 이대로 괜찮나요?'}</p>
            {withBackChoice && <IonButton expand="block" onClick={() => resumeStreaming('back')}>뒷면도 찍기</IonButton>}
            <IonButton expand="block" fill={withBackChoice ? 'outline' : 'solid'} onClick={() => { stopPreview(); onFinished(); }}>{withBackChoice ? '뒷면 없이 완료' : '이대로 완료'}</IonButton>
            <IonButton expand="block" fill="clear" onClick={() => resumeStreaming('front')}>앞면 다시 찍기</IonButton>
          </div>
        )}

        {phase === 'choice' && side === 'back' && (
          <div className="camera-choice">
            <p>뒷면 저장됨 — 이대로 괜찮나요?</p>
            <IonButton expand="block" onClick={() => { stopPreview(); onFinished(); }}>완료</IonButton>
            <IonButton expand="block" fill="outline" onClick={() => resumeStreaming('back')}>뒷면 다시 찍기</IonButton>
          </div>
        )}

        {/* 카메라가 안 열리는 기기에서는 막다른 길을 만들지 않는다 — 대신 갤러리에 남는다는 사실을 함께 말한다. */}
        {phase === 'error' && (
          <>
            <IonButton expand="block" onClick={() => void startPreview(side)}>다시 시도</IonButton>
            <IonButton expand="block" fill="outline" onClick={() => nativeInputRef.current?.click()}>기본 카메라 앱으로 찍기{galleryFree ? ' · 갤러리에 남아요' : ''}</IonButton>
          </>
        )}
        <input ref={nativeInputRef} className="native-camera-input" type="file" accept="image/*" capture="environment" onChange={(inputEvent) => { void handleNativeFile(inputEvent.target.files?.[0]); inputEvent.target.value = ''; }} />
      </IonContent>
    </IonModal>
  );
}
