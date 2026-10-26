// Passkeys the server can answer itself. A site's "Use passkey" opens Chrome's own dialog, outside the page: the phone
// view (a page screencast) never shows it and cannot tap it, and on this box nobody sits at the screen (26/10, Mercury:
// he saw the page and could not get past it). So every tab in the shared Chrome gets a CDP virtual authenticator that
// answers at once, with no dialog: a passkey registered once on a site (from a signed-in session) signs in there from
// then on, with no phone. The keys live in a 0600 file under hq's state dir and are put back on every tab, also after
// Chrome or hq restarted. A virtual authenticator exists only while the session that added it is attached, which is
// why this is a long-lived connection of its own and not something done once at Chrome's start.
// Security (said once, as asked): anyone with access to this server can sign in to the sites registered here.
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { Cdp } from './cdp.ts';

/** CDP's WebAuthn.Credential, as stored. privateKey is base64 PKCS#8. */
export interface StoredPasskey {
  credentialId: string; rpId: string; privateKey: string; userHandle?: string; signCount: number;
  isResidentCredential: boolean; userName?: string; addedAt: number;
}

/** What the vault needs from Chrome. Cdp is the real one; tests inject a fake. */
export interface PasskeyCdp {
  send(method: string, params?: object, sessionId?: string): Promise<any>;
  attach(targetId: string, listener: (method: string, params: any) => void): Promise<string>;
  pages(): Promise<{ targetId: string; url: string }[]>;
  onTargetCreated: (targetId: string) => void;
  onTargetGone: (targetId: string) => void;
  onDisconnect: () => void;
  onConnect: () => void;
  close(): void;
}

const AUTHENTICATOR = {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true,
  automaticPresenceSimulation: true,
};

export class PasskeyVault {
  private cdp: PasskeyCdp;
  private file: string;
  private log: (msg: string, data?: unknown) => void;
  /** targetId → its session and authenticator. */
  private tabs = new Map<string, Tab>();
  /** Covers in flight, so a second caller waits for the same one. */
  private attaching = new Map<string, Promise<void>>();
  private keys: StoredPasskey[];
  /** `authenticatorId credentialId` we are removing ourselves: Chrome reports those as deleted too. */
  private ourRemovals = new Set<string>();
  private stopped = false;

  constructor(file: string, cdp: PasskeyCdp | string, log: (msg: string, data?: unknown) => void = () => {}) {
    this.file = file;
    this.cdp = typeof cdp === 'string' ? new Cdp(cdp) : cdp;
    this.log = log;
    this.keys = this.load();
    this.cdp.onTargetCreated = (id) => { void this.cover(id); };
    this.cdp.onTargetGone = (id) => { this.tabs.delete(id); this.attaching.delete(id); };
    this.cdp.onDisconnect = () => { this.tabs.clear(); this.attaching.clear(); };
    // After Chrome (or the connection) came back, every tab is uncovered again.
    this.cdp.onConnect = () => { if (!this.stopped) void this.coverAll(); };
  }

  get passkeys(): readonly StoredPasskey[] { return this.keys; }
  get covered(): number { return this.tabs.size; }

  /** Cover every open tab; new ones are covered as they appear. Retried by the caller's timer when Chrome is down. */
  async coverAll(): Promise<void> {
    let pages: { targetId: string }[];
    try { pages = await this.cdp.pages(); } catch { return; } // Chrome down: onConnect brings us back
    await Promise.all(pages.map((p) => this.cover(p.targetId)));
  }

  private cover(targetId: string): Promise<void> {
    if (this.stopped || this.tabs.has(targetId)) return Promise.resolve();
    const inFlight = this.attaching.get(targetId);
    if (inFlight) return inFlight;
    const run = this.coverNow(targetId);
    this.attaching.set(targetId, run);
    return run;
  }

  private async coverNow(targetId: string): Promise<void> {
    try {
      if (this.stopped) return; // close() must not open the connection again
      const sessionId = await this.cdp.attach(targetId, (m, p) => this.onEvent(m, p));
      await this.cdp.send('WebAuthn.enable', { enableUI: false }, sessionId);
      const { authenticatorId } = await this.cdp.send('WebAuthn.addVirtualAuthenticator', { options: AUTHENTICATOR }, sessionId);
      const given = new Map<string, number>();
      for (const k of this.keys) { given.set(k.credentialId, k.signCount); await this.put(sessionId, authenticatorId, k); }
      // Not if the tab closed or the connection dropped meanwhile (both forget the cover in flight).
      if (!this.attaching.has(targetId)) return;
      const tab = { sessionId, authenticatorId };
      this.tabs.set(targetId, tab);
      // What was registered, used or deleted elsewhere while this tab was being set up.
      for (const k of this.keys) {
        if (!given.has(k.credentialId)) void this.put(sessionId, authenticatorId, k);
        else if (given.get(k.credentialId)! < k.signCount) void this.replace(tab, k);
      }
      for (const id of given.keys()) if (!this.keys.some((k) => k.credentialId === id)) void this.remove(tab, id);
    } catch (e) {
      // A tab that closed meanwhile: nothing to cover.
      this.log('passkeys: not covered', { targetId, error: String(e).slice(0, 120) });
    } finally {
      this.attaching.delete(targetId);
    }
  }

  private put(sessionId: string, authenticatorId: string, k: StoredPasskey): Promise<unknown> {
    const { addedAt: _added, userName: _name, ...credential } = k;
    return this.cdp.send('WebAuthn.addCredential', { authenticatorId, credential }, sessionId)
      .catch((e) => this.log('passkeys: addCredential', { rpId: k.rpId, error: String(e).slice(0, 120) }));
  }

  private async remove(t: Tab, credentialId: string): Promise<void> {
    const mark = `${t.authenticatorId} ${credentialId}`;
    this.ourRemovals.add(mark);
    try {
      await this.cdp.send('WebAuthn.removeCredential', { authenticatorId: t.authenticatorId, credentialId }, t.sessionId);
    } catch { /* tab gone */ }
    // Its event arrives before the reply on the same connection; let it be read first, then forget the mark.
    setImmediate(() => this.ourRemovals.delete(mark));
  }

  /** The same key with its current counter: a site may refuse a counter that goes back, as a cloned authenticator. */
  private async replace(t: Tab, k: StoredPasskey): Promise<void> {
    await this.remove(t, k.credentialId);
    await this.put(t.sessionId, t.authenticatorId, k);
  }

  private others(fromAuthenticator: string | undefined): Tab[] {
    return [...this.tabs.values()].filter((t) => t.authenticatorId !== fromAuthenticator);
  }

  private onEvent(method: string, p: any): void {
    if (method === 'WebAuthn.credentialAdded') this.added(p.authenticatorId, p.credential);
    else if (method === 'WebAuthn.credentialAsserted' || method === 'WebAuthn.credentialUpdated') this.used(p.authenticatorId, p.credential);
    else if (method === 'WebAuthn.credentialDeleted') this.deleted(p.authenticatorId, p.credentialId);
  }

  /** A site registered a passkey in one tab: keep it, and give it to every other tab. */
  private added(fromAuthenticator: string, c: any): void {
    if (!c?.credentialId || !c.privateKey || !c.rpId) return;
    if (this.keys.some((k) => k.credentialId === c.credentialId)) return;
    const k: StoredPasskey = {
      credentialId: c.credentialId, rpId: c.rpId, privateKey: c.privateKey, userHandle: c.userHandle,
      signCount: c.signCount ?? 0, isResidentCredential: c.isResidentCredential ?? true, userName: c.userName, addedAt: Date.now(),
    };
    this.keys.push(k);
    this.save();
    this.log('passkeys: registered', { rpId: k.rpId, user: k.userName ?? null });
    for (const t of this.others(fromAuthenticator)) void this.put(t.sessionId, t.authenticatorId, k);
  }

  /** A sign-in moved the counter in one tab: every other tab gets the new count. */
  private used(fromAuthenticator: string, c: any): void {
    const k = this.keys.find((x) => x.credentialId === c?.credentialId);
    if (!k || typeof c.signCount !== 'number' || c.signCount <= k.signCount) return;
    k.signCount = c.signCount;
    this.save();
    for (const t of this.others(fromAuthenticator)) void this.replace(t, k);
  }

  private deleted(fromAuthenticator: string, credentialId: string): void {
    if (this.ourRemovals.has(`${fromAuthenticator} ${credentialId}`)) return; // replace() at work, not the site
    const before = this.keys.length;
    this.keys = this.keys.filter((k) => k.credentialId !== credentialId);
    if (this.keys.length === before) return; // one we never kept
    this.save();
    for (const t of this.others(fromAuthenticator)) void this.remove(t, credentialId);
  }

  private load(): StoredPasskey[] {
    if (!existsSync(this.file)) return [];
    try { return (JSON.parse(readFileSync(this.file, 'utf8')) as { passkeys?: StoredPasskey[] }).passkeys ?? []; } catch (e) {
      // Kept aside, never overwritten by the next save: these are the only copies of the keys.
      const aside = `${this.file}.unreadable-${Date.now()}`;
      try { renameSync(this.file, aside); } catch { /* left in place; save() still writes a new file over a copy-less one */ }
      this.log('passkeys: unreadable file, kept aside and starting empty', { aside, error: String(e).slice(0, 120) });
      return [];
    }
  }

  /** Never throws: it runs inside a CDP event, and a full disk must not take hq down. */
  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = openSync(tmp, 'w', 0o600);
      try { writeSync(fd, JSON.stringify({ passkeys: this.keys }, null, 2) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch (e) {
      this.log('passkeys: could not save', String(e).slice(0, 160));
    }
  }

  close(): void {
    this.stopped = true;
    this.cdp.close();
  }
}

type Tab = { sessionId: string; authenticatorId: string };
