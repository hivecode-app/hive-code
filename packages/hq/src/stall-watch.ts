// A project that stands still with work open (#153). On 21/10 voice-bot ran out of credits; he bought more at 11:37,
// and by 11:51 nobody had gone back to the work: the lead ended its turn, the worker went to rest, and open-*.md still
// listed open items. Nothing noticed; he did. Now, every minute, for each active project that is not paused:
//   standing  — no task of it in the queue or running, nobody of it in a turn, no message waiting for one of them,
//               and so for STALL_AFTER_MS
//   open work — items in memory/projects/<p>/open-*.md, or an answer of his to the project in the last ANSWERED_MS
//   quiet     — the project already said what it waits for: an ask or a GO of it still waits for him, or its lead wrote
//               it (`status` blocked/waiting with a note) after the last news (his answer or message, a task that started or ended)
// standing + open work + not quiet → one system message to the lead. If ESCALATE_AFTER_MS later nothing restarted
// and the lead wrote nothing, the same goes to the manager. The automation is `stall-watch` in org.yaml.
import { OWNER, loadNames } from '@company/shared';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hq } from './hq.ts';
import { projectLead } from './org.ts';
import { hhmm } from './timezone.ts';
import { readCharter } from './workspace.ts';

export const AUTOMATION = 'stall-watch';
/** Standing this long before it counts: a lead between two turns, or a task about to be opened, is not a stall. */
export const STALL_AFTER_MS = 5 * 60_000;
/** An answer of his this recent is open work by itself (the credits he bought). */
export const ANSWERED_MS = 10 * 60_000;
/** After the lead heard and did nothing: the manager hears. */
export const ESCALATE_AFTER_MS = 10 * 60_000;
/** One project is not told more often than this, whatever happened in between. */
export const ALERT_GAP_MS = 30 * 60_000;
const ITEMS_SHOWN = 3;
const ITEM_MAX = 140;

/** Sections of an open-*.md that hold what is no longer open. */
const CLOSED_HEADING = /ישן|נסגר|סגור|בוצע|הושלם|ארכיון|done|closed|archive/i;

/** The open items in one open-*.md: top-level list items, outside sections of closed things. */
export function openItems(text: string): string[] {
  const out: string[] = [];
  let closed = false;
  for (const line of text.split('\n')) {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { closed = CLOSED_HEADING.test(h[1]!); continue; }
    const m = /^ {0,1}(?:[-*+]|\d+[.)])\s+(.*\S)/.exec(line);
    if (!m || closed) continue;
    const item = m[1]!.replace(/\*\*|__|`/g, '').trim();
    if (item && !/^(אין|כלום|ריק)\.?$/.test(item)) out.push(item);
  }
  return out;
}

/** Reads the project's open-*.md files: [{file, text}]. Injected in tests. */
export type OpenFilesReader = (project: string) => Promise<{ file: string; text: string }[]>;

interface State { idle_since: number | null; alerted_at: number | null; alert_id: string | null; last_alert_at: number | null; escalated_at: number | null }
const EMPTY: State = { idle_since: null, alerted_at: null, alert_id: null, last_alert_at: null, escalated_at: null };
const META = (p: string) => `stall_watch.${p}`;

export class StallWatch {
  private hq: Hq;
  readFiles: OpenFilesReader;
  constructor(hq: Hq, readFiles?: OpenFilesReader) {
    this.hq = hq;
    this.readFiles = readFiles ?? ((p) => this.openFiles(p));
  }

  private get db() { return this.hq.store.db; }
  private get now() { return this.hq.store.now(); }

  /** The identity whose org.yaml automations hold `stall-watch`; null = no such automation. */
  owner(): string | null {
    const r = this.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean {
    const o = this.owner();
    return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`);
  }

  private state(p: string): State {
    try { return { ...EMPTY, ...(JSON.parse(this.hq.store.getMeta(META(p)) ?? '{}') as Partial<State>) }; } catch { return { ...EMPTY }; }
  }
  private save(p: string, s: State): void { this.hq.store.setMeta(META(p), JSON.stringify(s)); }

  /** Active projects that may be woken: not dormant, not paused (the charter's `paused`), with a lead. */
  watched(): { project: string; lead: string }[] {
    const out: { project: string; lead: string }[] = [];
    for (const p of this.hq.projects()) {
      if (p.status !== 'active') continue;
      const ch = readCharter(this.hq.cfg.companyDir, p.id);
      if (!ch || ch.status !== 'active' || ch.paused) continue;
      const lead = projectLead(this.hq.store, p.id);
      if (lead) out.push({ project: p.id, lead });
    }
    return out;
  }

  async sweep(): Promise<void> {
    if (!this.enabled()) return;
    for (const { project, lead } of this.watched()) {
      try { await this.check(project, lead); } catch (e) {
        this.hq.store.emit('stall.error', lead, { project, error: (e as Error).message });
      }
    }
  }

  /** Its standing people (lead, members) and the workers of its tasks still open. A closed task's worker is not the
   *  project any more: a message that waits for it forever (its task closed first) must not read as work moving. */
  private members(project: string): string[] {
    return (this.db.prepare(`SELECT id FROM identities i WHERE project = ? AND active = 1 AND (team_kind != 'task'
      OR EXISTS (SELECT 1 FROM tasks t WHERE t.identity = i.id AND t.state NOT IN ('done','closed')))`).all(project) as { id: string }[]).map((r) => r.id);
  }

  /** Something moves: a task queued or on, someone in a turn or starting, a message on its way to one of them. */
  busy(project: string, ids = this.members(project)): boolean {
    if (this.db.prepare(`SELECT 1 FROM tasks WHERE project = ? AND state IN ('queued','open','interrupted','running','resting') LIMIT 1`).get(project)) return true;
    if (!ids.length) return false;
    const inIds = `(${ids.map(() => '?').join(',')})`;
    if (this.db.prepare(`SELECT 1 FROM shifts WHERE identity IN ${inIds} AND (state = 'starting' OR (state = 'live' AND in_turn = 1)) LIMIT 1`).get(...ids)) return true;
    return !!this.db.prepare(`SELECT 1 FROM messages WHERE to_identity IN ${inIds} AND state IN ('queued','delivered')
      AND NOT (state = 'queued' AND fyi = 1) LIMIT 1`).get(...ids);
  }

  /** The last news the project got: his answer or message to one of it, or a task of it starting or ending. */
  private lastNews(project: string, ids: string[]): number {
    const inIds = `(${ids.map(() => '?').join(',')})`;
    const msg = (this.db.prepare(`SELECT MAX(created_at) t FROM messages WHERE from_identity = ? AND to_identity IN ${inIds}`).get(OWNER, ...ids) as { t: number | null }).t ?? 0;
    const ask = (this.db.prepare(`SELECT MAX(answered_at) t FROM asks WHERE from_identity IN ${inIds} AND state = 'answered'`).get(...ids) as { t: number | null }).t ?? 0;
    const task = (this.db.prepare(`SELECT MAX(MAX(COALESCE(started_at, 0)), MAX(CASE WHEN state IN ('done','closed') THEN updated_at ELSE 0 END)) t
      FROM tasks WHERE project = ?`).get(project) as { t: number | null }).t ?? 0;
    return Math.max(msg, ask, task);
  }

  /** When the lead last wrote what the project waits for: `status` blocked/waiting with a note. A report to him ("bought
   *  the credits") is not that: on 21/10 it was the lead's last word before the project stood still. */
  private lastWaitNote(lead: string): number {
    return (this.db.prepare(`SELECT MAX(received_at) t FROM ops WHERE identity = ? AND op = 'status'
      AND json_extract(args, '$.state') IN ('blocked','waiting') AND TRIM(COALESCE(json_extract(args, '$.note'), '')) != ''`)
      .get(lead) as { t: number | null }).t ?? 0;
  }

  /** An ask or a GO of the project still waits for him: it waits, and he knows on what. */
  private waitsForOwner(ids: string[]): boolean {
    const inIds = `(${ids.map(() => '?').join(',')})`;
    return !!this.db.prepare(`SELECT 1 FROM asks WHERE from_identity IN ${inIds} AND state IN ('open','escalated') LIMIT 1`).get(...ids)
      || !!this.db.prepare(`SELECT 1 FROM inbox WHERE kind = 'go' AND state = 'open' AND from_identity IN ${inIds} LIMIT 1`).get(...ids);
  }

  /** What is open, one line each: his recent answers first, then the open-*.md items. */
  async openWork(project: string, ids: string[]): Promise<string[]> {
    const tz = this.hq.timeZone();
    const owner = loadNames(this.hq.cfg.companyDir, this.hq.cfg.managerId).owner.name;
    const out: string[] = [];
    const inIds = `(${ids.map(() => '?').join(',')})`;
    const since = this.now - ANSWERED_MS;
    const asks = this.db.prepare(`SELECT question, answered_at FROM asks WHERE from_identity IN ${inIds} AND state = 'answered' AND answered_at >= ?
      ORDER BY answered_at DESC`).all(...ids, since) as { question: string; answered_at: number }[];
    for (const a of asks) out.push(`${owner} ענה ב-${hhmm(a.answered_at, tz)} על "${clip(a.question, 80)}"`);
    if (!asks.length) {
      const m = this.db.prepare(`SELECT to_identity, created_at FROM messages WHERE from_identity = ? AND to_identity IN ${inIds} AND kind = 'tell'
        AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(OWNER, ...ids, since) as { to_identity: string; created_at: number } | undefined;
      if (m) out.push(`${owner} כתב ל-\`${m.to_identity}\` ב-${hhmm(m.created_at, tz)}`);
    }
    for (const f of await this.readFiles(project)) {
      const items = openItems(f.text);
      if (!items.length) continue;
      const name = f.file.split('/').pop()!;
      const shown = items.slice(0, ITEMS_SHOWN).map((i) => clip(i, ITEM_MAX)).join('; ');
      out.push(`ב-\`${name}\` ${items.length === 1 ? 'פריט פתוח אחד' : `${items.length} פריטים פתוחים`}: ${shown}${items.length > ITEMS_SHOWN ? '…' : ''}`);
    }
    return out;
  }

  private async check(project: string, lead: string): Promise<void> {
    const now = this.now;
    const ids = this.members(project);
    let s = this.state(project);
    const busy = this.busy(project, ids);

    if (s.alerted_at != null) {
      // The lead heard. A note, or a message to him, since: it said what it waits for, done.
      if (this.lastWaitNote(lead) >= s.alerted_at || this.waitsForOwner(ids)) {
        this.save(project, { ...s, idle_since: busy ? null : now, alerted_at: null, alert_id: null });
        this.hq.store.emit('stall.answered', lead, { project });
        return;
      }
      // Work restarted: a task, someone other than the lead took a turn, or the lead handed work on.
      if (this.restartedSince(project, lead, ids, s.alerted_at)) {
        this.save(project, { ...s, idle_since: busy ? null : now, alerted_at: null, alert_id: null });
        this.hq.store.emit('stall.restarted', lead, { project });
        return;
      }
      // Its own turn on the message is not a restart; still standing ESCALATE_AFTER_MS later goes up.
      if (busy || now - s.alerted_at < ESCALATE_AFTER_MS) return;
      // Nothing open any more (the lead cleared its open-*.md): nothing to raise.
      if (!(await this.openWork(project, ids)).length) {
        this.save(project, { ...s, idle_since: now, alerted_at: null, alert_id: null });
        return;
      }
      this.escalate(project, lead, s, now);
      return;
    }

    if (busy) {
      if (s.idle_since != null) this.save(project, { ...s, idle_since: null });
      return;
    }
    if (s.idle_since == null) { this.save(project, { ...s, idle_since: now }); return; }
    if (now - s.idle_since < STALL_AFTER_MS) return;
    if (s.last_alert_at != null && now - s.last_alert_at < ALERT_GAP_MS) return;
    // Said already: its wait note (or the escalation) is newer than the last news it got.
    const news = this.lastNews(project, ids);
    if (Math.max(this.lastWaitNote(lead), s.escalated_at ?? 0) >= news || this.waitsForOwner(ids)) return;
    const work = await this.openWork(project, ids);
    if (!work.length) return;
    if (this.busy(project, ids)) return; // the read took a moment; someone may have started
    const id = `stall-${project}-${now}`;
    this.hq.mailbox.tell({ msg_id: id, from: 'hq', to: lead, kind: 'system', priority: 'next',
      body: `הפרויקט \`${project}\` עומד ויש עבודה פתוחה: ${work.join(' · ')}. `
        + 'תפעיל מחדש או תכתוב למה מחכים: `status` עם `state: "blocked"` ו-`note` (על מה ועל מי מחכים). '
        + `אם תוך ${ESCALATE_AFTER_MS / 60_000} דקות שום דבר לא זז ולא נכתב למה, ההודעה עוברת ל-\`${this.hq.cfg.managerId}\`.` });
    s = { ...s, alerted_at: now, alert_id: id, last_alert_at: now, escalated_at: null };
    this.save(project, s);
    this.hq.store.emit('stall.alert', lead, { project, msg: id, work });
  }

  /** After `t`: a task of the project started or was opened, one of it other than the lead took a turn, or the lead
   *  handed work on (a message to one of the company, a team, a question, a GO). Its turn alone, reading the message, is
   *  not a restart, nor is a report to him. */
  private restartedSince(project: string, lead: string, ids: string[], t: number): boolean {
    if (this.db.prepare(`SELECT 1 FROM tasks WHERE project = ? AND (created_at > ? OR started_at > ?) LIMIT 1`).get(project, t, t)) return true;
    if (this.db.prepare(`SELECT 1 FROM ops WHERE identity = ? AND received_at > ? AND (op IN ('open_team','ask','request_go')
      OR (op = 'tell' AND COALESCE(json_extract(args, '$.to'), '') != ?)) LIMIT 1`).get(lead, t, OWNER)) return true;
    const others = ids.filter((i) => i !== lead);
    if (!others.length) return false;
    const inIds = `(${others.map(() => '?').join(',')})`;
    return !!this.db.prepare(`SELECT 1 FROM shifts WHERE identity IN ${inIds} AND COALESCE(last_event_at, started_at) > ? LIMIT 1`).get(...others, t);
  }

  private escalate(project: string, lead: string, s: State, now: number): void {
    const to = this.hq.cfg.managerId;
    const tz = this.hq.timeZone();
    const orig = s.alert_id ? this.hq.mailbox.get(s.alert_id) : undefined;
    const what = orig?.body.replace(/^הפרויקט `[^`]+` עומד ויש עבודה פתוחה: /, '').replace(/\. תפעיל מחדש[\s\S]*$/, '') ?? '';
    this.hq.mailbox.tell({ msg_id: `${s.alert_id ?? `stall-${project}`}-up`, from: 'hq', to, kind: 'system', priority: 'next',
      body: `הפרויקט \`${project}\` עומד ויש עבודה פתוחה${what ? `: ${what}` : ''}. `
        + `כתבתי ל-\`${lead}\` ב-${hhmm(s.alerted_at!, tz)}, ומאז שום דבר לא זז והוא לא כתב למה מחכים. תפעיל מחדש או תברר מה קרה.` });
    this.save(project, { ...s, alerted_at: null, alert_id: null, escalated_at: now, idle_since: now });
    this.hq.store.emit('stall.escalate', lead, { project, to });
  }

  /** The project's open-*.md as they are on main with the registry writes still waiting, and on disk for what git lacks. */
  private async openFiles(project: string): Promise<{ file: string; text: string }[]> {
    const dir = `memory/projects/${project}`;
    const repo = this.hq.cfg.companyHome;
    const mf = this.hq.memoryFiles;
    const names = new Set<string>();
    const listed = await mf.run('git', ['ls-tree', '--name-only', 'origin/main', `${dir}/`], repo).catch(() => '');
    for (const f of listed.split('\n')) if (/\/open-[^/]+\.md$/.test(f.trim())) names.add(f.trim());
    const local = join(repo, dir);
    if (existsSync(local)) for (const f of readdirSync(local)) if (/^open-.+\.md$/.test(f)) names.add(`${dir}/${f}`);
    for (const o of mf.registry.pending()) if (o.file.startsWith(`${dir}/open-`)) names.add(o.file);
    const out: { file: string; text: string }[] = [];
    for (const file of [...names].sort()) {
      let text = await mf.registry.current(file).catch(() => null);
      if (text == null) { try { text = readFileSync(join(repo, file), 'utf8'); } catch { text = null; } }
      if (text) out.push({ file, text });
    }
    return out;
  }
}

function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
