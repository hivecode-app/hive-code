// The names in texts (hq messages, the system prompt, MCP tool descriptions, the app): the owner's display name
// and the manager's, from company/org.yaml. `OWNER` stays the protocol id; only what a person reads changes.
// org.yaml: `owner_name` + `owner_gender` (male | female) for the owner; `manager` is an identity, whose `name`
// and `gender` are used. Hebrew bends by gender (אליו/אליה, סגר/סגרה), so every text picks its form with `g`.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { ownerLanguage } from './hebrew.ts';
import type { OwnerLanguage } from './hebrew.ts';

export type Gender = 'male' | 'female';
export interface NamedPerson { id: string; name: string; gender: Gender }
export interface CompanyNames {
  owner: NamedPerson;
  manager: NamedPerson;
  /** Who composes the head of his conversations screen: the identity whose automations hold `home-headline` (before it, `compose-home`). */
  composer?: NamedPerson;
  /** The owner's language (org.yaml `owner_language`, set from the app's language at setup): what every worker writes to him in. */
  language: OwnerLanguage;
}

/** Without org.yaml values: a phrase that still reads right after a Hebrew prefix (ל, מ, ש). */
export const DEFAULT_NAMES: CompanyNames = {
  owner: { id: 'owner', name: 'בעל החברה', gender: 'male' },
  manager: { id: 'manager', name: 'מנהל החברה', gender: 'male' },
  language: 'en',
};

/** The form for this person's gender: g(owner, 'סגר', 'סגרה'). */
export const g = (p: { gender: Gender }, male: string, female: string): string => (p.gender === 'female' ? female : male);

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const gender = (v: unknown): Gender => (v === 'female' ? 'female' : 'male');

/** Names from a parsed org.yaml. `managerId` is hq's own (cfg.managerId) when org.yaml has no `manager`. */
export function namesFromOrg(org: unknown, managerId?: string): CompanyNames {
  const o = (org && typeof org === 'object' ? org : {}) as Record<string, unknown>;
  const people = [
    ...(Array.isArray(o.identities) ? o.identities : []),
    ...(Array.isArray(o.teams) ? o.teams.flatMap((t: { lead?: unknown; members?: unknown }) => [t?.lead, ...(Array.isArray(t?.members) ? t.members : [])]) : []),
  ].filter((p): p is Record<string, unknown> => !!p && typeof p === 'object');
  const mId = str(o.manager) ?? managerId ?? DEFAULT_NAMES.manager.id;
  const m = people.find((p) => p.id === mId);
  const c = people.find((p) => Array.isArray(p.automations) && p.automations.some((a: { id?: unknown }) => a?.id === 'home-headline' || a?.id === 'compose-home'));
  const person = (p: Record<string, unknown>): NamedPerson => ({ id: String(p.id), name: str(p.name) ?? String(p.id), gender: gender(p.gender) });
  return {
    owner: { id: str(o.owner) ?? DEFAULT_NAMES.owner.id, name: str(o.owner_name) ?? DEFAULT_NAMES.owner.name, gender: gender(o.owner_gender) },
    manager: { id: mId, name: str(m?.name) ?? DEFAULT_NAMES.manager.name, gender: gender(m?.gender) },
    ...(c && str(c.id) ? { composer: person(c) } : {}),
    language: ownerLanguage(o.owner_language),
  };
}

const cache = new Map<string, { mtimeMs: number; managerId?: string; names: CompanyNames }>();

/** <companyDir>/org.yaml → names. Re-read when the file changes (org reload), so a PR to org.yaml takes effect.
 *  A broken org.yaml keeps the last names that parsed, as syncOrg keeps the last org: never "בעל החברה" mid-run. */
export function loadNames(companyDir: string, managerId?: string): CompanyNames {
  const file = join(companyDir, 'org.yaml');
  if (!existsSync(file)) return namesFromOrg({}, managerId);
  try {
    const mtimeMs = statSync(file).mtimeMs;
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.managerId === managerId) return hit.names;
    const names = namesFromOrg(parse(readFileSync(file, 'utf8')), managerId);
    cache.set(file, { mtimeMs, managerId, names });
    return names;
  } catch { return cache.get(file)?.names ?? namesFromOrg({}, managerId); }
}

/** A Hebrew prefix letter on a name: לרן, but ל-Alice (a prefix never sticks to a Latin letter). */
export const pre = (prefix: string, name: string): string => (/^[֐-׿]/.test(name) ? `${prefix}${name}` : `${prefix}-${name}`);
