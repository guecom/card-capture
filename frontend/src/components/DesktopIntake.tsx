// PC 진입의 캡처 입구 (TSK-000545 / INT-000030).
//
// 왜 폰 화면을 그대로 줄여 놓지 않는가 — PC에서 명함은 대개 **이미 파일로** 도착한다
// (메일 첨부, 스캐너, 폰에서 보낸 사진). 그리고 웹캠은 화각이 넓고 두 손이 자판에 묶여
// 있어 "명함을 들고 각도를 맞추는" 폰 동선이 성립하지 않는다. 그래서 PC의 첫 손잡이는
// 파일이고, 웹캠은 그 옆에 나란히 둔다 — 숨기지도, 강요하지도 않는다.
//
// 이 컴포넌트가 소유하는 것은 **파일을 받아 앞·뒷면으로 배정하는 일**까지다. 프레임 변환과
// 대기열 저장은 호출자가 한다. 판정(`triageIntakeFiles`)은 서비스가 갖고 있어 화면 없이도
// 전수 시험된다.
import '../styles/int30-desktop.css';
import { CircleAlert, ImageUp, RotateCcw, Video } from 'lucide-react';
import { useId, useRef, useState } from 'react';
import type { CaptureMethodCard, CaptureMethodRecovery } from '../contracts/int30';
import {
  type IntakeAssignment,
  type IntakeSide,
  intakeRejectionMessage,
  triageIntakeFiles,
} from '../services/device-capability';

export interface DesktopIntakeProps {
  /** 이미 배정된 자리. 파일 이름이 있으면 채워진 것으로 본다. */
  assigned?: { front?: string; back?: string };
  /** 배정된 파일. 호출자가 `fileToCameraFrame`으로 프레임을 만들어 대기열에 넣는다. */
  onFiles(assignments: IntakeAssignment<File>[]): void;
  /** 자리 비우기. 잘못 올린 것을 되돌릴 수 없으면 사용자는 새로고침으로 도망간다. */
  onClear?(side: IntakeSide): void;
  /** 웹캠 입구의 지금 사실. `deviceCaptureMethods(...)`가 만든 `camera` 카드를 그대로 넘긴다. */
  webcam: CaptureMethodCard;
  onOpenWebcam(): void;
  /** 못 쓰는 상태에서 벗어나는 행동. 카드의 `recovery`를 그대로 되돌려 준다. */
  onRecovery?(recovery: CaptureMethodRecovery): void;
}

const SIDE_LABEL: Record<IntakeSide, string> = { front: '앞면', back: '뒷면' };

export function DesktopIntake({
  assigned,
  onFiles,
  onClear,
  webcam,
  onOpenWebcam,
  onRecovery,
}: DesktopIntakeProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rejections, setRejections] = useState<string[]>([]);
  const dropHintId = useId();

  function accept(list: FileList | null | undefined): void {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const triage = triageIntakeFiles(files, {
      hasFront: Boolean(assigned?.front),
      hasBack: Boolean(assigned?.back),
    });
    // 거절은 조용히 버리지 않는다. 무엇이 왜 빠졌는지 이름을 붙여 말한다.
    setRejections(triage.rejected.map((item) => `${item.name} — ${intakeRejectionMessage[item.reason]}`));
    if (triage.accepted.length > 0) onFiles(triage.accepted);
  }

  return (
    <div className="cc-desktop-intake">
      <div
        className={`cc-drop-zone${dragging ? ' dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer?.files);
        }}
      >
        {/* 끌어다 놓기는 마우스만의 길이다. 같은 일을 하는 버튼이 반드시 함께 있어야
            키보드와 낭독기 사용자가 같은 자리에서 끝낼 수 있다. */}
        <button
          className="cc-drop-main"
          type="button"
          aria-describedby={dropHintId}
          onClick={() => inputRef.current?.click()}
        >
          <span className="cc-drop-icon" aria-hidden="true"><ImageUp size={24} /></span>
          <span className="cc-drop-title">명함 사진 올리기</span>
        </button>
        <p className="cc-drop-hint" id={dropHintId}>여기로 끌어다 놓아도 되고, 눌러서 골라도 돼요. 앞·뒷면 두 장까지 한 번에 받습니다.</p>
        <input
          ref={inputRef}
          className="cc-drop-input"
          type="file"
          accept="image/*"
          multiple
          aria-label="명함 사진 파일 고르기"
          onChange={(event) => { accept(event.target.files); event.target.value = ''; }}
        />
      </div>

      <ul className="cc-slot-row">
        {(['front', 'back'] as IntakeSide[]).map((side) => {
          const name = side === 'front' ? assigned?.front : assigned?.back;
          return (
            <li key={side} className={`cc-slot${name ? ' filled' : ''}`}>
              <span className="cc-slot-label">{SIDE_LABEL[side]}</span>
              <span className="cc-slot-name">{name || (side === 'front' ? '아직 없음' : '선택 사항')}</span>
              {name && onClear && (
                <button className="cc-slot-clear" type="button" onClick={() => onClear(side)}>
                  <RotateCcw aria-hidden="true" size={13} />{SIDE_LABEL[side]} 비우기
                </button>
              )}
            </li>
          );
        })}
      </ul>

      {rejections.length > 0 && (
        <ul className="cc-intake-rejects" role="status">
          {rejections.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}

      {/* 웹캠은 파일 옆에 나란히 있다. 못 쓰는 상태에서도 **사라지지 않고** 이유와 회복
          행동을 달고 남는다 — 사라진 버튼은 사용자가 원인을 찾을 수 없는 유일한 실패다. */}
      <div className={`cc-webcam-entry${webcam.available ? '' : ' blocked'}`}>
        <button
          className="cc-webcam-main"
          type="button"
          disabled={!webcam.available}
          onClick={onOpenWebcam}
        >
          <span className="cc-webcam-icon" aria-hidden="true"><Video size={19} /></span>
          <span className="cc-webcam-copy">
            <strong>{webcam.title}</strong>
            <small>{webcam.description}</small>
          </span>
        </button>
        {!webcam.available && webcam.unavailableReason && (
          <p className="cc-webcam-reason">
            <CircleAlert aria-hidden="true" size={14} />
            <span>{webcam.unavailableReason}</span>
          </p>
        )}
        {!webcam.available && webcam.recovery && onRecovery && (
          <button
            className="cc-webcam-recovery"
            type="button"
            onClick={() => onRecovery(webcam.recovery as CaptureMethodRecovery)}
          >
            {webcam.recovery.label}
          </button>
        )}
      </div>
    </div>
  );
}
