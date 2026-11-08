// The hourly snapshot of hq.db, out of hq's process (backup.ts isolatedSnapshot, task 1547): `VACUUM INTO` a raw copy on its
// own read-only connection (consistent under WAL, without the free pages), then zstd. What it reads and writes is this
// process's page cache, not hq's. Args: <db> <raw> <out>.
import { chmodSync } from 'node:fs';
import Database from 'better-sqlite3';
import { CHILD_FAILED, compress } from './backup.ts';

const [db, raw, out] = process.argv.slice(2);
if (!db || !raw || !out) {
  console.error('usage: backup-child.ts <db> <raw> <out>');
  process.exit(2);
}
try {
  const src = new Database(db, { readonly: true, fileMustExist: true });
  try {
    src.prepare('VACUUM INTO ?').run(raw);
  } finally {
    src.close();
  }
  chmodSync(raw, 0o600); // same privacy as hq.db
  await compress(raw, out);
} catch (e) {
  // A code of its own: backup.ts tells "the child ran and failed" (report it) from "systemd-run could not run it" (run it bare).
  console.error((e as Error).message);
  process.exit(CHILD_FAILED);
}
