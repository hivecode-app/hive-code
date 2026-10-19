#!/usr/bin/env node
// End-to-end smoke: real company-shift-host + pinned claude (haiku) + company MCP.
// Starts a host, connects as "hq", sends one message, waits for delivery states
// and the result, kills the hq connection, reconnects with `since`, checks the
// replay, then stops the shift. usage: node scripts/smoke-shift-host.mjs
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LineSplitter, encodeFrame, decodeHostFrame } from '../packages/shared/src/index.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lab = join(homedir(), '.local/state/agent-company/lab/smoke');
const stateDir = join(lab, 'state');
const cwd = join(lab, 'ws');
rmSync(stateDir, { recursive: true, force: true });
mkdirSync(cwd, { recursive: true });
const shift = `smoke-${Date.now() % 100000}`;
const sock = join(stateDir, 'shifts', `${shift}.sock`);

const host = spawn(process.execPath, [join(repo, 'packages/shift-host/src/cli.ts'), '--identity', 'smoke', '--shift', shift,
  '--session-id', crypto.randomUUID(), '--cwd', cwd, '--state-dir', stateDir, '--model', 'haiku', '--linger-ms', '2000'],
{ stdio: ['ignore', 'inherit', 'inherit'] });

const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(5), ...a);
while (!existsSync(sock)) await new Promise((r) => setTimeout(r, 50));

function connect(name, logId, since) {
  const s = createConnection(sock);
  const frames = [];
  const waiters = [];
  const sp = new LineSplitter((l) => {
    const f = decodeHostFrame(l); if (!f) return;
    frames.push(f);
    for (const w of [...waiters]) if (w.p(f)) { waiters.splice(waiters.indexOf(w), 1); w.r(f); }
  });
  s.on('data', (d) => sp.push(d));
  s.write(encodeFrame({ t: 'hello', v: 1, client: name, logId, since }));
  const wait = (p, ms = 90_000) => {
    const hit = frames.find(p); if (hit) return Promise.resolve(hit);
    return new Promise((r, j) => { const t = setTimeout(() => j(new Error('timeout')), ms); waiters.push({ p, r: (f) => { clearTimeout(t); r(f); } }); });
  };
  return { s, frames, wait, send: (f) => s.write(encodeFrame(f)) };
}

let ok = true;
const check = (name, cond, detail = '') => { ok &&= !!cond; log(cond ? 'PASS' : 'FAIL', name, detail); };

const a = connect('hq-smoke-a', null, 0);
const hello = await a.wait((f) => f.t === 'hello');
await a.wait((f) => f.t === 'live');
a.send({ t: 'send', id: 'c1', msgId: 'm-smoke-1', text: '[הודעה מ-smoke · דחיפות: רגילה · m-smoke-1]\nCall the company MCP tool `status` with state "smoke" and then reply with exactly: SMOKE-OK', priority: 'next' });
for (const st of ['written', 'delivered', 'started']) {
  const d = await a.wait((f) => f.t === 'delivery' && f.msgId === 'm-smoke-1' && f.state === st);
  check(`delivery ${st}`, d, `seq ${d.seq}`);
}
const res = await a.wait((f) => f.t === 'event' && f.ev.kind === 'result');
check('result', /SMOKE-OK/.test(res.ev.text ?? ''), JSON.stringify(res.ev.text).slice(0, 60));
const tools = a.frames.filter((f) => f.t === 'event' && f.ev.kind === 'tool_use').map((f) => f.ev.name);
check('mcp company tool used', tools.some((n) => n === 'mcp__company__status'), tools.join(','));
const init = a.frames.find((f) => f.t === 'event' && f.ev.kind === 'init');
check('init via host', init?.ev.sessionId === hello.info.sessionId, init?.ev.version);
await a.wait((f) => f.t === 'delivery' && f.msgId === 'm-smoke-1' && f.state === 'completed');
const sp = await new Promise((r) => { a.send({ t: 'spool_read', id: 'sp', cursor: null }); a.wait((f) => f.t === 'spool' && f.re === 'sp').then(r); });
check('spool via socket', sp.entries.length > 0, sp.entries.map((e) => e.event).join(','));
a.send({ t: 'usage', id: 'u' });
const u = await a.wait((f) => f.t === 'reply' && f.re === 'u');
check('usage via host', u.ok && typeof u.data.fiveHour === 'number', `5h=${u.data?.fiveHour}%`);

// hq "restart": drop connection, reconnect with since
const lastSeq = Math.max(...a.frames.filter((f) => 'seq' in f).map((f) => f.seq));
a.s.destroy();
const mid = Math.floor(lastSeq / 2);
const b = connect('hq-smoke-b', hello.info.logId, mid);
await b.wait((f) => f.t === 'live');
const re = b.frames.filter((f) => 'seq' in f).map((f) => f.seq);
check('replay after reconnect', re[0] === mid + 1 && re.at(-1) >= lastSeq, `${re[0]}..${re.at(-1)}`);

b.send({ t: 'stop', id: 'stop', reason: 'smoke done', graceMs: 3000 });
await b.wait((f) => f.t === 'lifecycle' && f.state === 'exited', 20_000);
const code = await new Promise((r) => host.on('exit', r));
check('host exited', code === 0 || code === null, `code ${code}`);
log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);
