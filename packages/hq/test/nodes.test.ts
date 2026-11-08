// Task shifts on another machine (nodes.ts): placement, the worktree there (workspace-cli.ts, run for real over a
// fake ssh that executes here), the forward of the shift's socket, the switch, and the remote launcher's commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { charter, git, makeEnv, repo, until } from './helpers.ts';
import { HostClient } from '../src/host-client.ts';
import { syncCompany } from '../src/workspace-cli.ts';
import { NodeUnreachable, RemoteLauncher, RemoteNode, RemoteWorkspaces, nodeCanHost, nodeToggle, type NodeDef, type SshRun } from '../src/nodes.ts';
import type { LaunchSpec } from '../src/shifts.ts';
import { BaseFetchFailed, Workspaces } from '../src/workspace.ts';

test('nodeCanHost: a need goes only to a node that has it; needs-local never leaves the main server', () => {
  const ci-host = { has: [] as NodeDef['has'] };
  const kvm = { has: ['emulator'] as NodeDef['has'] };
  assert.equal(nodeCanHost(ci-host, ['opened-by:yoav', 'repo:x']), true, 'labels that are not needs do not matter');
  assert.equal(nodeCanHost(ci-host, ['needs-emulator']), false);
  assert.equal(nodeCanHost(kvm, ['needs-emulator']), true);
  assert.equal(nodeCanHost(kvm, ['needs-simulator']), true, 'the old name');
  assert.equal(nodeCanHost(kvm, ['needs-emulator', 'needs-browser']), false, 'every need');
  assert.equal(nodeCanHost({ has: ['emulator', 'browser'] }, ['needs-local']), false);
  assert.equal(nodeCanHost({}, ['needs-browser']), false, 'no has: the baseline only');
});

const NODE: NodeDef = { name: 'n2', ssh: 'root@n2.test', projects: ['proj'], maxSlots: 2, maxLoad: 0.85, identityFile: null };

/** ssh to "n2" that is this machine: commands run here in bash; control ops, health and systemctl are recorded. */
function fakeSsh(calls: string[][], health: { totalMb: number; availableMb: number; load1: number; cpus: number; ac?: string; down?: boolean }
  = { totalMb: 32_000, availableMb: 30_000, load1: 0.4, cpus: 8 }): SshRun {
  return (args, input) => new Promise((res, rej) => {
    calls.push(args);
    const at = args.indexOf(NODE.ssh);
    const cmd = args.slice(at + 1).join(' ');
    if (health.down && !args.includes('-O')) return rej(Object.assign(new Error('ssh: connect to host n2.test: No route to host'), { code: 255 }));
    if (!cmd || cmd.startsWith('rm -f') || cmd.includes('systemctl')) return res('');
    if (cmd.includes('/proc/meminfo')) {
      return res(`MemTotal: ${health.totalMb * 1024} kB\nMemAvailable: ${health.availableMb * 1024} kB\n${health.load1}\n${health.cpus}\nac:${health.ac ?? ''}\n`);
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
    // The task's prompt reaches the shift there: `live` comes in the same read as hello, and the flush finds the connection.
    const prompt = hq.mailbox.list(`proj-t${t.id}`).find((m) => m.to_identity === `proj-t${t.id}`)!;
    await until(() => hq.mailbox.get(prompt.id)!.state !== 'queued', 3000, 'task prompt delivered on the node');

    // Woken again after a rest: the same machine and worktree.
    await hq.shifts.stop(sid, 'rest');
    await hq.shifts.request(`proj-t${t.id}`, { reason: 'message' });
    assert.equal(launcher.launches.at(-1)!.machine, 'n2');

    // The default (22/10): any task may go there; this one takes the node's second slot.
    const plain = hq.scheduler.addTask({ title: 'רגילה', project: 'proj' });
    await until(() => hq.scheduler.task(plain.id)!.state === 'running', 8000, 'plain running');
    assert.equal(hq.scheduler.task(plain.id)!.machine, 'n2');
    await hq.scheduler.completeTask(plain.id);
    await until(() => hq.scheduler.nodeSlots()[0]!.running === 1, 8000, 'its slot there is free again');
    // Marked needs-local while it waits (PATCH /api/tasks/:id): here, though the node has room.
    hq.store.setToggle('scheduler', false);
    const marked = hq.scheduler.addTask({ title: 'צריכה kubectl', project: 'proj' });
    hq.scheduler.setTaskLabels(marked.id, ['needs-local'], []);
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(marked.id)!.state === 'running', 8000, 'marked running');
    assert.equal(hq.scheduler.task(marked.id)!.machine, null);
    assert.equal(launcher.launches.at(-1)!.machine, 'local');
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
  // The ssh control socket is local: a temp dir, never the real state dir of this machine.
  const state = mkdtempSync(join(tmpdir(), 'rl-'));
  const node = new RemoteNode(NODE, state, run);
  node.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    const l = new RemoteLauncher(node, '/home/ran/.local/state/agent-company');
    const spec: LaunchSpec = { shiftId: 'p-t1-1', identity: 'p-t1', shiftNo: 1, sessionId: 's', resume: false, kind: 'work', cwd: '/w',
      socketPath: '/home/ran/.local/state/agent-company/shifts/p-t1-1.sock', taskId: 1, unit: 'company-shift@p-t1-1.service',
      account: 'node:n2', configDir: '/here/accounts/x', machine: 'n2' };
    await l.launch(spec);
    const write = calls.find((c) => c.args.at(-1)!.includes('; node -e'))!;
    const files = JSON.parse(write.input!) as Record<string, string>;
    const args = JSON.parse(files['/home/ran/.local/state/agent-company/shifts/p-t1-1/host-args.json']!) as Record<string, unknown>;
    assert.equal(args['oauth-token-file'], '/home/ran/.local/state/agent-company/node-oauth-token');
    assert.equal(args['config-dir'], undefined, 'never a config dir of here');
    assert.equal(args.cwd, '/w');
    assert.match(calls.at(-1)!.args.at(-1)!, /sc enable --now 'company-shift@p-t1-1.service'/);
    await l.kill('p-t1-1', spec.unit);
    assert.match(calls.at(-1)!.args.at(-1)!, /sc disable --now 'company-shift@p-t1-1.service'/);
  } finally { node.close(); rmSync(state, { recursive: true, force: true }); }
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

test('nodes: a worker there that never takes its task: the task runs here, and he hears nothing of it (adi 22/10)', async () => {
  const r = repo();
  const calls: string[][] = [];
  // A slow worktree_setup: a message that comes in while the task's worktree here is being set up must wait for it.
  const slow = charter(r.checkout).replace('  test: npm test', '  test: npm test\n  worktree_setup: sleep 1');
  const env = await makeEnv({ projects: { proj: slow }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq, launcher, clock } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    (hq.scheduler.workspacesFor('n2') as RemoteWorkspaces).fetch = async () => {};
    await hq.start({ listen: false, timers: false });
    launcher.mode = 'mute'; // the CLI there never accepts the prompt
    const t = hq.scheduler.addTask({ title: 'לא נלקחה שם', project: 'proj' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 8000, 'running on the node');
    assert.equal(hq.scheduler.task(t.id)!.machine, 'n2');
    const prompt = hq.mailbox.list(`proj-t${t.id}`).find((m) => m.to_identity === `proj-t${t.id}`)!;
    await until(() => (launcher.hosts.get(`proj-t${t.id}-1`)?.sent.length ?? 0) === 1, 3000, 'sent there');

    launcher.mode = 'echo';
    clock.advance(61_000);
    const before = launcher.launches.length;
    await hq.mailbox.sweep();
    hq.mailbox.tell({ msg_id: 'during-setup', from: 'eli', to: `proj-t${t.id}`, body: 'עוד פרט למשימה' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running' && hq.scheduler.task(t.id)!.machine === null, 8000, 'running here');
    assert.deepEqual(launcher.launches.slice(before).map((l) => l.cwd), [hq.scheduler.task(t.id)!.worktree], 'one launch here, in its worktree');
    await until(() => hq.mailbox.get('during-setup')!.state !== 'queued', 3000, 'the message during setup is delivered by the start');
    const here = launcher.launches.at(-1)!;
    assert.equal(here.machine, 'local');
    // One filesystem in this test: the node's worktree may still be there, so the one here can get a suffix.
    assert.ok(here.cwd.startsWith(join(r.checkout, '.worktrees', `company-t${t.id}`)), 'a worktree here');
    assert.equal(hq.scheduler.task(t.id)!.worktree, here.cwd);
    assert.ok(JSON.parse(hq.scheduler.task(t.id)!.labels).includes('needs-local'));
    assert.equal(hq.mailbox.get(prompt.id)!.state, 'failed', 'the prompt there is dropped');
    await until(() => hq.mailbox.list(`proj-t${t.id}`).some((m) => m.to_identity === `proj-t${t.id}` && m.id !== prompt.id && m.state !== 'queued'), 3000, 'the prompt here is taken');
    assert.ok(!hq.inbox.open().some((i) => i.kind === 'delivery_failure'), 'nothing for him');
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'task.node_fallback'));
  } finally { await env.cleanup(); r.cleanup(); }
});

test('nodes: a worker there that finds it needs the main server (status needs-local): the task moves here with its work (task-235)', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq, launcher } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    (hq.scheduler.workspacesFor('n2') as RemoteWorkspaces).fetch = async () => {};
    await hq.start({ listen: false, timers: false });
    const t = hq.scheduler.addTask({ title: 'צריכה .env', project: 'proj' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 8000, 'running on the node');
    assert.equal(hq.scheduler.task(t.id)!.machine, 'n2');
    const there = hq.scheduler.task(t.id)!.worktree!;
    const brief = hq.mailbox.list(`proj-t${t.id}`).find((m) => m.to_identity === `proj-t${t.id}`)!;
    assert.match(brief.body, /Running on the second server \(`n2`\)/, 'the brief says where it runs and how to move');
    await until(() => hq.mailbox.get(brief.id)!.state !== 'queued', 3000, 'taken there');

    const before = launcher.launches.length;
    const moving = hq.scheduler.moveLocal(t.id, 'אין .env');
    assert.equal(await hq.scheduler.moveLocal(t.id, 'פעמיים'), false, 'one move at a time');
    // A message while it moves does not wake it there: the start here delivers it.
    hq.mailbox.tell({ msg_id: 'while-moving', from: 'eli', to: `proj-t${t.id}`, body: 'עוד פרט' });
    assert.equal(await moving, true);
    await until(() => hq.scheduler.task(t.id)!.state === 'running' && hq.scheduler.task(t.id)!.machine === null, 8000, 'running here');
    assert.deepEqual(launcher.launches.slice(before).map((l) => l.machine), ['local'], 'one launch, here');
    await until(() => hq.mailbox.get('while-moving')!.state !== 'queued', 3000, 'delivered by the start here');
    const labels = JSON.parse(hq.scheduler.task(t.id)!.labels) as string[];
    assert.ok(labels.includes('needs-local'), 'stays here');
    assert.ok(labels.includes(`moved-from:n2:${there}`), 'the brief here says where the work from there is');
    const again = hq.mailbox.list(`proj-t${t.id}`).filter((m) => m.to_identity === `proj-t${t.id}` && m.id !== brief.id && m.id !== 'while-moving').at(-1)!;
    assert.match(again.body, /started on `n2` and came back here/);
    assert.doesNotMatch(again.body, /Running on the second server/);
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'task.move_local'));
    assert.equal(await hq.scheduler.moveLocal(t.id, 'שוב'), false, 'here already');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('#224: memory and load there are read again right before a start: a node that choked since the last poll gets no task', async () => {
  const r = repo();
  const calls: string[][] = [];
  const health = { totalMb: 32_000, availableMb: 30_000, load1: 0.4, cpus: 8 };
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls, health) }, noStart: true });
  try {
    const { hq, launcher, clock } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    assert.equal(hq.scheduler.nodeSlots()[0]!.free, 2, 'fine at the last poll');
    health.load1 = 52;
    health.availableMb = 1000;
    clock.advance(20_000);
    const t = hq.scheduler.addTask({ title: 'כשהשני נחנק', project: 'proj' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 8000, 'running');
    assert.equal(hq.scheduler.task(t.id)!.machine, null, 'here, not on the choked node');
    assert.equal(launcher.launches.at(-1)!.machine, 'local');
    const n = hq.scheduler.nodeSlots()[0]!;
    assert.deepEqual([n.free, n.busy], [0, true]);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('#224: a task placed on a node that is switched off, or whose worktree there is gone, comes back to the queue and runs here', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq, launcher } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    (hq.scheduler.workspacesFor('n2') as RemoteWorkspaces).fetch = async () => {};
    await hq.start({ listen: false, timers: false });

    // Switched off: a task pinned there (interrupted, its worktree there) is not started there again.
    hq.store.setToggle('scheduler', false);
    const off = hq.scheduler.addTask({ title: 'על שרת כבוי', project: 'proj' });
    const gone = join(r.checkout, '.worktrees', `company-t${off.id}-there`);
    hq.store.db.prepare(`UPDATE tasks SET machine = 'n2', worktree = ?, state = 'interrupted', started_at = 1 WHERE id = ?`).run(gone, off.id);
    hq.store.setToggle(nodeToggle('n2'), false);
    hq.store.setToggle('scheduler', true);
    assert.equal(hq.scheduler.waitReason(hq.scheduler.task(off.id)!, hq.scheduler.slots()), 'מתחילה עכשיו', 'not "waiting for n2"');
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(off.id)!.state === 'running', 8000, 'running here');
    const t1 = hq.scheduler.task(off.id)!;
    assert.equal(t1.machine, null);
    assert.ok(t1.worktree && t1.worktree !== gone && existsSync(t1.worktree), 'a new worktree here');
    assert.equal(launcher.launches.at(-1)!.machine, 'local');
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'task.unpinned'));

    // Started there, so its next brief says where its work from there is now.
    const brief = hq.mailbox.list(`proj-t${off.id}`).filter((m) => m.to_identity === `proj-t${off.id}`).at(-1)!;
    assert.match(brief.body, /The task started on `n2` and came back here/);

    // Switched off, and the close there fails: it still comes back, and its brief says the work stayed there.
    const ws2 = hq.scheduler.workspacesFor('n2') as RemoteWorkspaces;
    const realClose = ws2.close.bind(ws2);
    ws2.close = async () => { throw new Error('ssh: connection timed out'); };
    hq.store.setToggle('scheduler', false);
    const stuck = hq.scheduler.addTask({ title: 'סגירה שנכשלה', project: 'proj' });
    const there = join(r.checkout, '.worktrees', `company-t${stuck.id}-there`);
    hq.store.db.prepare(`UPDATE tasks SET machine = 'n2', worktree = ?, state = 'interrupted', started_at = 1 WHERE id = ?`).run(there, stuck.id);
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(stuck.id)!.state === 'running', 8000, 'running here');
    const b3 = hq.mailbox.list(`proj-t${stuck.id}`).filter((m) => m.to_identity === `proj-t${stuck.id}`).at(-1)!;
    assert.match(b3.body, /and the work from there may not have been fetched/);
    assert.ok(b3.body.includes(there), 'where it stayed');
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'task.worktree_close_failed' && (e.data as { id: number }).id === stuck.id));
    ws2.close = realClose;

    // Switch on, but the worktree there is gone and its branch too: back to the queue unplaced, not out of it (no
    // needs-decision). Unplaced, it may go to a node again: with a new worktree, from the start.
    hq.store.setToggle(nodeToggle('n2'), true);
    hq.store.setToggle('scheduler', false);
    const lost = hq.scheduler.addTask({ title: 'בלי worktree שם', project: 'proj' });
    const nothing = join(r.checkout, '.worktrees', 'company-t999-nothing');
    hq.store.db.prepare(`UPDATE tasks SET machine = 'n2', worktree = ?, state = 'interrupted', started_at = 1 WHERE id = ?`).run(nothing, lost.id);
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(lost.id)!.state === 'running', 8000, 'running');
    const t2 = hq.scheduler.task(lost.id)!;
    assert.ok(t2.worktree && t2.worktree !== nothing && existsSync(t2.worktree), 'a new worktree');
    assert.ok(!JSON.parse(t2.labels).includes('needs-decision'));
    assert.ok(hq.store.eventsAfter(0, 5000).some((e) => e.type === 'task.unpinned' && (e.data as { id: number }).id === lost.id));
  } finally { await env.cleanup(); r.cleanup(); }
});

test('#224: a fill never waits on a node\'s ssh: tasks for here start now, a task that could go there waits for the read', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq, clock } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    let release!: () => void;
    let reads = 0;
    hq.scheduler.pollNode = (n) => { reads++; return new Promise<void>((res) => { release = () => { n.status = { ...n.status!, at: clock.now() }; res(); }; }); };
    clock.advance(20_000);
    hq.store.setToggle('scheduler', false);
    const remote = hq.scheduler.addTask({ title: 'יכולה לצאת', project: 'proj' });
    const here = hq.scheduler.addTask({ title: 'רק כאן', project: 'proj', labels: ['needs-local'] });
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(here.id)!.state === 'running', 8000, 'the task for here runs while the node is read');
    assert.equal(hq.scheduler.task(remote.id)!.state, 'queued', 'waits for the read');
    await hq.scheduler.fill();
    assert.equal(reads, 1, 'one read at a time');
    release();
    await until(() => hq.scheduler.task(remote.id)!.state === 'running', 8000, 'starts once read');
    assert.equal(hq.scheduler.task(remote.id)!.machine, 'n2');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('task-288: local under load, the head of the queue cannot go to the node: a task that can still goes', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    hq.scheduler.loadInfo = () => ({ load1: 16, cpus: 8 });
    const head = hq.scheduler.addTask({ title: 'ראש התור', project: 'proj', labels: ['needs-local'] });
    const other = hq.scheduler.addTask({ title: 'פרויקט אחר', project: 'other' });
    const free = hq.scheduler.addTask({ title: 'יכולה לצאת', project: 'proj' });
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(free.id)!.state === 'running', 8000, 'runs on the node');
    assert.equal(hq.scheduler.task(free.id)!.machine, 'n2');
    assert.equal(hq.scheduler.task(head.id)!.state, 'queued');
    assert.equal(hq.scheduler.task(other.id)!.state, 'queued');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('task 1596: the main server full, a p0 and a task that needs what the node has go there; one that needs what it lacks waits here', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [{ ...NODE, maxSlots: 3, has: ['emulator'], keys: true }] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    hq.scheduler.loadInfo = () => ({ load1: 16, cpus: 8 });
    const browser = hq.scheduler.addTask({ title: 'צריכה דפדפן', project: 'proj', priority: 0, labels: ['needs-browser'] });
    const p0 = hq.scheduler.addTask({ title: 'p0 רגילה', project: 'proj', priority: 0 });
    const emu = hq.scheduler.addTask({ title: 'צריכה אמולטור', project: 'proj', labels: ['needs-emulator'] });
    const main = hq.scheduler.addTask({ title: 'פריסת hq', project: 'proj', labels: ['needs-local'] });
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(p0.id)!.state === 'running' && hq.scheduler.task(emu.id)!.state === 'running', 8000, 'both run on the node');
    assert.equal(hq.scheduler.task(p0.id)!.machine, 'n2', 'a p0 does not wait for the main server');
    assert.equal(hq.scheduler.task(emu.id)!.machine, 'n2', 'the node has an emulator');
    assert.equal(hq.scheduler.task(browser.id)!.state, 'queued', 'the node has no browser: it waits for the main server');
    assert.equal(hq.scheduler.task(main.id)!.state, 'queued');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('task 1596: a node set up with the keys goes first, though another has more room; a worker on one without them hears request_access', async () => {
  const r = repo();
  const calls: string[][] = [];
  const bare: NodeDef = { ...NODE, name: 'n3', ssh: 'root@n3.test', maxSlots: 4 };
  const ssh: SshRun = (args, input) => fakeSsh(calls)(args.map((a) => (a === bare.ssh ? NODE.ssh : a)), input);
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [bare, { ...NODE, maxSlots: 1, keys: true }] }, deps: { ssh }, noStart: true });
  try {
    const { hq } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    for (const n of hq.nodes.list) n.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    hq.scheduler.loadInfo = () => ({ load1: 16, cpus: 8 });
    const first = hq.scheduler.addTask({ title: 'ראשונה', project: 'proj' });
    await until(() => hq.scheduler.task(first.id)!.state === 'running', 8000, 'first running');
    assert.equal(hq.scheduler.task(first.id)!.machine, 'n2', 'the node with the keys, though n3 has 4 free and n2 1');
    const second = hq.scheduler.addTask({ title: 'שנייה', project: 'proj' });
    await until(() => hq.scheduler.task(second.id)!.state === 'running', 8000, 'second running');
    assert.equal(hq.scheduler.task(second.id)!.machine, 'n3', 'n2 is full: the other node, not the main server');
    const msgs = hq.store.db.prepare('SELECT to_identity AS t, body FROM messages WHERE to_identity IN (?, ?)').all(hq.scheduler.task(first.id)!.identity, hq.scheduler.task(second.id)!.identity) as { t: string; body: string }[];
    const of = (id: number) => msgs.filter((m) => m.t === hq.scheduler.task(id)!.identity).map((m) => m.body).join('\n');
    assert.match(of(first.id), /ssh to the clusters/);
    assert.doesNotMatch(of(first.id), /It has no ssh keys/);
    assert.match(of(second.id), /It has no ssh keys, `\.env`, kubectl/);
    assert.match(of(second.id), /request_access/);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('task-288: a task handed to a standing worker goes to the node like a task worker\'s; one handed to a lead stays here', async () => {
  const r = repo();
  const calls: string[][] = [];
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [NODE] }, deps: { ssh: fakeSsh(calls) }, noStart: true });
  try {
    const { hq } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    hq.nodes.list[0]!.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    await hq.start({ listen: false, timers: false });
    const free = new Map([['n2', 2]]);
    const worker = hq.scheduler.addTask({ title: 'לעובד קבוע', project: 'proj', identity: 'amit' });
    const lead = hq.scheduler.addTask({ title: 'לראש צוות', project: 'proj', identity: 'eli' });
    assert.equal(hq.scheduler.placeFor(hq.scheduler.task(worker.id)!, free), 'n2');
    assert.equal(hq.scheduler.placeFor(hq.scheduler.task(lead.id)!, free), 'local');
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(worker.id)!.state === 'running', 8000, 'the standing worker\'s task runs');
    assert.equal(hq.scheduler.task(worker.id)!.machine, 'n2');
    assert.equal(env.launcher.launches.find((l) => l.identity === 'amit')!.machine, 'n2');
  } finally { await env.cleanup(); r.cleanup(); }
});

test('task-288: closing a task from a node fetches back the preserved ref and the task\'s own branch, never main', async () => {
  const closeOn = async (branch: string, over: Record<string, unknown> = {}) => {
    const out = JSON.stringify({ ok: true, result: { path: '/w/.worktrees/company-t9', preserved: 'refs/company/preserved/company-t9', removed: true,
      branchDeleted: false, ignored: [], repo: '/w', branch, ...over } });
    const node = { def: { name: 'n2', ssh: 'root@n2.test' }, exec: async () => out, gitSsh: () => 'ssh' };
    const ws = new RemoteWorkspaces(node as never, '/c', '/e');
    const fetched: string[] = [];
    ws.fetch = async (_repo, ref) => { fetched.push(ref); };
    ws.companySha = async () => null;
    await ws.close('/w/.worktrees/company-t9');
    return fetched;
  };
  assert.deepEqual(await closeOn('company-t9'), ['refs/company/preserved/company-t9', 'refs/heads/company-t9']);
  assert.deepEqual(await closeOn('main'), ['refs/company/preserved/company-t9'], 'a worktree left on main: main stays out');
  assert.deepEqual(await closeOn('develop'), ['refs/company/preserved/company-t9']);
  assert.deepEqual(await closeOn('HEAD'), ['refs/company/preserved/company-t9']);
  assert.deepEqual(await closeOn('company-t9', { branchDeleted: true }), ['refs/company/preserved/company-t9']);
});

test('a node whose fetch of the base fails: hq gets a BaseFetchFailed (the task waits), any other failure stays an Error', async () => {
  // The message the node's Workspaces really throws, as workspace-cli sends it back.
  const failing = new Workspaces(async (_cwd, args) => { if (args[0] === 'fetch') throw new Error('cannot lock ref'); return ''; });
  const why = await failing.base({ name: 'proj', path: '/w', defaultBranch: 'main', repo: null }, 1).then(() => '', (e: Error) => e.message);
  const on = (error: string) => {
    const node = { def: { name: 'n2', ssh: 'root@n2.test' }, exec: async () => JSON.stringify({ ok: false, error }), gitSsh: () => 'ssh' };
    const ws = new RemoteWorkspaces(node as never, '/c', '/e');
    ws.companySha = async () => null;
    return ws.create({ project: 'proj', worktreeDir: '.worktrees' } as never, { name: 'proj', path: '/w', defaultBranch: 'main', repo: null }, 'company-t9');
  };
  await assert.rejects(on(why), (e: Error) => e instanceof BaseFetchFailed && e.message.startsWith('n2: ') && /cannot lock ref/.test(e.message));
  await assert.rejects(on('no checkout "proj"'), (e: Error) => !(e instanceof BaseFetchFailed) && /^n2: no checkout/.test(e.message));
});

test('RemoteLauncher ownLogin: a machine with a user of its own runs the shift on its own login, as that user', async () => {
  const calls: { args: string[]; input?: string }[] = [];
  let hasToken = false;
  let sshDown = false;
  const run: SshRun = async (args, input) => {
    calls.push({ args, input });
    if (args.at(-1)!.includes('test -s') && sshDown) throw Object.assign(new Error('ssh: connection closed'), { code: 255 });
    if (args.at(-1)!.includes('test -s') && !hasToken) throw Object.assign(new Error('exit 1'), { code: 1 });
    return '';
  };
  const state = mkdtempSync(join(tmpdir(), 'rl-'));
  const node = new RemoteNode({ ...NODE, ssh: 'ran@laptop.test', ownLogin: true }, state, run);
  node.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const STATE = '/home/ran/.local/state/agent-company';
  const launch = async () => {
    calls.length = 0;
    await new RemoteLauncher(node, STATE).launch({ shiftId: 'p-t1-1', identity: 'p-t1', shiftNo: 1, sessionId: 's', resume: false, kind: 'work', cwd: '/w',
      socketPath: '/s.sock', taskId: 1, unit: 'company-shift@p-t1-1.service', account: 'node:n2', configDir: null, machine: 'n2' });
    const write = calls.find((c) => c.args.at(-1)!.includes('; node -e'))!;
    return JSON.parse((JSON.parse(write.input!) as Record<string, string>)[`${STATE}/shifts/p-t1-1/host-args.json`]!) as Record<string, unknown>;
  };
  try {
    assert.equal((await launch())['oauth-token-file'], undefined, 'its ~/.claude login, no token file');
    const cmd = calls.at(-1)!.args.at(-1)!;
    assert.match(cmd, /systemctl --user/, 'not root: the user manager');
    assert.match(cmd, /PATH='\/[^']+\/\.local\/share\/agent-company\/bin':\/usr\/local\/bin:/, 'the node\'s own bin first');
    hasToken = true;
    assert.equal((await launch())['oauth-token-file'], `${STATE}/node-oauth-token`, 'a token file of its own (setup-token) wins: a login there expires');
    sshDown = true;
    await assert.rejects(launch(), NodeUnreachable, 'ssh failing on the check stops the launch: not "no token"');
    assert.ok(!calls.some((c) => c.args.at(-1)!.includes('; node -e')), 'no host-args.json written');
    assert.ok(!calls.some((c) => c.args.at(-1)!.includes('enable --now')), 'no unit enabled');
  } finally { node.close(); rmSync(state, { recursive: true, force: true }); }
});

test('nodes: a laptop on battery takes no new task; its own reserve is kept; with no room 10 minutes (asleep, on battery), its task runs here', async () => {
  const r = repo();
  const calls: string[][] = [];
  const health: Parameters<typeof fakeSsh>[1] = { totalMb: 24_000, availableMb: 9_000, load1: 0.4, cpus: 16, ac: '1' };
  const LAPTOP: NodeDef = { ...NODE, portable: true, ownLogin: true, maxSlots: 3, reserveMb: 6_000 };
  const env = await makeEnv({ projects: { proj: charter(r.checkout) }, cfg: { nodes: [LAPTOP] }, deps: { ssh: fakeSsh(calls, health) }, noStart: true });
  try {
    const { hq, launcher, clock } = env;
    git(env.dir, 'init', '--quiet', '--initial-branch=main');
    git(env.dir, 'add', 'company');
    git(env.dir, 'commit', '--quiet', '-m', 'company');
    const n = hq.nodes.list[0]!;
    n.spawnMaster = () => spawn('sleep', ['60'], { stdio: ['ignore', 'ignore', 'pipe'] });
    (hq.scheduler.workspacesFor('n2') as RemoteWorkspaces).fetch = async () => {};
    await hq.start({ listen: false, timers: false });
    assert.equal(n.status?.onBattery, false);
    // 9000 − its own 6000 reserve leaves room for 2 (rssWorkMb 1300), under maxSlots 3.
    assert.deepEqual(hq.scheduler.nodeSlots().map((s) => [s.free, s.busy]), [[2, false]]);
    health.ac = '0';
    await hq.pollNodes();
    assert.equal(n.status?.onBattery, true);
    assert.deepEqual(hq.scheduler.nodeSlots().map((s) => s.free), [0], 'on battery: nothing new');

    // Placed there, the laptop answers but is on battery: the task waits a while, then runs here.
    hq.store.setToggle('scheduler', false);
    const pin = (title: string) => {
      const t = hq.scheduler.addTask({ title, project: 'proj' });
      hq.store.db.prepare(`UPDATE tasks SET machine = 'n2', worktree = ?, state = 'interrupted', started_at = 1 WHERE id = ?`)
        .run(join(r.checkout, '.worktrees', `company-t${t.id}-there`), t.id);
      return t;
    };
    const b = pin('על סוללה');
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    clock.advance(5 * 60_000);
    await hq.scheduler.fill();
    assert.equal(hq.scheduler.task(b.id)!.machine, 'n2', 'a short while: it waits for it');
    clock.advance(6 * 60_000);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(b.id)!.state === 'running', 8000, 'running here');
    assert.equal(hq.scheduler.task(b.id)!.machine, null);
    assert.equal(launcher.launches.at(-1)!.machine, 'local');

    // Out of the queue and back in it: its wait starts over, a full PORTABLE_AWAY_MS from its return.
    hq.store.setToggle('scheduler', false);
    const back = pin('יצאה וחזרה');
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    clock.advance(8 * 60_000);
    hq.store.db.prepare(`UPDATE tasks SET state = 'blocked' WHERE id = ?`).run(back.id);
    await hq.scheduler.fill();
    hq.store.db.prepare(`UPDATE tasks SET state = 'interrupted' WHERE id = ?`).run(back.id);
    await hq.scheduler.fill();
    clock.advance(5 * 60_000);
    await hq.scheduler.fill();
    // unpin runs in the background; it marks the task in fallingBack before its first await.
    const falling = () => (hq.scheduler as unknown as { fallingBack: Set<number> }).fallingBack.has(back.id);
    assert.ok(!falling() && hq.scheduler.task(back.id)!.machine === 'n2', '13 minutes since it first waited, 5 since it came back: it still waits');
    clock.advance(6 * 60_000);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(back.id)!.state === 'running', 8000, 'running here');
    assert.equal(hq.scheduler.task(back.id)!.machine, null);

    // Asleep: no word to the manager (nothing ran there), and its task runs here after a while too.
    hq.store.setToggle('scheduler', false);
    const t = pin('על הלפטופ');
    health.ac = '1';
    n.close();
    health.down = true;
    await hq.pollNodes();
    assert.equal(n.status?.up, false);
    assert.ok(!hq.mailbox.list('yoav').some((m) => m.body.includes('לא עונה')), 'a laptop asleep with nothing running is not news');
    hq.store.setToggle('scheduler', true);
    await hq.scheduler.fill();
    clock.advance(11 * 60_000);
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 8000, 'running here');
    assert.equal(hq.scheduler.task(t.id)!.machine, null);
    assert.ok(JSON.parse(hq.scheduler.task(t.id)!.labels).some((l: string) => l.startsWith('left-on:n2:')), 'its brief says the work stayed there');
  } finally { await env.cleanup(); r.cleanup(); }
});

/** An origin with two commits, and the sha of each. */
function upstream(dir: string, name: string) {
  const origin = join(dir, `${name}.git`);
  const work = join(dir, `${name}-src`);
  git(dir, 'init', '--quiet', '--bare', '--initial-branch=master', origin);
  git(dir, 'clone', '--quiet', origin, work);
  const shas: string[] = [];
  for (const f of ['a', 'b']) {
    writeFileSync(join(work, f), f);
    git(work, 'add', f);
    git(work, 'commit', '--quiet', '-m', f);
    git(work, 'push', '--quiet', 'origin', 'HEAD:master');
    shas.push(git(work, 'rev-parse', 'HEAD').trim());
  }
  return { origin, work, old: shas[0]!, pin: shas[1]! };
}

const SYNC = join(import.meta.dirname, '..', '..', '..', 'scripts', 'repo-sync.sh');
const sync = (dir: string, own: 0 | 1, ...args: string[]) => new Promise<string>((res, rej) => {
  const p = spawn('bash', ['-s', '--', String(own), ...args], { env: { ...process.env, REPO_SYNC_BASE: dir } });
  let out = '';
  p.stdout.on('data', (d) => { out += String(d); });
  p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(`exit ${code}: ${out}`))));
  p.stdin.end(readFileSync(SYNC));
});

test('repo-sync: a nested repo or mirror there goes to the commit here; one of its user only fast-forwards, and changes stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-'));
  try {
    const u = upstream(dir, 'srv');
    const at = (p: string) => git(p, 'rev-parse', 'HEAD').trim();
    const clone = (name: string, sha: string, mark = false) => {
      const p = join(dir, name);
      git(dir, 'clone', '--quiet', u.origin, p);
      git(p, 'reset', '--quiet', '--hard', sha);
      if (mark) writeFileSync(join(p, '.git', 'agent-company-node'), '');
      return p;
    };
    // Behind and ours (own=0): fetched and detached on the pin. The clone was made before the pin was pushed.
    const ours = join(dir, 'ours');
    git(dir, 'clone', '--quiet', u.origin, ours);
    git(ours, 'reset', '--quiet', '--hard', u.old);
    git(ours, 'update-ref', 'refs/remotes/origin/master', u.old);
    // Its user's, behind on its branch: fast-forwarded, still on the branch.
    const his = clone('his', u.old);
    // Its user's, diverged: stays.
    const diverged = clone('diverged', u.old);
    writeFileSync(join(diverged, 'c'), 'c');
    git(diverged, 'add', 'c');
    git(diverged, 'commit', '--quiet', '-m', 'his own');
    const divergedAt = at(diverged);
    // Marked, diverged: ours, so detached on the pin.
    const marked = clone('marked', u.old, true);
    writeFileSync(join(marked, 'c'), 'c');
    git(marked, 'add', 'c');
    git(marked, 'commit', '--quiet', '-m', 'left');
    // Tracked changes: nothing moves.
    const dirty = clone('dirty', u.old, true);
    writeFileSync(join(dirty, 'a'), 'changed');
    // Its user's, on a branch whose upstream does not have the pin (a feature branch): stays.
    const feature = clone('feature', u.old);
    git(feature, 'checkout', '--quiet', '-b', 'feat');
    // Its user's, past the pin: left, and not behind.
    const ahead = clone('ahead', u.pin);
    writeFileSync(join(ahead, 'd'), 'd');
    git(ahead, 'add', 'd');
    git(ahead, 'commit', '--quiet', '-m', 'newer');
    const aheadAt = at(ahead);
    // Missing: cloned from REPO_SYNC_BASE/<owner/name>, marked, on the pin.
    const missing = join(dir, 'missing');
    const done = clone('done', u.pin);

    const out1 = await sync(dir, 0, ours, 'srv.git', u.pin);
    assert.match(out1, / moved /);
    assert.equal(at(ours), u.pin);
    assert.equal(git(ours, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD', 'ours: detached');

    const out = await sync(dir, 1, his, 'srv.git', u.pin, diverged, 'srv.git', u.pin, marked, 'srv.git', u.pin,
      dirty, 'srv.git', u.pin, missing, 'srv.git', u.pin, done, 'srv.git', u.pin, ahead, 'srv.git', u.pin, feature, 'srv.git', u.pin);
    const line = (p: string) => out.split('\n').find((l) => l.startsWith(`${p} `)) ?? '';
    assert.equal(at(his), u.pin);
    assert.equal(git(his, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'master', 'its user\'s: fast-forwarded on its branch');
    assert.equal(at(diverged), divergedAt);
    assert.match(line(diverged), /stays: .* not an ancestor/);
    assert.equal(at(marked), u.pin);
    assert.equal(at(dirty), u.old);
    assert.match(line(dirty), /stays: changes there/);
    assert.equal(at(missing), u.pin);
    assert.ok(existsSync(join(missing, '.git', 'agent-company-node')), 'a clone of ours is marked');
    assert.match(line(done), / ok /);
    assert.match(line(his), / moved /);
    assert.equal(at(ahead), aheadAt);
    assert.match(line(ahead), / ahead /);
    assert.equal(at(feature), u.old);
    assert.match(line(feature), /stays: .* not on the upstream of feat/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('RemoteWorkspaces.create: the checkout\'s nested repos and the node\'s mirrors go there at their commit here, after the worktree; what stays behind reaches the worker', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rwc-'));
  try {
    const checkout = join(dir, 'proj');
    for (const p of [checkout, join(checkout, 'server'), join(checkout, 'reference', 'tinode-js'), join(checkout, '.worktrees', 't1', 'server'),
      join(checkout, 'app', 'node_modules', 'x'), join(dir, 'whatsmeow')]) {
      mkdirSync(join(p, '.git'), { recursive: true });
    }
    const origins: Record<string, string> = { [join(checkout, 'server')]: 'https://github.com/hive-owner/lumo-tinode.git',
      [join(checkout, 'reference', 'tinode-js')]: 'https://github.com/tinode/tinode-js', [join(dir, 'whatsmeow')]: 'git@github.com:hive-owner/whatsmeow.git' };
    const execs: { cmd: string; input?: string }[] = [];
    let syncFails: Error | null = null;
    const node = {
      def: { name: 'laptop', ssh: 'ran@laptop.test', ownLogin: true, mirror: [join(dir, 'whatsmeow')] },
      exec: async (cmd: string, input?: string) => {
        execs.push({ cmd, input });
        if (cmd.startsWith('bash -s') && syncFails) throw syncFails;
        if (cmd.startsWith('bash -s')) return `${join(checkout, 'server')} moved 1 → 2\n${join(dir, 'whatsmeow')} stays: changes there\n`;
        return JSON.stringify({ ok: true, result: { path: join(checkout, '.worktrees', 'company-t9'), branch: 'company-t9', checkout, base: 'origin/main' } });
      },
      gitSsh: () => 'ssh',
    };
    const ws = new RemoteWorkspaces(node as never, '/c', '/e', async (cwd, args) => (args[0] === 'remote' ? origins[cwd] ?? '' : `sha-${cwd.split('/').pop()}\n`));
    ws.companySha = async () => null;
    const ch = { project: 'lumo', worktreeDir: '.worktrees', checkouts: [] } as never;
    const co = { name: 'lumo-app', path: checkout, defaultBranch: 'main' } as never;
    const w = await ws.create(ch, co, 'company-t9');
    assert.equal(execs.length, 2);
    assert.match(execs[0]!.cmd, /workspace-cli/, 'the worktree first: no checkout there, nothing cloned');
    assert.equal(execs[1]!.cmd, `bash -s -- 1 '${join(checkout, 'reference', 'tinode-js')}' 'tinode/tinode-js' 'sha-tinode-js' `
      + `'${join(checkout, 'server')}' 'hive-owner/lumo-tinode' 'sha-server' '${join(dir, 'whatsmeow')}' 'hive-owner/whatsmeow' 'sha-whatsmeow'`,
    'nested repos (not in the worktrees, not node_modules, not the checkout itself) and the mirror, by sha');
    assert.equal(execs[1]!.input, readFileSync(SYNC, 'utf8'), 'the script goes on stdin');
    assert.deepEqual(w.stale, [`${join(dir, 'whatsmeow')} stays: changes there`]);

    // A sync that fails (a timeout on a slow fetch, the node gone) does not lose the worktree made there: it is said.
    syncFails = new Error('ssh killed (SIGKILL)');
    assert.deepEqual((await ws.create(ch, co, 'company-t10')).stale, ['repo-sync failed: ssh killed (SIGKILL)']);
    syncFails = new NodeUnreachable('laptop: gone');
    assert.deepEqual((await ws.create(ch, co, 'company-t11')).stale, ['repo-sync failed: laptop: gone']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
