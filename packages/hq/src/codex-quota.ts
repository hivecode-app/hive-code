// Codex as a task worker (docs/spec/codex-helper.md, task 836): the weekly quota of the ChatGPT login Codex runs on.
// Read every 10 minutes with the accounts (hq.ts), from `codex app-server` itself (account/rateLimits/read: the
// same number Codex shows, and reading it costs nothing). Kept in meta, so a restart shows the last read at once.
//
// The guard: a task goes to Codex only while the week is under `codexTaskMaxPercent` (default 20%, the spec's
// reserve for continuity when Claude is full). Over it, or out, hq says so to whoever opened the task and does not
// move it to Claude by itself: the opener decides (open it again without `engine`).
import { spawn } from 'node:child_process';
import { LineSplitter } from '@company/shared';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import { readTimeZone, whenLocal } from './timezone.ts';

export interface CodexLimits {
  /** % of the weekly window used, as Codex reports it. */
  usedPercent: number | null;
  /** Epoch ms. */
  resetsAt: number | null;
  plan: string | null;
}
export type CodexLimitsReader = () => Promise<CodexLimits>;

export interface CodexQuotaState extends CodexLimits {
  snapshotAt: number | null;
  error: string | null;
}

const META = 'codex.quota';
/** A task whose worker runs on Codex (open_team `engine: "codex"`), and the model it asked for. */
export const CODEX_LABEL = 'engine:codex';
export const CODEX_MODEL_LABEL = 'codex-model:';

/** A task's labels (the JSON column) → its Codex engine, or null for a Claude task. */
export function codexOf(labels: string | null | undefined): { model: string | null } | null {
  let l: string[]; try { l = JSON.parse(labels || '[]'); } catch { return null; }
  if (!l.includes(CODEX_LABEL)) return null;
  return { model: l.find((x) => x.startsWith(CODEX_MODEL_LABEL))?.slice(CODEX_MODEL_LABEL.length) || null };
}
export const DEFAULT_TASK_MAX_PERCENT = 20;

/** One short-lived `codex app-server`: initialize, read the rate limits, exit. No turn, no thread. */
export function appServerLimits(bin = 'codex', timeoutMs = 20_000): CodexLimitsReader {
  return () => new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.OPENAI_API_KEY; // the ChatGPT login only, as in codex-process.ts
    const child = spawn(bin, ['app-server', '--listen', 'stdio://'], { stdio: ['pipe', 'pipe', 'ignore'], env });
    let done = false;
    const finish = (e: Error | null, v?: CodexLimits) => {
      if (done) return; done = true; clearTimeout(timer);
      try { child.stdin.end(); child.kill('SIGTERM'); } catch { /* gone */ }
      if (e) reject(e); else resolve(v!);
    };
    const timer = setTimeout(() => finish(new Error('codex app-server did not answer')), timeoutMs);
    child.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`codex app-server exited (${code})`)));
    const split = new LineSplitter((line) => {
      let o: any; try { o = JSON.parse(line); } catch { return; }
      if (o.id === 1) {
        if (o.error) return finish(new Error(o.error.message ?? 'initialize failed'));
        child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ id: 2, method: 'account/rateLimits/read', params: {} }) + '\n');
      } else if (o.id === 2) {
        if (o.error) return finish(new Error(o.error.message ?? 'rateLimits/read failed'));
        finish(null, parseLimits(o.result));
      }
    });
    child.stdout.on('data', (d: Buffer) => { try { split.push(d); } catch { /* a bad line is skipped */ } });
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent_company', title: 'Agent Company', version: '0.1' } } }) + '\n');
  });
}

/** The weekly window (10080 minutes) of account/rateLimits/read; `prolite` has no 5-hour one. */
export function parseLimits(result: any): CodexLimits {
  const rl = result?.rateLimits ?? {};
  const windows = [rl.primary, rl.secondary].filter(Boolean);
  const week = windows.find((w: any) => w.windowDurationMins === 10080) ?? windows[0];
  const at = typeof week?.resetsAt === 'number' ? week.resetsAt * (week.resetsAt < 1e12 ? 1000 : 1) : null;
  return { usedPercent: typeof week?.usedPercent === 'number' ? week.usedPercent : null, resetsAt: at, plan: typeof rl.planType === 'string' ? rl.planType : null };
}

export class CodexQuota {
  private store: Store;
  private cfg: HqConfig;
  private read: CodexLimitsReader;
  constructor(store: Store, cfg: HqConfig, read?: CodexLimitsReader) {
    this.store = store; this.cfg = cfg; this.read = read ?? appServerLimits(cfg.codexBin);
  }

  get maxPercent(): number { return this.cfg.codexTaskMaxPercent ?? DEFAULT_TASK_MAX_PERCENT; }

  state(): CodexQuotaState | null {
    try { return JSON.parse(this.store.getMeta(META) || 'null'); } catch { return null; }
  }

  async refresh(): Promise<CodexQuotaState> {
    const prev = this.state();
    let next: CodexQuotaState;
    try {
      next = { ...(await this.read()), snapshotAt: this.store.now(), error: null };
    } catch (e) {
      // The last good numbers stay, with why this read failed.
      next = { usedPercent: prev?.usedPercent ?? null, resetsAt: prev?.resetsAt ?? null, plan: prev?.plan ?? null,
        snapshotAt: prev?.snapshotAt ?? null, error: (e as Error).message.slice(0, 160) };
    }
    this.store.setMeta(META, JSON.stringify(next));
    this.store.emit('codex.quota', null, { used_percent: next.usedPercent, resets_at: next.resetsAt, error: next.error });
    return next;
  }

  /** Why a new Codex task can't start now (Hebrew, for the opener), or null when it can. Unknown = it may start. */
  blocked(): string | null {
    const s = this.state();
    const now = this.store.now();
    // A read from a week that has already reset says nothing about this one: unknown, like no read.
    if (s?.usedPercent == null || (s.resetsAt != null && s.resetsAt <= now)) return null;
    const pct = Math.round(s.usedPercent);
    const reset = s.resetsAt && s.resetsAt > now ? `, והיא מתאפסת ${whenLocal(s.resetsAt, now, readTimeZone(this.cfg.companyDir))}` : '';
    if (s.usedPercent >= 100) return `מכסת Codex של השבוע נגמרה (${pct}%${reset})`;
    if (s.usedPercent >= this.maxPercent) {
      return `מכסת Codex על ${pct}%${reset}. משימות נשלחות ל-Codex רק עד ${this.maxPercent}% מהשבוע, והשאר שמור להמשכיות כשמכסת Claude נגמרת`;
    }
    return null;
  }

  /** The home's "המכסה" row (home.ts QuotaLine), or null before the first read. */
  line() {
    const s = this.state();
    if (!s || (s.snapshotAt == null && s.usedPercent == null)) return null;
    const full = s.usedPercent != null && s.usedPercent >= 100;
    const over = s.usedPercent != null && s.usedPercent >= this.maxPercent;
    return {
      name: 'codex', label: 'Codex', usable: s.usedPercent != null, full, reopens_at: full ? s.resetsAt : null,
      five_hour_pct: null, seven_day_pct: s.usedPercent, five_hour_resets_at: null, seven_day_resets_at: s.resetsAt, snapshot_at: s.snapshotAt,
      ...(over && !full ? { note: `לא מקבל משימות חדשות עד האיפוס, כי עבר את התקרה של ${this.maxPercent}%` } : {}),
    };
  }
}
