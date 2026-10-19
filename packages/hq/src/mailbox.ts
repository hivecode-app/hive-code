// Identity mailboxes (B.4). Every message is stored first, then delivered over the best channel:
//   live shift we hold → shift-host `send` (stdin user line)  ·  foreign session → adapter.injectForeign
//   resting/dead → request a shift (resume) and deliver as its first prompt.
// No `delivered` in 60s → one retry with resurrection → visible failure in the sender's inbox and the owner's.
// msg_id is the idempotency key end to end (API, host `send`, retries after crash).
import { randomUUID } from 'node:crypto';
import { OWNER, type AskDTO, type AskRequest, type DeliveryState, type MessageKind, type MessageState, type Priority, type TellRequest, type Urgency } from '@company/shared';
import type { Store } from './store.ts';
import type { HqConfig } from './config.ts';
import type { Inbox } from './inbox.ts';
import type { ShiftManager, ShiftRow } from './shifts.ts';
import { getIdentity } from './org.ts';

export interface MessageRow {
  id: string; from_identity: string; to_identity: string; kind: MessageKind; body: string; urgency: Urgency;
  priority: Priority; ref: string | null; state: MessageState; attempts: number; resurrected: number; shift_id: string | null;
  error: string | null; created_at: number; last_attempt_at: number | null; delivered_at: number | null; seen_at: number | null;
  handled_at: number | null; failed_at: number | null;
}

/** Native socket path for sessions we don't hold (B.4 row 2). Provided by the adapter (engine lane). */
export interface ForeignInjector {
  injectForeign(pid: number, text: string, opts: { fromName: string; priority: Priority }): Promise<unknown>;
}

export const noForeignInjector: ForeignInjector = {
  async injectForeign() { throw new Error('adapter.injectForeign not available yet'); },
};

const URGENCY_HE: Record<Urgency, string> = { urgent: 'דחופה', normal: 'רגילה', low: 'נמוכה' };

interface AskRow { id: string; from_identity: string; question: string; options: string; blocking: number; urgency: Urgency;
  state: AskDTO['state']; answer: string | null; answered_by: AskDTO['answered_by']; created_at: number; escalated_at: number | null }

export class Mailbox {
  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private inbox: Inbox;
  private foreign: ForeignInjector;
  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, inbox: Inbox, foreign: ForeignInjector = noForeignInjector) {
    this.store = store;
    this.cfg = cfg;
    this.shifts = shifts;
    this.inbox = inbox;
    this.foreign = foreign;
    shifts.on('live', (row) => this.store.bg(this.flush(row.identity), 'mailbox.flush'));
    // `seen` comes only from the host's delivery frames (started/completed = dequeued into the
    // conversation). Assistant text is not proof: a `later` message can still be waiting behind the turn.
    shifts.on('frame', (row, f) => {
      if (f.t === 'delivery') this.onDelivery(row, f.msgId, f.state, f.error);
    });
    shifts.on('ended', (row) => this.requeueUndelivered(row));
  }

  label(id: string): string {
    if (id === OWNER) return 'רן';
    if (id === 'hq') return 'hq';
    const i = getIdentity(this.store, id);
    return i ? i.name : id; // symbols are icon names (Material Symbols), not text
  }

  /** The stdin envelope (B.4): the worker knows who it's from and replies with `ref`. */
  envelope(m: Pick<MessageRow, 'id' | 'from_identity' | 'urgency' | 'body' | 'kind' | 'ref'>): string {
    const ref = m.ref ? ` · ref: ${m.ref}` : '';
    return `[הודעה מ-${this.label(m.from_identity)} · דחיפות: ${URGENCY_HE[m.urgency]} · ${m.id}${ref}]\n${m.body}`;
  }

  get(id: string): MessageRow | undefined {
    return this.store.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow | undefined;
  }

  list(identity: string, limit = 200, beforeTs?: number): MessageRow[] {
    return this.store.db.prepare(`SELECT * FROM messages WHERE (to_identity = ? OR from_identity = ?) AND created_at < ?
      ORDER BY created_at DESC, rowid DESC LIMIT ?`).all(identity, identity, beforeTs ?? Number.MAX_SAFE_INTEGER, limit) as MessageRow[];
  }

  private setState(id: string, state: MessageState, extra: Record<string, unknown> = {}): void {
    const col = { delivered: 'delivered_at', seen: 'seen_at', handled: 'handled_at', failed: 'failed_at', queued: null }[state];
    const sets = ['state = @state', ...(col ? [`${col} = COALESCE(${col}, @now)`] : []), ...Object.keys(extra).map((k) => `${k} = @${k}`)];
    this.store.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = @id`).run({ id, state, now: this.store.now(), ...extra });
    const m = this.get(id)!;
    this.store.emit('message.state', m.to_identity, { id, state, from: m.from_identity, to: m.to_identity });
  }

  /** Store then deliver. Idempotent by msg_id: a retried request returns the existing message. */
  tell(req: TellRequest & { kind?: MessageKind }): MessageRow {
    const id = req.msg_id ?? `m-${randomUUID()}`;
    const existing = this.get(id);
    if (existing) return existing;
    if (!req.to || !req.body) throw new Error('to and body are required');
    const from = req.from ?? OWNER;
    // Answering an ask = a reply with ref=<ask id> to the asker: from the owner, or from the manager once
    // it was escalated to him (A.4 "החלטתי במקומך"). It goes through answer() so the inbox closes too.
    if (req.ref && (from === OWNER || from === this.cfg.managerId)) {
      const a = this.getAsk(req.ref);
      if (a && a.from_identity === req.to && (a.state === 'open' || a.state === 'escalated')
        && (from === OWNER || a.state === 'escalated')) {
        this.answer(a.id, req.body, from === OWNER ? 'owner' : 'manager');
        return this.get(`${a.id}-answer`)!;
      }
    }
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO messages (id, from_identity, to_identity, kind, body, urgency, priority, ref, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, from, req.to, req.kind ?? 'tell', req.body, req.urgency ?? 'normal',
      req.priority ?? (req.urgency === 'urgent' ? 'now' : 'next'), req.ref ?? null, now);
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
  async deliver(id: string, retry = false): Promise<void> {
    const m = this.get(id);
    if (!m || m.state !== 'queued') return;
    this.store.db.prepare('UPDATE messages SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?').run(this.store.now(), id);

    if (m.to_identity === OWNER) {
      // The app is his channel: the message is in his conversation the moment it's stored.
      this.setState(id, 'delivered');
      return;
    }
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
        this.store.db.prepare('UPDATE messages SET shift_id = ? WHERE id = ?').run(shift.id, id);
        // Idempotent on msgId in the host: a resend after an hq crash returns the current state instead.
        let r = await conn.send(id, this.envelope(m), m.priority, retry);
        // The host remembers this msgId as never accepted (e.g. its claude restarted): write it again.
        if (r?.state === 'failed' && !retry) r = await conn.send(id, this.envelope(m), m.priority, true);
        if (r) this.onDelivery(shift, id, r.state);
      } catch (e) {
        this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run((e as Error).message, id);
      }
      return;
    }
    if (!shift) {
      // Resting or dead: wake it. The message becomes the first prompt once the host is live (flush on `live`).
      try {
        await this.shifts.request(m.to_identity, { reason: 'message' });
      } catch (e) {
        this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?').run(`wake failed: ${(e as Error).message}`, id);
      }
    }
    // shift exists but not live yet: `live` → flush() delivers it.
  }

  /** Deliver everything still queued for an identity (called when its shift goes live). */
  async flush(identity: string): Promise<void> {
    const rows = this.store.db.prepare(`SELECT id FROM messages WHERE to_identity = ? AND state = 'queued' ORDER BY created_at, rowid`)
      .all(identity) as { id: string }[];
    for (const r of rows) await this.deliver(r.id);
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
      return;
    }
    if (state === 'written') return;
    if (m.state === 'queued') this.setState(msgId, 'delivered', { shift_id: row.id, error: null });
    if ((state === 'started' || state === 'completed') && this.get(msgId)!.state === 'delivered') this.setState(msgId, 'seen');
  }

  /** A shift ended before echoing: its messages go back to waiting for the next shift. */
  private requeueUndelivered(row: ShiftRow): void {
    this.store.db.prepare(`UPDATE messages SET shift_id = NULL WHERE shift_id = ? AND state = 'queued'`).run(row.id);
  }

  /** B.4 visible failures: 60s → retry with resurrection; another 60s → failed, in both inboxes. */
  async sweep(): Promise<void> {
    const cutoff = this.store.now() - this.cfg.timers.deliveryTimeoutMs;
    const stale = this.store.db.prepare(`SELECT * FROM messages WHERE state = 'queued' AND last_attempt_at IS NOT NULL AND last_attempt_at <= ?
      ORDER BY created_at, rowid`).all(cutoff) as MessageRow[];
    for (const m of stale.filter((x) => x.resurrected)) this.fail(m);
    // One resurrection per identity, however many of its messages are stale.
    const byIdentity = new Map<string, MessageRow[]>();
    for (const m of stale.filter((x) => !x.resurrected)) byIdentity.set(m.to_identity, [...(byIdentity.get(m.to_identity) ?? []), m]);
    for (const [identity, msgs] of byIdentity) {
      const mark = this.store.db.prepare('UPDATE messages SET resurrected = 1, last_attempt_at = ? WHERE id = ?');
      for (const m of msgs) { mark.run(this.store.now(), m.id); this.store.emit('message.retry', identity, { id: m.id }); }
      const cur = this.shifts.current(identity);
      try {
        if (cur && cur.kind !== 'foreign') {
          // The shift we tried isn't accepting: restart it (resume) so the messages become its next prompts.
          await this.shifts.stop(cur.id, 'resurrect', cur.started_at);
        }
        if (!cur || cur.kind !== 'foreign') await this.shifts.request(identity, { reason: 'resurrect' });
      } catch (e) {
        const err = this.store.db.prepare('UPDATE messages SET error = ? WHERE id = ?');
        for (const m of msgs) err.run(`resurrect failed: ${(e as Error).message}`, m.id);
      }
      for (const m of msgs) await this.deliver(m.id, true);
    }
  }

  private fail(m: MessageRow): void {
    this.setState(m.id, 'failed');
    const why = m.error ? ` (${m.error})` : '';
    const title = `הודעה ל-${this.label(m.to_identity)} לא נמסרה`;
    const body = `${m.body.slice(0, 400)}${why}`;
    this.inbox.add({ kind: 'delivery_failure', title, body, from_identity: m.to_identity, urgency: m.urgency === 'urgent' ? 'urgent' : 'normal',
      ref: m.id, dedupe_key: `delivery_failure:${m.id}` });
    if (m.from_identity !== OWNER && m.from_identity !== 'hq') {
      // The sender learns too, through its own mailbox. Never fails into a loop: system notes are not re-reported.
      if (m.kind !== 'system') {
        this.tell({ msg_id: `${m.id}-failed`, from: 'hq', to: m.from_identity, kind: 'system', ref: m.id, priority: 'next',
          body: `ההודעה שלך ${m.id} ל-${this.label(m.to_identity)} לא נמסרה${why}. היא מופיעה אצל רן ב"מחכה לך".` });
      }
    }
  }

  // ── owner completes something he was asked for ────────────────────────────
  /**
   * He finished (or declined) an inbox item: login / tab handoff, GO, ask. The requester is told
   * immediately through its mailbox with priority `now` — that wakes it if it rests — and the item
   * closes. Polling is never the only path (finding from 20/10: "סיימתי" on a tab handoff reached no one).
   */
  complete(itemId: number, opts: { note?: string; declined?: boolean } = {}): { item: ReturnType<Inbox['get']>; message: MessageRow | null } {
    const item = this.inbox.get(itemId);
    if (!item) throw new Error(`no inbox item ${itemId}`);
    if (item.kind === 'ask' && item.ref && !opts.declined) {
      const a = this.getAsk(item.ref);
      if (a && (a.state === 'open' || a.state === 'escalated')) {
        this.answer(a.id, opts.note ?? 'סיימתי');
        return { item: this.inbox.get(itemId), message: this.get(`${a.id}-answer`) ?? null };
      }
    }
    if (item.state !== 'open') return { item, message: null };
    this.inbox.resolve(itemId, opts.declined ? 'dismissed' : 'resolved');
    if (item.kind === 'ask' && item.ref) {
      this.store.db.prepare(`UPDATE asks SET state = 'cancelled', answered_at = ? WHERE id = ? AND state IN ('open','escalated')`).run(this.store.now(), item.ref);
    }
    const requester = item.from_identity;
    if (!requester || requester === OWNER || requester === 'hq' || !getIdentity(this.store, requester)) return { item: this.inbox.get(itemId), message: null };
    const verb = opts.declined ? 'דחה' : 'סיים';
    const message = this.tell({
      msg_id: `inbox-${itemId}-${opts.declined ? 'declined' : 'done'}`, from: OWNER, to: requester, kind: 'answer',
      ref: item.ref ?? `inbox-${itemId}`, priority: 'now', urgency: item.urgency,
      body: `רן ${verb}: ${item.title}${opts.note ? `\n${opts.note}` : ''}`,
    });
    this.store.emit('inbox.completed', requester, { id: itemId, declined: !!opts.declined, message: message.id });
    return { item: this.inbox.get(itemId), message };
  }

  // ── asks (B.4: a question to the owner is a message of kind `ask`) ─────────
  ask(req: AskRequest): AskDTO {
    const id = req.msg_id ?? `ask-${randomUUID().slice(0, 8)}`;
    const ex = this.getAsk(id);
    if (ex) return ex;
    if (!req.from || !req.question) throw new Error('from and question are required');
    const now = this.store.now();
    this.store.db.prepare(`INSERT INTO asks (id, from_identity, question, options, blocking, urgency, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, req.from, req.question, JSON.stringify(req.options ?? []), req.blocking ? 1 : 0,
      req.urgency ?? 'normal', now);
    // He comes first, directly from whoever asks (A.4) — the inbox item, not a relay through the manager.
    this.inbox.add({ kind: 'ask', title: `${this.label(req.from)} שואל/ת`, body: req.question, from_identity: req.from,
      urgency: req.urgency ?? 'normal', blocking: !!req.blocking, ref: id, dedupe_key: `ask:${id}` });
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
  answer(id: string, answer: string, by: 'owner' | 'manager' = 'owner', why?: string): AskDTO {
    const a = this.getAsk(id);
    if (!a) throw new Error(`no ask ${id}`);
    if (a.state === 'answered' || a.state === 'cancelled') return a;
    if (by === 'manager' && a.state !== 'escalated') throw new Error('manager may answer only escalated asks');
    this.store.db.prepare(`UPDATE asks SET state = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ?`)
      .run(answer, by, this.store.now(), id);
    this.inbox.resolveByRef('ask', id);
    const from = by === 'owner' ? OWNER : this.cfg.managerId;
    this.tell({ msg_id: `${id}-answer`, from, to: a.from_identity, kind: 'answer', ref: id, urgency: a.urgency, priority: 'now',
      body: by === 'owner' ? `תשובה לשאלה ${id}: ${answer}` : `יואב החליט במקום רן (${id}): ${answer}${why ? `, כי ${why}` : ''}` });
    if (by === 'manager') {
      // "החלטתי במקומך: X, כי Y" — informational, never pushed.
      this.inbox.add({ kind: 'escalation_note', title: `${this.label(this.cfg.managerId)} החליט במקומך`, from_identity: this.cfg.managerId,
        body: `${a.question}\n→ ${answer}${why ? `, כי ${why}` : ''}`, ref: id, urgency: 'low', dedupe_key: `escalation_note:${id}` });
    }
    const out = this.getAsk(id)!;
    this.store.emit('ask.answered', a.from_identity, out);
    return out;
  }

  /** Scheduler code, not an LLM remembering to check (B.4): blocking ask unanswered → manager. */
  escalate(a: AskDTO, why: string): void {
    if (a.from_identity === this.cfg.managerId) return; // the manager's own questions wait for the owner
    this.store.db.prepare(`UPDATE asks SET state = 'escalated', escalated_at = ? WHERE id = ? AND state = 'open'`).run(this.store.now(), a.id);
    this.tell({ msg_id: `${a.id}-escalation`, from: 'hq', to: this.cfg.managerId, kind: 'escalation', ref: a.id, urgency: a.urgency,
      priority: 'next', body: [
        `שאלה חוסמת מ-${this.label(a.from_identity)} לא נענתה ע"י רן (${why}).`,
        `שאלה (${a.id}): ${a.question}`,
        a.options.length ? `אפשרויות: ${a.options.join(' / ')}` : '',
        `אם זה בסמכותך: ענה עם tell(to="${a.from_identity}", ref="${a.id}", body="החלטתי במקומך: X, כי Y"). אם לא: השאר אותה לרן.`,
      ].filter(Boolean).join('\n') });
    this.store.emit('ask.escalated', a.from_identity, { id: a.id, why });
  }
}

function askDTO(r: AskRow): AskDTO {
  return { ...r, options: JSON.parse(r.options) as string[], blocking: r.blocking === 1 };
}
