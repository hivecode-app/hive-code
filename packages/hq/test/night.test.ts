import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, memForSlots, ORG_YAML, until, type TestEnv } from './helpers.ts';
import { parseNightTrigger, priorityOf, type Issue } from '../src/night.ts';

const CHARTER = (status = 'active') => `---\nproject: agent-company\nstatus: ${status}\nrepo: hivecode-app/hive-code\nnight_weight: 3\n---\n\n# x\n`;
const NO_SLOTS = { totalMb: 4096, availableMb: 1000 };

function issue(number: number, title: string, labels: string[] = []): Issue {
  return { number, title, body: `גוף ${number}`, labels, createdAt: new Date(Date.UTC(2026, 8, number)).toISOString() };
}

async function nightEnv(issues: Issue[], opts: { summary?: boolean; scheduler?: boolean } = {}) {
  const open = new Map(issues.map((i) => [i.number, i]));
  const calls: string[] = [];
  const env = await makeEnv({
    org: `${ORG_YAML}timezone: Asia/Jerusalem\n`,
    projects: { 'agent-company': CHARTER(), lumo: CHARTER('dormant').replace('agent-company', 'lumo') },
    deps: { issues: async (repo) => { calls.push(repo); return [...open.values()]; } },
  });
  env.hq.scheduler.memInfo = memForSlots(env.hq, 2);
  env.hq.store.setToggle('yoav/night-scheduler', opts.scheduler ?? true);
  env.hq.store.setToggle('yoav/morning-summary', opts.summary ?? true);
  return { env, open, calls };
}

const byRef = (env: TestEnv, n: number) => env.hq.store.db.prepare('SELECT * FROM tasks WHERE ref = ?').get(`hivecode-app/hive-code#${n}`) as
  { id: number; state: string; carried_over: number; identity: string } | undefined;

async function minute(env: TestEnv) {
  env.clock.advance(60_000);
  await env.hq.scheduler.sweep();
  await env.hq.night.sweep();
}

test('simulated night: one hour, 3 tasks on 2 slots, < 5% empty, correct morning summary', async () => {
  const { env, open } = await nightEnv([
    issue(1, 'עבודת לילה', ['company:night']), issue(2, 'באג p1', ['p1']), issue(3, 'רגיל'), issue(4, 'צריך החלטה', ['needs-decision', 'p0']),
  ]);
  try {
    const { hq } = env;
    hq.inbox.add({ kind: 'go', title: 'פריסת hq', from_identity: 'ac-ceo' });
    hq.mailbox.tell({ msg_id: 'n-1', to: 'yoav', body: 'לילה' });
    await until(() => byRef(env, 1)?.state === 'running' && byRef(env, 2)?.state === 'running', 3000, 'two night tasks running');
    assert.equal(hq.store.toggle('night'), true);
    assert.equal(byRef(env, 3)!.state, 'queued', 'two slots only');
    assert.equal(byRef(env, 4)!.state, 'queued');
    assert.deepEqual(hq.scheduler.queue().map((t) => t.id), [byRef(env, 3)!.id], 'needs-decision never enters the queue');

    for (let m = 1; m <= 60; m++) {
      await minute(env);
      const finish = async (n: number) => {
        hq.store.db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES (?, ?, 'status', ?, ?, 'ok')`)
          .run(`op-${n}`, byRef(env, n)!.identity, JSON.stringify({ state: 'done', note: `PR #${100 + n} מוזג` }), hq.store.now());
        await hq.scheduler.completeTask(byRef(env, n)!.id);
        open.delete(n);
      };
      if (m === 20) { await finish(1); await until(() => byRef(env, 3)!.state === 'running', 3000, 'slot refilled at once'); }
      if (m === 35) await finish(2);
      if (m === 50) await finish(3);
    }
    hq.mailbox.tell({ msg_id: 'n-2', to: 'yoav', body: 'בוקר טוב, מה קרה?' });
    assert.equal(hq.night.current(), undefined, 'his first message in the morning ends the night');
    assert.equal(hq.store.toggle('night'), false);

    const last = hq.night.last()!;
    assert.equal(last.end_reason, 'owner-morning');
    const s = JSON.parse(last.summary!) as ReturnType<typeof hq.night.summary>;
    assert.ok(s.empty.pct < 5, `empty ${s.empty.pct}%`);
    assert.equal(s.empty.minutes, 0);
    assert.equal(Math.round(s.minutes), 60);
    assert.deepEqual(s.done.map((p) => [p.project, p.tasks.map((t) => t.ref)]),
      [['agent-company', ['hivecode-app/hive-code#1', 'hivecode-app/hive-code#2', 'hivecode-app/hive-code#3']]]);
    assert.equal(s.done[0]!.tasks[0]!.note, 'PR #101 מוזג');
    assert.deepEqual(s.waiting.map((w) => [w.kind, w.title]), [['go', 'פריסת hq']]);
    assert.deepEqual(s.skipped.map((k) => [k.ref, k.why]), [['hivecode-app/hive-code#4', 'מחכה להחלטה (needs-decision)']]);

    const msg = hq.mailbox.get(`night-summary-${last.id}`)!;
    assert.equal(msg.to_identity, 'yoav');
    for (const part of ['מה נעשה (3)', 'PR #102 מוזג', 'מה מחכה לך (1)', 'בקשת אישור: פריסת hq', 'מה דולג ולמה (1)', 'needs-decision', '0 דקות (0% מהלילה']) {
      assert.ok(msg.body.includes(part), `summary has "${part}":\n${msg.body}`);
    }
  } finally { await env.cleanup(); }
});

test('empty slots are measured with their reason; no machine capacity is not a reason to look away', async () => {
  const { env } = await nightEnv([issue(1, 'א'), issue(2, 'ב'), issue(3, 'ג')]);
  try {
    const { hq } = env;
    hq.scheduler.memInfo = () => NO_SLOTS;
    await hq.night.start();
    for (let m = 0; m < 10; m++) await minute(env);
    hq.scheduler.memInfo = memForSlots(hq, 2);
    await minute(env);
    await until(() => byRef(env, 1)?.state === 'running' && byRef(env, 2)?.state === 'running');
    for (let m = 0; m < 9; m++) await minute(env);
    const s = hq.night.end('owner')!;
    assert.equal(s.empty.minutes, 11, '10 minutes without memory + the minute until the sweep saw it');
    assert.equal(s.empty.pct, 55);
    assert.deepEqual(s.empty.reasons.map((r) => r.reason), ['אין זיכרון פנוי במחשב']);
    assert.ok(s.text.includes('אין זיכרון פנוי במחשב: 11 דקות'));
    assert.ok(s.skipped.some((k) => k.ref === 'hivecode-app/hive-code#3' && k.why === 'לא הגיע תורו'));
  } finally { await env.cleanup(); }
});

test('leftovers: unstarted night issues wait for the next night and come back first, as bucket 2', async () => {
  const { env } = await nightEnv([issue(1, 'א'), issue(2, 'ב'), issue(3, 'ג', ['company:night'])]);
  try {
    const { hq } = env;
    hq.scheduler.memInfo = () => NO_SLOTS;
    await hq.night.start();
    hq.night.end('owner');
    for (const n of [1, 2, 3]) {
      assert.equal(byRef(env, n)!.state, 'night_wait', 'by day the queue is what the CEOs put in it');
      assert.equal(byRef(env, n)!.carried_over, 1);
    }
    assert.equal(hq.scheduler.queue().length, 0);
    await hq.night.start();
    const q = hq.scheduler.queue();
    assert.deepEqual(q.map((t) => t.bucket), [2, 2, 2]);
    assert.equal(q.length, 3);
  } finally { await env.cleanup(); }
});

test('switches: night-scheduler off pulls nothing from GitHub, morning-summary off sends nothing; the night toggle starts and ends', async () => {
  const { env, calls } = await nightEnv([issue(1, 'א')], { scheduler: false, summary: false });
  try {
    const { hq } = env;
    hq.store.setToggle('night', true);
    await until(() => !!hq.night.current(), 3000, 'night from the board switch');
    await minute(env);
    assert.deepEqual(calls, []);
    assert.equal(byRef(env, 1), undefined);
    hq.store.setToggle('night', false);
    assert.equal(hq.night.current(), undefined);
    const id = hq.night.last()!.id;
    assert.equal(hq.night.last()!.end_reason, 'toggle');
    assert.equal(hq.mailbox.get(`night-summary-${id}`), undefined);

    hq.store.setToggle('yoav/night-scheduler', true);
    await hq.night.start({ scope: ['lumo'] });
    assert.deepEqual(calls, [], 'scope "רק לומו": agent-company is out of scope (and lumo is dormant)');
    hq.night.end('owner');
    await hq.night.start();
    assert.deepEqual(calls, ['hivecode-app/hive-code'], 'only active projects with a repo');
  } finally { await env.cleanup(); }
});

test('a night with an hour set ends at that hour, not on his messages; the note reaches every task', async () => {
  const { env } = await nightEnv([issue(1, 'א')]);
  try {
    const { hq, clock } = env;
    await hq.night.start({ until: clock.now() + 30 * 60_000, note: 'בלי פריסות' });
    await until(() => byRef(env, 1)?.state === 'running');
    const prompt = hq.store.db.prepare(`SELECT body FROM messages WHERE id LIKE 'task-%'`).get() as { body: string };
    assert.ok(prompt.body.includes('הנחיית לילה של רן: בלי פריסות'));
    hq.mailbox.tell({ msg_id: 'u-1', to: 'yoav', body: 'עדכון באמצע הלילה' });
    assert.ok(hq.night.current(), 'an hour was set: his message does not end it');
    for (let m = 0; m < 30; m++) await minute(env);
    assert.equal(hq.night.current(), undefined);
    assert.equal(hq.night.last()!.end_reason, 'until');
  } finally { await env.cleanup(); }
});

test('parseNightTrigger and priorityOf', () => {
  const P = ['agent-company', 'lumo', 'voice-bot'];
  const IL = 'Asia/Jerusalem';
  const now = new Date(2026, 9, 20, 23, 0).getTime();
  assert.deepEqual(parseNightTrigger('לילה', P, now, IL), { scope: null, note: null, until: null });
  assert.deepEqual(parseNightTrigger('  לילה.  ', P, now, IL), { scope: null, note: null, until: null });
  assert.deepEqual(parseNightTrigger('לילה, רק לומו', P, now, IL), { scope: ['lumo'], note: null, until: null });
  assert.deepEqual(parseNightTrigger('לילה רק lumo ו-voice-bot', P, now, IL)?.scope, ['lumo', 'voice-bot']);
  assert.deepEqual(parseNightTrigger('לילה בלי פריסות', P, now, IL), { scope: null, note: 'בלי פריסות', until: null });
  const il23 = Date.UTC(2026, 9, 20, 20, 0); // 23:00 in Israel (IDT, UTC+3)
  assert.equal(parseNightTrigger('לילה עד 7', P, il23, IL)?.until, Date.UTC(2026, 9, 21, 4, 0), '07:00 Israel time, tomorrow');
  assert.deepEqual(parseNightTrigger('לילה, רק לומו בלי פריסות', P, now, IL), { scope: ['lumo'], note: 'בלי פריסות', until: null });
  assert.deepEqual(parseNightTrigger('לילה רק לומו עד 7', P, il23, IL), { scope: ['lumo'], note: null, until: Date.UTC(2026, 9, 21, 4, 0) });
  assert.deepEqual(parseNightTrigger('לילה רק לומו, voice-bot', P, now, IL)?.scope, ['lumo', 'voice-bot']);
  assert.deepEqual(parseNightTrigger('לילה רק דברים קטנים', P, now, IL), { scope: null, note: 'רק דברים קטנים', until: null });
  assert.equal(parseNightTrigger('לילה טוב', P, now, IL), null);
  assert.equal(parseNightTrigger('לילהלה', P, now, IL), null);
  assert.equal(parseNightTrigger('מה עם הלילה?', P, now, IL), null);
  assert.equal(priorityOf(['bug', 'p0']), 0);
  assert.equal(priorityOf(['priority:p3']), 3);
  assert.equal(priorityOf([]), 2);
});

test('morning: a message at night does not end it, the first one after 05:00 (Israel) does', async () => {
  const { env } = await nightEnv([]);
  try {
    const { hq, clock } = env;
    clock.t = Date.UTC(2026, 9, 20, 19, 0); // 22:00 in Israel
    hq.mailbox.tell({ msg_id: 'm-1', to: 'yoav', body: 'לילה' });
    await until(() => !!hq.night.current());
    clock.advance(60 * 60_000);
    hq.mailbox.tell({ msg_id: 'm-2', to: 'eli', body: 'תזכיר לי מחר את הביטוח' });
    assert.ok(hq.night.current(), '23:00 is not morning');
    hq.mailbox.tell({ msg_id: 'm-2b', to: 'eli', body: 'סוף סוף זה עובד' });
    assert.ok(hq.night.current(), '"סוף" alone is not "סוף לילה"');
    clock.t = Date.UTC(2026, 9, 21, 9, 30); // 12:30 next day: still his first message of the morning
    hq.mailbox.tell({ msg_id: 'm-3', to: 'yoav', body: 'מה המצב?' });
    assert.equal(hq.night.current(), undefined);
    assert.equal(hq.night.last()!.end_reason, 'owner-first-message');
  } finally { await env.cleanup(); }
});

test('a GitHub refresh that returns after the night ended queues nothing into the day', async () => {
  const { env } = await nightEnv([issue(1, 'א')]);
  try {
    const { hq } = env;
    hq.scheduler.memInfo = () => NO_SLOTS;
    await hq.night.start();
    hq.night.end('owner');
    assert.equal(byRef(env, 1)!.state, 'night_wait');
    await hq.night.start();
    let release!: () => void;
    hq.night.issues = async () => { await new Promise<void>((r) => { release = r; }); return [issue(1, 'א'), issue(9, 'חדש')]; };
    env.clock.advance(hq.night.refreshMs);
    await hq.night.sweep();
    await until(() => !!release, 1000, 'refresh in flight');
    hq.night.end('owner');
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(byRef(env, 1)!.state, 'night_wait');
    assert.equal(byRef(env, 9), undefined);
    assert.equal(hq.scheduler.queue().length, 0);
  } finally { await env.cleanup(); }
});

test('a scoped night leaves other projects\' leftovers parked, not in the day queue', async () => {
  const { env } = await nightEnv([issue(1, 'א')]);
  try {
    const { hq } = env;
    hq.scheduler.memInfo = () => NO_SLOTS;
    await hq.night.start();
    hq.night.end('owner');
    await hq.night.start({ scope: ['lumo'] });
    assert.equal(byRef(env, 1)!.state, 'night_wait', 'out of scope: stays parked');
    hq.night.end('owner');
    assert.equal(byRef(env, 1)!.state, 'night_wait');
    assert.equal(hq.scheduler.queue().length, 0);
  } finally { await env.cleanup(); }
});

test('memory short of a free slot counts as empty, with the memory reason', async () => {
  const { env } = await nightEnv([issue(1, 'א')]);
  try {
    const { hq } = env;
    hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 4096 + 100 }); // 2 slots exist, none can start
    await hq.night.start();
    for (let m = 0; m < 5; m++) await minute(env);
    const s = hq.night.end('owner')!;
    assert.equal(s.empty.minutes, 5);
    assert.deepEqual(s.empty.reasons.map((r) => r.reason), ['אין זיכרון פנוי במחשב']);
  } finally { await env.cleanup(); }
});
