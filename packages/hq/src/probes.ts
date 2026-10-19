// probe-runner (B.17), observe-only in phase 1: code, no tokens. Probes are declared in each project
// charter (company/projects/<p>.md) as a fenced ```yaml block with a top-level `probes:` list
// (frontmatter `monitoring:` from the B.17 example is accepted too). Phase 1 runs `http` probes;
// other kinds are listed as unsupported, never silently dropped.
// `fail_after` consecutive failures → one `now` message to רותם with the evidence; recovery → one note.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';

export interface ProbeSpec {
  key: string;              // <project>/<id>
  project: string;
  id: string;
  kind: 'http' | 'unsupported';
  url?: string;
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
    out.push({
      key: `${project}/${id}`, project, id,
      kind: typeof r.http === 'string' ? 'http' : 'unsupported',
      url: typeof r.http === 'string' ? r.http : undefined,
      // Observe-only: a probe may only read. Anything but GET/HEAD in a charter is ignored.
      method: typeof r.method === 'string' && r.method.toUpperCase() === 'HEAD' ? 'HEAD' : 'GET',
      expect: (Array.isArray(exp) ? exp : [exp]).map(Number),
      maxLatencyMs: r.max_latency_ms != null ? Number(r.max_latency_ms) : (r.max_latency != null ? parseDuration(r.max_latency, 0) : null),
      everyMs: parseDuration(r.every, 60_000),
      timeoutMs: parseDuration(r.timeout, 10_000),
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

export interface ProbeOutcome { ok: boolean; status: number | null; latencyMs: number | null; error: string | null }

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

interface ProbeStateRow { probe_id: string; consecutive_failures: number; anomaly_open: number; last_run_at: number | null; last_ok_at: number | null }

export class ProbeRunner {
  probes: ProbeSpec[] = [];
  run: (p: ProbeSpec) => Promise<ProbeOutcome> = runHttpProbe;
  private inflight = new Set<string>();

  private store: Store;
  private cfg: HqConfig;
  private mailbox: Mailbox;
  constructor(store: Store, cfg: HqConfig, mailbox: Mailbox) {
    this.store = store;
    this.cfg = cfg;
    this.mailbox = mailbox;
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
    const due = this.probes.filter((p) => p.kind === 'http' && !this.inflight.has(p.key))
      .filter((p) => { const s = this.state(p.key); return !s?.last_run_at || now - s.last_run_at >= p.everyMs; });
    await Promise.all(due.map(async (p) => {
      this.inflight.add(p.key);
      try { this.record(p, await this.run(p)); } finally { this.inflight.delete(p.key); }
    }));
  }

  record(p: ProbeSpec, o: ProbeOutcome): void {
    const now = this.store.now();
    const prev = this.state(p.key);
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
      this.store.db.prepare('UPDATE probe_state SET anomaly_open = 1 WHERE probe_id = ?').run(p.key);
      const recent = this.store.db.prepare('SELECT ok, status, latency_ms, error, ts FROM probe_results WHERE probe_id = ? ORDER BY id DESC LIMIT ?')
        .all(p.key, p.failAfter) as { status: number | null; latency_ms: number | null; error: string | null; ts: number }[];
      const lastOk = prev?.last_ok_at ? new Date(prev.last_ok_at).toISOString() : 'אף פעם (מאז שהתחלנו לבדוק)';
      this.mailbox.tell({ msg_id: `probe-${p.key}-${now}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'probe_anomaly',
        urgency: 'urgent', priority: 'now', body: [
          `חריגה בפרודקשן: ${p.key} (${p.method} ${p.url})`,
          `${fails} כישלונות ברצף (fail_after=${p.failAfter}). תקין לאחרונה: ${lastOk}.`,
          'ראיות:',
          ...recent.map((r) => `- ${new Date(r.ts).toISOString()} status=${r.status ?? '—'} latency=${r.latency_ms ?? '—'}ms ${r.error ?? ''}`.trim()),
          'שלב 1: observe-only. חקרי, ושלחי לרן ask דחוף עם השערה והצעה. פעולה על הפרודקשן רק עם grant באמנה.',
        ].join('\n') });
      this.store.emit('probe.anomaly', this.cfg.monitoringLeadId, { probe: p.key, fails });
    } else if (o.ok && open) {
      this.store.db.prepare('UPDATE probe_state SET anomaly_open = 0 WHERE probe_id = ?').run(p.key);
      this.mailbox.tell({ msg_id: `probe-${p.key}-recovered-${now}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system',
        priority: 'next', body: `${p.key} חזר לתקין (status=${o.status}, ${o.latencyMs}ms).` });
      this.store.emit('probe.recovered', this.cfg.monitoringLeadId, { probe: p.key });
    }
  }

  summary() {
    return this.probes.map((p) => ({ key: p.key, kind: p.kind, url: p.url ?? null, every_ms: p.everyMs, ...(this.state(p.key) ?? {}) }));
  }

  prune(olderThanMs = 7 * 86_400_000): void {
    this.store.db.prepare('DELETE FROM probe_results WHERE ts < ?').run(this.store.now() - olderThanMs);
  }
}
