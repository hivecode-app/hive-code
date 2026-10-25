import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv } from './helpers.ts';
import { prNumber } from '../src/awaiting.ts';

test('prNumber: number, #n and a PR url are the same; anything else is none', () => {
  assert.equal(prNumber(12), '12');
  assert.equal(prNumber('#12'), '12');
  assert.equal(prNumber('https://github.com/a/b/pull/12'), '12');
  assert.equal(prNumber('https://github.com/a/b/issues/12'), null);
  assert.equal(prNumber('abc'), null);
});

test('API #108: the board shows what waits; a deploy clears "deploy" by task id or PR in its project; "בדקתי" clears the rest', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const { scheduler, awaiting } = env.hq;
    const mk = (title: string, project: string) => {
      const t = scheduler.addTask({ title, project });
      scheduler.setTaskState(t.id, 'done');
      return t.id;
    };
    const a = mk('a', 'agent-company');
    const b = mk('b', 'agent-company');
    const c = mk('c', 'lumo');
    const d = mk('d', 'agent-company');
    awaiting.mark(a, { awaiting: 'deploy', awaiting_note: 'מחכה לפריסה' }, 'w');
    env.clock.advance(1000);
    awaiting.mark(b, { awaiting: 'deploy', pr: '#41' }, 'w');
    env.clock.advance(1000);
    awaiting.mark(c, { awaiting: 'deploy', pr: '41' }, 'w');
    env.clock.advance(1000);
    awaiting.mark(d, { awaiting: 'check', awaiting_note: 'לפתוח את האפליקציה בטלפון', pr: '42' }, 'w');

    let r = await call('GET', '/api/board');
    assert.deepEqual(r.json.awaiting.map((x: any) => x.id), [d, c, b, a], 'newest first');
    assert.equal(r.json.awaiting[0].awaiting, 'check');
    assert.equal(r.json.awaiting[0].awaiting_note, 'לפתוח את האפליקציה בטלפון');
    assert.equal(r.json.tasks.find((x: any) => x.id === a).awaiting, 'deploy', 'tasks carry it too');

    assert.equal((await call('POST', '/api/deploys', { sha: 'abc' })).status, 400, 'project is required');
    assert.equal((await call('POST', '/api/deploys', { project: 'agent-company', sha: 'abc', tasks: ['x'] })).status, 400);
    r = await call('POST', '/api/deploys', { project: 'agent-company', sha: 'abc123', target: 'hq', tasks: [a, 999], prs: [41, '42'] });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.deploy.cleared.sort(), [a, b].sort(), 'by id and by PR; lumo#41 is another repo, and check stays');
    assert.deepEqual(awaiting.list().map((x) => x.id), [d, c]);
    const row = env.hq.store.db.prepare('SELECT * FROM deploys WHERE id = ?').get(r.json.deploy.id) as any;
    assert.equal(row.sha, 'abc123');
    assert.equal(row.target, 'hq');
    assert.deepEqual(JSON.parse(row.prs), ['41', '42']);

    r = await call('POST', '/api/deploys', { project: 'lumo', sha: 'def', tasks: [a, d] });
    assert.deepEqual(r.json.deploy.cleared, [], 'a task of another project, and a check, are not cleared by id either');

    r = await call('POST', `/api/tasks/${d}/checked`);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.task.awaiting, null);
    assert.equal((await call('POST', `/api/tasks/${d}/checked`)).json.ok, false, 'twice: nothing left');
    assert.equal((await call('POST', '/api/tasks/9999/checked')).status, 404);
    assert.deepEqual((await call('GET', '/api/board')).json.awaiting.map((x: any) => x.id), [c]);
    const evs = env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'task.awaiting' || e.type === 'deploy.recorded').map((e) => e.type);
    assert.ok(evs.includes('deploy.recorded') && evs.filter((t) => t === 'task.awaiting').length >= 7);
  } finally { await env.cleanup(); }
});

test('#219: check and verify wait in "מחכה לך" at once, with "בוצע" and "נכשל"; the opener hears "נכשל"', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const { scheduler, awaiting, inbox, mailbox } = env.hq;
    const mk = (title: string, labels: string[] = []) => {
      const t = scheduler.addTask({ title, project: 'shop', labels });
      scheduler.setTaskState(t.id, 'done');
      return t.id;
    };
    const card = (id: number) => inbox.open().find((i) => i.kind === 'awaiting' && i.ref === `task-${id}`);
    const a = mk('build 20', ['opened-by:eli']);
    const b = mk('תמונות בצ\'אט');
    awaiting.mark(a, { awaiting: 'verify', awaiting_note: 'לבדוק את build 20 ב-TestFlight' }, 'w');
    awaiting.mark(b, { awaiting: 'check', awaiting_note: 'לשלוח תמונה מהטלפון' }, 'w');
    assert.equal(card(a)?.headline, 'לבדוק את build 20 ב-TestFlight');
    assert.equal(card(a)?.from_identity, 'eli', 'the opener');
    assert.equal(card(b)?.from_identity, 'yoav', 'no opener and no lead: the manager');

    // A new note updates the same card, never a second one.
    awaiting.mark(a, { awaiting_note: 'לבדוק את build 21 ב-TestFlight' }, 'w');
    assert.equal(inbox.open().filter((i) => i.ref === `task-${a}`).length, 1);
    assert.equal(card(a)?.headline, 'לבדוק את build 21 ב-TestFlight');

    // "נכשל": the task leaves both lists, and eli hears it, now.
    let r = await call('POST', `/api/inbox/${card(a)!.id}/failed`);
    assert.equal(r.status, 200);
    assert.equal(r.json.item.state, 'dismissed');
    assert.equal(awaiting.get(a), null);
    assert.equal(card(a), undefined);
    const failed = mailbox.get(`inbox-${r.json.item.id}-failed`)!;
    assert.equal(failed.to_identity, 'eli');
    assert.match(failed.body, /"נכשל"/);
    assert.equal((await call('POST', `/api/inbox/${r.json.item.id}/failed`)).status, 409, 'twice: already handled');

    // "בוצע" goes through the same /done every card uses, and wakes nobody.
    const bid = card(b)!.id;
    assert.equal((await call('POST', `/api/inbox/${bid}/dismiss`)).status, 409, 'closes with done or failed only');
    assert.equal((await call('POST', `/api/inbox/${bid}/answer`, { answer: 'x' })).status, 409);
    r = await call('POST', `/api/inbox/${bid}/done`, { note: 'done' });
    assert.equal(r.json.item.state, 'resolved');
    assert.equal(awaiting.get(b), null);
    assert.equal(mailbox.get(`inbox-${bid}-done`), undefined);

    // "בדקתי" on the old list closes the card too; marking it again opens a new one.
    const c = mk('c');
    awaiting.mark(c, { awaiting: 'check', awaiting_note: 'x' }, 'w');
    await call('POST', `/api/tasks/${c}/checked`);
    assert.equal(card(c), undefined);
    env.clock.advance(1000);
    awaiting.mark(c, { awaiting: 'check', awaiting_note: 'y' }, 'w');
    assert.equal(card(c)?.headline, 'y');

    // An opener that can't hear it (a task worker whose task closed) is skipped, for the manager.
    const opener = scheduler.addTask({ title: 'opener', project: 'shop' });
    scheduler.setTaskState(opener.id, 'done');
    env.hq.store.db.prepare("INSERT INTO identities (id, name, title, symbol, team_kind, project, lifecycle, source, active, data, updated_at) VALUES ('shop-t900', 'x', 'x', 'build', 'task', 'shop', 'ephemeral', 'runtime', 1, '{}', 0)").run();
    env.hq.store.db.prepare("UPDATE tasks SET identity = 'shop-t900' WHERE id = ?").run(opener.id);
    const e = mk('e', ['opened-by:shop-t900']);
    awaiting.mark(e, { awaiting: 'check' }, 'w');
    assert.equal(card(e)?.from_identity, 'yoav');
  } finally { await env.cleanup(); }
});

test('#219: what waited before this version gets its card when hq starts', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const t = env.hq.scheduler.addTask({ title: 'build 20', project: 'shop' });
    env.hq.store.db.prepare("UPDATE tasks SET state = 'done', awaiting = 'verify', awaiting_note = 'לבדוק ב-TestFlight', awaiting_at = ? WHERE id = ?").run(env.hq.store.now(), t.id);
    assert.equal(env.hq.inbox.open().length, 0);
    await env.hq.start({ timers: false });
    const c = env.hq.inbox.open().find((i) => i.ref === `task-${t.id}`);
    assert.equal(c?.kind, 'awaiting');
    assert.equal(c?.headline, 'לבדוק ב-TestFlight');
  } finally { await env.cleanup(); }
});

test('#219: a deploy is his only once stuck 6 hours with no GO about it; a deploy that takes it closes the card', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ timers: false });
    const { scheduler, awaiting, inbox } = env.hq;
    const mk = (title: string, identity?: string) => {
      const t = scheduler.addTask({ title, project: 'shop', identity });
      scheduler.setTaskState(t.id, 'done');
      return t.id;
    };
    const card = (id: number) => inbox.open().find((i) => i.kind === 'awaiting' && i.ref === `task-${id}`);
    const a = mk('a');                    // nothing about it
    const b = mk('b');                    // a GO that names its PR
    const c = mk('c', 'shop-t77');        // a GO its own worker asked
    const e = mk('e');                    // named as task-<id> in a GO
    const f = mk('f');                    // its GO was declined
    const h = mk('h');                    // the same PR number in another project's GO
    env.hq.store.db.prepare("INSERT INTO identities (id, name, title, symbol, team_kind, project, lifecycle, source, active, data, updated_at) VALUES ('shop-t77', 'x', 'x', 'build', 'task', 'shop', 'ephemeral', 'runtime', 1, '{}', 0), ('other-t1', 'x', 'x', 'build', 'task', 'other', 'ephemeral', 'runtime', 1, '{}', 0)").run();
    for (const [id, pr] of [[a, '51'], [b, '52'], [c, '53'], [e, '54'], [f, '55'], [h, '56']] as const) awaiting.mark(id, { awaiting: 'deploy', pr }, 'w');
    inbox.add({ kind: 'go', from_identity: 'shop-t77', title: 'GO: פריסה', body: 'נכנס: #52 ו-#5', blocking: true });
    inbox.add({ kind: 'go', from_identity: 'shop-t77', title: 'GO: c', blocking: true });
    inbox.add({ kind: 'go', from_identity: 'aviv', title: 'GO: פריסה', body: `גם task-${e}`, blocking: true });
    const declined = inbox.add({ kind: 'go', from_identity: 'aviv', title: `GO: משימה ${f}`, blocking: true });
    inbox.resolve(declined.id, 'dismissed');
    inbox.add({ kind: 'go', from_identity: 'other-t1', title: 'GO: other', body: '#56', blocking: true });
    awaiting.sweep();
    assert.equal(card(a), undefined, 'not yet');
    env.clock.advance(3 * 3600_000);
    awaiting.mark(a, { awaiting: 'deploy', awaiting_note: 'תיקון של ההערה' }, 'lead');
    env.clock.advance(3 * 3600_000);
    awaiting.sweep();
    assert.ok(card(a), 'stuck 6 hours, a fixed note did not restart them: his');
    assert.equal(card(b), undefined, 'a GO naming its PR: not his');
    assert.equal(card(c), undefined, 'a GO its worker asked');
    assert.equal(card(e), undefined, 'a GO naming task-<id>');
    assert.ok(card(f), 'a declined GO: stuck again, his');
    assert.ok(card(h), 'PR #56 of another project is not this one');
    awaiting.sweep();
    assert.equal(inbox.open().filter((i) => i.kind === 'awaiting').length, 3, 'idempotent');
    // Shown, then a GO is asked (the card goes), then declined: the card comes back.
    const go = inbox.add({ kind: 'go', from_identity: 'aviv', title: `GO: t${a}`, blocking: true });
    awaiting.sweep();
    assert.equal(card(a), undefined, 'a GO asked: that card is his now');
    inbox.resolve(go.id, 'dismissed');
    awaiting.sweep();
    assert.ok(card(a), 'declined: stuck again, back');
    awaiting.deployed({ project: 'shop', sha: 'x', prs: ['51'] });
    assert.equal(card(a), undefined, 'deployed: gone');
  } finally { await env.cleanup(); }
});

test('waitingDeploy: merged PRs waiting for GO or a deploy, for drift-check; deployed and other projects not', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ timers: false });
    const { scheduler, awaiting, inbox } = env.hq;
    const mk = (project: string) => { const t = scheduler.addTask({ title: 'x', project }); scheduler.setTaskState(t.id, 'done'); return t.id; };
    const a = mk('shop'), b = mk('shop'), c = mk('other');
    awaiting.mark(a, { awaiting: 'deploy', pr: '61' }, 'w');
    awaiting.mark(c, { awaiting: 'deploy', pr: '63' }, 'w');
    scheduler.setTaskState(b, 'done');
    env.hq.store.db.prepare('UPDATE tasks SET pr = ? WHERE id = ?').run('62', b);
    env.hq.store.db.prepare("INSERT INTO identities (id, name, title, symbol, team_kind, project, lifecycle, source, active, data, updated_at) VALUES ('shop-t9', 'x', 'x', 'build', 'task', 'shop', 'ephemeral', 'runtime', 1, '{}', 0)").run();
    inbox.add({ kind: 'go', from_identity: 'shop-t9', title: 'GO: פריסה', body: 'נכנס: #64', blocking: true });
    const w = awaiting.waitingDeploy('shop');
    assert.deepEqual(w.prs.sort(), ['61', '64'], 'awaiting + a PR named in a live GO of the project; not another project, not an unrelated done task');
    awaiting.clear(a, 'deploy', 'deployed');
    assert.deepEqual(awaiting.waitingDeploy('shop').prs, ['64']);
  } finally { await env.cleanup(); }
});

test('#297: "לא רלוונטי" takes the card off without "נכשל"; the opener hears it was closed as not relevant', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    await env.hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (method: string, path: string) => {
      const res = await fetch(`http://127.0.0.1:${env.hq.port}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    const { scheduler, awaiting, inbox, mailbox } = env.hq;
    const t = scheduler.addTask({ title: 'קוליות בוואטסאפ', project: 'shop', labels: ['opened-by:eli'] });
    scheduler.setTaskState(t.id, 'done');
    awaiting.mark(t.id, { awaiting: 'check', awaiting_note: 'לפתוח את וואטסאפ בשביל קוליות' }, 'w');
    const id = inbox.open().find((i) => i.ref === `task-${t.id}`)!.id;
    const r = await call('POST', `/api/inbox/${id}/irrelevant`);
    assert.equal(r.status, 200);
    assert.equal(r.json.item.state, 'dismissed');
    assert.equal(awaiting.get(t.id), null);
    assert.equal(mailbox.get(`inbox-${id}-failed`), undefined, 'nothing says it failed');
    const told = mailbox.get(`inbox-${id}-irrelevant`)!;
    assert.equal(told.to_identity, 'eli');
    assert.match(told.body, /"לא רלוונטי"/);
    assert.doesNotMatch(told.body, /נכשל/);
    const ev = env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'task.awaiting').at(-1)!;
    assert.equal((ev.data as any).why, 'irrelevant');
    assert.equal((await call('POST', `/api/inbox/${id}/irrelevant`)).status, 409, 'twice: already handled');
  } finally { await env.cleanup(); }
});

test('#297: a deploy clears once its follow-ups ("משימה <id>: …") are closed and none waits on a deploy, up the chain', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { scheduler, awaiting } = env.hq;
    const mk = (title: string, project = 'bot') => scheduler.addTask({ title, project }).id;
    const done = (id: number, a: Record<string, unknown> = {}) => { awaiting.mark(id, a, 'w'); scheduler.setTaskState(id, 'done'); };
    const p = mk('דיוק: נסיעה פנימית בלי מחיר');
    done(p, { awaiting: 'deploy', pr: '296' });
    const worker = mk(`משימה ${p}: שחרור וורקר 1.2.52 לכל הצי`);
    const matcher = mk(`משימה ${p}: פריסת ride-matcher`);
    const more = mk(`משימה ${p}, המשך: מה שהכלל מפספס`);
    const other = mk(`משימה ${p}: משהו בפרויקט אחר`, 'lumo');
    done(other);
    done(worker);
    assert.equal(awaiting.get(p)?.awaiting, 'deploy', 'the matcher is still open');
    done(matcher);
    assert.equal(awaiting.get(p)?.awaiting, 'deploy', 'the follow-up "המשך" is still open');
    done(more, { awaiting: 'deploy', pr: '302' });
    assert.equal(awaiting.get(p)?.awaiting, 'deploy', 'the follow-up waits on its own deploy');
    const w2 = mk(`משימה ${more}: שחרור וורקר 1.2.53`);
    const m2 = mk(`משימה ${more}: פריסת ride-matcher`);
    done(w2);
    assert.equal(awaiting.get(more)?.awaiting, 'deploy');
    done(m2);
    assert.equal(awaiting.get(more), null, 'its follow-ups closed');
    assert.equal(awaiting.get(p), null, 'and so the first one too');
    const ev = env.hq.store.eventsAfter(0, 1000).filter((e) => e.type === 'task.awaiting' && (e.data as any).id === p).at(-1)!;
    assert.equal((ev.data as any).why, 'followups');

    // A deploy that reports the follow-up clears it, and its parent with it.
    const q = mk('q');
    done(q, { awaiting: 'deploy' });
    const f = mk(`t${q}: המשך`);
    done(f, { awaiting: 'deploy' });
    assert.equal(awaiting.get(q)?.awaiting, 'deploy');
    awaiting.deployed({ project: 'bot', sha: 'abc', tasks: [f] });
    assert.equal(awaiting.get(q), null);

    // No follow-ups: nothing changes. A "check" parent is not touched.
    const solo = mk('solo');
    done(solo, { awaiting: 'deploy' });
    const c = mk('c');
    done(c, { awaiting: 'check' });
    done(mk(`משימה ${c}: x`));
    assert.equal(awaiting.get(solo)?.awaiting, 'deploy');
    assert.equal(awaiting.get(c)?.awaiting, 'check');
    // Not a follow-up: "t3.micro", "משימה 2 מתוך 3".
    const r = mk('r');
    done(r, { awaiting: 'deploy' });
    done(mk(`שרת t${r}.micro`));
    done(mk(`משימה ${r} מתוך 3`));
    assert.equal(awaiting.get(r)?.awaiting, 'deploy');
  } finally { await env.cleanup(); }
});
