import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { neverRan, tokenless } from '../src/mailbox.ts';

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

test('the manager answers an escalated ask only with the explicit decision line; any other tell is a note on the card', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    hq.mailbox.ask({ msg_id: 'ask-m', from: 'eli', question: 'לחדש את הדומיין?', options: ['כן', 'לא'], blocking: true });
    hq.mailbox.tell({ msg_id: 'early', from: 'yoav', to: 'eli', ref: 'ask-m', body: 'כן' });
    assert.equal(hq.mailbox.getAsk('ask-m')!.state, 'open', 'not escalated yet: yoav can\'t decide for the owner');
    clock.advance(11 * 60_000);
    hq.scheduler.escalateAsks();
    assert.match(hq.mailbox.get('ask-m-escalation')!.body, /tell\(to="eli", ref="ask-m"/);
    // Dana's case (#331): "I can't answer this for him" is not an answer.
    hq.mailbox.tell({ msg_id: 'y-0', from: 'yoav', to: 'eli', ref: 'ask-m', body: 'את זה אני לא יכול לענות במקומו' });
    let a = hq.mailbox.getAsk('ask-m')!;
    assert.equal(a.state, 'escalated');
    assert.equal(a.manager_note, 'את זה אני לא יכול לענות במקומו');
    const cards = hq.inbox.open().filter((i) => i.ref === 'ask-m');
    assert.deepEqual(cards.map((c) => c.kind), ['ask'], 'still the asker\'s card, no escalation_note beside or instead');
    assert.equal(cards[0]!.from_identity, 'eli');
    assert.equal(hq.mailbox.get('ask-m-answer'), undefined);
    hq.mailbox.tell({ msg_id: 'y-1', from: 'yoav', to: 'eli', ref: 'ask-m', body: 'החלטתי במקומך: כן, כי זה 12$' });
    a = hq.mailbox.getAsk('ask-m')!;
    assert.equal(a.state, 'answered');
    assert.equal(a.answered_by, 'manager');
    assert.match(a.answer!, /כן, כי זה 12\$/);
    assert.ok(hq.inbox.open().some((i) => i.kind === 'escalation_note'));
    assert.equal(hq.mailbox.get('ask-m-answer')!.priority, 'now');
  } finally { await env.cleanup(); }
});

test('his plain text in the asker\'s conversation answers its open ask (Boaz\'s case, #331); a worker\'s tell closes nothing', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    hq.mailbox.ask({ msg_id: 'ask-b', from: 'eli', question: 'לפרוס?', blocking: true });
    // Another worker's tell, and a tell from eli to someone else, close nothing.
    hq.mailbox.tell({ msg_id: 'w-1', from: 'noa', to: 'eli', ref: 'ask-b', body: 'ענו כבר' });
    assert.equal(hq.mailbox.getAsk('ask-b')!.state, 'open');
    // Written for another conversation: not this ask's.
    hq.mailbox.tell({ msg_id: 'o-0', from: 'owner', to: 'noa', body: 'כן', chat: true });
    assert.equal(hq.mailbox.getAsk('ask-b')!.state, 'open');
    // Internal owner-side tells (no chat flag) do not answer either.
    hq.mailbox.tell({ msg_id: 'o-1', from: 'owner', to: 'eli', body: 'תזכורת' });
    assert.equal(hq.mailbox.getAsk('ask-b')!.state, 'open');
    const m = hq.mailbox.tell({ msg_id: 'o-2', from: 'owner', to: 'eli', body: 'כן, תפרוס', chat: true });
    assert.equal(hq.mailbox.getAsk('ask-b')!.state, 'answered');
    assert.equal(hq.mailbox.getAsk('ask-b')!.answered_by, 'owner');
    assert.match(m.body, /כן, תפרוס/);
    assert.ok(!hq.inbox.open().some((i) => i.ref === 'ask-b'), 'the card is closed');
  } finally { await env.cleanup(); }
});

test('GO: his free text does not close the request, a worker\'s withdraw_ask closes its own ask only', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const go = hq.inbox.add({ kind: 'go', from_identity: 'eli', title: 'GO: פריסה', blocking: true, ref: 'go-1' });
    hq.mailbox.reply(go.id, 'למה?');
    assert.equal(hq.inbox.get(go.id)!.state, 'open');
    hq.mailbox.ask({ msg_id: 'ask-w', from: 'eli', question: 'לפרוס?', blocking: true });
    assert.equal(hq.mailbox.withdraw('ask-w', 'הוחלט בשיחה'), true);
    assert.equal(hq.mailbox.getAsk('ask-w')!.state, 'cancelled');
    assert.ok(!hq.inbox.open().some((i) => i.ref === 'ask-w'));
    assert.equal(hq.mailbox.withdraw('ask-w'), false, 'idempotent');
    assert.equal(hq.mailbox.get('ask-w-answer'), undefined, 'nothing is sent to the asker');
  } finally { await env.cleanup(); }
});

test('a second answer to an ask that was put back is delivered under its own id, never swallowed (#331)', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    hq.mailbox.ask({ msg_id: 'ask-r', from: 'eli', question: 'איזה?', options: ['א', 'ב'], blocking: true });
    // The first answer took `ask-r-answer` (the manager's, the old way); the ask was then reopened by hand.
    hq.mailbox.tell({ msg_id: 'ask-r-answer', from: 'yoav', to: 'eli', kind: 'answer', ref: 'ask-r', body: 'לא יכול לענות' });
    hq.store.db.prepare(`UPDATE asks SET state = 'open' WHERE id = 'ask-r'`).run();
    hq.mailbox.answer('ask-r', 'נפתח הצ\'אט', 'owner');
    const mine = hq.store.db.prepare(`SELECT id, from_identity, body FROM messages WHERE ref = 'ask-r' AND kind = 'answer' ORDER BY rowid`).all() as { id: string; from_identity: string; body: string }[];
    assert.equal(mine.length, 2);
    assert.equal(mine[1]!.from_identity, 'owner');
    assert.match(mine[1]!.body, /נפתח הצ'אט/);
    assert.notEqual(mine[1]!.id, mine[0]!.id);
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

test('neverRan: רק result של חידוש שנדחה, לא כשל ביצוע אמיתי', () => {
  const ev = { subtype: 'error_during_execution', text: '', numTurns: 0, durationMs: 0 };
  assert.equal(neverRan(ev), true);
  assert.equal(neverRan({ ...ev, numTurns: 3 }), false);
  assert.equal(neverRan({ ...ev, durationMs: 900 }), false);
  assert.equal(neverRan({ ...ev, text: 'boom' }), false);
});

test('company#237: a tokenless error result is held; a new init of the shift drops it, otherwise it is raised', async () => {
  const env = await makeEnv();
  try {
    const { hq, cfg } = env;
    (cfg.timers as { retryGraceMs: number }).retryGraceMs = 150;
    hq.mailbox.tell({ msg_id: 's-1', to: 'eli', body: 'א' });
    await until(() => hq.mailbox.get('s-1')!.state === 'delivered');
    const row = hq.shifts.get('eli-1')!;
    const errs = () => (hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'turn.error'`).get() as { n: number }).n;
    const fr = (ev: object) => ({ t: 'event', seq: 999, ts: '', ev }) as any;
    const bad = { kind: 'result', subtype: 'error_during_execution', isError: true, numTurns: 1, durationMs: 2148,
      usage: { input_tokens: 0, output_tokens: 0 } };
    const before = errs();
    hq.shifts.emit('frame', row, fr(bad), true);
    hq.shifts.emit('frame', row, fr({ kind: 'init', sessionId: 's', model: 'm', cwd: '/', tools: [] }), true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(errs(), before, 'the CLI retried: no error');
    hq.shifts.emit('frame', row, fr(bad), true);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(errs(), before + 1, 'no new turn: the error is raised');
    hq.shifts.emit('frame', row, fr({ ...bad, usage: { input_tokens: 5, output_tokens: 0 } }), true);
    assert.equal(errs(), before + 2, 'an error after tokens is raised at once');
    hq.shifts.emit('frame', row, fr({ ...bad, text: 'boom' }), true);
    assert.equal(errs(), before + 3, 'an error with text is raised at once');
  } finally { await env.cleanup(); }
});

test('tokenless: no text and no tokens in or out', () => {
  assert.equal(tokenless({ usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 } }), true);
  assert.equal(tokenless({}), true);
  assert.equal(tokenless({ text: 'x' }), false);
  assert.equal(tokenless({ usage: { output_tokens: 3 } }), false);
});

test('a worker\'s message that can wait: the first goes at once, what follows inside the window goes in together', async () => {
  const env = await makeEnv({ cfg: { batching: { enabled: true, gatherMs: 10 * 60_000 } } });
  try {
    const { hq, launcher, clock } = env;
    hq.mailbox.tell({ msg_id: 'g-0', from: 'amit', to: 'eli', body: 'אפשר למזג?' });
    await until(() => hq.mailbox.get('g-0')!.state === 'delivered', 3000, 'the first one at once: its sender may be waiting');
    const host = launcher.hosts.get('eli-1')!;
    host.event({ kind: 'result', subtype: 'success', isError: false } as never);
    await until(() => hq.shifts.current('eli')!.in_turn === 0, 3000, 'turn over');

    clock.advance(3 * 60_000);
    hq.mailbox.tell({ msg_id: 'g-1', from: 'amit', to: 'eli', body: 'סיימתי את הדוח' });
    clock.advance(3 * 60_000);
    hq.mailbox.tell({ msg_id: 'g-2', from: 'rotem', to: 'eli', body: 'לידיעה: הפריסה עברה' });
    await hq.mailbox.sweep();
    assert.equal(hq.mailbox.get('g-1')!.state, 'queued', 'gathered');
    assert.equal(hq.mailbox.get('g-1')!.attempts, 0, 'never attempted: the stale-retry sweep leaves it alone');
    assert.deepEqual(host.sent.map((x) => x.msgId), ['g-0']);

    clock.advance(4 * 60_000);
    await hq.mailbox.sweep();
    await until(() => hq.mailbox.get('g-2')!.state === 'delivered', 3000, 'both delivered');
    assert.deepEqual(host.sent.map((x) => x.msgId), ['g-0', 'g-1', 'g-2'], 'ten minutes after the first, together');
    assert.equal(launcher.launches.length, 1);

    // A reply to what eli itself sent: eli may be waiting on it.
    hq.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, body, state, created_at) VALUES ('q-1', 'eli', 'amit', 'מתי?', 'handled', ?)`).run(clock.now());
    hq.mailbox.tell({ msg_id: 'g-5', from: 'amit', to: 'eli', body: 'מחר', ref: 'q-1' });
    await until(() => hq.mailbox.get('g-5')!.state === 'delivered', 3000, 'a reply at once');
    hq.mailbox.markHandled('g-5');
    hq.store.db.prepare(`UPDATE messages SET delivered_at = ? WHERE id IN ('g-0', 'g-1', 'g-2')`).run(clock.now() - 20 * 60_000);
    hq.mailbox.tell({ msg_id: 'g-6', from: 'rotem', to: 'eli', body: 'משהו חדש' });
    await until(() => hq.mailbox.get('g-6')!.state === 'delivered', 3000, 'a reply opens no window: this one is the first');

    // Urgent from a worker, and anything from him: no wait.
    hq.mailbox.tell({ msg_id: 'g-3', from: 'amit', to: 'eli', body: 'דחוף', urgency: 'urgent' });
    await until(() => hq.mailbox.get('g-3')!.state === 'delivered', 3000, 'urgent at once');
    hq.mailbox.tell({ msg_id: 'g-4', to: 'eli', body: 'מה המצב?' });
    await until(() => hq.mailbox.get('g-4')!.state === 'delivered', 3000, 'owner at once');
  } finally { await env.cleanup(); }
});

test('a gathered message rides along with a shift that comes up, and with a turn already running', async () => {
  const env = await makeEnv({ cfg: { batching: { enabled: true, gatherMs: 10 * 60_000 } } });
  try {
    const { hq, launcher } = env;
    // eli had a worker's message a minute ago: this one is gathered (eli rests meanwhile).
    hq.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, body, state, created_at, delivered_at) VALUES ('r-0', 'rotem', 'eli', 'x', 'handled', ?, ?)`)
      .run(env.clock.now() - 60_000, env.clock.now() - 60_000);
    hq.mailbox.tell({ msg_id: 'r-1', from: 'amit', to: 'eli', body: 'לידיעה' });
    await hq.mailbox.sweep();
    assert.equal(launcher.launches.length, 0);
    hq.mailbox.tell({ msg_id: 'r-2', to: 'eli', body: 'תבדוק את הביטוח' });
    await until(() => hq.mailbox.get('r-1')!.state === 'delivered', 3000, 'gathered went in with his');
    assert.equal(launcher.launches.length, 1);

    const host = launcher.hosts.get('eli-1')!;
    host.event({ kind: 'text', text: 'עובד' });
    await until(() => hq.shifts.current('eli')!.in_turn === 1, 3000, 'in a turn');
    hq.mailbox.tell({ msg_id: 'r-3', from: 'rotem', to: 'eli', body: 'עוד משהו' });
    await until(() => hq.mailbox.get('r-3')!.state === 'delivered', 3000, 'into the running turn');
  } finally { await env.cleanup(); }
});
