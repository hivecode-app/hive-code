// collectSpool: a shift that closed (or whose host closed) mid-read is not an error; a host that drops under a live shift still is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HostConnection } from '../src/host-client.ts';
import { makeEnv, until } from './helpers.ts';

const failing = (real: HostConnection): HostConnection => new Proxy(real, {
  get(t, k) {
    if (k === 'readSpool') return () => Promise.reject(new Error('host socket closed'));
    const v = Reflect.get(t, k, t);
    return typeof v === 'function' ? v.bind(t) : v;
  },
});

test('collectSpool: silent once the shift ended, still an error for a live shift', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const t = hq.scheduler.addTask({ title: 'spool', project: 'agent-company' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'running');
    const id = `agent-company-t${t.id}-1`;
    await until(() => hq.shifts.get(id)?.state === 'live', 3000, 'live');
    const real = hq.shifts.conns.get(id)!;
    hq.shifts.conns.set(id, failing(real));

    await assert.rejects(hq.shifts.collectSpool(id), /host socket closed/);

    hq.shifts.markEnded(id, 'ended', 'test', hq.shifts.get(id)!.started_at);
    hq.shifts.conns.set(id, failing(real));
    await hq.shifts.collectSpool(id); // resolves: nothing to show
    const errs = hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'loop.error'`).all();
    assert.equal(errs.length, 0);
  } finally { await env.cleanup(); }
});
