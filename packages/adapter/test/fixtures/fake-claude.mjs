#!/usr/bin/env node
// Minimal stand-in for `claude -p --input-format stream-json ...` (wire shapes
// as observed on 2.1.303). Replies "ECHO:<text>" to each user line, one turn at
// a time, honoring the queue. FAKE_CLAUDE_TURN_MS slows a turn down.
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const sid = args[args.indexOf('--session-id') + 1] || args[args.indexOf('--resume') + 1] || randomUUID();
const turnMs = Number(process.env.FAKE_CLAUDE_TURN_MS ?? 20);
if (process.env.FAKE_CLAUDE_IN_USE) {
  process.stderr.write(`Error: Session ID ${sid} is already in use.\n`);
  process.exit(1);
}
const dieMidTurn = !!process.env.FAKE_CLAUDE_DIE_MIDTURN;
const out = (o) => process.stdout.write(JSON.stringify({ ...o, session_id: sid }) + '\n');
const queue = [];
let busy = false;
let inited = false;
let current = null;

function runNext() {
  if (busy || !queue.length) return;
  const m = queue.shift();
  busy = true;
  current = m;
  if (!inited) {
    inited = true;
    out({ type: 'system', subtype: 'init', cwd: process.cwd(), model: 'fake-haiku', tools: ['Bash'],
      permissionMode: 'bypassPermissions', claude_code_version: '0.0.0-fake', messaging_socket_path: '/tmp/cc-socks/0.sock' });
  }
  out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'started', uuid: randomUUID() });
  out({ type: 'user', message: m.message, parent_tool_use_id: null, uuid: m.uuid, isReplay: true });
  const text = 'ECHO:' + (typeof m.message.content === 'string' ? m.message.content : '');
  out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
  if (dieMidTurn) { setTimeout(() => process.exit(3), 30); return; }
  m.timer = setTimeout(() => {
    out({ type: 'assistant', message: { id: 'msg_' + m.uuid.slice(0, 8), role: 'assistant', content: [{ type: 'text', text }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: text, num_turns: 1, total_cost_usd: 0,
      modelUsage: { 'fake-haiku': { contextWindow: 200000 } } });
    out({ type: 'command_lifecycle', command_uuid: m.uuid, state: 'completed', uuid: randomUUID() });
    busy = false; current = null;
    runNext();
  }, turnMs);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let o;
  try { o = JSON.parse(line); } catch { return; }
  if (o.type === 'user') {
    out({ type: 'command_lifecycle', command_uuid: o.uuid, state: 'queued', uuid: randomUUID() });
    if (o.priority === 'now') queue.unshift(o); else queue.push(o);
    runNext();
  } else if (o.type === 'control_request') {
    const st = o.request?.subtype;
    let response = {};
    if (st === 'get_usage') response = { rate_limits: { five_hour: { utilization: 12, resets_at: '2026-10-20T05:00:00Z' }, seven_day: { utilization: 40, resets_at: '2026-10-24T04:00:00Z' } } };
    else if (st === 'get_context_usage') response = { totalTokens: 1234, maxTokens: 200000 };
    else if (st === 'interrupt') {
      response = { still_queued: [] };
      if (current) {
        clearTimeout(current.timer);
        out({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1 });
        busy = false; current = null;
      }
    }
    out({ type: 'control_response', response: { subtype: 'success', request_id: o.request_id, response } });
  }
});
rl.on('close', () => {
  const wait = () => (busy || queue.length ? setTimeout(wait, 10) : process.exit(0));
  wait();
});
process.on('SIGTERM', () => process.exit(143));
