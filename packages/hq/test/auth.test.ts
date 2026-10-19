// Devices and passkeys (#23), end to end over the real API with a software authenticator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { makeEnv, until } from './helpers.ts';

const RP_ID = 'app.hq.example.com';
const ORIGIN = 'https://app.hq.example.com';
const b64u = (b: Uint8Array | string) => Buffer.from(b).toString('base64url');

// Minimal CBOR encoder: what a "none" attestation and a COSE EC2 key need.
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]); }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: unsupported');
}

/** A platform authenticator holding one ES256 passkey, with user verification (fingerprint). */
class SoftAuthenticator {
  readonly credId = randomBytes(16);
  private key: KeyObject;
  private pub: { x: string; y: string };
  counter = 0;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.key = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.pub = { x: jwk.x!, y: jwk.y! };
  }
  get id() { return b64u(this.credId); }

  private authData(flags: number, attested?: Buffer) {
    const cnt = Buffer.alloc(4); cnt.writeUInt32BE(this.counter);
    return Buffer.concat([createHash('sha256').update(RP_ID).digest(), Buffer.from([flags]), cnt, ...(attested ? [attested] : [])]);
  }

  create(options: { challenge: string }, origin = ORIGIN) {
    const cose = cbor(new Map<number, unknown>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(this.pub.x, 'base64url')], [-3, Buffer.from(this.pub.y, 'base64url')]]));
    const len = Buffer.alloc(2); len.writeUInt16BE(this.credId.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, this.credId, cose]);
    const attObj = cbor(new Map<string, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', this.authData(0x45, attested)]]));
    const clientData = JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false });
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attObj), transports: ['internal'] } };
  }

  get(options: { challenge: string }, origin = ORIGIN) {
    this.counter++;
    const ad = this.authData(0x05);
    const clientData = JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false });
    const sig = sign('sha256', Buffer.concat([ad, createHash('sha256').update(clientData).digest()]), this.key);
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: b64u('company-owner') } };
  }
}

async function authEnv() {
  const env = await makeEnv({ noStart: true, cfg: { auth: { rpId: RP_ID, rpName: 'החברה', origins: [ORIGIN], appUrl: `${ORIGIN}/p/`, pairCodeMs: 10 * 60_000 } } });
  await env.hq.start({ listen: true, timers: false });
  const admin = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
  const base = `http://127.0.0.1:${env.hq.port}`;
  const call = async (method: string, path: string, body?: unknown, token: string | null = admin, from?: string) => {
    const res = await fetch(base + path, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(from ? { 'x-forwarded-for': from } : {}), 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const pairCode = async (token = admin) => (await call('POST', '/api/devices/pair', {}, token)).json.code as string;
  /** Pair code + new passkey on this "device": the full first-time flow. */
  const register = async (auth: SoftAuthenticator, name: string, code?: string) => {
    code ??= await pairCode();
    const opts = await call('POST', '/api/auth/register/options', { code }, null);
    assert.equal(opts.status, 200, JSON.stringify(opts.json));
    return call('POST', '/api/auth/register', { name, credential: auth.create(opts.json as { challenge: string }) }, null);
  };
  const login = async (auth: SoftAuthenticator, name: string, origin = ORIGIN) => {
    const opts = await call('POST', '/api/auth/login/options', {}, null);
    return call('POST', '/api/auth/login', { name, credential: auth.get(opts.json as { challenge: string }, origin) }, null);
  };
  return { ...env, admin, base, call, pairCode, register, login };
}

test('auth: pair code + passkey gives a device its own token; passkey login gives another device one', async () => {
  const env = await authEnv();
  try {
    const { call } = env;
    assert.equal((await call('GET', '/api/board', undefined, null)).status, 401);
    const pc = await call('POST', '/api/devices/pair', {});
    assert.match(pc.json.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(pc.json.link, `${ORIGIN}/p/?pair=${pc.json.code}`);

    const phone = new SoftAuthenticator();
    const reg = await env.register(phone, 'OnePlus 13', pc.json.code.toLowerCase().replace('-', ' '));
    assert.equal(reg.status, 200, JSON.stringify(reg.json));
    const phoneToken = reg.json.token as string;
    assert.equal(reg.json.device.via, 'register');
    assert.equal((await call('GET', '/api/board', undefined, phoneToken)).status, 200);
    assert.ok(!JSON.stringify(env.hq.store.db.prepare('SELECT * FROM devices').all()).includes(phoneToken), 'only the hash is stored');

    // The code is spent.
    assert.equal((await call('POST', '/api/auth/register/options', { code: pc.json.code }, null)).status, 401);

    // Same passkey, synced to the laptop: fingerprint login, a separate device and token.
    const lg = await env.login(phone, 'Chrome במחשב');
    assert.equal(lg.status, 200, JSON.stringify(lg.json));
    assert.notEqual(lg.json.token, phoneToken);
    assert.equal(lg.json.device.via, 'passkey');

    const list = await call('GET', '/api/devices', undefined, lg.json.token);
    assert.deepEqual(list.json.devices.map((d: { name: string; current: boolean }) => [d.name, d.current]).sort(),
      [['Chrome במחשב', true], ['OnePlus 13', false]]);
    assert.equal(list.json.passkeys.length, 1);
    assert.equal(list.json.passkeys[0].name, 'OnePlus 13');
    assert.equal(env.hq.store.db.prepare('SELECT counter FROM passkeys').pluck().get(), 1);
  } finally { await env.cleanup(); }
});

test('auth: revoking a device stops its token now, closes its live stream, and leaves the others alone', async () => {
  const env = await authEnv();
  try {
    const { call } = env;
    const phone = new SoftAuthenticator();
    const a = (await env.register(phone, 'טלפון')).json;
    const b = (await env.login(phone, 'מחשב')).json;

    const events: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${env.hq.port}/ws`, [`token.${a.token}`]);
    ws.on('message', (m) => events.push(JSON.parse(String(m)).type));
    await until(() => events.includes('live'), 3000, 'ws live');
    const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));

    const rv = await call('POST', `/api/devices/${a.device.id}/revoke`, {}, b.token);
    assert.equal(rv.status, 200);
    assert.equal(await closed, 4401);
    assert.equal((await call('GET', '/api/board', undefined, a.token)).status, 401);
    const again = new WebSocket(`ws://127.0.0.1:${env.hq.port}/ws`, [`token.${a.token}`]);
    assert.equal(await new Promise((r) => { again.on('unexpected-response', (_q, res) => r(res.statusCode)); again.on('open', () => r('open')); }), 401);
    again.on('error', () => {});
    assert.equal((await call('GET', '/api/board', undefined, b.token)).status, 200);
    assert.equal((await call('POST', `/api/devices/${a.device.id}/revoke`, {})).status, 404, 'already revoked');
    assert.deepEqual((await call('GET', '/api/devices')).json.devices.map((d: { name: string }) => d.name), ['מחשב']);

    // A device can sign itself out.
    assert.equal((await call('POST', `/api/devices/${b.device.id}/revoke`, {}, b.token)).status, 200);
    assert.equal((await call('GET', '/api/board', undefined, b.token)).status, 401);
    assert.ok(env.hq.store.eventsAfter(0, 500).some((e) => e.type === 'device.revoked'));
  } finally { await env.cleanup(); }
});

test('auth: removing a passkey signs out its devices and it can no longer log in', async () => {
  const env = await authEnv();
  try {
    const { call } = env;
    const phone = new SoftAuthenticator(), other = new SoftAuthenticator();
    const a = (await env.register(phone, 'טלפון')).json;
    const b = (await env.login(phone, 'מחשב')).json;
    const c = (await env.register(other, 'טאבלט')).json;
    const rm = await call('POST', `/api/passkeys/${phone.id}/revoke`, {}, c.token);
    assert.equal(rm.status, 200);
    assert.deepEqual([...rm.json.devices].sort(), [a.device.id, b.device.id].sort());
    assert.equal((await call('GET', '/api/board', undefined, a.token)).status, 401);
    assert.equal((await call('GET', '/api/board', undefined, b.token)).status, 401);
    assert.equal((await call('GET', '/api/board', undefined, c.token)).status, 200);
    assert.equal((await env.login(phone, 'שוב')).status, 401);
    assert.equal((await env.login(other, 'שוב')).status, 200);
  } finally { await env.cleanup(); }
});

test('auth: forged and replayed assertions, wrong origin and unknown passkeys are refused', async () => {
  const env = await authEnv();
  try {
    const { call } = env;
    const phone = new SoftAuthenticator();
    await env.register(phone, 'טלפון');

    assert.equal((await env.login(phone, 'x', 'https://evil.example')).status, 401);
    assert.equal((await env.login(new SoftAuthenticator(), 'x')).status, 401, 'never registered');

    // Replay: the same signed response twice. The challenge is single use.
    const opts = (await call('POST', '/api/auth/login/options', {}, null)).json as { challenge: string };
    const cred = phone.get(opts);
    assert.equal((await call('POST', '/api/auth/login', { name: 'a', credential: cred }, null)).status, 200);
    assert.equal((await call('POST', '/api/auth/login', { name: 'b', credential: cred }, null)).status, 401);

    // Signature by a different key over a valid challenge.
    const opts2 = (await call('POST', '/api/auth/login/options', {}, null)).json as { challenge: string };
    const forged = new SoftAuthenticator().get(opts2);
    assert.equal((await call('POST', '/api/auth/login', { name: 'c', credential: { ...forged, id: phone.id, rawId: phone.id } }, null)).status, 401);

    // A registration challenge can't be used to log in, nor a made-up one.
    assert.equal((await call('POST', '/api/auth/login', { name: 'd', credential: phone.get({ challenge: b64u(randomBytes(32)) }) }, null)).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { name: 'e', credential: 'junk' }, null)).status, 400);

    // Registration from the wrong origin spends nothing but fails.
    const code = await env.pairCode();
    const ro = (await call('POST', '/api/auth/register/options', { code }, null)).json as { challenge: string };
    assert.equal((await call('POST', '/api/auth/register', { name: 'x', credential: new SoftAuthenticator().create(ro, 'https://evil.example') }, null)).status, 401);
    assert.equal((await env.register(new SoftAuthenticator(), 'טאבלט', code)).status, 200, 'the code still works once');
  } finally { await env.cleanup(); }
});

test('auth: pairing codes are single use, expire, and wrong guesses close redemption', async () => {
  const env = await authEnv();
  try {
    const { call } = env;
    // Plain pairing (no passkey on this device).
    const code = await env.pairCode();
    const p = await call('POST', '/api/auth/pair', { code, name: 'אמולטור' }, null);
    assert.equal(p.status, 200);
    assert.equal(p.json.device.via, 'pair');
    assert.equal((await call('GET', '/api/board', undefined, p.json.token)).status, 200);
    assert.equal((await call('POST', '/api/auth/pair', { code, name: 'שוב' }, null)).status, 401, 'single use');

    // A paired device can pair the next one.
    const code2 = await env.pairCode(p.json.token);
    env.clock.advance(10 * 60_000 + 1);
    assert.equal((await call('POST', '/api/auth/pair', { code: code2, name: 'מאוחר' }, null)).status, 401, 'expired');

    env.clock.advance(10 * 60_000 + 1); // earlier misses age out of the window
    const good = await env.pairCode();
    // Counted per client (Caddy's X-Forwarded-For, last entry): a guesser locks only itself.
    const guess = (code: string, from: string) => call('POST', '/api/auth/pair', { code, name: 'x' }, null, from);
    for (let i = 0; i < 20; i++) assert.equal((await guess('AAAA-AAAA', '1.2.3.4, 203.0.113.9')).status, 401);
    assert.equal((await guess(good, '203.0.113.9')).status, 429, 'locked even for a good code');
    assert.equal((await guess(good, '1.2.3.4')).status, 200, 'a spoofed first entry is not the client; others are not locked');
    env.clock.advance(10 * 60_000 + 1);
    assert.equal((await guess(await env.pairCode(), '203.0.113.9')).status, 200, 'opens again');

    // hq's own token still works (server-side tools), and the open routes don't open anything else.
    assert.equal((await call('GET', '/api/board')).status, 200);
    assert.equal((await call('GET', '/api/auth/login/options', undefined, null)).status, 404);
    assert.equal((await call('POST', '/api/auth/nope', {}, null)).status, 404);
  } finally { await env.cleanup(); }
});

test('auth: open challenges are capped in memory; the oldest go first', async () => {
  const env = await authEnv();
  try {
    const first = (await env.hq.auth.loginOptions()).challenge;
    for (let i = 0; i < 1000; i++) await env.hq.auth.loginOptions();
    const phone = new SoftAuthenticator();
    await env.register(phone, 'טלפון');
    const stale = await env.call('POST', '/api/auth/login', { name: 'x', credential: phone.get({ challenge: first }) }, null);
    assert.equal(stale.status, 401, 'dropped');
    assert.equal((await env.login(phone, 'y')).status, 200, 'fresh ones still work');
  } finally { await env.cleanup(); }
});
