// B.6 Engine: the only interface the rest of the company uses to talk to Claude Code.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContextReply, EngineEvent, Priority, UsageReply } from '@company/shared';
import { ClaudeProcess, type ClaudeProcessHandlers } from './claude-process.ts';
import { resolveClaudeBin } from './binary.ts';
import { readTranscript, type Archive } from './transcript.ts';
import { injectForeign, type InjectOptions } from './foreign.ts';
import { buildEnv, type ShiftSpec } from './spec.ts';
import { newUuid } from './ids.ts';
import { extractYaml, seancePrompt } from './seance.ts';

export interface Account {
  name: string;
  /** CLAUDE_CODE_OAUTH_TOKEN; absent = the CLI's own login. */
  oauthToken?: string;
  /** Managed CLAUDE_CONFIG_DIR; absent = the CLI's own ~/.claude login. */
  configDir?: string;
}

export interface Engine {
  start(spec: ShiftSpec, handlers?: ClaudeProcessHandlers): ClaudeProcess;
  send(shift: ClaudeProcess, text: string, priority?: Priority, uuid?: string): string;
  interrupt(shift: ClaudeProcess): Promise<unknown>;
  usage(account: Account): Promise<UsageReply>;
  contextUsage(shift: ClaudeProcess): Promise<ContextReply>;
  events(shift: ClaudeProcess): AsyncIterable<EngineEvent>;
  readTranscript(sessionId: string, cwd?: string): Promise<Archive>;
  injectForeign(pid: number, msg: string, o?: InjectOptions): Promise<{ uuid: string }>;
  fork(sessionId: string, question: string, cwd: string): Promise<string>;
  seanceHandoff(sessionId: string, cwd: string, identity: string, shiftNo: number | string): Promise<string>;
}

export function toUsageReply(raw: any): UsageReply {
  const rl = raw?.rate_limits ?? {};
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  return {
    fiveHour: num(rl.five_hour?.utilization),
    sevenDay: num(rl.seven_day?.utilization),
    resetsAt: { fiveHour: rl.five_hour?.resets_at, sevenDay: rl.seven_day?.resets_at },
    raw,
  };
}

export function toContextReply(raw: any): ContextReply {
  return {
    totalTokens: typeof raw?.totalTokens === 'number' ? raw.totalTokens : null,
    maxTokens: typeof raw?.maxTokens === 'number' ? raw.maxTokens : null,
    raw,
  };
}

export interface ClaudeEngineOptions {
  claudeBin?: string;
  stateRoot: string;
  /** cwd for usage probes (no inference happens there). */
  scratchDir?: string;
}

export class ClaudeEngine implements Engine {
  private readonly bin: string;
  private readonly o: ClaudeEngineOptions;
  constructor(o: ClaudeEngineOptions) {
    this.o = o;
    this.bin = o.claudeBin ?? resolveClaudeBin();
  }

  start(spec: ShiftSpec, handlers?: ClaudeProcessHandlers): ClaudeProcess {
    return new ClaudeProcess({ ...spec, claudeBin: spec.claudeBin ?? this.bin }, handlers);
  }
  send(shift: ClaudeProcess, text: string, priority: Priority = 'next', uuid?: string): string {
    return shift.sendUser(text, priority, uuid);
  }
  interrupt(shift: ClaudeProcess): Promise<unknown> { return shift.interrupt(); }
  async contextUsage(shift: ClaudeProcess): Promise<ContextReply> { return toContextReply(await shift.contextUsage()); }
  events(shift: ClaudeProcess): AsyncIterable<EngineEvent> { return shift.events(); }
  readTranscript(sessionId: string, cwd?: string): Promise<Archive> { return readTranscript(sessionId, { cwd }); }
  injectForeign(pid: number, msg: string, o?: InjectOptions): Promise<{ uuid: string }> { return injectForeign(pid, msg, o); }

  /** get_usage before any prompt: no inference, ~4s, $0 (research/05 exp. 2). */
  async usage(account: Account): Promise<UsageReply> {
    const dir = this.o.scratchDir ?? mkdtempSync(join(tmpdir(), 'company-usage-'));
    const settingsFile = join(dir, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ autoMemoryEnabled: false }));
    const p = new ClaudeProcess({
      identity: '_usage', shift: '_usage', sessionId: newUuid(), resume: false, cwd: dir, settingsFile,
      oauthToken: account.oauthToken, configDir: account.configDir, stateRoot: this.o.stateRoot, claudeBin: this.bin, model: 'haiku',
    });
    try {
      return toUsageReply(await p.usage());
    } finally {
      await p.stop(500);
      if (!this.o.scratchDir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Seance handoff with the schema inline (bet 1). Returns YAML. */
  async seanceHandoff(sessionId: string, cwd: string, identity: string, shiftNo: number | string): Promise<string> {
    return extractYaml(await this.fork(sessionId, seancePrompt(identity, shiftNo), cwd));
  }

  /** Seance (B.3.2): ask a closed session a question without touching it. */
  fork(sessionId: string, question: string, cwd: string): Promise<string> {
    const spec = { identity: '_seance', shift: '_seance', sessionId, resume: true, cwd, settingsFile: '',
      stateRoot: this.o.stateRoot } as ShiftSpec;
    return new Promise((resolve, reject) => {
      execFile(this.bin, ['-p', '--resume', sessionId, '--fork-session', '--output-format', 'json',
        '--setting-sources', 'project,local', '--permission-mode', 'bypassPermissions',
        '--disallowedTools', 'AskUserQuestion', '--strict-mcp-config', '--', question],
      { cwd, env: buildEnv(spec), timeout: 600_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) { reject(err); return; }
        // A turn without a `result` is a failure, never an empty success (bet 1).
        try {
          const o = JSON.parse(stdout);
          if (o?.type !== 'result' || typeof o.result !== 'string' || o.is_error) reject(new Error(`fork: no result (${o?.subtype ?? 'none'})`));
          else resolve(o.result);
        } catch { reject(new Error(`fork: no result; stdout=${stdout.slice(0, 200)}`)); }
      });
    });
  }
}
