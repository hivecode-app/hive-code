#!/usr/bin/env node
// `company-run --lease lease-N -- <cmd>`: runs a heavy command under the lease `reserve` gave (resources-design.md §1).
// The command runs in a systemd scope with the class's MemoryMax/CPUWeight, and the scope is stopped when the command
// ends, so nothing it started (a Gradle daemon) stays behind holding memory. Every 15s a sign of life goes to hq; when
// hq says the lease ended (released, over its ceiling, the shift closed) the scope is stopped. When the command ends hq
// is told, and the lease is released. A lease hq does not know or has ended is refused; hq itself not answering is not:
// the command runs, as it did before there was a reserve, and the ceiling is the only thing missing.
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { ENV, statePaths } from '@company/shared';
import { postJson } from './hq-client.ts';
import type { HqTarget } from './hq-client.ts';
import { mergeEnv, parseRunArgs, systemdRunArgs, unitOf, type ScopePlan } from './run-args.ts';

const BEAT_MS = Number(process.env.COMPANY_RUN_BEAT_MS) || 15_000;
const HQ_TIMEOUT_MS = 10_000;
const env = process.env;
const say = (msg: string) => { process.stderr.write(`company-run: ${msg}\n`); };

const parsed = parseRunArgs(process.argv.slice(2));
if (typeof parsed === 'string') { say(parsed); process.exit(2); }
const { lease, cmd } = parsed;

const paths = statePaths(homedir(), env[ENV.stateDir] || undefined);
const target: HqTarget = env[ENV.hqUrl] ? { url: env[ENV.hqUrl] } : { socketPath: `${paths.root}/hq.sock` };
const call = (body: Record<string, unknown>) => postJson(target, '/v1/lease', { ...body, lease, ...(env[ENV.identity] ? { identity: env[ENV.identity] } : {}) }, HQ_TIMEOUT_MS);
const errorOf = (b: unknown, status: number) => (typeof (b as { error?: unknown })?.error === 'string' ? (b as { error: string }).error : `HTTP ${status}`);

interface Plan extends ScopePlan { env: Record<string, string> }

let plan: Plan | null = null;
try {
  const r = await call({ op: 'attach' });
  if (r.status === 200) plan = r.body as Plan;
  else if (r.status >= 400 && r.status < 500) { say(errorOf(r.body, r.status)); process.exit(125); }
  else say(`hq ענה ${errorOf(r.body, r.status)}: הפקודה רצה בלי תקרה`);
} catch (e) {
  say(`hq לא עונה (${e instanceof Error ? e.message : String(e)}): הפקודה רצה בלי הזמנה ובלי תקרה`);
}

const run = (file: string, args: string[]) => new Promise<number>((resolve) => { execFile(file, args, { timeout: 15_000 }, (err) => resolve(err ? 1 : 0)); });
const stopScope = () => run('systemctl', ['--user', 'stop', `${unitOf(lease)}.scope`]);
/** A user bus is there, so a scope can be made; else the ceiling is not possible on this machine. */
const scopeWorks = plan ? (await run('systemd-run', ['--user', '--scope', '--quiet', '--collect', '--', 'true'])) === 0 : false;
if (plan && !scopeWorks) say('אין systemd למשתמש במכונה הזו: הפקודה רצה בלי תקרת זיכרון');

const childEnv = mergeEnv(env, plan?.env ?? {});
const child = plan && scopeWorks
  ? spawn('systemd-run', systemdRunArgs(lease, plan, cmd), { stdio: 'inherit', env: childEnv })
  : spawn(cmd[0]!, cmd.slice(1), { stdio: 'inherit', env: childEnv });

let ended: string | null = null;
child.on('error', (e) => { say(`לא הצלחתי להריץ: ${e.message}`); void finish(127); });
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { child.kill(sig); });

const beat = plan ? setInterval(async () => {
  try {
    const r = await call({ op: 'beat' });
    const b = r.body as { state?: string; reason?: string };
    if (r.status === 200 && b.state === 'released' && !ended) {
      ended = b.reason ?? 'released';
      say(`ההזמנה ${lease} הסתיימה (${ended}): עוצר את הפקודה`);
      await stopScope();
      child.kill('SIGTERM');
    }
  } catch { /* hq does not answer: the command goes on, and hq decides by the missing beats */ }
}, BEAT_MS) : null;
beat?.unref();

async function finish(code: number): Promise<void> {
  if (beat) clearInterval(beat);
  if (plan && scopeWorks) await stopScope(); // whatever the command left behind goes with the scope
  if (plan) { try { await call({ op: 'finish', exit_code: code }); } catch { /* hq sweeps a lease whose beats stopped */ } }
  process.exit(code);
}

child.on('exit', (code, signal) => { void finish(code ?? (signal ? 128 + (({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[signal] ?? 0) : 1)); });
