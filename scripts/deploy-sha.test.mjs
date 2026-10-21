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
