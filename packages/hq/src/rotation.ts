// Rotation (24/10, quota): a long-running lead keeps its session, its continuity is worth something; only what is wasted goes.
//   rest — a lead about to rest with a context over restContextTokens writes a handoff first, while the prompt cache is warm.
//          Woken within restIdleMs it resumes as always (the cache is still there). Woken later, the resume would write the
//          whole conversation to the cache again: it starts a clean shift from the handoff and its memory instead (shifts.ts).
//   compact — a shift over compactContextTokens compacts in its next quiet moment (watchdog: no turn, no tool, no
//          background work, no mail, nothing waiting on him, for compactQuietMs), while the prompt cache is still warm.
//          `/compact` is a plain user line (no control_request); the session id stays, so a resume continues from the summary.
//          Task-496 research: at 250k a compaction is ~$0.3-0.5 against ~$0.05 of every later call that no longer reads the
//          dropped context; on 21-24/10 that was ~26% of what the leads spent, against 13% for the 600k cap alone.
//          It keeps the conversation (a summary), so it needs no handoff turn, and never cuts a turn. A task's shift too
//          (27/10: lumo-t586 ran 81 turns up to 625k, at 454k on average, with no compaction): its task can outlive many turns.
//          A turn that never pauses is the CLI's own: the adapter sets CLAUDE_CODE_AUTO_COMPACT_WINDOW (spec.ts).
//   cap  — the safety net: a working shift over maxContextTokens writes a handoff at the end of its turn, and is replaced.
// Never while background work runs, or while it waits on him (an open ask, an open GO of its own): it goes on as before.
// `shift.rotated` carries the context the rotation dropped, for the weekly report.
import type { HqConfig } from './config.ts';
import type { Mailbox } from './mailbox.ts';
import type { ShiftManager, ShiftRow } from './shifts.ts';
import type { Store } from './store.ts';

/** The context of a turn's last model call: what the next call reads again. null = not reported (no iterations). */
export function contextTokens(usage: unknown): number | null {
  const its = (usage as { iterations?: unknown } | null | undefined)?.iterations;
  if (!Array.isArray(its) || !its.length) return null;
  const u = its.at(-1) as Record<string, unknown> | null;
  if (!u || typeof u !== 'object') return null;
  const n = (k: string) => (typeof u[k] === 'number' ? u[k] as number : 0);
  const total = n('input_tokens') + n('cache_read_input_tokens') + n('cache_creation_input_tokens') + n('output_tokens');
  return total > 0 ? total : null;
}

/** What the identity waits on him for: an open ask, or an open GO it asked for. A rotation now would drop that thread. */
export function waitingOnOwner(store: Store, identity: string): 'ask' | 'go' | null {
  if (store.db.prepare(`SELECT 1 FROM asks WHERE from_identity = ? AND state IN ('open','escalated') LIMIT 1`).get(identity)) return 'ask';
  if (store.db.prepare(`SELECT 1 FROM inbox WHERE kind = 'go' AND state = 'open' AND from_identity = ? LIMIT 1`).get(identity)) return 'go';
  return null;
}

/** A shift the rotation is for: a standing one between tasks (a task's own shifts end with the task), on Claude. */
export function rotatable(s: ShiftRow): boolean {
  return s.kind !== 'foreign' && s.task_id == null && s.account !== 'codex';
}

/** The last shift rested with a handoff, long enough ago that its cache is gone, and was big: its wake starts clean. */
export function restRotationDue(cfg: HqConfig, store: Store, last: ShiftRow, now: number): boolean {
  const r = cfg.rotation;
  return r.enabled && last.end_reason === 'rest' && rotatable(last) && last.rest_handoff_at != null
    && (last.context_tokens ?? 0) >= r.restContextTokens && now - (last.ended_at ?? now) >= r.restIdleMs
    && !waitingOnOwner(store, last.identity);
}

interface Pending { why: 'rest' | 'cap'; startedAt: number; askedAt: number; context: number }

const k = (n: number) => `${Math.round(n / 1000)} אלף`;

/** What the summary keeps: what a lead works from between turns (its open threads, who waits on what, his decisions). */
export const COMPACT_INSTRUCTIONS = 'שמור במדויק: מה פתוח אצלך ומה הצעד הבא בכל דבר; מי מחכה למה (משימות, PRים, שאלות ובקשות GO לרן) '
  + 'עם המזהים; הכרעות והוראות של רן עם הציטוט; הודעות שעוד לא ענית עליהן, עם ה-msg_id. פרטי כלים וקבצים שכבר נסגרו לא צריך.';

/** A task's worker works from its brief: the task, where it stands, and what each open thread waits on. */
export const TASK_COMPACT_INSTRUCTIONS = 'שמור במדויק: המשימה כמו שנשלחה (מי שלח, msg_id, מה התבקש ומתי היא גמורה); ה-worktree והענף; '
  + 'כל PR עם מספר, קישור ומצב (סקירה, CI, סקירת עיצוב, מיזוג); מה כבר נעשה ומה הצעד הבא; מי מחכה למה ועל מה אתה מחכה; '
  + 'הכרעות והוראות של רן עם הציטוט; הודעות שעוד לא ענית עליהן, עם ה-msg_id. פלט של כלים וקבצים שכבר נסגרו לא צריך.';

export class Rotator {
  /** Shifts asked for a handoff (id → what for). In memory: after an hq restart the next rest or turn asks again. */
  private pending = new Map<string, Pending>();
  /** A cap rotation whose handoff never came: not asked again before this (id → ms). */
  private cooldown = new Map<string, number>();
  /** Deferrals already told (shift:why), so a turn after turn under an open ask is one event, not one per turn. */
  private deferred = new Set<string>();

  /** `/compact` sent (id → when, for which run); cleared by the compaction's boundary, or given up after handoffWaitMs. */
  private compacting = new Map<string, { at: number; startedAt: number }>();
  /** Not compacted again before this (id → ms): after a compaction, or one that never came. */
  private compactCooldown = new Map<string, number>();

  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private mailbox: Mailbox;
  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, mailbox: Mailbox) {
    this.store = store;
    this.cfg = cfg;
    this.shifts = shifts;
    this.mailbox = mailbox;
    shifts.on('frame', (row, f, live) => {
      // Replayed frames (a reattach after an hq restart) are history: nothing to act on now.
      if (live && f.t === 'event' && f.ev.kind === 'compact') this.onCompacted(row, f.ev);
      if (!live || f.t !== 'event' || f.ev.kind !== 'result') return;
      // On the next tick, like waitTurnEnd: what the other listeners fold from this result (the owner reply) is stored first.
      setImmediate(() => this.store.bg(this.onTurnEnd(row.id), 'rotation'));
    });
    shifts.on('ended', (row) => {
      this.pending.delete(row.id);
      this.cooldown.delete(row.id);
      this.compacting.delete(row.id);
      this.compactCooldown.delete(row.id);
      for (const key of this.deferred) if (key.startsWith(`${row.id}:`)) this.deferred.delete(key);
    });
  }

  /**
   * The watchdog would rest `s` now. A big context writes its handoff first: true = asked (or still waiting for it),
   * the rest comes after that turn. false = rest now, as always.
   */
  beforeRest(s: ShiftRow): boolean {
    const p = this.pending.get(s.id);
    if (p && p.startedAt === s.started_at) {
      if (this.store.now() - p.askedAt < this.cfg.rotation.handoffWaitMs) return true;
      this.pending.delete(s.id);
      this.store.emit('shift.rotation_skipped', s.identity, { shift: s.id, why: 'no_handoff', for: p.why });
      return false;
    }
    const r = this.cfg.rotation;
    const context = s.context_tokens ?? 0;
    if (!r.enabled || !rotatable(s) || context < r.restContextTokens) return false;
    const why = this.blocker(s);
    if (why) { this.defer(s, why, 'rest'); return false; }
    this.ask(s, 'rest', context, `המשמרת שלך עומדת לנוח, וה-context שלה ${k(context)} טוקנים. כתוב עכשיו \`handoff\`: מה פתוח, מה הצעד הבא, ומה מחכה למי. `
      + 'אל תתחיל עבודה חדשה. אם תתעורר תוך שעה, תמשיך באותה שיחה. אחרי יותר משעה תקום משמרת נקייה מה-handoff ומהזיכרון.');
    return true;
  }

  /**
   * The watchdog found `s` quiet (no turn, no background work, compactQuietMs since its last event). A big context compacts
   * now: true = asked (or still compacting). Nothing else happens to the shift on this sweep.
   */
  compactIfDue(s: ShiftRow): boolean {
    const r = this.cfg.rotation;
    const now = this.store.now();
    const c = this.compacting.get(s.id);
    if (c && c.startedAt === s.started_at) {
      if (now - c.at < r.handoffWaitMs) return true;
      this.compacting.delete(s.id);
      this.compactCooldown.set(s.id, now + r.handoffWaitMs * 3);
      this.store.emit('shift.compact_failed', s.identity, { shift: s.id, context_tokens: s.context_tokens });
      return false;
    }
    const context = s.context_tokens ?? 0;
    if (!r.enabled || !r.compactContextTokens || context < r.compactContextTokens || s.kind === 'foreign'
      || s.account === 'codex' || s.state !== 'live' || s.in_turn) return false;
    if ((this.compactCooldown.get(s.id) ?? 0) > now || this.pending.has(s.id)) return false;
    if (now - (s.last_event_at ?? s.started_at) < r.compactQuietMs) return false;
    // A quiet moment only: nothing it is in the middle of, and nothing on the way to it that the compaction would delay.
    if (this.blocker(s) || this.hasPending(s.identity)) return false;
    const conn = this.shifts.connection(s.id);
    if (!conn?.isLive) return false;
    this.compacting.set(s.id, { at: now, startedAt: s.started_at });
    this.store.emit('shift.compact_asked', s.identity, { shift: s.id, context_tokens: context });
    const failed = (error: string) => {
      this.compacting.delete(s.id);
      this.compactCooldown.set(s.id, this.store.now() + r.handoffWaitMs * 3);
      this.store.emit('shift.compact_failed', s.identity, { shift: s.id, error });
    };
    conn.send(`compact-${s.id}-${now}`, `/compact ${s.task_id != null ? TASK_COMPACT_INSTRUCTIONS : COMPACT_INSTRUCTIONS}`, 'next')
      .then((reply) => { if (reply?.state === 'failed') failed('the host did not take the line'); })
      .catch((e: Error) => failed(e.message));
    return true;
  }

  private onCompacted(row: ShiftRow, ev: { trigger?: string; preTokens?: number; postTokens?: number }): void {
    const asked = this.compacting.delete(row.id);
    this.compactCooldown.set(row.id, this.store.now() + this.cfg.rotation.handoffWaitMs * 3);
    this.store.emit('shift.compacted', row.identity, { shift: row.id, trigger: asked ? 'hq' : (ev.trigger ?? 'auto'),
      pre_tokens: ev.preTokens ?? null, post_tokens: ev.postTokens ?? null });
  }

  private async onTurnEnd(id: string): Promise<void> {
    const s = this.shifts.get(id);
    if (!s || s.state !== 'live' || !rotatable(s)) return;
    const p = this.pending.get(id);
    if (p && p.startedAt !== s.started_at) this.pending.delete(id);
    else if (p) return this.finish(s, p);
    const r = this.cfg.rotation;
    const context = s.context_tokens ?? 0;
    if (!r.enabled || !r.maxContextTokens || context < r.maxContextTokens) return;
    if ((this.cooldown.get(id) ?? 0) > this.store.now()) return;
    const why = this.blocker(s);
    if (why) { this.defer(s, why, 'cap'); return; }
    this.ask(s, 'cap', context, `ה-context של המשמרת שלך הגיע ל-${k(context)} טוקנים. כתוב עכשיו \`handoff\`: מה פתוח, מה הצעד הבא, ומה מחכה למי. `
      + 'אחרי הסבב הזה המשמרת תוחלף במשמרת נקייה מה-handoff ומהזיכרון, וההודעות שלך יגיעו אליה.');
  }

  /** A turn ended while a handoff was asked for: written → rest / rotate; not yet → wait for the next turn, up to handoffWaitMs. */
  private async finish(s: ShiftRow, p: Pending): Promise<void> {
    const handoff = this.store.db.prepare(`SELECT received_at FROM ops WHERE identity = ? AND op = 'handoff' AND received_at >= ?
      ORDER BY received_at DESC LIMIT 1`).get(s.identity, p.askedAt) as { received_at: number } | undefined;
    if (!handoff) {
      if (this.store.now() - p.askedAt < this.cfg.rotation.handoffWaitMs) return;
      this.pending.delete(s.id);
      if (p.why === 'cap') this.cooldown.set(s.id, this.store.now() + this.cfg.rotation.handoffWaitMs * 3);
      this.store.emit('shift.rotation_skipped', s.identity, { shift: s.id, why: 'no_handoff', for: p.why });
      return;
    }
    // A new turn already began (a message that waited behind this one): the stop waits for its end.
    if (s.in_turn) return;
    // The handoff turn may itself have opened an ask or a GO, or started background work: not now either.
    const why = this.blocker(s);
    if (why) {
      this.defer(s, why, p.why);
      // A cap rotation keeps its handoff and goes when the blocker is gone; a rest is left to the watchdog, as always.
      if (p.why === 'rest') this.pending.delete(s.id);
      return;
    }
    this.pending.delete(s.id);
    if (p.why === 'rest') {
      // Mail came in meanwhile: it works on, and its next rest asks for a handoff again (there will be more to hand off).
      if (this.hasPending(s.identity)) return;
      this.shifts.setFields(s.id, { rest_handoff_at: handoff.received_at });
      await this.shifts.stop(s.id, 'rest', s.started_at);
      this.store.emit('watchdog.rest', s.identity, { shift: s.id, handoff: true, context_tokens: s.context_tokens });
      return;
    }
    await this.shifts.stop(s.id, 'rotation', s.started_at);
    const ended = this.shifts.get(s.id);
    if (ended?.end_reason !== 'rotation' || ended.started_at !== s.started_at) return;
    this.store.emit('shift.rotated', s.identity, { shift: s.id, trigger: 'cap', context_tokens: s.context_tokens });
    // Mail on the way (or a resident) gets the clean shift now; anything else starts it with its next message.
    if (this.hasPending(s.identity) || s.kind === 'resident') {
      await this.shifts.request(s.identity, { reason: 'rotation', kind: s.kind }).catch((e: Error) =>
        this.store.emit('shift.rotation_failed', s.identity, { shift: s.id, error: e.message }));
    }
  }

  private ask(s: ShiftRow, why: Pending['why'], context: number, body: string): void {
    const now = this.store.now();
    this.pending.set(s.id, { why, startedAt: s.started_at, askedAt: now, context });
    this.store.emit('shift.rotation_asked', s.identity, { shift: s.id, for: why, context_tokens: context });
    this.mailbox.tell({ msg_id: `rotate-${s.id}-${now}`, from: 'hq', to: s.identity, kind: 'system', priority: 'next', body });
  }

  private blocker(s: ShiftRow): string | null {
    if (s.long_tool) return 'long_tool';
    if (s.bg_tasks !== '[]') return 'background';
    return waitingOnOwner(this.store, s.identity);
  }

  private defer(s: ShiftRow, why: string, what: Pending['why']): void {
    const key = `${s.id}:${s.started_at}:${why}`;
    if (this.deferred.has(key)) return;
    this.deferred.add(key);
    this.store.emit('shift.rotation_deferred', s.identity, { shift: s.id, why, for: what, context_tokens: s.context_tokens });
  }

  /** Mail on the way to it, other than hq's own ask for the handoff. */
  private hasPending(identity: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM messages WHERE to_identity = ? AND state IN ('queued','delivered')
      AND NOT (from_identity = 'hq' AND id LIKE 'rotate-%') AND NOT (state = 'queued' AND fyi = 1) LIMIT 1`).get(identity);
  }
}
