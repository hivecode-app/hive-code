// hq configuration. Everything lives under the state dir (B.11) — never /tmp.
// Override order: defaults < $STATE/hq.config.json < env.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TabConfig } from './tab/handoffs.ts';
import type { DictateConfig } from './dictate.ts';

export interface HqConfig {
  stateDir: string;
  dbPath: string;
  companyDir: string;            // the contract: company/org.yaml, company/projects/*.md
  host: string;
  port: number;
  managerId: string;             // יואב — receives escalations
  monitoringLeadId: string;      // רותם — receives probe anomalies
  telegramChat: string;
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
    accountsMs: number;          // B.7: quota read per account (get_usage), 10 min
  };
  capacity: {
    reserveMb: number;           // B.5: 4GB reserve
    rssIdleMb: number;           // placeholder until measured at the gate
    rssWorkMb: number;           // placeholder until measured at the gate
    residents: string[];         // resident pool (not counted in work slots): יואב
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
  };
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

export function defaultStateDir(): string {
  return process.env.AGENT_COMPANY_STATE ?? join(homedir(), '.local', 'state', 'agent-company');
}

export function loadConfig(overrides: Partial<HqConfig> = {}): HqConfig {
  const stateDir = overrides.stateDir ?? defaultStateDir();
  const base: HqConfig = {
    stateDir,
    dbPath: join(stateDir, 'hq.db'),
    companyDir: resolve(process.env.AGENT_COMPANY_DIR ?? join(import.meta.dirname, '..', '..', '..', 'company')),
    host: '127.0.0.1',
    port: 7420,
    managerId: 'yoav',
    monitoringLeadId: 'rotem',
    telegramChat: '100000001',
    telegramCmd: join(homedir(), 'bin', 'telegram-send'),
    defaultCwd: resolve(import.meta.dirname, '..', '..', '..'),
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
      accountsMs: 10 * 60_000,
    },
    capacity: { reserveMb: 4096, rssIdleMb: 450, rssWorkMb: 2500, residents: ['yoav'], maxSlots: 8 },
    backupsKeep: 48,
    auth: {
      rpId: 'app.hq.example.com',
      rpName: 'החברה',
      // The APK's origin is the sha256 of its release signing cert (public; tool/make_keystore.sh).
      origins: ['https://app.hq.example.com', 'android:apk-key-hash:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
      appUrl: 'https://app.hq.example.com/',
      pairCodeMs: 10 * 60_000,
    },
    dictate: { url: 'http://127.0.0.1:8790', token: process.env.DICTATE_TOKEN || null },
    accounts: [
      { name: 'owner-account', label: 'החשבון הראשי', expect: 'owner-account@example.com', managed: false },
      { name: 'hive-owner', label: 'hive-owner', expect: 'hive-owner', managed: true },
    ],
    claudeHome: join(homedir(), '.claude'),
    tab: { listen: '127.0.0.1:7422', baseUrl: 'https://tab.hq.example.com', cdpUrl: 'http://127.0.0.1:9222', ttlMin: 10 },
    appReleaseDir: '/var/www/hq-app/current',
  };
  const file = join(stateDir, 'hq.config.json');
  let fromFile: Partial<HqConfig> = {};
  if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<HqConfig>;
  const cfg: HqConfig = {
    ...base, ...fromFile, ...overrides,
    timers: { ...base.timers, ...fromFile.timers, ...overrides.timers },
    capacity: { ...base.capacity, ...fromFile.capacity, ...overrides.capacity },
    auth: { ...base.auth, ...fromFile.auth, ...overrides.auth },
    tab: { ...base.tab, ...fromFile.tab, ...overrides.tab },
    dictate: { ...base.dictate, ...fromFile.dictate, ...overrides.dictate },
  };
  if (!overrides.dbPath && !fromFile.dbPath) cfg.dbPath = join(cfg.stateDir, 'hq.db');
  if (process.env.HQ_PORT) cfg.port = Number(process.env.HQ_PORT);
  if (process.env.HQ_HOST) cfg.host = process.env.HQ_HOST;
  return cfg;
}
