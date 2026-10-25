// HostClient command timeouts (packages/hq/src/host-client.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HostClient } from '../src/host-client.ts';
import { until } from './helpers.ts';

/**
 * A host in its own process, like the real one: it answers every command at once, except `spool_ack` when told.
 * After each reply it touches `answered`, so a test can wait for the reply to be on the wire rather than for a guessed time.
 */
async function host(opts: { silentAck?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'hc-'));
  const sock = join(dir, 'h.sock');
  const answered = join(dir, 'answered');
  const ready = join(dir, 'ready');
  const src = `require('node:net').createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\\n')) >= 0) {
        const f = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
        if (!f.id || (${opts.silentAck === true} && f.t === 'spool_ack')) continue;
        s.write(JSON.stringify({ t: 'reply', re: f.id, ok: true }) + '\\n', () => require('node:fs').writeFileSync(process.argv[2], ''));
      }
    });
  }).listen(process.argv[1], () => require('node:fs').writeFileSync(process.argv[3], ''));`;
  const p = spawn(process.execPath, ['-e', src, sock, answered, ready], { stdio: 'ignore' });
  await until(() => existsSync(ready), 10_000, 'host listening');
  return { sock, answered, close: () => { p.kill(); rmSync(dir, { recursive: true, force: true }); } };
}

/** hq busy: no timer and no socket read runs until `done()` and at least `minMs` have passed (capped at 10s). */
function block(minMs: number, done: () => boolean): void {
  const t0 = Date.now();
  while (Date.now() - t0 < 10_000 && (Date.now() - t0 < minMs || !done())) { /* spin */ }
}

test('a reply that arrived while hq itself was stalled past the deadline is not a timeout', async () => {
  const h = await host();
  const c = new HostClient('s', h.sock);
  try {
    await c.open(0);
    const pong = c.ping(30);
    // The host answers, but hq does not read the socket until its stall ends, past the 30ms deadline.
    block(100, () => existsSync(h.answered));
    assert.equal(await pong, true);
  } finally { c.close(); h.close(); }
});

test('a host that never answers still times out', async () => {
  const h = await host({ silentAck: true });
  const c = new HostClient('s', h.sock);
  try {
    await c.open(0);
    assert.equal(await c.ping(), true);
    await assert.rejects(c.ackSpool('0:0'), /spool_ack timeout/);
  } finally { c.close(); h.close(); }
});

test('a connect that completed while hq was stalled past the deadline is not a connect timeout', async () => {
  const h = await host();
  const c = new HostClient('s', h.sock);
  try {
    // From the check phase, like a loop's callback: when the stall ends the next turn starts with timers, before the
    // pending and poll phases that deliver the connect (completed in the kernel at once, for a unix socket).
    const opened = await new Promise<Promise<void>>((r) => setImmediate(() => {
      const p = c.open(0, null, 30);
      block(100, () => true);
      r(p);
    }));
    await opened;
    assert.equal(await c.ping(), true);
  } finally { c.close(); h.close(); }
});
