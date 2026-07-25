import {
  IonButton,
  IonContent,
  IonHeader,
  IonInput,
  IonModal,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera as CameraIcon, Image as ImageIcon, ShieldCheck } from 'lucide-react';
import {
  CandidateCameraError,
  type CapturedCameraFrame,
  captureCameraFrame,
  openEnvironmentCamera,
  stopCameraStream,
} from '../services/camera';
import type { QuickName } from '../contracts/capture';
import { recognizeQuickName } from '../services/vision';

type PreviewPhase = 'idle' | 'requesting' | 'streaming' | 'captured' | 'error';

const failureCopy: Record<string, string> = {
  unsupported: '이 브라우저는 직접 카메라 미리보기를 지원하지 않습니다.',
  permission_denied: '카메라 권한이 꺼져 있습니다. 브라우저 설정에서 허용하거나 검증된 촬영 경로를 사용하세요.',
  camera_unavailable: '후면 카메라를 찾지 못했습니다. 검증된 촬영 경로로 계속할 수 있습니다.',
  camera_busy: '다른 앱이 카메라를 사용 중입니다. 닫은 뒤 다시 시도하세요.',
  camera_failed: '카메라를 시작하지 못했습니다. 검증된 촬영 경로로 계속하세요.',
};

export function CameraPreviewModal({
  isOpen,
  onDismiss,
  onQueueFrame,
}: {
  isOpen: boolean;
  onDismiss: () => void;
  onQueueFrame: (frame: CapturedCameraFrame, quickName: QuickName | null) => Promise<void>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ocrSessionRef = useRef(0);
  const [phase, setPhase] = useState<PreviewPhase>('idle');
  const [detail, setDetail] = useState('');
  const [frame, setFrame] = useState<{ dataUrl: string; width: number; height: number } | null>(null);
  const [queueing, setQueueing] = useState(false);
  const [quickName, setQuickName] = useState<QuickName | null>(null);
  const [nameText, setNameText] = useState('');
  const [ocrState, setOcrState] = useState('이름 인식 대기');

  const stopPreview = useCallback(() => {
    stopCameraStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setPhase('idle');
    setFrame(null);
    setQueueing(false);
    setQuickName(null);
    setNameText('');
    setOcrState('이름 인식 대기');
    ocrSessionRef.current += 1;
  }, []);

  useEffect(() => stopPreview, [stopPreview]);

  const startPreview = useCallback(async () => {
    stopPreview();
    setPhase('requesting');
    setDetail('후면 카메라 권한을 확인하고 있어요.');
    try {
      const stream = await openEnvironmentCamera();
      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) throw new CandidateCameraError('camera_failed');
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      setPhase('streaming');
      setDetail('후면 카메라 계약이 연결됐습니다. 이 화면은 아직 이미지를 저장하거나 전송하지 않습니다.');
    } catch (error) {
      stopPreview();
      const code = error instanceof CandidateCameraError ? error.code : 'camera_failed';
      setPhase('error');
      setDetail(failureCopy[code]);
    }
  }, [stopPreview]);

  const capturePreviewFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const nextFrame = captureCameraFrame(video);
      setFrame(nextFrame);
      setPhase('captured');
      setDetail(`${nextFrame.width}×${nextFrame.height} JPEG를 만들었습니다. 아직 queue·upload는 하지 않았습니다.`);
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
    } catch {
      setPhase('error');
      setDetail('카메라 프레임이 아직 준비되지 않았습니다. 다시 시도하거나 검증된 촬영 경로를 사용하세요.');
    }
  }, []);

  const queuePreviewFrame = useCallback(async () => {
    if (!frame || queueing) return;
    setQueueing(true);
    try {
      await onQueueFrame(frame, quickName);
    } catch {
      setDetail('로컬 대기열에 저장하지 못했습니다. 프레임은 전송되지 않았으며 다시 시도할 수 있습니다.');
      setQueueing(false);
    }
  }, [frame, onQueueFrame, queueing, quickName]);

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

  return (
    <IonModal
      className="camera-preview-modal"
      isOpen={isOpen}
      onDidPresent={() => void startPreview()}
      onDidDismiss={() => {
        stopPreview();
        onDismiss();
      }}
    >
      <IonHeader>
        <IonToolbar>
          <IonTitle>후보 카메라 계약</IonTitle>
          <IonButton slot="end" fill="clear" onClick={onDismiss}>닫기</IonButton>
        </IonToolbar>
      </IonHeader>
      <IonContent className="camera-preview-content ion-padding">
        <div className="camera-preview-stage" data-state={phase}>
          <video ref={videoRef} aria-label="후면 카메라 미리보기" />
          {frame && <img src={frame.dataUrl} alt="메모리 안의 후보 카메라 프레임" />}
          {phase !== 'streaming' && phase !== 'captured' && (
            <div className="camera-preview-state" role="status">
              {phase === 'requesting' ? <IonSpinner name="crescent" /> : <CameraIcon aria-hidden="true" size={30} />}
              <strong>{phase === 'error' ? '검증된 경로로 돌아갈 수 있어요' : '카메라 준비 중'}</strong>
            </div>
          )}
        </div>
        <section className="camera-contract-note">
          <ShieldCheck aria-hidden="true" size={20} />
          <div><strong>{phase === 'captured' ? '메모리 프레임 계약 통과' : phase === 'streaming' ? '미리보기 계약 연결됨' : '안전한 병렬 검증'}</strong><p>{detail}</p></div>
        </section>
        {phase === 'captured' && (
          <section className="quick-name-panel">
            <label htmlFor="candidate-quick-name">이름 후보</label>
            <IonInput id="candidate-quick-name" aria-label="이름 후보" value={nameText} placeholder="직접 입력할 수 있어요" onIonInput={(event) => editQuickName(String(event.detail.value ?? ''))} />
            <small role="status">{ocrState}</small>
          </section>
        )}
        {phase === 'streaming' && <IonButton expand="block" onClick={capturePreviewFrame}><ImageIcon aria-hidden="true" slot="start" size={18} />메모리 프레임 시험</IonButton>}
        {phase === 'captured' && <IonButton expand="block" disabled={queueing} onClick={() => void queuePreviewFrame()}>{queueing ? '로컬 저장 중' : '로컬 대기열에 보관'}</IonButton>}
        {phase === 'captured' && <IonButton expand="block" fill="outline" disabled={queueing} onClick={() => void startPreview()}>다시 미리보기</IonButton>}
        {phase === 'error' && <IonButton expand="block" onClick={() => void startPreview()}>다시 시도</IonButton>}
        <IonButton expand="block" fill="outline" href="../index.html">검증된 카메라로 촬영</IonButton>
      </IonContent>
    </IonModal>
  );
}
