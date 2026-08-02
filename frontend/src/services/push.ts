import type { RuntimeConfig } from '../contracts/capture';

export type PushStatus =
  | 'checking'
  | 'disconnected'
  | 'unsupported'
  | 'denied'
  | 'offline'
  | 'server_disabled'
  | 'capable'
  | 'off'
  | 'subscribed'
  | 'stale'
  | 'error';

export interface PushState {
  status: PushStatus;
  /** Machine-readable and deliberately non-sensitive. Never place an endpoint or key here. */
  detail?: 'key_changed' | 'registration_missing' | 'cleanup_pending' | 'local_subscription' | 'server_unavailable' | 'subscription_failed';
}

interface NotificationApi {
  permission: NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
}

interface PushSubscriptionLike {
  endpoint: string;
  options?: { applicationServerKey?: ArrayBuffer | null };
  toJSON(): PushSubscriptionJSON;
  unsubscribe(): Promise<boolean>;
}

interface PushManagerLike {
  getSubscription(): Promise<PushSubscriptionLike | null>;
  subscribe(options: PushSubscriptionOptionsInit): Promise<PushSubscriptionLike>;
}

interface ServiceWorkerContainerLike {
  ready: Promise<{ pushManager: PushManagerLike }>;
}

type PushFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface PushEnvironment {
  notification?: NotificationApi;
  serviceWorker?: ServiceWorkerContainerLike;
  pushManagerSupported: boolean;
  online: boolean;
  fetch: PushFetch;
  readyTimeoutMs?: number;
}

async function readyRegistration(environment: PushEnvironment): Promise<{ pushManager: PushManagerLike }> {
  const timeoutMs = environment.readyTimeoutMs ?? 4_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      environment.serviceWorker!.ready,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('service_worker_not_ready')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

interface ServerPushConfig {
  enabled: boolean;
  publicKey: string;
  keyId: string;
}

function browserEnvironment(): PushEnvironment {
  const notification = typeof Notification === 'undefined'
    ? undefined
    : {
        get permission() { return Notification.permission; },
        requestPermission: () => Notification.requestPermission(),
      };
  return {
    notification,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      ? navigator.serviceWorker as unknown as ServiceWorkerContainerLike
      : undefined,
    pushManagerSupported: typeof window !== 'undefined' && 'PushManager' in window,
    online: typeof navigator === 'undefined' ? false : navigator.onLine,
    fetch: globalThis.fetch.bind(globalThis),
  };
}

function isSupported(environment: PushEnvironment): boolean {
  return Boolean(environment.notification && environment.serviceWorker && environment.pushManagerSupported);
}

function configured(config: RuntimeConfig): boolean {
  return Boolean(config.apiUrl.trim() && config.token.trim());
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(value)) return null;
  try {
    const padded = `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat((4 - value.length % 4) % 4)}`;
    const decoded = atob(padded);
    const bytes = new Uint8Array(new ArrayBuffer(decoded.length));
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    // Uncompressed P-256 public key: 0x04 + two 32-byte coordinates.
    return bytes.length === 65 && bytes[0] === 4 ? bytes : null;
  } catch {
    return null;
  }
}

async function loadServerConfig(config: RuntimeConfig, environment: PushEnvironment): Promise<ServerPushConfig | null> {
  const response = await environment.fetch(config.apiUrl.trim(), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'pushconfig', k: config.token }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { ok?: unknown; enabled?: unknown; publicKey?: unknown; keyId?: unknown };
  if (payload.ok !== true) return null;
  if (payload.enabled !== true) return { enabled: false, publicKey: '', keyId: '' };
  if (typeof payload.publicKey !== 'string' || !base64UrlBytes(payload.publicKey) ||
      typeof payload.keyId !== 'string' || !/^vpk-[a-f0-9]{20}$/.test(payload.keyId)) return null;
  return { enabled: true, publicKey: payload.publicKey, keyId: payload.keyId };
}

async function subscriptionRegistered(
  config: RuntimeConfig,
  environment: PushEnvironment,
  endpoint: string,
): Promise<boolean | null> {
  const response = await environment.fetch(config.apiUrl.trim(), {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ action: 'pushstatus', endpoint, k: config.token }),
  });
  if (!response.ok) return null;
  const payload = await response.json() as { ok?: unknown; active?: unknown };
  return payload.ok === true ? payload.active === true : null;
}

function sameBytes(left: ArrayBuffer, right: Uint8Array<ArrayBuffer>): boolean {
  const bytes = new Uint8Array(left);
  return bytes.length === right.length && bytes.every((value, index) => value === right[index]);
}

function matchesServerKey(subscription: PushSubscriptionLike, publicKey: string): boolean {
  const current = subscription.options?.applicationServerKey;
  const expected = base64UrlBytes(publicKey);
  // Some older browsers do not expose options on an existing subscription. The server-side
  // registration remains the authority in that case; do not destroy a working subscription.
  return !current || !expected || sameBytes(current, expected);
}

async function postPushAction(
  config: RuntimeConfig,
  environment: PushEnvironment,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const response = await environment.fetch(config.apiUrl.trim(), {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ ...payload, k: config.token }),
  });
  if (!response.ok) return false;
  const result = await response.json() as { ok?: unknown };
  return result.ok === true;
}

/** Read-only state inspection. It never requests permission and therefore is safe outside a click. */
export async function inspectPushState(
  config: RuntimeConfig,
  environment: PushEnvironment = browserEnvironment(),
): Promise<PushState> {
  if (!configured(config)) return { status: 'disconnected' };
  if (!isSupported(environment)) return { status: 'unsupported' };

  try {
    // Local subscription truth is readable without the network. Keep revoke available when the
    // browser is denied, the device is offline, or the server has paused sending.
    const registration = await readyRegistration(environment);
    const subscription = await registration.pushManager.getSubscription();
    if (environment.notification?.permission === 'denied') {
      return { status: 'denied', ...(subscription ? { detail: 'local_subscription' as const } : {}) };
    }
    if (!environment.online) {
      return { status: 'offline', ...(subscription ? { detail: 'local_subscription' as const } : {}) };
    }
    const server = await loadServerConfig(config, environment);
    if (!server) return { status: 'error', detail: 'server_unavailable' };
    if (!server.enabled) return { status: 'server_disabled', ...(subscription ? { detail: 'local_subscription' as const } : {}) };
    if (!subscription) {
      return { status: environment.notification?.permission === 'default' ? 'capable' : 'off' };
    }
    if (!matchesServerKey(subscription, server.publicKey)) return { status: 'stale', detail: 'key_changed' };
    const registered = await subscriptionRegistered(config, environment, subscription.endpoint);
    if (registered === null) return { status: 'error', detail: 'server_unavailable' };
    if (!registered) return { status: 'stale', detail: 'registration_missing' };
    return { status: 'subscribed' };
  } catch {
    return { status: 'error', detail: 'server_unavailable' };
  }
}

/**
 * Must be called directly from an explicit user gesture. A server refusal rolls the browser
 * subscription back immediately so the UI never claims a notification path that cannot deliver.
 */
export async function enablePushNotifications(
  config: RuntimeConfig,
  environment: PushEnvironment = browserEnvironment(),
): Promise<PushState> {
  if (!configured(config)) return { status: 'disconnected' };
  if (!isSupported(environment)) return { status: 'unsupported' };
  if (!environment.online) return { status: 'offline' };
  if (environment.notification?.permission === 'denied') return { status: 'denied' };

  try {
    // Ask immediately inside the click continuation. The settings screen already proved server
    // readiness; this order preserves transient user activation on stricter mobile browsers.
    const permission = environment.notification!.permission === 'granted'
      ? 'granted'
      : await environment.notification!.requestPermission();
    if (permission !== 'granted') return { status: permission === 'denied' ? 'denied' : 'capable' };

    const server = await loadServerConfig(config, environment);
    if (!server) return { status: 'error', detail: 'server_unavailable' };
    if (!server.enabled) return { status: 'server_disabled' };

    const applicationServerKey = base64UrlBytes(server.publicKey)!;
    const registration = await readyRegistration(environment);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !matchesServerKey(subscription, server.publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
    }

    const accepted = await postPushAction(config, environment, {
      action: 'pushsubscribe',
      keyId: server.keyId,
      subscription: subscription.toJSON(),
    });
    if (!accepted) {
      await subscription.unsubscribe().catch(() => false);
      return { status: 'error', detail: 'subscription_failed' };
    }
    return { status: 'subscribed' };
  } catch {
    return { status: 'error', detail: 'subscription_failed' };
  }
}

/**
 * Revocation is local-first: even when offline, the endpoint is invalidated on this device.
 * Server cleanup is best-effort and a 404/410 sender response can safely prune any stale record.
 */
export async function disablePushNotifications(
  config: RuntimeConfig,
  environment: PushEnvironment = browserEnvironment(),
): Promise<PushState> {
  if (!isSupported(environment)) return { status: 'unsupported' };
  let localRevoked = false;
  try {
    const registration = await readyRegistration(environment);
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return configured(config) ? { status: 'off' } : { status: 'disconnected' };
    const endpoint = subscription.endpoint;
    localRevoked = await subscription.unsubscribe();

    if (!configured(config) || !environment.online) {
      return localRevoked ? { status: 'off', detail: 'cleanup_pending' } : { status: 'stale', detail: 'cleanup_pending' };
    }
    const removed = await postPushAction(config, environment, { action: 'pushunsubscribe', endpoint });
    return localRevoked && removed ? { status: 'off' } : { status: 'stale', detail: 'cleanup_pending' };
  } catch {
    return localRevoked ? { status: 'off', detail: 'cleanup_pending' } : { status: 'stale', detail: 'cleanup_pending' };
  }
}
