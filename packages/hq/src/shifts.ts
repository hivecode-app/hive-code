// Shift lifecycle in hq (B.2, B.5): request (new or resume), connect to the shift-host socket,
// fold its logged frames into facts on the shift row, reconnect after hq restarts.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { statePaths, shiftSocketPath, shiftDir, PRIME_BUDGETS, type EngineDelta, type LoggedFrame, type HostInfo, type PrimeFile } from '@company/shared';
import { HostClient, type HostConnection } from './host-client.ts';
import { procStart, sessionIdFor } from './proc.ts';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';
import { getIdentity, type IdentityRow } from './org.ts';
import { buildSystemPrompt, writeSystemPrompt } from './system-prompt.ts';

export type ShiftKind = 'work' | 'resident' | 'foreign';

export interface ShiftRow {
  id: string; identity: string; shift_no: number; session_id: string | null; state: string; kind: ShiftKind;
  host_pid: number | null; pid: number | null; proc_start: string | null; host_seq: number; host_log_id: string | null; spool_cursor: string | null;
  socket_path: string | null; unit: string | null; account: string | null; task_id: number | null; machine: string;
  started_at: number; ended_at: number | null; end_reason: string | null; last_event_at: number | null;
  in_turn: number; long_tool: number; rate_limited_until: number | null; stuck_since: number | null;
  nudged_at: number | null; interrupted_at: number | null; dead_signals: number; last_ping_ok_at: number | null;
  unit_released_at: number | null; run_start_seq: number | null;
}

export interface LaunchSpec {
  shiftId: string; identity: string; shiftNo: number; sessionId: string; resume: boolean;
  kind: ShiftKind; cwd: string; socketPath: string; taskId: number | null;
  /** systemd unit: company-shift@<shift>.service (the template instance). */
  unit: string;
  /** L0 + L1 (B.3), passed as --append-system-prompt-file. */
  systemPromptFile?: string;
}

/** Starts a shift-host process. Default: systemd-run --user (B.5); tests inject a fake. */
export interface Launcher {
  launch(spec: LaunchSpec): Promise<{ unit?: string }>;
  /** Stop a host we can't reach over its socket (still booting, or wedged). */
  kill(shiftId: string, unit: string | null): Promise<void>;
}

export type ConnectionFactory = (shiftId: string, socketPath: string) => HostConnection & { open(since: number, logId: string | null, timeoutMs?: number): Promise<void> };

export interface RequestOpts {
  kind?: ShiftKind;
  reason: string;            // message | resurrect | task | manual | rotation
  forceNew?: boolean;        // new shift with handoff instead of resume
  taskId?: number | null;
  cwd?: string;
}

const NEW_SHIFT_REASONS = new Set(['rotation', 'task_done', 'role_change', 'machine_move', 'resume_rejected', 'stuck']);

/** `systemctl --user` needs the user bus; a shell started outside the session may lack XDG_RUNTIME_DIR. */
function userBusEnv(): NodeJS.ProcessEnv {
  const uid = process.getuid?.();
  return process.env.XDG_RUNTIME_DIR || uid == null ? process.env : { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
}

function systemctl(args: string[]): Promise<{ code: number | null; err: string }> {
  return new Promise((resolve) => {
    const p = spawn('systemctl', ['--user', ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: userBusEnv() });
    let err = '';
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('error', (e) => resolve({ code: -1, err: e.message }));
    p.on('exit', (code) => resolve({ code, err: err.trim() }));
  });
}

export const shiftUnit = (shiftId: string) => `company-shift@${shiftId}.service`;

/** The flags hq passes to the shift-host (shift-host cli.ts --args-file). shift-no comes from the store. */
export function hostArgs(spec: LaunchSpec, stateDir: string): Record<string, string | boolean> {
  return {
    identity: spec.identity, shift: spec.shiftId, 'shift-no': String(spec.shiftNo), 'session-id': spec.sessionId,
    cwd: spec.cwd, 'state-dir': stateDir, resume: spec.resume,
    ...(spec.systemPromptFile ? { 'append-system-prompt-file': spec.systemPromptFile } : {}),
  };
}

/**
 * Persistent template unit packages/shift-host/systemd/company-shift@.service (bet 3: transient units do
 * not survive a reboot). hq writes shifts/<shift>/host-args.json, then `enable --now`; enabled instances
 * come back at boot. An ended shift is `disable --now`d so it doesn't.
 */
export class TemplateLauncher implements Launcher {
  private stateDir: string;
  private templateFile: string;
  private linked = false;
  constructor(stateDir: string, templateFile: string) {
    // The template unit reads %h/.local/state/agent-company/shifts/%i/host-args.json: no other state dir.
    if (resolvePath(stateDir) !== resolvePath(join(homedir(), '.local', 'state', 'agent-company'))) {
      throw new Error(`the shift template only supports the default state dir, not ${stateDir}`);
    }
    this.stateDir = stateDir;
    this.templateFile = templateFile;
  }

  private async ensureTemplate(): Promise<void> {
    if (this.linked) return;
    const cat = await systemctl(['cat', 'company-shift@.service']);
    if (cat.code !== 0) {
      const r = await systemctl(['link', this.templateFile]);
      if (r.code !== 0) throw new Error(`systemctl link ${this.templateFile}: ${r.err}`);
    }
    this.linked = true;
  }

  async launch(spec: LaunchSpec): Promise<{ unit?: string }> {
    await this.ensureTemplate();
    const dir = shiftDir(statePaths('', this.stateDir), spec.shiftId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = `${dir}/host-args.json`;
    writeFileSync(`${file}.tmp`, JSON.stringify(hostArgs(spec, this.stateDir), null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    // StartLimitBurst would otherwise block a resume right after a few failed starts.
    await systemctl(['reset-failed', spec.unit]);
    const r = await systemctl(['enable', '--now', spec.unit]);
    if (r.code !== 0) throw new Error(`systemctl enable --now ${spec.unit}: ${r.err.slice(0, 300)}`);
    return { unit: spec.unit };
  }

  /** Stop and disable (waits until stopped). Unknown/inactive units are fine; one still active is an error. */
  async kill(shiftId: string, unit: string | null): Promise<void> {
    const u = unit ?? shiftUnit(shiftId);
    await systemctl(['disable', '--now', u]);
    const active = await systemctl(['is-active', '--quiet', u]);
    if (active.code === 0) throw new Error(`${u} is still active after disable --now`);
  }
}

export interface ShiftEvents {
  live: [ShiftRow];
  delta: [ShiftRow, EngineDelta];
  frame: [ShiftRow, LoggedFrame];
  ended: [ShiftRow, string];
  launchFailed: [string, string, Error]; // identity, shiftId, error
}

export class ShiftManager extends EventEmitter<ShiftEvents> {
  readonly conns = new Map<string, HostConnection>();
  private connecting = new Set<string>();
  private readonly paths;

  private store: Store;
  private cfg: HqConfig;
  private launcher: Launcher;
  private factory: ConnectionFactory;
  constructor(store: Store, cfg: HqConfig, launcher: Launcher, factory: ConnectionFactory = (id, path) => new HostClient(id, path)) {
    super();
    this.store = store;
    this.cfg = cfg;
    this.launcher = launcher;
    this.factory = factory;
    this.paths = statePaths('', cfg.stateDir);
    mkdirSync(this.paths.shiftsDir, { recursive: true, mode: 0o700 });
  }

  get(id: string): ShiftRow | undefined {
    return this.store.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as ShiftRow | undefined;
  }

  current(identity: string): ShiftRow | undefined {
    return this.store.db.prepare(`SELECT * FROM shifts WHERE identity = ? AND state IN ('starting','live') ORDER BY shift_no DESC LIMIT 1`)
      .get(identity) as ShiftRow | undefined;
  }

  last(identity: string): ShiftRow | undefined {
    return this.store.db.prepare('SELECT * FROM shifts WHERE identity = ? ORDER BY shift_no DESC LIMIT 1').get(identity) as ShiftRow | undefined;
  }

  active(): ShiftRow[] {
    return this.store.db.prepare(`SELECT * FROM shifts WHERE state IN ('starting','live')`).all() as ShiftRow[];
  }

  connection(shiftId: string): HostConnection | undefined {
    const c = this.conns.get(shiftId);
    return c?.connected ? c : undefined;
  }

  private patch(id: string, fields: Partial<ShiftRow>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.store.db.prepare(`UPDATE shifts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  }

  /**
   * Make sure `identity` has a shift (B.2 "when a shift starts"). Resume the last session unless the
   * last shift ended for a reason that requires a fresh one (rotation, role change, rejected resume…).
   */
  private locks = new Map<string, Promise<unknown>>();

  /** Serialize lifecycle changes per identity so two callers never launch the same shift twice. */
  private locked<T>(identity: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(identity) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this.locks.set(identity, next);
    void next.catch(() => {}).finally(() => { if (this.locks.get(identity) === next) this.locks.delete(identity); });
    return next;
  }

  request(identity: string, opts: RequestOpts): Promise<ShiftRow> {
    return this.locked(identity, () => this.requestUnlocked(identity, opts));
  }

  private async requestUnlocked(identity: string, opts: RequestOpts): Promise<ShiftRow> {
    const cur = this.current(identity);
    if (cur && !opts.forceNew) {
      if (!this.conns.get(cur.id)?.connected) this.store.bg(this.attach(cur), 'shift.attach');
      return cur;
    }
    if (cur && opts.forceNew) await this.stopUnlocked(cur.id, opts.reason);

    const last = this.last(identity);
    // A shift number whose session never ran (launch/stop failed before any frame) is reused as new.
    const neverRan = !!last && last.host_seq === 0 && last.run_start_seq == null;
    const resume = !!last && !neverRan && !opts.forceNew && !NEW_SHIFT_REASONS.has(last.end_reason ?? '');
    const shiftNo = resume || (neverRan && !opts.forceNew) ? last!.shift_no : (last?.shift_no ?? 0) + 1;
    const shiftId = `${identity}-${shiftNo}`;
    const socketPath = shiftSocketPath(this.paths, shiftId);
    const sessionId = sessionIdFor(identity, shiftNo);
    const now = this.store.now();
    const kind: ShiftKind = opts.kind ?? last?.kind ?? (this.cfg.capacity.residents.includes(identity) ? 'resident' : 'work');
    const taskId = opts.taskId ?? (resume ? last!.task_id : null);
    this.store.db.prepare(`INSERT INTO shifts (id, identity, shift_no, session_id, state, kind, socket_path, task_id, started_at, last_event_at)
        VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET state='starting', kind=excluded.kind, started_at=excluded.started_at, ended_at=NULL,
        end_reason=NULL, last_event_at=excluded.last_event_at, in_turn=0, long_tool=0, stuck_since=NULL, nudged_at=NULL,
        interrupted_at=NULL, dead_signals=0, pid=NULL, host_pid=NULL, proc_start=NULL, last_ping_ok_at=NULL,
        unit_released_at=NULL, run_start_seq=NULL, task_id=excluded.task_id`)
      .run(shiftId, identity, shiftNo, sessionId, kind, socketPath, taskId, now, now);
    const row = this.get(shiftId)!;
    this.store.emit('shift.state', identity, { shift: shiftId, state: 'starting', resume, reason: opts.reason });
    const unit = shiftUnit(shiftId);
    this.patch(shiftId, { unit });
    this.heldExits.delete(shiftId); // held exits belong to a previous connection/run
    let stage = 'stop_failed';
    try {
      // The previous run's host may still be up (it lingers 10 min after claude exits, and answers `stop`
      // before it is gone). Stop it and wait, so two hosts never serve one shift.
      if (last?.unit) await this.launcher.kill(last.id, last.unit);
      stage = 'launch_failed';
      // A new shift (not a resume) won't see what the old CLI still held in its own queue: send it again.
      if (!resume) {
        this.store.db.prepare(`UPDATE messages SET state = 'queued', held_by_cli = 0, shift_id = NULL, resurrected = 0
          WHERE to_identity = ? AND state = 'delivered' AND held_by_cli = 1`).run(identity);
      }
      this.writePrime(shiftId, identity);
      const systemPromptFile = this.writeSystem(shiftId, identity);
      await this.launcher.launch({
        shiftId, identity, shiftNo, sessionId, resume, kind, socketPath, taskId, unit,
        cwd: opts.cwd ?? this.cfg.defaultCwd, systemPromptFile,
      });
    } catch (e) {
      this.markEnded(shiftId, 'dead', stage);
      this.emit('launchFailed', identity, shiftId, e as Error);
      throw e;
    }
    this.store.bg(this.attach(row), 'shift.attach');
    return this.get(shiftId)!;
  }

  /** Connect (with retries while the host boots) and keep the connection. Safe to call repeatedly. */
  async attach(row: ShiftRow, tries = 20, delayMs = 250): Promise<boolean> {
    if (this.conns.get(row.id)?.connected || this.connecting.has(row.id)) return true;
    this.connecting.add(row.id);
    try {
      for (let i = 0; i < tries && !this.closed; i++) {
        const fresh = this.get(row.id);
        if (!fresh || (fresh.state !== 'starting' && fresh.state !== 'live')) return false;
        const c = this.factory(row.id, fresh.socket_path ?? shiftSocketPath(this.paths, row.id));
        this.wire(c);
        try {
          await c.open(fresh.host_seq, fresh.host_log_id);
          const now = this.get(row.id);
          // Raced with markEnded/a relaunch while connecting: drop this socket, it belongs to a dead host.
          if (this.closed || !now || now.started_at !== fresh.started_at || (now.state !== 'starting' && now.state !== 'live')) {
            c.removeAllListeners(); c.close(); return false;
          }
          this.conns.set(row.id, c);
          return true;
        } catch {
          c.removeAllListeners();
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      return false;
    } finally {
      this.connecting.delete(row.id);
    }
  }

  private wire(c: HostConnection): void {
    const id = c.shiftId;
    c.on('hello', (info: HostInfo) => {
      if (this.closed) return;
      const row = this.get(id);
      const fields: Partial<ShiftRow> = {
        host_pid: info.hostPid, pid: info.claudePid, host_log_id: info.logId,
        proc_start: info.claudeProcStart ?? (info.claudePid ? procStart(info.claudePid) : null),
        in_turn: info.state === 'busy' ? 1 : 0, long_tool: info.activeTools?.length ? 1 : 0,
      };
      // A different durable log (new host process) or one shorter than ours: the host replays from 0,
      // and we dedupe by (logId, seq) from scratch.
      if (row && (row.host_log_id !== info.logId || info.lastSeq < row.host_seq)) fields.host_seq = 0;
      this.patch(id, fields);
    });
    c.on('delta', (ev: EngineDelta) => {
      if (this.closed) return;
      const row = this.get(id);
      if (!row) return;
      // Deltas arrive per token: record progress at most every 5s so the watchdog sees it without a write per token.
      const now = this.store.now();
      if (now - (this.lastDeltaAt.get(id) ?? 0) >= 5000) {
        this.lastDeltaAt.set(id, now);
        this.patch(id, { last_event_at: now, stuck_since: null, nudged_at: null, interrupted_at: null, in_turn: 1 });
      }
      this.emit('delta', row, ev);
    });
    c.on('spoolReady', () => { if (!this.closed) this.store.bg(this.collectSpool(id), 'spool'); });
    c.on('live', () => {
      if (this.closed) return;
      // Replay is over: an `exited` replayed from the log counts only if no later `starting` followed it
      // (a host restarted by systemd or at boot logs exited → starting while hq wasn't looking).
      const held = this.heldExits.get(id) ?? [];
      this.heldExits.delete(id);
      for (const f of held) {
        const r = this.get(id);
        if (r && (r.run_start_seq == null || f.seq > r.run_start_seq)) this.markEnded(id, 'ended', exitReason(f), r.started_at);
      }
      const row = this.get(id);
      if (!row || (row.state !== 'starting' && row.state !== 'live')) return;
      if (row.state === 'starting') {
        this.patch(id, { state: 'live', dead_signals: 0 });
        this.store.emit('shift.state', row.identity, { shift: id, state: 'live' });
      }
      this.emit('live', this.get(id)!);
    });
    c.on('frame', (f: LoggedFrame) => { if (!this.closed) this.onFrame(id, f, c.isLive); });
    c.on('close', () => {
      if (this.closed) return;
      this.heldExits.delete(id); // never carried into the next connection
      this.conns.delete(id);
      const row = this.get(id);
      if (row && (row.state === 'live' || row.state === 'starting')) {
        this.store.emit('shift.disconnected', row.identity, { shift: id });
      }
    });
  }

  private heldExits = new Map<string, Extract<LoggedFrame, { t: 'lifecycle' }>[]>();

  private onFrame(id: string, f: LoggedFrame, live = true): void {
    const row = this.get(id);
    if (!row) return;
    if (f.seq <= row.host_seq) return; // already folded (replay overlap)
    const now = this.store.now();
    const fields: Partial<ShiftRow> = { host_seq: f.seq };
    // Progress = the engine doing something. Our own deliveries and their echoes are not progress (B.5 stuck).
    if ((f.t === 'event' && f.ev.kind !== 'user_echo') || f.t === 'lifecycle') {
      Object.assign(fields, { last_event_at: now, stuck_since: null, nudged_at: null, interrupted_at: null });
    }
    if (f.t === 'event') {
      const ev = f.ev;
      // A tool call in flight is not "stuck" (B.5): long builds and subagents legitimately stay quiet.
      if (ev.kind === 'tool_use') { fields.in_turn = 1; fields.long_tool = 1; }
      else if (ev.kind === 'tool_result') fields.long_tool = 0;
      else if (ev.kind === 'text' || ev.kind === 'text_delta' || ev.kind === 'thinking_delta' || ev.kind === 'user_echo') fields.in_turn = 1;
      else if (ev.kind === 'result') { fields.in_turn = 0; fields.long_tool = 0; }
      else if (ev.kind === 'init' && ev.sessionId && ev.sessionId !== row.session_id) fields.session_id = ev.sessionId;
      else if (ev.kind === 'rate_limit') {
        fields.rate_limited_until = ev.status === 'rejected' && ev.resetsAt ? ev.resetsAt * (ev.resetsAt < 1e12 ? 1000 : 1) : null;
      }
      // Deltas are live-only (never persisted by hq); everything else is a fact in the event log.
      if (ev.kind === 'text_delta' || ev.kind === 'thinking_delta') this.emit('delta', row, ev);
      else this.store.emit(`engine.${ev.kind}`, row.identity, { shift: id, seq: f.seq, ev });
    } else if (f.t === 'lifecycle') {
      // A shift keeps one log across runs (resume, systemd restart, boot). The latest `starting` is the
      // current run; frames before it belong to older runs. Clock-independent.
      if (f.state === 'starting' && (row.run_start_seq == null || f.seq > row.run_start_seq)) fields.run_start_seq = f.seq;
      const runSeq = fields.run_start_seq ?? row.run_start_seq;
      const ours = runSeq == null || f.seq >= runSeq;
      if (ours && f.state === 'busy') fields.in_turn = 1;
      if (ours && f.state === 'idle') fields.in_turn = 0;
      this.patch(id, fields);
      // Held in the CLI's own queue: a --resume delivers them, so they are never re-sent (bet 2).
      if (f.heldByCli?.length) {
        const mark = this.store.db.prepare(`UPDATE messages SET held_by_cli = 1 WHERE id = ?`);
        for (const m of f.heldByCli) mark.run(m);
      }
      if (f.state === 'exited' && ours) {
        if (live) this.markEnded(id, 'ended', exitReason(f), row.started_at);
        else this.heldExits.set(id, [...(this.heldExits.get(id) ?? []), f]); // decided at `live`
      }
      this.emit('frame', this.get(id)!, f);
      return;
    }
    this.patch(id, fields);
    this.emit('frame', this.get(id)!, f);
  }

  /** `startedAt` guards against ending a newer run of the same shift id (a resume) by a stale caller. */
  markEnded(id: string, state: 'ended' | 'dead', reason: string, startedAt?: number): void {
    const row = this.get(id);
    if (!row || row.state === 'ended' || row.state === 'dead') return;
    if (startedAt != null && row.started_at !== startedAt) return;
    this.patch(id, { state, ended_at: this.store.now(), end_reason: reason, in_turn: 0 });
    this.conns.get(id)?.close();
    this.conns.delete(id);
    this.store.emit('shift.state', row.identity, { shift: id, state, reason });
    this.emit('ended', this.get(id)!, reason);
  }

  stop(id: string, reason: string, startedAt?: number): Promise<void> {
    const row = this.get(id);
    if (!row) return Promise.resolve();
    return this.locked(row.identity, () => this.stopUnlocked(id, reason, startedAt));
  }

  private async stopUnlocked(id: string, reason: string, startedAt?: number): Promise<void> {
    const row = this.get(id);
    if (!row || (row.state !== 'starting' && row.state !== 'live')) return;
    if (startedAt != null && row.started_at !== startedAt) return; // a newer run; not ours to stop
    const c = this.connection(id);
    let stopped = false;
    if (c) {
      try { await c.stop(reason); stopped = true; } catch { /* host may already be gone */ }
    }
    // Not reachable over the socket (still booting, wedged): stop the unit so no orphan keeps running.
    if (!stopped && row.kind !== 'foreign') await this.launcher.kill(id, row.unit).catch(() => {});
    this.markEnded(id, 'ended', reason, row.started_at);
  }

  async interrupt(id: string): Promise<void> {
    const c = this.connection(id);
    if (!c) throw new Error(`shift ${id} not connected`);
    await c.interrupt();
    this.patch(id, { interrupted_at: this.store.now() });
  }

  /** After an hq restart: reattach to every shift the store still believes is running (B.5). */
  async reattachAll(): Promise<void> {
    await Promise.all(this.active().filter((s) => s.kind !== 'foreign').map((s) => this.attach(s, 3, 200)));
  }

  /**
   * After a reboot, enabled template units usually bring their hosts back by themselves (reattach covers
   * that). Every shift the store believed
   * running whose host can't be reached and whose claude pid is gone is relaunched (resume). Task shifts
   * are only marked dead: the scheduler re-picks them from the head of the queue.
   */
  async restoreLost(procCheck: (pid: number) => string | null = procStart): Promise<string[]> {
    const restored: string[] = [];
    for (const s of this.active()) {
      if (s.kind === 'foreign' || s.machine !== 'local' || this.connection(s.id)) continue;
      const alive = s.pid != null && procCheck(s.pid) != null && (s.proc_start == null || procCheck(s.pid) === s.proc_start);
      if (alive) continue; // host may still be booting; the watchdog decides with two signals
      this.markEnded(s.id, 'dead', 'host_gone');
      this.store.emit('shift.lost', s.identity, { shift: s.id });
      if (s.task_id != null) continue;
      try {
        await this.request(s.identity, { reason: 'restore', kind: s.kind });
        restored.push(s.identity);
      } catch (e) {
        this.store.emit('shift.restore_failed', s.identity, { shift: s.id, error: (e as Error).message });
      }
    }
    return restored;
  }

  /** bet 4 liveness: a cheap control_request every few seconds; the board reads last_ping_ok_at. */
  async pingAll(): Promise<void> {
    await Promise.all([...this.conns.entries()].map(async ([id, c]) => {
      if (!c.connected || !c.isLive) return;
      if (await c.claudePing(3000)) this.patch(id, { last_ping_ok_at: this.store.now() });
    }));
  }

  /** Drain every connected host's hook spool (B.12). Also triggered live by `spool_ready`. */
  async collectSpools(): Promise<void> {
    for (const id of [...this.conns.keys()]) await this.collectSpool(id).catch(() => { /* next sweep */ });
  }

  private spooling = new Set<string>();
  private lastDeltaAt = new Map<string, number>();

  /** Read → store as events → persist cursor → ack (only after it is durable here). */
  async collectSpool(id: string): Promise<void> {
    const c = this.connection(id);
    const row = this.get(id);
    if (!c || !row || this.spooling.has(id)) return;
    this.spooling.add(id);
    try {
      let cursor = row.spool_cursor;
      for (let i = 0; i < 10; i++) {
        const r = await c.readSpool(cursor);
        this.store.db.transaction(() => {
          for (const e of r.entries) this.store.emit(`hook.${e.event}`, row.identity, { shift: id, ts: e.ts, payload: e.payload });
          if (r.cursor && r.cursor !== cursor) this.patch(id, { spool_cursor: r.cursor });
        })();
        if (r.cursor && r.cursor !== cursor) {
          cursor = r.cursor;
          await c.ackSpool(cursor);
        }
        if (!r.more) break;
      }
    } finally {
      this.spooling.delete(id);
    }
  }

  /** L0 + L1 from the contract, rewritten on every (re)start so a merged contract change applies at the next run. */
  writeSystem(shiftId: string, identity: string): string {
    const row = getIdentity(this.store, identity);
    if (!row) {
      // Never launch bare: an unknown identity still learns how to reply, and the board shows why.
      this.store.emit('shift.no_identity', identity, { shift: shiftId });
    }
    return writeSystemPrompt(shiftDir(this.paths, shiftId), buildSystemPrompt(this.cfg.companyDir, row ?? unknownIdentity(identity), this.cfg.managerId,
      row?.reports_to ? getIdentity(this.store, row.reports_to) : undefined));
  }

  /** Memory lookup for prime.json (set by hq: ingest recall over memory/). */
  primeRecall: ((identity: string, query: string) => { top?: { ref: string; body: string }; others: string[] }) | null = null;

  /**
   * B.3.3: the SessionStart hook reads shiftDir/prime.json; hq writes it before every (re)start.
   * Sections and budgets per company-api.ts PRIME_BUDGETS (sum 10,000). topRecord = body of the single
   * most relevant L3 record (bet 9).
   */
  writePrime(shiftId: string, identity: string): void {
    const dir = shiftDir(this.paths, shiftId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const handoffRow = this.store.db.prepare(`SELECT args FROM ops WHERE identity = ? AND op = 'handoff' ORDER BY received_at DESC LIMIT 1`)
      .get(identity) as { args: string } | undefined;
    const pending = this.store.db.prepare(`SELECT id, from_identity, body FROM messages WHERE to_identity = ?
      AND state IN ('queued','delivered','seen') ORDER BY created_at LIMIT 20`).all(identity) as { id: string; from_identity: string; body: string }[];
    const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
    const handoffArgs = handoffRow ? (JSON.parse(handoffRow.args) as Record<string, unknown>) : null;
    const project = (this.store.db.prepare('SELECT project FROM identities WHERE id = ?').get(identity) as { project: string | null } | undefined)?.project;
    const query = [project, ...pending.map((m) => m.body.slice(0, 200)), ...(Array.isArray(handoffArgs?.next) ? handoffArgs!.next as string[] : [])]
      .filter(Boolean).join(' ');
    let mem: { top?: { ref: string; body: string }; others: string[] } = { others: [] };
    try { if (query && this.primeRecall) mem = this.primeRecall(identity, query); } catch { /* prime still gets written */ }
    const prime: PrimeFile = {
      v: 1, shift: shiftId, identity, updatedAt: new Date(this.store.now()).toISOString(),
      ...(handoffArgs ? { handoff: cut(handoffYaml(handoffArgs), PRIME_BUDGETS.handoff) } : {}),
      ...(mem.top ? { topRecord: cut(`[${mem.top.ref}]\n${mem.top.body}`, PRIME_BUDGETS.topRecord) } : {}),
      ...(mem.others.length ? { memoryIndex: cut(mem.others.map((r) => `- ${r}`).join('\n'), PRIME_BUDGETS.memoryIndex) } : {}),
      ...(pending.length ? { inbox: cut(pending.map((m) => `- ${m.id} מ-${m.from_identity}: ${m.body.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'), PRIME_BUDGETS.inbox) } : {}),
      ...(mem.others.length ? { pointers: cut(`פרטים: ${mem.others.slice(0, 3).map((r) => `recall ${r}`).join(' · ')}`, PRIME_BUDGETS.pointers) } : {}),
    };
    const file = `${dir}/prime.json`;
    writeFileSync(`${file}.tmp`, JSON.stringify(prime, null, 2), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /**
   * Ended shifts' units are disabled so they don't come back at boot. Done under the identity lock and
   * only if no newer run started, so it can never stop a relaunch of the same shift id.
   */
  async releaseEnded(): Promise<void> {
    const rows = this.store.db.prepare(`SELECT * FROM shifts WHERE state IN ('ended','dead') AND unit IS NOT NULL
      AND unit_released_at IS NULL AND kind != 'foreign'`).all() as ShiftRow[];
    for (const r of rows) {
      try {
        await this.locked(r.identity, async () => {
          const now = this.get(r.id);
          if (!now || (now.state !== 'ended' && now.state !== 'dead') || now.started_at !== r.started_at) return;
          await this.launcher.kill(r.id, r.unit);
          this.patch(r.id, { unit_released_at: this.store.now() });
        });
      } catch (e) {
        // A wedged unit is retried next sweep; it never blocks releasing the others.
        this.store.emit('shift.release_failed', r.identity, { shift: r.id, error: (e as Error).message });
      }
    }
  }

  setFields(id: string, fields: Partial<ShiftRow>): void {
    this.patch(id, fields);
  }

  private closed = false;

  /** Wait for in-flight launches/stops (hq shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.locks.values()]);
  }

  closeAll(): void {
    this.closed = true;
    this.removeAllListeners();
    for (const c of this.conns.values()) { c.removeAllListeners(); c.on('close', () => {
      if (this.closed) return;}); c.close(); }
    this.conns.clear();
  }
}

function unknownIdentity(id: string): IdentityRow {
  return { id, name: id, title: '', symbol: '', team: null, team_kind: null, project: null, reports_to: null,
    lifecycle: 'dormant', source: 'unknown', active: 1, data: '{}', updated_at: 0 };
}

function handoffYaml(a: Record<string, unknown>): string {
  return Object.entries(a).filter(([, v]) => v != null && v !== '' && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${String(x)}`).join('\n')}` : `${k}: ${String(v)}`).join('\n');
}

function exitReason(f: Extract<LoggedFrame, { t: 'lifecycle' }>): string {
  return f.error ?? (f.exitCode === 0 ? 'exit' : 'crash');
}
