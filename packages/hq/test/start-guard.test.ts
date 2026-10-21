// #224 (22/10 00:30, hq-host choked: load 52, no memory, briefs "not delivered" in his inbox): no shift starts on a
// machine that is too loaded, whatever loads it; a brief its worker never took is a quiet retry, and the monitoring
// lead hears once after three in a row; a task placed on a node that is switched off comes back to the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { BUSY_REASON } from '../src/scheduler.ts';
import { openTasks } from '../src/open-tasks.ts';

test('#224: over the load or short of memory here, nothing starts and the queue says why; it starts when that passes', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    hq.scheduler.loadInfo = () => ({ load1: 52, cpus: 8 }); // 6.5 per CPU, over 1.5
    const t = hq.scheduler.addTask({ title: 'בזמן עומס', project: 'agent-company' });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 0, 'no shift on a choked machine');
    const s = hq.scheduler.slots();
    assert.deepEqual([s.free, s.pressure, s.load], [0, 'load', 6.5]);
    assert.equal(openTasks(hq.store, hq.scheduler, hq.board()).find((x) => x.id === t.id)!.reason, BUSY_REASON);
    assert.deepEqual(await hq.scheduler.restOnPressure(), [], 'resting leads frees no CPU');

    // Load is fine, memory is not: MemAvailable under reserve + one shift.
    hq.scheduler.loadInfo = () => ({ load1: 4, cpus: 8 });
    hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 4096 + 2000 });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 0);
    assert.equal(hq.scheduler.slots().pressure, 'memory');
    assert.equal(hq.scheduler.waitReason(hq.scheduler.task(t.id)!, hq.scheduler.slots()), BUSY_REASON);

    hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 19_000 });
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running once it passed');
    assert.equal(hq.scheduler.slots().pressure, null);
  } finally { await env.cleanup(); }
});

test('#224: a configured threshold: capacity.maxLoad', async () => {
  const env = await makeEnv({ cfg: { capacity: { maxLoad: 0.5 } as never } });
  try {
    const { hq } = env;
    hq.scheduler.loadInfo = () => ({ load1: 6, cpus: 8 });
    assert.equal(hq.scheduler.slots().pressure, 'load', '0.75 per CPU is over 0.5');
    hq.scheduler.loadInfo = () => ({ load1: 3, cpus: 8 });
    assert.equal(hq.scheduler.slots().pressure, null);
  } finally { await env.cleanup(); }
});

test('#224: a brief its worker never took (claude died): no delivery_failure for him, a retry after a backoff, the monitoring lead hears once after 3', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.mode = 'mute'; // the CLI never accepts a line
    const t = hq.scheduler.addTask({ title: 'בריף שלא נלקח', project: 'agent-company' });
    const who = `agent-company-t${t.id}`;
    const crashRun = async (n: number) => {
      await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, `running ${n}`);
      const sh = hq.shifts.current(who)!;
      await until(() => hq.shifts.get(sh.id)?.state === 'live', 3000, `live ${n}`);
      const brief = `task-${t.id}-${sh.id}-${sh.started_at}`;
      await until(() => hq.mailbox.get(brief)?.last_attempt_at != null, 3000, `brief ${n} sent`);
      // Like the real host when claude exits before accepting: the delivery fails, then the exit.
      const h = launcher.hosts.get(sh.id)!;
      const ts = new Date(clock.t).toISOString();
      h.push({ t: 'delivery', ts, msgId: brief, uuid: 'u', state: 'failed', error: 'claude exited before accepting' } as never);
      h.push({ t: 'lifecycle', ts, state: 'exited', exitCode: 1, error: 'crashed' } as never);
      await until(() => hq.scheduler.task(t.id)!.state !== 'running', 3000, `ended ${n}`);
      assert.equal(hq.mailbox.get(brief)!.state, 'failed', 'the brief is dropped: the next start sends its own');
      return brief;
    };
    await crashRun(1);
    // Other mail to the worker waits for the start; nothing resurrects it outside the scheduler.
    hq.mailbox.tell({ msg_id: 'extra', from: 'adi', to: who, body: 'עוד פרט' });
    clock.advance(61_000);
    await hq.mailbox.sweep();
    assert.equal(hq.shifts.current(who), undefined, 'not resurrected');
    assert.equal(hq.mailbox.get('extra')!.state, 'queued');
    await hq.scheduler.fill();
    await crashRun(2);
    // The second failure in a row doubles the wait.
    clock.advance(61_000);
    await hq.scheduler.fill();
    assert.equal(hq.scheduler.task(t.id)!.state, 'queued', 'still in its backoff');
    clock.advance(60_000);
    await hq.scheduler.fill();
    await crashRun(3);
    for (const sweep of [1, 2]) { clock.advance(61_000); await hq.mailbox.sweep(); void sweep; }

    // (rotem's own shift is mute in this test too: only the worker's mail counts here.)
    assert.ok(!hq.inbox.open().some((i) => i.kind === 'delivery_failure' && i.from_identity === who), 'nothing for him');
    const notes = hq.mailbox.list('rotem').filter((m) => m.to_identity === 'rotem' && m.from_identity === 'hq');
    assert.equal(notes.length, 1, 'one note to the monitoring lead');
    assert.match(notes[0]!.body, /3 פעמים ברצף/);
    assert.ok(!hq.mailbox.list('adi').some((m) => m.to_identity === 'adi' && /לא עלתה/.test(m.body)));

    // It goes on trying; a brief taken ends the run of failures.
    launcher.mode = 'echo';
    clock.advance(5 * 60_000);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running again');
    await until(() => hq.mailbox.get('extra')!.state !== 'queued', 3000, 'the waiting mail is delivered by the start');
    const sh = hq.shifts.current(who)!;
    await until(() => hq.mailbox.get(`task-${t.id}-${sh.id}-${sh.started_at}`)!.state !== 'queued', 3000, 'taken');
    await hq.shifts.stop(sh.id, 'stuck');
    await until(() => hq.scheduler.task(t.id)!.state === 'queued', 3000, 'back in the queue');
    clock.advance(61_000);
    assert.equal(hq.scheduler.inBackoff(t.id), false, 'back to the plain backoff');
  } finally { await env.cleanup(); }
});

test('#224: a shift that is up but never takes its brief: the sweep stops it and the task tries again, not a failure in his inbox', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.mode = 'mute';
    const t = hq.scheduler.addTask({ title: 'תקועה', project: 'agent-company' });
    const who = `agent-company-t${t.id}`;
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running');
    const sh = hq.shifts.current(who)!;
    const brief = `task-${t.id}-${sh.id}-${sh.started_at}`;
    await until(() => hq.mailbox.get(brief)?.last_attempt_at != null, 3000, 'sent');
    clock.advance(61_000);
    await hq.mailbox.sweep();
    await until(() => hq.scheduler.task(t.id)!.state === 'queued', 3000, 'back in the queue');
    assert.equal(hq.mailbox.get(brief)!.state, 'failed');
    assert.equal(hq.shifts.get(sh.id)!.end_reason, 'brief_failed');
    clock.advance(61_000);
    await hq.mailbox.sweep();
    assert.ok(!hq.inbox.open().some((i) => i.kind === 'delivery_failure'));
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'task.start_not_taken'));
  } finally { await env.cleanup(); }
});

test('#224: launches that fail three times in a row: the monitoring lead hears once, he does not', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.fail = true;
    const t = hq.scheduler.addTask({ title: 'לא עולה', project: 'agent-company' });
    // Its own launches (rotem's shift, woken by the note, fails to launch here too).
    const tries = () => launcher.launches.filter((l) => l.identity === `agent-company-t${t.id}`).length;
    await until(() => tries() === 1, 3000, 'first try');
    for (const wait of [61_000, 121_000]) {
      clock.advance(wait);
      await hq.scheduler.fill();
    }
    await until(() => tries() === 3, 3000, 'three tries');
    const notes = hq.mailbox.list('rotem').filter((m) => m.to_identity === 'rotem' && m.from_identity === 'hq');
    assert.equal(notes.length, 1);
    assert.match(notes[0]!.body, new RegExp(`#${t.id}`));
    assert.ok(!hq.inbox.open().some((i) => i.kind === 'delivery_failure'));
    clock.advance(4 * 60_000 + 1000);
    await hq.scheduler.fill();
    await until(() => tries() === 4, 3000, 'it goes on trying');
    assert.equal(hq.mailbox.list('rotem').filter((m) => m.to_identity === 'rotem' && m.from_identity === 'hq').length, 1, 'still one');
  } finally { await env.cleanup(); }
});

test('#224: two briefs of one task waiting (an older run\'s too) are one failure, and neither reaches the next run', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.mode = 'mute';
    const t = hq.scheduler.addTask({ title: 'שני בריפים', project: 'agent-company' });
    const who = `agent-company-t${t.id}`;
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running');
    const sh = hq.shifts.current(who)!;
    const brief = `task-${t.id}-${sh.id}-${sh.started_at}`;
    await until(() => hq.mailbox.get(brief)?.last_attempt_at != null, 3000, 'sent');
    // An older run's brief still waiting, as after a resurrection.
    hq.mailbox.tell({ msg_id: `task-${t.id}-${sh.id}-1`, from: 'hq', to: who, body: 'בריף ישן' });
    await until(() => hq.mailbox.get(`task-${t.id}-${sh.id}-1`)?.last_attempt_at != null, 3000, 'old sent');
    clock.advance(61_000);
    await hq.mailbox.sweep();
    await until(() => hq.scheduler.task(t.id)!.state === 'queued', 3000, 'back in the queue');
    const n = hq.store.eventsAfter(0, 5000).filter((e) => e.type === 'task.start_not_taken');
    assert.equal(n.length, 1, 'one failure');
    for (const id of [brief, `task-${t.id}-${sh.id}-1`]) assert.equal(hq.mailbox.get(id)!.state, 'failed', id);
  } finally { await env.cleanup(); }
});
