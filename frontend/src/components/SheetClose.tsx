// 덮이는 표면을 나가는 단 하나의 조작 — Kairen-Ref: TSK-000564 (ISS-000246 / DEC-000110)
//
// founder 판정 (개발 인터뷰 009):
//   "명함 안면 촬영 누르면 닫기를 눌러서 끄고 직접 입력을 누르면 취소를 눌러서 끄고 (…)
//    이거 다 오른쪽 위에 닫기 버튼으로 끌 수 있으면 좋겠어."
//
// 본질 문제는 button 문구가 아니라 **나가는 문법이 없었다는 것**이다. 표면이 하나 늘 때마다
// 나가는 방법이 새로 발명됐고(헤더 텍스트 `닫기`, 헤더 텍스트 `취소`, 하단 `취소`, 왼쪽 위 회색
// chip, 본문 `그대로 두기`), 사용자는 표면마다 "이건 어떻게 끄지"를 다시 찾아야 했다.
//
// 그래서 나가는 조작을 여기 하나로 모은다. 앞으로 덮이는 표면을 만드는 사람은 문구를 고르는 게
// 아니라 이 컴포넌트를 붙인다. `e2e/int37-dismiss.spec.ts`가 표면 **목록 전체**를 훑으며
// 이것이 오른쪽 위에 있는지 판정한다 — 표면별 게이트로는 새로 생긴 표면을 못 잡는다.
//
// ── 접근 이름을 `닫기`로 고정하는 이유
// 같은 자리·같은 모양인데 낭독기만 어떤 때는 `취소`, 어떤 때는 `닫기`로 읽으면 문법이 반쪽이다.
// 되돌릴 수 없는 행동(연결 해제 등)은 **표면 안의 자기 버튼**이 소유하므로, 껍데기의 이 조작은
// 언제나 "이 표면을 나간다" 하나만 뜻한다.
//
// ── 왜 `IonButton`이 아닌가
// `ion-button`은 자기 안에 shadow DOM의 native button을 또 만든다. 그래서 `getByRole('button')`이
// 겹쳐 잡히고, 크기를 44px로 맞추려면 `--padding-*` 변수를 뚫어야 한다. 껍데기 조작 하나에
// 그만한 우회는 필요 없다 — `slot`은 native 요소에도 그대로 붙는다.
import '../styles/int37-dismiss.css';

import { X } from 'lucide-react';

export interface SheetCloseProps {
  /** 나가기. 되돌릴 수 없는 행동을 여기 걸지 않는다. */
  onClose: () => void;
  /**
   * 접근 이름. 기본값 `닫기`를 그대로 쓴다.
   *
   * 바꿔야 할 이유가 생기면 그것은 대개 "이 조작이 나가기가 아니다"라는 신호다.
   */
  label?: string;
  /** 지금 나가면 안 되는 순간(전송 중 등). 이유는 표면이 따로 말한다. */
  disabled?: boolean;
  /** `ion-toolbar` 안에서 오른쪽 끝에 설 때 `"end"`. */
  slot?: string;
}

export function SheetClose({ onClose, label = '닫기', disabled = false, slot }: SheetCloseProps) {
  return (
    <button
      type="button"
      className="k-sheet-close"
      /* 게이트가 "덮인 표면마다 나가는 조작이 정확히 하나"를 세는 이름.
         문구가 아니라 이 표식으로 센다 — 문구는 앞으로도 바뀔 수 있다. */
      data-sheet-close="true"
      {...(slot ? { slot } : {})}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClose}
    >
      <X aria-hidden="true" size={19} strokeWidth={2.2} />
    </button>
  );
}
