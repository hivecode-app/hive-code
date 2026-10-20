import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { guarded, guardedUpgrade } from '../src/http-guard.ts';

/** Sends one raw HTTP request (fetch would normalise the path) and returns the status code, or null if the socket closed without one. */
function raw(port: number, path: string | Buffer, headers: Record<string, string> = {}, method = 'GET'): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1');
    let got = '';
    s.on('data', (d) => { got += d.toString('latin1'); });
    s.on('close', () => resolve(/^HTTP\/1\.1 (\d{3})/.exec(got) ? Number(/^HTTP\/1\.1 (\d{3})/.exec(got)![1]) : null));
    s.on('error', (e) => ((e as NodeJS.ErrnoException).code === 'ECONNRESET' ? resolve(null) : reject(e)));
    const head = Object.entries({ host: 'hq', connection: 'close', ...headers }).map(([k, v]) => `${k}: ${v}\r\n`).join('');
    s.write(Buffer.concat([Buffer.from(`${method} `), Buffer.isBuffer(path) ? path : Buffer.from(path, 'latin1'), Buffer.from(` HTTP/1.1\r\n${head}\r\n`)]));
  });
}

// Paths an outside scanner sent, or that make `new URL(path, base)` throw (20/10/2026: `//..%2f.env` took hq down).
const BAD = ['//..%2f.env', '//', '//%', '//%zz', '\\\\', '//[', '//x:abc', '//%E0%A4%A'];
const UPGRADE = { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };

test('API: a malformed request path gets 400 and hq keeps answering (HTTP and WS upgrade)', async () => {
  const env = await makeEnv({ noStart: true });
  await env.hq.start({ listen: true, timers: false });
  try {
    const port = env.hq.port!;
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    for (const p of BAD) {
      assert.equal(await raw(port, p), 400, `GET ${p}`);
      assert.equal(await raw(port, p, { authorization: `Bearer ${token}` }, 'POST'), 400, `POST ${p}`);
      assert.equal(await raw(port, p, UPGRADE), 400, `upgrade ${p}`);
    }
    // Broken UTF-8 in the raw path: Node's parser turns it away before hq sees it.
    assert.equal(await raw(port, Buffer.from([0x2f, 0x2f, 0xff, 0xfe, 0x2f, 0xc3])), 400, 'broken utf-8');
    // A route parameter that does not decode is the client's mistake, not ours.
    assert.equal(await raw(port, '/api/messages/%E0%A4%A/handled', { authorization: `Bearer ${token}` }, 'POST'), 400);
    assert.equal(await raw(port, '/api/uploads/%E0%A4%A', { authorization: `Bearer ${token}` }), 400);
    const res = await fetch(`http://127.0.0.1:${port}/api/inbox`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200, 'still serving');
  } finally { await env.cleanup(); }
});

test('guarded: a sync throw, a rejection or a throw after headers never escape the handler', async () => {
  const logged: string[] = [];
  const log = (msg: string) => { logged.push(msg); };
  const server = createServer(guarded(async (req, res) => {
    if (req.url === '/sync') throw new Error('sync');
    if (req.url === '/late') { res.writeHead(200); res.write('partial'); throw new Error('late'); }
    await new Promise((r) => setImmediate(r));
    if (req.url === '/async') throw new Error('async');
    res.writeHead(200).end('ok');
  }, log));
  server.on('upgrade', guardedUpgrade((req) => { throw new Error(`upgrade ${req.url}`); }, log));
  // A plain (non-async) handler, like the tab server's: its throw is synchronous.
  const plain = createServer(guarded((req, res) => {
    if (req.url === '/sync') throw new Error('sync');
    res.writeHead(200).end('ok');
  }, log));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  await new Promise<void>((r) => plain.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (server.address() as { port: number }).port;
    const plainPort = (plain.address() as { port: number }).port;
    assert.equal(await raw(plainPort, '/sync'), 500);
    assert.equal(await raw(plainPort, '/fine'), 200);
    assert.equal(await raw(port, '/sync'), 500);
    assert.equal(await raw(port, '/async'), 500);
    assert.equal(await raw(port, '/late'), 200, 'headers were out already: the socket is cut, nothing more');
    assert.equal(await raw(port, '/ws', UPGRADE), 500);
    assert.equal(await raw(port, '/fine'), 200);
    assert.deepEqual(logged, ['request failed', 'request failed', 'request failed', 'request failed', 'upgrade failed']);
  } finally {
    for (const s of [server, plain]) {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    }
  }
});
