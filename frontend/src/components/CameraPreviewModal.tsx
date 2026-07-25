import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonModal,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, Image as ImageIcon, Lightbulb, ShieldCheck } from 'lucide-react';
import {
  CandidateCameraError,
  cameraHasTorch,
  type CapturedCameraFrame,
  captureCameraFrame,
  fileToCameraFrame,
  openEnvironmentCamera,
  setCameraTorch,
  stopCameraStream,
} from '../services/camera';
import type { QuickName, ResearchInstruction } from '../contracts/capture';
import { recognizeQuickName } from '../services/vision';
import { blurScore, detectCardQuad, loadOpenCv, plausibleCard, type OpenCvRuntime, rectifyCardCanvas } from '../services/opencv';
import { blankAutoCaptureState, clippedRatio, nextAutoCaptureState } from '../services/auto-capture';
import { buildResearchInstruction } from '../services/research';
import { loadStickyCaptureContext } from '../services/storage';

type PreviewPhase = 'idle' | 'requesting' | 'streaming' | 'captured' | 'error';
type CardSide = 'front' | 'back';

export interface CandidateCaptureDraft {
  frontFrame: CapturedCameraFrame;
  backFrame: CapturedCameraFrame | null;
  event: string;
  relSelf: string;
  relKairen: string;
  memo: string;
  researchInstruction: ResearchInstruction | null;
  quickName: QuickName | null;
}

const failureCopy: Record<string, string> = {
  unsupported: '이 브라우저는 직접 카메라 미리보기를 지원하지 않습니다.',
  permission_denied: '카메라 권한이 꺼져 있습니다. 브라우저 설정에서 허용하거나 기본 카메라를 사용하세요.',
  camera_unavailable: '후면 카메라를 찾지 못했습니다. 기본 카메라로 계속할 수 있습니다.',
  camera_busy: '다른 앱이 카메라를 사용 중입니다. 닫은 뒤 다시 시도하세요.',
  camera_failed: '카메라를 시작하지 못했습니다. 기본 카메라로 계속하세요.',
};

function quadPixels(canvas: HTMLCanvasElement, quad: Array<{ x: number; y: number }>): ImageData | null {
  const x = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.x))));
  const y = Math.max(0, Math.floor(Math.min(...quad.map((point) => point.y))));
  const right = Math.min(canvas.width, Math.ceil(Math.max(...quad.map((point) => point.x))));
  const bottom = Math.min(canvas.height, Math.ceil(Math.max(...quad.map((point) => point.y))));
  if (right - x < 2 || bottom - y < 2) return null;
  try {
    return canvas.getContext('2d')?.getImageData(x, y, right - x, bottom - y) ?? null;
  } catch {
    return null;
  }
}

export function CameraPreviewModal({
  isOpen,
  researchInstructionEnabled,
  onDismiss,
  onQueueCapture,
}: {
  isOpen: boolean;
  researchInstructionEnabled: boolean;
  onDismiss: () => void;
  onQueueCapture: (draft: CandidateCaptureDraft) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ocrSessionRef = useRef(0);
  const cvRef = useRef<OpenCvRuntime | null>(null);
  const autoGateRef = useRef(blankAutoCaptureState());
  const capturingRef = useRef(false);
  const [phase, setPhase] = useState<PreviewPhase>('idle');
  const [side, setSide] = useState<CardSide>('front');
  const [detail, setDetail] = useState('');
  const [frame, setFrame] = useState<CapturedCameraFrame | null>(null);
  const [frontFrame, setFrontFrame] = useState<CapturedCameraFrame | null>(null);
  const [backFrame, setBackFrame] = useState<CapturedCameraFrame | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [quickName, setQuickName] = useState<QuickName | null>(null);
  const [nameText, setNameText] = useState('');
  const [ocrState, setOcrState] = useState('이름 인식 대기');
  const [cvState, setCvState] = useState('명함 감지 엔진 대기');
  const [autoCapture, setAutoCapture] = useState(() => localStorage.getItem('cc_autoCapture') !== 'off');
  const [autoProgress, setAutoProgress] = useState(0);
  const [autoHint, setAutoHint] = useState('명함을 화면 안에 담아 주세요');
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const sticky = loadStickyCaptureContext();
  const [event, setEvent] = useState(sticky.event);
  const [relSelf, setRelSelf] = useState(sticky.relSelf);
  const [relKairen, setRelKairen] = useState(sticky.relKairen);
  const [memo, setMemo] = useState('');
  const [researchText, setResearchText] = useState('');

  const stopPreview = useCallback(() => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setTorchAvailable(false);
    setTorchOn(false);
    capturingRef.current = false;
    autoGateRef.current = blankAutoCaptureState();
    setAutoProgress(0);
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const startPreview = useCallback(async (nextSide: CardSide) => {
    stopPreview();
    setSide(nextSide);
    setFrame(null);
    setPhase('requesting');
    setDetail(`${nextSide === 'front' ? '앞면' : '뒷면'} 촬영을 위해 후면 카메라 권한을 확인하고 있어요.`);
    setAutoHint('명함을 화면 안에 담아 주세요');
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
      setDetail(`${nextSide === 'front' ? '앞면' : '뒷면'} 미리보기가 연결됐습니다.`);
      setCvState('명함 감지 엔진 준비 중…');
      void loadOpenCv().then((runtime) => {
        cvRef.current = runtime;
        setCvState(runtime ? '명함 감지·자동 촬영 준비됨' : '전체 프레임 fallback 준비됨');
      });
    } catch (error) {
      stopPreview();
      const code = error instanceof CandidateCameraError ? error.code : 'camera_failed';
      setPhase('error');
      setDetail(failureCopy[code]);
    }
  }, [stopPreview]);

  const recognizeFrontName = useCallback((nextFrame: CapturedCameraFrame) => {
    const session = ++ocrSessionRef.current;
    setOcrState('이름 읽는 중…');
    void recognizeQuickName(nextFrame.dataUrl, (progress) => {
      if (session === ocrSessionRef.current) setOcrState(`이름 읽는 중 ${progress}%`);
    }).then((result) => {
      if (session !== ocrSessionRef.current) return;
      setQuickName(result);
      setNameText(result?.name ?? '');
      setOcrState(result?.name ? '인식 완료 · 확인해 주세요' : '직접 확인해 주세요');
    }).catch(() => {
      if (session === ocrSessionRef.current) setOcrState('직접 확인해 주세요');
    });
  }, []);

  const acceptFrame = useCallback((nextFrame: CapturedCameraFrame, rectified: boolean, source: 'manual' | 'auto' | 'native') => {
    stopPreview();
    setFrame(nextFrame);
    if (side === 'front') {
      setFrontFrame(nextFrame);
      recognizeFrontName(nextFrame);
    } else {
      setBackFrame(nextFrame);
    }
    setPhase('captured');
    setCvState(rectified ? '명함 경계를 보정했습니다' : '전체 프레임을 사용했습니다');
    setDetail(`${source === 'auto' ? '자동 촬영' : source === 'native' ? '기본 카메라 촬영' : '수동 촬영'} · ${nextFrame.width}×${nextFrame.height} JPEG 준비 완료`);
  }, [recognizeFrontName, side, stopPreview]);

  const capturePreviewFrame = useCallback((source: 'manual' | 'auto' = 'manual') => {
    const video = videoRef.current;
    if (!video || capturingRef.current) return;
    capturingRef.current = true;
    try {
      let rectified = false;
      const nextFrame = captureCameraFrame(video, undefined, (sourceCanvas) => {
        const detected = cvRef.current ? rectifyCardCanvas(sourceCanvas, cvRef.current) : null;
        rectified = Boolean(detected);
        return detected ?? sourceCanvas;
      });
      acceptFrame(nextFrame, rectified, source);
    } catch {
      capturingRef.current = false;
      setPhase('error');
      setDetail('카메라 프레임이 아직 준비되지 않았습니다. 다시 시도하거나 기본 카메라를 사용하세요.');
    }
  }, [acceptFrame]);

  useEffect(() => {
    if (phase !== 'streaming' || !autoCapture) return;
    let deepCounter = 0;
    const interval = window.setInterval(() => {
      const video = videoRef.current;
      const cv = cvRef.current;
      if (!video || !cv || !video.videoWidth || capturingRef.current) return;
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = Math.max(1, Math.round(320 * video.videoHeight / video.videoWidth));
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      deepCounter += 1;
      const quad = detectCardQuad(canvas, cv, 0.07, deepCounter % 3 !== 0);
      if (!quad || !plausibleCard(quad)) {
        autoGateRef.current = nextAutoCaptureState(autoGateRef.current, { detected: false }, performance.now());
        setAutoProgress(0);
        setAutoHint('명함을 화면 안에 담아 주세요');
        return;
      }
      const pixels = quadPixels(canvas, quad);
      autoGateRef.current = nextAutoCaptureState(autoGateRef.current, {
        detected: true,
        plausible: true,
        quad,
        frameWidth: canvas.width,
        frameHeight: canvas.height,
        blur: blurScore(canvas, cv),
        clippedRatio: pixels ? clippedRatio(pixels) : 0,
      }, performance.now());
      const gate = autoGateRef.current;
      setAutoProgress(gate.progress);
      setAutoHint(gate.reason === 'blur' ? '조금 흐려요 · 휴대폰을 고정해 주세요'
        : gate.reason === 'glare' ? '빛 반사를 줄여 주세요'
          : gate.fired ? '좋아요 · 자동 촬영 중'
            : '인식됨 · 잠시 고정하면 자동 촬영해요');
      if (gate.fired) capturePreviewFrame('auto');
    }, 180);
    return () => window.clearInterval(interval);
  }, [autoCapture, capturePreviewFrame, phase]);

  const handleNativeFile = useCallback(async (file: File | undefined) => {
    if (!file) return;
    setPhase('requesting');
    setDetail('기본 카메라 사진을 준비하고 있어요.');
    try {
      acceptFrame(await fileToCameraFrame(file), false, 'native');
    } catch {
      setPhase('error');
      setDetail('사진을 읽지 못했습니다. 다시 시도해 주세요.');
    }
  }, [acceptFrame]);

  const queueCapture = useCallback(async () => {
    if (!frontFrame || queueing) return;
    setQueueing(true);
    try {
      await onQueueCapture({
        frontFrame,
        backFrame,
        event,
        relSelf,
        relKairen,
        memo,
        researchInstruction: researchInstructionEnabled ? buildResearchInstruction(researchText) : null,
        quickName,
      });
    } catch {
      setDetail('로컬 대기열에 저장하지 못했습니다. 사진은 전송되지 않았으며 다시 시도할 수 있습니다.');
      setQueueing(false);
    }
  }, [backFrame, event, frontFrame, memo, onQueueCapture, queueing, quickName, relKairen, relSelf, researchInstructionEnabled, researchText]);

  const editQuickName = useCallback((value: string) => {
    const name = value.trim().slice(0, 80);
    setNameText(value.slice(0, 80));
    setQuickName(name ? {
      name,
      source: 'user_corrected',
      confidence: quickName?.confidence ?? 0,
      confirmed: true,
      recognizedAt: quickName?.recognizedAt ?? new Date().toISOString(),
    } : null);
    setOcrState(name ? '직접 확인됨' : '이름을 입력해 주세요');
  }, [quickName]);

  const beginDraft = useCallback(() => {
    const context = loadStickyCaptureContext();
    setEvent(context.event);
    setRelSelf(context.relSelf);
    setRelKairen(context.relKairen);
    setMemo('');
    setResearchText('');
    setFrontFrame(null);
    setBackFrame(null);
    setQuickName(null);
    setNameText('');
    setOcrState('이름 인식 대기');
    setQueueing(false);
    void startPreview('front');
  }, [startPreview]);

  const toggleAutoCapture = useCallback(() => {
    setAutoCapture((current) => {
      const next = !current;
      localStorage.setItem('cc_autoCapture', next ? 'on' : 'off');
      autoGateRef.current = blankAutoCaptureState();
      setAutoProgress(0);
      return next;
    });
  }, []);

  const toggleTorch = useCallback(async () => {
    const next = !torchOn;
    if (await setCameraTorch(streamRef.current, next)) setTorchOn(next);
  }, [torchOn]);

  return (
    <IonModal className="camera-preview-modal" isOpen={isOpen} onDidPresent={beginDraft} onDidDismiss={() => { stopPreview(); onDismiss(); }}>
      <IonHeader>
        <IonToolbar>
          <IonTitle>{side === 'front' ? '명함 앞면' : '명함 뒷면'}</IonTitle>
          <IonButton slot="end" fill="clear" onClick={onDismiss}>닫기</IonButton>
        </IonToolbar>
      </IonHeader>
      <IonContent className="camera-preview-content ion-padding">
        <div className="camera-preview-stage" data-state={phase}>
          <video ref={videoRef} aria-label="후면 카메라 미리보기" />
          {frame && <img src={frame.dataUrl} alt={`${side === 'front' ? '앞면' : '뒷면'} 촬영 미리보기`} />}
          {phase === 'streaming' && <div className="camera-guide" style={{ '--auto-progress': autoProgress } as React.CSSProperties}><span>{autoHint}</span></div>}
          {phase !== 'streaming' && phase !== 'captured' && (
            <div className="camera-preview-state" role="status">
              {phase === 'requesting' ? <IonSpinner name="crescent" /> : <CameraIcon aria-hidden="true" size={30} />}
              <strong>{phase === 'error' ? '기본 카메라로 계속할 수 있어요' : '카메라 준비 중'}</strong>
            </div>
          )}
        </div>

        <section className="camera-contract-note">
          <ShieldCheck aria-hidden="true" size={20} />
          <div><strong>{phase === 'captured' ? `${side === 'front' ? '앞면' : '뒷면'} 준비 완료` : phase === 'streaming' ? `${autoCapture ? '자동' : '수동'} 촬영 준비됨` : '안전한 촬영 경계'}</strong><p>{detail}</p></div>
        </section>

        {phase === 'streaming' && (
          <div className="camera-live-actions">
            <IonButton fill={autoCapture ? 'solid' : 'outline'} onClick={toggleAutoCapture}>{autoCapture ? '자동 촬영 켜짐' : '자동 촬영 꺼짐'}</IonButton>
            {torchAvailable && <IonButton fill={torchOn ? 'solid' : 'outline'} onClick={() => void toggleTorch()}><Lightbulb aria-hidden="true" size={17} /> 플래시</IonButton>}
          </div>
        )}

        {frontFrame && (
          <div className="capture-thumbnails" aria-label="촬영한 명함 면">
            <button type="button" onClick={() => void startPreview('front')}><img src={frontFrame.dataUrl} alt="촬영한 앞면" /><span>앞면 다시 찍기</span></button>
            <button type="button" onClick={() => void startPreview('back')} className={backFrame ? '' : 'empty'}>{backFrame ? <img src={backFrame.dataUrl} alt="촬영한 뒷면" /> : <span className="thumbnail-add">+</span>}<span>{backFrame ? '뒷면 다시 찍기' : '뒷면 추가'}</span></button>
          </div>
        )}

        {frontFrame && (
          <section className="quick-name-panel">
            <label htmlFor="candidate-quick-name">이름 먼저 확인</label>
            <IonInput id="candidate-quick-name" aria-label="이름 후보" value={nameText} placeholder="직접 입력할 수 있어요" onIonInput={(inputEvent) => editQuickName(String(inputEvent.detail.value ?? ''))} />
            <small role="status">{ocrState}</small>
            <small>{cvState}</small>
          </section>
        )}

        {frontFrame && (
          <section className="capture-context-fields">
            <h3>기억할 맥락 <span>선택 입력</span></h3>
            <IonInput label="어디서 만났는지 · 2시간 유지" labelPlacement="stacked" value={event} onIonInput={(inputEvent) => setEvent(String(inputEvent.detail.value ?? ''))} />
            <IonInput label="나와 이 사람과의 관계 · 2시간 유지" labelPlacement="stacked" value={relSelf} onIonInput={(inputEvent) => setRelSelf(String(inputEvent.detail.value ?? ''))} />
            <IonInput label="Kairen과 이 사람과의 관계 · 2시간 유지" labelPlacement="stacked" value={relKairen} onIonInput={(inputEvent) => setRelKairen(String(inputEvent.detail.value ?? ''))} />
            <IonTextarea label="메모" labelPlacement="stacked" autoGrow value={memo} onIonInput={(inputEvent) => setMemo(String(inputEvent.detail.value ?? ''))} />
            {researchInstructionEnabled && <IonTextarea label="조사 지시 · 소유자 전용" labelPlacement="stacked" maxlength={2000} autoGrow value={researchText} onIonInput={(inputEvent) => setResearchText(String(inputEvent.detail.value ?? ''))} />}
          </section>
        )}

        {phase === 'streaming' && <IonButton expand="block" onClick={() => capturePreviewFrame('manual')}><ImageIcon aria-hidden="true" slot="start" size={18} />{side === 'front' ? '앞면' : '뒷면'} 촬영</IonButton>}
        {frontFrame && side === 'front' && phase === 'captured' && !backFrame && <IonButton expand="block" fill="outline" onClick={() => void startPreview('back')}>뒷면도 찍기</IonButton>}
        {frontFrame && phase === 'captured' && <IonButton expand="block" disabled={queueing} onClick={() => void queueCapture()}>{queueing ? '로컬 저장 중' : '완료하고 대기열에 저장'}</IonButton>}
        {phase === 'error' && <IonButton expand="block" onClick={() => void startPreview(side)}>다시 시도</IonButton>}
        {(phase === 'streaming' || phase === 'error') && <IonButton expand="block" fill="outline" onClick={() => nativeInputRef.current?.click()}>기본 카메라 앱으로 찍기</IonButton>}
        <input ref={nativeInputRef} className="native-camera-input" type="file" accept="image/*" capture="environment" onChange={(inputEvent) => { void handleNativeFile(inputEvent.target.files?.[0]); inputEvent.target.value = ''; }} />
        <IonButton expand="block" fill="clear" href="../legacy.html">이전 촬영 화면 열기 · 복구용</IonButton>
      </IonContent>
    </IonModal>
  );
}
