// Hourly online backup of hq.db (B.11). The snapshot is SQLite's backup API (same as `sqlite3 .backup`), consistent
// under WAL; only then is it compressed with zstd, as `hq-<stamp>.db.zst`. Retention: the newest `hourly` backups, plus
// the newest backup of each of the `daily` most recent days (today included) that have one. 25/10: 48 raw hourly copies of a 600MB db
// were 24G of hq-host's disk; zstd makes one ~95MB.
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import Database from 'better-sqlite3';
import type { Store } from './store.ts';

export interface BackupPolicy { hourly: number; daily: number }

/** The hourly backups: `hq-2026-10-24T201046Z.db.zst` (and `.db`, uncompressed, from before 25/10). */
const HOURLY = /^hq-(\d{4}-\d{2}-\d{2})T\d{6}Z\.db(\.zst)?$/;
/** Any other backup of hq.db here, e.g. `hq-before-<tag>-<stamp>.db` from scripts/company-update.sh: the newest few stay. */
const OTHER = /^hq-.*\.db(\.zst)?$/;
const OTHER_KEEP = 3;
const ZSTD_LEVEL = 3; // measured on the 620MB hq.db: 94MB in ~2s; higher levels cost much more time for a few MB

/**
 * Task 1547: why hq "held 3.2GB" on 08/11 at 07:12 while its own heap was ~0.5GB. A file's page cache is charged to the cgroup
 * that reads it, and every hour this backup read all of hq.db (2.9GB), wrote a raw copy and read it again to compress: all of
 * it charged to hq's unit (memory.peak 4–9.6GB a run, swap peak under 250MB, so not the heap). With the machine short, hq then
 * waited on the reclaim of its own cache. `isolate`: the copy runs in a child process, in its own systemd scope with a
 * memory ceiling (backup-child.ts), so its cache is the scope's and is given back as it goes; and it is `VACUUM INTO`, which
 * leaves out the free pages (what the event prune frees), so the copy is the size of the data, not of the file.
 * No systemd here (CI, another machine): the same child without the scope. No file (a db in memory): in process, as before.
 */
export async function backupOnce(store: Store, dir: string, policy: BackupPolicy, opts: { isolate?: boolean } = {}): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = new Date(store.now()).toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z');
  const raw = join(dir, `.hq-${stamp}.db.tmp`);
  const out = join(dir, `hq-${stamp}.db.zst`);
  try {
    let file: string;
    if (opts.isolate && store.db.name && store.db.name !== ':memory:' && existsSync(store.db.name)) {
      await isolatedSnapshot(store.db.name, raw, out);
      file = out;
    } else {
      await store.db.backup(raw);
      chmodSync(raw, 0o600); // same privacy as hq.db
      file = await compress(raw, out);
    }
    await pruneBackups(dir, policy);
    store.setMeta('last_backup_at', String(store.now()));
    store.emit('backup.done', null, { file });
    return file;
  } finally {
    if (existsSync(raw)) unlinkSync(raw);
  }
}

const CHILD = join(dirname(fileURLToPath(import.meta.url)), 'backup-child.ts');
/** The child's ceiling: enough for SQLite's own cache and zstd, small next to the 2.9GB it reads. Past it the kernel takes back the
 *  child's clean cache first, which costs it little; the child goes slower, hq does not. */
export const CHILD_MEMORY_HIGH = '768M';
const CHILD_TIMEOUT_MS = 30 * 60_000;

/** backup-child.ts exits with this when it ran and failed: systemd-run passes the child's code through, its own failures are 1. */
export const CHILD_FAILED = 3;

/**
 * The snapshot and its compression in backup-child.ts, in a systemd scope of its own. Bare (in hq's cgroup, no ceiling) only when
 * systemd-run did not run the child at all (not installed, no user manager, the scope refused): a child that ran and failed is
 * that failure, reported as is, with no second run on top of what it left.
 */
async function isolatedSnapshot(db: string, raw: string, out: string): Promise<void> {
  const child = [process.execPath, CHILD, db, raw, out];
  const scoped = ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryHigh=${CHILD_MEMORY_HIGH}`, '-p', 'CPUWeight=20', '--', ...child];
  try {
    await run(scoped);
  } catch (e) {
    const err = e as Error & { code?: number | string };
    if (err.code === CHILD_FAILED || err.code === undefined || existsSync(raw) || existsSync(out)) throw e;
    await run(child);
  }
  if (!existsSync(out)) throw new Error(`backup child left no ${basename(out)}`);
}

function run([cmd, ...args]: string[]): Promise<void> {
  return new Promise((resolve, reject) => execFile(cmd!, args, { timeout: CHILD_TIMEOUT_MS, maxBuffer: 1 << 20 }, (e, _out, err) => {
    if (!e) return resolve();
    // `code`: the exit code, or 'ENOENT' when the command is not there; undefined = killed (the timeout): not a launch failure.
    const code = (e as { code?: number | string }).code;
    reject(Object.assign(new Error(`${basename(cmd!)}: ${String(err || e.message).trim().slice(0, 300)}`), { code: e.killed ? undefined : code }));
  }));
}

/** `src` → `out` (zstd), through a temp name so a half-written file never looks like a backup. Removes `src`. */
export async function compress(src: string, out: string): Promise<string> {
  const tmp = join(dirname(out), `.${basename(out)}.${randomBytes(4).toString('hex')}.tmp`); // its own: two runs never share one
  try {
    await pipeline(createReadStream(src), createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } }),
      createWriteStream(tmp, { mode: 0o600 }));
    renameSync(tmp, out);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
  gone(() => unlinkSync(src));
  return out;
}

/** Applies the policy to `dir`: deletes what it does not keep, compresses kept backups that are still raw `.db`, and
 *  removes leftovers (temp files of a run that died, `-wal`/`-shm` of a backup someone opened and that is gone). */
export async function pruneBackups(dir: string, policy: BackupPolicy): Promise<{ deleted: string[]; compressed: string[] }> {
  const names = readdirSync(dir);
  const deleted: string[] = [];
  const compressed: string[] = [];
  // hq's hourly run and a manual `backup-prune` may meet: a file the other one already took is not an error.
  const drop = (f: string) => { if (gone(() => unlinkSync(join(dir, f)))) deleted.push(f); };

  // Newest first; the stamp sorts as text. A `.db` and a `.db.zst` of the same hour count once (the .zst wins).
  const hourly = names.filter((f) => HOURLY.test(f)).sort().reverse();
  const seen = new Set<string>();
  const days = new Set<string>();
  const keep = new Set<string>();
  let hourlyKept = 0;
  for (const f of hourly) {
    const base = f.replace(/\.zst$/, '');
    if (seen.has(base)) { drop(f); continue; }
    seen.add(base);
    const day = HOURLY.exec(f)![1]!;
    const newestOfDay = !days.has(day); // newest first: the first one met of a day is its newest
    days.add(day);
    if (hourlyKept < policy.hourly) { hourlyKept++; keep.add(f); continue; }
    if (newestOfDay && days.size <= policy.daily) { keep.add(f); continue; }
    drop(f);
  }

  const mtime = (f: string) => { let t = 0; gone(() => { t = statSync(join(dir, f)).mtimeMs; }); return t; };
  const others = names.filter((f) => OTHER.test(f) && !HOURLY.test(f)).sort((a, b) => mtime(b) - mtime(a));
  for (const f of others.slice(OTHER_KEEP)) drop(f);
  for (const f of others.slice(0, OTHER_KEEP)) if (!f.endsWith('.zst')) keep.add(f);

  for (const f of keep) {
    if (f.endsWith('.zst') || existsSync(join(dir, `${f}.zst`))) continue;
    // A raw one written in the last 10 minutes may still be being written (company-update.sh's hq-before-*): next run.
    if (!existsSync(join(dir, f)) || Date.now() - statSync(join(dir, f)).mtimeMs < 10 * 60_000) continue;
    try { await compress(join(dir, f), join(dir, `${f}.zst`)); compressed.push(f); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }

  const present = new Set(readdirSync(dir));
  for (const f of present) {
    const orphan = /^(.*\.db)-(wal|shm|journal)$/.exec(f);
    // A temp file is someone's run in progress (hq's hourly one, while `backup-prune` runs) until it is an hour old.
    let stale = false;
    if (/^\.hq-.*\.tmp$/.test(f)) gone(() => { stale = Date.now() - statSync(join(dir, f)).mtimeMs > 60 * 60_000; });
    if ((orphan && !present.has(orphan[1]!)) || stale) drop(f);
  }
  return { deleted, compressed };
}

/** Runs `fn`; false when it failed only because the file is already gone. */
function gone(fn: () => void): boolean {
  try { fn(); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

/** Restores a backup (`.db.zst` or `.db`) to `out`, which must not exist, and checks that SQLite opens it whole
 *  (`PRAGMA integrity_check`). Leaves nothing at `out` when it fails. */
export async function restoreBackup(src: string, out: string): Promise<{ out: string; messages: number }> {
  if (existsSync(out)) throw new Error(`${out} already exists: restore to a new path`);
  const tmp = `${out}.restoring`;
  try {
    const input = createReadStream(src);
    await (src.endsWith('.zst')
      ? pipeline(input, createZstdDecompress(), createWriteStream(tmp, { mode: 0o600 }))
      : pipeline(input, createWriteStream(tmp, { mode: 0o600 })));
    const db = new Database(tmp, { readonly: true, fileMustExist: true });
    try {
      const check = db.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`integrity_check: ${String(check)}`);
      const messages = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
      db.close();
      renameSync(tmp, out);
      return { out, messages };
    } finally {
      if (db.open) db.close();
    }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (existsSync(f)) unlinkSync(f);
  }
}
