#!/usr/bin/env node
// Local owner commands. The admin token stays on this machine and is never printed.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { renderUnicodeCompact } from 'uqr';

const state = process.env.AGENT_COMPANY_STATE || join(homedir(), '.local/state/agent-company');
try {
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(join(state, 'hq.config.json'), 'utf8')); } catch { /* defaults */ }
  const token = readFileSync(join(state, 'api-token'), 'utf8').trim();
  const base = `http://127.0.0.1:${cfg.port || 7420}`;
  const pair = process.argv[2] === 'pair';
  const res = await fetch(`${base}${pair ? '/api/devices/pair' : '/api/setup'}`, {
    method: pair ? 'POST' : 'GET', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error('server unavailable');
  const v = await res.json();
  if (pair) {
    console.log(v.code);
    if (v.link) { console.log(renderUnicodeCompact(v.link, { border: 2 })); console.log(v.link); }
    console.log(`Expires: ${new Date(v.expires_at).toISOString()}`);
  } else {
    console.log('Server: connected');
    console.log(`Setup: ${v.pending ? v.started ? 'continue in the manager conversation' : 'open the app to begin' : 'complete'}`);
  }
} catch {
  console.error('The company server is unavailable. Start it and run company status again.');
  process.exitCode = 1;
}
