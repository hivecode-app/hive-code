// company-run: the parts that need no process (args, and the systemd-run line), so a test can read them.

export interface RunArgs { lease: string; cmd: string[] }

/** `--lease lease-N -- cmd args…` (also `--lease=lease-N`). Returns the problem as a sentence when the line is not that. */
export function parseRunArgs(argv: string[]): RunArgs | string {
  let lease = '';
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') { i++; break; }
    if (a === '--lease') lease = argv[++i] ?? '';
    else if (a.startsWith('--lease=')) lease = a.slice('--lease='.length);
    else return `דגל לא מוכר: ${a}`;
  }
  const cmd = argv.slice(i);
  if (!/^lease-\d+$/.test(lease)) return 'חסר --lease lease-N (המספר חוזר מ-`reserve`)';
  if (!cmd.length) return 'חסרה הפקודה אחרי --: company-run --lease lease-N -- <הפקודה>';
  return { lease, cmd };
}

export interface ScopePlan { memoryMax: string; cpuWeight: number; remainingMs?: number }

export const unitOf = (lease: string) => `company-run-${lease}`;

/** The scope ends by itself when the lease's time does (plus a minute for company-run to stop it first), even if company-run is gone. */
const runtimeMax = (plan: ScopePlan): string[] => (plan.remainingMs && plan.remainingMs > 0 ? ['-p', `RuntimeMaxSec=${Math.ceil(plan.remainingMs / 1000) + 60}`] : []);

/** `GRADLE_OPTS` the project already set stay; the class adds its own to them. Other names are the class's. */
export function mergeEnv(base: NodeJS.ProcessEnv, add: Record<string, string>): NodeJS.ProcessEnv {
  const out = { ...base };
  for (const [k, v] of Object.entries(add)) out[k] = /_OPTS$/.test(k) && base[k] && !base[k]!.includes(v) ? `${base[k]} ${v}` : v;
  return out;
}

/** The command line of the scope: the ceiling of the class around the worker's command. */
export function systemdRunArgs(lease: string, plan: ScopePlan, cmd: string[]): string[] {
  return ['--user', '--scope', '--quiet', '--collect', `--unit=${unitOf(lease)}`, '-p', `MemoryMax=${plan.memoryMax}`, '-p', `CPUWeight=${plan.cpuWeight}`, ...runtimeMax(plan), '--', ...cmd];
}
