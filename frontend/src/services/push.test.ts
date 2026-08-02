import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeConfig } from '../contracts/capture';
import { disablePushNotifications, enablePushNotifications, inspectPushState, type PushEnvironment } from './push';

const config: RuntimeConfig = {
  apiUrl: 'https://api.example.test/exec',
  token: 'owner-token',
  capturer: 'Fixture Owner',
};

// Valid uncompressed P-256 point shape. Cryptographic validity belongs to the sender;
// the browser adapter only needs to reject malformed/truncated configuration.
const PUBLIC_KEY = `B${'A'.repeat(86)}`;
const KEY_ID = `vpk-${'a'.repeat(20)}`;

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function fixture(options: {
  permission?: NotificationPermission;
  online?: boolean;
  supported?: boolean;
  subscription?: ReturnType<typeof subscriptionFixture> | null;
  server?: unknown;
  subscribeThrows?: boolean;
} = {}) {
  let current = options.subscription ?? null;
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  const subscribe = vi.fn(async () => {
    if (options.subscribeThrows) throw new Error('synthetic failure');
    current = subscriptionFixture();
    return current;
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const action = init?.body ? (JSON.parse(String(init.body)) as { action?: string }).action : '';
    if (action === 'pushconfig') return response(options.server ?? { ok: true, enabled: true, publicKey: PUBLIC_KEY, keyId: KEY_ID });
    if (action === 'pushstatus') return response({ ok: true, active: true });
    return response({ ok: true });
  });
  const environment: PushEnvironment = {
    notification: options.supported === false ? undefined : {
      permission: options.permission ?? 'default',
      requestPermission,
    },
    serviceWorker: options.supported === false ? undefined : {
      ready: Promise.resolve({
        pushManager: {
          getSubscription: vi.fn(async () => current),
          subscribe,
        },
      }),
    },
    pushManagerSupported: options.supported !== false,
    online: options.online !== false,
    fetch: fetchMock,
  };
  return { environment, fetchMock, requestPermission, subscribe, current: () => current };
}

function subscriptionFixture(endpoint = 'https://fcm.googleapis.com/fcm/send/opaque-capability') {
  const unsubscribe = vi.fn(async () => true);
  return {
    endpoint,
    toJSON: () => ({
      endpoint,
      expirationTime: null,
      keys: { p256dh: 'public-client-key', auth: 'auth-secret' },
    }),
    unsubscribe,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('push capability inspection', () => {
  it('does not ask permission while merely rendering settings', async () => {
    const harness = fixture();
    await expect(inspectPushState(config, harness.environment)).resolves.toEqual({ status: 'capable' });
    expect(harness.requestPermission).not.toHaveBeenCalled();
  });

  it.each([
    [{ supported: false }, 'unsupported'],
    [{ permission: 'denied' as const }, 'denied'],
    [{ online: false }, 'offline'],
    [{ server: { ok: true, enabled: false } }, 'server_disabled'],
  ])('reports an actionable non-ready state for %j', async (options, expected) => {
    const harness = fixture(options);
    await expect(inspectPushState(config, harness.environment)).resolves.toMatchObject({ status: expected });
  });

  it('distinguishes a granted-but-off device from a subscribed device', async () => {
    await expect(inspectPushState(config, fixture({ permission: 'granted' }).environment)).resolves.toEqual({ status: 'off' });
    await expect(inspectPushState(config, fixture({ permission: 'granted', subscription: subscriptionFixture() }).environment)).resolves.toEqual({ status: 'subscribed' });
  });

  it('marks an existing subscription stale when the server rotates its VAPID key', async () => {
    const subscription = {
      ...subscriptionFixture(),
      options: { applicationServerKey: new Uint8Array(65).buffer },
    };
    await expect(inspectPushState(config, fixture({ permission: 'granted', subscription }).environment))
      .resolves.toEqual({ status: 'stale', detail: 'key_changed' });
  });

  it('does not claim subscribed when the private registry lost the browser subscription', async () => {
    const harness = fixture({ permission: 'granted', subscription: subscriptionFixture() });
    harness.fetchMock.mockImplementation(async (_input, init) => {
      const action = init?.body ? (JSON.parse(String(init.body)) as { action?: string }).action : '';
      if (action === 'pushconfig') return response({ ok: true, enabled: true, publicKey: PUBLIC_KEY, keyId: KEY_ID });
      return response({ ok: true, active: false });
    });
    await expect(inspectPushState(config, harness.environment))
      .resolves.toEqual({ status: 'stale', detail: 'registration_missing' });
  });

  it('contains a service worker registration failure instead of leaving settings busy forever', async () => {
    const harness = fixture({ permission: 'granted' });
    harness.environment.serviceWorker = { ready: new Promise(() => undefined) };
    harness.environment.readyTimeoutMs = 1;
    await expect(inspectPushState(config, harness.environment))
      .resolves.toEqual({ status: 'error', detail: 'server_unavailable' });
  });
});

describe('explicit opt-in and local-first revoke', () => {
  it('requests permission only inside enable, subscribes with userVisibleOnly, and authenticates the server write', async () => {
    const harness = fixture();
    await expect(enablePushNotifications(config, harness.environment)).resolves.toEqual({ status: 'subscribed' });
    expect(harness.requestPermission).toHaveBeenCalledOnce();
    expect(harness.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    const post = harness.fetchMock.mock.calls.find((call) => {
      const body = call[1]?.body ? JSON.parse(String(call[1]?.body)) as { action?: string } : null;
      return body?.action === 'pushsubscribe';
    });
    const payload = JSON.parse(String(post?.[1]?.body));
    expect(payload).toMatchObject({ action: 'pushsubscribe', keyId: KEY_ID, k: 'owner-token' });
    expect(payload.subscription.endpoint).toContain('opaque-capability');
  });

  it('rolls back the browser subscription when the server refuses registration', async () => {
    const harness = fixture();
    harness.fetchMock.mockImplementation(async (_input, init) => {
      const action = init?.body ? (JSON.parse(String(init.body)) as { action?: string }).action : '';
      return action === 'pushconfig'
        ? response({ ok: true, enabled: true, publicKey: PUBLIC_KEY, keyId: KEY_ID })
        : response({ ok: false });
    });
    await expect(enablePushNotifications(config, harness.environment)).resolves.toEqual({ status: 'error', detail: 'subscription_failed' });
    expect(harness.current()?.unsubscribe).toHaveBeenCalledOnce();
  });

  it('revokes locally while offline without leaking the endpoint into a URL or persisted state', async () => {
    const subscription = subscriptionFixture();
    const harness = fixture({ permission: 'granted', online: false, subscription });
    await expect(disablePushNotifications(config, harness.environment)).resolves.toEqual({ status: 'off', detail: 'cleanup_pending' });
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('keeps local revoke available while an already-subscribed device is offline', async () => {
    const harness = fixture({ permission: 'granted', online: false, subscription: subscriptionFixture() });
    await expect(inspectPushState(config, harness.environment))
      .resolves.toEqual({ status: 'offline', detail: 'local_subscription' });
    expect(harness.fetchMock).not.toHaveBeenCalled();
  });

  it('sends only the endpoint needed for authenticated removal after local revoke', async () => {
    const subscription = subscriptionFixture();
    const harness = fixture({ permission: 'granted', subscription });
    await expect(disablePushNotifications(config, harness.environment)).resolves.toEqual({ status: 'off' });
    const payload = JSON.parse(String(harness.fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload).toEqual({ action: 'pushunsubscribe', endpoint: subscription.endpoint, k: 'owner-token' });
  });
});
