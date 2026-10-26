// Minimal CDP client over the shared Chrome's browser websocket (flattened sessions). Ported from the bet6
// spike. Unlike the spike it never exits the process: a dropped connection is reopened on the next call,
// and every session that lived on it is reported gone so its owner re-attaches.
import { WebSocket } from 'ws';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
export type SessionListener = (method: string, params: any) => void;

export class Cdp {
  private ws: WebSocket | null = null;
  private connecting: Promise<WebSocket> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private sessions = new Map<string, SessionListener>();
  private httpUrl: string;
  /** After close(): no call reopens the connection (a cover in flight would keep hq, or a test, alive). */
  private closed = false;
  /** A new page target appeared (a tab or window opened). */
  onTargetCreated: (targetId: string) => void = () => {};
  /** A page target closed or detached (the agent closed its tab, Chrome restarted). */
  onTargetGone: (targetId: string) => void = () => {};
  /** The browser connection dropped: every session id is now invalid. */
  onDisconnect: () => void = () => {};
  /** Called after each (re)connect, once the connection is usable (not awaited). */
  onConnect: () => void = () => {};

  constructor(httpUrl: string) { this.httpUrl = httpUrl; }

  get connected(): boolean { return this.ws?.readyState === WebSocket.OPEN; }

  private connect(): Promise<WebSocket> {
    if (this.closed) return Promise.reject(new Error('CDP client closed'));
    if (this.connected) return Promise.resolve(this.ws!);
    this.connecting ??= (async () => {
      const ver = await (await fetch(`${this.httpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })).json() as { webSocketDebuggerUrl: string };
      // A Chrome that accepts the connection and never answers must not hang every caller (machines.md, 21/09).
      const ws = new WebSocket(ver.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024, handshakeTimeout: 5000 });
      await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
      if (this.closed) { ws.close(); throw new Error('CDP client closed'); }
      ws.on('message', (raw) => this.onMessage(raw.toString()));
      ws.on('close', () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.sessions.clear();
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('CDP connection closed')); this.pending.delete(id); }
        this.onDisconnect();
      });
      ws.on('error', () => {});
      this.ws = ws;
      await this.raw('Target.setDiscoverTargets', { discover: true });
      return ws;
    })().then((ws) => { setImmediate(() => this.onConnect()); return ws; }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private onMessage(text: string): void {
    const msg = JSON.parse(text);
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${msg.error.message} ${msg.error.data ?? ''}`.trim()));
      else p.resolve(msg.result);
    } else if (msg.method) {
      if (msg.sessionId) this.sessions.get(msg.sessionId)?.(msg.method, msg.params);
      if (msg.method === 'Target.targetCreated' && msg.params.targetInfo?.type === 'page') this.onTargetCreated(msg.params.targetInfo.targetId);
      if (msg.method === 'Target.targetDestroyed') this.onTargetGone(msg.params.targetId);
      // Detached by Chrome, not by us (detach() forgets the session first): the tab is no longer drivable.
      if (msg.method === 'Target.detachedFromTarget' && msg.params.targetId && this.sessions.delete(msg.params.sessionId)) {
        this.onTargetGone(msg.params.targetId);
      }
    }
  }

  private raw(method: string, params: object = {}, sessionId?: string): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // After a stall of hq past the deadline, timers run before the socket is read: setImmediate lets a reply already
      // waiting settle first (host-client.ts command(), #313).
      const timer = setTimeout(() => setImmediate(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)); }), 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async send(method: string, params: object = {}, sessionId?: string): Promise<any> {
    await this.connect();
    return this.raw(method, params, sessionId);
  }

  async attach(targetId: string, listener: SessionListener): Promise<string> {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessions.set(sessionId, listener);
    return sessionId;
  }

  async detach(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    await this.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }

  /** Page targets that exist now. */
  async pages(): Promise<{ targetId: string; url: string }[]> {
    const { targetInfos } = await this.send('Target.getTargets');
    return (targetInfos as { targetId: string; type: string; url: string }[]).filter((t) => t.type === 'page');
  }

  close(): void {
    this.closed = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
