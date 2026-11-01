import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { ABANDONED_MS, BEAT_LOST_MS, LeaseError, UNCLAIMED_MS } from '../src/leases.ts';
import { DEFAULT_HEAVY, parseDurationMs, parseHeavy, parseSizeMb, scopeProps } from '../src/heavy.ts';

const CHARTER = (heavy = '') => `---
project: agent-company
status: active
machine: hq-host
checkouts: []
${heavy}
---
`;

/** A machine with 10GB for leases; shifts `a`, `b` and `c` of three identities, each with its task (priority 2, `c`'s is p0). */
async function setup(heavy = '', memMb = 10_000) {
  const env = await makeEnv({
    noStart: true, projects: { 'agent-company': CHARTER(heavy) },
    cfg: { heavy: { classes: DEFAULT_HEAVY, budgetPct: 65, machines: { local: { memMb } } } },
  });
  await env.hq.start({ listen: false, timers: false });
  const db = env.hq.store.db;
  for (const [identity, shift, priority] of [['ac-ceo', 'a-1', 2], ['amit', 'b-1', 2], ['eli', 'c-1', 0]] as const) {
    const t = env.hq.scheduler.addTask({ title: `משימה ${identity}`, project: 'agent-company', priority });
    db.prepare(`UPDATE tasks SET identity = ?, state = 'running' WHERE id = ?`).run(identity, t.id);
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at) VALUES (?, ?, 1, 'live', ?)`).run(shift, identity, env.clock.now());
  }
  const as = (identity: string, shift: string) => (args: Record<string, unknown>) => env.hq.leases.request({ identity, shift, wait: 0, ...args }) as Promise<any>;
  const events = (type: string) => (db.prepare('SELECT data FROM events WHERE type = ?').all(type) as { data: string }[]).map((e) => JSON.parse(e.data));
  return { env, a: as('ac-ceo', 'a-1'), b: as('amit', 'b-1'), c: as('eli', 'c-1'), events, db };
}

test('heavy: sizes, durations and a class that is not whole', () => {
  assert.equal(parseSizeMb('8GB'), 8192);
  assert.equal(parseSizeMb('512MB'), 512);
  assert.equal(parseSizeMb('3g'), 3072);
  assert.equal(parseSizeMb('lots'), null);
  assert.equal(parseDurationMs('30m'), 1_800_000);
  assert.equal(parseDurationMs('90s'), 90_000);
  assert.equal(parseDurationMs(45), 2_700_000);
  const cs = parseHeavy([{ class: 'build', mem: '8GB', cpu: 4, timeout: '20m', env: { GRADLE_OPTS: '-x', bad: 'no' } }, { class: 'nomem' }, { mem: '1GB' }, { class: 'Bad Name', mem: '1GB' }]);
  assert.deepEqual(cs.map((c) => c.name), ['build']);
  assert.equal(cs[0]!.timeoutMs, 1_200_000);
  assert.deepEqual(cs[0]!.env, { GRADLE_OPTS: '-x' });
  assert.deepEqual(scopeProps({ memMb: 8192, cpu: 4 }), { memoryMax: '8192M', cpuWeight: 100 });
  const defaults = parseHeavy(DEFAULT_HEAVY);
  assert.equal(defaults.find((c) => c.name === 'build')!.env.GRADLE_OPTS, '-Dorg.gradle.daemon=false');
  assert.equal(defaults.find((c) => c.name === 'test-full')!.exclusive, 'flutter-test');
});

test('reserve: free place → granted, with the command to run; release gives it back', async () => {
  const { env, a, events } = await setup();
  try {
    const r = await a({ class: 'build', note: 'בונה APK' });
    assert.equal(r.status, 'granted');
    assert.match(r.lease, /^lease-\d+$/);
    assert.match(r.message, /company-run --lease lease-\d+ -- /);
    // the full path too, the same on every machine, for a shell that lost company-run from its PATH
    assert.match(r.message, /~\/projects\/agent-company\/scripts\/company-run/);
    assert.equal(env.hq.leases.list().length, 1);
    const rel = await a({ op: 'release', lease: r.lease });
    assert.equal(rel.status, 'released');
    assert.equal(env.hq.leases.list().length, 0);
    assert.equal(events('lease.released')[0].reason, 'released');
    assert.match((await a({ op: 'release', lease: r.lease })).message, /כבר הסתיימה/);
  } finally { await env.cleanup(); }
});

test('reserve: a class nobody defined is unavailable, and says how to add it; the charter defines and overrides', async () => {
  const { env, a } = await setup(`heavy:
  - class: ios-archive
    mem: 6GB
    cpu: 3
    timeout: 45m
  - class: smoke
    mem: 9GB`);
  try {
    const none = await a({ class: 'nope' });
    assert.equal(none.status, 'unavailable');
    assert.match(none.message, /heavy:/);
    assert.match(none.message, /build.*test-full|test-full.*build/);
    assert.equal(env.hq.leases.list().length, 0);

    const own = await a({ class: 'ios-archive' });
    assert.equal(own.status, 'granted');
    assert.equal(env.hq.leases.row(1)!.mem_mb, 6144);
    assert.equal(env.hq.leases.row(1)!.timeout_ms, 45 * 60_000);

    // The charter's `smoke` (9GB) replaced the company's (2GB): it does not fit next to 6GB.
    const smoke = await a({ class: 'smoke', wait: 0 });
    assert.equal(smoke.status, 'queued');
  } finally { await env.cleanup(); }
});

test('reserve: more than the machine can ever hold is unavailable, with another machine named when one is free', async () => {
  const { env, a } = await setup('', 6000);
  try {
    const r = await a({ class: 'build' }); // 8GB over a 6000MB budget
    assert.equal(r.status, 'unavailable');
    assert.match(r.message, /8192MB/);
    const bad = await a({ class: 'smoke', machine: 'mars' });
    assert.equal(bad.status, 'unavailable');
    assert.match(bad.message, /mars/);
  } finally { await env.cleanup(); }
});

test('reserve: no place → queued with the holder, the place in the queue and an estimate; the next call goes on from the same place', async () => {
  const { env, a, b } = await setup();
  try {
    const first = await a({ class: 'build', note: 'APK' });
    assert.equal(first.status, 'granted');
    env.clock.advance(5 * 60_000);
    const q = await b({ class: 'build', note: 'APK שלי' });
    assert.equal(q.status, 'queued');
    assert.equal(q.position, 1);
    assert.ok(q.eta_min >= 1);
    assert.match(q.holder, /משימה \d+ · agent-company · build · 5 דקות/);
    assert.match(q.message, new RegExp(`lease: "${q.lease}"`));
    // Asking again does not queue twice: it is the same lease, in the same place.
    const again = await b({ lease: q.lease });
    assert.equal(again.status, 'queued');
    assert.equal(again.lease, q.lease);
    assert.equal(env.hq.leases.list().length, 2);
    // The holder lets go: whoever waits is granted on its own, and the worker finds it so.
    await a({ op: 'release', lease: first.lease });
    assert.equal(env.hq.leases.row(Number(q.lease.slice(6)))!.state, 'granted');
    assert.equal((await b({ lease: q.lease })).status, 'granted');
  } finally { await env.cleanup(); }
});

test('reserve: a wait inside the call ends the moment the place frees', async () => {
  const { env, a, b } = await setup();
  try {
    const first = await a({ class: 'build' });
    const waiting = b({ class: 'build', wait: 5 });
    setTimeout(() => { void a({ op: 'release', lease: first.lease }); }, 150);
    const t0 = Date.now();
    const r = await waiting;
    assert.equal(r.status, 'granted');
    assert.ok(Date.now() - t0 < 3000);
  } finally { await env.cleanup(); }
});

test('reserve: the same exclusive key is one at a time, however much memory is free (the old flock)', async () => {
  const { env, a, b } = await setup('', 20_000);
  try {
    assert.equal((await a({ class: 'test-full' })).status, 'granted');
    const q = await b({ class: 'test-full' });
    assert.equal(q.status, 'queued');
    assert.match(q.holder, /test-full/);
    // Another class that does not share the key goes through.
    assert.equal((await b({ class: 'smoke' })).status, 'granted');
  } finally { await env.cleanup(); }
});

test('reserve: a p0 that waits is not overtaken, and a lease that is held is not stopped for it', async () => {
  const { env, a, b, c } = await setup(); // 10GB
  try {
    const held = await a({ class: 'build' }); // 8GB
    assert.equal(held.status, 'granted');
    const p0 = await c({ class: 'build' });
    assert.equal(p0.status, 'queued');
    // 2GB would fit beside the 8GB, but a p0 waits for a place: the newcomer stands behind it.
    const small = await b({ class: 'smoke' });
    assert.equal(small.status, 'queued');
    assert.equal(small.position, 2);
    assert.match(small.message, /p0/);
    // The p0 did not push the holder out.
    assert.equal(env.hq.leases.row(Number(held.lease.slice(6)))!.state, 'granted');
    // The holder ends: p0 first, the small one still waits (8GB + 2GB > 10GB? no: 8 + 2 = 10, so it follows at once).
    await a({ op: 'release', lease: held.lease });
    assert.equal(env.hq.leases.row(Number(p0.lease.slice(6)))!.state, 'granted');
    assert.equal(env.hq.leases.row(Number(small.lease.slice(6)))!.state, 'queued');
  } finally { await env.cleanup(); }
});

test('reserve: a queue is served in order of p0, then of the time each asked', async () => {
  const { env, a, b, c } = await setup('', 9000);
  try {
    const held = await a({ class: 'build' });
    const lateP0 = await (async () => { env.clock.advance(1000); return c({ class: 'build' }); })();
    const early = await b({ class: 'build' });
    assert.equal(early.position, 2);
    assert.equal(lateP0.position, 1);
    await a({ op: 'release', lease: held.lease });
    assert.equal(env.hq.leases.row(Number(lateP0.lease.slice(6)))!.state, 'granted');
    assert.equal(env.hq.leases.row(Number(early.lease.slice(6)))!.state, 'queued');
  } finally { await env.cleanup(); }
});

test('leases are theirs who made them', async () => {
  const { env, a, b } = await setup();
  try {
    const r = await a({ class: 'smoke' });
    await assert.rejects(b({ lease: r.lease }), (e: unknown) => e instanceof LeaseError && e.status === 404);
    await assert.rejects(b({ op: 'release', lease: r.lease }), (e: unknown) => e instanceof LeaseError && e.status === 404);
    await assert.rejects(env.hq.leases.request({ identity: 'ac-ceo', shift: 'b-1', class: 'smoke' }), (e: unknown) => e instanceof LeaseError && e.status === 403);
    await assert.rejects(a({ lease: 'seven' }), (e: unknown) => e instanceof LeaseError && e.status === 400);
  } finally { await env.cleanup(); }
});

test('company-run: attach gives the ceiling and the environment, finish releases with the exit code', async () => {
  const { env, a, events } = await setup();
  try {
    const r = await a({ class: 'build' });
    const plan = await env.hq.leases.request({ op: 'attach', lease: r.lease }) as any;
    assert.equal(plan.memoryMax, '8192M');
    assert.equal(plan.cpuWeight, 100);
    assert.equal(plan.env.GRADLE_OPTS, '-Dorg.gradle.daemon=false');
    assert.equal(plan.remainingMs, 30 * 60_000);
    const beat = await env.hq.leases.request({ op: 'beat', lease: r.lease }) as any;
    assert.equal(beat.state, 'granted');
    await env.hq.leases.request({ op: 'finish', lease: r.lease, exit_code: 3 });
    const e = events('lease.released')[0];
    assert.equal(e.reason, 'exited');
    assert.equal(e.exit_code, 3);
    assert.equal(((await env.hq.leases.request({ op: 'beat', lease: r.lease })) as any).state, 'released');
  } finally { await env.cleanup(); }
});

test('company-run: a lease that waits or ended is refused', async () => {
  const { env, a, b } = await setup();
  try {
    const held = await a({ class: 'build' });
    const q = await b({ class: 'build' });
    await assert.rejects(env.hq.leases.request({ op: 'attach', lease: q.lease }), (e: unknown) => e instanceof LeaseError && e.status === 409 && /בתור/.test(e.message));
    await a({ op: 'release', lease: held.lease });
    await assert.rejects(env.hq.leases.request({ op: 'attach', lease: held.lease }), (e: unknown) => e instanceof LeaseError && e.status === 409 && /הסתיימה/.test(e.message));
    await assert.rejects(env.hq.leases.request({ op: 'attach', lease: 'lease-999' }), (e: unknown) => e instanceof LeaseError && e.status === 404);
  } finally { await env.cleanup(); }
});

test('auto release: the ceiling of the class, with a message to the worker, and the next in the queue is served', async () => {
  const { env, a, b, db } = await setup();
  try {
    const held = await a({ class: 'build' });
    await env.hq.leases.request({ op: 'attach', lease: held.lease });
    const q = await b({ class: 'build' });
    env.clock.advance(29 * 60_000);
    await env.hq.leases.request({ op: 'beat', lease: held.lease });
    await b({ lease: q.lease }); // still asking
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(Number(held.lease.slice(6)))!.state, 'granted');
    env.clock.advance(2 * 60_000);
    await env.hq.leases.request({ op: 'beat', lease: held.lease });
    await b({ lease: q.lease });
    env.hq.leases.sweep();
    const row = env.hq.leases.row(Number(held.lease.slice(6)))!;
    assert.equal(row.state, 'released');
    assert.equal(row.release_reason, 'timeout');
    assert.equal(env.hq.leases.row(Number(q.lease.slice(6)))!.state, 'granted');
    const msg = db.prepare(`SELECT to_identity, body FROM messages WHERE id = ?`).get(`${held.lease}-timeout`) as { to_identity: string; body: string };
    assert.equal(msg.to_identity, 'ac-ceo');
    assert.match(msg.body, /30 דקות/);
    // company-run hears it with its next beat.
    const beat = await env.hq.leases.request({ op: 'beat', lease: held.lease }) as any;
    assert.deepEqual([beat.state, beat.reason], ['released', 'timeout']);
  } finally { await env.cleanup(); }
});

test('auto release: company-run that stops answering, a place nobody runs, and a queue nobody asks', async () => {
  const { env, a, b } = await setup('', 30_000);
  try {
    const running = await a({ class: 'smoke' });
    await env.hq.leases.request({ op: 'attach', lease: running.lease });
    const idle = await b({ class: 'smoke' });
    env.clock.advance(BEAT_LOST_MS - 1000);
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(1)!.state, 'granted');
    env.clock.advance(2000);
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(1)!.release_reason, 'connection-lost');
    assert.equal(env.hq.leases.row(Number(idle.lease.slice(6)))!.state, 'granted'); // not attached yet: still within its grace
    env.clock.advance(UNCLAIMED_MS);
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(Number(idle.lease.slice(6)))!.release_reason, 'unclaimed');

  } finally { await env.cleanup(); }
});

test('auto release: a queued lease nobody asks for goes after a while, and the one behind it moves up', async () => {
  const { env, a, b, c } = await setup('', 9000);
  try {
    const held = await a({ class: 'build' });
    await env.hq.leases.request({ op: 'attach', lease: held.lease });
    const gone = await b({ class: 'build' });
    const stays = await c({ class: 'build' }); // p0: ahead of `gone`
    env.clock.advance(ABANDONED_MS - 1000);
    await c({ lease: stays.lease }); // c keeps asking
    await env.hq.leases.request({ op: 'beat', lease: held.lease });
    env.clock.advance(2000);
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(Number(gone.lease.slice(6)))!.release_reason, 'abandoned');
    assert.equal(env.hq.leases.row(Number(stays.lease.slice(6)))!.state, 'queued');
    assert.equal(env.hq.leases.row(Number(held.lease.slice(6)))!.state, 'granted');
  } finally { await env.cleanup(); }
});

test('auto release: hq that restarts does not take the beats it could not hear as a lost connection', async () => {
  const { env, a } = await setup();
  try {
    const r = await a({ class: 'smoke' });
    await env.hq.leases.request({ op: 'attach', lease: r.lease });
    env.clock.advance(10 * 60_000); // hq was down, and with it every beat
    const { Leases } = await import('../src/leases.ts');
    (env.hq as any).leases = new Leases(env.hq); // the restart
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(1)!.state, 'granted');
  } finally { await env.cleanup(); }
});

test('auto release: a shift that ends gives up what it holds and what it waits for', async () => {
  const { env, a, b } = await setup();
  try {
    const held = await a({ class: 'build' });
    const q = await a({ class: 'docker', wait: 0 }); // 4GB beside 8GB of 10GB
    assert.equal(q.status, 'queued');
    const other = await b({ class: 'build' });
    env.hq.shifts.markEnded('a-1', 'ended', 'test');
    assert.equal(env.hq.leases.row(Number(held.lease.slice(6)))!.release_reason, 'shift-ended');
    assert.equal(env.hq.leases.row(Number(q.lease.slice(6)))!.release_reason, 'shift-ended');
    assert.equal(env.hq.leases.row(Number(other.lease.slice(6)))!.state, 'granted');
  } finally { await env.cleanup(); }
});

test('auto release: a lease whose shift is gone is released by the sweep too', async () => {
  const { env, a, db } = await setup();
  try {
    const r = await a({ class: 'smoke' });
    db.prepare(`UPDATE shifts SET state = 'dead' WHERE id = 'a-1'`).run();
    env.hq.leases.sweep();
    assert.equal(env.hq.leases.row(Number(r.lease.slice(6)))!.release_reason, 'shift-ended');
  } finally { await env.cleanup(); }
});

test('reserve: a retry of the same request is the same lease, not another place in the queue', async () => {
  const { env, a, b } = await setup();
  try {
    const held = await a({ class: 'build' });
    const again = await a({ class: 'build' }); // the reply was lost: a granted lease nobody ran under is handed back
    assert.equal(again.lease, held.lease);
    const q = await b({ class: 'build' });
    const retry = await b({ class: 'build' });
    assert.equal(retry.lease, q.lease);
    assert.equal(env.hq.leases.list().length, 2);
    // Once a command runs under the first, a new request of the same class is a new lease.
    await env.hq.leases.request({ op: 'attach', lease: held.lease });
    assert.notEqual((await a({ class: 'build' })).lease, held.lease);
  } finally { await env.cleanup(); }
});

test('reserve: a lease granted from the queue is told to the worker who is no longer waiting for it', async () => {
  const { env, a, b, db } = await setup();
  try {
    const held = await a({ class: 'build' });
    const q = await b({ class: 'build' });
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM messages WHERE id = ?`).get(`${q.lease}-granted`) as { n: number }).n, 0);
    await a({ op: 'release', lease: held.lease }); // b is not inside a call
    const msg = db.prepare(`SELECT to_identity, body FROM messages WHERE id = ?`).get(`${q.lease}-granted`) as { to_identity: string; body: string };
    assert.equal(msg.to_identity, 'amit');
    assert.match(msg.body, /company-run --lease lease-\d+/);
    assert.match(msg.body, /~\/projects\/agent-company\/scripts\/company-run/);
    // One granted at once, inside its own call, is not told twice.
    const c2 = await a({ class: 'smoke' });
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM messages WHERE id = ?`).get(`${c2.lease}-granted`) as { n: number }).n, 0);
  } finally { await env.cleanup(); }
});

test('company-run: a lease of another identity is not found', async () => {
  const { env, a } = await setup();
  try {
    const r = await a({ class: 'build' });
    for (const op of ['attach', 'beat', 'finish']) {
      await assert.rejects(env.hq.leases.request({ op, lease: r.lease, identity: 'amit' }), (e: unknown) => e instanceof LeaseError && e.status === 404, op);
    }
    assert.equal(((await env.hq.leases.request({ op: 'attach', lease: r.lease, identity: 'ac-ceo' })) as any).class, 'build');
  } finally { await env.cleanup(); }
});
