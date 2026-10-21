// shift-host <-> hq wire protocol (B.5, B.4, B.11).
// Owner: engine lane. Additive changes only within a major version; bump
// SHIFT_PROTOCOL_VERSION on any breaking change and keep the old decoder
// for one release.
//
// Transport: unix socket per shift at
//   ~/.local/state/agent-company/shifts/<shift>.sock   (mode 0600)
// Framing: NDJSON, one JSON object per line, UTF-8, both directions.
//
// Session rules
// - The shift-host is the server and outlives hq. hq connects and sends
//   `hello{logId, since}`. The host answers `hello{info}`, replays every logged
//   frame with seq > since, then sends `live`. Frames produced during the
//   replay are numbered after it and sent after it, before `live`; there is
//   no gap and no reordering.
// - `logId` identifies one durable log (random, set when the log is created).
//   If hq's logId differs from the host's, or since > lastSeq, the host
//   replays from 0. hq must then dedupe by (logId, seq).
// - One controller at a time. A new `hello` takes over; the older connection
//   receives `error{code:'superseded'}` and is closed. This is what a rainbow
//   deploy of hq relies on.
// - Logged frames (`event`, `delivery`, `lifecycle`) carry `seq`: monotonic per
//   log, starting at 1, never reused. Command replies carry `re` (the
//   command `id`) and are not logged. `delta` and `spool_ready` are live-only.
//
// Delivery (B.4)
// - On `send`, the host generates a uuid, writes the stream-json user line
//   `{"type":"user","uuid":<uuid>,"priority":...,"message":{...}}` to claude's
//   stdin, logs `delivery{state:'written'}` and replies `{uuid}`.
// - Measured on 2.1.303 (adapter/contract.yaml rows command_lifecycle,
//   replay_echo): the CLI emits `command_lifecycle{command_uuid, state}` with
//   queued (on receipt, any priority) -> started (dequeued into the
//   conversation) -> completed (its turn ended). The replay echo
//   (isReplay:true, same uuid) arrives at dequeue time, not on receipt.
//   So: queued => `delivered`, started or echo => `started`, completed =>
//   `completed`. If lifecycle frames disappear (canary), echo alone still
//   yields `started`.
// - After a crash + --resume the CLI re-injects its own unconsumed queue as ONE
//   user line with a NEW uuid (bet 2). The host keeps those deliveries as
//   `delivered` (reinjected:true) instead of failing them, and matches the new
//   echo by content; hq must not resend them.
// - Command replies (ping/status/usage/context) are never logged: full
//   get_context_usage pings bloated the bet 4 log.
// - `send` is idempotent on msgId within a log: a repeat replies with the
//   current `{state, uuid}` and writes nothing. `retry:true` forces a new
//   stdin line with a fresh uuid (B.4 "no delivered within 60s -> retry").

import type { IdentityId, ShiftId } from './index.ts';

export const SHIFT_PROTOCOL_VERSION = 1 as const;

// ---------------------------------------------------------------- paths

export interface StatePaths {
  root: string;            // ~/.local/state/agent-company
  shiftsDir: string;       // <root>/shifts
}

export function statePaths(home: string, override?: string): StatePaths {
  const root = override ?? `${home}/.local/state/agent-company`;
  return { root, shiftsDir: `${root}/shifts` };
}

export function shiftSocketPath(p: StatePaths, shift: ShiftId): string {
  return `${p.shiftsDir}/${shift}.sock`;
}
export function shiftLogPath(p: StatePaths, shift: ShiftId): string {
  return `${p.shiftsDir}/${shift}.ndjson`;
}
/** Per-shift working dir: spool/, wal/, prime.json, settings.json, host.json */
export function shiftDir(p: StatePaths, shift: ShiftId): string {
  return `${p.shiftsDir}/${shift}`;
}

// ---------------------------------------------------------------- engine events
// Normalized by the adapter. The only CLI-shaped thing hq ever sees is `raw`
// on `other` events (kept for forward compatibility, never interpreted).

export type Priority = 'now' | 'next' | 'later';

export type EngineDelta =
  | { kind: 'text_delta'; text: string; messageId?: string }
  | { kind: 'thinking_delta'; text: string; messageId?: string };

export type EngineEvent =
  | EngineDelta
  | { kind: 'init'; sessionId: string; model: string; cwd: string; tools: string[];
      permissionMode?: string; messagingSocketPath?: string; memoryPaths?: unknown;
      version?: string }
  | { kind: 'text'; text: string; messageId?: string }
  | { kind: 'tool_use'; toolUseId: string; name: string; input: unknown; parentToolUseId?: string }
  | { kind: 'tool_result'; toolUseId: string; isError: boolean; preview: string }
  /** --replay-user-messages echo of a user line; basis of `delivered`. */
  | { kind: 'user_echo'; uuid: string; text: string }
  | { kind: 'result'; subtype: string; isError: boolean; text?: string; numTurns?: number;
      costUsd?: number; durationMs?: number; usage?: unknown; contextWindow?: number;
      permissionDenials?: unknown[] }
  | { kind: 'rate_limit'; status: string; rateLimitType?: string; resetsAt?: number;
      fiveHour?: number; sevenDay?: number }   // utilization 0..1
  | { kind: 'compact'; trigger?: string; preTokens?: number; postTokens?: number }
  | { kind: 'status'; status: string | null }
  | { kind: 'hook'; phase: 'started' | 'response'; event: string; name?: string; outcome?: string }
  | { kind: 'peer_hold'; state: string; cause?: string; lane?: string }
  | { kind: 'other'; type: string; subtype?: string; raw: unknown };

// ---------------------------------------------------------------- host state

export type HostState =
  | 'starting'   // claude spawned, no init yet
  | 'idle'       // between turns, stdin open
  | 'busy'       // turn in progress
  | 'exited';    // claude gone; host lingers so hq can read the tail

export interface HostInfo {
  shift: ShiftId;
  identity: IdentityId;
  sessionId: string;
  cwd: string;
  logId: string;
  lastSeq: number;
  hostPid: number;
  claudePid: number | null;
  /** /proc/<pid>/stat starttime; pid + procStart is the liveness key (B.5). */
  claudeProcStart: string | null;
  claudeVersion: string | null;
  startedAt: string;       // ISO
  state: HostState;
  lastEventAt: string | null;
  /** tool_use ids without a tool_result yet (long tool => not stuck). */
  activeTools: string[];
}

/** Replies to `usage` / `context`: a few stable fields plus the raw response. */
export interface UsageReply {
  fiveHour: number | null;  // percent 0..100
  sevenDay: number | null;
  resetsAt: { fiveHour?: string; sevenDay?: string };
  raw: unknown;
}
export interface ContextReply {
  totalTokens: number | null;
  maxTokens: number | null;
  raw: unknown;
}
/** The tool a `now` waits for: it was not safe to stop (shift-host safe-tools.ts), so the line goes in when it ends. */
export interface WaitingOn {
  tool: string;
  /** Bash: the command line. */
  command?: string;
  /** When the tool started (ISO). */
  since: string;
}
export interface SendReply {
  uuid: string;
  state: DeliveryState;
  /** Set when the send asked to stop the worker and a running tool was not safe to stop. */
  waitingOn?: WaitingOn;
}

/** written: on stdin. delivered: CLI accepted it (command_lifecycle queued).
 *  started: dequeued into the conversation (lifecycle started / replay echo).
 *  completed: its turn ended. failed: never accepted (claude died, write error). */
export type DeliveryState = 'written' | 'delivered' | 'started' | 'completed' | 'failed';

// ---------------------------------------------------------------- hq -> host

export type HqToHost =
  | { t: 'hello'; v: number; client: string; logId: string | null; since: number }
  /** stopIfSafe (with `now`): stop the running turn first when every running tool is safe to cut; else the
   *  reply says which tool the line waits for. A host that predates it ignores it: no stop, never a wrong one. */
  | { t: 'send'; id: string; msgId: string; text: string; priority: Priority; retry?: boolean; stopIfSafe?: boolean }
  | { t: 'interrupt'; id: string }
  | { t: 'usage'; id: string }           // control_request get_usage
  | { t: 'context'; id: string }         // control_request get_context_usage
  | { t: 'status'; id: string }          // reply data: HostInfo
  /** Read hook spool entries after `cursor` (opaque; only the host compares). */
  | { t: 'spool_read'; id: string; cursor: string | null; max?: number }
  /** hq has durably stored everything up to and including `cursor`. */
  | { t: 'spool_ack'; id: string; cursor: string }
  /** End the shift: close stdin, wait `graceMs`, then SIGTERM the group. */
  | { t: 'stop'; id: string; reason: string; graceMs?: number }
  | { t: 'ping'; id: string };

// ---------------------------------------------------------------- host -> hq

export interface SpoolEntry {
  cursor: string;
  ts: string;
  event: string;           // hook event name, e.g. "PostToolUse"
  payload: unknown;        // hook stdin JSON as received
}

export type ErrorCode =
  | 'bad_frame' | 'version' | 'superseded' | 'not_running' | 'timeout' | 'internal';

export type HostToHq =
  | { t: 'hello'; v: number; info: HostInfo }
  | { t: 'event'; seq: number; ts: string; ev: EngineEvent }
  | { t: 'delivery'; seq: number; ts: string; msgId: string; uuid: string;
      state: DeliveryState; error?: string;
      /** Only on `written`: the exact text, so a restarted host can match the
       *  CLI's own re-injected queue by content (bet 2). */
      text?: string;
      /** true when the CLI re-injected it on --resume under a new uuid. */
      reinjected?: boolean }
  | { t: 'lifecycle'; seq: number; ts: string; state: HostState;
      exitCode?: number | null; signal?: string | null; note?: string;
      /** On `starting`: the session this claude runs (auto-resume only matches its own). */
      sessionId?: string; resume?: boolean;
      /** Machine-readable failure: session_id_in_use | spawn_failed | no_result | crashed */
      error?: string;
      /** Tools in flight when claude died. A resume may re-run them
       *  (CLAUDE_CODE_RESUME_INTERRUPTED_TURN, bet 3): side-effect tools need an
       *  idempotency check in the Resume Delta. */
      interruptedTools?: Array<{ name: string; preview: string; sideEffect: boolean }>;
      /** msgIds still `delivered`: held in the CLI's own transcript queue; a
       *  --resume of this session delivers them, a new shift must resend. */
      heldByCli?: string[] }
  /** End of replay; everything after is live. */
  | { t: 'live'; lastSeq: number }
  /** Streaming deltas, live only (not logged, not replayed). */
  | { t: 'delta'; ev: EngineDelta }
  /** New spool entries exist; hq should `spool_read`. Live only. */
  | { t: 'spool_ready' }
  | { t: 'reply'; re: string; ok: true; data?: unknown }
  | { t: 'reply'; re: string; ok: false; code: ErrorCode; error: string }
  | { t: 'spool'; re: string; entries: SpoolEntry[]; cursor: string | null; more: boolean }
  /** Error not tied to a command id (bad frame, version, superseded). */
  | { t: 'error'; re?: string; code: ErrorCode; message: string; fatal: boolean };

/** Frames written to the durable log; they carry `seq`. */
export type LoggedFrame = Extract<HostToHq, { seq: number }>;

// ---------------------------------------------------------------- codec

export const MAX_LINE_CHARS = 8 * 1024 * 1024;

export function encodeFrame(f: HqToHost | HostToHq): string {
  return JSON.stringify(f) + '\n';
}

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  constructor(message: string, code: ErrorCode = 'bad_frame') {
    super(message);
    this.code = code;
  }
}

function parseObj(line: string): Record<string, unknown> {
  let o: unknown;
  try { o = JSON.parse(line); } catch { throw new ProtocolError('invalid JSON'); }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new ProtocolError('frame is not an object');
  if (typeof (o as { t?: unknown }).t !== 'string') throw new ProtocolError('frame has no t');
  return o as Record<string, unknown>;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Parses a frame sent by hq. Invalid or unknown frames throw ProtocolError. */
export function decodeHqFrame(line: string): HqToHost {
  const o = parseObj(line);
  const t = o.t as string;
  const need = (ok: boolean, what: string) => { if (!ok) throw new ProtocolError(`${t}: ${what}`); };
  switch (t) {
    case 'hello':
      need(nat(o.v), 'v must be a non-negative integer');
      if ((o.v as number) !== SHIFT_PROTOCOL_VERSION) {
        throw new ProtocolError(`hq speaks v${String(o.v)}, host speaks v${SHIFT_PROTOCOL_VERSION}`, 'version');
      }
      need(nat(o.since), 'since must be a non-negative integer');
      need(o.logId === null || o.logId === undefined || str(o.logId), 'logId must be string|null');
      if (o.logId === undefined) o.logId = null;
      if (!str(o.client)) o.client = 'unknown';
      break;
    case 'send':
      need(str(o.id) && str(o.msgId) && typeof o.text === 'string', 'needs id, msgId, text');
      if (o.priority !== 'now' && o.priority !== 'next' && o.priority !== 'later') o.priority = 'next';
      break;
    case 'spool_read':
      need(str(o.id), 'needs id');
      need(o.cursor === null || o.cursor === undefined || str(o.cursor), 'cursor must be string|null');
      if (o.cursor === undefined) o.cursor = null;
      break;
    case 'spool_ack':
      need(str(o.id) && str(o.cursor), 'needs id and cursor');
      break;
    case 'stop':
      need(str(o.id), 'needs id');
      if (typeof o.reason !== 'string') o.reason = '';
      break;
    case 'interrupt': case 'usage': case 'context': case 'status': case 'ping':
      need(str(o.id), 'needs id');
      break;
    default:
      throw new ProtocolError(`unknown hq frame t=${t}`);
  }
  return o as unknown as HqToHost;
}

const HOST_TYPES = new Set(['hello', 'event', 'delivery', 'lifecycle', 'live', 'delta',
  'spool_ready', 'reply', 'spool', 'error']);
const LOGGED = new Set(['event', 'delivery', 'lifecycle']);

/** Parses a frame sent by the host. Unknown `t` returns null (forward compat). */
export function decodeHostFrame(line: string): HostToHq | null {
  const o = parseObj(line);
  if (!HOST_TYPES.has(o.t as string)) return null;
  if (LOGGED.has(o.t as string) && !(nat(o.seq) && (o.seq as number) > 0)) {
    throw new ProtocolError(`${String(o.t)}: seq must be a positive integer`);
  }
  if ((o.t === 'reply' || o.t === 'spool') && !str(o.re)) throw new ProtocolError(`${String(o.t)}: needs re`);
  return o as unknown as HostToHq;
}

/**
 * Incremental NDJSON splitter for socket data. A line longer than `maxChars`
 * is dropped up to its newline and reported via `onOverflow`; a throwing
 * `onLine` does not strand later lines (errors go to `onError`, default rethrow
 * after the chunk is fully processed).
 */
export class LineSplitter {
  private parts: string[] = [];
  private partLen = 0;
  private discarding = false;
  private readonly dec = new TextDecoder();
  private readonly onLine: (line: string) => void;
  private readonly maxChars: number;
  private readonly onOverflow: () => void;

  constructor(onLine: (line: string) => void, maxChars = MAX_LINE_CHARS, onOverflow?: () => void) {
    this.onLine = onLine;
    this.maxChars = maxChars;
    this.onOverflow = onOverflow ?? (() => { throw new ProtocolError('line exceeds max length'); });
  }

  push(chunk: string | Uint8Array): void {
    const s = typeof chunk === 'string' ? chunk : this.dec.decode(chunk, { stream: true });
    const lines: string[] = [];
    let overflowed = false;
    let start = 0;
    for (;;) {
      const i = s.indexOf('\n', start);
      if (i < 0) break;
      const piece = s.slice(start, i);
      start = i + 1;
      if (this.discarding) { this.discarding = false; this.reset(); continue; }
      if (this.partLen + piece.length > this.maxChars) { this.reset(); overflowed = true; continue; }
      this.parts.push(piece);
      lines.push(this.parts.join(''));
      this.reset();
    }
    const rest = s.slice(start);
    if (!this.discarding && rest) {
      if (this.partLen + rest.length > this.maxChars) {
        this.reset(); this.discarding = true; overflowed = true;
      } else { this.parts.push(rest); this.partLen += rest.length; }
    }
    let firstErr: unknown;
    for (const l of lines) {
      if (!l.trim()) continue;
      try { this.onLine(l); } catch (e) { firstErr ??= e; }
    }
    if (overflowed) this.onOverflow();
    if (firstErr !== undefined) throw firstErr;
  }

  /** Flush a trailing line with no newline (end of stream). */
  end(): void {
    const tail = this.dec.decode();
    if (tail) this.push(tail);
    const line = this.discarding ? '' : this.parts.join('');
    this.reset();
    this.discarding = false;
    if (line.trim()) this.onLine(line);
  }

  private reset(): void { this.parts = []; this.partLen = 0; }
}
