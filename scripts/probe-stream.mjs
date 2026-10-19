#!/usr/bin/env node
// Ad-hoc probe of the stream-json wire on a given binary (dev aid, not a canary).
// usage: node scripts/probe-stream.mjs <claude-bin> <lab-dir>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const [bin, cwd] = process.argv.slice(2);
mkdirSync(cwd, { recursive: true });
const p = spawn(bin, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--include-partial-messages', '--replay-user-messages', '--session-id', randomUUID(),
  '--setting-sources', 'project,local', '--permission-mode', 'bypassPermissions', '--model', 'haiku',
  '--disallowedTools', 'AskUserQuestion', '--strict-mcp-config'],
{ cwd, env: { ...process.env, DISABLE_AUTOUPDATER: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
const t0 = Date.now();
let buf = '';
let results = 0;
const seen = {};
p.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const l = buf.slice(0, i); buf = buf.slice(i + 1);
    let o;
    try { o = JSON.parse(l); } catch { console.log('BAD', l.slice(0, 200)); continue; }
    const k = o.type + (o.subtype ? '/' + o.subtype : '') + (o.event?.type ? ':' + o.event.type : '');
    seen[k] = (seen[k] || 0) + 1;
    if (['user', 'result', 'control_response', 'rate_limit_event', 'command_lifecycle'].includes(o.type) || o.subtype === 'init') {
      console.log(((Date.now() - t0) / 1000).toFixed(1), process.env.FULL ? JSON.stringify(o) : JSON.stringify(o).slice(0, 900));
    }
    if (o.type === 'result' && ++results === 2) p.stdin.end();
  }
});
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
send({ type: 'control_request', request_id: 'u1', request: { subtype: 'get_usage' } });
send({ type: 'user', uuid: '11111111-1111-4111-8111-111111111111', priority: 'next', message: { role: 'user', content: 'Reply with exactly: OK' } });
setTimeout(() => send({ type: 'user', uuid: '22222222-2222-4222-8222-222222222222', priority: 'later', message: { role: 'user', content: 'Reply with exactly: SECOND' } }), 300);
setTimeout(() => send({ type: 'control_request', request_id: 'c1', request: { subtype: 'get_context_usage' } }), 500);
p.on('exit', (c, s) => console.log('exit', c, s, JSON.stringify(seen)));
setTimeout(() => p.kill(), 90000).unref();
