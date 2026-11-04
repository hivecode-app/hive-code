// Nothing a client sends may take hq down. A path like `//..%2f.env` makes `new URL()` throw, and a
// throw (or a rejected promise) inside an http handler is an uncaught exception: the whole process
// exits. On 20/10/2026 an outside scanner did exactly that. Every listener goes through these.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

/** The request's URL, or null when the client sent one that does not parse. */
export function requestUrl(req: IncomingMessage): URL | null {
  try { return new URL(req.url ?? '/', 'http://hq'); } catch { return null; }
}

type Log = (msg: string, data?: unknown) => void;
const defaultLog: Log = (msg, data) => console.error(`http: ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);

/** Wraps an http handler so no sync throw or rejection escapes: 500 and a log line instead of a crash. */
export function guarded(handler: (req: IncomingMessage, res: ServerResponse) => unknown, log: Log = defaultLog) {
  const fail = (req: IncomingMessage, res: ServerResponse, e: unknown) => {
    log('request failed', { method: req.method, url: req.url, error: String((e as Error)?.stack ?? e) });
    try {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    } catch { res.destroy(); }
  };
  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      const r = handler(req, res);
      if (r instanceof Promise) r.catch((e) => fail(req, res, e));
    } catch (e) { fail(req, res, e); }
  };
}

/** The same for an `upgrade` listener: on any error the socket is closed with a 500. */
export function guardedUpgrade(handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => unknown, log: Log = defaultLog) {
  const fail = (req: IncomingMessage, socket: Duplex, e: unknown) => {
    log('upgrade failed', { url: req.url, error: String((e as Error)?.stack ?? e) });
    rejectUpgrade(socket, 500, 'Internal Server Error');
  };
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    try {
      const r = handler(req, socket, head);
      if (r instanceof Promise) r.catch((e) => fail(req, socket, e));
    } catch (e) { fail(req, socket, e); }
  };
}

/** Answers a WebSocket upgrade with a plain HTTP status and closes the socket. */
export function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  try {
    if (socket.writable) socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch { /* the peer is gone already */ }
  socket.destroy();
}

/** Bounded per-address window for public entry points. Uses the server clock in tests. */
export class EntryLimiter {
  private failures = new Map<string, { count: number; until: number }>();
  private now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  blocked(client: string): boolean {
    const now = this.now();
    for (const [k, v] of this.failures) if (v.until <= now) this.failures.delete(k);
    return (this.failures.get(client)?.count ?? 0) >= 10;
  }
  fail(client: string): void {
    this.blocked(client);
    // Bound memory under address churn, without evicting a blocked client's window.
    if (!this.failures.has(client) && this.failures.size >= 10_000) return;
    const v = this.failures.get(client) ?? { count: 0, until: this.now() + 60_000 };
    v.count++;
    this.failures.set(client, v);
  }
}
