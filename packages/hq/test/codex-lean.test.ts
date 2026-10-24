import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';

test('lean continuity only delivers new owner messages, one identity at a time, and keeps the existing chat', async () => {
  const env = await makeEnv({ cfg: { codexLean: true } });
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'auto', from: 'hq', to: 'eli', body: 'עבוד ברקע' });
    hq.mailbox.tell({ msg_id: 'peer', from: 'rotem', to: 'eli', body: 'עוד עבודה' });
    hq.mailbox.tell({ msg_id: 'owner-a', to: 'eli', body: 'שלום אלי' });
    hq.mailbox.tell({ msg_id: 'owner-b', to: 'rotem', body: 'שלום רותם' });
    await until(() => hq.mailbox.get('owner-a')?.state === 'delivered');
    assert.equal(launcher.launches.length, 1);
    assert.equal(launcher.launches[0]!.provider, 'codex');
    assert.equal(hq.mailbox.get('auto')?.state, 'queued');
    assert.equal(hq.mailbox.get('peer')?.state, 'queued');
    assert.equal(hq.mailbox.get('owner-b')?.state, 'queued');
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('owner-a', 'started');
    await until(() => hq.mailbox.get('owner-a')?.state === 'seen');
    host.event({ kind: 'text', text: 'שלום רן', messageId: 'reply-text' });
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'שלום רן' });
    await until(() => hq.mailbox.get('owner-a')?.state === 'handled');
    assert.equal(hq.mailbox.get('owner-a-reply')?.body, 'שלום רן');
    await hq.mailbox.sweep();
    await until(() => hq.mailbox.get('owner-b')?.state === 'delivered');
    assert.equal(launcher.launches.length, 2);
    assert.equal(hq.mailbox.get('owner-a-reply')?.from_identity, 'eli');
    assert.deepEqual(await hq.scheduler.fill(), []);
  } finally { await env.cleanup(); }
});

test('provider switch starts a fresh session and preserves the old Claude session', async () => {
  const env = await makeEnv();
  try {
    const { hq, launcher } = env;
    const old = await hq.shifts.request('eli', { reason: 'manual' });
    await until(() => hq.shifts.get(old.id)?.state === 'live');
    hq.cfg.codexLean = true;
    hq.mailbox.tell({ msg_id: 'switch', to: 'eli', body: 'נמשיך' });
    await until(() => hq.mailbox.get('switch')?.state === 'delivered');
    const next = hq.shifts.current('eli')!;
    assert.notEqual(next.session_id, old.session_id);
    assert.equal(next.account, 'codex');
    assert.equal(hq.shifts.get(old.id)?.session_id, old.session_id);
    assert.equal(launcher.launches.at(-1)?.resume, false);
  } finally { await env.cleanup(); }
});

test('runtime toggle parks idle sessions, refuses an active turn, and switches back without resuming a Codex UUID in Claude', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const old = await hq.shifts.request('eli', { reason: 'manual' });
    await until(() => hq.shifts.get(old.id)?.state === 'live');
    await hq.setCodexLean(true);
    assert.equal(hq.store.toggle('codex/lean'), true);
    assert.equal(hq.shifts.current('eli'), undefined);
    hq.mailbox.tell({ msg_id: 'toggle-turn', to: 'eli', body: 'שלום' });
    await until(() => hq.mailbox.get('toggle-turn')?.state === 'delivered');
    await assert.rejects(hq.setCodexLean(false), /עובד פעיל/);
    const codex = hq.shifts.current('eli')!;
    const host = env.launcher.hosts.get(codex.id)!;
    host.deliveryState('toggle-turn', 'started');
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'שלום' });
    await until(() => !hq.mailbox.leanBusy());
    await hq.setCodexLean(false);
    assert.equal(hq.store.toggle('codex/lean'), false);
    hq.mailbox.tell({ msg_id: 'back-to-claude', to: 'eli', body: 'שלום שוב' });
    await until(() => hq.mailbox.get('back-to-claude')?.state === 'delivered');
    assert.notEqual(hq.shifts.current('eli')?.account, 'codex');
    assert.notEqual(hq.shifts.current('eli')?.session_id, codex.session_id);
    assert.equal(hq.shifts.get(old.id)?.session_id, old.session_id);
  } finally { await env.cleanup(); }
});

test('HQ restart preserves the lean switch and the slot reserved before turn started', async () => {
  const { Hq } = await import('../src/hq.ts');
  const env = await makeEnv({ cfg: { codexLean: true } });
  let restored;
  try {
    const { hq, launcher } = env;
    hq.mailbox.tell({ msg_id: 'before-restart', to: 'eli', body: 'אחד' });
    await until(() => hq.mailbox.get('before-restart')?.state === 'delivered');
    await hq.stop();
    restored = new Hq({ ...env.cfg, codexLean: false }, { launcher, now: env.clock.now, tabBrowser: env.tabBrowser });
    await restored.start({ listen: false, timers: false });
    assert.equal(restored.cfg.codexLean, true);
    restored.mailbox.tell({ msg_id: 'after-restart', to: 'rotem', body: 'שניים' });
    await restored.mailbox.sweep();
    assert.equal(restored.mailbox.get('after-restart')?.state, 'queued');
    assert.equal(launcher.launches.length, 1);
    const host = launcher.hosts.get('eli-1')!;
    host.deliveryState('before-restart', 'started');
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'סיימתי' });
    await until(() => !restored!.mailbox.leanBusy());
    await restored.mailbox.sweep();
    await until(() => restored!.mailbox.get('after-restart')?.state === 'delivered');
    assert.equal(host.sent.length, 1);
  } finally { await restored?.stop(); await env.cleanup(); }
});

test('parking a task for continuity preserves its worktree and leaves it resting', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const task = hq.scheduler.addTask({ title: 'עבודה שמורה', identity: 'eli' });
    hq.store.db.prepare("UPDATE tasks SET state = 'running', worktree = '/existing/task-worktree' WHERE id = ?").run(task.id);
    const shift = await hq.shifts.request('eli', { reason: 'manual', taskId: task.id, cwd: env.dir });
    await until(() => hq.shifts.get(shift.id)?.state === 'live');
    await hq.setCodexLean(true);
    assert.equal(hq.scheduler.task(task.id)?.state, 'resting');
    assert.equal(hq.scheduler.task(task.id)?.worktree, '/existing/task-worktree');
    assert.equal(env.launcher.launches.length, 1);
  } finally { await env.cleanup(); }
});

test('an uncertain send retains the single slot even when the host accepted it before disconnecting', async () => {
  const env = await makeEnv({ cfg: { codexLean: true } });
  try {
    const { hq, launcher } = env;
    const shift = await hq.shifts.request('eli', { reason: 'manual' });
    await until(() => hq.shifts.connection(shift.id)?.isLive === true);
    const conn = hq.shifts.connection(shift.id)!;
    const original = conn.send.bind(conn);
    conn.send = async (...args) => { await original(...args); throw new Error('reply lost after host accepted'); };
    hq.mailbox.tell({ msg_id: 'uncertain', to: 'eli', body: 'ראשון' });
    await until(() => hq.mailbox.get('uncertain')?.state === 'delivered' && !!hq.mailbox.get('uncertain')?.error);
    assert.equal(hq.mailbox.leanBusy(), true);
    hq.mailbox.tell({ msg_id: 'waiting', to: 'rotem', body: 'שני' });
    await hq.mailbox.sweep();
    assert.equal(hq.mailbox.get('waiting')?.state, 'queued');
    assert.equal(launcher.launches.length, 1);
    const host = launcher.hosts.get(shift.id)!;
    host.deliveryState('uncertain', 'started');
    host.event({ kind: 'result', subtype: 'success', isError: false, text: 'סיימתי' });
    await until(() => !hq.mailbox.leanBusy());
    await hq.mailbox.sweep();
    await until(() => hq.mailbox.get('waiting')?.state === 'delivered');
    assert.equal(host.sent.length, 1);
  } finally { await env.cleanup(); }
});

test('an uncertain send before acceptance reconciles the same message without releasing its slot', async () => {
  const env = await makeEnv({ cfg: { codexLean: true } });
  try {
    const { hq, clock, launcher } = env;
    const shift = await hq.shifts.request('eli', { reason: 'manual' });
    await until(() => hq.shifts.connection(shift.id)?.isLive === true);
    const conn = hq.shifts.connection(shift.id)!;
    const original = conn.send.bind(conn);
    conn.send = async () => { throw new Error('connection lost'); };
    hq.mailbox.tell({ msg_id: 'not-yet-accepted', to: 'eli', body: 'ראשון' });
    await until(() => !!hq.mailbox.get('not-yet-accepted')?.error);
    hq.mailbox.tell({ msg_id: 'still-waiting', to: 'rotem', body: 'שני' });
    conn.send = original;
    clock.advance(hq.cfg.timers.deliveryTimeoutMs + 1);
    await hq.mailbox.sweep();
    await until(() => hq.mailbox.get('not-yet-accepted')?.state === 'delivered');
    assert.equal(hq.mailbox.get('still-waiting')?.state, 'queued');
    assert.equal(launcher.hosts.get(shift.id)!.sent.length, 1);
    assert.equal(launcher.hosts.get(shift.id)!.sent[0]!.retry, false);
  } finally { await env.cleanup(); }
});
