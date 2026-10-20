// Shared types between hq, shift-host, adapter, mcp-company and hooks.
// Owner of this file: the hq build lane. Other lanes may ADD types; do not rename existing ones.
import type { Priority } from './shift-protocol.ts';
export type IdentityId = string;   // e.g. "yoav", "rotem", "eli"
export type ShiftId = string;      // `${IdentityId}-${n}`
/** B.4 two-stage ack: queued → delivered (CLI echo) → seen (assistant turn after it) → handled | failed. */
export type MessageState = 'queued' | 'delivered' | 'seen' | 'handled' | 'failed';

/** How much it matters to the human. Drives inbox order, push and escalation. */
export type Urgency = 'urgent' | 'normal' | 'low';

export type MessageKind = 'tell' | 'ask' | 'answer' | 'system' | 'probe_anomaly' | 'escalation';

/** Derived (never stored) status per A.3 — computed at read time from facts (B.11). */
export type DerivedStatus =
  | 'working'          // play_arrow
  | 'waiting_for_you'  // pause_circle · open ask/GO on the owner
  | 'blocked'          // block · on something else (named in `blocked_on`)
  | 'stuck'            // warning · alive, not progressing
  | 'restarting'       // autorenew
  | 'free'             // radio_button_unchecked · live shift, idle: answers right away ("פנוי")
  | 'resting'          // bedtime · no live shift: a message wakes it ("נח")
  | 'done';            // check_circle (ephemeral task worker whose task closed)

/** Material Symbols icon name per status (company.md, dir-0017): an icon from one set, never an emoji. */
export const STATUS_SYMBOL: Record<DerivedStatus, string> = {
  working: 'play_arrow', waiting_for_you: 'pause_circle', blocked: 'block', stuck: 'warning',
  restarting: 'autorenew', free: 'radio_button_unchecked', resting: 'bedtime', done: 'check_circle',
};

export type ShiftState = 'starting' | 'live' | 'ended' | 'dead';

/** Items in the owner's single "waiting for you" inbox (A.4). */
export type InboxKind = 'ask' | 'go' | 'login' | 'delivery_failure' | 'incident' | 'escalation_note' | 'shift_failure';

export interface InboxItemDTO {
  id: number;
  kind: InboxKind;
  title: string;
  body: string;
  from_identity: IdentityId | null;
  urgency: Urgency;
  blocking: boolean;
  ref: string | null;          // ask id / message id / probe id
  /** Where "פתיחה" goes when it is not the app itself: the one-time tab handoff link (B.9). */
  link: string | null;
  /** First line of an ask or GO, in his words: what changes for him. The body is the details. */
  headline: string | null;
  state: 'open' | 'resolved' | 'dismissed';
  created_at: number;          // epoch ms
  pushed_at: number | null;
  acked_at: number | null;
  /** He said "לא עכשיו": still open, shown below the rest until he takes it back (#74). */
  snoozed_at: number | null;
}

export interface AskDTO {
  id: string;                  // ask-<n> or caller-supplied msg_id
  from_identity: IdentityId;
  question: string;
  /** First line in his words; the question is the details under it. Null on asks from before it existed. */
  headline: string | null;
  options: string[];
  blocking: boolean;
  urgency: Urgency;
  state: 'open' | 'answered' | 'escalated' | 'cancelled';
  answer: string | null;
  answered_by: 'owner' | 'manager' | null;
  created_at: number;
  escalated_at: number | null;
}

/** Writers (mcp-company, hooks spool collector) POST these to hq. msg_id makes retries idempotent. */
export interface TellRequest {
  msg_id?: string;
  from?: IdentityId;           // omitted ⇒ "owner" (the human, via the app)
  to: IdentityId;
  body: string;
  urgency?: Urgency;
  priority?: Priority;
  ref?: string;
}

export interface AskRequest {
  msg_id?: string;
  from: IdentityId;
  question: string;
  headline?: string;
  options?: string[];
  blocking?: boolean;
  urgency?: Urgency;
}

/** One row of the hq event stream (WS `/ws`, REST `/api/events`). seq is monotonic; clients resume with `after=seq`. */
export interface HqEvent {
  seq: number;
  ts: number;
  type: string;                // e.g. "message.state", "inbox.new", "shift.state", "probe.result"
  identity: IdentityId | null;
  data: unknown;
}

export const OWNER: IdentityId = 'owner';

// Priority, EngineEvent, HostToHq/HqToHost frames: see shift-protocol.ts (engine lane).
export * from './shift-protocol.ts';
export * from './company-api.ts';
export * from './hebrew.ts';
