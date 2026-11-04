import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { dailyBackup } from './daily-backup.mjs';

test('daily backup restores SQLite, committed history and uncommitted company files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-e-backup-'));
  try {
    const company = join(dir, 'company'), state = join(dir, 'state');
    mkdirSync(company); mkdirSync(state);
    execFileSync('git', ['init', company], { stdio: 'pipe' });
    execFileSync('git', ['-C', company, 'config', 'user.name', 'Test']);
    execFileSync('git', ['-C', company, 'config', 'user.email', 'test@example.test']);
    writeFileSync(join(company, 'org.yaml'), 'setup: pending\n');
    execFileSync('git', ['-C', company, 'add', '.']);
    execFileSync('git', ['-C', company, 'commit', '-m', 'fixture'], { stdio: 'pipe' });
    writeFileSync(join(company, 'draft.md'), 'local work');
    const db = new Database(join(state, 'hq.db'));
    db.exec('CREATE TABLE fixture (n INTEGER); INSERT INTO fixture VALUES(42)');
    const out = await dailyBackup(state, company, new Date('2026-11-04T01:00:00Z'));
    const restored = new Database(join(out, 'hq.db'), { readonly: true });
    assert.equal(restored.prepare('SELECT n FROM fixture').get().n, 42); restored.close(); db.close();
    const clone = join(dir, 'restored-company');
    execFileSync('git', ['clone', join(out, 'company.bundle'), clone], { stdio: 'pipe' });
    execFileSync('tar', ['-xzf', join(out, 'company.tar.gz'), '-C', clone]);
    assert.equal(readFileSync(join(clone, 'draft.md'), 'utf8'), 'local work');
    assert.equal(readFileSync(join(clone, 'org.yaml'), 'utf8'), 'setup: pending\n');
    assert.equal(existsSync(join(out, 'hq.db-wal')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('company status and pair use the local API, show QR, and explain a stopped server', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-e-cli-'));
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer secret-token');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/pair') ? { code: 'ABCD-EFGH', link: 'https://company.example/pair?code=ABCD-EFGH', expires_at: Date.now() + 60_000 } : { pending: false }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    writeFileSync(join(dir, 'hq.config.json'), JSON.stringify({ port: server.address().port }));
    writeFileSync(join(dir, 'api-token'), 'secret-token');
    const run = arg => new Promise(resolve => {
      const p = spawn('node', ['scripts/company-client.mjs', arg], { env: { ...process.env, AGENT_COMPANY_STATE: dir } });
      let output = ''; p.stdout.on('data', c => output += c); p.stderr.on('data', c => output += c);
      p.on('close', code => resolve({ code, output }));
    });
    assert.match((await run('status')).output, /Setup: complete/);
    const pair = await run('pair');
    assert.equal(pair.code, 0); assert.match(pair.output, /ABCD-EFGH/); assert.match(pair.output, /[▀▄█]/);
    assert.doesNotMatch(pair.output, /secret-token/);
    await new Promise(resolve => server.close(resolve));
    const down = await run('status'); assert.equal(down.code, 1); assert.match(down.output, /unavailable/);
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('backup skips empty history, preserves nested git and excludes dependencies; low space leaves previous copies', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phase-e-empty-'));
  try {
    const company = join(dir, 'company'), state = join(dir, 'state');
    mkdirSync(company); mkdirSync(state);
    execFileSync('git', ['init', company], { stdio: 'pipe' });
    mkdirSync(join(company, 'nested/.git'), { recursive: true }); writeFileSync(join(company, 'nested/.git/keep'), 'nested metadata');
    mkdirSync(join(company, 'node_modules')); writeFileSync(join(company, 'node_modules/ignore'), 'dependency');
    const db = new Database(join(state, 'hq.db')); db.exec('CREATE TABLE fixture (n INTEGER)'); db.close();
    const out = await dailyBackup(state, company, new Date('2026-11-04T02:00:00Z'));
    const contents = execFileSync('tar', ['-tzf', join(out, 'company.tar.gz')], { encoding: 'utf8' });
    assert.match(contents, /nested\/\.git\/keep/); assert.doesNotMatch(contents, /node_modules/);
    assert.equal(existsSync(join(out, 'company.bundle')), false);
    await assert.rejects(dailyBackup(state, company, new Date('2026-11-05T02:00:00Z'), { freeBytes: () => 0 }), /space/);
    assert.equal(existsSync(join(out, 'hq.db')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('maintenance uses the resolved node binary and company-only cleaning', () => {
  const install = readFileSync('scripts/install.sh', 'utf8');
  const maintenance = install.slice(install.indexOf('for maintenance in backup disk-clean;'), install.indexOf('systemctl --user daemon-reload'));
  assert.match(maintenance, /maintenance_command="\\"\$node_bin/);
  assert.match(maintenance, /Environment="PATH=\$unit_path"/);
  assert.match(maintenance, /disk-clean\.mjs.*--company-only/);
});

test('new-install cleanup touches only stale incomplete company snapshots from dead processes', async () => {
  const { cleanCompany } = await import('./disk-clean.mjs');
  const { utimesSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'phase-e-clean-'));
  try {
    const backups = join(dir, 'daily-backups'); mkdirSync(backups);
    const stale = join(backups, '.2026-11-04-999999999'); mkdirSync(stale); writeFileSync(join(stale, 'partial'), 'incomplete');
    const active = join(backups, `.2026-11-04-${process.pid}`); mkdirSync(active);
    const complete = join(backups, '2026-11-04-123456'); mkdirSync(complete);
    writeFileSync(join(dir, 'unrelated'), 'keep');
    const before = Date.now() - 2 * 86_400_000;
    utimesSync(stale, before / 1000, before / 1000); utimesSync(active, before / 1000, before / 1000);
    assert.deepEqual(cleanCompany(dir).removed, ['.2026-11-04-999999999']);
    assert.equal(existsSync(active), true); assert.equal(existsSync(complete), true); assert.equal(existsSync(join(dir, 'unrelated')), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Caddy resolves a client address before forwarding to the entry limiter', () => {
  const install = readFileSync('scripts/install.sh', 'utf8');
  assert.match(install, /trusted_proxies static 127\.0\.0\.1\/32 ::1\/128/);
  assert.match(install, /trusted_proxies_strict/);
  for (const file of ['scripts/install.sh', 'deploy/caddy/agent-company.caddy']) {
    const text = readFileSync(file, 'utf8');
    const blocks = [...text.matchAll(/reverse_proxy 127\.0\.0\.1:7420 \{([^}]*\{http\.vars\.client_ip\}[^}]*)\}/g)];
    const proxies = [...text.matchAll(/reverse_proxy 127\.0\.0\.1:7420/g)];
    assert.equal(blocks.length, proxies.length, file);
    for (const block of blocks) assert.match(block[1], /header_up X-Forwarded-For \{http\.vars\.client_ip\}/);
  }
});
