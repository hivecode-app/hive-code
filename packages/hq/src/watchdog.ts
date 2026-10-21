// Deterministic watchdog (B.5), every 15s per shift:
//   alive       — claude pid exists and /proc starttime matches what we recorded (pid reuse guard)
//   progressing — last stream event recent
//   stuck       — in a turn, no event for 10 min, no long tool running → nudge → interrupt → new shift with handoff
//   dead        — needs TWO signals ("failed probes are not proof of death"): process gone AND host unreachable,
//                 or the same single signal on two consecutive sweeps. Then: resurrect (resume) if it has work.
// Also: rest an idle non-resident shift after 20 min (B.2), unless background work of its own still runs (#175).
import type { HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { Mailbox } from './mailbox.ts';
import type { Inbox } from './inbox.ts';
import type { ShiftManager, ShiftRow } from './shifts.ts';
import { procStart } from './proc.ts';

export type Health = 'alive' | 'progressing' | 'stuck' | 'dead' | 'suspect';

export class Watchdog {
  procCheck: (pid: number) => string | null = procStart;

  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private mailbox: Mailbox;
  private inbox: Inbox;
  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, mailbox: Mailbox, inbox: Inbox) {
    this.store = store;
    this.cfg = cfg;
    this.shifts = shifts;
    this.mailbox = mailbox;
    this.inbox = inbox;
  }

  async sweep(): Promise<Record<string, Health>> {
    const out: Record<string, Health> = {};
    for (const s of this.shifts.active()) {
      if (s.kind === 'foreign' || s.machine !== 'local') continue;
      out[s.id] = await this.check(s);
    }
    return out;
  }

  private async check(s: ShiftRow): Promise<Health> {
    const now = this.store.now();
    // Signal 1: the process.
    let procOk: boolean | null = null; // null = not known yet (still starting)
    if (s.pid) {
      const st = this.procCheck(s.pid);
      procOk = st != null && (s.proc_start == null || st === s.proc_start);
    }
    // Signal 2: the host socket.
    let conn = this.shifts.connection(s.id);
    if (!conn) {
      await this.shifts.attach(s, 1, 0);
      conn = this.shifts.connection(s.id);
    }
    const hostOk = conn ? await conn.ping(3000) : false;
    // The awaits above can take seconds; another loop may have stopped or resumed this shift meanwhile.
    const fresh = this.shifts.get(s.id);
    if (!fresh || fresh.started_at !== s.started_at || (fresh.state !== 'starting' && fresh.state !== 'live')) return 'alive';
    s = fresh;

    if (s.state === 'starting' && procOk === null) {
      // Booting: dead only if the host never comes up within the delivery window.
      if (!hostOk && now - s.started_at > this.cfg.timers.deliveryTimeoutMs) return this.declareDead(s, 'never came up');
      return 'alive';
    }
    const signals = (procOk === false ? 1 : 0) + (hostOk ? 0 : 1);
    if (signals === 2 || (signals === 1 && s.dead_signals >= 1)) {
      return this.declareDead(s, procOk === false ? 'process gone' : 'host unreachable');
    }
    if (signals === 1) {
      this.shifts.setFields(s.id, { dead_signals: s.dead_signals + 1 });
      this.store.emit('watchdog.suspect', s.identity, { shift: s.id, procOk, hostOk });
      return 'suspect';
    }
    if (s.dead_signals) this.shifts.setFields(s.id, { dead_signals: 0 });

    // bet 4: claude not answering control pings while the host is fine = frozen. Act after unresponsiveActMs.
    const lastPing = Math.max(s.last_ping_ok_at ?? 0, s.started_at);
    if (s.state === 'live' && now - lastPing >= this.cfg.timers.unresponsiveActMs) {
      this.store.emit('watchdog.unresponsive', s.identity, { shift: s.id, since: lastPing });
      if (!s.interrupted_at) {
        try { await this.shifts.interrupt(s.id); } catch { /* next round */ }
        this.shifts.setFields(s.id, { interrupted_at: now });
      } else if (now - s.interrupted_at >= this.cfg.timers.unresponsiveActMs / 2) {
        await this.shifts.stop(s.id, 'unresponsive', s.started_at);
        if (s.task_id == null) await this.shifts.request(s.identity, { reason: 'resurrect', kind: s.kind });
      }
      return 'stuck';
    }

    const last = s.last_event_at ?? s.started_at;
    const quiet = now - last;
    if (s.in_turn && !s.long_tool && quiet >= this.cfg.timers.stuckAfterMs) {
      await this.unstick(s, now);
      return 'stuck';
    }
    // Background work still running (CI, a simulator): its end is told only to a live process, so a rest loses it (#175).
    const bg = s.bg_tasks !== '[]' && quiet < this.cfg.timers.restBgMaxMs;
    if (!s.in_turn && !bg && s.kind !== 'resident' && quiet >= this.cfg.timers.restAfterMs && !this.hasPending(s.identity)) {
      await this.shifts.stop(s.id, 'rest', s.started_at);
      this.store.emit('watchdog.rest', s.identity, { shift: s.id });
      return 'alive';
    }
    return quiet < 60_000 ? 'progressing' : 'alive';
  }

  private hasPending(identity: string): boolean {
    return !!this.store.db.prepare(`SELECT 1 FROM messages WHERE to_identity = ? AND state IN ('queued','delivered') LIMIT 1`).get(identity);
  }

  /** nudge → interrupt → new shift with handoff; each step waits one more stuck window. */
  private async unstick(s: ShiftRow, now: number): Promise<void> {
    const step = this.cfg.timers.stuckAfterMs;
    if (!s.stuck_since) {
      this.shifts.setFields(s.id, { stuck_since: now });
      this.store.emit('watchdog.stuck', s.identity, { shift: s.id });
    }
    if (!s.nudged_at) {
      this.shifts.setFields(s.id, { nudged_at: now });
      this.mailbox.tell({ msg_id: `nudge-${s.id}-${now}`, from: 'hq', to: s.identity, kind: 'system', priority: 'now',
        body: 'לא היה אירוע 10 דקות באמצע turn. אם אתה תקוע, כתוב במשפט אחד מה חוסם אותך.' });
      return;
    }
    if (!s.interrupted_at && now - s.nudged_at >= step / 2) {
      try { await this.shifts.interrupt(s.id); } catch { /* falls through to a new shift next round */ }
      this.shifts.setFields(s.id, { interrupted_at: now });
      this.store.emit('watchdog.interrupt', s.identity, { shift: s.id });
      return;
    }
    if (s.interrupted_at && now - s.interrupted_at >= step / 2) {
      this.store.emit('watchdog.new_shift', s.identity, { shift: s.id });
      // A task shift is simply ended: the scheduler re-picks the task at the head of the queue (new shift, handoff).
      if (s.task_id != null) await this.shifts.stop(s.id, 'stuck', s.started_at);
      else await this.shifts.request(s.identity, { reason: 'stuck', forceNew: true });
    }
  }

  private async declareDead(s: ShiftRow, why: string): Promise<Health> {
    this.shifts.markEnded(s.id, 'dead', `crash: ${why}`, s.started_at);
    if (this.shifts.get(s.id)?.started_at !== s.started_at) return 'alive';
    this.store.emit('watchdog.dead', s.identity, { shift: s.id, why });
    // Resurrection (B.2): resume the same session if it still has work. To him this is just ↻.
    // Task shifts are re-picked by the scheduler (it listens to `ended`), so only mail/residents are woken here.
    if (s.task_id == null && (this.hasPending(s.identity) || s.kind === 'resident')) {
      try {
        await this.shifts.request(s.identity, { reason: 'resurrect' });
      } catch (e) {
        this.store.emit('watchdog.resurrect_failed', s.identity, { shift: s.id, error: (e as Error).message });
        this.inbox.add({ kind: 'shift_failure', title: `${s.identity} נפל ולא קם מחדש`, from_identity: s.identity,
          body: `${why}; resume נכשל: ${(e as Error).message}`, ref: s.id, dedupe_key: `shift_failure:${s.id}:${s.started_at}` });
      }
    }
    return 'dead';
  }
}
