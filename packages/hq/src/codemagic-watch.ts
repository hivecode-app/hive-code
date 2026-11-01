// task-1192: Codemagic has no spending cap, so this is ours. Once a day hq reads the account's build time this billing
// period (GET /user: the same seconds Codemagic bills, free and paid apart) and the builds of this month (GET /builds, for
// the split by workflow). When the macOS minutes pass 400, and again 800 and 1,500, he gets one message in Hebrew from
// the automation's owner, with the cost so far in dollars. Each threshold once a month; a jump over two sends the higher.
// A month that passed one after its last read (the 9:00 of its last day) is told in the first days of the next, from
// Codemagic's previousPeriod.
// The automation is `codemagic-minutes` in org.yaml; without it, switched off, or with no `codemagic` in hq.config.json,
// nothing is read. A read that fails tells the owner, once a day, so a dead token is not a quiet month.
import { readFileSync } from 'node:fs';
import { expandHome, OWNER } from '@company/shared';
import type { Hq } from './hq.ts';
import { readTimeZone, tzOffsetMs } from './timezone.ts';

export const AUTOMATION = 'codemagic-minutes';
export const THRESHOLDS = [400, 800, 1500];
/** The daily read goes from this hour, in org.yaml's time zone. */
export const READ_HOUR = 9;
const API = 'https://api.codemagic.io';
const META = 'codemagic.';

export interface CodemagicConfig {
  /** A file holding the API token (Codemagic > User settings > Integrations > Codemagic API). */
  tokenFile: string;
  /** Dollars per paid macOS minute. Default 0.095, the pay-as-you-go price of mac_mini_m2. */
  usdPerMinute?: number;
}

export interface Build { workflow: string; instanceType: string; startedAt: string | null; finishedAt: string | null }
export interface Usage {
  /** buildTime of usage.currentPeriod, in seconds per bucket (`mac_mini_m2_free`, `mac_mini_m2_personal`, ...). */
  buildTime: Record<string, number>;
  /** buildTime of usage.previousPeriod: last month's. */
  previous: Record<string, number>;
  /** usage.freeLimit.buildTime, seconds. */
  freeSeconds: number;
}
export interface CodemagicApi { usage(): Promise<Usage>; builds(sinceMs: number): Promise<Build[]> }

const isMac = (k: string) => k.startsWith('mac');

/** The macOS minutes of the period, and how many of them are paid (every bucket that is not `_free`). */
export function macMinutes(buildTime: Record<string, number>): { total: number; paid: number } {
  let total = 0, paid = 0;
  for (const [k, s] of Object.entries(buildTime)) {
    if (!isMac(k) || typeof s !== 'number') continue;
    total += s;
    if (!k.endsWith('_free')) paid += s;
  }
  return { total: Math.round(total / 60), paid: Math.round(paid / 60) };
}

/** Minutes by workflow of the macOS builds that started in [sinceMs, untilMs), each rounded up as a whole minute; most first. */
export function byWorkflow(builds: Build[], sinceMs: number, untilMs: number, now: number): { workflow: string; minutes: number; builds: number }[] {
  const m = new Map<string, { minutes: number; builds: number }>();
  for (const b of builds) {
    if (!isMac(b.instanceType) || !b.startedAt) continue;
    const start = Date.parse(b.startedAt);
    if (!(start >= sinceMs) || start >= untilMs) continue;
    const end = b.finishedAt ? Date.parse(b.finishedAt) : now;
    const row = m.get(b.workflow) ?? { minutes: 0, builds: 0 };
    row.minutes += Math.max(1, Math.ceil((end - start) / 60_000));
    row.builds++;
    m.set(b.workflow, row);
  }
  return [...m].map(([workflow, r]) => ({ workflow, ...r })).sort((a, b) => b.minutes - a.minutes || a.workflow.localeCompare(b.workflow));
}

const n = (x: number) => x.toLocaleString('en-US');
const usd = (x: number) => `$${x.toFixed(2)}`;

/** The message for the highest threshold passed; `ended` = last month's, told after it closed. */
export function message(threshold: number, buildTime: Record<string, number>, u: Usage, split: ReturnType<typeof byWorkflow>,
  usdPerMinute: number, ended = false): string {
  const { total, paid } = macMinutes(buildTime);
  const free = Math.round(u.freeSeconds / 60);
  const cost = paid > 0
    ? `${ended ? 'העלות' : 'העלות עד עכשיו'}: ${usd(paid * usdPerMinute)} (${n(paid)} דקות בתשלום, ${usdPerMinute} דולר לדקה, אחרי ${n(free)} הדקות החינמיות).`
    : `עוד אין עלות: ${n(free)} הדקות הראשונות בחודש חינם, ואחריהן ${usdPerMinute} דולר לדקה.`;
  const next = THRESHOLDS.find((t) => t > total);
  const rows = split.map((r) => `- ${r.workflow}: ${n(r.minutes)} דקות (${r.builds === 1 ? 'בילד אחד' : `${r.builds} בילדים`})`);
  return [
    ended
      ? `דקות ה-macOS ב-Codemagic עברו את ${n(threshold)} בחודש שעבר, אחרי הבדיקה האחרונה שלו: ${n(total)} דקות בסך הכול.`
      : `דקות ה-macOS ב-Codemagic עברו את ${n(threshold)} החודש: ${n(total)} דקות עד עכשיו.`,
    cost,
    `ב-Codemagic אין תקרת הוצאה. ${ended ? 'החודש הזה התחיל מאפס.' : next ? `ההתראה הבאה ב-${n(next)} דקות.` : 'זו ההתראה האחרונה החודש.'}`,
    ...(rows.length ? ['', 'לפי workflow (כל בילד מעוגל לדקה שלמה, ולכן הסכום כאן קצת גבוה מהסך הכול):', ...rows] : []),
  ].join('\n');
}

/** The real API, with the token from the file. Builds come newest first, 30 a page: read until older than `sinceMs`. */
export function httpApi(cfg: CodemagicConfig, fetchFn: typeof fetch = fetch): CodemagicApi {
  const get = async (path: string): Promise<any> => {
    const token = readFileSync(expandHome(cfg.tokenFile), 'utf8').trim();
    const r = await fetchFn(`${API}${path}`, { headers: { 'x-auth-token': token }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  };
  return {
    async usage() {
      const u = (await get('/user'))?.user?.billing?.usage;
      if (!u?.currentPeriod?.buildTime) throw new Error('/user: no billing.usage.currentPeriod');
      return { buildTime: u.currentPeriod.buildTime, previous: u.previousPeriod?.buildTime ?? {}, freeSeconds: Number(u.freeLimit?.buildTime ?? 0) };
    },
    async builds(sinceMs) {
      const out: Build[] = [];
      for (const app of (await get('/apps'))?.applications ?? []) {
        for (let skip = 0; skip < 3000; skip += 30) {
          const page: any[] = (await get(`/builds?appId=${encodeURIComponent(app._id)}&skip=${skip}`))?.builds ?? [];
          for (const b of page) {
            out.push({ workflow: b.fileWorkflowId ?? b.workflowId ?? '?', instanceType: String(b.instanceType ?? ''),
              startedAt: b.startedAt ?? null, finishedAt: b.finishedAt ?? null });
          }
          if (page.length < 30 || page.every((b) => Date.parse(b.createdAt) < sinceMs)) break;
        }
      }
      return out;
    },
  };
}

export class CodemagicWatch {
  private hq: Hq;
  /** Tests put a fake here; null = from hq.config.json's `codemagic`. */
  api: CodemagicApi | null = null;
  constructor(hq: Hq) { this.hq = hq; }

  /** The identity whose org.yaml automations hold `codemagic-minutes`; null = no such automation. */
  owner(): string | null {
    const r = this.hq.store.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  /** Once a day from READ_HOUR local time; a failed read tries again on the next tick. */
  async sweep(): Promise<void> {
    const { store, mailbox, cfg } = this.hq;
    const owner = this.owner();
    if (!owner || !store.toggle(`${owner}/${AUTOMATION}`)) return;
    const api = this.api ?? (cfg.codemagic ? httpApi(cfg.codemagic) : null);
    if (!api) return;
    const now = store.now();
    const tz = readTimeZone(cfg.companyDir);
    const local = new Date(now + tzOffsetMs(now, tz));
    if (local.getUTCHours() < READ_HOUR) return;
    const day = local.toISOString().slice(0, 10);
    if (store.getMeta(`${META}read`) === day) return;
    // Codemagic's period is the calendar month (UTC): the builds of the split are those that started in it.
    const d = new Date(now);
    const since = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const prevSince = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
    const ym = (t: number) => new Date(t).toISOString().slice(0, 7);
    try {
      const usage = await api.usage();
      store.emit('codemagic.minutes', owner, { month: ym(since), minutes: macMinutes(usage.buildTime).total });
      // Last month only in the first days of this one (later, previousPeriod has nothing left to tell), and only if it was
      // read at least once: a month before the automation ran, or one with every read failed, is not "after its last check".
      store.setMeta(`${META}seen.${ym(since)}`, '1');
      const periods = [
        ...(d.getUTCDate() <= 3 && store.getMeta(`${META}seen.${ym(prevSince)}`) ? [{ month: ym(prevSince), buildTime: usage.previous, from: prevSince, until: since, ended: true }] : []),
        { month: ym(since), buildTime: usage.buildTime, from: since, until: Infinity, ended: false },
      ];
      let builds: Build[] | null = null;
      for (const p of periods) {
        const { total } = macMinutes(p.buildTime);
        const sentKey = `${META}sent.${p.month}`;
        const passed = THRESHOLDS.filter((t) => total >= t).at(-1);
        if (!passed || passed <= Number(store.getMeta(sentKey) ?? 0)) continue;
        builds ??= await api.builds(prevSince);
        mailbox.tell({ msg_id: `codemagic-${p.month}-${passed}`, from: owner, to: OWNER, priority: 'next',
          body: message(passed, p.buildTime, usage, byWorkflow(builds, p.from, p.until, now), cfg.codemagic?.usdPerMinute ?? 0.095, p.ended) });
        store.setMeta(sentKey, String(passed));
        store.emit('codemagic.alert', owner, { month: p.month, minutes: total, threshold: passed });
      }
      store.setMeta(`${META}read`, day);
    } catch (e) {
      const err = (e as Error).message.slice(0, 200);
      store.emit('codemagic.error', owner, { error: err });
      if (store.getMeta(`${META}error`) === day) return;
      store.setMeta(`${META}error`, day);
      mailbox.tell({ msg_id: `codemagic-error-${day}`, from: 'hq', to: owner, kind: 'system', priority: 'later',
        body: `הבדיקה היומית של דקות Codemagic (${AUTOMATION}) נכשלה: ${err}. עד שזה מתוקן אין התראה על הוצאה. הטוקן: \`codemagic.tokenFile\` ב-hq.config.json.` });
    }
  }
}
