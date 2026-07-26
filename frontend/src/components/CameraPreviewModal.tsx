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
import { blankAutoCaptureState, nextAutoCaptureState } from '../services/auto-capture';
import { preloadQuickNameOcr } from '../services/vision';
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

export function CameraCaptureModal({
  isOpen,
  initialSide,
  withBackChoice,
  onDismiss,
  onCaptured,
  onFinished,
}: {
  isOpen: boolean;
  initialSide: CardSide;
  withBackChoice: boolean;
  onDismiss: () => void;
  onCaptured: (side: CardSide, frame: CapturedCameraFrame, meta: CapturedSideMeta) => void;
  onFinished: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<OpenCvWorkerClient | null>(null);
  const autoGateRef = useRef(blankAutoCaptureState());
  const capturingRef = useRef(false);
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
  const [autoHint, setAutoHint] = useState('명함을 화면 안에 담아 주세요');
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const stopPreview = useCallback(() => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchAvailable(false);
    setTorchOn(false);
    capturingRef.current = false;
    autoGateRef.current = blankAutoCaptureState();
    autoProgressRef.current = 0;
    liveQuadRef.current = null;
    displayQuadRef.current = null;
    detectedSinceRef.current = 0;
    lastDetectQuadRef.current = null;
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const resumeStreaming = useCallback((nextSide: CardSide) => {
    // 선택지에서 뒷면/앞면 재촬영으로 복귀 — 스트림은 살아 있으므로 즉시 촬영 가능 (legacy camGoBack2).
    setSide(nextSide);
    capturingRef.current = false;
    autoGateRef.current = blankAutoCaptureState();
    autoProgressRef.current = 0;
    liveQuadRef.current = null;
    detectedSinceRef.current = 0;
    lastDetectQuadRef.current = null;
    // 방금 찍은 장이 그대로 다시 찍히지 않도록, 명함이 한 번 화면에서 벗어난 뒤에만 자동 촬영을 재개한다.
    autoArmedRef.current = false;
    rearmAtRef.current = performance.now();
    setAutoHint(nextSide === 'back' ? '명함을 뒤집어 뒷면을 대주세요' : '앞면을 다시 대주세요');
    setPhase('streaming');
  }, []);

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
      if (client.isReady()) {
        setCvState('명함 감지·자동 촬영 준비됨');
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
        });
      }
      preloadQuickNameOcr();
    } catch (error) {
      stopPreview();
      const code = error instanceof CandidateCameraError ? error.code : 'camera_failed';
      setPhase('error');
      setDetail(failureCopy[code]);
    }
  }, [stopPreview]);

  const capturePreviewFrame = useCallback(async (source: 'manual' | 'auto' = 'manual') => {
    const video = videoRef.current;
    if (!video || capturingRef.current) return;
    capturingRef.current = true;
    try {
      if (!video.videoWidth) throw new CandidateCameraError('frame_not_ready');
      const full = document.createElement('canvas');
      full.width = video.videoWidth;
      full.height = video.videoHeight;
      const fullContext = full.getContext('2d');
      if (!fullContext) throw new CandidateCameraError('camera_failed');
      fullContext.drawImage(video, 0, 0);

      let result: HTMLCanvasElement | null = null;
      let cropState: CapturedSideMeta['cropState'] = 'full';
      const client = workerRef.current;
      if (client?.isReady()) {
        try {
          const image = fullContext.getImageData(0, 0, full.width, full.height);
          const rectified = await client.rectify(image);
          if (rectified) {
            result = canvasFromImageData(rectified);
            cropState = 'rectified';
          }
        } catch {
          // getImageData 불가(제한된 context 등) → 아래 가이드 크롭 폴백.
        }
      }
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
      let blurry = false;
      if (client?.isReady()) {
        try {
          const scale = Math.min(1, 600 / Math.max(1, finalCanvas.width));
          const check = document.createElement('canvas');
          check.width = Math.max(1, Math.round(finalCanvas.width * scale));
          check.height = Math.max(1, Math.round(finalCanvas.height * scale));
          const checkContext = check.getContext('2d');
          checkContext?.drawImage(finalCanvas, 0, 0, check.width, check.height);
          const image = checkContext?.getImageData(0, 0, check.width, check.height);
          const score = image ? await client.blurScore(image) : null;
          blurry = score !== null && score < 45;
        } catch {
          blurry = false;
        }
      }

      const frame = finalizeCameraFrame(finalCanvas);
      onCaptured(sideRef.current, frame, { cropState, blurry, source });
      if (sideRef.current === 'front' && withBackChoice) {
        // 카메라를 벗어나지 않는 선택지: 뒷면도 찍기 / 뒷면 없이 완료 / 앞면 다시 찍기 (legacy camChoiceUI).
        setChoiceThumb(frame.dataUrl);
        setPhase('choice');
        capturingRef.current = false;
      } else {
        stopPreview();
        onFinished();
      }
    } catch {
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
      let image: ImageData;
      try {
        image = context.getImageData(0, 0, canvas.width, canvas.height);
      } catch {
        return;
      }
      const frameWidth = canvas.width;
      const frameHeight = canvas.height;
      const videoScale = video.videoWidth / frameWidth;
      void client.analyze(image, { minAreaRatio: 0.07, fast: deepCounter % 3 !== 0, withGate: autoCapture, previousQuad: lastDetectQuadRef.current }).then((analysis) => {
        if (!analysis) return; // 이전 프레임 분석 중 — 이 프레임은 버림(자연 스로틀).
        if (phaseRef.current !== 'streaming' || capturingRef.current) return;
        const now = performance.now();
        if (!analysis.quad || !plausibleCard(analysis.quad)) {
          if (autoCapture) {
            autoGateRef.current = nextAutoCaptureState(autoGateRef.current, { detected: false }, now);
            autoProgressRef.current = 0;
          }
          // 명함이 화면에서 벗어났다 = 사용자가 장을 바꾸는 중. 이제 다음 장을 자동 촬영해도 된다.
          autoArmedRef.current = true;
          lastDetectQuadRef.current = null;
          setAutoHint('명함을 화면 안에 담아 주세요');
          return;
        }
        lastDetectQuadRef.current = analysis.quad;
        liveQuadRef.current = { quad: analysis.quad.map((point) => ({ x: point.x * videoScale, y: point.y * videoScale })), at: now };
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
          quad: analysis.quad,
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
        if (gate.fired) void capturePreviewFrame('auto');
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
    setAutoCapture((current) => {
      const next = !current;
      localStorage.setItem('cc_autoCapture', next ? 'on' : 'off');
      autoGateRef.current = blankAutoCaptureState();
      autoProgressRef.current = 0;
      return next;
    });
  }, []);

  const toggleTorch = useCallback(async () => {
    const next = !torchOn;
    if (await setCameraTorch(streamRef.current, next)) setTorchOn(next);
  }, [torchOn]);

  return (
    <IonModal className="camera-preview-modal" isOpen={isOpen} onDidPresent={beginSession} onDidDismiss={() => { stopPreview(); onDismiss(); }}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{side === 'front' ? '명함 앞면' : '명함 뒷면'}</IonTitle>
          <IonButton slot="end" fill="clear" onClick={onDismiss}>닫기</IonButton>
        </IonToolbar>
      </IonHeader>
      <IonContent className="camera-preview-content ion-padding">
        <div className="camera-preview-stage" data-state={phase}>
          <video ref={videoRef} aria-label="후면 카메라 미리보기" />
          <canvas ref={overlayRef} className="camera-overlay" aria-hidden="true" style={{ display: phase === 'streaming' ? '' : 'none' }} />
          {phase === 'choice' && choiceThumb && <img src={choiceThumb} alt="앞면 미리보기" />}
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
            <IonButton expand="block" fill="outline" onClick={() => nativeInputRef.current?.click()}>기본 카메라 앱으로 찍기</IonButton>
          </>
        )}

        {phase === 'choice' && (
          <div className="camera-choice">
            <p>앞면 저장됨 — 뒷면도 찍을까요? (선택)</p>
            <IonButton expand="block" onClick={() => resumeStreaming('back')}>뒷면도 찍기</IonButton>
            <IonButton expand="block" fill="outline" onClick={() => { stopPreview(); onFinished(); }}>뒷면 없이 완료</IonButton>
            <IonButton expand="block" fill="clear" onClick={() => resumeStreaming('front')}>앞면 다시 찍기</IonButton>
          </div>
        )}

        {phase === 'error' && (
          <>
            <IonButton expand="block" onClick={() => void startPreview(side)}>다시 시도</IonButton>
            <IonButton expand="block" fill="outline" onClick={() => nativeInputRef.current?.click()}>기본 카메라 앱으로 찍기</IonButton>
          </>
        )}
        <input ref={nativeInputRef} className="native-camera-input" type="file" accept="image/*" capture="environment" onChange={(inputEvent) => { void handleNativeFile(inputEvent.target.files?.[0]); inputEvent.target.value = ''; }} />
        <IonButton expand="block" fill="clear" href="../legacy.html">이전 촬영 화면 열기 · 복구용</IonButton>
      </IonContent>
    </IonModal>
  );
}
