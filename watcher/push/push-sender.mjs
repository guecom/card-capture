import process from 'node:process';
import webpush from 'web-push';

const ALLOWED_KINDS = new Set(['final_result', 'human_input_required', 'recovery_required']);
const ENDPOINT = /^https:\/\/fcm\.googleapis\.com\/(?:fcm\/send|wp)\/[A-Za-z0-9._~!$&'()*+,;=:@%\/-]{20,1900}$/;
const BASE64URL_KEY = /^[A-Za-z0-9_-]+$/;

function result(value, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exitCode = exitCode;
}

function fail(code, exitCode = 2) {
  result({ ok: false, errorCode: code }, exitCode);
}

function validVapid(value) {
  return value && typeof value === 'object' &&
    (/^mailto:[^\s@]+@[^\s@]+$/.test(String(value.subject || '')) || /^https:\/\/[^\s]+$/.test(String(value.subject || ''))) &&
    BASE64URL_KEY.test(String(value.publicKey || '')) && String(value.publicKey).length >= 80 && String(value.publicKey).length <= 120 &&
    BASE64URL_KEY.test(String(value.privateKey || '')) && String(value.privateKey).length >= 40 && String(value.privateKey).length <= 60;
}

function validSubscription(value) {
  const keys = value?.keys;
  return value && typeof value === 'object' && ENDPOINT.test(String(value.endpoint || '')) &&
    keys && BASE64URL_KEY.test(String(keys.p256dh || '')) && String(keys.p256dh).length >= 80 && String(keys.p256dh).length <= 120 &&
    BASE64URL_KEY.test(String(keys.auth || '')) && String(keys.auth).length >= 20 && String(keys.auth).length <= 40 &&
    (value.expirationTime === null || value.expirationTime === undefined || Number.isFinite(value.expirationTime));
}

function validPayload(value) {
  if (!value || value.v !== 1 || !ALLOWED_KINDS.has(String(value.kind || ''))) return false;
  if (!/^pne-[a-f0-9]{64}$/.test(String(value.eventId || ''))) return false;
  return /^[A-Za-z0-9_-]{4,80}$/.test(String(value.target || ''));
}

async function readInput() {
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 16384) throw new Error('request_too_large');
  }
  return JSON.parse(raw);
}

if (process.argv.length === 3 && process.argv[2] === '--generate') {
  const keys = webpush.generateVAPIDKeys();
  result({ ok: true, publicKey: keys.publicKey, privateKey: keys.privateKey });
} else {
  try {
    const request = await readInput();
    if (!request || request.operation !== 'send') fail('bad_operation');
    else if (!validVapid(request.vapid)) fail('bad_vapid');
    else if (!validSubscription(request.subscription)) fail('bad_subscription');
    else if (!validPayload(request.payload)) fail('bad_payload');
    else {
      webpush.setVapidDetails(request.vapid.subject, request.vapid.publicKey, request.vapid.privateKey);
      try {
        const response = await webpush.sendNotification(
          request.subscription,
          JSON.stringify(request.payload),
          {
            TTL: 300,
            urgency: 'normal',
            topic: request.payload.eventId.slice(4, 36),
            timeout: 20000
          }
        );
        result({ ok: true, statusCode: Number(response?.statusCode || 201) });
      } catch (error) {
        const statusCode = Number(error?.statusCode || 0);
        const permanent = statusCode === 404 || statusCode === 410;
        result({
          ok: false,
          errorCode: permanent ? 'subscription_gone' : (statusCode === 429 ? 'rate_limited' : 'delivery_failed'),
          statusCode,
          permanent,
          retryable: !permanent
        }, permanent ? 0 : 1);
      }
    }
  } catch (error) {
    fail(error?.message === 'request_too_large' ? 'request_too_large' : 'bad_request');
  }
}
