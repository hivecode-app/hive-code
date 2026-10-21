// The scheduler is code, not an LLM (A.2(8), B.5, B.16). It:
//  - fills every free work slot from the queue immediately, in B.16 order, with no quota-percentage gate;
//  - counts a lead idle with no task outside the work slots, and rests it when a task waits for a slot (#128);
//  - escalates unanswered blocking asks to the manager (A.4: 10 min by day, immediately at night);
//  - lets night.ts (B.16) scope the queue, add the night note and measure empty slots after every fill.
import { ENGINE_ROOT as ENGINE, g, pre } from '@company/shared';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import { waitingLine, type Mailbox } from './mailbox.ts';
import { ShiftBusyError, type ShiftManager } from './shifts.ts';
import { ensureRuntimeIdentity, getIdentity, isStandingWorker, projectLead, taskWorkerName } from './org.ts';
import { HELPER_TEAM, taskSteps } from './system-prompt.ts';
import { loadInfo, memInfoMb } from './proc.ts';
import { dirname, join } from 'node:path';
import { noWorkers, readCharter, Workspaces, type CloseResult } from './workspace.ts';
import { LOCAL, LOCAL_LABELS, NEEDS_LOCAL, NodeUnreachable, nodeToggle, RemoteWorkspaces, type Nodes, type RemoteNode } from './nodes.ts';

export interface TaskRow {
  id: number; ref: string | null; project: string | null; title: string; body: string; source: string; state: string;
  labels: string; priority: number; night_weight: number; worktree: string | null; carried_over: number;
  identity: string | null; shift_id: string | null; created_at: number; updated_at: number; started_at: number | null;
  /** One line in his words on what it did, written when it closed (status done / close_team); null = none given. */
  summary?: string | null;
  /** "מה לבדוק" (awaiting.ts): deploy | check | verify, with one line in his words; null = nothing waits. */
  awaiting?: string | null; awaiting_note?: string | null; awaiting_at?: number | null; pr?: string | null;
  /** Where its worktree and shifts are (nodes.ts): 'local' or a node's name; null = not placed yet. */
  machine?: string | null;
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

/**
 * SQL over shifts s LEFT JOIN identities i: a shift of an identity from org.yaml that is not a task worker and not a
 * resident (a lead, a standing worker). Without a task and out of a turn it holds no work slot (#128).
 */
const STANDING_SHIFT = `(i.source = 'org' AND i.active = 1 AND COALESCE(i.team_kind, '') != 'task' AND i.lifecycle != 'resident' AND i.id != @mgr)`;

/** SQL over shifts s: a message to its identity not yet handled. */
const PENDING = `SELECT 1 FROM messages m WHERE m.to_identity = s.identity AND m.state IN ('queued','delivered')`;

/** #175: how many times hq wakes one task whose worker rested before it leaves it for a message. */
const REST_WAKES = 6;

/** Label on a standing worker's task that close_team is closing: the time it was asked for its handoff. */
const CLOSING = 'closing-at:';

/** End reason of a node's shift whose task moves here (fallbackLocal). */
const NODE_FALLBACK = 'node_fallback';

/** End reason of a shift stopped because it never took its task's brief (briefStale). */
const BRIEF_FAILED = 'brief_failed';

/** #224: briefs not taken (or launches failed) in a row before the monitoring lead hears of the task, once. */
const BRIEF_FAILS = 3;

/** #224: a node's memory and load are read again before a start when the last read is older than this. */
const NODE_FRESH_MS = 15_000;

/** Label on a task that started on a node and came back to the queue (unpin), `moved-from:<node>:<path>`: its next brief says where its work is. */
const MOVED_FROM = 'moved-from:';

/** Label on a task that came back from a node whose worktree there could not be closed: `left-on:<node>:<path>`. */
const LEFT_ON = 'left-on:';

/** unpin waits this long for the node's worktree to close before the task comes back anyway (#224). */
const UNPIN_CLOSE_MS = 90_000;

/** A task's worktree is gone and its branch too (prepareWorktree). */
class WorktreeGone extends Error { override name = 'WorktreeGone'; }

/** What the board and the queue say when the machine is too loaded to start a shift (#224). */
export const BUSY_REASON = 'השרת עמוס';

export class Scheduler {
  memInfo: () => { totalMb: number; availableMb: number } = memInfoMb;
  /** #224: load here (/proc/loadavg). Tests swap it. */
  loadInfo: () => { load1: number; cpus: number } = loadInfo;
  /** Reads a node's memory and load again (hq sets it, to keep its up/down notices); default: the plain poll. */
  pollNode: (n: RemoteNode) => Promise<unknown> = (n) => n.poll(this.store.now());
  /** Night mode (night.ts) plugs in here: the scope filter, a note for every task prompt, and a look after each fill. */
  scope: () => string[] | null = () => null;
  promptNote: () => string | null = () => null;
  afterFill: () => void = () => {};
  /** Worktrees per task in the project's checkout (B.5). Tests swap in one over a temp repo. */
  workspaces = new Workspaces();
  /** Other machines that take task shifts (nodes.ts, set by hq); null = none. */
  nodes: Nodes | null = null;
  private remoteWs = new Map<string, Pick<Workspaces, 'checkout' | 'create' | 'ensure' | 'close'>>();

  /** The worktrees of a machine: here, or a node's (the same Workspaces, run there). */
  workspacesFor(machine: string | null | undefined): Pick<Workspaces, 'checkout' | 'create' | 'ensure' | 'close'> {
    if (!machine || machine === LOCAL) return this.workspaces;
    let w = this.remoteWs.get(machine);
    if (!w) {
      const n = this.nodes?.get(machine);
      if (!n) throw new Error(`task runs on ${machine}, which is not in hq.config.json nodes`);
      w = new RemoteWorkspaces(n, this.cfg.companyHome, ENGINE);
      this.remoteWs.set(machine, w);
    }
    return w;
  }

  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private mailbox: Mailbox;
  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, mailbox: Mailbox) {
    this.store = store;
    this.cfg = cfg;
    this.shifts = shifts;
    this.mailbox = mailbox;
    // A message stale on a node's shift that never took its task: the task moves here, no resurrection (fallbackLocal).
    mailbox.nodeFallback = async (identity) => {
      const t = this.store.db.prepare(`SELECT id FROM tasks WHERE identity = ? AND machine IS NOT NULL AND machine != 'local' AND state != 'done'
        ORDER BY id DESC LIMIT 1`).get(identity) as { id: number } | undefined;
      return t ? this.fallbackLocal(t.id, 'not accepted') : false;
    };
    mailbox.briefStale = (m) => this.briefStale(m);
    mailbox.startPending = (identity) => this.retrying(identity);
    // A slot frees the moment a shift ends: fill it now, don't wait for the next sweep.
    shifts.on('ended', (row, reason) => {
      if (row.task_id != null) this.onTaskShiftEnded(row.task_id, reason, row.machine, row);
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

  /** Runs at the end of every sweep (estimates.ts remind: no timer of its own per estimate). */
  onSweep?: () => void;

  /** A task that ends (any way) cancels the estimates still open on it; the ones its worker closed with status done are already closed. */
  onTaskDone?: (id: number) => void;

  setTaskState(id: number, state: string): void {
    this.store.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(state, this.store.now(), id);
    this.store.emit('task.state', null, { id, state });
    if (state === 'done' || state === 'closed') this.onTaskDone?.(id);
  }

  queue(): (TaskRow & { bucket: number })[] {
    const scope = this.scope();
    return this.store.db.prepare(QUEUE_SQL).all({ scope: scope ? JSON.stringify(scope) : null }) as (TaskRow & { bucket: number })[];
  }

  /**
   * Slots here (B.5, #128); a node's are nodeSlots(). `running` is what holds a work slot: task shifts, starts under way, and a standing shift (a lead,
   * a standing worker between tasks) while it is in a turn. A standing shift that is up and idle with no task holds no
   * slot: it is counted like a resident (RSS_idle off the total), and rests when a task waits (restOnPressure).
   * `tasks` / `leads` say what is behind the numbers, for the board.
   */
  slots() {
    const db = this.store.db;
    const live = db.prepare(`SELECT s.task_id, s.in_turn, s.state, ${STANDING_SHIFT} AS standing FROM shifts s
      LEFT JOIN identities i ON i.id = s.identity WHERE s.state IN ('starting','live') AND s.kind = 'work' AND s.machine = 'local'`)
      .all({ mgr: this.cfg.managerId }) as { task_id: number | null; in_turn: number; state: string; standing: number }[];
    const leadShifts = live.filter((s) => s.standing && s.task_id == null);
    const idle = leadShifts.filter((s) => s.state === 'live' && !s.in_turn).length;
    const active = leadShifts.length - idle;
    // A task still in its worktree setup has no shift row yet, but its slot is taken.
    const tasks = live.length - leadShifts.length + [...this.starting.values()].filter((m) => m === LOCAL).length;
    const residents = (db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND kind = 'resident'`).get() as { n: number }).n;
    // Standing identities that ran before and are down now: rested (idle, pressure) or stopped by hand. A message wakes them.
    const resting = (db.prepare(`SELECT COUNT(*) n FROM identities i WHERE i.source = 'org' AND i.active = 1
      AND COALESCE(i.team_kind, '') != 'task' AND i.lifecycle != 'resident' AND i.id != @mgr
      AND EXISTS (SELECT 1 FROM shifts s WHERE s.identity = i.id AND s.kind = 'work')
      AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.identity = i.id AND s.state IN ('starting','live'))`)
      .get({ mgr: this.cfg.managerId }) as { n: number }).n;
    const mem = this.memInfo();
    const c = capacity(this.cfg, mem, tasks + active, Math.max(residents, this.cfg.capacity.residents.length) + idle);
    // #224: the machine itself, whatever loads it (a CI runner, a build outside the shifts): over the load or short of
    // memory for one more shift, nothing starts, and the queue says why.
    const { load1, cpus } = this.loadInfo();
    const load = cpus > 0 ? Math.round((load1 / cpus) * 100) / 100 : null;
    const overLoad = load != null && load > this.cfg.capacity.maxLoad;
    const shortMem = c.total > c.running && mem.availableMb - this.cfg.capacity.reserveMb < this.cfg.capacity.rssWorkMb;
    const pressure: 'load' | 'memory' | null = overLoad ? 'load' : shortMem ? 'memory' : null;
    return { ...c, free: overLoad ? 0 : c.free, pressure, load, availableMb: Math.round(mem.availableMb), tasks, leads: { active, idle, resting } };
  }

  /**
   * Task slots on each node (nodes.ts): the same memory formula as here (B.5, no residents there), capped by the
   * node's maxSlots, and none while its load per CPU is over maxLoad or it is down. The switch (`enabled`) stops new
   * tasks going there (placeFor); a task already there keeps its slots, its worktree and session are there.
   */
  nodeSlots(): { name: string; enabled: boolean; up: boolean; error: string | null; load: number | null; total: number; running: number; free: number; busy: boolean }[] {
    return (this.nodes?.list ?? []).map((n) => {
      const name = n.def.name;
      const running = (this.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND machine = ?`).get(name) as { n: number }).n
        + [...this.starting.values()].filter((m) => m === name).length;
      const st = n.status;
      const enabled = this.store.toggle(nodeToggle(name));
      const load = st?.up && st.cpus ? Math.round((st.load1 / st.cpus) * 100) / 100 : null;
      if (!st?.up) return { name, enabled, up: false, error: st?.error ?? null, load, total: 0, running, free: 0, busy: false };
      const c = capacity({ ...this.cfg, capacity: { ...this.cfg.capacity, maxSlots: n.def.maxSlots } }, st, running, 0);
      const overLoad = load == null || load > n.def.maxLoad;
      const free = overLoad ? 0 : c.free;
      const busy = overLoad || (c.total > running && st.availableMb - this.cfg.capacity.reserveMb < this.cfg.capacity.rssWorkMb);
      return { name, enabled, up: true, error: null, load, total: c.total, running, free, busy };
    });
  }

  /**
   * Where a task that has no machine yet would go (nodes.ts): a node, when the task can run there (a task worker's
   * task of a project the node lists, with no label that keeps it here) and the node has a free slot; else here.
   * A task with a machine stays on it: its worktree and session are there.
   */
  placeFor(t: TaskRow, nodeFree: Map<string, number>): string {
    if (t.machine) return t.machine;
    if (!this.nodes || !this.mayLeave(t)) return LOCAL;
    const best = this.nodes.list.filter((n) => n.def.projects.includes(t.project!) && this.store.toggle(nodeToggle(n.def.name))
      && (nodeFree.get(n.def.name) ?? 0) > 0)
      .sort((a, b) => (nodeFree.get(b.def.name) ?? 0) - (nodeFree.get(a.def.name) ?? 0))[0];
    return best?.def.name ?? LOCAL;
  }

  /**
   * A task that has not started and may run on a node: a project task with no label that keeps it here, of a task
   * worker or of a standing worker (assignee), who works it in a worktree and a new session like a task worker (start()).
   * Task-288: it used to be task workers only, so every task handed to yael, ido or any other standing worker
   * waited for a slot here while the node was empty. A task handed to a lead or yoav has no worktree: it runs where they run, here.
   */
  private mayLeave(t: TaskRow): boolean {
    if (t.worktree || t.started_at != null || !t.project) return false;
    if ((JSON.parse(t.labels || '[]') as string[]).some((l) => LOCAL_LABELS.includes(l))) return false;
    if (!t.identity) return true;
    return getIdentity(this.store, t.identity)?.team_kind === 'task' || this.standing(t.identity);
  }

  /** A node the task could run on, whether or not it has room now (waitReason). */
  private nodeCandidate(t: TaskRow): RemoteNode | undefined {
    if (t.machine) return this.nodes?.get(t.machine);
    const free = new Map((this.nodes?.list ?? []).map((n) => [n.def.name, 1]));
    return this.nodes?.get(this.placeFor(t, free));
  }

  /**
   * #128: a task waits for a slot and none is free → standing shifts (not residents, not yoav) idle with no task for
   * restOnPressureMs rest (session kept; a message wakes them as always). Returns the shifts it rested.
   */
  async restOnPressure(): Promise<string[]> {
    if (!this.store.toggle('scheduler')) return [];
    const slots = this.slots();
    const { free, total } = slots;
    // At the maxSlots cap a rested lead frees no slot: it would only wake slower. Over the load, resting one frees no
    // CPU; short of memory it does.
    if (free > 0 || total >= this.cfg.capacity.maxSlots || slots.pressure === 'load') return [];
    if (!this.queue().some((t) => ['מחכה למשבצת', BUSY_REASON].includes(this.waitReason(t, slots)))) return [];
    const cutoff = this.store.now() - this.cfg.timers.restOnPressureMs;
    const rows = this.store.db.prepare(`SELECT s.id, s.identity, s.started_at FROM shifts s JOIN identities i ON i.id = s.identity
      WHERE s.state = 'live' AND s.kind = 'work' AND s.task_id IS NULL AND s.in_turn = 0 AND ${STANDING_SHIFT}
        AND (s.bg_tasks = '[]' OR COALESCE(s.last_event_at, s.started_at) <= @bgCutoff)
        AND COALESCE(s.last_event_at, s.started_at) <= @cutoff
        AND NOT EXISTS (${PENDING})
      ORDER BY COALESCE(s.last_event_at, s.started_at)`).all({ mgr: this.cfg.managerId, cutoff, bgCutoff: this.store.now() - this.cfg.timers.restBgMaxMs }) as { id: string; identity: string; started_at: number }[];
    const rested: string[] = [];
    for (const r of rows) {
      // A message may have come in, or started a turn, since the read (the stops before this one await): never cut one.
      const cur = this.shifts.get(r.id);
      if (!cur || cur.started_at !== r.started_at || cur.state !== 'live' || cur.in_turn || cur.task_id != null) continue;
      if (this.store.db.prepare(`SELECT 1 FROM shifts s WHERE s.id = ? AND EXISTS (${PENDING})`).get(r.id)) continue;
      await this.shifts.stop(r.id, 'rest', r.started_at);
      this.store.emit('scheduler.rest_on_pressure', r.identity, { shift: r.id });
      rested.push(r.id);
    }
    return rested;
  }

  private filling: Promise<number[]> | null = null;
  private refill = false;
  private lastStartAt = new Map<number, number>();
  /** The last launch error, for the empty-slot reason (B.16). Cleared by the next successful start. */
  lastStartError: string | null = null;

  /**
   * #224: briefs of a task its worker never took (claude died or never came up) and launches that failed, in a row.
   * Each one after the first doubles the task's backoff (taskRetryMs, ×2, ×4… up to ×16); the BRIEF_FAILS-th tells the monitoring lead once. A brief taken resets it.
   */
  private briefFails = new Map<number, { n: number; since: number }>();

  /** A task that just started (and crashed or failed to launch) waits taskRetryMs before the next try, longer after failures in a row. */
  inBackoff(id: number): boolean {
    const wait = this.cfg.timers.taskRetryMs * Math.min(16, 2 ** Math.max(0, (this.briefFails.get(id)?.n ?? 0) - 1));
    return this.store.now() - (this.lastStartAt.get(id) ?? -Infinity) < wait;
  }

  /** A task worker between failed starts (#224): its start brings it up, nothing else wakes it (mailbox). */
  retrying(identity: string): boolean {
    // A standing worker is more than its task: a message to it wakes it as always.
    if (getIdentity(this.store, identity)?.team_kind !== 'task') return false;
    // Moving to the main server (moveLocal, fallbackLocal): its start here brings it up, not a wake there.
    const last = this.store.db.prepare('SELECT id FROM tasks WHERE identity = ? ORDER BY id DESC LIMIT 1').get(identity) as { id: number } | undefined;
    if (last && (this.movingLocal.has(last.id) || this.fallingBack.has(last.id)) && !this.shifts.current(identity)) return true;
    const t = this.store.db.prepare(`SELECT id FROM tasks WHERE identity = ? AND state IN ('queued','open','interrupted') ORDER BY id DESC LIMIT 1`)
      .get(identity) as { id: number } | undefined;
    return !!t && this.briefFails.has(t.id) && !this.shifts.current(identity);
  }

  /**
   * #224: a start that did not take (its brief never accepted, or the launch failed). Not his business: the task
   * waits a longer backoff and tries again, and after BRIEF_FAILS in a row the monitoring lead hears of it once.
   */
  private startFailed(taskId: number, why: string): void {
    const t = this.task(taskId);
    if (!t || t.state === 'done') return;
    const now = this.store.now();
    const prev = this.briefFails.get(taskId);
    const f = { n: (prev?.n ?? 0) + 1, since: prev?.since ?? now };
    this.briefFails.set(taskId, f);
    this.lastStartAt.set(taskId, now);
    this.store.emit('task.start_not_taken', t.identity, { id: taskId, n: f.n, why });
    if (f.n !== BRIEF_FAILS) return;
    this.mailbox.tell({ msg_id: `hq-start-failing-t${taskId}-${f.since}`, from: 'hq', to: this.cfg.monitoringLeadId, kind: 'system', priority: 'next',
      body: [`משימה ${t.ref ?? `#${taskId}`} (${t.title}) לא עלתה ${BRIEF_FAILS} פעמים ברצף: ${why.slice(0, 300)}.`,
        `העובד (\`${t.identity ?? '—'}\`) לא קיבל את הבריף, או שהמשמרת לא עלתה. hq ממשיך לנסות עם המתנה ארוכה יותר. כדאי לבדוק את השרת (עומס, זיכרון) ואת היומן של המשמרת.`].join('\n') });
  }

  /** The brief of one run of a task's shift (start()'s prompt id). */
  private briefId(taskId: number, shift: { id: string; started_at: number }): string {
    return `task-${taskId}-${shift.id}-${shift.started_at}`;
  }

  /**
   * mailbox.sweep: a stale message that is a task's brief (its worker's shift is up but never took it). Instead of a
   * resurrection and a failure in his inbox, the brief is dropped, the shift stops and the task tries again (#224).
   * True when it was a brief and is handled here.
   */
  async briefStale(m: { id: string; to_identity: string; error: string | null }): Promise<boolean> {
    const id = Number(/^task-(\d+)-/.exec(m.id)?.[1]);
    if (!id || !m.id.startsWith(`task-${id}-${m.to_identity}-`) || this.mailbox.get(m.id)?.state !== 'queued') return false;
    const t = this.task(id);
    if (!t || t.identity !== m.to_identity || t.state === 'done') return false;
    // A lead's or a resident's shift is more than this task: it is resurrected as any (never stopped here).
    if (getIdentity(this.store, m.to_identity)?.team_kind !== 'task' && !this.standing(m.to_identity)) return false;
    // Every brief of the task still waiting (an older run's too): one failure, and none of them reaches the next run.
    this.mailbox.dropTaskPrompts(m.to_identity, id, 'brief not taken: the task starts again', `task-${id}-${m.to_identity}-`);
    this.startFailed(id, m.error ?? 'הבריף לא התקבל');
    const cur = this.shifts.current(m.to_identity);
    if (cur && cur.kind !== 'foreign' && cur.task_id === id) await this.shifts.stop(cur.id, BRIEF_FAILED, cur.started_at).catch(() => {});
    return true;
  }

  /**
   * Tasks whose start is in flight (worktree, commands.worktree_setup, launch): never picked twice, and their
   * slot is taken (slots()), so a slow setup (`flutter pub get`) holds only its own task, not the queue. It
   * overlaps the new shift row briefly: never too many, and the pass after the starts settle fills what it hid.
   */
  private starting = new Map<number, string>(); // task → the machine it starts on

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
      // #224: a node's memory and load as they are now, not as the last poll saw them (the machine may have choked since).
      // Read in the background: a task that could go to a node being read waits for the read (its end fills again);
      // everything else starts now.
      this.refreshNodes();
      do {
        this.refill = false;
        let free = this.slots().free;
        const nodeFree = new Map(this.nodeSlots().map((n) => [n.name, n.free]));
        // A standing worker takes one task at a time: one starting in this fill holds it too.
        const busy = new Set([...this.starting.keys()].map((id) => this.task(id)?.identity).filter((x): x is string => !!x));
        for (const t of this.queue()) {
          if (this.starting.has(t.id) || this.fallingBack.has(t.id)) continue;
          // #224: placed on a node that is switched off now (or gone from the config): back to the queue, unplaced.
          if (t.machine && t.machine !== LOCAL && (!this.nodes?.get(t.machine) || !this.store.toggle(nodeToggle(t.machine)))) {
            this.store.bg(this.unpin(t, 'node switched off'), 'scheduler.unpin');
            continue;
          }
          if (this.reading.size && [...this.reading.keys()].some((n) => this.couldGoTo(t, n))) continue;
          if (free <= 0 && ![...nodeFree.values()].some((n) => n > 0)) break;
          const machine = this.placeFor(t, nodeFree);
          if ((machine === LOCAL ? free : nodeFree.get(machine) ?? 0) <= 0) continue;
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
          this.starting.set(t.id, machine);
          if (machine === LOCAL) free--; else nodeFree.set(machine, nodeFree.get(machine)! - 1);
          starts.push(this.start(t, machine).then((ok) => {
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

  /**
   * Why a task in the queue has not started, in his words (#128): what fill() would skip it for, else that every
   * slot is taken, or that the machine is too loaded (#224). `slots` is slots(), read once by the caller for the whole list.
   */
  waitReason(t: TaskRow, slots: { free: number; pressure?: 'load' | 'memory' | null }): string {
    const { free } = slots;
    if (!this.store.toggle('scheduler')) return 'התור עצור';
    if (this.starting.has(t.id)) return 'מתחילה עכשיו';
    if (this.fallingBack.has(t.id) && t.machine && t.machine !== LOCAL) return `חוזרת מ-${t.machine}`;
    if (this.dormant(t.project)) return 'הפרויקט לא פעיל';
    if (t.identity && this.standing(t.identity) && this.workerBusy(t.identity, t.id)) {
      return `מחכה ${pre('ש', getIdentity(this.store, t.identity)?.name ?? t.identity)} יתפנה`;
    }
    if (this.inBackoff(t.id)) return 'ניסיון חוזר בעוד רגע';
    const node = this.nodeCandidate(t);
    const there = node ? this.nodeSlots().find((n) => n.name === node.def.name) : undefined;
    if (t.machine && t.machine !== LOCAL) {
      // Switched off, or gone from the config: the next fill brings it back to the queue (unpin), once no shift of its is up.
      if (!this.nodes?.get(t.machine) || !this.store.toggle(nodeToggle(t.machine))) {
        return t.identity && this.shifts.current(t.identity) ? `${t.machine} כבוי` : 'מתחילה עכשיו';
      }
      if (!there?.up) return `מחכה ל-${t.machine}, שלא עונה`;
      if (there.free > 0) return 'מתחילה עכשיו';
      return there.busy ? `${t.machine} עמוס` : `מחכה למשבצת ב-${t.machine}`;
    }
    if (free > 0 || (there?.free ?? 0) > 0) return 'מתחילה עכשיו';
    return slots.pressure ? BUSY_REASON : 'מחכה למשבצת';
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
  private async start(t: TaskRow, machine: string = LOCAL): Promise<boolean> {
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
      // Placed now, before the worktree: the worktree and every shift of the task follow it (shifts.taskMachine).
      if (!t.machine && machine !== LOCAL) {
        this.store.db.prepare('UPDATE tasks SET machine = ? WHERE id = ? AND machine IS NULL').run(machine, t.id);
        t = { ...t, machine };
      }
      try {
        ws = await this.prepareWorktree(t);
      } catch (e) {
        // The node could not be reached: not a fault of the task. It goes back unplaced, and tries again (here, or
        // on a node that answers) after the backoff.
        if (e instanceof NodeUnreachable) {
          if (!t.worktree) this.store.db.prepare('UPDATE tasks SET machine = NULL WHERE id = ? AND worktree IS NULL').run(t.id);
          throw e;
        }
        // #224: on a node, its worktree there is gone and its branch too: nothing there to go back to. It goes back to
        // the queue unplaced, not out of it. Any other failure there is what it is for a task here (below).
        if (e instanceof WorktreeGone && t.machine && t.machine !== LOCAL) {
          const cur = this.task(t.id);
          if (cur && await this.unpin(cur, e.message, false)) return false;
        }
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
      if (!(e instanceof ShiftBusyError)) {
        // #224: a launch that failed (spawn, systemd) tries again after a longer backoff; his inbox hears nothing.
        this.startFailed(t.id, `launch: ${(e as Error).message}`);
        throw e;
      }
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
  async prepareWorktree(t: Pick<TaskRow, 'id' | 'project' | 'worktree' | 'labels' | 'started_at'> & { identity?: string | null; machine?: string | null }): Promise<{ path: string; note: string } | null> {
    const ch = t.project ? readCharter(this.cfg.companyDir, t.project) : null;
    const ws = this.workspacesFor(t.machine);
    if (t.worktree) {
      const { c } = this.checkoutOf(t);
      if (!(await ws.ensure(t.worktree, c?.path, ch ?? undefined))) throw new WorktreeGone(`task ${t.id}: worktree ${t.worktree} is gone and its branch too`);
      return { path: t.worktree, note: worktreeNote(t.worktree, ch) + nodeNote(t.machine) + this.charterNote(t) };
    }
    // Started before hq made worktrees: its session and work live where it ran (hq's default cwd and
    // a worktree the worker made itself). Moving it would orphan both.
    if (t.started_at != null) return null;
    if (!ch) return null;
    const repoLabel = (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith('repo:'))?.slice(5);
    const c = ws.checkout(ch, repoLabel);
    if (!c) return null;
    const w = await ws.create(ch, c, `company-t${t.id}`);
    this.store.db.prepare('UPDATE tasks SET worktree = ?, updated_at = ? WHERE id = ?').run(w.path, this.store.now(), t.id);
    this.store.emit('task.worktree', null, { id: t.id, path: w.path, branch: w.branch, base: w.base });
    return { path: w.path, note: worktreeNote(w.path, ch, w.branch, w.base) + nodeNote(t.machine) + this.charterNote(t) + movedNote(t) };
  }

  /**
   * A company-level worker (design's tom) on another project's task: its system prompt has no charter (it has
   * no project), so the task says where the charter is (skills, deviations, deploy).
   */
  private charterNote(t: { project: string | null; identity?: string | null }): string {
    if (!t.project || !t.identity) return '';
    const i = getIdentity(this.store, t.identity);
    if (!i || i.project === t.project) return '';
    return `\n**האמנה:** המשימה בפרויקט \`${t.project}\`. קרא את האמנה שלו לפני שמתחילים: \`${join(this.cfg.companyDir, 'projects', `${t.project}.md`)}\`.`;
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
      const r: CloseResult = await this.workspacesFor(t.machine).close(t.worktree!, c.defaultBranch);
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

  private onTaskShiftEnded(taskId: number, reason: string, machine: string = LOCAL, row?: { id: string; started_at: number }): void {
    const t = this.task(taskId);
    // On a node and its worker never took the task (did not come up, exited before accepting): it runs here instead.
    if (reason === NODE_FALLBACK) return; // fallbackLocal sets the task itself
    if (t && (machine ?? LOCAL) !== LOCAL && !['task_done', 'rest', 'account_switch'].includes(reason) && this.neverTook(t)) {
      this.store.bg(this.fallbackLocal(taskId, reason), 'scheduler.node_fallback');
      return;
    }
    // #224: this run's brief: never taken (claude died or never came up) is a failed start, not his business; taken
    // ends a run of failures.
    const brief = t && row ? this.mailbox.get(this.briefId(taskId, row)) : undefined;
    if (brief && brief.to_identity === t?.identity) {
      if (brief.state === 'queued' && !['task_done', 'rest', 'account_switch', 'resurrect', BRIEF_FAILED].includes(reason)) {
        this.mailbox.dropTaskPrompts(brief.to_identity, taskId, `brief not taken (${reason}): the task starts again`, `task-${taskId}-${brief.to_identity}-`);
        this.startFailed(taskId, brief.error ?? reason);
      } else if (['delivered', 'seen', 'handled'].includes(brief.state)) this.briefFails.delete(taskId);
    }
    if (!t || t.state !== 'running') return;
    // B.7: the account manager resumes this same shift on another account right away; the task keeps running.
    if (reason === 'account_switch') return;
    // done: closed by the worker. rest: idle worker released its process, the task waits for its next
    // message (not re-queued, or it would restart forever). Anything else: back to the head of the queue.
    const next = reason === 'task_done' ? 'done' : reason === 'rest' ? 'resting' : t.worktree ? 'interrupted' : 'queued';
    this.store.db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?').run(next, this.store.now(), taskId);
    this.store.emit('task.state', t.identity, { id: taskId, state: next, reason });
    if (next === 'done') { this.closeWorktree(taskId); this.handOverOpenGos(t); this.onTaskDone?.(taskId); }
  }

  /** No message to the task's worker since the task was opened was accepted by its CLI: it never started on the task (a standing worker has older messages from before). */
  private neverTook(t: TaskRow): boolean {
    return !t.identity || !this.store.db.prepare(`SELECT 1 FROM messages WHERE to_identity = ? AND state IN ('delivered','seen','handled') AND created_at >= ? LIMIT 1`).get(t.identity, t.created_at);
  }

  private fallingBack = new Set<number>();

  /**
   * A task placed on a node whose worker never took it there goes back to the queue, to run here (adi, 22/10/2026):
   * not a "message not delivered" for him, and not a resume loop on a session that never existed. Its prompt is
   * dropped (the start here sends its own), the worktree there closes like any (preserved), and `needs-local` keeps it
   * here. False when it does not apply (here already, done, or its worker did take it).
   */
  async fallbackLocal(taskId: number, why: string): Promise<boolean> {
    const t = this.task(taskId);
    if (!t || !t.machine || t.machine === LOCAL || t.state === 'done' || !this.neverTook(t)) return false;
    if (this.fallingBack.has(taskId)) return true;
    this.fallingBack.add(taskId);
    try {
      const db = this.store.db;
      // Its messages first: the prompt there is dropped, and the others wait for the shift here (mailbox waitsForStart:
      // nothing wakes or resurrects the worker until the start here brings it up, and its flush delivers them).
      if (t.identity) this.mailbox.dropTaskPrompts(t.identity, taskId, `not taken on ${t.machine}: the task runs here`);
      const cur = t.identity ? this.shifts.current(t.identity) : undefined;
      if (cur && cur.kind !== 'foreign') await this.shifts.stop(cur.id, NODE_FALLBACK, cur.started_at).catch(() => {});
      const labels = [...new Set([...(JSON.parse(t.labels || '[]') as string[]), NEEDS_LOCAL])];
      db.prepare(`UPDATE tasks SET machine = NULL, worktree = NULL, state = 'queued', shift_id = NULL, started_at = NULL, labels = ?, updated_at = ?
        WHERE id = ? AND state != 'done'`).run(JSON.stringify(labels), this.store.now(), taskId);
      this.lastStartAt.delete(taskId);
      this.store.emit('task.node_fallback', t.identity, { id: taskId, machine: t.machine, why });
      this.store.emit('task.state', t.identity, { id: taskId, state: 'queued', reason: NODE_FALLBACK });
      this.store.bg(this.closeThere(t), 'task.node_fallback.close');
    } finally {
      this.fallingBack.delete(taskId);
    }
    this.store.bg(this.fill(), 'scheduler.fill');
    return true;
  }

  /**
   * A worker on a node that took its task and found it needs what exists only here (status state `needs-local`):
   * after its turn, its shift there ends, the task goes back to the queue with `needs-local`, and the next start here
   * gets the work from there (unpin: the branch and the preserved ref are fetched back, and the brief says where).
   */
  async moveLocal(taskId: number, why: string): Promise<boolean> {
    const t = this.task(taskId);
    if (!t || !t.machine || t.machine === LOCAL || t.state === 'done' || this.fallingBack.has(taskId) || this.movingLocal.has(taskId)) return false;
    this.movingLocal.add(taskId);
    let moved = false;
    try {
      const cur = t.identity ? this.shifts.current(t.identity) : undefined;
      if (cur && cur.kind !== 'foreign') await this.shifts.waitTurnEnd(cur.id, this.cfg.timers.turnEndWaitMs).catch(() => {});
      // Whatever shift it has there now (a crash may have brought up another run while the turn ended).
      const now = t.identity ? this.shifts.current(t.identity) : undefined;
      if (now && now.kind !== 'foreign') await this.shifts.stop(now.id, NODE_FALLBACK, now.started_at).catch(() => {});
      if (t.identity && this.shifts.current(t.identity)) return false;
      const fresh = this.task(taskId);
      if (!fresh || fresh.machine !== t.machine || fresh.state === 'done') return false;
      const labels = [...new Set([...(JSON.parse(fresh.labels || '[]') as string[]), NEEDS_LOCAL])];
      const r = this.store.db.prepare(`UPDATE tasks SET labels = ?, state = 'queued', updated_at = ? WHERE id = ? AND machine = ? AND state != 'done'`)
        .run(JSON.stringify(labels), this.store.now(), taskId, t.machine);
      if (!r.changes) return false;
      moved = !!(await this.unpin(this.task(taskId)!, `needs-local: ${why}`));
      // Not moved (it raced with something): back as it was, so it does not sit queued on the node.
      if (!moved) this.store.db.prepare(`UPDATE tasks SET state = ?, updated_at = ? WHERE id = ? AND machine = ? AND state = 'queued'`)
        .run(fresh.state, this.store.now(), taskId, t.machine);
      return moved;
    } finally {
      this.movingLocal.delete(taskId);
      this.store.emit('task.move_local', t.identity, { id: taskId, machine: t.machine, why, moved });
    }
  }

  private movingLocal = new Set<number>();

  /**
   * The worktree a task had on a node closes like any: uncommitted work preserved, and the preserved ref and a branch
   * with commits fetched back here (RemoteWorkspaces.close). fallbackLocal does not wait for it; unpin does.
   */
  private closeThere(t: TaskRow): Promise<string | null> {
    const { c } = t.worktree ? this.checkoutOf(t) : { c: undefined };
    if (!t.worktree || !c || !t.machine || !this.nodes?.get(t.machine)) return Promise.resolve(null);
    const failed = (error: string) => {
      this.store.emit('task.worktree_close_failed', t.identity, { id: t.id, path: t.worktree, machine: t.machine, error });
      return error;
    };
    return this.workspacesFor(t.machine).close(t.worktree, c.defaultBranch)
      .then((r) => (r.error && r.error !== 'missing' ? failed(r.error) : null), (e: Error) => failed(e.message));
  }

  /**
   * #224: a task in the queue placed on a node it cannot run on now (switched off, gone from the config, or its
   * worktree there is gone) goes back to the queue unplaced, with no session there to resume: it starts fresh where
   * fill() puts it. Its worktree there closes first (preserved, and its branch and preserved ref fetched back here), and
   * a task that had started there says so in its next brief (MOVED_FROM; not when its worktree there was gone,
   * `carried` false). Nothing moves while a shift of its worker is
   * up. Returns the task as it is now, or undefined when it was left alone.
   */
  private async unpin(t: TaskRow, why: string, carried = true): Promise<TaskRow | undefined> {
    if (!t.machine || t.machine === LOCAL || (t.identity && this.shifts.current(t.identity)) || this.fallingBack.has(t.id)) return undefined;
    this.fallingBack.add(t.id);
    try {
      // A choked or unreachable node does not hold the task for the close's own timeout: past UNPIN_CLOSE_MS the close
      // goes on in the background, and the brief says the work may still be there.
      let timer: NodeJS.Timeout | undefined;
      const closeError = await Promise.race([this.closeThere(t),
        new Promise<string>((res) => { timer = setTimeout(() => {
          const error = `no answer from ${t.machine} in ${UNPIN_CLOSE_MS / 1000}s (the close goes on there)`;
          this.store.emit('task.worktree_close_timeout', t.identity, { id: t.id, path: t.worktree, machine: t.machine });
          res(error);
        }, UNPIN_CLOSE_MS); })])
        .finally(() => clearTimeout(timer));
      const labels = (JSON.parse(t.labels || '[]') as string[]).filter((l) => !l.startsWith(MOVED_FROM) && !l.startsWith(LEFT_ON));
      // Where its work from there is now: fetched back here, or left there when the close failed.
      if (carried && t.started_at != null) labels.push(`${closeError ? LEFT_ON : MOVED_FROM}${t.machine}:${t.worktree}`);
      const r = this.store.db.prepare(`UPDATE tasks SET machine = NULL, worktree = NULL, state = 'queued', shift_id = NULL, started_at = NULL, labels = ?,
        updated_at = ? WHERE id = ? AND machine = ? AND state IN ('queued','open','interrupted')`).run(JSON.stringify(labels), this.store.now(), t.id, t.machine);
      if (!r.changes) return undefined;
      // Its prompts for the shift there are dropped: the start sends its own.
      if (t.identity) this.mailbox.dropTaskPrompts(t.identity, t.id, `unplaced from ${t.machine}: ${why}`);
      this.lastStartAt.delete(t.id);
      this.store.emit('task.unpinned', t.identity, { id: t.id, machine: t.machine, why });
      this.store.emit('task.state', t.identity, { id: t.id, state: 'queued', reason: 'unpinned' });
    } finally {
      this.fallingBack.delete(t.id);
    }
    this.store.bg(this.fill(), 'scheduler.fill');
    return this.task(t.id);
  }

  /** A task in the queue that could start on node `name` (pinned there, or a task of a project it lists that may leave here). */
  private couldGoTo(t: TaskRow, name: string): boolean {
    if (t.machine) return t.machine === name;
    const n = this.nodes?.get(name);
    return !!n && this.mayLeave(t) && n.def.projects.includes(t.project!);
  }

  /** Nodes being read right now (refreshNodes): their read is shared, and its end fills again. */
  private reading = new Map<string, Promise<unknown>>();

  /**
   * Nodes whose memory and load were read more than NODE_FRESH_MS ago are read again, in the background, when a task in
   * the queue could go there (switched-off ones are not). fill() holds only the tasks that could go to a node being
   * read (`reading`), and the read's end fills again. Nothing here waits on an ssh.
   */
  private refreshNodes(): void {
    if (!this.nodes?.list.length) return;
    const now = this.store.now();
    const stale = this.nodes.list.filter((n) => this.store.toggle(nodeToggle(n.def.name)) && (!n.status || now - n.status.at > NODE_FRESH_MS));
    if (!stale.length) return;
    const queue = this.queue();
    for (const n of stale) {
      const name = n.def.name;
      if (this.reading.has(name) || !queue.some((t) => this.couldGoTo(t, name))) continue;
      this.reading.set(name, this.pollNode(n).catch(() => {}).finally(() => {
        this.reading.delete(name);
        this.store.bg(this.fill(), 'scheduler.fill');
      }));
    }
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
      // A GO of its that he has not decided: the task stays, so his answer reaches the one who asked.
      const gos = this.mailbox.openGos(identity, t.started_at ?? t.created_at);
      if (gos.length) {
        this.mailbox.tell({ msg_id: `${last.opId}-go-open`, from: 'hq', to: identity, kind: 'system', priority: 'now', ref: `inbox-${gos[0]!.id}`,
          body: `המשימה לא נסגרה: בקשת ה-GO "${gos[0]!.headline ?? gos[0]!.title}" (inbox ${gos[0]!.id}) עדיין פתוחה אצל ${this.mailbox.names.owner.name}. `
            + `חכה לתשובה (היא תגיע אליך כהודעה), פעל לפיה, ואז \`status\` עם \`state: "done"\` שוב.` });
        this.store.emit('task.close_waiting', identity, { id, go: gos.map((x) => x!.id) });
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
      this.handOverOpenGos(t);
    }
    // A standing worker's next task may be waiting for this one.
    queueMicrotask(() => this.store.bg(this.fill(), 'scheduler.fill'));
    return this.task(id);
  }

  /** The task closed with a GO of its still open (close_team with force, the owner): the one responsible hears it is theirs now. */
  private handOverOpenGos(t: TaskRow): void {
    if (!t.identity) return;
    const gos = this.mailbox.openGos(t.identity);
    const to = gos.length ? this.mailbox.responsibleFor(t.identity) : null;
    if (!to || to === t.identity) return;
    this.mailbox.tell({ msg_id: `task-${t.id}-go-handover`, from: 'hq', to, kind: 'system', priority: 'next',
      body: `${this.mailbox.label(t.identity)} נסגר כשבקשת ה-GO שלו עוד פתוחה: ${gos.map((x) => `"${x!.headline ?? x!.title}" (inbox ${x!.id})`).join(', ')}. `
        + `התשובה של ${this.mailbox.names.owner.name} עליה (וכל מה שיכתוב לעובד שנסגר) תגיע אליך, והפעולה אחריה עליך.` });
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

  /**
   * #175: a task whose worker rested (idle, no message waiting) is left with no one on it: whatever it waited for (CI, a
   * simulator) told its end to a process that is gone. restWakeMs after the rest hq wakes it once with a note; the id is
   * fixed per rest (updated_at), so a sweep or a restart never sends it twice. A worker waiting for his answer, or with
   * mail on the way, is woken by that. At most REST_WAKES per task: past that it waits for a message (stall-watch sees
   * the project standing). Returns the tasks it woke.
   */
  wakeResting(): number[] {
    if (!this.store.toggle('scheduler')) return [];
    const cutoff = this.store.now() - this.cfg.timers.restWakeMs;
    const rows = this.store.db.prepare(`SELECT t.id, t.identity, t.updated_at FROM tasks t WHERE t.state = 'resting' AND t.identity IS NOT NULL
        AND t.updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.identity = t.identity AND s.state IN ('starting','live'))
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.to_identity = t.identity AND m.state IN ('queued','delivered'))
        AND NOT EXISTS (SELECT 1 FROM asks a WHERE a.from_identity = t.identity AND a.state IN ('open','escalated'))`)
      .all(cutoff) as { id: number; identity: string; updated_at: number }[];
    const woke: number[] = [];
    for (const t of rows) {
      const msgId = `task-${t.id}-rest-wake-${t.updated_at}`;
      if (this.mailbox.get(msgId)) continue;
      const n = (this.store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE id LIKE ?`).get(`task-${t.id}-rest-wake-%`) as { n: number }).n;
      if (n >= REST_WAKES) continue;
      this.mailbox.tell({ msg_id: msgId, from: 'hq', to: t.identity, kind: 'system', priority: 'next',
        body: [`נחת באמצע המשימה ${Math.round(this.cfg.timers.restWakeMs / 60_000)} דקות, ואף אחד לא עבד עליה. בדוק את מה שחיכית לו ותמשיך.`,
          'עבודה שהרצת ברקע לפני שנחת כבר לא רצה, וההודעה על הסיום שלה לא תגיע: בדוק את התוצאה בעצמך (למשל `gh pr checks`), או הרץ אותה מחדש.',
          'אם המשימה גמורה, סגור אותה עם `status`. אם אתה מחכה למישהו, כתוב לו ב-`tell` או ב-`ask`.'].join('\n') });
      this.store.emit('scheduler.rest_wake', t.identity, { task: t.id, msg: msgId });
      woke.push(t.id);
    }
    return woke;
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

  /** Adds and removes labels (PATCH /api/tasks/:id): a lead keeps a queued task here (`needs-local`) with no DB edit. */
  setTaskLabels(id: number, add: string[], remove: string[]): TaskRow | undefined {
    const cur = this.task(id);
    if (!cur) return undefined;
    const labels = [...new Set([...(JSON.parse(cur.labels || '[]') as string[]), ...add])].filter((l) => !remove.includes(l));
    this.store.db.prepare('UPDATE tasks SET labels = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(labels), this.store.now(), id);
    const t = this.task(id)!;
    this.store.emit('task.labels', t.identity, { id, labels });
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
    this.wakeResting();
    await this.restOnPressure();
    await this.fill();
    // Empty-slot measurement (metric.empty_slot) is night.ts: per interval, with its reason.
    await this.retryCloses();
    this.onSweep?.();
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

/** A task on a node: what is not there, and how it moves to the main server when it needs that (moveLocal). */
function nodeNote(machine?: string | null): string {
  if (!machine || machine === LOCAL) return '';
  return `\n**רץ בשרת השני (\`${machine}\`).** יש בו את ה-checkouts וה-toolchains, אבל אין בו מפתחות ssh, \`.env\`, kubectl, סודות של hq-host, דפדפן או סימולטור. `
    + 'כשהמשימה צריכה אחד מהם: קודם `commit` למה שיש (גם WIP), ואז `status` עם `state: "needs-local"` ו-`note` שאומר מה חסר. המשמרת כאן נגמרת, והמשימה ממשיכה בשרת הראשי מהענף שלך.';
}

/** A task that started on a node and came back (unpin): where its work from there is now (fetched back on close). */
function movedNote(t: { id: number; labels: string }): string {
  const labels = JSON.parse(t.labels || '[]') as string[];
  const left = labels.find((l) => l.startsWith(LEFT_ON))?.slice(LEFT_ON.length);
  if (left) {
    const [node, ...rest] = left.split(':');
    const path = rest.join(':');
    const name = path.split('/').pop();
    return `\n**המשימה התחילה ב-\`${node}\` וחזרה לכאן, וייתכן שהעבודה משם לא נמשכה** (הסגירה שם נכשלה או לא ענתה). אם היא לא כאן, היא ב-\`${node}\`: ב-worktree \`${path}\`, או בענף \`${name}\` וב-\`refs/company/preserved/${name}\` שם. בדוק קודם אם הענף וה-ref הגיעו לכאן, ואם צריך את העבודה משם, כתוב למי ששלח את המשימה לפני שמתחילים מחדש.`;
  }
  const moved = labels.find((l) => l.startsWith(MOVED_FROM))?.slice(MOVED_FROM.length);
  if (!moved) return '';
  const [from, ...rest] = moved.split(':');
  const name = rest.join(':').split('/').pop() || `company-t${t.id}`;
  return `\n**המשימה התחילה ב-\`${from}\` וחזרה לכאן.** מה שנעשה שם נמשך ל-checkout הזה: הענף \`${name}\` (אם היו בו commits) ו-\`refs/company/preserved/${name}\` (שינויים שלא קומטו). בדוק אותם והמשך מהם, לא מאפס.`;
}
