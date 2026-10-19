// SQLite WAL store (B.11). One process (hq) writes; migrations run on open via PRAGMA user_version.
// Every state change that a client may care about goes through `emit()` → events table (CDC, B.8) → WS.
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HqEvent, IdentityId } from '@company/shared';

export type DB = Database.Database;

// hq.db is deployed (hq-host, since 19/10): every change is a new migration appended below — never an edit
// of a shipped one.
const MIGRATIONS: string[] = [
  // 1 — phase 1 schema
  `
  CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    symbol TEXT NOT NULL DEFAULT '',
    team TEXT,
    team_kind TEXT,                 -- permanent | project | task
    project TEXT,
    reports_to TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'lead',  -- lead | resident | dormant | ephemeral
    source TEXT NOT NULL DEFAULT 'org',      -- org (company/org.yaml) | runtime (task workers)
    active INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE shifts (
    id TEXT PRIMARY KEY,            -- <identity>-<n>
    identity TEXT NOT NULL REFERENCES identities(id),
    shift_no INTEGER NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL,            -- starting | live | ended | dead
    kind TEXT NOT NULL DEFAULT 'work', -- work | resident | foreign
    host_pid INTEGER,
    pid INTEGER,                    -- claude pid
    proc_start TEXT,                -- /proc/<pid>/stat starttime: pid + procStart = alive (B.5)
    host_seq INTEGER NOT NULL DEFAULT 0,  -- last host log seq persisted; hello.since on reconnect
    host_log_id TEXT,               -- the host's durable log id; dedupe key is (host_log_id, seq)
    spool_cursor TEXT,
    socket_path TEXT,
    unit TEXT,
    account TEXT,
    task_id INTEGER,
    machine TEXT NOT NULL DEFAULT 'local',
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    end_reason TEXT,
    last_event_at INTEGER,
    in_turn INTEGER NOT NULL DEFAULT 0,
    long_tool INTEGER NOT NULL DEFAULT 0,
    rate_limited_until INTEGER,
    stuck_since INTEGER,
    nudged_at INTEGER,
    interrupted_at INTEGER,
    dead_signals INTEGER NOT NULL DEFAULT 0,
    last_ping_ok_at INTEGER,        -- claude answered a control_request (bet 4 liveness)
    unit_released_at INTEGER,       -- the ended run's unit was disabled (won't return at boot)
    run_start_seq INTEGER,          -- seq of the latest lifecycle 'starting'; earlier frames belong to older runs
    UNIQUE (identity, shift_no)
  );
  CREATE INDEX shifts_identity ON shifts(identity, state);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,            -- msg_id: idempotency key (B.4)
    from_identity TEXT NOT NULL,
    to_identity TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'tell',
    body TEXT NOT NULL,
    urgency TEXT NOT NULL DEFAULT 'normal',
    priority TEXT NOT NULL DEFAULT 'next',
    ref TEXT,
    state TEXT NOT NULL DEFAULT 'queued',   -- queued | delivered | seen | handled | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    resurrected INTEGER NOT NULL DEFAULT 0,
    held_by_cli INTEGER NOT NULL DEFAULT 0, -- in the CLI's own queue at exit: a resume delivers it, never re-send
    shift_id TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    delivered_at INTEGER,
    seen_at INTEGER,
    handled_at INTEGER,
    failed_at INTEGER
  );
  CREATE INDEX messages_to ON messages(to_identity, state);
  CREATE INDEX messages_state ON messages(state, last_attempt_at);

  CREATE TABLE asks (
    id TEXT PRIMARY KEY,
    from_identity TEXT NOT NULL,
    question TEXT NOT NULL,
    options TEXT NOT NULL DEFAULT '[]',
    blocking INTEGER NOT NULL DEFAULT 0,
    urgency TEXT NOT NULL DEFAULT 'normal',
    state TEXT NOT NULL DEFAULT 'open',     -- open | escalated | answered | cancelled
    answer TEXT,
    answered_by TEXT,                        -- owner | manager
    created_at INTEGER NOT NULL,
    escalated_at INTEGER,
    answered_at INTEGER
  );
  CREATE INDEX asks_state ON asks(state, blocking, created_at);

  CREATE TABLE inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    from_identity TEXT,
    urgency TEXT NOT NULL DEFAULT 'normal',
    blocking INTEGER NOT NULL DEFAULT 0,
    ref TEXT,
    dedupe_key TEXT UNIQUE,
    state TEXT NOT NULL DEFAULT 'open',      -- open | resolved | dismissed
    created_at INTEGER NOT NULL,
    resolved_at INTEGER,
    pushed_at INTEGER,
    push_error TEXT,
    acked_at INTEGER,
    telegram_at INTEGER,
    telegram_failures INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX inbox_state ON inbox(state, created_at);

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    identity TEXT,
    data TEXT NOT NULL DEFAULT 'null'
  );
  CREATE INDEX events_identity ON events(identity, seq);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref TEXT UNIQUE,                         -- e.g. lumo#3711
    project TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'store',    -- store | github
    state TEXT NOT NULL DEFAULT 'queued',    -- queued | open | interrupted | running | parked | needs_decision | done
    labels TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 2,     -- p0..p3
    night_weight REAL NOT NULL DEFAULT 1,
    worktree TEXT,
    carried_over INTEGER NOT NULL DEFAULT 0, -- was in last night's queue and not finished
    identity TEXT,
    shift_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    started_at INTEGER
  );
  CREATE INDEX tasks_state ON tasks(state);

  CREATE TABLE accounts (
    name TEXT PRIMARY KEY,
    email TEXT,
    org TEXT,
    plan TEXT,
    token_path TEXT,                         -- file (600) under state/accounts — never the token itself
    expires_at INTEGER,
    health TEXT NOT NULL DEFAULT 'unknown',
    five_hour_pct REAL,
    seven_day_pct REAL,
    five_hour_resets_at INTEGER,
    seven_day_resets_at INTEGER,
    snapshot_at INTEGER
  );

  CREATE TABLE toggles (
    key TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    manual INTEGER NOT NULL DEFAULT 0,       -- "כובה ידנית"
    description TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE probe_state (
    probe_id TEXT PRIMARY KEY,               -- <project>/<id>
    project TEXT NOT NULL,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    anomaly_open INTEGER NOT NULL DEFAULT 0,
    last_run_at INTEGER,
    last_ok_at INTEGER,
    last_status INTEGER,
    last_latency_ms INTEGER,
    last_error TEXT
  );
  CREATE TABLE probe_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    probe_id TEXT NOT NULL,
    ok INTEGER NOT NULL,
    status INTEGER,
    latency_ms INTEGER,
    error TEXT,
    ts INTEGER NOT NULL
  );
  CREATE INDEX probe_results_probe ON probe_results(probe_id, ts);

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    keys TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_ok_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0
  );

  -- Every write from mcp-company/hooks (company-api.ts WalEntry), stored first: idempotency on id.
  CREATE TABLE ops (
    id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    shift TEXT,
    session_id TEXT,
    op TEXT NOT NULL,
    args TEXT NOT NULL,
    ts TEXT,
    received_at INTEGER NOT NULL,
    ack TEXT NOT NULL
  );
  CREATE INDEX ops_identity ON ops(identity, op, received_at);

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  // 2 — a reply the owner got as the worker's own assistant text (chat.md §2.3א): the engine messageId of
  // that text, so the app shows the streamed bubble and the stored message as one item.
  `
  ALTER TABLE messages ADD COLUMN text_ref TEXT;
  `,
  // 3 — night mode (B.16): one row per night, which tasks were in its queue, and every interval a slot sat empty
  // while the queue was not (with the reason). The morning summary is computed from these and stored on the night.
  `
  CREATE TABLE nights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    until_at INTEGER,                        -- the hour he set; NULL = until his first message in the morning
    scope TEXT,                              -- JSON array of projects ("רק לומו"), NULL = all active
    note TEXT,                               -- the rest of what he wrote ("בלי פריסות"), passed to every night task
    started_by TEXT,
    end_reason TEXT,
    summary TEXT
  );
  CREATE TABLE night_tasks (
    night_id INTEGER NOT NULL,
    task_id INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (night_id, task_id)
  );
  CREATE TABLE night_empty (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    night_id INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    reason TEXT NOT NULL
  );
  CREATE INDEX night_empty_night ON night_empty(night_id);
  `,
];

export const DEFAULT_TOGGLES: { key: string; enabled: boolean; description: string }[] = [
  { key: 'scheduler', enabled: true, description: 'המתזמן ממלא משבצות פנויות מהתור' },
  { key: 'residents', enabled: true, description: 'התושבים (יואב) רצים תמיד' },
  { key: 'escalation', enabled: true, description: 'שאלה חוסמת שלא נענתה עוברת ליואב' },
  { key: 'push', enabled: true, description: 'התראות כשמשהו חסום עליך' },
  { key: 'backup', enabled: true, description: 'גיבוי hq.db כל שעה' },
  { key: 'focus', enabled: false, description: 'מצב פוקוס: רק תקלה דחופה בפרודקשן מתריעה' },
  { key: 'night', enabled: false, description: 'מצב לילה (B.16)' },
];

type Listener = (e: HqEvent) => void;

export class Store {
  readonly db: DB;
  private listeners = new Set<Listener>();
  now: () => number;

  constructor(path: string, opts: { now?: () => number } = {}) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    // Messages and asks are his private life (B.3 ⚠): owner-only. -wal/-shm inherit this mode.
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.now = opts.now ?? Date.now;
    this.migrate();
    this.seedToggles();
  }

  private migrate(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!);
        this.db.pragma(`user_version = ${v + 1}`);
      })();
    }
  }

  get schemaVersion(): number {
    return this.db.pragma('user_version', { simple: true }) as number;
  }

  private seedToggles(): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO toggles (key, enabled, description, updated_at) VALUES (?, ?, ?, ?)');
    for (const t of DEFAULT_TOGGLES) ins.run(t.key, t.enabled ? 1 : 0, t.description, this.now());
  }

  // ── events / CDC ──────────────────────────────────────────────────────────
  emit(type: string, identity: IdentityId | null, data: unknown): HqEvent {
    const ts = this.now();
    const r = this.db.prepare('INSERT INTO events (ts, type, identity, data) VALUES (?, ?, ?, ?)')
      .run(ts, type, identity, JSON.stringify(data ?? null));
    const ev: HqEvent = { seq: Number(r.lastInsertRowid), ts, type, identity, data };
    for (const l of this.listeners) {
      try { l(ev); } catch { /* a broken listener must not break writers */ }
    }
    return ev;
  }

  /** Live-only notification (seq 0): streaming deltas. Never persisted, never replayed. */
  publish(type: string, identity: IdentityId | null, data: unknown): void {
    const ev: HqEvent = { seq: 0, ts: this.now(), type, identity, data };
    for (const l of this.listeners) {
      try { l(ev); } catch { /* ignore */ }
    }
  }

  onEvent(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  eventsAfter(seq: number, limit = 500, identity?: string): HqEvent[] {
    const rows = (identity
      ? this.db.prepare('SELECT * FROM events WHERE seq > ? AND identity = ? ORDER BY seq LIMIT ?').all(seq, identity, limit)
      : this.db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(seq, limit)) as
      { seq: number; ts: number; type: string; identity: string | null; data: string }[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as unknown }));
  }

  /** Token deltas are only useful for live streaming/reconnect; facts are kept much longer. */
  pruneEvents(deltaMaxAgeMs = 86_400_000, maxAgeMs = 30 * 86_400_000): void {
    const now = this.now();
    this.db.prepare(`DELETE FROM events WHERE type = 'engine.delta' AND ts < ?`).run(now - deltaMaxAgeMs);
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(now - maxAgeMs);
  }

  // ── toggles ───────────────────────────────────────────────────────────────
  toggle(key: string): boolean {
    const r = this.db.prepare('SELECT enabled FROM toggles WHERE key = ?').get(key) as { enabled: number } | undefined;
    return r ? r.enabled === 1 : false;
  }

  setToggle(key: string, enabled: boolean, manual = true): void {
    this.db.prepare(`INSERT INTO toggles (key, enabled, manual, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET enabled = excluded.enabled, manual = excluded.manual, updated_at = excluded.updated_at`)
      .run(key, enabled ? 1 : 0, manual ? 1 : 0, this.now());
    this.emit('toggle.changed', null, { key, enabled, manual });
  }

  toggles(): { key: string; enabled: boolean; manual: boolean; description: string; updated_at: number }[] {
    return (this.db.prepare('SELECT * FROM toggles ORDER BY key').all() as
      { key: string; enabled: number; manual: number; description: string; updated_at: number }[])
      .map((t) => ({ ...t, enabled: t.enabled === 1, manual: t.manual === 1 }));
  }

  // ── meta ──────────────────────────────────────────────────────────────────
  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  closed = false;

  /** Run fire-and-forget work: errors become visible `loop.error` events; after close() they are dropped. */
  bg(p: Promise<unknown>, what: string): void {
    p.catch((e: unknown) => {
      if (this.closed) return;
      try { this.emit('loop.error', null, { loop: what, error: e instanceof Error ? e.message : String(e) }); } catch { /* closing */ }
    });
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }
}
