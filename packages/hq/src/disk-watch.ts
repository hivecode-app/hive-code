// A disk that fills up under the company (task 382). On 22/10 at 18:40 the disk of hq-host hit 100% with 273MB left,
// which killed the worktree of task 347: docker had piled up 55GB of images and 43GB of build cache, and /tmp another 7GB.
// Now, every 5 minutes, hq reads how full the disk is, here and on each node:
//   85% → scripts/disk-clean.mjs runs at once (at most once in 30 minutes per machine; the daily timer runs the same script);
//   92% (after that cleaning) → one urgent item for him, with the five biggest consumers.
// Task 1531: on 07/11 the 92% item sat in his inbox for 13 hours while the disk went to 100%, and the cleaning freed 0:
// what had grown (worktrees workers opened in lumo, hourly backups of a 2.6GB hq.db, copies of hq.db in /tmp) was
// outside it, and the consumers list did not even show the lumo worktrees (~/new-lumo-application is not under
// ~/projects). The monitoring probe at 80% had told רותם once, on 01/11, and stayed open since. Now, here (not on a
// node): at 85% the leftovers of tasks go too (leftovers-gc.ts) and the backups are pruned to their policy; the
// consumers list has every charter's worktree_dir, the backups and hq.db; and at 92%, and again at 97%, the
// automation's owner gets a `now` message too, so a worker acts and not only an inbox item waits for him.
// The automation is `disk-watch` in org.yaml; off, nothing is read and nothing is deleted.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hq } from './hq.ts';
import { q } from './nodes.ts';
import { pruneBackups } from './backup.ts';
import { readCharter } from './workspace.ts';

export const AUTOMATION = 'disk-watch';
export const CLEAN_AT = 85;
export const ALERT_AT = 92;
/** A second, separate alert the same day: 92% that kept growing. */
export const CRITICAL_AT = 97;
export const CLEAN_EVERY_MS = 30 * 60_000;
const KEEP_AFTER_CLOSE_MS = 24 * 3600_000;
const SCRIPT = fileURLToPath(new URL('../../../scripts/disk-clean.mjs', import.meta.url));

export interface Usage { pct: number; freeMb: number }
export interface Consumer { name: string; bytes: number }
export interface CleanResult { freed: number; steps: { name: string; freed: number; note: string }[] }

/** One machine: its disk, its cleaning, and who holds the space. `local` is this one; a node's go over ssh. */
export interface Machine {
  name: string;
  usage(): Promise<Usage>;
  clean(closedTasks: number[]): Promise<CleanResult>;
  consumers(): Promise<Consumer[]>;
}

// Home, /tmp and the worktrees are under the user the shell runs as; docker has its own count (its dir is root's).
const CONSUMERS_CMD = `du -sk --one-file-system /tmp "$HOME/.local/state" "$HOME"/projects/*/.worktrees "$HOME/.npm" "$HOME/.cache" 2>/dev/null; ` +
  `docker system df --format '{{.Type}}\t{{.Size}}' 2>/dev/null | sed 's/^/docker\t/'`;

export function parseBytes(text: string): number {
  const m = /([\d.]+)\s*([kKMGT]?)i?B\b/.exec(text);
  if (!m) return 0;
  const pow: Record<string, number> = { '': 0, k: 1, K: 1, M: 2, G: 3, T: 4 };
  return Math.round(Number(m[1]) * 1024 ** pow[m[2]!]!);
}

/** The output of CONSUMERS_CMD → biggest first. Docker volumes are listed (they are space) but the cleaning never touches them. */
export function parseConsumers(out: string): Consumer[] {
  const rows: Consumer[] = [];
  for (const line of out.split('\n')) {
    const p = line.split('\t');
    if (p[0] === 'docker' && p[1] && p[2]) rows.push({ name: `docker ${p[1].toLowerCase()}`, bytes: parseBytes(p[2]) });
    else if (p.length === 2 && /^\d+$/.test(p[0]!)) rows.push({ name: p[1]!, bytes: Number(p[0]) * 1024 });
  }
  return rows.filter((r) => r.bytes > 0).sort((a, b) => b.bytes - a.bytes);
}

export const human = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)}GB` : `${Math.round(b / 1024 ** 2)}MB`);

function sh(cmd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (e, out) => (e ? rej(e) : res(String(out)))));
}

/** Paths whose size is worth showing on this machine beyond CONSUMERS_CMD: every charter's worktree_dir, the backups and hq.db. */
export function localPaths(companyDir: string, stateDir: string): string[] {
  const out = new Set<string>([join(stateDir, 'backups'), join(stateDir, 'hq.db'), join(stateDir, 'db-copies')]);
  const dir = join(companyDir, 'projects');
  for (const f of existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith('.md')) : []) {
    const ch = readCharter(companyDir, f.slice(0, -3));
    for (const c of ch?.checkouts ?? []) out.add(join(c.path, ch!.worktreeDir));
  }
  return [...out].filter((p) => existsSync(p));
}

/** CONSUMERS_CMD with `paths` measured too (each one quoted). */
export const consumersCmd = (paths: string[] = []) => paths.length
  ? CONSUMERS_CMD.replace('"$HOME/.cache"', `"$HOME/.cache" ${paths.map(q).join(' ')}`)
  : CONSUMERS_CMD;

export function localMachine(path: string, extra: () => string[] = () => []): Machine {
  return {
    name: 'local',
    async usage() {
      const s = statfsSync(path);
      return { pct: Math.round(((s.blocks - s.bavail) / s.blocks) * 100), freeMb: Math.round((s.bavail * s.bsize) / 1024 ** 2) };
    },
    async clean(closed) {
      return JSON.parse((await sh(process.execPath, [SCRIPT, '--json', '--closed-tasks', closed.join(',')], 35 * 60_000)).trim().split('\n').pop()!);
    },
    async consumers() {
      // du of a path inside another one counts it twice: the list is "who is big", not a sum.
      const rows = parseConsumers(await sh('bash', ['-c', consumersCmd(extra())], 3 * 60_000).catch(() => ''));
      return rows.filter((r, i) => rows.findIndex((x) => x.name === r.name) === i);
    },
  };
}

type Exec = (cmd: string, input?: string, timeoutMs?: number) => Promise<string>;
/** A node mirrors this machine's $HOME and checkouts (nodes.ts), so the same script is at the same path there. */
export function remoteMachine(name: string, exec: Exec): Machine {
  return {
    name,
    async usage() {
      const [pct, avail] = (await exec(`df --output=pcent,avail -BM / | tail -1`, undefined, 30_000)).trim().split(/\s+/);
      return { pct: parseInt(pct ?? '0', 10), freeMb: parseInt(avail ?? '0', 10) };
    },
    async clean(closed) {
      const out = await exec(`node ${q(SCRIPT)} --json --closed-tasks ${q(closed.join(','))}`, undefined, 35 * 60_000);
      return JSON.parse(out.trim().split('\n').pop()!);
    },
    async consumers() { return parseConsumers(await exec(CONSUMERS_CMD, undefined, 3 * 60_000).catch(() => '')); },
  };
}

export class DiskWatch {
  private hq: Hq;
  /** Replaced in tests. */
  machines: () => Machine[];
  constructor(hq: Hq, machines?: () => Machine[]) {
    this.hq = hq;
    this.machines = machines ?? (() => [
      localMachine(hq.cfg.stateDir, () => localPaths(hq.cfg.companyDir, hq.cfg.stateDir)),
      ...hq.nodes.list.map((n) => remoteMachine(n.def.name, (c, i, t) => n.exec(c, i, t))),
    ]);
  }

  /** The identity whose org.yaml automations hold `disk-watch`; null = no such automation. */
  owner(): string | null {
    const r = this.hq.store.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean {
    const o = this.owner();
    return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`);
  }

  /** Tasks known to be done for more than 24 hours: only their /tmp may go. */
  closedTasks(): number[] {
    const { db } = this.hq.store;
    return (db.prepare(`SELECT id FROM tasks WHERE state = 'done' AND updated_at <= ?`).all(this.hq.store.now() - KEEP_AFTER_CLOSE_MS) as { id: number }[]).map((r) => r.id);
  }

  async sweep(): Promise<void> {
    if (!this.enabled()) return;
    await Promise.all(this.machines().map((m) => this.check(m).catch(() => { /* an unreachable node is the nodes poll's to report */ })));
  }

  private async check(m: Machine): Promise<void> {
    const { store, inbox } = this.hq;
    let u = await m.usage();
    if (u.pct < CLEAN_AT) return;
    let cleaned: 'ok' | 'failed' | 'not-now' = 'not-now';
    const lastKey = `disk_watch.clean.${m.name}`;
    const now = store.now();
    if (now - Number(store.getMeta(lastKey) ?? 0) >= CLEAN_EVERY_MS) {
      store.setMeta(lastKey, String(now));
      try {
        if (m.name === 'local') await this.cleanCompany();
        const r = await m.clean(this.closedTasks());
        cleaned = 'ok';
        store.emit('disk.cleaned', null, { machine: m.name, before: u.pct, freed: r.freed, steps: r.steps });
      } catch (e) {
        cleaned = 'failed';
        store.emit('disk.clean_failed', null, { machine: m.name, error: (e as Error).message.slice(0, 300) });
      }
      u = await m.usage();
    }
    if (u.pct < ALERT_AT) return;
    const where = m.name === 'local' ? 'hq-host' : m.name;
    const critical = u.pct >= CRITICAL_AT;
    const key = `disk-${m.name}-${new Date(now).toISOString().slice(0, 10)}${critical ? '-critical' : ''}`;
    if (store.db.prepare(`SELECT 1 FROM inbox WHERE dedupe_key = ?`).get(key)) return; // today's item exists: no heavy du again
    const top = (await m.consumers()).slice(0, 5);
    const ran = { ok: 'הניקוי האוטומטי רץ ולא הספיק.', failed: 'הניקוי האוטומטי נכשל (הפירוט באירוע `disk.clean_failed`).', 'not-now': 'הניקוי האוטומטי רץ לפני פחות מחצי שעה ולא הספיק.' }[cleaned];
    inbox.add({ kind: 'incident', urgency: 'urgent', from_identity: this.owner(), dedupe_key: key,
      title: `הדיסק של ${where} מלא ${u.pct}%, נשארו ${human(u.freeMb * 1024 ** 2)}`,
      body: `${ran}\n\nמה שתופס הכי הרבה:\n${top.length ? top.map((c) => `- ${human(c.bytes)} · ${c.name}`).join('\n') : 'לא הצלחתי למדוד'}\n\nב-100% נופלות עבודות באמצע (כך נעצרה משימה באמצע ב-22/10).` });
    const owner = this.owner();
    if (owner) this.hq.mailbox.tell({ msg_id: `${key}-${now}`, from: 'hq', to: owner, urgency: 'urgent', priority: 'now', body: [
      `הדיסק של ${where} ב-${u.pct}%, נשארו ${human(u.freeMb * 1024 ** 2)}. ${ran} צריך לפנות מקום עכשיו, או לפתוח משימה שמפנה (p0): ב-100% נופלות משימות באמצע.`,
      `מה שתופס הכי הרבה:\n${top.length ? top.map((c) => `- ${human(c.bytes)} · ${c.name}`).join('\n') : 'לא הצלחתי למדוד'}`,
      critical ? '' : `אם הוא ימשיך לעלות, הודעה נוספת תגיע ב-${CRITICAL_AT}%.`,
    ].filter(Boolean).join('\n\n') });
  }

  /** This machine's own leftovers before the generic cleaning: tasks' (leftovers-gc.ts, if on) and the backups' policy. */
  private async cleanCompany(): Promise<void> {
    const { hq } = this;
    await hq.leftovers.sweep().catch((e) => hq.store.emit('disk.clean_failed', null, { machine: 'local', step: 'leftovers', error: (e as Error).message.slice(0, 300) }));
    const dir = join(hq.cfg.stateDir, 'backups');
    if (existsSync(dir)) await pruneBackups(dir, hq.cfg.backups).catch((e) => hq.store.emit('disk.clean_failed', null, { machine: 'local', step: 'backups', error: (e as Error).message.slice(0, 300) }));
  }
}
