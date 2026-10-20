#!/usr/bin/env node
// `company hook <Event>`: spool the hook payload, and for SessionStart print
// the prime context. Always exits 0, never touches the network (B.3.3, B.5).
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ENV, englishLines, hebrewReason, shiftDir, statePaths } from '@company/shared';
import { writeCompactHandoff } from './compact.ts';
import { appendSpool, mkdirp, UNKNOWN_SHIFT } from './spool.ts';

// Last-resort guard: a hook must never hold up the turn.
setTimeout(() => process.exit(0), 3000).unref();
import { buildAdditionalContext, readPrimeFile } from './prime.ts';

const stateRoot = statePaths(homedir(), process.env[ENV.stateDir] || undefined).root;

function logError(where: string, err: unknown): void {
  try {
    mkdirp(stateRoot);
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    appendFileSync(`${stateRoot}/hooks-errors.log`,
      `${new Date().toISOString()} pid=${process.pid} ${where}: ${msg}\n`);
  } catch { /* best effort */ }
}

process.on('uncaughtException', (e) => { logError('uncaught', e); process.exitCode = 0; });
process.exitCode = 0;

/** Async stdin read so the 3s guard stays live if Claude never closes stdin. */
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (d: Buffer) => chunks.push(d));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', (e) => { logError('stdin', e); resolve(Buffer.concat(chunks).toString('utf8')); });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argEvent = (args[0] === 'hook' ? args[1] : args[0]) ?? '';
  const shift = process.env[ENV.shift] || UNKNOWN_SHIFT;

  const raw = await readStdin();
  let payload: unknown;
  try { payload = raw.trim() ? JSON.parse(raw) : {}; } catch { payload = { raw }; }

  const p = payload as { hook_event_name?: unknown; source?: unknown } | null;
  const event = argEvent || (typeof p?.hook_event_name === 'string' ? p.hook_event_name : 'unknown');

  try {
    appendSpool(stateRoot, shift, { ts: new Date().toISOString(), event, pid: process.pid, payload });
  } catch (e) { logError('spool', e); }

  if (event === 'Stop') {
    // Hebrew everywhere (dir-0002, #51): the owner's ~/.claude hebrew-reply-guard does not load in
    // shifts (--setting-sources project,local), so the same rule rides on this Stop hook. One retry:
    // a second block on the rewrite would loop.
    const st = payload as { stop_hook_active?: unknown; last_assistant_message?: unknown } | null;
    if (st?.stop_hook_active === true || typeof st?.last_assistant_message !== 'string') return;
    const bad = englishLines(st.last_assistant_message);
    if (bad.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: hebrewReason('הטקסט שלך', bad) }));
    return;
  }
  if (event === 'PostCompact') {
    const cs = (payload as { compact_summary?: unknown } | null)?.compact_summary;
    if (typeof cs === 'string' && cs.trim()) {
      try { writeCompactHandoff(shiftDir(statePaths('', stateRoot), shift), cs); } catch (e) { logError('compact', e); }
    }
    return;
  }
  if (event !== 'SessionStart') return;
  try {
    const prime = readPrimeFile(stateRoot, shift);
    if (!prime) return;
    const source = typeof p?.source === 'string' ? p.source : 'unknown';
    const additionalContext = buildAdditionalContext(prime, source);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext },
    }));
  } catch (e) { logError('prime', e); }
}

main().catch((e) => logError('main', e));
