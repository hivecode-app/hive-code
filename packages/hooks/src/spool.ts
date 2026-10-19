// Hook spool: one NDJSON line per hook invocation, per UTC hour (B.5).
// Kept dependency-light: the hook CLI imports this on every tool call.
import { appendFileSync, mkdirSync } from 'node:fs';
import type { SpoolLine } from '@company/shared';

/** Shift id used when COMPANY_SHIFT is missing. */
export const UNKNOWN_SHIFT = '_unknown';

/**
 * mkdir -p with a bounded loop. fs.mkdirSync({recursive:true}) spins forever
 * on some paths (e.g. under /proc, where mkdir answers ENOENT for a child of
 * an existing dir), and a hook must never hang.
 */
export function mkdirp(dir: string): void {
  try { mkdirSync(dir); return; } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return;
    if (code !== 'ENOENT') throw e;
  }
  const parts = dir.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const p = parts.slice(0, i).join('/');
    if (!p) continue;
    try { mkdirSync(p); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
}

export function spoolDir(stateRoot: string, shift: string): string {
  return `${stateRoot}/shifts/${shift || UNKNOWN_SHIFT}/spool`;
}

/** `2026-10-20T14:03:00.000Z` -> `2026102014` */
export function spoolHour(iso: string): string {
  return iso.slice(0, 13).replace(/[-T]/g, '');
}

/**
 * Appends one line with a single O_APPEND write, so concurrent hook processes
 * never interleave. Returns the file written. Throws on I/O errors.
 */
export function appendSpool(stateRoot: string, shift: string, line: SpoolLine): string {
  const dir = spoolDir(stateRoot, shift);
  mkdirp(dir);
  const file = `${dir}/${spoolHour(line.ts)}.ndjson`;
  appendFileSync(file, JSON.stringify(line) + '\n', { flag: 'a' });
  return file;
}
