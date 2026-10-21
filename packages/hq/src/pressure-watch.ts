// A p0 task that does not start because the machine is short of memory or loaded (task-297). On 21/10 at 04:45 task 292
// (p0) did not come up: MemAvailable was 3.5GB, under the reserve, and a Gradle daemon (7.2GB) left over from an
// Android build held it for 3 hours. Nobody was told. Now, every 30 seconds, a p0 task in the queue that the scheduler
// holds back for pressure (waitReason = BUSY_REASON) for PRESSURE_AFTER_MS becomes one incident for him, with the
// three processes that hold the most memory. The automation is `pressure-watch` in org.yaml.
import { execFile } from 'node:child_process';
import type { Hq } from './hq.ts';
import { BUSY_REASON } from './scheduler.ts';

export const AUTOMATION = 'pressure-watch';
export const PRESSURE_AFTER_MS = 10 * 60_000;
const META = (id: number) => `pressure_watch.${id}`;

export interface Proc { pid: number; rssMb: number; cmd: string }
/** The processes holding the most memory (RSS), biggest first. Injected in tests. */
export type TopProcs = (n: number) => Promise<Proc[]>;

export const topProcsByRss: TopProcs = (n) => new Promise((resolve) => {
  execFile('ps', ['-eo', 'pid=,rss=,args=', '--sort=-rss'], { timeout: 5_000, maxBuffer: 4 << 20 }, (err, out) => {
    if (err) return resolve([]);
    const rows: Proc[] = [];
    for (const line of out.split('\n')) {
      const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (m) rows.push({ pid: Number(m[1]), rssMb: Math.round(Number(m[2]) / 1024), cmd: m[3]!.slice(0, 120) });
      if (rows.length >= n) break;
    }
    resolve(rows);
  });
});

export class PressureWatch {
  private hq: Hq;
  topProcs: TopProcs;
  constructor(hq: Hq, topProcs?: TopProcs) {
    this.hq = hq;
    this.topProcs = topProcs ?? topProcsByRss;
  }

  /** The identity whose org.yaml automations hold `pressure-watch`; null = no such automation. */
  owner(): string | null {
    const r = this.hq.store.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean {
    const o = this.owner();
    return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`);
  }

  async sweep(): Promise<void> {
    const { store, scheduler, inbox } = this.hq;
    // Off: no clocks kept, so turning it on never alerts on a wait that began before.
    if (!this.enabled()) return this.forget(new Set());
    const now = store.now();
    const slots = scheduler.slots();
    const held = new Set<number>();
    for (const t of scheduler.queue()) {
      if (t.priority !== 0 || scheduler.waitReason(t, slots) !== BUSY_REASON) continue;
      held.add(t.id);
      const since = Number(store.getMeta(META(t.id)) ?? 0);
      if (!since) { store.setMeta(META(t.id), String(now)); continue; }
      if (now - since < PRESSURE_AFTER_MS) continue;
      const procs = await this.topProcs(3);
      const why = slots.pressure === 'load' ? `העומס על השרת גבוה (${slots.load ?? '?'} למעבד)` : `נשאר זיכרון פנוי של ${(slots.availableMb / 1024).toFixed(1)}GB, פחות ממה שצריך להתחיל משימה`;
      const top = procs.length ? procs.map((p) => `- ${(p.rssMb / 1024).toFixed(1)}GB · pid ${p.pid} · ${p.cmd}`).join('\n') : 'לא הצלחתי לקרוא את רשימת התהליכים';
      inbox.add({ kind: 'incident', urgency: 'urgent', from_identity: this.owner(), dedupe_key: `pressure-${t.id}-${since}`,
        title: `משימה דחופה (${t.ref ?? `#${t.id}`}) מחכה ${Math.round((now - since) / 60_000)} דקות כי השרת עמוס`,
        body: `${t.title}\n\n${why}.\n\nהתהליכים שתופסים הכי הרבה זיכרון:\n${top}` });
      store.emit('pressure.alert', null, { task: t.id, processes: procs });
    }
    // A task that started (or is no longer held back) forgets its clock: the 10 minutes are in a row.
    this.forget(held);
  }

  private forget(held: Set<number>): void {
    const { db } = this.hq.store;
    for (const r of db.prepare(`SELECT key FROM meta WHERE key LIKE 'pressure_watch.%'`).all() as { key: string }[]) {
      if (!held.has(Number(r.key.slice('pressure_watch.'.length)))) db.prepare(`DELETE FROM meta WHERE key = ?`).run(r.key);
    }
  }
}
