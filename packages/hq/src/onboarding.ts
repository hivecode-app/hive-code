// New installations remain idle until a device acknowledges full access and chooses projects.
// Existing companies bypass this flow; no consent migration changes their working behaviour.
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { parse, parseDocument } from 'yaml';
import type { Hq } from './hq.ts';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';
import type { Caller } from './auth.ts';
import { AuthError } from './auth.ts';
import { usage, sufficientUntil } from './usage.ts';

export const CONSENT_VERSION = '2026-11-04';
export function setupPending(companyDir: string): boolean {
  try { return parse(readFileSync(join(companyDir, 'org.yaml'), 'utf8'))?.setup === 'pending'; }
  catch { return false; }
}
export function hasConsent(store: Store): boolean {
  return !!store.db.prepare('SELECT 1 FROM consents WHERE version = ? LIMIT 1').get(CONSENT_VERSION);
}
export function setupMayRun(store: Store, dir: string): boolean {
  return !setupPending(dir) || (hasConsent(store) && store.getMeta('setup.started') === '1');
}

// Only named commands with fixed arguments. Tests inject a runner; no login opens in the daemon.
export type SetupCommand = (file: string, args: string[]) => Promise<string>;
export const setupCommand: SetupCommand = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(out));
});
export async function connectionStatus(service: string, run: SetupCommand = setupCommand): Promise<boolean> {
  try {
    if (service === 'claude') {
      const v = JSON.parse(await run('claude', ['auth', 'status', '--json']));
      return v.loggedIn === true;
    }
    if (service === 'github') { await run('gh', ['api', 'user', '--jq', '.login']); return true; }
    throw new Error('invalid service');
  } catch { return false; }
}
export async function repositories(page: number, run: SetupCommand = setupCommand) {
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new AuthError(400, 'invalid page');
  const rows = JSON.parse(await run('gh', ['api', `user/repos?per_page=50&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`])) as
    { full_name: string; description: string | null; archived: boolean; permissions?: { push?: boolean } }[];
  const repos = rows.filter(r => !r.archived && r.permissions?.push).map(r => ({ name: r.full_name, description: r.description ?? '' }));
  return { repos, more: rows.length === 50, page };
}

export interface WorkSettings { parallel: number; autoAccounts: boolean }
export function workSettings(store: Store, cfg: HqConfig): WorkSettings {
  const saved = store.getMeta('work.settings');
  if (saved) {
    const { parallel, autoAccounts } = JSON.parse(saved) as WorkSettings;
    return { parallel, autoAccounts };
  }
  const fresh = setupPending(cfg.companyDir);
  return { parallel: cfg.capacity.maxSlots, autoAccounts: !fresh };
}
export function saveWorkSettings(store: Store, cfg: HqConfig, body: Record<string, unknown>): WorkSettings {
  const v = { ...workSettings(store, cfg), ...body };
  if (!Number.isInteger(v.parallel) || v.parallel < 1 || v.parallel > 32 ||
      typeof v.autoAccounts !== 'boolean') {
    throw new AuthError(400, 'invalid work settings');
  }
  const value: WorkSettings = { parallel: v.parallel, autoAccounts: v.autoAccounts };
  store.setMeta('work.settings', JSON.stringify(value));
  applyWorkSettings(store, cfg);
  store.emit('settings.changed', null, value);
  return value;
}
export function applyWorkSettings(store: Store, cfg: HqConfig): void {
  if (!store.getMeta('work.settings') && !setupPending(cfg.companyDir)) return;
  const v = workSettings(store, cfg);
  // Persist defaults while setup is still pending; removing that marker must not change them.
  if (!store.getMeta('work.settings')) store.setMeta('work.settings', JSON.stringify(v));
  cfg.capacity.maxSlots = v.parallel;
}
export function autoAccounts(store: Store): boolean {
  const saved = store.getMeta('work.settings');
  return saved ? (JSON.parse(saved) as WorkSettings).autoAccounts : true;
}
// APK 2328 reads these fields after both loading and saving. Remove this response-only
// compatibility shim after the new APK is deployed; these values never schedule work.
function workSettingsResponse(settings: WorkSettings) {
  return { settings: { ...settings, nightEnabled: false, nightStart: '23:00', nightEnd: '07:00' } };
}

type Context = { body: () => Promise<Record<string, unknown>>; caller: Caller; url: URL };
type Route = (method: string, path: string, handler: (ctx: Context) => unknown | Promise<unknown>) => unknown;
export function onboardingRoutes(hq: Hq, route: Route): void {
  route('GET', '/api/setup', () => ({ pending: setupPending(hq.cfg.companyDir), consent: hasConsent(hq.store), version: CONSENT_VERSION,
    started: hq.store.getMeta('setup.started') === '1', selected: JSON.parse(hq.store.getMeta('setup.selected') || '[]'), manager: hq.cfg.managerId }));
  route('POST', '/api/consent', async ({ body, caller }) => {
    const b = await body();
    if (b.accepted !== true || b.version !== CONSENT_VERSION || !['en', 'he'].includes(String(b.language))) throw new AuthError(400, 'invalid consent');
    const device = caller.kind === 'device' ? caller.id : 'terminal';
    if (setupPending(hq.cfg.companyDir)) {
      const file = join(hq.cfg.companyDir, 'org.yaml');
      const doc = parseDocument(readFileSync(file, 'utf8'));
      doc.set('owner_language', b.language);
      writeFileSync(`${file}.consent-tmp`, doc.toString(), { mode: 0o600 });
      renameSync(`${file}.consent-tmp`, file);
    }
    hq.store.db.prepare('INSERT OR IGNORE INTO consents(version,device,language,accepted_at) VALUES(?,?,?,?)').run(CONSENT_VERSION, device, b.language, hq.store.now());
    return { consent: true, version: CONSENT_VERSION };
  });
  route('POST', '/api/setup/check', async ({ body }) => {
    const { service } = await body();
    if (!['claude', 'github'].includes(String(service))) throw new AuthError(400, 'invalid service');
    return { service, connected: await connectionStatus(String(service), hq.setupCommand) };
  });
  route('GET', '/api/setup/repos', async ({ url }) => {
    try { return await repositories(Number(url.searchParams.get('page') ?? '1'), hq.setupCommand); }
    catch (e) { if (e instanceof AuthError) throw e; throw new AuthError(403, 'github repositories unavailable'); }
  });
  route('POST', '/api/setup/projects', async ({ body }) => {
    if (!setupPending(hq.cfg.companyDir) || hq.store.getMeta('setup.started') === '1') throw new AuthError(409, 'setup already started');
    if (!hasConsent(hq.store)) throw new AuthError(403, 'consent required');
    const { selected } = await body();
    if (!Array.isArray(selected) || !selected.length || selected.length > 500 || selected.some(r => typeof r !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(r))) throw new AuthError(400, 'invalid repositories');
    const unique = [...new Set(selected)];
    const file = join(hq.cfg.companyDir, 'org.yaml');
    const doc = parseDocument(readFileSync(file, 'utf8'));
    doc.set('setup_repositories', unique);
    writeFileSync(`${file}.setup-tmp`, doc.toString(), { mode: 0o600 });
    renameSync(`${file}.setup-tmp`, file);
    hq.store.setMeta('setup.selected', JSON.stringify(unique));
    return { selected: unique };
  });
  route('POST', '/api/setup/start', async () => {
    if (!setupPending(hq.cfg.companyDir)) return { started: true, manager: hq.cfg.managerId };
    if (!hasConsent(hq.store) || !JSON.parse(hq.store.getMeta('setup.selected') || '[]').length) throw new AuthError(403, 'consent and projects required');
    if (hq.store.getMeta('setup.started') !== '1') {
      const ready = await Promise.all(['claude', 'github'].map(service => connectionStatus(service, hq.setupCommand)));
      if (ready.some(v => !v)) throw new AuthError(409, 'connections required');
    }
    // Idempotent mailbox ID and state survive retries and process restarts.
    hq.store.setMeta('setup.started', '1');
    hq.mailbox.tell({ to: hq.cfg.managerId, body: 'Begin company setup using skills/setup/SKILL.md and setup_repositories in org.yaml. Consent is recorded. Continue setup in this conversation, then demonstrate one task with a PR, independent review and owner approval. Never deploy.', msg_id: 'first-company-setup' });
    return { started: true, manager: hq.cfg.managerId };
  });
  route('GET', '/api/settings/work', () => workSettingsResponse(workSettings(hq.store, hq.cfg)));
  route('POST', '/api/settings/work', async ({ body }) => workSettingsResponse(saveWorkSettings(hq.store, hq.cfg, await body())));
  route('GET', '/api/usage/forecast', () => {
    const accounts = hq.accounts.capacity();
    const u = usage(hq.store, accounts.map(a => a.name), id => hq.mailbox.label(id));
    const remaining = accounts.length ? accounts.reduce((n, a) => n + (100 - (a.seven_day_pct ?? 0)), 0) / accounts.length : null;
    const resets = accounts.map(a => a.seven_day_resets_at).filter((v): v is number => v != null);
    return { sufficient_until: sufficientUntil(hq.store.now(), u.day_pct, remaining, resets.length ? Math.min(...resets) : null), measured_at: u.measured_at, day_pct: u.day_pct };
  });
}
