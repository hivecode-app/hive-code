// #118: רן asked a worker «תשלח לי מה הבעיה». It called status done mid-turn, hq stopped the shift within
// seconds, and the text it was still writing (his answer) never existed. The task closed; he searched and found
// nothing. Now: the stop waits for the turn, a task with his message unanswered does not close, and "ביקשת"
// shows the request and then the answer until he reads it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WalEntry } from '@company/shared';
import { makeEnv, until, type TestEnv } from './helpers.ts';
import { ASKED_AFTER_MS } from '../src/asked.ts';
import { validateBlocks } from '../src/home.ts';

const op = (env: TestEnv, o: WalEntry['op'], args: Record<string, unknown>, id: string, identity: string) =>
  env.hq.ingest.op({ id, v: 1, ts: new Date().toISOString(), identity, shift: `${identity}-1`, sessionId: null, op: o, args } as WalEntry);

/** A task worker, live, in a turn on his message (dequeued = seen). */
async function workerOnHisMessage(env: TestEnv, body: string) {
  const { hq, launcher } = env;
  const t = hq.scheduler.addTask({ title: 'ביטול מיזוג', project: 'agent-company', labels: ['opened-by:ac-ceo'] });
  await hq.scheduler.fill();
  const worker = `agent-company-t${t.id}`;
  const sid = `${worker}-1`;
  await until(() => hq.shifts.current(worker)?.state === 'live', 3000, 'worker live');
  const host = launcher.hosts.get(sid)!;
  hq.mailbox.tell({ msg_id: 'm-ask', to: worker, body });
  await until(() => hq.mailbox.get('m-ask')!.state === 'delivered', 3000, 'delivered');
  host.deliveryState('m-ask', 'started');
  host.event({ kind: 'user_echo', uuid: 'u', text: body });
  await until(() => hq.mailbox.get('m-ask')!.state === 'seen' && hq.shifts.get(sid)!.in_turn === 1, 3000, 'seen, in turn');
  return { t, worker, sid, host };
}

const stops = (host: { received: { t: string }[] }) => host.received.filter((f) => f.t === 'stop').length;

test('#118: status done mid-turn waits for the turn; the text after it is his reply, then the task closes', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const { t, worker, sid, host } = await workerOnHisMessage(env, 'תבטל להם את המיזוג תשלח לי מה הבעיה אני אשלח למשה');
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__status', input: { state: 'done' } });
    op(env, 'status', { state: 'done', summary: 'מצב אוטומטי חזר למשה' }, `${sid}:01`, worker);
    host.event({ kind: 'tool_result', toolUseId: 't1', isError: false, preview: '{"queued":true}' });
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(stops(host), 0, 'no stop while the turn is still writing');
    assert.equal(hq.scheduler.task(t.id)!.state, 'running');

    const answer = 'ביטלתי (PR #4). הבעיות למשה: הפענוח רץ בתוך ה-webhook, וה-Secret חובה.';
    host.event({ kind: 'text', text: answer, messageId: 'msg_z' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: answer });
    await until(() => hq.scheduler.task(t.id)!.state === 'done', 3000, 'task done after the turn');
    const reply = hq.mailbox.get('m-ask-reply')!;
    assert.equal(reply.body, answer);
    assert.equal(reply.to_identity, 'owner');
    assert.equal(hq.mailbox.get('m-ask')!.state, 'handled');
    assert.equal(stops(host), 1);
    assert.equal(hq.scheduler.task(t.id)!.summary, 'מצב אוטומטי חזר למשה');
  } finally { await env.cleanup(); }
});

test('#118: a turn that ends without answering him keeps the task open, and the worker hears what he waits for', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const { t, worker, sid, host } = await workerOnHisMessage(env, 'תשלח לי מה הבעיה');
    op(env, 'status', { state: 'done', summary: 'נגמר', awaiting: 'check', awaiting_note: 'לבדוק' }, `${sid}:01`, worker);
    // Its only text went to someone else: nothing reached him.
    host.event({ kind: 'tool_use', toolUseId: 't1', name: 'mcp__company__tell', input: { to: 'ac-ceo', body: 'העברתי לרן' } });
    host.event({ kind: 'tool_result', toolUseId: 't1', isError: false, preview: '' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    await until(() => !!hq.mailbox.get(`${sid}:01-waiting`), 3000, 'worker told');
    const told = hq.mailbox.get(`${sid}:01-waiting`)!;
    assert.equal(told.to_identity, worker);
    assert.match(told.body, /רן מחכה לתשובה על «תשלח לי מה הבעיה»/);
    assert.equal(hq.scheduler.task(t.id)!.state, 'running');
    assert.equal(stops(host), 0);
    assert.equal(hq.awaiting.get(t.id), null, '"מה לבדוק" only once it really closes');

    // It answers him with tell, closes again: done.
    op(env, 'tell', { to: 'owner', body: 'הבעיות: הפענוח בתוך ה-webhook, ה-Secret חובה' }, `${sid}:02`, worker);
    op(env, 'status', { state: 'done', summary: 'נגמר', awaiting: 'check', awaiting_note: 'לבדוק' }, `${sid}:03`, worker);
    await until(() => hq.scheduler.task(t.id)!.state === 'done', 3000, 'done after the answer');
    assert.equal(hq.awaiting.get(t.id)?.awaiting, 'check');
  } finally { await env.cleanup(); }
});

test('#118: close_team warns while he waits for the worker; force closes anyway', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const { t, worker, host } = await workerOnHisMessage(env, 'תשלח לי את הלוג');
    host.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    await until(() => hq.shifts.get(`${worker}-1`)!.in_turn === 0, 3000, 'turn over');
    assert.throws(() => op(env, 'close_team', { team: `t${t.id}` }, 'ac-ceo-1:01', 'ac-ceo'), (e: { status?: number }) => e.status === 409);
    await until(() => !!hq.mailbox.get('ac-ceo-1:01-rejected'), 2000, 'closer told');
    assert.match(hq.mailbox.get('ac-ceo-1:01-rejected')!.body, /רן מחכה לתשובה על «תשלח לי את הלוג».*force: true/s);
    assert.equal(hq.scheduler.task(t.id)!.state, 'running');

    op(env, 'close_team', { team: `t${t.id}`, force: true }, 'ac-ceo-1:02', 'ac-ceo');
    await until(() => hq.scheduler.task(t.id)!.state === 'done', 3000, 'forced close');
  } finally { await env.cleanup(); }
});

test('#118: "ביקשת": open after two minutes without an answer, then "answered" with the reply until he reads it', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    // Answered within the two minutes: a conversation, never on the list.
    hq.mailbox.tell({ msg_id: 'm-chat', to: 'eli', body: 'היי' });
    clock.advance(30_000);
    hq.mailbox.tell({ msg_id: 'm-chat-reply', from: 'eli', to: 'owner', body: 'היי רן', ref: 'm-chat' });
    clock.advance(60_000);

    hq.mailbox.tell({ msg_id: 'm-req', to: 'eli', body: 'תשלח לי מה הבעיה אני אשלח למשה' });
    assert.deepEqual(hq.home.asked(), [], 'not yet a request');
    clock.advance(ASKED_AFTER_MS);
    hq.mailbox.tell({ msg_id: 'm-req2', to: 'eli', body: 'ותוסיף את הלוג' });
    const [open] = hq.home.asked();
    assert.equal(open!.id, 'm-req');
    assert.equal(open!.state, 'open');
    assert.equal(open!.identity, 'eli');
    assert.equal(open!.count, 2, 'his follow-up is the same request');
    hq.home.watchAsked();
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'asked.changed' && (e.data as { ids: string[] }).ids.includes('m-req')),
      'the app hears of it');
    assert.equal(hq.home.watchAsked(), false, 'once per change');

    // Default home: right after "מחכה לך"; a composed recipe without it gets it anyway.
    const def = hq.home.defaultRecipe().blocks;
    assert.deepEqual(def.find((b) => b.type === 'asked'), { type: 'asked', messages: ['m-req'] });
    hq.home.compose([{ type: 'headline', text: 'בוקר שקט' }, { type: 'people', identities: ['eli'] }], 'yoav');
    assert.deepEqual(hq.home.current().blocks.map((b) => b.type), ['headline', 'asked', 'people']);

    clock.advance(5 * 60_000);
    hq.mailbox.tell({ msg_id: 'eli-1:tell', from: 'eli', to: 'owner', body: 'הבעיות: הפענוח בתוך ה-webhook' });
    const [answered] = hq.home.asked();
    assert.equal(answered!.state, 'answered');
    assert.equal(answered!.reply!.id, 'eli-1:tell');
    assert.equal(answered!.count, 2);
    assert.deepEqual(hq.home.current().blocks.find((b) => b.type === 'asked'), { type: 'asked', messages: ['m-req'] });

    clock.advance(1000);
    hq.conversations.markRead('eli');
    assert.deepEqual(hq.home.asked(), [], 'read: off the list');
    assert.equal(hq.home.current().blocks.some((b) => b.type === 'asked'), false);
  } finally { await env.cleanup(); }
});

test('#118: an ask or a GO that answered him is in "מחכה לך", not in "ביקשת"; a system notice is no answer', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.tell({ msg_id: 'm-a', to: 'eli', body: 'לשלם את החשבון?' });
    hq.mailbox.markHandled('m-a');
    hq.mailbox.tell({ msg_id: 'm-b', to: 'rotem', body: 'תבדקי את השרת' });
    hq.mailbox.tell({ msg_id: 'sys-1', from: 'rotem', to: 'owner', kind: 'system', body: 'הודעת מערכת' });
    clock.advance(ASKED_AFTER_MS + 1);
    assert.deepEqual(hq.home.asked().map((a) => a.id), ['m-b']);
  } finally { await env.cleanup(); }
});

test('compose_home: asked {messages[]} is validated against the list', () => {
  const refs = { projects: new Set<string>(), identities: new Set<string>(), inbox: new Set<number>(), awaiting: new Set<number>(), asked: new Set(['m-1']) };
  assert.deepEqual(validateBlocks([{ type: 'asked', messages: ['m-1', 'm-1'] }], refs), [{ type: 'asked', messages: ['m-1'] }]);
  assert.throws(() => validateBlocks([{ type: 'asked', messages: ['m-2'] }], refs), /לא ב"ביקשת"/);
  assert.throws(() => validateBlocks([{ type: 'asked', messages: [] }], refs), /messages/);
});

test('#118: asked.changed is emitted after the event that changed the list, never from inside it (the WS cursor)', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.tell({ msg_id: 'm-req', to: 'eli', body: 'תשלח לי מה הבעיה' });
    clock.advance(ASKED_AFTER_MS + 1);
    hq.home.watchAsked();
    let depth = 0;
    const seen: { type: string; nested: boolean }[] = [];
    hq.store.onEvent((e) => { seen.push({ type: e.type, nested: depth > 0 }); });
    hq.store.onEvent(() => { depth++; queueMicrotask(() => depth--); });
    hq.mailbox.tell({ msg_id: 'eli-1:t', from: 'eli', to: 'owner', body: 'הבעיות: …' });
    await until(() => seen.some((s) => s.type === 'asked.changed'), 2000, 'asked.changed');
    const i = seen.findIndex((s) => s.type === 'asked.changed');
    assert.ok(i > seen.findIndex((s) => s.type === 'message.new'));
    assert.equal(seen[i]!.nested, false);
  } finally { await env.cleanup(); }
});

test('#118: a second status done while the first waits: its awaiting wins', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const { t, worker, sid, host } = await workerOnHisMessage(env, 'מה המצב?');
    op(env, 'status', { state: 'done', summary: 'א', awaiting: 'check', awaiting_note: 'ישן' }, `${sid}:01`, worker);
    op(env, 'status', { state: 'done', summary: 'ב', awaiting: 'deploy', awaiting_note: 'חדש' }, `${sid}:02`, worker);
    host.event({ kind: 'text', text: 'הכול מוזג', messageId: 'msg_1' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'הכול מוזג' });
    await until(() => hq.scheduler.task(t.id)!.state === 'done', 3000, 'done');
    assert.equal(hq.awaiting.get(t.id)?.awaiting_note, 'חדש');
  } finally { await env.cleanup(); }
});

test('#118: an hq restart while status done waited: start finishes it from the ops table', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const env2 = await workerOnHisMessage(env, 'ועוד משהו');
    hq.mailbox.tell({ msg_id: 'r-1', from: env2.worker, to: 'owner', body: 'עניתי' });
    hq.store.db.prepare(`INSERT INTO ops (id, identity, shift, session_id, op, args, ts, received_at, ack) VALUES (?, ?, ?, NULL, 'status', ?, NULL, ?, '{}')`)
      .run(`${env2.sid}:09`, env2.worker, env2.sid, JSON.stringify({ state: 'done', summary: 'ג' }), hq.store.now() + 1);
    env2.host.event({ kind: 'result', subtype: 'success', isError: false, text: '' });
    assert.equal(hq.ingest.resumePendingDone(), 1);
    await until(() => hq.scheduler.task(env2.t.id)!.state === 'done', 3000, 'finished after restart');
  } finally { await env.cleanup(); }
});
