// One `claude -p` stream-json child held open for the whole shift.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { LineSplitter, type EngineEvent, type Priority } from '@company/shared';
import { normalize, type LifecycleSignal, type StreamState } from './normalize.ts';
import { buildArgs, buildEnv, type ShiftSpec } from './spec.ts';
import { resolveClaudeBin } from './binary.ts';
import { newUuid } from './ids.ts';

export interface ClaudeProcessHandlers {
  onEvent?: (ev: EngineEvent) => void;
  onLifecycle?: (l: LifecycleSignal) => void;
  /** Every stdout object, before normalization (for the raw archive / debugging). */
  onRaw?: (o: unknown) => void;
  onExit?: (code: number | null, signal: string | null) => void;
}

export function procStartOf(pid: number): string | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return s.slice(s.lastIndexOf(')') + 2).split(' ')[19] ?? null;   // field 22: starttime
  } catch { return null; }
}

interface Pending { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }

export class ClaudeProcess {
  readonly child: ChildProcess;
  readonly pid: number;
  /** "Session ID ... is already in use" etc., classified from stderr (bet 1). */
  get failureReason(): string | null {
    if (this.spawnError) return 'spawn_failed';
    if (!this.sawInit && /Session ID \S+ is already in use/i.test(this.stderrTail)) return 'session_id_in_use';
    return null;
  }
  readonly procStart: string | null;
  readonly spec: ShiftSpec;
  exited = false;
  /** Set on spawn failure (ENOENT/EACCES); `exited` follows on 'close'. */
  spawnError: string | null = null;
  exitCode: number | null = null;
  exitSignal: string | null = null;
  stderrTail = '';
  private readonly h: ClaudeProcessHandlers;
  private readonly pending = new Map<string, Pending>();
  private reqSeq = 0;
  private readonly stream: StreamState = {};
  private readonly queue: EngineEvent[] = [];
  private waiters: Array<(r: IteratorResult<EngineEvent>) => void> = [];
  private readonly exitPromise: Promise<void>;

  constructor(spec: ShiftSpec, handlers: ClaudeProcessHandlers = {}, spawnFn: typeof spawn = spawn) {
    this.spec = spec;
    this.h = handlers;
    const bin = spec.claudeBin ?? resolveClaudeBin();
    this.child = spawnFn(bin, buildArgs(spec), {
      cwd: spec.cwd, env: buildEnv(spec), stdio: ['pipe', 'pipe', 'pipe'], detached: true,
    });
    this.pid = this.child.pid ?? -1;
    this.procStart = this.pid > 0 ? procStartOf(this.pid) : null;
    const split = new LineSplitter((line) => this.onLine(line), undefined, () => {
      this.stderrTail += '\n[adapter] dropped oversized stdout line';
    });
    this.child.stdout!.on('data', (d: Buffer) => { try { split.push(d); } catch { /* logged via onLine */ } });
    this.child.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-65536);
    });
    this.child.stdin!.on('error', () => { /* EPIPE after exit; surfaced via exit */ });
    this.exitPromise = new Promise((res) => {
      // 'close' (not 'exit'): fires after stdout is drained, and also after a
      // spawn error, which emits no 'exit' at all.
      let done = false;
      // 'close' waits for every holder of claude's stdio (an MCP child may linger):
      // force finalization 3s after 'exit' if it never comes.
      this.child.on('exit', (code, signal) => {
        this.stdinDead = true;
        setTimeout(() => {
          if (done) return;
          this.child.stdout?.removeAllListeners('data');   // nothing may arrive after finalization
          this.child.stdout?.destroy();
          this.child.emit('close', code, signal);
        }, 3000).unref();
      });
      this.child.on('close', (code, signal) => {
        if (done) return;
        done = true;
        try { split.end(); } catch { /* ignore */ }
        this.exited = true; this.stdinDead = true; this.exitCode = code; this.exitSignal = signal;
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('claude exited')); }
        this.pending.clear();
        for (const w of this.waiters) w({ value: undefined, done: true });
        this.waiters = [];
        this.h.onExit?.(code, signal);
        res();
      });
      this.child.on('error', (e) => {
        this.stderrTail += `\n[spawn] ${e.message}`;
        if (this.pid <= 0) { this.spawnError = e.message; this.stdinDead = true; }
      });
    });
  }

  private onLine(line: string): void {
    let o: any;
    try { o = JSON.parse(line); } catch { this.stderrTail += `\n[adapter] non-JSON stdout: ${line.slice(0, 200)}`; return; }
    this.h.onRaw?.(o);
    const n = normalize(o, this.stream);
    if (o?.type === 'system' && o.subtype === 'init') this.sawInit = true;
    if (n.control) {
      const p = this.pending.get(n.control.requestId);
      if (p) {
        this.pending.delete(n.control.requestId); clearTimeout(p.timer);
        if (n.control.ok) p.resolve(n.control.response ?? null);
        else p.reject(new Error(n.control.error ?? 'control request failed'));
      }
    }
    if (n.inboundControl) this.answerInbound(n.inboundControl.requestId, n.inboundControl.subtype, n.inboundControl.request);
    if (n.lifecycle) this.h.onLifecycle?.(n.lifecycle);
    for (const ev of n.events) {
      this.h.onEvent?.(ev);
      const w = this.waiters.shift();
      if (w) w({ value: ev, done: false }); else this.queue.push(ev);
      if (this.queue.length > 10_000) this.queue.shift();   // unconsumed iterator: bounded
    }
  }

  /** bypassPermissions should never ask, but if it does, allow (multica "control auto-allow"). */
  private answerInbound(requestId: string, subtype: string, req: any): void {
    const response = subtype === 'can_use_tool'
      ? { behavior: 'allow', updatedInput: req.input ?? {} }
      : {};
    const ok = subtype === 'can_use_tool' || subtype === 'hook_callback';
    this.write(ok
      ? { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }
      : { type: 'control_response', response: { subtype: 'error', request_id: requestId, error: `unsupported ${subtype}` } });
  }

  private stdinDead = false;
  private sawInit = false;
  private write(o: unknown): boolean {
    if (this.exited || this.stdinDead || !this.child.stdin || this.child.stdin.destroyed) return false;
    return this.child.stdin.write(JSON.stringify(o) + '\n') || true;
  }

  /** stdin user line (B.4). Returns the uuid the CLI will echo. Throws if stdin is gone. */
  sendUser(text: string, priority: Priority = 'next', uuid: string = newUuid()): string {
    const ok = this.write({ type: 'user', uuid, priority, parent_tool_use_id: null,
      message: { role: 'user', content: text } });
    if (!ok) throw new Error('claude stdin closed');
    return uuid;
  }

  control<T = unknown>(subtype: string, extra: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    const id = `ac-${++this.reqSeq}`;
    return new Promise<T>((resolve, reject) => {
      if (!this.write({ type: 'control_request', request_id: id, request: { subtype, ...extra } })) {
        reject(new Error('claude stdin closed')); return;
      }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${subtype} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
  }

  interrupt(): Promise<unknown> { return this.control('interrupt', {}, 10_000); }
  usage(): Promise<any> { return this.control('get_usage', {}, 20_000); }
  contextUsage(): Promise<any> { return this.control('get_context_usage', {}, 15_000); }

  events(): AsyncIterable<EngineEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<EngineEvent>> => {
          const v = this.queue.shift();
          if (v) return Promise.resolve({ value: v, done: false });
          if (this.exited) return Promise.resolve({ value: undefined, done: true });
          return new Promise((r) => this.waiters.push(r));
        },
      }),
    };
  }

  waitExit(): Promise<void> { return this.exitPromise; }

  /** Close stdin, wait graceMs, then SIGTERM the process group, then SIGKILL. */
  async stop(graceMs = 5000): Promise<void> {
    if (this.exited) return;
    try { this.child.stdin?.end(); } catch { /* ignore */ }
    const race = (ms: number) => Promise.race([this.exitPromise, new Promise((r) => setTimeout(r, ms).unref())]);
    await race(graceMs);
    if (this.exited) return;
    this.killGroup('SIGTERM');
    await race(3000);
    if (!this.exited) this.killGroup('SIGKILL');
    await race(2000);
  }

  killGroup(sig: NodeJS.Signals): void {
    if (this.pid <= 0) return;   // never process.kill(-(-1)) == kill(1)
    try { process.kill(-this.pid, sig); } catch { try { this.child.kill(sig); } catch { /* gone */ } }
  }
}
