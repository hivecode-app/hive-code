// "מה לבדוק" (#108): a finished task that still waits on something. `deploy` = merged, waits for GO or a
// deploy. `check` = deployed, and he has to check something himself. `verify` = to check before it is released
// (a TestFlight build). One line in his words (awaiting_note). The worker marks it with status done, the lead
// with close_team. A deploy that reports the task (by id, or by its PR in the project's repo) clears `deploy`;
// he clears any of them with "בדקתי".
//
// #219: whatever waits on him is also in "מחכה לך", one inbox item (kind `awaiting`, ref `task-<id>`) per task,
// with "בוצע", "נכשל" and "לא רלוונטי" (#297). `check` and `verify` at once. `deploy` is not his until it is stuck: only after
// DEPLOY_STUCK_MS with no GO about it (a GO asked is already his card there; a GO given waits on the deployer).
//
// #297: a `deploy` also clears when its follow-ups are through. A follow-up names the task in its title ("משימה 500:
// פריסת ride-matcher"), as leads open them; once every follow-up is closed and none of them waits on a deploy itself,
// the deploy they were opened for is done, even when the deploy report named only them.
import type { Inbox } from './inbox.ts';
import type { Store } from './store.ts';

export const AWAITING = ['deploy', 'check', 'verify'] as const;
export type Awaiting = (typeof AWAITING)[number];

export interface AwaitingTask {
  id: number; ref: string | null; project: string | null; title: string; summary: string | null; identity: string | null;
  awaiting: Awaiting; awaiting_note: string | null; awaiting_at: number; pr: string | null;
}

/** A `deploy` with no GO about it shows up in "מחכה לך" after this long without a deploy. */
export const DEPLOY_STUCK_MS = 6 * 3600_000;

/** What he tapped on the task's card. */
export type AwaitingOutcome = 'done' | 'failed' | 'irrelevant';

/** "נכשל" or "לא רלוונטי" on the task's card: [to] (its opener) hears which. */
export type AwaitingTell = (t: AwaitingTask, itemId: number, to: string, outcome: Exclude<AwaitingOutcome, 'done'>) => void;

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
  private inbox: Inbox | null;
  /** Tells the task's opener he said "נכשל" (hq.ts wires it to the mailbox). */
  onOutcome: AwaitingTell = () => {};
  /** Whose the card is: the task's opener, who hears "נכשל". Null: nobody who can hear it. */
  openerOf: (t: { project: string | null; labels: string }) => string | null = () => null;
  /** A project's GitHub repo (owner/name), for the PR's link under a decision. */
  repoOf: (project: string, worktree: string | null) => string | null = () => null;
  constructor(store: Store, inbox: Inbox | null = null) { this.store = store; this.inbox = inbox; }

  /**
   * What a closer says about a finished task. `awaiting` deploy|check|verify sets it (with its note), `none` clears it,
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
      // The same kind again (a lead fixing the note) keeps its time: a stuck deploy's 6 hours don't restart.
      this.store.db.prepare(`UPDATE tasks SET awaiting_at = CASE WHEN awaiting IS ? THEN awaiting_at ELSE ? END,
        awaiting = ?, awaiting_note = ? WHERE id = ?`).run(a.awaiting, this.store.now(), a.awaiting, note, taskId);
    } else if (note) {
      this.store.db.prepare('UPDATE tasks SET awaiting_note = ? WHERE id = ? AND awaiting IS NOT NULL').run(note, taskId);
    } else {
      return this.get(taskId);
    }
    const t = this.get(taskId);
    if (t) this.store.emit('task.awaiting', t.identity, { id: taskId, awaiting: t.awaiting, note: t.awaiting_note, by });
    this.sync(taskId);
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
  clear(taskId: number, by: string, why: 'checked' | 'deployed' | 'cleared' | 'failed' | 'irrelevant' | 'followups' = 'cleared'): boolean {
    const t = this.get(taskId);
    if (!t) return false;
    this.store.db.prepare('UPDATE tasks SET awaiting = NULL, awaiting_note = NULL, awaiting_at = NULL WHERE id = ?').run(taskId);
    this.store.emit('task.awaiting', t.identity, { id: taskId, awaiting: null, was: t.awaiting, why, by });
    this.sync(taskId);
    // A follow-up no longer waiting on a deploy may be the last thing its parent waited for.
    if (t.awaiting === 'deploy') this.followUpDone(taskId);
    return true;
  }

  /**
   * A task closed, or stopped waiting on a deploy: each task it is a follow-up of (named in its title) and that waits on a
   * deploy is cleared once all its follow-ups are closed and none of them waits on a deploy. Returns the ids cleared.
   */
  followUpDone(taskId: number): number[] {
    const t = this.store.db.prepare('SELECT id, title, project, state, awaiting FROM tasks WHERE id = ?').get(taskId) as FollowUp | undefined;
    if (!t || t.state !== 'done' || t.awaiting === 'deploy') return [];
    const cleared: number[] = [];
    for (const pid of parentsOf(t)) {
      const p = this.get(pid);
      if (!p || p.awaiting !== 'deploy' || (p.project && t.project && p.project !== t.project)) continue;
      const kids = this.store.db.prepare(`SELECT id, title, project, state, awaiting FROM tasks WHERE id > ? AND title LIKE ?`)
        .all(pid, `%${pid}%`) as FollowUp[];
      const mine = kids.filter((k) => parentsOf(k).includes(pid) && (!p.project || !k.project || k.project === p.project));
      if (mine.every((k) => k.state === 'done' && k.awaiting !== 'deploy') && this.clear(pid, `task:${taskId}`, 'followups')) cleared.push(pid);
    }
    return cleared;
  }

  /**
   * "בוצע", "נכשל" or "לא רלוונטי" on the task's card in "מחכה לך": the task leaves both lists; on "נכשל" and on
   * "לא רלוונטי" its opener hears which (#297: "לא רלוונטי" closes it without saying anything failed).
   * Null when the item is not an open `awaiting` item (handled on another device a moment ago).
   */
  outcome(itemId: number, outcome: AwaitingOutcome): AwaitingTask | null {
    const item = this.inbox?.get(itemId);
    if (!item || item.kind !== 'awaiting' || item.state !== 'open') return null;
    const taskId = taskOf(item.ref);
    const t = taskId == null ? null : this.get(taskId);
    // The item first: clear() → sync() would close it as `resolved` either way.
    this.inbox!.resolve(itemId, outcome === 'done' ? 'resolved' : 'dismissed');
    if (!t) return null;
    this.clear(t.id, 'owner', outcome === 'done' ? 'checked' : outcome);
    const to = outcome === 'done' ? null : this.openerOf(this.taskRow(t.id));
    if (to && outcome !== 'done') this.onOutcome(t, itemId, to, outcome);
    return t;
  }

  /** Every task's card as it should be: the boot migration of what waited before #219, and stuck deploys. */
  sweep(): void {
    if (!this.inbox) return;
    const ids = this.store.db.prepare(`SELECT id FROM tasks WHERE awaiting IS NOT NULL
      UNION SELECT CAST(substr(ref, 6) AS INTEGER) FROM inbox WHERE kind = 'awaiting' AND state = 'open'`).all() as { id: number }[];
    for (const r of ids) this.sync(r.id);
  }

  /** One task's card in "מחכה לך": opened, its words updated, or closed, by what the task waits for now. */
  sync(taskId: number): void {
    if (!this.inbox) return;
    const ref = `task-${taskId}`;
    const open = this.store.db.prepare(`SELECT id, title, body, headline, links FROM inbox WHERE kind = 'awaiting' AND ref = ? AND state = 'open'`)
      .all(ref) as { id: number; title: string; body: string; headline: string | null; links: string | null }[];
    const t = this.get(taskId);
    if (!t || !this.isHis(t)) {
      for (const o of open) this.inbox.resolve(o.id);
      return;
    }
    const title = (t.summary?.split('\n')[0]?.trim() || t.title).slice(0, 200);
    const headline = t.awaiting_note ?? title;
    const body = t.pr ? `${title} · PR #${t.pr}` : title;
    const repo = t.pr && t.project ? this.repoOf(t.project, this.worktreeOf(taskId)) : null;
    const links = repo ? JSON.stringify([{ kind: 'pr', url: `https://github.com/${repo}/pull/${t.pr}` }]) : null;
    const [cur, ...extra] = open;
    for (const o of extra) this.inbox.resolve(o.id);
    if (cur) {
      if (cur.title !== title || cur.headline !== headline || cur.body !== body || cur.links !== links) {
        this.store.db.prepare('UPDATE inbox SET title = ?, headline = ?, body = ?, links = ? WHERE id = ?').run(title, headline, body, links, cur.id);
        this.store.emit('inbox.updated', null, { id: cur.id });
      }
      return;
    }
    // No dedupe_key: the open card by ref is the dedupe, and a card closed earlier (a GO asked, then declined) must
    // be able to come back while the task still waits.
    this.inbox.add({ kind: 'awaiting', from_identity: this.openerOf(this.taskRow(taskId)), title, headline, body, ref, blocking: false,
      links: links ? JSON.parse(links) : null });
  }

  private worktreeOf(id: number): string | null {
    return (this.store.db.prepare('SELECT worktree FROM tasks WHERE id = ?').get(id) as { worktree: string | null } | undefined)?.worktree ?? null;
  }

  private taskRow(id: number): { project: string | null; labels: string } {
    const r = this.store.db.prepare('SELECT project, labels FROM tasks WHERE id = ?').get(id) as { project: string | null; labels: string | null } | undefined;
    return { project: r?.project ?? null, labels: r?.labels ?? '[]' };
  }

  /** check and verify are his at once; a deploy only once it is stuck with no GO about it. */
  private isHis(t: AwaitingTask): boolean {
    if (t.awaiting !== 'deploy') return true;
    if (this.store.now() - t.awaiting_at < DEPLOY_STUCK_MS) return false;
    return !this.goAbout(t);
  }

  /**
   * A GO about this task that is asked (already his card) or given (waits on the deployer). A declined one is not:
   * the deploy is stuck again. About it = asked by the task's own worker, or naming its PR (a GO from the same
   * project: a PR number means nothing outside its repo) or `t<id>` / `task-<id>` / "משימה <id>".
   */
  private goAbout(t: AwaitingTask): boolean {
    const since = (this.store.db.prepare('SELECT created_at FROM tasks WHERE id = ?').get(t.id) as { created_at: number } | undefined)?.created_at ?? 0;
    const gos = this.store.db.prepare(`SELECT g.from_identity, g.title, g.body, g.headline, i.project, i.team_kind FROM inbox g
      LEFT JOIN identities i ON i.id = g.from_identity WHERE g.kind = 'go' AND g.state != 'dismissed' AND g.created_at >= ?`)
      .all(since) as { from_identity: string | null; title: string; body: string; headline: string | null; project: string | null; team_kind: string | null }[];
    const pr = t.pr ? new RegExp(`#${t.pr}(?!\\d)`) : null;
    const id = new RegExp(`(?:\\bt|task-|משימה )${t.id}(?!\\d)`);
    return gos.some((g) => {
      const text = `${g.title}\n${g.headline ?? ''}\n${g.body}`;
      if (t.identity && g.from_identity === t.identity && g.team_kind === 'task') return true;
      if (pr && t.project && g.project === t.project && pr.test(text)) return true;
      return id.test(text);
    });
  }


  /**
   * The PRs of [project] that are merged and wait for a deploy, for scripts/drift-check.sh: a task that waits
   * (`awaiting=deploy`), or one with a GO about it, asked or given (goAbout); and any PR a live GO of the project's
   * own identities names. These are not drift: production is behind main on purpose until the deploy.
   */
  waitingDeploy(project: string): { prs: string[]; tasks: { id: number; pr: string | null; why: 'awaiting' | 'go' }[] } {
    const since = this.store.now() - 14 * 86400_000;
    const rows = this.store.db.prepare(`SELECT ${COLS} FROM tasks WHERE project = ? AND (awaiting = 'deploy' OR created_at >= ?)`)
      .all(project, since) as AwaitingTask[];
    const tasks: { id: number; pr: string | null; why: 'awaiting' | 'go' }[] = [];
    for (const t of rows) {
      if (t.awaiting === 'deploy') tasks.push({ id: t.id, pr: t.pr, why: 'awaiting' });
      else if (t.pr && this.goAbout({ ...t, awaiting: 'deploy' })) tasks.push({ id: t.id, pr: t.pr, why: 'go' });
    }
    const prs = new Set(tasks.map((t) => t.pr).filter((p): p is string => !!p));
    const gos = this.store.db.prepare(`SELECT g.title, g.body, g.headline FROM inbox g JOIN identities i ON i.id = g.from_identity
      WHERE g.kind = 'go' AND g.state != 'dismissed' AND g.created_at >= ? AND i.project = ?`)
      .all(since, project) as { title: string; body: string; headline: string | null }[];
    for (const g of gos) for (const m of `${g.title}\n${g.headline ?? ''}\n${g.body}`.matchAll(/#(\d+)(?!\d)/g)) prs.add(m[1]!);
    return { prs: [...prs], tasks };
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

interface FollowUp { id: number; title: string; project: string | null; state: string; awaiting: string | null }

/** The tasks a task follows up on: "משימה 500: …", "t500", "task-500" in its title, older than it. */
function parentsOf(t: Pick<FollowUp, 'id' | 'title'>): number[] {
  // Not "t3.micro" or "משימה 2 מתוך 3".
  const ids = [...t.title.matchAll(/(?:משימה |\bt|task-)(\d+)(?![\d.])(?! מתוך)/g)].map((m) => Number(m[1]));
  return [...new Set(ids)].filter((n) => n < t.id);
}

/** `task-12` → 12. */
const taskOf = (ref: string | null): number | null => { const m = /^task-(\d+)$/.exec(ref ?? ''); return m ? Number(m[1]) : null; };
