// hq configuration. Everything lives under the state dir (B.11) — never /tmp.
// Override order: generic defaults < company/org.yaml (manager, monitoring_lead, residents)
// < $STATE/hq.config.json < env. Nothing of one particular company lives in the defaults: a company's
// own values (names, domains, accounts, Telegram) come from its hq.config.json (hq-host's is
// company/hq.config.json, installed by scripts/deploy.sh hq).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { TabConfig } from './tab/handoffs.ts';
import type { DictateConfig } from './dictate.ts';

export interface HqConfig {
  stateDir: string;
  dbPath: string;
  companyDir: string;            // the contract: company/org.yaml, company/projects/*.md
  host: string;
  port: number;
  managerId: string;             // receives escalations (org.yaml `manager`)
  monitoringLeadId: string;      // receives probe anomalies (org.yaml `monitoring_lead`)
  telegramChat: string;          // '' = no Telegram
  telegramCmd: string;
  defaultCwd: string;            // cwd for shifts without a task worktree
  /** systemd template for shifts (persistent; linked into ~/.config/systemd/user on first launch). */
  shiftTemplate: string;
  /** Extra listener serving only GET /health (for the ci-host heartbeat), e.g. "0.0.0.0:7421". Off by default. */
  healthListen: string | null;
  morningFromHour: number;       // night mode ends on his first message from this hour (org.yaml `timezone`)
  timers: {
    deliveryTimeoutMs: number;   // B.4: 60s without `delivered` → retry with resurrection → visible failure
    watchdogMs: number;          // B.5: 15s
    schedulerMs: number;         // B.16: sweep every minute (also runs on slot-free)
    stuckAfterMs: number;        // B.5: 10 min without an event during a turn
    escalateBlockingAskMs: number; // A.4: 10 min
    pushAckTimeoutMs: number;    // B.8: urgent push not acked in 5 min → Telegram too
    backupMs: number;            // B.11: hourly
    restAfterMs: number;         // B.2: 20 min idle → rest
    livenessMs: number;          // bet 4: claude ping (get_context_usage) interval; unresponsive after 3 misses
    unresponsiveActMs: number;   // unresponsive this long → interrupt, then a fresh process (resume)
    taskRetryMs: number;         // a task whose shift just started is not restarted again within this window
    handoffGraceMs: number;      // close_team on a standing worker's task: this long to write a handoff before the stop
    turnEndWaitMs: number;       // status done mid-turn: the turn ends first (its text may be his reply, #118), at most this long
    accountsMs: number;          // B.7: quota read per account (get_usage), 10 min
  };
  capacity: {
    reserveMb: number;           // B.5: 4GB reserve
    rssIdleMb: number;           // placeholder until measured at the gate
    rssWorkMb: number;           // placeholder until measured at the gate
    residents: string[];         // resident pool (not counted in work slots): org.yaml `resident: true`, else the manager
    maxSlots: number;
  };
  backupsKeep: number;
  /** WebAuthn and device pairing (auth.ts). */
  auth: {
    rpId: string;                // passkeys are bound to this host (and its subdomains)
    rpName: string;
    /** Accepted clientData origins: the web app, plus `android:apk-key-hash:<b64url sha256>` for the APK. */
    origins: string[];
    /** Where a pairing link points (`<appUrl>?pair=<code>`); null = code only. */
    appUrl: string | null;
    pairCodeMs: number;
    /** The passkey's user, as the phone's password manager shows it. */
    userName: string;
    userDisplayName: string;
  };
  /** hq's public URL (api.hq behind Caddy): deploy and verify-prod check it from the outside. null = local only. */
  apiUrl: string | null;
  /** VAPID subject for web push (a mailto: or https: URL), used only when vapid.json is first created. */
  pushContact: string;
  /** Optional import of the owner's own Claude memory dirs into L3 (the bet-9 corpus). Read-only. */
  memoryImport: { domain: string; dir: string }[];
  /** dictate-server for the app's mic (dictate.ts). token: DICTATE_TOKEN from hq.env; null = the mic shows an error. */
  dictate: DictateConfig;
  /** B.7: the accounts the company runs on. managed=false is the CLI's own ~/.claude login, never touched
   *  (dir-0016); managed=true gets its own config dir under state/accounts/<name>. */
  accounts: AccountDef[];
  /** The owner's global Claude dir: read-only for us, source of the shared projects/sessions symlinks. */
  claudeHome: string;
  /** B.9 tab handoff: the phone page listener (tab.hq behind Caddy) and the shared Chrome's CDP. */
  tab: TabConfig;
  /** The live app release dir (scripts/deploy.sh app): its app-release.json and APK feed the in-app update. null = none. */
  appReleaseDir: string | null;
}

export interface AccountDef {
  name: string;
  label: string;
  /** Email he asked to connect, or just its local part (verified after every login). */
  expect: string;
  managed: boolean;
}

/** The APK's origin: the sha256 of its release signing cert (public; tool/make_keystore.sh). It is the engine's
 *  own key, the same on every server, so it is always accepted. scripts/deploy.sh and verify-prod read it from here. */
export const APK_ORIGIN = 'android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

interface OrgDefaults { manager?: string; monitoringLead?: string; residents: string[] }

/** What hq takes from company/org.yaml as defaults. A missing or broken file gives none. */
export function orgDefaults(companyDir: string): OrgDefaults {
  try {
    const org = parse(readFileSync(join(companyDir, 'org.yaml'), 'utf8')) as Record<string, unknown> | null;
    if (!org || typeof org !== 'object') return { residents: [] };
    const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const people = Array.isArray(org.identities) ? org.identities as { id?: unknown; resident?: unknown }[] : [];
    return {
      manager: str(org.manager), monitoringLead: str(org.monitoring_lead),
      residents: people.filter((p) => p?.resident === true && typeof p.id === 'string').map((p) => p.id as string),
    };
  } catch { return { residents: [] }; }
}

export function defaultStateDir(): string {
  return process.env.AGENT_COMPANY_STATE ?? join(homedir(), '.local', 'state', 'agent-company');
}

export function loadConfig(overrides: Partial<HqConfig> = {}): HqConfig {
  const stateDir = overrides.stateDir ?? defaultStateDir();
  const file = join(stateDir, 'hq.config.json');
  let fromFile: Partial<HqConfig> = {};
  if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<HqConfig>;
  const companyDir = overrides.companyDir ?? fromFile.companyDir
    ?? resolve(process.env.AGENT_COMPANY_DIR ?? join(import.meta.dirname, '..', '..', '..', 'company'));
  const org = orgDefaults(companyDir);
  const managerId = overrides.managerId ?? fromFile.managerId ?? org.manager ?? 'manager';
  const base: HqConfig = {
    stateDir,
    dbPath: join(stateDir, 'hq.db'),
    companyDir,
    host: '127.0.0.1',
    port: 7420,
    managerId,
    monitoringLeadId: org.monitoringLead ?? managerId,
    telegramChat: '',
    telegramCmd: join(homedir(), 'bin', 'telegram-send'),
    defaultCwd: homedir(),
    shiftTemplate: resolve(import.meta.dirname, '..', '..', 'shift-host', 'systemd', 'company-shift@.service'),
    healthListen: null,
    morningFromHour: 5,
    timers: {
      deliveryTimeoutMs: 60_000,
      watchdogMs: 15_000,
      schedulerMs: 60_000,
      stuckAfterMs: 10 * 60_000,
      escalateBlockingAskMs: 10 * 60_000,
      pushAckTimeoutMs: 5 * 60_000,
      backupMs: 60 * 60_000,
      restAfterMs: 20 * 60_000,
      livenessMs: 5_000,
      unresponsiveActMs: 2 * 60_000,
      taskRetryMs: 60_000,
      handoffGraceMs: 5 * 60_000,
      turnEndWaitMs: 3 * 60_000,
      accountsMs: 10 * 60_000,
    },
    capacity: { reserveMb: 4096, rssIdleMb: 450, rssWorkMb: 2500, residents: org.residents.length ? org.residents : [managerId], maxSlots: 8 },
    backupsKeep: 48,
    auth: {
      rpId: 'localhost',
      rpName: 'החברה',
      origins: [],               // the web app's origin; APK_ORIGIN is added below
      appUrl: null,
      pairCodeMs: 10 * 60_000,
      userName: 'owner',
      userDisplayName: 'owner',
    },
    dictate: { url: null, token: process.env.DICTATE_TOKEN || null },
    // The CLI's own ~/.claude login only. More accounts come from hq.config.json.
    accounts: [{ name: 'claude', label: 'Claude', expect: '', managed: false }],
    claudeHome: join(homedir(), '.claude'),
    tab: { listen: '127.0.0.1:7422', baseUrl: 'http://127.0.0.1:7422', cdpUrl: 'http://127.0.0.1:9222', ttlMin: 10 },
    appReleaseDir: '/var/www/hq-app/current',
    apiUrl: null,
    pushContact: 'mailto:owner@localhost',
    memoryImport: [],
  };
  const cfg: HqConfig = {
    ...base, ...fromFile, ...overrides,
    timers: { ...base.timers, ...fromFile.timers, ...overrides.timers },
    capacity: { ...base.capacity, ...fromFile.capacity, ...overrides.capacity },
    auth: { ...base.auth, ...fromFile.auth, ...overrides.auth },
    tab: { ...base.tab, ...fromFile.tab, ...overrides.tab },
    dictate: { ...base.dictate, ...fromFile.dictate, ...overrides.dictate },
  };
  if (!cfg.auth.origins.includes(APK_ORIGIN)) cfg.auth.origins = [...cfg.auth.origins, APK_ORIGIN];
  if (!overrides.dbPath && !fromFile.dbPath) cfg.dbPath = join(cfg.stateDir, 'hq.db');
  if (process.env.HQ_PORT) cfg.port = Number(process.env.HQ_PORT);
  if (process.env.HQ_HOST) cfg.host = process.env.HQ_HOST;
  return cfg;
}
