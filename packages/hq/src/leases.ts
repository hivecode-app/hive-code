// reserve / release (resources-design.md §1, §3): a worker asks hq for a place before a heavy command (a build, a full test,
// docker, a smoke) and gets one of three answers:
//   granted      a lease: `company-run --lease L -- <cmd>` runs the command in a systemd scope with the class's ceiling
//   queued       no place now. The call comes back within the wait (90s) with who holds it, the place in the queue and an
//                estimate; the next call (`lease`) goes on from the same place, like `request` in request_access
//   unavailable  it will not fit in a reasonable time, or the class is not defined here; with an alternative
// The queue is FIFO per machine in the order of B.16 (a p0 task first, then by when it asked). A lease behind a waiting p0 is
// not granted even when it would fit: a p0 is not overtaken. hq never stops a lease that is held for a p0 (his decision, 22/10).
// A lease ends by itself: the command ends (company-run says so), company-run stops answering, its class's ceiling
// passes, a place nobody takes or asks for goes back, and a closed shift gives up all of its leases.
import type { Hq } from './hq.ts';
import { getIdentity } from './org.ts';
import { readCharter } from './workspace.ts';
import { classesFor, scopeProps, type HeavyClass } from './heavy.ts';
import { LOCAL } from './nodes.ts';
import { totalmem } from 'node:os';

export const DEFAULT_WAIT_S = 90;
export const MAX_WAIT_S = 100;
/** company-run beats this often; hq lets this long pass without one before the lease is the connection's loss. */
export const BEAT_LOST_MS = 90_000;
/** A granted lease nobody ran a command under (no company-run) goes back after this long. */
export const UNCLAIMED_MS = 5 * 60_000;
/** A queued lease whose worker stopped asking goes after this long. */
export const ABANDONED_MS = 5 * 60_000;

export class LeaseError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

type State = 'queued' | 'granted' | 'released';
type Reason = 'released' | 'exited' | 'timeout' | 'shift-ended' | 'connection-lost' | 'unclaimed' | 'abandoned' | 'cancelled';

export interface LeaseRow {
  id: number; identity: string; shift: string | null; task: number | null; project: string | null; class: string; machine: string; note: string | null;
  priority: number; mem_mb: number; cpu: number; exclusive: string | null; timeout_ms: number; state: State;
  created_at: number; polled_at: number; granted_at: number | null; attached_at: number | null; beat_at: number | null;
  released_at: number | null; release_reason: Reason | null; exit_code: number | null;
}

/** What reserve answers. `message` is Hebrew and says what to do next. */
export interface LeaseReply {
  status: 'granted' | 'queued' | 'unavailable' | 'released';
  lease?: string;
  machine?: string;
  message: string;
  run?: string;
  holder?: string;
  position?: number;
  eta_min?: number;
  alternative?: string;
}

/** What company-run takes when it attaches: the ceiling of the scope and the environment of the command. */
export interface RunPlan {
  lease: string; class: string; memoryMax: string; cpuWeight: number; env: Record<string, string>; remainingMs: number;
}

export const leaseName = (id: number) => `lease-${id}`;
const asS = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const mins = (ms: number) => Math.max(1, Math.round(ms / 60_000));

const REASON_HE: Record<Reason, string> = {
  released: 'שוחררה', exited: 'הפקודה נגמרה', timeout: 'עברה התקרה של המחלקה', 'shift-ended': 'המשמרת נסגרה',
  'connection-lost': 'company-run הפסיק להשיב', unclaimed: 'אף פקודה לא רצה תחתיה', abandoned: 'לא חזרת לשאול', cancelled: 'בוטלה',
};

export class Leases {
  private hq: Hq;
  private startedAt: number;

  constructor(hq: Hq) {
    this.hq = hq;
    this.startedAt = hq.store.now();
  }

  private get db() { return this.hq.store.db; }
  private now() { return this.hq.store.now(); }

  row(id: number): LeaseRow | undefined {
    return this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id) as LeaseRow | undefined;
  }

  /** Open leases (queued and granted), the oldest first. */
  list(): LeaseRow[] {
    return this.db.prepare(`SELECT * FROM leases WHERE state != 'released' ORDER BY created_at, id`).all() as LeaseRow[];
  }

  private idOf(v: unknown): number {
    const m = typeof v === 'string' ? /^lease-(\d+)$/.exec(v) : null;
    if (!m) throw new LeaseError(400, `lease: expected "lease-N", got ${JSON.stringify(v)}`);
    return Number(m[1]);
  }

  /** Who is asking: a live shift of that identity, with its machine, its task's priority and its project. */
  private caller(identity: string, shift: string): { machine: string; task: number | null; project: string | null; priority: number } {
    const row = this.db.prepare('SELECT identity, state, machine FROM shifts WHERE id = ?').get(shift) as { identity: string; state: string; machine: string | null } | undefined;
    if (!row || row.identity !== identity || (row.state !== 'live' && row.state !== 'starting')) throw new LeaseError(403, `reserve: no live shift ${shift} of ${identity}`);
    const t = this.db.prepare(`SELECT id, project, priority FROM tasks WHERE identity = ? AND state IN ('running','resting') ORDER BY updated_at DESC LIMIT 1`)
      .get(identity) as { id: number; project: string | null; priority: number } | undefined;
    return { machine: row.machine ?? LOCAL, task: t?.id ?? null, priority: t?.priority ?? 2, project: t?.project ?? getIdentity(this.hq.store, identity)?.project ?? null };
  }

  private machines(): string[] { return [LOCAL, ...this.hq.nodes.list.map((n) => n.def.name)]; }

  /** The memory the leases of a machine may hold together; null = the machine is not known or does not answer. */
  budgetMb(machine: string): number | null {
    const set = this.hq.cfg.heavy.machines[machine]?.memMb;
    if (typeof set === 'number' && set > 0) return set;
    let total: number;
    if (machine === LOCAL) total = Math.floor(totalmem() / 1048576);
    else {
      const st = this.hq.nodes.get(machine)?.status;
      if (!st?.up) return null;
      total = st.totalMb;
    }
    return Math.floor(total * this.hq.cfg.heavy.budgetPct / 100);
  }

  private classOf(project: string | null, name: string): { cls: HeavyClass | null; known: string[] } {
    const charter = project ? readCharter(this.hq.cfg.companyDir, project)?.heavy ?? [] : [];
    const all = classesFor(this.hq.cfg.heavy.classes, charter);
    return { cls: all.get(name) ?? null, known: [...all.keys()] };
  }

  private granted(machine: string): LeaseRow[] {
    return this.db.prepare(`SELECT * FROM leases WHERE state = 'granted' AND machine = ? ORDER BY granted_at, id`).all(machine) as LeaseRow[];
  }

  /** The queue of a machine in the order it is served: p0 first, then by when each asked. */
  private queue(machine: string): LeaseRow[] {
    return this.db.prepare(`SELECT * FROM leases WHERE state = 'queued' AND machine = ? ORDER BY priority, created_at, id`).all(machine) as LeaseRow[];
  }

  /** How long a class takes here: the average of its last ten finished leases, else a third of its ceiling. */
  private typicalMs(cls: string, timeoutMs: number): number {
    const r = this.db.prepare(`SELECT AVG(d) a FROM (SELECT released_at - granted_at d FROM leases WHERE class = ? AND granted_at IS NOT NULL
      AND release_reason IN ('exited','released') ORDER BY id DESC LIMIT 10)`).get(cls) as { a: number | null };
    return r.a && r.a > 0 ? r.a : timeoutMs / 3;
  }

  /** Why `r` cannot start now: the lease it waits for, or null when it fits. */
  private blockedBy(r: LeaseRow, held: LeaseRow[]): LeaseRow | null | 'budget' {
    if (r.exclusive) {
      const same = held.find((h) => h.exclusive === r.exclusive);
      if (same) return same;
    }
    const budget = this.budgetMb(r.machine);
    if (budget === null) return 'budget';
    if (held.reduce((n, h) => n + h.mem_mb, 0) + r.mem_mb <= budget) return null;
    // The one that frees the memory soonest.
    return [...held].sort((a, b) => this.endsAt(a) - this.endsAt(b))[0] ?? 'budget';
  }

  private endsAt(h: LeaseRow): number {
    return Math.min((h.granted_at ?? this.now()) + this.typicalMs(h.class, h.timeout_ms), (h.granted_at ?? this.now()) + h.timeout_ms);
  }

  private holderText(h: LeaseRow): string {
    return [h.task ? `משימה ${h.task}` : null, h.project ?? h.identity, h.class, `${mins(this.now() - (h.granted_at ?? this.now()))} דקות`].filter(Boolean).join(' · ');
  }

  /** Grants the queue of a machine in order while it fits; the first that waits for memory holds back all behind it. */
  promote(machine: string, own?: number): LeaseRow[] {
    const given: LeaseRow[] = [];
    for (const q of this.queue(machine)) {
      const blocked = this.blockedBy(q, this.granted(machine));
      if (blocked !== null) {
        // One that waits for memory holds back all behind it. One that waits only for its exclusive key (one flutter test at a time)
        // takes nothing from the others, unless it is a p0: a p0 is not overtaken.
        const waitsOnKey = q.priority > 0 && blocked !== 'budget' && q.exclusive !== null && blocked.exclusive === q.exclusive;
        if (waitsOnKey) continue;
        break;
      }
      const now = this.now();
      this.db.prepare(`UPDATE leases SET state = 'granted', granted_at = ?, polled_at = ? WHERE id = ? AND state = 'queued'`).run(now, now, q.id);
      this.hq.store.emit('lease.granted', q.identity, { lease: leaseName(q.id), class: q.class, machine, waited_ms: now - q.created_at });
      given.push(this.row(q.id)!);
      // A worker who is not inside the call that waits for this lease hears of it: its place is held until company-run takes it.
      if (q.id !== own) this.grantedFromQueue(this.row(q.id)!);
    }
    return given;
  }

  private grantedFromQueue(r: LeaseRow): void {
    this.hq.mailbox.tell({
      msg_id: `lease-${r.id}-granted`, from: 'hq', to: r.identity, kind: 'system', priority: 'next',
      body: `יש מקום ל-${r.class} ב-${r.machine}: ${leaseName(r.id)} ניתנה לך מהתור. מריצים דרך \`company-run --lease ${leaseName(r.id)} -- <הפקודה>\`; ` +
        `אם אף פקודה לא רצה תחתיה תוך ${UNCLAIMED_MS / 60_000} דקות היא חוזרת, כדי שמי שמחכה אחריך יקבל מקום.`,
    });
  }

  async request(body: unknown): Promise<LeaseReply | RunPlan | { state: string; reason?: string; remaining_ms?: number } | { ok: true }> {
    const b = (body ?? {}) as Record<string, unknown>;
    switch (asS(b.op) ?? 'reserve') {
      case 'reserve': return this.reserve(b);
      case 'release': return this.releaseCall(b);
      case 'attach': return this.attach(b);
      case 'beat': return this.beat(b);
      case 'finish': return this.finish(b);
      default: throw new LeaseError(400, `lease: unknown op ${JSON.stringify(b.op)}`);
    }
  }

  private async reserve(b: Record<string, unknown>): Promise<LeaseReply> {
    const identity = asS(b.identity), shift = asS(b.shift);
    if (!identity || !shift) throw new LeaseError(400, 'reserve: identity and shift are required');
    const who = this.caller(identity, shift);
    const waitS = Math.min(MAX_WAIT_S, Math.max(0, typeof b.wait === 'number' ? b.wait : DEFAULT_WAIT_S));

    let row: LeaseRow;
    if (asS(b.lease)) {
      const cur = this.row(this.idOf(b.lease));
      if (!cur || cur.identity !== identity) throw new LeaseError(404, `reserve: no lease ${b.lease} of ${identity}`);
      row = cur;
    } else {
      const name = asS(b.class);
      if (!name) throw new LeaseError(400, 'reserve: pass class, or lease to go on with one');
      const machine = asS(b.machine) ?? who.machine;
      // A retry (the reply was lost) is the same lease: one that waits, or was granted and nobody ran under yet.
      const open = this.db.prepare(`SELECT * FROM leases WHERE shift = ? AND class = ? AND machine = ? AND (state = 'queued' OR (state = 'granted' AND attached_at IS NULL)) ORDER BY id LIMIT 1`)
        .get(shift, name, machine) as LeaseRow | undefined;
      if (open) row = open;
      else {
        const made = this.create(identity, shift, who, name, machine, asS(b.note) ?? null);
        if ('message' in made) return made;
        row = made;
      }
    }
    return this.advance(row, waitS);
  }

  /** A new queued lease, or the `unavailable` answer. */
  private create(identity: string, shift: string, who: { task: number | null; project: string | null; priority: number }, name: string, machine: string, note: string | null): LeaseRow | LeaseReply {
    const { cls, known } = this.classOf(who.project, name);
    if (!cls) {
      return { status: 'unavailable', message: `המחלקה "${name}" לא מוגדרת. המחלקות הקיימות: ${known.join(', ') || 'אין'}. מחלקה חדשה מוסיפים בבלוק \`heavy:\` באמנת הפרויקט (class, mem, cpu, timeout), או ב-\`heavy.classes\` של hq.config.json לכל החברה. עד שתוגדר אפשר להמשיך כמו היום, בלי הזמנה.` };
    }
    if (!this.machines().includes(machine)) {
      return { status: 'unavailable', message: `אין מכונה בשם "${machine}". המכונות: ${this.machines().join(', ')}.` };
    }
    const budget = this.budgetMb(machine);
    if (budget === null) {
      return { status: 'unavailable', machine, message: `המכונה ${machine} לא עונה עכשיו, ולכן אי אפשר להזמין בה מקום.`, alternative: this.alternative(cls, machine) };
    }
    if (cls.memMb > budget) {
      return { status: 'unavailable', machine, message: `${name} צריך ${cls.memMb}MB, ובתקציב של ${machine} יש ${budget}MB. לא יהיה בה מקום גם כשהכול פנוי.`, alternative: this.alternative(cls, machine) };
    }
    const now = this.now();
    const id = Number(this.db.prepare(`INSERT INTO leases (identity, shift, task, project, class, machine, note, priority, mem_mb, cpu, exclusive, timeout_ms, state, created_at, polled_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`).run(identity, shift, who.task, who.project, name, machine, note, who.priority, cls.memMb, cls.cpu, cls.exclusive, cls.timeoutMs, now, now).lastInsertRowid);
    this.hq.store.emit('lease.requested', identity, { lease: leaseName(id), class: name, machine, task: who.task });
    this.promote(machine, id);
    return this.row(id)!;
  }

  /** Another machine that could take the class now, as a sentence; undefined when none. */
  private alternative(cls: HeavyClass, not: string): string | undefined {
    for (const m of this.machines()) {
      if (m === not) continue;
      const budget = this.budgetMb(m);
      if (budget === null || cls.memMb > budget) continue;
      const probe = { machine: m, mem_mb: cls.memMb, exclusive: cls.exclusive } as LeaseRow;
      if (this.blockedBy(probe, this.granted(m)) === null) return `המכונה ${m} פנויה עכשיו: פתח את המשימה שם (\`open_team\`), או הרץ ב-\`reserve\` עם \`machine: "${m}"\` מה שרץ שם.`;
    }
    return undefined;
  }

  /** Waits (up to waitS) for a queued lease to be granted, then answers by where it is. */
  private async advance(first: LeaseRow, waitS: number): Promise<LeaseReply> {
    const until = Date.now() + waitS * 1000;
    let row = first;
    for (;;) {
      row = this.row(row.id)!;
      if (row.state === 'queued') {
        this.db.prepare('UPDATE leases SET polled_at = ? WHERE id = ?').run(this.now(), row.id);
        this.promote(row.machine, row.id);
        row = this.row(row.id)!;
      }
      if (row.state !== 'queued' || Date.now() >= until) break;
      await sleep(Math.min(500, until - Date.now()));
    }
    return this.reply(row);
  }

  private reply(r: LeaseRow): LeaseReply {
    const lease = leaseName(r.id);
    if (r.state === 'released') {
      return { status: 'released', lease, machine: r.machine, message: `ההזמנה ${lease} (${r.class}) הסתיימה: ${REASON_HE[r.release_reason ?? 'released']}. צריך מקום? \`reserve\` מחדש.` };
    }
    if (r.state === 'granted') {
      const left = Math.max(0, r.timeout_ms - (this.now() - (r.granted_at ?? this.now())));
      return {
        status: 'granted', lease, machine: r.machine, run: `company-run --lease ${lease} -- <הפקודה>`,
        message: `יש מקום ב-${r.machine}: ${lease} (${r.class}, עד ${r.mem_mb}MB זיכרון, ${mins(left)} דקות). מריצים דרך \`company-run --lease ${lease} -- <הפקודה>\`; ההזמנה משתחררת לבד כשהפקודה נגמרת, וגם אפשר \`release\`.`,
      };
    }
    const queue = this.queue(r.machine);
    const position = queue.findIndex((q) => q.id === r.id) + 1;
    const held = this.granted(r.machine);
    const blocker = this.blockedBy(r, held);
    const ahead = queue.slice(0, position - 1);
    const p0Ahead = r.priority > 0 && ahead.some((q) => q.priority === 0);
    const holder = blocker && blocker !== 'budget' ? blocker : null;
    // The wait: until the one that holds frees its place, and a typical run of each who is before.
    const first = holder ? Math.max(0, this.endsAt(holder) - this.now()) : 0;
    const etaMin = mins(first + ahead.reduce((n, q) => n + this.typicalMs(q.class, q.timeout_ms), 0));
    const why = p0Ahead ? 'משימה דחופה (p0) מחכה לפניך ולא עוקפים אותה' : holder ? `מחזיק: ${this.holderText(holder)}` : 'התור שלפניך מחכה';
    return {
      status: 'queued', lease, machine: r.machine, position, eta_min: etaMin, ...(holder ? { holder: this.holderText(holder) } : {}),
      message: `אין מקום ל-${r.class} ב-${r.machine} עכשיו. ${why}. מקום בתור: ${position}. הערכה: כ-${etaMin} דקות. ממשיכים במה שלא תלוי בזה וחוזרים עם \`reserve\` ו-\`lease: "${lease}"\` (שומר לך את המקום בתור; אם לא חוזרים תוך ${ABANDONED_MS / 60_000} דקות הוא מתפנה).`,
    };
  }

  // ── the end of a lease ──────────────────────────────────────────────────────────────────────────────────────

  /** Ends a lease (queued or granted); false when it already ended. Whoever waits behind it is served. */
  end(id: number, reason: Reason, exitCode?: number): boolean {
    const r = this.row(id);
    if (!r || r.state === 'released') return false;
    const now = this.now();
    this.db.prepare(`UPDATE leases SET state = 'released', released_at = ?, release_reason = ?, exit_code = ? WHERE id = ?`).run(now, reason, exitCode ?? null, id);
    this.hq.store.emit('lease.released', r.identity, { lease: leaseName(id), class: r.class, machine: r.machine, reason, held_ms: r.granted_at ? now - r.granted_at : 0, exit_code: exitCode ?? null });
    this.promote(r.machine);
    return true;
  }

  /** A closed shift gives up everything it holds or waits for. */
  releaseShift(shift: string): void {
    const rows = this.db.prepare(`SELECT id FROM leases WHERE shift = ? AND state != 'released'`).all(shift) as { id: number }[];
    for (const r of rows) this.end(r.id, 'shift-ended');
  }

  private releaseCall(b: Record<string, unknown>): LeaseReply {
    const identity = asS(b.identity);
    if (!identity) throw new LeaseError(400, 'release: identity is required');
    const id = this.idOf(b.lease);
    const r = this.row(id);
    if (!r || r.identity !== identity) throw new LeaseError(404, `release: no lease ${b.lease} of ${identity}`);
    const ended = this.end(id, r.state === 'queued' ? 'cancelled' : 'released');
    const note = ended && r.attached_at ? ' company-run עוצר את הפקודה שרצה תחתיה בדקות הקרובות.' : '';
    return { status: 'released', lease: leaseName(id), machine: r.machine, message: ended ? `${leaseName(id)} שוחררה.${note}` : `${leaseName(id)} כבר הסתיימה (${REASON_HE[r.release_reason ?? 'released']}).` };
  }

  // ── company-run ─────────────────────────────────────────────────────────────────────────────────────────────

  /** The lease company-run speaks of. It sends the identity of its shift when it has one (the environment of a shift): another's lease is not found. */
  private ofRun(b: Record<string, unknown>, op: string): LeaseRow {
    const r = this.row(this.idOf(b.lease));
    if (!r || (asS(b.identity) && b.identity !== r.identity)) throw new LeaseError(404, `${op}: no lease ${b.lease}`);
    return r;
  }

  /** company-run takes a granted lease: the ceiling of the scope and the environment of the command. */
  private attach(b: Record<string, unknown>): RunPlan {
    const r = this.ofRun(b, 'attach');
    if (r.state !== 'granted') {
      throw new LeaseError(409, r.state === 'queued' ? `${leaseName(r.id)} עדיין בתור: מחכים ל-granted מ-\`reserve\` לפני company-run` : `${leaseName(r.id)} הסתיימה (${REASON_HE[r.release_reason ?? 'released']}): \`reserve\` מחדש`);
    }
    const now = this.now();
    this.db.prepare('UPDATE leases SET attached_at = COALESCE(attached_at, ?), beat_at = ? WHERE id = ?').run(now, now, r.id);
    const { cls } = this.classOf(r.project, r.class);
    const props = scopeProps({ memMb: r.mem_mb, cpu: r.cpu });
    return { lease: leaseName(r.id), class: r.class, memoryMax: props.memoryMax, cpuWeight: props.cpuWeight, env: cls?.env ?? {}, remainingMs: Math.max(0, r.timeout_ms - (now - (r.granted_at ?? now))) };
  }

  /** A sign of life from company-run, answered with whether the lease still stands. */
  private beat(b: Record<string, unknown>): { state: string; reason?: string; remaining_ms?: number } {
    const r = this.ofRun(b, 'beat');
    if (r.state !== 'granted') return { state: 'released', reason: r.release_reason ?? 'released' };
    const now = this.now();
    this.db.prepare('UPDATE leases SET beat_at = ? WHERE id = ?').run(now, r.id);
    return { state: 'granted', remaining_ms: Math.max(0, r.timeout_ms - (now - (r.granted_at ?? now))) };
  }

  /** The command under company-run ended: the lease is released with its exit code. */
  private finish(b: Record<string, unknown>): { ok: true } {
    const id = this.ofRun(b, 'finish').id;
    this.end(id, 'exited', typeof b.exit_code === 'number' ? b.exit_code : undefined);
    return { ok: true };
  }

  // ── sweep ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Every few seconds: what ran out, what stopped answering, what nobody takes, and then whoever waits is served. */
  sweep(): void {
    const now = this.now();
    // After hq itself was down the beats could not arrive: the clock of a beat starts when hq did.
    for (const r of this.list()) {
      if (r.state === 'queued') {
        if (now - r.polled_at > ABANDONED_MS) this.end(r.id, 'abandoned');
        continue;
      }
      const sh = r.shift ? this.db.prepare('SELECT state FROM shifts WHERE id = ?').get(r.shift) as { state: string } | undefined : undefined;
      if (r.shift && (!sh || sh.state === 'ended' || sh.state === 'dead')) this.end(r.id, 'shift-ended');
      else if (now - (r.granted_at ?? now) > r.timeout_ms) this.timedOut(r);
      else if (r.attached_at && now - Math.max(r.beat_at ?? 0, this.startedAt) > BEAT_LOST_MS) this.end(r.id, 'connection-lost');
      else if (!r.attached_at && now - (r.granted_at ?? now) > UNCLAIMED_MS) this.end(r.id, 'unclaimed');
    }
    for (const m of this.machines()) this.promote(m);
  }

  private timedOut(r: LeaseRow): void {
    if (!this.end(r.id, 'timeout')) return;
    this.hq.mailbox.tell({
      msg_id: `lease-${r.id}-timeout`, from: 'hq', to: r.identity, kind: 'system', priority: 'next',
      body: `ההזמנה ${leaseName(r.id)} (${r.class}) עברה את התקרה של ${mins(r.timeout_ms)} דקות ושוחררה, כדי שמי שמחכה יקבל מקום. ` +
        `${r.attached_at ? 'company-run עוצר את הפקודה שרצה תחתיה. ' : ''}צריך עוד זמן? \`reserve\` מחדש.`,
    });
  }
}
