// FCM HTTP v1 (task 1474): the Android app's push, instead of the foreground service that held a WebSocket and so kept a
// notification on his phone all the time (Android raises a foreground service's MIN channel to LOW).
// A message carries no content he must read elsewhere: the app wakes, fetches from hq over HTTPS and posts the
// notifications itself, as it did on a socket event, then acks (push.ts fcmReachable). Nothing he reads goes through
// Google. The service account key lives in hq's state dir on hq-host (fcm-service-account.json), never in a repo.
// No key = no FCM: the app's old socket and Telegram still work.
import { createSign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface FcmMessage {
  /** String values only (FCM data messages). */
  data: Record<string, string>;
  /** high wakes the phone from Doze: only for what alerts. Android lowers an app that sends high and shows nothing. */
  priority: 'high' | 'normal';
  /** Messages with the same key replace each other while the phone is offline (a sync is one, however many). */
  collapseKey?: string;
  ttlSec?: number;
}

/** Throws an error with `status` (HTTP) and `unregistered` when the token is gone for good. */
export type FcmSend = (token: string, msg: FcmMessage) => Promise<void>;

export class FcmError extends Error {
  status: number;
  unregistered: boolean;
  constructor(message: string, status: number, unregistered: boolean) {
    super(message);
    this.status = status;
    this.unregistered = unregistered;
  }
}

interface ServiceAccount { project_id: string; client_email: string; private_key: string; token_uri?: string }

type Fetch = typeof fetch;

/** The sender for the key at [file], or null when there is none (FCM is then off). */
export function fcmFromFile(file: string, fetchFn: Fetch = fetch): FcmSend | null {
  if (!existsSync(file)) return null;
  const sa = JSON.parse(readFileSync(file, 'utf8')) as ServiceAccount;
  if (!sa.project_id || !sa.client_email || !sa.private_key) throw new Error(`${file}: not a service account key (project_id, client_email, private_key)`);
  return fcmSender(sa, fetchFn);
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

export function fcmSender(sa: ServiceAccount, fetchFn: Fetch = fetch, now: () => number = Date.now): FcmSend {
  const tokenUri = sa.token_uri ?? 'https://oauth2.googleapis.com/token';
  let access: { token: string; until: number } | null = null;

  async function accessToken(): Promise<string> {
    if (access && access.until > now() + 60_000) return access.token;
    const iat = Math.floor(now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: tokenUri, iat, exp: iat + 3600 }));
    const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
    const res = await fetchFn(tokenUri, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = await res.json().catch(() => ({})) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !j.access_token) throw new FcmError(`fcm auth: ${res.status} ${j.error_description ?? ''}`.trim(), res.status, false);
    access = { token: j.access_token, until: now() + (j.expires_in ?? 3600) * 1000 };
    return access.token;
  }

  return async (token, msg) => {
    const body = { message: { token, data: msg.data, android: {
      priority: msg.priority === 'high' ? 'HIGH' : 'NORMAL',
      ttl: `${msg.ttlSec ?? 3600}s`,
      ...(msg.collapseKey ? { collapse_key: msg.collapseKey } : {}),
    } } };
    const res = await fetchFn(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return;
    const text = await res.text().catch(() => '');
    if (res.status === 401) access = null;
    // 404 UNREGISTERED: the app was uninstalled or the token rotated. 400 INVALID_ARGUMENT on the token: never valid.
    const unregistered = res.status === 404 || /UNREGISTERED|registration-token-not-registered/.test(text);
    throw new FcmError(`fcm ${res.status}: ${text.slice(0, 300)}`, res.status, unregistered);
  };
}
