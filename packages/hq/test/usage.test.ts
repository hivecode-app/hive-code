import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { overlap, usage, usedPct } from '../src/usage.ts';

test('usedPct: the positive steps of each account, a drop is a reset', () => {
  const snaps = [
    { name: 'a', at: 0, pct: 10 }, { name: 'a', at: 10, pct: 12 }, { name: 'a', at: 20, pct: 1 }, { name: 'a', at: 30, pct: 3 },
    { name: 'b', at: 5, pct: 40 }, { name: 'b', at: 25, pct: 41.5 },
  ];
  assert.equal(usedPct(snaps, 0), 2.8, '(4 + 1.5) / 2 accounts');
  assert.equal(usedPct(snaps, 21), 1.8, 'a step counts by its end: (2 + 1.5) / 2');
  assert.equal(usedPct(snaps, 26), 2, 'only a was read after 26');
  assert.equal(usedPct([{ name: 'a', at: 0, pct: 3 }], 0), null, 'one read is no rate');
});

test('overlap: time-weighted average and peak', () => {
  const r = overlap([{ from: 0, to: 50 }, { from: 25, to: 100 }, { from: 200, to: 300 }], 0, 100);
  assert.equal(r.avg, 1.3);
  assert.equal(r.peak, 2);
});

test('usage: the day\'s spend by what started each turn, by worker, and tasks in parallel', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const db = hq.store.db;
    const t = clock.now();
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, kind, started_at, task_id) VALUES (?, ?, 1, ?, 'work', ?, ?)`).run('eli-1', 'eli', 'live', t, null);
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, kind, started_at, task_id) VALUES (?, ?, 1, ?, 'work', ?, ?)`).run('amit-1', 'amit', 'live', t, 7);
    hq.store.emit('shift.state', 'amit', { shift: 'amit-1', state: 'starting' });
    hq.store.emit('message.state', 'eli', { id: 'x', state: 'seen', from: 'owner', to: 'eli' });
    hq.store.emit('engine.result', 'eli', { shift: 'eli-1', ev: { kind: 'result', costUsd: 1 } });
    hq.store.emit('message.state', 'eli', { id: 'y', state: 'seen', from: 'rotem', to: 'eli' });
    hq.store.emit('engine.result', 'eli', { shift: 'eli-1', ev: { kind: 'result', costUsd: 3 } });
    hq.store.emit('engine.result', 'amit', { shift: 'amit-1', ev: { kind: 'result', costUsd: 1 } });
    hq.store.emit('account.changed', null, { name: 'claude', snapshot_at: t - 30 * 60_000, seven_day_pct: 10 });
    hq.store.emit('account.changed', null, { name: 'claude', snapshot_at: t, seven_day_pct: 12 });
    clock.advance(60_000);
    const u = usage(hq.store, ['claude'], (id) => hq.mailbox.label(id));
    assert.equal(u.kinds.find((k) => k.kind === 'tasks')!.share, 0.25);
    assert.equal(u.kinds.find((k) => k.kind === 'leads_workers')!.share, 0.5);
    assert.equal(u.kinds.find((k) => k.kind === 'leads_owner')!.share, 0.25);
    assert.deepEqual(u.people.map((p) => [p.name, p.share, p.task]), [['אלי', 0.75, false], ['עמית', 0.25, true]]);
    assert.equal(u.day_pct, 2);
    assert.equal(usage(hq.store, ['claude', 'other'], (id) => id).day_pct, 2, 'an account with no read is not counted');
    hq.store.emit('account.changed', null, { name: 'other', snapshot_at: t - 20 * 60_000, seven_day_pct: 50 });
    hq.store.emit('account.changed', null, { name: 'other', snapshot_at: t, seven_day_pct: 50 });
    assert.equal(usage(hq.store, ['claude', 'other'], (id) => id).day_pct, 1, 'two accounts are one quota: their average');
    assert.equal(u.hour_pct, 2);
    assert.equal(u.parallel.now, 1);
    assert.ok(hq.home.current().usage, 'GET /api/home carries it');
  } finally { await env.cleanup(); }
});
