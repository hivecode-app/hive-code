import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRIME_BUDGETS, ADDITIONAL_CONTEXT_CAP } from '@company/shared';
import { buildAdditionalContext, compactSummaryToHandoff } from '../src/index.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;

test('compact_summary keeps only <summary> and fits the 4K handoff budget (bet 1)', () => {
  const s = `<analysis>${'x'.repeat(5000)}</analysis>\n<summary>\n1. Decisions: integer cents\n${'y'.repeat(8000)}\n</summary>`;
  const h = compactSummaryToHandoff(s);
  assert.ok(!h.includes('xxxx'), 'analysis dropped');
  assert.ok(h.startsWith('1. Decisions: integer cents'));
  assert.ok(h.length <= PRIME_BUDGETS.handoff);
  assert.equal(compactSummaryToHandoff('<analysis>a</analysis>plain'), 'plain');
});

test('topRecord section is injected and the full prime stays under the cap', () => {
  const big = 'z'.repeat(9000);
  const out = buildAdditionalContext({ v: 1, shift: 's-1', identity: 's', updatedAt: '', handoff: big, directives: big,
    topRecord: `personal/health-insurance-policy\n${big}`, memoryIndex: big, inbox: big, pointers: big }, 'startup');
  assert.ok(out.includes('## הרשומה הרלוונטית ביותר'));
  assert.ok(out.includes('personal/health-insurance-policy'));
  assert.ok(out.length <= ADDITIONAL_CONTEXT_CAP);
  const sum = Object.values(PRIME_BUDGETS).reduce((a, b) => a + b, 0);
  assert.equal(sum, 10_000);
});

test('PostCompact hook writes compact-handoff.md and exits 0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc-'));
  const code = await new Promise<number | null>((res) => {
    const p = spawn(process.execPath, [CLI, 'hook', 'PostCompact'], {
      env: { ...process.env, COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'c-1' }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    p.on('exit', res);
    p.stdin.end(JSON.stringify({ hook_event_name: 'PostCompact', compact_summary: '<analysis>A</analysis><summary>KEEP-ME</summary>' }));
  });
  assert.equal(code, 0);
  assert.equal(readFileSync(join(root, 'shifts/c-1/compact-handoff.md'), 'utf8'), 'KEEP-ME');
});

test('hook exits 0 within the guard even if stdin is never closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'hs-'));
  const t = Date.now();
  const code = await new Promise<number | null>((res) => {
    const p = spawn(process.execPath, [CLI, 'hook', 'Stop'], {
      env: { ...process.env, COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'h-1' }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    p.on('exit', res);
    // never end stdin
  });
  assert.equal(code, 0);
  // The hook's own guard is 3s; the bound only catches a hook that hangs for good, so it must outlast a loaded machine's node startup.
  assert.ok(Date.now() - t < 15_000);
});
