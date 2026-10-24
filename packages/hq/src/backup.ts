// Hourly online backup of hq.db (B.11). The snapshot is SQLite's backup API (same as `sqlite3 .backup`), consistent
// under WAL; only then is it compressed with zstd, as `hq-<stamp>.db.zst`. Retention: the newest `hourly` backups, plus
// the newest backup of each of the `daily` most recent days (today included) that have one. 25/10: 48 raw hourly copies of a 600MB db
// were 24G of hq-host's disk; zstd makes one ~95MB.
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
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

export async function backupOnce(store: Store, dir: string, policy: BackupPolicy): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = new Date(store.now()).toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z');
  const raw = join(dir, `.hq-${stamp}.db.tmp`);
  try {
    await store.db.backup(raw);
    chmodSync(raw, 0o600); // same privacy as hq.db
    const file = await compress(raw, join(dir, `hq-${stamp}.db.zst`));
    await pruneBackups(dir, policy);
    store.setMeta('last_backup_at', String(store.now()));
    store.emit('backup.done', null, { file });
    return file;
  } finally {
    if (existsSync(raw)) unlinkSync(raw);
  }
}

/** `src` → `out` (zstd), through a temp name so a half-written file never looks like a backup. Removes `src`. */
async function compress(src: string, out: string): Promise<string> {
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
