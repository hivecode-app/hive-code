// The owner's single "waiting for you" inbox (A.4). Order: blocking first, then urgency, then age.
// Only items that block on him are pushed (A.4, B.8); everything else waits in the inbox/summary.
//
// task 986 (31/10, «המסך הזה של החלטות אני לא סובל אותו… סתם הצטבר שם הרבה דברים»): only what is blocked on him is
// his: a question, a GO, a sign-in (`forOwner`). The system's faults (an incident, a failed delivery or shift, a fault
// the error-catcher caught) go to the manager the moment they come in (`setRouter`), and the manager brings him only
// what is his. A task to check is a card in its worker's conversation (awaiting.ts), not here. What he left 48 hours
// goes back to the manager (`returnStale`). Nothing is deleted: the rows stay, out of his view.
import type { InboxItemDTO, InboxLink, InboxKind, Urgency } from '@company/shared';
import type { Store } from './store.ts';

export interface NewInboxItem {
  kind: InboxKind;
  title: string;
  body?: string;
  from_identity?: string | null;
  urgency?: Urgency;
  blocking?: boolean;
  ref?: string | null;
  link?: string | null;
  headline?: string | null;
  links?: InboxLink[] | null;
  dedupe_key?: string | null;
}

interface InboxRow { id: number; kind: InboxKind; title: string; body: string; from_identity: string | null; urgency: Urgency;
  blocking: number; ref: string | null; link: string | null; headline: string | null; links: string | null; state: InboxItemDTO['state']; created_at: number; pushed_at: number | null; acked_at: number | null;
  snoozed_at: number | null; telegram_at: number | null; push_error: string | null; returned_at: number | null }

export const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, normal: 1, low: 2 };

/** He left it this long: it goes back to the manager, who decides it or words it again (task 986). */
export const RETURN_AFTER_MS = 48 * 3600_000;

/** A fault the error-catcher caught (error-watch.ts): the system's, so the manager's, not his. */
type Who = Pick<InboxItemDTO, 'kind'> & Partial<Pick<InboxItemDTO, 'from_identity' | 'ref'>>;

export const isCaughtFault = (item: Who): boolean =>
  item.kind === 'ask' && item.from_identity === 'hq' && !!item.ref?.startsWith('err-');

/**
 * A fault the manager can't take, so it is his: the manager's own shift fell, a message to the manager failed, or every
 * account is full (nobody can work, the manager neither). Sent to the manager it would only fail again, and nobody would
 * hear of it (lessons: "manager died").
 */
export function managerDown(item: Who, manager: string | null | undefined): boolean {
  if (item.kind === 'incident') return item.ref === 'accounts-all-full';
  return (item.kind === 'delivery_failure' || item.kind === 'shift_failure') && !!manager && item.from_identity === manager;
}

/** What is blocked on him and only on him: a question, a GO, a sign-in, and the manager's own fall. Everything else is the manager's (task 986). */
export function forOwner(item: Who, manager?: string | null): boolean {
  if (isCaughtFault(item)) return false;
  return item.kind === 'ask' || item.kind === 'go' || item.kind === 'login' || managerDown(item, manager);
}

/** Kinds that mean "blocked on you" — the only ones that may push (A.4). Focus mode: nothing (an incident is the manager's now). */
export function pushWorthy(item: Who & Pick<InboxItemDTO, 'blocking' | 'urgency'>, focus: boolean, manager?: string | null): boolean {
  if (focus || !forOwner(item, manager)) return false;
  if (item.kind === 'ask') return item.blocking;
  return true;
}

export type Notify = (item: InboxItemDTO) => void;

export class Inbox {
  private notify: Notify = () => {};
  private route: Notify = () => {};
  private store: Store;
  /** The manager: where a fault of the system goes, unless it is the manager's own (managerDown). */
  manager: string | null = null;
  constructor(store: Store) {
    this.store = store;
  }

  setNotifier(n: Notify): void { this.notify = n; }

  /** Where a fault of the system goes instead of him: the manager (hq.ts). */
  setRouter(r: Notify, manager: string): void { this.route = r; this.manager = manager; }

  /** His (forOwner), with this company's manager. */
  isHis(item: Who): boolean { return forOwner(item, this.manager); }

  /** What reaches the manager instead of him. A check card is its worker's (awaiting.ts); "the manager decided" is the manager's own. */
  private toManager(item: Who): boolean {
    return !this.isHis(item) && item.kind !== 'awaiting' && item.kind !== 'escalation_note';
  }

  add(n: NewInboxItem): InboxItemDTO {
    const now = this.store.now();
    if (n.dedupe_key) {
      const ex = this.store.db.prepare('SELECT * FROM inbox WHERE dedupe_key = ?').get(n.dedupe_key) as InboxRow | undefined;
      if (ex) return toDTO(ex);
    }
    const r = this.store.db.prepare(`INSERT INTO inbox (kind, title, body, from_identity, urgency, blocking, ref, link, headline, links, dedupe_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(n.kind, n.title, n.body ?? '', n.from_identity ?? null, n.urgency ?? 'normal',
      n.blocking ? 1 : 0, n.ref ?? null, n.link ?? null, n.headline ?? null, n.links?.length ? JSON.stringify(n.links) : null, n.dedupe_key ?? null, now);
    const item = this.get(Number(r.lastInsertRowid))!;
    this.store.emit('inbox.new', item.from_identity, item);
    if (this.toManager(item)) this.route(item);
    else this.notify(item);
    return item;
  }

  get(id: number): InboxItemDTO | undefined {
    const r = this.store.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as InboxRow | undefined;
    return r ? toDTO(r) : undefined;
  }

  open(): InboxItemDTO[] {
    const rows = this.store.db.prepare(`SELECT * FROM inbox WHERE state = 'open'
      ORDER BY snoozed_at IS NOT NULL, blocking DESC, CASE urgency WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC, id ASC`).all() as InboxRow[];
    return rows.map(toDTO);
  }

  /** What is his to decide now (task 986): a question, a GO, a sign-in, the manager's own fall; not gone back to the manager. In open()'s order. */
  mine(): InboxItemDTO[] {
    const rows = this.store.db.prepare(`SELECT * FROM inbox WHERE state = 'open' AND returned_at IS NULL AND kind IN ('ask', 'go', 'login', 'delivery_failure', 'shift_failure', 'incident')
      ORDER BY snoozed_at IS NOT NULL, blocking DESC, CASE urgency WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at ASC, id ASC`).all() as InboxRow[];
    return rows.map(toDTO).filter((i) => this.isHis(i));
  }

  /** The tasks he is asked to check (awaiting check/verify): cards in their worker's conversation, not in his queue. */
  checks(): InboxItemDTO[] {
    const rows = this.store.db.prepare(`SELECT * FROM inbox WHERE state = 'open' AND kind = 'awaiting' ORDER BY created_at ASC, id ASC`).all() as InboxRow[];
    return rows.map(toDTO);
  }

  /**
   * What he left RETURN_AFTER_MS goes back to the manager (task 986): out of his view, kept open as it is, and [back] tells
   * the manager, who decides it if it is theirs or words it again. Once per item. Returns what went back.
   */
  returnStale(back: (item: InboxItemDTO) => void): InboxItemDTO[] {
    const now = this.store.now();
    // A question or a GO: a sign-in expires by itself, and the manager's own fall can't go back to the manager.
    const stale = this.mine().filter((i) => i.created_at <= now - RETURN_AFTER_MS && (i.kind === 'ask' || i.kind === 'go'));
    const out: InboxItemDTO[] = [];
    for (const i of stale) {
      if (!this.store.db.prepare('UPDATE inbox SET returned_at = ? WHERE id = ? AND returned_at IS NULL').run(now, i.id).changes) continue;
      this.store.emit('inbox.returned', i.from_identity, { id: i.id, kind: i.kind });
      back(i);
      out.push(i);
    }
    return out;
  }

  /** When what waits for him last changed: an item came in, was answered or closed, or was put off (null: never). */
  lastChange(): number | null {
    const r = this.store.db.prepare('SELECT MAX(MAX(created_at, COALESCE(resolved_at, 0), COALESCE(snoozed_at, 0))) AS at FROM inbox').get() as { at: number | null };
    const snooze = Number(this.store.getMeta('inbox.snooze_changed_at') ?? 0);
    const at = Math.max(r.at ?? 0, snooze);
    return at > 0 ? at : null;
  }

  /** The same item, new words (error-watch.ts: the count went up). Open items only. */
  updateByRef(kind: InboxKind, ref: string, u: { body?: string; headline?: string; title?: string }): void {
    const rows = this.store.db.prepare(`SELECT id FROM inbox WHERE kind = ? AND ref = ? AND state = 'open'`).all(kind, ref) as { id: number }[];
    for (const r of rows) {
      this.store.db.prepare('UPDATE inbox SET body = COALESCE(?, body), headline = COALESCE(?, headline), title = COALESCE(?, title) WHERE id = ?')
        .run(u.body ?? null, u.headline ?? null, u.title ?? null, r.id);
      this.store.emit('inbox.updated', null, this.get(r.id));
    }
  }

  resolveByRef(kind: InboxKind, ref: string, state: 'resolved' | 'dismissed' = 'resolved'): void {
    const rows = this.store.db.prepare(`SELECT id FROM inbox WHERE kind = ? AND ref = ? AND state = 'open'`).all(kind, ref) as { id: number }[];
    for (const r of rows) this.resolve(r.id, state);
  }

  resolve(id: number, state: 'resolved' | 'dismissed' = 'resolved'): boolean {
    const r = this.store.db.prepare(`UPDATE inbox SET state = ?, resolved_at = ? WHERE id = ? AND state = 'open'`).run(state, this.store.now(), id);
    if (r.changes) this.store.emit('inbox.resolved', null, { id, state });
    return r.changes > 0;
  }

  /** Tapping the notification counts as receipt (B.8). */
  ack(id: number): boolean {
    const r = this.store.db.prepare('UPDATE inbox SET acked_at = COALESCE(acked_at, ?) WHERE id = ?').run(this.store.now(), id);
    if (r.changes) this.store.emit('inbox.acked', null, { id });
    return r.changes > 0;
  }

  /**
   * "לא עכשיו" (#74): the item stays open, below the rest, until he takes it back or it closes. Putting it
   * off counts as receipt too, so no Telegram chases it.
   */
  snooze(id: number, on = true): boolean {
    const now = this.store.now();
    const r = on
      ? this.store.db.prepare(`UPDATE inbox SET snoozed_at = COALESCE(snoozed_at, ?), acked_at = COALESCE(acked_at, ?) WHERE id = ? AND state = 'open'`).run(now, now, id)
      : this.store.db.prepare(`UPDATE inbox SET snoozed_at = NULL WHERE id = ? AND state = 'open'`).run(id);
    if (r.changes) {
      // Taking it back clears snoozed_at: lastChange() reads this one.
      this.store.setMeta('inbox.snooze_changed_at', String(now));
      this.store.emit('inbox.snoozed', null, { id, on });
    }
    return r.changes > 0;
  }

  markPushed(id: number, error: string | null): void {
    this.store.db.prepare('UPDATE inbox SET pushed_at = ?, push_error = ? WHERE id = ?').run(this.store.now(), error, id);
  }

  /** Takes the item's one Telegram before sending, so two sweeps never both send it. False = already taken. */
  claimTelegram(id: number): boolean {
    return this.store.db.prepare('UPDATE inbox SET telegram_at = ? WHERE id = ? AND telegram_at IS NULL').run(this.store.now(), id).changes > 0;
  }

  /** The send failed: the claim is released, to be retried (owedTelegram counts the attempts). */
  markTelegramFailed(id: number, error: string): void {
    this.store.db.prepare('UPDATE inbox SET telegram_at = NULL, telegram_failures = telegram_failures + 1, push_error = ? WHERE id = ?').run(error, id);
  }

  /**
   * Telegram is owed (#204) for a GO, a login or anything urgent that he hasn't taken (answered, tapped, put
   * off): at once when the app is not connected, else once it has waited `urgentMs` (urgent) or `ms` (the rest).
   * A blocking ask is not here: it goes to the manager after 10 minutes anyway. Once per item; a failed send is
   * retried, up to 5 attempts. `id`: only that item.
   */
  owedTelegram(o: { offline: boolean; urgentMs: number; ms: number; id?: number }): InboxItemDTO[] {
    const now = this.store.now();
    const rows = this.store.db.prepare(`SELECT * FROM inbox WHERE state = 'open' AND pushed_at IS NOT NULL AND telegram_at IS NULL
      AND telegram_failures < 5 AND acked_at IS NULL AND returned_at IS NULL AND (@id IS NULL OR id = @id)
      AND (kind IN ('go', 'login') OR (kind = 'ask' AND urgency = 'urgent' AND NOT (from_identity = 'hq' AND ref LIKE 'err-%'))
        OR kind IN ('delivery_failure', 'shift_failure', 'incident'))
      AND (@offline = 1 OR created_at <= CASE urgency WHEN 'urgent' THEN @urgent ELSE @rest END)
      ORDER BY id`).all({ id: o.id ?? null, offline: o.offline ? 1 : 0, urgent: now - o.urgentMs, rest: now - o.ms }) as InboxRow[];
    // A fault only when it is his (the manager's own fall); pushed_at above means it was his when it came in.
    return rows.map(toDTO).filter((i) => i.kind === 'go' || i.kind === 'login' || i.kind === 'ask' || this.isHis(i));
  }
}

function toDTO(r: InboxRow): InboxItemDTO {
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body, from_identity: r.from_identity, urgency: r.urgency,
    blocking: r.blocking === 1, ref: r.ref, link: r.link ?? null, headline: r.headline ?? null, links: parseLinks(r.links), state: r.state, created_at: r.created_at, pushed_at: r.pushed_at, acked_at: r.acked_at,
    snoozed_at: r.snoozed_at ?? null,
  };
}

function parseLinks(raw: string | null): InboxLink[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((l): l is InboxLink => !!l && typeof l === 'object' && ((l as InboxLink).kind === 'report' || (l as InboxLink).kind === 'pr') && typeof (l as InboxLink).url === 'string') : [];
  } catch { return []; }
}
