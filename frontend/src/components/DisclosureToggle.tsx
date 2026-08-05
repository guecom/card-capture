// 접었다 펴는 단 하나의 조작 — Kairen-Ref: TSK-000573 (ISS-000246 / DEC-000110)
//
// founder 판정 2026-08-05:
//   "손수 만든 나머지 패널. 이번엔 `IonModal`로 덮이는 창만 정리했습니다.
//    설정 안의 접었다 펴는 영역들은 다른 문법이라 아직 손대지 않았습니다."
//
// v2.27.0(`SheetClose`)이 **나가는** 조작을 하나로 모았다. 접는 조작은 그때 손대지 않았고,
// 남은 그것이 닫기 버튼의 예전 상태와 정확히 같았다 — 자리가 하나 늘 때마다 표시를 새로
// 발명했다. `브리핑 상세`와 `만남 맥락`은 lucide `ChevronRight`가 90도 돌았고, `문제가 생겼을 때`는
// `ChevronDown`이 180도 돌았고, `명함 기록`은 `▸`/`▾` **글자**였고, 인물 문서는 브라우저가
// 그리는 세모였다. 넷 중 셋에는 `aria-controls`가 없어서 낭독기가 "무엇이 열렸는지"를 말하지
// 못했고, `명함 기록` 줄은 21px이라 손가락으로 누를 수 없었다.
//
// 그래서 접는 조작을 여기 하나로 모은다. 앞으로 접는 영역을 만드는 사람은 표시를 고르는 게
// 아니라 이 컴포넌트를 붙인다. `services/dismiss-grammar.ts`가 소스를 훑어 이것을 안 쓴 접기
// 조작을 단위 시험에서 잡고, `e2e/int37-disclosure.spec.ts`가 렌더된 화면에서 다시 판정한다.
//
// ── 표시를 `ChevronDown` 하나로 고정하는 이유
// 표시가 자리마다 다르면 사용자는 "이게 눌러서 펴지는 것인가"를 자리마다 다시 배운다. 방향도
// 하나로 둔다: **닫힘 = 아래를 가리킴(누르면 아래로 열린다)**, **열림 = 180도 돌아 위를 가리킴
// (누르면 위로 접힌다)**. 글자 세모(`▸`)를 쓰지 않는 이유는 그것이 글꼴에 따라 크기·굵기·세로
// 정렬이 달라져서, 같은 표시로 보이게 만드는 일이 자리마다 다시 시작되기 때문이다.
//
// ── 왜 `controls`가 필수인가
// 눈으로 보는 사람은 조작 **아래**에 영역이 나타나는 것을 본다. 낭독기 사용자에게는 그 공간
// 관계가 없다 — `aria-controls`가 없으면 "펼쳐짐"이라고만 읽히고 **무엇이** 펼쳐졌는지는 알 수
// 없다. 그래서 선택 인자로 두지 않는다. 접는 영역에는 언제나 id가 있어야 한다.
import '../styles/int37-disclosure.css';

import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

/** 표시의 크기. 자리마다 글자 크기가 달라도 표시는 하나여야 하므로 여기서 못 박는다. */
const CHEVRON_SIZE = 17;

export interface DisclosureToggleProps {
  /** 지금 펴져 있는가. */
  open: boolean;
  /** 누르면 뒤집는다. */
  onToggle: () => void;
  /**
   * 여닫는 영역의 `id`.
   *
   * 그 영역은 접혀 있을 때도 문서에 있어야 한다(`hidden`으로 접는다). 조건부로 아예 지우면
   * 접힌 동안 이 `id`가 아무것도 안 가리켜 낭독기가 길을 잃는다. 무거운 내용은 영역을 남긴 채
   * **안쪽만** 조건부로 두면 된다 — `App.tsx`의 `명함 기록`이 그 예다.
   */
  controls: string;
  /** 자리마다 다른 배치·색·두께는 호출부의 class가 소유한다. */
  className?: string;
  /** 보이는 글자와 낭독기가 읽을 이름이 달라야 할 때만. */
  label?: string;
  /** 표시 왼쪽에 서는 것 전부. */
  children: ReactNode;
}

export function DisclosureToggle({ open, onToggle, controls, className, label, children }: DisclosureToggleProps) {
  return (
    <button
      type="button"
      className={`k-disclosure${className ? ` ${className}` : ''}`}
      /* 게이트가 "접는 조작마다 공용 표시가 정확히 하나"를 세는 표식. class 이름이 아니라
         이것으로 센다 — class는 자리마다 다르고 앞으로도 바뀐다. */
      data-disclosure="true"
      aria-expanded={open}
      aria-controls={controls}
      {...(label ? { 'aria-label': label } : {})}
      onClick={onToggle}
    >
      {children}
      <ChevronDown
        className="k-disclosure-chevron"
        data-disclosure-chevron="true"
        aria-hidden="true"
        size={CHEVRON_SIZE}
      />
    </button>
  );
}
