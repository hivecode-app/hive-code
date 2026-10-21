import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IdentityId, ShiftId } from '@company/shared';

export interface ShiftSpec {
  identity: IdentityId;
  shift: ShiftId;
  /** Deterministic session id (uuidv5). */
  sessionId: string;
  /** true: --resume <sessionId>; false: --session-id <sessionId>. */
  resume: boolean;
  cwd: string;
  model?: string;
  effort?: string;
  /** L0 + consolidated L1 file (B.3). */
  appendSystemPromptFile?: string;
  /** Path of the generated mcp config (company + browser). */
  mcpConfigFile?: string;
  /** Path of the generated --settings file. */
  settingsFile: string;
  /** Account token (B.7); absent = the CLI's own login. */
  oauthToken?: string;
  /** Managed config dir of a second account (B.7, issue #25); absent = the CLI's own ~/.claude login. */
  configDir?: string;
  /** Extra env for the child (COMPANY_* is filled in by the adapter). */
  env?: Record<string, string>;
  stateRoot: string;
  claudeBin?: string;
  extraArgs?: string[];
}

/** Hook events we register; all are `command` hooks that spool and exit 0 (B.5). */
export const SPOOLED_HOOK_EVENTS = [
  'SessionStart', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd', 'Notification',
  'PostToolUse',
] as const;

/** Tools the PreToolUse guard checks (hooks guard.ts GUARD_MATCHER; kept here so the adapter needs no hooks import). */
export const PRE_TOOL_USE_MATCHER = 'Write|Edit|NotebookEdit|Bash';

export interface SettingsInput {
  /** Command prefix that runs the hooks CLI, e.g. `node /abs/packages/hooks/src/cli.ts`. */
  hookCommand: string;
  /** PermissionRequest command hooks (B.3: the owner's permission-authority.mjs). */
  permissionRequestCommands?: string[];
  /** PostToolUse matcher for spooling; default SendMessage|Bash. */
  postToolUseMatcher?: string;
  /** CLAUDE.md files to skip. Default: the owner's global ~/.claude/CLAUDE.md, which
   *  otherwise loads as an ANCESTOR project file for any cwd under $HOME even with
   *  --setting-sources project,local (canary setting_sources, 2.1.303). */
  claudeMdExcludes?: string[];
  extra?: Record<string, unknown>;
}

type HookEntry = { matcher?: string; hooks: Array<{ type: 'command'; command: string; timeout?: number }> };

/** Generated --settings (B.5): crossSessionInbound accept, no auto-memory, command hooks only. */
export function buildSettings(inp: SettingsInput): Record<string, unknown> {
  const cmd = (ev: string): string => `${inp.hookCommand} ${ev}`;
  const hooks: Record<string, HookEntry[]> = {};
  for (const ev of SPOOLED_HOOK_EVENTS) {
    const entry: HookEntry = { hooks: [{ type: 'command', command: cmd(ev), timeout: 10 }] };
    if (ev === 'PostToolUse') entry.matcher = inp.postToolUseMatcher ?? 'SendMessage|Bash';
    hooks[ev] = [entry];
  }
  // #115: the main-checkout write guard (packages/hooks/src/guard.ts) answers before the tool runs.
  hooks.PreToolUse = [{ matcher: PRE_TOOL_USE_MATCHER, hooks: [{ type: 'command', command: cmd('PreToolUse'), timeout: 10 }] }];
  if (inp.permissionRequestCommands?.length) {
    hooks.PermissionRequest = [{ hooks: inp.permissionRequestCommands.map((c) => ({ type: 'command' as const, command: c, timeout: 15 })) }];
  }
  const out: Record<string, unknown> = {
    crossSessionInbound: 'accept',
    autoMemoryEnabled: false,
    claudeMdExcludes: inp.claudeMdExcludes ?? [join(homedir(), '.claude', 'CLAUDE.md')],
    env: { DISABLE_AUTOUPDATER: '1' },
    hooks,
    ...inp.extra,
  };
  // Never http (or anything but command): a stuck hq added 30s to EVERY tool
  // call (bet 3). Checked on the final object so `extra` cannot sneak one in.
  for (const [ev, entries] of Object.entries((out.hooks ?? {}) as Record<string, HookEntry[]>)) {
    for (const e of entries) for (const h of e.hooks) {
      if ((h as { type: string }).type !== 'command') throw new Error(`hook ${ev}: only command hooks are allowed`);
    }
  }
  return out;
}

/** argv for one shift (B.5). */
export function buildArgs(spec: ShiftSpec): string[] {
  const a = [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages',
    spec.resume ? '--resume' : '--session-id', spec.sessionId,
    '--setting-sources', 'project,local',
    '--settings', spec.settingsFile,
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', 'AskUserQuestion',
    '--strict-mcp-config',
  ];
  if (spec.mcpConfigFile) a.push('--mcp-config', spec.mcpConfigFile);
  if (spec.appendSystemPromptFile) a.push('--append-system-prompt-file', spec.appendSystemPromptFile);
  if (spec.model) a.push('--model', spec.model);
  if (spec.effort) a.push('--effort', spec.effort);
  if (spec.extraArgs) a.push(...spec.extraArgs);
  return a;
}

export function buildEnv(spec: ShiftSpec, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // Never let a parent session's identity leak into a worker.
  for (const k of Object.keys(env)) {
    if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE' || k === 'CLAUDE_CONFIG_DIR') delete env[k];
  }
  Object.assign(env, {
    DISABLE_AUTOUPDATER: '1',
    COMPANY_IDENTITY: spec.identity,
    COMPANY_SHIFT: spec.shift,
    COMPANY_SESSION_ID: spec.sessionId,
    COMPANY_STATE_DIR: spec.stateRoot,
  }, spec.env ?? {});
  if (spec.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = spec.oauthToken;
  if (spec.configDir) env.CLAUDE_CONFIG_DIR = spec.configDir;
  return env;
}

/** --mcp-config content for the per-shift company server (+ optional others; `company` is always ours). */
export function buildMcpConfig(companyCommand: string[], others: Record<string, unknown> = {}): Record<string, unknown> {
  const [command, ...args] = companyCommand;
  return { mcpServers: { ...others, company: { type: 'stdio', command, args } } };
}

/**
 * The owner's user-scope MCP servers (`mcpServers` in ~/.claude.json, e.g. `browser`). Shifts run with
 * --strict-mcp-config and a managed CLAUDE_CONFIG_DIR, so the CLI never reads them by itself: without
 * this, no worker has a browser (principle 10). Read only, never written (dir-0016). Missing or broken
 * file: no extra servers, and the shift still starts with `company`.
 */
export function ownerMcpServers(
  claudeJson = join(homedir(), '.claude.json'), warn: (msg: string) => void = () => {},
): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(claudeJson, 'utf8')); } catch (e) {
    warn(`${claudeJson}: ${(e as Error).message}; the shift starts without the owner's MCP servers (no browser)`);
    return {};
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  if (servers === undefined) return {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    warn(`${claudeJson}: mcpServers is not an object; the shift starts without the owner's MCP servers`);
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    if (name !== 'company' && cfg && typeof cfg === 'object') out[name] = cfg;
  }
  return out;
}
