// `company hq` composition root: one process (B.1) wiring store, mailboxes, inbox, scheduler,
// watchdog, probe-runner, push, backups and the API. Timers are plain intervals; every loop is
// independently guarded so one failing loop never stops the others.
import { g, loadNames, OWNER } from '@company/shared';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { HqConfig } from './config.ts';
import { Store } from './store.ts';
import { readCharter, repoOfWorktree } from './workspace.ts';
import { syncOrg, getIdentity, listIdentities, listProjects, listTones, projectLead, renameTaskWorkers } from './org.ts';
import { Inbox } from './inbox.ts';
import { Conversations } from './conversations.ts';
import { AwaitingBoard } from './awaiting.ts';
import { Estimates } from './estimates.ts';
import { Access, type JobRunner } from './access.ts';
import { ShiftManager, TemplateLauncher, type Launcher, type ConnectionFactory } from './shifts.ts';
import { Mailbox, noForeignInjector, type ForeignInjector } from './mailbox.ts';
import { Uploads } from './uploads.ts';
import { AppReleases } from './app-release.ts';
import { Scheduler } from './scheduler.ts';
import { Night, type IssueSource } from './night.ts';
import { Watchdog } from './watchdog.ts';
import { ProbeRunner } from './probes.ts';
import { Pusher, loadOrCreateVapid, telegramVia, type TelegramSend, type WebPushSend } from './push.ts';
import { backupOnce } from './backup.ts';
import { board } from './board.ts';
import { openedBy, openTasks } from './open-tasks.ts';
import { Home } from './home.ts';
import { MemoryFiles, type Run } from './memory-files.ts';
import { PressureWatch } from './pressure-watch.ts';
import { StallWatch, type OpenFilesReader } from './stall-watch.ts';
import { ErrorWatch } from './error-watch.ts';
import { startApi, loadOrCreateToken, health, type ApiServer } from './api.ts';
import { Auth } from './auth.ts';
import { Ingest, startIngestSocket, type Ticketer } from './ingest.ts';
import { AccountManager, type AccountDeps } from './accounts.ts';
import { TabHandoffs } from './tab/handoffs.ts';
import { CdpTabBrowser, type TabBrowser } from './tab/browser.ts';
import { startTabServer, type TabServer } from './tab/server.ts';
import { clockOf, readTimeZone } from './timezone.ts';
import { Nodes, RoutingLauncher, nodeToggle, type RemoteNode, type SshRun } from './nodes.ts';

/** The phone view's own diagnostics go to the journal, not the event log (frames and taps are not events). */
const tabLog = (msg: string, data?: unknown) => console.log(`tab: ${msg}${data === undefined ? '' : ` ${JSON.stringify(data)}`}`);

export interface HqDeps {
  launcher?: Launcher;
  connect?: ConnectionFactory;
  foreign?: ForeignInjector;
  telegram?: TelegramSend;
  webPush?: WebPushSend;
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
  readonly store: Store;
  readonly auth: Auth;
  readonly inbox: Inbox;
  readonly conversations: Conversations;
  readonly awaiting: AwaitingBoard;
  readonly estimates: Estimates;
  readonly access: Access;
  readonly shifts: ShiftManager;
  readonly mailbox: Mailbox;
  readonly uploads: Uploads;
  readonly appReleases: AppReleases;
  readonly scheduler: Scheduler;
  readonly night: Night;
  readonly watchdog: Watchdog;
  readonly probes: ProbeRunner;
  readonly pusher: Pusher;
  readonly ingest: Ingest;
  readonly accounts: AccountManager;
  readonly tab: TabHandoffs;
  readonly home: Home;
  readonly memoryFiles: MemoryFiles;
  readonly stallWatch: StallWatch;
  readonly errorWatch: ErrorWatch;
  readonly pressureWatch: PressureWatch;
  readonly nodes: Nodes;
  private tabServer: TabServer | null = null;
  private ingestServer: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private api: ApiServer | null = null;
  private healthServer: Server | null = null;

  readonly cfg: HqConfig;
  constructor(cfg: HqConfig, deps: HqDeps = {}) {
    this.cfg = cfg;
    this.store = new Store(cfg.dbPath, { now: deps.now, managerName: loadNames(cfg.companyDir, cfg.managerId).manager.name });
    this.inbox = new Inbox(this.store);
    this.auth = new Auth(this.store, cfg.auth);
    this.nodes = new Nodes(cfg.nodes, cfg.stateDir, deps.ssh);
    // A node's switch, on by default: off, nothing new starts there (what runs there finishes there).
    for (const n of cfg.nodes) this.store.ensureToggle(nodeToggle(n.name), true, `משמרות משימה רצות גם על ${n.name}`);
    // A launcher given by the caller (tests) launches on every machine itself.
    const launcher = deps.launcher ?? (cfg.nodes.length ? new RoutingLauncher(lazyTemplateLauncher(cfg), this.nodes, cfg.stateDir) : lazyTemplateLauncher(cfg));
    this.shifts = new ShiftManager(this.store, cfg, launcher, deps.connect);
    this.shifts.nodes = this.nodes;
    this.uploads = new Uploads(this.store, cfg.stateDir);
    this.appReleases = new AppReleases(cfg.appReleaseDir);
    this.mailbox = new Mailbox(this.store, cfg, this.shifts, this.inbox, deps.foreign ?? noForeignInjector, this.uploads);
    this.scheduler = new Scheduler(this.store, cfg, this.shifts, this.mailbox);
    this.scheduler.nodes = this.nodes;
    this.scheduler.pollNode = (n) => this.pollNode(n);
    this.night = new Night(this.store, cfg, this.scheduler, this.mailbox, this.inbox, deps.issues);
    this.accounts = new AccountManager(this.store, cfg, this.shifts, this.mailbox, this.inbox, deps.accounts);
    this.watchdog = new Watchdog(this.store, cfg, this.shifts, this.mailbox, this.inbox);
    this.probes = new ProbeRunner(this.store, cfg, this.mailbox);
    this.pusher = new Pusher(this.store, this.inbox, this.auth, cfg, loadOrCreateVapid(cfg.stateDir, cfg.pushContact),
      deps.telegram ?? telegramVia(cfg.telegramCmd, cfg.telegramChat), deps.webPush);
    // The CDP connection is opened on first use, so an hq with no handoff never touches Chrome.
    this.tab = new TabHandoffs(this.store, this.inbox, this.mailbox, cfg.tab, deps.tabBrowser ?? new CdpTabBrowser(cfg.tab.cdpUrl, tabLog));
    this.ingest = new Ingest(this, deps.ticketer);
    this.home = new Home(this);
    this.memoryFiles = new MemoryFiles(this, deps.memoryRun);
    this.stallWatch = new StallWatch(this, deps.openFiles);
    this.errorWatch = new ErrorWatch(this);
    this.pressureWatch = new PressureWatch(this);
    this.shifts.primeRecall = (identity, query) => this.ingest.primeRecall(identity, query);
    this.inbox.setNotifier((item) => this.store.bg(this.pusher.notify(item), 'push.notify'));
    this.awaiting = new AwaitingBoard(this.store, this.inbox);
    // Whose the card is and who hears "נכשל": the task's opener, else its project's lead, else the manager. One that
    // can't hear it (gone from org.yaml, or a task worker whose task closed) is skipped: the message would bounce
    // back to him as a delivery failure (21/10).
    // The PR's link under the decision: the project's repo from its charter.
    this.awaiting.repoOf = (project, worktree) => repoOfWorktree(readCharter(this.cfg.companyDir, project), worktree);
    this.awaiting.openerOf = (t) => [openedBy(t), t.project ? projectLead(this.store, t.project) : null, this.cfg.managerId]
      .find((id): id is string => !!id && id !== OWNER && !!getIdentity(this.store, id)?.active && !this.mailbox.taskClosed(id)) ?? null;
    // #219: "נכשל" on a task's card reaches the opener at once, with no details: if he has any, he writes them in
    // that conversation afterwards, as a message of his own. "בוצע" only takes the task off; nobody is woken for it.
    this.awaiting.onOutcome = (t, itemId, to) => {
      const o = this.mailbox.names.owner;
      const what = t.awaiting_note ?? t.summary ?? t.title;
      this.mailbox.tell({ msg_id: `inbox-${itemId}-failed`, from: OWNER, to, kind: 'answer', ref: `task-${t.id}`, priority: 'now',
        body: `${o.name} ${g(o, 'סימן', 'סימנה')} "נכשל" על משימה ${t.id} (${t.title}): ${what}\nאם יש פרטים, הם יגיעו ${g(o, 'ממנו', 'ממנה')} בהודעה נפרדת. המשימה ירדה מ"מחכה לך".` });
    };
    this.estimates = new Estimates(this.store);
    this.access = new Access(this, deps.accessRunner);
    this.night.estimates = this.estimates;
    this.scheduler.onTaskDone = (id) => this.estimates.cancelForTask(id);
    this.scheduler.onSweep = () => {
      if (!this.store.toggle('scheduler')) return;
      this.estimates.remind((to, msg_id, body) => { this.mailbox.tell({ msg_id, from: 'hq', to, kind: 'system', priority: 'next', body }); }, this.timeZone(),
        (id) => { const m = getIdentity(this.store, id)?.reports_to ?? this.cfg.managerId; return m === 'owner' || m === id ? null : m; });
    };
    this.conversations = new Conversations(this.store, (id) => this.conversationTitle(id));
    this.conversations.setAlert((m) => this.store.bg(this.pusher.notifyMessage(m), 'push.message'));
    this.pusher.titleOf = (id) => this.conversationTitle(id);
    this.shifts.on('delta', (row, ev) => this.store.publish('engine.delta', row.identity, { shift: row.id, ...ev }));
    this.shifts.on('launchFailed', (identity, shiftId, err) => {
      this.store.emit('shift.launch_failed', identity, { shift: shiftId, error: err.message });
    });
  }

  /** The company's time zone, org.yaml `timezone` (#121). Everything that knows what hour it is for him reads this. */
  timeZone(): string { return readTimeZone(this.cfg.companyDir); }

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
  openTasks(b = this.board()) { return openTasks(this.store, this.scheduler, b); }

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
  private projectName(id: string): string {
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
      try { await fn(); } catch (e) { this.store.emit('loop.error', null, { loop: name, error: (e as Error).message }); }
      finally { running = false; }
    }, ms);
    t.unref();
    this.timers.push(t);
  }

  async start(opts: { listen?: boolean; timers?: boolean } = {}): Promise<void> {
    this.reloadContract();
    this.accounts.sync();
    // The identity check runs once at start for every account (no inference; profile + cached oauthAccount).
    for (const a of this.accounts.rows()) this.store.bg(this.accounts.verify(a.name), 'accounts.verify');
    // The nodes' health first: the first fill already knows what room they have, and their shifts can be reattached.
    await this.pollNodes();
    await this.shifts.reattachAll();
    await this.shifts.restoreLost(this.watchdog.procCheck);
    this.store.bg(this.ingest.drainPendingTickets(), 'open_ticket.drain');
    this.ingest.resumePendingDone();
    // #219: what waited on him before this version (and anything a crash left half-done) gets its card now.
    this.awaiting.sweep();
    this.store.emit('hq.started', null, { pid: process.pid });
    if (opts.timers !== false) {
      const T = this.cfg.timers;
      this.every(5_000, 'mailbox', () => this.mailbox.sweep());
      if (this.nodes.list.length) this.every(30_000, 'nodes', () => this.pollNodes());
      this.every(5_000, 'spool', () => this.shifts.collectSpools());
      this.every(T.watchdogMs, 'watchdog', async () => { await this.watchdog.sweep(); await this.shifts.releaseEnded(); });
      this.every(T.livenessMs, 'liveness', () => this.shifts.pingAll());
      this.every(T.schedulerMs, 'scheduler', async () => { await this.scheduler.sweep(); await this.night.sweep(); this.home.sweep(); this.home.watchAsked(); this.awaiting.sweep(); });
      this.every(5_000, 'probes', () => this.probes.tick());
      this.every(30_000, 'push', () => this.pusher.sweepUnacked());
      // A handoff link never outlives its 10 minutes, and never leaves a phone viewport on a tab.
      this.every(15_000, 'tab', () => this.tab.sweep());
      this.store.bg(this.tab.clearStale(), 'tab.clearStale');
      // B.7: quota per account every 10 minutes (get_usage, no inference) + the identity check again.
      this.every(T.accountsMs, 'accounts', async () => {
        if (!this.store.toggle('yoav/accounts')) return;
        for (const a of this.accounts.rows()) if (a.config_dir && a.health !== 'needs_login') await this.accounts.verify(a.name);
        await this.accounts.refresh();
      });
      // #115: `remember` with `file` → the rolling memory PR (memory-files.ts), when enough waits or long enough.
      this.every(10 * 60_000, 'memory-files', () => this.memoryFiles.sweep());
      // #153: a project standing still with work open wakes its lead, and then the manager.
      this.every(60_000, 'stall-watch', () => this.stallWatch.sweep());
      // error-catcher: the errors he sees, one item each for him to approve (error-watch.ts).
      this.every(30_000, 'error-catcher', () => this.errorWatch.sweep());
      // task-297: a p0 task held back for memory or load for 10 minutes → one incident for him, with the top processes.
      this.every(30_000, 'pressure-watch', () => this.pressureWatch.sweep());
      this.every(T.backupMs, 'backup', async () => {
        if (!this.store.toggle('backup')) return;
        await backupOnce(this.store, join(this.cfg.stateDir, 'backups'), this.cfg.backupsKeep);
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
    if (!st.up) {
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

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.accounts.stop();
    await this.api?.close();
    await this.tabServer?.close();
    this.tab.browser.close?.();
    await new Promise<void>((r) => (this.healthServer ? this.healthServer.close(() => r()) : r()));
    if (this.ingestServer) { this.ingestServer.closeAllConnections(); await new Promise<void>((r) => this.ingestServer!.close(() => r())); }
    // Shift-hosts are separate units and keep running across hq restarts (B.5): only drop our sockets.
    await this.shifts.drain();
    this.shifts.closeAll();
    this.nodes.close();
    this.store.close();
  }
}

export { loadForeignInjector };
