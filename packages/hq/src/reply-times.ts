// How long he waits for each worker (27/10: eli took minutes over a simple request, and nothing showed it). Per message
// of his: from sending it to the worker's first streamed word after reading it (first_word_at, mailbox.ts), and to the
// reply that closed it (handled_at). A reply that came only through a tool (tell, ask) has no streamed word: its first
// word is the reply itself.
import { OWNER } from '@company/shared';
import type { Store } from './store.ts';

export interface ReplyTime { id: string; identity: string; created_at: number; first_word_ms: number | null; reply_ms: number | null }
export interface WorkerReplyTimes {
  identity: string; messages: number; answered: number;
  first_word_p50_ms: number | null; first_word_p90_ms: number | null;
  reply_p50_ms: number | null; reply_p90_ms: number | null;
}

/** Nearest-rank percentile of [xs] (any order); null when there is none. */
function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** His messages to workers since [since], newest first. */
export function replyTimes(store: Store, since: number): ReplyTime[] {
  const rows = store.db.prepare(`SELECT id, to_identity AS identity, created_at, first_word_at, handled_at FROM messages
    WHERE from_identity = ? AND kind = 'tell' AND to_identity != 'hq' AND created_at >= ? ORDER BY created_at DESC`)
    .all(OWNER, since) as { id: string; identity: string; created_at: number; first_word_at: number | null; handled_at: number | null }[];
  return rows.map((r) => {
    const reply = r.handled_at != null ? r.handled_at - r.created_at : null;
    const word = r.first_word_at != null ? r.first_word_at - r.created_at : reply;
    return { id: r.id, identity: r.identity, created_at: r.created_at,
      first_word_ms: word == null ? null : Math.max(0, reply != null ? Math.min(word, reply) : word), reply_ms: reply == null ? null : Math.max(0, reply) };
  });
}

/** Per worker, slowest first word (p50) first. */
export function replyTimesByWorker(times: ReplyTime[]): WorkerReplyTimes[] {
  const by = new Map<string, ReplyTime[]>();
  for (const t of times) by.set(t.identity, [...(by.get(t.identity) ?? []), t]);
  return [...by].map(([identity, ts]) => {
    const words = ts.flatMap((t) => (t.first_word_ms == null ? [] : [t.first_word_ms]));
    const replies = ts.flatMap((t) => (t.reply_ms == null ? [] : [t.reply_ms]));
    return { identity, messages: ts.length, answered: replies.length,
      first_word_p50_ms: pct(words, 50), first_word_p90_ms: pct(words, 90), reply_p50_ms: pct(replies, 50), reply_p90_ms: pct(replies, 90) };
  }).sort((a, b) => (b.first_word_p50_ms ?? -1) - (a.first_word_p50_ms ?? -1));
}
