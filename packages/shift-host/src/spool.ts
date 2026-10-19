// Reader side of the hook spool (shifts/<id>/spool/<YYYYMMDDHH>.ndjson), written
// by `company hook <event>`. Cursor = "<file>:<byteOffsetAfterEntry>", opaque to hq.
import { existsSync, mkdirSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync,
  unlinkSync, writeFileSync, renameSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { SpoolEntry } from '@company/shared';

const FILE_RE = /^\d{10}\.ndjson$/;

interface Pos { file: string; offset: number }

function parseCursor(c: string | null): Pos | null {
  if (!c) return null;
  const i = c.lastIndexOf(':');
  if (i < 0) return null;
  const off = Number(c.slice(i + 1));
  return Number.isFinite(off) ? { file: c.slice(0, i), offset: off } : null;
}

export class SpoolReader {
  readonly dir: string;
  private watcher: FSWatcher | null = null;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  files(): string[] {
    try { return readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort(); } catch { return []; }
  }

  /** Last cursor hq acknowledged (persisted), used when hq asks from null. */
  ackedCursor(): string | null {
    try { return (JSON.parse(readFileSync(join(this.dir, '.ack'), 'utf8')) as { cursor: string }).cursor; } catch { return null; }
  }

  read(cursor: string | null, max = 500): { entries: SpoolEntry[]; cursor: string | null; more: boolean } {
    const from = parseCursor(cursor ?? this.ackedCursor());
    const entries: SpoolEntry[] = [];
    let last: string | null = cursor ?? this.ackedCursor();
    for (const f of this.files()) {
      if (from && f < from.file) continue;
      const start = from && f === from.file ? from.offset : 0;
      const p = join(this.dir, f);
      let size: number;
      try { size = statSync(p).size; } catch { continue; }
      if (size <= start) continue;
      const buf = Buffer.alloc(size - start);
      const fd = openSync(p, 'r');
      try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
      let off = 0;
      for (;;) {
        const nl = buf.indexOf(0x0a, off);
        if (nl < 0) break;            // partial line still being written: stop here
        const line = buf.subarray(off, nl).toString('utf8');
        off = nl + 1;
        const cur = `${f}:${start + off}`;
        last = cur;
        if (!line.trim()) continue;
        let o: any;
        try { o = JSON.parse(line); } catch { o = { ts: '', event: 'unparseable', payload: { raw: line.slice(0, 2000) } }; }
        entries.push({ cursor: cur, ts: o.ts ?? '', event: o.event ?? 'unknown', payload: o.payload ?? o });
        if (entries.length >= max) return { entries, cursor: last, more: true };
      }
    }
    return { entries, cursor: last, more: false };
  }

  /** Persist the ack and delete files that are wholly acknowledged and closed (older hour). */
  ack(cursor: string): void {
    const pos = parseCursor(cursor);
    if (!pos) throw new Error('bad cursor');
    const prev = parseCursor(this.ackedCursor());
    if (prev && (prev.file > pos.file || (prev.file === pos.file && prev.offset >= pos.offset))) return;
    const tmp = join(this.dir, '.ack.tmp');
    writeFileSync(tmp, JSON.stringify({ cursor, at: new Date().toISOString() }));
    renameSync(tmp, join(this.dir, '.ack'));
    const files = this.files();
    const newest = files[files.length - 1];
    for (const f of files) {
      if (f > pos.file) break;
      if (f === newest) break;      // may still receive appends this hour
      const p = join(this.dir, f);
      if (f < pos.file || (existsSync(p) && statSync(p).size <= pos.offset)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  /** Calls `onReady` (debounced) whenever the spool grows. */
  watch(onReady: () => void): void {
    let t: NodeJS.Timeout | null = null;
    try {
      this.watcher = watch(this.dir, () => {
        if (t) return;
        t = setTimeout(() => { t = null; onReady(); }, 50);
      });
    } catch { /* fs.watch unsupported: hq still polls spool_read */ }
  }

  close(): void { this.watcher?.close(); }
}
