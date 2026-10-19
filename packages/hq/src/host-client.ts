// hq side of the shift-host socket (packages/shared/src/shift-protocol.ts, engine lane).
// One client per shift. The host is the server and outlives hq; we reconnect with hello{logId, since}
// and the host replays what we missed. One controller at a time: a newer hello supersedes us.
import { connect, type Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  SHIFT_PROTOCOL_VERSION, LineSplitter, decodeHostFrame, encodeFrame,
  type EngineDelta, type HostToHq, type HqToHost, type HostInfo, type LoggedFrame, type Priority, type SendReply, type SpoolEntry,
} from '@company/shared';

type Reply = Extract<HostToHq, { t: 'reply' }> | Extract<HostToHq, { t: 'spool' }>;

/** Distributive Omit so each union member keeps its own fields. */
type CommandBody<T> = T extends unknown ? Omit<T, 'id'> : never;

export interface HostClientEvents {
  hello: [HostInfo];
  frame: [LoggedFrame];
  delta: [EngineDelta];
  spoolReady: [];
  live: [number];
  close: [Error | null];
}

/** What the rest of hq needs from a shift-host connection. Tests substitute fakes at this seam. */
export interface HostConnection extends EventEmitter<HostClientEvents> {
  readonly shiftId: string;
  readonly connected: boolean;
  readonly isLive: boolean;
  info: HostInfo | null;
  send(msgId: string, text: string, priority: Priority, retry?: boolean): Promise<SendReply | null>;
  interrupt(): Promise<void>;
  stop(reason: string, graceMs?: number): Promise<void>;
  ping(timeoutMs?: number): Promise<boolean>;
  /** control_request get_context_usage via the host: claude answers it even mid-turn, no inference (bet 4). */
  claudePing(timeoutMs?: number): Promise<boolean>;
  readSpool(cursor: string | null, max?: number): Promise<{ entries: SpoolEntry[]; cursor: string | null; more: boolean }>;
  ackSpool(cursor: string): Promise<void>;
  close(): void;
}

export class HostClient extends EventEmitter<HostClientEvents> implements HostConnection {
  readonly shiftId: string;
  private readonly socketPath: string;
  private sock: Socket | null = null;
  private pending = new Map<string, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  info: HostInfo | null = null;
  connected = false;
  isLive = false;

  constructor(shiftId: string, socketPath: string) {
    super();
    this.shiftId = shiftId;
    this.socketPath = socketPath;
  }

  /** Connect and send hello. Resolves once the socket is open; `live` fires after the replay. */
  open(since: number, logId: string | null = null, timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = connect(this.socketPath);
      const t = setTimeout(() => { sock.destroy(); reject(new Error(`connect timeout ${this.socketPath}`)); }, timeoutMs);
      const split = new LineSplitter((line) => this.onLine(line), undefined, () => { /* oversized frame dropped */ });
      sock.on('connect', () => {
        clearTimeout(t);
        this.sock = sock;
        this.connected = true;
        this.write({ t: 'hello', v: SHIFT_PROTOCOL_VERSION, client: 'hq', logId, since });
        resolve();
      });
      sock.on('data', (d) => {
        try { split.push(d); } catch { /* a bad line never kills the connection */ }
      });
      sock.on('error', (e) => {
        clearTimeout(t);
        if (!this.connected) reject(e);
      });
      sock.on('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.isLive = false;
        this.sock = null;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('host socket closed')); }
        this.pending.clear();
        if (wasConnected) this.emit('close', null);
      });
    });
  }

  private onLine(line: string): void {
    let f: HostToHq | null;
    try { f = decodeHostFrame(line); } catch { return; }
    if (!f) return;
    switch (f.t) {
      case 'hello': this.info = f.info; this.emit('hello', f.info); break;
      case 'live': this.isLive = true; this.emit('live', f.lastSeq); break;
      case 'delta': this.emit('delta', f.ev); break;
      case 'spool_ready': this.emit('spoolReady'); break;
      case 'error':
        if (f.re) this.settle(f.re, { t: 'reply', re: f.re, ok: false, code: f.code, error: f.message });
        if (f.fatal || f.code === 'superseded') this.sock?.destroy();
        break;
      case 'reply':
      case 'spool': this.settle(f.re, f); break;
      default: this.emit('frame', f);
    }
  }

  private settle(re: string, r: Reply): void {
    const p = this.pending.get(re);
    if (p) { clearTimeout(p.timer); this.pending.delete(re); p.resolve(r); }
  }

  private write(f: HqToHost): void {
    if (!this.sock) throw new Error(`shift ${this.shiftId} not connected`);
    this.sock.write(encodeFrame(f));
  }

  private command(body: CommandBody<Extract<HqToHost, { id: string }>>, timeoutMs = 5000): Promise<Reply> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${body.t} timeout`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ ...body, id } as HqToHost); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e as Error); }
    });
  }

  private async ok(body: CommandBody<Extract<HqToHost, { id: string }>>, timeoutMs?: number): Promise<unknown> {
    const r = await this.command(body, timeoutMs);
    if (r.t === 'reply' && !r.ok) throw new Error(`${r.code}: ${r.error}`);
    return r.t === 'reply' ? r.data : r;
  }

  async send(msgId: string, text: string, priority: Priority, retry = false): Promise<SendReply | null> {
    const data = await this.ok({ t: 'send', msgId, text, priority, ...(retry ? { retry: true } : {}) });
    return data && typeof data === 'object' && 'state' in data ? (data as SendReply) : null;
  }
  async interrupt(): Promise<void> { await this.ok({ t: 'interrupt' }); }
  async stop(reason: string, graceMs?: number): Promise<void> { await this.ok({ t: 'stop', reason, graceMs }, (graceMs ?? 5000) + 5000); }
  async ping(timeoutMs = 3000): Promise<boolean> {
    try { await this.ok({ t: 'ping' }, timeoutMs); return true; } catch { return false; }
  }
  async claudePing(timeoutMs = 3000): Promise<boolean> {
    try { await this.ok({ t: 'context' }, timeoutMs); return true; } catch { return false; }
  }
  async readSpool(cursor: string | null, max = 200) {
    const r = await this.command({ t: 'spool_read', cursor, max });
    if (r.t === 'spool') return { entries: r.entries, cursor: r.cursor, more: r.more };
    if (!r.ok) throw new Error(r.error);
    return { entries: [], cursor, more: false };
  }
  async ackSpool(cursor: string): Promise<void> { await this.ok({ t: 'spool_ack', cursor }); }
  close(): void { this.sock?.destroy(); }
}
