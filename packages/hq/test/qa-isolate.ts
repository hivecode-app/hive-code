// A copy of a live hq.db, opened so that nothing in this process reaches anything live (qa-live-copy.mts,
// tested in qa-isolate.test.ts). The live file is only read: SQLite's online backup into a private temp dir
// (0700), removed by close() since the copy holds device tokens. In the copy, before hq starts:
// - its shifts are ended, and a socket outside its own temp dir is refused: the rows hold the live
//   shift-hosts' socket paths, and reattaching to them once sent a home-wake from a copy to עדי's live
//   shift (21/10);
// - no git on the live checkouts: the queue is off, no task keeps a worktree, and the worktree code throws
//   (finishing a task that is done in the copy would otherwise close a live worker's worktree);
// - no timers (scheduler, home sweep, watchdog, mailbox sweep, push), no account (the copy's are dropped),
//   no gh (tickets, issues, the memory PR), no foreign injection;
// - shifts the copy asks for go to makeEnv's fake launcher, in its temp dir; Telegram and push are fakes.
// The guard belongs in hq itself too (#163); until then this is the only way to open one.
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { makeEnv, type TestEnv } from './helpers.ts';
import { HostClient } from '../src/host-client.ts';

export interface IsolatedCopy { env: TestEnv; close(): Promise<void> }

export async function openIsolatedCopy(live: string, opts: { companyDir: string; realTime?: boolean; prepare?: (db: Database.Database) => void }): Promise<IsolatedCopy> {
  const dir = mkdtempSync(join(tmpdir(), 'hq-live-'));
  const copy = join(dir, 'hq.db');
  const src = new Database(live, { readonly: true, fileMustExist: true });
  await src.backup(copy);
  src.close();
  const db = new Database(copy);
  opts.prepare?.(db);
  db.exec(`UPDATE shifts SET state = 'ended' WHERE state IN ('starting', 'live'); DELETE FROM accounts;
    UPDATE tasks SET worktree = NULL; UPDATE toggles SET enabled = 0 WHERE key = 'scheduler'`);
  db.close();

  const refuse = (what: string) => () => { throw new Error(`qa copy: ${what} is off in a copy of the live hq`); };
  let own = '';
  const env = await makeEnv({ noStart: true, deps: {
    connect: (id, path) => {
      if (!own || !resolve(path).startsWith(own + sep)) throw new Error(`qa copy: ${path} is not this copy's socket`);
      return new HostClient(id, path);
    },
    foreign: { injectForeign: refuse('foreign injection') as never },
    ticketer: refuse('gh issue create'),
    issues: async () => [],
    memoryRun: refuse('git/gh for the memory PR') as never,
    accounts: { usage: refuse('account usage'), profile: refuse('account profile'), login: refuse('account login') },
  }, cfg: { dbPath: copy, companyDir: opts.companyDir } });
  own = resolve(env.dir);
  // A shift the copy starts is the fake launcher's, which never answers a ping: with the live interval it
  // reads "תקוע · לא עונה" on the board within a minute, about a worker who is fine (21/10, task 189).
  env.hq.cfg.timers.livenessMs = 24 * 3600_000;
  // The real time, before start so what it stamps is now: hq holds the clock's own now(), which reads t.
  if (opts.realTime) Object.defineProperty(env.clock, 't', { get: () => Date.now(), set: () => {} });
  const noGit = new Proxy({}, { get: (_, k) => (k === 'checkout' ? () => undefined : refuse(`git worktree (${String(k)})`)) }) as never;
  env.hq.scheduler.workspaces = noGit;
  env.hq.shifts.workspaces = noGit;
  await env.hq.start({ listen: false, timers: false });
  return { env, async close() { await env.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}
