export async function registerCandidateServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
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
