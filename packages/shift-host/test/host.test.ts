import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineSplitter, encodeFrame, decodeHostFrame, type HostToHq, type HqToHost } from '@company/shared';
import { ShiftHost, SpoolReader, DurableLog } from '../src/index.ts';

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '../../adapter/test/fixtures/fake-claude.mjs');
chmodSync(FAKE, 0o755);

class Client {
  frames: HostToHq[] = [];
  private waiters: Array<{ pred: (f: HostToHq) => boolean; res: (f: HostToHq) => void }> = [];
  sock: Socket;
  closed = false;
  constructor(path: string) {
    this.sock = createConnection(path);
    const sp = new LineSplitter((l) => {
      const f = decodeHostFrame(l);
      if (!f) return;
      this.frames.push(f);
      this.waiters = this.waiters.filter((w) => (w.pred(f) ? (w.res(f), false) : true));
    });
    this.sock.on('data', (d) => sp.push(d));
    this.sock.on('close', () => { this.closed = true; });
  }
  send(f: HqToHost): void { this.sock.write(encodeFrame(f)); }
  wait(pred: (f: HostToHq) => boolean, ms = 5000): Promise<HostToHq> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting for frame; got ' + JSON.stringify(this.frames.map((x) => x.t)))), ms);
      this.waiters.push({ pred, res: (f) => { clearTimeout(t); res(f); } });
    });
  }
  close(): void { this.sock.end(); }
}

function mkHost(root: string, shift = 'tester-1', extra: Partial<ConstructorParameters<typeof ShiftHost>[0]> = {}) {
  const cwd = join(root, 'cwd');
  mkdirSync(cwd, { recursive: true });
  return new ShiftHost({
    spec: { identity: 'tester', shift, sessionId: 'S-' + shift, resume: false, cwd, settingsFile: '', stateRoot: root, claudeBin: FAKE },
    lingerMs: 60_000, onExit: () => {}, ...extra,
  });
}

test('shift-host: send -> delivery states, events, replay after reconnect, superseded, stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sh-'));
  const host = mkHost(root);
  await host.start();
  assert.ok(existsSync(host.socketPath));

  const a = new Client(host.socketPath);
  a.send({ t: 'hello', v: 1, client: 'hq-a', logId: null, since: 0 });
  const hello = await a.wait((f) => f.t === 'hello') as Extract<HostToHq, { t: 'hello' }>;
  await a.wait((f) => f.t === 'live');
  const logId = hello.info.logId;

  a.send({ t: 'send', id: 'c1', msgId: 'm-1', text: 'hello', priority: 'next' });
  const r = await a.wait((f) => f.t === 'reply' && f.re === 'c1') as any;
  assert.equal(r.ok, true);
  assert.equal(r.data.state, 'written');
  for (const st of ['delivered', 'started', 'completed']) {
    await a.wait((f) => f.t === 'delivery' && f.msgId === 'm-1' && f.state === st);
  }
  const res = await a.wait((f) => f.t === 'event' && f.ev.kind === 'result') as any;
  assert.equal(res.ev.text, 'ECHO:hello');
  await a.wait((f) => f.t === 'delta');

  // idempotent send: same msgId is not resent
  a.send({ t: 'send', id: 'c2', msgId: 'm-1', text: 'hello', priority: 'next' });
  const r2 = await a.wait((f) => f.t === 'reply' && f.re === 'c2') as any;
  assert.equal(r2.data.state, 'completed');
  assert.equal(r2.data.uuid, r.data.uuid);

  a.send({ t: 'usage', id: 'u' });
  const u = await a.wait((f) => f.t === 'reply' && f.re === 'u') as any;
  assert.equal(u.data.fiveHour, 12);
  a.send({ t: 'status', id: 's' });
  const s = await a.wait((f) => f.t === 'reply' && f.re === 's') as any;
  assert.equal(s.data.state, 'idle');

  const seqs = a.frames.filter((f): f is Extract<HostToHq, { seq: number }> => 'seq' in f).map((f) => f.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  const mid = seqs[Math.floor(seqs.length / 2)]!;

  // second controller takes over; first is told and closed
  const b = new Client(host.socketPath);
  b.send({ t: 'hello', v: 1, client: 'hq-b', logId, since: mid });
  await a.wait((f) => f.t === 'error' && f.code === 'superseded');
  await b.wait((f) => f.t === 'live');
  const replayed = b.frames.filter((f): f is Extract<HostToHq, { seq: number }> => 'seq' in f).map((f) => f.seq);
  assert.equal(replayed[0], mid + 1);
  assert.deepEqual(replayed, seqs.filter((x) => x > mid));

  // wrong logId => full replay from 0
  const c = new Client(host.socketPath);
  c.send({ t: 'hello', v: 1, client: 'hq-c', logId: 'other', since: 9999 });
  await c.wait((f) => f.t === 'live');
  const firstSeq = c.frames.find((f) => 'seq' in f) as any;
  assert.equal(firstSeq.seq, 1);

  // commands before hello and bad frames get an error, not a crash
  const d = new Client(host.socketPath);
  d.send({ t: 'ping', id: 'p' });
  await d.wait((f) => f.t === 'error' && f.re === 'p');
  d.sock.write('{"t":"hello","v":99,"since":0}\n');
  await d.wait((f) => f.t === 'error' && f.code === 'version');

  c.send({ t: 'stop', id: 'x', reason: 'test', graceMs: 2000 });
  await c.wait((f) => f.t === 'lifecycle' && f.state === 'exited', 8000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(existsSync(host.socketPath), false);
  const log = readFileSync(join(root, 'shifts/tester-1.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(log.some((f) => f.t === 'delivery' && f.state === 'completed'));
  assert.ok(!log.some((f) => f.t === 'delta'), 'deltas are not logged');
  for (const cl of [a, b, c, d]) cl.close();
});

test('shift-host restart: log continues, logId kept, written deliveries fail', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sh2-'));
  const h1 = mkHost(root, 'r-1');
  await h1.start();
  const a = new Client(h1.socketPath);
  a.send({ t: 'hello', v: 1, client: 'hq', logId: null, since: 0 });
  const hello1 = await a.wait((f) => f.t === 'hello') as any;
  a.send({ t: 'send', id: 'c', msgId: 'm-9', text: 'x', priority: 'next' });
  await a.wait((f) => f.t === 'delivery' && f.state === 'completed');
  a.send({ t: 'stop', id: 's', reason: 'test' });
  await a.wait((f) => f.t === 'lifecycle' && f.state === 'exited', 8000);
  await new Promise((r) => setTimeout(r, 100));
  const last1 = h1.log.lastSeq;

  const h2 = mkHost(root, 'r-1');
  await h2.start();
  const b = new Client(h2.socketPath);
  b.send({ t: 'hello', v: 1, client: 'hq', logId: hello1.info.logId, since: last1 });
  const hello2 = await b.wait((f) => f.t === 'hello') as any;
  assert.equal(hello2.info.logId, hello1.info.logId);
  await b.wait((f) => f.t === 'live');
  const first = b.frames.find((f) => 'seq' in f) as any;
  assert.equal(first.seq, last1 + 1);
  // msgId remembered across host restarts (no duplicate delivery)
  b.send({ t: 'send', id: 'c2', msgId: 'm-9', text: 'x', priority: 'next' });
  const r = await b.wait((f) => f.t === 'reply' && f.re === 'c2') as any;
  assert.equal(r.data.state, 'completed');
  b.send({ t: 'stop', id: 's2', reason: 'test' });
  await b.wait((f) => f.t === 'lifecycle' && f.state === 'exited', 8000);
  a.close(); b.close();
});

test('spool reader: cursor, partial lines, ack deletes closed files', () => {
  const root = mkdtempSync(join(tmpdir(), 'sp-'));
  const sp = new SpoolReader(join(root, 'spool'));
  const line = (e: string) => JSON.stringify({ ts: 't', event: e, pid: 1, payload: { e } }) + '\n';
  appendFileSync(join(sp.dir, '2026102001.ndjson'), line('A') + line('B'));
  appendFileSync(join(sp.dir, '2026102002.ndjson'), line('C') + '{"ts":"t","event":"PART');
  const r1 = sp.read(null, 2);
  assert.deepEqual(r1.entries.map((e) => e.event), ['A', 'B']);
  assert.equal(r1.more, true);
  const r2 = sp.read(r1.cursor);
  assert.deepEqual(r2.entries.map((e) => e.event), ['C']);   // partial line not returned
  appendFileSync(join(sp.dir, '2026102002.ndjson'), 'IAL","pid":1,"payload":{}}\n');
  const r3 = sp.read(r2.cursor);
  assert.deepEqual(r3.entries.map((e) => e.event), ['PARTIAL']);
  sp.ack(r1.cursor!);
  assert.deepEqual(readdirSync(sp.dir).filter((f) => f.endsWith('.ndjson')), ['2026102002.ndjson']);
  assert.equal(sp.ackedCursor(), r1.cursor);
  // null cursor resumes from the persisted ack
  assert.deepEqual(sp.read(null).entries.map((e) => e.event), ['C', 'PARTIAL']);
  sp.ack(r3.cursor!);
  assert.deepEqual(readdirSync(sp.dir).filter((f) => f.endsWith('.ndjson')), ['2026102002.ndjson'], 'newest file kept');
  assert.equal(sp.read(null).entries.length, 0);
});

test('durable log repairs a torn last line and continues seq', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lg-'));
  const p = join(root, 'x.ndjson');
  const meta = join(root, 'x/log.json');
  const l1 = new DurableLog(p, meta);
  l1.append({ t: 'lifecycle', state: 'idle' });
  l1.append({ t: 'lifecycle', state: 'busy' });
  l1.close();
  appendFileSync(p, '{"t":"event","seq":3,"ts');
  const l2 = new DurableLog(p, meta);
  assert.equal(l2.lastSeq, 2);
  assert.equal(l2.logId, l1.logId);
  l2.append({ t: 'lifecycle', state: 'idle' });
  const got: number[] = [];
  for await (const f of l2.readRange(0, 10)) got.push(f.seq);
  assert.deepEqual(got, [1, 2, 3]);
  l2.close();
});
