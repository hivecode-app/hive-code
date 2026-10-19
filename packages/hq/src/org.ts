// Identities come from the contract (company/org.yaml, B.1). hq mirrors them into the store on start
// and on reload; identities that disappeared from org.yaml are deactivated, never deleted (history stays).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Store } from './store.ts';

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

/** Runtime identity for a task worker ("עידו · מפתח · t3711"), reporting to the project CEO. */
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
