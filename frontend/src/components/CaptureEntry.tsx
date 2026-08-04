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
          const recovery = anatomy.recovery;
          /* 못 쓰는 입구도 **버튼으로 남는다** (통합 판정, TSK-000220 + TSK-000545).
             처음 판은 `<div role="group">`이었다. 그 모양은 두 가지를 동시에 잃는다.
               - 낭독기는 group을 컨테이너로 읽는다. "누를 수 있었던 것이 지금 안 된다"는 사실이
                 사라지고, 그냥 글 뭉치가 하나 있다고 읽힌다.
               - 앱에서 가장 많이 참조되는 손잡이(`button` + `명함 앞면 촬영`)가 **기기에 따라**
                 사라진다. 웹캠 없는 PC에서만 14개 spec 파일의 대상이 없어지는 셈이고,
                 그 기기에서만 게이트가 무너진다 — 가장 늦게, 가장 알기 어렵게.
             그래서 회복 행동이 있으면 **카드 자체가 그 행동의 버튼**이다. 카드는 막다른 길이
             아니라 다른 길로 가는 문이 되고, `aria-disabled`는 회복이 아예 없을 때만 남는다
             (생산자는 그런 카드를 만들지 않는다).

             이유를 `aria-describedby`로 따로 매달지 않는다. 이유 줄이 버튼 **안**에 있어 이미
             접근 이름의 일부이고, describedby까지 붙이면 같은 문장을 두 번 읽는다. 쓸 수 있는
             카드가 "제목 → 설명 → 행동" 순서로 읽히는 것과 같은 규칙으로, 못 쓰는 카드는
             "제목 → 설명 → 이유 → 회복 행동" 순서로 읽힌다. */
          return (
            <button
              key={anatomy.id}
              type="button"
              className={`cc-entry-card is-unavailable ${legacy}`.trim()}
              data-unavailable="true"
              {...(recovery ? {} : { 'aria-disabled': 'true' as const })}
              onClick={recovery ? () => onRecover?.(anatomy.id, recovery as CaptureMethodRecovery) : undefined}
            >
              {head}
              {/* 이유는 설명 줄을 덮지 않고 그 아래에 선다 — 무엇이었는지는 계속 읽혀야 한다. */}
              <span className="cc-entry-reason">{anatomy.reason}</span>
              {recovery
                ? <span className="cc-entry-recovery">{recovery.label}</span>
                : <span className="cc-entry-action is-off">{anatomy.action}</span>}
            </button>
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
