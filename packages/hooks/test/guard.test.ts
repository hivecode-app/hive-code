import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashWrite, checkToolUse, companyRoot, GUARD_MATCHER, protectedRoot } from '../src/index.ts';

const HOME = '/home/u';
const ROOT = `${HOME}/projects/agent-company`;
const WT = `${ROOT}/.worktrees/company-t9`;
const env = { home: HOME, identity: 'ron' };
const write = (file_path: string, cwd = WT) => checkToolUse({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd }, env);
const bash = (command: string, cwd = WT, e: Record<string, string> = env) => checkToolUse({ tool_name: 'Bash', tool_input: { command }, cwd }, e);

test('Write/Edit/NotebookEdit into the main checkout are blocked, worktrees and elsewhere pass', () => {
  assert.match(write(`${ROOT}/memory/projects/lumo-bot/open-ron.md`)!, /remember/);
  assert.match(write('~/projects/agent-company/company/identities/ron.md')!, /main checkout/);
  assert.ok(write('open-ron.md', `${ROOT}/memory/projects/lumo-bot`), 'relative path resolved against cwd');
  assert.ok(write(ROOT + '/x/../README.md'));
  assert.ok(checkToolUse({ tool_name: 'Edit', tool_input: { file_path: `${ROOT}/README.md`, old_string: 'a', new_string: 'b' } }, env));
  assert.ok(checkToolUse({ tool_name: 'NotebookEdit', tool_input: { notebook_path: `${ROOT}/n.ipynb` } }, env));
  assert.equal(write(`${WT}/memory/projects/lumo-bot/open-ron.md`), null);
  assert.equal(write(`${ROOT}-other/README.md`), null, 'a sibling directory with the same prefix');
  assert.equal(write(`${HOME}/projects/lumo-bot/README.md`), null);
  assert.equal(write('/tmp/x.md', ROOT), null);
  assert.equal(checkToolUse({ tool_name: 'Read', tool_input: { file_path: `${ROOT}/README.md` } }, env), null);
  assert.equal(checkToolUse({ tool_name: 'Write', tool_input: {} }, env), null);
});

test('the protected root follows COMPANY_REPO, and a worktree as COMPANY_REPO protects nothing', () => {
  assert.equal(protectedRoot({ home: HOME }), ROOT);
  assert.equal(protectedRoot({ home: HOME, repo: '/srv/ac' }), '/srv/ac');
  assert.equal(protectedRoot({ home: HOME, repo: WT }), null);
  assert.ok(checkToolUse({ tool_name: 'Write', tool_input: { file_path: '/srv/ac/a' } }, { home: HOME, repo: '/srv/ac' }));
  assert.equal(checkToolUse({ tool_name: 'Write', tool_input: { file_path: `${ROOT}/a` } }, { home: HOME, repo: '/srv/ac' }), null);
});

test('Bash: redirections, tee, sed -i and git commit into the main checkout', () => {
  const blocked = [
    [`echo hi > ${ROOT}/memory/x.md`, WT],
    [`echo hi >> ~/projects/agent-company/memory/x.md`, WT],
    ['echo hi>memory/x.md', ROOT],
    ['printf x 2> err.log', ROOT],
    ['cmd &> out.txt', ROOT],
    [`cat > ${ROOT}/memory/x.md <<'EOF'\nline\nEOF`, WT],
    [`echo x | tee -a ${ROOT}/memory/x.md`, WT],
    [`echo x | tee /tmp/a "${ROOT}/memory/x.md"`, WT],
    [`sed -i 's/a/b/' ${ROOT}/memory/x.md`, WT],
    ['sed -i.bak -e s/a/b/ memory/x.md', ROOT],
    ['git commit -m "fix"', ROOT],
    ['git -c user.name=x commit -am wip', `${ROOT}/memory`],
    [`git -C ${ROOT} commit -m x`, WT],
    [`cd ${ROOT} && git add . && git commit -m x`, WT],
    ['cd ~/projects/agent-company; echo x > a.md', '/tmp'],
    [`(cd ${ROOT} && git commit -m x)`, WT],
    [`FOO=1 git -C ${ROOT} commit -m x`, WT],
    ['(cd /tmp && :); echo y > memory/a.md', ROOT],
    [`cp /tmp/a.md ${ROOT}/memory/a.md`, WT],
    ['mv /tmp/a.md memory/', ROOT],
    [`cp -t ${ROOT}/memory /tmp/a.md`, WT],
    ['echo x > "$HOME/projects/agent-company/memory/a.md"', WT],
    ['echo $(echo x > memory/a.md)', ROOT],
    ['x=$(git commit -am y)', ROOT],
    ['echo `sed -i s/a/b/ memory/a.md`', ROOT],
    ['echo "$(cd /tmp && :) $(tee memory/a.md < /dev/null)"', ROOT],
    ['cp -rt memory /tmp/a.md', ROOT],
  ];
  for (const [c, cwd] of blocked) assert.ok(bash(c!, cwd), `should block: ${c} (cwd ${cwd})`);

  const allowed = [
    ['echo hi > /tmp/x', ROOT],
    ['ls -la 2>&1 | head', ROOT],
    ['cat README.md > /dev/null', ROOT],
    ['git status && git log --oneline -3', ROOT],
    ['git commit -m x', WT],
    [`git -C ${WT} commit -m x`, ROOT],
    [`echo x > ${WT}/memory/x.md`, ROOT],
    ['node -e "const f = (a) => a > 1"', ROOT],
    ["echo 'a > b' && grep -n '>' README.md", ROOT],
    [`cat > /tmp/f.ts <<'EOF'\nconst x = a > b;\necho y > memory/x.md\nEOF\nnode /tmp/f.ts`, ROOT],
    [`cd ${WT} && echo x > memory/x.md && git commit -am x`, ROOT],
    ['sed -n 1,20p memory/x.md', ROOT],
    [`sed -i s/a/b/ /tmp/x`, ROOT],
    ['tee /tmp/a < README.md', ROOT],
    ['git log --grep commit', ROOT],
    ['echo "$(git rev-parse HEAD)" > /tmp/sha', ROOT],
    ['out=$(mktemp); gh pr view 1 --json body > "$out"', ROOT],
    ['gh pr view 1 > $TMPDIR/x.json', ROOT],
    ['f=/tmp/body.md; printf hi > $f', ROOT],
    ['echo `date` > /tmp/d', ROOT],
    ['(( n > 5 )) && echo big', ROOT],
    ['[[ $a > $b ]] && echo later', ROOT],
    ['x=$(( 3 > 2 )); echo $x', ROOT],
    ['echo "$(cat a > /dev/null; echo ok)"', ROOT],
    [`(cd ${ROOT} && git log -1) > /tmp/log`, WT],
    ['cp memory/a.md /tmp/', ROOT],
    ["gh pr comment 1 --body 'the hook blocks `echo x > memory/a.md` now'", ROOT],
    ["echo '$(echo x > memory/a.md)'", ROOT],
    ['echo "\\$(echo x > memory/a.md)"', ROOT],
    [`cp ${ROOT}/memory/a.md ${WT}/memory/a.md`, ROOT],
  ];
  for (const [c, cwd] of allowed) assert.equal(bash(c!, cwd), null, `should pass: ${c} (cwd ${cwd})`);
});

test('adi may run scripts/deploy.sh from the main checkout; only that command, and nobody else', () => {
  const adi = { home: HOME, identity: 'adi' };
  assert.equal(bash('scripts/deploy.sh all 2>&1 | tee /tmp/deploy.log', ROOT, adi), null);
  assert.equal(bash(`cd ${ROOT} && ./scripts/deploy.sh hq`, WT, adi), null);
  assert.equal(bash(`bash ${ROOT}/scripts/deploy.sh`, WT, adi), null);
  assert.ok(bash('scripts/deploy.sh all 2>&1 | tee deploy.log', ROOT, adi), 'a log in the checkout makes the next deploy refuse');
  assert.ok(bash('echo x > memory/a.md; scripts/deploy.sh', ROOT, adi));
  assert.ok(bash('echo scripts/deploy.sh > memory/a.md', ROOT, adi), 'only running it is exempt');
  assert.ok(bash('git commit -m scripts/deploy.sh', ROOT, adi));
  assert.equal(bash('scripts/deploy.sh all > deploy.log', ROOT, adi), null, 'the deploy command itself, redirect included');
  assert.ok(bash('scripts/deploy.sh all > deploy.log', ROOT, { home: HOME, identity: 'ron' }));
  assert.ok(bash('git commit -m x', ROOT, adi));
  assert.ok(checkToolUse({ tool_name: 'Write', tool_input: { file_path: `${ROOT}/a.md` } }, adi));
});

test('git that moves HEAD in the main checkout is blocked with what to do instead; worktrees and reads pass', () => {
  const CO = `${HOME}/company`;
  const e = { home: HOME, identity: 'ron', company: '~/company' };
  for (const sub of ['pull -q', 'checkout main', 'checkout -- README.md', 'switch -c x', 'reset --hard origin/main', 'merge origin/main',
    'rebase origin/main', 'restore .']) {
    const r = bash(`git ${sub}`, ROOT, e);
    assert.ok(r, `should block: git ${sub} in ${ROOT}`);
    assert.match(r!, /show origin\/main:/);
    assert.match(r!, /worktree/);
    assert.match(r!, /shift-host/);
    assert.ok(bash(`git -C ~/projects/agent-company ${sub}`, '/tmp', e), `should block: git -C ${ROOT} ${sub}`);
    assert.match(bash(`git -C ${CO} ${sub}`, WT, e)!, /of the company/, `should block: git -C ${CO} ${sub}`);
    assert.equal(bash(`git ${sub}`, WT, e), null, `should pass in a worktree: git ${sub}`);
    assert.equal(bash(`git -C ${CO}/.worktrees/t1 ${sub}`, ROOT, e), null);
  }
  assert.ok(bash('git pull', `${ROOT}/packages/hq`, e), 'a subdirectory of the checkout');
  assert.ok(bash(`cd ${ROOT} && git fetch -q && git pull -q`, WT, e));
  assert.ok(bash('git -c pull.rebase=true --no-pager pull', ROOT, e));
  assert.ok(bash('git pull', ROOT, { home: HOME, identity: 'adi' }), 'adi too: only deploy.sh moves it');
  for (const c of [`git -C ${ROOT} log --oneline -3`, `git -C ${ROOT} show origin/main:package.json`, 'git fetch origin', 'git status',
    'git diff origin/main', 'git log --grep pull', `git worktree add -b t .worktrees/t origin/main`, 'git branch -a', 'git stash list']) {
    assert.equal(bash(c, ROOT, e), null, `should pass: ${c}`);
  }
  assert.equal(bash('scripts/deploy.sh all', ROOT, { home: HOME, identity: 'adi' }), null, 'the deploy itself still runs');
});

test('bashWrite reports what it saw', () => {
  assert.match(bashWrite('git commit -m x', ROOT, ROOT, HOME)!, /git commit/);
  assert.match(bashWrite('echo > a', ROOT, ROOT, HOME)!, new RegExp(`${ROOT}/a`));
});

test('the matcher is the one the adapter registers (packages/adapter PRE_TOOL_USE_MATCHER)', () => {
  assert.equal(GUARD_MATCHER, 'Write|Edit|NotebookEdit|Bash');
});

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
function runCli(stdin: string, e: Record<string, string>): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'hook', 'PreToolUse'], { env: { PATH: process.env.PATH ?? '', ...e }, stdio: ['pipe', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(stdin);
  });
}

test('CLI: a write into the main checkout is denied with the Hebrew reason and spooled; others pass silently', async () => {
  const state = mkdtempSync(join(tmpdir(), 'guard-test-'));
  const repo = mkdtempSync(join(tmpdir(), 'guard-repo-'));
  const e = { COMPANY_STATE_DIR: state, COMPANY_SHIFT: 'ron-2', COMPANY_REPO: repo, COMPANY_IDENTITY: 'ron', HOME: tmpdir() };
  const denied = await runCli(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${repo}/memory/a.md` } }), e);
  assert.equal(denied.code, 0);
  const out = JSON.parse(denied.stdout) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /`remember` with `file`/);
  const spool = join(state, 'shifts', 'ron-2', 'spool');
  const lines = readdirSync(spool).flatMap((f) => readFileSync(join(spool, f), 'utf8').split('\n').filter(Boolean));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).event, 'PreToolUse.denied');

  const ok = await runCli(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: `${repo}/.worktrees/t/a.md` } }), e);
  assert.equal(ok.code, 0);
  assert.equal(ok.stdout, '');
  const garbage = await runCli('not json', e);
  assert.equal(garbage.code, 0);
  assert.equal(garbage.stdout, '');
});

test('COMPANY_HOME outside the engine is protected too; inside it (before the split) or a worktree adds nothing', () => {
  const CO = `${HOME}/company`;
  const e = { home: HOME, identity: 'adi', company: '~/company' };
  assert.equal(companyRoot(e), CO);
  assert.match(checkToolUse({ tool_name: 'Write', tool_input: { file_path: `${CO}/memory/x.md` } }, e)!, /COMPANY_HOME/);
  assert.match(checkToolUse({ tool_name: 'Bash', tool_input: { command: 'echo x >> memory/a.md' }, cwd: CO }, e)!, /COMPANY_HOME/);
  assert.match(checkToolUse({ tool_name: 'Bash', tool_input: { command: `git -C ${CO} commit -m x` }, cwd: '/tmp' }, e)!, /COMPANY_HOME/);
  assert.match(checkToolUse({ tool_name: 'Write', tool_input: { file_path: `${ROOT}/a` } }, e)!, /agent-company/, 'the engine is still guarded');
  assert.equal(checkToolUse({ tool_name: 'Write', tool_input: { file_path: `${CO}/.worktrees/t1/memory/x.md` } }, e), null);
  assert.equal(checkToolUse({ tool_name: 'Bash', tool_input: { command: 'scripts/deploy.sh hq' }, cwd: ROOT }, e), null, 'the deployer still deploys');
  assert.equal(companyRoot({ home: HOME, company: ROOT }), null, 'before the split COMPANY_HOME is the engine repo');
  assert.equal(companyRoot({ home: HOME, company: `${CO}/.worktrees/t1` }), null);
  assert.equal(companyRoot({ home: HOME }), null);
});
