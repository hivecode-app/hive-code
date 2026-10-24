// scripts/lib/deploy-sha.sh: which commit scripts/deploy.sh puts live. A real origin with five commits on main, a
// production clone behind it, and deploy_sha_move called the way deploy.sh calls it (set -Eeuo pipefail, ERR trap).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const LIB = join(REPO, 'scripts/lib/deploy-sha.sh');
const git = 'git -c user.email=t@t -c user.name=t -c init.defaultBranch=main';
const sh = (cwd, cmd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' }).trim();

/** origin: A..E on main and a side branch X; prod: a clone at B. Returns {prod, shas}. */
function fixture() {
  const t = mkdtempSync(join(tmpdir(), 'deploy-sha-'));
  const origin = join(t, 'origin');
  sh(t, `${git} init -q origin`);
  const shas = {};
  for (const c of ['A', 'B', 'C', 'D', 'E']) {
    sh(origin, `echo ${c} >f && ${git} add f && ${git} commit -qm "${c} (#${c.charCodeAt(0)})"`);
    shas[c] = sh(origin, 'git rev-parse HEAD');
  }
  sh(origin, `${git} checkout -qb side ${shas.C} && echo X >f && ${git} commit -qam X && git checkout -q main`);
  shas.X = sh(origin, 'git rev-parse side');
  const prod = join(t, 'prod');
  sh(t, `${git} clone -q origin prod`);
  sh(prod, `git reset -q --hard ${shas.B}`);
  return { prod, shas };
}

/** deploy_sha_move as deploy.sh runs it: after a fetch, under set -Eeuo pipefail with an ERR trap. */
function move(prod, want = '') {
  const r = spawnSync('bash', ['-c', `set -Eeuo pipefail
trap 'echo "ERR trap: $BASH_COMMAND"; exit 9' ERR
source "${LIB}"
git fetch -q origin main side
deploy_sha_move "$1" || { echo "refused: $DEPLOY_SHA_ERR"; exit 1; }
echo "$DEPLOY_PREV $DEPLOY_SHA_TO $DEPLOY_MOVED"`, '_', want], { cwd: prod, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout + r.stderr).trim(), head: sh(prod, 'git rev-parse HEAD') };
}

test('--sha in the middle of the range, then a plain deploy continues from it', () => {
  const { prod, shas } = fixture();
  let r = move(prod, shas.D.slice(0, 10));
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `${shas.B} ${shas.D} 1`);
  assert.equal(r.head, shas.D);
  // What deploy.sh prints as the range deployed: C and D, not E.
  assert.deepEqual(sh(prod, `git log --format=%s ${shas.B}..${shas.D}`).split('\n'), ['D (#68)', 'C (#67)']);
  r = move(prod);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `${shas.D} ${shas.E} 1`);
});

test('the same sha again moves nothing; no sha at origin/main moves nothing', () => {
  const { prod, shas } = fixture();
  sh(prod, `git reset -q --hard ${shas.E}`);
  assert.equal(move(prod, shas.E).out, `${shas.E} ${shas.E} 0`);
  assert.equal(move(prod).out, `${shas.E} ${shas.E} 0`);
});

test('refuses, and moves nothing: not on origin/main, backwards, unknown, diverged', () => {
  const { prod, shas } = fixture();
  let r = move(prod, shas.X);
  assert.equal(r.code, 1);
  assert.match(r.out, /לא נמצא ב-origin\/main/);
  assert.equal(r.head, shas.B);

  r = move(prod, shas.A);
  assert.equal(r.code, 1);
  assert.match(r.out, /לא חוזרת אחורה/);
  assert.equal(r.head, shas.B);

  r = move(prod, 'deadbeef');
  assert.equal(r.code, 1);
  assert.match(r.out, /אין commit יחיד בשם deadbeef/);

  sh(prod, `echo L >f && ${git} commit -qam L`);
  const local = sh(prod, 'git rev-parse HEAD');
  r = move(prod, shas.D);
  assert.equal(r.code, 1);
  assert.match(r.out, /לא אב של/);
  r = move(prod);
  assert.equal(r.code, 1);
  assert.match(r.out, /התפצל/);
  assert.equal(r.head, local);
});

test('deploy.sh: --sha needs a value, and an unknown argument is a usage error (before anything runs)', () => {
  for (const args of [['hq', '--sha'], ['hq', '--bogus'], ['all', 'extra'], ['nope']]) {
    const r = spawnSync('bash', [join(REPO, 'scripts/deploy.sh'), ...args], { encoding: 'utf8' });
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /usage: .*--sha <sha>/);
  }
});

// deploy_move_or_reexec (#209): a range that changes scripts/deploy.sh runs the new copy, once, with the lock still held.
/** origin: A, B, then C that brings a new scripts/deploy.sh (a stub that prints what it got) and the real lib. prod at B. */
function reexecFixture() {
  const t = mkdtempSync(join(tmpdir(), 'deploy-reexec-'));
  const origin = join(t, 'origin');
  sh(t, `${git} init -q origin`);
  const shas = {};
  for (const c of ['A', 'B']) {
    sh(origin, `echo ${c} >f && ${git} add f && ${git} commit -qm ${c}`);
    shas[c] = sh(origin, 'git rev-parse HEAD');
  }
  sh(origin, `mkdir -p scripts/lib && cp "${LIB}" scripts/lib/ && cat >scripts/deploy.sh <<'STUB'
set -Eeuo pipefail
trap 'echo "ERR trap: $BASH_COMMAND"; exit 9' ERR
source "$(dirname "$0")/lib/deploy-sha.sh"
[[ "\${DEPLOY_REEXEC:-}" == 1 ]] || exec 9>"$LOCKFILE"
flock -n 9 || { echo "lock refused"; exit 1; }
deploy_move_or_reexec "$0" "$@" || { echo "refused: $DEPLOY_SHA_ERR"; exit 1; }
echo "new run: $DEPLOY_PREV $DEPLOY_SHA_TO $DEPLOY_MOVED args=$*"
flock -n "$LOCKFILE" true && echo "lock free" || echo "lock held"
env | grep -c '^DEPLOY_' || true
STUB
${git} add scripts && ${git} commit -qm C`);
  shas.C = sh(origin, 'git rev-parse HEAD');
  sh(origin, `echo D >f && ${git} commit -qam D`);
  shas.D = sh(origin, 'git rev-parse HEAD');
  const prod = join(t, 'prod');
  sh(t, `${git} clone -q origin prod`);
  sh(prod, `git reset -q --hard ${shas.B}`);
  return { prod, shas, lock: join(t, 'lock') };
}

/** The deploy.sh already running (the old copy): takes the lock on fd 9 and calls deploy_move_or_reexec. */
function oldRun(prod, lock, want = '', env = {}) {
  const r = spawnSync('bash', ['-c', `set -Eeuo pipefail
trap 'echo "ERR trap: $BASH_COMMAND"; exit 9' ERR
source "${LIB}"
exec 9>"$LOCKFILE"; flock -n 9
git fetch -q origin main
want_sha="$1"
deploy_move_or_reexec "$PWD/scripts/deploy.sh" hq --sha "$1" || { echo "refused: $DEPLOY_SHA_ERR"; exit 1; }
echo "old run went on: $DEPLOY_PREV $DEPLOY_SHA_TO $DEPLOY_MOVED"`, '_', want], {
    cwd: prod, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, LOCKFILE: lock, ...env },
  });
  return { code: r.status, out: (r.stdout + r.stderr).trim(), head: sh(prod, 'git rev-parse HEAD') };
}

test('a range that changes scripts/deploy.sh runs the new copy once, with the move, the args and the lock', () => {
  const { prod, shas, lock } = reexecFixture();
  const r = oldRun(prod, lock, shas.D);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /old run went on/);
  assert.equal(r.out.match(/ממשיך עם הגרסה/g)?.length, 1, r.out);
  assert.equal(r.out.match(/new run:/g)?.length, 1, r.out);
  assert.match(r.out, new RegExp(`new run: ${shas.B} ${shas.D} 1 args=hq --sha ${shas.D}`));
  assert.match(r.out, /lock held/);
  // The markers are not exported to what the new run starts (checks, builds).
  assert.match(r.out, /\n0$/);
  assert.equal(r.head, shas.D);
});

test('a range that does not touch the scripts goes on in the same run', () => {
  const { prod, shas, lock } = reexecFixture();
  sh(prod, `git reset -q --hard ${shas.C}`);
  const r = oldRun(prod, lock);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out, `old run went on: ${shas.C} ${shas.D} 1`);
});

test('DEPLOY_REEXEC=1 without matching DEPLOY_PREV/DEPLOY_SHA_TO is refused and moves nothing', () => {
  const { prod, shas, lock } = reexecFixture();
  for (const env of [{ DEPLOY_REEXEC: '1' }, { DEPLOY_REEXEC: '1', DEPLOY_PREV: shas.A, DEPLOY_SHA_TO: shas.D }]) {
    const r = oldRun(prod, lock, '', env);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /refused: הרצה חוזרת \(DEPLOY_REEXEC\)/);
    assert.equal(r.head, shas.B);
  }
});

test('deploy.sh: DEPLOY_REEXEC=1 without the inherited lock fd is refused', () => {
  const t = mkdtempSync(join(tmpdir(), 'deploy-nofd-'));
  const r = spawnSync('bash', [join(REPO, 'scripts/deploy.sh'), 'hq'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: t, DEPLOY_REEXEC: '1', XDG_RUNTIME_DIR: t },
  });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /DEPLOY_REEXEC=1 בלי הנעילה/);
});

/** The real deploy.sh, end to end up to the move: HOME is a temp dir with the production checkout at
 *  ~/projects/agent-company, at B (this tree's deploy.sh and lib); origin/main is C, whose deploy.sh is this one with
 *  `edit` applied. */
function realDeploy(edit) {
  const home = mkdtempSync(join(tmpdir(), 'deploy-real-'));
  const origin = join(home, 'origin');
  sh(home, `${git} init -q origin && mkdir -p origin/scripts && cp -r "${join(REPO, 'scripts/lib')}" "${join(REPO, 'scripts/deploy.sh')}" origin/scripts/`);
  sh(origin, `${git} add -A && ${git} commit -qm B`);
  const B = sh(origin, 'git rev-parse HEAD');
  sh(origin, `${edit} && ${git} commit -qam C`);
  const C = sh(origin, 'git rev-parse HEAD');
  const prod = join(home, 'projects/agent-company');
  sh(home, `mkdir -p projects && ${git} clone -q origin projects/agent-company && git -C projects/agent-company reset -q --hard ${B}`);
  const r = spawnSync('bash', [join(prod, 'scripts/deploy.sh'), 'hq', '--sha', C.slice(0, 12)], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, XDG_RUNTIME_DIR: home },
  });
  return { B, C, code: r.status, out: (r.stdout + r.stderr).trim(), head: sh(prod, 'git rev-parse HEAD') };
}

test('deploy.sh itself: the new copy takes over right after the move, with the original arguments', () => {
  const marker = `echo "NEW RUN $prev_sha $sha $moved_checkout args=\${orig_args[*]}"; exit 0`;
  const r = realDeploy(`sed -i '/^prev_sha="\\$DEPLOY_PREV"/a ${marker.replace(/'/g, `'\\''`)}' scripts/deploy.sh`);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.out.match(/NEW RUN/g)?.length, 1, r.out);
  assert.match(r.out, new RegExp(`NEW RUN ${r.B} ${r.C} 1 args=hq --sha ${r.C.slice(0, 12)}`));
  assert.equal(r.head, r.C);
});

test('deploy.sh itself: the new copy failing before it reaches the move still puts the checkout back', () => {
  const r = realDeploy(`sed -i 's/^# ── preflight/false\\n&/' scripts/deploy.sh`);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /ממשיך עם הגרסה/);
  assert.match(r.out, /ה-checkout חזר ל-/);
  assert.equal(r.head, r.B);
});
