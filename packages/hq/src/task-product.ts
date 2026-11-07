// Phase C: task progress, worker presence and owner requests are separate facts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { OWNER } from '@company/shared';
import type { Hq } from './hq.ts';
import type { TaskRow } from './scheduler.ts';
import { projectLead } from './org.ts';
import { openedBy } from './open-tasks.ts';
import { recordedTaskPrs } from './task-prs.ts';
import { readCharter } from './workspace.ts';

export const TASK_STAGES = ['proposal', 'development', 'review', 'approval', 'released'] as const;
export type TaskStage = typeof TASK_STAGES[number];
export interface PrEvidence {
  url: string; head: string; state: string; draft: boolean; merged: boolean;
  review: 'approved' | 'changes' | 'pending'; ci: 'passed' | 'failed' | 'pending' | 'unknown';
  quote: string | null; checked_at: number; error?: boolean;
}
interface Message { id: string; body: string; from_identity: string; to_identity: string; ref: string | null; shift_id: string | null; created_at: number; attachments: string | null }
export interface TaskRequest { id: number; kind: string; title: string; asked_by: string | null; task: number | null; ref: string | null; created_at: number }

/** Bind at the source's time, not to whoever happens to be working now. Runtime identities keep their
 * completed history; a reused standing identity is bounded by its task interval. Explicit refs win. */
export function sourceTask(hq: Hq, identity: string | null, at: number, ref?: string | null, shift?: string | null): number | null {
  const explicit = /^task[-:](\d+)$/.exec(ref ?? '');
  if (explicit) return hq.scheduler.task(Number(explicit[1]))?.id ?? null;
  if (shift) {
    const s = hq.store.db.prepare('SELECT task_id FROM shifts WHERE id = ?').get(shift) as { task_id: number | null } | undefined;
    if (s?.task_id) return s.task_id;
  }
  if (!identity) return null;
  const runtime = (hq.store.db.prepare('SELECT source FROM identities WHERE id = ?').get(identity) as { source: string } | undefined)?.source === 'runtime';
  const t = hq.store.db.prepare(`SELECT id FROM tasks WHERE identity = ? AND COALESCE(started_at, created_at) <= ?
    AND (? OR started_at IS NOT NULL OR state IN ('running','resting','done','closed'))
    AND (? OR state NOT IN ('done','closed') OR updated_at >= ?) ORDER BY COALESCE(started_at, created_at) DESC, id DESC LIMIT 1`)
    .get(identity, at, runtime ? 1 : 0, runtime ? 1 : 0, at) as { id: number } | undefined;
  return t?.id ?? null;
}

export function taskRequests(hq: Hq): TaskRequest[] {
  return hq.inbox.mine().filter((i) => ['ask', 'go', 'login'].includes(i.kind)).map((i) => ({
    id: i.id, kind: i.kind, title: i.headline ?? i.title, asked_by: i.from_identity,
    task: sourceTask(hq, i.from_identity, i.created_at, i.ref), ref: i.ref, created_at: i.created_at,
  }));
}

export function taskMessages(hq: Hq, task: TaskRow): Message[] {
  const columns = 'id, body, from_identity, to_identity, ref, shift_id, created_at, attachments';
  const messages = hq.store.db.prepare(`SELECT ${columns} FROM messages
    WHERE ((from_identity = ? AND to_identity = ?) OR (to_identity = ? AND from_identity = ?)) AND kind != 'system'
    UNION SELECT ${columns} FROM messages WHERE (from_identity = ? OR to_identity = ?) AND ref IN (?, ?) AND kind != 'system'
    ORDER BY created_at, id`).all(task.identity, OWNER, task.identity, OWNER, OWNER, OWNER, `task-${task.id}`, `task:${task.id}`) as Message[];
  const tasks = hq.store.db.prepare('SELECT * FROM tasks WHERE identity = ? ORDER BY COALESCE(started_at, created_at) DESC, id DESC').all(task.identity) as TaskRow[];
  const shifts = new Map((hq.store.db.prepare('SELECT id, task_id FROM shifts WHERE identity = ?').all(task.identity) as { id: string; task_id: number | null }[]).map((r) => [r.id, r.task_id]));
  const runtime = (hq.store.db.prepare('SELECT source FROM identities WHERE id = ?').get(task.identity) as { source: string } | undefined)?.source === 'runtime';
  return messages.filter((m) => {
    const explicit = /^task[-:](\d+)$/.exec(m.ref ?? '');
    const found = explicit ? Number(explicit[1]) : (m.shift_id ? shifts.get(m.shift_id) : null) ?? tasks.find((t) =>
      (t.started_at ?? t.created_at) <= m.created_at && (runtime || t.started_at != null || ['running','resting','done','closed'].includes(t.state)) && (runtime || !['done','closed'].includes(t.state) || t.updated_at >= m.created_at))?.id;
    return found === task.id;
  });
}

/** Only explicitly recorded PR provenance is evidence. Links discussed in notes can refer to other work. */
export function taskPrUrls(hq: Hq, task: TaskRow, repo?: string | null): string[] {
  const urls = new Set<string>(recordedTaskPrs(hq.store, task.id));
  for (const m of (task.pr ?? '').matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/g)) urls.add(`https://github.com/${m[1]}/pull/${m[2]}`);
  if (/^#?\d+$/.test(task.pr ?? '') && task.project && ![...urls].some((u) => u.endsWith(`/pull/${task.pr!.replace('#', '')}`))) {
    const checkouts = readCharter(hq.cfg.companyDir, task.project)?.checkouts;
    const selected = (JSON.parse(task.labels) as string[]).find((l) => l.startsWith('repo:'))?.slice(5);
    repo ??= (selected ? checkouts?.find((c) => c.name === selected) : checkouts?.[0])?.repo;
    if (repo) urls.add(`https://github.com/${repo}/pull/${task.pr!.replace('#', '')}`);
  }
  return [...urls];
}

/** The branch hq opened for the task (`company-t<id>`, maybe with a suffix after a move). A PR from that branch in one
 * of its project's repos is the task's: hq named the branch after the task, so nobody else's work comes from it. */
export function branchPrUrls(task: TaskRow, prs: { url: string; head: string }[]): string[] {
  const own = new RegExp(`^company-t${task.id}(?:-|$)`);
  return prs.filter((p) => own.test(p.head)).map((p) => p.url);
}
/** error: the last read failed, and prs is what was known before it (maybe nothing). */
interface BranchPrs { at: number; prs: { url: string; head: string }[]; error?: boolean }

export function wasReleased(hq: Hq, task: TaskRow): boolean {
  return (hq.store.db.prepare('SELECT tasks FROM deploys WHERE project = ?').all(task.project) as { tasks: string }[])
    .some((r) => (JSON.parse(r.tasks) as number[]).includes(task.id));
}

/** The stage he reads: what the task waits for, not who is at the keyboard. Anything that waits on him (a GO, a
 * deploy, a check) is "approval"; "released" needs evidence: a deploy, or a finished task whose PR merged. A finished
 * task without code (a report, an investigation) has no stage, only its outcome. A PR not read yet is unknown (null)
 * while the task is still open, never a guess. A merged PR without a GO or a deploy waits for nothing of his. */
export function taskStage(task: TaskRow, prs: PrEvidence[], requests: TaskRequest[], released: boolean): TaskStage | null {
  if (released) return 'released';
  if (task.awaiting === 'deploy' || task.awaiting === 'verify' || task.awaiting === 'check' || requests.some((r) => r.task === task.id && r.kind === 'go')) return 'approval';
  if (task.state === 'done') return prs.some((p) => p.merged) ? 'released' : null;
  if (task.state === 'proposal') return 'proposal';
  if (prs.some((p) => p.checked_at === 0 || p.error)) return null;
  const open = prs.filter((p) => p.state === 'OPEN');
  if (open.some((p) => p.draft || p.review === 'changes')) return 'development';
  if (open.length) return 'review';
  return 'development';
}

/** Parse GitHub facts. A review comment approves only the exact head it names. A green check for a
 * different head, a stale approve, an empty rollup or a failed read never becomes "passed". */
export function prEvidence(j: Record<string, any>, now: number, requiredCheck: string | null): PrEvidence {
  const comments = (j.comments ?? []) as { body: string }[];
  const current = comments.filter((c) => c.body.split('\n').some((line) => line.trim() === `reviewed: ${j.headRefOid}`)).at(-1)?.body;
  const formal = (j.reviews ?? []).filter((r: any) => r.commit?.oid === j.headRefOid).at(-1);
  const review = current?.includes('**החלטה: changes**') || formal?.state === 'CHANGES_REQUESTED' ? 'changes'
    : current?.includes('**החלטה: approve**') || formal?.state === 'APPROVED' ? 'approved' : 'pending';
  const checks = (j.statusCheckRollup ?? []).filter((c: any) => !requiredCheck || c.name === requiredCheck || c.context === requiredCheck);
  const states = checks.map((c: any) => c.conclusion || c.state || c.status);
  const ci = !states.length ? 'unknown' : states.some((s: string) => ['FAILURE','ERROR','CANCELLED','TIMED_OUT','ACTION_REQUIRED'].includes(s)) ? 'failed'
    : states.every((s: string) => ['SUCCESS','NEUTRAL','SKIPPED'].includes(s)) ? 'passed' : 'pending';
  return { url: j.url, head: j.headRefOid, state: j.state, draft: j.isDraft === true, merged: !!j.mergedAt,
    review, ci, quote: current ?? formal?.body ?? null, checked_at: now };
}

const exec = promisify(execFile);
export class TaskCatalog {
  private cache = new Map<string, PrEvidence>();
  private pending = new Map<string, Promise<PrEvidence>>();
  private refreshing = false;
  private listCache: { at: number; version: number; result: TaskList } | null = null;
  private reading = 0;
  private waiters: (() => void)[] = [];
  private async limitedRead(url: string, check: string | null) {
    if (this.reading >= 4) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.reading++;
    try { return await this.readPr(url, check); }
    finally { const next = this.waiters.shift(); if (next) next(); else this.reading--; }
  }
  private hq: Hq;
  private branchReads = new Map<string, Promise<void>>();
  constructor(hq: Hq) { this.hq = hq; }
  /** One read per repo, not per task: the repo's latest PRs with their branch. Kept in meta like PR evidence. */
  readBranches = async (repo: string): Promise<{ url: string; head: string }[]> => {
    // The latest 200 open PRs, and the latest 200 of any state: an open task's PR stays known while its repo has
    // fewer than 200 open, however many were closed since.
    const read = async (state: string) => JSON.parse((await exec('gh', ['pr', 'list', '--repo', repo, '--state', state, '--limit', '200', '--json', 'url,headRefName'], { timeout: 8000, maxBuffer: 4 * 1024 * 1024 })).stdout) as { url: string; headRefName: string }[];
    const [open, all] = await Promise.all([read('open'), read('all')]);
    return [...new Map([...all, ...open].map((p) => [p.url, { url: p.url, head: p.headRefName }])).values()];
  };
  private branches(repo: string): BranchPrs | null {
    const saved = this.hq.store.getMeta(`task-branch-prs:${repo}`);
    return saved ? JSON.parse(saved) as BranchPrs : null;
  }
  /** null when what is known is fresh: nothing to read, nothing to announce. */
  private refreshBranches(repo: string): Promise<void> | null {
    const known = this.branches(repo);
    if (known && this.hq.store.now() - known.at < 120_000) return null;
    const pending = this.branchReads.get(repo);
    if (pending) return pending;
    const read = this.readBranches(repo).then((prs) => {
      this.hq.store.setMeta(`task-branch-prs:${repo}`, JSON.stringify({ at: this.hq.store.now(), prs }));
      this.listCache = null;
    }).catch((err: unknown) => {
      // A failed read keeps what was known, and waits like a good one: gh is not asked again on every poll. It is
      // said once, and marked: a task with no PR known in a repo that could not be read has no stage, not "development".
      if (!known?.error) this.hq.store.emit('tasks.branches.error', null, { repo, error: String((err as Error)?.message ?? err).slice(0, 300) });
      this.hq.store.setMeta(`task-branch-prs:${repo}`, JSON.stringify({ at: this.hq.store.now(), prs: known?.prs ?? [], error: true }));
      this.listCache = null;
    }).finally(() => this.branchReads.delete(repo));
    this.branchReads.set(repo, read);
    return read;
  }
  /** The repos of the project's checkouts: the task's branch is unique to it in any of them, worktree or not. */
  private taskRepos(charter: ReturnType<typeof readCharter> | undefined): string[] {
    return (charter?.checkouts ?? []).map((c) => c.repo).filter((r): r is string => !!r);
  }
  private urlsOf(task: TaskRow, charter: ReturnType<typeof readCharter> | undefined, fallbackRepo: string): string[] {
    const urls = taskPrUrls(this.hq, task, fallbackRepo);
    const found = this.taskRepos(charter).flatMap((r) => branchPrUrls(task, this.branches(r)?.prs ?? []));
    return [...new Set([...urls, ...found])];
  }
  // Read-only GitHub lookup, independent of scheduler/board. No writes to GitHub, tasks or worker state.
  readPr = async (url: string, check: string | null): Promise<PrEvidence> => {
    const { stdout } = await exec('gh', ['pr', 'view', url, '--json', 'url,state,isDraft,headRefOid,mergedAt,reviews,comments,statusCheckRollup'], { timeout: 4000, maxBuffer: 1024 * 1024 });
    return prEvidence(JSON.parse(stdout), this.hq.store.now(), check);
  };
  private known(url: string, check: string | null): PrEvidence | undefined {
    const key = `${url}:${check ?? ''}`;
    const saved = this.hq.store.getMeta(`task-pr:${key}`);
    return this.cache.get(key) ?? (saved ? JSON.parse(saved) as PrEvidence : undefined);
  }
  private async pr(url: string, check: string | null): Promise<PrEvidence> {
    const key = `${url}:${check ?? ''}`, cached = this.known(url, check);
    if (cached && this.hq.store.now() - cached.checked_at < 60_000) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const read = this.limitedRead(url, check).catch((): PrEvidence => ({
      url, head: cached?.head ?? '', state: '', draft: false, merged: false, review: 'pending', ci: 'unknown', quote: cached?.quote ?? null,
      error: true, checked_at: this.hq.store.now(),
    })).then((p) => { this.cache.set(key, p); this.hq.store.setMeta(`task-pr:${key}`, JSON.stringify(p)); return p; }).finally(() => this.pending.delete(key));
    this.pending.set(key, read);
    return read;
  }
  /** The task's PR links and its charter's CI check: one place for item() and knownStage(). */
  private prSource(task: TaskRow, context: ReturnType<TaskCatalog['context']>) {
    const info = task.project ? context.charters.get(task.project) : undefined;
    const selected = (JSON.parse(task.labels) as string[]).find((l) => l.startsWith('repo:'))?.slice(5);
    const checkout = selected ? info?.charter?.checkouts.find((c) => c.name === selected) : info?.charter?.checkouts[0];
    return { info, check: info?.charter?.ciCheck ?? null, urls: () => this.urlsOf(task, info?.charter, checkout?.repo ?? '') };
  }
  /** What is known of a PR without reading GitHub: the cache, or "not checked yet". */
  private knownOrPending(url: string, check: string | null): PrEvidence {
    return this.known(url, check) ?? { url, head: '', state: '', draft: false, merged: false, review: 'pending', ci: 'unknown', quote: null, checked_at: 0 };
  }
  /** The stage from the PR facts already known, without reading GitHub: search answers immediately. */
  knownStage(task: TaskRow, context: ReturnType<TaskCatalog['context']>): TaskStage | null {
    const { info, check, urls: own } = this.prSource(task, context), urls = own();
    return this.readStage(task, urls, urls.map((url) => this.knownOrPending(url, check)), context, info?.charter);
  }
  /** The stage, said as unknown when its PR may be in a repo that could not be read: the board and search say the same. */
  private readStage(task: TaskRow, urls: string[], prs: PrEvidence[], context: ReturnType<TaskCatalog['context']>, charter: ReturnType<typeof readCharter> | undefined): TaskStage | null {
    const stage = taskStage(task, prs, context.requests, context.deployed.has(task.id));
    return !urls.length && stage === 'development' && this.taskRepos(charter).some((r) => this.branches(r)?.error) ? null : stage;
  }
  private projectsContext: { at: number; key: string; context: ReturnType<TaskCatalog['context']> } | null = null;
  /** The context of whole projects, kept for a few seconds: search asks for it on every keystroke pause, and
   * it reads every charter from disk and all deploys. */
  projectContext(projects: string[]): ReturnType<TaskCatalog['context']> {
    const key = projects.join('\n'), now = this.hq.store.now();
    // The open requests stay live: an answered GO must not read "waits for you" for the next few seconds.
    if (this.projectsContext && this.projectsContext.key === key && now - this.projectsContext.at < 5000) return { ...this.projectsContext.context, requests: taskRequests(this.hq) };
    const context = this.context(projects.map((project) => ({ project }) as TaskRow));
    this.projectsContext = { at: now, key, context };
    return context;
  }
  context(tasks: TaskRow[]) {
    const people = new Map(this.hq.board().map((p) => [p.id, p]));
    const charters = new Map([...new Set(tasks.map((t) => t.project).filter((p): p is string => !!p))]
      .map((p) => [p, { charter: readCharter(this.hq.cfg.companyDir, p), lead: projectLead(this.hq.store, p) }]));
    const deployed = new Set((this.hq.store.db.prepare('SELECT tasks FROM deploys').all() as { tasks: string }[]).flatMap((r) => JSON.parse(r.tasks) as number[]));
    return { people, charters, deployed, ops: this.openOps(), requests: taskRequests(this.hq) };
  }
  private opsByTask = new Map<number, string>();
  private opsRowid = 0;
  /** The open_team call that opened each task: the conversation puts the task's card under the message it was opened in,
   *  also when the worker's tool heard only {queued, id} from hq (rpc.ts SYNC_OPS timeout). An open_team's ack is written
   *  with its row (ingest.ts op), so only the rows added since the last read are read. */
  private openOps() {
    const rows = this.hq.store.db.prepare(`SELECT rowid, id, json_extract(ack, '$.result.task') AS task FROM ops WHERE rowid > ? AND op = 'open_team'`)
      .all(this.opsRowid) as { rowid: number; id: string; task: number | null }[];
    for (const r of rows) {
      if (typeof r.task === 'number') this.opsByTask.set(r.task, r.id);
      this.opsRowid = Math.max(this.opsRowid, r.rowid);
    }
    return this.opsByTask;
  }
  async item(task: TaskRow, context = this.context([task]), refresh = true, urls?: string[]) {
    const { info, check, urls: own } = this.prSource(task, context);
    urls ??= own();
    const prs = await Promise.all(urls.map((url) => refresh ? this.pr(url, check) : this.knownOrPending(url, check)));
    const stage = this.readStage(task, urls, prs, context, info?.charter);
    return { id: task.id, title: task.title, body: task.body, project: task.project, worker: task.identity,
      opened_by: openedBy(task) ?? info?.lead ?? null, op: context.ops.get(task.id) ?? null,
      state: task.state, stage,
      outcome: task.state === 'closed' || JSON.parse(task.labels).includes('cancelled') ? 'cancelled' : task.state === 'done' ? 'completed' : null,
      summary: task.summary ?? null, about: this.hq.store.getMeta(`task-about:${task.id}`) ?? null, awaiting: task.awaiting ?? null, worker_status: context.people.get(task.identity ?? '')?.status ?? null,
      requests: context.requests.filter((r) => r.task === task.id), prs, created_at: task.created_at, started_at: task.started_at ?? null, updated_at: task.updated_at };
  }
  async list(): Promise<TaskList> {
    const version = (this.hq.store.db.prepare('SELECT MAX(seq) seq FROM events').get() as { seq: number }).seq;
    if (this.listCache && this.hq.store.now() - this.listCache.at < 3000 && this.listCache.version === version) return this.listCache.result;
    const tasks = this.hq.store.db.prepare(`SELECT * FROM tasks WHERE state NOT IN ('done','closed') OR id IN (SELECT id FROM tasks WHERE state IN ('done','closed') ORDER BY updated_at DESC LIMIT 100) ORDER BY updated_at DESC, id DESC`).all() as TaskRow[];
    const context = this.context(tasks);
    const entries = tasks.map((task) => {
      const checkouts = context.charters.get(task.project ?? '')?.charter?.checkouts;
      const selected = (JSON.parse(task.labels) as string[]).find((l) => l.startsWith('repo:'))?.slice(5);
      return { task, urls: this.urlsOf(task, context.charters.get(task.project ?? '')?.charter, (selected ? checkouts?.find((c) => c.name === selected) : checkouts?.[0])?.repo ?? '') };
    });
    // PRs found by the task's branch: one read per repo, in the background, then the list is read again.
    const repos = new Set(tasks.flatMap((t) => this.taskRepos(context.charters.get(t.project ?? '')?.charter)));
    const reads = [...repos].map((r) => this.refreshBranches(r)).filter((r): r is Promise<void> => r != null);
    if (reads.length) this.hq.store.bg(Promise.all(reads).then(() => this.hq.store.emit('tasks.progress', null, {})), 'tasks.branches');
    const out = await Promise.all(entries.map(({ task, urls }) => this.item(task, context, false, urls)));
    if (!this.refreshing) {
      // A finished task is read again only while a PR of it was last seen open (or never read), in its last week: "released" waits for its merge.
      // A PR merged more than a week after the task finished is not read again, and that task does not show as released.
      const settling = (task: TaskRow, check: string | null, urls: string[]) => task.state === 'done' && this.hq.store.now() - task.updated_at < 7 * 86_400_000
        && !urls.some((u) => this.known(u, check)?.merged) && urls.some((u) => { const k = this.known(u, check); return !k || !!k.error || k.state === 'OPEN'; });
      const stale = entries.filter(({ task, urls }) => (task.state !== 'done' || task.awaiting || settling(task, context.charters.get(task.project ?? '')?.charter?.ciCheck ?? null, urls)) && urls.some((u) => {
        const check = context.charters.get(task.project ?? '')?.charter?.ciCheck ?? null;
        return this.hq.store.now() - (this.known(u, check)?.checked_at ?? 0) >= 60_000;
      }));
      if (stale.length) {
        this.refreshing = true;
        let cursor = 0;
        this.hq.store.bg(Promise.all(Array.from({ length: 4 }, async () => {
          while (cursor < stale.length) { const { task, urls } = stale[cursor++]!; await this.item(task, context, true, urls); }
        })).then(() => { this.listCache = null; this.hq.store.emit('tasks.progress', null, {}); }).finally(() => { this.refreshing = false; }), 'tasks.progress');
      }
    }
    const unknown = out.filter((t) => t.stage === null && t.outcome === null);
    const result: TaskList = { pipeline: out, groups: [...TASK_STAGES.map((stage) => ({ stage, tasks: out.filter((t) => t.stage === stage && t.outcome !== 'cancelled') })), ...(unknown.length ? [{ stage: null, tasks: unknown }] : [])], requests: context.requests };
    this.listCache = { at: this.hq.store.now(), version, result };
    return result;
  }

  activity(task: TaskRow) {
    const messages = taskMessages(this.hq, task);
    const files = new Map<string, { id: string; name: string; mime: string; bytes: number; message: string; identity: string | null }>();
    for (const m of messages) for (const f of JSON.parse(m.attachments ?? '[]')) {
      files.set(f.id, { id: f.id, name: f.name, mime: f.mime, bytes: f.bytes, message: m.id, identity: m.from_identity === OWNER ? m.to_identity : m.from_identity });
    }
    const events = this.hq.store.db.prepare(`SELECT seq, ts, type, data FROM events WHERE type IN ('task.new','task.state','task.awaiting','task.labels','task.priority') AND json_extract(data, '$.id') = ? ORDER BY seq DESC LIMIT 500`).all(task.id).reverse();
    return { messages: messages.map((m) => ({ id: m.id, body: m.body, identity: m.from_identity === OWNER ? m.to_identity : m.from_identity, mine: m.from_identity === OWNER, created_at: m.created_at })), files: [...files.values()], events };
  }
}

export interface TaskList {
  pipeline: Awaited<ReturnType<TaskCatalog['item']>>[];
  groups: { stage: TaskStage | null; tasks: Awaited<ReturnType<TaskCatalog['item']>>[] }[];
  requests: TaskRequest[];
}

/** Include completed/deactivated workers. Cycle guards keep malformed reporting lines navigable. */
export function orgTree(hq: Hq) {
  const people = hq.store.db.prepare('SELECT id, name, title, project, reports_to, active FROM identities ORDER BY name, id').all() as
    { id: string; name: string; title: string; project: string | null; reports_to: string | null; active: number }[];
  const tasks = hq.store.db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC').all() as TaskRow[];
  const nodes = people.map((p) => ({ ...p, tasks: tasks.filter((t) => t.identity === p.id).map((t) => ({ id: t.id, title: t.title, state: t.state })) }));
  const build = (id: string, path: Set<string>): any => {
    if (path.has(id)) return null;
    const node = nodes.find((p) => p.id === id)!;
    return { ...node, children: nodes.filter((p) => p.reports_to === id).map((p) => build(p.id, new Set([...path, id]))).filter(Boolean) };
  };
  const roots = nodes.filter((p) => !p.reports_to || !nodes.some((n) => n.id === p.reports_to));
  const covered = new Set<string>();
  const mark = (n: any) => { covered.add(n.id); n.children.forEach(mark); };
  const tree = roots.map((p) => build(p.id, new Set())); tree.forEach(mark);
  for (const p of nodes) if (!covered.has(p.id)) { const n = build(p.id, new Set()); tree.push(n); mark(n); }
  return { tree, people: nodes };
}
