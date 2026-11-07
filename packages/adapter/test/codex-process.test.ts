import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProcess, codexMcpConfig } from '../src/codex-process.ts';
import type { ShiftSpec } from '../src/spec.ts';
import type { EngineEvent } from '@company/shared';

const fake = new URL('./fixtures/fake-codex.mjs', import.meta.url).pathname;
chmodSync(fake, 0o755);
async function until(fn: () => boolean) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('condition timed out'); await new Promise((r) => setTimeout(r, 10)); }
}
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'company-codex-'));
  const spec: ShiftSpec = { identity: 'tester', shift: 'tester-1', sessionId: 'company-session', resume: false,
    cwd: root, stateRoot: root, settingsFile: '', provider: 'codex', codexBin: fake, env: { CODEX_TEST_LOG: join(root, 'rpc.log') } };
  return { root, spec };
}

test('Codex delivers ordered turns, tools and final text; resumes the same thread after restart', async () => {
  const { root, spec } = setup(); const events: EngineEvent[] = []; const states: string[] = [];
  let p = new CodexProcess(spec, { onEvent: (e) => events.push(e), onLifecycle: (e) => states.push(`${e.commandUuid}:${e.state}`) });
  try {
    p.sendUser('אחד', 'next', 'a'); p.sendUser('שתיים', 'next', 'b');
    await until(() => events.filter((e) => e.kind === 'result').length === 2);
    assert.deepEqual(events.filter((e) => e.kind === 'text').map((e) => e.text), ['תשובה: אחד', 'תשובה: שתיים']);
    assert.ok(states.includes('a:started') && states.includes('b:started'));
    assert.ok(events.some((e) => e.kind === 'tool_use' && e.name === 'mcp__company__recall'));
    assert.ok(events.filter((e) => e.kind === 'init').every((e) => e.sessionId === spec.sessionId));
    const usage = await p.usage();
    assert.equal(usage.rate_limits.seven_day.utilization, 4);
    assert.equal(usage.rate_limits.five_hour, undefined, 'a weekly primary window is never labelled five-hour');
    await p.stop(100);
    p = new CodexProcess({ ...spec, resume: true }, { onEvent: (e) => events.push(e) });
    p.sendUser('שלוש');
    await until(() => events.filter((e) => e.kind === 'result').length === 3);
    const calls = readFileSync(join(root, 'rpc.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.filter((x) => x.method === 'thread/start').length, 1);
    assert.equal(calls.find((x) => x.method === 'thread/resume').params.threadId, 'thread-test');
  } finally { await p.stop(100); rmSync(root, { recursive: true, force: true }); }
});

test('failed and interrupted turns are never reported as successful', async () => {
  const { root, spec } = setup(); const events: EngineEvent[] = [];
  const p = new CodexProcess(spec, { onEvent: (e) => events.push(e) });
  try {
    p.sendUser('fail');
    await until(() => events.some((e) => e.kind === 'result'));
    const failed = events.find((e) => e.kind === 'result')!;
    assert.equal(failed.kind === 'result' && failed.isError, true);
    p.sendUser('hang');
    await until(() => events.filter((e) => e.kind === 'user_echo').length === 2);
    await p.interrupt();
    await until(() => events.filter((e) => e.kind === 'result').length === 2);
    const result = events.filter((e) => e.kind === 'result').at(-1)!;
    assert.equal(result.isError, true); assert.equal(result.interrupted, true);
  } finally { await p.stop(100); rmSync(root, { recursive: true, force: true }); }
});

test('an API-key login cannot silently replace the requested subscription login', async () => {
  const { root, spec } = setup(); const events: EngineEvent[] = [];
  const p = new CodexProcess({ ...spec, env: { ...spec.env, CODEX_TEST_AUTH: 'apikey' } }, { onEvent: (e) => events.push(e) });
  try {
    p.sendUser('hello');
    await until(() => p.exited);
    assert.equal(events.some((e) => e.kind === 'result' && !e.isError), false);
    assert.match(p.stderrTail, /ChatGPT login/);
    const calls = readFileSync(join(root, 'rpc.log'), 'utf8');
    assert.equal(calls.includes('turn/start'), false);
  } finally { await p.stop(100); rmSync(root, { recursive: true, force: true }); }
});

test('a task worker on Codex: task instructions, no browser (also not the one in ~/.codex/config.toml), no ChatGPT apps', async () => {
  const { root, spec } = setup(); const events: EngineEvent[] = [];
  const mcp = join(root, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: { company: { command: 'node', args: ['server.ts'] }, browser: { command: 'node', args: ['gateway.ts'] } } }));
  const p = new CodexProcess({ ...spec, mcpConfigFile: mcp, codexMode: 'task', codexModel: 'gpt-6-astra' }, { onEvent: (e) => events.push(e) });
  try {
    p.sendUser('משימה');
    await until(() => events.some((e) => e.kind === 'result'));
    const start = readFileSync(join(root, 'rpc.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.method === 'thread/start').params;
    assert.match(start.developerInstructions, /# Task worker on Codex/);
    assert.match(start.developerInstructions, /Do not touch production/);
    assert.match(start.developerInstructions, /written on Codex \(gpt-6-astra\) and reviewed on Claude/);
    assert.doesNotMatch(start.developerInstructions, /Lean continuity mode/);
    assert.deepEqual(start.config.mcp_servers.browser, { command: 'true', enabled: false });
    assert.equal(start.config.mcp_servers.company.required, true);
    assert.equal(start.config['features.apps'], false);
    assert.equal(start.model, 'gpt-6-astra');
  } finally { await p.stop(100); rmSync(root, { recursive: true, force: true }); }
  // The continuity mode keeps what it had.
  assert.equal(codexMcpConfig(undefined).browser, undefined);
});
