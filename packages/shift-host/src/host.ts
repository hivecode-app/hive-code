// shift-host: holds claude's stdio for the shift lifetime, logs every event
// durably, and serves the shift protocol on a unix socket (B.5).
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, renameSync, writeSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  SHIFT_PROTOCOL_VERSION, LineSplitter, ProtocolError, decodeHqFrame, encodeFrame,
  shiftDir, shiftLogPath, shiftSocketPath, statePaths,
  type DeliveryState, type EngineEvent, type HostInfo, type HostState, type HostToHq, type HqToHost,
  type LoggedFrame, type ErrorCode, type SendReply,
} from '@company/shared';
import { ClaudeProcess, CodexProcess, consumeSegments, pendingQueued, procStartOf, readTranscript, toContextReply, toUsageReply, type ShiftSpec, type WorkerProcess } from '@company/adapter';
import { DurableLog, type FrameInput } from './log.ts';
import { SpoolReader } from './spool.ts';
import { safeToInterrupt } from './safe-tools.ts';

export interface HostOptions {
  spec: ShiftSpec;
  /** Keep serving this long after claude exits, so hq can read the tail. */
  lingerMs?: number;
  /** Factory for tests (fake claude). */
  makeProcess?: (spec: ShiftSpec, h: ConstructorParameters<typeof ClaudeProcess>[1]) => WorkerProcess;
  onExit?: (code: number) => void;
}

interface Delivery { uuid: string; state: DeliveryState; text?: string }

const SIDE_EFFECT = /\b(git\s+push|gh\s+pr\s+merge|deploy|publish|release|upload|play-upload|pay|transfer|kubectl\s+apply|npm\s+publish|send)\b/i;
interface Client { sock: Socket; live: boolean; buffer: HostToHq[]; name: string }

const MAX_CLIENT_BUFFER = 50_000;

/** Exit codes the systemd template must not restart on (RestartPreventExitStatus). */
export const EXIT_LOCKED = 75;        // another host holds this shift
export const EXIT_UNRECOVERABLE = 76; // session_id_in_use / spawn_failed: needs hq, not a restart

const RANK: Record<DeliveryState, number> = { written: 0, delivered: 1, started: 2, completed: 3, failed: 4 };

export class ShiftHost {
  readonly spec: ShiftSpec;
  readonly socketPath: string;
  readonly dir: string;
  readonly log: DurableLog;
  readonly spool: SpoolReader;
  claude: WorkerProcess | null = null;
  state: HostState = 'starting';
  private server: Server | null = null;
  private client: Client | null = null;
  private readonly deliveries = new Map<string, Delivery>();   // msgId -> delivery
  private readonly byUuid = new Map<string, string>();         // uuid -> msgId
  private readonly activeTools = new Map<string, { name: string; preview: string; input: unknown; since: string }>();
  /** msgId -> text of deliveries the CLI re-injected on resume (matched by content). */
  private readonly reinjected = new Map<string, string>();
  private lastEventAt: string | null = null;
  private claudeVersion: string | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly o: HostOptions;
  private lingerTimer: NodeJS.Timeout | null = null;
  private readonly sockets = new Set<Socket>();
  private lockPath: string;
  private turnOpen = false;
  /** This turn was cut on purpose (we interrupted it, or a `now` line is still waiting when it ends: the CLI takes
   *  one by ending the turn): its `error_during_execution` is no failure, and the result says `interrupted`. */
  private cutAsked = false;
  private nowLines = new Set<string>();   // msgIds of `now` lines sent while this turn was open
  private sawInit = false;
  private exitDone: Promise<void> | null = null;          // a turn started and has not produced a result
  private closing = false;

  constructor(o: HostOptions) {
    this.o = o;
    this.spec = o.spec;
    const p = statePaths('', o.spec.stateRoot);
    this.dir = shiftDir(p, o.spec.shift);
    this.socketPath = shiftSocketPath(p, o.spec.shift);
    mkdirSync(p.shiftsDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.log = new DurableLog(shiftLogPath(p, o.spec.shift), join(this.dir, 'log.json'));
    this.spool = new SpoolReader(join(this.dir, 'spool'));
    this.lockPath = join(this.dir, 'host.lock');
  }

  async start(): Promise<void> {
    this.acquireLock();
    if (await socketAnswers(this.socketPath)) {
      this.releaseLock();
      throw new Error(`another shift-host is serving ${this.socketPath}`);
    }
    await this.rebuildDeliveries();
    await this.listen();
    this.spool.watch(() => this.sendLive({ t: 'spool_ready' }));
    this.spawnClaude();
    this.writeHostJson();
  }

  // ------------------------------------------------------------ claude

  private spawnClaude(): void {
    const handlers = {
      onEvent: (ev: EngineEvent) => this.onEngineEvent(ev),
      onLifecycle: (l: { commandUuid: string; state: string }) => this.onLifecycle(l.commandUuid, l.state),
      onExit: (code: number | null, signal: string | null) => this.onClaudeExit(code, signal),
    };
    this.claude = this.o.makeProcess ? this.o.makeProcess(this.spec, handlers)
      : this.spec.provider === 'codex' ? new CodexProcess(this.spec, handlers) : new ClaudeProcess(this.spec, handlers);
    this.record({ t: 'lifecycle', state: 'starting', sessionId: this.spec.sessionId, resume: this.spec.resume,
      note: `claude pid ${this.claude.pid}${this.spec.resume ? ' (resume)' : ''}` }, true);
  }

  private onEngineEvent(ev: EngineEvent): void {
    this.lastEventAt = new Date().toISOString();
    if (ev.kind === 'text_delta' || ev.kind === 'thinking_delta') { this.sendLive({ t: 'delta', ev }); return; }
    switch (ev.kind) {
      case 'init': this.claudeVersion = ev.version ?? this.claudeVersion; this.setState('busy'); this.turnOpen = true; break;
      case 'tool_use': this.activeTools.set(ev.toolUseId, { name: ev.name, preview: JSON.stringify(ev.input ?? '').slice(0, 300), input: ev.input, since: this.lastEventAt! }); break;
      case 'tool_result': this.activeTools.delete(ev.toolUseId); break;
      case 'user_echo': {
        const msgId = this.byUuid.get(ev.uuid);
        if (msgId) this.advance(msgId, 'started');
        else {
          // insertion order = queue order; each occurrence matches one delivery
          const entries = [...this.reinjected];
          for (const i of consumeSegments(ev.text, entries.map(([, t]) => t))) {
            const mid = entries[i]![0];
            this.reinjected.delete(mid);
            this.advance(mid, 'started');
          }
        }
        break;
      }
      case 'result':
        this.activeTools.clear(); this.turnOpen = false;
        // A turn we cut ends `error_during_execution` (measured 21/10, rotem: his GO answer at `now` mid-thinking).
        // That is the cut, not a failure: the result says so, and the lines it read stay in the conversation.
        if (ev.isError && ev.subtype === 'error_during_execution' && (this.cutAsked
          || [...this.nowLines].some((m) => ['written', 'delivered'].includes(this.deliveries.get(m)?.state ?? '')))) {
          ev = { ...ev, interrupted: true };
        }
        this.cutAsked = false; this.nowLines.clear();
        // lifecycle `completed` may be missing (canary): the result closes every started
        // delivery; an error result is a failure, never an empty success (bet 1).
        for (const [mid, d] of this.deliveries) {
          if (d.state !== 'started') continue;
          if (ev.isError && !ev.interrupted) this.advance(mid, 'failed', `turn ended: ${ev.subtype}`);
          else this.advance(mid, 'completed');
        }
        break;
    }
    this.record({ t: 'event', ev });
    if (ev.kind === 'result') this.setState('idle');
  }

  private onLifecycle(uuid: string, st: string): void {
    const msgId = this.byUuid.get(uuid);
    if (!msgId) return;
    if (st === 'queued') this.advance(msgId, 'delivered');
    else if (st === 'started') { this.advance(msgId, 'started'); this.setState('busy'); this.turnOpen = true; }
    else if (st === 'completed') this.advance(msgId, 'completed');
    else if (st === 'cancelled' || st === 'failed' || st === 'discarded') this.advance(msgId, 'failed', `lifecycle ${st}`);
  }

  private onClaudeExit(code: number | null, signal: string | null): void {
    this.exitDone = this.finishExit(code, signal).catch(() => { /* logged state best effort */ });
  }

  private async finishExit(code: number | null, signal: string | null): Promise<void> {
    // Queued-but-unconsumed messages live in the CLI's transcript queue and are
    // re-injected by a --resume (bet 2): keep those `delivered` (heldByCli), fail the rest.
    let pending: string[] = [];
    try { pending = pendingQueued(await readTranscript(this.spec.sessionId, { cwd: this.spec.cwd })); } catch { /* none */ }
    const heldByCli: string[] = [];
    const why: Record<string, string> = {
      written: 'claude exited before accepting', delivered: 'claude exited while queued',
      started: 'interrupted mid-turn',
    };
    for (const [msgId, d] of this.deliveries) {
      if (d.state === 'delivered' && d.text && takePending(pending, d.text)) { heldByCli.push(msgId); continue; }
      if (why[d.state]) this.advance(msgId, 'failed', why[d.state]);
    }
    // A turn that ends without a `result` is a failure, never an empty success (bet 1).
    const error = this.claude?.failureReason ?? (this.turnOpen ? 'no_result' : (code !== 0 && !this.closing ? 'crashed' : undefined));
    const interruptedTools = [...this.activeTools.values()].map(({ name, preview }) => ({ name, preview, sideEffect: SIDE_EFFECT.test(`${name} ${preview}`) }));
    this.state = 'exited';
    this.record({ t: 'lifecycle', state: 'exited', exitCode: code, signal, ...(error ? { error } : {}),
      ...(interruptedTools.length ? { interruptedTools } : {}),
      ...(heldByCli.length ? { heldByCli } : {}),
      note: this.claude?.stderrTail ? this.claude.stderrTail.slice(-2000) : undefined }, true);
    this.writeHostJson();
    const linger = this.closing ? 0 : (this.o.lingerMs ?? 10 * 60_000);
    // A requested stop exits 0 (systemd must not resurrect it); an unrecoverable
    // start failure exits 76 (no restart loop); a crash exits non-zero (restart).
    const exitCode = this.closing ? 0 : this.claude?.failureReason ? EXIT_UNRECOVERABLE : 1;   // claude only exits by itself on trouble
    this.lingerTimer = setTimeout(() => void this.shutdown(exitCode), linger);
  }

  private setState(s: HostState): void {
    if (this.state === s || this.state === 'exited') return;
    this.state = s;
    this.record({ t: 'lifecycle', state: s });
  }

  // ------------------------------------------------------------ deliveries

  private advance(msgId: string, state: DeliveryState, error?: string): void {
    const d = this.deliveries.get(msgId);
    if (!d) return;
    if (d.state === 'failed' || d.state === 'completed') return;
    if (state !== 'failed' && RANK[state] <= RANK[d.state]) return;
    d.state = state;
    this.record({ t: 'delivery', msgId, uuid: d.uuid, state, ...(error ? { error } : {}) }, true);
  }

  private async rebuildDeliveries(): Promise<void> {
    let startedSession: string | null = null;
    for await (const f of this.log.readRange(0, this.log.lastSeq)) {
      if (f.t === 'lifecycle' && f.state === 'starting') startedSession = f.sessionId ?? null;   // null: pre-sessionId log
      if (f.t === 'event' && f.ev.kind === 'init' && f.ev.sessionId === this.spec.sessionId
        && (startedSession === this.spec.sessionId || startedSession === null)) this.sawInit = true;
      if (f.t !== 'delivery') continue;
      const prev = this.deliveries.get(f.msgId);
      this.deliveries.set(f.msgId, { uuid: f.uuid, state: f.state, text: f.text ?? prev?.text });
      this.byUuid.set(f.uuid, f.msgId);
    }
    // Our own log shows this session already started: a restart (systemd, boot)
    // must --resume it. A transcript WITHOUT our log is a collision -> loud failure.
    if (!this.spec.resume && this.sawInit) this.spec.resume = true;
    // On --resume the CLI re-injects what it had queued but not consumed (bet 2).
    let pending: string[] = [];
    if (this.spec.resume) {
      try { pending = pendingQueued(await readTranscript(this.spec.sessionId, { cwd: this.spec.cwd })); } catch { /* none */ }
    }
    for (const [msgId, d] of this.deliveries) {
      if (d.state !== 'written' && d.state !== 'delivered' && d.state !== 'started') continue;
      if (d.state === 'delivered' && d.text && takePending(pending, d.text)) {
        this.reinjected.set(msgId, d.text);
        this.log.append({ t: 'delivery', msgId, uuid: d.uuid, state: 'delivered', reinjected: true }, true);
        continue;
      }
      d.state = 'failed';
      this.log.append({ t: 'delivery', msgId, uuid: d.uuid, state: 'failed', error: 'host restarted' }, true);
    }
  }

  /**
   * His `now` (stopIfSafe): mid-tool, stop the turn first when every running tool is safe to cut (safe-tools.ts), so
   * the line is read within a second. With no tool running nothing is cut (it would cut his worker's answer). A tool that is not safe runs to its end; the CLI takes a `now` line right after
   * the running tool, before the next step, and the reply says which tool that is, for the bubble.
   */
  private async sendNow(msgId: string, text: string, retry: boolean): Promise<SendReply> {
    const known = this.deliveries.get(msgId);
    if (!this.turnOpen || retry || known) return this.send(msgId, text, 'now', retry);
    const running = [...this.activeTools.values()];
    // No tool running (the model is writing): nothing for us to stop. The CLI itself may end the turn for a `now` line
    // (rotem 21/10, mid-thinking); send() marks that end as cut.
    if (!running.length) return this.send(msgId, text, 'now', retry);
    const blocking = running.filter((t) => !safeToInterrupt(t));
    if (!blocking.length) {
      try {
        await this.interrupt();
      } catch (e) {
        // The line still goes in, after the running step: late, never lost (journal: the unit's stderr).
        process.stderr.write(`shift-host: interrupt before ${msgId} failed: ${(e as Error).message}\n`);
      }
      return this.send(msgId, text, 'now', retry);
    }
    const first = blocking.reduce((a, b) => (a.since <= b.since ? a : b));
    const command = first.name === 'Bash' ? (first.input as { command?: unknown } | undefined)?.command : undefined;
    return { ...this.send(msgId, text, 'now', retry),
      waitingOn: { tool: first.name, ...(typeof command === 'string' ? { command } : {}), since: first.since } };
  }

  private send(msgId: string, text: string, priority: 'now' | 'next' | 'later', retry: boolean): { uuid: string; state: DeliveryState } {
    const existing = this.deliveries.get(msgId);
    // retry only re-sends what never got accepted; anything accepted stays single.
    if (existing && !(retry && (existing.state === 'written' || existing.state === 'failed'))) return { ...existing };
    if (!this.claude || this.claude.exited) throw new HostError('not_running', 'claude is not running');
    // The CLI takes a `now` line by ending the open turn (error_during_execution): that end is ours.
    if (priority === 'now' && this.turnOpen) this.nowLines.add(msgId);
    const uuid = this.claude.sendUser(text, priority);
    if (existing) this.byUuid.delete(existing.uuid);
    this.deliveries.set(msgId, { uuid, state: 'written' });
    this.byUuid.set(uuid, msgId);
    this.deliveries.get(msgId)!.text = text;
    this.record({ t: 'delivery', msgId, uuid, state: 'written', text }, true);
    return { uuid, state: 'written' };
  }

  // ------------------------------------------------------------ log + fan-out

  private record(f: FrameInput, durable = false): LoggedFrame {
    const frame = this.log.append(f, durable);
    const c = this.client;
    if (c) {
      if (c.live) this.write(c, frame);
      else if (c.buffer.length < MAX_CLIENT_BUFFER) c.buffer.push(frame);
      else { c.sock.destroy(); this.client = null; }   // it resumes with `since`
    }
    return frame;
  }

  private sendLive(f: HostToHq): void {
    const c = this.client;
    if (c?.live) this.write(c, f);
  }

  private write(c: Client, f: HostToHq): boolean {
    if (c.sock.destroyed) return false;
    return c.sock.write(encodeFrame(f));
  }

  info(): HostInfo {
    return {
      shift: this.spec.shift, identity: this.spec.identity, sessionId: this.spec.sessionId, cwd: this.spec.cwd,
      logId: this.log.logId, lastSeq: this.log.lastSeq, hostPid: process.pid,
      claudePid: this.claude?.pid ?? null, claudeProcStart: this.claude?.procStart ?? null,
      claudeVersion: this.claudeVersion, startedAt: this.startedAt, state: this.state,
      lastEventAt: this.lastEventAt, activeTools: [...this.activeTools.keys()],
    };
  }

  private writeHostJson(): void {
    const p = join(this.dir, 'host.json');
    try {
      writeFileSync(`${p}.tmp`, JSON.stringify({ ...this.info(), socketPath: this.socketPath }, null, 2));
      renameSync(`${p}.tmp`, p);
    } catch { /* best effort */ }
  }

  // ------------------------------------------------------------ socket server

  private listen(): Promise<void> {
    if (existsSync(this.socketPath)) { try { unlinkSync(this.socketPath); } catch { /* ignore */ } }
    this.server = createServer((sock) => this.onConnection(sock));
    return new Promise((res, rej) => {
      this.server!.once('error', rej);
      this.server!.listen(this.socketPath, () => {
        try { chmodSync(this.socketPath, 0o600); } catch { /* ignore */ }
        res();
      });
    });
  }

  private onConnection(sock: Socket): void {
    this.sockets.add(sock);
    sock.on('close', () => this.sockets.delete(sock));
    let me: Client | null = null;
    const fail = (code: ErrorCode, message: string, re?: string, fatal = false): void => {
      if (!sock.destroyed) sock.write(encodeFrame({ t: 'error', re, code, message, fatal }));
      if (fatal) sock.end();
    };
    const split = new LineSplitter((line) => {
      let f: HqToHost;
      try { f = decodeHqFrame(line); } catch (e) {
        const pe = e instanceof ProtocolError ? e : new ProtocolError(String(e));
        let re: string | undefined;
        try { const id = (JSON.parse(line) as { id?: unknown }).id; if (typeof id === 'string') re = id; } catch { /* no id */ }
        fail(pe.code, pe.message, re, pe.code === 'version');
        return;
      }
      if (f.t === 'hello') { me = this.takeOver(sock, f); return; }
      if (!me || this.client !== me) { fail('bad_frame', 'send hello first', 'id' in f ? f.id : undefined); return; }
      void this.handle(me, f);
    }, undefined, () => fail('bad_frame', 'line too long'));
    sock.on('data', (d) => { try { split.push(d); } catch { /* reported via fail */ } });
    sock.on('error', () => { /* client vanished */ });
    sock.on('close', () => { if (this.client && this.client.sock === sock) this.client = null; });
  }

  private takeOver(sock: Socket, hello: Extract<HqToHost, { t: 'hello' }>): Client {
    const old = this.client;
    if (old && old.sock !== sock) {
      this.write(old, { t: 'error', code: 'superseded', message: `superseded by ${hello.client}`, fatal: true });
      old.sock.end();
    }
    const c: Client = { sock, live: false, buffer: [], name: hello.client };
    this.client = c;
    this.write(c, { t: 'hello', v: SHIFT_PROTOCOL_VERSION, info: this.info() });
    const since = hello.logId !== this.log.logId || hello.since > this.log.lastSeq ? 0 : hello.since;
    void this.replay(c, since);
    return c;
  }

  private async replay(c: Client, since: number): Promise<void> {
    const upto = this.log.lastSeq;
    let sent = since;
    const gone = (): boolean => this.client !== c || c.sock.destroyed;
    for await (const f of this.log.readRange(since, upto)) {
      if (gone()) return;    // returning from for-await closes the read stream
      if (!this.write(c, f)) {
        await new Promise<void>((r) => {
          const done = (): void => { c.sock.off('drain', done); c.sock.off('close', done); r(); };
          c.sock.once('drain', done); c.sock.once('close', done);
        });
      }
      sent = f.seq;
    }
    if (this.client !== c) return;
    for (const f of c.buffer) if (!('seq' in f) || (f as LoggedFrame).seq > sent) this.write(c, f);
    c.buffer = [];
    c.live = true;
    this.write(c, { t: 'live', lastSeq: this.log.lastSeq });
  }

  private reply(c: Client, re: string, data?: unknown): void { this.write(c, { t: 'reply', re, ok: true, data }); }
  private replyErr(c: Client, re: string, code: ErrorCode, error: string): void {
    this.write(c, { t: 'reply', re, ok: false, code, error });
  }

  private async handle(c: Client, f: Exclude<HqToHost, { t: 'hello' }>): Promise<void> {
    try {
      switch (f.t) {
        case 'send': this.reply(c, f.id, f.stopIfSafe === true && f.priority === 'now'
          ? await this.sendNow(f.msgId, f.text, f.retry === true)
          : this.send(f.msgId, f.text, f.priority, f.retry === true)); return;
        case 'interrupt': this.reply(c, f.id, await this.interrupt()); return;
        case 'usage': this.reply(c, f.id, toUsageReply(await this.need().usage())); return;
        case 'context': this.reply(c, f.id, toContextReply(await this.need().contextUsage())); return;
        case 'status': this.reply(c, f.id, this.info()); return;
        case 'ping': this.reply(c, f.id, { pong: Date.now() }); return;
        case 'spool_read': {
          const r = this.spool.read(f.cursor, f.max);
          this.write(c, { t: 'spool', re: f.id, ...r });
          return;
        }
        case 'spool_ack': this.spool.ack(f.cursor); this.reply(c, f.id); return;
        case 'stop':
          this.reply(c, f.id, { stopping: true });
          this.record({ t: 'lifecycle', state: this.state, note: `stop requested: ${f.reason}` }, true);
          void this.stop(f.graceMs ?? 5000);
          return;
      }
    } catch (e) {
      const he = e instanceof HostError ? e : null;
      this.replyErr(c, f.id, he?.code ?? (String(e).includes('timed out') ? 'timeout' : 'internal'), (e as Error).message);
    }
  }

  /** Every interrupt hq or the host asks for goes through here, so the turn's end reads as cut, not failed. */
  private interrupt(): Promise<unknown> {
    const c = this.need();
    if (this.turnOpen) this.cutAsked = true;
    return c.interrupt();
  }

  private need(): WorkerProcess {
    if (!this.claude || this.claude.exited) throw new HostError('not_running', 'claude is not running');
    return this.claude;
  }

  // ------------------------------------------------------------ lock

  /** One host per shift: host.lock holds pid + procStart; a stale lock is taken over. */
  private acquireLock(): void {
    try {
      const fd = openSync(this.lockPath, 'wx', 0o600);
      writeSync(fd, JSON.stringify({ pid: process.pid, procStart: procStartOf(process.pid) }));
      closeSync(fd);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    let held: { pid?: number; procStart?: string | null } = {};
    try { held = JSON.parse(readFileSync(this.lockPath, 'utf8')); } catch { /* corrupt = stale */ }
    if (held.pid && held.pid !== process.pid && procStartOf(held.pid) !== null && procStartOf(held.pid) === held.procStart) {
      throw new Error(`shift ${this.spec.shift} is held by host pid ${held.pid}`);
    }
    unlinkSync(this.lockPath);
    this.acquireLock();
  }

  private releaseLock(): void {
    try {
      const held = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: number };
      if (held.pid === process.pid) unlinkSync(this.lockPath);
    } catch { /* gone */ }
  }

  // ------------------------------------------------------------ shutdown

  async stop(graceMs = 5000): Promise<void> {
    this.closing = true;
    if (this.claude && !this.claude.exited) { await this.claude.stop(graceMs); return; }
    if (this.exitDone) await this.exitDone;
    await this.shutdown(0);
  }

  private shutDown = false;
  async shutdown(code: number): Promise<void> {
    if (this.shutDown) return;
    this.shutDown = true;
    if (this.exitDone) await this.exitDone;   // the exited frame is written before the log closes
    if (this.lingerTimer) clearTimeout(this.lingerTimer);
    this.spool.close();
    this.log.close();
    this.writeHostJson();
    try { unlinkSync(this.socketPath); } catch { /* gone */ }
    this.client?.sock.end();
    await new Promise<void>((r) => {
      if (!this.server) { r(); return; }
      const t = setTimeout(r, 2000);
      this.server.close(() => { clearTimeout(t); r(); });
      setTimeout(() => { for (const s of this.sockets) s.destroy(); }, 200).unref();
    });
    this.releaseLock();
    this.o.onExit?.(code);
  }
}

export function socketAnswers(path: string, ms = 500): Promise<boolean> {
  if (!existsSync(path)) return Promise.resolve(false);
  return new Promise((res) => {
    const s = createConnection(path);
    const t = setTimeout(() => { s.destroy(); res(false); }, ms);
    s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });
    s.once('error', () => { clearTimeout(t); res(false); });
  });
}

/** Removes and returns true for the first pending entry exactly equal to `text`. */
function takePending(pending: string[], text: string): boolean {
  const i = pending.indexOf(text);
  if (i < 0) return false;
  pending.splice(i, 1);
  return true;
}

class HostError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) { super(message); this.code = code; }
}
