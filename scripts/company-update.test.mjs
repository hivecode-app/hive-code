// company-update.sh end to end, against a fake install: a local engine "origin" with tags, engine/<tag> + current,
// a company repo, and stubs for systemctl, curl and npm (scripts/lib/hq-restart.sh calls them). The engine-side steps
// (scripts/engine.mjs) are stubbed too: they have tests of their own (engine.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, copyFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

const REPO = join(import.meta.dirname, '..');
const sh = (cwd, cmd) => execFileSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' });
const git = 'git -c user.email=t@t -c user.name=t -c init.defaultBranch=main';

// The stub engine.mjs: org-plan from $FAKE_ORG_PLAN, Claude pin from the engine's own `pin` file.
const ENGINE_STUB = `#!/usr/bin/env node
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, a, b] = process.argv.slice(2);
if (cmd === 'latest-tag') console.log(process.env.FAKE_LATEST ?? '');
if (cmd === 'pinned-claude') console.log(readFileSync(join(root, 'pin'), 'utf8').trim());
if (cmd === 'org-plan') console.log(process.env.FAKE_ORG_PLAN ?? 'ok 1 1');
if (cmd === 'org-migrate') { if (process.env.FAKE_MIGRATE_FAIL) process.exit(1); const f = join(a, 'company/org.yaml'); writeFileSync(f, readFileSync(f, 'utf8').replace('version: 1', 'version: 2')); console.log('body'); }
if (cmd === 'events-seq') console.log(5);
if (cmd === 'shifts-rested' && process.env.FAKE_RESTED) console.log(process.env.FAKE_RESTED);
if (cmd === 'db-backup') copyFileSync(a, b);
if (cmd === 'db-migrate-dry') console.log('14 15');
`;

function fixture() {
  const t = mkdtempSync(join(tmpdir(), 'company-update-'));
  const bin = join(t, 'bin'); const log = join(t, 'calls.log');
  mkdirSync(bin);
  // systemctl: logs every call; the active shifts come from $T/shifts (and $T/shifts-after once hq restarted).
  writeFileSync(join(bin, 'systemctl'), `#!/usr/bin/env bash
echo "systemctl $*" >>"${log}"
if [[ "$*" == *ActiveEnterTimestamp* ]]; then if [[ "$*" == *--timestamp=unix* ]]; then cat "${t}/shift-start" 2>/dev/null; else echo 'Tue 2026-10-20 23:36:43 IDT'; fi; exit 0; fi
if [[ "$*" == *list-units* && -n "$FAKE_LIST_FAIL" ]]; then exit 1; fi
if [[ "$*" == *list-units* ]]; then if [[ -f "${t}/restarted" && -f "${t}/shifts-after" ]]; then cat "${t}/shifts-after"; else cat "${t}/shifts"; fi; fi
if [[ "$*" == *restart* ]]; then touch "${t}/restarted"; fi
exit 0`);
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
if [[ "$*" == *http_code* ]]; then echo 200; else echo '{"live_shifts":1}'; fi`);
  writeFileSync(join(bin, 'npm'), '#!/usr/bin/env bash\nexit 0');
  for (const f of ['systemctl', 'curl', 'npm']) chmodSync(join(bin, f), 0o755);
  writeFileSync(join(t, 'shifts'), 'company-shift@yoav-3.service loaded active running x\n');

  // The engine's origin: two tags, each with its own Claude pin.
  const origin = join(t, 'origin');
  mkdirSync(join(origin, 'scripts/lib'), { recursive: true });
  for (const f of ['company-update.sh', 'lib/hq-restart.sh', 'lib/engine-install.sh', 'lib/web-placeholder.html']) copyFileSync(join(REPO, 'scripts', f), join(origin, 'scripts', f));
  writeFileSync(join(origin, 'scripts/engine.mjs'), ENGINE_STUB);
  writeFileSync(join(origin, 'scripts/company-home.mjs'), 'console.log(process.env.COMPANY_HOME)\n');
  writeFileSync(join(origin, 'scripts/check-contract.mjs'), 'process.exit(process.env.FAKE_CHECK_FAIL ? 1 : 0)\n');
  writeFileSync(join(origin, 'scripts/verify-prod.mjs'), `if (process.env.FAKE_VERIFY_FAIL) { console.log('✗ api'); process.exit(1) } console.log('✓ api'); console.log('כל הבדיקות עברו.')\n`);
  writeFileSync(join(origin, 'scripts/install-claude.sh'), `#!/usr/bin/env bash
set -e; root="$AGENT_COMPANY_DATA/claude"; mkdir -p "$root/$1"; ln -sfn "$1" "$root/current"`);
  chmodSync(join(origin, 'scripts/install-claude.sh'), 0o755);
  chmodSync(join(origin, 'scripts/company-update.sh'), 0o755);
  writeFileSync(join(origin, 'pin'), '2.1.303\n');
  sh(origin, `${git} init -q && ${git} add -A && ${git} commit -qm one && git tag v1.0.0`);
  writeFileSync(join(origin, 'pin'), '2.1.400\n');
  sh(origin, `${git} commit -qam two && git tag v1.1.0`);

  // The install: v1.0.0 live, Claude 2.1.303 live, a state with hq.db, a company repo.
  const data = join(t, 'data'); const engines = join(data, 'engine');
  mkdirSync(engines, { recursive: true });
  // Installed the way the installer does it (the same scripts/lib/engine-install.sh).
  sh(t, `source ${join(REPO, 'scripts/lib/engine-install.sh')} && PATH=${bin}:$PATH engine_install ${origin} v1.0.0 ${engines}`);
  symlinkSync('v1.0.0', join(engines, 'current'));
  mkdirSync(join(data, 'claude/2.1.303'), { recursive: true });
  symlinkSync('2.1.303', join(data, 'claude/current'));
  const state = join(t, 'state');
  mkdirSync(state);
  writeFileSync(join(state, 'hq.db'), 'db');
  const home = join(t, 'company');
  mkdirSync(join(home, 'company'), { recursive: true });
  writeFileSync(join(home, 'company/org.yaml'), 'version: 1\n');
  sh(home, `${git} init -q && ${git} add -A && ${git} commit -qm init`);

  const run = (args = [], env = {}) => spawnSync(join(engines, 'current/scripts/company-update.sh'), args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_COMPANY_DATA: data, COMPANY_STATE: state, COMPANY_HOME: home,
      HQ_HEALTH_TRIES: '2', FAKE_LATEST: 'v1.1.0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env },
  });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8') : '');
  return { t, data, engines, state, home, run, calls, done: () => rmSync(t, { recursive: true, force: true }) };
}

test('update: new tag in its own dir, checked, Claude pinned, switched, hq restarted, verified', () => {
  const f = fixture();
  try {
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.1.0');
    assert.equal(readlinkSync(join(f.data, 'claude/current')), '2.1.400');
    assert.ok(existsSync(join(f.engines, 'v1.0.0')), 'the previous engine stays');
    assert.match(f.calls(), /restart agent-company-hq/);
    assert.match(f.calls(), /try-restart agent-company-web\.service/);
    const summary = readFileSync(join(f.state, 'update/last-summary.txt'), 'utf8');
    assert.match(summary, /ל-v1\.1\.0 הצליח/);
    assert.match(summary, /migrations 14→15/);
    assert.ok(readFileSync(join(f.state, 'update/last-summary.txt'), 'utf8').includes('גיבוי'));
    // Again: nothing to do.
    const again = f.run();
    assert.equal(again.status, 0);
    assert.match(again.stdout, /כבר בגרסה v1\.1\.0/);
  } finally { f.done(); }
});

test('update: verify fails after the switch, so engine and Claude go back and hq restarts on the old one', () => {
  const f = fixture();
  try {
    const r = f.run([], { FAKE_VERIFY_FAIL: '1' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.0.0');
    assert.equal(readlinkSync(join(f.data, 'claude/current')), '2.1.303');
    assert.equal(f.calls().match(/restart agent-company-hq/g).length, 2);
    assert.match(r.stdout, /engine\/current חזר ל-v1\.0\.0/);
  } finally { f.done(); }
});

test('update: a shift that falls in the restart is a failure, and rolls back', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.t, 'shifts-after'), '');
    const r = f.run();
    assert.equal(r.status, 1);
    assert.match(r.stdout, /משמרות נפלו ב-restart: company-shift@yoav-3/);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.0.0');
  } finally { f.done(); }
});

test('update: a shift hq itself put to rest after the restart did not fall, so the update stands', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.t, 'shifts-after'), '');
    const r = f.run([], { FAKE_RESTED: 'company-shift@yoav-3.service' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.1.0');
  } finally { f.done(); }
});

test('update: only the unit with no rest record fails, though another one was rested', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.t, 'shifts'), 'company-shift@yoav-3.service loaded active running x\ncompany-shift@dana-3.service loaded active running x\n');
    writeFileSync(join(f.t, 'shifts-after'), '');
    const r = f.run([], { FAKE_RESTED: 'company-shift@dana-3.service' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /משמרות נפלו ב-restart: company-shift@yoav-3\.service/);
    assert.doesNotMatch(r.stdout, /נפלו[^\n]*dana-3/);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.0.0');
  } finally { f.done(); }
});

test('update: when systemd cannot list the shifts, hq is not restarted and the update rolls back', () => {
  const f = fixture();
  try {
    const r = f.run([], { FAKE_LIST_FAIL: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /לא הצלחתי לקרוא את יחידות המשמרות לפני ה-restart/);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.0.0');
  } finally { f.done(); }
});

test('update: company check fails on the new engine, so nothing is switched or restarted', () => {
  const f = fixture();
  try {
    const r = f.run([], { FAKE_CHECK_FAIL: '1' });
    assert.equal(r.status, 1);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.0.0');
    assert.equal(readlinkSync(join(f.data, 'claude/current')), '2.1.303');
    assert.doesNotMatch(f.calls(), /restart/);
  } finally { f.done(); }
});

test('update: an org.yaml format change waits on a branch in the company repo; main and the engine are untouched', () => {
  const f = fixture();
  try {
    const r = f.run([], { FAKE_ORG_PLAN: 'migrate 1 2' });
    assert.equal(r.status, 3, r.stdout + r.stderr);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.0.0');
    assert.equal(readFileSync(join(f.home, 'company/org.yaml'), 'utf8'), 'version: 1\n', 'main is not rewritten');
    assert.equal(sh(f.home, 'git show engine-update/org-v2:company/org.yaml'), 'version: 2\n');
    assert.equal(sh(f.home, 'git worktree list').trim().split('\n').length, 1, 'the temporary worktree is gone');
    assert.match(r.stdout, /company update v1\.1\.0/);
    // A rerun before the merge does not open it twice.
    assert.equal(f.run([], { FAKE_ORG_PLAN: 'migrate 1 2' }).status, 3);
  } finally { f.done(); }
});

test('engine install: a tree without .git, .engine-version and .install-ok; a branch is named by its sha', () => {
  const f = fixture();
  try {
    const v1 = join(f.engines, 'v1.0.0');
    assert.ok(!existsSync(join(v1, '.git')) && existsSync(join(v1, '.install-ok')));
    const [name, sha, repo] = readFileSync(join(v1, '.engine-version'), 'utf8').trim().split(' ');
    assert.equal(name, 'v1.0.0'); assert.match(sha, /^[0-9a-f]{40}$/); assert.equal(repo, join(f.t, 'origin'));
    const out = sh(f.t, `source ${join(REPO, 'scripts/lib/engine-install.sh')} && PATH=${join(f.t, 'bin')}:$PATH engine_install ${join(f.t, 'origin')} main ${f.engines} && echo $ENGINE_NAME`).trim();
    assert.equal(out, sh(join(f.t, 'origin'), 'git rev-parse HEAD').slice(0, 12));
    assert.equal(sh(f.t, `source ${join(REPO, 'scripts/lib/engine-install.sh')} && engine_origin ${v1}`).trim(), join(f.t, 'origin'));
    writeFileSync(join(f.t, 'ev'), 'x y hivecode-app/hive-code\n');
    mkdirSync(join(f.t, 'gh')); copyFileSync(join(f.t, 'ev'), join(f.t, 'gh/.engine-version'));
    assert.equal(sh(f.t, `source ${join(REPO, 'scripts/lib/engine-install.sh')} && engine_origin ${join(f.t, 'gh')}`).trim(), 'https://github.com/hivecode-app/hive-code.git');
  } finally { f.done(); }
});

test('update: an old version goes only once no live shift is older than its retirement', () => {
  const f = fixture();
  try {
    const old = (n, retired) => { mkdirSync(join(f.engines, n)); if (retired) writeFileSync(join(f.engines, n, '.retired-at'), `${retired}\n`); };
    old('v0.7.0', null);          // never was current: never ran
    old('v0.8.0', 1_700_000_000); // retired before the oldest shift started
    old('v0.9.0', 1_800_000_000); // retired after it: that shift still runs v0.9.0
    writeFileSync(join(f.t, 'shift-start'), '@1750000000\n'); // systemctl --timestamp=unix
    const r = f.run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(!existsSync(join(f.engines, 'v0.7.0')));
    assert.ok(!existsSync(join(f.engines, 'v0.8.0')));
    assert.ok(existsSync(join(f.engines, 'v0.9.0')));
    assert.ok(existsSync(join(f.engines, 'v1.0.0', '.retired-at')), 'the previous one is kept, with its retirement');
  } finally { f.done(); }
});

test('update: a failed org.yaml migration leaves no branch and no worktree behind', () => {
  const f = fixture();
  try {
    const r = f.run([], { FAKE_ORG_PLAN: 'migrate 1 2', FAKE_MIGRATE_FAIL: '1' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(sh(f.home, 'git branch --list engine-update/*').trim(), '');
    assert.equal(sh(f.home, 'git worktree list').trim().split('\n').length, 1);
  } finally { f.done(); }
});

test('update: from a development checkout (no engine/current) it is scripts/deploy.sh hq', () => {
  const src = readFileSync(join(REPO, 'scripts/company-update.sh'), 'utf8');
  assert.match(src, /exec "\$self\/scripts\/deploy\.sh" hq/);
});

// A release of v1.1.0 the way scripts/release.sh lays it out: one top dir with the tree, web/, apk/ and .engine-release,
// SHA256SUMS next to it.
function release(f, { corrupt = false } = {}) {
  const dir = mkdtempSync(join(f.t, 'rel-')); const top = join(dir, 'stage', 'agent-company-v1.1.0');
  mkdirSync(top, { recursive: true });
  sh(f.t, `git -C origin archive v1.1.0 | tar -x -C ${top}`);
  mkdirSync(join(top, 'web')); writeFileSync(join(top, 'web/index.html'), '<!doctype html>app\n');
  mkdirSync(join(top, 'apk')); writeFileSync(join(top, 'apk/app-release.json'), '{}\n');
  writeFileSync(join(top, '.engine-release'), `v1.1.0 ${sh(join(f.t, 'origin'), 'git rev-parse v1.1.0').trim()}\n`);
  sh(dir, 'tar -czf agent-company-v1.1.0.tar.gz -C stage agent-company-v1.1.0 && sha256sum agent-company-v1.1.0.tar.gz >SHA256SUMS');
  if (corrupt) sh(dir, 'echo x >>agent-company-v1.1.0.tar.gz');
  return join(dir, 'agent-company-v1.1.0.tar.gz');
}

test('engine install from a release: checksum checked, named by .engine-release, with web/ and apk/', () => {
  const f = fixture();
  try {
    const file = release(f);
    const lib = `source ${join(REPO, 'scripts/lib/engine-install.sh')} && PATH=${join(f.t, 'bin')}:$PATH`;
    assert.equal(sh(f.t, `${lib} engine_install_tarball ${file} ${f.engines} https://github.com/o/r.git && echo $ENGINE_NAME`).trim(), 'v1.1.0');
    const v = join(f.engines, 'v1.1.0');
    assert.ok(existsSync(join(v, '.install-ok')) && existsSync(join(v, 'apk/app-release.json')));
    assert.equal(readFileSync(join(v, 'web/index.html'), 'utf8'), '<!doctype html>app\n');
    assert.equal(readFileSync(join(v, '.engine-version'), 'utf8').trim().split(' ')[2], 'https://github.com/o/r.git');
    // An engine from the code gets the placeholder page instead.
    assert.match(readFileSync(join(f.engines, 'v1.0.0/web/index.html'), 'utf8'), /בלי האפליקציה ל-web/);
  } finally { f.done(); }
});

test('engine install from a release: a checksum that does not match installs nothing', () => {
  const f = fixture();
  try {
    const file = release(f, { corrupt: true });
    const r = spawnSync('bash', ['-c', `source ${join(REPO, 'scripts/lib/engine-install.sh')} && engine_install_tarball ${file} ${f.engines} x || { echo "$ENGINE_ERR"; exit 1; }`], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /checksum של agent-company-v1\.1\.0\.tar\.gz לא תואם/);
    assert.ok(!existsSync(join(f.engines, 'v1.1.0')));
    // A release that is not the tag that was asked for is refused too.
    const other = spawnSync('bash', ['-c', `source ${join(REPO, 'scripts/lib/engine-install.sh')} && engine_install_tarball ${release(f)} ${f.engines} x v9.9.9 || { echo "$ENGINE_ERR"; exit 1; }`], { encoding: 'utf8' });
    assert.equal(other.status, 1);
    assert.match(other.stdout, /השחרור שהורד הוא v1\.1\.0, לא v9\.9\.9/);
    assert.ok(!existsSync(join(f.engines, 'v1.1.0')));
  } finally { f.done(); }
});

test('update --from-tarball: the release file becomes the new engine', () => {
  const f = fixture();
  try {
    const r = f.run(['--from-tarball', release(f)]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readlinkSync(join(f.engines, 'current')), 'v1.1.0');
    assert.ok(existsSync(join(f.engines, 'v1.1.0/web/index.html')));
    assert.equal(readlinkSync(join(f.data, 'claude/current')), '2.1.400');
  } finally { f.done(); }
});

test('engine_github_slug: GitHub URLs only', () => {
  const slug = (u) => spawnSync('bash', ['-c', `source ${join(REPO, 'scripts/lib/engine-install.sh')} && engine_github_slug "$1"`, '_', u], { encoding: 'utf8' });
  assert.equal(slug('https://github.com/hivecode-app/hive-code.git').stdout.trim(), 'hivecode-app/hive-code');
  assert.equal(slug('git@github.com:o/r').stdout.trim(), 'o/r');
  assert.equal(slug('o/r').stdout.trim(), 'o/r');
  assert.equal(slug('/tmp/some/origin').status, 1);
  assert.equal(slug('https://gitlab.com/o/r.git').status, 1);
});
