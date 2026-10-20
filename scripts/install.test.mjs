// scripts/install.sh: what can run here without installing anything. The full run (an Ubuntu 24.04 container with
// systemd, up to the QR and a green verify-prod --install) is manual: the PR that changes the installer says how.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'install.sh');

test('install.sh parses', () => {
  execFileSync('bash', ['-n', script]);
});

test('a machine that misses a requirement stops at step 1 and writes nothing', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-test-'));
  try {
    const r = spawnSync('bash', [script, '--accept-full-access'], {
      encoding: 'utf8', env: { ...process.env, HOME: home, INSTALL_MIN_MEM_GB: '100000', XDG_CONFIG_HOME: '' },
    });
    if (process.getuid?.() === 0) { assert.equal(r.status, 1); return; }
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /זיכרון: \d+GB, צריך 100000GB/);
    assert.doesNotMatch(r.stdout, /2\/8/);
    assert.deepEqual(readdirSync(home), []);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('units set up by hand (hq-host: symlinks, or files without the mark) stop it at step 1, before any write', () => {
  const home = mkdtempSync(join(tmpdir(), 'install-test-'));
  try {
    const units = join(home, '.config', 'systemd', 'user');
    mkdirSync(units, { recursive: true });
    writeFileSync(join(home, 'hq.service'), '[Service]\n');
    symlinkSync(join(home, 'hq.service'), join(units, 'agent-company-hq.service'));
    writeFileSync(join(units, 'company-shift@.service'), '[Service]\n');
    const r = spawnSync('bash', [script, '--accept-full-access'], {
      encoding: 'utf8', env: { ...process.env, HOME: home, INSTALL_MIN_MEM_GB: '1', XDG_CONFIG_HOME: '' },
    });
    if (process.getuid?.() === 0) return;
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /agent-company-hq\.service קיים ולא נוצר על ידי ההתקנה/);
    assert.match(r.stderr, /company-shift@\.service קיים ולא נוצר על ידי ההתקנה/);
    assert.doesNotMatch(r.stdout, /2\/8/);
    assert.deepEqual(readdirSync(home).sort(), ['.config', 'hq.service']);
    assert.deepEqual(readdirSync(join(home, '.config')), ['systemd']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('--help works without the script file (curl | bash)', () => {
  const r = spawnSync('bash', ['-s', '--', '--help'], { input: readFileSync(script), encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /--address funnel\|tunnel\|domain\|local/);
});

test('an unknown flag is refused before anything runs', () => {
  const r = spawnSync('bash', [script, '--nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

test('the pinned downloads carry full hashes', () => {
  const src = readFileSync(script, 'utf8');
  for (const a of ['amd64', 'arm64']) {
    assert.match(src, new RegExp(`CADDY_SHA512_${a}='[0-9a-f]{128}'`));
    assert.match(src, new RegExp(`CLOUDFLARED_SHA256_${a}='[0-9a-f]{64}'`));
  }
});
