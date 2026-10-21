// #128: יואב opened an urgent task (81), it waited in the queue half an hour, and רן saw it nowhere: not on
// the board, not in his conversations. Now every task not done is on `/api/board` `open_tasks`, with who opened
// it, who is on it, its state and its place in line, and the home has a `tasks` block for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, until } from './helpers.ts';
import { plainTitle } from '../src/open-tasks.ts';
import { validateBlocks, type HomeRefs } from '../src/home.ts';

test('plainTitle: no area prefix, no PR or issue numbers', () => {
  assert.equal(plainTitle('hq: שגיאת המפתח בקבלות (#81)'), 'שגיאת המפתח בקבלות');
  assert.equal(plainTitle('אפליקציה: תמונות בצ\'אט PR #12'), 'תמונות בצ\'אט');
  assert.equal(plainTitle('#128 משימה בתור לא מופיעה'), 'משימה בתור לא מופיעה');
  assert.equal(plainTitle('סיום PR #43: X'), 'X');
  assert.equal(plainTitle('בלי קידומת'), 'בלי קידומת');
  assert.equal(plainTitle('hq:'), 'hq:', 'nothing left: the title as it was');
});

test('#128: queued tasks are on the board with their opener, place in line and why they wait', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env;
    // One work slot: (7046 − 4096 − 1 resident × 450) / 2500.
    hq.scheduler.memInfo = () => ({ totalMb: 7046, availableMb: 7000 });
    await hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const get = async (path: string) => (await (await fetch(`http://127.0.0.1:${hq.port}${path}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, any>;

    const a = hq.scheduler.addTask({ title: 'hq: שגיאת המפתח בקבלות (#81)', project: 'agent-company', priority: 0, labels: ['opened-by:yoav'] });
    await until(() => hq.scheduler.task(a.id)!.state === 'running', 3000, 'a running');
    env.clock.advance(1000);
    const b = hq.scheduler.addTask({ title: 'אפליקציה: דבר שני PR #12', project: 'agent-company', labels: ['opened-by:yoav'] });
    env.clock.advance(1000);
    const c = hq.scheduler.addTask({ title: 'בלי מי שפתח', project: 'agent-company' });
    const d = hq.scheduler.addTask({ title: 'מחכה להחלטה', project: 'agent-company', labels: ['opened-by:eli', 'needs-decision'] });
    const e = hq.scheduler.addTask({ title: 'כבר נגמרה', project: 'agent-company' });
    hq.scheduler.setTaskState(e.id, 'done');
    await hq.scheduler.fill();

    const r = await get('/api/board');
    const open = r.open_tasks as any[];
    assert.deepEqual(open.map((t) => t.id), [a.id, b.id, c.id, d.id], 'running, the queue in its order, the blocked; done is gone');
    const [ra, rb, rc, rd] = open;
    assert.deepEqual({ ...ra, since: undefined }, { id: a.id, ref: null, project: 'agent-company', title: 'שגיאת המפתח בקבלות', opened_by: 'yoav',
      worker: `agent-company-t${a.id}`, state: 'running', position: null, reason: null, since: undefined });
    assert.equal(ra.since, hq.scheduler.task(a.id)!.started_at);
    assert.deepEqual([rb.state, rb.position, rb.reason, rb.worker, rb.title, rb.opened_by], ['queued', 1, 'מחכה למשבצת', null, 'דבר שני', 'yoav']);
    assert.deepEqual([rc.state, rc.position, rc.opened_by], ['queued', 2, 'ac-ceo'], 'no opener: the project lead');
    assert.deepEqual([rd.state, rd.position, rd.reason, rd.opened_by], ['blocked', null, 'מחכה להחלטה', 'eli']);

    // Its worker asks him: the task waits for him.
    hq.mailbox.ask({ from: `agent-company-t${a.id}`, question: 'למחוק את המפתח הישן?', options: ['כן', 'לא'], blocking: true });
    assert.equal(hq.openTasks().find((t) => t.id === a.id)!.state, 'waiting_for_you');

    // Night scope that leaves the project out: still listed, and says why.
    hq.scheduler.scope = () => ['lumo'];
    assert.deepEqual(hq.openTasks().filter((t) => t.id === b.id).map((t) => [t.state, t.position, t.reason]), [['queued', null, 'מחוץ להיקף הלילה']]);
  } finally { await env.cleanup(); }
});

test('#128: a task handed to a busy standing worker waits for that worker, not for a slot', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq } = env;
    await hq.start({ listen: false, timers: false });
    hq.store.db.prepare(`UPDATE identities SET lifecycle = 'standing', active = 1 WHERE id = 'amit'`).run();
    const one = hq.scheduler.addTask({ title: 'ראשונה', identity: 'amit' });
    await until(() => hq.scheduler.task(one.id)!.state === 'running', 3000, 'first running');
    const two = hq.scheduler.addTask({ title: 'שנייה', identity: 'amit' });
    await hq.scheduler.fill();
    const t = hq.openTasks().find((x) => x.id === two.id)!;
    assert.deepEqual([t.state, t.position, t.reason], ['queued', 1, 'מחכה שעמית יתפנה']);
  } finally { await env.cleanup(); }
});

test('#128: home block tasks {tasks: [ids] | "open"}: validated, in the default, gone when its task is', async () => {
  const env = await makeEnv();
  try {
    const { hq } = env;
    const refs: HomeRefs = { projects: new Set(), identities: new Set(), inbox: new Set(), awaiting: new Set(), open: new Set([5, 6]) };
    assert.deepEqual(validateBlocks([{ type: 'tasks', tasks: 'open' }], refs), [{ type: 'tasks', tasks: 'open' }]);
    assert.deepEqual(validateBlocks([{ type: 'tasks', tasks: [6, 6, 5], emphasis: 'strong' }], refs), [{ type: 'tasks', tasks: [6, 5], emphasis: 'strong' }]);
    assert.throws(() => validateBlocks([{ type: 'tasks', tasks: [7] }], refs), /לא פתוחה/);
    assert.throws(() => validateBlocks([{ type: 'tasks', tasks: 'all' }], refs), /open/);
    assert.throws(() => validateBlocks([{ type: 'tasks', tasks: [] }], refs), /open/);

    const t = hq.scheduler.addTask({ title: 'דחופה', project: 'agent-company', labels: ['opened-by:yoav'] });
    assert.equal(hq.home.defaultRecipe().blocks.some((b) => b.type === 'tasks'), false, 'the default leaves the list to the status screen');

    hq.home.compose([{ type: 'headline', text: 'משימה דחופה' }, { type: 'tasks', tasks: [t.id], emphasis: 'strong' }], 'yoav');
    assert.deepEqual(hq.home.current().blocks.find((b) => b.type === 'tasks'), { type: 'tasks', tasks: [t.id], emphasis: 'strong' });
    assert.match(hq.home.wakeBody([]), new RegExp(`${t.id}: דחופה`), 'the composer sees the open tasks');
    hq.scheduler.setTaskState(t.id, 'done');
    assert.equal(hq.home.current().blocks.some((b) => b.type === 'tasks'), false, 'done: the block is gone, the recipe stays');
    assert.equal(hq.home.current().source, 'agent');
  } finally { await env.cleanup(); }
});
