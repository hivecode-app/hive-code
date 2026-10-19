// HTTP/1.1 client for the hq ingest API (company-api.ts): unix socket
// <stateRoot>/hq.sock, or COMPANY_HQ_URL when set.
import { request } from 'node:http';

export interface HqTarget {
  /** http://host:port; wins over socketPath when set. */
  url?: string;
  socketPath?: string;
}

export interface HttpReply { status: number; body: unknown }

export class HqTimeoutError extends Error {}

/** POST JSON. Resolves for any HTTP status; rejects on network error/timeout. */
export function postJson(target: HqTarget, path: string, body: unknown, timeoutMs: number): Promise<HttpReply> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', 'content-length': String(payload.length) };
    const base = target.url
      ? (() => {
          const u = new URL(path, target.url);
          return { hostname: u.hostname, port: u.port, path: u.pathname + u.search };
        })()
      : { socketPath: target.socketPath, path };
    let settled = false;
    const done = (fn: () => void) => { if (!settled) { settled = true; clearTimeout(timer); fn(); } };
    const req = request({ ...base, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('error', (e) => done(() => reject(e)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep text */ }
        done(() => resolve({ status: res.statusCode ?? 0, body: parsed }));
      });
    });
    const timer = setTimeout(() => {
      done(() => reject(new HqTimeoutError(`hq ${path} timed out after ${timeoutMs}ms`)));
      req.destroy();
    }, timeoutMs);
    req.on('error', (e) => done(() => reject(e)));
    req.end(payload);
  });
}
