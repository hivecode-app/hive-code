// His conversations as in WhatsApp: what he hasn't read, what may alert him, and what he muted. Kept here, so
// every device shows the same counts and reading on the phone clears the desktop too.
// A worker's message to him alerts (conv.alert → the phone's link service, and Web Push to the same
// subscriptions as the inbox) unless the conversation is muted, it is open on one of his screens right now,
// or push is off / focus / night is on (APP-SPEC §5.5). It still counts as unread either way.
import { MUTE_FOREVER, OWNER, type ConversationStateDTO } from '@company/shared';
import type { Store } from './store.ts';

interface ConvRow { identity: string; read_at: number; muted_until: number | null; alert_at: number | null }
interface MessageLike { id: string; from_identity: string; to_identity: string; kind: string; body: string; created_at: number }

export type MuteFor = '8h' | 'week' | 'always' | 'off';
export const MUTE_FOR: readonly MuteFor[] = ['8h', 'week', 'always', 'off'];

/** A screen that says "this conversation is open on me" goes stale after this, unless it says it again. */
export const PRESENCE_TTL_MS = 60_000;

/** The others in his conversations: never him, never hq (the system has no conversation, #55). */
const NOT_A_CONVERSATION = new Set([OWNER, 'hq']);

/** Only what a worker says to him counts: not system lines (shown as event lines, not messages). */
const counts = (m: Pick<MessageLike, 'from_identity' | 'to_identity' | 'kind'>) =>
  m.to_identity === OWNER && !NOT_A_CONVERSATION.has(m.from_identity) && m.kind !== 'system';

export type MessageAlert = (a: { identity: string; title: string; body: string; message: string }) => void;

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

  private onMessage(m: MessageLike): void {
    if (!m || !counts(m)) return;
    const who = m.from_identity;
    if (this.muted(who) || this.onScreen(who)) return;
    if (!this.store.toggle('push') || this.store.toggle('focus') || this.store.toggle('night')) return;
    this.upsert(who, { alert_at: m.created_at });
    const title = this.titleOf(who);
    const body = m.body.slice(0, 300);
    this.store.emit('conv.alert', who, { identity: who, message: m.id, title, body, created_at: m.created_at });
    this.alert({ identity: who, title, body, message: m.id });
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
      AND kind != 'system' AND created_at > ? ORDER BY created_at DESC, rowid DESC`).all(identity, OWNER, readAt) as
      { id: string; body: string; created_at: number }[];
    const last = lastAt !== undefined ? lastAt : (this.store.db.prepare(`SELECT MAX(created_at) AS t FROM messages
      WHERE (from_identity = ? AND to_identity = ?) OR (from_identity = ? AND to_identity = ?)`).get(identity, OWNER, OWNER, identity) as { t: number | null }).t;
    return {
      identity, title: this.titleOf(identity),
      unread: NOT_A_CONVERSATION.has(identity) ? 0 : unread.length,
      read_at: readAt,
      muted_until: row?.muted_until != null && row.muted_until > this.store.now() ? row.muted_until : null,
      alert_at: row?.alert_at ?? null,
      last_at: last,
      recent: unread.slice(0, 5).reverse().map((m) => ({ id: m.id, body: m.body.slice(0, 300), created_at: m.created_at })),
    };
  }

  /** The number on the "שיחות" tab and the app icon: unread in conversations that aren't muted. */
  unreadTotal(): number {
    return this.list().reduce((n, c) => n + (c.muted_until == null ? c.unread : 0), 0);
  }
}
