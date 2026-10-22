#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const notice = (method, params) => send({ method, params });
let turn = 0, active = null;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line), p = m.params ?? {};
  if (process.env.CODEX_TEST_LOG) appendFileSync(process.env.CODEX_TEST_LOG, line + '\n');
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case 'initialize': reply({}); break;
    case 'account/read': reply({ account: { type: process.env.CODEX_TEST_AUTH ?? 'chatgpt' } }); break;
    case 'account/rateLimits/read': reply({ rateLimits: { primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1900000000 } } }); break;
    case 'thread/start': reply({ thread: { id: 'thread-test' }, model: 'test-codex' }); break;
    case 'thread/resume': reply({ thread: { id: p.threadId }, model: 'test-codex' }); break;
    case 'thread/read': reply({ thread: { id: p.threadId } }); break;
    case 'turn/start': {
      const id = `turn-${++turn}`, text = p.input[0].text;
      active = id;
      reply({ turn: { id, status: 'inProgress' } });
      notice('turn/started', { threadId: 'thread-test', turn: { id, status: 'inProgress' } });
      if (text === 'hang') break;
      setTimeout(() => {
        if (active !== id) return;
        if (text === 'fail') {
          notice('turn/completed', { threadId: 'thread-test', turn: { id, status: 'failed', error: { message: 'quota exceeded' } } });
        } else {
          const item = { type: 'mcpToolCall', id: `tool-${id}`, server: 'company', tool: 'recall', arguments: { query: 'רקע' } };
          notice('item/started', { threadId: 'thread-test', item });
          notice('item/completed', { threadId: 'thread-test', item: { ...item, status: 'completed' } });
          notice('item/agentMessage/delta', { threadId: 'thread-test', itemId: id, delta: `תשובה: ${text}` });
          notice('item/completed', { threadId: 'thread-test', item: { type: 'agentMessage', id, text: `תשובה: ${text}` } });
          notice('turn/completed', { threadId: 'thread-test', turn: { id, status: 'completed' } });
        }
        active = null;
      }, 25);
      break;
    }
    case 'turn/interrupt': {
      reply({});
      if (active) notice('turn/completed', { threadId: 'thread-test', turn: { id: active, status: 'interrupted' } });
      active = null; break;
    }
  }
});
