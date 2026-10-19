import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADDITIONAL_CONTEXT_CAP, PRIME_BUDGETS } from '@company/shared';
import type { PrimeFile, SpoolLine } from '@company/shared';
import {
  appendSpool, buildAdditionalContext, spoolDir, spoolHour, truncate, writePrimeFile, TRUNCATION_MARK,
} from '../src/index.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

interface Run { code: number | null; stdout: string; stderr: string; ms: number }

function runCli(args: string[], stdin: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, ms: performance.now() - t0 }));
    child.stdin.end(stdin);
  });
}

function tmpState(): string { return mkdtempSync(join(tmpdir(), 'hooks-test-')); }

function spoolLines(root: string, shift: string): SpoolLine[] {
  const dir = spoolDir(root, shift);
  return readdirSync(dir).flatMap((f) =>
    readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as SpoolLine));
}

const prime = (over: Partial<PrimeFile> = {}): PrimeFile => ({
  v: 1, shift: 'yoav-3', identity: 'yoav', updatedAt: '2026-10-20T10:00:00.000Z', ...over,
});

test('spoolHour and appendSpool layout', () => {
  assert.equal(spoolHour('2026-10-20T14:03:00.000Z'), '2026102014');
  const root = tmpState();
  const f = appendSpool(root, 'yoav-3', { ts: '2026-10-20T14:03:00.000Z', event: 'Stop', pid: 1, payload: {} });
  assert.equal(f, `${root}/shifts/yoav-3/spool/2026102014.ndjson`);
  assert.equal(spoolLines(root, 'yoav-3').length, 1);
});

test('10 concurrent CLI invocations produce 10 valid lines', async () => {
  const root = tmpState();
  const env = { COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'yoav-3' };
  const runs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    runCli(['hook', 'PostToolUse'], JSON.stringify({ hook_event_name: 'PostToolUse', i, pad: 'x'.repeat(5000) }), env)));
  for (const r of runs) assert.equal(r.code, 0);
  const lines = spoolLines(root, 'yoav-3');
  assert.equal(lines.length, 10);
  assert.deepEqual(lines.map((l) => (l.payload as { i: number }).i).sort((a, b) => a - b), [...Array(10).keys()]);
  for (const l of lines) assert.equal(l.event, 'PostToolUse');
});

test('invalid stdin spools {raw}; missing shift goes to _unknown', async () => {
  const root = tmpState();
  const r = await runCli(['Stop'], 'not json{', { COMPANY_STATE_DIR: root });
  assert.equal(r.code, 0);
  const [line] = spoolLines(root, '_unknown');
  assert.deepEqual(line!.payload, { raw: 'not json{' });
  assert.equal(line!.event, 'Stop');
});

test('exit code 0 even when the state dir is unwritable', async () => {
  const r = await runCli(['hook', 'SessionStart'], '{}', { COMPANY_STATE_DIR: '/proc/nope/state', COMPANY_SHIFT: 's' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
});

test('SessionStart prints hookSpecificOutput from prime.json', async () => {
  const root = tmpState();
  writePrimeFile(root, 'yoav-3', prime({ handoff: 'עבדתי על X', inbox: 'm-1 מדנה' }));
  const r = await runCli(['hook', 'SessionStart'],
    JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact' }),
    { COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'yoav-3' });
  assert.equal(r.code, 0);
  const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /source: compact/);
  assert.match(ctx, /עבדתי על X/);
  assert.ok(ctx.indexOf('## העברה מהמשמרת הקודמת') < ctx.indexOf('## הודעות שלא טופלו'));
  assert.equal(spoolLines(root, 'yoav-3').length, 1);
});

test('SessionStart without prime.json prints nothing but still spools', async () => {
  const root = tmpState();
  const r = await runCli(['hook', 'SessionStart'], '{"source":"startup"}', { COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'x-1' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.equal(spoolLines(root, 'x-1').length, 1);
});

test('sections are truncated to their budgets at line boundaries', () => {
  const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
  const ctx = buildAdditionalContext(prime({ handoff: long, directives: long, pointers: 'recall dir-0142' }), 'startup');
  const handoff = ctx.split('## העברה מהמשמרת הקודמת\n')[1]!.split('\n\n## ')[0]!;
  assert.ok(handoff.length <= PRIME_BUDGETS.handoff, `handoff ${handoff.length}`);
  assert.ok(handoff.endsWith(TRUNCATION_MARK));
  assert.match(handoff.split('\n').at(-2)!, /^line \d+ y{20}$/); // whole line kept before the mark
  const directives = ctx.split('## הוראות חדשות\n')[1]!.split('\n\n## ')[0]!;
  assert.ok(directives.length <= PRIME_BUDGETS.directives);
  assert.match(ctx, /## מצביעים\nrecall dir-0142$/);
});

test('total is hard-capped at ADDITIONAL_CONTEXT_CAP, cut from the end', () => {
  const big = 'z'.repeat(5000);
  const ctx = buildAdditionalContext(prime({
    handoff: big, directives: big, memoryIndex: big, inbox: big, pointers: big,
  }), 'resume');
  assert.ok(ctx.length <= ADDITIONAL_CONTEXT_CAP, `len ${ctx.length}`);
  assert.ok(ctx.startsWith('# הקשר משמרת'));
  assert.ok(ctx.endsWith(TRUNCATION_MARK));
  assert.equal(truncate('short', 100), 'short');
});

test('CLI latency (spool only)', async () => {
  const root = tmpState();
  const env = { COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'lat-1' };
  await runCli(['hook', 'PreToolUse'], '{}', env); // warm the fs cache
  const times: number[] = [];
  for (let i = 0; i < 5; i++) times.push((await runCli(['hook', 'PreToolUse'], '{"tool_name":"Bash"}', env)).ms);
  writePrimeFile(root, 'lat-1', prime({ handoff: 'h'.repeat(3000) }));
  const ss = (await runCli(['hook', 'SessionStart'], '{"source":"startup"}', env)).ms;
  const median = times.sort((a, b) => a - b)[2]!;
  console.log(`hook CLI latency: median ${median.toFixed(1)}ms (runs ${times.map((t) => t.toFixed(0)).join(',')}), SessionStart ${ss.toFixed(1)}ms`);
  assert.ok(median < 500, `median ${median}ms`);
  assert.ok(ss < 500, `SessionStart ${ss}ms`);
});
