// Hourly online backup of hq.db (B.11) — SQLite's backup API (same as `sqlite3 .backup`), safe under WAL.
import { chmodSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './store.ts';

export async function backupOnce(store: Store, dir: string, keep: number): Promise<string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const stamp = new Date(store.now()).toISOString().replace(/[:]/g, '').replace(/\..+/, 'Z');
  const file = join(dir, `hq-${stamp}.db`);
  await store.db.backup(file);
  chmodSync(file, 0o600); // same privacy as hq.db
  const all = readdirSync(dir).filter((f) => /^hq-.*\.db$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - keep))) unlinkSync(join(dir, f));
  store.setMeta('last_backup_at', String(store.now()));
  store.emit('backup.done', null, { file });
  return file;
}
