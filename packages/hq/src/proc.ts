import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** /proc/<pid>/stat field 22 (starttime). pid + procStart guards against pid reuse (B.5). */
export function procStart(pid: number): string | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
    return rest[19] ?? null; // fields after comm start at #3; starttime is #22
  } catch {
    return null;
  }
}

export function memInfoMb(): { totalMb: number; availableMb: number } {
  const txt = readFileSync('/proc/meminfo', 'utf8');
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(txt)?.[1] ?? 0) / 1024;
  return { totalMb: get('MemTotal'), availableMb: get('MemAvailable') };
}

/** Namespace for shift session ids (B.2): uuidv5(NS, `${identity}:${shift_no}`).
 *  Must equal adapter/src/ids.ts SHIFT_NAMESPACE — the shift-host derives the same id. */
export const SHIFT_NAMESPACE = 'b7c0a3e4-5d1f-5e2a-9c6b-1f0d2e3a4c5b';

export function uuidv5(name: string, namespace = SHIFT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(ns).update(name, 'utf8').digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export function sessionIdFor(identity: string, shiftNo: number): string {
  return uuidv5(`${identity}:${shiftNo}`);
}
