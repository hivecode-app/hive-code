// A QA copy of a live hq (qa-isolate.ts) never reaches anything live: on a fake "live" db with a live shift
// whose socket listens, a task that is done in the copy with a worktree in a temp repo, a queued task and the
// queue on, opening the copy makes no socket connection, runs no git, and starts nothing from the queue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { makeEnv } from './helpers.ts';
import { openIsolatedCopy, type IsolatedCopy } from './qa-isolate.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });

test('a copy of the live hq: no live socket, no git on the checkouts, no queue', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'qa-isolate-'));
  // A live checkout with a live worker's worktree, in the project's charter, so the copy would find it.
  const repo = join(tmp, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a'), 'a');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'a');
  const wt = join(repo, '.worktrees', 'company-t5');
  git(repo, 'worktree', 'add', '-q', '-b', 'company-t5', wt);
  const before = [git(repo, 'worktree', 'list', '--porcelain'), git(repo, 'branch', '--list')];
  const charter = `---\nproject: agent-company\nstatus: active\nrepo: hivecode-app/hive-code\ncheckouts:\n  - name: agent-company\n    path: ${repo}\n    default_branch: main\nworktree_dir: .worktrees\n---\n\n# x\n`;
  const live = await makeEnv({ projects: { 'agent-company': charter } });
  // A live shift-host: counts who connects.
  const sock = join(tmp, 'live.sock');
  let connections = 0;
  const host = createServer((s) => { connections++; s.destroy(); });
  await new Promise<void>((r) => host.listen(sock, r));
  let copy: IsolatedCopy | undefined;
  try {
    const now = live.clock.now();
    const db = live.hq.store.db;
    db.prepare(`INSERT INTO shifts (id, identity, shift_no, state, kind, socket_path, started_at, last_event_at) VALUES ('ac-ceo-1', 'ac-ceo', 1, 'live', 'resident', ?, ?, ?)`).run(sock, now, now);
    db.prepare(`INSERT INTO tasks (id, project, title, state, worktree, identity, created_at, updated_at, started_at) VALUES (5, 'agent-company', 'done in the copy', 'running', ?, 'agent-company-t5', ?, ?, ?)`).run(wt, now, now, now);
    db.prepare(`INSERT INTO ops (id, identity, op, args, received_at, ack) VALUES ('op-done', 'agent-company-t5', 'status', '{"state":"done","summary":"x"}', ?, '{}')`).run(now + 1);
    db.prepare(`INSERT INTO tasks (id, project, title, state, created_at, updated_at) VALUES (6, 'agent-company', 'queued', 'queued', ?, ?)`).run(now, now);
    live.hq.store.setToggle('scheduler', true);
    const liveDb = join(live.dir, 'live.db');
    await new Database(live.cfg.dbPath).backup(liveDb);

    copy = await openIsolatedCopy(liveDb, { companyDir: join(live.dir, 'company') });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(connections, 0, 'no connection to the live shift-host');
    assert.ok(existsSync(wt), 'the live worktree is still there');
    assert.deepEqual([git(repo, 'worktree', 'list', '--porcelain'), git(repo, 'branch', '--list')], before, 'no git on the live checkout');
    const hq = copy.env.hq;
    assert.equal(hq.store.toggle('scheduler'), false, 'the queue is off');
    assert.equal((hq.store.db.prepare(`SELECT COUNT(*) AS n FROM shifts WHERE state IN ('starting', 'live')`).get() as { n: number }).n, 0);
    assert.equal(copy.env.launcher.launches.length, 0, 'nothing started');
    assert.throws(() => (hq.scheduler.workspaces as unknown as { create(): void }).create(), /git worktree/);
    // The live db is only read.
    const after = new Database(liveDb, { readonly: true });
    assert.equal((after.prepare(`SELECT state FROM shifts WHERE id = 'ac-ceo-1'`).get() as { state: string }).state, 'live');
    after.close();
  } finally {
    await copy?.close();
    host.close();
    await live.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  }
});
