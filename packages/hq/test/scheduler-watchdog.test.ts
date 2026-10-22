import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { capacity } from '../src/scheduler.ts';
import { bgTasks } from '../src/shifts.ts';
import { loadConfig } from '../src/config.ts';
import { join } from 'node:path';

/** The memory a running task shift takes out of what is free (the fake memInfo of a test does not move by itself). */
const taskShifts = (hq: { store: { db: { prepare(sql: string): { get(): unknown } } } }) =>
  (hq.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND task_id IS NOT NULL`).get() as { n: number }).n;

test('capacity formula: floor((MemAvailable − reserve − leases held) / RSS_work), capped by maxSlots − running', () => {
  const cfg = loadConfig({ stateDir: '/nonexistent', capacity: { reserveMb: 4096, rssIdleMb: 400, rssWorkMb: 1300, residents: ['yoav'], maxSlots: 8, maxLoad: 1.5 } });
  assert.deepEqual(capacity(cfg, { totalMb: 23_552, availableMb: 14_000 }, 0), { total: 7, running: 0, free: 7 });
  assert.deepEqual(capacity(cfg, { totalMb: 23_552, availableMb: 14_000 }, 6), { total: 8, running: 6, free: 2 }, 'maxSlots − running');
  assert.equal(capacity(cfg, { totalMb: 23_552, availableMb: 5_000 }, 0).free, 0);
  assert.deepEqual(capacity(cfg, { totalMb: 23_552, availableMb: 5_000 }, 3), { total: 3, running: 3, free: 0 }, 'no room: total is what runs');
  assert.equal(capacity(cfg, { totalMb: 64_000, availableMb: 60_000 }, 0).total, 8, 'maxSlots cap');
  // Held leases count as consumption: 14000 − 4096 − 4000 = 5904 → 4 slots.
  assert.equal(capacity(cfg, { totalMb: 23_552, availableMb: 14_000 }, 0, 4_000).free, 4);
});

test('capacity today: 13 leads alive and 14.8G available gives more than 5 slots', () => {
  const cfg = loadConfig({ stateDir: '/nonexistent' });
  // Before: floor((RAM − 4096 − 13 × 450) / 2500) was 5–6 whatever was free. Now the free memory decides.
  const c = capacity(cfg, { totalMb: 23_552, availableMb: 14_800 }, 0);
  assert.ok(c.free > 5, `free=${c.free}`);
  assert.equal(c.free, Math.min(cfg.capacity.maxSlots, Math.floor((14_800 - cfg.capacity.reserveMb) / cfg.capacity.rssWorkMb)));
});

test('queue follows B.16 order (priority first) and skips needs-decision', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.store.setToggle('scheduler', false);
    const s = hq.scheduler;
    const d = s.addTask({ title: 'default p1', priority: 1 }); clock.advance(1);
    const n = s.addTask({ title: 'night p2', labels: ['company:night'], priority: 2 }); clock.advance(1);
    const left = s.addTask({ title: 'leftover' }); clock.advance(1);
    hq.store.db.prepare('UPDATE tasks SET carried_over = 1 WHERE id = ?').run(left.id);
    const open = s.addTask({ title: 'interrupted with worktree', state: 'interrupted', worktree: '/w/t1' }); clock.advance(1);
    s.addTask({ title: 'open without worktree', state: 'open' });
    s.addTask({ title: 'needs decision', labels: ['needs-decision'], priority: 0 });
    const d0 = s.addTask({ title: 'default p0', priority: 0 });
    assert.deepEqual(s.queue().map((t) => t.id), [d0.id, d.id, open.id, left.id, n.id]);
  } finally { await env.cleanup(); }
});

test('queue: a queued p0 goes before a p2 that came back interrupted; within one priority interrupted goes before queued', async () => {
  const env = await makeEnv();
  try {
    const s = env.hq.scheduler;
    env.hq.store.setToggle('scheduler', false);
    const q1 = s.addTask({ title: 'p1 חדשה', priority: 1 }); env.clock.advance(1);
    const i2 = s.addTask({ title: 'p2 שחזרה', priority: 2, state: 'interrupted', worktree: '/w/i2' }); env.clock.advance(1);
    const i1 = s.addTask({ title: 'p1 שחזרה', priority: 1, state: 'interrupted', worktree: '/w/i1' }); env.clock.advance(1);
    const p0 = s.addTask({ title: 'p0 חדשה', priority: 0 });
    assert.deepEqual(s.queue().map((t) => t.id), [p0.id, i1.id, q1.id, i2.id]);
  } finally { await env.cleanup(); }
});

test('scheduler fills free slots immediately with task workers under the project CEO', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.scheduler.memInfo = () => ({ totalMb: 4096 + 450 + 2 * 1300 + 100, availableMb: 4096 + 2 * 1300 + 100 }); // 2 slots
    const t1 = hq.scheduler.addTask({ title: 'תקן את ה-CI', project: 'agent-company' });
    const t2 = hq.scheduler.addTask({ title: 'שני', project: 'agent-company' });
    const t3 = hq.scheduler.addTask({ title: 'שלישי', project: 'agent-company' });
    await until(() => hq.scheduler.task(t1.id)!.state === 'running' && hq.scheduler.task(t2.id)!.state === 'running', 3000, 'two running');
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 2, 'no third slot');
    assert.equal(hq.scheduler.task(t1.id)!.state, 'running');
    assert.equal(hq.scheduler.task(t3.id)!.state, 'queued');
    const ident = hq.store.db.prepare('SELECT * FROM identities WHERE id = ?').get(`agent-company-t${t1.id}`) as { reports_to: string; lifecycle: string; name: string; title: string };
    assert.equal(ident.reports_to, 'ac-ceo');
    assert.match(ident.name, /^[\u05D0-\u05EA]+$/, 'a human Hebrew name, not t<N> (#51)');
    assert.match(ident.title, /^מפתח/);
    const other = hq.store.db.prepare('SELECT name FROM identities WHERE id = ?').get(`agent-company-t${t2.id}`) as { name: string };
    assert.notEqual(other.name, ident.name);
    assert.equal(ident.lifecycle, 'ephemeral');
    const promptOf = (id: number) => hq.store.db.prepare(`SELECT state FROM messages WHERE id LIKE ?`).get(`task-${id}-agent-company-t${id}-1-%`) as { state: string } | undefined;
    await until(() => promptOf(t1.id)?.state === 'delivered', 3000, 'task prompt');

    // A slot frees → the next task starts without waiting for the sweep.
    await hq.shifts.stop(`agent-company-t${t2.id}-1`, 'task_done');
    await until(() => hq.scheduler.task(t3.id)!.state === 'running', 3000, 'third task starts on slot free');
    assert.equal(launcher.launches.length, 3);
    assert.equal(hq.scheduler.task(t2.id)!.state, 'done');
    assert.equal(hq.scheduler.task(t3.id)!.state, 'running');
  } finally { await env.cleanup(); }
});

test('watchdog: one failed signal is suspect, two are dead; dead shift with mail is resurrected (resume)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'w-1', to: 'eli', body: 'שלום' });
    await until(() => hq.mailbox.get('w-1')!.state === 'delivered');
    let alive = true;
    hq.watchdog.procCheck = () => (alive ? hq.shifts.get('eli-1')!.proc_start : null);
    assert.equal((await hq.watchdog.sweep())['eli-1'], 'progressing');

    alive = false;
    assert.equal((await hq.watchdog.sweep())['eli-1'], 'suspect', 'pid gone but host answers: not proof of death');
    hq.mailbox.tell({ msg_id: 'w-2', to: 'eli', body: 'עוד אחת' });
    await launcher.hosts.get('eli-1')!.close(); // now the host is unreachable too
    launcher.mode = 'echo';
    const r = await hq.watchdog.sweep();
    assert.equal(r['eli-1'], 'dead');
    assert.equal(launcher.launches.length, 2);
    assert.equal(launcher.launches[1]!.resume, true);
  } finally { await env.cleanup(); }
});

test('watchdog: stuck in a turn → nudge → interrupt → new shift', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    hq.mailbox.tell({ msg_id: 's-1', to: 'eli', body: 'משימה ארוכה' });
    await until(() => hq.mailbox.get('s-1')!.state === 'delivered');
    hq.watchdog.procCheck = () => hq.shifts.get('eli-1')!.proc_start;
    launcher.hosts.get('eli-1')!.event({ kind: 'text', text: 'מתחיל' });
    await until(() => hq.shifts.get('eli-1')!.in_turn === 1);

    clock.advance(10 * 60_000 + 1);
    await hq.shifts.pingAll(); // claude still answers pings: alive but not progressing
    assert.equal((await hq.watchdog.sweep())['eli-1'], 'stuck');
    const nudge = hq.store.db.prepare(`SELECT * FROM messages WHERE to_identity = 'eli' AND id LIKE 'nudge-%'`).get() as { priority: string } | undefined;
    assert.equal(nudge?.priority, 'now');

    clock.advance(5 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.ok(hq.shifts.get('eli-1')!.interrupted_at);
    assert.ok(launcher.hosts.get('eli-1')!.received.some((f) => f.t === 'interrupt'));

    clock.advance(5 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    await until(() => launcher.launches.some((l) => l.shiftId === 'eli-2'), 3000, 'new shift');
    assert.equal(launcher.launches.at(-1)!.resume, false);
  } finally { await env.cleanup(); }
});

test('watchdog rests an idle non-resident shift after 20 min; residents stay', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.tell({ msg_id: 'r-1', to: 'eli', body: 'א' });
    hq.mailbox.tell({ msg_id: 'r-2', to: 'yoav', body: 'ב' });
    await until(() => hq.mailbox.get('r-1')!.state === 'delivered' && hq.mailbox.get('r-2')!.state === 'delivered');
    hq.mailbox.markHandled('r-1'); hq.mailbox.markHandled('r-2');
    hq.watchdog.procCheck = (pid) => hq.store.db.prepare('SELECT proc_start FROM shifts WHERE pid = ? LIMIT 1').pluck().get(pid) as string;
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get('eli-1')!.state, 'ended');
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');
    assert.equal(hq.shifts.get('yoav-1')!.state, 'live');
    const eli = hq.board().find((b) => b.id === 'eli')!;
    assert.equal(eli.status, 'resting');
    assert.equal(eli.status_symbol, 'bedtime');
  } finally { await env.cleanup(); }
});

test('liveness (bet 4): claude not answering pings → warning "לא עונה" on the board, then interrupt → fresh process', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    hq.mailbox.tell({ msg_id: 'l-1', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('l-1')!.state === 'delivered');
    hq.watchdog.procCheck = () => hq.shifts.get('eli-1')!.proc_start;
    await hq.shifts.pingAll();
    let eli = hq.board().find((b) => b.id === 'eli')!;
    assert.notEqual(eli.blocked_on, 'לא עונה');
    assert.ok(eli.last_seen_at && eli.derived_at >= eli.last_seen_at, 'freshness stamp');

    clock.advance(16_000); // > 3 × 5s without a ping answer
    eli = hq.board().find((b) => b.id === 'eli')!;
    assert.equal(eli.status, 'stuck');
    assert.equal(eli.blocked_on, 'לא עונה');

    clock.advance(2 * 60_000);
    assert.equal((await hq.watchdog.sweep())['eli-1'], 'stuck');
    assert.ok(launcher.hosts.get('eli-1')!.received.some((f) => f.t === 'interrupt'));
    clock.advance(61_000);
    await hq.watchdog.sweep();
    await until(() => launcher.launches.length === 2, 3000, 'relaunch');
    assert.equal(launcher.launches[1]!.resume, true, 'same session, fresh process');
  } finally { await env.cleanup(); }
});

test('reboot: shifts the store believed live but whose host and pid are gone are relaunched (bet 3)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    const ins = hq.store.db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, kind, pid, proc_start, socket_path, task_id, started_at)
      VALUES (?, ?, ?, 'live', ?, 999999, 'x', ?, ?, ?)`);
    // these shifts ran before the reboot (they have log frames)
    ins.run('yoav-3', 'yoav', 3, 'resident', join(env.cfg.stateDir, 'shifts', 'yoav-3.sock'), null, clock.t);
    ins.run('agent-company-t9-1', 'ac-ceo', 1, 'work', join(env.cfg.stateDir, 'shifts', 'agent-company-t9-1.sock'), 9, clock.t);
    hq.store.db.prepare(`UPDATE shifts SET host_seq = 7, run_start_seq = 1`).run();
    const restored = await hq.shifts.restoreLost(() => null);
    assert.deepEqual(restored, ['yoav']);
    assert.equal(hq.shifts.get('agent-company-t9-1')!.state, 'dead', 'task shift: left to the scheduler');
    assert.equal(launcher.launches[0]!.shiftId, 'yoav-3');
    assert.equal(launcher.launches[0]!.resume, true);
  } finally { await env.cleanup(); }
});

test('residents are kept up by the scheduler sweep (B.2: יואב always runs)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    await hq.scheduler.sweep();
    await until(() => hq.shifts.get('yoav-1')?.state === 'live', 3000, 'yoav up');
    assert.equal(hq.shifts.get('yoav-1')!.kind, 'resident');
    await hq.scheduler.sweep();
    assert.equal(launcher.launches.filter((l) => l.identity === 'yoav').length, 1, 'once');
    assert.equal(hq.scheduler.slots().running, 0, 'residents do not take work slots');
  } finally { await env.cleanup(); }
});

test('a failing launch does not spin the scheduler (backoff per task)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.fail = true;
    hq.store.setToggle('scheduler', false);
    hq.scheduler.addTask({ title: 'א', project: 'agent-company' });
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(launcher.launches.length, 1, 'one attempt, no refill storm');
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 1, 'backoff window');
    clock.advance(61_000);
    launcher.fail = false;
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 2);
  } finally { await env.cleanup(); }
});

test('task lifecycle: rest parks the task (no restart loop), a message wakes it, status{done} closes it', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    const t = hq.scheduler.addTask({ title: 'טיקט', project: 'agent-company' });
    const sid = `agent-company-t${t.id}-1`;
    await until(() => hq.shifts.get(sid)?.state === 'live', 3000, 'task shift live');
    hq.watchdog.procCheck = () => hq.shifts.get(sid)!.proc_start;
    hq.store.db.prepare(`UPDATE messages SET state = 'handled' WHERE to_identity = ?`).run(`agent-company-t${t.id}`);
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get(sid)!.end_reason, 'rest');
    assert.equal(hq.scheduler.task(t.id)!.state, 'resting');
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 1, 'not restarted by the scheduler');

    hq.mailbox.tell({ msg_id: 'wake-1', from: 'ac-ceo', to: `agent-company-t${t.id}`, body: 'יש review' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'woken by mail');
    assert.equal(launcher.launches[1]!.resume, true);
    assert.equal(hq.shifts.get(sid)!.task_id, t.id);

    hq.ingest.op({ id: `${sid}:done`, v: 1, ts: '', identity: `agent-company-t${t.id}`, shift: sid, sessionId: null, op: 'status', args: { state: 'done' } });
    await until(() => hq.scheduler.task(t.id)!.state === 'done', 3000, 'done');
    await until(() => hq.shifts.get(sid)!.state === 'ended', 3000, 'shift ended');
    assert.equal(hq.shifts.get(sid)!.end_reason, 'task_done');
    assert.equal(hq.board().find((b) => b.id === `agent-company-t${t.id}`)!.status, 'done');
  } finally { await env.cleanup(); }
});

test('a lead added to org.yaml wakes once after hq loads, told to write to ran (#68)', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    // eli already ran once: only leads that never had a shift are new.
    await hq.shifts.request('eli', { reason: 'manual' });
    await until(() => hq.shifts.get('eli-1')?.state === 'live', 3000, 'eli up');
    const woke = hq.scheduler.wakeNewLeads();
    assert.deepEqual(woke.sort(), ['ac-ceo', 'rotem'], 'leads only, never-run only (not yoav the resident, not amit)');
    await until(() => !!hq.shifts.get('ac-ceo-1') && !!hq.shifts.get('rotem-1'), 3000, 'leads up');
    const m = hq.mailbox.get('hq-lead-up-ac-ceo')!;
    assert.equal(m.from_identity, 'hq');
    assert.equal(m.kind, 'system');
    assert.match(m.body, /tell/);
    assert.match(m.body, /owner/);
    assert.equal((hq.store.db.prepare(`SELECT json_extract(data, '$.reason') r FROM events WHERE type = 'shift.state' AND identity = 'ac-ceo'
      ORDER BY seq LIMIT 1`).get() as { r: string }).r, 'message');
    // Once: a second load (restart) wakes nobody again, also after the lead's shift ended.
    await hq.shifts.stop(hq.shifts.get('ac-ceo-1')!.id, 'rest');
    assert.deepEqual(hq.scheduler.wakeNewLeads(), []);
    assert.equal(launcher.launches.filter((l) => l.identity === 'ac-ceo').length, 1);
  } finally { await env.cleanup(); }
});

test('hq start (with its loops) wakes a never-run lead by itself (#68)', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: false });
    await until(() => !!env.hq.shifts.get('ac-ceo-1'), 3000, 'ac-ceo woken by start');
    assert.ok(env.hq.mailbox.get('hq-lead-up-ac-ceo'));
  } finally { await env.cleanup(); }
});

test('#128: idle leads hold no work slot; with a task waiting they rest after 5 min, yoav stays, a message wakes them', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock, launcher } = env;
    // 2 work slots with yoav and two idle leads on the RSS_idle line.
    hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 4096 + 2 * 1300 + 100 - 1300 * taskShifts(hq) });
    hq.store.setToggle('scheduler', false);
    await hq.scheduler.ensureResidents();
    for (const [id, to] of [['l-1', 'eli'], ['l-2', 'ac-ceo']]) hq.mailbox.tell({ msg_id: id, to, body: 'שלום' });
    await until(() => ['l-1', 'l-2'].every((m) => hq.mailbox.get(m)!.state === 'delivered'), 3000, 'leads up');
    hq.mailbox.markHandled('l-1'); hq.mailbox.markHandled('l-2');
    await until(() => !hq.shifts.get('eli-1')!.in_turn && !hq.shifts.get('ac-ceo-1')!.in_turn && hq.shifts.get('yoav-1')?.state === 'live', 3000, 'idle');
    assert.deepEqual(hq.scheduler.slots(), { total: 2, running: 0, free: 2, pressure: null, load: 0.06, availableMb: 6796, tasks: 0, leads: { active: 0, idle: 2, resting: 0 } });

    hq.store.setToggle('scheduler', true);
    const t1 = hq.scheduler.addTask({ title: 'א', project: 'agent-company' });
    const t2 = hq.scheduler.addTask({ title: 'ב', project: 'agent-company' });
    const t3 = hq.scheduler.addTask({ title: 'ג', project: 'agent-company' });
    await until(() => hq.scheduler.task(t1.id)!.state === 'running' && hq.scheduler.task(t2.id)!.state === 'running', 3000, 'queue fills past idle leads');
    assert.equal(hq.scheduler.task(t3.id)!.state, 'queued');

    // Idle under 5 min: nobody rests yet.
    clock.advance(4 * 60_000);
    assert.deepEqual(await hq.scheduler.restOnPressure(), []);
    clock.advance(2 * 60_000);
    // A lead with a message waiting, or one in a turn, is never rested.
    hq.mailbox.tell({ msg_id: 'l-w', to: 'ac-ceo', body: 'רגע' });
    await until(() => hq.mailbox.get('l-w')!.state === 'delivered', 3000, 'ac-ceo has mail');
    hq.shifts.setFields('eli-1', { in_turn: 1 });
    assert.deepEqual(await hq.scheduler.restOnPressure(), []);
    hq.mailbox.markHandled('l-w');
    hq.shifts.setFields('eli-1', { in_turn: 0 });
    for (const id of ['eli-1', 'ac-ceo-1']) hq.shifts.setFields(id, { last_event_at: hq.store.now() - 6 * 60_000 });
    assert.deepEqual((await hq.scheduler.restOnPressure()).sort(), ['ac-ceo-1', 'eli-1']);
    assert.equal(hq.shifts.get('eli-1')!.end_reason, 'rest');
    assert.equal(hq.shifts.get('yoav-1')!.state, 'live', 'the resident never rests');
    assert.equal(hq.board().find((b) => b.id === 'eli')!.status, 'resting');
    assert.deepEqual(hq.scheduler.slots().leads, { active: 0, idle: 0, resting: 2 });

    // A message wakes a rested lead on its own session, as always.
    const before = launcher.launches.filter((l) => l.identity === 'eli').length;
    hq.mailbox.tell({ msg_id: 'l-3', to: 'eli', body: 'עוד משהו' });
    await until(() => hq.mailbox.get('l-3')!.state === 'delivered', 3000, 'eli woken');
    const wake = launcher.launches.filter((l) => l.identity === 'eli');
    assert.equal(wake.length, before + 1);
    assert.equal(wake.at(-1)!.resume, true, 'session kept');
  } finally { await env.cleanup(); }
});

test('#128: a message left delivered by an earlier shift does not keep an idle standing worker up', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 4096 + 2 * 1300 + 100 - 1300 * taskShifts(hq) });
    hq.store.setToggle('scheduler', false);
    await hq.scheduler.ensureResidents();
    for (const [id, to] of [['o-1', 'eli'], ['o-2', 'ac-ceo']]) hq.mailbox.tell({ msg_id: id, to, body: 'שלום' });
    await until(() => ['o-1', 'o-2'].every((m) => hq.mailbox.get(m)!.state === 'delivered'), 3000, 'leads up');
    await until(() => !hq.shifts.get('eli-1')!.in_turn && !hq.shifts.get('ac-ceo-1')!.in_turn && hq.shifts.get('yoav-1')?.state === 'live', 3000, 'idle');
    // eli's message was taken by a shift that closed before it saw it: delivered, from another shift.
    hq.store.db.prepare(`UPDATE messages SET shift_id = 'eli-0' WHERE id = 'o-1'`).run();
    hq.mailbox.markHandled('o-2');
    hq.store.setToggle('scheduler', true);
    for (const n of ['א', 'ב', 'ג']) hq.scheduler.addTask({ title: n, project: 'agent-company' });
    await until(() => hq.scheduler.queue().length > 0 && hq.scheduler.slots().free === 0, 3000, 'queue waits for a slot');
    clock.advance(10 * 60_000);
    for (const id of ['eli-1', 'ac-ceo-1']) hq.shifts.setFields(id, { last_event_at: hq.store.now() - 6 * 60_000 });
    assert.deepEqual((await hq.scheduler.restOnPressure()).sort(), ['ac-ceo-1', 'eli-1']);
  } finally { await env.cleanup(); }
});

test('#128: no pressure (empty queue) → idle leads stay up; a lead in a turn holds a slot', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 4096 + 2 * 1300 + 100 - 1300 * taskShifts(hq) });
    hq.mailbox.tell({ msg_id: 'n-1', to: 'eli', body: 'שלום' });
    await until(() => hq.mailbox.get('n-1')!.state === 'delivered', 3000, 'eli up');
    hq.shifts.setFields('eli-1', { in_turn: 1 });
    assert.deepEqual(hq.scheduler.slots().leads, { active: 1, idle: 0, resting: 0 });
    assert.equal(hq.scheduler.slots().running, 1, 'in a turn it holds a slot');
    hq.mailbox.markHandled('n-1');
    hq.shifts.setFields('eli-1', { in_turn: 0 });
    clock.advance(30 * 60_000);
    assert.deepEqual(await hq.scheduler.restOnPressure(), [], 'empty queue');
    assert.equal(hq.shifts.get('eli-1')!.state, 'live');

    // Stopped by hand (systemctl stop): down, counted as resting, not as a slot.
    hq.shifts.markEnded('eli-1', 'dead', 'crash: process gone');
    assert.deepEqual(hq.scheduler.slots().leads, { active: 0, idle: 0, resting: 1 });
    assert.equal(hq.scheduler.slots().running, 0);
  } finally { await env.cleanup(); }
});

test('#175: bgTasks follows the CLI background work: the full list, a backgrounded start, its end', () => {
  assert.deepEqual(bgTasks([], 'background_tasks_changed', { tasks: [{ task_id: 'a' }, { task_id: 'b' }] }), ['a', 'b']);
  assert.deepEqual(bgTasks(['a'], 'background_tasks_changed', { tasks: [] }), []);
  assert.deepEqual(bgTasks([], 'task_started', { task_id: 'a', is_backgrounded: true }), ['a']);
  assert.equal(bgTasks([], 'task_started', { task_id: 'f', is_backgrounded: false }), null, 'a foreground Bash is the turn itself');
  assert.deepEqual(bgTasks(['a', 'b'], 'task_notification', { task_id: 'a', status: 'completed' }), ['b']);
  assert.deepEqual(bgTasks(['a'], 'task_updated', { task_id: 'a', patch: { status: 'killed' } }), []);
  assert.equal(bgTasks(['a'], 'task_updated', { task_id: 'a', patch: { description: 'x' } }), null);
  assert.equal(bgTasks(['a'], 'task_progress', { task_id: 'a' }), null);
});

test('#175: a task shift waiting on its background work does not rest; it does once the work ends', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    const t = hq.scheduler.addTask({ title: 'מחכה ל-CI', project: 'agent-company' });
    const sid = `agent-company-t${t.id}-1`;
    await until(() => hq.shifts.get(sid)?.state === 'live', 3000, 'task shift live');
    hq.watchdog.procCheck = () => hq.shifts.get(sid)!.proc_start;
    hq.store.db.prepare(`UPDATE messages SET state = 'handled' WHERE to_identity = ?`).run(`agent-company-t${t.id}`);
    const host = launcher.hosts.get(sid)!;
    const sys = (subtype: string, raw: Record<string, unknown>) => host.event({ kind: 'other', type: 'system', subtype, raw: { type: 'system', subtype, ...raw } });
    sys('task_started', { task_id: 'bci', task_type: 'local_bash', is_backgrounded: true });
    sys('background_tasks_changed', { tasks: [{ task_id: 'bci', task_type: 'local_bash' }] });
    await until(() => hq.shifts.get(sid)!.bg_tasks === '["bci"]', 3000, 'background work recorded');
    assert.equal(hq.board().find((b) => b.id === `agent-company-t${t.id}`)!.status, 'working', 'not "פנוי" while its work runs');

    clock.advance(40 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get(sid)!.state, 'live', 'not rested with background work running');
    assert.equal(hq.scheduler.task(t.id)!.state, 'running');

    sys('task_notification', { task_id: 'bci', status: 'completed' });
    sys('background_tasks_changed', { tasks: [] });
    await until(() => hq.shifts.get(sid)!.bg_tasks === '[]', 3000, 'background work over');
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get(sid)!.end_reason, 'rest');
  } finally { await env.cleanup(); }
});

test('#175: background work that never ends keeps a shift up only until restBgMaxMs', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    const t = hq.scheduler.addTask({ title: 'שרת שרץ לנצח', project: 'agent-company' });
    const sid = `agent-company-t${t.id}-1`;
    await until(() => hq.shifts.get(sid)?.state === 'live', 3000, 'task shift live');
    hq.watchdog.procCheck = () => hq.shifts.get(sid)!.proc_start;
    hq.store.db.prepare(`UPDATE messages SET state = 'handled' WHERE to_identity = ?`).run(`agent-company-t${t.id}`);
    launcher.hosts.get(sid)!.event({ kind: 'other', type: 'system', subtype: 'background_tasks_changed', raw: { tasks: [{ task_id: 'srv' }] } });
    await until(() => hq.shifts.get(sid)!.bg_tasks === '["srv"]', 3000, 'background work recorded');
    clock.advance(hq.cfg.timers.restBgMaxMs + 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.shifts.get(sid)!.end_reason, 'rest');
    assert.equal(hq.shifts.get(sid)!.bg_tasks, '[]', 'the process and its work are gone');
  } finally { await env.cleanup(); }
});

test('#175: a rested task is not shown as running, and hq wakes it after restWakeMs, once per rest', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    const t = hq.scheduler.addTask({ title: 'hq: משימה שנחה', project: 'agent-company' });
    const who = `agent-company-t${t.id}`;
    const sid = `${who}-1`;
    await until(() => hq.shifts.get(sid)?.state === 'live', 3000, 'task shift live');
    hq.watchdog.procCheck = () => hq.shifts.get(sid)!.proc_start;
    hq.store.db.prepare(`UPDATE messages SET state = 'handled' WHERE to_identity = ?`).run(who);
    assert.equal(hq.openTasks().find((o) => o.id === t.id)!.state, 'running');
    clock.advance(21 * 60_000);
    await hq.shifts.pingAll();
    await hq.watchdog.sweep();
    assert.equal(hq.scheduler.task(t.id)!.state, 'resting');

    const open = hq.openTasks().find((o) => o.id === t.id)!;
    assert.equal(open.state, 'queued', 'no one works on it: not "בעבודה"');
    assert.equal(open.worker, null);
    assert.ok(open.reason);
    const head = hq.home.defaultRecipe().blocks.find((b) => b.type === 'headline') as { text: string };
    assert.doesNotMatch(head.text, /משימה אחת בעבודה/, 'the home headline does not count it as running');

    assert.deepEqual(hq.scheduler.wakeResting(), [], 'not before restWakeMs');
    clock.advance(hq.cfg.timers.restWakeMs);
    assert.deepEqual(hq.scheduler.wakeResting(), [t.id]);
    assert.deepEqual(hq.scheduler.wakeResting(), [], 'once per rest');
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'woken by hq');
    assert.equal(launcher.launches.at(-1)!.resume, true);
    const wake = hq.store.db.prepare(`SELECT body, from_identity FROM messages WHERE id LIKE ?`).get(`task-${t.id}-rest-wake-%`) as { body: string; from_identity: string };
    assert.equal(wake.from_identity, 'hq');
    assert.match(wake.body, /בדוק את מה שחיכית לו ותמשיך/);
    assert.equal(hq.openTasks().find((o) => o.id === t.id)!.state, 'running');
  } finally { await env.cleanup(); }
});
