// Identities come from the contract (company/org.yaml, B.1). hq mirrors them into the store on start
// and on reload; identities that disappeared from org.yaml are deactivated, never deleted (history stays).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { HELPER_TEAM } from './system-prompt.ts';
import type { Store } from './store.ts';
import { readCharter } from './workspace.ts';

interface OrgPerson {
  id: string; name: string; title?: string; symbol?: string; team?: string; reports_to?: string; kind?: string;
  lifecycle?: string; resident?: boolean; automations?: { id: string; what?: string; enabled?: boolean }[]; [k: string]: unknown;
}
interface OrgTeam { id: string; kind?: string; symbol?: string; project?: string; parent?: string; lead?: string | OrgPerson; members?: (string | OrgPerson)[]; [k: string]: unknown }
interface OrgFile { owner?: string; manager?: string; teams?: OrgTeam[]; identities?: OrgPerson[] }

export interface IdentityRow {
  id: string; name: string; title: string; symbol: string; team: string | null; team_kind: string | null;
  project: string | null; reports_to: string | null; lifecycle: string; source: string; active: number;
  data: string; updated_at: number;
}

export type ParsedIdentity = Omit<IdentityRow, 'updated_at' | 'active' | 'source'>;
export interface ParsedAutomation { key: string; identity: string; enabled: boolean; description: string }

/**
 * company/org.yaml → identities + automations. Two shapes are accepted:
 *  - the contract (company/org.yaml): `teams[]` with `lead: <id>`, `members: [<id>]`, plus `identities[]`;
 *  - the B.1 sketch: people inline in teams (`lead: {id, name, …}`).
 * Lifecycle in the store: resident (resident:true, B.2) | lead (always-on) | dormant | ephemeral.
 * `reports_to` of the owner (ran) is stored as null: the top of the chain.
 */
export function parseOrg(text: string, residents: string[], managerId: string): { identities: ParsedIdentity[]; automations: ParsedAutomation[] } {
  const org = (parse(text) ?? {}) as OrgFile;
  const owner = org.owner ?? 'ran';
  const manager = org.manager ?? managerId;
  const teams = org.teams ?? [];
  const idOf = (x: string | OrgPerson | undefined) => (typeof x === 'string' ? x : x?.id);
  const teamOf = new Map<string, OrgTeam>();
  const leadOf = new Map<string, string | undefined>();
  for (const t of teams) {
    leadOf.set(t.id, idOf(t.lead));
    for (const m of [t.lead, ...(t.members ?? [])]) { const id = idOf(m); if (id) teamOf.set(id, t); }
  }
  const people = new Map<string, OrgPerson>();
  for (const t of teams) for (const m of [t.lead, ...(t.members ?? [])]) if (m && typeof m === 'object') people.set(m.id, m);
  for (const p of org.identities ?? []) people.set(p.id, { ...people.get(p.id), ...p });

  const identities: ParsedIdentity[] = [];
  const automations: ParsedAutomation[] = [];
  for (const p of people.values()) {
    const t = (p.team ? teams.find((x) => x.id === p.team) : undefined) ?? teamOf.get(p.id);
    const isLead = !!t && idOf(t.lead) === p.id;
    const parentLead = t?.parent ? leadOf.get(t.parent) : undefined;
    let reports: string | undefined = p.reports_to ?? (isLead ? (p.id === manager ? owner : (parentLead ?? manager)) : (idOf(t?.lead) ?? manager));
    if (reports === owner) reports = undefined;
    const lifecycle = p.resident === true || residents.includes(p.id) ? 'resident'
      : p.lifecycle === 'dormant' || p.lifecycle === 'ephemeral' ? p.lifecycle
      : p.lifecycle === 'always-on' || isLead ? 'lead' : 'dormant';
    const { id, name, title, symbol, team: _t, reports_to: _r, lifecycle: _l, resident: _res, automations: autos, ...rest } = p;
    identities.push({
      id, name, title: title ?? '', symbol: symbol ?? t?.symbol ?? '', team: t?.id ?? null, team_kind: t?.kind ?? p.kind ?? 'permanent',
      project: t?.project ?? null, reports_to: reports ?? null, lifecycle, data: JSON.stringify(rest),
    });
    for (const a of autos ?? []) {
      if (a?.id) automations.push({ key: `${id}/${a.id}`, identity: id, enabled: a.enabled === true, description: a.what ?? '' });
    }
  }
  return { identities, automations };
}

/** Sync org.yaml → identities. Returns the number of identities loaded (0 if the file is missing). */
export function syncOrg(store: Store, companyDir: string, residents: string[], managerId: string): number {
  const file = join(companyDir, 'org.yaml');
  if (!existsSync(file)) {
    store.emit('org.missing', null, { file });
    return 0;
  }
  const { identities: rows, automations } = parseOrg(readFileSync(file, 'utf8'), residents, managerId);
  const now = store.now();
  const up = store.db.prepare(`INSERT INTO identities
      (id, name, title, symbol, team, team_kind, project, reports_to, lifecycle, source, active, data, updated_at)
      VALUES (@id, @name, @title, @symbol, @team, @team_kind, @project, @reports_to, @lifecycle, 'org', 1, @data, @updated_at)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, title=excluded.title, symbol=excluded.symbol, team=excluded.team,
      team_kind=excluded.team_kind, project=excluded.project, reports_to=excluded.reports_to, lifecycle=excluded.lifecycle,
      source='org', active=1, data=excluded.data, updated_at=excluded.updated_at`);
  store.db.transaction(() => {
    for (const r of rows) up.run({ ...r, updated_at: now });
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',') || "''";
    store.db.prepare(`UPDATE identities SET active = 0, updated_at = ? WHERE source = 'org' AND id NOT IN (${placeholders})`)
      .run(now, ...ids);
    // Automations are switches on the board (A.6). The contract sets the default; a manual switch in the
    // app wins until the contract changes it again ("כובה ידנית" stays off).
    for (const a of automations) {
      store.db.prepare(`INSERT INTO toggles (key, enabled, manual, description, updated_at) VALUES (?, ?, 0, ?, ?)
        ON CONFLICT(key) DO UPDATE SET description = excluded.description,
          enabled = CASE WHEN toggles.manual = 1 THEN toggles.enabled ELSE excluded.enabled END,
          updated_at = excluded.updated_at`).run(a.key, a.enabled ? 1 : 0, a.description, now);
    }
  })();
  store.emit('org.synced', null, { count: rows.length, automations: automations.length });
  return rows.length;
}

export function getIdentity(store: Store, id: string): IdentityRow | undefined {
  return store.db.prepare('SELECT * FROM identities WHERE id = ?').get(id) as IdentityRow | undefined;
}

export function listIdentities(store: Store): IdentityRow[] {
  return store.db.prepare('SELECT * FROM identities WHERE active = 1 ORDER BY team, lifecycle, id').all() as IdentityRow[];
}

/** Human names for task workers (#51): a name and a role, not "t12". None of them is a standing identity's name. */
const TASK_NAMES: ReadonlyArray<readonly [string, 'm' | 'f']> = [
  ['דנה', 'f'], ['איתי', 'm'], ['תמר', 'f'], ['נועם', 'm'], ['שירה', 'f'], ['עומר', 'm'], ['מאיה', 'f'], ['יונתן', 'm'],
  ['הדס', 'f'], ['גיל', 'm'], ['ענבל', 'f'], ['אסף', 'm'], ['מיכל', 'f'], ['ניר', 'm'], ['קרן', 'f'], ['עידו', 'm'],
  ['רעות', 'f'], ['אלון', 'm'], ['שקד', 'f'], ['יובל', 'm'], ['ליאת', 'f'], ['דורון', 'm'], ['אביגיל', 'f'], ['בועז', 'm'],
];

/** Second, third… "דנה" once the whole pool is in use. */
const ROUND = ['', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ז׳', 'ח׳', 'ט׳'];

/**
 * Name and title of a new task worker: the pool in order from the task id, skipping names in use (a standing
 * identity, or a task worker whose task is still open), so two live workers are never both "דנה". When every
 * name is in use the round goes on with a suffix ("דנה ב׳"). `helper` = a personal-team errand, not code.
 */
export function taskWorkerName(store: Store, taskId: number, helper = false): { name: string; title: string } {
  const taken = new Set((store.db.prepare(`SELECT i.name FROM identities i WHERE i.active = 1 AND (i.source != 'runtime'
      OR EXISTS (SELECT 1 FROM tasks t WHERE t.identity = i.id AND t.state != 'done'))`).all() as { name: string }[]).map((r) => r.name));
  const n = TASK_NAMES.length;
  const start = ((taskId % n) + n) % n;
  for (let k = 0; ; k++) {
    const [base, g] = TASK_NAMES[(start + k) % n]!;
    const round = Math.floor(k / n);
    const name = round === 0 ? base : `${base} ${ROUND[round] ?? round + 1}`;
    if (taken.has(name) && k < n * 50) continue;
    return { name, title: helper ? (g === 'f' ? 'עוזרת אישית' : 'עוזר אישי') : (g === 'f' ? 'מפתחת' : 'מפתח') };
  }
}

/** Task workers opened before #51 were named "t<N>" with the task title as their title: give them a name and a role. */
export function renameLegacyTaskWorkers(store: Store): number {
  const rows = store.db.prepare(`SELECT i.id, i.name, i.project, o.team AS opener_team FROM identities i
      LEFT JOIN identities o ON o.id = i.reports_to WHERE i.source = 'runtime' AND i.team_kind = 'task'`).all() as
    { id: string; name: string; project: string | null; opener_team: string | null }[];
  let n = 0;
  for (const r of rows) {
    const m = /^t(\d+)$/.exec(r.name);
    if (!m) continue;
    const w = taskWorkerName(store, Number(m[1]), !r.project && r.opener_team === HELPER_TEAM);
    store.db.prepare('UPDATE identities SET name = ?, title = ?, updated_at = ? WHERE id = ?').run(w.name, w.title, store.now(), r.id);
    n++;
  }
  return n;
}

/** Runtime identity for a task worker ("דנה · מפתחת", id agent-company-t3711), reporting to the project CEO. */
export function ensureRuntimeIdentity(store: Store, p: { id: string; name: string; title: string; project: string | null; reports_to: string | null; symbol?: string }): void {
  store.db.prepare(`INSERT OR IGNORE INTO identities
      (id, name, title, symbol, team, team_kind, project, reports_to, lifecycle, source, active, data, updated_at)
      VALUES (?, ?, ?, ?, ?, 'task', ?, ?, 'ephemeral', 'runtime', 1, '{}', ?)`)
    .run(p.id, p.name, p.title, p.symbol ?? '', p.id, p.project, p.reports_to, store.now());
}

export function projectLead(store: Store, project: string): string | undefined {
  const r = store.db.prepare(`SELECT id FROM identities WHERE project = ? AND team_kind = 'project' AND lifecycle IN ('lead','resident') AND active = 1 LIMIT 1`)
    .get(project) as { id: string } | undefined;
  return r?.id;
}

export interface ProjectRow { id: string; status: string; team: string | null }

/**
 * The projects in company/org.yaml (`projects:`), in contract order, for the app's board. The status is
 * the charter's own (company/projects/<id>.md): that is what hq acts on (dormant projects get no workers),
 * so the board shows the same thing; org.yaml's status is the fallback when the charter is missing.
 */
export function listProjects(companyDir: string): ProjectRow[] {
  const file = join(companyDir, 'org.yaml');
  if (!existsSync(file)) return [];
  let org: { projects?: { id?: unknown; status?: unknown; team?: unknown }[] };
  try { org = (parse(readFileSync(file, 'utf8')) ?? {}) as typeof org; } catch { return []; }
  const out: ProjectRow[] = [];
  for (const p of Array.isArray(org.projects) ? org.projects : []) {
    if (typeof p?.id !== 'string' || !p.id) continue;
    const charter = readCharter(companyDir, p.id);
    const status = charter?.status ?? (typeof p.status === 'string' ? p.status : 'active');
    out.push({ id: p.id, status, team: typeof p.team === 'string' ? p.team : null });
  }
  return out;
}
