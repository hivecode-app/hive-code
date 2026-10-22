#!/usr/bin/env node
// Disk cleaning for a machine that runs tasks (task 382). On 22/10 the disk of hq-host hit 100% (273MB left) because docker
// had piled up 55GB of images and 43GB of build cache from smoke tests and task builds, and /tmp held another 7GB of
// finished tasks. Run daily by deploy/agent-company-disk-clean.timer, and by hq (disk-watch.ts) when the disk passes 85%,
// here and, over ssh, on the nodes.
//
//   node scripts/disk-clean.mjs [--dry-run] [--json] [--closed-tasks 3,7,12]
//
// It prunes docker build cache (6h) and unused images (24h), verifies the npm cache, trims the user journal to 300MB,
// and removes /tmp directories of tasks (t<N>, task-<N>, rev<N>, directories only) that closed more than 24 hours ago, plus audit-*
// directories nobody touched for 24 hours. It never touches docker volumes, and never a /tmp of a task that is open.
//
// Task 263: the docker steps used to report `freed: 0` while 28GB of cache and 23GB of images sat there. Measured on hq-host
// (22/10): `builder prune -f --filter until=6h` without `-a` freed 0B with 15.6GB reclaimable, and with `-a` it freed 2.2GB
// (records used in the last 6h, and anything a running build holds, stay). The number was also read from a "reclaimed" line
// that `builder prune` does not print ("Total:\t1.2GB"). On the containerd image store `until` is when the image was stored
// here, not when it was built, and images are pulled again all the time, so 72h almost never matched. `docker --version`
// passed even when the daemon was unreachable. Now each docker step reports how much the disk really changed, with docker's
// own figure in the note, and an unreachable daemon is a `docker` step with a note in the log, not a silent 0.
//
// "Closed" comes from --closed-tasks (hq passes it for a node, which has no hq.db) or else from hq.db, read-only: the tasks
// known to be done for over 24 hours. Any other task id keeps its /tmp. With no list the /tmp step is skipped.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOCKER_BUILD_CACHE_AGE = '6h';
export const DOCKER_IMAGE_AGE = '24h';
export const JOURNAL_SIZE = '300M';
export const TMP_AGE_MS = 24 * 3600_000;

/** `/tmp` names a task leaves behind: t121, task-121, rev49 (the number is the task id); audit-* carries no number. */
const NUMBERED = /^(?:t|task-|rev)(\d+)$/;
const UNNUMBERED = /^audit-/;

/**
 * Which /tmp entries to remove. `entries` carry whether anything inside changed in the last 24 hours (`recent`).
 * A numbered entry goes only if its task is in `closed` (known to be done for over 24h); an unnumbered one only if it is quiet.
 */
export function pickTmp(entries, closed) {
  const out = [];
  for (const e of entries) {
    if (e.recent) continue;
    const n = NUMBERED.exec(e.name);
    if (n) { if (closed.has(Number(n[1]))) out.push(e.name); continue; }
    if (UNNUMBERED.test(e.name)) out.push(e.name);
  }
  return out;
}

/** "1.2GB", "512MB", "34.5kB", "Total reclaimed space: 3.1GB" → bytes; null when there is no size in the text. */
export function parseBytes(text) {
  const m = /([\d.]+)\s*([kKMGT]?)i?B\b/.exec(text);
  if (!m) return null;
  const pow = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4 }[m[2]];
  return Math.round(Number(m[1]) * 1024 ** pow);
}

const DOCKER_ROOT = '/var/lib/docker';

/** Docker's own count from a prune: "Total reclaimed space: 3.1GB" (image prune) or "Total:\t3.1GB" (builder prune). */
export function dockerReported(out) {
  const line = out.split('\n').find((l) => /^\s*Total(?: reclaimed space)?:/i.test(l));
  return line ? parseBytes(line) : null;
}

export const human = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)}MB` : `${Math.round(b / 1024)}KB`);

function run(cmd, args, timeout = 10 * 60_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      resolve({ ok: !err, missing: err?.code === 'ENOENT', out: String(stdout ?? ''), err: err ? (String(stderr || err.message).trim().split('\n')[0] ?? '') : '' });
    });
  });
}

/** Tasks done for more than 24h. From hq.db, read-only; null when it cannot be read. */
async function closedFromDb(stateDir, now) {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(join(stateDir, 'hq.db'), { readOnly: true });
    try {
      const rows = db.prepare(`SELECT id FROM tasks WHERE state = 'done' AND updated_at <= ?`).all(now - TMP_AGE_MS);
      return new Set(rows.map((r) => Number(r.id)));
    } finally { db.close(); }
  } catch { return null; }
}

async function tmpEntries(dir, uid) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!NUMBERED.test(name) && !UNNUMBERED.test(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = lstatSync(p); } catch { continue; }
    if (st.uid !== uid || !st.isDirectory()) continue; // isDirectory is false for a symlink too
    // Anything inside (or the entry itself) changed in the last 24 hours → in use.
    const r = await run('find', [p, '-newermt', '24 hours ago', '-print', '-quit'], 60_000);
    out.push({ name, path: p, recent: !r.ok || r.out.trim() !== '' });
  }
  return out;
}

async function duBytes(path) {
  const r = await run('du', ['-sk', '--one-file-system', path], 120_000);
  return Number(r.out.split('\t')[0]) * 1024 || 0;
}

const used = (path) => { const s = statfsSync(path); return (s.blocks - s.bfree) * s.bsize; };

/** One run. Returns { steps: [{ name, freed, note }], freed, skipped } and logs it. `opts` is for tests. */
export async function clean(opts = {}) {
  const dry = !!opts.dryRun;
  const now = opts.now ?? Date.now();
  const home = opts.home ?? homedir();
  const stateDir = opts.stateDir ?? join(home, '.local', 'state', 'agent-company');
  const tmp = opts.tmp ?? '/tmp';
  const steps = [];
  const before = used(tmp);

  const system = !opts.tmpOnly; // tests clean a /tmp of their own and must not prune the machine's docker
  const docker = opts.dockerBin ?? 'docker';
  const info = (system || opts.dockerBin) && (await run(docker, ['info', '--format', '{{.ServerVersion}}'], 30_000));
  const hasDocker = info && !info.missing; // no docker on this machine at all: nothing to clean, not a failure
  if (hasDocker && !info.ok) steps.push({ name: 'docker', freed: 0, note: `הדמון לא נגיש, לא ניקיתי: ${info.err}` });
  else if (hasDocker) {
    const usedFn = opts.usedFn ?? (() => used(existsSync(DOCKER_ROOT) ? DOCKER_ROOT : tmp));
    for (const [name, args] of [
      ['docker build cache', ['builder', 'prune', '-af', '--filter', `until=${DOCKER_BUILD_CACHE_AGE}`]],
      ['docker images', ['image', 'prune', '-af', '--filter', `until=${DOCKER_IMAGE_AGE}`]],
    ]) {
      if (dry) { steps.push({ name, freed: 0, note: 'dry-run' }); continue; }
      const b = usedFn();
      const r = await run(docker, args);
      const reported = dockerReported(r.out);
      const actual = Math.max(0, b - usedFn());
      steps.push({ name, freed: actual, note: r.ok ? `docker דיווח ${reported === null ? 'כלום' : human(reported)}, הדיסק כולו (לא רק docker) השתנה ב-${human(actual)}` : `נכשל: ${r.err}` });
    }
  }
  if (!system) { /* no npm, no journal */ }
  else if (dry) steps.push({ name: 'npm cache', freed: 0, note: 'dry-run' });
  else { const r = await run('npm', ['cache', 'verify'], 5 * 60_000); steps.push({ name: 'npm cache', freed: 0, note: r.ok ? '' : r.err }); }

  if (!system) { /* see above */ }
  else if (dry) steps.push({ name: 'journal', freed: 0, note: 'dry-run' });
  else { const r = await run('journalctl', ['--user', `--vacuum-size=${JOURNAL_SIZE}`], 120_000); const m = /freed ([\d.]+[KMGT]?)/.exec(r.out + r.err); steps.push({ name: 'journal', freed: m ? parseBytes(`${m[1]}B`) ?? 0 : 0, note: r.ok ? '' : r.err }); }

  const closed = opts.closedTasks ? new Set(opts.closedTasks) : await closedFromDb(stateDir, now);
  if (!closed) steps.push({ name: '/tmp של משימות', freed: 0, note: 'לא ידוע אילו משימות פתוחות, מדלג' });
  else {
    const doomed = pickTmp(await tmpEntries(tmp, process.getuid?.() ?? 0), closed);
    let freed = 0;
    for (const name of doomed) {
      const p = join(tmp, name);
      freed += await duBytes(p);
      if (!dry) rmSync(p, { recursive: true, force: true });
    }
    steps.push({ name: '/tmp של משימות', freed: dry ? 0 : freed, note: `${doomed.length} תיקיות${dry ? ` (היו משחררות ${human(freed)})` : ''}: ${doomed.slice(0, 8).join(' ')}` });
  }

  const freed = dry ? 0 : Math.max(0, before - used(tmp));
  const result = { at: new Date(now).toISOString(), dry, freed, steps };
  if (!dry) {
    try {
      mkdirSync(stateDir, { recursive: true });
      appendFileSync(join(stateDir, 'disk-clean.log'), JSON.stringify(result) + '\n');
    } catch { /* the log is a record, not a condition */ }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const ki = argv.indexOf('--closed-tasks');
  const closedTasks = ki >= 0 ? (argv[ki + 1] ?? '').split(',').filter(Boolean).map(Number) : undefined;
  const r = await clean({ dryRun: argv.includes('--dry-run'), closedTasks });
  if (argv.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`ניקוי דיסק${r.dry ? ' (ניסיון, לא נמחק כלום)' : ''}: שוחררו ${human(r.freed)}`);
    for (const s of r.steps) console.log(`- ${s.name}: ${s.freed ? human(s.freed) : '0'}${s.note ? ` · ${s.note}` : ''}`);
  }
}
