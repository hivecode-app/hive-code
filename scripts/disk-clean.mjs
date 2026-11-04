#!/usr/bin/env node
// Disk cleaning for a machine that runs tasks (task 382). On 22/10 the disk of hq-host hit 100% (273MB left) because docker
// had piled up 55GB of images and 43GB of build cache from smoke tests and task builds, and /tmp held another 7GB of
// finished tasks. Run daily by deploy/agent-company-disk-clean.timer, and by hq (disk-watch.ts) when the disk passes 85%,
// here and, over ssh, on the nodes.
//
//   node scripts/disk-clean.mjs [--dry-run] [--json] [--closed-tasks 3,7,12]
//
// It prunes docker build cache (6h) and unused images (24h), cuts to 0 a running container's log over 1GB, verifies the npm cache, trims the user journal to 300MB,
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
//
// Task 798: on 27/10 /tmp held 21GB in 38k entries, 6.9GB of it from the last day: leftovers of tests (hq-*, mcp-wal-*,
// mongo-mem-*), review and scratch files, and the caches claude-<uid>, tsx-<uid>, node-compile-cache. So any other entry
// directly in /tmp (and any entry directly inside those caches) goes too, when nothing in it changed for 24 hours (mtime and
// ctime of every file inside, not only of the directory: `tar x`, `cp -a` and `mv` keep an old mtime, not an old ctime) and
// nothing holds it: an open file, a cwd or a mapped file of a process we can read in /proc (ours; another user's are hidden
// from us), a bound unix socket, a mount point, or the source of a mount of a running docker container. Never a socket, a fifo
// or a symlink, never across a mount, never a dotted name (.X11-unix, .com.google.Chrome.*), never systemd-private-*, tmux-*,
// ssh-*, chrome or playwright, and never what belongs to another user. Each entry is checked again right before it goes.
// Without a believable /proc this step is skipped: not knowing who holds a file is not permission to delete it.
//
// Task 943: on 29/10 one container left running by a finished session (kcat reading a Kafka topic to stdout) wrote 28GB of
// json-file log in 16 hours, 1.7GB an hour, and took hq-host from 67% to 81%. docker keeps that log without a limit unless
// the daemon has log-opts, and those apply only to containers created after a restart of the daemon. So the log of a running
// container that passed 1GB is cut to 0 (`truncate`, as root through `sudo -n`, since the file is root's; docker keeps
// appending to it). The container keeps running: whether it should is not a question for a disk cleaner.
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DOCKER_BUILD_CACHE_AGE = '6h';
export const DOCKER_IMAGE_AGE = '24h';
export const JOURNAL_SIZE = '300M';
export const TMP_AGE_MS = 24 * 3600_000;
export const DOCKER_LOG_MAX = 1024 ** 3;

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

/** Never removed by age: what a live service or the system keeps in /tmp. Dotted names (.X11-unix, .ICE-unix, .com.google.Chrome.*) are skipped before this. */
const LIVE = /^(?:systemd-private-|snap-private-tmp$|tmux-|ssh-|dbus-|pulse-|lost\+found$)|chrom|playwright|puppeteer/i;

/** Caches that live sessions keep writing to as a whole; what is directly inside them is judged on its own. */
export const cacheDirs = (uid) => [`claude-${uid}`, `tsx-${uid}`, 'node-compile-cache'];

/**
 * May an entry directly in /tmp go by age at all (task 798), by its name. Task directories (t<N>, task-<N>, rev<N>, audit-*)
 * and the caches themselves are decided elsewhere; what a live service or the system keeps stays.
 */
export function byName(name, uid) {
  return !name.startsWith('.') && !LIVE.test(name) && !cacheDirs(uid).includes(name) && !NUMBERED.test(name) && !UNNUMBERED.test(name);
}

/**
 * Paths under `root` something holds: a process's cwd, root, exe, open files and mapped files (only processes we may read:
 * our own, or all as root), bound unix sockets, and mount points. null when /proc is missing or does not look like the
 * machine's (no pid 1, or too few processes, as in a pid namespace).
 */
export function heldUnder(root, proc = '/proc') {
  let pids;
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  if (!pids.includes('1') || pids.length < 20) return null;
  const out = new Set();
  const add = (p) => { if (p === root || p.startsWith(`${root}/`)) out.add(p.replace(/ \(deleted\)$/, '')); };
  for (const pid of pids) {
    const base = join(proc, pid);
    for (const l of ['cwd', 'root', 'exe']) { try { add(readlinkSync(join(base, l))); } catch { /* gone, or not ours */ } }
    try { for (const fd of readdirSync(join(base, 'fd'))) { try { add(readlinkSync(join(base, 'fd', fd))); } catch { /* closed meanwhile */ } } } catch { /* not ours */ }
    try { for (const line of readFileSync(join(base, 'maps'), 'utf8').split('\n')) { const i = line.indexOf('/'); if (i >= 0) add(line.slice(i)); } } catch { /* not ours */ }
  }
  try { for (const line of readFileSync(join(proc, 'net', 'unix'), 'utf8').split('\n').slice(1)) { const p = line.trim().split(/\s+/)[7]; if (p) add(p); } } catch { /* no sockets table */ }
  // mountinfo: "36 35 98:0 /mnt1 /mnt/parent rw ..." - the 5th field is the mount point, with spaces as \040
  try { for (const line of readFileSync(join(proc, 'self', 'mountinfo'), 'utf8').split('\n')) { const p = line.split(' ')[4]; if (p) add(p.replace(/\\040/g, ' ')); } } catch { return null; }
  return out;
}

/**
 * Sources under `root` that running docker containers mount: their processes are root's, hidden from us in /proc.
 * null when that cannot be known: `docker ps` failed, or a container has all of `root` (its own sockets and files there are
 * invisible from here).
 */
async function dockerHeld(root, docker) {
  const ps = await run(docker, ['ps', '-q'], 30_000);
  if (!ps.ok) return null;
  const ids = ps.out.split('\n').filter(Boolean);
  if (!ids.length) return [];
  // a container that exited meanwhile fails inspect; the others still print
  const r = await run(docker, ['inspect', '--format', '{{range .Mounts}}{{.Source}}\n{{end}}', ...ids], 30_000);
  if (!r.ok && !r.out.trim()) return null;
  const sources = r.out.split('\n').filter(Boolean);
  if (sources.some((p) => p === root || p === '/' || root.startsWith(`${p}/`))) return null; // all of root, or above it
  return sources.filter((p) => p.startsWith(`${root}/`));
}

const isHeld = (path, held) => { for (const h of held) if (h === path || h.startsWith(`${path}/`)) return true; return false; };

/**
 * Walks `path`: null (keep) if it or anything inside changed after `since` (mtime or ctime), sits on another filesystem
 * than `dev`, or cannot be read; else its size.
 */
function quietSize(path, since, dev) {
  let st;
  try { st = lstatSync(path); } catch { return null; }
  if (Math.max(st.mtimeMs, st.ctimeMs) > since || st.dev !== dev) return null;
  let size = st.blocks * 512;
  if (st.isDirectory()) {
    let names;
    try { names = readdirSync(path); } catch { return null; }
    for (const n of names) { const s = quietSize(join(path, n), since, dev); if (s === null) return null; size += s; }
  }
  return size;
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

/** Cuts to 0 the json-file log of every running container whose log passed DOCKER_LOG_MAX (task 943). */
async function capLogs(docker, sudo) {
  const name = 'docker logs';
  const ps = await run(docker, ['ps', '-q'], 30_000);
  if (!ps.ok) return { name, freed: 0, note: `docker ps נכשל: ${ps.err}` };
  const ids = ps.out.split('\n').filter(Boolean);
  if (!ids.length) return { name, freed: 0, note: 'אין קונטיינרים רצים' };
  const r = await run(docker, ['inspect', '--format', '{{.Name}}\t{{.LogPath}}', ...ids], 30_000);
  if (!r.ok && !r.out.trim()) return { name, freed: 0, note: `docker inspect נכשל: ${r.err}` };
  let freed = 0;
  const cut = [];
  const unread = r.ok ? [] : [`inspect (${r.err})`]; // a container gone since ps fails inspect; the others still print
  const uncut = [];
  for (const line of r.out.split('\n').filter(Boolean)) {
    const [cname, path] = line.split('\t');
    if (!path) continue; // a log driver other than json-file has no file here
    const st = await run(sudo, ['-n', 'stat', '-c', '%s', path], 30_000);
    const out = st.out.trim();
    if (!st.ok || !/^\d+$/.test(out)) { unread.push(`${cname} (${st.err || 'אין גודל'})`); continue; }
    const size = Number(out);
    if (size <= DOCKER_LOG_MAX) continue;
    const t = await run(sudo, ['-n', 'truncate', '-s', '0', path], 30_000);
    if (!t.ok) { uncut.push(`${cname} ${human(size)} (${t.err})`); continue; }
    freed += size;
    cut.push(`${cname} ${human(size)}`);
  }
  const list = (a) => `${a.slice(0, 4).join(', ')}${a.length > 4 ? ` ועוד ${a.length - 4}` : ''}`;
  const note = [
    cut.length ? `נחתכו: ${cut.join(', ')}` : `אין לוג מעל ${human(DOCKER_LOG_MAX)} שנחתך`,
    uncut.length ? `לא נחתכו: ${list(uncut)}` : '',
    unread.length ? `לא נבדקו: ${list(unread)}` : '',
  ].filter(Boolean).join(' · ');
  return { name, freed, note };
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
    steps.push(dry ? { name: 'docker logs', freed: 0, note: 'dry-run' } : await capLogs(docker, opts.sudoBin ?? 'sudo'));
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

  const uid = process.getuid?.() ?? 0;
  const proc = opts.proc ?? '/proc';
  let why = '';
  const holders = async () => {
    const h = opts.proc === null ? null : heldUnder(tmp, proc);
    if (!h) { why = 'אין /proc של המכונה, לא ידוע מי מחזיק קבצים, מדלג'; return null; }
    if (!hasDocker || !info.ok) return h;
    const d = await dockerHeld(tmp, docker);
    if (!d) { why = 'לא ידוע מה קונטיינרים של docker מחזיקים ב-/tmp, מדלג'; return null; }
    for (const p of d) h.add(p);
    return h;
  };
  let held = await holders();
  if (!held) steps.push({ name: '/tmp ישן', freed: 0, note: why });
  else {
    const since = now - TMP_AGE_MS;
    const dev = lstatSync(tmp).dev;
    const sizes = new Map();
    /** The quiet entries of `dir` that `keep(name)` lets through, as paths relative to /tmp. */
    const look = (dir, prefix, keep) => {
      let names;
      try { names = readdirSync(dir); } catch { return []; }
      const out = [];
      for (const name of names) {
        if (!keep(name)) continue; // by name first: no walk over what stays anyway
        const p = join(dir, name);
        let st;
        try { st = lstatSync(p); } catch { continue; }
        if (st.uid !== uid || !(st.isDirectory() || st.isFile()) || isHeld(p, held)) continue;
        const size = quietSize(p, since, dev);
        if (size === null) continue;
        sizes.set(`${prefix}${name}`, size);
        out.push(`${prefix}${name}`);
      }
      return out;
    };
    const doomed = look(tmp, '', (n) => byName(n, uid));
    for (const c of cacheDirs(uid)) {
      const st = (() => { try { return lstatSync(join(tmp, c)); } catch { return null; } })();
      if (!st?.isDirectory() || st.uid !== uid) continue;
      doomed.push(...look(join(tmp, c), `${c}/`, () => true)); // inside a cache everything is the cache's own
    }
    // The walk took a while: who holds what, and what changed, again right before each removal.
    const again = await holders();
    if (!again) doomed.length = 0; // went unknown meanwhile: nothing is known to be free
    else held = again;
    let freedQ = 0;
    const removed = [];
    let failed = 0;
    let firstErr = '';
    for (const rel of doomed) {
      const p = join(tmp, rel);
      if (isHeld(p, held) || quietSize(p, since, dev) === null) continue;
      if (!dry) { try { rmSync(p, { recursive: true, force: true }); } catch (e) { failed++; firstErr ||= e.code ?? String(e); continue; } }
      freedQ += sizes.get(rel) ?? 0;
      removed.push(rel);
    }
    steps.push({ name: '/tmp ישן', freed: dry ? 0 : freedQ, note: `${removed.length} פריטים שלא השתנו 24 שעות ואין להם מחזיק${again ? '' : ` (${why})`}${failed ? `, ${failed} לא נמחקו עד הסוף (${firstErr})` : ''}${dry ? ` (היו משחררים ${human(freedQ)})` : ''}: ${removed.slice(0, 8).join(' ')}` });
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

/** New installs clean only incomplete daily snapshots left by their own dead backup process. */
export function cleanCompany(stateDir, now = Date.now()) {
  const root = join(stateDir, 'daily-backups');
  const removed = [];
  if (!existsSync(root)) return { removed };
  for (const name of readdirSync(root)) {
    const match = /^\.\d{4}-\d{2}-\d{2}-(\d+)$/.exec(name);
    if (!match) continue;
    const path = join(root, name), info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || now - info.mtimeMs < 86_400_000) continue;
    try { process.kill(Number(match[1]), 0); continue; } catch (e) { if (e.code !== 'ESRCH') continue; }
    rmSync(path, { recursive: true }); removed.push(name);
  }
  return { removed };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const ki = argv.indexOf('--closed-tasks');
  const closedTasks = ki >= 0 ? (argv[ki + 1] ?? '').split(',').filter(Boolean).map(Number) : undefined;
  if (argv.includes('--company-only')) {
    console.log(JSON.stringify(cleanCompany(process.env.AGENT_COMPANY_STATE || join(homedir(), '.local/state/agent-company'))));
    process.exit(0);
  }
  const r = await clean({ dryRun: argv.includes('--dry-run'), closedTasks });
  if (argv.includes('--json')) console.log(JSON.stringify(r));
  else {
    console.log(`ניקוי דיסק${r.dry ? ' (ניסיון, לא נמחק כלום)' : ''}: שוחררו ${human(r.freed)}`);
    for (const s of r.steps) console.log(`- ${s.name}: ${s.freed ? human(s.freed) : '0'}${s.note ? ` · ${s.note}` : ''}`);
  }
}
