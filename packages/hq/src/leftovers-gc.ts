// What tasks leave on the disk after they close (task 1531). On 07/11 the disk of hq-host reached 99%: lumo's
// .worktrees held 58 worktrees, 52GB. hq's own close (scheduler.closeWorktree, B.5) had worked: of 41 that were removed
// by hand, one was a task's. The rest were worktrees workers opened themselves (standing workers' tamar-*, asaf-*, a task
// that opened ten more, t990-*), which no task row names, so nothing ever closed them. Two copies of hq.db (2.4GB each)
// sat in /tmp too. Now, every hour, for every checkout of every charter on this machine:
//   - a worktree in <checkout>/<worktree_dir> that no task holds (a task's own is closed when the task is), that nothing
//     changed for 24 hours and that no process has as its cwd, is closed like a task's: uncommitted work to
//     refs/company/preserved/<name>, then `git worktree remove` without --force (Workspaces.close);
//   - what is left and should not be (a close that failed, a locked worktree, a directory there that is not a
//     worktree, a task resting or interrupted with no activity for 7 days) is one message to the automation's owner,
//     again only when that list grows: never a silent leftover;
//   - copies of hq.db made with `company db-copy` (state/db-copies/<identity>/) go when no open task has that identity,
//     or after 48 hours.
// The automation is `leftovers-gc` in org.yaml; off, nothing is read and nothing is removed.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Hq } from './hq.ts';
import { readCharter, runGit, type Charter, type Git, type Workspaces } from './workspace.ts';

export const AUTOMATION = 'leftovers-gc';
/** A worktree nobody holds goes after this long with no change (its top dir, index, HEAD or reflog). */
export const ORPHAN_QUIET_MS = 24 * 3600_000;
/** A task resting or interrupted this long with no change is reported (its worktree is kept: the task may come back). */
export const STALE_TASK_MS = 7 * 24 * 3600_000;
/** A copy of hq.db is kept at most this long, even while its task is open. */
export const DB_COPY_MAX_MS = 48 * 3600_000;
export const DB_COPIES = 'db-copies';

export interface WorktreeEntry { path: string; branch: string | null; locked: boolean; prunable: boolean }

/** `git worktree list --porcelain` → its linked worktrees (the first block, the main checkout, is left out). */
export function parseWorktreeList(out: string): WorktreeEntry[] {
  const blocks = out.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  return blocks.slice(1).map((b) => {
    const lines = b.split('\n');
    const get = (k: string) => lines.find((l) => l === k || l.startsWith(`${k} `));
    const branch = get('branch')?.slice('branch '.length).replace(/^refs\/heads\//, '') ?? null;
    return { path: get('worktree')!.slice('worktree '.length), branch, locked: !!get('locked'), prunable: !!get('prunable') };
  }).filter((w) => !!w.path);
}

/**
 * The last change git or a worker made in a worktree: its top dir, its admin dir's index, HEAD and reflog, and `files`
 * (relative): what `git status` shows changed or untracked, and the ignored entries (.env, a local db, node_modules), so
 * an edit deep inside that was never committed counts as activity.
 */
export function lastActivity(path: string, files: string[] = []): number {
  let t = 0;
  const see = (p: string) => { try { t = Math.max(t, lstatSync(p).mtimeMs); } catch { /* not there */ } };
  see(path);
  for (const f of files) see(join(path, f));
  try {
    const m = /^gitdir: (.+)$/m.exec(readFileSync(join(path, '.git'), 'utf8'));
    if (m) { const admin = resolve(path, m[1]!.trim()); for (const f of ['index', 'HEAD', join('logs', 'HEAD')]) see(join(admin, f)); }
  } catch { /* no .git file */ }
  return t;
}

/** The cwd of every process we may read. null when /proc does not look like the machine's: not knowing is not "free". */
export function processCwds(proc = '/proc'): string[] | null {
  let pids: string[];
  try { pids = readdirSync(proc).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  if (!pids.includes('1') || pids.length < 20) return null;
  const out: string[] = [];
  for (const pid of pids) { try { out.push(readlinkSync(join(proc, pid, 'cwd'))); } catch { /* gone, or not ours */ } }
  return out;
}

/** `git status --porcelain -z` and `ls-files -z` output → the paths in it (a rename's old path too: it just won't stat). */
export function zPaths(out: string, status: boolean): string[] {
  return out.split('\0').filter(Boolean).map((e) => (status && /^[ MADRCUT?!]{2} /.test(e) ? e.slice(3) : e));
}

const under = (p: string, dir: string) => p === dir || p.startsWith(`${dir}/`);

export interface Problem { kind: 'close_failed' | 'locked' | 'not_worktree' | 'stale_task'; path: string; detail: string }
export interface Removed { path: string; branch: string | null; branchDeleted: boolean; preserved: string | null; ignored: string[] }
export interface SweepResult { removed: Removed[]; problems: Problem[]; dbCopies: string[]; skipped: string[] }

export class LeftoversGc {
  private hq: Hq;
  /** Replaced in tests. */
  git: Git = runGit;
  cwds: () => string[] | null = () => processCwds();
  host = hostname();
  constructor(hq: Hq) { this.hq = hq; }

  /** The identity whose org.yaml automations hold `leftovers-gc`; null = no such automation. */
  owner(): string | null {
    const r = this.hq.store.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean {
    const o = this.owner();
    return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`);
  }

  private charters(): Charter[] {
    const dir = join(this.hq.cfg.companyDir, 'projects');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((f) => f.endsWith('.md')).sort()
      .map((f) => readCharter(this.hq.cfg.companyDir, f.slice(0, -3)))
      .filter((c): c is Charter => !!c && c.status !== 'invalid' && (!c.machine || c.machine === this.host));
  }

  private get workspaces(): Workspaces { return this.hq.scheduler.workspaces; }

  private running: Promise<SweepResult | null> | null = null;

  /** One sweep at a time (the hourly timer and disk-watch at 85% may meet): a second caller gets the running one. */
  sweep(): Promise<SweepResult | null> {
    if (this.running) return this.running;
    this.running = this.sweepOnce().finally(() => { this.running = null; });
    return this.running;
  }

  /** What changed in a worktree that git keeps no time of: dirty and untracked files, and the ignored entries. */
  private async touched(path: string): Promise<string[]> {
    // GIT_OPTIONAL_LOCKS=0: no index refresh, or this very look would write the index and count as activity.
    const status = await this.git(path, ['status', '--porcelain', '-z', '--untracked-files=all'], { GIT_OPTIONAL_LOCKS: '0' }).catch(() => '');
    const ignored = await this.git(path, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']).catch(() => '');
    return [...zPaths(status, true), ...zPaths(ignored, false)];
  }

  private async sweepOnce(): Promise<SweepResult | null> {
    if (!this.enabled()) return null;
    const res: SweepResult = { removed: [], problems: [], dbCopies: [], skipped: [] };
    const cwds = this.cwds();
    if (!cwds) res.skipped.push('אין /proc של המכונה: לא ידוע מי עובד באיזה worktree, לא הוסר כלום');
    const now = this.hq.store.now();
    const { db } = this.hq.store;
    const taskOf = db.prepare(`SELECT id, state, updated_at FROM tasks WHERE worktree = ? ORDER BY id DESC LIMIT 1`);
    const openTask = db.prepare(`SELECT 1 FROM tasks WHERE id = ? AND state != 'done'`);
    const seen = new Set<string>();
    for (const ch of this.charters()) {
      for (const c of ch.checkouts) {
        const wtDir = join(c.path, ch.worktreeDir);
        if (seen.has(wtDir) || !existsSync(join(c.path, '.git')) || !existsSync(wtDir)) continue;
        seen.add(wtDir);
        let list: WorktreeEntry[];
        try {
          await this.git(c.path, ['worktree', 'prune']); // records of directories that are gone
          list = parseWorktreeList(await this.git(c.path, ['worktree', 'list', '--porcelain']));
        } catch (e) { res.skipped.push(`${c.path}: ${(e as Error).message.slice(0, 200)}`); continue; }
        const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
        const mine = list.filter((w) => dirname(real(w.path)) === real(wtDir));
        const known = new Set(mine.map((w) => real(w.path)));
        for (const name of readdirSync(wtDir)) {
          const p = join(wtDir, name);
          let st; try { st = lstatSync(p); } catch { continue; }
          if (st.isDirectory() && !known.has(real(p))) res.problems.push({ kind: 'not_worktree', path: p, detail: 'תיקייה ב-worktree_dir שאינה worktree של ה-checkout (clone נפרד? משהו שנשאר מהסרה ידנית?)' });
        }
        for (const w of mine) {
          const t = taskOf.get(w.path) as { id: number; state: string; updated_at: number } | undefined;
          const quiet = now - lastActivity(w.path, t ? [] : await this.touched(w.path)) >= ORPHAN_QUIET_MS;
          // A done task's worktree is the scheduler's to close (retryCloses, every 10 minutes): here it is only reported
          // when that keeps failing, so the two never close the same tree side by side.
          if (t?.state === 'done') {
            if (now - t.updated_at >= 3600_000) res.problems.push({ kind: 'close_failed', path: w.path, detail: `משימה #${t.id} נסגרה ו-hq לא מצליח להסיר (האירוע \`task.worktree_close_failed\`)` });
            continue;
          }
          if (t) {
            if (['resting', 'interrupted'].includes(t.state) && now - t.updated_at >= STALE_TASK_MS && quiet) {
              res.problems.push({ kind: 'stale_task', path: w.path, detail: `משימה #${t.id} ב-${t.state} ${Math.floor((now - t.updated_at) / 86_400_000)} ימים: ה-worktree נשמר עד שהיא נסגרת` });
            }
            continue;
          }
          // A task that opened one more worktree by hand, often in another checkout (company-t868 in west-depot for a
          // task in a library repo, t990-* in lumo): kept while that task is open.
          const n = /(?:^|[-_])t(\d+)(?=$|[-_])/.exec(w.path.split('/').pop()!)?.[1];
          if (!t && n && openTask.get(Number(n))) continue;
          if (w.locked) { res.problems.push({ kind: 'locked', path: w.path, detail: 'נעול (`git worktree lock`): לא מסירים' }); continue; }
          if (!cwds || !quiet || cwds.some((d) => under(d, w.path))) continue;
          // A worker's own branch (tamar-x on tamar-x) is never deleted here, even with nothing beyond main: only company-*.
          const r = await this.workspaces.close(w.path, c.defaultBranch, !w.branch?.startsWith('company-'));
          if (r.removed) res.removed.push({ path: w.path, branch: w.branch, branchDeleted: r.branchDeleted, preserved: r.preserved, ignored: r.ignored });
          else if (r.error !== 'missing') res.problems.push({ kind: 'close_failed', path: w.path, detail: (r.error ?? '').slice(0, 300) });
        }
      }
    }
    res.dbCopies = this.sweepDbCopies(now);
    this.hq.store.emit('leftovers.swept', null, res);
    this.report(res.problems, res.removed);
    return res;
  }

  /** state/db-copies/<identity>/: gone when no open task has that identity (and it is quiet for an hour), or after 48h. */
  private sweepDbCopies(now: number): string[] {
    const root = join(this.hq.cfg.stateDir, DB_COPIES);
    if (!existsSync(root)) return [];
    const open = this.hq.store.db.prepare(`SELECT 1 FROM tasks WHERE identity = ? AND state != 'done' LIMIT 1`);
    const removed: string[] = [];
    for (const who of readdirSync(root)) {
      const dir = join(root, who);
      let files: string[]; try { files = readdirSync(dir); } catch { continue; }
      for (const f of files) {
        const p = join(dir, f);
        let st; try { st = lstatSync(p); } catch { continue; }
        const age = now - st.mtimeMs;
        if (age < DB_COPY_MAX_MS && (open.get(who) || age < 3600_000)) continue;
        try { rmSync(p, { recursive: true, force: true }); removed.push(`${who}/${f}`); }
        catch (e) { this.hq.store.emit('leftovers.db_copy_failed', null, { path: p, error: (e as Error).message.slice(0, 200) }); }
      }
      try { if (!readdirSync(dir).length) rmSync(dir, { recursive: true }); } catch { /* gone meanwhile */ }
    }
    return removed;
  }

  /**
   * One message to the owner when worktrees were removed (where the work went, what went unsaved) or a leftover is new
   * since the last report; the leftovers list is the whole current one.
   */
  private report(problems: Problem[], removed: Removed[]): void {
    const key = (p: Problem) => `${p.kind}:${p.path}`;
    const before = new Set(JSON.parse(this.hq.store.getMeta('leftovers_gc.reported') ?? '[]') as string[]);
    this.hq.store.setMeta('leftovers_gc.reported', JSON.stringify(problems.map(key)));
    const owner = this.owner();
    const fresh = problems.some((p) => !before.has(key(p)));
    if (!owner || (!fresh && !removed.length)) return;
    const label: Record<Problem['kind'], string> = { close_failed: 'לא הוסר', locked: 'נעול', not_worktree: 'לא worktree', stale_task: 'משימה תקועה' };
    const list = createHash('sha1').update([...problems.map(key), ...removed.map((r) => r.path)].join('\n')).digest('hex').slice(0, 10);
    const gone = removed.slice(0, 30).map((r) => `- \`${r.path}\` · ענף ${!r.branch ? 'אין (detached)' : r.branchDeleted ? `\`${r.branch}\` נמחק (לא היה בו commit מעבר לענף הראשי)` : `\`${r.branch}\` נשאר`}`
      + `${r.preserved ? ` · עבודה שלא קומטה ב-\`${r.preserved}\`` : ''}${r.ignored.length ? ` · נמחקו בלי שמירה (ignored): ${r.ignored.slice(0, 5).map((f) => `\`${f}\``).join(', ')}${r.ignored.length > 5 ? ` ועוד ${r.ignored.length - 5}` : ''}` : ''}`);
    this.hq.mailbox.tell({ msg_id: `leftovers-gc-${this.hq.store.now()}-${list}`, from: 'hq', to: owner, priority: 'next', body: [
      removed.length ? `הוסרו ${removed.length} worktrees שאף משימה לא החזיקה ולא השתנו 24 שעות. אם מישהו עוד צריך אחד מהם: \`git worktree add <נתיב> <ענף>\`, ואת מה שלא קומט מחזירים מה-ref.` : '',
      ...gone,
      removed.length > 30 ? `ועוד ${removed.length - 30}.` : '',
      problems.length ? `${removed.length ? '\n' : ''}שאריות של משימות שהאיסוף לא מסיר לבד, ותופסות מקום בדיסק. צריך להחליט עליהן (לסגור את המשימה, להסיר ביד אחרי שמירה, או להשאיר):` : '',
      ...problems.slice(0, 30).map((p) => `- ${label[p.kind]} · \`${p.path}\` · ${p.detail}`),
      problems.length > 30 ? `ועוד ${problems.length - 30}.` : '',
      problems.length ? 'על הרשימה הזו הודעה חדשה תגיע רק כשיתווסף לה משהו.' : '',
    ].filter(Boolean).join('\n') });
  }
}
