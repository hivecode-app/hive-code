// Test doubles: a protocol-speaking fake shift-host on a real unix socket, and a launcher that starts it.
import { createServer, type Server, type Socket } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LineSplitter, decodeHqFrame, encodeFrame, type HostToHq, type HqToHost, type LoggedFrame, type EngineEvent,
} from '@company/shared';
import { loadConfig, type HqConfig } from '../src/config.ts';
import { Hq, type HqDeps } from '../src/hq.ts';
import type { LaunchSpec, Launcher } from '../src/shifts.ts';
import type { PhoneCallbacks, PhoneSize, TabBrowser } from '../src/tab/browser.ts';
import type { WebSocket as WsSocket } from 'ws';

export class Clock {
  t = Date.UTC(2026, 9, 20, 9, 0, 0); // fixed: fake hosts stamp frames from this clock too
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

export type HostMode = 'echo' | 'mute';

type DeliveryRec = { uuid: string; state: 'written' | 'delivered' | 'started' | 'completed' | 'failed' };

/** What survives a host restart for one shift id: the durable log and the delivery map (like the real host). */
export class ShiftDisk {
  log: LoggedFrame[] = [];
  logId = randomUUID();
  delivered = new Map<string, DeliveryRec>();
}

/**
 * Protocol-speaking fake shift-host on a real unix socket. Mirrors the real host where hq depends on it:
 * the log and deliveries persist per shift id across restarts (and `written` turns `failed` on restart),
 * `send` is idempotent on msgId unless retry:true re-sends something never accepted, `stop` replies
 * before the host is gone.
 */
export class FakeHost {
  server: Server;
  sent: { msgId: string; text: string; priority: string; retry: boolean; stopIfSafe: boolean }[] = [];
  /** What a real host would say the next `stopIfSafe` send waits for (an unsafe tool running). */
  waitingOn: Record<string, unknown> | null = null;
  received: HqToHost[] = [];
  clients = new Set<Socket>();
  sockets = new Set<Socket>();
  spool: { cursor: string; ts: string; event: string; payload: unknown }[] = [];
  spoolAcked: string | null = null;
  claudePid: number = process.pid;
  mode: HostMode;
  readonly spec: LaunchSpec;
  readonly disk: ShiftDisk;
  private now: () => number;
  iso() { return new Date(this.now()).toISOString(); }

  constructor(spec: LaunchSpec, mode: HostMode, disk: ShiftDisk, now: () => number = Date.now) {
    this.spec = spec;
    this.mode = mode;
    this.disk = disk;
    this.now = now;
    this.server = createServer((s) => this.onClient(s));
    this.push({ t: 'lifecycle', ts: this.iso(), state: 'starting', sessionId: spec.sessionId, resume: spec.resume } as Omit<LoggedFrame, 'seq'>);
    // Restart of a host on the same log: whatever claude never accepted is failed (real host: "host restarted").
    for (const [msgId, d] of disk.delivered) {
      if (d.state === 'written') {
        d.state = 'failed';
        this.push({ t: 'delivery', ts: this.iso(), msgId, uuid: d.uuid, state: 'failed', error: 'host restarted' } as Omit<LoggedFrame, 'seq'>);
      }
    }
  }

  get log() { return this.disk.log; }

  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(this.spec.socketPath, () => r()));
  }

  private nextSeq() { return (this.disk.log.at(-1)?.seq ?? 0) + 1; }

  push(f: Omit<LoggedFrame, 'seq'>): LoggedFrame {
    const frame = { ...f, seq: this.nextSeq() } as LoggedFrame;
    this.disk.log.push(frame);
    for (const c of this.clients) c.write(encodeFrame(frame));
    return frame;
  }

  event(ev: EngineEvent) { return this.push({ t: 'event', ts: this.iso(), ev } as Omit<LoggedFrame, 'seq'>); }

  /** Live-only frames (not logged): streaming deltas, spool notifications. */
  live(f: HostToHq) { for (const c of this.clients) c.write(encodeFrame(f)); }

  deliveryState(msgId: string, state: 'started' | 'completed') {
    const d = this.disk.delivered.get(msgId)!;
    d.state = state;
    return this.push({ t: 'delivery', ts: this.iso(), msgId, uuid: d.uuid, state } as Omit<LoggedFrame, 'seq'>);
  }

  private onClient(s: Socket) {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    const write = (f: HostToHq) => s.write(encodeFrame(f));
    const split = new LineSplitter((line) => {
      const f = decodeHqFrame(line);
      this.received.push(f);
      switch (f.t) {
        case 'hello': {
          const lastSeq = this.disk.log.at(-1)?.seq ?? 0;
          write({ t: 'hello', v: 1, info: { shift: this.spec.shiftId, identity: this.spec.identity, sessionId: this.spec.sessionId,
            cwd: this.spec.cwd, logId: this.disk.logId, lastSeq, hostPid: process.pid, claudePid: this.claudePid, claudeProcStart: null,
            claudeVersion: '2.1.303', startedAt: this.iso(), state: 'idle', lastEventAt: null, activeTools: [] } });
          // Protocol: a different logId or since > lastSeq ⇒ replay from 0.
          const since = f.logId !== this.disk.logId || f.since > lastSeq ? 0 : f.since;
          for (const l of this.disk.log) if (l.seq > since) write(l);
          this.clients.add(s);
          write({ t: 'live', lastSeq: this.disk.log.at(-1)?.seq ?? 0 });
          break;
        }
        case 'send': {
          const known = this.disk.delivered.get(f.msgId);
          // retry only re-sends what never got accepted; anything accepted stays single (real host).
          if (known && !(f.retry && (known.state === 'written' || known.state === 'failed'))) {
            write({ t: 'reply', re: f.id, ok: true, data: { ...known } });
            break;
          }
          const uuid = randomUUID();
          this.sent.push({ msgId: f.msgId, text: f.text, priority: f.priority, retry: f.retry === true, stopIfSafe: f.stopIfSafe === true });
          this.disk.delivered.set(f.msgId, { uuid, state: 'written' });
          this.push({ t: 'delivery', ts: this.iso(), msgId: f.msgId, uuid, state: 'written' } as Omit<LoggedFrame, 'seq'>);
          write({ t: 'reply', re: f.id, ok: true, data: { uuid, state: 'written', ...(f.stopIfSafe && this.waitingOn ? { waitingOn: this.waitingOn } : {}) } });
          if (this.mode === 'echo') {
            this.disk.delivered.set(f.msgId, { uuid, state: 'delivered' });
            this.push({ t: 'delivery', ts: this.iso(), msgId: f.msgId, uuid, state: 'delivered' } as Omit<LoggedFrame, 'seq'>);
          }
          break;
        }
        case 'ping': case 'interrupt': case 'status': case 'usage': case 'context':
          write({ t: 'reply', re: f.id, ok: true });
          break;
        case 'spool_read':
          write({ t: 'spool', re: f.id, entries: this.spool.filter((e) => !f.cursor || e.cursor > f.cursor),
            cursor: this.spool.at(-1)?.cursor ?? f.cursor, more: false });
          break;
        case 'spool_ack':
          this.spoolAcked = f.cursor;
          write({ t: 'reply', re: f.id, ok: true });
          break;
        case 'stop':
          // Real host: answers right away, then stops claude and exits a little later.
          write({ t: 'reply', re: f.id, ok: true, data: { stopping: true } });
          setTimeout(() => {
            // Already killed (systemd stop waits until the process is gone): a dead host writes nothing more.
            if (this.closed) return;
            this.push({ t: 'lifecycle', ts: this.iso(), state: 'exited', exitCode: 0, note: f.reason } as Omit<LoggedFrame, 'seq'>);
            void this.close();
          }, 20);
          break;
      }
    });
    s.on('data', (d) => split.push(d));
    s.on('close', () => this.clients.delete(s));
    s.on('error', () => {});
  }

  closed = false;
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.sockets) c.destroy();
    this.clients.clear();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

export class FakeLauncher implements Launcher {
  launches: LaunchSpec[] = [];
  hosts = new Map<string, FakeHost>();
  all: FakeHost[] = [];
  disks = new Map<string, ShiftDisk>();
  kills: string[] = [];
  mode: HostMode = 'echo';
  fail = false;
  closed = false;
  now: () => number = Date.now;

  async launch(spec: LaunchSpec) {
    this.launches.push(spec);
    if (this.fail) throw new Error('systemd-run failed (test)');
    if (this.closed) throw new Error('launcher closed');
    const prev = this.hosts.get(spec.shiftId);
    // Like systemd-run with a unit that is still active: a second host for the same shift is refused.
    if (prev && !prev.closed) throw new Error(`Unit ${spec.unit} or a host for ${spec.shiftId} is still running`);
    rmSync(spec.socketPath, { force: true });
    if (!this.disks.has(spec.shiftId)) this.disks.set(spec.shiftId, new ShiftDisk());
    const h = new FakeHost(spec, this.mode, this.disks.get(spec.shiftId)!, this.now);
    await h.listen();
    if (this.closed) { await h.close(); throw new Error('launcher closed'); }
    this.hosts.set(spec.shiftId, h);
    this.all.push(h);
    return { unit: spec.unit };
  }

  async kill(shiftId: string) {
    this.kills.push(shiftId);
    const h = this.hosts.get(shiftId);
    // Like the real host under `disable --now`: it logs its own `exited` before going away.
    if (h && !h.closed) h.push({ t: 'lifecycle', ts: h.iso(), state: 'exited', exitCode: 0, note: 'stopped' } as Omit<LoggedFrame, 'seq'>);
    await h?.close().catch(() => {});
  }

  /** systemd restarted the host (crash after linger, or boot with the unit enabled): same log, new run. */
  async restartBySystemd(shiftId: string, opts: { listen?: boolean } = {}): Promise<FakeHost> {
    const old = this.hosts.get(shiftId)!;
    if (!old.closed) {
      old.push({ t: 'lifecycle', ts: old.iso(), state: 'exited', exitCode: null, signal: 'SIGTERM', note: 'systemd stop' } as Omit<LoggedFrame, 'seq'>);
      await old.close();
    }
    rmSync(old.spec.socketPath, { force: true });
    const h = new FakeHost(old.spec, this.mode, this.disks.get(shiftId)!, this.now);
    if (opts.listen !== false) await h.listen();
    this.hosts.set(shiftId, h);
    this.all.push(h);
    return h;
  }

  async closeAll() {
    this.closed = true;
    for (const h of this.all) await h.close().catch(() => {});
  }
}

// Same shape as company/org.yaml (the contract): teams reference ids, identities carry the people.
/** The shared Chrome, faked: tests never touch the real browser on 9222. */
export class FakeTabBrowser implements TabBrowser {
  targets = new Set<string>(['agent-tab']);
  opened: string[] = [];
  closed: string[] = [];
  released: { targetId: string; tell?: string }[] = [];
  phones: { targetId: string; phone: WsSocket; size: PhoneSize; cb: PhoneCallbacks }[] = [];
  onTargetGone: (targetId: string) => void = () => {};
  onConnected: () => void = () => {};
  async openWindow(url: string) { const id = `win-${this.opened.length + 1}`; this.opened.push(url); this.targets.add(id); return id; }
  async hasTarget(id: string) { return this.targets.has(id); }
  async closeTarget(id: string) { this.closed.push(id); this.targets.delete(id); }
  async attachPhone(targetId: string, phone: WsSocket, size: PhoneSize, cb: PhoneCallbacks) {
    this.phones.push({ targetId, phone, size, cb });
    phone.send(JSON.stringify({ t: 'url', url: 'https://github.com/login' }));
    phone.on('message', (raw) => { if (JSON.parse(raw.toString()).t === 'done') cb.onDone('https://github.com/'); });
  }
  async release(targetId: string, tell?: string) {
    this.released.push({ targetId, tell });
    for (const p of this.phones.filter((x) => x.targetId === targetId)) { if (tell) p.phone.send(JSON.stringify({ t: tell })); p.phone.close(); }
  }
  async clearStale() {}
}

export const ORG_YAML = `
version: 1
owner: ran
owner_name: רן
owner_gender: male
manager: yoav
monitoring_lead: rotem
teams:
  - {id: management, kind: permanent, symbol: account_tree, lead: yoav, members: []}
  - {id: monitoring, kind: permanent, symbol: monitor_heart, lead: rotem, members: []}
  - {id: personal, kind: permanent, symbol: group, lead: eli, members: [amit]}
  - {id: agent-company, kind: project, project: agent-company, symbol: domain, lead: ac-ceo, members: []}
identities:
  - {id: yoav, name: יואב, title: מנהל החברה, symbol: explore, team: management, reports_to: ran, lifecycle: always-on, resident: true}
  - id: rotem
    name: רותם
    title: ראש צוות הניטור
    symbol: shield
    team: monitoring
    reports_to: yoav
    lifecycle: always-on
    automations:
      - {id: prod-probes, what: probe-runner, enabled: true}
      - {id: ci-host-heartbeat, what: heartbeat, enabled: false}
  - {id: eli, name: אלי, title: ראש הצוות האישי, symbol: person, team: personal, reports_to: yoav, lifecycle: always-on}
  - {id: amit, name: עמית, title: מומחה כספים, symbol: payments, team: personal, reports_to: eli, lifecycle: dormant, memory_domain: personal/finance}
  - {id: ac-ceo, name: שירה, title: מנכ"לית agent-company, symbol: architecture, team: agent-company, reports_to: yoav, kind: project, lifecycle: always-on}
`;

export interface TestEnv {
  hq: Hq; cfg: HqConfig; clock: Clock; launcher: FakeLauncher; dir: string;
  telegrams: string[]; webPushes: { endpoint: string; payload: string }[]; tabBrowser: FakeTabBrowser;
  cleanup(): Promise<void>;
}

export async function makeEnv(opts: { cfg?: Partial<HqConfig>; deps?: HqDeps; projects?: Record<string, string>; noStart?: boolean; org?: string } = {}): Promise<TestEnv> {
  const dir = mkdtempSync(join(tmpdir(), 'hq-'));
  const company = join(dir, 'company');
  mkdirSync(join(company, 'projects'), { recursive: true });
  mkdirSync(join(dir, 'memory')); // the company's memory/: memory-files writes only where there is one
  writeFileSync(join(company, 'org.yaml'), opts.org ?? ORG_YAML);
  for (const [p, md] of Object.entries(opts.projects ?? {})) writeFileSync(join(company, 'projects', `${p}.md`), md);
  // claudeHome: never the real ~/.claude (its token would go to /api/oauth/profile from a test).
  const cfg = loadConfig({ stateDir: join(dir, 'state'), companyDir: company, port: 0, claudeHome: join(dir, 'claude-home'), appReleaseDir: join(dir, 'app-release'), probeWitness: null, ...opts.cfg });
  // The phone listener stays off unless a test asks for it (it would collide on 7422 across test files).
  cfg.tab.listen = opts.cfg?.tab?.listen ?? null;
  const clock = new Clock();
  const launcher = new FakeLauncher();
  launcher.now = clock.now;
  const telegrams: string[] = [];
  const webPushes: { endpoint: string; payload: string }[] = [];
  const tabBrowser = new FakeTabBrowser();
  const hq = new Hq(cfg, {
    tabBrowser,
    launcher, now: clock.now,
    telegram: async (t) => { telegrams.push(t); },
    webPush: async (sub, payload) => { webPushes.push({ endpoint: sub.endpoint, payload }); },
    ...opts.deps,
  });
  hq.scheduler.memInfo = () => ({ totalMb: 23_000, availableMb: 19_000 });
  hq.scheduler.loadInfo = () => ({ load1: 0.5, cpus: 8 });
  if (!opts.noStart) await hq.start({ listen: false, timers: false });
  return {
    hq, cfg, clock, launcher, dir, telegrams, webPushes, tabBrowser,
    async cleanup() {
      await hq.stop().catch(() => {});
      await launcher.closeAll();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function until(cond: () => boolean, ms = 3000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// A real temp repository and a charter over it, for worktree tests (B.5).
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
export const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();

/** origin (bare) + a checkout on main with one commit and .worktrees/ ignored. */
export function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  const origin = join(dir, 'origin.git');
  const checkout = join(dir, 'proj');
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(dir, 'clone', '--quiet', origin, checkout);
  writeFileSync(join(checkout, '.gitignore'), '.worktrees/\nnode_modules/\n');
  writeFileSync(join(checkout, 'README.md'), 'hi\n');
  git(checkout, 'add', '.');
  git(checkout, 'commit', '--quiet', '-m', 'init');
  git(checkout, 'push', '--quiet', 'origin', 'HEAD:main');
  return { dir, checkout, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const charter = (checkout: string, status = 'active', machine = hostname()) => `---
project: proj
status: ${status}
repo: hive-owner/proj
machine: ${machine}
checkouts:
  - name: proj
    path: ${checkout}
    default_branch: main
worktree_dir: .worktrees
commands:
  test: npm test
ci: required
ci_check: company-ci
deviations: []
monitoring: []
grants: []
---

# proj
`;
