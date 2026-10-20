// The company's one time zone: `timezone` in company/org.yaml (#121). Night mode, the home screen's morning,
// the hours hq writes in messages and the hours the app shows all read it from here, so moving him to another
// city is one line in org.yaml. Read live (cached by mtime): a merged change applies without a restart.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/** org.yaml without a valid `timezone` (the contract check refuses that, so only tests and broken files). */
export const FALLBACK_TIME_ZONE = 'UTC';

export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const cache = new Map<string, { stamp: string; tz: string }>();

/** `timezone` from `<companyDir>/org.yaml`. */
export function readTimeZone(companyDir: string): string {
  const file = join(companyDir, 'org.yaml');
  try {
    if (!existsSync(file)) return FALLBACK_TIME_ZONE;
    const st = statSync(file);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const hit = cache.get(file);
    if (hit?.stamp === stamp) return hit.tz;
    const raw = (parse(readFileSync(file, 'utf8')) as { timezone?: unknown } | null)?.timezone;
    const tz = validTimeZone(raw) ? raw : FALLBACK_TIME_ZONE;
    if (tz !== raw) console.warn(`[hq] ${file}: timezone ${JSON.stringify(raw)} is not an IANA zone; using ${FALLBACK_TIME_ZONE}`);
    cache.set(file, { stamp, tz });
    return tz;
  } catch (e) {
    console.warn(`[hq] ${file}: cannot read timezone (${(e as Error).message}); using ${FALLBACK_TIME_ZONE}`);
    return FALLBACK_TIME_ZONE;
  }
}

/** Offset of `tz` from UTC at `ts`, in ms (DST-aware, through Intl). */
export function tzOffsetMs(ts: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ts / 1000) * 1000;
}

/** The next time it is HH:MM in `tz`, after `now`. */
export function nextLocal(now: number, h: number, m: number, tz: string): number {
  const off = tzOffsetMs(now, tz);
  const l = new Date(now + off);
  let t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), h, m) - off;
  if (t <= now) t += 86_400_000;
  return t;
}

/** "07:05" in `tz`. */
export function hhmm(ts: number, tz: string): string {
  return new Intl.DateTimeFormat('he-IL', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ts);
}

/** What the app gets in /api/org and /api/board: the zone, and its offset now (the app has no tz database). */
export function clockOf(tz: string, now: number): { name: string; offset_min: number } {
  return { name: tz, offset_min: Math.round(tzOffsetMs(now, tz) / 60_000) };
}
