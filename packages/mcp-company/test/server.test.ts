import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LineSplitter } from '@company/shared';
import type { WalEntry } from '@company/shared';
import { hebrewProblem, TOOL_BY_NAME } from '../src/tools.ts';

const SERVER = new URL('../src/server.ts', import.meta.url).pathname;

interface Rpc { id?: number; result?: any; error?: { code: number; message: string } }

class Client {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private waiters = new Map<number, (m: Rpc) => void>();
  stdoutLines: string[] = [];
  stderr = '';
  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), ...env } });
    const split = new LineSplitter((l) => {
      this.stdoutLines.push(l);
      const m = JSON.parse(l) as Rpc;
      if (typeof m.id === 'number') this.waiters.get(m.id)?.(m);
    });
    this.child.stdout.on('data', (c: Buffer) => split.push(c));
    this.child.stderr.on('data', (c: Buffer) => { this.stderr += c; });
  }
  send(obj: unknown): void { this.child.stdin.write(JSON.stringify(obj) + '\n'); }
  raw(line: string): void { this.child.stdin.write(line + '\n'); }
  call(method: string, params?: unknown): Promise<Rpc> {
    const id = this.nextId++;
    const p = new Promise<Rpc>((r) => this.waiters.set(id, r));
    this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    return p;
  }
  close(): Promise<number | null> {
    return new Promise((r) => { this.child.on('close', (code) => r(code)); this.child.stdin.end(); });
  }
}

function walLines(root: string, shift: string, file: string): unknown[] {
  try {
    return readFileSync(join(root, 'shifts', shift, 'wal', file), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}

test('handshake, tools/list, write tools queue to WAL while hq is down', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-srv-'));
  const c = new Client({
    COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'yoav-3', COMPANY_IDENTITY: 'yoav', COMPANY_SESSION_ID: 'sess-1',
    COMPANY_HQ_URL: 'http://127.0.0.1:1', // nothing listens: every send fails
    COMPANY_REPO: root,
  });
  try {
    const init = await c.call('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-03-26');
    const future = await c.call('initialize', { protocolVersion: '2099-01-01', capabilities: {} });
    assert.equal(future.result.protocolVersion, '2025-06-18');
    assert.deepEqual(init.result.capabilities, { tools: {} });
    assert.equal(init.result.serverInfo.name, 'company');
    c.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

    const list = await c.call('tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name).sort();
    assert.deepEqual(names, ['ask', 'close_team', 'compose_home', 'handoff', 'open_team', 'open_ticket', 'recall', 'remember', 'request_go', 'status', 'tell', 'withdraw_ask']);
    for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');

    const tell = await c.call('tools/call', { name: 'tell', arguments: { to: 'dana', body: 'שלום', urgency: 'now' } });
    assert.equal(tell.result.isError, undefined);
    const q = JSON.parse(tell.result.content[0].text) as { queued: boolean; id: string };
    assert.equal(q.queued, true);
    assert.match(q.id, /^yoav-3:/);
    const [e] = walLines(root, 'yoav-3', 'wal.ndjson') as WalEntry[];
    assert.equal(e!.id, q.id);
    assert.equal(e!.op, 'tell');
    assert.equal(e!.identity, 'yoav');
    assert.equal(e!.sessionId, 'sess-1');
    assert.deepEqual(e!.args, { to: 'dana', body: 'שלום', urgency: 'now' });

    // Hebrew everywhere (#51): English text or titles are sent back for a rewrite, never queued.
    const en = await c.call('tools/call', { name: 'tell', arguments: { to: 'yoav', body: 'Done. The PR is merged and the deploy went fine, see the link.' } });
    assert.equal(en.result.isError, true);
    assert.match(en.result.content[0].text, /בעברית/);
    const enTitle = await c.call('tools/call', { name: 'open_team', arguments: { name: 'Tab handoff into hq', purpose: 'להעביר את ה-handoff של הטאב ל-hq' } });
    assert.equal(enTitle.result.isError, true);
    const enTicket = await c.call('tools/call', { name: 'open_ticket', arguments: { repo: 'a/b', title: 'Fix login flow', body: 'תיקון' } });
    assert.equal(enTicket.result.isError, true);
    assert.equal(walLines(root, 'yoav-3', 'wal.ndjson').length, 1, 'none of them reached the WAL');
    const open = TOOL_BY_NAME.get('open_team')!;
    assert.equal(hebrewProblem(open, { name: 'העברת ה-handoff של הטאב ל-hq', purpose: 'PR עם `company-ci` ירוק' }), null);
    // compose_home: blocks are objects, and the words in them are his too.
    const home = TOOL_BY_NAME.get('compose_home')!;
    assert.equal(hebrewProblem(home, { blocks: [{ type: 'headline', text: 'בוקר שקט' }, { type: 'since', items: ['התמונות עולות'] }] }), null);
    assert.match(hebrewProblem(home, { blocks: [{ type: 'since', items: ['Images upload from the phone now'] }] }) ?? '', /blocks\[0\]/);
    assert.match(hebrewProblem(home, { blocks: [{ type: 'since', items: [{ text: 'Images upload from the phone now', task: 3 }] }] }) ?? '', /blocks\[0\]/);
    assert.equal(hebrewProblem(home, { blocks: [{ type: 'since', items: [{ text: 'התמונות עולות', task: 3 }] }] }), null);
    const notObjects = await c.call('tools/call', { name: 'compose_home', arguments: { blocks: ['headline'] } });
    assert.match(notObjects.result.content[0].text, /array of objects/);

    const bad = await c.call('tools/call', { name: 'remember', arguments: { scope: 'galaxy', kind: 'fact', text: 'x' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /scope must be one of/);

    const missing = await c.call('tools/call', { name: 'ask', arguments: {} });
    assert.equal(missing.result.isError, true);
    // The first line in his words is required on everything he answers (ask, request_go).
    const noHeadline = await c.call('tools/call', { name: 'request_go', arguments: { what: 'פריסה של hq' } });
    assert.equal(noHeadline.result.isError, true);
    assert.match(noHeadline.result.content[0].text, /headline/);
    const enHeadline = await c.call('tools/call', { name: 'ask', arguments: { headline: 'Deploy the bots', question: 'להעביר?' } });
    assert.equal(enHeadline.result.isError, true);

    const unknownTool = await c.call('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknownTool.error?.code, -32602);
    const unknown = await c.call('resources/list');
    assert.equal(unknown.error?.code, -32601);
    assert.deepEqual((await c.call('ping')).result, {});

    // recall with hq down: local fallback, marked partial.
    const rec = await c.call('tools/call', { name: 'recall', arguments: { query: 'zzzz-nothing' } });
    const rr = JSON.parse(rec.result.content[0].text) as { partial: boolean; items: unknown[] };
    assert.equal(rr.partial, true);
    const recQs = await c.call('tools/call', { name: 'recall', arguments: { queries: ['ביטוח', 'insurance'] } });
    assert.equal(recQs.result.isError, undefined);
    const recNone = await c.call('tools/call', { name: 'recall', arguments: {} });
    assert.equal(recNone.result.isError, true);

    c.raw('{not json');
    await new Promise((r) => setTimeout(r, 50));
    const parseErr = JSON.parse(c.stdoutLines.at(-1)!) as Rpc & { id: null };
    assert.equal(parseErr.error?.code, -32700);
    assert.equal(parseErr.id, null);

    for (const l of c.stdoutLines) assert.equal((JSON.parse(l) as { jsonrpc: string }).jsonrpc, '2.0');
  } finally {
    assert.equal(await c.close(), 0);
  }
  // Still pending after exit: survives for the next server instance.
  assert.equal(walLines(root, 'yoav-3', 'wal.ndjson').length, 1);
  assert.deepEqual(walLines(root, 'yoav-3', 'acks.ndjson'), []);
});

test('restarted server re-sends pending WAL entries to hq over the unix socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-srv-'));
  const shift = 'rotem-1';
  const base = { COMPANY_STATE_DIR: root, COMPANY_SHIFT: shift, COMPANY_IDENTITY: 'rotem' };

  // 1st instance: hq is down (no socket), one write is queued.
  const c1 = new Client(base);
  const r1 = await c1.call('tools/call', { name: 'handoff', arguments: { state: 'באמצע', next: ['לסיים'] } });
  const id1 = (JSON.parse(r1.result.content[0].text) as { id: string }).id;
  await c1.close();

  // hq comes up on <stateRoot>/hq.sock.
  const received: WalEntry[] = [];
  const hq = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      if (req.url === '/v1/ops') {
        const e = JSON.parse(body) as WalEntry;
        received.push(e);
        res.writeHead(200).end(JSON.stringify({ ok: true, id: e.id }));
      } else {
        res.writeHead(200).end(JSON.stringify({ items: [{ ref: 'dir-1', scope: 'company', text: 'from hq' }] }));
      }
    });
  });
  await new Promise<void>((r) => hq.listen(join(root, 'hq.sock'), r));
  try {
    const repo = mkdtempSync(join(tmpdir(), 'mcp-repo-'));
    mkdirSync(join(repo, 'memory'));
    writeFileSync(join(repo, 'memory/x.md'), 'x');
    const c2 = new Client({ ...base, COMPANY_REPO: repo });
    const r2 = await c2.call('tools/call', { name: 'status', arguments: { state: 'working' } });
    const id2 = (JSON.parse(r2.result.content[0].text) as { id: string }).id;
    const rec = await c2.call('tools/call', { name: 'recall', arguments: { query: 'x' } });
    assert.equal((JSON.parse(rec.result.content[0].text) as { items: Array<{ text: string }> }).items[0]!.text, 'from hq');
    for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    await c2.close();
    assert.deepEqual(received.map((e) => e.id), [id1, id2]);
    assert.equal(received[0]!.op, 'handoff');
    // all settled -> compacted
    assert.deepEqual(walLines(root, shift, 'wal.ndjson'), []);
  } finally { hq.close(); }
});

test('open_team answers with hq\'s verdict: a rejection comes back as a tool error with the reason (#69)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-srv-'));
  const hq = createHttpServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const e = JSON.parse(body) as WalEntry;
      if (e.args.project === 'sleepy') {
        res.writeHead(400).end(JSON.stringify({ ok: false, error: 'open_team: project sleepy is dormant', reason: 'הפרויקט `sleepy` רדום' }));
      } else {
        res.writeHead(200).end(JSON.stringify({ ok: true, id: e.id, ref: 'task-9', result: { task: 9, state: 'queued' } }));
      }
    });
  });
  await new Promise<void>((r) => hq.listen(join(root, 'hq.sock'), r));
  const c = new Client({ COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'yoav-4', COMPANY_IDENTITY: 'yoav', COMPANY_REPO: root });
  try {
    const no = await c.call('tools/call', { name: 'open_team', arguments: { name: 'משימה', purpose: 'לבדוק', project: 'sleepy' } });
    assert.equal(no.result.isError, true);
    assert.match(no.result.content[0].text, /^`open_team` נדחה ב-hq: הפרויקט `sleepy` רדום$/);
    const yes = await c.call('tools/call', { name: 'open_team', arguments: { name: 'משימה', purpose: 'לבדוק', project: 'agent-company' } });
    assert.equal(yes.result.isError, undefined);
    const ack = JSON.parse(yes.result.content[0].text) as { ok: boolean; ref: string; result: { task: number } };
    assert.equal(ack.ok, true);
    assert.equal(ack.ref, 'task-9');
    assert.equal(ack.result.task, 9);
    await c.close();
  } finally { hq.close(); }
});

test('recall reads memory from COMPANY_HOME, not from COMPANY_REPO (the engine checkout)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-srv-'));
  const mk = (name: string, text: string) => {
    const d = mkdtempSync(join(tmpdir(), `mcp-${name}-`));
    mkdirSync(join(d, 'memory', 'company'), { recursive: true });
    writeFileSync(join(d, 'memory', 'company', 'where.md'), `---\nname: where\ndescription: where memory lives\n---\n${text}\n`);
    return d;
  };
  const home = mk('home', 'okapifact from the company home');
  const engine = mk('engine', 'okapifact from the engine repo');
  const c = new Client({ COMPANY_STATE_DIR: root, COMPANY_SHIFT: 'eli-1', COMPANY_IDENTITY: 'eli', COMPANY_HQ_URL: 'http://127.0.0.1:1',
    COMPANY_REPO: engine, COMPANY_HOME: home });
  try {
    const rec = await c.call('tools/call', { name: 'recall', arguments: { query: 'okapifact' } });
    const items = (JSON.parse(rec.result.content[0].text) as { items: Array<{ text: string }> }).items;
    assert.ok(items.length > 0);
    assert.ok(items.every((i) => !i.text.includes('engine repo')), JSON.stringify(items));
    assert.ok(items[0]!.text.includes('company home'));
  } finally { await c.close(); }
});
