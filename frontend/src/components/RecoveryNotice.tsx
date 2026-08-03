import { LifeBuoy, Mail } from 'lucide-react';
import { RECOVERY_REASON_COPY, recoveryElapsedText, type CaptureRecovery } from '../services/capture-item';
import '../styles/int29-recovery.css';

interface Props {
  captureId: string;
  recovery: CaptureRecovery;
  /** 문의 메일이 갈 주소. 화면 밖으로 나가는 유일한 동작이라 호출부가 명시한다. */
  contactEmail: string;
  now?: number;
}

/**
 * 반복 실패로 잠긴 receipt의 자리 (TSK-000531 / ISS-000232).
 *
 * founder 실측 2026-08-04: "다시 처리 요청해도 안 되고, 뭐 반응이 없어서".
 * 워처는 같은 원인으로 예산을 두 번 소진한 receipt의 requeue를 더 받지 않는다 —
 * 그러므로 이 자리에는 `다시 처리 요청`을 두지 않는다. 눌러도 되는 것이 없는 버튼이
 * 남아 있는 것이 원래 결함이었다.
 *
 * 여기서 말하는 것은 셋뿐이다: 무슨 일이 있었나 / 얼마나 됐나 / 지금 무엇을 할 수 있나.
 * 원인 코드(`processor_failed` 등)는 화면에 찍지 않는다 — 사용자에게 아무 뜻도 아니다.
 */
export function RecoveryNotice({ captureId, recovery, contactEmail, now }: Props) {
  const copy = RECOVERY_REASON_COPY[recovery.reasonCode];
  const elapsed = recoveryElapsedText(recovery.since, now);
  const subject = `[명함] 복구 요청 ${captureId}`;
  // 본문에는 사람 이름·명함 내용이 아니라 receipt 식별자와 원인 분류만 넣는다.
  const body = [
    `캡처 ID: ${captureId}`,
    `상태: 복구 필요 (${recovery.reasonCode})`,
    `누적 실패: ${recovery.failures}${recovery.threshold > 0 ? `/${recovery.threshold}` : ''}회`,
    elapsed ? `멈춘 지: ${elapsed}` : '',
    '',
    '위 항목이 처리되지 않고 멈춰 있어요. 확인 부탁드려요.',
  ].filter(Boolean).join('\n');

  return (
    <section className="int29-recovery" aria-label="복구 필요">
      <div className="int29-recovery-head">
        <LifeBuoy aria-hidden="true" size={16} strokeWidth={2.1} />
        <div className="int29-recovery-title">
          <strong>{copy.cause}</strong>
          <div className="int29-recovery-facts">
            {elapsed && <span>{elapsed}</span>}
            {recovery.threshold > 0 && <span>같은 문제 {recovery.failures}/{recovery.threshold}회</span>}
            <span>사진·요청 내용은 그대로 있어요</span>
          </div>
        </div>
      </div>
      <p>{copy.action}</p>
      <div className="int29-recovery-actions">
        <a href={`mailto:${contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`}>
          <Mail aria-hidden="true" size={13} />이 항목 알리기
        </a>
      </div>
    </section>
  );
}
