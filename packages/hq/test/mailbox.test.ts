import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';

test('tell to a resting identity wakes a shift, delivers, then seen → handled on reply', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    const m = hq.mailbox.tell({ msg_id: 'm-1', to: 'eli', body: 'תבדוק את הביטוח' });
    assert.equal(m.state, 'queued');
    await until(() => hq.mailbox.get('m-1')!.state === 'delivered', 3000, 'delivered');
    assert.equal(launcher.launches.length, 1);
    assert.equal(launcher.launches[0]!.resume, false);
    assert.equal(launcher.launches[0]!.shiftId, 'eli-1');
    const host = launcher.hosts.get('eli-1')!;
    assert.match(host.sent[0]!.text, /^\[הודעה מ-רן \(owner\) · דחיפות: רגילה · m-1\]\nתבדוק את הביטוח$/);
    assert.equal(host.sent[0]!.priority, 'next');

    host.event({ kind: 'text', text: 'בודק' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hq.mailbox.get('m-1')!.state, 'delivered', 'assistant text alone is not proof it was read');
    host.deliveryState('m-1', 'started');
    await until(() => hq.mailbox.get('m-1')!.state === 'seen', 3000, 'seen');

    hq.mailbox.tell({ msg_id: 'm-2', from: 'eli', to: 'owner', body: 'בדקתי', ref: 'm-1' });
    assert.equal(hq.mailbox.get('m-1')!.state, 'handled');
    assert.equal(hq.mailbox.get('m-2')!.state, 'delivered', 'to owner = in the app immediately');

    // Idempotent by msg_id: a retried write returns the stored message, nothing is resent.
    const again = hq.mailbox.tell({ msg_id: 'm-1', to: 'eli', body: 'תבדוק את הביטוח' });
    assert.equal(again.state, 'handled');
    assert.equal(host.sent.filter((s) => s.msgId === 'm-1').length, 1);
  } finally { await env.cleanup(); }
});

test('urgent tell uses priority now', async () => {
  const env = await makeEnv();
  try {
    env.hq.mailbox.tell({ msg_id: 'u-1', to: 'rotem', body: 'דחוף', urgency: 'urgent' });
    await until(() => env.hq.mailbox.get('u-1')!.state === 'delivered');
    assert.equal(env.launcher.hosts.get('rotem-1')!.sent[0]!.priority, 'now');
  } finally { await env.cleanup(); }
});

test('no delivered in 60s → retry with resurrection (resume) → visible failure in both inboxes', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.mode = 'mute';
    hq.mailbox.tell({ msg_id: 'm-9', from: 'eli', to: 'amit', body: 'כמה שילמנו?' });
    await until(() => (launcher.hosts.get('amit-1')?.sent.length ?? 0) === 1, 3000, 'first send');
    assert.equal(hq.mailbox.get('m-9')!.state, 'queued');

    clock.advance(61_000);
    await hq.mailbox.sweep();
    assert.equal(launcher.launches.length, 2, 'resurrected');
    assert.equal(launcher.launches[1]!.resume, true, 'same session resumed');
    assert.equal(launcher.launches[1]!.sessionId, launcher.launches[0]!.sessionId);
    assert.equal(launcher.launches[1]!.unit, 'company-shift@amit-1.service', 'template instance');
    assert.ok(launcher.kills.includes('amit-1'), 'previous run stopped before relaunch');
    // The resumed host keeps its log: the old write is `failed` there, so hq must re-send with retry:true.
    await until(() => (launcher.hosts.get('amit-1')?.sent.length ?? 0) === 1, 3000, 'resent on resumed host');
    assert.equal(launcher.hosts.get('amit-1')!.sent[0]!.retry, true);
    assert.equal(hq.mailbox.get('m-9')!.state, 'queued');

    clock.advance(61_000);
    await hq.mailbox.sweep();
    assert.equal(hq.mailbox.get('m-9')!.state, 'failed');
    const items = hq.inbox.open();
    assert.ok(items.some((i) => i.kind === 'delivery_failure' && i.ref === 'm-9'), 'owner sees it in "waiting for you"');
    const note = hq.mailbox.get('m-9-failed');
    assert.ok(note, 'sender is told through its own mailbox');
    assert.equal(note!.to_identity, 'eli');

    // The failure note to eli is itself a system message: if it fails, it does not loop.
    clock.advance(61_000); await hq.mailbox.sweep();
    clock.advance(61_000); await hq.mailbox.sweep();
    assert.equal(hq.mailbox.get('m-9-failed-failed'), undefined);
  } finally { await env.cleanup(); }
});

test('launch failure leaves the message queued and visible after the windows', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.fail = true;
    hq.mailbox.tell({ msg_id: 'm-x', to: 'eli', body: 'שלום' });
    await until(() => !!hq.mailbox.get('m-x')!.error, 3000, 'error recorded');
    clock.advance(61_000); await hq.mailbox.sweep();
    clock.advance(61_000); await hq.mailbox.sweep();
    assert.equal(hq.mailbox.get('m-x')!.state, 'failed');
    assert.ok(hq.inbox.open().some((i) => i.kind === 'delivery_failure' && /שלום/.test(i.body)));
  } finally { await env.cleanup(); }
});

test('foreign session goes through adapter.injectForeign; stub failure stays visible', async () => {
  const injected: { pid: number; text: string }[] = [];
  const env = await makeEnv({ deps: { foreign: { injectForeign: async (pid, text) => { injected.push({ pid, text }); } } } });
  try {
    const { hq } = env;
    hq.store.db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, kind, pid, started_at) VALUES ('eli-f1', 'eli', 99, 'live', 'foreign', 4242, ?)`).run(env.clock.t);
    hq.mailbox.tell({ msg_id: 'f-1', to: 'eli', body: 'היי' });
    await until(() => hq.mailbox.get('f-1')!.state === 'delivered');
    assert.equal(injected[0]!.pid, 4242);
    assert.match(injected[0]!.text, /f-1/);
  } finally { await env.cleanup(); }
});

test('retry with resurrection actually re-sends: a message the old process never accepted is delivered by the resumed one', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    launcher.mode = 'mute';
    hq.mailbox.tell({ msg_id: 'c2-1', to: 'eli', body: 'ראשונה' });
    hq.mailbox.tell({ msg_id: 'c2-2', to: 'eli', body: 'שנייה' });
    await until(() => (launcher.hosts.get('eli-1')?.sent.length ?? 0) === 2, 3000, 'written, never accepted');
    launcher.mode = 'echo'; // the resumed claude works
    clock.advance(61_000);
    await hq.mailbox.sweep();
    assert.equal(launcher.launches.length, 2, 'one resurrection for the identity, not one per message');
    await until(() => hq.mailbox.get('c2-1')!.state === 'delivered' && hq.mailbox.get('c2-2')!.state === 'delivered', 3000, 'delivered after resume');
    assert.equal(launcher.disks.get('eli-1')!.delivered.get('c2-1')!.state, 'delivered');
    // The old host logged `exited` while being stopped (after run 2 was stamped); the replay must not end run 2.
    assert.ok(launcher.disks.get('eli-1')!.log.some((f) => f.t === 'lifecycle' && f.state === 'exited'));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hq.shifts.get('eli-1')!.state, 'live');
  } finally { await env.cleanup(); }
});

test('the manager answers an escalated ask by replying with ref=<ask id>', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.ask({ msg_id: 'ask-m', from: 'eli', question: 'לחדש את הדומיין?', blocking: true });
    hq.mailbox.tell({ msg_id: 'early', from: 'yoav', to: 'eli', ref: 'ask-m', body: 'כן' });
    assert.equal(hq.mailbox.getAsk('ask-m')!.state, 'open', 'not escalated yet: yoav can\'t decide for the owner');
    clock.advance(11 * 60_000);
    hq.scheduler.escalateAsks();
    assert.match(hq.mailbox.get('ask-m-escalation')!.body, /tell\(to="eli", ref="ask-m"/);
    hq.mailbox.tell({ msg_id: 'y-1', from: 'yoav', to: 'eli', ref: 'ask-m', body: 'החלטתי במקומך: כן, כי זה 12$' });
    const a = hq.mailbox.getAsk('ask-m')!;
    assert.equal(a.state, 'answered');
    assert.equal(a.answered_by, 'manager');
    assert.ok(hq.inbox.open().some((i) => i.kind === 'escalation_note'));
    assert.equal(hq.mailbox.get('ask-m-answer')!.priority, 'now');
  } finally { await env.cleanup(); }
});

test('a replayed `exited` from an earlier run of the same shift id does not end the resumed run', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock, cfg } = env;
    hq.mailbox.tell({ msg_id: 'x-1', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('x-1')!.state === 'delivered');
    await hq.shifts.stop('eli-1', 'rest');
    await until(() => launcher.hosts.get('eli-1')!.closed, 2000, 'old host gone');
    clock.advance(5_000);
    // hq loses its cursor (e.g. a different logId): the resumed host replays the whole log, old exit included.
    hq.store.db.prepare(`UPDATE shifts SET host_seq = 0, host_log_id = 'other' WHERE id = 'eli-1'`).run();
    hq.mailbox.tell({ msg_id: 'x-2', to: 'eli', body: 'ב' });
    await until(() => hq.mailbox.get('x-2')!.state === 'delivered', 3000, 'delivered on the resumed run');
    assert.equal(hq.shifts.get('eli-1')!.state, 'live');
    assert.ok(cfg);
  } finally { await env.cleanup(); }
});

test('heldByCli messages are never re-sent on resume, and are re-sent to a new shift', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher, clock } = env;
    hq.mailbox.tell({ msg_id: 'h-1', to: 'eli', body: 'בתור של ה-CLI' });
    await until(() => hq.mailbox.get('h-1')!.state === 'delivered');
    const host = launcher.hosts.get('eli-1')!;
    clock.advance(1000);
    host.push({ t: 'lifecycle', ts: new Date(clock.t).toISOString(), state: 'exited', exitCode: 1, error: 'crashed', heldByCli: ['h-1'] } as never);
    await until(() => hq.shifts.get('eli-1')!.state === 'ended', 2000, 'ended');
    assert.equal(hq.store.db.prepare(`SELECT held_by_cli FROM messages WHERE id = 'h-1'`).pluck().get(), 1);
    await hq.shifts.request('eli', { reason: 'resurrect' });
    await until(() => hq.shifts.get('eli-1')!.state === 'live', 2000, 'resumed');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(launcher.hosts.get('eli-1')!.sent.length, 0, 'resume: the CLI delivers it itself');
    await hq.shifts.request('eli', { reason: 'rotation', forceNew: true });
    await until(() => (launcher.hosts.get('eli-2')?.sent.length ?? 0) === 1, 3000, 'new shift gets it');
    assert.equal(launcher.hosts.get('eli-2')!.sent[0]!.msgId, 'h-1');
  } finally { await env.cleanup(); }
});

test('his `now` asks the host to stop the worker if safe; what it waits for reaches the app; answers and hq notes never ask', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    await hq.shifts.request('eli', { reason: 'message' });
    await until(() => hq.shifts.current('eli')?.state === 'live', 3000, 'live');
    const host = launcher.hosts.get('eli-1')!;
    const events: any[] = [];
    hq.store.onEvent((e) => { if (e.type === 'message.state') events.push(e.data); });

    host.waitingOn = { tool: 'Bash', command: 'bash deploy/hq.sh', since: '2026-10-21T06:00:00.000Z' };
    hq.mailbox.tell({ msg_id: 'n-1', to: 'eli', body: 'תעצור', priority: 'now' });
    await until(() => hq.mailbox.get('n-1')!.state === 'delivered', 3000, 'delivered');
    assert.equal(host.sent.at(-1)!.stopIfSafe, true);
    assert.deepEqual(hq.mailbox.get('n-1')!.waiting_on, host.waitingOn);
    assert.ok(events.some((e) => e.id === 'n-1' && e.waiting_on?.command === 'bash deploy/hq.sh'), 'the app hears it');

    hq.mailbox.tell({ msg_id: 'n-2', to: 'eli', body: 'אחרי הצעד', priority: 'next' });
    hq.mailbox.tell({ msg_id: 'n-3', from: 'hq', to: 'eli', kind: 'system', body: 'תזכורת', priority: 'now' });
    hq.mailbox.tell({ msg_id: 'n-4', to: 'eli', kind: 'answer', body: 'כן', priority: 'now' });
    await until(() => ['n-2', 'n-3', 'n-4'].every((id) => hq.mailbox.get(id)!.state === 'delivered'), 3000, 'delivered');
    for (const id of ['n-2', 'n-3', 'n-4']) {
      assert.equal(host.sent.find((s) => s.msgId === id)!.stopIfSafe, false, id);
      assert.equal(hq.mailbox.get(id)!.waiting_on, null, id);
    }
  } finally { await env.cleanup(); }
});
