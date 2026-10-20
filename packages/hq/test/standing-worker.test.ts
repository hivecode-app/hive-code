// A task for a standing worker (open_team `assignee`): its own worktree and a fresh session, one task at a time
// (the next waits in its queue without holding a slot), messages go to the task's shift, and between tasks a
// message wakes it in the project checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { WalEntry } from '@company/shared';
import { charter, makeEnv, ORG_YAML, repo, until } from './helpers.ts';
import { ShiftBusyError } from '../src/shifts.ts';

const ORG = ORG_YAML.replace('identities:\n', `  - {id: proj, kind: project, project: proj, symbol: domain, lead: proj-ceo, members: [gal]}
identities:
`) + `  - {id: proj-ceo, name: מאיה, title: מנכ"לית proj, symbol: architecture, team: proj, lifecycle: always-on}
  - {id: gal, name: גל, title: אחראי שרת, symbol: dns, team: proj, lifecycle: dormant}
`;

function post(socketPath: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = request({ socketPath, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': payload.length } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const entry = (args: Record<string, unknown>, id: string, identity = 'proj-ceo'): WalEntry =>
  ({ id, v: 1, ts: new Date().toISOString(), identity, shift: `${identity}-1`, sessionId: null, op: 'open_team', args });

test('open_team assignee: a standing worker of the project gets the task; anyone else is a 400 with the reason', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG, projects: { proj: charter(r.checkout) }, noStart: true });
  try {
    const { hq } = env;
    await hq.start({ listen: true, timers: false });
    hq.store.setToggle('scheduler', false);
    const sock = join(env.cfg.stateDir, 'hq.sock');
    // yoav has no project: the assignee's project is the task's.
    const ok = await post(sock, '/v1/ops', entry({ name: 'שדרוג השרת', purpose: 'לשדרג', assignee: 'gal' }, 'yoav-1:01', 'yoav'));
    assert.equal(ok.status, 200);
    const t = hq.scheduler.task(ok.json.result.task)!;
    assert.equal(t.identity, 'gal');
    assert.equal(t.project, 'proj');

    const no = async (args: Record<string, unknown>, id: string, re: RegExp, who = 'proj-ceo') => {
      const res = await post(sock, '/v1/ops', entry({ name: 'x', purpose: 'y', ...args }, id, who));
      assert.equal(res.status, 400, id);
      assert.match(res.json.reason, re, id);
    };
    await no({ assignee: 'nobody' }, 'proj-ceo-1:01', /אין עובד קבוע/);
    await no({ assignee: 'proj-ceo' }, 'proj-ceo-1:02', /לא עובד קבוע/);
    await no({ assignee: 'yoav' }, 'proj-ceo-1:03', /לא עובד קבוע/);
    await no({ assignee: 'amit', project: 'proj' }, 'proj-ceo-1:04', /לא שייך לפרויקט `proj`/);
    await no({ assignee: 'gal', project: 'agent-company' }, 'proj-ceo-1:05', /לא שייך לפרויקט `agent-company` אלא ל-`proj`/);
    // Without an assignee nothing changes: a temporary worker.
    const temp = await post(sock, '/v1/ops', entry({ name: 'זמני', purpose: 'y' }, 'proj-ceo-1:06'));
    assert.equal(hq.scheduler.task(temp.json.result.task)!.identity, null);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('standing worker: own worktree and a new session per task, one at a time, the next waits without holding a slot', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG, projects: { proj: charter(r.checkout) } });
  try {
    const { hq, launcher } = env;
    // It ran before (a resumable session in the checkout): the task must not resume it.
    await hq.shifts.request('gal', { reason: 'message' });
    await hq.shifts.stop('gal-1', 'rest');
    hq.scheduler.memInfo = () => ({ totalMb: 4096 + 450 + 2 * 2500 + 100, availableMb: 4096 + 2 * 2500 + 100 }); // 2 slots

    const a = hq.scheduler.addTask({ title: 'ראשונה', project: 'proj', identity: 'gal', labels: ['opened-by:proj-ceo'], priority: 1 });
    await until(() => hq.scheduler.task(a.id)!.state === 'running', 5000, 'first task running');
    const wa = join(r.checkout, '.worktrees', `company-t${a.id}`);
    const la = launcher.launches.at(-1)!;
    assert.equal(la.identity, 'gal');
    assert.equal(la.cwd, wa, 'its own worktree');
    assert.equal(la.resume, false, 'a new session');
    assert.equal(la.shiftId, 'gal-2');
    const prompt = hq.mailbox.list('gal').find((m) => m.id.startsWith(`task-${a.id}-gal-2-`))!;
    assert.match(prompt.body, /איפה עובדים/);
    assert.match(prompt.body, /`handoff`/, 'a standing worker hears how to close, with a handoff');
    assert.equal(prompt.from_identity, 'proj-ceo');

    // Its second task waits (even at a better priority); a temporary worker's task takes the free slot.
    const b = hq.scheduler.addTask({ title: 'שנייה', project: 'proj', identity: 'gal', labels: ['opened-by:proj-ceo'], priority: 0 });
    const c = hq.scheduler.addTask({ title: 'של עובד זמני', project: 'proj' });
    await until(() => hq.scheduler.task(c.id)!.state === 'running', 5000, 'the slot goes on to the next task');
    await hq.scheduler.fill();
    assert.equal(hq.scheduler.task(b.id)!.state, 'queued');

    const board = () => hq.board().find((x) => x.id === 'gal')!;
    assert.equal(board().current_task?.id, a.id);
    assert.equal(board().queued, 1);

    // A message during the task goes to the task's shift.
    hq.mailbox.tell({ msg_id: 'm-1', from: 'proj-ceo', to: 'gal', body: 'איך מתקדם?' });
    await until(() => hq.mailbox.get('m-1')!.state === 'delivered', 3000, 'delivered');
    assert.equal(hq.mailbox.get('m-1')!.shift_id, 'gal-2');

    // Resting on its task: a message resumes the task's session in the task's worktree, and the next task still waits.
    await hq.shifts.stop('gal-2', 'rest');
    await until(() => hq.scheduler.task(a.id)!.state === 'resting', 3000, 'resting');
    await hq.scheduler.fill();
    assert.equal(hq.scheduler.task(b.id)!.state, 'queued', 'resting is still busy');
    hq.mailbox.tell({ msg_id: 'm-2', from: 'proj-ceo', to: 'gal', body: 'עוד שאלה' });
    await until(() => hq.scheduler.task(a.id)!.state === 'running', 3000, 'woken on its task');
    assert.equal(launcher.launches.at(-1)!.cwd, wa);
    assert.equal(launcher.launches.at(-1)!.resume, true);

    // Done (status done / close_team): the next task starts, in its own worktree, in a new session.
    await hq.scheduler.completeTask(a.id);
    await until(() => hq.scheduler.task(b.id)!.state === 'running', 5000, 'second task starts when the first is done');
    const lb = launcher.launches.at(-1)!;
    assert.equal(lb.cwd, join(r.checkout, '.worktrees', `company-t${b.id}`));
    assert.equal(lb.resume, false);
    assert.equal(lb.shiftId, 'gal-3');
    await until(() => !existsSync(wa), 5000, 'the first worktree is removed');
    assert.equal(board().current_task?.id, b.id);
    assert.equal(board().queued, 0);

    // Between tasks: a message wakes it in the project checkout, in a new session (not the done task's).
    await hq.scheduler.completeTask(b.id);
    assert.equal(hq.shifts.current('gal'), undefined);
    assert.equal(board().current_task, null);
    hq.mailbox.tell({ msg_id: 'm-3', from: 'proj-ceo', to: 'gal', body: 'מה למדת?' });
    await until(() => hq.mailbox.get('m-3')!.state === 'delivered', 3000, 'woken by a message');
    const lm = launcher.launches.at(-1)!;
    assert.equal(lm.cwd, r.checkout, 'the project checkout');
    assert.equal(lm.resume, false);
    assert.equal(lm.taskId, null);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('standing worker: a task never cuts a conversation in the middle of a turn, and a lead still runs its tasks where it runs', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG, projects: { proj: charter(r.checkout) } });
  try {
    const { hq, launcher } = env;
    await hq.shifts.request('gal', { reason: 'message' });
    await until(() => hq.shifts.current('gal')?.state === 'live', 3000, 'live');
    hq.shifts.setFields('gal-1', { in_turn: 1 });
    const t = hq.scheduler.addTask({ title: 'משימה', project: 'proj', identity: 'gal' });
    await hq.scheduler.fill();
    assert.equal(hq.scheduler.task(t.id)!.state, 'queued', 'waits for the turn to end');
    // A turn that began after the fill looked (during a long worktree_setup) is spared at the launch itself.
    await assert.rejects(hq.shifts.request('gal', { reason: 'task', taskId: t.id, forceNew: true, spareTurn: true }), ShiftBusyError);
    assert.equal(hq.shifts.get('gal-1')!.state, 'live');
    hq.shifts.setFields('gal-1', { in_turn: 0 });
    await hq.scheduler.fill();
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 5000, 'starts once the conversation is idle');
    assert.equal(hq.shifts.get('gal-1')!.state, 'ended');
    assert.equal(launcher.launches.at(-1)!.shiftId, 'gal-2');

    // A lead (no assignee path): unchanged, it runs where it runs and gets no worktree.
    const own = hq.scheduler.addTask({ title: 'לראש הצוות', project: 'proj', identity: 'proj-ceo' });
    await until(() => hq.scheduler.task(own.id)!.state === 'running', 5000, 'lead task running');
    assert.equal(hq.scheduler.task(own.id)!.worktree, null);
    assert.equal(launcher.launches.find((l) => l.identity === 'proj-ceo')!.cwd, r.checkout);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('standing worker: woken by a message on an interrupted task, it works on the task in its worktree', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG, projects: { proj: charter(r.checkout) } });
  try {
    const { hq, launcher } = env;
    const t = hq.scheduler.addTask({ title: 'משימה', project: 'proj', identity: 'gal' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 5000, 'running');
    const wt = hq.scheduler.task(t.id)!.worktree!;
    // The watchdog ends a stuck task shift; the task waits at the head of the queue (here: no free slot).
    hq.store.setToggle('scheduler', false);
    await hq.shifts.stop(hq.shifts.current('gal')!.id, 'stuck');
    await until(() => hq.scheduler.task(t.id)!.state === 'interrupted', 3000, 'interrupted');
    assert.equal(hq.scheduler.findTeam('gal').task?.id, t.id, 'close_team finds it by the worker too');
    assert.equal(hq.scheduler.findTeam('גל').task?.id, t.id);
    hq.mailbox.tell({ msg_id: 'm-1', from: 'proj-ceo', to: 'gal', body: 'מה המצב?' });
    await until(() => hq.mailbox.get('m-1')!.state === 'delivered', 3000, 'delivered');
    const l = launcher.launches.at(-1)!;
    assert.equal(l.cwd, wt, 'the task worktree, not the checkout');
    assert.equal(l.taskId, t.id);
    assert.equal(l.resume, false, 'stuck: a new session');
    await until(() => hq.scheduler.task(t.id)!.state === 'running', 3000, 'back on its task');
    // A lead's identity is not a way to its tasks.
    const lead = hq.scheduler.addTask({ title: 'לראש הצוות', project: 'proj', identity: 'proj-ceo', state: 'running' });
    assert.equal(hq.scheduler.findTeam('proj-ceo').task?.id === lead.id, false);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('close_team on a standing worker: it is asked for a handoff, closes itself, or is closed after the grace', async () => {
  const r = repo();
  const env = await makeEnv({ org: ORG, projects: { proj: charter(r.checkout) }, noStart: true });
  try {
    const { hq, clock, cfg } = env;
    await hq.start({ listen: true, timers: false });
    const sock = join(cfg.stateDir, 'hq.sock');
    const close = (team: string, id: string) => post(sock, '/v1/ops', { id, v: 1, ts: new Date().toISOString(), identity: 'proj-ceo', shift: 'proj-ceo-1',
      sessionId: null, op: 'close_team', args: { team, reason: 'עדיפות אחרת' } });

    const a = hq.scheduler.addTask({ title: 'ראשונה', project: 'proj', identity: 'gal', labels: ['opened-by:proj-ceo'] });
    await until(() => hq.scheduler.task(a.id)!.state === 'running', 5000, 'running');
    const res = await close(`t${a.id}`, 'proj-ceo-1:c1');
    assert.equal(res.json.result.state, 'closing');
    const ask = hq.mailbox.get(`task-${a.id}-closing`)!;
    assert.equal(ask.to_identity, 'gal');
    assert.match(ask.body, /`handoff`/);
    assert.match(ask.body, /עדיפות אחרת/);
    assert.equal(hq.scheduler.task(a.id)!.state, 'running', 'not stopped before its handoff');
    // A task of its still in the queue closes at once; the one it is on keeps running.
    const queued = hq.scheduler.addTask({ title: 'בתור', project: 'proj', identity: 'gal', labels: ['opened-by:proj-ceo'] });
    const q = await close(`t${queued.id}`, 'proj-ceo-1:c0');
    assert.equal(q.json.result.state, 'closing');
    await until(() => hq.scheduler.task(queued.id)!.state === 'done', 3000, 'queued task closed at once');
    assert.equal(hq.mailbox.get(`task-${queued.id}-closing`), undefined, 'no handoff asked for it');
    assert.match(hq.mailbox.get('proj-ceo-1:c0-close')!.body, /שחיכתה לך בתור בוטלה/, 'not "your shift stops now"');
    assert.equal(hq.scheduler.task(a.id)!.state, 'running');
    // It writes a handoff and closes with status done.
    await post(sock, '/v1/ops', { id: 'gal-1:h', v: 1, ts: new Date().toISOString(), identity: 'gal', shift: 'gal-1', sessionId: null, op: 'handoff', args: { state: 'נסגר באמצע' } });
    await post(sock, '/v1/ops', { id: 'gal-1:d', v: 1, ts: new Date().toISOString(), identity: 'gal', shift: 'gal-1', sessionId: null, op: 'status', args: { state: 'done' } });
    await until(() => hq.scheduler.task(a.id)!.state === 'done', 3000, 'closed by the worker');

    // It never answers: the sweep closes it once the grace is over.
    const b = hq.scheduler.addTask({ title: 'שנייה', project: 'proj', identity: 'gal', labels: ['opened-by:proj-ceo'] });
    await until(() => hq.scheduler.task(b.id)!.state === 'running', 5000, 'second running');
    await close(`t${b.id}`, 'proj-ceo-1:c2');
    await hq.scheduler.sweep();
    assert.equal(hq.scheduler.task(b.id)!.state, 'running');
    clock.advance(cfg.timers.handoffGraceMs);
    await hq.scheduler.sweep();
    assert.equal(hq.scheduler.task(b.id)!.state, 'done');
    assert.equal(hq.shifts.current('gal'), undefined);
  } finally { await env.cleanup(); r.cleanup(); }
});

test('a lead whose task closed while it rested still resumes its session', async () => {
  const env = await makeEnv({ org: ORG });
  try {
    const { hq, launcher } = env;
    const t = hq.scheduler.addTask({ title: 'לראש הצוות', project: 'proj', identity: 'proj-ceo' });
    await until(() => hq.scheduler.task(t.id)!.state === 'running' && hq.shifts.current('proj-ceo')?.state === 'live'
      && hq.shifts.current('proj-ceo')!.host_seq > 0, 5000, 'running, and its session ran');
    await hq.shifts.stop(hq.shifts.current('proj-ceo')!.id, 'rest');
    hq.scheduler.setTaskState(t.id, 'done');
    await hq.shifts.request('proj-ceo', { reason: 'message' });
    assert.equal(launcher.launches.at(-1)!.resume, true);
  } finally { await env.cleanup(); }
});
