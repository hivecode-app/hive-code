// The scheduler is code, not an LLM (A.2(8), B.5, B.16). It:
//  - fills every free work slot from the queue immediately, in B.16 order, with no quota-percentage gate;
//  - escalates unanswered blocking asks to the manager (A.4: 10 min by day, immediately at night);
//  - lets night.ts (B.16) scope the queue, add the night note and measure empty slots after every fill.
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';
import type { ShiftManager } from './shifts.ts';
import { ensureRuntimeIdentity, projectLead } from './org.ts';
import { memInfoMb } from './proc.ts';

export interface TaskRow {
  id: number; ref: string | null; project: string | null; title: string; body: string; source: string; state: string;
  labels: string; priority: number; night_weight: number; worktree: string | null; carried_over: number;
  identity: string | null; shift_id: string | null; created_at: number; updated_at: number; started_at: number | null;
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

export class Scheduler {
  memInfo: () => { totalMb: number; availableMb: number } = memInfoMb;
  /** Night mode (night.ts) plugs in here: the scope filter, a note for every task prompt, and a look after each fill. */
  scope: () => string[] | null = () => null;
  promptNote: () => string | null = () => null;
  afterFill: () => void = () => {};

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
      if (row.kind === 'work' && reason !== 'launch_failed') this.store.bg(this.fill(), 'scheduler.fill');
    });
    // A resting task worker woken by a message is working on its task again.
    shifts.on('live', (row) => {
      if (row.task_id == null) return;
      const t = this.task(row.task_id);
      if (t && t.state === 'resting') this.setTaskState(t.id, 'running');
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
    const running = (this.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND kind = 'work'`).get() as { n: number }).n;
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

  /** Fill free slots from the queue. Concurrent calls coalesce into one more pass. Returns task ids started. */
  async fill(): Promise<number[]> {
    if (!this.store.toggle('scheduler')) return [];
    if (this.filling) { this.refill = true; return this.filling; }
    const run = (async () => {
      const started: number[] = [];
      let passes = 0;
      do {
        this.refill = false;
        let { free } = this.slots();
        for (const t of this.queue()) {
          if (free <= 0) break;
          // Backoff: a task that just started (and crashed or failed to launch) waits before the next try.
          if (this.inBackoff(t.id)) continue;
          this.lastStartAt.set(t.id, this.store.now());
          try {
            await this.start(t);
            started.push(t.id);
            free--;
            this.lastStartError = null;
          } catch (e) {
            this.lastStartError = (e as Error).message;
            this.store.emit('scheduler.start_failed', t.identity, { task: t.id, error: (e as Error).message });
          }
        }
      } while (this.refill && ++passes < 3);
      try { this.afterFill(); } catch (e) { this.store.emit('loop.error', null, { loop: 'scheduler.afterFill', error: (e as Error).message }); }
      return started;
    })();
    // Cleared on settle, never inside the IIFE: a pass with no awaits would finish before the assignment.
    this.filling = run.finally(() => { this.filling = null; });
    return this.filling;
  }

  /** Open a task worker under the project CEO (B.16) and hand it the task as its first prompt. */
  private async start(t: TaskRow): Promise<void> {
    const lead = t.project ? projectLead(this.store, t.project) : undefined;
    const OPENED_BY = 'opened-by:';
    const openedBy = (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith(OPENED_BY))?.slice(OPENED_BY.length);
    const identity = t.identity ?? `${t.project ?? 'company'}-t${t.id}`;
    if (!t.identity) {
      ensureRuntimeIdentity(this.store, { id: identity, name: `t${t.id}`, title: t.title.slice(0, 60), project: t.project,
        reports_to: openedBy ?? lead ?? this.cfg.managerId });
      this.store.db.prepare('UPDATE tasks SET identity = ? WHERE id = ?').run(identity, t.id);
    }
    const row = await this.shifts.request(identity, { kind: 'work', reason: 'task', taskId: t.id, cwd: t.worktree ?? undefined });
    // The identity already had a live shift (no new launch): bind the task to it so its end closes the loop.
    if (row.task_id !== t.id) this.shifts.setFields(row.id, { task_id: t.id });
    this.store.db.prepare(`UPDATE tasks SET state = 'running', shift_id = ?, started_at = COALESCE(started_at, ?), updated_at = ? WHERE id = ?`)
      .run(row.id, this.store.now(), this.store.now(), t.id);
    this.store.emit('task.state', identity, { id: t.id, state: 'running', shift: row.id });
    // One prompt per run of the shift: a resumed run gets the task again (the old prompt id would be a no-op).
    this.mailbox.tell({ msg_id: `task-${t.id}-${row.id}-${row.started_at}`, from: openedBy ?? lead ?? 'hq', to: identity, priority: 'next',
      body: [`משימה ${t.ref ?? `#${t.id}`}: ${t.title}`, t.body, this.promptNote()].filter(Boolean).join('\n\n') });
  }

  private onTaskShiftEnded(taskId: number, reason: string): void {
    const t = this.task(taskId);
    if (!t || t.state !== 'running') return;
    // done: closed by the worker. rest: idle worker released its process, the task waits for its next
    // message (not re-queued, or it would restart forever). Anything else: back to the head of the queue.
    const next = reason === 'task_done' ? 'done' : reason === 'rest' ? 'resting' : t.worktree ? 'interrupted' : 'queued';
    this.store.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(next, this.store.now(), taskId);
    this.store.emit('task.state', t.identity, { id: taskId, state: next, reason });
  }

  /** The worker (status op state=done) or the owner closed the task: end its shift with task_done. */
  async completeTask(id: number): Promise<TaskRow | undefined> {
    const t = this.task(id);
    if (!t || t.state === 'done') return t;
    const cur = t.identity ? this.shifts.current(t.identity) : undefined;
    if (cur && cur.task_id === id) await this.shifts.stop(cur.id, 'task_done', cur.started_at);
    if (this.task(id)!.state !== 'done') this.setTaskState(id, 'done');
    return this.task(id);
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

  async sweep(): Promise<void> {
    const now = this.store.now();
    this.escalateAsks();
    await this.ensureResidents();
    await this.fill();
    // Empty-slot measurement (metric.empty_slot) is night.ts: per interval, with its reason.
    this.store.setMeta('last_sweep_at', String(now));
  }
}
