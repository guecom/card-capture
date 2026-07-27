// 하단 탭 바가 스크롤 중에 내려갔다 다시 올라오는 문제 (INT-000016 항목 001).
//
// founder 관찰: "위아래로 스크롤을 빠르게 하면 하단에 있는 바가 아래로 없어졌다 위로 올라갔다."
//
// 앱에는 스크롤에 반응해 바를 숨기는 코드가 없다. 원인은 **껍데기 높이**다.
// Ionic은 `body`를 `position: fixed; height: 100%`로 잡는데, 모바일 브라우저에서 이 100%는
// 주소창이 접힌 상태의 큰 viewport(large viewport)다. 주소창이 펴져 있는 동안에는 화면 아래
// 수십 px이 주소창에 가려지고, 거기 놓인 탭 바가 통째로 안 보인다. 스크롤로 주소창이 접히면
// 다시 드러난다 — 사용자에게는 "바가 내려갔다 올라온다"로 보인다.
//
// 고치는 방법은 껍데기를 **지금 보이는 높이**에 맞추는 것이다(`100dvh`). CSS 단위라서
// 스크롤 이벤트를 듣지 않고, 따라서 스크롤 중에 우리가 만드는 흔들림이 없다.
// → `app.css`의 `--cc-app-height`.
//
// 이 파일이 맡는 건 CSS가 혼자 처리하지 못하는 나머지 하나다: safe-area.
// iOS는 주소창 상태에 따라 `env(safe-area-inset-bottom)`을 0 ↔ 홈 인디케이터 높이로 바꿔 보고한다.
// 그 값을 탭 바 높이에 그대로 쓰면 스크롤 중에 바 높이가 오르내린다. 그래서 지금까지 본
// **가장 큰 값만** 남긴다 — 한 번 늘어난 뒤로는 줄지 않으므로 스크롤 도중 높이가 변하지 않는다.

const HELD_PROPERTY = '--cc-safe-bottom';

/** `env(safe-area-inset-bottom)`을 px로 실측한다. 계산된 값을 읽을 다른 방법이 없다. */
function measureSafeAreaBottom(): number {
  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = [
    'position:fixed',
    'left:-9999px',
    'bottom:0',
    'width:1px',
    'height:env(safe-area-inset-bottom, 0px)',
    'visibility:hidden',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(probe);
  const measured = probe.getBoundingClientRect().height;
  probe.remove();
  return Number.isFinite(measured) ? measured : 0;
}

/**
 * 탭 바가 예약하는 아래 여백을 고정한다. 반환값을 호출하면 관찰을 멈춘다.
 * 값이 커질 때만 갱신하므로, 스크롤 도중 바 높이가 줄어드는 일은 생기지 않는다.
 */
export function holdSafeAreaInset(): () => void {
  let held = -1;
  const sample = () => {
    const measured = measureSafeAreaBottom();
    if (measured <= held) return;
    held = measured;
    document.documentElement.style.setProperty(HELD_PROPERTY, `${held}px`);
  };

  sample();
  window.addEventListener('resize', sample);
  window.addEventListener('orientationchange', sample);
  globalThis.visualViewport?.addEventListener('resize', sample);
  return () => {
    window.removeEventListener('resize', sample);
    window.removeEventListener('orientationchange', sample);
    globalThis.visualViewport?.removeEventListener('resize', sample);
  };
}
