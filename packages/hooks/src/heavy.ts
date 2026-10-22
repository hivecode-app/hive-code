// PreToolUse reminder (resources-design.md §1, stage 4): a known heavy command that runs without `company-run`.
// A reminder only, never a block (the owner's call for the first week); every hit is spooled so the false-positive
// rate can be measured. Pure except `serverState`, which reads /proc and nothing else (a hook never touches the network).
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { basename } from 'node:path';
import { lex } from './guard.ts';

export const HEAVY_EVENT = 'PreToolUse.heavy-unreserved';

export interface HeavyHit {
  /** the reservation class (`reserve` class name) the command belongs to */
  class: 'test-full' | 'build' | 'docker';
  /** the command as detected, e.g. `flutter test` */
  what: string;
}

const SEPARATORS = new Set(['&&', '||', ';', ';;', '|', '|&', '&', '(', ')']);
/** Words that run the next command without changing what it is. */
const WRAPPERS = new Set(['env', 'time', 'nice', 'sudo', 'nohup', 'exec', 'command', 'ionice', 'stdbuf']);
/** `flutter test` flags that narrow a run to a few tests. */
const NARROW_FLAGS = /^(--name|--plain-name|-n|-N|--tags|-t|--exclude-tags|-x)(=|$)/;

/** A positional word of `flutter test` that names a file or a directory: a focused run. */
function focusedFlutterTest(rest: string[]): boolean {
  return rest.some((a) => (!a.startsWith('-') && (a.endsWith('.dart') || a.includes('/') || a === 'test' || a === 'integration_test')) || NARROW_FLAGS.test(a));
}

function classify(words: string[]): HeavyHit | null {
  let w = [...words];
  for (;;) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]!)) w.shift();
    if (w.length && WRAPPERS.has(w[0]!)) { w.shift(); continue; }
    // `timeout 30m cmd`, `flock file cmd`: not a reservation, so the command under them is still unreserved.
    if (w[0] === 'timeout' || w[0] === 'flock') { w.shift(); while (w[0]?.startsWith('-')) w.shift(); w.shift(); continue; }
    break;
  }
  const [cmd, ...args] = w;
  if (!cmd) return null;
  const name = basename(cmd);
  if (name === 'company-run') return null;
  if ((name === 'bash' || name === 'sh') && args[0] === '-c' && typeof args[1] === 'string') return scan(args[1]);
  if (name === 'flutter') {
    const sub = args.findIndex((a) => !a.startsWith('-'));
    if (sub >= 0 && args[sub] === 'test' && !focusedFlutterTest(args.slice(sub + 1))) return { class: 'test-full', what: 'flutter test' };
    return null;
  }
  if (name === 'gradlew' || name === 'gradlew.bat') return { class: 'build', what: 'gradlew' };
  if (name === 'docker' || name === 'docker-compose') {
    const rest = args.filter((a) => !a.startsWith('-'));
    if (name === 'docker' && rest[0] === 'build') return { class: 'docker', what: 'docker build' };
    if (name === 'docker' && rest[0] === 'buildx' && rest[1] === 'build') return { class: 'docker', what: 'docker buildx build' };
    if (name === 'docker' && rest[0] === 'compose' && rest.includes('up')) return { class: 'docker', what: 'docker compose up' };
    if (name === 'docker-compose' && rest.includes('up')) return { class: 'docker', what: 'docker-compose up' };
  }
  return null;
}

/** The first known heavy command in a Bash command line that is not under `company-run`, or null. */
export function scan(command: string): HeavyHit | null {
  let seg: string[] = [];
  const subs: string[] = [];
  for (const t of [...lex(command), { op: ';' }]) {
    if (t.op && SEPARATORS.has(t.op)) {
      const hit = classify(seg);
      if (hit) return hit;
      seg = [];
    } else if (t.w !== undefined) { seg.push(t.w); subs.push(...(t.subs ?? [])); }
  }
  for (const s of subs) { const hit = scan(s); if (hit) return hit; }
  return null;
}

export interface ServerState { memAvailMb: number | null; memTotalMb: number | null; load1: number | null; cpus: number }

/** This machine's memory and load, from /proc. Missing numbers are null, never guessed. */
export function serverState(read: (p: string) => string = (p) => readFileSync(p, 'utf8')): ServerState {
  const num = (text: string, key: string): number | null => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Math.round(Number(m[1]) / 1024) : null;
  };
  let mem = ''; let load = '';
  try { mem = read('/proc/meminfo'); } catch { /* unknown */ }
  try { load = read('/proc/loadavg'); } catch { /* unknown */ }
  const l = Number(load.split(' ')[0]);
  return { memAvailMb: num(mem, 'MemAvailable'), memTotalMb: num(mem, 'MemTotal'), load1: load && Number.isFinite(l) ? l : null, cpus: cpus().length };
}

export function describeState(s: ServerState): string {
  const gb = (mb: number) => (mb / 1024).toFixed(1);
  const mem = s.memAvailMb !== null && s.memTotalMb !== null ? `זיכרון פנוי ${gb(s.memAvailMb)}GB מתוך ${gb(s.memTotalMb)}GB` : 'הזיכרון לא נקרא';
  const load = s.load1 !== null ? `עומס ${s.load1.toFixed(1)} על ${s.cpus} ליבות` : 'העומס לא נקרא';
  return `${mem}, ${load}`;
}

/** The Hebrew reminder, or null when the command is not a known heavy one. */
export function heavyReminder(command: string, state: ServerState = serverState()): { hit: HeavyHit; text: string } | null {
  const hit = scan(command);
  if (!hit) return null;
  return {
    hit,
    text: `תזכורת: \`${hit.what}\` הוא פקודה כבדה, ואין עליה הזמנה (\`company-run\`). השרת משותף לכל המשמרות. מצב השרת עכשיו: ${describeState(state)}. `
      + `הפקודה לא נחסמת. לפני הריצה: \`reserve\` עם \`class: "${hit.class}"\`, ואז \`company-run --lease <lease> -- <הפקודה>\`. `
      + 'אם זו לא הרצה כבדה (למשל בדיקה ממוקדת שלא זוהתה, או docker ממשהו קטן), ממשיכים כרגיל.',
  };
}
