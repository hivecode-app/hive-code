// B.7 accounts manager (issue #25, minimal scope). Two accounts: the CLI's own ~/.claude login (never
// written by us, dir-0016) and hive-owner in a managed config dir under state/accounts/<name>, which
// shares projects/sessions with ~/.claude through symlinks so --resume works across accounts.
//  - guided login: hq runs `claude auth login` for the managed dir and asks him (an hq ask) to open the
//    link and paste the code back; then the identity check (/api/oauth/profile) accepts or rejects it;
//  - quota: get_usage per account (no inference) + every rate_limit_event from the shifts;
//  - placement: a new run goes to the account with the most room; ties → the week that resets first;
//  - automatic switch: rate_limit rejected → stop the shift and resume the same session on the other account;
//  - "כולם ל-X": pinned account for new runs; live shifts move at their next turn boundary.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { g, OWNER, type LoggedFrame, type UsageReply } from '@company/shared';
import type { AccountDef, HqConfig } from './config.ts';
import type { Store } from './store.ts';
import type { AccountChoice, ShiftManager, ShiftRow } from './shifts.ts';
import type { Mailbox } from './mailbox.ts';
import type { Inbox } from './inbox.ts';
import { readTimeZone, whenLocal } from './timezone.ts';

export interface Profile { email: string; accountUuid: string | null; org: string | null; plan: string | null }

/** A running `claude auth login`: the link to open, and where the pasted code goes. */
export interface LoginProcess {
  url: Promise<string>;
  submit(code: string): void;
  done: Promise<number | null>;
  kill(): void;
}

export interface AccountDeps {
  usage?: (a: AccountChoice) => Promise<UsageReply>;
  /** configDir null = the owner's ~/.claude (read-only). */
  profile?: (configDir: string | null) => Promise<Profile>;
  login?: (configDir: string, email?: string) => LoginProcess | Promise<LoginProcess>;
}

export interface AccountRow {
  name: string; label: string; expect: string; config_dir: string | null; email: string | null; org: string | null;
  plan: string | null; account_uuid: string | null; health: string; note: string | null; verified_at: number | null;
  five_hour_pct: number | null; seven_day_pct: number | null; five_hour_resets_at: number | null;
  seven_day_resets_at: number | null; snapshot_at: number | null; blocked_until: number | null;
}

/** Directories every account shares with ~/.claude: transcripts (resume), live sessions (ListAgents), skills,
 *  hooks, agents. Not settings.json or CLAUDE.md: shifts load only project,local + the generated --settings and
 *  exclude ~/.claude/CLAUDE.md on purpose (adapter/spec.ts), so they behave the same on either account. */
const SHARED = ['projects', 'sessions', 'skills', 'file-history', 'hooks', 'agents'];
const PIN_KEY = 'accounts.pinned';
const LOGIN_TTL_MS = 12 * 3600_000;
/** "All accounts full" (23/10: both at 100% weekly, the company stood ~36 hours and nobody told him): one item, by ref. */
export const ALL_FULL_REF = 'accounts-all-full';
const ALL_FULL_META = 'accounts.all_full_since';

const QUOTA_FAILED = 'קריאת מכסה נכשלה:';
const ms = (iso?: string): number | null => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const toMs = (sec?: number): number | null => (typeof sec === 'number' ? sec * (sec < 1e12 ? 1000 : 1) : null);

export function matchesExpect(email: string, expect: string): boolean {
  const e = email.trim().toLowerCase(), x = expect.trim().toLowerCase();
  return x.includes('@') ? e === x : e.split('@')[0] === x;
}

export class AccountManager {
  private store: Store;
  private cfg: HqConfig;
  private shifts: ShiftManager;
  private mailbox: Mailbox;
  private inbox: Inbox;
  private deps: Required<AccountDeps>;
  private pending = new Map<string, { lp: LoginProcess; askId: string; timer: NodeJS.Timeout; tries: number }>();
  private moving = new Set<string>();
  private starting = new Set<string>();

  constructor(store: Store, cfg: HqConfig, shifts: ShiftManager, mailbox: Mailbox, inbox: Inbox, deps: AccountDeps = {}) {
    this.store = store;
    this.cfg = cfg;
    this.shifts = shifts;
    this.mailbox = mailbox;
    this.inbox = inbox;
    this.deps = {
      usage: deps.usage ?? defaultUsage(cfg),
      profile: deps.profile ?? ((dir) => readProfile(dir, cfg.claudeHome)),
      // The pinned Claude Code (B.6), same binary the shifts run.
      login: deps.login ?? (async (dir, email) => {
        const { resolveClaudeBin } = (await import('@company/adapter' as string)) as { resolveClaudeBin: () => string };
        return spawnLogin(dir, email, resolveClaudeBin());
      }),
    };
    shifts.chooseAccount = (_identity, want) => {
      const r = this.pick(want);
      return r ? { name: r.name, configDir: r.config_dir } : null;
    };
    // Replayed frames (reattach after an hq restart) are history, not a reason to switch now.
    shifts.on('frame', (row: ShiftRow, f: LoggedFrame, live?: boolean) => this.onFrame(row, f, live !== false));
    mailbox.onHqAnswer = (askId, answer) => {
      for (const [name, p] of this.pending) if (p.askId === askId) this.store.bg(this.onCode(name, answer), 'accounts.login');
    };
  }

  // ── registry ─────────────────────────────────────────────────────────────
  private def(name: string): AccountDef | undefined { return this.cfg.accounts.find((a) => a.name === name); }
  private dirOf(d: AccountDef): string | null { return d.managed ? join(this.cfg.stateDir, 'accounts', d.name) : null; }
  private get primary(): string { return this.cfg.accounts.find((a) => !a.managed)?.name ?? this.cfg.accounts[0]?.name ?? ''; }

  /** Upsert the configured accounts. A managed one without credentials waits for a login. */
  sync(): void {
    for (const d of this.cfg.accounts) {
      const dir = this.dirOf(d);
      this.store.db.prepare(`INSERT INTO accounts (name, label, expect, config_dir, health) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET label = excluded.label, expect = excluded.expect, config_dir = excluded.config_dir`)
        .run(d.name, d.label, d.expect, dir, dir && !existsSync(join(dir, '.credentials.json')) ? 'needs_login' : 'unknown');
    }
    // A row no longer in hq.config.json (the default `claude` of before the accounts were configured) is not an
    // account: it would show as capacity anywhere that reads the table.
    const names = this.cfg.accounts.map((a) => a.name);
    if (names.length) this.store.db.prepare(`DELETE FROM accounts WHERE name NOT IN (${names.map(() => '?').join(',')})`).run(...names);
    // A login ask from before a restart has no `claude auth login` behind it any more: close it, don't let a code vanish.
    const stale = this.store.db.prepare(`SELECT id FROM asks WHERE from_identity = 'hq' AND id LIKE 'account-login-%' AND state IN ('open','escalated')`).all() as { id: string }[];
    for (const { id } of stale) {
      if ([...this.pending.values()].some((p) => p.askId === id)) continue;
      this.store.db.prepare(`UPDATE asks SET state = 'cancelled', answered_at = ? WHERE id = ?`).run(this.store.now(), id);
      this.inbox.resolveByRef('ask', id, 'dismissed');
    }
  }

  get(name: string): AccountRow | undefined {
    return this.store.db.prepare('SELECT * FROM accounts WHERE name = ?').get(name) as AccountRow | undefined;
  }

  rows(): AccountRow[] {
    const names = this.cfg.accounts.map((a) => a.name);
    return (this.store.db.prepare('SELECT * FROM accounts').all() as AccountRow[])
      .filter((r) => names.includes(r.name)).sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name));
  }

  private set(name: string, f: Partial<AccountRow>): void {
    const keys = Object.keys(f);
    if (!keys.length) return;
    this.store.db.prepare(`UPDATE accounts SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE name = @name`).run({ ...f, name });
    this.store.emit('account.changed', null, { name, ...f });
  }

  // ── placement ────────────────────────────────────────────────────────────
  /** The CLI's own login is always usable (it is what every shift ran on before); a managed one only once verified.
   *  Never a duplicate: the same Claude account twice is one account's quota, not two. */
  usable(r: AccountRow, rows?: AccountRow[]): boolean { return (r.config_dir == null || r.health === 'ok') && !this.duplicateOf(r, rows); }
  /** The account registered earlier (hq.config.json order) with the same account_uuid; the first one is the real one. */
  duplicateOf(r: Pick<AccountRow, 'name' | 'account_uuid'>, rows = this.rows()): AccountRow | undefined {
    if (!r.account_uuid) return undefined;
    const i = rows.findIndex((o) => o.name === r.name);
    return rows.slice(0, i < 0 ? rows.length : i).find((o) => o.account_uuid === r.account_uuid);
  }
  blocked(r: AccountRow): boolean { return r.blocked_until != null && r.blocked_until > this.store.now(); }
  /** Percent left in the tighter window. Unknown counts as full: no percentage ever stops work (dir-0003). */
  room(r: AccountRow): number { return 100 - Math.max(r.five_hour_pct ?? 0, r.seven_day_pct ?? 0); }

  pinned(): string | null { return this.store.getMeta(PIN_KEY) || null; }

  /** A window at 100% counts while its reset is ahead; a rejection counts until blocked_until. */
  full(r: AccountRow): boolean {
    const now = this.store.now();
    const at100 = (pct: number | null, reset: number | null) => (pct ?? 0) >= 100 && (reset == null || reset > now);
    return this.blocked(r) || at100(r.five_hour_pct, r.five_hour_resets_at) || at100(r.seven_day_pct, r.seven_day_resets_at);
  }

  /** When a full account takes work again (the latest of what holds it); null = unknown, or not full. */
  reopensAt(r: AccountRow): number | null {
    const now = this.store.now();
    const t = [this.blocked(r) ? r.blocked_until : null,
      (r.five_hour_pct ?? 0) >= 100 ? r.five_hour_resets_at : null,
      (r.seven_day_pct ?? 0) >= 100 ? r.seven_day_resets_at : null].filter((x): x is number => x != null && x > now);
    return t.length ? Math.max(...t) : null;
  }

  /** The accounts that are capacity: configured, connected, not a duplicate. */
  capacity(): AccountRow[] { const rows = this.rows(); return rows.filter((r) => this.usable(r, rows)); }

  /** Every account the company can run on is full: nothing starts until one resets. */
  allFull(): boolean { const c = this.capacity(); return c.length > 0 && c.every((r) => this.full(r)); }

  pick(want?: string): AccountRow | null {
    const all = this.capacity();
    if (want) { const w = all.find((r) => r.name === want); if (w) return w; }
    const open = all.filter((r) => !this.blocked(r));
    const pin = open.find((r) => r.name === this.pinned());
    if (pin) return pin;
    if (!open.length) return [...all].sort((a, b) => (a.blocked_until ?? 0) - (b.blocked_until ?? 0))[0] ?? null;
    return [...open].sort((a, b) => this.room(b) - this.room(a)
      || (a.seven_day_resets_at ?? Infinity) - (b.seven_day_resets_at ?? Infinity))[0]!;
  }

  view() {
    const active = this.pick()?.name ?? null;
    const counts = new Map<string, number>();
    for (const s of this.shifts.active()) if (s.kind !== 'foreign') counts.set(s.account ?? this.primary, (counts.get(s.account ?? this.primary) ?? 0) + 1);
    const rows = this.rows();
    return {
      pinned: this.pinned(), active,
      accounts: rows.map((r) => ({
        name: r.name, label: r.label, email: r.email, plan: r.plan, health: r.health, note: r.note, verified_at: r.verified_at,
        managed: r.config_dir != null, usable: this.usable(r, rows), blocked_until: this.blocked(r) ? r.blocked_until : null,
        duplicate_of: this.duplicateOf(r, rows)?.name ?? null,
        five_hour_pct: r.five_hour_pct, seven_day_pct: r.seven_day_pct, five_hour_resets_at: r.five_hour_resets_at,
        seven_day_resets_at: r.seven_day_resets_at, snapshot_at: r.snapshot_at, room: this.room(r), shifts: counts.get(r.name) ?? 0,
        login_pending: this.pending.has(r.name),
      })),
    };
  }

  /** "כולם ל-X" (null = automatic). New runs go to X; idle shifts move now, busy ones at their next turn boundary. */
  setPinned(name: string | null): void {
    if (name) {
      const r = this.get(name);
      if (!r || !this.def(name)) throw new Error(`אין חשבון ${name}`);
      const dup = this.duplicateOf(r);
      if (dup) throw new Error(`${r.label} הוא אותו חשבון כמו ${dup.label}`);
      if (!this.usable(r)) throw new Error(`החשבון ${r.label} עוד לא מחובר`);
      this.store.setMeta(PIN_KEY, name);
    } else this.store.setMeta(PIN_KEY, '');
    this.store.emit('account.pinned', null, { name });
    if (name) for (const s of this.shifts.active()) if (!s.in_turn) this.store.bg(this.follow(s), 'accounts.follow');
  }

  private async follow(row: ShiftRow): Promise<void> {
    if (this.cfg.codexLean || row.account === 'codex') return;
    const pin = this.pinned();
    if (!pin || row.kind === 'foreign' || (row.account ?? this.primary) === pin || row.state !== 'live') return;
    // A node's shift runs on that node's own login (nodes.ts): "everyone to X" does not move it here.
    if ((row.machine ?? 'local') !== 'local') return;
    const r = this.get(pin);
    if (!r || !this.usable(r) || this.blocked(r)) return;
    const o = this.mailbox.names.owner;
    await this.move(row, pin, `${o.name} ${g(o, 'העביר', 'העבירה')} את כולם לחשבון ${r.label}.`);
  }

  // ── automatic switch ─────────────────────────────────────────────────────
  private onFrame(row: ShiftRow, f: LoggedFrame, live: boolean): void {
    if (f.t === 'lifecycle' && f.state === 'idle') { if (live) this.store.bg(this.follow(row), 'accounts.follow'); return; }
    if (f.t !== 'event' || f.ev.kind !== 'rate_limit') return;
    const ev = f.ev as { status?: string; resetsAt?: number; fiveHour?: number; sevenDay?: number };
    const name = row.account ?? this.primary;
    if (!this.get(name)) return;
    const pct = (v?: number) => (typeof v === 'number' ? Math.round(v * 1000) / 10 : undefined);
    const fields: Partial<AccountRow> = { snapshot_at: this.store.now() };
    if (pct(ev.fiveHour) != null) fields.five_hour_pct = pct(ev.fiveHour)!;
    if (pct(ev.sevenDay) != null) fields.seven_day_pct = pct(ev.sevenDay)!;
    if (ev.status !== 'rejected') { if (live) this.set(name, fields); return; }
    const until = toMs(ev.resetsAt) ?? this.store.now() + 3600_000;
    // A replayed rejection (reconnect after an hq restart) still counts while its window is open; the next
    // sweep's rebalance() moves the shift. Live: move it now.
    if (!live) { if (until > this.store.now()) this.set(name, { blocked_until: until }); return; }
    fields.blocked_until = until;
    this.set(name, fields);
    this.store.emit('account.exhausted', row.identity, { account: name, until, shift: row.id });
    this.watchFull();
    if (this.store.toggle('yoav/accounts')) this.store.bg(this.switchAway(row), 'accounts.switch');
  }

  /** The shift's account ran out: resume the same session on the account with the most room, if there is one. */
  async switchAway(row: ShiftRow): Promise<string | null> {
    if (this.cfg.codexLean || row.account === 'codex') return null;
    const from = this.get(row.account ?? this.primary);
    const next = this.pick();
    // Everyone is blocked: the shift parks; the board shows "חסום: מכסה" until the reset.
    if (!next || next.name === from?.name || this.blocked(next)) return null;
    await this.move(row, next.name, `המכסה של החשבון ${from?.label ?? row.account} נגמרה.`);
    return next.name;
  }

  /** Stop at the turn boundary and --resume the same session id on `to` (B.7 "החלפה באמצע"). */
  async move(row: ShiftRow, to: string, why: string): Promise<boolean> {
    if (this.cfg.codexLean || row.account === 'codex') return false;
    if (this.moving.has(row.identity)) return false;
    this.moving.add(row.identity);
    try {
      const cur = this.shifts.get(row.id);
      if (!cur || cur.state !== 'live' || cur.started_at !== row.started_at) return false;
      // One lock for stop + resume: nothing can start this identity in between. The task's worktree comes from
      // the shift manager (taskCwd), same as any resume.
      const next = await this.shifts.relaunch(cur.id, 'account_switch', cur.started_at, { reason: 'account_switch', kind: cur.kind,
        taskId: cur.task_id, account: to });
      if (!next) return false;
      const label = this.get(to)?.label ?? to;
      this.store.emit('account.switched', cur.identity, { from: cur.account, to, shift: next.id, why });
      this.mailbox.tell({ msg_id: `account-switch-${next.id}-${next.started_at}`, from: 'hq', to: cur.identity, priority: 'next',
        body: `${why} המשמרת עברה לחשבון ${label}, על אותו סשן. המשך מאיפה שעצרת.` });
      return true;
    } finally {
      this.moving.delete(row.identity);
    }
  }

  // ── quota ────────────────────────────────────────────────────────────────
  /** get_usage per usable account (B.7: every 10 minutes, no inference). */
  async refresh(): Promise<void> {
    for (const r of this.rows()) {
      if (!this.usable(r)) continue;
      try {
        const u = await this.deps.usage({ name: r.name, configDir: r.config_dir });
        const five = ms(u.resetsAt.fiveHour), seven = ms(u.resetsAt.sevenDay);
        const full = (u.fiveHour ?? 0) >= 100 ? five : (u.sevenDay ?? 0) >= 100 ? seven : null;
        this.set(r.name, { five_hour_pct: u.fiveHour, seven_day_pct: u.sevenDay, five_hour_resets_at: five, seven_day_resets_at: seven,
          snapshot_at: this.store.now(), blocked_until: full ?? (this.blocked(r) ? r.blocked_until : null),
          // A failed read from before is no longer true.
          ...(r.note?.startsWith(QUOTA_FAILED) ? { note: null } : {}) });
      } catch (e) {
        this.set(r.name, { note: `${QUOTA_FAILED} ${(e as Error).message.slice(0, 160)}` });
      }
    }
    this.watchFull();
    this.store.emit('accounts.quota', null, { full: this.allFull() });
    if (this.store.toggle('yoav/accounts')) await this.rebalance();
  }

  /** Each account as the home shows it (home.ts): both windows, when they reset, and whether it is full now. */
  quota() {
    const rows = this.rows();
    return rows.filter((r) => !this.duplicateOf(r, rows)).map((r) => ({
      name: r.name, label: r.label, usable: this.usable(r, rows), full: this.full(r), reopens_at: this.reopensAt(r),
      five_hour_pct: r.five_hour_pct, seven_day_pct: r.seven_day_pct, five_hour_resets_at: r.five_hour_resets_at,
      seven_day_resets_at: r.seven_day_resets_at, snapshot_at: r.snapshot_at,
    }));
  }

  /**
   * All accounts full → one urgent incident for the owner (task 986: the manager is down with everyone else, so this
   * one is his, inbox.ts managerDown), with when the first one reopens, in his time.
   * It stays one item while it lasts (new words if the times move), closes by itself once an account takes work
   * again, and then he gets a short message that we are back. Part of the `accounts` automation.
   */
  watchFull(): void {
    const now = this.store.now();
    const since = Number(this.store.getMeta(ALL_FULL_META) || 0);
    // Turned off: nothing is read any more, so an open item would only grow stale. It closes without a "חזרנו".
    if (!this.store.toggle('yoav/accounts')) {
      if (since) { this.store.setMeta(ALL_FULL_META, ''); this.inbox.resolveByRef('incident', ALL_FULL_REF, 'dismissed'); }
      return;
    }
    const cap = this.capacity();
    const tz = readTimeZone(this.cfg.companyDir);
    if (this.allFull()) {
      const times = cap.map((r) => this.reopensAt(r)).filter((x): x is number => x != null);
      const first = times.length ? Math.min(...times) : null;
      const title = first ? `כל החשבונות של Claude מלאים, והעבודה עומדת עד ${whenLocal(first, now, tz)}` : 'כל החשבונות של Claude מלאים, והעבודה עומדת';
      const pct = (v: number | null) => (v == null ? 'לא ידוע' : `${Math.round(v)}%`);
      const body = [
        ...cap.map((r) => { const at = this.reopensAt(r); return `- ${r.label}: 5 שעות ${pct(r.five_hour_pct)}, שבועי ${pct(r.seven_day_pct)}. ${at ? `נפתח ${whenLocal(at, now, tz)}` : 'שעת האיפוס לא ידועה'}.`; }),
        // An account that is not capacity (waiting for a login) is named too: the title speaks of all of them.
        ...this.rows().filter((r) => !cap.some((c) => c.name === r.name) && !this.duplicateOf(r)).map((r) => `- ${r.label}: לא מחובר.`),
        '',
        'שום משימה לא מתחילה עד שחשבון נפתח. כשזה קורה הפריט נסגר לבד ותגיע הודעה.',
      ].join('\n');
      if (!since) {
        this.store.setMeta(ALL_FULL_META, String(now));
        // One at a time is the meta key's job; no dedupe key, so a new episode in the same millisecond is still new.
        this.inbox.add({ kind: 'incident', urgency: 'urgent', from_identity: this.cfg.managerId, ref: ALL_FULL_REF, title, body });
        this.store.emit('accounts.all_full', null, { reopens_at: first });
      } else {
        const open = this.inbox.open().find((i) => i.kind === 'incident' && i.ref === ALL_FULL_REF);
        if (open && (open.title !== title || open.body !== body)) this.inbox.updateByRef('incident', ALL_FULL_REF, { title, body });
      }
      return;
    }
    // Back means an account takes work: none usable at all (every login lost) is not back.
    if (!since || !cap.some((r) => !this.full(r))) return;
    this.store.setMeta(ALL_FULL_META, '');
    this.inbox.resolveByRef('incident', ALL_FULL_REF);
    const back = cap.find((r) => !this.full(r));
    const h = Math.round((now - since) / 3600_000);
    const stood = h >= 1 ? ` (עמדנו ${h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`})` : '';
    this.mailbox.tell({ msg_id: `${ALL_FULL_REF}-back-${now}`, from: this.cfg.managerId, to: OWNER, priority: 'now',
      body: `חזרנו: ${back ? `החשבון ${back.label} פתוח שוב` : 'יש שוב חשבון פתוח'}, והעבודה ממשיכה${stood}.` });
    this.store.emit('accounts.back', null, { account: back?.name ?? null, since });
  }

  /** Live shifts still on a blocked account (a rejection missed while hq was down) move if another account is open. */
  async rebalance(): Promise<void> {
    if (this.cfg.codexLean) return;
    for (const s of this.shifts.active()) {
      const r = this.get(s.account ?? this.primary);
      if (s.kind === 'foreign' || s.state !== 'live' || s.in_turn || !r || !this.blocked(r)) continue;
      await this.switchAway(s);
    }
  }

  // ── identity check ───────────────────────────────────────────────────────
  /** After every login (and on every sweep): the credentials must be the account he asked for, and not one we already have. */
  async verify(name: string): Promise<AccountRow> {
    const r = this.get(name);
    if (!r) throw new Error(`אין חשבון ${name}`);
    let p: Profile;
    try { p = await this.deps.profile(r.config_dir); }
    catch (e) {
      this.set(name, r.config_dir ? { health: 'needs_login', note: `אין התחברות תקפה (${(e as Error).message.slice(0, 120)})` } : { note: (e as Error).message.slice(0, 160) });
      return this.get(name)!;
    }
    // Only an account registered before this one: two rows that verify each other must not both turn wrong.
    const dup = this.duplicateOf({ name, account_uuid: p.accountUuid });
    const base = { email: p.email, org: p.org, plan: p.plan, account_uuid: p.accountUuid, verified_at: this.store.now() };
    if (!matchesExpect(p.email, r.expect)) {
      this.set(name, { ...base, health: 'wrong_account', note: `התחברת כ-${p.email}, ביקשת ${r.expect}. נסה שוב.` });
    } else if (dup) {
      this.set(name, { ...base, health: 'wrong_account', note: `זה אותו חשבון כמו ${dup.label}. נסה שוב עם ${r.expect}.` });
    } else {
      this.set(name, { ...base, health: 'ok', note: null });
    }
    return this.get(name)!;
  }

  // ── guided login ─────────────────────────────────────────────────────────
  /** Shared dirs as symlinks into ~/.claude; the account's own .credentials.json and .claude.json stay separate. */
  prepareDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const s of SHARED) {
      const link = join(dir, s);
      let present = false;
      try { lstatSync(link); present = true; } catch { /* absent */ }
      if (present) continue;
      const target = join(this.cfg.claudeHome, s);
      mkdirSync(target, { recursive: true });
      symlinkSync(target, link);
    }
  }

  /** Start `claude auth login` for a managed account; the link reaches him as a (non-blocking) ask. */
  async startLogin(name: string, why?: string, tries = 0): Promise<{ askId: string }> {
    const d = this.def(name);
    if (!d) throw new Error(`אין חשבון ${name}`);
    if (!d.managed) throw new Error('זו ההתחברות הגלובלית של Claude (~/.claude). לא מחליפים אותה (dir-0016).');
    const ex = this.pending.get(name);
    if (ex) return { askId: ex.askId };
    if (this.starting.has(name)) throw new Error('ההתחברות כבר מתחילה');
    this.starting.add(name);
    let lp: LoginProcess, url: string;
    try {
      const dir = this.dirOf(d)!;
      this.prepareDir(dir);
      lp = await this.deps.login(dir, d.expect.includes('@') ? d.expect : undefined);
      try {
        url = await Promise.race([lp.url, new Promise<string>((_, rej) => setTimeout(() => rej(new Error('claude auth login לא החזיר קישור')), 30_000).unref())]);
      } catch (e) { lp.kill(); throw e; }
    } finally { this.starting.delete(name); }
    const askId = `account-login-${name}-${randomUUID().slice(0, 8)}`;
    const timer = setTimeout(() => this.cancelLogin(name, 'פג תוקף'), LOGIN_TTL_MS);
    timer.unref();
    this.pending.set(name, { lp, askId, timer, tries });
    this.set(name, { note: why ?? 'מחכה להתחברות' });
    this.mailbox.ask({ msg_id: askId, from: 'hq', blocking: false, question: [
      why ?? `חיבור החשבון ${d.label} לחברה, מתי שנוח לך.`,
      `1. פותחים את הקישור (רצוי בחלון פרטי, כדי לא להתחבר בטעות כ-${this.get(this.primary)?.email ?? this.primary}) ומתחברים כ-${d.expect}.`,
      '2. בסוף מופיע קוד. מדביקים אותו כאן כתשובה.',
      url,
    ].join('\n') });
    lp.done.then((code) => {
      const p = this.pending.get(name);
      // Exited before he answered (killed, crashed): close the ask so no stale link waits for him.
      if (p?.lp === lp && code !== 0) this.cancelLogin(name, 'תהליך ההתחברות נעצר');
    }, () => {});
    return { askId };
  }

  cancelLogin(name: string, why: string): void {
    const p = this.pending.get(name);
    if (!p) return;
    this.pending.delete(name);
    clearTimeout(p.timer);
    p.lp.kill();
    this.store.db.prepare(`UPDATE asks SET state = 'cancelled', answered_at = ? WHERE id = ? AND state IN ('open','escalated')`).run(this.store.now(), p.askId);
    this.inbox.resolveByRef('ask', p.askId, 'dismissed');
    this.set(name, { note: `ההתחברות בוטלה: ${why}` });
  }

  private async onCode(name: string, answer: string): Promise<void> {
    const p = this.pending.get(name);
    if (!p) return;
    this.pending.delete(name);
    clearTimeout(p.timer);
    p.lp.submit(answer.trim());
    const code = await Promise.race([p.lp.done, new Promise<null>((r) => setTimeout(() => r(null), 60_000).unref())]);
    if (code !== 0) {
      p.lp.kill();
      this.set(name, { note: 'הקוד לא התקבל' });
      if (p.tries < 2) await this.startLogin(name, `הקוד לא התקבל. נסה שוב לחבר את ${this.get(name)?.label ?? name}.`, p.tries + 1);
      return;
    }
    const r = await this.verify(name);
    if (r.health !== 'ok' && p.tries < 2) await this.startLogin(name, r.note ?? undefined, p.tries + 1);
    else if (r.health === 'ok') this.store.emit('account.connected', null, { name, email: r.email });
  }

  stop(): void { for (const name of [...this.pending.keys()]) this.cancelLogin(name, 'hq נעצר'); }
}

// ── defaults (real Claude Code) ────────────────────────────────────────────

function defaultUsage(cfg: HqConfig): (a: AccountChoice) => Promise<UsageReply> {
  let engine: { usage(a: { name: string; configDir?: string }): Promise<UsageReply> } | null = null;
  return async (a) => {
    if (!engine) {
      const mod = (await import('@company/adapter' as string)) as { ClaudeEngine: new (o: { stateRoot: string }) => typeof engine };
      engine = new mod.ClaudeEngine({ stateRoot: cfg.stateDir });
    }
    return engine!.usage({ name: a.name, configDir: a.configDir ?? undefined });
  };
}

/** GET /api/oauth/profile with the account's own access token (read-only); falls back to the CLI's cached oauthAccount. */
export async function readProfile(configDir: string | null, claudeHome: string): Promise<Profile> {
  const dir = configDir ?? claudeHome;
  const cred = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string; subscriptionType?: string } };
  const token = cred.claudeAiOauth?.accessToken;
  if (!token) throw new Error('אין טוקן');
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/profile', {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const j = await res.json() as { account?: { uuid?: string; email?: string }; organization?: { name?: string; rate_limit_tier?: string } };
      if (j.account?.email) return { email: j.account.email, accountUuid: j.account.uuid ?? null, org: j.organization?.name ?? null, plan: j.organization?.rate_limit_tier ?? null };
    }
  } catch { /* offline or expired: the CLI's own cache below */ }
  // ~/.claude's cache lives next to it (~/.claude.json); a managed dir keeps it inside.
  const cache = configDir ? join(configDir, '.claude.json') : `${claudeHome}.json`;
  const o = (JSON.parse(readFileSync(cache, 'utf8')) as { oauthAccount?: { emailAddress?: string; accountUuid?: string; organizationName?: string; organizationRateLimitTier?: string } }).oauthAccount;
  if (!o?.emailAddress) throw new Error('הפרופיל לא נקרא');
  return { email: o.emailAddress, accountUuid: o.accountUuid ?? null, org: o.organizationName ?? null, plan: o.organizationRateLimitTier ?? cred.claudeAiOauth?.subscriptionType ?? null };
}

/** `claude auth login` with its own CLAUDE_CONFIG_DIR: prints the link, then reads the pasted code from stdin. */
export function spawnLogin(configDir: string, email?: string, bin = 'claude'): LoginProcess {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_CODE_') || k === 'CLAUDECODE') delete env[k];
  // Never open a browser on this machine: the shared profile is logged in as the main account (B.7).
  Object.assign(env, { CLAUDE_CONFIG_DIR: configDir, BROWSER: '/bin/true', DISPLAY: '', WAYLAND_DISPLAY: '' });
  const p = spawn(bin, ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])],
    { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  const url = new Promise<string>((resolve, reject) => {
    const onData = (d: Buffer) => {
      out += String(d);
      const m = out.match(/https:\/\/\S+\/oauth\/authorize\?\S+/);
      if (m) resolve(m[0]);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', () => reject(new Error(`claude auth login יצא: ${out.slice(-200)}`)));
    p.on('error', reject);
  });
  url.catch(() => {});
  const done = new Promise<number | null>((resolve) => { p.on('exit', (c) => resolve(c)); p.on('error', () => resolve(-1)); });
  return {
    url, done,
    submit: (code) => { p.stdin.write(`${code}\n`); },
    kill: () => { if (p.exitCode == null) p.kill('SIGTERM'); },
  };
}
