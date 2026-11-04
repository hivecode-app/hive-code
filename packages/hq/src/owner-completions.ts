import { OWNER } from '@company/shared';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';
import type { TaskRow } from './scheduler.ts';

/** Give the opener ten minutes to report; a fixed message id makes retries and duplicate closes harmless. */
export function ownerCompletions(store: Store, mailbox: Mailbox): void {
  const tasks = store.db.prepare(`SELECT * FROM tasks WHERE for_owner = 1 AND state IN ('done','closed')
    AND owner_done_at IS NOT NULL AND owner_done_at <= ?`).all(store.now() - 10 * 60_000) as TaskRow[];
  for (const task of tasks) {
    const opener = (JSON.parse(task.labels) as string[]).find((s) => s.startsWith('opened-by:'))?.slice(10);
    if (!opener || task.awaiting === 'check' || task.awaiting === 'verify' || !task.summary) continue;
    const reported = store.db.prepare(`SELECT 1 FROM messages WHERE to_identity = ? AND kind = 'tell' AND
      (ref = ? OR (from_identity = ? AND created_at >= ? AND created_at <= ?)) LIMIT 1`)
      .get(OWNER, `task-${task.id}`, opener, task.owner_done_at!, task.owner_done_at! + 10 * 60_000);
    if (reported) continue;
    mailbox.tell({ msg_id: `task-${task.id}-owner-complete`, from: opener, to: OWNER,
      ref: `task-${task.id}`, body: `הסתיים: ${task.summary}` });
  }
}
