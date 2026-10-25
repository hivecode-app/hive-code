// "ביקשת" (#118): what he asked a worker for and is still waiting on, and the answer once it came, until he reads it.
// A request is his message to a worker that nothing answered within ASKED_AFTER_MS (a chat answer comes back
// sooner; what stays is work he waits for, "תשלח לי מה הבעיה"). A message of the worker to him after it is the
// answer. An ask or a GO that answered it marks it handled and is already in "מחכה לך". Derived from the store,
// nothing kept: the board's `asked`, and the home block `asked {messages[]}`.
import { OWNER } from '@company/shared';
import type { Store } from './store.ts';

export const ASKED_AFTER_MS = 2 * 60_000;
/** Older requests are not his open list any more. */
export const ASKED_WINDOW_MS = 7 * 86_400_000;
const BODY_MAX = 300;

export interface AskedItem {
  /** His (first) message: what the home block references. */
  id: string;
  identity: string;
  body: string;
  created_at: number;
  /** How many of his messages this row stands for: the ones that one answer (or none yet) covers. */
  count: number;
  state: 'open' | 'answered';
  reply: { id: string; body: string; created_at: number } | null;
}

interface Row { id: string; to_identity: string; body: string; created_at: number; state: string }
interface Reply { id: string; body: string; created_at: number }

/** Newest first. */
export function askedList(store: Store): AskedItem[] {
  const db = store.db;
  const now = store.now();
  const mine = db.prepare(`SELECT id, to_identity, body, created_at, state FROM messages WHERE from_identity = ? AND kind = 'tell'
    AND to_identity != 'hq' AND created_at >= ? ORDER BY created_at, rowid`).all(OWNER, now - ASKED_WINDOW_MS) as Row[];
  const replyStmt = db.prepare(`SELECT id, body, created_at FROM messages WHERE from_identity = ? AND to_identity = ? AND kind NOT IN ('system','note')
    AND created_at >= ? ORDER BY created_at, rowid LIMIT 1`);
  const readStmt = db.prepare('SELECT read_at FROM conversations WHERE identity = ?');
  const readAt = (identity: string) => (readStmt.get(identity) as { read_at: number } | undefined)?.read_at ?? 0;
  const rows = new Map<string, AskedItem>();
  for (const m of mine) {
    const reply = replyStmt.get(m.to_identity, OWNER, m.created_at) as Reply | undefined;
    // One row per worker and answer: his follow-ups to the same request don't each get a line.
    const key = `${m.to_identity}\u0000${reply?.id ?? ''}`;
    const row = rows.get(key);
    if (row) { row.count++; continue; }
    if (reply) {
      if (reply.created_at <= readAt(m.to_identity)) continue;
      // Answered in the same breath is a conversation, not a request he waited on.
      if (reply.created_at - m.created_at < ASKED_AFTER_MS) continue;
    } else if (m.state === 'handled' || m.state === 'failed' || now - m.created_at < ASKED_AFTER_MS) {
      // failed = never delivered (its task closed): a visible failure in the conversation, not a wait.
      continue;
    }
    rows.set(key, {
      id: m.id, identity: m.to_identity, body: m.body.slice(0, BODY_MAX), created_at: m.created_at, count: 1,
      state: reply ? 'answered' : 'open', reply: reply ? { id: reply.id, body: reply.body.slice(0, BODY_MAX), created_at: reply.created_at } : null,
    });
  }
  return [...rows.values()].sort((a, b) => (b.reply?.created_at ?? b.created_at) - (a.reply?.created_at ?? a.created_at));
}
