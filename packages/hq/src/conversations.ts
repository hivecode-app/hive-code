// His conversations as in WhatsApp: what he hasn't read, what may alert him, and what he muted. Kept here, so
// every device shows the same counts and reading on the phone clears the desktop too.
// A worker's message to him alerts (conv.alert → the phone's link service, and Web Push to the same
// subscriptions as the inbox) unless the conversation is muted, it is open on one of his screens right now,
// or push is off / focus / night is on (APP-SPEC §5.5). It still counts as unread either way.
import { MUTE_FOREVER, OWNER, type ConversationStateDTO } from '@company/shared';
import type { Store } from './store.ts';

interface ConvRow { identity: string; read_at: number; muted_until: number | null; alert_at: number | null; alert_level: 'sound' | 'silent' | null; last_sound_at: number | null; pending_alert: string | null; pending_due: number | null }
export interface MessageLike { id: string; from_identity: string; to_identity: string; kind: string; body: string; created_at: number; priority?: string; alert_hint?: 'fyi' | 'eta' | null }

export type MuteFor = '8h' | 'week' | 'always' | 'off';
export const MUTE_FOR: readonly MuteFor[] = ['8h', 'week', 'always', 'off'];

/** A screen that says "this conversation is open on me" goes stale after this, unless it says it again. */
export const PRESENCE_TTL_MS = 60_000;

/** The others in his conversations: never him, never hq (the system has no conversation, #55). */
const NOT_A_CONVERSATION = new Set([OWNER, 'hq']);

/** Only what a worker says to him counts: not system lines (shown as event lines, not messages), not a turn's kept text (`note`). */
const counts = (m: Pick<MessageLike, 'from_identity' | 'to_identity' | 'kind'>) =>
  m.to_identity === OWNER && !NOT_A_CONVERSATION.has(m.from_identity) && m.kind !== 'system' && m.kind !== 'note';

export type AlertLevel = 'sound' | 'silent' | 'badge' | 'none';
export const SOUND_WINDOW_MS = 10 * 60_000;
export const ALERT_DELAY_MS = 20_000;
export function alertLevel(m: MessageLike, conv: { muted_until?: number | null; last_sound_at?: number | null; on_screen?: boolean },
  toggles: { push: boolean; focus: boolean; night: boolean }, now: number): AlertLevel {
  if (!counts(m)) return 'none';
  if (conv.on_screen) return 'none';
  if ((conv.muted_until ?? 0) > now || !toggles.push) return 'badge';
  if (m.priority === 'now') return 'sound';
  if (toggles.focus || toggles.night || m.alert_hint === 'fyi') return 'badge';
  if (m.alert_hint === 'eta' || (conv.last_sound_at != null && now - conv.last_sound_at < SOUND_WINDOW_MS)) return 'silent';
  return 'sound';
}

export type MessageAlert = (a: { identity: string; title: string; body: string; message: string; priority?: string; level: 'sound' | 'silent' }) => void;

export class Conversations {
  private store: Store;
  private titleOf: (identity: string) => string;
  /** device → the conversation on its screen, and when it last said so. In memory: a restart forgets screens. */
  private screens = new Map<string, { identity: string; at: number }>();
  private alert: MessageAlert = () => {};

  constructor(store: Store, titleOf: (identity: string) => string) {
    this.store = store;
    this.titleOf = titleOf;
    store.onEvent((e) => {
      if (e.type === 'message.new') this.onMessage(e.data as MessageLike);
    });
  }

  /** Web Push for a message that may alert (push.ts). */
  setAlert(a: MessageAlert): void { this.alert = a; }

  private row(identity: string): ConvRow | undefined {
    return this.store.db.prepare('SELECT * FROM conversations WHERE identity = ?').get(identity) as ConvRow | undefined;
  }

  private upsert(identity: string, set: Partial<Omit<ConvRow, 'identity'>>): void {
    const now = this.store.now();
    this.store.db.prepare('INSERT OR IGNORE INTO conversations (identity, updated_at) VALUES (?, ?)').run(identity, now);
    const cols = Object.keys(set);
    this.store.db.prepare(`UPDATE conversations SET ${[...cols.map((k) => `${k} = @${k}`), 'updated_at = @now'].join(', ')} WHERE identity = @identity`)
      .run({ identity, now, ...set });
  }

  muted(identity: string): boolean {
    const until = this.row(identity)?.muted_until;
    return until != null && until > this.store.now();
  }

  /** Is this conversation open on one of his screens right now (the app in front, the chat showing)? */
  onScreen(identity: string): boolean {
    const now = this.store.now();
    for (const s of this.screens.values()) if (s.identity === identity && now - s.at < PRESENCE_TTL_MS) return true;
    return false;
  }

  /** A device says which conversation it shows now (null = none, or the app went to the background). */
  setScreen(device: string, identity: string | null): void {
    if (identity) this.screens.set(device, { identity, at: this.store.now() });
    else this.screens.delete(device);
  }

  /** He read it up to [at] (default: now). Never moves back. Emits only on a change, so a heartbeat costs nothing. */
  markRead(identity: string, at?: number): ConversationStateDTO {
    const upTo = at ?? this.store.now();
    const cur = this.row(identity);
    if (!cur || upTo > cur.read_at) {
      this.upsert(identity, { read_at: upTo });
      this.store.emit('conv.read', identity, { identity, read_at: upTo, unread_total: this.unreadTotal() });
    }
    return this.get(identity);
  }

  mute(identity: string, duration: MuteFor): ConversationStateDTO {
    const now = this.store.now();
    const until = { '8h': now + 8 * 3_600_000, week: now + 7 * 86_400_000, always: MUTE_FOREVER, off: null }[duration];
    this.upsert(identity, { muted_until: until });
    this.store.emit('conv.muted', identity, { identity, muted_until: until, unread_total: this.unreadTotal() });
    return this.get(identity);
  }

  private toggles() { return { push: this.store.toggle('push'), focus: this.store.toggle('focus'), night: this.store.toggle('night') }; }

  /** Also used by check cards in the opener's chat, after a task worker reported the result. */
  soundedRecently(identity: string | null | undefined): boolean {
    if (!identity) return false;
    const row = this.row(identity);
    const pending = row?.pending_alert ? JSON.parse(row.pending_alert) as { level: string } : null;
    return pending?.level === 'sound' || (row?.last_sound_at != null && this.store.now() - row.last_sound_at < SOUND_WINDOW_MS);
  }

  private onMessage(m: MessageLike): void {
    if (!m || !counts(m)) return;
    this.flush();
    const who = m.from_identity;
    const row = this.row(who);
    const level = alertLevel(m, { ...row, on_screen: this.onScreen(who) }, this.toggles(), this.store.now());
    if (level === 'badge') this.store.emit('conv.badge', who, { identity: who, message: m.id, level });
    if (level === 'badge' || level === 'none') return;
    if (m.priority === 'now') {
      this.upsert(who, { pending_alert: null, pending_due: null });
      this.send(m, level);
      return;
    }
    const pending = row?.pending_alert ? JSON.parse(row.pending_alert) as { level: string } : null;
    this.upsert(who, { pending_alert: JSON.stringify({ m, level: pending?.level === 'sound' ? 'sound' : level }), pending_due: this.store.now() + ALERT_DELAY_MS });
  }

  /** Durable 20-second window: the normal hq timer and fake-clock tests use the same path. */
  flush(): void {
    const rows = this.store.db.prepare('SELECT * FROM conversations WHERE pending_due <= ?').all(this.store.now()) as ConvRow[];
    for (const row of rows) {
      const { m, level } = JSON.parse(row.pending_alert!) as { m: MessageLike; level: 'sound' | 'silent' };
      this.upsert(row.identity, { pending_alert: null, pending_due: null });
      if (m.created_at <= row.read_at) continue;
      const current = alertLevel({ ...m, alert_hint: null }, { ...row, on_screen: this.onScreen(row.identity) }, this.toggles(), this.store.now());
      if (current === 'none' || current === 'badge') continue;
      this.send(m, current === 'silent' ? 'silent' : level);
    }
  }

  private send(m: MessageLike, level: 'sound' | 'silent'): void {
    const who = m.from_identity;
    this.upsert(who, { alert_at: m.created_at, alert_level: level, ...(level === 'sound' ? { last_sound_at: this.store.now() } : {}) });
    const title = this.titleOf(who), body = m.body.slice(0, 300);
    this.store.emit('conv.alert', who, { identity: who, message: m.id, title, body, created_at: m.created_at, level });
    this.alert({ identity: who, title, body, message: m.id, priority: m.priority, level });
  }

  /** Every conversation he has, newest first. */
  list(): ConversationStateDTO[] {
    const ids = (this.store.db.prepare(`SELECT other AS identity, MAX(created_at) AS last_at FROM (
        SELECT CASE WHEN from_identity = @owner THEN to_identity ELSE from_identity END AS other, created_at
        FROM messages WHERE from_identity = @owner OR to_identity = @owner)
      GROUP BY other ORDER BY last_at DESC`).all({ owner: OWNER }) as { identity: string; last_at: number }[])
      .filter((r) => !NOT_A_CONVERSATION.has(r.identity));
    const known = new Set(ids.map((r) => r.identity));
    // Muted before any message (from the chat menu of a new worker): still his setting.
    const rest = (this.store.db.prepare('SELECT identity FROM conversations').all() as { identity: string }[])
      .filter((r) => !known.has(r.identity) && !NOT_A_CONVERSATION.has(r.identity)).map((r) => ({ identity: r.identity, last_at: null }));
    return [...ids, ...rest].map((r) => this.get(r.identity, r.last_at));
  }

  get(identity: string, lastAt?: number | null): ConversationStateDTO {
    const row = this.row(identity);
    const readAt = row?.read_at ?? 0;
    const unread = this.store.db.prepare(`SELECT id, body, created_at FROM messages WHERE from_identity = ? AND to_identity = ?
      AND kind NOT IN ('system','note') AND created_at > ? ORDER BY created_at DESC, rowid DESC`).all(identity, OWNER, readAt) as
      { id: string; body: string; created_at: number }[];
    const last = lastAt !== undefined ? lastAt : (this.store.db.prepare(`SELECT MAX(created_at) AS t FROM messages
      WHERE (from_identity = ? AND to_identity = ?) OR (from_identity = ? AND to_identity = ?)`).get(identity, OWNER, OWNER, identity) as { t: number | null }).t;
    return {
      identity, title: this.titleOf(identity),
      unread: NOT_A_CONVERSATION.has(identity) ? 0 : unread.length,
      read_at: readAt,
      muted_until: row?.muted_until != null && row.muted_until > this.store.now() ? row.muted_until : null,
      alert_at: row?.alert_at ?? null,
      alert_level: row?.alert_level ?? null,
      last_at: last,
      recent: unread.slice(0, 5).reverse().map((m) => ({ id: m.id, body: m.body.slice(0, 300), created_at: m.created_at })),
    };
  }

  /** The number on the "שיחות" tab and the app icon: unread in conversations that aren't muted. */
  unreadTotal(): number {
    return this.list().reduce((n, c) => n + (c.muted_until == null ? c.unread : 0), 0);
  }
}
