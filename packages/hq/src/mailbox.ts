// Identity mailboxes (B.4). Every message is stored first, then delivered over the best channel:
//   live shift we hold → shift-host `send` (stdin user line)  ·  foreign session → adapter.injectForeign
//   resting/dead → request a shift (resume) and deliver as its first prompt.
// No `delivered` in 60s → one retry with resurrection → visible failure in the sender's inbox and the owner's.
// msg_id is the idempotency key end to end (API, host `send`, retries after crash).
import { randomUUID } from 'node:crypto';
import { g, loadNames, OWNER, pre, type CompanyNames, type AskDTO, type AskRequest, type DeliveryState, type MessageKind, type MessageState, type Priority, type TellRequest, type Urgency, type WaitingOn } from '@company/shared';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';
import type { Inbox } from './inbox.ts';
import type { ShiftManager, ShiftRow } from './shifts.ts';
import { getIdentity, isStandingWorker, projectLead } from './org.ts';
import { toDTO, type AttachmentDTO, type Uploads } from './uploads.ts';

export interface MessageRow {
  id: string; from_identity: string; to_identity: string; kind: MessageKind; body: string; urgency: Urgency;
  priority: Priority; ref: string | null; state: MessageState; attempts: number; resurrected: number; shift_id: string | null;
  error: string | null; created_at: number; last_attempt_at: number | null; delivered_at: number | null; seen_at: number | null;
  handled_at: number | null; failed_at: number | null;
  /** Engine messageId of the assistant text this message was made from (an owner reply, chat.md §2.3א). */
  text_ref: string | null;
  /** Images the owner attached (uploads.ts). Stored as JSON; get() and list() return the array. */
  attachments: AttachmentDTO[] | null;
  /** His `now` waits for this running tool (not safe to stop); the bubble says so until the worker reads it. */
  waiting_on: WaitingOn | null;
}

type StoredRow = Omit<MessageRow, 'attachments' | 'waiting_on'> & { attachments: string | null; waiting_on: string | null };
const hydrate = (r: StoredRow): MessageRow => ({ ...r, attachments: r.attachments ? JSON.parse(r.attachments) as AttachmentDTO[] : null,
  waiting_on: r.waiting_on ? JSON.parse(r.waiting_on) as WaitingOn : null });

/** Tools whose output the owner already sees as its own item: a turn that used one has no text reply (chat.md §2.3א). */
const OWNER_FACING_TOOLS = new Set(['mcp__company__ask', 'mcp__company__request_go']);

/** Native socket path for sessions we don't hold (B.4 row 2). Provided by the adapter (engine lane). */
export interface ForeignInjector {
  injectForeign(pid: number, text: string, opts: { fromName: string; priority: Priority }): Promise<unknown>;
}

export const noForeignInjector: ForeignInjector = {
  async injectForeign() { throw new Error('adapter.injectForeign not available yet'); },
};

/** The manager's explicit decision on an escalated ask, as the escalation message asks for it. */
const MANAGER_DECISION = /^\s*החלטתי במקומך\s*[:,\-–]?\s*/;

const URGENCY_HE: Record<Urgency, string> = { urgent: 'דחופה', normal: 'רגילה', low: 'נמוכה' };

interface AskRow { id: string; from_identity: string; question: string; headline: string | null; options: string; blocking: number; urgency: Urgency;
  state: AskDTO['state']; answer: string | null; answered_by: AskDTO['answered_by']; created_at: number; escalated_at: number | null; manager_note: string | null }

/** A `result` error of a turn that never started: no text, no turns, no time (a refused resume). */
export function neverRan(ev: { subtype: string; text?: string; numTurns?: number; durationMs?: number }): boolean {
  return ev.subtype === 'error_during_execution' && !ev.text && ev.numTurns === 0 && ev.durationMs === 0;
}

/** A `result` error that never reached the model: no text and no token in or out (the API refused or dropped the request). */
export function tokenless(ev: { text?: string; usage?: unknown }): boolean {
  if (ev.text) return false;
  const u = (ev.usage ?? {}) as Record<string, unknown>;
  return !(Number(u.input_tokens) > 0) && !(Number(u.output_tokens) > 0);
}

export class Mailbox {
  deliveryPaused = false;
  private leanDispatch: Promise<void> = Promise.resolve();
  // Persist the reservation before send: HQ can restart after the host accepted it but before turn/started.
  private get leanMessage(): { id: string; identity: string } | null {
    return JSON.parse(this.store.getMeta('codex.active_message') || 'null');
  }
  private set leanMessage(value: { id: string; identity: string } | null) {
    this.store.setMeta('codex.active_message', JSON.stringify(value));
  }
  leanBusy(): boolean { return this.leanMessage !== null; }
  /** #237: tokenless error results held for `retryGraceMs`, per shift: a fresh `init` of the same shift cancels them. */
  private heldErrors = new Map<string, { timer: NodeJS.Timeout; identity: string; err: Record<string, unknown> }>();
  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private inbox: Inbox;
  private foreign: ForeignInjector;
  private uploads: Uploads | null;
  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, inbox: Inbox, foreign: ForeignInjector = noForeignInjector,
    uploads: Uploads | null = null) {
    this.store = store;
    this.uploads = uploads;
    this.cfg = cfg;
    this.shifts = shifts;
    this.inbox = inbox;
    this.foreign = foreign;
    shifts.on('live', (row) => this.store.bg(this.flush(row.identity), 'mailbox.flush'));
    // `seen` comes only from the host's delivery frames (started/completed = dequeued into the
    // conversation). Assistant text is not proof: a `later` message can still be waiting behind the turn.
    shifts.on('frame', (row, f, live?: boolean) => {
      if (f.t === 'delivery') this.onDelivery(row, f.msgId, f.state, f.error);
      // The CLI retries a request that failed before a token (adi-1 22/10 06:45: error after 2s, a new `init` at once, the
      // message answered): that error is no failure of the turn. A held one is raised only if no new turn begins.
      if (f.t === 'event' && f.ev.kind === 'init' && live !== false) this.dropHeld(row.id);
      if (f.t === 'event' && f.ev.kind === 'result') {
        if (this.leanMessage?.identity === row.identity) this.leanMessage = null;
        // error-watch.ts: a turn that ended in an error he did not cause (a stop he pressed is `interrupted`, #177).
        // `neverRan`: a resume the CLI refused (no transcript) answers so; the shift ends as `resume_rejected` and the next
        // run is a new shift (shifts.ts), so there was no turn to fail.
        // Replayed frames (reattach after an hq restart) were caught the first time.
        if (f.ev.isError && !f.ev.interrupted && !neverRan(f.ev) && live !== false) {
          const err = { shift: row.id, identity: row.identity, subtype: f.ev.subtype, text: (f.ev.text ?? '').slice(0, 1000) };
          if (f.ev.subtype === 'error_during_execution' && tokenless(f.ev)) {
            this.raiseHeld(row.id);
            const timer = setTimeout(() => this.raiseHeld(row.id), this.cfg.timers.retryGraceMs);
            timer.unref();
            this.heldErrors.set(row.id, { timer, identity: row.identity, err });
          } else this.store.emit('turn.error', row.identity, err);
        }
        this.onTurnEnd(row, f.ev);
      }
    });
    shifts.on('ended', (row) => {
      if (this.leanMessage?.identity === row.identity) {
        const m = this.get(this.leanMessage.id);
        this.leanMessage = null;
        if (m && ['queued', 'delivered'].includes(m.state)) this.fail({ ...m, error: 'משמרת Codex הסתיימה לפני קבלת הפנייה; אפשר לשלוח אותה מחדש' });
      }
      this.raiseHeld(row.id); this.requeueUndelivered(row);
    });
  }

  /** A new turn began: the held error was the CLI's own retry, nothing to raise. */
  private dropHeld(shift: string): void {
    const h = this.heldErrors.get(shift);
    if (h) { clearTimeout(h.timer); this.heldErrors.delete(shift); }
  }
  /** The grace ended (or the shift did, or another error came): the held error is real. */
  private raiseHeld(shift: string): void {
    const h = this.heldErrors.get(shift);
    if (!h) return;
    clearTimeout(h.timer); this.heldErrors.delete(shift);
    this.store.emit('turn.error', h.identity, h.err);
  }

  /** hq's own asks (account login): the answer goes straight here, in process: never the store, never the WS. */
  onHqAnswer: ((askId: string, answer: string) => void) | null = null;
  /** Stale messages of a worker on a node that never took its task: true = handled there (the task moved here). */
  nodeFallback: ((identity: string) => Promise<boolean>) | null = null;
  /** #224: a stale task brief its worker never took: true = the scheduler took it back (the task starts again). */
  briefStale: ((m: MessageRow) => Promise<boolean>) | null = null;
  /** #224: a task worker between failed starts: its next start brings it up, so nothing here wakes it. */
  startPending: ((identity: string) => boolean) | null = null;

  /** The owner's and the manager's names in texts, from org.yaml (re-read when it changes). */
  get names(): CompanyNames { return loadNames(this.cfg.companyDir, this.cfg.managerId); }

  label(id: string): string {
    if (id === OWNER) return this.names.owner.name;
    if (id === 'hq') return 'hq';
    const i = getIdentity(this.store, id);
    return i ? i.name : id; // symbols are icon names (Material Symbols), not text
  }

  /**
   * The stdin envelope (B.4): the worker knows who it's from and replies with `ref`. An attached image is
   * a path on this machine: Read on it shows the worker the image itself.
   */
  envelope(m: Pick<MessageRow, 'id' | 'from_identity' | 'urgency' | 'body' | 'kind' | 'ref'> & { attachments?: AttachmentDTO[] | null }): string {
    const ref = m.ref ? ` · ref: ${m.ref}` : '';
    const files = (m.attachments ?? []).map((a) => {
      const path = this.uploads?.get(a.id)?.path ?? '(הקובץ לא נמצא בשרת)';
      return `[תמונה מצורפת: ${path} · כדי לראות אותה, פותחים את הנתיב ב-Read]`;
    });
    const body = [m.body, ...files].filter(Boolean).join('\n');
    return `[הודעה מ-${this.label(m.from_identity)} (${m.from_identity}) · דחיפות: ${URGENCY_HE[m.urgency]} · ${m.id}${ref}]\n${body}`;
  }

  get(id: string): MessageRow | undefined {
    const r = this.store.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as StoredRow | undefined;
    return r && hydrate(r);
  }

  list(identity: string, limit = 200, beforeTs?: number): MessageRow[] {
    return (this.store.db.prepare(`SELECT * FROM messages WHERE (to_identity = ? OR from_identity = ?) AND created_at < ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(identity, identity, beforeTs ?? Number.MAX_SAFE_INTEGER, limit) as StoredRow[]).map(hydrate);
  }

  private setState(id: string, state: MessageState, extra: Record<string, unknown> = {}): void {
    const col = { delivered: 'delivered_at', seen: 'seen_at', handled: 'handled_at', failed: 'failed_at', queued: null }[state];
    const sets = ['state = @state', ...(col ? [`${col} = COALESCE(${col}, @now)`] : []), ...Object.keys(extra).map((k) => `${k} = @${k}`)];
    this.store.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = @id`).run({ id, state, now: this.store.now(), ...extra });
    const m = this.get(id)!;
    this.store.emit('message.state', m.to_identity, { id, state, from: m.from_identity, to: m.to_identity });
  }

  /** What his message waits for, to the app on the same `message.state` stream (the state itself is unchanged). */
  private setWaiting(id: string, w: WaitingOn): void {
    this.store.db.prepare('UPDATE messages SET waiting_on = ? WHERE id = ?').run(JSON.stringify(w), id);
    const m = this.get(id)!;
    this.store.emit('message.state', m.to_identity, { id, state: m.state, from: m.from_identity, to: m.to_identity, waiting_on: w });
  }

  /** Store then deliver. Idempotent by msg_id: a retried request returns the existing message. */
  tell(req: TellRequest & { kind?: MessageKind; text_ref?: string; attachments?: string[]; chat?: boolean }): MessageRow {
    const id = req.msg_id ?? `m-${randomUUID()}`;
    const existing = this.get(id);
    if (existing) return existing;
    const files = this.attachmentsFor(req.attachments ?? []);
    if (!req.to || (!req.body && !files.length)) throw new Error('to and body are required');
    const from = req.from ?? OWNER;
    // What closes an ask: an explicit answer (the app's button or reply, `answer`), or his own words in that worker's
    // conversation while its card is open. A worker's tell closes nothing, the manager's included: with ref=<ask> on
    // an escalated ask it is a note on the card, unless it opens with the decision line ("החלטתי במקומך").
    if (req.ref && from === this.cfg.managerId) {
      const a = this.getAsk(req.ref);
      if (a && a.from_identity === req.to && a.state === 'escalated') {
        if (MANAGER_DECISION.test(req.body ?? '')) {
          this.answer(a.id, req.body ?? '', 'manager', undefined, req.attachments);
          return this.lastAnswer(a.id)!;
        }
        this.store.db.prepare('UPDATE asks SET manager_note = ? WHERE id = ?').run(req.body ?? '', a.id);
        this.store.emit('ask.noted', a.from_identity, this.getAsk(a.id)!);
      }
    }
    if (req.chat && from === OWNER && (req.kind ?? 'tell') === 'tell') {
      const target = req.ref ? this.getAsk(req.ref) : undefined;
      const open = target ? [target] : (this.store.db.prepare(`SELECT * FROM asks WHERE from_identity = ? AND state IN ('open','escalated')`).all(req.to) as AskRow[]).map(askDTO);
      if (open.length === 1 && open[0]!.from_identity === req.to && (open[0]!.state === 'open' || open[0]!.state === 'escalated')) {
        this.answer(open[0]!.id, req.body ?? '', 'owner', undefined, req.attachments);
        return this.lastAnswer(open[0]!.id)!;
      }
    }
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, urgency, priority, ref, text_ref, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, from, req.to, req.kind ?? 'tell', req.body ?? '', req.urgency ?? 'normal',
      req.priority ?? (req.urgency === 'urgent' ? 'now' : 'next'), req.ref ?? null, req.text_ref ?? null,
      files.length ? JSON.stringify(files) : null, now);
    const m = this.get(id)!;
    this.store.emit('message.new', req.to, m);
    // A reply that references a message marks that message handled (B.4 `handled`).
    if (req.ref) {
      const orig = this.get(req.ref);
      if (orig && orig.to_identity === from && orig.state !== 'handled' && orig.state !== 'failed') this.setState(orig.id, 'handled');
    }
    this.store.bg(this.deliver(id), 'mailbox.deliver');
    return this.get(id)!;
  }

  /** Upload ids → what the message carries. An id that was never uploaded is the client's error, not a silent drop. */
  private attachmentsFor(ids: string[]): AttachmentDTO[] {
    if (!ids.length) return [];
    if (ids.length > 10) throw new Error('attachments must be at most 10');
    return ids.map((id) => {
      const u = this.uploads?.get(id);
      if (!u) throw new Error(`attachments must be uploaded first: no upload ${id}`);
      return toDTO(u);
    });
  }

  markHandled(id: string): boolean {
    const m = this.get(id);
    if (!m || m.state === 'failed') return false;
    if (m.state !== 'handled') this.setState(id, 'handled');
    return true;
  }

  /** One delivery attempt over the best channel available right now. */
  /**
   * `retry` asks the host to write a fresh stdin line for a message it never got accepted (written/failed).
   * Without it a re-send is idempotent in the host and only reports the stored state.
   */
  async deliver(id: string, retry = false, force = false): Promise<void> {
    if (this.deliveryPaused) return;
    if (!this.cfg.codexLean) return this.deliverOne(id, retry, force);
    const m = this.get(id);
    if (!m || m.state !== 'queued') return;
    if (m.to_identity === OWNER || m.to_identity === 'hq') return this.deliverOne(id, retry);
    const since = Number(this.store.getMeta('codex.lean_since') ?? 0);
    // Old prompts and autonomous peer/system messages stay pending, never replayed into a new provider.
    if (m.from_identity !== OWNER || m.created_at < since) return;
    const run = this.leanDispatch.catch(() => {}).then(async () => {
      if (this.deliveryPaused || !this.cfg.codexLean) return;
      if (this.get(id)?.state !== 'queued') return;
      if (this.leanMessage) return;
      if (this.shifts.active().some((s) => s.account === 'codex' && (s.in_turn || s.state === 'starting'))) return;
      const cur = this.shifts.current(m.to_identity);
      if (!cur || cur.account !== 'codex') {
        try { await this.shifts.request(m.to_identity, { reason: 'message' }); }
        catch (e) { this.fail({ ...m, error: String(e) }); return; }
      }
      await this.deliverOne(id, retry);
    });
    this.leanDispatch = run;
    return run;
  }

  private async deliverOne(id: string, retry = false, force = false): Promise<void> {
    const m = this.get(id);
    if (!m || m.state !== 'queued') return;
    // Gathered (24/10, quota): a worker's message that can wait waits for the batch, and wakes the worker once for all of it.
    if (!force && this.heldUntil(m) > this.store.now()) return;
    this.store.db.prepare('UPDATE messages SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?').run(this.store.now(), id);

    if (m.to_identity === 'hq') {
      // hq is not a worker: a reply to a system notice is recorded and closed, never delivered to a shift.
      this.setState(id, 'handled');
      return;
    }
    if (m.to_identity === OWNER) {
      // The app is his channel: the message is in his conversation the moment it's stored.
      this.setState(id, 'delivered');
      return;
    }
    // A standing worker's message about one task of its (its prompt, close_team's handoff ask) dies with that task:
    // it never reaches the session of the next task, and never wakes the worker in the checkout after the close.
    const bound = this.boundTask(m);
    if (bound != null && this.taskDone(bound)) { this.failBound(m); return; }
    const shift = this.shifts.current(m.to_identity);
    if (shift?.kind === 'foreign') {
      try {
        if (!shift.pid) throw new Error('foreign session has no pid');
        await this.foreign.injectForeign(shift.pid, this.envelope(m), { fromName: this.label(m.from_identity), priority: m.priority });
        this.setState(id, 'delivered', { shift_id: shift.id });
      } catch (e) {
        this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run((e as Error).message, id);
      }
      return;
    }
    const conn = shift ? this.shifts.connection(shift.id) : undefined;
    if (shift && conn?.isLive) {
      try {
        if (this.cfg.codexLean) this.leanMessage = { id, identity: m.to_identity };
        this.store.db.prepare('UPDATE messages SET shift_id = ? WHERE id = ?').run(shift.id, id);
        // His own `now` stops the worker, but only out of a tool that is safe to cut (shift-host safe-tools.ts, adi
        // 21/10/2026); otherwise it goes in right after the running tool. hq's notes and the answers it writes in his
        // name (GO, ask, inbox: kind `answer`) never stop anyone.
        const stop = m.from_identity === OWNER && m.kind === 'tell' && m.priority === 'now' ? { stopIfSafe: true } : undefined;
        // Idempotent on msgId in the host: a resend after an hq crash returns the current state instead.
        let r = await conn.send(id, this.envelope(m), m.priority, retry, stop);
        // The host remembers this msgId as never accepted (e.g. its claude restarted): write it again.
        if (r?.state === 'failed' && !retry && !this.cfg.codexLean) r = await conn.send(id, this.envelope(m), m.priority, true);
        if (r?.waitingOn) this.setWaiting(id, r.waitingOn);
        if (r) this.onDelivery(shift, id, r.state);
      } catch (e) {
        // A timeout/disconnect is not proof of rejection: the host may already be running this prompt.
        // Keep the durable slot until its delivery/result/exit is reconciled.
        this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run((e as Error).message, id);
      }
      return;
    }
    if (!shift) {
      // A task worker whose task is done is not woken again (it would take a slot as <identity>-2).
      if (this.taskClosed(m.to_identity)) { this.failClosed(m); return; }
      // Its task has not started yet (a worktree being set up, back from a node): its start brings the shift up in the
      // task's worktree, and the flush on `live` delivers this. A wake now would start it in hq's default cwd.
      if (this.waitsForStart(m.to_identity)) return;
      // Resting or dead: wake it. The message becomes the first prompt once the host is live (flush on `live`).
      try {
        // Bound to its task: shifts.request refuses under the identity's lock if close_team got there first.
        await this.shifts.request(m.to_identity, { reason: 'message', ...(bound != null ? { taskId: bound } : {}) });
      } catch (e) {
        if (bound != null && this.taskDone(bound)) { this.failBound(m); return; }
        this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(`wake failed: ${(e as Error).message}`, id);
      }
    }
    // shift exists but not live yet: `live` → flush() delivers it.
  }

  /** Deliver everything still queued for an identity (called when its shift goes live): what was gathered goes with it. */
  async flush(identity: string): Promise<void> {
    const rows = this.store.db.prepare(`SELECT id FROM messages WHERE to_identity = ? AND state = 'queued' ORDER BY created_at, rowid`)
      .all(identity) as { id: string }[];
    for (const r of rows) await this.deliver(r.id, false, true);
  }

  /**
   * A message one worker sends another that can wait (not `now`, not his, not an answer or an escalation) to a standing
   * worker goes in at once when nothing of the kind went to that worker in the last `gatherMs`: the first one may be a
   * question its sender waits on (yoav 24/10), and so does a reply to what the recipient sent. What follows inside that window is gathered, and goes in together when it
   * ends (the CLI folds lines that wait behind a turn into it), or at once with anything that goes in sooner: a shift
   * that comes up, a turn already running. Each one used to wake a lead for a whole turn (task-496: 214 of 334 lead
   * wakes in 3 days were such messages). 0 = not held.
   */
  heldUntil(m: Pick<MessageRow, 'from_identity' | 'to_identity' | 'priority' | 'kind' | 'state' | 'ref'>): number {
    const gather = this.cfg.batching.enabled ? this.cfg.batching.gatherMs : 0;
    if (!gather || !this.gathers(m)) return 0;
    const cur = this.shifts.current(m.to_identity);
    if (cur && cur.kind !== 'foreign' && cur.state === 'live' && cur.in_turn) return 0;
    // The window opens at the last such message (a reply that went in at once is not one) that went in before the oldest one still waiting came: a batch going in
    // now (its first line moves that "last") is all due together.
    const waiting = (this.store.db.prepare(`SELECT from_identity, to_identity, priority, kind, state, ref, created_at FROM messages
      WHERE to_identity = ? AND state = 'queued' AND last_attempt_at IS NULL ORDER BY created_at, rowid`).all(m.to_identity) as
      (Pick<MessageRow, 'from_identity' | 'to_identity' | 'priority' | 'kind' | 'state' | 'ref'> & { created_at: number })[]).find((o) => this.gathers(o));
    if (!waiting) return 0;
    const last = this.store.db.prepare(`SELECT MAX(delivered_at) AS t FROM messages WHERE to_identity = ? AND delivered_at IS NOT NULL
      AND delivered_at <= ? AND priority != 'now' AND kind NOT IN ('answer','escalation') AND from_identity NOT IN (?, 'hq')
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.id = messages.ref AND o.from_identity = messages.to_identity)`)
      .get(m.to_identity, waiting.created_at, OWNER) as { t: number | null };
    return last.t == null ? 0 : last.t + gather;
  }

  private gathers(m: Pick<MessageRow, 'from_identity' | 'to_identity' | 'priority' | 'kind' | 'state' | 'ref'>): boolean {
    if (m.state !== 'queued' || m.priority === 'now' || m.kind === 'answer' || m.kind === 'escalation') return false;
    if (m.from_identity === OWNER || m.from_identity === 'hq' || !getIdentity(this.store, m.from_identity)) return false;
    // A reply to what the recipient itself sent: it may be waiting on it.
    if (m.ref && this.get(m.ref)?.from_identity === m.to_identity) return false;
    const to = getIdentity(this.store, m.to_identity);
    return !!to && to.active === 1 && to.team_kind !== 'task';
  }

  /**
   * Host delivery states → mailbox states (shift-protocol.ts, measured on 2.1.303):
   * delivered = the CLI accepted the line (any priority) → `delivered`;
   * started/completed = dequeued into the conversation → `seen`. `written` is not an ack.
   */
  private onDelivery(row: Pick<ShiftRow, 'id'>, msgId: string, state: DeliveryState, error?: string): void {
    const m = this.get(msgId);
    if (!m) return;
    if (state === 'failed') {
      this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(error ?? 'host reported failure', msgId);
      if (this.cfg.codexLean) {
        if (this.leanMessage?.id === msgId) this.leanMessage = null;
        this.fail({ ...m, error: error ?? 'Codex לא קיבל את הפנייה; אפשר לשלוח מחדש' });
      }
      return;
    }
    if (state === 'written') return;
    if (m.state === 'queued') this.setState(msgId, 'delivered', { shift_id: row.id, error: null });
    if ((state === 'started' || state === 'completed') && this.get(msgId)!.state === 'delivered') this.setState(msgId, 'seen');
  }

  /**
   * The conversation model with the owner (chat.md §2.3א): in a turn he started, the worker's own final
   * assistant text IS the reply. It becomes one stored message worker → owner (ref = his message, text_ref =
   * the engine messageId), so it is in his conversation list, closes his message as handled, and the app shows
   * the streamed bubble and the stored message as a single item. A turn that already reached him through
   * `tell`/`ask`/`request_go` has no text reply: its text was internal and is not stored.
   * The turn is the event-log window after this shift's previous `engine.result` up to this one (indexed on
   * identity, seq). Its triggers are his messages dequeued (`seen`) inside that window and still unanswered, so a
   * message left over from an errored turn never turns a later, unrelated turn's text into a reply. Everything
   * comes from the store, so a result replayed after an hq restart still yields exactly one reply (`<msg>-reply`).
   */
  private onTurnEnd(row: Pick<ShiftRow, 'id' | 'identity'>, ev: { isError: boolean; text?: string }): void {
    const db = this.store.db;
    type Ev = { seq: number; ts: number; data: string };
    const results = (db.prepare(`SELECT seq, ts, data FROM events WHERE identity = ? AND type = 'engine.result' ORDER BY seq DESC LIMIT 50`)
      .all(row.identity) as Ev[]).filter((r) => shiftOf(r.data) === row.id);
    if (!results.length) return;
    const cur = results[0]!;
    // First turn of the shift: the window starts at its `starting`, never at the start of the worker's history.
    const start = results[1] ?? (db.prepare(`SELECT seq, ts, data FROM events WHERE identity = ? AND type = 'shift.state' ORDER BY seq DESC LIMIT 50`)
      .all(row.identity) as Ev[]).find((r) => shiftOf(r.data) === row.id && (JSON.parse(r.data) as { state?: string }).state === 'starting');
    const window = (db.prepare(`SELECT seq, type, data FROM events WHERE identity = ? AND seq > ? AND seq < ? ORDER BY seq`)
      .all(row.identity, start?.seq ?? 0, cur.seq) as { seq: number; type: string; data: string }[])
      .map((r) => ({ seq: r.seq, type: r.type, data: JSON.parse(r.data) as Record<string, any> }));
    // Text of work that began before his message arrived mid-turn is not part of the reply to it.
    const firstTriggerSeq = window.find((e) => e.type === 'message.state' && e.data.state === 'seen' && e.data.from === OWNER)?.seq ?? 0;
    const triggers = window
      .filter((e) => e.type === 'message.state' && e.data.state === 'seen' && e.data.from === OWNER)
      .map((e) => this.get(String(e.data.id)))
      .filter((m): m is MessageRow => !!m && m.state === 'seen' && m.shift_id === row.id);
    if (!triggers.length) return;
    // Reached him in this turn: a stored message to him (any path: MCP, API from Bash), or the tool call itself
    // (its op may be ingested after the result).
    const stored = db.prepare(`SELECT 1 FROM messages WHERE from_identity = ? AND to_identity = ? AND created_at >= ? LIMIT 1`)
      .get(row.identity, OWNER, Math.min(...triggers.map((t) => t.seen_at ?? t.created_at)));
    // The first tool call of the turn that reached him; the turn's text before it he already saw.
    const reached = window.find((e) => {
      if (e.type !== 'engine.tool_use' || e.data.shift !== row.id || e.data.ev?.parentToolUseId) return false;
      const { name, input } = e.data.ev as { name?: string; input?: { to?: unknown } };
      if (OWNER_FACING_TOOLS.has(name ?? '')) return true;
      if (name !== 'mcp__company__tell') return false;
      // A `to` that is no identity ("רן") was meant for him; ingest rejects it and the worker resends.
      const to = typeof input?.to === 'string' ? input.to : '';
      return to === OWNER || (to !== 'hq' && !getIdentity(this.store, to));
    });
    const told = !!stored || !!reached;
    let answered = told;
    if (!ev.isError && (!told || reached)) {
      // All the text the worker wrote to him in the turn, in order, never only the block after the last tool. In a turn
      // that reached him through a tool, the text before that call (already on his screen) is the reply; what follows
      // it narrates the send and is not stored.
      const blocks = window
        .filter((e) => e.type === 'engine.text' && e.data.shift === row.id && e.seq > firstTriggerSeq && (!reached || e.seq < reached.seq))
        .map((e) => e.data.ev as { text?: string; messageId?: string })
        .filter((b) => (b.text ?? '').trim());
      const body = blocks.length ? blocks.map((b) => b.text!.trim()).join('\n\n') : told ? '' : (ev.text ?? '').trim();
      if (body) {
        const to = triggers.at(-1)!;
        this.tell({ msg_id: `${to.id}-reply`, from: row.identity, to: OWNER, body, ref: to.id, text_ref: blocks.at(-1)?.messageId });
        answered = true;
      }
    }
    // Everything he sent into this turn is answered by what the turn showed him.
    if (answered) for (const t of triggers) if (this.get(t.id)!.state === 'seen') this.setState(t.id, 'handled');
  }

  /**
   * His messages to this worker since [since] that nothing answered (#118), oldest first: not handled (a reply, a tell
   * with ref, an ask or a GO all mark it), and no message of the worker to him after it.
   */
  unanswered(identity: string, since = 0): MessageRow[] {
    return (this.store.db.prepare(`SELECT * FROM messages m WHERE m.from_identity = @owner AND m.to_identity = @identity AND m.kind = 'tell'
      AND m.created_at >= @since AND m.state != 'handled' AND NOT EXISTS (SELECT 1 FROM messages r WHERE r.from_identity = m.to_identity
        AND r.to_identity = @owner AND r.kind != 'system' AND r.created_at >= m.created_at)
      ORDER BY m.created_at, m.rowid`).all({ owner: OWNER, identity, since }) as StoredRow[]).map(hydrate);
  }

  /** A shift ended before echoing: its messages go back to waiting for the next shift. */
  private requeueUndelivered(row: ShiftRow): void {
    this.store.db.prepare(`UPDATE messages SET shift_id = NULL WHERE shift_id = ? AND state = 'queued'`).run(row.id);
  }

  /** B.4 visible failures: 60s → retry with resurrection; another 60s → failed, in both inboxes. */
  async sweep(): Promise<void> {
    if (this.cfg.codexLean) {
      // No stale-message resurrection storms while other identities wait for the single active turn.
      if (this.leanMessage) {
        const m = this.get(this.leanMessage.id);
        const s = this.shifts.current(this.leanMessage.identity);
        if (!s || ['handled', 'failed'].includes(m?.state ?? 'failed')) this.leanMessage = null;
        else if (m?.state === 'queued' && s.state === 'live' && this.shifts.connection(s.id)?.isLive
          && (m.last_attempt_at ?? 0) <= this.store.now() - this.cfg.timers.deliveryTimeoutMs) {
          // Same msgId, no retry flag: reconcile an uncertain send without issuing a second model turn.
          await this.deliverOne(m.id);
        }
      }
      const since = Number(this.store.getMeta('codex.lean_since') ?? 0);
      const rows = this.store.db.prepare(`SELECT id FROM messages WHERE state = 'queued' AND from_identity = ? AND created_at >= ? ORDER BY created_at, rowid LIMIT 25`).all(OWNER, since) as { id: string }[];
      for (const r of rows) await this.deliver(r.id);
      return;
    }
    // What was gathered and is due now (or rides with a turn that began): never attempted yet, so not stale either.
    const held = this.store.db.prepare(`SELECT id FROM messages WHERE state = 'queued' AND last_attempt_at IS NULL ORDER BY created_at, rowid`)
      .all() as { id: string }[];
    for (const r of held) await this.deliver(r.id);
    const cutoff = this.store.now() - this.cfg.timers.deliveryTimeoutMs;
    let stale = (this.store.db.prepare(`SELECT * FROM messages WHERE state = 'queued' AND last_attempt_at IS NOT NULL AND last_attempt_at <= ?
      ORDER BY created_at, rowid`).all(cutoff) as StoredRow[]).map(hydrate);
    // A worker on a node that never took its task: the task moves here (scheduler fallbackLocal), its messages wait
    // for the shift here. Not a failure for him, and no resurrection there. A task worker whose task has not started
    // yet is not resurrected either: its start delivers them.
    const moved = new Set<string>();
    for (const id of new Set(stale.map((m) => m.to_identity))) {
      if ((this.nodeFallback && await this.nodeFallback(id).catch(() => false)) || this.waitsForStart(id)) moved.add(id);
    }
    stale = stale.filter((m) => !moved.has(m.to_identity));
    // A task's brief its worker's shift never took (claude died, never came up, the machine choked): not a failure for
    // him. The scheduler drops it, stops the shift and starts the task again after a backoff (#224).
    const taken = new Set<string>();
    if (this.briefStale) {
      for (const m of stale) if (this.get(m.id)?.state === 'queued' && await this.briefStale(m).catch(() => false)) taken.add(m.id);
    }
    stale = stale.filter((m) => !taken.has(m.id) && this.get(m.id)?.state === 'queued' && !this.waitsForStart(m.to_identity));
    // A task worker whose task closed meanwhile is not resurrected: its messages close as failed, with why.
    for (const m of stale.filter((x) => !this.shifts.current(x.to_identity) && this.taskClosed(x.to_identity))) this.failClosed(m);
    for (const m of stale) { const b = this.boundTask(m); if (b != null && this.taskDone(b)) this.failBound(m); }
    for (const m of stale.filter((x) => x.resurrected && this.get(x.id)!.state === 'queued')) this.fail(m);
    // One resurrection per identity, however many of its messages are stale.
    const byIdentity = new Map<string, MessageRow[]>();
    for (const m of stale.filter((x) => !x.resurrected && this.get(x.id)!.state === 'queued')) byIdentity.set(m.to_identity, [...(byIdentity.get(m.to_identity) ?? []), m]);
    for (const [identity, msgs] of byIdentity) {
      const mark = this.store.db.prepare('UPDATE messages SET resurrected = 1, last_attempt_at = ? WHERE id = ?');
      for (const m of msgs) { mark.run(this.store.now(), m.id); this.store.emit('message.retry', identity, { id: m.id }); }
      const cur = this.shifts.current(identity);
      // Closed while its shift was still up (close_team on a stuck worker): stop it, never resurrect it.
      if (this.taskClosed(identity)) {
        if (cur && cur.kind !== 'foreign') {
          await this.shifts.stop(cur.id, 'task_done', cur.started_at)
            .catch((e: Error) => this.store.emit('mailbox.stop_failed', identity, { shift: cur.id, error: e.message }));
        }
        for (const m of msgs) if (this.get(m.id)!.state === 'queued') this.failClosed(m);
        continue;
      }
      try {
        if (cur && cur.kind !== 'foreign') {
          // The shift we tried isn't accepting: restart it (resume) so the messages become its next prompts.
          await this.shifts.stop(cur.id, 'resurrect', cur.started_at);
        }
        // The task may have closed while the old shift was stopping.
        if ((!cur || cur.kind !== 'foreign') && !this.taskClosed(identity)) await this.shifts.request(identity, { reason: 'resurrect' });
      } catch (e) {
        const err = this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?');
        for (const m of msgs) err.run(`resurrect failed: ${(e as Error).message}`, m.id);
      }
      for (const m of msgs) await this.deliver(m.id, true);
    }
  }

  /** A task worker with no shift whose task is queued and never started: the scheduler's start brings it up. */
  waitsForStart(identity: string): boolean {
    if (this.shifts.current(identity)) return false;
    if (this.startPending?.(identity)) return true;
    const r = this.store.db.prepare(`SELECT t.state, t.started_at FROM tasks t JOIN identities i ON i.id = t.identity
      WHERE t.identity = ? AND i.team_kind = 'task' ORDER BY t.id DESC LIMIT 1`).get(identity) as { state: string; started_at: number | null } | undefined;
    return r?.state === 'queued' && r.started_at == null;
  }

  /** A task's prompts to its worker that it never took (on a node, fallbackLocal): failed quietly, its next start sends one. */
  dropTaskPrompts(identity: string, taskId: number, why: string, prefix = `task-${taskId}-`): void {
    const rows = this.store.db.prepare(`SELECT id FROM messages WHERE to_identity = ? AND id LIKE ? AND state = 'queued'`)
      .all(identity, `${prefix}%`) as { id: string }[];
    for (const r of rows) this.setState(r.id, 'failed', { error: why });
    this.store.db.prepare(`UPDATE messages SET resurrected = 0 WHERE to_identity = ? AND state = 'queued'`).run(identity);
  }

  /** The identity is a task worker and its task is done: nothing should start a shift for it. */
  taskClosed(identity: string): boolean {
    const r = this.store.db.prepare(`SELECT t.state FROM tasks t JOIN identities i ON i.id = t.identity
      WHERE t.identity = ? AND i.team_kind = 'task' ORDER BY t.id DESC LIMIT 1`).get(identity) as { state: string } | undefined;
    return r?.state === 'done';
  }

  /**
   * Who hears what was meant for [identity] when its task is closed: whoever opened the task, else its project's lead,
   * else the manager (never a closed task worker). The identity itself while its task is open. Null: nobody else.
   */
  responsibleFor(identity: string): string | null {
    if (!this.taskClosed(identity)) return identity;
    const t = this.store.db.prepare('SELECT labels, project FROM tasks WHERE identity = ? ORDER BY id DESC LIMIT 1')
      .get(identity) as { labels: string | null; project: string | null } | undefined;
    const openedBy = (JSON.parse(t?.labels || '[]') as string[]).find((l) => l.startsWith('opened-by:'))?.slice('opened-by:'.length);
    const lead = t?.project ? projectLead(this.store, t.project) : undefined;
    for (const c of [openedBy, lead, this.cfg.managerId]) {
      if (c && c !== identity && c !== OWNER && c !== 'hq' && getIdentity(this.store, c)?.active && !this.taskClosed(c)) return c;
    }
    return null;
  }

  /** His GO requests from [identity] that are still open (since [since]): a task with one is not done. */
  openGos(identity: string, since = 0): ReturnType<Inbox['get']>[] {
    return (this.store.db.prepare(`SELECT id FROM inbox WHERE kind = 'go' AND state = 'open' AND from_identity = ? AND created_at >= ? ORDER BY id`)
      .all(identity, since) as { id: number }[]).map((r) => this.inbox.get(r.id));
  }

  /** The task a message to a standing worker belongs to (`task-<id>-…`: the scheduler's task prompt and handoff ask), if it is that worker's. */
  private boundTask(m: MessageRow): number | null {
    const id = /^task-(\d+)-/.exec(m.id)?.[1];
    if (!id || !isStandingWorker(getIdentity(this.store, m.to_identity), this.cfg.managerId)) return null;
    const t = this.store.db.prepare('SELECT identity FROM tasks WHERE id = ?').get(Number(id)) as { identity: string | null } | undefined;
    return t?.identity === m.to_identity ? Number(id) : null;
  }
  private taskDone(id: number): boolean {
    return (this.store.db.prepare('SELECT state FROM tasks WHERE id = ?').get(id) as { state: string } | undefined)?.state === 'done';
  }
  /** Nothing to report: the task it was about is closed, and the sender knows (it closed it, or the worker did). */
  private failBound(m: MessageRow): void {
    this.setState(m.id, 'failed', { error: 'המשימה כבר נסגרה' });
  }

  /** A message to a closed task's worker: failed with the reason, and the sender hears the task is closed. */
  private failClosed(m: MessageRow): void {
    const why = 'המשימה כבר נסגרה';
    this.setState(m.id, 'failed', { error: why });
    // System notes (a close reason that didn't make it before the stop, hq notices) are not re-reported.
    if (m.kind === 'system' || m.from_identity === 'hq') return;
    if (this.fromInboxClose(m)) return;
    const title = `הודעה ל-${this.label(m.to_identity)} לא נמסרה: ${why}`;
    this.store.emit('message.undelivered', m.to_identity, { id: m.id, from: m.from_identity, to: m.to_identity, why });
    if (m.from_identity === OWNER) {
      // His words are never lost to a closed worker: whoever is responsible for the task gets them, with the context.
      if (this.forwardToResponsible(m, why)) return;
      this.inbox.add({ kind: 'delivery_failure', title, body: m.body.slice(0, 400), from_identity: m.to_identity, urgency: 'normal',
        ref: m.id, dedupe_key: `delivery_failure:${m.id}` });
      return;
    }
    this.tell({ msg_id: `${m.id}-failed`, from: 'hq', to: m.from_identity, kind: 'system', ref: m.id, priority: 'next',
      body: `ההודעה שלך ${m.id} ל-${this.label(m.to_identity)} לא נמסרה: ${why}, והעובד לא מוקם מחדש. אם צריך להמשיך את העבודה, פותחים צוות חדש (open_team).` });
  }

  /** His message to a worker whose task closed, passed on to the one responsible for it. False: nobody to pass it to. */
  private forwardToResponsible(m: MessageRow, why: string): boolean {
    const to = this.responsibleFor(m.to_identity);
    if (!to || to === m.to_identity) return false;
    const files = m.attachments?.length ? `\n(${m.attachments.length} תמונות מצורפות לא הועברו)` : '';
    this.tell({ msg_id: `${m.id}-fwd`, from: OWNER, to, kind: m.kind === 'answer' ? 'answer' : 'tell', priority: 'next', urgency: m.urgency,
      body: `${this.names.owner.name} כתב ל-${this.label(m.to_identity)}, שכבר נסגר (${why}), ולכן זה מגיע אליך:\n${m.body}${files}` });
    return true;
  }

  /**
   * His "סיימתי" / "דחיתי" on an inbox item, told on to the requester: failing it is not a new item for him to close.
   * A reply in his own words (`inbox-<n>-reply`) still is: those words never arrived.
   */
  private fromInboxClose(m: MessageRow): boolean {
    return m.from_identity === OWNER && m.kind === 'answer' && /^inbox-\d+-(done|declined|failed)$/.test(m.id);
  }

  private fail(m: MessageRow): void {
    this.setState(m.id, 'failed', { error: m.error });
    if (this.fromInboxClose(m)) return;
    this.store.emit('message.undelivered', m.to_identity, { id: m.id, from: m.from_identity, to: m.to_identity, why: m.error ?? 'לא נמסרה בזמן' });
    const why = m.error ? ` (${m.error})` : '';
    const title = `הודעה ל-${this.label(m.to_identity)} לא נמסרה`;
    const body = `${m.body.slice(0, 400)}${why}`;
    this.inbox.add({ kind: 'delivery_failure', title, body, from_identity: m.to_identity, urgency: m.urgency === 'urgent' ? 'urgent' : 'normal',
      ref: m.id, dedupe_key: `delivery_failure:${m.id}` });
    if (m.from_identity !== OWNER && m.from_identity !== 'hq') {
      // The sender learns too, through its own mailbox. Never fails into a loop: system notes are not re-reported.
      if (m.kind !== 'system') {
        this.tell({ msg_id: `${m.id}-failed`, from: 'hq', to: m.from_identity, kind: 'system', ref: m.id, priority: 'next',
          body: `ההודעה שלך ${m.id} ל-${this.label(m.to_identity)} לא נמסרה${why}. היא מופיעה אצל ${this.names.owner.name} ב"מחכה לך".` });
      }
    }
  }

  // ── owner completes something he was asked for ────────────────────────────
  /**
   * He finished (or declined) an inbox item: login / tab handoff, GO, ask. The requester is told
   * immediately through its mailbox with priority `now` — that wakes it if it rests — and the item
   * closes. Polling is never the only path (finding from 20/10: "סיימתי" on a tab handoff reached no one).
   */
  complete(itemId: number, opts: { note?: string; declined?: boolean; by?: string } = {}): { item: ReturnType<Inbox['get']>; message: MessageRow | null } {
    const item = this.inbox.get(itemId);
    if (!item) throw new Error(`no inbox item ${itemId}`);
    // Only his own close speaks as him (#208). A worker or script closing the item is told in its own name, and its
    // words never appear as his.
    const by = opts.by ?? OWNER;
    const byOwner = by === OWNER;
    if (byOwner && item.kind === 'ask' && item.ref && !opts.declined) {
      const a = this.getAsk(item.ref);
      if (a && (a.state === 'open' || a.state === 'escalated')) {
        this.answer(a.id, opts.note ?? 'סיימתי');
        return { item: this.inbox.get(itemId), message: this.lastAnswer(a.id) ?? null };
      }
    }
    if (item.state !== 'open') return { item, message: null };
    this.inbox.resolve(itemId, opts.declined ? 'dismissed' : 'resolved');
    if (item.kind === 'ask' && item.ref) {
      this.store.db.prepare(`UPDATE asks SET state = 'cancelled', answered_at = ? WHERE id = ? AND state IN ('open','escalated')`).run(this.store.now(), item.ref);
    }
    const requester = item.from_identity;
    if (!requester || requester === OWNER || requester === 'hq' || !getIdentity(this.store, requester)) return { item: this.inbox.get(itemId), message: null };
    // A delivery failure's "requester" is the worker that never got the message: telling it would fail again into a new
    // delivery_failure, on every "סיימתי" (21/10).
    if (item.kind === 'delivery_failure') {
      this.store.emit('inbox.completed', requester, { id: itemId, declined: !!opts.declined, by, message: null });
      return { item: this.inbox.get(itemId), message: null };
    }
    // The worker's task closed since: its GO and the answer on it go to whoever is responsible for the task.
    const target = this.responsibleFor(requester);
    if (!target) {
      this.store.emit('inbox.completed', requester, { id: itemId, declined: !!opts.declined, by, message: null });
      return { item: this.inbox.get(itemId), message: null };
    }
    const o = this.names.owner;
    let body: string;
    if (byOwner) {
      const verb = opts.declined ? g(o, 'דחה', 'דחתה') : g(o, 'סיים', 'סיימה');
      // A question he closed (#74): the asker hears which one, and that no answer is coming.
      body = opts.declined && item.kind === 'ask'
        ? `${o.name} ${g(o, 'סגר', 'סגרה')} את השאלה בלי תשובה: ${item.headline ?? item.body}`
        : `${o.name} ${verb}: ${item.title}`;
    } else {
      // Someone else closed it: nothing to tell unless they wrote something, and then it carries their name.
      if (!opts.note || by === target) {
        this.store.emit('inbox.completed', requester, { id: itemId, declined: !!opts.declined, by, message: null });
        return { item: this.inbox.get(itemId), message: null };
      }
      body = `${this.label(by)} סגר/ה: ${item.title}`;
    }
    const message = this.tell({
      msg_id: `inbox-${itemId}-${opts.declined ? 'declined' : 'done'}`, from: by, to: target, kind: 'answer',
      ref: item.ref ?? `inbox-${itemId}`, priority: 'now', urgency: item.urgency,
      body: `${target === requester ? '' : `${this.closedNote(requester)}\n`}${body}${opts.note ? `\n${opts.note}` : ''}`,
    });
    this.store.emit('inbox.completed', requester, { id: itemId, declined: !!opts.declined, by, message: message.id });
    return { item: this.inbox.get(itemId), message };
  }

  /**
   * He wrote an answer of his own on an open item in the conversation ("לא, בלי הבוטים"). A question is
   * answered with it; a GO closes with his text, and the requester gets the text itself, not "GO".
   */
  reply(itemId: number, text: string, attachments: string[] = []): { item: ReturnType<Inbox['get']>; message: MessageRow | null } {
    const item = this.inbox.get(itemId);
    if (!item) throw new Error(`no inbox item ${itemId}`);
    // Closed elsewhere a moment ago (another device, Telegram): his words would reach no one. Say so.
    const open = item.kind === 'ask' && item.ref && this.getAsk(item.ref)
      ? ['open', 'escalated'].includes(this.getAsk(item.ref)!.state)
      : item.state === 'open';
    if (!open) throw new Error(`inbox item ${itemId} is already handled`);
    if (item.kind === 'ask' && item.ref && this.getAsk(item.ref)) {
      const a = this.answer(item.ref, text, 'owner', undefined, attachments);
      return { item: this.inbox.get(itemId), message: this.lastAnswer(a.id) ?? null };
    }
    const requester = item.from_identity;
    if (!requester || requester === OWNER || requester === 'hq' || !getIdentity(this.store, requester)) {
      throw new Error(`inbox item ${itemId} has no worker to answer`);
    }
    this.attachmentsFor(attachments);
    if (!text && attachments.length) text = '(תמונה מצורפת)';
    if (!text) throw new Error('answer must be text or an image');
    const target = this.responsibleFor(requester);
    const lead = target && target !== requester ? `${this.closedNote(requester)}\n` : '';
    // A GO closes only with a clear yes or no. Any other words (a question, "למה?") reach whoever answers for it
    // as an ordinary message, and the GO stays open for his decision (21/10: a question closed a GO nobody could answer).
    if (item.kind === 'go' && goVerdict(text) === 'other') {
      if (!target) throw new Error(`inbox item ${itemId} has no worker to answer`);
      const message = this.tell({
        msg_id: `inbox-${itemId}-note-${randomUUID().slice(0, 8)}`, from: OWNER, to: target, kind: 'tell', priority: 'now', urgency: item.urgency, attachments,
        body: `${lead}${this.names.owner.name} כתב על בקשת ה-GO "${item.headline ?? item.title}" (עדיין פתוחה, לא אושרה ולא נדחתה): ${text}`,
      });
      return { item: this.inbox.get(itemId), message };
    }
    if (!target) throw new Error(`inbox item ${itemId} has no worker to answer`);
    this.inbox.resolve(itemId, 'resolved');
    const what = item.kind === 'go' ? 'לבקשת ה-GO' : 'על';
    const message = this.tell({
      msg_id: `inbox-${itemId}-reply`, from: OWNER, to: target, kind: 'answer', ref: item.ref ?? `inbox-${itemId}`,
      priority: 'now', urgency: item.urgency, attachments,
      body: `${lead}תשובה של ${this.names.owner.name} ${what} "${item.headline ?? item.title}": ${text}`,
    });
    this.store.emit('inbox.completed', requester, { id: itemId, declined: item.kind === 'go' && goVerdict(text) === 'no', by: OWNER, message: message.id });
    return { item: this.inbox.get(itemId), message };
  }

  /** Why this reaches someone other than the worker who asked. */
  private closedNote(identity: string): string {
    return `(${this.label(identity)} כבר סיים ונסגר, והבקשה שלו מגיעה אליך כי אתה האחראי על המשימה.)`;
  }

  // ── asks (B.4: a question to the owner is a message of kind `ask`) ─────────
  ask(req: AskRequest): AskDTO {
    const id = req.msg_id ?? `ask-${randomUUID().slice(0, 8)}`;
    const ex = this.getAsk(id);
    if (ex) return ex;
    if (!req.from || !req.question) throw new Error('from and question are required');
    const now = this.store.now();
    const headline = req.headline?.trim() || null;
    this.store.db.prepare(`INSERT INTO asks (id, from_identity, question, headline, options, blocking, urgency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, req.from, req.question, headline, JSON.stringify(req.options ?? []), req.blocking ? 1 : 0,
      req.urgency ?? 'normal', now);
    // He comes first, directly from whoever asks (A.4) — the inbox item, not a relay through the manager.
    this.inbox.add({ kind: 'ask', title: req.title?.trim() || `${this.label(req.from)} שואל/ת`, body: req.question, from_identity: req.from,
      urgency: req.urgency ?? 'normal', blocking: !!req.blocking, ref: id, headline, dedupe_key: `ask:${id}` });
    const a = this.getAsk(id)!;
    this.store.emit('ask.new', req.from, a);
    return a;
  }

  getAsk(id: string): AskDTO | undefined {
    const r = this.store.db.prepare('SELECT * FROM asks WHERE id = ?').get(id) as AskRow | undefined;
    return r ? askDTO(r) : undefined;
  }

  openAsks(): AskDTO[] {
    return (this.store.db.prepare(`SELECT * FROM asks WHERE state IN ('open','escalated') ORDER BY blocking DESC, created_at`).all() as AskRow[]).map(askDTO);
  }

  /** Owner (from the app) or manager (after escalation) answers; the answer goes back to the asker's mailbox. */
  answer(id: string, answer: string, by: 'owner' | 'manager' = 'owner', why?: string, attachments: string[] = []): AskDTO {
    const a = this.getAsk(id);
    if (!a) throw new Error(`no ask ${id}`);
    if (a.state === 'answered' || a.state === 'cancelled') return a;
    if (by === 'manager' && a.state !== 'escalated') throw new Error('manager may answer only escalated asks');
    // An image can be the whole answer ("זה מה שאני רואה"): the asker gets it with the answer line.
    this.attachmentsFor(attachments);
    if (!answer && attachments.length) answer = '(תמונה מצורפת)';
    // hq's own asks (account login) carry a one-time code: it is handed over live only (never in asks,
    // events or backups), and hq has no mailbox to deliver an answer to.
    const fromHq = a.from_identity === 'hq';
    // error-watch.ts reads its answers ("לטפל" / "לא עכשיו") from here: those carry no secret.
    const secret = fromHq && !id.startsWith('err-');
    this.store.db.prepare(`UPDATE asks SET state = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?`)
      .run(secret ? '(התקבל)' : answer, by, this.store.now(), id);
    this.inbox.resolveByRef('ask', id);
    if (fromHq) this.onHqAnswer?.(id, answer);
    const from = by === 'owner' ? OWNER : this.cfg.managerId;
    if (!fromHq) this.tell({ msg_id: this.freshAnswerId(id), from, to: a.from_identity, kind: 'answer', ref: id, urgency: a.urgency, priority: 'now',
      body: by === 'owner' ? `תשובה לשאלה ${id}: ${answer}` : `${this.names.manager.name} ${g(this.names.manager, 'החליט', 'החליטה')} במקום ${this.names.owner.name} (${id}): ${answer}${why ? `, כי ${why}` : ''}`, attachments });
    // "החלטתי במקומך: X, כי Y" — informational, never pushed, and never beside an open card of the same ask.
    if (by === 'manager' && !this.store.db.prepare(`SELECT 1 FROM inbox WHERE ref = ? AND kind = 'ask' AND state = 'open'`).get(id)) {
      this.inbox.add({ kind: 'escalation_note', title: `${this.label(this.cfg.managerId)} ${g(this.names.manager, 'החליט', 'החליטה')} במקומך`, from_identity: this.cfg.managerId,
        body: `${a.question}\n→ ${answer}${why ? `, כי ${why}` : ''}`, ref: id, urgency: 'low', dedupe_key: `escalation_note:${id}` });
    }
    const out = this.getAsk(id)!;
    this.store.emit('ask.answered', a.from_identity, out);
    return out;
  }

  /**
   * One id per answer: an ask can be answered again after it was put back (repairEscalated, a manual reopen), and tell()
   * returns the existing message for a known id, so a second answer under `<ask>-answer` would never be delivered.
   */
  private freshAnswerId(ask: string): string {
    let id = `${ask}-answer`;
    for (let n = 2; this.get(id); n++) id = `${ask}-answer-${n}`;
    return id;
  }

  /** The newest answer message the asker got for this ask. */
  private lastAnswer(ask: string): MessageRow | undefined {
    const r = this.store.db.prepare(`SELECT id FROM messages WHERE ref = ? AND kind = 'answer' ORDER BY rowid DESC LIMIT 1`).get(ask) as { id: string } | undefined;
    return r ? this.get(r.id) : undefined;
  }

  /** A worker closes its own ask (decided another way): the card goes, nothing is sent. False = nothing was open. */
  withdraw(id: string, note?: string): boolean {
    const a = this.getAsk(id);
    if (!a || (a.state !== 'open' && a.state !== 'escalated')) return false;
    this.store.db.prepare(`UPDATE asks SET state = 'cancelled', answered_at = ? WHERE id = ?`).run(this.store.now(), id);
    this.inbox.resolveByRef('ask', id, 'dismissed');
    this.store.emit('ask.cancelled', a.from_identity, { id, note: note ?? null });
    return true;
  }

  /**
   * A worker (or its manager) closes a GO card whose decision was made another way. `chat`: he said yes in the conversation
   * (his message, which hq reads itself, is kept as the evidence). `withdrawn`: no longer relevant, nothing is recorded as a GO.
   * Never ran by his own close, so a card of request_access (whose yes runs a command) cannot be closed here.
   */
  closeGo(ref: string, outcome: 'approved_in_chat' | 'withdrawn', by: string, messageId?: string, note?: string): { item: NonNullable<ReturnType<Inbox['get']>>; already: boolean; quote: string | null } {
    const fail = (status: number, why: string, he: string): never => { throw new GoCloseError(status, why, he); };
    const num = /^inbox-(\d+)$/.exec(ref)?.[1] ?? (/^\d+$/.test(ref) ? ref : undefined);
    const row = (num
      ? this.store.db.prepare(`SELECT id FROM inbox WHERE kind = 'go' AND id = ?`).get(Number(num))
      : this.store.db.prepare(`SELECT id FROM inbox WHERE kind = 'go' AND ref = ? ORDER BY id DESC LIMIT 1`).get(ref)) as { id: number } | undefined;
    const item = row ? this.inbox.get(row.id) : undefined;
    if (!item) return fail(404, `withdraw_go: no GO ${ref}`, `אין בקשת GO עם המזהה ${ref} (ה-ref שחזר מ-request_go, או inbox-<מספר>)`);
    if (item.ref?.startsWith('acc-')) {
      return fail(409, `withdraw_go: ${ref} is an access request`, 'זו בקשת גישה (request_access): היא נסגרת רק בהחלטה שלו בכרטיס, לא דרך withdraw_go');
    }
    const requester = item.from_identity;
    const allowed = new Set([requester, this.cfg.managerId, requester ? getIdentity(this.store, requester)?.reports_to : null,
      requester ? this.responsibleFor(requester) : null].filter((x): x is string => !!x && x !== OWNER && x !== 'hq'));
    if (!allowed.has(by)) {
      return fail(403, `withdraw_go: ${by} may not close GO ${ref}`, 'רק מי שפתח את בקשת ה-GO, המנהל שלו או המנהל של החברה יכולים לסגור אותה');
    }
    if (item.state !== 'open') return { item, already: true, quote: null };
    let quote: string | null = null;
    if (outcome === 'approved_in_chat') {
      if (!messageId) return fail(400, 'withdraw_go: message is required for approved_in_chat', 'חסר `message`: ה-msg_id של ההודעה של רן שאישרה. בלי הודעה אמיתית שלו אי אפשר לאשר בשם שיחה');
      const m = this.get(messageId);
      if (!m || m.from_identity !== OWNER) {
        return fail(400, `withdraw_go: ${messageId} is not a message from the owner`, `\`${messageId}\` היא לא הודעה של ${this.names.owner.name}. ה-msg_id הוא מה שבסוגריים בכותרת ההודעה שלו`);
      }
      // A message he wrote to this worker's conversation (or its responsible one's), as himself: not one hq wrote in his name.
      if (m.kind !== 'tell' || ![requester, by, requester ? this.responsibleFor(requester) : null].includes(m.to_identity)) {
        return fail(400, `withdraw_go: ${messageId} is not a message of his in this conversation`, `\`${messageId}\` לא נכתבה בשיחה הזו. צריך הודעה ישירה של ${this.names.owner.name} אליך`);
      }
      if (m.created_at < item.created_at) {
        return fail(400, `withdraw_go: ${messageId} was written before the card opened`, 'ההודעה נכתבה לפני שהכרטיס נפתח, ולכן היא לא אישור שלו עליו');
      }
      quote = ownerWords(m.body);
      if (!quote) return fail(400, `withdraw_go: ${messageId} has no text`, 'בהודעה אין טקסט שאפשר לצטט כראיה');
      // The same bar as his own words on the card (reply): only a bare yes closes it, anything else stays open.
      if (goVerdict(quote) !== 'yes') {
        return fail(409, `withdraw_go: ${messageId} is not a clear yes`, `ההודעה «${quote.slice(0, 80)}» היא לא אישור ברור, ולכן הכרטיס נשאר פתוח. אם הוא התכוון לאשר, ${this.names.owner.name} יכול ללחוץ GO או לכתוב "אשר"`);
      }
    }
    const approved = outcome === 'approved_in_chat';
    this.inbox.resolve(item.id, approved ? 'resolved' : 'dismissed');
    if (approved) {
      this.store.db.prepare('UPDATE inbox SET body = ? WHERE id = ?').run(`${item.body}\nאושר בשיחה: «${quote}»`.trim(), item.id);
    }
    // `by` is never him: the card was closed for him, and what reads his own close (access.ts) must not mistake it for a click.
    this.store.emit('inbox.completed', requester, { id: item.id, declined: !approved, by, how: approved ? 'chat' : 'withdrawn', message: messageId ?? null, quote, note: note ?? null });
    // The asker hears it when someone else closed its card (a manager): it may be waiting on the answer.
    if (requester && by !== requester && getIdentity(this.store, requester)) {
      this.tell({ msg_id: `inbox-${item.id}-closed-by-${by}`, from: 'hq', to: requester, kind: 'tell', ref: item.ref ?? `inbox-${item.id}`, priority: 'next',
        body: `${this.label(by)} סגר/ה את בקשת ה-GO "${item.headline ?? item.title}": ${approved ? `אושרה בשיחה («${quote}»)` : 'בוטלה'}.` });
    }
    return { item: this.inbox.get(item.id)!, already: false, quote };
  }

  /** Scheduler code, not an LLM remembering to check (B.4): blocking ask unanswered → manager. */
  escalate(a: AskDTO, why: string): void {
    if (a.from_identity === this.cfg.managerId) return; // the manager's own questions wait for the owner
    this.store.db.prepare(`UPDATE asks SET state = 'escalated', escalated_at = ? WHERE id = ? AND state = 'open'`).run(this.store.now(), a.id);
    this.tell({ msg_id: `${a.id}-escalation`, from: 'hq', to: this.cfg.managerId, kind: 'escalation', ref: a.id, urgency: a.urgency,
      priority: 'next', body: [
        `שאלה חוסמת מ-${this.label(a.from_identity)} לא נענתה ע"י ${this.names.owner.name} (${why}).`,
        `שאלה (${a.id}): ${a.question}`,
        a.options.length ? `אפשרויות: ${a.options.join(' / ')}` : '',
        `אם זה בסמכותך: ענה עם tell(to="${a.from_identity}", ref="${a.id}", body="החלטתי במקומך: X, כי Y"). אם לא: השאר אותה ${pre('ל', this.names.owner.name)}. כל tell אחר עם ה-ref הזה לא עונה על השאלה: הוא נשאר הערה קטנה בכרטיס, והכרטיס נשאר של ${this.label(a.from_identity)} עם הכפתורים שלו.`,
      ].filter(Boolean).join('\n') });
    this.store.emit('ask.escalated', a.from_identity, { id: a.id, why });
  }
}

/** A rejected `withdraw_go`: a 4xx with the Hebrew reason (ingest.ts turns it into the IngestError the worker hears). */
export class GoCloseError extends Error {
  status: number;
  he: string;
  constructor(status: number, why: string, he: string) { super(why); this.status = status; this.he = he; }
}

/** What he actually wrote: a note hq wrapped around his words on a GO card ("כתב על בקשת ה-GO … : <text>") is stripped to them. */
export function ownerWords(body: string): string {
  const wrapped = /^[\s\S]*\(עדיין פתוחה, לא אושרה ולא נדחתה\): ([\s\S]*)$/.exec(body);
  return (wrapped ? wrapped[1]! : body).trim();
}

function shiftOf(data: string): string | undefined {
  try { return (JSON.parse(data) as { shift?: string }).shift; } catch { return undefined; }
}

function askDTO(r: AskRow): AskDTO {
  return { ...r, options: JSON.parse(r.options) as string[], blocking: r.blocking === 1 };
}

/** "רן מחכה לתשובה על «…»" for his unanswered messages (#118): the latest one quoted, one line. `owner`: his name (names.ts). */
export function waitingLine(msgs: Pick<MessageRow, 'body'>[], owner: string): string {
  const last = msgs.at(-1)?.body.replace(/\s+/g, ' ').trim() ?? '';
  const quote = last.length > 80 ? `${last.slice(0, 79)}…` : last;
  return `${owner} מחכה לתשובה על «${quote}»${msgs.length > 1 ? ` (ועוד ${msgs.length - 1})` : ''}`;
}

/**
 * His free text on a GO card: only a bare yes or a bare no closes it, anything else (a question, a condition, "בסדר אבל לא עכשיו") does not.
 * A yes is made only of approval words, so any qualifier ("רק", "אבל", a time) makes it a remark. A no is short and starts with the word.
 */
const YES_WORDS = new Set(['go', 'ok', 'okay', 'yes', 'y', 'approve', 'approved', 'confirm', 'אשר', 'מאשר', 'מאושר', 'אישור', 'אושר', 'אשרתי',
  'כן', 'בסדר', 'סבבה', 'יאללה', 'תפרוס', 'תפרסו', 'פרוס', 'בצע', 'קדימה', 'שחרר']);
// "יאללה נתקן" (22/10): a yes word with a plain "let's do it" verb is still a bare yes. A verb alone, or any other word, is not.
const YES_FILLER = new Set(['עכשיו', 'תודה', 'לך', 'על', 'זה', 'please', 'now', 'נתקן', 'תתקן', 'תתקנו', 'נפרוס', 'נשחרר', 'נעלה', 'נעשה', 'תעשה', 'תעשו', 'נמשיך', 'תמשיך']);
export function goVerdict(text: string): 'yes' | 'no' | 'other' {
  const t = text.trim().toLowerCase().replace(/[.!,"'״]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t || /[?؟]/.test(text)) return 'other';
  const words = t.split(' ');
  if (words.some((w) => YES_WORDS.has(w)) && words.every((w) => YES_WORDS.has(w) || YES_FILLER.has(w))) return 'yes';
  if (words.length <= 3 && !/הבנתי|ברור|יודע|מבין|בטוח|מכיר|ממש|כל כך|idea|problem|ahead/.test(t) && /^(no|nope|cancel|reject|stop|לא|דחה|דוחה|נדחה|דחיתי|בטל|בטלתי|ביטול|עצור|עצרו|תעצור)$/.test(words[0]!)) return 'no';
  return 'other';
}
