import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until, type TestEnv } from './helpers.ts';
import { contextTokens } from '../src/rotation.ts';
import type { EngineEvent } from '@company/shared';

/** A result whose last model call read `ctx` tokens (usage.iterations, as the CLI reports it). */
const result = (ctx: number) => ({ kind: 'result', subtype: 'success', isError: false, usage: {
  input_tokens: 10, cache_read_input_tokens: ctx * 3, output_tokens: 500,
  iterations: [{ input_tokens: 2, output_tokens: 400, cache_read_input_tokens: ctx - 1402, cache_creation_input_tokens: 1000, type: 'message' }],
} }) as unknown as EngineEvent;

const handoff = (env: TestEnv, identity: string, id: string) =>
  env.hq.store.db.prepare(`INSERT INTO ops (id, identity, shift, op, args, received_at, ack) VALUES (?, ?, ?, 'handoff', ?, ?, '{}')`)
    .run(id, identity, `${identity}-1`, JSON.stringify({ next: ['להמשיך'] }), env.clock.now());

const events = (env: TestEnv, type: string) => (env.hq.store.db.prepare(`SELECT data FROM events WHERE type = ? ORDER BY seq`).all(type) as { data: string }[])
  .map((r) => JSON.parse(r.data) as Record<string, unknown>);

const rotateAsk = (env: TestEnv, identity: string) =>
  env.hq.store.db.prepare(`SELECT id, body FROM messages WHERE to_identity = ? AND from_identity = 'hq' AND id LIKE 'rotate-%' ORDER BY created_at`).all(identity) as { id: string; body: string }[];

/** eli has a live shift that answered one message; its turn ended with a context of `ctx`. */
async function liveEli(env: TestEnv, ctx: number) {
  const { hq, launcher } = env;
  hq.mailbox.tell({ msg_id: 'm-1', to: 'eli', body: 'שלום' });
  await until(() => hq.mailbox.get('m-1')?.state === 'delivered');
  hq.mailbox.markHandled('m-1');
  launcher.hosts.get('eli-1')!.event(result(ctx));
  await until(() => hq.shifts.get('eli-1')!.context_tokens === ctx, 3000, 'context stored');
  await new Promise((r) => setImmediate(r));
}

const flush = () => new Promise((r) => setTimeout(r, 30));

test('contextTokens: the last iteration of the turn, not the turn\'s sum', () => {
  assert.equal(contextTokens((result(250_000) as { usage?: unknown }).usage), 250_000);
  assert.equal(contextTokens({ input_tokens: 5 }), null);
  assert.equal(contextTokens(undefined), null);
});

test('cap: over maxContextTokens at the end of a turn → handoff asked, the shift goes on until it is written, then a clean shift', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    await liveEli(env, 650_000);
    await until(() => rotateAsk(env, 'eli').length === 1, 3000, 'handoff asked');
    assert.match(rotateAsk(env, 'eli')[0]!.body, /handoff/);
    // A turn that ends without the handoff: the shift is not stopped.
    launcher.hosts.get('eli-1')!.event(result(660_000));
    await flush();
    assert.equal(hq.shifts.get('eli-1')!.state, 'live', 'never stopped before the handoff is written');
    handoff(env, 'eli', 'eli-1:h1');
    hq.mailbox.tell({ msg_id: 'm-2', to: 'eli', body: 'עוד משהו' }); // mail on the way: the clean shift starts at once
    launcher.hosts.get('eli-1')!.event(result(670_000));
    await until(() => hq.shifts.get('eli-1')!.state === 'ended', 3000, 'rotated');
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rotation');
    const rotated = events(env, 'shift.rotated');
    assert.equal(rotated.length, 1);
    assert.deepEqual([rotated[0]!.trigger, rotated[0]!.context_tokens], ['cap', 670_000]);
    await until(() => launcher.launches.some((l) => l.shiftId === 'eli-2'), 3000, 'clean shift');
    assert.equal(launcher.launches.find((l) => l.shiftId === 'eli-2')!.resume, false);
    assert.equal(hq.shifts.get('eli-2')!.context_tokens, null);
  } finally { await env.cleanup(); }
});

test('cap: deferred while background work runs or an ask to him is open; asked once they are gone', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    await liveEli(env, 100);
    hq.shifts.setFields('eli-1', { bg_tasks: '["b1"]' });
    launcher.hosts.get('eli-1')!.event(result(700_000));
    await flush();
    assert.equal(rotateAsk(env, 'eli').length, 0);
    hq.shifts.setFields('eli-1', { bg_tasks: '[]' });
    hq.store.db.prepare(`INSERT INTO asks (id, from_identity, question, created_at) VALUES ('ask-1', 'eli', 'לשלם?', ?)`).run(env.clock.now());
    launcher.hosts.get('eli-1')!.event(result(710_000));
    launcher.hosts.get('eli-1')!.event(result(720_000));
    await flush();
    assert.equal(rotateAsk(env, 'eli').length, 0);
    assert.deepEqual(events(env, 'shift.rotation_deferred').map((e) => e.why), ['background', 'ask'], 'one event per reason');
    hq.store.db.prepare(`UPDATE asks SET state = 'answered' WHERE id = 'ask-1'`).run();
    launcher.hosts.get('eli-1')!.event(result(730_000));
    await until(() => rotateAsk(env, 'eli').length === 1, 3000, 'asked after');
    assert.equal(hq.shifts.get('eli-1')!.state, 'live');
  } finally { await env.cleanup(); }
});

test('cap: an open GO of its own defers it too', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    await liveEli(env, 100);
    hq.inbox.add({ kind: 'go', title: 'GO: פריסה', from_identity: 'eli', blocking: true });
    launcher.hosts.get('eli-1')!.event(result(700_000));
    await flush();
    assert.equal(rotateAsk(env, 'eli').length, 0);
    assert.deepEqual(events(env, 'shift.rotation_deferred').map((e) => e.why), ['go']);
  } finally { await env.cleanup(); }
});

test('rest: a big lead writes a handoff before it rests; woken within the hour it resumes, after it a clean shift starts', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock, launcher } = env;
    hq.watchdog.procCheck = (pid) => hq.store.db.prepare('SELECT proc_start FROM shifts WHERE pid = ? LIMIT 1').pluck().get(pid) as string;
    await liveEli(env, 200_000);
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get('eli-1')!.state, 'live', 'not rested before the handoff');
    assert.equal(rotateAsk(env, 'eli').length, 1);
    hq.mailbox.markHandled(rotateAsk(env, 'eli')[0]!.id);
    handoff(env, 'eli', 'eli-1:h1');
    launcher.hosts.get('eli-1')!.event(result(205_000));
    await until(() => hq.shifts.get('eli-1')!.state === 'ended', 3000, 'rested');
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');
    assert.ok(hq.shifts.get('eli-1')!.rest_handoff_at);

    // Within the hour: the cache is still warm, same session.
    clock.advance(30 * 60_000);
    hq.mailbox.tell({ msg_id: 'm-2', to: 'eli', body: 'שאלה קטנה' });
    await until(() => hq.mailbox.get('m-2')?.state === 'delivered');
    assert.equal(launcher.launches.at(-1)!.shiftId, 'eli-1');
    assert.equal(launcher.launches.at(-1)!.resume, true);
    assert.equal(hq.shifts.get('eli-1')!.context_tokens, 205_000, 'kept across the resume');
    hq.mailbox.markHandled('m-2');

    // Rests again (a new handoff), then sleeps past the hour: the wake is a clean shift.
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(rotateAsk(env, 'eli').length, 2);
    hq.mailbox.markHandled(rotateAsk(env, 'eli')[1]!.id);
    handoff(env, 'eli', 'eli-1:h2');
    launcher.hosts.get('eli-1')!.event(result(206_000));
    await until(() => hq.shifts.get('eli-1')!.state === 'ended', 3000, 'rested again');
    clock.advance(61 * 60_000);
    hq.mailbox.tell({ msg_id: 'm-3', to: 'eli', body: 'בוקר' });
    await until(() => hq.mailbox.get('m-3')?.state === 'delivered');
    assert.equal(launcher.launches.at(-1)!.shiftId, 'eli-2');
    assert.equal(launcher.launches.at(-1)!.resume, false);
    const rotated = events(env, 'shift.rotated');
    assert.equal(rotated.length, 1);
    assert.deepEqual([rotated[0]!.trigger, rotated[0]!.shift, rotated[0]!.next, rotated[0]!.context_tokens], ['rest', 'eli-1', 'eli-2', 206_000]);
  } finally { await env.cleanup(); }
});

test('rest: a small context rests as always, and a late wake resumes', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock, launcher } = env;
    hq.watchdog.procCheck = (pid) => hq.store.db.prepare('SELECT proc_start FROM shifts WHERE pid = ? LIMIT 1').pluck().get(pid) as string;
    await liveEli(env, 90_000);
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');
    assert.equal(rotateAsk(env, 'eli').length, 0);
    clock.advance(3 * 60 * 60_000);
    hq.mailbox.tell({ msg_id: 'm-2', to: 'eli', body: 'בוקר' });
    await until(() => hq.mailbox.get('m-2')?.state === 'delivered');
    assert.equal(launcher.launches.at(-1)!.shiftId, 'eli-1');
    assert.equal(launcher.launches.at(-1)!.resume, true);
  } finally { await env.cleanup(); }
});

test('rest: a big lead with an open ask rests without a handoff, and its late wake resumes', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock, launcher } = env;
    hq.watchdog.procCheck = (pid) => hq.store.db.prepare('SELECT proc_start FROM shifts WHERE pid = ? LIMIT 1').pluck().get(pid) as string;
    await liveEli(env, 300_000);
    hq.store.db.prepare(`INSERT INTO asks (id, from_identity, question, created_at) VALUES ('ask-1', 'eli', 'לשלם?', ?)`).run(clock.now());
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');
    assert.equal(rotateAsk(env, 'eli').length, 0);
    assert.deepEqual(events(env, 'shift.rotation_deferred').map((e) => [e.why, e.for]), [['ask', 'rest']]);
    clock.advance(2 * 60 * 60_000);
    hq.mailbox.tell({ msg_id: 'm-2', to: 'eli', body: 'התשובה: כן' });
    await until(() => hq.mailbox.get('m-2')?.state === 'delivered');
    assert.equal(launcher.launches.at(-1)!.resume, true);
  } finally { await env.cleanup(); }
});

test('rest: no handoff within handoffWaitMs → it rests as before, and resumes later', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock, launcher } = env;
    hq.watchdog.procCheck = (pid) => hq.store.db.prepare('SELECT proc_start FROM shifts WHERE pid = ? LIMIT 1').pluck().get(pid) as string;
    await liveEli(env, 200_000);
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(rotateAsk(env, 'eli').length, 1);
    hq.mailbox.markHandled(rotateAsk(env, 'eli')[0]!.id);
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');
    assert.equal(hq.shifts.get('eli-1')!.rest_handoff_at, null);
    assert.equal(events(env, 'shift.rotation_skipped').length, 1);
    clock.advance(2 * 60 * 60_000);
    hq.mailbox.tell({ msg_id: 'm-2', to: 'eli', body: 'בוקר' });
    await until(() => hq.mailbox.get('m-2')?.state === 'delivered');
    assert.equal(launcher.launches.at(-1)!.resume, true);
  } finally { await env.cleanup(); }
});

test('cap: an ask opened in the handoff turn holds the rotation; it goes with that handoff once the ask is answered', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    await liveEli(env, 650_000);
    await until(() => rotateAsk(env, 'eli').length === 1, 3000, 'handoff asked');
    handoff(env, 'eli', 'eli-1:h1');
    hq.store.db.prepare(`INSERT INTO asks (id, from_identity, question, created_at) VALUES ('ask-1', 'eli', 'לפרוס?', ?)`).run(env.clock.now());
    launcher.hosts.get('eli-1')!.event(result(660_000));
    await flush();
    assert.equal(hq.shifts.get('eli-1')!.state, 'live', 'not rotated with his question open');
    assert.deepEqual(events(env, 'shift.rotation_deferred').map((e) => [e.why, e.for]), [['ask', 'cap']]);
    hq.store.db.prepare(`UPDATE asks SET state = 'answered' WHERE id = 'ask-1'`).run();
    launcher.hosts.get('eli-1')!.event(result(670_000));
    await until(() => hq.shifts.get('eli-1')!.state === 'ended', 3000, 'rotated');
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rotation');
    assert.equal(rotateAsk(env, 'eli').length, 1, 'the handoff already written is the one used');
  } finally { await env.cleanup(); }
});

test('rest: background work started in the handoff turn keeps the shift up', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock, launcher } = env;
    hq.watchdog.procCheck = (pid) => hq.store.db.prepare('SELECT proc_start FROM shifts WHERE pid = ? LIMIT 1').pluck().get(pid) as string;
    await liveEli(env, 200_000);
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(rotateAsk(env, 'eli').length, 1);
    handoff(env, 'eli', 'eli-1:h1');
    hq.shifts.setFields('eli-1', { bg_tasks: '["b1"]' });
    launcher.hosts.get('eli-1')!.event(result(205_000));
    await flush();
    assert.equal(hq.shifts.get('eli-1')!.state, 'live');
    assert.equal(hq.shifts.get('eli-1')!.rest_handoff_at, null);
  } finally { await env.cleanup(); }
});
