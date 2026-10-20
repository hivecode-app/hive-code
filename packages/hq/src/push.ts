// Web Push (VAPID) for "blocked on you", with Telegram as fallback (B.8), and for a worker's message to him
// (conversations.ts decides which ones may alert). Fallback fires when there is no subscription, when every push
// fails, or when an urgent push is not acknowledged within pushAckTimeoutMs. A failed send is always visible
// (event + push_error). Messages have no Telegram fallback: the phone gets them over its link (conv.alert).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import webpush from 'web-push';
import type { InboxItemDTO } from '@company/shared';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';
import { pushWorthy, type Inbox } from './inbox.ts';

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
  constructor(store: Store, inbox: Inbox, cfg: HqConfig, vapid: VapidKeys, telegram: TelegramSend, webSend?: WebPushSend) {
    this.store = store;
    this.inbox = inbox;
    this.cfg = cfg;
    this.vapid = vapid;
    this.telegram = telegram;
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

  /** Called for every new inbox item; decides whether it is allowed to interrupt him. */
  async notify(item: InboxItemDTO): Promise<void> {
    if (!this.store.toggle('push')) return;
    if (!pushWorthy(item, this.store.toggle('focus'))) return;
    const payload = JSON.stringify({ id: item.id, kind: item.kind, title: item.title, body: item.body.slice(0, 300), url: `/?inbox=${item.id}` });
    const { delivered, errors } = await this.sendAll(payload);
    const err = delivered ? null : (errors.join('; ') || 'no push subscription');
    this.inbox.markPushed(item.id, err);
    this.store.emit(delivered ? 'push.sent' : 'push.failed', item.from_identity, { inbox: item.id, delivered, errors });
    if (!delivered) await this.toTelegram(item, 'push לא נמסר');
  }

  /** A worker's message that may alert him: "דנה · מנכ"לית לומו" and its first lines; a tap opens the conversation. */
  async notifyMessage(m: { identity: string; title: string; body: string; message: string }): Promise<void> {
    const subs = (this.store.db.prepare('SELECT COUNT(*) n FROM push_subscriptions').get() as { n: number }).n;
    if (!subs) return; // no browser subscribed: the phone has it over its link, nothing failed
    const payload = JSON.stringify({ kind: 'message', identity: m.identity, message: m.message, title: m.title, body: m.body,
      tag: `chat-${m.identity}`, url: `/?chat=${encodeURIComponent(m.identity)}` });
    const { delivered, errors } = await this.sendAll(payload);
    if (!delivered) this.store.emit('push.failed', m.identity, { message: m.message, delivered, errors });
  }

  private async sendAll(payload: string): Promise<{ delivered: number; errors: string[] }> {
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
    return { delivered, errors };
  }

  /** Sweep: pushed but not acknowledged within the window → Telegram as well (B.8). */
  async sweepUnacked(): Promise<void> {
    for (const item of this.inbox.owedTelegram(this.cfg.timers.pushAckTimeoutMs)) {
      await this.toTelegram(item, item.urgency === 'urgent' ? 'לא אושר תוך 5 דקות' : 'push לא נמסר');
    }
  }

  private async toTelegram(item: InboxItemDTO, why: string): Promise<void> {
    const link = item.link ? `\n${item.link}` : '';
    const text = `⏸ ${item.title}\n${item.body.slice(0, 1500)}${link}\n(${why} · inbox #${item.id})`;
    try {
      await this.telegram(text);
      this.inbox.markTelegram(item.id, null);
      this.store.emit('push.telegram', item.from_identity, { inbox: item.id });
    } catch (e) {
      this.inbox.markTelegram(item.id, (e as Error).message);
      this.store.emit('push.telegram_failed', item.from_identity, { inbox: item.id, error: (e as Error).message });
    }
  }
}
