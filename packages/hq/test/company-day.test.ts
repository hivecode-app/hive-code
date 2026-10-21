// The company map's day: lines without any text, how long each worker took to answer HIM, merges from hq's own
// event (the spool of a worker's `gh pr merge`, or a POST), and the text of one line on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, until } from './helpers.ts';
import { dayBounds, dateOf, isDate } from '../src/company-day.ts';
import { prMergedFrom } from '../src/merged.ts';

test('dayBounds: the calendar day in the company zone, DST included', () => {
  assert.deepEqual(dayBounds('2026-10-21', 'Asia/Bangkok'), { start: Date.UTC(2026, 9, 20, 17), end: Date.UTC(2026, 9, 21, 17) });
  assert.equal(dayBounds('2026-03-29', 'Europe/Berlin').end - dayBounds('2026-03-29', 'Europe/Berlin').start, 23 * 3_600_000, 'the short day');
  assert.equal(dateOf(Date.UTC(2026, 9, 20, 18), 'Asia/Bangkok'), '2026-10-21');
  assert.ok(isDate('2026-10-21') && !isDate('2026-13-01') && !isDate('2026-10-21x') && !isDate('2026-02-30'));
});

test('prMergedFrom: only a merge that happened, with the PR it merged', () => {
  const bash = (command: string, stdout: string, cwd = '/home/a/projects/agent-company/.worktrees/company-t5') => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout }, cwd });
  assert.deepEqual(prMergedFrom(bash('gh pr merge --squash --delete-branch', '✓ Squashed and merged pull request #226 (אפליקציה: רשימה)')),
    { repo: 'agent-company', number: 226, title: 'אפליקציה: רשימה' }, 'the repo is the checkout the worktree hangs off');
  assert.deepEqual(prMergedFrom(bash('gh pr merge 7 -R hive-owner/lumo-app --squash', '✓ Squashed and merged pull request hive-owner/lumo-app#7 (x)')),
    { repo: 'hive-owner/lumo-app', number: 7, title: 'x' });
  assert.deepEqual(prMergedFrom(bash('cd /w && gh api -X PUT repos/o/r/pulls/9/merge -f merge_method=squash', '{"sha":"a","merged":true}', '/w')),
    { repo: 'o/r', number: 9, title: null });
  assert.equal(prMergedFrom(bash('gh pr merge 7 --auto --squash', '✓ Pull request #7 will be automatically merged when all requirements are met')), null, 'auto: not merged yet');
  assert.equal(prMergedFrom(bash('gh pr merge 7', 'X Pull request #7 is not mergeable')), null);
  assert.equal(prMergedFrom(bash('gh pr view 7', 'merged pull request #7')), null);
  assert.equal(prMergedFrom({ tool_name: 'Read', tool_input: {}, tool_response: '' }), null);
});

test('the day: lines carry no text, his answer time, merges once per PR, and a line\'s text on its own', async () => {
  const env = await makeEnv({ noStart: true });
  try {
    const { hq, clock, launcher } = env;
    await hq.start({ listen: true, timers: false });
    const token = readFileSync(join(env.cfg.stateDir, 'api-token'), 'utf8').trim();
    const call = async (path: string, init?: RequestInit) => await fetch(`http://127.0.0.1:${hq.port}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
    const get = async (path: string) => (await (await call(path)).json()) as Record<string, any>;

    clock.t = Date.UTC(2026, 9, 20, 9, 0, 0);
    hq.mailbox.tell({ msg_id: 'm1', from: 'owner', to: 'eli', body: 'מה המצב? סודי' });
    clock.advance(30_000);
    hq.mailbox.tell({ msg_id: 'm2', from: 'eli', to: 'owner', body: 'הכול בסדר' });
    clock.advance(60_000);
    hq.mailbox.tell({ msg_id: 'm3', from: 'owner', to: 'eli', body: 'תודה' });
    clock.advance(60_000);
    hq.mailbox.tell({ msg_id: 'm4', from: 'rotem', to: 'yoav', body: 'כל הבדיקות ירוקות' });
    // A worker's `gh pr merge` in the hook spool becomes `pr.merged` with its task's project; a retried spool and a POST
    // for the same PR add nothing; a POST for another PR is its own merge.
    const task = hq.scheduler.addTask({ title: 'מפה', project: 'agent-company' });
    await until(() => hq.scheduler.task(task.id)!.state === 'running', 3000, 'running');
    const shift = `agent-company-t${task.id}-1`;
    await until(() => hq.shifts.get(shift)?.state === 'live', 3000, 'live');
    const merged = (stdout: string, command = 'gh pr merge --squash') => ({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout }, cwd: '/p/agent-company/.worktrees/company-t1' });
    const host = launcher.hosts.get(shift)!;
    host.spool.push(
      { cursor: '001', ts: '', event: 'PostToolUse', payload: merged('✓ Squashed and merged pull request #226 (x)') },
      { cursor: '002', ts: '', event: 'PostToolUse', payload: merged('✓ Squashed and merged pull request #226 (x)') },
      { cursor: '003', ts: '', event: 'PostToolUse', payload: merged('✓ Pull request #228 will be automatically merged', 'gh pr merge 228 --auto') },
    );
    await hq.shifts.collectSpool(shift);
    const mergedEvents = () => hq.store.db.prepare(`SELECT data FROM events WHERE type = 'pr.merged'`).all().map((r: any) => JSON.parse(r.data));
    assert.deepEqual(mergedEvents().map((e) => [e.repo, e.number, e.project, e.by]), [['agent-company', 226, 'agent-company', shift.replace(/-\d+$/, '')]]);
    const post = async (b: object) => (await (await call('/api/prs/merged', { method: 'POST', body: JSON.stringify(b) })).json() as any).recorded;
    assert.equal(await post({ repo: 'agent-company', number: 226 }), false);
    assert.equal(await post({ repo: 'hivecode-app/hive-code', number: 226 }), false, 'the same PR by its full name');
    assert.equal(await post({ repo: 'agent-company', number: 227, project: 'agent-company' }), true);
    assert.equal((await call('/api/prs/merged', { method: 'POST', body: '{}' })).status, 400);

    const day = await get('/api/company-day?date=2026-10-20');
    assert.deepEqual(day.messages.map((m: any) => m.id).filter((id: string) => /^m\d/.test(id)), ['m1', 'm2', 'm3', 'm4'], '(and the task\'s own start message from hq)');
    assert.ok(!JSON.stringify(day).includes('סודי'), 'no message text in the day');
    assert.deepEqual(Object.keys(day.messages[0]).sort(), ['f', 'id', 'k', 't', 'to']);
    assert.equal(day.messages[0].t, 9 * 3_600_000, '9:00 UTC, the day starts at midnight UTC');
    const eli = day.stats.workers.find((w: any) => w.id === 'eli');
    assert.deepEqual([eli.asked, eli.answered, eli.answerMs], [2, 1, 30_000], 'his two messages, one answered, in 30 seconds');
    assert.equal(day.stats.workers.find((w: any) => w.id === 'rotem').answerMs, null, 'never wrote to him: no answer time');
    assert.deepEqual(day.marks.filter((m: any) => m.k === 'merge').map((m: any) => m.label), ['agent-company #226 · x', 'agent-company #227'], 'each PR once');
    const closed = hq.scheduler.addTask({ title: 'ירדה מהתור', project: 'agent-company' });
    hq.scheduler.setTaskState(closed.id, 'closed' as any);
    const after = await get('/api/company-day?date=2026-10-20');
    const open = (d: any) => d.stats.projects.find((p: any) => p.project === 'agent-company').open;
    assert.equal(open(after), open(day), 'a task that left the queue (closed) is not open at the end of the day');
    assert.ok(day.people.some((p: any) => p.id === 'eli' && p.role === 'lead' && p.team === 'personal'));
    assert.ok(day.teams.some((t: any) => t.id === 'agent-company' && t.project === 'agent-company'));
    assert.equal(day.upTo, 9 * 3_600_000 + 150_000, 'today: the day so far');

    assert.equal((await get('/api/company-day?date=2026-10-19')).messages.length, 0);
    assert.equal((await call('/api/company-day?date=bad')).status, 400);
    const one = await get('/api/company-day/messages/m1');
    assert.deepEqual([one.from, one.to, one.body], ['owner', 'eli', 'מה המצב? סודי']);
    assert.equal((await call('/api/company-day/messages/nope')).status, 404);
    assert.equal((await call('/api/company-day/messages/%E0%A4%A')).status, 400);
  } finally { await env.cleanup(); }
});
