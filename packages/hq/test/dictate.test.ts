import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { DICTATE_MAX_BYTES } from '../src/dictate.ts';

/** A stand-in for dictate-server: checks its own token, records what reached it. */
async function fakeDictateHe(status = 200) {
  const seen: { headers: IncomingHttpHeaders; body: Buffer }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
      if (req.headers.authorization !== 'Bearer svc-token') { res.writeHead(401); return res.end('{"detail":"bad token"}'); }
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(status === 200 ? '{"text":"שלום","ms":5,"engine":"openai"}' : '{"detail":"x"}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  return { seen, url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function env(dictate: { url: string; token: string | null }) {
  const e = await makeEnv({ noStart: true, cfg: { dictate } });
  await e.hq.start({ listen: true, timers: false });
  const base = `http://127.0.0.1:${e.hq.port}`;
  const admin = readFileSync(join(e.cfg.stateDir, 'api-token'), 'utf8').trim();
  const post = (path: string, body: unknown, token?: string) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const code = (await (await post('/api/devices/pair', {}, admin)).json()).code as string;
  const device = (await (await post('/api/auth/pair', { code, name: 'phone' })).json()).token as string;
  const transcribe = (token?: string, body: BodyInit = form()) =>
    fetch(`${base}/api/dictate/transcribe`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {}, body });
  return { ...e, device, transcribe };
}

function form(): FormData {
  const f = new FormData();
  f.set('engine', 'openai');
  f.set('audio', new Blob([Buffer.from('RIFF....WAVEfmt ')]), 'audio.wav');
  return f;
}

test('dictate: a device token reaches dictate-server with the server credential, and nothing else does', async () => {
  const d = await fakeDictateHe();
  const e = await env({ url: d.url, token: 'svc-token' });
  try {
    assert.equal((await e.transcribe()).status, 401, 'no token');
    assert.equal((await e.transcribe('svc-token')).status, 401, "dictate-server's own token is not an hq token");
    assert.equal(d.seen.length, 0, 'nothing reached dictate-server without a device');

    const ok = await e.transcribe(e.device);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).text, 'שלום');
    assert.equal(d.seen.length, 1);
    assert.equal(d.seen[0]!.headers.authorization, 'Bearer svc-token', 'hq swaps in its own credential');
    assert.match(String(d.seen[0]!.headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.ok(d.seen[0]!.body.includes('RIFF....WAVEfmt '), 'the audio arrives intact');
    assert.ok(d.seen[0]!.body.includes('name="engine"'));

    const big = await e.transcribe(e.device, new Uint8Array(DICTATE_MAX_BYTES + 1));
    assert.equal(big.status, 413);
    assert.equal(d.seen.length, 1, 'an oversized recording is not forwarded');
  } finally { await e.cleanup(); await d.close(); }
});

test('dictate: a rejected server credential, no credential, and a dead service are hq errors, not 401', async () => {
  const d = await fakeDictateHe();
  const wrong = await env({ url: d.url, token: 'stale' });
  try {
    const r = await wrong.transcribe(wrong.device);
    assert.equal(r.status, 502, 'a 401 from dictate-server must not look like a signed-out device');
  } finally { await wrong.cleanup(); }

  const none = await env({ url: d.url, token: null });
  try {
    assert.equal((await none.transcribe(none.device)).status, 503);
  } finally { await none.cleanup(); }

  const dead = await env({ url: 'http://127.0.0.1:1', token: 'svc-token' });
  try {
    assert.equal((await dead.transcribe(dead.device)).status, 502);
  } finally { await dead.cleanup(); await d.close(); }
});
