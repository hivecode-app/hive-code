#!/usr/bin/env node
// `company db-copy`: a consistent copy of hq.db for a worker who needs one to write to (task 1531). On 07/11 two tasks
// left 2.4GB copies of hq.db in /tmp each, on a disk that reached 99%. Reading needs no copy at all:
//   sqlite3 "file:$HOME/.local/state/agent-company/hq.db?mode=ro"
// A copy goes to <state>/db-copies/<identity>/hq-<stamp>.db (SQLite's backup API, safe while hq runs). hq's leftovers-gc
// removes it when no open task has that identity, and after 48 hours in any case. Prints the path.
//
//   node scripts/hq-db-copy.mjs [--identity <id>]
import { mkdirSync, statfsSync, statSync, chmodSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

/** Room left after the copy: never take the last of the disk for a copy. */
export const RESERVE = 5 * 1024 ** 3;

export async function dbCopy({ state, identity, now = new Date(), free } = {}) {
  if (!identity || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(identity)) throw new Error('אין identity (COMPANY_IDENTITY או --identity)');
  const src = join(state, 'hq.db');
  const dir = join(state, 'db-copies', identity);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const need = statSync(src).size + RESERVE;
  const left = free ? free(dir) : (() => { const s = statfsSync(dir); return s.bavail * s.bsize; })();
  if (left < need) throw new Error(`אין מקום לעותק: צריך ${Math.ceil(need / 1024 ** 3)}GB (כולל ${RESERVE / 1024 ** 3}GB רזרבה), יש ${Math.floor(left / 1024 ** 3)}GB. לקריאה בלבד אין צורך בעותק: sqlite3 "file:${src}?mode=ro"`);
  const out = join(dir, `hq-${now.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z.db`);
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try { await db.backup(out); } catch (e) { rmSync(out, { force: true }); throw e; } finally { db.close(); }
  chmodSync(out, 0o600); // same privacy as hq.db
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--identity');
  const identity = i >= 0 ? argv[i + 1] : process.env.COMPANY_IDENTITY;
  const state = process.env.COMPANY_STATE_DIR || process.env.AGENT_COMPANY_STATE || join(homedir(), '.local', 'state', 'agent-company');
  dbCopy({ state, identity }).then((p) => console.log(p)).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
