import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { makeEnv, type TestEnv } from './helpers.ts';
import { Estimates, median, parseEta } from '../src/estimates.ts';
import { Store } from '../src/store.ts';

const MIN = 60_000;
let n = 0;
const op = (env: TestEnv, o: WalEntry['op'], args: Record<string, unknown>, identity = 'ac-ceo') =>
  env.hq.ingest.op({ id: `${identity}-1:op${++n}`, v: 1, ts: '', identity, shift: `${identity}-1`, sessionId: null, op: o, args } as WalEntry);
const said = (env: TestEnv, id: string) => env.hq.mailbox.get(id)?.body;

test('parseEta: minutes, HH:MM and ISO become a due time; kind and a time are required', () => {
  const now = Date.UTC(2026, 9, 20, 9, 0, 0);
  assert.equal(parseEta({ eta_min: 20, eta_kind: 'feature', eta_what: 'PR מוכן' }, now, 'UTC', null)!.dueAt, now + 20 * MIN);
  assert.equal(parseEta({ eta_at: '10:30', eta_kind: 'report', eta_what: 'דוח' }, now, 'UTC', null)!.dueAt, now + 90 * MIN);
  assert.equal(parseEta({ eta_at: '08:00', eta_kind: 'report', eta_what: 'דוח' }, now, 'UTC', null)!.dueAt, now + 23 * 60 * MIN, 'a passed HH:MM is tomorrow');
  assert.equal(parseEta({ eta_at: '2026-10-20T11:00:00Z', eta_kind: 'build' }, now, 'UTC', 'בילד')!.what, 'בילד', 'what falls back');
  assert.equal(parseEta({ note: 'x' }, now, 'UTC', null), null, 'no eta fields, no estimate');
  assert.throws(() => parseEta({ eta_min: 5 }, now, 'UTC', 'x'), /eta_kind/);
  assert.throws(() => parseEta({ eta_kind: 'build' }, now, 'UTC', 'x'), /eta_min or eta_at/);
  assert.throws(() => parseEta({ eta_min: -1, eta_kind: 'build' }, now, 'UTC', 'x'), /eta_min/);
  assert.throws(() => parseEta({ eta_at: '2026-10-19T11:00:00Z', eta_kind: 'build' }, now, 'UTC', 'x'), /eta_at/);
  assert.throws(() => parseEta({ eta_min: 5, eta_kind: 'build' }, now, 'UTC', null), /eta_what/);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 10]), 2.5);
});

test('tell with eta: recorded with message_id, the calibration line comes back in Hebrew and the worker\'s number is untouched', async () => {
  const env = await makeEnv();
  try {
    const ack = op(env, 'tell', { to: 'yoav', body: 'שחרור 1.2 ל-Play', eta_min: 60, eta_kind: 'release', eta_what: '1.2 ב-Play' });
    const [e] = env.hq.estimates.list({ identity: 'ac-ceo' });
    assert.equal(e!.message_id, ack.id);
    assert.equal(e!.kind, 'release');
    assert.equal(e!.estimated_min, 60);
    assert.equal(e!.project, 'agent-company');
    assert.equal(e!.state, 'open');
    assert.equal((ack.result as any).estimate.suggestion.minutes, 120);
    assert.equal(said(env, `${ack.id}-estimate`), 'שחרורים יוצאים פי 2. אולי 120 דקות?');
    // Shape of the API row.
    assert.equal(env.hq.estimates.list({ message_id: ack.id }).length, 1);
    assert.equal(env.hq.estimates.list({ message_id: 'nope' }).length, 0);
  } finally { await env.cleanup(); }
});

test('status with eta: message_id is null; a short non-release promise gets 0.33 and +10 minutes', async () => {
  const env = await makeEnv();
  try {
    const ack = op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'feature', eta_what: 'הפיצ\'ר מוכן' });
    const [e] = env.hq.estimates.list();
    assert.equal(e!.message_id, null);
    assert.equal(said(env, `${ack.id}-estimate`), 'עבודה כזו נגמרת בחברה פי 3 מהר. אולי 20 דקות?');
    // 120 min deploy: ×0.33, over 30 so no padding; build ×1.5 without data.
    assert.equal(env.hq.estimates.suggest('agent-company', 'deploy', 120).minutes, 40);
    assert.equal(env.hq.estimates.suggest('agent-company', 'build', 20).line, 'בילדים יוצאים פי 1.5. אולי 40 דקות?');
    assert.equal(env.hq.estimates.suggest(null, 'report', 3).minutes, 11, 'padding comes after the factor');
  } finally { await env.cleanup(); }
});

test('a bad estimate does not reject the op: hq answers with the reason, and nothing is recorded', async () => {
  const env = await makeEnv();
  try {
    const ack = op(env, 'tell', { to: 'yoav', body: 'בעוד שעה', eta_min: 60 });
    assert.ok(env.hq.mailbox.get(ack.id), 'the message itself went out');
    assert.match(said(env, `${ack.id}-estimate-rejected`)!, /eta_kind/);
    assert.equal(env.hq.estimates.list().length, 0);
  } finally { await env.cleanup(); }
});

test('a new estimate on the same what is an update: the original is kept, closed as cancelled and pointing at the new one', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'feature', eta_what: 'ה-PR מוכן' });
    env.clock.advance(5 * MIN);
    const ack = op(env, 'status', { state: 'working', eta_min: 50, eta_kind: 'feature', eta_what: ' ה-PR  מוכן ' });
    op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'report', eta_what: 'דוח אחר' });
    const all = env.hq.estimates.list().reverse();
    assert.equal(all.length, 3, 'nothing is deleted');
    assert.equal(all[0]!.estimated_min, 30, 'as originally given');
    assert.equal(all[0]!.state, 'cancelled');
    assert.equal(all[0]!.superseded_by, all[1]!.id);
    assert.equal((ack.result as any).estimate.updated, all[0]!.id);
    assert.deepEqual(env.hq.estimates.list({ state: 'open' }).map((x) => x.what).sort(), ['דוח אחר', 'ה-PR מוכן'].sort());
  } finally { await env.cleanup(); }
});

test('eta_done closes the open estimate with the real time; late is kept', async () => {
  const env = await makeEnv();
  try {
    op(env, 'tell', { to: 'yoav', body: 'a', eta_min: 10, eta_kind: 'build', eta_what: 'בילד א' });
    op(env, 'tell', { to: 'yoav', body: 'b', eta_min: 10, eta_kind: 'build', eta_what: 'בילד ב' });
    env.clock.advance(4 * MIN);
    op(env, 'status', { state: 'working', eta_done: true, eta_what: 'בילד א' });
    let rows = env.hq.estimates.list();
    const a = rows.find((x) => x.what === 'בילד א')!;
    assert.equal(a.state, 'done');
    assert.equal(a.actual_min, 4);
    assert.equal(a.late, false);
    assert.equal(rows.find((x) => x.what === 'בילד ב')!.state, 'open');
    // Without eta_what: the newest open one; it is 25 minutes in, past its 10: missed first, then closed late with the real time.
    env.clock.advance(21 * MIN);
    assert.equal(env.hq.estimates.list({ state: 'missed' }).length, 1);
    op(env, 'tell', { to: 'yoav', body: 'c', eta_done: true });
    rows = env.hq.estimates.list();
    const b = rows.find((x) => x.what === 'בילד ב')!;
    assert.equal(b.state, 'done');
    assert.equal(b.actual_min, 25);
    assert.equal(b.late, true);
    assert.equal(env.hq.estimates.list({ state: 'missed' }).length, 0);
  } finally { await env.cleanup(); }
});

test('status done closes every open estimate of the worker as done', async () => {
  const env = await makeEnv();
  try {
    const t = env.hq.scheduler.addTask({ title: 'משימה', project: 'agent-company', identity: 'ac-ceo' });
    env.hq.store.db.prepare(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(t.id);
    op(env, 'status', { state: 'working', eta_min: 40, eta_kind: 'feature', eta_what: 'א' });
    op(env, 'status', { state: 'working', eta_min: 40, eta_kind: 'report', eta_what: 'ב' });
    assert.equal(env.hq.estimates.list()[0]!.task, t.id);
    env.clock.advance(12 * MIN);
    op(env, 'status', { state: 'done', summary: 'גמור' });
    for (let i = 0; i < 100 && env.hq.estimates.list({ state: 'open' }).length; i++) await new Promise((r) => setTimeout(r, 20));
    const rows = env.hq.estimates.list();
    assert.deepEqual(rows.map((x) => x.state), ['done', 'done']);
    assert.deepEqual(rows.map((x) => x.actual_min), [12, 12]);
  } finally { await env.cleanup(); }
});

test('a task that closes any other way cancels its open estimates, and only its own', async () => {
  const env = await makeEnv();
  try {
    const t = env.hq.scheduler.addTask({ title: 'משימה', project: 'agent-company', identity: 'ac-ceo' });
    env.hq.store.db.prepare(`UPDATE tasks SET state = 'running' WHERE id = ?`).run(t.id);
    op(env, 'status', { state: 'working', eta_min: 40, eta_kind: 'feature', eta_what: 'של המשימה' });
    op(env, 'status', { state: 'working', eta_min: 40, eta_kind: 'feature', eta_what: 'של אחרת' }, 'eli');
    env.clock.advance(3 * MIN);
    env.hq.scheduler.setTaskState(t.id, 'done');
    const rows = env.hq.estimates.list();
    assert.equal(rows.find((x) => x.what === 'של המשימה')!.state, 'cancelled');
    assert.equal(rows.find((x) => x.what === 'של המשימה')!.actual_min, null, 'cancelled has no real time');
    assert.equal(rows.find((x) => x.what === 'של אחרת')!.state, 'open');
  } finally { await env.cleanup(); }
});

test('missed is computed: past due and open; the sweep is idempotent', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'build', eta_what: 'בילד' });
    env.clock.advance(9 * MIN);
    assert.equal(env.hq.estimates.list()[0]!.state, 'open');
    env.clock.advance(2 * MIN);
    assert.equal(env.hq.estimates.list()[0]!.state, 'missed');
    assert.equal(env.hq.estimates.sweepMissed(), 0);
    assert.equal(env.hq.estimates.list({ state: 'missed' }).length, 1);
    assert.equal(env.hq.estimates.list({ state: 'open' }).length, 0);
  } finally { await env.cleanup(); }
});

test('the factor moves from the default to the project\'s data at 8 closed estimates of the kind', async () => {
  const env = await makeEnv();
  try {
    const { estimates } = env.hq;
    // Seven builds that took 3× what was promised: still the default ×1.5.
    for (let i = 0; i < 7; i++) {
      op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'build', eta_what: `בילד ${i}` });
      env.clock.advance(30 * MIN);
      op(env, 'status', { state: 'working', eta_done: true, eta_what: `בילד ${i}` });
    }
    let s = estimates.suggest('agent-company', 'build', 40);
    assert.deepEqual([s.source, s.samples, s.factor], ['default', 7, 1.5]);
    // The eighth: the median of 3, 3, ... is 3.
    op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'build', eta_what: 'בילד 7' });
    env.clock.advance(30 * MIN);
    op(env, 'status', { state: 'working', eta_done: true, eta_what: 'בילד 7' });
    s = estimates.suggest('agent-company', 'build', 40);
    assert.deepEqual([s.source, s.samples, s.factor, s.minutes], ['data', 8, 3, 120]);
    assert.equal(s.line, 'בילדים יוצאים פי 3. אולי 120 דקות?');
    // Other kinds and other projects are not mixed in; cancelled and updated ones do not count.
    assert.equal(estimates.suggest('agent-company', 'release', 60).source, 'default');
    assert.equal(estimates.suggest('lumo', 'build', 40).source, 'default');
    // Data that says the worker is faster than promised: the "מהר" wording, with the padding for a short promise.
    for (let i = 0; i < 8; i++) {
      op(env, 'status', { state: 'working', eta_min: 60, eta_kind: 'report', eta_what: `דוח ${i}` });
      env.clock.advance(15 * MIN);
      op(env, 'status', { state: 'working', eta_done: true, eta_what: `דוח ${i}` });
    }
    s = estimates.suggest('agent-company', 'report', 20);
    assert.equal(s.factor, 0.25);
    assert.equal(s.line, 'עבודה כזו נגמרת בחברה פי 4 מהר. אולי 15 דקות?');
  } finally { await env.cleanup(); }
});

test('GET /api/estimates filters by project, worker, state, date and message_id', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const get = async (q: string) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}/api/estimates${q}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const t0 = env.clock.now();
    const a = op(env, 'tell', { to: 'yoav', body: 'a', eta_min: 60, eta_kind: 'release', eta_what: 'א' });
    env.clock.advance(60 * MIN);
    op(env, 'status', { state: 'working', eta_min: 5, eta_kind: 'build', eta_what: 'ב' }, 'eli');
    env.clock.advance(MIN);
    assert.equal((await get('')).json.estimates.length, 2);
    assert.deepEqual((await get('?identity=eli')).json.estimates.map((x: any) => x.what), ['ב']);
    assert.deepEqual((await get('?project=agent-company')).json.estimates.map((x: any) => x.what), ['א']);
    assert.deepEqual((await get('?state=missed')).json.estimates.map((x: any) => x.what), ['א']);
    assert.deepEqual((await get('?state=open')).json.estimates.map((x: any) => x.what), ['ב']);
    assert.deepEqual((await get(`?message_id=${encodeURIComponent(a.id)}`)).json.estimates.map((x: any) => x.what), ['א']);
    assert.deepEqual((await get(`?since=${t0 + 30 * MIN}`)).json.estimates.map((x: any) => x.what), ['ב']);
    assert.deepEqual((await get(`?until=${new Date(t0 + 30 * MIN).toISOString()}`)).json.estimates.map((x: any) => x.what), ['א']);
    assert.equal((await get('?state=nope')).status, 400);
    assert.equal((await get('?kind=nope')).status, 400);
    assert.equal((await get('?since=x')).status, 400);
  } finally { await env.cleanup(); }
});

// ---- reminders (remind, driven by the scheduler's sweep) ----

const mail = (env: TestEnv, to: string) => env.hq.store.db.prepare(`SELECT id, body FROM messages WHERE to_identity = ? AND from_identity = 'hq' AND id LIKE 'estimate-%' ORDER BY id`).all(to) as { id: string; body: string }[];

test('reminder: one message at 20% left (clamped 2..10 minutes), not twice, and not for an estimate too short to have one', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 100, eta_kind: 'feature', eta_what: 'הפיצ\'ר' });
    op(env, 'status', { state: 'working', eta_min: 20, eta_kind: 'build', eta_what: 'בילד' });
    op(env, 'status', { state: 'working', eta_min: 1, eta_kind: 'build', eta_what: 'קצר' });
    await env.hq.scheduler.sweep();
    assert.deepEqual(mail(env, 'ac-ceo'), [], 'nothing before the time');
    env.clock.advance(85 * MIN); // 100 min: 20% = 20 → capped at 10; 15 left; the 20-minute one is past due, so no reminder for it
    await env.hq.scheduler.sweep();
    assert.equal(mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-remind')).length, 0, '15 min left of 100: not yet');
    env.clock.advance(5 * MIN);
    await env.hq.scheduler.sweep();
    const reminders = mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-remind'));
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!.body, /הבטחת לרן "הפיצ'ר" עד \d\d:\d\d\. נשארו 10 דקות\./);
    assert.match(reminders[0]!.body, /`eta_min`.*`eta_done`/);
    for (let i = 0; i < 3; i++) { env.clock.advance(MIN); await env.hq.scheduler.sweep(); }
    assert.equal(mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-remind')).length, 1, 'once per estimate');
  } finally { await env.cleanup(); }
});

test('reminder for a 20-minute estimate comes at 4 minutes left, a 5-minute one at the 2-minute floor', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 20, eta_kind: 'build', eta_what: 'בילד' });
    op(env, 'status', { state: 'working', eta_min: 5, eta_kind: 'build', eta_what: 'חמש' }, 'eli');
    env.clock.advance(15 * MIN);
    await env.hq.scheduler.sweep();
    assert.equal(mail(env, 'ac-ceo').length, 0, '5 left of 20: not yet');
    assert.match(mail(env, 'eli').find((m) => m.id.endsWith('-missed'))!.body, /עבר/, 'the 5-minute one is already past due');
    env.clock.advance(MIN);
    await env.hq.scheduler.sweep();
    assert.match(mail(env, 'ac-ceo')[0]!.body, /נשארו 4 דקות/);
  } finally { await env.cleanup(); }
});

test('an updated estimate resets the reminder: the new row is reminded on its own time', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'feature', eta_what: 'משימה' });
    env.clock.advance(25 * MIN);
    await env.hq.scheduler.sweep();
    assert.equal(mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-remind')).length, 1);
    op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'feature', eta_what: 'משימה' });
    await env.hq.scheduler.sweep();
    assert.equal(mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-remind')).length, 1, 'new estimate: not reminded yet');
    env.clock.advance(25 * MIN);
    await env.hq.scheduler.sweep();
    assert.equal(mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-remind')).length, 2);
    assert.equal(env.hq.estimates.list({ state: 'cancelled' }).length, 1, 'the superseded one is never reminded after');
  } finally { await env.cleanup(); }
});

test('a closed estimate is not reminded', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'feature', eta_what: 'משימה' });
    env.clock.advance(20 * MIN);
    op(env, 'status', { state: 'working', eta_done: true, eta_what: 'משימה' });
    env.clock.advance(20 * MIN);
    await env.hq.scheduler.sweep();
    assert.deepEqual(mail(env, 'ac-ceo'), []);
  } finally { await env.cleanup(); }
});

test('past due: missed, one more message to the worker, nothing to the owner, the manager only 10 minutes after the due time', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'build', eta_what: 'בילד' });
    env.clock.advance(11 * MIN);
    await env.hq.scheduler.sweep();
    assert.equal(env.hq.estimates.list()[0]!.state, 'missed');
    assert.equal(env.hq.estimates.list()[0]!.missed, true);
    const toWorker = mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-missed'));
    assert.equal(toWorker.length, 1);
    assert.match(toWorker[0]!.body, /היעד של "בילד".*עבר/);
    assert.deepEqual(mail(env, 'yoav').filter((m) => m.id.endsWith('-escalation')), [], 'the manager waits 10 minutes');
    assert.equal((env.hq.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE to_identity = 'owner' AND id LIKE 'estimate-%'`).get() as { n: number }).n, 0);
    env.clock.advance(9 * MIN);
    await env.hq.scheduler.sweep();
    const esc = mail(env, (env.hq.store.db.prepare(`SELECT reports_to r FROM identities WHERE id = 'ac-ceo'`).get() as { r: string }).r).filter((m) => m.id.endsWith('-escalation'));
    assert.equal(esc.length, 1);
    assert.match(esc[0]!.body, /ac-ceo.*"בילד".*עבר לפני 10 דקות/);
    for (let i = 0; i < 3; i++) { env.clock.advance(MIN); await env.hq.scheduler.sweep(); }
    assert.equal(mail(env, 'ac-ceo').filter((m) => m.id.endsWith('-missed')).length, 1, 'once');
  } finally { await env.cleanup(); }
});

test('an update before the manager is told: no escalation. A late close keeps missed and the real time', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'build', eta_what: 'בילד' });
    op(env, 'status', { state: 'working', eta_min: 10, eta_kind: 'build', eta_what: 'שני' });
    env.clock.advance(12 * MIN);
    await env.hq.scheduler.sweep();
    op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'build', eta_what: 'בילד' }); // new estimate in time
    op(env, 'status', { state: 'working', eta_done: true, eta_what: 'שני' }); // closes late
    env.clock.advance(10 * MIN);
    await env.hq.scheduler.sweep();
    assert.deepEqual(mail(env, 'yoav').filter((m) => m.id.endsWith('-escalation')), []);
    const late = env.hq.estimates.list({ missed: true }).find((x) => x.what === 'שני')!;
    assert.equal(late.state, 'done');
    assert.equal(late.missed, true);
    assert.equal(late.late, true);
    assert.equal(late.actual_min, 12);
    assert.equal(env.hq.estimates.list({ missed: true }).length, 2, 'the superseded one that was missed keeps it too');
  } finally { await env.cleanup(); }
});

test('survives a restart: the marks are in the table, a fresh Estimates sends nothing again and loses nothing', async () => {
  const env = await makeEnv();
  try {
    op(env, 'status', { state: 'working', eta_min: 30, eta_kind: 'feature', eta_what: 'משימה' });
    env.clock.advance(26 * MIN);
    await env.hq.scheduler.sweep();
    env.clock.advance(5 * MIN);
    await env.hq.scheduler.sweep();
    const before = mail(env, 'ac-ceo').length;
    assert.equal(before, 2, 'reminder + missed');
    const reopened = new Store(env.cfg.dbPath, { now: env.clock.now });
    try {
      const sent: string[] = [];
      const say = (_to: string, id: string) => { sent.push(id); };
      const again = new Estimates(reopened).remind(say, 'UTC', () => 'yoav');
      assert.deepEqual(sent, []);
      assert.deepEqual(again, { reminded: 0, missed: 0, escalated: 0 });
      // The escalation was not yet due, and it still comes after the restart, once.
      env.clock.advance(10 * MIN);
      new Estimates(reopened).remind(say, 'UTC', () => 'yoav');
      new Estimates(reopened).remind(say, 'UTC', () => 'yoav');
      assert.equal(sent.length, 1);
      assert.match(sent[0]!, /-escalation$/);
    } finally { reopened.db.close(); }
  } finally { await env.cleanup(); }
});

import { accuracyLine, yesterdayRange, type EstimateView } from '../src/estimates.ts';

const view = (id: number, o: Partial<EstimateView> & { est?: number; act?: number }): EstimateView => {
  const est = o.est ?? 30;
  const created_at = id * 1000;
  const closed = o.act != null ? created_at + o.act * MIN : null;
  return { id, identity: 'dana', shift: null, task: null, project: 'agent-company', kind: 'feature', what: `משהו ${id}`, message_id: null, created_at,
    due_at: created_at + est * MIN, closed_at: closed, outcome: closed ? 'done' : null, superseded_by: null, missed_at: null, reminded_at: null, missed_told_at: null, escalated_at: null, missed: false, state: closed ? 'done' : 'open',
    estimated_min: est, actual_min: o.act ?? null, late: closed != null && o.act! > est, ...o };
};

test('accuracyLine: nothing yesterday, no line; cancelled ones do not count', () => {
  assert.equal(accuracyLine([]), null);
  assert.equal(accuracyLine([view(1, { state: 'cancelled', outcome: 'cancelled' })]), null);
});

test('accuracyLine: all on time is one short line, no names, no per-kind breakdown', () => {
  const line = accuracyLine([view(1, { act: 10 }), view(2, { act: 30, kind: 'report' }), view(3, { act: 5, kind: 'build' })]);
  assert.equal(line, 'הערכות אתמול: 3, מתוכן 3 בזמן');
});

test('accuracyLine: late and unclosed are named with the worker and their words, in creation order; a kind only when it was off', () => {
  const line = accuracyLine([
    view(5, { identity: 'dana', what: 'תוכנית ל-TestFlight', est: 60, state: 'missed', kind: 'release' }),
    view(2, { identity: 'eli', what: 'שחרור 1.2.3', est: 50, act: 120, kind: 'release' }),
    view(1, { act: 10 }), view(3, { act: 20, kind: 'report' }), view(4, { act: 15, kind: 'build' }),
  ]);
  assert.equal(line, 'הערכות אתמול: 5, מתוכן 3 בזמן ו-1 באיחור (eli, "שחרור 1.2.3", פי 2.4) ו-1 שלא נסגרה (dana, "תוכנית ל-TestFlight")'
    + ' · חריגים לפי סוג: שחרורים 2 מתוך 2');
  assert.ok(!/%/.test(line));
});

test('yesterdayRange: the local calendar day before the one the summary is made in', () => {
  const end = Date.UTC(2026, 9, 21, 4, 30); // 07:30 in Jerusalem (UTC+3), 21 Oct
  const { since, until } = yesterdayRange(end, 'Asia/Jerusalem');
  assert.equal(new Date(until).toISOString(), '2026-10-20T21:00:00.000Z');
  assert.equal(new Date(since).toISOString(), '2026-10-19T21:00:00.000Z');
});

test('the morning summary carries the line, and has none when there were no estimates yesterday', async () => {
  const env = await makeEnv({ org: `${(await import('./helpers.ts')).ORG_YAML}timezone: UTC\n` });
  try {
    const { hq } = env;
    const ins = (what: string, created: number, due: number, closed: number | null, outcome: string | null) =>
      hq.store.db.prepare(`INSERT INTO estimates (identity, kind, what, created_at, due_at, closed_at, outcome) VALUES ('dana', 'feature', ?, ?, ?, ?, ?)`)
        .run(what, created, due, closed, outcome);
    const now = hq.store.now();
    const noon = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() - 1, 12);
    await hq.night.start();
    hq.store.db.prepare('UPDATE nights SET started_at = ? WHERE ended_at IS NULL').run(now - 2 * 60 * MIN);
    assert.equal(hq.night.summary(hq.night.last()!.id).estimates_line, null);
    assert.ok(!hq.night.summary(hq.night.last()!.id).text.includes('הערכות אתמול'));
    ins('א', noon, noon + 10 * MIN, noon + 5 * MIN, 'done');
    ins('ב', noon, noon + 10 * MIN, noon + 25 * MIN, 'done');
    const s = hq.night.summary(hq.night.last()!.id);
    assert.equal(s.estimates_line, 'הערכות אתמול: 2, מתוכן 1 בזמן ו-1 באיחור (dana, "ב", פי 2.5)');
    assert.equal(s.text.split('\n')[1], s.estimates_line, 'right under the header');
  } finally { await env.cleanup(); }
});

test('accuracyLine: several late and several unclosed come in creation order, kinds in the fixed kind order; an open one not yet due is left out', () => {
  // The register lists newest first, as the API does.
  const line = accuracyLine([
    view(9, { what: 'עוד פתוח', state: 'open' }),
    view(8, { identity: 'noa', what: 'ח', est: 10, state: 'missed', kind: 'release' }),
    view(7, { identity: 'eli', what: 'ז', est: 10, state: 'missed', kind: 'build' }),
    view(6, { identity: 'dana', what: 'ו', est: 10, act: 20, kind: 'release' }),
    view(5, { identity: 'eli', what: 'ה', est: 10, act: 30, kind: 'build' }),
  ]);
  assert.equal(line, 'הערכות אתמול: 4, מתוכן 0 בזמן ו-2 באיחור (eli, "ה", פי 3; dana, "ו", פי 2) ו-2 שלא נסגרה (eli, "ז"; noa, "ח")'
    + ' · חריגים לפי סוג: בילדים 2 מתוך 2, שחרורים 2 מתוך 2');
});
