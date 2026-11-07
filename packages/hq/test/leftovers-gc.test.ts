// Task 1531: worktrees no task holds (workers open their own), a close that keeps failing and copies of hq.db are
// collected or reported, never left in silence. On a real temp repository, as workspace.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { charter, git, makeEnv, repo } from './helpers.ts';
import { lastActivity, parseWorktreeList } from '../src/leftovers-gc.ts';

const ORG = (on: boolean) => `
version: 1
owner: ran
owner_name: רן
owner_gender: male
manager: yoav
monitoring_lead: yoav
teams:
  - {id: management, kind: permanent, symbol: account_tree, lead: yoav, members: []}
identities:
  - id: yoav
    name: יואב
    title: מנהל החברה
    symbol: explore
    team: management
    reports_to: ran
    lifecycle: always-on
    resident: true
    automations:
      - {id: leftovers-gc, what: שאריות של משימות, enabled: ${on}}
`;
const HOUR = 3600_000;

/** Back-dates a worktree's activity by `ms`: every file in it, its index, HEAD and reflog. */
function age(path: string, ms: number) {
  const t = (Date.now() - ms) / 1000;
  execFileSync('find', [path, '-exec', 'touch', '-h', '-d', `@${t}`, '{}', '+']);
  const admin = resolve(path, /^gitdir: (.+)$/m.exec(readFileSync(join(path, '.git'), 'utf8'))![1]!.trim());
  for (const p of [path, join(admin, 'index'), join(admin, 'HEAD'), join(admin, 'logs', 'HEAD')]) if (existsSync(p)) utimesSync(p, t, t);
}

/** A worktree a worker opened by hand, on its own branch, as tamar-* in lumo. */
function byHand(checkout: string, name: string, branch = name) {
  const p = join(checkout, '.worktrees', name);
  git(checkout, 'worktree', 'add', '--quiet', '-b', branch, p, 'origin/main');
  return p;
}

test('parseWorktreeList: linked worktrees only, with branch, lock and prunable', () => {
  const out = 'worktree /r\nHEAD aaa\nbranch refs/heads/main\n\nworktree /r/.worktrees/a\nHEAD bbb\nbranch refs/heads/tamar-a\n\n'
    + 'worktree /r/.worktrees/b\nHEAD ccc\ndetached\nlocked why\n\nworktree /r/.worktrees/c\nHEAD ddd\nbranch refs/heads/x\nprunable gitdir file points to non-existent location\n';
  assert.deepEqual(parseWorktreeList(out), [
    { path: '/r/.worktrees/a', branch: 'tamar-a', locked: false, prunable: false },
    { path: '/r/.worktrees/b', branch: null, locked: true, prunable: false },
    { path: '/r/.worktrees/c', branch: 'x', locked: false, prunable: true },
  ]);
});

test('orphans: an old worktree no task holds is preserved and removed; fresh, in use, a task\'s and not-a-worktree stay; the owner hears once', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG(true), projects: { proj: charter(r.checkout) } });
  try {
    const { hq, clock } = env;
    clock.t = Date.now();
    hq.leftovers.cwds = () => [];

    const old = byHand(r.checkout, 'tamar-old', 'tamar-prod-web');
    writeFileSync(join(old, 'wip.txt'), 'half done\n');
    mkdirSync(join(old, 'node_modules', 'x'), { recursive: true }); // ignored: no --force needed
    writeFileSync(join(old, 'node_modules', 'x', 'i.js'), '1\n');
    age(old, 25 * HOUR);
    const same = byHand(r.checkout, 'tamar-x'); // its branch has the same name and nothing beyond main
    age(same, 25 * HOUR);
    const ours = byHand(r.checkout, 'company-x');
    age(ours, 25 * HOUR);
    const fresh = byHand(r.checkout, 't990-fresh');
    const busy = byHand(r.checkout, 'asaf-busy');
    age(busy, 30 * HOUR);
    hq.leftovers.cwds = () => [join(busy, 'server')];
    // A task's worktree that is running: never the collector's, however quiet.
    const t = hq.scheduler.addTask({ title: 'משימה', project: 'proj' });
    const tasks = byHand(r.checkout, `company-t${t.id}`);
    hq.store.db.prepare(`UPDATE tasks SET state = 'running', worktree = ? WHERE id = ?`).run(tasks, t.id);
    age(tasks, 30 * HOUR);
    // One more worktree the running task opened by hand, named after it: kept while the task is open.
    const extra = byHand(r.checkout, `t${t.id}-fork`);
    age(extra, 30 * HOUR);
    // A separate clone in the worktree dir (lumo's company-t1461-fork): reported, not touched.
    execFileSync('git', ['clone', '--quiet', r.checkout, join(r.checkout, '.worktrees', 'company-t9-fork')]);

    const res = (await hq.leftovers.sweep())!;
    assert.deepEqual(res.removed.map((x) => x.path).sort(), [ours, old, same].sort());
    assert.equal(git(r.checkout, 'branch', '--list', 'tamar-x').replace(/^[ *+]+/, ''), 'tamar-x', 'a worker\'s branch is never deleted, even when it has nothing beyond main');
    assert.equal(git(r.checkout, 'branch', '--list', 'company-x'), '', 'a company-* branch with nothing beyond main goes');
    assert.equal(existsSync(old), false);
    assert.equal(git(r.checkout, 'show', 'refs/company/preserved/tamar-old:wip.txt'), 'half done', 'the work is kept');
    assert.match(git(r.checkout, 'branch', '--list', 'tamar-prod-web'), /tamar-prod-web/, 'its branch stays');
    for (const p of [fresh, busy, tasks, extra]) assert.equal(existsSync(p), true, p);
    assert.deepEqual(res.problems.map((p) => [p.kind, p.path.split('/').pop()]), [['not_worktree', 'company-t9-fork']]);

    const told = () => hq.mailbox.list('yoav').filter((m) => m.from_identity === 'hq' && m.id.startsWith('leftovers-gc-'));
    assert.equal(told().length, 1);
    assert.match(told()[0]!.body, /company-t9-fork/);
    assert.match(told()[0]!.body, /tamar-old.*tamar-prod-web` נשאר.*refs\/company\/preserved\/tamar-old.*node_modules/, 'a removal is told: the branch, the ref and what went unsaved');
    await hq.leftovers.sweep();
    assert.equal(told().length, 1, 'the same list is not reported again');

    // The task closes and its close keeps failing: reported after an hour, the scheduler's to retry.
    hq.store.db.prepare(`UPDATE tasks SET state = 'done', updated_at = ? WHERE id = ?`).run(clock.t - 2 * HOUR, t.id);
    const again = (await hq.leftovers.sweep())!;
    assert.ok(again.problems.some((p) => p.kind === 'close_failed' && p.path === tasks));
    assert.equal(existsSync(tasks), true, 'not closed here: the scheduler retries it');
    assert.ok(!existsSync(extra), 'its task is done: the extra one goes');
    assert.equal(told().length, 2, 'a new leftover is a new message');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('a worktree whose directory went away is pruned from git; no /proc means nothing is removed', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG(true), projects: { proj: charter(r.checkout) } });
  try {
    const { hq, clock } = env;
    clock.t = Date.now();
    const gone = byHand(r.checkout, 'gone');
    execFileSync('rm', ['-rf', gone]);
    const old = byHand(r.checkout, 'old');
    age(old, 25 * HOUR);
    hq.leftovers.cwds = () => null;
    const res = (await hq.leftovers.sweep())!;
    assert.deepEqual(res.removed, []);
    assert.equal(existsSync(old), true);
    assert.match(res.skipped.join(), /proc/);
    assert.doesNotMatch(git(r.checkout, 'worktree', 'list'), /\/gone /, 'the record of a missing dir is pruned');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('off: nothing is read and nothing is removed', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG(false), projects: { proj: charter(r.checkout) } });
  try {
    env.clock.t = Date.now();
    env.hq.leftovers.cwds = () => [];
    const old = byHand(r.checkout, 'old');
    age(old, 48 * HOUR);
    assert.equal(await env.hq.leftovers.sweep(), null);
    assert.equal(existsSync(old), true);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('copies of hq.db: gone when their task is done, and after 48 hours even while it is open', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG(true), projects: { proj: charter(r.checkout) } });
  try {
    const { hq, clock } = env;
    clock.t = Date.now();
    const root = join(env.cfg.stateDir, 'db-copies');
    const put = (who: string, name: string, ageMs: number) => {
      mkdirSync(join(root, who), { recursive: true });
      const p = join(root, who, name);
      writeFileSync(p, 'db');
      const t = (Date.now() - ageMs) / 1000;
      utimesSync(p, t, t);
      return p;
    };
    const open = hq.scheduler.addTask({ title: 'פתוחה', project: 'proj' });
    const done = hq.scheduler.addTask({ title: 'סגורה', project: 'proj' });
    hq.store.db.prepare(`UPDATE tasks SET identity = ?, state = 'running' WHERE id = ?`).run('proj-t1', open.id);
    hq.store.db.prepare(`UPDATE tasks SET identity = ?, state = 'done' WHERE id = ?`).run('proj-t2', done.id);
    const keep = put('proj-t1', 'hq-a.db', 2 * HOUR);
    const tooOld = put('proj-t1', 'hq-b.db', 49 * HOUR);
    const closed = put('proj-t2', 'hq-c.db', 2 * HOUR);
    const res = (await hq.leftovers.sweep())!;
    assert.deepEqual(res.dbCopies.sort(), ['proj-t1/hq-b.db', 'proj-t2/hq-c.db']);
    assert.equal(existsSync(keep), true);
    assert.equal(existsSync(tooOld), false);
    assert.equal(existsSync(closed), false);
    assert.equal(existsSync(join(root, 'proj-t2')), false, 'an empty dir goes too');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('lastActivity: the newest of the dir, the index, HEAD and the reflog', () => {
  const r = repo();
  try {
    const p = byHand(r.checkout, 'x');
    age(p, 10 * HOUR);
    assert.ok(Date.now() - lastActivity(p) >= 10 * HOUR - 1000);
    git(p, 'status'); // a refresh of the index is activity
    writeFileSync(join(p, 'a.txt'), '1\n');
    assert.ok(Date.now() - lastActivity(p) < HOUR);
  } finally { r.cleanup(); }
});

test('an edit deep inside, never committed, or to an ignored file is activity: the worktree stays (review of #498)', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG(true), projects: { proj: charter(r.checkout) } });
  try {
    const { hq, clock } = env;
    clock.t = Date.now();
    hq.leftovers.cwds = () => [];
    writeFileSync(join(r.checkout, '.gitignore'), '.worktrees/\nnode_modules/\n.env\n');
    mkdirSync(join(r.checkout, 'src', 'deep'), { recursive: true });
    writeFileSync(join(r.checkout, 'src', 'deep', 'a.ts'), '1\n');
    git(r.checkout, 'add', '.');
    git(r.checkout, 'commit', '--quiet', '-m', 'deep');
    git(r.checkout, 'push', '--quiet', 'origin', 'HEAD:main');
    git(r.checkout, 'fetch', '--quiet', 'origin');
    const tracked = byHand(r.checkout, 'tracked-edit');
    const untracked = byHand(r.checkout, 'untracked-new');
    const env_ = byHand(r.checkout, 'env-edit');
    const t = (Date.now() - 30 * HOUR) / 1000;
    // Every file is old, as in a checkout three days old…
    writeFileSync(join(env_, '.env'), 'A=1\n');
    for (const w of [tracked, untracked, env_]) age(w, 30 * HOUR);
    // …and then one edit now, deep inside, of each kind (the dirs above keep their old mtime).
    writeFileSync(join(tracked, 'src', 'deep', 'a.ts'), '2\n');
    writeFileSync(join(untracked, 'src', 'deep', 'new.ts'), 'x\n');
    writeFileSync(join(env_, '.env'), 'A=2\n');
    for (const w of [tracked, untracked, env_]) utimesSync(w, t, t); // the top dir stays old (a new file deep inside does not touch it)
    const res = (await hq.leftovers.sweep())!;
    assert.deepEqual(res.removed, []);
    for (const w of [tracked, untracked, env_]) assert.equal(existsSync(w), true, w);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('two sweeps at once (hourly and disk-watch at 85%) are one: a worktree is closed once (review of #498)', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG(true), projects: { proj: charter(r.checkout) } });
  try {
    const { hq, clock } = env;
    clock.t = Date.now();
    hq.leftovers.cwds = () => [];
    const old = byHand(r.checkout, 'old');
    writeFileSync(join(old, 'wip.txt'), 'half done\n');
    age(old, 30 * HOUR);
    const [a, b] = await Promise.all([hq.leftovers.sweep(), hq.leftovers.sweep()]);
    assert.equal(a, b, 'the second caller gets the running sweep');
    assert.deepEqual(a!.removed.map((x) => x.path), [old]);
    assert.equal(git(r.checkout, 'show', 'refs/company/preserved/old:wip.txt'), 'half done');
  } finally { await env.cleanup(); r.cleanup(); }
});
