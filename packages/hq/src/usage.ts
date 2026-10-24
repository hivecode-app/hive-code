// "השימוש" on the home (task 496, next to "המכסה"): how fast the quota goes and on what, from what hq already records.
//   rate     — the weekly window's % used in the last hour and the last day, of the accounts the company runs on as one
//              quota (the average of those read in the span; account.changed: each quota read, every 10 minutes; a drop is a reset).
//   kinds    — the last day's spend split by what it went on: task workers, and the standing workers' turns by what started
//              them (his message, a worker's, hq's, anything else such as background work coming back). The spend is the
//              CLI's own costUsd per turn (engine.result, at API prices): good to compare, not a bill.
//   people   — the same spend by worker, the top of it.
//   parallel — task workers running now, and over the last day on average and in its busiest hour.
import { OWNER } from '@company/shared';
import type { Store } from './store.ts';

export const USAGE_WINDOW_MS = 24 * 60 * 60_000;
const HOUR = 60 * 60_000;

export type UsageKind = 'tasks' | 'leads_owner' | 'leads_workers' | 'leads_hq' | 'leads_other';

export interface Usage {
  measured_at: number;
  /** % of the weekly quota, the accounts as one (their average); null = no quota read in that span. */
  hour_pct: number | null;
  day_pct: number | null;
  /** Shares of the day's spend (0..1), largest first; empty when nothing ran. */
  kinds: { kind: UsageKind; share: number }[];
  people: { id: string; name: string; share: number; task: boolean }[];
  parallel: { now: number; avg: number; peak: number };
}

interface Snap { name: string; at: number; pct: number }

/**
 * The positive steps of each account's weekly %, from `since`: what was used, as one quota (the average of the accounts
 * read in that span: two that each used 11% of their week used 11% of the company's). A drop is the window resetting.
 */
export function usedPct(snaps: Snap[], since: number): number | null {
  const by = new Map<string, Snap[]>();
  for (const s of snaps) by.set(s.name, [...(by.get(s.name) ?? []), s]);
  let total = 0;
  let read = 0;
  for (const list of by.values()) {
    list.sort((a, b) => a.at - b.at);
    let seen = false;
    for (let i = 1; i < list.length; i++) {
      if (list[i]!.at < since) continue;
      seen = true;
      const d = list[i]!.pct - list[i - 1]!.pct;
      if (d > 0) total += d;
    }
    if (seen) read++;
  }
  return read ? Math.round((total / read) * 10) / 10 : null;
}

/** Time-weighted average (and the instant peak) of how many intervals overlap inside [t0, t1]. */
export function overlap(spans: { from: number; to: number }[], t0: number, t1: number): { avg: number; peak: number } {
  const edges: [number, number][] = [];
  for (const s of spans) {
    const a = Math.max(s.from, t0);
    const b = Math.min(s.to, t1);
    if (b > a) edges.push([a, 1], [b, -1]);
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0;
  let peak = 0;
  let area = 0;
  let last = t0;
  for (const [t, d] of edges) {
    area += cur * (t - last);
    last = t;
    cur += d;
    peak = Math.max(peak, cur);
  }
  return { avg: t1 > t0 ? Math.round((area / (t1 - t0)) * 10) / 10 : 0, peak };
}

/** The first event at or after `ts`: seq and ts grow together, so a search over the primary key, never a scan of `ts`. */
export function seqAt(store: Store, ts: number): number {
  const db = store.db;
  const tsOf = db.prepare('SELECT ts FROM events WHERE seq >= ? ORDER BY seq LIMIT 1');
  const b = db.prepare('SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM events').get() as { lo: number | null; hi: number | null };
  if (b.lo == null || b.hi == null) return 0;
  let lo = b.lo;
  let hi = b.hi + 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const r = tsOf.get(mid) as { ts: number } | undefined;
    if (!r || r.ts >= ts) hi = mid; else lo = mid + 1;
  }
  return lo;
}

export function usage(store: Store, accounts: string[], names: (id: string) => string): Usage {
  const now = store.now();
  const t0 = now - USAGE_WINDOW_MS;
  const db = store.db;
  // One read of the window, and a day before it: the bases of the first steps (a quota read, a run's running total,
  // a task shift's start).
  const from = seqAt(store, t0 - USAGE_WINDOW_MS);
  const rows = db.prepare(`SELECT ts, type, identity, data FROM events WHERE seq >= ?
    AND type IN ('engine.result', 'message.state', 'account.changed', 'shift.state') ORDER BY seq`).all(from) as
    { ts: number; type: string; identity: string | null; data: string }[];
  const shifts = new Map((db.prepare(`SELECT id, identity, task_id FROM shifts WHERE ended_at IS NULL OR ended_at >= ?`).all(t0 - USAGE_WINDOW_MS) as
    { id: string; identity: string; task_id: number | null }[]).map((s) => [s.id, s]));

  const want = new Set(accounts);
  const snaps: Snap[] = [];
  const lastCost = new Map<string, number>();
  const lastFrom = new Map<string, string>();
  const byKind = new Map<UsageKind, number>();
  const byPerson = new Map<string, number>();
  const taskPeople = new Set<string>();
  const open = new Map<string, number>();
  const spans: { from: number; to: number }[] = [];
  let total = 0;
  for (const r of rows) {
    if (r.type === 'message.state') {
      // Cheap first: only a `seen` says what started the next turn.
      if (!r.data.includes('"seen"')) continue;
      const d = JSON.parse(r.data) as { state?: string; from?: string };
      if (d.state === 'seen' && r.identity && d.from) lastFrom.set(r.identity, d.from);
      continue;
    }
    if (r.type === 'account.changed') {
      const d = JSON.parse(r.data) as { name?: unknown; seven_day_pct?: unknown; snapshot_at?: unknown };
      if (typeof d.name === 'string' && want.has(d.name) && typeof d.seven_day_pct === 'number') {
        snaps.push({ name: d.name, at: typeof d.snapshot_at === 'number' ? d.snapshot_at : r.ts, pct: d.seven_day_pct });
      }
      continue;
    }
    if (r.type === 'shift.state') {
      const d = JSON.parse(r.data) as { shift?: string; state?: string };
      if (!d.shift) continue;
      // A new run (a resume) counts its costUsd from zero again.
      if (d.state === 'starting') lastCost.delete(d.shift);
      // Parallel: each run of a task shift, from its `starting` to its `ended` (a resume is a new run of the same row).
      if (shifts.get(d.shift)?.task_id == null) continue;
      if (d.state === 'starting' && !open.has(d.shift)) open.set(d.shift, r.ts);
      else if ((d.state === 'ended' || d.state === 'dead') && open.has(d.shift)) { spans.push({ from: open.get(d.shift)!, to: r.ts }); open.delete(d.shift); }
      continue;
    }
    // Spend: costUsd is the run's running total, so a turn costs the step from the run's previous result.
    const d = JSON.parse(r.data) as { shift?: string; ev?: { costUsd?: unknown } };
    const c = typeof d.ev?.costUsd === 'number' ? d.ev.costUsd : null;
    if (!d.shift || c == null) continue;
    const prev = lastCost.get(d.shift);
    lastCost.set(d.shift, c);
    if (r.ts < t0) continue;
    const step = prev != null && c >= prev ? c - prev : c;
    if (!(step > 0)) continue;
    const s = shifts.get(d.shift);
    const who = s?.identity ?? r.identity ?? '?';
    const task = s?.task_id != null;
    const by = lastFrom.get(who);
    lastFrom.delete(who);
    const kind: UsageKind = task ? 'tasks'
      : by === OWNER ? 'leads_owner'
      : by === 'hq' ? 'leads_hq'
      : by ? 'leads_workers' : 'leads_other';
    byKind.set(kind, (byKind.get(kind) ?? 0) + step);
    byPerson.set(who, (byPerson.get(who) ?? 0) + step);
    if (task) taskPeople.add(who);
    total += step;
  }
  const share = (v: number) => (total > 0 ? Math.round((v / total) * 1000) / 1000 : 0);
  const live = (db.prepare(`SELECT id FROM shifts WHERE task_id IS NOT NULL AND kind != 'foreign' AND state IN ('starting','live')`).all() as { id: string }[]);
  for (const s of live) if (open.has(s.id)) spans.push({ from: open.get(s.id)!, to: now });

  return {
    measured_at: now,
    hour_pct: usedPct(snaps, now - HOUR),
    day_pct: usedPct(snaps, t0),
    kinds: [...byKind].map(([kind, v]) => ({ kind, share: share(v) })).filter((k) => k.share > 0).sort((a, b) => b.share - a.share),
    people: [...byPerson].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, v]) => ({ id, name: names(id), share: share(v), task: taskPeople.has(id) })).filter((p) => p.share > 0),
    // The peak is the busiest hour's average: a burst of starts that the stop right after ended is not parallel work.
    parallel: { now: live.length, avg: overlap(spans, t0, now).avg,
      peak: Math.max(0, ...Array.from({ length: 24 }, (_, i) => overlap(spans, t0 + i * HOUR, t0 + (i + 1) * HOUR).avg)) },
  };
}
