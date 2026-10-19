import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecallRequest, WalEntry } from '@company/shared';
import { localRecall, postJson, recall, Wal } from '../src/index.ts';
import type { OpTransport } from '../src/index.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'mcp-wal-'));
const noSleep = () => Promise.resolve();

let n = 0;
function entry(op: WalEntry['op'] = 'tell'): WalEntry {
  n++;
  return { id: `yoav-3:t${n}`, v: 1, ts: new Date().toISOString(), identity: 'yoav', shift: 'yoav-3',
    sessionId: null, op, args: { to: 'dana', body: `msg ${n}` } };
}

function lines(file: string): unknown[] {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

test('append is durable before the flusher runs', () => {
  const dir = tmp();
  const wal = new Wal({ dir, transport: async () => ({ status: 200 }) });
  const e = entry();
  wal.append(e);
  assert.deepEqual(lines(wal.walFile), [e]);
  assert.equal(wal.pending().length, 1);
});

test('retries network errors and 503 with backoff, then acks once, in order', async () => {
  const dir = tmp();
  const sent: string[] = [];
  let failuresLeft = 4;
  const transport: OpTransport = async (e) => {
    sent.push(e.id);
    if (failuresLeft > 0) {
      failuresLeft--;
      if (failuresLeft % 2) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { status: 503 };
    }
    return { status: 200, body: { ok: true, id: e.id } };
  };
  const delays: number[] = [];
  const wal = new Wal({ dir, transport, sleep: async (ms) => { delays.push(ms); }, random: () => 1 });
  const a = entry(); const b = entry(); const c = entry();
  wal.append(a); wal.append(b); wal.append(c);
  wal.start();
  await wal.whenIdle();
  await wal.stop();
  assert.deepEqual(delays, [250, 500, 1000, 2000]);
  assert.deepEqual(sent, [a.id, a.id, a.id, a.id, a.id, b.id, c.id]);
  // WAL compacted once everything settled
  assert.deepEqual(lines(wal.walFile), []);
  assert.deepEqual(lines(wal.ackFile), []);
});

test('acks are recorded in order while something is still pending', async () => {
  const dir = tmp();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const transport: OpTransport = async (e) => {
    if (e.args.body === 'hold') await gate;
    return { status: 200 };
  };
  const wal = new Wal({ dir, transport, sleep: noSleep });
  const a = entry(); const b = { ...entry(), args: { to: 'x', body: 'hold' } };
  wal.append(a); wal.append(b);
  wal.start();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(lines(wal.ackFile), [{ ack: a.id }]);
  release();
  await wal.whenIdle();
  await wal.stop();
});

test('backoff caps at maxDelayMs and jitter stays within [50%,100%]', async () => {
  const dir = tmp();
  let calls = 0;
  const delays: number[] = [];
  const wal = new Wal({
    dir, transport: async () => (++calls > 12 ? { status: 200 } : { status: 500 }),
    sleep: async (ms) => { delays.push(ms); }, random: () => 0,
  });
  wal.append(entry());
  wal.start();
  await wal.whenIdle();
  await wal.stop();
  assert.equal(delays.length, 12);
  assert.equal(delays[0], 125);
  assert.equal(Math.max(...delays), 15_000); // 30s cap * 0.5 jitter floor
});

test('4xx marks the entry failed and is not retried', async () => {
  const dir = tmp();
  const sent: string[] = [];
  const a = entry('ask'); const b = entry(); const c = entry('status');
  // c keeps failing with 503 so the files are not compacted and can be inspected.
  const wal = new Wal({
    dir, sleep: () => new Promise((r) => setTimeout(r, 5)),
    transport: async (e) => { sent.push(e.id); return { status: e.id === c.id ? 503 : e.op === 'ask' ? 422 : 200 }; },
  });
  wal.append(a); wal.append(b); wal.append(c);
  wal.start();
  await new Promise((r) => setTimeout(r, 40));
  await wal.stop();
  assert.deepEqual(sent.slice(0, 3), [a.id, b.id, c.id]);
  assert.equal(sent.filter((id) => id === a.id).length, 1);
  assert.deepEqual(lines(wal.ackFile), [{ fail: a.id, status: 422 }, { ack: b.id }]);
  assert.deepEqual(wal.pending().map((e) => e.id), [c.id]);
});

test('restart: pending and unacked entries are re-sent, settled ones are not', async () => {
  const dir = tmp();
  // First process: writes 4 entries, acks the first, fails the second, then "crashes".
  const first = new Wal({ dir, transport: async () => ({ status: 503 }), sleep: noSleep });
  const [a, b, c, d] = [entry(), entry(), entry(), entry()];
  for (const e of [a, b, c, d]) first.append(e);
  appendFileSync(first.ackFile, JSON.stringify({ ack: a.id }) + '\n' + JSON.stringify({ fail: b.id, status: 400 }) + '\n');
  appendFileSync(first.walFile, '{"id":"torn'); // torn tail from a crash mid-write

  const sent: string[] = [];
  const second = new Wal({ dir, transport: async (e) => { sent.push(e.id); return { status: 200 }; }, sleep: noSleep });
  assert.deepEqual(second.pending().map((e) => e.id), [c.id, d.id]);
  const e5 = entry();
  second.append(e5); // after the torn line: must land on its own line
  assert.ok(readFileSync(second.walFile, 'utf8').includes('\n' + JSON.stringify(e5) + '\n'));
  second.start();
  await second.whenIdle();
  await second.stop();
  assert.deepEqual(sent, [c.id, d.id, e5.id]);

  // Third process after a clean compaction has nothing to send.
  const third = new Wal({ dir, transport: async () => { throw new Error('must not send'); } });
  assert.equal(third.pending().length, 0);
});

test('stop() interrupts a long backoff sleep', async () => {
  const dir = tmp();
  const wal = new Wal({ dir, transport: async () => { throw new Error('down'); }, baseDelayMs: 60_000 });
  wal.append(entry());
  wal.start();
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await wal.stop();
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(wal.pending().length, 1);
});

// ------------------------------------------------------------------ real http over unix socket

function listenUnix(handler: (req: IncomingMessage, body: string, res: ServerResponse) => void): Promise<{ server: Server; sock: string }> {
  const sock = join(tmp(), 'hq.sock');
  const server = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, body, res));
  });
  return new Promise((resolve) => server.listen(sock, () => resolve({ server, sock })));
}

test('Wal + postJson deliver to an hq on a unix socket', async () => {
  const got: Array<{ url?: string; entry: WalEntry }> = [];
  let first = true;
  const { server, sock } = await listenUnix((req, body, res) => {
    const e = JSON.parse(body) as WalEntry;
    got.push({ url: req.url, entry: e });
    if (first) { first = false; res.writeHead(502).end('bad gateway'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, id: e.id, ref: 'm-1' }));
  });
  try {
    const dir = tmp();
    const wal = new Wal({ dir, transport: (e) => postJson({ socketPath: sock }, '/v1/ops', e, 2000), baseDelayMs: 5 });
    const a = entry(); const b = entry();
    wal.append(a); wal.append(b);
    wal.start();
    await wal.whenIdle();
    await wal.stop();
    assert.deepEqual(got.map((g) => g.url), ['/v1/ops', '/v1/ops', '/v1/ops']);
    assert.deepEqual(got.map((g) => g.entry.id), [a.id, a.id, b.id]);
    assert.deepEqual(got[2]!.entry, b);
  } finally { server.close(); }
});

// ------------------------------------------------------------------ recall

function memoryRepo(): string {
  const repo = tmp();
  mkdirSync(join(repo, 'memory/company'), { recursive: true });
  mkdirSync(join(repo, 'memory/projects/lumo'), { recursive: true });
  writeFileSync(join(repo, 'memory/company/deploy.md'), '# Deploy rules\n\nAlways run CI before deploy.\nNever force-push main.\n');
  writeFileSync(join(repo, 'memory/projects/lumo/bridge.md'), '# Lumo bridge\n\nThe bridge DEPLOY uses systemd.\nWhatsApp parity.\n');
  writeFileSync(join(repo, 'memory/projects/lumo/other.md'), '# Other\n\nnothing relevant\n');
  return repo;
}

test('recall falls back to memory/ when hq never answers', async () => {
  const repo = memoryRepo();
  const { server, sock } = await listenUnix(() => { /* never answer */ });
  try {
    const req: RecallRequest = { identity: 'yoav', shift: 'yoav-3', query: 'deploy CI' };
    const t0 = Date.now();
    const res = await recall(req, { transport: (r, ms) => postJson({ socketPath: sock }, '/v1/recall', r, ms), repo, timeoutMs: 100 });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(res.partial, true);
    assert.match(res.note ?? '', /hq/);
    assert.deepEqual(res.items.map((i) => i.ref), ['company/deploy', 'projects/lumo/bridge']);
    assert.match(res.items[0]!.text, /^### company\/deploy: Deploy rules\n[\s\S]*Never force-push main/);
    assert.equal(res.items[0]!.scope, 'company');
    assert.equal(res.items[1]!.scope, 'project:lumo');
    assert.match(res.items[1]!.text, /bridge DEPLOY/);

    const scoped = await recall({ ...req, scope: 'project:lumo', limit: 1 }, { transport: async () => { throw new Error('ECONNREFUSED'); }, repo });
    assert.deepEqual(scoped.items.map((i) => i.ref), ['projects/lumo/bridge']);
  } finally { server.closeAllConnections(); server.close(); }
});

test('recall returns hq answer when hq is up', async () => {
  const { server, sock } = await listenUnix((req, body, res) => {
    const r = JSON.parse(body) as RecallRequest & { queries: string[] };
    res.writeHead(200).end(JSON.stringify({ items: [{ ref: 'dir-0142', scope: 'company', text: `${req.url} ${r.query} ${r.limit} ${r.queries.join('|')}` }] }));
  });
  try {
    const res = await recall({ identity: 'y', shift: 'y-1', query: 'q', queries: ['ש', 'q', 'e'] },
      { transport: (r, ms) => postJson({ socketPath: sock }, '/v1/recall', r, ms), repo: tmp() });
    assert.equal(res.partial, undefined);
    assert.equal(res.items[0]!.text, '/v1/recall q 8 q|ש|e');
  } finally { server.close(); }
});

test('localRecall with no memory dir returns nothing', () => {
  assert.deepEqual(localRecall(tmp(), ['x'], undefined, 8), []);
});

test('localRecall: he+en queries in one call, exact id first, symlinks not followed', () => {
  const repo = memoryRepo();
  symlinkSync(join(repo, 'memory/company/deploy.md'), join(repo, 'memory/company/link.md'));
  const items = localRecall(repo, ['פריסה', 'deploy systemd'], undefined, 8);
  assert.deepEqual(items.map((i) => i.ref), ['projects/lumo/bridge', 'company/deploy']);
  assert.ok(items.every((i) => i.ref !== 'company/link'));
  assert.equal(localRecall(repo, ['other'], undefined, 8)[0]!.ref, 'projects/lumo/other');
  assert.equal(localRecall(repo, ['systemd bridge', 'company/deploy'], undefined, 8)[0]!.ref, 'company/deploy');
});

test('ack write failure keeps the entry and retries; flusher never rejects', async () => {
  const dir = tmp();
  const logs: string[] = [];
  let sends = 0;
  // must yield to timers: a microtask-only sleep would starve this test's polling
  const yieldSleep = () => new Promise<void>((r) => { setImmediate(r); });
  const wal = new Wal({ dir, transport: async () => { sends++; return { status: 200 }; }, sleep: yieldSleep, log: (m) => logs.push(m) });
  mkdirSync(join(dir, 'acks.ndjson')); // a directory: every ack append throws EISDIR
  const e1 = entry();
  wal.append(e1);
  wal.start();
  for (let i = 0; i < 100 && sends < 3; i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(sends >= 3);
  assert.equal(wal.pending().length, 1);
  assert.ok(logs.some((l) => l.includes(`recording ack for ${e1.id} failed`)));
  await wal.stop();
});

test('compact leaves the WAL alone when another instance appended to it', async () => {
  const dir = tmp();
  const a = new Wal({ dir, transport: async () => ({ status: 200 }), sleep: noSleep });
  const b = new Wal({ dir, transport: async () => ({ status: 503 }), sleep: noSleep }); // overlapping instance
  a.append(entry());
  const b1 = entry();
  b.append(b1); // never sent by b (not started), not in a's queue
  a.start();
  await a.whenIdle();
  await a.stop();
  const ids = readFileSync(join(dir, 'wal.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as WalEntry).id);
  assert.ok(ids.includes(b1.id));
});
