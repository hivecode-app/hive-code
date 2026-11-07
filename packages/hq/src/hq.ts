import { applyWorkSettings, setupCommand, type SetupCommand } from './onboarding.ts';
// `company hq` composition root: one process (B.1) wiring store, mailboxes, inbox, scheduler,
// watchdog, probe-runner, push, backups and the API. Timers are plain intervals; every loop is
// independently guarded so one failing loop never stops the others.
import { g, loadNames, OWNER, pre } from '@company/shared';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { HqConfig } from './config.ts';
import { Store } from './store.ts';
import { readCharter, repoOfWorktree } from './workspace.ts';
import { syncOrg, getIdentity, listIdentities, listProjects, listTones, projectLead, renameTaskWorkers } from './org.ts';
import { Inbox } from './inbox.ts';
import { Artifacts } from './artifacts.ts';
import { ownerCompletions } from './owner-completions.ts';
import { Conversations } from './conversations.ts';
import { AwaitingBoard, DEPLOY_STUCK_MS } from './awaiting.ts';
import { LIVE_EVERY_MS, LiveWatch, type LiveGit, type LiveRun } from './live.ts';
import { recordedTaskPrs } from './task-prs.ts';
import { Estimates } from './estimates.ts';
import { Access, type JobRunner } from './access.ts';
import { Leases } from './leases.ts';
import { ShiftManager, TemplateLauncher, type Launcher, type ConnectionFactory } from './shifts.ts';
import { Mailbox, noForeignInjector, type ForeignInjector } from './mailbox.ts';
import { Uploads } from './uploads.ts';
import { AppReleases } from './app-release.ts';
import { Scheduler } from './scheduler.ts';
import { Night, type IssueSource } from './night.ts';
import { Watchdog } from './watchdog.ts';
import { Rotator } from './rotation.ts';
import { ProbeRunner } from './probes.ts';
import { Pusher, loadOrCreateVapid, telegramVia, type TelegramSend, type WebPushSend } from './push.ts';
import { fcmFromFile, type FcmSend } from './fcm.ts';
import { backupOnce } from './backup.ts';
import { board } from './board.ts';
import { openedBy, openTasks } from './open-tasks.ts';
import { Home } from './home.ts';
import { MemoryFiles, type Run } from './memory-files.ts';
import { PressureWatch } from './pressure-watch.ts';
import { UnidentifiedWatch } from './unidentified-watch.ts';
import { CodemagicWatch } from './codemagic-watch.ts';
import { DiskWatch } from './disk-watch.ts';
import { Resources, SAMPLE_EVERY_MS } from './resources.ts';
import { StallWatch, type OpenFilesReader } from './stall-watch.ts';
import { ErrorWatch } from './error-watch.ts';
import { startApi, loadOrCreateToken, health, type ApiServer } from './api.ts';
import { Auth } from './auth.ts';
import { Ingest, startIngestSocket, type Ticketer } from './ingest.ts';
import { AccountManager, type AccountDeps } from './accounts.ts';
import { TabHandoffs } from './tab/handoffs.ts';
import { CdpTabBrowser, type TabBrowser } from './tab/browser.ts';
import { startTabServer, type TabServer } from './tab/server.ts';
import { PasskeyVault } from './tab/passkeys.ts';
import { clockOf, hhmm, readTimeZone } from './timezone.ts';
import { LoopWatch } from './loop-watch.ts';
import { UsageFeed } from './usage.ts';
import { AUTOMATION as FREEZE_AUTOMATION, FREEZE_COUNT, FREEZE_REF, FreezeWatch, freezeItem } from './freeze-watch.ts';
import { CodexQuota, type CodexLimitsReader } from './codex-quota.ts';
import { LOCAL, Nodes, RoutingLauncher, nodeToggle, type RemoteNode, type SshRun } from './nodes.ts';

/** A broken key file turns FCM off (the old socket and Telegram still work) rather than keeping hq down. */
function fcmOrOff(file: string): FcmSend | null {
  try { return fcmFromFile(file); } catch (e) { console.error(`fcm off: ${(e as Error).message}`); return null; }
}
/** The phone view's own diagnostics go to the journal, not the event log (frames and taps are not events). */
const tabLog = (msg: string, data?: unknown) => console.log(`tab: ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);

export interface HqDeps {
  launcher?: Launcher;
  connect?: ConnectionFactory;
  foreign?: ForeignInjector;
  telegram?: TelegramSend;
  webPush?: WebPushSend;
  /** FCM HTTP v1 (fcm.ts); default: the key in stateDir/fcm-service-account.json, none = FCM off. null = off. */
  fcm?: FcmSend | null;
  ticketer?: Ticketer;
  issues?: IssueSource;
  accounts?: AccountDeps;
  tabBrowser?: TabBrowser;
  /** git/gh runner for the rolling memory PR (memory-files.ts). */
  memoryRun?: Run;
  /** The open-*.md of a project, for stall-watch.ts (default: the company repo). */
  openFiles?: OpenFilesReader;
  /** ssh for the nodes (nodes.ts). */
  ssh?: SshRun;
  /** Starts the jobs of request_access (access.ts). */
  accessRunner?: JobRunner;
  /** Reads Codex's rate limits (codex-quota.ts; default: a short-lived `codex app-server`). */
  codexLimits?: CodexLimitsReader;
  setupCommand?: SetupCommand;
  /** What production runs (live.ts): GitHub, and the charters' `live:` commands. */
  liveGit?: LiveGit;
  liveRun?: LiveRun;
  now?: () => number;
}

/** The adapter (engine lane) exposes injectForeign; use it when present, otherwise a visible-failure stub. */
async function loadForeignInjector(): Promise<ForeignInjector> {
  try {
    const mod = (await import('@company/adapter' as string)) as { injectForeign?: ForeignInjector['injectForeign'] };
    if (typeof mod.injectForeign === 'function') return { injectForeign: mod.injectForeign };
  } catch { /* not built yet */ }
  return noForeignInjector;
}

/** Constructed on first use so `--state <dir>` for tooling (token, backup) doesn't trip the template check. */
function lazyTemplateLauncher(cfg: HqConfig): Launcher {
  let l: TemplateLauncher | null = null;
  const get = () => (l ??= new TemplateLauncher(cfg.stateDir, cfg.shiftTemplate));
  return { launch: (s) => get().launch(s), kill: (id, u) => get().kill(id, u) };
}

export class Hq {
  readonly setupCommand: SetupCommand;
  readonly store: Store;
  readonly auth: Auth;
  readonly inbox: Inbox;
  readonly conversations: Conversations;
  readonly awaiting: AwaitingBoard;
  readonly live: LiveWatch;
  readonly estimates: Estimates;
  readonly access: Access;
  readonly leases: Leases;
  readonly shifts: ShiftManager;
  readonly mailbox: Mailbox;
  readonly artifacts: Artifacts;
  readonly uploads: Uploads;
  readonly appReleases: AppReleases;
  readonly scheduler: Scheduler;
  readonly night: Night;
  readonly watchdog: Watchdog;
  readonly rotator: Rotator;
  readonly probes: ProbeRunner;
  readonly pusher: Pusher;
  readonly ingest: Ingest;
  readonly accounts: AccountManager;
  /** Codex's weekly quota, for task workers on Codex (codex-quota.ts). */
  readonly codexQuota: CodexQuota;
  readonly tab: TabHandoffs;
  passkeys?: PasskeyVault;
  readonly home: Home;
  /** The usage card's events, kept in memory (usage.ts, task 1505): GET /api/home never reads the log. */
  readonly usageFeed: UsageFeed;
  readonly memoryFiles: MemoryFiles;
  readonly stallWatch: StallWatch;
  readonly errorWatch: ErrorWatch;
  readonly pressureWatch: PressureWatch;
  readonly unidentifiedWatch: UnidentifiedWatch;
  readonly codemagicWatch: CodemagicWatch;
  readonly diskWatch: DiskWatch;
  readonly resources: Resources;
  readonly nodes: Nodes;
  /** hq's own event loop, frozen (loop-watch.ts): `hq.event_loop_stall`. */
  readonly loopWatch = new LoopWatch((r) => this.store.emit('hq.event_loop_stall', null, r), { onBegin: (w) => this.freezeWatch.mark(w) });
  /** hq frozen for 45 seconds: a worker thread kills it for systemd to restart, and the next one tells him (freeze-watch.ts). */
  readonly freezeWatch: FreezeWatch;
  private tabServer: TabServer | null = null;
  private ingestServer: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private api: ApiServer | null = null;
  private healthServer: Server | null = null;

  readonly cfg: HqConfig;
  constructor(cfg: HqConfig, deps: HqDeps = {}) {
    this.setupCommand = deps.setupCommand ?? setupCommand;
    this.cfg = cfg;
    this.store = new Store(cfg.dbPath, { now: deps.now, managerName: loadNames(cfg.companyDir, cfg.managerId).manager.name });
    this.store.ensureToggle('codex/lean', cfg.codexLean ?? false, 'Codex זמני: רק פניות שלך, עובד פעיל אחד בכל רגע');
    cfg.codexLean = this.store.toggle('codex/lean');
    this.inbox = new Inbox(this.store);
    this.auth = new Auth(this.store, cfg.auth);
    this.nodes = new Nodes(cfg.nodes, cfg.stateDir, deps.ssh);
    // A node's switch, on by default: off, nothing new starts there (what runs there finishes there).
    for (const n of cfg.nodes) this.store.ensureToggle(nodeToggle(n.name), true, `משמרות משימה רצות גם על ${n.name}`);
    // A launcher given by the caller (tests) launches on every machine itself.
    const launcher = deps.launcher ?? (cfg.nodes.length ? new RoutingLauncher(lazyTemplateLauncher(cfg), this.nodes, cfg.stateDir) : lazyTemplateLauncher(cfg));
    this.shifts = new ShiftManager(this.store, cfg, launcher, deps.connect);
    this.shifts.nodes = this.nodes;
    this.uploads = new Uploads(this.store, cfg.stateDir, cfg.dictate);
    this.appReleases = new AppReleases(cfg.appReleaseDir);
    this.mailbox = new Mailbox(this.store, cfg, this.shifts, this.inbox, deps.foreign ?? noForeignInjector, this.uploads);
    this.artifacts = new Artifacts(this.store, cfg.stateDir, this.mailbox, cfg.auth.appUrl);
    this.scheduler = new Scheduler(this.store, cfg, this.shifts, this.mailbox);
    this.scheduler.nodes = this.nodes;
    this.scheduler.pollNode = (n) => this.pollNode(n);
    this.night = new Night(this.store, cfg, this.scheduler, this.mailbox, this.inbox, deps.issues);
    this.accounts = new AccountManager(this.store, cfg, this.shifts, this.mailbox, this.inbox, deps.accounts);
    this.codexQuota = new CodexQuota(this.store, cfg, deps.codexLimits);
    this.scheduler.codexBlocked = () => this.codexQuota.blocked();
    this.night.accountsFull = () => this.accounts.allFull();
    this.watchdog = new Watchdog(this.store, cfg, this.shifts, this.mailbox, this.inbox);
    this.rotator = new Rotator(this.store, cfg, this.shifts, this.mailbox);
    this.watchdog.rotator = this.rotator;
    this.probes = new ProbeRunner(this.store, cfg, this.mailbox, this.inbox);
    this.pusher = new Pusher(this.store, this.inbox, this.auth, cfg, loadOrCreateVapid(cfg.stateDir, cfg.pushContact),
      deps.telegram ?? telegramVia(cfg.telegramCmd, cfg.telegramChat), deps.webPush,
      deps.fcm !== undefined ? deps.fcm : fcmOrOff(join(cfg.stateDir, 'fcm-service-account.json')));
    this.store.onEvent((e) => this.pusher.onEvent(e.type));
    // A revoked device's phone stops getting pushes at once, as its socket closes (api.ts).
    this.auth.onRevoke((ids) => { for (const id of ids) this.pusher.unregisterFcm(id); });
    // The CDP connection is opened on first use, so an hq with no handoff never touches Chrome.
    this.tab = new TabHandoffs(this.store, this.inbox, this.mailbox, cfg.tab, deps.tabBrowser ?? new CdpTabBrowser(cfg.tab.cdpUrl, tabLog));
    this.ingest = new Ingest(this, deps.ticketer);
    this.usageFeed = new UsageFeed(this.store);
    this.freezeWatch = new FreezeWatch(join(cfg.stateDir, 'freeze.json'));
    this.home = new Home(this);
    this.memoryFiles = new MemoryFiles(this, deps.memoryRun);
    this.stallWatch = new StallWatch(this, deps.openFiles);
    this.errorWatch = new ErrorWatch(this);
    this.pressureWatch = new PressureWatch(this);
    this.unidentifiedWatch = new UnidentifiedWatch(this);
    this.codemagicWatch = new CodemagicWatch(this);
    this.diskWatch = new DiskWatch(this);
    this.resources = new Resources(this);
    this.shifts.primeRecall = (identity, query) => this.ingest.primeRecall(identity, query);
    this.inbox.setNotifier((item) => this.store.bg(this.pusher.notify(item), 'push.notify'));
    // task 986: a fault of the system (an incident, a failed delivery or shift) is the manager's, the moment it comes in.
    // He hears from the manager only what is blocked on him. A fault the error-catcher caught goes there as an ask (mailbox.ask).
    this.inbox.setRouter((item) => {
      if (item.kind === 'ask') return;
      const kind = { incident: 'תקלה', delivery_failure: 'הודעה שלא נמסרה', shift_failure: 'עובד שנפל ולא קם' }[item.kind as string] ?? item.kind;
      const from = item.from_identity && item.from_identity !== this.cfg.managerId ? ` (${pre('מ', this.mailbox.label(item.from_identity))})` : '';
      this.mailbox.tell({ msg_id: `inbox-${item.id}-to-manager`, from: 'hq', to: this.cfg.managerId, kind: 'system', ref: item.ref ?? `inbox-${item.id}`,
        priority: item.urgency === 'urgent' ? 'now' : 'next', urgency: item.urgency,
        body: [`${kind}${from}: ${item.title}`, item.body.slice(0, 2000),
          `זה מגיע אליך ולא ${pre('ל', this.mailbox.names.owner.name)}: תקלות מערכת הן שלך. מעבירים לו רק מה שחסום עליו, כשאלה או בקשת GO.`].filter(Boolean).join('\n\n') });
    }, this.cfg.managerId);
    this.awaiting = new AwaitingBoard(this.store, this.inbox);
    // Whose the card is and who hears "נכשל": the task's opener, else its project's lead, else the manager. One that
    // can't hear it (gone from org.yaml, or a task worker whose task closed) is skipped: the message would bounce
    // back to him as a delivery failure (21/10).
    // The PR's link under the decision: the project's repo from its charter.
    this.awaiting.repoOf = (project, worktree) => repoOfWorktree(readCharter(this.cfg.companyDir, project), worktree);
    this.awaiting.defaultRepoOf = (project) => readCharter(this.cfg.companyDir, project)?.checkouts[0]?.repo ?? null;
    this.awaiting.checkoutsOf = (project) => (readCharter(this.cfg.companyDir, project)?.checkouts ?? []).map((c) => ({ name: c.name, repo: c.repo }));
    this.awaiting.prLinksOf = (id) => recordedTaskPrs(this.store, id);
    this.live = new LiveWatch(this.store, this.awaiting, (project) => readCharter(this.cfg.companyDir, project)?.live ?? [],
      { git: deps.liveGit, run: deps.liveRun, companyDir: this.cfg.companyDir });
    this.awaiting.openerOf = (t) => [openedBy(t), t.project ? projectLead(this.store, t.project) : null, this.cfg.managerId]
      .find((id): id is string => !!id && id !== OWNER && !!getIdentity(this.store, id)?.active && !this.mailbox.taskClosed(id)) ?? null;
    // #219: "נכשל" on a task's card reaches the opener at once, with no details: if he has any, he writes them in
    // that conversation afterwards, as a message of his own. "בוצע" only takes the task off; nobody is woken for it.
    // #297: "לא רלוונטי" takes it off too, and the opener hears that it was closed as such, not that something broke.
    this.awaiting.onOutcome = (t, itemId, to, outcome) => {
      const o = this.mailbox.names.owner;
      const what = t.awaiting_note ?? t.summary ?? t.title;
      if (outcome === 'irrelevant') {
        this.mailbox.tell({ msg_id: `inbox-${itemId}-irrelevant`, from: OWNER, to, kind: 'answer', ref: `task-${t.id}`, priority: 'next',
          body: `${o.name} ${g(o, 'סגר', 'סגרה')} כ"לא רלוונטי" את מה שחיכה ${g(o, 'לו', 'לה')} במשימה ${t.id} (${t.title}): ${what}\nזה לא דיווח על תקלה: אין מה לתקן. המשימה ירדה מ"מחכה לך".` });
        return;
      }
      this.mailbox.tell({ msg_id: `inbox-${itemId}-failed`, from: OWNER, to, kind: 'answer', ref: `task-${t.id}`, priority: 'now',
        body: `${o.name} ${g(o, 'סימן', 'סימנה')} "נכשל" על משימה ${t.id} (${t.title}): ${what}\nאם יש פרטים, הם יגיעו ${g(o, 'ממנו', 'ממנה')} בהודעה נפרדת. המשימה ירדה מ"מחכה לך".` });
    };
    // task 986: a task to check is a card in the opener's conversation, with a line there that says what to check.
    this.awaiting.onCard = (t, itemId, from) => {
      this.mailbox.tell({ msg_id: `inbox-${itemId}-check`, from: from ?? this.cfg.managerId, to: OWNER, kind: 'tell', ref: `task-${t.id}`, priority: 'next',
        alert_hint: this.conversations.soundedRecently(from) || this.conversations.soundedRecently(t.identity) ? 'eta' : null,
        body: `${t.awaiting === 'verify' ? 'לבדוק לפני שחרור' : 'לבדוק'}: ${t.awaiting_note ?? t.summary ?? t.title}` });
    };
    // A deploy is never his card: its opener bundles what waits in the project into one GO (once per wait).
    this.awaiting.onStuck = (t, to) => {
      this.mailbox.tell({ msg_id: `task-${t.id}-deploy-stuck-${t.awaiting_at}`, from: 'hq', to, kind: 'system', ref: `task-${t.id}`, priority: 'next',
        body: `משימה ${t.id} (${t.title}${t.pr ? `, PR #${t.pr}` : ''}) מוזגה ומחכה לפריסה כבר ${Math.round(DEPLOY_STUCK_MS / 3600_000)} שעות, בלי בקשת GO. `
          + `מאחדים את כל מה שמחכה לפריסה בפרויקט לבקשת GO אחת (request_go). אם היא כבר נפרסה ו-hq לא ראה: חסר באמנה חלק ב-\`live:\` שמראה מה רץ בפרודקשן (למה היא נשארת: GET /api/deploys/live). עד שיתוקן: status עם awaiting: "none" על המשימה.` });
    };
    this.estimates = new Estimates(this.store);
    this.access = new Access(this, deps.accessRunner);
    this.leases = new Leases(this);
    this.scheduler.heldMb = () => this.leases.heldMb(LOCAL);
    this.shifts.on('ended', (row) => this.leases.releaseShift(row.id));
    this.night.estimates = this.estimates;
    this.scheduler.onTaskDone = (id) => { this.estimates.cancelForTask(id); this.awaiting.followUpDone(id); this.store.db.prepare('UPDATE tasks SET owner_done_at = COALESCE(owner_done_at, ?) WHERE id = ? AND for_owner = 1').run(this.store.now(), id); };
    this.scheduler.onTaskFrozen = (id, by) => this.estimates.freezeForTask(id, by);
    this.scheduler.onSweep = () => {
      if (!this.store.toggle('scheduler')) return;
      this.estimates.remind((to, msg_id, body) => { this.mailbox.tell({ msg_id, from: 'hq', to, kind: 'system', priority: 'next', body }); }, this.etaTimeZone(),
        (id) => { const m = getIdentity(this.store, id)?.reports_to ?? this.cfg.managerId; return m === 'owner' || m === id ? null : m; });
    };
    this.conversations = new Conversations(this.store, (id) => this.conversationTitle(id));
    this.conversations.setAlert((m) => this.store.bg(this.pusher.notifyMessage(m), 'push.message'));
    this.pusher.titleOf = (id) => this.conversationTitle(id);
    this.shifts.on('delta', (row, ev) => this.store.publish('engine.delta', row.identity, { shift: row.id, ...ev }));
    // A Codex task worker out of quota mid-task (codex-quota.ts): the opener hears it once per task, and it stays on Codex.
    // A fresh shift of a task worker may carry no task id: its task is found by the identity (like shifts.codexTask).
    this.shifts.on('codexLimit', (row, text) => {
      type T = { id: number; ref: string | null; title: string; project: string | null; labels: string };
      const t = (row.task_id != null
        ? this.store.db.prepare('SELECT id, ref, title, project, labels FROM tasks WHERE id = ?').get(row.task_id)
        : this.store.db.prepare(`SELECT t.id, t.ref, t.title, t.project, t.labels FROM tasks t JOIN identities i ON i.id = t.identity
            WHERE t.identity = ? AND i.team_kind = 'task' ORDER BY t.updated_at DESC LIMIT 1`).get(row.identity)) as T | undefined;
      if (!t) return;
      // Once per task per Codex week: another week's limit on the same task is news again.
      const reset = this.codexQuota.state()?.resetsAt;
      const week = reset != null && reset > this.store.now() ? reset : 'unknown';
      const msgId = `task-${t.id}-codex-limit-${week}`;
      if (this.mailbox.get(msgId)) return;
      this.store.bg(this.codexQuota.refresh(), 'codex-quota.refresh');
      const to = openedBy(t) ?? (t.project ? projectLead(this.store, t.project) : undefined) ?? this.cfg.managerId;
      this.store.emit('codex.limit', row.identity, { task: t.id, shift: row.id, text: text.slice(0, 300) });
      this.mailbox.tell({ msg_id: msgId, from: 'hq', to, priority: 'next',
        body: `משימה ${t.ref ?? `#${t.id}`} (${t.title}) נעצרה באמצע: מכסת Codex נגמרה. היא לא עברה ל-Claude. `
          + `העבודה שלה נשארה בענף וב-worktree. אם להמשיך על Claude, סוגרים אותה (\`close_team\`) ופותחים משימה חדשה בלי \`engine\` שממשיכה מהענף.` });
    });
    this.shifts.on('launchFailed', (identity, shiftId, err) => {
      this.store.emit('shift.launch_failed', identity, { shift: shiftId, error: err.message });
    });
  }

  /** The company's time zone, org.yaml `timezone` (#121). Everything that knows what hour it is for him reads this. */
  timeZone(): string { return readTimeZone(this.cfg.companyDir); }

  /** #301: the zone a worker's `eta_at` without a zone is read in (hq.config.json `etaTimeZone`). Workers think in Israel time,
   *  wherever he is: org.yaml's `timezone` follows him, this does not. */
  etaTimeZone(): string { return this.cfg.etaTimeZone; }

  /** For the app: the zone and its offset now. */
  clock() { return clockOf(this.timeZone(), this.store.now()); }

  board() { return board(this.store, this.cfg.timers.livenessMs * 3, this.timeZone(), this.tones()); }

  /** org.yaml's tones, read at most once a minute: the board is asked for on every refresh. */
  private toneCache: { at: number; tones: ReturnType<typeof listTones> } | null = null;
  private tones() {
    const now = Date.now();
    if (!this.toneCache || now - this.toneCache.at > 60_000) this.toneCache = { at: now, tones: listTones(this.cfg.companyDir) };
    return this.toneCache.tones;
  }

  /** "בעבודה ובתור" (#128): every task not done, with who opened it, who is on it and why it waits. */
  openTasks(b = this.board()) { return openTasks(this.store, this.scheduler, b, () => this.resources.busy()); }

  teams() {
    // A project's team shows the owner's name for the project (org.yaml `projects[].name`), or null.
    const names = new Map(this.projects().map((p) => [p.id, p.name]));
    const t = new Map<string, { id: string; name: string | null; kind: string | null; project: string | null; members: string[] }>();
    for (const i of listIdentities(this.store)) {
      const key = i.team ?? 'none';
      const name = i.team_kind === 'project' && i.project ? names.get(i.project) ?? null : null;
      if (!t.has(key)) t.set(key, { id: key, name, kind: i.team_kind, project: i.project, members: [] });
      t.get(key)!.members.push(i.id);
    }
    return [...t.values()];
  }

  /** "קרן · מפתחת · voice-bot": the worker, its title, and the project its team works on when the title doesn't say it. */
  conversationTitle(id: string): string {
    const i = getIdentity(this.store, id);
    if (!i) return id;
    const project = i.team_kind === 'project' && i.project ? this.projectName(i.project) : null;
    const title = i.title && project && !i.title.includes(project) ? `${i.title} · ${project}` : i.title || project || '';
    return title ? `${i.name} · ${title}` : i.name;
  }

  /** org.yaml is read at most once a minute for names: a list of every conversation asks once per row. */
  private projectNames: { at: number; names: Map<string, string | null> } | null = null;
  projectName(id: string): string {
    const now = Date.now();
    if (!this.projectNames || now - this.projectNames.at > 60_000) {
      this.projectNames = { at: now, names: new Map(this.projects().map((p) => [p.id, p.name])) };
    }
    return this.projectNames.names.get(id) ?? id;
  }

  /** The projects in org.yaml with their charter status (the board's filter, APP-SPEC §4.5). */
  projects() { return listProjects(this.cfg.companyDir); }

  identityExists(id: string): boolean { return !!getIdentity(this.store, id); }

  reloadContract(): void {
    syncOrg(this.store, this.cfg.companyDir, this.cfg.capacity.residents, this.cfg.managerId);
    this.toneCache = null;
    renameTaskWorkers(this.store);
    this.probes.reload();
  }

  private every(ms: number, name: string, fn: () => unknown): void {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      const done = this.loopWatch.begin(`loop ${name}`);
      try { await fn(); } catch (e) { this.store.emit('loop.error', null, { loop: name, error: (e as Error).message }); }
      finally { running = false; done(); }
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  async start(opts: { listen?: boolean; timers?: boolean } = {}): Promise<void> {
    if (this.cfg.codexLean && this.store.getMeta('codex.lean_active') !== '1') this.store.setMeta('codex.lean_since', String(this.store.now()));
    this.store.setMeta('codex.lean_active', this.cfg.codexLean ? '1' : '0');
    this.reloadContract();
    applyWorkSettings(this.store, this.cfg);
    this.accounts.sync();
    // The identity check runs once at start for every account (no inference; profile + cached oauthAccount).
    for (const a of this.accounts.rows()) this.store.bg(this.accounts.verify(a.name), 'accounts.verify');
    // The nodes' health first: the first fill already knows what room they have, and their shifts can be reattached.
    await this.pollNodes();
    await this.shifts.reattachAll();
    if (!this.cfg.codexLean) await this.shifts.restoreLost(this.watchdog.procCheck);
    this.store.bg(this.ingest.drainPendingTickets(), 'open_ticket.drain');
    this.ingest.resumePendingDone();
    // #219: what waited on him before this version (and anything a crash left half-done) gets its card now.
    this.awaiting.sweep();
    this.awaiting.backfillPrRepos();
    this.store.emit('hq.started', null, { pid: process.pid });
    this.reportFreeze();
    // task 986: a fault caught while the card was still his goes to the manager, as a new one does.
    this.mailbox.caughtFaultsToManager();
    if (opts.timers !== false) {
      const T = this.cfg.timers;
      this.loopWatch.start();
      // Armed only from here: the start above (migrations, reattaching shifts) may be long, and it is not a freeze.
      this.freezeWatch.start(() => this.freezeArmed());
      this.every(1_000, 'conversation-alerts', () => this.conversations.flush());
      this.every(60_000, 'artifact-expiry', () => this.artifacts.sweep());
      this.every(30_000, 'owner-completions', () => ownerCompletions(this.store, this.mailbox));
      this.every(60_000, 'upload-expiry', () => this.uploads.sweep());
      this.every(5_000, 'mailbox', () => this.mailbox.sweep());
      if (this.nodes.list.length) this.every(30_000, 'nodes', () => this.pollNodes());
      this.every(5_000, 'spool', () => this.shifts.collectSpools());
      this.every(T.watchdogMs, 'watchdog', async () => { await this.watchdog.sweep(); await this.shifts.releaseEnded(); });
      this.every(T.livenessMs, 'liveness', () => this.shifts.pingAll());
      this.every(T.schedulerMs, 'scheduler', async () => {
        await this.scheduler.sweep();
        if (!this.cfg.codexLean) { await this.night.sweep(); this.home.watchAsked(); }
        this.awaiting.sweep();
        this.inbox.returnStale((i) => this.mailbox.returnToManager(i));
      });
      this.every(5_000, 'probes', () => this.probes.tick());
      // task 1476: "מחכה לפריסה" clears by what production runs (the charters' `live:`), now and every 30 minutes.
      this.store.bg(this.live.tick(), 'live.tick');
      this.every(LIVE_EVERY_MS, 'live', () => this.live.tick());
      // reserve (leases.ts): the ceiling of a class, a company-run that stopped answering, a place nobody takes; then whoever waits is served.
      this.every(5_000, 'leases', () => this.leases.sweep());
      this.every(30_000, 'push', () => this.pusher.sweepUnacked());
      // A handoff link never outlives its 10 minutes, and never leaves a phone viewport on a tab.
      this.every(15_000, 'tab', () => this.tab.sweep());
      this.store.bg(this.tab.clearStale(), 'tab.clearStale');
      // Passkeys the server answers itself (tab/passkeys.ts). The timer also covers a Chrome that was down at start.
      if (this.cfg.tab.passkeys) {
        this.passkeys = new PasskeyVault(join(this.cfg.stateDir, 'passkeys.json'), this.cfg.tab.cdpUrl, tabLog);
        this.store.bg(this.passkeys.coverAll(), 'passkeys.cover');
        this.every(30_000, 'passkeys', () => this.passkeys!.coverAll());
      }
      // B.7: quota per account every 10 minutes (get_usage, no inference) + the identity check again.
      this.every(T.accountsMs, 'accounts', async () => {
        // Off: an "all full" item left open closes quietly (accounts.watchFull), nothing else runs.
        if (!this.store.toggle('yoav/accounts')) { this.accounts.watchFull(); return; }
        for (const a of this.accounts.rows()) if (a.config_dir && a.health !== 'needs_login') await this.accounts.verify(a.name);
        await this.accounts.refresh();
      });
      // Codex's weekly quota (codex-quota.ts): the home's row, and the guard on new Codex tasks. First read right away.
      this.every(T.accountsMs, 'codex-quota', async () => { await this.codexQuota.refresh(); });
      this.store.bg(this.codexQuota.refresh(), 'codex-quota.refresh');
      // #115: `remember` with `file` → the rolling memory PR (memory-files.ts), when enough waits or long enough.
      this.every(10 * 60_000, 'memory-files', () => this.memoryFiles.sweep());
      // #153: a project standing still with work open wakes its lead, and then the manager.
      this.every(60_000, 'stall-watch', () => this.stallWatch.sweep());
      // error-catcher: the errors he sees, one item each for him to approve (error-watch.ts).
      this.every(30_000, 'error-catcher', () => this.errorWatch.sweep());
      // task-297: a p0 task held back for memory or load for 10 minutes → one incident for him, with the top processes.
      this.every(30_000, 'pressure-watch', () => this.pressureWatch.sweep());
      // resources stage 3: a consumer no project owns holding a lot of memory for an hour → one item for him.
      this.every(60_000, 'unidentified-watch', () => this.unidentifiedWatch.sweep());
      // task-1192: Codemagic's macOS minutes this month, once a day; past 400, 800 and 1,500 → one message to him.
      this.every(10 * 60_000, 'codemagic-minutes', () => this.codemagicWatch.sweep());
      // task-382: the disk at 85% → scripts/disk-clean.mjs now; at 92% after it → one urgent item with the biggest consumers.
      this.every(5 * 60_000, 'disk-watch', () => this.diskWatch.sweep());
      // resources stage 1: disk, memory, cgroups and docker of each machine, by project (reads a node only while its poll says it is up).
      this.every(SAMPLE_EVERY_MS, 'resources', () => this.resources.sample());
      this.every(T.backupMs, 'backup', async () => {
        if (!this.store.toggle('backup')) return;
        await backupOnce(this.store, join(this.cfg.stateDir, 'backups'), this.cfg.backups);
        this.probes.prune();
        this.store.pruneEvents();
      });
      // First quota read right away, so placement doesn't wait 10 minutes for numbers.
      if (this.store.toggle('yoav/accounts')) this.store.bg(this.accounts.refresh(), 'accounts.refresh');
      // A lead that was added to org.yaml and never ran wakes now, not on the first message it happens to get (#68).
      this.scheduler.wakeNewLeads();
      await this.scheduler.sweep();
    }
    if (opts.listen !== false) {
      this.api = await startApi(this, loadOrCreateToken(this.cfg.stateDir), this.cfg.host, this.cfg.port);
      if (this.cfg.healthListen) this.healthServer = await this.startHealthListener(this.cfg.healthListen);
      if (this.cfg.tab.listen) {
        const i = this.cfg.tab.listen.lastIndexOf(':');
        this.tabServer = await startTabServer(this.tab, this.cfg.tab.listen.slice(0, i), Number(this.cfg.tab.listen.slice(i + 1)),
          tabLog);
      }
      // mcp-company and hooks write here (company-api.ts); 0600 socket, no token.
      this.ingestServer = await startIngestSocket(this.ingest, join(this.cfg.stateDir, 'hq.sock'));
    }
  }

  /**
   * Memory and load of every node whose switch is on or that still runs shifts. A node that stops answering (or comes
   * back) is an event, and the manager hears of it once while shifts or the switch depend on it (no false quiet).
   */
  async pollNodes(): Promise<void> {
    await Promise.all(this.nodes.list.map((n) => this.pollNode(n)));
  }

  /** One node's poll (pollNodes, and the scheduler right before a start there, #224). Polls of one node at once share one. */
  pollNode(n: RemoteNode): Promise<void> {
    const name = n.def.name;
    let p = this.polling.get(name);
    if (!p) {
      p = this.pollNodeOnce(n).finally(() => this.polling.delete(name));
      this.polling.set(name, p);
    }
    return p;
  }

  private polling = new Map<string, Promise<void>>();

  private async pollNodeOnce(n: RemoteNode): Promise<void> {
    const name = n.def.name;
    const running = (this.store.db.prepare(`SELECT COUNT(*) n FROM shifts WHERE state IN ('starting','live') AND machine = ?`).get(name) as { n: number }).n;
    // Switched off, and nothing of ours left there (no shift, no open task with its worktree there): leave it alone.
    const placed = this.store.db.prepare(`SELECT 1 FROM tasks WHERE machine = ? AND (state != 'done' OR worktree IS NOT NULL) LIMIT 1`).get(name);
    if (!this.store.toggle(nodeToggle(name)) && !running && !placed) { if (n.connected) n.close(); n.status = null; return; }
    const was = n.status?.up;
    const st = await n.poll(this.store.now());
    if (was === st.up || (was === undefined && st.up)) return;
    this.store.emit(st.up ? 'node.up' : 'node.down', null, { node: name, error: st.error, running });
    // A laptop that sleeps with nothing of ours running is its everyday, not news.
    if (!st.up && (running || !n.def.portable)) {
      this.mailbox.tell({ msg_id: `node-down-${name}-${this.store.now()}`, from: 'hq', to: this.cfg.managerId, priority: 'next',
        body: `השרת ${name} לא עונה (${st.error ?? 'בלי פרטים'}). ${running ? `${running} משמרות רצות שם, וה-watchdog יסמן אותן כמתות. ` : ''}משימות חדשות לא יוצאות אליו עד שיחזור. כיבוי: המתג \`${nodeToggle(name)}\` באוטומציות.` });
    }
  }

  get port(): number | null { return this.api?.port ?? null; }
  get tabPort(): number | null { return this.tabServer?.port ?? null; }

  /** Optional second listener that serves only GET /health — for the ci-host heartbeat, nothing else exposed. */
  private startHealthListener(spec: string): Promise<Server> {
    const i = spec.lastIndexOf(':');
    const host = spec.slice(0, i), port = Number(spec.slice(i + 1));
    const s = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
        const h = health(this);
        res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(h));
      } else { res.writeHead(404); res.end(); }
    });
    return new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, host, () => resolve(s)); });
  }

  /** Runtime switch: preserve sessions/tasks and park the idle workers of the previous provider. */
  async setCodexLean(enabled: boolean): Promise<void> {
    if (this.mailbox.deliveryPaused) throw new Error('החלפת מצב כבר מתבצעת');
    if (enabled === this.cfg.codexLean) return;
    const owned = this.shifts.active().filter((s) => s.kind !== 'foreign');
    if (owned.some((s) => s.in_turn || s.long_tool || s.state === 'starting') || this.mailbox.leanBusy()) {
      throw new Error('יש עובד פעיל; אפשר להחליף מצב אחרי שיסיים');
    }
    this.mailbox.deliveryPaused = true;
    this.shifts.suspendStarts = true;
    try {
      for (const row of owned) await this.shifts.stop(row.id, 'provider_change', row.started_at);
      if (enabled) this.store.setMeta('codex.lean_since', String(this.store.now()));
      this.cfg.codexLean = enabled;
      this.store.setToggle('codex/lean', enabled, true);
      this.store.setMeta('codex.lean_active', enabled ? '1' : '0');
      this.store.emit('codex.lean', null, { enabled });
    } finally {
      this.shifts.suspendStarts = false;
      this.mailbox.deliveryPaused = false;
    }
  }

  /** The identity whose org.yaml automations hold `freeze-watch`; null = no such automation. */
  private freezeOwner(): string | null {
    const r = this.store.db.prepare(`SELECT key FROM toggles WHERE key LIKE ? ORDER BY key LIMIT 1`).get(`%/${FREEZE_AUTOMATION}`) as { key: string } | undefined;
    return r ? r.key.slice(0, -(FREEZE_AUTOMATION.length + 1)) : null;
  }

  private freezeArmed(): boolean {
    const o = this.freezeOwner();
    return !!o && this.store.toggle(`${o}/${FREEZE_AUTOMATION}`);
  }

  /** The last hq froze and was killed (freeze-watch.ts): one urgent item for him, from the automation's owner. Freezing again
   *  while it is open (a machine still thrashing) updates it with the count: one item, not one per restart. */
  private reportFreeze(): void {
    const r = this.freezeWatch.takeReport();
    if (!r) return;
    this.store.emit('hq.freeze', null, r);
    const owner = this.freezeOwner();
    if (!owner) return;
    const tz = this.timeZone();
    // The count is kept, not derived from timestamps: the item and the first event are written a moment apart.
    const open = this.store.db.prepare(`SELECT 1 FROM inbox WHERE kind = 'incident' AND ref = ? AND state = 'open' LIMIT 1`).get(FREEZE_REF);
    if (open) {
      const times = Math.max(1, Number(this.store.getMeta(FREEZE_COUNT) ?? 1)) + 1;
      this.store.setMeta(FREEZE_COUNT, String(times));
      this.inbox.updateByRef('incident', FREEZE_REF, freezeItem(r, (ms) => hhmm(ms, tz), times));
      return;
    }
    this.store.setMeta(FREEZE_COUNT, '1');
    const { title, body } = freezeItem(r, (ms) => hhmm(ms, tz));
    this.inbox.add({ kind: 'incident', urgency: 'urgent', from_identity: owner, ref: FREEZE_REF, dedupe_key: `freeze-${r.at}`, title, body });
  }

  async stop(): Promise<void> {
    await this.freezeWatch.stop();
    this.loopWatch.stop();
    this.pusher.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.accounts.stop();
    await this.api?.close();
    await this.tabServer?.close();
    this.tab.browser.close?.();
    this.passkeys?.close();
    await new Promise<void>((r) => (this.healthServer ? this.healthServer.close(() => r()) : r()));
    if (this.ingestServer) { this.ingestServer.closeAllConnections(); await new Promise<void>((r) => this.ingestServer!.close(() => r())); }
    // Shift-hosts are separate units and keep running across hq restarts (B.5): only drop our sockets.
    await this.ingest.drain();
    await this.shifts.drain();
    this.shifts.closeAll();
    this.nodes.close();
    await this.uploads.drain();
    await this.artifacts.drain();
    this.store.close();
  }
}

export { loadForeignInjector };
