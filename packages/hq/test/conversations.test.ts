import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MUTE_FOREVER } from '@company/shared';
import { makeEnv, until } from './helpers.ts';
import { Store } from '../src/store.ts';

const alerts = (env: Awaited<ReturnType<typeof makeEnv>>) =>
  env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'conv.alert').map((e) => e.data as { identity: string; message: string; title: string; body: string });

test('unread: counted per conversation, read on any device clears it, the total skips muted ones', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.tell({ msg_id: 'e1', from: 'eli', to: 'owner', body: 'העדכון עלה' });
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'e2', from: 'eli', to: 'owner', body: 'ועוד משהו' });
    hq.mailbox.tell({ msg_id: 'o1', from: 'owner', to: 'yoav', body: 'מה נשמע?' });
    clock.advance(1000);
    hq.mailbox.tell({ msg_id: 'r1', from: 'rotem', to: 'owner', body: 'הכול תקין' });
    hq.mailbox.tell({ msg_id: 's1', from: 'hq', to: 'owner', body: 'הודעת מערכת' });
    hq.mailbox.tell({ msg_id: 'x1', from: 'eli', to: 'rotem', body: 'בין עובדים' });

    const byId = Object.fromEntries(hq.conversations.list().map((c) => [c.identity, c]));
    assert.deepEqual(Object.keys(byId).sort(), ['eli', 'rotem', 'yoav'], 'hq is not a conversation');
    assert.equal(byId.eli!.unread, 2);
    assert.deepEqual(byId.eli!.recent.map((m) => m.body), ['העדכון עלה', 'ועוד משהו'], 'oldest first, for the notification');
    assert.equal(byId.rotem!.unread, 1);
    assert.equal(byId.yoav!.unread, 0, 'his own message is not unread');
    assert.equal(hq.conversations.list()[0]!.identity, 'rotem', 'newest first');
    assert.equal(hq.conversations.unreadTotal(), 3);

    clock.advance(1000);
    hq.conversations.markRead('eli');
    assert.equal(hq.conversations.get('eli').unread, 0);
    const read = hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'conv.read');
    assert.equal(read.length, 1, 'other devices hear it');
    assert.deepEqual(read[0]!.data, { identity: 'eli', read_at: clock.t, unread_total: 1 });
    hq.conversations.markRead('eli', clock.t - 5000);
    assert.equal(hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'conv.read').length, 1, 'never moves back, no event');

    hq.conversations.mute('rotem', 'week');
    assert.equal(hq.conversations.get('rotem').unread, 1, 'a muted conversation still shows its count');
    assert.equal(hq.conversations.unreadTotal(), 0, 'but the total skips it');
  } finally { await env.cleanup(); }
});

test('alerts: a worker message alerts with name and team; muted, on screen, focus and night do not', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.pusher.subscribe({ endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } });
    hq.mailbox.tell({ msg_id: 'e1', from: 'eli', to: 'owner', body: 'העדכון עלה' });
    await until(() => env.webPushes.length === 1, 2000, 'push');
    const a = alerts(env);
    assert.equal(a.length, 1);
    assert.equal(a[0]!.identity, 'eli');
    assert.match(a[0]!.title, /^אלי/);
    assert.equal(a[0]!.body, 'העדכון עלה');
    const payload = JSON.parse(env.webPushes[0]!.payload) as Record<string, string>;
    assert.equal(payload.kind, 'message');
    assert.equal(payload.url, '/?chat=eli', 'a tap opens the conversation');
    assert.equal(hq.conversations.get('eli').alert_at, clock.t);
    assert.equal(env.telegrams.length, 0, 'messages never go to Telegram');

    // Yoav answers while the conversation is open on his screen: no alert, still unread until the app reads it.
    hq.conversations.setScreen('device:phone', 'yoav');
    hq.mailbox.tell({ msg_id: 'y1', from: 'yoav', to: 'owner', body: 'כן, סגור' });
    assert.equal(alerts(env).length, 1);
    assert.equal(hq.conversations.get('yoav').unread, 1);
    // The screen went stale (the app was killed without saying so): alerts again.
    clock.advance(61_000);
    hq.mailbox.tell({ msg_id: 'y2', from: 'yoav', to: 'owner', body: 'עוד משהו' });
    assert.equal(alerts(env).length, 2);
    hq.conversations.setScreen('device:phone', 'yoav');
    hq.conversations.setScreen('device:phone', null);
    hq.mailbox.tell({ msg_id: 'y3', from: 'yoav', to: 'owner', body: 'ועוד' });
    assert.equal(alerts(env).length, 3, 'left the chat: alerts');

    hq.conversations.mute('eli', '8h');
    hq.mailbox.tell({ msg_id: 'e2', from: 'eli', to: 'owner', body: 'שקט' });
    assert.equal(alerts(env).length, 3, 'muted');
    clock.advance(8 * 3_600_000 + 1);
    assert.equal(hq.conversations.get('eli').muted_until, null, '8 hours are over');
    hq.mailbox.tell({ msg_id: 'e3', from: 'eli', to: 'owner', body: 'שוב' });
    assert.equal(alerts(env).length, 4);
    hq.conversations.mute('eli', 'always');
    assert.equal(hq.conversations.get('eli').muted_until, MUTE_FOREVER);
    hq.mailbox.tell({ msg_id: 'e4', from: 'eli', to: 'owner', body: 'תמיד שקט' });
    assert.equal(alerts(env).length, 4);
    hq.conversations.mute('eli', 'off');
    assert.equal(hq.conversations.get('eli').muted_until, null);

    hq.store.setToggle('focus', true);
    hq.mailbox.tell({ msg_id: 'r1', from: 'rotem', to: 'owner', body: 'בפוקוס' });
    hq.store.setToggle('focus', false);
    hq.store.setToggle('night', true);
    hq.mailbox.tell({ msg_id: 'r2', from: 'rotem', to: 'owner', body: 'בלילה' });
    hq.store.setToggle('night', false);
    assert.equal(alerts(env).length, 4, 'focus and night collect quietly');
    assert.equal(hq.conversations.get('rotem').unread, 2, 'but they count');

    hq.mailbox.tell({ msg_id: 'o1', from: 'owner', to: 'eli', body: 'תודה' });
    hq.mailbox.tell({ msg_id: 'h1', from: 'hq', to: 'owner', body: 'מערכת' });
    assert.equal(alerts(env).length, 4, 'his own messages and hq do not alert');
  } finally { await env.cleanup(); }
});

test('the inbox push is unchanged, and a message with no browser subscribed is not a failure', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    hq.mailbox.tell({ msg_id: 'e1', from: 'eli', to: 'owner', body: 'העדכון עלה' });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(env.webPushes.length, 0);
    assert.equal(hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'push.failed').length, 0);
    assert.equal(alerts(env).length, 1, 'the phone still hears it over its link');
  } finally { await env.cleanup(); }
});

test('API: conversations, read, mute, presence', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    env.hq.mailbox.tell({ msg_id: 'e1', from: 'eli', to: 'owner', body: 'שלום' });
    let r = await call('GET', '/api/conversations');
    assert.equal(r.status, 200);
    assert.equal(r.json.unread_total, 1);
    assert.equal(r.json.conversations[0].identity, 'eli');
    assert.equal(r.json.conversations[0].unread, 1);

    r = await call('POST', '/api/conversations/eli/mute', { for: 'week' });
    assert.equal(r.json.conversation.muted_until, env.clock.t + 7 * 86_400_000);
    assert.equal((await call('POST', '/api/conversations/eli/mute', { for: 'month' })).status, 400);
    assert.equal((await call('POST', '/api/conversations/eli/mute', {})).status, 400);
    assert.equal((await call('GET', '/api/conversations')).json.unread_total, 0);

    env.clock.advance(1000);
    r = await call('POST', '/api/conversations/eli/read');
    assert.equal(r.json.conversation.unread, 0);

    assert.equal((await call('PUT', '/api/presence', { identity: 'rotem', device: 'x' })).status, 200);
    env.hq.mailbox.tell({ msg_id: 'r1', from: 'rotem', to: 'owner', body: 'פתוח אצלך' });
    assert.equal(alerts(env).length, 1, 'only eli\'s first message');
    await call('PUT', '/api/presence', { identity: null, device: 'x' });
    env.hq.mailbox.tell({ msg_id: 'r2', from: 'rotem', to: 'owner', body: 'סגור אצלך' });
    assert.equal(alerts(env).length, 2);
  } finally { await env.cleanup(); }
});

test('migration: what was there before counts as read', () => {
  const s = new Store(':memory:');
  try {
    // Roll back to v10, put history in, migrate again.
    s.db.exec('DROP TABLE conversations');
    s.db.exec('ALTER TABLE tasks DROP COLUMN summary'); // v12, so the replay from v10 adds it again
    // v13 too (awaiting.ts)
    s.db.exec('DROP INDEX tasks_awaiting; DROP TABLE deploys');
    for (const c of ['awaiting', 'awaiting_note', 'awaiting_at', 'pr']) s.db.exec(`ALTER TABLE tasks DROP COLUMN ${c}`);
    s.db.exec('DROP TABLE home_recipes'); // v14
    s.db.exec('DROP TABLE memory_file_ops'); // v15
    s.db.exec('ALTER TABLE messages DROP COLUMN waiting_on'); // v17
    s.db.exec('ALTER TABLE shifts DROP COLUMN bg_tasks'); // v18
    s.db.exec('ALTER TABLE tasks DROP COLUMN machine'); // v20
    s.db.pragma('user_version = 10');
    s.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, body, created_at) VALUES ('a', 'eli', 'owner', 'ישן', 100), ('b', 'eli', 'owner', 'ישן יותר', 50)`).run();
    (s as unknown as { migrate(): void }).migrate();
    const row = s.db.prepare('SELECT * FROM conversations WHERE identity = ?').get('eli') as { read_at: number };
    assert.equal(row.read_at, 100);
  } finally { s.close(); }
});

test('seen: when he last left the chats screen, one value for every device, only forward', async () => {
  const env = await makeEnv();
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    assert.deepEqual((await call('GET', '/api/seen')).json.seen, { chats: null }, 'never yet');
    const t0 = env.clock.t;
    let r = await call('PUT', '/api/seen/chats', {});
    assert.equal(r.json.at, t0, 'hq\'s clock by default');
    r = await call('PUT', '/api/seen/chats', { at: t0 + 60_000 });
    assert.equal(r.json.at, t0, 'not in the future');
    env.clock.advance(5000);
    r = await call('PUT', '/api/seen/chats', { at: t0 + 3000 });
    assert.equal(r.json.at, t0 + 3000);
    r = await call('PUT', '/api/seen/chats', { at: t0 + 1000 });
    assert.equal(r.json.at, t0 + 3000, 'never moves back');
    assert.equal((await call('GET', '/api/seen')).json.seen.chats, t0 + 3000);
    assert.equal((await call('PUT', '/api/seen/status', {})).status, 400);
    const events = env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'seen.changed').map((e) => (e.data as { at: number }).at);
    assert.deepEqual(events, [t0, t0 + 3000], 'other devices hear of it');
  } finally { await env.cleanup(); }
});
