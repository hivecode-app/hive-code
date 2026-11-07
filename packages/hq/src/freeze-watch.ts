// hq frozen, and nobody restarting it (task 1505). On 08/11 from 01:49:47 to 02:00:56 hq's event loop was stuck in one
// synchronous call (GET /api/home, usage.ts reading two days of the event log from a disk at 60% io pressure). systemd saw
// a live process, hq's own watchdog and loop-watch run on the same loop, so they froze with it; the API timed out for 11
// minutes. Now a worker thread, which has its own loop, watches a heartbeat the main thread writes every second into
// shared memory. Silent for FREEZE_MS while armed: it writes what it saw to freeze.json and SIGKILLs the process
// (systemd's Restart=always brings it back in 2 seconds). The next hq turns freeze.json into one urgent item for him.
// The automation is `freeze-watch` in org.yaml (rotem); off = the worker watches and does nothing.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

export const AUTOMATION = 'freeze-watch';
/** The ref of its item in "מחכה לך": one open at a time. */
export const FREEZE_REF = 'hq-freeze';
/** meta: how many freezes the open item counts. */
export const FREEZE_COUNT = 'freeze_watch.count';
/** Silent this long = frozen. A GC pause or a slow query is far shorter; 11 minutes was not. */
export const FREEZE_MS = 45_000;
const CHECK_MS = 5_000;
const BEAT_MS = 1_000;
/** The last thing the main thread began (an API route, a loop): the likely culprit. */
const MARK_BYTES = 256;

export interface FreezeReport {
  at: number;
  silent_ms: number;
  pid: number;
  /** What the main thread began last, and when. */
  last: { what: string; at: number } | null;
  /** The machine at that moment: /proc/meminfo (MB), /proc/loadavg, /proc/pressure/{memory,io,cpu} avg10. */
  machine: { mem_available_mb: number | null; swap_free_mb: number | null; load1: number | null; psi: Record<string, number | null> };
}

// Runs in the worker (eval: plain JS). Int32: [0] armed, [1] the mark's length; Float64: [0] the beat (monotonic ms,
// hrtime: the same clock in both threads, and a wall clock that jumps is not a freeze), [1] the mark's wall time; then the mark.
const WORKER = `
// getBuiltinModule, not require: an eval worker is CommonJS or ESM by its parent's flags (--input-type).
const { workerData } = process.getBuiltinModule('node:worker_threads');
const fs = process.getBuiltinModule('node:fs');
const { sab, file, freezeMs, checkMs, pid } = workerData;
const mono = () => Number(process.hrtime.bigint() / 1000000n);
const i32 = new Int32Array(sab, 0, 2);
const f64 = new Float64Array(sab, 8, 2);
const mark = new Uint8Array(sab, 24);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const kb = (txt, k) => { const m = new RegExp('^' + k + ':\\\\s+(\\\\d+)', 'm').exec(txt); return m ? Math.round(Number(m[1]) / 1024) : null; };
const avg10 = (txt) => { const m = /^some avg10=([\\d.]+)/m.exec(txt); return m ? Number(m[1]) : null; };
setInterval(() => {
  if (Atomics.load(i32, 0) !== 1) return;
  const beat = f64[0];
  const silent = mono() - beat;
  if (!beat || silent < freezeMs) return;
  const len = Atomics.load(i32, 1);
  const mem = read('/proc/meminfo');
  const load = Number(read('/proc/loadavg').split(' ')[0]);
  const report = {
    at: Date.now(), silent_ms: Math.round(silent), pid,
    last: len > 0 ? { what: Buffer.from(mark.slice(0, len)).toString('utf8'), at: f64[1] } : null,
    machine: { mem_available_mb: kb(mem, 'MemAvailable'), swap_free_mb: kb(mem, 'SwapFree'), load1: Number.isFinite(load) ? load : null,
      psi: { memory: avg10(read('/proc/pressure/memory')), io: avg10(read('/proc/pressure/io')), cpu: avg10(read('/proc/pressure/cpu')) } },
  };
  try { fs.writeFileSync(file + '.tmp', JSON.stringify(report), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); } catch {}
  process.kill(pid, 'SIGKILL');
}, checkMs);
`;

export class FreezeWatch {
  private readonly sab = new SharedArrayBuffer(24 + MARK_BYTES);
  private readonly i32 = new Int32Array(this.sab, 0, 2);
  private readonly f64 = new Float64Array(this.sab, 8, 2);
  private readonly markBytes = new Uint8Array(this.sab, 24);
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  readonly file: string;
  private readonly freezeMs: number;
  private readonly checkMs: number;
  private readonly beatMs: number;

  constructor(file: string, opts: { freezeMs?: number; checkMs?: number; beatMs?: number } = {}) {
    this.file = file;
    this.freezeMs = opts.freezeMs ?? FREEZE_MS;
    this.checkMs = opts.checkMs ?? CHECK_MS;
    this.beatMs = opts.beatMs ?? BEAT_MS;
  }

  /** Starts beating and watching. `armed()` is asked on every beat: the toggle, read on the main thread. */
  start(armed: () => boolean): void {
    if (this.worker) return;
    this.beat(armed);
    this.worker = new Worker(WORKER, {
      eval: true,
      workerData: { sab: this.sab, file: this.file, freezeMs: this.freezeMs, checkMs: this.checkMs, pid: process.pid },
    });
    this.worker.unref();
    this.timer = setInterval(() => this.beat(armed), this.beatMs);
    this.timer.unref();
  }

  private beat(armed: () => boolean): void {
    let on = false;
    try { on = armed(); } catch { /* store closed: not armed */ }
    this.f64[0] = Number(process.hrtime.bigint() / 1_000_000n);
    Atomics.store(this.i32, 0, on ? 1 : 0);
  }

  /** What the main thread begins now (loop-watch's begin): the report names the last one. */
  mark(what: string): void {
    const n = Buffer.from(what.slice(0, 120), 'utf8').copy(this.markBytes, 0, 0, MARK_BYTES);
    this.f64[1] = Date.now();
    Atomics.store(this.i32, 1, n);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    Atomics.store(this.i32, 0, 0);
    await this.worker?.terminate();
    this.worker = null;
  }

  /** The report a frozen hq left, once: read and removed. Null when the last hq did not freeze. */
  takeReport(): FreezeReport | null {
    if (!existsSync(this.file)) return null;
    try { return JSON.parse(readFileSync(this.file, 'utf8')) as FreezeReport; }
    catch { return null; }
    finally { rmSync(this.file, { force: true }); }
  }
}

const gb = (mb: number | null) => (mb == null ? null : (mb / 1024).toFixed(1));

/**
 * The urgent item for him: what happened and what it meant, in his words. Only what is known: the workers' writes wait in
 * their own WAL (mcp-company wal.ts) and go in when hq is back, so nothing is said to be lost. The rest (what began last,
 * load, PSI) is in the `hq.freeze` event. `times`: the freezes since this item opened (a second one updates it).
 */
export function freezeItem(r: FreezeReport, tz: (ms: number) => string, times = 1): { title: string; body: string } {
  const secs = Math.round(r.silent_ms / 1000);
  const mem = gb(r.machine.mem_available_mb);
  const swap = gb(r.machine.swap_free_mb);
  // The numbers as they were, no verdict on them: a freeze on an idle machine is told the same way.
  const machine = mem && swap ? ` באותו רגע היו בשרת ${mem}GB זיכרון פנוי ו-${swap}GB פנויים ב-swap.` : '';
  return {
    title: times > 1 ? `hq נתקע ${times} פעמים, האחרונה ב-${tz(r.at)}` : `hq נתקע ${secs} שניות והופעל מחדש`,
    body: `ב-${tz(r.at)} hq לא ענה ${secs} שניות, ולכן הוא הופעל מחדש לבד.${times > 1 ? ` זו הפעם ה-${times} מאז שהפריט הזה נפתח.` : ''} `
      + `בזמן הזה האפליקציה לא נטענה. מה שהעובדים כתבו חיכה אצלם ונכנס כשהוא חזר.${machine}`,
  };
}
