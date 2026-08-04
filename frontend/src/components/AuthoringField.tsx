// 앱의 모든 "글 쓰는 칸"이 공유하는 한 겹 — Kairen-Ref: TSK-000220
//
// founder 판정 (INT-000030 / DEC-000105):
//   "캡처 페이지 만남 맥락 글 작성하는 박스 포함해서 테두리 뭔가 좀 구려. 다른 곳의 작성하는
//    박스 테두리와 통일성도 없고"
//
// 실제로 그랬다. 만남 맥락은 1.5px 짙은 테두리 + 눌린 회색, 직접 입력 시트는 1.5px 연한
// 테두리 + 흰 배경, AI 조사 요청은 1px 강조색 테두리, 대기열 편집은 **테두리가 아예 없었다.**
// 네 자리 모두 "여기에 글을 씁니다"라는 같은 말을 서로 다른 모양으로 하고 있었다.
//
// 그래서 테두리·모서리·focus를 `int30-capture.css`의 `--cc-field-*` token 한 벌이 소유하고,
// 이 컴포넌트는 그 token을 두르는 **라벨 밖 + 박스 + 예시** 구조를 준다.
// 색을 여기서 직접 정하지 않는 이유: 다크 팔레트가 통째로 바뀌어도 따라가야 하고,
// 다크 대비 게이트가 그 위에서 판정한다.
//
// 박스는 여전히 `ion-input` / `ion-textarea` **자신**이다. 테두리를 바깥 div로 옮기면
// 칸이 두 겹으로 보이고, 입력 칸의 테두리를 재는 기존 게이트(int15-surfaces)가 빈손이 된다.

import type { ReactNode } from 'react';

export interface AuthoringFieldProps {
  /** 박스 밖에 서는 라벨. Ionic stacked label은 placeholder와 같은 회색조라 칸에 묻힌다. */
  label: string;
  /** 지금 값이 있는가. 채워진 칸은 켜져 보이고, 그것이 이 영역의 진행 감각이다. */
  filled?: boolean;
  /**
   * 라벨 옆에 서는 **짧은** affordance(예: `예시`). 설명을 늘리는 자리가 아니다 —
   * founder 요구는 "설명보다 직관적으로"였다.
   */
  hint?: string;
  /** `ion-input` 또는 `ion-textarea` 하나. 테두리·focus는 이 자식이 입는다. */
  children: ReactNode;
  /** 칸 아래에 붙는 것(예시 chip 등). */
  footer?: ReactNode;
  /** 기존 표면의 class를 잃지 않고 얹기 위한 자리. */
  className?: string;
}

export function AuthoringField({ label, filled = false, hint, children, footer, className }: AuthoringFieldProps) {
  const classes = ['cc-field', filled ? 'is-filled' : 'is-empty', className].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <span className="cc-field-head">
        <span className="cc-field-label">{label}</span>
        {hint && <span className="cc-field-hint">{hint}</span>}
      </span>
      {children}
      {footer && <div className="cc-field-foot">{footer}</div>}
    </div>
  );
}
