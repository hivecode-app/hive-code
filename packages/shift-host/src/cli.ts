#!/usr/bin/env node
// company-shift-host --identity <id> --shift <id-n> --cwd <dir> [options]
// Meant to run as its own unit: systemd-run --user --unit=shift-<identity>-<n> ...
import { parseArgs } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shiftDir, statePaths } from '@company/shared';
import { buildMcpConfig, buildSettings, shiftSessionId, type ShiftSpec } from '@company/adapter';
import { ShiftHost } from './host.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');

const OPTIONS = {
    identity: { type: 'string' },
    shift: { type: 'string' },
    'shift-no': { type: 'string' },              // from the store, never recomputed (bet 1)
    epoch: { type: 'string' },
    cwd: { type: 'string' },
    'session-id': { type: 'string' },
    resume: { type: 'boolean' },
    model: { type: 'string' },
    effort: { type: 'string' },
    'append-system-prompt-file': { type: 'string' },
    'mcp-config': { type: 'string' },
    'browser-mcp': { type: 'string' },          // JSON of an extra mcpServers entry
    settings: { type: 'string' },               // use this file instead of generating
    'permission-hook': { type: 'string', multiple: true },
    'state-dir': { type: 'string' },
    'claude-bin': { type: 'string' },
    'oauth-token-file': { type: 'string' },
    'company-repo': { type: 'string' },
    'linger-ms': { type: 'string' },
    'args-file': { type: 'string' },            // JSON {flag: value} written by hq (template unit)
} as const;

const { values: cliValues } = parseArgs({ options: OPTIONS, strict: true });
// --args-file: the persistent systemd template passes only this; flags on the
// command line still win.
let fileValues: Record<string, unknown> = {};
if (cliValues['args-file']) {
  try { fileValues = JSON.parse((await import('node:fs')).readFileSync(cliValues['args-file'], 'utf8')) as Record<string, unknown>; }
  catch (e) { process.stderr.write(`company-shift-host: args-file: ${(e as Error).message}\n`); process.exit(2); }
  if (typeof fileValues !== 'object' || fileValues === null || Array.isArray(fileValues)) {
    process.stderr.write('company-shift-host: args-file must be a JSON object\n'); process.exit(2);
  }
}
for (const [k, val] of Object.entries(fileValues)) {
  const o = (OPTIONS as Record<string, { type: string; multiple?: boolean }>)[k];
  if (!o || k === 'args-file') die(`args-file: unknown key ${k}`);
  const ok = o.multiple ? Array.isArray(val) && val.every((x) => typeof x === 'string')
    : o.type === 'boolean' ? typeof val === 'boolean' : typeof val === 'string';
  if (!ok) die(`args-file: ${k} must be ${o.multiple ? 'string[]' : o.type}`);
}
const v = { ...fileValues, ...cliValues } as typeof cliValues;

function die(msg: string): never { process.stderr.write(`company-shift-host: ${msg}\n`); process.exit(2); }

const identity = v.identity ?? die('--identity required');
const epochNo = Number(v.epoch ?? 0);
// hq should always pass --shift (= the systemd instance name %i, where host-args.json lives).
const shift = v.shift ?? (v['shift-no'] ? (epochNo ? `${identity}-e${epochNo}-${v['shift-no']}` : `${identity}-${v['shift-no']}`) : die('--shift or --shift-no required'));
const cwd = resolve(v.cwd ?? die('--cwd required'));
const stateRoot = v['state-dir'] ?? process.env.COMPANY_STATE_DIR ?? join(homedir(), '.local/state/agent-company');
// The shift number comes from the store (hq), explicitly. It is never derived
// from the shift name or local files: a reused number collides with an old
// transcript ("Session ID already in use") and the shift silently does nothing.
const sessionId = v['session-id']
  ?? (v['shift-no'] ? shiftSessionId(identity, Number(v['shift-no']), epochNo) : die('--session-id or --shift-no (from the store) required'));
const dir = shiftDir(statePaths('', stateRoot), shift);
mkdirSync(dir, { recursive: true, mode: 0o700 });

const node = process.execPath;
const hookCmd = `${JSON.stringify(node)} ${JSON.stringify(join(repoRoot, 'packages/hooks/src/cli.ts'))} hook`;

let settingsFile = v.settings;
if (!settingsFile) {
  settingsFile = join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify(buildSettings({
    hookCommand: hookCmd,
    permissionRequestCommands: v['permission-hook'] ?? defaultPermissionHooks(),
  }), null, 2));
}

let mcpConfigFile = v['mcp-config'];
if (!mcpConfigFile) {
  mcpConfigFile = join(dir, 'mcp.json');
  const others = v['browser-mcp'] ? { browser: JSON.parse(v['browser-mcp']) } : {};
  writeFileSync(mcpConfigFile, JSON.stringify(buildMcpConfig([node, join(repoRoot, 'packages/mcp-company/src/server.ts')], others), null, 2));
}

let oauthToken: string | undefined;
if (v['oauth-token-file']) {
  const { readFileSync } = await import('node:fs');
  oauthToken = readFileSync(v['oauth-token-file'], 'utf8').trim();
}

const spec: ShiftSpec = {
  identity, shift, sessionId, resume: v.resume === true, cwd, stateRoot,
  model: v.model, effort: v.effort,
  appendSystemPromptFile: v['append-system-prompt-file'],
  mcpConfigFile, settingsFile, oauthToken,
  claudeBin: v['claude-bin'],
  env: { COMPANY_REPO: v['company-repo'] ?? process.env.COMPANY_REPO ?? repoRoot },
};

/** B.3: the owner's permission-authority hook rides along via --settings. */
function defaultPermissionHooks(): string[] {
  const p = join(homedir(), '.claude/hooks/permission-authority.mjs');
  return existsSync(p) ? [`${JSON.stringify(node)} ${JSON.stringify(p)}`] : [];
}

const host = new ShiftHost({
  spec,
  lingerMs: v['linger-ms'] ? Number(v['linger-ms']) : undefined,
  onExit: (code) => process.exit(code),
});
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { void host.stop(5000); });
}
process.on('SIGHUP', () => { /* survive terminal/hq going away */ });
try { await host.start(); } catch (e) {
  const m = (e as Error).message;
  process.stderr.write(`company-shift-host: ${m}\n`);
  process.exit(/held by host pid|another shift-host/.test(m) ? 75 : 2);
}
process.stderr.write(`company-shift-host: ${shift} session ${sessionId} socket ${host.socketPath}\n`);
