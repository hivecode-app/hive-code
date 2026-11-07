import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** Wall-clock of a bare node on a tiny .ts file: the spawn + type-strip floor the hook pays too. */
function runNode(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(process.execPath, [file], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', () => resolve(performance.now() - t0));
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

// A hook runs on every tool call, so the CLI must stay a cheap spool write: no network, no heavy
// imports. Wall-clock on a loaded box (#72: load 6.7, SessionStart 878ms) slows every process
// spawn, so the budget is relative to a bare node that starts in the same run, interleaved with the
// hooks so both see the same load. A heavy import still fails; the cap below cli.ts's 3s guard
// keeps a hang (network) failing however loaded the box is.
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const hookBudget = (base: number): number => Math.min(2500, Math.max(500, base * 6));

test('latency budget is relative to the baseline, with a floor', () => {
  assert.equal(hookBudget(40), 500); // quiet box: the absolute budget
  assert.equal(hookBudget(300), 1800); // loaded box (#72): every spawn is slower
  assert.equal(hookBudget(800), 2500); // capped below the 3s guard: a hang always fails
  assert.equal(median([5, 1, 9, 3, 7]), 5);
});

test('CLI latency (spool only)', async () => {
  const root = tmpState();
  const env = { COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'lat-1' };
  const bare = join(root, 'bare.ts');
  writeFileSync(bare, 'const x: number = 0; export default x;\n');
  writePrimeFile(root, 'lat-1', prime({ handoff: 'h'.repeat(3000) }));
  await runCli(['hook', 'PreToolUse'], '{}', env); // warm the fs cache
  const base: number[] = []; const pre: number[] = []; const ss: number[] = [];
  for (let i = 0; i < 7; i++) {
    base.push(await runNode(bare));
    pre.push((await runCli(['hook', 'PreToolUse'], '{"tool_name":"Bash"}', env)).ms);
    ss.push((await runCli(['hook', 'SessionStart'], '{"source":"startup"}', env)).ms);
  }
  const fmt = (xs: number[]): string => `${median(xs).toFixed(0)}ms (${xs.map((t) => t.toFixed(0)).join(',')})`;
  const budget = hookBudget(median(base));
  console.log(`hook CLI latency: bare node ${fmt(base)}, PreToolUse ${fmt(pre)}, SessionStart ${fmt(ss)}, budget ${budget.toFixed(0)}ms`);
  assert.ok(median(pre) < budget, `PreToolUse median ${median(pre).toFixed(0)}ms, budget ${budget.toFixed(0)}ms`);
  assert.ok(median(ss) < budget, `SessionStart median ${median(ss).toFixed(0)}ms, budget ${budget.toFixed(0)}ms`);
});

test('Stop: an English reply is not blocked, only spooled (owner, 07/11: the block made duplicate replies)', async () => {
  const root = tmpState();
  const env = { COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'dana-1' };
  const english = 'I merged the pull request and the deploy finished without any problems.';
  const r = await runCli(['hook', 'Stop'], JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: english }), env);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, '');
  assert.ok(spoolLines(root, 'dana-1').every((l) => l.event === 'Stop'));
});
