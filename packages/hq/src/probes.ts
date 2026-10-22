// probe-runner (B.17), observe-only in phase 1: code, no tokens. Probes are declared in each project
// charter (company/projects/<p>.md) as a fenced ```yaml block with a top-level `probes:` list
// (frontmatter `monitoring:` from the B.17 example is accepted too). Phase 1 runs `http` probes;
// other kinds are listed as unsupported, never silently dropped.
// `disk` (monitoring-spec §3.2 step 4) is the first ssh-shaped probe: read-only `df`, measured from hq-host only.
// `latency` measures network jitter to a host: `ping -c 20 -i 0.2 -q` from hq-host (a node with jitter is a slow node, 22/10).
// No answer (timeout, ssh failed, garbage output) is "unknown": not a failure, never counted toward fail_after.
// For latency, 100% loss is an answer (a failure); hosts that drop ICMP stay out of the charter.
// `fail_after` consecutive failures → one `now` message to רותם with the evidence; recovery → one note.
import { pre } from '@company/shared';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadavg, cpus, homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { memInfoMb } from './proc.ts';
import { runSsh, q, type SshRun } from './nodes.ts';
import { parse } from 'yaml';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';

export interface ProbeSpec {
  key: string;              // <project>/<id>
  project: string;
  id: string;
  kind: 'http' | 'disk' | 'latency' | 'unsupported';
  url?: string;
  disk?: { target: string; host: string | null; path: string; identityFile: string | null; maxPercent: number };  // host null = local
  latency?: { host: string; maxAvgMs: number; maxMdevMs: number; maxLossPercent: number };
  method: string;
  expect: number[];
  maxLatencyMs: number | null;
  everyMs: number;
  timeoutMs: number;
  failAfter: number;
  raw: Record<string, unknown>;
}

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

/** A missing threshold takes the default; one that is there but isn't a number is NaN, and the probe becomes unsupported (as disk does). */
const posNum = (v: unknown, dflt: number): number => { if (v == null) return dflt; const n = typeof v === 'number' ? v : NaN; return Number.isFinite(n) && n >= 0 ? n : NaN; };

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
    const dt = typeof r.disk === 'string' ? parseDiskTarget(r.disk) : null;
    const maxPct = Number(r.max_percent);
    const disk = dt && Number.isFinite(maxPct) && maxPct > 0 && maxPct <= 100
      ? { target: String(r.disk), host: dt.host, path: dt.path, maxPercent: maxPct,
          identityFile: typeof r.identity === 'string' ? r.identity.replace(/^~(?=\/|$)/, homedir()) : null }
      : undefined;
    const lt = typeof r.latency === 'string' && isPingHost(r.latency.trim())
      ? { host: r.latency.trim(), maxAvgMs: posNum(r.max_avg_ms, 10), maxMdevMs: posNum(r.max_mdev_ms, 20), maxLossPercent: posNum(r.max_loss_percent, 5) }
      : undefined;
    const latency = lt && [lt.maxAvgMs, lt.maxMdevMs, lt.maxLossPercent].every(Number.isFinite) ? lt : undefined;
    out.push({
      key: `${project}/${id}`, project, id,
      kind: typeof r.http === 'string' ? 'http' : disk ? 'disk' : latency ? 'latency' : 'unsupported',
      url: typeof r.http === 'string' ? r.http : undefined,
      disk, latency,
      // Observe-only: a probe may only read. Anything but GET/HEAD in a charter is ignored.
      method: typeof r.method === 'string' && r.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET',
      expect: (Array.isArray(exp) ? exp : [exp]).map(Number),
      maxLatencyMs: r.max_latency_ms != null ? Number(r.max_latency_ms) : (r.max_latency != null ? parseDuration(r.max_latency, 0) : null),
      everyMs: parseDuration(r.every, 60_000),
      // 20 pings at 0.2s with -W 2 end within ~6s; the default leaves room so a dead host ends in ping's summary, not a kill.
      timeoutMs: parseDuration(r.timeout, latency ? 20_000 : 10_000),
      failAfter: Number(r.fail_after ?? 3),
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

/** `unknown`: no answer came back. Not a failure (ok is meaningless then); the runner doesn't count it. */
export interface ProbeOutcome { ok: boolean; status: number | null; latencyMs: number | null; error: string | null; unknown?: boolean; percent?: number; ping?: PingStats }

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

/** Read-only ping from hq-host. Only a ping that didn't run or didn't print a summary is unknown. */
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
    return { ok: false, status: null, latencyMs: Math.round(performance.now() - t0), error: (e as Error).message };
  }
}

/** What the second vantage point saw for one probe; `unavailable` = it could not be asked (then it proves nothing). */
export type WitnessOutcome = ProbeOutcome | { unavailable: string };

export type Witness = (p: ProbeSpec) => Promise<WitnessOutcome>;

/** The same check, run by curl on the witness machine (ci-host). Same expectations as the probe: status and latency budget. */
export function sshWitness(w: { ssh: string; identityFile: string | null }, run: SshRun = runSsh): Witness {
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

interface ProbeStateRow { probe_id: string; consecutive_failures: number; anomaly_open: number; last_run_at: number | null; last_ok_at: number | null }

export class ProbeRunner {
  probes: ProbeSpec[] = [];
  run: (p: ProbeSpec) => Promise<ProbeOutcome> = (p) => p.kind === 'disk' ? runDiskProbe(p) : p.kind === 'latency' ? runLatencyProbe(p) : runHttpProbe(p);
  /** Second vantage point, asked before an anomaly wakes רותם. null = none configured. */
  witness: Witness | null;
  host: () => { load1: number; cpus: number; freeMb: number } = hostLoad;
  private measurerEpisode = false;
  private inflight = new Set<string>();

  private store: Store;
  private cfg: HqConfig;
  private mailbox: Mailbox;
  constructor(store: Store, cfg: HqConfig, mailbox: Mailbox) {
    this.store = store;
    this.cfg = cfg;
    this.mailbox = mailbox;
    this.witness = cfg.probeWitness ? sshWitness(cfg.probeWitness) : null;
  }

  get toggleKey(): string { return `${this.cfg.monitoringLeadId}/prod-probes`; }

  reload(): ProbeSpec[] {
    this.probes = loadProbes(this.cfg.companyDir);
    const unsupported = this.probes.filter((p) => p.kind === 'unsupported').map((p) => p.key);
    this.store.emit('probes.loaded', this.cfg.monitoringLeadId, { count: this.probes.length, unsupported });
    return this.probes;
  }

  private state(key: string): ProbeStateRow | undefined {
    return this.store.db.prepare('SELECT * FROM probe_state WHERE probe_id = ?').get(key) as ProbeStateRow | undefined;
  }

  /** Run every due probe. Observe-only: the only side effect outside the store is a message to רותם. */
  async tick(): Promise<void> {
    // A.6: an automation that isn't written in its team's contract doesn't exist. The switch is rotem/prod-probes.
    if (!this.store.toggle(this.toggleKey)) return;
    const now = this.store.now();
    const due = this.probes.filter((p) => p.kind !== 'unsupported' && !this.inflight.has(p.key))
      .filter((p) => { const s = this.state(p.key); return !s?.last_run_at || now - s.last_run_at >= p.everyMs; });
    const crossed: ProbeSpec[] = [];
    await Promise.all(due.map(async (p) => {
      this.inflight.add(p.key);
      try { if (this.record(p, await this.run(p), true) === 'crossed') crossed.push(p); } finally { this.inflight.delete(p.key); }
    }));
    if (crossed.length) await this.confirm(crossed);
    // The measurer episode is about http (the witness): a disk or a jittery node failing for days must not keep it muted.
    else if (!this.probes.some((p) => p.kind === 'http' && (this.state(p.key)?.consecutive_failures ?? 0) > 0)) this.measurerEpisode = false;
  }

  /** More than half of the http probes failing at once points at the measurer, not at the projects. */
  private majorityFailing(): boolean {
    const http = this.probes.filter((p) => p.kind === 'http');
    const failing = http.filter((p) => (this.state(p.key)?.consecutive_failures ?? 0) > 0).length;
    return http.length >= 2 && failing * 2 > http.length;
  }

  /** Probes that reached fail_after: ask the second vantage point before waking anyone. */
  private async confirm(crossedAll: ProbeSpec[]): Promise<void> {
    let crossed = crossedAll;
    const majority = this.majorityFailing();
    // Disk and latency are measured from hq-host only: the witness checks http, nothing to verify from ci-host.
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
        // Fine from there, failing here for a long time: a broken path from hq-host only. Not silent forever (unless most probes fail: that is the host, already recorded).
        const fails = this.state(p.key)?.consecutive_failures ?? 0;
        if (!majority && fails >= p.failAfter * 2) this.openAnomaly(p, `תקין מנקודה שנייה (status=${w.status} ${w.latencyMs}ms) אבל נכשל מ-hq-host ${fails} פעמים ברצף: ייתכן נתיב שבור רק משם`);
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
      machine: 'hq-host', probes: items.map(({ p, w }) => ({ probe: p.key, witness_status: w.status, witness_latency_ms: w.latencyMs })), majority, ...host });
    if (this.measurerEpisode) return;
    this.measurerEpisode = true;
    this.mailbox.tell({ msg_id: `probe-measurer-${this.store.now()}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system', priority: 'next',
      body: [
        `אירוע על hq-host, לא תקלה בפרודקשן: ${items.map(({ p }) => p.key).join(', ')} נכשלו אצלנו אבל תקינים מנקודה שנייה (ci-host).`,
        ...items.map(({ p, w }) => `- ${p.key}: ci-host status=${w.status} ${w.latencyMs}ms`),
        `המכונה: load ${host.load1} על ${host.cpus} ליבות, ${host.freeMb >= 0 ? `${host.freeMb}MB RAM פנויים` : 'RAM לא ידוע'}.${majority ? ' יותר ממחצית ה-probes נכשלו יחד.' : ''}`,
        'לא נפתחה חריגה ולא הערתי אותך כתקלה. אם זה חוזר, זה עומס על hq-host.',
      ].join('\n') });
  }

  /** Returns 'crossed' when `defer` is set and this failure reached fail_after: the caller confirms it first. */
  record(p: ProbeSpec, o: ProbeOutcome, defer = false): 'crossed' | undefined {
    const now = this.store.now();
    const prev = this.state(p.key);
    if (o.unknown) {
      // No answer is not a failure: the streak and any open anomaly stay as they were; only the attempt is noted.
      this.store.db.prepare(`INSERT INTO probe_state (probe_id, project, last_run_at, last_error) VALUES (?, ?, ?, ?)
        ON CONFLICT(probe_id) DO UPDATE SET last_run_at = excluded.last_run_at, last_error = excluded.last_error`).run(p.key, p.project, now, o.error);
      this.store.emit('probe.unknown', this.cfg.monitoringLeadId, { probe: p.key, error: o.error });
      return undefined;
    }
    const fails = o.ok ? 0 : (prev?.consecutive_failures ?? 0) + 1;
    this.store.db.prepare(`INSERT INTO probe_results (probe_id, ok, status, latency_ms, error, ts) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(p.key, o.ok ? 1 : 0, o.status, o.latencyMs, o.error, now);
    this.store.db.prepare(`INSERT INTO probe_state (probe_id, project, consecutive_failures, last_run_at, last_ok_at, last_status, last_latency_ms, last_error)
        VALUES (@k, @project, @fails, @now, @ok_at, @status, @lat, @err)
      ON CONFLICT(probe_id) DO UPDATE SET consecutive_failures = @fails, last_run_at = @now,
        last_ok_at = COALESCE(@ok_at, last_ok_at), last_status = @status, last_latency_ms = @lat, last_error = @err`)
      .run({ k: p.key, project: p.project, fails, now, ok_at: o.ok ? now : null, status: o.status, lat: o.latencyMs, err: o.error });
    this.store.emit('probe.result', this.cfg.monitoringLeadId, { probe: p.key, ...o });

    const open = prev?.anomaly_open === 1;
    if (!o.ok && fails >= p.failAfter && !open) {
      if (defer) return 'crossed';
      this.openAnomaly(p);
    } else if (o.ok && open) {
      this.store.db.prepare('UPDATE probe_state SET anomaly_open = 0 WHERE probe_id = ?').run(p.key);
      this.mailbox.tell({ msg_id: `probe-${p.key}-recovered-${now}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system',
        priority: 'next', body: p.kind === 'disk' ? `${p.key} חזר לתקין (${o.percent}% ב-${p.disk!.path} על ${p.disk!.host ?? 'local'}).`
          : p.kind === 'latency' && o.ping ? `${p.key} חזר לתקין (${p.latency!.host}: ${pingEvidence(o.ping)}).`
          : `${p.key} חזר לתקין (status=${o.status}, ${o.latencyMs}ms).` });
      this.store.emit('probe.recovered', this.cfg.monitoringLeadId, { probe: p.key });
    }
    return undefined;
  }

  private openAnomaly(p: ProbeSpec, verification?: string): void {
    const now = this.store.now();
    const st = this.state(p.key);
    const fails = st?.consecutive_failures ?? 0;
    this.store.db.prepare('UPDATE probe_state SET anomaly_open = 1 WHERE probe_id = ?').run(p.key);
    const recent = this.store.db.prepare('SELECT ok, status, latency_ms, error, ts FROM probe_results WHERE probe_id = ? ORDER BY id DESC LIMIT ?')
      .all(p.key, p.failAfter) as { status: number | null; latency_ms: number | null; error: string | null; ts: number }[];
    const lastOk = st?.last_ok_at ? new Date(st.last_ok_at).toISOString() : 'אף פעם (מאז שהתחלנו לבדוק)';
    this.mailbox.tell({ msg_id: `probe-${p.key}-${now}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'probe_anomaly',
      urgency: 'urgent', priority: 'now', body: [
        p.kind === 'disk' ? `חריגה בפרודקשן: ${p.key} (דיסק ${p.disk!.path} על ${p.disk!.host ?? 'local'}, הסף ${p.disk!.maxPercent}%)`
          : p.kind === 'latency' ? `חריגה בפרודקשן: ${p.key} (jitter ברשת אל ${p.latency!.host}: הספים avg ${p.latency!.maxAvgMs}ms, mdev ${p.latency!.maxMdevMs}ms, אובדן ${p.latency!.maxLossPercent}%)`
          : `חריגה בפרודקשן: ${p.key} (${p.method} ${p.url})`,
        `${fails} כישלונות ברצף (fail_after=${p.failAfter}). תקין לאחרונה: ${lastOk}.`,
        ...(verification ? [verification] : []),
        'ראיות:',
        ...recent.map((r) => p.kind !== 'http' ? `- ${new Date(r.ts).toISOString()} ${r.error ?? ''}`.trim()
          : `- ${new Date(r.ts).toISOString()} status=${r.status ?? '—'} latency=${r.latency_ms ?? '—'}ms ${r.error ?? ''}`.trim()),
        `שלב 1: observe-only. חקרי, ושלחי ${pre('ל', this.mailbox.names.owner.name)} ask דחוף עם השערה והצעה. פעולה על הפרודקשן רק עם grant באמנה.`,
      ].join('\n') });
    this.store.emit('probe.anomaly', this.cfg.monitoringLeadId, { probe: p.key, fails });
  }

  summary() {
    return this.probes.map((p) => ({ key: p.key, kind: p.kind, url: p.url ?? null, ...(p.disk ? { disk: p.disk.target } : {}), ...(p.latency ? { latency: p.latency.host } : {}), every_ms: p.everyMs, ...(this.state(p.key) ?? {}) }));
  }

  prune(olderThanMs = 7 * 86_400_000): void {
    this.store.db.prepare('DELETE FROM probe_results WHERE ts < ?').run(this.store.now() - olderThanMs);
  }
}
