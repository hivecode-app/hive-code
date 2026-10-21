// The owner's single "waiting for you" inbox (A.4). Order: blocking first, then urgency, then age.
// Only items that block on him are pushed (A.4, B.8); everything else waits in the inbox/summary.
import type { InboxItemDTO, InboxKind, Urgency } from '@company/shared';
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
  dedupe_key?: string | null;
}

interface InboxRow { id: number; kind: InboxKind; title: string; body: string; from_identity: string | null; urgency: Urgency;
  blocking: number; ref: string | null; link: string | null; headline: string | null; state: InboxItemDTO['state']; created_at: number; pushed_at: number | null; acked_at: number | null;
  snoozed_at: number | null; telegram_at: number | null; push_error: string | null }

export const URGENCY_RANK: Record<Urgency, number> = { urgent: 0, normal: 1, low: 2 };

/** Kinds that mean "blocked on you" — the only ones that may push (A.4). */
export function pushWorthy(item: Pick<InboxItemDTO, 'kind' | 'blocking' | 'urgency'>, focus: boolean): boolean {
  const urgentIncident = item.kind === 'incident' && item.urgency === 'urgent';
  if (focus) return urgentIncident;            // focus mode: only urgent production incidents
  if (urgentIncident) return true;
  if (item.kind === 'go' || item.kind === 'login') return true;
  return item.kind === 'ask' && item.blocking;
}

export type Notify = (item: InboxItemDTO) => void;

export class Inbox {
  private notify: Notify = () => {};
  private store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  setNotifier(n: Notify): void { this.notify = n; }

  add(n: NewInboxItem): InboxItemDTO {
    const now = this.store.now();
    if (n.dedupe_key) {
      const ex = this.store.db.prepare('SELECT * FROM inbox WHERE dedupe_key = ?').get(n.dedupe_key) as InboxRow | undefined;
      if (ex) return toDTO(ex);
    }
    const r = this.store.db.prepare(`INSERT INTO inbox (kind, title, body, from_identity, urgency, blocking, ref, link, headline, dedupe_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(n.kind, n.title, n.body ?? '', n.from_identity ?? null, n.urgency ?? 'normal',
      n.blocking ? 1 : 0, n.ref ?? null, n.link ?? null, n.headline ?? null, n.dedupe_key ?? null, now);
    const item = this.get(Number(r.lastInsertRowid))!;
    this.store.emit('inbox.new', item.from_identity, item);
    this.notify(item);
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

  /** When what waits for him last changed: an item came in, was answered or closed, or was put off (null: never). */
  lastChange(): number | null {
    const r = this.store.db.prepare('SELECT MAX(MAX(created_at, COALESCE(resolved_at, 0), COALESCE(snoozed_at, 0))) AS at FROM inbox').get() as { at: number | null };
    const snooze = Number(this.store.getMeta('inbox.snooze_changed_at') ?? 0);
    const at = Math.max(r.at ?? 0, snooze);
    return at > 0 ? at : null;
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
      AND telegram_failures < 5 AND acked_at IS NULL AND (@id IS NULL OR id = @id)
      AND (kind IN ('go', 'login') OR urgency = 'urgent')
      AND (@offline = 1 OR created_at <= CASE urgency WHEN 'urgent' THEN @urgent ELSE @rest END)
      ORDER BY id`).all({ id: o.id ?? null, offline: o.offline ? 1 : 0, urgent: now - o.urgentMs, rest: now - o.ms }) as InboxRow[];
    return rows.map(toDTO);
  }
}

function toDTO(r: InboxRow): InboxItemDTO {
  return {
    id: r.id, kind: r.kind, title: r.title, body: r.body, from_identity: r.from_identity, urgency: r.urgency,
    blocking: r.blocking === 1, ref: r.ref, link: r.link ?? null, headline: r.headline ?? null, state: r.state, created_at: r.created_at, pushed_at: r.pushed_at, acked_at: r.acked_at,
    snoozed_at: r.snoozed_at ?? null,
  };
}
