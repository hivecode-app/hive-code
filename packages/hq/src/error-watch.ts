// error-catcher (22/10/2026): every error he would see, caught here and brought to him one at a time. He said «לבנות,
// אבל עם אישור שלי לכל תקלה», so nothing opens by itself: each new signature is one ask in "מחכה לך" with "לטפל" /
// "לא עכשיו", one line in his words (what, how many times, where). It happens again: the count on that same item goes
// up. "לטפל" opens a task in agent-company under the automation's owner (adi) with the brief: the signature, three
// examples and the events around the last one. "לא עכשיו" (or closing the card) mutes it for MUTE_MS.
// The events read (store `events`, from a cursor): turn.error, message.undelivered, api.5xx, client.error (the app,
// POST /api/client-errors) open from one; hq's internal failures (loop.error and the like) only from INTERNAL_MIN in
// a WINDOW_MS. Known ones that are not bugs (a rate limit, a closed task) are counted only. A signature waits FIRST_WAIT_MS
// before it is asked, so a series arrives as one. More than STORM new signatures in a WINDOW_MS is one thing, not
// twenty: one message to the monitoring lead, nothing asked. The automation is `error-catcher` in org.yaml; off, the
// counting goes on and nothing is asked.
import { createHash } from 'node:crypto';
import type { HqEvent } from '@company/shared';
import type { Hq } from './hq.ts';
import { hhmm } from './timezone.ts';

export const AUTOMATION = 'error-catcher';
/** The project its tasks open in. */
export const PROJECT = 'agent-company';
export const WINDOW_MS = 10 * 60_000;
export const FIRST_WAIT_MS = 2 * 60_000;
export const MUTE_MS = 24 * 3_600_000;
/** More new signatures than this in a WINDOW_MS: a storm. */
export const STORM = 20;
/** hq's own failures he doesn't see: this many in a WINDOW_MS before they count. */
export const INTERNAL_MIN = 2;
export const HANDLE = 'לטפל';
export const NOT_NOW = 'לא עכשיו';
const AROUND = 10;
const EXAMPLES = 3;

/** The errors he sees: one is enough. */
const SHOWN = new Set(['turn.error', 'message.undelivered', 'api.5xx', 'client.error']);
/** hq's own failures: only from INTERNAL_MIN in a window. */
const INTERNAL = new Set(['loop.error', 'shift.launch_failed', 'shift.restore_failed', 'scheduler.start_failed',
  'watchdog.resurrect_failed', 'task.worktree_close_failed', 'push.failed']);
export const WATCHED = [...SHOWN, ...INTERNAL];

/** Known and not a bug of ours: counted, never asked. */
const KNOWN: { type?: string; re: RegExp }[] = [
  { re: /rate.?limit|usage limit|limit reached|hit your (?:[a-z]+ )?limit\b|\b429\b|overloaded|\b529\b|credit balance/i },
  { re: /interrupted|aborted by user|request was aborted/i },
  { type: 'message.undelivered', re: /המשימה כבר נסגרה/ },
];

/** One error, out of an event. */
export interface Caught { type: string; component: string; message: string; identity: string | null }

const s = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

export function caught(e: Pick<HqEvent, 'type' | 'identity' | 'data'>): Caught | null {
  const d = (e.data ?? {}) as Record<string, unknown>;
  const id = e.identity ?? null;
  switch (e.type) {
    case 'turn.error': return { type: e.type, component: s(d.identity) || s(id), message: s(d.text) || s(d.subtype), identity: id };
    case 'message.undelivered': return { type: e.type, component: s(d.to) || s(id), message: s(d.why), identity: id };
    case 'api.5xx': return { type: e.type, component: `${s(d.method)} ${s(d.route)}`, message: s(d.error), identity: null };
    case 'client.error': return { type: e.type, component: s(d.screen), message: s(d.message), identity: null };
    case 'loop.error':
      // Its own failures are not watched: an error here must not feed itself.
      if (d.loop === AUTOMATION) return null;
      return { type: e.type, component: s(d.loop), message: s(d.error), identity: id };
    case 'push.failed': return { type: e.type, component: 'push', message: JSON.stringify(d.errors ?? '').slice(0, 300), identity: id };
    default:
      if (!INTERNAL.has(e.type)) return null;
      return { type: e.type, component: s(id), message: s(d.error) || s(d.why), identity: id };
  }
}

/** The same error with other ids, numbers, paths and times reads the same. */
export function normalize(msg: string): string {
  return msg
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/[\w.-]+:[a-z0-9]{6,}-[0-9a-z]{6,}(-[\w-]+)?/gi, '<msg>')
    .replace(/(^|[\s('"`=])(~|\.{0,2})\/[^\s'"`)]+/g, '$1<path>')
    .replace(/\bt\d+\b/g, 't#')
    .replace(/-t\d+(-\d+)?\b/g, '-t#')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** A route with its ids taken out: /api/inbox/12/ack → /api/inbox/:id/ack. */
export function normalizePath(path: string): string {
  return (path.split('?')[0] ?? '').split('/').map((p) => (/\d/.test(p) && p.length > 0 ? ':id' : p)).join('/');
}

export function signature(c: Pick<Caught, 'type' | 'component' | 'message'>): string {
  return createHash('sha1').update(`${c.type}|${normalize(c.component)}|${normalize(c.message)}`).digest('hex');
}

export function known(c: Pick<Caught, 'type' | 'message'>): boolean {
  return KNOWN.some((k) => (!k.type || k.type === c.type) && k.re.test(c.message));
}

type State = 'idle' | 'pending' | 'asked' | 'handling' | 'done' | 'muted' | 'known';
export interface SigRow {
  sig: string; type: string; component: string; message: string; state: State; count: number; cycle_count: number;
  first_seen: number; last_seen: number; cycle_start: number; pending_since: number | null; window_start: number; window_count: number;
  ask_id: string | null; shown_count: number; task_id: number | null; muted_until: number | null; returned: number;
  examples: string; identity: string | null; answer: string | null;
}
interface Example { seq: number; ts: number; identity: string | null; data: unknown }

const CURSOR = 'error_watch.seq';
const STORM_AT = 'error_watch.storm_at';

export class ErrorWatch {
  private hq: Hq;
  constructor(hq: Hq) {
    this.hq = hq;
    // His answer acts at once, not on the next sweep.
    hq.store.onEvent((e) => {
      // After the write that told it (closing a card resolves the item before it cancels the ask).
      if ((e.type === 'ask.answered' || e.type === 'inbox.resolved') && this.ours(e)) queueMicrotask(() => hq.store.bg(this.answers(), 'error-watch.answers'));
    });
  }

  private get db() { return this.hq.store.db; }
  private get now() { return this.hq.store.now(); }

  private ours(e: HqEvent): boolean {
    const d = e.data as { id?: unknown } | null;
    if (e.type === 'ask.answered') return typeof d?.id === 'string' && d.id.startsWith('err-');
    return !!this.db.prepare(`SELECT 1 FROM inbox WHERE id = ? AND kind = 'ask' AND ref LIKE 'err-%'`).get(Number(d?.id));
  }

  /** The identity whose org.yaml automations hold `error-catcher`; null = no such automation. */
  owner(): string | null {
    const r = this.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(AUTOMATION.length + 1)) : null;
  }

  enabled(): boolean {
    const o = this.owner();
    return !!o && this.hq.store.toggle(`${o}/${AUTOMATION}`);
  }

  get(sig: string): SigRow | undefined {
    return this.db.prepare('SELECT * FROM error_signatures WHERE sig = ?').get(sig) as SigRow | undefined;
  }

  async sweep(): Promise<void> {
    this.collect();
    await this.answers();
    this.closed();
    this.ask();
    this.recount();
  }

  /** The new events since the cursor, into their signatures. The first run starts from now: history is not news. */
  collect(): void {
    const max = (this.db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM events').get() as { m: number }).m;
    const at = this.hq.store.getMeta(CURSOR);
    if (at == null) { this.hq.store.setMeta(CURSOR, String(max)); return; }
    let cursor = Number(at);
    const marks = WATCHED.map(() => '?').join(',');
    for (;;) {
      const rows = this.db.prepare(`SELECT seq, ts, type, identity, data FROM events WHERE seq > ? AND type IN (${marks}) ORDER BY seq LIMIT 500`)
        .all(cursor, ...WATCHED) as { seq: number; ts: number; type: string; identity: string | null; data: string }[];
      if (!rows.length) break;
      this.db.transaction(() => {
        for (const r of rows) {
          let data: unknown = null;
          try { data = JSON.parse(r.data); } catch { /* kept as null */ }
          const c = caught({ type: r.type, identity: r.identity, data });
          if (c) this.seen(c, { seq: r.seq, ts: r.ts, identity: r.identity, data });
          cursor = r.seq;
        }
        this.hq.store.setMeta(CURSOR, String(cursor));
      })();
    }
    if (cursor < max) this.hq.store.setMeta(CURSOR, String(max));
  }

  /** One occurrence. */
  seen(c: Caught, ex: Example): void {
    const sig = signature(c);
    const r = this.get(sig);
    const isKnown = known(c);
    if (!r) {
      const pending = !isKnown && threshold(c.type) <= 1;
      this.db.prepare(`INSERT INTO error_signatures (sig, type, component, message, state, count, cycle_count, first_seen, last_seen,
        cycle_start, pending_since, window_start, window_count, examples, identity) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(sig, c.type, c.component, c.message.slice(0, 1000), isKnown ? 'known' : pending ? 'pending' : 'idle', ex.ts, ex.ts, ex.ts,
          pending ? ex.ts : null, ex.ts, JSON.stringify([ex]), c.identity);
      this.hq.store.emit('error.caught', c.identity, { sig, type: c.type, component: c.component, known: isKnown, new: true });
      return;
    }
    const inWindow = ex.ts - r.window_start < WINDOW_MS;
    const windowStart = inWindow ? r.window_start : ex.ts;
    const windowCount = inWindow ? r.window_count + 1 : 1;
    const examples = (JSON.parse(r.examples) as Example[]);
    // The first ones, and always the latest: the events around it go into the brief.
    const next = examples.length < EXAMPLES ? [...examples, ex] : [...examples.slice(0, EXAMPLES - 1), ex];
    let state = r.state;
    let cycle = r.cycle_count + 1;
    let pendingSince = r.pending_since;
    let cycleStart = r.cycle_start;
    let returned = r.returned;
    // Quiet until now (new under the threshold, muted and over, its task done): enough in the window starts a new round,
    // counted from the window. Below it, it stays as it was.
    const wakes = state === 'idle' || (state === 'muted' && (r.muted_until ?? 0) <= ex.ts) || state === 'done';
    if (wakes && windowCount >= threshold(r.type)) {
      if (state !== 'idle') { cycle = windowCount; cycleStart = windowStart; returned = state === 'done' ? 1 : 0; }
      state = 'pending';
      pendingSince = ex.ts;
    }
    this.db.prepare(`UPDATE error_signatures SET count = count + 1, cycle_count = ?, last_seen = ?, window_start = ?, window_count = ?,
      examples = ?, state = ?, pending_since = ?, cycle_start = ?, returned = ? WHERE sig = ?`)
      .run(cycle, ex.ts, windowStart, windowCount, JSON.stringify(next), state, pendingSince, cycleStart, returned, sig);
    this.hq.store.emit('error.caught', c.identity, { sig, type: c.type, component: c.component, known: state === 'known', new: false });
  }

  /** Pending past the first wait: asked, one at a time, or (a storm) all at once to the monitoring lead. */
  private ask(): void {
    const now = this.now;
    const ready = this.db.prepare(`SELECT * FROM error_signatures WHERE state = 'pending' AND pending_since <= ? ORDER BY pending_since`)
      .all(now - FIRST_WAIT_MS) as SigRow[];
    if (!ready.length) return;
    if (!this.enabled()) {
      // Off: counted, never asked. The next one after it is switched back on starts a round.
      this.db.prepare(`UPDATE error_signatures SET state = 'muted', muted_until = ? WHERE state = 'pending' AND pending_since <= ?`).run(now, now - FIRST_WAIT_MS);
      return;
    }
    // A storm already called in this window takes what comes after it too. The count includes what a storm muted.
    const stormed = now - Number(this.hq.store.getMeta(STORM_AT) ?? 0) < WINDOW_MS;
    const fresh = (this.db.prepare(`SELECT COUNT(*) n FROM error_signatures WHERE pending_since >= ? AND state NOT IN ('idle','known')`)
      .get(now - WINDOW_MS) as { n: number }).n;
    if (stormed || fresh > STORM) return this.storm(now);
    for (const r of ready) {
      const id = `err-${r.sig.slice(0, 10)}-${now}`;
      this.db.prepare(`UPDATE error_signatures SET state = 'asked', ask_id = ?, shown_count = cycle_count, answer = NULL WHERE sig = ?`).run(id, r.sig);
      const row = this.get(r.sig)!;
      // The card (design review, #207): the title carries how many times and since when, the headline what and where;
      // the error's own words are in the details.
      this.hq.mailbox.ask({ msg_id: id, from: 'hq', title: this.title(row), question: this.line(row), headline: clip(what(row, this.label, false), 80),
        options: [HANDLE, NOT_NOW], blocking: false, urgency: 'normal' });
      this.hq.store.emit('error.asked', r.identity, { sig: r.sig, ask: id, count: row.cycle_count });
    }
  }

  /** More than STORM new signatures in a window: one message to the monitoring lead, nothing asked. */
  private storm(now: number): void {
    // A storm that built up slowly: what was asked in its window and he hasn't answered is taken back, into the one message.
    const rows = this.db.prepare(`SELECT s.* FROM error_signatures s LEFT JOIN asks a ON a.id = s.ask_id WHERE s.state = 'pending'
      OR (s.state = 'asked' AND s.pending_since >= ? AND a.state IN ('open','escalated')) ORDER BY s.cycle_count DESC`).all(now - WINDOW_MS) as SigRow[];
    for (const r of rows) {
      // Muted first: the card closing below must not read as his "לא עכשיו".
      this.db.prepare(`UPDATE error_signatures SET state = 'muted', muted_until = ?, ask_id = NULL WHERE sig = ?`).run(now + WINDOW_MS, r.sig);
      if (r.state !== 'asked' || !r.ask_id) continue;
      this.db.prepare(`UPDATE asks SET state = 'cancelled', answered_at = ? WHERE id = ? AND state IN ('open','escalated')`).run(now, r.ask_id);
      this.hq.inbox.resolveByRef('ask', r.ask_id, 'dismissed');
    }
    const last = Number(this.hq.store.getMeta(STORM_AT) ?? 0);
    if (now - last < WINDOW_MS) return;
    this.hq.store.setMeta(STORM_AT, String(now));
    const to = this.hq.cfg.monitoringLeadId || this.hq.cfg.managerId;
    const top = rows.slice(0, 5).map((r) => `- ${clip(what(r, this.label), 140)} (${r.cycle_count})`).join('\n');
    this.hq.mailbox.tell({ msg_id: `error-storm-${now}`, from: 'hq', to, kind: 'system', priority: 'next',
      body: `הרבה תקלות יחד: ${rows.length} חתימות שגיאה חדשות ב-${WINDOW_MS / 60_000} הדקות האחרונות, כנראה משהו גדול נפל. `
        + `${this.hq.mailbox.names.owner.name} לא נשאל עליהן אחת-אחת. הבולטות:\n${top}\n`
        + 'ה-events המלאים ב-`GET /api/events` (type `error.caught`) ובטבלה `error_signatures`.' });
    this.hq.store.emit('error.storm', null, { count: rows.length, to });
  }

  /** His answers: "לטפל" opens the task, "לא עכשיו" or closing the card mutes it for MUTE_MS. */
  async answers(): Promise<void> {
    const rows = this.db.prepare(`SELECT s.*, a.state ask_state, a.answer ask_answer FROM error_signatures s JOIN asks a ON a.id = s.ask_id
      WHERE s.state = 'asked' AND a.state IN ('answered','cancelled')`).all() as (SigRow & { ask_state: string; ask_answer: string | null })[];
    for (const r of rows) {
      const answer = (r.ask_answer ?? '').trim();
      // Only "לטפל" (or his words that say so) opens a task. "לא עכשיו", "אל תטפל", "סיימתי" on the card, "תתעלם", closing it: muted.
      if (r.ask_state === 'cancelled' || !wantsHandling(answer)) { this.mute(r.sig, r.ask_state === 'cancelled' ? 'closed' : 'not_now'); continue; }
      this.handle(r, answer === HANDLE ? '' : answer);
    }
  }

  mute(sig: string, why: string): void {
    const until = this.now + MUTE_MS;
    this.db.prepare(`UPDATE error_signatures SET state = 'muted', muted_until = ?, ask_id = NULL WHERE sig = ?`).run(until, sig);
    this.hq.store.emit('error.muted', null, { sig, until, why });
  }

  private handle(r: SigRow, words: string): void {
    const opener = this.owner() ?? this.hq.cfg.managerId;
    const task = this.hq.scheduler.addTask({ title: clip(`תקלה: ${what(r, this.label)}`, 120), body: this.brief(r, words),
      project: PROJECT, ref: `error:${r.sig.slice(0, 12)}:${r.ask_id ?? this.now}`, labels: [`opened-by:${opener}`, 'error-catcher'] });
    this.db.prepare(`UPDATE error_signatures SET state = 'handling', task_id = ?, answer = ? WHERE sig = ?`).run(task.id, words || HANDLE, r.sig);
    this.hq.store.emit('error.handling', null, { sig: r.sig, task: task.id });
  }

  /** Its task closed: the next time it happens, it came back. */
  private closed(): void {
    this.db.prepare(`UPDATE error_signatures SET state = 'done' WHERE state = 'handling'
      AND task_id IN (SELECT id FROM tasks WHERE state IN ('done','closed'))`).run();
  }

  /** It happened again while he hasn't answered: the same item, the new count. */
  private recount(): void {
    const rows = this.db.prepare(`SELECT s.* FROM error_signatures s JOIN asks a ON a.id = s.ask_id
      WHERE s.state = 'asked' AND a.state IN ('open','escalated') AND s.cycle_count != s.shown_count`).all() as SigRow[];
    for (const r of rows) {
      const line = this.line(r);
      this.db.prepare('UPDATE asks SET question = ? WHERE id = ?').run(line, r.ask_id);
      this.db.prepare('UPDATE error_signatures SET shown_count = cycle_count WHERE sig = ?').run(r.sig);
      this.hq.inbox.updateByRef('ask', r.ask_id!, { body: line, title: this.title(r) });
    }
  }

  private label = (id: string): string => this.hq.mailbox.label(id);

  /** The card's title: "תפסתי תקלה · 3 פעמים מ-13:40", or once: "תפסתי תקלה · 13:40". */
  title(r: SigRow): string {
    const tz = this.hq.timeZone();
    return `תפסתי תקלה · ${r.cycle_count === 1 ? hhmm(r.last_seen, tz) : `${r.cycle_count} פעמים מ-${hhmm(firstOfCycle(r), tz)}`}`;
  }

  /** One line in his words: what, how many times, where. */
  line(r: SigRow): string {
    const tz = this.hq.timeZone();
    const times = r.cycle_count === 1 ? `פעם אחת, ב-${hhmm(r.last_seen, tz)}` : `${r.cycle_count} פעמים, מ-${hhmm(firstOfCycle(r), tz)} עד ${hhmm(r.last_seen, tz)}`;
    return `${r.returned ? 'חזרה אחרי שטופלה: ' : ''}${what(r, this.label)}. ${times}, ${where(r, this.label)}.`;
  }

  /** The brief of the task: the signature, the examples, and the events around the last one. */
  brief(r: SigRow, words: string): string {
    const tz = this.hq.timeZone();
    const examples = JSON.parse(r.examples) as Example[];
    const last = examples.at(-1);
    const around = last ? this.around(last) : [];
    return [
      `${this.hq.mailbox.names.owner.name} ביקש לטפל בתקלה שנתפסה (error-catcher): ${this.line(r)}`,
      words ? `\nמה הוא כתב: «${words}»` : '',
      '',
      `- חתימה: \`${r.sig}\` (\`${r.type}\` · \`${r.component}\`)`,
      `- בסך הכול ${r.count} פעמים, ראשונה ${hhmm(r.first_seen, tz)}, אחרונה ${hhmm(r.last_seen, tz)}`,
      `- ההודעה המנורמלת: \`${normalize(r.message)}\``,
      '',
      'דוגמאות (גולמי):',
      ...examples.map((e) => `- seq ${e.seq} · ${hhmm(e.ts, tz)}${e.identity ? ` · ${e.identity}` : ''}: \`${clip(JSON.stringify(e.data), 600)}\``),
      '',
      `${around.length} ה-events סביב האחרונה${last?.identity ? ` (של ${last.identity})` : ''}:`,
      ...around.map((e) => `- ${e.seq === last?.seq ? '**' : ''}${e.seq} ${hhmm(e.ts, tz)} ${e.type}${e.seq === last?.seq ? '**' : ''}: \`${clip(e.data, 200)}\``),
      '',
      'מה עושים: משחזרים, מתקנים ב-PR (סקירה, CI), ומדווחים. אם זה לא באג שלנו (מכסה נגמרה, תקלה אצל ספק), '
        + 'סוגרים עם הסבר בשורה אחת, ואם צריך מוסיפים אותה לרשימת "ידועות ולא באג" ב-`packages/hq/src/error-watch.ts`.',
    ].filter((l, i, a) => l !== '' || a[i - 1] !== '').join('\n');
  }

  private around(ex: Example): { seq: number; ts: number; type: string; data: string }[] {
    const by = ex.identity ? 'AND identity = ?' : '';
    const args = ex.identity ? [ex.identity] : [];
    const before = this.db.prepare(`SELECT seq, ts, type, data FROM events WHERE seq <= ? AND type != 'engine.delta' ${by} ORDER BY seq DESC LIMIT ?`)
      .all(ex.seq, ...args, AROUND + 1) as { seq: number; ts: number; type: string; data: string }[];
    const after = this.db.prepare(`SELECT seq, ts, type, data FROM events WHERE seq > ? AND type != 'engine.delta' ${by} ORDER BY seq LIMIT ?`)
      .all(ex.seq, ...args, AROUND) as { seq: number; ts: number; type: string; data: string }[];
    return [...before.reverse(), ...after];
  }
}

/** His answer says to handle it: a word "טפל" / "לטפל" / "תטפל" / "לתקן" / "תתקן" (not "אטפל", "אתקן": he does it himself),
 *  "שתטפל", "תתקנו", or "כן" as the whole answer ("כן בבקשה"), with no "לא" / "אל" / "אין" / "בלי" / "אסור" (with ו/ש in front: "ולא", "שלא") before it in the
 *  same clause ("אל תטפל", "עדיף שלא לטפל"). A no in an earlier clause ("אין בעיה, תטפל") or after it ("לטפל, לא דחוף") is
 *  about something else. */
export function wantsHandling(answer: string): boolean {
  const a = answer.trim();
  if (/^כן([\s,.!]*(כן|בבקשה|תודה))*[\s.!]*$/u.test(a)) return true;
  const m = /(^|[^\p{L}])[וש]?[לת]?(טפל|תק[ןנ])/u.exec(a);
  if (!m) return false;
  const clause = a.slice(0, m.index + m[1]!.length).split(/[,.;:!?\n]/).at(-1) ?? '';
  return !/(^|[^\p{L}])[וש]?(לא|אל|אין|בלי|אסור)(?!\p{L})/u.test(clause);
}

function threshold(type: string): number { return INTERNAL.has(type) ? INTERNAL_MIN : 1; }

function firstOfCycle(r: SigRow): number { return r.cycle_start; }

/** What happened, in his words. */
/** [quote]: with the error's own words («…»); the card's headline leaves them to the details. */
export function what(r: Pick<SigRow, 'type' | 'component' | 'message'>, label: (id: string) => string, quote = true): string {
  const msg = quote && r.message ? ` «${clip(r.message, 100)}»` : '';
  switch (r.type) {
    case 'turn.error': return `סבב של ${label(r.component)} נגמר בשגיאה${msg}`;
    case 'message.undelivered': return `הודעה ל${label(r.component)} לא נמסרה${msg}`;
    case 'api.5xx': return `השרת נכשל בבקשה \`${r.component}\`${msg}`;
    case 'client.error': return `שגיאה באפליקציה${r.component ? ` במסך ${r.component}` : ''}${msg}`;
    case 'loop.error': return `תקלה פנימית ב-hq בלולאה \`${r.component}\`${msg}`;
    default: return `תקלה ב-hq (\`${r.type}\`${r.component ? ` · ${label(r.component)}` : ''})${msg}`;
  }
}

function where(r: Pick<SigRow, 'type' | 'component'>, label: (id: string) => string): string {
  switch (r.type) {
    case 'turn.error': return `בשיחה עם ${label(r.component)}`;
    case 'message.undelivered': return 'במסירת הודעות';
    case 'api.5xx': return 'בשרת (hq)';
    case 'client.error': return 'באפליקציה בטלפון';
    default: return 'בתוך hq';
  }
}

function clip(t: string, n: number): string {
  const one = t.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}
