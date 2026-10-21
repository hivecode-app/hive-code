import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';

// #204: Telegram only when the app can't reach him, once per thing, and never a flood.

const settle = () => new Promise((r) => setTimeout(r, 50));
const phone = (env: Awaited<ReturnType<typeof makeEnv>>) => env.hq.store.db.prepare(`INSERT INTO devices (id, name, token_hash, via, created_at)
  VALUES ('phone', 'טלפון', 'x', 'pair', ?)`).run(env.hq.store.now());

test('telegram: app connected → nothing; not connected → once; the same item twice → once', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    phone(env);
    // Connected (a live link): a GO stays in the app.
    hq.auth.link('phone', 1);
    const go = hq.inbox.add({ kind: 'go', from_identity: 'adi', title: 'GO ל-hq', blocking: true });
    await until(() => hq.inbox.get(go.id)!.pushed_at != null, 2000, 'notify ran');
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 0, 'app connected: no Telegram');

    // The link closes: still "seen lately" for 10 minutes, then the app counts as not connected.
    hq.auth.link('phone', -1);
    clock.advance(5 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 0, 'seen 5 minutes ago');
    clock.advance(6 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 1, 'not connected: once');
    assert.match(env.telegrams[0]!, /GO ל-hq[\s\S]*האפליקציה לא מחוברת/);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 1);

    // The same item asked for twice (dedupe_key): one item, one Telegram.
    hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ל-Cloudflare', blocking: true, dedupe_key: 'login-cf' });
    hq.inbox.add({ kind: 'login', from_identity: 'eli', title: 'כניסה ל-Cloudflare', blocking: true, dedupe_key: 'login-cf' });
    await until(() => env.telegrams.length === 2, 2000, 'login telegram');
    await hq.pusher.sweepUnacked();
    await settle();
    assert.equal(env.telegrams.length, 2, 'the same item twice: once');
  } finally { await env.cleanup(); }
});

test('telegram: a blocking ask and a non-blocking item never go, even with the app gone', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.ask({ msg_id: 'a1', from: 'eli', question: 'למזג?', blocking: true });
    hq.inbox.add({ kind: 'delivery_failure', title: 'לא נמסרה' });
    hq.mailbox.tell({ msg_id: 'n1', from: 'eli', to: 'owner', body: 'עדכון רגיל' }); // `next`, not `now`
    clock.advance(60 * 60_000);
    await hq.pusher.sweepUnacked();
    await settle();
    assert.equal(env.telegrams.length, 0);
  } finally { await env.cleanup(); }
});

test('telegram: a worker\'s `now` message goes when the app is not connected, one per conversation until he reads it', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    phone(env);
    hq.mailbox.tell({ msg_id: 'm1', from: 'eli', to: 'owner', body: 'השרת נפל', priority: 'now' });
    await until(() => env.telegrams.length === 1, 2000, 'message telegram');
    assert.match(env.telegrams[0]!, /השרת נפל/);
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'm2', from: 'eli', to: 'owner', body: 'ועוד אחת', priority: 'now' });
    await settle();
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 1, 'unread since the last one: no second Telegram');

    // He reads it; the next `now` may go again.
    clock.advance(1000);
    hq.conversations.markRead('eli');
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'm3', from: 'eli', to: 'owner', body: 'שוב', priority: 'now' });
    await until(() => env.telegrams.length === 2, 2000, 'after reading');

    // A live link: the app showed it, no Telegram even after the app goes away.
    hq.conversations.markRead('eli');
    hq.auth.link('phone', 1);
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'm4', from: 'eli', to: 'owner', body: 'באפליקציה', priority: 'now' });
    await settle();
    hq.auth.link('phone', -1);
    clock.advance(11 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 2, 'came over a live link');

    // No live link but seen lately: owed, sent once the app counts as gone ...
    clock.advance(1000);
    hq.conversations.markRead('eli');
    hq.auth.link('phone', 1);
    hq.auth.link('phone', -1);
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'm5', from: 'eli', to: 'owner', body: 'אחרי שיצא', priority: 'now' });
    await settle();
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 2, 'seen a moment ago');
    clock.advance(11 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 3);
    assert.match(env.telegrams[2]!, /אחרי שיצא/);

    // ... unless he read it before that.
    hq.conversations.markRead('eli');
    hq.auth.link('phone', 1);
    hq.auth.link('phone', -1);
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'm6', from: 'eli', to: 'owner', body: 'נקרא', priority: 'now' });
    await settle();
    clock.advance(1000);
    hq.conversations.markRead('eli');
    clock.advance(11 * 60_000);
    await hq.pusher.sweepUnacked();
    assert.equal(env.telegrams.length, 3, 'read in time');
  } finally { await env.cleanup(); }
});

test('telegram: a slow send is not sent twice by a sweep or by a burst of messages', async () => {
  let release!: () => void;
  const sent: string[] = [];
  const env = await makeEnv({ deps: { telegram: (t) => { sent.push(t); return new Promise<void>((r) => { release = r; }); } } });
  try {
    const { hq, clock } = env;
    hq.inbox.add({ kind: 'go', from_identity: 'adi', title: 'GO איטי', blocking: true });
    await until(() => sent.length === 1, 2000, 'first send started');
    const sweep = hq.pusher.sweepUnacked(); // runs while the send is still in flight
    await settle();
    release(); await sweep; await settle();
    assert.equal(sent.length, 1, 'the item once');

    hq.mailbox.tell({ msg_id: 'b1', from: 'eli', to: 'owner', body: 'אחת', priority: 'now' });
    await until(() => sent.length === 2, 2000, 'message send started');
    clock.advance(1);
    hq.mailbox.tell({ msg_id: 'b2', from: 'eli', to: 'owner', body: 'שתיים', priority: 'now' });
    hq.mailbox.tell({ msg_id: 'b3', from: 'eli', to: 'owner', body: 'שלוש', priority: 'now' });
    const sweep2 = hq.pusher.sweepUnacked();
    await settle();
    release(); await sweep2; await settle();
    assert.equal(sent.length, 2, 'a burst: one');
  } finally { release?.(); await env.cleanup(); }
});
