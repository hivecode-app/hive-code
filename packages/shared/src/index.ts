// Shared types between hq, shift-host, adapter, mcp-company and hooks.
// Owner of this file: the hq build lane. Other lanes may ADD types; do not rename existing ones.
import type { Priority } from './shift-protocol.ts';
export type IdentityId = string;   // e.g. "yoav", "rotem", "eli"
export type ShiftId = string;      // `${IdentityId}-${n}`
/** B.4 two-stage ack: queued → delivered (CLI echo) → seen (assistant turn after it) → handled | failed. */
export type MessageState = 'queued' | 'delivered' | 'seen' | 'handled' | 'failed';

/** How much it matters to the human. Drives inbox order, push and escalation. */
export type Urgency = 'urgent' | 'normal' | 'low';

/** note: text a worker wrote in his conversation in a turn he did not start; kept, never alerts or counts as unread. */
export type MessageKind = 'tell' | 'ask' | 'answer' | 'system' | 'probe_anomaly' | 'escalation' | 'note';

/** Derived (never stored) status per A.3 — computed at read time from facts (B.11). */
export type DerivedStatus =
  | 'working'          // play_arrow
  | 'waiting_for_you'  // front_hand · open ask/GO on the owner
  | 'blocked'          // block · on something else (named in `blocked_on`)
  | 'stuck'            // warning · alive, not progressing
  | 'restarting'       // autorenew
  | 'free'             // radio_button_unchecked · live shift, idle: answers right away ("פנוי")
  | 'resting'          // bedtime · no live shift: a message wakes it ("נח")
  | 'done';            // check_circle (ephemeral task worker whose task closed)

/** Material Symbols icon name per status (company.md, dir-0017): an icon from one set, never an emoji. */
export const STATUS_SYMBOL: Record<DerivedStatus, string> = {
  working: 'play_arrow', waiting_for_you: 'front_hand', blocked: 'block', stuck: 'warning',
  restarting: 'autorenew', free: 'radio_button_unchecked', resting: 'bedtime', done: 'check_circle',
};

/** A team's identity tone (org.yaml `teams[].tone`, docs/design/language-v2.md §3): one of eight muted hues on the
 *  faces of its workers. Identity only, beside the name or the icon; a state is never told by it. None = slate. */
export const TONES = ['blue', 'teal', 'clay', 'green', 'rose', 'sky', 'olive', 'slate'] as const;
export type Tone = (typeof TONES)[number];

export type ShiftState = 'starting' | 'live' | 'ended' | 'dead';

/** Items in the owner's single "waiting for you" inbox (A.4). */
/** `awaiting` (#219): a finished task that waits on him to check or verify something, ref `task-<id>`. */
export type InboxKind = 'ask' | 'go' | 'login' | 'delivery_failure' | 'incident' | 'escalation_note' | 'shift_failure' | 'awaiting';

/** A link under a decision in the app: the full report, or the PR (always a full https URL). */
export interface InboxLink { kind: 'report' | 'pr'; url: string }

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
  /** "הדוח המלא", "ה-PR": what the app shows under the decision. Empty when there is none. */
  links: InboxLink[];
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
  /** What the one it was escalated to wrote about it (a tell, not an answer): a small line on the card. */
  manager_note: string | null;
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
  /** The card's title; default "<name> שואל/ת". */
  title?: string;
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

/** `muted_until` of a conversation muted "תמיד". */
export const MUTE_FOREVER = 8_640_000_000_000_000;

/** One conversation as he sees it (WhatsApp): what he hasn't read yet, and whether it may alert him. */
export interface ConversationStateDTO {
  identity: IdentityId;
  /** "דנה · מנכ"לית לומו": the notification's title. */
  title: string;
  /** Messages from the worker to him after `read_at`. */
  unread: number;
  /** He has read everything in it up to here (epoch ms), on any device. */
  read_at: number;
  /** Muted until (epoch ms; MUTE_FOREVER = always). Null = not muted. A muted conversation counts, but never alerts. */
  muted_until: number | null;
  /** created_at of the newest message that was allowed to alert him. A device alerts when it is newer than `read_at`. */
  alert_at: number | null;
  alert_level?: 'sound' | 'silent' | null;
  /** The newest message either way. */
  last_at: number | null;
  /** The newest unread messages from the worker (oldest first, at most 5): what a notification shows. */
  recent: { id: string; body: string; created_at: number }[];
}

// Priority, EngineEvent, HostToHq/HqToHost frames: see shift-protocol.ts (engine lane).
export * from './shift-protocol.ts';
export * from './company-api.ts';
export * from './hebrew.ts';
export * from './names.ts';
export * from './company-home.ts';
