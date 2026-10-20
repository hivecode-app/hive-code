import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { prNumber } from '../src/awaiting.ts';

test('prNumber: number, #n and a PR url are the same; anything else is none', () => {
  assert.equal(prNumber(12), '12');
  assert.equal(prNumber('#12'), '12');
  assert.equal(prNumber('https://github.com/a/b/pull/12'), '12');
  assert.equal(prNumber('https://github.com/a/b/issues/12'), null);
  assert.equal(prNumber('abc'), null);
});

test('API #108: the board shows what waits; a deploy clears "deploy" by task id or PR in its project; "בדקתי" clears the rest', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const { scheduler, awaiting } = env.hq;
    const mk = (title: string, project: string) => {
      const t = scheduler.addTask({ title, project });
      scheduler.setTaskState(t.id, 'done');
      return t.id;
    };
    const a = mk('a', 'agent-company');
    const b = mk('b', 'agent-company');
    const c = mk('c', 'lumo');
    const d = mk('d', 'agent-company');
    awaiting.mark(a, { awaiting: 'deploy', awaiting_note: 'מחכה לפריסה' }, 'w');
    env.clock.advance(1000);
    awaiting.mark(b, { awaiting: 'deploy', pr: '#41' }, 'w');
    env.clock.advance(1000);
    awaiting.mark(c, { awaiting: 'deploy', pr: '41' }, 'w');
    env.clock.advance(1000);
    awaiting.mark(d, { awaiting: 'check', awaiting_note: 'לפתוח את האפליקציה בטלפון', pr: '42' }, 'w');

    let r = await call('GET', '/api/board');
    assert.deepEqual(r.json.awaiting.map((x: any) => x.id), [d, c, b, a], 'newest first');
    assert.equal(r.json.awaiting[0].awaiting, 'check');
    assert.equal(r.json.awaiting[0].awaiting_note, 'לפתוח את האפליקציה בטלפון');
    assert.equal(r.json.tasks.find((x: any) => x.id === a).awaiting, 'deploy', 'tasks carry it too');

    assert.equal((await call('POST', '/api/deploys', { sha: 'abc' })).status, 400, 'project is required');
    assert.equal((await call('POST', '/api/deploys', { project: 'agent-company', sha: 'abc', tasks: ['x'] })).status, 400);
    r = await call('POST', '/api/deploys', { project: 'agent-company', sha: 'abc123', target: 'hq', tasks: [a, 999], prs: [41, '42'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.deploy.cleared.sort(), [a, b].sort(), 'by id and by PR; lumo#41 is another repo, and check stays');
    assert.deepEqual(awaiting.list().map((x) => x.id), [d, c]);
    const row = env.hq.store.db.prepare('SELECT * FROM deploys WHERE id = ?').get(r.json.deploy.id) as any;
    assert.equal(row.sha, 'abc123');
    assert.equal(row.target, 'hq');
    assert.deepEqual(JSON.parse(row.prs), ['41', '42']);

    r = await call('POST', '/api/deploys', { project: 'lumo', sha: 'def', tasks: [a, d] });
    assert.deepEqual(r.json.deploy.cleared, [], 'a task of another project, and a check, are not cleared by id either');

    r = await call('POST', `/api/tasks/${d}/checked`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.task.awaiting, null);
    assert.equal((await call('POST', `/api/tasks/${d}/checked`)).json.ok, false, 'twice: nothing left');
    assert.equal((await call('POST', '/api/tasks/9999/checked')).status, 404);
    assert.deepEqual((await call('GET', '/api/board')).json.awaiting.map((x: any) => x.id), [c]);
    const evs = env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'task.awaiting' || e.type === 'deploy.recorded').map((e) => e.type);
    assert.ok(evs.includes('deploy.recorded') && evs.filter((t) => t === 'task.awaiting').length >= 7);
  } finally { await env.cleanup(); }
});
