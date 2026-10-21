// Task shifts on another machine (nodes.ts): placement, the worktree there (workspace-cli.ts, run for real over a
// fake ssh that executes here), the forward of the shift's socket, the switch, and the remote launcher's commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { charter, git, makeEnv, repo, until } from './helpers.ts';
import { HostClient } from '../src/host-client.ts';
import { syncCompany } from '../src/workspace-cli.ts';
import { RemoteLauncher, RemoteNode, RemoteWorkspaces, nodeToggle, type NodeDef, type SshRun } from '../src/nodes.ts';
import type { LaunchSpec } from '../src/shifts.ts';

const NODE: NodeDef = { name: 'n2', ssh: 'root@n2.test', projects: ['proj'], maxSlots: 2, maxLoad: 0.85, identityFile: null };

/** ssh to "n2" that is this machine: commands run here in bash; control ops, health and systemctl are recorded. */
function fakeSsh(calls: string[][], health = { totalMb: 32_000, availableMb: 30_000, load1: 0.4, cpus: 8 }): SshRun {
  return (args, input) => new Promise((res, rej) => {
    calls.push(args);
    const at = args.indexOf(NODE.ssh);
    const cmd = args.slice(at + 1).join(' ');
    if (!cmd || cmd.startsWith('rm -f') || cmd.includes('systemctl')) return res('');
    if (cmd.includes('/proc/meminfo')) {
      return res(`MemTotal: ${health.totalMb * 1024} kB\nMemAvailable: ${health.availableMb * 1024} kB\n${health.load1}\n${health.cpus}\n`);
    }
    const p = spawn('bash', ['-c', cmd], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += String(d); });
    p.stderr.on('data', (d) => { err += String(d); });
    p.on('close', (code) => (code === 0 ? res(out) : rej(Object.assign(new Error(err || `exit ${code}`), { code }))));
    p.stdin.end(input ?? '');
  });
}

test('nodes: a task worker\'s task goes to the node, its worktree is made and closed there, its shift runs there', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq, launcher } = env;
    // The company checkout (COMPANY_HOME = env.dir): the node's copy goes to its commit before each op.
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const fetched: string[] = [];
    (hq.scheduler.workspacesFor('n2') as RemoteWorkspaces).fetch = async (repoPath, ref) => { fetched.push(`${repoPath} ${ref}`); };
    await hq.start({ listen: false, timers: false });
    assert.equal(hq.nodes.list[0]!.status?.up, true, `polled at start: ${hq.nodes.list[0]!.status?.error}`);
    assert.deepEqual(hq.scheduler.nodeSlots().map((n) => [n.name, n.total, n.free]), [['n2', 2, 2]]);

    const t = hq.scheduler.addTask({ title: 'על השרת השני', project: 'proj' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 8000, 'running');
    const wt = join(r.checkout, '.worktrees', `company-t${t.id}`);
    assert.equal(hq.scheduler.task(t.id)!.machine, 'n2');
    assert.equal(hq.scheduler.task(t.id)!.worktree, wt);
    assert.ok(existsSync(wt), 'made by workspace-cli on the node');
    const spec = launcher.launches.at(-1)!;
    assert.equal(spec.machine, 'n2');
    assert.equal(spec.cwd, wt);
    assert.equal(spec.account, 'node:n2', 'its own login there, not an account here');
    const sid = `proj-t${t.id}-1`;
    assert.equal(hq.shifts.get(sid)!.machine, 'n2');
    assert.ok(calls.some((a) => a.includes('-O') && a.includes('forward') && a.some((x) => x.endsWith(`${sid}.sock:${hq.shifts.get(sid)!.socket_path}`))),
      'the shift socket is forwarded');
    assert.equal(hq.scheduler.nodeSlots()[0]!.running, 1);
    assert.equal(hq.scheduler.slots().tasks, 0, 'holds no slot here');
    assert.equal(hq.board().find((b) => b.id === `proj-t${t.id}`)!.shift!.machine, 'n2');

    // Woken again after a rest: the same machine and worktree.
    await hq.shifts.stop(sid, 'rest');
    await hq.shifts.request(`proj-t${t.id}`, { reason: 'message' });
    assert.equal(launcher.launches.at(-1)!.machine, 'n2');

    // A task that needs the browser stays here; so does everything while the switch is off.
    const local = hq.scheduler.addTask({ title: 'עם דפדפן', project: 'proj', labels: ['needs-browser'] });
    await until(() => hq.scheduler.task(local.id)!.state === 'running', 8000, 'local running');
    assert.equal(launcher.launches.at(-1)!.machine, 'local');
    assert.equal(hq.scheduler.task(local.id)!.machine, null);
    hq.store.setToggle(nodeToggle('n2'), false);
    assert.equal(hq.scheduler.nodeSlots()[0]!.enabled, false, 'off: no new task goes there (one already there keeps its slot)');
    const off = hq.scheduler.addTask({ title: 'כשהמתג כבוי', project: 'proj' });
    await until(() => hq.scheduler.task(off.id)!.state === 'running', 8000, 'off running');
    assert.equal(launcher.launches.at(-1)!.machine, 'local');

    // Done: the worktree closes there, uncommitted work is preserved and fetched back here.
    writeFileSync(join(wt, 'wip.txt'), 'half done\n');
    await hq.scheduler.completeTask(t.id);
    await until(() => !existsSync(wt), 8000, 'worktree removed on the node');
    assert.equal(git(r.checkout, 'show', `refs/company/preserved/company-t${t.id}:wip.txt`), 'half done');
    await until(() => fetched.length > 0, 8000, 'preserved ref fetched back');
    assert.deepEqual(fetched, [`${r.checkout} refs/company/preserved/company-t${t.id}`]);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('nodes: a node that does not answer gets no task, and its load caps it', async () => {
  const r = repo();
  const calls: string[][] = [];
  const health = { totalMb: 32_000, availableMb: 30_000, load1: 7.5, cpus: 8 };
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls, health) }, noStart: true });
  try {
    const { hq } = env;
    const n = hq.nodes.list[0]!;
    n.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    assert.equal(hq.scheduler.nodeSlots()[0]!.free, 0, 'load 0.94 per CPU is over 0.85');
    health.load1 = 1;
    await hq.pollNodes();
    assert.equal(hq.scheduler.nodeSlots()[0]!.free, 2);
    n.status = { up: false, at: 0, error: 'Connection refused', totalMb: 0, availableMb: 0, load1: 0, cpus: 0 };
    const s = hq.scheduler.nodeSlots()[0]!;
    assert.deepEqual([s.up, s.free, s.error], [false, 0, 'Connection refused']);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('RemoteLauncher: the shift\'s files go to the same paths there, on the node\'s token, then its unit starts', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const run: SshRun = async (args, input) => { calls.push({ args, input }); return ''; };
  const node = new RemoteNode(NODE, '/home/owner/.local/state/agent-company', run);
  node.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const l = new RemoteLauncher(node, '/home/owner/.local/state/agent-company');
    const spec: LaunchSpec = { shiftId: 'p-t1-1', identity: 'p-t1', shiftNo: 1, sessionId: 's', resume: false, kind: 'work', cwd: '/w',
      socketPath: '/home/owner/.local/state/agent-company/shifts/p-t1-1.sock', taskId: 1, unit: 'company-shift@p-t1-1.service',
      account: 'node:n2', configDir: '/here/accounts/x', machine: 'n2' };
    await l.launch(spec);
    const write = calls.find((c) => c.args.at(-1)!.includes('; node -e'))!;
    const files = JSON.parse(write.input!) as Record<string, string>;
    const args = JSON.parse(files['/home/owner/.local/state/agent-company/shifts/p-t1-1/host-args.json']!) as Record<string, unknown>;
    assert.equal(args['oauth-token-file'], '/home/owner/.local/state/agent-company/node-oauth-token');
    assert.equal(args['config-dir'], undefined, 'never a config dir of here');
    assert.equal(args.cwd, '/w');
    assert.match(calls.at(-1)!.args.at(-1)!, /systemctl enable --now 'company-shift@p-t1-1.service'/);
    await l.kill('p-t1-1', spec.unit);
    assert.match(calls.at(-1)!.args.at(-1)!, /systemctl disable --now 'company-shift@p-t1-1.service'/);
  } finally { node.close(); }
});

test('HostClient awaitHello: a socket that opens but has no host behind it (an ssh forward) is not connected', async () => {
  const sock = join(mkdtempSync(join(tmpdir(), 'hc-')), 'x.sock');
  const server = createServer((s) => s.destroy());
  await new Promise<void>((r) => server.listen(sock, () => r()));
  try {
    const plain = new HostClient('a', sock);
    await plain.open(0);
    const remote = new HostClient('b', sock, { awaitHello: true });
    await assert.rejects(remote.open(0));
    assert.equal(remote.connected, false);
    plain.close();
  } finally { server.close(); }
});

test('workspace-cli: ops side by side move the company checkout one at a time (no index.lock failures)', async () => {
  const r = repo();
  try {
    const sha = git(r.checkout, 'rev-parse', 'HEAD');
    await Promise.all(Array.from({ length: 6 }, () => syncCompany(r.checkout, sha)));
    assert.equal(git(r.checkout, 'rev-parse', 'HEAD'), sha);
    assert.ok(!existsSync(join(r.checkout, '.git', 'company-sync.lock')), 'the lock is released');
  } finally { r.cleanup(); }
});
