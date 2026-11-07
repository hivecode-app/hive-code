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
//
// task 986: "מחכה לך" holds only what is blocked on him. A `check` or `verify` is a card in the conversation with the
// task's opener ("עובד" / "לא עובד"), with a message there that says what to check (onCard). A `deploy` is never his
// card: the lead bundles the project's merged work into one GO. One stuck DEPLOY_STUCK_MS with no GO about it reminds
// its opener once (onStuck). The old deploy cards close (#478: they came back after 6 hours even when deployed).
import type { Inbox } from './inbox.ts';
import type { Store } from './store.ts';

export const AWAITING = ['deploy', 'check', 'verify'] as const;
export type Awaiting = (typeof AWAITING)[number];

export interface AwaitingTask {
  id: number; ref: string | null; project: string | null; title: string; summary: string | null; identity: string | null;
  awaiting: Awaiting; awaiting_note: string | null; awaiting_at: number; pr: string | null;
  /** owner/name of `pr` (task 1476); null = not known (two repos could have that number; no guess). */
  pr_repo: string | null;
}

/** A `deploy` with no GO about it reminds its opener after this long without a deploy. */
export const DEPLOY_STUCK_MS = 6 * 3600_000;

/** A task merged and waiting for its release longer than this is stuck: the tasks tab marks it "תקועה". */
export const RELEASE_STUCK_MS = 7 * 86400_000;

/** Waits for its release (merged, no deploy yet) longer than RELEASE_STUCK_MS. */
export const releaseStuck = (t: { awaiting?: string | null; awaiting_at?: number | null }, now: number): boolean =>
  t.awaiting === 'deploy' && t.awaiting_at != null && now - t.awaiting_at > RELEASE_STUCK_MS;

/** What he tapped on the task's card. */
export type AwaitingOutcome = 'done' | 'failed' | 'irrelevant';

/** "נכשל" or "לא רלוונטי" on the task's card: [to] (its opener) hears which. */
export type AwaitingTell = (t: AwaitingTask, itemId: number, to: string, outcome: Exclude<AwaitingOutcome, 'done'>) => void;

export interface DeployReport {
  project: string; sha: string; target?: string | null;
  /** The repo its PRs are in (owner/name). Default: the project's repo (its first checkout). */
  repo?: string | null;
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

/** `https://github.com/o/r/pull/12` → "o/r"; anything else → null. */
export function prRepo(v: unknown): string | null {
  const m = typeof v === 'string' ? /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/\d+/.exec(v) : null;
  return m ? m[1]! : null;
}

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
  /** The project's own repo (its first checkout): what a PR number means in a deploy report that names no repo. */
  defaultRepoOf: (project: string) => string | null = () => null;
  /** The charter's checkouts (name, repo), first = where hq opens a task's worktree unless a `repo:` label names another. */
  checkoutsOf: (project: string) => { name: string; repo: string | null }[] = () => [];
  /** The PR links a task's own shift created (task-prs.ts). */
  prLinksOf: (taskId: number) => string[] = () => [];
  /** A new card to check: hq.ts says so in the opener's conversation. */
  onCard: (t: AwaitingTask, itemId: number, from: string | null) => void = () => {};
  /** A deploy stuck with no GO about it: hq.ts reminds its opener, once per wait. */
  onStuck: (t: AwaitingTask, to: string) => void = () => {};
  constructor(store: Store, inbox: Inbox | null = null) { this.store = store; this.inbox = inbox; }

  /**
   * What a closer says about a finished task. `awaiting` deploy|check|verify sets it (with its note), `none` clears it,
   * anything else leaves it. A note alone updates the note of what is already set. `pr` is kept for deploys.
   */
  mark(taskId: number, a: { awaiting?: unknown; awaiting_note?: unknown; pr?: unknown }, by: string): AwaitingTask | null {
    const pr = prNumber(a.pr);
    if (pr) this.store.db.prepare('UPDATE tasks SET pr = ?, pr_repo = ? WHERE id = ?').run(pr, prRepo(a.pr) ?? this.resolvePrRepo(taskId, pr), taskId);
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

  /**
   * The repo of a task's PR given as a bare number: the one PR link with that number its shift created, else the
   * checkout its worktree is in (repoOf). A closed task's worktree is gone: a task team (identity <project>-t<id>) ran
   * in the checkout hq opened it in, the one its `repo:` label names or the first. Null when it can't be told: no
   * guess between two repos (a standing worker's task ran wherever that worker works).
   */
  private resolvePrRepo(taskId: number, pr: string): string | null {
    const repos = new Set(this.prLinksOf(taskId).filter((u) => prNumber(u) === pr).map(prRepo).filter((r): r is string => !!r));
    if (repos.size === 1) return [...repos][0]!;
    if (repos.size > 1) return null;
    const t = this.store.db.prepare('SELECT project, worktree, identity, labels FROM tasks WHERE id = ?').get(taskId) as { project: string | null; worktree: string | null; identity: string | null; labels: string } | undefined;
    if (!t?.project) return null;
    const byWorktree = this.repoOf(t.project, t.worktree);
    if (byWorktree || t.worktree) return byWorktree;
    const checkouts = this.checkoutsOf(t.project);
    const label = (JSON.parse(t.labels || '[]') as string[]).find((l) => l.startsWith('repo:'))?.slice(5);
    if (label) return checkouts.find((c) => c.name === label)?.repo ?? null;
    return t.identity === `${t.project}-t${taskId}` ? checkouts[0]?.repo ?? null : null;
  }

  /**
   * Tasks that wait on a deploy with a PR and no repo (before v43): the repo from the PR link the closer gave in
   * `status`/`close_team` (its op in `ops` while the task was open), else resolvePrRepo. Idempotent.
   */
  backfillPrRepos(): number {
    const rows = this.store.db.prepare(`SELECT id, pr, identity, created_at, awaiting_at FROM tasks
      WHERE awaiting = 'deploy' AND pr IS NOT NULL AND pr_repo IS NULL`).all() as { id: number; pr: string; identity: string | null; created_at: number; awaiting_at: number | null }[];
    let n = 0;
    for (const t of rows) {
      // `status` comes from the task's worker; `close_team` from whoever closed it, naming the team (t<N> or its identity).
      const urls = (this.store.db.prepare(`SELECT json_extract(args, '$.pr') AS pr FROM ops
        WHERE ((op = 'status' AND identity = ?) OR (op = 'close_team' AND json_extract(args, '$.team') IN (?, ?)))
        AND received_at BETWEEN ? AND ? AND json_extract(args, '$.pr') LIKE ?`)
        .all(t.identity ?? '', `t${t.id}`, t.identity ?? '', t.created_at, (t.awaiting_at ?? this.store.now()) + 60_000, `%/pull/${t.pr}`) as { pr: string }[]).map((r) => r.pr);
      const repos = new Set([...urls, ...this.prLinksOf(t.id)].filter((u) => prNumber(u) === t.pr).map(prRepo).filter((r): r is string => !!r));
      const repo = repos.size === 1 ? [...repos][0]! : repos.size > 1 ? null : this.resolvePrRepo(t.id, t.pr);
      if (repo) { this.store.db.prepare('UPDATE tasks SET pr_repo = ? WHERE id = ?').run(repo, t.id); n++; }
    }
    return n;
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
    this.remindStuck();
  }

  /** Each deploy stuck DEPLOY_STUCK_MS with no GO about it: its opener hears it, once per wait (onStuck is idempotent by its id). */
  private remindStuck(): void {
    const rows = this.store.db.prepare(`SELECT ${COLS} FROM tasks WHERE awaiting = 'deploy' AND awaiting_at <= ?`)
      .all(this.store.now() - DEPLOY_STUCK_MS) as AwaitingTask[];
    for (const t of rows) {
      if (this.goAbout(t)) continue;
      const to = this.openerOf(this.taskRow(t.id));
      if (to) this.onStuck(t, to);
    }
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
    const repo = t.pr && t.project ? t.pr_repo ?? this.repoOf(t.project, this.worktreeOf(taskId)) : null;
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
    const from = this.openerOf(this.taskRow(taskId));
    const item = this.inbox.add({ kind: 'awaiting', from_identity: from, title, headline, body, ref, blocking: false,
      links: links ? JSON.parse(links) : null });
    this.onCard(t, item.id, from);
  }

  private worktreeOf(id: number): string | null {
    return (this.store.db.prepare('SELECT worktree FROM tasks WHERE id = ?').get(id) as { worktree: string | null } | undefined)?.worktree ?? null;
  }

  private taskRow(id: number): { project: string | null; labels: string } {
    const r = this.store.db.prepare('SELECT project, labels FROM tasks WHERE id = ?').get(id) as { project: string | null; labels: string | null } | undefined;
    return { project: r?.project ?? null, labels: r?.labels ?? '[]' };
  }

  /** check and verify are his at once; a deploy never is (the lead asks one GO for the project). */
  private isHis(t: AwaitingTask): boolean {
    return t.awaiting !== 'deploy';
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
    // A task id is global; a PR number only means something inside its repo (task 1476: my-company#69 is not
    // agent-company#69). A task whose repo isn't known matches a report of the project's own repo only.
    const repo = r.repo ?? this.defaultRepoOf(r.project);
    const own = (repo ?? '').toLowerCase() === (this.defaultRepoOf(r.project) ?? '').toLowerCase() ? 1 : 0;
    const rows = this.store.db.prepare(`SELECT id FROM tasks WHERE awaiting = 'deploy' AND (project = ? OR project IS NULL)
      AND (id IN (SELECT value FROM json_each(?)) OR (project = ? AND pr IN (SELECT value FROM json_each(?))
        AND (lower(pr_repo) = lower(?) OR (pr_repo IS NULL AND ? = 1))))`)
      .all(r.project, JSON.stringify(tasks), r.project, JSON.stringify(prs), repo ?? '', own) as { id: number }[];
    const cleared = rows.filter((t) => this.clear(t.id, `deploy:${id}`, 'deployed')).map((t) => t.id);
    this.store.db.prepare('UPDATE deploys SET cleared = ? WHERE id = ?').run(JSON.stringify(cleared), id);
    this.store.emit('deploy.recorded', null, { id, project: r.project, sha: r.sha, target: r.target ?? null, cleared });
    return { id, cleared };
  }
}

const COLS = 'id, ref, project, title, summary, identity, awaiting, awaiting_note, awaiting_at, pr, pr_repo';

interface FollowUp { id: number; title: string; project: string | null; state: string; awaiting: string | null }

/** The tasks a task follows up on: "משימה 500: …", "t500", "task-500" in its title, older than it. */
function parentsOf(t: Pick<FollowUp, 'id' | 'title'>): number[] {
  // Not "t3.micro" or "משימה 2 מתוך 3".
  const ids = [...t.title.matchAll(/(?:משימה |\bt|task-)(\d+)(?![\d.])(?! מתוך)/g)].map((m) => Number(m[1]));
  return [...new Set(ids)].filter((n) => n < t.id);
}

/** `task-12` → 12. */
const taskOf = (ref: string | null): number | null => { const m = /^task-(\d+)$/.exec(ref ?? ''); return m ? Number(m[1]) : null; };
