import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeEnv, parseRunArgs, systemdRunArgs, unitOf } from '../src/run-args.ts';

const RUN = new URL('../src/run.ts', import.meta.url).pathname;

test('company-run args: --lease and the command after --', () => {
  assert.deepEqual(parseRunArgs(['--lease', 'lease-7', '--', './gradlew', 'assembleDebug', '--lease', 'x']), { lease: 'lease-7', cmd: ['./gradlew', 'assembleDebug', '--lease', 'x'] });
  assert.deepEqual(parseRunArgs(['--lease=lease-7', '--', 'ls']), { lease: 'lease-7', cmd: ['ls'] });
  assert.match(String(parseRunArgs(['--', 'ls'])), /--lease/);
  assert.match(String(parseRunArgs(['--lease', '7', '--', 'ls'])), /--lease/);
  assert.match(String(parseRunArgs(['--lease', 'lease-7'])), /הפקודה/);
  assert.match(String(parseRunArgs(['--lease', 'lease-7', 'ls'])), /דגל לא מוכר/);
});

test('company-run: the scope carries the ceiling of the class and a unit of its own', () => {
  const a = systemdRunArgs('lease-7', { memoryMax: '8192M', cpuWeight: 100 }, ['./gradlew', 'build']);
  assert.deepEqual(a.slice(0, 3), ['--user', '--scope', '--quiet']);
  assert.ok(a.includes('MemoryMax=8192M') && a.includes('CPUWeight=100'));
  assert.ok(a.includes(`--unit=${unitOf('lease-7')}`));
  assert.deepEqual(a.slice(a.indexOf('--') + 1), ['./gradlew', 'build']);
});

test('company-run: the scope ends by itself when the lease does, even if company-run is gone', () => {
  const a = systemdRunArgs('lease-7', { memoryMax: '1M', cpuWeight: 10, remainingMs: 600_000 }, ['x']);
  assert.ok(a.includes('RuntimeMaxSec=660'));
  assert.ok(!systemdRunArgs('lease-7', { memoryMax: '1M', cpuWeight: 10 }, ['x']).some((x) => x.startsWith('RuntimeMaxSec')));
});

test('company-run: GRADLE_OPTS the project set stay and the class adds to them', () => {
  assert.equal(mergeEnv({ GRADLE_OPTS: '-Xmx2g' }, { GRADLE_OPTS: '-Dorg.gradle.daemon=false' }).GRADLE_OPTS, '-Xmx2g -Dorg.gradle.daemon=false');
  assert.equal(mergeEnv({ GRADLE_OPTS: '-Dorg.gradle.daemon=false' }, { GRADLE_OPTS: '-Dorg.gradle.daemon=false' }).GRADLE_OPTS, '-Dorg.gradle.daemon=false');
  assert.equal(mergeEnv({}, { GRADLE_OPTS: '-x' }).GRADLE_OPTS, '-x');
  assert.equal(mergeEnv({ MODE: 'a' }, { MODE: 'b' }).MODE, 'b');
});

function run(env: Record<string, string>, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [RUN, ...args], { env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env }, timeout: 30_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (err as { code?: number }).code ?? 1 : 0, stderr, stdout });
    });
  });
}

async function fakeHq(answer: (body: any) => { status: number; body: unknown }) {
  const seen: any[] = [];
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      seen.push({ path: req.url, body });
      const a = answer(body);
      res.writeHead(a.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(a.body));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() };
}

test('company-run: attach, the command with the class environment, finish with its exit code', async () => {
  const hq = await fakeHq((b) => b.op === 'attach'
    ? { status: 200, body: { lease: b.lease, class: 'build', memoryMax: '2048M', cpuWeight: 50, env: { GRADLE_OPTS: '-Dorg.gradle.daemon=false' }, remainingMs: 60_000 } }
    : { status: 200, body: { ok: true } });
  try {
    const r = await run({ COMPANY_HQ_URL: hq.url, COMPANY_STATE_DIR: mkdtempSync(join(tmpdir(), 'run-')) },
      ['--lease', 'lease-3', '--', 'sh', '-c', 'echo "$GRADLE_OPTS"; exit 3']);
    assert.equal(r.code, 3);
    assert.match(r.stdout, /-Dorg.gradle.daemon=false/);
    assert.deepEqual(hq.seen.map((s) => s.body.op), ['attach', 'finish']);
    assert.equal(hq.seen[0].path, '/v1/lease');
    assert.equal(hq.seen[1].body.exit_code, 3);
    assert.equal(hq.seen[1].body.lease, 'lease-3');
  } finally { hq.close(); }
});

test('company-run: a lease hq does not grant is refused, and the command does not run', async () => {
  const hq = await fakeHq(() => ({ status: 409, body: { ok: false, error: 'lease-3 עדיין בתור' } }));
  try {
    const r = await run({ COMPANY_HQ_URL: hq.url, COMPANY_STATE_DIR: mkdtempSync(join(tmpdir(), 'run-')) }, ['--lease', 'lease-3', '--', 'sh', '-c', 'echo ran']);
    assert.equal(r.code, 125);
    assert.match(r.stderr, /בתור/);
    assert.doesNotMatch(r.stdout, /ran/);
  } finally { hq.close(); }
});

test('company-run: hq that does not answer is no reason to stop the work', async () => {
  const r = await run({ COMPANY_HQ_URL: 'http://127.0.0.1:9', COMPANY_STATE_DIR: mkdtempSync(join(tmpdir(), 'run-')) }, ['--lease', 'lease-3', '--', 'sh', '-c', 'echo ran; exit 4']);
  assert.equal(r.code, 4);
  assert.match(r.stdout, /ran/);
  assert.match(r.stderr, /hq לא עונה/);
});

test('company-run: when hq says the lease ended, the command is stopped and hq is told', async () => {
  let beats = 0;
  const hq = await fakeHq((b) => b.op === 'attach' ? { status: 200, body: { lease: b.lease, class: 'build', memoryMax: '2048M', cpuWeight: 50, env: {}, remainingMs: 60_000 } }
    : b.op === 'beat' ? { status: 200, body: ++beats > 1 ? { state: 'released', reason: 'timeout' } : { state: 'granted' } } : { status: 200, body: { ok: true } });
  try {
    const t0 = Date.now();
    const r = await run({ COMPANY_HQ_URL: hq.url, COMPANY_RUN_BEAT_MS: '100', COMPANY_IDENTITY: 'lumo-t9', COMPANY_STATE_DIR: mkdtempSync(join(tmpdir(), 'run-')) },
      ['--lease', 'lease-3', '--', 'sleep', '30']);
    assert.ok(Date.now() - t0 < 10_000, 'sleep 30 was stopped');
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /timeout/);
    const fin = hq.seen.find((s) => s.body.op === 'finish');
    assert.ok(fin, 'hq was told it ended');
    assert.equal(fin.body.identity, 'lumo-t9');
  } finally { hq.close(); }
});
