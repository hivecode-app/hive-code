// The scheduler is code, not an LLM (A.2(8), B.5, B.16). It:
//  - fills every free work slot from the queue immediately, in B.16 order, with no quota-percentage gate;
//  - escalates unanswered blocking asks to the manager (A.4: 10 min by day, immediately at night);
//  - lets night.ts (B.16) scope the queue, add the night note and measure empty slots after every fill.
import { g, pre } from '@company/shared';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import { waitingLine, type Mailbox } from './mailbox.ts';
import { ShiftBusyError, type ShiftManager } from './shifts.ts';
import { ensureRuntimeIdentity, getIdentity, isStandingWorker, projectLead, taskWorkerName } from './org.ts';
import { HELPER_TEAM, taskSteps } from './system-prompt.ts';
import { memInfoMb } from './proc.ts';
import { dirname, join } from 'node:path';
import { noWorkers, readCharter, Workspaces, type CloseResult } from './workspace.ts';

export interface TaskRow {
  id: number; ref: string | null; project: string | null; title: string; body: string; source: string; state: string;
  labels: string; priority: number; night_weight: number; worktree: string | null; carried_over: number;
  identity: string | null; shift_id: string | null; created_at: number; updated_at: number; started_at: number | null;
  /** One line in his words on what it did, written when it closed (status done / close_team); null = none given. */
  summary?: string | null;
  /** "מה לבדוק" (awaiting.ts): deploy | check, with one line in his words; null = nothing waits. */
  awaiting?: string | null; awaiting_note?: string | null; awaiting_at?: number | null; pr?: string | null;
}

export interface NewTask {
  ref?: string; project?: string; title: string; body?: string; source?: 'store' | 'github'; state?: string;
  labels?: string[]; priority?: number; night_weight?: number; worktree?: string; identity?: string;
}

/** B.5: work_slots = floor((RAM − 4GB reserve − residents × RSS_idle) / RSS_work). RSS values are placeholders until measured. */
export function capacity(cfg: HqConfig, mem: { totalMb: number; availableMb: number }, running: number, residentsLive: number) {
  const { reserveMb, rssIdleMb, rssWorkMb, maxSlots } = cfg.capacity;
  const total = Math.max(0, Math.min(maxSlots, Math.floor((mem.totalMb - reserveMb - residentsLive * rssIdleMb) / rssWorkMb)));
  // Never start more than the memory that is actually free right now can hold.
  const byAvailable = Math.max(0, Math.floor((mem.availableMb - reserveMb) / rssWorkMb));
  const free = Math.max(0, Math.min(total - running, byAvailable));
  return { total, running, free };
}

// B.16 queue order: 1 open/interrupted with a worktree · 2 left over from last night · 3 `company:night` by priority then age ·
// 4 everything else without `needs-decision`, by priority, project night_weight, age.
const QUEUE_SQL = `
  SELECT t.*,
    CASE
      WHEN t.state IN ('open','interrupted') AND t.worktree IS NOT NULL THEN 1
      WHEN t.carried_over = 1 THEN 2
      WHEN EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = 'company:night') THEN 3
      ELSE 4
    END AS bucket
  FROM tasks t
  WHERE t.state IN ('queued','open','interrupted')
    AND NOT EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = 'needs-decision')
    AND (t.state = 'queued' OR t.worktree IS NOT NULL)
    AND (@scope IS NULL OR t.project IN (SELECT value FROM json_each(@scope)))
  ORDER BY bucket, t.priority, CASE WHEN bucket = 4 THEN -t.night_weight ELSE 0 END, t.created_at, t.id`;

/**
 * SQL over tasks t JOIN identities i: t is the task a standing worker (org.ts isStandingWorker) is on now. close_team
 * finds it by the worker's identity or name.
 */
const STANDING_TASK = `(i.source = 'org' AND i.active = 1 AND i.team_kind != 'task' AND i.lifecycle NOT IN ('lead','resident') AND i.id != @mgr
  AND (t.state IN ('running','resting') OR (t.state IN ('open','interrupted') AND t.started_at IS NOT NULL)))`;

/** Label on a standing worker's task that close_team is closing: the time it was asked for its handoff. */
const CLOSING = 'closing-at:';

export class Scheduler {
  memInfo: () => { totalMb: number; availableMb: number } = memInfoMb;
  /** Night mode (night.ts) plugs in here: the scope filter, a note for every task prompt, and a look after each fill. */
  scope: () => string[] | null = () => null;
  promptNote: () => string | null = () => null;
  afterFill: () => void = () => {};
  /** Worktrees per task in the project's checkout (B.5). Tests swap in one over a temp repo. */
  workspaces = new Workspaces();

  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private mailbox: Mailbox;
  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, mailbox: Mailbox) {
    this.store = store;
    this.cfg = cfg;
    this.shifts = shifts;
    this.mailbox = mailbox;
    // A slot frees the moment a shift ends: fill it now, don't wait for the next sweep.
    shifts.on('ended', (row, reason) => {
      if (row.task_id != null) this.onTaskShiftEnded(row.task_id, reason);
      // A failed launch frees nothing: refilling on it would spin (start → fail → ended → fill → …).
      if (row.kind === 'work' && reason !== 'launch_failed' && reason !== 'account_switch') this.store.bg(this.fill(), 'scheduler.fill');
    });
    // A resting task worker woken by a message is working on its task again.
    shifts.on('live', (row) => {
      if (row.task_id == null) return;
      const t = this.task(row.task_id);
      // A standing worker woken on its interrupted task (shifts.request binds it) is back on it too.
      if (t && (t.state === 'resting' || (t.state === 'interrupted' && this.standing(row.identity)))) this.setTaskState(t.id, 'running');
    });
  }

  addTask(t: NewTask): TaskRow {
    // project becomes part of identity ids, unit names and paths: keep it to a safe slug.
    if (t.project != null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(t.project)) throw new Error(`invalid project ${t.project}`);
    const now = this.store.now();
    if (t.ref) {
      const ex = this.store.db.prepare('SELECT * FROM tasks WHERE ref = ?').get(t.ref) as TaskRow | undefined;
      if (ex) return ex;
    }
    const r = this.store.db.prepare(`INSERT INTO tasks (ref, project, title, body, source, state, labels, priority, night_weight, worktree, identity, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.ref ?? null, t.project ?? null, t.title, t.body ?? '', t.source ?? 'store',
      t.state ?? 'queued', JSON.stringify(t.labels ?? []), t.priority ?? 2, t.night_weight ?? 1, t.worktree ?? null, t.identity ?? null, now, now);
    const task = this.task(Number(r.lastInsertRowid))!;
    this.store.emit('task.new', task.identity, task);
    // After the caller's transaction (ingest applies ops inside one), never inside it.
    queueMicrotask(() => this.store.bg(this.fill(), 'scheduler.fill'));
    return task;
  }

  task(id: number): TaskRow | undefined {
    return this.store.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  tasks(): TaskRow[] {
    return this.store.db.prepare(`SELECT * FROM tasks ORDER BY CASE WHEN state IN ('done') THEN 1 ELSE 0 END, updated_at DESC LIMIT 500`).all() as TaskRow[];
  }

  setTaskState(id: number, state: string): void {
    this.store.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, this.store.now(), id);
    this.store.emit('task.state', null, { id, state });
  }

  queue(): (TaskRow & { bucket: number })[] {
    const scope = this.scope();
    return this.store.db.prepare(QUEUE_SQL).all({ scope: scope ? JSON.stringify(scope) : null }) as (TaskRow & { bucket: number })[];
  }

  slots() {
    // A task still in its worktree setup has no shift row yet, but its slot is taken.
    const running = (this.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND kind = 'work'`).get() as { n: number }).n
      + this.starting.size;
    const residents = (this.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND kind = 'resident'`).get() as { n: number }).n;
    return capacity(this.cfg, this.memInfo(), running, Math.max(residents, this.cfg.capacity.residents.length));
  }

  private filling: Promise<number[]> | null = null;
  private refill = false;
  private lastStartAt = new Map<number, number>();
  /** The last launch error, for the empty-slot reason (B.16). Cleared by the next successful start. */
  lastStartError: string | null = null;

  /** A task that just started (and crashed or failed to launch) waits taskRetryMs before the next try. */
  inBackoff(id: number): boolean {
    return this.store.now() - (this.lastStartAt.get(id) ?? -Infinity) < this.cfg.timers.taskRetryMs;
  }

  /**
   * Tasks whose start is in flight (worktree, commands.worktree_setup, launch): never picked twice, and their
   * slot is taken (slots()), so a slow setup (`flutter pub get`) holds only its own task, not the queue. It
   * overlaps the new shift row briefly: never too many, and the pass after the starts settle fills what it hid.
   */
  private starting = new Set<number>();

  /** A queued task whose start is under way (the night's empty-slot metric does not count it as waiting). */
  isStarting(id: number): boolean { return this.starting.has(id); }

  /**
   * Fill free slots from the queue. Starts run side by side. The caller that ran the pass gets the ids its
   * starts started (after they settle); a call that coalesced into a running pass gets the ids started so far.
   */
  async fill(): Promise<number[]> {
    if (!this.store.toggle('scheduler')) return [];
    if (this.filling) { this.refill = true; return this.filling; }
    const started: number[] = [];
    const starts: Promise<void>[] = [];
    let failed = false;
    const run = (async () => {
      let passes = 0;
      do {
        this.refill = false;
        let free = this.slots().free;
        // A standing worker takes one task at a time: one starting in this fill holds it too.
        const busy = new Set([...this.starting].map((id) => this.task(id)?.identity).filter((x): x is string => !!x));
        for (const t of this.queue()) {
          if (free <= 0) break;
          if (this.starting.has(t.id)) continue;
          try {
            // Its next task waits in its own queue; the slot goes on to the next task in line.
            if (t.identity && this.standing(t.identity)) {
              if (busy.has(t.identity) || this.workerBusy(t.identity, t.id)) continue;
              busy.add(t.identity);
            }
            // A dormant project (charter status) gets no workers until it moves to the company (D phase 3).
            if (this.dormant(t.project)) continue;
            // Backoff: a task that just started (and crashed or failed to launch) waits before the next try.
            if (this.inBackoff(t.id)) continue;
          } catch (e) {
            this.store.emit('scheduler.start_failed', t.identity, { task: t.id, error: (e as Error).message });
            continue;
          }
          this.lastStartAt.set(t.id, this.store.now());
          this.starting.add(t.id);
          free--;
          starts.push(this.start(t).then((ok) => {
            if (ok) started.push(t.id); else failed = true; // closed during setup: its slot is free again
            this.lastStartError = null;
          }, (e: Error) => {
            failed = true;
            this.lastStartError = e.message;
            this.store.emit('scheduler.start_failed', t.identity, { task: t.id, error: e.message });
          }).finally(() => this.starting.delete(t.id)));
        }
        await Promise.resolve();
      } while (this.refill && ++passes < 3);
    })();
    // Cleared on settle, never inside the IIFE: a pass with no awaits would finish before the assignment.
    this.filling = run.then(() => started).finally(() => {
      this.filling = null;
      // A call that came in after the last pass looked at `refill`: run it now, not never.
      if (this.refill) { this.refill = false; this.store.bg(this.fill(), 'scheduler.refill'); }
    });
    await this.filling;
    await Promise.all(starts);
    try { this.afterFill(); } catch (e) { this.store.emit('loop.error', null, { loop: 'scheduler.afterFill', error: (e as Error).message }); }
    // A start that failed held a slot it never used, and a pass during a launch saw that slot twice: one more
    // pass now (a failed task is in backoff, so this ends).
    if (failed || started.length) this.store.bg(this.fill(), 'scheduler.refill');
    return started;
  }

  private standing(identity: string): boolean {
    return isStandingWorker(getIdentity(this.store, identity), this.cfg.managerId);
  }

  /**
   * A standing worker is busy with another task (running, resting on a message, or interrupted mid-way), or is in
   * the middle of a conversation woken by a message between tasks. Its task waits; the conversation is not cut.
   */
  private workerBusy(identity: string, taskId: number): boolean {
    const other = this.store.db.prepare(`SELECT 1 FROM tasks WHERE identity = ? AND id != ? AND (state IN ('running','resting')
      OR (state IN ('open','interrupted') AND started_at IS NOT NULL)) LIMIT 1`).get(identity, taskId);
    if (other) return true;
    const cur = this.shifts.current(identity);
    return !!cur && cur.task_id !== taskId && (cur.task_id != null || this.shifts.midTurn(cur));
  }

  /**
   * Open a task worker under the project CEO (B.16) and hand it the task as its first prompt. False when the
   * task was closed while its worktree was being set up (no worker then).
   */
  private async start(t: TaskRow): Promise<boolean> {
    const lead = t.project ? projectLead(this.store, t.project) : undefined;
    const OPENED_BY = 'opened-by:';
    const openedBy = (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith(OPENED_BY))?.slice(OPENED_BY.length);
    const identity = t.identity ?? `${t.project ?? 'company'}-t${t.id}`;
    if (!t.identity) {
      const helper = !t.project && !!openedBy && getIdentity(this.store, openedBy)?.team === HELPER_TEAM;
      ensureRuntimeIdentity(this.store, { id: identity, ...taskWorkerName(this.store, t.id, helper), project: t.project,
        reports_to: openedBy ?? lead ?? this.cfg.managerId });
      this.store.db.prepare('UPDATE tasks SET identity = ? WHERE id = ?').run(identity, t.id);
    }
    // A task handed to a standing worker (open_team assignee) runs like a task worker's: its own worktree and a
    // new session. One handed to a lead or yoav runs where that identity runs: no worktree.
    const assigned = !!t.identity && this.standing(identity);
    const taskIdentity = !t.identity || assigned || (getIdentity(this.store, identity)?.team_kind === 'task');
    let ws: { path: string; note: string } | null = null;
    if (taskIdentity) {
      try {
        ws = await this.prepareWorktree(t);
      } catch (e) {
        // Wrong machine, no repository, worktree and branch gone: retrying will not help. Out of the
        // queue (needs-decision) and the opener hears why.
        const labels = [...new Set([...(JSON.parse(t.labels || '[]') as string[]), 'needs-decision'])];
        this.store.db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(labels), this.store.now(), t.id);
        this.mailbox.tell({ msg_id: `task-${t.id}-worktree-failed-${this.store.now()}`, from: 'hq', to: openedBy ?? lead ?? this.cfg.managerId, priority: 'next',
          body: `משימה ${t.ref ?? `#${t.id}`} (${t.title}) לא התחילה: ${(e as Error).message}. היא סומנה needs-decision ויצאה מהתור.` });
        throw e;
      }
      // Closed (done, closed on GitHub…) during a long worktree_setup: no worker, and the worktree goes.
      const now = this.task(t.id);
      if (!now || !['queued', 'open', 'interrupted'].includes(now.state)) {
        if (now?.worktree) await this.closeWorktree(t.id);
        return false;
      }
    }
    // A standing worker starts each task clean: a new session, not its previous task's or a conversation's. A
    // restart of this same task (crash, stuck) follows the usual resume rules.
    const fresh = assigned && this.shifts.last(identity)?.task_id !== t.id;
    let row;
    try {
      // spareTurn: a message may have started a turn during the worktree setup. The task waits for it, no backoff.
      row = await this.shifts.request(identity, { kind: 'work', reason: 'task', taskId: t.id, cwd: ws?.path, forceNew: fresh, spareTurn: fresh });
    } catch (e) {
      if (!(e instanceof ShiftBusyError)) throw e;
      this.lastStartAt.delete(t.id);
      return false;
    }
    // The identity already had a live shift (no new launch): bind the task to it so its end closes the loop.
    if (row.task_id !== t.id) this.shifts.setFields(row.id, { task_id: t.id });
    const set = this.store.db.prepare(`UPDATE tasks SET state = 'running', shift_id = ?, started_at = COALESCE(started_at, ?), updated_at = ?
      WHERE id = ? AND state != 'done'`).run(row.id, this.store.now(), this.store.now(), t.id);
    if (!set.changes) {
      // Closed while the shift was starting: a task worker's shift does not run (a standing identity's shift is its own).
      if (taskIdentity) await this.shifts.stop(row.id, 'task_done', row.started_at);
      return false;
    }
    this.store.emit('task.state', identity, { id: t.id, state: 'running', shift: row.id });
    // One prompt per run of the shift: a resumed run gets the task again (the old prompt id would be a no-op).
    this.mailbox.tell({ msg_id: `task-${t.id}-${row.id}-${row.started_at}`, from: openedBy ?? lead ?? 'hq', to: identity, priority: 'next',
      body: [`משימה ${t.ref ?? `#${t.id}`}: ${t.title}`, ws?.note, assigned ? this.standingNote(t, openedBy ?? lead) : null, t.body, this.promptNote()]
        .filter(Boolean).join('\n\n') });
    return true;
  }

  /** A standing worker has no task-worker prompt: how this task is done and closed comes with the task. */
  private standingNote(t: TaskRow, opener: string | undefined): string {
    return ['**איך סוגרים את המשימה:**', ...taskSteps(t.project, this.cfg.companyDir, { standing: true, opener })].join('\n');
  }

  private invalidReported = new Map<string, number>();

  private dormant(project: string | null): boolean {
    if (!project) return false;
    const ch = readCharter(this.cfg.companyDir, project);
    if (ch?.status === 'invalid' && this.store.now() - (this.invalidReported.get(project) ?? -Infinity) > 60 * 60_000) {
      this.invalidReported.set(project, this.store.now());
      this.store.emit('charter.invalid', null, { project, error: ch.error });
    }
    return noWorkers(ch);
  }

  /** The charter checkout a stored worktree belongs to: <checkout>/<worktree_dir>/<name>, nothing else. */
  private checkoutOf(t: Pick<TaskRow, 'project' | 'worktree'>) {
    const ch = t.project ? readCharter(this.cfg.companyDir, t.project) : null;
    const c = ch?.checkouts.find((x) => dirname(t.worktree!) === join(x.path, ch.worktreeDir));
    return { ch, c };
  }

  /**
   * The task's worktree (B.5): created on first start in the charter's checkout, reused (or brought back
   * on its branch) on a resume. A project without a checkout in its charter runs in hq's default cwd.
   */
  async prepareWorktree(t: Pick<TaskRow, 'id' | 'project' | 'worktree' | 'labels' | 'started_at'>): Promise<{ path: string; note: string } | null> {
    const ch = t.project ? readCharter(this.cfg.companyDir, t.project) : null;
    if (t.worktree) {
      const { c } = this.checkoutOf(t);
      if (!(await this.workspaces.ensure(t.worktree, c?.path, ch ?? undefined))) throw new Error(`task ${t.id}: worktree ${t.worktree} is gone and its branch too`);
      return { path: t.worktree, note: worktreeNote(t.worktree, ch) };
    }
    // Started before hq made worktrees: its session and work live where it ran (hq's default cwd and
    // a worktree the worker made itself). Moving it would orphan both.
    if (t.started_at != null) return null;
    if (!ch) return null;
    const repoLabel = (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith('repo:'))?.slice(5);
    const c = this.workspaces.checkout(ch, repoLabel);
    if (!c) return null;
    const w = await this.workspaces.create(ch, c, `company-t${t.id}`);
    this.store.db.prepare('UPDATE tasks SET worktree = ?, updated_at = ? WHERE id = ?').run(w.path, this.store.now(), t.id);
    this.store.emit('task.worktree', null, { id: t.id, path: w.path, branch: w.branch, base: w.base });
    return { path: w.path, note: worktreeNote(w.path, ch, w.branch, w.base) };
  }

  /**
   * The whole worktree path of a task, with no worker: create in the charter's checkout, look inside,
   * close (preserve + remove). Works on a dormant project too; that is what it is for.
   */
  async dryRunWorktree(project: string) {
    const ch = readCharter(this.cfg.companyDir, project);
    if (!ch) throw new Error(`no charter for ${project}`);
    const c = this.workspaces.checkout(ch);
    if (!c) throw new Error(`charter of ${project} names no checkout`);
    const w = await this.workspaces.create(ch, c, `company-dryrun-${this.store.now().toString(36)}`);
    let inside: Awaited<ReturnType<Workspaces['inspect']>> | { error: string };
    try { inside = await this.workspaces.inspect(w.path); } catch (e) { inside = { error: (e as Error).message }; }
    const closed = await this.workspaces.close(w.path, c.defaultBranch);
    const result = { project, status: ch.status, machine: ch.machine, checkout: c, worktree: w, inside, closed };
    this.store.emit('task.worktree_dry_run', null, result);
    return result;
  }

  /**
   * Task done: preserve and remove its worktree (B.5). Only a worktree inside a charter checkout's
   * worktree_dir is touched (never a path someone put on the task by hand). Failures are events, and
   * sweep() retries them; the task stays done.
   */
  private closeAttemptAt = new Map<number, number>();
  private closeWorktree(id: number): Promise<void> {
    const t = this.task(id);
    if (!t?.worktree) return Promise.resolve();
    this.closeAttemptAt.set(id, this.store.now());
    const { ch, c } = this.checkoutOf(t);
    // An unreadable charter may be a passing typo: keep the path, retryCloses tries again later.
    if (!ch || ch.status === 'invalid') return Promise.resolve();
    if (!c) {
      this.store.emit('task.worktree_close_failed', t.identity, { id, path: t.worktree, error: 'not inside a charter checkout worktree_dir: left alone' });
      this.store.db.prepare('UPDATE tasks SET worktree = NULL WHERE id = ? AND worktree = ?').run(id, t.worktree);
      return Promise.resolve();
    }
    const run = (async () => {
      // The worker may still be exiting: let its unit go first.
      const live = t.identity ? this.shifts.current(t.identity) : undefined;
      if (live && live.task_id === id) return;
      const r: CloseResult = await this.workspaces.close(t.worktree!, c.defaultBranch);
      if (r.removed || r.error === 'missing') {
        this.store.db.prepare('UPDATE tasks SET worktree = NULL WHERE id = ? AND worktree = ?').run(id, t.worktree);
        this.closeAttemptAt.delete(id);
      }
      this.store.emit(r.error && r.error !== 'missing' ? 'task.worktree_close_failed' : 'task.worktree_closed', t.identity, { id, ...r });
    })();
    this.store.bg(run, 'task.worktree.close');
    return run;
  }

  /** Done tasks whose worktree is still there (a close failed, or hq restarted mid-close): try again every 10 min. */
  async retryCloses(): Promise<void> {
    const rows = this.store.db.prepare(`SELECT id FROM tasks WHERE state = 'done' AND worktree IS NOT NULL`).all() as { id: number }[];
    for (const { id } of rows) {
      if (this.store.now() - (this.closeAttemptAt.get(id) ?? -Infinity) < 10 * 60_000) continue;
      await this.closeWorktree(id).catch(() => {});
    }
  }

  private onTaskShiftEnded(taskId: number, reason: string): void {
    const t = this.task(taskId);
    if (!t || t.state !== 'running') return;
    // B.7: the account manager resumes this same shift on another account right away; the task keeps running.
    if (reason === 'account_switch') return;
    // done: closed by the worker. rest: idle worker released its process, the task waits for its next
    // message (not re-queued, or it would restart forever). Anything else: back to the head of the queue.
    const next = reason === 'task_done' ? 'done' : reason === 'rest' ? 'resting' : t.worktree ? 'interrupted' : 'queued';
    this.store.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(next, this.store.now(), taskId);
    this.store.emit('task.state', t.identity, { id: taskId, state: next, reason });
    if (next === 'done') this.closeWorktree(taskId);
  }

  /** Tasks whose worker's status done waits for its turn: the latest call's op and onClose win. */
  private finishing = new Map<number, { opId: string; onClose?: () => void }>();

  /**
   * status done from the worker (#118). Its turn ends first: the text it is still writing may be his reply, and a stop
   * mid-turn loses it. Then, if he is still waiting for an answer from it, the task stays open and the worker hears
   * so; otherwise [onClose] runs and the task completes. Returns what happened.
   */
  async finishByWorker(id: number, identity: string, opId: string, onClose?: () => void): Promise<'done' | 'waiting' | 'skipped'> {
    const again = this.finishing.has(id);
    this.finishing.set(id, { opId, onClose });
    if (again) return 'skipped';
    try {
      const cur = this.shifts.current(identity);
      if (cur && cur.kind !== 'foreign') await this.shifts.waitTurnEnd(cur.id, this.cfg.timers.turnEndWaitMs);
      const t = this.task(id);
      if (!t || t.state === 'done') return 'skipped';
      const waiting = this.mailbox.unanswered(identity, t.started_at ?? t.created_at);
      const last = this.finishing.get(id)!;
      if (waiting.length) {
        this.mailbox.tell({ msg_id: `${last.opId}-waiting`, from: 'hq', to: identity, kind: 'system', priority: 'now', ref: waiting.at(-1)!.id,
          body: `המשימה לא נסגרה: ${waitingLine(waiting, this.mailbox.names.owner.name)}. ענה ${g(this.mailbox.names.owner, 'לו', 'לה')} ב-\`tell\` ל-\`owner\`, ואז \`status\` עם \`state: "done"\` שוב.` });
        this.store.emit('task.close_waiting', identity, { id, messages: waiting.map((m) => m.id) });
        return 'waiting';
      }
      last.onClose?.();
      await this.completeTask(id);
      return 'done';
    } finally { this.finishing.delete(id); }
  }

  /** The worker (status op state=done) or the owner closed the task: end its shift with task_done. */
  async completeTask(id: number): Promise<TaskRow | undefined> {
    const t = this.task(id);
    if (!t || t.state === 'done') return t;
    // A task worker's identity exists only for its task: any shift of it goes (also one a message woke, task_id null).
    const owns = (s: { task_id: number | null }) => s.task_id === id || (s.task_id == null && getIdentity(this.store, t.identity!)?.team_kind === 'task');
    const cur = t.identity ? this.shifts.current(t.identity) : undefined;
    if (cur && owns(cur)) await this.shifts.stop(cur.id, 'task_done', cur.started_at);
    // A run that started while we were stopping (resurrect, a message) is stopped too, before the worktree goes.
    const late = t.identity ? this.shifts.current(t.identity) : undefined;
    if (late && late.kind !== 'foreign' && owns(late) && (late.id !== cur?.id || late.started_at !== cur.started_at)) {
      await this.shifts.stop(late.id, 'task_done', late.started_at);
    }
    if (this.task(id)!.state !== 'done') {
      this.setTaskState(id, 'done');
      this.closeWorktree(id);
    }
    // A standing worker's next task may be waiting for this one.
    queueMicrotask(() => this.store.bg(this.fill(), 'scheduler.fill'));
    return this.task(id);
  }

  /**
   * close_team on a standing worker's task: its next task starts from its handoff, so it gets handoffGraceMs to write
   * one (a message wakes it if it rests) and close with status done. Then the task is closed anyway (sweep). The
   * label keeps the deadline across an hq restart. Returns false when there is no one to ask (no standing worker, or
   * a task of its that has not started): the caller closes it at once.
   */
  closeWithHandoff(id: number, by: string, reason: string | undefined): boolean {
    const t = this.task(id);
    if (!t || t.state === 'done' || !t.identity || !this.standing(t.identity)) return false;
    // Only the task it is on: one still waiting in its queue has nothing to hand off, and closes at once.
    const onIt = ['running', 'resting'].includes(t.state) || (['open', 'interrupted'].includes(t.state) && t.started_at != null);
    if (!onIt) return false;
    const labels = JSON.parse(t.labels || '[]') as string[];
    if (!labels.some((l) => l.startsWith(CLOSING))) {
      labels.push(`${CLOSING}${this.store.now()}`);
      this.store.db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(labels), this.store.now(), id);
    }
    this.mailbox.tell({ msg_id: `task-${id}-closing`, from: by, to: t.identity, kind: 'system', priority: 'now',
      body: [`המשימה ${t.ref ?? `#${id}`} (${t.title}) נסגרת${reason ? `: ${reason}` : ''}.`,
        `כתוב עכשיו \`handoff\` (מה נעשה, מה נשאר, מה למדת), ואז \`status\` עם \`state: "done"\`. בעוד ${Math.round(this.cfg.timers.handoffGraceMs / 60_000)} דקות המשמרת נעצרת בכל מקרה.`].join('\n') });
    return true;
  }

  /** Tasks close_team is closing whose grace is over: closed now. */
  async closeOverdue(): Promise<void> {
    const rows = this.store.db.prepare(`SELECT id, labels FROM tasks WHERE state != 'done' AND labels LIKE '%"${CLOSING}%'`).all() as { id: number; labels: string }[];
    for (const r of rows) {
      const at = Number((JSON.parse(r.labels) as string[]).find((l) => l.startsWith(CLOSING))!.slice(CLOSING.length));
      if (this.store.now() - at >= this.cfg.timers.handoffGraceMs) await this.completeTask(r.id);
    }
  }

  /**
   * close_team's `team` → its task: `t22` / `task-22` / `#22` / `22`, the task worker's identity (`lumo-t22`) or a
   * shift of it (`lumo-t22-2`), the task's ref, or the worker's display name; a standing worker's identity or name
   * finds its current task. An open task wins over a done one;
   * two open tasks behind one name are ambiguous (the caller says which).
   */
  findTeam(team: string): { task?: TaskRow; ambiguous?: TaskRow[] } {
    const db = this.store.db;
    const q = team.trim();
    const num = /^(?:t|task-|#)?(\d+)$/i.exec(q);
    if (num) { const t = this.task(Number(num[1])); return t ? { task: t } : {}; }
    const shiftTask = (db.prepare('SELECT task_id FROM shifts WHERE id = ?').get(q) as { task_id: number | null } | undefined)?.task_id ?? null;
    const rows = db.prepare(`SELECT t.* FROM tasks t LEFT JOIN identities i ON i.id = t.identity
      WHERE (t.identity = @q AND i.team_kind = 'task') OR (t.identity = @q AND ${STANDING_TASK}) OR t.ref = @q OR t.id = @shiftTask OR (i.name = @q AND (i.team_kind = 'task' OR ${STANDING_TASK}))
      ORDER BY CASE WHEN t.state = 'done' THEN 1 ELSE 0 END, t.id DESC`)
      .all({ q, shiftTask, mgr: this.cfg.managerId }) as TaskRow[];
    const open = rows.filter((t) => t.state !== 'done');
    if (open.length > 1) return { ambiguous: open };
    return rows[0] ? { task: rows[0] } : {};
  }

  /** Who may close a task team: whoever opened it, that opener's manager, the worker's manager, or the company manager. */
  canCloseTeam(t: TaskRow, by: string): boolean {
    if (by === this.cfg.managerId) return true;
    const openedBy = (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith('opened-by:'))?.slice('opened-by:'.length);
    const allowed = new Set<string>();
    if (openedBy) { allowed.add(openedBy); const m = getIdentity(this.store, openedBy)?.reports_to; if (m) allowed.add(m); }
    const workerMgr = t.identity ? getIdentity(this.store, t.identity)?.reports_to : undefined;
    if (workerMgr) allowed.add(workerMgr);
    if (!openedBy && t.project) { const lead = projectLead(this.store, t.project); if (lead) allowed.add(lead); }
    return allowed.has(by);
  }

  setTaskPriority(id: number, priority: number): TaskRow | undefined {
    if (!this.task(id)) return undefined;
    this.store.db.prepare('UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?').run(priority, this.store.now(), id);
    const t = this.task(id)!;
    this.store.emit('task.priority', t.identity, { id, priority });
    queueMicrotask(() => this.store.bg(this.fill(), 'scheduler.fill'));
    return t;
  }

  /** A.4: blocking ask → manager after N minutes (immediately at night, B.16). Non-blocking asks wait. */
  escalateAsks(): void {
    if (!this.store.toggle('escalation')) return;
    const night = this.store.toggle('night');
    const cutoff = this.store.now() - (night ? 0 : this.cfg.timers.escalateBlockingAskMs);
    for (const a of this.mailbox.openAsks()) {
      if (a.state !== 'open' || !a.blocking || a.created_at > cutoff) continue;
      this.mailbox.escalate(a, night ? 'מצב לילה' : `${Math.round(this.cfg.timers.escalateBlockingAskMs / 60000)} דקות בלי תשובה`);
    }
  }

  /** One sweep (B.16: every minute, and whenever a slot frees). Heartbeat reads `last_sweep_at`. */
  private residentTriedAt = new Map<string, number>();

  /** B.2: residents (יואב) always run, in their own pool. Keep them up; retry a failed launch every 5 min. */
  async ensureResidents(): Promise<string[]> {
    if (!this.store.toggle('residents')) return [];
    const now = this.store.now();
    const started: string[] = [];
    const rows = this.store.db.prepare(`SELECT id FROM identities WHERE lifecycle = 'resident' AND active = 1`).all() as { id: string }[];
    for (const { id } of rows) {
      if (this.shifts.current(id)) continue;
      if (now - (this.residentTriedAt.get(id) ?? 0) < 5 * 60_000) continue;
      this.residentTriedAt.set(id, now);
      try {
        await this.shifts.request(id, { reason: 'resident', kind: 'resident' });
        started.push(id);
      } catch (e) {
        this.store.emit('scheduler.resident_failed', id, { error: (e as Error).message });
      }
    }
    return started;
  }

  /**
   * #68: a lead (team head or project CEO) that is in org.yaml but never had a shift was only woken by the
   * first message someone happened to send it. hq wakes it once itself: a system message whose id is fixed
   * per identity, so a restart or a second call never sends it again. Returns the leads it woke.
   */
  wakeNewLeads(): string[] {
    const rows = this.store.db.prepare(`SELECT id, name, title FROM identities i WHERE lifecycle = 'lead' AND active = 1
      AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.identity = i.id)`).all() as { id: string; name: string; title: string }[];
    const woke: string[] = [];
    for (const r of rows) {
      const msgId = `hq-lead-up-${r.id}`;
      if (this.mailbox.get(msgId)) continue;
      this.mailbox.tell({ msg_id: msgId, from: 'hq', to: r.id, kind: 'system', priority: 'next',
        body: [
          `קמת לראשונה: נוספת ל-\`org.yaml\` בתור ${r.title || 'ראש צוות'}, ו-hq העיר אותך אחרי שנטען.`,
          `כתוב ${pre('ל', this.mailbox.names.owner.name)} ב-\`tell\` (\`to: "owner"\`) משפט-שניים: שקמת, מי אתה ומה הצוות שלך עושה. אחר כך המשך לפי התיק שלך.`,
        ].join('\n') });
      this.store.emit('scheduler.lead_woken', r.id, { msg: msgId });
      woke.push(r.id);
    }
    return woke;
  }

  async sweep(): Promise<void> {
    const now = this.store.now();
    this.escalateAsks();
    await this.ensureResidents();
    await this.closeOverdue();
    await this.fill();
    // Empty-slot measurement (metric.empty_slot) is night.ts: per interval, with its reason.
    await this.retryCloses();
    this.store.setMeta('last_sweep_at', String(now));
  }
}

/** What the worker is told about where it works (first prompt of each run). */
function worktreeNote(path: string, ch: ReturnType<typeof readCharter>, branch?: string, base?: string): string {
  const cmds = Object.entries(ch?.commands ?? {}).map(([k, v]) => `${k}: \`${v}\``).join(' · ');
  return [
    `**איפה עובדים:** hq פתח לך worktree ב-\`${path}\`${branch ? ` על הענף \`${branch}\` (מ-\`${base}\`)` : ''}. זה ה-cwd שלך. לא פותחים worktree נוסף ולא מסירים אותו: hq שומר ומסיר אותו כשהמשימה נסגרת.`,
    cmds ? `**פקודות מהאמנה:** ${cmds}` : '',
    ch?.ciCheck ? `**CI:** ממזגים רק כשהבדיקה \`${ch.ciCheck}\` ירוקה ב-PR.` : '',
  ].filter(Boolean).join('\n');
}
