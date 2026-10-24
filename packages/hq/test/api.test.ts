import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';
import { ORG_YAML, makeEnv, until } from './helpers.ts';
import { wsPing } from '../src/api.ts';

async function apiEnv() {
  const env = await makeEnv({ noStart: true });
  await env.hq.start({ listen: true, timers: false });
  const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
  const base = `http://127.0.0.1:${env.hq.port}`;
  const call = async (method: string, path: string, body?: unknown, auth = true) => {
    const res = await fetch(base + path, {
      method, headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  return { ...env, token, base, call };
}

test('API: token auth, health open, token file is 0600', async () => {
  const env = await apiEnv();
  try {
    assert.equal(statSync(join(env.cfg.stateDir, 'api-token')).mode & 0o777, 0o600);
    assert.equal(statSync(join(env.cfg.stateDir, 'vapid.json')).mode & 0o777, 0o600);
    assert.equal(statSync(env.cfg.dbPath).mode & 0o777, 0o600);
    assert.equal((await env.call('GET', '/api/inbox', undefined, false)).status, 401);
    assert.equal((await fetch(`${env.base}/api/inbox?token=wrong`)).status, 401);
    assert.equal((await env.call('GET', '/health', undefined, false)).status, 503, 'no sweep yet');
    await env.hq.scheduler.sweep();
    const h = await env.call('GET', '/health', undefined, false);
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(typeof h.json.live_shifts, 'number');
    env.clock.advance(10 * 60_000);
    assert.equal((await env.call('GET', '/health', undefined, false)).status, 503, 'stale sweep = unhealthy (heartbeat alerts)');
  } finally { await env.cleanup(); }
});

test('API: org/board with derived status, tell, asks/answer, toggles, tasks, inbox done', async () => {
  const env = await apiEnv();
  try {
    const { call, hq } = env;
    const org = await call('GET', '/api/org');
    assert.equal(org.status, 200);
    const ids = org.json.identities.map((i: { id: string }) => i.id);
    assert.deepEqual(ids.sort(), ['ac-ceo', 'amit', 'eli', 'rotem', 'yoav']);
    assert.equal(org.json.identities.find((i: { id: string }) => i.id === 'eli').status, 'resting');

    const t = await call('POST', '/api/messages/tell', { msg_id: 'api-1', to: 'eli', body: 'שלום' });
    assert.equal(t.status, 200);
    await until(() => hq.mailbox.get('api-1')!.state === 'delivered');
    assert.equal((await call('POST', '/api/messages/tell', { msg_id: 'api-1', to: 'eli', body: 'שלום' })).json.message.state, 'delivered', 'idempotent');
    assert.equal((await call('POST', '/api/messages/tell', { to: 'eli' })).status, 400);
    assert.equal((await call('POST', '/api/messages/tell', { to: 'eli', body: 'x', urgency: 'nope' })).status, 400);
    const msgs = await call('GET', '/api/messages?identity=eli');
    assert.equal(msgs.json.messages[0].id, 'api-1');

    const ask = await call('POST', '/api/asks', { msg_id: 'ask-api', from: 'eli', question: 'GO?', blocking: true });
    assert.equal(ask.json.ask.state, 'open');
    const board = await call('GET', '/api/board');
    assert.equal(board.json.identities.find((i: { id: string }) => i.id === 'eli').status, 'waiting_for_you');
    assert.equal(board.json.identities.find((i: { id: string }) => i.id === 'eli').status_symbol, 'front_hand');
    assert.equal(board.json.manager, 'yoav', 'the app pins the manager from hq (org.yaml `manager`), not a name in its code');
    const ans = await call('POST', '/api/asks/ask-api/answer', { answer: 'כן' });
    assert.equal(ans.json.ask.state, 'answered');
    assert.equal((await call('POST', '/api/asks/nope/answer', { answer: 'x' })).status, 404);

    // Words typed on an open GO in the conversation: the item closes with them, the worker gets them.
    const go = await call('POST', '/api/inbox', { kind: 'go', from: 'eli', title: 'GO: פריסה', headline: 'עדכון לאפליקציה', body: 'פריסה' });
    assert.equal(go.json.item.headline, 'עדכון לאפליקציה');
    const wrote = await call('POST', `/api/inbox/${go.json.item.id}/answer`, { answer: 'לא, בלי הבוטים' });
    assert.equal(wrote.status, 200);
    assert.equal(wrote.json.item.state, 'resolved');
    assert.equal(wrote.json.message.to_identity, 'eli');
    assert.match(wrote.json.message.body, /לא, בלי הבוטים/);
    assert.equal((await call('POST', `/api/inbox/${go.json.item.id}/answer`, { answer: 'שוב' })).status, 409, 'already handled');
    assert.equal((await call('POST', '/api/inbox/99999/answer', { answer: 'x' })).status, 404);
    assert.equal((await call('POST', `/api/inbox/${go.json.item.id}/answer`, {})).status, 400);

    const login = await call('POST', '/api/inbox', { kind: 'login', from: 'eli', title: 'כניסה ל-Cloudflare', ref: 'tab-1', msg_id: 'tab-1' });
    const again = await call('POST', '/api/inbox', { kind: 'login', from: 'eli', title: 'כניסה ל-Cloudflare', ref: 'tab-1', msg_id: 'tab-1' });
    assert.equal(again.json.item.id, login.json.item.id, 'idempotent');
    const done = await call('POST', `/api/inbox/${login.json.item.id}/done`, { note: 'נכנסתי' });
    assert.equal(done.json.item.state, 'resolved');
    assert.equal(done.json.message.priority, 'now');

    const tog = await call('PUT', '/api/toggles/rotem%2Fprod-probes', { enabled: false });
    assert.equal(tog.json.toggles.find((x: { key: string }) => x.key === 'rotem/prod-probes').enabled, false);
    assert.equal(tog.json.toggles.find((x: { key: string }) => x.key === 'rotem/prod-probes').manual, true, '"כובה ידנית"');
    assert.equal((await call('PUT', '/api/toggles/nope', { enabled: false })).status, 404);

    hq.store.setToggle('scheduler', false);
    const task = await call('POST', '/api/tasks', { title: 'טיקט', project: 'agent-company', ref: 'agent-company#1' });
    assert.equal(task.json.task.state, 'queued');
    assert.equal((await call('GET', '/api/tasks')).json.queue[0].id, task.json.task.id);
    const tid = task.json.task.id;
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { priority: 0 })).json.task.priority, 0);
    assert.equal(hq.scheduler.task(tid)!.priority, 0);
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { priority: 7 })).status, 400);
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { priority: '1' })).status, 400);
    assert.equal((await call('PATCH', '/api/tasks/99999', { priority: 1 })).status, 404);
    // task-235: mark remote-ok (and take it back) without the DB; labels hq writes itself are not touched.
    hq.store.db.prepare('UPDATE tasks SET labels = ? WHERE id = ?').run(JSON.stringify(['opened-by:adi']), tid);
    const lab = await call('PATCH', `/api/tasks/${tid}`, { labels: ['remote-ok'] });
    assert.deepEqual(JSON.parse(lab.json.task.labels), ['opened-by:adi', 'remote-ok']);
    assert.equal(lab.json.task.priority, 0, 'priority untouched');
    assert.deepEqual(JSON.parse((await call('PATCH', `/api/tasks/${tid}`, { labels: ['remote-ok'], priority: 1 })).json.task.labels), ['opened-by:adi', 'remote-ok']);
    assert.equal(hq.scheduler.task(tid)!.priority, 1);
    assert.deepEqual(JSON.parse((await call('PATCH', `/api/tasks/${tid}`, { remove_labels: ['remote-ok'] })).json.task.labels), ['opened-by:adi']);
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { remove_labels: ['opened-by:adi'] })).status, 400);
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { labels: ['repo:x'] })).status, 400);
    assert.deepEqual(JSON.parse((await call('PATCH', `/api/tasks/${tid}`, { labels: ['company:night'] })).json.task.labels), ['opened-by:adi', 'company:night']);
    await call('PATCH', `/api/tasks/${tid}`, { remove_labels: ['company:night'] });
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { labels: 'remote-ok' })).status, 400);
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, {})).status, 400);
    assert.equal((await call('PATCH', `/api/tasks/${tid}`, { labels: [] })).status, 400);
    assert.equal((await call('PATCH', '/api/tasks/99999', { labels: ['remote-ok'] })).status, 404);

    const st = await call('POST', '/api/shifts/start', { identity: 'rotem' });
    assert.equal(st.json.shift.identity, 'rotem');
    assert.equal((await call('POST', '/api/shifts/start', { identity: 'ghost' })).status, 404);
    await until(() => hq.shifts.get('rotem-1')?.state === 'live');
    const stop = await call('POST', '/api/shifts/rotem-1/stop', {});
    assert.equal(stop.json.shift.state, 'ended');
    assert.equal(stop.json.shift.end_reason, 'owner_stop');
    assert.equal((await call('GET', '/api/push/vapid')).json.publicKey.length > 20, true);
  } finally { await env.cleanup(); }
});

test('WS: says ping when nothing else happens, so a client can tell a dead link from a quiet one', async () => {
  const env = await apiEnv();
  const was = wsPing.ms;
  wsPing.ms = 50;
  try {
    const { hq, token } = env;
    const got: { type: string; seq: number }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${hq.port}/ws`, [`token.${token}`]);
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await until(() => got.filter((e) => e.type === 'ping').length >= 2, 20_000, 'pings');
    assert.ok(got.filter((e) => e.type === 'ping').every((e) => e.seq === 0), 'not an event: no seq to resume from');
    ws.close();
  } finally { wsPing.ms = was; await env.cleanup(); }
});

test('WS: replays after seq, then streams live; rejects bad token', async () => {
  const env = await apiEnv();
  try {
    const { hq, token } = env;
    const seq0 = hq.store.eventsAfter(0, 10_000).at(-1)!.seq;
    hq.mailbox.ask({ msg_id: 'ask-ws', from: 'eli', question: 'לפני החיבור' });
    const got: { type: string; seq: number }[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${hq.port}/ws?after=${seq0}`, [`token.${token}`]);
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    await until(() => got.some((e) => e.type === 'live'), 3000, 'live marker');
    assert.ok(got.some((e) => e.type === 'ask.new'), 'replayed');
    assert.ok(got.every((e) => e.type === 'live' || e.seq > seq0));
    hq.store.setToggle('focus', true);
    await until(() => got.some((e) => e.type === 'toggle.changed'), 3000, 'live event');
    const seqs = got.filter((e) => e.type !== 'live').map((e) => e.seq);
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'ordered, no duplicates');
    assert.equal(new Set(seqs).size, seqs.length);
    ws.close();

    const bad = new WebSocket(`ws://127.0.0.1:${hq.port}/ws?token=nope`);
    const err = await new Promise<string>((r) => { bad.on('error', (e) => r(e.message)); bad.on('open', () => r('opened')); });
    assert.match(err, /401/);
  } finally { await env.cleanup(); }
});

test('hq restart: reattaches to live shift-hosts and replays only what it missed', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, cfg, clock } = env;
    hq.mailbox.tell({ msg_id: 'r-1', to: 'eli', body: 'לפני restart' });
    await until(() => hq.mailbox.get('r-1')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    await hq.stop();

    // While hq is down the shift keeps working (separate unit).
    host.event({ kind: 'text', text: 'עבדתי בזמן ש-hq למטה' });
    host.deliveryState('r-1', 'started');
    const { Hq } = await import('../src/hq.ts');
    const hq2 = new Hq(cfg, { launcher, now: clock.now, telegram: async () => {}, webPush: async () => {} });
    env.hq = hq2 as typeof env.hq;
    await hq2.start({ listen: false, timers: false });
    await until(() => hq2.mailbox.get('r-1')!.state === 'seen', 3000, 'missed event folded after restart');
    assert.equal(launcher.launches.length, 1, 'no new shift: same host');
    const hello = host.received.filter((f) => f.t === 'hello');
    assert.equal(hello.length, 2);
    assert.ok((hello[1] as { since: number }).since >= 1, 'resumes from persisted seq');
    assert.equal(hq2.board().find((b) => b.id === 'eli')!.live, true);
  } finally { await env.cleanup(); }
});

test('boot/systemd restart while hq was down: replayed exited → starting keeps the run live (no relaunch)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, cfg, clock } = env;
    hq.mailbox.tell({ msg_id: 'b-1', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('b-1')!.state === 'delivered');
    await hq.stop();
    await launcher.restartBySystemd('eli-1');
    const { Hq } = await import('../src/hq.ts');
    const hq2 = new Hq(cfg, { launcher, now: clock.now, telegram: async () => {}, webPush: async () => {} });
    env.hq = hq2 as typeof env.hq;
    await hq2.start({ listen: false, timers: false });
    await until(() => hq2.shifts.connection('eli-1')?.isLive === true, 3000, 'reattached');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hq2.shifts.get('eli-1')!.state, 'live', 'old exited is history');
    assert.equal(launcher.launches.length, 1);
  } finally { await env.cleanup(); }
});

test('boot restart that hq misses at reattach: restoreLost resumes, every older exited is ignored', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, cfg, clock } = env;
    hq.mailbox.tell({ msg_id: 'b-2', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('b-2')!.state === 'delivered');
    await hq.stop();
    await launcher.restartBySystemd('eli-1', { listen: false }); // still booting when hq comes up
    const { Hq } = await import('../src/hq.ts');
    const hq2 = new Hq(cfg, { launcher, now: clock.now, telegram: async () => {}, webPush: async () => {} });
    env.hq = hq2 as typeof env.hq;
    hq2.watchdog.procCheck = () => null;
    clock.advance(1000);
    await hq2.start({ listen: false, timers: false });
    await until(() => launcher.launches.length === 2, 3000, 'resumed by restoreLost');
    await until(() => hq2.shifts.connection('eli-1')?.isLive === true, 3000, 'attached to the new run');
    await new Promise((r) => setTimeout(r, 50));
    const log = launcher.disks.get('eli-1')!.log.filter((f) => f.t === 'lifecycle').map((f) => (f as { state: string }).state);
    assert.deepEqual(log, ['starting', 'exited', 'starting', 'exited', 'starting']);
    assert.equal(hq2.shifts.get('eli-1')!.state, 'live');
  } finally { await env.cleanup(); }
});

test('API: "לא עכשיו" and closing a card are kept by hq, so a refresh does not bring the card back (#74)', async () => {
  const env = await apiEnv();
  try {
    const { call, hq } = env;
    hq.mailbox.ask({ msg_id: 'ask-74', from: 'eli', headline: 'הבוטים', question: 'להעביר גם את הבוטים?', blocking: true });
    hq.mailbox.ask({ msg_id: 'ask-74b', from: 'eli', question: 'עוד שאלה', blocking: true });
    const go = await call('POST', '/api/inbox', { kind: 'go', from: 'eli', title: 'GO: פריסה', body: 'פריסה' });
    const items = () => call('GET', '/api/inbox').then((r) => r.json.items as Record<string, any>[]);
    const ask = (await items()).find((i) => i.ref === 'ask-74')!;

    // לא עכשיו: still open, marked and last, on a fresh read from the server; Telegram doesn't chase it.
    const s = await call('POST', `/api/inbox/${ask.id}/snooze`, {});
    assert.equal(s.status, 200);
    let now = await items();
    assert.ok(now.find((i) => i.id === ask.id)!.snoozed_at, 'kept on the server');
    assert.equal(now.at(-1)!.id, ask.id, 'below the rest');
    assert.ok(now.find((i) => i.id === ask.id)!.acked_at);
    // ביטול: back with the others.
    await call('POST', `/api/inbox/${ask.id}/snooze`, { on: false });
    now = await items();
    assert.equal(now.find((i) => i.id === ask.id)!.snoozed_at, null);
    assert.notEqual(now.at(-1)!.id, ask.id);
    await call('POST', `/api/inbox/${go.json.item.id}/snooze`, {});
    assert.ok((await items()).find((i) => i.id === go.json.item.id)!.snoozed_at);

    // Closing: gone from the inbox for good, the question cancelled, the asker told which one.
    // Only the app's device token is him (#208).
    const code = (await call('POST', '/api/devices/pair', {})).json.code;
    const paired = await fetch(`${env.base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'טלפון' }) });
    const device = ((await paired.json()) as { token: string }).token;
    const dismissed = await fetch(`${env.base}/api/inbox/${ask.id}/dismiss`, { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(dismissed.status, 200);
    assert.ok(!(await items()).some((i) => i.id === ask.id), 'does not come back');
    assert.equal(hq.inbox.get(ask.id)!.state, 'dismissed');
    assert.equal(hq.mailbox.getAsk('ask-74')!.state, 'cancelled');
    const told = hq.mailbox.list('eli').find((m) => m.id === `inbox-${ask.id}-declined`)!;
    assert.equal(told.priority, 'now');
    assert.equal(told.ref, 'ask-74');
    assert.match(told.body, /^רן סגר את השאלה בלי תשובה: הבוטים/);

    assert.equal((await call('POST', `/api/inbox/${ask.id}/snooze`, {})).status, 409, 'already handled');
    assert.equal((await call('POST', '/api/inbox/99999/snooze', {})).status, 404);
  } finally { await env.cleanup(); }
});

test('API: a project team in /api/org carries the owner\'s name for the project (org.yaml projects[].name)', async () => {
  const env = await makeEnv({ org: `${ORG_YAML}projects:\n  - {id: agent-company, name: החברה, status: active, team: agent-company}\n` });
  try {
    const teams = env.hq.teams();
    assert.equal(teams.find((t) => t.id === 'agent-company')?.name, 'החברה');
    assert.equal(teams.find((t) => t.id === 'personal')?.name, null, 'a permanent team: no project name');
  } finally { await env.cleanup(); }
});

test('API: the app\'s device token on the three routes the "החלטות" tab sends is him: a message from owner (#208)', async () => {
  const env = await apiEnv();
  try {
    const { call, hq } = env;
    const code = (await call('POST', '/api/devices/pair', {})).json.code;
    const paired = await fetch(`${env.base}/api/auth/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name: 'טלפון' }) });
    const device = ((await paired.json()) as { token: string }).token;
    const app = async (path: string, body: unknown) => {
      const res = await fetch(env.base + path, { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };

    // 1. A GO: the app sends done with {note:'GO'}. The worker is told "רן סיים", from him.
    const go = await call('POST', '/api/inbox', { kind: 'go', from: 'eli', title: 'GO: פריסה', body: 'פריסה' });
    const done = await app(`/api/inbox/${go.json.item.id}/done`, { note: 'GO' });
    assert.equal(done.status, 200);
    assert.equal(done.json.item.state, 'resolved');
    assert.equal(done.json.message.from_identity, 'owner');
    assert.equal(done.json.message.to_identity, 'eli');
    assert.match(done.json.message.body, /^רן סיים: GO: פריסה\nGO$/);

    // 2. His own words on an inbox ask: the answer leaves from him.
    hq.mailbox.ask({ msg_id: 'ask-app-1', from: 'eli', question: 'להעביר את הבוטים?', blocking: true });
    const item = hq.inbox.open().find((i) => i.ref === 'ask-app-1')!;
    const viaInbox = await app(`/api/inbox/${item.id}/answer`, { answer: 'לא, בלי הבוטים' });
    assert.equal(viaInbox.status, 200);
    const a1 = hq.mailbox.get('ask-app-1-answer')!;
    assert.equal(a1.from_identity, 'owner');
    assert.equal(a1.to_identity, 'eli');
    assert.match(a1.body, /לא, בלי הבוטים/);

    // 3. A button on the ask itself: /api/asks/:id/answer.
    hq.mailbox.ask({ msg_id: 'ask-app-2', from: 'eli', question: 'לפרוס?', blocking: true });
    const viaAsk = await app('/api/asks/ask-app-2/answer', { answer: 'GO', by: 'owner' });
    assert.equal(viaAsk.status, 200);
    const a2 = hq.mailbox.get('ask-app-2-answer')!;
    assert.equal(a2.from_identity, 'owner');
    assert.equal(a2.to_identity, 'eli');
    assert.match(a2.body, /GO/);
  } finally { await env.cleanup(); }
});
