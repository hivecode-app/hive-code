import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, ORG_YAML, until, type TestEnv } from './helpers.ts';
import { writeCatalog, type JobRunner, type JobSpec } from '../src/access.ts';

/** A runner that "runs" at once: the output is a canned text per command, written the way the real script writes it. */
class FakeRunner implements JobRunner {
  started: JobSpec[] = [];
  stopped: number[] = [];
  /** null = never finishes (a long job). */
  output: ((j: JobSpec) => { text: string; code: number } | null) = () => ({ text: 'NAME READY\napi-1 1/1\n', code: 0 });
  async start(j: JobSpec) {
    this.started.push(j);
    const o = this.output(j);
    if (o) { writeFileSync(j.logPath, o.text); writeFileSync(j.exitPath, `${o.code}\n`); }
  }
  async stop(j: { id: number }) { this.stopped.push(j.id); }
  finish(j: JobSpec, text: string, code = 0) { writeFileSync(j.logPath, text); writeFileSync(j.exitPath, `${code}\n`); }
}

const CHARTER = (access = '') => `---
project: agent-company
status: active
machine: hq-host
checkouts: []
${access}
---
`;

const CATALOG = {
  resources: {
    'kube:lumo-dev': { type: 'kube', namespace: 'lumo-dev', kubeconfig: '/k/dev.yaml', env: 'dev' },
    'kube:lumo-prod': { type: 'kube', namespace: 'lumo-prod', kubeconfig: '/k/prod.yaml', env: 'prod' },
    'ssh:ci-host': { type: 'ssh', host: 'ci-host.example', user: 'root', env: 'ci', allow: [{ argv: ['docker', 'images'] }] },
    'hq:query': { type: 'hq-query', env: 'internal' },
    'kube:other': { type: 'kube', namespace: 'other', env: 'dev', projects: ['someone-else'] },
  },
};

async function setup(access = '', listen = false) {
  const runner = new FakeRunner();
  const env = await makeEnv({ noStart: true, deps: { accessRunner: runner }, projects: { 'agent-company': CHARTER(access) } });
  await env.hq.start({ listen, timers: false });
  writeCatalog(env.cfg.stateDir, CATALOG);
  const t = env.hq.scheduler.addTask({ title: 'משימה', project: 'agent-company' });
  env.hq.store.db.prepare(`UPDATE tasks SET identity = 'ac-ceo', state = 'running' WHERE id = ?`).run(t.id);
  env.hq.store.db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at) VALUES ('ac-ceo-1', 'ac-ceo', 1, 'live', ?)`).run(env.clock.now());
  const ask = (args: Record<string, unknown>) => env.hq.access.request({ identity: 'ac-ceo', shift: 'ac-ceo-1', wait: 1, ...args });
  const events = (type: string) => (env.hq.store.db.prepare('SELECT data FROM events WHERE type = ?').all(type) as { data: string }[]).map((e) => JSON.parse(e.data));
  return { env, runner, ask, events };
}

const GRANT = `access:
  - resource: kube:lumo-dev
    verbs: [read]
    quote: «אישרתי קריאה ב-dev»
    date: '2026-10-22'
  - resource: kube:lumo-prod
    verbs: [read, write]
    quote: «אישרתי»
    date: '2026-10-22'
  - resource: hq:query
    verbs: [read]
    quote: «אישרתי»
    date: '2026-10-22'`;

test('access: a read the charter allows runs at once, as a job, and comes back with its output', async () => {
  const { env, runner, ask, events } = await setup(GRANT);
  try {
    const r = await ask({ resource: 'kube:lumo-dev', argv: ['get', 'pods'], why: 'בודק את הפריסה' }) as any;
    assert.equal(r.status, 'done');
    assert.equal(r.exit_code, 0);
    assert.match(r.output, /api-1 1\/1/);
    assert.equal(runner.started.length, 1);
    assert.equal(runner.started[0]!.cmd, 'kubectl');
    assert.deepEqual(runner.started[0]!.args, ['--kubeconfig', '/k/dev.yaml', '-n', 'lumo-dev', 'get', 'pods']);
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'go').length, 0, 'no card for a granted read');
    assert.equal(events('access.granted')[0].by, 'auto:grant');
    assert.equal(events('access.ran')[0].exit_code, 0);
    const row = env.hq.access.list()[0]!;
    assert.equal(row.state, 'done');
    assert.equal(row.approved_by, 'auto:grant');
  } finally { await env.cleanup(); }
});

test('access: outside prod nothing is asked: a write in dev and a command on ci-host run at once, without a grant', async () => {
  const { env, runner, ask, events } = await setup('');
  try {
    const w = await ask({ resource: 'kube:lumo-dev', argv: ['rollout', 'restart', 'deploy/api'], why: 'בדיקה' }) as any;
    assert.equal(w.status, 'done');
    const c = await ask({ resource: 'ssh:ci-host', argv: ['docker', 'images'] }) as any;
    assert.equal(c.status, 'done');
    assert.equal(runner.started.length, 2);
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'go').length, 0);
    assert.deepEqual(events('access.granted').map((e) => e.by), ['auto:non-prod', 'auto:non-prod']);
    // prod is still his: a read with no grant is a card
    assert.equal(((await ask({ resource: 'kube:lumo-prod', argv: ['get', 'pods'] })) as any).status, 'pending');
  } finally { await env.cleanup(); }
});

test('access: prod, no grant → a GO card with the exact command; his yes runs it once; the worker comes back with the request', async () => {
  const { env, runner, ask } = await setup('');
  try {
    const first = await ask({ resource: 'kube:lumo-prod', argv: ['logs', 'deploy/api', '--tail=20'], why: 'חקירת תקלה' }) as any;
    assert.equal(first.status, 'pending');
    assert.equal(runner.started.length, 0);
    const card = env.hq.inbox.open().find((i) => i.kind === 'go')!;
    assert.match(card.body, /kubectl -n lumo-prod logs deploy\/api --tail=20/);
    assert.match(card.body, /חקירת תקלה/);
    assert.equal(card.blocking, true);
    assert.match(card.headline ?? '', /^להחליט אם/);
    // still waiting
    assert.equal(((await ask({ request: first.request })) as any).status, 'pending');
    env.hq.mailbox.complete(card.id, {});
    const done = await ask({ request: first.request }) as any;
    assert.equal(done.status, 'done');
    assert.match(done.output, /api-1/);
    assert.equal(runner.started.length, 1);
    // once: coming back again does not run it again
    assert.equal(((await ask({ request: first.request })) as any).status, 'done');
    assert.equal(runner.started.length, 1);
    assert.equal(env.hq.access.list()[0]!.approved_by, 'owner');
  } finally { await env.cleanup(); }
});

test('access: his "no" (a declined close, or the word) ends the request as denied, and nothing runs', async () => {
  const { env, runner, ask, events } = await setup('');
  try {
    const a = await ask({ resource: 'kube:lumo-prod', argv: ['get', 'pods'] }) as any;
    env.hq.mailbox.complete(env.hq.inbox.open().find((i) => i.kind === 'go')!.id, { declined: true });
    const r = await ask({ request: a.request }) as any;
    assert.equal(r.status, 'denied');
    const b = await ask({ resource: 'kube:lumo-prod', argv: ['get', 'svc'] }) as any;
    env.hq.mailbox.reply(env.hq.inbox.open().find((i) => i.kind === 'go')!.id, 'לא');
    assert.equal(((await ask({ request: b.request })) as any).status, 'denied');
    assert.equal(runner.started.length, 0);
    assert.equal(events('access.denied').length, 2);
  } finally { await env.cleanup(); }
});

test('access: a write in prod is his every time, even with a grant that lists write', async () => {
  const { env, runner, ask } = await setup(GRANT);
  try {
    const r = await ask({ resource: 'kube:lumo-prod', argv: ['rollout', 'restart', 'deploy/api'], why: 'הפעלה מחדש' }) as any;
    assert.equal(r.status, 'pending');
    const card = env.hq.inbox.open().find((i) => i.kind === 'go')!;
    assert.equal(card.urgency, 'urgent');
    assert.match(card.body, /kubectl -n lumo-prod rollout restart deploy\/api/);
    assert.match(card.body, /פרודקשן/);
    assert.equal(runner.started.length, 0);
    // a prod read the grant covers goes through
    assert.equal(((await ask({ resource: 'kube:lumo-prod', argv: ['get', 'pods'] })) as any).status, 'done');
    // and a second write asks again: approval is for one command
    env.hq.mailbox.complete(card.id, {});
    assert.equal(((await ask({ request: r.request })) as any).status, 'done');
    const again = await ask({ resource: 'kube:lumo-prod', argv: ['rollout', 'restart', 'deploy/api'] }) as any;
    assert.equal(again.status, 'pending');
  } finally { await env.cleanup(); }
});

test('access: what is not in the lists is refused and counted (unfit / denied), never run', async () => {
  const { env, runner, ask, events } = await setup(GRANT);
  try {
    const f = await ask({ resource: 'kube:lumo-dev', argv: ['logs', 'api', '-f'] }) as any;
    assert.equal(f.status, 'unfit');
    assert.match(f.hint, /--tail/);
    const t = await ask({ resource: 'kube:lumo-dev', argv: ['get', 'pods', '--token', 'x'] }) as any;
    assert.equal(t.status, 'denied');
    assert.equal(((await ask({ resource: 'kube:nope', argv: ['get', 'pods'] })) as any).status, 'unfit');
    assert.equal(((await ask({ resource: 'kube:other', argv: ['get', 'pods'] })) as any).status, 'denied', 'a resource closed to this project');
    assert.equal(((await ask({ resource: 'ssh:ci-host', argv: ['rm', '-rf', '/'] })) as any).status, 'unfit');
    assert.equal(runner.started.length, 0);
    assert.equal(events('access.unfit').length, 3);
    assert.equal(events('access.denied').length, 2);
    assert.match((await ask({ resource: 'kube:nope', argv: ['x'] }) as any).hint, /kube:lumo-dev/);
  } finally { await env.cleanup(); }
});

test('access: a long job comes back running, then done on the next call; the output is a tail with secrets taken out', async () => {
  const { env, runner, ask } = await setup(GRANT);
  try {
    runner.output = () => null;
    const r = await ask({ resource: 'kube:lumo-dev', argv: ['rollout', 'status', 'deploy/api', '--timeout=5m'], wait: 0 }) as any;
    assert.equal(r.status, 'running');
    assert.equal(((await ask({ request: r.request, wait: 0 })) as any).status, 'running');
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    lines.splice(298, 0, 'TOKEN=ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789AB');
    runner.finish(runner.started[0]!, lines.join('\n'));
    const d = await ask({ request: r.request }) as any;
    assert.equal(d.status, 'done');
    assert.equal(d.truncated, true);
    assert.equal(d.output.split('\n').length, 200);
    assert.ok(!d.output.includes('ghp_'));
    assert.match(d.output, /line 299/);
  } finally { await env.cleanup(); }
});

test('access: a failed command says so with its exit code; cancel stops a running job and drops a waiting card', async () => {
  const { env, runner, ask } = await setup(GRANT);
  try {
    runner.output = () => ({ text: 'Error from server (NotFound)', code: 1 });
    const f = await ask({ resource: 'kube:lumo-prod', argv: ['get', 'pod/x'] }) as any;
    assert.equal(f.status, 'failed');
    assert.equal(f.exit_code, 1);
    runner.output = () => null;
    const run = await ask({ resource: 'kube:lumo-prod', argv: ['rollout', 'status', 'deploy/api'], wait: 0 }) as any;
    const c = await ask({ cancel: run.request }) as any;
    assert.equal(c.status, 'cancelled');
    assert.deepEqual(runner.stopped, [Number(run.request.slice(4))]);
    const w = await ask({ resource: 'kube:lumo-prod', argv: ['scale', 'deploy/api', '--replicas=2'] }) as any;
    assert.equal(w.status, 'pending');
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'go').length, 1);
    await ask({ cancel: w.request });
    assert.equal(env.hq.inbox.open().filter((i) => i.kind === 'go').length, 0);
  } finally { await env.cleanup(); }
});

test('access: hq:query reads hq.db in a child process: rows back, a write or a token table refused', async () => {
  const { env, ask } = await setup(GRANT);
  try {
    const r = await ask({ resource: 'hq:query', argv: ['select count(*) as n from tasks'] }) as any;
    assert.equal(r.status, 'done', JSON.stringify(r));
    assert.equal(JSON.parse(r.output).n, 1);
    assert.equal(((await ask({ resource: 'hq:query', argv: ['delete from tasks'] })) as any).status, 'unfit');
    assert.equal(((await ask({ resource: 'hq:query', argv: ['select 1 from tasks where 1; pragma x'] })) as any).status, 'unfit');
    assert.equal(((await ask({ resource: 'hq:query', argv: ['select * from devices'] })) as any).status, 'denied');
    const bad = await ask({ resource: 'hq:query', argv: ['select * from nope'] }) as any;
    assert.equal(bad.status, 'failed');
  } finally { await env.cleanup(); }
});

test('access: only a live shift of that identity may ask; a request belongs to who made it', async () => {
  const { env, ask } = await setup(GRANT);
  try {
    await assert.rejects(env.hq.access.request({ identity: 'ac-ceo', shift: 'ac-ceo-9', resource: 'kube:lumo-dev', argv: ['get', 'pods'] }), /no live shift/);
    await assert.rejects(env.hq.access.request({ identity: 'eli', shift: 'ac-ceo-1', resource: 'kube:lumo-dev', argv: ['get', 'pods'] }), /no live shift/);
    const r = await ask({ resource: 'kube:lumo-dev', argv: ['get', 'pods'] }) as any;
    env.hq.store.db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, started_at) VALUES ('eli-1', 'eli', 1, 'live', 1)`).run();
    await assert.rejects(env.hq.access.request({ identity: 'eli', shift: 'eli-1', request: r.request }), /no request/);
    await assert.rejects(ask({ resource: 'kube:lumo-dev' }), /argv/);
  } finally { await env.cleanup(); }
});

test('access: POST /v1/access on the ingest socket gives the same answers', async () => {
  const { env } = await setup(GRANT, true);
  try {
    const sock = join(env.cfg.stateDir, 'hq.sock');
    const post = (body: unknown) => new Promise<{ status: number; json: any }>((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body));
      const req = request({ socketPath: sock, path: '/v1/access', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
    const ok = await post({ identity: 'ac-ceo', shift: 'ac-ceo-1', resource: 'kube:lumo-dev', argv: ['get', 'pods'], wait: 1 });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.status, 'done');
    const nope = await post({ identity: 'ac-ceo', shift: 'ac-ceo-77', resource: 'kube:lumo-dev', argv: ['get', 'pods'] });
    assert.equal(nope.status, 403);
    assert.equal((await post({ identity: 'ac-ceo' })).status, 400);
  } finally { await env.cleanup(); }
});

test('access: two calls with the same request after his yes run the command once, and both get the answer', async () => {
  const { env, runner, ask } = await setup('');
  try {
    const first = await ask({ resource: 'kube:lumo-prod', argv: ['rollout', 'restart', 'deploy/api'], wait: 0 }) as any;
    assert.equal(first.status, 'pending');
    env.hq.mailbox.complete(env.hq.inbox.open().find((i) => i.kind === 'go')!.id, {});
    const [a, b] = await Promise.all([ask({ request: first.request }), ask({ request: first.request })]) as any[];
    assert.equal(runner.started.length, 1, 'one run');
    assert.deepEqual([a.status, b.status].sort(), ['done', 'done']);
    // a cancel that came in while another call waited is not undone by it
    const w = await ask({ resource: 'kube:lumo-prod', argv: ['scale', 'deploy/api', '--replicas=2'], wait: 0 }) as any;
    const waiting = ask({ request: w.request, wait: 3 });
    await ask({ cancel: w.request });
    assert.equal(((await waiting) as any).status, 'cancelled');
    assert.equal(runner.started.length, 1);
  } finally { await env.cleanup(); }
});

test('access: a card closed by anyone but him is not an approval', async () => {
  const { env, runner, ask } = await setup('');
  try {
    const a = await ask({ resource: 'kube:lumo-prod', argv: ['get', 'pods'], wait: 0 }) as any;
    env.hq.mailbox.complete(env.hq.inbox.open().find((i) => i.kind === 'go')!.id, { by: 'hq', note: 'נסגר' });
    assert.equal(((await ask({ request: a.request })) as any).status, 'denied');
    assert.equal(runner.started.length, 0);
  } finally { await env.cleanup(); }
});

test('access: the card shows the command as it runs: a word with a space is quoted', async () => {
  const { env, ask } = await setup('');
  try {
    await ask({ resource: 'kube:lumo-prod', argv: ['exec', 'deploy/api', '--', 'sh', '-c', 'rm -rf /'], wait: 0 });
    const card = env.hq.inbox.open().find((i) => i.kind === 'go')!;
    assert.match(card.body, /exec deploy\/api -- sh -c "rm -rf \/"/);
    assert.match(card.body, /הרצת פקודה בתוך ה-pod/);
  } finally { await env.cleanup(); }
});

test('access: hq:query answers a second call from the same stored result', async () => {
  const { env, ask } = await setup(GRANT);
  try {
    const r = await ask({ resource: 'hq:query', argv: ['select 1 as one'] }) as any;
    assert.equal(r.status, 'done');
    const again = await ask({ request: r.request }) as any;
    assert.equal(again.output, r.output);
  } finally { await env.cleanup(); }
});
