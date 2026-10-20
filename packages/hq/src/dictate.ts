// Dictation for the app (#27): POST /api/dictate/transcribe. The app sends the audio with its own
// device token (checked by api.ts like every other route); hq forwards it to dictate-server
// (~/projects/dictate-server, 127.0.0.1:8790) with dictate-server's token, which never leaves the server.
// The token comes from DICTATE_TOKEN in ~/.config/agent-company/hq.env (deploy/agent-company-hq.service).
import { request } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface DictateConfig {
  url: string;
  token: string | null;
}

/** The limit Caddy had before hq took this over: about 13 minutes of 16 kHz mono PCM16. */
export const DICTATE_MAX_BYTES = 25 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export function proxyDictate(cfg: DictateConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (status: number, error: string) => {
      if (settled) return;
      settled = true;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ error }));
      resolve();
    };
    if (!cfg.token) return fail(503, 'dictation is not configured on this hq (DICTATE_TOKEN)');
    if (Number(req.headers['content-length'] ?? 0) > DICTATE_MAX_BYTES) { req.resume(); return fail(413, 'recording too large'); }
    const headers: Record<string, string> = { authorization: `Bearer ${cfg.token}` };
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
    const up = request(new URL('/transcribe', cfg.url), { method: 'POST', headers, timeout: TIMEOUT_MS }, (r) => {
      // A 401 from dictate-server is about hq's credential, not the device: the app must not read it as "sign in again".
      if (r.statusCode === 401) { r.resume(); return fail(502, 'dictate-server rejected the credential of hq'); }
      if (settled) return void r.resume();
      settled = true;
      res.writeHead(r.statusCode ?? 502, { 'content-type': r.headers['content-type'] ?? 'application/json', 'cache-control': 'no-store' });
      r.pipe(res);
      r.on('end', () => resolve());
      r.on('error', () => { res.destroy(); resolve(); });
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    // The phone gave up (app closed, network gone): stop the upstream call too.
    req.on('aborted', () => { up.destroy(); settled = true; resolve(); });
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    up.on('error', () => fail(502, 'dictation service unavailable'));
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= DICTATE_MAX_BYTES) return;
      fail(413, 'recording too large');
      req.unpipe(up);
      up.destroy();
      req.resume();
    });
    req.pipe(up);
  });
}
