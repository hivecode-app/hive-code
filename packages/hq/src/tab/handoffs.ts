// Tab handoff (B.9): a worker's `browser_ask_user` needs the owner on a site (a login, a code, a CAPTCHA).
// hq issues a one-time 192-bit link to that worker's own tab, puts it in "מחכה לך" (kind `login`, which
// pushes), and the phone page drives the tab. "סיימתי" (on the phone or in the app) wakes the requester at
// once: its waiting tool call returns, or, when nothing is waiting, a `now` message through its mailbox.
// One live login per site (a short lock), so two workers never trigger two SMS codes.
import { g, pre } from '@company/shared';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Store } from '../store.ts';
import type { Inbox } from '../inbox.ts';
import type { Mailbox } from '../mailbox.ts';
import type { PhoneEnd, TabBrowser } from './browser.ts';
import { getIdentity } from '../org.ts';

export interface TabConfig {
  /** Public listener for the phone page only (/h/<token>, /ws/<token>), behind Caddy. null = off. */
  listen: string | null;
  baseUrl: string;
  cdpUrl: string;
  ttlMin: number;
}

export type HandoffState = 'live' | 'done' | 'expired' | 'closed' | 'cancelled';

export interface HandoffRow {
  id: string; token_hash: string; from_identity: string | null; inbox_id: number | null; target_id: string;
  own_window: number; url: string; domain: string; what: string; need: string | null; state: HandoffState;
  bound_hash: string | null; viewed: number; final_url: string | null; created_at: number; expires_at: number;
  ended_at: number | null; ended_by: string | null;
}

/** What a worker sees about its handoff. Never the token: the link is only returned once, at creation. */
export interface HandoffView {
  id: string; state: HandoffState; domain: string; from: string | null; expires_at: number;
  final_url: string | null; ended_by: string | null;
}

export class HandoffError extends Error {
  status: number;
  busy?: HandoffView;
  constructor(status: number, message: string, busy?: HandoffView) { super(message); this.status = status; this.busy = busy; }
}

export interface NewHandoff {
  from: string | null;
  /** The worker's own tab (browser-memory tabs.json). Without it hq opens a window of its own at `url`. */
  target?: string;
  url?: string;
  what?: string;
  need?: string;
  ttlMin?: number;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const sameHash = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The site a login belongs to: accounts.google.com and mail.google.com share one SMS code. */
export function siteOf(url: string): string {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return ''; }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const parts = host.split('.');
  // co.il, gov.il, ac.uk, com.au…: the registrable name is one label longer.
  const n = parts.length >= 3 && parts.at(-1)!.length === 2 && /^(co|com|org|net|gov|ac|edu|muni)$/.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export class TabHandoffs {
  private store: Store;
  private inbox: Inbox;
  private mailbox: Mailbox;
  private cfg: TabConfig;
  readonly browser: TabBrowser;
  private waiters = new Map<string, Set<(v: HandoffView) => void>>();

  constructor(store: Store, inbox: Inbox, mailbox: Mailbox, cfg: TabConfig, browser: TabBrowser) {
    this.store = store;
    this.inbox = inbox;
    this.mailbox = mailbox;
    this.cfg = cfg;
    this.browser = browser;
    browser.onTargetGone = (targetId) => {
      for (const r of this.live().filter((x) => x.target_id === targetId)) this.end(r.id, 'closed', 'tab-closed');
    };
    // After Chrome restarted (or hq did), a live handoff whose tab is gone ends now, not at its expiry.
    browser.onConnected = () => this.store.bg(this.dropVanished(), 'tab.dropVanished');
  }

  private async dropVanished(): Promise<void> {
    for (const r of this.live()) if (!(await this.browser.hasTarget(r.target_id))) this.end(r.id, 'closed', 'tab-gone');
  }

  /** The login lock: a live handoff on this site, if any. */
  private holderOf(domain: string): HandoffRow | undefined {
    const now = this.store.now();
    return domain ? this.live().find((r) => r.domain === domain && r.expires_at > now) : undefined;
  }

  private busy(holder: HandoffRow, from: string | null): HandoffError {
    // Not a second link even for the same worker: the first one may already be open on his phone.
    return new HandoffError(409, holder.from_identity === from
      ? `you already have a live handoff for ${holder.domain}`
      : `${holder.from_identity ?? 'someone'} is already signing in to ${holder.domain}`, this.view(holder));
  }

  private row(id: string): HandoffRow | undefined {
    return this.store.db.prepare('SELECT * FROM tab_handoffs WHERE id = ?').get(id) as HandoffRow | undefined;
  }

  private live(): HandoffRow[] {
    return this.store.db.prepare(`SELECT * FROM tab_handoffs WHERE state = 'live'`).all() as HandoffRow[];
  }

  /** What the phone page shows for a handoff that ended (phone.html). */
  static phoneEnd(state: HandoffState): PhoneEnd {
    return state === 'done' || state === 'live' ? 'finished' : state;
  }

  view(r: HandoffRow): HandoffView {
    return { id: r.id, state: r.state, domain: r.domain, from: r.from_identity, expires_at: r.expires_at, final_url: r.final_url, ended_by: r.ended_by };
  }

  get(id: string): HandoffView | undefined {
    const r = this.row(id);
    return r ? this.view(r) : undefined;
  }

  async create(n: NewHandoff): Promise<{ handoff: HandoffView; link: string; inbox_id: number | null }> {
    if (!n.target && !n.url) throw new HandoffError(400, 'target or url is required');
    if (n.url && !/^https?:\/\//.test(n.url)) throw new HandoffError(400, 'url must be http(s)');
    const now = this.store.now();
    const ttl = Math.min(240, Math.max(1, Number(n.ttlMin) || this.cfg.ttlMin)) * 60_000;
    const url = n.url ?? '';
    const domain = siteOf(url);
    // The login lock: one live handoff per site, checked before any await and again right before the
    // insert (the awaits in between are where a second request for the same site could slip in).
    const early = this.holderOf(domain);
    if (early) throw this.busy(early, n.from);
    let target = n.target && (await this.browser.hasTarget(n.target)) ? n.target : null;
    let ownWindow = 0;
    if (!target) {
      if (!url) throw new HandoffError(400, `tab ${n.target} is not open and no url was given`);
      target = await this.browser.openWindow(url);
      ownWindow = 1;
    }
    const late = this.holderOf(domain);
    if (late) {
      if (ownWindow) await this.browser.closeTarget(target).catch(() => {});
      throw this.busy(late, n.from);
    }
    const id = `h-${randomBytes(4).toString('hex')}`;
    const token = randomBytes(24).toString('base64url'); // 192 bit
    const link = `${this.cfg.baseUrl.replace(/\/$/, '')}/h/${token}`;
    this.store.db.prepare(`INSERT INTO tab_handoffs (id, token_hash, from_identity, target_id, own_window, url, domain, what, need, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sha(token), n.from, target, ownWindow, url, domain, n.what ?? '', n.need ?? null, now, now + ttl);
    // Title is the site: the app shows it as the domain chip (APP-SPEC §9.1).
    const item = this.inbox.add({
      kind: 'login', title: domain || 'כניסה לאתר', body: n.what ?? '', from_identity: n.from, blocking: true,
      ref: `handoff:${id}`, link, dedupe_key: `handoff:${id}`,
    });
    this.store.db.prepare('UPDATE tab_handoffs SET inbox_id = ? WHERE id = ?').run(item.id, id);
    this.store.emit('tab.handoff', n.from, { id, domain, inbox: item.id, own_window: !!ownWindow, expires_at: now + ttl });
    return { handoff: this.get(id)!, link, inbox_id: item.id };
  }

  /** The live handoff behind a link, or why there is none. */
  byToken(token: string): { row?: HandoffRow; gone: boolean } {
    const r = this.store.db.prepare('SELECT * FROM tab_handoffs WHERE token_hash = ?').get(sha(token)) as HandoffRow | undefined;
    if (!r || r.state !== 'live' || r.expires_at <= this.store.now()) return { row: r, gone: true };
    return { row: r, gone: false };
  }

  /** One-time: the first device that opens the link owns it (reloads from it keep working). */
  bind(r: HandoffRow): string {
    const key = randomBytes(18).toString('base64url');
    const ok = this.store.db.prepare('UPDATE tab_handoffs SET bound_hash = ? WHERE id = ? AND bound_hash IS NULL').run(sha(key), r.id);
    if (!ok.changes) throw new HandoffError(403, 'already bound');
    this.store.emit('tab.opened', r.from_identity, { id: r.id });
    return key;
  }

  isBoundTo(r: HandoffRow, key: string | undefined): boolean {
    return !!key && !!r.bound_hash && sameHash(r.bound_hash, sha(key));
  }

  markViewed(id: string): void {
    this.store.db.prepare('UPDATE tab_handoffs SET viewed = 1 WHERE id = ?').run(id);
  }

  noteUrl(id: string, url: string): void {
    if (url) this.store.db.prepare(`UPDATE tab_handoffs SET final_url = ? WHERE id = ? AND state = 'live'`).run(url, id);
  }

  /**
   * Long-poll: resolves when the handoff ends, or with its current state after `ms`. `signal` = the caller
   * went away (its HTTP request closed): it is no longer a waiter, so "סיימתי" falls back to mail.
   */
  wait(id: string, ms: number, signal?: AbortSignal): Promise<HandoffView | undefined> {
    const r = this.row(id);
    if (!r || r.state !== 'live') return Promise.resolve(r ? this.view(r) : undefined);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const done = (v: HandoffView) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', gone);
        set.delete(done);
        if (!set.size) this.waiters.delete(id);
        resolve(v);
      };
      const gone = () => done(this.get(id)!);
      const timer = setTimeout(gone, Math.max(0, Math.min(ms, 60_000)));
      set.add(done);
      signal?.addEventListener('abort', gone, { once: true });
      if (signal?.aborted) gone();
    });
  }

  /**
   * Ends a handoff once. `done` = he finished (phone "סיימתי", the app, or the worker's page watcher saw it).
   * A waiting tool call is the wake-up; with nothing waiting, the requester gets a `now` message instead.
   */
  end(id: string, state: Exclude<HandoffState, 'live'>, by: string, finalUrl?: string, closer?: string): HandoffView | undefined {
    const now = this.store.now();
    const r = this.row(id);
    if (!r) return undefined;
    const changed = this.store.db.prepare(`UPDATE tab_handoffs SET state = ?, ended_at = ?, ended_by = ?, final_url = COALESCE(?, final_url)
      WHERE id = ? AND state = 'live'`).run(state, now, by, finalUrl || null, id).changes;
    if (!changed) return this.get(id);
    const v = this.get(id)!;
    // The worker hears it first; Chrome is cleaned up after, in the background (a slow or hung Chrome must
    // never delay "סיימתי" or the expiry sweep).
    const waiting = this.waiters.get(id);
    if (r.inbox_id != null) {
      // The link is spent: it does not stay in the store once it can no longer open anything.
      this.store.db.prepare('UPDATE inbox SET link = NULL WHERE id = ?').run(r.inbox_id);
      // The worker closing its own tab is the one ending it already knows about.
      const ownDoing = by === 'worker' || (state === 'closed' && by === 'tab-closed' && !r.own_window);
      if (!waiting?.size && !ownDoing) this.mailRequester(r, v, closer);
      else this.inbox.resolve(r.inbox_id, state === 'done' ? 'resolved' : 'dismissed');
    }
    for (const w of [...(waiting ?? [])]) w(v);
    this.store.emit('tab.ended', r.from_identity, { id, state, by, domain: r.domain });
    const tell = TabHandoffs.phoneEnd(state);
    this.store.bg((async () => {
      try { await this.browser.release(r.target_id, tell); } catch { /* Chrome gone: nothing left on the tab */ }
      this.store.db.prepare('UPDATE tab_handoffs SET viewed = 0 WHERE id = ?').run(id);
      if (r.own_window && state !== 'closed') await this.browser.closeTarget(r.target_id);
    })(), 'tab.release');
    return v;
  }

  /**
   * Nobody is blocked in browser_ask_user any more (its wait timed out, and it told the worker a message
   * would come): every ending he caused, or the clock did, reaches the worker by mail.
   */
  private mailRequester(r: HandoffRow, v: HandoffView, closer?: string): void {
    const itemId = r.inbox_id!;
    if (v.state === 'done') {
      this.mailbox.complete(itemId, { note: v.final_url ? `הדף עכשיו: ${v.final_url}` : undefined, by: closer });
    } else if (v.state === 'cancelled') {
      this.mailbox.complete(itemId, { declined: true, by: closer });
    } else {
      this.inbox.resolve(itemId, 'dismissed');
      if (!r.from_identity || !getIdentity(this.store, r.from_identity)) return;
      const o = this.mailbox.names.owner;
      const what = v.state === 'expired' ? `פג בלי ${pre('ש', o.name)} ${g(o, 'נכנס', 'נכנסה')}` : 'נסגר, כי הטאב כבר לא פתוח';
      this.mailbox.tell({
        msg_id: `handoff-${r.id}-${v.state}`, from: 'hq', to: r.from_identity, kind: 'system', ref: `inbox-${itemId}`, priority: 'next',
        body: `הקישור לכניסה ל-${r.domain || 'האתר'} ${what}. אם עדיין צריך, קרא שוב ל-browser_ask_user.`,
      });
    }
  }

  /** "סיימתי" / "לא עכשיו" in the app on the handoff's inbox item. True if the item was a handoff. */
  async fromInbox(itemId: number, declined: boolean, closer?: string): Promise<boolean> {
    const r = this.store.db.prepare(`SELECT * FROM tab_handoffs WHERE inbox_id = ?`).get(itemId) as HandoffRow | undefined;
    if (!r) return false;
    if (r.state === 'live') this.end(r.id, declined ? 'cancelled' : 'done', declined ? 'owner-declined' : 'app', undefined, closer);
    return true;
  }

  async sweep(): Promise<void> {
    const now = this.store.now();
    for (const r of this.live()) if (r.expires_at <= now) this.end(r.id, 'expired', 'ttl');
  }

  /** After a restart no view is attached, but a phone viewport can still sit on a tab (it survives the socket). */
  async clearStale(): Promise<void> {
    const rows = this.store.db.prepare('SELECT id, target_id FROM tab_handoffs WHERE viewed = 1').all() as { id: string; target_id: string }[];
    if (!rows.length) return;
    await this.browser.clearStale(rows.map((r) => r.target_id));
    this.store.db.prepare(`UPDATE tab_handoffs SET viewed = 0 WHERE viewed = 1 AND state != 'live'`).run();
  }
}
