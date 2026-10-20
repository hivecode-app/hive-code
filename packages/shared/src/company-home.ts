// COMPANY_HOME: where the company lives, the one source every part reads it from (docs/generic/PLAN.md §1, step 3).
// It is a git checkout with company/ (the contract) and memory/ at its root: hive-owner/my-company in ~/company on
// hq-host. Order: the env var COMPANY_HOME, then `companyHome` in <state>/hq.config.json, then the engine repo
// itself, which still carries company/ and memory/ (the behavior from before the split).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const COMPANY_HOME_ENV = 'COMPANY_HOME';

/** The engine checkout this code runs from (packages/shared/src → the repo root). */
export const ENGINE_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export function expandHome(p: string, home = homedir()): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** `companyHome` from <stateRoot>/hq.config.json (or the parent of its legacy `companyDir`), or null. */
export function configuredCompanyHome(stateRoot: string): string | null {
  try {
    const c = JSON.parse(readFileSync(join(stateRoot, 'hq.config.json'), 'utf8')) as { companyHome?: unknown; companyDir?: unknown };
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? resolve(expandHome(v.trim())) : null);
    return str(c.companyHome) ?? (str(c.companyDir) ? resolve(str(c.companyDir)!, '..') : null);
  } catch { return null; }
}

export interface CompanyHomeOptions {
  env?: NodeJS.ProcessEnv;
  /** The state root whose hq.config.json may set `companyHome`; default COMPANY_STATE_DIR (shifts), AGENT_COMPANY_STATE (hq),
   *  else ~/.local/state/agent-company. */
  stateRoot?: string;
  /** When nothing is configured; default ENGINE_ROOT. */
  fallback?: string;
}

/** The company's home: env COMPANY_HOME, else hq.config.json's `companyHome`, else the engine repo. Absolute. */
export function resolveCompanyHome(o: CompanyHomeOptions = {}): string {
  const env = o.env ?? process.env;
  const fromEnv = env[COMPANY_HOME_ENV]?.trim();
  if (fromEnv) return resolve(expandHome(fromEnv));
  const stateRoot = o.stateRoot ?? (env.COMPANY_STATE_DIR || env.AGENT_COMPANY_STATE) ?? join(homedir(), '.local', 'state', 'agent-company');
  return configuredCompanyHome(stateRoot) ?? resolve(o.fallback ?? ENGINE_ROOT);
}

/** What shift-host hands a worker as COMPANY_HOME, at every start (so a restart follows the split or a rollback):
 *  --company-home, env COMPANY_HOME, hq.config.json's companyHome; null = not configured (the worker reads the
 *  engine repo through COMPANY_REPO, as before). */
export function shiftCompanyHome(arg: string | undefined, env: NodeJS.ProcessEnv, stateRoot: string): string | null {
  const given = arg?.trim() || env[COMPANY_HOME_ENV]?.trim();
  return given ? resolve(expandHome(given)) : configuredCompanyHome(stateRoot);
}

/** <home>/company: org.yaml, company.md, projects/, identities/, skills/. */
export const companyDirOf = (home: string): string => join(home, 'company');
/** <home>/memory: L3. */
export const memoryDirOf = (home: string): string => join(home, 'memory');
