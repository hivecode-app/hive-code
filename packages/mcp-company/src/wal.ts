// Local write-ahead log for mcp-company write tools (B.5: nothing in a turn
// depends on hq). A tool call is answered only after its entry is fsynced to
// <shiftDir>/wal/wal.ndjson; a background flusher then POSTs entries to hq in
// order. Settled entries are recorded in acks.ndjson as {"ack":id} (2xx) or
// {"fail":id,"status":n} (4xx, permanent). On startup the WAL minus settled ids
// is replayed; hq dedupes by id, so a resend after a crash is harmless.
import {
  appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync,
  readSync, statSync, truncateSync, writeSync,
} from 'node:fs';
import type { WalEntry } from '@company/shared';

export interface TransportReply { status: number; body?: unknown }
/** Sends one entry to hq. Throw for network errors; resolve with any HTTP status. */
export type OpTransport = (entry: WalEntry) => Promise<TransportReply>;

export interface WalOptions {
  dir: string;
  transport: OpTransport;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  log?: (msg: string) => void;
}

type Outcome = 'ack' | 'fail' | 'retry';

function classify(status: number): Outcome {
  if (status >= 200 && status < 300) return 'ack';
  // 408/429 are "try again later" by HTTP semantics; every other 4xx is a
  // permanent reject per company-api.ts.
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return 'fail';
  return 'retry';
}

function readLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn tail after a crash */ }
  }
  return out;
}

/** Makes sure the next append starts on a fresh line after a torn write. */
function healTail(file: string): void {
  if (!existsSync(file)) return;
  const size = statSync(file).size;
  if (size === 0) return;
  const b = Buffer.alloc(1);
  const fd = openSync(file, 'r');
  try { readSync(fd, b, 0, 1, size - 1); } finally { closeSync(fd); }
  if (b[0] !== 0x0a) appendFileSync(file, '\n');
}

/** Appends + fsyncs; returns the file size after the write. */
function appendDurable(file: string, line: string): number {
  const fd = openSync(file, 'a');
  try {
    writeSync(fd, line);
    fsyncSync(fd);
    return fstatSync(fd).size;
  } finally { closeSync(fd); }
}

function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

export class Wal {
  readonly walFile: string;
  readonly ackFile: string;
  private readonly transport: OpTransport;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly log: (msg: string) => void;
  private queue: WalEntry[];
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private stopSignal: Promise<void> = Promise.resolve();
  private fireStop: () => void = () => {};
  private idleWaiters: Array<() => void> = [];
  private dirty = false;
  /** WAL size as this instance last left it; a mismatch means another instance wrote. */
  private walSize = 0;
  /** Number of transport attempts made, for observability/tests. */
  attempts = 0;

  constructor(opts: WalOptions) {
    mkdirSync(opts.dir, { recursive: true });
    this.walFile = `${opts.dir}/wal.ndjson`;
    this.ackFile = `${opts.dir}/acks.ndjson`;
    this.transport = opts.transport;
    // unref: a backoff timer alone must not keep the process alive after stop().
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => { setTimeout(r, ms).unref(); }));
    this.random = opts.random ?? Math.random;
    this.baseDelayMs = opts.baseDelayMs ?? 250;
    this.maxDelayMs = opts.maxDelayMs ?? 30_000;
    this.log = opts.log ?? (() => {});
    healTail(this.walFile);
    healTail(this.ackFile);
    this.queue = this.replay();
    this.walSize = sizeOf(this.walFile);
    this.dirty = this.walSize > 0;
  }

  private replay(): WalEntry[] {
    const settled = new Set<string>();
    for (const a of readLines(this.ackFile) as Array<{ ack?: string; fail?: string }>) {
      if (typeof a?.ack === 'string') settled.add(a.ack);
      if (typeof a?.fail === 'string') settled.add(a.fail);
    }
    const seen = new Set<string>();
    const out: WalEntry[] = [];
    for (const e of readLines(this.walFile) as WalEntry[]) {
      if (typeof e?.id !== 'string' || settled.has(e.id) || seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
    return out;
  }

  /** Durably appends the entry (fsync) and schedules it for sending. */
  append(entry: WalEntry): void {
    const line = JSON.stringify(entry) + '\n';
    const size = appendDurable(this.walFile, line);
    // Only our own bytes since the last check: keep tracking; otherwise leave
    // the mismatch so compact() refuses to drop another instance's entries.
    if (size === this.walSize + Buffer.byteLength(line)) this.walSize = size;
    this.dirty = true;
    this.queue.push(entry);
    this.wake?.();
  }

  pending(): readonly WalEntry[] { return this.queue; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopSignal = new Promise((r) => { this.fireStop = r; });
    this.loop = this.run().catch((e: unknown) => {
      this.running = false;
      this.log(`wal: flusher crashed: ${e instanceof Error ? e.stack : String(e)}`);
    });
  }

  /** Stops the flusher after the in-flight attempt; pending entries stay in the WAL. */
  async stop(): Promise<void> {
    this.running = false;
    this.fireStop();
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  /** Resolves once nothing is pending (or immediately if nothing is). */
  whenIdle(): Promise<void> {
    if (this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private async run(): Promise<void> {
    let failures = 0;
    while (this.running) {
      const head = this.queue[0];
      if (!head) {
        this.compact();
        for (const w of this.idleWaiters.splice(0)) w();
        await new Promise<void>((r) => { this.wake = r; });
        this.wake = null;
        continue;
      }
      let outcome: Outcome = 'retry';
      let status = 0;
      this.attempts++;
      try {
        const reply = await this.transport(head);
        status = reply.status;
        outcome = classify(status);
      } catch (e) {
        this.log(`wal: send ${head.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (outcome === 'retry') {
        const exp = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** failures);
        const delay = Math.round(exp * (0.5 + this.random() * 0.5));
        failures++;
        if (status) this.log(`wal: hq answered ${status} for ${head.id}, retry in ${delay}ms`);
        await Promise.race([this.sleep(delay), this.stopSignal]);
        continue;
      }
      const line = outcome === 'ack' ? { ack: head.id } : { fail: head.id, status };
      if (outcome === 'fail') this.log(`wal: hq rejected ${head.id} with ${status}; not retrying`);
      try {
        appendDurable(this.ackFile, JSON.stringify(line) + '\n');
      } catch (e) {
        // ENOSPC/EIO: keep the entry at the head and back off; the resend is
        // harmless (hq dedupes by id).
        const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** failures);
        failures++;
        this.log(`wal: recording ack for ${head.id} failed (${e instanceof Error ? e.message : String(e)}), retry in ${delay}ms`);
        await Promise.race([this.sleep(delay), this.stopSignal]);
        continue;
      }
      failures = 0;
      this.queue.shift();
    }
  }

  /** Everything is settled: drop both files. WAL first, so a crash in between
   *  leaves only stale acks (harmless), never unacked-looking entries. */
  private compact(): void {
    if (!this.dirty || this.queue.length > 0) return;
    try {
      // Truncate only if the WAL is exactly as this instance left it: if an
      // overlapping instance (e.g. a restart racing the old process) appended
      // entries, they are not ours to drop; the next replay settles them.
      const fd = openSync(this.walFile, 'r+');
      try {
        const size = fstatSync(fd).size;
        if (size !== this.walSize) {
          this.log(`wal: not compacting, wal.ndjson changed under us (${this.walSize} -> ${size} bytes)`);
          this.dirty = false;
          return;
        }
        ftruncateSync(fd, 0);
      } finally { closeSync(fd); }
      this.walSize = 0;
      if (existsSync(this.ackFile)) truncateSync(this.ackFile, 0);
      this.dirty = false;
    } catch (e) {
      this.log(`wal: compact failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
