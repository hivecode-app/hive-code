import { sourceTask, TaskCatalog, type TaskStage } from './task-product.ts';
import type { Hq } from './hq.ts';
import type { TaskRow } from './scheduler.ts';
import { projectLead } from './org.ts';
import { OWNER, type DerivedStatus } from '@company/shared';

export interface SearchHit {
  kind: 'person' | 'project' | 'task' | 'message';
  id: string; title: string; subtitle: string; identity?: string; project?: string; reports_to?: string | null; task?: number | null; body?: string; state?: string;
  /** The project as he calls it (org.yaml `projects[].name`), never the raw id when a name exists. */
  project_name?: string;
  /** task: the stage from known facts (null = not known yet), how it ended, and whether it waits on him. */
  stage?: TaskStage | null; outcome?: 'completed' | 'cancelled' | null; waiting?: boolean;
  /** person: the role alone, the lead's name, the derived status and the task in hand now. */
  role?: string; lead_name?: string | null; leads?: boolean; status?: DerivedStatus | null; now_task?: { id: number; title: string; stage: TaskStage | null } | null;
  /** project: its lead and how many tasks are open. */
  open_tasks?: number;
  /** message: the task it belongs to. */
  task_title?: string | null;
}

/** Active before old: who waits on him and who works first, finished workers last. */
const STATUS_RANK: Record<string, number> = { waiting_for_you: 0, working: 1, blocked: 2, stuck: 3, restarting: 4, free: 5, resting: 6, done: 7 };
const CLOSED = new Set(['done', 'closed']);

/** Literal, case-insensitive search. Each category is bounded independently and only owner-visible
 * messages are searched. No internal mail, system identifiers or SQL wildcard expansion in results. */
export function search(hq: Hq, raw: string, catalog = new TaskCatalog(hq)): { results: SearchHit[] } {
  const q = raw.trim().slice(0, 160).toLocaleLowerCase();
  if (!q) return { results: [] };
  const people = hq.store.db.prepare('SELECT id, name, title, project, reports_to, active FROM identities ORDER BY active DESC, name').all() as { id: string; name: string; title: string; project: string | null; reports_to: string | null; active: number }[];
  const projects = hq.projects();
  const names = new Map(people.map((p) => [p.id, p.name]));
  const projectName = (id: string | null | undefined) => (id ? hq.projectName(id) : undefined);
  const board = new Map(hq.board().map((b) => [b.id, b]));
  // Charters by project, so a task's stage reads its own CI check and repo.
  const context = catalog.projectContext(projects.map((p) => p.id));
  const taskRow = hq.store.db.prepare('SELECT * FROM tasks WHERE id = ?');
  const stageOf = (id: number) => { const t = taskRow.get(id) as TaskRow | undefined; return t ? catalog.knownStage(t, context) : null; };
  const results: SearchHit[] = [];
  // Who leads: a project's lead, or anyone active people report to. "In X's team" would be wrong for them.
  const leads = new Set<string | null>([...people.filter((p) => p.active).map((p) => p.reports_to), ...projects.map((p) => projectLead(hq.store, p.id) ?? null)]);

  const matchedPeople = people.filter((p) => `${p.name} ${p.title} ${p.project ?? ''} ${projectName(p.project) ?? ''}`.toLocaleLowerCase().includes(q))
    .sort((a, b) => (b.active - a.active) || (STATUS_RANK[board.get(a.id)?.status ?? 'done']! - STATUS_RANK[board.get(b.id)?.status ?? 'done']!) || a.name.localeCompare(b.name))
    .slice(0, 20);
  for (const p of matchedPeople) {
    const b = board.get(p.id), current = b?.current_task;
    const lead = p.reports_to && p.reports_to !== OWNER ? names.get(p.reports_to) ?? null : null;
    results.push({ kind: 'person', id: p.id, title: p.name, subtitle: hq.conversationTitle(p.id), reports_to: p.reports_to, identity: p.id,
      role: p.title, lead_name: lead, leads: leads.has(p.id), status: b?.status ?? null,
      now_task: current ? { id: current.id, title: current.title, stage: stageOf(current.id) } : null,
      ...(p.project ? { project: p.project, project_name: projectName(p.project) } : {}) });
  }

  const openCount = hq.store.db.prepare(`SELECT COUNT(*) n FROM tasks WHERE project = ? AND state NOT IN ('done','closed','proposal')`);
  for (const p of projects.filter((p) => `${p.name ?? ''} ${p.id}`.toLocaleLowerCase().includes(q)).slice(0, 20)) {
    const lead = projectLead(hq.store, p.id);
    results.push({ kind: 'project', id: p.id, title: p.name ?? p.id, subtitle: '', project: p.id, project_name: p.name ?? p.id,
      lead_name: lead ? names.get(lead) ?? null : null, open_tasks: (openCount.get(p.id) as { n: number }).n });
  }

  const taskHit = (t: TaskRow, identity?: string | null): SearchHit => {
    const outcome = t.state === 'closed' || (JSON.parse(t.labels) as string[]).includes('cancelled') ? 'cancelled' : t.state === 'done' ? 'completed' : null;
    return { kind: 'task', id: String(t.id), title: t.title, subtitle: projectName(t.project) ?? '', body: t.body.slice(0, 8000), state: t.state,
      stage: catalog.knownStage(t, context), outcome, waiting: context.requests.some((r) => r.task === t.id) || (outcome == null && t.awaiting === 'check'),
      ...(t.project ? { project: t.project, project_name: projectName(t.project) } : {}), ...((identity ?? t.identity) ? { identity: (identity ?? t.identity)! } : {}) };
  };
  // instr binds literal text, so %, _ and quotes have no special meaning. Open tasks before finished ones.
  const tasks = hq.store.db.prepare(`SELECT * FROM tasks
    WHERE instr(lower(title || ' ' || body || ' ' || COALESCE(pr, '')), ?) > 0
      OR EXISTS (SELECT 1 FROM meta m, json_each(m.value) link WHERE m.key = 'task-pr-links:' || tasks.id AND instr(lower(link.value), ?) > 0)
    ORDER BY CASE WHEN state IN ('done','closed') THEN 1 ELSE 0 END, updated_at DESC, id DESC LIMIT 20`).all(q, q) as TaskRow[];
  for (const t of tasks) results.push(taskHit(t));

  const messages = hq.store.db.prepare(`SELECT id, body, from_identity, to_identity, created_at, ref, shift_id FROM messages
    WHERE (from_identity = ? OR to_identity = ?) AND kind != 'system' AND (instr(lower(body), ?) > 0 OR EXISTS (SELECT 1 FROM json_each(COALESCE(attachments, '[]')) f WHERE instr(lower(json_extract(f.value, '$.name')), ?) > 0))
    ORDER BY created_at DESC, rowid DESC LIMIT 20`).all(OWNER, OWNER, q, q) as
    { id: string; body: string; from_identity: string; to_identity: string; created_at: number; ref: string | null; shift_id: string | null }[];
  for (const m of messages) {
    const identity = m.from_identity === OWNER ? m.to_identity : m.from_identity;
    if (!names.has(identity)) continue;
    const task = sourceTask(hq, identity, m.created_at, m.ref, m.shift_id);
    const t = task != null ? hq.scheduler.task(task) : undefined;
    if (t && !results.some((r) => r.kind === 'task' && r.id === String(t.id))) results.push(taskHit(t, identity));
    results.push({ task, kind: 'message', id: m.id, title: m.body.slice(0, 240), subtitle: names.get(identity)!, identity, task_title: t?.title ?? null,
      ...(t?.project ? { project: t.project, project_name: projectName(t.project) } : {}) });
  }
  // Tasks found through a message join the task group, open before finished.
  const firstTask = results.findIndex((r) => r.kind === 'task');
  if (firstTask >= 0) {
    const taskHits = results.filter((r) => r.kind === 'task').sort((a, b) => Number(CLOSED.has(a.state ?? '')) - Number(CLOSED.has(b.state ?? '')));
    const rest = results.filter((r) => r.kind !== 'task');
    rest.splice(firstTask, 0, ...taskHits);
    return { results: rest };
  }
  return { results };
}
