// B.5 worktrees per task, on a real temp repository: create from the charter's checkout, the shift's cwd,
// preserve uncommitted work on close and remove without --force, dormant projects get no workers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { charter, git, makeEnv, repo, until } from './helpers.ts';
import { readCharter, Workspaces } from '../src/workspace.ts';

test('readCharter: checkouts, commands and ci_check from the frontmatter; ~ is expanded', () => {
  const d = mkdtempSync(join(tmpdir(), 'ch-'));
  try {
    execFileSync('mkdir', ['-p', join(d, 'projects')]);
    writeFileSync(join(d, 'projects', 'proj.md'), charter('~/x', 'dormant', 'hq-host'));
    const ch = readCharter(d, 'proj')!;
    assert.equal(ch.status, 'dormant');
    assert.equal(ch.machine, 'hq-host');
    assert.equal(ch.checkouts[0]!.path, join(process.env.HOME!, 'x'));
    assert.equal(ch.checkouts[0]!.repo, 'hive-owner/proj');
    assert.deepEqual(ch.commands, { test: 'npm test' });
    assert.equal(ch.ciCheck, 'company-ci');
    assert.equal(readCharter(d, 'none'), null);
    assert.equal(readCharter(d, '../etc'), null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('Workspaces: create from origin/main, preserve dirty work on close, remove without --force', async () => {
  const r = repo();
  try {
    const d = mkdtempSync(join(r.dir, 'company-'));
    execFileSync('mkdir', ['-p', join(d, 'projects')]);
    writeFileSync(join(d, 'projects', 'proj.md'), charter(r.checkout));
    const ch = readCharter(d, 'proj')!;
    const ws = new Workspaces();
    const c = ws.checkout(ch)!;
    const w = await ws.create(ch, c, 'company-t1');
    assert.equal(w.path, join(r.checkout, '.worktrees', 'company-t1'));
    assert.equal(w.branch, 'company-t1');
    assert.equal(w.base, 'origin/main');
    assert.deepEqual(await ws.inspect(w.path), { toplevel: w.path, branch: 'company-t1', clean: true });
    assert.equal(git(r.checkout, 'status', '--porcelain'), '', 'the main checkout stays clean');

    // A taken name is never reused.
    const again = await ws.create(ch, c, 'company-t1');
    assert.notEqual(again.path, w.path);
    assert.deepEqual(await ws.close(again.path), { path: again.path, preserved: null, removed: true, branchDeleted: true, ignored: [] });

    // Dirty: a modified tracked file, an untracked file, an ignored file.
    writeFileSync(join(w.path, 'README.md'), 'changed\n');
    writeFileSync(join(w.path, 'new.txt'), 'new\n');
    execFileSync('mkdir', ['-p', join(w.path, 'node_modules')]);
    writeFileSync(join(w.path, 'node_modules', 'x'), 'ignored\n');
    const closed = await ws.close(w.path);
    assert.equal(closed.error, undefined, closed.error);
    assert.equal(closed.preserved, 'refs/company/preserved/company-t1');
    assert.equal(closed.removed, true);
    assert.equal(closed.branchDeleted, true, 'no commit beyond main → the branch goes');
    assert.deepEqual(closed.ignored, ['node_modules/'], 'ignored files are not preserved, but they are reported');
    assert.equal(existsSync(w.path), false);
    assert.equal(git(r.checkout, 'show', 'refs/company/preserved/company-t1:README.md'), 'changed');
    assert.equal(git(r.checkout, 'show', 'refs/company/preserved/company-t1:new.txt'), 'new');
    assert.equal(git(r.checkout, 'worktree', 'list').split('\n').length, 1);

    // A branch with its own commit stays after close.
    const w2 = await ws.create(ch, c, 'company-t2');
    writeFileSync(join(w2.path, 'b.txt'), 'b\n');
    git(w2.path, 'add', 'b.txt');
    git(w2.path, 'commit', '--quiet', '-m', 'b');
    const c2 = await ws.close(w2.path);
    assert.equal(c2.preserved, null);
    assert.equal(c2.removed, true);
    assert.equal(c2.branchDeleted, false);
    assert.equal(git(r.checkout, 'rev-parse', '--abbrev-ref', 'company-t2'), 'company-t2');

    // ensure() brings a hand-removed worktree back on its branch.
    const w3 = await ws.create(ch, c, 'company-t3');
    rmSync(w3.path, { recursive: true, force: true });
    assert.equal(await ws.ensure(w3.path), true);
    assert.equal((await ws.inspect(w3.path)).branch, 'company-t3');

    assert.throws(() => new Workspaces(undefined, 'elsewhere').checkout(ch), /runs on/);
  } finally { r.cleanup(); }
});

test('scheduler: a task runs in its own worktree (shift cwd), resumes there, and closes it when done', async () => {
  const r = repo();
  const env = await makeEnv({ projects: { proj: charter(r.checkout) } });
  try {
    const { hq, launcher } = env;
    const t = hq.scheduler.addTask({ title: 'משימה', project: 'proj' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 5000, 'running');
    const wt = join(r.checkout, '.worktrees', `company-t${t.id}`);
    assert.equal(hq.scheduler.task(t.id)!.worktree, wt);
    assert.equal(launcher.launches.at(-1)!.cwd, wt, 'the shift runs in the task worktree');
    const prompt = hq.mailbox.list(`proj-t${t.id}`).find((m) => m.to_identity === `proj-t${t.id}`)!;
    assert.match(prompt.body, new RegExp(wt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(prompt.body, /company-ci/);

    // Woken by a message after a stop (no cwd passed): still the worktree.
    const sid = `proj-t${t.id}-1`;
    await hq.shifts.stop(sid, 'rest');
    await hq.shifts.request(`proj-t${t.id}`, { reason: 'message' });
    assert.equal(launcher.launches.at(-1)!.cwd, wt);

    writeFileSync(join(wt, 'wip.txt'), 'half done\n');
    await hq.scheduler.completeTask(t.id);
    await until(() => !existsSync(wt), 5000, 'worktree removed');
    assert.equal(git(r.checkout, 'show', `refs/company/preserved/company-t${t.id}:wip.txt`), 'half done');
    await until(() => hq.scheduler.task(t.id)!.worktree === null, 2000, 'worktree cleared on the task');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('scheduler: a dormant project gets no worker; the dry run still makes and removes a worktree', async () => {
  const r = repo();
  const env = await makeEnv({ projects: { proj: charter(r.checkout, 'dormant') } });
  try {
    const { hq, launcher } = env;
    const t = hq.scheduler.addTask({ title: 'לא עכשיו', project: 'proj' });
    await hq.scheduler.fill();
    assert.equal(hq.scheduler.task(t.id)!.state, 'queued');
    assert.equal(launcher.launches.length, 0);

    const dry = await hq.scheduler.dryRunWorktree('proj');
    assert.equal(dry.status, 'dormant');
    assert.equal((dry.inside as { toplevel: string }).toplevel, dry.worktree.path);
    assert.equal(dry.closed.removed, true);
    assert.equal(dry.closed.preserved, null);
    assert.equal(existsSync(dry.worktree.path), false);
    assert.equal(git(r.checkout, 'branch', '--list', 'company-dryrun-*'), '');
    assert.equal(existsSync(join(r.checkout, '.worktrees')), false, 'an emptied .worktrees/ goes too');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('close() refuses a main checkout and keeps detached-HEAD commits', async () => {
  const r = repo();
  try {
    const ws = new Workspaces();
    writeFileSync(join(r.checkout, 'dirty.txt'), 'mine\n');
    const main = await ws.close(r.checkout);
    assert.match(main.error!, /not a linked worktree/);
    assert.equal(existsSync(join(r.checkout, 'dirty.txt')), true, 'nothing reset or cleaned in the main checkout');
    await assert.rejects(ws.ensure(r.checkout), /not a linked worktree/);

    const d = mkdtempSync(join(r.dir, 'company-'));
    execFileSync('mkdir', ['-p', join(d, 'projects')]);
    writeFileSync(join(d, 'projects', 'proj.md'), charter(r.checkout));
    const ch = readCharter(d, 'proj')!;
    const w = await ws.create(ch, ws.checkout(ch)!, 'company-t9');
    git(w.path, 'checkout', '--quiet', '--detach');
    writeFileSync(join(w.path, 'x.txt'), 'x\n');
    git(w.path, 'add', 'x.txt');
    git(w.path, 'commit', '--quiet', '-m', 'on no branch');
    const sha = git(w.path, 'rev-parse', 'HEAD');
    const c = await ws.close(w.path);
    assert.equal(c.removed, true, c.error);
    assert.equal(c.preserved, 'refs/company/preserved/company-t9');
    assert.equal(git(r.checkout, 'rev-parse', 'refs/company/preserved/company-t9'), sha);
  } finally { r.cleanup(); }
});

test('scheduler: tasks from before worktrees, standing identities and broken checkouts', async () => {
  const r = repo();
  const env = await makeEnv({ projects: { proj: charter(r.checkout), far: charter(r.checkout, 'active', 'elsewhere') } });
  try {
    const { hq, launcher, cfg } = env;
    hq.store.setToggle('scheduler', false);
    // Started before this change (worktree NULL): it resumes where it ran, not in a new worktree.
    const old = hq.scheduler.addTask({ title: 'ישנה', project: 'proj' });
    hq.store.db.prepare('UPDATE tasks SET started_at = 1 WHERE id = ?').run(old.id);
    // Handed to a standing identity: runs where that identity runs.
    const own = hq.scheduler.addTask({ title: 'ליואב', project: 'proj', identity: 'eli' });
    // Its charter's machine is another one: out of the queue, the opener hears why.
    const far = hq.scheduler.addTask({ title: 'רחוקה', project: 'far' });
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(old.id)!.state === 'running' && hq.scheduler.task(own.id)!.state === 'running', 5000, 'running');
    assert.equal(hq.scheduler.task(old.id)!.worktree, null);
    assert.equal(launcher.launches.find((l) => l.identity === `proj-t${old.id}`)!.cwd, cfg.defaultCwd);
    assert.equal(hq.scheduler.task(own.id)!.worktree, null);
    assert.equal(launcher.launches.find((l) => l.identity === 'eli')!.cwd, cfg.defaultCwd);
    assert.equal(existsSync(join(r.checkout, '.worktrees')), false, 'no worktree made for either');
    assert.match(hq.scheduler.task(far.id)!.labels, /needs-decision/);
    assert.equal(hq.scheduler.queue().some((t) => t.id === far.id), false);
    const told = hq.mailbox.list(cfg.managerId).find((m) => m.id.startsWith(`task-${far.id}-worktree-failed`));
    assert.match(told!.body, /runs on elsewhere/);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('scheduler: a broken charter means no workers, and says so', async () => {
  const env = await makeEnv({ projects: { bad: '---\nproject: bad\nstatus: [unclosed\n---\n' } });
  try {
    const { hq, launcher } = env;
    hq.scheduler.addTask({ title: 'x', project: 'bad' });
    await hq.scheduler.fill();
    assert.equal(launcher.launches.length, 0);
    const ev = hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'charter.invalid'`).get();
    assert.ok(ev, 'charter.invalid emitted');
  } finally { await env.cleanup(); }
});

test('repoOfWorktree: the checkout the worktree lives in; one checkout is the project\'s; several and no match is no link', async () => {
  const { repoOfWorktree } = await import('../src/workspace.ts');
  const co = (name: string, path: string, repo: string | null) => ({ name, path, defaultBranch: 'main', repo });
  const ch = (checkouts: ReturnType<typeof co>[]) => ({ project: 'p', status: 'active', machine: null, checkouts, worktreeDir: '.worktrees', commands: {}, ciCheck: null, mergeInstructions: null, designReview: null, paused: null }) as never;
  const two = ch([co('a', '/r/a', 'o/a'), co('b', '/r/b', 'o/b')]);
  assert.equal(repoOfWorktree(two, '/r/b/.worktrees/company-t1'), 'o/b');
  assert.equal(repoOfWorktree(two, '/elsewhere/x'), null);
  assert.equal(repoOfWorktree(two, null), null);
  assert.equal(repoOfWorktree(ch([co('a', '/r/a', 'o/a')]), null), 'o/a');
  assert.equal(repoOfWorktree(null, '/r/a/.worktrees/x'), null);
});
