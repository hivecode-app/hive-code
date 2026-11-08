// hq's own event loop, frozen (#313): on 25/10 at 21:50 no event was written for 4 seconds, a host's reply lost to its
// own timeout, and two probes failed at 10 seconds. Nothing measured it. Now `monitorEventLoopDelay` does, and a
// freeze of STALL_MS or more is one `hq.event_loop_stall` event: how long, and what was running around it (the loops of
// `every()` and the API routes that began before it ended and had not finished before it began).
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

type IntervalHistogram = ReturnType<typeof monitorEventLoopDelay>;

/** A freeze this long is a stall: one second, well past a GC pause or a slow query, short of a 5s host timeout. */
export const STALL_MS = 1000;
/** How often the histogram is read. A stall is reported this soon after it ends. */
const CHECK_MS = 500;
/** What ran, kept for the report: enough for every loop and a burst of API calls. */
const RECENT_MAX = 64;
const SHOWN = 6;

interface Activity { what: string; start: number; end: number | null }
export interface StallReport {
  ms: number;
  /** Overlapping the stall: the finished ones first (the likely cause is among them), longest first. `ms` is wall time
   *  (an async loop's includes its waits); `open`: still running, e.g. a loop awaiting a host. */
  ran: { what: string; ms: number; open: boolean }[];
  /** Handles alive in hq at the report (Timeout, TCPSocketWrap, …): process.getActiveResourcesInfo(), counted. */
  resources: Record<string, number>;
}

export class LoopWatch {
  private h: IntervalHistogram | null = null;
  private timer: NodeJS.Timeout | null = null;
  private recent: Activity[] = [];
  private readonly report: (r: StallReport) => void;
  private readonly stallMs: number;
  private readonly checkMs: number;
  private readonly onBegin: ((what: string) => void) | null;

  constructor(report: (r: StallReport) => void, opts: { stallMs?: number; checkMs?: number; onBegin?: (what: string) => void } = {}) {
    this.report = report;
    this.onBegin = opts.onBegin ?? null;
    this.stallMs = opts.stallMs ?? STALL_MS;
    this.checkMs = opts.checkMs ?? CHECK_MS;
  }

  /** Marks the start of `what`; call the returned function when it ends. Cheap enough for every API call. */
  begin(what: string): () => void {
    const a: Activity = { what, start: performance.now(), end: null };
    this.onBegin?.(what);
    this.recent.push(a);
    if (this.recent.length > RECENT_MAX) {
      // Finished ones go first; an open one (a loop awaiting) stays, it may be the one a stall lands on.
      const i = this.recent.findIndex((x) => x.end !== null);
      this.recent.splice(i < 0 ? 0 : i, 1);
    }
    return () => { a.end = performance.now(); };
  }

  start(): void {
    if (this.h) return;
    this.h = monitorEventLoopDelay({ resolution: 20 });
    this.h.enable();
    this.timer = setInterval(() => this.check(), this.checkMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.h?.disable();
    this.h = null;
  }

  private check(): void {
    const h = this.h;
    if (!h) return;
    const ms = Math.round(h.max / 1e6);
    if (ms < this.stallMs) return;
    // Only after a stall: a reset also forgets when the histogram's own timer last ran, so the delay it measures next
    // (a stall that ends right then) is not recorded. Resetting on every check lost every stall the check ran just before.
    h.reset();
    const now = performance.now();
    const from = now - ms - this.checkMs; // the stall ended before this check, at most one interval ago
    const to = now - this.checkMs; // the stall's end, at the earliest: what began after it is not a suspect
    const ran = this.recent
      .filter((a) => a.start <= to && (a.end === null || a.end >= from))
      .map((a) => ({ what: a.what, ms: Math.round((a.end ?? now) - a.start), open: a.end === null }))
      .sort((a, b) => Number(a.open) - Number(b.open) || b.ms - a.ms)
      .slice(0, SHOWN);
    const resources: Record<string, number> = {};
    for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] ?? 0) + 1;
    try { this.report({ ms, ran, resources }); } catch { /* store closed (hq stopping) */ }
  }
}
