// What a company's own probe kinds build on (probes.ts ProbeKind), and the loader that registers them. A kind that watches one
// company's own product doesn't belong in the engine: it lives in the company's local directory (probeKindsDir, default
// <companyDir>/local/hq-probes), and hq imports every module there that exports `kinds` before it reads the charters.
// A module reaches this one through HQ_PROBE_KIT (set by the loader; a test of the module sets it to the engine's copy):
//   const kit: typeof import('…/probe-kit.ts') = await import(process.env.HQ_PROBE_KIT!);
// A kind no module registered stays unsupported, and the monitoring lead is told (probes.ts reload).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerProbeKinds, setProbeKindErrors, type ProbeKind } from './probes.ts';

export { pre } from '@company/shared';
export { runSsh, q, type SshRun } from './nodes.ts';
export { tzOffsetMs } from './timezone.ts';
export { israel, parseDuration, posNum, stringList, isIdentityId, charterTime, registerProbeKinds, probeKind,
  type ProbeKind, type ProbeContext, type ProbeSpec, type ProbeOutcome, type ProbeStateRow } from './probes.ts';

/** ANSI colors out of a log line (kubectl logs of a colored logger). */
export const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

/** kubectl's `--timestamps` (RFC3339 with nanoseconds). null when it isn't one. */
export function kubeTs(s: string): number | null {
  const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$/.exec(s);
  if (!m) return null;
  const t = Date.parse(`${m[1]}${m[2] ? m[2].slice(0, 4) : ''}${m[3]}`);
  return Number.isFinite(t) ? t : null;
}

/** A module of hq's own dependencies (`mongodb`, say), resolved from hq: a module in the company's directory has no node_modules. */
export const hqImport = (name: string): Promise<unknown> => import(name);

/** Imports every `*.ts`, `*.mjs` and `*.js` in `dir` (not `*.test.*`) and registers the `kinds` each one exports.
 *  No directory is no kinds. A module that fails to load is in `errors`; the rest are loaded all the same. */
export async function loadProbeKinds(dir: string): Promise<{ kinds: string[]; errors: { file: string; error: string }[] }> {
  const out = { kinds: [] as string[], errors: [] as { file: string; error: string }[] };
  if (!existsSync(dir)) { setProbeKindErrors([]); return out; }
  process.env.HQ_PROBE_KIT = fileURLToPath(import.meta.url);
  for (const f of readdirSync(dir).filter((x) => /\.(ts|mjs|js)$/.test(x) && !/\.test\.[a-z]+$/.test(x) && !x.endsWith('.d.ts')).sort()) {
    try {
      const m = await import(pathToFileURL(join(dir, f)).href) as { kinds?: ProbeKind[] };
      if (!Array.isArray(m.kinds)) continue;
      registerProbeKinds(m.kinds);
      out.kinds.push(...m.kinds.map((k) => k.kind));
    } catch (e) { out.errors.push({ file: f, error: (e as Error).message }); }
  }
  setProbeKindErrors(out.errors);
  return out;
}
