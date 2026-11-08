import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { availableParallelism, loadavg } from 'node:os';

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

/** The machine's memory, beyond MemAvailable (task 1547): swap, and memory PSI. A part that can't be read is left out, never 0. */
export interface MemInfo { totalMb: number; availableMb: number; swapTotalMb?: number; swapFreeMb?: number; psiSome10?: number }

export function memInfoMb(): MemInfo {
  const txt = readFileSync('/proc/meminfo', 'utf8');
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(txt)?.[1] ?? 0) / 1024;
  const swapTotal = /^SwapTotal:\s+(\d+)/m.exec(txt), swapFree = /^SwapFree:\s+(\d+)/m.exec(txt);
  const psi = memPsiSome10();
  return {
    totalMb: get('MemTotal'), availableMb: get('MemAvailable'),
    ...(swapTotal && swapFree ? { swapTotalMb: Number(swapTotal[1]) / 1024, swapFreeMb: Number(swapFree[1]) / 1024 } : {}),
    ...(psi != null ? { psiSome10: psi } : {}),
  };
}

/** `some avg10` of /proc/pressure/memory: the share of the last 10 seconds some task waited for memory. null = no PSI here. */
export function memPsiSome10(read: (p: string) => string = (p) => readFileSync(p, 'utf8')): number | null {
  try {
    const m = /^some avg10=([\d.]+)/m.exec(read('/proc/pressure/memory'));
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

/** Load average over the last minute and the CPUs it is shared by (#224: load from outside the shifts counts too). */
export function loadInfo(): { load1: number; cpus: number } {
  return { load1: loadavg()[0] ?? 0, cpus: availableParallelism() };
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
