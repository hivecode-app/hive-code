import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { makeEnv, until } from './helpers.ts';
import { createsPr, createdPrFrom, recordedTaskPrs, recordTaskPr } from '../src/task-prs.ts';
import { search } from '../src/search.ts';
import { ensureRuntimeIdentity } from '../src/org.ts';
import { taskPrUrls, TaskCatalog, taskStage, orgTree } from '../src/task-product.ts';

const url = 'https://github.com/example/project/pull/19';
const hook = (command: string, stdout = url) => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout } });

test('PR provenance accepts a create command and an exact success URL, not discussion or view output', () => {
  assert(createsPr('gh pr create --body-file /tmp/body'));
  assert.equal(createdPrFrom(hook('cd /work && gh pr create --title x')), url);
  assert.equal(createdPrFrom(hook('gh pr view 19')), null);
  assert.equal(createdPrFrom(hook('echo "gh pr create"')), null);
  assert.equal(createdPrFrom(hook('gh pr create', `See ${url} for details`)), null);
});

test('Codex shell wrapping preserves the create but fallback output and quoted examples are not provenance', () => {
  assert.equal(createdPrFrom(hook("/bin/bash -lc 'gh pr create --body-file /tmp/body'")), url);
  for (const command of [
    'gh pr create --title x || gh pr view 123 --json url -q .url',
    'gh pr create --title x; cat notes.md',
    'gh pr create --title x && gh pr view 123 --json url -q .url',
    'echo "x; gh pr create"',
    'echo x; gh pr create',
  ]) assert.equal(createdPrFrom(hook(command)), null, command);
});

test('real creation forms keep argument expansions, push chains and stderr redirection', () => {
  for (const command of [
    'git push origin branch && gh pr create --body-file /tmp/body',
    'gh pr create --body-file /tmp/body 2>&1',
    'gh pr create --body "$(cat /tmp/body)"',
    'gh pr create --body `cat /tmp/body`',
    `gh pr create --body "$(cat <<'EOF'\nSome text with ) and a quote ".\nEOF\n)"`,
    "/bin/sh -c 'gh pr create --body-file /tmp/body'",
    "/bin/bash -c 'gh pr create --body-file /tmp/body'",
  ]) assert.equal(createdPrFrom(hook(command)), url, command);
});

const checkout = (env: Awaited<ReturnType<typeof makeEnv>>) => writeFileSync(join(env.cfg.companyDir, 'projects', 'agent-company.md'), `---
project: agent-company
status: active
repo: example/project
checkouts:
  - name: project
    path: ${env.dir}
    default_branch: main
---
`);

test('PR history preserves the release reference and never stores a foreign repository as a local PR number', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false); checkout(env);
    const task = hq.scheduler.addTask({ title: 'Release reference', project: 'agent-company', state: 'running', identity: 'eli' });
    hq.store.db.prepare('UPDATE tasks SET shift_id = ? WHERE id = ?').run('active', task.id);
    assert(recordTaskPr(hq.store, task.id, 'eli', url, 'active', env.cfg.companyDir));
    hq.store.db.prepare("UPDATE tasks SET awaiting = 'deploy' WHERE id = ?").run(task.id);
    assert(recordTaskPr(hq.store, task.id, 'eli', 'https://github.com/example/project/pull/20', 'active', env.cfg.companyDir));
    assert.equal(hq.scheduler.task(task.id)!.pr, '19');
    hq.awaiting.deployed({ project: 'agent-company', sha: 'abc', tasks: [], prs: ['19'] });
    assert.equal(hq.scheduler.task(task.id)!.awaiting, null, 'the deployment of the first merge still clears its waiting state');
    const foreign = hq.scheduler.addTask({ title: 'Other repo', project: 'agent-company', state: 'running', identity: 'eli' });
    hq.store.db.prepare('UPDATE tasks SET shift_id = ? WHERE id = ?').run('foreign', foreign.id);
    assert(recordTaskPr(hq.store, foreign.id, 'eli', 'https://github.com/other/repo/pull/21', 'foreign', env.cfg.companyDir));
    assert.equal(hq.scheduler.task(foreign.id)!.pr, null);
    assert.deepEqual(recordedTaskPrs(hq.store, foreign.id), ['https://github.com/other/repo/pull/21']);
  } finally { await env.cleanup(); }
});

test('numeric deploy provenance matches the worktree checkout, ignoring repository case', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    writeFileSync(join(env.cfg.companyDir, 'projects', 'agent-company.md'), `---
project: agent-company
status: active
repo: example/project
checkouts:
  - { name: primary, path: ${env.dir}/primary, default_branch: main }
  - { name: secondary, path: ${env.dir}/secondary, default_branch: main, repo: example/secondary }
---
`);
    const task = hq.scheduler.addTask({ title: 'Primary checkout', project: 'agent-company', state: 'running', identity: 'eli' });
    hq.store.db.prepare('UPDATE tasks SET shift_id = ?, worktree = ? WHERE id = ?').run('active', join(env.dir, 'primary', '.worktrees', 'task'), task.id);
    assert(recordTaskPr(hq.store, task.id, 'eli', 'https://github.com/example/secondary/pull/20', 'active', env.cfg.companyDir));
    assert.equal(hq.scheduler.task(task.id)!.pr, null);
    assert(recordTaskPr(hq.store, task.id, 'eli', 'https://github.com/EXAMPLE/PROJECT/pull/21', 'active', env.cfg.companyDir));
    assert.equal(hq.scheduler.task(task.id)!.pr, '21');
  } finally { await env.cleanup(); }
});

test('a completed task or another active shift cannot receive a later PR from a standing worker', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false); checkout(env);
    for (const state of ['done', 'closed', 'queued', 'running', 'resting']) {
      const task = hq.scheduler.addTask({ title: state, project: 'agent-company', state, identity: 'eli' });
      hq.store.db.prepare('UPDATE tasks SET shift_id = ? WHERE id = ?').run('older', task.id);
      assert.equal(recordTaskPr(hq.store, task.id, 'eli', url, 'newer', env.cfg.companyDir), false, state);
      assert.equal(hq.scheduler.task(task.id)!.pr, null);
      assert.deepEqual(recordedTaskPrs(hq.store, task.id), []);
      if (['done','closed','queued'].includes(state)) assert.equal(recordTaskPr(hq.store, task.id, 'eli', url, 'older', env.cfg.companyDir), false, `finished state ${state}`);
      if (state === 'resting') assert(recordTaskPr(hq.store, task.id, 'eli', url, 'older', env.cfg.companyDir));
    }
  } finally { await env.cleanup(); }
});

test('a real shift binds PR creates from the hook and normalized engine events once, and keeps earlier PRs', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq, launcher } = env; await hq.start({ timers: false });
    const t = hq.scheduler.addTask({ title: 'Task progress', project: 'agent-company' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running');
    const shift = `agent-company-t${t.id}-1`;
    await until(() => hq.shifts.get(shift)?.state === 'live');
    const host = launcher.hosts.get(shift)!; checkout(env);
    host.spool.push({ cursor: '001', ts: '', event: 'PostToolUse', payload: hook('gh pr create') });
    await hq.shifts.collectSpool(shift);
    assert.equal(hq.scheduler.task(t.id)!.pr, '19');
    assert.deepEqual(recordedTaskPrs(hq.store, t.id), [url]);
    // The normalized engine route is what Codex emits, without Claude's hook process.
    const second = 'https://github.com/example/project/pull/20';
    host.event({ kind: 'tool_use', toolUseId: 'create', name: 'Bash', input: { command: 'gh pr create --body-file /tmp/body' } });
    await until(() => !!hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'engine.tool_use' AND json_extract(data, '$.ev.toolUseId') = 'create'`).get());
    host.event({ kind: 'tool_result', toolUseId: 'create', isError: false, preview: second });
    await until(() => recordedTaskPrs(hq.store, t.id).includes(second));
    assert.equal(hq.scheduler.task(t.id)!.pr, '19');
    assert.deepEqual(taskPrUrls(hq, hq.scheduler.task(t.id)!), [url, second]);
    assert(search(hq, url).results.some((h) => h.kind === 'task' && h.id === String(t.id)), 'an earlier explicitly recorded PR remains searchable');
    const catalog = new TaskCatalog(hq);
    catalog.readPr = async (u) => ({ url: u, head: 'a', state: 'OPEN', draft: false, merged: false, review: 'pending', ci: 'pending', quote: null, checked_at: hq.store.now() });
    const item = await catalog.item(hq.scheduler.task(t.id)!);
    assert.equal(item.stage, 'review');
    assert.equal(taskStage(hq.scheduler.task(t.id)!, [{ ...item.prs[0]!, state: 'MERGED', merged: true }, item.prs[1]!], [], false), 'review', 'an earlier merge cannot hide the next open PR');
    // The same output from the hook cannot add a second source entry.
    host.spool.push({ cursor: '002', ts: '', event: 'PostToolUse', payload: hook('gh pr create', second) });
    await hq.shifts.collectSpool(shift);
    assert.deepEqual(recordedTaskPrs(hq.store, t.id), [url, second]);
    // After a coordinator restart the input remains durable even when the in-memory pairing is gone.
    hq.store.emit('engine.tool_use', hq.scheduler.task(t.id)!.identity, { shift, ev: { kind: 'tool_use', toolUseId: 'recovered', name: 'Bash', input: { command: 'gh pr create' } } });
    host.event({ kind: 'tool_result', toolUseId: 'recovered', isError: false, preview: 'https://github.com/example/project/pull/22' });
    await until(() => recordedTaskPrs(hq.store, t.id).length === 3);
    assert.deepEqual(recordedTaskPrs(hq.store, t.id), [url, second, 'https://github.com/example/project/pull/22']);
    const before = hq.scheduler.task(t.id)!.pr;
    host.event({ kind: 'tool_use', toolUseId: 'failed', name: 'Bash', input: { command: 'gh pr create' } });
    host.event({ kind: 'tool_result', toolUseId: 'failed', isError: true, preview: 'https://github.com/example/project/pull/21' });
    await until(() => !!hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'engine.tool_result' AND json_extract(data, '$.ev.toolUseId') = 'failed'`).get());
    assert.equal(hq.scheduler.task(t.id)!.pr, before);
  } finally { await env.cleanup(); }
});

test('a queued task assigned to a busy standing worker cannot take the running task\'s request or notes', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const active = hq.scheduler.addTask({ title: 'Active', state: 'running', identity: 'eli' });
    hq.store.db.prepare('UPDATE tasks SET started_at = ? WHERE id = ?').run(env.clock.t, active.id);
    env.clock.advance(1000);
    hq.scheduler.addTask({ title: 'Next', state: 'queued', identity: 'eli' });
    const ask = hq.inbox.add({ kind: 'ask', title: 'Which device?', from_identity: 'eli' });
    hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('during-active', 'eli', 'owner', 'Current task note', env.clock.t);
    const catalog = new TaskCatalog(hq);
    const item = await catalog.item(active);
    assert(item.requests.some((r) => r.id === ask.id));
    assert((await catalog.activity(active)).messages.some((m) => m.id === 'during-active'));
  } finally { await env.cleanup(); }
});

test('an owner-visible note explicitly attached by the lead keeps its own source, even before assignment', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    const proposal = hq.scheduler.addTask({ title: 'Suggestion', state: 'proposal' });
    const put = hq.store.db.prepare('INSERT INTO messages (id, from_identity, to_identity, body, ref, attachments, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const file = JSON.stringify([{ id: 'lead-file', name: 'notes.pdf', mime: 'application/pdf', bytes: 10 }]);
    put.run('lead-note', 'yoav', 'owner', 'Proposed approach', `task-${proposal.id}`, file, env.clock.t);
    put.run('private-note', 'yoav', 'eli', 'Private discussion', `task-${proposal.id}`, null, env.clock.t);
    const activity = await new TaskCatalog(hq).activity(proposal);
    assert.deepEqual(activity.messages.map((m) => [m.id, m.identity]), [['lead-note', 'yoav']]);
    assert.equal(activity.files[0]?.identity, 'yoav');
    assert.equal(activity.files[0]?.message, 'lead-note');
  } finally { await env.cleanup(); }
});

test('a follow-up to a completed worker reaches the responsible lead without manual session work', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    ensureRuntimeIdentity(hq.store, { id: 'closed-worker', name: 'Former worker', title: 'Developer', project: 'agent-company', reports_to: 'eli' });
    hq.scheduler.addTask({ title: 'Finished work', state: 'done', identity: 'closed-worker', labels: ['opened-by:eli'] });
    hq.mailbox.tell({ msg_id: 'follow-up', from: 'owner', to: 'closed-worker', body: 'Please check the earlier result', chat: true });
    await until(() => !!hq.mailbox.get('follow-up-fwd'));
    const forwarded = hq.mailbox.get('follow-up-fwd')!;
    assert.equal(forwarded.to_identity, 'eli');
    assert(forwarded.body.includes('Please check the earlier result'));
    assert.equal(hq.shifts.current('closed-worker'), undefined);
  } finally { await env.cleanup(); }
});

test('two managers keep separate worker and task subtrees', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env; await hq.start({ timers: false }); hq.store.setToggle('scheduler', false);
    for (const [id, manager] of [['worker-a', 'eli'], ['worker-b', 'ac-ceo']]) {
      ensureRuntimeIdentity(hq.store, { id: id!, name: id!, title: 'Developer', project: 'agent-company', reports_to: manager! });
    }
    const a = hq.scheduler.addTask({ title: 'A', state: 'queued', identity: 'worker-a' });
    const b = hq.scheduler.addTask({ title: 'B', state: 'done', identity: 'worker-b' });
    const { tree } = orgTree(hq);
    const flatten = (nodes: any[]): any[] => nodes.flatMap((n) => [n, ...flatten(n.children)]);
    const nodes = flatten(tree), first = nodes.find((n) => n.id === 'eli'), second = nodes.find((n) => n.id === 'ac-ceo');
    assert(first.children.some((n: any) => n.id === 'worker-a' && n.tasks.some((t: any) => t.id === a.id)));
    assert(!first.children.some((n: any) => n.id === 'worker-b'));
    assert(second.children.some((n: any) => n.id === 'worker-b' && n.tasks.some((t: any) => t.id === b.id)));
  } finally { await env.cleanup(); }
});
