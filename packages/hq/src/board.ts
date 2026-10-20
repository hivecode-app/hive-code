// Derived status (B.11): never stored, computed at read time from facts — live shift, last event,
// open ask, rate limit, task state. Precedence follows what he needs to see first.
import { STATUS_SYMBOL, type DerivedStatus } from '@company/shared';
import type { Store } from './store.ts';
import type { IdentityRow } from './org.ts';
import { listIdentities } from './org.ts';
import type { ShiftRow } from './shifts.ts';
import { FALLBACK_TIME_ZONE, hhmm } from './timezone.ts';

export interface BoardEntry {
  id: string; name: string; title: string; symbol: string; team: string | null; team_kind: string | null; project: string | null;
  reports_to: string | null; lifecycle: string;
  status: DerivedStatus; status_symbol: string; blocked_on: string | null; live: boolean;
  shift: { id: string; state: string; started_at: number; last_event_at: number | null; in_turn: boolean } | null;
  task: { id: number; ref: string | null; title: string; state: string } | null;
  /** The task it is on now (running, resting on a message, interrupted mid-way); null between tasks. */
  current_task: { id: number; ref: string | null; title: string; state: string } | null;
  /** Tasks handed to it that wait their turn (a standing worker takes one at a time). */
  queued: number;
  open_asks: number; queued_messages: number;
  /** When this status was derived and when the shift last proved alive — the board shows "updated X s ago" (bet 4). */
  derived_at: number; last_seen_at: number | null;
}

export function deriveStatus(i: IdentityRow, s: ShiftRow | undefined, f: {
  openAsks: number; taskState: string | null; now: number; hadEarlierShift: boolean; unresponsiveAfterMs?: number; tz?: string;
}): { status: DerivedStatus; blocked_on: string | null } {
  if (i.lifecycle === 'ephemeral' && f.taskState === 'done') return { status: 'done', blocked_on: null };
  if (f.openAsks > 0) return { status: 'waiting_for_you', blocked_on: null };
  if (s) {
    if (s.rate_limited_until && s.rate_limited_until > f.now) {
      return { status: 'blocked', blocked_on: `מכסה, חוזר ב-${hhmm(s.rate_limited_until, f.tz ?? FALLBACK_TIME_ZONE)}` };
    }
    if (s.stuck_since) return { status: 'stuck', blocked_on: null };
    // Unresponsive ≠ dead (bet 4): claude stopped answering control pings. Shown as `warning` with the reason.
    if (s.state === 'live' && f.unresponsiveAfterMs && f.now - Math.max(s.last_ping_ok_at ?? 0, s.started_at) > f.unresponsiveAfterMs) {
      return { status: 'stuck', blocked_on: 'לא עונה' };
    }
    if (s.state === 'starting') return { status: f.hadEarlierShift ? 'restarting' : 'working', blocked_on: null };
    if (s.in_turn) return { status: 'working', blocked_on: null };
    // Live and idle: awake, answers right away (APP-SPEC §6.2 "פנוי"). Never "נח" while a shift is up.
    return { status: 'free', blocked_on: null };
  }
  if (f.taskState === 'parked' || f.taskState === 'needs_decision') return { status: 'blocked', blocked_on: 'מחכה להחלטה' };
  return { status: 'resting', blocked_on: null };
}

export function board(store: Store, unresponsiveAfterMs?: number, tz?: string): BoardEntry[] {
  const now = store.now();
  const shiftQ = store.db.prepare(`SELECT * FROM shifts WHERE identity = ? ORDER BY shift_no DESC, started_at DESC LIMIT 2`);
  const askQ = store.db.prepare(`SELECT COUNT(*) n FROM asks WHERE from_identity = ? AND state IN ('open','escalated')`);
  const msgQ = store.db.prepare(`SELECT COUNT(*) n FROM messages WHERE to_identity = ? AND state = 'queued'`);
  const endedQ = store.db.prepare(`SELECT 1 FROM events WHERE type = 'shift.state' AND identity = ?
    AND json_extract(data, '$.state') IN ('ended', 'dead') LIMIT 1`);
  const taskQ = store.db.prepare(`SELECT id, ref, title, state FROM tasks WHERE identity = ? ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`);
  const currentQ = store.db.prepare(`SELECT id, ref, title, state FROM tasks WHERE identity = ? AND (state IN ('running','resting')
    OR (state IN ('open','interrupted') AND started_at IS NOT NULL)) ORDER BY CASE state WHEN 'running' THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`);
  const queuedQ = store.db.prepare(`SELECT COUNT(*) n FROM tasks WHERE identity = ? AND state = 'queued'`);
  return listIdentities(store).map((i) => {
    const [latest, older] = shiftQ.all(i.id) as ShiftRow[];
    const live = latest && (latest.state === 'starting' || latest.state === 'live') ? latest : undefined;
    // restarting (autorenew) = coming back: an earlier shift exists, or this same shift (resume) ended before.
    const hadEarlierShift = !!live && (older != null || endedQ.get(i.id) != null);
    const openAsks = (askQ.get(i.id) as { n: number }).n;
    const task = taskQ.get(i.id) as BoardEntry['task'] | undefined;
    const d = deriveStatus(i, live, { openAsks, taskState: task?.state ?? null, now, hadEarlierShift, unresponsiveAfterMs, tz });
    return {
      id: i.id, name: i.name, title: i.title, symbol: i.symbol, team: i.team, team_kind: i.team_kind, project: i.project,
      reports_to: i.reports_to, lifecycle: i.lifecycle, status: d.status, status_symbol: STATUS_SYMBOL[d.status], blocked_on: d.blocked_on,
      live: !!live,
      shift: latest ? { id: latest.id, state: latest.state, started_at: latest.started_at, last_event_at: latest.last_event_at, in_turn: latest.in_turn === 1 } : null,
      task: task ?? null, current_task: (currentQ.get(i.id) as BoardEntry['current_task'] | undefined) ?? null,
      queued: (queuedQ.get(i.id) as { n: number }).n, open_asks: openAsks, queued_messages: (msgQ.get(i.id) as { n: number }).n,
      derived_at: now, last_seen_at: latest ? Math.max(latest.last_ping_ok_at ?? 0, latest.last_event_at ?? 0) || null : null,
    };
  });
}
