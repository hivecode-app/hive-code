#!/usr/bin/env node
// `company hook <Event>`: spool the hook payload, and for SessionStart print
// the prime context. Always exits 0, never touches the network (B.3.3, B.5).
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { ENV, englishLines, hebrewReason, shiftDir, statePaths } from '@company/shared';
import { writeCompactHandoff } from './compact.ts';
import { checkToolUse } from './guard.ts';
import { checkMerge, detectMerges } from './merge.ts';
import { turnTexts } from './turn-text.ts';
import { appendSpool, mkdirp, UNKNOWN_SHIFT } from './spool.ts';

// Last-resort guard: a hook must never hold up the turn.
const guardTimer = setTimeout(() => process.exit(0), 3000);
guardTimer.unref();
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

/** Merge gate (dir-0011): only a Bash command that merges a PR pays for `gh`. A check that does not finish in time blocks. */
async function mergeGate(payload: unknown): Promise<string | null> {
  const p = (payload ?? {}) as { tool_name?: unknown; tool_input?: { command?: unknown }; cwd?: unknown };
  const command = p.tool_input?.command;
  if (p.tool_name !== 'Bash' || typeof command !== 'string' || !/\bgh\b/.test(command)) return null;
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : process.cwd();
  try {
    if (!detectMerges(command, cwd).length) return null;
    clearTimeout(guardTimer);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((res) => {
      timer = setTimeout(() => res('מיזוג נחסם: בדיקת הסקירה לא רצה (הקריאה ל-`gh` לא הסתיימה בזמן), ואין מיזוג בלי שהיא עברה. מנסים שוב.'), 8000);
    });
    try { return await Promise.race([checkMerge(command, cwd), late]); } finally { clearTimeout(timer); }
  } catch (e) {
    logError('merge-gate', e);
    return 'מיזוג נחסם: בדיקת הסקירה לא רצה (שגיאה פנימית ב-hook), ואין מיזוג בלי שהיא עברה.';
  }
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

  if (event === 'PreToolUse') {
    // #115: no writes into the main agent-company checkout. Only a block is spooled (the board sees it);
    // every other tool call passes silently.
    let reason: string | null = null;
    try {
      reason = checkToolUse((payload ?? {}) as object, { repo: process.env[ENV.repo], company: process.env[ENV.home], identity: process.env[ENV.identity] });
    } catch (e) { logError('guard', e); }
    if (!reason) reason = await mergeGate(payload);
    if (!reason) return;
    try { appendSpool(stateRoot, shift, { ts: new Date().toISOString(), event: 'PreToolUse.denied', pid: process.pid, payload }); }
    catch (e) { logError('spool', e); }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    }));
    return;
  }

  try {
    appendSpool(stateRoot, shift, { ts: new Date().toISOString(), event, pid: process.pid, payload });
  } catch (e) { logError('spool', e); }

  if (event === 'Stop') {
    // Hebrew everywhere (dir-0002, #51): the owner's ~/.claude hebrew-reply-guard does not load in
    // shifts (--setting-sources project,local), so the same rule rides on this Stop hook. One retry:
    // a second block on the rewrite would loop.
    // The whole turn's text, not only the last block: the earlier blocks already streamed to the owner.
    const st = payload as { stop_hook_active?: unknown; last_assistant_message?: unknown; transcript_path?: unknown } | null;
    if (st?.stop_hook_active === true || typeof st?.last_assistant_message !== 'string') return;
    const texts = turnTexts(st.transcript_path);
    const bad = englishLines([...texts, ...(texts.includes(st.last_assistant_message) ? [] : [st.last_assistant_message])].join('\n'));
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
