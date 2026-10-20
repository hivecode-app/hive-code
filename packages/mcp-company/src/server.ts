#!/usr/bin/env node
// `company-mcp`: stdio MCP server, one per shift. stdout carries protocol
// only; every log line goes to stderr.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ENV, LineSplitter, loadNames, shiftDir, statePaths } from '@company/shared';
import { postJson } from './hq-client.ts';
import type { HqTarget } from './hq-client.ts';
import { recall } from './recall.ts';
import { createServer } from './rpc.ts';
import { buildTools } from './tools.ts';
import { Wal } from './wal.ts';

const OPS_TIMEOUT_MS = 10_000;
const env = process.env;
const log = (msg: string) => { process.stderr.write(`[company-mcp] ${msg}\n`); };

const paths = statePaths(homedir(), env[ENV.stateDir] || undefined);
const shift = env[ENV.shift] || '_unknown';
const identity = env[ENV.identity] || 'unknown';
const target: HqTarget = env[ENV.hqUrl] ? { url: env[ENV.hqUrl] } : { socketPath: `${paths.root}/hq.sock` };

const wal = new Wal({
  dir: `${shiftDir(paths, shift)}/wal`,
  transport: (entry) => postJson(target, '/v1/ops', entry, OPS_TIMEOUT_MS),
  log,
});
if (wal.pending().length) log(`replaying ${wal.pending().length} pending WAL entries`);
wal.start();

const repo = env[ENV.repo] || process.cwd();
const server = createServer({
  ctx: { identity, shift, sessionId: env[ENV.sessionId] || null },
  // The names in the tool descriptions (the owner, the manager) come from the company's org.yaml.
  tools: buildTools(loadNames(join(repo, 'company'))),
  append: (e) => wal.append(e),
  waitSettled: (id, ms) => wal.waitSettled(id, ms),
  recall: (req) => recall(req, {
    transport: (r, timeoutMs) => postJson(target, '/v1/recall', r, timeoutMs),
    repo,
    stateRoot: paths.root,
    log,
  }),
  log,
});

const inFlight = new Set<Promise<void>>();
const splitter = new LineSplitter((line) => {
  const p = server.handle(line).then((reply) => {
    if (reply !== null) process.stdout.write(reply + '\n');
  }, (e) => log(`handler crashed: ${e instanceof Error ? e.stack : String(e)}`))
    .finally(() => inFlight.delete(p));
  inFlight.add(p);
}, undefined, () => log('dropped an over-long input line'));

let closing = false;
async function shutdown(why: string): Promise<void> {
  if (closing) return;
  closing = true;
  await Promise.race([Promise.all(inFlight), new Promise((r) => setTimeout(r, 5000))]);
  log(`shutting down (${why}); ${wal.pending().length} entries left in WAL`);
  await Promise.race([wal.stop(), new Promise((r) => setTimeout(r, 1000))]);
  process.exit(0);
}

process.stdin.on('data', (c: Buffer) => {
  try { splitter.push(c); } catch (e) { log(`input error: ${e instanceof Error ? e.message : String(e)}`); }
});
process.stdin.on('end', () => { try { splitter.end(); } catch { /* ignore */ } void shutdown('stdin closed'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });
