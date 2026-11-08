// error-catcher (22/10/2026): «לבנות, אבל עם אישור שלי לכל תקלה». Each new error signature is one item for him with
// "לטפל" / "לא עכשיו"; it happening again moves the count on that item; "לטפל" opens a task, "לא עכשיו" mutes it for a day;
// a storm goes to the monitoring lead in one message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, type TestEnv } from './helpers.ts';
import { CLIENT_ERRORS_MAX } from '../src/api.ts';
import { wantsHandling, FIRST_WAIT_MS, HANDLE, MUTE_MS, NOT_NOW, STORM, WINDOW_MS, normalize, normalizePath, signature, known } from '../src/error-watch.ts';

const MIN = 60_000;

async function env(): Promise<TestEnv> {
  const e = await makeEnv();
  // Messages stay queued: no fake shift in the way of the timing.
  (e.hq.mailbox as unknown as { deliver: () => Promise<void> }).deliver = async () => {};
  e.hq.store.setToggle('adi/error-catcher', true, false);
  await e.hq.errorWatch.sweep(); // the first sweep sets the cursor: history before it is not news
  return e;
}

const undelivered = (e: TestEnv, to = 'yoav', why = 'המשמרת לא קמה אחרי 120 שניות (msg agent-company-t244-1:mviiesti-01a05ea33d)') =>
  e.hq.store.emit('message.undelivered', to, { id: `m-${e.clock.t}`, from: 'ran', to, why });

const asks = (e: TestEnv) => e.hq.store.db.prepare(`SELECT * FROM asks WHERE from_identity = 'hq' AND id LIKE 'err-%'`).all() as
  { id: string; question: string; options: string; state: string }[];
const items = (e: TestEnv) => e.hq.inbox.open().filter((i) => i.kind === 'ask' && i.ref?.startsWith('err-'));
const sigs = (e: TestEnv) => e.hq.store.db.prepare('SELECT * FROM error_signatures').all() as { sig: string; state: string; count: number; cycle_count: number; task_id: number | null; muted_until: number | null }[];

test('signature: the same error with other ids, numbers and paths is one; another component is another', () => {
  const a = { type: 'turn.error', component: 'agent-company-t244', message: 'API Error 500 at /home/ran/x.ts:12 for msg adi-1:mvigd529-2geca04177' };
  const b = { type: 'turn.error', component: 'agent-company-t251', message: 'API Error 503 at /tmp/y.ts:7 for msg yoav-3:mvi00000-0000000000' };
  assert.equal(signature(a), signature(b));
  assert.notEqual(signature(a), signature({ ...a, component: 'dana' }));
  assert.notEqual(signature(a), signature({ ...a, type: 'api.5xx' }));
  assert.equal(normalize('task t12 at 2026-10-22T01:08:00Z took 300ms'), 'task t# at <time> took #ms');
  assert.equal(normalizePath('/api/inbox/12/ack?x=1'), '/api/inbox/:id/ack');
  assert.equal(known({ type: 'turn.error', message: 'Claude AI usage limit reached|1792611158' }), true);
  assert.equal(known({ type: 'turn.error', message: "You've hit your weekly limit · resets Nov 7, 5am (Europe/Berlin)" }), true);
  assert.equal(known({ type: 'turn.error', message: 'You have hit your context window limit' }), false);
  assert.equal(known({ type: 'turn.error', message: 'Prompt is too long' }), false);
});

test('a new error is one item for him after the first wait; again → the same item, the count goes up', async () => {
  const e = await env();
  try {
    undelivered(e);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 0, 'waits FIRST_WAIT_MS so a series arrives as one');
    e.clock.advance(MIN);
    undelivered(e);
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    const [a] = asks(e);
    assert.ok(a);
    assert.deepEqual(JSON.parse(a.options), [HANDLE, NOT_NOW]);
    assert.match(a.question, /הודעה ל.* לא נמסרה/);
    assert.match(a.question, /2 פעמים/);
    const [item] = items(e);
    assert.match(item!.title, /^תפסתי תקלה · 2 פעמים מ-\d\d:\d\d$/);
    assert.doesNotMatch(item!.headline ?? '', /«/, 'the error\'s words are in the details, not the headline');
    assert.equal(item!.blocking, false);

    // Another with another message id is the same signature: no new item, the count on this one.
    undelivered(e, 'yoav', 'המשמרת לא קמה אחרי 90 שניות (msg dana-2:mvi11111-1111111111)');
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 1);
    assert.equal(items(e).length, 1);
    assert.match(items(e)[0]!.body, /3 פעמים/);
    assert.match(items(e)[0]!.title, /^תפסתי תקלה · 3 פעמים/);
    assert.match(asks(e)[0]!.question, /3 פעמים/);
    assert.equal(sigs(e)[0]!.count, 3);
  } finally { await e.cleanup(); }
});

test('"לטפל" opens one task in agent-company under adi, with the examples and the events around', async () => {
  const e = await env();
  try {
    e.hq.store.emit('engine.text', 'yoav', { shift: 's1', ev: { text: 'עובד על זה' } });
    e.hq.store.emit('turn.error', 'yoav', { shift: 's1', identity: 'yoav', subtype: 'error_during_execution', text: 'Prompt is too long' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    const [a] = asks(e);
    e.hq.mailbox.answer(a!.id, HANDLE);
    await new Promise((r) => setImmediate(r));
    const [s] = sigs(e);
    assert.equal(s!.state, 'handling');
    const t = e.hq.scheduler.task(s!.task_id!)!;
    assert.equal(t.project, 'agent-company');
    assert.ok(JSON.parse(t.labels).includes('opened-by:adi'));
    assert.match(t.title, /^תקלה: סבב של .* נגמר בשגיאה/);
    assert.match(t.body, /Prompt is too long/);
    assert.match(t.body, /engine\.text/, 'the events around it');
    assert.equal(items(e).length, 0, 'answered: the item is gone');

    // Again while it is handled: counted, nothing new asked.
    e.hq.store.emit('turn.error', 'yoav', { shift: 's1', identity: 'yoav', subtype: 'error_during_execution', text: 'Prompt is too long' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 1);
    assert.equal((e.hq.store.db.prepare(`SELECT COUNT(*) n FROM tasks WHERE project = 'agent-company'`).get() as { n: number }).n, 1);

    // Its task done, and it comes back: a new item that says so.
    e.hq.store.db.prepare(`UPDATE tasks SET state = 'done' WHERE id = ?`).run(t.id);
    await e.hq.errorWatch.sweep();
    e.hq.store.emit('turn.error', 'yoav', { shift: 's2', identity: 'yoav', subtype: 'error_during_execution', text: 'Prompt is too long' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 2);
    assert.match(items(e)[0]!.body, /^חזרה אחרי שטופלה/);
  } finally { await e.cleanup(); }
});

test('"לא עכשיו" mutes it for a day: counted, not asked; after the day it is asked again', async () => {
  const e = await env();
  try {
    e.hq.store.emit('api.5xx', null, { method: 'GET', route: '/api/board', error: 'no such column: x', stack: 'at board' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    e.hq.mailbox.answer(asks(e)[0]!.id, NOT_NOW);
    await new Promise((r) => setImmediate(r));
    assert.equal(sigs(e)[0]!.state, 'muted');
    e.clock.advance(MIN);
    e.hq.store.emit('api.5xx', null, { method: 'GET', route: '/api/board', error: 'no such column: x', stack: 'at board' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 1, 'muted: no new item');
    assert.equal(sigs(e)[0]!.count, 2, 'but counted');
    assert.equal((e.hq.store.db.prepare(`SELECT COUNT(*) n FROM tasks`).get() as { n: number }).n, 0);

    e.clock.advance(MUTE_MS);
    e.hq.store.emit('api.5xx', null, { method: 'GET', route: '/api/board', error: 'no such column: x', stack: 'at board' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 2);
    assert.match(items(e)[0]!.body, /פעם אחת/);
  } finally { await e.cleanup(); }
});

test('closing the card without an answer is "לא עכשיו"', async () => {
  const e = await env();
  try {
    undelivered(e);
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    e.hq.mailbox.complete(items(e)[0]!.id, { declined: true });
    await new Promise((r) => setImmediate(r));
    assert.equal(sigs(e)[0]!.state, 'muted');
    assert.equal(sigs(e)[0]!.muted_until, e.clock.t + MUTE_MS);
  } finally { await e.cleanup(); }
});

test('known ones (a rate limit, a closed task) and internal ones under the threshold are counted only', async () => {
  const e = await env();
  try {
    e.hq.store.emit('turn.error', 'yoav', { identity: 'yoav', text: "You've hit your usage limit · resets 3pm" });
    undelivered(e, 'yoav', 'המשימה כבר נסגרה');
    e.hq.store.emit('loop.error', null, { loop: 'nodes', error: 'ssh: connect timed out' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 0);
    assert.deepEqual(sigs(e).map((s) => s.state).sort(), ['idle', 'known', 'known']);
    // A second loop.error in the window: now it counts.
    e.hq.store.emit('loop.error', null, { loop: 'nodes', error: 'ssh: connect timed out' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 1);
    // Its own failure is not watched: it must not feed itself.
    e.hq.store.emit('loop.error', null, { loop: 'error-catcher', error: 'x' });
    e.hq.store.emit('loop.error', null, { loop: 'error-catcher', error: 'x' });
    await e.hq.errorWatch.sweep();
    assert.equal(sigs(e).length, 3);
  } finally { await e.cleanup(); }
});

test('off in org.yaml: counted, nothing asked', async () => {
  const e = await env();
  try {
    e.hq.store.setToggle('adi/error-catcher', false);
    undelivered(e);
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 0);
    assert.equal(sigs(e)[0]!.count, 1);
  } finally { await e.cleanup(); }
});

test('a storm (more than 20 new signatures in 10 minutes) is one message to the monitoring lead, nothing asked', async () => {
  const e = await env();
  try {
    for (let i = 0; i <= STORM; i++) e.hq.store.emit('client.error', null, { message: `boom ${'abcdefghijklmnopqrstuvwxyz'[i]}`, screen: `screen-${'abcdefghijklmnopqrstuvwxyz'[i]}` });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(asks(e).length, 0);
    const storm = e.hq.store.db.prepare(`SELECT * FROM messages WHERE id LIKE 'error-storm-%'`).all() as { to_identity: string; body: string }[];
    assert.equal(storm.length, 1);
    assert.equal(storm[0]!.to_identity, e.hq.cfg.monitoringLeadId);
    assert.match(storm[0]!.body, /^הרבה תקלות יחד: 21 חתימות/);
    // More of it in the same window: still one message.
    e.hq.store.emit('client.error', null, { message: 'boom zz', screen: 'zz' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal((e.hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE id LIKE 'error-storm-%'`).get() as { n: number }).n, 1);
    assert.ok(WINDOW_MS > 2 * FIRST_WAIT_MS);
  } finally { await e.cleanup(); }
});

test('a storm that builds up slowly takes back what was asked in its window, and what comes after it is not asked either', async () => {
  const e = await env();
  try {
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < 15; i++) e.hq.store.emit('client.error', null, { message: `boom ${letters[i]}`, screen: `s-${letters[i]}` });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(items(e).length, 15, 'not a storm yet: asked one by one');
    for (let i = 15; i < 25; i++) e.hq.store.emit('client.error', null, { message: `boom ${letters[i]}`, screen: `s-${letters[i]}` });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    await new Promise((r) => setImmediate(r));
    assert.equal(items(e).length, 0, 'the storm took its items back');
    assert.ok(sigs(e).every((s) => s.state === 'muted' && s.muted_until !== e.clock.t + MUTE_MS), 'taken back is not his "לא עכשיו"');
    const storm = e.hq.store.db.prepare(`SELECT body FROM messages WHERE id LIKE 'error-storm-%'`).all() as { body: string }[];
    assert.equal(storm.length, 1);
    assert.match(storm[0]!.body, /^הרבה תקלות יחד: 25 חתימות/);

    // After it, in the same window: five more new ones are not five items for him.
    for (let i = 0; i < 5; i++) e.hq.store.emit('client.error', null, { message: `after ${letters[i]}`, screen: `after-${letters[i]}` });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.equal(items(e).length, 0);
    assert.equal((e.hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE id LIKE 'error-storm-%'`).get() as { n: number }).n, 1);
  } finally { await e.cleanup(); }
});

test('"סיימתי" on the card or other words without "לטפל" mute it; his words with "לטפל" open the task with them', async () => {
  const e = await env();
  try {
    undelivered(e);
    e.hq.store.emit('api.5xx', null, { method: 'GET', route: '/api/board', error: 'x', stack: '' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    const [i1, i2] = items(e);
    e.hq.mailbox.complete(i1!.id);
    e.hq.mailbox.reply(i2!.id, 'כן לטפל, זה קרה לי גם אתמול');
    await new Promise((r) => setImmediate(r));
    const by = Object.fromEntries(sigs(e).map((s) => [s.state, s]));
    assert.ok(by.muted && by.handling);
    assert.match(e.hq.scheduler.task(by.handling!.task_id!)!.body, /זה קרה לי גם אתמול/);
  } finally { await e.cleanup(); }
});

test('the times in his line are of the occurrences it counts', async () => {
  const e = await env();
  try {
    e.hq.store.emit('loop.error', null, { loop: 'nodes', error: 'ssh down' });
    e.clock.advance(3 * MIN);
    e.hq.store.emit('loop.error', null, { loop: 'nodes', error: 'ssh down' });
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    assert.match(items(e)[0]!.body, /2 פעמים, מ-09:00 עד 09:03/);
  } finally { await e.cleanup(); }
});

test('his no is a no: "אל תטפל", "לא", "לא עכשיו" never open a task', async () => {
  for (const no of ['אל תטפל', 'אל תטפל בזה', 'לא', 'לא עכשיו', 'לא צריך לטפל', 'אין צורך לטפל', 'בלי לטפל', 'סיימתי', 'תתעלם',
    'ולא לטפל', 'ואל תטפל', 'שלא תטפל', 'עדיף שלא לטפל', 'לא לתקן', 'כנראה לא', 'כן, אבל לא עכשיו', 'כן, אבל אל תטפל', 'כן ראיתי, לא צריך', 'לא, אני אתקן לבד',
    'אני אתקן בעצמי', 'אני אטפל בזה']) assert.equal(wantsHandling(no), false, no);
  for (const yes of ['לטפל', 'כן לטפל', 'תטפל בזה', 'לטפל, לא דחוף', 'אין בעיה, תטפל', 'לא יודע מה זה, תטפל', 'בלי קשר, תטפל',
    'כן', 'כן.', 'תתקן', 'טפל בזה', 'כן, לטפל',
    'אני רוצה שתטפל', 'שתטפל בזה', 'שתתקן', 'תתקנו', 'כן בבקשה', 'כן כן']) assert.equal(wantsHandling(yes), true, yes);
  const e = await env();
  try {
    undelivered(e);
    e.clock.advance(FIRST_WAIT_MS);
    await e.hq.errorWatch.sweep();
    e.hq.mailbox.reply(items(e)[0]!.id, 'אל תטפל');
    await new Promise((r) => setImmediate(r));
    assert.equal(sigs(e)[0]!.state, 'muted');
    assert.equal((e.hq.store.db.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n, 0);
  } finally { await e.cleanup(); }
});

test('POST /api/client-errors: one event per report, a rate limit per caller; a 500 is an api.5xx with the route without ids', async () => {
  const e = await makeEnv({ noStart: true });
  await e.hq.start({ listen: true, timers: false });
  try {
    const token = readFileSync(join(e.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = (method: string, path: string, body?: unknown) => fetch(`http://127.0.0.1:${e.hq.port}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const r = await call('POST', '/api/client-errors', { message: 'Null check operator used on a null value', screen: 'chat', app_version: '1.4.2', stack: '#0 x', shown: true });
    assert.equal(r.status, 200);
    const ev = e.hq.store.eventsAfter(0, 5000).filter((x) => x.type === 'client.error');
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0]!.data, { kind: 'error', message: 'Null check operator used on a null value', screen: 'chat', app_version: '1.4.2', stack: '#0 x', shown: true });
    assert.equal((await call('POST', '/api/client-errors', { screen: 'chat' })).status, 400, 'message is required');
    let last = 200;
    for (let i = 0; i < CLIENT_ERRORS_MAX; i++) last = (await call('POST', '/api/client-errors', { message: `x${i}` })).status;
    assert.equal(last, 429);

    e.hq.inbox.ack = () => { throw new Error('boom'); };
    assert.equal((await call('POST', '/api/inbox/17/ack')).status, 500);
    const five = e.hq.store.eventsAfter(0, 5000).filter((x) => x.type === 'api.5xx');
    assert.equal(five.length, 1);
    assert.deepEqual({ ...(five[0]!.data as object), stack: undefined }, { method: 'POST', route: '/api/inbox/:id/ack', error: 'boom', stack: undefined });
  } finally { await e.cleanup(); }
});
