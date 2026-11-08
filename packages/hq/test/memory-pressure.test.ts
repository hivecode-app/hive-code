// Task 1547 (08/11 07:12: hq frozen 65 seconds, 0.4GB free, swap 4070 of 4095MB, 15 shifts, three unreserved builds; at 01:50
// the same at load 107): a new shift or a lease here counts swap and memory PSI, not MemAvailable alone. Full swap raises the
// reserve; a memory stall closes the door; and neither starts what would freeze hq, while hq itself goes on answering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { BUSY_REASON, capacity, memPressure } from '../src/scheduler.ts';
import { memPsiSome10 } from '../src/proc.ts';
import { loadConfig } from '../src/config.ts';
import { DEFAULT_HEAVY } from '../src/heavy.ts';

const CAP = { reserveMb: 4096, psiMaxPct: 10, swapLowMb: 512, swapLowExtraMb: 2048, swapPsiPct: 1 };
/** 08/11 07:12 on hq-host, as freeze-watch saw it. */
const INCIDENT = { totalMb: 24_031, availableMb: 400, swapTotalMb: 4095, swapFreeMb: 25, psiSome10: 38 };

test('memPressure: full swap raises the reserve by a burst, PSI over the line stalls, and what is not reported changes nothing', () => {
  assert.deepEqual(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, swapTotalMb: 4095, swapFreeMb: 2000, psiSome10: 0.2 }),
    { reserveMb: 4096, stalled: false, swapLow: false });
  // hq-host this morning after the restart: swap full of cold pages, 9GB available, PSI 0. Not pressure: the plain reserve,
  // else builds would wait for the extra 2GB for good (swap stays full for days).
  assert.deepEqual(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, swapTotalMb: 4095, swapFreeMb: 61, psiSome10: 0 }),
    { reserveMb: 4096, stalled: false, swapLow: false });
  // The same swap with memory starting to stall: the bar goes up.
  assert.deepEqual(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, swapTotalMb: 4095, swapFreeMb: 61, psiSome10: 2 }),
    { reserveMb: 4096 + 2048, stalled: false, swapLow: true });
  // No PSI reported: swap alone raises it (no way to tell cold pages from a spike).
  assert.equal(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, swapTotalMb: 4095, swapFreeMb: 61 }).swapLow, true);
  assert.equal(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, psiSome10: 10 }).stalled, true, 'at the line is a stall');
  assert.equal(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, psiSome10: 9.9 }).stalled, false);
  // a machine without swap is not "swap low", and one that does not report PSI (a node's poll) is not stalled
  assert.deepEqual(memPressure(CAP, { totalMb: 24_000, availableMb: 9000, swapTotalMb: 0, swapFreeMb: 0 }), { reserveMb: 4096, stalled: false, swapLow: false });
  assert.deepEqual(memPressure(CAP, { totalMb: 24_000, availableMb: 9000 }), { reserveMb: 4096, stalled: false, swapLow: false });
});

test('capacity: the slots count the larger reserve when swap is full, and none while memory stalls', () => {
  const cfg = loadConfig({ stateDir: '/nonexistent' });
  const free = (m: Parameters<typeof capacity>[1]) => capacity(cfg, m, 0).free;
  assert.equal(free({ totalMb: 24_000, availableMb: 9000, swapTotalMb: 4095, swapFreeMb: 3000 }), 3, '(9000 − 4096) / 1300');
  assert.equal(free({ totalMb: 24_000, availableMb: 9000, swapTotalMb: 4095, swapFreeMb: 61 }), 2, '(9000 − 6144) / 1300');
  assert.equal(free({ totalMb: 24_000, availableMb: 19_000, psiSome10: 25 }), 0, 'a stall closes the door whatever is free');
  assert.equal(free(INCIDENT), 0);
});

test('memPsiSome10: reads `some avg10`; no file or no line is null, never 0', () => {
  const txt = 'some avg10=38.21 avg60=12.00 avg300=3.10 total=123\nfull avg10=20.00 avg60=6.00 avg300=1.00 total=99\n';
  assert.equal(memPsiSome10(() => txt), 38.21);
  assert.equal(memPsiSome10(() => { throw new Error('ENOENT'); }), null);
  assert.equal(memPsiSome10(() => 'garbage'), null);
});

test('task 1547: swap full and little free (07:12) → no new shift here, the queue says the server is busy and why; it starts when memory is back', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    // Room for one shift by MemAvailable alone (4096 + 1300 + 300), but swap is gone: the reserve is 6GB now.
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 4096 + 1300 + 300, swapTotalMb: 4095, swapFreeMb: 25 });
    const t = hq.scheduler.addTask({ title: 'בזמן ש-swap מלא', project: 'agent-company' });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 0, 'no shift while swap is full and the room is only by MemAvailable');
    const s = hq.scheduler.slots();
    assert.deepEqual([s.free, s.pressure, s.memWhy, s.swapFreeMb], [0, 'memory', 'swap', 25]);
    assert.equal(hq.scheduler.waitReason(hq.scheduler.task(t.id)!, s), BUSY_REASON);

    // The same free memory with swap to spare: it starts. Swap is what changed the answer.
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 4096 + 1300 + 300, swapTotalMb: 4095, swapFreeMb: 3000 });
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running once swap is back');
  } finally { await env.cleanup(); }
});

test('task 1547: a memory stall (PSI) holds every new shift, with plenty free, and slots() says it is a stall', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 15_000, swapTotalMb: 4095, swapFreeMb: 3000, psiSome10: 31 });
    hq.scheduler.addTask({ title: 'בזמן שהזיכרון נתקע', project: 'agent-company' });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 0);
    const s = hq.scheduler.slots();
    assert.deepEqual([s.free, s.pressure, s.memWhy, s.psi], [0, 'memory', 'stalled', 31]);
  } finally { await env.cleanup(); }
});

const CHARTER = `---
project: agent-company
status: active
machine: hq-host
checkouts: []
---
`;

test('task 1547: reserve at 07:12 (0.4GB free, swap full) is queued with the reason, not granted; granted when memory is back; hq answers all along', async () => {
  const env = await makeEnv({ noStart: true, projects: { 'agent-company': CHARTER },
    cfg: { heavy: { classes: DEFAULT_HEAVY, budgetPct: 65, machines: { local: { memMb: 15_000 } }, liveSharePct: 50 } } });
  await env.hq.start({ listen: false, timers: false });
  try {
    const { hq } = env;
    const db = hq.store.db;
    const t = hq.scheduler.addTask({ title: 'go vet', project: 'agent-company' });
    db.prepare(`UPDATE tasks SET identity = 'amit', state = 'running' WHERE id = ?`).run(t.id);
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at) VALUES ('b-1', 'amit', 1, 'live', ?)`).run(env.clock.now());
    const reserve = (args: Record<string, unknown>) => hq.leases.request({ identity: 'amit', shift: 'b-1', wait: 0, ...args }) as Promise<any>;

    hq.scheduler.memInfo = () => INCIDENT;
    const r = await reserve({ class: 'test-full' });
    assert.equal(r.status, 'queued', 'the budget has room (3GB of 15GB), the machine does not');
    assert.match(r.message, /הזיכרון בשרת נתקע \(ב-38%/);
    // A stall alone (plenty free, swap fine) holds it too.
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 15_000, swapTotalMb: 4095, swapFreeMb: 3000, psiSome10: 40 });
    assert.equal((await reserve({ lease: r.lease })).status, 'queued');
    // Swap full, no stall: 4096 + 2048 reserve + half of 3GB = 7680 needed. 7000 is not enough, 8000 is.
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 7000, swapTotalMb: 4095, swapFreeMb: 25, psiSome10: 1 });
    assert.equal((await reserve({ lease: r.lease })).status, 'queued');
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 8000, swapTotalMb: 4095, swapFreeMb: 25, psiSome10: 1 });
    const g = await reserve({ lease: r.lease });
    assert.equal(g.status, 'granted');
    // A second one right after: the first has not grown yet, its half counts as taken (8000 − 6144 − 1536 < 1536).
    const t2 = hq.scheduler.addTask({ title: 'עוד build', project: 'agent-company' });
    db.prepare(`UPDATE tasks SET identity = 'eli', state = 'running' WHERE id = ?`).run(t2.id);
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at) VALUES ('c-1', 'eli', 1, 'live', ?)`).run(env.clock.now());
    const second = await hq.leases.request({ identity: 'eli', shift: 'c-1', wait: 0, class: 'test-full' }) as any;
    assert.equal(second.status, 'queued', 'not two on the same free memory');
    // hq itself, under the 07:12 numbers: the board and the queue still answer, at once.
    hq.scheduler.memInfo = () => INCIDENT;
    const at = Date.now();
    hq.board();
    hq.resources.view();
    assert.ok(Date.now() - at < 2000, 'hq answers under the incident numbers');
  } finally { await env.cleanup(); }
});

test('task 1547 (review): a lease that waits for memory is not overtaken by shifts that start after it', async () => {
  const env = await makeEnv({ projects: { 'agent-company': CHARTER },
    cfg: { heavy: { classes: DEFAULT_HEAVY, budgetPct: 65, machines: { local: { memMb: 15_000 } }, liveSharePct: 50 } } });
  try {
    const { hq, launcher } = env;
    const db = hq.store.db;
    hq.store.setToggle('scheduler', false); // the lease first, then the queue
    const t = hq.scheduler.addTask({ title: 'build', project: 'agent-company' });
    db.prepare(`UPDATE tasks SET identity = 'amit', state = 'running' WHERE id = ?`).run(t.id);
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at, kind) VALUES ('b-1', 'amit', 1, 'live', ?, 'foreign')`).run(env.clock.now());
    // 6000 free: one more shift fits (6000 − 4096 ≥ 1300), a build's half (4096) does not.
    hq.scheduler.memInfo = () => ({ totalMb: 24_031, availableMb: 6000, swapTotalMb: 4095, swapFreeMb: 3000, psiSome10: 0 });
    const r = await hq.leases.request({ identity: 'amit', shift: 'b-1', wait: 0, class: 'build' }) as any;
    assert.equal(r.status, 'queued');
    assert.match(r.message, /נשארו בשרת 5\.9GB פנויים/, 'the reason it knows, not a list of three');
    assert.match(r.message, /אין הערכה/, 'no "1 minute" when nothing says when memory frees');
    assert.equal(r.eta_min, undefined);
    hq.store.setToggle('scheduler', true);
    hq.scheduler.addTask({ title: 'משמרת שבאה אחרי', project: 'agent-company' });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 0, 'the build waits first: its 4GB counts as held');
    assert.equal(hq.scheduler.slots().pressure, 'memory');
  } finally { await env.cleanup(); }
});
