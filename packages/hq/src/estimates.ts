// הערכות זמן: the live register of what a worker promised ("X יהיה מוכן תוך Y"), instead of guessing it from text.
// A worker gives eta_min or eta_at, eta_kind and eta_what in `tell` or `status` (ingest.ts). hq stores it here, answers
// with the company's calibration (memory/company/time-estimates.md) as a suggestion, and closes it with the real time:
//   status done / eta_done → done (closed_at = the real moment, even when it was late)
//   the task closes any other way → cancelled, but one already past due stays missed (a promise that was not kept)
//   the task is frozen (parked, needs-decision) → frozen, "הוקפא על ידי <מי>": not a promise that was broken, and no reminder
//   past due and still open → missed (swept; closing it later still keeps the real time, and `missed` stays on the row)
// remind() is the scheduler's every-minute pass: the reminder before the due time, the one after it, the manager at +10 minutes.
// A new estimate of the same worker on the same `what` is an update: the old row stays as given, closed as cancelled
// with superseded_by pointing at the new one.
import type { Store } from './store.ts';
import { hhmm, nextLocal, tzOffsetMs, wallToUtc } from './timezone.ts';

export const ETA_KINDS = ['small-fix', 'feature', 'investigation', 'report', 'build', 'deploy', 'release'] as const;
export type EtaKind = (typeof ETA_KINDS)[number];
export type EstimateOutcome = 'missed' | 'done' | 'cancelled' | 'frozen';
export type EstimateState = 'open' | EstimateOutcome;

/** Closed estimates of one kind in one project that turn the default factor into the project's own data. */
export const MIN_SAMPLES = 8;
/** An estimate this short or shorter gets SHORT_PAD_MIN on top of the factor (a short promise is late by minutes). */
export const SHORT_MIN = 30;
export const SHORT_PAD_MIN = 10;
const MAX_ETA_MIN = 14 * 24 * 60;
/** Defaults until a kind has data (time-estimates.md): store releases ×2, builds ×1.5, everything else ×0.33. */
export const DEFAULT_FACTOR: Record<EtaKind, number> = {
  release: 2, build: 1.5, deploy: 0.33, report: 0.33, 'small-fix': 0.33, feature: 0.33, investigation: 0.33,
};

const PLURAL: Record<EtaKind, string> = {
  release: 'שחרורים', build: 'בילדים', deploy: 'פריסות', report: 'דוחות', 'small-fix': 'תיקונים קטנים', feature: 'פיצ\'רים', investigation: 'חקירות',
};

export interface EstimateRow {
  id: number; identity: string; shift: string | null; task: number | null; project: string | null; kind: EtaKind; what: string;
  message_id: string | null; created_at: number; due_at: number; closed_at: number | null; outcome: EstimateOutcome | null; superseded_by: number | null;
  /** When it went past its due time while open (= due_at). Stays when it closes late. */
  missed_at: number | null; reminded_at: number | null; missed_told_at: number | null; escalated_at: number | null;
}

/** A row as the API shows it: `state` is the outcome or `open`, the times are in minutes, `late` = closed after its due time. */
export interface EstimateView extends EstimateRow {
  /** outcome `frozen`: who froze the task (parked / needs-decision) it was promised on. */
  frozen_by: string | null;
  state: EstimateState; estimated_min: number; actual_min: number | null; late: boolean;
  /** Was ever past due while open, also after it closed late: what the statistics and the app count. */
  missed: boolean;
}

/** The reminder comes when 20% of the estimate is left, but not more than REMIND_MAX_MIN and not less than REMIND_MIN_MIN before the due time. */
export const REMIND_FRACTION = 0.2;
export const REMIND_MIN_MIN = 2;
export const REMIND_MAX_MIN = 10;
/** A worker still silent this long after the due time is reported to their manager. */
export const ESCALATE_AFTER_MS = 10 * 60_000;

/** Where `remind` sends: a system message to `to`, once per `msgId`. */
export interface Say { (to: string, msgId: string, body: string): void }

export interface Suggestion {
  /** The Hebrew line the worker hears, e.g. «שחרורים יוצאים פי 2. אולי 120 דקות?». */
  line: string;
  minutes: number; factor: number;
  source: 'data' | 'default'; samples: number;
}

export interface Registered { estimate: EstimateView; suggestion: Suggestion; updated: number | null }

export class EstimateError extends Error {
  /** The reason in Hebrew, for the worker's mailbox. */
  he: string;
  constructor(message: string, he: string) { super(message); this.he = he; }
}

const oneLine = (v: unknown, max = 200): string | null => {
  if (typeof v !== 'string') return null;
  const l = v.split('\n').map((x) => x.trim()).find(Boolean);
  return l ? l.replace(/\s+/g, ' ').slice(0, max) : null;
};
const norm = (v: string): string => v.replace(/\s+/g, ' ').trim().toLowerCase();

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const num = (n: number): string => String(Number(n.toFixed(1)));
const minutes = (n: number): string => (n === 1 ? 'דקה' : `${n} דקות`);

/** What an `eta_*` set of fields says, or null when the call carries none. Throws EstimateError when it is incomplete or wrong. */
export interface EtaFields { dueAt: number; kind: EtaKind; what: string }

export function parseEta(a: Record<string, unknown>, now: number, tz: string, fallbackWhat: string | null): EtaFields | null {
  const hasTime = a.eta_min != null || a.eta_at != null;
  if (!hasTime && a.eta_kind == null && a.eta_what == null) return null;
  const bad = (en: string, he: string): never => { throw new EstimateError(en, he); };
  if (!hasTime) bad('eta: eta_min or eta_at is required', 'ההערכה לא נרשמה: חסר `eta_min` (דקות) או `eta_at` (שעה).');
  if (!ETA_KINDS.includes(a.eta_kind as EtaKind)) {
    bad(`eta: eta_kind must be one of ${ETA_KINDS.join(', ')}`, `ההערכה לא נרשמה: \`eta_kind\` חייב להיות אחד מ-${ETA_KINDS.join(', ')} (release = שחרור לחנויות או שרשרת release, deploy = rollout לשרת).`);
  }
  let dueAt: number;
  if (a.eta_min != null) {
    const m = typeof a.eta_min === 'string' ? Number(a.eta_min) : a.eta_min;
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > MAX_ETA_MIN) bad('eta: eta_min must be minutes, 0 < n <= 20160', 'ההערכה לא נרשמה: `eta_min` הוא מספר דקות (עד שבועיים).');
    dueAt = now + Math.round((m as number) * 60_000);
  } else {
    const v = a.eta_at;
    let t = NaN;
    const hm = typeof v === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(v.trim()) : null;
    // #301: a date and time with no zone is in `tz` too, not in the server's zone (Date.parse would read it as local).
    const bare = typeof v === 'string' ? /^(\d{4}-\d{2}-\d{2})[T ](\d{1,2}):(\d{2}(:\d{2}(\.\d+)?)?)$/.exec(v.trim()) : null;
    if (hm && +hm[1]! < 24 && +hm[2]! < 60) t = nextLocal(now, +hm[1]!, +hm[2]!, tz);
    else if (typeof v === 'number') t = v < 1e11 ? v * 1000 : v;
    else if (bare) {
      t = wallToUtc(Date.parse(`${bare[1]}T${bare[2]!.padStart(2, '0')}:${bare[3]}Z`), tz);
    } else if (typeof v === 'string') t = Date.parse(v);
    if (!Number.isFinite(t) || t <= now || t - now > MAX_ETA_MIN * 60_000) {
      bad('eta: eta_at must be a time in the next two weeks (HH:MM or ISO)', 'ההערכה לא נרשמה: `eta_at` צריך להיות שעה עתידית (HH:MM, או תאריך ושעה מלאים).');
    }
    dueAt = Math.round(t);
  }
  const what = oneLine(a.eta_what) ?? fallbackWhat;
  if (!what) bad('eta: eta_what is required', 'ההערכה לא נרשמה: חסר `eta_what`, מה יהיה מוכן, בשורה אחת.');
  return { dueAt, kind: a.eta_kind as EtaKind, what: what! };
}

/** #301: an estimate further than this is kept, and the worker is told how hq read it (most often a time read in the wrong zone). */
export const LONG_ETA_MIN = 6 * 60;

/** The Hebrew warning for an estimate over LONG_ETA_MIN, or null. `tz` is the zone `eta_at` was read in. */
export function longEtaWarning(a: Record<string, unknown>, eta: EtaFields, now: number, tz: string): string | null {
  const min = Math.round((eta.dueAt - now) / 60_000);
  if (min <= LONG_ETA_MIN) return null;
  const hours = num(min / 60);
  const read = a.eta_min != null
    ? `\`eta_min: ${a.eta_min}\` הוא ${hours} שעות`
    : `\`eta_at: ${String(a.eta_at)}\` הוא ${hhmm(eta.dueAt, tz)} לפי ${tzName(tz)}, בעוד ${hours} שעות`;
  return `ההערכה נרשמה, אבל היא ארוכה: ${read}. אם לא לזה התכוונת, שלח אותה שוב עם \`eta_min\` (דקות מעכשיו).`;
}

/** "שעון ישראל" for the zone workers think in, the IANA name for any other. */
export function tzName(tz: string): string {
  return tz === 'Asia/Jerusalem' ? 'שעון ישראל' : `\`${tz}\``;
}

export interface EstimateFilter {
  project?: string; identity?: string; state?: EstimateState; kind?: string; message_id?: string; task?: number;
  /** created_at range, ms. */
  since?: number; until?: number; limit?: number;
  /** Only the ones that were ever past due while open (also closed late). */
  missed?: boolean;
}

export class Estimates {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** Open = not closed: includes the missed ones, which are only late. */
  private open(identity: string): EstimateRow[] {
    this.sweepMissed();
    return this.store.db.prepare('SELECT * FROM estimates WHERE identity = ? AND closed_at IS NULL ORDER BY id').all(identity) as EstimateRow[];
  }

  /** Past due and still open → outcome missed. Idempotent; closing such a row later keeps closed_at, the real time. */
  sweepMissed(): number {
    const r = this.store.db.prepare(`UPDATE estimates SET outcome = 'missed', missed_at = due_at WHERE closed_at IS NULL AND outcome IS NULL AND due_at < ?`).run(this.store.now());
    return r.changes;
  }

  /**
   * The scheduler's sweep (scheduler.ts), every minute: the state is in the table, so a restart of hq sends nothing twice and loses nothing.
   *  1. reminder: 20% left (2 to 10 minutes) → the worker, once per estimate (an update is a new row, so it starts over);
   *  2. past due and open → missed, and the worker hears it once more;
   *  3. ESCALATE_AFTER_MS past due and still open → `managerOf(worker)`, once. Null = nobody to tell.
   * The owner is not told: `missed` shows in the API (GET /api/estimates) and is not a push.
   */
  remind(say: Say, tz: string, managerOf: (identity: string) => string | null): { reminded: number; missed: number; escalated: number } {
    const db = this.store.db;
    const now = this.store.now();
    const out = { reminded: 0, missed: 0, escalated: 0 };
    const open = `closed_at IS NULL`;
    this.freezeFrozenTasks();
    for (const x of db.prepare(`SELECT * FROM estimates WHERE ${open} AND reminded_at IS NULL AND due_at > ?`).all(now) as EstimateRow[]) {
      const total = x.due_at - x.created_at;
      const lead = Math.min(Math.max(total * REMIND_FRACTION, REMIND_MIN_MIN * 60_000), REMIND_MAX_MIN * 60_000);
      // An estimate no longer than the lead has no time to be reminded in.
      if (lead >= total || now < x.due_at - lead) continue;
      if (db.prepare('UPDATE estimates SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL').run(now, x.id).changes === 0) continue;
      const left = Math.max(1, Math.round((x.due_at - now) / 60_000));
      say(x.identity, `estimate-${x.id}-remind`, `הבטחת לרן "${x.what}" עד ${hhmm(x.due_at, tz)}. נשארו ${minutes(left)}. אם לא תעמוד בזה, תגיד לו עכשיו עם הערכה חדשה (\`eta_min\`), או תסגור עם \`eta_done\`.`);
      this.store.emit('estimate.reminded', x.identity, { id: x.id, left_min: left });
      out.reminded++;
    }
    this.sweepMissed();
    for (const x of db.prepare(`SELECT * FROM estimates WHERE ${open} AND missed_at IS NOT NULL AND missed_told_at IS NULL`).all() as EstimateRow[]) {
      if (db.prepare('UPDATE estimates SET missed_told_at = ? WHERE id = ? AND missed_told_at IS NULL').run(now, x.id).changes === 0) continue;
      say(x.identity, `estimate-${x.id}-missed`, `היעד של "${x.what}" (${hhmm(x.due_at, tz)}) עבר, וההבטחה לרן עדיין פתוחה. תגיד לו עכשיו עם הערכה חדשה (\`eta_min\`), או תסגור עם \`eta_done\`.`);
      this.store.emit('estimate.missed', x.identity, { id: x.id, due_at: x.due_at });
      out.missed++;
    }
    for (const x of db.prepare(`SELECT * FROM estimates WHERE ${open} AND missed_at IS NOT NULL AND escalated_at IS NULL AND due_at <= ?`).all(now - ESCALATE_AFTER_MS) as EstimateRow[]) {
      if (db.prepare('UPDATE estimates SET escalated_at = ? WHERE id = ? AND escalated_at IS NULL').run(now, x.id).changes === 0) continue;
      const mgr = managerOf(x.identity);
      if (!mgr) continue;
      say(mgr, `estimate-${x.id}-escalation`, `${x.identity} הבטיח לרן "${x.what}" עד ${hhmm(x.due_at, tz)}, והיעד עבר לפני ${Math.round((now - x.due_at) / 60_000)} דקות בלי סגירה ובלי הערכה חדשה. כדאי לבדוק מה קורה.`);
      this.store.emit('estimate.escalated', x.identity, { id: x.id, to: mgr });
      out.escalated++;
    }
    return out;
  }

  /**
   * Records an estimate. The same worker's open estimate on the same `what` is replaced by it: kept as given, closed as
   * cancelled with superseded_by. Returns the suggestion hq makes for it (the worker's own number is never changed).
   */
  register(p: { identity: string; shift?: string | null; task?: number | null; project?: string | null; messageId?: string | null } & EtaFields): Registered {
    const db = this.store.db;
    const now = this.store.now();
    const prev = this.open(p.identity).find((x) => norm(x.what) === norm(p.what));
    const r = db.prepare(`INSERT INTO estimates (identity, shift, task, project, kind, what, message_id, created_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(p.identity, p.shift ?? null, p.task ?? null, p.project ?? null, p.kind, p.what, p.messageId ?? null, now, p.dueAt);
    const id = Number(r.lastInsertRowid);
    if (prev) db.prepare(`UPDATE estimates SET closed_at = ?, outcome = 'cancelled', superseded_by = ? WHERE id = ?`).run(now, id, prev.id);
    const estimate = this.view(this.get(id)!);
    this.store.emit('estimate.registered', p.identity, { id, kind: p.kind, what: p.what, due_at: p.dueAt, message_id: p.messageId ?? null, updates: prev?.id ?? null });
    return { estimate, suggestion: this.suggest(p.project ?? null, p.kind, estimate.estimated_min), updated: prev?.id ?? null };
  }

  /**
   * The factor for a kind in a project and what it makes of `estimatedMin`. With MIN_SAMPLES closed (done) estimates of
   * that kind in that project: the median of actual / estimated. Otherwise DEFAULT_FACTOR. A short promise gets SHORT_PAD_MIN on top.
   */
  suggest(project: string | null, kind: EtaKind, estimatedMin: number): Suggestion {
    const rows = this.store.db.prepare(`SELECT created_at, due_at, closed_at FROM estimates
      WHERE kind = ? AND project IS ? AND outcome = 'done' AND closed_at IS NOT NULL AND due_at > created_at`).all(kind, project) as
      { created_at: number; due_at: number; closed_at: number }[];
    const data = rows.length >= MIN_SAMPLES;
    const factor = data ? median(rows.map((x) => (x.closed_at - x.created_at) / (x.due_at - x.created_at))) : DEFAULT_FACTOR[kind];
    const pad = estimatedMin <= SHORT_MIN ? SHORT_PAD_MIN : 0;
    const mins = Math.max(1, Math.round(estimatedMin * factor + pad));
    const same = Math.abs(factor - 1) < 0.1;
    const head = same ? `ההערכות האלה יוצאות מדויקות` : factor > 1 ? `${PLURAL[kind]} יוצאים פי ${num(factor)}` : `עבודה כזו נגמרת בחברה פי ${num(1 / factor)} מהר`;
    return { line: `${head}. אולי ${minutes(mins)}?`, minutes: mins, factor: Number(factor.toFixed(2)), source: data ? 'data' : 'default', samples: rows.length };
  }

  /**
   * Closes open estimates with the real time. `what` closes the one on it, else the newest; `all` closes all of the
   * worker's (status done: it finished, whatever it promised). Already-missed ones close too.
   */
  close(identity: string, opts: { what?: string | null; all?: boolean } = {}): EstimateRow[] {
    const open = this.open(identity);
    const pick = opts.all ? open : opts.what ? open.filter((x) => norm(x.what) === norm(opts.what!)) : open.slice(-1);
    const now = this.store.now();
    for (const x of pick) {
      this.store.db.prepare(`UPDATE estimates SET closed_at = ?, outcome = 'done', missed_at = CASE WHEN ? > due_at THEN due_at ELSE missed_at END WHERE id = ?`).run(now, now, x.id);
      this.store.emit('estimate.closed', identity, { id: x.id, outcome: 'done', actual_min: Math.round((now - x.created_at) / 60_000), late: now > x.due_at });
    }
    return pick.map((x) => this.get(x.id)!);
  }

  /**
   * The task was frozen (parked, or needs-decision): nobody is working on it, so its open estimates close as `frozen` by `by`
   * ("הוקפא על ידי …"), with no reminder and no `missed`, even when past due. A task that thaws gets a new estimate from its worker.
   */
  freezeForTask(taskId: number, by: string): number {
    const now = this.store.now();
    const ids = this.store.db.prepare('SELECT id, identity FROM estimates WHERE task = ? AND closed_at IS NULL').all(taskId) as { id: number; identity: string }[];
    for (const x of ids) {
      this.store.db.prepare(`UPDATE estimates SET closed_at = ?, outcome = 'frozen' WHERE id = ?`).run(now, x.id);
      this.store.db.prepare('INSERT OR REPLACE INTO estimate_frozen (estimate_id, by) VALUES (?, ?)').run(x.id, by);
      this.store.emit('estimate.closed', x.identity, { id: x.id, outcome: 'frozen', by, task: taskId });
    }
    return ids.length;
  }

  /** The every-minute net under freezeForTask: a task frozen some way that did not say who (hq itself marks needs-decision). */
  private freezeFrozenTasks(): void {
    const rows = this.store.db.prepare(`SELECT DISTINCT e.task FROM estimates e JOIN tasks t ON t.id = e.task
      WHERE e.closed_at IS NULL AND (t.state IN ('parked','needs_decision') OR EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = 'needs-decision'))`).all() as { task: number }[];
    for (const r of rows) this.freezeForTask(r.task, 'hq');
  }

  /**
   * The task ended some other way than its worker saying done: its estimates were never delivered. One that was already
   * past due stays `missed` (closed, but still a promise that was not kept); only one cancelled before its due time is `cancelled`.
   */
  cancelForTask(taskId: number): number {
    const now = this.store.now();
    const ids = (this.store.db.prepare('SELECT id, identity, due_at FROM estimates WHERE task = ? AND closed_at IS NULL').all(taskId) as { id: number; identity: string; due_at: number }[]);
    for (const x of ids) {
      const outcome = x.due_at < now ? 'missed' : 'cancelled';
      this.store.db.prepare(`UPDATE estimates SET closed_at = ?, outcome = ? WHERE id = ?`).run(now, outcome, x.id);
      this.store.emit('estimate.closed', x.identity, { id: x.id, outcome, task: taskId });
    }
    return ids.length;
  }

  get(id: number): EstimateRow | undefined {
    return this.store.db.prepare('SELECT * FROM estimates WHERE id = ?').get(id) as EstimateRow | undefined;
  }

  view(r: EstimateRow): EstimateView {
    return {
      ...r, state: r.outcome ?? 'open', estimated_min: Math.round((r.due_at - r.created_at) / 60_000),
      actual_min: r.closed_at != null && r.outcome === 'done' ? Math.round((r.closed_at - r.created_at) / 60_000) : null,
      late: r.closed_at != null && r.outcome === 'done' && r.closed_at > r.due_at,
      missed: r.missed_at != null,
      frozen_by: r.outcome === 'frozen' ? (this.store.db.prepare('SELECT by FROM estimate_frozen WHERE estimate_id = ?').get(r.id) as { by: string } | undefined)?.by ?? null : null,
    };
  }

  list(f: EstimateFilter = {}): EstimateView[] {
    this.sweepMissed();
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, v: string | number | undefined) => { if (v !== undefined) { where.push(sql); args.push(v); } };
    add('project = ?', f.project); add('identity = ?', f.identity); add('kind = ?', f.kind); add('message_id = ?', f.message_id); add('task = ?', f.task);
    add('created_at >= ?', f.since); add('created_at < ?', f.until);
    if (f.missed) where.push('missed_at IS NOT NULL');
    if (f.state === 'open') where.push('closed_at IS NULL AND outcome IS NULL');
    else if (f.state) { where.push('outcome = ?'); args.push(f.state); }
    const limit = Math.min(Math.max(f.limit ?? 200, 1), 1000);
    const rows = this.store.db.prepare(`SELECT * FROM estimates ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args, limit) as EstimateRow[];
    return rows.map((r) => this.view(r));
  }
}

/** [start, end) of the local calendar day before the one `ts` falls in, in `tz`. */
export function yesterdayRange(ts: number, tz: string): { since: number; until: number } {
  const at = (days: number): number => {
    const l = new Date(ts + tzOffsetMs(ts, tz));
    const guess = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), l.getUTCDate() + days);
    return guess - tzOffsetMs(guess - tzOffsetMs(guess, tz), tz);
  };
  return { since: at(-1), until: at(0) };
}

/**
 * One line for the morning summary: how yesterday's estimates ended. On time = closed done by its due time; late = closed
 * done after it (with the factor actual / estimated); unclosed = past due and still open (an open one not yet due is not known
 * yet, and is left out). Cancelled ones are
 * not counted (replaced by a newer estimate, or the task ended before it was due). Null when there were none.
 * An estimate that was missed and then cancelled with its task stays counted as unclosed.
 * Names of what was late or unclosed come with the worker (`name` turns an identity into the Hebrew name); a per-kind count only for a kind that had something off,
 * and only when more than one kind was given.
 */
export function accuracyLine(rows: EstimateView[], name: (identity: string) => string = (id) => id): string | null {
  const all = rows.filter((r) => r.state !== 'cancelled' && r.state !== 'frozen' && r.state !== 'open');
  if (!all.length) return null;
  const order = (a: EstimateView, b: EstimateView) => a.created_at - b.created_at || a.id - b.id;
  const late = all.filter((r) => r.late).sort(order);
  const unclosed = all.filter((r) => r.state === 'missed').sort(order);
  const onTime = all.length - late.length - unclosed.length;
  const parts = [`${all.length}`, `${onTime} בזמן`];
  if (late.length) parts.push(`${late.length} באיחור (${late.map((r) => `${name(r.identity)}, "${r.what}", פי ${num(r.actual_min! / Math.max(1, r.estimated_min))}`).join('; ')})`);
  if (unclosed.length) parts.push(`${unclosed.length} ${unclosed.length === 1 ? 'שלא נסגרה' : 'שלא נסגרו'} (${unclosed.map((r) => `${name(r.identity)}, "${r.what}"`).join('; ')})`);
  const head = `הערכות אתמול: ${parts[0]}, מתוכן ${parts.slice(1).join(' ו-')}`;
  let line = head;
  const kinds = new Map<EtaKind, EstimateView[]>();
  for (const k of ETA_KINDS) { const rs = all.filter((r) => r.kind === k); if (rs.length) kinds.set(k, rs); }
  if (kinds.size > 1) {
    const off = [...kinds].filter(([, rs]) => rs.some((r) => r.late || r.state === 'missed'))
      .map(([k, rs]) => `${PLURAL[k]} ${rs.filter((r) => r.late || r.state === 'missed').length} מתוך ${rs.length}`);
    if (off.length) line += ` · חריגים לפי סוג: ${off.join(', ')}`;
  }
  return line;
}
