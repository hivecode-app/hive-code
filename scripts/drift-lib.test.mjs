// scripts/drift-lib.mjs: waiting for GO is not drift; a manual pull, a dirty file are.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { checkoutDrift, pendingCommits, pendingLines, incidentTitle } from './drift-lib.mjs';

const git = 'git -c user.email=t@t -c user.name=t -c init.defaultBranch=main';
const sh = (cwd, cmd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' }).trim();

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** origin with A(#1) B(#2) C(#3) D(#4); prod cloned and reset to B. */
function fixture() {
  const t = mkdtempSync(join(tmpdir(), 'drift-'));
  made.push(t);
  const origin = join(t, 'origin');
  sh(t, `${git} init -q origin`);
  const shas = {};
  for (const [i, c] of ['A', 'B', 'C', 'D'].entries()) {
    sh(origin, `echo ${c} >f && ${git} add f && ${git} commit -qm "${c} (#${i + 1})"`);
    shas[c] = sh(origin, 'git rev-parse HEAD');
  }
  sh(t, `${git} clone -q origin prod`);
  const prod = join(t, 'prod');
  sh(prod, `git reset -q --hard ${shas.B}`);
  return { prod, shas };
}

test('behind main, all merged PRs waiting for a GO: no drift, shown as waiting', () => {
  const { prod, shas } = fixture();
  assert.deepEqual(checkoutDrift(prod, [shas.B]), []);
  const c = pendingCommits(prod, shas.B, shas.D, ['3', '4']);
  assert.deepEqual(c.map((x) => [x.pr, x.waiting]), [['4', true], ['3', true]]);
  assert.match(pendingLines(c).join('\n'), /ממתינים ל-GO/);
});

test('merged without a GO or awaiting: still no drift, reported as merged and not deployed', () => {
  const { prod, shas } = fixture();
  assert.deepEqual(checkoutDrift(prod, [shas.B]), []);
  const lines = pendingLines(pendingCommits(prod, shas.B, shas.D, ['4']));
  assert.match(lines.join('\n'), /ממתינים ל-GO[^]*D \(#4\)[^]*מוזגו ולא נפרסו[^]*C \(#3\)/);
});

test('a manual git pull is drift', () => {
  const { prod, shas } = fixture();
  sh(prod, 'git pull -q --ff-only origin main');
  const d = checkoutDrift(prod, [shas.B]);
  assert.equal(d.length, 1);
  assert.match(d[0].short, /עודכנה ידנית/);
  assert.doesNotMatch(incidentTitle(d), /[0-9a-f]{7}|\//, 'the owner line has no sha and no path');
});

test('a deploy of another target (app/caddy) that moved the checkout is not drift', () => {
  const { prod, shas } = fixture();
  sh(prod, 'git pull -q --ff-only origin main');
  assert.deepEqual(checkoutDrift(prod, [shas.B, shas.D]), []);
});

test('a file edited in the checkout is drift', () => {
  const { prod, shas } = fixture();
  writeFileSync(join(prod, 'f'), 'hand edit');
  const d = checkoutDrift(prod, [shas.B]);
  assert.match(d[0].short, /שונו ביד/);
});

test('nothing left to deploy: empty summary, no drift', () => {
  const { prod, shas } = fixture();
  sh(prod, 'git pull -q --ff-only origin main');
  assert.deepEqual(checkoutDrift(prod, [shas.D]), []);
  assert.deepEqual(pendingLines(pendingCommits(prod, shas.D, shas.D, [])), []);
});

test('no record of a deploy is drift; one item or many make one line', () => {
  const { prod } = fixture();
  assert.equal(checkoutDrift(prod, []).length, 1);
  assert.equal(incidentTitle([{ short: 'א' }, { short: 'ב' }, { short: 'ג' }]), 'בפרודקשן: א, ועוד 2');
});
