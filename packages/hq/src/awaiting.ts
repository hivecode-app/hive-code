// "מה לבדוק" (#108): a finished task that still waits on something. `deploy` = merged, waits for GO or a
// deploy. `check` = deployed, and he has to check something himself. One line in his words (awaiting_note).
// The worker marks it with status done, the lead with close_team. A deploy that reports the task (by id, or
// by its PR in the project's repo) clears `deploy`; he clears either one with "בדקתי".
import type { Store } from './store.ts';

export const AWAITING = ['deploy', 'check'] as const;
export type Awaiting = (typeof AWAITING)[number];

export interface AwaitingTask {
  id: number; ref: string | null; project: string | null; title: string; summary: string | null; identity: string | null;
  awaiting: Awaiting; awaiting_note: string | null; awaiting_at: number; pr: string | null;
}

export interface DeployReport {
  project: string; sha: string; target?: string | null;
  /** hq task ids it includes (a task's branch is company-t<id>). */
  tasks?: number[];
  /** PR numbers (or URLs) it includes, in the project's repo. */
  prs?: string[];
}

/** One line, cut: what he reads. */
const line = (v: unknown, max = 200): string | null => {
  if (typeof v !== 'string') return null;
  const l = v.split('\n')[0]!.trim();
  return l ? l.slice(0, max) : null;
};

/** "#12", "12" and ".../pull/12" are the same PR. */
export function prNumber(v: unknown): string | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = /^#?(\d+)$/.exec(s) ?? /\/pull\/(\d+)\b/.exec(s);
  return m ? m[1]! : null;
}

export class AwaitingBoard {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /**
   * What a closer says about a finished task. `awaiting` deploy|check sets it (with its note), `none` clears it,
   * anything else leaves it. A note alone updates the note of what is already set. `pr` is kept for deploys.
   */
  mark(taskId: number, a: { awaiting?: unknown; awaiting_note?: unknown; pr?: unknown }, by: string): AwaitingTask | null {
    const pr = prNumber(a.pr);
    if (pr) this.store.db.prepare('UPDATE tasks SET pr = ? WHERE id = ?').run(pr, taskId);
    const note = line(a.awaiting_note);
    if (a.awaiting === 'none') {
      this.clear(taskId, by);
      return null;
    }
    if (AWAITING.includes(a.awaiting as Awaiting)) {
      this.store.db.prepare('UPDATE tasks SET awaiting = ?, awaiting_note = ?, awaiting_at = ? WHERE id = ?')
        .run(a.awaiting, note, this.store.now(), taskId);
    } else if (note) {
      this.store.db.prepare('UPDATE tasks SET awaiting_note = ? WHERE id = ? AND awaiting IS NOT NULL').run(note, taskId);
    } else {
      return this.get(taskId);
    }
    const t = this.get(taskId);
    if (t) this.store.emit('task.awaiting', t.identity, { id: taskId, awaiting: t.awaiting, note: t.awaiting_note, by });
    return t;
  }

  get(taskId: number): AwaitingTask | null {
    return (this.store.db.prepare(`SELECT ${COLS} FROM tasks WHERE id = ? AND awaiting IS NOT NULL`).get(taskId) as AwaitingTask | undefined) ?? null;
  }

  /** Everything that waits, newest first: what the board's "מה לבדוק" shows. */
  list(): AwaitingTask[] {
    return this.store.db.prepare(`SELECT ${COLS} FROM tasks WHERE awaiting IS NOT NULL ORDER BY awaiting_at DESC, id DESC`).all() as AwaitingTask[];
  }

  /** He checked it ("בדקתי"), or a deploy took it: off the list. False if it wasn't on it. */
  clear(taskId: number, by: string, why: 'checked' | 'deployed' | 'cleared' = 'cleared'): boolean {
    const t = this.get(taskId);
    if (!t) return false;
    this.store.db.prepare('UPDATE tasks SET awaiting = NULL, awaiting_note = NULL, awaiting_at = NULL WHERE id = ?').run(taskId);
    this.store.emit('task.awaiting', t.identity, { id: taskId, awaiting: null, was: t.awaiting, why, by });
    return true;
  }

  /**
   * A deploy happened (scripts/deploy.sh, or any project's own deploy): record it, and clear `deploy` on every
   * task it includes. `check` stays: deployed is exactly when he has something to check.
   */
  deployed(r: DeployReport): { id: number; cleared: number[] } {
    const tasks = (r.tasks ?? []).filter((n) => Number.isInteger(n));
    const prs = [...new Set((r.prs ?? []).map(prNumber).filter((p): p is string => !!p))];
    const id = Number(this.store.db.prepare(`INSERT INTO deploys (project, sha, target, tasks, prs, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.project, r.sha, r.target ?? null, JSON.stringify(tasks), JSON.stringify(prs), this.store.now()).lastInsertRowid);
    // A task id is global; a PR number only means something inside its project.
    const rows = this.store.db.prepare(`SELECT id FROM tasks WHERE awaiting = 'deploy' AND (project = ? OR project IS NULL)
      AND (id IN (SELECT value FROM json_each(?)) OR (project = ? AND pr IN (SELECT value FROM json_each(?))))`)
      .all(r.project, JSON.stringify(tasks), r.project, JSON.stringify(prs)) as { id: number }[];
    const cleared = rows.filter((t) => this.clear(t.id, `deploy:${id}`, 'deployed')).map((t) => t.id);
    this.store.db.prepare('UPDATE deploys SET cleared = ? WHERE id = ?').run(JSON.stringify(cleared), id);
    this.store.emit('deploy.recorded', null, { id, project: r.project, sha: r.sha, target: r.target ?? null, cleared });
    return { id, cleared };
  }
}

const COLS = 'id, ref, project, title, summary, identity, awaiting, awaiting_note, awaiting_at, pr';
