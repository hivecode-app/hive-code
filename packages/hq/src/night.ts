// Night mode (B.16, company/modes/night.md). The owner writes "לילה" and that is enough:
//  - the queue is built in code (scheduler.ts QUEUE_SQL) and, with `<manager>/night-scheduler` on, GitHub
//    issues of every active project are pulled into it (company:night first, then anything without needs-decision);
//  - every free slot is filled at once (the scheduler) with no quota gate (dir-0003);
//  - every interval in which a slot sat empty while the queue was not is recorded with its reason;
//  - the night ends at the hour he set, or with his first message in the morning, and with
//    `<manager>/morning-summary` on, one summary computed from the store goes to the manager.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { OWNER } from '@company/shared';
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Scheduler, TaskRow } from './scheduler.ts';
import type { Mailbox, MessageRow } from './mailbox.ts';
import type { Inbox } from './inbox.ts';

export interface Issue { number: number; title: string; body: string; labels: string[]; createdAt: string }
/** Open issues of a repo. Injected in tests; default is the gh CLI. */
export type IssueSource = (repo: string) => Promise<Issue[]>;

export const ghIssues: IssueSource = (repo) => new Promise((resolve, reject) => {
  execFile('gh', ['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '200', '--json', 'number,title,body,labels,createdAt'],
    { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (err, out, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 300)));
      const rows = JSON.parse(out) as { number: number; title: string; body: string; labels: { name: string }[]; createdAt: string }[];
      resolve(rows.map((r) => ({ ...r, labels: r.labels.map((l) => l.name) })));
    });
});

export interface Charter { project: string; status: string; repo: string | null; night_weight: number }

/** Frontmatter of company/projects/*.md: status, repo, night_weight. */
export function loadCharters(companyDir: string): Charter[] {
  const dir = join(companyDir, 'projects');
  if (!existsSync(dir)) return [];
  const out: Charter[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
    const m = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(dir, f), 'utf8'));
    if (!m) continue;
    let fm: Record<string, unknown>;
    try { fm = (parse(m[1]!) ?? {}) as Record<string, unknown>; } catch { continue; }
    out.push({ project: typeof fm.project === 'string' ? fm.project : basename(f, '.md'), status: String(fm.status ?? 'dormant'),
      repo: typeof fm.repo === 'string' ? fm.repo : null, night_weight: Number(fm.night_weight ?? 1) || 1 });
  }
  return out;
}

/** `p0`..`p3` (also `priority:p1`, `P1`) → 0..3. No label → 2. */
export function priorityOf(labels: string[]): number {
  for (const l of labels) {
    const m = /^(?:priority[:/ -]?)?p([0-3])$/i.exec(l.trim());
    if (m) return Number(m[1]);
  }
  return 2;
}

export interface NightTrigger { scope: string[] | null; note: string | null; until: number | null }

/** Offset of `tz` from UTC at `ts`, in ms (DST-aware, through Intl). */
function tzOffsetMs(ts: number, tz: string): number {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(ts).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!) - Math.floor(ts / 1000) * 1000;
}

/** The next time it is HH:MM in `tz`, after `now`. */
export function nextLocal(now: number, h: number, m: number, tz: string): number {
  const off = tzOffsetMs(now, tz);
  const l = new Date(now + off);
  let t = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate(), h, m) - off;
  if (t <= now) t += 86_400_000;
  return t;
}

const PUNCT = /^[\s,.:;!-]+|[\s,.:;!-]+$/g;

/**
 * "לילה" alone, or with an addition: "לילה, רק לומו", "לילה בלי פריסות", "לילה עד 7".
 * `רק <p>[ ו<p>]` becomes the scope filter on the queue; `עד HH[:MM]` the end hour (in `tz`); the rest is a note to every task.
 * Not a trigger: anything that does not start with the word לילה ("לילה טוב" is a goodnight, not an order).
 */
export function parseNightTrigger(body: string, projects: string[], now: number, tz = 'Asia/Jerusalem'): NightTrigger | null {
  const m = /^לילה(?=$|[\s,.:;!-])[\s,.:;!-]*(.*)$/s.exec(body.trim());
  if (!m) return null;
  let rest = m[1]!.trim();
  if (/^(טוב|מנוחה|שקט)(\s|$|[,.!])/.test(rest)) return null;

  // "רק לומו, טיקי בלי פריסות": take the project names right after רק, stop at the first word that is not one.
  let scope: string[] | null = null;
  const alias = (n: string) => projects.find((p) => p === n || p.toLowerCase() === n.toLowerCase() || HEBREW_NAMES[n] === p);
  const toks = rest.split(/\s+/);
  const at = toks.findIndex((t) => t.replace(PUNCT, '') === 'רק');
  if (at >= 0) {
    const found: string[] = [];
    let j = at + 1;
    for (; j < toks.length; j++) {
      const word = toks[j]!.replace(PUNCT, '');
      if (word === 'ו' || word === '') continue;
      const p = alias(word) ?? alias(word.replace(/^ו-?/, ''));
      if (!p) break;
      found.push(p);
      if (/[.;:!]$/.test(toks[j]!)) { j++; break; }
    }
    if (found.length) { scope = [...new Set(found)]; toks.splice(at, j - at); rest = toks.join(' '); }
  }

  let until: number | null = null;
  const u = /(?:^|[\s,])עד\s+(?:השעה\s+)?(\d{1,2})(?::(\d{2}))?(?=$|[\s,.;!])/.exec(rest);
  if (u && Number(u[1]) < 24 && Number(u[2] ?? 0) < 60) {
    until = nextLocal(now, Number(u[1]), Number(u[2] ?? 0), tz);
    rest = rest.replace(u[0], ' ');
  }
  rest = rest.replace(/\s+/g, ' ').replace(PUNCT, '');
  return { scope, note: rest || null, until };
}

/** How he says the project names in Hebrew. */
const HEBREW_NAMES: Record<string, string> = { 'לומו': 'lumo', 'טיקי': 'tiki-bot-go', 'טיקי-בוט': 'tiki-bot-go', 'קול': 'voice-bot', 'החברה': 'agent-company' };

export interface NightRow {
  id: number; started_at: number; ended_at: number | null; until_at: number | null; scope: string | null; note: string | null;
  started_by: string | null; end_reason: string | null; summary: string | null;
}

export interface NightSummary {
  night: number; started_at: number; ended_at: number; minutes: number;
  done: { project: string; tasks: { id: number; ref: string | null; title: string; note: string | null }[] }[];
  waiting: { id: number; kind: string; title: string; from: string | null; blocking: boolean }[];
  skipped: { id: number; ref: string | null; title: string; why: string }[];
  empty: { minutes: number; pct: number; reasons: { reason: string; minutes: number }[] };
  text: string;
}

export class Night {
  issues: IssueSource;
  /** How often GitHub is re-read during the night (new issues, labels changed by the CEOs). */
  refreshMs = 10 * 60_000;
  private lastRefreshAt = 0;
  private refreshing: Promise<void> | null = null;

  private store: Store;
  private cfg: HqConfig;
  private scheduler: Scheduler;
  private mailbox: Mailbox;
  private inbox: Inbox;
  constructor(store: Store, cfg: HqConfig, scheduler: Scheduler, mailbox: Mailbox, inbox: Inbox, issues: IssueSource = ghIssues) {
    this.store = store;
    this.cfg = cfg;
    this.scheduler = scheduler;
    this.mailbox = mailbox;
    this.inbox = inbox;
    this.issues = issues;
    scheduler.scope = () => { const n = this.current(); return n?.scope ? (JSON.parse(n.scope) as string[]) : null; };
    scheduler.promptNote = () => { const n = this.current(); return n?.note ? `הנחיית לילה של רן: ${n.note}` : null; };
    scheduler.afterFill = () => this.observe();
    store.onEvent((e) => {
      if (e.type === 'message.new') this.onMessage(e.data as MessageRow);
      // The `night` switch on the board starts and ends the night too.
      if (e.type === 'toggle.changed') {
        const d = e.data as { key: string; enabled: boolean };
        if (d.key !== 'night') return;
        if (d.enabled && !this.current()) this.store.bg(this.start({ by: 'toggle' }), 'night.start');
        if (!d.enabled && this.current()) this.end('toggle');
      }
    });
  }

  get schedulerKey() { return `${this.cfg.managerId}/night-scheduler`; }
  get summaryKey() { return `${this.cfg.managerId}/morning-summary`; }

  current(): NightRow | undefined {
    return this.store.db.prepare('SELECT * FROM nights WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get() as NightRow | undefined;
  }

  get(id: number): NightRow | undefined {
    return this.store.db.prepare('SELECT * FROM nights WHERE id = ?').get(id) as NightRow | undefined;
  }

  last(): NightRow | undefined {
    return this.store.db.prepare('SELECT * FROM nights ORDER BY id DESC LIMIT 1').get() as NightRow | undefined;
  }

  private onMessage(m: MessageRow): void {
    if (m.from_identity !== OWNER || m.kind !== 'tell') return;
    const now = this.store.now();
    const trig = parseNightTrigger(m.body, loadCharters(this.cfg.companyDir).map((c) => c.project), now, this.cfg.timeZone);
    const cur = this.current();
    if (trig) {
      if (!cur) this.store.bg(this.start({ ...trig, by: m.to_identity }), 'night.start');
      return;
    }
    if (!cur) return;
    // "בוקר", "סוף לילה": ends it now, whatever the hour.
    if (/^(בוקר|סוף\s+ה?לילה)(?=$|[\s,.:;!])/.test(m.body.trim())) { this.end('owner-morning'); return; }
    // Default end (night.md): his first message *in the morning*. A note at 2am to a worker does not burn the night,
    // and a night with an hour set ends at that hour.
    if (cur.until_at == null && this.isMorning(cur, now)) this.end('owner-first-message');
  }

  /** Morning = a `morningFromHour` o'clock (his time zone) has passed since the night started, and at least an hour of night. */
  private isMorning(n: NightRow, now: number): boolean {
    return now - n.started_at >= 60 * 60_000 && nextLocal(n.started_at, this.cfg.morningFromHour, 0, this.cfg.timeZone) <= now;
  }

  /** Start the night. Idempotent: a running night is returned as is. */
  async start(o: { scope?: string[] | null; note?: string | null; until?: number | null; by?: string } = {}): Promise<NightRow> {
    const cur = this.current();
    if (cur) return cur;
    const now = this.store.now();
    const r = this.store.db.prepare('INSERT INTO nights (started_at, until_at, scope, note, started_by) VALUES (?, ?, ?, ?, ?)')
      .run(now, o.until ?? null, o.scope?.length ? JSON.stringify(o.scope) : null, o.note ?? null, o.by ?? null);
    // Last night's leftovers come back into the queue (bucket 2).
    this.store.db.prepare(`UPDATE tasks SET state = 'queued', updated_at = @now WHERE state = 'night_wait'
      AND (@scope IS NULL OR project IN (SELECT value FROM json_each(@scope)))`).run({ now, scope: o.scope?.length ? JSON.stringify(o.scope) : null });
    const night = this.get(Number(r.lastInsertRowid))!;
    if (!this.store.toggle('night')) this.store.setToggle('night', true, false);
    this.store.emit('night.started', null, night);
    this.lastRefreshAt = 0;
    await this.refresh();
    await this.scheduler.fill();
    this.observe();
    return night;
  }

  /** Pull open issues of every active project (in scope) into the queue. Errors are visible, never fatal. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const night = this.current();
    if (!night || !this.store.toggle(this.schedulerKey)) return;
    this.lastRefreshAt = this.store.now();
    const scope = night.scope ? (JSON.parse(night.scope) as string[]) : null;
    const charters = loadCharters(this.cfg.companyDir).filter((c) => c.status === 'active' && c.repo && (!scope || scope.includes(c.project)));
    this.refreshing = (async () => {
      for (const c of charters) {
        let issues: Issue[];
        try { issues = await this.issues(c.repo!); } catch (e) {
          this.store.emit('night.issues_failed', null, { project: c.project, repo: c.repo, error: (e as Error).message });
          continue;
        }
        // The night may have ended while gh was answering: never queue anything into the day.
        if (this.current()?.id !== night.id) return;
        this.importIssues(c, issues);
      }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private importIssues(c: Charter, issues: Issue[]): void {
    const db = this.store.db;
    const open = new Set<string>();
    for (const i of issues) {
      const ref = `${c.repo}#${i.number}`;
      open.add(ref);
      const ex = db.prepare('SELECT * FROM tasks WHERE ref = ?').get(ref) as TaskRow | undefined;
      if (ex) {
        // Labels are how the CEOs steer the queue during the day: keep them current.
        if (ex.state !== 'done') db.prepare('UPDATE tasks SET labels = ?, priority = ?, night_weight = ? WHERE id = ?')
          .run(JSON.stringify(i.labels), priorityOf(i.labels), c.night_weight, ex.id);
        if (ex.state === 'night_wait' || ex.state === 'closed') db.prepare(`UPDATE tasks SET state = 'queued', updated_at = ? WHERE id = ?`).run(this.store.now(), ex.id);
        continue;
      }
      const t = this.scheduler.addTask({ ref, project: c.project, title: i.title, body: [`${c.repo}#${i.number}`, i.body].filter(Boolean).join('\n\n'),
        source: 'github', labels: i.labels, priority: priorityOf(i.labels), night_weight: c.night_weight });
      // Age is the issue's, not the import's (night.md: "ואחר כך לפי ותק").
      const created = Date.parse(i.createdAt);
      if (Number.isFinite(created)) db.prepare('UPDATE tasks SET created_at = ? WHERE id = ?').run(created, t.id);
    }
    // Closed on GitHub while still waiting here: it leaves the queue.
    const waiting = db.prepare(`SELECT id, ref FROM tasks WHERE source = 'github' AND project = ? AND state IN ('queued','night_wait')`).all(c.project) as { id: number; ref: string }[];
    for (const w of waiting) if (!open.has(w.ref)) this.scheduler.setTaskState(w.id, 'closed');
  }

  /**
   * Called after every fill and every sweep. Opens an empty interval when a slot is free while the queue is
   * not, closes it when that stops (or the reason changes). Also remembers which tasks were in tonight's queue.
   */
  observe(): void {
    const night = this.current();
    if (!night) return;
    const now = this.store.now();
    const queue = this.scheduler.queue();
    const ins = this.store.db.prepare('INSERT OR IGNORE INTO night_tasks (night_id, task_id, first_seen_at) VALUES (?, ?, ?)');
    for (const t of queue) ins.run(night.id, t.id, now);
    const running = this.store.db.prepare(`SELECT id FROM tasks WHERE state IN ('running','resting')`).all() as { id: number }[];
    for (const t of running) ins.run(night.id, t.id, now);

    const slots = this.scheduler.slots();
    // A task whose start is under way (a long worktree_setup) is not waiting, and its slot is taken.
    const waiting = queue.filter((t) => !this.scheduler.isStarting(t.id));
    // A slot that exists but cannot start (not enough memory free right now) is empty too.
    const empty = waiting.length > 0 && (slots.total - slots.running > 0 || slots.total === 0);
    const reason = empty ? this.reason(waiting, slots) : null;
    const open = this.openInterval(night.id);
    if (open && open.reason !== reason) {
      this.store.db.prepare('UPDATE night_empty SET ended_at = ? WHERE id = ?').run(now, open.id);
    }
    if (reason && (!open || open.reason !== reason)) {
      this.store.db.prepare('INSERT INTO night_empty (night_id, started_at, reason) VALUES (?, ?, ?)').run(night.id, now, reason);
      this.store.emit('metric.empty_slot', null, { night: night.id, free: slots.free, total: slots.total, waiting: waiting.length, reason });
    }
  }

  private openInterval(nightId: number) {
    return this.store.db.prepare('SELECT id, reason FROM night_empty WHERE night_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(nightId) as { id: number; reason: string } | undefined;
  }

  private reason(queue: TaskRow[], slots: { total: number; free: number }): string {
    if (!this.store.toggle('scheduler')) return 'המתזמן כבוי';
    const accounts = this.store.db.prepare('SELECT health FROM accounts').all() as { health: string }[];
    if (accounts.length && accounts.every((a) => /block|limit|exhaust|expired/i.test(a.health))) return 'כל החשבונות חסומים';
    if (slots.total === 0 || slots.free <= 0) return 'אין זיכרון פנוי במחשב';
    if (queue.every((t) => this.scheduler.inBackoff(t.id))) {
      return this.scheduler.lastStartError ? `הפעלה נכשלה: ${this.scheduler.lastStartError.slice(0, 120)}` : 'ממתין לניסיון חוזר אחרי הפעלה שנכשלה';
    }
    return 'המשבצת לא התמלאה';
  }

  /** The scheduler's minute sweep: end at the set hour, re-read GitHub now and then, measure. */
  async sweep(): Promise<void> {
    const night = this.current();
    if (!night) return;
    if (night.until_at != null && this.store.now() >= night.until_at) { this.end('until'); return; }
    // In the background: `gh` may take a while, and blocking asks must not wait behind it at night.
    if (this.store.now() - this.lastRefreshAt >= this.refreshMs) this.store.bg(this.refresh().then(() => this.scheduler.fill()), 'night.refresh');
    this.observe();
  }

  /** End the night: close the measurement, carry what is left to the next night, write and send the summary. */
  end(reason: string): NightSummary | undefined {
    const night = this.current();
    if (!night) return undefined;
    const now = this.store.now();
    const db = this.store.db;
    db.prepare('UPDATE night_empty SET ended_at = ? WHERE night_id = ? AND ended_at IS NULL').run(now, night.id);
    db.prepare('UPDATE nights SET ended_at = ?, end_reason = ? WHERE id = ?').run(now, reason, night.id);
    db.transaction(() => {
      db.prepare(`UPDATE tasks SET carried_over = CASE WHEN state IN ('done','closed') THEN 0 ELSE 1 END
        WHERE id IN (SELECT task_id FROM night_tasks WHERE night_id = ?)`).run(night.id);
      // Issues pulled in for the night that never started wait for the next night: by day the queue is what the CEOs put in it.
      db.prepare(`UPDATE tasks SET state = 'night_wait', updated_at = ? WHERE source = 'github' AND state = 'queued'`).run(now);
    })();
    const summary = this.summary(night.id);
    db.prepare('UPDATE nights SET summary = ? WHERE id = ?').run(JSON.stringify(summary), night.id);
    if (this.store.toggle('night')) this.store.setToggle('night', false, false);
    this.store.emit('night.ended', null, { night: night.id, reason, empty_pct: summary.empty.pct });
    if (this.store.toggle(this.summaryKey)) {
      this.mailbox.tell({ msg_id: `night-summary-${night.id}`, from: 'hq', to: this.cfg.managerId, priority: 'next',
        body: `סיכום בוקר ללילה ${night.id}, מתוך ה-store. תעביר לרן כמו שהוא, אפשר לקצר:\n\n${summary.text}` });
    }
    return summary;
  }

  /** The morning summary, computed only from the store (night.md: "מתוך ה-store, לא מהזיכרון שלו"). */
  summary(nightId: number): NightSummary {
    const night = this.get(nightId);
    if (!night) throw new Error(`no night ${nightId}`);
    const db = this.store.db;
    const end = night.ended_at ?? this.store.now();
    const tasks = db.prepare(`SELECT t.* FROM tasks t JOIN night_tasks n ON n.task_id = t.id WHERE n.night_id = ? ORDER BY t.project, t.id`)
      .all(nightId) as TaskRow[];

    const doneIds = new Set((db.prepare(`SELECT DISTINCT json_extract(data, '$.id') id FROM events WHERE type = 'task.state'
      AND json_extract(data, '$.state') = 'done' AND ts >= ? AND ts <= ?`).all(night.started_at, end) as { id: number }[]).map((r) => r.id));
    const noteOf = (identity: string | null) => {
      if (!identity) return null;
      const r = db.prepare(`SELECT args FROM ops WHERE identity = ? AND op = 'status' ORDER BY received_at DESC LIMIT 1`).get(identity) as { args: string } | undefined;
      if (!r) return null;
      try { return (JSON.parse(r.args) as { note?: string }).note ?? null; } catch { return null; }
    };
    const byProject = new Map<string, NightSummary['done'][number]['tasks']>();
    for (const t of tasks) {
      if (t.state !== 'done' || !doneIds.has(t.id)) continue;
      const p = t.project ?? 'company';
      if (!byProject.has(p)) byProject.set(p, []);
      byProject.get(p)!.push({ id: t.id, ref: t.ref, title: t.title, note: noteOf(t.identity) });
    }
    const done = [...byProject].map(([project, ts]) => ({ project, tasks: ts }));

    const waiting = this.inbox.open().filter((i) => i.kind === 'go' || i.kind === 'ask' || i.kind === 'login' || i.kind === 'incident')
      .map((i) => ({ id: i.id, kind: i.kind, title: i.title, from: i.from_identity, blocking: i.blocking }));

    const failed = new Map<number, string>();
    for (const e of db.prepare(`SELECT data FROM events WHERE type = 'scheduler.start_failed' AND ts >= ? AND ts <= ? ORDER BY seq`)
      .all(night.started_at, end) as { data: string }[]) {
      const d = JSON.parse(e.data) as { task: number; error: string };
      failed.set(d.task, d.error);
    }
    const skipped: NightSummary['skipped'] = [];
    for (const t of tasks) {
      if (t.state === 'done' || t.state === 'closed') continue;
      const labels = JSON.parse(t.labels || '[]') as string[];
      const why = labels.includes('needs-decision') || t.state === 'needs_decision' ? 'מחכה להחלטה (needs-decision)'
        : failed.has(t.id) ? `ההפעלה נכשלה: ${failed.get(t.id)!.slice(0, 120)}`
        : t.state === 'running' ? 'עדיין רץ'
        : t.state === 'resting' ? 'מחכה לתשובה'
        : 'לא הגיע תורו';
      skipped.push({ id: t.id, ref: t.ref, title: t.title, why });
    }
    // Issues that were never queued at all: needs-decision ones in the active projects.
    const scope = night.scope ? (JSON.parse(night.scope) as string[]) : null;
    for (const t of db.prepare(`SELECT * FROM tasks WHERE state NOT IN ('done','closed')
      AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = 'needs-decision')`).all() as TaskRow[]) {
      if (skipped.some((s) => s.id === t.id) || (scope && !scope.includes(t.project ?? ''))) continue;
      skipped.push({ id: t.id, ref: t.ref, title: t.title, why: 'מחכה להחלטה (needs-decision)' });
    }

    const intervals = db.prepare('SELECT started_at, COALESCE(ended_at, ?) ended_at, reason FROM night_empty WHERE night_id = ?')
      .all(end, nightId) as { started_at: number; ended_at: number; reason: string }[];
    const reasons = new Map<string, number>();
    let emptyMs = 0;
    for (const i of intervals) { const d = Math.max(0, i.ended_at - i.started_at); emptyMs += d; reasons.set(i.reason, (reasons.get(i.reason) ?? 0) + d); }
    const nightMs = Math.max(1, end - night.started_at);
    const min = (ms: number) => Math.round(ms / 6_000) / 10;
    const empty = { minutes: min(emptyMs), pct: Math.round((emptyMs / nightMs) * 1000) / 10,
      reasons: [...reasons].sort((a, b) => b[1] - a[1]).map(([reason, ms]) => ({ reason, minutes: min(ms) })) };

    const out: Omit<NightSummary, 'text'> = { night: nightId, started_at: night.started_at, ended_at: end, minutes: min(end - night.started_at),
      done, waiting, skipped, empty };
    return { ...out, text: summaryText(out, night) };
  }
}

const KIND_HE: Record<string, string> = { go: 'GO', ask: 'שאלה', login: 'כניסה לאתר', incident: 'תקלה' };

function summaryText(s: Omit<NightSummary, 'text'>, night: NightRow): string {
  const hhmm = (t: number) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false });
  const lines: string[] = [];
  const scope = night.scope ? ` · רק ${(JSON.parse(night.scope) as string[]).join(', ')}` : '';
  lines.push(`לילה ${hhmm(s.started_at)} עד ${hhmm(s.ended_at)} (${Math.round(s.minutes)} דקות)${scope}`);
  const doneCount = s.done.reduce((n, p) => n + p.tasks.length, 0);
  lines.push('', `מה נעשה (${doneCount}):`);
  if (!doneCount) lines.push('- כלום לא נסגר');
  for (const p of s.done) {
    lines.push(`- ${p.project}:`);
    for (const t of p.tasks) lines.push(`  - ${t.ref ?? `#${t.id}`} ${t.title}${t.note ? ` · ${t.note}` : ''}`);
  }
  lines.push('', `מה מחכה לך (${s.waiting.length}):`);
  if (!s.waiting.length) lines.push('- כלום');
  for (const w of s.waiting) lines.push(`- ${KIND_HE[w.kind] ?? w.kind}${w.blocking ? ' חוסם' : ''}: ${w.title} (בתיבה, פריט ${w.id})`);
  lines.push('', `מה דולג ולמה (${s.skipped.length}):`);
  if (!s.skipped.length) lines.push('- כלום');
  for (const k of s.skipped) lines.push(`- ${k.ref ?? `#${k.id}`} ${k.title}: ${k.why}`);
  lines.push('', `משבצת ריקה בזמן שהייתה עבודה בתור: ${s.empty.minutes} דקות (${s.empty.pct}% מהלילה, היעד פחות מ-5%)`);
  for (const r of s.empty.reasons) lines.push(`- ${r.reason}: ${r.minutes} דקות`);
  return lines.join('\n');
}
