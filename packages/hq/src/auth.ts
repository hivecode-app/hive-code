// Devices and passkeys (#23). Every device has its own token, which can be revoked; hq's api-token
// stays on the server (CLI, tools). A device gets a token in one of three ways:
//   - login:    a passkey already registered (fingerprint), from any device the passkey syncs to;
//   - register: a one-time pairing code plus a new passkey on this device;
//   - pair:     a one-time pairing code alone, when the device can't make a passkey.
// Pairing codes come from a device that is already in (settings → devices) or `main.ts pair` on the
// server. Tokens and codes are stored as sha256 only. Challenges live in memory for 5 minutes.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type AuthenticatorTransportFuture, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';

export class AuthError extends Error {
  public status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Caller = { kind: 'admin' } | { kind: 'device'; id: string };

export interface DeviceRow {
  id: string; name: string; via: 'passkey' | 'register' | 'pair'; passkey_id: string | null;
  created_at: number; last_seen_at: number | null; revoked_at: number | null;
}
export interface PasskeyRow { id: string; name: string; created_at: number; last_used_at: number | null; revoked_at: number | null }

const CHALLENGE_MS = 5 * 60_000;
const SEEN_EVERY_MS = 60_000;
// Pairing codes: 8 characters without look-alikes (~40 bits), single use, 10 minutes. Wrong guesses
// are counted per client address; past the limit, that address can't redeem until the window passes.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_BAD_CODES = 20;
const BAD_CODE_WINDOW_MS = 10 * 60_000;
// Open endpoints keep challenges in memory; the oldest go first past this many.
const MAX_CHALLENGES = 1000;
// One owner, one WebAuthn user. Fixed so a synced passkey manager keeps a single "רן" entry.
const USER_ID = new TextEncoder().encode('company-owner');

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function clientChallenge(resp: { response?: { clientDataJSON?: unknown } }): string {
  try {
    const cd = JSON.parse(Buffer.from(String(resp.response?.clientDataJSON ?? ''), 'base64url').toString('utf8')) as { challenge?: unknown };
    if (typeof cd.challenge === 'string') return cd.challenge;
  } catch { /* fall through */ }
  throw new AuthError(400, 'invalid credential');
}

export class Auth {
  private challenges = new Map<string, { kind: 'register' | 'login'; code?: string; expires: number }>();
  private seen = new Map<string, number>();
  private badCodes = new Map<string, number[]>();
  private revokeListeners = new Set<(deviceIds: string[]) => void>();
  private readonly store: Store;
  private readonly cfg: HqConfig['auth'];

  constructor(store: Store, cfg: HqConfig['auth']) {
    this.store = store;
    this.cfg = cfg;
  }

  private now() { return this.store.now(); }

  /** The live device holding this token, or null. (hq's own token is checked by the API.) */
  deviceFor(token: string | null | undefined): Caller | null {
    if (!token) return null;
    const row = this.store.db.prepare('SELECT id FROM devices WHERE token_hash = ? AND revoked_at IS NULL').get(sha256(token)) as { id: string } | undefined;
    if (!row) return null;
    const now = this.now();
    if (now - (this.seen.get(row.id) ?? 0) >= SEEN_EVERY_MS) {
      this.seen.set(row.id, now);
      this.store.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, row.id);
    }
    return { kind: 'device', id: row.id };
  }

  /** Called with the device ids whose tokens just stopped working (the API closes their sockets). */
  onRevoke(l: (deviceIds: string[]) => void): () => void {
    this.revokeListeners.add(l);
    return () => this.revokeListeners.delete(l);
  }

  // ── pairing codes ─────────────────────────────────────────────────────────

  createPairCode(by: Caller): { code: string; expires_at: number; link: string | null } {
    let raw = '';
    for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const now = this.now(), expires = now + this.cfg.pairCodeMs;
    this.store.db.prepare('DELETE FROM pair_codes WHERE expires_at < ?').run(now - 86_400_000);
    this.store.db.prepare('INSERT INTO pair_codes (code_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(raw), by.kind === 'admin' ? 'admin' : by.id, now, expires);
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    this.store.emit('device.pair_code', null, { by: by.kind === 'admin' ? 'admin' : by.id, expires_at: expires });
    return { code, expires_at: expires, link: this.cfg.appUrl ? `${this.cfg.appUrl}?pair=${code}` : null };
  }

  /** A usable code (not used, not expired), normalized; throws otherwise and counts the miss against [client]. */
  private validCode(code: unknown, client: string): string {
    const now = this.now();
    for (const [k, ts] of this.badCodes) {
      const fresh = ts.filter((t) => now - t < BAD_CODE_WINDOW_MS);
      if (fresh.length) this.badCodes.set(k, fresh); else this.badCodes.delete(k);
    }
    const misses = this.badCodes.get(client) ?? [];
    if (misses.length >= MAX_BAD_CODES) throw new AuthError(429, 'too many wrong codes, try again later');
    const c = typeof code === 'string' ? normalizeCode(code) : '';
    const row = c && this.store.db.prepare('SELECT expires_at, used_at FROM pair_codes WHERE code_hash = ?').get(sha256(c)) as
      { expires_at: number; used_at: number | null } | undefined;
    if (!row || row.used_at != null || row.expires_at < now) {
      this.badCodes.set(client, [...misses, now]);
      throw new AuthError(401, 'pairing code is wrong, used or expired');
    }
    return c;
  }

  private useCode(code: string, deviceId: string): void {
    const r = this.store.db.prepare('UPDATE pair_codes SET used_at = ?, used_by = ? WHERE code_hash = ? AND used_at IS NULL')
      .run(this.now(), deviceId, sha256(code));
    if (r.changes !== 1) throw new AuthError(401, 'pairing code is wrong, used or expired');
  }

  // ── devices ───────────────────────────────────────────────────────────────

  private addDevice(name: string, via: DeviceRow['via'], passkeyId: string | null): { token: string; device: DeviceRow } {
    const token = newToken();
    const id = `dev_${randomBytes(6).toString('hex')}`;
    const now = this.now();
    this.store.db.prepare('INSERT INTO devices (id, name, token_hash, via, passkey_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, name, sha256(token), via, passkeyId, now, now);
    this.store.emit('device.added', null, { id, name, via, passkey: passkeyId });
    return { token, device: this.device(id)! };
  }

  device(id: string): DeviceRow | undefined {
    return this.store.db.prepare('SELECT id, name, via, passkey_id, created_at, last_seen_at, revoked_at FROM devices WHERE id = ?').get(id) as DeviceRow | undefined;
  }

  devices(): { devices: DeviceRow[]; passkeys: PasskeyRow[] } {
    return {
      devices: this.store.db.prepare(`SELECT id, name, via, passkey_id, created_at, last_seen_at, revoked_at FROM devices
        WHERE revoked_at IS NULL ORDER BY COALESCE(last_seen_at, created_at) DESC`).all() as DeviceRow[],
      passkeys: this.store.db.prepare(`SELECT id, name, created_at, last_used_at, revoked_at FROM passkeys
        WHERE revoked_at IS NULL ORDER BY created_at DESC`).all() as PasskeyRow[],
    };
  }

  revokeDevice(id: string): DeviceRow {
    const d = this.device(id);
    if (!d || d.revoked_at != null) throw new AuthError(404, `no device ${id}`);
    this.store.db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(this.now(), id);
    this.store.emit('device.revoked', null, { id, name: d.name });
    this.fireRevoke([id]);
    return this.device(id)!;
  }

  /** Removing a passkey also signs out every device that came in with it. */
  revokePasskey(id: string): { passkey: PasskeyRow; devices: string[] } {
    const p = this.store.db.prepare('SELECT id, name, created_at, last_used_at, revoked_at FROM passkeys WHERE id = ?').get(id) as PasskeyRow | undefined;
    if (!p || p.revoked_at != null) throw new AuthError(404, `no passkey ${id}`);
    const now = this.now();
    const ids = (this.store.db.prepare('SELECT id FROM devices WHERE passkey_id = ? AND revoked_at IS NULL').all(id) as { id: string }[]).map((r) => r.id);
    this.store.db.transaction(() => {
      this.store.db.prepare('UPDATE passkeys SET revoked_at = ? WHERE id = ?').run(now, id);
      this.store.db.prepare('UPDATE devices SET revoked_at = ? WHERE passkey_id = ? AND revoked_at IS NULL').run(now, id);
    })();
    this.store.emit('passkey.revoked', null, { id, name: p.name, devices: ids });
    this.fireRevoke(ids);
    return { passkey: { ...p, revoked_at: now }, devices: ids };
  }

  private fireRevoke(ids: string[]): void {
    for (const id of ids) this.seen.delete(id);
    if (!ids.length) return;
    for (const l of this.revokeListeners) {
      try { l(ids); } catch { /* a broken listener must not block revocation */ }
    }
  }

  // ── WebAuthn ──────────────────────────────────────────────────────────────

  private remember(challenge: string, kind: 'register' | 'login', code?: string): void {
    const now = this.now();
    for (const [k, v] of this.challenges) if (v.expires < now) this.challenges.delete(k);
    while (this.challenges.size >= MAX_CHALLENGES) this.challenges.delete(this.challenges.keys().next().value!);
    this.challenges.set(challenge, { kind, code, expires: now + CHALLENGE_MS });
  }

  /** Single use: the challenge is gone after the first attempt, good or bad. */
  private takeChallenge(challenge: string, kind: 'register' | 'login') {
    const c = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!c || c.kind !== kind || c.expires < this.now()) throw new AuthError(401, 'challenge expired, try again');
    return c;
  }

  async registerOptions(code: unknown, client: string) {
    const c = this.validCode(code, client);
    const existing = this.store.db.prepare('SELECT id, transports FROM passkeys WHERE revoked_at IS NULL').all() as { id: string; transports: string | null }[];
    const options = await generateRegistrationOptions({
      rpName: this.cfg.rpName, rpID: this.cfg.rpId, userID: USER_ID, userName: 'ran', userDisplayName: 'רן',
      attestationType: 'none', timeout: CHALLENGE_MS,
      excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports ? JSON.parse(p.transports) as AuthenticatorTransportFuture[] : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    this.remember(options.challenge, 'register', c);
    return options;
  }

  async register(response: unknown, name: string, client: string): Promise<{ token: string; device: DeviceRow }> {
    const resp = response as RegistrationResponseJSON;
    const ch = this.takeChallenge(clientChallenge(resp), 'register');
    const code = this.validCode(ch.code, client);
    let v: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      v = await verifyRegistrationResponse({
        response: resp, expectedChallenge: clientChallenge(resp), expectedOrigin: this.cfg.origins, expectedRPID: this.cfg.rpId,
        requireUserVerification: true,
      });
    } catch (e) { throw new AuthError(401, `passkey rejected: ${(e as Error).message}`); }
    if (!v.verified) throw new AuthError(401, 'passkey rejected');
    const cred = v.registrationInfo.credential;
    const now = this.now();
    return this.store.db.transaction(() => {
      this.store.db.prepare('INSERT INTO passkeys (id, public_key, counter, transports, name, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(cred.id, Buffer.from(cred.publicKey), cred.counter, cred.transports ? JSON.stringify(cred.transports) : null, name, now, now);
      const out = this.addDevice(name, 'register', cred.id);
      this.useCode(code, out.device.id);
      return out;
    })();
  }

  /** Pairing without a passkey: the code alone is the proof. */
  pair(code: unknown, name: string, client: string): { token: string; device: DeviceRow } {
    const c = this.validCode(code, client);
    return this.store.db.transaction(() => {
      const out = this.addDevice(name, 'pair', null);
      this.useCode(c, out.device.id);
      return out;
    })();
  }

  async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.cfg.rpId, userVerification: 'required', timeout: CHALLENGE_MS });
    this.remember(options.challenge, 'login');
    return options;
  }

  async login(response: unknown, name: string): Promise<{ token: string; device: DeviceRow }> {
    const resp = response as AuthenticationResponseJSON;
    const challenge = clientChallenge(resp);
    this.takeChallenge(challenge, 'login');
    const p = typeof resp.id === 'string' ? this.store.db.prepare('SELECT id, public_key, counter, transports FROM passkeys WHERE id = ? AND revoked_at IS NULL')
      .get(resp.id) as { id: string; public_key: Buffer; counter: number; transports: string | null } | undefined : undefined;
    if (!p) throw new AuthError(401, 'unknown passkey');
    let v: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      v = await verifyAuthenticationResponse({
        response: resp, expectedChallenge: challenge, expectedOrigin: this.cfg.origins, expectedRPID: this.cfg.rpId,
        requireUserVerification: true,
        credential: { id: p.id, publicKey: new Uint8Array(p.public_key), counter: p.counter,
          transports: p.transports ? JSON.parse(p.transports) as AuthenticatorTransportFuture[] : undefined },
      });
    } catch (e) { throw new AuthError(401, `passkey rejected: ${(e as Error).message}`); }
    if (!v.verified) throw new AuthError(401, 'passkey rejected');
    this.store.db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(v.authenticationInfo.newCounter, this.now(), p.id);
    return this.addDevice(name, 'passkey', p.id);
  }
}
