// Remote nodes: task shifts also run on other machines, over ssh (task 199, "קיצור התור"). Leads, residents and
// everything with a browser stay here; a node takes task workers only, of the projects it lists.
//
// A node mirrors this machine's paths: the same $HOME (/home/owner, a directory there, not a user), the same
// checkouts, the same state dir. So a task's worktree, a shift's socket and its shift dir are one path on both sides,
// and nothing in the store needs to know where a path lives. scripts/node-install.sh sets a node up.
//
// One ssh master per node (ControlMaster) carries everything:
//   -R <state>/hq.sock → our hq.sock: the MCP `company` of a shift there reaches this hq;
//   -L <state>/shifts/<id>.sock per shift, added with `-O forward`: hq talks to the shift-host there as to a local one;
//   commands (systemctl, the worktree ops of workspace-cli.ts, the health read) over the same connection.
// The master is a child of hq: an hq restart opens it again, and attach() forwards each live shift again.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Charter, Checkout, CloseResult, Worktree } from './workspace.ts';
import type { Launcher, LaunchSpec } from './shifts.ts';
import { hostArgs, shiftUnit } from './shifts.ts';

/** A machine in hq.config.json `nodes`. */
export interface NodeDef {
  /** Its name on the board and in the toggle `node:<name>`; also the shifts' `machine`. */
  name: string;
  /** user@host for ssh. */
  ssh: string;
  /** ssh -i; none = ssh's own default keys. */
  identityFile?: string | null;
  /** Projects whose tasks may run there (their checkouts exist there, with what they need to build). */
  projects: string[];
  /** Cap on task shifts there, whatever the memory says. */
  maxSlots: number;
  /** No new shift while the 1-minute load average per CPU is above this. */
  maxLoad: number;
}

export const LOCAL = 'local';
export const nodeToggle = (name: string) => `node:${name}`;

/**
 * Labels that keep a task on this machine: it needs the browser (the MCP `browser` runs only here), a simulator or
 * an emulator, or someone said so. `needs-local` is the general one.
 */
export const LOCAL_LABELS = ['needs-local', 'needs-browser', 'needs-simulator'];

export interface NodeStatus {
  up: boolean; at: number; error: string | null;
  totalMb: number; availableMb: number; load1: number; cpus: number;
}

/** Thrown when the node itself could not be reached: the task waits and tries again, it does not leave the queue. */
export class NodeUnreachable extends Error { override name = 'NodeUnreachable'; }

/** ssh runner: args after `ssh`, stdin; resolves stdout, rejects with stderr. Tests substitute it. */
export type SshRun = (args: string[], input?: string, timeoutMs?: number) => Promise<string>;

export const runSsh: SshRun = (args, input, timeoutMs = 60_000) => new Promise((res, rej) => {
  const p = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
  p.stdout.on('data', (d) => { out += String(d); });
  p.stderr.on('data', (d) => { err = (err + String(d)).slice(-2000); });
  p.on('error', (e) => { clearTimeout(timer); rej(e); });
  p.on('close', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) res(out);
    else rej(Object.assign(new Error(err.trim() || (signal ? `ssh killed (${signal})` : `ssh exit ${code}`)), { code }));
  });
  p.stdin.on('error', () => { /* the remote side closed early: the exit code tells */ });
  p.stdin.end(input ?? '');
});

/** One argument for the remote shell. */
export const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** ssh's exit code for "could not connect" (and a dead control master). */
const SSH_FAILED = 255;

/** After a failed connect, this long without trying again (the 30s health poll tries next). */
const FAIL_FAST_MS = 20_000;

export class RemoteNode {
  readonly def: NodeDef;
  readonly ctlPath: string;
  status: NodeStatus | null = null;
  private master: ChildProcess | null = null;
  private opening: Promise<void> | null = null;
  /** The last failed open: within FAIL_FAST_MS everything fails at once, so a down node never stalls a sweep. */
  private failed: { at: number; error: string } | null = null;
  private forwards = new Set<string>();
  private readonly hqSock: string;
  private readonly run: SshRun;
  /** spawns the master; tests substitute it. */
  spawnMaster: (args: string[]) => ChildProcess = (args) => spawn('ssh', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  constructor(def: NodeDef, stateDir: string, run: SshRun = runSsh) {
    this.def = def;
    this.hqSock = join(stateDir, 'hq.sock');
    // A short path: unix socket paths are capped at 108 bytes.
    this.ctlPath = join(stateDir, 'nodes', `${def.name}.ctl`);
    this.run = run;
  }

  private base(): string[] {
    return [...(this.def.identityFile ? ['-i', this.def.identityFile] : []),
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10'];
  }

  get connected(): boolean { return !!this.master && this.master.exitCode == null && !this.opening; }

  /** The master connection, opened (again) when it is not up. */
  async ensure(): Promise<void> {
    if (this.connected) return;
    if (this.failed && Date.now() - this.failed.at < FAIL_FAST_MS) throw new NodeUnreachable(this.failed.error);
    this.opening ??= this.open().then(() => { this.failed = null; }, (e: Error) => {
      this.failed = { at: Date.now(), error: e.message };
      throw e;
    }).finally(() => { this.opening = null; });
    return this.opening;
  }

  private async open(): Promise<void> {
    mkdirSync(dirname(this.ctlPath), { recursive: true, mode: 0o700 });
    try {
      // A stale hq.sock there (an old master) makes the -R forward fail: the server does not unlink it.
      await this.run([...this.base(), this.def.ssh, `rm -f ${q(this.hqSock)}`], undefined, 20_000);
    } catch (e) { throw new NodeUnreachable(`${this.def.name}: ${(e as Error).message}`); }
    rmSync(this.ctlPath, { force: true });
    const m = this.spawnMaster([...this.base(), '-M', '-S', this.ctlPath, '-N',
      '-o', 'ControlPersist=no', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      // Our own end of each -L is a shift's socket path here: a file left from an earlier run is replaced.
      '-o', 'StreamLocalBindUnlink=yes',
      '-R', `${this.hqSock}:${this.hqSock}`, this.def.ssh]);
    let err = '';
    m.stderr?.on('data', (d) => { err = (err + String(d)).slice(-1000); });
    m.on('exit', () => { if (this.master === m) { this.master = null; this.forwards.clear(); } });
    this.master = m;
    for (let i = 0; i < 40; i++) {
      if (m.exitCode != null) break;
      if (await this.ctl(['-O', 'check']).then(() => true, () => false)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    m.kill();
    this.master = null;
    throw new NodeUnreachable(`${this.def.name}: ssh master did not come up${err ? `: ${err.trim()}` : ''}`);
  }

  private ctl(args: string[], input?: string, timeoutMs?: number): Promise<string> {
    return this.run(['-S', this.ctlPath, '-o', 'ControlMaster=no', ...this.base(), ...args, this.def.ssh], input, timeoutMs);
  }

  /**
   * A command there, over the master, with this machine's $HOME (the node mirrors it: git's identity, gh's login and
   * the checkouts are under it, not under the ssh user's own home). Unreachable → NodeUnreachable; failing → Error.
   */
  async exec(cmd: string, input?: string, timeoutMs?: number): Promise<string> {
    await this.ensure();
    try {
      return await this.run(['-S', this.ctlPath, '-o', 'ControlMaster=no', ...this.base(), this.def.ssh,
        `export HOME=${q(homedir())} PATH=/usr/local/bin:$PATH; ${cmd}`], input, timeoutMs);
    } catch (e) {
      if ((e as { code?: number }).code === SSH_FAILED) throw new NodeUnreachable(`${this.def.name}: ${(e as Error).message}`);
      throw e;
    }
  }

  /** hq reaches the shift-host there at the same socket path here. */
  async forward(sock: string): Promise<void> {
    await this.ensure();
    if (this.forwards.has(sock)) return;
    try { await this.ctl(['-O', 'forward', '-L', `${sock}:${sock}`], undefined, 15_000); }
    catch (e) { throw new NodeUnreachable(`${this.def.name}: forward ${sock}: ${(e as Error).message}`); }
    this.forwards.add(sock);
  }

  async unforward(sock: string): Promise<void> {
    if (!this.forwards.delete(sock) || !this.connected) return;
    await this.ctl(['-O', 'cancel', '-L', `${sock}:${sock}`], undefined, 15_000).catch(() => {});
    rmSync(sock, { force: true });
  }

  /** Memory, load and CPUs there. Never throws: an unreachable node is `up: false` with the reason. */
  async poll(now: number): Promise<NodeStatus> {
    try {
      const out = await this.exec(`grep -E '^(MemTotal|MemAvailable):' /proc/meminfo; cut -d' ' -f1 /proc/loadavg; nproc`, undefined, 20_000);
      const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(out)?.[1] ?? NaN);
      const [load1, cpus] = out.trim().split('\n').slice(-2).map(Number);
      const s = { up: true, at: now, error: null, totalMb: Math.floor(kb('MemTotal') / 1024), availableMb: Math.floor(kb('MemAvailable') / 1024),
        load1: load1 ?? NaN, cpus: cpus ?? NaN };
      if (![s.totalMb, s.availableMb, s.load1, s.cpus].every(Number.isFinite)) throw new Error(`unreadable health: ${out.slice(0, 200)}`);
      this.status = s;
    } catch (e) {
      this.status = { up: false, at: now, error: (e as Error).message.slice(0, 300), totalMb: 0, availableMb: 0, load1: 0, cpus: 0 };
    }
    return this.status;
  }

  /** git fetch from this node over the master (the preserved ref of a task closed there). */
  gitSsh(): string {
    return ['ssh', '-S', this.ctlPath, '-o', 'ControlMaster=no', ...this.base()].map((a) => (/^[\w./=@:-]+$/.test(a) ? a : q(a))).join(' ');
  }

  close(): void {
    this.master?.kill();
    this.master = null;
    this.forwards.clear();
  }
}

/** The nodes of this hq, by name. */
export class Nodes {
  readonly list: RemoteNode[];
  constructor(defs: NodeDef[], stateDir: string, run?: SshRun) {
    this.list = defs.map((d) => new RemoteNode(d, stateDir, run));
  }
  get(name: string | null | undefined): RemoteNode | undefined {
    return name && name !== LOCAL ? this.list.find((n) => n.def.name === name) : undefined;
  }
  /** ShiftManager's NodeLinks: a shift's socket there, forwarded here. */
  async forward(machine: string, sock: string): Promise<void> {
    const n = this.get(machine);
    if (!n) throw new Error(`no node ${machine} in hq.config.json`);
    await n.forward(sock);
  }
  close(): void { for (const n of this.list) n.close(); }
}

/**
 * Shifts on a node: hq writes the shift's files here as always (host-args.json, prime.json, the system prompt), sends
 * them to the same paths there, and enables the node's system unit company-shift@<shift> (node-install.sh).
 */
export class RemoteLauncher {
  private node: RemoteNode;
  private stateDir: string;
  constructor(node: RemoteNode, stateDir: string) {
    this.node = node;
    this.stateDir = stateDir;
  }

  /** The token file there (node-install.sh): the shift runs on it, with that node's own ~/.claude (never ours). */
  get tokenFile(): string { return join(this.stateDir, 'node-oauth-token'); }

  async launch(spec: LaunchSpec): Promise<{ unit?: string }> {
    const args = hostArgs({ ...spec, configDir: null }, this.stateDir);
    args['oauth-token-file'] = this.tokenFile;
    const files: Record<string, string> = { [join(this.stateDir, 'shifts', spec.shiftId, 'host-args.json')]: JSON.stringify(args, null, 2) };
    for (const f of [join(this.stateDir, 'shifts', spec.shiftId, 'prime.json'), spec.systemPromptFile]) {
      if (f && existsSync(f)) files[f] = readFileSync(f, 'utf8');
    }
    await this.node.exec(`node -e ${q(WRITE_FILES)}`, JSON.stringify(files), 30_000);
    await this.node.exec(`systemctl reset-failed ${q(spec.unit)} 2>/dev/null; systemctl enable --now ${q(spec.unit)}`, undefined, 60_000);
    return { unit: spec.unit };
  }

  async kill(shiftId: string, unit: string | null): Promise<void> {
    const u = unit ?? shiftUnit(shiftId);
    await this.node.exec(`systemctl disable --now ${q(u)} 2>/dev/null; ! systemctl is-active --quiet ${q(u)}`, undefined, 60_000)
      .catch((e) => { throw e instanceof NodeUnreachable ? e : new Error(`${u} is still active on ${this.node.def.name} after disable --now`); });
    await this.node.unforward(join(this.stateDir, 'shifts', `${shiftId}.sock`));
  }
}

/** Writes {path: content} from stdin, owner-only, atomically (the remote half of RemoteLauncher.launch). */
const WRITE_FILES = `const fs=require('fs'),p=require('path');let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
for(const [f,c] of Object.entries(JSON.parse(s))){fs.mkdirSync(p.dirname(f),{recursive:true,mode:0o700});fs.writeFileSync(f+'.tmp',c,{mode:0o600});fs.renameSync(f+'.tmp',f);}})`;

/** Local shifts go to the template launcher, a node's to its RemoteLauncher. */
export class RoutingLauncher implements Launcher {
  private local: Launcher;
  private remote = new Map<string, RemoteLauncher>();
  constructor(local: Launcher, nodes: Nodes, stateDir: string) {
    this.local = local;
    for (const n of nodes.list) this.remote.set(n.def.name, new RemoteLauncher(n, stateDir));
  }
  private of(machine: string | null | undefined): Launcher | RemoteLauncher {
    if (!machine || machine === LOCAL) return this.local;
    const r = this.remote.get(machine);
    if (!r) throw new Error(`no node ${machine} in hq.config.json`);
    return r;
  }
  launch(spec: LaunchSpec): Promise<{ unit?: string }> { return this.of(spec.machine).launch(spec); }
  kill(shiftId: string, unit: string | null, machine?: string | null): Promise<void> { return this.of(machine).kill(shiftId, unit); }
}

/**
 * A task's worktree on a node: the same Workspaces code, run there by workspace-cli.ts on the node's own checkouts
 * and its copy of the company (synced to ours first, so it reads the same charter). A preserved ref comes back here,
 * into the same checkout path, so closing on a node keeps the work as it does here.
 */
export class RemoteWorkspaces {
  private node: RemoteNode;
  private companyHome: string;
  private engine: string;
  /** git here (fetch of a preserved ref); tests substitute it. */
  fetch: (repo: string, ref: string) => Promise<void>;
  /** The commit our company checkout is on: the node's copy goes to it before each op. */
  companySha: () => Promise<string | null>;

  constructor(node: RemoteNode, companyHome: string, engine: string, git?: (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>) {
    this.node = node;
    this.companyHome = companyHome;
    this.engine = engine;
    const run = git ?? (async (cwd: string, args: string[], env?: NodeJS.ProcessEnv) => (await import('./workspace.ts')).runGit(cwd, args, env));
    this.fetch = async (repo, ref) => {
      if (!existsSync(join(repo, '.git'))) return;
      await run(repo, ['fetch', '--quiet', `${this.node.def.ssh}:${repo}`, `+${ref}:${ref}`], { GIT_SSH_COMMAND: this.node.gitSsh() });
    };
    this.companySha = async () => (await run(this.companyHome, ['rev-parse', 'HEAD']).catch(() => '')).trim() || null;
  }

  private async op<T>(body: Record<string, unknown>, timeoutMs = 20 * 60_000): Promise<T> {
    const out = await this.node.exec(`cd ${q(this.engine)} && node packages/hq/src/workspace-cli.ts`,
      JSON.stringify({ ...body, companyHome: this.companyHome, companySha: await this.companySha() }), timeoutMs);
    const line = out.trim().split('\n').pop() ?? '';
    let r: { ok: boolean; result?: T; error?: string };
    try { r = JSON.parse(line) as typeof r; } catch { throw new Error(`${this.node.def.name}: workspace-cli: ${out.slice(-400)}`); }
    if (!r.ok) throw new Error(`${this.node.def.name}: ${r.error}`);
    return r.result as T;
  }

  /** The charter's checkout by name (the node checks it exists when it creates the worktree). */
  checkout(ch: Charter, name?: string | null): Checkout | null {
    if (ch.checkouts.length === 0) return null;
    const c = name ? ch.checkouts.find((x) => x.name === name) : ch.checkouts[0];
    if (!c) throw new Error(`project ${ch.project} has no checkout "${name}"`);
    return c;
  }

  create(ch: Charter, c: Checkout, task: string): Promise<Worktree> {
    return this.op({ op: 'create', project: ch.project, checkout: c.name, task });
  }

  ensure(path: string, checkout?: string, ch?: Charter): Promise<boolean> {
    return this.op({ op: 'ensure', path, checkout: checkout ?? null, project: ch?.project ?? null });
  }

  async close(path: string, defaultBranch = 'main', keepBranch = false): Promise<CloseResult> {
    const r = await this.op<CloseResult & { repo?: string; branch?: string }>({ op: 'close', path, defaultBranch, keepBranch });
    // What close keeps there comes here too: the preserved ref, and a branch with commits it did not delete.
    const keep = [r.preserved, r.removed && !r.branchDeleted && r.branch && r.branch !== 'HEAD' ? `refs/heads/${r.branch}` : null];
    for (const ref of keep) {
      if (!ref || !r.repo) continue;
      try { await this.fetch(r.repo, ref); }
      catch (e) { r.error = `${r.error ? `${r.error}; ` : ''}${ref} stayed on ${this.node.def.name}: ${(e as Error).message}`; }
    }
    delete r.branch;
    delete r.repo;
    return r;
  }
}
