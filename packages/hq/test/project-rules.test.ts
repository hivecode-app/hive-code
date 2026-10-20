// A project's workers run with that project's rules: a standing identity in the charter's first checkout,
// merge_instructions in place of the company's review + merge steps, commands.worktree_setup after
// `git worktree add` (a failure means no shift, and the opener hears why).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, until } from './helpers.ts';
import { buildSystemPrompt } from '../src/system-prompt.ts';
import { forCheckout, readCharter, Workspaces } from '../src/workspace.ts';
import type { IdentityRow } from '../src/org.ts';

const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'pr-'));
  const origin = join(dir, 'origin.git');
  const checkout = join(dir, 'proj');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'clone', '--quiet', origin, checkout);
  writeFileSync(join(checkout, '.gitignore'), '.worktrees/\nserver\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'init');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
  mkdirSync(join(checkout, 'server'));                         // untracked in the main checkout only
  return { dir, checkout, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const charter = (checkout: string, extra = '') => `---
project: proj
status: active
machine: ${hostname()}
checkouts:
  - name: proj
    path: ${checkout}
    default_branch: main
worktree_dir: .worktrees
commands:
  test: npm test
${extra}ci: required
ci_check: app
deviations: []
monitoring: []
grants: []
---

# proj
`;

const SETUP_OK = `  worktree_setup: ln -sfn "$COMPANY_CHECKOUT/server" server && [[ -d server ]] && echo done > .setup\n`;

test('a standing identity of a project runs in its first checkout; without one, in the default cwd', async () => {
  const r = repo();
  // ac-ceo (helpers ORG_YAML) belongs to agent-company.
  const env = await makeEnv({ projects: { 'agent-company': charter(r.checkout) } });
  try {
    const { hq, launcher, cfg } = env;
    await hq.shifts.request('ac-ceo', { reason: 'test' });
    assert.equal(launcher.launches.at(-1)!.cwd, r.checkout, 'the project CEO runs in the project checkout');
    await hq.shifts.request('yoav', { reason: 'test' });
    assert.equal(launcher.launches.at(-1)!.cwd, cfg.defaultCwd, 'no project: the default cwd');
  } finally { await env.cleanup(); r.cleanup(); }

  // Another machine: the default cwd, and the board hears why.
  const r2 = repo();
  const env2 = await makeEnv({ projects: { 'agent-company': charter(r2.checkout).replace(`machine: ${hostname()}`, 'machine: elsewhere') } });
  try {
    await env2.hq.shifts.request('ac-ceo', { reason: 'test' });
    assert.equal(env2.launcher.launches.at(-1)!.cwd, env2.cfg.defaultCwd);
    assert.ok(env2.hq.store.db.prepare(`SELECT 1 FROM events WHERE type = 'shift.project_cwd_failed'`).get());
  } finally { await env2.cleanup(); r2.cleanup(); }
});

test('task worker prompt: absolute skill paths by default; merge_instructions replace review and merge', () => {
  const d = mkdtempSync(join(tmpdir(), 'co-'));
  try {
    mkdirSync(join(d, 'projects'));
    writeFileSync(join(d, 'projects', 'plain.md'), charter('/x'));
    writeFileSync(join(d, 'projects', 'own.md'), charter('/x', 'merge_instructions:\n  - "סקירה עם `diff-reviewer` ו-`verifier`"\n  - "הערה `ship-step-4: reviewed <sha>` ומיזוג ב-`gh api -X PUT repos/o/r/pulls/N/merge`"\n'));
    writeFileSync(join(d, 'projects', 'one.md'), charter('/x', 'merge_instructions: "מיזוג לפי `.claude/skills/ship/SKILL.md` של ה-repo"\n'));
    const w = { id: 'plain-t1', name: 'דנה', title: 'מפתחת', symbol: 'build', team: null, team_kind: 'task', project: 'plain',
      reports_to: 'adi', lifecycle: 'ephemeral', source: 'runtime', active: 1, data: '{}', updated_at: 0 } as IdentityRow;
    const plain = buildSystemPrompt(d, w, 'yoav').split('\n---\n')[0]!;
    assert.ok(plain.includes(`\`${join(d, 'skills', 'reviewer', 'SKILL.md')}\``));
    assert.ok(plain.includes(`\`${join(d, 'skills', 'ship', 'SKILL.md')}\``));
    assert.match(plain, /gh pr merge --squash --delete-branch/);
    assert.match(plain, /\(`app`\) ירוקה/);
    assert.match(plain, /^5\. מדווחים/m);

    const own = buildSystemPrompt(d, { ...w, id: 'own-t1', project: 'own' }, 'yoav').split('\n---\n')[0]!;
    assert.match(own, /ship-step-4: reviewed <sha>/);
    assert.match(own, /gh api -X PUT/);
    assert.doesNotMatch(own, /gh pr merge|skills\/reviewer|skills\/ship/, 'no second, conflicting set of steps');
    assert.match(own, /^3\. סקירה ומיזוג לפי האמנה.*diff-reviewer/m);
    assert.match(own, /^4\. הערה `ship-step-4/m);
    assert.match(own, /^5\. מדווחים/m);
    const one = buildSystemPrompt(d, { ...w, id: 'one-t1', project: 'one' }, 'yoav').split('\n---\n')[0]!;
    assert.match(one, /^3\. .*\.claude\/skills\/ship/m);
    assert.match(one, /^4\. מדווחים/m);
    assert.doesNotMatch(one, /gh pr merge/);
    assert.equal(readCharter(d, 'plain')!.mergeInstructions, null);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('worktree_setup runs in the new worktree with COMPANY_CHECKOUT, also when a missing tree is brought back', async () => {
  const r = repo();
  try {
    const d = mkdtempSync(join(r.dir, 'company-'));
    mkdirSync(join(d, 'projects'));
    writeFileSync(join(d, 'projects', 'proj.md'), charter(r.checkout, SETUP_OK));
    const ch = readCharter(d, 'proj')!;
    assert.equal(ch.commands.worktree_setup?.startsWith('ln -sfn'), true);
    const ws = new Workspaces();
    const w = await ws.create(ch, ws.checkout(ch)!, 'company-t1');
    assert.equal(readlinkSync(join(w.path, 'server')), join(r.checkout, 'server'));
    assert.equal(readFileSync(join(w.path, '.setup'), 'utf8'), 'done\n', 'bash, not sh: [[ ]] works');
    rmSync(w.path, { recursive: true, force: true });
    assert.equal(await ws.ensure(w.path, r.checkout, ch), true);
    assert.equal(readlinkSync(join(w.path, 'server')), join(r.checkout, 'server'));
  } finally { r.cleanup(); }
});

test('a failing worktree_setup: no shift, the worktree is gone, the task leaves the queue and the opener hears the output', async () => {
  const r = repo();
  const env = await makeEnv({ projects: { proj: charter(r.checkout, "  worktree_setup: 'echo \"pub get: no network\" >&2; exit 3'\n") } });
  try {
    const { hq, launcher, cfg } = env;
    const t = hq.scheduler.addTask({ title: 'משימה', project: 'proj' });
    await hq.scheduler.fill();
    await until(() => /needs-decision/.test(hq.scheduler.task(t.id)!.labels), 5000, 'needs-decision');
    assert.equal(launcher.launches.some((l) => l.identity === `proj-t${t.id}`), false, 'the shift never starts');
    assert.notEqual(hq.scheduler.task(t.id)!.state, 'running');
    assert.equal(hq.scheduler.task(t.id)!.worktree, null);
    assert.equal(existsSync(join(r.checkout, '.worktrees', `company-t${t.id}`)), false, 'the half-made worktree is removed');
    assert.equal(git(r.checkout, 'branch', '--list', `company-t${t.id}`), '', 'and its empty branch');
    const told = hq.mailbox.list(cfg.managerId).find((m) => m.id.startsWith(`task-${t.id}-worktree-failed`));
    assert.match(told!.body, /worktree_setup failed/);
    assert.match(told!.body, /pub get: no network/);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('a slow worktree_setup holds only its own task: another task starts meanwhile', async () => {
  const r = repo();
  const r2 = repo();
  const gate = join(r.dir, 'go');
  const env = await makeEnv({ projects: {
    slow: charter(r.checkout, `  worktree_setup: 'while [[ ! -f "${gate}" ]]; do sleep 0.05; done'\n`),
    fast: charter(r2.checkout),
  } });
  try {
    const { hq } = env;
    hq.store.setToggle('scheduler', false);
    const a = hq.scheduler.addTask({ title: 'איטית', project: 'slow' });
    const b = hq.scheduler.addTask({ title: 'מהירה', project: 'fast' });
    hq.store.setToggle('scheduler', true);
    const first = hq.scheduler.fill();
    await until(() => hq.scheduler.task(b.id)!.state === 'running', 5000, 'the fast task runs while the slow setup waits');
    assert.equal(hq.scheduler.task(a.id)!.state, 'queued');
    assert.equal(hq.scheduler.isStarting(a.id), true);
    const running = hq.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND kind = 'work'`).get() as { n: number };
    assert.equal(hq.scheduler.slots().running, running.n + 1, 'the slot in setup is taken');
    await hq.scheduler.fill();                                    // a later pass does not wait for it, nor start it twice
    assert.equal(hq.scheduler.task(a.id)!.state, 'queued');
    writeFileSync(gate, '');
    assert.deepEqual((await first).sort(), [a.id, b.id].sort());
    assert.equal(hq.scheduler.task(a.id)!.state, 'running');
  } finally { await env.cleanup(); r.cleanup(); r2.cleanup(); }
});

test('a standing identity whose cwd changed gets a new shift, not a resume of a session that is not there', async () => {
  const r = repo();
  const env = await makeEnv();
  try {
    const { hq, launcher, cfg } = env;
    await hq.shifts.request('ac-ceo', { reason: 'test' });
    assert.equal(launcher.launches.at(-1)!.cwd, cfg.defaultCwd, 'no charter yet');
    const ran = () => hq.store.db.prepare(`UPDATE shifts SET host_seq = 1, run_start_seq = 1 WHERE id = 'ac-ceo-1'`).run(); // the session ran
    ran();
    await hq.shifts.stop('ac-ceo-1', 'rest');
    await hq.shifts.request('ac-ceo', { reason: 'message' });
    assert.equal(launcher.launches.at(-1)!.resume, true, 'same cwd: resume');
    ran();
    await hq.shifts.stop('ac-ceo-1', 'rest');
    writeFileSync(join(cfg.companyDir, 'projects', 'agent-company.md'), charter(r.checkout));
    await hq.shifts.request('ac-ceo', { reason: 'message' });
    const l = launcher.launches.at(-1)!;
    assert.equal(l.cwd, r.checkout);
    assert.equal(l.resume, false);
    assert.equal(l.shiftId, 'ac-ceo-2');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('worktree_setup: a failure when a missing tree is brought back keeps the branch and runs again next time; a timeout kills it', async () => {
  const r = repo();
  try {
    const d = mkdtempSync(join(r.dir, 'company-'));
    mkdirSync(join(d, 'projects'));
    const flag = join(r.dir, 'fail');
    writeFileSync(join(d, 'projects', 'proj.md'), charter(r.checkout, `  worktree_setup: '[[ ! -f "${flag}" ]] && touch .setup'\n`));
    const ch = readCharter(d, 'proj')!;
    const ws = new Workspaces();
    const w = await ws.create(ch, ws.checkout(ch)!, 'company-t1');
    rmSync(w.path, { recursive: true, force: true });
    writeFileSync(flag, '');
    await assert.rejects(ws.ensure(w.path, r.checkout, ch), /worktree_setup failed .*exit 1/);
    assert.equal(existsSync(w.path), false, 'the half-set-up tree is gone');
    assert.equal(git(r.checkout, 'branch', '--list', 'company-t1').trim(), 'company-t1', 'the branch stays');
    rmSync(flag);
    assert.equal(await ws.ensure(w.path, r.checkout, ch), true);
    assert.equal(existsSync(join(w.path, '.setup')), true, 'the setup ran again');

    const { runSetup } = await import('../src/workspace.ts');
    const pidFile = join(r.dir, 'child.pid');
    const t0 = Date.now();
    await assert.rejects(runSetup(r.dir, `sleep 30 & echo $! > "${pidFile}"; wait`, r.checkout, 300), /timed out/);
    assert.ok(Date.now() - t0 < 5000);
    const child = Number(readFileSync(pidFile, 'utf8'));
    await until(() => { try { process.kill(child, 0); return false; } catch { return true; } }, 3000, 'the child is killed too');
  } finally { r.cleanup(); }
});

test('a task closed while its worktree is being set up gets no worker, and its worktree goes', async () => {
  const r = repo();
  const gate = join(r.dir, 'go');
  const env = await makeEnv({ projects: { slow: charter(r.checkout, `  worktree_setup: 'while [[ ! -f "${gate}" ]]; do sleep 0.05; done'\n`) } });
  try {
    const { hq, launcher } = env;
    hq.store.setToggle('scheduler', false);
    const a = hq.scheduler.addTask({ title: 'תיסגר באמצע', project: 'slow' });
    hq.store.setToggle('scheduler', true);
    const fill = hq.scheduler.fill();
    await until(() => existsSync(join(r.checkout, '.worktrees', `company-t${a.id}`)), 5000, 'setup running');
    hq.scheduler.setTaskState(a.id, 'closed');
    writeFileSync(gate, '');
    assert.deepEqual(await fill, []);
    assert.equal(hq.scheduler.task(a.id)!.state, 'closed');
    assert.equal(launcher.launches.some((l) => l.identity === `slow-t${a.id}`), false);
    await until(() => !existsSync(join(r.checkout, '.worktrees', `company-t${a.id}`)), 5000, 'worktree removed');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('a second checkout with its own commands, ci_check and merge steps: its worktree and its note use them', async () => {
  const r = repo();
  const bot = repo();
  const second = `  - name: bot
    path: ${bot.checkout}
    default_branch: main
    repo: o/bot
    commands:
      test: go test ./...
    ci_check: null
    merge_instructions: default
`;
  const text = charter(r.checkout, SETUP_OK + 'merge_instructions:\n  - "מיזוג ב-`gh api -X PUT repos/o/proj/pulls/N/merge`"\n')
    .replace('worktree_dir:', `${second}worktree_dir:`);
  const env = await makeEnv({ projects: { proj: text } });
  try {
    const ch = readCharter(join(env.cfg.companyDir), 'proj')!;
    const [main, b] = ch.checkouts;
    assert.equal(main!.own, undefined, 'the first checkout inherits everything');
    assert.deepEqual(b!.own, { commands: { test: 'go test ./...' }, ciCheck: null, mergeInstructions: null });
    assert.equal(b!.repo, 'o/bot');
    const inBot = forCheckout(ch, b);
    assert.equal(inBot.commands.worktree_setup, undefined, "the top level's setup is not run in the bot repo");
    assert.equal(inBot.ciCheck, null);
    assert.equal(forCheckout(ch, main).ciCheck, 'app');

    const w = await env.hq.scheduler.prepareWorktree({ id: 901, project: 'proj', worktree: null, labels: '["repo:bot"]', started_at: null });
    assert.equal(w!.path, join(bot.checkout, '.worktrees', 'company-t901'));
    assert.equal(existsSync(join(w!.path, '.setup')), false);
    assert.match(w!.note, /go test/);
    assert.doesNotMatch(w!.note, /npm test|gh api -X PUT|`app`/);
    assert.match(w!.note, /אין בדיקת CI/);
    assert.match(w!.note, /^3\. סקירה בלתי תלויה/m);
    assert.match(w!.note, /^4\. .*gh pr merge --squash --delete-branch.*עברו מקומית/m);

    const m = await env.hq.scheduler.prepareWorktree({ id: 902, project: 'proj', worktree: null, labels: '[]', started_at: null });
    assert.equal(readFileSync(join(m!.path, '.setup'), 'utf8'), 'done\n');
    assert.match(m!.note, /npm test/);
    assert.match(m!.note, /`app` ירוקה/);
    assert.doesNotMatch(m!.note, /סקירה ומיזוג ב-repo הזה/, 'the first checkout: the steps are in the system prompt');
  } finally { await env.cleanup(); r.cleanup(); bot.cleanup(); }
});
