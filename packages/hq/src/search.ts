import type { Hq } from './hq.ts';
import { OWNER } from '@company/shared';

export interface SearchHit {
  kind: 'person' | 'project' | 'task' | 'message';
  id: string; title: string; subtitle: string; identity?: string; project?: string; reports_to?: string | null; body?: string; state?: string;
}

/** Literal, case-insensitive search. Each category is bounded independently and only owner-visible
 * messages are searched. No internal mail, system identifiers or SQL wildcard expansion in results. */
export function search(hq: Hq, raw: string): { results: SearchHit[] } {
  const q = raw.trim().slice(0, 160).toLocaleLowerCase();
  if (!q) return { results: [] };
  const people = hq.board();
  const projects = hq.projects();
  const names = new Map(people.map((p) => [p.id, p.name]));
  const results: SearchHit[] = [];
  for (const p of people.filter((p) => `${p.name} ${p.title} ${p.project ?? ''}`.toLocaleLowerCase().includes(q)).slice(0, 20)) {
    results.push({ kind: 'person', id: p.id, title: p.name, subtitle: hq.conversationTitle(p.id), reports_to: p.reports_to, identity: p.id, ...(p.project ? { project: p.project } : {}) });
  }
  for (const p of projects.filter((p) => `${p.name ?? ''} ${p.id}`.toLocaleLowerCase().includes(q)).slice(0, 20)) {
    results.push({ kind: 'project', id: p.id, title: p.name ?? p.id, subtitle: '', project: p.id });
  }
  // instr binds literal text, so %, _ and quotes have no special meaning.
  const tasks = hq.store.db.prepare(`SELECT id, title, body, state, project, identity FROM tasks
    WHERE instr(lower(title || ' ' || body), ?) > 0 ORDER BY updated_at DESC, id DESC LIMIT 20`).all(q) as
    { id: number; title: string; body: string; state: string; project: string | null; identity: string | null }[];
  for (const t of tasks) results.push({ kind: 'task', id: String(t.id), title: t.title, subtitle: t.project ?? '', body: t.body.slice(0, 8000), state: t.state,
    ...(t.project ? { project: t.project } : {}), ...(t.identity ? { identity: t.identity } : {}) });
  const messages = hq.store.db.prepare(`SELECT id, body, from_identity, to_identity FROM messages
    WHERE (from_identity = ? OR to_identity = ?) AND kind != 'system' AND instr(lower(body), ?) > 0
    ORDER BY created_at DESC, rowid DESC LIMIT 20`).all(OWNER, OWNER, q) as
    { id: string; body: string; from_identity: string; to_identity: string }[];
  for (const m of messages) {
    const identity = m.from_identity === OWNER ? m.to_identity : m.from_identity;
    if (!names.has(identity)) continue;
    results.push({ kind: 'message', id: m.id, title: m.body.slice(0, 240), subtitle: names.get(identity)!, identity });
  }
  return { results };
}
