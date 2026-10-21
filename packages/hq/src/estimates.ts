// הערכות זמן: the live register of what a worker promised ("X יהיה מוכן תוך Y"), instead of guessing it from text.
// A worker gives eta_min or eta_at, eta_kind and eta_what in `tell` or `status` (ingest.ts). hq stores it here, answers
// with the company's calibration (memory/company/time-estimates.md) as a suggestion, and closes it with the real time:
//   status done / eta_done → done (closed_at = the real moment, even when it was late)
//   the task closes any other way → cancelled
//   past due and still open → missed (swept; closing it later still keeps the real time)
// A new estimate of the same worker on the same `what` is an update: the old row stays as given, closed as cancelled
// with superseded_by pointing at the new one.
import type { Store } from './store.ts';
import { nextLocal, tzOffsetMs } from './timezone.ts';

export const ETA_KINDS = ['small-fix', 'feature', 'investigation', 'report', 'build', 'deploy', 'release'] as const;
export type EtaKind = (typeof ETA_KINDS)[number];
export type EstimateOutcome = 'missed' | 'done' | 'cancelled';
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
}

/** A row as the API shows it: `state` is the outcome or `open`, the times are in minutes, `late` = closed after its due time. */
export interface EstimateView extends EstimateRow {
  state: EstimateState; estimated_min: number; actual_min: number | null; late: boolean;
}

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
    if (hm && +hm[1]! < 24 && +hm[2]! < 60) t = nextLocal(now, +hm[1]!, +hm[2]!, tz);
    else if (typeof v === 'number') t = v < 1e11 ? v * 1000 : v;
    else if (typeof v === 'string') t = Date.parse(v);
    if (!Number.isFinite(t) || t <= now || t - now > MAX_ETA_MIN * 60_000) {
      bad('eta: eta_at must be a time in the next two weeks (HH:MM or ISO)', 'ההערכה לא נרשמה: `eta_at` צריך להיות שעה עתידית (HH:MM, או תאריך ושעה מלאים).');
    }
    dueAt = Math.round(t);
  }
  const what = oneLine(a.eta_what) ?? fallbackWhat;
  if (!what) bad('eta: eta_what is required', 'ההערכה לא נרשמה: חסר `eta_what`, מה יהיה מוכן, בשורה אחת.');
  return { dueAt, kind: a.eta_kind as EtaKind, what: what! };
}

export interface EstimateFilter {
  project?: string; identity?: string; state?: EstimateState; kind?: string; message_id?: string; task?: number;
  /** created_at range, ms. */
  since?: number; until?: number; limit?: number;
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
    const r = this.store.db.prepare(`UPDATE estimates SET outcome = 'missed' WHERE closed_at IS NULL AND outcome IS NULL AND due_at < ?`).run(this.store.now());
    return r.changes;
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
      this.store.db.prepare(`UPDATE estimates SET closed_at = ?, outcome = 'done' WHERE id = ?`).run(now, x.id);
      this.store.emit('estimate.closed', identity, { id: x.id, outcome: 'done', actual_min: Math.round((now - x.created_at) / 60_000), late: now > x.due_at });
    }
    return pick.map((x) => this.get(x.id)!);
  }

  /** The task ended some other way than its worker saying done: its estimates were never delivered. */
  cancelForTask(taskId: number): number {
    const now = this.store.now();
    const ids = (this.store.db.prepare('SELECT id, identity FROM estimates WHERE task = ? AND closed_at IS NULL').all(taskId) as { id: number; identity: string }[]);
    for (const x of ids) {
      this.store.db.prepare(`UPDATE estimates SET closed_at = ?, outcome = 'cancelled' WHERE id = ?`).run(now, x.id);
      this.store.emit('estimate.closed', x.identity, { id: x.id, outcome: 'cancelled', task: taskId });
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
    };
  }

  list(f: EstimateFilter = {}): EstimateView[] {
    this.sweepMissed();
    const where: string[] = [];
    const args: (string | number)[] = [];
    const add = (sql: string, v: string | number | undefined) => { if (v !== undefined) { where.push(sql); args.push(v); } };
    add('project = ?', f.project); add('identity = ?', f.identity); add('kind = ?', f.kind); add('message_id = ?', f.message_id); add('task = ?', f.task);
    add('created_at >= ?', f.since); add('created_at < ?', f.until);
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
 * not counted (replaced by a newer estimate, or the task ended without its worker saying done). Null when there were none.
 * Names of what was late or unclosed come with the worker; a per-kind count only for a kind that had something off,
 * and only when more than one kind was given.
 */
export function accuracyLine(rows: EstimateView[]): string | null {
  const all = rows.filter((r) => r.state !== 'cancelled' && r.state !== 'open');
  if (!all.length) return null;
  const order = (a: EstimateView, b: EstimateView) => a.created_at - b.created_at || a.id - b.id;
  const late = all.filter((r) => r.late).sort(order);
  const unclosed = all.filter((r) => r.state === 'missed').sort(order);
  const onTime = all.length - late.length - unclosed.length;
  const parts = [`${all.length}`, `${onTime} בזמן`];
  if (late.length) parts.push(`${late.length} באיחור (${late.map((r) => `${r.identity}, "${r.what}", פי ${num(r.actual_min! / Math.max(1, r.estimated_min))}`).join('; ')})`);
  if (unclosed.length) parts.push(`${unclosed.length} שלא נסגרה (${unclosed.map((r) => `${r.identity}, "${r.what}"`).join('; ')})`);
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
