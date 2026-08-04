// 사람을 등록하는 입구들 — Kairen-Ref: TSK-000220 / INT-000030 / DEC-000105
//
// founder 판정:
//   "캡처 페이지에 명함 촬영, 직접 입력, 구도는 좋아. 근데 하나는 설명이 있고 하나는 없고
//    그래서 시각적으로 뭔가 통일감이 떨어져."
//
// 예전에는 두 입구를 서로 다른 파일이 각자 그렸다 — `App.tsx`가 촬영 버튼을,
// `ManualPersonSheet.tsx`가 직접 입력 버튼을. 같은 줄에 두는 것까지는 맞췄지만 **안쪽 구조가
// 달랐다.** 한쪽은 아이콘+제목, 다른 쪽은 아이콘+제목+보조문구였고, 초안이 있으면 그 보조문구
// 자리를 상태 뱃지가 차지해 설명이 통째로 사라졌다.
//
// 이제 입구는 이 컴포넌트 하나가 그린다. 카드는 예외 없이 같은 네 줄을 갖는다:
//   아이콘 · 제목 · 한 줄 outcome · 행동 affordance
// 상태(초안 있음 등)는 **다섯 번째 자리**라 설명을 밀어내지 못한다.
//
// 무엇을 쓸 수 있는지는 여기서 추측하지 않는다. `methods` 배열이 사실이고, 그것은
// `services/device-capability.ts`(TSK-000545)가 만든다. 못 쓰는 입구도 카드는 남는다 —
// 이유 없이 사라진 버튼이 이 표면에서 가장 나쁜 결과다.
//
// 이 파일이 `int30-capture.css`를 자기 맨 위에서 들여온다. 공용 `app.css`에는 아무것도 더하지 않는다.
import '../styles/int30-capture.css';

import { Camera, ChevronRight, ImageUp, PenLine, Sparkles } from 'lucide-react';
import type { ReactNode } from 'react';
import type { CaptureMethodCard, CaptureMethodId, CaptureMethodRecovery } from '../contracts/int30';
import { captureCardAnatomy, captureMethodColumns, orderCaptureMethods } from '../services/capture-entry';

export interface CaptureEntryProps {
  /** 지금 이 기기에서 쓸 수 있는 입구들. 순서는 이 컴포넌트가 다시 정한다. */
  methods: readonly CaptureMethodCard[];
  /** 카드를 눌렀을 때. 못 쓰는 카드는 여기로 오지 않는다. */
  onSelect: (id: CaptureMethodId) => void;
  /** 못 쓰는 카드의 회복 버튼. 이유만 남고 할 일이 없는 상태를 만들지 않는다. */
  onRecover?: (id: CaptureMethodId, recovery: CaptureMethodRecovery) => void;
  /**
   * 입구별 진행 한 조각(`이어서 쓰기`처럼). 설명 자리를 대체하지 않고 위쪽 뱃지 자리에 선다.
   * 여기 없는 입구는 그냥 뱃지가 없다 — 카드 높이는 그대로다.
   */
  status?: Partial<Record<CaptureMethodId, string>>;
}

const METHOD_ICON: Record<CaptureMethodId, ReactNode> = {
  camera: <Camera size={22} />,
  manual: <PenLine size={22} />,
  upload: <ImageUp size={22} />,
};

/**
 * 기존 회귀 게이트가 잡고 있는 손잡이.
 *
 * `.shot-main` / `.manual-main`은 여러 게이트가 "두 입구가 같은 부모·같은 크기인가"를 재는
 * 이름이다. 구조를 바꾸면서 이 이름까지 갈면 그 게이트들이 대상을 잃는다 —
 * 계약을 지키면서 이름을 지우는 것은 계약을 지운 것과 구별되지 않는다.
 */
const METHOD_LEGACY_CLASS: Record<CaptureMethodId, string> = {
  camera: 'shot-main',
  manual: 'manual-main',
  upload: 'upload-main',
};

export function CaptureEntry({ methods, onSelect, onRecover, status }: CaptureEntryProps) {
  const ordered = orderCaptureMethods(methods);
  const columns = captureMethodColumns(ordered.length);

  return (
    <div
      className="primary-entries cc-entries"
      data-columns={columns}
      style={{ ['--cc-entry-columns' as string]: String(columns) }}
    >
      {ordered.map((card) => {
        const anatomy = captureCardAnatomy(card, { status: status?.[card.id] });
        const legacy = METHOD_LEGACY_CLASS[anatomy.id] ?? '';
        const icon = METHOD_ICON[anatomy.id] ?? <Sparkles size={22} />;

        // 네 줄의 앞 세 줄은 쓸 수 있든 없든 완전히 같다. 마지막 줄만 `행동`과 `회복`으로 갈린다.
        const head = (
          <>
            <span className="cc-entry-top">
              <span className="cc-entry-icon" aria-hidden="true">{icon}</span>
              {anatomy.status && <span className="cc-entry-status">{anatomy.status}</span>}
            </span>
            <span className="cc-entry-title">{anatomy.title}</span>
            <span className="cc-entry-outcome">{anatomy.outcome}</span>
          </>
        );

        if (!anatomy.available) {
          return (
            <div
              key={anatomy.id}
              className={`cc-entry-card is-unavailable ${legacy}`.trim()}
              role="group"
              aria-label={anatomy.title}
              aria-disabled="true"
            >
              {head}
              {/* 이유는 설명 줄을 덮지 않고 그 아래에 선다 — 무엇이었는지는 계속 읽혀야 한다. */}
              <span className="cc-entry-reason">{anatomy.reason}</span>
              {anatomy.recovery
                ? (
                  <button
                    type="button"
                    className="cc-entry-recovery"
                    onClick={() => onRecover?.(anatomy.id, anatomy.recovery as CaptureMethodRecovery)}
                  >
                    {anatomy.recovery.label}
                  </button>
                )
                : <span className="cc-entry-action is-off">{anatomy.action}</span>}
            </div>
          );
        }

        return (
          <button
            key={anatomy.id}
            type="button"
            className={`cc-entry-card ${legacy}`.trim()}
            onClick={() => onSelect(anatomy.id)}
          >
            {head}
            <span className="cc-entry-action">
              {anatomy.action}
              <ChevronRight aria-hidden="true" size={14} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
