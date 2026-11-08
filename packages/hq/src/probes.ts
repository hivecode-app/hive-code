// probe-runner (B.17), observe-only in phase 1: code, no tokens. Probes are declared in each project
// charter (company/projects/<p>.md) as a fenced ```yaml block with a top-level `probes:` list
// (frontmatter `monitoring:` from the B.17 example is accepted too). Kinds this hq doesn't know, or entries it can't read,
// are listed as unsupported with the reason and told to the monitoring lead once, never silently dropped.
// `disk` (monitoring-spec §3.2 step 4) is the first ssh-shaped probe: read-only `df`, measured from hq's machine only.
// `latency` measures network jitter to a host: `ping -c 20 -i 0.2 -q` from hq's machine (a node with jitter is a slow node, 22/10).
// `kubelet` reads a cluster over ssh (`kubectl get --raw /version`, `kubectl get nodes`) and compares each node's kubeletVersion to the
// apiserver's: a node on another version is one anomaly to the monitoring lead, held until it matches again (task 697: six 1.34 kubelets on a 1.33 master, 9 days).
// No answer (timeout, ssh failed, garbage output) is "unknown": not a failure, never counted toward fail_after.
// For latency, 100% loss is an answer (a failure); hosts that drop ICMP stay out of the charter.
// `fail_after` consecutive failures → one `now` message to the monitoring lead with the evidence; recovery → one note.
// `fail_for` (http only, 27/10): after a failure that got an answer, look again every FAIL_FOR_RETRY_MS, and a failure
// still there fail_for after the first one is crossed without waiting for fail_after (then the same witness). The retries are extra
// runs on top of `every`: they don't count toward fail_after and don't move its schedule. A timeout starts and crosses it like a
// status (the witness filters out a fault on our side). A timed-out run holds its tick for timeoutMs, so a stuck server is crossed
// at about fail_for + 2×timeout + the witness: fail_for should be well above timeout; a DNS that didn't answer (EAI_AGAIN) or unknown doesn't start or move that
// clock, and fail_after still covers it as before.
// Latency (memory/company/monitoring/probe-alerts-spec.md, 26/10): over avg/mdev with the loss under its threshold is jitter,
// recorded and counted in a daily digest by node; it wakes the monitoring lead only when it lasts JITTER_SUSTAIN_ROUNDS samples in a row and it has
// an impact (jitterImpact, 28/10): a service probe of its project failing, or the node not Ready, in that window. Without one it
// is noted quietly (probe.jitter_quiet) and counted in the digest, which drafts a Contabo ticket only for a node that had an impact. More than SHARED_MIN_NODES nodes losing pings in one round
// is one event; it reaches the owner only when it lasts past SHARED_PERSIST_MS and http fails too or there is no witness.
// `prod: false` (http only, 03/11): its anomaly arrives at `later`, low urgency, and its failure is no impact for jitter,
// a shared event or a root signal.
// `alertmanager` reads the cluster's own critical alerts over ssh (alertmanager.ts): one message per fingerprint, held until it is gone.
// `cluster` reads the layer under the services of a whole k3s cluster over one ssh (root-signals.ts): its findings and messages are its own.
// Other kinds come from outside the engine (ProbeKind, registered by probe-kit.ts from the company's local directory): a probe of
// one of them is parsed, run, recorded and told through the hooks of its kind.
import { OWNER, pre } from '@company/shared';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadavg, cpus, homedir, hostname } from 'node:os';
import { execFile } from 'node:child_process';
import { memInfoMb } from './proc.ts';
import { tzOffsetMs } from './timezone.ts';
import { runSsh, q, type SshRun } from './nodes.ts';
import { getIdentity } from './org.ts';
import { parse } from 'yaml';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';
import type { Inbox } from './inbox.ts';
import { RootWatch, isSshTarget, type ClusterSpec } from './root-signals.ts';
import { amRound, isNamespace, readAlertmanager, NS_TIMEOUT_S, RESOLVE_AFTER_MS, type AlertmanagerSpec, type AmReading, type AmState, type LabelSelector } from './alertmanager.ts';
import { createHash } from 'node:crypto';

export interface ProbeSpec {
  key: string;              // <project>/<id>
  project: string;
  id: string;
  /** A kind of the engine, one registered (ProbeKind), or 'unsupported' (then `reason` says why). */
  kind: 'http' | 'disk' | 'latency' | 'kubelet' | 'cluster' | 'alertmanager' | 'unsupported' | (string & {});
  reason?: string;
  /** Unsupported because no field of it is a kind this hq has (a company's kind whose module isn't loaded): told to the lead. */
  unknownKind?: true;
  url?: string;
  disk?: { target: string; host: string | null; path: string; identityFile: string | null; maxPercent: number };  // host null = local
  latency?: { host: string; maxAvgMs: number; maxMdevMs: number; maxLossPercent: number };
  kubelet?: { target: string; identityFile: string | null };  // ssh target of a machine with kubectl for the cluster (its master)
  alertmanager?: AlertmanagerSpec;  // the cluster's Alertmanager in each namespace listed, read over ssh to its master
  cluster?: ClusterSpec;     // root signals (root-signals.ts): the k3s master to read the cluster from, over ssh
  prod?: false;              // `prod: false` in the charter (http only): not production. Its anomaly arrives at `later`, low urgency, and its failure is no impact of jitter or a shared event
  method: string;
  expect: number[];
  maxLatencyMs: number | null;
  everyMs: number;
  timeoutMs: number;
  failAfter: number;
  failForMs: number | null;  // http: a failure lasting this long is crossed without waiting for fail_after (FAIL_FOR_RETRY_MS retries)
  raw: Record<string, unknown>;
}

/** How often a `fail_for` probe is looked at again while a failure is open. */
export const FAIL_FOR_RETRY_MS = 10_000;

/** The row of probe_state: a kind's hooks read it (when it last ran) and set anomaly_open themselves. */
export interface ProbeStateRow { probe_id: string; consecutive_failures: number; anomaly_open: number; last_run_at: number | null; last_ok_at: number | null }

/** What a kind's hooks get from the runner. */
export interface ProbeContext {
  store: Store;
  mailbox: Mailbox;
  /** The monitoring lead: who the probes' messages go to. */
  lead: string;
  /** Every probe of the charters, as last reloaded. */
  readonly probes: ProbeSpec[];
  /** Keys being read now (a kind may add its own, as `<key>#scan`). */
  inflight: Set<string>;
  state(key: string): ProbeStateRow | undefined;
  /** The runner's run (a test may replace it): the kind's own `run` for its probes. */
  run(p: ProbeSpec): Promise<ProbeOutcome>;
  /** Record an outcome read outside the tick, as the tick records its own (then `round`). */
  record(p: ProbeSpec, o: ProbeOutcome, now: number): void;
  /** An identity active in org.yaml. */
  known(id: string): boolean;
}

/** A probe kind that isn't the engine's (a company's own product, say): its charter field and its hooks. Registered with
 *  registerProbeKinds; probe-kit.ts loads them from the company's local directory. */
export interface ProbeKind {
  /** The charter field that declares it (`<kind>: <target>`), and the probe's `kind`. */
  kind: string;
  /** The fields this kind adds to the ProbeSpec, and its defaults for `every` and `timeout`. null: the entry is malformed (unsupported). */
  parse(r: Record<string, unknown>, h: { identityFile: string | null }): { fields: Record<string, unknown>; everyMs?: number; timeoutMs?: number } | null;
  /** Read once: only the outcome, never a change. No answer is `unknown`. */
  run(p: ProbeSpec, ctx: ProbeContext): Promise<ProbeOutcome>;
  /** Not run by the tick: its `tick` starts its own reads (a long one doesn't hold the other probes) and records them (ctx.record). */
  alone?: boolean;
  /** The probe as the tick runs it (what it learned since the charter, say). */
  prepare?(p: ProbeSpec, ctx: ProbeContext): ProbeSpec;
  /** Every tick, before the tick's own runs, with this kind's probes. Not awaited. */
  tick?(probes: ProbeSpec[], ctx: ProbeContext, now: number): void;
  /** After every recorded outcome, an unknown one too. */
  round?(p: ProbeSpec, o: ProbeOutcome, ctx: ProbeContext, now: number): void;
  /** Its messages are its own (round): fail_after and the recovery note don't apply. */
  ownMessages?: boolean;
  /** Its failure is a service failing: an impact for jitter in its project. */
  service?: boolean;
  /** Outcome fields that are readings: not written to the probe.result event. */
  readings?: string[];
  /** What the anomaly's head says about the probe, and the recovery note (fail_after kinds). */
  anomaly?(p: ProbeSpec): string;
  recovered?(p: ProbeSpec, o: ProbeOutcome): string;
  /** Its fields in the probes summary (the API). */
  summary?(p: ProbeSpec, ctx: ProbeContext): Record<string, unknown>;
}

const kinds = new Map<string, ProbeKind>();
/** The kinds the engine has itself, by their charter field. */
const BUILTIN_FIELDS = ['http', 'disk', 'latency', 'kubelet', 'cluster', 'alertmanager'];

/** Registers kinds (a kind of the same name replaces the one before). One of the engine's own names is refused. */
export function registerProbeKinds(ks: ProbeKind[]): void {
  for (const k of ks) {
    if (!/^[a-z][a-z0-9_]*$/.test(k.kind) || BUILTIN_FIELDS.includes(k.kind) || k.kind === 'unsupported') throw new Error(`probe kind ${JSON.stringify(k.kind)}: not a name a kind can have`);
    kinds.set(k.kind, k);
  }
}

export const probeKind = (kind: string): ProbeKind | undefined => kinds.get(kind);

/** The local modules that failed to load (probe-kit.ts): an unknown kind's reason says so, with the error. */
let loadErrors: { file: string; error: string }[] = [];
export function setProbeKindErrors(errors: { file: string; error: string }[]): void { loadErrors = errors; }

export function parseDuration(v: unknown, dflt: number): number {
  if (typeof v === 'number') return v * 1000;
  if (typeof v !== 'string') return dflt;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(v.trim());
  if (!m) return dflt;
  const n = Number(m[1]);
  return n * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] ?? 's'] ?? 1000);
}

/** `root@host:/path` or `local:/path`. null when it isn't one. */
export function parseDiskTarget(s: string): { host: string | null; path: string } | null {
  const i = s.indexOf(':');
  if (i <= 0) return null;
  const host = s.slice(0, i).trim(), path = s.slice(i + 1).trim();
  if (!path.startsWith('/') || host.startsWith('-') || /[\s\0]/.test(host)) return null;  // `-…` would reach ssh as an option
  return { host: host === 'local' ? null : host, path };
}

/** A host for ping: an address or a name, never something ping could read as an option. */
export function isPingHost(s: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(s);
}

/** A time in the charter: an ISO date or date-time (YAML may hand a Date). A date alone is midnight in Israel. NaN when it isn't one. */
export const charterTime = (v: unknown): number => {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== 'string') return NaN;
  const t = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) { const utc = Date.parse(`${t}T00:00:00Z`); return utc - tzOffsetMs(utc, 'Asia/Jerusalem'); }
  return /^\d{4}-\d{2}-\d{2}T/.test(t) ? Date.parse(t) : NaN;
};

/** A missing threshold takes the default; one that is there but isn't a number is NaN, and the probe becomes unsupported (as disk does). */
export const posNum = (v: unknown, dflt: number): number => { if (v == null) return dflt; const n = typeof v === 'number' ? v : NaN; return Number.isFinite(n) && n >= 0 ? n : NaN; };

/** `{key: value}` of label names and values, at least one. null when it isn't one. */
function labelSelector(v: unknown): LabelSelector | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const e = Object.entries(v as Record<string, unknown>);
  if (!e.length || !e.every(([k, x]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && (typeof x === 'string' || typeof x === 'number'))) return null;
  return Object.fromEntries(e.map(([k, x]) => [k, String(x)]));
}

/** A list of non-empty strings. null when it isn't one. */
export const stringList = (v: unknown): string[] | null => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim()) ? v.map((x) => (x as string).trim()) : null;

export const isIdentityId = (s: string): boolean => /^[a-z][a-z0-9-]*$/.test(s);

/** Extract probe declarations from a project charter. */
export function parseCharterProbes(project: string, md: string): ProbeSpec[] {
  const lists: unknown[] = [];
  const fm = /^---\n([\s\S]*?)\n---/.exec(md);
  if (fm) {
    // A broken frontmatter must not stop hq from starting; the scheduler reports it (charter.invalid).
    let y: Record<string, unknown> = {};
    try { y = (parse(fm[1]!) ?? {}) as Record<string, unknown>; } catch { /* no probes from it */ }
    if (Array.isArray(y.monitoring)) lists.push(...y.monitoring);
    if (Array.isArray(y.probes)) lists.push(...y.probes);
  }
  for (const m of md.matchAll(/```ya?ml\n([\s\S]*?)```/g)) {
    let y: unknown;
    try { y = parse(m[1]!); } catch { continue; }
    if (y && typeof y === 'object' && Array.isArray((y as { probes?: unknown }).probes)) lists.push(...(y as { probes: unknown[] }).probes);
  }
  const out: ProbeSpec[] = [];
  for (const p of lists) {
    if (!p || typeof p !== 'object') continue;
    const r = p as Record<string, unknown>;
    const id = String(r.id ?? '');
    if (!id) continue;
    const exp = r.expect ?? 200;
    const identityFile = typeof r.identity === 'string' ? r.identity.replace(/^~(?=\/|$)/, homedir()) : null;
    const dt = typeof r.disk === 'string' ? parseDiskTarget(r.disk) : null;
    const maxPct = Number(r.max_percent);
    const disk = dt && Number.isFinite(maxPct) && maxPct > 0 && maxPct <= 100
      ? { target: String(r.disk), host: dt.host, path: dt.path, maxPercent: maxPct,
          identityFile }
      : undefined;
    const lt = typeof r.latency === 'string' && isPingHost(r.latency.trim())
      ? { host: r.latency.trim(), maxAvgMs: posNum(r.max_avg_ms, 10), maxMdevMs: posNum(r.max_mdev_ms, 20), maxLossPercent: posNum(r.max_loss_percent, 5) }
      : undefined;
    const latency = lt && [lt.maxAvgMs, lt.maxMdevMs, lt.maxLossPercent].every(Number.isFinite) ? lt : undefined;
    // `root@host`: never something ssh could read as an option.
    const kubelet = typeof r.kubelet === 'string' && /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9.:-]*$/.test(r.kubelet.trim())
      ? { target: r.kubelet.trim(), identityFile } : undefined;
    const cluster: ClusterSpec | undefined = typeof r.cluster === 'string' && isSshTarget(r.cluster.trim())
      ? { ssh: r.cluster.trim(), identityFile, ignore: Array.isArray(r.ignore) ? r.ignore.map(String) : [] }
      : undefined;
    // fail_for is for http; anywhere else, or not a duration, the probe is unsupported (listed, not silently dropped).
    const failForMs = r.fail_for == null ? null : parseDuration(r.fail_for, NaN);
    const badFailFor = failForMs != null && (typeof r.http !== 'string' || !(failForMs > 0));
    // prod is a boolean, and `false` is for http only (the other kinds' messages are their own): otherwise unsupported, not ignored.
    const badProd = r.prod != null && (typeof r.prod !== 'boolean' || (r.prod === false && typeof r.http !== 'string'));
    // An explicit list of namespaces, every one a namespace name: a probe that can't say where to look is unsupported.
    // An entry is a name, or `{name, prod: false}` for a namespace that isn't production (its alerts arrive at `later`, low urgency).
    const nsEntries = Array.isArray(r.namespaces) ? r.namespaces.map((n) => n && typeof n === 'object'
      ? { name: String((n as { name?: unknown }).name ?? ''), prod: (n as { prod?: unknown }).prod !== false } : { name: String(n), prod: true }) : [];
    const nss = nsEntries.map((n) => n.name);
    const resolveAfterMs = r.resolve_after == null ? RESOLVE_AFTER_MS : parseDuration(r.resolve_after, NaN);
    // Which alerts are this probe's (alertmanager.ts): `match` a selector, `exclude` one or a list, `critical`/`warning` alertnames,
    // `notify` an identity and `cc` a list of them. Any of these there but malformed makes the probe unsupported.
    const amMatch = r.match == null ? undefined : labelSelector(r.match);
    const amExclude = r.exclude == null ? [] : (Array.isArray(r.exclude) ? r.exclude : [r.exclude]).map(labelSelector);
    const amCritical = r.critical == null ? [] : stringList(r.critical);
    const amWarning = r.warning == null ? [] : stringList(r.warning);
    const amNotify = r.notify == null ? undefined : typeof r.notify === 'string' && isIdentityId(r.notify.trim()) ? r.notify.trim() : null;
    const amCc = r.cc == null ? [] : stringList(typeof r.cc === 'string' ? [r.cc] : r.cc);
    const amOk = amMatch !== null && amExclude.every((x) => x !== null) && amCritical && amWarning && amNotify !== null && amCc && amCc.every(isIdentityId)
      && !amCritical.some((n) => amWarning.includes(n));
    const alertmanager: AlertmanagerSpec | undefined = typeof r.alertmanager === 'string' && isSshTarget(r.alertmanager.trim()) && nss.length && nss.every(isNamespace)
      && resolveAfterMs >= 0 && amOk
      ? { target: r.alertmanager.trim(), identityFile, namespaces: [...new Set(nss)], nonProd: [...new Set(nsEntries.filter((n) => !n.prod).map((n) => n.name))], resolveAfterMs,
          ...(amMatch ? { match: amMatch } : {}), ...(amExclude.length ? { exclude: amExclude as LabelSelector[] } : {}),
          ...(amCritical!.length ? { critical: amCritical! } : {}), ...(amWarning!.length ? { warning: amWarning! } : {}),
          ...(amNotify ? { notify: amNotify } : {}), ...(amCc!.length ? { cc: [...new Set(amCc!)].filter((c) => c !== amNotify) } : {}) } : undefined;
    // A registered kind is the entry's only kind: beside another one it is unsupported, not swallowed by it.
    const fields = Object.keys(r).filter((k) => r[k] != null);
    const ownKind = fields.filter((k) => kinds.has(k));
    const clash = ownKind.length > 0 && fields.filter((k) => kinds.has(k) || BUILTIN_FIELDS.includes(k)).length > 1;
    const own = ownKind.length === 1 && !clash ? kinds.get(ownKind[0]!)!.parse(r, { identityFile }) : null;
    const builtin = typeof r.http === 'string' ? 'http' : disk ? 'disk' : latency ? 'latency' : kubelet ? 'kubelet' : cluster ? 'cluster' : alertmanager ? 'alertmanager' : null;
    const kind = badFailFor || badProd || clash ? 'unsupported' : ownKind.length ? (own ? ownKind[0]! : 'unsupported') : builtin ?? 'unsupported';
    const named = fields.filter((k) => kinds.has(k) || BUILTIN_FIELDS.includes(k));
    const reason = kind !== 'unsupported' ? undefined
      : badFailFor ? 'fail_for הוא ל-http בלבד, ומשך חיובי'
      : badProd ? 'prod הוא true או false, ו-false ל-http בלבד'
      : clash ? `כמה סוגים ברשומה אחת: ${named.join(', ')}`
      : named.length ? `הרשומה של ${named[0]} לא תקינה (יעד, סף או שדה)`
      : `אין ב-hq הזה סוג probe לאף שדה ברשומה (${fields.filter((k) => k !== 'id').join(', ') || 'ריקה'}): ${loadErrors.length
        ? `מודול מקומי לא נטען (${loadErrors.map((e) => `${e.file}: ${e.error}`).join('; ')})`
        : 'סוג של מודול מקומי שלא נטען?'}`;
    out.push({
      key: `${project}/${id}`, project, id, kind, ...(reason ? { reason } : {}), ...(kind === 'unsupported' && !named.length ? { unknownKind: true as const } : {}),
      url: typeof r.http === 'string' ? r.http : undefined,
      disk, latency, kubelet, cluster, alertmanager,
      ...(own && kind !== 'unsupported' ? own.fields : {}),
      // Observe-only: a probe may only read. Anything but GET/HEAD in a charter is ignored.
      method: typeof r.method === 'string' && r.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET',
      expect: (Array.isArray(exp) ? exp : [exp]).map(Number),
      maxLatencyMs: r.max_latency_ms != null ? Number(r.max_latency_ms) : (r.max_latency != null ? parseDuration(r.max_latency, 0) : null),
      everyMs: parseDuration(r.every, own?.everyMs ?? (cluster ? 300_000 : 60_000)),
      // 20 pings at 0.2s with -W 2 end within ~6s; the default leaves room so a dead host ends in ping's summary, not a kill.
      timeoutMs: parseDuration(r.timeout, own?.timeoutMs ?? (cluster ? 180_000 : latency ? 20_000 : alertmanager ? Math.max(60_000, (alertmanager.namespaces.length * NS_TIMEOUT_S + 20) * 1000) : kubelet ? 30_000 : 10_000)),
      failAfter: Number(r.fail_after ?? 3),
      failForMs: badFailFor ? null : failForMs,
      ...(r.prod === false && !badProd ? { prod: false as const } : {}),
      raw: r,
    });
  }
  return out;
}

export function loadProbes(companyDir: string): ProbeSpec[] {
  const dir = join(companyDir, 'projects');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
    .flatMap((f) => parseCharterProbes(basename(f, '.md'), readFileSync(join(dir, f), 'utf8')));
}

/** `unknown`: no answer came back. Not a failure (ok is meaningless then); the runner doesn't count it.
 *  `noAnswer` (http): a DNS that didn't answer (EAI_AGAIN). A failure for fail_after as always, but it doesn't move fail_for's clock.
 *  A timeout is not noAnswer: it starts and crosses fail_for like a status. A registered kind adds its own reading fields (ProbeKind.readings). */
export interface ProbeOutcome { ok: boolean; status: number | null; latencyMs: number | null; error: string | null; unknown?: boolean; noAnswer?: boolean; alerts?: AmReading; percent?: number; ping?: PingStats; versions?: KubeletVersions }

/** The apiserver's version and each node's kubelet version, as `kubectl` reported them ('' = the node has none yet, still registering). */
export interface KubeletVersions { master: string; nodes: Record<string, string> }

/** rtt fields are null when nothing came back (no rtt line) or, for mdev, when the ping doesn't report it (busybox). */
export interface PingStats { transmitted: number; received: number; lossPercent: number; min: number | null; avg: number | null; max: number | null; mdev: number | null }

/** The summary of `ping -q` (iputils, busybox). null when it isn't ping output. */
export function parsePing(out: string): PingStats | null {
  const c = /(\d+) packets transmitted, (\d+) (?:packets )?received,.*?(\d+(?:\.\d+)?)% packet loss/.exec(out);
  const r = /(?:rtt|round-trip) min\/avg\/max(?:\/(?:mdev|stddev))? = (\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))? ms/.exec(out);
  if (!c || Number(c[1]) === 0 || (!r && Number(c[2]) > 0)) return null;
  const n = (v: string | undefined) => v != null ? Number(v) : null;
  return { transmitted: Number(c[1]), received: Number(c[2]), lossPercent: Number(c[3]), min: n(r?.[1]), avg: n(r?.[2]), max: n(r?.[3]), mdev: n(r?.[4]) };
}

export const pingEvidence = (s: PingStats): string => s.received === 0 ? `אין אף תשובה, אובדן ${s.lossPercent}%`
  : `min/avg/max/mdev ${s.min}/${s.avg}/${s.max}/${s.mdev ?? '—'}ms, אובדן ${s.lossPercent}%`;

/** What is over the thresholds, empty when nothing is. */
export function pingBreaches(s: PingStats, t: { maxAvgMs: number; maxMdevMs: number; maxLossPercent: number }): string[] {
  return [
    ...(s.avg != null && s.avg > t.maxAvgMs ? [`avg מעל ${t.maxAvgMs}ms`] : []),
    ...(s.mdev != null && s.mdev > t.maxMdevMs ? [`mdev מעל ${t.maxMdevMs}ms`] : []),
    ...(s.lossPercent > t.maxLossPercent ? [`אובדן מעל ${t.maxLossPercent}%`] : []),
  ];
}

/** Runs ping and returns its output, also when it exits non-zero (no reply at all is exit 1). -W 2: no 10s linger after the last one. */
export type PingRun = (host: string, timeoutMs: number) => Promise<string>;
const localPing: PingRun = (host, timeoutMs) => new Promise((res, rej) =>
  execFile('ping', ['-c', '20', '-i', '0.2', '-W', '2', '-q', '--', host], { timeout: timeoutMs }, (e, out) => e && !out ? rej(e) : res(out)));

/** Read-only ping from hq's machine. Only a ping that didn't run or didn't print a summary is unknown. */
export async function runLatencyProbe(p: ProbeSpec, ping: PingRun = localPing): Promise<ProbeOutcome> {
  const l = p.latency!;
  let out: string;
  try { out = await ping(l.host, p.timeoutMs); } catch (e) { return { ok: false, unknown: true, status: null, latencyMs: null, error: (e as Error).message }; }
  const s = parsePing(out);
  if (!s) return { ok: false, unknown: true, status: null, latencyMs: null, error: `פלט ping לא מובן: ${out.trim().slice(-80) || '(ריק)'}` };
  const bad = pingBreaches(s, l);
  return { ok: !bad.length, ping: s, status: null, latencyMs: s.avg != null ? Math.round(s.avg) : null,
    error: bad.length ? `${l.host}: ${pingEvidence(s)} (${bad.join(', ')})` : null };
}

export type LocalDf = (path: string, timeoutMs: number) => Promise<string>;
const localDf: LocalDf = (path, timeoutMs) => new Promise((res, rej) =>
  execFile('df', ['--output=pcent', '--', path], { timeout: timeoutMs }, (e, out) => e ? rej(e) : res(out)));

/** Read-only `df` on the server named in the charter (or here for `local:`). Only a returned value can fail. */
export async function runDiskProbe(p: ProbeSpec, run: SshRun = runSsh, local: LocalDf = localDf): Promise<ProbeOutcome> {
  const d = p.disk!;
  const t0 = performance.now();
  const lat = () => Math.round(performance.now() - t0);
  let out: string;
  try {
    out = d.host === null ? await local(d.path, p.timeoutMs)
      : await run(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
          ...(d.identityFile ? ['-i', d.identityFile] : []), d.host, `df --output=pcent -- ${q(d.path)} | tail -1`], undefined, p.timeoutMs);
  } catch (e) { return { ok: false, unknown: true, status: null, latencyMs: lat(), error: (e as Error).message }; }
  const m = /^\s*(\d{1,3})%\s*$/.exec(out.trim().split('\n').pop() ?? '');
  if (!m || Number(m[1]) > 100) return { ok: false, unknown: true, status: null, latencyMs: lat(), error: `פלט df לא מובן: ${out.trim().slice(0, 80) || '(ריק)'}` };
  const percent = Number(m[1]);
  return { ok: percent <= d.maxPercent, percent, status: percent, latencyMs: lat(),
    error: percent > d.maxPercent ? `${percent}% בשימוש ב-${d.path} על ${d.host ?? 'local'}, הסף ${d.maxPercent}%` : null };
}

const KUBELET_SEP = '@@nodes';

/** `<gitVersion of the apiserver>` then `<node> <kubeletVersion>` per line. null when it isn't that. */
export function parseKubeletVersions(out: string): KubeletVersions | null {
  const i = out.indexOf(KUBELET_SEP);
  if (i < 0) return null;
  let master: unknown;
  try { master = (JSON.parse(out.slice(0, i)) as { gitVersion?: unknown }).gitVersion; } catch { return null; }
  if (typeof master !== 'string' || !master) return null;
  const nodes: Record<string, string> = {};
  for (const line of out.slice(i + KUBELET_SEP.length).split('\n')) {
    const m = /^(\S+)(?: (\S+))?$/.exec(line.trim());
    if (m) nodes[m[1]!] = m[2] ?? '';
  }
  return Object.keys(nodes).length ? { master, nodes } : null;
}

/** Read-only: the apiserver's version and every node's kubelet version, over ssh to the machine named in the charter. */
export async function runKubeletProbe(p: ProbeSpec, run: SshRun = runSsh): Promise<ProbeOutcome> {
  const k = p.kubelet!;
  const t0 = performance.now();
  const lat = () => Math.round(performance.now() - t0);
  const cmd = `kubectl get --raw /version && echo ${KUBELET_SEP} && kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.nodeInfo.kubeletVersion}{"\\n"}{end}'`;
  let out: string;
  try {
    out = await run(['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10',
      ...(k.identityFile ? ['-i', k.identityFile] : []), k.target, cmd], undefined, p.timeoutMs);
  } catch (e) { return { ok: false, unknown: true, status: null, latencyMs: lat(), error: (e as Error).message }; }
  const v = parseKubeletVersions(out);
  if (!v) return { ok: false, unknown: true, status: null, latencyMs: lat(), error: `פלט kubectl לא מובן: ${out.trim().slice(0, 80) || '(ריק)'}` };
  const off = Object.entries(v.nodes).filter(([, ver]) => ver && ver !== v.master);
  return { ok: !off.length, versions: v, status: null, latencyMs: lat(),
    error: off.length ? `${off.length} נודים בגרסת kubelet שונה מהמאסטר (${v.master}): ${off.map(([n, ver]) => `${n} ${ver}`).join(', ')}` : null };
}

/** Read-only: this probe's alerts of each namespace's Alertmanager. Unknown only when no namespace answered; one that didn't
 *  answer while others did is in `alerts` with its error (the runner keeps its alerts as they were and counts its blindness). */
export async function runAlertmanagerProbe(p: ProbeSpec, run: SshRun = runSsh): Promise<ProbeOutcome> {
  const t0 = performance.now();
  const alerts = await readAlertmanager(p.alertmanager!, p.timeoutMs, run);
  const latencyMs = Math.round(performance.now() - t0);
  const known = Object.entries(alerts).filter((e): e is [string, Extract<AmReading[string], unknown[]>] => Array.isArray(e[1]));
  if (!known.length) return { ok: false, unknown: true, alerts, status: null, latencyMs, error: Object.values(alerts).map((v) => (v as { error: string }).error)[0] ?? null };
  const crit = known.flatMap(([ns, a]) => a.filter((x) => x.severity === 'critical').map((x) => `${ns}/${x.labels.alertname ?? '?'}`));
  const warn = known.flatMap(([ns, a]) => a.filter((x) => x.severity === 'warning').map((x) => `${ns}/${x.labels.alertname ?? '?'}`));
  // ok is production's critical: one in a `prod: false` namespace, or a warning, is in the error but doesn't fail the probe.
  const nonProd = new Set(p.alertmanager!.nonProd ?? []);
  const error = [crit.length ? `${crit.length} התראות קריטיות: ${crit.join(', ')}` : '', warn.length ? `${warn.length} אזהרות: ${warn.join(', ')}` : ''].filter(Boolean).join('; ');
  return { ok: known.every(([ns, a]) => nonProd.has(ns) || !a.some((x) => x.severity === 'critical')), alerts, status: null, latencyMs, error: error || null };
}

export async function runHttpProbe(p: ProbeSpec): Promise<ProbeOutcome> {
  const t0 = performance.now();
  try {
    const res = await fetch(p.url!, { method: p.method, signal: AbortSignal.timeout(p.timeoutMs), redirect: 'manual' });
    await res.body?.cancel();
    const latencyMs = Math.round(performance.now() - t0);
    const statusOk = p.expect.includes(res.status);
    const slow = p.maxLatencyMs != null && latencyMs > p.maxLatencyMs;
    return { ok: statusOk && !slow, status: res.status, latencyMs,
      error: !statusOk ? `status ${res.status}, expected ${p.expect.join('|')}` : slow ? `latency ${latencyMs}ms > ${p.maxLatencyMs}ms` : null };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    // ENOTFOUND is the DNS's answer (no such name: a real fault); EAI_AGAIN is a DNS that didn't answer.
    // A timeout (of the request or the connection) is a failure like a status: a server stuck altogether is caught by fail_for,
    // and the witness is what tells a fault on our side apart (27/10).
    const noAnswer = err.cause?.code === 'EAI_AGAIN';
    return { ok: false, status: null, latencyMs: Math.round(performance.now() - t0), error: err.cause?.code ? `${err.message} (${err.cause.code})` : err.message,
      ...(noAnswer ? { noAnswer: true } : {}) };
  }
}

/** What the second vantage point saw for one probe; `unavailable` = it could not be asked (then it proves nothing). */
export type WitnessOutcome = ProbeOutcome | { unavailable: string };

export type Witness = (p: ProbeSpec) => Promise<WitnessOutcome>;

/** The same check, run by curl on the witness machine. Same expectations as the probe: status and latency budget. */
export function sshWitness(w: { ssh: string; identityFile: string | null; name?: string }, run: SshRun = runSsh): Witness {
  return async (p) => {
    const secs = Math.ceil(p.timeoutMs / 1000);
    const cmd = `curl -s -o /dev/null -X ${p.method} --max-time ${secs} -w '%{http_code} %{time_total}' -- ${q(p.url!)}; true`;
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(w.identityFile ? ['-i', w.identityFile] : []), w.ssh, cmd];
    let out: string;
    try { out = await run(args, undefined, (secs + 15) * 1000); } catch (e) { return { unavailable: (e as Error).message }; }
    const m = /^(\d{3}) (\d+(?:\.\d+)?)$/.exec(out.trim());
    if (!m) return { unavailable: `תשובה לא מובנת מ-curl: ${out.trim().slice(0, 80)}` };
    const status = Number(m[1]);
    const latencyMs = Math.round(Number(m[2]) * 1000);
    if (status === 0) return { ok: false, status: null, latencyMs, error: 'curl לא קיבל תשובה' };
    const statusOk = p.expect.includes(status);
    const slow = p.maxLatencyMs != null && latencyMs > p.maxLatencyMs;
    return { ok: statusOk && !slow, status, latencyMs,
      error: !statusOk ? `status ${status}, expected ${p.expect.join('|')}` : slow ? `latency ${latencyMs}ms > ${p.maxLatencyMs}ms` : null };
  };
}

/** The measuring machine's own state, for the record when the fault turns out to be the measurer's. */
export function hostLoad(): { load1: number; cpus: number; freeMb: number } {
  let freeMb = -1;
  try { freeMb = Math.round(memInfoMb().availableMb); } catch { /* not linux */ }
  return { load1: Math.round(loadavg()[0]! * 100) / 100, cpus: cpus().length, freeMb };
}

/** What the witness saw pinging each host (null = no readable summary for it); `unavailable` = it could not be asked. */
export type PingWitness = (hosts: string[], timeoutMs: number) => Promise<Map<string, PingStats | null> | { unavailable: string }>;

/** The same ping as the probe, run on the witness machine for all the hosts at once, in parallel, over one ssh. */
export function sshPingWitness(w: { ssh: string; identityFile: string | null; name?: string }, run: SshRun = runSsh): PingWitness {
  return async (hosts, timeoutMs) => {
    const safe = hosts.filter(isPingHost);
    if (!safe.length) return { unavailable: 'אין כתובות לבדוק' };
    // One printf per host: each block is a single small write, so parallel blocks don't interleave.
    const cmd = `for h in ${safe.map(q).join(' ')}; do (o=$(ping -c 20 -i 0.2 -W 2 -q -- "$h" 2>&1); printf '@@ %s\\n%s\\n' "$h" "$o") & done; wait; true`;
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', ...(w.identityFile ? ['-i', w.identityFile] : []), w.ssh, cmd];
    let out: string;
    try { out = await run(args, undefined, timeoutMs + 15_000); } catch (e) { return { unavailable: (e as Error).message }; }
    const seen = new Map<string, PingStats | null>();
    for (const block of out.split(/^@@ /m).slice(1)) {
      const nl = block.indexOf('\n');
      const host = (nl < 0 ? block : block.slice(0, nl)).trim();
      if (safe.includes(host)) seen.set(host, parsePing(nl < 0 ? '' : block.slice(nl + 1)));
    }
    if (![...seen.values()].some(Boolean)) return { unavailable: `תשובה לא מובנת מ-ping ב-${w.name ?? w.ssh.replace(/^.*@/, '')}: ${out.trim().slice(0, 80) || '(ריק)'}` };
    return seen;
  };
}

/** More than this many latency probes losing pings in one round is one network event, not an alert per node. */
export const SHARED_MIN_NODES = 3;
/** A shared event reaches the owner only once it outlasted this: at `every: 5m`, into the next round. */
export const SHARED_PERSIST_MS = 5 * 60_000;
/** Latency probes due within this of one that is due run with it, so a round of latency probes is one tick. */
const ROUND_SLACK_MS = 60_000;
/** Jitter that lasts wakes: this many latency samples in a row with no clean one (loss continues the run), 30 minutes at
 *  `every: 5m`. Calibrated on 22–26/10: runs of 1–5 happened 754 times and passed by themselves; 6+ happened 7 times (spec §1). */
export const JITTER_SUSTAIN_ROUNDS = 6;
/** The daily jitter digest goes out from this hour, Israel time. */
export const DIGEST_HOUR = 6;
/** Chronic jitter: more than CHRONIC_PER_DAY jitter samples a day, CHRONIC_DAYS days in a row → a ticket draft for Contabo. */
export const CHRONIC_PER_DAY = 3;
export const CHRONIC_DAYS = 3;
const DAY_MS = 86_400_000;

/** Over avg or mdev only, the loss under its threshold: jitter. Recorded, counted in the digest, wakes no one. */
export const jitterOnly = (p: ProbeSpec, o: ProbeOutcome): boolean =>
  p.kind === 'latency' && !o.ok && !o.unknown && !!o.ping && o.ping.received > 0 && o.ping.lossPercent <= p.latency!.maxLossPercent;

/** A latency sample that failed on loss (100% included). */
export const lossFailed = (p: ProbeSpec, o: ProbeOutcome): boolean => p.kind === 'latency' && !o.ok && !o.unknown && !jitterOnly(p, o);

/** Kinds whose failure is a service failing: jitter while one of them fails in its project has an impact. Not latency (the
 *  network itself), disk or kubelet (a version skew or a full disk is not something jitter does). A registered kind is one when
 *  it says so (ProbeKind.service). */
const SERVICE_KINDS = new Set<ProbeSpec['kind']>(['http', 'alertmanager']);
const isService = (kind: string): boolean => SERVICE_KINDS.has(kind) || !!kinds.get(kind)?.service;

/** What jitter on `p` could have done in (from, to]: a failure of a service probe in its project (not one with `prod: false`), or its node not Ready in a
 *  `cluster:` probe's rounds (root-signals.ts, `ready:<node>`; the node by the vmi name in the probe's id). Oldest first. */
export function jitterImpact(db: Store['db'], probes: ProbeSpec[], p: ProbeSpec, from: number, to: number): { ts: number; what: string }[] {
  const out: { ts: number; what: string }[] = [];
  const services = probes.filter((x) => x.project === p.project && isService(x.kind) && x.prod !== false).map((x) => x.key);
  if (services.length) {
    const rows = db.prepare(`SELECT probe_id, ts FROM probe_results WHERE ok = 0 AND ts > ? AND ts <= ? AND probe_id IN (${services.map(() => '?').join(', ')})`)
      .all(from, to, ...services) as { probe_id: string; ts: number }[];
    for (const r of rows) out.push({ ts: r.ts, what: `${r.probe_id} נכשל` });
  }
  const node = vpsName(p);
  const ready = db.prepare('SELECT ts FROM root_samples WHERE cluster = ? AND key = ? AND value = 0 AND ts > ? AND ts <= ?');
  for (const c of probes.filter((x) => x.kind === 'cluster')) {
    for (const r of ready.all(c.key, `ready:${node}`, from, to) as { ts: number }[]) out.push({ ts: r.ts, what: `הנוד ${node} לא Ready (${c.key})` });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** `shop/api נכשל 3 פעמים, הנוד vmi1 לא Ready פעם אחת`: impacts by what, in the order they first happened. */
const impactText = (xs: { what: string }[]): string => {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x.what, (n.get(x.what) ?? 0) + 1);
  return [...n].map(([w, k]) => `${w} ${k === 1 ? 'פעם אחת' : `${k} פעמים`}`).join(', ');
};

/** A failed latency sample's `error` as runLatencyProbe writes it (pingEvidence). null when it isn't one. */
export function parsePingEvidence(error: string): PingStats | null {
  const none = /: אין אף תשובה, אובדן (\d+(?:\.\d+)?)%/.exec(error);
  if (none) return { transmitted: 20, received: 0, lossPercent: Number(none[1]), min: null, avg: null, max: null, mdev: null };
  const m = /: min\/avg\/max\/mdev (\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?|—)ms, אובדן (\d+(?:\.\d+)?)%/.exec(error);
  if (!m) return null;
  return { transmitted: 20, received: 1, lossPercent: Number(m[5]), min: Number(m[1]), avg: Number(m[2]), max: Number(m[3]), mdev: m[4] === '—' ? null : Number(m[4]) };
}

/** Failed latency samples from before v32 carry no jitter/loss/avg/mdev, so the digest saw no jitter in them. Fills them from
 *  their `error` text by the same rule as jitterOnly, against the probe's max_loss_percent in the charter today. Idempotent: only
 *  rows with no loss_percent, and a filled row has one; a text it can't read stays as it is and is read again on the next reload.
 *  `received` is only "some came back or none", which is all jitterOnly asks. */
export function backfillLatencyRows(db: Store['db'], probes: ProbeSpec[]): number {
  const read = db.prepare('SELECT id, error FROM probe_results WHERE probe_id = ? AND ok = 0 AND loss_percent IS NULL AND error IS NOT NULL');
  const set = db.prepare('UPDATE probe_results SET jitter = ?, loss_percent = ?, avg_ms = ?, mdev_ms = ? WHERE id = ? AND loss_percent IS NULL');
  let n = 0;
  db.transaction(() => {
    for (const p of probes.filter((x) => x.kind === 'latency')) {
      for (const r of read.all(p.key) as { id: number; error: string }[]) {
        const s = parsePingEvidence(r.error);
        if (!s) continue;
        const jitter = jitterOnly(p, { ok: false, status: null, latencyMs: null, error: r.error, ping: s });
        n += set.run(jitter ? 1 : 0, s.lossPercent, s.avg, s.mdev, r.id).changes;
      }
    }
  })();
  return n;
}

/** `25/10` and the hour, in Israel time. */
export function israel(ts: number): { date: string; day: string; hour: number } {
  const f = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(ts).map((x) => [x.type, x.value]));
  return { date: `${f.year}-${f.month}-${f.day}`, day: `${f.day}/${f.month}`, hour: Number(f.hour) };
}

const vpsName = (p: ProbeSpec): string => /vmi\d+/.exec(p.id)?.[0] ?? p.id;

interface DigestRow { ok: number; jitter: number; loss_percent: number | null; avg_ms: number | null; mdev_ms: number | null; latency_ms: number | null; ts: number }

/** The daily digest (spec §4): the last 24 hours by node; a node with chronic jitter is "למעקב", and gets a recommendation for a
 *  Contabo ticket with a ready draft only when its jitter had an impact (jitterImpact) in the days counted. null = no latency probes. */
export function jitterDigest(db: Store['db'], probes: ProbeSpec[], now: number): string | null {
  const latency = probes.filter((p) => p.kind === 'latency');
  if (!latency.length) return null;
  const lines: string[] = ['סיכום jitter יומי, 24 השעות האחרונות לפי נוד:'];
  const tickets: string[] = [];
  const watch: string[] = [];
  for (const p of latency) {
    const rows = db.prepare('SELECT ok, jitter, loss_percent, avg_ms, mdev_ms, latency_ms, ts FROM probe_results WHERE probe_id = ? AND ts > ? AND ts <= ?')
      .all(p.key, now - 7 * DAY_MS, now) as unknown as DigestRow[];
    const avg = (r: DigestRow) => r.avg_ms ?? r.latency_ms;
    const day = rows.filter((r) => r.ts > now - DAY_MS);
    const jit = day.filter((r) => r.jitter === 1).length;
    const loss = day.filter((r) => r.ok === 0 && r.jitter === 0 && r.loss_percent != null).length; // rows from before v32 carry no loss
    const maxAvg = Math.max(-1, ...day.map((r) => avg(r) ?? -1));
    lines.push(`- ${p.key} (${p.latency!.host}): jitter ${jit}, אובדן ${loss}, avg מקסימלי ${maxAvg >= 0 ? `${maxAvg}ms` : '—'}`);
    // Days counted back from now, 24 hours each; the streak is the run of days over the bar ending today.
    const perDay = Array.from({ length: 7 }, (_, i) => rows.filter((r) => r.jitter === 1 && r.ts > now - (i + 1) * DAY_MS && r.ts <= now - i * DAY_MS));
    let streak = 0;
    while (streak < perDay.length && perDay[streak]!.length > CHRONIC_PER_DAY) streak++;
    if (streak < CHRONIC_DAYS) continue;
    const days = perDay.slice(0, streak).reverse();
    // An impact counts while the node jittered: within a round of one of its jitter samples.
    const jitTs = days.flat().map((r) => r.ts);
    const impact = jitterImpact(db, probes, p, now - streak * DAY_MS - p.everyMs - ROUND_SLACK_MS, now)
      .filter((x) => jitTs.some((t) => x.ts >= t - ROUND_SLACK_MS && x.ts <= t + p.everyMs + ROUND_SLACK_MS));
    if (!impact.length) { watch.push(`- ${vpsName(p)} (${p.latency!.host}), ${streak} ימים ברצף, בלי כשל שירות ובלי נוד לא Ready בזמן ה-jitter.`); continue; }
    const worst = days.flat().sort((a, b) => (avg(b) ?? 0) - (avg(a) ?? 0)).slice(0, 3);
    const end = (i: number) => israel(now - (streak - 1 - i) * DAY_MS).day;
    tickets.push([
      `${vpsName(p)} (${p.latency!.host}), ${streak} ימים ברצף. השפעה בזמן ה-jitter: ${impactText(impact)}.`,
      '```',
      `Subject: Recurring network jitter on ${vpsName(p)} (${p.latency!.host})`,
      '',
      `We measure latency to ${vpsName(p)} (${p.latency!.host}) every few minutes with 20 pings (ping -c 20 -i 0.2).`,
      `For the last ${streak} days in a row the round-trip time has repeatedly jumped far above normal, without packet loss:`,
      ...days.map((d, i) => `- 24h to ${end(i)}: ${d.length} samples over our threshold (avg > ${p.latency!.maxAvgMs}ms or mdev > ${p.latency!.maxMdevMs}ms)`),
      'The worst samples:',
      ...worst.map((r) => `- ${new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ')} UTC: avg ${avg(r) ?? '?'}ms, mdev ${r.mdev_ms ?? '?'}ms`),
      'Please check the host node and the network path of this VPS.',
      '```',
    ].join('\n'));
  }
  if (tickets.length) lines.push('', `jitter קבוע (יותר מ-${CHRONIC_PER_DAY} ביום, ${CHRONIC_DAYS} ימים ברצף ויותר) עם השפעה: המלצה לטיקט ב-Contabo, נוסח מוכן להדבקה.`, ...tickets);
  if (watch.length) lines.push('', 'למעקב: jitter קבוע בלי השפעה. אין המלצה לטיקט.', ...watch);
  if (!tickets.length && !watch.length) lines.push('', 'אין נוד עם jitter קבוע.');
  return lines.join('\n');
}

/** One network event: more than SHARED_MIN_NODES latency probes lost pings in one round. Kept in meta, so a restart
 *  continues it (and closes what the owner was sent) instead of opening a second one. */
interface SharedOutage { since: number; lastRound: number; rounds: number; members: Set<string>; owner: boolean; held: boolean }
const OUTAGE_META = 'probes.shared_outage';
/** The last shared event that ended: its members' loss inside it doesn't count toward sustained jitter after it. */
const OUTAGE_LAST_META = 'probes.shared_outage_last';

/** An open failure of a fail_for probe: since = its first failure that got an answer, moved on by every stretch without an answer
 *  (from the answered failure before it to the one after it: the clock is frozen there); answered = the last answered failure;
 *  gap = a failure without an answer came after it; last = the last run (retry or scheduled);
 *  asked = it was crossed and the witness was asked (then only scheduled runs cross again, as with fail_after).
 *  In memory: a restart starts the clock over, which costs at most fail_for. */
interface FailFor { since: number; answered: number; gap: boolean; last: number; asked: boolean }

export class ProbeRunner {
  probes: ProbeSpec[] = [];
  run: (p: ProbeSpec) => Promise<ProbeOutcome> = (p) => p.kind === 'disk' ? runDiskProbe(p) : p.kind === 'latency' ? runLatencyProbe(p)
    : p.kind === 'kubelet' ? runKubeletProbe(p) : p.kind === 'alertmanager' ? runAlertmanagerProbe(p)
    : kinds.has(p.kind) ? kinds.get(p.kind)!.run(p, this.ctx) : runHttpProbe(p);
  /** Second vantage point, asked before an anomaly wakes the monitoring lead. null = none configured. */
  witness: Witness | null;
  /** The same second vantage point for latency: ping from the witness machine. null = none configured (then a shared event has no witness). */
  pingWitness: PingWitness | null;
  /** How the messages name the witness machine and this one. */
  witnessName: string;
  machine: string = hostname();
  host: () => { load1: number; cpus: number; freeMb: number } = hostLoad;
  /** What the registered kinds' hooks get. */
  readonly ctx: ProbeContext;
  /** Root signals of the `cluster:` probes: their own findings and messages, not probe_results. */
  readonly roots: RootWatch;
  private measurerEpisode = false;
  private outageLoaded: SharedOutage | null | undefined;
  private inflight = new Set<string>();
  private failFor = new Map<string, FailFor>();

  private store: Store;
  private cfg: HqConfig;
  private mailbox: Mailbox;
  private inbox: Inbox | null;
  constructor(store: Store, cfg: HqConfig, mailbox: Mailbox, inbox: Inbox | null = null) {
    this.store = store;
    this.cfg = cfg;
    this.mailbox = mailbox;
    this.inbox = inbox;
    this.witness = cfg.probeWitness ? sshWitness(cfg.probeWitness) : null;
    this.pingWitness = cfg.probeWitness ? sshPingWitness(cfg.probeWitness) : null;
    this.witnessName = cfg.probeWitness?.name ?? cfg.probeWitness?.ssh.replace(/^.*@/, '') ?? 'נקודה שנייה';
    const runner = this;  // eslint-disable-line @typescript-eslint/no-this-alias
    this.ctx = {
      store, mailbox, lead: cfg.monitoringLeadId, inflight: this.inflight,
      get probes() { return runner.probes; },
      state: (key) => this.state(key),
      run: (p) => this.run(p),
      record: (p, o, now) => { this.record(p, o, false, now); },
      known: (id) => getIdentity(this.store, id)?.active === 1,
    };
    this.roots = new RootWatch(store, mailbox, inbox, cfg.monitoringLeadId);
    this.roots.failingHttp = () => this.failingHttp().map((p) => p.key);
  }

  get toggleKey(): string { return `${this.cfg.monitoringLeadId}/prod-probes`; }

  reload(): ProbeSpec[] {
    this.probes = loadProbes(this.cfg.companyDir);
    // A clock of a probe that no longer has fail_for (or is gone) would keep its retries going.
    for (const k of this.failFor.keys()) if (!this.probes.some((p) => p.key === k && p.failForMs != null)) this.failFor.delete(k);
    const backfilled = backfillLatencyRows(this.store.db, this.probes);
    if (backfilled) this.store.emit('probes.backfilled', this.cfg.monitoringLeadId, { rows: backfilled });
    const bad = this.probes.filter((p) => p.kind === 'unsupported');
    this.store.emit('probes.loaded', this.cfg.monitoringLeadId, { count: this.probes.length, unsupported: bad.map((p) => p.key) });
    // Not silent: a probe of a kind this hq doesn't have (its module not loaded) is told once to the monitoring lead (the msg_id keeps
    // it to one per reason). A malformed entry of a known kind is in the event and the summary, with its reason.
    for (const p of bad.filter((x) => x.unknownKind)) {
      const h = createHash('sha1').update(p.reason ?? '').digest('hex').slice(0, 8);
      this.mailbox.tell({ msg_id: `probe-${p.key}-unsupported-${h}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system', priority: 'next',
        body: `${p.key} באמנה של ${p.project} לא רץ: ${p.reason}. לטעון את הסוג (probeKindsDir, probe-kit.ts), או לתקן את הרשומה באמנה.` });
    }
    return this.probes;
  }

  state(key: string): ProbeStateRow | undefined {
    return this.store.db.prepare('SELECT * FROM probe_state WHERE probe_id = ?').get(key) as ProbeStateRow | undefined;
  }

  /** Run every due probe. Observe-only: the only side effect outside the store is a message to רותם. */
  async tick(): Promise<void> {
    // A.6: an automation that isn't written in its team's contract doesn't exist. The switch is rotem/prod-probes.
    if (!this.store.toggle(this.toggleKey)) { this.failFor.clear(); return; }  // back on later: an old clock would cross at once
    const now = this.store.now();
    const isDue = (p: ProbeSpec, slack = 0) => { const s = this.state(p.key); return !s?.last_run_at || now - s.last_run_at >= p.everyMs - slack; };
    // Root signals: a round per cluster, on its own (a 3-minute ssh doesn't hold the other probes back).
    for (const p of this.probes.filter((x) => x.kind === 'cluster' && !this.inflight.has(x.key) && isDue(x))) void this.clusterRound(p, now);
    // The registered kinds' own work (reads that run alone, scans): started here, never awaited.
    for (const k of kinds.values()) if (k.tick) k.tick(this.probes.filter((x) => x.kind === k.kind), this.ctx, now);
    const runnable = this.probes.filter((p) => p.kind !== 'unsupported' && p.kind !== 'cluster' && !kinds.get(p.kind)?.alone && !this.inflight.has(p.key));
    // A round of latency is one tick: one that is due takes along those almost due, and they all record this tick's time.
    const latencyDue = runnable.some((p) => p.kind === 'latency' && isDue(p));
    const due = runnable.filter((p) => isDue(p) || (latencyDue && p.kind === 'latency' && isDue(p, ROUND_SLACK_MS)));
    // fail_for: an open failure is looked at again every FAIL_FOR_RETRY_MS, until the first success (or it was crossed and
    // the witness said it is us: then the schedule goes on as with fail_after). An anomaly that is open keeps the retries, for a fast note.
    const retries = runnable.filter((p) => {
      const f = this.failFor.get(p.key);
      return !!f && p.failForMs != null && !due.includes(p) && (!f.asked || this.state(p.key)?.anomaly_open === 1) && now - f.last >= FAIL_FOR_RETRY_MS;
    });
    const crossed: ProbeSpec[] = [];
    const sustained: ProbeSpec[] = [];
    const round: { p: ProbeSpec; o: ProbeOutcome }[] = [];
    await Promise.all([...due.map((p) => ({ p, retry: false })), ...retries.map((p) => ({ p, retry: true }))].map(async ({ p, retry }) => {
      this.inflight.add(p.key);
      try {
        const k = kinds.get(p.kind);
        const o = await this.run(k?.prepare ? k.prepare(p, this.ctx) : p);
        if (p.kind === 'latency') round.push({ p, o });
        const r = this.record(p, o, true, now, retry);
        if (r === 'crossed') crossed.push(p);
        else if (r === 'sustained') sustained.push(p);
      } finally { this.inflight.delete(p.key); }
    }));
    if (round.length) await this.sharedRound(round, now);
    // After the round: a node that this round put inside a shared event has no anomaly of its own, as with loss.
    // Counted again: an event that ended this round no longer lends its loss to the run.
    for (const p of sustained) if (!this.outage?.members.has(p.key) && this.state(p.key)?.anomaly_open !== 1 && this.badRun(p, now) >= JITTER_SUSTAIN_ROUNDS) this.sustainedJitter(p, now);
    // A node inside an open shared event has no anomaly of its own: the event speaks for it.
    const own = crossed.filter((p) => !this.outage?.members.has(p.key));
    if (own.length) await this.confirm(own);
    // The measurer episode is about http (the witness): a disk or a jittery node failing for days must not keep it muted.
    else if (!crossed.length && !this.probes.some((p) => p.kind === 'http' && p.prod !== false && (this.state(p.key)?.consecutive_failures ?? 0) > 0)) this.measurerEpisode = false;
    this.digest(now);
  }

  /** One round of root signals on a cluster. Its time is noted in probe_state (when it is due); its findings live in root_findings. */
  async clusterRound(p: ProbeSpec, now = this.store.now()): Promise<void> {
    this.inflight.add(p.key);
    try {
      this.store.db.prepare(`INSERT INTO probe_state (probe_id, project, last_run_at) VALUES (?, ?, ?)
        ON CONFLICT(probe_id) DO UPDATE SET last_run_at = excluded.last_run_at`).run(p.key, p.project, now);
      await this.roots.round(p.key, p.cluster!, p.timeoutMs);
    } catch (e) {
      this.store.emit('roots.error', this.cfg.monitoringLeadId, { probe: p.key, error: (e as Error).message });
    } finally { this.inflight.delete(p.key); }
  }

  /** The daily jitter digest to רותם, once a day from DIGEST_HOUR Israel time (part of prod-probes, its switch). */
  private digest(now: number): void {
    const il = israel(now);
    if (il.hour < DIGEST_HOUR) return;
    const key = `probes.jitter_digest.${il.date}`;
    if (this.store.getMeta(key)) return;
    const body = jitterDigest(this.store.db, this.probes, now);
    if (body) this.mailbox.tell({ msg_id: `probe-jitter-digest-${il.date}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system', priority: 'later', body });
    this.store.setMeta(key, String(now)); // after it went out: a failure tries again next tick (the msg_id keeps it to one)
    if (body) this.store.emit('probe.jitter_digest', this.cfg.monitoringLeadId, { date: il.date });
  }

  private get outage(): SharedOutage | null {
    if (this.outageLoaded === undefined) {
      let o: SharedOutage | null = null;
      try {
        const j = JSON.parse(this.store.getMeta(OUTAGE_META) || 'null') as (Omit<SharedOutage, 'members'> & { members: string[] }) | null;
        if (j) o = { ...j, members: new Set(j.members) };
      } catch { /* unreadable: no event */ }
      this.outageLoaded = o;
    }
    return this.outageLoaded;
  }

  private set outage(o: SharedOutage | null) {
    this.outageLoaded = o;
    this.store.setMeta(OUTAGE_META, o ? JSON.stringify({ ...o, members: [...o.members] }) : '');
  }

  /** http that really fails: reached its fail_after, or has an anomaly open. One blip in the same round wakes no one. `prod: false` isn't counted. */
  private failingHttp(): ProbeSpec[] {
    return this.probes.filter((p) => {
      if (p.kind !== 'http' || p.prod === false) return false;
      const s = this.state(p.key);
      return !!s && (s.anomaly_open === 1 || s.consecutive_failures >= p.failAfter);
    });
  }

  /** The witness's ping to the nodes that lost here: a line per node, and whether it could be asked at all. */
  private async witnessPing(lost: { p: ProbeSpec; o: ProbeOutcome }[]): Promise<{ available: boolean; lines: string[] }> {
    const w = this.pingWitness ? await this.pingWitness(lost.map(({ p }) => p.latency!.host), Math.max(...lost.map(({ p }) => p.timeoutMs)))
      : { unavailable: 'לא הוגדרה נקודה שנייה' };
    const name = this.witnessName;
    if ('unavailable' in w) return { available: false, lines: [`ping מ-${name}: אין witness (${w.unavailable}).`] };
    const there = lost.map(({ p }) => ({ p, s: w.get(p.latency!.host) ?? null }));
    const alsoLost = there.filter(({ p, s }) => s && s.lossPercent > p.latency!.maxLossPercent).length;
    const read = there.filter(({ s }) => s).length;
    return { available: true, lines: [
      `ping מ-${name}: ${alsoLost} מתוך ${read} מאבדים גם משם. ${alsoLost === 0 ? `מ-${name} הנודים תקינים: כנראה הנתיב של ${this.machine}, לא הנודים.` : alsoLost * 2 > read ? `גם ${name} רואה אובדן: כנראה בנודים או ב-Contabo.` : 'תמונה חלקית.'}`,
      ...there.map(({ p, s }) => `- ${p.key} מ-${name}: ${s ? pingEvidence(s) : 'אין סיכום מובן'}`),
    ] };
  }

  /** The shared-event part of a body: the nodes, how many were checked, the measurer, and http at this moment. */
  private sharedFacts(lost: { p: ProbeSpec; o: ProbeOutcome }[], checked: number): string[] {
    const host = this.host();
    const http = this.probes.filter((p) => p.kind === 'http' && p.prod !== false);  // as failingHttp: production only
    const bad = this.failingHttp();
    return [
      `${lost.length} מתוך ${checked} נודים איבדו pings באותו סבב (${checked - lost.length} תקינים):`,
      ...lost.map(({ p, o }) => `- ${p.key} (${p.latency!.host}): אובדן ${o.ping?.lossPercent ?? '?'}%, avg ${o.ping?.avg ?? '—'}ms`),
      `${this.machine}, שממנו יוצאים ה-pings: load ${host.load1} על ${host.cpus} ליבות, ${host.freeMb >= 0 ? `${host.freeMb}MB RAM פנויים` : 'RAM לא ידוע'}.`,
      !http.length ? 'probes של http: אין.' : bad.length ? `probes של http: ${bad.length} מתוך ${http.length} נכשלים (${bad.map((p) => p.key).join(', ')}).`
        : `probes של http: כל ה-${http.length} תקינים. זה רמז שהבעיה בנתיב הרשת ולא בשירותים.`,
    ];
  }

  /** One round of latency probes (spec §3): more than SHARED_MIN_NODES losing pings is one event, not an alert per node. */
  private async sharedRound(round: { p: ProbeSpec; o: ProbeOutcome }[], now: number): Promise<void> {
    const known = round.filter(({ o }) => !o.unknown);
    if (known.length <= SHARED_MIN_NODES) return; // too few answers to call a shared event either way
    const lost = known.filter(({ p, o }) => lossFailed(p, o));
    const lead = this.cfg.monitoringLeadId;
    const o = this.outage;
    if (lost.length > SHARED_MIN_NODES) {
      if (!o) {
        this.outage = { since: now, lastRound: now, rounds: 1, members: new Set(lost.map(({ p }) => p.key)), owner: false, held: false };
        const seen = await this.witnessPing(lost);
        this.mailbox.tell({ msg_id: `probe-shared-${now}`, from: 'hq', to: lead, kind: 'probe_anomaly', urgency: 'urgent', priority: 'now', body: [
          'נפילה משותפת ברשת: אירוע אחד, לא התראה לכל נוד.', ...this.sharedFacts(lost, known.length), ...seen.lines,
          `אם זה נמשך גם בסבב הבא (יותר מ-${SHARED_PERSIST_MS / 60_000} דקות), תצא התראה דחופה ${pre('ל', this.mailbox.names.owner.name)}, אבל רק אם נכשל גם probe של http או שאין witness.`,
        ].join('\n') });
        this.store.emit('probe.shared_outage', lead, { nodes: lost.map(({ p }) => p.key), checked: known.length, witness: seen.available });
        return;
      }
      if (now > o.lastRound) { o.rounds++; o.lastRound = now; }
      // A node that starts losing after the event was reported is told, or it would be silenced without anyone hearing of it.
      const joined = lost.filter(({ p }) => !o.members.has(p.key));
      for (const { p } of joined) o.members.add(p.key);
      if (joined.length) this.mailbox.tell({ msg_id: `probe-shared-${o.since}-joined-${now}`, from: 'hq', to: lead, kind: 'system', priority: 'next',
        body: [`הצטרפו לנפילה המשותפת ברשת (עכשיו ${lost.length} מתוך ${known.length} נודים):`,
          ...joined.map(({ p, o: r }) => `- ${p.key} (${p.latency!.host}): אובדן ${r.ping?.lossPercent ?? '?'}%, avg ${r.ping?.avg ?? '—'}ms`)].join('\n') });
      this.outage = o;
      if (o.owner || o.rounds < 2 || now - o.since < SHARED_PERSIST_MS) return;
      // Lasting. The owner hears of it only when something says it is real: http failing too, or no second point to say otherwise.
      const bad = this.failingHttp();
      const seen = await this.witnessPing(lost);
      const minutes = Math.round((now - o.since) / 60_000);
      if (bad.length || !seen.available) {
        o.owner = true;
        this.outage = o;
        const ref = `probe-shared-${o.since}`;
        const body = [`נפילה משותפת ברשת שנמשכת ${minutes} דקות.`, ...this.sharedFacts(lost, known.length), ...seen.lines,
          `${this.mailbox.label(lead)} כבר על זה. רק מעקב: לא נעשתה פעולה בשירות.`].join('\n');
        this.mailbox.tell({ msg_id: `${ref}-owner`, from: lead, to: OWNER, kind: 'probe_anomaly', urgency: 'urgent', priority: 'now', body });
        this.inbox?.add({ kind: 'incident', urgency: 'urgent', from_identity: lead, ref, dedupe_key: ref,
          title: `נפילה ברשת: ${lost.length} נודים מאבדים pings כבר ${minutes} דקות`, body });
        this.store.emit('probe.shared_outage_owner', lead, { nodes: lost.map(({ p }) => p.key), http_failing: bad.map((p) => p.key), witness: seen.available });
      } else if (!o.held) {
        o.held = true;
        this.outage = o;
        this.mailbox.tell({ msg_id: `probe-shared-${o.since}-held`, from: 'hq', to: lead, kind: 'system', priority: 'next', body: [
          `הנפילה המשותפת נמשכת ${minutes} דקות, אבל כל ה-http תקינים ו-${this.witnessName} זמין, ולכן לא יצאה התראה ${pre('ל', this.mailbox.names.owner.name)}: כנראה בעיית מדידה או נתיב.`,
          ...seen.lines].join('\n') });
      }
      return;
    }
    if (!o) return;
    this.outage = null;
    this.store.setMeta(OUTAGE_LAST_META, JSON.stringify({ end: now, members: [...o.members] }));
    const minutes = Math.round((now - o.since) / 60_000);
    const body = `הנפילה המשותפת ברשת נגמרה אחרי ${minutes} דקות: בסבב האחרון ${lost.length} מתוך ${known.length} נודים איבדו pings.`;
    this.mailbox.tell({ msg_id: `probe-shared-${o.since}-recovered`, from: 'hq', to: lead, kind: 'system', priority: 'next', body });
    if (o.owner) {
      this.mailbox.tell({ msg_id: `probe-shared-${o.since}-owner-recovered`, from: lead, to: OWNER, priority: 'next', body: `חזר לתקין. ${body}` });
      this.inbox?.resolveByRef('incident', `probe-shared-${o.since}`);
    }
    this.store.emit('probe.shared_recovered', lead, { since: o.since, owner: o.owner });
  }

  /** More than half of the http probes failing at once points at the measurer, not at the projects. */
  private majorityFailing(): boolean {
    const http = this.probes.filter((p) => p.kind === 'http' && p.prod !== false);
    const failing = http.filter((p) => (this.state(p.key)?.consecutive_failures ?? 0) > 0).length;
    return http.length >= 2 && failing * 2 > http.length;
  }

  /** Probes that reached fail_after: ask the second vantage point before waking anyone. */
  private async confirm(crossedAll: ProbeSpec[]): Promise<void> {
    let crossed = crossedAll;
    const majority = this.majorityFailing();
    // Disk, latency and the other kinds are measured from here only: the witness checks http, nothing to verify from there.
    for (const p of crossed.filter((c) => c.kind !== 'http')) this.openAnomaly(p);
    crossed = crossed.filter((c) => c.kind === 'http');
    if (!crossed.length) return;
    const verdicts = await Promise.all(crossed.map(async (p) => ({ p, w: this.witness ? await this.witness(p) : { unavailable: 'לא הוגדרה נקודה שנייה' } as WitnessOutcome })));
    const measurer: typeof verdicts = [];
    for (const { p, w } of verdicts) {
      if ('unavailable' in w) {
        // Can't verify. Most probes failing together: assume the measurer and look again next round (up to twice fail_after);
        // otherwise alert with the note that nothing confirmed it.
        const fails = this.state(p.key)?.consecutive_failures ?? 0;
        if (majority && fails < p.failAfter * 2) continue;
        this.openAnomaly(p, `לא אומת מנקודה שנייה: ${w.unavailable}${majority ? ' (רוב ה-probes נכשלים יחד, ייתכן שהבעיה במודד)' : ''}`);
      } else if (w.ok) {
        // Fine from there, failing here for a long time: a broken path from here only. Not silent forever (unless most probes fail: that is the host, already recorded).
        const fails = this.state(p.key)?.consecutive_failures ?? 0;
        if (!majority && fails >= p.failAfter * 2) this.openAnomaly(p, `תקין מנקודה שנייה (status=${w.status} ${w.latencyMs}ms) אבל נכשל מ-${this.machine} ${fails} פעמים ברצף: ייתכן נתיב שבור רק משם`);
        else measurer.push({ p, w });
      } else this.openAnomaly(p, `אומת גם מנקודה שנייה: status=${w.status ?? '—'} latency=${w.latencyMs ?? '—'}ms ${w.error ?? ''}`.trim());
    }
    if (!measurer.length) this.measurerEpisode = false;
    else this.measurerFault(measurer.map(({ p, w }) => ({ p, w: w as ProbeOutcome })), majority);
  }

  /** The probe failed here and passed there: an incident on the measuring host, not a production anomaly. */
  private measurerFault(items: { p: ProbeSpec; w: ProbeOutcome }[], majority: boolean): void {
    const host = this.host();
    this.store.emit('probe.measurer_fault', this.cfg.monitoringLeadId, {
      machine: this.machine, probes: items.map(({ p, w }) => ({ probe: p.key, witness_status: w.status, witness_latency_ms: w.latencyMs })), majority, ...host });
    if (this.measurerEpisode) return;
    this.measurerEpisode = true;
    this.mailbox.tell({ msg_id: `probe-measurer-${this.store.now()}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system', priority: 'next',
      body: [
        `אירוע על ${this.machine}, לא תקלה בפרודקשן: ${items.map(({ p }) => p.key).join(', ')} נכשלו אצלנו אבל תקינים מנקודה שנייה (${this.witnessName}).`,
        ...items.map(({ p, w }) => `- ${p.key}: ${this.witnessName} status=${w.status} ${w.latencyMs}ms`),
        `המכונה: load ${host.load1} על ${host.cpus} ליבות, ${host.freeMb >= 0 ? `${host.freeMb}MB RAM פנויים` : 'RAM לא ידוע'}.${majority ? ' יותר ממחצית ה-probes נכשלו יחד.' : ''}`,
        `לא נפתחה חריגה ולא הערתי אותך כתקלה. אם זה חוזר, זה עומס על ${this.machine}.`,
      ].join('\n') });
  }

  /** Returns 'crossed' when `defer` is set and this failure reached fail_after (or lasted fail_for): the caller confirms it first.
   *  'sustained' when `defer` is set and jitter reached JITTER_SUSTAIN_ROUNDS: the caller opens it after the shared round.
   *  `retry`: a fail_for retry. It doesn't count toward fail_after and doesn't move last_run_at (the schedule of `every`). */
  record(p: ProbeSpec, o: ProbeOutcome, defer = false, now = this.store.now(), retry = false): 'crossed' | 'sustained' | undefined {
    const prev = this.state(p.key);
    const ff = p.failForMs != null ? this.failFor.get(p.key) : undefined;
    if (ff) ff.last = now;
    if (o.unknown) {
      if (ff) ff.gap = true;  // no answer: its stretch is frozen, as a DNS that didn't answer
      // No answer is not a failure: the streak and any open anomaly stay as they were; only the attempt is noted.
      this.store.db.prepare(`INSERT INTO probe_state (probe_id, project, last_run_at, last_error) VALUES (?, ?, ?, ?)
        ON CONFLICT(probe_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`).run(p.key, p.project, retry ? (prev?.last_run_at ?? now) : now, o.error);
      this.store.emit('probe.unknown', this.cfg.monitoringLeadId, { probe: p.key, error: o.error });
      if (p.kind === 'alertmanager' && o.alerts) this.alertmanagerRound(p, o.alerts, now);  // its blindness is counted from unknowns
      kinds.get(p.kind)?.round?.(p, o, this.ctx, now);  // so is a registered kind's, when it has its own
      return undefined;
    }
    // Jitter without loss is noted (ok=0, jitter=1) and doesn't advance the loss streak; alone it wakes no one until it lasts (JITTER_SUSTAIN_ROUNDS).
    const jitter = jitterOnly(p, o);
    const healthy = o.ok || jitter;
    // A retry that passes ends the retries, but the streak of scheduled failures stays (a flapping service still reaches fail_after);
    // with an anomaly open it is a recovery like any other.
    const fails = retry ? (healthy && prev?.anomaly_open === 1 ? 0 : prev?.consecutive_failures ?? 0)
      : healthy ? 0 : (prev?.consecutive_failures ?? 0) + 1;
    // fail_for's clock: started by the first failure that got an answer, ended by a success. No answer neither starts it nor crosses it.
    let lasted = false;
    if (p.failForMs != null) {
      if (healthy) this.failFor.delete(p.key);
      else if (o.noAnswer) { if (ff) ff.gap = true; }
      else if (!ff) this.failFor.set(p.key, { since: now, answered: now, gap: false, last: now, asked: false });
      else {
        if (ff.gap) ff.since += now - ff.answered;
        ff.answered = now;
        ff.gap = false;
        lasted = now - ff.since >= p.failForMs && (!retry || !ff.asked);
      }
    }
    this.store.db.prepare(`INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts, jitter, loss_percent, avg_ms, mdev_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.key, o.ok ? 1 : 0, o.status, o.latencyMs, o.error, now, jitter ? 1 : 0, o.ping?.lossPercent ?? null, o.ping?.avg ?? null, o.ping?.mdev ?? null);
    this.store.db.prepare(`INSERT INTO probe_state (probe_id, project, consecutive_failures, last_run_at, last_ok_at, last_status, last_latency_ms, last_error)
        VALUES (@k, @project, @fails, @now, @ok_at, @status, @lat, @err)
      ON CONFLICT(probe_id) DO UPDATE SET consecutive_failures = @fails, last_run_at = @now,
        last_ok_at = COALESCE(@ok_at, last_ok_at), last_status = @status, last_latency_ms = @lat, last_error = @err`)
      .run({ k: p.key, project: p.project, fails, now: retry ? (prev?.last_run_at ?? now) : now, ok_at: o.ok ? now : null, status: o.status, lat: o.latencyMs, err: o.error });
    // The verdict, not the readings (alerts, pods, versions…): their rounds below take them from `o`, and nobody reads them
    // back from the log. One kind's result was 216KB a minute: probe.result was 1.8GB of the 2.9GB hq.db (task 1547).
    const { alerts: _a, versions: _v, ...verdict } = o as ProbeOutcome & Record<string, unknown>;
    const k = kinds.get(p.kind);
    for (const f of k?.readings ?? []) delete verdict[f];
    this.store.emit('probe.result', this.cfg.monitoringLeadId, { probe: p.key, ...verdict, error: verdict.error?.slice(0, 2000) ?? null });
    if (p.kind === 'kubelet') { if (o.versions) this.kubeletSkew(p, o.versions, now); return undefined; }
    if (p.kind === 'alertmanager') { if (o.alerts) this.alertmanagerRound(p, o.alerts, now); return undefined; }
    k?.round?.(p, o, this.ctx, now);
    if (k?.ownMessages) return undefined;

    const open = prev?.anomaly_open === 1;
    if (p.kind === 'latency' && o.ok && this.store.getMeta(`probes.jitter_quiet.${p.key}`)) this.store.setMeta(`probes.jitter_quiet.${p.key}`, '');
    if (!healthy && (fails >= p.failAfter || lasted) && !open) {
      if (ff) ff.asked = true;
      if (defer) return 'crossed';
      if (!this.outage?.members.has(p.key)) this.openAnomaly(p);
    } else if (p.kind === 'latency' && !o.ok && !open && this.badRun(p, now) >= JITTER_SUSTAIN_ROUNDS) {
      if (defer) return 'sustained';
      if (!this.outage?.members.has(p.key)) this.sustainedJitter(p, now);
    } else if (o.ok && open) {
      // Only a clean sample recovers: jitter after an anomaly is not "back to normal".
      this.store.db.prepare('UPDATE probe_state SET anomaly_open = 0 WHERE probe_id = ?').run(p.key);
      this.mailbox.tell({ msg_id: `probe-${p.key}-recovered-${now}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system',
        priority: p.prod === false ? 'later' : 'next', body: p.kind === 'disk' ? `${p.key} חזר לתקין (${o.percent}% ב-${p.disk!.path} על ${p.disk!.host ?? 'local'}).`
          : p.kind === 'latency' && o.ping ? `${p.key} חזר לתקין (${p.latency!.host}: ${pingEvidence(o.ping)}).`
          : k?.recovered ? k.recovered(p, o)
          : `${p.key} חזר לתקין (status=${o.status}, ${o.latencyMs}ms).` });
      this.store.emit('probe.recovered', this.cfg.monitoringLeadId, { probe: p.key });
    }
    return undefined;
  }

  /** One anomaly per node whose kubelet is not on the apiserver's version, held until it is (or the node is gone); then one note.
   *  Nodes that go off in the same reading share one message (a master upgraded first puts every worker off at once).
   *  A node with no version yet (still registering) keeps the state it had.
   *  Not fail_after: the version doesn't flicker, and the first reading is the evidence. Not urgent: a skew is fixed by day, it doesn't wake anyone. */
  private kubeletSkew(p: ProbeSpec, v: KubeletVersions, now: number): void {
    const key = `probes.kubelet_skew.${p.key}`;
    let open: Record<string, string> = {};
    try { open = (JSON.parse(this.store.getMeta(key) || '{}') ?? {}) as Record<string, string>; } catch { /* unreadable: none open */ }
    const off: Record<string, string> = {};
    for (const [node, ver] of Object.entries(v.nodes)) {
      if (!ver) { if (node in open) off[node] = open[node]!; } else if (ver !== v.master) off[node] = ver;
    }
    const lead = this.cfg.monitoringLeadId;
    const total = Object.keys(v.nodes).length;
    const same = Object.values(v.nodes).filter((ver) => ver === v.master).length;
    const fresh = Object.entries(off).filter(([node]) => !(node in open));
    if (fresh.length) {
      this.mailbox.tell({ msg_id: `probe-${p.key}-${now}`, from: 'hq', to: lead, kind: 'probe_anomaly', priority: 'next', body: [
        `חריגה בקלאסטר: ${p.key} (${p.kubelet!.target}): ${fresh.length === 1 ? 'נוד מריץ' : `${fresh.length} נודים מריצים`} kubelet בגרסה אחרת מהמאסטר (apiserver ${v.master}):`,
        ...fresh.map(([node, ver]) => `- הנוד ${node} מריץ kubelet ${ver}`),
        `kubelet חדש מה-apiserver הוא מחוץ ל-skew הנתמך, וגם ישן יותר הוא מצב ביניים שצריך לסגור. ${same} מתוך ${total} נודים בגרסה של המאסטר.`,
        'בפעם הקודמת (משימה 697, 26/10) ששה נודים כאלה שלחו כ-68% מהבקשות ל-apiserver במשך 9 ימים.',
        `התראה אחת לנוד: עליו לא תצא עוד התראה עד שהוא חוזר לגרסה של המאסטר. שלב 1: observe-only. חקרי, ושלחי ${pre('ל', this.mailbox.names.owner.name)} הצעה. איך מצרפים נוד בגרסה של המאסטר: machines.md, קלאסטר k3s.`,
      ].join('\n') });
      this.store.emit('probe.anomaly', lead, { probe: p.key, nodes: Object.fromEntries(fresh), master: v.master });
    }
    const fixed = Object.keys(open).filter((n) => !(n in off));
    if (fixed.length) {
      this.mailbox.tell({ msg_id: `probe-${p.key}-recovered-${now}`, from: 'hq', to: lead, kind: 'system', priority: 'next',
        body: `${p.key}: ${fixed.map((n) => n in v.nodes ? `${n} חזר לגרסה של המאסטר (${v.master})` : `${n} כבר לא בקלאסטר`).join(', ')}.` });
      this.store.emit('probe.recovered', lead, { probe: p.key, nodes: fixed });
    }
    this.store.setMeta(key, JSON.stringify(off));
    this.store.db.prepare('UPDATE probe_state SET anomaly_open = ? WHERE probe_id = ?').run(Object.keys(off).length ? 1 : 0, p.key);
  }

  /** The cluster's critical alerts against what was told (alertmanager.ts). Not fail_after: Alertmanager's rules already have their `for:`.
   *  The state is in meta, so a restart doesn't wake רותם again for what is still open. */
  private alertmanagerRound(p: ProbeSpec, reading: AmReading, now: number): void {
    const key = `probes.alertmanager.${p.key}`;
    let prev: AmState = { open: {}, blind: {} };
    try { prev = { ...prev, ...(JSON.parse(this.store.getMeta(key) || '{}') as Partial<AmState>) }; } catch { /* unreadable: nothing open */ }
    const am = p.alertmanager!;
    const { state, messages } = amRound(p.key, am.target, prev, reading, now, { toOwner: pre('ל', this.mailbox.names.owner.name), nonProd: am.nonProd, resolveAfterMs: am.resolveAfterMs });
    // `notify` in the charter, else רותם. An identity that isn't in org.yaml (a typo) would wake a worker that doesn't exist and no one
    // would know: its messages go to רותם, with a line that says why. Each of `cc` gets a copy (its own msg_id, so it is delivered once),
    // as a system message at `next` or `later`, never urgent: the one notified handles it, the copy doesn't send a second ask.
    const lead = this.cfg.monitoringLeadId;
    const known = (id: string) => getIdentity(this.store, id)?.active === 1;  // removed from org.yaml: active 0, the row stays
    const to = am.notify && known(am.notify) ? am.notify : lead;
    const unknown = [am.notify, ...(am.cc ?? [])].filter((id): id is string => !!id && !known(id));
    const cc = [...new Set(am.cc ?? [])].filter((id) => id !== to && known(id));
    const note = unknown.length ? `\n(באמנה ${unknown.length === 1 ? 'יש מזהה' : 'יש מזהים'} שלא פעילים ב-org.yaml: ${unknown.join(', ')}. ${am.notify && !known(am.notify) ? 'ההודעה הגיעה אלייך במקום. ' : ''}לתקן את notify/cc באמנה של ${p.project}.)` : '';
    for (const m of messages) {
      this.mailbox.tell({ msg_id: m.id, from: 'hq', to, kind: m.anomaly ? 'probe_anomaly' : 'system',
        ...(m.anomaly ? { urgency: 'urgent' as const } : m.priority === 'later' ? { urgency: 'low' as const } : {}), priority: m.priority, body: m.body + note });
      for (const c of cc) this.mailbox.tell({ msg_id: `${m.id}-cc-${c}`, from: 'hq', to: c, kind: 'system', priority: m.priority === 'later' ? 'later' : 'next',
        ...(m.priority === 'later' ? { urgency: 'low' as const } : {}),
        body: `העתק לידיעה: ההודעה נשלחה ${pre('ל', this.mailbox.label(to))} (${to}), והטיפול שם. אין צורך לפעול או לשלוח ask.\n${m.body}` });
      this.store.emit(m.event, to, { probe: p.key, msg: m.id, ...(cc.length ? { cc } : {}) });
    }
    this.store.setMeta(key, JSON.stringify(state));
    // Open in production and critical: what isn't production, or a warning, doesn't hold the probe's anomaly open.
    const nonProd = new Set(am.nonProd ?? []);
    this.store.db.prepare('UPDATE probe_state SET anomaly_open = ? WHERE probe_id = ?').run(Object.values(state.open).some((o) => !nonProd.has(o.ns) && !o.warning) ? 1 : 0, p.key);
  }

  /** Samples in a row, newest back, with no clean one (jitter or loss), up to JITTER_SUSTAIN_ROUNDS. Unknowns are not recorded here.
   *  Only samples from the last JITTER_SUSTAIN_ROUNDS intervals (a gap, like hq down, starts over), and for a node that was in the
   *  last shared event only samples after it ended: its loss there was the event's. */
  private badRun(p: ProbeSpec, now: number): number { return this.badRows(p, now).length; }

  /** The time of the oldest sample of the run badRun counts (now when there is none). */
  private runStart(p: ProbeSpec, now: number): number { return this.badRows(p, now).at(-1)?.ts ?? now; }

  private badRows(p: ProbeSpec, now: number): { ok: number; ts: number }[] {
    let from = now - JITTER_SUSTAIN_ROUNDS * p.everyMs - ROUND_SLACK_MS;
    try {
      const last = JSON.parse(this.store.getMeta(OUTAGE_LAST_META) || 'null') as { end: number; members: string[] } | null;
      if (last?.members.includes(p.key)) from = Math.max(from, last.end - 1);
    } catch { /* unreadable: no event */ }
    const rows = this.store.db.prepare('SELECT ok, ts FROM probe_results WHERE probe_id = ? AND ts > ? ORDER BY id DESC LIMIT ?')
      .all(p.key, from, JITTER_SUSTAIN_ROUNDS) as { ok: number; ts: number }[];
    const i = rows.findIndex((r) => r.ok === 1);
    return i < 0 ? rows : rows.slice(0, i);
  }

  /** Jitter that lasted JITTER_SUSTAIN_ROUNDS: urgent only with an impact in its window (jitterImpact). Without one it is noted
   *  once per run (probe.jitter_quiet, cleared by a clean sample) and wakes no one; nothing opens, so no "recovered" follows either.
   *  Looked at again every round while it lasts: an impact that comes later opens it then. */
  private sustainedJitter(p: ProbeSpec, now: number): void {
    // The window is the run itself: from its oldest sample (a failure in the round before it, as a shared event's, is not its impact).
    const start = this.runStart(p, now);
    const impact = jitterImpact(this.store.db, this.probes, p, start - 1, now);
    const key = `probes.jitter_quiet.${p.key}`;
    if (impact.length) {
      if (this.store.getMeta(key)) this.store.setMeta(key, '');
      this.openAnomaly(p, `השפעה בזמן ה-jitter: ${impactText(impact)}.`, true);
      return;
    }
    // Once per run: the meta is the last round it was seen. A run that started after it (after a gap or a shared event) is a new one.
    const seen = Number(this.store.getMeta(key) || '0');
    this.store.setMeta(key, String(now));
    if (seen >= start) return;
    this.store.emit('probe.jitter_quiet', this.cfg.monitoringLeadId, { probe: p.key, rounds: JITTER_SUSTAIN_ROUNDS });
  }

  private openAnomaly(p: ProbeSpec, verification?: string, sustained = false): void {
    const now = this.store.now();
    const st = this.state(p.key);
    const fails = st?.consecutive_failures ?? 0;
    this.store.db.prepare('UPDATE probe_state SET anomaly_open = 1 WHERE probe_id = ?').run(p.key);
    const ff = this.failFor.get(p.key);
    const lasted = ff && p.failForMs != null && now - ff.since >= p.failForMs ? Math.round((now - ff.since) / 1000) : null;
    const recent = this.store.db.prepare('SELECT ok, status, latency_ms, error, ts FROM probe_results WHERE probe_id = ? ORDER BY id DESC LIMIT ?')
      .all(p.key, sustained ? JITTER_SUSTAIN_ROUNDS : lasted != null ? Math.max(p.failAfter, Math.min(10, Math.ceil(lasted * 1000 / FAIL_FOR_RETRY_MS) + 1)) : p.failAfter) as { status: number | null; latency_ms: number | null; error: string | null; ts: number }[];
    const lastOk = st?.last_ok_at ? new Date(st.last_ok_at).toISOString() : 'אף פעם (מאז שהתחלנו לבדוק)';
    // `prod: false`: the same evidence, at `later` and low urgency (03/11: not production).
    const prod = p.prod !== false;
    const head = prod ? 'חריגה בפרודקשן' : 'חריגה (לא פרודקשן, עדיפות נמוכה)';
    this.mailbox.tell({ msg_id: `probe-${p.key}-${now}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'probe_anomaly',
      urgency: prod ? 'urgent' : 'low', priority: prod ? 'now' : 'later', body: [
        p.kind === 'disk' ? `${head}: ${p.key} (דיסק ${p.disk!.path} על ${p.disk!.host ?? 'local'}, הסף ${p.disk!.maxPercent}%)`
          : p.kind === 'latency' ? `${head}: ${p.key} (jitter ברשת אל ${p.latency!.host}: הספים avg ${p.latency!.maxAvgMs}ms, mdev ${p.latency!.maxMdevMs}ms, אובדן ${p.latency!.maxLossPercent}%)`
          : kinds.get(p.kind)?.anomaly ? `${head}: ${p.key} (${kinds.get(p.kind)!.anomaly!(p)})`
          : `${head}: ${p.key} (${p.method} ${p.url})`,
        sustained ? `jitter מתמשך עם השפעה: ${JITTER_SUSTAIN_ROUNDS} דגימות ברצף בלי דגימה תקינה (JITTER_SUSTAIN_ROUNDS), גם כשהאובדן לא הגיע ל-fail_after. תקין לאחרונה: ${lastOk}.`
          : lasted != null && fails < p.failAfter ? `נכשל ברצף ${lasted} שניות (fail_for=${p.failForMs! / 1000}s, בדיקה חוזרת כל ${FAIL_FOR_RETRY_MS / 1000} שניות), בלי לחכות ל-fail_after=${p.failAfter}. תקין לאחרונה: ${lastOk}.`
          : `${fails} כישלונות ברצף (fail_after=${p.failAfter}). תקין לאחרונה: ${lastOk}.`,
        ...(verification ? [verification] : []),
        'ראיות:',
        ...recent.map((r) => p.kind !== 'http' ? `- ${new Date(r.ts).toISOString()} ${r.error ?? ''}`.trim()
          : `- ${new Date(r.ts).toISOString()} status=${r.status ?? '—'} latency=${r.latency_ms ?? '—'}ms ${r.error ?? ''}`.trim()),
        prod ? `שלב 1: observe-only. חקרי, ושלחי ${pre('ל', this.mailbox.names.owner.name)} ask דחוף עם השערה והצעה. פעולה על הפרודקשן רק עם grant באמנה.`
          : 'האמנה מסמנת את ה-probe הזה `prod: false`: לא דחוף, ולא מעירים עליו. בודקים כשמתפנים.',
      ].join('\n') });
    this.store.emit('probe.anomaly', this.cfg.monitoringLeadId, { probe: p.key, fails, ...(sustained ? { jitter_sustained: JITTER_SUSTAIN_ROUNDS } : {}) });
  }

  summary() {
    return this.probes.map((p) => ({ key: p.key, kind: p.kind, url: p.url ?? null, ...(p.disk ? { disk: p.disk.target } : {}), ...(p.latency ? { latency: p.latency.host } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
      ...(p.kubelet ? { kubelet: p.kubelet.target } : {}), ...(p.cluster ? { cluster: p.cluster.ssh } : {}),
      ...(kinds.get(p.kind)?.summary?.(p, this.ctx) ?? {}),
      ...(p.alertmanager ? { alertmanager: p.alertmanager.target, namespaces: p.alertmanager.namespaces, non_prod: p.alertmanager.nonProd ?? [], resolve_after_ms: p.alertmanager.resolveAfterMs ?? RESOLVE_AFTER_MS,
        ...(p.alertmanager.match ? { match: p.alertmanager.match } : {}), ...(p.alertmanager.exclude ? { exclude: p.alertmanager.exclude } : {}),
        ...(p.alertmanager.critical ? { critical: p.alertmanager.critical } : {}), ...(p.alertmanager.warning ? { warning: p.alertmanager.warning } : {}),
        ...(p.alertmanager.notify ? { notify: p.alertmanager.notify } : {}), ...(p.alertmanager.cc ? { cc: p.alertmanager.cc } : {}) } : {}),
      every_ms: p.everyMs, ...(p.failForMs != null ? { fail_for_ms: p.failForMs } : {}), ...(this.state(p.key) ?? {}) }));
  }

  prune(olderThanMs = 7 * 86_400_000): void {
    this.store.db.prepare('DELETE FROM probe_results WHERE ts < ?').run(this.store.now() - olderThanMs);
    this.roots.prune(olderThanMs);
  }
}
