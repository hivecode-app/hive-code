// Durable per-shift log: shifts/<id>.ndjson (B.5, B.11). One LoggedFrame per line.
// logId lives in shifts/<id>/log.json and identifies this file (protocol "logId").
import { closeSync, createReadStream, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { LoggedFrame } from '@company/shared';

type Unseq<T> = T extends unknown ? Omit<T, 'seq' | 'ts'> : never;
export type FrameInput = Unseq<LoggedFrame>;

export class DurableLog {
  readonly path: string;
  readonly logId: string;
  lastSeq = 0;
  private fd: number;
  private dirty = false;
  private readonly timer: NodeJS.Timeout;

  constructor(path: string, metaPath: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(metaPath), { recursive: true, mode: 0o700 });
    let logId: string | null = null;
    if (existsSync(metaPath) && existsSync(path)) {
      try { logId = (JSON.parse(readFileSync(metaPath, 'utf8')) as { logId?: string }).logId ?? null; } catch { /* new */ }
    }
    if (!logId) {
      logId = randomUUID();
      // A log without meta (or meta without log) starts a new identity.
      writeFileSync(`${metaPath}.tmp`, JSON.stringify({ logId, createdAt: new Date().toISOString() }));
      renameSync(`${metaPath}.tmp`, metaPath);
    }
    this.logId = logId;
    this.lastSeq = existsSync(path) ? scanLastSeq(path) : 0;
    this.fd = openSync(path, 'a', 0o600);
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref();
  }

  private closed = false;
  append(f: FrameInput, durable = false): LoggedFrame {
    if (this.closed) throw new Error('log closed');
    const frame = { ...f, seq: ++this.lastSeq, ts: new Date().toISOString() } as LoggedFrame;
    writeSync(this.fd, JSON.stringify(frame) + '\n');
    this.dirty = true;
    if (durable) this.flush();
    return frame;
  }

  flush(): void {
    if (!this.dirty) return;
    try { fsyncSync(this.fd); } catch { /* best effort */ }
    this.dirty = false;
  }

  /** Frames with since < seq <= upto, in order. Tolerates a torn last line. */
  async *readRange(since: number, upto: number): AsyncGenerator<LoggedFrame> {
    if (upto <= since) return;
    const rl = createInterface({ input: createReadStream(this.path, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      let f: LoggedFrame;
      try { f = JSON.parse(line) as LoggedFrame; } catch { continue; }
      if (f.seq > upto) break;
      if (f.seq > since) yield f;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.flush();
    try { closeSync(this.fd); } catch { /* ignore */ }
  }
}

/** Last seq in an existing log; also repairs a torn final line by appending '\n'. */
function scanLastSeq(path: string): number {
  const buf = readFileSync(path, 'utf8');
  let last = 0;
  for (const line of buf.split('\n')) {
    if (!line) continue;
    try { const s = (JSON.parse(line) as { seq?: number }).seq; if (typeof s === 'number' && s > last) last = s; } catch { /* torn */ }
  }
  if (buf.length && !buf.endsWith('\n')) {
    const fd = openSync(path, 'a');
    writeSync(fd, '\n');
    closeSync(fd);
  }
  return last;
}
