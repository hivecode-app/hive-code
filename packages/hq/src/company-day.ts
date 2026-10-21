// The company map's day (docs: מסך החברה): who was on the map, every message of the day as a line (who to whom,
// when, no text), the day's marks (a task done, a PR merged, a deploy) and the tables under the map. The text of
// a message is not here: the app asks for it (`messageBody`) when he touches the line. Times are milliseconds
// from the start of the day in the company's time zone. Derived at read time from hq.db, nothing kept.
import { OWNER } from '@company/shared';
import { listIdentities, listMapTeams, type IdentityRow } from './org.ts';
import type { Store } from './store.ts';
import { tzOffsetMs } from './timezone.ts';

const DAY = 86_400_000;
const ANSWER_WITHIN = 6 * 3_600_000;
const HQ = 'hq';

/** [start, end) of the calendar day `date` ("2026-10-21") in `tz`. */
export function dayBounds(date: string, tz: string): { start: number; end: number } {
  const at = (d: number) => d - tzOffsetMs(d - tzOffsetMs(d, tz), tz);
  const utc = Date.parse(`${date}T00:00:00Z`);
  return { start: at(utc), end: at(utc + DAY) };
}

export function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
}

/** Today's date in `tz` ("2026-10-21"). */
export function dateOf(ts: number, tz: string): string {
  return new Date(ts + tzOffsetMs(ts, tz)).toISOString().slice(0, 10);
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2;
};

interface MsgRow { id: string; f: string; t: string; kind: string; ts: number }
interface ShiftRowLite { identity: string; started_at: number; ended_at: number }

export function companyDay(store: Store, companyDir: string, tz: string, date: string) {
  const { start, end } = dayBounds(date, tz);
  const now = store.now();
  const q = <T>(sql: string, ...a: unknown[]) => store.db.prepare(sql).all(...a) as T[];

  const msgs = q<MsgRow>(`SELECT id, from_identity f, to_identity t, kind, created_at ts FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at, rowid`, start, end);
  const shifts = q<ShiftRowLite>(`SELECT identity, started_at, COALESCE(ended_at, last_event_at, ?) ended_at FROM shifts WHERE started_at < ? AND COALESCE(ended_at, last_event_at, ?) >= ?`, Math.min(now, end), end, Math.min(now, end), start);

  const ids = new Map(listIdentities(store).map((i) => [i.id, i]));
  const teamRows = listMapTeams(companyDir);
  const teamOf = (i: IdentityRow): string | null => {
    if (i.team_kind !== 'task') return i.team;
    if (i.project) return i.project;
    // An errand without a project belongs to the team of whoever it reports to.
    return (i.reports_to ? ids.get(i.reports_to)?.team : null) ?? null;
  };
  const teams = teamRows;
  const leads = new Set(teams.map((t) => t.lead).filter((x): x is string => !!x));

  const active = new Set<string>();
  for (const m of msgs) { active.add(m.f); active.add(m.t); }
  for (const s of shifts) active.add(s.identity);

  const people: { id: string; name: string; mono: string; team: string; role: string }[] = [
    { id: OWNER, name: 'רן', mono: 'עק', team: 'management', role: 'owner' },
    { id: HQ, name: 'hq', mono: '', team: 'management', role: 'system' },
  ];
  for (const i of ids.values()) {
    if (i.id === OWNER || i.id === HQ) continue;
    const lead = leads.has(i.id);
    if (!lead && !active.has(i.id)) continue;
    const team = teamOf(i);
    if (!team || !teams.some((t) => t.id === team)) continue;
    let mono = i.name.slice(0, 2);
    try { const d = JSON.parse(i.data || '{}') as { monogram?: unknown }; if (typeof d.monogram === 'string' && d.monogram) mono = d.monogram; } catch { /* the name's start */ }
    people.push({ id: i.id, name: i.name, mono, team, role: lead ? 'lead' : i.team_kind === 'task' ? 'task' : 'member' });
  }
  const known = new Set(people.map((p) => p.id));

  const presence = shifts.filter((s) => known.has(s.identity))
    .map((s) => ({ id: s.identity, from: Math.max(s.started_at, start) - start, to: Math.min(s.ended_at, end) - start }))
    .filter((s) => s.to > s.from);

  const messages = msgs.filter((m) => known.has(m.f) && known.has(m.t)).map((m) => ({ id: m.id, t: m.ts - start, f: m.f, to: m.t, k: m.kind }));

  // Marks: a task done, a PR merged, a deploy.
  const evs = q<{ ts: number; type: string; data: string }>(`SELECT ts, type, data FROM events WHERE ts >= ? AND ts < ? AND type IN ('task.new', 'task.state', 'deploy.recorded', 'pr.merged') ORDER BY ts, seq`, start, end);
  const tasks = new Map(q<{ id: number; project: string | null; title: string }>('SELECT id, project, title FROM tasks').map((r) => [r.id, r]));
  const marks: { t: number; k: string; label: string; project: string | null; repo?: string | null }[] = [];
  const opened: Record<string, number> = {};
  const done: Record<string, number> = {};
  const bump = (o: Record<string, number>, p: string) => { o[p] = (o[p] ?? 0) + 1; };
  for (const e of evs) {
    let d: Record<string, unknown> = {};
    try { d = (JSON.parse(e.data) ?? {}) as Record<string, unknown>; } catch { /* a row we cannot read adds nothing */ }
    const t = e.ts - start;
    if (e.type === 'task.new' && typeof d.project === 'string') bump(opened, d.project);
    else if (e.type === 'task.state' && (d.state === 'done' || d.state === 'closed')) {
      const task = tasks.get(Number(d.id));
      if (task?.project) bump(done, task.project);
      marks.push({ t, k: 'task', project: task?.project ?? null, label: task?.title ?? `משימה ${String(d.id)}` });
    } else if (e.type === 'deploy.recorded') {
      marks.push({ t, k: 'deploy', project: typeof d.project === 'string' ? d.project : null, label: `${String(d.project ?? '')} · ${String(d.target ?? '')}`.trim() });
    } else if (e.type === 'pr.merged') {
      marks.push({ t, k: 'merge', project: typeof d.project === 'string' ? d.project : null, repo: typeof d.repo === 'string' ? d.repo : null,
        label: `${typeof d.repo === 'string' ? d.repo : ''} #${String(d.number)}${typeof d.title === 'string' ? ` · ${d.title}` : ''}`.trim() });
    }
  }

  // Tasks open at the end of the day: opened before it and not done by then.
  const openAtEnd = Object.fromEntries(q<{ project: string; n: number }>(
    `SELECT project, COUNT(*) n FROM tasks WHERE project IS NOT NULL AND created_at < ? AND (state NOT IN ('done', 'closed') OR COALESCE((SELECT MIN(e.ts) FROM events e WHERE e.type = 'task.state'
       AND json_extract(e.data, '$.id') = tasks.id AND json_extract(e.data, '$.state') IN ('done', 'closed')), ?) >= ?) GROUP BY project`, end, end, end).map((r) => [r.project, r.n]));
  const projects = [...new Set(teams.map((t) => t.project).filter((x): x is string => !!x))]
    .map((project) => ({ project, opened: opened[project] ?? 0, done: done[project] ?? 0, open: openAtEnd[project] ?? 0 }));

  // The workers: shift time, messages, and how long each took to answer HIM (his message to the worker's next one back).
  const workers = [];
  for (const p of people) {
    if (p.id === HQ) continue;
    const inbox = messages.filter((m) => m.to === p.id && m.f !== HQ);
    const out = messages.filter((m) => m.f === p.id);
    const waits: number[] = [];
    let asked = 0;
    if (p.id !== OWNER) {
      for (const m of messages) {
        if (m.f !== OWNER || m.to !== p.id) continue;
        asked++;
        const r = out.find((o) => o.to === OWNER && o.t > m.t);
        if (r && r.t - m.t < ANSWER_WITHIN) waits.push(r.t - m.t);
      }
    }
    const hourly = new Array<number>(24).fill(0);
    let workMs = 0;
    for (const s of presence) {
      if (s.id !== p.id) continue;
      workMs += s.to - s.from;
      for (let h = 0; h < 24; h++) hourly[h]! += Math.max(0, Math.min(s.to, (h + 1) * 3_600_000) - Math.max(s.from, h * 3_600_000));
    }
    if (!inbox.length && !out.length && !workMs) continue;
    workers.push({ id: p.id, in: inbox.length, out: out.length, asked, answerMs: median(waits), answered: waits.length, workMs,
      hourly: hourly.map((x) => Math.round((x / 3_600_000) * 100) / 100) });
  }

  // Estimates: all of them so far (a day holds too few to say anything).
  const kinds: Record<string, { kind: string; n: number; onTime: number; late: number; open: number; ratios: number[] }> = {};
  for (const e of q<{ kind: string; created_at: number; due_at: number; closed_at: number | null; outcome: string | null }>(
    'SELECT kind, created_at, due_at, closed_at, outcome FROM estimates WHERE superseded_by IS NULL')) {
    const k = (kinds[e.kind] ??= { kind: e.kind, n: 0, onTime: 0, late: 0, open: 0, ratios: [] });
    k.n++;
    if (!e.closed_at || e.outcome === 'cancelled') { k.open++; continue; }
    if (e.closed_at <= e.due_at) k.onTime++; else k.late++;
    k.ratios.push((e.closed_at - e.created_at) / Math.max(1, e.due_at - e.created_at));
  }
  const estimates = Object.values(kinds).map(({ ratios, ...k }) => ({ ...k, ratio: median(ratios) }));

  return {
    day: date, start, tz, tzOffsetMin: Math.round(tzOffsetMs(start, tz) / 60_000),
    /** Milliseconds into the day that are over: the whole day, or for today how far it got. */
    upTo: Math.max(0, Math.min(DAY, now - start)),
    teams: teams.map((t) => ({ id: t.id, name: t.name, symbol: t.symbol, tone: t.tone ?? 'slate', lead: t.id === 'management' ? 'yoav' : t.lead, project: t.project })),
    people, presence, messages, marks,
    stats: { projects, workers, estimates },
  };
}

/** One message's text for the card (the day's lines carry none): who, to whom, when, the body. */
export function messageBody(store: Store, id: string): { id: string; from: string; to: string; kind: string; at: number; body: string } | null {
  const r = store.db.prepare('SELECT id, from_identity f, to_identity t, kind, created_at at, body FROM messages WHERE id = ?').get(id) as
    { id: string; f: string; t: string; kind: string; at: number; body: string } | undefined;
  return r ? { id: r.id, from: r.f, to: r.t, kind: r.kind, at: r.at, body: r.body.length > 4000 ? `${r.body.slice(0, 4000).replace(/\s+\S*$/, '')}…` : r.body } : null;
}
