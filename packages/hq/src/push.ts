import { notificationTitle, productPreferences } from './i18n.ts';
// Web Push (VAPID) for "blocked on you" and for a worker's message to him (conversations.ts decides which ones
// may alert), and Telegram for when the app can't reach him (#204). Telegram goes only while the app is not
// connected (no live link, no device seen in timers.appSeenMs), once per item: a GO, a login or anything urgent,
// and a worker's `now` message that came with no live link (one per conversation until he reads it). A GO, login or urgent item he leaves
// untaken goes after a while even with the app connected. A blocking ask never does: it reaches the manager in 10
// minutes. A failed send is always visible (event + push_error).
// FCM (task 1474, fcm.ts) is the Android app's push: the same alerts at high priority, and a quiet "sync" at normal priority
// on every change the phone shows (an item taken, a conversation read elsewhere), as the socket event did. The phone acks each
// push; one it has not acked in fcmAckMs means FCM does not reach him, and Telegram goes as if the app were not connected.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import webpush from 'web-push';
import type { InboxItemDTO } from '@company/shared';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';
import type { Auth } from './auth.ts';
import { pushWorthy, type Inbox } from './inbox.ts';
import type { FcmMessage, FcmSend } from './fcm.ts';
import { FcmError } from './fcm.ts';

export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

export function loadOrCreateVapid(stateDir: string, subject: string): VapidKeys {
  const file = join(stateDir, 'vapid.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as VapidKeys;
  const k = webpush.generateVAPIDKeys();
  const keys: VapidKeys = { ...k, subject };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2) + '\n', { mode: 0o600 });
  return keys;
}

export interface PushSubscriptionJSON { endpoint: string; keys: { p256dh: string; auth: string } }

export type WebPushSend = (sub: PushSubscriptionJSON, payload: string) => Promise<unknown>;
export type TelegramSend = (text: string) => Promise<void>;

export function telegramVia(cmd: string, chat: string): TelegramSend {
  if (!chat) return async () => { throw new Error('telegram is not configured on this hq (telegramChat)'); };
  return (text) => new Promise((resolve, reject) => {
    execFile(cmd, ['-t', chat, '-m', text], { timeout: 30_000 }, (err, _out, stderr) => {
      if (err) reject(new Error(`telegram-send: ${(stderr || err.message).trim().slice(0, 300)}`));
      else resolve();
    });
  });
}

export class Pusher {
  private webSend: WebPushSend;
  private store: Store;
  private inbox: Inbox;
  private cfg: HqConfig;
  private vapid: VapidKeys;
  private telegram: TelegramSend;
  private auth: Auth;
  private fcm: FcmSend | null;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  /** The conversation's title for a Telegram line ("דנה · מנכ"לית לומו"); hq sets it. */
  titleOf: (identity: string) => string = (identity) => identity;
  constructor(store: Store, inbox: Inbox, auth: Auth, cfg: HqConfig, vapid: VapidKeys, telegram: TelegramSend, webSend?: WebPushSend, fcm: FcmSend | null = null) {
    this.store = store;
    this.inbox = inbox;
    this.auth = auth;
    this.cfg = cfg;
    this.vapid = vapid;
    this.telegram = telegram;
    this.fcm = fcm;
    this.webSend = webSend ?? ((sub, payload) => webpush.sendNotification(sub, payload, {
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey }, TTL: 3600, urgency: 'high',
    }));
  }

  get publicKey(): string { return this.vapid.publicKey; }

  subscribe(sub: PushSubscriptionJSON): void {
    if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('invalid subscription');
    this.store.db.prepare(`INSERT INTO push_subscriptions (endpoint, keys, created_at) VALUES (?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, failures = 0`).run(sub.endpoint, JSON.stringify(sub.keys), this.store.now());
  }

  unsubscribe(endpoint: string): void {
    this.store.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  // ── FCM tokens (the Android app, task 1474) ─────────────────────────────
  registerFcm(device: string, token: string): void {
    if (!token || token.length > 4096) throw new Error('invalid token');
    // A token moved to another device row (a re-pair on the same phone) is that device's now.
    this.store.db.prepare('DELETE FROM fcm_tokens WHERE token = ? AND device != ?').run(token, device);
    this.store.db.prepare(`INSERT INTO fcm_tokens (device, token, created_at) VALUES (?, ?, ?)
      ON CONFLICT(device) DO UPDATE SET token = excluded.token, failures = 0, pending_since = NULL,
        acked_at = CASE WHEN fcm_tokens.token = excluded.token THEN fcm_tokens.acked_at ELSE NULL END`).run(device, token, this.store.now());
  }

  unregisterFcm(device: string): void {
    this.store.db.prepare('DELETE FROM fcm_tokens WHERE device = ?').run(device);
  }

  /** The phone got a push (any): its token works, and nothing it was sent is owed any more. */
  ackFcm(device: string): void {
    this.store.db.prepare('UPDATE fcm_tokens SET acked_at = ?, pending_since = NULL WHERE device = ?').run(this.store.now(), device);
  }

  /** A phone FCM reaches: it acked a push once, and has not left a high-priority one unacked for fcmAckMs. */
  fcmReachable(): boolean {
    if (!this.fcm) return false;
    return this.store.db.prepare(`SELECT 1 FROM fcm_tokens WHERE acked_at IS NOT NULL AND (pending_since IS NULL OR pending_since > ?) LIMIT 1`)
      .get(this.store.now() - this.cfg.timers.fcmAckMs) != null;
  }

  private fcmTokens(): { device: string; token: string }[] {
    if (!this.fcm) return [];
    return this.store.db.prepare('SELECT device, token FROM fcm_tokens').all() as { device: string; token: string }[];
  }

  private async sendFcm(msg: FcmMessage): Promise<{ subs: number; delivered: number; errors: string[] }> {
    const tokens = this.fcmTokens();
    let delivered = 0;
    const errors: string[] = [];
    for (const t of tokens) {
      // A high push is owed an ack from the moment it is tried: a send that fails (a revoked key, FCM down, no route to
      // Google) must start the clock too, or a phone that acked once counts as reached forever. Before the send, so an
      // ack that beats Google's answer still clears it.
      if (msg.priority === 'high') this.store.db.prepare('UPDATE fcm_tokens SET pending_since = COALESCE(pending_since, ?) WHERE device = ?').run(this.store.now(), t.device);
      try {
        await this.fcm!(t.token, msg);
        delivered++;
        this.store.db.prepare('UPDATE fcm_tokens SET last_ok_at = ?, failures = 0 WHERE device = ?').run(this.store.now(), t.device);
      } catch (e) {
        errors.push(`fcm ${(e as Error).message}`);
        if (e instanceof FcmError && e.unregistered) this.unregisterFcm(t.device);
        else this.store.db.prepare('UPDATE fcm_tokens SET failures = failures + 1 WHERE device = ?').run(t.device);
      }
    }
    return { subs: tokens.length, delivered, errors };
  }

  /** Every change the phone shows (the events its socket refreshed on), coalesced into one quiet sync a second later. */
  static readonly SYNC_EVENTS = /^(inbox\.|ask\.|conv\.|toggle\.changed$|shift\.state$)/;
  onEvent(type: string): void {
    if (!this.fcm || !Pusher.SYNC_EVENTS.test(type) || this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      if (!this.fcmTokens().length) return;
      this.store.bg(this.sendFcm({ data: { type: 'sync' }, priority: 'normal', collapseKey: 'sync' }).then(() => undefined), 'push.sync');
    }, 1000);
    this.syncTimer.unref?.();
  }

  stop(): void {
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.syncTimer = null;
  }

  /** Called for every new inbox item; decides whether it is allowed to interrupt him. */
  private notifying = new Set<number>();
  async notify(item: InboxItemDTO): Promise<void> {
    if (!this.store.toggle('push')) return;
    if (!pushWorthy(item, this.store.toggle('focus'), this.inbox.manager, this.store.toggle('night'))) return;
    if (this.notifying.has(item.id)) return;
    this.notifying.add(item.id);
    try {
      const title = notificationTitle(item, productPreferences(this.cfg.companyDir).owner_language);
      const payload = JSON.stringify({ id: item.id, kind: item.kind, title, body: item.body.slice(0, 300), url: `/?inbox=${item.id}` });
      const { subs, delivered, errors } = this.merge(await this.sendAll(payload),
        await this.sendFcm({ data: { type: 'inbox', id: String(item.id), kind: item.kind }, priority: 'high' }));
      this.inbox.markPushed(item.id, subs && !delivered ? errors.join('; ') : null);
      if (subs) this.store.emit(delivered ? 'push.sent' : 'push.failed', item.from_identity, { inbox: item.id, delivered, errors });
      await this.sweepItems(item.id);
    } finally { this.notifying.delete(item.id); }
  }

  /** A worker's message that may alert him: "דנה · מנכ"לית לומו" and its first lines; a tap opens the conversation. */
  async notifyMessage(m: { identity: string; title: string; body: string; message: string; priority?: string; level?: 'sound' | 'silent' }): Promise<void> {
    if (m.priority === 'now' && !this.auth.linked()) {
      // With a live link the app has shown it already. Without one: owed until he reads it, sent once the app counts
      // as gone (seen lately = not yet), one per conversation until he reads it.
      this.store.db.prepare(`UPDATE conversations SET telegram_owed = ? WHERE identity = ? AND (telegram_at IS NULL OR telegram_at <= read_at)`)
        .run(m.message, m.identity);
    }
    const subs = (this.store.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n;
    const web = subs ? await this.sendAll(JSON.stringify({ kind: 'message', identity: m.identity, message: m.message, title: m.title, body: m.body,
      silent: m.level === 'silent', tag: `chat-${m.identity}`, url: `/?chat=${encodeURIComponent(m.identity)}` })) : { subs: 0, delivered: 0, errors: [] };
    // A silent one is still a notification on the phone, so it goes high too: normal may wait out Doze for hours.
    const fcm = await this.sendFcm({ data: { type: 'message', identity: m.identity, message: m.message }, priority: 'high' });
    const { delivered, errors } = this.merge(web, fcm);
    if ((web.subs || fcm.subs) && !delivered) this.store.emit('push.failed', m.identity, { message: m.message, delivered, errors });
    await this.sweepMessages();
  }

  private merge(a: { subs: number; delivered: number; errors: string[] }, b: { subs: number; delivered: number; errors: string[] }) {
    return { subs: a.subs + b.subs, delivered: a.delivered + b.delivered, errors: [...a.errors, ...b.errors] };
  }

  private async sendAll(payload: string): Promise<{ subs: number; delivered: number; errors: string[] }> {
    const subs = this.store.db.prepare('SELECT endpoint, keys FROM push_subscriptions').all() as { endpoint: string; keys: string }[];
    let delivered = 0;
    const errors: string[] = [];
    for (const s of subs) {
      try {
        await this.webSend({ endpoint: s.endpoint, keys: JSON.parse(s.keys) as PushSubscriptionJSON['keys'] }, payload);
        delivered++;
        this.store.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE endpoint = ?').run(this.store.now(), s.endpoint);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        errors.push(`${status ?? ''} ${(e as Error).message}`.trim());
        if (status === 404 || status === 410) this.unsubscribe(s.endpoint);
        else this.store.db.prepare('UPDATE push_subscriptions SET failures = failures + 1 WHERE endpoint = ?').run(s.endpoint);
      }
    }
    return { subs: subs.length, delivered, errors };
  }

  /** He can't be reached in the app: no live link, no device seen lately, and no phone FCM reaches. */
  private offline(): boolean { return !this.auth.appOnline(this.cfg.timers.appSeenMs) && !this.fcmReachable(); }

  /** Sweep (every 30 s): whatever Telegram is owed now, items and messages (#204). */
  async sweepUnacked(): Promise<void> {
    // Quiet modes leave the item in the inbox. Once they end, an unhandled item gets its first push.
    for (const item of this.inbox.mine()) if (item.pushed_at == null && item.acked_at == null && item.snoozed_at == null) await this.notify(item);
    await this.sweepItems();
    await this.sweepMessages();
  }

  private async sweepItems(id?: number): Promise<void> {
    const offline = this.offline();
    const T = this.cfg.timers;
    for (const item of this.inbox.owedTelegram({ offline, urgentMs: T.pushAckTimeoutMs, ms: T.telegramAfterMs, id })) {
      if (!this.store.toggle('push') || !pushWorthy(item, this.store.toggle('focus'), this.inbox.manager, this.store.toggle('night'))) continue;
      await this.toTelegram(item, offline ? 'האפליקציה לא מחוברת' : `לא נענה תוך ${Math.round((item.urgency === 'urgent' ? T.pushAckTimeoutMs : T.telegramAfterMs) / 60_000)} דקות`);
    }
  }

  private async sweepMessages(): Promise<void> {
    const rows = this.store.db.prepare(`SELECT c.identity, c.read_at, c.muted_until, m.id, m.body, m.created_at FROM conversations c
      LEFT JOIN messages m ON m.id = c.telegram_owed WHERE c.telegram_owed IS NOT NULL`).all() as
      { identity: string; read_at: number; muted_until: number | null; id: string | null; body: string | null; created_at: number | null }[];
    if (!rows.length) return;
    const now = this.store.now();
    // telegram_owed is set only by urgency now, which bypasses focus and night.
    const quiet = !this.store.toggle('push');
    const clear = this.store.db.prepare('UPDATE conversations SET telegram_owed = NULL WHERE identity = ?');
    const offline = this.offline();
    for (const r of rows) {
      // Read already, muted since, or alerts are off now: nothing is owed any more.
      if (r.id == null || r.created_at! <= r.read_at || (r.muted_until != null && r.muted_until > now) || quiet) { clear.run(r.identity); continue; }
      if (!offline) continue; // seen lately: owed until he reads it or the app counts as gone
      // Taken before sending, so a sweep and a new message never both send it, and a `now` arriving meanwhile is not
      // owed (telegram_at is past read_at).
      const prev = this.store.db.prepare('SELECT telegram_at FROM conversations WHERE identity = ?').pluck().get(r.identity) as number | null;
      if (!this.store.db.prepare('UPDATE conversations SET telegram_owed = NULL, telegram_at = ? WHERE identity = ? AND telegram_owed = ?')
        .run(this.store.now(), r.identity, r.id).changes) continue;
      try {
        await this.telegram(`${this.titleOf(r.identity)}\n${r.body!.slice(0, 1500)}\n(האפליקציה לא מחוברת)`);
        this.store.emit('push.telegram', r.identity, { message: r.id });
      } catch (e) {
        this.store.db.prepare('UPDATE conversations SET telegram_at = ? WHERE identity = ?').run(prev, r.identity);
        this.store.emit('push.telegram_failed', r.identity, { message: r.id, error: (e as Error).message });
      }
    }
  }

  private async toTelegram(item: InboxItemDTO, why: string): Promise<void> {
    const link = item.link ? `\n${item.link}` : '';
    const text = `⏸ ${item.headline ?? item.title}\n${item.body.slice(0, 1500)}${link}\n(${why})`;
    if (!this.inbox.claimTelegram(item.id)) return; // another sweep took it
    try {
      await this.telegram(text);
      this.store.emit('push.telegram', item.from_identity, { inbox: item.id });
    } catch (e) {
      this.inbox.markTelegramFailed(item.id, (e as Error).message);
      this.store.emit('push.telegram_failed', item.from_identity, { inbox: item.id, error: (e as Error).message });
    }
  }
}
