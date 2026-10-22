// The one new alert of resources stage 3 (resources-design.md §2): a consumer that no project owns ("לא מזוהה") and that holds
// a lot of memory for more than an hour. On 22/10 a Gradle daemon nobody knew held 7GB for 3 hours. A p0 that cannot start is
// already `pressure-watch`; this one is the same thing before anyone waits. One item in "מחכה לך" per consumer and per incident.
// The automation is `unidentified-watch` in org.yaml; without it, or switched off, nothing is kept and nothing is sent.
import type { Hq } from './hq.ts';

export const AUTOMATION = 'unidentified-watch';
export const UNIDENTIFIED_MB = 2048;
export const UNIDENTIFIED_AFTER_MS = 60 * 60_000;
const PREFIX = 'unidentified_watch.';

export class UnidentifiedWatch {
  private hq: Hq;
  constructor(hq: Hq) { this.hq = hq; }

  /** The identity whose org.yaml automations hold `unidentified-watch`; null = no such automation. */
  owner(): string | null {
    const r = this.hq.store.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean {
    const o = this.owner();
    return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`);
  }

  sweep(): void {
    const { store, inbox } = this.hq;
    // Off: no clocks kept, so turning it on never alerts on a hold that began before.
    if (!this.enabled()) return this.forget(new Set());
    const now = store.now();
    const gb = (mb: number) => `${(mb / 1024).toFixed(1)}GB`;
    const seen = new Set<string>();
    for (const m of this.hq.resources.view().machines) {
      // A machine that was not read now: what it holds is unknown, so no hour is counted through it.
      if (!m.measured) continue;
      for (const u of m.unidentified) {
        if (u.mem_mb < UNIDENTIFIED_MB) continue;
        const key = `${PREFIX}${m.name}\0${u.name}`;
        const sent = `${key}\0sent`;
        seen.add(key).add(sent);
        const since = Number(store.getMeta(key) ?? 0);
        if (!since) { store.setMeta(key, String(now)); continue; }
        if (now - since < UNIDENTIFIED_AFTER_MS || store.getMeta(sent) === String(since)) continue;
        store.setMeta(sent, String(since));
        inbox.add({ kind: 'incident', urgency: 'urgent', from_identity: this.owner(), dedupe_key: `unidentified-${m.name}-${u.name}-${since}`,
          title: `צרכן לא מזוהה מחזיק ${gb(u.mem_mb)} זיכרון כבר ${Math.round((now - since) / 60_000)} דקות ב-${m.label}`,
          body: `${u.name}\n\nאף פרויקט לא רשום כבעלים שלו, ולכן אף אחד לא יודע מי ישחרר אותו. אם הוא של פרויקט, מוסיפים אותו ל-\`resources.map\` ב-hq.config.json; אם נשאר אחרי build, עוצרים אותו.` });
        store.emit('unidentified.alert', null, { machine: m.name, name: u.name, mem_mb: u.mem_mb, since });
      }
    }
    this.forget(seen);
  }

  private forget(keep: Set<string>): void {
    const { db } = this.hq.store;
    for (const r of db.prepare(`SELECT key FROM meta WHERE key LIKE ?`).all(`${PREFIX}%`) as { key: string }[]) {
      if (!keep.has(r.key)) db.prepare(`DELETE FROM meta WHERE key = ?`).run(r.key);
    }
  }
}
