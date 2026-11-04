// SQLite WAL store (B.11). One process (hq) writes; migrations run on open via PRAGMA user_version.
// Every state change that a client may care about goes through `emit()` → events table (CDC, B.8) → WS.
import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_NAMES, pre, type HqEvent, type IdentityId } from '@company/shared';

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
    state TEXT NOT NULL DEFAULT 'queued',    -- proposal | queued | open | interrupted | running | parked | needs_decision | done
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
  // 4 — devices and passkeys (auth.ts, #23). Device tokens are stored as sha256 only.
  `
  CREATE TABLE passkeys (
    id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    via TEXT NOT NULL,
    passkey_id TEXT REFERENCES passkeys(id),
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE pair_codes (
    code_hash TEXT PRIMARY KEY,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER,
    used_by TEXT
  );
  `,
  // 5 — accounts manager (B.7, issue #25): a managed config dir per extra account, identity check, block window
  `
  ALTER TABLE accounts ADD COLUMN label TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN expect TEXT NOT NULL DEFAULT '';   -- the email (or its local part) he asked to connect
  ALTER TABLE accounts ADD COLUMN config_dir TEXT;                    -- NULL = the CLI's own ~/.claude login (dir-0016)
  ALTER TABLE accounts ADD COLUMN account_uuid TEXT;                  -- from /api/oauth/profile: two rows never share one
  ALTER TABLE accounts ADD COLUMN verified_at INTEGER;
  ALTER TABLE accounts ADD COLUMN blocked_until INTEGER;              -- rate limit rejected until (ms)
  ALTER TABLE accounts ADD COLUMN note TEXT;                          -- last verdict, in Hebrew, for the app
  `,
  // B.9 tab handoff (tab/handoffs.ts). The token and the phone's cookie are stored hashed.
  `
  ALTER TABLE inbox ADD COLUMN link TEXT;                             -- where "פתיחה" goes (a handoff link)
  CREATE TABLE tab_handoffs (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    from_identity TEXT,
    inbox_id INTEGER,
    target_id TEXT NOT NULL,                 -- CDP target of the tab being handed over
    own_window INTEGER NOT NULL DEFAULT 0,   -- hq opened this window, and closes it at the end
    url TEXT NOT NULL DEFAULT '',
    domain TEXT NOT NULL DEFAULT '',         -- the login lock: one live handoff per site
    what TEXT NOT NULL DEFAULT '',
    need TEXT,
    state TEXT NOT NULL DEFAULT 'live',      -- live | done | expired | closed | cancelled
    bound_hash TEXT,                         -- the first device that opened the link
    viewed INTEGER NOT NULL DEFAULT 0,       -- a phone viewport may be on the tab (cleared after a restart)
    final_url TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ended_at INTEGER,
    ended_by TEXT
  );
  CREATE INDEX tab_handoffs_live ON tab_handoffs(state, domain);
  CREATE INDEX tab_handoffs_inbox ON tab_handoffs(inbox_id);
  `,
  // v7: where the run's CLI ran. Claude Code keeps sessions per cwd: a new cwd means a new shift, not a resume.
  `ALTER TABLE shifts ADD COLUMN cwd TEXT;`,
  // v8: images the owner attaches in the app (uploads.ts). A message lists them by id, with what the app shows.
  `
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    path TEXT NOT NULL,                      -- <state>/uploads/<id>.<ext>: what the worker opens with Read
    created_at INTEGER NOT NULL
  );
  ALTER TABLE messages ADD COLUMN attachments TEXT;                   -- JSON [{id,name,mime,bytes}], NULL = none
  `,
  // v9: the first line of a question or GO in his words ("עדכון לאפליקציה: תמונות בצ'אט"); the details fold under it.
  `
  ALTER TABLE asks ADD COLUMN headline TEXT;
  ALTER TABLE inbox ADD COLUMN headline TEXT;
  `,
  // v10: "לא עכשיו" is his, kept here: the card stays down with the others he put off, on every device and refresh (#74).
  `ALTER TABLE inbox ADD COLUMN snoozed_at INTEGER;`,
  // v11: unread and mute per conversation, his on every device (conversations.ts, as in WhatsApp). What was
  // already there when this shipped counts as read: a deploy must not light up every old conversation.
  `
  CREATE TABLE conversations (
    identity TEXT PRIMARY KEY,
    read_at INTEGER NOT NULL DEFAULT 0,      -- he read everything from this worker up to here
    muted_until INTEGER,                     -- NULL = not muted; MUTE_FOREVER = always
    alert_at INTEGER,                        -- created_at of the newest message that was allowed to alert him
    updated_at INTEGER NOT NULL
  );
  INSERT INTO conversations (identity, read_at, updated_at)
    SELECT from_identity, MAX(created_at), MAX(created_at) FROM messages WHERE to_identity = 'owner' GROUP BY from_identity;
  `,
  // v12: what a finished task did, one line in his words ("התמונות עלו"), from status done or close_team (#53).
  `ALTER TABLE tasks ADD COLUMN summary TEXT;`,
  // v13: "מה לבדוק" (awaiting.ts, #108): a finished task that waits for a deploy or for him to check something,
  // the PR it merged in (a deploy reports PRs), and every deploy that was reported.
  `
  ALTER TABLE tasks ADD COLUMN awaiting TEXT;                         -- NULL | deploy | check
  ALTER TABLE tasks ADD COLUMN awaiting_note TEXT;                    -- one line in his words
  ALTER TABLE tasks ADD COLUMN awaiting_at INTEGER;
  ALTER TABLE tasks ADD COLUMN pr TEXT;                               -- PR number in the project's repo
  CREATE INDEX tasks_awaiting ON tasks(awaiting) WHERE awaiting IS NOT NULL;
  CREATE TABLE deploys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    sha TEXT NOT NULL,
    target TEXT,                             -- hq | app | caddy | all, or the project's own word
    tasks TEXT NOT NULL DEFAULT '[]',        -- JSON task ids it reported
    prs TEXT NOT NULL DEFAULT '[]',          -- JSON PR numbers it reported
    cleared TEXT NOT NULL DEFAULT '[]',      -- JSON task ids that left "מה לבדוק" because of it
    created_at INTEGER NOT NULL
  );
  `,
  // v14: the head of his conversations screen as a recipe of blocks (home.ts). The newest row is in force; kept 200 back.
  `
  CREATE TABLE home_recipes (
    version INTEGER PRIMARY KEY AUTOINCREMENT,
    composed_by TEXT NOT NULL,
    composed_at INTEGER NOT NULL,
    reason TEXT,
    blocks TEXT NOT NULL                     -- JSON [Block], validated on the way in
  );
  `,
  // v15: `remember` with `file` (memory-files.ts): which ops went into the rolling memory PR, and which PR.
  `
  CREATE TABLE memory_file_ops (
    op_id TEXT PRIMARY KEY,
    pr TEXT,                                 -- the PR URL; NULL when the update changed nothing
    flushed_at INTEGER NOT NULL
  );
  `,
  // v16: registries (memory-registry.ts) land on main one commit each: the commit, and how the write ended.
  `
  ALTER TABLE memory_file_ops ADD COLUMN sha TEXT;        -- the commit on main; NULL when nothing was committed
  ALTER TABLE memory_file_ops ADD COLUMN outcome TEXT;    -- committed | unchanged | conflict | invalid; NULL = the rolling PR
  `,
  // v17: the tool his `now` waits for (shift-host safe-tools.ts): {tool, command?, since}. The bubble says it.
  `ALTER TABLE messages ADD COLUMN waiting_on TEXT;`,
  // v18: background work of the current run (Bash/Agent run_in_background): JSON [task_id]. Its end notifies only a
  // live process, so the watchdog does not rest a shift while it is not empty (#175).
  `ALTER TABLE shifts ADD COLUMN bg_tasks TEXT NOT NULL DEFAULT '[]';`,
  // v19: Telegram for a worker's `now` message while the app is not connected (push.ts, #204): the message still
  // owed one, and when the last one went (one per conversation until he reads it).
  `
  ALTER TABLE conversations ADD COLUMN telegram_owed TEXT;
  ALTER TABLE conversations ADD COLUMN telegram_at INTEGER;
  `,
  // v20: the machine a task's worktree and shifts are on (nodes.ts): NULL = not placed yet (here, until it gets a worktree).
  `ALTER TABLE tasks ADD COLUMN machine TEXT;`,
  // v21: the live register of time estimates (estimates.ts): what a worker promised, when, and how it ended.
  `
  CREATE TABLE estimates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity TEXT NOT NULL,
    shift TEXT,
    task INTEGER,                            -- the worker's open task when it promised; NULL = none (a standing worker between tasks)
    project TEXT,
    kind TEXT NOT NULL,                      -- small-fix | feature | investigation | report | build | deploy | release
    what TEXT NOT NULL,                      -- what will be ready, one line
    message_id TEXT,                         -- the tell that carried it; NULL = given in a status
    created_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    closed_at INTEGER,                       -- the real time it ended; kept when a missed one closes late
    outcome TEXT,                            -- NULL (open) | missed (past due, still open) | done | cancelled
    superseded_by INTEGER                    -- a newer estimate of the same worker on the same what; this one is kept as given
  );
  CREATE INDEX estimates_open ON estimates(identity) WHERE closed_at IS NULL;
  CREATE INDEX estimates_task ON estimates(task) WHERE task IS NOT NULL;
  CREATE INDEX estimates_kind ON estimates(project, kind, outcome);
  `,
  // v22: the reminders of an estimate (estimates.ts remind): each is sent once, the time is its mark. missed_at (= due_at) stays when a late one closes.
  `
  ALTER TABLE estimates ADD COLUMN missed_at INTEGER;
  ALTER TABLE estimates ADD COLUMN reminded_at INTEGER;
  ALTER TABLE estimates ADD COLUMN missed_told_at INTEGER;
  ALTER TABLE estimates ADD COLUMN escalated_at INTEGER;
  UPDATE estimates SET missed_at = due_at WHERE outcome = 'missed';
  `,
  // v23: error-catcher (error-watch.ts): one row per error signature, sha1(type|component|normalized message).
  `
  CREATE TABLE error_signatures (
    sig TEXT PRIMARY KEY,
    type TEXT NOT NULL,                      -- the event: turn.error | message.undelivered | api.5xx | client.error | loop.error | …
    component TEXT NOT NULL,                 -- identity / route / screen / loop
    message TEXT NOT NULL,                   -- the first raw message
    identity TEXT,
    state TEXT NOT NULL,                     -- idle (under the threshold) | pending | asked | handling | done | muted | known
    count INTEGER NOT NULL,                  -- every occurrence, ever
    cycle_count INTEGER NOT NULL,            -- this round's (since it was last asked about): the number he sees
    shown_count INTEGER NOT NULL DEFAULT 0,  -- the number his item shows now
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    cycle_start INTEGER NOT NULL,            -- the first occurrence this round counts
    pending_since INTEGER,
    window_start INTEGER NOT NULL,
    window_count INTEGER NOT NULL,
    ask_id TEXT,                             -- his item (asks.id, from hq)
    answer TEXT,
    task_id INTEGER,                         -- the task "לטפל" opened
    muted_until INTEGER,
    returned INTEGER NOT NULL DEFAULT 0,     -- this round came after its task was done
    examples TEXT NOT NULL DEFAULT '[]'      -- [{seq, ts, identity, data}]: the first ones and the latest
  );
  CREATE INDEX error_signatures_state ON error_signatures(state);
  `,
  // v-next: the links under a decision in the app ("הדוח המלא", "ה-PR"): JSON [{kind: 'report' | 'pr', url}], NULL = none.
  `ALTER TABLE inbox ADD COLUMN links TEXT;`,
  // v-next: what the manager wrote on an escalated ask without answering it (mailbox.ts tell): the card keeps its asker and buttons.
  `
  ALTER TABLE asks ADD COLUMN manager_note TEXT;
  -- Once, at deploy (#331): an ask the manager "answered" with a plain tell (no "החלטתי במקומך" line) whose escalation note
  -- is still open goes back to its asker's card, and the manager's words stay as the note.
  CREATE TEMP TABLE repair_escalated AS
    SELECT a.id FROM asks a JOIN inbox n ON n.ref = a.id AND n.kind = 'escalation_note' AND n.state = 'open'
    WHERE a.state = 'answered' AND a.answered_by = 'manager' AND a.answer NOT LIKE 'החלטתי במקומך%';
  UPDATE inbox SET state = 'open', resolved_at = NULL, acked_at = NULL WHERE kind = 'ask' AND ref IN (SELECT id FROM repair_escalated);
  UPDATE inbox SET state = 'dismissed', resolved_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
    WHERE kind = 'escalation_note' AND state = 'open' AND ref IN (SELECT id FROM repair_escalated);
  UPDATE asks SET state = 'escalated', manager_note = answer, answer = NULL, answered_by = NULL, answered_at = NULL WHERE id IN (SELECT id FROM repair_escalated);
  DROP TABLE repair_escalated;
  `,
  // v26: request_access (access.ts): what a worker asked hq to run in its name, how it was decided and how it ended.
  `
  CREATE TABLE IF NOT EXISTS access_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity TEXT NOT NULL,
    shift TEXT,
    task INTEGER,
    project TEXT,
    resource TEXT NOT NULL,
    argv TEXT NOT NULL,                      -- JSON array, as the worker gave it
    shown TEXT NOT NULL,                     -- the exact command, as the card shows it
    why TEXT NOT NULL DEFAULT '',
    class TEXT,                              -- read | write | exec; NULL = never planned (unfit, denied)
    state TEXT NOT NULL,                     -- pending | running | done | failed | denied | unfit | cancelled
    approved_by TEXT,                        -- auto:read | auto:grant | auto:non-prod | owner
    inbox_id INTEGER,
    exit_code INTEGER,
    note TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    started_at INTEGER,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS access_requests_state ON access_requests(state, created_at);
  CREATE INDEX IF NOT EXISTS access_requests_identity ON access_requests(identity, id);
  `,
  // v27: resources (resources.ts): a rolling few hours of what each machine holds, by project. "unmeasured" = parts that could not be read.
  `
  CREATE TABLE IF NOT EXISTS resource_machine (
    at INTEGER NOT NULL,
    machine TEXT NOT NULL,
    error TEXT,
    mem_total_mb INTEGER, mem_avail_mb INTEGER, load1 REAL, cpus INTEGER,
    disk_pct INTEGER, disk_free_mb INTEGER,
    unmeasured TEXT NOT NULL DEFAULT '[]',
    docker_df TEXT,
    PRIMARY KEY (machine, at)
  );
  CREATE TABLE IF NOT EXISTS resource_usage (
    at INTEGER NOT NULL,
    machine TEXT NOT NULL,
    kind TEXT NOT NULL,                      -- shift | ci | docker | other
    project TEXT,                            -- NULL = לא מזוהה
    task INTEGER,
    name TEXT NOT NULL,                      -- the cgroup or container
    mem_mb REAL,
    cpu_pct REAL
  );
  CREATE INDEX IF NOT EXISTS resource_usage_at ON resource_usage(machine, at);
  `,
  // v28: reserve/release (leases.ts): a worker's place for a heavy command on a machine, from the queue to its release.
  `
  CREATE TABLE IF NOT EXISTS leases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    identity TEXT NOT NULL,
    shift TEXT,
    task INTEGER,
    project TEXT,
    class TEXT NOT NULL,
    machine TEXT NOT NULL,                   -- 'local' or a node's name (nodes.ts)
    note TEXT,
    priority INTEGER NOT NULL DEFAULT 2,     -- the task's: 0 = p0, first in the queue
    mem_mb INTEGER NOT NULL,
    cpu REAL NOT NULL,
    exclusive TEXT,
    timeout_ms INTEGER NOT NULL,
    state TEXT NOT NULL,                     -- queued | granted | released
    created_at INTEGER NOT NULL,
    polled_at INTEGER NOT NULL,              -- the last time the worker asked: a queued lease nobody asks for goes away
    granted_at INTEGER,
    attached_at INTEGER,                     -- company-run took it
    beat_at INTEGER,                         -- company-run's last sign of life
    released_at INTEGER,
    release_reason TEXT,                     -- released | exited | timeout | shift-ended | connection-lost | unclaimed | abandoned | cancelled
    exit_code INTEGER
  );
  CREATE INDEX IF NOT EXISTS leases_open ON leases(state, machine, created_at);
  CREATE INDEX IF NOT EXISTS leases_shift ON leases(shift, state);
  `,
  // v29: an estimate on a task that was frozen (parked / needs-decision) closes as `frozen`, not as a broken promise (estimates.ts freezeForTask).
  `
  CREATE TABLE IF NOT EXISTS estimate_frozen (estimate_id INTEGER PRIMARY KEY, by TEXT NOT NULL);
  `,
  // v30: rotation.ts. The context of the session's last turn (usage.iterations of engine.result), and when a resting lead wrote
  // the handoff hq asked for before its rest: a wake after the cache expired starts a clean shift from it instead of a resume.
  `
  ALTER TABLE shifts ADD COLUMN context_tokens INTEGER;
  ALTER TABLE shifts ADD COLUMN rest_handoff_at INTEGER;
  `,
  // v31: one worker's messages to one identity, by time. asked.ts looked up the answer to each of his messages of the week
  // (1,100 on 25/10) through messages_to, i.e. every message to him: ~6s of a frozen hq per call, on every /api/home and
  // /api/board (the event_loop_stall of #313). conversations.ts asks the same question for his unread.
  `
  CREATE INDEX IF NOT EXISTS messages_pair ON messages(from_identity, to_identity, created_at);
  `,
  // v32: a latency sample's numbers (probes.ts). `jitter` = over avg/mdev with loss under the threshold: recorded, wakes no one,
  // and counted in the daily digest by node, whose ticket draft needs avg and mdev of the worst samples.
  `
  ALTER TABLE probe_results ADD COLUMN jitter INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE probe_results ADD COLUMN loss_percent REAL;
  ALTER TABLE probe_results ADD COLUMN avg_ms REAL;
  ALTER TABLE probe_results ADD COLUMN mdev_ms REAL;
  `,
  // v33: root signals (root-signals.ts). root_samples: what a cluster looked like each round (a queue's oldest age, a node's
  // shell-loop time, OOM restarts), the baselines the next rounds compare to. root_findings: what is wrong now, how long it has
  // lasted, and whether רותם and the owner were told.
  `
  CREATE TABLE IF NOT EXISTS root_samples (cluster TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL);
  CREATE INDEX IF NOT EXISTS root_samples_key ON root_samples(cluster, key, ts);
  CREATE TABLE IF NOT EXISTS root_findings (
    cluster TEXT NOT NULL, key TEXT NOT NULL, signal TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
    first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, rounds INTEGER NOT NULL, misses INTEGER NOT NULL DEFAULT 0, alone INTEGER NOT NULL DEFAULT 0,
    lead_at INTEGER, owner_at INTEGER, PRIMARY KEY (cluster, key));
  `,
  // v34: a message for the record only (an update that asks nothing of its reader): it never wakes anyone, and goes in with
  // the recipient's next turn or shift (mailbox.ts heldFyi). Not work waiting either: a queued one keeps no shift up.
  `ALTER TABLE messages ADD COLUMN fyi INTEGER NOT NULL DEFAULT 0;`,
  // v35: when the worker began to answer his message (its first streamed word after it read it): with created_at and
  // handled_at, how long he waited for a word and for the whole reply, per worker (reply-times.ts).
  `ALTER TABLE messages ADD COLUMN first_word_at INTEGER;`,
  // v36: an ask or GO he left 48 hours went back to the manager (inbox.ts returnStale): out of "מחכות לך", kept as it was.
  `ALTER TABLE inbox ADD COLUMN returned_at INTEGER;`,
  // v37: notification intent and durable coalescing, shared by web and linked phones.
  `ALTER TABLE messages ADD COLUMN alert_hint TEXT CHECK (alert_hint IN ('fyi','eta'));
   ALTER TABLE conversations ADD COLUMN alert_level TEXT;
   ALTER TABLE conversations ADD COLUMN last_sound_at INTEGER;
   ALTER TABLE conversations ADD COLUMN pending_alert TEXT;
   ALTER TABLE conversations ADD COLUMN pending_due INTEGER;
   ALTER TABLE tasks ADD COLUMN for_owner INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tasks ADD COLUMN owner_done_at INTEGER;`,
  // v38: resumable uploads and derived representations.
  `ALTER TABLE uploads ADD COLUMN meta TEXT;
   CREATE TABLE upload_sessions (id TEXT PRIMARY KEY, name TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, upload_id TEXT);
   CREATE TABLE upload_parts (session TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE, part INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(session, part));`,
  // v39: artifact cards survive content expiration; links are signed per version.
  `CREATE TABLE artifacts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, task_id INTEGER, title TEXT NOT NULL, latest INTEGER NOT NULL, expires_at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, expired INTEGER NOT NULL DEFAULT 0, message_id TEXT NOT NULL, thumb TEXT);
   CREATE TABLE artifact_versions (artifact TEXT NOT NULL REFERENCES artifacts(id), version INTEGER NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL, note TEXT NOT NULL, network INTEGER NOT NULL DEFAULT 0, op_id TEXT NOT NULL UNIQUE, ready INTEGER NOT NULL DEFAULT 0, warnings TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(artifact,version));`,

  // v40: indexed task provenance and bounded task activity, without scanning the event log on polling.
  `CREATE INDEX IF NOT EXISTS tasks_identity_start ON tasks(identity, started_at);
   CREATE INDEX IF NOT EXISTS events_task_activity ON events(json_extract(data, '$.id'), seq)
     WHERE type IN ('task.new','task.state','task.awaiting','task.labels','task.priority');`,

  // v41, phase E: versioned acknowledgement, scoped to the device that gave it.
  `CREATE TABLE consents (version TEXT NOT NULL, device TEXT NOT NULL, language TEXT NOT NULL,
    accepted_at INTEGER NOT NULL, PRIMARY KEY(version, device));`,
];

/** The switches a new store starts with. `manager`: the manager's name in their descriptions (org.yaml, CompanyNames). */
export const defaultToggles = (manager: string): { key: string; enabled: boolean; description: string }[] => [
  { key: 'scheduler', enabled: true, description: 'המתזמן ממלא משבצות פנויות מהתור' },
  { key: 'residents', enabled: true, description: `התושבים (${manager}) רצים תמיד` },
  { key: 'escalation', enabled: true, description: `שאלה חוסמת שלא נענתה עוברת ${pre('ל', manager)}` },
  { key: 'push', enabled: true, description: 'התראות: מה שחסום עליך, והודעות מעובדים' },
  { key: 'backup', enabled: true, description: 'גיבוי hq.db כל שעה' },
  { key: 'focus', enabled: false, description: 'מצב פוקוס: רק תקלה דחופה בפרודקשן מתריעה' },
  { key: 'night', enabled: false, description: 'מצב לילה (B.16)' },
];

type Listener = (e: HqEvent) => void;

export class Store {
  readonly db: DB;
  private listeners = new Set<Listener>();
  now: () => number;

  constructor(path: string, opts: { now?: () => number; managerName?: string } = {}) {
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
    this.seedToggles(opts.managerName ?? DEFAULT_NAMES.manager.name);
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

  private seedToggles(manager: string): void {
    const ins = this.db.prepare(
      'INSERT OR IGNORE INTO toggles (key, enabled, description, updated_at) VALUES (?, ?, ?, ?)');
    for (const t of defaultToggles(manager)) ins.run(t.key, t.enabled ? 1 : 0, t.description, this.now());
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

  /** Events after [seq], oldest first. [tail]: the newest [limit] of them (still oldest first), for a history that must
   *  end at now: a busy conversation has more than [limit] in its window, and its first ones hid its latest text (lumo-t552 25/10). */
  eventsAfter(seq: number, limit = 500, identity?: string, tail = false): HqEvent[] {
    const order = tail ? 'DESC' : 'ASC';
    const rows = (identity
      ? this.db.prepare(`SELECT * FROM events WHERE seq > ? AND identity = ? ORDER BY seq ${order} LIMIT ?`).all(seq, identity, limit)
      : this.db.prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ${order} LIMIT ?`).all(seq, limit)) as
      { seq: number; ts: number; type: string; identity: string | null; data: string }[];
    if (tail) rows.reverse();
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

  /** A switch that exists only with its config (a node, nodes.ts): created once, then his to flip. */
  ensureToggle(key: string, enabled: boolean, description: string): void {
    this.db.prepare('INSERT OR IGNORE INTO toggles (key, enabled, description, updated_at) VALUES (?, ?, ?, ?)')
      .run(key, enabled ? 1 : 0, description, this.now());
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
