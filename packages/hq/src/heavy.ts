// The heavy classes (resources-design.md §1): what a worker must `reserve` before it runs a build, a full test, docker or a
// smoke. Defined in the company's defaults (hq.config.json `heavy.classes`) and, for what is heavy in one project, in its
// charter (`heavy:`); a charter's class wins over the default of the same name. A class nobody defined is `unavailable`.

export interface HeavyClass {
  name: string;
  memMb: number;
  cpu: number;
  diskMb: number;
  timeoutMs: number;
  /** One lease at a time per key, whatever the memory (the old `flock`): `flutter-test`. */
  exclusive: string | null;
  /** Set by company-run in the command's environment. */
  env: Record<string, string>;
}

/** `mem: 8GB`, `512MB`, `3g`; a bare number is MB. Null = not a size. */
export function parseSizeMb(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(kb|mb|gb|tb|k|m|g|t)?\s*$/i.exec(v);
  if (!m) return null;
  const unit = (m[2] ?? 'm').toLowerCase()[0]!;
  const mb = Number(m[1]) * ({ k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 } as Record<string, number>)[unit]!;
  return mb > 0 ? Math.round(mb) : null;
}

/** `30m`, `90s`, `2h`; a bare number is minutes. Null = not a duration. */
export function parseDurationMs(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 60_000) : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h)?\s*$/i.exec(v);
  if (!m) return null;
  const ms = Number(m[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 } as Record<string, number>)[(m[2] ?? 'm').toLowerCase()]!;
  return ms > 0 ? Math.round(ms) : null;
}

export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
const NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** The company's classes when hq.config.json says nothing. `build` keeps Gradle from leaving a daemon behind. */
export const DEFAULT_HEAVY: Record<string, unknown>[] = [
  { class: 'build', mem: '8GB', cpu: 4, disk: '6GB', timeout: '30m', env: { GRADLE_OPTS: '-Dorg.gradle.daemon=false' } },
  { class: 'test-full', mem: '3GB', cpu: 2, exclusive: 'flutter-test', timeout: '30m' },
  { class: 'docker', mem: '4GB', cpu: 2, disk: '4GB', timeout: '30m' },
  { class: 'smoke', mem: '2GB', cpu: 2, timeout: '15m' },
];

/** A list of classes from a charter or the config. An entry without a name or a memory size is dropped, not guessed. */
export function parseHeavy(v: unknown): HeavyClass[] {
  const out: HeavyClass[] = [];
  for (const x of Array.isArray(v) ? v : []) {
    const o = (x ?? {}) as Record<string, unknown>;
    const name = typeof o.class === 'string' ? o.class.trim() : '';
    const memMb = parseSizeMb(o.mem);
    if (!NAME.test(name) || !memMb) continue;
    const cpu = typeof o.cpu === 'number' && o.cpu > 0 ? o.cpu : 1;
    const env: Record<string, string> = {};
    if (o.env && typeof o.env === 'object') for (const [k, val] of Object.entries(o.env)) if (/^[A-Z_][A-Z0-9_]*$/.test(k) && typeof val === 'string') env[k] = val;
    out.push({
      name, memMb, cpu, diskMb: parseSizeMb(o.disk) ?? 0, timeoutMs: parseDurationMs(o.timeout) ?? DEFAULT_TIMEOUT_MS,
      exclusive: typeof o.exclusive === 'string' && NAME.test(o.exclusive) ? o.exclusive : null, env,
    });
  }
  return out;
}

/** The classes a project can reserve: the company's, with the charter's replacing the same name. */
export function classesFor(defaults: unknown, charter: HeavyClass[]): Map<string, HeavyClass> {
  const m = new Map<string, HeavyClass>();
  for (const c of [...parseHeavy(defaults), ...charter]) m.set(c.name, c);
  return m;
}

/** What company-run gives the scope: the memory ceiling, and a CPU weight (100 = a shift's share) by the cpus the class asks. */
export function scopeProps(c: Pick<HeavyClass, 'memMb' | 'cpu'>): { memoryMax: string; cpuWeight: number } {
  return { memoryMax: `${c.memMb}M`, cpuWeight: Math.min(1000, Math.max(10, Math.round(c.cpu * 25))) };
}
