import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeState, heavyReminder, scan, serverState } from '../src/index.ts';

const what = (c: string) => scan(c)?.what ?? null;

test('known heavy commands are found, with the class to reserve', () => {
  assert.equal(what('flutter test'), 'flutter test');
  assert.equal(scan('cd packages/app && flutter test --coverage')?.class, 'test-full');
  assert.equal(what('./gradlew assembleDebug'), 'gradlew');
  assert.equal(what('cd android && GRADLE_OPTS=-Xmx2g ./gradlew bundleRelease'), 'gradlew');
  assert.equal(what('docker build -t x .'), 'docker build');
  assert.equal(what('docker compose -f a.yml up -d'), 'docker compose up');
  assert.equal(what('docker-compose up'), 'docker-compose up');
  assert.equal(what('bash -c "flutter test"'), 'flutter test');
  assert.equal(what('flock /tmp/flutter-test.lock flutter test'), 'flutter test', 'a flock is not a reservation');
  assert.equal(what('timeout 20m ./gradlew build'), 'gradlew');
  // task 1547: what ran unreserved at 07:12 on 08/11
  assert.equal(what('cd bridge && go vet ./...'), 'go vet ./...');
  assert.equal(scan('go test -race ./internal/...')?.class, 'build', 'not test-full: that one waits for every flutter test');
  assert.equal(what('go -C bridge vet ./...'), 'go vet ./...');
  assert.equal(scan('go build ./...')?.class, 'build');
  assert.equal(what('cargo test --release'), 'cargo test');
  assert.equal(what('cargo +nightly build'), 'cargo build');
});

test('company-run, focused tests and other commands pass', () => {
  assert.equal(what('company-run --lease lease-3 -- flutter test'), null);
  assert.equal(what('~/.local/bin/company-run --lease lease-3 -- ./gradlew build'), null);
  assert.equal(what('flutter test test/widget/chat_test.dart'), null);
  assert.equal(what('flutter test --plain-name "chat sends"'), null);
  assert.equal(what('flutter analyze'), null);
  assert.equal(what('docker ps'), null);
  assert.equal(what('docker compose down'), null);
  assert.equal(what('echo "flutter test" > notes.txt'), null);
  assert.equal(what('git commit -m "docker build fix"'), null);
  assert.equal(what('go test ./internal/bridge -run TestSend'), null, 'one package is a focused run');
  assert.equal(what('go vet .'), null);
  assert.equal(what('go mod tidy'), null);
  assert.equal(what('company-run --lease lease-4 -- go vet ./...'), null);
  assert.equal(what('cargo fmt'), null);
});

test('the reminder says there is no reservation and what the server looks like; unreadable numbers are not guessed', () => {
  const r = heavyReminder('docker build .', { memAvailMb: 6144, memTotalMb: 16384, load1: 2.5, cpus: 8 })!;
  assert.match(r.text, /it has no reservation/);
  assert.match(r.text, /6\.0GB of 16\.0GB memory free, load 2\.5 on 8 cores/);
  assert.match(r.text, /`class: "docker"`/);
  assert.equal(heavyReminder('ls'), null);
  assert.match(describeState({ memAvailMb: null, memTotalMb: null, load1: null, cpus: 4 }), /memory not read, load not read/);
  const s = serverState((p) => (p.endsWith('meminfo') ? 'MemTotal: 2097152 kB\nMemAvailable: 1048576 kB\n' : '0.50 0.4 0.3 1/2 3'));
  assert.deepEqual([s.memTotalMb, s.memAvailMb, s.load1], [2048, 1024, 0.5]);
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

test('CLI: a heavy Bash gets the reminder as context (no deny) and a spool event; company-run is silent', async () => {
  const state = mkdtempSync(join(tmpdir(), 'heavy-test-'));
  const e = { COMPANY_STATE_DIR: state, COMPANY_SHIFT: 'ron-2', COMPANY_REPO: '/nonexistent/repo', HOME: tmpdir() };
  const call = (command: string) => runCli(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: tmpdir() }), e);
  const hit = await call('flutter test');
  assert.equal(hit.code, 0);
  const out = JSON.parse(hit.stdout) as { hookSpecificOutput: { permissionDecision?: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.permissionDecision, undefined, 'a reminder, not a block');
  assert.match(out.hookSpecificOutput.additionalContext, /it has no reservation/);
  const quiet = await call('company-run --lease lease-1 -- flutter test');
  assert.equal(quiet.stdout, '');
  const spool = join(state, 'shifts', 'ron-2', 'spool');
  const lines = readdirSync(spool).flatMap((f) => readFileSync(join(spool, f), 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.event), ['PreToolUse.heavy-unreserved']);
  assert.equal(lines[0].payload.class, 'test-full');
});
