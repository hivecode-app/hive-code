import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { makeEnv, until } from './helpers.ts';
import { FcmError, fcmSender, type FcmMessage } from '../src/fcm.ts';

// task 1474: FCM is the Android app's push. Alerts at high priority, a quiet sync on every change, and Telegram when
// the phone leaves a push unacked.

const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));
const phone = (env: Awaited<ReturnType<typeof makeEnv>>) => env.hq.store.db.prepare(`INSERT INTO devices (id, name, token_hash, via, created_at)
  VALUES ('phone', 'טלפון', 'x', 'pair', ?)`).run(env.hq.store.now());

async function fcmEnv(fail?: (token: string) => Error | null) {
  const sent: { token: string; msg: FcmMessage }[] = [];
  const env = await makeEnv({ deps: { fcm: async (token, msg) => {
    const e = fail?.(token);
    if (e) throw e;
    sent.push({ token, msg });
  } } });
  return { env, sent };
}

test('fcm: an inbox item and a worker\'s message go high; another change goes as one quiet sync', async () => {
  const { env, sent } = await fcmEnv();
  try {
    const { hq } = env;
    phone(env);
    hq.pusher.registerFcm('phone', 'tok-1');
    hq.inbox.add({ kind: 'go', from_identity: 'adi', title: 'GO ל-hq', blocking: true });
    await until(() => sent.some((s) => s.msg.data.type === 'inbox'), 2000, 'inbox push');
    const go = sent.find((s) => s.msg.data.type === 'inbox')!;
    assert.equal(go.token, 'tok-1');
    assert.equal(go.msg.priority, 'high');
    assert.ok(Object.values(go.msg.data).every((v) => typeof v === 'string'), 'FCM data is strings only');

    hq.mailbox.tell({ msg_id: 'm1', from: 'eli', to: 'owner', body: 'השרת נפל', priority: 'now' });
    await until(() => sent.some((s) => s.msg.data.type === 'message'), 2000, 'message push');
    const m = sent.find((s) => s.msg.data.type === 'message')!;
    assert.equal(m.msg.priority, 'high');
    assert.equal(m.msg.data.identity, 'eli');

    // A burst of changes is one sync, at normal priority, collapsed.
    await until(() => sent.some((s) => s.msg.data.type === 'sync'), 3000, 'sync');
    const before = sent.filter((s) => s.msg.data.type === 'sync').length;
    hq.conversations.markRead('eli');
    hq.store.setToggle('focus', false, true);
    hq.store.setToggle('focus', true, true);
    await settle(1300);
    const syncs = sent.filter((s) => s.msg.data.type === 'sync');
    assert.equal(syncs.length, before + 1, 'one sync for the burst');
    assert.equal(syncs.at(-1)!.msg.priority, 'normal');
    assert.equal(syncs.at(-1)!.msg.collapseKey, 'sync');
  } finally { await env.cleanup(); }
});

test('fcm: no token, no key → nothing is sent and nothing breaks', async () => {
  const env = await makeEnv({ deps: { fcm: null } });
  try {
    env.hq.pusher.registerFcm('phone', 'tok-1');
    env.hq.inbox.add({ kind: 'go', from_identity: 'adi', title: 'GO', blocking: true });
    await settle(1200);
    assert.equal(env.hq.pusher.fcmReachable(), false);
  } finally { await env.cleanup(); }
});

test('fcm: an acked phone holds Telegram back; a push it leaves unacked lets Telegram go', async () => {
  const { env, sent } = await fcmEnv();
  try {
    const { hq, clock } = env;
    phone(env);
    hq.pusher.registerFcm('phone', 'tok-1');
    assert.equal(hq.pusher.fcmReachable(), false, 'never acked: not proven');
    hq.pusher.ackFcm('phone');
    assert.equal(hq.pusher.fcmReachable(), true);

    // The app is gone (no link, not seen), but FCM reaches it and it acks: no Telegram.
    clock.advance(60 * 60_000);
    hq.mailbox.tell({ msg_id: 'm1', from: 'eli', to: 'owner', body: 'השרת נפל', priority: 'now' });
    await until(() => sent.some((s) => s.msg.data.type === 'message'), 2000, 'message push');
    hq.pusher.ackFcm('phone');
    clock.advance(5 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 0, 'acked: the phone showed it');

    // The next one is never acked: after fcmAckMs Telegram goes.
    hq.conversations.markRead('eli');
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'm2', from: 'eli', to: 'owner', body: 'שוב נפל', priority: 'now' });
    await until(() => sent.filter((s) => s.msg.data.type === 'message').length === 2, 2000, 'second push');
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 0, 'within fcmAckMs: wait for the ack');
    clock.advance(env.cfg.timers.fcmAckMs + 1000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 1, 'unacked: Telegram');
    assert.match(env.telegrams[0]!, /שוב נפל/);
  } finally { await env.cleanup(); }
});

test('fcm: a phone that acked once, when FCM sends fail (revoked key, FCM down), lets Telegram go', async () => {
  let broken = false;
  let tries = 0;
  const { env } = await fcmEnv(() => { tries++; return broken ? new FcmError('fcm auth: 401 invalid_grant', 401, false) : null; });
  try {
    const { hq, clock } = env;
    phone(env);
    hq.pusher.registerFcm('phone', 'tok-1');
    hq.pusher.ackFcm('phone');
    broken = true;
    clock.advance(60 * 60_000);
    hq.mailbox.tell({ msg_id: 'm1', from: 'eli', to: 'owner', body: 'השרת נפל', priority: 'now' });
    await until(() => tries > 0, 2000, 'tried');
    await settle();
    clock.advance(env.cfg.timers.fcmAckMs + 1000);
    assert.equal(hq.pusher.fcmReachable(), false, 'a failed high send is owed an ack like a sent one');
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 1, 'FCM could not send: Telegram');
  } finally { await env.cleanup(); }
});

test('fcm: an unregistered token is dropped; a revoked device loses its token', async () => {
  const { env, sent } = await fcmEnv((t) => t === 'gone' ? new FcmError('fcm 404: UNREGISTERED', 404, true) : null);
  try {
    const { hq } = env;
    phone(env);
    hq.pusher.registerFcm('phone', 'gone');
    hq.inbox.add({ kind: 'go', from_identity: 'adi', title: 'GO', blocking: true });
    await until(() => hq.store.db.prepare('SELECT COUNT(*) n FROM fcm_tokens').pluck().get() === 0, 2000, 'dropped');
    assert.equal(sent.length, 0);

    hq.pusher.registerFcm('phone', 'tok-2');
    // The same token from another device row is that device's now.
    hq.pusher.registerFcm('tablet', 'tok-2');
    assert.deepEqual(hq.store.db.prepare('SELECT device FROM fcm_tokens').pluck().all(), ['tablet']);
    hq.pusher.registerFcm('phone', 'tok-3');
    hq.auth.revokeDevice('phone');
    assert.deepEqual(hq.store.db.prepare('SELECT device FROM fcm_tokens').pluck().all(), ['tablet'], 'revoked: its token is gone');
  } finally { await env.cleanup(); }
});

test('fcm sender: signs a JWT, caches the access token, sends the v1 message, flags UNREGISTERED', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const calls: { url: string; init: RequestInit }[] = [];
  let status = 200;
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at', expires_in: 3600 }), { status: 200 });
    return new Response(status === 200 ? '{}' : '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status });
  }) as unknown as typeof fetch;
  const send = fcmSender({ project_id: 'p1', client_email: 'sa@p1.iam.gserviceaccount.com', private_key: pem }, fetchFn);

  await send('tok', { data: { type: 'sync' }, priority: 'normal', collapseKey: 'sync' });
  await send('tok', { data: { type: 'inbox' }, priority: 'high' });
  assert.equal(calls.filter((c) => c.url.includes('oauth2')).length, 1, 'access token cached');
  const assertion = new URLSearchParams(calls[0]!.init.body as URLSearchParams).get('assertion')!;
  const [h, c, sig] = assertion.split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url')), 'RS256 signature');
  assert.equal(JSON.parse(Buffer.from(c!, 'base64url').toString()).scope, 'https://www.googleapis.com/auth/firebase.messaging');

  const msg = calls[1]!;
  assert.equal(msg.url, 'https://fcm.googleapis.com/v1/projects/p1/messages:send');
  assert.equal((msg.init.headers as Record<string, string>).authorization, 'Bearer at');
  assert.deepEqual(JSON.parse(msg.init.body as string), { message: { token: 'tok', data: { type: 'sync' }, android: { priority: 'NORMAL', ttl: '3600s', collapse_key: 'sync' } } });
  assert.equal(JSON.parse(calls[2]!.init.body as string).message.android.priority, 'HIGH');

  status = 404;
  await assert.rejects(send('tok', { data: {}, priority: 'high' }), (e: unknown) => e instanceof FcmError && e.unregistered && e.status === 404);
});
