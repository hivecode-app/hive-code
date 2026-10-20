// The public side of the tab handoff (B.9), behind Caddy at tab.hq: only GET /h/<token> (the phone page,
// served as the bet6 spike had it) and the WS /ws/<token> that drives the tab. Nothing else of hq is
// reachable here. Link-preview fetchers (Telegram, WhatsApp…) open the URL before the person does: they get
// an inert page and never claim the link (20/10, the spike's first real test).
import { createServer, type IncomingMessage } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { TabHandoffs } from './handoffs.ts';
import { guarded, guardedUpgrade, rejectUpgrade, requestUrl } from '../http-guard.ts';

const PAGE_HTML = readFileSync(join(import.meta.dirname, 'phone.html'), 'utf8');
const TOKEN = '([A-Za-z0-9_-]{32})';

export function isPreviewFetch(req: Pick<IncomingMessage, 'headers'>): boolean {
  const ua = String(req.headers['user-agent'] ?? '');
  return /bot|preview|crawler|spider|facebookexternalhit|WhatsApp|Slack|Discord/i.test(ua)
    || (req.headers['sec-fetch-mode'] !== undefined && req.headers['sec-fetch-mode'] !== 'navigate');
}

/** One cookie per handoff, so a second link on the same phone never unbinds the first. */
const cookieName = (id: string) => `hqt_${id.replace(/[^a-z0-9]/gi, '')}`;
function cookieOf(req: IncomingMessage, id: string): string | undefined {
  return new RegExp(`(?:^|;\\s*)${cookieName(id)}=([A-Za-z0-9_-]+)`).exec(String(req.headers.cookie ?? ''))?.[1];
}

export interface TabServer { port: number; close(): Promise<void> }

export function startTabServer(tab: TabHandoffs, host: string, port: number, log: (msg: string, data?: unknown) => void): Promise<TabServer> {
  const server = createServer(guarded((req, res) => {
    const m = new RegExp(`^/h/${TOKEN}$`).exec((req.url ?? '').split('?')[0]!);
    if (req.method !== 'GET' || !m) { res.writeHead(404).end('not found'); return; }
    const headers: Record<string, string> = {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow',
    };
    const page = (state: string) => PAGE_HTML.replace('__STATE__', state);
    const { row, gone } = tab.byToken(m[1]!);
    if (gone || !row) { res.writeHead(410, headers).end(page('expired')); return; }
    if (isPreviewFetch(req)) { res.writeHead(200, headers).end(page('expired')); return; }
    if (!row.bound_hash) {
      try {
        const key = tab.bind(row);
        headers['set-cookie'] = `${cookieName(row.id)}=${key}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=14400`;
      } catch { res.writeHead(403, headers).end(page('used')); return; }
    } else if (!tab.isBoundTo(row, cookieOf(req, row.id))) {
      res.writeHead(403, headers).end(page('used')); return;
    }
    res.writeHead(200, headers).end(page('live'));
  }, log));

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', guardedUpgrade((req, sock, head) => {
    const url = requestUrl(req);
    if (!url) return rejectUpgrade(sock, 400, 'Bad Request');
    const m = new RegExp(`^/ws/${TOKEN}$`).exec(url.pathname);
    const found = m ? tab.byToken(m[1]!) : null;
    const row = found && !found.gone ? found.row : undefined;
    if (!row || !tab.isBoundTo(row, cookieOf(req, row.id))) { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, head, async (ws) => {
      const clamp = (v: string | null, lo: number, hi: number, d: number) => Math.min(hi, Math.max(lo, Number(v) || d));
      const size = {
        w: Math.round(clamp(url.searchParams.get('w'), 280, 600, 390)),
        h: Math.round(clamp(url.searchParams.get('h'), 300, 1200, 760)),
        dsf: clamp(url.searchParams.get('dpr'), 1, 2, 2),
      };
      try {
        tab.markViewed(row.id);
        await tab.browser.attachPhone(row.target_id, ws, size, {
          onDone: (finalUrl) => { tab.end(row.id, 'done', 'phone', finalUrl); },
          onUrl: (u) => tab.noteUrl(row.id, u),
        });
        // Ended while the view was being set up: give the tab back now (release runs after this attach).
        if (tab.byToken(m![1]!).gone) await tab.browser.release(row.target_id, TabHandoffs.phoneEnd(tab.get(row.id)!.state));
        log('phone connected', { id: row.id, ...size });
      } catch (e) {
        log('phone view failed', { id: row.id, error: String(e) });
        ws.close();
      }
    });
  }, log));

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => new Promise<void>((r) => {
          for (const c of wss.clients) c.terminate();
          wss.close();
          server.closeAllConnections();
          server.close(() => r());
        }),
      });
    });
  });
}
