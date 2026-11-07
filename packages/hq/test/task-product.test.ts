import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { charter, makeEnv } from './helpers.ts';
import { ensureRuntimeIdentity } from '../src/org.ts';
import { TaskCatalog, orgTree, prEvidence, sourceTask, taskRequests, taskStage, type PrEvidence } from '../src/task-product.ts';
import { search } from '../src/search.ts';
import { readCharter } from '../src/workspace.ts';

const pr: PrEvidence = { url: 'https://github.com/example/project/pull/1', head: 'a'.repeat(40), state: 'OPEN', draft: false, merged: false, review: 'pending', ci: 'pending', quote: null, checked_at: 1 };

test('GitHub review and CI refer to the current head and required check; no invented success', () => {
  const j = { url: pr.url, headRefOid: pr.head, state: 'OPEN', comments: [{ body: `reviewed: ${'b'.repeat(40)}\n**החלטה: approve**` }], statusCheckRollup: [{ name: 'other', conclusion: 'SUCCESS' }] };
  assert.equal(prEvidence(j, 1, 'company-ci').review, 'pending');
  assert.equal(prEvidence(j, 1, 'company-ci').ci, 'unknown');
  j.comments.push({ body: `reviewed: ${pr.head}\n**החלטה: changes**` });
  j.statusCheckRollup.push({ name: 'company-ci', conclusion: 'FAILURE' });
  assert.equal(prEvidence(j, 1, 'company-ci').review, 'changes');
  assert.equal(prEvidence(j, 1, 'company-ci').ci, 'failed');
  j.comments.push({ body: `reviewed: ${pr.head}\n**החלטה: approve**` });
  assert.equal(prEvidence(j, 1, 'company-ci').review, 'approved');
});

test('six tasks: proposals, development with an ask, review, approval, release, completed report', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env;
    await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const add = (state: string, extra = {}) => hq.scheduler.addTask({ title: state, project: 'agent-company', state, ...extra });
    const proposal = add('proposal'), dev = add('running'), review = add('running'), approval = add('done'), released = add('done'), report = add('done');
    hq.store.db.prepare('UPDATE tasks SET awaiting = ? WHERE id = ?').run('deploy', approval.id);
    hq.store.db.prepare('UPDATE tasks SET started_at = ? WHERE id IN (?, ?, ?)').run(env.clock.t, dev.id, review.id, report.id);
    hq.awaiting.deployed({ project: 'agent-company', sha: 'abc', tasks: [released.id], prs: [] });
    const catalog = new TaskCatalog(hq);
    assert.equal((await catalog.item(proposal)).stage, 'proposal');
    assert.equal(taskStage(hq.scheduler.task(dev.id)!, [], [{ id: 4, task: dev.id, kind: 'ask', title: 'Question', asked_by: 'eli', ref: null, created_at: 1 }], false), 'development');
    assert.equal(taskStage(review, [pr], [], false), 'review');
    assert.equal(taskStage(review, [{ ...pr, review: 'changes' }], [], false), 'development');
    assert.equal((await catalog.item(hq.scheduler.task(approval.id)!)).stage, 'approval');
    assert.equal((await catalog.item(released)).stage, 'released');
    const done = await catalog.item(report);
    assert.equal(done.stage, null, 'a report shipped nothing: no stage, only its outcome'); assert.equal(done.outcome, 'completed');
    assert(!(await catalog.list()).groups.some((g) => g.tasks.some((t) => t.id === report.id)), 'nor an unknown one');
    assert((await catalog.list()).groups.find((g) => g.stage === 'approval')!.tasks.some((t) => t.id === approval.id), 'completed implementation still awaiting release remains visible');
  } finally { await env.cleanup(); }
});

test('only what waits on him is "approval": an approved PR is still in review, a merged one waits for nothing of his', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const t = hq.scheduler.addTask({ title: 'Work', project: 'agent-company', state: 'running' });
    assert.equal(taskStage(t, [{ ...pr, review: 'approved', ci: 'passed' }], [], false), 'review');
    assert.equal(taskStage(t, [{ ...pr, state: 'MERGED', merged: true }], [], false), 'development');
    assert.equal(taskStage(t, [{ ...pr, checked_at: 0 }], [], false), null);
    const go = { id: 9, task: t.id, kind: 'go', title: 'GO', asked_by: 'eli', ref: null, created_at: 1 };
    assert.equal(taskStage(t, [pr], [go], false), 'approval');
    const done = hq.scheduler.addTask({ title: 'Done', project: 'agent-company', state: 'done' });
    assert.equal(taskStage(done, [{ ...pr, checked_at: 0 }], [], false), null, 'a finished task is not released before its merge is known');
    assert.equal(taskStage(done, [{ ...pr, state: 'MERGED', merged: true }], [], false), 'released');
    assert.equal(taskStage(done, [{ ...pr, state: 'CLOSED' }], [], false), null, 'a closed PR released nothing');
    assert.equal(taskStage({ ...done, awaiting: 'check' }, [], [], false), 'approval');
    assert.equal(taskStage({ ...done, awaiting: 'deploy' }, [], [], true), 'released');
  } finally { await env.cleanup(); }
});

test("a PR from the task's own branch belongs to it: one read per repo, not per task", async () => {
  const env = await makeEnv({ noStart: true, projects: { proj: charter('/srv/proj') } });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const ch = readCharter(hq.cfg.companyDir, 'proj')!;
    const dir = join(ch.checkouts[0]!.path, ch.worktreeDir);
    const t = hq.scheduler.addTask({ title: 'Branch', project: 'proj', state: 'running' });
    const other = hq.scheduler.addTask({ title: 'Other', project: 'proj', state: 'running' });
    hq.store.db.prepare('UPDATE tasks SET worktree = ? WHERE id = ?').run(join(dir, `company-t${t.id}`), t.id);
    hq.store.db.prepare('UPDATE tasks SET worktree = ? WHERE id = ?').run(join(dir, `company-t${other.id}`), other.id);
    const repo = ch.checkouts[0]!.repo!;
    const url = `https://github.com/${repo}/pull/7`;
    const catalog = new TaskCatalog(hq); let lists = 0;
    catalog.readBranches = async () => { lists++; return [{ url, head: `company-t${t.id}` }, { url: `https://github.com/${repo}/pull/8`, head: `company-t${t.id}0` }]; };
    catalog.readPr = async () => ({ ...pr, url });
    await catalog.list();
    await new Promise((r) => setTimeout(r, 20));
    const listed = await catalog.list();
    assert.equal(lists, 1, 'one gh read for the repo');
    assert.deepEqual(listed.pipeline.find((p) => p.id === t.id)!.prs.map((p) => p.url), [url]);
    assert.deepEqual(listed.pipeline.find((p) => p.id === other.id)!.prs, [], 'company-t<id>0 is another task');
    assert.equal((await catalog.item(hq.scheduler.task(t.id)!)).stage, 'review');
  } finally { await env.cleanup(); }
});

test('a repo that could not be read is said, once, and its tasks with no known PR have no stage instead of "development"', async () => {
  const env = await makeEnv({ noStart: true, projects: { proj: charter('/srv/proj') } });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const t = hq.scheduler.addTask({ title: 'Branch', project: 'proj', state: 'running' });
    const catalog = new TaskCatalog(hq); let lists = 0;
    catalog.readBranches = async () => { lists++; throw new Error('gh: not logged in'); };
    await catalog.list();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal((await catalog.item(hq.scheduler.task(t.id)!)).stage, null);
    const row = hq.scheduler.task(t.id)!;
    assert.equal(catalog.knownStage(row, catalog.context([row])), null, 'search says the same as the board');
    const said = () => (hq.store.db.prepare("SELECT COUNT(*) n FROM events WHERE type = 'tasks.branches.error'").get() as { n: number }).n;
    assert.equal(said(), 1);
    env.clock.t += 200_000; await catalog.list(); await new Promise((r) => setTimeout(r, 20));
    assert.equal(lists, 2, 'read again after the wait, not on every poll');
    assert.equal(said(), 1, 'a failure that goes on is not said again');
    catalog.readBranches = async () => [];
    env.clock.t += 200_000; await catalog.list(); await new Promise((r) => setTimeout(r, 20));
    assert.equal((await catalog.item(hq.scheduler.task(t.id)!)).stage, 'development', 'read again: no PR yet is development');
  } finally { await env.cleanup(); }
});

test('requests carry stable sources; reused workers do not attach an old question to a new task', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const old = hq.scheduler.addTask({ title: 'Old', state: 'done', identity: 'eli' });
    hq.store.db.prepare('UPDATE tasks SET started_at = ? WHERE id = ?').run(env.clock.t, old.id);
    const askedAt = env.clock.t; env.clock.advance(1000);
    hq.store.db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(env.clock.t, old.id);
    env.clock.advance(1000);
    const newer = hq.scheduler.addTask({ title: 'New', state: 'running', identity: 'eli' });
    assert.equal(sourceTask(hq, 'eli', askedAt), old.id);
    assert.equal(sourceTask(hq, 'eli', env.clock.t), newer.id);
    const go = hq.inbox.add({ kind: 'go', title: 'Release?', from_identity: 'eli', ref: `task-${old.id}` });
    const r = taskRequests(hq).filter((r) => r.id === go.id);
    assert.equal(r.length, 1); assert.equal(r[0]!.asked_by, 'eli'); assert.equal(r[0]!.task, old.id);
  } finally { await env.cleanup(); }
});

test('tree includes completed workers and their tasks; task notes and files remain searchable without internal mail', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    ensureRuntimeIdentity(hq.store, { id: 'finished-worker', name: 'Finished', title: 'Developer', reports_to: 'eli', project: 'agent-company' });
    const t = hq.scheduler.addTask({ title: 'Map fix', identity: 'finished-worker', state: 'done', project: 'agent-company' });
    hq.store.db.prepare('UPDATE identities SET active = 0 WHERE id = ?').run('finished-worker');
    const put = hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    put.run('note', 'finished-worker', 'owner', 'Unique review sentence', JSON.stringify([{ id: 'file1', name: 'map.pdf', mime: 'application/pdf', bytes: 32 }]), env.clock.t);
    put.run('private', 'finished-worker', 'eli', 'Secret review sentence', null, env.clock.t);
    const tree = orgTree(hq);
    assert(tree.people.find((p) => p.id === 'finished-worker')?.tasks.some((x) => x.id === t.id));
    assert(tree.tree.some((p) => JSON.stringify(p).includes('finished-worker')));
    const activity = new TaskCatalog(hq).activity(t);
    assert.deepEqual(activity.messages.map((m) => m.id), ['note']);
    assert.equal(activity.files[0]?.message, 'note');
    const hits = search(hq, 'Unique review sentence').results;
    assert(hits.some((h) => h.kind === 'task' && h.id === String(t.id)));
    assert(hits.some((h) => h.kind === 'message' && h.id === 'note'));
    assert.equal(search(hq, 'Secret review sentence').results.length, 0);
    assert(search(hq, 'Finished').results.some((h) => h.kind === 'person' && h.reports_to === 'eli'));
  } finally { await env.cleanup(); }
});

test('task list is local and immediate when GitHub is down; concurrent detail reads coalesce and expose stale data', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const t = hq.scheduler.addTask({ title: 'Code', state: 'running' });
    hq.store.db.prepare('UPDATE tasks SET pr = ? WHERE id = ?').run(pr.url, t.id);
    t.pr = pr.url;
    const catalog = new TaskCatalog(hq); let calls = 0;
    catalog.readPr = async () => { calls++; throw new Error('offline'); };
    const list = await catalog.list(); assert(list.pipeline.some((p) => p.id === t.id));
    const [a, b] = await Promise.all([catalog.item(t), catalog.item(t)]);
    assert.equal(calls, 1); assert.equal(a.prs[0]?.error, true); assert.equal(b.prs[0]?.ci, 'unknown');
  } finally { await env.cleanup(); }
});

test('API: start is idempotent, proposal survives failed requests, task and old message sources are addressable', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ listen: true, timers: false }); hq.store.setToggle('scheduler', false);
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const base = `http://127.0.0.1:${hq.port}`;
    const t = hq.scheduler.addTask({ title: 'Proposal', body: 'Description preserved', state: 'proposal' });
    assert.equal((await fetch(`${base}/api/tasks/${t.id}/start`, { method: 'POST' })).status, 401);
    assert.equal(hq.scheduler.task(t.id)!.state, 'proposal');
    const results = await Promise.all([1, 2].map(() => fetch(`${base}/api/tasks/${t.id}/start`, { method: 'POST', headers })));
    assert(results.every((r) => r.status === 200));
    assert.equal(hq.scheduler.task(t.id)!.state, 'queued');
    assert.equal(hq.scheduler.task(t.id)!.body, 'Description preserved');
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) n FROM events WHERE type = 'task.state' AND json_extract(data, '$.id') = ?`).get(t.id) as { n: number }).n, 1);
    for (const path of [`/api/tasks/${t.id}`, `/api/tasks/${t.id}/activity`, '/api/org/tree', '/api/tasks']) assert.equal((await fetch(base + path, { headers })).status, 200);
    hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, created_at) VALUES (?, ?, ?, ?, ?)').run('old', 'eli', 'owner', 'Old text', 1);
    hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, created_at) VALUES (?, ?, ?, ?, ?)').run('internal', 'eli', 'amit', 'Hidden', 1);
    const source = await (await fetch(base + '/api/messages/old/source', { headers })).json() as any;
    assert.equal(source.target, 'old'); assert.equal(source.messages[0].id, 'old');
    assert.equal((await fetch(base + '/api/messages/internal/source', { headers })).status, 404);
    assert(!('shift_id' in source.messages[0])); assert(!('attempts' in source.messages[0]));
    const done = hq.scheduler.addTask({ title: 'Completed', state: 'done' });
    assert.equal((await fetch(`${base}/api/tasks/${done.id}/start`, { method: 'POST', headers })).status, 409);
    const parked = hq.scheduler.addTask({ title: 'Decision pending', state: 'parked' });
    assert.equal((await fetch(`${base}/api/tasks/${parked.id}/start`, { method: 'POST', headers })).status, 200);
    assert.equal(hq.scheduler.task(parked.id)!.state, 'parked');
    const create = () => fetch(base + '/api/tasks', { method: 'POST', headers, body: JSON.stringify({ title: 'Suggestion', proposal: true, ref: 'owner-suggestion-1' }) });
    const [first, second] = await Promise.all([create(), create()]);
    const a = await first.json() as any, b = await second.json() as any;
    assert.equal(a.task.id, b.task.id);
    assert(!hq.openTasks().some((t) => t.id === a.task.id), 'unaccepted proposals are not in the legacy work queue');
    const groups = (await (await fetch(base + '/api/tasks', { headers })).json() as any).groups;
    assert(!groups.some((g: any) => g.stage !== 'released' && g.tasks.some((x: any) => x.id === done.id)), 'completion is not active development');
  } finally { await env.cleanup(); }
});

test('references to another PR cannot release a task or trigger a GitHub lookup; cold evidence is explicit', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const t = hq.scheduler.addTask({ title: 'Investigation', state: 'running', project: 'agent-company', body: `Compare ${pr.url}` });
    hq.awaiting.deployed({ project: 'agent-company', sha: 'abc', tasks: [], prs: ['1'] });
    const catalog = new TaskCatalog(hq); let reads = 0;
    catalog.readPr = async () => { reads++; return pr; };
    assert.equal((await catalog.item(t)).stage, 'development'); assert.equal(reads, 0);
    hq.store.db.prepare('UPDATE tasks SET pr = ? WHERE id = ?').run(pr.url, t.id);
    const cold = await catalog.list();
    assert.equal(cold.pipeline.find((p) => p.id === t.id)!.stage, null);
    assert(cold.groups.find((g) => g.stage === null)?.tasks.some((p) => p.id === t.id), 'unverified tasks stay visible in a pending group');
    await catalog.item(hq.scheduler.task(t.id)!);
    assert.equal(reads, 1);
    assert.notEqual((await catalog.item(hq.scheduler.task(t.id)!)).stage, 'released');
  } finally { await env.cleanup(); }
});

test('polling hundreds of tasks does not scan thousands of notes and reuses a short cache', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    hq.store.db.transaction(() => {
      const put = hq.store.db.prepare('INSERT INTO tasks (title, identity, project, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (let i = 0; i < 600; i++) put.run(`Work ${i}`, 'eli', 'agent-company', 'queued', i, i);
      const msg = hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, created_at) VALUES (?, ?, ?, ?, ?)');
      for (let i = 0; i < 12000; i++) msg.run(`load-${i}`, 'eli', 'owner', `Compare ${pr.url}`, i);
    })();
    const catalog = new TaskCatalog(hq);
    catalog.readPr = async () => { throw new Error('list must not inspect mentioned PRs'); };
    const start = performance.now(), first = await catalog.list();
    assert.equal(first.pipeline.length, 600); assert.equal(first.groups.find((g) => g.stage === 'development')!.tasks.length, 600);
    assert(performance.now() - start < 1500, 'local projection finishes within 1.5 seconds with 600 tasks / 12000 messages');
    assert.equal(await catalog.list(), first, 'unchanged polling uses the same cached projection');
    const plan = hq.store.db.prepare(`EXPLAIN QUERY PLAN SELECT id FROM tasks WHERE identity = ? AND started_at <= ?`).all('eli', 1);
    assert(JSON.stringify(plan).includes('tasks_identity_start'));
  } finally { await env.cleanup(); }
});

test('file search reads names only; the old-message context filters system and private rows', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false });
    const put = hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, kind, body, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    put.run('file', 'eli', 'owner', 'tell', 'Attached', JSON.stringify([{ id: 'file-id', name: 'map.pdf', mime: 'application/pdf', bytes: 30 }]), 1);
    assert.equal(search(hq, 'map.pdf').results.filter((h) => h.kind === 'message').length, 1);
    assert.equal(search(hq, 'name').results.filter((h) => h.kind === 'message').length, 0);
    assert.equal(search(hq, 'file-id').results.filter((h) => h.kind === 'message').length, 0);
  } finally { await env.cleanup(); }
});

test('a task carries the open_team call that opened it, for its card in the conversation', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const opened = hq.scheduler.addTask({ title: 'Opened in a chat', project: 'agent-company', state: 'queued' });
    const other = hq.scheduler.addTask({ title: 'From the board', project: 'agent-company', state: 'queued' });
    const op = (id: string, ack: unknown) => hq.store.db.prepare('INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, 'eli', 'open_team', '{}', env.clock.t, JSON.stringify(ack));
    op('eli-1:aa', { ok: true, id: 'eli-1:aa', ref: `task-${opened.id}`, result: { task: opened.id, state: 'queued' } });
    op('eli-1:bb', { ok: false, error: 'rejected' });
    const catalog = new TaskCatalog(hq);
    assert.equal((await catalog.item(opened)).op, 'eli-1:aa');
    assert.equal((await catalog.item(other)).op, null);
    assert.equal((await catalog.list()).pipeline.find((t) => t.id === opened.id)!.op, 'eli-1:aa');
    // A call that comes in later is read too (only the rows since the last read).
    op('eli-2:cc', { ok: true, id: 'eli-2:cc', ref: `task-${other.id}`, result: { task: other.id, state: 'queued' } });
    assert.equal((await catalog.item(other)).op, 'eli-2:cc');
    assert.equal((await catalog.item(opened)).op, 'eli-1:aa');
  } finally { await env.cleanup(); }
});
