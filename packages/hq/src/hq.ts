// `company hq` composition root: one process (B.1) wiring store, mailboxes, inbox, scheduler,
// watchdog, probe-runner, push, backups and the API. Timers are plain intervals; every loop is
// independently guarded so one failing loop never stops the others.
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import type { HqConfig } from './config.ts';
import { Store } from './store.ts';
import { syncOrg, getIdentity, listIdentities } from './org.ts';
import { Inbox } from './inbox.ts';
import { ShiftManager, TemplateLauncher, type Launcher, type ConnectionFactory } from './shifts.ts';
import { Mailbox, noForeignInjector, type ForeignInjector } from './mailbox.ts';
import { Scheduler } from './scheduler.ts';
import { Watchdog } from './watchdog.ts';
import { ProbeRunner } from './probes.ts';
import { Pusher, loadOrCreateVapid, telegramVia, type TelegramSend, type WebPushSend } from './push.ts';
import { backupOnce } from './backup.ts';
import { board } from './board.ts';
import { startApi, loadOrCreateToken, health, type ApiServer } from './api.ts';
import { Ingest, startIngestSocket, type Ticketer } from './ingest.ts';

export interface HqDeps {
  launcher?: Launcher;
  connect?: ConnectionFactory;
  foreign?: ForeignInjector;
  telegram?: TelegramSend;
  webPush?: WebPushSend;
  ticketer?: Ticketer;
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
  readonly inbox: Inbox;
  readonly shifts: ShiftManager;
  readonly mailbox: Mailbox;
  readonly scheduler: Scheduler;
  readonly watchdog: Watchdog;
  readonly probes: ProbeRunner;
  readonly pusher: Pusher;
  readonly ingest: Ingest;
  private ingestServer: Server | null = null;
  private timers: NodeJS.Timeout[] = [];
  private api: ApiServer | null = null;
  private healthServer: Server | null = null;

  readonly cfg: HqConfig;
  constructor(cfg: HqConfig, deps: HqDeps = {}) {
    this.cfg = cfg;
    this.store = new Store(cfg.dbPath, { now: deps.now });
    this.inbox = new Inbox(this.store);
    this.shifts = new ShiftManager(this.store, cfg, deps.launcher ?? lazyTemplateLauncher(cfg), deps.connect);
    this.mailbox = new Mailbox(this.store, cfg, this.shifts, this.inbox, deps.foreign ?? noForeignInjector);
    this.scheduler = new Scheduler(this.store, cfg, this.shifts, this.mailbox);
    this.watchdog = new Watchdog(this.store, cfg, this.shifts, this.mailbox, this.inbox);
    this.probes = new ProbeRunner(this.store, cfg, this.mailbox);
    this.pusher = new Pusher(this.store, this.inbox, cfg, loadOrCreateVapid(cfg.stateDir),
      deps.telegram ?? telegramVia(cfg.telegramCmd, cfg.telegramChat), deps.webPush);
    this.ingest = new Ingest(this, deps.ticketer);
    this.shifts.primeRecall = (identity, query) => this.ingest.primeRecall(identity, query);
    this.inbox.setNotifier((item) => this.store.bg(this.pusher.notify(item), 'push.notify'));
    this.shifts.on('delta', (row, ev) => this.store.publish('engine.delta', row.identity, { shift: row.id, ...ev }));
    this.shifts.on('launchFailed', (identity, shiftId, err) => {
      this.store.emit('shift.launch_failed', identity, { shift: shiftId, error: err.message });
    });
  }

  board() { return board(this.store, this.cfg.timers.livenessMs * 3); }

  teams() {
    const t = new Map<string, { id: string; kind: string | null; project: string | null; members: string[] }>();
    for (const i of listIdentities(this.store)) {
      const key = i.team ?? 'none';
      if (!t.has(key)) t.set(key, { id: key, kind: i.team_kind, project: i.project, members: [] });
      t.get(key)!.members.push(i.id);
    }
    return [...t.values()];
  }

  identityExists(id: string): boolean { return !!getIdentity(this.store, id); }

  reloadContract(): void {
    syncOrg(this.store, this.cfg.companyDir, this.cfg.capacity.residents, this.cfg.managerId);
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
    await this.shifts.reattachAll();
    await this.shifts.restoreLost(this.watchdog.procCheck);
    this.store.bg(this.ingest.drainPendingTickets(), 'open_ticket.drain');
    this.store.emit('hq.started', null, { pid: process.pid });
    if (opts.timers !== false) {
      const T = this.cfg.timers;
      this.every(5_000, 'mailbox', () => this.mailbox.sweep());
      this.every(5_000, 'spool', () => this.shifts.collectSpools());
      this.every(T.watchdogMs, 'watchdog', async () => { await this.watchdog.sweep(); await this.shifts.releaseEnded(); });
      this.every(T.livenessMs, 'liveness', () => this.shifts.pingAll());
      this.every(T.schedulerMs, 'scheduler', () => this.scheduler.sweep());
      this.every(5_000, 'probes', () => this.probes.tick());
      this.every(30_000, 'push', () => this.pusher.sweepUnacked());
      this.every(T.backupMs, 'backup', async () => {
        if (!this.store.toggle('backup')) return;
        await backupOnce(this.store, join(this.cfg.stateDir, 'backups'), this.cfg.backupsKeep);
        this.probes.prune();
        this.store.pruneEvents();
      });
      await this.scheduler.sweep();
    }
    if (opts.listen !== false) {
      this.api = await startApi(this, loadOrCreateToken(this.cfg.stateDir), this.cfg.host, this.cfg.port);
      if (this.cfg.healthListen) this.healthServer = await this.startHealthListener(this.cfg.healthListen);
      // mcp-company and hooks write here (company-api.ts); 0600 socket, no token.
      this.ingestServer = await startIngestSocket(this.ingest, join(this.cfg.stateDir, 'hq.sock'));
    }
  }

  get port(): number | null { return this.api?.port ?? null; }

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
    await this.api?.close();
    await new Promise<void>((r) => (this.healthServer ? this.healthServer.close(() => r()) : r()));
    if (this.ingestServer) { this.ingestServer.closeAllConnections(); await new Promise<void>((r) => this.ingestServer!.close(() => r())); }
    // Shift-hosts are separate units and keep running across hq restarts (B.5): only drop our sockets.
    await this.shifts.drain();
    this.shifts.closeAll();
    this.store.close();
  }
}

export { loadForeignInjector };
