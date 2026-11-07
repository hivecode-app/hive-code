// task 1505: no read of the event log on hq's paths is a scan of all of it. On 08/11 the log was 2.6GB, and a read of it
// on the event loop, with memory short and its pages on disk, was 11 minutes of a frozen hq. Every statement these paths
// prepare against `events` is planned here (EXPLAIN QUERY PLAN), with the indexes of v44 (events_type, events_identity_type).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.ts';
import { usage } from '../src/usage.ts';
import { board } from '../src/board.ts';
import { recordPrMerged } from '../src/merged.ts';
import { companyDay } from '../src/company-day.ts';

test('the reads of the event log go through an index, never a scan of it', async () => {
  const env = await makeEnv();
  try {
    const { hq, cfg } = env;
    const db = hq.store.db;
    const seen = new Set<string>();
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { if (/\bFROM events\b/.test(sql)) seen.add(sql); return prepare(sql); }) as typeof db.prepare;
    try {
      hq.store.emit('task.state', null, { id: 1, state: 'running' });
      usage(hq.store, ['claude'], (id) => id);
      hq.home.current();
      board(hq.store);
      recordPrMerged(hq.store, { project: 'agent-company', repo: 'hivecode-app/hive-code', number: 7, title: null, by: 'eli' } as Parameters<typeof recordPrMerged>[1]);
      hq.scheduler.markCancelled(1);
      companyDay(hq.store, cfg.companyDir, 'Asia/Jerusalem', '2026-11-08');
    } finally { db.prepare = prepare as typeof db.prepare; }
    assert.ok(seen.size >= 5, `the paths read the log (${seen.size})`);
    for (const sql of seen) {
      const params = (sql.match(/\?/g) ?? []).map(() => null);
      const plan = (prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((r) => r.detail);
      // Any SCAN of events reads all of it (the table, or a whole index of it); only a SEARCH reads a part.
      assert.ok(!plan.some((d) => /^SCAN events\b/.test(d)), `${sql.replace(/\s+/g, ' ').slice(0, 160)}\n  → ${plan.join(' / ')}`);
    }
  } finally { await env.cleanup(); }
});

test('pruneEvents: what is older than the month goes, by seq, and the rest stays', async () => {
  const env = await makeEnv();
  try {
    const { hq, clock } = env;
    const day = 86_400_000;
    hq.store.emit('engine.delta', 'eli', { n: 1 });
    hq.store.emit('task.state', null, { id: 1, state: 'running' });
    clock.advance(10 * day);
    hq.store.emit('engine.delta', 'eli', { n: 2 });
    const mid = hq.store.emit('task.state', null, { id: 2, state: 'running' }).seq;
    clock.advance(25 * day);
    hq.store.emit('task.state', null, { id: 3, state: 'running' });
    const before = (hq.store.db.prepare('SELECT MIN(seq) s FROM events').get() as { s: number }).s;
    assert.ok(before < mid);
    hq.store.pruneEvents();
    const left = hq.store.db.prepare(`SELECT type, json_extract(data, '$.id') id FROM events WHERE type IN ('task.state', 'engine.delta') ORDER BY seq`).all();
    assert.deepEqual(left, [{ type: 'task.state', id: 2 }, { type: 'task.state', id: 3 }], 'older than 30 days, and deltas older than a day');
    clock.advance(40 * day);
    hq.store.pruneEvents();
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'task.state'`).get() as { n: number }).n, 0, 'all of them old: all go');
  } finally { await env.cleanup(); }
});
