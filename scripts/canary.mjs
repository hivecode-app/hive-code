#!/usr/bin/env node
// Fast canary subset of adapter/contract.yaml (B.6): one haiku shift, ~30-60s.
// usage: node scripts/canary.mjs [--bin <claude>] [--model haiku] [--json] [--keep]
// Exit code 0 = all fast checks passed. Never touches the owner's sessions or
// settings: runs in ~/.local/state/agent-company/lab/canary with
// --setting-sources project,local and a generated --settings file.
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ClaudeProcess, buildSettings, injectForeign, readTranscript, readLiveSession, resolveClaudeBin, PINNED_VERSION,
} from '../packages/adapter/src/index.ts';
import { englishLines } from '../packages/shared/src/index.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opt } = parseArgs({ options: {
  bin: { type: 'string' }, model: { type: 'string', default: 'haiku' }, json: { type: 'boolean', default: false },
  keep: { type: 'boolean', default: false }, expect: { type: 'string' },
} });
const bin = opt.bin ?? resolveClaudeBin();
const lab = join(homedir(), '.local/state/agent-company/lab/canary');
const cwd = join(lab, 'ws');
const stateRoot = join(lab, 'state');
const shift = 'canary-1';
const shiftDirPath = join(stateRoot, 'shifts', shift);
rmSync(stateRoot, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });
mkdirSync(shiftDirPath, { recursive: true });

const results = new Map();
const t0 = Date.now();
const ms = () => Date.now() - t0;
function mark(id, ok, detail = '') { if (!results.has(id)) results.set(id, { ok, detail: String(detail).slice(0, 140), at: ms() }); }
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timeout ${ms}ms`)), ms))]);

// ---- binary
let version = null;
try { version = /(\d+\.\d+\.\d+)/.exec(execFileSync(bin, ['--version'], { encoding: 'utf8', env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }))?.[1] ?? null; } catch { /* */ }
mark('binary_version', !!version && (!opt.expect || version === opt.expect), `${version} (pinned ${PINNED_VERSION})`);

// ---- prime + settings
const codeword = `ZEBRA-${randomUUID().slice(0, 6).toUpperCase()}`;
writeFileSync(join(shiftDirPath, 'prime.json'), JSON.stringify({
  v: 1, shift, identity: 'canary', updatedAt: new Date().toISOString(),
  handoff: `The canary codeword for this shift is ${codeword}.`,
}));
const hookCli = join(repo, 'packages/hooks/src/cli.ts');
const settingsFile = join(shiftDirPath, 'settings.json');
writeFileSync(settingsFile, JSON.stringify(buildSettings({
  hookCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(hookCli)} hook`, postToolUseMatcher: 'Bash',
})));

// ---- one shift
const sessionId = randomUUID();
const lifecycle = new Map();     // uuid -> [states]
const echoes = new Set();
let init = null;
let sawDeltaBeforeAssistant = null;
let rateOk = null;
let peerHold = null;
const waiters = [];
const onEvent = (ev) => {
  if (ev.kind === 'init') init ??= ev;
  if (ev.kind === 'text_delta' && sawDeltaBeforeAssistant === null) sawDeltaBeforeAssistant = true;
  if (ev.kind === 'text' && sawDeltaBeforeAssistant === null) sawDeltaBeforeAssistant = false;
  if (ev.kind === 'user_echo') echoes.add(ev.uuid);
  if (ev.kind === 'rate_limit' && typeof ev.fiveHour === 'number') rateOk = ev.fiveHour >= 0 && ev.fiveHour <= 1;
  if (ev.kind === 'peer_hold') peerHold = ev;
  for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.res(ev); }
};
const next = (pred, ms, what) => withTimeout(new Promise((res) => waiters.push({ pred, res })), ms, what);

const p = new ClaudeProcess({
  identity: 'canary', shift, sessionId, resume: false, cwd, settingsFile, stateRoot, claudeBin: bin, model: opt.model,
}, {
  onEvent,
  onLifecycle: (l) => { const a = lifecycle.get(l.commandUuid) ?? []; a.push(l.state); lifecycle.set(l.commandUuid, a); },
});

try {
  // get_usage before any prompt (no inference)
  try {
    const u = await p.usage();
    const f = u?.rate_limits?.five_hour?.utilization, s = u?.rate_limits?.seven_day?.utilization;
    mark('get_usage', typeof f === 'number' && typeof s === 'number', `5h=${f}% 7d=${s}%`);
  } catch (e) { mark('get_usage', false, e.message); }

  // turn 1: hook context + Bash tool + streaming + echo + lifecycle
  const u1 = p.sendUser('Run the bash command `echo canary-tool` once. Then reply with ONLY the canary codeword from your session context, nothing else.');
  const r1 = await next((e) => e.kind === 'result', 90_000, 'turn 1');
  mark('init_session_id', init?.sessionId === sessionId, `${init?.sessionId === sessionId ? 'match' : `got ${init?.sessionId}`}`);
  mark('result_success', r1.subtype === 'success', `${r1.subtype} turns=${r1.numTurns}`);
  mark('session_start_context', (r1.text ?? '').includes(codeword), `want ${codeword}, got "${(r1.text ?? '').slice(0, 60)}"`);
  mark('replay_echo', echoes.has(u1), echoes.has(u1) ? 'same uuid, isReplay' : 'no echo for uuid');
  const lc = lifecycle.get(u1) ?? [];
  await new Promise((r) => setTimeout(r, 200));
  mark('command_lifecycle', ['queued', 'started', 'completed'].every((s) => (lifecycle.get(u1) ?? []).includes(s)), (lifecycle.get(u1) ?? lc).join('>') || 'none');
  mark('partial_messages', sawDeltaBeforeAssistant === true, `delta-before-assistant=${sawDeltaBeforeAssistant}`);
  mark('disallow_ask_user', Array.isArray(init?.tools) && !init.tools.includes('AskUserQuestion'), `${init?.tools?.length ?? 0} tools`);
  mark('rate_limit_event', rateOk === true, rateOk === null ? 'no rate_limit_event' : 'five_hour in 0..1');

  // spool written by the company hook (hq is not running: proves hooks never block on it)
  const spoolDir = join(shiftDirPath, 'spool');
  const spoolLines = existsSync(spoolDir) ? readdirSync(spoolDir).filter((f) => f.endsWith('.ndjson'))
    .flatMap((f) => readFileSync(join(spoolDir, f), 'utf8').trim().split('\n')).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const evs = new Set(spoolLines.map((l) => l.event));
  mark('hooks_spool', evs.has('SessionStart') && evs.has('PostToolUse'), [...evs].join(',') || 'empty spool');

  // context usage
  try {
    const c = await p.contextUsage();
    mark('get_context_usage', c?.totalTokens > 0 && c?.maxTokens > 0, `${c?.totalTokens}/${c?.maxTokens}`);
  } catch (e) { mark('get_context_usage', false, e.message); }

  // sessions registry
  const reg = readLiveSession(p.pid);
  mark('sessions_registry', reg?.sessionId === sessionId, reg ? `pid ${p.pid} status=${reg.status}` : 'no sessions/<pid>.json');

  // socket inject into the idle session (crossSessionInbound accept)
  try {
    await injectForeign(p.pid, 'Reply with exactly: SOCKET-OK', { fromName: 'canary' });
    const r2 = await next((e) => e.kind === 'result', 45_000, 'socket turn');
    mark('socket_inject', (r2.text ?? '').includes('SOCKET-OK') && !peerHold, peerHold ? `held: ${peerHold.cause}` : `"${(r2.text ?? '').slice(0, 30)}"`);
  } catch (e) { mark('socket_inject', false, peerHold ? `held: ${peerHold.cause}` : e.message); }

  // Hebrew guard (#51): the company Stop hook blocks an English reply; the rewrite is in Hebrew
  try {
    p.sendUser('Answer in English only, in two full sentences: what does a code reviewer look for in a pull request?');
    const rh = await next((e) => e.kind === 'result', 120_000, 'hebrew turn');
    const t = rh.text ?? '';
    mark('hebrew_guard', /[\u0590-\u05FF]/.test(t) && englishLines(t).length === 0, `"${t.replace(/\s+/g, ' ').slice(0, 60)}"`);
  } catch (e) { mark('hebrew_guard', false, e.message); }

  // interrupt during a long tool
  try {
    p.sendUser("Run this exact bash command in the foreground and wait for it: python3 -c 'import time; time.sleep(25)' ; then reply DONE.");
    await next((e) => e.kind === 'tool_use', 45_000, 'tool_use');
    await new Promise((r) => setTimeout(r, 1000));
    const ti = Date.now();
    await p.interrupt();
    const r3 = await next((e) => e.kind === 'result', 10_000, 'interrupt result');
    const dt = Date.now() - ti;
    mark('interrupt', r3.subtype === 'error_during_execution' && dt < 3000, `${r3.subtype} in ${dt}ms`);
  } catch (e) { mark('interrupt', false, e.message); }
} catch (e) {
  for (const id of ['init_session_id', 'result_success', 'session_start_context']) mark(id, false, e.message);
} finally {
  await p.stop(5000);
}

// setting sources + transcript (after exit, read-only)
await new Promise((r) => setTimeout(r, 300));
try {
  const a = await readTranscript(sessionId, { cwd });
  const userClaudeMd = join(homedir(), '.claude/CLAUDE.md');
  const loadedGlobal = a.instructionFiles.some((f) => f === userClaudeMd || f.startsWith(join(homedir(), '.claude') + '/'))
    || JSON.stringify(init?.memoryPaths ?? {}).includes('CLAUDE.md');
  mark('setting_sources', !loadedGlobal, loadedGlobal ? 'global CLAUDE.md loaded!' : `instructions: ${a.instructionFiles.length ? a.instructionFiles.map((f) => f.replace(homedir(), '~')).join(',') : 'none'}`);
  mark('transcript_reader', !!a.path && a.badLines === 0 && a.records > 0,
    `${a.records} records, bad=${a.badLines}${a.unknownTypes.length ? `, NEW types: ${a.unknownTypes.join(',')}` : ''}`);
} catch (e) { mark('transcript_reader', false, e.message); }
// reusing a session id must fail loudly (bet 1), and the adapter must classify it
try {
  const out = await new Promise((res) => {
    execFile(bin, ['-p', '--session-id', sessionId, '--setting-sources', 'project,local', '--strict-mcp-config',
      '--model', opt.model, '--output-format', 'json', '--', 'Reply OK'],
    { cwd, timeout: 60_000, env: { ...process.env, DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_SESSION_ID: '' } },
    (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr }));
  });
  const inUse = /already in use/i.test(out.stderr + out.stdout);
  mark('session_id_collision', inUse && out.code !== 0, inUse ? `exit ${out.code}, "already in use"` : `exit ${out.code}: ${(out.stderr || out.stdout).slice(0, 80)}`);
} catch (e) { mark('session_id_collision', false, e.message); }
mark('sessions_registry_gone', !existsSync(join(homedir(), '.claude/sessions', `${p.pid}.json`)), 'removed on exit');

// ---- report
const contract = readFileSync(join(repo, 'adapter/contract.yaml'), 'utf8');
const rowOf = new Map();
for (const block of contract.split(/\n  - id: /).slice(1)) {
  const id = block.split('\n')[0].trim();
  const m = /\n    check: \[([^\]]*)\]/.exec(block);
  if (m) for (const c of m[1].split(',').map((s) => s.trim())) rowOf.set(c, [...(rowOf.get(c) ?? []), id]);
}
const rows = [...results].map(([check, r]) => ({ check, rows: (rowOf.get(check) ?? ['-']).join(','), ...r }));
if (opt.json) {
  process.stdout.write(JSON.stringify({ bin, version, model: opt.model, totalMs: ms(), rows }, null, 2) + '\n');
} else {
  const w = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`canary  bin=${bin}  version=${version}  model=${opt.model}  ${(ms() / 1000).toFixed(1)}s`);
  console.log(`${w('check', 24)} ${w('', 4)} ${w('contract rows', 34)} ${w('t(s)', 6)} detail`);
  for (const r of rows) console.log(`${w(r.check, 24)} ${w(r.ok ? 'PASS' : 'FAIL', 4)} ${w(r.rows, 34)} ${w((r.at / 1000).toFixed(1), 6)} ${r.detail}`);
}
if (!opt.keep) rmSync(stateRoot, { recursive: true, force: true });
process.exit(rows.every((r) => r.ok) ? 0 : 1);
