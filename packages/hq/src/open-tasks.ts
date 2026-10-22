// "בעבודה ובתור" (#128): every task that is not done, wherever it runs, the way he reads it. A task opened by
// Yoav that runs under a project worker, or waits in the queue, used to show nowhere he looks; now it is in
// the opener's row in his conversations ("מה פתוח אצלי"), at the top of "סטטוס", and in the home block
// `tasks {tasks: [ids] | "open"}`. Derived at read time from the tasks, the queue and the board, nothing kept.
import type { BoardEntry } from './board.ts';
import { projectLead } from './org.ts';
import { BUSY_REASON, type Scheduler, type TaskRow } from './scheduler.ts';
import type { Store } from './store.ts';

/** running: a worker is on it · queued: waits its turn · waiting_for_you: its worker waits for him · blocked: waits for a decision. */
export type OpenTaskState = 'running' | 'queued' | 'waiting_for_you' | 'blocked';

export interface OpenTask {
  id: number; ref: string | null; project: string | null;
  /** In his words: without the area prefix ("hq: ", "אפליקציה: ") and without PR or issue numbers. */
  title: string;
  /** Who opened it (`opened-by:` label); without one, the project's lead. Its row in his conversations shows it. */
  opened_by: string | null;
  /** The worker on it; null while it waits for a slot. */
  worker: string | null;
  state: OpenTaskState;
  /** Its place in the queue, from 1; null when it is not in the queue. */
  position: number | null;
  /** Why it waits, one short line ("מחכה למשבצת"); null when it runs. */
  reason: string | null;
  /** Since when it is in this state: started (running), asked (waiting for him), opened (queued). */
  since: number;
}

/** A task title as one line for him (the app's plainTitle in models.dart, kept the same). */
export function plainTitle(title: string): string {
  let t = title.trim().replace(/\s*\(#\d+\)/g, '').replace(/\s*\bPR\s*#\d+/g, '').replace(/^#\d+\s+/, '').replace(/\s+#\d+\b/g, '');
  const m = /^([^:]{1,14}):\s+/.exec(t);
  if (m) t = t.slice(m[0].length);
  t = t.trim();
  return t || title.trim();
}

const OPENED_BY = 'opened-by:';
export function openedBy(t: Pick<TaskRow, 'labels'>): string | null {
  try {
    return (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith(OPENED_BY))?.slice(OPENED_BY.length) || null;
  } catch { return null; }
}

/** Running first (oldest start first), then what waits for him, then the queue in its order, then the blocked. */
export function openTasks(store: Store, scheduler: Scheduler, board: BoardEntry[], busy?: () => { reason: 'memory' | 'load'; waiting_for: string | null; eta_min: number | null }): OpenTask[] {
  const tasks = store.db.prepare(`SELECT * FROM tasks WHERE state NOT IN ('done','closed') ORDER BY created_at, id`).all() as TaskRow[];
  if (!tasks.length) return [];
  const queue = scheduler.queue().map((t) => t.id);
  const slots = scheduler.slots();
  const byId = new Map(board.map((b) => [b.id, b]));
  const askSince = store.db.prepare(`SELECT MIN(created_at) t FROM asks WHERE from_identity = ? AND state IN ('open','escalated')`);
  let busyNow: { reason: 'memory' | 'load'; waiting_for: string | null; eta_min: number | null } | undefined;
  const leads = new Map<string, string | null>();
  const lead = (p: string) => { if (!leads.has(p)) leads.set(p, projectLead(store, p) ?? null); return leads.get(p)!; };
  const out = tasks.map((t): OpenTask => {
    const labels = (() => { try { return JSON.parse(t.labels || '[]') as string[]; } catch { return []; } })();
    const pos = queue.indexOf(t.id);
    // A worker is on it: running, resting on a message, or started where its identity runs (no worktree to restart in).
    const on = t.state === 'running' || t.state === 'resting'
      || (pos < 0 && (t.state === 'open' || t.state === 'interrupted') && t.started_at != null && t.identity != null);
    const b = t.identity ? byId.get(t.identity) : undefined;
    let state: OpenTaskState;
    let reason: string | null = null;
    let since = t.created_at;
    if (on && b?.status === 'waiting_for_you') {
      state = 'waiting_for_you';
      since = (askSince.get(t.identity) as { t: number | null }).t ?? t.updated_at;
    } else if (on && t.state === 'resting' && b?.live !== true) {
      // #175: its worker rested and no one is on it now; hq wakes it (scheduler.wakeResting), or a message does.
      state = 'queued';
      reason = 'העובד נח';
      since = t.updated_at;
    } else if (on) {
      state = 'running';
      since = t.started_at ?? t.updated_at;
    } else if (pos >= 0) {
      state = 'queued';
      reason = scheduler.waitReason(t, slots);
      // "השרת עמוס" says nothing: who holds the machine, and when it is expected to free (resources-design.md §2).
      if (reason === BUSY_REASON && busy) {
        const b = (busyNow ??= busy());
        reason = `${b.reason === 'load' ? 'מחכה שהעומס יירד' : 'מחכה לזיכרון'}${b.waiting_for ? `: ${b.waiting_for}` : ''}${b.eta_min != null ? ` · כ-${b.eta_min} דקות` : ''}`;
      }
    } else {
      // Out of the queue: a decision it waits for, or night mode keeps it for the day.
      const decision = t.state === 'parked' || t.state === 'needs_decision' || labels.includes('needs-decision');
      const scope = scheduler.scope();
      state = decision ? 'blocked' : 'queued';
      reason = decision ? 'מחכה להחלטה' : scope && !scope.includes(t.project ?? '') ? 'מחוץ להיקף הלילה' : 'מחכה לשיבוץ';
      since = t.updated_at;
    }
    return {
      id: t.id, ref: t.ref, project: t.project, title: plainTitle(t.title),
      opened_by: openedBy(t) ?? (t.project ? lead(t.project) : null),
      worker: on && state !== 'queued' ? t.identity : null,
      state, position: state === 'queued' && pos >= 0 ? pos + 1 : null, reason, since,
    };
  });
  const rank: Record<OpenTaskState, number> = { running: 0, waiting_for_you: 1, queued: 2, blocked: 3 };
  return out.sort((a, b) => rank[a.state] - rank[b.state]
    || (a.state === 'queued' ? (a.position ?? Infinity) - (b.position ?? Infinity) : 0)
    || a.since - b.since || a.id - b.id);
}
