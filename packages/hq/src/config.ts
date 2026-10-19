// hq configuration. Everything lives under the state dir (B.11) — never /tmp.
// Override order: defaults < $STATE/hq.config.json < env.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

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
  };
  capacity: {
    reserveMb: number;           // B.5: 4GB reserve
    rssIdleMb: number;           // placeholder until measured at the gate
    rssWorkMb: number;           // placeholder until measured at the gate
    residents: string[];         // resident pool (not counted in work slots): יואב
    maxSlots: number;
  };
  backupsKeep: number;
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
    },
    capacity: { reserveMb: 4096, rssIdleMb: 450, rssWorkMb: 2500, residents: ['yoav'], maxSlots: 8 },
    backupsKeep: 48,
  };
  const file = join(stateDir, 'hq.config.json');
  let fromFile: Partial<HqConfig> = {};
  if (existsSync(file)) fromFile = JSON.parse(readFileSync(file, 'utf8')) as Partial<HqConfig>;
  const cfg: HqConfig = {
    ...base, ...fromFile, ...overrides,
    timers: { ...base.timers, ...fromFile.timers, ...overrides.timers },
    capacity: { ...base.capacity, ...fromFile.capacity, ...overrides.capacity },
  };
  if (!overrides.dbPath && !fromFile.dbPath) cfg.dbPath = join(cfg.stateDir, 'hq.db');
  if (process.env.HQ_PORT) cfg.port = Number(process.env.HQ_PORT);
  if (process.env.HQ_HOST) cfg.host = process.env.HQ_HOST;
  return cfg;
}
