export async function registerCandidateServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    // 새 배포가 activate되면 페이지를 한 번 자동 새로고침한다 — 이게 없으면 홈 화면 PWA가
    // 항상 "한 번 전 실행" 빌드를 보여줘 사용자가 수정 반영 여부를 알 수 없다 (2026-07-26 실폰 혼선).
    // 최초 설치(기존 controller 없음)에는 새로고침하지 않는다.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloadedForUpdate = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadedForUpdate) return;
      reloadedForUpdate = true;
      window.location.reload();
    });

    const registration = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    await navigator.serviceWorker.ready;

    let candidateControlsPage = await pingCandidateController();
    if (!candidateControlsPage) {
      await new Promise<void>((resolve) => {
        const timeout = window.setTimeout(resolve, 3_000);
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.clearTimeout(timeout);
          resolve();
        }, { once: true });
      });
      candidateControlsPage = await pingCandidateController();
    }
    document.documentElement.dataset.offlineReady = candidateControlsPage ? 'true' : 'installed';
    return registration;
  } catch {
    document.documentElement.dataset.offlineReady = 'false';
    return null;
  }
}

function pingCandidateController(): Promise<boolean> {
  const controller = navigator.serviceWorker.controller;
  if (!controller) return Promise.resolve(false);

  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => resolve(false), 1_000);
    channel.port1.onmessage = (event: MessageEvent<{ type?: string }>) => {
      window.clearTimeout(timeout);
      resolve(event.data?.type === 'CC_PONG');
    };
    controller.postMessage({ type: 'CC_PING' }, [channel.port2]);
  });
}
